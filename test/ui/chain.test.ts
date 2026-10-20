/**
 * 攻击链页的模型 + 渲染测试。
 *
 * 重点是**五阶段的三条硬规则**：
 * - 阶段编号来自数组顺序（第六个起退化成 `06`）
 * - 累计分取服务端值（不在前端累加）
 * - `self-only` 通道必须单独提示（「有 socks5」不等于「打进内网」）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  chainErrorOf,
  chainOf,
  loadChain,
  nextView,
  renderChainTab,
  toggleHitOpen,
  type ChainTabProps,
} from "../../src/redteam/client/chain-tab.js";
import {
  CHAIN_FLOW_LABEL,
  COMPACT_LIMIT,
  COMPACT_TUNNEL_LIMIT,
  CIRCLED,
  EMPTY_CHAIN_MESSAGE,
  SELF_ONLY_WARNING,
  assetHitsLabel,
  assetPointsLabel,
  assetPortsLabel,
  assetPriorityLabel,
  assetScopeClass,
  assetScopeLabel,
  assetVulnsLabel,
  chainAssetOf,
  chainDataOf,
  chainHitOf,
  chainStageOf,
  chainTunnelOf,
  compactAssetCountLabel,
  compactAssetScope,
  compactHitsLabel,
  compactReconHit,
  compactTunnelHit,
  cumulativeLabel,
  hitActionLabel,
  hitPointsLabel,
  hitRecordedLine,
  hitTarget,
  hitTimesLine,
  hitVulnLine,
  isBoundaryStage,
  isReconStage,
  moreHitsLabel,
  nthLabel,
  reconAssetsLabel,
  showsSelfOnlyWarning,
  stageAssetsLabel,
  stageEmptyMessage,
  stageHeadStyle,
  stageHitsLabel,
  stageNumber,
  stageNumberCompact,
  stageNumberCompactStyle,
  stageNumberStyle,
  stagePointsStyle,
  totalLabel,
  tunnelStatusClass,
  tunnelStatusLabel,
  tunnelStatusStyle,
  tunnelsLabel,
  viewButtonClass,
  viewButtonLabel,
  viewButtonTitle,
  viewRootClass,
  type ChainAsset,
  type ChainData,
  type ChainHit,
  type ChainStage,
  type ChainTunnel,
} from "../../src/redteam/client/chain-model.js";
import type { ApiResponse } from "../../src/redteam/client/api.js";
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
      createElement: () => { throw new Error("unused"); },
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
function hit(overrides: Partial<ChainHit> = {}): ChainHit {
  return {
    id: 1,
    pointName: "服务器权限",
    points: 10,
    counted: true,
    capped: false,
    cappedReason: "",
    nthOfPoint: 1,
    target: "10.0.0.5:22",
    assetIp: "10.0.0.5",
    vulnTitle: "",
    vulnCve: "",
    recordedAt: "2026-01-02T03:04:05Z",
    recordedBy: "exploit",
    evidence: "",
    actionTitle: "",
    actionInferred: false,
    hasAction: false,
    ...overrides,
  };
}

/** 造一个资产。 */
function asset(overrides: Partial<ChainAsset> = {}): ChainAsset {
  return {
    id: 1,
    ip: "10.0.0.5",
    scope: "external",
    segmentCidr: "10.0.0.0/24",
    openPorts: 3,
    vulns: 0,
    priority: "",
    points: 10,
    hits: 1,
    ...overrides,
  };
}

/** 造一条隧道。 */
function tunnel(overrides: Partial<ChainTunnel> = {}): ChainTunnel {
  return {
    id: 1,
    kind: "suo5",
    listen: "127.0.0.1:1080",
    reach: "10.0.0.0/8",
    status: "active",
    ...overrides,
  };
}

/** 造一个阶段。 */
function stage(overrides: Partial<ChainStage> = {}): ChainStage {
  return {
    code: "internet",
    name: "互联网资产权限",
    subtitle: "internet",
    goal: "拿到互联网侧资产权限",
    color: "#3b82f6",
    points: 10,
    cumulative: 10,
    hits: 1,
    assetCount: 1,
    assets: [],
    items: [hit()],
    tunnels: [],
    tunnelsSelfOnly: [],
    transition: "",
    ...overrides,
  };
}

