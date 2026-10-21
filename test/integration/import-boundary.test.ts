/**
 * 导入边界守卫：补丁引擎必须与 redteam 解耦。
 *
 * ## 为什么需要这条测试
 *
 * `src/engine/**`、`src/patches/**`、`src/host/**`、`src/fs/atomic.ts` 是
 * **交付物核心**：它们要在用户宿主上跑 `apply` / `revert`，出错就是用户的 DSH
 * 起不来。而 `src/redteam/**` 是另一条产品线（红队控制台 + 存储 + 插件）。
 *
 * 两者之间一旦出现 import，后果是：
 *
 * 1. 补丁引擎的**启动面**被撑大 —— 一个 `patch-table-invariants` 或者
 *    `verify:patches` 会连带把 `node:sqlite`、web server、Cordis 依赖拉进来；
 * 2. 依赖方向变乱 —— redteam 是插件层，patch engine 是底层，底层反向依赖上层
 *    会造成循环与难以推理的初始化顺序；
 * 3. 上游同步（`sync:patches`）与补丁表校验本来是**纯数据/纯文本**操作，
 *    没有任何理由需要知道 redteam 的存在。
 *
 * 新增的 `src/redteam/plugin.ts`（服务端入口：`new RedteamStore` +
 * `ctx.webServer.register("/redteam/api")` + Cordis 三件套）正是最容易
 * 不小心被引到公共桶文件里的东西。这条测试就是它的护栏。
 *
 * ## 判据
 *
 * 不看"谁 import 了谁"的运行时图，而是**静态扫描源码文本**里的 import 语句。
 * 理由：运行时图需要真的把模块加载起来，而加载 redteam 会拉起 sqlite 等重依赖，
 * 在某些环境下直接失败——那会让守卫本身变成不稳定源。文本扫描足够可靠，
 * 因为这些 import 都是字面量。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** 源码根（`dist-test/test/integration` 往上三级 = 仓库根，再进 src）。 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SRC = path.join(REPO_ROOT, "src");

/**
 * 补丁引擎核心的目录/文件（相对于 `src/`）。
 *
 * 这些文件构成「打补丁」这条链：目标解析 → 读取 → 文本变换 → 原子写 → 漂移诊断。
 */
const ENGINE_SURFACE: readonly string[] = [
  "engine",
  "patches",
  "host",
  path.join("fs", "atomic.ts"),
];

/** 递归列出目录下所有 .ts 文件。 */
function listTs(dir: string): readonly string[] {
  if (!fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return dir.endsWith(".ts") ? [dir] : [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(fp));
    else if (entry.name.endsWith(".ts")) out.push(fp);
  }
  return out;
}

/** 抽出文件里所有 `from "..."` 的模块说明符（含 `import()` 动态导入）。 */
function importSpecifiers(text: string): readonly string[] {
  const specs: string[] = [];
  // 静态 import / export ... from / 动态 import()
  const re = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) specs.push(m[1]!);
  const dyn = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(dyn)) specs.push(m[1]!);
  return specs;
}

/** 收集补丁引擎核心的所有源文件。 */
function engineFiles(): readonly string[] {
  const files: string[] = [];
  for (const rel of ENGINE_SURFACE) files.push(...listTs(path.join(SRC, rel)));
  return files;
}

