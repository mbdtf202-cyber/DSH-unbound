/**
 * 控制台容器的**运行时入口**：把 `client/` 的纯函数页签接到宿主插件契约上。
 *
 * ## 这一层解决什么
 *
 * `client/` 里 12 个页签是纯函数（`renderXxxTab(runtime, props)`），
 * `panel.ts` 是纯外壳，`tab-registry.ts` 是纯分派 —— 三者都**不接触宿主**。
 * 而这个文件是唯一知道「宿主长什么样」的地方：
 *
 * - 宿主的模块契约是 `factory(require)` 返回 `{ name, inject, apply }`；
 * - 宿主的 UI 契约是 `ctx.slots.register(slot, component)`；
 * - 宿主的 `require("react")` 由它 provide。
 *
 * ## 为什么它不进 `client/`
 *
 * `client/**` 的每一行都必须能在 `node:test` 里直接跑（那是 3,600+ 用例的基础）。
 * 一旦某个模块开始读全局 `window`、调 `ctx.slots`，它就不再是纯函数，
 * 也没法脱离宿主测试。所以「宿主耦合」集中在**这一个文件**里，且它自己
 * 也用注入（`windowOf` / `requireModule`）避免直接摸全局 —— 于是它同样可测。
 *
 * ## 数据加载的现状（如实记录）
 *
 * 本容器做四件事：**挂槽位、拉靶标名册（`bootstrap`）、分派页签、挂样式**。
 * 逐页签的业务数据（资产/漏洞/攻击链…）**尚未接线** —— 每个页签拿到空 props，
 * 会走自己设计好的空态（"还没有资产数据（先跑信息收集）"等）。
 *
 * 这不是省事：`tab-registry.ts` 的 props 设计就是**每项可缺失**，注释里写明
 * 「面板先能显示」与「数据逐项接齐」分两步做。容器只传它真有的东西，
 * 页签自己降级 —— 不存在「半截数据」这种会撒谎的中间态。
 * 接数据的扩展点是 `TabPropsSlot`（见下）。
 */

import type { DshWindow, FetchLike, ModuleRequire, ReactNode } from "../client/dom.js";
import type { ConsoleRuntime } from "../client/runtime.js";
import { createRuntime, isConsoleTabId, readStorage, STORAGE_KEYS } from "../client/runtime.js";
import type { ConsoleTabId, DockGeometry } from "../client/state.js";
import { makeApiClient } from "../client/api.js";
import type { ApiClient, ApiResponse } from "../client/api.js";
import { initialGeometry, renderPanel } from "../client/panel.js";
import { isFullWindow } from "../client/entry.js";
import { makeRenderTab, renderTabContent, type TabRegistryProps } from "../client/tab-registry.js";
import { CSS as CONSOLE_CSS, THEME as CONSOLE_THEME } from "../client/styles.js";
import { makeTabPropsSlot } from "./tab-data.js";

/** 模块 id：宿主的 `__ModuleLoader__` 用它做注册键，也是 `package.json` 的包名。 */
export const MODULE_NAME = "dsh-unbound";

/** 面板挂的槽位（与上游一致）。 */
export const SLOT_NAME = "shell.overlay";

/** 槽位内唯一标识（同一槽位可能挂多个面板）。 */
export const SLOT_ID = "dsh-unbound-console";

/** 槽位排序（上游用 50；保持同值，避免与其它插件的相对顺序变化）。 */
export const SLOT_ORDER = 50;

/**
 * 向宿主声明的依赖服务。
 *
 * 与上游一致只要 `slots`（挂面板）与 `locale`（宿主会在 apply 前等它们就绪）。
 * **不要**把 `pluginPackages` 之类写进来：Cordis 会对每个声明的 key 空等，
 * 等不到就 pending，最终宿主退出码 1（上游注释记过这个坑）。
 */
export const INJECT: readonly string[] = Object.freeze(["slots", "locale"]);

/** `ctx.slots` 的两个方法。`inject` 是「等该槽位就绪后再注册」的宿主约定。 */
export interface SlotFace {
  register?(
    slot: { readonly name: string; readonly id: string; readonly order: number },
    component: () => ReactNode,
  ): void;
  inject?(name: string, register: () => void): void;
}

/** 宿主 `ctx` 里本容器实际读取的部分（不是完整 HostContext 镜像）。 */
export interface ConsoleHostContext {
  /** UI 插槽服务。缺它就不挂载。 */
  readonly slots?: SlotFace | undefined;
  /** 宿主 logger（可选，只用来报「为什么没挂上」）。 */
  readonly logger?: { warn?(message: string): void } | undefined;
}