/** 造链数据。 */
function chain(overrides: Partial<ChainData> = {}): ChainData {
  // 用 `hasOwn` 而不是 `??`：`summary: null` 是**有意义的输入**（工具栏不显示总分），
  // `??` 会把它替换成默认值，测不出那个分支。
  return {
    stages: overrides.stages ?? [stage()],
    summary: Object.hasOwn(overrides, "summary") ? (overrides.summary ?? null) : { points: 10 },
  };
}

/** 默认 props。 */
function props(overrides: Partial<ChainTabProps> = {}): ChainTabProps {
  return {
    data: chain(),
    error: null,
    loading: false,
    view: "A",
    openId: null,
    onViewChange: () => undefined,
    onToggleHit: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<ChainTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderChainTab(runtime, props(overrides))) };
}

/** 造 api 替身。 */
function fakeApi(responses: readonly ApiResponse[]): {
  readonly requests: Record<string, unknown>[];
  readonly api: { raw: (request: Record<string, unknown>) => Promise<ApiResponse> };
} {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  return {
    requests,
    api: {
      raw: async (request) => {
        requests.push(request);
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return response ?? { ok: true };
      },
    },
  };
}

describe("chain-model — 阶段编号", () => {
  it("**前五个用圈号**", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(stageNumber), ["①", "②", "③", "④", "⑤"]);
  });

  it("**第六个起退化成零填充两位数字**（只设计了五个圈号）", () => {
    assert.equal(stageNumber(5), "⑥");
    assert.equal(stageNumber(6), "07");
    assert.equal(stageNumber(11), "012");
  });

  it("CIRCLED 只有六个", () => {
    assert.equal(CIRCLED.length, 6);
  });

  it("横向视图用阿拉伯数字（列窄，圈号会挤）", () => {
    assert.equal(stageNumberCompact(0), "1");
    assert.equal(stageNumberCompact(6), "7");
  });

  it("圈号不会因 index 为负而崩", () => {
    assert.equal(stageNumber(-1), "00");
  });
});

describe("chain-model — 解析", () => {
  it("解析一条命中", () => {
    const parsed = chainHitOf({
      id: 3,
      point_name: "RCE",
      points: 50,
      counted: true,
      nth_of_point: 2,
      target: "http://x/",
      recorded_at: "2026-01-01T00:00:00Z",
      action: { title: "上传马" },
    });
    assert.equal(parsed?.id, 3);
    assert.equal(parsed?.points, 50);
    assert.equal(parsed?.hasAction, true);
    assert.equal(parsed?.actionTitle, "上传马");
  });

  it("**counted 缺省算「计分」**（老 host 不给这个字段）", () => {
    assert.equal(chainHitOf({ id: 1 })?.counted, true);
  });

  it("counted: false 显式排除", () => {
    assert.equal(chainHitOf({ id: 1, counted: false })?.counted, false);
  });

  it("丢没有 id 的命中", () => {
    assert.equal(chainHitOf({ point_name: "无 id" }), null);
  });

  it("没有 action 时 hasAction 为 false", () => {
    assert.equal(chainHitOf({ id: 1 })?.hasAction, false);
  });

  it("解析资产（含 assetCount 的两种写法）", () => {
    const parsed = chainStageOf({ code: "recon", assetCount: 5 });
    assert.equal(parsed?.assetCount, 5);
    assert.equal(chainStageOf({ code: "recon", asset_count: 7 })?.assetCount, 7);
  });

  it("解析隧道", () => {
    const parsed = chainTunnelOf({ id: 1, kind: "suo5", listen: "127.0.0.1:1080", status: "active" });
    assert.equal(parsed?.kind, "suo5");
    assert.equal(parsed?.status, "active");
  });

  it("丢没有 code 的阶段（无法判定渲染分支）", () => {
    assert.equal(chainStageOf({ name: "没有 code" }), null);
  });

  it("name 缺失时回退成 code", () => {
    assert.equal(chainStageOf({ code: "recon" })?.name, "recon");
  });

  it("stage 的 self-only 隧道单独收", () => {
    const parsed = chainStageOf({
      code: "boundary",
      tunnels: [{ id: 1 }, { id: 2 }],
      tunnels_self_only: [{ id: 3 }],
    });
    assert.equal(parsed?.tunnels.length, 2);
    assert.equal(parsed?.tunnelsSelfOnly.length, 1);
  });

  it("chainDataOf 解析 stages 与 summary", () => {
    const parsed = chainDataOf({ ok: true, stages: [{ code: "recon" }], summary: { points: 42 } });
    assert.equal(parsed?.stages.length, 1);
    assert.equal(parsed?.summary?.points, 42);
  });

  it("**summary 缺失时给 null**（工具栏不显示「总分 0 分」）", () => {
    assert.equal(chainDataOf({ ok: true, stages: [] })?.summary, null);
  });

  it("失败响应 → null", () => {
    assert.equal(chainDataOf({ ok: false }), null);
  });

  it("空对象也能解析（stages 空、summary null）", () => {
    const parsed = chainDataOf({ ok: true });
    assert.deepEqual(parsed?.stages, []);
    assert.equal(parsed?.summary, null);
  });

  it("chainAssetOf 解析完整字段", () => {
    const parsed = chainAssetOf({ id: 1, ip: "1.1.1.1", scope: "internal", open_ports: 5, points: 3, hits: 2 });
    assert.equal(parsed?.scope, "internal");
    assert.equal(parsed?.openPorts, 5);
    assert.equal(parsed?.hits, 2);
  });
});

