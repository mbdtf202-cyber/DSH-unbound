/**
 * 面板外壳：三种形态 + 页签栏 + 未读红点。
 *
 * ## 三种形态（原实现的 shellProps 三分支）
 *
 * | 形态 | className | 位置 | 拖拽/缩放 |
 * |---|---|---|---|
 * | `full`（全面浏览） | `rt-full` | 铺满窗口 | 无 |
 * | `embedded`（嵌在外层 dock 里） | `rt-dock rt-embedded` | 相对定位 100% | 无 |
 * | 普通 dock | `rt-dock` | fixed + 几何 | **有** |
 *
 * 判定顺序是 `full → embedded → 普通`：全面浏览优先（它也可能同时是
 * embedded，但铺满优先）。
 *
 * ## 页签栏的可访问性
 *
 * 原实现的注释记了动机：用标准 `tablist`/`tab` 角色，读屏软件据此播报
 * 「第几个页签、是否选中」；键盘用户 Tab 进来后可用 Enter/Space 切换。
 * 这里逐条保留：`role="tablist"` 在容器、`role="tab"` + `aria-selected`
 * 在每个页签、`aria-label` 给红点做文字替代。
 *
 * ## 红点的语义
 *
 * 红点是纯视觉信息，读屏软件读不到。所以原实现给了
 * `h('span', { className: 'rt-tab-dot', 'aria-label': '有新内容' })`
 * —— 这里保留，并且**只在真有未读时才渲染**该 span。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { PropsOf } from "./h.js";
import { clickable } from "./helpers.js";
import type { MinimalPointerEventLike } from "./h.js";
import {
  ENGAGEMENT_TABS,
  TABS,
  clampDockGeometry,
  defaultDockGeometry,
  type ConsoleTabId,
  type DockGeometry,
  type TabDescriptor,
  type UnreadState,
  hasUnread,
  type UnreadMark,
} from "./state.js";
import { applyDrag, beginDrag, isPrimaryButton, shouldIgnoreDrag, dragOriginOf, type DragHost, type DragKind } from "./drag.js";
import { exitFullWindow } from "./entry.js";

/** 面板的 props。 */
export interface PanelProps {
  /** 嵌在外层 dock 里（去掉收起 / 全面浏览 / 拖拽条）。 */
  readonly embedded?: boolean | undefined;
  /** 当前靶标 id（`null` = 还没选）。 */
  readonly engagement?: string | null | undefined;
  /** 靶标名册（下拉框选项）。 */
  readonly engagements?: readonly { readonly id: string; readonly name?: string | undefined }[] | undefined;
  /**
   * 当前未读指针（宿主 `consoleDigest` 给的每个页签的 `{count, at}`）。
   *
   * 与 `seen` 配对使用：`unread` 是「现在有多少」，`seen` 是「上次看过多少」，
   * 两者比较得出红点。**缺任一都不显示红点**——只有一侧数据时无法判断
   * 「是否有新内容」，猜一个会让红点乱闪。
   */
  readonly unread?: UnreadState | undefined;
  /** 已读指针（localStorage 里记的「上次查看」快照）。 */
  readonly seen?: UnreadState | undefined;
  /** 页签内容渲染器。缺少时显示空态。 */
  readonly renderTab?: ((tab: ConsoleTabId) => ReactNode) | undefined;
  /** 页签切换回调（用于强制重取数）。 */
  readonly onTabChange?: ((tab: ConsoleTabId) => void) | undefined;
  /** 靶标切换回调。 */
  readonly onEngagementChange?: ((id: string) => void) | undefined;
  /** 创建靶标回调。 */
  readonly onCreateEngagement?: ((name: string) => void) | undefined;
  /** 刷新回调。 */
  readonly onRefresh?: (() => void) | undefined;
  /** 底部统计。 */
  readonly stats?: Readonly<Record<string, number>> | undefined;
}

/** 面板外壳的渲染结果（拆开便于测试各部件）。 */
export interface PanelParts {
  readonly root: ReactNode;
}

/** 页签是否要求先选靶标。 */
export function tabNeedsEngagement(tab: ConsoleTabId): boolean {
  return ENGAGEMENT_TABS.has(tab);
}

/**
 * 外壳形态判定。
 *
 * 顺序 `full → embedded → dock`，返回判别联合而不是散落的布尔，
 * 这样渲染分支与测试都能穷举。
 */
export type ShellKind = "full" | "embedded" | "dock";

/** 由 props + 当前是否全面浏览窗口判定形态。 */
export function shellKindOf(embedded: boolean, full: boolean): ShellKind {
  if (full) return "full";
  if (embedded) return "embedded";
  return "dock";
}

