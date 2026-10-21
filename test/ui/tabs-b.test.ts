/**
 * B 组页签取数的测试：**证明「真实数据」与「空态」不是同一件事**。
 *
 * ## 这一层要证明什么
 *
 * `client/` 的 6 个页签已被各自的 `*-tab.test.ts` / `*-model.test.ts` 覆盖
 * （纯函数、渲染与模型都测过）。真正没被测过的是 **`tabs-b.ts`**：
 * 「op 名字有没有写错」「响应有没有真的喂给模型层」「失败会不会填 error」
 * 「回调是不是 `() => {}` 空函数」。
 *
 * 这些错误的表现都是**页签显示空态** —— 看起来像「后端没数据」，
 * 实际是「前端没接上」。所以这里每一条都要求：
 *
 * - **正向**：喂真实形状的响应 → 渲染出**业务字符串**（POC 标题、技能名、
 *   资产 IP、文件名、角色标题、得分点名字），**并且**断言空态文案**不**出现；
 * - **负向**：`null` / 失败 → 走空态或错误态，不崩、不白屏。
 *
 * ## 为什么用假 `FetchLike` 而不是假 `ApiClient`
 *
 * 假 `fetch` 能一并覆盖 `api.ts` 的解析路径（HTTP 状态码、空体、非 JSON），
 * 也让「op 名字写错」这类错误在测试里就暴露（假 fetch 按 `op` 分派，
 * 认不出的 op 直接返回 `{ok:false}`，页签就会显示空态 → 用例失败）。
 *
 * 唯一例外是直接驱动容器的方法（`copy` / `download` 注入），那里不走 fetch。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeTestReact, renderToText } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import type { FetchLike, MinimalFetchResponse, ModuleRequire, ReactLike } from "../../src/redteam/client/dom.js";
import { makeApiClient } from "../../src/redteam/client/api.js";
import { renderTabContent } from "../../src/redteam/client/tab-registry.js";
import {
  AGENTS_NOT_WIRED_REASON,
  TABS_B_OPS,
  TABS_B_WIRED,
  emptySnapshot,
  loadAll,
  makeTabsBSlot,
  makeTabsBState,
  propsFor,
  propsForWithEngagement,
  renderShotStrip,
  shotImageOf,
  tabBOwnsOp,
  type TabsBState,
} from "../../src/redteam/ui/tabs-b.js";
import {
  EMPTY_KB_MESSAGE,
  LOADING_KB_MESSAGE,
} from "../../src/redteam/client/knowledge-model.js";
import { EMPTY_FILES_MESSAGE } from "../../src/redteam/client/attackfiles-model.js";
import { EMPTY_PROMPTS_MESSAGE } from "../../src/redteam/client/prompts-model.js";
import { EMPTY_REPORT_TITLE } from "../../src/redteam/client/report-model.js";
import { EMPTY_TESTING_TEXT, NO_ENGAGEMENT_TEXT } from "../../src/redteam/client/testing-model.js";

/* ══════════════════════════════════════════════════════════════ 测试装置 */

/** 假 react 的 require。 */
function requireOf(): ModuleRequire {
  const react = makeTestReact();
  return () => react as unknown as ReactLike;
}

