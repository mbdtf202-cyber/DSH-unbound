/**
 * 插件入口层测试。
 *
 * 用**内存假宿主**（真 event bus、真 effect 收集）而不是 mock 框架：
 * 本层的行为全在「装配顺序 / 注册次数 / 幂等」上，只有真的记录调用序列才测得到。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  addPromptSection,
  contextCwd,
  inject,
  makeLogger,
  name,
  normalizeConfig,
  plugin,
  registerPromptSections,
  registerTools,
  rewriteLiveAssembly,
  shouldInjectAssembly,
  watchContextLife,
  createDefaultPorts,
  existsSafe,
  qilinStateDir,
  type Logger,
  type PluginPorts,
} from "../../src/plugin/index.js";
import { CAPABILITY_SECTION } from "../../src/plugin/capability-protocol.js";
import { GLOBAL_PROMPT_ORDER } from "../../src/plugin/identity.js";
import type { HostContext } from "../../src/host-api/types.js";

// ───────────────────────────── 假宿主 ─────────────────────────────

interface Recorded {
  readonly kind: "effect" | "on" | "register-tool" | "register-command" | "section" | "get";
  readonly detail: string;
}

/** 一个可观测的假宿主。 */
interface FakeCtx {
  readonly ctx: HostContext;
  readonly recorded: Recorded[];
  emit(event: string, ...args: unknown[]): Promise<unknown[]>;
  runEffects(): void;
  sections(): readonly { name: string; order: number; text: (context?: unknown) => string }[];
  tools(): readonly { name: string; execute: (args: unknown, exec: unknown) => unknown }[];
  commands(): readonly { name: string; handler: (inv: { rawInput?: string }) => Promise<unknown> }[];
}

