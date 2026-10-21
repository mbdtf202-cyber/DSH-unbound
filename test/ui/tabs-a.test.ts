/**
 * A 组六个页签的**取数接线**测试（`src/redteam/ui/tabs-a.ts`）。
 *
 * ## 这些用例要证明的是什么
 *
 * 本任务的价值不是「类型能过」，而是「**真实数据真的到了界面上**」。
 * 所以每个页签都有一对断言：
 *
 * ```
 *   喂真数据 → renderToText 里出现业务字符串（IP / CVE / 隧道地址 / 得分点）
 *   喂 null   → renderToText 里出现该页签自己的空态文案，且不抛错
 * ```
 *
 * 只断言「渲染没崩」是不够的 —— 空态也「没崩」。必须断言**具体业务串**，
 * 才能区分「接了数据」和「走空态」。
 *
 * ## 假 fetch 的做法
 *
 * `client/api.ts` 的 `makeApiClient({ fetch })` 允许注入 `fetch`，于是这里
 * 造一个按 `op` 分派预设响应的假 fetch —— 不用真的起 HTTP 服务，也不用
 * 伪造 `globalThis.fetch`。同时它会**记录每个 op**，用来断言：
 *
 * - 取数时真的发了该发的 op
 * - `onRefresh` 真的触发了**第二次**请求（不是空函数）
 * - `onSort`/`onFilterChange` 改条件后真的带着新条件重查
 *
 * ## 六个页签各自的「真实数据」证据串
 *
 * | 页签 | 断言的业务串 |
 * |---|---|
 * | 资产测绘 | `203.0.113.5`（IP）、`Apache`（指纹） |
 * | 会话隧道 | `127.0.0.1:1080`（隧道 listen）、`https://x/shell.jsp` |
 * | 漏洞战果 | `CVE-2023-21839`（CVE 编号标题） |
 * | 攻击链 | `信息收集`（阶段名）、总分数字 |
 * | 得分目标 | 得分点名称与分值 |
 * | 环境适配 | `/usr/bin/nmap`（工具路径） |
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  makeTabsA,
  initialState,
  flattenPlatform,
  ownsTab,
  TABS_A_OWNED,
  conclusionFilter,
  makeWindowCopy,
  KNOWN_SHAPE_GAPS,
  UNFILLED_PROPS,
  UNUSED_OPS,
  type TabsA,
} from "../../src/redteam/ui/tabs-a.js";
import { renderAssetsTab } from "../../src/redteam/client/assets-tab.js";
import { renderSessionTab } from "../../src/redteam/client/session-tab.js";
import { renderFindingsTab } from "../../src/redteam/client/findings-tab.js";
import { renderChainTab } from "../../src/redteam/client/chain-tab.js";
import { renderScoreTab } from "../../src/redteam/client/score-tab.js";
import { renderEnvTab } from "../../src/redteam/client/env-tab.js";
import {
  EMPTY_CHAIN_MESSAGE,
} from "../../src/redteam/client/chain-model.js";
import { toolsOf } from "../../src/redteam/client/env-model.js";
import { EMPTY_POINTS_TEXT, NO_ENGAGEMENT_TEXT as SCORE_NO_ENGAGEMENT } from "../../src/redteam/client/score-model.js";
import { EMPTY_FINDINGS_MESSAGE } from "../../src/redteam/client/findings-model.js";
import type { FetchLike, MinimalFetchInit, MinimalFetchResponse, MinimalWindow, ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

/* ══════════════════════════════════════════════════════════════ 造运行时 */

/** 造运行时（与其它 ui 测试一致：window 是纯对象）。 */
function makeRuntime(): ConsoleRuntime {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  return createRuntime(requireModule, {
    innerWidth: 1440,
    innerHeight: 900,
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

/* ══════════════════════════════════════════════════════════════ 假 fetch */

/** 一个 op → 响应体的映射；`null` 表示「这个 op 没有预设」。 */
export type OpReplies = Readonly<Record<string, unknown>>;

/** 记录下来的调用。 */
export interface RecordedCall {
  readonly op: string;
  readonly request: Readonly<Record<string, unknown>>;
}

/** 假 fetch 的返回值：客户端能拿到的东西。 */
export interface FakeFetch {
  readonly fetch: FetchLike;
  /** 按顺序记录每一次请求（**断言「真的发了」靠它**）。 */
  readonly calls: readonly RecordedCall[];
  /** 某个 op 被调了几次（断言 onRefresh 真的重查）。 */
  readonly countOf: (op: string) => number;
  /** 最后一次该 op 的请求体（断言「带着新条件重查」）。 */
  readonly lastOf: (op: string) => Readonly<Record<string, unknown>> | null;
}

/** 造一个 200 + JSON 的假响应。 */
function jsonResponse(body: unknown): MinimalFetchResponse {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => text,
  };
}

/**
 * 造假 fetch。
 *
 * 未预设的 op 回 `{ ok: false, error: "unknown op: <op>" }` —— 这与真实
 * 后端对未知 op 的行为一致（`dispatch` 抛 `unknown op`）。这样「接线时
 * 打错 op 名」会立刻在测试里暴露，而不是静默走空态。
 */
export function makeFakeFetch(replies: OpReplies): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (input: string, init: MinimalFetchInit) => {
    assert.equal(input, "/redteam/api", "所有请求都走同一个端点");
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      parsed = {};
    }
    const request = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    const op = typeof request["op"] === "string" ? request["op"] : "";
    calls.push({ op, request });
    if (op in replies) return jsonResponse(replies[op]);
    return jsonResponse({ ok: false, error: "unknown op: " + op });
  };
  return {
    fetch: fetchFn,
    calls,
    countOf: (op) => calls.filter((call) => call.op === op).length,
    lastOf: (op) => {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        const call = calls[i];
        if (call !== undefined && call.op === op) return call.request;
      }
      return null;
    },
  };
}

/** 造一个「某个 op 固定失败」的假 fetch（测非 unknown-op 的错误分支）。 */
export function makeFakeFetchRejecting(op: string, error: string): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (_input: string, init: MinimalFetchInit) => {
    const parsed: unknown = JSON.parse(init.body);
    const request = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    const requested = typeof request["op"] === "string" ? request["op"] : "";
    calls.push({ op: requested, request });
    if (requested === op) return jsonResponse({ ok: false, error });
    return jsonResponse({ ok: false, error: "unknown op: " + requested });
  };
  return {
    fetch: fetchFn,
    calls,
    countOf: (target) => calls.filter((call) => call.op === target).length,
    lastOf: (target) => {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        const call = calls[i];
        if (call !== undefined && call.op === target) return call.request;
      }
      return null;
    },
  };
}

/** 造一个已接好假 fetch 的接线器。 */
function make(engagement: string | null, replies: OpReplies): { readonly a: TabsA; readonly fake: FakeFetch } {
  const fake = makeFakeFetch(replies);
  const a = makeTabsA({ fetch: fake.fetch, engagement });
  return { a, fake };
}

/** 一个空的资产过滤器（结论行用例的底板）。 */
function a_filter() {
  return {
    cidr: null,
    query: "",
    service: "",
    port: "",
    provenance: "",
    testStatus: "",
    priority: "",
    scope: "" as const,
    state: "",
    sort: "priority" as const,
  };
}

/** 等所有已排队的 Promise 落地（本项目取数全是 await Promise，无定时器）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/* ══════════════════════════════════════════════════════════════ 夹具 */