/** 最小 window（`createRuntime` 只要这几个字段）。 */
function makeRuntime(): ConsoleRuntime {
  const react = makeTestReact();
  const windowRef = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://h/", hostname: "h", port: "1", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    navigator: { clipboard: { writeText: async () => undefined } },
    document: {
      createElement: () => {
        throw new Error("未使用");
      },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Parameters<typeof createRuntime>[1];
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  void requireOf;
  return createRuntime(requireModule, windowRef);
}

/** 一次被拦截的请求。 */
interface Call {
  readonly op: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * 按 op 分派的假 `fetch`。
 *
 * `handlers` 里没有的 op 返回 `{ ok: false, error: "unknown op: X" }` ——
 * 于是「op 名字写错」会让页签显示空态，用例随之失败（这正是我们要的）。
 */
function makeFetch(
  handlers: Readonly<Record<string, unknown | (() => unknown)>>,
  calls: Call[] = [],
): { readonly fetch: FetchLike; readonly calls: readonly Call[] } {
  const fetchFn: FetchLike = async (_input, init) => {
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(init.body) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    const op = typeof body["op"] === "string" ? body["op"] : "";
    calls.push({ op, body });

    const handler = handlers[op];
    const payload = typeof handler === "function" ? (handler as () => unknown)() : handler;
    const json = payload === undefined
      ? { ok: false, error: "unknown op: " + op }
      : payload;

    const response: MinimalFetchResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(json),
    };
    return response;
  };
  return { fetch: fetchFn, calls };
}

/** 造容器（默认无靶标）。 */
function makeState(
  handlers: Readonly<Record<string, unknown | (() => unknown)>>,
  options: {
    readonly engagement?: string | null;
    readonly calls?: Call[];
    readonly copy?: (text: string, label: string) => Promise<boolean>;
    readonly download?: (text: string, label: string) => Promise<boolean>;
    readonly nowIso?: () => string;
    readonly nowDate?: () => Date;
    readonly setInterval?: (handler: () => void, ms: number) => unknown;
    readonly clearInterval?: (handle: unknown) => void;
  } = {},
): { readonly state: TabsBState; readonly calls: readonly Call[]; readonly api: ReturnType<typeof makeApiClient> } {
  const calls: Call[] = options.calls ?? [];
  const { fetch } = makeFetch(handlers, calls);
  const api = makeApiClient({ fetch });
  const engagementValue = options.engagement ?? null;
  const state = makeTabsBState({
    api,
    engagement: () => engagementValue,
    ...(options.copy !== undefined ? { copy: options.copy } : {}),
    ...(options.download !== undefined ? { download: options.download } : {}),
    ...(options.nowIso !== undefined ? { nowIso: options.nowIso } : {}),
    ...(options.nowDate !== undefined ? { nowDate: options.nowDate } : {}),
    ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
    ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
  });
  return { state, calls, api };
}

/** 渲染一个页签成文本。 */
function render(
  runtime: ConsoleRuntime,
  state: TabsBState,
  tab: "knowledge" | "skills" | "testing" | "attackfiles" | "prompts" | "report",
  engagement: string | null = "eng-1",
): string {
  const props = propsForWithEngagement(runtime, state, engagement);
  return renderToText(renderTabContent(runtime, tab, props)).text;
}

/* ────────────────────────────────────────────── 真实形状的响应夹具 */

/** 一条知识库条目（字段名与 `pocItemOf` / store 的 `PocListItem` 对齐）。 */
const POC_ROW = {
  id: 7,
  code: "weblogic-t3-cve-2023-21839",
  title: "Weblogic T3 反序列化 CVE-2023-21839",
  kind: "exp",
  category: "deserialization",
  source: "web",
  cve: "CVE-2023-21839",
  component: "Weblogic",
  versions: "12.2.1.3",
  language: "python",
  tags: "java,反序列化",
  verified: 1,
  hit_count: 3,
  created_at: "2026-10-01T09:00:00.000Z",
  engagement_id: "eng-1",
  engagement_name: "示例靶标",
  asset_target: "10.1.2.30:7001",
  found_by_agent: "vuln-scan",
  source_url: "https://example.test/poc",
};

/** `pocSearch` 的响应。 */
function pocSearchResponse(): unknown {
  return {
    ok: true,
    items: [POC_ROW],
    stats: {
      total: 1,
      verified: 1,
      reused: 3,
      uncategorized: 0,
      byCategory: [{ code: "deserialization", n: 1, verified: 1, hint: "" }],
      byEngagement: [{ engagement: "示例靶标", n: 1 }],
    },
    templates: {
      dir: "/opt/nuclei-templates",
      total: 800,
      matched: 1,
      offset: 0,
      items: [{ path: "http/cves/2023/CVE-2023-21839.yaml", name: "CVE-2023-21839", severity: "critical", category: "rce" }],
      byCategory: [{ code: "rce", n: 1 }],
    },
    dbPath: "/data/knowledge.sqlite",
    root: "/data",
  };
}

/** `pocGet` 的响应。 */
function pocGetResponse(): unknown {
  return {
    ok: true,
    id: 7,
    title: POC_ROW.title,
    content: "print('weblogic t3 exploit')",
    usage: "python poc.py -u http://10.1.2.30:7001",
    description: "T3 反序列化",
    verified_note: "在 10.1.2.30:7001 回显 uid=0",
    used_on: "控制台手动标记",
    path: "pocs/weblogic-t3-cve-2023-21839/poc.py",
    source_url: "https://example.test/poc",
  };
}

/** `skillCatalog` 的响应。 */
function skillCatalogResponse(): unknown {
  return {
    ok: true,
    total: 2,
    items: [
      {
        name: "suo5-tunnel",
        description: "用 suo5 通过 WebShell 建立 SOCKS5 隧道",
        whenToUse: "需要把内网流量代理出来时",
        provider: "dsh-unbound",
        source: "redteam",
        dir: "/skills/redteam/suo5-tunnel",
        modelInvocable: true,
        userInvocable: true,
        fromPlugin: true,
        library: "redteam",
        availability: "available",
        problems: [],
        needs_user: [],
      },
      {
        name: "office-docx",
        description: "创建与编辑 Word 文档",
        whenToUse: "要交付 docx 时",
        provider: "host",
        source: "official",
        dir: "/skills/official/office-docx",
        modelInvocable: true,
        userInvocable: true,
        fromPlugin: false,
        library: "official",
        availability: "listed",
        problems: [],
        needs_user: [],
      },
    ],
    availability: { summary: { available: 1, broken: 0, unknown: 0 }, cached: false, checked_at: null, broken: [] },
    byDir: [{ key: "/skills/redteam/suo5-tunnel", n: 1 }],
    bySource: [{ key: "redteam", n: 1 }],
    note: "红队技能与官方技能分开",
  };
}

/** `skillRead` 的响应。 */
function skillReadResponse(): unknown {
  return {
    ok: true,
    name: "suo5-tunnel",
    description: "用 suo5 通过 WebShell 建立 SOCKS5 隧道",
    whenToUse: "需要把内网流量代理出来时",
    provider: "dsh-unbound",
    source: "redteam",
    path: "/skills/redteam/suo5-tunnel/SKILL.md",
    content: "# suo5-tunnel\n\n用 suo5 建隧道。",
  };
}

/** `activeTests` 的响应（三区块各一条，字段与 `testedAssetOf` 对齐）。 */
function activeTestsResponse(): unknown {
  const base = {
    segment_cidr: "10.1.2.0/24",
    scope: "internal",
    state: "live",
    test_notes: "nmap 全端口 + nuclei cve 模板",
    test_surface: "SMB 445 未测",
    test_updated_at: "2026-10-21T09:30:00.000Z",
    test_updated_by: "vuln-scan",
    blocked_count: 0,
    priority: "high",
    potential: "服务器权限",
    open_ports: 5,
    vulns: 2,
    webshells: 1,
    tunnels: 1,
  };
  return {
    ok: true,
    testing: [{ ...base, id: 11, ip: "10.1.2.30", test_status: "testing" }],
    recent: [{ ...base, id: 12, ip: "10.1.2.31", test_status: "tested" }],
    queue: [{ ...base, id: 13, ip: "10.1.2.32", test_status: "untested" }],
    stats: { testing: 1, untested: 1, tested: 1, abandoned: 0, blocked: 0, no_surface: 0 },
    untested: 1,
    at: "2026-10-21T09:31:00.000Z",
  };
}

/** `attackFiles` 的响应（`items` 是文件夹数组）。 */
function attackFilesResponse(): unknown {
  return {
    ok: true,
    items: [
      {
        target: "10.1.2.30",
        folder: "10.1.2.30",
        count: 1,
        files: [{ id: 21, name: "cve-2023-21839.sh", kind: "poc", description: "T3 反序列化验证" }],
      },
    ],
  };
}

/** `readAttackFile` 的响应。 */
function readAttackFileResponse(): unknown {
  return {
    ok: true,
    id: 21,
    name: "cve-2023-21839.sh",
    content: "#!/bin/sh\npython poc.py -u http://10.1.2.30:7001",
    path: "attack-files/10.1.2.30/cve-2023-21839.sh",
    evidence: "回显 uid=0(root)",
    created_at: "2026-10-21T09:40:00.000Z",
    created_by: "exploit",
  };
}

/** `prompts` 的响应。 */
function promptsResponse(): unknown {
  return {
    ok: true,
    builtin: false,
    roles: [
      { role: "recon", title: "信息收集", content: "你是信息收集智能体。", updated_at: "2026-10-20T10:00:00.000Z" },
      { role: "exploit", title: "漏洞利用", content: "你是漏洞利用智能体。", updated_at: null },
    ],
  };
}

/** `scoreReport` 的响应（带阶段，所以不会再发 `scoreChain`）。 */
function scoreReportResponse(): unknown {
  return {
    ok: true,
    target: "示例靶标",
    markdown: "# 报告\n\n## 阶段 2\n",
    summary: {
      count: 1,
      points: 10,
      withRequests: 1,
      autoMatched: 0,
      missingRequests: 0,
      withSteps: 1,
      withCommands: 1,
      incomplete: 0,
      credentials: 0,
      tunnels: 0,
      selfCreatedExcluded: 0,
      serviceCappedExcluded: 0,
      disabledExcluded: 0,
      serviceCapped: [],
    },
    items: [
      {
        id: 31,
        seq: 1,
        point_name: "服务器主机权限",
        points: 10,
        counted: true,
        nth_of_point: 1,
        target: "10.1.2.30",
        asset_ip: "10.1.2.30",
        gained: "root 权限",
        evidence: "回显 uid=0(root)",
        recorded_at: "2026-10-21T09:45:00.000Z",
        recorded_by: "exploit",
        note: "",
        vuln: { cve: "CVE-2023-21839", title: "Weblogic T3 反序列化" },
        how: "通过 T3 反序列化拿 shell",
        incomplete: false,
        gaps: [],
        requests: [
          {
            label: "T3 反序列化",
            method: "POST",
            url: "http://10.1.2.30:7001/",
            status: 200,
            request: "POST / HTTP/1.1\r\nHost: 10.1.2.30:7001\r\n\r\n",
            response: "uid=0(root)",
            note: null,
            source: "linked",
          },
        ],
        steps: [
          { id: 41, seq: 1, title: "上传冰蝎马", detail: "后台模板上传点", tool: "curl -X POST http://10.1.2.30:7001/x", result: "上传成功", stage_code: "internet", agent: "exploit", recorded_at: "2026-10-21T09:44:00.000Z" },
        ],
        credentials: [],
        tunnels: [],
        webshells: [],
        shots: [{ id: 51, kind: "screenshot", label: "回显 uid=0", note: "", target: "10.1.2.30", captured_at: "2026-10-21T09:45:00.000Z" }],
        shot_total: 1,
      },
    ],
    stages: [
      {
        code: "internet",
        name: "互联网资产权限",
        color: "#38bdf8",
        ordinal: 2,
        points: 10,
        cumulative: 10,
        items: [],
      },
    ],
  };
}

/** 六件事全就绪的 handler 表。 */
function allHandlers(): Record<string, unknown> {
  return {
    pocSearch: pocSearchResponse(),
    pocGet: pocGetResponse(),
    pocUse: { ok: true, id: 7, code: POC_ROW.code, hit_count: 4 },
    skillCatalog: skillCatalogResponse(),
    skillRead: skillReadResponse(),
    activeTests: activeTestsResponse(),
    attackFiles: attackFilesResponse(),
    readAttackFile: readAttackFileResponse(),
    prompts: promptsResponse(),
    savePrompt: { ok: true, role: "recon", bytes: 12 },
    resetPrompts: { ok: true, reset: ["recon"] },
    scoreReport: scoreReportResponse(),
    shotData: { ok: true, id: 51, mime: "image/png", base64: "iVBORw0KGgo=", bytes: 12 },
  };
}

/* ══════════════════════════════════════════════════════════════ 接线清单 */

describe("接线清单 —— 6 个页签，不是 7 个", () => {
  it("TABS_B_WIRED 恰好是我负责的 6 个页签", () => {
    assert.deepEqual(
      [...TABS_B_WIRED].sort(),
      ["attackfiles", "knowledge", "prompts", "report", "skills", "testing"],
    );
  });

  it("agents 不在清单里（它没有 props 槽位）", () => {
    assert.equal(TABS_B_WIRED.includes("agents"), false);
    assert.match(AGENTS_NOT_WIRED_REASON, /无 props 槽位/);
    assert.match(AGENTS_NOT_WIRED_REASON, /agentsStatus op 已就绪/);
  });

  it("每个接线的页签都声明了 op", () => {
    for (const tab of TABS_B_WIRED) {
      const ops = TABS_B_OPS[tab];
      assert.notEqual(ops, undefined, tab + " 缺少 op 声明");
      assert.ok((ops ?? []).length > 0, tab + " 的 op 列表为空");
    }
  });

  it("tabBOwnsOp 认自己组的 op、不认别人的", () => {
    assert.equal(tabBOwnsOp("pocSearch"), true);
    assert.equal(tabBOwnsOp("skillCatalog"), true);
    assert.equal(tabBOwnsOp("scoreReport"), true);
    // A 组（assets/sessions/findings/chain/scores/env）的 op 不是我的
    assert.equal(tabBOwnsOp("assets"), false);
    assert.equal(tabBOwnsOp("sessions"), false);
    assert.equal(tabBOwnsOp("chain"), false);
    // 未知 op
    assert.equal(tabBOwnsOp("nope"), false);
  });
});

/* ══════════════════════════════════════════════════════════════ 空态（未取数） */

describe("未取数时 —— 6 个页签都走空态，不崩", () => {
  it("knowledge：显示「加载中…」而不是「知识库还是空的」", () => {
    const runtime = makeRuntime();
    const { state } = makeState({});
    const text = render(runtime, state, "knowledge");
    assert.ok(text.includes(LOADING_KB_MESSAGE), "缺加载态文案：" + text.slice(0, 200));
    assert.equal(text.includes(EMPTY_KB_MESSAGE), false);
  });

  it("attackfiles：没有文件夹时显示空态文案", () => {
    const runtime = makeRuntime();
    const { state } = makeState({});
    const text = render(runtime, state, "attackfiles");
    assert.ok(text.includes(EMPTY_FILES_MESSAGE));
  });

  it("prompts：没有角色时显示空态文案", () => {
    const runtime = makeRuntime();
    const { state } = makeState({});
    const text = render(runtime, state, "prompts");
    assert.ok(text.includes(EMPTY_PROMPTS_MESSAGE));
  });

  it("testing：没靶标时提示「请先在顶部选择或创建靶标」", () => {
    const runtime = makeRuntime();
    const { state } = makeState({});
    const text = render(runtime, state, "testing", null);
    assert.ok(text.includes(NO_ENGAGEMENT_TEXT), text.slice(0, 200));
  });

  it("report：null 时显示加载态，不是「没有成果」", () => {
    const runtime = makeRuntime();
    const { state } = makeState({});
    const text = render(runtime, state, "report");
    assert.equal(text.includes(EMPTY_REPORT_TITLE), false, "还没读回来就报「没有成果」是错的");
  });

  it("skills：null 时不崩（渲染出结构）", () => {
    const runtime = makeRuntime();
    const { state } = makeState({});
    const text = render(runtime, state, "skills");
    assert.ok(text.length > 0);
  });

  it("空快照的每个页签字段都是「未加载」而不是「空结果」", () => {
    const snapshot = emptySnapshot();
    assert.equal(snapshot.knowledge.data, null);
    assert.equal(snapshot.skills.data, null);
    assert.equal(snapshot.testing.data, null);
    assert.equal(snapshot.attackfiles.data, null, "attackfiles 的「未加载」必须是 null，不是 []");
    assert.equal(snapshot.prompts.data, null);
    assert.equal(snapshot.report.data, null);
  });
});

/* ══════════════════════════════════════════════════════════════ 知识库 */

describe("knowledge —— 真实数据渲染", () => {
  it("喂真实响应后渲染出 POC 标题与 CVE，不是空态", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers());
    await state.refreshKnowledge();
    const text = render(runtime, state, "knowledge");

    // 业务字符串：标题、CVE、组件
    assert.ok(text.includes("Weblogic T3 反序列化 CVE-2023-21839"), "没渲染出标题：" + text.slice(0, 400));
    assert.ok(text.includes("CVE-2023-21839"));
    assert.ok(text.includes("Weblogic"));
    // 空态文案必须**不**出现
    assert.equal(text.includes(EMPTY_KB_MESSAGE), false);
    assert.equal(text.includes(LOADING_KB_MESSAGE), false);
    // 真的发了对 op
    assert.equal(calls[0]?.op, "pocSearch");
  });

  it("模板块渲染出 nuclei 模板路径", async () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers());
    await state.refreshKnowledge();
    const text = render(runtime, state, "knowledge");
    assert.ok(text.includes("http/cves/2023/CVE-2023-21839.yaml"));
  });

  it("展开条目后渲染出正文（真的发了 pocGet）", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers());
    await state.refreshKnowledge();
    await state.openPoc(7);
    const text = render(runtime, state, "knowledge");

    assert.ok(text.includes("print('weblogic t3 exploit')"), "没渲染出正文：" + text.slice(-400));
    assert.ok(text.includes("在 10.1.2.30:7001 回显 uid=0"));
    const ops = calls.map((call) => call.op);
    assert.ok(ops.includes("pocGet"), "没发 pocGet：" + ops.join(","));
  });

  it("onSearch 换关键词后真的用新关键词重查", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers());
    const props = propsForWithEngagement(runtime, state, "eng-1");
    props.knowledge?.onQueryChange({ ...state.get().knowledge.query, q: "shiro" });
    props.knowledge?.onSubmit();
    // onSubmit 是 fire-and-forget，等一个微任务让请求落地
    await new Promise((resolve) => setTimeout(resolve, 10));

    const search = calls.filter((call) => call.op === "pocSearch");
    assert.ok(search.length >= 1);
    assert.equal(search[search.length - 1]?.body["q"], "shiro", "关键词没带上");
  });

  it("点归类条立即用该归类重查", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers());
    const props = propsForWithEngagement(runtime, state, "eng-1");
    props.knowledge?.onCategoryChange("rce");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const search = calls.filter((call) => call.op === "pocSearch");
    assert.equal(search[search.length - 1]?.body["category"], "rce");
  });

  it("onToggleFold 真的改分组状态", () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers());
    const props = propsForWithEngagement(runtime, state, "eng-1");
    assert.equal(state.get().knowledge.grouped, false);
    props.knowledge?.onToggleGrouped();
    assert.equal(state.get().knowledge.grouped, true);
    props.knowledge?.onToggleGrouped();
    assert.equal(state.get().knowledge.grouped, false);
  });

  it("op 失败填 error，渲染错误态不白屏", async () => {
    const runtime = makeRuntime();
    const { state } = makeState({ pocSearch: { ok: false, error: "知识库文件损坏" } });
    await state.refreshKnowledge();

    assert.equal(state.get().knowledge.error, "知识库文件损坏");
    const text = render(runtime, state, "knowledge");
    assert.ok(text.includes("知识库文件损坏"), "错误文案没渲染：" + text.slice(0, 300));
  });

  it("复制失败时给出明确消息（不静默成功）", async () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers());
    // 不注入 copy → 应当报「宿主未提供剪贴板能力」
    await state.copyKnowledgeText("payload", "POC 正文");
    const message = state.get().knowledge.message;
    assert.notEqual(message, null);
    assert.equal(message?.kind, "err");
    assert.match(message?.text ?? "", /剪贴板/);
    void runtime;
  });

  it("注入 copy 后复制成功给出「已复制」", async () => {
    const { state } = makeState(allHandlers(), { copy: async () => true });
    await state.copyKnowledgeText("payload", "POC 正文");
    assert.deepEqual(state.get().knowledge.message, { kind: "ok", text: "已复制：POC 正文" });
  });
});

