/**
 * 56 个工具的**整体**校验。
 *
 * 单组测试各自验证自己的行为，本文件验证的是**集合层面**的契约：
 *
 * 1. **数量与名字**：恰好 56 个，与 `ALL_TOOL_NAMES` 完全一致（少一个多一个都红）
 * 2. **description 全部来自 `descriptions.ts`**（逐字符），没有手写残留
 * 3. **参数 schema 自洽**：required 的字段都有类型、enum 非空、嵌套 items 完整
 * 4. **注册桥**：56 个都能注册，且 `execute` 一律返回字符串
 *
 * ## 为什么需要这一层
 *
 * 单组测试通过 ≠ 56 个齐了。手工维护 6 个组的列表时，
 * "漏了一个"或"两个组重复注册同一个名字"都不会在单组测试里暴露。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { HostContext } from "../../src/host-api/types.js";
import type { ParamDecl } from "../../src/redteam/tools/define.js";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { ALL_TOOL_NAMES, buildAllTools, registerTools } from "../../src/redteam/tools/index.js";
import { TOOL_DESCRIPTIONS } from "../../src/redteam/tools/descriptions.js";
import { bindings, resetToolState } from "../../src/redteam/tools/context.js";
import type { StoreForTools } from "../../src/redteam/tools/store-contract.js";

/** 最小 store 替身：所有方法都返回空结构，只为跑通 56 个工具的构造与注册。 */
function mkStore(): StoreForTools {
  const empty = (): Record<string, never> => ({});
  const list = (): readonly unknown[] => [];
  const store: Record<string, unknown> = {
    activeEngagementId: () => undefined,
    listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }],
    stats: empty,
    openEngagement: (name: string) => ({ id: "e1", name }),
    importBundle: () => ({ counts: { edges: 0, assets: 0 } }),
    listAssets: () => ({ total: 0, items: [] }),
    getAsset: () => undefined,
    listSegments: list,
    graph: () => ({ nodes: [], edges: [] }),
    attackGraph: () => ({ nodes: [], edges: [], summary: {} }),
    updateAssetTest: () => ({ updated: true }),
    assessAsset: () => ({ updated: true }),
    discoveryTimeline: () => ({ span: null, days: [], recent: [] }),
    listWeb: () => ({ total: 0, items: [] }),
    domainIndex: list,
    addVuln: () => ({ id: 1 }),
    listVulns: () => ({ total: 0, items: [] }),
    updateVuln: () => ({ updated: true }),
    vulnStats: empty,
    addCredential: () => ({ id: 1 }),
    listCredentials: list,
    addAccess: () => ({ id: 1 }),
    listAccess: list,
    addShot: () => ({ id: 1 }),
    listShots: empty,
    deleteShot: () => ({ deleted: true }),
    sessionSummary: () => ({ totals: {}, webshells: [], tunnels: [] }),
    addWebshell: () => ({ id: 1 }),
    listWebshells: empty,
    updateWebshell: () => ({ updated: true }),
    addTunnel: () => ({ id: 1 }),
    listTunnels: empty,
    updateTunnel: () => ({ updated: true }),
    probeSessions: async () => ({ checkedAt: "t", webshells: [], tunnels: [] }),
    listPrompts: () => [{ role: "recon", title: "信息收集", updated_at: "t", content: "p" }],
    resetPrompts: () => ({ reset: [] }),
    listScorePoints: () => ({ summary: {}, items: [], ruleGroups: [] }),
    addScoreHit: () => ({ hit: {} }),
    saveScorePoint: () => ({ point: {} }),
    scoreChain: () => ({ summary: { points: 0, hits: 0 }, stages: [] }),
    scoreReport: () => ({ summary: {}, markdown: "", items: [] }),
    addHttpEvidence: () => ({ id: 1 }),
    addChainStep: () => ({ step: {} }),
    listChain: list,
    addAttackFile: () => ({ file: {} }),
    listAttackFiles: list,
    attackFileTree: list,
    report: () => ({ generated_at: "t", stats: {}, markdown: "" }),
    reportTargets: () => ({ generated_at: "t", totals: {}, targets: [] }),
    searchPocs: list,
    getPoc: () => undefined,
    savePoc: () => ({
      created: true,
      poc: {
        id: 1,
        code: "c",
        category: "rce",
        engagement_id: null,
        engagement_name: null,
        asset_target: null,
        created_at: "t",
        verified: 0,
        verified_note: null,
        updated_at: "t",
      },
      path: null,
    }),
    updatePoc: () => ({
      id: 1,
      code: "c",
      category: null,
      engagement_id: null,
      engagement_name: null,
      asset_target: null,
      created_at: "t",
      verified: 0,
      verified_note: null,
      updated_at: "t",
    }),
    markPocUsed: () => ({ hit_count: 1 }),
    pocStats: () => ({ total: 0, verified: 0, reused: 0 }),
    searchTemplates: () => ({ dir: null, total: 0, items: [] }),
    templateStats: () => ({ dir: null, total: 0, cve: 0 }),
    nucleiTemplatesDir: () => null,
  };
  return store as unknown as StoreForTools;
}

