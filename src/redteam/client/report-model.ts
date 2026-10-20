/**
 * 得分复现报告页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `ReportTab` 的 224 行里，「分组」是唯一有真实分支逻辑的部分，
 * 而它藏在一次**二次请求**里：
 *
 * ```js
 * if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
 *   api({ op: 'scoreChain' }).then((c) => setData({ ...r, stages: groupByStage(r.items, c) }))
 * }
 * ```
 *
 * 也就是说：**老 host 只给平铺条目时，前端要用 `scoreChain` 的阶段信息
 * 把条目重新分组**，否则报告页会误报「还没有可交付的成果」。
 * 这是真实的兼容场景（host 侧版本较旧 / 阶段行缺失），不是防御性代码。
 *
 * 抽出来后可以钉死三条规则：
 *
 * 1. **按 `score_hit` id 对齐**：两边唯一的共同键是 id，不是顺序、不是标题。
 * 2. **没有阶段信息的条目归「其他得分」**，不能让它们凭空消失。
 * 3. **阶段分组只保留有命中的阶段**：空阶段不占版面。
 *
 * ## 另外三块
 *
 * - **复现材料的完整度判定**（`incomplete`）：没有攻击步骤、没写实际命令、
 *   没有原始请求 —— 三者都是「这份报告复现不了」的硬缺口。
 * - **`markdown` 的下载文件名规整**：`report-<label>.md`，label 里的
 *   非 `[A-Za-z0-9_.-]` 全部换成 `_`。
 * - **报告只收录得分成果**：`items` 为空就是「没有可交付的成果」，
 *   而不是「加载失败」。
 */

import { formatTimestamp, isFailure } from "./helpers.js";
import { ROLE_LABEL, labelOf } from "./label.js";

/** 一次报告条目的原始请求。 */
export interface ReportRequest {
  readonly request: string;
  readonly response: string;
  readonly method: string;
  readonly status: number | null;
  readonly url: string;
  /** `auto` = 按目标路径自动匹配（用户需要核对）。 */
  readonly source: string;
}

/** 一条攻击步骤（复现的核心）。 */
export interface ReportStep {
  readonly id: number;
  readonly title: string;
  readonly detail: string;
  readonly tool: string;
  readonly result: string;
  readonly agent: string;
  readonly stageCode: string;
  readonly evidenceRef: string;
  readonly recordedAt: string;
  /** 按同资产推断（不是直接关联）。 */
  readonly inferred: boolean;
}

/** 报告里的一条凭据（来源可追溯）。 */
export interface ReportCredential {
  readonly id: number;
  readonly host: string;
  readonly username: string;
  readonly secretType: string;
  readonly privilege: string;
  readonly source: string;
  readonly tool: string;
}

/** 报告里的一条隧道。 */
export interface ReportTunnel {
  readonly id: number;
  readonly kind: string;
  readonly listen: string;
  readonly entry: string;
  readonly entryKind: string;
  readonly reach: string;
  readonly status: string;
  readonly command: string;
  /** `false` = 只在自己服务器上，不算跨越靶标边界。 */
  readonly legit: boolean | null;
}

/** 报告里的一条 WebShell。 */
export interface ReportWebshell {
  readonly id: number;
  readonly shellType: string;
  readonly url: string;
  readonly passKey: string;
  readonly privilege: string;
  readonly status: string;
}

/** 报告里的一张证据截图（元数据；字节由容器另取）。 */
export interface ReportShot {
  readonly id: number;
  readonly kind: string;
  readonly label: string;
  readonly note: string;
  readonly target: string;
  readonly capturedAt: string;
}

/** 一条报告条目（= 一次得分）。 */
export interface ReportItem {
  readonly id: number;
  readonly seq: number;
  readonly pointName: string;
  readonly points: number;
  readonly counted: boolean;
  readonly nthOfPoint: number;
  readonly target: string;
  readonly assetIp: string;
  readonly gained: string;
  readonly evidence: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly note: string;
  readonly vulnCve: string;
  readonly vulnTitle: string;
  readonly how: string;
  /** 复现材料是否完整（缺步骤/命令/请求）。 */
  readonly incomplete: boolean;
  readonly gaps: readonly string[];
  /** 关联漏洞的原始请求。 */
  readonly requests: readonly ReportRequest[];
  readonly steps: readonly ReportStep[];
  readonly credentials: readonly ReportCredential[];
  readonly tunnels: readonly ReportTunnel[];
  readonly webshells: readonly ReportWebshell[];
  readonly shots: readonly ReportShot[];
  readonly shotTotal: number;
}

