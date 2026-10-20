/**
 * 资产测绘页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `AssetsTab`（436 行）把 5 件事揉在同一个组件里：
 *
 * 1. **12 个 `useState`** 的过滤条件（`cidr` / `q` / `qApplied` / `service` /
 *    `port` / `prov` / `testStatus` / `priority` / `scope` / `assetState` /
 *    `sort` / `showAll`），其中 `q` 与 `qApplied` 是**两个**值 —— 输入框
 *    自由输入、回车/点搜索才生效。
 * 2. 4 种视图（列表 / 发现时间 / 域名 / Web）+ 一个内嵌的「当前测试」。
 * 3. 结论行的**六种点击语义**（互斥 + 组合键 `abandoned,blocked`）。
 * 4. 三张子表的响应解析（`domains` / `web` / `discoveryTimeline`）。
 * 5. 端口与指纹的**文本收敛**（最多 3 个端口 + `+N`、指纹截 30 字符）。
 *
 * 这里把 1–4 全部搬出来，逐条钉死；`assets-tab.ts` 只留排版。
 *
 * ## 一个容易迁错的语义：结论行的互斥
 *
 * ```js
 * const toggleTest = (v) => { setTestStatus(cur => cur === v ? '' : v); setAssetState('') }
 * ```
 *
 * 「待测 / 测试中 / 已测 / 放弃」四个键**共用** `testStatus` 一个字段（后者是
 * `'abandoned,blocked'` 这样一个**逗号组合值**），且点它们时**必然清掉**
 * `assetState`；而「存活」键只动 `assetState` 且清掉 `testStatus`；
 * 「全部」键清掉除 `sort` 之外的一切。四个分支的清除范围各不相同，
 * 迁漏一个就会出现「点全部之后筛选没撤干净」。
 */

import { err, ok, type Result } from "../../shared/result.js";
import type { ApiClient, ApiRequest, ApiResponse } from "./api.js";
import { TEST_STATUS_LABEL, TEST_STATUS_ORDER } from "./label.js";

/* ══════════════════════════════════════════════════════════════ 窄化原语 */

/** 从不可信值读字符串。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 从不可信值读对象（数组与 null 都算没有）。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从不可信值读数组（其它形态 → 空数组）。 */
function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 从不可信值读计数（非有限或负数 → 0）。 */
function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 从不可信值读可空字符串（`""` → `null`）。 */
function nullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 从不可信值读外网/内网归属。 */
export type AssetScope = "internal" | "external";

/** 归一归属：除 `internal` 之外一律算外网（与原实现的二选一一致）。 */
export function scopeOf(value: unknown): AssetScope {
  return value === "internal" ? "internal" : "external";
}

/** 归属徽章的短标签（列表里占一列，只能是单字）。 */
export function scopeShortLabel(scope: AssetScope): string {
  return scope === "internal" ? "内" : "外";
}

/** 归属徽章的完整标签。 */
export function scopeLongLabel(scope: AssetScope): string {
  return scope === "internal" ? "内网资产" : "外网资产";
}

/* ══════════════════════════════════════════════════════════════ C 段 */

/** 一条 C 段（`snapshot.segments` 的一项）。 */
export interface AssetSegment {
  readonly cidr: string;
  readonly org: string;
  readonly assets: number;
  readonly live: number;
  readonly openPorts: number;
  readonly passivePorts: number;
  readonly activePorts: number;
  readonly scope: AssetScope;
}

/** 解析 `snapshot.segments`。 */
export function segmentsOf(response: unknown): readonly AssetSegment[] {
  return arrayOf(recordOf(response)["segments"])
    .map((raw) => {
      const entry = recordOf(raw);
      return {
        cidr: text(entry["cidr"]),
        org: text(entry["org"]),
        assets: countOrZero(entry["assets"]),
        live: countOrZero(entry["live"]),
        openPorts: countOrZero(entry["open_ports"]) || countOrZero(entry["openPorts"]),
        passivePorts: countOrZero(entry["passive_ports"]) || countOrZero(entry["passivePorts"]),
        activePorts: countOrZero(entry["active_ports"]) || countOrZero(entry["activePorts"]),
        scope: scopeOf(entry["scope"]),
      };
    })
    // 没有 cidr 的段无法筛选（点它会发一个空 cidr 的请求），丢掉。
    .filter((segment) => segment.cidr !== "");
}

/** C 段按内外网分组（顺序保持输入顺序 —— 后端已按资产数排过）。 */
export interface SegmentGroups {
  readonly external: readonly AssetSegment[];
  readonly internal: readonly AssetSegment[];
}

/** 分组。 */
export function groupSegments(segments: readonly AssetSegment[]): SegmentGroups {
  return {
    external: segments.filter((segment) => segment.scope !== "internal"),
    internal: segments.filter((segment) => segment.scope === "internal"),
  };
}

