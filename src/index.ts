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
