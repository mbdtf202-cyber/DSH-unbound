/**
 * 补丁应用引擎。
 *
 * ## 相对原实现的结构性改进
 *
 * 1. **不再需要一个 _patchTargetAiBase 全局变量**。原实现用一个模块级变量
 *    记住「当前在打哪个 aiBase」，供 targetFiles() 内部使用——这让同一进程内
 *    并发处理多个宿主变得不安全。这里把 aiBase 一路作为参数传下去。
 *
 * 2. **状态判定顺序显式化**。原实现的 rollupPatchStatus 有 6 个 if，
 *    条件互相重叠（strictFiles/applied/already/missing/lastError），
 *    很难推理。这里改成表格驱动 + 穷举测试。
 *
 * 3. **写回前先比内容**。原实现只要 changed 就写，导致 mtime 每次都变，
 *    外部 watcher（宿主自己）会反复触发。这里 changed 且内容真的不同才写。
 *
 * 4. **幂等性成为契约**。第二次 apply 必须 0 写入、0 变化，
 *    由测试强约束（原实现靠 skipIfMarked 手工保证，漏一处就无限膨胀）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyPatchToText,
  contendedMarkers,
  isPatchApplied,
  patchHasRemainingWork,
  patchOwnsItsMarkers,
  toLf,
} from "./text.js";
import { atomicWriteFileSync, ensureBackupSync, isRegularFile, readTextIfExists } from "../fs/atomic.js";
import type { PatchDefinition, PatchStatus } from "../patches/types.js";
import { resolveTarget } from "../host/targets.js";

/** 单个补丁在一组目标文件上的应用结果。 */
export interface PatchOutcome {
  readonly patchId: number;
  readonly name: string;
  readonly layer: string;
  readonly status: PatchStatus;
  /** 实际被修改的文件。 */
  readonly changedFiles: readonly string[];
  /** 目标文件（不论是否改动）。 */
  readonly targetFiles: readonly string[];
  /** 有 pattern 没命中（漂移信号，即使 status 是 applied 也值得看）。 */
  readonly notFoundPatterns: number;
  /** 错误信息（status 为 *_error / failed 时）。 */
  readonly error: string | undefined;
}

export interface ApplyReport {
  readonly aiBase: string;
  readonly outcomes: readonly PatchOutcome[];
  readonly summary: ApplySummary;
  /** 被写入的文件（去重）。用于外部工具做「我需要重启宿主」的判断。 */
  readonly writtenFiles: readonly string[];
}

export interface ApplySummary {
  readonly total: number;
  readonly applied: number;
  readonly already: number;
  readonly patternNotFound: number;
  readonly missingFile: number;
  readonly skipped: number;
  readonly failed: number;
  /** 本次真正改动的文件数。首次 apply > 0，第二次必须为 0。 */
  readonly filesChanged: number;
}

export interface ApplyOptions {
  /** 只处理这些 surface（default: 不过滤）。 */
  readonly surface?: string;
  /** 干跑：算出会发生什么，但不写盘。 */
  readonly dryRun?: boolean;
  /** 只处理指定 id。 */
  readonly only?: readonly number[];
  /** 跳过指定 id。 */
  readonly skip?: readonly number[];
}

/** surface 过滤 + id 过滤。 */
export function selectPatches(
  patches: readonly PatchDefinition[],
  opts: ApplyOptions = {},
): readonly PatchDefinition[] {
  return patches.filter((p) => {
    if (opts.only !== undefined && opts.only.length > 0 && !opts.only.includes(p.id)) return false;
    if (opts.skip !== undefined && opts.skip.includes(p.id)) return false;
    if (opts.surface !== undefined && p.surfaces !== undefined && !p.surfaces.includes(opts.surface)) return false;
    return true;
  });
}

/**
 * 收集一个补丁的所有目标文件。
 *
 * 返回 `{ paths, missingKeys }`：missingKeys 是「宿主上找不到的 key」。
 * 调用方需要区分「全部 key 都缺」（=目标不存在）与「部分缺」（=正常，某些文件可选）。
 */