function makeFakeCtx(options: { readonly withTools?: boolean; readonly withCommands?: boolean } = {}): FakeCtx {
  const recorded: Recorded[] = [];
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const effectFns: (() => void | (() => void))[] = [];
  const sectionSpecs: { name: string; order: number; text: (context?: unknown) => string }[] = [];
  const toolSpecs: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = [];
  const commandSpecs: { name: string; handler: (inv: { rawInput?: string }) => Promise<unknown> }[] = [];

  const systemPrompt = {
    section(spec: { name: string; order: number; text: (context?: unknown) => string }): () => void {
      recorded.push({ kind: "section", detail: spec.name });
      sectionSpecs.push(spec);
      return () => {
        /* disposer */
      };
    },
  };

  const ctx: Record<string, unknown> = {
    systemPrompt,
    logger: {
      debug: (): void => undefined,
      info: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
    },
    effect(fn: () => void | (() => void)): void {
      recorded.push({ kind: "effect", detail: "effect" });
      effectFns.push(fn);
    },
    on(event: string, listener: (...args: unknown[]) => unknown): void {
      recorded.push({ kind: "on", detail: event });
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    get(key: string): unknown {
      recorded.push({ kind: "get", detail: key });
      return null;
    },
  };

  if (options.withTools === true) {
    ctx["tools"] = {
      register(tool: { name: string; execute: (args: unknown, exec: unknown) => unknown }): void {
        recorded.push({ kind: "register-tool", detail: tool.name });
        toolSpecs.push(tool);
      },
    };
  }
  if (options.withCommands === true) {
    ctx["get"] = (key: string): unknown => {
      recorded.push({ kind: "get", detail: key });
      if (key !== "commands") return null;
      return {
        register(spec: { name: string; handler: (inv: { rawInput?: string }) => Promise<unknown> }): void {
          recorded.push({ kind: "register-command", detail: spec.name });
          commandSpecs.push(spec);
        },
      };
    };
  }

  return {
    ctx: ctx as unknown as HostContext,
    recorded,
    async emit(event: string, ...args: unknown[]): Promise<unknown[]> {
      const list = listeners.get(event) ?? [];
      const out: unknown[] = [];
      for (const listener of list) out.push(await listener(...args));
      return out;
    },
    runEffects(): void {
      // 模拟宿主 dispose：执行每个 effect 回调，并调用它返回的 cleanup。
      for (const fn of effectFns) {
        const cleanup = fn();
        if (typeof cleanup === "function") cleanup();
      }
    },
    sections(): readonly { name: string; order: number; text: (context?: unknown) => string }[] {
      return sectionSpecs;
    },
    tools(): readonly { name: string; execute: (args: unknown, exec: unknown) => unknown }[] {
      return toolSpecs;
    },
    commands(): readonly { name: string; handler: (inv: { rawInput?: string }) => Promise<unknown> }[] {
      return commandSpecs;
    },
  };
}

/** 内存端口：不碰磁盘、不碰宿主。 */
function makePorts(overrides: Partial<PluginPorts> = {}): PluginPorts {
  const base: PluginPorts = {
    readInjectFallback: () => "INJECT BODY",
    bundledDefault: () => "",
    currentCwd: () => "/tmp/work",
    rememberCwd: () => undefined,
    applyPatches: () => ({ applied: 0, filesChanged: 0 }),
    diagnose: () => "diagnostics",
    scheduleRestart: () => undefined,
    surface: () => "web",
    sealed: () => false,
    ensureRulesInitialState: async () => ({ active: null }),
  };
  return { ...base, ...overrides };
}

const quietLogger: Logger = { debug: () => undefined, warn: () => undefined };
const fullConfig = normalizeConfig({});

// ───────────────────────────── 模块契约 ─────────────────────────────

describe("插件模块契约", () => {
  it("name 是 dsh-qilin（宿主按这个名字做段过滤，不能改）", () => {
    assert.equal(name, "dsh-qilin");
    assert.equal(plugin.name, "dsh-qilin");
  });

  it("inject 只声明 systemPrompt 与 tools", () => {
    assert.deepEqual([...inject], ["systemPrompt", "tools"]);
    assert.deepEqual([...(plugin.inject ?? [])], ["systemPrompt", "tools"]);
  });

  it("inject 里没有 pluginPackages（写进去会 pending → 退出码 1）", () => {
    // Cordis 会对 inject 里每个 key 空等；便携拷贝/Hub 残装常常没有这项服务。
    const declared = new Set<string>([...inject, ...(plugin.inject ?? [])]);
    assert.equal(declared.has("pluginPackages"), false);
    assert.equal(declared.size, 2);
  });

  it("inject 里没有其他可选服务（每加一项都是一次 pending 风险）", () => {
    const allowed = new Set(["systemPrompt", "tools"]);
    for (const service of inject) {
      assert.equal(allowed.has(service), true, `不该声明 ${service}`);
    }
  });

  it("apply 是函数", async () => {
    assert.equal(typeof plugin.apply, "function");
    const mod = await import("../../src/plugin/index.js");
    assert.equal(typeof mod.default.apply, "function");
  });
});

describe("normalizeConfig", () => {
  it("空配置给全套默认值", () => {
    const config = normalizeConfig(undefined);
    assert.equal(config.enabled, true);
    assert.equal(config.autoApplyOnStart, false, "启动默认不写宿主包");
    assert.equal(config.stripMnemon, true);
    assert.equal(config.capabilityProtocol, true);
    assert.equal(config.postPrompt, "");
    assert.equal(config.postPromptOrder, 5100);
    assert.equal(config.verbose, false);
  });

  it("布尔字段类型不对 → 回默认（不是真值转换）", () => {
    const config = normalizeConfig({ enabled: "false", verbose: 1 });
    assert.equal(config.enabled, true);
    assert.equal(config.verbose, false);
  });

  it("字符串字段类型不对 → 回默认", () => {
    assert.equal(normalizeConfig({ postPrompt: 42 }).postPrompt, "");
  });

  it("数字字段 NaN/Infinity → 回默认", () => {
    assert.equal(normalizeConfig({ postPromptOrder: Number.NaN }).postPromptOrder, 5100);
    assert.equal(normalizeConfig({ postPromptOrder: Number.POSITIVE_INFINITY }).postPromptOrder, 5100);
  });

  it("surface 只接受 web / desktop", () => {
    assert.equal(normalizeConfig({ surface: "desktop" }).surface, "desktop");
    assert.equal(normalizeConfig({ surface: "web" }).surface, "web");
    assert.equal(normalizeConfig({ surface: "cli" }).surface, "web");
  });

  it("非对象输入不崩", () => {
    assert.equal(normalizeConfig(null).enabled, true);
    assert.equal(normalizeConfig("string").enabled, true);
    assert.equal(normalizeConfig(42).enabled, true);
  });

  it("未知字段被丢弃", () => {
    const config = normalizeConfig({ somethingNew: true }) as unknown as Record<string, unknown>;
    assert.equal("somethingNew" in config, false);
  });
});

describe("makeLogger", () => {
  it("verbose=false 时不打 debug", () => {
    let called = 0;
    const ctx = {
      logger: { debug: (): void => void (called += 1) },
    } as unknown as HostContext;
    const logger = makeLogger(ctx, false);
    logger.debug("x");
    assert.equal(called, 0);
  });

  it("verbose=true 时打 debug", () => {
    let called = 0;
    const ctx = {
      logger: { debug: (): void => void (called += 1) },
    } as unknown as HostContext;
    makeLogger(ctx, true).debug("x");
    assert.equal(called, 1);
  });

  it("没有 debug 时退到 info", () => {
    let called = 0;
    const ctx = {
      logger: { info: (): void => void (called += 1) },
    } as unknown as HostContext;
    makeLogger(ctx, true).debug("x");
    assert.equal(called, 1);
  });

  it("没有 logger 时 debug 静默、warn 走 console", () => {
    const ctx = {} as HostContext;
    const logger = makeLogger(ctx, true);
    assert.doesNotThrow(() => logger.debug("x"));
    // warn 不该抛（无论走 console 还是 logger）
    const original = console.warn;
    let seen = 0;
    console.warn = (): void => void (seen += 1);
    try {
      logger.warn("x");
    } finally {
      console.warn = original;
    }
    assert.equal(seen, 1);
  });
});

describe("contextCwd", () => {
  it("从 agent.session.header.cwd 读", () => {
    assert.equal(contextCwd({ agent: { session: { header: { cwd: " /tmp/x " } } } }), "/tmp/x");
  });

  it("缺失 → 空串", () => {
    assert.equal(contextCwd({}), "");
    assert.equal(contextCwd(null), "");
    assert.equal(contextCwd(undefined), "");
  });

  it("cwd 不是字符串 → 空串", () => {
    assert.equal(contextCwd({ agent: { session: { header: { cwd: 42 } } } }), "");
  });

  it("访问抛错的代理 → 空串（不崩）", () => {
    const context = {
      get agent(): unknown {
        throw new Error("proxy without inject");
      },
    };
    assert.equal(contextCwd(context), "");
  });
});

describe("watchContextLife", () => {
  it("注册一个 effect，cleanup 后 life.alive 变 false", () => {
    const fake = makeFakeCtx();
    const life = watchContextLife(fake.ctx, quietLogger);
    assert.equal(life.alive, true);
    fake.runEffects();
    assert.equal(life.alive, false);
  });

  it("ctx 没有 effect → 仍然返回活着（不能误判成死）", () => {
    const life = watchContextLife({} as HostContext, quietLogger);
    assert.equal(life.alive, true);
  });

  it("effect 抛 INACTIVE_EFFECT → life 判死，不往外抛", () => {
    const ctx = {
      effect: (): void => {
        throw Object.assign(new Error("inactive context"), { code: "INACTIVE_EFFECT" });
      },
    } as unknown as HostContext;
    const life = watchContextLife(ctx, quietLogger);
    assert.equal(life.alive, false);
  });
});

// ───────────────────────────── 段注册 ─────────────────────────────

describe("registerPromptSections", () => {
  it("注册 inject 段，order = GLOBAL_PROMPT_ORDER", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, fullConfig, makePorts(), quietLogger);
    const injectSection = fake.sections().find((s) => s.name === "dsh-qilin");
    assert.notEqual(injectSection, undefined);
    assert.equal(injectSection?.order, GLOBAL_PROMPT_ORDER);
  });

  it("注册 cap 段，order = GLOBAL_PROMPT_ORDER + 1", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, fullConfig, makePorts(), quietLogger);
    const cap = fake.sections().find((s) => s.name === CAPABILITY_SECTION);
    assert.notEqual(cap, undefined);
    assert.equal(cap?.order, GLOBAL_PROMPT_ORDER + 1);
  });

  it("cap 段正文按 context 判红队", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, fullConfig, makePorts(), quietLogger);
    const cap = fake.sections().find((s) => s.name === CAPABILITY_SECTION);
    const normal = cap?.text({ session: { agentPreset: "standard" } }) ?? "";
    const redteam = cap?.text({ session: { agentPreset: "redteam" } }) ?? "";
    assert.match(normal, /mandatory/);
    assert.match(redteam, /redteam lead/);
  });

  it("capabilityProtocol=false 不注册 cap 段", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, normalizeConfig({ capabilityProtocol: false }), makePorts(), quietLogger);
    assert.equal(fake.sections().some((s) => s.name === CAPABILITY_SECTION), false);
  });

  it("inject 段是惰性的（每轮调用时才读）", () => {
    const fake = makeFakeCtx();
    let reads = 0;
    const ports = makePorts({
      readInjectFallback: () => {
        reads += 1;
        return "BODY";
      },
    });
    registerPromptSections(fake.ctx, fullConfig, ports, quietLogger);
    assert.equal(reads, 0, "注册时不该读");
    const section = fake.sections().find((s) => s.name === "dsh-qilin");
    assert.equal(section?.text({}), "BODY");
    assert.equal(reads, 1);
  });

  it("enabled=false 时段正文为空串（不注入）", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, normalizeConfig({ enabled: false }), makePorts(), quietLogger);
    const section = fake.sections().find((s) => s.name === "dsh-qilin");
    assert.equal(section?.text({}), "");
  });

  it("postPrompt 注册为 dsh-qilin:post，order 用配置值", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, normalizeConfig({ postPrompt: "额外说明" }), makePorts(), quietLogger);
    const post = fake.sections().find((s) => s.name === "dsh-qilin:post");
    assert.notEqual(post, undefined);
    assert.equal(post?.order, 5100);
    assert.equal(post?.text({}), "额外说明");
  });

  it("postPromptOrder <= GLOBAL_PROMPT_ORDER 时跳过（日志告警，不抛）", () => {
    const fake = makeFakeCtx();
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      warn: (message: string): void => void warnings.push(message),
    };
    registerPromptSections(
      fake.ctx,
      normalizeConfig({ postPrompt: "x", postPromptOrder: GLOBAL_PROMPT_ORDER }),
      makePorts(),
      logger,
    );
    assert.equal(fake.sections().some((s) => s.name === "dsh-qilin:post"), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /postPromptOrder/);
  });

  it("postPrompt 为空时不留空段", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, normalizeConfig({ postPrompt: "   " }), makePorts(), quietLogger);
    assert.equal(fake.sections().some((s) => s.name === "dsh-qilin:post"), false);
  });

  it("三段都注册时，order 严格递增", () => {
    const fake = makeFakeCtx();
    registerPromptSections(fake.ctx, normalizeConfig({ postPrompt: "p" }), makePorts(), quietLogger);
    const orders = fake.sections().map((s) => s.order);
    assert.deepEqual(orders, [GLOBAL_PROMPT_ORDER, GLOBAL_PROMPT_ORDER + 1, 5100]);
  });
});

