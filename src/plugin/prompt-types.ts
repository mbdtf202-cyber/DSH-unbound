/**
 * 提示词装配的共享类型。
 *
 * ## 为什么单独一层
 *
 * 宿主的 `assemble()` 返回的对象是**结构化但未声明**的：`sections` 可能是数组，
 * 也可能被别的插件替换成函数；`text` 可能是字符串，也可能是 `(context) => string`
 * 的惰性求值函数（`systemPrompt.section({ text })` 官方就吃这两种）。
 *
 * 原 `dsh-qilin` 全用 JS，靠 `typeof section.text === "string"` 在各处手工兜。
 * 这里把「段」的形状编成类型，让调用点必须显式窄化一次，而不是靠记忆。
 */

/** 段正文：字符串，或惰性求值回调（宿主 section 注册用）。 */
export type SectionText = string | ((context?: unknown) => unknown);

/**
 * 提示词装配里的一段。
 *
 * `[key: string]: unknown` 是**故意**保留的：段对象是宿主和其他插件共享的，
 * 他们会往上挂自己的字段（`source`、`priority`、`id`…）。用 `...section` 复制时
 * 必须把未知字段原样带过去，否则会悄悄破坏别人的段。
 */
export interface PromptSection {
  readonly name?: string;
  readonly text?: SectionText;
  readonly order?: number;
  readonly interpolate?: boolean;
  readonly [key: string]: unknown;
}

/** 宿主 `assemble()` 的返回值（宽松形态：字段都可能不存在）。 */
export interface AssembledPrompt {
  readonly sections?: unknown;
  readonly contexts?: unknown;
  readonly tools?: unknown;
  readonly [key: string]: unknown;
}

/**
 * 改写后的装配结果。
 *
 * `sections` 一定是数组；`contexts` / `tools` 一定存在（原实现会补空数组，
 * 因为下游 `renderPrompt` 直接读 `.length`，缺了就炸）。
 */
export interface RewrittenAssembly extends AssembledPrompt {
  readonly sections: readonly PromptSection[];
  readonly contexts: unknown;
  readonly tools: unknown;
}

/** 取段的字符串正文；函数形态与缺失一律当空串（只用于需要「文本」的场景）。 */
export function sectionText(section: PromptSection | null | undefined): string {
  if (section === null || section === undefined) return "";
  const text = section.text;
  return typeof text === "string" ? text : "";
}

/** 取段名；缺失当空串。 */
export function sectionName(section: PromptSection | null | undefined): string {
  if (section === null || section === undefined) return "";
  const name = section.name;
  return typeof name === "string" ? name : "";
}

/** 是不是一个「有 sections 数组」的装配结果。 */
export function isAssemblyLike(value: unknown): value is AssembledPrompt & { sections: readonly PromptSection[] } {
  if (value === null || typeof value !== "object") return false;
  const sections = (value as { sections?: unknown }).sections;
  return Array.isArray(sections);
}

/** 把 unknown 收敛成段数组（非数组 → 空数组）。 */
export function asSectionArray(value: unknown): readonly PromptSection[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is PromptSection => item !== null && typeof item === "object");
}
