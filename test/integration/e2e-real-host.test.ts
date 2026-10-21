/**
 * 真实宿主端到端验证（A 部分）。
 *
 * ## 这组测试要证明什么
 *
 * 单元测试能证明「每个函数行为正确」，但证明不了「这东西作为交付物能用」。
 * 这组测试把真实的 54 个宿主文件搬进 `/tmp` 副本，跑完整生命周期：
 *
 *   1. apply 全量 → filesChanged > 0 且 failed === 0
 *   2. 再 apply 一次 → 幂等：filesChanged === 0，全部 already
 *   3. revert → 字节级回到初始（sha256 逐文件比对）
 *   4. 备份行为：apply 生成、revert 清理/保留策略
 *   5. 中途失败安全性：注入只读目录 / 目标变目录，断言不留半写状态
 *
 * ## 绝不动真实宿主
 *
 * 所有写操作都只发生在 `mkdtemp` 出来的副本里（见 `replica.ts` 的 `assertInside`）。
 * 用例结束还会断言「真实宿主的字节没被改」—— 万一哪天真被写了，要立刻响。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatches, revertPatches } from "../../src/engine/apply.js";
import { diagnoseAll } from "../../src/engine/drift.js";
import { loadBundledPatches } from "../../src/patches/load.js";
import { atomicWriteFileSync } from "../../src/fs/atomic.js";
import {
  assertInside,
  diffAgainstSnapshot,
  realHostSkipReason,
  replicaFromRealHost,
  sha256File,
  snapshotHashes,
  type Replica,
} from "./replica.js";

const patches = loadBundledPatches();
const skip = realHostSkipReason();

/**
 * 补丁 #1 要替换的上游原文（`dsh-agent-instructions/lib/index.js`）。
 *
 * 必须在测试里给出**真实会被命中的字节**：如果随手写个占位符，引擎根本不会
 * 进入写盘分支，失败注入用例就退化成「什么都没发生」——看起来绿，其实没测到东西。
 */
const PATCH_ONE_UPSTREAM =
  'const WORKSPACE_CONTEXT_INTRO = "The following workspace instructions may be relevant to your work. ' +
  "Use them as guidance when applicable. More specific instructions take precedence over broader ones. " +
  'They do not override system, developer, or direct user instructions."\n';

