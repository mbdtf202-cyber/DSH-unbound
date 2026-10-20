/**
 * WebShell / 隧道 / 会话总览 组（9 个工具）的测试。
 *
 * ## 本组的核心：description 逐字保真
 *
 * `tunnel_add` 的 description 有 497 字，包含"什么不算突破"的完整红线说明。
 * 这类文字**改写一个字就可能改变模型行为**（比如把"不算突破"写成"算突破"）。
 *
 * 所以本文件的第一组用例不是测行为，而是**比对工具里的 description 与
 * `descriptions.ts` 常量是否完全一致** —— 而那份常量是脚本从原实现 `eval`
 * 原文生成的。这样"我抄漏了一个字"这类错误必然被抓到。
 *
 * ## 第二个重点：`attackGraph` 可选能力的降级不能冒充
 *
 * `graph()`（只有资产）与 `attackGraph()`（含漏洞节点与 owned 标记）语义不同。
 * store 未提供后者时必须明确报错，不能拿前者顶替 —— 那会让"攻击路径"缺一半信息。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { TUNNEL_TOOL_NAMES, tunnelTools } from "../../src/redteam/tools/tunnel-tools.js";
import { TOOL_DESCRIPTIONS } from "../../src/redteam/tools/descriptions.js";
import { bindings, resetToolState } from "../../src/redteam/tools/context.js";
import type { StoreForTools } from "../../src/redteam/tools/store-contract.js";

interface Recorder {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
}

function mkStore(overrides: Partial<StoreForTools> = {}): StoreForTools & Recorder {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string, ret: unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      return ret;
    };
  const base: Record<string, unknown> = {
    activeEngagementId: (): string | undefined => undefined,
    listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }],
    sessionSummary: rec("sessionSummary", {
      totals: { webshells: 1, tunnels: 1, online: 1, active: 1 },
      webshells: [
        {
          id: 1,
          url: "http://x/shell.jsp",
          shell_type: "behinder",
          pass_key: "k",
          privilege: "www-data",
          status: "online",
          asset_ip: "10.0.0.5",
          last_check: "2026-09-17T00:00:00Z",
          note: null,
        },
      ],
      tunnels: [
        {
          id: 2,
          kind: "suo5",
          listen: "127.0.0.1:1080",
          entry: "http://x/shell.jsp",
          reach: "10.0.0.0/8",
          entry_kind: "target-http",
          legit: true,
          status: "active",
          asset_ip: "10.0.0.5",
          command: "suo5 -t ...",
          last_check: null,
          note: null,
        },
      ],
    }),
    addWebshell: rec("addWebshell", { id: 1 }),
    listWebshells: rec("listWebshells", { items: [] }),
    updateWebshell: rec("updateWebshell", { updated: true }),
    addTunnel: rec("addTunnel", { id: 2 }),
    listTunnels: rec("listTunnels", { items: [] }),
    updateTunnel: rec("updateTunnel", { updated: true }),
    probeSessions: async () => ({
      checkedAt: "2026-09-17T00:00:00Z",
      webshells: [{ status: "online" }, { status: "offline" }],
      tunnels: [{ status: "active" }, { status: "down" }],
    }),
    attackGraph: rec("attackGraph", {
      nodes: [
        { id: "a", label: "10.0.0.5", meta: { owned: true } },
        { id: "b", label: "10.0.0.6", meta: { owned: false } },
        { id: "c", label: "10.0.0.7" },
      ],
      edges: [],
      summary: { assets: 3 },
    }),
  };
  return Object.assign({ ...base, ...overrides }, { calls }) as unknown as StoreForTools & Recorder;
}

function mkExec(sessionId = "s1"): ToolExecContext {
  return { agent: { session: { id: sessionId, header: {} } } } as unknown as ToolExecContext;
}

function toolNamed(tools: ReturnType<typeof tunnelTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  assert.notEqual(found, undefined, `找不到 ${name}`);
  return found as ReturnType<typeof tunnelTools>[number];
}

async function run(
  tools: ReturnType<typeof tunnelTools>,
  name: string,
  args: Record<string, unknown>,
  exec: ToolExecContext = mkExec(),
): Promise<Record<string, unknown>> {
  const out = await (toolNamed(tools, name).execute as (a: unknown, e: ToolExecContext) => Promise<string>)(args, exec);
  return JSON.parse(out) as Record<string, unknown>;
}

function lastCall(store: StoreForTools & Recorder, method: string): readonly unknown[] | undefined {
  const hits = store.calls.filter((c) => c.method === method);
  return hits.length === 0 ? undefined : hits[hits.length - 1]?.args;
}

beforeEach(() => {
  resetToolState();
  bindings.set("s1", "e1");
});

/* ── description 逐字保真（本组最重要） ────────────────────────────────── */

