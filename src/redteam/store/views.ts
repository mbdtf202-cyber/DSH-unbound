/**
 * 方法**返回**的视图类型。
 *
 * 与 `types.ts` 的 `XxxRow` 分开：Row 是 SQLite 原样输出（`null | number | string`），
 * View 是归一化后的形态（`|| 0` / `|| ''` / JSON 已解析 / 算了派生字段）。
 *
 * 原实现直接在行对象上打补丁（`row.service = ...`、`detail.observations = ...`），
 * 读代码时分不清哪些字段来自库里、哪些是算出来的。分开之后，
 * "这个字段可能是 undefined 吗"从"翻 500 行找赋值"变成"看类型"。
 */
import type {
  AssetRow, CredentialRow, DedupScope, IpScope, PocRow, ScoreHitRow, ScorePointRow,
  Severity, ShellStatus, ShellType, ShotKind, StageCode, TestStatus, TunnelStatus, TunnelEntryKind, VulnStatus,
} from "./types.js";

/* ══════════════════════════════════════════════════════════════ 靶标与统计 */

/** `listEngagements()` 的一行。 */
export interface EngagementSummary {
  readonly id: string;
  readonly name: string;
  readonly scope: readonly string[];
  readonly status: string;
  readonly created_at: string | null;
  readonly stats: TargetStats | null;
}

/** `openEngagement()` 的返回。 */
export interface OpenedEngagement {
  readonly id: string;
  readonly name: string;
  readonly scope: readonly string[];
}

/** `stats()` 的一屏计数。 */
export interface TargetStats {
  readonly segments: number;
  readonly assets: number;
  readonly liveAssets: number;
  readonly openPorts: number;
  readonly services: number;
  readonly fingerprints: number;
  readonly passiveSignals: number;
  readonly activeSignals: number;
  readonly vulns: number;
  readonly credentials: number;
  readonly accesses: number;
  readonly untestedAssets: number;
  readonly blockedAssets: number;
}

/** 控制台"未读"摘要里的一个页签。 */
export interface DigestSection {
  readonly count: number;
  readonly at: string | null;
}

/** `consoleDigest()` 的返回。 */
export interface ConsoleDigest {
  readonly engagement: string;
  readonly at: string;
  readonly sections: Readonly<Record<string, DigestSection>>;
}

/** `testStats()` 的返回。 */
export interface TestStats {
  readonly untested: number;
  readonly testing: number;
  readonly tested: number;
  readonly blocked: number;
  readonly abandoned: number;
  readonly no_surface: number;
}

/** `vulnStats()` 的返回。 */
export interface VulnStats {
  readonly total: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly withGained: number;
  readonly withEvidence: number;
  readonly targetGroups: number;
}

/* ══════════════════════════════════════════════════════════════ 资产 */

/** 资产列表/详情里的一个端口（含 JOIN 来的服务字段）。 */
export interface AssetPortView {
  readonly port: number;
  readonly proto: string | null;
  readonly state: string | null;
  readonly provenance: string | null;
  readonly banner: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly service: string | null;
  readonly product: string | null;
  readonly version: string | null;
}

/** 资产列表里的一个指纹。 */
export interface AssetFingerprintView {
  readonly category: string | null;
  readonly vendor: string | null;
  readonly product: string | null;
  readonly version: string | null;
  readonly evidence: string | null;
  readonly provenance: string | null;
}

/** 资产列表里的一个名字。 */
export interface AssetNameView {
  readonly name: string;
  readonly kind: string | null;
  readonly provenance: string | null;
}

/** `assetRow()` 的产物：资产行 + 归一化字段 + 子表。 */
export interface AssetView {
  readonly id: number;
  readonly ip: string;
  readonly segment_cidr: string;
  readonly state: string | null;
  readonly primary_name: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly discovered_at: string | null;
  readonly test_status: TestStatus;
  readonly test_notes: string;
  readonly test_surface: string;
  readonly test_updated_at: string | null;
  readonly test_updated_by: string | null;
  readonly blocked_count: number;
  readonly priority: string | null;
  readonly potential: string;
  readonly assess_reason: string;
  readonly assessed_at: string | null;
  readonly assessed_by: string | null;
  readonly scope: IpScope;
  readonly open_ports: number;
  readonly ports: readonly AssetPortView[];
  readonly fingerprints: readonly AssetFingerprintView[];
  readonly names: readonly AssetNameView[];
  readonly passive: number;
  readonly active: number;
}

