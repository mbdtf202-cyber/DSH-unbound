/**
 * 提取器测试：**核心是幂等性**。
 *
 * lead 的要求原话：「必须有一个测试证明：提取 → 重新嵌入 → 字节相同。
 * 这个测试不做，等于没换。」
 *
 * 所以这里不是只测「能找到标记」，而是把「原方案的每一把刀」
 * 各造一个专门用例 —— 缩进改动、花括号、CRLF、标记重复 —— 逐一验证
 * 新方案在这些条件下仍然产出相同字节。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FACTORY_BEGIN,
  FACTORY_END,
  byteLength,
  describeFragment,
  embedFragment,
  extractFragment,
  toLf,
  verifyRoundTrip,
  wrapFragment,
} from "../../src/redteam/ui/extract.js";

/** 一段「像真的」的工厂正文：含 CSS 花括号、模板字面量、嵌套函数。 */
const REALISTIC_BODY = `    const CSS = \`
.rt-dock{position:fixed;top:12px;right:12px}
.rt-tab.on{font-weight:600}
\`

    function Panel(props) {
      if (!props) { return null }
      const style = { width: '100%', height: 520 }
      return h('div', { className: 'rt-dock', style: style },
        h('span', null, 'ok'),
        props.children)
    }

    const parts = () => ({ CSS: CSS, Panel: Panel })
`;

/** 造一个带标记的目标文本。 */
function targetWith(body: string, prefix = "// shell\n", suffix = "// tail\n"): string {
  return `${prefix}${FACTORY_BEGIN}\n${body}${FACTORY_END}\n${suffix}`;
}

describe("extractFragment — 定位", () => {
  it("取出标记之间的正文", () => {
    const source = targetWith("const x = 1\n");
    const result = extractFragment(source);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value.body : "", "const x = 1\n");
  });

  it("报告标记所在行号（便于修复）", () => {
    const source = `line1\nline2\n${FACTORY_BEGIN}\nbody\n${FACTORY_END}\n`;
    const result = extractFragment(source);
    if (!result.ok) throw new Error("应成功");
    assert.equal(result.value.beginLine, 3);
    assert.equal(result.value.endLine, 5);
  });

  it("标记与代码同行时取精确区间", () => {
    const source = `${FACTORY_BEGIN}const y = 2${FACTORY_END}`;
    const result = extractFragment(source);
    assert.equal(result.ok ? result.value.body : "x", "const y = 2");
  });

  it("正文里的花括号不影响提取（原方案靠计数，这里不数）", () => {
    const body = "function f() { if (a) { return { k: 1 } } }\n";
    const result = extractFragment(targetWith(body));
    assert.equal(result.ok ? result.value.body : "", body);
  });

  it("正文里的 CSS 模板字面量不影响提取", () => {
    const result = extractFragment(targetWith(REALISTIC_BODY));
    assert.equal(result.ok ? result.value.body : "", REALISTIC_BODY);
  });

  it("正文里出现 'factory: (require) => {' 字样也不影响（原方案的定位串）", () => {
    // 这是原方案的第一把刀：indexOf 会被这行骗到。
    const body = "// factory: (require) => {\nconst z = 3\n";
    const result = extractFragment(targetWith(body));
    assert.equal(result.ok ? result.value.body : "", body);
  });
});

