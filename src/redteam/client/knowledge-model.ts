/**
 * 知识库页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `KnowledgeTab` 的 271 行是全项目**分支最多**的一个页签：
 * 检索表单（6 个字段）、归类分组、知识库条目、nuclei 模板分页、
 * 空态的**五种**不同解读。抽出来后要钉住的是：
 *
 * 1. **归类计数是「知识库 + 本机模板」的和**：`catShown(c) = c.n + tplByCat.get(c.code)`。
 *    只数知识库会让「有 800 个 nuclei 模板但库里 0 条」的归类显示成 0，
 *    用户以为那类武器是空的。
 * 2. **空态有五种解读**，每种给不同行动建议（见 `emptyDiagnosis`）：
 *    有筛选条件 → 换关键字；库空+模板有但没列 → 重启客户端；
 *    模板目录存在但没 yaml → 跑 update-templates；都没有 → 装模板库；
 *    有条目 → 不该走空态。
 * 3. **`tplMatched` 兜底成 `tpl.total`**：老 host 不给 `matched`，
 *    用 total 当 matched 才不会显示 `0–0 / 0`。
 *
 * ## 两个原实现的行为，别改
 *
 * - **首次进入拉全量、检索是显式动作**：原注释写「避免边打字边打接口」。
 *   所以输入框的 `onChange` 只改本地状态，回车/点「检索」才发请求。
 * - **模板分页的 offset 归一**：`Math.max(0, next)` —— 上一页按到底时
 *   不能出现负 offset。
 */

import { formatTimestamp, isFailure } from "./helpers.js";
import { POC_CATEGORY_LABEL, POC_CAT_ORDER, ROLE_LABEL, labelOf } from "./label.js";

/** POC 类型 → 中文。 */
export const POC_KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  poc: "POC",
  exp: "EXP",
  script: "脚本",
  template: "模板",
  payload: "载荷",
});

/** 来源 → 中文。 */
export const POC_SOURCE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  web: "互联网",
  self: "手搓",
  manual: "人工",
  "nuclei-template": "nuclei 模板",
  kb: "知识库",
});

/** 归类名（与 `label.ts` 共用一张表，避免两份中文对不上）。 */
export const POC_CAT_NAME: Readonly<Record<string, string>> = POC_CATEGORY_LABEL;

/** 归类顺序（面板按它分组）。 */
export const POC_CAT_ORDER_LIST: readonly string[] = POC_CAT_ORDER;

/** 模板每页条数。 */
export const TEMPLATE_PAGE_SIZE = 40;

/** 正文的截断长度（超出提示去看落盘文件）。 */
export const CONTENT_LIMIT = 12000;

/** 空态：知识库还是空的。 */
export const EMPTY_KB_MESSAGE = "知识库还是空的";

/** 老 host 没有知识库接口时的恢复说明。 */
export const OLD_HOST_MESSAGE = "知识库接口由 host 侧提供，当前宿主还是旧进程 —— "
  + "请完全退出后重新打开（官方 exe / 社区版 / dsh web 任一），再刷新页面。";

/** 打 Nday 的标准顺序（空态里的行动建议）。 */
export const STANDARD_ORDER_HINT = "打 Nday/1day 的标准顺序：① redteam_poc_search 先查这里"
  + "（顺带搜本机 nuclei 模板库）→ ② 都没有就互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）"
  + "或自己手搓 → ③ 在真实目标上验证有效后 redteam_poc_add 回填，后面的靶标直接就能用。";

/** 底部说明。 */
export const KB_FOOTER = "全局共享（跨靶标）｜ 落盘：pocs/<code>/ ｜ 只收录通用可复用的 POC/EXP，靶标专用脚本走「攻击文件」";

/** 加载中文案。 */
export const LOADING_KB_MESSAGE = "加载中…";

/** 没命中的提示。 */
export const NO_MATCH_MESSAGE = "没有命中：换个关键字再试，或去互联网找 / 自己手搓后回填。";