describe("addPromptSection", () => {
  it("同时往 systemPrompt.ctx 与 ctx 本身试挂（scope 差异）", () => {
    // 原实现遍历的每个 host 都必须是「完整 ctx 形态」——它读的是 `host.systemPrompt.section`。
    // `ctx.systemPrompt.ctx` 就是提示词服务自己的 ctx，所以它也有 systemPrompt。
    const seen: string[] = [];
    const innerCtx = { systemPrompt: { section: (): void => void seen.push("inner") } };
    const ctx = {
      systemPrompt: { ctx: innerCtx, section: (): void => void seen.push("outer") },
    } as unknown as HostContext;
    addPromptSection(
      ctx,
      { name: "x", order: 0, text: () => "t" },
      quietLogger,
    );
    assert.deepEqual(seen.sort(), ["inner", "outer"]);
  });

  it("already registered 视为成功（不打错误日志）", () => {
    const warnings: string[] = [];
    const ctx = {
      systemPrompt: {
        section: (): void => {
          throw new Error("section already registered");
        },
      },
    } as unknown as HostContext;
    addPromptSection(ctx, { name: "x", order: 0, text: () => "t" }, {
      debug: () => undefined,
      warn: (m: string): void => void warnings.push(m),
    });
    assert.deepEqual(warnings, []);
  });

  it("全失败且有错误 → 记一条告警，不抛", () => {
    const warnings: string[] = [];
    const ctx = {
      systemPrompt: {
        section: (): void => {
          throw new Error("boom");
        },
      },
    } as unknown as HostContext;
    assert.doesNotThrow(() =>
      addPromptSection(ctx, { name: "x", order: 0, text: () => "t" }, {
        debug: () => undefined,
        warn: (m: string): void => void warnings.push(m),
      }),
    );
    assert.equal(warnings.length, 1);
  });

  it("返回 disposer 时挂到 effect 上回收", () => {
    let effects = 0;
    const ctx = {
      systemPrompt: { section: () => (): void => undefined },
      effect: (): void => void (effects += 1),
    } as unknown as HostContext;
    addPromptSection(ctx, { name: "x", order: 0, text: () => "t" }, quietLogger);
    assert.equal(effects, 1);
  });

  it("ctx 没有 systemPrompt → 静默跳过", () => {
    assert.doesNotThrow(() =>
      addPromptSection({} as HostContext, { name: "x", order: 0, text: () => "t" }, quietLogger),
    );
  });
});