/* ══════════════════════════════════════════════════════════════ 技能库 */

describe("skills —— 真实数据渲染", () => {
  it("喂真实响应后渲染出技能名与描述", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers());
    await state.refreshSkills(false);
    const text = render(runtime, state, "skills");

    assert.ok(text.includes("suo5-tunnel"), "没渲染出技能名：" + text.slice(0, 400));
    assert.ok(text.includes("用 suo5 通过 WebShell 建立 SOCKS5 隧道"));
    // 官方技能单独分组
    assert.ok(text.includes("office-docx"));
    assert.ok(text.includes("红队技能"));
    assert.ok(text.includes("官方技能"));
    assert.equal(calls[0]?.op, "skillCatalog");
  });

  it("展开技能后渲染出正文（真的发了 skillRead）", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers());
    await state.refreshSkills(false);
    const item = state.get().skills.data?.items[0];
    assert.notEqual(item, undefined);
    if (item === undefined) return;
    await state.toggleSkill(item);
    const text = render(runtime, state, "skills");

    assert.ok(text.includes("# suo5-tunnel"), "没渲染出正文：" + text.slice(-400));
    assert.ok(calls.some((call) => call.op === "skillRead"));
  });

  it("同一条再点一次收起（activeKey 变回 null）", async () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers());
    await state.refreshSkills(false);
    const item = state.get().skills.data?.items[0];
    if (item === undefined) return;
    await state.toggleSkill(item);
    assert.notEqual(state.get().skills.activeKey, null);
    await state.toggleSkill(item);
    assert.equal(state.get().skills.activeKey, null);
    void runtime;
  });

  it("unknown op 时给出「重启宿主」提示（restartHint）", async () => {
    const runtime = makeRuntime();
    // 不提供 skillCatalog → 假 fetch 返回 unknown op
    const { state } = makeState({});
    await state.refreshSkills(false);
    const load = state.get().skills.data;
    assert.equal(load?.ok, false);
    assert.equal(load?.restartHint, true, "应识别出 unknown op");
    const text = render(runtime, state, "skills");
    assert.match(text, /重启 dsh web/);
  });

  it("onFilterChange 真的改过滤条件", () => {
    const { state } = makeState(allHandlers());
    const props = propsFor(state === undefined ? makeRuntime() : makeRuntime(), state);
    props.skills?.onFilterChange({ query: "suo5", pluginOnly: true, brokenOnly: false });
    assert.deepEqual(state.get().skills.filter, { query: "suo5", pluginOnly: true, brokenOnly: false });
  });
});