/** `getAsset()` 的详情：资产视图 + 观测/边。 */
export interface AssetDetail extends AssetView {
  readonly observations: readonly {
    readonly attr: string | null;
    readonly value: string | null;
    readonly provenance: string | null;
    readonly tool: string | null;
    readonly collected_at: string | null;
  }[];
  readonly edges: readonly {
    readonly src_kind: string;
    readonly src_id: string;
    readonly dst_kind: string;
    readonly dst_id: string;
    readonly relation: string;
    readonly confidence: number | null;
  }[];
}

/** `listAssets()` 的返回。 */
export interface AssetListResult {
  readonly total: number;
  readonly sort: string;
  readonly items: readonly AssetView[];
}

/** 图谱节点。 */
export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/** 图谱边。 */
export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
}

/** `graph()` / `attackGraph()` 的返回。 */
export interface GraphResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/* ══════════════════════════════════════════════════════════════ 得分 */

/** `listStages()` 的一行。 */
export interface StageView {
  readonly code: string;
  readonly name: string;
  readonly subtitle: string;
  readonly color: string;
  readonly goal: string;
  readonly sections: readonly unknown[];
  readonly tools: string;
  readonly transition: string;
  readonly ordinal: number;
  readonly updated_at: string | null;
}

/** 得分面板里的一条命中。 */
export interface ScoreHitView {
  readonly id: number;
  readonly asset_id: number | null;
  readonly vuln_id: number | null;
  readonly step_id: number | null;
  readonly target: string | null;
  readonly evidence: string | null;
  readonly note: string | null;
  readonly points: number;
  readonly points_overridden: boolean;
  readonly port: number | null;
  readonly self_created: boolean;
  readonly capped: boolean;
  readonly capped_by_id: number | null;
  readonly capped_reason: string | null;
  readonly capped_reason_kind: "dedup" | "cap" | null;
  readonly recorded_by: string | null;
  readonly recorded_at: string | null;
  readonly service: string;
  readonly capped_by?: string | null;
  shot_count?: number;
}

/** 得分点面板里的一项（含其命中）。 */
export interface ScorePointView {
  readonly id: number;
  readonly code: string | null;
  readonly name: string;
  readonly category: string | null;
  readonly points: number | null;
  readonly rule: number | null;
  readonly tier: string | null;
  readonly cap: number;
  readonly dedup_scope: DedupScope;
  readonly src: number | null;
  readonly builtin: boolean;
  readonly legacy: boolean;
  readonly counted: number;
  readonly earned: number;
  readonly self_created: number;
  readonly capped: number;
  readonly capped_hits: readonly ScoreHitView[];
  readonly cap_used: number | null;
  readonly cap_capped: number;
  readonly scope_label: string;
  readonly service_summary: string | null;
  readonly description: string;
  readonly enabled: boolean;
  readonly sort_order: number | null;
  readonly hits: readonly ScoreHitView[];
  shots?: readonly ShotBrief[];
  shot_total?: number;
  shot_shown?: number;
}

/** 得分点按类别的分组。 */
export interface ScoreRuleGroup {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly capSum: number;
  readonly points: number;
  readonly counted: number;
  readonly capped: number;
  readonly order: number;
  readonly tiers: readonly ScorePointView[];
}

