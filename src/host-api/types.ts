/**
 * 宿主（DeepSeek Harness / Cordis）API 的类型声明。
 *
 * ## 为什么需要这一层
 *
 * `@deepseek-ai/*` 包**不带任何 .d.ts**（实测 `find -name '*.d.ts' | wc -l` = 0）。
 * 原 `dsh-qilin` 因此全是 `any`：60 处 `ctx.tools`、28 处 `ctx.effect`、
 * 26 处 `ctx.on`、10 处 `ctx.waterfall` 全无校验。上游一改签名，
 * 只会在运行时炸，而且往往被 `catch {}` 吞掉。
 *
 * ## 设计原则
 *
 * 1. **只声明项目真正用到的部分**。这不是上游 SDK 的完整镜像，
 *    而是「我们从宿主拿走的东西」的契约。多写就是负担。
 * 2. **未知即 `unknown`，不是 `any`**。`any` 会污染整条调用链；
 *    `unknown` 强制调用点做窄化，这正是我们要的。
 * 3. **宿主私有钩子单独分组**。`__dshQilin*` 系列是往 ctx 上挂的自定义属性，
 *    它们不是宿主 API，显式标注，避免和官方 API 混淆。
 */

/** 工具参数的单字段声明（宿主用这套 schema 生成 JSON Schema）。 */
export interface ToolParamDecl {
  readonly type: "string" | "number" | "boolean" | "array" | "object";
  readonly description?: string;
  readonly required?: boolean;
  readonly enum?: readonly string[];
  readonly items?: ToolParamDecl;
  readonly default?: unknown;
}

/** 工具返回值声明与渲染。 */
export interface ToolOutputDecl<T = unknown> {
  readonly schema: { readonly type: string };
  readonly render?: (args: unknown, value: T) => unknown;
}

/**
 * 一个可注册的工具。
 *
 * `execute` 的 `exec` 是宿主的执行上下文（含会话 id、cwd 等），
 * 原实现只用了少量字段，这里声明已知部分并保留扩展口。
 */
export interface ToolDefinition<A = Record<string, unknown>, R = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, ToolParamDecl>;
  readonly output?: ToolOutputDecl<R>;
  execute(args: A, exec: ToolExecContext): Promise<R> | R;
}

/** 宿主传给工具的执行上下文。字段按原项目实际读取的为准。 */
export interface ToolExecContext {
  readonly session?: unknown;
  readonly sessionId?: string;
  readonly cwd?: string;
  /** 子智能体场景下的父会话信息。 */
  readonly parent?: unknown;
  /** 原项目用到的其余字段都是可选读取，保持开放。 */
  readonly [key: string]: unknown;
}

/** 工具注册表。原项目只用 `register`。 */
export interface ToolRegistry {
  register(tool: ToolDefinition<never, unknown> | ToolDefinition<Record<string, unknown>, unknown>): void;
}

/** 宿主 logger。原项目全部用可选链调用。 */
export interface HostLogger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/**
 * Cordis 的 effect：注册副作用并返回清理函数。
 *
 * `ctx.effect(fn)` 的 `fn` 返回一个 disposer；插件 unload 时宿主调用它。
 * 原项目注释明确记过：不用 effect 包起来会导致「handler 残留 + 热重载翻倍」。
 */
export type EffectFn = () => void | (() => void);

/** `ctx.on` 的可选订阅选项（不同宿主版本字段不一，保持开放）。 */
export interface EventSubscribeOptions {
  readonly global?: boolean;
  readonly prepend?: boolean;
  readonly [key: string]: unknown;
}

/** 事件监听器签名。宿主事件载荷形态不一，统一 unknown。 */
export type EventListener = (...args: unknown[]) => void;

/**
 * `ctx.on` 的已知事件名。
 *
 * 原项目把 `ctx.on` 同时用于**宿主生命周期事件**（字符串名）和
 * 子进程/流的 `child.on('close'|'data'|...)`。后者不是 ctx 事件，
 * 这里只列真正的 ctx 事件；其余走 Node 类型。
 */
export type HostEventName = string;

/** 瀑布式中间件：拿到上游结果，返回可能被改写的结果。 */
export type WaterfallHandler<T> = (current: T, ...rest: unknown[]) => T | Promise<T>;

/**
 * 宿主命令服务（`ctx.get("commands")`）。
 *
 * 原实现注册 `/qilin` `/rules` `/skills` 三条命令。这里的形状按实际调用建模：
 * `handler` 拿到原始输入文本，返回 `{kind, text}` 供宿主渲染。
 *
 * 为什么放在共享层：命令服务是宿主能力，不是某个模块的私有契约。
 * 早期版本把它定义在 `plugin/index.ts` 里，导致其他模块要用就得重新窄化一次。
 */
