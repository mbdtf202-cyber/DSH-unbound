/**
 * 技能库页（`skills` 页签）的渲染。
 *
 * 数据与过滤全在 `skills-model.ts`（83 用例），这里只排版。
 *
 * ## 布局（原实现是左右分栏）
 *
 * ```
 * ┌─────────────┬──────────────────────┐
 * │ 搜索框      │ 详情（展开时才显示）  │
 * │ 只看本插件  │  名称 / 路径          │
 * │ 只看不可用  │  正文                │
 * │ 可用性徽章  │                      │
 * │ 红队技能    │                      │
 * │ 官方技能    │                      │
 * └─────────────┴──────────────────────┘
 * ```
 *
 * ## 一个原实现的细节，这里保留
 *
 * 「只看不可用」复选框**只在真有缺口时才出现**（`showsBrokenFilter`）。
 * 永远显示一个「（0 个）」的复选框是噪声。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import {
  DEFAULT_SKILL_FILTER,
  availabilityLabel,
  availabilityTitle,
  catalogLoadOf,
  detailOf,
  filterSkills,
  gapCount,
  groupSkills,
  problemLine,
  showsBrokenFilter,
  showsProblemLine,
  skillKeyOf,
  skillSubtitle,
  toggleActive,
  visibleDirs,
  type CatalogLoad,
  type SkillDetail,
  type SkillFilter,
  type SkillItem,
} from "./skills-model.js";

/** 技能页的 props。 */
export interface SkillsTabProps {
  /** 目录加载结果。 */
  readonly catalog: CatalogLoad | null;
  /** 当前过滤条件。 */
  readonly filter: SkillFilter;
  /** 当前展开的技能键（`null` = 未展开）。 */
  readonly activeKey: string | null;
  /** 展开技能的详情。 */
  readonly detail: SkillDetail | null;
  /** 是否在请求中。 */
  readonly busy: boolean;
  /** 详情加载中。 */
  readonly detailBusy: boolean;
  readonly onRefresh: (force: boolean) => void;
  readonly onFilterChange: (filter: SkillFilter) => void;
  readonly onToggle: (item: SkillItem) => void;
}

/** 可用性徽章。 */
function availabilityBadge(runtime: ConsoleRuntime, item: SkillItem): ReactNode {
  const label = availabilityLabel(item.availability);
  if (item.library === "official") {
    // 官方技能只标「官方」：它们不按红队工具路径检查，
    // 标「可用性」会让人误以为它们也在被检查。
    return runtime.h("span", {
      className: "rt-tag",
      style: { marginLeft: 6 },
      title: "官方技能目录，不按红队工具路径检查",
    }, "官方");
  }
  return runtime.h("span", {
    className: "rt-avail rt-avail-" + item.availability,
    style: { marginLeft: 6 },
    title: availabilityTitle(item),
  }, label);
}

/** 一行技能。 */
function skillRow(runtime: ConsoleRuntime, props: SkillsTabProps, item: SkillItem): ReactNode {
  const key = skillKeyOf(item);
  const active = props.activeKey === key;
  return runtime.h("div", {
    key,
    className: "rt-item" + (active ? " on" : ""),
    role: "button",
    tabIndex: 0,
    "aria-label": "查看技能 " + item.name,
    "aria-expanded": active ? "true" : "false",
    onClick: () => props.onToggle(item),
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        props.onToggle(item);
      }
    },
  },
    runtime.h("div", { className: "rt-item-name" }, item.name,
      item.modelInvocable ? null : runtime.h("span", { className: "rt-tag", style: { marginLeft: 6 } }, "仅人工"),
      availabilityBadge(runtime, item),
    ),
    runtime.h("div", { className: "rt-item-desc" }, item.description !== "" ? item.description : "（无描述）"),
    runtime.h("div", { className: "rt-kb-sub" }, skillSubtitle(item)),
    showsProblemLine(item)
      ? runtime.h("div", {
          className: "rt-kb-sub",
          style: { color: "var(--dsw-alias-state-warn-primary, #f59e0b)" },
        }, problemLine(item))
      : null,
  );
}