describe("description 与 descriptions.ts 常量完全一致", () => {
  const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("9 个工具，名字与顺序稳定", () => {
    assert.deepEqual(tools.map((t) => t.name), [...TUNNEL_TOOL_NAMES]);
  });

  it("每个工具的 description 与常量逐字符相同", () => {
    for (const t of tools) {
      const key = t.name as keyof typeof TOOL_DESCRIPTIONS;
      const expected = TOOL_DESCRIPTIONS[key];
      assert.notEqual(expected, undefined, `${t.name} 在 descriptions.ts 里没有对应常量`);
      assert.equal(t.description, expected, `${t.name} 的 description 与原文不一致`);
    }
  });

  it("tunnel_add 的红线段落完整保留（含 \n\n 分段）", () => {
    const d = toolNamed(tools, "redteam_tunnel_add").description;
    /* 原文分两段：第一段讲怎么建隧道，第二段讲什么不算突破 */
    assert.equal(d.includes("\n\n**红线：自己的 VPS / 自己配置的服务器不算隧道。**"), true);
    assert.equal(d.length > 450, true, "tunnel_add 的 description 应保留完整长度，实际=" + String(d.length));
  });

  it("tunnel_add 的三种合法 entry_kind 都在原文里", () => {
    const d = toolNamed(tools, "redteam_tunnel_add").description;
    for (const k of ["target-outbound", "target-http", "target-agent"]) {
      assert.equal(d.includes(k), true, "缺少 entry_kind 说明：" + k);
    }
    assert.match(d, /self-only/);
  });

  it("webshell_add 保留「只能填 godzilla | behinder」约束", () => {
    const d = toolNamed(tools, "redteam_webshell_add").description;
    assert.match(d, /shell_type 只能填 godzilla \| behinder/);
    assert.match(d, /一句话马\/自研马\/MemShell 用户连不上/);
  });

  it("tunnel_list / update 保留 legit 语义说明", () => {
    /* 用字符串查而不是正则：这句里含 `/`，写成正则要转义，容易看错 */
    assert.equal(
      toolNamed(tools, "redteam_tunnel_list").description.includes("legit=false 表示只在自己 VPS/自建服务器上开的通道"),
      true,
    );
    assert.match(toolNamed(tools, "redteam_tunnel_update").description, /补完才算突破凭证/);
  });

  it("descriptions 常量覆盖本组全部工具（没有遗漏）", () => {
    for (const name of TUNNEL_TOOL_NAMES) {
      assert.notEqual(
        (TOOL_DESCRIPTIONS as Record<string, string>)[name],
        undefined,
        `${name} 在 TOOL_DESCRIPTIONS 里缺失`,
      );
    }
  });
});

/* ── sessions 总览 ────────────────────────────────────────────────────── */

