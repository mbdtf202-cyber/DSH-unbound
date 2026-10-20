/**
 * 桶文件：对外只暴露稳定 API。
 */
export { applyPatchToText, isPatchApplied, matchesPattern, patchHasRemainingWork, toLf } from "./text.js";
export type { ApplyTextResult } from "./text.js";
export {
  applyPatches,
  collectTargets,
  detectSurfaceFromPath,
  revertPatches,
  selectPatches,
} from "./apply.js";
export type { ApplyOptions, ApplyReport, ApplySummary, PatchOutcome } from "./apply.js";
export { diagnoseAll, diagnosePatch, driftExitCode, formatDriftReport } from "./drift.js";
export type { DriftReport, DriftSummary, PatchDrift } from "./drift.js";
