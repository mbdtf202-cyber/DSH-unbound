/**
 * 红队事实库的类型层（**唯一**的数据形状定义处）。
 *
 * ## 为什么这一层值得单独存在
 *
 * 原 `store-core.js` 是 5,385 行纯 JS：258 条 SQL、334 处裸行访问（`row.xxx`）、
 * 71 个 `if (op === '...')` 分派，没有一行类型。后果不是"不好看"，而是：
 *   · 列名打错（`asset.test_surface` 写成 `test_surfacex`）只在**那条查询被调用时**报错，
 *     而调用点往往被 `catch {}` 吞掉 → 面板某一块永远空白，没人知道为什么；
 *   · 可空列当成必有值用（`row.priority` 是 NULL 时 `.toUpperCase()` 直接崩）；
 *   · `points` 从 TEXT 列读出来是 string，"50" * 2 = 100 但 "50" + 2 = "502"。
 *
 * 这一层把 DDL 的事实**逐列**搬进类型：
 *   · `NOT NULL` / `PRIMARY KEY` → 非空；
 *   · 其余（含带 `DEFAULT` 的）→ 可空。**带 DEFAULT 不等于 NOT NULL** ——
 *     SQLite 里 `INSERT ... VALUES(NULL)` 照样写 NULL，把 DEFAULT 当"必有值"
 *     等于自造一个编译器查不出的空指针。
 *
 * ## 分两类类型，不混用
 *
 * 1. `XxxRow` —— 表里的**原始行**（SQLite 输出：`null | number | string`）。
 * 2. `XxxView` —— 方法**返回**的视图（已归一化：`|| 0` / `|| ''` / JSON 已解析）。
 *    原实现直接在行上打补丁（`row.service = ...`、`detail.observations = ...`），
 *    读的人分不清哪些字段是库里的、哪些是算出来的。这里拆开。
 */

/* ══════════════════════════════════════════════════════════════ 基础别名 */

/** SQLite 能存的值（`node:sqlite` 的 `SQLInputValue`）。 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** SQLite 驱动返回的原始值。 */
export type RawValue = null | number | bigint | string | Uint8Array;

/**
 * 内网 / 外网归属、马类型、马状态：**定义在 platform 层，这里只再导出**。
 *
 * 为什么不在这里重新定义：`assertPathWithin` 那个洞就是"安全/判定代码有两份"
 * 的直接后果（词法版与软链版的差别没有任何测试能同时覆盖两份）。同一概念
 * 只留一处定义，改动只可能漏一次。
 */
export type { IpScope } from "../../platform/ip-utils.js";
export type { ShellType, ShellStatus } from "../../platform/validate.js";
import type { IpScope as IpScopeT } from "../../platform/ip-utils.js";
import type { ShellStatus as ShellStatusT, ShellType as ShellTypeT } from "../../platform/validate.js";

/* 本文件内部继续用短名，避免每个字段都写 `T` 后缀 */
type IpScope = IpScopeT;
type ShellStatus = ShellStatusT;
type ShellType = ShellTypeT;

/** 攻击链阶段 code（只有这 5 个会进分桶）。 */
export type StageCode = "recon" | "internet" | "boundary" | "internal" | "target";

/** 计分口径。 */
export type DedupScope = "service" | "system" | "target" | "none";

/** 漏洞严重级（按展示优先级排列）。 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** 漏洞处置状态。 */
export type VulnStatus = "candidate" | "confirmed" | "false-positive" | "exploited" | "fixed";

/** 资产测试状态。 */
export type TestStatus = "untested" | "testing" | "tested" | "blocked" | "abandoned" | "no_surface";

/** 资产易打性优先级。 */
export type Priority = "high" | "medium" | "low";

/** 隧道的"目标侧那一端"：决定这条通道算不算跨越靶标边界。 */
export type TunnelEntryKind = "target-outbound" | "target-http" | "target-agent" | "self-only";

/** 隧道状态。 */
export type TunnelStatus = "active" | "down" | "closed" | "unknown";

