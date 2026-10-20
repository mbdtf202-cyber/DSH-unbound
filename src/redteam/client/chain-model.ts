/**
 * 攻击链页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `ChainTab` 的 205 行里，约 120 行是**五个阶段的排版**，而真正需要
 * 被测试锁住的是这几条规则：
 *
 * 1. **阶段编号来自数组顺序，不是 `ordinal` 字段**：原实现用
 *    `CIRCLED[i] || ('0' + (i + 1))` —— 第六个阶段起退化成 `06`、`07`。
 *    这不是缺陷，是「只设计了五个圈号」的诚实降级。
 * 2. **累计分取服务端值**：`st.cumulative` 直接显示，不在前端累加 ——
 *    前端的漏洞状态与后端可能不一致，用本地累加会让总分与得分页对不上。
 * 3. **边界突破阶段的「只在自己 VPS 上」的通道不算突破**：`self-only`
 *    必须单独提示，否则用户会以为「有 socks5 就算打进内网了」。
 *
 * ## 一个容易漏的空态
 *
 * `data !== null && stages.length === 0` 与 `data === null` 是**两种不同**状态：
 * 前者是「读到了，但还没有得分记录」，后者是「还没读回来」。
 * 合并会让首次加载时闪一下「还没有得分记录」。
 */

import { formatTimestamp, isFailure } from "./helpers.js";

/** 五阶段的 code。 */
export type StageCode = "recon" | "internet" | "boundary" | "internal" | "target";

/** 一次得分命中。 */
export interface ChainHit {
  readonly id: number;
  readonly pointName: string;
  readonly points: number;
  readonly counted: boolean;
  readonly capped: boolean;
  readonly cappedReason: string;
  readonly nthOfPoint: number;
  readonly target: string;
  readonly assetIp: string;
  readonly vulnTitle: string;
  readonly vulnCve: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly evidence: string;
  /** 关联的攻击步骤（可能缺失）。 */
  readonly actionTitle: string;
  readonly actionInferred: boolean;
  readonly hasAction: boolean;
}

/** 阶段涉及的资产。 */
export interface ChainAsset {
  readonly id: number;
  readonly ip: string;
  readonly scope: string;
  readonly segmentCidr: string;
  readonly openPorts: number;
  readonly vulns: number;
  readonly priority: string;
  readonly points: number;
  readonly hits: number;
}

/** 阶段涉及的隧道。 */
export interface ChainTunnel {
  readonly id: number;
  readonly kind: string;
  readonly listen: string;
  readonly reach: string;
  readonly status: string;
}

/** 一个阶段。 */
export interface ChainStage {
  readonly code: string;
  readonly name: string;
  readonly subtitle: string;
  readonly goal: string;
  readonly color: string;
  readonly points: number;
  readonly cumulative: number;
  readonly hits: number;
  readonly assetCount: number;
  readonly assets: readonly ChainAsset[];
  readonly items: readonly ChainHit[];
  readonly tunnels: readonly ChainTunnel[];
  /** 只在自己 VPS/自建服务器上的通道（不算突破）。 */
  readonly tunnelsSelfOnly: readonly ChainTunnel[];
  readonly transition: string;
}

/** 总分摘要。 */
export interface ChainSummary {
  readonly points: number;
}

/** 一次攻击链读取的结果。 */
export interface ChainData {
  readonly stages: readonly ChainStage[];
  readonly summary: ChainSummary | null;
}

/** 两个视图。 */
export type ChainView = "A" | "B";

/** 空态文案。 */
export const EMPTY_CHAIN_MESSAGE = "还没有得分记录。拿到成果后用 redteam_score_hit 记分，这条链才会长出来。";

/** 阶段目标说明条（工具栏上的提示）。 */
export const CHAIN_FLOW_LABEL = "信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限";

/** 圈号（只有五个；第六个起退化成两位数字）。 */
export const CIRCLED: readonly string[] = Object.freeze(["①", "②", "③", "④", "⑤", "⑥"]);

/** 阶段序号标签（`CIRCLED[i]` 或零填充）。 */
export function stageNumber(index: number): string {
  return CIRCLED[index] ?? "0" + String(index + 1);
}

/**
 * 横向视图的阶段序号（与竖向不同：横向只显示阿拉伯数字）。
 *
 * 原实现：竖向用圈号、横向用 `String(i + 1)` —— 横向列窄，圈号会挤。
 */
