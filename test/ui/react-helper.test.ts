/**
 * 假 React 测试辅助**自身**的测试。
 *
 * 这条不是「测工具」，而是**校准测量仪器**：如果 `renderToText` 的
 * falsy 语义与真 React 不一致，那么所有基于它的组件测试都会撒谎 ——
 * 最典型的失效是「`0` 被当空值渲染」这类坑测不出来。
 *
 * 所以先证明这几点逐条对齐 React：
 * - `null` / `undefined` / `false` / `true` → 不渲染
 * - `0` / `NaN` → **渲染成文本**（这就是坑所在）
 * - `""` → 不产生文本节点
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classOf,
  containsComponent,
  findAll,
  findOne,
  fire,
  handlerOf,
  makeTestReact,
  renderToText,
  styleOf,
  textOf,
} from "./helpers/react.js";
import type { ReactNode } from "../../src/redteam/client/dom.js";

/** 取一个假 React 的 `h`。 */
function setup(): {
  readonly react: ReturnType<typeof makeTestReact>;
  readonly h: ReturnType<typeof makeTestReact>["createElement"];
} {
  const react = makeTestReact();
  return { react, h: react.createElement };
}

describe("假 React — 元素结构与 props", () => {
  it("创建标签元素并记录 type / props", () => {
    const { h } = setup();
    const element = h("div", { className: "a" });
    assert.equal(element.props["className"], "a");
  });

  it("单子节点放进 props.children", () => {
    const { h } = setup();
    const element = h("div", null, "text");
    assert.equal(element.props["children"], "text");
  });

  it("多子节点放进数组", () => {
    const { h } = setup();
    const element = h("div", null, "a", "b");
    assert.deepEqual(element.props["children"], ["a", "b"]);
  });

  it("key 被剥离出 props 并单独记录", () => {
    const { h } = setup();
    const element = h("div", { key: "k1" });
    assert.equal(element.key, "k1");
    assert.equal("key" in element.props, false);
  });

  it("ref 被剥离", () => {
    const { h } = setup();
    const element = h("div", { ref: { current: null } });
    assert.equal("ref" in element.props, false);
  });

  it("数字 key 也识别", () => {
    const { h } = setup();
    assert.equal(h("div", { key: 7 }).key, 7);
  });
});

describe("假 React — **falsy 渲染语义与真 React 对齐**", () => {
  it("null 不渲染", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, null)).text, "<div></div>");
  });

  it("undefined 不渲染", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, undefined)).text, "<div></div>");
  });

  it("false 不渲染", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, false)).text, "<div></div>");
  });

  it("true 不渲染（真 React 同样不渲染 true）", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, true)).text, "<div></div>");
  });

  it("**0 渲染成 '0'** —— 这就是 `{count && <X/>}` 的坑", () => {
    const { h } = setup();
    const result = renderToText(h("div", null, 0));
    assert.equal(result.text, "<div>0</div>", "0 必须被渲染出来（与真 React 一致）");
  });

  it("**NaN 渲染成 'NaN'**", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, Number.NaN)).text, "<div>NaN</div>");
  });

  it("空串不产生文本节点", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, "")).text, "<div></div>");
  });

  it("普通字符串渲染", () => {
    const { h } = setup();
    assert.equal(renderToText(h("span", null, "abc")).text, "<span>abc</span>");
  });

  it("数组子节点逐个渲染并保持顺序", () => {
    const { h } = setup();
    const result = renderToText(h("div", null, [h("b", null, "1"), h("i", null, "2")]));
    assert.equal(result.text, "<div><b>1</b><i>2</i></div>");
  });

  it("数组里的 falsy 项按同一规则处理", () => {
    const { h } = setup();
    const items: ReactNode[] = [null, 0, false, "x"];
    const result = renderToText(h("div", null, items));
    // null/false 消失，0 与 "x" 保留 → 与真 React 一致。
    assert.equal(result.text, "<div>0x</div>");
  });

  it("**条件渲染的经典坑可被检出**：count=0 会渲染出额外文本", () => {
    const { h } = setup();
    // 源码里常见的写法：`count && h('span', null, count)`
    const count = 0;
    const result = renderToText(h("div", null, count && h("span", null, count)));
    assert.equal(result.text, "<div>0</div>", "0 短路会直接把 0 渲染成文本");
  });

  /**
   * **属性位置 vs 子元素位置**：这是 React 里最容易搞混的一组差异。
   *
   * ```tsx
   * <div value={0} />     // 属性：0 原样保留在 props 上，不渲染成文本
   * <div>{0}</div>        // 子元素：渲染成文本 "0"
   * <div>{NaN}</div>      // 子元素：渲染成文本 "NaN"
   * <div>{null}</div>     // 子元素：不渲染
   * ```
   *
   * 混淆这两处的后果是：以为「0 在子元素里也不渲染」，于是写出
   * `{count && <Badge/>}` ——`count === 0` 时界面上多出一个 `0`。
   * 本节四条把两处行为分别钉住。
   */
  it("**属性位置的 0 保留在 props 上，不渲染成文本**", () => {
    const { h } = setup();
    const element = h("div", { value: 0 });
    assert.equal(element.props["value"], 0, "props 上是数字 0，不是字符串");
    assert.equal(renderToText(element).text, "<div></div>", "属性不参与文本渲染");
  });

  it("**子元素位置的 0 渲染成文本**", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, 0)).text, "<div>0</div>");
  });

  it("**子元素位置的 NaN 渲染成文本**", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, Number.NaN)).text, "<div>NaN</div>");
  });

  it("**子元素位置的 null 不渲染**", () => {
    const { h } = setup();
    assert.equal(renderToText(h("div", null, null)).text, "<div></div>");
  });

  it("同一元素里属性 0 与子元素 0 并存时行为各自独立", () => {
    const { h } = setup();
    const element = h("div", { value: 0 }, 0);
    assert.equal(element.props["value"], 0);
    assert.equal(renderToText(element).text, "<div>0</div>");
  });

  it("正确写法（显式判空）不产生多余文本", () => {
    const { h } = setup();
    const count = 0;
    const result = renderToText(h("div", null, count > 0 ? h("span", null, count) : null));
    assert.equal(result.text, "<div></div>");
  });
});

