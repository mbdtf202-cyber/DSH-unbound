/**
 * 插件入口：把 identity / rules / skills / settle 装到宿主上。
 *
 * ## 与原实现的差别（都是「去掉无法类型化的部分」，不是改行为）
 *
 * 1. **不再访问 `ctx.agentPresets` / `ctx.permissionPresets` / `ctx.agents` 等未声明属性**。
 *    原实现靠 Proxy 的 try/catch 探测；这里统一走 `getService(ctx, name)`，
 *    类型上就不可能写出静默 any。
 * 2. **`__dshQilin*` 私有钩子集中在 `hooks.ts`**，不散落在业务逻辑里。
 * 3. **补丁写入走 engine**（`applyPatches`），不再自带一套 `core.applyPatches`。
 *    engine 有幂等性契约与测试；原实现在这里重复实现了两遍。
 *
 * ## 与原实现**完全一致**的部分
 *
 * - `name` / `inject` 的取值，以及「不要把 pluginPackages 写进 inject」那条注释。
 * - guard 的挂载时机（init / sessionCreated / presetSelected / preStep / 400ms 心跳）。
 * - 段注册的三段（inject / cap / post）。
 * - 命令与工具的名字、描述、参数形态。
 * - settle 的时序：延时 → 判活 → 跑规则初始化的并行分支。
 */
import fs from "node:fs";
import path from "node:path";
import { applyPatches } from "../engine/apply.js";
import { diagnoseAll, formatDriftReport } from "../engine/drift.js";
import { loadBundledPatches } from "../patches/load.js";
import { findDshHome, findHost } from "../host/discover.js";
import { getService } from "../host-api/types.js";
import type {
  HostContext,
  PluginModule,
  ToolDefinition,
  ToolParamDecl,
} from "../host-api/types.js";
import { CAPABILITY_SECTION, capabilityProtocolText } from "./capability-protocol.js";
import {
  GLOBAL_PROMPT_ORDER,
  installAssembleGuard,
  isChildAgentContext,
  isRedteamSession,
  rewritePromptAssembly,
  type AssembleRewrite,
} from "./identity.js";
import { InjectRefreshCache, PromptState } from "./prompt-state.js";
import {
  createLastCwdMemo,
  ensureInitialState,
  readSelectedCwdInject,
  readWorkspacePolicy,
  rulesStatus,
  writeLastCwd,
  type LastCwdMemo,
} from "./rules.js";
import {
  applyShouldRestart,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
  type ContextLife,
  type Surface,
} from "./settle-policy.js";
import { listSkills, skillsStatus, type SkillsStatus } from "./skills.js";

/**
 * 插件名。
 *
 * 保持 `dsh-qilin` 而不是改成 `dsh-unbound`：宿主按名字做段过滤
 * （`startsWith("dsh-qilin")`），改名会让 `dsh-qilin` / `dsh-qilin:post` 段失去
 * 「提到最前」的语义。段名本身也是外部契约（用户预设里可能引用）。
 */
export const name = "dsh-qilin";

/**
 * 声明依赖的服务。
 *
 * ## 千万不要把 pluginPackages 写进 inject
 *
 * Cordis 会对 inject 里**每一个 key** 空等（pending）。便携拷贝 / Hub 残装
 * 经常没有 `pluginPackages` 这项服务，一写进去就是永久的 pending →
 * 宿主启动超时 → **退出码 1**。原项目为此排查过一整轮。
 *
 * 只声明真正每套宿主都有的两项。
 */
export const inject = ["systemPrompt", "tools"] as const;

/** 插件配置（全部有默认值）。 */
export interface PluginConfig {
  readonly enabled?: boolean;
  /** 启动时自动写补丁。默认关：启动不写宿主包。 */
  readonly autoApplyOnStart?: boolean;
  /** 关掉 mnemon 消息/段。默认开。 */
  readonly stripMnemon?: boolean;
  /** 额外追加的提示词段正文。 */
  readonly postPrompt?: string;
  /** 追加段的 order，必须 > GLOBAL_PROMPT_ORDER。 */
  readonly postPromptOrder?: number;
  /** 打日志。 */
  readonly verbose?: boolean;
  /** 能力选用协议段。默认开。 */
  readonly capabilityProtocol?: boolean;
  /** 建议的宿主面（不给就按宿主探测）。 */
  readonly surface?: Surface;
}

const DEFAULTS: Required<Omit<PluginConfig, "surface">> & { surface: Surface } = {
  enabled: true,
  autoApplyOnStart: false,
  stripMnemon: true,
  postPrompt: "",
  postPromptOrder: 5100,
  verbose: false,
  capabilityProtocol: true,
  surface: "web",
};

/** 归一化配置：未知字段丢弃，类型错的字段回默认。 */
export function normalizeConfig(raw: unknown): Required<PluginConfig> {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (key: string, fallback: boolean): boolean => {
    const value = record[key];
    return typeof value === "boolean" ? value : fallback;
  };
  const str = (key: string, fallback: string): string => {
    const value = record[key];
    return typeof value === "string" ? value : fallback;
  };
  const num = (key: string, fallback: number): number => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const surfaceRaw = record["surface"];
  const surface: Surface = surfaceRaw === "desktop" || surfaceRaw === "web" ? surfaceRaw : DEFAULTS.surface;
  return {
    enabled: bool("enabled", DEFAULTS.enabled),
    autoApplyOnStart: bool("autoApplyOnStart", DEFAULTS.autoApplyOnStart),
    stripMnemon: bool("stripMnemon", DEFAULTS.stripMnemon),
    postPrompt: str("postPrompt", DEFAULTS.postPrompt),
    postPromptOrder: num("postPromptOrder", DEFAULTS.postPromptOrder),
    verbose: bool("verbose", DEFAULTS.verbose),
    capabilityProtocol: bool("capabilityProtocol", DEFAULTS.capabilityProtocol),
    surface,
  };
}

