/**
 * 资产测绘页（`assets` 页签）的渲染。
 *
 * 数据与过滤全在 `assets-model.ts`，这里只排版。
 *
 * ## 布局（原实现是左右分栏）
 *
 * ```
 * ┌──────────┬───────────────────────────────────────────┐
 * │ 全部 C 段 │ 搜索 / 服务 / 端口 / 内外网 / 来源 / 易打性  │
 * │ 当前测试  │ 测试状态 / 刷新 / 列表·发现时间·域名·Web    │
 * │ 外网资产▾ │ 结论行：台账资产 存活 待测 测试中 已测 放弃   │
 * │  10.0.0/24│ ─────────────────────────────────────────  │
 * │ 内网资产▾ │ 表头 / 资产行（点开是详情）                  │
 * └──────────┴───────────────────────────────────────────┘
 * ```
 *
 * ## 两个原实现细节，这里保留
 *
 * 1. **测试视图隐藏工具栏**（`view === 'testing' ? null : toolbar`），但
 *    结论行仍然渲染 —— 内嵌的测试页自己带一条自己的结论行，两条并存是
 *    原样（外层那条是「家底分布」，内层那条是「当前测试进度」）。
 * 2. **`q` 与 `qApplied` 是两个值**：输入框自由输入，回车或点「搜索」才生效。
 *    渲染层因此需要 `searchDraft` 单独进 props。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { CollapseState } from "./state.js";
import type { MinimalPointerEventLike } from "./h.js";
import { clickable, formatTimestamp, formatTimestampShort } from "./helpers.js";
import { priorityLabel, testStatusLabel } from "./label.js";
import {
  DEFAULT_ASSET_FILTER,
  DISCOVERY_NOTE,
  MAX_OBSERVATIONS,
  NO_ENGAGEMENT_TEXT,
  PRIORITY_OPTIONS,
  PROVENANCE_OPTIONS,
  SCOPE_OPTIONS,
  SORT_OPTIONS,
  TEST_STATUS_OPTIONS,
  VIEW_BUTTONS,
  applyConclusion,
  assessLongText,
  conclusionItems,
  conclusionStatsOf,
  detailFor,
  discoverySpanText,
  domainEmptyText,
  filterDiscoveryByDay,
  fingerprintDetailText,
  fingerprintSummary,
  groupSegments,
  listEmptyText,
  namesText,
  noteLinesOf,
  observationText,
  openPortsOf,
  portServiceText,
  portSummary,
  provenanceText,
  scopeLongLabel,
  scopeShortLabel,
  segmentTitle,
  segmentsOf,
  sideGroupKey,
  surfaceText,
  testMetaText,
  totalAssetsOf,
  webAssetUrl,
  webEmptyText,
  webServiceText,
  type AssetFilter,
  type AssetItem,
  type AssetListState,
  type AssetScope,
  type AssetSegment,
  type AssetViewKind,
  type ConclusionKey,
  type DiscoveryData,
  type DomainGroup,
  type WebAsset,
} from "./assets-model.js";

/** C 段折叠的默认展开态（外网/内网两组默认都展开）。 */
const SIDE_GROUP_DEFAULT_OPEN = true;