/** 某形态下的根元素属性。 */
export function shellPropsOf(
  kind: ShellKind,
  open: boolean,
  geometry: DockGeometry,
): { readonly className: string; readonly dataOpen: "1" | "0"; readonly style: Readonly<Record<string, string>> } {
  switch (kind) {
    case "full":
      return {
        className: "rt-full",
        dataOpen: "1",
        style: { display: "flex" },
      };
    case "embedded":
      return {
        className: "rt-dock rt-embedded",
        dataOpen: "1",
        style: { width: "100%", display: "flex" },
      };
    case "dock":
      return {
        className: "rt-dock",
        dataOpen: open ? "1" : "0",
        style: {
          left: geometry.x + "px",
          top: geometry.y + "px",
          right: "auto",
          bottom: "auto",
          width: geometry.w + "px",
          height: geometry.h + "px",
          display: open ? "flex" : "none",
        },
      };
  }
}

/** 该形态是否显示拖拽把手。 */
export function hasHandles(kind: ShellKind): boolean {
  return kind === "dock";
}

/** 单个页签的可访问性属性（拆出来便于逐条断言）。 */
export interface TabProps {
  readonly className: string;
  readonly role: "tab";
  readonly ariaSelected: "true" | "false";
  readonly title: string;
  readonly onClick: (event: MinimalPointerEventLike) => void;
  readonly onKeyDown: (event: MinimalPointerEventLike) => void;
  readonly ariaLabel: string | undefined;
}

/**
 * 页签条的每个页签属性。
 *
 * 单独导出便于测试：断言 `aria-selected`、红点、键盘可达性，
 * 不必把整个 Panel 渲染出来。
 */
export function tabPropsOf(
  runtime: ConsoleRuntime,
  tab: TabDescriptor,
  active: boolean,
  unread: boolean,
  onActivate: () => void,
): TabProps {
  const props = clickable(() => onActivate(), { label: tab.label });
  return {
    className: "rt-tab" + (active ? " on" : ""),
    role: "tab",
    ariaSelected: active ? "true" : "false",
    title: unread ? tab.label + "：有新内容，点开看过红点就会消失" : tab.label,
    // 处理器签名与 `clickable` 一致：接收事件对象。
    onClick: props.onClick,
    onKeyDown: props.onKeyDown,
    ariaLabel: props["aria-label"],
  };
}

/** 页签的未读判定（靶标 + 指针缺失时一律「无未读」）。 */
export function tabHasUnread(unread: UnreadState | undefined, seen: UnreadState | undefined, tab: string): boolean {
  if (unread === undefined || seen === undefined) return false;
  const current: UnreadMark | undefined = unread[tab];
  const previous: UnreadMark | undefined = seen[tab];
  return hasUnread(previous, current);
}

/**
 * 渲染面板外壳。
 *
 * 这个函数是 `Panel` 组件的**可测内核**：它不调用 hook、不读全局，
 * 只按参数拼元素树。`Panel` 组件本身只负责 `useState` / `useEffect`
 * 与事件绑定。
 */