describe("chain-model — 阶段判定与文案", () => {
  it("信息收集阶段识别", () => {
    assert.equal(isReconStage(stage({ code: "recon" })), true);
    assert.equal(isReconStage(stage({ code: "internet" })), false);
  });

  it("边界突破阶段识别", () => {
    assert.equal(isBoundaryStage(stage({ code: "boundary" })), true);
    assert.equal(isBoundaryStage(stage({ code: "internal" })), false);
  });

  it("命中标题带上得分的条件说明", () => {
    assert.equal(stageHitsLabel(stage({ hits: 3, points: 15 })), "本阶段命中 3 次 · +15 分");
  });

  it("**0 分时不显示 +0 分**（无噪声）", () => {
    assert.equal(stageHitsLabel(stage({ hits: 3, points: 0 })), "本阶段命中 3 次");
  });

  it("信息收集的资产标题", () => {
    assert.equal(reconAssetsLabel(stage({ code: "recon", assetCount: 4 })), "拿到分数的资产 · 4 台");
  });

  it("其它阶段的资产标题", () => {
    assert.equal(stageAssetsLabel(stage({ assetCount: 4 })), "涉及资产 · 4 台");
  });

  it("隧道标题在有 self-only 时补充说明", () => {
    const withSelf = stage({
      code: "boundary",
      tunnels: [tunnel()],
      tunnelsSelfOnly: [tunnel({ id: 2 })],
    });
    assert.match(tunnelsLabel(withSelf), /另有 1 条只在自己 VPS\/自建服务器上/);
  });

  it("隧道标题在无 self-only 时不啰嗦", () => {
    const plain = stage({ code: "boundary", tunnels: [tunnel()] });
    assert.equal(tunnelsLabel(plain), "跨越靶标边界的通道 · 1 条");
  });

  it("**只有 self-only 通道时给警示**（「有 socks5」不等于「打进内网」）", () => {
    const selfOnly = stage({ code: "boundary", tunnels: [], tunnelsSelfOnly: [tunnel()] });
    assert.equal(showsSelfOnlyWarning(selfOnly), true);
    assert.match(SELF_ONLY_WARNING, /没有碰到目标/);
  });

  it("**有一条真通道就不警示**（self-only 只是补充信息）", () => {
    const both = stage({ code: "boundary", tunnels: [tunnel()], tunnelsSelfOnly: [tunnel({ id: 2 })] });
    assert.equal(showsSelfOnlyWarning(both), false);
  });

  it("完全没有隧道时不警示", () => {
    assert.equal(showsSelfOnlyWarning(stage({ code: "boundary" })), false);
  });

  it("阶段的空态文案按类型分", () => {
    assert.equal(stageEmptyMessage(stage({ code: "recon" })), "还没有产生得分的资产");
    assert.equal(stageEmptyMessage(stage({ code: "internet" })), "本阶段还没有得分");
  });

  it("隧道状态文案", () => {
    assert.equal(tunnelStatusLabel(tunnel({ status: "active" })), "可用");
    assert.equal(tunnelStatusLabel(tunnel({ status: "down" })), "down");
    assert.equal(tunnelStatusLabel(tunnel({ status: "" })), "未知");
  });

  it("隧道状态样式（非可用降不透明度）", () => {
    assert.equal(tunnelStatusClass(tunnel({ status: "active" })), "rt-tag rt-tag-live");
    assert.equal(tunnelStatusClass(tunnel({ status: "down" })), "rt-tag ");
    assert.deepEqual(tunnelStatusStyle(tunnel({ status: "down" })), { opacity: 0.7 });
    assert.equal(tunnelStatusStyle(tunnel({ status: "active" })), undefined);
  });

  it("累计分与合计", () => {
    assert.equal(cumulativeLabel(stage({ cumulative: 30 })), "累计 30 分");
    assert.equal(totalLabel({ points: 99 }), "合计 99 分");
    assert.equal(totalLabel(null), "合计 0 分");
  });

  it("**capped（服务已拿满）的命中显示 +0**", () => {
    assert.equal(hitPointsLabel(hit({ capped: true, counted: false, points: 50 })), "+0");
    assert.equal(hitPointsLabel(hit({ points: 50 })), "+50");
  });

  it("「第 N 次」只在 >1 时显示", () => {
    assert.equal(nthLabel(hit({ nthOfPoint: 1 })), null);
    assert.equal(nthLabel(hit({ nthOfPoint: 3 })), "第 3 次");
  });

  it("命中的目标回退", () => {
    assert.equal(hitTarget(hit({ target: "http://x/" })), "http://x/");
    assert.equal(hitTarget(hit({ target: "" })), "10.0.0.5");
    assert.equal(hitTarget(hit({ target: "", assetIp: "" })), "—");
  });

  it("动作说明带「推断」标记", () => {
    assert.equal(hitActionLabel(hit({ hasAction: true, actionTitle: "上传" })), "动作：上传");
    assert.equal(
      hitActionLabel(hit({ hasAction: true, actionTitle: "上传", actionInferred: true })),
      "动作：上传（推断）",
    );
  });

  it("**没有标题的动作显示（未命名步骤）**", () => {
    assert.equal(hitActionLabel(hit({ hasAction: true })), "动作：（未命名步骤）");
  });

  it("命中详情的各行", () => {
    assert.equal(hitTimesLine(hit({ nthOfPoint: 2, points: 5 })), "同类第 2 次 · +5 分");
    assert.match(hitRecordedLine(hit()), /2026-01-02 03:04 · exploit/);
    assert.equal(hitVulnLine(hit({ vulnCve: "CVE-1", vulnTitle: "T" })), "CVE-1 T");
    assert.equal(hitVulnLine(hit()), "");
  });

  it("**记录人缺失时不出多余的分隔符**", () => {
    assert.equal(hitRecordedLine(hit({ recordedBy: "" })), "2026-01-02 03:04");
  });

  it("资产行文案", () => {
    assert.equal(assetPriorityLabel(asset({ priority: "high" })), "易打 high");
    assert.equal(assetPriorityLabel(asset()), null);
    assert.equal(assetPortsLabel(asset({ openPorts: 5 })), "端口 5");
    assert.equal(assetVulnsLabel(asset({ vulns: 0 })), null);
    assert.equal(assetVulnsLabel(asset({ vulns: 2 })), "漏洞 2");
    assert.equal(assetPointsLabel(asset({ points: 9 })), "+9 分");
    assert.equal(assetHitsLabel(asset({ hits: 2 })), "2 次");
  });

  it("**端口 0 也要显示「端口 0」**（不是消失）", () => {
    assert.equal(assetPortsLabel(asset({ openPorts: 0 })), "端口 0");
  });

  it("资产内外网标签", () => {
    assert.equal(assetScopeLabel(asset({ scope: "internal" })), "内");
    assert.equal(assetScopeLabel(asset({ scope: "external" })), "外");
    assert.equal(assetScopeClass(asset({ scope: "internal" })), "rt-scope rt-scope-internal");
  });

  it("横向视图的资产前缀", () => {
    assert.equal(compactAssetScope(asset({ scope: "internal" })), "内 ");
    assert.equal(compactAssetScope(asset({ scope: "external" })), "外 ");
  });

  it("横向视图的命中说明", () => {
    assert.equal(compactTunnelHit(stage({ code: "boundary", tunnels: [tunnel()] })), "隧道 1 条");
    assert.equal(compactReconHit(stage({ code: "recon", assetCount: 3 })), "3 台资产拿到分");
    assert.equal(compactHitsLabel(stage({ hits: 4 })), "4 次命中");
  });

  it("**横向视图的截断：超过 6 条给「另有 N 次」**", () => {
    assert.equal(moreHitsLabel(COMPACT_LIMIT), null);
    assert.equal(moreHitsLabel(COMPACT_LIMIT + 3), "…另有 3 次");
  });

  it("横向视图的资产数说明（0 台 → 不显示）", () => {
    assert.equal(compactAssetCountLabel(stage({ assetCount: 0 })), null);
    assert.equal(compactAssetCountLabel(stage({ assetCount: 3 })), "涉及 3 台资产");
  });

  it("横向隧道的截断数是 3", () => {
    assert.equal(COMPACT_TUNNEL_LIMIT, 3);
  });
});

