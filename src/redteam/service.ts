/**
 * 红队控制台的**服务端聚合入口**（Cordis 插件三件套）。
 *
 * ## 这个文件补的是哪一段
 *
 * 浏览器半侧（`client.js`）已经能加载、页签能渲染，但每个页签都在等
 * `POST /redteam/api`。这条路由此前**没有任何人注册**：
 *
 * - `ui/server.ts` 的 `serveRequest` 是 handler 本体，但只被测试调用过；
 * - `ui/bridge.ts` 的 `BridgePorts` 需要 `{ gateway, store }`，而
 *   `GatewayPorts` 的 15 个字段只有测试里有 fake 实现；
 * - `RedteamStore` 只在测试里 `new` 过。
 *
 * 所以这里把三件事接上：**造 store → 提供 `redteam` 服务 → 注册 `/redteam/api`**。
 *
 * ## 为什么叫 service 而不是 plugin
 *
 * 它不是「一个插件功能」，而是把本包内三个库（store / tools 的 store 端口 / ui 的
 * 桥接管线）聚合成一个可被宿主装载的服务端入口。名字如实反映职责。
 *
 * ## 三条与 `src/host-api/types.ts` 的偏差（以真宿主源码为准）
 *
 * 1. **`webServer.register` 必须带 `kind`**。真实现见
 *    `@deepseek-ai/dsh-host-webserver/lib/index.js:326`：
 *
 *    ```js
 *    register(route) {
 *      const table = route.kind === "exact" ? this.exact : this.prefixes;
 *      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
 *      table.set(route.path, route);
 *      return () => { table.delete(route.path); };
 *    }
 *    ```
 *
 *    - 漏 `kind` 会落进 prefix 表：`/redteam/api` 能匹配，但语义变成「前缀路由」，
 *      将来任何 `/redteam/api/xxx` 都会命中同一个 handler。
 *    - **重复 `(kind, path)` 直接 throw** —— 热重载时上一轮没撤就崩。
 *    - **返回 disposer**，而 `WebServerFace` 声明的是 `(): void`。
 *
 *    共享层类型是错的，但不是这个文件的owner；所以在这里本地窄化一次
 *    （`webServerOf`），并且不信 `WebServerFace` 的返回值类型。
 *
 * 2. **`ctx.provide` 自带 effect 生命周期**。`cordis/lib/index.js:801` 的
 *    `provide(name, value, check)` 内部就是 `this.ctx.fiber.effect(...)`，
 *    dispose 时自动注销并通知依赖方。所以 `store.close()` **不能**塞进
 *    provide 的 disposer，要挂独立 effect —— 资源释放与服登记解耦。
 *
 * 3. **不硬依赖 `webServer`**。本包会同时装进 web / desktop / headless 三种面，
 *    headless 上没有 `webServer`。若把 `webServer` 写进 `inject`，Cordis 会对它
 *    永久 pending → 宿主启动超时 → **退出码 1**（本仓库 `src/plugin/index.ts`
 *    的 inject 注释记过同一条坑）。改用 `ctx.inject(["webServer"], cb)`：
 *    服务不出现时回调根本不会跑，也不会留半截注册。这也是上游
 *    `dsh-qilin/lib/index.js:1754` 的写法。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HostContext, HostLogger, PluginModule } from "../host-api/types.js";
import { dispatchAsync } from "./store/dispatch.js";
import { RedteamStore } from "./store/store.js";
import { serveRequest } from "./ui/server.js";
import type { BridgePorts, BridgeRequest, StorePort } from "./ui/bridge.js";
import { fieldString } from "./ui/ops.js";
import type { ParsedRequest } from "./ui/ops.js";
import type { ApiBody } from "./ui/protocol.js";
import type {
  GatewayPorts,
  InstallInfo,
  PluginIdentity,
  PresetService,
  SessionRegistry,
  SkillEntry,
  SkillService,
  SubagentRegistry,
  UpdateApply,
  UpdateCheck,
  UpdatePreflight,
} from "./ui/gateway.js";
import {
  DEFAULT_MAX_AGENTS,
  MAX_AGENTS_LIMIT,
  maxAgentsOf,
  maxAgentsSourceOf,
  saveMaxAgents,
} from "../platform/settings.js";
import {
  configPathOf,
  envAdaptStatus,
  loadPlatformConfig,
  markEnvAdaptSkip,
  mergeConfigEnv,
  redteamRoot,
} from "../platform/platform-config.js";
import {
  bundledSkillSummaries,
  checkSkill,
  officialSkillSummaries,
  skillLibraryOf,
  summarizeSkills,
} from "../platform/skill-availability.js";
import type { SkillSummary, SkillVerdict } from "../platform/skill-availability.js";
import { versionIsNewer } from "../platform/version.js";

/** Cordis 插件名（与 `cordis.patch.yml` 的 insert 行 id 对齐）。 */
export const name = "dsh-unbound-service";

/**
 * 硬依赖：**一个都没有**。
 *
 * 理由见文件头第 3 条。需要 `webServer` 的地方走 `ctx.inject` 懒取。
 */
export const inject: readonly string[] = [];

/** 本插件注册的唯一路由。 */
export const ROUTE_PATH = "/redteam/api";

/** 路由种类：精确匹配。写死成常量避免各处手抄。 */
export const ROUTE_KIND = "exact";

/** 环境变量视图（便于测试注入 `DSH_HOME`）。 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/* ════════════════════════════════════════════════════════ 日志 */

/**
 * 本文件用的 logger 形状：**方法必选**。
 *
 * `HostLogger` 把四个方法都声明成可选（不同宿主面提供的不一样，那个类型是诚实的），
 * 但本文件每一处日志都是无条件调用的 —— 用可选类型会让每个调用点都要判一次空。
 * 所以这里声明一个"已经填好兜底"的必选形态：`makeLogger` 一定返回全部四个方法。
 * 它结构化兼容 `HostLogger`，需要时可以直接传。
 */
