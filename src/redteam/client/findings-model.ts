/**
 * 漏洞战果页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `FindingsTab` 的 286 行里，有 130 行是**四件互不相干的逻辑**：
 *
 * 1. **漏洞行 + 展开详情**（`vulnRows`）
 * 2. **按目标聚合**（`targetKeyOf` + 分组排序）
 * 3. **攻击文件按漏洞聚合**（`filesByVuln` / `orphanFiles`）
 * 4. **证据区**（`detailEvidence` + HTTP 报文的行级着色）
 *
 * 这四块全是纯数据变换，埋在组件里只能整页渲染才能测。抽出来后：
 * - 「按目标聚合」的**归并规则**可逐条断言（带路径的 URL 不能把分组打散）
 * - 「拿到什么」的分割规则可穷举（`gained` 用中文顿号/逗号/分号分隔）
 * - 「证据缺失」这条红线可钉死（未验证/无证据的漏洞不计入报告）
 *
 * ## 三个容易错的地方
 *
 * 1. **`targetKeyOf` 必须砍掉路径**：`https://a/b` 与 `https://a/c` 是同一台。
 *    原实现用两条正则分别处理「带 scheme 的 URL」与「裸 host:port」，顺序有意义。
 * 2. **排序是复合的**：先按最高严重级，再按漏洞条数降序 —— 只按严重级排，
 *    同一档里 20 条的目标会混在 1 条的目标后面。
 * 3. **`stats` 缺失时不能崩**：原实现 `(state.stats && state.stats.bySeverity) ? ... : { bySeverity:{}, byStatus:{} }`。
 *    `stats` 为空对象但缺 `bySeverity` 时也要兜底 —— 否则结论行直接抛。
 */

import { formatTimestamp, isFailure } from "./helpers.js";
import { labelOf } from "./label.js";

/** 严重级。 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** 漏洞状态。 */
export type VulnStatus = "candidate" | "confirmed" | "exploited" | "false-positive" | "fixed";

/** 严重级 → 中文（顺序即下拉框顺序）。 */
export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = Object.freeze({
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
});

/** 状态 → 中文。 */
export const STATUS_LABEL: Readonly<Record<VulnStatus, string>> = Object.freeze({
  candidate: "待验证",
  confirmed: "已确认",
  "false-positive": "误报",
  exploited: "已利用",
  fixed: "已修复",
});

/** 严重级下拉的选项（值 + 显示名）。 */
export const SEVERITY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: "", label: "全部等级" },
  { value: "critical", label: "严重" },
  { value: "high", label: "高危" },
  { value: "medium", label: "中危" },
  { value: "low", label: "低危" },
  { value: "info", label: "信息" },
]);

/** 状态下拉的选项。 */
export const STATUS_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: "", label: "全部状态" },
  { value: "candidate", label: "待验证" },
  { value: "confirmed", label: "已确认" },
  { value: "exploited", label: "已利用" },
  { value: "false-positive", label: "误报" },
  { value: "fixed", label: "已修复" },
]);

/**
 * 严重级的排序权重。
 *
 * 未知级别取 `9`（原实现 `SEV_RANK[a.severity] ?? 9`）—— 排在最后，
 * 但**不会消失**。上游加了新级别时界面会把它放在末尾，便于发现「前端没跟上」。
 */
export const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

/** 默认每页条数（与原实现一致）。 */
export const FINDINGS_LIMIT = 200;

/** 空态文案。 */
export const EMPTY_FINDINGS_MESSAGE = "暂无漏洞记录";

/** 重启提示（宿主版本不含该 op 时）。 */
export const RESTART_HINT = "该模块的宿主代码已更新，需重启一次当前宿主（官方 exe / 社区版 / dsh web）后生效";

/** 证据缺失的警示（原实现的红线文案）。 */
export const MISSING_EVIDENCE_MESSAGE =
  "缺失 —— 未验证/无证据的漏洞不计入报告，请补 redteam_http_evidence_add";

/** 一条 HTTP 证据。 */
export interface HttpEvidence {
  readonly id: number;
  readonly label: string;
  readonly method: string;
  readonly status: number | null;
  readonly request: string;
  readonly response: string;
  readonly note: string;
  readonly capturedAt: string;
}