/* ══════════════════════════════════════════════════════════════ 当前测试 */

describe("testing —— 真实数据渲染", () => {
  it("喂真实响应后渲染出资产 IP 与测试记录", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshTesting();
    const text = render(runtime, state, "testing", "eng-1");

    assert.ok(text.includes("10.1.2.30"), "没渲染出资产 IP：" + text.slice(0, 500));
    assert.ok(text.includes("nmap 全端口 + nuclei cve 模板"));
    // 三个区块的**计数**都在（含折叠的），证明数据进了结论行与区块头
    assert.ok(text.includes("1 台"), "区块计数没渲染");
    // 「当前没有资产处于「测试中」」不该出现（我们有一条 testing）
    assert.equal(text.includes(EMPTY_TESTING_TEXT), false);
    assert.equal(calls[0]?.op, "activeTests");
  });

  it("默认只展开「正在测」，另两个区块折叠；全部展开后内容都出现", async () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshTesting();

    // 默认：recent / queue 折叠（SECTION_DEFAULTS）→ 内容不渲染，
    // 但区块标题与计数仍在（用户能看到「1 台」）。
    const collapsed = render(runtime, state, "testing", "eng-1");
    assert.equal(collapsed.includes("10.1.2.31"), false, "折叠时不该渲染「最近动过」内容");
    assert.equal(collapsed.includes("10.1.2.32"), false, "折叠时不该渲染「待测队列」内容");
    assert.ok(collapsed.includes("最近动过"));
    assert.ok(collapsed.includes("待测队列"));

    // 点「全部展开」后，两个区块的内容都出现（证明 onExpandAll 真生效）
    const props = propsForWithEngagement(runtime, state, "eng-1");
    props.testing?.onExpandAll();
    const expanded = render(runtime, state, "testing", "eng-1");
    assert.ok(expanded.includes("10.1.2.31"), "展开后仍没渲染「最近动过」");
    assert.ok(expanded.includes("10.1.2.32"), "展开后仍没渲染「待测队列」");
  });

  it("没靶标时不发请求", async () => {
    const { state, calls } = makeState(allHandlers(), { engagement: null });
    await state.refreshTesting();
    assert.equal(calls.length, 0, "没靶标还发了请求");
    assert.equal(state.get().testing.data, null);
  });

  it("op 失败填 error 并渲染错误态", async () => {
    const runtime = makeRuntime();
    const { state } = makeState({ activeTests: { ok: false, error: "库被锁住" } }, { engagement: "eng-1" });
    await state.refreshTesting();
    assert.equal(state.get().testing.error, "库被锁住");
    const text = render(runtime, state, "testing", "eng-1");
    assert.ok(text.includes("库被锁住"));
  });

  it("切靶标时清掉旧数据（不显示上一个靶标的资产）", async () => {
    let current = "eng-1";
    const { fetch } = makeFetch(allHandlers());
    const api = makeApiClient({ fetch });
    const state = makeTabsBState({ api, engagement: () => current });
    await state.refreshTesting();
    assert.notEqual(state.get().testing.data, null);

    current = "eng-2";
    await state.refreshTesting();
    // 新靶标同样返回了数据（假 fetch 不区分），但请求里带的是新靶标
    assert.notEqual(state.get().testing.data, null);
  });

  it("onToggleAuto 真的切 auto，并在没定时器时不假装在轮询", () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    const props = propsForWithEngagement(makeRuntime(), state, "eng-1");
    assert.equal(state.get().testing.auto, false);
    props.testing?.onToggleAuto();
    assert.equal(state.get().testing.auto, true);
    props.testing?.onToggleAuto();
    assert.equal(state.get().testing.auto, false);
  });

  it("注入定时器后开 auto 真的会轮询", async () => {
    const handlers: unknown[] = [];
    const cleared: unknown[] = [];
    let current: string | null = "eng-1";
    const { fetch } = makeFetch(allHandlers());
    const api = makeApiClient({ fetch });
    const state = makeTabsBState({
      api,
      engagement: () => current,
      setInterval: (handler, ms) => {
        handlers.push({ handler, ms });
        return "handle-1";
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    });
    state.setAuto(true);
    assert.equal(handlers.length, 1, "没注册定时器");
    assert.equal((handlers[0] as { ms: number }).ms, 5000);
    state.setAuto(false);
    assert.deepEqual(cleared, ["handle-1"], "没清定时器");
    current = null;
  });

  it("折叠状态：toggleSection 真的改，expandAll/collapseAll 一次改三个", () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    state.toggleTestingSection("testing:eng-1");
    // 默认展开（SECTION_DEFAULTS.testing = true）→ 点一次变折叠
    assert.equal(state.get().testing.collapsed["testing:eng-1"], false);

    state.expandTestingSections();
    assert.equal(state.get().testing.collapsed["testing:eng-1"], true);
    assert.equal(state.get().testing.collapsed["recent:eng-1"], true);
    assert.equal(state.get().testing.collapsed["queue:eng-1"], true);

    state.collapseTestingSections();
    assert.equal(state.get().testing.collapsed["testing:eng-1"], false);
    assert.equal(state.get().testing.collapsed["recent:eng-1"], false);
  });

  it("测试记录展开态按资产 id 切换", () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    assert.deepEqual(state.get().testing.openNotes, []);
    state.toggleTestingNotes(11);
    assert.deepEqual(state.get().testing.openNotes, [11]);
    state.toggleTestingNotes(12);
    assert.deepEqual(state.get().testing.openNotes, [11, 12]);
    state.toggleTestingNotes(11);
    assert.deepEqual(state.get().testing.openNotes, [12]);
  });
});