export interface ServiceLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** 统一日志：宿主 logger 缺字段时退化成 console.warn，绝不静默。 */
function makeLogger(ctx: HostContext): ServiceLogger {
  const logger = ctx.logger;
  return {
    debug(message: string, ...args: unknown[]): void {
      if (typeof logger?.debug === "function") logger.debug(message, ...args);
    },
    info(message: string, ...args: unknown[]): void {
      if (typeof logger?.info === "function") logger.info(message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
      if (typeof logger?.warn === "function") logger.warn(message, ...args);
      else console.warn(message, ...args);
    },
    error(message: string, ...args: unknown[]): void {
      if (typeof logger?.error === "function") logger.error(message, ...args);
      else console.error(message, ...args);
    },
  };
}

/* ════════════════════════════════════════════════════════ 宿主能力窄化 */

/**
 * 真实的 `webServer` 形状（**不是** `host-api/types.ts` 里那份错的）。
 *
 * `register` 返回 disposer（真实现返回 `() => void`）或 `unknown`；
 * 这里只声明「可能是个函数」，调用点自己判。
 */
export interface WebServerRealFace {
  register(route: {
    readonly kind: "exact" | "prefix";
    readonly path: string;
    readonly handler: (request: IncomingMessage, response: ServerResponse) => unknown;
  }): unknown;
}

/** 从 ctx 读一个属性；Proxy 在未 inject 时会抛，一律当「没有」。 */
function readProp(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) return undefined;
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * 把 `ctx.webServer` 窄化成 {@link WebServerRealFace}。
 *
 * 不用 `as WebServerFace`：那份类型缺 `kind`、返回 `void`，照着写编译过了运行时是坏的。
 * 这里逐个字段验证 `register` 是函数，再包一层转发（`this` 绑定保住）。
 */
export function webServerOf(ctx: HostContext): WebServerRealFace | null {
  const face = readProp(ctx, "webServer");
  if (face === null || typeof face !== "object") return null;
  const register = readProp(face, "register");
  if (typeof register !== "function") return null;
  return {
    register(route): unknown {
      return Reflect.apply(register, face, [route]);
    },
  };
}

/** `ctx.provide(name, value)` —— 真宿主是方法，类型声明里是数组。 */
export interface ProviderFace {
  provide(name: string, value: unknown): void;
}

/**
 * 把 `ctx.provide` 窄化成方法形态；不可用返回 null。
 *
 * 用 `Reflect.apply` 而不是 `fn.call(...)`：`strictBindCallApply` 会把
 * `Function.prototype.call` 的实参个数按被调函数的声明参数校验，
 * 而这里拿到的是 `unknown` 收窄出来的函数，参数表不可靠 ——
 * `Reflect.apply` 走 `any[]`，不会引入假约束，也不会丢 `this`。
 */
export function providerOf(ctx: HostContext): ProviderFace | null {
  const provide = readProp(ctx, "provide");
  if (typeof provide !== "function") return null;
  return {
    provide(serviceName: string, value: unknown): void {
      Reflect.apply(provide, ctx, [serviceName, value]);
    },
  };
}

/** `ctx.inject(names, callback)` —— 真宿主是方法，类型声明里是字符串数组。 */
export interface InjectorFace {
  inject(names: readonly string[], callback: (host: HostContext) => void): unknown;
}

/** 把 `ctx.inject` 窄化成方法形态；不可用返回 null。 */
export function injectorOf(ctx: HostContext): InjectorFace | null {
  const injectFn = readProp(ctx, "inject");
  if (typeof injectFn !== "function") return null;
  return {
    inject(names: readonly string[], callback: (host: HostContext) => void): unknown {
      return Reflect.apply(injectFn, ctx, [names, callback]);
    },
  };
}

/** 调 `ctx.get(name)`；服务未就绪 / 未注入时返回 `undefined` 而不是抛。 */
export function serviceOf(ctx: HostContext, serviceName: string): unknown {
  const get = readProp(ctx, "get");
  if (typeof get !== "function") return undefined;
  try {
    const value: unknown = Reflect.apply(get, ctx, [serviceName]);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/** 注册一个 effect；ctx 不支持或已 dispose 时返回 false（不抛）。 */
function runEffect(ctx: HostContext, fn: () => void | (() => void)): boolean {
  const effect = readProp(ctx, "effect");
  if (typeof effect !== "function") return false;
  try {
    Reflect.apply(effect, ctx, [fn]);
    return true;
  } catch {
    return false;
  }
}

/* ════════════════════════════════════════════════════════ 宿主服务窄化 */

/** 读整数（缺失/非法 → fallback）。 */
function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读字符串（缺失 → 空串）。 */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 窄化 `ctx.get("subagents")`。
 *
 * 只认 `listChildren` 是函数这一件事 —— 宿主版本间别的字段都在变，
 * 而这个方法是网关唯一用到的。
 */
export function narrowSubagents(value: unknown): SubagentRegistry | null {
  if (value === null || typeof value !== "object") return null;
  const listChildren = readProp(value, "listChildren");
  if (typeof listChildren !== "function") return null;
  return {
    async listChildren(parentId: unknown): Promise<readonly unknown[]> {
      const rows: unknown = await Reflect.apply(listChildren, value, [parentId]);
      return Array.isArray(rows) ? rows : [];
    },
  };
}

/** 窄化 `ctx.get("sessions")`：只认 `list()`。 */
export function narrowSessions(value: unknown): SessionRegistry | null {
  if (value === null || typeof value !== "object") return null;
  const list = readProp(value, "list");
  if (typeof list !== "function") return null;
  return {
    list(): readonly unknown[] {
      try {
        const rows: unknown = Reflect.apply(list, value, []);
        return Array.isArray(rows) ? rows : [];
      } catch {
        // 会话注册表在启动早期会抛；当「列不出来」，不炸网关。
        return [];
      }
    },
  };
}

/**
 * 窄化一条技能记录。
 *
 * `name` / `description` 是渲染必需的；其余字段只在类型对的时候带上 ——
 * 宿主给 `null` 时保留 `null`（`SkillEntry` 的可空字段就是 `| null`），
 * 给 `undefined` 时省略（`exactOptionalPropertyTypes` 下不能显式赋 undefined）。
 */
export function narrowSkillEntry(value: unknown): SkillEntry | null {
  if (value === null || typeof value !== "object") return null;
  const skillName = textOf(readProp(value, "name"));
  if (skillName === "") return null;
  const entry: {
    name: string;
    description: string;
    whenToUse?: string;
    provider?: string;
    source?: string;
    path?: string | null;
    content?: string;
    resourceBase?: { readonly kind?: string; readonly path?: string } | null;
    invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean } | null;
  } = { name: skillName, description: textOf(readProp(value, "description")) };

  const whenToUse = readProp(value, "whenToUse");
  if (typeof whenToUse === "string") entry.whenToUse = whenToUse;
  const provider = readProp(value, "provider");
  if (typeof provider === "string") entry.provider = provider;
  const source = readProp(value, "source");
  if (typeof source === "string") entry.source = source;
  const path = readProp(value, "path");
  if (typeof path === "string" || path === null) entry.path = path;
  const content = readProp(value, "content");
  if (typeof content === "string") entry.content = content;

  const resourceBase = readProp(value, "resourceBase");
  if (resourceBase === null) {
    entry.resourceBase = null;
  } else if (typeof resourceBase === "object") {
    const kind = readProp(resourceBase, "kind");
    const dir = readProp(resourceBase, "path");
    const base: { kind?: string; path?: string } = {};
    if (typeof kind === "string") base.kind = kind;
    if (typeof dir === "string") base.path = dir;
    entry.resourceBase = base;
  }

  const invocation = readProp(value, "invocation");
  if (invocation === null) {
    entry.invocation = null;
  } else if (typeof invocation === "object") {
    const modelInvocable = readProp(invocation, "modelInvocable");
    const userInvocable = readProp(invocation, "userInvocable");
    const inv: { modelInvocable?: boolean; userInvocable?: boolean } = {};
    if (typeof modelInvocable === "boolean") inv.modelInvocable = modelInvocable;
    if (typeof userInvocable === "boolean") inv.userInvocable = userInvocable;
    entry.invocation = inv;
  }
  return entry;
}

/** 窄化 `ctx.get("skills")`：要 `list` + `get` 两个方法都像函数。 */
export function narrowSkills(value: unknown): SkillService | null {
  if (value === null || typeof value !== "object") return null;
  const list = readProp(value, "list");
  const get = readProp(value, "get");
  if (typeof list !== "function" || typeof get !== "function") return null;
  return {
    async list(options: { readonly scope: unknown }): Promise<readonly SkillEntry[]> {
      const rows: unknown = await Reflect.apply(list, value, [options]);
      if (!Array.isArray(rows)) return [];
      const out: SkillEntry[] = [];
      for (const row of rows) {
        const entry = narrowSkillEntry(row);
        if (entry !== null) out.push(entry);
      }
      return out;
    },
    async get(skillName: string, options: { readonly scope: unknown }): Promise<SkillEntry | undefined> {
      const row: unknown = await Reflect.apply(get, value, [skillName, options]);
      const entry = narrowSkillEntry(row);
      return entry ?? undefined;
    },
  };
}

/** 窄化 `ctx.get("agentPresets")`：只要 `standingKeyFor`。 */
export function narrowPresets(value: unknown): PresetService | null {
  if (value === null || typeof value !== "object") return null;
  const standing = readProp(value, "standingKeyFor");
  if (typeof standing !== "function") return null;
  return {
    async standingKeyFor(preset: string): Promise<unknown> {
      return Reflect.apply(standing, value, [preset]);
    },
  };
}

/* ════════════════════════════════════════════════════════ 包身份 */

/** 本包的兜底身份（package.json 读不到时用；版本明确为 null = 未知）。 */
const FALLBACK_IDENTITY: PluginIdentity = {
  name: "dsh-unbound",
  version: null,
  description: "",
  homepage: null,
};

/** 从某个目录往上找本包的 package.json。 */
function findPackageJson(startDir: string, maxDepth = 8): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * 读本包身份（`name` / `version` / `description` / `homepage`）。
 *
 * 模块位置在 `dist/redteam/` 或 `dist-test/src/redteam/` 都不同，
 * 所以用「向上找 package.json」而不是写死相对层数。
 *
 * @param packageJsonPath 显式路径（测试注入用；不给就自动找）。
 */
export function readPluginIdentity(packageJsonPath?: string): PluginIdentity {
  let file = packageJsonPath ?? null;
  if (file === null) {
    try {
      file = findPackageJson(dirname(fileURLToPath(import.meta.url)));
    } catch {
      file = null;
    }
  }
  if (file === null || !existsSync(file)) return FALLBACK_IDENTITY;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return FALLBACK_IDENTITY;
    const record = parsed as Record<string, unknown>;
    const homepage = record["homepage"];
    return {
      name: textOf(record["name"]) || FALLBACK_IDENTITY.name,
      version: textOf(record["version"]) || null,
      description: textOf(record["description"]),
      homepage: typeof homepage === "string" && homepage !== "" ? homepage : null,
    };
  } catch {
    return FALLBACK_IDENTITY;
  }
}

/* ════════════════════════════════════════════════════════ 技能兜底 */

/** 一条兜底技能（内部形态，与 `SkillSummary` 对齐）。 */
interface FallbackSkill {
  readonly summary: SkillSummary;
  readonly verdict: SkillVerdict;
}

/** 把技能摘要做一次真实可用性检查（读正文 → 共享判定模块）。 */
function checkSummaries(
  summaries: readonly SkillSummary[],
  env: EnvLike,
): readonly FallbackSkill[] {
  const home = env["DSH_HOME"] ?? join(homedir(), ".dsh");
  const cfg = loadPlatformConfig(join(home, "redteam"));
  const checkEnv = mergeConfigEnv(env, cfg);
  const out: FallbackSkill[] = [];
  for (const summary of summaries) {
    const verdict = checkSkill(
      {
        name: summary.name,
        content: summary.content ?? "",
        ...(summary.path === undefined ? {} : { path: summary.path }),
        ...(summary.resourceBase?.path === undefined ? {} : { root: summary.resourceBase.path }),
      },
      { env: checkEnv },
    );
    out.push({ summary, verdict });
  }
  return out;
}

/** 一条技能在目录响应里的形态。 */
function catalogItemOf(item: FallbackSkill, library: "redteam" | "official"): Record<string, unknown> {
  const { summary, verdict } = item;
  const dir = summary.resourceBase?.kind === "directory" ? summary.resourceBase.path ?? null : null;
  const description = summary.description ?? "";
  return {
    name: summary.name,
    description,
    whenToUse: summary.whenToUse ?? "",
    provider: library === "official" ? "dsh" : "dsh-unbound",
    source: library === "official" ? "official" : "plugin",
    dir,
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: library === "redteam",
    library,
    availability: library === "official" ? "listed" : verdict.status,
    problems: library === "official" ? [] : verdict.problems,
    needs_user: library === "official" ? [] : verdict.needs_user,
  };
}

/**
 * 技能服务的**兜底实现**：不依赖宿主 `skills` inject，直接读
 * 本包 `skills/redteam` 与 `$DSH_HOME/redteam/skills`（`bundledSkillSummaries` 两个都扫），
 * 再合并官方 `$DSH_HOME/skills`。
 *
 * 这就是网关在 `skillService === null` 或 preset scope 未就绪时调用的那条路。
 * 与上游 `handleSkillOpFromPluginDir` 同一口径：**红队技能做工具路径检查，
 * 官方技能只列出不判定**（不拿红队工具路径去判官方技能可不可用）。
 */
export async function skillFallbackOf(
  request: ParsedRequest,
  env: EnvLike = process.env,
): Promise<ApiBody> {
  const redteam = checkSummaries(bundledSkillSummaries(env), env);
  const officialSummaries = officialSkillSummaries(env);

  if (request.op === "skillRead") {
    const wanted = (fieldString(request, "name") ?? "").trim();
    if (wanted === "") return { ok: false, error: "name required" };
    const hit = redteam.find((item) => item.summary.name === wanted);
    if (hit !== undefined) {
      return {
        ok: true,
        name: hit.summary.name,
        description: hit.summary.description ?? "",
        whenToUse: hit.summary.whenToUse ?? "",
        provider: "dsh-unbound",
        source: "plugin",
        path: hit.summary.path ?? null,
        content: hit.summary.content ?? "",
        library: "redteam",
      };
    }
    const official = officialSummaries.find((item) => item.name === wanted);
    if (official !== undefined) {
      return {
        ok: true,
        name: official.name,
        description: official.description ?? "",
        whenToUse: "",
        provider: "dsh",
        source: "official",
        path: official.path ?? null,
        content: official.content ?? "",
        library: "official",
      };
    }
    return { ok: false, error: "skill not found: " + wanted };
  }

  if (request.op !== "skillCatalog") {
    // 网关只会在两个 op 上调过来；别的 op 说明表与实现漂移，明确报错而不是返回空目录。
    return { ok: false, error: `skillFallback 不处理 op: ${request.op}` };
  }

  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of redteam) {
    if (seen.has(item.summary.name)) continue;
    seen.add(item.summary.name);
    items.push(catalogItemOf(item, "redteam"));
  }
  for (const summary of officialSummaries) {
    if (seen.has(summary.name)) continue;
    seen.add(summary.name);
    items.push(catalogItemOf({ summary, verdict: checkSkill(summary, { env }) }, "official"));
  }

  const bySource = new Map<string, number>();
  const byDir = new Map<string, number>();
  for (const item of items) {
    const source = textOf(item["source"]) || "unknown";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    const dirRaw = item["dir"];
    const dirKey = typeof dirRaw === "string" && dirRaw !== "" ? dirRaw : "(非文件系统来源)";
    byDir.set(dirKey, (byDir.get(dirKey) ?? 0) + 1);
  }

  const redteamVerdicts = redteam.map((item) => item.verdict);
  const summary = summarizeSkills(redteamVerdicts);
  const byDirList = [...byDir].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);

  return {
    ok: true,
    total: items.length,
    fromPlugin: redteam.length,
    bySource: [...bySource].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
    byDir: byDirList,
    availability: {
      summary,
      checked_at: new Date().toISOString(),
      cached: false,
      broken: redteam
        .filter((item) => item.verdict.status === "broken")
        .map((item) => ({
          name: item.summary.name,
          problems: item.verdict.problems,
          needs_user: item.verdict.needs_user,
        })),
      note: "按本包与 $DSH_HOME/redteam/skills 的技能文件自检。工具路径、密钥和占位符只记在缺口里，不把整条技能标成不可用。",
    },
    note:
      items.length === 0
        ? "没有可列出的技能：本包没有随包 skills/redteam 目录，$DSH_HOME/redteam/skills 也是空的。"
        : "红队技能做工具路径检查；官方技能在 $DSH_HOME/skills，由宿主按任务调用。",
    items,
  };
}