describe("chain-model — 视图与样式", () => {
  it("视图根容器类名", () => {
    assert.equal(viewRootClass("A"), "rt-ap");
    assert.equal(viewRootClass("B"), "rt-ap-h");
  });

  it("视图按钮类名与文案", () => {
    assert.equal(viewButtonClass("A", "A"), "rt-btn rt-btn-primary");
    assert.equal(viewButtonClass("B", "A"), "rt-btn");
    assert.equal(viewButtonLabel("A"), "链路 A");
    assert.equal(viewButtonLabel("B"), "链路 B");
  });

  it("视图按钮 title 说明形态", () => {
    assert.match(viewButtonTitle("A"), /竖向/);
    assert.match(viewButtonTitle("B"), /横向/);
  });

  it("阶段色带样式", () => {
    assert.deepEqual(stageHeadStyle("#fff"), { borderLeftColor: "#fff" });
    assert.deepEqual(stagePointsStyle("#fff"), { background: "#fff22", color: "#fff", borderColor: "#fff66" });
    assert.deepEqual(stageNumberStyle("#fff"), { background: "#fff" });
    assert.deepEqual(stageNumberCompactStyle("#fff"), { background: "#fff", width: 16, height: 16, fontSize: 10 });
  });

  it("流程说明文案", () => {
    assert.match(CHAIN_FLOW_LABEL, /信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限/);
  });
});

