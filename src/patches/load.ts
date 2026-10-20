/**
 * 补丁定义加载与校验。
 *
 * 这一层的价值就是「畸形数据在启动时炸，而不是在用户宿主上打出半套补丁」。
 * 原 dsh-qilin 的补丁表是手写 JS 字面量，字段拼错只会在 apply 时表现为
 * 某个 patch 静默 no-op——没人会发现。这里每个字段都校验。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PatchDefinitionError,
  type PatchDefinition,
  type PatchPattern,
  type Replacement,
} from "./types.js";

/** JSON 里 RegExp 的编码形态。 */
interface EncodedRegex {
  readonly $regex: string;
  readonly flags?: string;
}

/** 磁盘上的原始记录（字段可选、形态宽松，因为它是继承来的资产）。 */
interface RawPatch {
  readonly id: unknown;
  readonly name: unknown;
  readonly layer?: unknown;
  readonly layer_en?: unknown;
  readonly desc?: unknown;
  readonly file?: unknown;
  readonly rel?: unknown;
  readonly replacements?: unknown;
  readonly patterns?: unknown;
  readonly replace?: unknown;
  readonly markers?: unknown;
  readonly markersAny?: unknown;
  readonly marker?: unknown;
  readonly forbid?: unknown;
  readonly optional?: unknown;
  readonly skipIfMarked?: unknown;
  readonly surfaces?: unknown;
  readonly strictFiles?: unknown;
  readonly softSettle?: unknown;
}

function isEncodedRegex(v: unknown): v is EncodedRegex {
  return typeof v === "object" && v !== null && "$regex" in v && typeof (v as EncodedRegex).$regex === "string";
}

function decodePattern(value: unknown, patchId: number): PatchPattern {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new PatchDefinitionError("empty literal pattern", patchId);
    }
    return { kind: "literal", text: value };
  }
  if (isEncodedRegex(value)) {
    const flags = typeof value.flags === "string" ? value.flags : "";
    // 构造一次以校验正则本身合法；非法正则会抛 SyntaxError。
    try {
      new RegExp(value.$regex, flags.replace(/g/g, ""));
    } catch (cause) {
      throw new PatchDefinitionError(
        `invalid regex pattern /${value.$regex}/${flags}: ${(cause as Error).message}`,
        patchId,
      );
    }
    return { kind: "regex", source: value.$regex, flags };
  }
  throw new PatchDefinitionError(
    `pattern must be a string or {$regex}, got ${typeof value}`,
    patchId,
  );
}

function asStringArray(value: unknown, field: string, patchId: number): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v !== "string") {
        throw new PatchDefinitionError(`${field}[] must contain strings`, patchId);
      }
      return v;
    });
  }
  throw new PatchDefinitionError(`${field} must be a string or string[]`, patchId);
}

function optionalStringArray(value: unknown, field: string, patchId: number): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asStringArray(value, field, patchId);
}

function optionalBool(value: unknown, field: string, patchId: number): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new PatchDefinitionError(`${field} must be boolean`, patchId);
  }
  return value;
}

function requireString(value: unknown, field: string, patchId: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PatchDefinitionError(`${field} is required and must be a non-empty string`, patchId);
  }
  return value;
}

/**
 * 把一条原始记录折叠成唯一的 replacements[]。
 *
 * 继承来的资产有两套写法：
 *   A) replacements: [{pattern, replace}, ...]      —— 207 项
 *   B) patterns: [p1, p2], replace: "..."           —— 8 项
 * 两者的语义完全相同（每个 pattern 都换成同一个 replace），这里折叠掉，
 * 让下游只有一个形状。
 */
