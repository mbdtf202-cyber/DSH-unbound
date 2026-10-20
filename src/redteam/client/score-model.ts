/**
 * 得分目标页（`scores` 页签）的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `ScoreTab`（357 行）混了四件互不相干的事：
 *
 * 1. **看板解析**：`items` / `ruleGroups` / `summary` 三条线，且 `ruleGroups`
 *    缺失时（老 host）要**退回平铺** —— 这个兼容分支最容易在迁移里丢掉。
 * 2. **分组渲染**：8 个类别按后端 `order` 排序，组头显示「N 项 · 各项上限合计 X 分」。
 * 3. **表单**：内置点（`builtin`）的 5 个字段全部 `readOnly`，只有「启用/停用」可改，
 *    且删除按钮禁用。这是**真实的产品决策**（分值由《得分规则》锁定，改了就
 *    「一条命中吃掉整组上限」），不是防呆。
 * 4. **保存语义**：`overridden === false` 表示后端**没采纳**分值 —— 这时
 *    必须报「分值未改动」而不是笼统的「已保存」。
 */

import { err, ok, type Result } from "../../shared/result.js";
import type { ApiClient, ApiRequest } from "./api.js";

/* ══════════════════════════════════════════════════════════════ 窄化原语 */

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

/** 从不可信值读数组。 */
function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 从不可信值读计数（非有限或负数 → 0）。 */
function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 从不可信值读有符号整数（可为负）。 */
function intOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** 从不可信值读可空数字。 */
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ══════════════════════════════════════════════════════════════ 命中 */

/** 一条命中记录。 */
export interface ScoreHit {
  readonly id: number;
  readonly target: string;
  readonly assetIp: string;
  readonly evidence: string;
  readonly note: string;
  readonly points: number;
  readonly service: string;
  readonly selfCreated: boolean;
  readonly capped: boolean;
  readonly cappedReason: string;
  readonly recordedAt: string;
  readonly shotCount: number;
}

/** 解析一条命中。 */
export function scoreHitOf(raw: unknown): ScoreHit {
  const entry = recordOf(raw);
  return {
    id: countOrZero(entry["id"]),
    target: text(entry["target"]),
    assetIp: text(entry["asset_ip"]) || text(entry["assetIp"]),
    evidence: text(entry["evidence"]),
    note: text(entry["note"]),
    points: intOf(entry["points"]),
    service: text(entry["service"]),
    // 两个形态都读：Host 返回 snake_case，而模型函数也可能被已解析的对象再喂一次
    // （测试与「看板 → 表单 → 看板」的往返都会这样），只认 snake_case 会静默丢字段。
    selfCreated: entry["self_created"] === true || entry["selfCreated"] === true,
    capped: entry["capped"] === true,
    cappedReason: text(entry["capped_reason"]) || text(entry["cappedReason"]),
    recordedAt: text(entry["recorded_at"]) || text(entry["recordedAt"]),
    shotCount: countOrZero(entry["shot_count"]) || countOrZero(entry["shotCount"]),
  };
}

/** 命中的资产标签（`asset_ip` 优先，回退 `target`，都空则「未指定资产」）。 */
export function hitAssetLabel(hit: ScoreHit): string {
  if (hit.assetIp !== "") return hit.assetIp;
  if (hit.target !== "") return hit.target;
  return "未指定资产";
}

/**
 * 命中的证据文本。
 *
 * 原实现把换行压成空格（`String(evidence).replace(/\n+/g, ' ')`）——
 * 命中行是**一格**，多行证据会把行高撑爆，这是刻意的收敛。
 */
export function hitEvidenceText(hit: ScoreHit): string {
  return hit.evidence.replace(/\n+/g, " ");
}

/** 命中是否填了证据（决定渲染「未填账号密码/结果」还是证据文本）。 */
export function hitHasEvidence(hit: ScoreHit): boolean {
  return hit.evidence !== "";
}

/** 「复制这一条」要送进剪贴板的文本：`资产  证据`（两个空格分隔）。 */
export function hitCopyText(hit: ScoreHit): string {
  const asset = hit.assetIp !== "" ? hit.assetIp : hit.target;
  return asset + "  " + hit.evidence;
}

