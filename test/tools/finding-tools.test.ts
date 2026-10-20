/**
 * 漏洞 / 凭据 / 访问 / 截图 组（10 个工具）的测试。
 *
 * ## 本组的两类重点
 *
 * 1. **`credential_add` 的明文要求**：description 明确说"必须把口令/密钥明文写进
 *    secret_value"。这条不是可选的——面板靠它直接显示明文供复用。
 *    测试要钉住：明文真的透传、不被工具层改写或脱敏。
 * 2. **`vuln_update`/`vuln_query` 的参数整形**：不传的字段不能以 `undefined` 形式
 *    进入 store（否则部分 store 实现会把"显式 undefined"当成"清空"）。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { FINDING_TOOL_NAMES, SEVERITY_ENUM, VULN_STATUS_ENUM, findingTools } from "../../src/redteam/tools/finding-tools.js";
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
    addVuln: rec("addVuln", { id: 1, created: true }),
    listVulns: rec("listVulns", { total: 0, items: [] }),
    updateVuln: rec("updateVuln", { updated: true }),
    vulnStats: rec("vulnStats", { total: 0 }),
    addCredential: rec("addCredential", { id: 2 }),
    listCredentials: rec("listCredentials", []),
    addAccess: rec("addAccess", { id: 3 }),
    listAccess: rec("listAccess", []),
    addShot: rec("addShot", { id: 4 }),
    listShots: rec("listShots", { items: [] }),
    deleteShot: rec("deleteShot", { deleted: true }),
  };
  return Object.assign({ ...base, ...overrides }, { calls }) as unknown as StoreForTools & Recorder;
}

function mkExec(sessionId = "s1"): ToolExecContext {
  return { agent: { session: { id: sessionId, header: {} } } } as unknown as ToolExecContext;
}

function toolNamed(tools: ReturnType<typeof findingTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  assert.notEqual(found, undefined, `找不到 ${name}`);
  return found as ReturnType<typeof findingTools>[number];
}

async function run(
  tools: ReturnType<typeof findingTools>,
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

describe("本组工具集合", () => {
  const tools = findingTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("10 个工具，名字与顺序稳定", () => {
    assert.deepEqual(tools.map((t) => t.name), [...FINDING_TOOL_NAMES]);
  });

  it("枚举与 store 的 Severity / VulnStatus 对齐", () => {
    assert.deepEqual([...SEVERITY_ENUM], ["critical", "high", "medium", "low", "info"]);
    assert.deepEqual([...VULN_STATUS_ENUM], ["candidate", "confirmed", "false-positive", "exploited", "fixed"]);
    assert.deepEqual(toolNamed(tools, "redteam_vuln_add").parameters["severity"]?.enum, [...SEVERITY_ENUM]);
  });

  it("credential_add 的 description 保留明文要求原句", () => {
    const d = toolNamed(tools, "redteam_credential_add").description;
    assert.match(d, /\*\*必须把口令\/密钥明文写进 secret_value\*\*/);
    assert.match(d, /面板要直接显示明文供随时复用/);
    assert.match(d, /禁止把库文件或导出内容提交到任何仓库/);
  });

  it("shot_add 的 description 保留「最多 3 张代表图」约束", () => {
    const d = toolNamed(tools, "redteam_shot_add").description;
    assert.match(d, /每个得分点最多展示 3 张代表图/);
  });

  it("每个工具 description 非空", () => {
    for (const t of tools) assert.equal(t.description.length > 10, true, t.name);
  });
});

/* ── vuln_add ─────────────────────────────────────────────────────────── */