/** 资产页的 props。 */
export interface AssetsTabProps {
  /** 当前靶标（`null` = 还没选，渲染空态而不是空白）。 */
  readonly engagement: string | null;
  /** 快照响应（`segments` / `stats` / `tests` 的来源）。 */
  readonly snapshot: unknown;
  /** 已生效的过滤条件。 */
  readonly filter: AssetFilter;
  /** 搜索框里的**草稿**值（回车/点搜索才进 `filter.query`）。 */
  readonly searchDraft: string;
  /** 当前视图。 */
  readonly view: AssetViewKind;
  /** 列表数据（`null` = 还没加载）。 */
  readonly list: AssetListState | null;
  /** 域名维度（`null` = 加载中）。 */
  readonly domains: readonly DomainGroup[] | null;
  /** Web 维度（`null` = 加载中）。 */
  readonly web: readonly WebAsset[] | null;
  /** 单台资产详情（`null` = 加载中或读取失败）。 */
  readonly detail: AssetItem | null;
  /** 当前展开的资产 id。 */
  readonly openId: number | null;
  /** 「展开全部」的资产 id。 */
  readonly showAllId: number | null;
  /** 测试记录长文本是否展开（原 `Clip` 的 `open`）。 */
  readonly notesOpen: boolean;
  /** 侧栏 C 段分组的折叠状态。 */
  readonly collapsed: CollapseState;
  /** 发现时间线数据（`null` = 加载中）。 */
  readonly discovery: DiscoveryData | null;
  /** 发现时间线错误。 */
  readonly discoveryError: string | null;
  /** 发现时间线按天筛选（空串 = 不筛）。 */
  readonly discoveryDay: string;
  /** 「当前测试」视图的内容（由外层注入 `TestingTab`）。 */
  readonly renderTesting?: (() => ReactNode) | undefined;
  readonly onFilterChange: (filter: AssetFilter) => void;
  readonly onSearchDraftChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onViewChange: (view: AssetViewKind) => void;
  readonly onToggleRow: (id: number) => void;
  readonly onToggleShowAll: (id: number | null) => void;
  readonly onToggleNotes: () => void;
  readonly onToggleSideGroup: (scope: AssetScope) => void;
  readonly onDiscoveryDayChange: (day: string) => void;
  /** 点域名维度里的一台资产 → 回列表并搜索该 IP。 */
  readonly onDomainAssetClick: (ip: string) => void;
  readonly onRefresh: () => void;
  readonly onCopy: (text: string) => void;
}

/** 从事件里读 input 的值（React 合成事件与原生事件都能用）。 */
function inputValue(event: MinimalPointerEventLike): string {
  const target = event.target as { value?: unknown } | null | undefined;
  return typeof target?.value === "string" ? target.value : "";
}

/** 归属徽章（单字）。 */
function scopeBadge(
  runtime: ConsoleRuntime,
  scope: AssetScope,
  style?: Readonly<Record<string, string | number>>,
): ReactNode {
  return runtime.h("span", {
    className: "rt-scope rt-scope-" + scope,
    ...(style !== undefined ? { style } : {}),
  }, scopeShortLabel(scope));
}

/**
 * 易打性徽章。
 *
 * 原实现：`props.p` 假值时显示「未评」（而不是空）—— 未评估的资产也要占位，
 * 否则表格这一列会塌。
 */
function priorityBadge(runtime: ConsoleRuntime, priority: string, title: string): ReactNode {
  if (priority === "") {
    return runtime.h("span", { className: "rt-tag" }, "未评");
  }
  return runtime.h("span", {
    className: "rt-pri rt-pri-" + priority,
    title,
  }, priorityLabel(priority));
}

/** 测试状态徽章（未知状态直接显示原始 code，便于发现「后端加了状态前端没跟上」）。 */
function testStatusBadge(runtime: ConsoleRuntime, status: string): ReactNode {
  const value = status !== "" ? status : "untested";
  return runtime.h("span", { className: "rt-test rt-test-" + value }, testStatusLabel(value));
}

/** 来源徽章。 */
function provenanceBadge(runtime: ConsoleRuntime, provenance: string): ReactNode {
  if (provenance === "") return runtime.h("span", { className: "rt-tag" }, "未知");
  const label = provenance === "passive" ? "被动" : provenance === "active" ? "主动" : "未知";
  return runtime.h("span", { className: "rt-tag rt-tag-" + provenance }, label);
}