/** 命中的服务封顶标签（`服务已拿满 · 不计分（https）`）。 */
export function cappedLabel(hit: ScoreHit): string {
  return "服务已拿满 · 不计分" + (hit.service !== "" ? "（" + hit.service + "）" : "");
}

/** 命中封顶的 tooltip（后端没给理由时用默认口径）。 */
export function cappedTitle(hit: ScoreHit): string {
  return hit.cappedReason !== ""
    ? hit.cappedReason
    : "同一资产同一端口只算分值最高的一条，这条不计分";
}

/** 自建标记的 tooltip。 */
export const SELF_CREATED_TITLE = "自己注册/自建的账号不算得分权限，只作过程记录";

/** 截图标记的 tooltip。 */
export const SHOT_COUNT_TITLE = "这条命中有证据截图（展开得分点即可看到代表图）";

/* ══════════════════════════════════════════════════════════════ 得分点 */

/** 一个得分点（含命中）。 */
export interface ScorePoint {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly points: number;
  readonly tier: string;
  readonly cap: number;
  readonly capUsed: number;
  readonly src: number | null;
  readonly rule: number | null;
  readonly builtin: boolean;
  readonly enabled: boolean;
  readonly description: string;
  readonly counted: number;
  readonly earned: number;
  readonly selfCreated: number;
  readonly capped: number;
  readonly scopeLabel: string;
  readonly serviceSummary: string;
  readonly hits: readonly ScoreHit[];
}

/** 解析一个得分点。 */
export function scorePointOf(raw: unknown): ScorePoint {
  const entry = recordOf(raw);
  return {
    id: countOrZero(entry["id"]),
    code: text(entry["code"]),
    name: text(entry["name"]),
    category: text(entry["category"]),
    points: intOf(entry["points"]),
    tier: text(entry["tier"]),
    cap: countOrZero(entry["cap"]),
    capUsed: countOrZero(entry["cap_used"]) || countOrZero(entry["capUsed"]),
    src: nullableNumber(entry["src"]),
    rule: nullableNumber(entry["rule"]),
    builtin: entry["builtin"] === true,
    enabled: entry["enabled"] !== false,
    description: text(entry["description"]),
    counted: countOrZero(entry["counted"]),
    earned: intOf(entry["earned"]),
    selfCreated: countOrZero(entry["self_created"]) || countOrZero(entry["selfCreated"]),
    capped: countOrZero(entry["capped"]),
    scopeLabel: text(entry["scope_label"]) || text(entry["scopeLabel"]),
    serviceSummary: text(entry["service_summary"]) || text(entry["serviceSummary"]),
    hits: arrayOf(entry["hits"]).map(scoreHitOf),
  };
}

/** 得分点是否已命中。 */
export function isAchieved(point: ScorePoint): boolean {
  return point.hits.length > 0;
}

/** 得分点行的分值徽章类名（命中用高亮，未命中用低亮）。 */
export function pointsBadgeClass(point: ScorePoint): string {
  return isAchieved(point) ? "rt-pri rt-pri-high" : "rt-pri rt-pri-low";
}

/**
 * 未命中的分值徽章额外样式。
 *
 * 原实现：`achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' }`
 * —— 返回 `null` 表示「不加额外样式」（命中时）。
 */
export function pointsBadgeStyle(point: ScorePoint): Readonly<Record<string, string>> | null {
  if (isAchieved(point)) return null;
  return {
    background: "var(--dsw-alias-bg-layer-2)",
    color: "var(--dsw-alias-label-secondary)",
  };
}

/** 得分点行的名称文本（含档位后缀）。 */
export function pointNameText(point: ScorePoint): string {
  return point.name + (point.tier !== "" ? "　" + point.tier : "");
}

/** 命中列的文本：`N 次命中` 或 `未命中`。 */
export function countedText(point: ScorePoint): string {
  return point.hits.length > 0 ? point.counted + " 次命中" : "未命中";
}

/** 上限列的文本（无上限 → `null`，不渲染）。 */
export function capText(point: ScorePoint): string | null {
  return point.cap > 0 ? "　上限 " + point.capUsed + "/" + point.cap : null;
}