/** 一条漏洞。 */
export interface VulnItem {
  readonly id: number;
  readonly title: string;
  readonly severity: Severity;
  readonly status: VulnStatus;
  readonly cve: string;
  readonly target: string;
  readonly assetIp: string;
  readonly segmentCidr: string;
  readonly gained: string;
  /** 「拿到什么」的拆分结果（顿号/逗号/分号分隔，去空）。 */
  readonly gainedList: readonly string[];
  readonly source: string;
  readonly foundByAgent: string;
  readonly foundAt: string;
  readonly confidence: number | null;
  readonly evidence: string;
  readonly httpEvidence: readonly HttpEvidence[];
}

/** 一条攻击文件（挂在漏洞上的）。 */
export interface AttackFileRow {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly description: string;
  readonly path: string;
  readonly vulnId: number | null;
  readonly target: string;
}

/** 一条凭据。 */
export interface CredentialRow {
  readonly id: number;
  readonly host: string;
  readonly username: string;
  readonly secretType: string;
  readonly secretValue: string;
  readonly privilege: string;
  readonly source: string;
  readonly tool: string;
  readonly secretRef: string;
  readonly foundByAgent: string;
  readonly foundAt: string;
  readonly note: string;
}

/** 一条访问会话。 */
export interface AccessRow {
  readonly id: number;
  readonly host: string;
  readonly username: string;
  readonly method: string;
  readonly privilege: string;
  readonly sessionRef: string;
}

/** 漏洞查询的统计。 */
export interface FindingsStats {
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly withGained: number;
  readonly targetGroups: number;
}

/** 一次漏洞查询的结果。 */
export interface FindingsList {
  readonly total: number;
  readonly items: readonly VulnItem[];
  readonly stats: FindingsStats;
  readonly error: string | null;
  readonly loading: boolean;
}