/** 侧栏：一个 C 段分组（外网/内网）。 */
function sideGroup(
  runtime: ConsoleRuntime,
  props: AssetsTabProps,
  title: string,
  list: readonly AssetSegment[],
  kind: AssetScope,
): readonly ReactNode[] {
  const { h } = runtime;
  const key = sideGroupKey(kind);
  const stored = props.collapsed[key];
  const open = stored === undefined ? SIDE_GROUP_DEFAULT_OPEN : stored === true;
  const activate = (event?: MinimalPointerEventLike): void => {
    event?.stopPropagation?.();
    props.onToggleSideGroup(kind);
  };
  const out: ReactNode[] = [
    h("div", {
      key: "h" + kind,
      className: "rt-sidehead rt-sidehead-btn",
      role: "button",
      tabIndex: 0,
      "aria-expanded": open ? "true" : "false",
      title: (open ? "收起本组" : "展开本组") + "（并切回资产列表）",
      onClick: () => {
        props.onViewChange("list");
        activate();
      },
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          props.onViewChange("list");
          activate(event);
        }
      },
    },
      h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
      h("span", { className: "rt-scope rt-scope-" + kind }, kind === "internal" ? "内网" : "外网"),
      h("span", null, title + " · " + list.length + " 个 C 段"),
      h("span", { className: "rt-spacer" }),
      h("span", { style: { fontWeight: 400 } }, totalAssetsOf(list) + " 资产"),
    ),
  ];
  if (!open) return out;
  for (const segment of list) {
    const active = props.filter.cidr === segment.cidr;
    out.push(h("div", {
      key: segment.cidr,
      className: "rt-seg" + (active ? " on" : ""),
      title: segmentTitle(segment),
      ...clickable(() => {
        props.onViewChange("list");
        props.onFilterChange({ ...props.filter, cidr: segment.cidr });
      }, { label: "筛选 C 段 " + segment.cidr, expanded: active && props.view !== "testing" }),
    },
      h("div", { className: "rt-seg-cidr", style: { display: "flex", alignItems: "baseline", gap: 5 } },
        h("span", { className: "rt-scope rt-scope-" + kind }, kind === "internal" ? "内" : "外"),
        h("span", { style: { flex: 1 } }, segment.cidr),
        h("span", { className: "rt-seg-meta", style: { margin: 0, whiteSpace: "nowrap" } },
          segment.assets + " 台"),
      ),
    ));
  }
  return out;
}

/** 侧栏。 */
function sidePane(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  const segments = segmentsOf(props.snapshot);
  const groups = groupSegments(segments);
  const allActive = props.filter.cidr === null && props.view !== "testing";
  const testingActive = props.view === "testing";

  const children: ReactNode[] = [
    h("div", {
      key: "all",
      className: "rt-seg" + (allActive ? " on" : ""),
      ...clickable(() => {
        props.onViewChange("list");
        props.onFilterChange({ ...props.filter, cidr: null });
      }, { label: "全部 C 段", expanded: allActive }),
    },
      h("div", { className: "rt-seg-cidr" }, "全部 C 段"),
      h("div", { className: "rt-seg-meta" }, segments.length + " 个网段"),
    ),
    h("div", {
      key: "testing",
      className: "rt-seg" + (testingActive ? " on" : ""),
      title: "正在跑的扫描 / 探测与进度（5 秒自动刷新）",
      ...clickable(() => {
        props.onViewChange("testing");
        props.onFilterChange({ ...props.filter, cidr: null });
      }, { label: "当前测试", expanded: testingActive }),
    },
      h("div", { className: "rt-seg-cidr", style: { display: "flex", alignItems: "baseline", gap: 5 } },
        h("span", { className: "rt-scope rt-scope-testing", title: "当前测试（既非内网也非外网）" }, "测"),
        h("span", { style: { flex: 1 } }, "当前测试"),
      ),
      h("div", { className: "rt-seg-meta" }, "正在跑的扫描与探测"),
    ),
  ];

  // 先外网（互联网可达，通常是入口）再内网（打进去之后才看得到）。
  if (groups.external.length > 0) {
    children.push(...sideGroup(runtime, props, "外网资产", groups.external, "external"));
  }
  if (groups.internal.length > 0) {
    children.push(...sideGroup(runtime, props, "内网资产", groups.internal, "internal"));
  }

  return h("div", { className: "rt-side" }, children);
}

/** 一个下拉筛选。 */
function filterSelect(
  runtime: ConsoleRuntime,
  value: string,
  options: readonly { readonly value: string; readonly label: string }[],
  onChange: (value: string) => void,
  title?: string,
): ReactNode {
  return runtime.h("select", {
    className: "rt-input",
    value,
    ...(title !== undefined ? { title } : {}),
    onChange: (event) => onChange(inputValue(event)),
  }, options.map((option) => runtime.h("option", { key: option.value, value: option.value }, option.label)));
}