/** 详情面板。 */
function detailPane(runtime: ConsoleRuntime, props: SkillsTabProps): ReactNode {
  if (props.activeKey === null) {
    return runtime.h("div", { className: "rt-empty" }, "点左侧技能查看正文");
  }
  if (props.detailBusy) {
    return runtime.h("div", { className: "rt-empty" }, "载入中…");
  }
  const detail = props.detail;
  if (detail === null) {
    return runtime.h("div", { className: "rt-empty" }, "读取失败或没有正文");
  }
  return runtime.h("div", { className: "rt-pane" },
    runtime.h("div", { className: "rt-card" },
      runtime.h("div", { style: { fontWeight: 600, marginBottom: 6 } }, detail.name),
      detail.description !== ""
        ? runtime.h("div", { style: { fontSize: 12, marginBottom: 6 } }, detail.description)
        : null,
      detail.whenToUse !== ""
        ? runtime.h("div", { className: "rt-kb-sub" }, "适用：" + detail.whenToUse)
        : null,
      detail.path !== null
        ? runtime.h("div", { className: "rt-kb-sub rt-mono" }, detail.path)
        : null,
    ),
    runtime.h("pre", { className: "rt-md" }, detail.content),
  );
}

/**
 * 渲染技能库页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderSkillsTab(runtime: ConsoleRuntime, props: SkillsTabProps): ReactNode {
  const { h } = runtime;
  const catalog = props.catalog;
  const items = catalog?.items ?? [];
  const meta = catalog?.meta ?? null;
  const summary = meta?.availability ?? null;

  const filtered = filterSkills(items, props.filter);
  const groups = groupSkills(filtered);
  const dirs = meta === null ? [] : visibleDirs(meta);

  // 徽章全显示（`共 N` / `本插件 N` / `可用 N` / `不可用 N` / `未知 N`）：
  // 这些是既定的外观契约（测试按语义断言），不要为省宽度把它们藏进 title。
  // 620px 下靠 THEME 收紧 badge 内边距与 gap 排成一行。
  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "技能库"),
    h("span", { className: "rt-tag" }, "共 " + items.length + " 个"),
    meta !== null && meta.fromPlugin > 0
      ? h("span", { className: "rt-tag rt-tag-live" }, "本插件 " + meta.fromPlugin)
      : null,
    summary !== null
      ? h("span", { className: "rt-avail rt-avail-available" }, "可用 " + summary.available)
      : null,
    summary !== null && summary.broken > 0
      ? h("span", {
          className: "rt-avail rt-avail-broken",
          title: "这些技能跑不起来：缺工具或正文读不到。勾选下方「只看不可用」查看",
        }, "不可用 " + summary.broken)
      : null,
    summary !== null && summary.unknown > 0
      ? h("span", {
          className: "rt-avail rt-avail-unknown",
          title: "判不了可用性（正文读不到）。勾选下方「只看不可用/未知」查看",
        }, "未知 " + summary.unknown)
      : null,
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn",
      disabled: props.busy,
      title: "跳过后端 30 秒可用性缓存，重新检查技能正文与环境",
      onClick: () => props.onRefresh(true),
    }, props.busy ? "读取中…" : "刷新"),
  );

  const errorNode = catalog !== null && catalog.error !== null
    ? h("div", { className: "rt-err" }, catalog.error)
    : null;

  // 宿主版本不含 skillCatalog op 时给一条明确的行动建议，
  // 而不是让用户对着「unknown op」发呆。
  const restartNode = catalog !== null && catalog.restartHint
    ? h("div", { className: "rt-foot" },
        "宿主版本似乎不含技能库接口：请重启 dsh web（或升级宿主）后刷新本页。")
    : null;

  const dirChips = dirs.length > 0
    ? h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 } },
        dirs.map((entry) =>
          h("span", { key: entry.key, className: "rt-tag", title: entry.key },
            entry.key + " · " + entry.n)))
    : null;

  const searchBox = h("input", {
    className: "rt-input",
    style: { width: "100%", marginBottom: 8, boxSizing: "border-box" },
    placeholder: "过滤技能",
    value: props.filter.query,
    onChange: (event) => {
      const value = String((event.target as { value?: string } | null)?.value ?? "");
      props.onFilterChange({ ...props.filter, query: value });
    },
  });

  const pluginCheckbox = h("label", { className: "rt-kb-check", style: { display: "flex", margin: "0 0 6px" } },
    h("input", {
      type: "checkbox",
      checked: props.filter.pluginOnly,
      onChange: (event) => {
        const checked = (event.target as { checked?: boolean } | null)?.checked === true;
        props.onFilterChange({ ...props.filter, pluginOnly: checked });
      },
    }),
    "只看本插件自带（" + (meta?.fromPlugin ?? 0) + " 个）",
  );

  const brokenCheckbox = showsBrokenFilter(summary)
    ? h("label", {
        className: "rt-kb-check",
        style: { display: "flex", margin: "0 0 8px" },
        title: "只看有明确缺口（缺 key / 缺本机路径 / 基础设施还是占位符）或判不了可用性的技能",
      },
      h("input", {
        type: "checkbox",
        checked: props.filter.brokenOnly,
        onChange: (event) => {
          const checked = (event.target as { checked?: boolean } | null)?.checked === true;
          props.onFilterChange({ ...props.filter, brokenOnly: checked });
        },
      }),
      "只看不可用/未知（" + gapCount(summary) + " 个）",
    )
    : null;

  /** 一组技能（带组标题）。 */
  const groupNode = (title: string, group: readonly SkillItem[], groupKey: string): ReactNode =>
    group.length === 0
      ? null
      : h("div", { key: groupKey },
          h("div", { className: "rt-kb-sub", style: { margin: "8px 0 4px", fontWeight: 600 } }, title),
          group.map((item) => skillRow(runtime, props, item)),
        );

  const emptyNode = filtered.length === 0
    ? h("div", { className: "rt-empty" },
        items.length === 0 ? "没有技能（本包 skills/redteam 目录为空）" : "没有匹配的技能")
    : null;

  // 工具栏横跨整宽，放在分栏**之上**而不是塞进左侧 210px 列表里：
  // 塞进窄栏会把「技能库 / 共 N 个 / 本插件 N / 可用 N / 不可用 N / 刷新」
  // 折成三行，把列表挤到看不见（真实渲染截图确认过）。
  return h("div", {
    className: "rt-kb-wrap",
    style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  },
    // 工具栏必须进树 —— 它是「共 N 个 / 本插件 N / 可用性徽章 / 刷新」的唯一载体。
    // 原实现漏了这一行，导致 `toolbar` 成了死代码：标题、徽章、刷新按钮全不渲染，
    // 8 个用例（标题/徽章/刷新点击/读取中/title 提示/null 态结构稳定/端到端）因此失败。
    toolbar,
    h("div", { className: "rt-split" },
      h("div", { className: "rt-list" },
        searchBox,
      pluginCheckbox,
      brokenCheckbox,
      dirChips,
      errorNode,
      restartNode,
      emptyNode,
        groupNode("红队技能", groups.redteam, "head-redteam"),
        groupNode("官方技能", groups.official, "head-official"),
      ),
      h("div", { className: "rt-main" }, detailPane(runtime, props)),
    ),
  );
}