/** 空结果（避免每处手写一份）。 */
export const EMPTY_FINDINGS: FindingsList = Object.freeze({
  total: 0,
  items: Object.freeze([]),
  stats: Object.freeze({
    bySeverity: Object.freeze({}),
    byStatus: Object.freeze({}),
    withGained: 0,
    targetGroups: 0,
  }),
  error: null,
  loading: false,
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

/** 读一个有限数字（非有限 → `null`）。 */
function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 计数字段兜底（非数字 / 负数 → 0）。 */
export function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 归一严重级（未知 → `info`，与原实现的 `sevClass` 兜底一致）。 */
export function severityOf(value: unknown): Severity {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
      return value;
    default:
      return "info";
  }
}

/** 归一状态（未知 → `candidate`：还没验证是最保守的解读）。 */
export function vulnStatusOf(value: unknown): VulnStatus {
  switch (value) {
    case "candidate":
    case "confirmed":
    case "exploited":
    case "false-positive":
    case "fixed":
      return value;
    default:
      return "candidate";
  }
}

/** 严重级徽章的 className。 */
export function severityClass(value: unknown): string {
  return "rt-sev rt-sev-" + severityOf(value);
}

/**
 * 严重级的中文名。
 *
 * 未知取值**原样显示 code**（`SEV_LABEL[s] || s`）—— 上游加了新级别时界面
 * 会暴露新值而不是变成一片「未知」，便于发现「后端加了、前端没跟上」。
 *
 * 注意空串/null 也原样返回空串（不是 `—`）：原实现是 `||` 短路，
 * 空值走的是「返回原值」那条路。要显示 `—` 的地方由调用方自己判断。
 */
export function severityLabel(value: unknown): string {
  return labelOf(SEVERITY_LABEL, value);
}

/** 状态的中文名（未知同样原样显示）。 */
export function statusLabel(value: unknown): string {
  return labelOf(STATUS_LABEL, value);
}

/**
 * 拆分「拿到什么」。
 *
 * 原实现：`String(v.gained || '').split(/[、,;，；]/).map(trim).filter(Boolean)`。
 * 支持中文顿号/逗号/分号与半角逗号/分号 —— 智能体回填时分隔符不统一。
 */
export function gainedListOf(value: unknown): readonly string[] {
  const raw = typeof value === "string" ? value : "";
  return raw
    .split(/[、,;，；]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * 「拿到什么」的一行摘要。
 *
 * 多余项收成 `+N`（原实现 `gainedList[0] + ' +' + (len-1)`）——
 * 表格列宽有限，铺开会把整个网格挤变形。空列表返回空串，由调用方决定显示 `—`。
 */
export function gainedSummary(list: readonly string[]): string {
  const first = list[0];
  if (first === undefined) return "";
  return list.length > 1 ? first + " +" + (list.length - 1) : first;
}

/**
 * 目标归并键：按「scheme://host:port」聚合，避免带路径的 URL 把分组打散。
 *
 * **保留原实现的判定顺序**：
 * 1. `target` 为空 → 用 `asset_ip`，都没有 → `(未指定目标)`；
 * 2. 带 scheme 的 URL 只取 `scheme://host[:port]`（砍掉 path/query/hash）；
 * 3. 裸串按第一个 `/`、`?`、`#`、空白切一刀；
 * 4. 全都不匹配（极端空白）→ 原样。
 */
export function targetKeyOf(v: { readonly target?: unknown; readonly asset_ip?: unknown }): string {
  const raw = typeof v.target === "string" ? v.target.trim() : "";
  if (raw !== "") {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(raw);
    if (url !== null && url[1] !== undefined) return url[1];
    const head = /^([^\s/?#]+)/.exec(raw);
    if (head !== null && head[1] !== undefined) return head[1];
    return raw;
  }
  const ip = typeof v.asset_ip === "string" ? v.asset_ip : "";
  return ip !== "" ? ip : "(未指定目标)";
}

/** 解析一条 HTTP 证据。 */
export function httpEvidenceOf(raw: unknown): HttpEvidence | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    label: text(item["label"]),
    method: text(item["method"]),
    status: numberOrNull(item["status"]),
    request: text(item["request"]),
    response: text(item["response"]),
    note: text(item["note"]),
    capturedAt: text(item["captured_at"]) || text(item["created_at"]),
  };
}

/** 解析一条漏洞。 */
export function vulnOf(raw: unknown): VulnItem | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  const gained = text(item["gained"]);
  return {
    id,
    title: text(item["title"]),
    severity: severityOf(item["severity"]),
    status: vulnStatusOf(item["status"]),
    cve: text(item["cve"]),
    target: text(item["target"]),
    assetIp: text(item["asset_ip"]),
    segmentCidr: text(item["segment_cidr"]),
    gained,
    gainedList: gainedListOf(gained),
    source: text(item["source"]),
    foundByAgent: text(item["found_by_agent"]),
    foundAt: text(item["found_at"]),
    confidence: numberOrNull(item["confidence"]),
    evidence: text(item["evidence"]),
    httpEvidence: asArray(item["http_evidence"])
      .map(httpEvidenceOf)
      .filter((entry): entry is HttpEvidence => entry !== null),
  };
}

/** 解析统计块。 */
export function statsOf(raw: unknown): FindingsStats {
  const item = asRecord(raw);
  const bySeverity = asRecord(item["bySeverity"]);
  const byStatus = asRecord(item["byStatus"]);
  const severityCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(bySeverity)) severityCounts[key] = countOrZero(value);
  const statusCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(byStatus)) statusCounts[key] = countOrZero(value);
  return {
    bySeverity: severityCounts,
    byStatus: statusCounts,
    withGained: countOrZero(item["withGained"]),
    targetGroups: countOrZero(item["targetGroups"]),
  };
}

/**
 * 解析 `vulns` 响应。
 *
 * `stats` 缺失时给一份空表（结论行据此渲染 0）—— 原实现的兜底也一样，
 * 只是它写成 `(state.stats && state.stats.bySeverity) ? ... : {bySeverity:{},byStatus:{}}`，
 * 也就是说 `stats` 存在但缺少 `bySeverity` 时也走空表分支。
 */
export function findingsOf(response: unknown): FindingsList {
  if (isFailure(response)) {
    const error = asRecord(response)["error"];
    return {
      ...EMPTY_FINDINGS,
      error: typeof error === "string" && error !== "" ? error : "查询失败",
    };
  }
  const body = asRecord(response);
  const items = asArray(body["items"])
    .map(vulnOf)
    .filter((item): item is VulnItem => item !== null);
  return {
    total: countOrZero(body["total"]),
    items,
    stats: statsOf(body["stats"]),
    error: null,
    loading: false,
  };
}

/** 是否是「宿主版本不含该 op」的错误。 */
export function needsRestart(error: string | null): boolean {
  return error !== null && error.includes("unknown op");
}