/** 工具栏。 */
function toolbar(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  const set = (patch: Partial<AssetFilter>): void => props.onFilterChange({ ...props.filter, ...patch });
  return h("div", { className: "rt-toolbar" },
    h("input", {
      className: "rt-input",
      style: { flex: "1 1 150px" },
      placeholder: "搜索 IP / 域名 / 指纹（回车）",
      value: props.searchDraft,
      onChange: (event) => props.onSearchDraftChange(inputValue(event)),
      onKeyDown: (event) => {
        if (event.key === "Enter") props.onSearch();
      },
    }),
    h("button", { className: "rt-btn", onClick: () => props.onSearch() }, "搜索"),
    h("input", {
      className: "rt-input",
      style: { width: "78px" },
      placeholder: "服务",
      value: props.filter.service,
      onChange: (event) => set({ service: inputValue(event) }),
    }),
    h("input", {
      className: "rt-input",
      style: { width: "60px" },
      placeholder: "端口",
      value: props.filter.port,
      onChange: (event) => set({ port: inputValue(event) }),
    }),
    filterSelect(runtime, props.filter.scope, SCOPE_OPTIONS, (value) => {
      // 只允许三个字面值，其它一律当「不限」。
      set({ scope: value === "external" || value === "internal" ? value : "" });
    }),
    filterSelect(
      runtime,
      props.filter.provenance,
      PROVENANCE_OPTIONS,
      (value) => set({ provenance: value }),
      "按端口来源过滤（列表已不再单列显示，详情里可见）",
    ),
    filterSelect(runtime, props.filter.priority, PRIORITY_OPTIONS, (value) => set({ priority: value })),
    filterSelect(runtime, props.filter.testStatus, TEST_STATUS_OPTIONS, (value) => set({ testStatus: value })),
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn",
      title: "重新拉取快照与当前视图数据",
      onClick: () => props.onRefresh(),
    }, "刷新"),
    VIEW_BUTTONS.map((button) => h("button", {
      key: button.value,
      className: "rt-btn" + (props.view === button.value ? " rt-btn-primary" : ""),
      ...(button.title !== undefined ? { title: button.title } : {}),
      onClick: () => props.onViewChange(button.value),
    }, button.label)),
  );
}

/** 结论行（一屏看清家底，数字点一下就是筛选）。 */
function conclusionBar(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  const stats = conclusionStatsOf(props.snapshot);
  const items = conclusionItems(stats, props.filter);
  return h("div", { className: "rt-concl" },
    items.map((item) => h("span", {
      key: item.key,
      className: "rt-concl-i" + (item.active ? " on" : ""),
      title: "点击筛选 / 再点取消",
      ...clickable(
        () => props.onFilterChange(applyConclusion(props.filter, item.key as ConclusionKey)),
        { label: "按「" + item.label + "」筛选（" + item.value + "）", expanded: item.active },
      ),
    },
      h("b", null, String(item.value)),
      h("span", null, item.label),
    )),
    h("div", { className: "rt-spacer" }),
    h("select", {
      className: "rt-input",
      value: props.filter.sort,
      title: "列表排序方式",
      onChange: (event) => {
        const value = inputValue(event);
        const known = SORT_OPTIONS.some((option) => option.value === value);
        props.onFilterChange({ ...props.filter, sort: known ? (value as AssetFilter["sort"]) : "priority" });
      },
    }, SORT_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))),
  );
}