/** 一组 C 段的资产总数（侧栏组标题右侧的那个数字）。 */
export function totalAssetsOf(segments: readonly AssetSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.assets, 0);
}

/**
 * C 段的悬浮提示。
 *
 * 原实现：`(s.org || '未知归属') + ' · 存活 ' + live + '/' + assets + ' 台'`
 * —— 端口数不占位，归属与存活都塞进 title。
 */
export function segmentTitle(segment: AssetSegment): string {
  const org = segment.org !== "" ? segment.org : "未知归属";
  return org + " · 存活 " + segment.live + "/" + segment.assets + " 台";
}

/* ══════════════════════════════════════════════════════════════ 资产列表 */

/** 一个端口。 */
export interface AssetPort {
  readonly port: number;
  readonly proto: string;
  readonly state: string;
  readonly provenance: string;
  readonly url: string | null;
  readonly title: string;
  readonly service: string;
  readonly product: string;
  readonly version: string;
}

/** 一个指纹。 */
export interface AssetFingerprint {
  readonly category: string;
  readonly vendor: string;
  readonly product: string;
  readonly version: string;
  readonly evidence: string;
  readonly provenance: string;
}

/** 一个观测（采集溯源）。 */
export interface AssetObservation {
  readonly attr: string;
  readonly value: string;
  readonly provenance: string;
  readonly tool: string;
  readonly collectedAt: string;
}

/** 一个名字（域名/主机名）。 */
export interface AssetName {
  readonly name: string;
}

/** 资产列表项（`op: assets` 的一行）。 */
export interface AssetItem {
  readonly id: number;
  readonly ip: string;
  readonly segmentCidr: string;
  readonly scope: AssetScope;
  readonly state: string;
  readonly priority: string;
  readonly potential: string;
  readonly assessReason: string;
  readonly assessedAt: string;
  readonly testStatus: string;
  readonly blockedCount: number;
  readonly testSurface: string;
  readonly testNotes: string;
  readonly testUpdatedAt: string;
  readonly testUpdatedBy: string;
  readonly discoveredAt: string;
  readonly lastSeen: string;
  readonly firstSeen: string;
  readonly passive: number;
  readonly active: number;
  readonly ports: readonly AssetPort[];
  readonly fingerprints: readonly AssetFingerprint[];
  readonly names: readonly AssetName[];
  readonly observations: readonly AssetObservation[];
}

/** 解析一个端口。 */
function portOf(raw: unknown): AssetPort {
  const entry = recordOf(raw);
  return {
    port: countOrZero(entry["port"]),
    proto: text(entry["proto"]) || "tcp",
    state: text(entry["state"]),
    provenance: text(entry["provenance"]),
    url: nullableText(entry["url"]),
    title: text(entry["title"]),
    service: text(entry["service"]),
    product: text(entry["product"]),
    version: text(entry["version"]),
  };
}

/** 解析一个指纹。 */
function fingerprintOf(raw: unknown): AssetFingerprint {
  const entry = recordOf(raw);
  return {
    category: text(entry["category"]),
    vendor: text(entry["vendor"]),
    product: text(entry["product"]),
    version: text(entry["version"]),
    evidence: text(entry["evidence"]),
    provenance: text(entry["provenance"]),
  };
}

/** 解析一个观测。 */
function observationOf(raw: unknown): AssetObservation {
  const entry = recordOf(raw);
  return {
    attr: text(entry["attr"]),
    value: text(entry["value"]),
    provenance: text(entry["provenance"]),
    tool: text(entry["tool"]),
    collectedAt: text(entry["collected_at"]) || text(entry["collectedAt"]),
  };
}

/** 解析一个资产。 */
export function assetOf(raw: unknown): AssetItem {
  const entry = recordOf(raw);
  return {
    id: countOrZero(entry["id"]),
    ip: text(entry["ip"]),
    segmentCidr: text(entry["segment_cidr"]) || text(entry["segmentCidr"]),
    scope: scopeOf(entry["scope"]),
    state: text(entry["state"]),
    priority: text(entry["priority"]),
    potential: text(entry["potential"]),
    assessReason: text(entry["assess_reason"]) || text(entry["assessReason"]),
    assessedAt: text(entry["assessed_at"]) || text(entry["assessedAt"]),
    testStatus: text(entry["test_status"]) || text(entry["testStatus"]),
    blockedCount: countOrZero(entry["blocked_count"]) || countOrZero(entry["blockedCount"]),
    testSurface: text(entry["test_surface"]) || text(entry["testSurface"]),
    testNotes: text(entry["test_notes"]) || text(entry["testNotes"]),
    testUpdatedAt: text(entry["test_updated_at"]) || text(entry["testUpdatedAt"]),
    testUpdatedBy: text(entry["test_updated_by"]) || text(entry["testUpdatedBy"]),
    discoveredAt: text(entry["discovered_at"]) || text(entry["discoveredAt"]),
    lastSeen: text(entry["last_seen"]) || text(entry["lastSeen"]),
    firstSeen: text(entry["first_seen"]) || text(entry["firstSeen"]),
    passive: countOrZero(entry["passive"]),
    active: countOrZero(entry["active"]),
    ports: arrayOf(entry["ports"]).map(portOf),
    fingerprints: arrayOf(entry["fingerprints"]).map(fingerprintOf),
    names: arrayOf(entry["names"]).map((name) => ({ name: text(recordOf(name)["name"]) })).filter((name) => name.name !== ""),
    observations: arrayOf(entry["observations"]).map(observationOf),
  };
}