export function stageNumberCompact(index: number): string {
  return String(index + 1);
}

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

/** 解析一次得分命中。 */
export function chainHitOf(raw: unknown): ChainHit | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  const action = asRecord(item["action"]);
  const hasAction = Object.keys(action).length > 0;
  return {
    id,
    pointName: text(item["point_name"]),
    points: numberOf(item["points"]),
    // 缺省算「计分」：`counted !== false` —— 老 host 不给这个字段。
    counted: item["counted"] !== false,
    capped: item["capped"] === true,
    cappedReason: text(item["capped_reason"]),
    nthOfPoint: numberOf(item["nth_of_point"]),
    target: text(item["target"]),
    assetIp: text(item["asset_ip"]),
    vulnTitle: text(item["vuln_title"]),
    vulnCve: text(item["vuln_cve"]),
    recordedAt: text(item["recorded_at"]),
    recordedBy: text(item["recorded_by"]),
    evidence: text(item["evidence"]),
    actionTitle: text(action["title"]),
    actionInferred: item["action_inferred"] === true,
    hasAction,
  };
}

/** 解析一个资产。 */
export function chainAssetOf(raw: unknown): ChainAsset | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    ip: text(item["ip"]),
    scope: text(item["scope"]),
    segmentCidr: text(item["segment_cidr"]),
    openPorts: numberOf(item["open_ports"]),
    vulns: numberOf(item["vulns"]),
    priority: text(item["priority"]),
    points: numberOf(item["points"]),
    hits: numberOf(item["hits"]),
  };
}

/** 解析一条隧道。 */
export function chainTunnelOf(raw: unknown): ChainTunnel | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    kind: text(item["kind"]),
    listen: text(item["listen"]),
    reach: text(item["reach"]),
    status: text(item["status"]),
  };
}

/** 解析一个阶段。 */
export function chainStageOf(raw: unknown): ChainStage | null {
  const item = asRecord(raw);
  const code = text(item["code"]);
  if (code === "") return null;
  const selfOnly = asArray(item["tunnels_self_only"])
    .map(chainTunnelOf)
    .filter((entry): entry is ChainTunnel => entry !== null);
  return {
    code,
    name: text(item["name"]) || code,
    subtitle: text(item["subtitle"]),
    goal: text(item["goal"]),
    color: text(item["color"]),
    points: numberOf(item["points"]),
    cumulative: numberOf(item["cumulative"]),
    hits: numberOf(item["hits"]),
    assetCount: numberOf(item["assetCount"]) || numberOf(item["asset_count"]),
    assets: asArray(item["assets"])
      .map(chainAssetOf)
      .filter((entry): entry is ChainAsset => entry !== null),
    items: asArray(item["items"])
      .map(chainHitOf)
      .filter((entry): entry is ChainHit => entry !== null),
    tunnels: asArray(item["tunnels"])
      .map(chainTunnelOf)
      .filter((entry): entry is ChainTunnel => entry !== null),
    tunnelsSelfOnly: selfOnly,
    transition: text(item["transition"]),
  };
}

/** 解析 `scoreChain` 响应（失败 → `null`）。 */
export function chainDataOf(response: unknown): ChainData | null {
  if (isFailure(response)) return null;
  const body = asRecord(response);
  const summary = asRecord(body["summary"]);
  return {
    stages: asArray(body["stages"])
      .map(chainStageOf)
      .filter((entry): entry is ChainStage => entry !== null),
    summary: Object.keys(summary).length > 0 ? { points: numberOf(summary["points"]) } : null,
  };
}

/** 是否信息收集阶段（渲染分支不同）。 */
export function isReconStage(stage: ChainStage): boolean {
  return stage.code === "recon";
}

/** 是否边界突破阶段（要额外渲染隧道清单）。 */
export function isBoundaryStage(stage: ChainStage): boolean {
  return stage.code === "boundary";
}

/** 阶段的「本阶段命中」小标题。 */
export function stageHitsLabel(stage: ChainStage): string {
  return "本阶段命中 " + stage.hits + " 次" + (stage.points !== 0 ? " · +" + stage.points + " 分" : "");
}

/** 信息收集阶段的资产小标题。 */
export function reconAssetsLabel(stage: ChainStage): string {
  return "拿到分数的资产 · " + stage.assetCount + " 台";
}

