/**
 * 控制台容器测试：**宿主耦合层**。
 *
 * ## 这一层要证明什么
 *
 * `client/**` 已被 3,600+ 用例覆盖（纯函数，好测）。真正没被测过的是
 * 「把纯函数接到宿主契约上」这一段 —— 它只在浏览器里跑，出错的表现是
 * **面板不出现**（用户看到一片空白，控制台里可能一条日志都没有）。
 *
 * 所以这里逐条锁住 apply 的每个分支：
 * 1. 契约：`name` / `inject` / `apply` 三个导出齐全且形态正确；
 * 2. 前置失败**报可读日志**而不是静默（无 window / 无 fetch / 无 slots）；
 * 3. 成功路径真的调了 `slots.inject` + `slots.register`，槽位参数与上游一致；
 * 4. 挂上去的组件能渲染出面板（不是空函数）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText } from "./helpers/react.js";
import type { DshWindow, ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";
import type { ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  INJECT,
  MODULE_NAME,
  SLOT_ID,
  SLOT_NAME,
  SLOT_ORDER,
  currentOf,
  engagementsOf,
  makeConsoleApp,
  makeConsoleModule,
  savedWidthOf,
  type ConsoleHostContext,
  type SlotFace,
} from "../../src/redteam/ui/console.js";
import type { ApiClient, ApiResponse } from "../../src/redteam/client/api.js";

/** 假 react 的 require（宿主 provide 的那一份）。 */
function requireOf(): ModuleRequire {
  const react = makeTestReact();
  return () => react as unknown as ReactLike;
}

/**
 * 极简窗口。
 *
 * 声明成 `DshWindow`（含 `__ModuleLoader__` 与 `fetch`）而不是 `MinimalWindow`：
 * 容器的 `ConsoleInit.windowOf` 签名要求 `DshWindow | null` —— 它必须同时有
 * fetch（取数）与 moduleLoader（宿主契约）。测试替身如实满足该契约，
 * 不用 `as unknown as` 骗过类型检查。
 */
function baseWindow(): DshWindow {
  return {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://h/", hostname: "h", port: "1", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => {
        throw new Error("未使用");
      },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    __ModuleLoader__: { load: () => undefined },
    fetch: () => Promise.resolve({ ok: true, status: 200, statusText: "OK", text: () => Promise.resolve("{\"ok\":true}") }),
  };
}

/**
 * 不带 fetch 的窗口（验证前置检查）。
 *
 * 直接覆写成 `undefined` 而不是 `delete`：`DshWindow.fetch` 是必填字段，
 * `delete` 之后对象就不满足类型了，而容器判断的是「取出来是不是函数」，
 * 所以 `undefined` 就能触发同一条前置检查分支。
 */
function windowWithoutFetch(): DshWindow {
  return { ...baseWindow(), fetch: undefined as unknown as DshWindow["fetch"] };
}

/** 记录槽位注册的假 ctx。 */
interface SlotRecorder {
  readonly ctx: ConsoleHostContext;
  readonly injected: readonly string[];
  readonly registered: readonly { readonly slot: unknown; readonly component: () => unknown }[];
  readonly warnings: readonly string[];
}

function makeSlotRecorder(options: { readonly withInject?: boolean } = {}): SlotRecorder {
  const injected: string[] = [];
  const registered: { slot: unknown; component: () => unknown }[] = [];
  const warnings: string[] = [];
  const slots: SlotFace = {
    register(slot, component) {
      registered.push({ slot, component });
    },
    ...(options.withInject === false
      ? {}
      : {
          inject(name: string, register: () => void) {
            injected.push(name);
            register();
          },
        }),
  };
  return {
    ctx: { slots, logger: { warn: (message: string) => warnings.push(message) } },
    injected,
    registered,
    warnings,
  };
}

/** 造一个「永远返回给定响应」的假 api 客户端。 */
function fakeApi(response: ApiResponse = { ok: true }): ApiClient {
  const raw = async (): Promise<ApiResponse> => response;
  return {
    raw,
    snapshot: raw,
    assets: raw,
    asset: raw,
    vulns: raw,
    sessions: raw,
    chain: raw,
    scores: raw,
    report: raw,
    consoleDigest: raw,
    shotData: raw,
    activateEngagement: raw,
  };
}

describe("宿主契约 —— 三个导出", () => {
  it("name 是包名（宿主用它对上 package.json）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.equal(module.name, MODULE_NAME);
    assert.equal(module.name, "dsh-unbound");
  });

  it("inject 只要 slots 与 locale（与上游一致）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.deepEqual([...module.inject], ["slots", "locale"]);
    assert.deepEqual([...INJECT], ["slots", "locale"]);
  });

  it("inject 里不含 pluginPackages（Cordis 会空等到宿主退出码 1）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.equal(module.inject.includes("pluginPackages"), false);
  });

  it("apply 是函数", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.equal(typeof module.apply, "function");
  });

  it("槽位参数与上游一致：shell.overlay / order 50", () => {
    assert.equal(SLOT_NAME, "shell.overlay");
    assert.equal(SLOT_ORDER, 50);
    assert.equal(SLOT_ID, "dsh-unbound-console");
  });
});

