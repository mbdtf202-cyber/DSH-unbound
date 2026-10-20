/**
 * 补丁表完整性校验。
 *
 * 用途：在 CI 与发布前，确认补丁表本身没有畸形数据、id 无重复、
 * pattern 不是空的、正则合法。**不**要求 pattern 能在某个具体宿主上命中
 * （那属于 drift 检测，需要真实宿主）。
 */
import { loadBundledPatches } from "../src/patches/load.js";

const patches = loadBundledPatches();

const problems: string[] = [];
const seen = new Set<number>();
let regexCount = 0;
let literalCount = 0;

for (const p of patches) {
  if (seen.has(p.id)) problems.push(`duplicate id ${p.id}`);
  seen.add(p.id);
  if (p.fileKeys.length === 0) problems.push(`#${p.id} has no file key`);
  if (p.replacements.length === 0) problems.push(`#${p.id} has no replacements`);
  for (const [i, r] of p.replacements.entries()) {
    if (typeof r.replace !== "string") problems.push(`#${p.id} replacement[${i}].replace not string`);
    if (r.pattern.kind === "regex") {
      regexCount += 1;
      try {
        new RegExp(r.pattern.source, r.pattern.flags.replace(/g/g, ""));
      } catch (cause) {
        problems.push(`#${p.id} replacement[${i}] invalid regex: ${(cause as Error).message}`);
      }
    } else {
      literalCount += 1;
      if (r.pattern.text.length === 0) problems.push(`#${p.id} replacement[${i}] empty literal`);
    }
  }
}

console.log(`patches: ${patches.length}`);
console.log(`literal patterns: ${literalCount}`);
console.log(`regex patterns: ${regexCount}`);
console.log(`with markers: ${patches.filter((p) => p.markers !== undefined).length}`);
console.log(`skipIfMarked: ${patches.filter((p) => p.skipIfMarked).length}`);
console.log(`optional: ${patches.filter((p) => p.optional).length}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const msg of problems) console.error(`  - ${msg}`);
  process.exit(1);
}
console.log("\nok: patch table is well-formed");