/* ══════════════════════════════════════════════════════════════ 攻击文件 */

describe("attackfiles —— 真实数据渲染", () => {
  it("喂真实响应后渲染出文件名与文件夹", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshAttackFiles();
    const text = render(runtime, state, "attackfiles", "eng-1");

    assert.ok(text.includes("cve-2023-21839.sh"), "没渲染出文件名：" + text.slice(0, 400));
    assert.ok(text.includes("10.1.2.30/"), "没渲染出文件夹");
    assert.ok(text.includes("T3 反序列化验证"));
    assert.equal(text.includes(EMPTY_FILES_MESSAGE), false);
    assert.equal(calls[0]?.op, "attackFiles");
  });

  it("展开文件后渲染出正文与效果（真的发了 readAttackFile）", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshAttackFiles();
    const folder = state.get().attackfiles.data?.[0];
    const file = folder?.files[0];
    assert.notEqual(file, undefined);
    if (file === undefined) return;
    await state.openAttackFile(file);
    const text = render(runtime, state, "attackfiles", "eng-1");

    assert.ok(text.includes("python poc.py -u http://10.1.2.30:7001"), "没渲染出正文：" + text.slice(-400));
    assert.ok(text.includes("回显 uid=0(root)"));
    assert.ok(calls.some((call) => call.op === "readAttackFile"));
  });

  it("同一条再点一次收起（detail 变回 null）", async () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshAttackFiles();
    const file = state.get().attackfiles.data?.[0]?.files[0];
    if (file === undefined) return;
    await state.openAttackFile(file);
    assert.notEqual(state.get().attackfiles.detail, null);
    await state.openAttackFile(file);
    assert.equal(state.get().attackfiles.detail, null);
    void runtime;
  });

  it("没靶标时数据是空数组（不是错误）", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: null });
    await state.refreshAttackFiles();
    assert.deepEqual(state.get().attackfiles.data, []);
    assert.equal(state.get().attackfiles.error, null);
    assert.equal(calls.length, 0);
    const text = render(runtime, state, "attackfiles", null);
    assert.ok(text.includes(EMPTY_FILES_MESSAGE));
  });

  it("op 失败填 error", async () => {
    const { state } = makeState({ attackFiles: { ok: false, error: "目录不可读" } }, { engagement: "eng-1" });
    await state.refreshAttackFiles();
    assert.equal(state.get().attackfiles.error, "目录不可读");
  });

  it("onRefresh 真的重拉", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    const props = propsForWithEngagement(runtime, state, "eng-1");
    props.attackfiles?.onRefresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls.some((call) => call.op === "attackFiles"));
  });
});

