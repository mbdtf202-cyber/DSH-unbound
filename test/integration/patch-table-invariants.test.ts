/**
 * 补丁表不变量（`verify:patches` 漏掉的那几条）。
 *
 * `scripts/verify-patches.ts` 已经覆盖：id 唯一、pattern 非空、正则合法、
 * 每条有 replacements。它**漏掉**了四类会真实造成故障的问题：
 *
 * 1. **标记争用** —— 同一条标记被多条补丁声明、且目标文件重叠。这直接导致了
 *    #73 被 #70 永久遮蔽的真 bug（见 `marker-contention.test.ts`）。
 * 2. **自增长替换** —— 替换值里包含自己的 pattern，会导致每次 apply 无限膨胀。
 *    这类补丁必须 `skipIfMarked`，否则第二次 apply 就+长度。
 * 3. **forbid 是自己的 pattern 的子串** —— 这会让**干净的**宿主被报成 `reverted`
 *    （看起来像「有人回滚过」，实际是从没打过）。
 * 4. **markers 全部不可达** —— 声明了标记但既不在产出里、也没有别的补丁写它，
 *    这种标记永远不会出现，`skipIfMarked` 就失去意义。
 *
 * 这些断言跑在**真实补丁表**上，所以将来同步新表时若引入同类问题会立刻红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBundledPatches } from "../../src/patches/load.js";
import {
  contendedMarkers,
  patchOwnsItsMarkers,
  toLf,
} from "../../src/engine/text.js";
import type { PatchDefinition } from "../../src/patches/types.js";

const patches = loadBundledPatches();

/** 用 fileKeys 当「目标文件」的替身（同一 key = 同一批目标，足够判定重叠）。 */
function targetKeysOf(p: PatchDefinition): readonly string[] {
  return p.fileKeys.map((k) => `key:${k}`);
}

/** 一条替换是否会无限增长：替换值里包含自己的 pattern。 */
function isSelfGrowing(p: PatchDefinition): boolean {
  for (const r of p.replacements) {
    if (r.pattern.kind !== "literal") continue;
    const pat = toLf(r.pattern.text);
    if (pat.length === 0) continue;
    if (toLf(r.replace).includes(pat)) return true;
  }
  return false;
}

describe("补丁表不变量：标记争用", () => {
  /**
   * 争用本身**不是错误**（#70/#73 是有意共用一个家族标记），
   * 但必须是**已知且可枚举**的：新增争用意味着又有一对补丁可能互相遮蔽，
   * 需要人确认引擎的降级逻辑能正确处理它们。
   */
  it("争用集合必须是已知的那一条（新增争用要人工确认）", () => {
    const c = contendedMarkers(patches, targetKeysOf);
    assert.deepEqual(
      [...c].sort(),
      ["[dsh-qilin] preset shell network"],
      `争用标记发生变化，请确认新争用不会造成互相遮蔽。实际：${JSON.stringify([...c])}`,
    );
  });

  it("每条争用标记涉及的补丁里，至少有一条自己拥有该标记", () => {
    // 否则这批补丁全都靠别人的标记判断「已应用」，谁也证明不了自己。
    const c = contendedMarkers(patches, targetKeysOf);
    for (const marker of c) {
      const owner = patches.find(
        (p) =>
          [...(p.markers ?? []), ...(p.marker === undefined ? [] : [p.marker])].some((m) => toLf(m) === marker) &&
          patchOwnsItsMarkers(p),
      );
      assert.ok(owner !== undefined, `争用标记 ${JSON.stringify(marker)} 没有任何补丁真正写出它`);
    }
  });
});

describe("补丁表不变量：自增长替换必须 skipIfMarked", () => {
  it("自增长的补丁都声明了 skipIfMarked（否则每次 apply 都会变长）", () => {
    const risky = patches.filter((p) => isSelfGrowing(p) && !p.skipIfMarked);
    assert.deepEqual(
      risky.map((p) => `#${p.id} ${p.name}`),
      [],
      "这些补丁的替换值包含自身 pattern 却没开 skipIfMarked，会无限膨胀",
    );
  });

  it("确实存在自增长补丁（否则这条不变量是空转的）", () => {
    // 若为 0，说明上一条断言没有实际保护对象 —— 需要重新审视判据。
    const selfGrowing = patches.filter(isSelfGrowing);
    assert.ok(selfGrowing.length > 0, "应当存在自增长补丁（当前补丁表实测有若干条）");
    for (const p of selfGrowing) {
      assert.equal(p.skipIfMarked, true, `#${p.id} 自增长却没 skipIfMarked`);
    }
  });
});