/* ════════════════════════════════════════════════════════ GatewayPorts 实现 */

/** 造端口时需要的外部输入。 */
export interface GatewayPortOptions {
  readonly ctx: HostContext;
  /** 数据根（`$DSH_HOME/redteam`）。 */
  readonly root: string;
  /** 环境变量表（测试注入）。 */
  readonly env?: EnvLike | undefined;
  /** 本包 package.json 路径（测试注入）。 */
  readonly packageJsonPath?: string | undefined;
  /** 宿主面标识，用于 preflight 说明（不给就 "unknown"）。 */
  readonly surface?: string | undefined;
}

/** 读 profile 目录：`ctx.baseUrl` 是 `file://` URL，必须转回系统路径。 */
function profileDirOf(ctx: HostContext): string | null {
  const raw = readProp(ctx, "baseUrl");
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return raw.startsWith("file://") ? fileURLToPath(raw) : raw;
  } catch {
    return null;
  }
}

/** 读 profile 的 package.json（读不到 → null）。 */
function readProfilePackage(dir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 包管理器：profile 里有 pnpm 的锁文件就用 pnpm，否则 npm。 */
function packageManagerOf(dir: string): "pnpm" | "npm" {
  if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "pnpm-workspace.yaml"))) return "pnpm";
  return "npm";
}

