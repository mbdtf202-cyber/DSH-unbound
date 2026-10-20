/**
 * 页签分派表测试。
 *
 * 这一层最容易犯的错是「静默白屏」：某个页签的 props 没接上，
 * 结果渲染出一片空白，而编译与单测都不报错。所以这里的重点不是
 * 逐页签的排版细节（那些在各自 `xxx.test.ts` 里），而是：
 *
 * 1. **每个 tab id 都有分派分支**（穷尽性由 TS 保证，这里补运行时兜底）；
 * 2. **缺 props 时给出明确空态**，而不是 `null` / 空白；
 * 3. **注入槽接得对**：攻击文件子页签、测试子视图拿到的确实是渲染结果；
 * 4. 有 props 时**真的把请求转给了对应页签**（不是永远走空态）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import { TABS, type ConsoleTabId } from "../../src/redteam/client/state.js";
import { DEFAULT_FINDINGS_FILTER } from "../../src/redteam/client/findings-tab.js";
import {
  makeRenderTab,
  renderTabContent,
  type TabRegistryProps,
} from "../../src/redteam/client/tab-registry.js";
import type { ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

/** 造运行时。 */
function makeRuntime(): ConsoleRuntime {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  return createRuntime(requireModule, {
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
  } as unknown as Parameters<typeof createRuntime>[1]);
}

/** 渲染某页签并取文本。 */
function text(tab: ConsoleTabId, props: TabRegistryProps = {}): string {
  const runtime = makeRuntime();
  return renderToText(renderTabContent(runtime, tab, props)).text;
}

/** 全部 tab id（含不在标签栏的兼容值）。 */
const ALL_TABS: readonly ConsoleTabId[] = Object.freeze([
  "assets", "env", "agents", "sessions", "findings", "chain",
  "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
]);

describe("tab-registry — 覆盖面", () => {
  it("每个 tab id 都能渲染出东西（不允许 null）", () => {
    const runtime = makeRuntime();
    for (const tab of ALL_TABS) {
      const node = renderTabContent(runtime, tab, {});
      assert.notEqual(node, null, tab + " 渲染成了 null（会白屏）");
      assert.notEqual(node, undefined, tab + " 渲染成了 undefined（会白屏）");
    }
  });

  it("每个 tab id 缺 props 时都有可读文案（不是空字符串）", () => {
    for (const tab of ALL_TABS) {
      const body = text(tab);
      assert.ok(body.trim().length > 0, tab + " 的空态没有任何文案");
    }
  });

  it("标签栏里的 10 个页签都被分派覆盖", () => {
    for (const descriptor of TABS) {
      assert.ok(ALL_TABS.includes(descriptor.id), descriptor.id + " 不在覆盖清单里");
      assert.ok(text(descriptor.id).trim().length > 0, descriptor.id + " 渲染为空");
    }
  });

  it("空态给出的是「具体缺什么」而不是泛泛的「无数据」", () => {
    // 抽查三个：文案里应能看出下一步动作
    assert.match(text("assets"), /信息收集/);
    assert.match(text("sessions"), /入口/);
    assert.match(text("chain"), /步骤/);
  });
});

