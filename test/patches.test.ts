/**
 * 目标解析与补丁加载的测试。
 *
 * 这两块是「数据正确性」的关键：解析错了就会打错文件、加载错了就会静默 no-op。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { knownTargetKeys, namespaceRootsOf, resolveTarget, resolveAllTargets, isAiBase } from "../src/host/targets.js";
import { join } from "node:path";

describe("normalizePatch — 加载期校验", () => {
  it("接受 replacements[] 写法（主形态）", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    const [p] = loadPatchesFromArray([
      { id: 1, name: "A", file: "x", replacements: [{ pattern: "P", replace: "R" }] },
    ]);
    assert.equal(p?.replacements.length, 1);
    assert.equal(p?.replacements[0]?.pattern.kind, "literal");
  });

  it("接受 patterns[] + replace 写法，并折叠成 replacements", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    const [p] = loadPatchesFromArray([
      { id: 1, name: "A", file: ["x", "y"], patterns: ["P1", "P2"], replace: "R" },
    ]);
    assert.equal(p?.replacements.length, 2, "两个 pattern 应折叠成两条替换");
    assert.deepEqual(p?.fileKeys, ["x", "y"], "file 应归一为数组");
    assert.equal(p?.replacements[0]?.replace, "R");
    assert.equal(p?.replacements[1]?.replace, "R");
  });

  it("file 是字符串时归一为单元素数组", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    const [p] = loadPatchesFromArray([
      { id: 1, name: "A", file: "only", replacements: [{ pattern: "P", replace: "R" }] },
    ]);
    assert.deepEqual(p?.fileKeys, ["only"]);
  });

  it("拒绝重复 id", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    const { PatchDefinitionError } = await import("../src/patches/types.js");
    assert.throws(
      () =>
        loadPatchesFromArray([
          { id: 1, name: "A", file: "x", replacements: [{ pattern: "P", replace: "R" }] },
          { id: 1, name: "B", file: "x", replacements: [{ pattern: "P", replace: "R" }] },
        ]),
      (e: unknown) => e instanceof PatchDefinitionError && /duplicate/.test((e as Error).message),
    );
  });

  it("拒绝没有 replacements 也没有 patterns 的补丁（会静默 no-op）", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    assert.throws(() => loadPatchesFromArray([{ id: 1, name: "A", file: "x" }]), /no replacements/);
  });

  it("拒绝空字符串 pattern", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    assert.throws(
      () => loadPatchesFromArray([{ id: 1, name: "A", file: "x", replacements: [{ pattern: "", replace: "R" }] }]),
      /empty literal/,
    );
  });

  it("拒绝非法正则", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    assert.throws(
      () =>
        loadPatchesFromArray([
          { id: 1, name: "A", file: "x", replacements: [{ pattern: { $regex: "([" }, replace: "R" }] },
        ]),
      /invalid regex/i,
    );
  });

  it("拒绝缺 name", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    assert.throws(
      () => loadPatchesFromArray([{ id: 1, file: "x", replacements: [{ pattern: "P", replace: "R" }] }]),
      /name/,
    );
  });

  it("拒绝非正整数 id", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    assert.throws(
      () => loadPatchesFromArray([{ id: 0, name: "A", file: "x", replacements: [{ pattern: "P", replace: "R" }] }]),
      /positive integer/,
    );
  });

  it("可选字段缺省值正确", async () => {
    const { loadPatchesFromArray } = await import("../src/patches/load.js");
    const [p] = loadPatchesFromArray([
      { id: 1, name: "A", file: "x", replacements: [{ pattern: "P", replace: "R" }] },
    ]);
    assert.equal(p?.markersAny, false);
    assert.equal(p?.skipIfMarked, false);
    assert.equal(p?.optional, false);
    assert.equal(p?.strictFiles, false);
    assert.equal(p?.softSettle, false);
    assert.equal(p?.markers, undefined);
    assert.equal(p?.forbid, undefined);
  });
});

describe("内置补丁表", () => {
  it("能加载且条数为 86", async () => {
    const { loadBundledPatches } = await import("../src/patches/load.js");
    const patches = loadBundledPatches();
    assert.equal(patches.length, 86);
  });

  it("id 唯一且递增有序", async () => {
    const { loadBundledPatches } = await import("../src/patches/load.js");
    const patches = loadBundledPatches();
    const ids = patches.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "id 必须唯一");
  });

  it("每条补丁都至少有一个目标 key 和一条替换", async () => {
    const { loadBundledPatches } = await import("../src/patches/load.js");
    for (const p of loadBundledPatches()) {
      assert.ok(p.fileKeys.length > 0, `#${p.id} 缺 file`);
      assert.ok(p.replacements.length > 0, `#${p.id} 缺 replacements`);
    }
  });

  it("所有正则 pattern 都能构造", async () => {
    const { loadBundledPatches } = await import("../src/patches/load.js");
    for (const p of loadBundledPatches()) {
      for (const r of p.replacements) {
        const pat = r.pattern;
        if (pat.kind === "regex") {
          assert.doesNotThrow(
            () => new RegExp(pat.source, pat.flags.replace(/g/g, "")),
            `#${p.id} 有非法正则`,
          );
        }
      }
    }
  });
});

describe("目标解析", () => {
  it("knownTargetKeys 覆盖补丁表里出现的所有 key", async () => {
    const { loadBundledPatches } = await import("../src/patches/load.js");
    const used = new Set(loadBundledPatches().flatMap((p) => p.fileKeys));
    const known = new Set(knownTargetKeys());
    const missing = [...used].filter((k) => !known.has(k));
    // targets.json 里有历史 key（如 base-package）不在 TARGETS 模板中，
    // 但如果补丁用到却没模板，就是真缺口。
    const trulyMissing = missing.filter((k) => !k.startsWith("preset-liangshen"));
    assert.deepEqual(trulyMissing, [], `这些 key 被补丁使用但没有解析模板：${trulyMissing.join(", ")}`);
  });

  it("不存在的 aiBase 上所有 key 都解析为空（不抛）", () => {
    const all = resolveAllTargets("/nonexistent/@deepseek-ai");
    for (const [key, r] of Object.entries(all)) {
      assert.deepEqual(r.paths, [], `${key} 应当解析为空`);
    }
  });

  it("isAiBase 拒绝非 @deepseek-ai 目录", () => {
    assert.equal(isAiBase("/tmp"), false);
    assert.equal(isAiBase("/nonexistent"), false);
  });

  it("isAiBase 拒绝空的同名目录", () => {
    const root = fs.mkdtempSync(path.join(import.meta.dirname, "fake-"));
    try {
      const fake = path.join(root, "@deepseek-ai");
      fs.mkdirSync(fake);
      assert.equal(isAiBase(fake), false, "没有 dsh-* 包时不算 aiBase");
      fs.mkdirSync(path.join(fake, "dsh-fake"));
      assert.equal(isAiBase(fake), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("namespaceRootsOf 能发现兄弟 scope（pi-ai 在 @earendil-works 下）", () => {
    const root = fs.mkdtempSync(join(import.meta.dirname, "ns-"));
    try {
      const nm = join(root, "node_modules");
      const primary = join(nm, "@deepseek-ai");
      const sibling = join(nm, "@earendil-works");
      fs.mkdirSync(primary, { recursive: true });
      fs.mkdirSync(sibling, { recursive: true });
      const roots = namespaceRootsOf(primary);
      assert.equal(roots.primary, primary);
      assert.equal(roots.siblingScopes.get("@earendil-works"), sibling);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("目标解析 — 真实宿主（存在时）", () => {
  const REAL = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai";
  const available = fs.existsSync(REAL);

  it("能解析 pi-ai（跨命名空间，原项目漏掉的功能）", { skip: !available }, () => {
    for (const key of ["pi-ai-anthropic-messages", "pi-ai-completions", "pi-ai-responses-shared"]) {
      const r = resolveTarget(key, REAL);
      assert.ok(r.paths.length > 0, `${key} 应当解析成功`);
      assert.match(r.paths[0]!, /@earendil-works/, `${key} 应落在 @earendil-works 命名空间`);
    }
  });

  it("能解析 agent-instructions（主命名空间）", { skip: !available }, () => {
    const r = resolveTarget("agent-instructions", REAL);
    assert.ok(r.paths.length > 0);
    assert.match(r.paths[0]!, /dsh-agent-instructions/);
  });

  it("不存在的 key 返回 none 而不是抛错", () => {
    const r = resolveTarget("this-key-does-not-exist", REAL);
    assert.deepEqual(r.paths, []);
    assert.equal(r.via, "none");
  });
});