/** `listScorePoints()` 的汇总。 */
export interface ScoreSummary {
  readonly achievedPoints: number;
  readonly pointCount: number;
  readonly hitPointCount: number;
  readonly hitCount: number;
  readonly countedHits: number;
  readonly selfCreatedHits: number;
  readonly serviceCappedHits: number;
  readonly cappedByDedup: number;
  readonly cappedByRuleLimit: number;
  readonly legacyPointCount: number;
  readonly legacyHitCount: number;
  readonly latestCapped: {
    readonly hit_id: number;
    readonly point_id: number;
    readonly code: string | null;
    readonly service: string;
    readonly evidence: string | null;
    readonly points: number;
    readonly recorded_at: string | null;
    readonly reason: string;
  } | null;
}

/** `listScorePoints()` 的返回。 */
export interface ScoreBoard {
  readonly items: readonly ScorePointView[];
  readonly ruleGroups: readonly ScoreRuleGroup[];
  readonly summary: ScoreSummary;
}

/** `addScoreHit()` 的返回。 */
export interface ScoreHitAdded {
  readonly id: number;
  readonly point_id: number;
  readonly point: string | null;
  readonly base_points: number;
  readonly multiplier: number;
  readonly multiplier_reasons: readonly string[] | undefined;
  readonly points: number;
  readonly port: number | null;
  readonly service: string | null;
  readonly volume: { readonly rows: number | null; readonly min_rows: number; readonly meets_threshold: boolean | null } | null;
  readonly self_created: boolean;
  readonly counted: boolean;
  readonly capped_by_service: boolean;
  readonly capped_by: string | null;
  readonly demoted_hits: readonly { readonly id: number; readonly evidence: string | null; readonly points: number }[];
  readonly warning: string | undefined;
  readonly summary: ScoreSummary;
}

/** `saveScorePoint()` 的返回。 */
export interface ScorePointSaved {
  readonly id: number;
  readonly code: string | null;
  readonly updated: boolean;
  readonly builtin: boolean;
  readonly overridden: boolean;
  readonly points: number | null;
  readonly cap?: number | null;
  readonly rule?: number | null;
  readonly locked_fields?: readonly string[];
  readonly note: string;
}

/* ══════════════════════════════════════════════════════════════ 会话与证据 */

/** `listWebshells()` 的一行。 */
export interface WebshellView {
  readonly id: number;
  readonly asset_id: number | null;
  readonly url: string;
  readonly shell_type: ShellType | string | null;
  readonly pass_key: string | null;
  readonly secret_ref: string | null;
  readonly privilege: string | null;
  readonly status: ShellStatus | string | null;
  readonly last_check: string | null;
  readonly check_note: string | null;
  readonly latency_ms: number | null;
  readonly note: string | null;
  readonly found_by_agent: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly agent: string | null;
  readonly asset_ip: string | null;
}

/** `listTunnels()` 的一行：隧道 + legit 判定。 */
export interface TunnelView {
  readonly id: number;
  readonly asset_id: number | null;
  readonly webshell_id: number | null;
  readonly kind: string | null;
  readonly listen: string | null;
  readonly entry: string | null;
  readonly reach: string | null;
  readonly entry_kind: TunnelEntryKind | string | null;
  readonly status: TunnelStatus | string | null;
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
  readonly asset_ip: string | null;
  readonly webshell_url: string | null;
  readonly legit: boolean | null;
  readonly entry_kind_label: string | null;
}

/** `sessionSummary()` 的返回。 */
export interface SessionSummary {
  readonly webshells: readonly WebshellView[];
  readonly tunnels: readonly TunnelView[];
  readonly totals: {
    readonly webshells: number;
    readonly webshellsOnline: number;
    readonly tunnels: number;
    readonly tunnelsActive: number;
    readonly tunnelsLegit: number;
    readonly tunnelsSelfOnly: number;
    readonly credentials: number;
    readonly access: number;
  };
}

/** `probeSessions()` 的返回。 */
export interface ProbeResult {
  readonly webshells: readonly { readonly id: number; readonly url: string; readonly status: string; readonly note: string; readonly latency_ms: number }[];
  readonly tunnels: readonly { readonly id: number; readonly kind: string | null; readonly listen: string | null; readonly status: string; readonly note: string; readonly latency_ms: number }[];
  readonly checkedAt: string;
}