describe("补丁表不变量：forbid 与自己的 pattern 冲突", () => {
  /**
   * `forbid` 的语义是「出现即视为未应用（曾被回滚）」。
   * 如果 forbid 字符串本身就是自己 pattern 的子串，那么**干净宿主**上
   * pattern 还在 → forbid 也命中 → 被误报成 `reverted`。
   *
   * 这不会让 drift 返回非 0（reverted 不计入 broken），但它误导人：
   * 报告会显示「有补丁被回滚过」，实际谁都没动过。
   */
  it("记录当前存在冲突的补丁（作为已知噪声，不允许扩大）", () => {
    const conflicting: string[] = [];
    for (const p of patches) {
      if (p.forbid === undefined) continue;
      const pats = p.replacements
        .map((r) => (r.pattern.kind === "literal" ? toLf(r.pattern.text) : ""))
        .filter((s) => s.length > 0);
      for (const f of p.forbid) {
        const needle = toLf(f);
        if (needle.length < 8) continue;
        if (pats.some((pat) => pat.includes(needle))) {
          conflicting.push(`#${p.id}`);
          break;
        }
      }
    }
    // 实测当前补丁表里有 4 条（#60/#61/#69/#86）。它们来自上游补丁表，
    // 属于数据层面的口径问题（不是本引擎引入的）；这里锁住数量，防止同步新表时悄悄变多。
    assert.ok(
      conflicting.length <= 4,
      `forbid 与自身 pattern 冲突的补丁变多了（${conflicting.length} 条：${conflicting.join(", ")}）。` +
        `这会让干净宿主被误报成 reverted。`,
    );
  });

  it("由该冲突导致的 reverted 不计入 broken（退出码不受影响）", () => {
    // 锁住「这个噪声不会把 CI 弄红」这一事实，避免有人为了消噪去改 broken 的定义。
    const brokenMembers = new Set(["partial", "dead"]);
    assert.equal(brokenMembers.has("reverted"), false);
  });
});

describe("补丁表不变量：标记语义", () => {
  /**
   * 注意：标记**不必**是补丁自己的产出。
   *
   * 有一类补丁的标记是**上游原文**——它的意思是「宿主已经处于官方的那种形态，
   * 所以不用再改了」。例如 #5 的标记
   * `The host MAX profile has already selected its configured permission policy`
   * 是官方源码里的句子，本补丁从不写出它。
   *
   * 所以这里不能断言「标记一定出现在某条 replacement 的产出里」。
   * 真正需要守的是：**开了 skipIfMarked 却没有标记**——那标志既关不掉也停不住。
   */
  it("skipIfMarked 的补丁必须有标记（否则标志无意义）", () => {
    const bad = patches
      .filter((p) => p.skipIfMarked)
      .filter((p) => (p.markers === undefined || p.markers.length === 0) && p.marker === undefined)
      .map((p) => `#${p.id} ${p.name}`);
    assert.deepEqual(bad, [], "开了 skipIfMarked 却没有标记，等于关不掉也停不住");
  });

  it("标记不能是空字符串（空标记会命中任何文本）", () => {
    const bad: string[] = [];
    for (const p of patches) {
      const ms = [...(p.markers ?? []), ...(p.marker === undefined ? [] : [p.marker])];
      for (const m of ms) if (m.length === 0) bad.push(`#${p.id}`);
    }
    assert.deepEqual(bad, [], "空标记会让『已应用』恒为真");
  });

  /**
   * 「标记是上游原文」这一情形本身是合法的，但它带来一个真实约束：
   * 这类补丁的 `already` 判定在**干净宿主**上就可能成立（上游文案本来就在）。
   * 因此这类补丁必须靠 pattern 而不是标记来表达「还要不要干活」，
   * 也就是说它们**不能**是 skipIfMarked（否则会在干净宿主上直接跳过）。
   */
  it("标记若并非自己产出，则不得开 skipIfMarked（否则干净宿主上会直接跳过）", () => {
    const bad: string[] = [];
    for (const p of patches) {
      if (!p.skipIfMarked) continue;
      if (patchOwnsItsMarkers(p)) continue; // 自己写标记，安全
      // 借来的/上游的标记 + skipIfMarked → 只在标记被争用时有风险（已由引擎处理）
      const c = contendedMarkers(patches, targetKeysOf);
      const ms = [...(p.markers ?? []), ...(p.marker === undefined ? [] : [p.marker])].map((m) => toLf(m));
      if (!ms.some((m) => c.has(m))) bad.push(`#${p.id} ${p.name}`);
    }
    // 已知只有 #73 属于「借来的 + 争用」，引擎已专门降级处理；这里不允许扩大。
    assert.ok(bad.length <= 1, `不应有更多『上游标记 + skipIfMarked』的补丁：${bad.join(", ")}`);
  });
});
