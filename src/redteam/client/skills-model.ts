/**
 * 技能库页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `SkillsTab` 的过滤与分组藏在渲染里：
 * ```js
 * let filtered = needle ? items.filter(s => (...).indexOf(needle) >= 0) : items
 * if (srcOnly) filtered = filtered.filter(s => s.library !== 'official' && s.fromPlugin === true)
 * if (brokenOnly) filtered = filtered.filter(s => ...)
 * const redteamRows = filtered.filter(s => s.library !== 'official')
 * const officialRows = filtered.filter(s => s.library === 'official')
 * ```
 * 这里有三个**容易错**的点，抽出来后可以逐条钉死：
 *
 * 1. **过滤器的组合顺序**：`srcOnly` 与 `brokenOnly` 都是「仅红队」语义，
 *    叠加时不能互相覆盖。原实现是顺序串联，等价于 AND。
 * 2. **"未知"算缺口**：`brokenOnly` 把 `unknown` 也算进来 —— 理由在
 *    原注释里：「判不了可用性」本身就是要处理的缺口，不该被藏起来。
 * 3. **搜索是三字段拼接**：`name + ' ' + description + ' ' + whenToUse`
 *    小写后子串匹配。只搜 name 会漏掉「按描述找技能」这个主用例。
 */

import type { ApiBody } from "../ui/protocol.js";

/** 技能可用性状态。 */
export type SkillAvailability = "available" | "broken" | "unknown" | "listed";

/** 技能库归属。 */
export type SkillLibrary = "redteam" | "official";

/** 一条技能。 */
export interface SkillItem {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly provider: string;
  readonly source: string;
  readonly dir: string | null;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly fromPlugin: boolean;
  readonly library: SkillLibrary;
  readonly availability: SkillAvailability;
  readonly problems: readonly string[];
  readonly needsUser: readonly string[];
}

/** 可用性统计。 */
export interface AvailabilitySummary {
  readonly available: number;
  readonly broken: number;
  readonly unknown: number;
}

/** 目录聚合项。 */
export interface DirCount {
  readonly key: string;
  readonly n: number;
}

/** 分类聚合项。 */
export interface SourceCount {
  readonly key: string;
  readonly n: number;
}

/** 技能目录元信息。 */
export interface SkillCatalogMeta {
  readonly total: number;
  readonly fromPlugin: number;
  readonly availability: AvailabilitySummary | null;
  readonly checkedAt: number | null;
  readonly cached: boolean;
  readonly broken: readonly { readonly name: string; readonly problems: readonly string[]; readonly needsUser: readonly string[] }[];
  readonly byDir: readonly DirCount[];
  readonly bySource: readonly SourceCount[];
  readonly note: string;
}

/** 从不可信值读字符串。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 从不可信值读对象。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从不可信值读字符串数组（过滤非字符串项）。 */
function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 归一可用性状态。 */
function availabilityOf(value: unknown): SkillAvailability {
  switch (value) {
    case "available":
    case "broken":
    case "unknown":
    case "listed":
      return value;
    default:
      // 未知取值按 unknown 处理：比猜成「可用」安全（不会把坏技能藏起来）。
      return "unknown";
  }
}

/** 归一库归属。 */
function libraryOf(value: unknown): SkillLibrary {
  return value === "official" ? "official" : "redteam";
}

/** 解析一条技能。 */
export function skillItemOf(raw: unknown): SkillItem {
  const item = recordOf(raw);
  return {
    name: text(item["name"]),
    description: text(item["description"]),
    whenToUse: text(item["when_to_use"]) || text(item["whenToUse"]),
    provider: text(item["provider"]),
    source: text(item["source"]),
    dir: typeof item["dir"] === "string" ? item["dir"] : null,
    // 缺省为 true（原实现语义：`invocation.modelInvocable !== false`）。
    modelInvocable: item["modelInvocable"] !== false,
    userInvocable: item["userInvocable"] !== false,
    fromPlugin: item["fromPlugin"] === true,
    library: libraryOf(item["library"]),
    availability: availabilityOf(item["availability"]),
    problems: stringsOf(item["problems"]),
    needsUser: stringsOf(item["needs_user"]) || stringsOf(item["needsUser"]),
  };
}