// ───────────────────────────── 宿主调用窄化 ─────────────────────────────

/**
 * `ctx.on` 的**完整**签名。
 *
 * `src/host-api/types.ts` 里只声明了两参形态（那是共享只读层，本工作流不改）。
 * 真实宿主支持第三参 `{ global, prepend }`——原实现大量依赖 `prepend: true`
 * 才能在别的插件之前改装配。这里本地窄化一次，调用点就不必逐个 cast。
 */
interface EventOptions {
  readonly global?: boolean;
  readonly prepend?: boolean;
}

/** 能注册「带选项事件」的 ctx。 */
interface CtxWithEventOptions {
  on(event: string, listener: (...args: unknown[]) => unknown, options?: EventOptions): unknown;
}

/** 窄化成带事件选项的形态；不支持就返回 null。 */
function eventCapable(ctx: HostContext): CtxWithEventOptions | null {
  if (typeof ctx.on !== "function") return null;
  return ctx as unknown as CtxWithEventOptions;
}

/** 安全执行一次 effect；ctx 已死时返回 false 而不是抛。 */
function runEffect(ctx: HostContext, fn: () => void | (() => void)): boolean {
  const effect = ctx.effect;
  if (typeof effect !== "function") return false;
  try {
    effect.call(ctx, fn);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── 私有钩子 ─────────────────────────────

/**
 * 本插件在 ctx 上记的「已安装」标记。
 *
 * 为什么需要：`installXxx(ctx)` 可能被同一 ctx 二次调用（dispose 后重 mount /
 * 热重载）。没有幂等闸，listener 会叠加，inject 跑 N 遍、wrap 挂 N 层。
 *
 * 全部收在这里（而不是像原实现那样散落在各 install 函数里），
 * 是为了让「哪些状态挂在宿主对象上」一眼可见。
 */
const HOOK_FLAGS = {
  session: "__dshQilinSessionHook",
  preset: "__dshQilinPresetHook",
  preStep: "__dshQilinPreStepHook",
  assemble: "__dshQilinAssembleHook",
  cwd: "__dshQilinCwdCapture",
  fullPin: "__dshQilinFullPin",
  mnemon: "__dshQilinMnemonStrip",
} as const;

type HookFlag = (typeof HOOK_FLAGS)[keyof typeof HOOK_FLAGS];

interface FlagHost {
  [key: string]: unknown;
}

/** 读 flag（吞异常：Proxy 可能在未 inject 时抛）。 */
function hasFlag(ctx: HostContext, flag: HookFlag): boolean {
  try {
    return (ctx as unknown as FlagHost)[flag] === true;
  } catch {
    return false;
  }
}

/** 置 flag（吞异常：同上）。 */
function setFlag(ctx: HostContext, flag: HookFlag): void {
  try {
    (ctx as unknown as FlagHost)[flag] = true;
  } catch {
    /* 不可写时靠幂等 install 自身兜底 */
  }
}

function clearFlag(ctx: HostContext, flag: HookFlag): void {
  try {
    delete (ctx as unknown as FlagHost)[flag];
  } catch {
    /* ignore */
  }
}

// ───────────────────────────── 日志 ─────────────────────────────

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** 从 ctx 取 logger，字段缺失时退化成 no-op / console.warn。 */
export function makeLogger(ctx: HostContext, verbose: boolean): Logger {
  const logger = ctx.logger;
  return {
    debug(message: string, ...args: unknown[]): void {
      if (!verbose) return;
      if (typeof logger?.debug === "function") logger.debug(message, ...args);
      else if (typeof logger?.info === "function") logger.info(message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      if (typeof logger?.warn === "function") logger.warn(message, ...args);
      else console.warn(message, ...args);
    },
  };
}

// ───────────────────────────── 生命期 ─────────────────────────────

/**
 * 观察 ctx 生命期。
 *
 * `ctx.effect(fn)` 返回 disposer；插件 unload 时宿主调用它，`alive` 变 false。
 * settle 里每个 `await` 之后都要查一次——`ctx` 可能在 await 期间被 dispose，
 * 之后任何 `ctx.scheduleRestart` 都会命中 `INACTIVE_EFFECT`。
 */
export function watchContextLife(ctx: HostContext, logger: Logger): ContextLife {
  const life: ContextLife = { alive: true };
  const effect = ctx.effect;
  if (typeof effect !== "function") return life;
  try {
    effect.call(ctx, () => () => {
      life.alive = false;
    });
  } catch (error) {
    // ctx 已经死了：life 直接判死，让调用方跳过后续所有宿主交互。
    if (isInactiveContextError(error)) {
      life.alive = false;
      return life;
    }
    logger.warn("[dsh-unbound] watchContextLife failed", String(error));
  }
  return life;
}

// ───────────────────────────── 段注册 ─────────────────────────────

/** 一个待注册的提示词段。 */
export interface PromptSectionSpec {
  readonly name: string;
  readonly order: number;
  readonly interpolate?: boolean;
  readonly text: (context?: unknown) => string;
}

/** 宿主 systemPrompt 服务的窄化形态。 */
interface SystemPromptFace {
  readonly ctx?: unknown;
  section?(spec: PromptSectionSpec): unknown;
}

/**
 * 注册一个提示词段。
 *
 * ## 为什么同时往两个 host 上试
 *
 * 提示词服务自己的 `ctx` 多半没有 scope，段会进全局层；插件若挂在某个 scope 上，
 * 预设代理的父链看不到那一层。所以先试 `ctx.systemPrompt.ctx`，再试 `ctx` 本身。
 *
 * 「already registered」不是错误——宿主在热重载后重复挂段是正常的，
 * 当成成功（否则每次重载都会打一条误导性的错误日志）。
 */
export function addPromptSection(ctx: HostContext, spec: PromptSectionSpec, logger: Logger): void {
  const hosts: unknown[] = [];
  const push = (host: unknown): void => {
    if (host !== null && host !== undefined && !hosts.includes(host)) hosts.push(host);
  };
  const ownPrompt = readSystemPrompt(ctx);
  if (ownPrompt !== null && ownPrompt.ctx !== undefined) push(ownPrompt.ctx);
  push(ctx);

  const disposers: (() => void)[] = [];
  let registered = false;
  let lastError: unknown = null;
  for (const host of hosts) {
    const prompt = readSystemPrompt(host);
    if (prompt === null || typeof prompt.section !== "function") continue;
    try {
      const disposer = prompt.section(spec);
      registered = true;
      if (typeof disposer === "function") disposers.push(disposer as () => void);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already registered")) registered = true;
      else lastError = error;
    }
  }
  if (!registered && lastError !== null) {
    logger.warn("[dsh-unbound] prompt section register failed:", String(lastError));
  }
  // 让 ctx.effect 在 reload / dispose 时把 section 一并撤掉。
  // 宿主的 `systemPrompt.section` 当前多半不返回 disposer，这段只对返回函数的实现生效。
  if (disposers.length > 0) {
    runEffect(ctx, () => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* 单个段撤销失败不影响其他段 */
        }
      }
    });
  }
}