/** 攻击文件类型。 */
export type AttackFileKind = "poc" | "exp" | "script" | "wordlist" | "other";

/** POC 类型。 */
export type PocKind = "poc" | "exp" | "script" | "template" | "payload";

/** POC 来源。 */
export type PocSource = "web" | "self" | "manual" | "nuclei-template" | "kb";

/** 证据截图类型：现场截图 vs 由记录生成的摘录卡（**不能混**）。 */
export type ShotKind = "screenshot" | "card";

/* ══════════════════════════════════════════════════════════════ 23 张表的行类型 */

/** `scan_run` —— 一次采集动作（哪个工具、什么参数、什么时候）。 */
export interface ScanRunRow {
  readonly id: number;
  readonly agent_session_id: string | null;
  readonly tool: string | null;
  readonly argv: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly status: string | null;
}

/** `segment` —— C 段（IPv6 是 /64）。主键是 cidr 文本。 */
export interface SegmentRow {
  readonly cidr: string;
  readonly ip_start: string | null;
  readonly ip_end: string | null;
  readonly org: string | null;
  readonly asn: string | null;
  readonly country: string | null;
  readonly city: string | null;
  readonly source: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
}

/** `asset` —— 一台资产。`scope` 是后补列（迁移来的），所以可空。 */
export interface AssetRow {
  readonly id: number;
  readonly segment_cidr: string;
  readonly ip: string;
  readonly ip_int: number | null;
  readonly state: string | null;
  readonly primary_name: string | null;
  readonly confidence: number | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly discovered_at: string | null;
  readonly test_status: string | null;
  readonly test_notes: string | null;
  readonly test_surface: string | null;
  readonly test_updated_at: string | null;
  readonly test_updated_by: string | null;
  readonly blocked_count: number | null;
  readonly priority: string | null;
  readonly potential: string | null;
  readonly assess_reason: string | null;
  readonly assessed_at: string | null;
  readonly assessed_by: string | null;
  /** 迁移补列：internal | external（手工指定优先于按 IP 推导）。 */
  readonly scope: string | null;
}

/** `asset_name` —— 资产上的域名/别名（一台资产多个名字）。 */
export interface AssetNameRow {
  readonly id: number;
  readonly asset_id: number;
  readonly name: string;
  readonly kind: string | null;
  readonly provenance: string | null;
  readonly tool: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
}

/** `port` —— 资产上的端口。`url` / `title` 是后补列。 */
export interface PortRow {
  readonly id: number;
  readonly asset_id: number;
  readonly proto: string | null;
  readonly port: number;
  readonly state: string | null;
  readonly provenance: string | null;
  readonly tool: string | null;
  readonly banner: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
}

/** `service` —— 端口上的服务指纹。 */
export interface ServiceRow {
  readonly id: number;
  readonly port_id: number;
  readonly name: string | null;
  readonly product: string | null;
  readonly version: string | null;
  readonly cpe: string | null;
  readonly provenance: string | null;
  readonly tool: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
}

/** `fingerprint` —— 组件指纹（category/vendor/product/version）。 */
export interface FingerprintRow {
  readonly id: number;
  readonly asset_id: number;
  readonly port_id: number | null;
  readonly category: string | null;
  readonly vendor: string | null;
  readonly product: string | null;
  readonly version: string | null;
  readonly evidence: string | null;
  readonly confidence: number | null;
  readonly provenance: string | null;
  readonly tool: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
}

/** `observation` —— 一条观测事实（谁在什么时候、用什么手段看见的）。 */
export interface ObservationRow {
  readonly id: number;
  readonly entity_kind: string;
  readonly entity_id: number;
  readonly attr: string | null;
  readonly value: string | null;
  readonly provenance: string | null;
  readonly tool: string | null;
  readonly scan_run_id: number | null;
  readonly collected_at: string | null;
  readonly raw_ref: string | null;
}

