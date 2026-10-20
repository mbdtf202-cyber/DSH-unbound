/**
 * 当前测试页测试（模型层 + 渲染层）。
 *
 * 重点锁住四件事：
 * 1. **在途守卫**：在途时第二次 begin 返回 null、切靶标后旧请求的 finish 不释放闸门
 * 2. **测试记录取最后 3 行**（`slice(-3)`：最近进展在末尾）
 * 3. **chips 只在非 0/非空时出现**（每一枚都有独立判定）
 * 4. **空态四分支** + 三个区块的默认展开态
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  defaultTestingProps,
  renderTestingTab,
  type TestingTabProps,
} from "../../src/redteam/client/testing-tab.js";
import {
  ACTIVE_TESTS_LIMIT,
  EMPTY_QUEUE_TEXT,
  EMPTY_TESTING_TEXT,
  LOADING_TEXT,
  MAX_NOTE_CHARS,
  MAX_NOTE_LINES,
  NO_ENGAGEMENT_TEXT,
  POLL_INTERVAL_MS,
  QUEUE_HINT,
  SECTION_DEFAULTS,
  activeTestsOf,
  activeTestsRequest,
  assetChips,
  autoLabel,
  collapseKey,
  conclusionItems,
  createPollGuard,
  loadActiveTests,
  noteLines,
  potentialLine,
  sectionKeys,
  statusClass,
  statusLabel,
  surfaceLine,
  testStatsOf,
  testingSubtitle,
  updatedAtText,
  updatedText,
  type ActiveTestsData,
  type TestedAsset,
} from "../../src/redteam/client/testing-model.js";
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

/** 造一台资产。 */
function asset(overrides: Partial<TestedAsset> = {}): TestedAsset {
  return {
    id: 1,
    ip: "203.0.113.5",
    segmentCidr: "203.0.113.0/24",
    scope: "external",
    testStatus: "testing",
    testNotes: "",
    testSurface: "SMB 445",
    testUpdatedAt: "2026-09-18T10:00:00Z",
    testUpdatedBy: "exploit",
    blockedCount: 0,
    priority: "high",
    potential: "服务器权限",
    openPorts: 3,
    vulns: 1,
    webshells: 0,
    tunnels: 0,
    ...overrides,
  };
}

/** 造数据。 */
function data(overrides: {
  readonly testing?: readonly TestedAsset[];
  readonly recent?: readonly TestedAsset[];
  readonly queue?: readonly TestedAsset[];
  readonly stats?: Partial<ActiveTestsData["stats"]>;
  readonly untested?: number;
} = {}): ActiveTestsData {
  return {
    testing: overrides.testing ?? [asset()],
    recent: overrides.recent ?? [],
    queue: overrides.queue ?? [],
    stats: {
      testing: overrides.testing?.length ?? 1,
      untested: overrides.untested ?? 4,
      tested: 2,
      abandoned: 1,
      blocked: 1,
      noSurface: 0,
      ...overrides.stats,
    },
    untested: overrides.untested ?? 4,
  };
}

/** 默认 props。 */
function props(overrides: Partial<TestingTabProps> = {}): TestingTabProps {
  return { ...defaultTestingProps("eng-1"), data: data(), ...overrides };
}

/** 渲染。 */
function render(overrides: Partial<TestingTabProps> = {}): ReturnType<typeof renderToText> {
  const runtime = makeRuntime();
  return renderToText(renderTestingTab(runtime, props(overrides)));
}

/* ══════════════════════════════════════════════════════════════ 模型：在途守卫 */

