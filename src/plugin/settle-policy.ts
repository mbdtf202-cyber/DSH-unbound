/**
 * 落定（settle）策略：插件启动后「要不要写盘 / 要不要重启」的唯一判定处。
 *
 * ## 背景（原实现的注释记下的真实事故）
 *
 * 官方桌面启动时 `Fiber._reload` 还在挂 desktop-office。此刻插件若解包 / 杀进程 /
 * requestRestart，会撞上 Cordis 的 `INACTIVE_EFFECT`：
 *
 *   - 症状不是崩溃，而是「点了应用没反应」「窗口关了又被拉起来」「要退出两次」。
 *   - 所以桌面面（surface === "desktop"）的 settle 一律**不重启**，
 *     密封 asar 上也不**就地重打**，等用户点「应用」。
 *
 * 这些判定原本散在 index.js 的 settleInstalledPatches 里，与 IO 混在一起，
 * 无法单测。这里抽成纯函数：输入全是值，输出全是值，没有副作用。
 */

/** 桌面面给官方 Host 的喘息窗口。web 面不需要等待。 */
export const DESKTOP_SETTLE_DELAY_MS = 4000;

/** 宿主面。原项目只有这两个，用字面量联合而不是 string。 */
export type Surface = "web" | "desktop";

/** Cordis 在 ctx 已 dispose 后继续操作时抛的错误形态。 */
export interface InactiveContextError extends Error {
  readonly code: "INACTIVE_EFFECT";
}

/**
 * 判断一个异常是不是「ctx 已经没了」。
 *
 * 两种情况都算：带 `code === "INACTIVE_EFFECT"` 的结构化错误，
 * 或者消息里含 `inactive context`（老版本只给字符串）。
 */
export function isInactiveContextError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === "string") return /inactive context/i.test(error);
  if (typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "INACTIVE_EFFECT") return true;
  const message = (error as { message?: unknown }).message;
  return /inactive context/i.test(String(message ?? ""));
}

/** settle 的上下文范围：宿主面 + 是否密封包。 */
export interface SettleScope {
  readonly surface: Surface;
  readonly sealed: boolean;
}

/** 桌面面 4s，其他 0。 */
export function settleDelayMs(surface: Surface): number {
  return surface === "desktop" ? DESKTOP_SETTLE_DELAY_MS : 0;
}

/**
 * settle 阶段是否允许**重启**。
 *
 * 桌面面一律不允许（官方启动时 `Fiber._reload` 在挂载，重启 = INACTIVE_EFFECT）；
 * 密封包也不允许，因为换包必须走用户点「应用」的完整退出。
 */
export function settleMayRestart(scope: SettleScope): boolean {
  if (scope.surface === "desktop") return false;
  if (scope.sealed) return false;
  return true;
}

/**
 * settle 阶段是否允许**就地重打补丁**。
 *
 * 只有「桌面 + 密封」被拒：密封 asar 上就地 extract/swap 会和官方 Host 的
 * `Fiber._reload` 抢锁。
 */
export function settleMayReapply(scope: SettleScope): boolean {
  if (scope.surface === "desktop" && scope.sealed) return false;
  return true;
}

/** 「点应用」之后是否重启。 */
export interface ApplyShouldRestartInput {
  /** 补丁是否全部落定。 */
  readonly complete?: boolean;
  /** 当前宿主是不是密封包。 */
  readonly sealed?: boolean;
  /** 本次实际写入了多少条补丁。 */
  readonly appliedCount?: number;
  /** 提示词是否已经写好（写好也值得重启，让新会话读到）。 */
  readonly promptReady?: boolean;
}

/**
 * 点「应用」后是否重启。网页和桌面用同一条：
 * 提示词已经写入，或这次写了补丁，就重启。对不上当前版本的代码补丁不取消重启。
 * 密封包多出来的只是换包，不另做一套判断。
 *
 * 冷却**不**放在这里——否则第一次重启没换掉 asar，第二次应用会被当成取消。
 */
export function applyShouldRestart(input: ApplyShouldRestartInput = {}): boolean {
  // 密封桌面：点「应用」后必须完全退出才能换 asar / 加载 resources/app，
  // 与补丁是否标 applied 无关。
  if (input.sealed === true) return true;
  if (input.complete === true || input.promptReady === true) return true;
  return Number(input.appliedCount ?? 0) > 0;
}

/** 生命期标记：插件 dispose 后 `alive` 变 false，settle 的每个 await 之后都要查一次。 */
export interface ContextLife {
  alive: boolean;
}