/**
 * 枚举「真正在跑」的子智能体。
 *
 * 口径与网关 `handleAgentsStatus` 一致：只把 `kind === "child"` 且
 * `activity === "running"` 的算进去；单个会话读不到不影响其它。
 */
async function runningAgentsOf(
  subagents: SubagentRegistry | null,
  sessions: SessionRegistry | null,
): Promise<readonly { readonly session: string; readonly label: string }[]> {
  if (subagents === null || sessions === null) return [];
  const out: { session: string; label: string }[] = [];
  let roots: readonly unknown[] = [];
  try {
    roots = sessions.list().filter((candidate) => {
      const header = readProp(candidate, "header");
      if (header === null || typeof header !== "object") return false;
      const parent = readProp(header, "parentSession");
      return parent === undefined || parent === null;
    });
  } catch {
    return [];
  }
  for (const root of roots) {
    const rootId = readProp(root, "id");
    try {
      const kids = await subagents.listChildren(rootId);
      for (const kid of kids) {
        if (readProp(kid, "kind") !== "child") continue;
        if (readProp(kid, "activity") !== "running") continue;
        const label = textOf(readProp(kid, "label")) || textOf(readProp(kid, "id"));
        out.push({ session: String(rootId), label });
      }
    } catch {
      // 单个会话读不到不影响其它（与网关同一处理）。
    }
  }
  return out;
}