/** 从宿主对象读 systemPrompt（Proxy 可能抛）。 */
function readSystemPrompt(host: unknown): SystemPromptFace | null {
  if (host === null || (typeof host !== "object" && typeof host !== "function")) return null;
  try {
    const prompt = (host as { systemPrompt?: unknown }).systemPrompt;
    if (prompt === null || typeof prompt !== "object") return null;
    return prompt as SystemPromptFace;
  } catch {
    return null;
  }
}

/**
 * 注册插件自己的三段：inject / 能力协议 / 可选的追加段。
 *
 * `text` 是**惰性**的：宿主每轮装配时才调，因此用户改了 prompt-inject.md
 * 不必重启就生效。这是原实现的核心机制，不能改成注册时求值。
 */
export function registerPromptSections(
  ctx: HostContext,
  config: Required<PluginConfig>,
  ports: PluginPorts,
  logger: Logger,
): void {
  addPromptSection(
    ctx,
    {
      name: "dsh-qilin",
      order: GLOBAL_PROMPT_ORDER,
      interpolate: false,
      text: (context?: unknown): string => {
        if (config.enabled !== true) return "";
        return ports.readInjectFallback(context);
      },
    },
    logger,
  );

  if (config.capabilityProtocol) {
    addPromptSection(
      ctx,
      {
        name: CAPABILITY_SECTION,
        order: GLOBAL_PROMPT_ORDER + 1,
        interpolate: false,
        text: (context?: unknown): string => {
          if (config.enabled !== true) return "";
          const redteam = isRedteamSession(context);
          return capabilityProtocolText({
            redteam,
            redteamChild: redteam && isChildAgentContext(context),
            enabled: true,
          });
        },
      },
      logger,
    );
  }

  const postPrompt = config.postPrompt.trim();
  if (postPrompt === "") return;
  if (!Number.isFinite(config.postPromptOrder) || config.postPromptOrder <= GLOBAL_PROMPT_ORDER) {
    // 旧版在这里 throw 会把整个 apply 炸掉；postPrompt 只是附加段，
    // 降级 skip 不影响核心注入。
    logger.warn(
      `[dsh-unbound] postPromptOrder (${config.postPromptOrder}) 需要是 > ${GLOBAL_PROMPT_ORDER} 的有限数；跳过 postPrompt 段`,
    );
    return;
  }
  addPromptSection(
    ctx,
    {
      name: "dsh-qilin:post",
      order: config.postPromptOrder,
      text: (): string => (config.enabled === true ? postPrompt : ""),
    },
    logger,
  );
}

// ───────────────────────────── 依赖端口 ─────────────────────────────

/**
 * 插件运行所需的「外部世界」端口。
 *
 * 抽出来的理由：这些能力一半来自宿主（ctx），一半来自尚未迁移的 core.js
 * （加密默认稿、补丁落盘）。做成端口后，插件层可以纯内存测试，
 * 等 core 迁移完成只需替换实现。
 */
export interface PluginPorts {
  /** 当前注入正文（磁盘 > 内存提交 > 内置默认）。 */
  readInjectFallback(context: unknown): string;
  /** 内置默认稿（加密槽）。 */
  bundledDefault(): string;
  /** 当前 cwd。 */
  currentCwd(context: unknown): string;
  /** 写 cwd 记账。 */
  rememberCwd(dshHome: string, cwd: string): void;
  /** 应用补丁；返回是否真的写了文件。 */
  applyPatches(aiBase: string): { readonly applied: number; readonly filesChanged: number };
  /** 诊断补丁状态。 */
  diagnose(aiBase: string): string;
  /** 重启宿主（桌面密封包与 web 走不同后端）。 */
  scheduleRestart(ctx: HostContext): void;
  /** 宿主面。 */
  surface(): Surface;
  /** 是否是密封 asar。 */
  sealed(): boolean;
  /** 规则集初始状态自检。 */
  ensureRulesInitialState(dshHome: string): Promise<{ readonly active: string | null }>;
  /** 停用时清掉指向本插件预设的 selectedDefault。 */
  clearOwnedPreset?(ctx: HostContext, dshHome: string): void;
}