/** 靶标名册的一项（`bootstrap` 的 `engagements` 元素）。 */
export interface EngagementOption {
  readonly id: string;
  readonly name?: string | undefined;
}

/**
 * 逐页签业务 props 的来源（**接数据的扩展点**）。
 *
 * 容器每次渲染都问它要一次；返回 `{}` 就等于「全部页签走空态」（v1 默认）。
 * 将来接数据只需实现一个 `TabPropsSlot` 并传进 `ConsoleInit.tabProps`，
 * **不必改本文件、也不必让 `client/` 知道宿主**。
 */
export type TabPropsSlot = (() => TabRegistryProps) & {
  /**
   * 数据层就绪钩子（可选）。
   *
   * 只由 `makeConsoleModule` 的自动接线实现提供 —— 它要在 `apply(ctx)` 拿到
   * `window` 之后才能造 A/B 两组。调用方自己传的 `tabProps` 不会有这个属性，
   * 所以是可选的，`apply` 用 `?.` 调。
   *
   * 不用 `readonly` 之外的花样：它是一个普通属性赋值，不是方法，
   * 这样 `lazySlot` 里可以直接挂上去。
   */
  ready?: (windowRef: DshWindow) => void;
};

/** 初始化参数：全部注入，绝不直接摸全局。 */
export interface ConsoleInit {
  /** 宿主的 `require`（只认 `"react"`）。 */
  readonly requireModule: ModuleRequire;
  /** 取全局 `window`；非浏览器环境返回 `null`（此时 apply 只记一条警告）。 */
  readonly windowOf: () => DshWindow | null;
  /** 业务数据来源；省略 = 所有页签走空态。 */
  readonly tabProps?: TabPropsSlot | undefined;
}

/**
 * 诊断面（宿主不读，测试与排障用）。
 *
 * 宿主契约只认 `name` / `inject` / `apply`；这个字段是给「产物到底有没有把
 * 37 个模块都打进来」「样式在不在」「页签还能不能渲染」这类问题一个
 * **可断言**的入口。
 *
 * `renderTab` 存在的理由：端到端用例要从**产物**里渲染页签（而不是从
 * 源码 import），否则「打包过程拍平了循环依赖 / 漏了 shared/result」
 * 这类问题测不出来 —— 而那正是打包最可能引入的故障。
 */
export interface ConsoleParts {
  readonly styles: { readonly css: string; readonly theme: string };
  /** 造运行时的工厂（不预设 window：由调用方给）。 */
  readonly createRuntime: (windowRef: ConsoleRuntime["window"]) => ConsoleRuntime;
  /** 按页签 id 渲染（走产物里的 `tab-registry`，空 props → 各页签空态）。 */
  readonly renderTab: (runtime: ConsoleRuntime, tab: ConsoleTabId) => ReactNode;
  /** 产物里的页签数（证明 `tab-registry` 整张分派表打进来了）。 */
  readonly tabCount: number;
}

/** 宿主读的三个导出（外加诊断用的 `parts`）。 */
export interface ConsoleModule {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: ConsoleHostContext | null | undefined) => void;
  readonly parts: ConsoleParts;
}

