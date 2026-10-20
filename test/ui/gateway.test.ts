/**
 * 网关 9 个本地 op 的测试。
 *
 * 端口全部注入，所以这里不碰真宿主 / 真 npm / 真网络。
 * 重点是：**缺能力时明确报错**，不猜、不降级。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GATEWAY_LOCAL_OPS,
  handleGateway,
  rawField,
  type GatewayPorts,
  type SkillEntry,
} from "../../src/redteam/ui/gateway.js";
import { parseRequest } from "../../src/redteam/ui/ops.js";
import type { ParsedRequest } from "../../src/redteam/ui/ops.js";

/** 解析一个请求；失败直接抛（测试夹具问题）。 */
function reqOf(input: Readonly<Record<string, unknown>>): ParsedRequest {
  const result = parseRequest(input);
  if (!result.ok) throw new Error(`夹具解析失败：${result.error.message}`);
  return result.value;
}

/** 构造端口，逐项可覆盖。 */
function ports(overrides: Partial<GatewayPorts> = {}): GatewayPorts {
  return {
    storeRoot: "/tmp/rt",
    maxAgents: () => 3,
    saveMaxAgents: (value) => value,
    maxAgentsSource: () => "default",
    maxAgentsLimit: 10,
    defaultMaxAgents: 3,
    subagents: null,
    sessions: null,
    envAdaptStatus: () => ({ ok: true, ready: true, reason: "configured" }),
    envAdaptSkip: (skip) => ({ ok: true, skipped: skip }),
    pluginIdentity: () => ({ name: "dsh-unbound", version: "0.1.0", description: "d", homepage: "https://x" }),
    updatePreflight: async () => ({
      install: { mode: "package", dir: "/p", packageManager: "npm" },
      blockers: [],
      notes: [],
      runningAgents: [],
    }),
    checkLatest: async () => ({ ok: true, latest: "0.2.0" }),
    applyUpdate: async () => ({ ok: true, restart: { log: "/tmp/restart.log" } }),
    // 简化版 semver 比较：测试只要方向对。
    versionIsNewer: (remote, local) => remote.localeCompare(local, undefined, { numeric: true }) > 0,
    skillService: null,
    presetService: null,
    skillFallback: async () => ({ ok: true, fromFallback: true }),
    ...overrides,
  };
}

describe("GATEWAY_LOCAL_OPS — 与 op 表一致", () => {
  it("恰好 9 个", () => {
    assert.equal(GATEWAY_LOCAL_OPS.size, 9);
  });

  it("不含 store 类 op（platformConfigGet 等归资产库）", () => {
    for (const op of ["platformConfigGet", "platformConfigSave", "platformAssignToolkit"]) {
      assert.equal(GATEWAY_LOCAL_OPS.has(op), false, `${op} 不该在网关列表`);
    }
  });
});

describe("handleGateway — 不认识的 op 交回上层", () => {
  it("store 类 op 返回 null（不吞掉）", async () => {
    const result = await handleGateway(reqOf({ op: "bootstrap" }), ports());
    assert.equal(result, null);
  });
});

describe("环境适配 op", () => {
  it("platformEnvAdaptStatus 原样返回端口结果", async () => {
    const result = await handleGateway(
      reqOf({ op: "platformEnvAdaptStatus" }),
      ports({ envAdaptStatus: () => ({ ok: true, ready: false, reason: "need-config" }) }),
    );
    assert.equal(result?.["ready"], false);
    assert.equal(result?.["reason"], "need-config");
  });

  it("platformEnvAdaptSkip 缺省 skip=true", async () => {
    const captured: boolean[] = [];
    await handleGateway(
      reqOf({ op: "platformEnvAdaptSkip" }),
      ports({ envAdaptSkip: (skip) => { captured.push(skip); return { ok: true, skipped: skip }; } }),
    );
    assert.deepEqual(captured, [true]);
  });

  it("platformEnvAdaptSkip 传 skip=false 时尊重显式值", async () => {
    const captured: boolean[] = [];
    await handleGateway(
      reqOf({ op: "platformEnvAdaptSkip", skip: false }),
      ports({ envAdaptSkip: (skip) => { captured.push(skip); return { ok: true, skipped: skip }; } }),
    );
    assert.deepEqual(captured, [false]);
  });
});

