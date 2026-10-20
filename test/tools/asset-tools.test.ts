/**
 * 资产组（11 个工具）的测试。
 *
 * ## 本文件的核心：`asset_add` 的三层嵌套 schema
 *
 * Lead 的要求是"不只测能推导出类型（编译期），要测运行时行为与推导一致"。所以这里有四层：
 *
 * 1. **编译期**：`args.ports[0].fingerprints[0].category` 有真实类型（写错编译不过）
 * 2. **运行时收到正确形状**：传进去的嵌套结构，`execute` 真的原样收到
 * 3. **缺中间层不崩**：`{assets:[{ip}]}` 没有 `ports` → 行为符合 schema 声明
 * 4. **多余字段**：原实现透传，保持一致（断言透传而非丢弃）
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { ASSET_TOOL_NAMES, assetTools, compactAsset } from "../../src/redteam/tools/asset-tools.js";
import { bindings, resetToolState } from "../../src/redteam/tools/context.js";
import type { StoreForTools } from "../../src/redteam/tools/store-contract.js";

/* ── 替身 ──────────────────────────────────────────────────────────────── */

/** 记录所有对 store 的调用，便于断言"传了什么进去"。 */
interface Recorder {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
}

function mkStore(overrides: Partial<StoreForTools> = {}): StoreForTools & Recorder {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, ret: unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      return ret;
    };
  const base: Record<string, unknown> = {
    activeEngagementId: (): string | undefined => undefined,
    listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }],
    stats: rec("stats", { assets: 3 }),
    importBundle: rec("importBundle", { counts: { edges: 0, assets: 1 } }),
    listAssets: rec("listAssets", { total: 0, items: [] }),
    getAsset: rec("getAsset", undefined),
    listSegments: rec("listSegments", []),
    graph: rec("graph", { nodes: [], edges: [] }),
    updateAssetTest: rec("updateAssetTest", { updated: true }),
    assessAsset: rec("assessAsset", { assessed: true }),
    discoveryTimeline: rec("discoveryTimeline", { span: null, days: [], recent: [] }),
    listWeb: rec("listWeb", { total: 0, items: [] }),
    domainIndex: rec("domainIndex", []),
    openEngagement: rec("openEngagement", { id: "e1", name: "A" }),
    resetPrompts: rec("resetPrompts", { reset: [] }),
  };
  const merged = { ...base, ...overrides } as Record<string, unknown>;
  return Object.assign(merged, { calls }) as unknown as StoreForTools & Recorder;
}

function mkExec(sessionId = "s1"): ToolExecContext {
  return { agent: { session: { id: sessionId, header: {} } } } as unknown as ToolExecContext;
}

type AnyTool = ReturnType<typeof assetTools>[number];

function toolNamed(tools: ReturnType<typeof assetTools>, name: string): AnyTool {
  const found = tools.find((t) => t.name === name);
  assert.notEqual(found, undefined, `找不到 ${name}`);
  return found as AnyTool;
}

async function run(
  tools: ReturnType<typeof assetTools>,
  name: string,
  args: Record<string, unknown>,
  exec: ToolExecContext = mkExec(),
): Promise<Record<string, unknown>> {
  const out = await (toolNamed(tools, name).execute as (a: unknown, e: ToolExecContext) => Promise<string>)(args, exec);
  return JSON.parse(out) as Record<string, unknown>;
}

/** 取最后一次某方法的调用参数。 */
function lastCall(store: StoreForTools & Recorder, method: string): readonly unknown[] | undefined {
  const hits = store.calls.filter((c) => c.method === method);
  return hits.length === 0 ? undefined : hits[hits.length - 1]?.args;
}

beforeEach(() => {
  resetToolState();
  bindings.set("s1", "e1");
});

/* ── 工具集合 ─────────────────────────────────────────────────────────── */

