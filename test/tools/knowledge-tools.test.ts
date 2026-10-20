/**
 * 知识库 + 角色提示词组（7 个工具）的测试。
 *
 * ## 本组最重要的边界：`poc_add` 的 engagement 不是作用域
 *
 * `redteam_poc_add` 的 `engagement` 参数表示**来源靶标**（这条知识在哪发现的），
 * 不是"作用到哪个靶标"。如果它走 `resolveEngagement`，把来源当成作用域，
 * 知识就会被记到错误的靶标下 —— 而面板归类与"按来源靶标筛"都会跟着错。
 *
 * 用例专门断言：**即使会话已绑定另一个靶标，poc_add 也不会用那个绑定**。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { KNOWLEDGE_TOOL_NAMES, knowledgeTools } from "../../src/redteam/tools/knowledge-tools.js";
import { TOOL_DESCRIPTIONS } from "../../src/redteam/tools/descriptions.js";
import { ROLE_ORDER } from "../../src/redteam/store/constants.js";
import { bindings, resetToolState } from "../../src/redteam/tools/context.js";
import type { StoreForTools } from "../../src/redteam/tools/store-contract.js";

interface Recorder { readonly calls: { readonly method: string; readonly args: readonly unknown[] }[]; }

function mkStore(overrides: Partial<StoreForTools> = {}): StoreForTools & Recorder {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, ret: unknown) => (...args: unknown[]): unknown => { calls.push({ method, args }); return ret; };
  const base: Record<string, unknown> = {
    activeEngagementId: (): string | undefined => undefined,
    listEngagements: () => [
      { id: "e1", name: "甲公司", created_at: "t" },
      { id: "e2", name: "乙公司", created_at: "t" },
    ],
    listPrompts: rec("listPrompts", [
      { role: "recon", title: "信息收集", updated_at: "2026-01-01", content: "你是信息收集角色" },
    ]),
    searchPocs: rec("searchPocs", []),
    getPoc: rec("getPoc", undefined),
    savePoc: rec("savePoc", {
      created: true,
      poc: { id: 1, code: "cve-2023-21839", category: "deserialization", engagement_id: "e2", engagement_name: "乙公司", asset_target: "10.1.2.3", created_at: "2026-09-17", verified: 1, verified_note: "回显 uid=0", updated_at: "2026-09-17" },
      path: "/pocs/cve-2023-21839.py",
    }),
    updatePoc: rec("updatePoc", { id: 1, code: "c", category: null, engagement_id: null, engagement_name: null, asset_target: null, created_at: "t", verified: 1, verified_note: "证据", updated_at: "2026-09-18" }),
    markPocUsed: rec("markPocUsed", { id: 1, hit_count: 3 }),
    pocStats: rec("pocStats", {
      total: 12, verified: 5, reused: 30,
      byCategory: [{ name: "rce", n: 6, verified: 3 }, { name: "sqli", n: 0, verified: 0 }],
      byEngagement: [{ engagement: "乙公司", n: 4 }],
      byKind: { poc: 8 }, bySource: { web: 9 },
    }),
    searchTemplates: rec("searchTemplates", {
      dir: "/tk/nuclei-templates", total: 13000, items: [{ path: "cves/2023/CVE-2023-21839.yaml", name: "CVE-2023-21839", severity: "critical", tags: ["weblogic"] }],
    }),
    templateStats: rec("templateStats", { dir: "/tk/nuclei-templates", total: 13000, cve: 4000, byCategory: [{ name: "cves", n: 4000 }] }),
    nucleiTemplatesDir: rec("nucleiTemplatesDir", "/tk/nuclei-templates"),
  };
  return Object.assign({ ...base, ...overrides }, { calls }) as unknown as StoreForTools & Recorder;
}

function mkExec(sessionId = "s1"): ToolExecContext {
  return { agent: { session: { id: sessionId, header: {} } } } as unknown as ToolExecContext;
}

function toolNamed(tools: ReturnType<typeof knowledgeTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  assert.notEqual(found, undefined, `找不到 ${name}`);
  return found as ReturnType<typeof knowledgeTools>[number];
}

async function run(tools: ReturnType<typeof knowledgeTools>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await (toolNamed(tools, name).execute as (a: unknown, e: ToolExecContext) => Promise<string>)(args, mkExec());
  return JSON.parse(out) as Record<string, unknown>;
}

function lastCall(store: StoreForTools & Recorder, method: string): readonly unknown[] | undefined {
  const hits = store.calls.filter((c) => c.method === method);
  return hits.length === 0 ? undefined : hits[hits.length - 1]?.args;
}

beforeEach(() => { resetToolState(); bindings.set("s1", "e1"); });

describe("知识库组工具集合", () => {
  const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("7 个工具，名字与顺序稳定", () => {
    assert.deepEqual(tools.map((t) => t.name), [...KNOWLEDGE_TOOL_NAMES]);
  });

  it("description 全部来自 descriptions.ts", () => {
    const dict = TOOL_DESCRIPTIONS as Record<string, string>;
    for (const t of tools) assert.equal(t.description, dict[t.name], t.name);
  });

  it("poc_add 的 description 保留「回填三件套」要求", () => {
    const d = toolNamed(tools, "redteam_poc_add").description;
    assert.match(d, /回填三件套（缺了面板里就没有归类、追溯不到来源）/);
  });

  it("role_prompt 的 role 枚举来自 ROLE_ORDER（含 assess）", () => {
    const roles = toolNamed(tools, "redteam_role_prompt").parameters["role"]?.enum;
    assert.deepEqual(roles, [...ROLE_ORDER]);
    assert.equal(roles?.includes("assess"), true);
  });
});

describe("redteam_role_prompt", () => {
  it("取到角色提示词全文", async () => {
    const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_role_prompt", { role: "recon" });
    assert.equal(out["ok"], true);
    assert.equal(out["prompt"], "你是信息收集角色");
    assert.equal(out["title"], "信息收集");
  });

  it("角色不存在时 ok:false（不抛）", async () => {
    const store = mkStore({ listPrompts: () => [] });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_role_prompt", { role: "recon" });
    assert.equal(out["ok"], false);
    assert.equal(out["error"], "unknown role");
  });
});

describe("redteam_poc_add —— engagement 是来源不是作用域", () => {
  it("不走 resolveEngagement：会话绑定的 e1 不影响来源解析", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    /* 会话已绑定 e1，但 poc_add 的 engagement 传"乙公司"（= e2）—— 必须按 e2 记 */
    await run(tools, "redteam_poc_add", { title: "T", engagement: "乙公司" });
    const payload = lastCall(store, "savePoc")?.[0] as Record<string, unknown>;
    assert.equal(payload["engagement_id"], "e2", "应按传入的来源靶标解析成 e2，而不是会话绑定的 e1");
    assert.equal(payload["engagement_name"], "乙公司");
  });

  it("来源靶标按 id 精确匹配", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_add", { title: "T", engagement: "e2" });
    const payload = lastCall(store, "savePoc")?.[0] as Record<string, unknown>;
    assert.equal(payload["engagement_id"], "e2");
    assert.equal(payload["engagement_name"], "乙公司");
  });

  it("来源靶标按名称子串匹配", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_add", { title: "T", engagement: "甲公" });
    const payload = lastCall(store, "savePoc")?.[0] as Record<string, unknown>;
    assert.equal(payload["engagement_id"], "e1");
  });

  it("来源靶标匹配不上时保留原文（不丢信息）", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_add", { title: "T", engagement: "未登记的靶标" });
    const payload = lastCall(store, "savePoc")?.[0] as Record<string, unknown>;
    assert.equal(payload["engagement_id"], "未登记的靶标");
    assert.equal(payload["engagement_name"], "未登记的靶标");
  });

  it("不传 engagement 时不写 engagement_id / engagement_name（无来源的知识）", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_add", { title: "T" });
    const payload = lastCall(store, "savePoc")?.[0] as Record<string, unknown>;
    assert.equal("engagement_id" in payload, false);
    assert.equal("engagement_name" in payload, false);
  });

  it("返回里回显归类、来源与验证状态", async () => {
    const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_add", { title: "T", engagement: "乙公司" });
    assert.equal(out["category"], "deserialization");
    assert.equal(out["engagement"], "乙公司");
    assert.equal(out["verified"], true);
    assert.match(String(out["hint"]), /知识库共 12 条/);
  });

  it("title 必填", () => {
    const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(toolNamed(tools, "redteam_poc_add").parameters["title"]?.required, true);
  });
});