describe("apply —— 前置条件缺失时报可读日志（不静默、不抛）", () => {
  it("没有 window → 记一条 warn（说明环境不支持），不抛", () => {
    const recorder = makeSlotRecorder();
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.doesNotThrow(() => module.apply(recorder.ctx));
    assert.equal(recorder.registered.length, 0, "没有 window 时不该注册任何槽位");
    assert.equal(recorder.warnings.length, 1);
    assert.match(recorder.warnings[0] ?? "", /没有 window/);
  });

  it("ctx 是 null → 也不抛（宿主提前调 apply 的场景）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: baseWindow });
    assert.doesNotThrow(() => module.apply(null));
  });

  it("没有 slots 服务 → 记 warn 说明原因", () => {
    const warnings: string[] = [];
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: baseWindow });
    module.apply({ logger: { warn: (message) => warnings.push(message) } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /slots/);
  });

  it("window 没有 fetch → 记 warn（面板没法取数，挂上去也是白屏）", () => {
    const recorder = makeSlotRecorder();
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: windowWithoutFetch });
    module.apply(recorder.ctx);
    assert.equal(recorder.registered.length, 0);
    assert.equal(recorder.warnings.length, 1);
    assert.match(recorder.warnings[0] ?? "", /fetch/);
  });

  it("logger 本身抛错不影响挂载判定（不能因日志把插件拖崩）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.doesNotThrow(() => module.apply({
      logger: {
        warn: () => {
          throw new Error("logger 坏了");
        },
      },
    }));
  });
});

describe("apply —— 成功路径", () => {
  /** 一个带 fetch 的窗口（baseWindow 本身就有，这里保留是为了用例语义清晰）。 */
  function windowWithFetch(): DshWindow {
    return baseWindow();
  }

  it("先 inject 槽位再 register（宿主约定：等槽位就绪）", () => {
    const recorder = makeSlotRecorder();
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: windowWithFetch });
    module.apply(recorder.ctx);
    assert.deepEqual([...recorder.injected], [SLOT_NAME]);
    assert.equal(recorder.registered.length, 1);
  });

  it("注册的槽位形状正确（name / id / order）", () => {
    const recorder = makeSlotRecorder();
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: windowWithFetch });
    module.apply(recorder.ctx);
    assert.deepEqual(recorder.registered[0]?.slot, {
      name: "shell.overlay",
      id: "dsh-unbound-console",
      order: 50,
    });
  });

  it("没有 slots.inject 时退化为直接 register（老宿主兼容）", () => {
    const recorder = makeSlotRecorder({ withInject: false });
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: windowWithFetch });
    module.apply(recorder.ctx);
    assert.equal(recorder.registered.length, 1);
    assert.equal(recorder.injected.length, 0);
  });

  it("挂上去的组件能渲染出面板（不是空函数）", () => {
    const recorder = makeSlotRecorder();
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: windowWithFetch });
    module.apply(recorder.ctx);
    const component = recorder.registered[0]?.component;
    assert.equal(typeof component, "function");
    // 挂载函数返回的是 h(ConsoleApp, {})，不是 null。
    const node = component?.();
    assert.notEqual(node, null);
    assert.notEqual(node, undefined);
  });

  it("槽位 register 抛错时记 warn 而不是把 apply 抛出去", () => {
    const warnings: string[] = [];
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: windowWithFetch });
    const ctx: ConsoleHostContext = {
      slots: {
        register: () => {
          throw new Error("槽位冲突");
        },
      },
      logger: { warn: (message) => warnings.push(message) },
    };
    assert.doesNotThrow(() => module.apply(ctx));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /挂载失败/);
  });

  it("require('react') 抛错时记 warn（宿主没 provide react）", () => {
    const warnings: string[] = [];
    const recorder = makeSlotRecorder();
    const module = makeConsoleModule({
      requireModule: () => {
        throw new Error("no react");
      },
      windowOf: windowWithFetch,
    });
    assert.doesNotThrow(() => module.apply({ ...recorder.ctx, logger: { warn: (m) => warnings.push(m) } }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /react/);
  });
});