describe("redteam_vuln_add", () => {
  it("带上 agent 与默认 found_by_agent", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_add", { title: "SQL 注入", severity: "high", agent: "vuln-scan" });
    const payload = lastCall(store, "addVuln")?.[1] as Record<string, unknown>;
    assert.equal(payload["agent"], "vuln-scan");
    assert.equal(payload["found_by_agent"], "vuln-scan");
    assert.equal("engagement" in payload, false, "engagement 必须被剔掉");
  });

  it("不传 agent 时按主会话记账（plan）", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_add", { title: "X", severity: "low" });
    const payload = lastCall(store, "addVuln")?.[1] as Record<string, unknown>;
    assert.equal(payload["agent"], "plan");
  });

  it("显式 found_by_agent 优先于 agent", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_add", { title: "X", severity: "low", agent: "exploit", found_by_agent: "custom" });
    const payload = lastCall(store, "addVuln")?.[1] as Record<string, unknown>;
    assert.equal(payload["found_by_agent"], "custom");
  });

  it("gained（得分口径标签）原样透传", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_add", {
      title: "X",
      severity: "critical",
      gained: "服务器权限、内网隧道",
    });
    const payload = lastCall(store, "addVuln")?.[1] as Record<string, unknown>;
    assert.equal(payload["gained"], "服务器权限、内网隧道");
  });

  it("返回里带最新 vulnStats", async () => {
    const store = mkStore({ vulnStats: () => ({ total: 7, bySeverity: { high: 3 } }) });
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_vuln_add", { title: "X", severity: "high" });
    assert.deepEqual(out["stats"], { total: 7, bySeverity: { high: 3 } });
  });
});

/* ── vuln_query / update ──────────────────────────────────────────────── */

describe("redteam_vuln_query", () => {
  it("limit 默认 50、上限 200", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_query", {});
    assert.equal((lastCall(store, "listVulns")?.[1] as Record<string, unknown>)["limit"], 50);
    await run(tools, "redteam_vuln_query", { limit: 999 });
    assert.equal((lastCall(store, "listVulns")?.[1] as Record<string, unknown>)["limit"], 200);
  });

  it("未传的过滤条件不带 undefined 进 store", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_query", { severity: "high" });
    const filter = lastCall(store, "listVulns")?.[1] as Record<string, unknown>;
    assert.equal(filter["severity"], "high");
    assert.equal("status" in filter, false);
    assert.equal("cve" in filter, false);
    assert.equal("engagement" in filter, false);
  });
});

describe("redteam_vuln_update", () => {
  it("只传要改的字段（部分更新，不清空其它）", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_update", { id: 9, status: "confirmed" });
    const patch = lastCall(store, "updateVuln")?.[2] as Record<string, unknown>;
    assert.equal(patch["status"], "confirmed");
    assert.equal("severity" in patch, false, "没传的字段不该出现（会被当成清空）");
    assert.equal("evidence" in patch, false);
  });

  it("ok 反映 store 的 updated 标记", async () => {
    const store = mkStore({ updateVuln: () => ({ updated: false }) });
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_vuln_update", { id: 1, status: "fixed" });
    assert.equal(out["ok"], false, "store 没更新就应该是 ok:false");
  });

  it("id 原样传给 store（第一个参数是靶标，第二个才是 id）", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_vuln_update", { id: 42, title: "新标题" });
    const call = lastCall(store, "updateVuln");
    assert.equal(call?.[0], "e1");
    assert.equal(call?.[1], 42);
  });
});

/* ── credential：明文要求是硬约束 ──────────────────────────────────────── */

describe("redteam_credential_add —— 明文透传", () => {
  it("secret_value 明文原样送达 store（不脱敏、不改写）", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    const secret = "P@ssw0rd!#$%^&*()_+中文";
    await run(tools, "redteam_credential_add", { host: "10.0.0.5", username: "admin", secret_value: secret });
    const payload = lastCall(store, "addCredential")?.[1] as Record<string, unknown>;
    assert.equal(payload["secret_value"], secret, "明文必须一字不差地进去");
  });

  it("私钥类多行内容不被截断", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\nBBBBC4\n-----END OPENSSH PRIVATE KEY-----";
    await run(tools, "redteam_credential_add", { host: "1.1.1.1", secret_type: "key", secret_value: key });
    const payload = lastCall(store, "addCredential")?.[1] as Record<string, unknown>;
    assert.equal(payload["secret_value"], key);
    assert.equal(String(payload["secret_value"]).split("\n").length, 4);
  });

  it("secret_type 原样透传（password/hash/key/token/connection-string）", async () => {
    for (const t of ["password", "hash", "key", "token", "connection-string"]) {
      const store = mkStore();
      const tools = findingTools(store, { env: {}, root: "/tmp/x" });
      await run(tools, "redteam_credential_add", { host: "h", secret_type: t, secret_value: "v" });
      assert.equal((lastCall(store, "addCredential")?.[1] as Record<string, unknown>)["secret_type"], t);
    }
  });

  it("agent 必填项按角色记账", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_credential_add", { host: "h", secret_value: "v", agent: "internal" });
    assert.equal((lastCall(store, "addCredential")?.[1] as Record<string, unknown>)["agent"], "internal");
  });

  it("host 是必填参数", () => {
    const tools = findingTools(mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(toolNamed(tools, "redteam_credential_add").parameters["host"]?.required, true);
  });
});