describe("资产组工具集合", () => {
  const tools = assetTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("11 个工具，名字与顺序稳定", () => {
    assert.deepEqual(tools.map((t) => t.name), [...ASSET_TOOL_NAMES]);
    assert.equal(tools.length, 11);
  });

  it("每个工具 description 非空", () => {
    for (const t of tools) assert.equal(t.description.length > 10, true, t.name);
  });

  it("description 保留关键指令（原文照搬）", () => {
    assert.match(toolNamed(tools, "redteam_asset_add").description, /每条发现必须标注 provenance/);
    assert.match(toolNamed(tools, "redteam_asset_test").description, /\*\*每个资产开始测之前先调一次（status=testing）/);
    assert.match(toolNamed(tools, "redteam_asset_query").description, /内外网维度（scope）/);
    assert.match(toolNamed(tools, "redteam_web_list").description, /优先从接口入手/);
  });

  it("required 参数标注正确", () => {
    assert.equal(toolNamed(tools, "redteam_asset_add").parameters["ip"]?.required, true);
    assert.equal(toolNamed(tools, "redteam_asset_add").parameters["provenance"]?.required, true);
    assert.equal(toolNamed(tools, "redteam_asset_get").parameters["id"]?.required, true);
    assert.equal(toolNamed(tools, "redteam_asset_link").parameters["relation"]?.required, true);
  });

  it("枚举参数带字面量取值", () => {
    assert.deepEqual(toolNamed(tools, "redteam_asset_add").parameters["provenance"]?.enum, ["passive", "active"]);
    assert.deepEqual(toolNamed(tools, "redteam_asset_query").parameters["sort"]?.enum, [
      "priority",
      "todo",
      "ports",
      "ip",
    ]);
    assert.deepEqual(toolNamed(tools, "redteam_asset_test").parameters["status"]?.enum, [
      "untested",
      "testing",
      "tested",
      "blocked",
      "abandoned",
      "no_surface",
    ]);
  });
});

/* ── asset_add 三层嵌套：运行时一致性 ───────────────────────────────────── */

