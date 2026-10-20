/**
 * 得分 / 证据 / 报告 组（12 个工具）的测试。
 *
 * ## 本组的核心边界：**不复制计分逻辑**
 *
 * 封顶、去重、多档、服务口径全部在 `store/score.ts`。工具层只做参数整形。
 * 所以这里不测"分数怎么算"（那是 store 的测试职责），而是测：
 *
 * 1. **参数正确送达 store**（多档的 `points`、`self_created`、`stage_code` 等）
 * 2. **不传的字段不出现**（避免被 store 当成"显式清空"）
 * 3. **返回字段映射对**（`hits.length > 0` → `achieved`，`service_summary` → `capped_summary`）
 * 4. **`chain_add` 的提示逻辑**（缺 tool/result 时提醒，score_hint 带上）
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { CHAIN_STAGE_ENUM, SCORE_TOOL_NAMES, STAGE_CODE_ENUM, scoreTools } from "../../src/redteam/tools/score-tools.js";
import { TOOL_DESCRIPTIONS } from "../../src/redteam/tools/descriptions.js";
import { bindings, resetToolState } from "../../src/redteam/tools/context.js";
import type { StoreForTools } from "../../src/redteam/tools/store-contract.js";

interface Recorder { readonly calls: { readonly method: string; readonly args: readonly unknown[] }[]; }

function mkStore(overrides: Partial<StoreForTools> = {}): StoreForTools & Recorder {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec = (method: string, ret: unknown) => (...args: unknown[]): unknown => { calls.push({ method, args }); return ret; };
  const base: Record<string, unknown> = {
    activeEngagementId: (): string | undefined => undefined,
    listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }],
    listScorePoints: rec("listScorePoints", { summary: { points: 0 }, items: [], ruleGroups: [] }),
    addScoreHit: rec("addScoreHit", { hit: { id: 1 }, warning: null }),
    saveScorePoint: rec("saveScorePoint", { point: { id: 1 } }),
    scoreReport: rec("scoreReport", { summary: {}, markdown: "# 报告", items: [] }),
    scoreChain: rec("scoreChain", { summary: { points: 0, hits: 0 }, stages: [] }),
    addHttpEvidence: rec("addHttpEvidence", { id: 1 }),
    addChainStep: rec("addChainStep", { step: { id: 1 } }),
    listChain: rec("listChain", []),
    addAttackFile: rec("addAttackFile", { file: { id: 1 } }),
    listAttackFiles: rec("listAttackFiles", []),
    attackFileTree: rec("attackFileTree", []),
    report: rec("report", { generated_at: "t", stats: {}, markdown: "# 报告" }),
    reportTargets: rec("reportTargets", { generated_at: "t", totals: {}, targets: [] }),
  };
  return Object.assign({ ...base, ...overrides }, { calls }) as unknown as StoreForTools & Recorder;
}

function mkExec(sessionId = "s1"): ToolExecContext {
  return { agent: { session: { id: sessionId, header: {} } } } as unknown as ToolExecContext;
}

function toolNamed(tools: ReturnType<typeof scoreTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  assert.notEqual(found, undefined, `找不到 ${name}`);
  return found as ReturnType<typeof scoreTools>[number];
}

async function run(tools: ReturnType<typeof scoreTools>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await (toolNamed(tools, name).execute as (a: unknown, e: ToolExecContext) => Promise<string>)(args, mkExec());
  return JSON.parse(out) as Record<string, unknown>;
}

function lastCall(store: StoreForTools & Recorder, method: string): readonly unknown[] | undefined {
  const hits = store.calls.filter((c) => c.method === method);
  return hits.length === 0 ? undefined : hits[hits.length - 1]?.args;
}

beforeEach(() => { resetToolState(); bindings.set("s1", "e1"); });

describe("得分组工具集合", () => {
  const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("12 个工具，名字与顺序稳定", () => {
    assert.deepEqual(tools.map((t) => t.name), [...SCORE_TOOL_NAMES]);
  });

  it("description 全部来自 descriptions.ts", () => {
    const dict = TOOL_DESCRIPTIONS as Record<string, string>;
    for (const t of tools) assert.equal(t.description, dict[t.name], t.name);
  });

  it("score_hit 的 description 保留三条红线（1124 字原文）", () => {
    const d = toolNamed(tools, "redteam_score_hit").description;
    assert.match(d, /红线一：账号类得分必须先实测能登录/);
    assert.match(d, /红线二：自己注册的账号不算得分权限/);
    assert.match(d, /红线三：注意该条的计分口径/);
    assert.equal(d.length > 1000, true, "原文 1124 字，实际=" + String(d.length));
  });

  it("stage_code 枚举只有 5 个合法值", () => {
    assert.deepEqual([...STAGE_CODE_ENUM], ["recon", "internet", "boundary", "internal", "target"]);
    assert.deepEqual(toolNamed(tools, "redteam_chain_add").parameters["stage_code"]?.enum, [...STAGE_CODE_ENUM]);
  });

  it("chain_add 的 stage（兼容字段）枚举是另一组 7 个值", () => {
    assert.deepEqual([...CHAIN_STAGE_ENUM], ["recon", "vuln", "exploit", "access", "pivot", "data", "other"]);
    assert.deepEqual(toolNamed(tools, "redteam_chain_add").parameters["stage"]?.enum, [...CHAIN_STAGE_ENUM]);
  });
});

describe("redteam_score_list", () => {
  it("把 hits.length>0 映射成 achieved", async () => {
    const store = mkStore({
      listScorePoints: () => ({
        summary: { points: 50 },
        items: [
          { id: 1, code: "rce", name: "RCE", category: "服务器权限", points: 50, tier: "main", cap: 600, cap_used: 50, dedup_scope: "system", scope_label: "同一系统", enabled: true, counted: 1, earned: 50, capped: 0, service_summary: "", hits: [{ target: "10.0.0.5", evidence: "uid=0" }] },
          { id: 2, code: "db", name: "数据库", category: "数据库", points: 30, tier: "main", cap: 200, cap_used: 0, dedup_scope: "service", scope_label: "同一服务", enabled: true, counted: 0, earned: 0, capped: 0, service_summary: "同服务已有更高档", hits: [] },
        ],
        ruleGroups: [],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_list", {});
    const items = out["items"] as Record<string, unknown>[];
    assert.equal(items[0]?.["achieved"], true);
    assert.equal(items[1]?.["achieved"], false);
    assert.deepEqual(items[0]?.["evidence"], ["10.0.0.5：uid=0"]);
  });

  it("evidence 最多取 3 条（不把整库塞进上下文）", async () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({ target: "t" + String(i), evidence: "e" + String(i) }));
    const store = mkStore({
      listScorePoints: () => ({
        summary: {},
        items: [{ id: 1, code: "c", name: "n", category: "cat", points: 1, tier: "t", cap: 10, cap_used: 0, dedup_scope: "s", scope_label: "l", enabled: true, counted: 0, earned: 0, capped: 0, service_summary: "", hits }],
        ruleGroups: [],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_list", {});
    assert.equal(((out["items"] as Record<string, unknown>[])[0]?.["evidence"] as unknown[]).length, 3);
  });

  it("service_summary 映射到 capped_summary（不是 capped_reason）", async () => {
    const store = mkStore({
      listScorePoints: () => ({
        summary: {},
        items: [{ id: 1, code: "c", name: "n", category: "cat", points: 1, tier: "t", cap: 10, cap_used: 0, dedup_scope: "s", scope_label: "l", enabled: true, counted: 0, earned: 0, capped: 2, service_summary: "整段说明", hits: [] }],
        ruleGroups: [],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_list", {});
    const item = (out["items"] as Record<string, unknown>[])[0];
    assert.equal(item?.["capped_summary"], "整段说明");
    assert.equal("capped_reason" in (item ?? {}), false, "capped_reason 属于 hits[]，不在条目级");
  });

  it("groups 来自 ruleGroups", async () => {
    const store = mkStore({
      listScorePoints: () => ({ summary: {}, items: [], ruleGroups: [{ name: "获取权限", tiers: [1, 2], points: 100, capSum: 500 }] }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_list", {});
    assert.deepEqual(out["groups"], [{ category: "获取权限", items: 2, points: 100, cap_sum: 500 }]);
  });
});

describe("redteam_score_hit", () => {
  it("多档 points 与 self_created 原样透传", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_score_hit", { code: "terminal", points: 50, evidence: "管理员", self_created: false, target: "10.0.0.5:443" });
    const payload = lastCall(store, "addScoreHit")?.[1] as Record<string, unknown>;
    assert.equal(payload["points"], 50, "多档条目必须显式传档位分值");
    assert.equal(payload["self_created"], false);
    assert.equal(payload["target"], "10.0.0.5:443");
    assert.equal("engagement" in payload, false);
  });

  it("evidence 是必填", () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(toolNamed(tools, "redteam_score_hit").parameters["evidence"]?.required, true);
  });

  it("不传 points 时该键不出现（让 store 用主档默认值）", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_score_hit", { code: "c", evidence: "e" });
    assert.equal("points" in ((lastCall(store, "addScoreHit")?.[1] as Record<string, unknown>) ?? {}), false);
  });

  it("warning（已达上限/被顶掉）原样返回给模型当停止信号", async () => {
    const store = mkStore({ addScoreHit: () => ({ hit: { id: 1 }, warning: "已达上限，不再累计" }) });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_hit", { code: "c", evidence: "e" });
    assert.equal(out["warning"], "已达上限，不再累计");
  });
});

describe("redteam_score_report", () => {
  it("markdown 默认返回全文", async () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_report", {});
    assert.equal(out["markdown"], "# 报告");
  });

  it("markdown:false 时只返回条目摘要（不返回全文）", async () => {
    const store = mkStore({
      scoreReport: () => ({
        summary: { points: 100 },
        markdown: "# 长全文",
        items: [{ seq: 1, point_name: "RCE", points: 50, counted: true, target: "t", gained: "root", requests: [1, 2], missing_evidence: null }],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_score_report", { markdown: false });
    assert.equal("markdown" in out, false, "摘要模式不该带全文");
    assert.equal(((out["items"] as Record<string, unknown>[])[0]?.["requests"]), 2, "requests 是数量不是数组");
  });

  it("limit 透传", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_score_report", { limit: 10 });
    assert.equal((lastCall(store, "scoreReport")?.[1] as Record<string, unknown>)["limit"], 10);
  });
});

describe("redteam_attack_chain", () => {
  it("totals 里 serviceCappedHits 缺省补 0", async () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_chain", {});
    assert.equal((out["totals"] as Record<string, unknown>)["serviceCappedHits"], 0);
  });

  it("阶段字段映射（含 assets 内外网标注与 tunnels 可达）", async () => {
    const store = mkStore({
      scoreChain: () => ({
        summary: { points: 100, hits: 2, serviceCappedHits: 1 },
        stages: [{
          code: "boundary", name: "边界突破", goal: "搭隧道", points: 50, cumulative: 150, counted: 1, hits: 1, steps: 3, tools: 2,
          sections: [{ label: "手法", items: ["suo5", "frp"] }],
          items: [{ point_name: "隧道", points: 50, counted: true, target: "t", service: "s", capped: false, capped_reason: null }],
          assets: [{ ip: "10.0.0.5", scope: "internal", points: 50 }],
          tunnels: [{ kind: "suo5", listen: "127.0.0.1:1080", status: "active", reach: "10.0.0.0/8" }],
        }],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_chain", {});
    const st = (out["stages"] as Record<string, unknown>[])[0];
    assert.deepEqual(st?.["methods"], ["手法：suo5、frp"]);
    assert.deepEqual(st?.["assets"], ["10.0.0.5(内网) 贡献50分"]);
    assert.deepEqual(st?.["tunnels"], ["suo5 127.0.0.1:1080 [active] 可达 10.0.0.0/8"]);
  });

  it("tunnels 的 reach 为空时显示 —", async () => {
    const store = mkStore({
      scoreChain: () => ({
        summary: { points: 0, hits: 0 },
        stages: [{ code: "boundary", name: "b", goal: "g", points: 0, cumulative: 0, counted: 0, hits: 0, steps: 0, tools: 0, items: [], tunnels: [{ kind: "frp", listen: "l", status: "down" }] }],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_chain", {});
    const st = (out["stages"] as Record<string, unknown>[])[0];
    assert.deepEqual(st?.["tunnels"], ["frp l [down] 可达 —"]);
  });
});

describe("redteam_chain_add", () => {
  it("缺 tool 时提示补命令", async () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_chain_add", { stage: "recon", title: "扫端口" });
    const hints = out["hints"] as string[];
    assert.equal(hints.some((h) => h.includes("没写 `tool`")), true);
  });

  it("缺 result 时提示补回显", async () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_chain_add", { stage: "recon", title: "扫端口", tool: "nmap -sV x" });
    const hints = out["hints"] as string[];
    assert.equal(hints.some((h) => h.includes("没写 `result`")), true);
  });

  it("tool 与 result 都写了时不给这两条提示", async () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_chain_add", { stage: "recon", title: "t", tool: "nmap", result: "22 open" });
    assert.equal(out["hints"], undefined, "无需提醒时 hints 应为 undefined 而不是空数组");
  });

  it("store 的 score_hint 会并进 hints", async () => {
    const store = mkStore({ addChainStep: () => ({ step: { id: 1 }, score_hint: "已记 50 分" }) });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_chain_add", { stage: "exploit", title: "t", tool: "x", result: "y" });
    assert.deepEqual(out["hints"], ["已记 50 分"]);
  });

  it("agent 与 recorded_by 的默认关系", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_chain_add", { stage: "recon", title: "t", agent: "recon" });
    const payload = lastCall(store, "addChainStep")?.[1] as Record<string, unknown>;
    assert.equal(payload["agent"], "recon");
    assert.equal(payload["recorded_by"], "recon", "recorded_by 缺省取 agent");
  });

  it("显式 recorded_by 优先", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    await run(tools, "redteam_chain_add", { stage: "recon", title: "t", agent: "recon", recorded_by: "custom" });
    assert.equal((lastCall(store, "addChainStep")?.[1] as Record<string, unknown>)["recorded_by"], "custom");
  });
});

describe("redteam_attack_file_list", () => {
  it("给 target 时列该目标文件", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_file_list", { target: "10.0.0.5" });
    assert.notEqual(out["items"], undefined);
    assert.equal("folders" in out, false);
  });

  it("不给 target 时列目录树", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_file_list", {});
    assert.notEqual(out["folders"], undefined);
    assert.equal("items" in out, false);
  });

  it("空字符串 target 等同未给（列目录树）", async () => {
    const store = mkStore();
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_attack_file_list", { target: "" });
    assert.notEqual(out["folders"], undefined);
  });
});

describe("redteam_report_targets / report", () => {
  it("report_targets 按 key 或 label 过滤", async () => {
    const store = mkStore({
      reportTargets: () => ({
        generated_at: "t",
        totals: { targets: 2 },
        targets: [
          { key: "10.0.0.5", label: "web", segment: "10.0.0.0/24", stats: {} },
          { key: "10.0.0.6", label: "db", segment: "10.0.0.0/24", stats: {} },
        ],
      }),
    });
    const tools = scoreTools(store, { env: {}, root: "/tmp/x" });
    assert.equal(((await run(tools, "redteam_report_targets", { target: "10.0.0.5" }))["targets"] as unknown[]).length, 1);
    assert.equal(((await run(tools, "redteam_report_targets", { target: "db" }))["targets"] as unknown[]).length, 1);
    assert.equal(((await run(tools, "redteam_report_targets", {}))["targets"] as unknown[]).length, 2);
  });

  it("report 返回 markdown 与 stats", async () => {
    const tools = scoreTools(mkStore(), { env: {}, root: "/tmp/x" });
    const out = await run(tools, "redteam_report", {});
    assert.equal(out["markdown"], "# 报告");
    assert.notEqual(out["stats"], undefined);
  });
});