/** `edge` —— 实体之间的关系（domain→asset、asset→port…）。 */
export interface EdgeRow {
  readonly id: number;
  readonly src_kind: string;
  readonly src_id: string;
  readonly dst_kind: string;
  readonly dst_id: string;
  readonly relation: string;
  readonly confidence: number | null;
  readonly scan_run_id: number | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
}

/** `tag` —— 打在某实体上的标签（复合主键 → 三列都非空）。 */
export interface TagRow {
  readonly entity_kind: string;
  readonly entity_id: number;
  readonly tag: string;
  readonly note: string | null;
  readonly created_by: string | null;
  readonly created_at: string | null;
}

/** `vuln` —— 一条漏洞。`target` / `found_by_agent` / `found_at` / `gained` / `agent` 都是后补列。 */
export interface VulnRow {
  readonly id: number;
  readonly asset_id: number | null;
  readonly port_id: number | null;
  readonly cve: string | null;
  readonly title: string | null;
  readonly severity: string | null;
  readonly source: string | null;
  readonly confidence: number | null;
  readonly status: string | null;
  readonly evidence: string | null;
  readonly target: string | null;
  readonly found_by_agent: string | null;
  readonly found_at: string | null;
  readonly gained: string | null;
  readonly agent: string | null;
}

/** `score_point` —— 一个得分点（规则号/档位/上限/计分口径）。`code` 是 UNIQUE → 可空。 */
export interface ScorePointRow {
  readonly id: number;
  readonly code: string | null;
  readonly name: string;
  readonly category: string | null;
  readonly points: number | null;
  readonly max_hits: number | null;
  readonly description: string | null;
  readonly enabled: number | null;
  readonly sort_order: number | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly src: number | null;
  readonly rule: number | null;
  readonly tier: string | null;
  readonly cap: number | null;
  readonly dedup_scope: string | null;
  readonly legacy: number | null;
  readonly builtin: number | null;
}

/** `stage` —— 作战阶段（主键是 code）。`sections` 是 JSON 文本。 */
export interface StageRow {
  readonly code: string;
  readonly name: string;
  readonly subtitle: string | null;
  readonly color: string | null;
  readonly goal: string | null;
  readonly sections: string | null;
  readonly tools: string | null;
  readonly transition: string | null;
  readonly sort_order: number | null;
  readonly updated_at: string | null;
}

/** `score_hit` —— 一次得分记录。`points` 为 NULL 表示用得分点默认分值。 */
export interface ScoreHitRow {
  readonly id: number;
  readonly point_id: number;
  readonly asset_id: number | null;
  readonly vuln_id: number | null;
  readonly step_id: number | null;
  readonly target: string | null;
  readonly evidence: string | null;
  readonly note: string | null;
  readonly self_created: number | null;
  readonly port: number | null;
  readonly recorded_by: string | null;
  readonly recorded_at: string | null;
  readonly points: number | null;
  readonly multiplier: number | null;
  readonly stage_code: string | null;
}

/** `credential` —— 一条凭据（明文存 `secret_value`，`secret_ref` 指向证据文件）。 */
export interface CredentialRow {
  readonly id: number;
  readonly asset_id: number | null;
  readonly host: string | null;
  readonly username: string | null;
  readonly secret_type: string | null;
  readonly secret_value: string | null;
  readonly secret_ref: string | null;
  readonly privilege: string | null;
  readonly source: string | null;
  readonly tool: string | null;
  readonly note: string | null;
  readonly found_by_agent: string | null;
  readonly found_at: string | null;
  readonly agent: string | null;
}

/** `access_session` —— 一次可控访问（横向移动的起点）。 */
export interface AccessSessionRow {
  readonly id: number;
  readonly asset_id: number | null;
  readonly host: string | null;
  readonly username: string | null;
  readonly method: string | null;
  readonly privilege: string | null;
  readonly session_ref: string | null;
  readonly note: string | null;
  readonly found_by_agent: string | null;
  readonly obtained_at: string | null;
}