describe("redteam_asset_add —— 三层嵌套 schema", () => {
  it("完整三层结构原样送达 store", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const ports = [
      {
        port: 443,
        proto: "tcp",
        service: "https",
        product: "nginx",
        version: "1.24.0",
        url: "https://oa.example.com/portal",
        title: "致远OA 登录",
        provenance: "active" as const,
        fingerprints: [
          { category: "Web服务器", vendor: "nginx", product: "nginx", version: "1.24.0", confidence: 0.9 },
          { category: "CMS", product: "seeyon" },
        ],
      },
    ];
    await run(tools, "redteam_asset_add", {
      ip: "10.0.0.5",
      provenance: "active",
      tool: "nmap",
      ports,
    });

    const call = lastCall(store, "importBundle");
    assert.notEqual(call, undefined);
    const bundle = call?.[1] as Record<string, unknown>;
    const assets = bundle["assets"] as Record<string, unknown>[];
    const sentPorts = assets[0]?.["ports"] as Record<string, unknown>[];
    assert.equal(sentPorts.length, 1);
    assert.equal(sentPorts[0]?.["port"], 443);
    const fps = sentPorts[0]?.["fingerprints"] as Record<string, unknown>[];
    assert.equal(fps.length, 2);
    assert.equal(fps[0]?.["category"], "Web服务器");
    assert.equal(fps[1]?.["category"], "CMS", "第二层嵌套也要原样");
    assert.equal(fps[0]?.["confidence"], 0.9);
  });

  it("缺中间层（只有 ip，没有 ports/names）不崩", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_add", { ip: "10.0.0.9", provenance: "passive" });
    assert.equal(out["ok"], true);
    const bundle = lastCall(store, "importBundle")?.[1] as Record<string, unknown>;
    const asset = (bundle["assets"] as Record<string, unknown>[])[0];
    /* 原实现把 undefined 一并塞进 payload，store 侧按"没提供"处理 —— 保持一致 */
    assert.equal(asset?.["ip"], "10.0.0.9");
    assert.equal(asset?.["ports"], undefined);
  });

  it("ports 为空数组时按空处理（不是 undefined）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_add", { ip: "10.0.0.9", provenance: "passive", ports: [] });
    const asset = ((lastCall(store, "importBundle")?.[1] as Record<string, unknown>)["assets"] as Record<string, unknown>[])[0];
    assert.deepEqual(asset?.["ports"], []);
  });

  /**
   * **多余字段的行为是分层的**（实测，原实现即如此）：
   *
   * - `asset` 层：工具逐个字段挑着构造，所以**多余字段被丢弃**
   * - `ports[]` / `names[]` 层：直接引用 `args.ports` / `args.names`，所以**多余字段透传**
   *
   * 这个不对称是有原因的：asset 层要显式钉住"发现时间"这类语义字段（不能靠透传），
   * 而 ports 层交给 store 归一。锁住现状 —— 若有人以为"全都过滤"或"全都透传"，
   * 会写出错误的断言或错误的重构。
   */
  it("多余字段：asset 层丢弃、嵌套层透传（分层行为，锁住现状）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_add", {
      ip: "10.0.0.9",
      provenance: "passive",
      unexplored_extra: "should-be-ignored",
      ports: [{ port: 80, extra_port_field: "x" }],
      names: [{ name: "a.example.com", extra_name_field: "y" }],
    });
    const asset = ((lastCall(store, "importBundle")?.[1] as Record<string, unknown>)["assets"] as Record<string, unknown>[])[0];

    /* asset 层：白名单构造 */
    assert.equal("unexplored_extra" in (asset ?? {}), false, "asset 层的多余字段应被丢弃");

    /* 嵌套层：原样透传（store 侧负责归一） */
    const port = (asset?.["ports"] as Record<string, unknown>[])[0];
    assert.equal(port?.["port"], 80);
    assert.equal(port?.["extra_port_field"], "x", "ports 层的多余字段原样透传");

    const name = (asset?.["names"] as Record<string, unknown>[])[0];
    assert.equal(name?.["extra_name_field"], "y", "names 层的多余字段原样透传");
  });

  it("discovered_at / first_seen 分开传（发现时间与首次出现时间不是一个概念）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_add", {
      ip: "10.0.0.9",
      provenance: "passive",
      discovered_at: "2026-09-17T09:30:00Z",
      first_seen: "2025-01-01T00:00:00Z",
    });
    const asset = ((lastCall(store, "importBundle")?.[1] as Record<string, unknown>)["assets"] as Record<string, unknown>[])[0];
    assert.equal(asset?.["discovered_at"], "2026-09-17T09:30:00Z");
    assert.equal(asset?.["first_seen"], "2025-01-01T00:00:00Z");
  });

  it("scan.argv 标记来源工具（可追溯到哪个工具写的）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_add", { ip: "1.2.3.4", provenance: "active", tool: "nmap" });
    const bundle = lastCall(store, "importBundle")?.[1] as Record<string, unknown>;
    const scan = bundle["scan"] as Record<string, unknown>;
    assert.equal(scan["tool"], "nmap");
    assert.deepEqual(scan["argv"], ["redteam_asset_add"]);
  });

  it("回写后展示发现时间（提示「重复采集不改它」）", async () => {
    const written = {
      id: 7,
      ip: "10.0.0.5",
      segment_cidr: "10.0.0.0/24",
      state: "live",
      primary_name: "host",
      names: [],
      ports: [],
      fingerprints: [],
      passive: 1,
      active: 0,
      discovered_at: "2026-09-17T09:30:00Z",
      first_seen: null,
      last_seen: "2026-09-18T00:00:00Z",
      test_status: "untested",
      priority: "medium",
    };
    const store = mkStore({ listAssets: () => ({ total: 1, items: [written] }) });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_add", { ip: "10.0.0.5", provenance: "active" });
    assert.equal(out["discovered_at"], "2026-09-17T09:30:00Z");
    assert.match(String(out["hint"]), /重复采集只刷新 last_seen/);
  });
});

/* ── compactAsset ─────────────────────────────────────────────────────── */

