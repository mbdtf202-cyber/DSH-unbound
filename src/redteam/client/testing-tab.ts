/**
 * 当前测试页（`testing` 页签）的渲染。
 *
 * 数据与轮询守卫全在 `testing-model.ts`，这里只排版。
 *
 * ## 三个区块
 *
 * ```
 * ┌────────────────────────────────────────────────────────────┐
 * │ 测试中 2  待测 8  已测 5  放弃 1  无攻击面 0  更新于 12:34:56│
 * │                       [全部展开] [全部收起] [实时·5s] [刷新] │
 * ├────────────────────────────────────────────────────────────┤
 * │ ▾ 正在测 · 2 台    agent 正在打这些资产                      │
 * │   ● 10.0.0.5 [测试中]                    [测试记录] 复制 展开│
 * ├────────────────────────────────────────────────────────────┤
 * │ ▸ 最近动过 · 5 台  已测过的资产                              │
 * │ ▸ 待测队列 · 8 台  按易打性与端口数排出先打哪几台            │
 * └────────────────────────────────────────────────────────────┘
 *
 * ## 一个原实现的现象，这里保留
 *
 * 「正在测」区块的注释写着「永远常显、不参与折叠」，但**代码**是
 * `open: collapse.isOpen('testing:' + eng, true)` —— 它确实可折叠，
 * 「全部收起」也会把它一起收起。这里按代码行为迁（用户看到的是代码）。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { CollapseState } from "./state.js";
import { clickable, formatTimestamp } from "./helpers.js";
import {
  AUTO_TITLE,
  COLLAPSE_ALL_TITLE,
  EMPTY_QUEUE_TEXT,
  EMPTY_RECENT_TEXT,
  EMPTY_TESTING_TEXT,
  EXPAND_ALL_TITLE,
  LOADING_TEXT,
  NO_ENGAGEMENT_TEXT,
  QUEUE_HINT,
  SECTION_DEFAULTS,
  assetChips,
  autoLabel,
  collapseKey,
  conclusionItems,
  noteLines,
  potentialLine,
  statusClass,
  statusLabel,
  surfaceLine,
  testingSubtitle,
  updatedAtText,
  updatedText,
  type ActiveTestsData,
  type TestedAsset,
} from "./testing-model.js";

/** 当前测试页的 props。 */
export interface TestingTabProps {
  readonly engagement: string | null;
  /** 数据（`null` = 还没加载）。 */
  readonly data: ActiveTestsData | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 上次成功刷新的时刻（`null` = 还没成功过）。 */
  readonly updatedAt: Date | null;
  /** 是否自动刷新。 */
  readonly auto: boolean;
  /** 三个区块的折叠状态。 */
  readonly collapsed: CollapseState;
  readonly onRefresh: () => void;
  readonly onToggleAuto: () => void;
  readonly onToggleSection: (key: string) => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
  /** 测试记录长文本是否展开（按资产 id）。 */
  readonly openNotes: readonly number[];
  readonly onToggleNotes: (assetId: number) => void;
  readonly onCopy: (text: string) => void;
}

/** 取区块展开态。 */
function isOpen(collapsed: CollapseState, key: string, fallback: boolean): boolean {
  const stored = collapsed[key];
  return stored === undefined ? fallback : stored === true;
}

/** 测试记录折叠（原 `Clip` 的最小面；展开态由 props 承载）。 */
function clip(runtime: ConsoleRuntime, props: TestingTabProps, asset: TestedAsset, text: string): ReactNode {
  const { h } = runtime;
  if (text.trim() === "") return null;
  const open = props.openNotes.includes(asset.id);
  return h("div", { className: "rt-clip" + (open ? " open" : "") },
    h("div", { className: "rt-clip-head" },
      h("span", { className: "rt-clip-label" }, "测试记录"),
      h("div", { className: "rt-spacer" }),
      h("button", {
        className: "rt-btn",
        style: { padding: "0 6px", fontSize: 11 },
        onClick: (event) => {
          event.stopPropagation?.();
          props.onCopy(text);
        },
      }, "复制"),
      h("button", {
        className: "rt-btn",
        style: { padding: "0 6px", fontSize: 11 },
        onClick: (event) => {
          event.stopPropagation?.();
          props.onToggleNotes(asset.id);
        },
      }, open ? "收起" : "展开"),
    ),
    h("div", { className: "rt-clip-body" }, text),
  );
}

/** 一台资产一张卡：一眼看清「打的是谁、打到哪、拿到什么」。 */
function assetCard(runtime: ConsoleRuntime, props: TestingTabProps, asset: TestedAsset, past: boolean): ReactNode {
  const { h } = runtime;
  const chips = assetChips(asset);
  const notes = noteLines(asset);
  const surface = surfaceLine(asset);
  const potential = potentialLine(asset);

  return h("div", { key: "at" + asset.id, className: "rt-atest" + (past ? " past" : "") },
    h("div", { className: "rt-atest-head" },
      // 正在测的卡片带绿色呼吸点；历史卡片不带（不动的资产不该有「活的」指示）。
      past ? null : h("span", { className: "rt-live-dot" }),
      h("span", { className: "rt-atest-ip" }, asset.ip),
      h("span", { className: statusClass(asset) }, statusLabel(asset)),
      h("div", { className: "rt-spacer" }),
      h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } },
        updatedText(asset, formatTimestamp(asset.testUpdatedAt))),
    ),
    chips.length > 0
      ? h("div", null, chips.map((chip) => h("span", {
          key: chip.key,
          className: chip.className,
          ...(chip.title !== undefined ? { title: chip.title } : {}),
        }, chip.label)))
      : null,
    surface !== null ? h("div", { className: "rt-atest-meta" }, surface) : null,
    potential !== null ? h("div", { className: "rt-atest-meta" }, potential) : null,
    notes.length > 0 ? clip(runtime, props, asset, notes.join("\n")) : null,
  );
}