export interface CommandsFace {
  register(spec: {
    readonly name: string;
    readonly description: string;
    readonly input?: { readonly hint?: string };
    readonly handler: (invocation: CommandInvocation) => Promise<CommandResult>;
  }): void;
}

/** 命令调用载荷。 */
export interface CommandInvocation {
  readonly rawInput?: string;
}

/** 命令执行结果：`kind` 决定宿主怎么渲染（文本/通知等）。 */
export interface CommandResult {
  readonly kind: string;
  readonly text: string;
}

/** 会话/系统的 slot（UI 插槽）。 */
export interface SlotRegistry {
  register?(name: string, component: unknown): void;
  [key: string]: unknown;
}

/** 宿主 HTTP 服务注册面。 */
export interface WebServerFace {
  register?(route: {
    readonly method?: string;
    readonly path: string;
    readonly handler: (req: unknown, res: unknown) => unknown;
  }): void;
  [key: string]: unknown;
}

/**
 * 插件拿到的 ctx。
 *
 * 所有成员都是**可选**：不同宿主面（web / desktop / cli）提供的服务不一致，
 * 原项目大量用 `typeof ctx.get === 'function'` 探测。用可选属性把这个事实
 * 编进类型，调用点就必须窄化——这正是原项目手工做的事，现在由编译器强制。
 */
export interface HostContext {
  /** 工具注册表。60 处调用点。 */
  readonly tools?: ToolRegistry;
  /** 按名字取宿主服务（subagents / sessions / skills / agentPresets / redteam …）。 */
  get?(name: string): unknown;
  /**
   * 注册副作用并返回清理函数。28 处。
   *
   * 返回值在不同宿主版本上可能是 disposer、Promise 或 void，
   * 所以声明为 `unknown` 而不是 `void` —— 强迫调用点窄化取用。
   */
  effect?(fn: EffectFn): unknown;
  /**
   * 事件订阅。
   *
   * 第三个参数在部分宿主版本上是 `{global, prepend}` 之类的选项；
   * 原实现手工探测，这里显式声明为可选，避免每个调用点各自窄化。
   */
  on?(event: HostEventName, listener: EventListener, options?: EventSubscribeOptions): void;
  /** 系统提示词装配瀑布。10 处。 */
  waterfall?<T>(scope: unknown, event: string, input: T, context?: unknown, fallback?: () => T): Promise<T>;
  readonly logger?: HostLogger;
  readonly slots?: SlotRegistry;
  readonly webServer?: WebServerFace;
  readonly settings?: unknown;
  readonly systemPrompt?: unknown;
  readonly shell?: unknown;
  readonly skills?: unknown;
  readonly subagents?: unknown;
  readonly agents?: unknown;
  readonly subprocess?: unknown;
  readonly baseUrl?: string;
  readonly fiber?: unknown;
  readonly sandboxPolicy?: unknown;
  /** 发布进程级服务（原项目 `ctx.provide('redteam', store)`）。 */
  provide?(name: string, value: unknown): void;
  /** 声明依赖。 */
  inject?: readonly string[];
  scheduleRestart?(...args: unknown[]): unknown;
  /** 未声明的宿主属性：保持 unknown，禁止静默 any。 */
  readonly [key: string]: unknown;
}

/**
 * 本插件挂在 ctx 上的**私有**钩子。
 *
 * 这些不是宿主 API，是 dsh-qilin/unbound 自己在 ctx 上记的状态，
 * 用于跨模块传值（如当前 role、cwd、preset）。单独建模，
 * 避免误以为是官方能力。
 */
export interface PrivateHostHooks {
  __dshQilinSessionHook?: unknown;
  __dshQilinRoleCapture?: unknown;
  __dshQilinPresetHook?: unknown;
  __dshQilinPreStepHook?: unknown;
  __dshQilinAssembleHook?: unknown;
  __dshQilinCwdCapture?: unknown;
  __dshQilinFullPin?: unknown;
  __dshQilinRegionGate?: unknown;
  __dshQilinMnemonStrip?: unknown;
  __dshpEnvAdaptPreStep?: unknown;
}

/**
 * 插件模块的形状（Cordis 约定）。
 *
 * `apply` 是入口，`inject` 声明依赖的服务名。
 * 原项目注释记过一条坑：不要把 `pluginPackages` 写进 inject，
 * Cordis 会对 map 里每个 key 空等 → pending → 宿主退出码 1。
 */
export interface PluginModule {
  readonly name: string;
  readonly inject?: readonly string[];
  apply(ctx: HostContext, config?: unknown): void | Promise<void>;
}

/** 从 ctx.get 安全取服务的类型化助手。 */
export function getService<T>(ctx: HostContext, name: string): T | null {
  if (typeof ctx.get !== "function") return null;
  try {
    const value = ctx.get(name);
    return (value as T) ?? null;
  } catch {
    // 宿主在服务未就绪时会抛；原项目一律吞掉当成「没有」
    return null;
  }
}