export function collectTargets(
  patch: PatchDefinition,
  aiBase: string,
): { paths: readonly string[]; missingKeys: readonly string[] } {
  const paths: string[] = [];
  const missingKeys: string[] = [];
  for (const key of patch.fileKeys) {
    const resolved = resolveTarget(key, aiBase).paths;
    if (resolved.length === 0) {
      missingKeys.push(key);
      continue;
    }
    for (const fp of resolved) {
      if (!paths.includes(fp)) paths.push(fp);
    }
  }
  return { paths, missingKeys };
}

/** 根据「每条替换在各文件上的命中/落地情况」汇总状态。 */
function rollupStatus(input: {
  readonly appliedCount: number;
  readonly alreadyCount: number;
  readonly notFoundCount: number;
  readonly totalReplacements: number;
  readonly readErrors: number;
  readonly writeErrors: number;
  readonly missingKeys: number;
  readonly totalKeys: number;
  readonly strictFiles: boolean;
  readonly softSettle: boolean;
  readonly optional: boolean;
}): PatchStatus {
  const {
    appliedCount,
    alreadyCount,
    notFoundCount,
    totalReplacements,
    readErrors,
    writeErrors,
    missingKeys,
    totalKeys,
    strictFiles,
    softSettle,
    optional,
  } = input;

  // 写失败永远优先：那是真的没打成。
  if (writeErrors > 0) return "write_error";
  // strictFiles：读失败即整条失败（目标文件必须存在且可读）
  if (strictFiles && readErrors > 0) return "read_error";
  // 所有目标 key 都找不到
  if (missingKeys === totalKeys) {
    // optional 的目标缺失是正常的（如桌面专属补丁在 web 上）
    return optional ? "na" : "missing_file";
  }
  if (appliedCount > 0) return "applied";
  if (alreadyCount > 0) {
    // already + 有 pattern 没命中 = 布局变了但标记还在 → softSettle 认为没问题
    if (notFoundCount === 0 || softSettle) return "already";
    return "pattern_not_found";
  }
  if (readErrors > 0) return "read_error";
  if (notFoundCount >= totalReplacements) return "pattern_not_found";
  // 到这里说明所有替换都因 YAML/identity 规则被跳过
  return "skipped";
}

/**
 * 把一批补丁应用到某个 aiBase。
 *
 * 全程串行：这些是宿主正在使用的文件，并发写没有收益，只有互相踩踏的风险。
 */
export function applyPatches(
  patches: readonly PatchDefinition[],
  aiBase: string,
  opts: ApplyOptions = {},
): ApplyReport {
  const selected = selectPatches(patches, opts);
  const outcomes: PatchOutcome[] = [];
  const written = new Set<string>();

  // 标记争用：被多条命中同一批文件的补丁共用的标记，无法证明「是哪一条打的」。
  // 这类标记不能作为 already 的凭据，否则后一条补丁会被前一条的标记永久遮蔽（#73 即此）。
  const contended = contendedMarkers(selected, (p) => collectTargets(p, aiBase).paths);

  /**
   * 仅 dryRun 使用：虚拟写入内容。
   *
   * 多条补丁会命中**同一个文件**（实测 `agent-loop` 被 #55/#67/#74/#87/#89 共用）。
   * 真跑时前一条写入后，后一条读到的是新内容；dryRun 不写盘，若每条都重读磁盘，
   * 后一条就会看到**前一条尚未生效的旧内容** —— 于是 dryRun 报出的 status 与真跑不一致
   * （实测 #87 会从 applied 误报成 pattern_not_found）。用 overlay 让预演同序。
   */
  const overlay = new Map<string, string>();

  for (const patch of selected) {
    outcomes.push(applyOne(patch, aiBase, opts, written, contended, overlay));
  }

  const count = (s: PatchStatus): number => outcomes.filter((o) => o.status === s).length;
  const summary: ApplySummary = {
    total: outcomes.length,
    applied: count("applied"),
    already: count("already"),
    patternNotFound: count("pattern_not_found"),
    missingFile: count("missing_file"),
    skipped: count("skipped") + count("na"),
    failed: count("read_error") + count("write_error") + count("failed"),
    filesChanged: written.size,
  };

  return { aiBase, outcomes, summary, writtenFiles: [...written].sort() };
}

