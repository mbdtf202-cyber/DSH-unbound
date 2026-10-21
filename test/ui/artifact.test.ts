/**
 * **产物端到端测试**：从 `client.js`（磁盘上那份生成物）出发，走一遍真实加载路径。
 *
 * ## 为什么必须有这一层
 *
 * `test/ui/*.test.ts` 其余 30 个文件测的都是**源码**（`import` 自 `src/`）。
 * 源码全绿**不能**证明产物能跑 —— 打包过程可能引入的问题恰好落在
 * 源码测试够不着的地方：
 *
 * - 循环依赖被拍平后初始化顺序变了（`assets-model` ↔ `label` 这类）；
 * - `shared/result` 没打进去，产物里留一个无法解析的模块 id；
 * - `export` 语句的编译产物与 ESM 语义不一致；
 * - 入口 `apply` / `inject` 没挂到 `module.exports` 上（宿主读不到）。
 *
 * 所以这里的做法是：**用 `node:vm` 造一个假浏览器**，把 `client.js`
 * 整份执行一遍，然后只通过产物自己暴露的东西（`factory` 的返回值、
 * `__parts`）去断言。全程不 `import` `src/` 里的任何模块 ——
 * 一旦源码和产物脱节，这层就会红。
 *
 * ## 断言的四件事
 *
 * 1. **契约**：注册的 id 正确、factory 返回带 `apply`/`inject`/`name` 的对象；
 * 2. **加载**：`require("react")` 真的被调用（宿主 provide 的那一份）；
 * 3. **渲染**：13 个页签逐个渲染，每个都出非空节点树；
 * 4. **可复现**：同一输入两次构建字节完全相同（sha256 一致）。
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { makeTestReact, renderToText } from "./helpers/react.js";
import type { ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

/**
 * 仓库根。
 *
 * 这个文件会被编译到 `dist-test/test/ui/artifact.test.js`，从那里往上三层
 * 才是仓库根（`dist-test` → 仓库）。用「找 package.json」而不是固定层数：
 * 将来 tsconfig.test.json 改 outDir，这里不用跟着改。
 */
function findRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("从 " + from + " 向上找不到仓库根（没有 package.json + src）");
}

const ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT_JS = path.join(ROOT, "client.js");
const BUILD_SCRIPT = path.join(ROOT, "scripts", "build-client.mjs");

/** 产物里注册的模块（`__ModuleLoader__.load` 的入参）。 */
interface RegisteredModule {
  readonly id: string;
  readonly factory: (require: ModuleRequire) => unknown;
}

/** 产物 factory 返回的模块对象（宿主读的三个导出 + 诊断面）。 */
interface ArtifactModule {
  readonly name: string;
  readonly inject: readonly string[];
  readonly apply: (ctx: unknown) => void;
  readonly __parts: {
    readonly styles: { readonly css: string; readonly theme: string };
    readonly createRuntime: (windowRef: unknown) => unknown;
    readonly renderTab: (runtime: unknown, tab: string) => unknown;
    readonly tabCount: number;
  };
}

/**
 * 在 vm 沙箱里执行产物，返回它注册的模块。
 *
 * 沙箱只给产物两样东西：`window.__ModuleLoader__`（宿主会先建好）与
 * 内置构造器（`Map` / `Symbol` 等 —— vm 的独立 realm 里没有它们，
 * 而产物用到了 `new Map()` 与 `Symbol.toStringTag`）。
 */
function loadArtifact(source: string): readonly RegisteredModule[] {
  const registered: RegisteredModule[] = [];
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (module: RegisteredModule): void => {
          registered.push(module);
        },
      },
    },
    // vm 的 context 是独立 realm：显式给出产物用到的内置构造器。
    Map,
    Symbol,
    Object,
    Array,
    Error,
    String,
    Number,
    Boolean,
    Promise,
    JSON,
    Math,
  };
  sandbox["globalThis"] = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.js" });
  return registered;
}

/** 从注册项里取出模块对象（喂假 react）。 */
function instantiate(module: RegisteredModule): ArtifactModule {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  const exported = module.factory(requireModule) as ArtifactModule;
  return exported;
}

/** 造一个浏览器形态的 window（产物里的 `createRuntime` 需要它）。 */
function browserWindow(): Record<string, unknown> {
  return {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://127.0.0.1:43120/", hostname: "127.0.0.1", port: "43120", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => {
        throw new Error("本用例不创建 DOM 元素");
      },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    __ModuleLoader__: { load: () => undefined },
    fetch: () => Promise.resolve({ ok: true, status: 200, statusText: "OK", text: () => Promise.resolve("{\"ok\":true}") }),
  };
}

