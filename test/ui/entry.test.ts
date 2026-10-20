/**
 * 入口按钮测试。
 *
 * 按 lead 的策略：不只测「渲染不抛」，而是测**边界值与分支**：
 * - `wide` 的 `true` / `false` / `undefined` / `0`（falsy 陷阱）
 * - `open` 的两种状态与 className
 * - `window.open` 被拦截时的行为
 * - `location` 读取抛异常时的降级
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findOne, fire, classOf, type RecordedElement } from "./helpers/react.js";
import { createRuntime, createUiStore, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  FullButton,
  HeaderButton,
  SidebarButton,
  exitFullWindow,
  isFullWindow,
} from "../../src/redteam/client/entry.js";
import type { DshWindow, MinimalWindow, ModuleRequire, ReactLike } from "../../src/redteam/client/dom.js";
import { DEFAULT_UI_STATE } from "../../src/redteam/client/state.js";

/** 造一个可控的假 window。 */
function fakeWindow(overrides: {
  readonly hash?: string;
  readonly href?: string;
  readonly openThrows?: boolean;
  readonly locationThrows?: boolean;
  readonly closeThrows?: boolean;
} = {}): {
  readonly window: MinimalWindow;
  readonly opened: { readonly url: string; readonly target: string; readonly features: string }[];
  readonly closed: number;
  readonly reloaded: number;
  readonly hashWrites: string[];
} {
  const opened: { readonly url: string; readonly target: string; readonly features: string }[] = [];
  let closed = 0;
  let reloaded = 0;
  const hashWrites: string[] = [];
  let hash = overrides.hash ?? "";

  const location = {
    get hash(): string {
      if (overrides.locationThrows === true) throw new Error("blocked");
      return hash;
    },
    set hash(value: string) {
      hashWrites.push(value);
      hash = value;
    },
    href: overrides.href ?? "http://127.0.0.1:3000/",
    hostname: "127.0.0.1",
    port: "3000",
    reload(): void {
      reloaded += 1;
    },
  };

  const window = {
    location,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    document: {
      createElement: () => {
        throw new Error("not used");
      },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open(url: string, target: "_blank" | "_self", features: string): unknown {
      if (overrides.openThrows === true) throw new Error("popup blocked");
      opened.push({ url, target, features });
      return null;
    },
    close(): void {
      if (overrides.closeThrows === true) throw new Error("cannot close");
      closed += 1;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as DshWindow;

  return {
    window,
    opened,
    get closed() {
      return closed;
    },
    get reloaded() {
      return reloaded;
    },
    hashWrites,
  };
}

/** 造运行时。 */
function runtime(overrides: {
  readonly window?: ReturnType<typeof fakeWindow>;
  readonly initial?: typeof DEFAULT_UI_STATE;
} = {}): {
  readonly runtime: ConsoleRuntime;
  readonly react: ReturnType<typeof makeTestReact>;
  readonly window: ReturnType<typeof fakeWindow>;
} {
  const react = makeTestReact();
  const window = overrides.window ?? fakeWindow();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  const created = createRuntime(requireModule, window.window, {
    ...(overrides.initial !== undefined ? { initial: overrides.initial } : {}),
  });
  return { runtime: created, react, window };
}

/** 取按钮元素。 */
function buttonOf(node: ReturnType<typeof SidebarButton>): RecordedElement {
  const found = findOne(renderToText(node), "button");
  if (found === null) throw new Error("没渲染出 button");
  return found;
}

describe("SidebarButton", () => {
  it("渲染 button + ⛨ 图标", () => {
    const { runtime: rt } = runtime();
    const result = renderToText(SidebarButton(rt, {}));
    assert.equal(findOne(result, "button") !== null, true);
    assert.match(result.text, /⛨/);
  });

  it("open=true 时 className 带 on", () => {
    const { runtime: rt } = runtime({ initial: { open: true, tab: "assets" } });
    assert.equal(classOf(buttonOf(SidebarButton(rt, {}))), "rt-icon-btn on");
  });

  it("open=false 时 className 不带 on", () => {
    const { runtime: rt } = runtime({ initial: { open: false, tab: "assets" } });
    assert.equal(classOf(buttonOf(SidebarButton(rt, {}))), "rt-icon-btn");
  });

  it("点击切换 open 状态（每次点击后**重新渲染**，与 React 一致）", () => {
    const { runtime: rt } = runtime({ initial: { open: true, tab: "assets" } });
    // React 在 state 变化后会重渲染，产生新元素与新闭包。
    // 复用旧元素等于在测一个 React 不会出现的场景。
    fire(buttonOf(SidebarButton(rt, {})), "onClick");
    assert.equal(rt.ui.get().open, false, "点击后应关闭");
    fire(buttonOf(SidebarButton(rt, {})), "onClick");
    assert.equal(rt.ui.get().open, true, "再点应打开");
  });

  it("**未重渲染时连点也正确**（点击时读当前值，不依赖捕获的 state）", () => {
    const { runtime: rt } = runtime({ initial: { open: true, tab: "assets" } });
    const button = buttonOf(SidebarButton(rt, {}));
    fire(button, "onClick");
    fire(button, "onClick");
    assert.equal(rt.ui.get().open, true, "连点两次应回到打开（奇偶切换正确）");
  });

  it("title 与原实现一致", () => {
    const { runtime: rt } = runtime();
    assert.equal(buttonOf(SidebarButton(rt, {})).props["title"], "RedTeam 控制台（常驻右侧栏）");
  });

  it("wide=true 显示 'RedTeam' 文字", () => {
    const { runtime: rt } = runtime();
    assert.match(renderToText(SidebarButton(rt, { wide: true })).text, /RedTeam/);
  });

  it("wide=false 不显示文字", () => {
    const { runtime: rt } = runtime();
    assert.doesNotMatch(renderToText(SidebarButton(rt, { wide: false })).text, /RedTeam/);
  });

  it("wide 缺失不显示文字", () => {
    const { runtime: rt } = runtime();
    assert.doesNotMatch(renderToText(SidebarButton(rt, {})).text, /RedTeam/);
  });

  it("**wide=0（falsy 但非 false）不渲染出 0**", () => {
    // 若用 `props.wide && h(...)` 写法，0 会被直接渲染成文本。
    // 组件用 `props.wide === true` 判定，所以安全。
    const { runtime: rt } = runtime();
    const result = renderToText(SidebarButton(rt, { wide: 0 as unknown as boolean }));
    assert.doesNotMatch(result.text, /0/, "不该出现多余的 0");
  });

  it("**wide='' 不渲染出空文本节点**", () => {
    const { runtime: rt } = runtime();
    const result = renderToText(SidebarButton(rt, { wide: "" as unknown as boolean }));
    assert.equal(result.text.includes("RedTeam"), false);
  });
});

describe("HeaderButton", () => {
  it("渲染 '⛨ RedTeam' 文字", () => {
    const { runtime: rt } = runtime();
    assert.match(renderToText(HeaderButton(rt)).text, /⛨ RedTeam/);
  });

  it("open=true 时 className 是 'rt-hbtn on'（与侧栏按钮样式不同）", () => {
    const { runtime: rt } = runtime({ initial: { open: true, tab: "assets" } });
    assert.equal(classOf(buttonOf(HeaderButton(rt))), "rt-hbtn on");
  });

  it("open=false 时 className 是 'rt-hbtn'", () => {
    const { runtime: rt } = runtime({ initial: { open: false, tab: "assets" } });
    assert.equal(classOf(buttonOf(HeaderButton(rt))), "rt-hbtn");
  });

  it("点击切换 open", () => {
    const { runtime: rt } = runtime({ initial: { open: false, tab: "assets" } });
    fire(buttonOf(HeaderButton(rt)), "onClick");
    assert.equal(rt.ui.get().open, true);
  });

  it("与 SidebarButton 共享同一份 store（同一 runtime 下状态一致）", () => {
    const { runtime: rt } = runtime({ initial: { open: true, tab: "assets" } });
    fire(buttonOf(SidebarButton(rt, {})), "onClick");
    // 两个按钮读的都是 rt.ui，所以 HeaderButton 看到的是切换后的状态。
    assert.equal(rt.ui.get().open, false);
    assert.equal(classOf(buttonOf(HeaderButton(rt))), "rt-hbtn");
  });
});

describe("FullButton", () => {
  it("渲染 button + ⛶ 图标", () => {
    const { runtime: rt } = runtime();
    const result = renderToText(FullButton(rt, {}));
    assert.match(result.text, /⛶/);
  });

  it("点击在新窗口打开带 hash 的 URL", () => {
    const { runtime: rt, window } = runtime();
    fire(buttonOf(FullButton(rt, {})), "onClick");
    assert.equal(window.opened.length, 1);
    assert.equal(window.opened[0]?.url, "http://127.0.0.1:3000/#redteam-full");
    assert.equal(window.opened[0]?.target, "_blank");
    assert.equal(window.opened[0]?.features, "noopener");
  });

  it("已带 hash 时不重复拼接", () => {
    const win = fakeWindow({ href: "http://h/x#other" });
    const { runtime: rt } = runtime({ window: win });
    fire(buttonOf(FullButton(rt, {})), "onClick");
    assert.equal(win.opened[0]?.url, "http://h/x#redteam-full");
  });

  it("**window.open 抛错时不冒泡**（弹窗被拦截）", () => {
    const win = fakeWindow({ openThrows: true });
    const { runtime: rt } = runtime({ window: win });
    assert.doesNotThrow(() => fire(buttonOf(FullButton(rt, {})), "onClick"));
  });

  it("点击**不改变** UI 状态（当前窗口不受影响）", () => {
    const { runtime: rt } = runtime({ initial: { open: false, tab: "scores" } });
    fire(buttonOf(FullButton(rt, {})), "onClick");
    assert.equal(rt.ui.get().open, false);
    assert.equal(rt.ui.get().tab, "scores");
  });

  it("wide=true 显示「全面浏览」", () => {
    const { runtime: rt } = runtime();
    assert.match(renderToText(FullButton(rt, { wide: true })).text, /全面浏览/);
  });

  it("wide=false 不显示文字", () => {
    const { runtime: rt } = runtime();
    assert.doesNotMatch(renderToText(FullButton(rt, { wide: false })).text, /全面浏览/);
  });

  it("title 提示里说明 Esc 退出", () => {
    const { runtime: rt } = runtime();
    assert.match(String(buttonOf(FullButton(rt, {})).props["title"]), /Esc/);
  });
});

describe("isFullWindow", () => {
  it("hash 是 #redteam-full → true", () => {
    const { runtime: rt } = runtime({ window: fakeWindow({ hash: "#redteam-full" }) });
    assert.equal(isFullWindow(rt), true);
  });

  it("其它 hash → false", () => {
    const { runtime: rt } = runtime({ window: fakeWindow({ hash: "#other" }) });
    assert.equal(isFullWindow(rt), false);
  });

  it("空 hash → false", () => {
    const { runtime: rt } = runtime();
    assert.equal(isFullWindow(rt), false);
  });

  it("**读 location 抛错 → false**（沙箱降级，不崩）", () => {
    const { runtime: rt } = runtime({ window: fakeWindow({ locationThrows: true }) });
    assert.equal(isFullWindow(rt), false);
  });
});

describe("exitFullWindow", () => {
  it("先尝试 close()", () => {
    const win = fakeWindow({ hash: "#redteam-full" });
    const { runtime: rt } = runtime({ window: win });
    exitFullWindow(rt);
    assert.equal(win.closed, 1);
  });

  it("有 hash 时清空并 reload", () => {
    const win = fakeWindow({ hash: "#redteam-full" });
    const { runtime: rt } = runtime({ window: win });
    exitFullWindow(rt);
    assert.deepEqual(win.hashWrites, [""]);
    assert.equal(win.reloaded, 1);
  });

  it("无 hash 时不 reload（已经在普通界面）", () => {
    const win = fakeWindow({ hash: "" });
    const { runtime: rt } = runtime({ window: win });
    exitFullWindow(rt);
    assert.equal(win.reloaded, 0);
  });

  it("**close 抛错时仍继续清 hash**（非脚本打开的窗口关不掉）", () => {
    const win = fakeWindow({ hash: "#redteam-full", closeThrows: true });
    const { runtime: rt } = runtime({ window: win });
    assert.doesNotThrow(() => exitFullWindow(rt));
    assert.equal(win.reloaded, 1, "close 失败不该阻止降级路径");
  });

  it("location 读取抛错时不冒泡", () => {
    const win = fakeWindow({ locationThrows: true });
    const { runtime: rt } = runtime({ window: win });
    assert.doesNotThrow(() => exitFullWindow(rt));
  });
});

describe("UI store 语义", () => {
  it("set 合并补丁（只改指定字段）", () => {
    const react = makeTestReact();
    const store = createUiStore(react, { open: true, tab: "assets" });
    store.set({ tab: "scores" });
    assert.equal(store.get().open, true);
    assert.equal(store.get().tab, "scores");
  });

  it("**状态无变化时不通知**（避免无意义重渲染）", () => {
    const react = makeTestReact();
    const store = createUiStore(react, { open: true, tab: "assets" });
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    store.set({ open: true });
    assert.equal(notified, 0, "值没变不该通知");
    store.set({ open: false });
    assert.equal(notified, 1);
  });

  it("退订后不再收到通知", () => {
    const react = makeTestReact();
    const store = createUiStore(react, { open: true, tab: "assets" });
    let notified = 0;
    const unsubscribe = store.subscribe(() => { notified += 1; });
    store.set({ open: false });
    assert.equal(notified, 1);
    unsubscribe();
    store.set({ open: true });
    assert.equal(notified, 1, "退订后不该再通知");
  });

  it("**一个订阅者抛错不影响其它订阅者**", () => {
    const react = makeTestReact();
    const store = createUiStore(react, { open: true, tab: "assets" });
    let good = 0;
    store.subscribe(() => { throw new Error("bad subscriber"); });
    store.subscribe(() => { good += 1; });
    assert.doesNotThrow(() => store.set({ open: false }));
    assert.equal(good, 1, "坏订阅者不该阻断其它订阅者");
  });

  it("通知时传的是快照（订阅者改不到内部状态）", () => {
    const react = makeTestReact();
    const store = createUiStore(react, { open: true, tab: "assets" });
    store.subscribe((snapshot) => {
      // 尝试篡改快照不应影响 store。
      (snapshot as unknown as { open: boolean }).open = false;
    });
    store.set({ tab: "scores" });
    assert.equal(store.get().open, true, "store 内部状态不该被订阅者改动");
  });

  it("get 返回当前状态", () => {
    const react = makeTestReact();
    const store = createUiStore(react, { open: false, tab: "report" });
    assert.equal(store.get().open, false);
    assert.equal(store.get().tab, "report");
  });
});