describe("testing-model — 在途守卫", () => {
  it("**在途时第二次 begin 返回 null**（不排队、不并发）", () => {
    const guard = createPollGuard();
    const first = guard.begin();
    assert.notEqual(first, null);
    assert.equal(guard.begin(), null);
    assert.equal(guard.inflight, true);
  });

  it("finish 之后可以再 begin", () => {
    const guard = createPollGuard();
    const token = guard.begin()!;
    guard.finish(token);
    assert.equal(guard.inflight, false);
    assert.notEqual(guard.begin(), null);
  });

  it("isCurrent：只有最新序号有效", () => {
    const guard = createPollGuard();
    const first = guard.begin()!;
    guard.finish(first);
    const second = guard.begin()!;
    assert.equal(guard.isCurrent(first), false);
    assert.equal(guard.isCurrent(second), true);
  });

  it("**切靶标后旧请求的 finish 不释放新请求的闸门**", () => {
    const guard = createPollGuard();
    const stale = guard.begin()!;
    // 切靶标：invalidate 让旧请求失效并重开闸门。
    guard.invalidate();
    const fresh = guard.begin()!;
    assert.equal(guard.inflight, true);
    // 旧请求此时才回来：它不该把新请求的闸门清掉。
    guard.finish(stale);
    assert.equal(guard.inflight, true, "旧 finish 不能释放新闸门");
    guard.finish(fresh);
    assert.equal(guard.inflight, false);
  });

  it("invalidate 让在途请求失效", () => {
    const guard = createPollGuard();
    const token = guard.begin()!;
    guard.invalidate();
    assert.equal(guard.isCurrent(token), false);
    assert.equal(guard.inflight, false);
  });

  it("**序号单调递增**（连点也不会复用同一个 token）", () => {
    const guard = createPollGuard();
    const first = guard.begin()!;
    guard.finish(first);
    const second = guard.begin()!;
    assert.ok(second > first);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：记录与 chips */

describe("testing-model — 测试记录", () => {
  it("**取最后 3 行**（最近进展在末尾）", () => {
    const lines = noteLines(asset({ testNotes: "第1行\n第2行\n第3行\n第4行\n第5行" }));
    assert.equal(lines.length, MAX_NOTE_LINES);
    assert.deepEqual(lines, ["第3行", "第4行", "第5行"]);
  });

  it("不足 3 行时全取", () => {
    assert.deepEqual(noteLines(asset({ testNotes: "a\nb" })), ["a", "b"]);
  });

  it("空记录返回空数组", () => {
    assert.deepEqual(noteLines(asset({ testNotes: "" })), []);
  });

  it("**单行超 240 字符截断并加 ` …`**", () => {
    const long = "x".repeat(300);
    const lines = noteLines(asset({ testNotes: long }));
    assert.equal(lines[0]?.length, MAX_NOTE_CHARS + 2);
    assert.ok(lines[0]?.endsWith(" …"));
  });

  it("正好 240 字符不截断", () => {
    const exact = "x".repeat(MAX_NOTE_CHARS);
    assert.equal(noteLines(asset({ testNotes: exact }))[0], exact);
  });

  it("MAX_NOTE_LINES = 3、MAX_NOTE_CHARS = 240", () => {
    assert.equal(MAX_NOTE_LINES, 3);
    assert.equal(MAX_NOTE_CHARS, 240);
  });
});

describe("testing-model — chips", () => {
  it("**归属 chip 始终存在**", () => {
    const chips = assetChips(asset({ scope: "internal" }));
    assert.equal(chips[0]?.label, "内网");
    assert.equal(assetChips(asset({ scope: "external" }))[0]?.label, "外网");
  });

  it("C 段 chip 只在非空时出现", () => {
    assert.equal(assetChips(asset({ segmentCidr: "" })).some((chip) => chip.key === "seg"), false);
    assert.equal(assetChips(asset({ segmentCidr: "10.0.0.0/24" })).some((chip) => chip.key === "seg"), true);
  });

  it("**每一枚计数 chip 都在 0 时不出现**", () => {
    const chips = assetChips(asset({ openPorts: 0, vulns: 0, webshells: 0, tunnels: 0, blockedCount: 0 }));
    assert.deepEqual(chips.map((chip) => chip.key), ["sc", "seg", "pr"], "只剩归属 / C 段 / 易打性");
  });

  it("计数 > 0 时逐枚出现且文案带数字", () => {
    const chips = assetChips(asset({ openPorts: 3, vulns: 1, webshells: 2, tunnels: 1, blockedCount: 4 }));
    const byKey = new Map(chips.map((chip) => [chip.key, chip.label]));
    assert.equal(byKey.get("p"), "开放 3 端口");
    assert.equal(byKey.get("v"), "已确认漏洞 1");
    assert.equal(byKey.get("w"), "WebShell 2");
    assert.equal(byKey.get("t"), "隧道 1");
    assert.equal(byKey.get("b"), "被封 4 次");
  });

  it("易打性 chip 只在非空时出现", () => {
    assert.equal(assetChips(asset({ priority: "" })).some((chip) => chip.key === "pr"), false);
    assert.equal(assetChips(asset({ priority: "high" })).some((chip) => chip.key === "pr"), true);
  });

  it("chip 顺序固定（归属 → C 段 → 端口 → 漏洞 → 马 → 隧道 → 易打 → 封禁）", () => {
    const chips = assetChips(asset({ openPorts: 1, vulns: 1, webshells: 1, tunnels: 1, blockedCount: 1 }));
    assert.deepEqual(chips.map((chip) => chip.key), ["sc", "seg", "p", "v", "w", "t", "pr", "b"]);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：状态与文本 */

describe("testing-model — 状态与行文本", () => {
  it("statusLabel 用共享标签表，未知状态回退原始值", () => {
    assert.equal(statusLabel(asset({ testStatus: "testing" })), "测试中");
    assert.equal(statusLabel(asset({ testStatus: "brand_new" })), "brand_new");
  });

  it("**只有「测试中」才带 live 高亮类**", () => {
    assert.match(statusClass(asset({ testStatus: "testing" })), /rt-tag-live/);
    assert.doesNotMatch(statusClass(asset({ testStatus: "tested" })), /rt-tag-live/);
  });

  it("surfaceLine / potentialLine 空则 null（不渲染）", () => {
    assert.equal(surfaceLine(asset({ testSurface: "SMB" })), "测试面：SMB");
    assert.equal(surfaceLine(asset({ testSurface: "" })), null);
    assert.equal(potentialLine(asset({ potential: "RCE" })), "预期得分：RCE");
    assert.equal(potentialLine(asset({ potential: "" })), null);
  });

  it("updatedText 带角色，没角色就只报时间", () => {
    assert.equal(updatedText(asset({ testUpdatedBy: "recon" }), "2026-09-18 10:00"), "2026-09-18 10:00 · recon");
    assert.equal(updatedText(asset({ testUpdatedBy: "" }), "2026-09-18 10:00"), "2026-09-18 10:00");
  });

  it("testingSubtitle 空/非空两套文案", () => {
    assert.match(testingSubtitle(0), /开始测某台资产后/);
    assert.match(testingSubtitle(2), /agent 正在打这些资产/);
  });

  it("autoLabel 两态", () => {
    assert.equal(autoLabel(true), "实时 · 5s");
    assert.equal(autoLabel(false), "已暂停");
  });

  it("updatedAtText：null → null，否则带时间", () => {
    assert.equal(updatedAtText(null), null);
    assert.match(String(updatedAtText(new Date("2026-09-18T10:00:00Z"))), /^更新于 /);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：计数与折叠 */

describe("testing-model — 计数与折叠键", () => {
  it("testStatsOf 解析（含 no_surface 的 snake_case）", () => {
    const stats = testStatsOf({ testing: 1, untested: 2, no_surface: 3 });
    assert.equal(stats.noSurface, 3);
    assert.equal(stats.testing, 1);
  });

  it("testStatsOf 容错", () => {
    const stats = testStatsOf({ testing: "abc", untested: -1 });
    assert.equal(stats.testing, 0);
    assert.equal(stats.untested, 0);
  });

  it("conclusionItems 五项，放弃 = abandoned + blocked", () => {
    const items = conclusionItems(testStatsOf({ testing: 1, untested: 2, tested: 3, abandoned: 1, blocked: 2, no_surface: 4 }));
    assert.deepEqual(items.map((item) => item.key), ["testing", "untested", "tested", "giveup", "noSurface"]);
    assert.equal(items[3]?.value, 3);
    assert.equal(items[4]?.value, 4);
  });

  it("**折叠键都带靶标 id**（切靶标各自独立）", () => {
    assert.equal(collapseKey("testing", "eng-1"), "testing:eng-1");
    assert.deepEqual(sectionKeys("eng-1"), ["testing:eng-1", "recent:eng-1", "queue:eng-1"]);
  });

  it("**默认展开态：只在测展开，另两个折叠**", () => {
    assert.equal(SECTION_DEFAULTS.testing, true);
    assert.equal(SECTION_DEFAULTS.recent, false);
    assert.equal(SECTION_DEFAULTS.queue, false);
  });

  it("轮询间隔 5 秒、每次 20 条", () => {
    assert.equal(POLL_INTERVAL_MS, 5000);
    assert.equal(ACTIVE_TESTS_LIMIT, 20);
    assert.equal(activeTestsRequest("eng-1")["limit"], 20);
    assert.equal(activeTestsRequest("eng-1")["op"], "activeTests");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：解析 */

describe("testing-model — 响应解析", () => {
  it("activeTestsOf 解析三个区块 + stats + untested", () => {
    const parsed = activeTestsOf({
      testing: [{ id: 1, ip: "1.1.1.1" }],
      recent: [{ id: 2, ip: "1.1.1.2" }],
      queue: [{ id: 3, ip: "1.1.1.3" }],
      stats: { untested: 9 },
      untested: 9,
    });
    assert.equal(parsed.testing.length, 1);
    assert.equal(parsed.recent[0]?.ip, "1.1.1.2");
    assert.equal(parsed.queue[0]?.ip, "1.1.1.3");
    assert.equal(parsed.untested, 9);
  });

  it("缺字段时三个区块都是空数组（不抛）", () => {
    const parsed = activeTestsOf({});
    assert.deepEqual(parsed.testing, []);
    assert.deepEqual(parsed.recent, []);
    assert.deepEqual(parsed.queue, []);
    assert.equal(parsed.untested, 0);
  });
});

/* ══════════════════════════════════════════════════════════════ 假 api */

function fakeApi(response: ApiResponse, calls: Record<string, unknown>[] = []): ApiClient {
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

describe("renderTestingTab — 四种空态", () => {
  it("**未选靶标**：渲染真实空态", () => {
    const text = render({ engagement: null }).text;
    assert.match(text, new RegExp(NO_ENGAGEMENT_TEXT.slice(0, 8)));
  });

  it("未选靶标时不渲染结论行", () => {
    assert.doesNotMatch(render({ engagement: null }).text, /无攻击面/);
  });

  it("**未加载**（data=null）显示「加载中…」且结论行仍是 0", () => {
    const result = render({ data: null });
    assert.match(result.text, new RegExp(LOADING_TEXT));
    assert.match(result.text, /测试中/);
    // 结论行五项都是 0（不是空白、不是 NaN）。
    const items = findAll(result, (element) => classOf(element) === "rt-concl-i");
    assert.equal(items.length, 5);
    assert.ok(items.every((item) => textOf(item).startsWith("<b>0</b>")));
  });

  it("**没有正在测的资产**时区块内显示说明", () => {
    const text = render({ data: data({ testing: [], stats: { testing: 0 } }) }).text;
    assert.match(text, new RegExp(EMPTY_TESTING_TEXT.slice(0, 8)));
  });

  it("**请求失败**时显示错误条（区块仍渲染）", () => {
    const result = render({ data: null, error: "读取失败" });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-err"), null);
    assert.match(result.text, /正在测/);
    // 有错误时不该再显示「加载中…」（两者互斥）。
    assert.doesNotMatch(result.text, new RegExp(LOADING_TEXT));
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：结论行 */

describe("renderTestingTab — 结论行", () => {
  it("五项计数都在", () => {
    const text = render({ data: data({ stats: { testing: 1, untested: 4, tested: 2, abandoned: 1, blocked: 1, noSurface: 0 } }) }).text;
    for (const label of ["测试中", "待测", "已测", "放弃", "无攻击面"]) {
      assert.match(text, new RegExp(label));
    }
  });

  it("**计数为 0 也渲染成 0**（React 假值坑）", () => {
    const result = render({ data: data({ stats: { testing: 0, untested: 0, tested: 0, abandoned: 0, blocked: 0, noSurface: 0 } }) });
    const items = findAll(result, (element) => classOf(element) === "rt-concl-i");
    assert.equal(items.length, 5);
    for (const item of items) {
      assert.match(textOf(item), /^<b>0<\/b>/);
    }
  });

  it("「放弃」是 abandoned + blocked 之和", () => {
    const result = render({ data: data({ stats: { abandoned: 2, blocked: 3 } }) });
    const node = findAll(result, (element) => classOf(element) === "rt-concl-i")
      .find((element) => textOf(element).includes("放弃"));
    assert.match(textOf(node!), /^<b>5<\/b>/);
  });

  it("更新时间存在时显示「更新于 …」", () => {
    const text = render({ updatedAt: new Date("2026-09-18T10:00:00Z") }).text;
    assert.match(text, /更新于 /);
  });

  it("没有更新时间时不渲染该行", () => {
    assert.doesNotMatch(render({ updatedAt: null }).text, /更新于/);
  });

  it("四个操作按钮都在，实时开关带 primary", () => {
    const result = render({ auto: true });
    for (const label of ["全部展开", "全部收起", "刷新"]) {
      assert.notEqual(findAll(result, "button").find((element) => textOf(element) === label), undefined, label);
    }
    const auto = findAll(result, "button").find((element) => textOf(element).includes("实时"));
    assert.match(classOf(auto!), /rt-btn-primary/);
  });

  it("auto=false 时按钮文案「已暂停」且没有 primary", () => {
    const result = render({ auto: false });
    const button = findAll(result, "button").find((element) => textOf(element) === "已暂停");
    assert.notEqual(button, undefined);
    assert.doesNotMatch(classOf(button!), /rt-btn-primary/);
  });

  it("四个按钮各自回调", () => {
    const calls: string[] = [];
    const result = render({
      onExpandAll: () => calls.push("expand"),
      onCollapseAll: () => calls.push("collapse"),
      onToggleAuto: () => calls.push("auto"),
      onRefresh: () => calls.push("refresh"),
    });
    for (const [label, expect] of [["全部展开", "expand"], ["全部收起", "collapse"], ["刷新", "refresh"]] as const) {
      fire(findAll(result, "button").find((element) => textOf(element) === label)!, "onClick");
      assert.equal(calls[calls.length - 1], expect);
    }
    const auto = findAll(result, "button").find((element) => textOf(element).includes("实时"))!;
    fire(auto, "onClick");
    assert.equal(calls[calls.length - 1], "auto");
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：资产卡 */

describe("renderTestingTab — 资产卡", () => {
  it("渲染 IP / 状态 / 更新时间", () => {
    const text = render().text;
    assert.match(text, /203\.0\.113\.5/);
    assert.match(text, /测试中/);
    assert.match(text, /exploit/);
  });

  it("**正在测的卡带呼吸点，历史卡不带**", () => {
    const live = render({ data: data({ testing: [asset()], recent: [] }) });
    assert.notEqual(findOne(live, (element) => classOf(element) === "rt-live-dot"), null);

    const past = render({ data: data({ testing: [], recent: [asset({ testStatus: "tested" })] }) });
    assert.equal(findOne(past, (element) => classOf(element) === "rt-live-dot"), null);
  });

  it("历史卡带 past 类名（视觉上淡化）", () => {
    // 「最近动过」默认折叠：要显式展开才能看到卡片本身。
    const result = render({
      data: data({ testing: [], recent: [asset({ testStatus: "tested" })] }),
      collapsed: { "recent:eng-1": true },
    });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-atest past"), null);
  });

  it("渲染 chips（含端口 / 漏洞 / 易打性）", () => {
    const text = render().text;
    assert.match(text, /开放 3 端口/);
    assert.match(text, /已确认漏洞 1/);
    assert.match(text, /易打 high/);
  });

  it("**chips 为 0 时那一枚不渲染**", () => {
    const text = render({ data: data({ testing: [asset({ openPorts: 0, vulns: 0 })] }) }).text;
    assert.doesNotMatch(text, /开放 0 端口/);
    assert.doesNotMatch(text, /已确认漏洞 0/);
  });

  it("有测试面与预期得分时显示两行", () => {
    const text = render().text;
    assert.match(text, /测试面：SMB 445/);
    assert.match(text, /预期得分：服务器权限/);
  });

  it("测试面/预期为空时不渲染那两行", () => {
    const text = render({ data: data({ testing: [asset({ testSurface: "", potential: "" })] }) }).text;
    assert.doesNotMatch(text, /测试面：/);
    assert.doesNotMatch(text, /预期得分：/);
  });

  it("有测试记录时渲染折叠块", () => {
    const result = render({ data: data({ testing: [asset({ testNotes: "开始扫描\n扫到 8080" })] }) });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-clip"), null);
    assert.match(result.text, /测试记录/);
  });

  it("没有测试记录时不渲染折叠块", () => {
    const result = render({ data: data({ testing: [asset({ testNotes: "" })] }) });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-clip"), null);
  });

  it("**只显示最后 3 行**（不显示最早那行）", () => {
    const text = render({
      data: data({ testing: [asset({ testNotes: "最早一行\n二\n三\n四\n最新一行" })] }),
    }).text;
    assert.doesNotMatch(text, /最早一行/);
    assert.match(text, /最新一行/);
  });

  it("记录折叠的展开态由 props 决定", () => {
    const closed = render({ data: data({ testing: [asset({ id: 1, testNotes: "a" })] }), openNotes: [] });
    const closedClip = findOne(closed, (element) => classOf(element) === "rt-clip");
    assert.notEqual(closedClip, null);
    assert.doesNotMatch(classOf(closedClip!), /open/);

    const opened = render({ data: data({ testing: [asset({ id: 1, testNotes: "a" })] }), openNotes: [1] });
    assert.notEqual(findOne(opened, (element) => classOf(element) === "rt-clip open"), null);
  });

  it("点记录里的「展开」回调资产 id", () => {
    const toggles: number[] = [];
    const result = render({
      data: data({ testing: [asset({ id: 7, testNotes: "a" })] }),
      onToggleNotes: (id) => toggles.push(id),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "展开")!, "onClick");
    assert.deepEqual(toggles, [7]);
  });

  it("点记录里的「复制」回调全文", () => {
    const copies: string[] = [];
    const result = render({
      data: data({ testing: [asset({ testNotes: "全文内容" })] }),
      onCopy: (text) => copies.push(text),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "复制")!, "onClick");
    assert.deepEqual(copies, ["全文内容"]);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：区块 */

describe("renderTestingTab — 三个区块", () => {
  it("三个区块标题与计数都在", () => {
    const text = render({
      data: data({ testing: [asset({ id: 1 })], recent: [asset({ id: 2, testStatus: "tested" })], queue: [] }),
    }).text;
    assert.match(text, /正在测/);
    assert.match(text, /最近动过/);
    assert.match(text, /待测队列/);
    assert.match(text, /1 台/);
  });

  it("**待测队列的计数用 data.untested（不是 queue.length）**", () => {
    // queue 只展示前 N 台，而 untested 是「一共有多少台待测」。
    const text = render({ data: data({ queue: [asset({ id: 3, testStatus: "untested" })], untested: 42 }) }).text;
    assert.match(text, /42 台/);
  });

  it("**默认只在测展开**：最近动过与待测队列默认折叠", () => {
    const result = render({
      data: data({
        testing: [asset({ id: 1, ip: "1.1.1.1" })],
        recent: [asset({ id: 2, ip: "2.2.2.2", testStatus: "tested" })],
        queue: [asset({ id: 3, ip: "3.3.3.3", testStatus: "untested" })],
      }),
    });
    assert.match(result.text, /1\.1\.1\.1/, "正在测可见");
    assert.doesNotMatch(result.text, /2\.2\.2\.2/, "最近动过默认折叠");
    assert.doesNotMatch(result.text, /3\.3\.3\.3/, "待测队列默认折叠");
  });

  it("显式展开后内容出现", () => {
    const result = render({
      data: data({ recent: [asset({ id: 2, ip: "2.2.2.2", testStatus: "tested" })] }),
      collapsed: { "recent:eng-1": true },
    });
    assert.match(result.text, /2\.2\.2\.2/);
  });

  it("显式折叠「正在测」后内容消失（按代码行为，注释说常显但实现可折叠）", () => {
    const result = render({
      data: data({ testing: [asset({ id: 1, ip: "1.1.1.1" })] }),
      collapsed: { "testing:eng-1": false },
    });
    assert.doesNotMatch(result.text, /1\.1\.1\.1/);
    assert.match(result.text, /正在测/);
  });

  it("待测队列为空时显示空态、非空时带引导", () => {
    const empty = render({ data: data({ queue: [] }), collapsed: { "queue:eng-1": true } });
    assert.match(empty.text, new RegExp(EMPTY_QUEUE_TEXT));
    const filled = render({
      data: data({ queue: [asset({ id: 3, testStatus: "untested" })] }),
      collapsed: { "queue:eng-1": true },
    });
    assert.match(filled.text, new RegExp(QUEUE_HINT.slice(0, 6)));
  });

  it("最近动过为空时显示「暂无」", () => {
    const text = render({ data: data({ recent: [] }), collapsed: { "recent:eng-1": true } }).text;
    assert.match(text, /暂无/);
  });

  it("点区块标题触发 onToggleSection（带靶标的键）", () => {
    const keys: string[] = [];
    const result = render({ onToggleSection: (key) => keys.push(key) });
    const head = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => textOf(element).includes("最近动过"));
    fire(head!, "onClick");
    assert.deepEqual(keys, ["recent:eng-1"]);
  });

  it("区块标题键盘可达（Space）", () => {
    const keys: string[] = [];
    const result = render({ onToggleSection: (key) => keys.push(key) });
    const head = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => textOf(element).includes("待测队列"));
    fire(head!, "onKeyDown", { key: " " });
    assert.deepEqual(keys, ["queue:eng-1"]);
  });

  it("区块头带 aria-expanded", () => {
    const result = render();
    const head = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => textOf(element).includes("正在测"));
    assert.equal(head?.props["aria-expanded"], "true");
  });
});

/* ══════════════════════════════════════════════════════════════ 流程 */

describe("testing-model — 加载流程", () => {
  it("loadActiveTests 成功返回数据", async () => {
    const api = fakeApi({ ok: true, testing: [{ id: 1 }], stats: { testing: 1 }, untested: 2 });
    const result = await loadActiveTests(api, "eng-1");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.testing.length, 1);
  });

  it("loadActiveTests 失败返回 err", async () => {
    const api = fakeApi({ ok: false, error: "读取失败" });
    const result = await loadActiveTests(api, "eng-1");
    assert.equal(result.ok === false && result.error, "读取失败");
  });

  it("loadActiveTests 发 activeTests 带 limit", async () => {
    const calls: Record<string, unknown>[] = [];
    await loadActiveTests(fakeApi({ ok: true }, calls), "eng-1");
    assert.equal(calls[0]?.["op"], "activeTests");
    assert.equal(calls[0]?.["limit"], 20);
    assert.equal(calls[0]?.["engagement"], "eng-1");
  });

  it("失败但没文案时兜底「读取失败」", async () => {
    const result = await loadActiveTests(fakeApi({ ok: false }), "eng-1");
    assert.equal(result.ok === false && result.error, "读取失败");
  });
});

/* ══════════════════════════════════════════════════════════════ 端到端 */

describe("端到端：从原始响应一路渲染", () => {
  it("完整响应渲染出三区块 / chips / 记录 / 计数", () => {
    const parsed = activeTestsOf({
      ok: true,
      untested: 12,
      stats: { testing: 1, untested: 12, tested: 5, abandoned: 1, blocked: 2, no_surface: 3 },
      testing: [{
        id: 1,
        ip: "10.0.0.5",
        segment_cidr: "10.0.0.0/24",
        scope: "internal",
        test_status: "testing",
        test_notes: "扫到 445\n试了个弱口令",
        test_surface: "SMB",
        test_updated_at: "2026-09-18T10:00:00Z",
        test_updated_by: "internal",
        open_ports: 5,
        vulns: 2,
        webshells: 1,
        priority: "high",
        potential: "服务器权限",
      }],
      recent: [{ id: 2, ip: "10.0.0.6", test_status: "tested", test_updated_at: "2026-09-18T09:00:00Z" }],
      queue: [{ id: 3, ip: "10.0.0.7", test_status: "untested", priority: "high", open_ports: 9 }],
    });
    const runtime = makeRuntime();
    const text = renderToText(renderTestingTab(runtime, props({ data: parsed, collapsed: { "recent:eng-1": true, "queue:eng-1": true } }))).text;
    assert.match(text, /10\.0\.0\.5/);
    assert.match(text, /内网/);
    assert.match(text, /开放 5 端口/);
    assert.match(text, /已确认漏洞 2/);
    assert.match(text, /WebShell 1/);
    assert.match(text, /测试面：SMB/);
    assert.match(text, /试了个弱口令/);
    assert.match(text, /10\.0\.0\.6/);
    assert.match(text, /10\.0\.0\.7/);
    assert.match(text, /12 台/, "待测队列计数用 untested");
  });
});
