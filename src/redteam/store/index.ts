/**
 * 红队存储层的公开接口。
 *
 * 对外只暴露三类东西：
 *   1. `RedteamStore` —— 事实库本体；
 *   2. `dispatch` / `dispatchAsync` —— 统一 op 分派（面板、CLI、工具共用）；
 *   3. 类型与纯函数 —— 供 W2（工具层）/ W3（控制台）按类型接，不读实现。
 *
 * 内部模块（`sqlite` / `meta` / `schema` 的实现细节）不在这里导出：
 * W2/W3 只需要 `HostContext` + 这些类型，不该依赖"我用的哪个 SQLite 包装"。
 */
export { RedteamStore, pngSize, promptHash } from "./store.js";
export type { ImageSize } from "./store.js";
export { dispatch, dispatchAsync, KNOWN_OPS } from "./dispatch.js";
export type { DispatchResult } from "./dispatch.js";

/* ── 表行类型（W2/W3 直接 `import type { AssetRow }`）────────────────── */
export type {
  TableRowMap, TableName,
} from "./types.js";
export type {
  ScanRunRow, SegmentRow, AssetRow, AssetNameRow, PortRow, ServiceRow, FingerprintRow,
  ObservationRow, EdgeRow, TagRow, VulnRow, ScorePointRow, StageRow, ScoreHitRow,
  CredentialRow, AccessSessionRow, WebshellRow, TunnelRow, HttpEvidenceRow, AttackFileRow,
  AttackStepRow, ShotRow, PocRow,
  SqlValue, RawValue, IpScope, StageCode, DedupScope, Severity, VulnStatus, TestStatus,
  Priority, TunnelEntryKind, TunnelStatus, ShellStatus, ShellType, AttackFileKind,
  PocKind, PocSource, ShotKind,
  DefaultStage, ScoreConfirm, ScoreGroup, ScorePointDef, GeneralRule, PocCategory,
} from "./types.js";
export { TABLE_NAMES } from "./types.js";

/* ── 方法返回的视图类型 ────────────────────────────────────────────── */
export type {
  EngagementSummary, OpenedEngagement, TargetStats, DigestSection, ConsoleDigest,
  TestStats, VulnStats,
  AssetPortView, AssetFingerprintView, AssetNameView, AssetView, AssetDetail, AssetListResult,
  GraphNode, GraphEdge, GraphResult, WebRow,
  StageView, ScoreHitView, ScorePointView, ScoreRuleGroup, ScoreSummary, ScoreBoard,
  ScoreHitAdded, ScorePointSaved,
  WebshellView, TunnelView, SessionSummary, ProbeResult, ShotBrief, ShotListItem,
  PocStats, PocListItem, TemplateHit, TemplateSearch, TemplateStats,
  HitTrace, TracedStep, TracedVuln, TracedCredential, TracedAccess, TracedShell, TracedTunnel,
  ReportRequest, ReportItem, ReportStage, ReportSummary, ScoreReport,
  ChainItem, ChainStage, ScoreChain, VulnReport, ReportTarget, ReportTargets,
  PromptRole, PromptRefresh, ScoreHitInput,
} from "./views.js";

/* ── 领域常量与纯函数（面板要用来渲染下拉框、工具要用来校验）─────────── */
export {
  ROLE_TITLES, ROLE_ORDER, PLANNER_ROLE, SEVERITIES, VULN_STATUSES,
  POC_KINDS, POC_SOURCES, VALID_TEST_STATUSES, VALID_PRIORITIES, TUNNEL_STATUSES,
  ATTACK_FILE_KINDS,
} from "./constants.js";
export {
  DEFAULT_STAGES, POINT_STAGE_OVERRIDE, POINT_SHORT_NAME, LEGACY_STAGE_MAP, VALID_STAGE_CODES,
} from "./data/stages.js";
export { DEFAULT_PROMPTS } from "./data/prompts.js";
export {
  DEFAULT_SCORE_POINTS, SCORE_GROUPS, SCORE_GENERAL_RULES, SCORE_CONFIRM, scoreConfirmOf,
} from "./data/score-points.js";
export {
  HAS_FTS5, POC_CATEGORIES, pocCategoryName, guessPocCategory, migrate, migrateKnowledge,
  SCOPE_SQL, LEGACY_STAGE_MAP as SCHEMA_LEGACY_STAGE_MAP,
} from "./schema.js";
export type { MigrationOutcome } from "./schema.js";
export {
  TUNNEL_ENTRY_KINDS, tunnelIsLegit, ACCOUNT_POINT_CODES, SERVICE_CAPPED_POINT_CODES,
  parseTargetPort, normalizePort, targetAuthority, scoreServiceKey, serviceLabel,
  systemKeyOf, applyScoreCaps, evaluateScoreBoard, scoreCapReasonText, serviceCapReason,
  hitPointsOf, scoreMultiplierOf, scoreStageOf, targetKey, scoreMetaFromRow,
  parseRowCount, formatRows, SENSITIVE_DATA_MIN_ROWS,
} from "./score.js";
export type {
  ScoreHitLike, ScoreMeta, ScoredHit, RuleCapUsage, ScoreCapsResult, MultiplierResult,
  BoardRow, BoardResult,
} from "./score.js";
export {
  parseTarget, commandKind, parseCurl, buildHttpRequest, buildCurlCommand, fillTemplate,
} from "./replay.js";
export type {
  ParsedTarget, CommandKind, ParsedCurl, BuildHttpRequestOptions, BuildCurlCommandOptions,
  TemplateValues, FilledTemplate,
} from "./replay.js";
export { readMeta, writeMeta, metaString, metaList } from "./meta.js";
export type { EngagementMeta } from "./meta.js";
