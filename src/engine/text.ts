/**
 * 纯文本变换：把一条补丁应用到一段源码上。
 *
 * 这是整个引擎最容易出错的地方，原 dsh-qilin 里这些语义全都是隐式的：
 *
 * 1. **CRLF 往返**：宿主文件可能是 CRLF。匹配前统一转 LF，改完再转回 CRLF。
 *    不做的话，`\n` pattern 在 CRLF 文件里永远匹配不到 → 静默 no-op。
 *
 * 2. **RegExp 的 $1 展开**：原项目特意用 `String.replace(re, str)` 而不是回调，
 *    因为回调形态会把 `$1` 当字面量写进文件。这是真实踩过的坑，必须保住。
 *
 * 3. **RegExp lastIndex 泄漏**：`/g` 正则的 `test()` 会推进 `lastIndex`，
 *    下一次 `replace` 就从中间开始。原项目每次 clone 一个带 g 的新正则来规避。
 *
 * 4. **YAML 注释改写**：往 .yml 里插 JS 的 `//` 注释会让 YAML 解析失败，
 *    所以写入前要把行尾 `//` 改成 `#`，但 `!!js` 行和引号内的 `//` 不能动。
 *
 * 5. **skipIfMarked**：插入型补丁若已带标记就不再执行，
 *    否则每次 apply 都会再叠一层（原项目实测 +841 字符/次，永不收敛）。
 *
 * 所有函数都是纯函数：同样的输入必得同样的输出，不碰文件系统。这让它们可被穷举测试。
 */
import type { PatchDefinition, PatchPattern, Replacement } from "../patches/types.js";

/** 统一换行符为 LF。 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** 是否看起来是 YAML 文件。 */
export function isYamlPath(fp: string): boolean {
  return /\.ya?ml$/i.test(fp);
}

/**
 * 克隆正则，可控地加/去 `g`。
 *
 * 为什么必须 clone：模块级正则对象有可变的 `lastIndex`，
 * 复用它会让第二次匹配从上次结束位置开始，表现为「时灵时不灵」。
 */
export function cloneRegExp(pattern: RegexPatternLike, global: boolean): RegExp {
  let flags = String(pattern.flags ?? "").replace(/g/g, "");
  if (global) flags += "g";
  return new RegExp(pattern.source, flags);
}

interface RegexPatternLike {
  readonly source: string;
  readonly flags?: string;
}

/** 在 hay 上测试单个 pattern（不影响任何共享状态）。 */
export function matchesPattern(hay: string, pattern: PatchPattern): boolean {
  if (pattern.kind === "regex") {
    return cloneRegExp(pattern, false).test(hay);
  }
  return hay.includes(pattern.text);
}

/**
 * 把 YAML 里行尾的 JS `//` 注释改成 `#`。
 *
 * 逐字符扫描以尊重引号状态：
 *  - 单引号内 `''` 是转义的单引号，不能当字符串结束
 *  - 双引号内 `\"` 是转义
 *  - 含 `!!js` 的行整行跳过（那是 YAML 里的 JS 表达式，`//` 可能是真的除法或注释）
 */