describe("假 React — 组件调用", () => {
  it("函数组件被调用并渲染其输出", () => {
    const { h } = setup();
    const Badge = (props: { readonly label: string }): ReactNode => h("span", null, props.label);
    const result = renderToText(h(Badge, { label: "hi" }));
    assert.equal(result.text, "<span>hi</span>");
  });

  it("组件可以嵌套", () => {
    const { h } = setup();
    const Inner = (): ReactNode => h("b", null, "in");
    const Outer = (): ReactNode => h("div", null, h(Inner, null));
    assert.equal(renderToText(h(Outer, null)).text, "<div><b>in</b></div>");
  });

  it("组件返回 null 时不渲染", () => {
    const { h } = setup();
    const Empty = (): ReactNode => null;
    assert.equal(renderToText(h("div", null, h(Empty, null))).text, "<div></div>");
  });

  it("containsComponent 能判定组件是否出现", () => {
    const { h } = setup();
    const Only = (): ReactNode => h("i", null, "x");
    const wrapper = h("div", null, h(Only, null));
    const result = renderToText(wrapper);
    assert.equal(containsComponent(result, Only), true);
  });
});

describe("查找与读取助手", () => {
  it("findAll 按标签名找", () => {
    const { h } = setup();
    const result = renderToText(h("div", null, h("span", null, "a"), h("span", null, "b")));
    assert.equal(findAll(result, "span").length, 2);
  });

  it("findAll 按谓词找", () => {
    const { h } = setup();
    const result = renderToText(h("div", null, h("span", { className: "on" }, "a"), h("span", null, "b")));
    assert.equal(findAll(result, (element) => classOf(element) === "on").length, 1);
  });

  it("findOne 找不到给 null", () => {
    const { h } = setup();
    const result = renderToText(h("div", null, "x"));
    assert.equal(findOne(result, "span"), null);
  });

  it("classOf / styleOf 读属性", () => {
    const { h } = setup();
    const element = h("div", { className: "rt-x", style: { width: 10 } });
    assert.equal(classOf(element), "rt-x");
    assert.equal(styleOf(element)["width"], 10);
  });

  it("styleOf 缺失给空对象", () => {
    const { h } = setup();
    assert.deepEqual(styleOf(h("div", null)), {});
  });

  it("handlerOf 取到函数，取不到给 null", () => {
    const { h } = setup();
    const element = h("div", { onClick: () => undefined });
    assert.equal(typeof handlerOf(element, "onClick"), "function");
    assert.equal(handlerOf(element, "onMouseDown"), null);
  });

  it("fire 触发处理器", () => {
    const { h } = setup();
    let calls = 0;
    const element = h("div", { onClick: () => { calls += 1; } });
    fire(element, "onClick");
    assert.equal(calls, 1);
  });

  it("fire 对不存在的处理器明确报错（防静默通过）", () => {
    const { h } = setup();
    assert.throws(() => fire(h("div", null), "onClick"), /没有 onClick 处理器/);
  });

  it("textOf 直接取元素文本", () => {
    const { h } = setup();
    assert.equal(textOf(h("div", null, "abc")), "abc");
  });

  it("renderToText 的 elements 含全部节点", () => {
    const { h } = setup();
    const result = renderToText(h("div", null, h("span", null, h("b", null, "x"))));
    assert.ok(result.elements.length >= 3, "div/span/b 都应被收集");
  });
});

describe("假 React — Hooks 可调用", () => {
  it("useState 返回初值与 setter", () => {
    const react = makeTestReact();
    const [value, setValue] = react.useState(5);
    assert.equal(value, 5);
    assert.equal(typeof setValue, "function");
  });

  it("useState 支持惰性初值", () => {
    const react = makeTestReact();
    const [value] = react.useState(() => 7);
    assert.equal(value, 7);
  });

  it("useRef 返回稳定的 current", () => {
    const react = makeTestReact();
    const ref = react.useRef(0);
    assert.equal(ref.current, 0);
  });

  it("useMemo 立即求值", () => {
    const react = makeTestReact();
    assert.equal(react.useMemo(() => 42, []), 42);
  });

  it("useCallback 原样返回", () => {
    const react = makeTestReact();
    const fn = (): number => 1;
    assert.equal(react.useCallback(fn, []), fn);
  });

  it("useEffect 不执行副作用（测试环境）", () => {
    const react = makeTestReact();
    let ran = false;
    react.useEffect(() => { ran = true; });
    assert.equal(ran, false);
  });
});