/** 证据截图摘要（面板/报告用）。 */
export interface ShotBrief {
  readonly id: number;
  readonly url: string;
  readonly label: string;
  readonly note: string;
  readonly kind: ShotKind | string;
  readonly mime: string;
  readonly bytes: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly target: string;
  readonly captured_at: string;
  readonly source_ref: string;
}

/** `listShots()` 的一行。 */
export interface ShotListItem {
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
  readonly point_code: string | null;
  readonly point_name: string | null;
  readonly url: string;
}

/* ══════════════════════════════════════════════════════════════ 知识库 */

/** `pocStats()` 的返回。 */
export interface PocStats {
  readonly total: number;
  readonly verified: number;
  readonly withContent: number;
  readonly reused: number;
  readonly uncategorized: number;
  /** 最早/最近建立时间：**时间戳字符串**（上游原样返回 `MIN/MAX(created_at)`），空库为 0。 */
  readonly earliest: number | string;
  readonly latest: number | string;
  readonly byKind: readonly { readonly kind: string; readonly n: number }[];
  readonly bySource: readonly { readonly source: string; readonly n: number }[];
  readonly byCategory: readonly { readonly code: string; readonly name: string; readonly hint: string; readonly n: number; readonly verified: number }[];
  readonly byEngagement: readonly { readonly engagement: string; readonly n: number; readonly latest: string | null }[];
  readonly topAssets: readonly { readonly asset_target: string; readonly n: number }[];
  readonly topComponents: readonly { readonly component: string; readonly n: number }[];
  readonly categories: readonly { readonly code: string; readonly name: string; readonly hint: string }[];
  readonly dbPath: string;
}

/** `searchPocs()` 的一行（列表视图，不含正文）。 */
export interface PocListItem {
  readonly id: number;
  readonly code: string;
  readonly title: string;
  readonly kind: string | null;
  readonly category: string | null;
  readonly cve: string | null;
  readonly component: string | null;
  readonly versions: string | null;
  readonly severity: Severity | string | null;
  readonly language: string | null;
  readonly source: string | null;
  readonly source_url: string | null;
  readonly description: string | null;
  readonly usage: string | null;
  readonly path: string | null;
  readonly verified: number | null;
  readonly verified_note: string | null;
  readonly hit_count: number | null;
  readonly used_on: string | null;
  readonly tags: string | null;
  readonly engagement_id: string | null;
  readonly engagement_name: string | null;
  readonly asset_target: string | null;
  readonly found_by_agent: string | null;
  readonly created_by: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly content_bytes: number;
  readonly has_content: number;
}

/** `searchTemplates()` 的一行。 */
export interface TemplateHit {
  readonly path: string;
  readonly name: string;
  readonly severity: string;
  readonly tags: string;
}

/** `searchTemplates()` / `templateStats()` 的返回。 */
export interface TemplateSearch {
  readonly dir: string | null;
  readonly total: number;
  readonly items: readonly TemplateHit[];
}

/** `templateStats()` 的返回。 */
export interface TemplateStats {
  readonly dir: string | null;
  readonly total: number;
  readonly cve: number;
}

/* ══════════════════════════════════════════════════════════════ 报告 */

/** 一条得分的"怎么来的"追踪。 */
export interface HitTrace {
  readonly engagement_dir: string | null;
  readonly steps: readonly TracedStep[];
  readonly vuln: TracedVuln | null;
  readonly credentials: readonly TracedCredential[];
  readonly accesses: readonly TracedAccess[];
  readonly webshells: readonly TracedShell[];
  readonly tunnels: readonly TracedTunnel[];
  readonly how: string;
  readonly step_source: string | null;
  readonly evidence_refs: readonly string[];
  readonly complete: boolean;
  readonly gaps: readonly string[];
}

