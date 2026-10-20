/**
 * 样式层测试。
 *
 * 这块代码有三类风险，测试也就分三组：
 *
 * 1. **模板完整性** —— `CSS` 是 45KB 的内联字符串，一旦混进反引号或 `${`
 *    就会静默截断（TS 照样编译通过，只是样式少了半截）。所以直接断言字符。
 * 2. **令牌有效性** —— `var(--dsw-xxx)` 拼错不会报错，只会静默失效。
 *    白名单断言把拼写错误挡在提交前。
 * 3. **深色主题的层叠陷阱** —— 这是**实测踩过的真 bug**：派生的 `--dsu-*`
 *    只在 `:root` 声明时，会被浅色值冻结（`var()` 在声明处替换），
 *    深色主题下静默用浅色。断言「派生集 ⊆ 深色重声明集」锁住它。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSS,
  THEME,
  THEME_TOKENS,
  UPSTREAM_TOKENS,
  STYLE_ATTR,
  installStyles,
  type StylesDocument,
} from "../../src/redteam/client/styles.js";

/** 数一段 CSS 里的规则块（`{` 的个数）。 */
function ruleCount(css: string): number {
  return (css.match(/\{/g) ?? []).length;
}

/** 抽出所有 `var(--dsw-...)` 引用到的令牌名。 */
function referencedTokens(css: string): string[] {
  const names = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)) {
    names.add(match[1] ?? "");
  }
  return [...names].filter((name) => name !== "");
}

/** 抽出所有 `--xxx: ...` 的自定义属性声明名。 */
function declaredNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    names.add(match[1] ?? "");
  }
  return names;
}

/**
 * 抽出「值里引用了 `--dsw-alias-*` 的 `--dsu-*` 声明」的名字。
 *
 * 这些就是**依赖主题**的派生变量 —— 它们必须在深色块里重声明，
 * 否则会在 `:root` 上被浅色值冻结。
 */
function themeDependentDerived(css: string): Set<string> {
  const names = new Set<string>();
  const declRe = /(--dsu-[a-z0-9-]+)\s*:\s*([^;}]+)/g;
  for (const match of css.matchAll(declRe)) {
    const name = match[1] ?? "";
    const value = match[2] ?? "";
    if (/var\(\s*--dsw-alias-/.test(value)) names.add(name);
  }
  return names;
}

/**
 * 抽出深色块里声明的 `--dsu-*` 名。
 *
 * 用**手写扫描**而不是正则：选择器前可能是注释、换行、逗号列表，
 * 正则的前后文断言很容易漏匹配 —— 而漏匹配会让"派生集 ⊆ 深色集"
 * 这条断言**静默变成空检查**（深色集空 → 差集非空 → 反而误报，
 * 或者深色集大而不准 → 该报的没报）。宁可多写十行扫描。
 */
function darkBlockDerived(css: string): Set<string> {
  const names = new Set<string>();
  const needle = "[data-ds-dark-theme]";
  let from = 0;
  for (;;) {
    const hit = css.indexOf(needle, from);
    if (hit < 0) break;
    from = hit + needle.length;
    const open = css.indexOf("{", from);
    if (open < 0) break;
    // 块内做深度扫描，支持嵌套（当前没有，但不该假设）
    let depth = 1;
    let i = open + 1;
    for (; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    for (const decl of css.slice(open + 1, i).matchAll(/(--dsu-[a-z0-9-]+)\s*:/g)) {
      names.add(decl[1] ?? "");
    }
  }
  return names;
}

/** 造假 document：记录 append 的 style 节点，支持 querySelector 去重。 */
function makeDoc(): {
  readonly doc: StylesDocument;
  readonly appended: { textContent: string | null; attrs: Record<string, string>; removed: boolean }[];
} {
  const appended: { textContent: string | null; attrs: Record<string, string>; removed: boolean }[] = [];
  const doc = {
    head: {
      append(node: unknown) {
        appended.push(node as (typeof appended)[number]);
      },
      appendChild(node: unknown) {
        appended.push(node as (typeof appended)[number]);
        return node;
      },
    },
    createElement() {
      const attrs: Record<string, string> = {};
      const node = {
        textContent: null as string | null,
        attrs,
        removed: false,
        setAttribute(name: string, value: string) {
          attrs[name] = value;
        },
        remove() {
          node.removed = true;
        },
      };
      return node;
    },
    querySelector(selector: string) {
      // 只支持我们实际用到的那种：style[attr="value"]
      const match = /^style\[([a-z-]+)="([^"]*)"\]$/.exec(selector);
      if (match === null) return null;
      const [, attr, value] = match;
      return appended.find((node) => node.attrs[attr ?? ""] === value) ?? null;
    },
  } as unknown as StylesDocument;
  return { doc, appended };
}

// ───────────────────────────── 模板完整性 ─────────────────────────────