/** 一条凭据。 */
export function credentialOf(raw: unknown): CredentialRow | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    host: text(item["host"]),
    username: text(item["username"]),
    secretType: text(item["secret_type"]),
    secretValue: text(item["secret_value"]),
    privilege: text(item["privilege"]),
    source: text(item["source"]),
    tool: text(item["tool"]),
    secretRef: text(item["secret_ref"]),
    foundByAgent: text(item["found_by_agent"]),
    foundAt: text(item["found_at"]),
    note: text(item["note"]),
  };
}

/** 解析凭据列表响应（失败 → 空数组，与原实现的 `(r && r.items) || []` 一致）。 */
export function credentialsOf(response: unknown): readonly CredentialRow[] {
  if (isFailure(response)) return [];
  return asArray(asRecord(response)["items"])
    .map(credentialOf)
    .filter((item): item is CredentialRow => item !== null);
}

/** 一条访问会话。 */
export function accessOf(raw: unknown): AccessRow | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    host: text(item["host"]),
    username: text(item["username"]),
    method: text(item["method"]),
    privilege: text(item["privilege"]),
    sessionRef: text(item["session_ref"]),
  };
}

/** 解析访问会话列表。 */
export function accessesOf(response: unknown): readonly AccessRow[] {
  if (isFailure(response)) return [];
  return asArray(asRecord(response)["items"])
    .map(accessOf)
    .filter((item): item is AccessRow => item !== null);
}

/** 一条攻击文件（已带上所属目标）。 */
export function attackFileOf(raw: unknown, target: string): AttackFileRow | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  const rawVuln = item["vuln_id"];
  const vulnId = rawVuln === null || rawVuln === undefined ? null : numberOrNull(rawVuln);
  return {
    id,
    name: text(item["name"]),
    kind: text(item["kind"]),
    description: text(item["description"]),
    path: text(item["path"]),
    vulnId,
    target,
  };
}

/** 攻击文件的响应形态：`{ target, files[] }` 的分组数组。 */
export interface AttackFileGroup {
  readonly target: string;
  readonly files: readonly AttackFileRow[];
}

/** 解析 `attackFiles` 响应（按目标分组）。 */
export function attackFileGroupsOf(response: unknown): readonly AttackFileGroup[] {
  if (isFailure(response)) return [];
  return asArray(asRecord(response)["items"]).map((raw) => {
    const group = asRecord(raw);
    const target = text(group["target"]);
    return {
      target,
      files: asArray(group["files"])
        .map((file) => attackFileOf(file, target))
        .filter((file): file is AttackFileRow => file !== null),
    };
  });
}

/**
 * 把攻击文件按漏洞 id 归堆，并挑出没挂漏洞的。
 *
 * 原实现用 `vuln_id === null || undefined ? orphan : byVuln`。
 * **注意 `0` 的处理**：`vuln_id: 0` 在原实现里因为 `Number(0)` 不是 null，
 * 会被当成有效 id 归堆（虽然实际不会出现 id 0）—— 这里保持一致。
 */
export function indexFilesByVuln(groups: readonly AttackFileGroup[]): {
  readonly byVuln: ReadonlyMap<number, readonly AttackFileRow[]>;
  readonly orphans: readonly AttackFileRow[];
  readonly all: readonly AttackFileRow[];
} {
  const byVuln = new Map<number, AttackFileRow[]>();
  const orphans: AttackFileRow[] = [];
  const all: AttackFileRow[] = [];
  for (const group of groups) {
    for (const file of group.files) {
      all.push(file);
      if (file.vulnId === null) {
        orphans.push(file);
        continue;
      }
      const bucket = byVuln.get(file.vulnId);
      if (bucket === undefined) byVuln.set(file.vulnId, [file]);
      else bucket.push(file);
    }
  }
  return { byVuln, orphans, all };
}

/** 一个目标分组。 */
export interface TargetGroup {
  readonly key: string;
  readonly vulns: readonly VulnItem[];
  /** 该组里最严重的一条（排序用，也用于副标题）。 */
  readonly top: VulnItem;
  /** 该组「拿到什么」去重后的合集。 */
  readonly gained: readonly string[];
  /** 已利用条数。 */
  readonly exploited: number;
}

/**
 * 按目标聚合 + 排序。
 *
 * 排序是**复合**的：先按最高严重级升序（critical 在前），再按漏洞条数降序。
 * 只按严重级排会让同档次里 20 条的目标沉到 1 条的目标后面，看不出「哪台被打得最狠」。
 */