/** 追踪里的一步。 */
export interface TracedStep {
  readonly id: number;
  readonly seq: number | null;
  readonly stage_code: string | null;
  readonly title: string;
  readonly detail: string;
  readonly tool: string;
  readonly result: string;
  readonly agent: string;
  readonly recorded_at: string | null;
  readonly vuln_id: number | null;
  readonly asset_id: number | null;
  readonly point_id: number | null;
  readonly evidence_ref: string;
  readonly inferred: boolean;
}

/** 追踪到的漏洞。 */
export interface TracedVuln {
  readonly id: number;
  readonly cve: string | null;
  readonly title: string | null;
  readonly severity: string | null;
  readonly status: string | null;
  readonly target: string | null;
  readonly evidence: string | null;
  readonly gained: string | null;
  readonly source: string | null;
  readonly found_by_agent: string | null;
  readonly found_at: string | null;
}

/** 追踪到的凭据。 */
export interface TracedCredential {
  readonly id: number;
  readonly host: string | null;
  readonly username: string | null;
  readonly secret_value: string | null;
  readonly secret_type: string | null;
  readonly privilege: string | null;
  readonly source: string | null;
  readonly tool: string | null;
  readonly agent: string | null;
  readonly found_at: string | null;
}

/** 追踪到的访问会话。 */
export interface TracedAccess {
  readonly id: number;
  readonly host: string | null;
  readonly username: string | null;
  readonly method: string | null;
  readonly privilege: string | null;
  readonly session_ref: string | null;
  readonly obtained_at: string | null;
}

/** 追踪到的马。 */
export interface TracedShell {
  readonly id: number;
  readonly url: string | null;
  readonly shell_type: string | null;
  readonly pass_key: string | null;
  readonly privilege: string | null;
  readonly status: string | null;
  readonly agent: string | null;
}

/** 追踪到的隧道。 */
export interface TracedTunnel {
  readonly id: number;
  readonly kind: string | null;
  readonly listen: string | null;
  readonly entry: string | null;
  readonly reach: string | null;
  readonly entry_kind: string | null;
  readonly status: string | null;
  readonly command: string | null;
  readonly agent: string | null;
  readonly legit: boolean | null;
}

/** 报告里的原始请求。 */
export interface ReportRequest {
  readonly label: string;
  readonly method: string | null;
  readonly url: string | null;
  readonly status: number | null;
  readonly request: string;
  readonly response: string;
  readonly note: string | null;
  readonly source: "linked" | "auto";
}

/** `scoreReport()` 的一条正文条目。 */
export interface ReportItem {
  readonly seq: number;
  readonly id: number;
  readonly point_id: number;
  /** 命中所属资产 id（附录对账与阶段归属要用；`asset_ip` 只是展示用）。 */
  readonly asset_id: number | null;
  readonly step_id: number | null;
  readonly point_rule: number | null;
  readonly point_tier: string;
  readonly point_cap: number;
  readonly point_dedup: string;
  readonly code: string;
  readonly stage_code: string;
  readonly point_name: string;
  readonly category: string;
  readonly points: number;
  readonly counted: boolean;
  readonly nth_of_point: number;
  readonly target: string;
  readonly asset_ip: string;
  readonly gained: string;
  readonly vuln: { readonly id: number; readonly title: string; readonly cve: string | null; readonly severity: string | null } | null;
  readonly evidence: string;
  readonly note: string;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly requests: readonly ReportRequest[];
  readonly missing_evidence: boolean;
  readonly replay_cmd: string | null;
  readonly replay_cmd_kind: string | null;
  readonly replay_cmd_unfilled: readonly string[] | undefined;
  readonly replay_http: string | null;
  readonly replay_http_synthesized: boolean;
  readonly replay_http_rebuilt: boolean;
  readonly http_entry: boolean;
  readonly replay_source: string | null;
  readonly confirm: { readonly need: string; readonly proof: string; readonly replay: string; readonly script: string } | null;
  readonly confirm_missing: boolean;
  readonly trace: HitTrace;
  readonly how: string;
  readonly steps: readonly TracedStep[];
  readonly credentials: readonly TracedCredential[];
  readonly accesses: readonly TracedAccess[];
  readonly webshells: readonly TracedShell[];
  readonly tunnels: readonly TracedTunnel[];
  readonly incomplete: boolean;
  readonly gaps: readonly string[];
  shots: readonly ShotBrief[];
  shot_total: number;
  is_group?: boolean;
  group_size?: number;
  order_at?: string;
  group_targets?: readonly { readonly id: number; readonly target: string; readonly points: number; readonly evidence: string; readonly recorded_at: string }[];
  chain_no?: number;
  deps?: readonly { readonly no: number; readonly name: string; readonly short: string; readonly target: string }[];
  needs_channel?: boolean;
  repro_kind?: "http" | "cli" | "method";
  repro_http_captured?: boolean;
  repro_nonhttp?: boolean;
}

