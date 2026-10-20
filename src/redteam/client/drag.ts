/**
 * 面板拖拽 / 缩放：纯几何计算。
 *
 * ## 为什么单独一层
 *
 * 原实现把六种拖拽（拖动、左/右/下/角缩放）写在组件的闭包里，
 * 每个都直接调 `setGeom` 与 `window.addEventListener`。后果是：
 * - 无法测试（要真 window + 真鼠标事件）；
 * - 六段逻辑高度重复（都是「记起点 → 算 delta → clamp」），
 *   但每段的基准量不同（`ox+dx` vs `ow-dx` vs `ow+dx`），改一处容易漏别的。
 *
 * 这里把「起点状态 + 鼠标位移 → 新几何」抽成纯函数，六种操作变成一张表。
 * 组件只剩「监听 mousemove → 调用对应函数」。
 *
 * ## 一个必须保留的细节：左缩放的符号
 *
 * 左侧缩放时，`x` 增加量与 `w` 减少量**必须对称**（`x + dx` 与 `w - dx`），
 * 否则拖动左边缘会同时改变面板右边界 —— 视觉上像「整个面板在滑动」。
 * 原实现的 `startResizeLeft` 是对的，这里逐字保留。
 *
 * ## 另一个：clamp 的先后
 *
 * 每次都走 `clampDockGeometry`，它内部「先钳尺寸再钳位置」。
 * 若顺序反了，拖出屏幕时面板会先被钳位置、再被钳尺寸，边界会跳动。
 */

import { clampDockGeometry, type DockGeometry, type DockGeometryInput, type Viewport, DEFAULT_VIEWPORT } from "./state.js";

/** 拖拽操作类型。 */
export type DragKind = "move" | "resize-left" | "resize-right" | "resize-bottom" | "resize-corner";

/** 一次拖拽的起点快照。 */
export interface DragOrigin {
  /** 按下时的鼠标位置。 */
  readonly clientX: number;
  readonly clientY: number;
  /** 按下时的几何。 */
  readonly geometry: DockGeometry;
}

/** 从（鼠标位置, 几何）造起点。 */
export function dragOriginOf(clientX: number, clientY: number, geometry: DockGeometry): DragOrigin {
  return { clientX, clientY, geometry };
}

/**
 * 按位移算新几何。
 *
 * 六种操作在同一张表里，避免六段近似代码各自漂移。
 */
export function applyDrag(
  kind: DragKind,
  origin: DragOrigin,
  clientX: number,
  clientY: number,
  viewport: Viewport = DEFAULT_VIEWPORT,
): DockGeometry {
  const dx = clientX - origin.clientX;
  const dy = clientY - origin.clientY;
  const { x, y, w, h } = origin.geometry;

  let next: DockGeometryInput;
  switch (kind) {
    case "move":
      next = { x: x + dx, y: y + dy, w, h };
      break;
    case "resize-left":
      // 左边缘：x 与 w 反向变化，保证右边界不动。
      next = { x: x + dx, y, w: w - dx, h };
      break;
    case "resize-right":
      next = { x, y, w: w + dx, h };
      break;
    case "resize-bottom":
      next = { x, y, w, h: h + dy };
      break;
    case "resize-corner":
      next = { x, y, w: w + dx, h: h + dy };
      break;
  }
  return clampDockGeometry(next, viewport);
}

/**
 * 该不该开始拖动面板？
 *
 * 原实现：`if (e.target.closest('button,a,input,select,textarea,label')) return`
 * —— 面板头部里放了「刷新 / 全面浏览 / 收起」等按钮，点头部空白处才拖动。
 *
 * 这里把「是否交互元素」抽成可测判断。缺失 `closest` 时按「不是交互元素」处理
 * （原实现同样直接放过，因为 `e.target.closest &&` 的短路）。
 */
export const INTERACTIVE_SELECTOR = "button,a,input,select,textarea,label";

/** 事件目标的最小面。 */
export interface EventTargetLike {
  closest?(selector: string): unknown;
}

/** 判断拖拽是否应被忽略（点到交互元素）。 */
export function shouldIgnoreDrag(target: EventTargetLike | null | undefined): boolean {
  if (target === null || target === undefined) return false;
  if (typeof target.closest !== "function") return false;
  try {
    return target.closest(INTERACTIVE_SELECTOR) !== null
      && target.closest(INTERACTIVE_SELECTOR) !== undefined;
  } catch {
    // `closest` 在非 Element 节点上可能抛（Text 节点等）。
    return false;
  }
}

/**
 * 是否只响应主键（左键）。
 *
 * 原实现：`if (e.button !== 0) return`。右键 / 中键不该触发拖拽
 * （右键要出上下文菜单，中键是滚动）。
 */
export function isPrimaryButton(button: number | undefined): boolean {
  return button === 0;
}

/** 一次拖拽会话：绑定 / 解绑 mousemove + mouseup。 */
export interface DragSession {
  /** 结束拖拽（解绑）。 */
  end(): void;
}

/** 监听器注册面（便于测试注入）。 */
export interface DragHost {
  addEventListener(type: "mousemove" | "mouseup", listener: (event: MouseMoveEvent) => void): void;
  removeEventListener(type: "mousemove" | "mouseup", listener: (event: MouseMoveEvent) => void): void;
}

/** 鼠标移动事件的最小面。 */
export interface MouseMoveEvent {
  readonly clientX?: number;
  readonly clientY?: number;
}

/**
 * 开始一次拖拽。
 *
 * 返回会话对象，`end()` 时解绑 —— 调用点不必自己记两个监听器的引用
 * （原实现里 `up` 闭包捕获 `move`，六个入口各写一遍，容易漏解绑）。
 */
export function beginDrag(
  host: DragHost,
  kind: DragKind,
  origin: DragOrigin,
  onUpdate: (geometry: DockGeometry) => void,
  viewport: Viewport = DEFAULT_VIEWPORT,
): DragSession {
  let ended = false;
  const move = (event: MouseMoveEvent): void => {
    if (ended) return;
    const clientX = typeof event.clientX === "number" ? event.clientX : origin.clientX;
    const clientY = typeof event.clientY === "number" ? event.clientY : origin.clientY;
    onUpdate(applyDrag(kind, origin, clientX, clientY, viewport));
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    host.removeEventListener("mousemove", move);
    host.removeEventListener("mouseup", end);
  };
  host.addEventListener("mousemove", move);
  host.addEventListener("mouseup", end);
  return { end };
}