/** 13 个页签 id（与 `state.ts` 的 `ConsoleTabId` 一致）。 */
const ALL_TABS = Object.freeze([
  "assets", "env", "agents", "sessions", "findings", "chain",
  "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
] as const);

/** 产物源码（整份文件读一次，多个 describe 共用）。 */
let artifactSource = "";

before(() => {
  assert.ok(
    existsSync(CLIENT_JS),
    "找不到 client.js —— 先跑 `npm run build:client`（CI 里由 `npm run build` 产出）",
  );
  artifactSource = readFileSync(CLIENT_JS, "utf8");
});

describe("产物契约 —— 宿主怎么加载它", () => {
  it("文件存在且非空（>= 100 KB：36 个模块打进来不可能只有几 KB）", () => {
    assert.ok(artifactSource.length > 100_000, "产物太小，可能是空壳：" + artifactSource.length);
  });

  it("是 window.__ModuleLoader__.load({ id, factory }) 的形式", () => {
    assert.match(artifactSource, /window\.__ModuleLoader__\.load\(\{/);
    assert.match(artifactSource, /id: 'dsh-unbound'/);
    assert.match(artifactSource, /factory: \(require\) => \{/);
  });

  it("vm 沙箱里执行后**恰好注册一个**模块", () => {
    const registered = loadArtifact(artifactSource);
    assert.equal(registered.length, 1, "注册了 " + registered.length + " 个模块，宿主只期望 1 个");
  });

  it("注册的 id 是 dsh-unbound", () => {
    const registered = loadArtifact(artifactSource);
    assert.equal(registered[0]?.id, "dsh-unbound");
  });

  it("factory 是函数", () => {
    const registered = loadArtifact(artifactSource);
    assert.equal(typeof registered[0]?.factory, "function");
  });

  it("factory 真的调用了 require('react')（宿主 provide 的那一份）", () => {
    const registered = loadArtifact(artifactSource);
    const requested: string[] = [];
    const react = makeTestReact();
    registered[0]?.factory((id) => {
      requested.push(id);
      assert.equal(id, "react", "产物向宿主要了非 react 的模块：" + id);
      return react as unknown as ReactLike;
    });
    assert.ok(requested.length >= 1, "产物没有 require('react')");
    assert.deepEqual([...new Set(requested)], ["react"], "产物向宿主要了 react 以外的模块");
  });

  it("factory 返回对象带 name / inject / apply / __parts", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    assert.equal(module.name, "dsh-unbound");
    assert.ok(Array.isArray(module.inject), "inject 必须是数组");
    assert.deepEqual([...module.inject], ["slots", "locale"]);
    assert.equal(typeof module.apply, "function");
    assert.notEqual(module.__parts, undefined, "缺 __parts 诊断面");
  });

  it("产物末尾 return module.exports（模块契约的另一半）", () => {
    assert.match(artifactSource, /return module\.exports/);
  });
});

describe("产物完整性 —— 每个模块都真的打进来了", () => {
  it("包含 shared/result（4 个 model 依赖它，漏了就是浏览器里找不到模块）", () => {
    assert.ok(
      artifactSource.includes('define("shared/result"'),
      "产物里没有 shared/result 的 define —— 它会退化成未解析的 require",
    );
  });

  it("不留任何未解析的裸相对路径（../../shared/... 之类）", () => {
    // AMD 下所有依赖都必须是模块 id；出现 `require("../../` 说明 tsc
    // 没解析成功，运行时会找不到模块。
    assert.equal(artifactSource.includes('require("../../'), false, "产物里有未解析的相对 require");
    assert.equal(artifactSource.includes("require('./"), false, "产物里有未解析的相对 require");
  });

  it("12 个页签的模块都在（逐个查 define）", () => {
    for (const tab of [
      "assets-tab", "chain-tab", "env-tab", "findings-tab", "knowledge-tab", "prompts-tab",
      "report-tab", "score-tab", "session-tab", "skills-tab", "testing-tab", "attackfiles-tab",
    ]) {
      assert.ok(
        artifactSource.includes('define("redteam/client/' + tab + '"'),
        "缺页签模块：" + tab,
      );
    }
  });

  it("分派表、面板外壳、运行时、样式都在", () => {
    for (const module of ["tab-registry", "panel", "runtime", "styles", "entry", "state", "h", "helpers"]) {
      assert.ok(
        artifactSource.includes('define("redteam/client/' + module + '"'),
        "缺基础模块：" + module,
      );
    }
  });

  it("产物里没有与装配标记冲突的文本（否则下次构建会切错）", () => {
    assert.equal(
      artifactSource.split("/* @dsh-unbound:factory-begin */").length - 1,
      1,
      "begin 标记出现了不止一次",
    );
    assert.equal(
      artifactSource.split("/* @dsh-unbound:factory-end */").length - 1,
      1,
      "end 标记出现了不止一次",
    );
  });

  /**
   * 加数据层时**不需要改** `scripts/build-client.mjs` 的 `INCLUDE`。
   *
   * 这条断言锁住那个机制：`console.ts` 的 `import` 图会被 tsc 自动拉进产物。
   * 一旦有人误以为「必须把新文件写进 include」，或者把 `console.ts` 从
   * include 里去掉，这条会红 —— 比等到运行时浏览器白屏好得多。
   *
   * 具体证据：`console.ts` 引用了 `panel` / `tab-registry` / `runtime` 等
   * `client/**` 模块，也引用了 `redteam/ui/console` 自己；只要它们都在，
   * 就说明「按 import 图自动收纳」在生效。
   */
  it("console.ts 的依赖被自动打进来（不靠手写 include 列表）", () => {
    assert.ok(
      artifactSource.includes('define("redteam/ui/console"'),
      "console.ts 没进产物（它在 INCLUDE 里，说明 tsc 连入口都没编）",
    );
    for (const dep of ["panel", "tab-registry", "runtime", "styles", "api", "entry"]) {
      assert.ok(
        artifactSource.includes('define("redteam/client/' + dep + '"'),
        "console.ts 依赖的模块没被自动拉进来：" + dep,
      );
    }
  });

  it("产物里每个 define 的依赖都能在产物内解析（无悬空依赖）", () => {
    // 抽出所有 define("id", [...deps...]) 的 id 与依赖名。
    const defined = new Set<string>();
    for (const match of artifactSource.matchAll(/define\("([^"]+)",\s*\[([^\]]*)\]/g)) {
      defined.add(match[1] ?? "");
    }
    const dangling: string[] = [];
    for (const match of artifactSource.matchAll(/define\("([^"]+)",\s*\[([^\]]*)\]/g)) {
      const owner = match[1] ?? "";
      const depList = match[2] ?? "";
      for (const raw of depList.split(",")) {
        const dep = raw.trim().replace(/^"|"$/g, "");
        if (dep === "" || dep === "require" || dep === "exports" || dep === "module") continue;
        if (!defined.has(dep)) dangling.push(owner + " → " + dep);
      }
    }
    assert.deepEqual(dangling, [], "产物里有悬空依赖（运行时会抛「产物缺少模块」）：\n" + dangling.join("\n"));
  });
});

describe("产物渲染 —— 13 个页签逐个出非空节点树", () => {
  it("tabCount 是 13", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    assert.equal(module.__parts.tabCount, 13);
  });

  it("createRuntime 能造出运行时（不依赖宿主）", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    const runtime = module.__parts.createRuntime(browserWindow()) as { readonly h?: unknown };
    assert.equal(typeof runtime.h, "function");
  });

  it("13 个页签逐个渲染，每个都出**非空**节点树", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    const runtime = module.__parts.createRuntime(browserWindow());

    const failures: string[] = [];
    for (const tab of ALL_TABS) {
      let text = "";
      try {
        const node = module.__parts.renderTab(runtime, tab);
        if (node === null || node === undefined) {
          failures.push(tab + "：渲染成 " + String(node));
          continue;
        }
        text = renderToText(node as never).text;
      } catch (error) {
        failures.push(tab + "：抛错 " + (error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (text.trim() === "") failures.push(tab + "：可见文本为空");
    }
    assert.deepEqual(failures, [], "以下页签渲染失败：\n" + failures.join("\n"));
  });

  it("空 props 下走的是各页签的**空态**（不是白屏，也不是报错）", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    const runtime = module.__parts.createRuntime(browserWindow());
    /** 每个页签空态必须包含的关键词（与 tab-registry 的 MISSING 表对应）。 */
    const expected: readonly (readonly [string, RegExp])[] = [
      ["assets", /还没有资产/],
      ["env", /环境适配数据未加载/],
      ["sessions", /还没有会话或隧道/],
      ["findings", /还没有漏洞战果/],
      ["chain", /还没有攻击链步骤/],
      ["scores", /得分目标未加载/],
      ["report", /还没有可生成的报告/],
      ["knowledge", /知识库未加载/],
      ["skills", /技能库未加载/],
      ["testing", /还没有待测资产/],
      ["attackfiles", /还没有保存的攻击文件/],
      ["prompts", /提示词目录未加载/],
      ["agents", /智能体概览未接入/],
    ];
    for (const [tab, pattern] of expected) {
      const text = renderToText(module.__parts.renderTab(runtime, tab) as never).text;
      assert.match(text, pattern, tab + " 的空态文案不对：" + text.slice(0, 80));
    }
  });

  it("渲染结果里不泄漏 undefined / null 字样", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    const runtime = module.__parts.createRuntime(browserWindow());
    for (const tab of ALL_TABS) {
      const text = renderToText(module.__parts.renderTab(runtime, tab) as never).text;
      assert.doesNotMatch(text, /undefined/, tab + " 漏出了 undefined：" + text.slice(0, 120));
      assert.doesNotMatch(text, /\bnull\b/, tab + " 漏出了 null：" + text.slice(0, 120));
    }
  });

  /**
   * 分派表的兜底分支。
   *
   * `tab-registry.test.ts` 在源码层证过「页签抛错不白屏」。打包后要确认的是
   * **那段兜底代码还在产物里**（不是被 tree-shake 掉、也不是被压缩改名成
   * 另一个字符串）。产物对外只暴露 `renderTab(runtime, tab)`（固定空 props），
   * 没法从外部喂一个会抛的 props，所以这里断言兜底分支的三个可辨识标记：
   * 样式类 `rt-pane`、错误标题、给用户的后续建议。
   */
  it("兜底分支还在产物里（页签抛错时的降级 UI）", () => {
    assert.ok(artifactSource.includes("rt-pane"), "缺兜底样式类 rt-pane");
    assert.ok(artifactSource.includes("页签渲染失败"), "缺兜底标题");
    assert.ok(artifactSource.includes("面板与其它页签仍可使用"), "缺兜底提示");
    assert.ok(artifactSource.includes("常见原因"), "缺兜底排查建议");
  });
});