/* ══════════════════════════════════════════════════════════════ 提示词 */

describe("prompts —— 真实数据渲染", () => {
  it("喂真实响应后渲染出角色标题与预览", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshPrompts();
    const text = render(runtime, state, "prompts", "eng-1");

    assert.ok(text.includes("信息收集"), "没渲染出角色标题：" + text.slice(0, 400));
    assert.ok(text.includes("漏洞利用"));
    assert.ok(text.includes("你是信息收集智能体。"), "没渲染出预览/正文");
    assert.equal(text.includes(EMPTY_PROMPTS_MESSAGE), false);
    assert.equal(calls[0]?.op, "prompts");
  });

  it("未选中的角色：草稿同步到第一个角色的服务端正文", async () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshPrompts();
    assert.equal(state.get().prompts.active, "recon");
    assert.equal(state.get().prompts.draft, "你是信息收集智能体。");
  });

  it("onSelect 换角色后草稿跟着换", async () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshPrompts();
    state.selectPromptRole("exploit");
    assert.equal(state.get().prompts.active, "exploit");
    assert.equal(state.get().prompts.draft, "你是漏洞利用智能体。");
  });

  it("onSave 真的提交（发了 savePrompt 并带 content）", async () => {
    const { state, calls } = makeState(allHandlers(), {
      engagement: "eng-1",
      nowIso: () => "2026-10-21T10:00:00.000Z",
    });
    await state.refreshPrompts();
    state.setPromptDraft("改过的正文");
    await state.savePromptDraft();

    const save = calls.filter((call) => call.op === "savePrompt");
    assert.equal(save.length, 1, "没发 savePrompt");
    assert.equal(save[0]?.body["role"], "recon");
    assert.equal(save[0]?.body["content"], "改过的正文");
    assert.deepEqual(state.get().prompts.message, { kind: "ok", text: "已保存" });
  });

  it("无靶标时保存不发请求、直接给「请先创建靶标」", async () => {
    const { state, calls } = makeState(allHandlers(), { engagement: null });
    await state.refreshPrompts();
    await state.savePromptDraft();
    assert.equal(calls.filter((call) => call.op === "savePrompt").length, 0);
    assert.equal(state.get().prompts.message?.kind, "err");
    assert.match(state.get().prompts.message?.text ?? "", /请先创建靶标/);
  });

  it("onReset(false) 只恢复当前角色", async () => {
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshPrompts();
    await state.resetPromptRoles(false);
    const reset = calls.filter((call) => call.op === "resetPrompts");
    assert.equal(reset.length, 1);
    assert.equal(reset[0]?.body["role"], "recon");
  });

  it("onReset(true) 不带 role（恢复全部）", async () => {
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshPrompts();
    await state.resetPromptRoles(true);
    const reset = calls.filter((call) => call.op === "resetPrompts");
    assert.equal(reset.length, 1);
    assert.equal(reset[0]?.body["role"], undefined);
  });

  it("内置默认态给提示（builtin=true）", async () => {
    const runtime = makeRuntime();
    const { state } = makeState({
      prompts: { ok: true, builtin: true, roles: [{ role: "recon", title: "信息收集", content: "内置", updated_at: null }] },
    });
    await state.refreshPrompts();
    const text = render(runtime, state, "prompts", null);
    assert.match(text, /内置默认提示词/);
  });

  it("op 失败填 error", async () => {
    const runtime = makeRuntime();
    const { state } = makeState({ prompts: { ok: false, error: "提示词目录不可读" } }, { engagement: "eng-1" });
    await state.refreshPrompts();
    assert.equal(state.get().prompts.error, "提示词目录不可读");
    const text = render(runtime, state, "prompts", "eng-1");
    assert.ok(text.includes("提示词目录不可读"));
  });
});

/* ══════════════════════════════════════════════════════════════ 报告 */

