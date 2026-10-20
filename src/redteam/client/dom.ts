/**
 * 最小浏览器类型声明。
 *
 * ## 为什么不引入 `lib.dom`
 *
 * `tsconfig.json` 的 `lib` 只有 `["ES2023"]` —— 这是**故意的**：
 * 本仓库的主体是 Node 侧库代码（补丁引擎、文件操作、宿主交互），
 * 一旦把整套 DOM 类型塞进全局，`fetch` / `setTimeout` / `document`
 * 这些名字会与 Node 侧的 `node:timers`、`undici` 等声明**竞争合并**，
 * 典型症状是 `fetch` 的返回类型在两个库之间反复覆盖，报错指向用户代码。
 *
 * 浏览器半侧真正用到的 DOM 面积很小（就 6 个全局 + 若干属性），
 * 手写一遍反而更准，也把「这一层依赖浏览器」标得清清楚楚。
 *
 * ## 覆盖范围
 *
 * 只声明**本模块真正读取**的成员。多写一个就多一处需要跟上游对齐的负担。
 */

/** 事件目标的最小面（`addEventListener` 的签名不参与推导，统一 unknown）。 */
export interface MinimalEventTarget {
  addEventListener(type: string, listener: (event: MinimalEvent) => void): void;
  removeEventListener(type: string, listener: (event: MinimalEvent) => void): void;
}

/** 事件对象：本模块只用 `key`、`target`、`currentTarget` 与 preventDefault/stopPropagation。 */
export interface MinimalEvent {
  readonly key?: string;
  readonly target?: unknown;
  readonly currentTarget?: unknown;
  preventDefault?(): void;
  stopPropagation?(): void;
}

/** React 的合成事件里我们读的那几个字段（鼠标事件）。 */
export interface MinimalPointerEvent extends MinimalEvent {
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly value?: string;
}