describe("产物样式 —— CSS 与 THEME 都要在", () => {
  it("styles 是 { css, theme } 对象（不是字符串）", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    assert.equal(typeof module.__parts.styles, "object");
    assert.equal(typeof module.__parts.styles.css, "string");
    assert.equal(typeof module.__parts.styles.theme, "string");
  });

  it("CSS 非空且含真实样式规则（.rt- 前缀）", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    assert.ok(module.__parts.styles.css.length > 10_000, "CSS 太短：" + module.__parts.styles.css.length + " 字节");
    assert.match(module.__parts.styles.css, /\.rt-dock/);
    assert.match(module.__parts.styles.css, /\.rt-tab/);
  });

  it("THEME 非空且含 CSS 自定义属性（--dsu- 前缀）", () => {
    const module = instantiate(loadArtifact(artifactSource)[0] as RegisteredModule);
    assert.ok(module.__parts.styles.theme.length > 5_000, "THEME 太短：" + module.__parts.styles.theme.length + " 字节");
    assert.match(module.__parts.styles.theme, /--dsu-/);
  });

  it("样式在产物源码里以字符串字面量形式存在（不是被摇掉）", () => {
    // 抽查两个只应出现在样式里的选择器。
    assert.ok(artifactSource.includes(".rt-resize-r"), "样式内容没进产物");
    assert.ok(artifactSource.includes("--dsu-font-mono"), "THEME 变量没进产物");
  });
});

