/**
 * 标记争用回归（真实缺陷）。
 *
 * ## 原 bug 的形态
 *
 * 补丁 #70 `PRESET_SHELL_NETWORK` 在 preset yml 里插入一行带标记的注释：
 *
 *     - id: persistent-pwsh # [dsh-qilin] preset shell network
 *
 * 补丁 #73 `PRESET_BASH_MIRROR_LINE` 是**纯删除型**：它删掉
 * `* Network access depends on the task environment...` 那一行，替换值只是 `"\n"`，
 * 自己从不写任何标记。但它把 #70 的那条标记声明成自己的 `markers`。
 *
 * 两条补丁命中**同一对文件**（`dsh-web-app/presets/minimal.patch.yml`
 * 与 `dsh-sdk-minimal/cordis.patch.yml`）。补丁表里 #70 在前、#73 在后，于是：
 *
 *   1. #70 先跑，把标记写进文件；
 *   2. #73 跑到 `skipIfMarked` 分支，看到「标记在」→ 判 `already` → 直接 continue；
 *   3. #73 的 pattern 因此**永远没有机会执行**。
 *
 * 实测真实宿主：那两个 preset 文件里 `Network access depends on the task environment`
 * 至今原样存在，而 `drift` 与 `apply` 都报 #73 为 `applied` / `already` ——
 * 一个从未生效的补丁被一致地误报成已完成。这是本项目最危险的一类失败：
 * 用户以为破甲打全了，实际少一条。
 *
 * ## 修法
 *
 * 在**补丁集合层面**识别「标记争用」：同一条标记被两条以上补丁声明，且它们的
 * 目标文件有交集。对这类标记不采信 `skipIfMarked` / `already` 的短路，
 * 让它回到 pattern 判定。
 *
 * 关键是**只对同时满足两个条件的补丁降级**：
 *   - 标记不是自己写的（`patchOwnsItsMarkers === false`）
 *   - 标记被争用
 * 只满足一条时保持原行为 —— 否则会把 #70 自己（它确实写过标记）误判成 dead。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatches } from "../../src/engine/apply.js";
import { diagnosePatch } from "../../src/engine/drift.js";
import { contendedMarkers, patchOwnsItsMarkers } from "../../src/engine/text.js";
import { loadBundledPatches, loadPatchesFromArray } from "../../src/patches/load.js";
import type { PatchDefinition } from "../../src/patches/types.js";

const patches = loadBundledPatches();

/** #70 / #73 在补丁表里的真实定义。 */
const P70 = patches.find((p) => p.id === 70);
const P73 = patches.find((p) => p.id === 73);

/** 二者共用的标记。 */
const SHARED_MARKER = "[dsh-qilin] preset shell network";

/** #73 要删除的那一行。 */
const MIRROR_LINE =
  "                    * Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.\n";

/** 造一个含 #70 pattern 与 #73 目标行的 preset yml（上游原始形态）。 */
function presetUpstream(): string {
  // #70 的 pattern[1]（无缩进变体）原文 + #73 的目标行。
  const pwsh = P70!.replacements[1]!.pattern;
  const pwshText = pwsh.kind === "literal" ? pwsh.text : "";
  return `${pwshText}\n${MIRROR_LINE}                    * State is persistent across command calls.\n`;
}