/** 从运行时窗口里取 `fetch`（`MinimalWindow` 没有它，只有 `DshWindow` 有）。 */
function fetchOf(windowRef: unknown): FetchLike | null {
  if (windowRef === null || typeof windowRef !== "object") return null;
  const candidate = (windowRef as { readonly fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as FetchLike) : null;
}

/** 读上次拖拽保存的面板宽度（读不到 → `null`，由 `defaultDockGeometry` 兜底）。 */
export function savedWidthOf(windowRef: ConsoleRuntime["window"]): number | null {
  const raw = readStorage(windowRef, STORAGE_KEYS.width);
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 从 `bootstrap` 响应里读名册（不可信输入，逐项窄化）。 */
export function engagementsOf(response: ApiResponse): readonly EngagementOption[] {
  const raw = response["engagements"];
  if (!Array.isArray(raw)) return [];
  const out: EngagementOption[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string" || id === "") continue;
    const displayName = record["name"];
    out.push(typeof displayName === "string" ? { id, name: displayName } : { id });
  }
  return out;
}

/** 从 `bootstrap` 响应里读当前靶标（不可信输入）。 */
export function currentOf(response: ApiResponse): string | null {
  const current = response["current"];
  return typeof current === "string" && current !== "" ? current : null;
}

/**
 * 造面板组件（**函数组件**，宿主用 `h(component, props)` 渲染）。
 *
 * 内部只用 `runtime.React` 的 hook —— 于是测试里换成假 react 就能直接调用，
 * 不需要 React 运行时。
 */
export function makeConsoleApp(
  runtime: ConsoleRuntime,
  api: ApiClient,
  tabPropsSlot: TabPropsSlot = () => ({}),
): () => ReactNode {
  const React = runtime.React;

  return function ConsoleApp(): ReactNode {
    const ui = runtime.ui.useUi();
    const [engagements, setEngagements] = React.useState<readonly EngagementOption[]>([]);
    const [engagement, setEngagement] = React.useState<string | null>(null);

    /**
     * `bootstrap`：名册 + 当前靶标。
     *
     * 失败**不抛也不清空界面** —— 宿主重启期间面板要能继续显示（用自己的空态），
     * 而不是因为一次失败变成白屏。这与 `api.ts` 的「永不 reject」契约配套。
     */
    React.useEffect(() => {
      let alive = true;
      void api.raw({ op: "bootstrap" }).then((response) => {
        if (!alive || response.ok === false) return;
        setEngagements(engagementsOf(response));
        setEngagement(currentOf(response));
      }, () => undefined);
      return () => {
        alive = false;
      };
    }, []);

    const renderTab = makeRenderTab(runtime, tabPropsSlot());
    const geometry: DockGeometry = initialGeometry(runtime.window, savedWidthOf(runtime.window));
    return renderPanel(runtime, {
      engagement,
      engagements,
      renderTab,
      stats: {},
      onTabChange: (tab: ConsoleTabId): void => {
        runtime.ui.set({ tab });
      },
      onEngagementChange: (id: string): void => {
        const next = id === "" ? null : id;
        setEngagement(next);
        // 服务端持久化「当前靶标」；失败静默（面板已在本地下切换了）。
        if (next !== null) {
          void api.raw({ op: "activateEngagement", engagement: next }).then(() => undefined, () => undefined);
        }
      },
      onRefresh: (): void => {
        void api.raw({ op: "bootstrap" }).then((response) => {
          if (response.ok === false) return;
          setEngagements(engagementsOf(response));
          setEngagement(currentOf(response));
        }, () => undefined);
      },
    }, {
      uiOpen: ui.open,
      activeTab: ui.tab,
      geometry,
      full: isFullWindow(runtime),
    });
  };
}

/** 全部页签 id（从 `state.ts` 的枚举里数出来的固定清单，用于诊断）。 */
const ALL_TAB_IDS: readonly ConsoleTabId[] = Object.freeze([
  "assets", "env", "agents", "sessions", "findings", "chain",
  "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
]);

/**
 * 造完整的宿主模块对象。
 *
 * `apply(ctx)` 的每一步失败都有**可读日志**而不是静默返回：
 * 「面板没出现」是最难排查的一类问题，宿主日志是唯一线索。
 */
/**
 * 惰性数据接线槽。
 *
 * ## 为什么必须惰性
 *
 * 自动接线要用 `window.fetch`，而 `window` 只有 `apply(ctx)` 里才拿得到
 * （模块加载时还在宿主的外壳里，没有 window）。所以不能在造模块时就接线。
 *
 * ## 怎么就绪
 *
 * `apply` 成功后调 `ready(window)` 把运行时与 api 存下来；`ConsoleApp` 首次
 * 渲染时 `slot()` 被调用，这才真的去造 A/B 两组。在此之前一律返回 `{}`，
 * 即「所有页签走空态」——与旧行为一致，不会白屏。
 *
 * ## 为什么用 `engagement` 取函数而不是值
 *
 * 靶标是 React state，切换后本层要能读到新值。闭包捕获的是取值函数，
 * 每次渲染都读最新 —— 若捕获值，切靶标后数据不会刷新（踩过）。
 */
function lazySlot(init: ConsoleInit): TabPropsSlot {
  const explicit = init.tabProps;
  if (explicit !== undefined) return explicit;

  let slot: TabPropsSlot | null = null;

  /* 给 `apply` 调：把能用的 window 存下来。 */
  const ready = (windowRef: DshWindow): void => {
    if (slot !== null) return;
    /* 与 `apply()` 内那处 `createRuntime` 同策略：拿不到 `react`（宿主没
       provide、或 require 自己抛）就**不接线** —— 页签走空态，绝不抛。
       一个插件不该因为宿主缺服务就把整个界面拖崩。
       这里曾有回归：`apply` 自己包了 try/catch，但 `ready` 是它内部
       另外调的一次、独立又建了一个 runtime，那一次没保护。 */
    let runtime: ConsoleRuntime;
    try {
      runtime = createRuntime(init.requireModule, windowRef);
    } catch {
      return;
    }
    const fetchFn = (windowRef as { readonly fetch?: unknown }).fetch;
    if (typeof fetchFn !== "function") return;
    const api = makeApiClient({ fetch: fetchFn as FetchLike });
    const readEngagement = (): string | null => {
      /* 与面板显示同源：`entry.ts` 把它存在 localStorage 的 `engagement` 键下。 */
      const raw = windowRef.localStorage?.getItem("dsh-unbound.engagement");
      return typeof raw === "string" && raw !== "" ? raw : null;
    };
    slot = makeTabPropsSlot(runtime, api, { engagement: readEngagement });
  };

  const fn = ((): TabRegistryProps => (slot === null ? {} : slot())) as TabPropsSlot & {
    readonly ready?: (windowRef: DshWindow) => void;
  };
  /* 内部通道：只有本文件用，不对外暴露成 API。 */
  (fn as unknown as { ready: (w: DshWindow) => void }).ready = ready;
  return fn;
}

/**
 * 造完整的宿主模块对象。
 *
 * `apply(ctx)` 的每一步失败都有**可读日志**而不是静默返回：
 * 「面板没出现」是最难排查的一类问题，宿主日志是唯一线索。
 */
export function makeConsoleModule(init: ConsoleInit): ConsoleModule {
  /**
   * 数据接线槽。
   *
   * 调用方给了 `tabProps` 就用它（测试与定制场景）；没给就**自动接线**，
   * 让 13 个页签真的去 `POST /redteam/api` 取数据。
   *
   * 自动接线必须发生在 **apply 之后**（那时才有 `window.fetch`），
   * 所以这里用惰性求值：先记下 `init`，等 `ConsoleApp` 首次渲染时再造。
   * 在此之前返回空 props —— 与「省略 = 全走空态」的旧行为一致，
   * 差别只在于首帧之后会换成真数据。
   */
  const dataSlot = lazySlot(init);

  const parts: ConsoleParts = {
    styles: { css: CONSOLE_CSS, theme: CONSOLE_THEME },
    createRuntime: (windowRef) => createRuntime(init.requireModule, windowRef),
    renderTab: (runtime, tab) => renderTabContent(runtime, tab, dataSlot()),
    tabCount: ALL_TAB_IDS.filter((tab) => isConsoleTabId(tab)).length,
  };

  return {
    name: MODULE_NAME,
    inject: INJECT,
    parts,
    apply(ctx: ConsoleHostContext | null | undefined): void {
      const warn = (message: string): void => {
        try {
          ctx?.logger?.warn?.(message);
        } catch {
          /* logger 本身炸了也不能影响挂载 */
        }
      };

      const windowRef = init.windowOf();
      if (windowRef === null) {
        warn("[dsh-unbound] 控制台未挂载：当前环境没有 window");
        return;
      }
      const fetchFn = fetchOf(windowRef);
      if (fetchFn === null) {
        warn("[dsh-unbound] 控制台未挂载：当前 window 没有 fetch");
        return;
      }
      const slots = ctx?.slots;
      if (slots === undefined) {
        warn("[dsh-unbound] 控制台未挂载：宿主没有 slots 服务");
        return;
      }

      /* 数据槽就绪：此刻 `window` 与 `fetch` 都验证过了，是接线的最早安全点。
         放在 `slots` 检查之后 —— 挂不上槽位时连数据层都不必造。 */
      dataSlot.ready?.(windowRef);

      // 造运行时可能抛（宿主 require('react') 失败）—— 捕获后报可读日志，
      // 不让一个插件把宿主整体拖崩。
      let runtime: ConsoleRuntime;
      try {
        runtime = createRuntime(init.requireModule, windowRef);
      } catch (error) {
        warn("[dsh-unbound] 控制台未挂载：require('react') 失败（"
          + (error instanceof Error ? error.message : String(error)) + "）");
        return;
      }

      const ConsoleApp = makeConsoleApp(runtime, makeApiClient({ fetch: fetchFn }), dataSlot);
      const mount = (): ReactNode => runtime.h(ConsoleApp, {});

      const slot = { name: SLOT_NAME, id: SLOT_ID, order: SLOT_ORDER } as const;
      const register = (): void => {
        try {
          slots.register?.(slot, mount);
        } catch (error) {
          warn("[dsh-unbound] 控制台挂载失败：" + (error instanceof Error ? error.message : String(error)));
        }
      };

      // `inject` 是宿主约定：等该槽位可用后再注册（上游同样用法）。
      try {
        if (typeof slots.inject === "function") slots.inject(SLOT_NAME, register);
        else register();
      } catch (error) {
        warn("[dsh-unbound] 槽位注册失败：" + (error instanceof Error ? error.message : String(error)));
      }
    },
  };
}
