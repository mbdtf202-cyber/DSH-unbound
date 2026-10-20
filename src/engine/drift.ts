/**
 * 漂移检测。
 *
 * ## 这是本项目相对 dsh-qilin 最重要的新增能力
 *
 * 补丁引擎的全部前提是「上游源码里那段文本还在」。上游一改版，pattern 就失效，
 * 补丁静默 no-op —— 用户以为「已破甲」，实际什么都没打。
 *
 * dsh-qilin 完全没有这个能力：只有人肉 "逐条重核"（见其 commit c6ce4ad）。
 * 这里把它做成**可重复执行、可进 CI、有明确退出码**的一等命令。
 *
 * ## 检测分三层
 *
 * 1. **target**：目标文件在不在宿主上。不在 = 上游移走/删掉了整块。
 * 2. **pattern**：每条替换的 pattern 能不能在目标文件里命中。
 *    全部命中 = 健康；部分命中 = 漂移（部分替换会静默跳过）；0 命中 = 彻底失效。
 * 3. **marker**：已应用标记是否已存在。用于区分「还没打」与「打完又漂了」。
 *
 * 判定必须是三态而不是布尔：`unknown`（文件缺失导致无法判定）不能当成失败，
 * 否则 optional/desktop-only 的补丁会把整次检测染红。
 */
import { isPatchApplied, matchesPattern, toLf } from "../engine/text.js";
import { readTextIfExists } from "../fs/atomic.js";
import type { PatchDefinition } from "../patches/types.js";
import { resolveTarget } from "../host/targets.js";

/** 单个补丁的漂移诊断。 */
export interface PatchDrift {
  readonly patchId: number;
  readonly name: string;
  readonly layer: string;
  /**
   * healthy    — 所有 pattern 仍命中，可以正常打
   * applied    — 已带标记（打完且未回退）
   * partial    — 部分 pattern 命中，部分失效（最危险：看起来能用）
   * dead       — 0 命中，整条失效
   * absent     — 目标文件不存在（无法判定，不算失败）
   * reverted   — 有 forbid 标记，说明曾被回滚
   * pending-upgrade — 升级链补丁（pattern 匹配自己的早先产物），干净宿主上必然不命中，非漂移
   */
  readonly state:
    | "healthy"
    | "applied"
    | "partial"
    | "dead"
    | "absent"
    | "reverted"
    | "pending-upgrade";
  readonly targetFiles: readonly string[];
  readonly totalPatterns: number;
  readonly matchedPatterns: number;
  /** 未命中的 pattern 摘要，用于人工比对（截断，不塞全文）。 */
  readonly stalePatterns: readonly string[];
}

export interface DriftReport {
  readonly aiBase: string;
  readonly generatedAt: string;
  readonly patches: readonly PatchDrift[];
  readonly summary: DriftSummary;
}

export interface DriftSummary {
  readonly total: number;
  readonly healthy: number;
  readonly applied: number;
  readonly partial: number;
  readonly dead: number;
  readonly absent: number;
  readonly reverted: number;
  /** 升级链补丁未就位（非错误）。 */
  readonly pendingUpgrade: number;
  /** partial + dead：真正需要人工介入的条数。 */
  readonly broken: number;
}