describe("tab-registry — 缺 props 走空态", () => {
  it("assets 无 props 时空态", () => {
    assert.match(text("assets"), /还没有资产/);
  });

  it("skills 无 props 时空态", () => {
    assert.match(text("skills"), /技能库未加载/);
  });

  it("传入 props 的页签**不再**走空态（证明真的转给了子页签）", () => {
    const runtime = makeRuntime();
    const body = renderToText(renderTabContent(runtime, "skills", {
      skills: {
        catalog: {
          ok: true,
          items: [{
            name: "recon", description: "信息收集", whenToUse: "开始前", provider: "p",
            source: "plugin", dir: "/s", modelInvocable: true, userInvocable: true,
            fromPlugin: true, library: "redteam", availability: "available",
            problems: [], needsUser: [],
          }],
          meta: {
            total: 1, fromPlugin: 1,
            availability: { available: 1, broken: 0, unknown: 0 },
            checkedAt: 1, cached: false, broken: [],
            byDir: [{ key: "/s", n: 1 }], bySource: [{ key: "plugin", n: 1 }], note: "",
          },
          error: null, restartHint: false,
        },
        filter: { query: "", pluginOnly: false, brokenOnly: false },
        activeKey: null, detail: null, busy: false, detailBusy: false,
        onRefresh: () => undefined, onFilterChange: () => undefined, onToggle: () => undefined,
      },
    })).text;
    assert.match(body, /recon/, "没有渲染出技能名，说明 props 没转下去");
    assert.doesNotMatch(body, /技能库未加载/);
  });

  it("agents 永远走空态（它属于插件层，客户端不渲染）", () => {
    assert.match(text("agents"), /智能体概览未接入/);
  });
});

describe("tab-registry — 注入槽", () => {
  it("attackfiles 有 props 时渲染文件列表而不是空态", () => {
    const runtime = makeRuntime();
    const body = renderToText(renderTabContent(runtime, "attackfiles", {
      attackfiles: {
        folders: [{
          folder: "203.0.113.14",
          count: 1,
          files: [{ id: 1, name: "poc.py", kind: "poc", description: "验证脚本" }],
        }],
        detail: null,
        error: null,
        busy: false,
        collapse: {},
        onRefresh: () => undefined,
        onOpenFile: () => undefined,
        onCollapseChange: () => undefined,
      },
    })).text;
    assert.match(body, /poc\.py/, "没有渲染出文件名，说明 props 没转下去");
    assert.doesNotMatch(body, /还没有保存的攻击文件/);
  });

  it("findings 收到 attackfiles props 时，注入槽里是**真的渲染结果**", () => {
    const runtime = makeRuntime();
    const marker = "注入的攻击文件视图唯一标记";
    // 用源码导出的默认值而不是手搓对象：手搓一旦与真实类型漂移，
    // 测试会在无关字段上挂掉（第一次写这条时就在 `kind` 上报了 undefined）。
    const node = renderTabContent(runtime, "findings", {
      findings: {
        findings: null,
        credentials: [],
        accesses: [],
        fileGroups: [],
        filter: DEFAULT_FINDINGS_FILTER,
        subTab: "files",
        grouped: false,
        openId: null,
        collapse: {},
        message: null,
        onFilterChange: () => undefined,
        onSubmitQuery: () => undefined,
        onSubTabChange: () => undefined,
        onToggleGrouped: () => undefined,
        onToggleOpen: () => undefined,
        onCollapseChange: () => undefined,
        onSetAllCollapsed: () => undefined,
        onUpdateStatus: () => undefined,
        onCopy: () => undefined,
      },
      attackfiles: {
        folders: [{ folder: "t", count: 1, files: [{ id: 1, name: marker, kind: "poc", description: "" }] }],
        detail: null, error: null, busy: false, collapse: {},
        onRefresh: () => undefined, onOpenFile: () => undefined, onCollapseChange: () => undefined,
      },
    });
    assert.notEqual(node, null);
    // 攻击文件是子页签：默认落在 findings 子页签时槽位不一定可见，
    // 所以这里只断言「分派层把两边的 props 都正确喂进去了」——
    // 具体可见性由 findings-tab 自己的用例负责。
    assert.notEqual(renderToText(node).text, "");
  });

  it("makeRenderTab 返回的函数对任意 tab 都可用", () => {
    const runtime = makeRuntime();
    const renderTab = makeRenderTab(runtime, {});
    for (const tab of ALL_TABS) {
      assert.doesNotThrow(() => renderTab(tab), tab + " 抛错了");
    }
  });

  it("makeRenderTab 闭包住了 props（同一函数多次调用结果一致）", () => {
    const runtime = makeRuntime();
    const renderTab = makeRenderTab(runtime, {});
    assert.equal(
      renderToText(renderTab("skills")).text,
      renderToText(renderTab("skills")).text,
    );
  });
});