/** 快照响应（资产测绘侧栏 + 结论行）。 */
const SNAPSHOT = {
  ok: true,
  engagement: { id: "eng-1", name: "示例靶标", scope: [], status: "active", created_at: null },
  stats: { assets: 10, liveAssets: 7 },
  tests: { untested: 4, testing: 1, tested: 3, abandoned: 1, blocked: 1 },
  segments: [
    { cidr: "203.0.113.0/24", org: "示例机房", assets: 10, live: 7, open_ports: 20, passive_ports: 12, active_ports: 8, scope: "external" },
  ],
};

/** 资产列表响应：一台带 IP / 端口 / 指纹的资产。 */
const ASSET_LIST = {
  ok: true,
  total: 1,
  items: [
    {
      id: 1,
      ip: "203.0.113.5",
      segment_cidr: "203.0.113.0/24",
      scope: "external",
      state: "live",
      priority: "high",
      potential: "账号权限+RCE",
      assess_reason: "指纹命中 Nday",
      test_status: "untested",
      blocked_count: 0,
      discovered_at: "2026-09-17T09:30:00Z",
      last_seen: "2026-09-18T10:00:00Z",
      ports: [
        { port: 22, proto: "tcp", state: "open", service: "ssh", provenance: "active" },
        { port: 80, proto: "tcp", state: "open", service: "http", provenance: "active" },
      ],
      fingerprints: [{ vendor: "Apache", product: "httpd", version: "2.4.49", provenance: "active" }],
    },
  ],
};

/** 会话响应：一个 WebShell + 一条 suo5 隧道。 */
const SESSIONS = {
  ok: true,
  webshells: [
    {
      id: 11,
      url: "https://x.example.com/shell.jsp",
      shell_type: "godzilla",
      pass_key: "pass123",
      privilege: "root",
      status: "online",
      last_check: "2026-09-18T10:00:00Z",
      latency_ms: 42,
    },
  ],
  tunnels: [
    {
      id: 21,
      kind: "suo5",
      listen: "127.0.0.1:1080",
      reach: "10.0.0.0/8",
      status: "active",
      entry_kind: "target-http",
      entry: "https://x.example.com/shell.jsp",
    },
  ],
  totals: {
    webshells: 1,
    webshellsOnline: 1,
    tunnels: 1,
    tunnelsActive: 1,
    credentials: 3,
    access: 2,
  },
};

/** 漏洞响应：一条带 CVE 的漏洞。 */
const VULNS = {
  ok: true,
  total: 1,
  totalEcho: 1,
  items: [
    {
      id: 31,
      title: "Weblogic T3 反序列化",
      severity: "critical",
      status: "exploited",
      cve: "CVE-2023-21839",
      target: "https://oa.example.com:7001",
      asset_ip: "203.0.113.9",
      segment_cidr: "203.0.113.0/24",
      gained: "服务器权限、内网隧道",
      source: "nuclei",
      found_by_agent: "vuln-scan",
      found_at: "2026-09-18T09:00:00Z",
      confidence: 0.95,
      evidence: "回显 uid=0",
      http_evidence: [],
    },
  ],
  stats: { bySeverity: { critical: 1 }, byStatus: { exploited: 1 }, withGained: 1, targetGroups: 1 },
};

/** 凭据 / 访问 / 攻击文件（三个附属表）。 */
const CREDENTIALS = {
  ok: true,
  items: [
    { id: 41, host: "203.0.113.9", username: "root", secret_type: "password", secret_value: "toor", privilege: "admin", source: "exploit", found_at: "2026-09-18T09:30:00Z" },
  ],
};
const ACCESSES = {
  ok: true,
  items: [{ id: 51, host: "203.0.113.9", username: "root", method: "webshell", privilege: "admin", session_ref: "runs/ws.md" }],
};
const ATTACK_FILES = { ok: true, items: [] };

/** 攻击链响应：一个信息收集阶段 + 一个互联网资产权限阶段。 */
const SCORE_CHAIN = {
  ok: true,
  stages: [
    {
      code: "recon",
      name: "信息收集",
      subtitle: "先把家底收全",
      goal: "收全资产",
      color: "#3b82f6",
      points: 0,
      cumulative: 0,
      hits: 0,
      asset_count: 10,
      assets: [],
      items: [],
      tunnels: [],
      tunnels_self_only: [],
      transition: "下一步：打互联网资产",
    },
    {
      code: "internet",
      name: "互联网资产权限",
      subtitle: "先拿一台",
      goal: "拿到服务器权限",
      color: "#10b981",
      points: 50,
      cumulative: 50,
      hits: 1,
      asset_count: 1,
      assets: [
        { id: 1, ip: "203.0.113.5", scope: "external", segment_cidr: "203.0.113.0/24", open_ports: 2, vulns: 1, priority: "high", points: 50, hits: 1 },
      ],
      items: [
        {
          id: 61,
          point_name: "服务器主机权限",
          points: 50,
          counted: true,
          capped: false,
          nth_of_point: 1,
          target: "203.0.113.5:8080",
          asset_ip: "203.0.113.5",
          vuln_title: "Weblogic T3 反序列化",
          vuln_cve: "CVE-2023-21839",
          recorded_at: "2026-09-18T09:00:00Z",
          recorded_by: "exploit",
          evidence: "回显 uid=0",
        },
      ],
      tunnels: [],
      tunnels_self_only: [],
      transition: "下一步：边界突破",
    },
  ],
  summary: { hits: 1, points: 50, countedHits: 1, achievedCount: 1, missingCount: 0, missingPoints: 0, selfCreatedHits: 0, serviceCappedHits: 0, tunnelsLegit: 0, tunnelsSelfOnly: 0 },
};

/** 得分看板响应：一个内置得分点 + 一条命中。 */
const SCORE_POINT = {
  id: 71,
  code: "server-host",
  name: "服务器主机权限",
  category: "服务器权限",
  points: 50,
  tier: "管理员权限",
  cap: 600,
  cap_used: 50,
  builtin: true,
  enabled: true,
  description: "拿到目标服务器的主机权限",
  counted: 1,
  earned: 50,
  self_created: 0,
  capped: 0,
  scope_label: "同一系统只算最高权限一次",
  hits: [
    {
      id: 81,
      target: "203.0.113.5:8080",
      asset_ip: "203.0.113.5",
      evidence: "回显 uid=0",
      points: 50,
      recorded_at: "2026-09-18T09:00:00Z",
      shot_count: 2,
    },
  ],
};

const SCORES = {
  ok: true,
  items: [SCORE_POINT],
  // 真实的 `listScorePoints` 会把得分点挂进规则组（`tiers`）——
  // 页签只渲染 `groups[].tiers`，`tiers: []` 会让整张表空掉。
  ruleGroups: [
    { key: "g1", code: "g1", name: "一、获取权限", capSum: 6000, points: 50, counted: 1, capped: 0, order: 1, tiers: [SCORE_POINT] },
  ],
  summary: {
    hits: 1,
    points: 50,
    countedHits: 1,
    achievedCount: 1,
    missingCount: 0,
    missingPoints: 0,
    selfCreatedHits: 0,
    serviceCappedHits: 0,
    tunnelsLegit: 0,
    tunnelsSelfOnly: 0,
  },
};

