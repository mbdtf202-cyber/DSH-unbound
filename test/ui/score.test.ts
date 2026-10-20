/**
 * 得分目标页测试（模型层 + 渲染层）。
 *
 * 重点锁住四件事：
 * 1. **老 host 兼容**：`ruleGroups` 缺失时退回平铺（这条丢了得分项会整片消失）
 * 2. **内置项的锁定**：4 个字段 `readOnly` + 删除按钮禁用
 * 3. **`overridden === false` 的文案**：必须说「分值未改动」，不能说「已保存」
 * 4. **空态四分支**：未选靶标 / 未加载 / 无得分点 / 请求失败
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  defaultScoreProps,
  renderScoreTab,
  type ScoreTabProps,
} from "../../src/redteam/client/score-tab.js";
import {
  BUILTIN_DELETE_LABEL,
  DEFAULT_POINTS,
  EMPTY_POINTS_TEXT,
  EMPTY_SCORE_SUMMARY,
  NO_ENGAGEMENT_TEXT,
  OVERRIDDEN_MESSAGE,
  checkForm,
  countedText,
  countedTitle,
  deleteOutcomeOf,
  earnedText,
  editFormOf,
  capText,
  groupSubtitle,
  hitAssetLabel,
  hitCopyText,
  hitEvidenceText,
  isAchieved,
  isFieldLocked,
  loadScores,
  lockedTitle,
  newScoreForm,
  pointNameText,
  pointsBadgeClass,
  pointsBadgeStyle,
  saveOutcomeOf,
  saveScorePoint,
  scoreBoardOf,
  scoreGroupOf,
  scorePointOf,
  removeScorePoint,
  shouldSkipDelete,
  statusText,
  summaryOf,
  withFormField,
  type ScoreForm,
  type ScoreHit,
  type ScorePoint,
} from "../../src/redteam/client/score-model.js";
import type { ApiClient, ApiResponse } from "../../src/redteam/client/api.js";
import type { ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

/** 造运行时。 */
function makeRuntime(): ConsoleRuntime {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  return createRuntime(requireModule, {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://h/", hostname: "h", port: "1", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => {
        throw new Error("unused");
      },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Parameters<typeof createRuntime>[1]);
}

/** 造一条命中。 */
function hit(overrides: Partial<ScoreHit> = {}): ScoreHit {
  return {
    id: 1,
    target: "203.0.113.5",
    assetIp: "203.0.113.5",
    evidence: "后台管理员 tomcat/Tomcat@2024",
    note: "",
    points: 50,
    service: "",
    selfCreated: false,
    capped: false,
    cappedReason: "",
    recordedAt: "2026-09-18T10:00:00Z",
    shotCount: 0,
    ...overrides,
  };
}

/** 造一个得分点。 */
function point(overrides: Partial<ScorePoint> = {}): ScorePoint {
  return {
    id: 1,
    code: "server-host",
    name: "服务器主机权限",
    category: "获取权限",
    points: 10,
    tier: "",
    cap: 50,
    capUsed: 0,
    src: null,
    rule: null,
    builtin: true,
    enabled: true,
    description: "拿到服务器主机权限",
    counted: 0,
    earned: 0,
    selfCreated: 0,
    capped: 0,
    scopeLabel: "同一系统只算最高权限一次",
    serviceSummary: "",
    hits: [],
    ...overrides,
  };
}

/** 造看板（默认带一个分组）。 */
function board(overrides: {
  readonly points?: readonly ScorePoint[];
  readonly groups?: readonly unknown[];
  readonly summary?: Record<string, unknown>;
  readonly grouped?: boolean;
} = {}): Record<string, unknown> {
  const points = overrides.points ?? [point()];
  const groups = overrides.groups ?? [{
    key: "g1",
    name: "一、获取权限",
    capSum: 300,
    points: 120,
    counted: 3,
    capped: 0,
    tiers: points,
  }];
  return {
    ok: true,
    items: points,
    ruleGroups: overrides.grouped === false ? [] : groups,
    summary: overrides.summary ?? {
      achievedPoints: 320,
      pointCount: points.length,
      hitPointCount: 1,
      hitCount: 9,
      countedHits: 8,
      selfCreatedHits: 0,
      serviceCappedHits: 0,
    },
  };
}

/** 默认 props。 */
function props(overrides: Partial<ScoreTabProps> = {}): ScoreTabProps {
  return { ...defaultScoreProps("eng-1"), ...overrides };
}