/** 一个阶段分组。 */
export interface ReportStage {
  readonly code: string;
  readonly name: string;
  readonly color: string;
  readonly ordinal: number;
  readonly points: number;
  readonly cumulative: number;
  readonly items: readonly ReportItem[];
}

/** 报告摘要。 */
export interface ReportSummary {
  readonly points: number;
  readonly count: number;
  readonly withRequests: number;
  readonly incomplete: number;
  readonly missingRequests: boolean;
  readonly serviceCappedExcluded: number;
  readonly serviceCapped: readonly { readonly service: string; readonly point_name: string }[];
}

/** 一次报告读取的结果。 */
export interface ReportData {
  readonly target: string;
  readonly markdown: string;
  readonly items: readonly ReportItem[];
  readonly stages: readonly ReportStage[];
  readonly summary: ReportSummary | null;
}

/** 报告的「其他得分」阶段的固定 code。 */
export const OTHER_STAGE_CODE = "other";

/** 「其他得分」的固定颜色（与上游一致）。 */
export const OTHER_STAGE_COLOR = "#64748b";

/** 「其他得分」的显示名。 */
export const OTHER_STAGE_NAME = "其他得分";

/** 圈号（20 个 —— 报告阶段可能超过五个）。 */
export const CIRCLED: readonly string[] = Object.freeze([
  "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
  "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
]);

/** 空态：没有可交付成果。 */
export const EMPTY_REPORT_TITLE = "还没有可交付的成果。";

/** 空态说明。 */
export const EMPTY_REPORT_HINT = "本报告只收录\"拿到了分\"的成果；没有得分的漏洞不进报告。"
  + "拿到成果后用 redteam_score_hit 记分（目标资产 + 拿到的东西），并补 redteam_http_evidence_add 以便复现。";

/** 加载中文案。 */
export const LOADING_REPORT_MESSAGE = "加载中…";

/** 底部口径说明。 */
export const REPORT_FOOTER = "口径：只收录得分成果，每条附带可粘进 Yakit Repeater 的原始请求";

/** 缺少步骤的警示。 */
export const MISSING_STEPS_MESSAGE = "⚠️ 没有关联的攻击步骤：说不清这一步是怎么做的。"
  + "请用 redteam_chain_add 补上动作（title / detail / tool / result），记分时也可以带 point_code + evidence 一次完成。";

/** 缺少原始请求的警示。 */
export const MISSING_REQUESTS_MESSAGE = "⚠️ 这一项没有原始请求记录，无法直接复现 —— 请用 redteam_http_evidence_add 补上";

/** 缺少实际命令的警示。 */
export const MISSING_TOOL_MESSAGE = "未记录实际命令（redteam_chain_add 的 tool）";

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

/** 读字符串数组。 */
function stringsOf(value: unknown): readonly string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

/** 解析一条原始请求。 */
export function reportRequestOf(raw: unknown): ReportRequest | null {
  const item = asRecord(raw);
  // 请求可能是空串（只有响应），此时 url/method 仍要保留 —— 不按 id 判空
  // （这条记录没有 id 字段，用「有没有任何字段」判空）。
  if (Object.keys(item).length === 0) return null;
  return {
    request: text(item["request"]),
    response: text(item["response"]),
    method: text(item["method"]),
    status: numberOrNull(item["status"]),
    url: text(item["url"]),
    source: text(item["source"]),
  };
}

/** 解析一条攻击步骤。 */
export function reportStepOf(raw: unknown): ReportStep | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    title: text(item["title"]),
    detail: text(item["detail"]),
    tool: text(item["tool"]),
    result: text(item["result"]),
    agent: text(item["agent"]),
    stageCode: text(item["stage_code"]),
    evidenceRef: text(item["evidence_ref"]),
    recordedAt: text(item["recorded_at"]),
    inferred: item["inferred"] === true,
  };
}