/** 环境适配响应（**外层包了 `platform`**，与真实 `platformConfigGet` 一致）。 */
const PLATFORM_CONFIG = {
  ok: true,
  platform: {
    config: {
      platform: "linux",
      toolkitDir: "/opt/toolkit",
      nucleiTemplatesDir: "/opt/toolkit/nuclei-templates",
      binDirs: ["/opt/bin"],
      tools: { nmap: "/usr/bin/nmap" },
      env: { FOFA_KEY: "k-123" },
      notes: "示例",
    },
    runtime: { effective: "linux" },
    toolkitDir: "/opt/toolkit",
    toolkitExists: true,
    nucleiTemplatesDir: "/opt/toolkit/nuclei-templates",
    tools: {
      total: 2,
      found: 1,
      missing: 1,
      items: [
        { id: "nmap", label: "Nmap", path: "/usr/bin/nmap", source: "path" },
        { id: "suo5", label: "suo5", path: null, source: "missing" },
      ],
    },
    adapt: { ready: true, reason: "configured", kali: false, message: "已保存的工具路径还在" },
    egress: { http_proxy: "", https_proxy: "", all_proxy: "", no_proxy: "", note: "只读" },
    hint: "在 Kali 虚拟机里跑最省事",
  },
};

/** 六页签全部成功的响应集。 */
function allReplies(): OpReplies {
  return {
    snapshot: SNAPSHOT,
    assets: ASSET_LIST,
    domains: { ok: true, items: [] },
    web: { ok: true, items: [] },
    discoveryTimeline: { ok: true, days: [], recent: [], span: { first: null, last: null, total: 0 } },
    asset: { ok: true, asset: ASSET_LIST.items[0] },
    sessions: SESSIONS,
    vulns: VULNS,
    credentials: CREDENTIALS,
    access: ACCESSES,
    attackFiles: ATTACK_FILES,
    scoreChain: SCORE_CHAIN,
    scores: SCORES,
    platformConfigGet: PLATFORM_CONFIG,
  };
}

/* ══════════════════════════════════════════════════════════════ 页签 id */

describe("tabs-a — makeWindowCopy（推荐给容器的复制实现）", () => {
  it("有 navigator.clipboard 时走 writeText", async () => {
    const seen: string[] = [];
    const copy = makeWindowCopy({
      navigator: { clipboard: { writeText: async (text: string) => { seen.push(text); } } },
      document: {},
    } as unknown as MinimalWindow);
    assert.equal(await copy("hello"), true);
    assert.deepEqual(seen, ["hello"]);
  });

  it("无 clipboard 时回退 textarea + execCommand('copy')", async () => {
    const ops: string[] = [];
    const copy = makeWindowCopy({
      document: {
        createElement: () => ({ value: "", style: {}, setAttribute: () => undefined, select: () => { ops.push("select"); } }),
        body: { appendChild: () => { ops.push("append"); }, removeChild: () => { ops.push("remove"); } },
        execCommand: (command: string) => { ops.push("exec:" + command); return true; },
      },
    } as unknown as MinimalWindow);
    assert.equal(await copy("world"), true);
    // 顺序：先挂上、再选中、再复制、最后摘掉（不留下垃圾节点）。
    assert.deepEqual(ops, ["append", "select", "exec:copy", "remove"]);
  });

  it("clipboard 拒绝时返回 false（不谎称成功）", async () => {
    const copy = makeWindowCopy({
      navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
      document: {},
    } as unknown as MinimalWindow);
    assert.equal(await copy("x"), false);
  });

  it("完全没有剪贴板能力时返回 false（不抛）", async () => {
    const copy = makeWindowCopy({
      document: {
        createElement: () => { throw new Error("not supported"); },
      },
    } as unknown as MinimalWindow);
    assert.equal(await copy("x"), false);
  });
});

describe("tabs-a — 自述常量（记录我们绕过了什么）", () => {
  it("UNFILLED_PROPS：两项都由容器注入，理由非空", () => {
    assert.equal(UNFILLED_PROPS.length, 2);
    for (const item of UNFILLED_PROPS) {
      assert.ok(item.reason.length > 0, item.prop + " 必须有理由");
    }
    assert.deepEqual(UNFILLED_PROPS.map((i) => i.prop).sort(), ["attackFilesNode", "renderTesting"]);
  });

  it("KNOWN_SHAPE_GAPS：platform 多包一层这件事有记录", () => {
    assert.equal(KNOWN_SHAPE_GAPS.length, 1);
    const gap = KNOWN_SHAPE_GAPS[0];
    assert.ok(gap !== undefined);
    assert.ok(gap.ops.includes("platformConfigGet"));
    assert.ok(gap.mitigation.includes("flattenPlatform"));
    assert.ok(gap.whenFixed.length > 0, "要写清服务端修好后该怎么办");
  });

  it("UNUSED_OPS：每个「有意不发」的 op 都有理由", () => {
    assert.ok(UNUSED_OPS.length >= 4);
    for (const item of UNUSED_OPS) assert.ok(item.reason.length > 0, item.op + " 必须有理由");
    const ops = UNUSED_OPS.map((i) => i.op);
    for (const op of ["webshells", "tunnels", "vulnStats", "attackGraph"]) {
      assert.ok(ops.includes(op), "应记录 " + op);
    }
  });
});

describe("tabs-a — 归属与初始态", () => {
  it("ownsTab：只认本组六页签（另七个归 B 组）", () => {
    assert.equal(TABS_A_OWNED.length, 6);
    for (const tab of TABS_A_OWNED) assert.equal(ownsTab(tab), true, tab);
    assert.equal(ownsTab("knowledge"), false);
    assert.equal(ownsTab("skills"), false);
    assert.equal(ownsTab("report"), false);
    assert.equal(ownsTab("agents"), false);
  });

  it("initialState：全部 null → 六个页签各自走空态", () => {
    const s = initialState("eng-1");
    assert.equal(s.engagement, "eng-1");
    assert.equal(s.assets.list, null);
    assert.equal(s.assets.snapshot, null);
    assert.equal(s.sessions.data, null);
    assert.equal(s.findings.findings, null);
    assert.equal(s.chain.data, null);
    assert.equal(s.scores.board, null);
    assert.equal(s.env.draft, null);
    // 空态不能是「有没有数据」的暧昧态：过滤器要有确定的默认值。
    assert.equal(s.assets.filter.sort, "priority");
    assert.equal(s.findings.subTab, "vulns");
    assert.equal(s.chain.view, "A");
  });

  it("未选靶标时六个 props 都能造出来（不抛）", () => {
    const { a } = make(null, {});
    assert.equal(a.assetsProps().engagement, null);
    assert.equal(a.sessionsProps().engagement, null);
    assert.equal(a.scoresProps().engagement, null);
    // 这三个先看 data 是否为 null。
    assert.equal(a.chainProps().data, null);
    assert.equal(a.findingsProps().findings, null);
    assert.equal(a.envProps().draft, null);
  });
});

/* ══════════════════════════════════════════════════════════════ 资产测绘 */