function tinyHost(content: string): { root: string; aiBase: string; file: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-contend-"));
  const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
  const rel = "dsh-web-app/presets/minimal.patch.yml";
  const file = path.join(aiBase, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  fs.copyFileSync(file, file + ".dshqilin.bak");
  return { root, aiBase, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("回归：标记争用（#73 被 #70 的标记永久遮蔽）", () => {
  it("前提：两条补丁共用同一条标记，且目标文件有交集", () => {
    assert.ok(P70 !== undefined, "补丁 #70 必须存在");
    assert.ok(P73 !== undefined, "补丁 #73 必须存在");
    assert.deepEqual(P70.markers, [SHARED_MARKER]);
    assert.deepEqual(P73.markers, [SHARED_MARKER], "#73 确实借用了 #70 的标记");
    assert.deepEqual(P70.fileKeys, P73.fileKeys, "两条补丁必须命中同一组 file key");
  });

  it("patchOwnsItsMarkers：识别『借来的标记』", () => {
    // #70 的替换值里带标记 → 自己写的
    assert.equal(patchOwnsItsMarkers(P70!), true, "#70 的产出里包含自己的标记");
    // #73 的替换值是 "\\n" → 借来的
    assert.equal(patchOwnsItsMarkers(P73!), false, "#73 是纯删除型，从不写标记");
  });

  it("contendedMarkers：把这条标记识别为争用", () => {
    const c = contendedMarkers([P70!, P73!], (p) => p.fileKeys.map((k) => `key:${k}`));
    assert.ok(c.has(SHARED_MARKER), "共用且目标重叠 → 必须判为争用");
  });

  it("contendedMarkers：单条补丁不产生争用（避免误伤）", () => {
    const c = contendedMarkers([P73!], (p) => p.fileKeys.map((k) => `key:${k}`));
    assert.equal(c.size, 0, "只有一条补丁时不存在争用");
  });

  it("contendedMarkers：共用标记但目标不重叠 → 不算争用", () => {
    const a = loadPatchesFromArray([
      { id: 1, name: "A", file: "agent-instructions", patterns: ["x"], replace: "y", markers: ["M"] },
    ])[0]!;
    const b = loadPatchesFromArray([
      { id: 2, name: "B", file: "tool-bash", patterns: ["x"], replace: "y", markers: ["M"] },
    ])[0]!;
    const c = contendedMarkers([a, b], (p) => p.fileKeys.map((k) => `key:${k}`));
    assert.equal(c.size, 0, "目标文件不同 → 标记能区分归属，不算争用");
  });

  it("核心：apply 时 #73 不再被 #70 的标记遮蔽", () => {
    const host = tinyHost(presetUpstream());
    try {
      const before = fs.readFileSync(host.file, "utf8");
      assert.ok(before.includes("Network access depends on"), "前置：上游确实有这一行");

      // 按补丁表顺序跑（#70 在前），这正是真实场景。
      const report = applyPatches([P70!, P73!], host.aiBase);
      const after = fs.readFileSync(host.file, "utf8");

      const o73 = report.outcomes.find((o) => o.patchId === 73)!;
      // 修好之后：#73 要么自己把行删了（applied），要么诚实地报 pattern_not_found；
      // 绝不能出现「报 already 但行还在」。
      const lineStillThere = after.includes("Network access depends on");
      if (o73.status === "already") {
        assert.equal(lineStillThere, false, "报 already 就必须真的已经删掉了那一行");
      }
      assert.equal(lineStillThere, false, "#73 的目标行最终必须被删除");
    } finally {
      host.cleanup();
    }
  });

  it("核心：drift 不再把 #73 误报成 applied（目标行还在时必须暴露）", () => {
    // 造一个「#70 已打、#73 未打」的文件：即真实宿主的当前形态。
    const host = tinyHost("");
    try {
      // 先用 #70 打一遍
      fs.writeFileSync(host.file, presetUpstream(), "utf8");
      applyPatches([P70!], host.aiBase);
      const mid = fs.readFileSync(host.file, "utf8");
      assert.ok(mid.includes(SHARED_MARKER), "前置：#70 的标记已经在文件里");
      assert.ok(mid.includes("Network access depends on"), "前置：#73 的目标行仍在");

      // 此时诊断 #73：绝不能是 applied（它根本没生效）。
      const drifted = diagnosePatch(P73!, host.aiBase, new Set([SHARED_MARKER]));
      assert.notEqual(drifted.state, "applied", "#73 未生效时不能报 applied");
      // 而且健康度要如实反映：pattern 还活着 → healthy（可以打）
      assert.equal(drifted.state, "healthy", `期望 healthy（pattern 仍可命中），实际 ${drifted.state}`);
    } finally {
      host.cleanup();
    }
  });

  it("不误伤 #70：它自己拥有标记，被共用也照常判 applied", () => {
    const host = tinyHost("");
    try {
      fs.writeFileSync(host.file, presetUpstream(), "utf8");
      applyPatches([P70!], host.aiBase);
      const d = diagnosePatch(P70!, host.aiBase, new Set([SHARED_MARKER]));
      assert.equal(d.state, "applied", "#70 确实写了自己的标记，不能被判成 dead");
    } finally {
      host.cleanup();
    }
  });

  it("真实补丁表上：争用集合恰好只有这一条标记", () => {
    const c = contendedMarkers(patches, (p) => {
      const keys: string[] = [];
      for (const k of p.fileKeys) keys.push(`key:${k}`);
      return keys;
    });
    // 这条断言的意义：修复的作用面是**可枚举**的，不是全局放宽。
    assert.deepEqual([...c], [SHARED_MARKER], `实际争用集合：${JSON.stringify([...c])}`);
  });

  it("真实补丁表上：#73 的 pattern 现在能命中真实宿主（证明它之前确实没打过）", () => {
    const realAiBase =
      process.env["DSH_UNBOUND_REAL_AIBASE"] ??
      "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai";
    const rel = "dsh-web-app/presets/minimal.patch.yml";
    const fp = path.join(realAiBase, rel);
    if (!fs.existsSync(fp)) {
      // 宿主不在就跳过（不能因此让 CI 红）。
      return;
    }
    const text = fs.readFileSync(fp, "utf8");
    const pattern = P73!.replacements[0]!.pattern;
    const matches =
      pattern.kind === "regex"
        ? new RegExp(pattern.source, pattern.flags.replace(/g/g, "")).test(text)
        : text.includes(pattern.text);
    // pattern 能命中 = 这条补丁的工作还没做 —— 与「它从未生效」一致。
    // 如果哪天真实宿主被正确打过，这里的 pattern 就不该再命中，届时把断言翻转。
    if (matches) {
      const d = diagnosePatch(P73!, realAiBase, new Set([SHARED_MARKER]));
      assert.notEqual(d.state, "applied", "pattern 还命中时不得报 applied（这正是原 bug）");
    }
  });
});