/** `scoreReport()` 的阶段分桶。 */
export interface ReportStage {
  readonly code: string;
  readonly name: string;
  readonly color: string | null;
  readonly goal: string | null;
  readonly transition: string | null;
  readonly ordinal: number;
  readonly points: number;
  readonly cumulative: number;
  readonly items: readonly ReportItem[];
}

/** `scoreReport()` 的汇总。 */
export interface ReportSummary {
  readonly count: number;
  readonly points: number;
  readonly withRequests: number;
  readonly autoMatched: number;
  readonly missingRequests: number;
  readonly withSteps: number;
  readonly withCommands: number;
  readonly incomplete: number;
  readonly credentials: number;
  readonly tunnels: number;
  readonly selfCreatedExcluded: number;
  readonly serviceCappedExcluded: number;
  readonly disabledExcluded: number;
  readonly serviceCapped: readonly {
    readonly id: number;
    readonly point_name: string;
    readonly code: string | null;
    readonly service: string;
    readonly evidence: string;
    readonly target: string;
    readonly points: number;
    readonly recorded_at: string;
  }[];
}

/** `scoreReport()` 的返回。 */
export interface ScoreReport {
  readonly items: readonly ReportItem[];
  readonly stages: readonly ReportStage[];
  readonly summary: ReportSummary;
  readonly markdown: string;
  readonly target: string;
}

/** `scoreChain()` 的返回。 */
export interface ScoreChain {
  readonly items: readonly ChainItem[];
  readonly stages: readonly ChainStage[];
  readonly achieved: readonly { readonly id: number; readonly code: string | null; readonly name: string; readonly category: string | null }[];
  readonly missing: readonly { readonly id: number; readonly code: string | null; readonly name: string; readonly category: string | null }[];
  readonly summary: {
    readonly hits: number;
    readonly points: number;
    readonly totalPoints?: number;
    readonly countedHits: number;
    readonly achievedCount: number;
    readonly missingCount: number;
    readonly missingPoints: number;
    readonly selfCreatedHits: number;
    readonly serviceCappedHits: number;
    readonly tunnelsLegit: number;
    readonly tunnelsSelfOnly: number;
  };
}

/** `scoreChain()` 里的一条。 */
export interface ChainItem {
  readonly id: number;
  readonly point_id: number;
  readonly asset_id: number | null;
  readonly vuln_id: number | null;
  readonly step_id: number | null;
  readonly target: string | null;
  readonly evidence: string | null;
  readonly note: string | null;
  readonly code: string | null;
  readonly point_name: string | null;
  readonly category: string | null;
  readonly point_default: number;
  readonly points: number;
  readonly multiplier: number | null;
  readonly asset_ip: string | null;
  readonly vuln_title: string | null;
  readonly vuln_cve: string | null;
  action: { readonly id: number; readonly seq: number | null; readonly stage: string | null; readonly title: string | null; readonly detail: string | null } | null;
  action_inferred: boolean;
  self_created: boolean;
  capped: boolean;
  port: number | null;
  service: string | null;
  capped_reason_kind: "dedup" | "cap" | null;
  rule: number | null;
  rule_cap: number;
  capped_reason: string | null;
  nth_of_point: number;
  counted: boolean;
  stage_code?: string;
}

