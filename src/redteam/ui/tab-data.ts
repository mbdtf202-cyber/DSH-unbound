/**
 * 页签数据的容器接线层。
 *
 * ## 这一层存在的理由
 *
 * `tabs-a.ts` 与 `tabs-b.ts` 各自是**无状态工厂**：它们只负责「按 op 取数、
 * 把响应转成 props、把回调接到取数上」。它们不知道 React 的存在，也不知道
 * 当前渲染的是哪个页签 —— 这是刻意的，它让两组都能在 `node:test` 里直接驱动。
 *
 * 但宿主要的是 `TabPropsSlot = () => TabRegistryProps`：一个**在 React 渲染期
 * 被调用**、返回当前页签 props 的函数。于是需要这一层把三者接起来：
 *
 * ```
 * React 渲染 → 本层 → A 组 propsFor(tab) + B 组 propsFor(tab) 合并
 *                        ↑ 订阅变化后触发重渲染
 * ```
 *
 * ## 为什么两组都造、只取当前页签
 *
 * `propsFor(tab)` 是「只装这一个页签」的入口，两组都实现了它。本层按当前
 * 页签只调其中一组，避免每次渲染把 13 个页签的 props 全算一遍 —— 那些
 * props 里含大量格式化（时间、计数、路径），全算是纯浪费。
 *
 * 两边返回的都是**部分** `TabRegistryProps`（各自只有自己负责的页签键），
 * 合并即可。键不重叠（见 `TABS_A_OWNED` / `tabs-b` 的 `OWNED_CLIENT_TABS`），
 * 所以合并安全，不需要后者覆盖前者的语义。
 *
 * ## 交叉注入
 *
 * 有两个 props 是**别人的渲染节点**，只能由容器给：
 *
 * - `assets.renderTesting` ← `renderTestingTab(runtime, props.testing)`
 * - `findings.attackFilesNode` ← `renderAttackFilesTab(runtime, props.attackfiles)`
 *
 * `tab-registry.ts` 已经写好了「`props.testing` 存在才注入」的判断，本层
 * 只需保证同一轮 props 里 `testing` / `attackfiles` 与当前页签同源。
 * 因为两组各自都会返回自己负责的页签键，所以当渲染 `assets` 时，
 * B 组返回的 `testing` 正好可用于注入 —— 但 `propsFor("assets")` 只会返回
 * assets 一个键，拿不到 testing。
 *
 * 处理方式：本层额外向 B 组要一次 `testing` / `attackfiles` 的 props
 * （仅当当前页签是 `assets` / `findings` 时），避免为这一点把两大组全算。
 */

import type { ApiClient } from "../client/api.js";
import type { ConsoleRuntime } from "../client/runtime.js";
import type { ConsoleTabId } from "../client/state.js";
import type { TabRegistryProps } from "../client/tab-registry.js";
import type { TabPropsSlot } from "./console.js";

import { makeTabsA, makeWindowCopy, ownsTab as ownsTabA, type TabsA } from "./tabs-a.js";
import { loadAll as loadAllB, makeTabsBState, propsForWithEngagement, type TabsBState } from "./tabs-b.js";

/** 交叉注入需要的页签：当前页签 → 需要额外取的那一组 props。 */
const CROSS_INJECT: Readonly<Partial<Record<ConsoleTabId, readonly ConsoleTabId[]>>> = Object.freeze({
  // 资产页签要测试子视图
  assets: ["testing"],
  // 漏洞页签要攻击文件子视图
  findings: ["attackfiles"],
});

/** 接线层参数。 */
export interface TabDataWiring {
  /** 当前靶标（`null` = 未选）。取函数而非值：切靶标时本层要能读到最新值。 */
  readonly engagement: () => string | null;
}

/**
 * 造一个可喂给 `ConsoleInit.tabProps` 的 slot。
 *
 * **必须在 React 渲染期调用返回值**（它内部用 `useState` 订阅变化），
 * 这与 `ConsoleInit.tabProps` 的调用位置一致（`console.ts` 的 `ConsoleApp`
 * 里每次渲染调一次）。
 */