/** 列表视图。 */
function listPane(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  const state = props.list;
  const items = state?.items ?? [];

  const head = h("div", { className: "rt-row head" },
    h("span", null, "IP"),
    h("span", null, "易打"),
    h("span", null, "测试状态"),
    h("span", null, "开放端口 / 服务"),
    h("span", null, "指纹"),
  );

  const rows: ReactNode[] = [];
  for (const item of items) {
    const ports = portSummary(item.ports);
    const fingerprints = fingerprintSummary(item.fingerprints);
    const open = props.openId === item.id;
    rows.push(h("div", {
      key: "r" + item.id,
      className: "rt-row",
      ...clickable(() => props.onToggleRow(item.id), {
        label: "展开资产 " + item.ip,
        expanded: open,
      }),
    },
      h("span", { className: "rt-mono", style: { display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap" } },
        scopeBadge(runtime, item.scope),
        h("span", {
          title: item.state === "live" ? "存活" : item.state,
          style: {
            width: 7,
            height: 7,
            borderRadius: "50%",
            flex: "none",
            marginTop: 4,
            background: item.state === "live" ? "#10b981" : "#94a3b8",
          },
        }),
        h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, item.ip),
        // 发现时间挂在 IP 下面一行：IP 列宽度有限，不另开列。
        h("span", {
          style: {
            fontSize: 10.5,
            color: "var(--dsw-alias-label-secondary)",
            whiteSpace: "nowrap",
          },
          title: "发现时间：" + (item.discoveredAt !== "" ? formatTimestamp(item.discoveredAt) : "未记录")
            + (item.lastSeen !== "" ? "\n最近采集：" + formatTimestamp(item.lastSeen) : ""),
        }, item.discoveredAt !== "" ? formatTimestampShort(item.discoveredAt) : "发现时间未知"),
      ),
      h("span", null, priorityBadge(runtime, item.priority, item.potential)),
      h("span", null,
        testStatusBadge(runtime, item.testStatus),
        item.blockedCount > 0
          ? h("span", {
              className: "rt-tag",
              style: { color: "#ef4444", borderColor: "#ef444455", marginLeft: 4 },
            }, "封" + item.blockedCount)
          : null,
      ),
      h("span", { title: ports.full }, ports.shown),
      h("span", { title: fingerprints.full }, fingerprints.shown),
    ));

    if (!open) continue;
    rows.push(h("div", {
      key: "d" + item.id,
      className: "rt-row",
      style: { cursor: "default", gridTemplateColumns: "1fr" },
    }, h("div", { className: "rt-expand" }, detailBody(runtime, props, item))));
  }

  return h("div", { className: "rt-table" },
    head,
    rows,
    state !== null && !state.loading && items.length === 0
      ? h("div", { className: "rt-empty" }, listEmptyText())
      : null,
  );
}

/** 展开后的详情。 */
function detailBody(runtime: ConsoleRuntime, props: AssetsTabProps, item: AssetItem): ReactNode {
  const { h } = runtime;
  const detail = detailFor(item, props.detail);
  if (detail === null) return h("div", null, "加载中…");

  const openPorts = openPortsOf(detail);
  const all = props.showAllId === item.id;
  const noteLines = noteLinesOf(detail);

  const portRows = openPorts.map((port) => h("div", { key: "p" + port.port, className: "rt-kv" },
    h("b", { className: "rt-mono" }, port.port + "/" + port.proto),
    h("span", null, portServiceText(port)),
    port.url !== null
      ? h("a", {
          className: "rt-link",
          href: port.url,
          target: "_blank",
          rel: "noreferrer",
          title: port.url,
        }, port.title !== "" ? port.title : port.url)
      : null,
    provenanceBadge(runtime, port.provenance),
  ));

  const fingerprintRows = detail.fingerprints.map((fingerprint) => h("div", {
    key: "f" + fingerprint.product + fingerprint.version + fingerprint.evidence,
    className: "rt-kv",
  },
    h("b", null, fingerprint.category !== "" ? fingerprint.category : "—"),
    h("span", null, fingerprintDetailText(fingerprint)),
    provenanceBadge(runtime, fingerprint.provenance),
  ));

  const observationRows = detail.observations.slice(0, MAX_OBSERVATIONS).map((observation) => h("div", {
    key: "o" + observation.attr + observation.value + observation.collectedAt,
    className: "rt-kv",
  },
    h("b", null, observation.attr !== "" ? observation.attr : "—"),
    h("span", null, observationText(observation, formatTimestamp(observation.collectedAt))),
    provenanceBadge(runtime, observation.provenance),
  ));

  return h("div", null,
    // 必读三行。
    h("div", { className: "rt-kv" },
      h("b", null, "测试"),
      h("span", null,
        testStatusBadge(runtime, detail.testStatus),
        detail.blockedCount > 0
          ? h("span", {
              className: "rt-tag",
              style: { marginLeft: 6, color: "#ef4444", borderColor: "#ef444455" },
            }, "被封 " + detail.blockedCount + " 次")
          : null,
        h("span", { style: { marginLeft: 8, color: "var(--dsw-alias-label-secondary)" } },
          testMetaText(detail, formatTimestamp(detail.testUpdatedAt))),
      ),
    ),
    h("div", { className: "rt-kv" },
      h("b", null, "易打性"),
      h("span", null,
        priorityBadge(runtime, detail.priority, detail.assessReason),
        h("span", { style: { marginLeft: 8 } }, detail.potential !== "" ? detail.potential : "未评估"),
        detail.assessReason !== ""
          ? h("span", { style: { marginLeft: 8, color: "var(--dsw-alias-label-secondary)" } }, detail.assessReason)
          : null,
      ),
    ),
    h("div", { className: "rt-kv" },
      h("b", null, "攻击面"),
      h("span", null,
        surfaceText(detail, openPorts.length),
        h("span", {
          className: "rt-scope rt-scope-" + detail.scope,
          style: { marginLeft: 8 },
        }, scopeLongLabel(detail.scope)),
      ),
    ),
    h("span", {
      className: "rt-more",
      ...clickable(
        () => props.onToggleShowAll(all ? null : item.id),
        { label: all ? "收起资产详情" : "展开资产详情", expanded: all },
      ),
    }, all ? "收起全部 ▲" : "展开全部（端口 · 指纹 · 采集溯源 · 测试记录）▼"),
    all
      ? h("div", null,
          h("div", { className: "rt-kv" },
            h("b", null, "主机名"),
            h("span", null, namesText(detail)),
          ),
          h("div", { className: "rt-kv" },
            h("b", null, "发现时间"),
            h("span", { title: "本条资产第一次进入资产库的时刻（重复采集只刷新\"最近采集\"）" },
              formatTimestamp(detail.discoveredAt)),
            h("b", { style: { minWidth: 0, marginLeft: 8 } }, "最近采集"),
            h("span", null, formatTimestamp(detail.lastSeen)),
            h("b", { style: { minWidth: 0, marginLeft: 8 } }, "数据源首见"),
            h("span", null, formatTimestamp(detail.firstSeen)),
          ),
          h("div", { className: "rt-kv" },
            h("b", null, "C 段"),
            h("span", null, detail.segmentCidr),
          ),
          h("div", { className: "rt-kv" },
            h("b", null, "易打性"),
            h("span", null, assessLongText(detail, formatTimestamp(detail.assessedAt))),
          ),
          h("div", { className: "rt-kv" },
            h("b", null, "来源"),
            h("span", null, provenanceText(detail)),
          ),
          h("div", { style: { margin: "6px 0 3px", fontWeight: 600 } }, "开放端口 / 服务"),
          h("div", null, portRows.length > 0 ? portRows : "—"),
          h("div", { style: { margin: "6px 0 3px", fontWeight: 600 } }, "指纹"),
          h("div", null, fingerprintRows.length > 0 ? fingerprintRows : "—"),
          noteLines.length > 0
            ? clip(runtime, props, "测试记录（" + noteLines.length + " 条）", noteLines.join("\n"))
            : null,
          h("div", { style: { margin: "6px 0 3px", fontWeight: 600 } }, "采集溯源（最近 8 条）"),
          h("div", null, observationRows.length > 0 ? observationRows : "—"),
        )
      : null,
  );
}

/**
 * 长文本折叠。
 *
 * 原 `Clip` 用 `useState` 管展开态 —— 本层无 hook，展开态与复制回调整体
 * 由 props 承载（`notesOpen` / `onToggleNotes` / `onCopy`），行为不变。
 */
function clip(runtime: ConsoleRuntime, props: AssetsTabProps, label: string, text: string): ReactNode {
  const { h } = runtime;
  if (text.trim() === "") return null;
  return h("div", { className: "rt-clip" + (props.notesOpen ? " open" : "") },
    h("div", { className: "rt-clip-head" },
      h("span", { className: "rt-clip-label" }, label),
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
          props.onToggleNotes();
        },
      }, props.notesOpen ? "收起" : "展开"),
    ),
    h("div", { className: "rt-clip-body" }, text),
  );
}