export function groupByTarget(vulns: readonly VulnItem[]): readonly TargetGroup[] {
  const buckets = new Map<string, VulnItem[]>();
  for (const vuln of vulns) {
    const key = targetKeyOf({ target: vuln.target, asset_ip: vuln.assetIp });
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [vuln]);
    else bucket.push(vuln);
  }
  const groups: TargetGroup[] = [];
  for (const [key, list] of buckets) {
    const sorted = list.slice().sort((a, b) => rankOf(a.severity) - rankOf(b.severity));
    const top = sorted[0];
    if (top === undefined) continue;
    const gained: string[] = [];
    const seen = new Set<string>();
    for (const vuln of list) {
      for (const item of vuln.gainedList) {
        if (seen.has(item)) continue;
        seen.add(item);
        gained.push(item);
      }
    }
    groups.push({
      key,
      vulns: list,
      top,
      gained,
      exploited: list.filter((vuln) => isExploited(vuln)).length,
    });
  }
  return groups.sort((a, b) =>
    rankOf(a.top.severity) - rankOf(b.top.severity) || b.vulns.length - a.vulns.length);
}

/** 取严重级权重（未知 → 9）。 */
function rankOf(severity: string): number {
  return SEVERITY_RANK[severity] ?? 9;
}

/** 是否已利用（拆出来避免在 sort/filter 里重复写字符串）。 */
function isExploited(vuln: VulnItem): boolean {
  return vuln.status === "exploited";
}

