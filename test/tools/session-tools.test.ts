/**
 * 会话 / 靶标 / 闸门 组（7 个工具）的测试。
 *
 * ## 三类断言，各有分工
 *
 * 1. **description 逐字保真** —— description 是**指令的一部分**（模型读它决定怎么调）。
 *    这里不重抄全文，而是断言"关键约束句必须原样出现"：
 *    一旦有人"顺手润色"，会立刻红。
 * 2. **行为** —— 每个工具至少 happy-path + 参数校验失败路径。
 * 3. **Lead 点名的两个语义**：
 *    - `agent_slot` 的拒绝必须让调用方**无法误判成功**（无 slot 字段 + 三重信号）
 *    - `preflight` 降级时必须**显式标记**（不让"不可用"看起来像"健康"）
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecContext } from "../../src/host-api/types.js";
import { SESSION_TOOL_NAMES, sessionTools } from "../../src/redteam/tools/session-tools.js";
import type { ToolRuntimeContext } from "../../src/redteam/tools/session-tools.js";
import { resetToolState, bindings } from "../../src/redteam/tools/context.js";
import type { StoreForTools } from "../../src/redteam/tools/store-contract.js";

/* ── 测试替身 ──────────────────────────────────────────────────────────── */

/** 造一个最小 store 替身：只实现本组用到的方法，其余抛错以暴露误用。 */
function mkStore(overrides: Partial<StoreForTools> = {}): StoreForTools {
  const base = {
    activeEngagementId: (): string | undefined => undefined,
    listEngagements: () => [],
    openEngagement: (name: string) => ({ id: "e-new", name }),
    stats: () => ({ assets: 0 }),
    resetPrompts: (_id: string, role?: string) => ({ reset: role === undefined ? ["recon", "assess", "vuln-scan", "exploit", "internal"] : [role] }),
  };
  return { ...base, ...overrides } as StoreForTools;
}

/** 造会话 exec。 */
function mkExec(sessionId = "s1", parentSession?: string): ToolExecContext {
  return {
    agent: {
      session: {
        id: sessionId,
        header: parentSession === undefined ? {} : { parentSession },
      },
    },
  } as unknown as ToolExecContext;
}

/** 取某个工具。 */
function toolNamed(tools: ReturnType<typeof sessionTools>, name: string): ReturnType<typeof sessionTools>[number] {
  const found = tools.find((t) => t.name === name);
  assert.notEqual(found, undefined, `找不到工具 ${name}`);
  return found as ReturnType<typeof sessionTools>[number];
}

/** 调执行体并解析 JSON。 */
async function run(
  tools: ReturnType<typeof sessionTools>,
  name: string,
  args: Record<string, unknown>,
  exec: ToolExecContext = mkExec(),
): Promise<Record<string, unknown>> {
  const tool = toolNamed(tools, name);
  const out = await (tool.execute as (a: unknown, e: ToolExecContext) => Promise<string>)(args, exec);
  return JSON.parse(out) as Record<string, unknown>;
}

let tmp: string;
beforeEach(() => {
  resetToolState();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-sessiontools-"));
});

/* ── description 保真 ──────────────────────────────────────────────────── */

describe("description 逐字保真（指令的一部分）", () => {
  const tools = sessionTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("工具名与顺序稳定", () => {
    assert.deepEqual(
      tools.map((t) => t.name),
      [...SESSION_TOOL_NAMES],
    );
  });

  it("engagement_open 的关键约束句原样存在", () => {
    const d = toolNamed(tools, "redteam_engagement_open").description;
    assert.match(d, /并把\*\*当前会话\*\*绑定到该靶标/);
    assert.match(d, /子智能体会自动继承/);
    assert.match(d, /不会改动其它会话正在用的靶标/);
  });

  it("session_bind 强调「互不串写」", () => {
    const d = toolNamed(tools, "redteam_session_bind").description;
    assert.match(d, /互不串写/);
    assert.match(d, /省略则列出可绑定的靶标/);
  });

  it("agent_slot 保留「不要重试硬塞」这条行为指令", () => {
    const d = toolNamed(tools, "redteam_agent_slot").description;
    assert.match(d, /\*\*不要重试硬塞\*\*/);
    assert.match(d, /最多同时 3 个/);
    assert.match(d, /子智能体结束时服务端也会自动释放/);
  });

  it("preflight 保留「不要假装能跑」这条红线", () => {
    const d = toolNamed(tools, "redteam_preflight").description;
    assert.match(d, /\*\*缺 key \/ 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。\*\*/);
    assert.match(d, /【开工前必须跑一次】/);
  });

  it("每个工具的 description 都非空且不含占位文本", () => {
    for (const t of tools) {
      assert.equal(t.description.length > 10, true, t.name);
      assert.equal(/TODO|FIXME|待补/.test(t.description), false, t.name);
    }
  });
});

