/**
 * 测试用的「假 React」+ 元素树字符串化。
 *
 * ## 为什么需要它
 *
 * 本仓库**刻意零外部依赖**（`package.json` 的 `dependencies` 是 `{}`），
 * 所以 `react-dom/server` 用不了。而组件测试又必须真的「渲染一次」，
 * 否则 `{cond && <X/>}` 里 `cond` 为 `0` 时渲染出 `0` 这类坑完全测不到。
 *
 * ## 做法
 *
 * 写一个 `ReactLike` 实现：`createElement` 不返回不透明句柄，而返回
 * **可断言的对象树**；再配一个 `renderToText` 把树拼成字符串。
 *
 * 这样比 HTML 字符串断言更好用：可以直接查「这里是不是渲染了一个 0」，
 * 而不是在 `>0<` 这种 HTML 片段里猜它是文本还是属性。
 *
 * ## 忠实复刻的 React 语义（关键）
 *
 * `renderToText` 必须与 React 的**假值渲染规则**逐条一致，否则测试会撒谎：
 *
 * | 子节点值 | React 行为 | 这里的行为 |
 * |---|---|---|
 * | `null` | 不渲染 | 不渲染 |
 * | `undefined` | 不渲染 | 不渲染 |
 * | `false` | 不渲染 | 不渲染 |
 * | `true` | 不渲染 | 不渲染 |
 * | `0` | **渲染成 "0"** | 渲染成 "0" |
 * | `""` | **渲染成空串**（不产生文本节点） | 不渲染 |
 * | `NaN` | **渲染成 "NaN"** | 渲染成 "NaN" |
 * | 数组 | 逐个渲染，`key` 用于 diff | 逐个渲染 |
 *
 * 第三列与第四列的区别正是 `{count && <Badge/>}` 在 `count === 0` 时
 * 渲染出 `0` 的原因 —— 这是 React 最经典的坑，也是本项目 `formatTimestamp(0)`
 * 那个 bug 的同源问题（falsy 值被当成「没有」）。
 */

import type {
  ReactElement,
  ReactLike,
  ReactNode,
  ReactComponentConstructor,
  ReactComponentInstance,
} from "../../../src/redteam/client/dom.js";
import type { EventHandler, MinimalPointerEventLike, StyleObject } from "../../../src/redteam/client/h.js";

/**
 * 记录下来的元素。`type` 是标签名或组件函数。
 *
 * **继承 `ReactElement`**：这样它既能塞进 `ReactNode`（组件测试需要），
 * 又能被测试读取 props/children 做断言。继承而不是「结构兼容」是必须的 ——
 * `ReactElement` 全成员可选，会触发 TS 的 weak type 检测，结构兼容过不了。
 */
export interface RecordedElement extends ReactElement {
  readonly kind: "element";
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly RecordedChild[];
  /** 用于断言 key 是否设置。 */
  readonly key: string | number | null;
}

/** 记录下来的子节点（已按 React 规则过滤/保留）。 */
export type RecordedChild =
  | RecordedElement
  | { readonly kind: "text"; readonly text: string }
  /** 被渲染为文本的原始值（0 / NaN 之类）。 */
  | { readonly kind: "value"; readonly value: number };

/**
 * 假 React 的 `createElement`：**返回可断言元素**而不是不透明句柄。
 *
 * 这是本辅助存在的全部理由：真 React 的 `createElement` 返回不透明对象，
 * 测试拿不到 props/children 做断言。这里把返回类型如实声明成
 * `RecordedElement`，测试就不用到处写 `as unknown as`。
 */
export interface TestCreateElement {
  (
    type: unknown,
    props?: Readonly<Record<string, unknown>> | null,
    ...children: readonly ReactNode[]
  ): RecordedElement;
}

/** 假 React：除 `createElement` 外与 `ReactLike` 一致。 */
export type TestReact = Omit<ReactLike, "createElement"> & {
  readonly createElement: TestCreateElement;
  /** 本次渲染记录过的全部元素（调试用）。 */
  readonly rendered: readonly RecordedElement[];
};

/** 把 ReactNode 归一成记录用的子节点（**按 React 语义**）。 */
function toChildren(node: ReactNode): readonly RecordedChild[] {
  if (node === null || node === undefined) return [];
  if (typeof node === "boolean") return [];
  if (typeof node === "string") return node === "" ? [] : [{ kind: "text", text: node }];
  if (typeof node === "number") {
    // React 会把 0 与 NaN 渲染成文本；这是「坑」的根源，必须复刻。
    return [{ kind: "value", value: node }];
  }
  if (Array.isArray(node)) {
    const out: RecordedChild[] = [];
    for (const child of node) out.push(...toChildren(child as ReactNode));
    return out;
  }
  // 到这里只可能是已记录的元素（ReactElement 与 RecordedElement 同构）。
  return [node as unknown as RecordedElement];
}

/** 判断是不是我们记录的元���。 */
function isRecordedElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && (value as RecordedElement).kind === "element";
}