/** `<style>` 元素的最小面。 */
export interface MinimalStyleElement {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/** `<textarea>` / `<input>` 的最小面。 */
export interface MinimalFormControl {
  value: string;
  style: { position: string; left: string };
  setAttribute(name: string, value: string): void;
  select(): void;
}

/** `<head>` / `<body>` 的最小面。 */
export interface MinimalContainerElement {
  append(child: MinimalStyleElement | MinimalFormControl): void;
  appendChild(child: MinimalStyleElement | MinimalFormControl): unknown;
  removeChild(child: MinimalStyleElement | MinimalFormControl): unknown;
}

/** `document`。 */
export interface MinimalDocument {
  createElement(tag: "style"): MinimalStyleElement;
  createElement(tag: "textarea"): MinimalFormControl;
  readonly head: MinimalContainerElement;
  readonly body: MinimalContainerElement;
  execCommand(command: "copy"): boolean;
}

/** `localStorage`。隐私模式下访问会抛，所以调用点必须 try/catch。 */
export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `navigator.clipboard` 的最小面。 */
export interface MinimalClipboard {
  writeText(text: string): Promise<void>;
}

/** `navigator`。 */
export interface MinimalNavigator {
  readonly clipboard?: MinimalClipboard;
  readonly userAgent?: string;
}

/** `window.location`。 */
export interface MinimalLocation {
  hash: string;
  href: string;
  readonly hostname: string;
  readonly port: string;
  reload(): void;
}

/** `window.open` 的选项（本模块只用 `_blank` + 特性串）。 */
export type WindowOpenTarget = "_blank" | "_self";

/** `window`。 */
export interface MinimalWindow extends MinimalEventTarget {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly location: MinimalLocation;
  readonly localStorage: MinimalStorage;
  readonly navigator?: MinimalNavigator;
  readonly document: MinimalDocument;
  open(url: string, target: WindowOpenTarget, features: string): unknown;
  close(): void;
}

/**
 * 宿主注入的模块加载器契约。
 *
 * **这是宿主的模块契约，不是我们的设计**：`client.js` 必须以
 * `window.__ModuleLoader__.load({ id, factory })` 的形式注册，
 * 改成 ESM 就加载不到（宿主只为这个形状提供了加载入口）。
 */
export interface ModuleLoader {
  load(module: {
    readonly id: string;
    readonly factory: (require: ModuleRequire) => unknown;
  }): void;
}

/** `factory(require)` 的 require：只接受宿主任可的几个模块名。 */
export type ModuleRequire = (id: "react") => ReactLike;

/**
 * React 的最小面。
 *
 * 只声明本模块用到的 API。`createElement` 的返回类型用 `ReactNode`
 * ——它必须能嵌进自身（元素可作子节点）。
 */
export interface ReactLike {
  createElement(
    type: unknown,
    props?: Readonly<Record<string, unknown>> | null,
    ...children: readonly ReactNode[]
  ): ReactElement;
  useState<T>(initial: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useCallback<T>(callback: T, deps: readonly unknown[]): T;
  /**
   * 错误边界基类。
   *
   * 全项目只有一处（`RtBoundary`），但它是**唯一的类组件**，
   * 而错误边界在 React 里没有 Hook 等价物 —— 必须用 class。
   * 声明最小面：`state` / `props` / `setState` + 对象生命周期方法。
   */
  readonly Component: ReactComponentConstructor;
}

/** 类组件实例。 */
export interface ReactComponentInstance {
  props: Readonly<Record<string, unknown>>;
  state: Readonly<Record<string, unknown>>;
  setState(patch: Readonly<Record<string, unknown>>): void;
  render(): ReactNode;
}

/** 类组件构造函数。 */
export interface ReactComponentConstructor {
  new (props: Readonly<Record<string, unknown>>): ReactComponentInstance;
  /** 错误边界的静态方法：从错误推导新 state。 */
  getDerivedStateFromError?(error: unknown): Readonly<Record<string, unknown>> | null;
}

/**
 * React 元素。
 *
 * **对 src 不透明**：这个接口没有任何可读成员，所以库代码无法
 * `element.props` 之类地读内部结构（那是真实的越界访问，真 React
 * 的元素形状也不是我们该依赖的契约）。
 *
 * **对测试结构化开放**：品牌是**可选**的（`?: never`），因此测试里
 * 的替身对象不需要构造一个 `unique symbol` 值就能满足这个类型 ——
 * 用 `unique symbol` 必填字段会把所有测试替身挡在门外，而测试恰恰
 * 需要读 props 做断言。
 *
 * ## ⚠️ 这个品牌**不提供强保证**
 *
 * 必填的 `unique symbol` 是「绝对不可能伪造」；`?: never` 只是
 * 「不能提供值，但可以省略」。所以**现在真正挡住外部对象的不是品牌**
 * —— 是这个接口**没有任何可读成员**（`props` / `children` 之类都不存在），
 * 库代码读不到元素内部结构。
 *
 * 换句话说：品牌在这个形态下只是一个「提示性标记」，别把它当成
 * 类型安全的关键。要恢复强保证，唯一的办法是让测试侧用
 * `as unknown as` —— 但那等于关掉类型检查，代价更大，不划算。
 */
export interface ReactElement {
  readonly $$dshUnboundElement?: never;
}

/** 可渲染节点。 */
export type ReactNode =
  | ReactElement
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ReactNode[];

/**
 * `fetch` 响应的最小面。
 *
 * 只声明本模块真正读的成员。**不引入 `lib.dom`**：那会带来 `Body`/`Headers`/
 * `Request`/`Response` 整套声明，与 Node 侧的 `undici` 类型竞争合并，
 * 典型症状是 `fetch` 的返回类型在两者之间反复覆盖、报错指向用户代码。
 */
export interface MinimalFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

/** `fetch` 的选项。 */
export interface MinimalFetchInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * `fetch` 的最小签名。
 *
 * 单独抽出 `FetchLike` 是为了**可注入**：`api.ts` 接收 `deps.fetch`
 * 而不是直接读全局，测试里就能喂任意响应而不用伪造 `globalThis.fetch`。
 */
export type FetchLike = (input: string, init: MinimalFetchInit) => Promise<MinimalFetchResponse>;

/** 全局注入：宿主在页面里先建好 `window.__ModuleLoader__`。 */
export interface DshWindow extends MinimalWindow {
  readonly __ModuleLoader__: ModuleLoader;
  readonly fetch: FetchLike;
}