/** 域名维度。 */
function domainPane(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  const domains = props.domains;
  if (domains === null) return h("div", { className: "rt-table" }, h("div", { className: "rt-empty" }, "加载中…"));
  if (domains.length === 0) {
    return h("div", { className: "rt-table" },
      h("div", { className: "rt-empty" }, domainEmptyText(props.filter.cidr)),
    );
  }
  const rows: ReactNode[] = [];
  for (const group of domains) {
    rows.push(h("div", { key: group.domain, className: "rt-section", style: { padding: "8px 10px 4px" } },
      h("a", {
        className: "rt-link",
        href: "http://" + group.domain,
        target: "_blank",
        rel: "noreferrer",
      }, group.domain),
      h("span", { className: "rt-tag", style: { marginLeft: 8 } }, group.count + " 个资产"),
    ));
    for (const asset of group.assets) {
      rows.push(h("div", {
        key: group.domain + "\u0000" + asset.id + "\u0000" + asset.ip,
        className: "rt-row",
        style: { gridTemplateColumns: "150px 130px 70px 1fr", cursor: "pointer" },
        onClick: () => props.onDomainAssetClick(asset.ip),
      },
        h("span", { className: "rt-mono" }, asset.ip),
        h("span", { className: "rt-mono" }, asset.segment),
        h("span", null,
          h("span", { className: "rt-tag rt-tag-" + (asset.state === "live" ? "live" : "dead") },
            asset.state === "live" ? "存活" : asset.state)),
        h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } },
          asset.names.join(", ")),
      ));
    }
  }
  return h("div", { className: "rt-table" }, rows);
}

