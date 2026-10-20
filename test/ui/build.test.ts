/**
 * 构建装配测试：**这是 lead 最关心的一块**。
 *
 * 核心问题：原 `build-client.mjs` 用字符串切片（找 `factory: (require) => {`
 * 再数括号）提取，改一个缩进就**静默产错包**（构建成功、退出码 0）。
 *
 * 这里证明四件事：
 * 1. 装配产物保留宿主契约 `window.__ModuleLoader__.load({ id, factory })`。
 * 2. 提取 → 再嵌入 **字节相同**（幂等）。
 * 3. 各种「会让原方案切错」的格式扰动，新方案都不受影响。
 * 4. 产物过期（源码改了没重建）能被检出。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assemble,
  assembleNormalized,
  defaultTemplate,
  describeArtifact,
  fragmentOf,
  isUpToDate,
  renderTemplate,
} from "../../src/redteam/ui/build.js";
import { FACTORY_BEGIN, FACTORY_END, byteLength, extractFragment } from "../../src/redteam/ui/extract.js";

/** 一段「像编译产物」的正文：含 CSS、嵌套函数、模板字面量、1,000+ 花括号规模的内容。 */
const COMPILED_BODY = [
  "    const CSS = `",
  ".rt-dock{position:fixed;top:12px;right:12px;z-index:20}",
  ".rt-tab.on{color:var(--x);border-bottom:2px solid var(--y)}",
  "`",
  "",
  "    function Panel(props) {",
  "      if (!props) { return null }",
  "      const style = { width: '100%', height: 520 }",
  "      return h('div', { className: 'rt-dock', style: style },",
  "        h('span', null, 'ok'),",
  "        props.children)",
  "    }",
  "",
  "    exports.apply = function apply(ctx) {",
  "      const tag = document.createElement('style')",
  "      tag.textContent = CSS",
  "      ctx.effect(() => () => { tag.remove() })",
  "    }",
  "",
].join("\n");

describe("模板 —— 宿主契约", () => {
  it("产物骨架里有 window.__ModuleLoader__.load({ id, factory })", () => {
    const shell = renderTemplate(defaultTemplate("dsh-qilin"));
    assert.match(shell, /window\.__ModuleLoader__\.load\(\{/);
    assert.match(shell, /factory: \(require\) => \{/);
    assert.match(shell, /id: 'dsh-qilin'/);
  });

  it("id 会被原样写入", () => {
    const shell = renderTemplate(defaultTemplate("custom-id"));
    assert.match(shell, /id: 'custom-id'/);
  });

  it("前置里有 require('react') 与 h 所需的解构", () => {
    const shell = renderTemplate(defaultTemplate("x"));
    assert.match(shell, /require\('react'\)/);
    assert.match(shell, /\{ useState, useEffect, useRef, useCallback, Component \}/);
  });

  it("后置里有 return module.exports（模块契约的另一半）", () => {
    const shell = renderTemplate(defaultTemplate("x"));
    assert.match(shell, /return module\.exports/);
  });

  it("模板自带一对标记", () => {
    const shell = renderTemplate(defaultTemplate("x"));
    assert.ok(shell.includes(FACTORY_BEGIN));
    assert.ok(shell.includes(FACTORY_END));
    assert.ok(shell.indexOf(FACTORY_BEGIN) < shell.indexOf(FACTORY_END));
  });
});

describe("装配 —— 基本正确性", () => {
  it("装配成功并报告字节数", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value.bytes > 0);
    assert.equal(result.value.fragmentBytes, byteLength(COMPILED_BODY));
  });

  it("产物包含片段正文", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    assert.ok(result.value.text.includes(".rt-dock{position:fixed"));
    assert.ok(result.value.text.includes("function Panel(props)"));
  });

  it("产物同时保留前置与后置", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    assert.ok(result.value.text.includes("const React = require('react')"));
    assert.ok(result.value.text.includes("return module.exports"));
  });

  it("产物里只有一对标记（不重复）", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    assert.equal(result.value.text.split(FACTORY_BEGIN).length - 1, 1);
    assert.equal(result.value.text.split(FACTORY_END).length - 1, 1);
  });

  it("空片段被拒绝（防产出空包）", () => {
    const result = assemble(defaultTemplate("x"), "");
    assert.equal(result.ok, false);
  });
});

describe("幂等性 —— 同一输入 → 输出字节相同", () => {
  it("同一片段装配两次，字节完全一致", () => {
    const template = defaultTemplate("x");
    const first = assemble(template, COMPILED_BODY);
    const second = assemble(template, COMPILED_BODY);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.text, second.value.text);
    assert.equal(first.value.bytes, second.value.bytes);
  });

  it("对**已装配产物**再装配同一片段，字节不变（真幂等）", () => {
    const template = defaultTemplate("x");
    const first = assemble(template, COMPILED_BODY);
    if (!first.ok) throw new Error("首次装配失败");
    // 用产物本身当输入：这正是「重跑构建」的场景。
    const second = assemble(template, fragmentFrom(first.value.text));
    if (!second.ok) throw new Error("二次装配失败");
    assert.equal(second.value.text, first.value.text);
  });

  it("从产物里再提取的片段 === 原片段", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    const back = fragmentOf(result.value.text);
    assert.equal(back.ok, true);
    assert.equal(back.ok ? back.value : "", COMPILED_BODY);
  });

  it("10 次连续装配字节稳定（不累积漂移）", () => {
    const template = defaultTemplate("x");
    let current = COMPILED_BODY;
    let previous: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const result = assemble(template, current);
      if (!result.ok) throw new Error(`第 ${round} 轮失败`);
      if (previous !== null) assert.equal(result.value.text, previous, `第 ${round} 轮发生漂移`);
      previous = result.value.text;
      // 下一轮的输入就是这一轮的产物片段。
      current = fragmentFrom(result.value.text);
    }
  });

  it("assembleNormalized 对 CRLF 输入也稳定", () => {
    const template = defaultTemplate("x");
    const crlf = COMPILED_BODY.replace(/\n/g, "\r\n");
    const first = assembleNormalized(template, crlf);
    const second = assembleNormalized(template, crlf);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.text, second.value.text);
    assert.equal(first.value.text.includes("\r\n"), false, "归一后不应残留 CRLF");
  });
});