/** `webshell` —— 已上线的可控入口。`url` NOT NULL，其余可空。 */
export interface WebshellRow {
  readonly id: number;
  readonly asset_id: number | null;
  readonly url: string;
  readonly shell_type: string | null;
  readonly pass_key: string | null;
  readonly secret_ref: string | null;
  readonly privilege: string | null;
  readonly status: string | null;
  readonly last_check: string | null;
  readonly check_note: string | null;
  readonly latency_ms: number | null;
  readonly note: string | null;
  readonly found_by_agent: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly agent: string | null;
}

/** `tunnel` —— 内网隧道（suo5 / socks5 / ssh -R / frp…）。`entry_kind` 是边界突破的凭证字段。 */
export interface TunnelRow {
  readonly id: number;
  readonly asset_id: number | null;
  readonly webshell_id: number | null;
  readonly kind: string | null;
  readonly listen: string | null;
  readonly entry: string | null;
  readonly reach: string | null;
  readonly entry_kind: string | null;
  readonly status: string | null;
  readonly last_check: string | null;
  readonly check_note: string | null;
  readonly latency_ms: number | null;
  readonly pid: string | null;
  readonly command: string | null;
  readonly note: string | null;
  readonly found_by_agent: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly agent: string | null;
}

/** `http_evidence` —— 原始请求/响应（可直贴 Burp / Yakit）。 */
export interface HttpEvidenceRow {
  readonly id: number;
  readonly vuln_id: number | null;
  readonly asset_id: number | null;
  readonly label: string | null;
  readonly method: string | null;
  readonly url: string | null;
  readonly status: number | null;
  readonly request: string | null;
  readonly response: string | null;
  readonly note: string | null;
  readonly captured_by: string | null;
  readonly captured_at: string | null;
}

/** `attack_file` —— 实际生效的脚本/POC/EXP。`target` / `name` / `path` NOT NULL。 */
export interface AttackFileRow {
  readonly id: number;
  readonly target: string;
  readonly target_kind: string | null;
  readonly name: string;
  readonly kind: string | null;
  readonly path: string;
  readonly description: string | null;
  readonly evidence: string | null;
  readonly asset_id: number | null;
  readonly vuln_id: number | null;
  readonly created_by: string | null;
  readonly created_at: string | null;
}

/** `attack_step` —— 攻击链的一步。`stage_code` 是后补列，`stage` 是旧的兜底列。 */
export interface AttackStepRow {
  readonly id: number;
  readonly seq: number | null;
  readonly stage: string | null;
  readonly stage_code: string | null;
  readonly title: string | null;
  readonly detail: string | null;
  readonly asset_id: number | null;
  readonly vuln_id: number | null;
  readonly access_id: number | null;
  readonly point_id: number | null;
  readonly evidence_ref: string | null;
  readonly tool: string | null;
  readonly agent: string | null;
  readonly result: string | null;
  readonly recorded_by: string | null;
  readonly recorded_at: string | null;
}

/** `shot` —— 证据截图（库里只存文件名，图片在 `<靶标>/shots/`）。`file` NOT NULL。 */
export interface ShotRow {
  readonly id: number;
  readonly point_id: number | null;
  readonly hit_id: number | null;
  readonly asset_id: number | null;
  readonly vuln_id: number | null;
  readonly target: string | null;
  readonly label: string | null;
  readonly note: string | null;
  readonly file: string;
  readonly kind: string | null;
  readonly mime: string | null;
  readonly bytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly sha256: string | null;
  readonly source_ref: string | null;
  readonly captured_at: string | null;
  readonly found_by_agent: string | null;
  readonly agent: string | null;
  readonly created_at: string | null;
}