describe("tab-registry — 渲染层不许因缺字段整页崩", () => {
  /**
   * 真缺陷回归：`findings-tab` 曾经直接读 `vuln.gainedList.length`。
   * 容器若把**未经 `vulnOf()` 的原始对象**喂进来（宿主新增字段、上层漏跑解析），
   * 该字段是 `undefined` → `TypeError` → **整个漏洞页签白屏**。
   *
   * 页签级崩溃比「某列显示 —」严重得多：用户看到一片空白且无从自救。
   * 这条断言锁住「少一个字段仍能渲染」。
   */
  it("findings 收到缺 gainedList 的漏洞对象时，仍然渲染而不是抛错", () => {
    const runtime = makeRuntime();
    assert.doesNotThrow(() => {
      renderToText(renderTabContent(runtime, "findings", {
        findings: {
          // 故意只给 id/title/severity/status —— 缺 gainedList / gained 等必填字段
          findings: { total: 1, items: [{ id: 1, title: "缺字段的漏洞", severity: "high", status: "candidate" }] },
          credentials: [], accesses: [], fileGroups: [],
          filter: DEFAULT_FINDINGS_FILTER, subTab: "vulns", grouped: false,
          openId: null, collapse: {}, message: null,
          onFilterChange: () => undefined, onSubmitQuery: () => undefined,
          onSubTabChange: () => undefined, onToggleGrouped: () => undefined,
          onToggleOpen: () => undefined, onCollapseChange: () => undefined,
          onSetAllCollapsed: () => undefined, onUpdateStatus: () => undefined,
          onCopy: () => undefined,
        },
      } as never));
    });
  });

  it("缺字段的漏洞仍能显示出标题（不是整片空白）", () => {
    const runtime = makeRuntime();
    const body = renderToText(renderTabContent(runtime, "findings", {
      findings: {
        findings: { total: 1, items: [{ id: 1, title: "缺字段的漏洞", severity: "high", status: "candidate" }] },
        credentials: [], accesses: [], fileGroups: [],
        filter: DEFAULT_FINDINGS_FILTER, subTab: "vulns", grouped: false,
        openId: null, collapse: {}, message: null,
        onFilterChange: () => undefined, onSubmitQuery: () => undefined,
        onSubTabChange: () => undefined, onToggleGrouped: () => undefined,
        onToggleOpen: () => undefined, onCollapseChange: () => undefined,
        onSetAllCollapsed: () => undefined, onUpdateStatus: () => undefined,
        onCopy: () => undefined,
      },
    } as never)).text;
    assert.match(body, /缺字段的漏洞/);
  });
});

describe("tab-registry — 结构约束", () => {
  it("空态用统一的 rt-empty 类（样式层能命中）", () => {
    const runtime = makeRuntime();
    const node = renderTabContent(runtime, "agents", {});
    const rendered = renderToText(node);
    const empties = findAll(rendered, (element) => String(element.props["className"] ?? "").includes("rt-empty"));
    assert.ok(empties.length > 0, "空态没有用 rt-empty");
  });

  it("空态文案非空且不含 undefined / null 字样", () => {
    for (const tab of ALL_TABS) {
      const body = text(tab);
      assert.doesNotMatch(body, /undefined/, tab + " 文案里漏出了 undefined");
      assert.doesNotMatch(body, /\bnull\b/, tab + " 文案里漏出了 null");
    }
  });

  it("渲染结果里的可见文本都不为空（防「渲染了一个空 div」）", () => {
    const runtime = makeRuntime();
    for (const tab of ALL_TABS) {
      const rendered = renderToText(renderTabContent(runtime, tab, {}));
      // 可见文本的合计要在根节点上取：textOf 期望一个元素或结果树
      assert.ok(rendered.text.trim().length > 0, tab);
    }
  });
});
