/**
 * 备份与回滚策略（A 部分第 5 条）。
 *
 * 备份是这个工具唯一的安全网：apply 会改宿主文件，revert 全靠备份。
 * 所以「备份里放的到底是不是原文」是**正确性问题**，不是实现细节。
 *
 * ## 这里锁住的真实缺陷
 *
 * 从 dsh-qilin 迁移过来的宿主上，文件布局是这样的：
 *
 *     file.js               = 已被旧版打过补丁的字节
 *     file.js.dshqilin.bak  = 干净的官方原文   ← 唯一可用的回滚点
 *
 * 而 `ensureBackupSync` 早先只检查自己的 `.dsh-unbound.bak`。于是在这种宿主上
 * 它会**把已打补丁的当前文件再复制一份**当备份：
 *
 *     file.js.dsh-unbound.bak = 已打补丁的字节   ← 污染
 *
 * 而 `findBackup` / `revertPatches` 都**优先**用自然后缀。结果 revert 把
 * 「已打补丁的字节」写回去并报告「restored 1 file」—— 用户以为回到了官方原文，
 * 其实只是从一个补丁态换到了另一个补丁态。这种失败**没有任何报错**。
 *
 * 实测本机真实宿主上 54 个被补丁触及的文件**全部**带有 `.dshqilin.bak`，
 * 所以这不是理论问题。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupPathOf,
  ensureBackupSync,
  findBackup,
  restoreFromBackupSync,
  BACKUP_SUFFIX,
} from "../../src/fs/atomic.js";
import { applyPatches, revertPatches } from "../../src/engine/apply.js";
import { loadPatchesFromArray } from "../../src/patches/load.js";

/** 最小补丁：把 ORIGINAL 换成 PATCHED。 */
function patchFor(): ReturnType<typeof loadPatchesFromArray>[number] {
  return loadPatchesFromArray([
    {
      id: 1,
      name: "BACKUP_TEST",
      file: "agent-instructions",
      replacements: [{ pattern: "ORIGINAL", replace: "PATCHED" }],
    },
  ])[0]!;
}

function host(files: Record<string, string> = {}): { root: string; aiBase: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-bak-"));
  const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(aiBase, ...rel.split("/"));
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
  }
  return { root, aiBase, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const REL = "dsh-agent-instructions/lib/index.js";

describe("备份策略：apply 生成与幂等", () => {
  it("首次改文件时生成 .dsh-unbound.bak 且内容是原文", () => {
    const h = host({ [REL]: "ORIGINAL\n" });
    try {
      applyPatches([patchFor()], h.aiBase);
      const fp = path.join(h.aiBase, ...REL.split("/"));
      assert.equal(fs.existsSync(backupPathOf(fp)), true, "应生成备份");
      assert.equal(fs.readFileSync(backupPathOf(fp), "utf8"), "ORIGINAL\n", "备份必须是原文");
      assert.equal(fs.readFileSync(fp, "utf8"), "PATCHED\n", "当前文件应是补丁后内容");
    } finally {
      h.cleanup();
    }
  });

  it("再次 apply 不覆盖已有备份（保住最早的原文）", () => {
    const h = host({ [REL]: "ORIGINAL\n" });
    try {
      applyPatches([patchFor()], h.aiBase);
      const fp = path.join(h.aiBase, ...REL.split("/"));
      const first = fs.readFileSync(backupPathOf(fp), "utf8");

      // 手动把文件改成别的形态，模拟「中间又被别的东西改过」
      fs.writeFileSync(fp, "SOMETHING_ELSE\n", "utf8");
      const r = ensureBackupSync(fp);
      assert.equal(r.created, false, "已有备份不应重建");
      assert.equal(fs.readFileSync(backupPathOf(fp), "utf8"), first, "备份必须保持不变");
    } finally {
      h.cleanup();
    }
  });

  it("不产生 .tmp 残留", () => {
    const h = host({ [REL]: "ORIGINAL\n" });
    try {
      applyPatches([patchFor()], h.aiBase);
      const dir = path.join(h.aiBase, "dsh-agent-instructions", "lib");
      assert.deepEqual(
        fs.readdirSync(dir).filter((n) => n.includes(".tmp")),
        [],
        "正常 apply 不应留临时文件",
      );
    } finally {
      h.cleanup();
    }
  });
});

describe("备份策略：迁移自 dsh-qilin 时不得污染回滚点", () => {
  it("已有 legacy 备份时，不得再生成内容不同的自有备份", () => {
    const pristine = "ORIGINAL\n";
    const qilinPatched = "ORIGINAL qilin-patched\n"; // 旧版打过补丁的当前文件
    const h = host({ [REL]: qilinPatched });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      // 关键布局：legacy 备份是干净原文，当前文件是旧版补丁产物
      fs.writeFileSync(fp + ".dshqilin.bak", pristine, "utf8");

      const r = ensureBackupSync(fp);
      assert.equal(r.created, false, "已有 legacy 备份就不该新建");
      assert.equal(r.backupPath, expectLegacy(fp), "应当复用 legacy 备份");
      assert.equal(fs.existsSync(fp + BACKUP_SUFFIX), false, "绝不能再造一份自有备份");
    } finally {
      h.cleanup();
    }
  });

  it("revert 必须还原到 legacy 备份里的**干净原文**，而不是旧版补丁产物", () => {
    const pristine = "ORIGINAL\n";
    const qilinPatched = "ORIGINAL qilin-patched\n";
    const h = host({ [REL]: qilinPatched });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      fs.writeFileSync(fp + ".dshqilin.bak", pristine, "utf8");

      const r = revertPatches([patchFor()], h.aiBase);
      assert.equal(r.restored.length, 1);
      assert.equal(
        fs.readFileSync(fp, "utf8"),
        pristine,
        "必须回到官方原文；若回到 qilinPatched 说明回滚点被污染了",
      );
    } finally {
      h.cleanup();
    }
  });

  it("findBackup 优先自有备份，自有不存在时退到 legacy", () => {
    const h = host({ [REL]: "x\n" });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      assert.equal(findBackup(fp), null, "都没有时应为 null");

      fs.writeFileSync(fp + ".dshqilin.bak", "legacy", "utf8");
      assert.equal(findBackup(fp), fp + ".dshqilin.bak");

      fs.writeFileSync(fp + BACKUP_SUFFIX, "own", "utf8");
      assert.equal(findBackup(fp), fp + BACKUP_SUFFIX, "自有备份优先");
    } finally {
      h.cleanup();
    }
  });

  it("restoreFromBackupSync 走同样的优先级", () => {
    const h = host({ [REL]: "current\n" });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      fs.writeFileSync(fp + ".dshqilin.bak", "legacy\n", "utf8");
      assert.equal(restoreFromBackupSync(fp), true);
      assert.equal(fs.readFileSync(fp, "utf8"), "legacy\n");
    } finally {
      h.cleanup();
    }
  });
});