/** 解析一条凭据。 */
export function reportCredentialOf(raw: unknown): ReportCredential | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    host: text(item["host"]),
    username: text(item["username"]),
    secretType: text(item["secret_type"]),
    privilege: text(item["privilege"]),
    source: text(item["source"]),
    tool: text(item["tool"]),
  };
}

/** 解析一条隧道。 */
export function reportTunnelOf(raw: unknown): ReportTunnel | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  const legit = item["legit"];
  return {
    id,
    kind: text(item["kind"]),
    listen: text(item["listen"]),
    entry: text(item["entry"]),
    entryKind: text(item["entry_kind"]),
    reach: text(item["reach"]),
    status: text(item["status"]),
    command: text(item["command"]),
    legit: typeof legit === "boolean" ? legit : null,
  };
}

/** 解析一条 WebShell。 */
export function reportWebshellOf(raw: unknown): ReportWebshell | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    shellType: text(item["shell_type"]),
    url: text(item["url"]),
    passKey: text(item["pass_key"]),
    privilege: text(item["privilege"]),
    status: text(item["status"]),
  };
}

/** 解析一张证据截图。 */
export function reportShotOf(raw: unknown): ReportShot | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    kind: text(item["kind"]),
    label: text(item["label"]),
    note: text(item["note"]),
    target: text(item["target"]),
    capturedAt: text(item["captured_at"]),
  };
}

/** 解析一条报告条目。 */
export function reportItemOf(raw: unknown): ReportItem | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  const vuln = asRecord(item["vuln"]);
  const steps = asArray(item["steps"])
    .map(reportStepOf)
    .filter((entry): entry is ReportStep => entry !== null);
  const requests = asArray(item["requests"])
    .map(reportRequestOf)
    .filter((entry): entry is ReportRequest => entry !== null);
  return {
    id,
    seq: numberOf(item["seq"]),
    pointName: text(item["point_name"]),
    points: numberOf(item["points"]),
    // 缺省算「计分」（`counted !== false`），与攻击链页一致。
    counted: item["counted"] !== false,
    nthOfPoint: numberOf(item["nth_of_point"]),
    target: text(item["target"]),
    assetIp: text(item["asset_ip"]),
    gained: text(item["gained"]),
    evidence: text(item["evidence"]),
    recordedAt: text(item["recorded_at"]),
    recordedBy: text(item["recorded_by"]),
    note: text(item["note"]),
    vulnCve: text(vuln["cve"]),
    vulnTitle: text(vuln["title"]),
    how: text(item["how"]),
    incomplete: item["incomplete"] === true,
    gaps: stringsOf(item["gaps"]),
    requests,
    steps,
    credentials: asArray(item["credentials"])
      .map(reportCredentialOf)
      .filter((entry): entry is ReportCredential => entry !== null),
    tunnels: asArray(item["tunnels"])
      .map(reportTunnelOf)
      .filter((entry): entry is ReportTunnel => entry !== null),
    webshells: asArray(item["webshells"])
      .map(reportWebshellOf)
      .filter((entry): entry is ReportWebshell => entry !== null),
    shots: asArray(item["shots"])
      .map(reportShotOf)
      .filter((entry): entry is ReportShot => entry !== null),
    shotTotal: numberOf(item["shot_total"]),
  };
}

/** 解析摘要。 */
export function reportSummaryOf(raw: unknown): ReportSummary | null {
  const item = asRecord(raw);
  if (Object.keys(item).length === 0) return null;
  return {
    points: numberOf(item["points"]),
    count: numberOf(item["count"]),
    withRequests: numberOf(item["withRequests"]),
    incomplete: numberOf(item["incomplete"]),
    missingRequests: numberOf(item["missingRequests"]) !== 0,
    serviceCappedExcluded: numberOf(item["serviceCappedExcluded"]),
    serviceCapped: asArray(item["serviceCapped"]).map((entry) => {
      const record = asRecord(entry);
      return { service: text(record["service"]), point_name: text(record["point_name"]) };
    }),
  };
}