describe("compactAsset", () => {
  const base = {
    id: 1,
    ip: "10.0.0.5",
    segment_cidr: "10.0.0.0/24",
    state: "live",
    primary_name: "web",
    names: [{ name: "a.example.com" }, { name: "b.example.com" }],
    ports: [
      { port: 443, proto: "tcp", state: "open", service: "https", product: "nginx", version: "1.24", provenance: "active" },
      { port: 22, proto: "tcp", state: "filtered", provenance: "passive" },
      { port: 3306, proto: "tcp", state: "open", service: "mysql", provenance: "active" },
    ],
    fingerprints: [
      { category: "Web服务器", vendor: "nginx", product: "nginx", version: "1.24", provenance: "active" },
      { category: "CMS", provenance: "passive" },
    ],
    passive: 2,
    active: 1,
    discovered_at: "2026-09-17T00:00:00Z",
    first_seen: null,
    last_seen: "2026-09-18T00:00:00Z",
    test_status: "testing",
    priority: "high",
  };

  it("只保留 open 端口（filtered 不进模型上下文）", () => {
    const out = compactAsset(base);
    const ports = out["ports"] as string[];
    assert.equal(ports.length, 2);
    assert.equal(ports.some((p) => p.startsWith("22/")), false);
  });

  it("端口串带服务与 provenance", () => {
    const ports = compactAsset(base)["ports"] as string[];
    assert.equal(ports[0], "443/tcp https nginx 1.24 [active]");
    assert.equal(ports[1], "3306/tcp mysql [active]");
  });

  it("指纹串带分类与 provenance", () => {
    const fps = compactAsset(base)["fingerprints"] as string[];
    assert.equal(fps[0], "Web服务器 nginx nginx 1.24 [active]");
    assert.equal(fps[1], "CMS [passive]");
  });

  it("names 只取名字", () => {
    assert.deepEqual(compactAsset(base)["names"], ["a.example.com", "b.example.com"]);
  });

  it("字段名映射正确（segment_cidr → segment / primary_name → name）", () => {
    const out = compactAsset(base);
    assert.equal(out["segment"], "10.0.0.0/24");
    assert.equal(out["name"], "web");
    assert.equal(out["discovered_at"], "2026-09-17T00:00:00Z");
  });
});

/* ── 其余 10 个工具 ────────────────────────────────────────────────────── */

describe("redteam_asset_link", () => {
  it("写入关系边并回报道数", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_link", {
      src_kind: "domain",
      src_id: "a.example.com",
      dst_kind: "asset",
      dst_id: "5",
      relation: "resolves",
      confidence: 0.8,
    });
    assert.equal(out["ok"], true);
    assert.equal(out["edges"], 0);
    const bundle = lastCall(store, "importBundle")?.[1] as Record<string, unknown>;
    const edge = (bundle["edges"] as Record<string, unknown>[])[0];
    assert.equal(edge?.["relation"], "resolves");
    assert.equal(edge?.["confidence"], 0.8);
  });

  it("不传 confidence 时该键不出现（避免把 undefined 写进库）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_link", {
      src_kind: "a",
      src_id: "1",
      dst_kind: "b",
      dst_id: "2",
      relation: "r",
    });
    const edge = ((lastCall(store, "importBundle")?.[1] as Record<string, unknown>)["edges"] as Record<string, unknown>[])[0];
    assert.equal("confidence" in (edge ?? {}), false);
  });
});

describe("redteam_asset_query", () => {
  it("limit 默认 50", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_query", {});
    const filter = lastCall(store, "listAssets")?.[1] as Record<string, unknown>;
    assert.equal(filter["limit"], 50);
  });

  it("limit 上限 200（超了被夹住）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_query", { limit: 9999 });
    assert.equal((lastCall(store, "listAssets")?.[1] as Record<string, unknown>)["limit"], 200);
  });

  it("未传的过滤条件不出现在 payload（避免把 undefined 当条件）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_query", { cidr: "10.0.0.0/24" });
    const filter = lastCall(store, "listAssets")?.[1] as Record<string, unknown>;
    assert.equal(filter["cidr"], "10.0.0.0/24");
    assert.equal("service" in filter, false);
    assert.equal("scope" in filter, false);
  });

  it("scope / sort 等枚举原样透传", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_query", { scope: "internal", sort: "todo", state: "live" });
    const filter = lastCall(store, "listAssets")?.[1] as Record<string, unknown>;
    assert.equal(filter["scope"], "internal");
    assert.equal(filter["sort"], "todo");
    assert.equal(filter["state"], "live");
  });

  it("返回 compact 后的条目", async () => {
    const store = mkStore({
      listAssets: () => ({
        total: 1,
        items: [
          {
            id: 1,
            ip: "10.0.0.1",
            segment_cidr: "10.0.0.0/24",
            state: "live",
            primary_name: null,
            names: [],
            ports: [],
            fingerprints: [],
            passive: 0,
            active: 0,
            discovered_at: null,
            first_seen: null,
            last_seen: null,
            test_status: "untested",
            priority: "low",
          },
        ],
      }),
    });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_query", {});
    assert.equal(out["total"], 1);
    assert.equal(out["returned"], 1);
  });
});