/** 资产列表的加载状态。 */
export interface AssetListState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly total: number;
  readonly items: readonly AssetItem[];
}

/** 空列表状态（未加载 / 无数据）。 */
export const EMPTY_ASSET_LIST: AssetListState = Object.freeze({
  loading: false,
  error: null,
  total: 0,
  items: [],
});

/** 解析 `op: assets` 的响应。 */
export function assetListOf(response: unknown): AssetListState {
  const body = recordOf(response);
  return {
    loading: false,
    error: null,
    total: countOrZero(body["total"]),
    items: arrayOf(body["items"]).map(assetOf),
  };
}

/** 解析 `op: asset` 的响应（单台详情）。 */
export function assetDetailOf(response: unknown): AssetItem | null {
  const body = recordOf(response);
  if (body["ok"] === false) return null;
  const asset = body["asset"];
  if (typeof asset !== "object" || asset === null) return null;
  const parsed = assetOf(asset);
  return parsed.id > 0 ? parsed : null;
}

/**
 * 取要展开的详情。
 *
 * 原实现：`detail && detail.id === it.id ? detail : null` ——
 * 详情响应回来得比切换慢时，**不能**把上一台的详情显示在下一台下面。
 */
export function detailFor(item: AssetItem, detail: AssetItem | null): AssetItem | null {
  return detail !== null && detail.id === item.id ? detail : null;
}

/* ══════════════════════════════════════════════════════════════ 过滤 */

/** 排序方式。 */
export type AssetSort = "priority" | "todo" | "discovered" | "ports" | "ip";

/** 排序选项（顺序即下拉框顺序）。 */
export const SORT_OPTIONS: readonly { readonly value: AssetSort; readonly label: string }[] = Object.freeze([
  { value: "priority", label: "排序：易打性优先" },
  { value: "todo", label: "排序：待测优先" },
  { value: "discovered", label: "排序：最近发现优先" },
  { value: "ports", label: "排序：端口多优先" },
  { value: "ip", label: "排序：按 IP" },
]);

/** 归属筛选选项。 */
export const SCOPE_OPTIONS: readonly { readonly value: "" | AssetScope; readonly label: string }[] = Object.freeze([
  { value: "", label: "内外网不限" },
  { value: "external", label: "仅外网资产" },
  { value: "internal", label: "仅内网资产" },
]);

/** 端口来源筛选选项。 */
export const PROVENANCE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: "", label: "来源不限" },
  { value: "passive", label: "仅被动" },
  { value: "active", label: "仅主动" },
]);

/** 易打性筛选选项。 */
export const PRIORITY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: "", label: "易打性不限" },
  { value: "high", label: "易打（高）" },
  { value: "medium", label: "一般（中）" },
  { value: "low", label: "难打（低）" },
]);

/** 测试状态筛选选项（由共享标签表派生，顺序即后端枚举顺序）。 */
export const TEST_STATUS_OPTIONS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: "", label: "测试状态不限" },
  ...TEST_STATUS_ORDER.map((code) => ({
    value: code,
    label: TEST_STATUS_LABEL[code as keyof typeof TEST_STATUS_LABEL] ?? code,
  })),
]);

/**
 * 测试状态筛选里的**组合值**：结论行的「放弃」= 已放弃 + 被封禁。
 *
 * 它是唯一一个逗号组合，后端按 `IN` 拆开处理（见 store 的 `listAssets`）。
 */
export const GIVEUP_STATUS_COMBINED = "abandoned,blocked";

/** 过滤条件。 */
export interface AssetFilter {
  /** C 段（`null` = 全部）。 */
  readonly cidr: string | null;
  /** **已生效**的搜索词（回车/点搜索后）。 */
  readonly query: string;
  readonly service: string;
  readonly port: string;
  readonly provenance: string;
  readonly testStatus: string;
  readonly priority: string;
  readonly scope: "" | AssetScope;
  /** 存活状态（`live` / 空）。 */
  readonly state: string;
  readonly sort: AssetSort;
}