/** 加载技能目录。 */
export async function loadSkillCatalog(api: ApiClient, force: boolean): Promise<CatalogLoad> {
  const response = await api.raw({ op: "skillCatalog", refresh: force });
  return catalogLoadOf(response as ApiResponse);
}

/** 读取技能详情。 */
export async function loadSkillDetail(
  api: ApiClient,
  item: SkillItem,
): Promise<{ readonly detail: SkillDetail | null; readonly error: string | null }> {
  const response = await api.raw({
    op: "skillRead",
    name: item.name,
    library: item.library,
  });
  if (response.ok === false) {
    return { detail: null, error: response.error ?? "读取失败" };
  }
  return { detail: detailOf(response), error: null };
}

/** 切换过滤条件里的一个布尔项（不修改原对象）。 */
export function toggleFilterFlag(filter: SkillFilter, flag: "pluginOnly" | "brokenOnly"): SkillFilter {
  return { ...filter, [flag]: !filter[flag] };
}

/** 重置过滤条件。 */
export function resetFilter(): SkillFilter {
  return DEFAULT_SKILL_FILTER;
}

/** 由点击算出新的 activeKey（复用模型层语义）。 */
export function nextActiveKey(current: string | null, item: SkillItem): string | null {
  return toggleActive(current, item);
}