/**
 * 更新通道的三条「未实现」说明。
 *
 * 为什么不做：本包**没有发布到 npm registry**，也没有 GitHub release 源
 * （`package.json` 无 `repository`，`homepage` 也没有）。真去 spawn
 * `npm view dsh-unbound version` 只会拿 404，面板上显示「查询失败」比
 * 显示「未实现」更难排查 —— 前者看起来是网络问题，后者是明确的能力缺口。
 *
 * 类型上这不是「假装成功」：`UpdateCheck` / `UpdateApply` 都有 `{ ok: false }` 分支，
 * 网关会把 `error` 原样透给面板（见 `handleVersion` / `handleUpdateCheck` 的
 * `check_error` 字段）。面板显示错误态是**诚实**的结果。
 */
const NOT_IMPLEMENTED_CHECK =
  "更新检查未实现：本包未发布到 npm registry / GitHub release（package.json 没有 repository），"
  + "没有可查询的版本源。请在本仓库升级：`git pull && npm install && npm run build`，再重启 DeepSeek Harness。";

const NOT_IMPLEMENTED_APPLY =
  "自动更新未实现：本包未发布到 npm registry，没有可安装的发布版本。"
  + "请在本仓库手动升级：`git pull && npm install && npm run build`，再重启 DeepSeek Harness。";

/**
 * 造一份**真的** `GatewayPorts`。
 *
 * 15 个字段分三类：
 * - **真实实现（11）**：storeRoot / maxAgents / saveMaxAgents / maxAgentsSource /
 *   maxAgentsLimit / defaultMaxAgents / subagents / sessions / envAdaptStatus /
 *   envAdaptSkip / pluginIdentity / versionIsNewer / skillFallback
 * - **真实但可能为空（2）**：skillService / presetService（宿主 inject 缺失时为 null，
 *   网关会自动走 skillFallback）
 * - **明确未实现（3）**：checkLatest / applyUpdate / updatePreflight 的更新部分
 *
 * 每一条读不到能力时都给安全降级值，**不抛** —— 网关是 HTTP 请求路径，
 * 端口抛错会被 `bridge.ts` 收成 400 `handler_failed`，用户看到的是
 * 「面板打不开」而不是「某个能力不可用」。这是这一层最重要的纪律。
 */