/** 解析一个阶段。 */
export function reportStageOf(raw: unknown): ReportStage | null {
  const item = asRecord(raw);
  const code = text(item["code"]);
  if (code === "") return null;
  return {
    code,
    name: text(item["name"]) || code,
    color: text(item["color"]) || OTHER_STAGE_COLOR,
    ordinal: numberOf(item["ordinal"]),
    points: numberOf(item["points"]),
    cumulative: numberOf(item["cumulative"]),
    items: asArray(item["items"])
      .map(reportItemOf)
      .filter((entry): entry is ReportItem => entry !== null),
  };
}

/** 解析 `scoreReport` 响应（失败 → `null`）。 */
export function reportDataOf(response: unknown): ReportData | null {
  if (isFailure(response)) return null;
  const body = asRecord(response);
  return {
    target: text(body["target"]),
    markdown: text(body["markdown"]),
    items: asArray(body["items"])
      .map(reportItemOf)
      .filter((entry): entry is ReportItem => entry !== null),
    stages: asArray(body["stages"])
      .map(reportStageOf)
      .filter((entry): entry is ReportStage => entry !== null),
    summary: reportSummaryOf(body["summary"]),
  };
}

/**
 * 报告是否需要前端补分组。
 *
 * 条件与原实现一致：**服务端没给阶段**（缺失或空）**且有平铺条目**。
 * 两个条件必须同时成立 —— 只有「没阶段也没条目」时补分组是白跑一次请求。
 */
export function needsStageGrouping(data: ReportData | null): boolean {
  if (data === null) return false;
  return data.stages.length === 0 && data.items.length > 0;
}

/**
 * 用攻击链的阶段信息给平铺条目补分组。
 *
 * **对齐键是 `score_hit` 的 id**：`scoreChain` 的每条 item 带 `stage_code`，
 * `scoreReport` 的每条 item 带同样的 id。用顺序或标题对齐都会错位。
 *
 * 三条规则：
 * 1. 空阶段不出现（`items.length === 0` 就跳过）。
 * 2. 阶段顺序沿用 `chain.stages` 的顺序（那是攻击链的定义顺序）。
 * 3. 没被任何阶段认领的条目归入「其他得分」—— **不能丢**，
 *    否则报告会少掉真实拿到的分。
 */
export function groupByStage(
  items: readonly ReportItem[],
  chainStageRefs: readonly {
    readonly code: string;
    readonly name: string;
    readonly color: string;
    readonly ordinal: number;
    readonly points: number;
    readonly cumulative: number;
    readonly itemIds: readonly number[];
  }[],
): readonly ReportStage[] {
  const byId = new Map<number, ReportItem>();
  for (const item of items) byId.set(item.id, item);

  const groups: ReportStage[] = [];
  chainStageRefs.forEach((ref, index) => {
    const claimed: ReportItem[] = [];
    for (const id of ref.itemIds) {
      const item = byId.get(id);
      if (item !== undefined) claimed.push(item);
    }
    if (claimed.length === 0) return;
    groups.push({
      code: ref.code,
      name: ref.name,
      color: ref.color !== "" ? ref.color : OTHER_STAGE_COLOR,
      ordinal: ref.ordinal !== 0 ? ref.ordinal : index + 1,
      points: ref.points,
      cumulative: ref.cumulative,
      items: claimed,
    });
  });

  const grouped = new Set<number>();
  for (const group of groups) {
    for (const item of group.items) grouped.add(item.id);
  }
  const rest = items.filter((item) => !grouped.has(item.id));
  if (rest.length > 0) {
    groups.push({
      code: OTHER_STAGE_CODE,
      name: OTHER_STAGE_NAME,
      color: OTHER_STAGE_COLOR,
      ordinal: groups.length + 1,
      points: rest.reduce((sum, item) => sum + (item.counted ? item.points : 0), 0),
      cumulative: 0,
      items: rest,
    });
  }
  return groups;
}

/**
 * 从 `scoreChain` 的响应里抽出「阶段 → 条目 id」的引用表。
 *
 * 只保留三个字段（code/name/color）+ 序号 + 分数 + id 列表，
 * 让 `groupByStage` 不依赖攻击链页的完整类型。
 */
