/**
 * 样式层测试。
 *
 * ## 这块代码的四类风险，测试就分四组
 *
 * 1. **模板完整性** —— `CSS` 是 45KB 的内联字符串，一旦混进反引号或 `${`
 *    就会静默截断（TS 照样编译通过，只是样式少了半截）。所以直接断言字符，
 *    并且断言首尾锚点：截断通常从尾巴开始，首尾都在才说明整块没丢。
 * 2. **令牌有效性** —— `var(--dsw-xxx)` 拼错不报错，只会让整条声明被丢弃。
 *    白名单断言把拼写错误挡在提交前，**并把违规名字打出来**（否则只看到
 *    "deepEqual 失败"，还得自己去翻 45KB）。
 * 3. **选择器隔离** —— 演练台样式注入的是宿主页面。任何一条漏掉 `.rt-` 前缀
 *    的规则都会串味到宿主的全局样式（`body{}` 一条就够把整页改掉）。
 * 4. **深色主题的层叠陷阱** —— 这是**实测踩过的真 bug**：派生的 `--dsu-*`
 *    只在 `:root` 声明时会被浅色值冻结（`var()` 在声明处替换），深色下静默
 *    用浅色。断言「alias 派生集 ⊆ 深色重声明集」锁住它。
 *
 * `installStyles` 单独一组：幂等与清理是热重载下的真实故障点。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSS,
  DEFAULT_STYLE_KEY,
  STYLE_ATTR,
  THEME,
  THEME_TOKENS,
  TOKEN_WHITELIST,
  UPSTREAM_TOKENS,
  installStyles,
  type DocumentLike,
} from "../../src/redteam/client/styles.js";

// ───────────────────────────── CSS 扫描工具 ─────────────────────────────

/**
 * 去掉 `/* … *\/` 注释。
 *
 * 必须先去注释：上游有十几条规则带前置注释（`/* 未读红点… *\/ .rt-tab-dot{`），
 * 不剥的话选择器前缀提取会把注释文本当成选择器，报一堆假违规。
 */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = css.indexOf("/*", i);
    if (start < 0) {
      out += css.slice(i);
      return out;
    }
    out += css.slice(i, start);
    const end = css.indexOf("*/", start + 2);
    if (end < 0) return out; // 未闭合注释：丢弃尾部，避免把注释当选择器
    i = end + 2;
  }
}

/** 一条规则块。 */
interface RuleBlock {
  /** 逗号分隔的选择器列表（at-rule 的 prelude 也在内，如 `@media (…)`）。 */
  readonly prelude: string;
  /** 花括号内的原文。 */
  readonly body: string;
}

/**
 * 扫描出所有规则块。
 *
 * 手写扫描而不是正则：CSS 里有 `@keyframes`（其内部 `0%,100%` 也是花括号块）
 * 和 `@media`（其内部才是真规则），正则的前后文断言很难既跳过前者又进入后者。
 *
 * 规则：
 * - `@keyframes` 块**整块跳过** —— 里面的 `0%` / `50%` 不是选择器。
 * - 其它 at-rule（`@media` / `@supports`）的 prelude 不收，但**进入**它的块
 *   继续收内部规则（那才是真正生效的 `.rt-*` 规则）。
 * - 普通规则收 prelude，并进入其块（当前没有嵌套规则，但不假设）。
 */
function ruleBlocks(css: string): RuleBlock[] {
  const text = stripComments(css);
  const out: RuleBlock[] = [];
  /** 每层块是否「收集内部规则」；false = 整块跳过（@keyframes）。 */
  const collect: boolean[] = [];
  const skipping = (): boolean => collect.includes(false);
  let buf = "";
  let bodyStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      bodyStart = i + 1;
      const isAtRule = prelude.startsWith("@");
      const isKeyframes = /^@(?:-webkit-)?keyframes\b/.test(prelude);
      if (isAtRule) {
        collect.push(!isKeyframes);
      } else {
        if (!skipping()) out.push({ prelude, body: "" });
        collect.push(true);
      }
      continue;
    }
    if (ch === "}") {
      // 回填最近一条被收集规则的 body
      const last = out[out.length - 1];
      if (last !== undefined && last.body === "" && !skipping()) {
        out[out.length - 1] = { prelude: last.prelude, body: text.slice(bodyStart, i) };
      }
      buf = "";
      collect.pop();
      continue;
    }
    buf += ch;
  }
  return out;
}

/**
 * 选择器列表里的每个「首个复合选择器」。
 *
 * 只取逗号分隔后的第一段、再去掉后代/子代组合符之后的第一个复合项 ——
 * 隔离检查关心的是「这条规则会不会命中宿主元素」，也就是最左边那一项。
 */
function selectorHeads(css: string): string[] {
  const heads: string[] = [];
  for (const block of ruleBlocks(css)) {
    if (block.prelude.startsWith("@")) continue;
    for (const part of block.prelude.split(",")) {
      const trimmed = part.trim().replace(/\s+/g, " ");
      if (trimmed === "") continue;
      const head = /^[^\s>+~]+/.exec(trimmed)?.[0] ?? trimmed;
      if (head !== "") heads.push(head);
    }
  }
  return heads;
}