describe("智能体并发 op", () => {
  it("setAgentsMax 保存并回报生效值", async () => {
    const result = await handleGateway(
      reqOf({ op: "setAgentsMax", max: 8 }),
      ports({ saveMaxAgents: () => 8, maxAgentsLimit: 10 }),
    );
    assert.equal(result?.["max"], 8);
    assert.equal(result?.["limit"], 10);
    assert.match(String(result?.["note"]), /8/);
  });

  it("setAgentsMax 回报的是**保存后实际值**（可能被 clamp）", async () => {
    const result = await handleGateway(
      reqOf({ op: "setAgentsMax", max: 999 }),
      ports({ saveMaxAgents: () => 10 }),
    );
    assert.equal(result?.["max"], 10, "应回报 clamp 后的值，而不是输入值");
  });

  it("agentsStatus：注册表不可用 → ok:false 但仍然给 max", async () => {
    const result = await handleGateway(reqOf({ op: "agentsStatus" }), ports({ subagents: null, sessions: null }));
    assert.equal(result?.["ok"], false);
    assert.equal(result?.["max"], 3);
    assert.match(String(result?.["error"]), /注册表不可用/);
  });

  it("agentsStatus：统计真正在跑的子会话", async () => {
    const result = await handleGateway(
      reqOf({ op: "agentsStatus" }),
      ports({
        maxAgents: () => 5,
        sessions: {
          list: () => [
            { id: "root-1", header: {} },                       // 根会话
            { id: "child-1", header: { parentSession: "root-1" } }, // 子会话，不应被当根
          ],
        },
        subagents: {
          listChildren: async (parentId) => {
            if (parentId !== "root-1") return [];
            return [
              { id: "a", kind: "child", activity: "running", label: "侦察" },
              { id: "b", kind: "child", activity: "idle", label: "扫描" },
              { id: "c", kind: "root", activity: "running" },   // kind 不是 child，不计
            ];
          },
        },
      }),
    );
    assert.equal(result?.["ok"], true);
    assert.equal(result?.["max"], 5);
    assert.equal(result?.["used"], 1, "只有 activity=running 的 child 算占用");
    assert.equal(result?.["free"], 4);
    assert.equal(result?.["total_children"], 2);
  });

  it("agentsStatus：单个会话读取失败不影响其它", async () => {
    const result = await handleGateway(
      reqOf({ op: "agentsStatus" }),
      ports({
        sessions: { list: () => [{ id: "r1", header: {} }, { id: "r2", header: {} }] },
        subagents: {
          listChildren: async (parentId) => {
            if (parentId === "r1") throw new Error("gone");
            return [{ id: "x", kind: "child", activity: "running" }];
          },
        },
      }),
    );
    assert.equal(result?.["ok"], true);
    assert.equal(result?.["used"], 1);
  });

  it("agentsStatus：running 列表上限 20（防响应体过大）", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, kind: "child", activity: "running" }));
    const result = await handleGateway(
      reqOf({ op: "agentsStatus" }),
      ports({
        sessions: { list: () => [{ id: "r", header: {} }] },
        subagents: { listChildren: async () => many },
      }),
    );
    assert.equal(result?.["used"], 50);
    assert.equal((result?.["running"] as readonly unknown[]).length, 20);
  });
});