/** 检索失败兜底。 */
export const KB_ERROR_FALLBACK = "读取失败";

/** 一条知识库条目。 */
export interface PocItem {
  readonly id: number;
  readonly code: string;
  readonly title: string;
  readonly kind: string;
  readonly category: string;
  readonly source: string;
  readonly cve: string;
  readonly component: string;
  readonly versions: string;
  readonly language: string;
  readonly tags: string;
  readonly verified: boolean;
  readonly hitCount: number;
  readonly createdAt: string;
  readonly engagementId: string;
  readonly engagementName: string;
  readonly assetTarget: string;
  readonly foundByAgent: string;
  readonly sourceUrl: string;
}

/** 条目详情（`pocGet` 的响应）。 */
export interface PocDetail {
  readonly id: number;
  readonly title: string;
  readonly content: string;
  readonly usage: string;
  readonly description: string;
  readonly verifiedNote: string;
  readonly usedOn: string;
  readonly path: string;
  readonly sourceUrl: string;
}

/** 归类统计。 */
export interface CategoryCount {
  readonly code: string;
  readonly n: number;
  readonly verified: number;
  readonly hint: string;
}

/** 来源靶标统计。 */
export interface EngagementCount {
  readonly engagement: string;
  readonly n: number;
}

/** 知识库统计。 */
export interface PocStats {
  readonly total: number;
  readonly verified: number;
  readonly reused: number;
  readonly uncategorized: number;
  readonly byCategory: readonly CategoryCount[];
  readonly byEngagement: readonly EngagementCount[];
}

/** 一条本机 nuclei 模板。 */
export interface TemplateRow {
  readonly path: string;
  readonly name: string;
  readonly severity: string;
  readonly category: string;
}

/** 模板分页块。 */
export interface TemplatePage {
  readonly dir: string | null;
  readonly total: number;
  readonly matched: number;
  readonly offset: number;
  readonly items: readonly TemplateRow[];
  readonly byCategory: readonly { readonly code: string; readonly n: number }[];
}

/** 一次检索的结果。 */
export interface KnowledgeData {
  readonly items: readonly PocItem[];
  readonly stats: PocStats;
  readonly templates: TemplatePage;
  readonly dbPath: string;
  readonly root: string;
}

/** 检索条件。 */
export interface KnowledgeQuery {
  readonly q: string;
  readonly kind: string;
  readonly category: string;
  readonly engagement: string;
  readonly assetTarget: string;
  readonly verifiedOnly: boolean;
  readonly templateOffset: number;
}

/** 默认检索条件（空 = 拉全量）。 */
export const EMPTY_QUERY: KnowledgeQuery = Object.freeze({
  q: "",
  kind: "",
  category: "",
  engagement: "",
  assetTarget: "",
  verifiedOnly: false,
  templateOffset: 0,
});

/** 从不可信值读字符串。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 从不可信值读对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从不可信值读数组。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 读有限数字（非有限 → 0）。 */
function numberOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 读有限数字（非有限 → `null`）。 */
function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 计数字段（非有限 / 负数 → 0）。 */
export function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * 归一 `verified` 字段。
 *
 * 原实现判 `x.verified === 1`（SQLite 给整数），但 `true` 也可能出现。
 * 两种都认；其它一律 false。
 */
export function verifiedOf(value: unknown): boolean {
  return value === 1 || value === true;
}