/** 其它阶段涉及资产的小标题。 */
export function stageAssetsLabel(stage: ChainStage): string {
  return "涉及资产 · " + stage.assetCount + " 台";
}

/** 边界突破阶段的隧道小标题（含 self-only 说明）。 */
export function tunnelsLabel(stage: ChainStage): string {
  const selfOnly = stage.tunnelsSelfOnly.length;
  return "跨越靶标边界的通道 · " + stage.tunnels.length + " 条"
    + (selfOnly > 0
      ? "（另有 " + selfOnly + " 条只在自己 VPS/自建服务器上，不算突破）"
      : "");
}

/**
 * 是否要显示「现有通道都在自己服务器上」的警示。
 *
 * 条件：**有** self-only 通道，且**没有**任何真正跨越边界的通道。
 * 只要有一条真通道就不警示 —— 那时 self-only 只是补充信息。
 */
export function showsSelfOnlyWarning(stage: ChainStage): boolean {
  return stage.tunnelsSelfOnly.length > 0 && stage.tunnels.length === 0;
}

/** self-only 警示文案。 */
export const SELF_ONLY_WARNING = "⚠️ 现有的通道都在自己的服务器上，没有碰到目标 —— 不计边界突破。"
  + "需要目标侧发起的通道（反弹 shell 到我这 / 目标上跑 frp 客户端 / 经目标 WebShell 的 suo5）。";

/** 阶段空的文案。 */
export function stageEmptyMessage(stage: ChainStage): string {
  return isReconStage(stage) ? "还没有产生得分的资产" : "本阶段还没有得分";
}

/** 隧道的状态标签（`active` → 可用）。 */
export function tunnelStatusLabel(tunnel: ChainTunnel): string {
  if (tunnel.status === "active") return "可用";
  return tunnel.status !== "" ? tunnel.status : "未知";
}

/** 隧道状态块的 className。 */
export function tunnelStatusClass(tunnel: ChainTunnel): string {
  return "rt-tag " + (tunnel.status === "active" ? "rt-tag-live" : "");
}

/** 隧道状态块的 style（非可用时降低不透明度）。 */
export function tunnelStatusStyle(tunnel: ChainTunnel): Readonly<Record<string, number>> | undefined {
  return tunnel.status === "active" ? undefined : { opacity: 0.7 };
}

/** 累计分标签。 */
export function cumulativeLabel(stage: ChainStage): string {
  return "累计 " + stage.cumulative + " 分";
}

/** 合计说明（最后一个阶段之后那条）。 */
export function totalLabel(summary: ChainSummary | null): string {
  return "合计 " + (summary?.points ?? 0) + " 分";
}

/** 得分徽章上的显示值（`capped` 时算 0 —— 服务已拿满不计分）。 */
export function hitPointsLabel(hit: ChainHit): string {
  return "+" + (hit.counted ? hit.points : 0);
}

/**
 * 「同类第 N 次」标签。
 *
 * 只在 `nth_of_point > 1` 时显示 —— 第一次是常态，标出来只是噪声。
 */
export function nthLabel(hit: ChainHit): string | null {
  return hit.nthOfPoint > 1 ? "第 " + hit.nthOfPoint + " 次" : null;
}

/** 命中行的目标（`target` → `asset_ip` → `—`）。 */
export function hitTarget(hit: ChainHit): string {
  if (hit.target !== "") return hit.target;
  return hit.assetIp !== "" ? hit.assetIp : "—";
}

/** 命中行的动作说明。 */
export function hitActionLabel(hit: ChainHit): string {
  const title = hit.actionTitle !== "" ? hit.actionTitle : "（未命名步骤）";
  return "动作：" + title + (hit.actionInferred ? "（推断）" : "");
}

/** 命中详情的「次数」行。 */
export function hitTimesLine(hit: ChainHit): string {
  return "同类第 " + hit.nthOfPoint + " 次 · +" + hit.points + " 分";
}

/** 命中详情的「记录」行。 */
export function hitRecordedLine(hit: ChainHit): string {
  return formatTimestamp(hit.recordedAt) + (hit.recordedBy !== "" ? " · " + hit.recordedBy : "");
}