/** 命中列的 tooltip。 */
export function countedTitle(point: ScorePoint): string {
  if (point.capped > 0) {
    const scope = point.scopeLabel !== "" ? point.scopeLabel : "计分口径";
    return "已计入 " + point.counted + " 次，另有 " + point.capped
      + " 条因「" + scope + "」或已达上限不计分";
  }
  return point.scopeLabel;
}

/** 得分列文本：命中 → `+N 分`；未命中 → `—`。 */
export function earnedText(point: ScorePoint): string {
  return point.earned > 0 ? "+" + point.earned + " 分" : "—";
}

/** 详情里「状态」行的文本。 */
export function statusText(point: ScorePoint): string {
  return (point.enabled ? "启用" : "停用")
    + " · " + point.points + " 分/次"
    + " · 命中 " + point.hits.length + " 次"
    + " = " + point.earned + " 分"
    + (point.selfCreated > 0 ? "（另有 " + point.selfCreated + " 次自建不计分）" : "")
    + (point.capped > 0 ? "（另有 " + point.capped + " 次同服务重复命中不计分）" : "");
}

/** 详情里「命中记录」的标题。 */
export function hitsSectionTitle(point: ScorePoint): string {
  return "命中记录 · " + point.hits.length + "（只记资产与账号密码，详细复现见报告）";
}

/** 详情里「服务封顶」行的说明尾部。 */
export const SERVICE_CAP_SUFFIX = "；账号权限与数据库权限按「同资产同端口」只算一次，拿到最高权限账号即该服务拿满";

/** 未命中时的提示（引导用户去记分，而不是干看空表）。 */
export const NO_HIT_HINT = "还没有 —— 拿下成果后用 redteam_score_hit 记分：写明目标资产 + 拿到的账号密码/权限";

/* ══════════════════════════════════════════════════════════════ 分组 */

/** 一个规则分组（8 类别之一）。 */
export interface ScoreGroup {
  readonly key: string;
  readonly name: string;
  readonly capSum: number;
  readonly points: number;
  readonly counted: number;
  readonly capped: number;
  readonly tiers: readonly ScorePoint[];
}

/** 解析一个分组。 */
export function scoreGroupOf(raw: unknown): ScoreGroup {
  const entry = recordOf(raw);
  return {
    key: text(entry["key"]),
    name: text(entry["name"]),
    capSum: countOrZero(entry["capSum"]) || countOrZero(entry["cap_sum"]),
    points: intOf(entry["points"]),
    counted: countOrZero(entry["counted"]),
    capped: countOrZero(entry["capped"]),
    tiers: arrayOf(entry["tiers"]).map(scorePointOf),
  };
}

/**
 * 分组键（后端没给 `key` 时用的兜底）。
 *
 * 原实现直接用 `'g-' + g.key` 做 React key；`key` 缺失会撞成同一个 `g-`。
 * 这里补一个稳定兜底：`group-<序号>`。
 */
export function groupKeyOf(group: ScoreGroup, index: number): string {
  return group.key !== "" ? group.key : "group-" + index;
}

/** 组头副标题：`N 项 · 各项上限合计 X 分（各项独立，不跨项累加）`。 */
export function groupSubtitle(group: ScoreGroup): string {
  const head = group.tiers.length + " 项";
  return group.capSum > 0
    ? head + " · 各项上限合计 " + group.capSum + " 分（各项独立，不跨项累加）"
    : head;
}

/* ══════════════════════════════════════════════════════════════ 汇总 */

/** 看板汇总。 */
export interface ScoreSummary {
  readonly achievedPoints: number;
  readonly pointCount: number;
  readonly hitPointCount: number;
  readonly hitCount: number;
  readonly countedHits: number;
  readonly selfCreatedHits: number;
  readonly serviceCappedHits: number;
}

/** 空汇总（未加载时的兜底，与原实现的字面量一致）。 */
export const EMPTY_SCORE_SUMMARY: ScoreSummary = Object.freeze({
  achievedPoints: 0,
  pointCount: 0,
  hitPointCount: 0,
  hitCount: 0,
  countedHits: 0,
  selfCreatedHits: 0,
  serviceCappedHits: 0,
});