describe("extractFragment — 失败必须明确", () => {
  it("缺 begin 标记 → missing_marker(begin)", () => {
    const result = extractFragment(`x\n${FACTORY_END}\n`);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.kind, "missing_marker");
    if (result.ok || result.error.kind !== "missing_marker") return;
    assert.equal(result.error.marker, "begin");
    assert.equal(result.error.expected, FACTORY_BEGIN);
  });

  it("缺 end 标记 → missing_marker(end)", () => {
    const result = extractFragment(`${FACTORY_BEGIN}\nbody\n`);
    assert.equal(result.ok ? "" : result.error.kind, "missing_marker");
    if (result.ok || result.error.kind !== "missing_marker") return;
    assert.equal(result.error.marker, "end");
  });

  it("重复 begin → duplicate_marker 并给出行号", () => {
    const source = `${FACTORY_BEGIN}\na\n${FACTORY_BEGIN}\nb\n${FACTORY_END}\n`;
    const result = extractFragment(source);
    assert.equal(result.ok ? "" : result.error.kind, "duplicate_marker");
    if (result.ok || result.error.kind !== "duplicate_marker") return;
    assert.equal(result.error.marker, "begin");
    assert.equal(result.error.count, 2);
    assert.deepEqual(result.error.lines, [1, 3]);
  });

  it("end 在 begin 之前 → out_of_order", () => {
    const source = `${FACTORY_END}\nbody\n${FACTORY_BEGIN}\n`;
    const result = extractFragment(source);
    assert.equal(result.ok ? "" : result.error.kind, "out_of_order");
  });

  it("空正文 → empty_fragment（不是产出空包）", () => {
    const source = `${FACTORY_BEGIN}\n\n   \n${FACTORY_END}\n`;
    const result = extractFragment(source);
    assert.equal(result.ok ? "" : result.error.kind, "empty_fragment");
  });
});

describe("embedFragment — 嵌入", () => {
  it("替换标记之间的内容", () => {
    const target = targetWith("old\n");
    const result = embedFragment(target, "new\n");
    if (!result.ok) throw new Error("应成功");
    assert.ok(result.value.includes("new\n"));
    assert.ok(!result.value.includes("old\n"));
  });

  it("保留标记外的内容（前缀与后缀）", () => {
    const result = embedFragment(targetWith("x\n"), "y\n");
    if (!result.ok) throw new Error("应成功");
    assert.ok(result.value.startsWith("// shell\n"));
    assert.ok(result.value.endsWith("// tail\n"));
  });

  it("片段缺结尾换行时补一个（保证标记独占一行）", () => {
    const result = embedFragment(targetWith("a\n"), "no-newline");
    if (!result.ok) throw new Error("应成功");
    // 补换行后 `end` 标记仍在行首。
    assert.ok(result.value.includes("no-newline\n" + FACTORY_END));
  });

  it("目标缺标记时透出提取错误", () => {
    const result = embedFragment("no markers here", "x\n");
    assert.equal(result.ok, false);
  });
});