/** 解析一条知识库条目。 */
export function pocItemOf(raw: unknown): PocItem | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    code: text(item["code"]),
    title: text(item["title"]),
    kind: text(item["kind"]),
    category: text(item["category"]),
    source: text(item["source"]),
    cve: text(item["cve"]),
    component: text(item["component"]),
    versions: text(item["versions"]),
    language: text(item["language"]),
    tags: text(item["tags"]),
    verified: verifiedOf(item["verified"]),
    hitCount: numberOf(item["hit_count"]) || numberOf(item["hitCount"]),
    createdAt: text(item["created_at"]) || text(item["createdAt"]),
    engagementId: text(item["engagement_id"]) || text(item["engagementId"]),
    engagementName: text(item["engagement_name"]) || text(item["engagementName"]),
    assetTarget: text(item["asset_target"]) || text(item["assetTarget"]),
    foundByAgent: text(item["found_by_agent"]) || text(item["foundByAgent"]),
    sourceUrl: text(item["source_url"]) || text(item["sourceUrl"]),
  };
}

/** 解析条目详情。 */
export function pocDetailOf(response: unknown): PocDetail | null {
  if (isFailure(response)) return null;
  const body = asRecord(response);
  const id = numberOrNull(body["id"]);
  if (id === null) return null;
  return {
    id,
    title: text(body["title"]),
    content: text(body["content"]),
    usage: text(body["usage"]),
    description: text(body["description"]),
    verifiedNote: text(body["verified_note"]) || text(body["verifiedNote"]),
    usedOn: text(body["used_on"]) || text(body["usedOn"]),
    path: text(body["path"]),
    sourceUrl: text(body["source_url"]) || text(body["sourceUrl"]),
  };
}

/** 解析统计块。 */
export function pocStatsOf(raw: unknown): PocStats {
  const item = asRecord(raw);
  return {
    total: numberOf(item["total"]),
    verified: numberOf(item["verified"]),
    reused: numberOf(item["reused"]),
    uncategorized: numberOf(item["uncategorized"]),
    byCategory: asArray(item["byCategory"]).map((entry) => {
      const record = asRecord(entry);
      return {
        code: text(record["code"]),
        n: numberOf(record["n"]),
        verified: numberOf(record["verified"]),
        hint: text(record["hint"]),
      };
    }).filter((entry) => entry.code !== ""),
    byEngagement: asArray(item["byEngagement"]).map((entry) => {
      const record = asRecord(entry);
      return { engagement: text(record["engagement"]), n: numberOf(record["n"]) };
    }).filter((entry) => entry.engagement !== ""),
  };
}

/** 解析一条模板。 */
export function templateRowOf(raw: unknown): TemplateRow | null {
  const item = asRecord(raw);
  const path = text(item["path"]);
  if (path === "") return null;
  return {
    path,
    name: text(item["name"]),
    severity: text(item["severity"]),
    category: text(item["category"]),
  };
}

/** 解析模板分页块。 */
export function templatePageOf(raw: unknown): TemplatePage {
  const item = asRecord(raw);
  const items = asArray(item["items"])
    .map(templateRowOf)
    .filter((entry): entry is TemplateRow => entry !== null);
  const total = numberOf(item["total"]);
  const matchedRaw = numberOrNull(item["matched"]);
  return {
    dir: typeof item["dir"] === "string" ? item["dir"] : null,
    total,
    // 老 host 不给 matched：用 total 兜底，否则页码显示成「0–0 / 0」。
    matched: matchedRaw === null ? total : countOrZero(matchedRaw),
    offset: countOrZero(item["offset"]),
    items,
    byCategory: asArray(item["byCategory"]).map((entry) => {
      const record = asRecord(entry);
      return { code: text(record["code"]), n: numberOf(record["n"]) };
    }).filter((entry) => entry.code !== ""),
  };
}

/** 解析 `pocSearch` 响应（失败 → `null`）。 */
export function knowledgeDataOf(response: unknown): KnowledgeData | null {
  if (isFailure(response)) return null;
  const body = asRecord(response);
  return {
    items: asArray(body["items"])
      .map(pocItemOf)
      .filter((entry): entry is PocItem => entry !== null),
    stats: pocStatsOf(body["stats"]),
    templates: templatePageOf(body["templates"]),
    dbPath: text(body["dbPath"]) || text(body["db_path"]),
    root: text(body["root"]),
  };
}