describe("备份策略：revert 后的清理与保留", () => {
  /**
   * 当前策略：**保留**备份文件，不删除。
   *
   * 理由：备份是用户唯一的回滚点。revert 之后若把它删掉，再 apply 一次
   * 就会以「已回滚的当前文件」为原文重新备份 —— 那个原文可能已经不可靠。
   * 保留备份让 revert 可以反复执行且结果稳定。
   */
  it("revert 之后备份文件保留（使 revert 可重复执行且稳定）", () => {
    const h = host({ [REL]: "ORIGINAL\n" });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      applyPatches([patchFor()], h.aiBase);

      const first = revertPatches([patchFor()], h.aiBase);
      assert.equal(first.restored.length, 1);
      assert.equal(fs.existsSync(backupPathOf(fp)), true, "revert 不删备份");

      // 再 revert 一次：结果必须一样（幂等），而不是报 missing
      const second = revertPatches([patchFor()], h.aiBase);
      assert.equal(second.restored.length, 1, "第二次 revert 仍应还原");
      assert.equal(second.missing.length, 0);
      assert.equal(fs.readFileSync(fp, "utf8"), "ORIGINAL\n");
    } finally {
      h.cleanup();
    }
  });

  it("apply → revert → apply 的往返：原文始终可从备份取回", () => {
    const h = host({ [REL]: "ORIGINAL\n" });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      for (let i = 0; i < 3; i += 1) {
        applyPatches([patchFor()], h.aiBase);
        assert.equal(fs.readFileSync(fp, "utf8"), "PATCHED\n", `第 ${i + 1} 轮 apply`);
        revertPatches([patchFor()], h.aiBase);
        assert.equal(fs.readFileSync(fp, "utf8"), "ORIGINAL\n", `第 ${i + 1} 轮 revert`);
      }
    } finally {
      h.cleanup();
    }
  });

  it("无备份的文件 revert 时原样保留（不用旧版覆盖用户刚升级的宿主）", () => {
    const h = host({ [REL]: "USER_UPGRADED\n" });
    try {
      const fp = path.join(h.aiBase, ...REL.split("/"));
      const r = revertPatches([patchFor()], h.aiBase);
      assert.equal(r.restored.length, 0);
      assert.equal(r.missing.length, 1);
      assert.equal(fs.readFileSync(fp, "utf8"), "USER_UPGRADED\n", "无备份就不该动");
    } finally {
      h.cleanup();
    }
  });
});

/** legacy 备份的期望路径。 */
function expectLegacy(fp: string): string {
  return `${fp}.dshqilin.bak`;
}