export function createGatewayPorts(options: GatewayPortOptions): GatewayPorts {
  const { ctx, root } = options;
  const env: EnvLike = options.env ?? process.env;
  const subagents = narrowSubagents(serviceOf(ctx, "subagents"));
  const sessions = narrowSessions(serviceOf(ctx, "sessions"));
  const skillService = narrowSkills(serviceOf(ctx, "skills"));
  const presetService = narrowPresets(serviceOf(ctx, "agentPresets"));
  const surface = options.surface ?? "unknown";

  return {
    storeRoot: root,

    maxAgents(): number {
      // settings.json → REDTEAM_MAX_AGENTS → 默认 3（判定顺序与来源判定共用一套）。
      try {
        return maxAgentsOf(root, env);
      } catch {
        return DEFAULT_MAX_AGENTS;
      }
    },

    saveMaxAgents(value: number): number {
      // 写盘失败时返回 clamp 后的值：面板显示「已保存」但实际没落盘会比报错更难查，
      // 所以这里让异常冒到 gateway（bridge 会收成 400 handler_failed）——
      // 但为了「面板不整个炸掉」，退化成只 clamp 不写。
      try {
        return saveMaxAgents(root, value);
      } catch {
        const n = Math.floor(Number(value));
        if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS;
        return Math.min(Math.max(n, 1), MAX_AGENTS_LIMIT);
      }
    },

    maxAgentsSource(): string {
      try {
        return maxAgentsSourceOf(root, env);
      } catch {
        return "default";
      }
    },

    maxAgentsLimit: MAX_AGENTS_LIMIT,
    defaultMaxAgents: DEFAULT_MAX_AGENTS,

    subagents,
    sessions,

    envAdaptStatus(): ApiBody {
      try {
        // EnvAdaptStatus 自带 `ok: true`，展开即可（面板读 ready / reason / kali…）。
        return { ...envAdaptStatus(root) };
      } catch (cause) {
        return {
          ok: false,
          ready: false,
          reason: "need-config",
          error: "环境适配状态读取失败：" + (cause instanceof Error ? cause.message : String(cause)),
        };
      }
    },

    envAdaptSkip(skip: boolean): ApiBody {
      try {
        return { ...markEnvAdaptSkip(root, skip) };
      } catch (cause) {
        return {
          ok: false,
          error: "保存「暂不配置」失败：" + (cause instanceof Error ? cause.message : String(cause)),
        };
      }
    },

    pluginIdentity(): PluginIdentity {
      return readPluginIdentity(options.packageJsonPath);
    },

    async updatePreflight(): Promise<UpdatePreflight> {
      const identity = readPluginIdentity(options.packageJsonPath);
      const dir = profileDirOf(ctx);
      const notes: string[] = [];
      const blockers: string[] = [];

      // ① 安装态：profile 依赖里有没有这个包名 / node_modules 里有没有实体。
      let install: InstallInfo;
      if (dir === null) {
        install = { mode: "dev" };
        notes.push("读不到宿主 profile 目录（ctx.baseUrl 缺失），按开发态处理。");
      } else {
        const profilePkg = readProfilePackage(dir);
        const deps = readProp(profilePkg, "dependencies");
        const declaredRaw = readProp(deps, identity.name);
        const declared = typeof declaredRaw === "string" ? declaredRaw : null;
        const installed = existsSync(join(dir, "node_modules", identity.name, "package.json"));
        const mode: "dev" | "package" = declared !== null || installed ? "package" : "dev";
        install = {
          mode,
          dir,
          declared,
          packageManager: packageManagerOf(dir),
        };
        if (mode === "dev") {
          notes.push(
            `当前是开发态安装（profile 依赖里没有 ${identity.name}，是源码软链/手动挂载的），`
            + "包管理器更新不适用：请在本仓库 `git pull && npm install && npm run build` 后重启。",
          );
        }
      }
      if (options.surface !== undefined) notes.push(`宿主面：${surface}。`);

      // ② 有智能体在跑：更新要重启宿主，会打断它们。
      const running = await runningAgentsOf(subagents, sessions);
      if (running.length > 0) {
        blockers.push(
          `有 ${running.length} 个智能体正在跑（${running.map((item) => item.label).join("、")}）：`
          + "更新要重启当前宿主，会打断它们。请等它们结束。",
        );
      }

      // ③ 更新通道本身未实现 —— 说清楚，不要让人以为「检查一下就能更」。
      notes.push("自动更新通道未接入（本包没有可查询/可安装的发布版本源）。");

      return { install, blockers, notes, runningAgents: running };
    },

    async checkLatest(): Promise<UpdateCheck> {
      return { ok: false, error: NOT_IMPLEMENTED_CHECK };
    },

    async applyUpdate(target: string | null): Promise<UpdateApply> {
      void target;
      return { ok: false, error: NOT_IMPLEMENTED_APPLY };
    },

    versionIsNewer(remote: string, local: string): boolean {
      // 直接复用 platform/version 的唯一实现（含它显式记录的 prerelease 比较弱点）。
      return versionIsNewer(remote, local);
    },

    skillService,
    presetService,

    async skillFallback(request: ParsedRequest): Promise<ApiBody> {
      return skillFallbackOf(request, env);
    },
  };
}

/* ════════════════════════════════════════════════════════ BridgePorts 实现 */

/** 造桥接端口：网关 + 资产库。 */
export function createBridgePorts(
  store: RedteamStore,
  gateway: GatewayPorts,
): BridgePorts {
  const storePort: StorePort = {
    async dispatch(request: Readonly<Record<string, unknown>>): Promise<unknown> {
      // 用 dispatchAsync 而不是 dispatch：它是 dispatch 的超集，多一条 `probeSessions`
      // （要在 host 侧真实发起 TCP/HTTP 探测）。资产库不该抛，它内部已 catch 成
      // `{ ok: false, error }`；真抛了说明服务未就绪，交给 bridge 收成 store_failed。
      return dispatchAsync(store, request);
    },
  };
  return { gateway, store: storePort };
}

/* ════════════════════════════════════════════════════════ 请求适配 */

/**
 * 把真实的 `IncomingMessage` 适配成 `BridgeRequest`。
 *
 * ## 为什么不能直接传
 *
 * `exactOptionalPropertyTypes` 下两者不兼容：`IncomingMessage.method` 是
 * `string | undefined`（可选字段），而 `BridgeRequest.method` 是 `string | null`。
 * 语义上两者都表达「没有方法」，但类型系统不认 —— 这正是我们要它做出的提醒：
 * **浏览器侧与 Node 侧对"缺失"的表达不同，必须在边界上显式翻译一次**，
 * 而不是靠 `as` 掩盖（`as` 会让将来 host 把 `method` 改成别的形态时静默错位）。
 *
 * 三个字段的翻译规则：
 * - `method` 缺失 → `null`（`bridge.ts` 判的就是 `!== "POST"`）；
 * - `socket.remoteAddress` 缺失 → `null`（`origin.ts` 按 `null` 走严格分支）；
 * - `headers` 原样传：`IncomingHttpHeaders` 的 `string | string[] | undefined`
 *   正好是 `BridgeRequest` 要的形状。
 */
export function bridgeRequestOf(request: IncomingMessage): BridgeRequest {
  const socket = request.socket;
  const remoteAddress = typeof socket?.remoteAddress === "string" ? socket.remoteAddress : null;
  return {
    method: typeof request.method === "string" ? request.method : null,
    socket: { remoteAddress },
    headers: request.headers,
    on(event: "data" | "end" | "error", listener: (...args: never[]) => void): unknown {
      // `readBody` 只挂这三类监听，且回调签名各自固定；这里转发给真实流。
      return (request.on as unknown as (e: string, l: unknown) => unknown)(event, listener);
    },
    destroy(cause?: Error): unknown {
      return request.destroy(cause);
    },
  };
}

/* ════════════════════════════════════════════════════════ 路由挂载 */

/** 一次挂载的结果（供测试与日志核对）。 */
export interface MountResult {
  readonly registered: boolean;
  readonly reason: string;
}

/**
 * 收 disposer 的容器。
 *
 * ## 为什么不是模块级 Set
 *
 * 一度写成模块级 `Set`，真 cordis 上立刻暴露一个**跨实例泄漏**：
 * 同一进程里装两次（热重载、两个宿主面、并行测试）时，第一份的卸载
 * 会把第二份刚挂的路由也撤掉 —— 因为两轮共用一个集合。
 * 改成显式注入：谁挂的谁收，卸载只撤自己那批。
 */