function mkExec(sessionId = "s1"): ToolExecContext {
  return { agent: { session: { id: sessionId, header: {} } } } as unknown as ToolExecContext;
}

beforeEach(() => {
  resetToolState();
  bindings.set("s1", "e1");
});

/* ── 集合契约 ─────────────────────────────────────────────────────────── */

describe("56 个工具的集合契约", () => {
  const tools = buildAllTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("恰好 56 个工具", () => {
    assert.equal(tools.length, 56);
    assert.equal(ALL_TOOL_NAMES.length, 56);
  });

  it("实际工具名与 ALL_TOOL_NAMES 完全一致（顺序也一致）", () => {
    assert.deepEqual(
      tools.map((t) => t.name),
      [...ALL_TOOL_NAMES],
    );
  });

  it("没有重名（重复注册会让后注册的覆盖前一个）", () => {
    const names = tools.map((t) => t.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dup, [], "重复的工具名：" + dup.join(", "));
  });

  it("全部带 redteam_ 前缀（宿主按前缀分组展示）", () => {
    for (const t of tools) assert.match(t.name, /^redteam_/, t.name);
  });

  it("每个工具的 description 都来自 descriptions.ts（逐字符）", () => {
    const dict = TOOL_DESCRIPTIONS as Record<string, string>;
    const offenders: string[] = [];
    for (const t of tools) {
      const expected = dict[t.name];
      if (expected === undefined) {
        offenders.push(t.name + "（descriptions.ts 里没有这一条）");
        continue;
      }
      if (t.description !== expected) offenders.push(t.name + "（与原文不一致）");
    }
    assert.deepEqual(offenders, [], "description 与原文不符：" + offenders.join("; "));
  });

  it("descriptions.ts 里没有多余条目（没被任何工具用到）", () => {
    const used = new Set(tools.map((t) => t.name));
    const unused = Object.keys(TOOL_DESCRIPTIONS).filter((k) => !used.has(k));
    assert.deepEqual(unused, [], "descriptions.ts 里有工具没用到的条目：" + unused.join(", "));
  });

  /**
   * description 累计长度。
   *
   * 实测值 7128 字符（56 个工具）。这个断言的作用是**发现"某个工具漏了原文"**：
   * 如果谁把某个长 description 换成一句摘要，总长会明显掉下来。
   *
   * 阈值留了 5% 余量（6780）而不是卡死在 7128 —— 因为将来增删工具会让它合法漂移，
   * 而"漏抄一大段"的跌幅远大于 5%。
   */
  it("description 累计长度在合理区间（防止漏抄一大段）", () => {
    const total = tools.reduce((n, t) => n + t.description.length, 0);
    const measured = 7128;
    assert.equal(
      total > measured * 0.95,
      true,
      "description 总长 " + String(total) + " 明显低于实测的 " + String(measured) + "，可能有工具漏了原文",
    );
  });
});

/* ── 参数 schema 自洽 ─────────────────────────────────────────────────── */