describe("版本与更新 op", () => {
  it("version：开发态不查 registry（避免无意义网络）", async () => {
    let checked = 0;
    const result = await handleGateway(
      reqOf({ op: "version" }),
      ports({
        updatePreflight: async () => ({ install: { mode: "dev" }, blockers: [], notes: ["开发态"], runningAgents: [] }),
        checkLatest: async () => { checked += 1; return { ok: true, latest: "9.9.9" }; },
      }),
    );
    assert.equal(checked, 0, "开发态不该查 registry");
    assert.equal(result?.["latest"], null);
    assert.equal(result?.["updateAvailable"], false);
  });

  it("version：包管理器安装态会查并算 updateAvailable", async () => {
    const result = await handleGateway(
      reqOf({ op: "version" }),
      ports({ checkLatest: async () => ({ ok: true, latest: "0.2.0" }) }),
    );
    assert.equal(result?.["latest"], "0.2.0");
    assert.equal(result?.["updateAvailable"], true);
  });

  it("version：本机比 registry 新 → localAhead", async () => {
    const result = await handleGateway(
      reqOf({ op: "version" }),
      ports({
        pluginIdentity: () => ({ name: "x", version: "0.5.0", description: "", homepage: null }),
        checkLatest: async () => ({ ok: true, latest: "0.2.0" }),
      }),
    );
    assert.equal(result?.["localAhead"], true);
    assert.equal(result?.["updateAvailable"], false);
  });

  it("version：查失败时把 check_error 带出去（不静默当「最新」）", async () => {
    const result = await handleGateway(
      reqOf({ op: "version" }),
      ports({ checkLatest: async () => ({ ok: false, error: "network" }) }),
    );
    assert.equal(result?.["check_error"], "network");
    assert.equal(result?.["latest"], null);
  });

  it("updateCheck：查失败 → ok:false", async () => {
    const result = await handleGateway(
      reqOf({ op: "updateCheck" }),
      ports({ checkLatest: async () => ({ ok: false, error: "HTTP 404" }) }),
    );
    assert.equal(result?.["ok"], false);
    assert.equal(result?.["error"], "HTTP 404");
  });

  it("updateCheck：本机超前时给出解释性 note", async () => {
    const result = await handleGateway(
      reqOf({ op: "updateCheck" }),
      ports({
        pluginIdentity: () => ({ name: "x", version: "0.5.0", description: "", homepage: null }),
        checkLatest: async () => ({ ok: true, latest: "0.2.0" }),
      }),
    );
    const notes = result?.["notes"] as readonly string[];
    assert.ok(notes.some((n) => /尚未发布的开发版本/.test(n)));
  });

  it("updateApply：有阻塞项时拒绝", async () => {
    const result = await handleGateway(
      reqOf({ op: "updateApply" }),
      ports({
        updatePreflight: async () => ({
          install: { mode: "package" },
          blockers: ["有 2 个智能体正在跑"],
          notes: [],
          runningAgents: [],
        }),
      }),
    );
    assert.equal(result?.["ok"], false);
    assert.match(String(result?.["error"]), /不能更新/);
  });

  it("updateApply：**target 只接受纯 semver**（防注入 npm 参数）", async () => {
    const evil = [
      "left-pad",
      "../local",
      "https://evil.example/pkg.tgz",
      "0.1.0 --registry=https://evil.example",
      "@scope/pkg",
    ];
    for (const target of evil) {
      const result = await handleGateway(reqOf({ op: "updateApply", target }), ports());
      assert.equal(result?.["ok"], false, `target=${target} 应被拒绝`);
      assert.match(String(result?.["error"]), /纯版本号/);
    }
  });

  it("updateApply：合法 semver 通过（含 v 前缀与 prerelease）", async () => {
    for (const target of ["0.11.0", "v0.11.0", "1.0.0-beta.1"]) {
      const result = await handleGateway(reqOf({ op: "updateApply", target }), ports());
      assert.equal(result?.["ok"], true, `target=${target} 应通过`);
    }
  });

  it("updateApply：不带 target 时传 null（表示装最新）", async () => {
    const captured: (string | null)[] = [];
    await handleGateway(
      reqOf({ op: "updateApply" }),
      ports({ applyUpdate: async (target) => { captured.push(target); return { ok: true, restart: { log: "/l" } }; } }),
    );
    assert.deepEqual(captured, [null]);
  });

  it("updateApply：安装失败透出错误", async () => {
    const result = await handleGateway(
      reqOf({ op: "updateApply" }),
      ports({ applyUpdate: async () => ({ ok: false, error: "EACCES" }) }),
    );
    assert.equal(result?.["ok"], false);
    assert.equal(result?.["error"], "EACCES");
  });
});