/** 渲染。 */
function render(overrides: Partial<ScoreTabProps> = {}): ReturnType<typeof renderToText> {
  const runtime = makeRuntime();
  return renderToText(renderScoreTab(runtime, props(overrides)));
}

/* ══════════════════════════════════════════════════════════════ 模型：解析 */

describe("score-model — 解析", () => {
  it("scoreBoardOf 解析 items / groups / summary", () => {
    const parsed = scoreBoardOf(board());
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.summary.achievedPoints, 320);
    assert.equal(parsed.grouped, true);
  });

  it("**老 host 没有 ruleGroups 时退回平铺**（得分项不能消失）", () => {
    const parsed = scoreBoardOf({ ok: true, items: [{ id: 1, name: "x" }], summary: {} });
    assert.equal(parsed.grouped, false);
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0]?.name, "", "匿名组不渲染组头");
    assert.equal(parsed.groups[0]?.tiers.length, 1);
  });

  it("items 与 ruleGroups.tiers 是两条独立来源（都解析）", () => {
    const parsed = scoreBoardOf({
      items: [{ id: 1, name: "a" }],
      ruleGroups: [{ key: "k", tiers: [{ id: 2, name: "b" }] }],
    });
    assert.equal(parsed.items[0]?.name, "a");
    assert.equal(parsed.groups[0]?.tiers[0]?.name, "b");
  });

  it("scorePointOf 缺省值：enabled 默认 true、points 可负但有限", () => {
    const parsed = scorePointOf({ id: 1, name: "x" });
    assert.equal(parsed.enabled, true, "缺 enabled 视为启用");
    assert.equal(parsed.points, 0);
    assert.equal(parsed.cap, 0);
    assert.deepEqual(parsed.hits, []);
  });

  it("summaryOf 兜底零值（非数字不变成 NaN）", () => {
    const summary = summaryOf({ achievedPoints: "abc", pointCount: null });
    assert.equal(summary.achievedPoints, 0);
    assert.equal(summary.pointCount, 0);
    assert.deepEqual(summary, { ...EMPTY_SCORE_SUMMARY, achievedPoints: 0 });
  });

  it("EMPTY_SCORE_SUMMARY 的六个字段都是 0", () => {
    assert.ok(Object.values(EMPTY_SCORE_SUMMARY).every((value) => value === 0));
  });

  it("scoreGroupOf 兼容 snake_case", () => {
    const group = scoreGroupOf({ key: "k", cap_sum: 100, tiers: [] });
    assert.equal(group.capSum, 100);
  });

  it("groupSubtitle 有上限时带说明、无上限时只报项数", () => {
    assert.equal(
      groupSubtitle(scoreGroupOf({ name: "a", capSum: 300, tiers: [{}, {}] })),
      "2 项 · 各项上限合计 300 分（各项独立，不跨项累加）",
    );
    assert.equal(groupSubtitle(scoreGroupOf({ name: "a", capSum: 0, tiers: [{}] })), "1 项");
  });

  it("没有分组名时不渲染组头（匿名组）", () => {
    assert.equal(scoreGroupOf({ tiers: [] }).name, "");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：行文本 */

describe("score-model — 行文本", () => {
  it("isAchieved 看 hits 是否为空", () => {
    assert.equal(isAchieved(point({ hits: [] })), false);
    assert.equal(isAchieved(point({ hits: [hit()] })), true);
  });

  it("**命中/未命中的徽章类名与样式不同**", () => {
    const achieved = point({ hits: [hit()] });
    assert.equal(pointsBadgeClass(achieved), "rt-pri rt-pri-high");
    assert.equal(pointsBadgeStyle(achieved), null, "命中时不加额外样式");

    const pending = point({ hits: [] });
    assert.equal(pointsBadgeClass(pending), "rt-pri rt-pri-low");
    assert.deepEqual(pointsBadgeStyle(pending), {
      background: "var(--dsw-alias-bg-layer-2)",
      color: "var(--dsw-alias-label-secondary)",
    });
  });

  it("pointNameText 带档位后缀（全角空格分隔）", () => {
    assert.equal(pointNameText(point({ name: "域名控制权限", tier: "一级 50 分" })), "域名控制权限　一级 50 分");
    assert.equal(pointNameText(point({ name: "x", tier: "" })), "x");
  });

  it("countedText：有命中报次数、无命中报「未命中」", () => {
    assert.equal(countedText(point({ hits: [hit()], counted: 3 })), "3 次命中");
    assert.equal(countedText(point({ hits: [] })), "未命中");
  });

  it("capText：无上限返回 null（不渲染）", () => {
    assert.equal(capText(point({ cap: 0 })), null);
    assert.equal(capText(point({ cap: 50, capUsed: 20 })), "　上限 20/50");
  });

  it("countedTitle：有被顶掉的条目时说明原因与条数", () => {
    const title = countedTitle(point({ counted: 2, capped: 1, scopeLabel: "同一服务只算最高一条" }));
    assert.match(title, /已计入 2 次/);
    assert.match(title, /另有 1 条/);
    assert.match(title, /同一服务只算最高一条/);
  });

  it("countedTitle：没有被顶掉时就是计分口径", () => {
    assert.equal(countedTitle(point({ capped: 0, scopeLabel: "按台累加" })), "按台累加");
  });

  it("countedTitle：没有口径文案时给默认兜底", () => {
    assert.equal(countedTitle(point({ capped: 1, scopeLabel: "" })), "已计入 0 次，另有 1 条因「计分口径」或已达上限不计分");
  });

  it("earnedText：>0 显示 +N 分，否则 —", () => {
    assert.equal(earnedText(point({ earned: 50 })), "+50 分");
    assert.equal(earnedText(point({ earned: 0 })), "—");
  });

  it("statusText 拼启用态/分值/命中/自建/封顶", () => {
    const text = statusText(point({
      enabled: true,
      points: 10,
      hits: [hit(), hit()],
      earned: 20,
      selfCreated: 2,
      capped: 1,
    }));
    assert.match(text, /^启用 · 10 分\/次 · 命中 2 次 = 20 分/);
    assert.match(text, /另有 2 次自建不计分/);
    assert.match(text, /另有 1 次同服务重复命中不计分/);
  });

  it("停用态如实显示", () => {
    assert.match(statusText(point({ enabled: false })), /^停用/);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：命中 */

describe("score-model — 命中", () => {
  it("hitAssetLabel：asset_ip 优先、回退 target、都空则「未指定资产」", () => {
    assert.equal(hitAssetLabel(hit({ assetIp: "1.1.1.1", target: "t" })), "1.1.1.1");
    assert.equal(hitAssetLabel(hit({ assetIp: "", target: "https://x" })), "https://x");
    assert.equal(hitAssetLabel(hit({ assetIp: "", target: "" })), "未指定资产");
  });

  it("hitEvidenceText **把换行压成空格**（命中行是一格）", () => {
    assert.equal(hitEvidenceText(hit({ evidence: "a\nb\n\nc" })), "a b c");
  });

  it("hitCopyText 是「资产 + 两个空格 + 证据」", () => {
    assert.equal(hitCopyText(hit({ assetIp: "1.1.1.1", evidence: "uid=0" })), "1.1.1.1  uid=0");
  });

  it("hitCopyText 在没有 asset_ip 时用 target", () => {
    assert.equal(hitCopyText(hit({ assetIp: "", target: "https://x", evidence: "e" })), "https://x  e");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：表单 */

describe("score-model — 表单", () => {
  it("newScoreForm 的默认值（分值 10、启用、非内置、无 id）", () => {
    const form = newScoreForm();
    assert.equal(form.points, DEFAULT_POINTS);
    assert.equal(DEFAULT_POINTS, 10);
    assert.equal(form.enabled, true);
    assert.equal(form.builtin, false);
    assert.equal(form.id, null);
  });

  it("editFormOf 带着 id / builtin / src / cap / rule", () => {
    const builtin = point({ id: 7, builtin: true, src: 12, cap: 50, rule: 3 });
    const form = editFormOf(builtin);
    assert.equal(form.id, 7);
    assert.equal(form.builtin, true);
    assert.equal(form.src, 12);
    assert.equal(form.cap, 50);
    assert.equal(form.rule, 3);
  });

  it("withFormField 不改原对象", () => {
    const form = newScoreForm();
    const next = withFormField(form, "name", "新名字");
    assert.equal(form.name, "");
    assert.equal(next.name, "新名字");
  });

  it("**checkForm：名称不能为空**（预期内失败走 Result）", () => {
    const bad = checkForm(newScoreForm());
    assert.equal(bad.ok, false);
    assert.equal(bad.ok === false && bad.error, "名称不能为空");

    const good = checkForm(withFormField(newScoreForm(), "name", "x"));
    assert.equal(good.ok, true);
  });

  it("**内置项锁定 4 个字段**", () => {
    const builtin = editFormOf(point({ builtin: true }));
    assert.equal(isFieldLocked(builtin), true);
    for (const field of ["name", "category", "points", "description"] as const) {
      assert.notEqual(lockedTitle(builtin, field), "", field + " 应有锁定说明");
    }
  });

  it("非内置项不锁定、没有锁定说明", () => {
    const form = newScoreForm();
    assert.equal(isFieldLocked(form), false);
    assert.equal(lockedTitle(form, "name"), "");
  });

  it("**「分数锁定」的说明要点明「组内累计」这个理由**", () => {
    const builtin = editFormOf(point({ builtin: true }));
    assert.match(lockedTitle(builtin, "points"), /《得分规则》锁定/);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：保存 */

describe("score-model — 保存语义", () => {
  it("**overridden === false 时必须说「分值未改动」**", () => {
    const outcome = saveOutcomeOf({ ok: true, overridden: false });
    assert.equal(outcome.message.err, OVERRIDDEN_MESSAGE);
    assert.match(String(outcome.message.err), /分值未改动/);
    assert.doesNotMatch(String(outcome.message.err), /^已保存$/);
    assert.equal(outcome.closeForm, true, "启用态确实存了，表单要关");
    assert.equal(outcome.reload, true);
  });

  it("正常保存用后端 note", () => {
    const outcome = saveOutcomeOf({ ok: true, note: "已更新分值" });
    assert.equal(outcome.message.ok, "已更新分值");
    assert.equal(outcome.message.err, undefined);
  });

  it("正常保存没有 note 时显示「已保存」", () => {
    assert.equal(saveOutcomeOf({ ok: true }).message.ok, "已保存");
  });

  it("失败时不关表单、不重载", () => {
    const outcome = saveOutcomeOf({ ok: false, error: "名称重复" });
    assert.equal(outcome.message.err, "名称重复");
    assert.equal(outcome.closeForm, false);
    assert.equal(outcome.reload, false);
  });

  it("失败但没文案时兜底「保存失败」", () => {
    assert.equal(saveOutcomeOf({ ok: false }).message.err, "保存失败");
  });

  it("**saveScorePoint 先校验再发请求**（空名字不发网络请求）", async () => {
    const calls: Record<string, unknown>[] = [];
    const api = fakeApi({ ok: true }, calls);
    const outcome = await saveScorePoint(api, "eng-1", newScoreForm());
    assert.equal(outcome.message.err, "名称不能为空");
    assert.equal(calls.length, 0, "校验失败不该发请求");
  });

  it("saveScorePoint 请求体是 `point` 字段", async () => {
    const calls: Record<string, unknown>[] = [];
    const api = fakeApi({ ok: true }, calls);
    await saveScorePoint(api, "eng-1", withFormField(newScoreForm(), "name", "x"));
    assert.equal(calls[0]?.["op"], "saveScorePoint");
    assert.deepEqual(calls[0]?.["point"], withFormField(newScoreForm(), "name", "x"));
  });

  it("删除成功：关表单、关详情、重载", () => {
    const outcome = deleteOutcomeOf({ ok: true });
    assert.equal(outcome.message.ok, "已删除");
    assert.equal(outcome.closeForm, true);
    assert.equal(outcome.closeDetail, true);
    assert.equal(outcome.reload, true);
  });

  it("删除失败：三样都不动", () => {
    const outcome = deleteOutcomeOf({ ok: false, error: "内置项不可删" });
    assert.equal(outcome.message.err, "内置项不可删");
    assert.equal(outcome.closeForm, false);
    assert.equal(outcome.closeDetail, false);
    assert.equal(outcome.reload, false);
  });

  it("shouldSkipDelete：新增表单不发删除请求", () => {
    assert.equal(shouldSkipDelete(null), true);
    assert.equal(shouldSkipDelete(newScoreForm()), true, "没有 id 就是新增");
    assert.equal(shouldSkipDelete(editFormOf(point({ id: 3 }))), false);
  });

  it("removeScorePoint 发 deleteScorePoint 带 id", async () => {
    const calls: Record<string, unknown>[] = [];
    const api = fakeApi({ ok: true }, calls);
    await removeScorePoint(api, "eng-1", 7);
    assert.equal(calls[0]?.["op"], "deleteScorePoint");
    assert.equal(calls[0]?.["id"], 7);
  });
});

/* ══════════════════════════════════════════════════════════════ 假 api */

function fakeApi(
  response: ApiResponse,
  calls: Record<string, unknown>[] = [],
): ApiClient {
  const raw = async (request: { readonly op: string; readonly [key: string]: unknown }): Promise<ApiResponse> => {
    calls.push(request as unknown as Record<string, unknown>);
    return response;
  };
  return {
    raw,
    snapshot: raw as never, assets: raw as never, asset: raw as never, vulns: raw as never,
    sessions: raw as never, chain: raw as never, scores: raw as never, report: raw as never,
    consoleDigest: raw as never, shotData: raw as never, activateEngagement: raw as never,
  } as unknown as ApiClient;
}

/* ══════════════════════════════════════════════════════════════ 渲染：空态 */

describe("renderScoreTab — 四种空态", () => {
  it("**未选靶标**：渲染真实空态", () => {
    const text = render({ engagement: null }).text;
    assert.match(text, new RegExp(NO_ENGAGEMENT_TEXT.slice(0, 8)));
  });

  it("未选靶标时不渲染工具栏（不显示 0 分的假家底）", () => {
    const text = render({ engagement: null }).text;
    assert.doesNotMatch(text, /新增得分点/);
  });

  it("**未加载**（board=null）时工具栏仍渲染（结构稳定）", () => {
    const text = render({ board: null }).text;
    assert.match(text, /得分目标/);
    assert.match(text, /新增得分点/);
  });

  it("**没有得分点**时显示「暂无得分点」", () => {
    const text = render({ board: scoreBoardOf(board({ points: [] })) }).text;
    assert.match(text, new RegExp(EMPTY_POINTS_TEXT.slice(0, 6)));
  });

  it("**请求失败**时显示错误条", () => {
    const result = render({ board: null, error: "读取失败" });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-err"), null);
    assert.match(result.text, /读取失败/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：工具栏 */

describe("renderScoreTab — 工具栏", () => {
  it("显示总分 / 得分点数 / 命中次数", () => {
    const text = render({ board: scoreBoardOf(board()) }).text;
    assert.match(text, /总分/);
    assert.match(text, /320/);
    assert.match(text, /1 个得分点/);
    assert.match(text, /命中 8 次/);
  });

  it("**自建不计分为 0 时不显示该徽章**", () => {
    const text = render({ board: scoreBoardOf(board()) }).text;
    assert.doesNotMatch(text, /自建不计分/);
  });

  it("自建不计分 > 0 时显示并带说明", () => {
    const data = scoreBoardOf(board({
      summary: { ...(board()["summary"] as Record<string, unknown>), selfCreatedHits: 3 },
    }));
    const result = render({ board: data });
    assert.match(result.text, /自建不计分 3/);
    const badge = findAll(result, (element) => classOf(element).includes("rt-tag-warn"))[0];
    assert.match(String(badge?.props["title"]), /不算得分权限/);
  });

  it("服务已拿满不计分 > 0 时显示", () => {
    const data = scoreBoardOf(board({
      summary: { ...(board()["summary"] as Record<string, unknown>), serviceCappedHits: 2 },
    }));
    assert.match(render({ board: data }).text, /服务已拿满不计分 2/);
  });

  it("busy 时刷新按钮禁用且文案变化", () => {
    const result = render({ busy: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("刷新中"));
    assert.equal(button?.props["disabled"], true);
  });

  it("点刷新触发 onRefresh", () => {
    let count = 0;
    const result = render({ onRefresh: () => (count += 1) });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("点「新增」触发 onNew", () => {
    let count = 0;
    const result = render({ onNew: () => (count += 1) });
    const button = findAll(result, "button").find((element) => textOf(element).includes("新增得分点"));
    fire(button!, "onClick");
    assert.equal(count, 1);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：分组与行 */

describe("renderScoreTab — 分组与行", () => {
  it("渲染组头与组内得分点", () => {
    const text = render({ board: scoreBoardOf(board()) }).text;
    assert.match(text, /一、获取权限/);
    assert.match(text, /各项上限合计 300 分/);
    assert.match(text, /服务器主机权限/);
  });

  it("组头显示组内已得分（>0 才显示）", () => {
    assert.match(render({ board: scoreBoardOf(board()) }).text, /\+120 分/);
    const zero = scoreBoardOf(board({ groups: [{ key: "g", name: "空组", capSum: 0, points: 0, tiers: [] }] }));
    assert.doesNotMatch(render({ board: zero }).text, /\+0 分/);
  });

  it("**匿名组（老 host）不渲染组头**", () => {
    const data = scoreBoardOf({ ok: true, items: [{ id: 1, name: "服务器主机权限" }] });
    const text = render({ board: data }).text;
    assert.match(text, /服务器主机权限/);
    assert.doesNotMatch(text, /各项上限合计/);
  });

  it("行显示分值 / 名称 / 命中 / 已得分", () => {
    const text = render({ board: scoreBoardOf(board()) }).text;
    assert.match(text, /10分/);
    assert.match(text, /未命中/);
    assert.match(text, /上限 0\/50/);
  });

  it("命中过的行显示次数与得分", () => {
    const data = scoreBoardOf(board({ points: [point({ hits: [hit()], counted: 1, earned: 50, capUsed: 50 })] }));
    const text = render({ board: data }).text;
    assert.match(text, /1 次命中/);
    assert.match(text, /\+50 分/);
  });

  it("无上限的得分点不渲染上限（不是「上限 0/0」）", () => {
    const data = scoreBoardOf(board({ points: [point({ cap: 0 })] }));
    assert.doesNotMatch(render({ board: data }).text, /上限 0\/0/);
  });

  it("点得分点行触发 onToggle", () => {
    const toggles: number[] = [];
    const result = render({ board: scoreBoardOf(board()), onToggle: (id) => toggles.push(id) });
    const row = findAll(result, (element) => classOf(element) === "rt-score-row")[0];
    fire(row!, "onClick");
    assert.deepEqual(toggles, [1]);
  });

  it("行键盘可达（Enter / Space）", () => {
    const toggles: number[] = [];
    const result = render({ board: scoreBoardOf(board()), onToggle: (id) => toggles.push(id) });
    const row = findAll(result, (element) => classOf(element) === "rt-score-row")[0];
    fire(row!, "onKeyDown", { key: "Enter" });
    fire(row!, "onKeyDown", { key: " " });
    assert.deepEqual(toggles, [1, 1]);
  });

  it("展开的行带 aria-expanded=true", () => {
    const result = render({ board: scoreBoardOf(board()), openId: 1 });
    const rows = findAll(result, (element) => classOf(element) === "rt-score-row");
    assert.equal(rows[0]?.props["aria-expanded"], "true");
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：详情 */

describe("renderScoreTab — 展开详情", () => {
  it("显示得分条件与状态", () => {
    const result = render({ board: scoreBoardOf(board()), openId: 1 });
    assert.match(result.text, /得分条件/);
    assert.match(result.text, /拿到服务器主机权限/);
    assert.match(result.text, /启用 · 10 分\/次/);
  });

  it("未命中时显示引导文案（而不是空白）", () => {
    const result = render({ board: scoreBoardOf(board()), openId: 1 });
    assert.match(result.text, /redteam_score_hit/);
  });

  it("有命中时渲染命中行", () => {
    const data = scoreBoardOf(board({
      points: [point({ hits: [hit({ evidence: "uid=0(root)" })] })],
    }));
    const result = render({ board: data, openId: 1 });
    assert.match(result.text, /命中记录 · 1/);
    assert.match(result.text, /uid=0\(root\)/);
  });

  it("**未填证据的命中显示「未填账号密码/结果」**", () => {
    const data = scoreBoardOf(board({ points: [point({ hits: [hit({ evidence: "" })] })] }));
    assert.match(render({ board: data, openId: 1 }).text, /未填账号密码\/结果/);
  });

  it("自建命中带「自建 · 不计分」", () => {
    const data = scoreBoardOf(board({ points: [point({ hits: [hit({ selfCreated: true })] })] }));
    const text = render({ board: data, openId: 1 }).text;
    assert.match(text, /自建 · 不计分/);
  });

  it("服务封顶命中带「服务已拿满」", () => {
    const data = scoreBoardOf(board({ points: [point({ hits: [hit({ capped: true, service: "https" })] })] }));
    assert.match(render({ board: data, openId: 1 }).text, /服务已拿满 · 不计分（https）/);
  });

  it("截图数 > 0 时显示「图 N」", () => {
    const data = scoreBoardOf(board({ points: [point({ hits: [hit({ shotCount: 2 })] })] }));
    assert.match(render({ board: data, openId: 1 }).text, /图 2/);
  });

  it("点「复制」回调命中文本", () => {
    const copied: string[] = [];
    const data = scoreBoardOf(board({ points: [point({ hits: [hit()] })] }));
    const result = render({ board: data, openId: 1, onCopy: (text) => copied.push(text) });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制");
    fire(button!, "onClick");
    assert.equal(copied[0], "203.0.113.5  后台管理员 tomcat/Tomcat@2024");
  });

  it("点「编辑」回调该得分点", () => {
    const edited: ScorePoint[] = [];
    const result = render({ board: scoreBoardOf(board()), openId: 1, onEdit: (item) => edited.push(item) });
    const button = findAll(result, "button").find((element) => textOf(element) === "编辑");
    fire(button!, "onClick");
    assert.equal(edited[0]?.id, 1);
  });

  it("服务封顶说明行只在有封顶时出现", () => {
    const withCap = scoreBoardOf(board({ points: [point({ capped: 1, serviceSummary: "https 已满" })] }));
    assert.match(render({ board: withCap, openId: 1 }).text, /服务封顶/);
    assert.doesNotMatch(render({ board: scoreBoardOf(board()), openId: 1 }).text, /服务封顶/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：表单 */

describe("renderScoreTab — 表单", () => {
  it("表单关闭时不渲染输入框", () => {
    const result = render({ board: scoreBoardOf(board()), form: null });
    assert.equal(findAll(result, "input").filter((element) => element.props["placeholder"] === "名称（必填）").length, 0);
  });

  it("新增表单预填默认值", () => {
    const result = render({ form: newScoreForm() });
    const name = findAll(result, "input").find((element) => element.props["placeholder"] === "名称（必填）");
    assert.equal(name?.props["value"], "");
    const points = findAll(result, "input").find((element) => element.props["placeholder"] === "单次分值");
    assert.equal(points?.props["value"], 10);
  });

  it("**内置项的 4 个字段 readOnly**", () => {
    const form = editFormOf(point({ builtin: true }));
    const result = render({ form });
    const name = findAll(result, "input").find((element) => element.props["placeholder"] === "名称（必填）");
    const category = findAll(result, "input").find((element) => element.props["placeholder"] === "分类，如 账号权限");
    const points = findAll(result, "input").find((element) => element.props["placeholder"] === "单次分值");
    const description = findAll(result, "input").find((element) => element.props["placeholder"] === "得分条件说明");
    assert.equal(name?.props["readOnly"], true);
    assert.equal(category?.props["readOnly"], true);
    assert.equal(points?.props["readOnly"], true);
    assert.equal(description?.props["readOnly"], true);
  });

  it("非内置项不 readOnly", () => {
    const result = render({ form: newScoreForm() });
    const name = findAll(result, "input").find((element) => element.props["placeholder"] === "名称（必填）");
    assert.equal(name?.props["readOnly"], false);
  });

  it("**内置项删除按钮禁用并说明原因**", () => {
    const form = editFormOf(point({ builtin: true }));
    const result = render({ form });
    const button = findAll(result, "button").find((element) => textOf(element) === BUILTIN_DELETE_LABEL);
    assert.notEqual(button, null);
    assert.equal(button?.props["disabled"], true);
    assert.match(String(button?.props["title"]), /不能删除/);
  });

  it("**非内置项显示可用的「删除」**", () => {
    const form = editFormOf(point({ id: 3, builtin: false }));
    const result = render({ form });
    const button = findAll(result, "button").find((element) => textOf(element) === "删除");
    assert.equal(button?.props["disabled"], false);
  });

  it("新增表单不显示删除按钮", () => {
    const result = render({ form: newScoreForm() });
    assert.equal(findAll(result, "button").filter((element) => textOf(element) === "删除").length, 0);
  });

  it("内置项显示锁定说明与规则原文", () => {
    const form = editFormOf(point({ builtin: true, src: 12, rule: 3, cap: 50 }));
    const result = render({ form });
    assert.match(result.text, /内置得分点（来自《突破入侵类得分规则（合并版）》）/);
    assert.match(result.text, /规则原文序号 12/);
    assert.match(result.text, /上限分组 rule=3/);
  });

  it("非内置项不显示锁定说明", () => {
    assert.doesNotMatch(render({ form: newScoreForm() }).text, /内置得分点（来自/);
  });

  it("改名称触发 onFormChange", () => {
    const forms: ScoreForm[] = [];
    const result = render({ form: newScoreForm(), onFormChange: (form) => forms.push(form) });
    const name = findAll(result, "input").find((element) => element.props["placeholder"] === "名称（必填）");
    fire(name!, "onChange", { target: { value: "新点" } });
    assert.equal(forms[0]?.name, "新点");
  });

  it("**分值输入非数字时收敛为 0**（不产生 NaN）", () => {
    const forms: ScoreForm[] = [];
    const result = render({ form: newScoreForm(), onFormChange: (form) => forms.push(form) });
    const points = findAll(result, "input").find((element) => element.props["placeholder"] === "单次分值");
    fire(points!, "onChange", { target: { value: "abc" } });
    assert.equal(forms[0]?.points, 0);
  });

  it("启用/停用下拉切换 enabled", () => {
    const forms: ScoreForm[] = [];
    const result = render({ form: newScoreForm(), onFormChange: (form) => forms.push(form) });
    const select = findAll(result, "select").find((element) => textOf(element).includes("停用"));
    fire(select!, "onChange", { target: { value: "0" } });
    assert.equal(forms[0]?.enabled, false);
  });

  it("点保存 / 删除 / 取消各自回调", () => {
    let saves = 0;
    let removes = 0;
    let cancels = 0;
    const form = editFormOf(point({ id: 3, builtin: false }));
    const result = render({
      form,
      onSave: () => (saves += 1),
      onRemove: () => (removes += 1),
      onCancel: () => (cancels += 1),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "保存")!, "onClick");
    fire(findAll(result, "button").find((element) => textOf(element) === "删除")!, "onClick");
    fire(findAll(result, "button").find((element) => textOf(element) === "取消")!, "onClick");
    assert.deepEqual([saves, removes, cancels], [1, 1, 1]);
  });

  it("busy 时保存与删除禁用", () => {
    const form = editFormOf(point({ id: 3, builtin: false }));
    const result = render({ form, busy: true });
    assert.equal(findAll(result, "button").find((element) => textOf(element) === "保存")?.props["disabled"], true);
    assert.equal(findAll(result, "button").find((element) => textOf(element) === "删除")?.props["disabled"], true);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：消息 */

describe("renderScoreTab — 消息条", () => {
  it("错误消息用 rt-err", () => {
    const result = render({ message: { err: "名称不能为空" } });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-err"), null);
    assert.match(result.text, /名称不能为空/);
  });

  it("成功消息用 rt-foot", () => {
    const result = render({ message: { ok: "已保存" } });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-foot"), null);
  });

  it("**被 overridden 时的消息如实说「分值未改动」**", () => {
    const result = render({ message: { err: OVERRIDDEN_MESSAGE } });
    assert.match(result.text, /分值未改动/);
  });

  it("没有消息时不渲染消息条", () => {
    const result = render({ message: null });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-err"), null);
  });
});

/* ══════════════════════════════════════════════════════════════ 流程 */

describe("score-model — 加载流程", () => {
  it("loadScores 成功返回看板", async () => {
    const api = fakeApi({ ...board(), ok: true } as ApiResponse);
    const result = await loadScores(api, "eng-1");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.items.length, 1);
  });

  it("loadScores 失败返回 err", async () => {
    const api = fakeApi({ ok: false, error: "读取失败" });
    const result = await loadScores(api, "eng-1");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, "读取失败");
  });

  it("loadScores 发 scores op", async () => {
    const calls: Record<string, unknown>[] = [];
    await loadScores(fakeApi({ ok: true, items: [] }, calls), "eng-1");
    assert.equal(calls[0]?.["op"], "scores");
    assert.equal(calls[0]?.["engagement"], "eng-1");
  });
});

/* ══════════════════════════════════════════════════════════════ 端到端 */

describe("端到端：从原始响应一路渲染", () => {
  it("完整看板渲染出组头 / 得分点 / 命中 / 总分", () => {
    const data = scoreBoardOf({
      ok: true,
      summary: {
        achievedPoints: 120,
        pointCount: 2,
        hitPointCount: 1,
        hitCount: 2,
        countedHits: 2,
        selfCreatedHits: 1,
        serviceCappedHits: 0,
      },
      items: [],
      ruleGroups: [
        {
          key: "perm",
          name: "一、获取权限",
          capSum: 4000,
          points: 120,
          counted: 2,
          capped: 0,
          tiers: [
            {
              id: 1,
              code: "server-host",
              name: "服务器主机权限",
              points: 10,
              cap: 600,
              enabled: true,
              builtin: true,
              counted: 2,
              earned: 120,
              cap_used: 120,
              hits: [
                { id: 1, asset_ip: "1.1.1.1", evidence: "uid=0(root)", points: 50, recorded_at: "2026-09-18T10:00:00Z" },
                { id: 2, asset_ip: "1.1.1.2", evidence: "nt authority\\system", points: 70, recorded_at: "2026-09-18T11:00:00Z" },
              ],
            },
            { id: 2, name: "域名控制权限", points: 50, cap: 0, enabled: false },
          ],
        },
      ],
    });
    const text = render({ board: data, openId: 1 }).text;
    assert.match(text, /一、获取权限/);
    assert.match(text, /各项上限合计 4000 分/);
    assert.match(text, /服务器主机权限/);
    assert.match(text, /域名控制权限/);
    assert.match(text, /uid=0\(root\)/);
    assert.match(text, /nt authority\\system/);
    assert.match(text, /120/);
    assert.match(text, /自建不计分 1/);
  });
});