/** Web 维度。 */
function webPane(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  const web = props.web;
  const columns = "1.6fr 1.2fr 130px 110px";
  return h("div", { className: "rt-table" },
    h("div", { className: "rt-row head", style: { gridTemplateColumns: columns } },
      h("span", null, "URL（可点击）"),
      h("span", null, "标题"),
      h("span", null, "资产"),
      h("span", null, "服务"),
    ),
    (web ?? []).map((asset) => {
      const url = webAssetUrl(asset);
      return h("div", {
        key: "w" + asset.portId,
        className: "rt-row",
        style: { gridTemplateColumns: columns, cursor: "default" },
      },
        h("a", {
          className: "rt-link rt-mono",
          href: url,
          target: "_blank",
          rel: "noreferrer",
          title: url,
        }, url),
        h("span", { title: asset.title }, asset.title !== "" ? asset.title : "—"),
        h("span", { className: "rt-mono" }, asset.ip + " · " + asset.segmentCidr),
        h("span", { style: { fontSize: 11 } }, webServiceText(asset)),
      );
    }),
    web === null
      ? h("div", { className: "rt-empty" }, "加载中…")
      : (web.length === 0 ? h("div", { className: "rt-empty" }, webEmptyText(props.filter.cidr)) : null),
  );
}

/** 发现时间线。 */
function timelinePane(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;
  if (props.discoveryError !== null) {
    return h("div", { className: "rt-pane" }, h("div", { className: "rt-err" }, props.discoveryError));
  }
  const data = props.discovery;
  if (data === null) return h("div", { className: "rt-empty" }, "加载中…");
  const recent = filterDiscoveryByDay(data.recent, props.discoveryDay);

  return h("div", { className: "rt-pane", style: { flex: 1, minHeight: 0 } },
    h("div", { className: "rt-card" },
      h("h4", null, "资产发现时间线"),
      h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
        discoverySpanText(data, formatTimestamp(data.first), formatTimestamp(data.last)) + DISCOVERY_NOTE),
    ),
    data.days.length === 0 ? h("div", { className: "rt-empty" }, "还没有资产。") : null,
    h("div", { className: "rt-card" },
      h("h4", null, "按天统计",
        props.discoveryDay !== ""
          ? h("span", {
              className: "rt-tag",
              style: { marginLeft: 6, cursor: "pointer" },
              ...clickable(() => props.onDiscoveryDayChange(""), {
                label: "清除按天筛选：" + props.discoveryDay,
              }),
            }, "清除筛选：" + props.discoveryDay)
          : null,
      ),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
        data.days.map((day) => {
          const active = props.discoveryDay === day.day;
          return h("div", {
            key: day.day,
            className: "rt-seg" + (active ? " on" : ""),
            style: { marginBottom: 0, cursor: "pointer" },
            title: day.day + "：新增 " + day.assets + " 台（内网 " + day.internal + " / 外网 " + day.external + "）",
            ...clickable(
              () => props.onDiscoveryDayChange(active ? "" : day.day),
              { label: "筛选 " + day.day + " 发现的资产", expanded: active },
            ),
          },
            h("div", { className: "rt-seg-cidr" }, day.day),
            h("div", { className: "rt-seg-meta" }, day.assets + " 台 · 内 " + day.internal + " / 外 " + day.external),
          );
        }),
      ),
    ),
    h("div", { className: "rt-card" },
      h("h4", null, props.discoveryDay !== ""
        ? props.discoveryDay + " 发现的资产（" + recent.length + "）"
        : "最近发现的资产（" + recent.length + "）"),
      recent.length === 0 ? h("div", { className: "rt-empty" }, "这一天没有新增资产。") : null,
      recent.map((asset) => h("div", { key: asset.id, className: "rt-kv" },
        h("b", { className: "rt-mono", style: { minWidth: 110 } },
          scopeBadge(runtime, asset.scope, { marginRight: 4 }),
          asset.ip,
        ),
        h("span", { style: { minWidth: 132, fontSize: 11.5, color: "var(--dsw-alias-label-secondary)" } },
          asset.discoveredAt !== "" ? formatTimestamp(asset.discoveredAt) : "时间未知"),
        h("span", { style: { flex: 1 } },
          (asset.primaryName !== "" ? asset.primaryName : "—")
          + (asset.openPorts > 0 ? " · " + asset.openPorts + " 端口" : "")),
        priorityBadge(runtime, asset.priority, ""),
      )),
    ),
  );
}