describe("redteam_poc_search", () => {
  it("有查询词时搜模板；无查询词时只统计", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_search", { q: "weblogic" });
    assert.notEqual(lastCall(store, "searchTemplates"), undefined);

    const store2 = mkStore();
    const tools2 = knowledgeTools(store2, { env: {}, root: "/tmp/x" });
    await run(tools2, "redteam_poc_search", {});
    assert.equal(lastCall(store2, "searchTemplates"), undefined, "无查询词时不搜模板（省一次全目录扫描）");
  });

  it("templateStats 一次调用只算一次（原实现曾连算三遍）", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_search", { q: "x" });
    assert.equal(store.calls.filter((c) => c.method === "templateStats").length, 1);
  });

  it("templateLimit 默认 20、上限 100", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_search", { q: "x" });
    assert.equal(lastCall(store, "searchTemplates")?.[1], 20);
    await run(tools, "redteam_poc_search", { q: "x", templateLimit: 999 });
    assert.equal(lastCall(store, "searchTemplates")?.[1], 100);
  });

  it("by_category 过滤掉 n=0 的类别（不显示空类别）", async () => {
    const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_search", {});
    const kb = out["knowledge_base"] as Record<string, unknown>;
    const cats = kb["by_category"] as string[];
    assert.equal(cats.length, 1, "sqli 的 n=0 应被过滤");
    assert.match(cats[0] ?? "", /rce 6（已验证 3）/);
  });

  it("命中时 hint 指向 poc_get 与 nuclei -t", async () => {
    const store = mkStore({ searchPocs: () => [{ id: 1, code: "c", title: "t", kind: "poc", category: "rce", cve: null, component: null, versions: null, language: "python", source: "web", source_url: null, verified: 1, verified_note: null, hit_count: 0, engagement_id: null, engagement_name: null, asset_target: null, found_by_agent: null, created_at: "t", tags: null, usage: null, path: "/pocs/c.py", has_content: 1 }] });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_search", {});
    assert.match(String(out["hint"]), /redteam_poc_get/);
    assert.match(String(out["hint"]), /nuclei -t/);
  });

  it("未命中时 hint 指向互联网搜索与回填", async () => {
    const store = mkStore({ searchTemplates: () => ({ dir: null, total: 0, items: [] }) });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_search", { q: "nothing" });
    assert.match(String(out["hint"]), /去互联网搜索/);
    assert.match(String(out["hint"]), /redteam_poc_add 回填/);
  });

  it("verified===1 映射成 true", async () => {
    const store = mkStore({ searchPocs: () => [{ id: 1, code: "c", title: "t", kind: "poc", category: null, cve: null, component: null, versions: null, language: null, source: null, source_url: null, verified: 1, verified_note: null, hit_count: 0, engagement_id: null, engagement_name: null, asset_target: null, found_by_agent: null, created_at: "t", tags: null, usage: null, path: null, has_content: 0 }] });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_search", {});
    assert.equal(((out["items"] as Record<string, unknown>[])[0]?.["verified"]), true);
  });
});