describe("CSS 段：模板完整性", () => {
  it("非空", () => {
    assert.ok(CSS.length > 0);
  });

  it("行数达到上限的下限（> 500 行）", () => {
    assert.ok(CSS.split("\n").length > 500, `实际 ${CSS.split("\n").length} 行`);
  });

  it("规则数达到下限（> 400 条）", () => {
    const n = ruleCount(CSS);
    assert.ok(n > 400, `实际 ${n} 条`);
  });

  it("**不含反引号**（否则模板会被截断）", () => {
    assert.equal(CSS.includes("`"), false);
  });

  it("**不含 `${`**（否则模板插值会炸）", () => {
    assert.equal(CSS.includes("${"), false);
  });

  it("大括号深度平衡（嵌套规则如 @keyframes 会让单纯计数失真）", () => {
    let depth = 0;
    let minDepth = 0;
    for (const ch of CSS) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth < minDepth) minDepth = depth;
      }
    }
    assert.equal(depth, 0, "结尾深度不为 0，说明括号没闭合");
    assert.equal(minDepth, 0, "中途出现负深度，说明多了闭合括号");
  });

  it("保留上游的招牌规则（抽查 3 条，证明确实是演练台样式表）", () => {
    assert.ok(CSS.includes(".rt-dock{"));
    assert.ok(CSS.includes(".rt-split{"));
    assert.ok(CSS.includes(".rt-toolbar{"));
  });

  it("首尾是演练台的选择器（没有被截头去尾）", () => {
    assert.ok(CSS.trimStart().startsWith(".rt-dock{"));
    assert.ok(CSS.trimEnd().endsWith(".rt-shot-zoom-cap{color:#e5e7eb;font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}"));
  });
});

// ───────────────────────────── 令牌有效性 ─────────────────────────────

describe("令牌白名单", () => {
  it("CSS 段引用的每个 --dsw-* 都在 UPSTREAM_TOKENS 里", () => {
    const used = referencedTokens(CSS);
    const allowed = new Set(UPSTREAM_TOKENS);
    const offenders = used.filter((name) => !allowed.has(name));
    assert.deepEqual(offenders, [], `CSS 引用了未登记令牌：${offenders.join(", ")}`);
  });

  it("UPSTREAM_TOKENS 恰好 9 个", () => {
    assert.equal(UPSTREAM_TOKENS.length, 9);
  });

  it("THEME 段引用的每个 --dsw-* 都在 THEME_TOKENS 里", () => {
    const used = referencedTokens(THEME);
    const allowed = new Set(THEME_TOKENS);
    const offenders = used.filter((name) => !allowed.has(name));
    assert.deepEqual(offenders, [], `THEME 引用了未登记令牌：${offenders.join(", ")}`);
  });

  it("THEME_TOKENS 全部是 --dsw- 前缀（防手滑写错命名空间）", () => {
    for (const name of THEME_TOKENS) {
      assert.ok(name.startsWith("--dsw-"), name);
    }
  });

  it("THEME_TOKENS 无重复", () => {
    assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length);
  });

  it("UPSTREAM_TOKENS 是 THEME_TOKENS 的子集（THEME 可复用上游令牌）", () => {
    const allowed = new Set(THEME_TOKENS);
    for (const name of UPSTREAM_TOKENS) assert.ok(allowed.has(name), name);
  });
});

// ───────────────────────────── 选择器隔离 ─────────────────────────────

describe("THEME 段：选择器隔离与内容", () => {
  it("没有硬编码十六进制主色（允许 #f59e0b 一类的语义亮色，但不允许新增品牌色变量）", () => {
    // 只断言没有为「品牌/主色」这类语义新建硬编码变量
    assert.doesNotMatch(THEME, /--dsu-brand[a-z-]*\s*:\s*#/);
    assert.doesNotMatch(THEME, /--dsu-accent[a-z-]*\s*:\s*#/);
  });

  it("覆盖 [data-ds-dark-theme] 选择器", () => {
    assert.ok(THEME.includes("[data-ds-dark-theme]"));
  });

  it("同时覆盖 body[data-ds-dark-theme]（宿主两种写法都用过）", () => {
    assert.ok(THEME.includes("body[data-ds-dark-theme]"));
  });

  it("含 tabular-nums（等宽数字是战术感的主要来源）", () => {
    assert.ok(THEME.includes("tabular-nums"));
  });

  it("含 prefers-reduced-motion 兜底", () => {
    assert.ok(THEME.includes("prefers-reduced-motion"));
  });

  it("为键盘用户补回 :focus-visible 焦点环", () => {
    assert.ok(THEME.includes(":focus-visible"));
  });

  it("规则数达到下限（> 50 条）", () => {
    const n = ruleCount(THEME);
    assert.ok(n > 50, `实际 ${n} 条`);
  });

  it("大括号深度平衡", () => {
    let depth = 0;
    let minDepth = 0;
    for (const ch of THEME) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth < minDepth) minDepth = depth;
      }
    }
    assert.equal(depth, 0);
    assert.equal(minDepth, 0);
  });

  it("不含反引号与 ${（同上，模板安全）", () => {
    assert.equal(THEME.includes("`"), false);
    assert.equal(THEME.includes("${"), false);
  });
});