/** `scoreChain()` 的阶段。 */
export interface ChainStage {
  readonly code: string;
  readonly name: string;
  readonly subtitle: string;
  readonly color: string;
  readonly goal: string;
  readonly sections: readonly unknown[];
  readonly tools: string;
  readonly transition: string;
  readonly ordinal: number;
  readonly updated_at: string | null;
  readonly items: readonly ChainItem[];
  readonly hits: number;
  readonly counted: number;
  readonly points: number;
  readonly cumulative: number;
  readonly assets: readonly unknown[];
  readonly assetCount: number;
  readonly tunnels: readonly TunnelView[];
  readonly tunnels_self_only: readonly TunnelView[];
  readonly steps: number;
}

/** `report()` 的返回。 */
export interface VulnReport {
  readonly markdown: string;
  readonly generated_at: string;
  readonly stats: {
    readonly results: number;
    readonly bySeverity: Readonly<Record<string, number>>;
    readonly exploited: number;
    readonly filteredOut: number;
    readonly accesses: number;
    readonly credentials: number;
    readonly chainSteps: number;
  };
}

/** `reportTargets()` 的一个目标分组。 */
export interface ReportTarget {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly segment: string;
  readonly stats: {
    readonly vulns: number;
    readonly bySeverity: Readonly<Record<string, number>>;
    readonly accesses: number;
    readonly credentials: number;
    readonly files: number;
    readonly chainSteps: number;
  };
  readonly markdown: string;
}

/** `reportTargets()` 的返回。 */
export interface ReportTargets {
  readonly generated_at: string;
  readonly engagement: { readonly id: string; readonly name: string; readonly scope: readonly string[] };
  readonly groups: readonly { readonly cidr: string; readonly targets: readonly ReportTarget[] }[];
  readonly targets: readonly ReportTarget[];
  readonly totals: {
    readonly targets: number;
    readonly vulns: number;
    readonly accesses: number;
    readonly credentials: number;
    readonly files: number;
    readonly filteredOut: number;
  };
}

/* ══════════════════════════════════════════════════════════════ 提示词 */

/** `listPrompts()` 的一行。 */
export interface PromptRole {
  readonly role: string;
  readonly title: string;
  readonly planner: boolean;
  readonly dispatcher: boolean;
  readonly content: string;
  readonly updated_at: string | null;
}

/** `refreshDefaultPrompts()` 的返回。 */
export interface PromptRefresh {
  readonly changed: number;
  readonly kept: readonly string[];
  readonly created: number;
}

/** `addScoreHit` 入参（未类型化输入的窄化结果）。 */
export interface ScoreHitInput {
  readonly point_id?: unknown;
  readonly code?: unknown;
  readonly point_name?: unknown;
  readonly evidence?: unknown;
  readonly asset_id?: unknown;
  readonly vuln_id?: unknown;
  readonly step_id?: unknown;
  readonly target?: unknown;
  readonly note?: unknown;
  readonly recorded_by?: unknown;
  readonly self_created?: unknown;
  readonly points?: unknown;
  readonly port?: unknown;
  readonly ip_version?: unknown;
  readonly data_scale?: unknown;
  readonly stage_code?: unknown;
  readonly system_key?: unknown;
}

/* 供 store 内部使用的窄别名（避免每个方法都写长名）。 */
export type { AssetRow, CredentialRow, PocRow, ScoreHitRow, ScorePointRow, StageCode, VulnStatus, TestStatus, TunnelStatus, Severity, IpScope, DedupScope, ShellType, ShellStatus, ShotKind, TunnelEntryKind };

/** `listWeb()` 的一行：端口 + 资产 + 服务。 */
export interface WebRow {
  readonly port_id: number;
  readonly port: number;
  readonly proto: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly banner: string | null;
  readonly provenance: string | null;
  readonly tool: string | null;
  readonly asset_id: number;
  readonly ip: string;
  readonly segment_cidr: string;
  readonly primary_name: string | null;
  readonly state: string | null;
  readonly service: string | null;
  readonly product: string | null;
  readonly version: string | null;
}