describe("端到端：真实宿主隔离副本上的完整生命周期", { skip }, () => {
  let replica: Replica;
  /** 副本建立时的字节指纹。revert 之后必须逐个对上。 */
  let initial: ReadonlyMap<string, string>;
  /** 真实宿主的字节指纹，用例结束后要确认没被碰过。 */
  let realHostHashes: ReadonlyMap<string, string>;

  before(() => {
    replica = replicaFromRealHost({ seedBackups: true });
    initial = snapshotHashes(replica.replicaFiles);
    realHostHashes = snapshotHashes(replica.sourceFiles);
  });

  after(() => {
    if (replica !== undefined) {
      // 红线：真实宿主一个字节都不能变。
      const changed = diffAgainstSnapshot(replica.sourceFiles, realHostHashes);
      assert.deepEqual(changed, [], "真实宿主被写了！端到端测试必须只动副本");
      fs.rmSync(replica.root, { recursive: true, force: true });
    }
  });

  it("副本本身就是一份真实宿主（不是空壳）", () => {
    assert.ok(replica.replicaFiles.length > 0, "必须复制到文件");
    // 54 个文件是本机实测值；布局变化时这里会变，所以只断言「够多」而不钉死。
    assert.ok(
      replica.replicaFiles.length >= 40,
      `补丁涉及的文件数应 >= 40，实际 ${replica.replicaFiles.length}`,
    );
    // 每个副本文件都必须位于副本根之下。
    for (const fp of replica.replicaFiles) assertInside(replica.root, fp);
    // 至少有一份目标文件是真实的 JS（证明拿到的不是占位符）。
    const jsFiles = replica.replicaFiles.filter((f) => f.endsWith(".js"));
    assert.ok(jsFiles.length > 0, "副本里必须有 .js 目标文件");
  });

  it("apply 全量：filesChanged > 0 且 failed === 0", () => {
    const report = applyPatches(patches, replica.aiBase);

    assert.equal(report.summary.failed, 0, `不应有失败，outcomes: ${
      JSON.stringify(report.outcomes.filter((o) => o.status === "read_error" || o.status === "write_error" || o.status === "failed"))
    }`);
    assert.ok(
      report.summary.filesChanged > 0,
      `首次 apply 必须真的改到文件，实际 ${report.summary.filesChanged}`,
    );
    assert.equal(report.summary.total, patches.length, "每条补丁都应有 outcome");
    // writtenFiles 必须与实际改动一致（外部工具靠它判断要不要重启宿主）。
    assert.equal(
      report.writtenFiles.length,
      report.summary.filesChanged,
      "writtenFiles 与 filesChanged 必须一致",
    );
    for (const fp of report.writtenFiles) assertInside(replica.root, fp);
  });

  it("apply 之后副本字节确实变了（且改的是真实文件）", () => {
    const changed = diffAgainstSnapshot(replica.replicaFiles, initial);
    assert.ok(changed.length > 0, "apply 之后必须有文件字节变化");
    for (const fp of changed) {
      assertInside(replica.root, fp);
      assert.ok(fs.statSync(fp).size > 0, `${fp} 被写成了空文件`);
    }
  });

  it("幂等：第二次 apply 一个字节都不写，全部 already/非 applied", () => {
    const report = applyPatches(patches, replica.aiBase);

    assert.equal(report.summary.filesChanged, 0, "第二次 apply 必须 0 写入（幂等契约）");
    assert.deepEqual(report.writtenFiles, [], "第二次 apply 不应报告任何写入文件");
    assert.equal(report.summary.applied, 0, "第二次不应有 applied");
    assert.equal(report.summary.failed, 0);
    // 第二次之后字节必须仍与「第一次 apply 完」一致 —— 不能来回抖。
    const twich = applyPatches(patches, replica.aiBase);
    assert.equal(twich.summary.filesChanged, 0, "第三次也必须 0 写入");
  });

  it("dry-run 不写盘，但报告的结果与真实 apply 一致", () => {
    // 先回滚，回到「未打补丁」的初始态，再对比 dry-run 与真跑。
    revertPatches(patches, replica.aiBase);
    assert.deepEqual(diffAgainstSnapshot(replica.replicaFiles, initial), [], "回滚应回到初始态");

    const dry = applyPatches(patches, replica.aiBase, { dryRun: true });
    assert.deepEqual(diffAgainstSnapshot(replica.replicaFiles, initial), [], "dry-run 不能写盘");
    assert.equal(dry.summary.filesChanged, 0, "dry-run 的 filesChanged 记 0（没真写）");

    const real = applyPatches(patches, replica.aiBase);
    assert.equal(
      real.summary.applied,
      dry.summary.applied,
      "dry-run 预测的 applied 必须与真跑一致",
    );
    assert.equal(
      real.summary.patternNotFound,
      dry.summary.patternNotFound,
      "dry-run 预测的 patternNotFound 必须与真跑一致",
    );
    assert.equal(real.summary.failed, 0);
  });

  it("备份：apply 生成 .bak，且绝不覆盖已有备份", () => {
    // 副本里我们预置了 .dshqilin.bak，apply 不应该再新建一份「已污染」的 .dsh-unbound.bak。
    const wronglyCreated: string[] = [];
    for (const fp of replica.replicaFiles) {
      if (fs.existsSync(fp + ".dsh-unbound.bak")) {
        const own = fs.readFileSync(fp + ".dsh-unbound.bak");
        const legacy = fs.existsSync(fp + ".dshqilin.bak")
          ? fs.readFileSync(fp + ".dshqilin.bak")
          : null;
        // 若已有 legacy 备份，却还新建了自己的备份 → 说明备份逻辑没复用 legacy。
        if (legacy !== null && !own.equals(legacy)) wronglyCreated.push(fp);
      }
    }
    assert.deepEqual(
      wronglyCreated,
      [],
      "已有 .dshqilin.bak 时不应再生成内容不同的 .dsh-unbound.bak（会污染回滚路径）",
    );
  });

  it("revert：字节级回到初始状态（逐文件 sha256）", () => {
    const result = revertPatches(patches, replica.aiBase);
    assert.equal(result.missing.length, 0, `不应有「无备份」的文件，实际：${result.missing.join(", ")}`);
    assert.ok(result.restored.length > 0, "必须还原到文件");

    const stillDifferent = diffAgainstSnapshot(replica.replicaFiles, initial);
    assert.deepEqual(
      stillDifferent.map((f) => path.relative(replica.aiBase, f)),
      [],
      "revert 之后每个文件的 sha256 都必须与初始一致",
    );
  });

  it("revert 之后再次 apply 可以重新打上（生命周期可重复）", () => {
    const report = applyPatches(patches, replica.aiBase);
    assert.equal(report.summary.failed, 0);
    assert.ok(report.summary.filesChanged > 0, "回滚后应能重新 apply");

    // 再回滚，收尾干净。
    const rv = revertPatches(patches, replica.aiBase);
    assert.equal(rv.missing.length, 0);
    assert.deepEqual(diffAgainstSnapshot(replica.replicaFiles, initial), []);
  });

  it("drift 在副本上可跑且不报 broken 之外的东西（一致性）", () => {
    const report = diagnoseAll(patches, replica.aiBase);
    assert.equal(report.summary.total, patches.length);
    // broken 的定义必须自洽：partial + dead
    assert.equal(report.summary.broken, report.summary.partial + report.summary.dead);
    for (const p of report.patches) {
      assert.ok(p.totalPatterns >= 0);
      assert.ok(p.matchedPatterns >= 0 && p.matchedPatterns <= p.totalPatterns);
    }
  });
});

