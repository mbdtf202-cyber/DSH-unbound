/**
 * 桶文件：补丁定义与加载。
 */
export { PatchDefinitionError } from "./types.js";
export type {
  LiteralPattern,
  PatchDefinition,
  PatchPattern,
  PatchStatus,
  RegexPattern,
  Replacement,
} from "./types.js";
export {
  loadBundledPatches,
  loadPatchesFromArray,
  normalizePatch,
  resolveBundledPatchesPath,
} from "./load.js";
