/**
 * 边界穷举（B 部分）。
 *
 * 这里专测「输入不是正常形态时引擎怎么表现」——正常路径已经被大量用例覆盖，
 * 真正会咬人的是空表、重复 id、空 pattern、0 字节文件、CRLF、超长单行、
 * 以及**同一 pattern 出现多次**时到底全替换还是只替换首个。
 *
 * 每条断言都写清「为什么是这个期望」：边界用例最容易被写成
 * 「断言当前行为」，那样它只能防止改动，不能防止错误。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchToText, matchesPattern, toLf, isPatchApplied } from "../../src/engine/text.js";
import { loadPatchesFromArray } from "../../src/patches/load.js";
import { PatchDefinitionError } from "../../src/patches/types.js";
import { applyPatches, revertPatches, selectPatches } from "../../src/engine/apply.js";
import type { PatchDefinition } from "../../src/patches/types.js";

/** 造一条最小可用补丁（只填必需字段）。 */
function mkPatch(over: {
  id?: number;
  replacements?: readonly { pattern: unknown; replace: string }[];
  patterns?: readonly unknown[];
  replace?: string;
  file?: string | string[];
  markers?: string | string[];
  marker?: string;
  markersAny?: boolean;
  forbid?: string | string[];
  skipIfMarked?: boolean;
  optional?: boolean;
  strictFiles?: boolean;
  softSettle?: boolean;
  surfaces?: string | string[];
}): PatchDefinition {
  const raw: Record<string, unknown> = {
    id: over.id ?? 1,
    name: "TEST",
    file: over.file ?? "agent-instructions",
  };
  if (over.replacements !== undefined) raw["replacements"] = over.replacements;
  if (over.patterns !== undefined) raw["patterns"] = over.patterns;
  if (over.replace !== undefined) raw["replace"] = over.replace;
  if (over.markers !== undefined) raw["markers"] = over.markers;
  if (over.marker !== undefined) raw["marker"] = over.marker;
  if (over.markersAny !== undefined) raw["markersAny"] = over.markersAny;
  if (over.forbid !== undefined) raw["forbid"] = over.forbid;
  if (over.skipIfMarked !== undefined) raw["skipIfMarked"] = over.skipIfMarked;
  if (over.optional !== undefined) raw["optional"] = over.optional;
  if (over.strictFiles !== undefined) raw["strictFiles"] = over.strictFiles;
  if (over.softSettle !== undefined) raw["softSettle"] = over.softSettle;
  if (over.surfaces !== undefined) raw["surfaces"] = over.surfaces;
  return loadPatchesFromArray([raw])[0]!;
}

