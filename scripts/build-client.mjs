#!/usr/bin/env node
/**
 * 构建 `client.js`：`src/redteam/client/` → 单文件浏览器模块。
 *
 * ## 怎么走通的（两条路的取舍）
 *
 * 需求是「把 37 个模块打成一个文件，且浏览器里能跑」。两条路：
 *
 * ### 路线 A：按拓扑序拼接源码（自己写拼接器）
 * 要自己处理：去重、循环依赖、`export { a, b }` / `export default` / `export *`、
 * `import type` 剔除、同名冲突改名、`const` 提升顺序……每一条都能写出
 * 「大多数情况对」的实现，而**错的时候不报错**，只在某个页签点开时才炸。
 * 这正是本项目明确要避免的那类 bug（见 `extract.ts` 对旧方案的复盘）。
 *
 * ### 路线 B：`tsc --module AMD --outFile`（**本脚本采用**）
 * 编译器自己做依赖解析与拓扑排序，产出 `define("模块id", [依赖...], factory)`
 * 序列。我们**一个字都不改写**这些 define，只在片段最前面提供十几行
 * `define` / `require` shim 把它们串起来执行。收益：
 *
 * - **没有正则、没有括号计数、没有字符串改写**：产物正文是 tsc 的输出，
 *   与 `dist/` 那套 Node 侧产物出自同一编译器、同一份类型检查。
 * - **循环依赖由 shim 的 lazy 解析天然处理**（`exports` 先占位后执行，与
 *   AMD/CommonJS 语义一致），不需要我排序。
 * - **`shared/result.js` 自动内联**：它在 `include` 里，tsc 会把它编成自己的
 *   `define("shared/result", ...)`，产物里不留任何裸相对路径 —— 这是最容易
 *   漏的一处（4 个 model 依赖它，漏了就是浏览器里 `require` 找不到模块）。
 * - **字节可复现**：同一输入两次构建 sha256 相同（有测试锁）。
 *
 * ## 覆盖掉的三个 tsconfig 冲突（都有编译器原文报错可查）
 *
 * | 冲突 | 报错 | 这里怎么处理 |
 * |---|---|---|
 * | `verbatimModuleSyntax` 与 AMD | TS5105 | 设 `false` |
 * | `moduleResolution: NodeNext` 与 `module: AMD` | TS5110 | 设 `Classic` |
 * | 找不到 `@types/node`（`types: ["node"]`） | TS2688 | 设 `types: []` |
 *
 * 两条刻意的选择：
 * - **不加 `lib: ["dom"]`**：`client/dom.ts` 手写了最小浏览器声明，引入真 DOM
 *   会与它重复声明同一批名字（`window` / `document`）而冲突。
 * - **`target: ES2020`**：宿主 Electron/Chromium 都支持，比 ES2023 少一层新语法风险。
 *
 * ## 产物结构
 *
 * ```
 * window.__ModuleLoader__.load({ id: 'dsh-unbound', factory: (require) => {
 *     var module = {...}; var exports = module.exports
 *     const React = require('react')          ← 宿主 provide
 *     /* @dsh-unbound:factory-begin *\/
 *     <AMD shim>
 *     <tsc 的 define 序列，原样>
 *     <入口胶水：调 makeConsoleModule → exports.name/inject/apply>
 *     /* @dsh-unbound:factory-end *\/
 *     return module.exports
 *   },
 * })
 * ```
 *
 * 标记之间由 `src/redteam/ui/build.ts` 的 `assemble()` 写入并跑往返自检；
 * 自检不过 → 退出码 1，**不落盘**。
 *
 * ## 产物提交策略：**提交进 git + CI 校验同步**（策略 a）
 *
 * `client.js` 是构建产物，但它**同时是运行时文件**：宿主按
 * `package.json` 的 `exports["./client"]` 直接读这份文件，浏览器端
 * 没有它整个控制台就是空白。所以两条路：
 *
 * | 策略 | 做法 | 问题 |
 * |---|---|---|
 * | (b) 不提交 | clone 后必须手动 `npm run build:client` | 忘跑 → 控制台白屏，且**没有任何报错**；`files` 里声明了它却没有 = 发出一个坏包 |
 * | **(a) 提交 + 校验（本仓库采用）** | 提交产物，CI 跑 `check:client` | 唯一的风险是「改了源码忘了重建」 |
 *
 * 选 (a) 是因为它把 (b) 的失败模式（静默白屏）换成了**可见的 CI 红灯**：
 * `npm run check:client` 重建一遍并与磁盘上的 `client.js` 逐字节比对，
 * 不一致就 exit 1，并打印两边的 sha256 与字节数。
 *
 * 配套脚本：
 * - `build:client` —— 构建并写盘（`npm run build` 的最后一步）
 * - `check:client` —— 只重建比对，不写盘（CI 门禁；`prepublishOnly` 也跑它）
 * - `--stdout` —— 打到标准输出，不落盘（测试用，避免多个测试互相踩文件）
 *
 * ## 用法
 *
 * ```
 * node scripts/build-client.mjs            # 构建并写入 ./client.js
 * node scripts/build-client.mjs --check    # 只校验现有 client.js 是否最新（CI 用）
 * node scripts/build-client.mjs --stdout   # 打到 stdout（测试用，不落盘）
 * ```
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
/** 产物落在仓库根（宿主按 `exports["./client"]` 找它）。 */
const OUTPUT = path.join(ROOT, "client.js");
/** 宿主的模块 id：`__ModuleLoader__` 的注册键，也是 `package.json` 的包名。 */
const MODULE_ID = "dsh-unbound";

