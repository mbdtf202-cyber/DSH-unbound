/**
 * 门禁自检：确认测试**真的被跑了**，且**跑的是全部**。
 *
 * ## 为什么需要这个脚本
 *
 * 本仓库曾出现过一个真实的假绿：
 *   `npm test` 写的是 `node --test dist-test/test/*.test.js`（只匹配顶层），
 *   而 44 个测试文件里 37 个在子目录 —— 门禁显示绿，实际只跑了 16%。
 *
 * 这类问题无法靠"测试通过"发现，因为**它本身就是关于"测试有没有跑"的**。
 * 所以需要一个独立的、检查测试发现逻辑的脚本。
 *
 * 判据（任一不满足即失败）：
 *   1. 编译产物里的测试文件数 == 源码里的测试文件数
 *   2. 实际被 node --test 发现的用例数 > 0
 *   3. 发现的用例数 >= 测试文件数 * 最小期望（默认 3），防止"文件在但用例没注册"
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 定位仓库根。
 *
 * 编译后本文件在 `dist-test/scripts/`，源码态在 `scripts/`，
 * 所以不能靠固定层数上溯——改为向上找「同时含 package.json 与 test/」的目录。
 */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up += 1) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "test"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("无法定位仓库根（需要同时存在 package.json 与 test/）");
}

const ROOT = findRoot();
const SRC_TEST_DIR = path.join(ROOT, "test");
const DIST_TEST_DIR = path.join(ROOT, "dist-test", "test");

/** 递归收集 `*.test.ts`（源码）。 */
function collectSourceTests(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(fp);
        continue;
      }
      if (e.name.endsWith(".test.ts")) out.push(path.relative(SRC_TEST_DIR, fp));
    }
  };
  walk(dir);
  return out.sort();
}

/** 递归收集 `*.test.js`（编译产物）。 */
function collectDistTests(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(fp);
        continue;
      }
      if (e.name.endsWith(".test.js")) out.push(path.relative(DIST_TEST_DIR, fp));
    }
  };
  walk(dir);
  return out.sort();
}

const sourceTests = collectSourceTests(SRC_TEST_DIR);
if (!fs.existsSync(DIST_TEST_DIR)) {
  console.error(`dist-test 不存在，请先跑 npm run build:test\n  期望路径: ${DIST_TEST_DIR}`);
  process.exit(1);
}
const distTests = collectDistTests(DIST_TEST_DIR);

const problems: string[] = [];

// 判据 1：源码与产物一致
if (sourceTests.length !== distTests.length) {
  problems.push(
    `测试文件数不一致：源码 ${sourceTests.length} 个，编译产物 ${distTests.length} 个\n` +
      `  源码独有: ${sourceTests.filter((f) => !distTests.includes(f)).join(", ") || "(无)"}\n` +
      `  产物独有: ${distTests.filter((f) => !sourceTests.includes(f)).join(", ") || "(无)"}`,
  );
}

// 判据 2/3：实际跑一遍，看发现了多少用例
const globs = [
  ...(fs.existsSync(path.join(DIST_TEST_DIR)) ? ["dist-test/test/*.test.js"] : []),
  "dist-test/test/*/*.test.js",
];
const run = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", ...globs],
  { cwd: ROOT, encoding: "utf8", shell: true },
);
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const testsMatch = /^# tests (\d+)$/m.exec(output);
const passMatch = /^# pass (\d+)$/m.exec(output);
const failMatch = /^# fail (\d+)$/m.exec(output);

const discovered = testsMatch === null ? 0 : Number(testsMatch[1]);
const passed = passMatch === null ? 0 : Number(passMatch[1]);
const failed = failMatch === null ? 0 : Number(failMatch[1]);

const MIN_PER_FILE = 3;
if (discovered === 0) {
  problems.push(`node --test 一个用例都没发现（globs: ${globs.join(" ")}）`);
} else if (discovered < distTests.length * MIN_PER_FILE) {
  problems.push(
    `发现用例数 ${discovered} 少于期望下限 ${distTests.length * MIN_PER_FILE}` +
      `（${distTests.length} 文件 x ${MIN_PER_FILE}）—— 可能有文件没注册测试`,
  );
}

console.log(`源码测试文件: ${sourceTests.length}`);
console.log(`产物测试文件: ${distTests.length}`);
console.log(`发现用例: ${discovered}（pass ${passed} / fail ${failed}）`);

if (failed > 0) {
  problems.push(`存在失败用例 ${failed} 个`);
}

if (problems.length > 0) {
  console.error(`\n门禁自检失败：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\nok: 测试发现逻辑正常（${discovered} 用例来自 ${distTests.length} 个文件）`);
