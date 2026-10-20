/**
 * 面板外壳测试。
 *
 * 三条主线：
 * 1. **三种外壳形态**（full / embedded / dock）各自的 className、几何、把手
 * 2. **页签栏的可访问性**（role / aria-selected / 键盘可达 / 红点文字替代）
 * 3. **边界值**（未读指针缺失、靶标为空、统计缺字段）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, styleOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  HANDLE_KINDS,
  bindDrag,
  canStartDrag,
  hasHandles,
  initialGeometry,
  reclampGeometry,
  renderPanel,
  shellKindOf,
  shellPropsOf,
  tabHasUnread,
  tabNeedsEngagement,
  tabPropsOf,
  viewportOf,
  type PanelProps,
} from "../../src/redteam/client/panel.js";
import { TABS, DEFAULT_UI_STATE, type ConsoleTabId, type DockGeometry } from "../../src/redteam/client/state.js";
import type { ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

const GEOM: DockGeometry = { x: 100, y: 50, w: 600, h: 500 };

/** 造运行时。 */
function makeRuntime(): { readonly runtime: ConsoleRuntime; readonly react: ReturnType<typeof makeTestReact> } {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  return { runtime: createRuntime(requireModule, reactWindow()), react };
}

/** 极简 window（panel 只读 innerWidth/innerHeight）。 */
function reactWindow(): Parameters<typeof createRuntime>[1] {
  return {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://h/", hostname: "h", port: "1", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => { throw new Error("unused"); },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Parameters<typeof createRuntime>[1];
}

/** 渲染面板。 */
function render(
  props: PanelProps = {},
  options: {
    readonly uiOpen?: boolean;
    readonly activeTab?: ConsoleTabId;
    readonly full?: boolean;
  } = {},
): { readonly runtime: ConsoleRuntime; readonly result: ReturnType<typeof renderToText> } {
  const { runtime } = makeRuntime();
  const node = renderPanel(runtime, props, {
    uiOpen: options.uiOpen ?? true,
    activeTab: options.activeTab ?? "assets",
    geometry: GEOM,
    full: options.full ?? false,
  });
  return { runtime, result: renderToText(node) };
}

describe("shellKindOf — 形态判定顺序", () => {
  it("full 优先（即使同时 embedded）", () => {
    assert.equal(shellKindOf(true, true), "full");
  });

  it("embedded 次之", () => {
    assert.equal(shellKindOf(true, false), "embedded");
  });

  it("默认 dock", () => {
    assert.equal(shellKindOf(false, false), "dock");
  });
});

describe("shellPropsOf — 三种形态的属性", () => {
  it("full：className 是 rt-full，display flex", () => {
    const props = shellPropsOf("full", true, GEOM);
    assert.equal(props.className, "rt-full");
    assert.equal(props.style["display"], "flex");
  });

  it("full：不带几何样式（铺满窗口）", () => {
    const props = shellPropsOf("full", true, GEOM);
    assert.equal(props.style["left"], undefined);
    assert.equal(props.style["width"], undefined);
  });

  it("embedded：className 同时有 rt-dock 与 rt-embedded", () => {
    const props = shellPropsOf("embedded", true, GEOM);
    assert.equal(props.className, "rt-dock rt-embedded");
    assert.equal(props.style["width"], "100%");
  });

  it("embedded：data-open 固定 '1'（嵌在外层里没有收起态）", () => {
    assert.equal(shellPropsOf("embedded", false, GEOM).dataOpen, "1");
  });

  it("dock：几何写进 style（px 单位）", () => {
    const props = shellPropsOf("dock", true, GEOM);
    assert.equal(props.style["left"], "100px");
    assert.equal(props.style["top"], "50px");
    assert.equal(props.style["width"], "600px");
    assert.equal(props.style["height"], "500px");
  });

  it("dock：right/bottom 是 auto（用 left/top 定位）", () => {
    const props = shellPropsOf("dock", true, GEOM);
    assert.equal(props.style["right"], "auto");
    assert.equal(props.style["bottom"], "auto");
  });

  it("dock：打开时 display flex", () => {
    assert.equal(shellPropsOf("dock", true, GEOM).style["display"], "flex");
  });

  it("dock：收起时 display none", () => {
    assert.equal(shellPropsOf("dock", false, GEOM).style["display"], "none");
  });

  it("dock：data-open 反映开关", () => {
    assert.equal(shellPropsOf("dock", true, GEOM).dataOpen, "1");
    assert.equal(shellPropsOf("dock", false, GEOM).dataOpen, "0");
  });
});

describe("hasHandles", () => {
  it("只有 dock 有把手", () => {
    assert.equal(hasHandles("dock"), true);
    assert.equal(hasHandles("full"), false);
    assert.equal(hasHandles("embedded"), false);
  });

  it("HANDLE_KINDS 覆盖四种把手", () => {
    assert.equal(HANDLE_KINDS.length, 4);
    assert.deepEqual(HANDLE_KINDS.map((handle) => handle.kind), [
      "resize-left", "resize-right", "resize-bottom", "resize-corner",
    ]);
  });
});

describe("renderPanel — dock 形态", () => {
  it("根元素是 rt-dock 并带几何", () => {
    const { result } = render();
    const root = findOne(result, (element) => classOf(element) === "rt-dock");
    assert.notEqual(root, null);
    assert.equal(styleOf(root!)["width"], "600px");
  });

  it("渲染四个拖拽把手", () => {
    const { result } = render();
    for (const className of ["rt-grip", "rt-resize-r", "rt-resize-b", "rt-resize-c"]) {
      assert.notEqual(findOne(result, (element) => classOf(element) === className), null, `缺 ${className}`);
    }
  });

  it("渲染标题「演练台」", () => {
    const { result } = render();
    assert.match(result.text, /演练台/);
  });

  it("渲染「刷新」与「收起」按钮", () => {
    const { result } = render();
    const labels = findAll(result, "button").map((button) => textOf(button));
    assert.ok(labels.includes("刷新"), "缺刷新按钮");
    assert.ok(labels.includes("收起"), "缺收起按钮");
  });

  it("点「收起」把 open 置 false", () => {
    const { runtime, result } = render();
    const button = findAll(result, "button").find((element) => textOf(element) === "收起");
    assert.notEqual(button, undefined);
    fire(button!, "onClick");
    assert.equal(runtime.ui.get().open, false);
  });

  it("点「刷新」触发 onRefresh", () => {
    let refreshed = 0;
    const { result } = render({ onRefresh: () => { refreshed += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(refreshed, 1);
  });
});

describe("renderPanel — full 形态", () => {
  it("根元素是 rt-full", () => {
    const { result } = render({}, { full: true });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-full"), null);
  });

  it("标题带「全面浏览」与「独立窗口」标记", () => {
    const { result } = render({}, { full: true });
    assert.match(result.text, /演练台 · 全面浏览/);
    assert.match(result.text, /独立窗口/);
  });

  it("**没有拖拽把手**（铺满窗口不可拖）", () => {
    const { result } = render({}, { full: true });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-grip"), null);
  });

  it("渲染「退出全面浏览」而不是「收起」", () => {
    const { result } = render({}, { full: true });
    const labels = findAll(result, "button").map((button) => textOf(button));
    assert.ok(labels.includes("退出全面浏览"));
    assert.ok(!labels.includes("收起"));
  });

  it("底部提示 Esc 退出", () => {
    const { result } = render({}, { full: true });
    assert.match(result.text, /Esc/);
  });
});

describe("renderPanel — embedded 形态", () => {
  it("根元素同时有 rt-dock 与 rt-embedded", () => {
    const { result } = render({ embedded: true });
    const root = findOne(result, (element) => classOf(element) === "rt-dock rt-embedded");
    assert.notEqual(root, null);
  });

  it("**没有拖拽把手**（避免与外层按钮重叠）", () => {
    const { result } = render({ embedded: true });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-grip"), null);
  });

  it("**没有标题**（外层已有标题）", () => {
    const { result } = render({ embedded: true });
    assert.doesNotMatch(result.text, /演练台/);
  });

  it("没有「刷新」与「收起」按钮", () => {
    const { result } = render({ embedded: true });
    const labels = findAll(result, "button").map((button) => textOf(button));
    assert.ok(!labels.includes("刷新"));
    assert.ok(!labels.includes("收起"));
  });

  it("靶标下拉框宽度自适应（maxWidth 100%）", () => {
    const { result } = render({ embedded: true });
    const select = findOne(result, "select");
    assert.equal(styleOf(select!)["maxWidth"], "100%");
  });
});

describe("renderPanel — 页签栏", () => {
  it("容器有 role=tablist", () => {
    const { result } = render();
    const tablist = findOne(result, (element) => element.props["role"] === "tablist");
    assert.notEqual(tablist, null);
  });

  it("渲染 10 个页签", () => {
    const { result } = render();
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    assert.equal(tabs.length, TABS.length);
  });

  it("每个页签的 role 都是 tab", () => {
    const { result } = render();
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    for (const tab of tabs) {
      assert.equal(tab.props["role"], "tab");
    }
  });

  it("当前页签 aria-selected='true'", () => {
    const { result } = render({}, { activeTab: "scores" });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    const selected = tabs.filter((tab) => tab.props["aria-selected"] === "true");
    assert.equal(selected.length, 1, "同一时刻只有一个页签被选中");
    assert.equal(textOf(selected[0]!), "得分目标");
  });

  it("非当前页签 aria-selected='false'", () => {
    const { result } = render({}, { activeTab: "scores" });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    const others = tabs.filter((tab) => tab.props["aria-selected"] === "false");
    assert.equal(others.length, TABS.length - 1);
  });

  it("当前页签带 on 类名", () => {
    const { result } = render({}, { activeTab: "chain" });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    assert.equal(tabs.filter((tab) => classOf(tab).includes("on")).length, 1);
  });

  it("点击页签触发 onTabChange", () => {
    const changes: ConsoleTabId[] = [];
    const { result } = render({ onTabChange: (tab) => changes.push(tab) });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    fire(tabs[4]!, "onClick");
    assert.deepEqual(changes, ["findings"], "第 5 个页签是漏洞战果");
  });

  it("**键盘可达**：Enter 切换页签", () => {
    const changes: ConsoleTabId[] = [];
    const { result } = render({ onTabChange: (tab) => changes.push(tab) });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    fire(tabs[0]!, "onKeyDown", { key: "Enter" });
    assert.deepEqual(changes, ["assets"]);
  });

  it("**键盘可达**：Space 切换页签", () => {
    const changes: ConsoleTabId[] = [];
    const { result } = render({ onTabChange: (tab) => changes.push(tab) });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    fire(tabs[1]!, "onKeyDown", { key: " " });
    assert.deepEqual(changes, ["env"]);
  });

  it("每个页签有 aria-label（读屏播报名称）", () => {
    const { result } = render();
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    for (const tab of tabs) {
      assert.equal(typeof tab.props["aria-label"], "string");
    }
  });
});

describe("renderPanel — 未读红点", () => {
  it("无未读指针时不渲染红点", () => {
    const { result } = render({ unread: undefined });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-tab-dot"), null);
  });

  it("有未读时渲染红点", () => {
    const { result } = render({
      unread: { assets: { count: 3, at: "2026-01-01T00:00:00" } },
      seen: { assets: { count: 1, at: "2026-01-01T00:00:00" } },
    });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-tab-dot"), null);
  });

  it("红点有 aria-label 文字替代（纯视觉信息对读屏不可见）", () => {
    const { result } = render({
      unread: { assets: { count: 3, at: "2026-01-01T00:00:00" } },
      seen: { assets: { count: 1, at: "2026-01-01T00:00:00" } },
    });
    const dot = findOne(result, (element) => classOf(element) === "rt-tab-dot");
    assert.equal(dot!.props["aria-label"], "有新内容");
  });

  it("**只有 unread 没有 seen 时不显示红点**（无法判断是否有新内容）", () => {
    const { result } = render({
      unread: { assets: { count: 3, at: "2026-01-01T00:00:00" } },
    });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-tab-dot"), null);
  });

  it("条数没增加时不显示红点", () => {
    const { result } = render({
      unread: { assets: { count: 2, at: "t" } },
      seen: { assets: { count: 2, at: "t" } },
    });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-tab-dot"), null);
  });

  it("未读页签的 title 说明红点含义", () => {
    const { result } = render({
      unread: { assets: { count: 3, at: "2026-01-01T00:00:00" } },
      seen: { assets: { count: 1, at: "2026-01-01T00:00:00" } },
    });
    const tabs = findAll(result, (element) => element.props["role"] === "tab");
    const assetsTab = tabs.find((tab) => textOf(tab).includes("资产测绘"));
    assert.match(String(assetsTab!.props["title"]), /红点/);
  });
});

describe("tabHasUnread", () => {
  it("指针缺失 → false", () => {
    assert.equal(tabHasUnread(undefined, undefined, "assets"), false);
  });

  it("只有当前指针、无已读记录 → true", () => {
    assert.equal(tabHasUnread({ assets: { count: 1, at: null } }, {}, "assets"), true);
  });

  it("条数未增、时间未变 → false", () => {
    assert.equal(
      tabHasUnread(
        { assets: { count: 2, at: "t" } },
        { assets: { count: 2, at: "t" } },
        "assets",
      ),
      false,
    );
  });

  it("条数增加 → true", () => {
    assert.equal(
      tabHasUnread(
        { assets: { count: 3, at: "t" } },
        { assets: { count: 2, at: "t" } },
        "assets",
      ),
      true,
    );
  });

  it("查的是指定页签，不串页", () => {
    assert.equal(
      tabHasUnread({ assets: { count: 9, at: "t" } }, { chain: { count: 1, at: null } }, "chain"),
      false,
    );
  });
});

describe("tabPropsOf", () => {
  const tab = TABS[0]!;

  it("active 时 className 带 on", () => {
    const { runtime } = makeRuntime();
    assert.equal(tabPropsOf(runtime, tab, true, false, () => undefined).className, "rt-tab on");
  });

  it("inactive 时 className 无 on", () => {
    const { runtime } = makeRuntime();
    assert.equal(tabPropsOf(runtime, tab, false, false, () => undefined).className, "rt-tab");
  });

  it("ariaSelected 反映 active", () => {
    const { runtime } = makeRuntime();
    assert.equal(tabPropsOf(runtime, tab, true, false, () => undefined).ariaSelected, "true");
    assert.equal(tabPropsOf(runtime, tab, false, false, () => undefined).ariaSelected, "false");
  });

  it("unread 时 title 说明红点", () => {
    const { runtime } = makeRuntime();
    assert.match(tabPropsOf(runtime, tab, false, true, () => undefined).title, /红点/);
  });

  it("无 unread 时 title 就是页签名", () => {
    const { runtime } = makeRuntime();
    assert.equal(tabPropsOf(runtime, tab, false, false, () => undefined).title, tab.label);
  });

  it("onClick 触发激活回调", () => {
    const { runtime } = makeRuntime();
    let activated = 0;
    const props = tabPropsOf(runtime, tab, false, false, () => { activated += 1; });
    props.onClick({});
    assert.equal(activated, 1);
  });

  it("onKeyDown 的 Enter 触发激活", () => {
    const { runtime } = makeRuntime();
    let activated = 0;
    const props = tabPropsOf(runtime, tab, false, false, () => { activated += 1; });
    props.onKeyDown({ key: "Enter", preventDefault: () => undefined });
    assert.equal(activated, 1);
  });
});

describe("renderPanel — 靶标下拉", () => {
  it("无靶标时提示「暂无靶标」", () => {
    const { result } = render({ engagements: [] });
    assert.match(result.text, /暂无靶标/);
  });

  it("有靶标时提示「选择靶标」", () => {
    const { result } = render({ engagements: [{ id: "e1", name: "示例" }] });
    assert.match(result.text, /选择靶标/);
  });

  it("渲染每个靶标选项", () => {
    const { result } = render({
      engagements: [{ id: "e1", name: "甲" }, { id: "e2", name: "乙" }],
    });
    const options = findAll(result, "option");
    // 含一个占位 option。
    assert.equal(options.length, 3);
  });

  it("靶标名为空时回退用 id", () => {
    const { result } = render({ engagements: [{ id: "e9", name: undefined }] });
    assert.match(result.text, /e9/);
  });

  it("选择靶标触发 onEngagementChange", () => {
    const changes: string[] = [];
    const { result } = render({
      engagements: [{ id: "e1", name: "甲" }],
      onEngagementChange: (id) => changes.push(id),
    });
    const select = findOne(result, "select");
    fire(select!, "onChange", { target: { value: "e1" } });
    assert.deepEqual(changes, ["e1"]);
  });
});

describe("renderPanel — 底部统计", () => {
  it("统计缺字段时显示 0（不显示 undefined）", () => {
    const { result } = render({ stats: {} });
    assert.doesNotMatch(result.text, /undefined/);
    assert.match(result.text, /C 段 0/);
  });

  it("渲染各统计项", () => {
    const { result } = render({ stats: { segments: 3, assets: 12 } });
    assert.match(result.text, /C 段 3/);
    assert.match(result.text, /资产 12/);
  });
});

describe("renderPanel — 页签内容", () => {
  it("提供 renderTab 时渲染其内容", () => {
    const { runtime } = makeRuntime();
    const result = renderToText(renderPanel(runtime, {
      renderTab: () => runtime.h("div", { className: "custom-body" }, "内容"),
    }, { uiOpen: true, activeTab: "assets", geometry: GEOM, full: false }));
    assert.match(result.text, /内容/);
  });

  it("缺 renderTab 时显示「未知页签」", () => {
    const { result } = render();
    assert.match(result.text, /未知页签/);
  });
});

describe("视口与几何助手", () => {
  it("viewportOf 读 innerWidth/innerHeight", () => {
    assert.deepEqual(viewportOf({ innerWidth: 1000, innerHeight: 700 }), { width: 1000, height: 700 });
  });

  it("**viewportOf 对 0 / 缺失回退默认值**（防除零与 NaN 几何）", () => {
    assert.deepEqual(viewportOf({}), { width: 1280, height: 800 });
    assert.deepEqual(viewportOf({ innerWidth: 0, innerHeight: 0 }), { width: 1280, height: 800 });
  });

  it("initialGeometry 贴右上角", () => {
    const geometry = initialGeometry({ innerWidth: 1280, innerHeight: 800 }, null);
    assert.equal(geometry.y, 12);
    assert.ok(geometry.x > 0);
  });

  it("initialGeometry 沿用上次宽度", () => {
    assert.equal(initialGeometry({ innerWidth: 1280, innerHeight: 800 }, 900).w, 900);
  });

  it("reclampGeometry 在视口缩小时钳制", () => {
    const clamped = reclampGeometry(GEOM, { innerWidth: 700, innerHeight: 600 });
    assert.ok(clamped.w <= 700);
    assert.ok(clamped.h <= 600);
  });
});

describe("拖拽入口", () => {
  it("canStartDrag：左键 + 非交互元素 → true", () => {
    assert.equal(canStartDrag(0, { closest: () => null }), true);
  });

  it("canStartDrag：右键 → false", () => {
    assert.equal(canStartDrag(2, { closest: () => null }), false);
  });

  it("canStartDrag：点在按钮上 → false", () => {
    assert.equal(canStartDrag(0, { closest: () => ({}) }), false);
  });

  it("bindDrag 返回可结束的会话", () => {
    const { runtime } = makeRuntime();
    const session = bindDrag(runtime, "move", GEOM, 100, 100, () => undefined);
    assert.equal(typeof session.end, "function");
    assert.doesNotThrow(() => session.end());
  });
});

describe("tabNeedsEngagement", () => {
  it("资产测绘需要靶标", () => {
    assert.equal(tabNeedsEngagement("assets"), true);
  });

  it("知识库 / 环境 / 技能库不需要", () => {
    for (const tab of ["knowledge", "env", "skills"] as const) {
      assert.equal(tabNeedsEngagement(tab), false, `${tab} 不该要求靶标`);
    }
  });
});

describe("默认状态", () => {
  it("DEFAULT_UI_STATE 是打开 + 资产测绘", () => {
    assert.equal(DEFAULT_UI_STATE.open, true);
    assert.equal(DEFAULT_UI_STATE.tab, "assets");
  });
});