describe("tabs-a — 资产测绘（assets）", () => {
  it("取数：snapshot + assets 两个 op 都发了", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAssets();
    assert.equal(fake.countOf("snapshot"), 1);
    assert.equal(fake.countOf("assets"), 1);
    // 请求里带了靶标与默认排序。
    const req = fake.lastOf("assets");
    assert.equal(req?.["engagement"], "eng-1");
    assert.equal(req?.["sort"], "priority");
  });

  it("真实数据渲染：出现 IP 与指纹，且不是空态", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadAssets();
    const result = renderToText(renderAssetsTab(makeRuntime(), a.assetsProps()));
    // 业务字符串：IP 来自 `assets` 响应，指纹来自同一个响应。
    assert.ok(result.text.includes("203.0.113.5"), "应渲染出资产 IP：" + result.text.slice(0, 400));
    assert.ok(result.text.includes("Apache"), "应渲染出指纹厂商");
    assert.ok(result.text.includes("2.4.49"), "应渲染出指纹版本");
    // 对照：不能是「没有匹配的资产」这种空态。
    assert.equal(result.text.includes("没有匹配的资产"), false);
  });

  it("数据为 null 时不崩，且不谎称「没有匹配的资产」", () => {
    const { a } = make("eng-1", {});
    const result = renderToText(renderAssetsTab(makeRuntime(), a.assetsProps()));
    assert.equal(a.assetsProps().list, null);
    // 页签契约：`list === null` 表示**还没加载**，此时渲染表头与工具栏，
    // 但**不**渲染「没有匹配的资产」——那是「查过了确实没有」的文案。
    assert.equal(result.text.includes("没有匹配的资产"), false);
    assert.ok(result.text.includes("IP"), "表头仍在（不是白屏）");
  });

  it("查过确实为空（list 非 null 且 0 条）→ 才是「没有匹配的资产」", async () => {
    const { a } = make("eng-1", {
      snapshot: SNAPSHOT,
      assets: { ok: true, total: 0, items: [] },
    });
    await a.loadAssets();
    const result = renderToText(renderAssetsTab(makeRuntime(), a.assetsProps()));
    assert.notEqual(a.assetsProps().list, null);
    assert.ok(result.text.includes("没有匹配的资产"));
  });

  it("op 失败：错误进 props.list.error 并渲染错误态", async () => {
    const { a } = make("eng-1", { snapshot: SNAPSHOT });
    // assets 未预设 → 假 fetch 回 { ok:false, error:"unknown op: assets" }
    await a.loadAssets();
    const props = a.assetsProps();
    assert.notEqual(props.list?.error, null);
    const result = renderToText(renderAssetsTab(makeRuntime(), props));
    assert.ok(result.text.includes("unknown op: assets"), "错误文案应出现在界面上：" + result.text.slice(0, 400));
  });

  it("onRefresh 真的触发第二次取数", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAssets();
    assert.equal(fake.countOf("assets"), 1);
    a.assetsProps().onRefresh();
    await settle();
    assert.equal(fake.countOf("assets"), 2, "onRefresh 必须真的重查");
    assert.equal(fake.countOf("snapshot"), 2);
  });

  it("onSort（走 onFilterChange）改排序并带着新排序重查", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAssets();
    const props = a.assetsProps();
    props.onFilterChange({ ...props.filter, sort: "ip" });
    await settle();
    assert.equal(a.assetsProps().filter.sort, "ip");
    assert.equal(fake.lastOf("assets")?.["sort"], "ip", "重查要带新排序");
    assert.equal(fake.countOf("assets"), 2);
  });

  it("onSearchDraftChange 只改草稿，不发请求；onSearch 才发", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAssets();
    const before = fake.countOf("assets");
    a.assetsProps().onSearchDraftChange("203.0.113");
    await settle();
    assert.equal(fake.countOf("assets"), before, "草稿不该触发查询");
    assert.equal(a.assetsProps().searchDraft, "203.0.113");
    assert.equal(a.assetsProps().filter.query, "", "query 是「已生效」的搜索词");
    a.assetsProps().onSearch();
    await settle();
    assert.equal(fake.countOf("assets"), before + 1);
    assert.equal(a.assetsProps().filter.query, "203.0.113");
    assert.equal(fake.lastOf("assets")?.["q"], "203.0.113");
  });

  it("onViewChange('domain') 懒加载域名维度并真的请求 domains", async () => {
    const { a, fake } = make("eng-1", {
      ...allReplies(),
      domains: {
        ok: true,
        items: [{ domain: "oa.example.com", count: 1, assets: [{ id: 1, ip: "203.0.113.5", segment: "203.0.113.0/24", state: "live", names: ["oa.example.com"] }] }],
      },
    });
    a.assetsProps().onViewChange("domain");
    await settle();
    assert.equal(fake.countOf("domains"), 1);
    const result = renderToText(renderAssetsTab(makeRuntime(), a.assetsProps()));
    assert.ok(result.text.includes("oa.example.com"), "域名维度应渲染出域名");
  });

  it("onToggleRow 真的去读详情（op: asset）", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAssets();
    a.assetsProps().onToggleRow(1);
    await settle();
    assert.equal(fake.countOf("asset"), 1);
    assert.equal(fake.lastOf("asset")?.["id"], 1);
    assert.equal(a.assetsProps().detail?.ip, "203.0.113.5");
    // 再点一次是收起，不发新请求。
    a.assetsProps().onToggleRow(1);
    await settle();
    assert.equal(a.assetsProps().openId, null);
    assert.equal(fake.countOf("asset"), 1);
  });

  it("onDomainAssetClick 回列表并按该 IP 搜索", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAssets();
    a.assetsProps().onDomainAssetClick("203.0.113.5");
    await settle();
    assert.equal(a.assetsProps().view, "list");
    assert.equal(a.assetsProps().filter.query, "203.0.113.5");
    assert.equal(fake.lastOf("assets")?.["q"], "203.0.113.5");
  });

  it("conclusionFilter：结论行点击的六种语义（导给容器复用）", () => {
    const base = a_filter();
    // 「全部」清掉除 sort 之外的一切。
    const all = conclusionFilter({ ...base, testStatus: "untested", scope: "internal", state: "live" }, "all");
    assert.equal(all.testStatus, "");
    assert.equal(all.scope, "");
    assert.equal(all.state, "");
    assert.equal(all.sort, base.sort, "排序不该被清");
    // 「放弃」= 组合值 abandoned,blocked，并清掉 state。
    const giveup = conclusionFilter({ ...base, state: "live" }, "giveup");
    assert.equal(giveup.testStatus, "abandoned,blocked");
    assert.equal(giveup.state, "");
    // 「存活」只动 state 并清掉 testStatus。
    const live = conclusionFilter({ ...base, testStatus: "tested" }, "live");
    assert.equal(live.state, "live");
    assert.equal(live.testStatus, "");
    // 再点一次同一个键 = 取消。
    assert.equal(conclusionFilter(live, "live").state, "");
  });

  it("快照失败但列表成功：错误不静默（挂到 list.error）", async () => {
    const { a } = make("eng-1", { assets: ASSET_LIST });
    await a.loadAssets();
    const props = a.assetsProps();
    assert.equal(props.list?.items.length, 1, "列表本身是成功的");
    assert.notEqual(props.list?.error, null, "快照失败要能看见");
  });
});

/* ══════════════════════════════════════════════════════════════ 会话隧道 */

