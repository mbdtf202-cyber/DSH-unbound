/**
 * 文本变换的穷举测试。
 *
 * 这里每一条用例都对应一个「真实踩过的坑」（原 dsh-qilin 的注释或 commit 有记录）。
 * 这些行为如果不钉死，重写时一定会丢；丢了不会报错，只会表现为补丁静默失效。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatchToText,
  cloneRegExp,
  isBareIdentityNeedle,
  isPatchApplied,
  isYamlPath,
  matchesPattern,
  patchHasRemainingWork,
  toLf,
  yamlJsCommentsToHash,
} from "../src/engine/text.js";
import type { PatchDefinition, PatchPattern, Replacement } from "../src/patches/types.js";

/** 造一个最小补丁定义，只关心 replacements。 */
function mkPatch(replacements: readonly Replacement[], extra: Partial<PatchDefinition> = {}): PatchDefinition {
  return {
    id: 1,
    name: "TEST",
    layer: "",
    layerEn: "",
    desc: "",
    fileKeys: ["x"],
    rel: [],
    replacements,
    markers: undefined,
    markersAny: false,
    marker: undefined,
    forbid: undefined,
    skipIfMarked: false,
    optional: false,
    surfaces: undefined,
    strictFiles: false,
    softSettle: false,
    ...extra,
  };
}

const lit = (text: string): PatchPattern => ({ kind: "literal", text });
const re = (source: string, flags = "g"): PatchPattern => ({ kind: "regex", source, flags });

describe("toLf", () => {
  it("把 CRLF 归一成 LF", () => {
    assert.equal(toLf("a\r\nb\r\nc"), "a\nb\nc");
  });
  it("不动裸 CR（不在 CRLF 里的）", () => {
    assert.equal(toLf("a\rb"), "a\rb");
  });
  it("幂等", () => {
    const s = "a\r\nb";
    assert.equal(toLf(toLf(s)), toLf(s));
  });
});

describe("isYamlPath", () => {
  it("识别 .yml / .yaml / .YML", () => {
    assert.equal(isYamlPath("a.yml"), true);
    assert.equal(isYamlPath("a.yaml"), true);
    assert.equal(isYamlPath("a.YML"), true);
  });
  it("拒绝 js/json", () => {
    assert.equal(isYamlPath("a.js"), false);
    assert.equal(isYamlPath("a.json"), false);
  });
});

describe("cloneRegExp", () => {
  it("去重 g 再加 g，不残留 lastIndex", () => {
    const original = /a/g;
    original.lastIndex = 5;
    const clone = cloneRegExp(original, true);
    assert.equal(clone.lastIndex, 0);
    assert.equal(clone.global, true);
  });
  it("保留非 g 标志", () => {
    const clone = cloneRegExp(/a/gi, false);
    assert.equal(clone.ignoreCase, true);
    assert.equal(clone.global, false);
  });
  it("源正则的 lastIndex 不被污染", () => {
    const original = /x/g;
    const clone = cloneRegExp(original, true);
    clone.lastIndex = 99;
    assert.equal(original.lastIndex, 0);
  });
});

describe("matchesPattern", () => {
  it("字面量 substring 匹配", () => {
    assert.equal(matchesPattern("hello world", lit("world")), true);
    assert.equal(matchesPattern("hello world", lit("WORLD")), false);
  });
  it("正则匹配", () => {
    assert.equal(matchesPattern("abc123", re("\\d+")), true);
  });
  it("多次调用结果稳定（lastIndex 不泄漏）", () => {
    const p = re("a");
    for (let i = 0; i < 5; i += 1) {
      assert.equal(matchesPattern("aaa", p), true, `iteration ${i}`);
    }
  });
});