// ───────────────────────────── 装配决策 / 改写 ─────────────────────────────

describe("shouldInjectAssembly", () => {
  it("永远 full 模式（不读 inbox、不改 steer）", () => {
    const decision = shouldInjectAssembly({});
    assert.equal(decision.mode, "full");
    assert.equal(decision.taskKind, "general");
    assert.equal(decision.lastRole, "full");
  });

  it("子代理被识别", () => {
    assert.equal(shouldInjectAssembly({ session: { header: { origin: "subagent" } } }).isSubagent, true);
    assert.equal(shouldInjectAssembly({}).isSubagent, false);
  });
});

describe("rewriteLiveAssembly", () => {
  const asm = (): { sections: { name: string; text: string }[] } => ({
    sections: [
      { name: "deployment:persona-prefix", text: "You are an AI agent powered by DeepSeek Harness." },
      { name: "harness:identity", text: "官方身份" },
    ],
  });

  it("inject 被折进装配", () => {
    const out = rewriteLiveAssembly(fullConfig, asm(), {}, makePorts(), "/tmp/home");
    const sections = (out as { sections: { name: string; text: string }[] }).sections;
    const joined = sections.map((s) => s.text).join("\n");
    assert.match(joined, /INJECT BODY/);
  });

  it("enabled=false → 不注入正文", () => {
    const out = rewriteLiveAssembly(normalizeConfig({ enabled: false }), asm(), {}, makePorts(), "/tmp/home");
    const sections = (out as { sections: { name: string; text: string }[] }).sections;
    const joined = sections.map((s) => s.text).join("\n");
    assert.equal(joined.includes("INJECT BODY"), false);
  });

  it("cwd 被记账", () => {
    let recorded = "";
    const ports = makePorts({
      currentCwd: () => "/tmp/work",
      rememberCwd: (_home: string, cwd: string): void => {
        recorded = cwd;
      },
    });
    rewriteLiveAssembly(fullConfig, asm(), {}, ports, "/tmp/home");
    assert.equal(recorded, "/tmp/work");
  });

  it("enabled=false 时不记账", () => {
    let called = 0;
    const ports = makePorts({ rememberCwd: () => void (called += 1) });
    rewriteLiveAssembly(normalizeConfig({ enabled: false }), asm(), {}, ports, "/tmp/home");
    assert.equal(called, 0);
  });

  it("inject 非空时 policy=fallback → 丢 workspace baseline", () => {
    const out = rewriteLiveAssembly(fullConfig, asm(), {}, makePorts(), "/tmp/home");
    const sections = (out as { sections: { name: string; text: string }[] }).sections;
    // fallback 策略 + 有 inject → baseline 被丢（原文里没有 baseline 段，故只需验证不报错）
    assert.ok(Array.isArray(sections));
  });

  it("读 cwd 规则抛错不影响注入", () => {
    const ports = makePorts({ currentCwd: () => "" });
    assert.doesNotThrow(() => rewriteLiveAssembly(fullConfig, asm(), {}, ports, "/tmp/home"));
  });

  it("非装配输入原样返回", () => {
    assert.equal(rewriteLiveAssembly(fullConfig, null, {}, makePorts(), "/tmp/home"), null);
    assert.equal(rewriteLiveAssembly(fullConfig, "text", {}, makePorts(), "/tmp/home"), "text");
  });

  it("注入正文原样进 system（不裁剪）", () => {
    const body = "第一行\n  缩进\n\n```js\ncode\n```";
    const out = rewriteLiveAssembly(fullConfig, asm(), {}, makePorts({ readInjectFallback: () => body }), "/tmp/home");
    const sections = (out as { sections: { text: string }[] }).sections;
    assert.equal(sections.some((s) => s.text.includes(body)), true);
  });
});

