/**
 * 页签分派表：把 `ConsoleTabId` 映射到具体的渲染函数。
 *
 * ## 为什么需要这一层
 *
 * 12 个页签各自是**纯函数**（`renderXxxTab(runtime, props)`）：props 进、回调出、
 * 无 hook、不读全局。这是刻意的——它让每个页签都能在 `node:test` 里直接渲染
 * 断言，不需要 DOM 或 React 运行时。
 *
 * 但「纯函数」也意味着它们不会自己取数据。取数（`loadAssets` / `loadSessions` …）
 * 与状态（`useState`）必须由**有状态的外层**提供。这一层就是这个外层的最小面：
 * 它只做三件事——按 tab id 分派、把注入槽（`attackFilesNode` / `renderShots`）
 * 接好、在缺少必需数据时给出明确的空态而不是白屏。
 *
 * ## 与上游的关系
 *
 * 上游每个 `XxxTab` 都是一个大组件，内部 `useState` + `api(...)` 混在一起。
 * 这里把「取数」推给宿主容器（`panel.ts` 的调用方），分派表只负责排版与
 * 槽位接线。好处是分派表本身零状态、可测；代价是容器要多传几项 props
 * —— 这是有意的取舍：状态集中在容器，页签保持可测。
 *
 * ## 缺数据时的行为
 *
 * 每个页签在 `data === null` 时都会渲染自己的空态（这是各 tab 的契约，
 * 有专门用例覆盖）。分派表不再额外包一层「加载中」，避免两套空态打架。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ConsoleTabId } from "./state.js";

import { renderAssetsTab, type AssetsTabProps } from "./assets-tab.js";
import { renderChainTab, type ChainTabProps } from "./chain-tab.js";
import { renderEnvTab, type EnvTabProps } from "./env-tab.js";
import { renderFindingsTab, type FindingsTabProps } from "./findings-tab.js";
import { renderKnowledgeTab, type KnowledgeTabProps } from "./knowledge-tab.js";
import { renderPromptsTab, type PromptsTabProps } from "./prompts-tab.js";
import { renderReportTab, type ReportTabProps } from "./report-tab.js";
import { renderScoreTab, type ScoreTabProps } from "./score-tab.js";
import { renderSessionTab, type SessionTabProps } from "./session-tab.js";
import { renderSkillsTab, type SkillsTabProps } from "./skills-tab.js";
import { renderTestingTab, type TestingTabProps } from "./testing-tab.js";
import { renderAttackFilesTab, type AttackFilesTabProps } from "./attackfiles-tab.js";

/**
 * 分派表需要的全部 props。
 *
 * 每个字段都可缺失：容器按自己已有的能力传，缺的那一项对应页签会走空态。
 * 这样「面板先能显示」与「数据逐项接齐」可以分两步做，不必等全部就绪。
 */
export interface TabRegistryProps {
  readonly assets?: Omit<AssetsTabProps, "runtime"> | undefined;
  readonly env?: EnvTabProps | undefined;
  readonly sessions?: SessionTabProps | undefined;
  readonly findings?: Omit<FindingsTabProps, "attackFilesNode"> | undefined;
  readonly chain?: ChainTabProps | undefined;
  readonly scores?: ScoreTabProps | undefined;
  readonly report?: ReportTabProps | undefined;
  readonly knowledge?: KnowledgeTabProps | undefined;
  readonly skills?: SkillsTabProps | undefined;
  readonly testing?: TestingTabProps | undefined;
  readonly attackfiles?: AttackFilesTabProps | undefined;
  readonly prompts?: PromptsTabProps | undefined;
}

/** 某个页签没有数据时的统一空态文案。 */
const MISSING: Readonly<Record<string, string>> = Object.freeze({
  assets: "还没有资产数据（先跑信息收集）",
  env: "环境适配数据未加载",
  sessions: "还没有会话或隧道（先拿到入口）",
  findings: "还没有漏洞战果",
  chain: "还没有攻击链步骤",
  scores: "得分目标未加载",
  report: "还没有可生成的报告",
  knowledge: "知识库未加载",
  skills: "技能库未加载",
  testing: "还没有待测资产",
  attackfiles: "还没有保存的攻击文件",
  prompts: "提示词目录未加载",
  agents: "智能体概览未接入",
});

/**
 * 按页签 id 渲染。
 *
 * 分派用 `switch` 而不是查表函数：TS 能在这里做**穷尽性检查**
 * （`default` 分支里若 `tab` 不是 `never` 就编译报错），
 * 以后给 `ConsoleTabId` 加新页签时会强制你在这里补一行，不会静默白屏。
 */