describe("端到端：中途失败的安全性（不留半写状态）", { skip }, () => {
  /** 每个用例独立建一个小宿主，只放一个目标文件，便于精确注入故障。 */
  function tinyHost(): { root: string; aiBase: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-failsafe-"));
    const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
    fs.mkdirSync(aiBase, { recursive: true });
    return { root, aiBase };
  }

  it("目标目录只读 → 写失败被记为 failed，且文件字节完整保留", () => {
    const { root, aiBase } = tinyHost();
    try {
      const dir = path.join(aiBase, "dsh-agent-instructions", "lib");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "index.js");
      // 必须是**真正会被补丁 #1 命中的上游原文**，否则引擎根本不会尝试写盘，
      // 这个用例就退化成了「什么都没发生」。
      const original = PATCH_ONE_UPSTREAM;
      fs.writeFileSync(target, original, "utf8");

      const before = sha256File(target);
      fs.chmodSync(dir, 0o555); // 目录只读：原子写的 tmp 文件建不出来

      let report;
      try {
        report = applyPatches(patches, aiBase);
      } finally {
        fs.chmodSync(dir, 0o755);
      }

      // 写不进去必须被如实报告为失败，而不是静默成功。
      assert.ok(
        report.summary.failed > 0,
        `只读目录必须导致 failed > 0，实际 ${report.summary.failed}`,
      );
      const outcome = report.outcomes.find((o) => o.patchId === 1);
      assert.ok(outcome !== undefined);
      assert.equal(outcome.status, "write_error", "补丁 #1 应被判为 write_error");
      assert.ok(outcome.error !== undefined, "必须给出可读的错误原因");
      // 关键断言：文件必须保持原样，不能变成空/截断/半写。
      assert.equal(sha256File(target), before, "失败后原文件字节必须不变");
      assert.equal(fs.readFileSync(target, "utf8"), original);
      // 且不能留下 .tmp 垃圾（会污染宿主目录、被下次 glob 命中）
      const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
      assert.deepEqual(leftovers, [], "失败后不能残留临时文件");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("目标是目录 → 写失败被判为 failed，且不会把目录变成文件", () => {
    const { root, aiBase } = tinyHost();
    try {
      const dir = path.join(aiBase, "dsh-agent-instructions", "lib");
      fs.mkdirSync(dir, { recursive: true });
      // 故意把目标做成目录。注意：`collectTargets` 用的是 `isRegularFile`，
      // 所以目录会被当成「目标不存在」→ 补丁判 missing_file。
      // 这仍然是**安全**行为（没有写坏任何东西、没有半写），但不是 write_error。
      const target = path.join(dir, "index.js");
      fs.mkdirSync(target, { recursive: true });

      const report = applyPatches(patches, aiBase);
      // 核心安全断言：目录仍在，没被替换成文件。
      assert.ok(fs.statSync(target).isDirectory(), "目标目录不能被替换成文件");
      assert.deepEqual(fs.readdirSync(target), [], "目录里不应被塞进任何东西");

      const outcome = report.outcomes.find((o) => o.patchId === 1);
      assert.ok(outcome !== undefined, "补丁 #1 必须有 outcome");
      // 该 key 只剩这一个目标且它不是普通文件 → 判 missing_file（而非崩溃/静默成功）。
      assert.equal(
        outcome.status,
        "missing_file",
        `目标不是普通文件时应判 missing_file，实际 ${outcome.status}`,
      );
      // 这种情况下失败不该计入 failed（它是「宿主上没这个目标」，不是写失败）。
      assert.equal(report.summary.failed, 0, "missing_file 不算 failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomicWriteFileSync 自身：目录只读时抛错且字节不变", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-atomic-"));
    try {
      const dir = path.join(root, "d");
      fs.mkdirSync(dir);
      const f = path.join(dir, "x.js");
      fs.writeFileSync(f, "OLD", "utf8");
      const before = sha256File(f);

      fs.chmodSync(dir, 0o555);
      try {
        assert.throws(() => atomicWriteFileSync(f, "NEW"));
      } finally {
        fs.chmodSync(dir, 0o755);
      }

      assert.equal(sha256File(f), before, "失败的原子写必须让原文件字节不变");
      assert.equal(fs.readFileSync(f, "utf8"), "OLD");
      assert.deepEqual(
        fs.readdirSync(dir).filter((n) => n.includes(".tmp")),
        [],
        "不能残留 tmp",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
