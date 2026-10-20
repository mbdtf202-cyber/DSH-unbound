/**
 * 从 dsh-qilin 的 lib/core.js 程序化导出 86 条补丁为类型化 JSON。
 *
 * 为什么程序化导出而不是手抄：补丁 pattern 里嵌着 tab/换行/CRLF/正则，
 * 手抄一定会漂。这里直接 import 原模块取 ALL_PATCHES，逐字段序列化，
 * 并把 RegExp 还原成 {source, flags}，保证 round-trip 后字节等价。
 *
 * 用法：node scripts/extract-patches.mjs <qilin-root>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const qilinRoot = process.argv[2];
if (!qilinRoot) {
  console.error("usage: node scripts/extract-patches.mjs <qilin-root>");
  process.exit(2);
}

const corePath = path.join(qilinRoot, "lib", "core.js");
const core = await import(pathToFileURL(corePath).href);
const ALL = core.ALL_PATCHES;
if (!Array.isArray(ALL) || ALL.length === 0) {
  throw new Error("ALL_PATCHES not found or empty");
}

/** RegExp 不能 JSON 化：显式编码成可还原的标签，避免静默变成 {}。 */
function encPattern(v) {
  if (v instanceof RegExp) return { $regex: v.source, flags: v.flags };
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return null;
  throw new Error("unexpected pattern type: " + Object.prototype.toString.call(v));
}

/** 只保留已知字段；未知字段必须报错，不能静默丢。 */
const KNOWN = new Set([
  "id", "name", "layer", "layer_en", "desc", "file", "rel",
  "replacements", "patterns", "replace", "markers", "markersAny", "marker",
  "forbid", "optional", "skipIfMarked", "surfaces", "strictFiles", "softSettle",
]);

const out = [];
for (const p of ALL) {
  for (const k of Object.keys(p)) {
    if (!KNOWN.has(k)) throw new Error(`patch #${p.id} has unknown field "${k}" — update the extractor`);
  }
  const rec = {};
  rec.id = p.id;
  rec.name = p.name;
  rec.layer = p.layer;
  rec.layer_en = p.layer_en;
  rec.desc = p.desc;
  rec.file = p.file;

  if (p.rel !== undefined) rec.rel = p.rel;
  if (p.markers !== undefined) rec.markers = p.markers.map((m) => String(m));
  if (p.markersAny !== undefined) rec.markersAny = p.markersAny;
  if (p.marker !== undefined) rec.marker = p.marker;
  if (p.forbid !== undefined) rec.forbid = p.forbid.map((m) => String(m));
  if (p.optional !== undefined) rec.optional = p.optional;
  if (p.skipIfMarked !== undefined) rec.skipIfMarked = p.skipIfMarked;
  if (p.surfaces !== undefined) rec.surfaces = p.surfaces;
  if (p.strictFiles !== undefined) rec.strictFiles = p.strictFiles;
  if (p.softSettle !== undefined) rec.softSettle = p.softSettle;

  if (Array.isArray(p.replacements)) {
    rec.replacements = p.replacements.map((r) => {
      const item = {};
      item.pattern = encPattern(r.pattern);
      item.replace = r.replace;
      for (const k of Object.keys(r)) {
        if (k !== "pattern" && k !== "replace") throw new Error(`patch #${p.id} replacement has unknown field "${k}"`);
      }
      return item;
    });
  }
  if (Array.isArray(p.patterns)) rec.patterns = p.patterns.map(encPattern);
  if (typeof p.replace === "string") rec.replace = p.replace;

  out.push(rec);
}

const dest = path.join(process.cwd(), "patches", "patches.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", "utf8");

// 统计
const withRegex = out.flatMap((p) => [
  ...(p.replacements ?? []).map((r) => r.pattern),
  ...(p.patterns ?? []),
]).filter((x) => x && typeof x === "object" && "$regex" in x).length;

console.log(`extracted ${out.length} patches -> ${path.relative(process.cwd(), dest)}`);
console.log(`  replacements: ${out.reduce((n, p) => n + (p.replacements?.length ?? 0), 0)}`);
console.log(`  patterns[] entries: ${out.reduce((n, p) => n + (p.patterns?.length ?? 0), 0)}`);
console.log(`  regex patterns: ${withRegex}`);
console.log(`  with markers: ${out.filter((p) => p.markers).length}`);
console.log(`  skipIfMarked: ${out.filter((p) => p.skipIfMarked).length}`);
console.log(`  forbid: ${out.filter((p) => p.forbid).length}`);