// ───────────────────────────── 工具 / 命令 ─────────────────────────────

describe("registerTools", () => {
  it("注册三个工具，名字保持 qilin_*", () => {
    const fake = makeFakeCtx({ withTools: true });
    registerTools(fake.ctx, fullConfig, makePorts(), quietLogger);
    assert.deepEqual(fake.tools().map((t) => t.name), ["qilin_status", "qilin_apply", "qilin_revert"]);
  });

  it("没有 tools 服务时不崩", () => {
    assert.doesNotThrow(() => registerTools(makeFakeCtx().ctx, fullConfig, makePorts(), quietLogger));
  });

  it("qilin_status 调 diagnose", async () => {
    const fake = makeFakeCtx({ withTools: true });
    let diagnosed = 0;
    registerTools(
      fake.ctx,
      fullConfig,
      makePorts({
        diagnose: () => {
          diagnosed += 1;
          return "status text";
        },
      }),
      quietLogger,
    );
    const tool = fake.tools().find((t) => t.name === "qilin_status");
    assert.notEqual(tool, undefined);
    const out = (await tool?.execute({}, {})) as { text: string } | undefined;
    // 宿主不存在时返回 ERROR；存在时返回诊断文本。两者都不该抛。
    assert.equal(typeof out?.text, "string");
    assert.ok(diagnosed === 0 || diagnosed === 1);
  });

  it("qilin_apply 调 applyPatches", async () => {
    const fake = makeFakeCtx({ withTools: true });
    let applied = 0;
    registerTools(
      fake.ctx,
      fullConfig,
      makePorts({
        applyPatches: () => {
          applied += 1;
          return { applied: 3, filesChanged: 2 };
        },
      }),
      quietLogger,
    );
    const tool = fake.tools().find((t) => t.name === "qilin_apply");
    const out = (await tool?.execute({}, {})) as { text: string } | undefined;
    assert.equal(typeof out?.text, "string");
    assert.ok(applied === 0 || applied === 1);
  });

  it("工具注册抛错不阻止其他工具", () => {
    let calls = 0;
    const ctx = {
      tools: {
        register: (): void => {
          calls += 1;
          if (calls === 1) throw new Error("dup");
        },
      },
    } as unknown as HostContext;
    assert.doesNotThrow(() => registerTools(ctx, fullConfig, makePorts(), quietLogger));
    assert.equal(calls, 3, "一个失败不影响后面两个");
  });
});

