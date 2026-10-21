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

/**
 * 一条补丁是否**自己**写出了它声明的标记。
 *
 * 判据：标记字符串出现在本补丁某条 replacement 的**产出**里。
 *
 * 为什么需要它：纯删除型补丁（真实案例 #73，替换值只是 `"\n"`）永远不会写标记，
 * 它声明的标记一定是从别的补丁那里借来的。对这类补丁，标记无法证明「我做过」。
 * 而正常补丁（含自引用升级链）的替换值里带着自己的标记，这条判据为真。
 */
export function patchOwnsItsMarkers(patch: PatchDefinition): boolean {
  const markers = [...(patch.markers ?? []), ...(patch.marker === undefined ? [] : [patch.marker])];
  if (markers.length === 0) return false;
  const outputs = patch.replacements.map((r) => toLf(r.replace)).join("\n");
  return markers.some((m) => outputs.includes(toLf(m)));
}

/**
 * 找出补丁集合里「被多条补丁争用」的标记。
 *
 * 为什么必须在**集合层面**算，而不是在单条补丁里判断：一条补丁单独看是自洽的
 * （测试里造的单补丁也应当照常工作）。只有当**另一条**补丁也产出同一条标记、
 * 且两条补丁的目标文件有重叠时，这条标记才不再能证明「是哪一条打的」。
 *
 * 只在**集合层面**降级：单条补丁（测试里造的、或真正独占总标记的）行为完全不变。
 *
 * 与 `patchOwnsItsMarkers` 配合使用，两者同时成立才不采信标记：
 *   - owned=false  ：这个标记本来就不是我写的（#73 借 #70 的）
 *   - contended=true：还有别人也写同一标记、还打同一批文件
 * 只满足其中一条时保持原行为，避免误伤（#70 自己拥有标记，只是被别人共用）。
 */
export function contendedMarkers(patches: readonly PatchDefinition[], targetFilesOf: (p: PatchDefinition) => readonly string[]): ReadonlySet<string> {
  /** marker -> 声明它的补丁下标 */
  const owners = new Map<string, number[]>();
  for (const [i, p] of patches.entries()) {
    const ms = [...(p.markers ?? []), ...(p.marker === undefined ? [] : [p.marker])];
    for (const m of new Set(ms.map((x) => toLf(x)))) {
      const list = owners.get(m);
      if (list === undefined) owners.set(m, [i]);
      else list.push(i);
    }
  }

  const contended = new Set<string>();
  for (const [marker, idxs] of owners) {
    if (idxs.length < 2) continue;
    // 只有当其中两条补丁的目标文件有交集时，标记才真的分不清归属。
    outer: for (let a = 0; a < idxs.length; a += 1) {
      for (let b = a + 1; b < idxs.length; b += 1) {
        const ia = idxs[a]!;
        const ib = idxs[b]!;
        const fa = new Set(targetFilesOf(patches[ia]!));
        const overlap = targetFilesOf(patches[ib]!).some((f) => fa.has(f));
        if (overlap) {
          contended.add(marker);
          break outer;
        }
      }
    }
  }
  return contended;
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
 *
 * `opts.respectSkipIfMarked`（默认 true）控制内置的防膨胀短路。
 * 批处理路径（`applyOne`）在调用前已经用**标记争用**判定过一遍，
 * 它传 false 关掉这里的内置幂等短路 —— 否则争用判定会被这里无条件推翻
 * （真实案例 #73：`applyOne` 已判定标记不可信，却在这里又被判 already）。
 */
export function applyPatchToText(
  text: string,
  patch: PatchDefinition,
  fp: string,
  opts: { readonly respectSkipIfMarked?: boolean } = {},
): ApplyTextResult {
  // skipIfMarked：已经带标记就整条跳过，防止重复插入导致的无限膨胀。
  if (opts.respectSkipIfMarked !== false && patch.skipIfMarked && isPatchApplied(text, patch)) {
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