describe("技能库 op", () => {
  const skill = (over: Partial<SkillEntry> = {}): SkillEntry => ({
    name: "recon",
    description: "信息收集",
    whenToUse: "开始前",
    provider: "dsh-qilin",
    source: "plugin",
    resourceBase: { kind: "directory", path: "/skills/redteam" },
    invocation: { modelInvocable: true, userInvocable: true },
    ...over,
  });

  it("skillCatalog：无 skills 服务 → 走兜底", async () => {
    const result = await handleGateway(reqOf({ op: "skillCatalog" }), ports());
    assert.equal(result?.["fromFallback"], true);
  });

  it("skillCatalog：preset 服务不可用 → 走兜底（不 400）", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillCatalog" }),
      ports({
        skillService: { list: async () => [skill()], get: async () => undefined },
        presetService: null,
      }),
    );
    assert.equal(result?.["fromFallback"], true);
  });

  it("skillCatalog：正常列出并统计 bySource / byDir", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillCatalog" }),
      ports({
        skillService: {
          list: async () => [
            skill(),
            skill({ name: "exploit", source: "plugin" }),
            skill({ name: "scan", source: "user", resourceBase: null }),
          ],
          get: async () => undefined,
        },
        presetService: { standingKeyFor: async () => "scope-1" },
      }),
    );
    assert.equal(result?.["ok"], true);
    assert.equal(result?.["total"], 3);
    const bySource = result?.["bySource"] as readonly { key: string; n: number }[];
    assert.equal(bySource.find((x) => x.key === "plugin")?.n, 2);
    assert.equal(bySource.find((x) => x.key === "user")?.n, 1);
  });

  it("skillCatalog：服务列空时走兜底", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillCatalog" }),
      ports({
        skillService: { list: async () => [], get: async () => undefined },
        presetService: { standingKeyFor: async () => "s" },
      }),
    );
    assert.equal(result?.["fromFallback"], true);
  });

  it("skillCatalog：服务抛错时走兜底", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillCatalog" }),
      ports({
        skillService: { list: async () => { throw new Error("boom"); }, get: async () => undefined },
        presetService: { standingKeyFor: async () => "s" },
      }),
    );
    assert.equal(result?.["fromFallback"], true);
  });

  it("skillRead：缺 name → ok:false", async () => {
    const result = await handleGateway(reqOf({ op: "skillRead", name: "" }), ports());
    assert.equal(result?.["ok"], false);
    assert.equal(result?.["error"], "name required");
  });

  it("skillRead：找到技能时返回正文", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillRead", name: "recon" }),
      ports({
        skillService: {
          list: async () => [skill()],
          get: async () => skill({ content: "# recon", path: "/skills/recon.md" }),
        },
        presetService: { standingKeyFor: async () => "s" },
      }),
    );
    assert.equal(result?.["content"], "# recon");
    assert.equal(result?.["path"], "/skills/recon.md");
  });

  it("skillRead：服务没找到 → 走兜底", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillRead", name: "nope" }),
      ports({
        skillService: { list: async () => [], get: async () => undefined },
        presetService: { standingKeyFor: async () => "s" },
      }),
    );
    assert.equal(result?.["fromFallback"], true);
  });

  it("skillRead：服务抛错 → 走兜底", async () => {
    const result = await handleGateway(
      reqOf({ op: "skillRead", name: "recon" }),
      ports({
        skillService: { list: async () => [], get: async () => { throw new Error("boom"); } },
        presetService: { standingKeyFor: async () => "s" },
      }),
    );
    assert.equal(result?.["fromFallback"], true);
  });
});

describe("rawField", () => {
  it("读未声明字段", () => {
    const request = reqOf({ op: "skillCatalog", future: 42 });
    assert.equal(rawField(request, "future"), 42);
  });
});