describe("chain-tab — 流程", () => {
  it("读攻击链", async () => {
    const { api, requests } = fakeApi([{ ok: true, stages: [] }]);
    await loadChain(api as never, "eng-1");
    assert.equal(requests[0]?.["op"], "scoreChain");
    assert.equal(requests[0]?.["engagement"], "eng-1");
  });

  it("chainOf 解析响应", () => {
    const parsed = chainOf({ ok: true, stages: [{ code: "recon" }] });
    assert.equal(parsed?.stages.length, 1);
  });

  it("chainErrorOf 取错误文案", () => {
    assert.equal(chainErrorOf({ ok: false, error: "库损坏" }), "库损坏");
    assert.equal(chainErrorOf({ ok: false }), "读取失败");
    assert.equal(chainErrorOf({ ok: true }), null);
  });

  it("nextView 归一非法值", () => {
    assert.equal(nextView("B"), "B");
    assert.equal(nextView("A"), "A");
    assert.equal(nextView("C"), "A");
    assert.equal(nextView(null), "A");
  });

  it("toggleHitOpen 同一条再点收起", () => {
    assert.equal(toggleHitOpen(3, 3), null);
    assert.equal(toggleHitOpen(3, 4), 4);
    assert.equal(toggleHitOpen(null, 4), 4);
  });
});