/** `poc` —— 知识库条目（全局共享，跨靶标）。`code` / `title` NOT NULL。 */
export interface PocRow {
  readonly id: number;
  readonly code: string;
  readonly title: string;
  readonly kind: string | null;
  readonly category: string | null;
  readonly cve: string | null;
  readonly component: string | null;
  readonly versions: string | null;
  readonly severity: string | null;
  readonly language: string | null;
  readonly source: string | null;
  readonly source_url: string | null;
  readonly description: string | null;
  readonly usage: string | null;
  readonly content: string | null;
  readonly path: string | null;
  readonly verified: number | null;
  readonly verified_note: string | null;
  readonly hit_count: number | null;
  readonly used_on: string | null;
  readonly engagement_id: string | null;
  readonly engagement_name: string | null;
  readonly asset_target: string | null;
  readonly found_by_agent: string | null;
  readonly tags: string | null;
  readonly created_by: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

/**
 * 表名 → 行类型的映射。
 * 用途：`store.rows<T>("asset")` 这类通用读法能拿到正确类型，而不是 `Record<string, unknown>`。
 */
export interface TableRowMap {
  readonly scan_run: ScanRunRow;
  readonly segment: SegmentRow;
  readonly asset: AssetRow;
  readonly asset_name: AssetNameRow;
  readonly port: PortRow;
  readonly service: ServiceRow;
  readonly fingerprint: FingerprintRow;
  readonly observation: ObservationRow;
  readonly edge: EdgeRow;
  readonly tag: TagRow;
  readonly vuln: VulnRow;
  readonly score_point: ScorePointRow;
  readonly stage: StageRow;
  readonly score_hit: ScoreHitRow;
  readonly credential: CredentialRow;
  readonly access_session: AccessSessionRow;
  readonly webshell: WebshellRow;
  readonly tunnel: TunnelRow;
  readonly http_evidence: HttpEvidenceRow;
  readonly attack_file: AttackFileRow;
  readonly attack_step: AttackStepRow;
  readonly shot: ShotRow;
  readonly poc: PocRow;
}

/** 表名联合。 */
export type TableName = keyof TableRowMap;

/** 全部表名（顺序与 DDL 一致；测试用它核对"23 张表都建出来了"）。 */
export const TABLE_NAMES: readonly TableName[] = [
  "scan_run", "segment", "asset", "asset_name", "port", "service", "fingerprint",
  "observation", "edge", "tag", "vuln", "score_point", "stage", "score_hit",
  "credential", "access_session", "webshell", "tunnel", "http_evidence",
  "attack_file", "attack_step", "shot", "poc",
];

/* ══════════════════════════════════════════════════════════════ 领域常量类型 */

/** 攻击链阶段定义（`DEFAULT_STAGES` 的元素）。 */
export interface DefaultStage {
  readonly code: StageCode;
  readonly name: string;
  readonly subtitle: string;
  readonly color: string;
  /** 0 = 这一阶段本身不直接得分（信息收集）。 */
  readonly scored: number;
  readonly goal: string;
  readonly sections: readonly { readonly label: string; readonly items: readonly string[] }[];
  readonly tools: string;
  readonly transition: string;
}

/** 得分点的交付口径（怎么算拿到 / 拿什么自证 / 怎么复现）。 */
export interface ScoreConfirm {
  readonly need: string;
  readonly proof: string;
  readonly replay: string;
  readonly script: string;
}

/** 得分点的界面分组（8 个类别）。 */
export interface ScoreGroup {
  readonly code: string;
  readonly name: string;
}

/** 一条默认得分点的完整定义。 */
export interface ScorePointDef {
  /** 《合并版》里的原序号（对账用）。 */
  readonly src: number;
  /** 内部上限分组键（1..N 连续唯一）。 */
  readonly rule: number;
  readonly tier: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly points: number;
  readonly cap: number;
  readonly dedup_scope: DedupScope;
  readonly description: string;
  /**
   * 默认启用状态（0 = 停用）。
   * 上游 `seedScorePoints` 读 `point.enabled === 0 ? 0 : 1` —— 定义里可以带这个字段。
   */
  readonly enabled?: number;
  /** 1 = 旧版口径的默认点（播种时转 legacy 停用，只作历史参照）。 */
  readonly legacy?: number;
}

/** 通用规则 G1-G8。 */
export interface GeneralRule {
  readonly code: string;
  readonly name: string;
  readonly detail: string;
}

/** POC 归类（面板按它分组）。 */
export interface PocCategory {
  readonly code: string;
  readonly name: string;
  readonly hint: string;
}
