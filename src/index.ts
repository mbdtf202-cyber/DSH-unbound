/**
 * dsh-unbound
 *
 * 类型安全的 DeepSeek Harness 宿主补丁引擎。
 */
export { loadBundledPatches, loadPatchesFromArray } from "./patches/index.js";
export type { PatchDefinition, PatchStatus, PatchPattern, Replacement } from "./patches/index.js";
export {
  applyPatches,
  applyPatchToText,
  diagnoseAll,
  diagnosePatch,
  driftExitCode,
  formatDriftReport,
  isPatchApplied,
  revertPatches,
  toLf,
} from "./engine/index.js";
export type {
  ApplyOptions,
  ApplyReport,
  ApplySummary,
  DriftReport,
  DriftSummary,
  PatchDrift,
  PatchOutcome,
} from "./engine/index.js";
export { discoverHosts, findDshHome, findHost } from "./host/discover.js";
export type { HostCandidate } from "./host/discover.js";
export { isAiBase, resolveAllTargets, resolveTarget } from "./host/targets.js";
export type { TargetResolution } from "./host/targets.js";
export { atomicWriteFileSync, ensureBackupSync, findBackup, restoreFromBackupSync } from "./fs/atomic.js";

// ───────────────────────────── 插件生命周期层 ─────────────────────────────

/**
 * 插件层对外只暴露**稳定的入口与契约**，不导出内部助手函数。
 *
 * 理由：宿主只认 Cordis 的 `{ name, inject, apply }` 三件套；
 * 其余导出是给本仓库其他工作流（UI / 工具 / 平台）用的稳定接口，
 * 以及给测试用的纯函数。内部实现细节（`addPromptSection` 之类）不外露，
 * 避免被当成 API 依赖后无法重构。
 */
export { apply, inject, name, plugin } from "./plugin/index.js";
export type { PluginConfig } from "./plugin/index.js";

export {
  GLOBAL_PROMPT_ORDER,
  installAssembleGuard,
  isRedteamPresetId,
  isRedteamSession,
  rewritePromptAssembly,
  sessionAgentPreset,
} from "./plugin/identity.js";
export type {
  AssembledPrompt,
  AssembleRewrite,
  PromptSection,
  RewriteOptions,
  RewrittenAssembly,
} from "./plugin/identity.js";

export { CAPABILITY_SECTION, capabilityProtocolText } from "./plugin/capability-protocol.js";
export type { CapabilityProtocolOptions } from "./plugin/capability-protocol.js";

export { stripHarnessPersona } from "./plugin/persona.js";

export {
  HUNG_CACHE_MS,
  InjectRefreshCache,
  PromptState,
  hashOverride,
  normalizeOverride,
} from "./plugin/prompt-state.js";
export type { ResolvedInject } from "./plugin/prompt-state.js";

export {
  applyShouldRestart,
  DESKTOP_SETTLE_DELAY_MS,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
} from "./plugin/settle-policy.js";
export type { ApplyShouldRestartInput, ContextLife, SettleScope, Surface } from "./plugin/settle-policy.js";

export {
  ancestorChainForCwd,
  listRules,
  RULE_TARGETS,
  rulesStatus,
  scanCwdInstructions,
  WORKSPACE_POLICIES,
} from "./plugin/rules.js";
export type { CwdCandidate, RuleEntry, RulesStatus, WorkspacePolicy } from "./plugin/rules.js";

export {
  listSkills,
  parseSkillDocument,
  pathsOverlap,
  resolvePhysical,
  skillsStatus,
} from "./plugin/skills.js";
export { validSkillName } from "./plugin/skills.js";
export type { SkillRecord, SkillsStatus } from "./plugin/skills.js";
