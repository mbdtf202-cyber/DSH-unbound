/**
 * 工厂片段的提取与再嵌入（**基于显式标记注释**，不做括号计数）。
 *
 * ## 为什么废弃原方案
 *
 * 原 `scripts/build-client.mjs` 的提取逻辑：
 * ```js
 * const startMark = "factory: (require) => {";
 * const start = raw.indexOf(startMark);
 * const endMark = "\n    return module.exports\n  },\n})";
 * const end = raw.lastIndexOf(endMark);
 * let body = raw.slice(start + startMark.length, end);
 *
 * const applyAt = body.lastIndexOf("function apply(ctx) {");
 * let d = 0;                                  // ← 数花括号
 * for (; j < body.length; j += 1) { ... }
 * ```
 *
 * 这条链上有四把刀，每一把都能**静默**切错：
 *
 * 1. `indexOf("factory: (require) => {")` —— 源码里换个缩进、
 *    或者注释里出现同样的字样，定位就偏。
 * 2. `lastIndexOf("\n    return module.exports\n  },\n})")` —— **依赖四个空格的
 *    缩进和 `\n` 行尾**。文件被 Prettier 改成两空格，或某个编辑器的
 *    "trim trailing whitespace" 动了行尾空格 → `end = -1` → 抛错（还算好）；
 *    更坏的情况是 `lastIndexOf` 命中了**另一个**同名片段 → 切出半截。
 * 3. 字符串里的花括号（CSS 模板字面量里有**成百上千个** `{...}`）——
 *    括号计数必须跳过字符串/模板/注释/正则，原实现**没有**做词法分析，
 *    只是「恰好」CSS 在被切的位置之前。
 * 4. 末尾用正则删 `exports.apply = apply` —— 正则匹配不到就静默保留，
 *    产物里多一行代码，跑起来也许没事，但下次构建的输入就变了。
 *
 * 四条加起来的效果是：**改一个缩进 → 产出一个错包，但构建成功、退出码 0**。
 * 这个项目里最难查的 bug 就是这类。
 *
 * ## 新方案
 *
 * 不猜、不算、不跳过。源码里放**成对的标记注释**，提取就是取两者之间：
 *
 * ```ts
 * /* @dsh-unbound:factory-begin *\/
 * ...需要被搬走的正文...
 * /* @dsh-unbound:factory-end *\/
 * ```
 *
 * 标记是**注释**，所以对 JS/TS 语法无副作用；正文可以随便用花括号、
 * 随便换缩进、随便改行尾 —— 提取器不看内容，只找标记。
 *
 * ## 严格性
 *
 * - 标记必须**恰好出现一次**（0 次 → 报"找不到"，2 次 → 报"重复"，都不猜）。
 * - `begin` 必须在 `end` 之前。
 * - 标记**不允许嵌套**（同一对标记出现第二组就是错误）。
 * - 提取保留标记之间的原始字节（含行尾），**不做 trim**：
 *   trim 会让「提取-再嵌入」不幂等。
 *
 * ## 幂等性契约（有测试锁）
 *
 * ```
 * extract(embed(target, extract(source)))  ===  extract(source)
 * embed(embed(target, f), f)                ===  embed(target, f)
 * ```
 * 第一条保证「搬过去的东西没被改」，第二条保证「重复构建字节相同」。
 */

import { err, ok, type Result } from "../../shared/result.js";

/** 标记文本。改用常量而非散落字符串，避免各处手抄走形。 */
export const FACTORY_BEGIN = "/* @dsh-unbound:factory-begin */";
export const FACTORY_END = "/* @dsh-unbound:factory-end */";

/** 提取/嵌入失败的原因（全部可定位到行）。 */
export type MarkerError =
  | {
      readonly kind: "missing_marker";
      readonly marker: "begin" | "end";
      /** 期望出现的标记文本，便于修复时直接复制。 */
      readonly expected: string;
    }
  | {
      readonly kind: "duplicate_marker";
      readonly marker: "begin" | "end";
      /** 出现次数。 */
      readonly count: number;
      /** 各次出现的行号（1 基）。 */
      readonly lines: readonly number[];
    }
  | {
      readonly kind: "out_of_order";
      readonly beginLine: number;
      readonly endLine: number;
    }
  | {
      readonly kind: "nested_markers";
      readonly detail: string;
    }
  | {
      readonly kind: "empty_fragment";
      readonly beginLine: number;
      readonly endLine: number;
    };