/** 默认过滤：全部资产、易打性优先。 */
export const DEFAULT_ASSET_FILTER: AssetFilter = Object.freeze({
  cidr: null,
  query: "",
  service: "",
  port: "",
  provenance: "",
  testStatus: "",
  priority: "",
  scope: "",
  state: "",
  sort: "priority",
});

/**
 * 是否有任何筛选生效（「全部」结论键的高亮判定）。
 *
 * 原实现：`!testStatus && !priority && !scope && !prov && !assetState && !cidr`
 * —— **不含** `query` / `service` / `port`。这不是笔误：搜索与服务/端口是
 * 「查」而不是「筛家底」，把它们算进「已筛选」会让「全部」键在纯搜索时
 * 也高亮，看起来像「家底只剩搜索命中的那几台」。
 */
export function hasConclusionFilter(filter: AssetFilter): boolean {
  return filter.testStatus !== ""
    || filter.priority !== ""
    || filter.scope !== ""
    || filter.provenance !== ""
    || filter.state !== ""
    || filter.cidr !== null;
}

/** 构造 `op: assets` 的请求（空串视为不过滤）。 */
export function assetsRequest(engagement: string, filter: AssetFilter): ApiRequest {
  return {
    op: "assets",
    engagement,
    cidr: filter.cidr !== null && filter.cidr !== "" ? filter.cidr : undefined,
    q: filter.query !== "" ? filter.query : undefined,
    service: filter.service !== "" ? filter.service : undefined,
    port: filter.port !== "" ? filter.port : undefined,
    provenance: filter.provenance !== "" ? filter.provenance : undefined,
    test_status: filter.testStatus !== "" ? filter.testStatus : undefined,
    priority: filter.priority !== "" ? filter.priority : undefined,
    scope: filter.scope !== "" ? filter.scope : undefined,
    state: filter.state !== "" ? filter.state : undefined,
    sort: filter.sort,
    limit: 400,
  };
}

/** 结论行的键。 */
export type ConclusionKey = "all" | "live" | "untested" | "testing" | "tested" | "giveup";

/**
 * 点击结论行的**新过滤条件**。
 *
 * 四个分支的清除范围各不相同（原实现逐行不同），见文件头注释：
 * - `all`：清掉 everything（除 sort）
 * - `live`：只切 `state`，并清掉 `testStatus`
 * - `untested` / `testing` / `tested`：切 `testStatus`，并清掉 `state`
 * - `giveup`：`testStatus` 设为组合值 `abandoned,blocked`，并清掉 `state`
 *
 * 切换语义是「再点一次取消」：值已经等于目标时清成空串。
 */
export function applyConclusion(filter: AssetFilter, key: ConclusionKey): AssetFilter {
  switch (key) {
    case "all":
      return {
        ...filter,
        cidr: null,
        testStatus: "",
        priority: "",
        scope: "",
        provenance: "",
        state: "",
      };
    case "live":
      return { ...filter, state: filter.state === "live" ? "" : "live", testStatus: "" };
    case "untested":
      return { ...filter, testStatus: filter.testStatus === "untested" ? "" : "untested", state: "" };
    case "testing":
      return { ...filter, testStatus: filter.testStatus === "testing" ? "" : "testing", state: "" };
    case "tested":
      return { ...filter, testStatus: filter.testStatus === "tested" ? "" : "tested", state: "" };
    case "giveup":
      return {
        ...filter,
        testStatus: filter.testStatus === GIVEUP_STATUS_COMBINED ? "" : GIVEUP_STATUS_COMBINED,
        state: "",
      };
  }
}

/** 结论行高亮判定（与 `applyConclusion` 的分支一一对应）。 */
export function isConclusionActive(filter: AssetFilter, key: ConclusionKey): boolean {
  switch (key) {
    case "all":
      return !hasConclusionFilter(filter);
    case "live":
      return filter.state === "live";
    case "untested":
      return filter.testStatus === "untested";
    case "testing":
      return filter.testStatus === "testing";
    case "tested":
      return filter.testStatus === "tested";
    case "giveup":
      return filter.testStatus === GIVEUP_STATUS_COMBINED;
  }
}

/** 结论行上的计数来源（`snapshot.stats` + `snapshot.tests`）。 */
export interface ConclusionStats {
  readonly assets: number;
  readonly liveAssets: number;
  readonly untested: number;
  readonly testing: number;
  readonly tested: number;
  readonly abandoned: number;
  readonly blocked: number;
}

