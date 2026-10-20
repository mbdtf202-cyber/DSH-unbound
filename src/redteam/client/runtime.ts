/**
 * 控制台运行时上下文。
 *
 * ## 为什么要这一层
 *
 * 原实现的组件直接闭包引用模块级的 `ui` / `setUI` / `window`：
 * ```js
 * function SidebarButton(props) {
 *   const st = useUI()                    // ← 闭包里的模块级 store
 *   return h('button', { onClick: () => setUI({ open: !st.open }) })
 * }
 * ```
 * 后果是**组件不可测**：任何一次渲染都要求页面里存在 `document`、
 * `localStorage`，还要先把模块级 store 初始化好。测试只能靠「整包加载
 * 一次」来做，粒度粗到无法断言单个分支。
 *
 * 这里把「React + 窗口 + UI store」收进 `ConsoleRuntime`，组件通过参数
 * 拿到它。于是：
 * - 生产：`createRuntime()` 用真 `window` 与真 React 造一份；
 * - 测试：手写一份 runtime，`window` 是个普通对象，store 是个变量。
 *
 * setter 不再是模块级单例，而是 runtime 的一部分 —— 这也顺带修掉了
 * 原实现里「多个控制台实例共享一份 state」的隐患（全面浏览窗口与主窗口
 * 在同一页面里同时存在时）。
 */

import type {
  DshWindow,
  MinimalStorage,
  MinimalWindow,
  ModuleRequire,
  ReactLike,
  ReactNode,
} from "./dom.js";
import { makeH, type TypedCreateElement } from "./h.js";
import {
  applyUiPatch,
  DEFAULT_UI_STATE,
  type ConsoleTabId,
  type ConsoleUiPatch,
  type ConsoleUiState,
} from "./state.js";

/**
 * 订阅者：state 变化时被调用。
 *
 * 原实现用 `Set` 存订阅者，回调抛错被吞掉（`try { f(snap) } catch {}`）——
 * 保留这个行为：一个坏订阅者不该让整个界面停摆。
 */
export type UiSubscriber = (state: ConsoleUiState) => void;

/** UI store：读写面板状态。 */
export interface UiStore {
  /** 读当前状态（渲染时用，非 hook）。 */
  get(): ConsoleUiState;
  /** 合并补丁并通知订阅者。 */
  set(patch: ConsoleUiPatch): void;
  /** 订阅变化，返回退订函数。 */
  subscribe(subscriber: UiSubscriber): () => void;
  /**
   * Hook 形态的读取：组件里用。
   *
   * 与 `get()` 的区别是会随 store 变化重渲染 —— 内部用
   * `useState` + `useEffect` 订阅，与原实现的 `useUI` 等价。
   */
  useUi(): ConsoleUiState;
}

/** 存储键（与原实现逐字一致，改动会让老用户的界面状态丢失）。 */
export const STORAGE_KEYS = Object.freeze({
  /** 面板几何。 */
  geometry: "rt-dock-geom-v1",
  /** 上次拖动的宽度。 */
  width: "rt-dock-width",
  /** 每页签未读指针的前缀（后缀是靶标 id）。 */
  unreadPrefix: "rt-unread:",
  /** 折叠状态的前缀（后缀是页签 + 靶标）。 */
  collapsePrefix: "rt-collapse:",
} as const);

/**
 * 安全读 localStorage。
 *
 * 隐私模式 / 沙箱 iframe 下访问 `localStorage` 会**抛异常**（不是返回 null）。
 * 原实现每处都包 `try/catch`，这里统一成一个函数，避免漏包。
 */
export function safeStorage(windowRef: MinimalWindow): MinimalStorage | null {
  try {
    return windowRef.localStorage;
  } catch {
    return null;
  }
}

/** 安全读一个存储项。 */
export function readStorage(windowRef: MinimalWindow, key: string): string | null {
  const storage = safeStorage(windowRef);
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** 安全写一个存储项（写失败不影响功能）。 */
export function writeStorage(windowRef: MinimalWindow, key: string, value: string): void {
  const storage = safeStorage(windowRef);
  if (storage === null) return;
  try {
    storage.setItem(key, value);
  } catch {
    /* 配额满 / 隐私模式：不持久化也能用 */
  }
}

/** 控制台运行时：组件拿到的全部外部能力。 */
export interface ConsoleRuntime {
  /** 类型化 `h`（运行时就是 `React.createElement`）。 */
  readonly h: TypedCreateElement;
  /** 本次运行的 React（组件/hook 用）。 */
  readonly React: ReactLike;
  /** 窗口。测试里传普通对象。 */
  readonly window: DshWindow | MinimalWindow;
  /** UI store。 */
  readonly ui: UiStore;
  /** 诊断日志（默认吞掉，宿主可注入 logger）。 */
  readonly log: (message: string) => void;
}

/** 造 UI store。`notifyOnSet` 供测试观察通知。 */
export function createUiStore(react: ReactLike, initial: ConsoleUiState = DEFAULT_UI_STATE): UiStore {
  let state = initial;
  const subscribers = new Set<UiSubscriber>();

  const notify = (): void => {
    // **冻结的拷贝**，不是内部对象的引用：
    // · 拷贝：订阅者改了也影响不到 store（否则它改的是内部 state 本身）；
    // · 冻结：订阅者想改会抛（严格模式下），而不是静默污染。
    const snapshot: ConsoleUiState = Object.freeze({ open: state.open, tab: state.tab });
    // 复制订阅者列表再遍历：回调里退订不该影响本轮通知。
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber(snapshot);
      } catch {
        /* 一个坏订阅者不该让整个界面停摆（原实现同样吞掉） */
      }
    }
  };

  return {
    get: () => state,
    set(patch) {
      const next = applyUiPatch(state, patch);
      // 无变化时**不通知**：避免无意义的重渲染（原实现每次 set 都通知）。
      if (next.open === state.open && next.tab === state.tab) return;
      // **先更新再通知**：订阅者在回调里调 `get()` 必须看到新值。
      state = next;
      notify();
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    useUi() {
      const [snapshot, setSnapshot] = react.useState<ConsoleUiState>(() => state);
      react.useEffect(() => {
        const subscriber: UiSubscriber = (next) => setSnapshot(next);
        subscribers.add(subscriber);
        // 挂载时同步一次：订阅之前可能已经变过。
        setSnapshot(Object.freeze({ open: state.open, tab: state.tab }));
        return () => {
          subscribers.delete(subscriber);
        };
      }, []);
      return snapshot;
    },
  };
}

/** 造运行时。`require` 来自宿主的工厂参数。 */
export function createRuntime(
  requireModule: ModuleRequire,
  windowRef: DshWindow | MinimalWindow,
  options: { readonly initial?: ConsoleUiState; readonly log?: (message: string) => void } = {},
): ConsoleRuntime {
  const React = requireModule("react");
  const ui = createUiStore(React, options.initial ?? DEFAULT_UI_STATE);
  const log = options.log ?? (() => undefined);
  return {
    h: makeH(React),
    React,
    window: windowRef,
    ui,
    log,
  };
}

/** 页签是否合法（运行时校验未受信输入用）。 */
export function isConsoleTabId(value: unknown): value is ConsoleTabId {
  return typeof value === "string" && [
    "assets", "env", "agents", "sessions", "findings", "chain",
    "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
  ].includes(value);
}

/** 渲染一个节点（测试便利：把组件当函数调用）。 */
export function renderWith(runtime: ConsoleRuntime, node: () => ReactNode): ReactNode {
  return node();
}
