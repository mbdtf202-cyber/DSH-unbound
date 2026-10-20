/**
 * 补丁数据模型。
 *
 * 设计要点（与原 dsh-qilin 的关键差异）：
 * 1. 原项目把 pattern 混在 JS 字符串拼接里，RegExp 与 string 混在同一字段，
 *    靠 `instanceof RegExp` 在运行时分支。这里用 discriminated union 显式建模，
 *    编译器强迫每个消费点处理两种形态。
 * 2. 原项目 `file` 有时是 string 有时是 string[]，消费点各自 `Array.isArray` 兜底。
 *    这里统一成 `readonly string[]`，在加载期归一化一次。
 * 3. 原项目用 `patterns[]+replace` 和 `replacements[]` 两套 schema 表达同一件事，
 *    引擎里靠 `patchReplacements()` 现算。这里在加载期折叠成唯一的 `replacements`，
 *    两套写作习惯仍被接受（因为 JSON 是继承来的），但内部只有一个形状。
 */

/** 字面量 pattern：逐字节 substring 匹配。 */
export interface LiteralPattern {
  readonly kind: "literal";
  readonly text: string;
}

/** 正则 pattern：用于自匹配型替换（产物包含原 pattern）。 */
export interface RegexPattern {
  readonly kind: "regex";
  readonly source: string;
  readonly flags: string;
}

export type PatchPattern = LiteralPattern | RegexPattern;

/** 一条替换：找到 pattern 就换成 replace。 */
export interface Replacement {
  readonly pattern: PatchPattern;
  readonly replace: string;
}

/**
 * 补丁状态。
 *
 * `pattern_not_found` 与 `missing_file` 必须分开：前者是上游漂移（要报），
 * 后者是宿主没装这个包（正常）。原项目两者都算失败，导致噪声。
 */
export type PatchStatus =
  | "applied"
  | "already"
  | "pattern_not_found"
  | "missing_file"
  | "read_error"
  | "write_error"
  | "skipped"
  | "na"
  | "failed";

/** 补丁定义（加载并归一化后的不可变形态）。 */
export interface PatchDefinition {
  readonly id: number;
  readonly name: string;
  readonly layer: string;
  readonly layerEn: string;
  readonly desc: string;
  /** 宿主文件 key，对应 targetFiles() 的返回。已归一为数组。 */
  readonly fileKeys: readonly string[];
  /** 相对于 aiBase 的路径片段，拼成实际文件路径。 */
  readonly rel: readonly string[];
  readonly replacements: readonly Replacement[];

  /** 已应用判定标记。默认「全部命中」；markersAny 时「任一命中」。 */
  readonly markers: readonly string[] | undefined;
  readonly markersAny: boolean;
  /** 单标记简写。 */
  readonly marker: string | undefined;
  /** 出现即视为「未应用」（用于检测半应用/被回滚的形态）。 */
  readonly forbid: readonly string[] | undefined;

  /** 命中标记时整条跳过，不再重复 replaceAll（防无限叠加）。 */
  readonly skipIfMarked: boolean;
  /** 目标宿主不要求存在：缺失不算失败。 */
  readonly optional: boolean;
  /** 限定表面：只在这些 surface 上生效。 */
  readonly surfaces: readonly string[] | undefined;
  /** 任一目标文件读失败即整条失败（默认是尽力而为）。 */
  readonly strictFiles: boolean;
  /** 布局不一致时降级为已应用（不报错）。 */
  readonly softSettle: boolean;
}

/** 加载期校验错误：宁可拒绝启动，也不要在宿主上打出半个补丁。 */
export class PatchDefinitionError extends Error {
  constructor(
    message: string,
    readonly patchId: number | undefined,
  ) {
    super(patchId === undefined ? message : `patch #${patchId}: ${message}`);
    this.name = "PatchDefinitionError";
  }
}