export function makeTabPropsSlot(
  runtime: ConsoleRuntime,
  api: ApiClient,
  wiring: TabDataWiring,
): TabPropsSlot {
  const React = runtime.React;

  /* A 组是无状态工厂，造一次即可（它自带 subscribe）。 */
  let tabsA: TabsA | null = null;
  /* B 组的状态工厂，同样只造一次。 */
  let tabsB: TabsBState | null = null;
  /* 上一次取数用的靶标 —— 变了要重取。 */
  let loadedFor: string | null | undefined = undefined;

  return function tabProps(): TabRegistryProps {
    const [, bump] = React.useState(0);
    const current = wiring.engagement();

    if (tabsA === null) {
      tabsA = makeTabsA({
        api,
        engagement: current,
        /* 剪贴板：不传的话 `tabs-a.ts` 的默认值是「一律返回 false」，
           六个页签的复制按钮会全部显示「复制失败（浏览器未授权剪贴板）」。
           那不是 bug（它不谎称成功），但体验差一截。
           `makeWindowCopy` 依次试 clipboard.writeText → textarea+execCommand，
           都给不出真结果时返回 false —— 行为已由 4 条用例钉住。 */
        copyText: makeWindowCopy(runtime.window),
        /* 状态变化 → 触发重渲染。`bump` 是 React 的 setState，
           同值不重渲染，所以这里用一个自增包装。 */
        onChange: () => bump((value) => value + 1),
      });
    }
    const a = tabsA;

    if (tabsB === null) {
      tabsB = makeTabsBState({
        api,
        engagement: wiring.engagement,
        notify: () => bump((value) => value + 1),
      });
    }
    const b = tabsB;

    /* 订阅 A 组状态：它在取数完成后会 notify。B 组用 notify 回调，不必订阅。 */
    React.useEffect(() => {
      return a.subscribe(() => bump((value) => value + 1));
    }, [a]);

    /* 首屏与切靶标取数。
     *
     * **两组都要取。** `makeTabsBState` 只造状态、不取数；漏掉 `loadAllB`
     * 的话 B 组 6 个页签永远停在 `data === null` 的加载态 —— 即使容器
     * 已经把它们接上了。实测对照（假 fetch 喂业务串）：
     *
     *   不调 loadAllB → knowledge/skills/testing/attackfiles/prompts/report 全部 EMPTY
     *   调 loadAllB   → 同样 6 个页签全部渲染出真实内容（节点长度也变大，不是空态换文案）
     *
     * 这条曾经真的漏过，所以注释留在这里当护栏。
     */
    React.useEffect(() => {
      if (loadedFor === undefined) {
        loadedFor = current;
        a.setEngagement(current);
        void a.loadAll();
        loadAllB(b);
        return;
      }
      if (loadedFor !== current) {
        loadedFor = current;
        a.setEngagement(current);
        void a.loadAll();
        loadAllB(b);
      }
    }, [current, a, b]);

    /* 当前页签 —— 从 runtime 的 ui 状态读，与 panel 渲染的同源。 */
    const active: ConsoleTabId = runtime.ui.useUi().tab;

    const own: TabRegistryProps = ownsTabA(active) ? a.propsFor(active) : {};
    const bProps = propsForWithEngagement(runtime, b, current);

    /* 只取当前页签那一个键，而不是把 B 组全部键都摊开 —— 避免无谓计算。 */
    const mine: Record<string, unknown> = { ...own };
    const bKey = active as keyof TabRegistryProps;
    if (!ownsTabA(active) && bProps[bKey] !== undefined) {
      mine[bKey] = bProps[bKey];
    }

    /* 交叉注入：assets 要 testing、findings 要 attackfiles。
       这些键平时不在当前页签的 props 里，需要单独取。 */
    const extra = CROSS_INJECT[active];
    if (extra !== undefined) {
      for (const need of extra) {
        if (bProps[need as keyof TabRegistryProps] !== undefined) {
          mine[need] = bProps[need as keyof TabRegistryProps];
        }
      }
    }

    return mine as TabRegistryProps;
  };
}