/** 出现位置：字节偏移 + 1 基行号。 */
interface Occurrence {
  readonly index: number;
  readonly line: number;
}

/** 找出所有出现位置（含行号，用于报错）。 */
function findAll(haystack: string, needle: string): readonly Occurrence[] {
  const out: Occurrence[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    // 行号 = 该偏移之前出现过的换行数 + 1
    let line = 1;
    for (let i = 0; i < index; i += 1) {
      if (haystack.charCodeAt(i) === 10) line += 1;
    }
    out.push({ index, line });
    from = index + needle.length;
  }
  return out;
}

/** 提取结果：片段正文 + 便于诊断的元数据。 */
export interface ExtractedFragment {
  /** 标记之间的原始文本（**不含**两个标记行）。 */
  readonly body: string;
  /** `begin` 标记所在行（1 基）。 */
  readonly beginLine: number;
  /** `end` 标记所在行（1 基）。 */
  readonly endLine: number;
}

/**
 * 从源码里提取标记之间的正文。
 *
 * 正文**不含**标记本身，也不含标记所在的整行：标记行通常自己独占一行，
 * 把它留在正文里会让再嵌入时出现重复标记。
 *
 * 具体规则：从 `begin` 标记**行尾**（含换行）开始，到 `end` 标记**行首**为止。
 * 如果标记与代码同行（`/* begin *\/ code /* end *\/`），则取标记之间的精确区间。
 * 这条规则让「标记独占一行」的常见写法产出干净的正文，同时不破坏同行写法。
 */
export function extractFragment(source: string): Result<ExtractedFragment, MarkerError> {
  const begins = findAll(source, FACTORY_BEGIN);
  const ends = findAll(source, FACTORY_END);

  if (begins.length === 0) {
    return err({ kind: "missing_marker", marker: "begin", expected: FACTORY_BEGIN });
  }
  if (ends.length === 0) {
    return err({ kind: "missing_marker", marker: "end", expected: FACTORY_END });
  }
  if (begins.length > 1) {
    return err({
      kind: "duplicate_marker",
      marker: "begin",
      count: begins.length,
      lines: begins.map((o) => o.line),
    });
  }
  if (ends.length > 1) {
    return err({
      kind: "duplicate_marker",
      marker: "end",
      count: ends.length,
      lines: ends.map((o) => o.line),
    });
  }

  // 到这里两者都恰好一个（`noUncheckedIndexedAccess` 要求显式取值检查）。
  const begin = begins[0];
  const end = ends[0];
  if (begin === undefined || end === undefined) {
    // 不可达：上面已判空。写出来是为了满足类型收窄，不隐藏逻辑。
    return err({ kind: "missing_marker", marker: "begin", expected: FACTORY_BEGIN });
  }

  if (end.index < begin.index) {
    return err({ kind: "out_of_order", beginLine: begin.line, endLine: end.line });
  }

  const afterBegin = begin.index + FACTORY_BEGIN.length;
  const bodyStart = lineStartAfter(source, afterBegin);
  const bodyEnd = lineStartOf(source, end.index);
  const rawBody = source.slice(bodyStart, bodyEnd);

  // 空片段几乎总是「标记写对了但忘放内容」，明确报错而不是产出空包。
  if (rawBody.trim() === "") {
    return err({ kind: "empty_fragment", beginLine: begin.line, endLine: end.line });
  }

  if (bodyStart > bodyEnd) {
    return err({
      kind: "nested_markers",
      detail: `begin@${begin.line} 与 end@${end.line} 之间没有可提取区间`,
    });
  }

  return ok({ body: rawBody, beginLine: begin.line, endLine: end.line });
}

/**
 * 若 `from` 到行尾之间只有空白，返回**下一行行首**；否则原样返回 `from`。
 *
 * 用途：标记独占一行时跳过它的换行，让正文从下一行开始；
 * 标记后面紧跟代码时不吞掉那一行的内容。
 */
function lineStartAfter(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const ch = source.charCodeAt(i);
    if (ch === 10) return i + 1; // \n
    if (ch === 13) {
      // \r\n
      return source.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
    if (ch !== 32 && ch !== 9) return from; // 行内有非空白 → 保持原位
    i += 1;
  }
  return from;
}