/* ── credential_list / access ─────────────────────────────────────────── */

describe("redteam_credential_list", () => {
  it("按 host / username 过滤，未传的不出现", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_credential_list", { host: "10.0.0.5" });
    const filter = lastCall(store, "listCredentials")?.[1] as Record<string, unknown>;
    assert.equal(filter["host"], "10.0.0.5");
    assert.equal("username" in filter, false);
  });

  it("无过滤时传空对象", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_credential_list", {});
    assert.deepEqual(lastCall(store, "listCredentials")?.[1], {});
  });
});

describe("redteam_access_add / list", () => {
  it("method 必填且透传", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_access_add", { host: "10.0.0.5", method: "rdp", privilege: "admin" });
    const payload = lastCall(store, "addAccess")?.[1] as Record<string, unknown>;
    assert.equal(payload["method"], "rdp");
    assert.equal(payload["privilege"], "admin");
    assert.equal("engagement" in payload, false);
  });

  it("host 与 method 都是必填", () => {
    const tools = findingTools(mkStore(), { env: {}, root: "/tmp/x" });
    const p = toolNamed(tools, "redteam_access_add").parameters;
    assert.equal(p["host"]?.required, true);
    assert.equal(p["method"]?.required, true);
  });

  it("list 按 host 过滤", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_access_list", { host: "1.1.1.1" });
    assert.deepEqual(lastCall(store, "listAccess")?.[1], { host: "1.1.1.1" });
  });

  it("list 无过滤时传空对象", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_access_list", {});
    assert.deepEqual(lastCall(store, "listAccess")?.[1], {});
  });
});

/* ── shots ────────────────────────────────────────────────────────────── */

describe("redteam_shot_*", () => {
  it("add 支持 path 与 data_base64 两种来源（都由 store 处理）", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_shot_add", { path: "/tmp/shot.png", label: "证据" });
    let payload = lastCall(store, "addShot")?.[1] as Record<string, unknown>;
    assert.equal(payload["path"], "/tmp/shot.png");

    await run(tools, "redteam_shot_add", { data_base64: "iVBORw0KGgo=", label: "inline" });
    payload = lastCall(store, "addShot")?.[1] as Record<string, unknown>;
    assert.equal(payload["data_base64"], "iVBORw0KGgo=");
    assert.equal("path" in payload, false);
  });

  it("add 带上 agent 记账", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_shot_add", { path: "/x.png", agent: "exploit" });
    assert.equal((lastCall(store, "addShot")?.[1] as Record<string, unknown>)["agent"], "exploit");
  });

  it("list 的三项过滤器都可选", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_shot_list", { point_code: "terminal-access" });
    const filter = lastCall(store, "listShots")?.[1] as Record<string, unknown>;
    assert.equal(filter["point_code"], "terminal-access");
    assert.equal("hit_id" in filter, false);
    assert.equal("asset_id" in filter, false);
  });

  it("delete 的 id 必填且透传", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_shot_delete", { id: 7 });
    assert.equal(lastCall(store, "deleteShot")?.[1], 7);
    assert.equal(toolNamed(tools, "redteam_shot_delete").parameters["id"]?.required, true);
  });
});

/* ── 靶标解析 ─────────────────────────────────────────────────────────── */

describe("本组共用的靶标解析", () => {
  it("显式 engagement 覆盖绑定", async () => {
    const store = mkStore();
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_vuln_query", { engagement: "explicit" });
    assert.equal(out["engagement"], "explicit");
  });

  it("未绑定且多靶标时抛错（被结构化包装）", async () => {
    resetToolState();
    const store = mkStore({
      listEngagements: () => [
        { id: "a", name: "A", created_at: "t" },
        { id: "b", name: "B", created_at: "t" },
      ],
    });
    const tools = findingTools(store, { env: {}, root: "/tmp/x" });
    const { withStructuredErrors } = await import("../../src/redteam/tools/define.js");
    const guarded = withStructuredErrors(toolNamed(tools, "redteam_credential_list"));
    const raw = await (guarded.execute as (a: unknown, e: ToolExecContext) => Promise<string>)({}, mkExec());
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /尚未绑定靶标/);
  });
});