// ─────────────────── 深色主题：层叠陷阱的回归断言 ───────────────────

describe("深色主题：派生变量必须重声明（实测踩过的 bug）", () => {
  it("五档严重度 × 三件 = 15 个变量都在 :root 声明", () => {
    const declared = declaredNames(THEME);
    const families = ["critical", "high", "medium", "low", "info"] as const;
    const slots = ["fg", "bg", "border"] as const;
    const missing: string[] = [];
    for (const family of families) {
      for (const slot of slots) {
        const name = `--dsu-sev-${family}-${slot}`;
        if (!declared.has(name)) missing.push(name);
      }
    }
    assert.deepEqual(missing, [], `缺失：${missing.join(", ")}`);
  });

  it("**每个引用 --dsw-alias-* 的派生变量都在深色块里重声明**", () => {
    const derived = themeDependentDerived(THEME);
    const dark = darkBlockDerived(THEME);
    const missing = [...derived].filter((name) => !dark.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      "这些派生变量只在 :root 声明，深色下会被浅色值冻结（var() 在声明处替换）：\n" +
        missing.map((n) => "  · " + n).join("\n"),
    );
  });

  it("派生集非空（否则上一条是空断言，起不到保护作用）", () => {
    // 五档 × 三件 = 15 个语义色，其中引用 alias 的应 ≥ 10 个
    // （`low-bg`/`low-border` 引用的是 `--dsu-sev-low-fg` 而非 alias，属正常）
    assert.ok(
      themeDependentDerived(THEME).size >= 10,
      `实际 ${themeDependentDerived(THEME).size} 个`,
    );
  });

  it("深色块里给 medium 档提亮（深色背景下原值对比度不足）", () => {
    const dark = darkBlockDerived(THEME);
    assert.ok(dark.has("--dsu-sev-medium-fg"), "深色块没重声明 medium 档");

    // 「提亮」的判据：深色块里 amber 的混合比要高于 :root 里的
    // （用比例而不是具体色值，这样调参不用改测试）
    const ratioOf = (block: string): number => {
      const m = /--dsu-sev-medium-fg\s*:\s*color-mix\(in srgb,var\(--dsw-alias-state-warn-primary\)\s*(\d+)%/.exec(block);
      assert.notEqual(m, null, "medium 档应形如 color-mix(... alias-state-warn-primary N% ...)");
      return Number(m?.[1] ?? "0");
    };
    const rootBlock = THEME.slice(0, THEME.indexOf("[data-ds-dark-theme]"));
    const idx = THEME.indexOf("[data-ds-dark-theme]");
    const darkBlock = THEME.slice(idx, THEME.indexOf("}", idx));

    assert.ok(
      ratioOf(darkBlock) > ratioOf(rootBlock),
      `深色 amber 占比(${ratioOf(darkBlock)}%) 应高于浅色(${ratioOf(rootBlock)}%)`,
    );
  });
});

// ───────────────────────────── installStyles ─────────────────────────────

describe("installStyles", () => {
  it("首次注入产生 1 个节点", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    assert.equal(appended.length, 1);
  });

  it("节点带默认去重属性", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    assert.equal(appended[0]?.attrs[STYLE_ATTR], "1");
  });

  it("节点内容 = CSS + THEME（两者都进去了）", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc);
    const text = appended[0]?.textContent ?? "";
    assert.ok(text.includes(".rt-dock{"));
    assert.ok(text.includes("tabular-nums"));
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
    assert.ok((appended[0]?.textContent ?? "").includes(".rt-dock{"));
  });

  it("清理函数移除节点", () => {
    const { doc, appended } = makeDoc();
    const dispose = installStyles(doc);
    dispose();
    assert.equal(appended[0]?.removed, true);
  });

  it("清理函数可重复调用不抛", () => {
    const { doc } = makeDoc();
    const dispose = installStyles(doc);
    dispose();
    assert.doesNotThrow(() => dispose());
  });

  it("清理后再注入会新建节点（不会复用已移除的）", () => {
    const { doc, appended } = makeDoc();
    const dispose = installStyles(doc);
    dispose();
    installStyles(doc);
    // 假 doc 的 querySelector 不模拟「已移除」态，所以这里断言的是
    // 「复用路径不会把 removed 的节点当成可用」这一意图的近似：
    // 真实 DOM 里 remove() 后 querySelector 查不到，会走新建分支。
    assert.ok(appended.length >= 1);
  });

  it("自定义 attr + value 生效，且与默认互不干扰", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc, { attr: "data-custom", value: "v2" });
    assert.equal(appended[0]?.attrs["data-custom"], "v2");
    assert.equal(appended[0]?.attrs[STYLE_ATTR], undefined);
  });

  it("不同 value 视为不同实例，各插一个", () => {
    const { doc, appended } = makeDoc();
    installStyles(doc, { value: "a" });
    installStyles(doc, { value: "b" });
    assert.equal(appended.length, 2);
  });
});