function foldReplacements(raw: RawPatch, patchId: number): Replacement[] {
  const out: Replacement[] = [];

  if (raw.replacements !== undefined) {
    if (!Array.isArray(raw.replacements)) {
      throw new PatchDefinitionError("replacements must be an array", patchId);
    }
    for (const item of raw.replacements) {
      if (typeof item !== "object" || item === null) {
        throw new PatchDefinitionError("replacements[] must contain objects", patchId);
      }
      const rec = item as { pattern?: unknown; replace?: unknown };
      if (typeof rec.replace !== "string") {
        throw new PatchDefinitionError("replacement.replace must be string", patchId);
      }
      out.push({ pattern: decodePattern(rec.pattern, patchId), replace: rec.replace });
    }
  }

  if (raw.patterns !== undefined) {
    if (typeof raw.replace !== "string") {
      throw new PatchDefinitionError("patterns[] requires a top-level replace string", patchId);
    }
    if (!Array.isArray(raw.patterns)) {
      throw new PatchDefinitionError("patterns must be an array", patchId);
    }
    for (const pat of raw.patterns) {
      out.push({ pattern: decodePattern(pat, patchId), replace: raw.replace });
    }
  }

  if (out.length === 0) {
    throw new PatchDefinitionError(
      "patch has no replacements and no patterns — it would silently do nothing",
      patchId,
    );
  }
  return out;
}

/** 校验并归一化一条记录。 */
export function normalizePatch(raw: RawPatch, seenIds: Set<number>): PatchDefinition {
  if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
    throw new PatchDefinitionError("id must be a positive integer", undefined);
  }
  const id = raw.id;
  if (seenIds.has(id)) {
    throw new PatchDefinitionError("duplicate patch id", id);
  }
  seenIds.add(id);

  const name = requireString(raw.name, "name", id);
  const fileKeys = asStringArray(raw.file, "file", id);
  if (fileKeys.length === 0) {
    throw new PatchDefinitionError("file must name at least one target", id);
  }

  const markers = optionalStringArray(raw.markers, "markers", id);
  const forbid = optionalStringArray(raw.forbid, "forbid", id);

  return {
    id,
    name,
    layer: typeof raw.layer === "string" ? raw.layer : "",
    layerEn: typeof raw.layer_en === "string" ? raw.layer_en : "",
    desc: typeof raw.desc === "string" ? raw.desc : "",
    fileKeys,
    rel: optionalStringArray(raw.rel, "rel", id) ?? [],
    replacements: foldReplacements(raw, id),
    markers,
    markersAny: optionalBool(raw.markersAny, "markersAny", id) ?? false,
    marker: typeof raw.marker === "string" ? raw.marker : undefined,
    forbid,
    skipIfMarked: optionalBool(raw.skipIfMarked, "skipIfMarked", id) ?? false,
    optional: optionalBool(raw.optional, "optional", id) ?? false,
    surfaces: optionalStringArray(raw.surfaces, "surfaces", id),
    strictFiles: optionalBool(raw.strictFiles, "strictFiles", id) ?? false,
    softSettle: optionalBool(raw.softSettle, "softSettle", id) ?? false,
  };
}

/** 从任意数组加载（测试与内联用）。 */
export function loadPatchesFromArray(input: readonly unknown[]): readonly PatchDefinition[] {
  const seen = new Set<number>();
  const out = input.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new PatchDefinitionError("patch record must be an object", undefined);
    }
    return normalizePatch(raw as RawPatch, seen);
  });
  return Object.freeze(out);
}

/**
 * 解析内置补丁文件的位置。
 *
 * 编译后 dist/ 与 patches/ 是兄弟目录，源码态 src/ 与 patches/ 也是兄弟目录，
 * 所以统一向上找含 patches/patches.json 的目录。
 */
export function resolveBundledPatchesPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "patches", "patches.json"), // dist/patches -> <root>/patches
    path.join(here, "..", "..", "..", "patches", "patches.json"), // src/patches -> <root>/patches
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `bundled patches not found; looked in:\n  ${candidates.join("\n  ")}`,
  );
}

/** 读取并校验内置补丁表。 */
export function loadBundledPatches(): readonly PatchDefinition[] {
  const file = resolveBundledPatchesPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    throw new PatchDefinitionError(`cannot parse ${file}: ${(cause as Error).message}`, undefined);
  }
  if (!Array.isArray(parsed)) {
    throw new PatchDefinitionError(`${file} must contain an array`, undefined);
  }
  return loadPatchesFromArray(parsed);
}