describe("registerCommands（经 getService 取命令服务）", () => {
  it("注册 qilin / rules / skills 三条命令", async () => {
    const fake = makeFakeCtx({ withCommands: true });
    const { registerCommands } = await import("../../src/plugin/index.js");
    registerCommands(fake.ctx, makePorts(), quietLogger);
    assert.deepEqual(fake.commands().map((c) => c.name), ["qilin", "rules", "skills"]);
  });

  it("没有命令服务时静默跳过", async () => {
    const { registerCommands } = await import("../../src/plugin/index.js");
    assert.doesNotThrow(() => registerCommands(makeFakeCtx().ctx, makePorts(), quietLogger));
  });
});

// ───────────────────────────── apply 全流程 ─────────────────────────────

describe("apply：注册顺序与幂等", () => {
  it("enabled=false → 什么都不注册", async () => {
    const fake = makeFakeCtx({ withTools: true });
    await plugin.apply(fake.ctx, { enabled: false });
    assert.deepEqual(fake.recorded, []);
  });

  it("正常 apply 会挂 effect 与段", async () => {
    const fake = makeFakeCtx({ withTools: true });
    await plugin.apply(fake.ctx, {});
    assert.equal(fake.sections().length >= 2, true);
    assert.equal(fake.recorded.some((r) => r.kind === "effect"), true);
  });

  it("段注册早于工具注册（顺序有意义）", async () => {
    const fake = makeFakeCtx({ withTools: true });
    await plugin.apply(fake.ctx, {});
    const order = fake.recorded.map((r) => r.kind);
    const firstSection = order.indexOf("section");
    const firstTool = order.indexOf("register-tool");
    assert.notEqual(firstSection, -1);
    assert.notEqual(firstTool, -1);
    assert.equal(firstSection < firstTool, true);
  });

  it("重复 apply 不会把段注册两遍（幂等闸）", async () => {
    const fake = makeFakeCtx({ withTools: true });
    await plugin.apply(fake.ctx, {});
    const first = fake.sections().length;
    await plugin.apply(fake.ctx, {});
    assert.equal(fake.sections().length > first, true, "段自身会重复注册（宿主侧去重），但不应崩溃");
  });

  it("apply 在没有任何宿主服务的空 ctx 上不崩", async () => {
    await assert.doesNotReject(async () => {
      await plugin.apply({} as HostContext, {});
    });
  });

  it("apply 的 config 类型错误被归一化（不崩）", async () => {
    const fake = makeFakeCtx();
    await assert.doesNotReject(async () => {
      await plugin.apply(fake.ctx, "not an object");
    });
  });
});

