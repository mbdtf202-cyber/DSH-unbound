/**
 * 控制台 UI 状态的类型。
 *
 * ## 为什么要单独建模
 *
 * 原 `client.js` 的状态是几坨裸对象：
 * ```js
 * let ui = { open: true, tab: 'assets' }
 * let geom = { x, y, w, h }              // 面板几何，来自 localStorage
 * let collapse = {}                      // 折叠状态，键是任意字符串
 * let unread = {}                        // 每个页签的已读指针
 * ```
 * 问题不是「没有类型」，而是**边界不清楚**：页签名是裸字符串
 * （`setUI({ tab: t[0] })` 里 `t[0]` 来自一个 `[[id, label], ...]` 数组，
 * 编译器不知道有哪些合法值），于是打错页签名会在 `body` 分支里
 * 静默落到 `'未知页签'`，看起来像「数据没加载」。
 *
 * 这里把四块状态分别建模：
 * - `ConsoleTabId`：页签**枚举**（12 个，含 2 个未在标签栏出现的兼容值）。
 * - `DockGeometry`：面板几何，含钳制规则。
 * - `CollapseState`：折叠状态（开放键，因为每个页签的键各不相同）。
 * - `UnreadState`：每页签的未读指针。
 */

/**
 * 页签 id。
 *
 * 前 10 个出现在标签栏；`testing` 与 `attackfiles` 是**别名**
 * —— 原实现里它们是 `assets` / `findings` 的旧路由值，仍可能出现在
 * 已持久化的状态或深链里，删掉会让老用户的界面白屏。
 */
export type ConsoleTabId =
  | "assets"
  | "env"
  | "agents"
  | "sessions"
  | "findings"
  | "chain"
  | "scores"
  | "report"
  | "knowledge"
  | "skills"
  | "testing"
  | "attackfiles"
  | "prompts";

/** 面板可见性状态（`open` + 当前页签）。 */
export interface ConsoleUiState {
  readonly open: boolean;
  readonly tab: ConsoleTabId;
}

/** 默认状态：打开面板，停在资产测绘页。 */
export const DEFAULT_UI_STATE: ConsoleUiState = Object.freeze({ open: true, tab: "assets" });

/** 状态补丁（部分字段）。 */
export type ConsoleUiPatch = Partial<ConsoleUiState>;

/** 合并补丁（与原实现的 `Object.assign({}, ui, patch)` 同语义）。 */
export function applyUiPatch(state: ConsoleUiState, patch: ConsoleUiPatch): ConsoleUiState {
  return {
    open: patch.open ?? state.open,
    tab: patch.tab ?? state.tab,
  };
}

/** 标签栏条目：`[页签 id, 显示名]`。 */
export interface TabDescriptor {
  readonly id: ConsoleTabId;
  readonly label: string;
}

/**
 * 标签栏。顺序即界面顺序（原实现同样把顺序编在数组里）。
 *
 * 只列 10 个真正显示在标签栏的页签；`testing` / `attackfiles` / `prompts`
 * 是可以在状态里出现、但不由标签栏直接切换的兼容值。
 */
export const TABS: readonly TabDescriptor[] = Object.freeze([
  { id: "assets", label: "资产测绘" },
  { id: "env", label: "环境适配" },
  { id: "agents", label: "智能体" },
  { id: "sessions", label: "会话隧道" },
  { id: "findings", label: "漏洞战果" },
  { id: "chain", label: "攻击链" },
  { id: "scores", label: "得分目标" },
  { id: "report", label: "报告" },
  { id: "knowledge", label: "知识库" },
  { id: "skills", label: "技能库" },
]);

/**
 * 需要靶标才能显示的页签。
 *
 * 「没有靶标时显示什么」是原实现里散在三处的判断
 * （`else if (!eng) body = ...`），这里变成一个集合，
 * 让「无靶标时的空状态」只有一个来源。
 */
export const ENGAGEMENT_TABS: ReadonlySet<ConsoleTabId> = new Set([
  "assets",
  "testing",
  "sessions",
  "findings",
  "attackfiles",
  "chain",
  "report",
  "scores",
]);

/** 面板几何（像素）。 */
export interface DockGeometry {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 几何的**未受信**输入形态。
 *
 * 字段显式允许 `undefined`：真实调用点读的是
 * `JSON.parse(localStorage.getItem('rt-dock-geom-v1') || 'null')`，
 * 字段可能整个缺失，也可能被手改成非数字。`finiteOr` 已按这个前提写，
 * 签名如实表达它，调用点就不必先补一层 `?? 0`。
 */
export interface DockGeometryInput {
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly w?: number | undefined;
  readonly h?: number | undefined;
}

/** 尺寸约束。 */
export const DOCK_MIN_WIDTH = 320;
export const DOCK_MIN_HEIGHT = 240;
export const DOCK_DEFAULT_WIDTH = 620;
export const DOCK_MAX_HEIGHT = 640;

/** 视口尺寸（测试可注入，不依赖真实 window）。 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 默认视口（与原实现的兜底一致）。 */
export const DEFAULT_VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });

/**
 * 把任意几何钳制进视口。
 *
 * 规则逐条对应原实现，**顺序有意义**：
 * 1. 宽先钳到 `[MIN_WIDTH, max(MIN_WIDTH, vw)]` —— 视口比最小宽还窄时，
 *    取最小宽（宁可溢出也不把面板压成不可用）。
 * 2. 高同理。
 * 3. x/y 再按「不超出右下边界」钳一次 —— 先钳尺寸再钳位置，否则
 *    用未钳制的 w 算右边界会把面板推出屏幕。
 */
export function clampDockGeometry(input: DockGeometryInput, viewport: Viewport = DEFAULT_VIEWPORT): DockGeometry {
  const vw = Math.max(viewport.width, DOCK_MIN_WIDTH);
  const vh = Math.max(viewport.height, DOCK_MIN_HEIGHT);
  const w = Math.min(Math.max(DOCK_MIN_WIDTH, finiteOr(input.w, DOCK_DEFAULT_WIDTH)), vw);
  const h = Math.min(Math.max(DOCK_MIN_HEIGHT, finiteOr(input.h, 520)), vh);
  const x = Math.min(Math.max(0, finiteOr(input.x, 0)), Math.max(0, vw - w));
  const y = Math.min(Math.max(0, finiteOr(input.y, 0)), Math.max(0, vh - h));
  return { x, y, w, h };
}

/** 非有限数回退到默认值（`Number(undefined)` 是 NaN，不能直接用）。 */
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 默认几何：贴右上角。
 *
 * 宽度优先取用户上次拖的宽度（`rt-dock-width`），受 320~1200 约束 ——
 * 这条「上次宽度」是原实现里唯一从 localStorage 读进几何的字段。
 */
export function defaultDockGeometry(
  viewport: Viewport = DEFAULT_VIEWPORT,
  savedWidth: number | null = null,
): DockGeometry {
  const w = savedWidth !== null && savedWidth >= DOCK_MIN_WIDTH && savedWidth <= 1200
    ? savedWidth
    : DOCK_DEFAULT_WIDTH;
  const h = Math.max(DOCK_MIN_HEIGHT, Math.min(DOCK_MAX_HEIGHT, viewport.height - 24));
  return clampDockGeometry({ x: Math.max(0, viewport.width - w - 12), y: 12, w, h }, viewport);
}

/** 折叠状态：键 → 是否展开。开放键是因为每个页签的折叠项不同。 */
export type CollapseState = Readonly<Record<string, boolean>>;

/**
 * 查折叠项是否展开。
 *
 * `defaultOpen` 的语义容易写错：原实现是 `defaultOpen !== false`，
 * 也就是「不传就展开」，传 `false` 才折叠。
 */
export function isSectionOpen(state: CollapseState, key: string, defaultOpen = true): boolean {
  const value = state[key];
  return value === undefined ? defaultOpen !== false : value === true;
}

/** 切换一个折叠项，返回新状态（不改原对象）。 */
export function toggleSection(state: CollapseState, key: string, defaultOpen = true): CollapseState {
  return { ...state, [key]: !isSectionOpen(state, key, defaultOpen) };
}

/** 批量设置。 */
export function setSections(state: CollapseState, keys: readonly string[], open: boolean): CollapseState {
  const next: Record<string, boolean> = { ...state };
  for (const key of keys) next[key] = open;
  return next;
}

/** 单个页签的未读指针。 */
export interface UnreadMark {
  readonly count: number;
  readonly at: string | null;
}

/** 全部页签的未读指针。 */
export type UnreadState = Readonly<Record<string, UnreadMark | undefined>>;

/**
 * 这个页签相对上次查看有没有新内容。
 *
 * 判定是**或**关系：条数变多 **或** 最新更新时间变了且更晚。
 * 只比条数会漏掉「删了两条又加了两条」这种等量变化。
 */
export function hasUnread(previous: UnreadMark | undefined, current: UnreadMark | undefined): boolean {
  if (current === undefined) return false;
  if (previous === undefined) return true;
  if (current.count > previous.count) return true;
  const previousAt = previous.at ?? "";
  const currentAt = current.at ?? "";
  return currentAt !== "" && currentAt !== previousAt && currentAt > previousAt;
}

/** 把一个页签标记为已读（写入当前指针）。 */
export function markSeen(state: UnreadState, tab: string, current: UnreadMark | undefined): UnreadState {
  if (current === undefined) return state;
  return { ...state, [tab]: { count: current.count, at: current.at } };
}

/**
 * 把宿主 `consoleDigest` 的响应归一成 `UnreadState`。
 *
 * 宿主的字段是 `{ [tab]: { count, at } }`，但 `count` 可能是字符串
 * （SQLite 聚合结果的形态），所以显式转数字。
 */
export function normalizeDigest(raw: unknown): UnreadState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, UnreadMark> = {};
  for (const [tab, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const count = Number(record["count"]);
    const at = typeof record["at"] === "string" ? record["at"] : null;
    out[tab] = { count: Number.isFinite(count) ? count : 0, at };
  }
  return out;
}