describe("redteam_sessions", () => {
  it("字段映射：shell_type → type", async () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_sessions", {});
    const shells = out["webshells"] as Record<string, unknown>[];
    assert.equal(shells[0]?.["type"], "behinder");
    assert.equal(shells[0]?.["pass_key"], "k");
  });

  it("隧道带 legit 与 entry_kind（判定在 store，工具只透传）", async () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_sessions", {});
    const tunnels = out["tunnels"] as Record<string, unknown>[];
    assert.equal(tunnels[0]?.["legit"], true);
    assert.equal(tunnels[0]?.["entry_kind"], "target-http");
  });

  it("hint 保留「self-only 不算突破」的提醒", async () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_sessions", {});
    assert.match(String(out["hint"]), /不算跨越靶标边界、不算突破/);
    assert.match(String(out["hint"]), /legit=null 表示未声明/);
  });

  it("totals 原样返回", async () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_sessions", {});
    assert.deepEqual(out["totals"], { webshells: 1, tunnels: 1, online: 1, active: 1 });
  });
});

/* ── webshell CRUD ────────────────────────────────────────────────────── */

describe("redteam_webshell_add / list / update", () => {
  it("add 强制 status=online（刚登记的马刚打通）", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_webshell_add", { url: "http://x/s.jsp", shell_type: "behinder" });
    const payload = lastCall(store, "addWebshell")?.[1] as Record<string, unknown>;
    assert.equal(payload["status"], "online");
    assert.equal("engagement" in payload, false);
  });

  it("add 带上 agent", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_webshell_add", { url: "u", agent: "exploit" });
    assert.equal((lastCall(store, "addWebshell")?.[1] as Record<string, unknown>)["agent"], "exploit");
  });

  it("url 必填", () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(toolNamed(tools, "redteam_webshell_add").parameters["url"]?.required, true);
  });

  it("list 的过滤器可选", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_webshell_list", {});
    assert.deepEqual(lastCall(store, "listWebshells")?.[1], {});
    await run(tools, "redteam_webshell_list", { status: "online", asset_id: 3 });
    assert.deepEqual(lastCall(store, "listWebshells")?.[1], { status: "online", asset_id: 3 });
  });

  it("update 的 id 必填", () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(toolNamed(tools, "redteam_webshell_update").parameters["id"]?.required, true);
  });

  it("update 原样透传 args（含 id，store 侧忽略）", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_webshell_update", { id: 5, status: "dead", note: "被删了" });
    const call = lastCall(store, "updateWebshell");
    assert.equal(call?.[1], 5);
    const patch = call?.[2] as Record<string, unknown>;
    assert.equal(patch["status"], "dead");
    assert.equal(patch["note"], "被删了");
  });
});

/* ── tunnel CRUD ──────────────────────────────────────────────────────── */

describe("redteam_tunnel_add / list / update", () => {
  it("add 强制 status=active", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_tunnel_add", { kind: "suo5", listen: "127.0.0.1:1080" });
    const payload = lastCall(store, "addTunnel")?.[1] as Record<string, unknown>;
    assert.equal(payload["status"], "active");
  });

  it("kind 与 listen 都是必填", () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const p = toolNamed(tools, "redteam_tunnel_add").parameters;
    assert.equal(p["kind"]?.required, true);
    assert.equal(p["listen"]?.required, true);
  });

  it("entry_kind 透传给 store（判定不在这里做）", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_tunnel_add", {
      kind: "suo5",
      listen: "127.0.0.1:1080",
      entry_kind: "self-only",
    });
    assert.equal((lastCall(store, "addTunnel")?.[1] as Record<string, unknown>)["entry_kind"], "self-only");
  });

  it("list 按 status 过滤", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_tunnel_list", { status: "active" });
    assert.deepEqual(lastCall(store, "listTunnels")?.[1], { status: "active" });
  });

  it("update 可补 entry_kind（老记录 legit=null 的收口路径）", async () => {
    const store = mkStore();
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_tunnel_update", { id: 9, entry_kind: "target-http" });
    const patch = lastCall(store, "updateTunnel")?.[2] as Record<string, unknown>;
    assert.equal(patch["entry_kind"], "target-http");
  });

  it("update 的 id 必填", () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(toolNamed(tools, "redteam_tunnel_update").parameters["id"]?.required, true);
  });
});