export function stageRefsFromChain(response: unknown): readonly {
  readonly code: string;
  readonly name: string;
  readonly color: string;
  readonly ordinal: number;
  readonly points: number;
  readonly cumulative: number;
  readonly itemIds: readonly number[];
}[] {
  if (isFailure(response)) return [];
  const stages = asArray(asRecord(response)["stages"]);
  return stages.map((raw) => {
    const stage = asRecord(raw);
    const items = asArray(stage["items"]);
    return {
      code: text(stage["code"]),
      name: text(stage["name"]),
      color: text(stage["color"]),
      ordinal: numberOf(stage["ordinal"]),
      points: numberOf(stage["points"]),
      cumulative: numberOf(stage["cumulative"]),
      itemIds: items
        .map((item) => numberOrNull(asRecord(item)["id"]))
        .filter((id): id is number => id !== null),
    };
  }).filter((ref) => ref.code !== "");
}

/** 把补好的分组套回报告数据。 */
export function withStages(
  data: ReportData,
  stages: readonly ReportStage[],
): ReportData {
  return { ...data, stages };
}

/** 阶段序号标签（超出 20 个 → 原始数字）。 */
export function circledOf(ordinal: number): string {
  if (ordinal < 1) return String(ordinal);
  return CIRCLED[ordinal - 1] ?? String(ordinal);
}

/** 阶段标题的计项文案。 */
export function stageCountLabel(stage: ReportStage): string {
  return stage.items.length + " 项";
}

/** 阶段标题的得分文案。 */
export function stagePointsLabel(stage: ReportStage): string {
  return "+" + stage.points + " 分";
}

/** 阶段标题的累计分文案。 */
export function stageCumulativeLabel(stage: ReportStage): string {
  return "累计 " + stage.cumulative + " 分";
}

/** 阶段标题的得分徽章 style。 */
export function stagePointsStyle(color: string): Readonly<Record<string, string>> {
  return { background: color + "22", color, borderColor: color + "66" };
}

/** 阶段标题的序号块 style。 */
export function stageOrdinalStyle(color: string): Readonly<Record<string, string>> {
  return { background: color };
}

/** 阶段的折叠键（`st:<code>`）。 */
export function stageCollapseKey(code: string): string {
  return "st:" + code;
}

/** 条目的序号标签（`String(seq)`）。 */
export function itemSeqLabel(item: ReportItem): string {
  return String(item.seq);
}

/** 条目的得分标签。 */
export function itemPointsLabel(item: ReportItem): string {
  return "+" + item.points + " 分";
}

/** 「同类第 N 次」标签（第一次 → `null`）。 */
export function itemNthLabel(item: ReportItem): string | null {
  return item.nthOfPoint > 1 ? "同类第 " + item.nthOfPoint + " 次" : null;
}

/** 条目的目标（`target` → `asset_ip` → `—`）。 */
export function itemTarget(item: ReportItem): string {
  if (item.target !== "") return item.target;
  return item.assetIp !== "" ? item.assetIp : "—";
}

/** 条目的漏洞行（CVE + 标题；都空 → `null`）。 */
export function itemVulnLine(item: ReportItem): string | null {
  const parts = [item.vulnCve, item.vulnTitle].filter((part) => part !== "");
  return parts.length > 0 ? parts.join(" ") : null;
}

/** 条目的取得时间行（含角色中文名）。 */
export function itemRecordedLine(item: ReportItem): string {
  const base = formatTimestamp(item.recordedAt);
  return item.recordedBy !== "" ? base + "（" + labelOf(ROLE_LABEL, item.recordedBy) + "）" : base;
}

/** 条目的结果行（换行压成空格，保持单行）。 */
export function itemEvidenceLine(item: ReportItem): string {
  return item.evidence.replace(/\n+/g, " ");
}

/** 步骤的执行命令行（`null` = 没记录）。 */
export function stepToolLine(step: ReportStep): string | null {
  return step.tool !== "" ? step.tool : null;
}

/** 步骤的结果行（换行压成空格）。 */
export function stepResultLine(step: ReportStep): string {
  return step.result.replace(/\n+/g, " ");
}