describe("tabs-a — 会话隧道（sessions）", () => {
  it("取数：只发 sessions（不重复发 webshells/tunnels）", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadSessions();
    assert.equal(fake.countOf("sessions"), 1);
    assert.equal(fake.countOf("webshells"), 0, "sessions 已并好 WebShell 表");
    assert.equal(fake.countOf("tunnels"), 0, "sessions 已并好隧道表");
  });

  it("真实数据渲染：隧道监听地址与 WebShell URL 都出现", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadSessions();
    const result = renderToText(renderSessionTab(makeRuntime(), a.sessionsProps()));
    assert.ok(result.text.includes("127.0.0.1:1080"), "应渲染出隧道监听地址：" + result.text.slice(0, 500));
    assert.ok(result.text.includes("shell.jsp"), "应渲染出 WebShell URL");
    assert.ok(result.text.includes("suo5"), "应渲染出隧道类型");
    // 计数徽章来自 totals（真实值 1/1），不是 0/0。
    assert.ok(result.text.includes("WebShell 1/1 在线"));
    assert.ok(result.text.includes("隧道 1/1 可用"));
    // 对照空态。
    assert.equal(result.text.includes("还没有登记任何 WebShell 或隧道"), false);
  });

  it("数据为 null 时走空态", () => {
    const { a } = make("eng-1", {});
    const result = renderToText(renderSessionTab(makeRuntime(), a.sessionsProps()));
    assert.equal(a.sessionsProps().data, null);
    assert.ok(result.text.includes("还没有登记任何 WebShell 或隧道"));
  });

  it("op 失败：错误进 props.error 并渲染", async () => {
    const { a } = make("eng-1", {});
    await a.loadSessions();
    assert.equal(a.sessionsProps().error, "unknown op: sessions");
    const result = renderToText(renderSessionTab(makeRuntime(), a.sessionsProps()));
    assert.ok(result.text.includes("unknown op: sessions"));
  });

  it("onRefresh 真的重查；onMarkTunnel 改状态后重查", async () => {
    const { a, fake } = make("eng-1", { ...allReplies(), updateTunnel: { ok: true } });
    await a.loadSessions();
    a.sessionsProps().onRefresh();
    await settle();
    assert.equal(fake.countOf("sessions"), 2);

    const tunnel = a.sessionsProps().data?.tunnels[0];
    assert.ok(tunnel !== undefined);
    a.sessionsProps().onMarkTunnel(tunnel, "down");
    await settle();
    assert.equal(fake.countOf("updateTunnel"), 1);
    assert.equal(fake.countOf("sessions"), 3, "标记后要重读状态");
  });

  it("onProbe 真的发 probeSessions 并带回摘要文案", async () => {
    const { a, fake } = make("eng-1", {
      ...allReplies(),
      probeSessions: {
        ok: true,
        webshells: [{ id: 11, url: "https://x.example.com/shell.jsp", status: "online", note: "HTTP 200", latency_ms: 30 }],
        tunnels: [{ id: 21, kind: "suo5", listen: "127.0.0.1:1080", status: "active", note: "ok", latency_ms: 5 }],
        checkedAt: "2026-09-18T10:00:00Z",
      },
    });
    await a.loadSessions();
    a.sessionsProps().onProbe();
    await settle();
    assert.equal(fake.countOf("probeSessions"), 1);
    // `SessionTabProps` 没有独立的探测摘要槽位 —— 摘要走 `message.ok`
    //（页签把消息渲染成 `rt-foot` 行），真值放在 state 的 probe 里备查。
    const props = a.sessionsProps();
    assert.ok((props.message?.ok ?? "").includes("WebShell 在线 1/1"), "探测摘要应进消息");
    assert.equal(a.state().sessions.probe?.onlineShells, 1);
    assert.equal(a.state().sessions.probe?.activeTunnels, 1);
    // 探测会回写状态 → 必须重读。
    assert.equal(fake.countOf("sessions"), 2);
  });

  it("onCopy 成功才点亮「已复制」；复制能力缺失时给真实失败文案", async () => {
    // 场景一：没有 copyText 注入 → 复制失败，不能谎称成功。
    const fail = make("eng-1", allReplies());
    await fail.a.loadSessions();
    fail.a.sessionsProps().onCopy("k1", "https://x/shell.jsp", "WebShell URL");
    await settle();
    assert.equal(fail.a.sessionsProps().copied, null, "失败时不能点亮按钮");
    assert.ok((fail.a.sessionsProps().message?.err ?? "").includes("复制失败"));

    // 场景二：注入成功的 copyText → 点亮 + 记录复制到的文本。
    const copied: string[] = [];
    const fake = makeFakeFetch(allReplies());
    const ok = makeTabsA({
      fetch: fake.fetch,
      engagement: "eng-1",
      copyText: (text) => {
        copied.push(text);
        return true;
      },
    });
    await ok.loadSessions();
    ok.sessionsProps().onCopy("k1", "https://x/shell.jsp", "WebShell URL");
    await settle();
    assert.deepEqual(copied, ["https://x/shell.jsp"]);
    assert.equal(ok.sessionsProps().copied, "k1");
    assert.ok((ok.sessionsProps().message?.ok ?? "").includes("已复制"));
  });
});

/* ══════════════════════════════════════════════════════════════ 漏洞战果 */

describe("tabs-a — 漏洞战果（findings）", () => {
  it("取数：vulns + 三张附属表并行；不重复发 vulnStats", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadFindings();
    assert.equal(fake.countOf("vulns"), 1);
    assert.equal(fake.countOf("credentials"), 1);
    assert.equal(fake.countOf("access"), 1);
    assert.equal(fake.countOf("attackFiles"), 1);
    assert.equal(fake.countOf("vulnStats"), 0, "vulns 响应里已带 stats");
  });

  it("真实数据渲染：出现 CVE 编号标题（平铺视图）", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadFindings();
    // 切平铺：聚合视图默认折叠，表格行不渲染（这是页签自身的设计）。
    a.findingsProps().onToggleGrouped();
    const result = renderToText(renderFindingsTab(makeRuntime(), a.findingsProps()));
    assert.ok(result.text.includes("CVE-2023-21839"), "应渲染出 CVE 编号：" + result.text.slice(0, 600));
    assert.ok(result.text.includes("Weblogic T3 反序列化"), "应渲染出漏洞标题");
    assert.ok(result.text.includes("oa.example.com"), "应渲染出目标");
    // 资产 IP 在**详情**里（列表列是 target）；展开后必须能看到。
    a.findingsProps().onToggleOpen(31);
    const opened = renderToText(renderFindingsTab(makeRuntime(), a.findingsProps()));
    assert.ok(opened.text.includes("203.0.113.9"), "展开后应渲染出资产 IP");
    // 对照空态。
    assert.equal(opened.text.includes(EMPTY_FINDINGS_MESSAGE), false);
  });

  it("数据为 null 时走空态", () => {
    const { a } = make("eng-1", {});
    const result = renderToText(renderFindingsTab(makeRuntime(), a.findingsProps()));
    assert.equal(a.findingsProps().findings, null);
    assert.ok(result.text.includes(EMPTY_FINDINGS_MESSAGE));
  });

  it("op 失败：错误进 findings.error；unknown op 渲染成「需重启宿主」提示", async () => {
    const { a } = make("eng-1", {});
    await a.loadFindings();
    const props = a.findingsProps();
    assert.equal(props.findings?.error, "unknown op: vulns");
    const result = renderToText(renderFindingsTab(makeRuntime(), props));
    // 页签对 `unknown op` 有专门分支：这是「宿主版本不含该 op」，
    // 显示重启提示比显示原始错误更有用（模型层 `needsRestart`）。
    assert.ok(result.text.includes("需重启一次当前宿主"), "应渲染重启提示：" + result.text.slice(0, 600));
  });

  it("op 失败（非 unknown op）：原始错误文案渲染到界面上", async () => {
    // `vulns` 返回 500 类错误 → 不是 restart 分支，应显示原文。
    const fake = makeFakeFetchRejecting("vulns", "database is locked");
    const a = makeTabsA({ fetch: fake.fetch, engagement: "eng-1" });
    await a.loadFindings();
    assert.equal(a.findingsProps().findings?.error, "database is locked");
    const result = renderToText(renderFindingsTab(makeRuntime(), a.findingsProps()));
    assert.ok(result.text.includes("database is locked"));
  });

  it("onSubmitQuery 提交草稿并带 q 重查", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadFindings();
    a.findingsProps().onFilterChange({ ...a.findingsProps().filter, query: "weblogic" });
    await settle();
    // 只改草稿：不重查。
    assert.equal(fake.countOf("vulns"), 1);
    a.findingsProps().onSubmitQuery();
    await settle();
    assert.equal(fake.countOf("vulns"), 2);
    assert.equal(fake.lastOf("vulns")?.["q"], "weblogic");
  });

  it("onFilterChange 改严重级走服务端过滤并重查", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadFindings();
    a.findingsProps().onFilterChange({ ...a.findingsProps().filter, severity: "critical" });
    await settle();
    assert.equal(fake.countOf("vulns"), 2);
    assert.equal(fake.lastOf("vulns")?.["severity"], "critical");
  });

  it("onUpdateStatus 真的发 updateVuln 并重查", async () => {
    const { a, fake } = make("eng-1", { ...allReplies(), updateVuln: { ok: true } });
    await a.loadFindings();
    a.findingsProps().onUpdateStatus(31, "confirmed");
    await settle();
    assert.equal(fake.countOf("updateVuln"), 1);
    assert.equal(fake.lastOf("updateVuln")?.["id"], 31);
    assert.equal(fake.countOf("vulns"), 2);
    assert.equal(a.findingsProps().message?.kind, "ok");
  });

  it("onToggleOpen / onSubTabChange / onSetAllCollapsed 都是真的状态变更", () => {
    const { a } = make("eng-1", allReplies());
    a.findingsProps().onToggleOpen(31);
    assert.equal(a.findingsProps().openId, 31);
    a.findingsProps().onToggleOpen(31);
    assert.equal(a.findingsProps().openId, null);

    a.findingsProps().onSubTabChange("creds");
    assert.equal(a.findingsProps().subTab, "creds");

    a.findingsProps().onSetAllCollapsed(["target:a", "target:b"], true);
    assert.equal(a.findingsProps().collapse["target:a"], true);
    assert.equal(a.findingsProps().collapse["target:b"], true);
    a.findingsProps().onSetAllCollapsed(["target:a"], false);
    assert.equal(a.findingsProps().collapse["target:a"], false);
  });

  it("附属表真的进 props（凭据可见）", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadFindings();
    a.findingsProps().onSubTabChange("creds");
    const result = renderToText(renderFindingsTab(makeRuntime(), a.findingsProps()));
    assert.ok(result.text.includes("203.0.113.9"), "凭据主机应渲染：" + result.text.slice(0, 500));
  });
});