describe("导入边界：补丁引擎不得依赖 redteam", () => {
  it("引擎核心不 import 任何 redteam 模块（含动态 import）", () => {
    const offenders: string[] = [];
    for (const fp of engineFiles()) {
      const text = fs.readFileSync(fp, "utf8");
      for (const spec of importSpecifiers(text)) {
        if (/redteam/i.test(spec)) {
          offenders.push(`${path.relative(SRC, fp)} → ${spec}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "补丁引擎核心引用了 redteam。底层不得反向依赖插件层；" +
        "这会把 sqlite / web server / Cordis 拉进纯文本打补丁的启动路径。",
    );
  });

  it("引擎核心不 import 任何 plugin / platform 模块", () => {
    // 与 redteam 同理：plugin 与 platform 是上层，引擎是底层。
    const offenders: string[] = [];
    for (const fp of engineFiles()) {
      const text = fs.readFileSync(fp, "utf8");
      for (const spec of importSpecifiers(text)) {
        if (/(?:\/|^)(plugin|platform)\//.test(spec) || /(?:^|\/)plugin\.js$/.test(spec)) {
          offenders.push(`${path.relative(SRC, fp)} → ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "补丁引擎核心不应依赖 plugin / platform 层");
  });

  it("引擎核心只依赖 node 内置模块与自身子模块", () => {
    // 这条更强：把「允许的依赖面」显式列出来，任何新的第三方/跨层依赖都会红。
    // 之所以卡这么死：apply/revert 要在用户宿主上跑，依赖越少越不可能因宿主
    // 环境差异而失败。
    const allowedNodePrefix = "node:";
    const offenders: string[] = [];
    for (const fp of engineFiles()) {
      const text = fs.readFileSync(fp, "utf8");
      for (const spec of importSpecifiers(text)) {
        if (spec.startsWith(allowedNodePrefix)) continue;
        // 相对路径 = 引擎内部/相邻模块，允许
        if (spec.startsWith(".")) continue;
        // 其它一切（裸模块名）= 第三方依赖
        offenders.push(`${path.relative(SRC, fp)} → ${spec}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "补丁引擎出现了第三方依赖。它必须在零外部依赖下可运行（宿主环境未知）。",
    );
  });

  it("补丁表校验脚本保持纯数据（不 import redteam / sqlite）", () => {
    const script = path.join(REPO_ROOT, "scripts", "verify-patches.ts");
    if (!fs.existsSync(script)) return; // 脚本被挪走就跳过，别误报
    const text = fs.readFileSync(script, "utf8");
    const specs = importSpecifiers(text);
    const bad = specs.filter((s) => /redteam|sqlite|plugin|platform/i.test(s));
    assert.deepEqual(bad, [], "verify:patches 必须保持纯数据校验，不能被插件层污染");
  });
});

describe("导入边界：新增 redteam/plugin.ts 不得被公共桶文件带出", () => {
  /**
   * 这条针对 `server-entry` 落地后的具体风险：
   *
   * 若 `src/redteam/plugin.ts`（会 `new RedteamStore` + 注册 HTTP 路由）被
   * 某个公共桶文件 re-export，那么任何 import 该桶的地方都会连带加载 sqlite
   * 与 web server —— 包括纯粹想跑一次 `verify:patches` 的 CI 步骤。
   *
   * 这里检查「除 redteam 自身与测试外，没有别的模块 import redteam/plugin」。
   * 文件还没落地时自动跳过（不误报）。
   */
  it("redteam/plugin 尚未落地时跳过（不误报）", () => {
    const target = path.join(SRC, "redteam", "plugin.ts");
    if (!fs.existsSync(target)) {
      // 明确记录：现在不存在，所以这条守卫暂时无对象。
      // 落地后本用例会自动进入下面的断言。
      assert.equal(fs.existsSync(target), false, "文件不存在");
      return;
    }
    assert.ok(true);
  });

  it("除 redteam 自身外，src 内没有模块 import redteam/plugin", () => {
    const pluginFiles = ["redteam/plugin.ts", "redteam/plugin.js"]
      .map((r) => path.join(SRC, r.split("/").join(path.sep)))
      .filter((fp) => fs.existsSync(fp));
    if (pluginFiles.length === 0) return; // 未落地 → 跳过

    const offenders: string[] = [];
    for (const fp of listTs(SRC)) {
      const relToRedteam = path.relative(path.join(SRC, "redteam"), fp);
      const insideRedteam = !relToRedteam.startsWith("..");
      if (insideRedteam) continue; // redteam 内部互相 import 合理
      const text = fs.readFileSync(fp, "utf8");
      for (const spec of importSpecifiers(text)) {
        if (/redteam\/plugin(?:\.js)?$/.test(spec)) {
          offenders.push(`${path.relative(SRC, fp)} → ${spec}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "redteam/plugin 被 redteam 之外的模块 import 了。" +
        "它带 sqlite + web server，不能进入公共导入路径。",
    );
  });
});

describe("导入边界：补丁表不涉及 redteam 目标", () => {
  /**
   * 补丁表打的是**宿主** `@deepseek-ai` 包里的文件。redteam 是本仓库自己的代码，
   * 永远不会出现在宿主上。若补丁表里出现 redteam 路径，那说明有人把「改自己的
   * 代码」误当成「打宿主补丁」——apply 时会静默 missing_file，永远不生效。
   */
  it("patch 表与 targets 表里不出现 redteam / 本仓库 src 路径", () => {
    const files = [
      path.join(REPO_ROOT, "patches", "patches.json"),
      path.join(REPO_ROOT, "patches", "targets.json"),
    ];
    const offenders: string[] = [];
    for (const fp of files) {
      if (!fs.existsSync(fp)) continue;
      const text = fs.readFileSync(fp, "utf8");
      if (/redteam/i.test(text)) offenders.push(`${path.basename(fp)} 含 redteam 字样`);
      if (/src\/redteam/i.test(text)) offenders.push(`${path.basename(fp)} 含 src/redteam 路径`);
    }
    assert.deepEqual(offenders, [], "补丁表不应指向本仓库的 redteam 代码");
  });
});