export interface RouteSink {
  add(disposer: () => void): void;
}

/** 模块级默认集合（`mountRoute` 不带 sink 时用；测试与单次挂载够用）。 */
const defaultSinkDisposers = new Set<() => void>();

/** 默认 sink。 */
const defaultSink: RouteSink = {
  add(disposer: () => void): void {
    defaultSinkDisposers.add(disposer);
  },
};

/** 造一个独立的 sink（`applyWith` 每次调用一个）。 */
export function createRouteSink(): RouteSink & { unmount(): number } {
  const disposers = new Set<() => void>();
  return {
    add(disposer: () => void): void {
      disposers.add(disposer);
    },
    unmount(): number {
      let removed = 0;
      for (const dispose of disposers) {
        try {
          dispose();
          removed += 1;
        } catch {
          /* 单个撤销失败不影响其它 */
        }
      }
      disposers.clear();
      return removed;
    },
  };
}

/**
 * 把 `/redteam/api` 挂到宿主 webServer。
 *
 * 关键点（都是真宿主的契约，见文件头）：
 * - `kind: "exact"` —— 漏了会进 prefix 表，`/redteam/api/xxx` 也会命中同一条路由；
 * - 返回的 disposer 必须收起来，否则热重载时下一轮 `register` 直接 throw
 *   （`duplicate exact route`），整个插件在 reload 时崩掉；
 * - 重复注册要**吞掉并 warn**，不能让它冒成 apply 失败。
 *
 * @param sink disposer 的收集处（默认模块级；`applyWith` 传自己的）。
 * @returns 是否挂上、以及没挂上的原因（供调用方决定要不要 warn）。
 */
export function mountRoute(
  server: WebServerRealFace,
  ports: BridgePorts,
  logger: ServiceLogger,
  sink: RouteSink = defaultSink,
): MountResult {
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      // serveRequest 内部会读 body、校验同源、分派 op、写 JSON 响应。
      // 它不该抛；真抛了（端口实现的编程错误）由宿主兜成 400，这里先记一条。
      await serveRequest(bridgeRequestOf(request), response, ports);
    } catch (cause) {
      logger.warn(
        `[${name}] ${ROUTE_PATH} 处理失败：`,
        cause instanceof Error ? cause.message : String(cause),
      );
      // 响应可能已经写了头；避免二次写导致 ERR_HTTP_HEADERS_SENT。
      if (!response.headersSent) {
        try {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: false, error: "internal handler failure" }));
        } catch {
          /* 连接已断，无能为力 */
        }
      }
    }
  };

  try {
    const disposer = server.register({ kind: ROUTE_KIND, path: ROUTE_PATH, handler });
    // 真实现返回 `() => void`；返回别的（旧宿主 / 未实现）就当没有 disposer。
    if (typeof disposer === "function") {
      sink.add(disposer as () => void);
    }
    return { registered: true, reason: "ok" };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // 重复注册（热重载）不是致命错误：上一轮的 handler 还在，路由仍然可用。
    if (message.includes("duplicate")) {
      logger.warn(`[${name}] ${ROUTE_PATH} 已存在（热重载沿用上一轮），跳过重复注册`);
      return { registered: false, reason: "duplicate" };
    }
    logger.warn(`[${name}] ${ROUTE_PATH} 注册失败：${message}`);
    return { registered: false, reason: message };
  }
}

/**
 * 撤掉**默认 sink** 上的全部路由（幂等）。
 *
 * 注意：这只撤「没自带 sink 的 mountRoute」挂上去的那批。
 * `applyWith` 用独立 sink，不受这里影响 —— 这正是修掉跨实例泄漏后的语义。
 */
export function unmountAllRoutes(): number {
  let removed = 0;
  for (const dispose of defaultSinkDisposers) {
    try {
      dispose();
      removed += 1;
    } catch {
      /* 单个撤销失败不影响其它 */
    }
  }
  defaultSinkDisposers.clear();
  return removed;
}

/* ════════════════════════════════════════════════════════ apply */

/** `apply` 的可注入依赖（测试用；生产走默认实现）。 */
export interface ApplyOptions {
  /** 环境变量（含 `DSH_HOME`）。 */
  readonly env?: EnvLike | undefined;
  /** 数据根覆盖（默认 `$DSH_HOME/redteam`）。 */
  readonly root?: string | undefined;
  /** 本包 package.json 路径。 */
  readonly packageJsonPath?: string | undefined;
  /** 宿主面标识（`web` / `desktop` / `headless`）。 */
  readonly surface?: string | undefined;
}

/** 一次 apply 的结果（测试用来核对「provide 收到了什么」「register 收到了什么」）。 */
export interface ApplyOutcome {
  readonly store: RedteamStore | null;
  readonly provided: boolean;
  readonly route: MountResult | null;
  readonly error: string | null;
}

/**
 * 装到宿主上。
 *
 * 顺序（顺序本身有意义）：
 *   ① 造 store（同时 mkdir engagements 目录）
 *   ② 立刻挂 `close` 清理 —— 后面任何一步失败都不会漏掉句柄
 *   ③ provide `redteam` 服务（自带 effect，不用再包）
 *   ④ 挂 `/redteam/api`（`ctx.inject` 懒等 webServer）
 *
 * 全过程**不抛**：拿不到能力的部分只留 warning。宿主里 apply 抛异常会让
 * 整个 fiber 变 failed，用户看到的是「插件没加载」，而真正的原因（比如
 * 数据目录不可写）被埋掉。
 */