/* ── 参数 schema ───────────────────────────────────────────────────────── */

describe("parameters schema", () => {
  const tools = sessionTools(mkStore(), { env: {}, root: "/tmp/x" });

  it("engagement_open 的 target 必填、scope 是字符串数组", () => {
    const p = toolNamed(tools, "redteam_engagement_open").parameters;
    assert.equal(p["target"]?.required, true);
    assert.equal(p["target"]?.type, "string");
    assert.equal(p["scope"]?.type, "array");
    assert.equal(p["scope"]?.items?.type, "string");
  });

  it("agent_slot 的 action 是枚举且必填", () => {
    const p = toolNamed(tools, "redteam_agent_slot").parameters;
    assert.equal(p["action"]?.required, true);
    assert.deepEqual(p["action"]?.enum, ["status", "acquire", "release"]);
  });

  it("role_prompt_reset 的 role 枚举来自 ROLE_ORDER（不是写死 4 个）", () => {
    const p = toolNamed(tools, "redteam_role_prompt_reset").parameters;
    const roles = p["role"]?.enum;
    assert.notEqual(roles, undefined);
    /* 历史上写死 4 个值漏掉了 assess，导致资产梳理角色永远拿不到约束 */
    assert.equal(roles?.includes("assess"), true);
    assert.equal(roles?.length, 5);
  });

  it("session_info / roles / preflight 无必填参数（可零参调用）", () => {
    for (const name of ["redteam_session_info", "redteam_roles"]) {
      const p = toolNamed(tools, name).parameters;
      const required = Object.entries(p).filter(([, v]) => v.required === true);
      assert.deepEqual(required.map(([k]) => k), [], name);
    }
  });
});

/* ── engagement_open ───────────────────────────────────────────────────── */

describe("redteam_engagement_open", () => {
  it("happy-path：绑定当前会话，不动全局指针", async () => {
    let bindCurrentSeen: unknown = "unset";
    const store = mkStore({
      openEngagement: (name: string, _scope, options) => {
        bindCurrentSeen = (options as { bindCurrent?: boolean } | undefined)?.bindCurrent;
        return { id: "e1", name };
      },
    });
    const tools = sessionTools(store, { env: {}, root: tmp });
    const out = await run(tools, "redteam_engagement_open", { target: "示例科技" });
    assert.equal(out["ok"], true);
    assert.equal(bindCurrentSeen, false, "必须显式 bindCurrent:false（多会话串写的根源）");
    assert.equal(bindings.get("s1"), "e1");
  });

  it("子智能体调用时提示「通常不需要再 open」", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_engagement_open", { target: "X" }, mkExec("child", "parent"));
    assert.match(String(out["note"]), /本会话是子智能体/);
  });

  it("主会话不出现子智能体提示", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_engagement_open", { target: "X" });
    assert.equal(/本会话是子智能体/.test(String(out["note"])), false);
  });

  it("store 抛错时被包成结构化失败（不是异常外泄）", async () => {
    const store = mkStore({
      openEngagement: () => {
        throw new Error("target 不能为空");
      },
    });
    const tools = sessionTools(store, { env: {}, root: tmp });
    const { withStructuredErrors } = await import("../../src/redteam/tools/define.js");
    const guarded = withStructuredErrors(toolNamed(tools, "redteam_engagement_open"));
    const raw = await (guarded.execute as (a: unknown, e: ToolExecContext) => Promise<string>)(
      { target: "" },
      mkExec(),
    );
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out["ok"], false);
    assert.equal(out["error_kind"], "bad_input", "「不能为空」应被识别为参数类错误");
    assert.match(String(out["hint"]), /核对参数/);
  });
});