/* ── session_check ────────────────────────────────────────────────────── */

describe("redteam_session_check", () => {
  it("统计在线/可用数量并给出可读摘要", async () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_session_check", {});
    assert.equal(out["summary"], "WebShell 在线 1/2，隧道可用 1/2");
    assert.equal(out["checked_at"], "2026-09-17T00:00:00Z");
  });

  it("timeoutMs 透传", async () => {
    let seen: unknown;
    const store = mkStore({
      probeSessions: async (_id, opts) => {
        seen = opts;
        return { checkedAt: "t", webshells: [], tunnels: [] };
      },
    });
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_session_check", { timeoutMs: 3000 });
    assert.deepEqual(seen, { timeoutMs: 3000 });
  });

  it("不传 timeoutMs 时传空对象（让 store 用默认 6000）", async () => {
    let seen: unknown;
    const store = mkStore({
      probeSessions: async (_id, opts) => {
        seen = opts;
        return { checkedAt: "t", webshells: [], tunnels: [] };
      },
    });
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_session_check", {});
    assert.deepEqual(seen, {});
  });

  it("全离线时摘要如实反映 0", async () => {
    const store = mkStore({
      probeSessions: async () => ({
        checkedAt: "t",
        webshells: [{ status: "offline" }],
        tunnels: [{ status: "down" }],
      }),
    });
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_session_check", {});
    assert.equal(out["summary"], "WebShell 在线 0/1，隧道可用 0/1");
  });
});

/* ── attack_path：可选能力不能冒充 ────────────────────────────────────── */

describe("redteam_attack_path", () => {
  it("只把 meta.owned 的节点算进 owned 列表", async () => {
    const tools = tunnelTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_path", {});
    assert.deepEqual(out["owned"], ["10.0.0.5"]);
    assert.equal((out["nodes"] as unknown[]).length, 3);
  });

  it("store 没有 attackGraph 时**明确报错**，不拿 graph() 顶替", async () => {
    const store = mkStore();
    /* 删掉可选能力，模拟 store 侧未落地 */
    delete (store as unknown as Record<string, unknown>)["attackGraph"];
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    const { withStructuredErrors } = await import("../../src/redteam/tools/define.js");
    const guarded = withStructuredErrors(toolNamed(tools, "redteam_attack_path"));
    const raw = await (guarded.execute as (a: unknown, e: ToolExecContext) => Promise<string>)({}, mkExec());
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /store 未提供 attackGraph/);
    assert.match(String(out["error"]), /redteam_asset_graph/, "要给出替代路径");
  });

  it("节点超限时拒绝并给 summary 供判断", async () => {
    const many = Array.from({ length: 401 }, (_, i) => ({ id: "n" + String(i), label: "l" + String(i) }));
    const store = mkStore({
      attackGraph: () => ({ nodes: many, edges: [], summary: { assets: 401 } }),
    });
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_path", {});
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /图谱节点过多/);
    assert.deepEqual(out["summary"], { assets: 401 });
  });

  it("maxNodes 上限 1500", async () => {
    const many = Array.from({ length: 1501 }, (_, i) => ({ id: "n" + String(i), label: "l" }));
    const store = mkStore({ attackGraph: () => ({ nodes: many, edges: [], summary: {} }) });
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_path", { maxNodes: 99999 });
    assert.equal(out["ok"], false);
  });

  it("cidr 透传", async () => {
    let seen: unknown;
    const store = mkStore({
      attackGraph: (_id, f) => {
        seen = f;
        return { nodes: [], edges: [], summary: {} };
      },
    });
    const tools = tunnelTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_attack_path", { cidr: "10.0.0.0/24" });
    assert.deepEqual(seen, { cidr: "10.0.0.0/24" });
  });
});