describe("yamlJsCommentsToHash", () => {
  it("行尾 // 注释变 #", () => {
    assert.equal(yamlJsCommentsToHash("key: value // note"), "key: value # note");
  });
  it("不含 // 的行不动", () => {
    assert.equal(yamlJsCommentsToHash("key: value"), "key: value");
  });
  it("!!js 行整行跳过（那里 // 可能是真除法）", () => {
    const line = "root: !!js path.join(a, b) // c";
    assert.equal(yamlJsCommentsToHash(line), line);
  });
  it("双引号内的 // 不动", () => {
    assert.equal(yamlJsCommentsToHash('a: "http://x"'), 'a: "http://x"');
  });
  it("单引号内的 // 不动", () => {
    assert.equal(yamlJsCommentsToHash("a: 'http://x'"), "a: 'http://x'");
  });
  it("已经注释掉的行（#）不动", () => {
    assert.equal(yamlJsCommentsToHash("a: b # already // x"), "a: b # already // x");
  });
  it("单引号内 '' 是转义单引号，不当结束", () => {
    // 'it''s // x' —— 整段都在引号里，// 不该被改
    const line = "a: 'it''s // x'";
    assert.equal(yamlJsCommentsToHash(line), line);
  });
  it("// 紧跟非空白字符时不算注释", () => {
    // 例如 URL 里的 :// 前面是冒号，不是空白
    assert.equal(yamlJsCommentsToHash("a: x://y"), "a: x://y");
  });
  it("CRLF 输入被归一为 LF", () => {
    assert.equal(yamlJsCommentsToHash("a\r\nb"), "a\nb");
  });
});

describe("isBareIdentityNeedle", () => {
  it("识别无缩进的 identity 语句", () => {
    assert.equal(isBareIdentityNeedle(lit("You are a coding agent powered by X")), true);
  });
  it("有缩进的同句不算", () => {
    assert.equal(isBareIdentityNeedle(lit("  You are a coding agent powered by X")), false);
  });
  it("不匹配其它句子", () => {
    assert.equal(isBareIdentityNeedle(lit("You are helpful")), false);
  });
  it("正则永远不算", () => {
    assert.equal(isBareIdentityNeedle(re("You are a coding agent powered by")), false);
  });
});

describe("applyPatchToText — 字面量", () => {
  it("单次替换", () => {
    const r = applyPatchToText("a FOO b", mkPatch([{ pattern: lit("FOO"), replace: "BAR" }]), "x.js");
    assert.equal(r.text, "a BAR b");
    assert.equal(r.changed, true);
    assert.equal(r.appliedCount, 1);
    assert.equal(r.notFoundCount, 0);
  });

  it("多次出现全部替换（split/join 语义，不是只换第一个）", () => {
    const r = applyPatchToText("FOO FOO FOO", mkPatch([{ pattern: lit("FOO"), replace: "X" }]), "x.js");
    assert.equal(r.text, "X X X");
  });

  it("未命中：原文不动，计 notFound", () => {
    const r = applyPatchToText("nothing here", mkPatch([{ pattern: lit("FOO"), replace: "X" }]), "x.js");
    assert.equal(r.text, "nothing here");
    assert.equal(r.changed, false);
    assert.equal(r.notFoundCount, 1);
  });

  it("$1 在字面量替换里按字面写（不展开）", () => {
    const r = applyPatchToText("a FOO", mkPatch([{ pattern: lit("FOO"), replace: "$1" }]), "x.js");
    assert.equal(r.text, "a $1");
  });
});