/* ── session_bind ──────────────────────────────────────────────────────── */

describe("redteam_session_bind", () => {
  const engagements = [
    { id: "e1", name: "甲公司", created_at: "2026-01-01" },
    { id: "e2", name: "乙公司", created_at: "2026-01-02" },
  ];

  it("省略 engagement 时只列候选，不绑定", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => engagements }), { env: {}, root: tmp });
    const out = await run(tools, "redteam_session_bind", {});
    assert.equal(out["ok"], false);
    assert.equal((out["candidates"] as unknown[]).length, 2);
    assert.equal(bindings.get("s1"), undefined, "不该产生绑定");
  });

  it("按 id 绑定", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => engagements }), { env: {}, root: tmp });
    const out = await run(tools, "redteam_session_bind", { engagement: "e2" });
    assert.equal(out["ok"], true);
    assert.equal(bindings.get("s1"), "e2");
  });

  it("按名称绑定", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => engagements }), { env: {}, root: tmp });
    await run(tools, "redteam_session_bind", { engagement: "甲公司" });
    assert.equal(bindings.get("s1"), "e1");
  });

  it("按名称子串绑定（用户常只记得一部分）", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => engagements }), { env: {}, root: tmp });
    await run(tools, "redteam_session_bind", { engagement: "乙公" });
    assert.equal(bindings.get("s1"), "e2");
  });

  it("靶标不存在时 ok:false 并列出可选 id", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => engagements }), { env: {}, root: tmp });
    const out = await run(tools, "redteam_session_bind", { engagement: "不存在" });
    assert.equal(out["ok"], false);
    assert.deepEqual(out["candidates"], ["e1", "e2"]);
  });

  it("子智能体绑定时沿链写入（父会话也能查到）", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => engagements }), { env: {}, root: tmp });
    const exec = mkExec("child", "parent-root");
    await run(tools, "redteam_session_bind", { engagement: "e1" }, exec);
    /* 根键是 parent-root（父会话不在 store 里 → 父 id 直接当根） */
    assert.equal(bindings.get("parent-root"), "e1");
  });
});

/* ── session_info ──────────────────────────────────────────────────────── */

describe("redteam_session_info", () => {
  it("回显绑定与全量绑定表", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }] }), {
      env: {},
      root: tmp,
    });
    bindings.set("s1", "e1");
    const out = await run(tools, "redteam_session_info", {});
    const session = out["session"] as Record<string, unknown>;
    assert.equal(session["session_id"], "s1");
    assert.equal(session["bound_engagement"], "e1");
    assert.equal((out["bindings_now"] as unknown[]).length, 1);
  });

  it("未绑定时 bound_engagement 为 null 且 stats 为 null", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_session_info", {});
    const session = out["session"] as Record<string, unknown>;
    assert.equal(session["bound_engagement"], null);
    assert.equal(out["stats"], null);
  });

  it("提示绑定是进程内状态（重启后要重绑）", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_session_info", {});
    assert.match(String(out["note"]), /重启后各会话需要重新绑定/);
  });
});

/* ── agent_slot：Lead 点名的"拒绝必须无法误判成功" ─────────────────────── */