/** 解析汇总。 */
export function summaryOf(raw: unknown): ScoreSummary {
  const entry = recordOf(raw);
  return {
    achievedPoints: intOf(entry["achievedPoints"]) || intOf(entry["achieved_points"]),
    pointCount: countOrZero(entry["pointCount"]) || countOrZero(entry["point_count"]),
    hitPointCount: countOrZero(entry["hitPointCount"]) || countOrZero(entry["hit_point_count"]),
    hitCount: countOrZero(entry["hitCount"]) || countOrZero(entry["hit_count"]),
    countedHits: countOrZero(entry["countedHits"]) || countOrZero(entry["counted_hits"]),
    selfCreatedHits: countOrZero(entry["selfCreatedHits"]) || countOrZero(entry["self_created_hits"]),
    serviceCappedHits: countOrZero(entry["serviceCappedHits"]) || countOrZero(entry["service_capped_hits"]),
  };
}

/** 自建不计分的 tooltip。 */
export const SELF_CREATED_SUMMARY_TITLE =
  "自己注册/自己创建的账号不算得分权限，只作过程记录（不计分、不占上限、不进报告）";

/** 服务已拿满的 tooltip。 */
export const SERVICE_CAPPED_SUMMARY_TITLE =
  "账号权限与数据库权限按「同资产同端口」只算一次：该服务已拿满，这些重复命中不计分（只作留痕）";

/* ══════════════════════════════════════════════════════════════ 看板 */

/** 看板数据。 */
export interface ScoreBoard {
  readonly items: readonly ScorePoint[];
  readonly groups: readonly ScoreGroup[];
  readonly summary: ScoreSummary;
  /** 后端是否给了 `ruleGroups`（决定是否显示组头）。 */
  readonly grouped: boolean;
}

/**
 * 解析 `op: scores` 的响应。
 *
 * **兼容分支**：后端没给 `ruleGroups`（老 host）时退回一个匿名总组 ——
 * 原先平铺的 `items` 直接塞进 `tiers`，组头因为 `name === ''` 而不渲染。
 * 这条分支丢了的话，老 host 上得分项会**整片消失**。
 */
export function scoreBoardOf(response: unknown): ScoreBoard {
  const body = recordOf(response);
  const items = arrayOf(body["items"]).map(scorePointOf);
  const rawGroups = arrayOf(body["ruleGroups"]);
  const grouped = rawGroups.length > 0;
  const groups = grouped
    ? rawGroups.map(scoreGroupOf)
    : [{
        key: "all",
        name: "",
        capSum: 0,
        points: 0,
        counted: 0,
        capped: 0,
        tiers: items,
      }];
  return {
    items,
    groups,
    summary: summaryOf(body["summary"]),
    grouped,
  };
}

/** 从错误响应里取错误文案。 */
function errorOf(response: unknown, fallback: string): string | null {
  if (response === null || response === undefined) return fallback;
  const body = recordOf(response);
  if (body["ok"] !== false) return null;
  const message = body["error"];
  return typeof message === "string" && message !== "" ? message : fallback;
}

/* ══════════════════════════════════════════════════════════════ 表单 */

/** 表单里的一行（`null` = 表单关闭）。 */
export interface ScoreForm {
  /** 编辑已有项时有 id；新增时 `null`。 */
  readonly id: number | null;
  readonly name: string;
  readonly category: string;
  readonly points: number;
  readonly description: string;
  readonly enabled: boolean;
  /** 内置项：名称/分类/分值/说明全部锁定，只能改启用。 */
  readonly builtin: boolean;
  /** 规则原文序号（仅内置项有）。 */
  readonly src: number | null;
  /** 上限（`0` = 不设上限）。 */
  readonly cap: number;
  /** 上限分组（rule）。 */
  readonly rule: number | null;
}

/** 空表单的默认值（与原实现的 `startNew` 一致：分值默认 10、启用）。 */
export const DEFAULT_POINTS = 10;

/** 新增表单。 */
export function newScoreForm(): ScoreForm {
  return {
    id: null,
    name: "",
    category: "",
    points: DEFAULT_POINTS,
    description: "",
    enabled: true,
    builtin: false,
    src: null,
    cap: 0,
    rule: null,
  };
}