/** 一个区块（统一折叠头）。 */
function section(
  runtime: ConsoleRuntime,
  props: TestingTabProps,
  key: string,
  tone: string,
  title: string,
  count: string,
  sub: string,
  fallbackOpen: boolean,
  children: ReactNode,
): ReactNode {
  const { h } = runtime;
  const open = isOpen(props.collapsed, key, fallbackOpen);
  return h("div", { className: "rt-sec-wrap" },
    h("div", {
      className: "rt-sec t-" + tone,
      ...clickable(() => props.onToggleSection(key), { label: title, expanded: open }),
    },
      h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
      h("span", { className: "rt-sec-title" }, title),
      h("span", { className: "rt-sec-count" }, count),
      h("span", { className: "rt-sec-sub" }, sub),
    ),
    open ? h("div", { className: "rt-sec-body" }, children) : null,
  );
}

/**
 * 渲染当前测试页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderTestingTab(runtime: ConsoleRuntime, props: TestingTabProps): ReactNode {
  const { h } = runtime;

  if (props.engagement === null || props.engagement === "") {
    return h("div", { className: "rt-main" },
      h("div", { className: "rt-empty" }, NO_ENGAGEMENT_TEXT),
    );
  }

  const engagement = props.engagement;
  const data = props.data;
  const testing = data?.testing ?? [];
  const recent = data?.recent ?? [];
  const queue = data?.queue ?? [];
  const stats = data?.stats ?? { testing: 0, untested: 0, tested: 0, abandoned: 0, blocked: 0, noSurface: 0 };
  const items = conclusionItems(stats);
  const at = updatedAtText(props.updatedAt);

  const conclusion = h("div", { className: "rt-concl" },
    items.map((item) => h("span", {
      key: item.key,
      className: "rt-concl-i",
      style: { cursor: "default" },
    },
      h("b", null, String(item.value)),
      h("span", null, item.label),
    )),
    h("div", { className: "rt-spacer" }),
    at !== null
      ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, at)
      : null,
    h("button", {
      className: "rt-btn",
      style: { padding: "0 7px", fontSize: 11 },
      title: EXPAND_ALL_TITLE,
      onClick: () => props.onExpandAll(),
    }, "全部展开"),
    h("button", {
      className: "rt-btn",
      style: { padding: "0 7px", fontSize: 11 },
      title: COLLAPSE_ALL_TITLE,
      onClick: () => props.onCollapseAll(),
    }, "全部收起"),
    h("button", {
      className: "rt-btn" + (props.auto ? " rt-btn-primary" : ""),
      style: { padding: "0 7px", fontSize: 11 },
      title: AUTO_TITLE,
      onClick: () => props.onToggleAuto(),
    }, autoLabel(props.auto)),
    h("button", {
      className: "rt-btn",
      style: { padding: "0 7px", fontSize: 11 },
      onClick: () => props.onRefresh(),
    }, "刷新"),
  );

  const body: ReactNode[] = [
    section(
      runtime,
      props,
      collapseKey("testing", engagement),
      "test",
      "正在测",
      testing.length + " 台",
      testingSubtitle(testing.length),
      SECTION_DEFAULTS.testing,
      testing.length > 0
        ? testing.map((asset) => assetCard(runtime, props, asset, false))
        : h("div", { className: "rt-atest-meta", style: { paddingBottom: 4 } }, EMPTY_TESTING_TEXT),
    ),
    section(
      runtime,
      props,
      collapseKey("recent", engagement),
      "past",
      "最近动过",
      recent.length + " 台",
      "已测过的资产",
      SECTION_DEFAULTS.recent,
      recent.length > 0
        ? recent.map((asset) => assetCard(runtime, props, asset, true))
        : h("div", { className: "rt-atest-meta" }, EMPTY_RECENT_TEXT),
    ),
    section(
      runtime,
      props,
      collapseKey("queue", engagement),
      "queue",
      "待测队列",
      (data !== null ? data.untested : 0) + " 台",
      "按易打性与端口数排出先打哪几台",
      SECTION_DEFAULTS.queue,
      queue.length > 0
        ? [
            ...queue.map((asset) => assetCard(runtime, props, asset, true)),
            h("div", { key: "queueHint", className: "rt-atest-meta", style: { paddingTop: 4 } }, QUEUE_HINT),
          ]
        : h("div", { className: "rt-atest-meta" }, EMPTY_QUEUE_TEXT),
    ),
  ];

  return h("div", { className: "rt-main" },
    conclusion,
    props.error !== null ? h("div", { className: "rt-err" }, props.error) : null,
    data === null && props.error === null ? h("div", { className: "rt-empty" }, LOADING_TEXT) : null,
    h("div", { className: "rt-body", style: { overflow: "auto" } },
      h("div", { style: { padding: "6px 12px 14px" } }, body),
    ),
  );
}

/** 默认 props（供测试与未接线场景）。 */
export function defaultTestingProps(engagement: string | null): TestingTabProps {
  return {
    engagement,
    data: null,
    error: null,
    updatedAt: null,
    auto: true,
    collapsed: {},
    onRefresh: () => undefined,
    onToggleAuto: () => undefined,
    onToggleSection: () => undefined,
    onExpandAll: () => undefined,
    onCollapseAll: () => undefined,
    openNotes: [],
    onToggleNotes: () => undefined,
    onCopy: () => undefined,
  };
}