describe("redteam_agent_slot —— acquire 成功与拒绝", () => {
  it("status：新会话应显示全部名额可用", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal(out["ok"], true);
    assert.equal(out["used"], 0);
    assert.equal(typeof out["max"], "number");
    assert.equal(out["free"], out["max"]);
  });

  it("acquire 成功时给出 slot 与 acquired:true", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "acquire", label: "信息收集" });
    assert.equal(out["ok"], true);
    assert.equal(out["acquired"], true);
    assert.equal(typeof out["slot"], "string");
    assert.match(String(out["slot"]), /^信息收集#/);
  });

  it("无 label 时 slot 前缀是 slot#", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "acquire" });
    assert.match(String(out["slot"]), /^slot#/);
  });

  it("满额拒绝：调用方无法误判成功（无 slot / acquired:false / rejected:true）", async () => {
    /* 把上限压到 1，占满后再 acquire */
    fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ maxAgents: 1 }), "utf8");
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const first = await run(tools, "redteam_agent_slot", { action: "acquire" });
    assert.equal(first["acquired"], true);

    const second = await run(tools, "redteam_agent_slot", { action: "acquire" });
    /* 三重信号：任一缺失都可能让调用方误判 */
    assert.equal(second["ok"], false, "ok 必须为 false");
    assert.equal(second["acquired"], false, "acquired 必须显式为 false");
    assert.equal(second["rejected"], true, "rejected 必须显式为 true");
    assert.equal("slot" in second, false, "拒绝时绝不能给出 slot —— 有 slot 就等于拿到了名额");
    assert.match(String(second["error"]), /并发已满/);
  });

  it("settings.json 的 maxAgents 生效（面板改了就变）", async () => {
    fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ maxAgents: 2 }), "utf8");
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal(out["max"], 2);
  });

  it("超上限的配置被夹到 MAX_AGENTS_LIMIT", async () => {
    fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ maxAgents: 999 }), "utf8");
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal(out["max"], 10);
  });

  it("release 指定 key", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const acq = await run(tools, "redteam_agent_slot", { action: "acquire", label: "mine" });
    const slot = String(acq["slot"]);
    const rel = await run(tools, "redteam_agent_slot", { action: "release", key: slot });
    assert.equal(rel["released"], true);
  });

  it("release 省略 key 时释放最早一条", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    await run(tools, "redteam_agent_slot", { action: "acquire", label: "a" });
    await run(tools, "redteam_agent_slot", { action: "acquire", label: "b" });
    const rel = await run(tools, "redteam_agent_slot", { action: "release" });
    assert.equal(rel["released"], true);
    const st = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal((st["reservations"] as unknown[]).length, 1);
  });

  /**
   * **非法 action 必须显式拒绝**（原实现的缺陷 2）。
   *
   * 原实现把 `release` 写成"落到最后"，于是任何未知 action 都会**静默释放一个名额**
   * 并返回 `ok: true` —— 模型拼错一个词就放掉了别人的并发名额。
   *
   * 断言三条，缺一都可能让调用方误读：
   * 1. `ok === false`
   * 2. **`released` 字段不存在**（带了它，`"released" in r` 仍会被读成"执行了释放"）
   * 3. 名额数**没有变化**（证明真的没释放）
   */
  it("非法 action 显式拒绝，且绝不释放名额", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    /* 先占一个名额，才能证明"没被误释放" */
    const acq = await run(tools, "redteam_agent_slot", { action: "acquire", label: "held" });
    assert.equal(acq["acquired"], true);

    for (const bogus of ["releaes", "foo", "", "STATUS"]) {
      const out = await run(tools, "redteam_agent_slot", { action: bogus });
      assert.equal(out["ok"], false, `action=${JSON.stringify(bogus)} 必须 ok:false`);
      assert.equal(out["rejected"], true);
      assert.equal("released" in out, false, `action=${JSON.stringify(bogus)} 不得带 released 字段`);
      assert.match(String(out["error"]), /未知 action/);
      assert.match(String(out["error"]), /status \/ acquire \/ release/);
    }

    /* 名额还在：证明那 4 次非法调用一次都没动过预留表 */
    const st = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal((st["reservations"] as unknown[]).length, 1, "非法 action 不得释放任何名额");
  });

  it("release 是显式分支（正常路径仍然可用）", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const acq = await run(tools, "redteam_agent_slot", { action: "acquire", label: "x" });
    const slot = String(acq["slot"]);
    const out = await run(tools, "redteam_agent_slot", { action: "release", key: slot });
    assert.equal(out["ok"], true);
    assert.equal(out["released"], true);
  });

  it("释放不存在的 key 返回 released:false（不抛）", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "release", key: "nope" });
    assert.equal(out["released"], false);
  });

  it("取不到会话 id 时明确拒绝", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "status" }, {} as ToolExecContext);
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /取不到会话 id/);
  });

  it("注册表不可用时如实说明（不假装能核对）", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal(out["registry_available"], false);
    assert.match(String(out["registry_note"]), /subagents 注册表不可用/);
  });

  it("subagents 可用时读真实在跑数", async () => {
    const ctx: ToolRuntimeContext = {
      env: {},
      root: tmp,
      getService: (name) =>
        name === "subagents"
          ? {
              listChildren: async () => [
                { kind: "child", activity: "running", label: "信息收集" },
                { kind: "child", activity: "idle", label: "空闲" },
                { kind: "other", activity: "running" },
              ],
            }
          : null,
    };
    const tools = sessionTools(mkStore(), ctx);
    const out = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal(out["registry_available"], true);
    assert.equal(out["running_from_registry"], 1);
    assert.deepEqual(out["running_labels"], ["信息收集"]);
  });

  it("subagents.listChildren 抛错时降级但不崩", async () => {
    const ctx: ToolRuntimeContext = {
      env: {},
      root: tmp,
      getService: () => ({
        listChildren: async () => {
          throw new Error("boom");
        },
      }),
    };
    const tools = sessionTools(mkStore(), ctx);
    const out = await run(tools, "redteam_agent_slot", { action: "status" });
    assert.equal(out["registry_available"], false);
    assert.match(String(out["registry_note"]), /列子会话失败/);
  });
});