describe("redteam_poc_get", () => {
  it("有结果时展开内容", async () => {
    const store = mkStore({ getPoc: () => ({ id: 1, code: "c", content: "print(1)" }) });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_get", { id: 1 });
    assert.equal(out["ok"], true);
    assert.equal(out["content"], "print(1)");
  });

  it("无结果时提示先检索", async () => {
    const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_get", { code: "nope" });
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /先用 redteam_poc_search/);
  });

  it("id 与 code 都传时优先 id", async () => {
    let seen: unknown;
    const store = mkStore({ getPoc: (k) => { seen = k; return { id: 1 }; } });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_get", { id: 5, code: "c" });
    assert.equal(seen, 5);
  });

  it("只传 code 时用 code", async () => {
    let seen: unknown;
    const store = mkStore({ getPoc: (k) => { seen = k; return { id: 1 }; } });
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_get", { code: "cve-2023-1" });
    assert.equal(seen, "cve-2023-1");
  });
});

describe("redteam_poc_list / update / use", () => {
  it("list 返回精简字段与统计", async () => {
    const tools = knowledgeTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_list", {});
    assert.deepEqual(out["stats"], { total: 12, verified: 5, by_kind: { poc: 8 }, by_source: { web: 9 } });
  });

  it("update 的 patch 与便捷字段合并（便捷字段优先）", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_update", {
      code: "c", patch: { versions: "5.0-5.2", verified: false }, verified: true, verified_note: "实测成功",
    });
    const patch = lastCall(store, "updatePoc")?.[1] as Record<string, unknown>;
    assert.equal(patch["versions"], "5.0-5.2");
    assert.equal(patch["verified"], true, "便捷字段应覆盖 patch 里的值");
    assert.equal(patch["verified_note"], "实测成功");
  });

  it("update 不传便捷字段时不覆盖 patch", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_poc_update", { code: "c", patch: { verified: false } });
    assert.equal((lastCall(store, "updatePoc")?.[1] as Record<string, unknown>)["verified"], false);
  });

  it("use 记一次复用", async () => {
    const store = mkStore();
    const tools = knowledgeTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_poc_use", { code: "c", used_on: "甲公" });
    assert.equal(out["hit_count"], 3);
    assert.equal(lastCall(store, "markPocUsed")?.[1], "甲公");
  });
});
