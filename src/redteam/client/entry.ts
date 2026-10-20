/**
 * 入口按钮：侧栏、会话头部、全面浏览。
 *
 * ## 这一组为什么先做
 *
 * 它们是**控制台的唯一入口**，且不依赖任何业务数据 —— 只依赖
 * 已完成的三块：`runtime`（window + ui store）、`helpers`（`fullWindowUrl`）、
 * `state`（`open` 开关）。用来验证「组件 + runtime 注入」这套骨架是否成立，
 * 比一上来就啃 `AssetsTab`（依赖 8 个 API 调用）成本低得多。
 *
 * ## 与原实现的差异（有意为之）
 *
 * 原实现的三个按钮直接闭包引用模块级 `setUI` / `window`：
 * ```js
 * onClick: () => setUI({ open: !st.open })
 * ```
 * 这里改成通过 `runtime` 拿 —— 于是同一个组件可以在测试里跑，
 * 也可以在同一页面的两个控制台实例里各自持有独立状态。
 *
 * **行为逐条对齐原实现**（className、title、显示器、`wide` 分支）。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import { fullWindowUrl } from "./helpers.js";
import type { CommonProps } from "./h.js";

/** 侧栏按钮的 props。 */
export interface SidebarButtonProps {
  /** 侧栏展开时是否显示「RedTeam」文字（原实现只渲染图标）。 */
  readonly wide?: boolean | undefined;
}

/** 会话头部按钮的 props（无）。 */
export type HeaderButtonProps = Readonly<Record<string, never>>;

/** 全面浏览按钮的 props。 */
export interface FullButtonProps {
  readonly wide?: boolean | undefined;
}

/**
 * 侧栏「RedTeam」开关按钮。
 *
 * 原实现：
 * ```js
 * h('button', {
 *   className: 'rt-icon-btn' + (st.open ? ' on' : ''),
 *   title: 'RedTeam 控制台（常驻右侧栏）',
 *   onClick: () => setUI({ open: !st.open }),
 * }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
 * ```
 *
 * 注意 `props.wide ? ... : null` 的写法是对的（三元而非 `&&`）：
 * 若写成 `props.wide && h(...)`，`wide === false` 时不会渲染任何东西，
 * 但 `wide` 若是 `0` 之类会渲染出 `0` —— 三元避开了这个坑。
 */
export function SidebarButton(runtime: ConsoleRuntime, props: SidebarButtonProps): ReactNode {
  const state = runtime.ui.useUi();
  return runtime.h("button", {
    className: "rt-icon-btn" + (state.open ? " on" : ""),
    title: "RedTeam 控制台（常驻右侧栏）",
    // 点击时**读当前值**而不是捕获渲染时的 `state`：
    // React 里每次渲染都会给出新闭包，所以两种写法在真 React 下等价；
    // 但读当前值对「重渲染前连点」「元素被缓存复用」都成立，没有代价。
    onClick: () => runtime.ui.set({ open: !runtime.ui.get().open }),
  },
    runtime.h("span", { style: { fontSize: 14 } }, "⛨"),
    props.wide === true ? runtime.h("span", null, "RedTeam") : null,
  );
}

/**
 * 会话头部的「RedTeam」开关按钮。
 *
 * 与侧栏按钮共用同一份状态（`open`），但样式类不同（`rt-hbtn`），
 * 且始终显示文字（原实现如此）。
 */
export function HeaderButton(runtime: ConsoleRuntime): ReactNode {
  const state = runtime.ui.useUi();
  return runtime.h("button", {
    className: "rt-hbtn" + (state.open ? " on" : ""),
    title: "RedTeam 控制台（常驻右侧栏）",
    onClick: () => runtime.ui.set({ open: !runtime.ui.get().open }),
  }, "⛨ RedTeam");
}

/**
 * 侧栏「全面浏览」：在新浏览器窗口打开完整控制台。
 *
 * 原实现把 `window.open` 包在 `try/catch` 里 —— 弹出窗口被浏览器拦截时
 * `window.open` 返回 `null`（不抛），但某些环境下会抛。
 * 两种都不该让点击看起来「没反应」：这里保留 catch，且**不改变**任何状态。
 */
export function FullButton(runtime: ConsoleRuntime, props: FullButtonProps): ReactNode {
  const open = (): void => {
    try {
      const href = runtime.window.location.href;
      runtime.window.open(fullWindowUrl(href), "_blank", "noopener");
    } catch {
      /* 被浏览器拦截：静默（原实现同样静默） */
    }
  };
  return runtime.h("button", {
    className: "rt-icon-btn",
    title: "全面浏览：在新窗口打开完整控制台（当前窗口不受影响；新窗口内按 Esc 退出）",
    onClick: open,
  },
    runtime.h("span", { style: { fontSize: 14 } }, "⛶"),
    props.wide === true ? runtime.h("span", null, "全面浏览") : null,
  );
}

/**
 * 判断当前是否在「全面浏览」独立窗口里。
 *
 * 原实现读 `window.location.hash`，并整体包 `try/catch`
 * （某些沙箱里读 `location` 会抛）。这里同样包住。
 */
export function isFullWindow(runtime: ConsoleRuntime): boolean {
  try {
    const hash = String(runtime.window.location.hash || "");
    return hash === "#redteam-full";
  } catch {
    return false;
  }
}

/** 退出全面浏览：优先 `window.close()`，关不掉则清 hash 并重载。 */
export function exitFullWindow(runtime: ConsoleRuntime): void {
  try {
    runtime.window.close();
  } catch {
    /* 非脚本打开的窗口无法 close */
  }
  try {
    if (runtime.window.location.hash) {
      runtime.window.location.hash = "";
      runtime.window.location.reload();
    }
  } catch {
    /* ignore */
  }
}

/** 入口按钮的统一 props（宿主槽位会把 `wide` 之类透传进来）。 */
export type EntryProps = CommonProps & SidebarButtonProps;