/** 从快照读计数。 */
export function conclusionStatsOf(snapshot: unknown): ConclusionStats {
  const body = recordOf(snapshot);
  const stats = recordOf(body["stats"]);
  const tests = recordOf(body["tests"]);
  return {
    assets: countOrZero(stats["assets"]),
    liveAssets: countOrZero(stats["liveAssets"]) || countOrZero(stats["live_assets"]),
    untested: countOrZero(tests["untested"]),
    testing: countOrZero(tests["testing"]),
    tested: countOrZero(tests["tested"]),
    abandoned: countOrZero(tests["abandoned"]),
    blocked: countOrZero(tests["blocked"]),
  };
}

/** 一条结论项（渲染层直接 map）。 */
export interface ConclusionItem {
  readonly key: ConclusionKey;
  readonly label: string;
  readonly value: number;
  readonly active: boolean;
}

/** 六条结论项（顺序即界面顺序）。 */
export function conclusionItems(stats: ConclusionStats, filter: AssetFilter): readonly ConclusionItem[] {
  return [
    { key: "all", label: "台资产", value: stats.assets, active: isConclusionActive(filter, "all") },
    { key: "live", label: "存活", value: stats.liveAssets, active: isConclusionActive(filter, "live") },
    { key: "untested", label: "待测", value: stats.untested, active: isConclusionActive(filter, "untested") },
    { key: "testing", label: "测试中", value: stats.testing, active: isConclusionActive(filter, "testing") },
    { key: "tested", label: "已测", value: stats.tested, active: isConclusionActive(filter, "tested") },
    {
      key: "giveup",
      label: "放弃",
      // 「放弃」是两类之和：已放弃 + 被封禁（后者往往是「被迫放弃」）。
      value: stats.abandoned + stats.blocked,
      active: isConclusionActive(filter, "giveup"),
    },
  ];
}

/* ══════════════════════════════════════════════════════════════ 列表行文本 */

/** 只取状态为 open 的端口。 */
export function openPortsOf(item: AssetItem): readonly AssetPort[] {
  return item.ports.filter((port) => port.state === "open");
}

/** 端口的短标签：`443/https`（无服务名时只有端口）。 */
export function portLabel(port: AssetPort): string {
  return String(port.port) + (port.service !== "" ? "/" + port.service : "");
}

/** 端口列的文本（含 `+N` 折叠）。 */
export interface PortSummary {
  /** 列表里显示的文本（如 `22/ssh, 80/http +2`）。 */
  readonly shown: string;
  /** 悬浮提示里的**完整**列表（如 `22/ssh, 80/http, 443/https, 8080/http`）。 */
  readonly full: string;
}

/** 最多列 3 个端口，其余用 `+N`。 */
export const MAX_SHOWN_PORTS = 3;

/** 收敛端口列文本。 */
export function portSummary(ports: readonly AssetPort[]): PortSummary {
  const open = ports.filter((port) => port.state === "open");
  const labels = open.map(portLabel);
  const full = labels.length > 0 ? labels.join(", ") : "—";
  const shownLabels = labels.slice(0, MAX_SHOWN_PORTS).join(", ");
  const hidden = labels.length > MAX_SHOWN_PORTS ? " +" + (labels.length - MAX_SHOWN_PORTS) : "";
  return { shown: (shownLabels !== "" ? shownLabels : "—") + hidden, full };
}

/** 指纹列里单个指纹的文本：`厂商 产品 版本`（缺项自动跳过）。 */
export function fingerprintLabel(fingerprint: AssetFingerprint): string {
  return [fingerprint.vendor, fingerprint.product, fingerprint.version]
    .filter((part) => part !== "")
    .join(" ");
}

/** 指纹列最多显示的字符数（超出截断并加省略号）。 */
export const MAX_FINGERPRINT_CHARS = 30;

/** 指纹列的文本。 */
export interface FingerprintSummary {
  readonly shown: string;
  readonly full: string;
}

/** 收敛指纹列文本。 */
export function fingerprintSummary(fingerprints: readonly AssetFingerprint[]): FingerprintSummary {
  const labels = fingerprints.map(fingerprintLabel).filter((label) => label !== "");
  const full = labels.length > 0 ? labels.join(" / ") : "—";
  return {
    shown: full.length > MAX_FINGERPRINT_CHARS ? full.slice(0, MAX_FINGERPRINT_CHARS) + "…" : full,
    full,
  };
}

/** 详情里端口的服务描述：`服务 产品 版本`，全空时「未知服务」。 */
export function portServiceText(port: AssetPort): string {
  const joined = [port.service, port.product, port.version].filter((part) => part !== "").join(" ");
  return joined !== "" ? joined : "未知服务";
}

/** 详情里指纹的描述：`厂商 产品 版本（依据）`。 */
export function fingerprintDetailText(fingerprint: AssetFingerprint): string {
  const head = fingerprintLabel(fingerprint);
  return fingerprint.evidence !== ""
    ? head + "（" + fingerprint.evidence + "）"
    : head;
}

