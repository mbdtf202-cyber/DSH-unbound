/**
 * 自动续跑与自动重试的判定逻辑。
 *
 * 迁移自 dsh-qilin/lib/continue-retry.js 的纯逻辑部分。
 *
 * ## 这块为什么值得单独成模块
 *
 * 原文件顶部有一条关键注释：
 * ```
 * [dsh-qilin] 二轮立刻发被拒根因之一: idle 后 280ms 自动续跑与用户 submit 竞态。
 * 关自动续跑,只保留 autoRetry(request-error 自动重试)。
 * ```
 * 也就是说 `autoContinue` 默认关闭是**踩过线上问题后刻意做的选择**，不是随手设的默认值。
 * 迁移时必须保留这个默认，否则会把已经修掉的竞态重新引回来。
 *
 * ## 判定分两层
 *
 * 1. **能不能续跑**（`shouldAutoContinue`）：失败原因不是永久性的，才值得再发一轮
 * 2. **能不能重试**（`shouldAutoRetry`）：永久失败（鉴权/配额/上下文超限）重试无意义
 *
 * "继续"这类兜底手段对 `RATE_LIMIT` 与 `TRANSPORT` 也无效——官方自己已经重试过了，
 * 再发一轮只会叠加压力。这条规则体现在 `NO_CONTINUE_CODES` 比 `PERMANENT_CODES` 多两项。
 */

/** 插件默认配置。`autoContinue: false` 是刻意选择，见文件头。 */
export const DEFAULT_CONTINUE_RETRY = Object.freeze({
  autoRetry: true,
  retryMax: 3,
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
});

/** 归一化后的配置。 */
export interface ContinueRetryConfig {
  readonly autoRetry: boolean;
  readonly retryMax: number;
  readonly autoContinue: boolean;
  readonly continueMax: number;
  readonly continueText: string;
}

/**
 * 永久性失败码：重试或续跑都不会改变结果。
 *
 * 鉴权、配额、模型不存在、上下文超限都属于「换个问法也一样」。
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID",
  "INVALID_REQUEST",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "BILLING",
  "MODEL_NOT_FOUND",
  "CONTEXT_OVERFLOW",
  "CONTEXT_LENGTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "NO_ADAPTER",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
]);

/**
 * 不该靠「继续」化解的码 = 永久码 + 限流 + 传输层。
 *
 * 后两项官方已内置重试；再插一轮「继续」只会加剧拥塞。
 */
const NO_CONTINUE_CODES: ReadonlySet<string> = new Set([...PERMANENT_CODES, "RATE_LIMIT", "TRANSPORT"]);

/** 视为异常结束的 kind。 */
const ABNORMAL_KINDS: ReadonlySet<string> = new Set(["error", "aborted", "interrupted", "max-tokens"]);

/** 把任意输入夹到 [0,20] 的整数；非法返回 fallback。 */
export function clampCount(value: unknown, fallback = 3): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

/**
 * 归一化配置。
 *
 * 注意两条「上限为 0 就等于关闭」的联动：
 *  - `retryMax === 0` → `autoRetry` 强制 false
 *  - `continueMax === 0` → `autoContinue` 强制 false
 * 这样用户不必同时改两个开关。
 */
export function normalizeConfig(raw: unknown = {}): ContinueRetryConfig {
  const src: Record<string, unknown> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const retryMax = clampCount(src["retryMax"], DEFAULT_CONTINUE_RETRY.retryMax);
  const continueMax = clampCount(src["continueMax"], DEFAULT_CONTINUE_RETRY.continueMax);
  const rawText = typeof src["continueText"] === "string" ? src["continueText"].trim() : "";
  return {
    autoRetry: src["autoRetry"] !== false && retryMax > 0,
    retryMax,
    autoContinue: src["autoContinue"] === true && continueMax > 0,
    continueMax,
    continueText: rawText === "" ? DEFAULT_CONTINUE_RETRY.continueText : rawText,
  };
}