/** 这条补丁声明的标记里，是否有被别的补丁争用的。 */
function hasContendedMarker(patch: PatchDefinition, contended: ReadonlySet<string>): boolean {
  const ms = [...(patch.markers ?? []), ...(patch.marker === undefined ? [] : [patch.marker])];
  return ms.some((m) => contended.has(toLf(m)));
}

function applyOne(
  patch: PatchDefinition,
  aiBase: string,
  opts: ApplyOptions,
  written: Set<string>,
  contended: ReadonlySet<string>,
  overlay: Map<string, string>,
): PatchOutcome {
  const { paths, missingKeys } = collectTargets(patch, aiBase);

  if (paths.length === 0) {
    return {
      patchId: patch.id,
      name: patch.name,
      layer: patch.layer,
      status: patch.optional ? "na" : "missing_file",
      changedFiles: [],
      targetFiles: [],
      notFoundPatterns: 0,
      error: undefined,
    };
  }

  let appliedCount = 0;
  let alreadyCount = 0;
  let notFoundCount = 0;
  let readErrors = 0;
  let writeErrors = 0;
  let firstError: string | undefined;
  const changedFiles: string[] = [];

  for (const fp of paths) {
    let text: string | null;
    try {
      // dryRun 时优先读「本该写入」的虚拟内容，保证预演与真跑同序。
      text = overlay.get(fp) ?? readTextIfExists(fp);
    } catch (cause) {
      readErrors += 1;
      firstError ??= `${fp}: ${(cause as Error).message}`;
      continue;
    }
    if (text === null) {
      readErrors += 1;
      firstError ??= `${fp}: unreadable`;
      continue;
    }

    // 标记是否足以证明「这条补丁已经打过了」。
    // 标记能否单独证明「这条已经打过了」。三种情况：
    //
    //   1. 标记是我自己写的（#70）                → 能。照常 already。
    //   2. 借来的标记，但没有被争用（单补丁场景）  → 能。保持原行为，不误伤。
    //   3. 借来的标记 + 被争用（#73）             → 不能单独证明，改用「还有没有活干」。
    //
    // 情况 3 的关键：纯删除型补丁（#73 替换值只是 "\n"）在文件里**不留任何痕迹**，
    // 唯一的线索就是「它的 pattern 还在不在」。
    //   - pattern 还在  → 这条补丁的工作没做 → 不能算 already（否则永久遮蔽，#73 原 bug）
    //   - pattern 没了  → 要么打过了，要么上游改版。后者无法区分，
    //                     而标记确实存在于同一批文件上，按「打过」处理更符合实际。
    const ownsMarker = patchOwnsItsMarkers(patch);
    const markerContended = hasContendedMarker(patch, contended);
    const markersTrustworthy = ownsMarker || !markerContended;
    /** 情况 3 的补充判据：没有剩余工作，才算它已经打完。 */
    const settledWithoutMarker = !ownsMarker && markerContended && !patchHasRemainingWork(text, patch, fp);

    // 已应用 + skipIfMarked → 完全不动（防重复插入）
    if (patch.skipIfMarked && isPatchApplied(text, patch) && (markersTrustworthy || settledWithoutMarker)) {
      alreadyCount += 1;
      continue;
    }

    // 关键区分（照原实现在 filePatchSettled 里的语义）：
    //   「already」只能由 markers/marker/replace 首行命中来证明 **已经应用过**；
    //   「没有剩余工作」不能证明已应用 —— 上游改版把 pattern 换掉时同样没有剩余工作，
    //   那叫漂移（pattern_not_found），不是已完成。早先把两者混同会让漂移静默显示为 already。
    //
    // 标记被争用时连这一条也不能用：那正是 #73 被误判的入口。
    if (isPatchApplied(text, patch) && (markersTrustworthy || settledWithoutMarker)) {
      alreadyCount += 1;
      continue;
    }

    // 布局软补丁：没有残留 pattern 即视为已完成（官方副本布局不同，别再报漂移）。
    if (patch.softSettle && !patchHasRemainingWork(text, patch, fp)) {
      alreadyCount += 1;
      continue;
    }

    let result;
    try {
      // 关掉内置的 skipIfMarked 短路：上面已经用标记争用判定过了，
      // 再让内层无条件短路会把它推翻（#73 就死在这一层）。
      result = applyPatchToText(text, patch, fp, { respectSkipIfMarked: false });
    } catch (cause) {
      writeErrors += 1;
      firstError ??= `${fp}: ${(cause as Error).message}`;
      continue;
    }

    appliedCount += result.appliedCount;
    notFoundCount += result.notFoundCount;

    if (!result.changed) continue;

    // 内容真的不同才写：避免无谓的 mtime 抖动与宿主 watcher 反复触发
    if (toLf(result.text) === toLf(text)) {
      alreadyCount += 1;
      continue;
    }

    if (opts.dryRun === true) {
      // 不写盘，但把内容记进 overlay：后续补丁要看到与真跑一致的状态。
      overlay.set(fp, result.text);
      changedFiles.push(fp);
      continue;
    }

    try {
      ensureBackupSync(fp);
      atomicWriteFileSync(fp, result.text);
      changedFiles.push(fp);
      written.add(fp);
    } catch (cause) {
      writeErrors += 1;
      firstError ??= `${fp}: ${(cause as Error).message}`;
    }
  }

  const status = rollupStatus({
    appliedCount,
    alreadyCount,
    notFoundCount,
    totalReplacements: patch.replacements.length * paths.length,
    readErrors,
    writeErrors,
    missingKeys: missingKeys.length,
    totalKeys: patch.fileKeys.length,
    strictFiles: patch.strictFiles,
    softSettle: patch.softSettle,
    optional: patch.optional,
  });

  return {
    patchId: patch.id,
    name: patch.name,
    layer: patch.layer,
    status,
    changedFiles,
    targetFiles: paths,
    notFoundPatterns: notFoundCount,
    error: firstError,
  };
}

