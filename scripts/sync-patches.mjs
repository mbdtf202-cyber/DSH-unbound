/**
 * 补丁表同步与一致性校验。
 *
 * 两种模式：
 *   sync   —— 从 dsh-qilin 拉取最新补丁表，写进 patches/patches.json
 *   verify —— 只比对，不一致就退出 1（用于 CI / 发布前门禁）
 *
 * 优先走 dsh-qilin 的官方出口 `scripts/export-patches.mjs`：
 * 那是它承诺的稳定契约。只有拿不到时才回退到直接 import lib/core.js
 * （更脆弱：依赖它的内部组织方式）。
 *
 * 用法：
 *   node scripts/sync-patches.mjs sync   [--qilin PATH]
 *   node scripts/sync-patches.mjs verify [--qilin PATH]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOCAL_TABLE = path.join(ROOT, "patches", "patches.json");

const DEFAULT_QILIN_CANDIDATES = [
  "/Users/raki/Documents/deepseek-harness/default-workspace/dsh-qilin",
  path.join(ROOT, "..", "dsh-qilin"),
];

function parseArgs() {
  const argv = process.argv.slice(2);
  const mode = argv[0] === "verify" ? "verify" : "sync";
  let qilin;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--qilin") {
      qilin = argv[i + 1];
      i += 1;
    }
  }
  return { mode, qilin };
}

function findQilin(explicit) {
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, "lib", "patches-data.js"))) {
      throw new Error(`not a dsh-qilin checkout: ${explicit}`);
    }
    return explicit;
  }
  for (const c of DEFAULT_QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "patches-data.js"))) return c;
  }
  throw new Error(
    "dsh-qilin not found. Pass --qilin PATH, or clone it next to this repo.",
  );
}

/** 用 qilin 的官方导出脚本取表；失败则回退到直接 import。 */
async function readQilinTable(qilinRoot) {
  const exporter = path.join(qilinRoot, "scripts", "export-patches.mjs");
  if (fs.existsSync(exporter)) {
    const tmp = path.join(os.tmpdir(), `dsh-qilin-export-${process.pid}.json`);
    try {
      execFileSync(process.execPath, [exporter, tmp], { stdio: "pipe" });
      const parsed = JSON.parse(fs.readFileSync(tmp, "utf8"));
      const patches = Array.isArray(parsed) ? parsed : parsed.patches;
      if (!Array.isArray(patches) || patches.length === 0) {
        throw new Error("exporter produced no patches");
      }
      return { patches, via: "export-patches.mjs" };
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }
  // 回退：直接 import（老版本 qilin 没有导出脚本）
  const corePath = path.join(qilinRoot, "lib", "core.js");
  if (!fs.existsSync(corePath)) throw new Error(`neither exporter nor core.js found in ${qilinRoot}`);
  const core = await import(pathToFileURL(corePath).href);
  if (!Array.isArray(core.ALL_PATCHES)) throw new Error("ALL_PATCHES missing from core.js");
  const patches = JSON.parse(
    JSON.stringify(core.ALL_PATCHES, (k, v) => (v instanceof RegExp ? { $regex: v.source, flags: v.flags } : v)),
  );
  return { patches, via: "core.js (fallback)" };
}

/** 统一形状：本地表是裸数组，qilin 导出的可能带信封。 */
function normalizeTable(raw) {
  const arr = Array.isArray(raw) ? raw : raw?.patches;
  if (!Array.isArray(arr)) throw new Error("table is not an array");
  return arr.map((p) => ({ ...p }));
}

/** 稳定序列化：键顺序无关的比较只需要 JSON.stringify 因为两边同源同序。 */
function canon(p) {
  const copy = { ...p };
  delete copy.__source;
  return JSON.stringify(copy);
}

function diffTables(local, remote) {
  const problems = [];
  if (local.length !== remote.length) {
    problems.push(`count differs: local ${local.length} vs qilin ${remote.length}`);
  }
  const byId = new Map(local.map((p) => [p.id, p]));
  const remoteIds = new Set(remote.map((p) => p.id));
  for (const p of remote) {
    const mine = byId.get(p.id);
    if (mine === undefined) {
      problems.push(`#${p.id} ${p.name} missing locally`);
      continue;
    }
    if (canon(mine) !== canon(p)) {
      problems.push(`#${p.id} ${p.name} differs`);
    }
  }
  for (const p of local) {
    if (!remoteIds.has(p.id)) problems.push(`#${p.id} ${p.name} exists only locally`);
  }
  return problems;
}

const { mode, qilin } = parseArgs();
const qilinRoot = findQilin(qilin);
const { patches: remoteRaw, via } = await readQilinTable(qilinRoot);
const remote = normalizeTable(remoteRaw);

if (mode === "verify") {
  if (!fs.existsSync(LOCAL_TABLE)) {
    console.error(`missing ${path.relative(ROOT, LOCAL_TABLE)}`);
    process.exit(1);
  }
  const local = normalizeTable(JSON.parse(fs.readFileSync(LOCAL_TABLE, "utf8")));
  const problems = diffTables(local, remote);
  console.log(`source: ${qilinRoot} (via ${via})`);
  console.log(`local ${local.length} | qilin ${remote.length}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} mismatch(es):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nrun: node scripts/sync-patches.mjs sync --qilin "${qilinRoot}"`);
    process.exit(1);
  }
  console.log("ok: patch table is in sync with dsh-qilin");
  process.exit(0);
}

// sync
fs.writeFileSync(LOCAL_TABLE, JSON.stringify(remote, null, 2) + "\n", "utf8");
console.log(`source: ${qilinRoot} (via ${via})`);
console.log(`wrote ${remote.length} patches -> ${path.relative(ROOT, LOCAL_TABLE)}`);