/** 由已有得分点造编辑表单。 */
export function editFormOf(point: ScorePoint): ScoreForm {
  return {
    id: point.id,
    name: point.name,
    category: point.category,
    points: point.points,
    description: point.description,
    enabled: point.enabled,
    builtin: point.builtin,
    src: point.src,
    cap: point.cap,
    rule: point.rule,
  };
}

/** 改一个字段（返回新表单）。 */
export function withFormField<K extends keyof ScoreForm>(form: ScoreForm, key: K, value: ScoreForm[K]): ScoreForm {
  return { ...form, [key]: value };
}

/** 表单校验：名称不能为空。 */
export type FormCheck = Result<ScoreForm, string>;

/** 校验表单。 */
export function checkForm(form: ScoreForm): FormCheck {
  if (form.name === "") return err("名称不能为空");
  return ok(form);
}

/** 可锁定的字段。 */
export type LockedField = "name" | "category" | "points" | "description";

/** 该字段是否锁定（渲染层据此 `readOnly`）。内置项的名称/分类/分值/说明全部锁定。 */
export function isFieldLocked(form: ScoreForm): boolean {
  return form.builtin;
}

/** 字段锁定的 tooltip（空串 = 不锁，不渲染 title）。 */
export function lockedTitle(form: ScoreForm, field: LockedField): string {
  if (!form.builtin) return "";
  switch (field) {
    case "name":
      return "内置得分点的名称由规则锁定";
    case "category":
      return "内置得分点的分类由规则锁定（决定它属于面板哪一组）";
    case "points":
      return "内置得分点的分值由《得分规则》锁定，不能在这里改";
    case "description":
      return "内置得分点的条款正文由规则锁定";
  }
}

/** 分值输入框的 tooltip（非内置项）。 */
export const POINTS_HINT = "这一类的单次分值；每命中一次就按这个分值累加（受该条规则上限约束）";

/** 内置项的提示标题。 */
export const BUILTIN_NOTICE_TITLE = "内置得分点（来自《突破入侵类得分规则（合并版）》）";

/** 内置项的提示正文。 */
export const BUILTIN_NOTICE_BODY =
  "分值、上限、计分口径与名称由规则锁定 —— 同一条规则的上限按组内所有得分点累计，"
  + "单独改分值会让一条命中吃掉整组上限。这里可以改「启用 / 停用」；"
  + "要自定义分值时请返回上一屏点「+ 新增得分点」。";

/** 内置项的「不能删除」按钮文案。 */
export const BUILTIN_DELETE_LABEL = "删除（内置项不可删）";

/** 内置项「不能删除」的 tooltip。 */
export const BUILTIN_DELETE_TITLE =
  "内置得分点不能删除：删掉会让面板缺一条规则、报告少一类成果（下次启动还会自动补回来）。"
  + "要让它不参与计分请改用「停用」。";

/** 内置项提示里的规则原文行（`null` = 不渲染）。 */
export function builtinRuleText(form: ScoreForm): string | null {
  if (form.src === null && form.rule === null && form.cap === 0) return null;
  const parts: string[] = [];
  if (form.src !== null) parts.push("规则原文序号 " + form.src);
  if (form.rule !== null) parts.push("上限分组 rule=" + form.rule);
  parts.push(form.cap > 0 ? "上限 " + form.cap + " 分" : "不设上限");
  return parts.join("　·　");
}

/* ══════════════════════════════════════════════════════════════ 保存与删除 */

/** 保存结果消息。 */
export interface FormMessage {
  readonly err?: string;
  readonly ok?: string;
}

/**
 * 「已保存」那条特殊消息：内置项分值未被采纳。
 *
 * 原实现逐字如此（含换行拼接的文案）。**不能简化成「已保存」** ——
 * 那会让用户以为分值改成功了，而这正是之前的 bug 报告。
 */
export const OVERRIDDEN_MESSAGE =
  "已保存「启用/停用」。分值未改动：这是随《得分规则》分发的内置得分点，"
  + "分值 / 上限 / 计分口径由规则锁定（同一条规则的上限按组内所有得分点累计，"
  + "单独改分值会让一条命中吃掉整组上限）。要自定义分值时请「+ 新增得分点」。";