/** 详情里观测的文本：`值 · 工具 · 时间`。 */
export function observationText(observation: AssetObservation, timeText: string): string {
  return observation.value + " · " + (observation.tool !== "" ? observation.tool : "未知工具") + " · " + timeText;
}

/** 观测最多列 8 条（原实现的 `slice(0, 8)`）。 */
export const MAX_OBSERVATIONS = 8;

/** 测试记录按行拆开（去掉空行）。 */
export function noteLinesOf(item: AssetItem): readonly string[] {
  return item.testNotes.split("\n").filter((line) => line !== "");
}

/** 主机名列表的文本（逗号分隔，空 → `—`）。 */
export function namesText(item: AssetItem): string {
  const joined = item.names.map((name) => name.name).join(", ");
  return joined !== "" ? joined : "—";
}

/** 详情里「测试」行的尾部文本：`时间 · 角色`（没测过显示「未测过」）。 */
export function testMetaText(item: AssetItem, timeText: string): string {
  const when = item.testUpdatedAt !== "" ? timeText : "未测过";
  return item.testUpdatedBy !== "" ? when + " · " + item.testUpdatedBy : when;
}

/** 详情里「易打性」行的文本：`预期 · 依据`。 */
export function assessText(item: AssetItem): string {
  const potential = item.potential !== "" ? item.potential : "未评估";
  return item.assessReason !== "" ? potential + " · " + item.assessReason : potential;
}

/** 详情里「攻击面」行的文本。 */
export function surfaceText(item: AssetItem, openPortCount: number): string {
  if (item.testSurface !== "") return item.testSurface;
  return openPortCount > 0 ? "未记录（开放端口见下）" : "无开放端口";
}

/** 详情里「来源」行的文本。 */
export function provenanceText(item: AssetItem): string {
  return "被动端口 " + item.passive + " · 主动端口 " + item.active;
}

/** 详情里「易打性」长篇（展开全部后）：`优先级 · 预期 · 依据（时间）`。 */
export function assessLongText(item: AssetItem, timeText: string): string {
  const priority = item.priority !== "" ? item.priority : "未评估";
  return priority
    + (item.potential !== "" ? " · 预期：" + item.potential : "")
    + (item.assessReason !== "" ? " · 依据：" + item.assessReason : "")
    + (item.assessedAt !== "" ? "（" + timeText + "）" : "");
}

/* ══════════════════════════════════════════════════════════════ 视图 */

/** 资产页的视图。 */
export type AssetViewKind = "list" | "timeline" | "domain" | "web" | "testing";

/** 视图按钮（顺序即界面顺序）。 */
export const VIEW_BUTTONS: readonly { readonly value: AssetViewKind; readonly label: string; readonly title?: string }[] = Object.freeze([
  { value: "list", label: "列表" },
  { value: "timeline", label: "发现时间", title: "按发现时间看资产（什么时候发现、哪天收了多少）" },
  { value: "domain", label: "域名" },
  { value: "web", label: "Web" },
]);

/* ══════════════════════════════════════════════════════════════ 域名维度 */

/** 域名分组里的一台资产。 */
export interface DomainAsset {
  readonly id: number;
  readonly ip: string;
  readonly segment: string;
  readonly state: string;
  readonly names: readonly string[];
}

/** 一个域名分组。 */
export interface DomainGroup {
  readonly domain: string;
  readonly count: number;
  readonly assets: readonly DomainAsset[];
}

/** 解析 `op: domains` 的响应。 */
export function domainGroupsOf(response: unknown): readonly DomainGroup[] {
  return arrayOf(recordOf(response)["items"])
    .map((raw) => {
      const entry = recordOf(raw);
      const domain = text(entry["domain"]);
      const assets = arrayOf(entry["assets"]).map((assetRaw) => {
        const asset = recordOf(assetRaw);
        return {
          id: countOrZero(asset["id"]),
          ip: text(asset["ip"]),
          segment: text(asset["segment"]),
          state: text(asset["state"]),
          names: arrayOf(asset["names"]).filter((name): name is string => typeof name === "string"),
        };
      });
      return { domain, count: countOrZero(entry["count"]) || assets.length, assets };
    })
    .filter((group) => group.domain !== "");
}

/* ══════════════════════════════════════════════════════════════ Web 维度 */

/** Web 资产。 */
export interface WebAsset {
  readonly portId: number;
  readonly port: number;
  readonly url: string;
  readonly title: string;
  readonly ip: string;
  readonly segmentCidr: string;
  readonly service: string;
  readonly product: string;
  readonly version: string;
}