/** 假 React 构造器。 */
export function makeTestReact(): TestReact {
  const rendered: RecordedElement[] = [];

  const createElement = (
    type: unknown,
    props?: Readonly<Record<string, unknown>> | null,
    ...children: readonly ReactNode[]
  ): RecordedElement => {
    const merged = { ...(props ?? {}) } as Record<string, unknown>;
    // React 的 props.children 语义：一个子节点传值，多个传数组。
    if (children.length === 1) merged["children"] = children[0];
    else if (children.length > 1) merged["children"] = children;

    const rawKey = merged["key"];
    const key = typeof rawKey === "string" || typeof rawKey === "number" ? rawKey : null;
    delete merged["key"];
    delete merged["ref"];

    const element: RecordedElement = {
      kind: "element",
      type,
      props: merged,
      children: toChildren(merged["children"] as ReactNode),
      key,
    };
    rendered.push(element);
    return element;
  };

  /** 最小可用的类组件基类（供错误边界测试）。 */
  class Component implements ReactComponentInstance {
    props: Readonly<Record<string, unknown>>;
    state: Readonly<Record<string, unknown>> = {};
    constructor(props: Readonly<Record<string, unknown>>) {
      this.props = props;
    }
    setState(patch: Readonly<Record<string, unknown>>): void {
      this.state = { ...this.state, ...patch };
    }
    render(): ReactNode {
      return null;
    }
  }

  const React = {
    createElement,
    useState<T>(initial: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
      const value = typeof initial === "function" ? (initial as () => T)() : initial;
      return [value, () => undefined];
    },
    useEffect(): void {
      /* 测试里不跑 effect */
    },
    useRef<T>(initial: T): { current: T } {
      return { current: initial };
    },
    useMemo<T>(factory: () => T): T {
      return factory();
    },
    useCallback<T>(callback: T): T {
      return callback;
    },
    Component: Component as unknown as ReactComponentConstructor,
    rendered,
  };

  return React;
}

/** 渲染结果：文本 + 元素树（供细粒度断言）。 */
export interface RenderResult {
  readonly text: string;
  readonly elements: readonly RecordedElement[];
}

/** 递归渲染一个子节点。 */
function renderChild(child: RecordedChild): string {
  switch (child.kind) {
    case "text":
      return child.text;
    case "value":
      return String(child.value);
    case "element":
      return renderElement(child);
  }
}

/** 取参与样式断言的 props（本次用不上值，只用于存在性断言）。 */
export function propsOf(element: RecordedElement): Readonly<Record<string, unknown>> {
  return element.props;
}

/** 取 className（缺失 → 空串）。 */
export function classOf(element: RecordedElement): string {
  const value = element.props["className"];
  return typeof value === "string" ? value : "";
}

/** 取 style 对象。 */
export function styleOf(element: RecordedElement): StyleObject {
  const value = element.props["style"];
  return typeof value === "object" && value !== null ? (value as StyleObject) : {};
}

/** 取事件处理器（用于断言可点击性）。 */
export function handlerOf(element: RecordedElement, name: string): EventHandler | null {
  const value = element.props[name];
  return typeof value === "function" ? (value as EventHandler) : null;
}

/** 模拟点击 / 按键（测试键盘可达性）。 */
export function fire(element: RecordedElement, name: string, event: Partial<MinimalPointerEventLike> = {}): void {
  const handler = handlerOf(element, name);
  if (handler === null) throw new Error(`元素上没有 ${name} 处理器`);
  handler({
    ...event,
    preventDefault: event.preventDefault ?? (() => undefined),
    stopPropagation: event.stopPropagation ?? (() => undefined),
  });
}

/**
 * 渲染一个元素为文本。
 *
 * 组件函数会被**调用**（模拟 React 渲染），标签名会被渲染成
 * `<tag>children</tag>` —— 保留结构便于断言嵌套与顺序。
 */
function renderElement(element: RecordedElement): string {
  const inner = element.children.map(renderChild).join("");
  if (typeof element.type === "function") {
    // 组件：调用它拿子树，再渲染。props 含 key 已剥离的原始 props。
    const output = (element.type as (props: Readonly<Record<string, unknown>>) => ReactNode)(element.props);
    return toChildren(output).map(renderChild).join("");
  }
  if (typeof element.type === "string") {
    return `<${element.type}>${inner}</${element.type}>`;
  }
  return inner;
}

/** 渲染任意 ReactNode 成文本。 */
export function renderToText(node: ReactNode): RenderResult {
  const children = toChildren(node);
  const elements: RecordedElement[] = [];
  const collect = (child: RecordedChild): void => {
    if (child.kind === "element") {
      elements.push(child);
      for (const grandchild of child.children) collect(grandchild);
    }
  };
  for (const child of children) collect(child);
  return { text: children.map(renderChild).join(""), elements };
}

/**
 * 在渲染结果里找元素（按标签名或组件函数）。
 *
 * 用 `find` 而不是选择器字符串：测试直接持有组件引用更可靠，
 * 也不会因为 className 改动而失效。
 */
export function findAll(
  result: RenderResult,
  matcher: string | ((element: RecordedElement) => boolean),
): readonly RecordedElement[] {
  const predicate = typeof matcher === "string"
    ? (element: RecordedElement): boolean => element.type === matcher
    : matcher;
  return result.elements.filter(predicate);
}

/** 找第一个匹配的元素（找不到 → `null`）。 */
export function findOne(
  result: RenderResult,
  matcher: string | ((element: RecordedElement) => boolean),
): RecordedElement | null {
  const found = findAll(result, matcher);
  return found[0] ?? null;
}

/** 断言辅助：判断元素树里是否存在某个组件。 */
export function containsComponent(result: RenderResult, component: unknown): boolean {
  return result.elements.some((element) => element.type === component);
}

/** 便利：直接从元素断言（不必先 renderToText）。 */
export function textOf(element: RecordedElement): string {
  return element.children.map(renderChild).join("");
}