/** `{` 的个数 = 规则块数（含 at-rule 块）。 */
function blocksOf(css: string): number {
  return (css.match(/\{/g) ?? []).length;
}

/** 抽出 `var(--dsw-…)` 引用到的令牌名（去重、保序）。 */
function referencedTokens(css: string): string[] {
  const seen = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)) {
    const name = match[1];
    if (name !== undefined) seen.add(name);
  }
  return [...seen];
}

/** 抽出所有自定义属性声明名。 */
function declaredNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * 抽出「值里引用了 `--dsw-alias-*` 的 `--dsu-*` 声明」。
 *
 * 这些就是**依赖主题**的派生变量 —— 必须在深色块里重声明，
 * 否则会在 `:root` 上被浅色值冻结。
 */
function aliasDerivedNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const block of ruleBlocks(css)) {
    if (block.prelude.startsWith("@")) continue;
    for (const decl of block.body.matchAll(/(--dsu-[a-z0-9-]+)\s*:\s*([^;]+)/g)) {
      const name = decl[1];
      const value = decl[2] ?? "";
      if (name !== undefined && /var\(\s*--dsw-alias-/.test(value)) names.add(name);
    }
  }
  return names;
}

/** 深色块（`[data-ds-dark-theme]` 那一组）里声明的 `--dsu-*` 名。 */
function darkDeclaredNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const block of ruleBlocks(css)) {
    if (!block.prelude.includes("[data-ds-dark-theme]")) continue;
    for (const decl of block.body.matchAll(/(--dsu-[a-z0-9-]+)\s*:/g)) {
      const name = decl[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/** 所有 **prelude** 中含 `needle` 的规则块（用于「哪些选择器命中了 X」）。 */
function blocksMentioning(css: string, needle: string): RuleBlock[] {
  return ruleBlocks(css).filter((block) => block.prelude.includes(needle));
}

/**
 * 所有 **body** 中含 `needle` 的规则块（用于「哪个属性被写在哪」）。
 *
 * 与 `blocksMentioning` 分开是必须的：`tabular-nums` / `var(--dsu-row-h)`
 * 这类是**声明**，只出现在花括号内部。混用一个函数会让断言永远查不到，
 * 变成「看起来在测、实际恒失败/恒通过」的假断言。
 */
function blocksWithBody(css: string, needle: string): RuleBlock[] {
  return ruleBlocks(css).filter((block) => block.body.includes(needle));
}

/**
 * 所有 at-rule 的 prelude（`@media …` / `@supports …`）。
 *
 * `ruleBlocks` **故意不把 at-rule 的 prelude 当规则收**（它不是选择器，
 * 混进隔离检查会误报）。但「有没有 `@media (prefers-reduced-motion)`」
 * 这类断言需要它，所以单独抽一个只读扫描。
 */
function atRulePreludes(css: string): string[] {
  const text = stripComments(css);
  const out: string[] = [];
  for (const match of text.matchAll(/(@[a-z-]+[^{};]*)\{/g)) {
    const prelude = match[1];
    if (prelude !== undefined) out.push(prelude.trim());
  }
  return out;
}

/** 断言集合 A ⊆ B，失败时把差集逐个打出来。 */
function assertSubset(actual: Iterable<string>, allowed: ReadonlySet<string>, label: string): void {
  const offenders = [...actual].filter((name) => !allowed.has(name)).sort();
  assert.deepEqual(
    offenders,
    [],
    `${label} 越界（共 ${offenders.length} 个）：\n` + offenders.map((n) => "  · " + n).join("\n"),
  );
}

// ───────────────────────────── 假 document ─────────────────────────────

/** 假 `<style>` 节点：记录属性、内容、是否被移除。 */
interface FakeStyle {
  textContent: string | null;
  readonly attrs: Record<string, string>;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface FakeDoc {
  readonly doc: DocumentLike;
  /** 被 append 进 `<head>` 的节点（按顺序）。 */
  readonly appended: FakeStyle[];
  /** 被 createElement 创建过的节点（含未 append 的）。 */
  readonly created: FakeStyle[];
}

/**
 * 造假 document —— 不依赖真实 DOM。
 *
 * `querySelector` 只实现我们真正用到的形状 `style[attr="value"]`，
 * 并且**跳过已移除的节点**：真实 DOM 里 `remove()` 之后查询就查不到了，
 * 假文档必须复刻这一条，否则「清理后再注入」这类用例会被假象蒙过去。
 *
 * `withQuerySelector: false` 用来模拟精简文档对象（没有查询能力），
 * 验证注入器会退化到「按实例记忆」的幂等，而不是抛错。
 */
function makeDoc(options: { readonly withQuerySelector?: boolean } = {}): FakeDoc {
  const appended: FakeStyle[] = [];
  const created: FakeStyle[] = [];

  const doc = {
    createElement(): FakeStyle {
      const node: FakeStyle = {
        textContent: null,
        attrs: {},
        removed: false,
        setAttribute(name: string, value: string): void {
          node.attrs[name] = value;
        },
        remove(): void {
          node.removed = true;
        },
      };
      created.push(node);
      return node;
    },
    head: {
      append(child: FakeStyle): void {
        appended.push(child);
      },
    },
  } as unknown as DocumentLike;

  if (options.withQuerySelector !== false) {
    Object.assign(doc, {
      querySelector(selector: string): FakeStyle | null {
        const match = /^style\[([a-z-]+)="([^"]*)"\]$/.exec(selector);
        if (match === null) return null;
        const attr = match[1] ?? "";
        const value = match[2] ?? "";
        return appended.find((node) => !node.removed && node.attrs[attr] === value) ?? null;
      },
    });
  }

  return { doc, appended, created };
}

// ───────────────────────────── 1. CSS 模板完整性 ─────────────────────────────

describe("CSS 段：模板完整性", () => {
  it("非空（不是空模板）", () => {
    assert.ok(CSS.length > 0);
  });

  it("行数 > 500（上游 539 行，用下限断言）", () => {
    const lines = CSS.split("\n").length;
    assert.ok(lines > 500, `实际 ${lines} 行`);
  });

  it("规则数 > 400（上游 422 条，用下限断言）", () => {
    const n = blocksOf(CSS);
    assert.ok(n > 400, `实际 ${n} 条`);
  });

  it("不含反引号（否则模板在此截断）", () => {
    assert.equal(CSS.includes("`"), false);
  });

  it("不含 ${（否则模板插值会炸）", () => {
    assert.equal(CSS.includes("${"), false);
  });

  it("不含反斜杠（String.raw 下仍会走样，且上游本来没有）", () => {
    assert.equal(CSS.includes("\\"), false);
  });

  it("大括号数量相等（粗粒度平衡）", () => {
    const open = (CSS.match(/\{/g) ?? []).length;
    const close = (CSS.match(/\}/g) ?? []).length;
    assert.equal(open, close, `{ ${open} 个，} ${close} 个`);
  });

  it("保留上游的招牌规则（抽查 3 条，证明确实是演练台样式表）", () => {
    assert.ok(CSS.includes(".rt-dock{"), ".rt-dock 丢了");
    assert.ok(CSS.includes(".rt-split{"), ".rt-split 丢了");
    assert.ok(CSS.includes(".rt-toolbar{"), ".rt-toolbar 丢了");
  });

  it("首尾锚点都在（截断通常从尾巴开始）", () => {
    assert.ok(CSS.trimStart().startsWith(".rt-dock{"), "头部不是 .rt-dock");
    assert.ok(CSS.trimEnd().endsWith(".rt-shot-zoom-cap{color:#e5e7eb;font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}"), "尾部不是 .rt-shot-zoom-cap");
  });

  it("三张表的核心类都在（资产 / 漏洞 / 得分）", () => {
    for (const name of [".rt-row{", ".rt-vrow{", ".rt-score-row{"]) {
      assert.ok(CSS.includes(name), `缺少 ${name}`);
    }
  });
});

// ───────────────────────────── 2. CSS 选择器隔离 ─────────────────────────────

/**
 * `.rt-` / `.dshp-` / `[data-` 之外的**白名单例外**。
 *
 * 目前为空：上游 422 条规则全部以 `.rt-` 开头（注释里那些「假选择器」被
 * `stripComments` 剥掉了）。保留这个常量是为了将来真有例外时，
 * 在这一处集中登记 + 写理由，而不是放宽断言。
 */
const SELECTOR_EXCEPTIONS: readonly string[] = Object.freeze([]);

describe("CSS 段：选择器隔离（不许串味到宿主全局）", () => {
  it("每个选择器的首项都属于 .rt- / .dshp- / [data- 家族", () => {
    const heads = selectorHeads(CSS);
    const allowed = new Set(SELECTOR_EXCEPTIONS);
    const offenders = heads
      .filter((head) => !/^(?:\.(?:rt|dshp)-|\[data-)/.test(head))
      .filter((head) => !allowed.has(head))
      .sort();
    assert.deepEqual(
      offenders,
      [],
      `这些选择器会命中宿主元素（共 ${offenders.length} 个）：\n` +
        offenders.map((n) => "  · " + n).join("\n"),
    );
  });

  it("提取器确实抽到了足够多的选择器（防「空数组恒通过」）", () => {
    const heads = selectorHeads(CSS);
    assert.ok(heads.length > 400, `只抽到 ${heads.length} 个`);
  });

  it("没有裸标签 / html / body / :root 这类全局选择器", () => {
    const heads = selectorHeads(CSS);
    const global = heads.filter((head) => /^(?:html|body|:root|\*|[a-z]+\b)/.test(head));
    assert.deepEqual(global, [], `出现了全局选择器：${global.join(", ")}`);
  });

  it("没有带 #id 的选择器（id 属于宿主，不能被我们挑中）", () => {
    const withId = selectorHeads(CSS).filter((head) => head.includes("#"));
    assert.deepEqual(withId, [], `出现了 id 选择器：${withId.join(", ")}`);
  });

  it("选择器里没有 !important 之外的越界写法（抽查：无 @import）", () => {
    assert.equal(CSS.includes("@import"), false, "@import 会把外部样式表拉进来");
  });
});

// ───────────────────────────── 3. THEME 令牌白名单 ─────────────────────────────

describe("THEME 段：令牌白名单", () => {
  it("THEME 非空", () => {
    assert.ok(THEME.length > 0);
  });

  it("**THEME 引用的每个 --dsw-* 都在白名单里**", () => {
    assertSubset(referencedTokens(THEME), TOKEN_WHITELIST, "THEME 引用的令牌");
  });

  it("白名单全部是 --dsw- 前缀（防手滑写错命名空间）", () => {
    const bad = THEME_TOKENS.filter((name) => !name.startsWith("--dsw-"));
    assert.deepEqual(bad, []);
  });

  it("白名单无重复", () => {
    assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length);
  });

  it("白名单非空且规模合理（8 ≤ n ≤ 64，防止被清空后断言失去意义）", () => {
    assert.ok(THEME_TOKENS.length >= 8 && THEME_TOKENS.length <= 64, `实际 ${THEME_TOKENS.length}`);
  });

  it("UPSTREAM_TOKENS 恰好 9 个（上游 CSS 实际引用数）", () => {
    assert.equal(UPSTREAM_TOKENS.length, 9);
  });

  it("CSS 段引用的令牌与 UPSTREAM_TOKENS 完全一致（多一个少一个都要红）", () => {
    const used = referencedTokens(CSS).sort();
    const declared = [...UPSTREAM_TOKENS].sort();
    assert.deepEqual(used, declared);
  });

  it("UPSTREAM_TOKENS ⊆ 白名单（THEME 可以复用上游令牌）", () => {
    assertSubset(UPSTREAM_TOKENS, TOKEN_WHITELIST, "UPSTREAM_TOKENS");
  });

  it("TOKEN_WHITELIST 与 THEME_TOKENS 内容一致", () => {
    assert.deepEqual([...TOKEN_WHITELIST].sort(), [...THEME_TOKENS].sort());
  });
});

// ───────────────────────────── 4. THEME 纯净度 ─────────────────────────────

describe("THEME 段：不硬编码主色", () => {
  it("**不含任何十六进制色值**（主色只能从 --dsw-* 派生）", () => {
    const hex = THEME.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hex, [], `出现了硬编码色值：${hex.join(", ")}`);
  });

  it("不含 rgb()/hsl() 字面量（同样是为了不从零发明颜色）", () => {
    const literals = THEME.match(/\b(?:rgb|rgba|hsl|hsla)\(/g) ?? [];
    assert.deepEqual(literals, []);
  });

  it("颜色要么走 var(--dsw-*)，要么走 color-mix()", () => {
    // 出现 color: 或 background: 的行里，值必须含 var( 或 color-mix(
    const colorLines = THEME.split("\n").filter((line) => /(?:^|[;{\s])(?:color|background|border-color|outline-color)\s*:/.test(line));
    assert.ok(colorLines.length > 10, `只找到 ${colorLines.length} 行颜色声明，提取器可能失效`);
    const offenders = colorLines.filter(
      (line) => !line.includes("var(") && !line.includes("color-mix(") && !line.includes("transparent") && !line.includes("currentColor") && !line.includes("inherit"),
    );
    assert.deepEqual(offenders, [], `这些颜色声明没有从令牌派生：\n${offenders.join("\n")}`);
  });

  it("不含反引号与 ${（模板安全）", () => {
    assert.equal(THEME.includes("`"), false);
    assert.equal(THEME.includes("${"), false);
  });

  it("大括号数量相等", () => {
    const open = (THEME.match(/\{/g) ?? []).length;
    const close = (THEME.match(/\}/g) ?? []).length;
    assert.equal(open, close, `{ ${open} 个，} ${close} 个`);
  });

  it("THEME 只叠加不改写：不重复声明上游已经写过的『非覆盖意图』属性", () => {
    // 判据：THEME 不复制 .rt-dock 的定位/尺寸（那是上游的布局契约）
    const dockRules = blocksMentioning(THEME, ".rt-dock");
    const layout = dockRules.filter((block) => /position\s*:/.test(block.body));
    assert.deepEqual(layout.map((block) => block.prelude), [], "THEME 不该改 .rt-dock 的定位");
  });
});

// ───────────────────────────── 5. 设计变量阶梯 ─────────────────────────────

describe("THEME 段：设计变量阶梯", () => {
  it("圆角梯度 --dsu-radius-xs/sm/md/lg 都在", () => {
    const declared = declaredNames(THEME);
    const missing = ["--dsu-radius-xs", "--dsu-radius-sm", "--dsu-radius-md", "--dsu-radius-lg"].filter((n) => !declared.has(n));
    assert.deepEqual(missing, [], `缺失：${missing.join(", ")}`);
  });

  it("间距梯度 --dsu-space-1..6 都在", () => {
    const declared = declaredNames(THEME);
    const missing = [1, 2, 3, 4, 5, 6].map((n) => `--dsu-space-${n}`).filter((n) => !declared.has(n));
    assert.deepEqual(missing, [], `缺失：${missing.join(", ")}`);
  });

  it("字体栈 --dsu-font-mono 与 --dsu-font-ui 都在，且真的被规则用到", () => {
    const declared = declaredNames(THEME);
    assert.ok(declared.has("--dsu-font-mono"));
    assert.ok(declared.has("--dsu-font-ui"));
    assert.ok((THEME.match(/var\(--dsu-font-mono\)/g) ?? []).length >= 2, "mono 字体没被用到");
  });

  it("行高梯度至少 3 档（徽章 / 表格行 / 正文 各一档）", () => {
    const names = [...declaredNames(THEME)].filter((n) => n.startsWith("--dsu-lh-"));
    assert.ok(names.length >= 3, `只有 ${names.length} 档：${names.join(", ")}`);
  });

  it("字重梯度至少 3 档（常规 / semi / bold）", () => {
    const names = [...declaredNames(THEME)].filter((n) => n.startsWith("--dsu-fw-"));
    assert.ok(names.length >= 3, `只有 ${names.length} 档：${names.join(", ")}`);
  });

  it("字号梯度至少 3 档", () => {
    const names = [...declaredNames(THEME)].filter((n) => n.startsWith("--dsu-fs-"));
    assert.ok(names.length >= 3, `只有 ${names.length} 档：${names.join(", ")}`);
  });

  it("间距 / 圆角 / 字体这些不依赖主题的变量只在 :root 声明一次（不在深色块重复）", () => {
    const dark = darkDeclaredNames(THEME);
    const themeIndependent = ["--dsu-space-1", "--dsu-radius-lg", "--dsu-font-mono", "--dsu-lh-base", "--dsu-fw-semi"];
    const redundant = themeIndependent.filter((name) => dark.has(name));
    assert.deepEqual(redundant, [], `这些不引用 alias，深色块里不必重声明：${redundant.join(", ")}`);
  });
});

// ───────────────────────────── 6. 等宽数字与表格密度 ─────────────────────────────

describe("THEME 段：等宽数字", () => {
  it("含 tabular-nums", () => {
    assert.ok(THEME.includes("tabular-nums"));
  });

  it("端口 / 分值 / 计数 / 时间戳所需的类都被 tabular-nums 覆盖", () => {
    const rules = blocksWithBody(THEME, "tabular-nums");
    assert.ok(rules.length > 0, "没有找到 tabular-nums 规则");
    const covered = rules.map((block) => block.prelude).join(",");
    const required = [".rt-mono", ".rt-row", ".rt-vrow", ".rt-score-row", ".rt-tag", ".rt-sev"];
    const missing = required.filter((name) => !covered.includes(name));
    assert.deepEqual(missing, [], `这些类没有等宽数字：${missing.join(", ")}`);
  });

  it("五档严重度的徽章类都带等宽数字（.rt-sev-* 家族）", () => {
    const covered = blocksWithBody(THEME, "tabular-nums")
      .map((block) => block.prelude)
      .join(",");
    const missing = ["critical", "high", "medium", "low", "info"]
      .map((family) => `.rt-sev-${family}`)
      .filter((name) => !covered.includes(name));
    assert.deepEqual(missing, [], `缺失：${missing.join(", ")}`);
  });

  it("数字列用等宽字体族（不只是 tabular-nums）", () => {
    const monoRules = blocksWithBody(THEME, "var(--dsu-font-mono)");
    assert.ok(monoRules.length > 0);
    const covered = monoRules.map((block) => block.prelude).join(",");
    assert.ok(covered.includes(".rt-mono"));
  });
});

describe("THEME 段：表格密度", () => {
  it("三张表共用同一个行高变量 --dsu-row-h", () => {
    const rules = blocksWithBody(THEME, "var(--dsu-row-h)");
    assert.ok(rules.length > 0);
    const covered = rules.map((block) => block.prelude).join(",");
    for (const name of [".rt-row", ".rt-vrow", ".rt-score-row"]) {
      assert.ok(covered.includes(name), `${name} 没有用行高变量`);
    }
  });

  it("表头有独立的（更矮的）行高变量", () => {
    assert.ok(THEME.includes("--dsu-row-h-head"));
    const headRules = blocksMentioning(THEME, ".head");
    const usesHeadVar = headRules.some((block) => block.body.includes("var(--dsu-row-h-head)"));
    assert.ok(usesHeadVar, "表头没有用 --dsu-row-h-head");
  });

  it("hover 态从 --dsw-alias-bg-layer-* 派生（不硬编码色值）", () => {
    const hoverRules = blocksMentioning(THEME, ":hover");
    const withBgLayer = hoverRules.filter((block) => block.body.includes("var(--dsw-alias-bg-layer-"));
    assert.ok(withBgLayer.length > 0, "hover 没有从 bg-layer 派生");
    // 三张表的 hover 都在
    const covered = withBgLayer.map((block) => block.prelude).join(",");
    for (const name of [".rt-row", ".rt-vrow", ".rt-score-row"]) {
      assert.ok(covered.includes(name), `${name}:hover 没覆盖`);
    }
  });

  it("hover 走派生变量 --dsu-hover-bg（该变量自己在 :root 与深色块各声明一次）", () => {
    const rules = blocksWithBody(THEME, "var(--dsu-hover-bg)");
    assert.ok(rules.length > 0, "没有任何规则用 --dsu-hover-bg");
    const covered = rules.map((block) => block.prelude).join(",");
    for (const name of [".rt-row:hover", ".rt-vrow:hover", ".rt-score-row:hover"]) {
      assert.ok(covered.includes(name), `${name} 没用派生 hover 底色`);
    }
    assert.equal((THEME.match(/--dsu-hover-bg\s*:/g) ?? []).length, 2, "hover 底色应在 :root 与深色块各声明一次");
  });

  it("选中态用细左轨 + 派生底色（不是整行填死色）", () => {
    const onRules = blocksMentioning(THEME, ".rt-row.on");
    assert.ok(onRules.length > 0, "没有 .rt-row.on 规则");
    const all = onRules.map((block) => block.body).join(";");
    assert.ok(all.includes("inset 2px 0 0"), "选中态没有细左轨");
    assert.ok(all.includes("var(--dsu-selected-bg)"), "选中态没有用派生的选中底色");
  });

  it("选中底色 --dsu-selected-bg 在 :root 与深色块各声明一次", () => {
    const declared = declaredNames(THEME);
    assert.ok(declared.has("--dsu-selected-bg"));
    assert.equal((THEME.match(/--dsu-selected-bg\s*:/g) ?? []).length, 2, "选中底色应在 :root 与深色块各声明一次");
  });

  it("得分命中行有独立强调（.rt-score-row.hit）", () => {
    const hit = blocksMentioning(THEME, ".rt-score-row.hit");
    assert.ok(hit.length > 0);
    assert.ok(hit.some((block) => block.body.includes("--dsw-alias-state-success-primary")));
  });

  it("长文本换行不截断（域名/口令/回显要看全）", () => {
    assert.ok(THEME.includes("overflow-wrap:anywhere"));
  });
});

// ───────────────────────────── 7. 五档严重度 ─────────────────────────────

describe("THEME 段：五档严重度语义色", () => {
  const FAMILIES = ["critical", "high", "medium", "low", "info"] as const;
  const SLOTS = ["fg", "bg", "border"] as const;

  it("五档 × 三件 = 15 个变量全部声明", () => {
    const declared = declaredNames(THEME);
    const missing: string[] = [];
    for (const family of FAMILIES) {
      for (const slot of SLOTS) {
        const name = `--dsu-sev-${family}-${slot}`;
        if (!declared.has(name)) missing.push(name);
      }
    }
    assert.deepEqual(missing, [], `缺失：${missing.join(", ")}`);
  });

  it("每档的 .rt-sev-<family> 规则都引用了自己的三件套", () => {
    const problems: string[] = [];
    for (const family of FAMILIES) {
      const rules = blocksMentioning(THEME, `.rt-sev-${family}`);
      if (rules.length === 0) {
        problems.push(`.rt-sev-${family} 没有规则`);
        continue;
      }
      const body = rules.map((block) => block.body).join(";");
      for (const slot of SLOTS) {
        const name = `--dsu-sev-${family}-${slot}`;
        if (!body.includes(`var(${name})`)) problems.push(`.rt-sev-${family} 没用 ${name}`);
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("bg / border 从 fg 的同一色相混出来（不是各写一个色）", () => {
    const body = blocksWithBody(THEME, "--dsu-sev-critical-bg").map((block) => block.body).join(";");
    assert.ok(body.includes("color-mix("), "严重度底色/描边没有从同一色相混出");
    // bg / border 必须引用与 fg 相同的源色（critical 档 = alias-state-error-primary）
    assert.ok(body.includes("var(--dsw-alias-state-error-primary)"), `critical 底色/描边没引用 error 源色：${body.slice(0, 200)}`);
  });

  it("medium 与 low 用静态色阶而不是别名状态色（避免和 warn/error 撞色）", () => {
    const declared = THEME.match(/--dsu-sev-medium-fg\s*:\s*([^;]+)/)?.[1] ?? "";
    const lowFg = THEME.match(/--dsu-sev-low-fg\s*:\s*([^;]+)/)?.[1] ?? "";
    assert.ok(declared.includes("--dsw-static-amber"), `medium 应为 amber 阶，实际 ${declared.trim()}`);
    assert.ok(lowFg.includes("--dsw-static-blue"), `low 应为 blue 阶，实际 ${lowFg.trim()}`);
  });
});

// ───────────────────────────── 8. 深色主题补偿 ─────────────────────────────

describe("THEME 段：success 色的对比度补偿（真缺陷回归）", () => {
  // 背景：宿主 --dsw-alias-state-success-primary 在浅色下是 green-500 (#22c55e)，
  // 白底对比度只有 2.28:1 —— 11px 徽章文字读不清（WCAG AA 小字要 4.5:1）。
  // 曾经因为它"直接引用 alias、看着最规范"而被改回去，这条测试锁住补偿。

  it("**success 的消费点走 --dsu-success-fg，而不是直接引 alias**", () => {
    for (const cls of [".rt-avail-available", ".rt-tag-live", ".rt-test-tested"]) {
      const rules = blocksMentioning(THEME, cls);
      assert.ok(rules.length > 0, cls + " 没有规则");
      const body = rules.map((r) => r.body).join(";");
      assert.ok(
        body.includes("var(--dsu-success-fg)"),
        cls + " 没有走 --dsu-success-fg（浅色下对比度会掉到 2.28:1）",
      );
    }
  });

  it("--dsu-success-fg 在 :root 与深色块各声明一次（派生值必须重声明）", () => {
    const all = [...THEME.matchAll(/--dsu-success-fg\s*:/g)].length;
    assert.ok(all >= 2, `只声明了 ${all} 次，深色块漏了重声明`);
    assert.ok(darkDeclaredNames(THEME).has("--dsu-success-fg"), "深色块没有 --dsu-success-fg");
  });

  it("补偿表达式是「混入 label-primary」——同一式子随主题自动压深/提亮", () => {
    const value = /--dsu-success-fg\s*:\s*([^;]+)/.exec(THEME)?.[1] ?? "";
    assert.match(value, /color-mix\(/);
    assert.match(value, /var\(--dsw-alias-state-success-primary\)/);
    assert.match(value, /var\(--dsw-alias-label-primary\)/);
  });
});

describe("THEME 段：深色主题（层叠陷阱回归）", () => {
  it("覆盖 [data-ds-dark-theme] 选择器", () => {
    assert.ok(THEME.includes("[data-ds-dark-theme]"));
  });

  it("同时覆盖 body[data-ds-dark-theme]（宿主两种写法都用过）", () => {
    assert.ok(THEME.includes("body[data-ds-dark-theme]"));
  });

  it("两种深色选择器写在同一组规则里（值只写一份，不会漂移）", () => {
    const darkRules = blocksMentioning(THEME, "[data-ds-dark-theme]");
    const both = darkRules.filter((block) => block.prelude.includes("body[data-ds-dark-theme]"));
    assert.ok(both.length > 0, "没有一条规则同时列了两种深色选择器");
  });

  it("**每个引用 --dsw-alias-* 的派生变量都在深色块里重声明**", () => {
    const derived = aliasDerivedNames(THEME);
    const dark = darkDeclaredNames(THEME);
    const missing = [...derived].filter((name) => !dark.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      "这些派生变量只在 :root 声明，深色下会被浅色值冻结（var() 在声明处替换）：\n" +
        missing.map((n) => "  · " + n).join("\n"),
    );
  });

  it("派生集非空（否则上一条是空断言，起不到保护作用）", () => {
    const derived = aliasDerivedNames(THEME);
    // 五档 × 三件里多数引用 alias（medium/low 走 static 色阶，属正常），
    // 加上 hover / selected / line，量级应在 10 以上。这里取 10 作下限：
    // 既不会因为调参误红，也不会在提取器失效时静默通过。
    assert.ok(derived.size >= 10, `只抽到 ${derived.size} 个 alias 派生变量，提取器或声明可能失效`);
  });

  it("深色块整组重声明五档（不只重声明 fg —— 否则深色字压浅色底）", () => {
    const dark = darkDeclaredNames(THEME);
    const missing: string[] = [];
    for (const family of ["critical", "high", "medium", "low", "info"]) {
      for (const slot of ["fg", "bg", "border"]) {
        const name = `--dsu-sev-${family}-${slot}`;
        if (!dark.has(name)) missing.push(name);
      }
    }
    assert.deepEqual(missing, [], `深色块缺少：${missing.join(", ")}`);
  });

  it("深色下 medium / low 提亮一档（深底上原值对比度不足）", () => {
    const darkSegment = THEME.slice(THEME.indexOf("[data-ds-dark-theme]"));
    assert.ok(darkSegment.includes("--dsw-static-amber-400"), "medium 深色档没有提亮到 amber-400");
    assert.ok(darkSegment.includes("--dsw-static-blue-300"), "low 深色档没有提亮到 blue-300");
  });
});

// ───────────────────────────── 9. 焦点可见性 ─────────────────────────────

describe("THEME 段：焦点可见性", () => {
  it("有 :focus-visible 规则", () => {
    assert.ok(THEME.includes(":focus-visible"));
  });

  it("焦点环用 --dsw-alias-brand-primary 画", () => {
    const focusRules = blocksMentioning(THEME, ":focus-visible");
    assert.ok(focusRules.length > 0);
    const body = focusRules.map((block) => block.body).join(";");
    assert.ok(body.includes("outline:2px solid var(--dsw-alias-brand-primary)"), `焦点环实现：${body.slice(0, 200)}`);
  });

  it("**没有用 outline:none 把焦点干掉**（上游有几处，这里必须补回）", () => {
    const offenders = blocksMentioning(THEME, "outline").filter((block) => /outline\s*:\s*none/.test(block.body));
    assert.deepEqual(offenders.map((block) => block.prelude), []);
  });

  it("焦点环覆盖面板的所有外壳（dock / full / embedded / pane）", () => {
    const focus = blocksMentioning(THEME, ":focus-visible").map((block) => block.prelude).join(",");
    for (const shell of [".rt-dock", ".rt-full", ".rt-embedded", ".rt-pane"]) {
      assert.ok(focus.includes(shell), `${shell} 没有焦点环`);
    }
  });

  it("尊重系统「减少动态效果」", () => {
    // `@media` 的 prelude 不是选择器（`ruleBlocks` 故意不收），用 at-rule 扫描查
    const media = atRulePreludes(THEME).filter((prelude) => prelude.includes("prefers-reduced-motion"));
    assert.ok(media.length > 0, "没有 @media (prefers-reduced-motion) 兜底");
    // 且它内部真的关掉了动画
    const motionBlock = blocksWithBody(THEME, "animation:none");
    assert.ok(motionBlock.length > 0, "减少动态效果块里没有关动画");
  });
});

// ───────────────────────────── 10. installStyles ─────────────────────────────

describe("installStyles", () => {
  it("首次注入产生 1 个节点", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    assert.equal(appended.length, 1);
  });

  it("节点带默认标记属性（属性名 = 默认 key）", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    assert.equal(appended[0]?.attrs[STYLE_ATTR], DEFAULT_STYLE_KEY);
  });

  it("注入顺序有语义：THEME 排在 CSS 之后（后者才赢）", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    const text = appended[0]?.textContent ?? "";
    assert.equal(text, CSS + "\n\n" + THEME);
    assert.ok(text.indexOf("tabular-nums") > text.indexOf(".rt-dock{"), "THEME 没有排在 CSS 之后");
  });

  it("内容含两段（CSS 与 THEME 都进去了）", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    const text = appended[0]?.textContent ?? "";
    assert.ok(text.includes(".rt-shot-zoom-cap{"), "CSS 段缺失");
    assert.ok(text.includes("--dsu-sev-critical-fg"), "THEME 段缺失");
  });

  it("**幂等：连调两次仍只有 1 个节点**", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    installStyles(doc);
    assert.equal(appended.length, 1);
  });

  it("幂等时刷新内容（改完 THEME 立刻生效）", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    appended[0]!.textContent = "旧内容";
    installStyles(doc);
    assert.equal(appended[0]?.textContent, CSS + "\n\n" + THEME);
  });

  it("**key 生效**：自定义 key 写进标记属性的值", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc, { key: "instance-b" });
    assert.equal(appended[0]?.attrs[STYLE_ATTR], "instance-b");
  });

  it("不同 key 视为不同实例，各插一个节点", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc, { key: "a" });
    installStyles(doc, { key: "b" });
    assert.equal(appended.length, 2);
    assert.deepEqual(
      appended.map((node) => node.attrs[STYLE_ATTR]),
      ["a", "b"],
    );
  });

  it("同一自定义 key 连调两次仍只有 1 个节点", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc, { key: "same" });
    installStyles(doc, { key: "same" });
    assert.equal(appended.length, 1);
  });

  it("**清理函数移除节点**", () => {
    const { doc, appended } = makeDoc();
    const dispose = installStyles(doc);
    dispose();
    assert.equal(appended[0]?.removed, true);
  });

  it("**清理函数可重复调用不抛**（热重载下会跑不止一次）", () => {
    const { doc } = makeDoc();
    const dispose = installStyles(doc);
    dispose();
    assert.doesNotThrow(() => dispose());
    assert.doesNotThrow(() => dispose());
  });

  it("清理后再注入会新建节点（不会复用已移除的）", () => {
    const { doc, appended } = makeDoc();
    const dispose = installStyles(doc);
    dispose();
    installStyles(doc);
    assert.equal(appended.length, 2, "第二次注入应新建节点");
    assert.equal(appended[1]?.removed, false);
  });

  it("清理自己的节点不牵连同 doc 的另一个 key", () => {
    const { doc, appended } = makeDoc();
    const disposeA = installStyles(doc, { key: "a" });
    installStyles(doc, { key: "b" });
    disposeA();
    const byKey = new Map(appended.map((node) => [node.attrs[STYLE_ATTR], node]));
    assert.equal(byKey.get("a")?.removed, true, "a 应被移除");
    assert.equal(byKey.get("b")?.removed, false, "b 不该被牵连");
  });

  it("重复清理自己的节点也不会误删另一个 key", () => {
    const { doc, appended } = makeDoc();
    const disposeA = installStyles(doc, { key: "a" });
    installStyles(doc, { key: "b" });
    disposeA();
    disposeA();
    const b = appended.find((node) => node.attrs[STYLE_ATTR] === "b");
    assert.equal(b?.removed, false);
  });

  it("文档没有 querySelector 时仍幂等（退化为按实例记忆）", () => {
    const { doc, appended } = makeDoc({ withQuerySelector: false });
    installStyles(doc);
    installStyles(doc);
    assert.equal(appended.length, 1);
  });

  it("文档没有 querySelector 时清理照常工作", () => {
    const { doc, appended } = makeDoc({ withQuerySelector: false });
    const dispose = installStyles(doc);
    dispose();
    assert.equal(appended[0]?.removed, true);
  });

  it("两个不同的 document 各自独立（不会跨文档复用节点）", () => {
    const first = makeDoc();
    const second = makeDoc();
    installStyles(first.doc);
    installStyles(second.doc);
    assert.equal(first.appended.length, 1);
    assert.equal(second.appended.length, 1);
    assert.notEqual(first.appended[0], second.appended[0]);
  });

  it("清理后记忆表不再持有该 key（同 doc 重装会拿到新节点）", () => {
    const { doc, appended } = makeDoc();
    const first = installStyles(doc);
    first();
    const second = installStyles(doc);
    second();
    assert.equal(appended.length, 2);
    assert.equal(appended[1]?.removed, true);
  });
});
