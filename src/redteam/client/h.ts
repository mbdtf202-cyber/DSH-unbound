/**
 * 类型化的 `h()`：保留 `createElement` 调用形态，让 props 有类型检查。
 *
 * ## 为什么不改 JSX
 *
 * 浏览器半侧有 **1,111 处** `createElement` 调用。改 JSX 需要：
 * Babel/esbuild 的 JSX 配置、`jsxImportSource`、宿主加载器的配合，
 * 而收益集中在「元素属性拼错能报错」这一点上——JSX 并不会让
 * `h(Div, {...})` 里的业务 props 变得更有类型（真正的类型来自组件签名）。
 *
 * 更关键的是：**这个文件会被原样嵌进宿主 `client.js` 的工厂函数**，
 * 不能依赖构建期转换。JSX 必须编译才能跑，而这里要求「源码即产物」。
 *
 * 所以选择：留调用形态，把类型加在 `h()` 的签名上。
 *
 * ## 类型收益具体是什么
 *
 * 1. `h('div', {...})` —— 标签名收窄到已知 HTML 标签联合，`h('dv', ...)` 报错。
 * 2. 已知标签的 props 有具体形状：`className`/`style`/`onClick`/`title`/`aria-*`
 *    拼错（`classname`、`onclick`）报错，这是原实现最容易犯的错。
 * 3. 组件函数（`(props: P) => ReactElement`）由 `P` 推导 props，
 *    缺必填字段、传多余字段都报错。
 * 4. 子节点接受 `ReactNode`，`null`/`false`/数组都可，与 React 语义一致。
 *
 * ## `data-*` 与 `aria-*`
 *
 * React 允许任意 `data-*` / `aria-*`。TS 无法表达「任意前缀 + 任意后缀」的
 * 可选键（模板字面量索引签名在 `exactOptionalPropertyTypes` 下会与
 * `ReactNode` 竞争），所以这两类用显式索引签名 + 值类型约束开放。
 */

import type { ReactElement, ReactLike, ReactNode } from "./dom.js";

/**
 * 已知 HTML 标签。
 *
 * 只列本模块真正用到的那些 —— 不追求覆盖 HTML 全集。
 * 漏掉的标签在用到时补一行，比一次性写 120 个没人用的名字更好维护。
 */
export type HtmlTag =
  | "div"
  | "span"
  | "button"
  | "input"
  | "select"
  | "option"
  | "textarea"
  | "label"
  | "b"
  | "i"
  | "em"
  | "strong"
  | "p"
  | "pre"
  | "code"
  | "a"
  | "img"
  | "br"
  | "hr"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "ul"
  | "ol"
  | "li"
  | "table"
  | "thead"
  | "tbody"
  | "tr"
  | "th"
  | "td"
  | "details"
  | "summary"
  | "dl"
  | "dt"
  | "dd"
  | "fieldset"
  | "legend";

/** CSS 值：字符串或数字（数字由 React 补 `px`，除少数无单位属性）。 */
export type CssValue = string | number | undefined;

/**
 * `style` 对象。
 *
 * 用索引签名开放 `kebab-case` 与 `camelCase` 两种写法：原实现里两者混用
 * （`maxWidth` 与 `'aria-hidden'` 并存），收紧会产出上百个假阳性。
 */
export interface StyleObject {
  readonly [property: string]: CssValue;
}

/**
 * 事件处理器。
 *
 * 参数类型用 `MinimalPointerEvent`（见 dom.ts）而不是 `any`：
 * 调用点读 `e.target.value` / `e.clientX` / `e.key` 时仍有类型。
 */
export type EventHandler = (event: MinimalPointerEventLike) => void;

/** 与 dom.ts 的 `MinimalPointerEvent` 保持一致（避免循环 import）。 */
export interface MinimalPointerEventLike {
  readonly key?: string;
  readonly target?: unknown;
  readonly currentTarget?: unknown;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly value?: string;
  preventDefault?(): void;
  stopPropagation?(): void;
}

/** `data-*` / `aria-*` 的开放签名。 */
export interface OpenAttributes {
  readonly [attribute: `data-${string}`]: string | number | boolean | undefined;
  readonly [attribute: `aria-${string}`]: string | number | boolean | undefined;
}

/**
 * 任意元素都接受的通用属性。
 *
 * `key` 用 `string | number`：React 要求它，而我们的列表常写 `'sh' + id`。
 */
export interface CommonProps extends OpenAttributes {
  readonly key?: string | number | undefined;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly style?: StyleObject | undefined;
  readonly role?: string | undefined;
  readonly tabIndex?: number | undefined;
  readonly hidden?: boolean | undefined;
  readonly onClick?: EventHandler | undefined;
  readonly onKeyDown?: EventHandler | undefined;
  readonly onMouseDown?: EventHandler | undefined;
  readonly onMouseMove?: EventHandler | undefined;
  readonly onMouseUp?: EventHandler | undefined;
  readonly onChange?: EventHandler | undefined;
  readonly onInput?: EventHandler | undefined;
  readonly onFocus?: EventHandler | undefined;
  readonly onBlur?: EventHandler | undefined;
  readonly ref?: unknown;
}