/** 解析目录响应。 */
export function catalogOf(response: unknown): { readonly items: readonly SkillItem[]; readonly meta: SkillCatalogMeta } {
  const body = recordOf(response);
  const rawItems = Array.isArray(body["items"]) ? body["items"] : [];
  const items = rawItems
    .map(skillItemOf)
    // 无名技能无法渲染、也无法读取，留着只会出空白行。
    .filter((item) => item.name !== "");

  const availability = recordOf(body["availability"]);
  const summary = recordOf(availability["summary"]);
  const hasSummary = Object.keys(summary).length > 0;

  const byDir = (Array.isArray(body["byDir"]) ? body["byDir"] : [])
    .map((entry) => {
      const record = recordOf(entry);
      const n = Number(record["n"]);
      return { key: text(record["key"]), n: Number.isFinite(n) ? n : 0 };
    })
    .filter((entry) => entry.key !== "");

  const bySource = (Array.isArray(body["bySource"]) ? body["bySource"] : [])
    .map((entry) => {
      const record = recordOf(entry);
      const n = Number(record["n"]);
      return { key: text(record["key"]), n: Number.isFinite(n) ? n : 0 };
    })
    .filter((entry) => entry.key !== "");

  const broken = (Array.isArray(availability["broken"]) ? availability["broken"] : [])
    .map((entry) => {
      const record = recordOf(entry);
      return {
        name: text(record["name"]),
        problems: stringsOf(record["problems"]),
        needsUser: stringsOf(record["needs_user"]) || stringsOf(record["needsUser"]),
      };
    })
    .filter((entry) => entry.name !== "");

  const checkedAtRaw = Number(availability["checked_at"]);

  return {
    items,
    meta: {
      total: items.length,
      fromPlugin: items.filter((item) => item.fromPlugin).length,
      availability: hasSummary
        ? {
            available: countOrZero(summary["available"]),
            broken: countOrZero(summary["broken"]),
            unknown: countOrZero(summary["unknown"]),
          }
        : null,
      checkedAt: Number.isFinite(checkedAtRaw) && checkedAtRaw > 0 ? checkedAtRaw : null,
      cached: availability["cached"] === true,
      broken,
      byDir,
      bySource,
      note: text(body["note"]),
    },
  };
}

/** 计数字段兜底（非数字 → 0）。 */
function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 过滤条件。 */
export interface SkillFilter {
  /** 搜索词（空串 = 不过滤）。 */
  readonly query: string;
  /** 只看本插件自带。 */
  readonly pluginOnly: boolean;
  /** 只看不可用/未知（仅红队）。 */
  readonly brokenOnly: boolean;
}

/** 默认过滤（全显示）。 */
export const DEFAULT_SKILL_FILTER: SkillFilter = Object.freeze({
  query: "",
  pluginOnly: false,
  brokenOnly: false,
});

/**
 * 搜索命中判定。
 *
 * 三字段拼接后子串匹配 —— 只搜 `name` 会漏掉「按描述找技能」这个主用例。
 */