/**
 * 从备份还原一个 aiBase 上所有被本工具改过的文件。
 *
 * 只还原「有备份的」文件：没备份说明我们没动过它，
 * 还原它等于用旧版覆盖用户刚升级的宿主。
 */
export function revertPatches(
  patches: readonly PatchDefinition[],
  aiBase: string,
  opts: { dryRun?: boolean } = {},
): { readonly restored: readonly string[]; readonly missing: readonly string[] } {
  const seen = new Set<string>();
  const restored: string[] = [];
  const missing: string[] = [];

  for (const patch of patches) {
    const { paths } = collectTargets(patch, aiBase);
    for (const fp of paths) {
      if (seen.has(fp)) continue;
      seen.add(fp);
      const backup = fp + ".dsh-unbound.bak";
      const legacy = fp + ".dshqilin.bak";
      const source = isRegularFile(backup) ? backup : isRegularFile(legacy) ? legacy : null;
      if (source === null) {
        missing.push(fp);
        continue;
      }
      if (opts.dryRun === true) {
        restored.push(fp);
        continue;
      }
      const content = fs.readFileSync(source, "utf8");
      atomicWriteFileSync(fp, content);
      restored.push(fp);
    }
  }
  return { restored, missing };
}

/** 从目录名推断 surface（web / desktop）。 */
export function detectSurfaceFromPath(aiBase: string): "web" | "desktop" {
  const n = path.normalize(aiBase).replace(/\\/g, "/").toLowerCase();
  if (n.includes("/resources/app") || n.includes(".app/contents")) return "desktop";
  return "web";
}