/** 聚合组的副标题：严重级 · 已利用 N · 资产 IP（与分组键不同时才给）。 */
export function groupSubtitle(group: TargetGroup): string {
  return [
    severityLabel(group.top.severity),
    group.exploited > 0 ? "已利用 " + group.exploited : null,
    group.top.assetIp !== "" && group.top.assetIp !== group.key ? "资产 " + group.top.assetIp : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

/** 聚合组右侧的「拿到什么」：最多两项 + `+N`。 */
export function groupGainedLabel(group: TargetGroup): string {
  if (group.gained.length === 0) return "未记录权限";
  const head = group.gained.slice(0, 2).join(" / ");
  return group.gained.length > 2 ? head + " +" + (group.gained.length - 2) : head;
}

/** 聚合组的计数文案（`N 个漏洞`）。 */
export function groupCountLabel(group: TargetGroup): string {
  return group.vulns.length + " 个漏洞";
}

/** 结论行的一项。 */
export interface ConclusionItem {
  readonly code: string;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  /** 点击后应设的新值（`""` = 取消筛选）。 */
  readonly next: string;
}

/**
 * 结论行的六项。
 *
 * 原实现把「已确认 / 已利用 / 严重 / 高危 / 中危 / 拿到权限」六个数字并排放，
 * 点一下就是筛选、再点取消。这里把「值的来源 + 点完变什么」集中算出来，
 * 组件只负责渲染与派发。
 *
 * **「拿到权限」不可点**：它不是筛选项（`stats.withGained` 是独立统计，
 * 后端没有对应的筛选参数）。原实现同样给了一个空回调。
 */
export function conclusionItems(
  stats: FindingsStats,
  severity: string,
  status: string,
): readonly ConclusionItem[] {
  return [
    {
      code: "confirmed",
      label: "已确认",
      count: stats.byStatus["confirmed"] ?? 0,
      active: status === "confirmed",
      next: status === "confirmed" ? "" : "confirmed",
    },
    {
      code: "exploited",
      label: "已利用",
      count: stats.byStatus["exploited"] ?? 0,
      active: status === "exploited",
      next: status === "exploited" ? "" : "exploited",
    },
    {
      code: "critical",
      label: "严重",
      count: stats.bySeverity["critical"] ?? 0,
      active: severity === "critical",
      next: severity === "critical" ? "" : "critical",
    },
    {
      code: "high",
      label: "高危",
      count: stats.bySeverity["high"] ?? 0,
      active: severity === "high",
      next: severity === "high" ? "" : "high",
    },
    {
      code: "medium",
      label: "中危",
      count: stats.bySeverity["medium"] ?? 0,
      active: severity === "medium",
      next: severity === "medium" ? "" : "medium",
    },
    {
      code: "gained",
      label: "拿到权限",
      count: stats.withGained,
      active: false,
      next: "",
    },
  ];
}

/** 结论行右侧的目标数说明。 */
export function targetSummary(stats: FindingsStats): string {
  return "默认按目标聚合 · 共 " + stats.targetGroups + " 个目标";
}

/** 结论项的 aria-label（读屏播报「按 X 筛选（N）」）。 */
export function conclusionLabel(item: ConclusionItem): string {
  return "按「" + item.label + "」筛选（" + item.count + "）";
}

/** 结论项的 className（选中加 `on`）。 */
export function conclusionClass(item: ConclusionItem): string {
  return "rt-concl-i" + (item.active ? " on" : "");
}

/** 置信度的显示值（`null` → `—`，否则百分比取整）。 */
export function confidenceLabel(value: number | null): string {
  if (value === null) return "—";
  return Math.round(value * 100) + "%";
}

/** 漏洞标题的显示串（`CVE-xxx 标题`）。 */
export function vulnTitle(vuln: VulnItem): string {
  return (vuln.cve !== "" ? vuln.cve + " " : "") + vuln.title;
}

/** 漏洞目标的显示值（`target` → `asset_ip` → `—`）。 */
export function vulnTarget(vuln: VulnItem): string {
  if (vuln.target !== "") return vuln.target;
  return vuln.assetIp !== "" ? vuln.assetIp : "—";
}

/** 详情里的资产行（`IP · C 段`）。 */
export function vulnAssetLine(vuln: VulnItem): string {
  return (vuln.assetIp !== "" ? vuln.assetIp : "—") + " · " + vuln.segmentCidr;
}

/** 详情里的来源行（`来源 · 角色 · 时间`）。 */
export function vulnSourceLine(vuln: VulnItem): string {
  return (vuln.source !== "" ? vuln.source : "—")
    + " · " + (vuln.foundByAgent !== "" ? vuln.foundByAgent : "—")
    + " · " + formatTimestamp(vuln.foundAt);
}

/** 凭据的元信息行。 */
export function credentialMeta(cred: CredentialRow): string {
  return [
    cred.source !== "" ? "来源 " + cred.source : null,
    cred.tool !== "" ? "工具 " + cred.tool : null,
    cred.secretRef !== "" ? "证据 " + cred.secretRef : null,
    cred.foundByAgent !== "" ? "by " + cred.foundByAgent : null,
    cred.foundAt !== "" ? formatTimestamp(cred.foundAt) : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

/** 凭据区的标题（有凭据时提示明文直显的风险）。 */
export function credentialsHeading(count: number): string {
  return "凭据 · " + count + (count > 0 ? "（明文直显，注意屏幕分享/录屏）" : "");
}

/** 凭据区的空态。 */
export const EMPTY_CREDENTIALS_MESSAGE =
  "暂无凭据（拿到口令/密钥/Hash 后用 redteam_credential_add 落库，秒级可复用）";

/** 访问会话区的标题。 */
export function accessHeading(count: number): string {
  return "已获得访问会话 · " + count;
}

/** 访问会话密码区的空态。 */
export const EMPTY_ACCESS_MESSAGE = "暂无";

/** 子页签。 */
export type FindingsSubTab = "vulns" | "files" | "creds" | "access";

/** 子页签按钮的文案（原实现是 `label + ' ' + n`）。 */
export function subTabLabel(label: string, count: number): string {
  return label + " " + count;
}

/** 子页签按钮的 className。 */
export function subTabClass(key: FindingsSubTab, current: FindingsSubTab): string {
  return "rt-subtab" + (key === current ? " on" : "");
}

/** 子页签按钮的 aria-label（原实现 `label + '（' + n + '）'`）。 */
export function subTabAriaLabel(label: string, count: number): string {
  return label + "（" + count + "）";
}

/** 攻击文件子页签的说明文案（含孤儿文件提醒）。 */
export function attackFilesHint(orphanCount: number): string {
  return "攻击文件按靶标目录组织（原「攻击文件」页签）；每条漏洞的关联文件也能在该漏洞详情里直接看到。"
    + (orphanCount > 0
      ? " 目前有 " + orphanCount + " 个文件没挂 vuln_id，建议补上以便与漏洞对应。"
      : "");
}

/** 漏洞详情里「拿到什么」的缺失说明。 */
export const MISSING_GAINED_MESSAGE =
  "未记录 —— 拿到权限/成果后请用 redteam_vuln_update 补 gained（例：服务器权限、内网隧道、后台管理员账号）";

/** 漏洞详情里「攻击文件」的缺失说明。 */
export const MISSING_ATTACK_FILE_MESSAGE =
  "（无）用 redteam_attack_file_add 把这条漏洞打通的脚本/马/EXP 归档，并带上 vuln_id";

/** 漏洞详情里的状态操作（原实现的四个按钮）。 */
export interface StatusAction {
  readonly status: VulnStatus;
  readonly label: string;
}

/** 四个状态按钮（顺序即界面顺序）。 */
export const STATUS_ACTIONS: readonly StatusAction[] = Object.freeze([
  { status: "confirmed", label: "确认" },
  { status: "exploited", label: "已利用" },
  { status: "false-positive", label: "误报" },
  { status: "fixed", label: "已修复" },
]);

/** 更新状态成功后的提示（原实现 `已更新为「X」`）。 */
export function statusUpdatedMessage(next: VulnStatus): string {
  return "已更新为「" + (STATUS_LABEL[next] ?? next) + "」";
}

/** 更新状态的请求载荷（`patch.status`）。 */
export function updateVulnPatch(next: VulnStatus): { readonly status: VulnStatus } {
  return { status: next };
}

/**
 * 证据区的判定：这段文本看起来是不是原始 HTTP 报文。
 *
 * 原实现：`/^(GET|POST|...|HTTP\/)/m` 或 `/\n[A-Za-z-]+: /`。
 * 前者匹配「首行是请求行或状态行」，后者匹配「任意行的头字段」。
 * 判错的后果是：把报文明文塞进 `<pre>` 而不是按行着色，人眼很难扫读。
 */
export function looksLikeHttp(text: string): boolean {
  const value = text.trim();
  if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(value)) return true;
  return /\n[A-Za-z-]+: /.test(value);
}

/** 证据是否缺失（红线：没有证据的漏洞不进报告）。 */
export function evidenceMissing(vuln: VulnItem): boolean {
  return vuln.evidence.trim() === "" && vuln.httpEvidence.length === 0;
}

/** 高亮行的类别。 */
export type HttpLineKind = "req" | "res" | "header" | null;

/**
 * 给一行 HTTP 报文着色。
 *
 * 原实现逐行判定：
 * - 第 0 行以方法名开头 → 请求行（`rt-hl-req`）；
 * - 第 0 行以 `HTTP/` 开头 → 状态行（`rt-hl-res`）；
 * - 任意行 `Name:` 且名字是 host/cookie/authorization/content-type → 请求头高亮。
 *
 * 「第 0 行」是硬条件 —— 报文中间的正文里出现 `GET xxx` 不该被着色。
 */
export function httpLineKind(line: string, index: number): HttpLineKind {
  if (index === 0) {
    if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(line)) return "req";
    if (/^HTTP\//.test(line)) return "res";
  }
  if (/^[A-Za-z0-9-]+:/.test(line)) {
    const name = line.split(":")[0];
    if (name === undefined) return null;
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "cookie" || lower === "authorization" || lower === "content-type") {
      return "header";
    }
  }
  return null;
}

/**
 * 行类别 → className。
 *
 * 请求行与请求头（host/cookie/authorization/content-type）共用 `rt-hl-req`，
 * 状态行用 `rt-hl-res`；其余不加类。`compact` 只影响外层 `<pre>` 的类
 * （见 `httpBlockClass`），单行不加额外类。
 */
export function httpLineClass(kind: HttpLineKind): string | undefined {
  if (kind === "req" || kind === "header") return "rt-hl-req";
  if (kind === "res") return "rt-hl-res";
  return undefined;
}

/** `<pre>` 的 className（紧凑模式给 `rt-evi-body req`，否则 `rt-evi-body`）。 */
export function httpBlockClass(compact: boolean): string {
  return compact ? "rt-evi-body req" : "rt-evi-body";
}

/**
 * 把报文切成行。
 *
 * 空行渲染成 `\u00a0`：`<div></div>` 在部分浏览器里高度塌成 0，
 * 报文里的空行（头/体分隔）就会消失，看起来像报文被截断了。
 */
export function httpLinesOf(text: string): readonly string[] {
  if (text === "") return [];
  return text.split(/\r?\n/).map((line) => (line === "" ? "\u00a0" : line));
}

/** 一条证据的标题（`方法 状态码`）。 */
export function evidenceHeadLabel(ev: HttpEvidence): string {
  return (ev.method !== "" ? ev.method : "") + " " + (ev.status === null ? "" : String(ev.status));
}