describe("applyPatchToText — 正则", () => {
  it("$1 展开生效（关键语义，用字符串形态 replace）", () => {
    const r = applyPatchToText(
      "value=42",
      mkPatch([{ pattern: re("value=(\\d+)"), replace: "value=[$1]" }]),
      "x.js",
    );
    assert.equal(r.text, "value=[42]");
  });

  it("无匹配时不改", () => {
    const r = applyPatchToText("abc", mkPatch([{ pattern: re("\\d+"), replace: "N" }]), "x.js");
    assert.equal(r.text, "abc");
    assert.equal(r.changed, false);
  });

  it("连续调用同一补丁不会因为 lastIndex 而漏匹配", () => {
    const patch = mkPatch([{ pattern: re("a"), replace: "b" }]);
    for (let i = 0; i < 4; i += 1) {
      const r = applyPatchToText("aaa", patch, "x.js");
      assert.equal(r.text, "bbb", `iteration ${i}`);
    }
  });

  it("带 g 的正则替换全部出现", () => {
    const r = applyPatchToText("1 2 3", mkPatch([{ pattern: re("\\d"), replace: "n" }]), "x.js");
    assert.equal(r.text, "n n n");
  });

  it("即使 pattern 声明不带 g，也强制全局替换（与原引擎一致）", () => {
    // 原实现 cloneRegExp(pattern, true) 无条件加 g：补丁语义是「改掉所有出现」，
    // 不是「改第一个」。这条测试锁住这个刻意的选择，防止有人"顺手"改成遵循 flags。
    const r = applyPatchToText("a a", mkPatch([{ pattern: re("a", "i"), replace: "b" }]), "x.js");
    assert.equal(r.text, "b b");
  });

  it("i 标志仍然生效（大小写不敏感）", () => {
    const r = applyPatchToText("A a", mkPatch([{ pattern: re("a", "i"), replace: "b" }]), "x.js");
    assert.equal(r.text, "b b");
  });
});

describe("applyPatchToText — CRLF 往返", () => {
  it("CRLF 文件改完仍是 CRLF", () => {
    const src = "line1\r\nFOO\r\nline3\r\n";
    const r = applyPatchToText(src, mkPatch([{ pattern: lit("FOO"), replace: "BAR" }]), "x.js");
    assert.equal(r.text, "line1\r\nBAR\r\nline3\r\n");
    assert.equal(r.text.includes("\r\n"), true);
    // 不能出现混合换行
    assert.equal(/[^\r]\n/.test(r.text), false);
  });

  it("CRLF 文件里 LF pattern 也能匹配", () => {
    const src = "a\r\nb\r\n";
    const r = applyPatchToText(src, mkPatch([{ pattern: lit("a\nb"), replace: "X" }]), "x.js");
    assert.equal(r.text, "X\r\n");
  });

  it("LF 文件不会被改成 CRLF", () => {
    const r = applyPatchToText("a\nb\n", mkPatch([{ pattern: lit("a"), replace: "z" }]), "x.js");
    assert.equal(r.text, "z\nb\n");
    assert.equal(r.text.includes("\r"), false);
  });
});

describe("applyPatchToText — YAML 特殊规则", () => {
  it("写入 .yml 时 // 注释被改成 #", () => {
    const r = applyPatchToText(
      "key: old",
      mkPatch([{ pattern: lit("key: old"), replace: "key: new // added" }]),
      "x.yml",
    );
    assert.equal(r.text, "key: new # added");
  });

  it("写入 .js 时 // 注释保持原样", () => {
    const r = applyPatchToText(
      "const a = 1",
      mkPatch([{ pattern: lit("const a = 1"), replace: "const a = 2 // note" }]),
      "x.js",
    );
    assert.equal(r.text, "const a = 2 // note");
  });

  it("YAML 里裸 identity needle 被跳过（避免破坏块标量缩进）", () => {
    const needle = "You are a coding agent powered by X";
    const patch = mkPatch([{ pattern: lit(needle), replace: "Y" }]);
    const r = applyPatchToText(needle, patch, "x.yml");
    assert.equal(r.text, needle, "应当完全不改");
    assert.equal(r.changed, false);
  });

  it("同样的 needle 在 .js 里会被改", () => {
    const needle = "You are a coding agent powered by X";
    const patch = mkPatch([{ pattern: lit(needle), replace: "Y" }]);
    const r = applyPatchToText(needle, patch, "x.js");
    assert.equal(r.text, "Y");
  });
});