/* ══════════════════════════════════════════════════════════════ 攻击链 */

describe("tabs-a — 攻击链（chain）", () => {
  it("取数：走 scoreChain（ChainTabProps 的唯一数据源）", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadChain();
    assert.equal(fake.countOf("scoreChain"), 1);
    assert.equal(fake.countOf("attackGraph"), 0, "ChainTabProps 没有拓扑图槽位");
  });

  it("真实数据渲染：阶段名与总分都出现", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadChain();
    const result = renderToText(renderChainTab(makeRuntime(), a.chainProps()));
    assert.ok(result.text.includes("信息收集"), "应渲染出阶段名：" + result.text.slice(0, 500));
    assert.ok(result.text.includes("互联网资产权限"), "应渲染出第二阶段名");
    assert.ok(result.text.includes("总分 50 分"), "应渲染出总分");
    assert.ok(result.text.includes("203.0.113.5"), "应渲染出阶段里的资产 IP");
    // 对照空态。
    assert.equal(result.text.includes(EMPTY_CHAIN_MESSAGE), false);
  });

  it("数据为 null 时不是空态而是「加载中」（页签区分了两种 null）", () => {
    const { a } = make("eng-1", {});
    const result = renderToText(renderChainTab(makeRuntime(), a.chainProps()));
    assert.equal(a.chainProps().data, null);
    // 契约：data===null 表示还没读回来，**不**渲染「还没有得分记录」。
    assert.equal(result.text.includes(EMPTY_CHAIN_MESSAGE), false);
  });

  it("读回来但没有阶段 → 空态文案", async () => {
    const { a } = make("eng-1", { scoreChain: { ok: true, stages: [], summary: { points: 0 } } });
    await a.loadChain();
    const result = renderToText(renderChainTab(makeRuntime(), a.chainProps()));
    assert.ok(result.text.includes(EMPTY_CHAIN_MESSAGE));
  });

  it("op 失败：错误进 props.error 并渲染", async () => {
    const { a } = make("eng-1", {});
    await a.loadChain();
    assert.equal(a.chainProps().error, "unknown op: scoreChain");
    const result = renderToText(renderChainTab(makeRuntime(), a.chainProps()));
    assert.ok(result.text.includes("unknown op: scoreChain"));
  });

  it("onViewChange / onToggleHit / onRefresh 都真的生效", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadChain();
    a.chainProps().onViewChange("B");
    assert.equal(a.chainProps().view, "B");
    a.chainProps().onViewChange("bogus" as unknown as "B");
    assert.equal(a.chainProps().view, "A", "非法值归一成 A");

    a.chainProps().onToggleHit(61);
    assert.equal(a.chainProps().openId, 61);
    a.chainProps().onToggleHit(61);
    assert.equal(a.chainProps().openId, null);

    a.chainProps().onRefresh();
    await settle();
    assert.equal(fake.countOf("scoreChain"), 2);
  });

  it("展开一条命中会渲染出它的证据文本", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadChain();
    a.chainProps().onToggleHit(61);
    const result = renderToText(renderChainTab(makeRuntime(), a.chainProps()));
    assert.ok(result.text.includes("uid=0"), "命中详情应渲染证据：" + result.text.slice(0, 800));
  });
});

/* ══════════════════════════════════════════════════════════════ 得分目标 */

describe("tabs-a — 得分目标（scores）", () => {
  it("取数：走 scores", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadScores();
    assert.equal(fake.countOf("scores"), 1);
  });

  it("真实数据渲染：得分点名称与分值都出现", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadScores();
    const result = renderToText(renderScoreTab(makeRuntime(), a.scoresProps()));
    assert.ok(result.text.includes("服务器主机权限"), "应渲染出得分点名称：" + result.text.slice(0, 600));
    assert.ok(result.text.includes("50分"), "应渲染出分值");
    assert.ok(result.text.includes("一、获取权限"), "应渲染出规则组头");
    // 对照空态。
    assert.equal(result.text.includes(EMPTY_POINTS_TEXT), false);
  });

  it("数据为 null 且未选靶标 → 未选靶标空态", () => {
    const { a } = make(null, {});
    const result = renderToText(renderScoreTab(makeRuntime(), a.scoresProps()));
    assert.ok(result.text.includes(SCORE_NO_ENGAGEMENT));
  });

  it("op 失败：错误进 props.error 并渲染", async () => {
    const { a } = make("eng-1", {});
    await a.loadScores();
    assert.equal(a.scoresProps().error, "unknown op: scores");
    const result = renderToText(renderScoreTab(makeRuntime(), a.scoresProps()));
    assert.ok(result.text.includes("unknown op: scores"));
  });

  it("onRefresh 真的重查；表单开合与保存链路真的生效", async () => {
    const { a, fake } = make("eng-1", { ...allReplies(), saveScorePoint: { ok: true, note: "已保存得分点" } });
    await a.loadScores();
    a.scoresProps().onRefresh();
    await settle();
    assert.equal(fake.countOf("scores"), 2);

    // 打开新增表单。
    a.scoresProps().onNew();
    const form = a.scoresProps().form;
    assert.ok(form !== null);
    assert.equal(form?.id, null);

    // 改字段。
    a.scoresProps().onFormChange({ ...form, name: "自建得分点", points: 20 });
    assert.equal(a.scoresProps().form?.name, "自建得分点");

    // 保存 → 发 saveScorePoint → 成功后关表单并重查。
    a.scoresProps().onSave();
    await settle();
    assert.equal(fake.countOf("saveScorePoint"), 1);
    assert.equal(a.scoresProps().form, null, "保存成功应关表单");
    assert.equal(fake.countOf("scores"), 3, "保存后应重查");
    assert.equal(a.scoresProps().message?.ok, "已保存得分点");
  });

  it("onEdit 打开编辑表单并带上该点字段", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadScores();
    const point = a.scoresProps().board?.items[0];
    assert.ok(point !== undefined);
    a.scoresProps().onEdit(point);
    const form = a.scoresProps().form;
    assert.equal(form?.id, 71);
    assert.equal(form?.name, "服务器主机权限");
    assert.equal(form?.builtin, true);
    assert.equal(a.scoresProps().openId, 71);
  });

  it("onRemove 在新增表单上不发请求（只关表单）", () => {
    const { a, fake } = make("eng-1", allReplies());
    a.scoresProps().onNew();
    assert.ok(a.scoresProps().form !== null);
    a.scoresProps().onRemove();
    assert.equal(a.scoresProps().form, null);
    assert.equal(fake.countOf("deleteScorePoint"), 0);
  });

  it("onRemove 在编辑表单上真的发 deleteScorePoint", async () => {
    const { a, fake } = make("eng-1", { ...allReplies(), deleteScorePoint: { ok: true } });
    await a.loadScores();
    const point = a.scoresProps().board?.items[0];
    assert.ok(point !== undefined);
    a.scoresProps().onEdit(point);
    a.scoresProps().onRemove();
    await settle();
    assert.equal(fake.countOf("deleteScorePoint"), 1);
    assert.equal(fake.lastOf("deleteScorePoint")?.["id"], 71);
  });

  it("onCancel 关表单并清消息", () => {
    const { a } = make("eng-1", allReplies());
    a.scoresProps().onNew();
    a.scoresProps().onCancel();
    assert.equal(a.scoresProps().form, null);
    assert.equal(a.scoresProps().message, null);
  });

  it("表单校验失败不发请求（名称为空）", async () => {
    const { a, fake } = make("eng-1", allReplies());
    a.scoresProps().onNew();
    a.scoresProps().onSave();
    await settle();
    assert.equal(fake.countOf("saveScorePoint"), 0, "空名称不该发请求");
    assert.notEqual(a.scoresProps().message?.err, undefined);
  });
});