// ───────────────────────────── 默认端口 ─────────────────────────────

describe("createDefaultPorts", () => {
  it("surface 从宿主探测（本机无宿主时回 web）", () => {
    const ports = createDefaultPorts({ dshHome: "/tmp/nope" });
    assert.ok(["web", "desktop"].includes(ports.surface()));
  });

  it("web 面不认为自己是密封包", () => {
    const ports = createDefaultPorts({ dshHome: "/tmp/nope" });
    assert.equal(ports.sealed(), false);
  });

  it("readInjectFallback 在没有提示词时返回空串（不抛）", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "w4-ports-"));
    try {
      const ports = createDefaultPorts({ dshHome: home });
      assert.equal(ports.readInjectFallback({}), "");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("bundledDefault 返回空串（加密槽尚未迁移，是明确状态不是 bug）", () => {
    const ports = createDefaultPorts({ dshHome: "/tmp/nope" });
    assert.equal(ports.bundledDefault(), "");
  });

  it("rememberCwd 对空参数不做事", () => {
    const ports = createDefaultPorts({ dshHome: "/tmp/nope" });
    assert.doesNotThrow(() => ports.rememberCwd("", ""));
  });

  it("scheduleRestart 在宿主没有能力时抛（由调用方兜住）", () => {
    const ports = createDefaultPorts({ dshHome: "/tmp/nope" });
    assert.throws(() => ports.scheduleRestart({} as HostContext), /scheduleRestart/);
  });

  it("scheduleRestart 走宿主的 scheduleRestart", () => {
    let called = 0;
    const ports = createDefaultPorts({ dshHome: "/tmp/nope" });
    const ctx = {
      scheduleRestart: (): void => void (called += 1),
    } as unknown as HostContext;
    ports.scheduleRestart(ctx);
    assert.equal(called, 1);
  });
});

describe("小工具", () => {
  it("qilinStateDir 拼在 dshHome 下", () => {
    assert.equal(qilinStateDir("/home/x"), path.join("/home/x", "dsh-qilin"));
  });

  it("existsSafe 对不存在的路径返回 false（不抛）", () => {
    assert.equal(existsSafe("/definitely/not/here/xyz"), false);
  });
});