/**
 * 合并插件配置与已保存设置（保存的优先）。
 *
 * `autoContinue` 有一条额外约束：只有**插件配置显式开启**时才允许生效。
 * 原因见文件头——自动续跑曾与用户 submit 抢跑。这条约束防止用户把
 * 保存的旧配置带回来重新打开它。
 */
export function mergeConfig(pluginCfg: unknown, saved: unknown): ContinueRetryConfig {
  const merged: Record<string, unknown> = {
    ...DEFAULT_CONTINUE_RETRY,
    ...(pluginCfg !== null && typeof pluginCfg === "object" ? (pluginCfg as Record<string, unknown>) : {}),
    ...(saved !== null && typeof saved === "object" ? (saved as Record<string, unknown>) : {}),
  };
  const pluginWanted =
    pluginCfg !== null && typeof pluginCfg === "object"
      ? (pluginCfg as Record<string, unknown>)["autoContinue"] === true
      : false;
  if (!pluginWanted && !DEFAULT_CONTINUE_RETRY.autoContinue) {
    merged["autoContinue"] = false;
  }
  return normalizeConfig(merged);
}

/** 一处会话事件（只用到 type）。 */
export interface TurnEvent {
  readonly type?: string;
  readonly [key: string]: unknown;
}

/** 最后一个 turn/end 事件；没有则 null。 */
export function lastTurnEnd(events: unknown): TurnEvent | null {
  const list: unknown[] = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i] as TurnEvent | null | undefined;
    if (event?.type === "turn/end") return event;
  }
  return null;
}

/** 结束原因的形状。字段都是可选的，因为不同失败路径填的不同。 */
export interface TurnEndReason {
  readonly kind?: string;
  readonly reason?: unknown;
  readonly code?: string;
  readonly error?: { readonly code?: string };
  readonly failure?: { readonly code?: string };
}

/** 是否是用户主动中断（不是系统故障）。 */
export function isUserAbort(reason: TurnEndReason | null | undefined): boolean {
  if (reason === null || reason === undefined || reason.kind !== "aborted") return false;
  const cause = reason.reason;
  if (cause === "user" || cause === "cancel") return true;
  if (cause !== null && typeof cause === "object") {
    const kind = (cause as { kind?: unknown }).kind;
    return kind === "user" || kind === "cancel";
  }
  return false;
}

/** 是否是异常结束（错误 / 中断 / 达到 token 上限）。 */
export function isAbnormalReason(reason: TurnEndReason | null | undefined): boolean {
  if (reason === null || reason === undefined) return false;
  return typeof reason.kind === "string" && ABNORMAL_KINDS.has(reason.kind);
}

/**
 * 提取失败码（统一大写）。
 *
 * 三个来源按优先级：`reason.error.code` → `reason.failure.code` → `reason.code`。
 * 兼容这三种是因为不同版本的宿主填在不同位置。
 */
export function failureCodeOf(reason: TurnEndReason | null | undefined): string {
  const raw = reason?.error?.code ?? reason?.failure?.code ?? reason?.code;
  return String(raw ?? "").toUpperCase();
}

/** 「继续」这一轮是否有意义。 */
export function shouldAutoContinue(reason: TurnEndReason | null | undefined): boolean {
  if (!isAbnormalReason(reason) || isUserAbort(reason)) return false;
  const code = failureCodeOf(reason);
  // 没有错误码 → 可能是纯中断，继续有意义
  return code === "" || !NO_CONTINUE_CODES.has(code);
}

/** 该失败码是否永久性（重试无意义）。 */
export function isPermanentFailure(code: unknown): boolean {
  return PERMANENT_CODES.has(String(code ?? "").toUpperCase());
}

/** 是否应该自动重试。已 abort 的请求不重试（用户已经不要了）。 */
export function shouldAutoRetry(
  failure: { readonly code?: unknown } | null | undefined,
  signal: { readonly aborted?: boolean } | null | undefined,
): boolean {
  if (signal?.aborted === true) return false;
  return !isPermanentFailure(failure?.code);
}