/** 步骤的角色标签（`null` = 没标注）。 */
export function stepAgentLabel(step: ReportStep): string | null {
  return step.agent !== "" ? labelOf(ROLE_LABEL, step.agent) : null;
}

/** 步骤的序号（从 1 开始的显示序）。 */
export function stepIndexLabel(index: number): string {
  return String(index + 1);
}

/** 步骤的标题（空 → `(未命名动作)`）。 */
export function stepTitleLabel(step: ReportStep): string {
  return step.title !== "" ? step.title : "(未命名动作)";
}

/** 凭据行的可追溯说明。 */
export function credentialLine(cred: ReportCredential): string {
  return (cred.username !== "" ? cred.username : "(无用户名)")
    + " / " + (cred.secretType !== "" ? cred.secretType : "password")
    + (cred.privilege !== "" ? " · 权限 " + cred.privilege : "")
    + " · 来源 " + (cred.source !== "" ? cred.source : "未标注")
    + (cred.tool !== "" ? " · 取得方式 " + cred.tool.replace(/\n+/g, " ").slice(0, 160) : "");
}

/** 隧道行的说明。 */
export function tunnelLine(tunnel: ReportTunnel): string {
  return "入口 " + (tunnel.entry !== "" ? tunnel.entry : "未登记")
    + (tunnel.reach !== "" ? " · 可达 " + tunnel.reach : "")
    + " · 目标侧 " + (tunnel.entryKind !== "" ? tunnel.entryKind : "未声明")
    + (tunnel.legit === false ? " · ⚠️ 不算跨越靶标边界" : "")
    + (tunnel.status !== "" ? " · " + tunnel.status : "")
    + (tunnel.command !== "" ? " · 命令 " + tunnel.command.replace(/\n+/g, " ").slice(0, 160) : "");
}

/** 隧道的标题（`kind listen`）。 */
export function tunnelHeading(tunnel: ReportTunnel): string {
  return (tunnel.kind !== "" ? tunnel.kind : "socks5") + " " + tunnel.listen;
}

/** WebShell 行的说明。 */
export function webshellLine(shell: ReportWebshell): string {
  return shell.url
    + (shell.passKey !== "" ? " · 口令/密钥 " + shell.passKey : "")
    + (shell.privilege !== "" ? " · 权限 " + shell.privilege : "")
    + (shell.status !== "" ? " · " + shell.status : "");
}

/** WebShell 的标题（空 → `shell`）。 */
export function webshellHeading(shell: ReportWebshell): string {
  return shell.shellType !== "" ? shell.shellType : "shell";
}

/** 请求行的标题（`复现请求 N` + 自动匹配说明）。 */
export function requestTitle(index: number, request: ReportRequest): string {
  return "复现请求 " + (index + 1)
    + (request.source === "auto" ? "（按目标路径自动匹配，请核对）" : "");
}

/** 请求行的标签（`方法 状态码`）。 */
export function requestLabel(request: ReportRequest): string {
  return (request.method !== "" ? request.method : "GET") + " "
    + (request.status === null ? "" : String(request.status));
}

/**
 * 请求正文的显示值。
 *
 * 原实现：`r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')`。
 * 没有原始请求时退化成一行合成的请求行 —— 至少能看出是发给谁的哪个方法。
 */
export function requestBody(request: ReportRequest): string {
  if (request.request !== "") return request.request;
  return (request.method !== "" ? request.method : "GET") + " " + request.url + " HTTP/1.1";
}

/** 响应摘要的截断长度。 */
export const RESPONSE_PREVIEW_LIMIT = 1600;

/** 响应摘要的显示值（截断到 1600 字符）。 */
export function responsePreview(request: ReportRequest): string | null {
  if (request.response === "") return null;
  return request.response.slice(0, RESPONSE_PREVIEW_LIMIT);
}

/** 一条条目所有请求拼起来的可复制文本（空请求行会被过滤）。 */
export function requestsText(item: ReportItem): string {
  return item.requests
    .map((request) => request.request)
    .filter((request) => request !== "")
    .join("\n\n");
}