describe("renderChainTab — 竖向视图", () => {
  it("渲染工具栏与流程说明", () => {
    const { result } = render();
    assert.match(result.text, /攻击链/);
    assert.match(result.text, /信息收集 → 互联网资产权限/);
  });

  it("显示总分", () => {
    assert.match(render().result.text, /总分 10 分/);
  });

  it("summary 缺失时不显示总分徽章", () => {
    assert.doesNotMatch(render({ data: chain({ summary: null }) }).result.text, /总分/);
  });

  it("渲染阶段名与阶段目标", () => {
    const { result } = render();
    assert.match(result.text, /互联网资产权限/);
    assert.match(result.text, /阶段目标/);
  });

  it("渲染累计分", () => {
    assert.match(render().result.text, /累计 10 分/);
  });

  it("**最后一个阶段之后显示合计**", () => {
    const { result } = render({ data: chain({ summary: { points: 42 } }) });
    assert.match(result.text, /合计 42 分/);
  });

  it("渲染命中行", () => {
    const { result } = render();
    assert.match(result.text, /服务器权限/);
    assert.match(result.text, /\+10/);
  });

  it("**capped 的命中显示「服务已拿满 · 不计分」**", () => {
    const { result } = render({
      data: chain({ stages: [stage({ items: [hit({ capped: true, counted: false, cappedReason: "已算过" })] })] }),
    });
    assert.match(result.text, /服务已拿满 · 不计分/);
    const badge = findAll(result, (element) => classOf(element) === "rt-tag rt-tag-warn");
    assert.equal(String(badge[0]?.props["title"]), "已算过");
  });

  it("命中带动作时渲染动作行", () => {
    const { result } = render({
      data: chain({ stages: [stage({ items: [hit({ hasAction: true, actionTitle: "上传马" })] })] }),
    });
    assert.match(result.text, /动作：上传马/);
  });

  it("展开的命中渲染详情", () => {
    const { result } = render({ openId: 1 });
    assert.match(result.text, /次数/);
    assert.match(result.text, /记录/);
  });

  it("**详情里的证据只在有内容时显示**", () => {
    const withEvidence = render({
      openId: 1,
      data: chain({ stages: [stage({ items: [hit({ evidence: "uid=0" })] })] }),
    });
    assert.match(withEvidence.result.text, /结果与证据/);
    assert.match(withEvidence.result.text, /uid=0/);

    const withoutEvidence = render({ openId: 1 });
    assert.doesNotMatch(withoutEvidence.result.text, /结果与证据/);
  });

  it("点命中行切换展开", () => {
    const toggled: number[] = [];
    const { result } = render({ onToggleHit: (id) => toggled.push(id) });
    // `rt-ap-hit-head` 也以 `rt-ap-hit` 开头：用精确匹配拿到行本身。
    const row = findOne(result, (element) => {
      const value = classOf(element);
      return value === "rt-ap-hit" || value === "rt-ap-hit open";
    });
    fire(row!, "onClick");
    assert.deepEqual(toggled, [1]);
  });

  it("键盘 Enter 也能展开", () => {
    const toggled: number[] = [];
    const { result } = render({ onToggleHit: (id) => toggled.push(id) });
    const row = findOne(result, (element) => {
      const value = classOf(element);
      return value === "rt-ap-hit" || value === "rt-ap-hit open";
    });
    fire(row!, "onKeyDown", { key: " " });
    assert.deepEqual(toggled, [1]);
  });

  it("信息收集阶段渲染资产列表", () => {
    const { result } = render({
      data: chain({
        stages: [stage({
          code: "recon",
          assets: [asset({ ip: "10.1.1.1", points: 5 })],
          assetCount: 1,
          items: [],
        })],
      }),
    });
    assert.match(result.text, /拿到分数的资产 · 1 台/);
    assert.match(result.text, /10\.1\.1\.1/);
  });

  it("**信息收集阶段没有资产时给空态**", () => {
    const { result } = render({
      data: chain({ stages: [stage({ code: "recon", assets: [], items: [] })] }),
    });
    assert.match(result.text, /还没有产生得分的资产/);
  });

  it("边界突破阶段渲染隧道清单", () => {
    const { result } = render({
      data: chain({
        stages: [stage({ code: "boundary", tunnels: [tunnel({ listen: "127.0.0.1:1080" })], items: [] })],
      }),
    });
    assert.match(result.text, /跨越靶标边界的通道 · 1 条/);
    assert.match(result.text, /127\.0\.0\.1:1080/);
    assert.match(result.text, /可达 10\.0\.0\.0\/8/);
  });

  it("**边界阶段没有隧道时给登记提示**", () => {
    const { result } = render({
      data: chain({ stages: [stage({ code: "boundary", tunnels: [], items: [] })] }),
    });
    assert.match(result.text, /还没有建立隧道/);
  });

  it("**只有 self-only 通道时渲染警示**", () => {
    const { result } = render({
      data: chain({
        stages: [stage({ code: "boundary", tunnels: [], tunnelsSelfOnly: [tunnel()], items: [] })],
      }),
    });
    assert.match(result.text, /现有的通道都在自己的服务器上/);
  });

  it("其它阶段有资产时渲染涉及资产", () => {
    const { result } = render({
      data: chain({ stages: [stage({ code: "internal", assets: [asset()], assetCount: 1 })] }),
    });
    assert.match(result.text, /涉及资产 · 1 台/);
  });

  it("**边界突破阶段不渲染「涉及资产」**（隧道已经是主线）", () => {
    const { result } = render({
      data: chain({ stages: [stage({ code: "boundary", assets: [asset()], tunnels: [tunnel()], items: [] })] }),
    });
    assert.doesNotMatch(result.text, /涉及资产/);
  });

  it("多阶段之间用 ▼ 连接", () => {
    const { result } = render({
      data: chain({ stages: [stage({ code: "recon" }), stage({ code: "internet" })] }),
    });
    assert.match(result.text, /▼/);
  });

  it("**中间阶段的连接条显示 transition**", () => {
    const { result } = render({
      data: chain({
        stages: [stage({ code: "recon", transition: "收完资产就开打" }), stage({ code: "internet" })],
      }),
    });
    assert.match(result.text, /收完资产就开打/);
  });
});