/**
 * 某归类的显示计数。
 *
 * `知识库条数 + 本机模板条数` —— 只数知识库会让「有 800 个模板但库里 0 条」
 * 的归类显示成 0，用户以为那类武器是空的。
 */
export function categoryShown(
  category: CategoryCount,
  templateCounts: ReadonlyMap<string, number>,
): number {
  return category.n + (templateCounts.get(category.code) ?? 0);
}

/** 从模板分页块造「归类 → 条数」表。 */
export function templateCategoryMap(templates: TemplatePage): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of templates.byCategory) map.set(entry.code, entry.n);
  return map;
}

/**
 * 归类条要不要显示。
 *
 * 原实现：`catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)` ——
 * 有内容的归类一定显示；内置归类即使为空也显示（让用户知道「这一类还没有武器」）。
 * 既没内容又不是内置归类 → 藏起来（避免脏数据撑爆横向空间）。
 */
export function showsCategory(category: CategoryCount, shown: number): boolean {
  return shown > 0 || POC_CAT_ORDER_LIST.includes(category.code);
}

/** 归类条的 title（悬浮说明）。 */
export function categoryTitle(
  category: CategoryCount,
  shown: number,
  templateCount: number,
): string {
  return (category.hint !== "" ? category.hint : (POC_CAT_NAME[category.code] ?? category.code))
    + " · 本机模板 " + templateCount
    + " · 知识库 " + category.n
    + (category.verified > 0 ? "（已验证 " + category.verified + "）" : "");
}

/** 归类条的显示名（含已验证数）。 */
export function categoryLabel(category: CategoryCount): string {
  const name = POC_CAT_NAME[category.code] ?? category.code;
  return category.verified > 0 ? name + "（已验证 " + category.verified + "）" : name;
}

/** 归类标题块的 key（`g<code>`）。 */
export function groupKey(code: string): string {
  return "g" + code;
}

/** 归类标题块的计数文案。 */
export function groupCountText(items: readonly PocItem[]): string {
  return items.length + " 条";
}

/** 归类标题块的已验证文案。 */
export function groupVerifiedText(items: readonly PocItem[]): string {
  return "已验证 " + items.filter((item) => item.verified).length;
}

/** 归类的中文名（未知原样显示）。 */
export function categoryName(code: string): string {
  return POC_CAT_NAME[code] ?? code;
}

/** 类型的中文名。 */
export function pocKindLabel(kind: string): string {
  return POC_KIND_LABEL[kind] ?? (kind !== "" ? kind : "POC");
}

/** 来源的中文名。 */
export function pocSourceLabel(source: string): string {
  return POC_SOURCE_LABEL[source] ?? (source !== "" ? source : "—");
}

/**
 * 条目的来源行（归类 · 版本 · 语言 · 标签 · 时间 · 来源靶标 · 发现资产 · 角色 · 链接）。
 *
 * 一行把「什么时候、在哪个单位的哪台资产上发现的」说清 —— 这是知识库
 * 能被人信任的原因（不是凭空冒出来的一条 POC）。
 */