/** pattern 摘要：把换行/制表压平并截断，避免把整段源码塞进报告。 */
function summarizePattern(text: string, max = 110): string {
  const flat = text.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 判断一条补丁是不是「升级链补丁」。
 *
 * 这类补丁的 pattern 匹配的是**自己早先版本的产物**，而不是上游原文。
 * 例：#21 只匹配 `timeoutMs: 600000 # [dsh-qilin] bash timeout raised`，
 * 那是「已经应用过一次之后的形态」，用来把 600000 升级成新值。
 *
 * 后果：在**干净宿主**上它必然 0 命中 —— 这不是漂移，是设计如此。
 * 把它算进 broken 会让 drift 在干净宿主上永远返回 1，告警就废了。
 *
 * 判据：pattern 里出现本工具自己的标记字符串（`[dsh-qilin]` / `dsh-qilin:` / `dsh-unbound`）。
 * 注意 `[dsh-qilin]` 用字面量判断就够了 —— 这些是历史资产里的固定写法。
 */
export function isUpgradeChainPatch(patch: PatchDefinition): boolean {
  // 正则 source 里这些方括号是转义的（`\[dsh-qilin\]`），所以两头都查：
  // 先剥掉反斜杠再比对，避免把「转义形态」当成「不是标记」。
  const MARKERS = ["[dsh-qilin]", "dsh-qilin:", "[dsh-unbound]", "dsh-unbound:"];
  const normalize = (s: string): string => s.replace(/\\(.)/g, "$1");
  return patch.replacements.some((r) => {
    const raw = r.pattern.kind === "regex" ? r.pattern.source : r.pattern.text;
    const plain = normalize(raw);
    return MARKERS.some((m) => plain.includes(m));
  });
}

function patternTextOf(p: PatchDefinition): string[] {
  return p.replacements.map((r) =>
    r.pattern.kind === "regex" ? `/${r.pattern.source}/${r.pattern.flags}` : r.pattern.text,
  );
}

/** 诊断单条补丁。 */
export function diagnosePatch(patch: PatchDefinition, aiBase: string): PatchDrift {
  const files = new Set<string>();
  for (const key of patch.fileKeys) {
    for (const fp of resolveTarget(key, aiBase).paths) files.add(fp);
  }
  const targetFiles = [...files];

  if (targetFiles.length === 0) {
    return {
      patchId: patch.id,
      name: patch.name,
      layer: patch.layer,
      state: "absent",
      targetFiles: [],
      totalPatterns: patternTextOf(patch).length,
      matchedPatterns: 0,
      stalePatterns: [],
    };
  }

  const texts: { fp: string; text: string }[] = [];
  for (const fp of targetFiles) {
    const text = readTextIfExists(fp);
    if (text !== null) texts.push({ fp, text: toLf(text) });
  }
  if (texts.length === 0) {
    return {
      patchId: patch.id,
      name: patch.name,
      layer: patch.layer,
      state: "absent",
      targetFiles,
      totalPatterns: patternTextOf(patch).length,
      matchedPatterns: 0,
      stalePatterns: [],
    };
  }

  // 已应用判定：任一目标文件带标记即算（多写目标时，实现文件才是权威）
  const appliedSomewhere = texts.some(({ text }) => isPatchApplied(text, patch));
  // forbid 命中 = 曾经应用又被回滚
  const reverted = patch.forbid
    ? texts.some(({ text }) => patch.forbid!.some((m) => text.includes(toLf(m))))
    : false;

  let matched = 0;
  const stale: string[] = [];
  for (const replacement of patch.replacements) {
    // 一条替换只要在任一目标命中就算「这条还活着」
    const hit = texts.some(({ text }) => matchesPattern(text, replacement.pattern));
    if (hit) {
      matched += 1;
    } else {
      stale.push(
        summarizePattern(
          replacement.pattern.kind === "regex"
            ? `/${replacement.pattern.source}/`
            : replacement.pattern.text,
        ),
      );
    }
  }

  const total = patch.replacements.length;
  const upgradeChain = isUpgradeChainPatch(patch);
  let state: PatchDrift["state"];
  if (reverted) {
    state = "reverted";
  } else if (appliedSomewhere) {
    state = "applied";
  } else if (matched === total) {
    state = "healthy";
  } else if (matched === 0) {
    // 升级链补丁在干净宿主上必然 0 命中：那是「还没升级过」，不是漂移。
    state = upgradeChain ? "pending-upgrade" : "dead";
  } else {
    // 升级链补丁部分命中同样只表示所处版本阶段不同。
    state = upgradeChain ? "pending-upgrade" : "partial";
  }

  return {
    patchId: patch.id,
    name: patch.name,
    layer: patch.layer,
    state,
    targetFiles,
    totalPatterns: total,
    matchedPatterns: matched,
    stalePatterns: stale,
  };
}

/** 对一批补丁做全量诊断。 */
export function diagnoseAll(patches: readonly PatchDefinition[], aiBase: string): DriftReport {
  const results = patches.map((p) => diagnosePatch(p, aiBase));
  const count = (s: PatchDrift["state"]): number => results.filter((r) => r.state === s).length;
  const summary: DriftSummary = {
    total: results.length,
    healthy: count("healthy"),
    applied: count("applied"),
    partial: count("partial"),
    dead: count("dead"),
    absent: count("absent"),
    reverted: count("reverted"),
    pendingUpgrade: count("pending-upgrade"),
    broken: count("partial") + count("dead"),
  };
  return {
    aiBase,
    generatedAt: new Date().toISOString(),
    patches: results,
    summary,
  };
}

/**
 * 漂移报告的退出码。
 *
 * 0 — 无 broken（partial/dead 都是 0），可以放心 apply
 * 1 — 存在 broken（需要人工重核 pattern）
 *
 * 注意 absent 不算失败：桌面专属补丁在 web 宿主上本来就没有目标。
 */
export function driftExitCode(report: DriftReport): 0 | 1 {
  return report.summary.broken === 0 ? 0 : 1;
}

/** 人类可读报告（CLI 用）。 */
export function formatDriftReport(report: DriftReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`aiBase: ${report.aiBase}`);
  lines.push(
    `patches ${s.total} | healthy ${s.healthy} | applied ${s.applied} | ` +
      `partial ${s.partial} | dead ${s.dead} | absent ${s.absent} | ` +
      `reverted ${s.reverted} | pending-upgrade ${s.pendingUpgrade}`,
  );
  lines.push(`broken: ${s.broken}${s.broken > 0 ? "  ← 需要重核 pattern" : "  ✓"}`);

  const broken = report.patches.filter((p) => p.state === "partial" || p.state === "dead");
  if (broken.length > 0) {
    lines.push("");
    lines.push("— broken —");
    for (const p of broken) {
      lines.push(
        `  #${String(p.patchId).padEnd(3)} ${p.name}  ` +
          `${p.matchedPatterns}/${p.totalPatterns} ` +
          `[${p.state}] ${p.layer}`,
      );
      if (opts.verbose === true) {
        for (const fp of p.targetFiles) lines.push(`        file: ${fp}`);
        for (const sp of p.stalePatterns) lines.push(`        stale: ${sp}`);
      }
    }
  }

  if (opts.verbose === true) {
    const absent = report.patches.filter((p) => p.state === "absent");
    if (absent.length > 0) {
      lines.push("");
      lines.push("— absent (目标文件不在本宿主，非失败) —");
      for (const p of absent) lines.push(`  #${String(p.patchId).padEnd(3)} ${p.name}`);
    }
  }
  return lines.join("\n");
}