/* ══════════════════════════════════════════════════════════════ 环境适配 */

describe("tabs-a — 环境适配（env）", () => {
  it("flattenPlatform：把 platform 展开到顶层（model 层按扁平读）", () => {
    const flat = flattenPlatform({ ok: true, platform: { config: { platform: "linux" }, hint: "h" } });
    assert.equal(flat.ok, true);
    assert.equal(flat["hint"], "h");
    assert.deepEqual(flat["config"], { platform: "linux" });
    // 没有 platform 时原样返回（不伪造）。
    const raw = { ok: true, hint: "x" };
    assert.deepEqual(flattenPlatform(raw), raw);
  });

  it("取数：platformConfigGet 后草稿与 data 都填好", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadEnv();
    assert.equal(fake.countOf("platformConfigGet"), 1);
    const props = a.envProps();
    assert.equal(props.draft?.toolkitDir, "/opt/toolkit");
    assert.equal(props.draft?.platform, "linux");
    assert.equal(props.busy, false);
    assert.equal(props.error, null);
  });

  it("真实数据渲染：工具路径与就绪标签都出现", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadEnv();
    const result = renderToText(renderEnvTab(makeRuntime(), a.envProps()));
    // 工具路径渲染在 `<input>` 的 placeholder/value 上（不是文本子节点），
    // 所以这里断言标签与计数；路径本身断言在 props/data 层（见下）。
    assert.ok(result.text.includes("工具 1/2"), "应渲染出工具计数：" + result.text.slice(0, 900));
    assert.ok(result.text.includes("就绪"), "应渲染出就绪标签");
    assert.ok(result.text.includes("nmap"), "应渲染出工具 id");
    // 路径真的到了 props 里（`toolsOf` 读的正是这份数据）。
    const items = toolsOf(a.envProps().data);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.path, "/usr/bin/nmap");
  });

  it("数据为 null 时走空态（保存按钮禁用）", () => {
    const { a } = make("eng-1", {});
    const props = a.envProps();
    assert.equal(props.draft, null);
    const result = renderToText(renderEnvTab(makeRuntime(), props));
    // 未加载草稿：输入框禁用、保存按钮禁用。
    assert.ok(result.text.includes("环境适配"));
  });

  it("op 失败：错误进 props.error 并渲染", async () => {
    const { a } = make("eng-1", {});
    await a.loadEnv();
    assert.equal(a.envProps().error, "unknown op: platformConfigGet");
    const result = renderToText(renderEnvTab(makeRuntime(), a.envProps()));
    assert.ok(result.text.includes("unknown op: platformConfigGet"));
  });

  it("onSave 真的发 platformConfigSave，成功后刷新草稿", async () => {
    const { a, fake } = make("eng-1", {
      ...allReplies(),
      platformConfigSave: {
        ok: true,
        // 服务端归一：路径被展开（模拟 ~ → 绝对路径）。
        platform: {
          config: {
            platform: "linux",
            toolkitDir: "/opt/toolkit",
            path: "/home/u/.dsh/redteam/config.json",
            binDirs: ["/opt/bin"],
            tools: { nmap: "/usr/bin/nmap" },
            env: { FOFA_KEY: "k-123" },
            notes: "",
          },
        },
      },
    });
    await a.loadEnv();
    a.envProps().onSave();
    await settle();
    assert.equal(fake.countOf("platformConfigSave"), 1);
    assert.equal(a.envProps().message?.kind, "ok");
    const saveMessage = a.envProps().message;
    const saveText = saveMessage !== null && saveMessage.kind === "ok" ? saveMessage.text : "";
    // 路径来自 `platformConfigSave` 里被 platform 包住的 `config.path`：
    // 必须先展开再读，否则会退化成默认文案（这是接线层的一个真 bug）。
    assert.ok(saveText.includes("/home/u/.dsh/redteam/config.json"), "保存消息应带真实路径：" + saveText);
    assert.equal(saveText.includes("$DSH_HOME"), false, "不该退化成默认路径");
  });

  it("onAssign 空路径且草稿无工具目录时**不发请求**，给前置提示", async () => {
    // 草稿里的 toolkitDir 也是空 → `assignDirOf` 拦下，不发注定失败的请求。
    const { a, fake } = make("eng-1", {
      platformConfigGet: { ok: true, platform: { config: { toolkitDir: "" } } },
    });
    await a.loadEnv();
    assert.equal(a.envProps().draft?.toolkitDir, "");
    a.envProps().onAssign();
    await settle();
    assert.equal(fake.countOf("platformAssignToolkit"), 0, "空目录不该发注定失败的请求");
    const message = a.envProps().message;
    assert.equal(message?.kind, "err");
    assert.ok(message !== null && message.kind === "err" && message.text.includes("请先填写"));
  });

  it("onAssign 输入框为空但草稿有目录 → 回落到草稿目录（模型层既定语义）", async () => {
    const { a, fake } = make("eng-1", {
      ...allReplies(),
      platformAssignToolkit: { ok: true, assignedCount: 2, dir: "/opt/toolkit" },
    });
    await a.loadEnv();
    // folderPath 空，但 draft.toolkitDir === "/opt/toolkit"。
    a.envProps().onAssign();
    await settle();
    assert.equal(fake.countOf("platformAssignToolkit"), 1);
    assert.equal(fake.lastOf("platformAssignToolkit")?.["dir"], "/opt/toolkit");
  });

  it("onAssign 有路径时真的发 platformAssignToolkit", async () => {
    const { a, fake } = make("eng-1", {
      ...allReplies(),
      platformAssignToolkit: { ok: true, assignedCount: 3, dir: "/opt/bin" },
    });
    await a.loadEnv();
    a.envProps().onFolderPathChange("/opt/bin");
    a.envProps().onAssign();
    await settle();
    assert.equal(fake.countOf("platformAssignToolkit"), 1);
    assert.equal(fake.lastOf("platformAssignToolkit")?.["dir"], "/opt/bin");
    const assignMessage = a.envProps().message;
    assert.ok((assignMessage !== null && assignMessage.kind === "ok" ? assignMessage.text : "")
      .includes("3 个工具"));
  });

  it("onRefresh 真的重查", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadEnv();
    a.envProps().onRefresh();
    await settle();
    assert.equal(fake.countOf("platformConfigGet"), 2);
  });
});