describe("redteam_asset_get", () => {
  it("找到时返回完整 asset", async () => {
    const store = mkStore({ getAsset: () => ({ id: 5, ip: "10.0.0.5", ports: [80] }) });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_get", { id: 5 });
    assert.equal(out["ok"], true);
    assert.notEqual(out["asset"], undefined);
  });

  it("找不到时 ok:false（不是抛错）", async () => {
    const tools = assetTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_get", { id: 999 });
    assert.equal(out["ok"], false);
    assert.equal(out["error"], "asset not found");
  });
});

describe("redteam_asset_stats / graph", () => {
  it("stats 返回统计与分段明细", async () => {
    const tools = assetTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_stats", {});
    assert.equal(out["ok"], true);
    assert.notEqual(out["stats"], undefined);
    assert.deepEqual(out["segments"], []);
  });

  it("graph 节点未超限时全量返回", async () => {
    const store = mkStore({ graph: () => ({ nodes: [{ id: "n1", label: "a" }], edges: [] }) });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_graph", {});
    assert.equal(out["ok"], true);
    assert.equal((out["nodes"] as unknown[]).length, 1);
  });

  it("graph 节点超限时拒绝并建议缩小 cidr", async () => {
    const nodes = Array.from({ length: 301 }, (_, i) => ({ id: "n" + String(i), label: "l" }));
    const store = mkStore({ graph: () => ({ nodes, edges: [] }) });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_graph", {});
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /图谱节点过多/);
    assert.match(String(out["error"]), /请指定 cidr/);
  });

  it("maxNodes 上限 1000（超了被夹住）", async () => {
    const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: "n" + String(i), label: "l" }));
    const store = mkStore({ graph: () => ({ nodes, edges: [] }) });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_graph", { maxNodes: 99999 });
    assert.equal(out["ok"], false, "1001 个节点超过 1000 上限");
  });
});

describe("redteam_asset_test / assess", () => {
  it("asset_test 不把 engagement 传进 store（它是作用域不是资产字段）", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_test", { asset_id: 5, status: "testing", test: "nmap 全端口", engagement: "e1" });
    const patch = lastCall(store, "updateAssetTest")?.[1] as Record<string, unknown>;
    assert.equal("engagement" in patch, false, "engagement 必须被剔掉");
    assert.equal(patch["status"], "testing");
    assert.equal(patch["test"], "nmap 全端口");
  });

  it("asset_test 的 notes 作为 test 的兼容别名一并透传", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_test", { ip: "10.0.0.1", status: "tested", notes: "老提示词写法" });
    const patch = lastCall(store, "updateAssetTest")?.[1] as Record<string, unknown>;
    assert.equal(patch["notes"], "老提示词写法");
  });

  it("assess 同样剔掉 engagement", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_assess", { asset_id: 5, priority: "high", engagement: "e1" });
    const patch = lastCall(store, "assessAsset")?.[1] as Record<string, unknown>;
    assert.equal("engagement" in patch, false);
    assert.equal(patch["priority"], "high");
  });
});