/** 解析 `op: web` 的响应。 */
export function webAssetsOf(response: unknown): readonly WebAsset[] {
  return arrayOf(recordOf(response)["items"])
    .map((raw) => {
      const entry = recordOf(raw);
      return {
        portId: countOrZero(entry["port_id"]) || countOrZero(entry["portId"]),
        port: countOrZero(entry["port"]),
        url: text(entry["url"]),
        title: text(entry["title"]),
        ip: text(entry["ip"]),
        segmentCidr: text(entry["segment_cidr"]) || text(entry["segmentCidr"]),
        service: text(entry["service"]),
        product: text(entry["product"]),
        version: text(entry["version"]),
      };
    })
    .filter((asset) => asset.ip !== "");
}

/** 这些端口按 HTTPS 处理（原实现的白名单，逐字保留）。 */
const HTTPS_PORTS: ReadonlySet<number> = new Set([443, 8443, 9443]);

/** 这些端口是默认端口，URL 里不写端口号。 */
const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);

/**
 * Web 资产的可点击 URL。
 *
 * 原实现：有 `url` 就用它，否则按端口推：
 * `http` + (443/8443/9443 ? `s` : ``) + `://` + ip + (80/443 ? `` : `:port`)
 * —— 端口白名单是硬编码的，这里逐字保留（改成「按证书判断」会改变既有链接）。
 */
export function webAssetUrl(asset: WebAsset): string {
  if (asset.url !== "") return asset.url;
  const scheme = "http" + (HTTPS_PORTS.has(asset.port) ? "s" : "");
  const portPart = DEFAULT_PORTS.has(asset.port) ? "" : ":" + asset.port;
  return scheme + "://" + asset.ip + portPart;
}

/** Web 资产的服务描述（`服务 产品 版本`）。 */
export function webServiceText(asset: WebAsset): string {
  return [asset.service, asset.product, asset.version].filter((part) => part !== "").join(" ");
}

/* ══════════════════════════════════════════════════════════════ 发现时间线 */

/** 按天统计的一行。 */
export interface DiscoveryDay {
  readonly day: string;
  readonly assets: number;
  readonly internal: number;
  readonly external: number;
}

/** 时间线里的一台资产。 */
export interface DiscoveryAsset {
  readonly id: number;
  readonly ip: string;
  readonly scope: AssetScope;
  readonly primaryName: string;
  readonly discoveredAt: string;
  readonly lastSeen: string;
  readonly openPorts: number;
  readonly priority: string;
}

/** 发现时间线的数据。 */
export interface DiscoveryData {
  readonly total: number;
  readonly first: string;
  readonly last: string;
  readonly days: readonly DiscoveryDay[];
  readonly recent: readonly DiscoveryAsset[];
}

/** 解析 `op: discoveryTimeline` 的响应（失败 → `null`）。 */
export function discoveryOf(response: unknown): DiscoveryData | null {
  const body = recordOf(response);
  if (body["ok"] === false) return null;
  // 空响应（`null`）与「还没加载」要分开：前者是失败，后者由 props 的 `null` 表示。
  if (Object.keys(body).length === 0) return null;
  const span = recordOf(body["span"]);
  return {
    total: countOrZero(span["total"]),
    first: text(span["first"]),
    last: text(span["last"]),
    days: arrayOf(body["days"])
      .map((raw) => {
        const entry = recordOf(raw);
        return {
          day: text(entry["day"]),
          assets: countOrZero(entry["assets"]),
          internal: countOrZero(entry["internal"]),
          external: countOrZero(entry["external"]),
        };
      })
      .filter((day) => day.day !== ""),
    recent: arrayOf(body["recent"])
      .map((raw) => {
        const entry = recordOf(raw);
        return {
          id: countOrZero(entry["id"]),
          ip: text(entry["ip"]),
          scope: scopeOf(entry["scope"]),
          primaryName: text(entry["primary_name"]) || text(entry["primaryName"]),
          discoveredAt: text(entry["discovered_at"]) || text(entry["discoveredAt"]),
          lastSeen: text(entry["last_seen"]) || text(entry["lastSeen"]),
          openPorts: countOrZero(entry["open_ports"]) || countOrZero(entry["openPorts"]),
          priority: text(entry["priority"]),
        };
      })
      .filter((asset) => asset.ip !== ""),
  };
}

/**
 * 按天筛选「最近发现的资产」。
 *
 * 原实现：`day === '' || String(a.discovered_at || '').slice(0, 10) === day`
 * —— 比对的是 ISO 串的**前 10 个字符**（`YYYY-MM-DD`），不做时区换算。
 */
export function filterDiscoveryByDay(
  recent: readonly DiscoveryAsset[],
  day: string,
): readonly DiscoveryAsset[] {
  if (day === "") return recent;
  return recent.filter((asset) => asset.discoveredAt.slice(0, 10) === day);
}