/** 临时宿主。 */
function tinyHost(files: Record<string, string> = {}): { root: string; aiBase: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-edge-"));
  const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
  fs.mkdirSync(aiBase, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(aiBase, ...rel.split("/"));
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
  }
  return { root, aiBase, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("边界：补丁表校验（加载期就该炸）", () => {
  it("空补丁表：加载成功，apply 出 0 条 outcome 而不是崩溃", () => {
    const empty = loadPatchesFromArray([]);
    assert.deepEqual(empty, []);
    const host = tinyHost();
    try {
      const report = applyPatches(empty, host.aiBase);
      assert.equal(report.summary.total, 0);
      assert.equal(report.summary.filesChanged, 0);
      assert.equal(report.summary.failed, 0);
      assert.deepEqual(report.outcomes, []);
    } finally {
      host.cleanup();
    }
  });

  it("重复 id：加载期抛 PatchDefinitionError（不能带进运行时）", () => {
    assert.throws(
      () =>
        loadPatchesFromArray([
          { id: 7, name: "A", file: "agent-instructions", patterns: ["x"], replace: "y" },
          { id: 7, name: "B", file: "agent-instructions", patterns: ["x"], replace: "y" },
        ]),
      (err: unknown) => err instanceof PatchDefinitionError && /duplicate patch id/i.test(String(err)),
    );
  });

  it("空字面量 pattern：加载期直接拒绝", () => {
    assert.throws(
      () => loadPatchesFromArray([{ id: 1, name: "A", file: "agent-instructions", patterns: [""], replace: "y" }]),
      (err: unknown) => err instanceof PatchDefinitionError && /empty literal pattern/i.test(String(err)),
    );
  });

  it("非法正则：加载期直接拒绝（附原始错误原因）", () => {
    assert.throws(
      () =>
        loadPatchesFromArray([
          { id: 1, name: "A", file: "agent-instructions", patterns: [{ $regex: "([unclosed" }], replace: "y" },
        ]),
      (err: unknown) => err instanceof PatchDefinitionError && /invalid regex/i.test(String(err)),
    );
  });

  it("完全没有 replacements/patterns：加载期拒绝（不许静默 no-op）", () => {
    assert.throws(
      () => loadPatchesFromArray([{ id: 1, name: "A", file: "agent-instructions" }]),
      (err: unknown) => err instanceof PatchDefinitionError && /no replacements/i.test(String(err)),
    );
  });

  it("id 非正整数、name 空、file 空：都拒绝", () => {
    const bad: readonly Record<string, unknown>[] = [
      { id: 0, name: "A", file: "k", patterns: ["x"], replace: "y" },
      { id: -3, name: "A", file: "k", patterns: ["x"], replace: "y" },
      { id: 1.5, name: "A", file: "k", patterns: ["x"], replace: "y" },
      { id: 1, name: "", file: "k", patterns: ["x"], replace: "y" },
      { id: 1, name: "A", file: [], patterns: ["x"], replace: "y" },
    ];
    for (const raw of bad) {
      assert.throws(
        () => loadPatchesFromArray([raw]),
        (err: unknown) => err instanceof PatchDefinitionError,
        `应当拒绝：${JSON.stringify(raw)}`,
      );
    }
  });

  it("两种写法（replacements[] 与 patterns[]+replace）折叠成同一形状", () => {
    const a = mkPatch({ replacements: [{ pattern: "x", replace: "y" }] });
    const b = mkPatch({ patterns: ["x"], replace: "y" });
    assert.deepEqual(a.replacements, b.replacements, "两套 schema 必须折叠成相同结果");
    assert.equal(a.replacements.length, 1);
  });
});

describe("边界：空 pattern 在引擎层的表现（不该被静默接受）", () => {
  it("matchesPattern 对空字面量恒为 true —— 这是 substring 的定义", () => {
    // 语义事实：任何字符串都包含空串。这不是 bug，但意味着**空 pattern 必须靠
    // 加载期拒绝**来防；一旦越过加载期，它会变成「任何地方都算命中」。
    assert.equal(matchesPattern("abc", { kind: "literal", text: "" }), true);
    assert.equal(matchesPattern("", { kind: "literal", text: "" }), true);
  });

  it("空字面量 pattern 根本进不到引擎：加载期就抛错", () => {
    // 上面那条「恒为 true」看起来危险，但**无法通过正常路径构造出这种补丁**。
    // 这里就是证明：加载期把它挡住了，所以 applyPatchToText 永远见不到空 pattern。
    assert.throws(
      () => mkPatch({ replacements: [{ pattern: "", replace: "X" }] }),
      (err: unknown) => err instanceof PatchDefinitionError && /empty literal pattern/i.test(String(err)),
    );
  });

  it("假设绕过加载期，空 pattern 会打散文本 —— 记录这个破坏性后果", () => {
    // 直接构造一个未经 loadPatchesFromArray 校验的对象（模拟「有人绕过校验」），
    // 证明为什么加载期必须拒绝：split("") 会把每个字符拆开再加分隔符。
    const rogue: PatchDefinition = {
      id: 1,
      name: "ROGUE",
      layer: "",
      layerEn: "",
      desc: "",
      fileKeys: ["agent-instructions"],
      rel: [],
      replacements: [{ pattern: { kind: "literal", text: "" }, replace: "X" }],
      markers: undefined,
      markersAny: false,
      marker: undefined,
      forbid: undefined,
      skipIfMarked: false,
      optional: false,
      surfaces: undefined,
      strictFiles: false,
      softSettle: false,
    };
    const result = applyPatchToText("abc", rogue, "x.js");
    assert.equal(result.text, "aXbXc", "空 pattern 会把文本打散（这正是加载期必须拦它的原因）");
    assert.equal(result.changed, true);
  });
});

describe("边界：文件形态（0 字节 / CRLF / 无结尾换行 / 超长单行）", () => {
  it("0 字节文件：不写、不算失败，判 pattern 未命中", () => {
    const patch = mkPatch({ replacements: [{ pattern: "foo", replace: "BAR" }] });
    const r = applyPatchToText("", patch, "x.js");
    assert.equal(r.text, "");
    assert.equal(r.changed, false);
    assert.equal(r.appliedCount, 0);
    assert.equal(r.notFoundCount, 1);
  });

  it("0 字节文件在文件系统上：apply 后文件仍为空，且不产生 .bak 污染", () => {
    const host = tinyHost({ "dsh-agent-instructions/lib/index.js": "" });
    try {
      const patch = mkPatch({ replacements: [{ pattern: "foo", replace: "BAR" }] });
      const report = applyPatches([patch], host.aiBase);
      const fp = path.join(host.aiBase, "dsh-agent-instructions/lib/index.js");
      assert.equal(fs.readFileSync(fp, "utf8"), "", "空文件不该被写成别的东西");
      assert.equal(report.summary.filesChanged, 0);
      // pattern 未命中 → pattern_not_found（不是静默 already）
      assert.equal(report.outcomes[0]!.status, "pattern_not_found");
    } finally {
      host.cleanup();
    }
  });

  it("CRLF 文件：能匹配、替换后仍是 CRLF（不能把宿主换行风格改掉）", () => {
    const patch = mkPatch({ replacements: [{ pattern: "foo", replace: "BAR" }] });
    const r = applyPatchToText("a\r\nfoo\r\nb\r\n", patch, "x.js");
    assert.equal(r.text, "a\r\nBAR\r\nb\r\n");
    assert.equal(r.changed, true);
    // 换行风格必须整体保持 CRLF，不能只有被替换那行变 LF。
    assert.equal((r.text.match(/\r\n/g) ?? []).length, 3);
    assert.equal(r.text.includes("\n\n"), false);
  });

  it("CRLF 文件：pattern 本身带 \\n 也能命中（匹配前统一转 LF）", () => {
    const patch = mkPatch({ replacements: [{ pattern: "a\nb", replace: "a\nB" }] });
    const r = applyPatchToText("x\r\na\r\nb\r\ny\r\n", patch, "x.js");
    assert.equal(r.changed, true, "CRLF 文件里的 \\n pattern 必须能命中");
    assert.equal(r.text, "x\r\na\r\nB\r\ny\r\n");
  });

  it("LF 文件不会被无端加 CRLF", () => {
    const patch = mkPatch({ replacements: [{ pattern: "foo", replace: "BAR" }] });
    const r = applyPatchToText("a\nfoo\nb\n", patch, "x.js");
    assert.equal(r.text.includes("\r"), false, "原本是 LF 的文件不能出现 CR");
  });

  it("无结尾换行：替换后不会凭空补一个换行", () => {
    const patch = mkPatch({ replacements: [{ pattern: "b", replace: "B" }] });
    const r = applyPatchToText("a\nb", patch, "x.js");
    assert.equal(r.text, "a\nB");
    assert.equal(r.text.endsWith("\n"), false, "末尾不该被加上换行");
  });

  it("超长单行（1 MB）：能正确匹配替换，不崩不收尾异常", () => {
    const longLine = "x".repeat(1024 * 1024);
    const text = `${longLine}NEEDLE${longLine}`;
    const patch = mkPatch({ replacements: [{ pattern: "NEEDLE", replace: "OK" }] });
    const r = applyPatchToText(text, patch, "x.js");
    assert.equal(r.changed, true);
    assert.equal(r.text.length, text.length - "NEEDLE".length + 2);
    assert.equal(r.text.includes("NEEDLE"), false);
    assert.equal(r.text.includes("OK"), true);
  });

  it("只有孤立的 \\r（老式 Mac）：toLf 不动它，因此 \\n pattern 不会误解它", () => {
    // 这是刻意记录的行为：toLf 只处理 \\r\\n。孤立 \\r 不是行分隔符承诺的一部分。
    assert.equal(toLf("a\rb"), "a\rb");
    assert.equal(toLf("a\r\nb"), "a\nb");
  });
});

describe("边界：同一 pattern 出现多次 —— 全替换（不是只替换首个）", () => {
  it("字面量 pattern：全部替换", () => {
    const patch = mkPatch({ replacements: [{ pattern: "foo", replace: "BAR" }] });
    const r = applyPatchToText("foo\nfoo\nfoo\n", patch, "x.js");
    assert.equal(r.text, "BAR\nBAR\nBAR\n", "必须全替换（split/join 语义）");
    assert.equal(r.appliedCount, 1, "appliedCount 记的是『替换条数』，不是命中次数");
  });

  it("正则 pattern：全部替换", () => {
    const patch = mkPatch({ replacements: [{ pattern: { $regex: "foo" }, replace: "BAR" }] });
    const r = applyPatchToText("foo foo", patch, "x.js");
    assert.equal(r.text, "BAR BAR");
  });

  it("全替换是幂等的前提：只替换首个会导致第二次 apply 又改一次", () => {
    const patch = mkPatch({ replacements: [{ pattern: "foo", replace: "BAR" }] });
    const once = applyPatchToText("foo foo foo", patch, "x.js");
    const twice = applyPatchToText(once.text, patch, "x.js");
    assert.equal(twice.changed, false, "全替换之后第二次必须无可替换");
  });

  it("替换结果包含原 pattern 时，skipIfMarked 是唯一防膨胀手段", () => {
    // 形如 `a` -> `a // marker`：pattern 在产物里依然存在，会无限膨胀。
    const patch = mkPatch({
      replacements: [{ pattern: "const A = 1;", replace: "const A = 1; // patched" }],
      marker: "// patched",
      skipIfMarked: true,
    });
    const once = applyPatchToText("const A = 1;\n", patch, "x.js");
    const twice = applyPatchToText(once.text, patch, "x.js");
    const thrice = applyPatchToText(twice.text, patch, "x.js");
    assert.equal(twice.changed, false, "带标记后必须跳过");
    assert.equal(thrice.text, once.text, "不能每次 apply 都叠加一层");
  });

  it("正则 $1 展开语义必须保住（不能当字面量写进文件）", () => {
    const patch = mkPatch({ replacements: [{ pattern: { $regex: "name: (\\w+)" }, replace: "name: $1_renamed" }] });
    const r = applyPatchToText("name: alice", patch, "x.js");
    assert.equal(r.text, "name: alice_renamed", "$1 必须被展开");
    assert.equal(r.text.includes("$1"), false, "$1 不能以字面量形式留下");
  });
});

describe("边界：--only / --skip 的选择语义", () => {
  const p1 = mkPatch({ id: 1, replacements: [{ pattern: "a", replace: "b" }] });
  const p2 = mkPatch({ id: 2, replacements: [{ pattern: "a", replace: "b" }] });
  const p3 = mkPatch({ id: 3, replacements: [{ pattern: "a", replace: "b" }] });
  const all = [p1, p2, p3];

  it("不传 only/skip：全选", () => {
    assert.equal(selectPatches(all).length, 3);
  });

  it("only 为空数组：视为不过滤（不是『一个都不要』）", () => {
    // 这个语义很重要：CLI 里 `--only ""` 会得到空数组，
    // 若解释成「全不选」，用户会以为补丁都没打，实际却什么都没做。
    assert.equal(selectPatches(all, { only: [] }).length, 3);
  });

  it("only 指定 id：只选这些", () => {
    assert.deepEqual(selectPatches(all, { only: [2] }).map((p) => p.id), [2]);
  });

  it("only 里含不存在的 id：静默忽略，不报错、不影响其它选择", () => {
    assert.deepEqual(selectPatches(all, { only: [2, 999] }).map((p) => p.id), [2]);
    assert.deepEqual(selectPatches(all, { only: [999] }).map((p) => p.id), [], "全都不存在 = 空选择");
  });

  it("skip 指定 id：剔除这些", () => {
    assert.deepEqual(selectPatches(all, { skip: [1] }).map((p) => p.id), [2, 3]);
  });

  it("skip 里含不存在的 id：无副作用", () => {
    assert.deepEqual(selectPatches(all, { skip: [999] }).map((p) => p.id), [1, 2, 3]);
  });

  it("only 与 skip 同时给：skip 优先（同一 id 被 only 选中又被 skip → 不选）", () => {
    const sel = selectPatches(all, { only: [1, 2], skip: [2] });
    assert.deepEqual(sel.map((p) => p.id), [1], "skip 优先级必须高于 only");
  });

  it("skip 全部：得到空选择，apply 不写任何东西", () => {
    const host = tinyHost({ "dsh-agent-instructions/lib/index.js": "aa\n" });
    try {
      const report = applyPatches(all, host.aiBase, { skip: [1, 2, 3] });
      assert.equal(report.summary.total, 0);
      assert.equal(report.summary.filesChanged, 0);
    } finally {
      host.cleanup();
    }
  });

  it("surface 过滤：补丁声明了 surfaces 且不含当前 surface 时被排除", () => {
    const webOnly = mkPatch({ id: 10, replacements: [{ pattern: "a", replace: "b" }], surfaces: ["web"] });
    const desktopOnly = mkPatch({ id: 11, replacements: [{ pattern: "a", replace: "b" }], surfaces: ["desktop"] });
    const noSurface = mkPatch({ id: 12, replacements: [{ pattern: "a", replace: "b" }] });
    const list = [webOnly, desktopOnly, noSurface];
    assert.deepEqual(selectPatches(list, { surface: "web" }).map((p) => p.id), [10, 12]);
    assert.deepEqual(selectPatches(list, { surface: "desktop" }).map((p) => p.id), [11, 12]);
    assert.equal(selectPatches(list).length, 3, "不传 surface 时不过滤");
  });
});

describe("边界：目标解析失败与 optional/strictFiles 语义", () => {
  it("file key 完全解析不到 + 非 optional：missing_file", () => {
    const host = tinyHost();
    try {
      const patch = mkPatch({ replacements: [{ pattern: "a", replace: "b" }] });
      const report = applyPatches([patch], host.aiBase);
      assert.equal(report.outcomes[0]!.status, "missing_file");
      assert.equal(report.summary.failed, 0, "missing_file 不算 failed");
      assert.deepEqual(report.outcomes[0]!.targetFiles, []);
    } finally {
      host.cleanup();
    }
  });

  it("file key 解析不到 + optional：na（桌面专属补丁在 web 宿主上的正常形态）", () => {
    const host = tinyHost();
    try {
      const patch = mkPatch({ replacements: [{ pattern: "a", replace: "b" }], optional: true });
      const report = applyPatches([patch], host.aiBase);
      assert.equal(report.outcomes[0]!.status, "na");
      assert.equal(report.summary.skipped, 1, "na 计入 skipped");
      assert.equal(report.summary.missingFile, 0, "na 不计入 missingFile");
    } finally {
      host.cleanup();
    }
  });

  it("完全不存在的 file key（模板里没有）：也走 missing_file，不抛异常", () => {
    const host = tinyHost();
    try {
      const patch = mkPatch({ replacements: [{ pattern: "a", replace: "b" }], file: "no-such-key-at-all" });
      const report = applyPatches([patch], host.aiBase);
      assert.equal(report.outcomes[0]!.status, "missing_file");
    } finally {
      host.cleanup();
    }
  });

  it("revert 对没有备份的文件：报 missing 并保持原样", () => {
    const content = "untouched\n";
    const host = tinyHost({ "dsh-agent-instructions/lib/index.js": content });
    try {
      const patch = mkPatch({ replacements: [{ pattern: "a", replace: "b" }] });
      const r = revertPatches([patch], host.aiBase);
      assert.equal(r.restored.length, 0);
      assert.equal(r.missing.length, 1);
      const fp = path.join(host.aiBase, "dsh-agent-instructions/lib/index.js");
      assert.equal(fs.readFileSync(fp, "utf8"), content, "无备份就不该动文件");
    } finally {
      host.cleanup();
    }
  });
});

describe("边界：isPatchApplied 的判定优先级", () => {
  it("forbid 命中时一律判『未应用』（即使 marker 也在）", () => {
    const patch = mkPatch({
      replacements: [{ pattern: "x", replace: "y" }],
      markers: ["MARKER"],
      forbid: ["FORBIDDEN"],
    });
    assert.equal(isPatchApplied("MARKER only", patch), true);
    assert.equal(isPatchApplied("MARKER + FORBIDDEN", patch), false, "forbid 必须压过 marker");
  });

  it("markersAny=false：必须全部命中才算已应用", () => {
    const patch = mkPatch({ replacements: [{ pattern: "x", replace: "y" }], markers: ["A", "B"], markersAny: false });
    assert.equal(isPatchApplied("A", patch), false, "只有一半标记不算已应用");
    assert.equal(isPatchApplied("A B", patch), true);
  });

  it("markersAny=true：任一命中即可", () => {
    const patch = mkPatch({ replacements: [{ pattern: "x", replace: "y" }], markers: ["A", "B"], markersAny: true });
    assert.equal(isPatchApplied("A", patch), true);
    assert.equal(isPatchApplied("B", patch), true);
    assert.equal(isPatchApplied("none", patch), false);
  });
});