export function matchesQuery(item: SkillItem, needle: string): boolean {
  if (needle === "") return true;
  const haystack = (item.name + " " + item.description + " " + item.whenToUse).toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

/**
 * 应用过滤。
 *
 * 三个条件**串联**（AND），与原实现一致。`pluginOnly` 与 `brokenOnly`
 * 都带「仅红队」语义 —— 官方技能不做工具路径检查，把它们算进
 * 「不可用」是错的。
 */
export function filterSkills(items: readonly SkillItem[], filter: SkillFilter): readonly SkillItem[] {
  const needle = filter.query.trim().toLowerCase();
  let result = needle === "" ? items : items.filter((item) => matchesQuery(item, needle));
  if (filter.pluginOnly) {
    result = result.filter((item) => item.library !== "official" && item.fromPlugin);
  }
  if (filter.brokenOnly) {
    result = result.filter((item) =>
      item.library !== "official"
      && (item.availability === "broken" || item.availability === "unknown"));
  }
  return result;
}

/** 分组结果。 */
export interface SkillGroups {
  readonly redteam: readonly SkillItem[];
  readonly official: readonly SkillItem[];
}

/** 按库归属分组（顺序保持输入顺序）。 */
export function groupSkills(items: readonly SkillItem[]): SkillGroups {
  return {
    redteam: items.filter((item) => item.library !== "official"),
    official: items.filter((item) => item.library === "official"),
  };
}

/** 技能的唯一键：`library:name`。 */
export function skillKeyOf(item: SkillItem): string {
  return item.library + ":" + item.name;
}

/**
 * 切换/打开一条技能的详情。
 *
 * 原实现语义：点同一条会折叠（返回 `null`），点别的会展开成新键。
 * 返回 `null` 表示「应关闭详情」。
 */
export function toggleActive(current: string | null, item: SkillItem): string | null {
  const key = skillKeyOf(item);
  return current === key ? null : key;
}

/** 目录聚合的显示项（前 6 个，过滤掉 0）。 */
export const MAX_DIR_CHIPS = 6;

/** 取要显示的目录聚合。 */
export function visibleDirs(meta: SkillCatalogMeta): readonly DirCount[] {
  return meta.byDir.filter((entry) => entry.n > 0).slice(0, MAX_DIR_CHIPS);
}

/** 缺口总数（不可用 + 未知）。 */
export function gapCount(summary: AvailabilitySummary | null): number {
  if (summary === null) return 0;
  return summary.broken + summary.unknown;
}

/** 是否显示「只看不可用」复选框。 */
export function showsBrokenFilter(summary: AvailabilitySummary | null): boolean {
  return gapCount(summary) > 0;
}

/**
 * 是否是「宿主版本不含此 op」的错误。
 *
 * 原实现：`err.indexOf('unknown op') >= 0` 时给一条「需要重启/升级宿主」的提示。
 * 这是真实的兼容场景：插件更新了但宿主还跑着旧版，技能 op 不存在。
 */
export function needsRestart(err: unknown): boolean {
  return typeof err === "string" && err.includes("unknown op");
}

/** 可用性徽章文案。 */
export function availabilityLabel(availability: SkillAvailability): string {
  switch (availability) {
    case "available":
      return "可用";
    case "broken":
      return "不可用";
    case "listed":
      // 官方技能不做检查，只列出。
      return "已列出";
    case "unknown":
      return "未知";
  }
}

/** 可用性徽章的 tooltip。 */
export function availabilityTitle(item: SkillItem): string {
  if (item.availability === "available") {
    return "可用：技能正文可以加载。缺的外部工具或密钥记在详情里，不阻止调用。";
  }
  const problems = item.problems.join("\n");
  return problems === "" ? "未知" : problems;
}

/** 技能行的副标题（来源 / 归属 / 目录）。 */
export function skillSubtitle(item: SkillItem): string {
  return [
    item.source !== "" ? "来源 " + item.source : null,
    item.fromPlugin ? "本插件自带" : null,
    item.provider !== "" ? item.provider : null,
    item.dir,
  ].filter((part): part is string => part !== null).join(" · ");
}

/**
 * 是否显示问题提示行。
 *
 * 三个条件同时满足：有问题、不是可用、不是官方 —— 官方技能不做检查，
 * 显示「⚠」会让用户以为官方技能坏了。
 */
export function showsProblemLine(item: SkillItem): boolean {
  return item.problems.length > 0 && item.availability !== "available" && item.library !== "official";
}

/** 问题提示行的文本（截断到 60 字符，与原实现一致）。 */
export function problemLine(item: SkillItem): string {
  if (item.problems.length === 0) return "";
  return "⚠ " + String(item.problems[0]).slice(0, 60);
}

/** 详情内容（`skillRead` 的响应）。 */
export interface SkillDetail {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly provider: string;
  readonly source: string;
  readonly path: string | null;
  readonly content: string;
}

/** 从响应解析详情。 */
export function detailOf(response: unknown): SkillDetail | null {
  const body = recordOf(response);
  if (body["ok"] === false) return null;
  const name = text(body["name"]);
  if (name === "") return null;
  return {
    name,
    description: text(body["description"]),
    whenToUse: text(body["whenToUse"]) || text(body["when_to_use"]),
    provider: text(body["provider"]),
    source: text(body["source"]),
    path: typeof body["path"] === "string" ? body["path"] : null,
    content: text(body["content"]),
  };
}

/** 目录响应失败时的错误文案。 */
export function catalogError(response: unknown, fallback = "读取失败"): string | null {
  if (response === null || response === undefined) return fallback;
  const body = recordOf(response);
  if (body["ok"] !== false) return null;
  const error = body["error"];
  return typeof error === "string" && error !== "" ? error : fallback;
}

/** 供流程函数返回的加载结果。 */
export interface CatalogLoad {
  readonly ok: boolean;
  readonly items: readonly SkillItem[];
  readonly meta: SkillCatalogMeta | null;
  readonly error: string | null;
  /** 失败是否因为宿主版本不含该 op。 */
  readonly restartHint: boolean;
}

/** 从响应造加载结果。 */
export function catalogLoadOf(response: ApiBody | null): CatalogLoad {
  const error = catalogError(response);
  if (error !== null) {
    return {
      ok: false,
      items: [],
      meta: null,
      error,
      restartHint: needsRestart(error),
    };
  }
  const parsed = catalogOf(response);
  return {
    ok: true,
    items: parsed.items,
    meta: parsed.meta,
    error: null,
    restartHint: false,
  };
}