describe("renderChainTab — 横向视图", () => {
  it("横向视图渲染五个阶段列", () => {
    const { result } = render({
      view: "B",
      data: chain({ stages: [stage({ code: "recon" }), stage({ code: "internet" })] }),
    });
    const cols = findAll(result, (element) => classOf(element) === "rt-ap-col");
    assert.equal(cols.length, 2);
  });

  it("**横向视图的序号是阿拉伯数字**", () => {
    const { result } = render({ view: "B" });
    assert.match(result.text, /<span>1<\/span>/);
  });

  it("横向视图用 ▶ 连接", () => {
    const { result } = render({
      view: "B",
      data: chain({ stages: [stage({ code: "recon" }), stage({ code: "internet" })] }),
    });
    assert.match(result.text, /▶/);
  });

  it("横向视图的信息收集阶段列资产", () => {
    const { result } = render({
      view: "B",
      data: chain({ stages: [stage({ code: "recon", assets: [asset({ ip: "10.1.1.1", points: 5 })], assetCount: 1 })] }),
    });
    assert.match(result.text, /10\.1\.1\.1  \+5/);
  });

  it("**横向视图只列前 6 条资产**", () => {
    const assets = Array.from({ length: 10 }, (_, index) => asset({ id: index + 1, ip: "10.0.0." + index }));
    const { result } = render({
      view: "B",
      data: chain({ stages: [stage({ code: "recon", assets, assetCount: 10 })] }),
    });
    const listed = findAll(result, (element) => classOf(element) === "rt-hcol-sub");
    assert.equal(listed.length, 6);
  });

  it("横向视图的隧道只列前 3 条", () => {
    const tunnels = Array.from({ length: 5 }, (_, index) => tunnel({ id: index + 1, listen: "127.0.0.1:" + (1080 + index) }));
    const { result } = render({
      view: "B",
      data: chain({ stages: [stage({ code: "boundary", tunnels })] }),
    });
    const rows = findAll(result, (element) => classOf(element) === "rt-hcol-sub");
    assert.equal(rows.length, 3);
  });

  it("横向视图的命中超过 6 条时给「另有 N 次」", () => {
    const items = Array.from({ length: 9 }, (_, index) => hit({ id: index + 1, pointName: "P" + index }));
    const { result } = render({
      view: "B",
      data: chain({ stages: [stage({ items })] }),
    });
    assert.match(result.text, /…另有 3 次/);
  });
});