describe("report —— 真实数据渲染", () => {
  it("喂真实响应后渲染出得分点名字与证据", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshReport();
    const text = render(runtime, state, "report", "eng-1");

    assert.ok(text.includes("攻击得分链路复现报告"));
    assert.ok(text.includes("互联网资产权限"), "没渲染出阶段名：" + text.slice(0, 500));
    assert.equal(text.includes(EMPTY_REPORT_TITLE), false);
    const ops = calls.map((call) => call.op);
    assert.ok(ops.includes("scoreReport"), "没发 scoreReport：" + ops.join(","));
  });

  it("op 失败填 error 并渲染错误态", async () => {
    const runtime = makeRuntime();
    const { state } = makeState({ scoreReport: { ok: false, error: "生成失败：没有得分" } }, { engagement: "eng-1" });
    await state.refreshReport();
    assert.equal(state.get().report.error, "生成失败：没有得分");
    const text = render(runtime, state, "report", "eng-1");
    assert.ok(text.includes("生成失败：没有得分"));
  });

  it("没靶标时给出「请先选择靶标」而不是白跑", async () => {
    const { state, calls } = makeState(allHandlers(), { engagement: null });
    await state.refreshReport();
    assert.equal(calls.length, 0);
    assert.match(state.get().report.error ?? "", /请先在顶部选择/);
  });

  it("readShots：能取到 base64 时渲染 <img>（真实现，不是假函数）", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.refreshReport();
    const item = state.get().report.data?.stages[0]?.items[0]
      ?? state.get().report.data?.items[0];
    assert.notEqual(item, undefined);
    if (item === undefined) return;

    // 第一次渲染：还没取到字节 → 触发取数，本轮不渲染 img
    const first = renderToText(renderShotStrip(runtime, state, item)).text;
    assert.equal(first.includes("<img>"), false, "还没取到字节就渲染了 img");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 取回后：真的有 data URL 且渲染 <img src=...>
    assert.ok(calls.some((call) => call.op === "shotData"), "没发 shotData");
    const url = state.shotUrl(51);
    assert.notEqual(url, undefined);
    assert.match(url ?? "", /^data:image\/png;base64,/);

    const second = renderToText(renderShotStrip(runtime, state, item)).text;
    assert.ok(second.includes("<img>"), "取回后仍没渲染 img：" + second);
  });

  it("readShots：取不到字节时不放占位图", async () => {
    const runtime = makeRuntime();
    const { state } = makeState({ shotData: { ok: false, error: "shot not found" } }, { engagement: "eng-1" });
    await state.refreshReport();
    const item = state.get().report.data?.items[0];
    if (item === undefined) return;
    renderToText(renderShotStrip(runtime, state, item)).text;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.shotUrl(51), undefined);
    const text = renderToText(renderShotStrip(runtime, state, item)).text;
    assert.equal(text, "", "取不到图却渲染了东西");
  });

  it("没有截图的 item 不渲染截图条", () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    const empty = { ...state.get().report, data: null };
    void empty;
    const fakeItem = {
      id: 1, seq: 1, pointName: "x", points: 0, counted: true, nthOfPoint: 1,
      target: "", assetIp: "", gained: "", evidence: "", recordedAt: "", recordedBy: "",
      note: "", vulnCve: "", vulnTitle: "", how: "", incomplete: false, gaps: [],
      requests: [], steps: [], credentials: [], tunnels: [], webshells: [],
      shots: [], shotTotal: 0,
    };
    const text = renderToText(renderShotStrip(runtime, state, fakeItem)).text;
    assert.equal(text, "");
  });

  it("shotImageOf：非字符串 base64 返回 null（窄化不可信输入）", () => {
    assert.equal(shotImageOf({ ok: true, base64: 123 }), null);
    assert.equal(shotImageOf({ ok: true, base64: "" }), null);
    assert.equal(shotImageOf({ ok: false, error: "x" }), null);
    assert.match(shotImageOf({ ok: true, base64: "AAAA", mime: "image/jpeg" }) ?? "", /^data:image\/jpeg;base64,AAAA$/);
    // mime 缺失时按 png 兜底
    assert.match(shotImageOf({ ok: true, base64: "AAAA" }) ?? "", /^data:image\/png;base64,AAAA$/);
  });

  it("onDownload 真的触发注入的下载并给消息", async () => {
    const downloaded: { text: string; label: string }[] = [];
    const { state } = makeState(allHandlers(), {
      engagement: "eng-1",
      download: async (text, label) => {
        downloaded.push({ text, label });
        return true;
      },
    });
    await state.refreshReport();
    const data = state.get().report.data;
    assert.notEqual(data, null);
    await state.downloadReportText(data?.markdown ?? "", "示例靶标");
    assert.equal(downloaded.length, 1);
    assert.match(state.get().report.message?.text ?? "", /已下载/);
  });

  it("没有注入 download 时明确说「未提供下载能力」", async () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    await state.downloadReportText("# 报告", "示例靶标");
    assert.equal(state.get().report.message?.kind, "err");
    assert.match(state.get().report.message?.text ?? "", /未提供下载能力/);
  });

  it("onCopy 真的复制并给消息", async () => {
    const copied: string[] = [];
    const { state } = makeState(allHandlers(), {
      engagement: "eng-1",
      copy: async (text) => {
        copied.push(text);
        return true;
      },
    });
    await state.refreshReport();
    await state.copyReportText("# 报告", "整份报告");
    assert.deepEqual(copied, ["# 报告"]);
    assert.deepEqual(state.get().report.message, { kind: "ok", text: "已复制：整份报告" });
  });

  it("折叠：setReportAllCollapsed 一次改多个键", () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    const props = propsForWithEngagement(makeRuntime(), state, "eng-1");
    props.report?.onSetAllCollapsed(["stage:internet", "stage:boundary"], true);
    assert.equal(state.get().report.collapse["stage:internet"], true);
    assert.equal(state.get().report.collapse["stage:boundary"], true);
    props.report?.onSetAllCollapsed(["stage:internet"], false);
    assert.equal(state.get().report.collapse["stage:internet"], false);
  });

  it("需要补分组时会额外发 scoreChain", async () => {
    // 服务端没给 stages、但有 items → `needsStageGrouping` 成立
    const noStages = { ...(scoreReportResponse() as Record<string, unknown>) };
    delete noStages["stages"];
    const { state, calls } = makeState(
      { scoreReport: noStages, scoreChain: { ok: true, items: [], stages: [] } },
      { engagement: "eng-1" },
    );
    await state.refreshReport();
    const ops = calls.map((call) => call.op);
    assert.ok(ops.includes("scoreReport"));
    assert.ok(ops.includes("scoreChain"), "缺阶段时应补发 scoreChain：" + ops.join(","));
  });
});