/**
 * 渲染资产测绘页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderAssetsTab(runtime: ConsoleRuntime, props: AssetsTabProps): ReactNode {
  const { h } = runtime;

  // 未选靶标：渲染真实空态（不是空白），与面板的 `!eng` 分支文案对齐。
  if (props.engagement === null || props.engagement === "") {
    return h("div", { className: "rt-main" },
      h("div", { className: "rt-empty" }, NO_ENGAGEMENT_TEXT),
    );
  }

  let pane: ReactNode;
  switch (props.view) {
    case "testing":
      pane = props.renderTesting !== undefined
        ? props.renderTesting()
        : h("div", { className: "rt-empty" }, "当前测试页面未接线");
      break;
    case "domain":
      pane = domainPane(runtime, props);
      break;
    case "web":
      pane = webPane(runtime, props);
      break;
    case "timeline":
      pane = timelinePane(runtime, props);
      break;
    case "list":
      pane = listPane(runtime, props);
      break;
  }

  const error = props.list?.error ?? null;

  return h("div", { className: "rt-split" },
    sidePane(runtime, props),
    h("div", { className: "rt-main" },
      props.view === "testing" ? null : toolbar(runtime, props),
      conclusionBar(runtime, props),
      error !== null ? h("div", { className: "rt-err" }, error) : null,
      pane,
    ),
  );
}

/** 默认 props（供测试与「未接线」场景使用）。 */
export function defaultAssetsProps(engagement: string | null): AssetsTabProps {
  return {
    engagement,
    snapshot: null,
    filter: DEFAULT_ASSET_FILTER,
    searchDraft: "",
    view: "list",
    list: null,
    domains: null,
    web: null,
    detail: null,
    openId: null,
    showAllId: null,
    notesOpen: false,
    collapsed: {},
    discovery: null,
    discoveryError: null,
    discoveryDay: "",
    onFilterChange: () => undefined,
    onSearchDraftChange: () => undefined,
    onSearch: () => undefined,
    onViewChange: () => undefined,
    onToggleRow: () => undefined,
    onToggleShowAll: () => undefined,
    onToggleNotes: () => undefined,
    onToggleSideGroup: () => undefined,
    onDiscoveryDayChange: () => undefined,
    onDomainAssetClick: () => undefined,
    onRefresh: () => undefined,
    onCopy: () => undefined,
  };
}