/** 从 context 里取会话对象（宿主形态不一）。 */
export function contextCwd(context: unknown): string {
  if (context === null || typeof context !== "object") return "";
  try {
    const agent = (context as { agent?: unknown }).agent;
    const session = (agent as { session?: unknown } | null)?.session;
    const header = (session as { header?: unknown } | null)?.header;
    const cwd = (header as { cwd?: unknown } | null)?.cwd;
    return typeof cwd === "string" ? cwd.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 默认端口实现：接 engine + host 层。
 *
 * 这些是**真实行为**（会写盘），只在真实宿主里用。测试注入内存端口。
 */
export function createDefaultPorts(options: { readonly dshHome?: string } = {}): PluginPorts {
  const dshHomeOf = (): string => options.dshHome ?? findDshHome();
  const promptState = new PromptState({
    bundledDefault: () => {
      // 加密默认稿尚未迁移（在 core.js 的 4,915 行里）。
      // 返回空串是**明确状态**：resolve() 会给出 source:"none"，
      // 上层据此提示「提示词和规则集都是空的」，而不是静默注入空段。
      return "";
    },
  });
  const cache = new InjectRefreshCache({ state: promptState });
  const memo: LastCwdMemo = createLastCwdMemo();

  return {
    readInjectFallback(context: unknown): string {
      const home = dshHomeOf();
      const refreshed = cache.refresh(home);
      if (refreshed.text !== "") return refreshed.text;
      const ensured = promptState.ensureOperatorBody(home);
      if (ensured !== "") return ensured;
      // 提示词为空时才启用勾选的 cwd 规则兜底，避免与 prompt-inject.md 叠加污染。
      const cwd = contextCwd(context);
      if (cwd === "") return "";
      try {
        return readSelectedCwdInject(home, cwd);
      } catch {
        return "";
      }
    },
    bundledDefault: (): string => promptState.bundledDefault(),
    currentCwd: (context: unknown): string => contextCwd(context),
    rememberCwd(home: string, cwd: string): void {
      if (home === "" || cwd === "") return;
      try {
        // writeLastCwd 有进程内去重：assemble 空闲时每秒 7~9 次调用。
        writeLastCwd(home, cwd, memo);
      } catch {
        /* 记账失败不影响注入 */
      }
    },
    applyPatches(aiBase: string): { applied: number; filesChanged: number } {
      const patches = loadBundledPatches();
      const report = applyPatches(patches, aiBase);
      return { applied: report.summary.applied, filesChanged: report.summary.filesChanged };
    },
    diagnose(aiBase: string): string {
      const patches = loadBundledPatches();
      return formatDriftReport(diagnoseAll(patches, aiBase));
    },
    scheduleRestart(ctx: HostContext): void {
      // 宿主暴露 scheduleRestart 时直接用；否则记录一条（重启是可选增强）。
      if (typeof ctx.scheduleRestart === "function") {
        ctx.scheduleRestart();
        return;
      }
      throw new Error("host does not expose scheduleRestart");
    },
    surface(): Surface {
      const host = findHost();
      return host === null ? "web" : host.surface;
    },
    sealed(): boolean {
      // 密封 asar 检测在 core.js（未迁移）。web 面恒为 false。
      return false;
    },
    ensureRulesInitialState(home: string): Promise<{ readonly active: string | null }> {
      return ensureInitialState(home);
    },
    clearOwnedPreset(ctx: HostContext): void {
      void ctx;
    },
  };
}

// ───────────────────────────── 装配改写 ─────────────────────────────

/**
 * 一次装配改写的决策（仅用于日志，不参与行为）。
 *
 * 保留原实现的字段名，方便对照日志。
 */
export interface AssembleDecision {
  readonly mode: "full";
  readonly taskKind: "general";
  readonly lastRole: string;
  readonly isSubagent: boolean;
}

/**
 * 三条路都全文注入。不读 inbox、不改 steer/followup，避免误唤醒。
 */
export function shouldInjectAssembly(context: unknown): AssembleDecision {
  const decision = { mode: "full" as const, taskKind: "general" as const, lastRole: "full", isSubagent: false };
  let isSubagent = false;
  try {
    isSubagent = isChildAgentContext(context);
  } catch {
    /* 拿不到会话就当主代理 */
  }
  return { ...decision, isSubagent };
}

/**
 * 实时装配改写：算出 inject，然后交给 `rewritePromptAssembly`。
 *
 * 与原实现一致的关键顺序：
 *   1. 先判 enabled（关掉时 inject 为空、也不写 cwd 记账）；
 *   2. 写 cwd 记账（无论是否有 inject）；
 *   3. 读 workspace policy；
 *   4. **只有 inject 为空时**才用勾选的 cwd 规则兜底；
 *   5. 按 policy 决定是否丢 workspace baseline；
 *   6. 红队才取角色稿。
 */
export function rewriteLiveAssembly(
  config: Required<PluginConfig>,
  assembled: unknown,
  context: unknown,
  ports: PluginPorts,
  dshHome: string,
): unknown {
  const enabled = config.enabled === true;
  const redteam = enabled && isRedteamSession(context);
  const full = enabled ? ports.readInjectFallback(context) : "";
  let cwd = "";
  try {
    cwd = ports.currentCwd(context);
  } catch {
    cwd = "";
  }
  if (enabled && dshHome !== "" && cwd !== "") {
    try {
      ports.rememberCwd(dshHome, cwd);
    } catch {
      /* ignore */
    }
  }
  const policy = enabled && dshHome !== "" ? readWorkspacePolicy(dshHome) : "always";
  // 提示词框为空时才启用勾选的本地 cwd 规则兜底，避免跟 prompt-inject.md 叠加污染。
  let localInject = "";
  if (enabled && dshHome !== "" && full.trim() === "") {
    try {
      localInject = readSelectedCwdInject(dshHome, cwd);
    } catch {
      /* ignore */
    }
  }
  const inject = full.trim() !== "" ? full : localInject;
  const hasInject = inject.trim() !== "";
  let dropWorkspaceBaseline = false;
  if (enabled) {
    if (policy === "strict") dropWorkspaceBaseline = true;
    else if (policy === "fallback") dropWorkspaceBaseline = hasInject;
    else dropWorkspaceBaseline = false;
  }
  return rewritePromptAssembly(assembled, {
    fallbackInject: inject,
    dropMnemon: config.stripMnemon,
    capabilityProtocol: config.capabilityProtocol,
    context,
    roleText: "",
    cardText: "",
    dropWorkspaceBaseline,
  });
}

// ───────────────────────────── 装配守卫安装 ─────────────────────────────

/**
 * 安装 `system-prompt/assemble` 的事件钩子 + 400ms 心跳守卫。
 *
 * ## 为什么两个都要
 *
 * - 事件钩子负责「这一轮已经存在的装配」；
 * - 心跳负责「宿主换了 systemPrompt 代理之后重新包上」。
 *   切换预设会换掉 `assemble`；pre-step 瀑布在 assemble 之后才跑，
 *   只靠 pre-step 会漏掉本轮第一次发送。
 *
 * ## 400ms 而不是 2000ms
 *
 * 2000ms 窗口下新对话第一次 assemble 可能跑在钩子挂上之前 → inject 塌。
 * 幂等 wrap（WeakSet + 对象 identity）的 CPU 代价相比「新对话失效」不值一提。
 */
export function installIdentityOverride(
  ctx: HostContext,
  config: Required<PluginConfig>,
  ports: PluginPorts,
  dshHome: string,
  logger: Logger,
): void {
  if (typeof ctx.on !== "function") return;

  // installAssembleGuard 幂等：已挂 slot 的 prompt 只刷新 rewriteFn。
  // 原实现每 400ms + 每 pre-step 都 push 一个 noop closure 进 Set，
  // 2 小时 session 累积上万条。这里用 WeakSet 只 track 首次真正挂上的 disposer。
  const wrapDisposers = new Set<() => void>();
  const wrappedPrompts = new WeakSet<object>();

  const trackDisposer = (disposer: unknown, prompt: unknown): void => {
    if (typeof disposer !== "function") return;
    if (prompt !== null && typeof prompt === "object") {
      if (wrappedPrompts.has(prompt)) return;
      wrappedPrompts.add(prompt);
    }
    wrapDisposers.add(disposer as () => void);
  };

  const rewriteFn: AssembleRewrite = (assembled, context) =>
    rewriteLiveAssembly(config, assembled, context, ports, dshHome);

  const wrapAssemble = (caller: string): void => {
    try {
      const prompt = readSystemPrompt(ctx);
      const disposer = installAssembleGuard(prompt, rewriteFn);
      trackDisposer(disposer, prompt);
    } catch (error) {
      logger.debug(`[dsh-unbound] guard.wrap failed (${caller})`, String(error));
    }
  };

  if (!hasFlag(ctx, HOOK_FLAGS.assemble)) {
    setFlag(ctx, HOOK_FLAGS.assemble);
    // cordis 不同版本的 waterfall 可能是 (assembly, context) 或 (assembly, context, next)，
    // 所以取最后一个参数判断是不是 next，而不是固定拿第 3 位。
    const bus = eventCapable(ctx);
    try {
      bus?.on(
        "system-prompt/assemble",
        async (...args: unknown[]): Promise<unknown> => {
          const assembly = args[0];
          const context = args[1];
          const next = args.length >= 3 ? args[args.length - 1] : null;
          let assembled = assembly;
          if (typeof next === "function") {
            try {
              assembled = await (next as () => Promise<unknown>)();
            } catch (error) {
              // 下游 waterfall 任一环节抛就会把整条 assemble 弄死，UI 卡住发不出去。
              // 吞掉改用上游装配兜底，inject 保底能挂上。
              logger.warn("[dsh-unbound] system-prompt/assemble waterfall rejected:", String(error));
              assembled = assembly;
            }
          }
          try {
            return rewriteLiveAssembly(config, assembled, context, ports, dshHome);
          } catch (error) {
            logger.warn("[dsh-unbound] rewriteLiveAssembly failed:", String(error));
            return assembled;
          }
        },
        { global: true, prepend: true },
      );
    } catch (error) {
      logger.debug("[dsh-unbound] assemble hook not installed", String(error));
    }
  }

  wrapAssemble("init");
  const timer = setInterval(() => wrapAssemble("interval"), 400);
  if (typeof timer.unref === "function") timer.unref();

  if (!hasFlag(ctx, HOOK_FLAGS.session)) {
    setFlag(ctx, HOOK_FLAGS.session);
    try {
      eventCapable(ctx)?.on("session/created", () => {
        wrapAssemble("sessionCreated");
      });
    } catch {
      /* ignore */
    }
  }
  if (!hasFlag(ctx, HOOK_FLAGS.preset)) {
    setFlag(ctx, HOOK_FLAGS.preset);
    try {
      eventCapable(ctx)?.on("agent-preset/selected", () => wrapAssemble("presetSelected"), { global: true });
    } catch {
      /* ignore */
    }
  }
  if (!hasFlag(ctx, HOOK_FLAGS.preStep)) {
    setFlag(ctx, HOOK_FLAGS.preStep);
    try {
      eventCapable(ctx)?.on(
        "agent/pre-step",
        (...args: unknown[]): unknown => {
          wrapAssemble("preStep");
          const next = args[args.length - 1];
          if (typeof next === "function") return (next as () => unknown)();
          return args[0];
        },
        { global: true, prepend: true },
      );
    } catch {
      /* ignore */
    }
  }

  // 热重载/卸载时统一回收：轮询 timer、guard 代理层、flag。
  runEffect(ctx, () => () => {
      clearInterval(timer);
      for (const dispose of wrapDisposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      wrapDisposers.clear();
      // 清 flag，下次 apply 允许重新挂 listener；不然 ctx 复用时沉默无响应。
      clearFlag(ctx, HOOK_FLAGS.session);
      clearFlag(ctx, HOOK_FLAGS.preset);
      clearFlag(ctx, HOOK_FLAGS.preStep);
      // AssembleHook 也要清。原实现漏删 → ctx 复用时新 apply 看到 flag=true
      // 直接跳过 ctx.on("system-prompt/assemble") → 新对话首轮完全依赖 400ms 心跳，
      // 时间窗没赶上就 inject 真空。
      clearFlag(ctx, HOOK_FLAGS.assemble);
  });
}

// ───────────────────────────── settle ─────────────────────────────

/** settle 的结果码（与原实现同名，便于日志对照）。 */
export type SettleResult =
  | "skip:inactive"
  | "skip:boot-no-host-write"
  | "skip:sealed-wait-apply"
  | "already-clean"
  | "reapplied-no-restart"
  | "full-quit"
  | "reapplied"
  | "restart-failed"
  | "reapply-failed"
  | "restarting"
  | "applied";

/**
 * 启动落定。
 *
 * 与原实现一致的两条铁律：
 *   1. `autoApplyOnStart !== true` 时**启动绝不写宿主包**（只在用户点「应用」时写）。
 *   2. 密封桌面在 settle 阶段不重打、不重启（会和官方 `Fiber._reload` 抢锁）。
 *
 * 每个 `await` 之后都再查一次 `life.alive`：ctx 可能在等待中被 dispose，
 * 之后任何宿主调用都会命中 `INACTIVE_EFFECT`。
 */
export async function settleInstalledPatches(
  config: Required<PluginConfig>,
  ctx: HostContext,
  life: ContextLife,
  ports: PluginPorts,
  logger: Logger,
): Promise<SettleResult> {
  if (!life.alive) return "skip:inactive";

  const aiBase = portsSeekAiBase(ports);
  if (aiBase === null) {
    logger.debug("[dsh-unbound] settle: plugin root not found");
    return "skip:boot-no-host-write";
  }

  if (!config.autoApplyOnStart) {
    // 启动不写宿主包：补丁 / bak / client.js 只在点「应用」时写一次。
    logger.debug("[dsh-unbound] boot: skip host writes (Apply once)");
    return "skip:boot-no-host-write";
  }

  const scope = { surface: ports.surface(), sealed: ports.sealed() };
  if (!settleMayReapply(scope)) {
    logger.debug("[dsh-unbound] sealed desktop: skip startup reapply (wait for Apply)");
    return "skip:sealed-wait-apply";
  }

  const result = ports.applyPatches(aiBase);
  if (!life.alive) return "skip:inactive";
  if (result.filesChanged === 0) {
    logger.debug("[dsh-unbound] host already clean; nothing to write");
    return "already-clean";
  }
  if (!settleMayRestart(scope)) {
    logger.debug("[dsh-unbound] reapply wrote patches; desktop settle does not restart");
    return "reapplied-no-restart";
  }

  if (life && !life.alive) return "skip:inactive";
  try {
    ports.scheduleRestart(ctx);
    return "restarting";
  } catch (error) {
    logger.warn("[dsh-unbound] restart after reapply failed:", String(error));
    return "restart-failed";
  }
}

/** 宿主根探测（engine 负责真正的路径解析；这里只判「有没有东西可打」）。 */
function portsSeekAiBase(ports: PluginPorts): string | null {
  void ports;
  const host = findHost();
  return host === null ? null : host.aiBase;
}

// ───────────────────────────── 工具注册 ─────────────────────────────

/** 无参工具的参数声明（宿主用来生成 JSON Schema）。 */
const EMPTY_PARAMS: Record<string, ToolParamDecl> = {};

/** 统一输出形态：`{ text }`。 */
const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string" } },
  },
  render: (_args: unknown, value: unknown): unknown[] => [
    { type: "text", text: String((value as { text?: unknown } | null)?.text ?? "") },
  ],
} as const;

/**
 * 注册 `qilin_status` / `qilin_apply` / `qilin_revert` 三个工具。
 *
 * 名字保持 `qilin_*`（不是 `unbound_*`）：用户脚本和提示词里可能已经引用，
 * 改名是破坏性变更。
 */
export function registerTools(
  ctx: HostContext,
  config: Required<PluginConfig>,
  ports: PluginPorts,
  logger: Logger,
): void {
  const registry = ctx.tools;
  if (registry === undefined) return;

  const definitions: ToolDefinition<Record<string, unknown>, { readonly text: string }>[] = [
    {
      name: "qilin_status",
      description: "查看 dsh 指令权威性清洗状态（补丁清洗进度、shim 注入、override 文件）。",
      parameters: EMPTY_PARAMS,
      output: TEXT_OUTPUT,
      execute: async (): Promise<{ readonly text: string }> => {
        const host = findHost();
        if (host === null) return { text: "ERROR: 未找到宿主插件根（plugin root not found）" };
        return { text: ports.diagnose(host.aiBase) };
      },
    },
    {
      name: "qilin_apply",
      description:
        "应用 dsh 指令权威性清洗：补丁（提示词层+代码默认+引擎级审批/沙箱绕过）+ shim 注入 + override 文件。需重启 dsh 完全生效。",
      parameters: EMPTY_PARAMS,
      output: TEXT_OUTPUT,
      execute: async (): Promise<{ readonly text: string }> => {
        const host = findHost();
        if (host === null) return { text: "ERROR: 未找到宿主插件根（plugin root not found）" };
        const result = ports.applyPatches(host.aiBase);
        const shouldRestart = applyShouldRestart({
          complete: result.filesChanged === 0,
          sealed: ports.sealed(),
          appliedCount: result.applied,
          promptReady: false,
        });
        let restartNote = "";
        if (shouldRestart) {
          try {
            ports.scheduleRestart(ctx);
            restartNote = " 已请求重启.";
          } catch {
            restartNote = " 需手动重启 dsh 生效.";
          }
        }
        return {
          text: `清洗完成 / applied=${result.applied}, files=${result.filesChanged}.${restartNote}`,
        };
      },
    },
    {
      name: "qilin_revert",
      description: "回滚 dsh 指令权威性清洗到备份原件（保留 prompt-inject.md 用户文件）。",
      parameters: EMPTY_PARAMS,
      output: TEXT_OUTPUT,
      execute: async (): Promise<{ readonly text: string }> => {
        const host = findHost();
        if (host === null) return { text: "ERROR: 未找到宿主插件根（plugin root not found）" };
        const { revertPatches } = await import("../engine/apply.js");
        const patches = loadBundledPatches();
        const undone = revertPatches(patches, host.aiBase);
        logger.debug("[dsh-unbound] revert", String(undone.restored.length));
        const rest = undone.missing.length > 0 ? ` 无备份=${undone.missing.length}` : "";
        return { text: `回滚完成 / reverted=${undone.restored.length}.${rest} 重启 dsh 恢复.` };
      },
    },
  ];

  for (const definition of definitions) {
    try {
      registry.register(definition as ToolDefinition<Record<string, unknown>, unknown>);
    } catch (error) {
      logger.warn(`[dsh-unbound] tool register failed: ${definition.name}`, String(error));
    }
  }
  void config;
}

// ───────────────────────────── 命令注册 ─────────────────────────────

/** 宿主的命令服务形态。 */
interface CommandsFace {
  register(spec: {
    readonly name: string;
    readonly description: string;
    readonly input?: { readonly hint?: string };
    readonly handler: (invocation: { readonly rawInput?: string }) => Promise<{ readonly kind: string; readonly text: string }>;
  }): void;
}

/**
 * 注册 `/qilin` `/rules` `/skills` 三条命令。
 *
 * 命令名保持原样（用户肌肉记忆）。`/rules` 与 `/skills` 的正文渲染
 * 与 CLI 输出一致，便于用户对照文档。
 */
export function registerCommands(ctx: HostContext, ports: PluginPorts, logger: Logger): void {
  const commands = getService<CommandsFace>(ctx, "commands");
  if (commands === null || typeof commands.register !== "function") return;
  const dshHome = findDshHome();

  const specs = [
    {
      name: "qilin",
      description: "dsh 指令权威性清洗（status/apply/revert）",
      input: { hint: "status | apply | revert" },
      handler: async (invocation: { readonly rawInput?: string }): Promise<{ kind: string; text: string }> => {
        const sub = (invocation.rawInput ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "status";
        const host = findHost();
        if (host === null) return { kind: "error", text: "未找到宿主插件根（plugin root not found）" };
        switch (sub) {
          case "apply":
          case "a": {
            const result = ports.applyPatches(host.aiBase);
            return { kind: "success", text: `清洗完成 / applied=${result.applied}, files=${result.filesChanged}.` };
          }
          case "revert": {
            const { revertPatches } = await import("../engine/apply.js");
            const undone = revertPatches(loadBundledPatches(), host.aiBase);
            return { kind: "success", text: `回滚完成 / reverted=${undone.restored.length}.` };
          }
          case "status":
          case "s":
            return { kind: "success", text: ports.diagnose(host.aiBase) };
          default:
            return {
              kind: "success",
              text: "qilin 命令：\n  /qilin status   查看清洗状态\n  /qilin apply    应用清洗\n  /qilin revert   回滚",
            };
        }
      },
    },
    {
      name: "rules",
      description: "规则集切换（写入 AGENTS.md/CLAUDE.md）: list | use <id> | reset | help",
      input: { hint: "list | use <id> | reset | help" },
      handler: async (invocation: { readonly rawInput?: string }): Promise<{ kind: string; text: string }> => {
        const args = (invocation.rawInput ?? "").trim().split(/\s+/).filter(Boolean);
        const sub = (args[0] ?? "list").toLowerCase();
        const state = new PromptState({ bundledDefault: (): string => ports.bundledDefault() });
        if (sub === "list" || sub === "ls" || sub === "s") {
          const status = await rulesStatus(dshHome, state);
          const lines: string[] = ["规则集 / Rule Sets", `  存储目录 / store  ${status.rules_dir}`];
          lines.push(
            `  目标文件 / target ${status.active === null ? "(无激活)" : `${status.agents_path} (${status.active_target})`} — exists=${status.agents_exists}, synced=${status.agents_synced}`,
          );
          if (status.rules.length === 0) lines.push("  (暂无规则 / no rules)");
          for (const rule of status.rules) {
            const mark = rule.id === status.active ? "▶" : "·";
            lines.push(`  ${mark} ${rule.name === rule.id ? rule.id : `${rule.name} (${rule.id})`} [${rule.target}]`);
          }
          return { kind: "success", text: lines.join("\n") };
        }
        return { kind: "success", text: "规则集命令：\n  /rules list  列出所有规则\n  /rules help  显示帮助" };
      },
    },
    {
      name: "skills",
      description: "官方用户 Skill（$DSH_HOME/skills）：list | help",
      input: { hint: "list | help" },
      handler: async (invocation: { readonly rawInput?: string }): Promise<{ kind: string; text: string }> => {
        const sub = (invocation.rawInput ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "list";
        if (sub !== "list" && sub !== "ls" && sub !== "s") {
          return {
            kind: "success",
            text: "官方 Skill 安装：\n  /skills list   列出 $DSH_HOME/skills\n  /skills help   显示帮助",
          };
        }
        const status: SkillsStatus = await skillsStatus(dshHome);
        const lines = ["官方用户 Skill / $DSH_HOME/skills", `  ${status.skills_dir}`];
        if (status.skills.length === 0) lines.push("  (暂无用户 Skill)");
        for (const item of status.skills) {
          lines.push(`  ${item.valid ? "·" : "!"} ${item.id}  ${item.description || "(无说明)"}`);
          if (!item.valid && item.error !== null) lines.push(`      ${item.error}`);
        }
        return { kind: "success", text: lines.join("\n") };
      },
    },
  ];

  for (const spec of specs) {
    try {
      commands.register(spec);
    } catch (error) {
      logger.warn(`[dsh-unbound] command register failed: ${spec.name}`, String(error));
    }
  }
  void listSkills;
}

// ───────────────────────────── apply ─────────────────────────────

/** `readInjectFallback` 需要包一层以便日志与错误隔离。 */
function makeInjectReader(
  ports: PluginPorts,
  logger: Logger,
): (context: unknown) => string {
  return (context: unknown): string => {
    try {
      return ports.readInjectFallback(context);
    } catch (error) {
      logger.warn("[dsh-unbound] readInjectFallback failed:", String(error));
      return "";
    }
  };
}

/**
 * 插件入口。
 *
 * 顺序（与原实现一致，顺序本身有意义）：
 *   watchLife → settle 定时器 → 装配守卫 → 段注册 → 工具 → 命令
 *
 * 装配守卫必须在段注册**之前**：段是「被装配的对象」，守卫是「装配完成后的改写」；
 * 反过来的话守卫第一轮会包住一个还没有插件段的装配。
 */
export async function apply(ctx: HostContext, rawConfig?: unknown): Promise<void> {
  const config = normalizeConfig(rawConfig);
  const logger = makeLogger(ctx, config.verbose);

  if (!config.enabled) {
    logger.debug("[dsh-unbound] plugin disabled by config");
    return;
  }

  const dshHome = findDshHome();
  const basePorts = createDefaultPorts({ dshHome });
  const injectReader = makeInjectReader(basePorts, logger);
  const ports: PluginPorts = { ...basePorts, readInjectFallback: injectReader };

  const life = watchContextLife(ctx, logger);
  if (!life.alive) {
    logger.warn("[dsh-unbound] skip apply: inactive context");
    return;
  }

  installIdentityOverride(ctx, config, ports, dshHome, logger);
  registerPromptSections(ctx, config, ports, logger);
  registerTools(ctx, config, ports, logger);
  registerCommands(ctx, ports, logger);

  // settle：延时 → 判活 → 跑补丁落定 + 规则集自检。
  const delay = settleDelayMs(ports.surface());
  const settleTimer = setTimeout(() => {
    if (!life.alive) {
      logger.debug("[dsh-unbound] settle skipped: inactive context");
      return;
    }
    settleInstalledPatches(config, ctx, life, ports, logger)
      .then((result) => logger.debug(`[dsh-unbound] settle: ${result}`))
      .catch((error: unknown) => {
        if (isInactiveContextError(error)) {
          logger.debug("[dsh-unbound] settle skipped: inactive context");
          return;
        }
        logger.warn("[dsh-unbound] settle error:", String(error));
      });
    ports
      .ensureRulesInitialState(dshHome)
      .then((state) => logger.debug(`[dsh-unbound] rules init: ${JSON.stringify(state)}`))
      .catch((error: unknown) => logger.warn("[dsh-unbound] rules init error:", String(error)));
  }, delay);
  if (typeof settleTimer.unref === "function") settleTimer.unref();

  const cleared = runEffect(ctx, () => () => clearTimeout(settleTimer));
  if (!cleared) {
    // 没有 effect 的 ctx（老宿主 / 已 dispose）不能留着定时器悬空。
    clearTimeout(settleTimer);
  }

  // 停用时清掉指向本插件预设的 selectedDefault（宿主 resolve() 对未知预设是硬抛）。
  runEffect(ctx, () => () => {
    try {
      ports.clearOwnedPreset?.(ctx, dshHome);
    } catch {
      /* 停用清理失败不挡 */
    }
  });
}

/** Cordis 插件模块形态。 */
export const plugin: PluginModule = {
  name,
  inject: [...inject],
  apply,
};

export default plugin;

/** 供测试核对「哪些目录会被顺手创建」。 */
export function qilinStateDir(dshHome: string): string {
  return path.join(dshHome, "dsh-qilin");
}

/** 供 status 输出用：判断某个路径是否存在（不抛）。 */
export function existsSafe(fp: string): boolean {
  try {
    return fs.existsSync(fp);
  } catch {
    return false;
  }
}