describe("产物可复现 —— 同一输入两次构建字节相同", () => {
  /** 跑一次 `--stdout` 构建，返回产物文本。 */
  function buildToStdout(): string {
    return execFileSync(process.execPath, [BUILD_SCRIPT, "--stdout"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  it("两次构建字节完全一致（sha256 相同）", () => {
    const first = buildToStdout();
    const second = buildToStdout();
    assert.equal(first.length, second.length, "两次构建长度不同");
    const hashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
    assert.equal(hashOf(first), hashOf(second), "两次构建 sha256 不同 —— 产物不可复现");
  });

  it("重新构建的结果与磁盘上的 client.js 一致（产物没过期）", () => {
    const rebuilt = buildToStdout();
    assert.equal(
      createHash("sha256").update(rebuilt, "utf8").digest("hex"),
      createHash("sha256").update(artifactSource, "utf8").digest("hex"),
      "磁盘上的 client.js 与重新构建的结果不一致 —— 源码改了但没重建（跑 npm run build:client）",
    );
  });

  it("`--check` 在产物最新时 exit 0", () => {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [BUILD_SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    });
  });

  it("`--check` 报出一致的 sha256 前缀与字节数", () => {
    const output = execFileSync(process.execPath, [BUILD_SCRIPT, "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    const expectedBytes = Buffer.byteLength(artifactSource, "utf8");
    assert.ok(output.includes(String(expectedBytes)), "check 输出的字节数与磁盘不符：" + output.trim());
    assert.match(output, /up to date/);
  });
});