/** 「复制请求」按钮对应的 label。 */
export function copyRequestsLabel(item: ReportItem): string {
  return "第 " + item.seq + " 项请求";
}

/** 「复制命令」按钮对应的 label。 */
export function copyCommandLabel(index: number): string {
  return "第 " + (index + 1) + " 步命令";
}

/** 工具栏的「合计 N 分」。 */
export function summaryPointsLabel(summary: ReportSummary | null): string | null {
  return summary === null ? null : "合计 " + summary.points + " 分";
}

/** 工具栏的「N 项得分」。 */
export function summaryCountLabel(summary: ReportSummary | null): string | null {
  return summary === null ? null : summary.count + " 项得分";
}

/** 工具栏的「N/M 项带原始请求」。 */
export function summaryRequestsLabel(summary: ReportSummary | null): string | null {
  return summary === null ? null : summary.withRequests + "/" + summary.count + " 项带原始请求";
}

/** 「带原始请求」标签是否用绿色（全带 → 绿；有缺 → 灰）。 */
export function summaryRequestsLive(summary: ReportSummary): boolean {
  return !summary.missingRequests;
}

/** 工具栏的「可复现 N/M」。 */
export function summaryCompleteLabel(summary: ReportSummary | null): string | null {
  return summary === null ? null : "可复现 " + (summary.count - summary.incomplete) + "/" + summary.count;
}

/** 「可复现」标签是否用警示色（有缺口 → 警示）。 */
export function summaryCompleteWarn(summary: ReportSummary): boolean {
  return summary.incomplete > 0;
}

/**
 * 工具栏的「同服务已拿满不计分 N」。
 *
 * 只在**有**被排除的条目时显示。tooltip 列出被排除的服务/得分点
 * （原实现用 `join('\n')`，空列表时退化成一句解释）。
 */
export function summaryCappedLabel(summary: ReportSummary | null): string | null {
  if (summary === null || summary.serviceCappedExcluded === 0) return null;
  return "同服务已拿满不计分 " + summary.serviceCappedExcluded;
}

/** 「同服务已拿满」标签的 tooltip。 */
export function summaryCappedTitle(summary: ReportSummary): string {
  const lines = summary.serviceCapped
    .map((entry) => (entry.service !== "" ? entry.service : "") + "｜" + entry.point_name)
    .join("\n");
  return lines !== ""
    ? lines
    : "同一资产同一端口的重复账号/数据库权限命中：服务已拿满，不计分、不进报告";
}

/**
 * 下载文件名。
 *
 * 原实现：`'report-' + String(label || 'score').replace(/[^\w.\-]/g, '_') + '.md'`。
 * `\w` 在 JS 里是 `[A-Za-z0-9_]`，所以中文 label 会变成一串 `_` ——
 * **保留这个行为**：文件名在各平台上的兼容性比可读性重要。
 */
export function downloadFileName(label: string): string {
  const safe = (label !== "" ? label : "score").replace(/[^\w.-]/g, "_");
  return "report-" + safe + ".md";
}

/** 下载成功提示。 */
export function downloadedMessage(label: string): string {
  return "已下载：" + label;
}

/** 下载失败提示。 */
export function downloadFailedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return "下载失败：" + message;
}

/** 复制成功的提示（与原实现同形）。 */
export function copiedMessage(label: string): string {
  return "已复制：" + label;
}

/** 复制失败的提示。 */
export const COPY_FAILED_MESSAGE = "复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制";

/** 工具栏按钮的禁用条件：没正文时不能复制/下载。 */
export function canCopyOrDownload(busy: boolean, markdown: string): boolean {
  return !busy && markdown !== "";
}

/** 「全部展开 / 全部折叠」的键列表。 */
export function stageKeys(stages: readonly ReportStage[]): readonly string[] {
  return stages.map((stage) => stageCollapseKey(stage.code));
}

/** 报告数据是否为空（`null` = 没读回来，与「读到但没有成果」区分）。 */
export function isLoaded(data: ReportData | null): boolean {
  return data !== null;
}

/** 报告是否有可展示的阶段。 */
export function hasStages(data: ReportData | null): boolean {
  return data !== null && data.stages.length > 0;
}