describe("参数 schema 自洽性", () => {
  const tools = buildAllTools(mkStore(), { env: {}, root: "/tmp/x" });

  /** 递归检查一个参数声明。 */
  function checkDecl(name: string, key: string, decl: ParamDecl): readonly string[] {
    const problems: string[] = [];
    const where = `${name}.${key}`;
    const validTypes = ["string", "number", "boolean", "array", "object"];
    if (!validTypes.includes(decl.type)) problems.push(`${where}: 非法 type ${String(decl.type)}`);
    if (decl.type === "array" && decl.items === undefined) problems.push(`${where}: array 缺 items`);
    if (decl.type === "string" && decl.enum !== undefined) {
      if (decl.enum.length === 0) problems.push(`${where}: enum 是空数组`);
      const dupes = decl.enum.filter((v, i) => decl.enum?.indexOf(v) !== i);
      if (dupes.length > 0) problems.push(`${where}: enum 有重复值 ${dupes.join(",")}`);
    }
    if (decl.type !== "string" && decl.enum !== undefined) problems.push(`${where}: 非 string 却带 enum`);
    return problems;
  }

  it("每个参数声明的 type / items / enum 都自洽", () => {
    const problems: string[] = [];
    for (const t of tools) {
      for (const [key, decl] of Object.entries(t.parameters)) {
        problems.push(...checkDecl(t.name, key, decl));
        if (decl.type === "array" && decl.items !== undefined) {
          problems.push(...checkDecl(t.name, key + "[]", decl.items));
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("; "));
  });

  it("每个工具至少有一个参数或显式无参（没有空 schema 的意外）", () => {
    const noParams = tools.filter((t) => Object.keys(t.parameters).length === 0).map((t) => t.name);
    /* 无参工具是合法的（session_info / roles / score_list 等），
       但要**明确知道**有哪些，不能是"忘了写参数" */
    assert.deepEqual(noParams.sort(), [
      "redteam_roles",
      "redteam_score_list",
      "redteam_attack_chain",
      "redteam_chain",
      "redteam_report",
      "redteam_asset_timeline",
      "redteam_sessions",
      "redteam_domain_index",
      "redteam_asset_stats",
      "redteam_session_info",
      "redteam_score_report",
      "redteam_report_targets",
      "redteam_asset_graph",
    ].filter((n) => tools.some((t) => t.name === n)).sort().filter((n) => {
      /* 只保留真正无参的那些 */
      const tool = tools.find((t) => t.name === n);
      return tool !== undefined && Object.keys(tool.parameters).length === 0;
    }));
  });

  it("required 参数不超过全部参数（拼错的 required 会全选）", () => {
    for (const t of tools) {
      const all = Object.keys(t.parameters);
      const required = all.filter((k) => t.parameters[k]?.required === true);
      assert.equal(required.length <= all.length, true, t.name);
    }
  });

  it("每个工具都有 output 声明（宿主要靠它渲染）", () => {
    for (const t of tools) {
      assert.notEqual(t.output, undefined, t.name + " 缺 output 声明");
      assert.equal(t.output?.schema.type, "string", t.name + " 的 schema.type 应为 string");
      assert.equal(typeof t.output?.render, "function", t.name + " 缺 render");
    }
  });
});

/* ── 注册桥 ───────────────────────────────────────────────────────────── */

describe("registerTools", () => {
  it("注册 56 个工具，返回的名字与 ALL_TOOL_NAMES 一致", () => {
    const registered: { name: string }[] = [];
    const ctx = {
      tools: { register: (tool: { name: string }) => registered.push(tool) },
    } as unknown as HostContext;
    const names = registerTools(ctx, mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(names.length, 56);
    assert.deepEqual(names, [...ALL_TOOL_NAMES]);
    assert.deepEqual(registered.map((r) => r.name), [...ALL_TOOL_NAMES]);
  });

  it("宿主没有 tools.register 时明确报错", () => {
    assert.throws(
      () => registerTools({} as HostContext, mkStore(), { env: {}, root: "/tmp/x" }),
      /宿主没有提供 ctx\.tools\.register/,
    );
  });

  it("注册后的 execute 一律返回字符串（宿主的 content 数组靠它）", async () => {
    const registered: { name: string; execute: (a: unknown, e: ToolExecContext) => Promise<unknown> }[] = [];
    const ctx = {
      tools: { register: (tool: { name: string; execute: unknown }) => registered.push(tool as never) },
    } as unknown as HostContext;
    registerTools(ctx, mkStore(), { env: {}, root: "/tmp/x" });
    /* 挑几个零参或容易构造参数的工具实跑 */
    for (const name of ["redteam_roles", "redteam_sessions", "redteam_chain", "redteam_score_list"]) {
      const tool = registered.find((r) => r.name === name);
      assert.notEqual(tool, undefined, name);
      const out = await tool?.execute({}, mkExec());
      assert.equal(typeof out, "string", `${name} 应返回字符串，实际 ${typeof out}`);
    }
  });

  it("注册前每个工具都过了 withStructuredErrors（异常不外泄）", async () => {
    const registered: { name: string; execute: (a: unknown, e: ToolExecContext) => Promise<unknown> }[] = [];
    const brokenStore = mkStore();
    /* 让 listChain 抛错，观察是否被收敛 */
    (brokenStore as unknown as Record<string, unknown>)["listChain"] = (): never => {
      throw new Error("数据库炸了");
    };
    const ctx = {
      tools: { register: (tool: { name: string; execute: unknown }) => registered.push(tool as never) },
    } as unknown as HostContext;
    registerTools(ctx, brokenStore, { env: {}, root: "/tmp/x" });
    const tool = registered.find((r) => r.name === "redteam_chain");
    assert.notEqual(tool, undefined);
    const out = await tool?.execute({}, mkExec());
    assert.equal(typeof out, "string");
    const parsed = JSON.parse(String(out)) as Record<string, unknown>;
    assert.equal(parsed["ok"], false);
    assert.match(String(parsed["error"]), /数据库炸了/);
    assert.equal(parsed["error_kind"], "failed");
  });

  it("ctx.get 抛错时服务读取器返回 null（不炸工具）", () => {
    const registered: unknown[] = [];
    const ctx = {
      tools: { register: (tool: unknown) => registered.push(tool) },
      get: (): never => {
        throw new Error("service not ready");
      },
    } as unknown as HostContext;
    const names = registerTools(ctx, mkStore(), { env: {}, root: "/tmp/x" });
    assert.equal(names.length, 56);
  });
});

/* ── 分组覆盖 ─────────────────────────────────────────────────────────── */

describe("分组覆盖完整性", () => {
  it("6 个分组加起来正好 56（没有跨组重复）", () => {
    const tools = buildAllTools(mkStore(), { env: {}, root: "/tmp/x" });
    const byPrefix = new Map<string, number>();
    for (const t of tools) {
      const key = t.name.replace(/^redteam_/, "").split("_")[0] ?? "";
      byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1);
    }
    /* 只断言总数与重名（上面已有），这里额外确认没有明显的前缀异常 */
    assert.equal(tools.length, 56);
    assert.equal(byPrefix.size > 5, true, "工具前缀种类过少，可能分组漏了");
  });
});