export function renderTabContent(
  runtime: ConsoleRuntime,
  tab: ConsoleTabId,
  props: TabRegistryProps,
): ReactNode {
  const { h } = runtime;

  const empty = (tab: ConsoleTabId): ReactNode =>
    h("div", { className: "rt-empty" }, MISSING[tab] ?? "该页签暂无内容");

  /**
   * 兜底：**任何一个页签渲染抛错，都不能让整个面板白屏**。
   *
   * 为什么这一层必须有：宿主的 React 错误边界在组件抛错时会把整棵子树
   * 换成白屏 —— 用户看到的是「面板没了」，连切到别的页签都做不到，
   * 也不知道发生了什么。而页签渲染是数据形状最不可控的地方：
   * 容器可能把未经模型层解析的原始对象喂进来（宿主新增/改名字段），
   * 某个页签少一个 `undefined` 守卫就会连带整块面板。
   *
   * 降级原则：**保面板、弃本页**。把错误如实显示出来（含消息），
   * 其它页签照常可用，用户能自己切走或去环境适配页修配置。
   */
  try {
    return dispatch(runtime, tab, props, empty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return h("div", { className: "rt-pane" },
      h("div", { className: "rt-err" }, "「" + tab + "」页签渲染失败：" + message),
      h("div", { className: "rt-empty" },
        h("div", null, "面板与其它页签仍可使用。"),
        h("div", { style: { marginTop: 6, fontSize: 11.5 } },
          "常见原因：宿主返回的数据结构与预期不符（新增/改名字段）。"),
        h("div", { style: { marginTop: 6, fontSize: 11.5 } },
          "可先到「环境适配」页确认宿主版本，或刷新重试。")),
    );
  }
}

/**
 * 真正的分派（不含错误兜底）。
 *
 * 单独拆出来是为了让 `renderTabContent` 能在外层套一层保护：
 * 页签渲染是**最后一个可能整页崩掉的地方** —— 它一旦抛错，宿主的 React
 * 错误边界会把整个面板换成白屏，用户连换页签都做不到。
 */
function dispatch(
  runtime: ConsoleRuntime,
  tab: ConsoleTabId,
  props: TabRegistryProps,
  empty: (tab: ConsoleTabId) => ReactNode,
): ReactNode {
  const { h } = runtime;

  switch (tab) {
    case "assets": {
      const p = props.assets;
      if (p === undefined) return empty(tab);
      // 「资产测绘」与「测试状态」在上游是同一个组件（`AssetsTab({view})`）。
      // 这里保留该结构：`view: "testing"` 时由 `renderTesting` 注入子视图，
      // 避免两个页签各自维护一套资产列表与筛选条件。
      return renderAssetsTab(runtime, {
        ...p,
        ...(props.testing !== undefined
          ? { renderTesting: () => renderTestingTab(runtime, props.testing as TestingTabProps) }
          : {}),
      } as AssetsTabProps);
    }
    case "env": {
      const p = props.env;
      return p === undefined ? empty(tab) : renderEnvTab(runtime, p);
    }
    case "sessions": {
      const p = props.sessions;
      return p === undefined ? empty(tab) : renderSessionTab(runtime, p);
    }
    case "findings": {
      const p = props.findings;
      if (p === undefined) return empty(tab);
      // 「攻击文件」是 findings 的子页签：上游把它内嵌在 FindingsTab 里，
      // 这里通过注入槽传节点，而不是让 findings-tab 直接 import 另一个页签
      // （那会形成 tab 之间的循环依赖，且让 findings 的单测被迫拉起 attackfiles）。
      return renderFindingsTab(runtime, {
        ...p,
        ...(props.attackfiles !== undefined
          ? { attackFilesNode: renderAttackFilesTab(runtime, props.attackfiles) }
          : {}),
      } as FindingsTabProps);
    }
    case "chain": {
      const p = props.chain;
      return p === undefined ? empty(tab) : renderChainTab(runtime, p);
    }
    case "scores": {
      const p = props.scores;
      return p === undefined ? empty(tab) : renderScoreTab(runtime, p);
    }
    case "report": {
      const p = props.report;
      return p === undefined ? empty(tab) : renderReportTab(runtime, p);
    }
    case "knowledge": {
      const p = props.knowledge;
      return p === undefined ? empty(tab) : renderKnowledgeTab(runtime, p);
    }
    case "skills": {
      const p = props.skills;
      return p === undefined ? empty(tab) : renderSkillsTab(runtime, p);
    }
    case "testing": {
      const p = props.testing;
      return p === undefined ? empty(tab) : renderTestingTab(runtime, p);
    }
    case "attackfiles": {
      const p = props.attackfiles;
      return p === undefined ? empty(tab) : renderAttackFilesTab(runtime, p);
    }
    case "prompts": {
      const p = props.prompts;
      return p === undefined ? empty(tab) : renderPromptsTab(runtime, p);
    }
    case "agents": {
      // 智能体概览属于插件生命周期层（`src/plugin/`），不在客户端渲染。
      return empty(tab);
    }
    default: {
      // 穷尽性检查：若 `ConsoleTabId` 新增了值而这里没补分支，
      // 下面这行会让 `tab` 不是 `never` 而**编译失败**。
      const exhaustive: never = tab;
      return h("div", { className: "rt-empty" }, "未知页签：" + String(exhaustive));
    }
  }
}

/**
 * 造一个可直接传给 `renderPanel` 的 `renderTab` 函数。
 *
 * 用法：
 * ```ts
 * renderPanel(runtime, { ..., renderTab: makeRenderTab(runtime, { skills: {...} }) }, opts)
 * ```
 */
export function makeRenderTab(
  runtime: ConsoleRuntime,
  props: TabRegistryProps,
): (tab: ConsoleTabId) => ReactNode {
  return (tab: ConsoleTabId) => renderTabContent(runtime, tab, props);
}