export function renderPanel(runtime: ConsoleRuntime, props: PanelProps, options: {
  readonly uiOpen: boolean;
  readonly activeTab: ConsoleTabId;
  readonly geometry: DockGeometry;
  readonly full: boolean;
}): ReactNode {
  const { h } = runtime;
  const kind = shellKindOf(props.embedded === true, options.full);
  const shell = shellPropsOf(kind, options.uiOpen, options.geometry);
  const embedded = kind === "embedded";
  const full = kind === "full";
  const showChrome = !embedded && !full;

  const onTabActivate = (tab: ConsoleTabId): void => {
    props.onTabChange?.(tab);
  };

  const tabNodes = TABS.map((tab) => {
    const active = options.activeTab === tab.id;
    const unread = tabHasUnread(props.unread, props.seen, tab.id);
    const interactive = clickable(() => onTabActivate(tab.id), { label: tab.label });
    return h("div", {
      key: tab.id,
      className: "rt-tab" + (active ? " on" : ""),
      role: "tab",
      "aria-selected": active ? "true" : "false",
      title: unread ? tab.label + "：有新内容，点开看过红点就会消失" : tab.label,
      onClick: interactive.onClick,
      onKeyDown: interactive.onKeyDown,
      "aria-label": interactive["aria-label"],
    },
      tab.label,
      // 红点是纯视觉信息，给读屏软件一个文字替代。
      unread ? h("span", { className: "rt-tab-dot", "aria-label": "有新内容" }) : null,
    );
  });

  const engagementOptions = (props.engagements ?? []).map((item) =>
    h("option", { key: item.id, value: item.id }, item.name ?? item.id ?? "未命名"));

  const body = props.renderTab !== undefined
    ? props.renderTab(options.activeTab)
    : h("div", { className: "rt-empty" }, "未知页签");

  return h("div", {
    className: shell.className,
    "data-open": shell.dataOpen,
    style: shell.style,
  },
    // 拖拽把手只在外壳为 dock 时出现（embedded / full 没有）。
    showChrome
      ? h("div", { className: "rt-grip", title: "拖动调整宽度" })
      : null,
    showChrome
      ? h("div", { className: "rt-resize-r", title: "拖动调整宽度" })
      : null,
    showChrome
      ? h("div", { className: "rt-resize-b", title: "拖动调整高度" })
      : null,
    showChrome
      ? h("div", { className: "rt-resize-c", title: "拖动调整大小" })
      : null,
    h("div", {
      className: "rt-head",
      title: showChrome ? "按住拖动面板" : undefined,
    },
      embedded
        ? null
        : h("div", { className: "rt-title" },
            h("span", { className: "rt-dot" }),
            full ? "演练台 · 全面浏览" : "演练台",
            full ? h("span", { className: "rt-tag", style: { marginLeft: 6 } }, "独立窗口") : null,
          ),
      h("select", {
        className: "rt-input rt-eng-select",
        style: {
          maxWidth: embedded ? "100%" : "170px",
          minWidth: embedded ? "160px" : undefined,
          flex: embedded ? "1 1 200px" : undefined,
        },
        value: props.engagement ?? "",
        onChange: (event) => {
          const value = String((event.target as { value?: string } | null)?.value ?? "");
          props.onEngagementChange?.(value);
        },
      },
        h("option", { value: "", disabled: true }, engagementOptions.length > 0 ? "选择靶标" : "暂无靶标"),
        engagementOptions,
      ),
      h("div", { className: "rt-spacer" }),
      full
        ? h("button", { className: "rt-btn", title: "回到带侧栏的普通界面（或按 Esc）", onClick: () => exitFullWindow(runtime) }, "退出全面浏览")
        : null,
      embedded
        ? null
        : h("button", { className: "rt-btn", title: "刷新名册、快照与当前页面数据", onClick: () => props.onRefresh?.() }, "刷新"),
      showChrome
        ? h("button", { className: "rt-btn", title: "收起面板", onClick: () => runtime.ui.set({ open: false }) }, "收起")
        : null,
    ),
    h("div", { className: "rt-tabs", role: "tablist" }, tabNodes),
    h("div", { className: "rt-body", key: "body-" + options.activeTab }, body),
    h("div", { className: "rt-foot" },
      h("span", null, "C 段 " + (props.stats?.["segments"] ?? 0)),
      h("span", null, "资产 " + (props.stats?.["assets"] ?? 0)),
      h("div", { className: "rt-spacer" }),
      full ? h("span", null, "按 Esc 或点右上角「退出全面浏览」回到带侧栏的界面") : null,
    ),
  );
}

/** `Panel` 的 props 类型（供外部槽位注册时引用）。 */
export type PanelPropsType = PropsOf<typeof renderPanel>;

/** 拖拽把手 → 操作类型的映射（组件绑定时用）。 */
export const HANDLE_KINDS: readonly { readonly className: string; readonly kind: DragKind }[] = Object.freeze([
  { className: "rt-grip", kind: "resize-left" },
  { className: "rt-resize-r", kind: "resize-right" },
  { className: "rt-resize-b", kind: "resize-bottom" },
  { className: "rt-resize-c", kind: "resize-corner" },
]);

/**
 * 在组件里绑定拖拽。
 *
 * 抽成函数而不是内联，是为了让「按下 → 建会话 → 解绑」的生命周期只有一个来源。
 */
export function bindDrag(
  runtime: ConsoleRuntime,
  kind: DragKind,
  geometry: DockGeometry,
  clientX: number,
  clientY: number,
  onUpdate: (geometry: DockGeometry) => void,
): { readonly end: () => void } {
  const host = runtime.window as unknown as DragHost;
  return beginDrag(host, kind, dragOriginOf(clientX, clientY, geometry), onUpdate);
}

/** 该不该开始拖（主键 + 非交互元素）。 */
export function canStartDrag(button: number | undefined, target: { closest?(selector: string): unknown } | null | undefined): boolean {
  return isPrimaryButton(button) && !shouldIgnoreDrag(target);
}

/** 视口尺寸（测试可注入）。 */
export function viewportOf(windowRef: { readonly innerWidth?: number; readonly innerHeight?: number }): { readonly width: number; readonly height: number } {
  const width = typeof windowRef.innerWidth === "number" && windowRef.innerWidth > 0 ? windowRef.innerWidth : 1280;
  const height = typeof windowRef.innerHeight === "number" && windowRef.innerHeight > 0 ? windowRef.innerHeight : 800;
  return { width, height };
}

/** 初始几何（读上次宽度）。 */
export function initialGeometry(
  windowRef: { readonly innerWidth?: number; readonly innerHeight?: number },
  savedWidth: number | null,
): DockGeometry {
  return defaultDockGeometry(viewportOf(windowRef), savedWidth);
}

/** 视口变化后重新钳制。 */
export function reclampGeometry(
  geometry: DockGeometry,
  windowRef: { readonly innerWidth?: number; readonly innerHeight?: number },
): DockGeometry {
  return clampDockGeometry(geometry, viewportOf(windowRef));
}

// `applyDrag` 从这里转出：组件测试可能想直接验证拖拽结果。
export { applyDrag };