/** 时间线的摘要行（`共 N 台 · 最早 … · 最近 …`）。 */
export function discoverySpanText(data: DiscoveryData, firstText: string, lastText: string): string {
  return "共 " + data.total + " 台 · 最早 " + firstText + " · 最近 " + lastText;
}

/** 首页说明（发现时间口径）。 */
export const DISCOVERY_NOTE = "（发现时间 = 第一次进入资产库的时刻；重复采集只刷新\"最近采集\"）";

/* ══════════════════════════════════════════════════════════════ 请求与加载 */

/** 请求 `op: domains`。 */
export function domainsRequest(engagement: string, cidr: string | null): ApiRequest {
  return { op: "domains", engagement, cidr: cidr !== null && cidr !== "" ? cidr : undefined };
}

/** 请求 `op: web`。 */
export function webRequest(engagement: string, cidr: string | null): ApiRequest {
  return { op: "web", engagement, cidr: cidr !== null && cidr !== "" ? cidr : undefined };
}

/** 请求 `op: asset`（单台详情）。 */
export function assetRequest(engagement: string, id: number): ApiRequest {
  return { op: "asset", engagement, id };
}

/** 请求 `op: discoveryTimeline`。 */
export function discoveryRequest(engagement: string): ApiRequest {
  return { op: "discoveryTimeline", engagement, limit: 200 };
}

/** 从响应里取错误文案（非失败 → `null`）。 */
function errorOf(response: unknown, fallback: string): string | null {
  if (response === null || response === undefined) return fallback;
  const body = recordOf(response);
  if (body["ok"] !== false) return null;
  const message = body["error"];
  return typeof message === "string" && message !== "" ? message : fallback;
}

/** 加载资产列表（预期内失败走 Result）。 */
export async function loadAssets(
  api: ApiClient,
  engagement: string,
  filter: AssetFilter,
): Promise<Result<AssetListState, string>> {
  const response = await api.raw(assetsRequest(engagement, filter));
  const error = errorOf(response, "查询失败");
  if (error !== null) return err(error);
  return ok(assetListOf(response));
}

/** 加载域名维度。 */
export async function loadDomains(
  api: ApiClient,
  engagement: string,
  cidr: string | null,
): Promise<Result<readonly DomainGroup[], string>> {
  const response = await api.raw(domainsRequest(engagement, cidr));
  const error = errorOf(response, "读取域名失败");
  if (error !== null) return err(error);
  return ok(domainGroupsOf(response));
}

/** 加载 Web 维度。 */
export async function loadWebAssets(
  api: ApiClient,
  engagement: string,
  cidr: string | null,
): Promise<Result<readonly WebAsset[], string>> {
  const response = await api.raw(webRequest(engagement, cidr));
  const error = errorOf(response, "读取 Web 资产失败");
  if (error !== null) return err(error);
  return ok(webAssetsOf(response));
}

/** 加载单台资产详情。 */
export async function loadAssetDetail(
  api: ApiClient,
  engagement: string,
  id: number,
): Promise<Result<AssetItem, string>> {
  const response = await api.raw(assetRequest(engagement, id));
  const error = errorOf(response, "读取资产详情失败");
  if (error !== null) return err(error);
  const detail = assetDetailOf(response);
  return detail === null ? err("资产不存在或已删除") : ok(detail);
}

/** 加载发现时间线。 */
export async function loadDiscovery(
  api: ApiClient,
  engagement: string,
): Promise<Result<DiscoveryData, string>> {
  const response = await api.raw(discoveryRequest(engagement));
  const error = errorOf(response, "加载失败");
  if (error !== null) return err(error);
  const data = discoveryOf(response);
  return data === null ? err("加载失败") : ok(data);
}

/** 资产列表的空态文案。 */
export function listEmptyText(): string {
  return "没有匹配的资产";
}

/** 域名维度的空态文案。 */
export function domainEmptyText(cidr: string | null): string {
  return cidr !== null && cidr !== ""
    ? "该 C 段下暂无域名（切换到「全部 C 段」看全量）"
    : "暂无域名数据（信息收集阶段会写入域名）";
}

/** Web 维度的空态文案。 */
export function webEmptyText(cidr: string | null): string {
  return cidr !== null && cidr !== ""
    ? "该 C 段下暂无 Web 资产"
    : "暂无 Web 资产（HTTP 探测后会写入 URL 与标题）";
}

/** 侧栏两个固定项（「全部 C 段」「当前测试」）之外的分组键。 */
export function sideGroupKey(scope: AssetScope): string {
  return "scope:" + scope;
}

/** 未选靶标时的提示文案。 */
export const NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看资产测绘。";

/** 类型收窄辅助：把 `ApiResponse` 当作未知输入喂给解析函数。 */
export type AssetResponse = ApiResponse;