export function yamlJsCommentsToHash(text: string): string {
  const lines = toLf(text).split("\n");
  const out = lines.map((line) => {
    if (line.includes("!!js")) return line;
    let quote = "";
    for (let i = 0; i < line.length - 1; i += 1) {
      const ch = line[i];
      if (quote !== "") {
        if (quote === "'" && ch === "'" && line[i + 1] === "'") {
          i += 1;
          continue;
        }
        if (quote === '"' && ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "#") return line;
      if (ch === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
        return `${line.slice(0, i)}#${line.slice(i + 2)}`;
      }
    }
    return line;
  });
  return out.join("\n");
}

/**
 * 无缩进的 identity 语句写进 YAML 会破坏块标量缩进。
 * 这类 pattern 在 YAML 目标上直接跳过。
 */
export function isBareIdentityNeedle(pattern: PatchPattern): boolean {
  if (pattern.kind === "regex") return false;
  const needle = toLf(pattern.text);
  if (needle.length === 0) return false;
  if (/^[ \t]/.test(needle)) return false;
  return /^You are a coding agent powered by\b/.test(needle);
}

/** 补丁是否已经处于「已应用」形态。 */
export function isPatchApplied(text: string, patch: PatchDefinition): boolean {
  const hay = toLf(text);

  if (patch.forbid && patch.forbid.some((m) => hay.includes(toLf(m)))) {
    return false;
  }
  if (patch.markers && patch.markers.length > 0) {
    const needles = patch.markers.map((m) => toLf(m));
    return patch.markersAny ? needles.some((n) => hay.includes(n)) : needles.every((n) => hay.includes(n));
  }
  if (patch.marker !== undefined) {
    return hay.includes(toLf(patch.marker));
  }
  if (patch.replacements.length > 0) {
    const firstLine = toLf(patch.replacements[0]!.replace).split("\n")[0]!.slice(0, 60);
    if (firstLine.length === 0) return false;
    return hay.includes(firstLine);
  }
  return false;
}

export interface ApplyTextResult {
  readonly text: string;
  readonly changed: boolean;
  /** 有多少条替换真正落地（用于诊断和漂移统计）。 */
  readonly appliedCount: number;
  /** 有多少条 pattern 没找到（漂移信号）。 */
  readonly notFoundCount: number;
}

/**
 * 把补丁应用到一段文本。
 *
 * 注意 `fp` 只影响「是否按 YAML 规则处理」，不读写文件。
 */
export function applyPatchToText(text: string, patch: PatchDefinition, fp: string): ApplyTextResult {
  // skipIfMarked：已经带标记就整条跳过，防止重复插入导致的无限膨胀。
  if (patch.skipIfMarked && isPatchApplied(text, patch)) {
    return { text, changed: false, appliedCount: 0, notFoundCount: 0 };
  }

  const hadCrlf = text.includes("\r\n");
  const yaml = isYamlPath(fp);
  let out = toLf(text);
  let changed = false;
  let appliedCount = 0;
  let notFoundCount = 0;

  for (const replacement of patch.replacements) {
    const applied = applyOne(out, replacement, yaml);
    if (applied === null) {
      notFoundCount += 1;
      continue;
    }
    out = applied;
    changed = true;
    appliedCount += 1;
  }

  if (hadCrlf) out = out.replace(/\n/g, "\r\n");
  return { text: out, changed, appliedCount, notFoundCount };
}

/** 应用单条替换；未命中返回 null。 */
function applyOne(text: string, replacement: Replacement, yaml: boolean): string | null {
  const { pattern, replace } = replacement;

  if (yaml && isBareIdentityNeedle(pattern)) return null;

  const written = yaml ? yamlJsCommentsToHash(toLf(replace)) : toLf(replace);

  if (pattern.kind === "regex") {
    const re = cloneRegExp(pattern, true);
    re.lastIndex = 0;
    if (!re.test(text)) return null;
    re.lastIndex = 0;
    // 字符串形态调用，保住 $1..$9 展开语义。
    const next = text.replace(re, written);
    return next === text ? null : next;
  }

  if (!text.includes(pattern.text)) return null;
  const next = text.split(pattern.text).join(written);
  return next === text ? null : next;
}

/**
 * 补丁是否还有未完成的工作。
 *
 * 与 applyPatchToText 必须保持一致：apply 会跳过的 pattern，这里也不能算待做，
 * 否则状态会永远显示 pending，settle 循环会无限重启。
 */
export function patchHasRemainingWork(text: string, patch: PatchDefinition, fp: string): boolean {
  const hay = toLf(text);
  const yaml = isYamlPath(fp);
  for (const { pattern } of patch.replacements) {
    if (yaml && isBareIdentityNeedle(pattern)) continue;
    if (matchesPattern(hay, pattern)) return true;
  }
  return false;
}