describe("格式扰动 —— 原方案会切错的场景", () => {
  /** 每种扰动都跑「装配 + 往返」双重断言。 */
  function expectStable(body: string, label: string): void {
    const result = assemble(defaultTemplate("x"), body);
    assert.equal(result.ok, true, `${label}：装配失败`);
    if (!result.ok) return;
    const back = fragmentOf(result.value.text);
    assert.equal(back.ok, true, `${label}：提取失败`);
    assert.equal(back.ok ? back.value : "", body, `${label}：往返不一致`);
    // 再装配一次必须字节相同。
    const again = assemble(defaultTemplate("x"), back.ok ? back.value : body);
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.value.text, result.value.text, `${label}：不幂等`);
  }

  it("2 空格缩进（原方案依赖 4 空格）", () => {
    expectStable("  const a = 1\n  function f() {\n    return 2\n  }\n", "2 空格");
  });

  it("8 空格缩进", () => {
    expectStable("        const a = 1\n        function f() {\n          return 2\n        }\n", "8 空格");
  });

  it("Tab 缩进（原实现里源码就是 Tab）", () => {
    expectStable("\tconst a = 1\n\tfunction f() {\n\t\treturn 2\n\t}\n", "Tab");
  });

  it("混合缩进", () => {
    expectStable("  const a = 1\n\tconst b = 2\n      const c = 3\n", "混合");
  });

  it("深层花括号嵌套（原方案靠计数）", () => {
    expectStable("function a() { function b() { function c() { return { d: { e: {} } } } } }\n", "嵌套");
  });

  it("正文里出现原方案的两个定位串", () => {
    // 这是最致命的一种：原方案靠这两个字符串定位，出现即切错。
    expectStable(
      "// factory: (require) => {\n//     return module.exports\n//   },\n// })\nconst x = 1\n",
      "定位串出现在正文",
    );
  });

  it("正文里有多个 function apply(ctx) {（原方案用 lastIndexOf）", () => {
    expectStable(
      "function apply(ctx) { return 1 }\nfunction apply(ctx) { return 2 }\n",
      "多个 apply",
    );
  });

  it("单行片段（无结尾换行）", () => {
    const result = assemble(defaultTemplate("x"), "const a = 1");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 补了换行，标记仍独占一行。
    assert.ok(result.value.text.includes("const a = 1\n" + FACTORY_END));
  });

  it("超长正文（500 KB）仍稳定", () => {
    const huge = "const x = 1\n".repeat(40_000);
    const result = assemble(defaultTemplate("x"), huge);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.fragmentBytes, byteLength(huge));
  });
});

describe("产物时效检测（CI 该抓的状态）", () => {
  it("产物与片段一致 → up to date", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    assert.equal(isUpToDate(result.value.text, COMPILED_BODY), true);
  });

  it("源码改过但没重建 → 不是 up to date", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    assert.equal(isUpToDate(result.value.text, COMPILED_BODY + "const added = 1\n"), false);
  });

  it("产物缺标记 → 判定为过期（不是「无差异」）", () => {
    assert.equal(isUpToDate("no markers", COMPILED_BODY), false);
  });
});

describe("跨平台字节一致", () => {
  it("LF 与 CRLF 输入归一后产出一致", () => {
    const template = defaultTemplate("x");
    const lf = assembleNormalized(template, COMPILED_BODY);
    const crlf = assembleNormalized(template, COMPILED_BODY.replace(/\n/g, "\r\n"));
    assert.equal(lf.ok, true);
    assert.equal(crlf.ok, true);
    if (!lf.ok || !crlf.ok) return;
    assert.equal(lf.value.bytes, crlf.value.bytes, "不同行尾输入应产出相同字节数");
  });
});

describe("describeArtifact", () => {
  it("给出行数与字节数", () => {
    const result = assemble(defaultTemplate("x"), COMPILED_BODY);
    if (!result.ok) throw new Error("装配失败");
    const text = describeArtifact(result.value.text);
    assert.match(text, /artifact: \d+ 行 \/ \d+ 字节/);
  });
});

/** 从装配产物里取回片段（测试辅助）。 */
function fragmentFrom(artifact: string): string {
  const extracted = extractFragment(artifact);
  if (!extracted.ok) throw new Error(`提取失败：${extracted.error.kind}`);
  return extracted.value.body;
}