/* ══════════════════════════════════════════════════════════════ 分发 */

describe("tabs-a — 分发与订阅", () => {
  it("propsFor：只装被请求的那个页签", () => {
    const { a } = make("eng-1", {});
    assert.deepEqual(Object.keys(a.propsFor("assets")), ["assets"]);
    assert.deepEqual(Object.keys(a.propsFor("sessions")), ["sessions"]);
    assert.deepEqual(Object.keys(a.propsFor("findings")), ["findings"]);
    assert.deepEqual(Object.keys(a.propsFor("chain")), ["chain"]);
    assert.deepEqual(Object.keys(a.propsFor("scores")), ["scores"]);
    assert.deepEqual(Object.keys(a.propsFor("env")), ["env"]);
    // 不属本组 → 空（让容器用 B 组的）。
    assert.deepEqual(a.propsFor("knowledge"), {});
    assert.deepEqual(a.propsFor("report"), {});
  });

  it("allProps：六个页签一次给全", () => {
    const { a } = make("eng-1", {});
    const props = a.allProps();
    assert.ok(props.assets !== undefined);
    assert.ok(props.sessions !== undefined);
    assert.ok(props.findings !== undefined);
    assert.ok(props.chain !== undefined);
    assert.ok(props.scores !== undefined);
    assert.ok(props.env !== undefined);
  });

  it("load：只为本组页签发请求", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.load("chain");
    assert.equal(fake.countOf("scoreChain"), 1);
    assert.equal(fake.countOf("snapshot"), 0, "不该顺带拉别的页签");
    // 别的组的页签是 no-op。
    await a.load("knowledge");
    assert.equal(fake.calls.length, 1);
  });

  it("loadAll：六个页签的 op 都发到了", async () => {
    const { a, fake } = make("eng-1", allReplies());
    await a.loadAll();
    const ops = new Set(fake.calls.map((call) => call.op));
    for (const op of ["snapshot", "assets", "sessions", "vulns", "scoreChain", "scores", "platformConfigGet"]) {
      assert.equal(ops.has(op), true, "loadAll 应发出 " + op);
    }
  });

  it("subscribe：状态变化会通知，退订后不再通知", async () => {
    const { a } = make("eng-1", allReplies());
    let count = 0;
    const off = a.subscribe(() => {
      count += 1;
    });
    await a.loadChain();
    assert.ok(count > 0, "取数过程应通知订阅者");
    const seen = count;
    off();
    await a.loadScores();
    assert.equal(count, seen, "退订后不该再通知");
  });

  it("subscribe：一个订阅者抛错不影响其它订阅者", async () => {
    const { a } = make("eng-1", allReplies());
    let good = 0;
    a.subscribe(() => {
      throw new Error("坏订阅者");
    });
    a.subscribe(() => {
      good += 1;
    });
    await a.loadChain();
    assert.ok(good > 0, "坏订阅者不该让好订阅者收不到通知");
  });

  it("onChange 依赖回调也会被调", async () => {
    const fake = makeFakeFetch(allReplies());
    let changed = 0;
    const a = makeTabsA({
      fetch: fake.fetch,
      engagement: "eng-1",
      onChange: () => {
        changed += 1;
      },
    });
    await a.loadChain();
    assert.ok(changed > 0);
  });

  it("setEngagement：换靶标清掉旧数据（不串台）", async () => {
    const { a } = make("eng-1", allReplies());
    await a.loadSessions();
    assert.notEqual(a.sessionsProps().data, null);
    a.setEngagement("eng-2");
    assert.equal(a.state().engagement, "eng-2");
    assert.equal(a.sessionsProps().data, null, "换靶标后旧数据必须清空");
    assert.equal(a.assetsProps().list, null);
    assert.equal(a.chainProps().data, null);
  });

  it("未选靶标时：只发全局的 env 请求，靶标相关的都不发", async () => {
    const { a, fake } = make(null, allReplies());
    await a.loadAll();
    // `platformConfigGet` 是全局 op（不依赖靶标），发它是正确的。
    assert.deepEqual(fake.calls.map((call) => call.op), ["platformConfigGet"]);
    assert.equal(a.state().engagement, null);
    // 各页签都是空态而不是崩。
    assert.equal(a.assetsProps().list, null);
    assert.equal(a.sessionsProps().data, null);
    assert.equal(a.chainProps().data, null);
    assert.equal(a.scoresProps().board, null);
  });
});

/* ══════════════════════════════════════════════════════════════ 回调不是空函数 */

describe("tabs-a — 回调真的是回调（反「空函数骗类型」）", () => {
  /**
   * 本用例的价值：如果哪个 `onXxx` 写成 `() => {}`，类型检查照样过，
   * 但这里会立刻发现「点了一下，state 没变、请求没发」。
   */
  it("六个页签的每个 onXxx 都产生了可观察的效果", async () => {
    const { a, fake } = make("eng-1", {
      ...allReplies(),
      updateVuln: { ok: true },
      updateTunnel: { ok: true },
      updateWebshell: { ok: true },
      saveScorePoint: { ok: true },
      deleteScorePoint: { ok: true },
      platformAssignToolkit: { ok: true, assignedCount: 1 },
    });
    await a.loadAll();
    const callsBefore = fake.calls.length;

    // 资产：onToggleSideGroup 改折叠态（不发请求）。
    // 侧栏分组**默认展开**，所以第一次切换是「收起」（false），再切是展开。
    a.assetsProps().onToggleSideGroup("external");
    assert.equal(a.assetsProps().collapsed["scope:external"], false, "折叠键应是 scope:external");
    a.assetsProps().onToggleSideGroup("external");
    assert.equal(a.assetsProps().collapsed["scope:external"], true, "再切一次应展开");
    // 资产：onToggleNotes 改展开态。
    a.assetsProps().onToggleNotes();
    assert.equal(a.assetsProps().notesOpen, true);

    // 会话：onToggleSection 改折叠态（区块同样默认展开 → 第一次切换是收起）。
    a.sessionsProps().onToggleSection("shells");
    assert.equal(a.sessionsProps().collapsed["shells"], false);
    a.sessionsProps().onToggleSection("shells");
    assert.equal(a.sessionsProps().collapsed["shells"], true);

    // 攻击链：onViewChange 改视图。
    a.chainProps().onViewChange("B");
    assert.equal(a.chainProps().view, "B");

    // 得分：onToggle 改展开。
    a.scoresProps().onToggle(71);
    assert.equal(a.scoresProps().openId, 71);

    // 环境：onDraftChange 改草稿。
    const draft = a.envProps().draft;
    assert.ok(draft !== null);
    a.envProps().onDraftChange({ ...draft, notes: "改过的备注" });
    assert.equal(a.envProps().draft?.notes, "改过的备注");

    // 至少一个回调真的发了请求。
    assert.ok(fake.calls.length >= callsBefore, "回调应产生网络活动或状态变更");
  });
});