/**
 * 打包范围的**唯一**来源。
 *
 * `client/**` 是主体；另外两项是它依赖但不在该目录里的模块：
 *
 * - `shared/result.ts` —— 4 个 model 用它（`ok`/`err`/`Result`）。**必打**，
 *   否则产物里留 `require("../../shared/result.js")`，浏览器里直接炸。
 * - `redteam/ui/protocol.ts` —— 2 个 model 只用 `import type`。列进来让
 *   「类型依赖也算依赖」显式可见；tsc 会因只有类型引用而不产出运行时模块，
 *   这是正确的（类型不占运行时字节）。
 * - `redteam/ui/console.ts` —— 入口胶水。
 *
 * ## ⚠️ 加新模块时**不需要**改这个列表
 *
 * `include` 决定「哪些文件被当作**入口**编译」，但 tsc 会沿 `import` 图
 * 自动把被引用的模块一起编进来。实测：给 `console.ts` 加一行
 * `import { X } from "./tabs-a.js"`，产物里立刻出现 `define("redteam/ui/tabs-a")`
 * 与它的全部代码，**无需**动 `INCLUDE`。
 *
 * 所以给控制台加数据层（`src/redteam/ui/tabs-a.ts` / `tabs-b.ts` 之类）的
 * 正确做法是：**只在 `console.ts` 里 import 它**，然后重跑 `npm run build:client`。
 * 只有「需要成为编译入口、但不被 console.ts 引用」的文件才要加到这个列表里
 * ——按目前设计不存在这种文件。
 *
 * 有用例断言 `define("shared/result", ...)` 存在、且产物里**不存在**任何
 * 未解析的裸相对路径（`require("../../`）：一旦谁把 include 改坏，它会红。
 */
const INCLUDE = [
  `${SRC}/redteam/client/**/*.ts`,
  `${SRC}/shared/result.ts`,
  `${SRC}/redteam/ui/protocol.ts`,
  `${SRC}/redteam/ui/console.ts`,
];

/**
 * 临时 tsconfig（写在临时目录里，所以路径必须全是绝对路径 ——
 * 相对路径会以临时目录为基准解析，指不回仓库）。
 */