/** 若 `at` 之前的同行部分只有空白，返回该行行首；否则原样返回 `at`。 */
function lineStartOf(source: string, at: number): number {
  let i = at - 1;
  while (i >= 0) {
    const ch = source.charCodeAt(i);
    if (ch === 10) return i + 1;
    if (ch === 13) return i + 1;
    if (ch !== 32 && ch !== 9) return at;
    i -= 1;
  }
  return at;
}

/**
 * 把片段嵌入目标文本的标记之间（替换原有内容）。
 *
 * 幂等的关键：无论目标原内容是什么，输出都只由「标记位置 + 片段」决定，
 * 且片段被原样写入（不 trim、不加缩进、不改行尾）。
 */
export function embedFragment(
  target: string,
  fragment: string,
): Result<string, MarkerError> {
  const extracted = extractFragment(target);
  if (!extracted.ok) {
    // 目标里标记不完整：把同样的分类错误透出去，调用方能看到是哪一边坏的。
    return err(extracted.error);
  }
  const begins = findAll(target, FACTORY_BEGIN);
  const ends = findAll(target, FACTORY_END);
  const begin = begins[0];
  const end = ends[0];
  if (begin === undefined || end === undefined) {
    return err({ kind: "missing_marker", marker: "begin", expected: FACTORY_BEGIN });
  }
  const bodyStart = lineStartAfter(target, begin.index + FACTORY_BEGIN.length);
  const bodyEnd = lineStartOf(target, end.index);

  // 保证片段以单个换行结束：否则再嵌入一次会与 `end` 标记粘连，
  // 破坏「标记独占一行」的形状，进而在下一次 extract 时改变正文边界。
  const normalized = fragment.endsWith("\n") ? fragment : fragment + "\n";
  return ok(target.slice(0, bodyStart) + normalized + target.slice(bodyEnd));
}

/** 把片段包进标记，生成一段新的、带标记的文本（用于新建源码文件）。 */
export function wrapFragment(fragment: string): string {
  const normalized = fragment.endsWith("\n") ? fragment : fragment + "\n";
  return `${FACTORY_BEGIN}\n${normalized}${FACTORY_END}\n`;
}

/**
 * 自检：提取 → 再嵌入 → 再提取，两段正文必须**逐字节相同**。
 *
 * 这是构建脚本每次运行都会调的断言。返回 `Result` 而不是抛，
 * 让 CI 能打印出「哪一段变了」而不是只看到栈。
 */
export function verifyRoundTrip(
  target: string,
  fragment: string,
): Result<{ readonly bytes: number }, MarkerError | { readonly kind: "roundtrip_mismatch"; readonly detail: string }> {
  const embedded = embedFragment(target, fragment);
  if (!embedded.ok) return err(embedded.error);

  const once = embedded.value;
  const twice = embedFragment(once, fragment);
  if (!twice.ok) return err(twice.error);

  // ① 重复嵌入必须字节相同（幂等）。
  if (once !== twice.value) {
    return err({
      kind: "roundtrip_mismatch",
      detail: `重复嵌入不一致：第一次 ${byteLength(once)} 字节，第二次 ${byteLength(twice.value)} 字节`,
    });
  }

  // ② 从产物里再提取，必须拿回原片段（含结尾换行归一）。
  const reExtract = extractFragment(once);
  if (!reExtract.ok) return err(reExtract.error);
  const expected = fragment.endsWith("\n") ? fragment : fragment + "\n";
  if (reExtract.value.body !== expected) {
    return err({
      kind: "roundtrip_mismatch",
      detail: `再提取的正文与原片段不同：期望 ${byteLength(expected)} 字节，实际 ${byteLength(reExtract.value.body)} 字节`,
    });
  }

  return ok({ bytes: byteLength(once) });
}

/** UTF-8 字节长度（幂等断言按字节比对，不是按 UTF-16 码元）。 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 统一行尾为 LF。
 *
 * 单独暴露：构建要在归一化**之前**记录原始行尾，否则
 * 「Windows 上产出与 Linux 不同」这类问题查不出来。
 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** 诊断用的摘要（不含正文，避免把大段代码打进日志）。 */
export function describeFragment(fragment: ExtractedFragment): string {
  // 去掉结尾换行再数：`"a\nb\n"` 是 2 行内容，不是 3 行。
  const body = fragment.body.endsWith("\n") ? fragment.body.slice(0, -1) : fragment.body;
  const lines = body === "" ? 0 : body.split("\n").length;
  return `fragment: ${lines} 行 / ${byteLength(fragment.body)} 字节（begin@${fragment.beginLine}, end@${fragment.endLine}）`;
}