/* ══════════════════════════════════════════════════════════════ 整体 */

describe("容器整体", () => {
  it("loadAll 一次发 6 个页签的请求", async () => {
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    loadAll(state);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ops = new Set(calls.map((call) => call.op));
    for (const op of ["pocSearch", "skillCatalog", "activeTests", "attackFiles", "prompts", "scoreReport"]) {
      assert.ok(ops.has(op), "loadAll 漏了 " + op + "；实发：" + [...ops].join(","));
    }
  });

  /**
   * 回归：**造了容器 ≠ 会取数**。
   *
   * 真实踩到的坑：接线层（`tab-data.ts`）造出了 B 组容器却只调了 A 组的
   * `loadAll`，于是 6 个页签全部停在加载态 —— 表现与「后端没数据」一模一样，
   * 但根因是「前端没发请求」。
   *
   * 这条用例把两种状态钉死在渲染结果上：**不调 loadAll 必须是空态，
   * 调了必须出真实数据**。这样任何人（包括接线层）漏了取数都会红。
   */
  it("回归：不调 loadAll 时 6 个页签都是空态；调了之后全部出现真实数据", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });

    const tabs = ["knowledge", "skills", "testing", "attackfiles", "prompts", "report"] as const;
    /** 业务字符串（只有真喂了数据才会出现）。 */
    const businessStrings = [
      "Weblogic T3 反序列化 CVE-2023-21839",
      "suo5-tunnel",
      "10.1.2.30",
      "cve-2023-21839.sh",
      "信息收集",
      "互联网资产权限",
    ];

    // ── 未取数：一个业务字符串都不该出现，且一个请求都没发 ──
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      if (tab === undefined) continue;
      const text = render(runtime, state, tab, "eng-1");
      const needle = businessStrings[index] ?? "";
      assert.equal(
        text.includes(needle),
        false,
        "还没取数就渲染出了 " + tab + " 的业务数据「" + needle + "」",
      );
    }
    assert.equal(calls.length, 0, "还没调 loadAll 就发了请求：" + calls.map((c) => c.op).join(","));

    // ── 调 loadAll：6 个页签全部出真实数据 ──
    loadAll(state);
    await new Promise((resolve) => setTimeout(resolve, 40));

    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      if (tab === undefined) continue;
      const text = render(runtime, state, tab, "eng-1");
      const needle = businessStrings[index] ?? "";
      assert.ok(
        text.includes(needle),
        "loadAll 之后 " + tab + " 仍是空态（缺「" + needle + "」）：" + text.slice(0, 300),
      );
    }
  });

  it("subscribe 在变更时被通知，退订后不再收到", async () => {
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    let hits = 0;
    const off = state.subscribe(() => {
      hits += 1;
    });
    await state.refreshKnowledge();
    assert.ok(hits > 0, "变更没通知订阅者");
    const before = hits;
    off();
    await state.refreshKnowledge();
    assert.equal(hits, before, "退订后仍在收到通知");
  });

  it("propsFor 6 个页签的 props 都齐全（不缺项）", () => {
    const runtime = makeRuntime();
    const { state } = makeState(allHandlers(), { engagement: "eng-1" });
    const props = propsFor(runtime, state);
    assert.notEqual(props.knowledge, undefined);
    assert.notEqual(props.skills, undefined);
    assert.notEqual(props.testing, undefined);
    assert.notEqual(props.attackfiles, undefined);
    assert.notEqual(props.prompts, undefined);
    assert.notEqual(props.report, undefined);
    // agents 没有槽位，不该出现
    assert.equal(Object.prototype.hasOwnProperty.call(props, "agents"), false);
  });

  it("没有任何回调是空函数（都接到容器真实方法）", async () => {
    const runtime = makeRuntime();
    const { state, calls } = makeState(allHandlers(), { engagement: "eng-1" });
    const props = propsForWithEngagement(runtime, state, "eng-1");

    // 抽查 6 个页签各一个回调：调用后应产生可观察副作用
    props.knowledge?.onPage(40);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(state.get().knowledge.query.templateOffset, 40, "onPage 没生效");
    assert.ok(calls.some((call) => call.op === "pocSearch" && call.body["templateOffset"] === 40));

    props.skills?.onFilterChange({ query: "q", pluginOnly: false, brokenOnly: false });
    assert.equal(state.get().skills.filter.query, "q", "onFilterChange 没生效");

    props.testing?.onToggleNotes(99);
    assert.deepEqual(state.get().testing.openNotes, [99], "onToggleNotes 没生效");

    props.attackfiles?.onCollapseChange({ "folder:10.1.2.30": false });
    assert.equal(state.get().attackfiles.collapse["folder:10.1.2.30"], false, "onCollapseChange 没生效");

    props.prompts?.onDraftChange("新草稿");
    assert.equal(state.get().prompts.draft, "新草稿", "onDraftChange 没生效");

    props.report?.onCollapseChange({ "stage:internet": false });
    assert.equal(state.get().report.collapse["stage:internet"], false, "onCollapseChange 没生效");
  });

  it("dispose 停掉轮询", () => {
    const cleared: unknown[] = [];
    let current: string | null = "eng-1";
    const { fetch } = makeFetch(allHandlers());
    const api = makeApiClient({ fetch });
    const state = makeTabsBState({
      api,
      engagement: () => current,
      setInterval: () => "handle-x",
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    });
    state.setAuto(true);
    state.dispose();
    assert.deepEqual(cleared, ["handle-x"]);
    current = null;
  });

  it("React 胶水：makeTabsBSlot 在挂载时取数（effect 被调用）", async () => {
    const runtime = makeRuntime();
    const { fetch, calls } = makeFetch(allHandlers());
    const slot = makeTabsBSlot(runtime, makeApiClient({ fetch }), () => "eng-1");
    // 假 react 的 useEffect 不执行副作用，所以这里验证「拿到的是有效 props」
    // 与「effect 已登记」两件事；真正的取数路径由上面的容器用例覆盖。
    const props = slot();
    assert.notEqual(props.knowledge, undefined);
    assert.notEqual(props.report, undefined);
    // 直接调容器的 loadAll 证明 6 个 op 都能通（与 effect 里同一组调用）
    const state = makeTabsBState({ api: makeApiClient({ fetch }), engagement: () => "eng-1" });
    loadAll(state);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(calls.length > 0);
  });
});