export function itemSubLine(item: PocItem): string {
  return [
    item.category !== "" ? "归类 " + categoryName(item.category) : null,
    item.versions !== "" ? "影响版本 " + item.versions : null,
    item.language !== "" ? item.language : null,
    item.tags !== "" ? item.tags : null,
    "建立时间 " + formatTimestamp(item.createdAt),
    (item.engagementName !== "" || item.engagementId !== "")
      ? "来源靶标 " + (item.engagementName !== "" ? item.engagementName : item.engagementId)
      : null,
    item.assetTarget !== "" ? "发现资产 " + item.assetTarget : null,
    item.foundByAgent !== ""
      ? "发现角色 " + labelOf(ROLE_LABEL, item.foundByAgent)
      : null,
    item.sourceUrl !== "" ? "来源 " + item.sourceUrl : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

/** 条目的复用标签（`复用 N`；0 次 → `null`）。 */
export function hitCountLabel(item: PocItem): string | null {
  return item.hitCount !== 0 ? "复用 " + item.hitCount : null;
}

/** 验证徽章的文案。 */
export function verifiedLabel(item: PocItem): string {
  return item.verified ? "已验证" : "未验证";
}

/** 验证徽章的 className。 */
export function verifiedClass(item: PocItem): string {
  return item.verified ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn";
}

/** 条目头部的类型块 className（`rt-kb-kind k-<kind>`）。 */
export function kindClass(item: PocItem): string {
  return "rt-kb-kind k-" + (item.kind !== "" ? item.kind : "poc");
}

/** 卡片容器的 className（展开加 `open`）。 */
export function cardClass(open: boolean): string {
  return "rt-kb" + (open ? " open" : "");
}

/** 详情正文的截断处理（超 12000 字符时加提示）。 */
export function contentBody(content: string): string {
  if (content === "") return "";
  return content.length > CONTENT_LIMIT
    ? content.slice(0, CONTENT_LIMIT) + "\n…（已截断，完整内容见落盘文件）"
    : content;
}

/** 详情里没有正文时的提示。 */
export const MISSING_CONTENT_MESSAGE = "这条只有元数据，没有正文 —— 拿到正文后用 redteam_poc_update 补上";

/** 详情读取中。 */
export const DETAIL_LOADING_MESSAGE = "读取中…";

/** 详情是否属于当前展开项（防止切到别的条目后还显示上一条）。 */
export function detailFor(detail: PocDetail | null, openId: number | null): PocDetail | null {
  if (detail === null || openId === null) return null;
  return detail.id === openId ? detail : null;
}

/** 检索按钮的文案。 */
export function searchLabel(busy: boolean): string {
  return busy ? "检索中…" : "刷新";
}

/** 「记一次复用」成功的提示。 */
export function usedMessage(title: string): string {
  return "已记一次复用：" + title;
}

/** 复用请求的 `used_on` 固定值（原实现硬编码）。 */
export const USED_ON_MANUAL = "控制台手动标记";

/** 模板列表的状态行（`本机 nuclei 模板 · 1–40 / 812`）。 */
export function templateRangeLabel(templates: TemplatePage, shown: number): string {
  const start = templates.offset;
  return "本机 nuclei 模板 · " + (start + 1) + "–" + (start + shown) + " / " + templates.matched
    + "（直接 `nuclei -t <模板路径>`）";
}

/** 上一页是否可用（`offset <= 0` 时禁用）。 */
export function canPrevPage(busy: boolean, offset: number): boolean {
  return !busy && offset > 0;
}

/** 下一页是否可用（已经到底时禁用）。 */
export function canNextPage(busy: boolean, offset: number, shown: number, matched: number): boolean {
  return !busy && offset + shown < matched;
}

/** 翻页后的 offset（不小于 0）。 */
export function pageOffset(next: number): number {
  return Math.max(0, next);
}

/** 模板命令（点击复制的文本）。 */
export function templateCommand(path: string): string {
  return "nuclei -t " + path + " -u <目标>";
}

/** 模板行的类别标签（有归类才显示）。 */
export function templateCategoryLabel(template: TemplateRow): string | null {
  return template.category !== "" ? categoryName(template.category) : null;
}

/** 模板行的严重级（空 → `—`）。 */
export function templateSeverity(template: TemplateRow): string {
  return template.severity !== "" ? template.severity : "—";
}

/** 模板列表为空 + 知识库有内容时，模板块不渲染（`null`）。 */
export function showsTemplateBlock(templates: TemplatePage): boolean {
  return templates.items.length > 0;
}

/**
 * 分组渲染时的归类顺序。
 *
 * 内置顺序优先，未知归类挂末尾（`POC_CAT_ORDER` 里没有的 code）——
 * 原实现同样在遍历完内置顺序后 `push` 剩余 key。
 */
export function groupOrder(codes: readonly string[]): readonly string[] {
  const present = new Set(codes);
  const ordered: string[] = POC_CAT_ORDER_LIST.filter((code) => present.has(code));
  for (const code of codes) {
    if (!ordered.includes(code)) ordered.push(code);
  }
  return ordered;
}

/** 一条条目的分组键（内置归类 → 归到自己；未知 → `other`）。 */
export function bucketKeyOf(item: PocItem): string {
  return POC_CAT_NAME[item.category] !== undefined ? item.category : "other";
}

/** 分组头部的「最近建立」说明。 */
export function groupRecentLabel(items: readonly PocItem[]): string {
  const latest = items
    .map((item) => item.createdAt)
    .filter((value) => value !== "")
    .sort()
    .pop();
  return "最近建立 " + formatTimestamp(latest ?? "");
}

/** 分组头部的计数。 */
export function groupCount(items: readonly PocItem[]): number {
  return items.length;
}

/** 分组头部的已验证数。 */
export function groupVerified(items: readonly PocItem[]): number {
  return items.filter((item) => item.verified).length;
}

/** 空态的诊断结果。 */
export type EmptyDiagnosis =
  | { readonly kind: "no-match" }
  | { readonly kind: "templates-not-listed"; readonly total: number }
  | { readonly kind: "templates-dir-empty"; readonly dir: string }
  | { readonly kind: "no-templates"; }
  | { readonly kind: "none" };

/**
 * 空态诊断：**五种**不同的解读。
 *
 * 原实现是一条嵌套三元链，这就是它最值得被抽出来的原因 ——
 * 六种情况三种文案，埋在一行里没人能确认改动有没有打破分支。
 */
export function emptyDiagnosis(
  query: KnowledgeQuery,
  templates: TemplatePage,
): EmptyDiagnosis {
  const filtered = query.q !== "" || query.kind !== "" || query.verifiedOnly;
  if (filtered) return { kind: "no-match" };
  if (templates.total > 0) return { kind: "templates-not-listed", total: templates.total };
  if (templates.dir !== null) return { kind: "templates-dir-empty", dir: templates.dir };
  return { kind: "no-templates" };
}

/** 空态的主文案。 */
export function emptyTitle(diagnosis: EmptyDiagnosis): string {
  switch (diagnosis.kind) {
    case "no-match":
      return NO_MATCH_MESSAGE;
    case "templates-not-listed":
      return "POC/EXP 库还是空的；本机已有 " + diagnosis.total + " 个 nuclei 模板，但这一页没有列出来。请完全退出后重新打开客户端。";
    case "templates-dir-empty":
      return "知识库还是空的（本机模板目录存在但没有 yaml，请跑 nuclei -update-templates）。";
    case "no-templates":
      return "知识库还是空的。本机也还没有 nuclei 模板库 —— 在演练机上跑 setup.sh 或 `nuclei -update-templates`，装好后这里会出现「本机模板 N」。";
    case "none":
      return EMPTY_KB_MESSAGE;
  }
}

/** 空态里是否显示「知识库文件」行。 */
export function showsDbPath(data: KnowledgeData | null): boolean {
  return data !== null && data.dbPath !== "";
}

/** 空态里是否显示「模板目录」行。 */
export function showsTemplateDir(templates: TemplatePage): boolean {
  return templates.dir !== null && templates.dir !== "";
}

/** 检索失败是否为「宿主太旧」（`engagement required` / `unknown op`）。 */
export function isOldHostError(error: string | null): boolean {
  if (error === null) return false;
  return /engagement required|unknown op/i.test(error);
}

/** 检索失败的显示文案（老宿主给可执行的恢复步骤）。 */
export function errorText(error: string | null): string {
  if (error === null) return "";
  return isOldHostError(error) ? OLD_HOST_MESSAGE : error;
}

/** 工具栏的计数项。 */
export function statsLabels(stats: PocStats, templateTotal: number): readonly string[] {
  const out: string[] = [];
  out.push(stats.total + " 条");
  out.push("已验证 " + stats.verified);
  out.push("累计复用 " + stats.reused);
  if (stats.uncategorized > 0 && stats.uncategorized !== stats.total) {
    out.push("未归类 " + stats.uncategorized);
  }
  if (templateTotal !== 0) out.push("本机模板 " + templateTotal);
  return out;
}

/** 未归类标签的 title。 */
export const UNCATEGORIZED_TITLE = "这些条目还没归类：智能体回填时用 redteam_poc_add 的 category 参数标一下";

/** 未归类标签是否显示。 */
export function showsUncategorized(stats: PocStats): boolean {
  return stats.uncategorized > 0 && stats.uncategorized !== stats.total;
}

/** 知识库文件行的文案。 */
export function dbPathLine(data: KnowledgeData): string {
  return "知识库：" + data.dbPath + (data.root !== "" ? "（根目录 " + data.root + "）" : "");
}

/** 模板目录行的文案。 */
export function templateDirLine(templates: TemplatePage): string {
  return "模板目录：" + (templates.dir ?? "");
}

/**
 * 造检索请求参数。
 *
 * 空值一律不下发（原实现 `q.trim() || undefined`），`verified=false` 也
 * 不下发（区别于「只要未验证」—— 后端没有这个语义）。
 */
export function queryParams(query: KnowledgeQuery): Readonly<Record<string, unknown>> {
  const offset = pageOffset(query.templateOffset);
  return {
    ...(query.q.trim() !== "" ? { q: query.q.trim() } : {}),
    ...(query.kind !== "" ? { kind: query.kind } : {}),
    ...(query.category !== "" ? { category: query.category } : {}),
    ...(query.engagement !== "" ? { engagement: query.engagement } : {}),
    ...(query.assetTarget.trim() !== "" ? { asset_target: query.assetTarget.trim() } : {}),
    ...(query.verifiedOnly ? { verified: true } : {}),
    templateOffset: offset,
    templateLimit: TEMPLATE_PAGE_SIZE,
  };
}

/** 改一个检索字段（返回新条件，不改原对象）。 */
export function withQueryField<K extends keyof KnowledgeQuery>(
  query: KnowledgeQuery,
  key: K,
  value: KnowledgeQuery[K],
): KnowledgeQuery {
  return { ...query, [key]: value };
}

/** 点归类条后的新归类（同一条再点 → 清空）。 */
export function toggleCategory(current: string, code: string): string {
  return current === code ? "" : code;
}

/**
 * 归类条点击后的完整请求条件。
 *
 * 原实现是 `setCategory(next); query({ category: next || undefined })` ——
 * 既改本地状态又**立即**发一次带新归类的检索。这里一次算清。
 */
export function categoryQuery(query: KnowledgeQuery, code: string): KnowledgeQuery {
  return { ...query, category: toggleCategory(query.category, code), templateOffset: 0 };
}

/** 类型下拉的选项（顺序即 `POC_KIND_LABEL` 的键顺序）。 */
export const POC_KIND_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze(
  Object.entries(POC_KIND_LABEL).map(([value, label]) => ({ value, label })),
);

/** 归类下拉的选项（含「全部归类」）。 */
export const POC_CATEGORY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: "", label: "全部归类" },
  ...POC_CAT_ORDER_LIST.map((code) => ({ value: code, label: POC_CAT_NAME[code] ?? code })),
]);

/** 检索条件是否有筛选（用于空态诊断与「清空筛选」）。 */
export function hasFilters(query: KnowledgeQuery): boolean {
  return query.q !== "" || query.kind !== "" || query.category !== "" || query.engagement !== ""
    || query.assetTarget !== "" || query.verifiedOnly;
}