export function applyWith(
  ctx: HostContext,
  options: ApplyOptions = {},
): ApplyOutcome {
  const logger = makeLogger(ctx);
  const env: EnvLike = options.env ?? process.env;

  // ① 数据根：$DSH_HOME/redteam（与 ~/.dsh/redteam 现状一致）。
  let root: string;
  try {
    root = options.root ?? redteamRoot(env);
  } catch (cause) {
    const message = "红队数据根解析失败：" + (cause instanceof Error ? cause.message : String(cause));
    logger.warn(`[${name}] ${message}`);
    return { store: null, provided: false, route: null, error: message };
  }

  let store: RedteamStore;
  try {
    store = new RedteamStore(root);
  } catch (cause) {
    const message = "红队事实库打开失败（" + root + "）："
      + (cause instanceof Error ? cause.message : String(cause));
    logger.warn(`[${name}] ${message}`);
    return { store: null, provided: false, route: null, error: message };
  }

  // ② 资源释放：独立 effect，与 provide 的登记解耦（provide 自带 effect，
  //    塞在一起会导致「服务注销」和「句柄关闭」绑死，语义混乱）。
  //
  //    sink 也是**每次 apply 一个**：模块级共享会让同进程内的第二次装载
  //    （热重载 / 两个宿主面 / 并行测试）在第一次卸载时被连坐撤掉。
  const sink = createRouteSink();
  const effectAttached = runEffect(ctx, () => () => {
    sink.unmount();
    try {
      store.close();
    } catch {
      /* 关闭失败不阻断卸载 */
    }
  });
  if (!effectAttached) {
    logger.warn(`[${name}] 宿主没有 ctx.effect：store 句柄与路由不会在卸载时自动释放`);
  }

  // ③ provide：宿主里已有同名服务时**不覆盖**（旧红队包残留会让 cordis 直接 throw）。
  let provided = false;
  const provider = providerOf(ctx);
  if (provider === null) {
    logger.warn(`[${name}] 宿主没有 ctx.provide：redteam 服务未发布（HTTP 面板不依赖它）`);
  } else {
    try {
      provider.provide("redteam", store);
      provided = true;
    } catch (cause) {
      // `service "redteam" has been registered at <其它 fiber>` 会走到这里。
      logger.warn(
        `[${name}] ctx.provide("redteam") 失败（可能已有同名服务）：`
        + (cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  // ④ 路由：网关端口先造好（它读 ctx 里的服务，必须在 apply 作用域内）。
  const gateway = createGatewayPorts({
    ctx,
    root,
    env,
    ...(options.packageJsonPath === undefined ? {} : { packageJsonPath: options.packageJsonPath }),
    ...(options.surface === undefined ? {} : { surface: options.surface }),
  });
  const ports = createBridgePorts(store, gateway);

  const mountWith = (server: WebServerRealFace): MountResult =>
    mountRoute(server, ports, logger, sink);

  const direct = webServerOf(ctx);
  let route: MountResult | null = null;
  if (direct !== null) {
    route = mountWith(direct);
  } else {
    // webServer 还没就绪：用 cordis 的 inject 排队，服务出现时回调才跑。
    // 这样不会永久 pending（那样会拖死宿主启动），也不会留半截注册。
    const injector = injectorOf(ctx);
    if (injector === null) {
      logger.warn(`[${name}] 宿主没有 webServer，也没有 ctx.inject：${ROUTE_PATH} 无法注册`);
    } else {
      try {
        injector.inject(["webServer"], (host: HostContext) => {
          const ready = webServerOf(host);
          if (ready === null) {
            logger.warn(`[${name}] webServer 就绪但形状不符，${ROUTE_PATH} 未注册`);
            return;
          }
          const mounted = mountWith(ready);
          // 延迟回调里的 effect 挂在**新** ctx 上（cordis 为每个 inject 回调
          // 建子 fiber）。两个 effect 都会在卸载时跑，`sink.unmount()` 幂等，
          // 所以重复撤不会出错。
          runEffect(host, () => () => {
            sink.unmount();
          });
          logger.info(`[${name}] ${ROUTE_PATH} 已注册（延迟，reason=${mounted.reason}）`);
        });
        route = { registered: false, reason: "deferred" };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn(`[${name}] ctx.inject(["webServer"]) 失败：${message}`);
        route = { registered: false, reason: message };
      }
    }
  }

  logger.info(`[${name}] 就绪：root=${root}，provide=${provided ? "yes" : "no"}，route=${route?.reason ?? "none"}`);

  return { store, provided, route, error: null };
}

/**
 * Cordis 插件入口。
 *
 * 配置项（`cordis.patch.yml` 的 `config`）：
 * - `root`：数据根覆盖（默认 `$DSH_HOME/redteam`）；
 * - `surface`：宿主面标识，只用于 preflight 说明。
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const record: Record<string, unknown> =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  const rootRaw = record["root"];
  const surfaceRaw = record["surface"];
  applyWith(ctx, {
    ...(typeof rootRaw === "string" && rootRaw.trim() !== "" ? { root: rootRaw.trim() } : {}),
    ...(typeof surfaceRaw === "string" && surfaceRaw.trim() !== "" ? { surface: surfaceRaw.trim() } : {}),
  });
}

/** Cordis 插件模块形态。 */
export const plugin: PluginModule = { name, inject, apply };

export default plugin;

/* ════════════════════════════════════════════════════════ 诊断 */

/** 服务端入口的自检快照（给测试与 `qilin_status` 类工具用）。 */
export interface ServiceSnapshot {
  readonly name: string;
  readonly root: string;
  readonly configPath: string;
  readonly engagementCount: number;
  readonly skillDirCount: number;
  readonly packageVersion: string | null;
}

/** 读一份自检快照；任何一项读不到都给安全值，不抛。 */
export function snapshotOf(root: string, env: EnvLike = process.env): ServiceSnapshot {
  let engagementCount = 0;
  try {
    const dir = join(root, "engagements");
    engagementCount = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    engagementCount = 0;
  }
  let skillDirCount = 0;
  try {
    const home = env["DSH_HOME"] ?? join(homedir(), ".dsh");
    skillDirCount = readdirSync(join(home, "redteam", "skills")).filter((f) => f.endsWith(".md")).length;
  } catch {
    skillDirCount = 0;
  }
  return {
    name,
    root,
    configPath: configPathOf(root),
    engagementCount,
    skillDirCount,
    packageVersion: readPluginIdentity().version,
  };
}

/** 供测试核对「技能库归属」判定与网关一致（导出而非复制一份）。 */
export { skillLibraryOf };