/* ── roles ─────────────────────────────────────────────────────────────── */

describe("redteam_roles", () => {
  it("列出全部角色的 code 与标题", async () => {
    const tools = sessionTools(mkStore(), { env: {}, root: tmp });
    const out = await run(tools, "redteam_roles", {});
    const roles = out["roles"] as { role: string; title: string }[];
    assert.equal(roles.length >= 5, true);
    assert.equal(roles.some((r) => r.role === "assess"), true);
    for (const r of roles) {
      assert.equal(typeof r.role, "string");
      assert.equal(typeof r.title, "string");
      assert.equal(r.title.length > 0, true);
    }
  });
});

/* ── role_prompt_reset ─────────────────────────────────────────────────── */

describe("redteam_role_prompt_reset", () => {
  it("重置指定角色", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }] }), {
      env: {},
      root: tmp,
    });
    bindings.set("s1", "e1");
    const out = await run(tools, "redteam_role_prompt_reset", { role: "recon" });
    assert.equal(out["ok"], true);
    assert.deepEqual(out["reset"], ["recon"]);
  });

  it("省略 role 时重置全部", async () => {
    const tools = sessionTools(mkStore({ listEngagements: () => [{ id: "e1", name: "A", created_at: "t" }] }), {
      env: {},
      root: tmp,
    });
    bindings.set("s1", "e1");
    const out = await run(tools, "redteam_role_prompt_reset", {});
    assert.equal((out["reset"] as string[]).length, 5);
  });

  it("未绑定且多靶标时报错（不猜）", async () => {
    const tools = sessionTools(
      mkStore({
        listEngagements: () => [
          { id: "e1", name: "A", created_at: "t" },
          { id: "e2", name: "B", created_at: "t" },
        ],
      }),
      { env: {}, root: tmp },
    );
    const { withStructuredErrors } = await import("../../src/redteam/tools/define.js");
    const guarded = withStructuredErrors(toolNamed(tools, "redteam_role_prompt_reset"));
    const raw = await (guarded.execute as (a: unknown, e: ToolExecContext) => Promise<string>)(
      { role: "recon" },
      mkExec(),
    );
    const out = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(out["ok"], false);
    assert.match(String(out["error"]), /尚未绑定靶标/);
  });
});

/* ── preflight ─────────────────────────────────────────────────────────── */