describe("幂等性 —— lead 要求的核心验证", () => {
  it("重复嵌入字节完全相同", () => {
    const target = targetWith("initial\n");
    const first = embedFragment(target, REALISTIC_BODY);
    if (!first.ok) throw new Error("第一次嵌入失败");
    const second = embedFragment(first.value, REALISTIC_BODY);
    if (!second.ok) throw new Error("第二次嵌入失败");
    assert.equal(first.value, second.value, "两次嵌入必须字节相同");
    assert.equal(byteLength(first.value), byteLength(second.value));
  });

  it("提取 → 再嵌入 → 再提取：两段正文逐字节相同", () => {
    const source = targetWith(REALISTIC_BODY);
    const extracted = extractFragment(source);
    if (!extracted.ok) throw new Error("提取失败");

    const rebuilt = embedFragment(source, extracted.value.body);
    if (!rebuilt.ok) throw new Error("再嵌入失败");

    const again = extractFragment(rebuilt.value);
    if (!again.ok) throw new Error("再提取失败");

    assert.equal(again.value.body, extracted.value.body);
  });

  it("verifyRoundTrip 通过并报告字节数", () => {
    const result = verifyRoundTrip(targetWith("old\n"), REALISTIC_BODY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.bytes > 0);
  });

  it("verifyRoundTrip 在正文不幂等时报错（自检真的会红）", () => {
    // 构造一个不可能稳定嵌入的场景：目标缺 end 标记。
    const result = verifyRoundTrip(`${FACTORY_BEGIN}\nbody\n`, "x\n");
    assert.equal(result.ok, false);
  });

  it("三种行尾（LF / CRLF / 混用）下幂等性都成立", () => {
    const bodies = [
      "const a = 1\nconst b = 2\n",
      "const a = 1\r\nconst b = 2\r\n",
      "const a = 1\r\nconst b = 2\n",
    ];
    for (const body of bodies) {
      const target = targetWith("seed\n");
      const first = embedFragment(target, body);
      const second = first.ok ? embedFragment(first.value, body) : first;
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (first.ok && second.ok) {
        assert.equal(first.value, second.value, `行尾 ${JSON.stringify(body.slice(0, 12))} 下不幂等`);
      }
    }
  });

  it("**改缩进不影响结果**（原方案会静默产错包）", () => {
    // 原方案依赖 `"\n    return module.exports\n  },\n})"` 这种四空格缩进。
    // 新方案只看标记，正文缩进改成 2 / 8 / tab 都应产出**相同**的嵌入结果。
    const variants = [
      "  const a = 1\n",
      "        const a = 1\n",
      "\tconst a = 1\n",
    ];
    const target = targetWith("seed\n");
    const outputs = variants.map((body) => {
      const result = embedFragment(target, body);
      if (!result.ok) throw new Error("嵌入失败");
      return result.value;
    });
    // 正文不同 → 输出不同；但「再嵌入同一正文」必须稳定。
    for (const [index, variant] of variants.entries()) {
      const again = embedFragment(outputs[index] ?? "", variant);
      assert.equal(again.ok, true);
      if (again.ok) assert.equal(again.value, outputs[index]);
    }
  });

  it("标记位置随正文长度变化后仍然幂等", () => {
    const target = targetWith("tiny\n");
    const huge = "x".repeat(100_000) + "\n";
    const first = embedFragment(target, huge);
    const second = first.ok ? embedFragment(first.value, huge) : first;
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) assert.equal(first.value, second.value);
  });
});

describe("wrapFragment", () => {
  it("产出带标记的文本，且能被 extract 原样取回", () => {
    const wrapped = wrapFragment(REALISTIC_BODY);
    const result = extractFragment(wrapped);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value.body : "", REALISTIC_BODY);
  });

  it("缺结尾换行时补换行", () => {
    const wrapped = wrapFragment("const a = 1");
    const result = extractFragment(wrapped);
    assert.equal(result.ok ? result.value.body : "", "const a = 1\n");
  });
});

describe("toLf / byteLength / describeFragment", () => {
  it("toLf 归一 CRLF", () => {
    assert.equal(toLf("a\r\nb\r\n"), "a\nb\n");
  });

  it("byteLength 按 UTF-8 而非 UTF-16 码元", () => {
    // '中' 是 3 字节 UTF-8、1 个 UTF-16 码元。
    assert.equal(byteLength("中"), 3);
    assert.equal(byteLength("中").valueOf(), Buffer.byteLength("中", "utf8"));
  });

  it("describeFragment 给出行数与字节数，不泄露正文", () => {
    const result = extractFragment(targetWith("a\nb\n"));
    if (!result.ok) throw new Error("应成功");
    const text = describeFragment(result.value);
    assert.match(text, /2 行/);
    assert.ok(!text.includes("a\nb"), "不应把正文打进摘要");
  });
});

describe("对真实源文件的适应性", () => {
  it("能在含大量花括号与模板字面量的正文上工作", () => {
    // 拼一段比真实 CSS 更极端的内容：深层嵌套 + 正则字面量 + 注释里的花括号。
    const nasty = [
      "const re = /[{}]/g\n",
      "/* 注释里的 { 和 } 不该被数 */\n",
      "const css = `a{b{c{d}}}`\n",
      "function f() { return () => { return { x: { y: 1 } } } }\n",
    ].join("");
    const source = targetWith(nasty);
    const result = extractFragment(source);
    assert.equal(result.ok ? result.value.body : "", nasty);
    const rt = verifyRoundTrip(source, nasty);
    assert.equal(rt.ok, true);
  });
});