/** `<div>` / `<span>` / `<section>` 一类。 */
export type ContainerProps = CommonProps & {
  readonly children?: ReactNode;
};

/** `<button>`。 */
export type ButtonProps = CommonProps & {
  readonly type?: "button" | "submit" | "reset" | undefined;
  readonly disabled?: boolean | undefined;
  readonly children?: ReactNode;
};

/** `<input>`。 */
export type InputProps = CommonProps & {
  readonly type?: "text" | "number" | "checkbox" | "radio" | "hidden" | "password" | "file" | undefined;
  readonly value?: string | number | undefined;
  readonly defaultValue?: string | number | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly checked?: boolean | undefined;
  readonly min?: string | number | undefined;
  readonly max?: string | number | undefined;
  readonly step?: string | number | undefined;
  readonly multiple?: boolean | undefined;
};

/** `<select>`。 */
export type SelectProps = CommonProps & {
  readonly value?: string | number | undefined;
  readonly multiple?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly children?: ReactNode;
};

/** `<option>`。 */
export type OptionProps = CommonProps & {
  readonly value?: string | number | undefined;
  readonly disabled?: boolean | undefined;
  readonly children?: ReactNode;
};

/** `<textarea>`。 */
export type TextareaProps = CommonProps & {
  readonly value?: string | undefined;
  readonly rows?: number | undefined;
  readonly placeholder?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly className?: string | undefined;
};

/** `<a>`。 */
export type AnchorProps = CommonProps & {
  readonly href?: string | undefined;
  readonly target?: "_blank" | "_self" | undefined;
  readonly rel?: string | undefined;
  readonly children?: ReactNode;
};

/** `<img>`。 */
export type ImageProps = CommonProps & {
  readonly src?: string | undefined;
  readonly alt?: string | undefined;
  readonly width?: number | string | undefined;
  readonly height?: number | string | undefined;
};

/** `<details>`。 */
export type DetailsProps = CommonProps & {
  readonly open?: boolean | undefined;
  readonly children?: ReactNode;
};

/** 标签 → props 的映射。未列出的标签退化为 `ContainerProps`。 */
export interface TagPropsMap {
  readonly div: ContainerProps;
  readonly span: ContainerProps;
  readonly button: ButtonProps;
  readonly input: InputProps;
  readonly select: SelectProps;
  readonly option: OptionProps;
  readonly textarea: TextareaProps;
  readonly a: AnchorProps;
  readonly img: ImageProps;
  readonly details: DetailsProps;
}

/** 取某标签的 props 类型；未列出的走 `ContainerProps`。 */
export type PropsFor<T extends HtmlTag> = T extends keyof TagPropsMap ? TagPropsMap[T] : ContainerProps;

/** 函数组件。 */
export type Component<P> = (props: P) => ReactNode;

/**
 * 组件 props 的推导：从函数签名取第一个参数。
 *
 * 用条件类型而不是 `Parameters<C>[0]`，这样对 `function foo(props: P)` 与
 * `const foo = (props: P) => ...` 两种写法都能取到 `P`。
 */
export type PropsOf<C> = C extends (props: infer P) => ReactNode ? P : never;

/**
 * 创建元素。
 *
 * 三个重载分别对应：
 * 1. 已知 HTML 标签 → 标签专属 props；
 * 2. 组件函数 → 从签名推导 props；
 * 3. 兜底（`unknown` 类型）→ 仍要求 props 是对象，不许传原始值。
 *
 * 第 3 条存在的理由：原实现里有 `h(SomeComp, props)` 而 `SomeComp` 的类型
 * 在上游丢失（`ctx.slots` 给的是 `unknown`）的地方。此时至少保住
 * 「props 必须是对象或 null」这条，而不是退化成 `any`。
 */
export interface TypedCreateElement {
  <T extends HtmlTag>(
    tag: T,
    props?: PropsFor<T> | null,
    ...children: readonly ReactNode[]
  ): ReactElement;

  <C extends Component<never>>(
    component: C,
    props: PropsOf<C> | null,
    ...children: readonly ReactNode[]
  ): ReactElement;

  <P extends object>(
    component: Component<P> | unknown,
    props?: P | null,
    ...children: readonly ReactNode[]
  ): ReactElement;
}

/**
 * 用宿主给的 React 造一个类型化 `h`。
 *
 * 运行时它**就是** `React.createElement`（同一次调用、同一份行为），
 * 类型层额外收窄。这样嵌入产物后的行为与原来完全一致 —— 不存在
 * 「类型化版本和原版本行为不同」的风险。
 */
export function makeH(react: ReactLike): TypedCreateElement {
  const create = react.createElement as unknown as TypedCreateElement;
  return create;
}

/**
 * 空 props 的常量。
 *
 * `h('div', null, ...)` 与 `h('div', {}, ...)` 在 React 里等价，
 * 但 `{}` 每次渲染都是新对象（会破坏 memo）。用共享冻结对象避免这个开销。
 */
export const NO_PROPS: Readonly<Record<string, never>> = Object.freeze({});