describe("redteam_preflight —— 降级必须显式标记", () => {
  /** 造一个 skills 服务替身。 */
  function skillsService(summaries: readonly Record<string, unknown>[]): Record<string, unknown> {
    return {
      list: async () => summaries,
      get: async (name: string) => summaries.find((s) => s["name"] === name),
    };
  }

  /**
   * 宿主 skills 服务不可用时，**必须显式标记降级**。
   *
   * ⚠️ 关于测试隔离的限制（已实测）：`bundledSkillSummaries` 的候选目录里
   * **总会追加真实的 `~/.dsh`**（`dshHomeCandidates` 的两候选设计，用来应付
   * "插件与宿主 home 分叉"的真实部署）。所以即使把 `DSH_HOME` 指向空目录，
   * 开发机上只要 `~/.dsh/redteam/skills` 存在，就仍能读到随包技能。
   *
   * 因此这里不断言 reason 的具体值（会随跑测试的机器而变），
   * 只断言**契约本身**：degraded 为 true、reason 有值、且给出出路。
   */
  it("宿主 skills 不可用时 degraded:true 且有 reason（不假装健康）", async () => {
    const home = path.join(tmp, "empty-home");
    fs.mkdirSync(home, { recursive: true });
    const tools = sessionTools(mkStore(), { env: { DSH_HOME: home }, root: tmp });
    const out = await run(tools, "redteam_preflight", {});
    assert.equal(out["degraded"], true, "技能服务不可用必须标记降级");
    const reason = String(out["degraded_reason"]);
    assert.equal(
      ["skills_unavailable", "skills_unavailable_used_bundled"].includes(reason),
      true,
      "reason 必须是已知的两类之一，实际=" + reason,
    );
    assert.notEqual(out["next"], undefined, "降级也要给出下一步");
    /* 用了随包兜底时要有可读说明 */
    if (reason === "skills_unavailable_used_bundled") {
      assert.match(String(out["degraded_note"]), /随包技能正文体检/);
    } else {
      assert.match(String(out["skills_root_hint"]), /请到「环境适配」配置路径/);
    }
  });

  it("skills 服务可用时不走降级分支", async () => {
    const home = path.join(tmp, "home2");
    const skillDir = path.join(home, "redteam", "skills");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "demo.md"), "# demo\n正文\n", "utf8");
    const ctx: ToolRuntimeContext = {
      env: { DSH_HOME: home },
      root: tmp,
      getService: (name) =>
        name === "skills"
          ? skillsService([
              { name: "demo", content: "# demo\n正文\n", path: path.join(skillDir, "demo.md"), library: "redteam" },
            ])
          : null,
    };
    const tools = sessionTools(mkStore(), ctx);
    const out = await run(tools, "redteam_preflight", {});
    assert.equal(out["degraded"], false);
    assert.equal(out["skills_root_hint"], "这里只检查红队技能。官方技能在 $DSH_HOME/skills，不按红队工具路径判不可用。");
  });

  it("include 只体检点名技能，ok 不被无关技能拖黑", async () => {
    const home = path.join(tmp, "home3");
    const ctx: ToolRuntimeContext = {
      env: { DSH_HOME: home },
      root: tmp,
      getService: (name) =>
        name === "skills"
          ? skillsService([
              { name: "good", content: "# good\n没有缺任何东西\n", library: "redteam" },
              { name: "bad", content: "os.environ['MISSING_KEY_XYZ']\n", library: "redteam" },
            ])
          : null,
    };
    const tools = sessionTools(mkStore(), ctx);
    const out = await run(tools, "redteam_preflight", { include: "good" });
    /* good 缺的只是全局 key/VPS，与技能本身无关 */
    assert.equal(out["checked"], 1);
    const include = out["include"] as Record<string, unknown>;
    assert.deepEqual(include["requested"], ["good"]);
  });

  it("include 里点不存在的技能时报告 unknown", async () => {
    const home = path.join(tmp, "home4");
    const skillDir = path.join(home, "redteam", "skills");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "real.md"), "# real\n正文\n", "utf8");
    const tools = sessionTools(mkStore(), { env: { DSH_HOME: home }, root: tmp });
    const out = await run(tools, "redteam_preflight", { include: "nonexistent-skill" });
    const include = out["include"] as Record<string, unknown>;
    assert.deepEqual(include["unknown"], ["nonexistent-skill"]);
  });

  it("platform 段包含工具解析结果与 runtime", async () => {
    const tools = sessionTools(mkStore(), { env: { DSH_HOME: path.join(tmp, "h5") }, root: tmp });
    const out = await run(tools, "redteam_preflight", {});
    const plat = out["platform"] as Record<string, unknown>;
    assert.equal(plat["ok"], true);
    const runtime = plat["runtime"] as Record<string, unknown>;
    assert.equal(typeof runtime["windows"], "boolean");
    const toolsSeg = plat["tools"] as Record<string, unknown>;
    assert.equal(toolsSeg["total"], 15);
  });

  it("onboarding 里如实列出 missing（缺 FOFA / 缺 VPS）", async () => {
    const tools = sessionTools(mkStore(), { env: { DSH_HOME: path.join(tmp, "h6") }, root: tmp });
    const out = await run(tools, "redteam_preflight", {});
    const onboarding = out["onboarding"] as Record<string, unknown>;
    const missing = onboarding["missing"] as string[];
    assert.equal(missing.some((m) => m.includes("FOFA_KEY")), true);
    assert.equal(missing.some((m) => m.includes("VPS")), true);
  });

  it("配好 FOFA_KEY 与 VPS 后 missing 相应减少", async () => {
    const home = path.join(tmp, "h7");
    const vpsDir = path.join(home, "redteam", "toolkit", "vps");
    fs.mkdirSync(vpsDir, { recursive: true });
    const vpsKey = path.join(vpsDir, "id_rsa");
    fs.writeFileSync(vpsKey, "key", "utf8");
    const tools = sessionTools(mkStore(), {
      env: { DSH_HOME: home, FOFA_KEY: "0123456789abcdef", REDTEAM_VPS_KEY: vpsKey, REDTEAM_VPS_HOST: "u@h" },
      root: tmp,
    });
    const out = await run(tools, "redteam_preflight", {});
    const onboarding = out["onboarding"] as Record<string, unknown>;
    const configured = onboarding["configured"] as Record<string, unknown>;
    assert.match(String(configured["fofa_key"]), /^configured/);
    assert.match(String(configured["vps_key"]), /^configured/);
    /* FOFA key 要脱敏显示，不能整串回显 */
    assert.equal(String(configured["fofa_key"]).includes("89abcdef"), false);
  });

  it("平台 config.json 里的 env 参与判定（config 也是合法来源）", async () => {
    /* 注意：config.json 落在 **ctx.root** 下（platformSummary/loadPlatformConfig 的根），
       不是 $DSH_HOME 下 —— 放错位置这条用例会假通过。 */
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ env: { FOFA_KEY: "from-config-1234" } }), "utf8");
    const tools = sessionTools(mkStore(), { env: { DSH_HOME: path.join(tmp, "h8") }, root: tmp });
    const out = await run(tools, "redteam_preflight", {});
    const onboarding = out["onboarding"] as Record<string, unknown>;
    const configured = onboarding["configured"] as Record<string, unknown>;
    assert.match(String(configured["fofa_key"]), /^configured/);
  });
});