/** 命中详情的「利用漏洞」行（CVE + 标题）。 */
export function hitVulnLine(hit: ChainHit): string {
  return [hit.vulnCve, hit.vulnTitle].filter((part) => part !== "").join(" ");
}

/** 资产行的优先级标签（`易打 N`；无优先级 → `null`）。 */
export function assetPriorityLabel(asset: ChainAsset): string | null {
  return asset.priority !== "" ? "易打 " + asset.priority : null;
}

/** 资产行的端口说明。 */
export function assetPortsLabel(asset: ChainAsset): string {
  return "端口 " + asset.openPorts;
}

/** 资产行的漏洞说明（0 条时不显示）。 */
export function assetVulnsLabel(asset: ChainAsset): string | null {
  return asset.vulns !== 0 ? "漏洞 " + asset.vulns : null;
}

/** 资产行的得分。 */
export function assetPointsLabel(asset: ChainAsset): string {
  return "+" + asset.points + " 分";
}

/** 资产行的命中次数。 */
export function assetHitsLabel(asset: ChainAsset): string {
  return asset.hits + " 次";
}

/** 资产行的内外网标签。 */
export function assetScopeLabel(asset: ChainAsset): string {
  return asset.scope === "internal" ? "内" : "外";
}

/** 资产行的内外网 className。 */
export function assetScopeClass(asset: ChainAsset): string {
  return "rt-scope rt-scope-" + (asset.scope === "internal" ? "internal" : "external");
}

/** 横向视图里资产行的前缀（`内 ` / `外 `）。 */
export function compactAssetScope(asset: ChainAsset): string {
  return asset.scope === "internal" ? "内 " : "外 ";
}

/** 横向视图里边界阶段的命中说明。 */
export function compactTunnelHit(stage: ChainStage): string {
  return "隧道 " + stage.tunnels.length + " 条";
}

/** 横向视图里信息收集阶段的命中说明。 */
export function compactReconHit(stage: ChainStage): string {
  return stage.assetCount + " 台资产拿到分";
}

/** 横向视图里其它阶段的命中说明。 */
export function compactHitsLabel(stage: ChainStage): string {
  return stage.hits + " 次命中";
}

/** 横向视图的截断：只列前 N 条，余下用「另有 N 次」。 */
export const COMPACT_LIMIT = 6;

/** 横向视图隧道的截断数。 */
export const COMPACT_TUNNEL_LIMIT = 3;

/** 「另有 N 次」的文案（不足时 → `null`）。 */
export function moreHitsLabel(total: number): string | null {
  return total > COMPACT_LIMIT ? "…另有 " + (total - COMPACT_LIMIT) + " 次" : null;
}

/** 「涉及 N 台资产」的文案（0 台时 → `null`）。 */
export function compactAssetCountLabel(stage: ChainStage): string | null {
  return stage.assetCount !== 0 ? "涉及 " + stage.assetCount + " 台资产" : null;
}

/** 竖向视图根容器的 className。 */
export function viewRootClass(view: ChainView): string {
  return view === "A" ? "rt-ap" : "rt-ap-h";
}

/** 视图切换按钮的 className。 */
export function viewButtonClass(view: ChainView, current: ChainView): string {
  return "rt-btn" + (current === view ? " rt-btn-primary" : "");
}

/** 视图切换按钮的 title。 */
export function viewButtonTitle(view: ChainView): string {
  return view === "A"
    ? "竖向攻击链：逐阶段向下看细节"
    : "横向攻击链：一屏看完五个阶段";
}

/** 视图切换按钮的文案。 */
export function viewButtonLabel(view: ChainView): string {
  return view === "A" ? "链路 A" : "链路 B";
}

/** 阶段标题块的 className（带颜色的左边框）。 */
export function stageHeadStyle(color: string): Readonly<Record<string, string>> {
  return { borderLeftColor: color };
}

/** 阶段的得分徽章 style（带透明背景与边框）。 */
export function stagePointsStyle(color: string): Readonly<Record<string, string>> {
  return { background: color + "22", color, borderColor: color + "66" };
}

/** 阶段编号块的 style。 */
export function stageNumberStyle(color: string): Readonly<Record<string, string>> {
  return { background: color };
}

/** 横向视图阶段编号块的 style（更小）。 */
export function stageNumberCompactStyle(color: string): Readonly<Record<string, string | number>> {
  return { background: color, width: 16, height: 16, fontSize: 10 };
}