describe("诊断面 parts", () => {
  it("样式双导出都在且非空（CSS 与 THEME 要一起进产物）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.ok(module.parts.styles.css.length > 1000, "CSS 太短，可能没打进来");
    assert.ok(module.parts.styles.theme.length > 1000, "THEME 太短，可能没打进来");
    assert.match(module.parts.styles.css, /\.rt-/);
    // THEME 是一组 CSS 自定义属性，前缀 --dsu-（见 styles.ts 的 THEME_TOKENS）。
    assert.match(module.parts.styles.theme, /--dsu-/);
  });

  it("tabCount 是 13（12 个业务页签 + agents）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    assert.equal(module.parts.tabCount, 13);
  });

  it("createRuntime 造得出可用运行时", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    const runtime = module.parts.createRuntime(baseWindow());
    assert.equal(typeof runtime.h, "function");
    assert.equal(typeof runtime.ui.get, "function");
  });

  it("renderTab 对任意页签都能渲染（空 props → 空态）", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    const runtime = module.parts.createRuntime(baseWindow());
    for (const tab of ["assets", "env", "sessions", "findings", "chain", "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts", "agents"] as const) {
      const text = renderToText(module.parts.renderTab(runtime, tab)).text;
      assert.ok(text.trim().length > 0, tab + " 渲染为空");
    }
  });
});

describe("makeConsoleApp —— 有状态外壳", () => {
  it("渲染出面板根（rt-dock）与样式子节点", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    const runtime = module.parts.createRuntime(baseWindow());
    const result = renderToText(makeConsoleApp(runtime, fakeApi())());
    // 应用函数本身不渲染：它返回节点树（假 react 的 hook 直接返回值）。
    assert.ok(result.text.length > 0);
    const root = result.elements[0];
    assert.ok(root !== undefined, "没有渲染出根元素");
    assert.match(String(root.props["className"] ?? ""), /rt-dock/);
    // 样式作为子节点挂在面板根里（不是手动 append 到 head）。
    assert.ok(
      result.elements.some((el) => el.type === "style"),
      "面板里没有 <style> 子节点",
    );
  });

  it("面板里有全部 10 个标签栏页签", () => {
    const module = makeConsoleModule({ requireModule: requireOf(), windowOf: () => null });
    const runtime = module.parts.createRuntime(baseWindow());
    const result = renderToText(makeConsoleApp(runtime, fakeApi())());
    for (const label of ["资产测绘", "环境适配", "智能体", "会话隧道", "漏洞战果", "攻击链", "得分目标", "报告", "知识库", "技能库"]) {
      assert.ok(result.text.includes(label), "缺页签：" + label);
    }
  });
});

describe("bootstrap 响应解析（不可信输入）", () => {
  it("名册正常解析", () => {
    const list = engagementsOf({
      ok: true,
      engagements: [{ id: "e1", name: "靶标一" }, { id: "e2" }],
    });
    assert.deepEqual(list.map((item) => item.id), ["e1", "e2"]);
    assert.equal(list[0]?.name, "靶标一");
  });

  it("非数组 → 空名册（不是抛错）", () => {
    assert.deepEqual(engagementsOf({ ok: true, engagements: "nope" }), []);
    assert.deepEqual(engagementsOf({ ok: true }), []);
  });

  it("数组里的脏项被跳过（缺 id / id 为空 / 不是对象）", () => {
    const list = engagementsOf({
      ok: true,
      engagements: [null, 42, { id: "" }, { name: "没有 id" }, { id: "good" }, ["x"]],
    });
    assert.deepEqual(list.map((item) => item.id), ["good"]);
  });

  it("name 不是字符串时省略该字段", () => {
    const list = engagementsOf({ ok: true, engagements: [{ id: "e1", name: 42 }] });
    assert.equal(list.length, 1);
    assert.equal("name" in (list[0] ?? {}), false);
  });

  it("current：正常值透传，空串与非字符串 → null", () => {
    assert.equal(currentOf({ ok: true, current: "e1" }), "e1");
    assert.equal(currentOf({ ok: true, current: "" }), null);
    assert.equal(currentOf({ ok: true, current: 7 }), null);
    assert.equal(currentOf({ ok: true }), null);
  });
});

describe("savedWidthOf —— 读上次拖拽宽度", () => {
  /** 带指定 localStorage 内容的窗口。 */
  function windowWithStored(value: string | null): DshWindow {
    const base = baseWindow();
    return {
      ...base,
      localStorage: {
        getItem: (key: string) => (key === "rt-dock-width" ? value : null),
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    };
  }

  it("读到数字时返回它", () => {
    assert.equal(savedWidthOf(windowWithStored("720")), 720);
  });

  it("没有值时返回 null（由 defaultDockGeometry 兜底）", () => {
    assert.equal(savedWidthOf(windowWithStored(null)), null);
  });

  it("非数字返回 null（localStorage 可被手改）", () => {
    assert.equal(savedWidthOf(windowWithStored("abc")), null);
  });

  it("空串返回 null", () => {
    assert.equal(savedWidthOf(windowWithStored("")), null);
  });

  it("localStorage 抛错时返回 null（隐私模式）", () => {
    const base = baseWindow();
    const hostile = {
      ...base,
      get localStorage(): never {
        throw new Error("拒绝访问");
      },
    } as unknown as DshWindow;
    assert.equal(savedWidthOf(hostile), null);
  });
});