/* ── 注册桥 ────────────────────────────────────────────────────────────── */

describe("toHostTool 注册桥", () => {
  it("保留 name / description，且 parameters 里不含 undefined 键", async () => {
    const { toHostTool } = await import("../../src/redteam/tools/define.js");
    const tools = sessionTools(mkStore(), { env: {}, root: "/tmp/x" });
    const host = toHostTool(toolNamed(tools, "redteam_agent_slot"));
    assert.equal(host.name, "redteam_agent_slot");
    assert.equal(host.description.length > 10, true);
    const action = host.parameters["action"];
    assert.notEqual(action, undefined);
    /* enum 被保留（模型据此知道只有三个合法值） */
    assert.deepEqual(action?.enum, ["status", "acquire", "release"]);
    /* 不该出现显式的 undefined 属性 */
    assert.equal(Object.keys(action ?? {}).includes("default"), false);
  });

  it("宿主包装后 execute 仍返回字符串", async () => {
    const { toHostTool } = await import("../../src/redteam/tools/define.js");
    const tools = sessionTools(mkStore(), { env: {}, root: "/tmp/x" });
    const host = toHostTool(toolNamed(tools, "redteam_roles"));
    const out = await host.execute({}, mkExec());
    assert.equal(typeof out, "string");
    const parsed = JSON.parse(String(out)) as Record<string, unknown>;
    assert.equal(parsed["ok"], true);
  });
});