describe("renderChainTab — 空态与错误态", () => {
  it("**data 为 null 时工具栏仍渲染**（不整页空白）", () => {
    const { result } = render({ data: null });
    assert.match(result.text, /攻击链/);
    assert.match(result.text, /刷新/);
  });

  it("**data 为 null 时不显示「还没有得分记录」**（那是读到之后的状态）", () => {
    const { result } = render({ data: null });
    assert.ok(!result.text.includes(EMPTY_CHAIN_MESSAGE));
  });

  it("读到但没有阶段时显示空态", () => {
    const { result } = render({ data: chain({ stages: [], summary: null }) });
    assert.ok(result.text.includes(EMPTY_CHAIN_MESSAGE));
  });

  it("读失败时显示 rt-err", () => {
    const { result } = render({ data: null, error: "库损坏" });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
    assert.match(result.text, /库损坏/);
  });

  it("**读失败时仍渲染工具栏**", () => {
    const { result } = render({ data: null, error: "库损坏" });
    assert.match(result.text, /链路 A/);
  });

  it("错误与阶段同时存在时不显示空态（错误优先）", () => {
    const { result } = render({ data: chain({ stages: [] }), error: "读失败" });
    assert.ok(!result.text.includes(EMPTY_CHAIN_MESSAGE));
  });

  it("loading 时刷新按钮文案变「加载中…」且禁用", () => {
    const { result } = render({ loading: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("加载中"));
    assert.equal(button?.props["disabled"], true);
  });
});

describe("renderChainTab — 视图切换", () => {
  it("点「链路 A」传 A", () => {
    const views: string[] = [];
    const { result } = render({ view: "B", onViewChange: (view) => views.push(view) });
    const button = findAll(result, "button").find((element) => textOf(element) === "链路 A");
    fire(button!, "onClick");
    assert.deepEqual(views, ["A"]);
  });

  it("点「链路 B」传 B", () => {
    const views: string[] = [];
    const { result } = render({ onViewChange: (view) => views.push(view) });
    const button = findAll(result, "button").find((element) => textOf(element) === "链路 B");
    fire(button!, "onClick");
    assert.deepEqual(views, ["B"]);
  });

  it("**当前视图的按钮是 primary**", () => {
    const { result } = render({ view: "B" });
    const active = findAll(result, "button").find((element) => textOf(element) === "链路 B");
    const inactive = findAll(result, "button").find((element) => textOf(element) === "链路 A");
    assert.equal(active?.props["className"], "rt-btn rt-btn-primary");
    assert.equal(inactive?.props["className"], "rt-btn");
  });

  it("点刷新触发 onRefresh", () => {
    let count = 0;
    const { result } = render({ onRefresh: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });
});