describe("redteam_asset_timeline", () => {
  it("按天聚合与最近资产都返回", async () => {
    const store = mkStore({
      discoveryTimeline: () => ({
        span: { first: "2026-09-01", last: "2026-09-17" },
        days: [{ date: "2026-09-17", internal: 3, external: 5 }],
        recent: [
          {
            id: 1,
            ip: "10.0.0.1",
            scope: "internal",
            state: "live",
            primary_name: "x",
            discovered_at: "2026-09-17T00:00:00Z",
            last_seen: null,
            open_ports: 2,
            priority: "high",
          },
        ],
      }),
    });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_timeline", {});
    assert.equal(out["ok"], true);
    assert.notEqual(out["span"], undefined);
    assert.equal((out["days"] as unknown[]).length, 1);
    assert.equal((out["recent"] as unknown[]).length, 1);
    assert.match(String(out["hint"]), /第一次进入本库/);
  });

  it("limit 透传", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_asset_timeline", { limit: 10 });
    assert.equal((lastCall(store, "discoveryTimeline")?.[1] as Record<string, unknown>)["limit"], 10);
  });
});

describe("redteam_web_list", () => {
  it("url 缺失时按端口推出可访问 URL", async () => {
    const store = mkStore({
      listWeb: () => ({
        total: 3,
        items: [
          { url: null, title: null, ip: "1.1.1.1", segment_cidr: "1.1.1.0/24", port: 443, service: null, product: null, version: null, provenance: "active", asset_id: 1 },
          { url: null, title: null, ip: "2.2.2.2", segment_cidr: "2.2.2.0/24", port: 80, service: null, product: null, version: null, provenance: "active", asset_id: 2 },
          { url: null, title: null, ip: "3.3.3.3", segment_cidr: "3.3.3.0/24", port: 8080, service: null, product: null, version: null, provenance: "active", asset_id: 3 },
        ],
      }),
    });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_web_list", {});
    const items = out["items"] as { url: string }[];
    assert.equal(items[0]?.url, "https://1.1.1.1", "443 走 https 且不带端口");
    assert.equal(items[1]?.url, "http://2.2.2.2", "80 走 http 且不带端口");
    assert.equal(items[2]?.url, "http://3.3.3.3:8080", "非标端口要带端口");
  });

  it("已有 url 时原样用（不重新拼）", async () => {
    const store = mkStore({
      listWeb: () => ({
        total: 1,
        items: [{ url: "https://oa.example.com:8443/portal", title: "OA", ip: "1.1.1.1", segment_cidr: "s", port: 8443, service: "https", product: "nginx", version: "1.2", provenance: "active", asset_id: 1 }],
      }),
    });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_web_list", {});
    const items = out["items"] as { url: string }[];
    assert.equal(items[0]?.url, "https://oa.example.com:8443/portal");
  });

  it("service 串由 service/product/version 拼成", async () => {
    const store = mkStore({
      listWeb: () => ({
        total: 1,
        items: [{ url: null, title: null, ip: "1.1.1.1", segment_cidr: "s", port: 80, service: "http", product: "nginx", version: "1.24", provenance: "active", asset_id: 1 }],
      }),
    });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_web_list", {});
    assert.equal((out["items"] as { service: string }[])[0]?.service, "http nginx 1.24");
  });
});

describe("redteam_domain_index", () => {
  it("返回域名聚合结果", async () => {
    const store = mkStore({ domainIndex: () => [{ domain: "a.example.com", assets: [1, 2] }] });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_domain_index", {});
    assert.equal(out["ok"], true);
    assert.equal((out["items"] as unknown[]).length, 1);
  });
});

/* ── 靶标解析（本组所有工具共用） ──────────────────────────────────────── */

describe("本组共用的靶标解析", () => {
  it("未绑定且多靶标时报错（不猜）", async () => {
    resetToolState();
    const store = mkStore({
      listEngagements: () => [
        { id: "e1", name: "A", created_at: "t" },
        { id: "e2", name: "B", created_at: "t" },
      ],
    });
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const { withStructuredErrors } = await import("../../src/redteam/tools/define.js");
    const guarded = withStructuredErrors(toolNamed(tools, "redteam_asset_stats"));
    const raw = await (guarded.execute as (a: unknown, e: ToolExecContext) => Promise<string>)({}, mkExec());
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /尚未绑定靶标/);
  });

  it("显式传 engagement 时优先于绑定", async () => {
    const store = mkStore();
    const tools = assetTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_asset_stats", { engagement: "explicit-id" });
    assert.equal(out["engagement"], "explicit-id");
  });
});