describe("applyPatchToText — skipIfMarked 幂等", () => {
  it("插入型补丁第二次不再叠加", () => {
    const patch = mkPatch([{ pattern: lit("ANCHOR"), replace: "ANCHOR_MARKED" }], {
      skipIfMarked: true,
      markers: ["ANCHOR_MARKED"],
    });
    const first = applyPatchToText("x ANCHOR y", patch, "x.js");
    assert.equal(first.changed, true);
    const second = applyPatchToText(first.text, patch, "x.js");
    assert.equal(second.changed, false, "第二次必须无变化");
    assert.equal(second.text, first.text);
  });

  it("没有 skipIfMarked 时会重复替换（这是原实现的已知风险，此处只记录语义）", () => {
    const patch = mkPatch([{ pattern: lit("A"), replace: "AA" }]);
    const once = applyPatchToText("A", patch, "x.js");
    const twice = applyPatchToText(once.text, patch, "x.js");
    assert.equal(once.text, "AA");
    assert.equal(twice.text, "AAAA");
  });
});

describe("isPatchApplied", () => {
  it("markers 默认要求全部命中", () => {
    const patch = mkPatch([{ pattern: lit("p"), replace: "r" }], { markers: ["m1", "m2"] });
    assert.equal(isPatchApplied("m1", patch), false);
    assert.equal(isPatchApplied("m1 m2", patch), true);
  });

  it("markersAny 只要求任一命中", () => {
    const patch = mkPatch([{ pattern: lit("p"), replace: "r" }], { markers: ["m1", "m2"], markersAny: true });
    assert.equal(isPatchApplied("m1", patch), true);
  });

  it("forbid 命中则判定未应用（即使 markers 命中）", () => {
    const patch = mkPatch([{ pattern: lit("p"), replace: "r" }], {
      markers: ["m1"],
      forbid: ["BANNED"],
    });
    assert.equal(isPatchApplied("m1", patch), true);
    assert.equal(isPatchApplied("m1 BANNED", patch), false);
  });

  it("无 markers 时用 replace 首行前 60 字符判定", () => {
    const long = "a".repeat(120);
    const patch = mkPatch([{ pattern: lit("p"), replace: long }]);
    assert.equal(isPatchApplied("a".repeat(60), patch), true);
    assert.equal(isPatchApplied("zzz", patch), false);
  });

  it("marker 单字段生效", () => {
    const patch = mkPatch([{ pattern: lit("p"), replace: "r" }], { marker: "SINGLE" });
    assert.equal(isPatchApplied("SINGLE", patch), true);
  });

  it("CRLF 输入也能命中（内部归一）", () => {
    const patch = mkPatch([{ pattern: lit("p"), replace: "r" }], { markers: ["m1\nm2"] });
    assert.equal(isPatchApplied("zz m1\r\nm2 zz", patch), true);
  });
});

describe("patchHasRemainingWork", () => {
  it("pattern 仍在 = 有待做", () => {
    const patch = mkPatch([{ pattern: lit("FOO"), replace: "BAR" }]);
    assert.equal(patchHasRemainingWork("a FOO b", patch, "x.js"), true);
  });
  it("pattern 已消失 = 无待做", () => {
    const patch = mkPatch([{ pattern: lit("FOO"), replace: "BAR" }]);
    assert.equal(patchHasRemainingWork("a BAR b", patch, "x.js"), false);
  });
  it("YAML 里被跳过的裸 identity 不算待做（否则状态永远 pending）", () => {
    const needle = "You are a coding agent powered by X";
    const patch = mkPatch([{ pattern: lit(needle), replace: "Y" }]);
    assert.equal(patchHasRemainingWork(needle, patch, "x.yml"), false);
    assert.equal(patchHasRemainingWork(needle, patch, "x.js"), true);
  });
  it("与 apply 一致：apply 不改的，这里不报待做", () => {
    const needle = "You are a coding agent powered by X";
    const patch = mkPatch([{ pattern: lit(needle), replace: "Y" }]);
    const applied = applyPatchToText(needle, patch, "x.yml");
    assert.equal(applied.changed, false);
    assert.equal(patchHasRemainingWork(needle, patch, "x.yml"), false);
  });
});