/** 保存的产出。 */
export interface SaveOutcome {
  readonly message: FormMessage;
  /** 是否应该关闭表单（成功时关闭；被 overridden 时也关闭 —— 启用态确实存了）。 */
  readonly closeForm: boolean;
  /** 是否应该重新加载看板。 */
  readonly reload: boolean;
}

/** 解析保存响应。 */
export function saveOutcomeOf(response: unknown): SaveOutcome {
  const error = errorOf(response, "保存失败");
  if (error !== null) return { message: { err: error }, closeForm: false, reload: false };
  const body = recordOf(response);
  // `overridden === false` 表示后端**没采纳**提交的分值（内置点由规则锁定）。
  if (body["overridden"] === false) {
    return { message: { err: OVERRIDDEN_MESSAGE }, closeForm: true, reload: true };
  }
  const note = text(body["note"]);
  return { message: { ok: note !== "" ? note : "已保存" }, closeForm: true, reload: true };
}

/** 删除的产出。 */
export interface DeleteOutcome {
  readonly message: FormMessage;
  readonly closeForm: boolean;
  readonly closeDetail: boolean;
  readonly reload: boolean;
}

/** 解析删除响应。 */
export function deleteOutcomeOf(response: unknown): DeleteOutcome {
  const error = errorOf(response, "删除失败");
  if (error !== null) {
    return { message: { err: error }, closeForm: false, closeDetail: false, reload: false };
  }
  return { message: { ok: "已删除" }, closeForm: true, closeDetail: true, reload: true };
}

/** 删除前的判定：新增表单（没有 id）不需要发请求，直接关掉表单。 */
export function shouldSkipDelete(form: ScoreForm | null): boolean {
  return form === null || form.id === null;
}

/* ══════════════════════════════════════════════════════════════ 请求 */

/** 请求 `op: scores`。 */
export function scoresRequest(engagement: string): ApiRequest {
  return { op: "scores", engagement };
}

/** 请求 `op: saveScorePoint`（`point` 就是整个表单）。 */
export function saveRequest(engagement: string, form: ScoreForm): ApiRequest {
  return { op: "saveScorePoint", engagement, point: form };
}

/** 请求 `op: deleteScorePoint`。 */
export function deleteRequest(engagement: string, id: number): ApiRequest {
  return { op: "deleteScorePoint", engagement, id };
}

/** 加载看板。 */
export async function loadScores(api: ApiClient, engagement: string): Promise<Result<ScoreBoard, string>> {
  const response = await api.raw(scoresRequest(engagement));
  const error = errorOf(response, "读取失败");
  if (error !== null) return err(error);
  return ok(scoreBoardOf(response));
}

/** 保存得分点。 */
export async function saveScorePoint(
  api: ApiClient,
  engagement: string,
  form: ScoreForm,
): Promise<SaveOutcome> {
  const checked = checkForm(form);
  if (!checked.ok) return { message: { err: checked.error }, closeForm: false, reload: false };
  const response = await api.raw(saveRequest(engagement, form));
  return saveOutcomeOf(response);
}

/** 删除得分点。 */
export async function removeScorePoint(
  api: ApiClient,
  engagement: string,
  id: number,
): Promise<DeleteOutcome> {
  const response = await api.raw(deleteRequest(engagement, id));
  return deleteOutcomeOf(response);
}

/* ══════════════════════════════════════════════════════════════ 空态 */

/** 未选靶标时的提示。 */
export const NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看得分目标。";

/** 无得分点时的空态。 */
export const EMPTY_POINTS_TEXT = "暂无得分点，点右上角「新增得分点」";

/** 平坦分组键（渲染 key 用）。 */
export function groupRowKey(group: ScoreGroup, index: number): string {
  return "g-" + groupKeyOf(group, index);
}

/** 详情行 key。 */
export function detailRowKey(point: ScorePoint): string {
  return "spd" + point.id;
}

/** 命中行 key。 */
export function hitRowKey(hit: ScoreHit): string {
  return "h" + hit.id;
}