function writeTempTsconfig(dir, outFile) {
  const config = {
    compilerOptions: {
      target: "ES2020",
      lib: ["ES2020"],
      module: "AMD",
      moduleResolution: "Classic",
      // ↓ 三个必须覆盖的冲突项，见文件头表格。
      verbatimModuleSyntax: false,
      isolatedModules: false,
      types: [],
      // 与仓库主 tsconfig 对齐的严格档：打包用的是**同一份严格性**，
      // 不是放宽后再打包（否则会有「本地过、打包不过」两套标准）。
      strict: true,
      noImplicitOverride: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noFallthroughCasesInSwitch: true,
      noImplicitReturns: true,
      noPropertyAccessFromIndexSignature: true,
      useUnknownInCatchVariables: true,
      forceConsistentCasingInFileNames: true,
      // 产物只要一个 .js：声明文件与 sourcemap 落临时目录没有意义。
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      removeComments: false,
      skipLibCheck: true,
      outFile,
      rootDir: SRC,
    },
    include: INCLUDE,
  };
  const configPath = path.join(dir, "tsconfig.client.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return configPath;
}

/**
 * 编译出 AMD 单文件。
 *
 * 用 `execFileSync` + 参数数组而不是拼 shell 字符串：路径里有空格时
 * （本仓库路径含 `DeepSeek Harness`）拼字符串会静默切错参数。
 */
function compileAmd() {
  const work = mkdtempSync(path.join(tmpdir(), "dsh-unbound-client-"));
  try {
    const outFile = path.join(work, "client.amd.js");
    const configPath = writeTempTsconfig(work, outFile);
    // 用本地 typescript 的 tsc.js 而不是 `npx`：npx 在缓存缺失时会尝试下载，
    // 而 `npm run build` 是 CI 门禁，不能因为网络抖动失败。
    const tscJs = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tscJs)) {
      throw new Error("找不到本地 typescript：" + tscJs + "（先 npm install）");
    }
    try {
      execFileSync(process.execPath, [tscJs, "-p", configPath], {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (error) {
      const stdout = typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error.stderr === "string" ? error.stderr : "";
      const detail = (stdout + stderr).trim();
      throw new Error("tsc 编译失败（AMD 单文件）：\n" + (detail || String(error.message)));
    }
    if (!existsSync(outFile)) throw new Error("tsc 报成功但没产出 outFile：" + outFile);
    return readFileSync(outFile, "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * AMD 运行时 shim。
 *
 * ## 要做什么
 *
 * tsc 产出的每个模块长这样：
 * ```js
 * define("redteam/client/h", ["require", "exports"], function (require, exports) {
 *   "use strict";
 *   Object.defineProperty(exports, "__esModule", { value: true });
 *   exports.makeH = makeH
 * })
 * ```
 * 所以要提供 `define(id, deps, factory)`：先登记，再按需实例化。
 *
 * ## 为什么依赖解析是 lazy
 *
 * tsc 的 define **顺序未必等于依赖顺序**（它按输入文件顺序输出，实测
 * `assets-model` 出现在 `label` 之前）。若在 `define` 时就实例化依赖，
 * 后面的模块可能还没登记。lazy 解析天然免疫，顺带把循环依赖变成
 * 「拿到半成品 exports」（AMD 标准语义）。
 *
 * ## 与宿主契约的接缝
 *
 * 宿主 `factory(require)` 的 `require` 只认 `"react"`（见 `client/dom.ts` 的
 * `ModuleRequire`）。shim 对 `"react"` 透传宿主那份，其余 id 走内部登记表 ——
 * 于是「宿主 provide 什么」与「我们自己打进去什么」边界清楚。
 */
const SHIM = String.raw`
/* ── AMD 运行时 shim（由 scripts/build-client.mjs 注入，不是 tsc 输出） ──
 *
 * 只做三件事：登记 define、lazy 解析依赖、给外部依赖（react）留一个通透口。
 * 不含任何模块逻辑 —— 模块正文全部来自下面的 tsc 输出，一字未改。 */
var __amdRegistry = new Map()
var __amdInstances = new Map()

function __amdDefine(id, deps, factory) {
  __amdRegistry.set(id, { deps: deps, factory: factory })
}

/** 实例化一个模块（懒、幂等）。循环依赖时先返回半成品 exports。 */
function __amdLoad(id) {
  var cached = __amdInstances.get(id)
  if (cached !== undefined) return cached
  var entry = __amdRegistry.get(id)
  if (entry === undefined) {
    throw new Error("[dsh-unbound] 产物缺少模块：" + id + "（构建 include 漏了它）")
  }
  // 先占位再执行工厂：循环依赖回指自己时拿到同一个 exports 对象。
  var module = { exports: {} }
  __amdInstances.set(id, module.exports)
  var args = entry.deps.map(function (dep) {
    if (dep === "require") return __amdRequire
    if (dep === "exports") return module.exports
    if (dep === "module") return module
    return __amdLoad(dep)
  })
  entry.factory.apply(null, args)
  // 工厂可能整体替换 module.exports（tsc 的 AMD 输出不会，但保留正确语义）。
  __amdInstances.set(id, module.exports)
  return module.exports
}

/** 内部 require：宿主 provide 的走宿主，我们打进去的走登记表。 */
function __amdRequire(id) {
  if (id === "react") return React
  return __amdLoad(id)
}
`;

/**
 * 入口胶水。
 *
 * **只有 8 行**，因为真正的入口逻辑在 `src/redteam/ui/console.ts` 里 ——
 * 那是经过类型检查的正式模块，也被 `test/ui/console.test.ts` 直接调用。
 * 这里只负责「给它宿主的两样东西」（`require` 与全局 `window`），
 * 然后把结果挂到 `exports` 上。
 *
 * 之所以不把它也写成 `.ts`：这两样东西（宿主 `require` 实参、全局 `window`）
 * 在编译期的模块图里**不存在**，只能在这里接。
 */
const ENTRY_GLUE = String.raw`
/* ── 入口：把宿主契约交给已编译的 console 模块 ──────────────────────
 *
 * 上游 dsh-qilin 的 client.js 末尾是：
 *     exports.name = name; exports.inject = inject; exports.apply = apply
 * 宿主读这三个。这里逐条对齐，另外多挂 __parts 供诊断（宿主不读）。 */
var __console = __amdLoad("redteam/ui/console")

var __module = __console.makeConsoleModule({
  // 宿主的 require 实参：只认 "react"，我们的 shim 透传。
  requireModule: __amdRequire,
  // 全局 window：SSR / node 里没有，返回 null 让 apply 报可读日志而不是崩。
  windowOf: function () { return typeof window === "undefined" ? null : window },
})

exports.name = __module.name
exports.inject = __module.inject
exports.apply = __module.apply
exports.__parts = __module.parts
`;

/** 组装完整片段：shim → tsc 输出 → 入口胶水。 */
function buildFragment(amdSource) {
  const normalized = amdSource.endsWith("\n") ? amdSource : amdSource + "\n";
  return [
    // 顺序有意义：shim 必须早于 tsc 输出（tsc 调 `define` 时它得已在作用域里）。
    SHIM.trim(),
    "",
    "/* tsc 把下面这部份当作全局 AMD define 调用；别名过来喂给我们的登记表。 */",
    "var define = __amdDefine",
    "",
    "/* ── 以下为 tsc --module AMD --outFile 的原样输出（未改写） ────────── */",
    normalized.trim(),
    "",
    ENTRY_GLUE.trim(),
    "",
  ].join("\n");
}

/** sha256（十六进制）。产物可复现性由它证明。 */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 动态 import 仓库里已编译的装配模块（`dist/`）。 */
async function loadAssembler() {
  const buildJs = path.join(ROOT, "dist", "redteam", "ui", "build.js");
  if (!existsSync(buildJs)) {
    throw new Error(
      "找不到 dist/redteam/ui/build.js —— 构建前需要先编译 TypeScript：\n"
      + "  npx tsc -p tsconfig.build.json",
    );
  }
  return import(pathToFileURL(buildJs).href);
}

/**
 * 主流程。
 *
 * - 无参数：构建并写 `client.js`
 * - `--check`：比对现有产物是否与源码同步，不同步则退出码 1（CI 门禁用）
 * - `--stdout`：产物打到 stdout，不落盘（测试用，避免测试互相踩文件）
 */
async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check");
  const toStdout = args.has("--stdout");

  const assembler = await loadAssembler();
  const amdSource = compileAmd();
  const fragment = buildFragment(amdSource);

  const assembled = assembler.assemble(assembler.defaultTemplate(MODULE_ID), fragment);
  if (!assembled.ok) {
    console.error("[build-client] 装配失败：" + assembled.error.kind);
    console.error(JSON.stringify(assembled.error, null, 2));
    process.exit(1);
  }
  const artifact = assembled.value.text;

  if (toStdout) {
    process.stdout.write(artifact);
    return;
  }

  if (checkOnly) {
    if (!existsSync(OUTPUT)) {
      console.error("[build-client] client.js 不存在 —— 需要先构建");
      process.exit(1);
    }
    const current = readFileSync(OUTPUT, "utf8");
    if (current !== artifact) {
      console.error("[build-client] client.js 已过期（源码改过但没重建）");
      console.error("  现有：" + sha256(current).slice(0, 16) + " / " + Buffer.byteLength(current, "utf8") + " 字节");
      console.error("  期望：" + sha256(artifact).slice(0, 16) + " / " + Buffer.byteLength(artifact, "utf8") + " 字节");
      process.exit(1);
    }
    console.log("[build-client] up to date：" + sha256(current).slice(0, 16)
      + "（" + Buffer.byteLength(current, "utf8") + " 字节）");
    return;
  }

  writeFileSync(OUTPUT, artifact, "utf8");
  console.log(
    "[build-client] 已写出 client.js："
    + Buffer.byteLength(artifact, "utf8") + " 字节 / "
    + artifact.split("\n").length + " 行 / sha256=" + sha256(artifact),
  );
  console.log("[build-client] 片段：" + assembled.value.fragmentBytes + " 字节（往返自检通过）");
}

main().catch((error) => {
  console.error("[build-client] " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
