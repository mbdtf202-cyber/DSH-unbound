/**
 * 漂移检测测试。
 *
 * 这是原项目完全没有的能力，所以测试要覆盖它最容易骗人的地方：
 * 「看起来能用」的 partial 状态必须被识别出来，而不是被当成 healthy。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { diagnoseAll, diagnosePatch, driftExitCode, formatDriftReport, isUpgradeChainPatch } from "../src/engine/drift.js";
import { loadBundledPatches, loadPatchesFromArray } from "../src/patches/load.js";
import { applyPatches } from "../src/engine/apply.js";
import { makeFakeHost, type FakeHost } from "./helpers/host.js";
import type { PatchDefinition } from "../src/patches/types.js";

const FILE = "dsh-agent-instructions/lib/index.js";

function mk(opts: {
  id?: number;
  patterns: (string | { $regex: string; flags?: string })[];
  replace?: string;
  markers?: string[];
  markersAny?: boolean;
  forbid?: string[];
  file?: string;
}): PatchDefinition {
  return loadPatchesFromArray([
    {
      id: opts.id ?? 1,
      name: "DRIFT_TEST",
      layer: "代码",
      file: opts.file ?? "agent-instructions",
      replacements: opts.patterns.map((p) => ({ pattern: p, replace: opts.replace ?? "NEW" })),
      ...(opts.markers !== undefined ? { markers: opts.markers } : {}),
      ...(opts.markersAny !== undefined ? { markersAny: opts.markersAny } : {}),
      ...(opts.forbid !== undefined ? { forbid: opts.forbid } : {}),
    },
  ])[0]!;
}

describe("diagnosePatch — 六种状态", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("healthy：所有 pattern 都在", () => {
    host.write(FILE, "AAA\nBBB\n");
    const d = diagnosePatch(mk({ patterns: ["AAA", "BBB"] }), host.aiBase);
    assert.equal(d.state, "healthy");
    assert.equal(d.matchedPatterns, 2);
    assert.equal(d.totalPatterns, 2);
  });

  it("dead：0 个 pattern 命中（上游彻底改版）", () => {
    host.write(FILE, "completely rewritten\n");
    const d = diagnosePatch(mk({ patterns: ["AAA", "BBB"] }), host.aiBase);
    assert.equal(d.state, "dead");
    assert.equal(d.matchedPatterns, 0);
    assert.equal(d.stalePatterns.length, 2);
  });

  it("partial：部分命中 —— 最危险的状态（看起来能用）", () => {
    host.write(FILE, "AAA only\n");
    const d = diagnosePatch(mk({ patterns: ["AAA", "BBB", "CCC"] }), host.aiBase);
    assert.equal(d.state, "partial");
    assert.equal(d.matchedPatterns, 1);
    assert.equal(d.totalPatterns, 3);
    assert.equal(d.stalePatterns.length, 2);
  });

  it("applied：带已应用标记", () => {
    host.write(FILE, "AAA PATCHED_MARK\n");
    const d = diagnosePatch(mk({ patterns: ["AAA"], markers: ["PATCHED_MARK"] }), host.aiBase);
    assert.equal(d.state, "applied");
  });

  it("reverted：带 forbid 标记（曾应用又回滚）", () => {
    host.write(FILE, "AAA ROLLED_BACK\n");
    const d = diagnosePatch(
      mk({ patterns: ["AAA"], markers: ["PATCHED_MARK"], forbid: ["ROLLED_BACK"] }),
      host.aiBase,
    );
    assert.equal(d.state, "reverted");
  });

  it("absent：目标文件不在（不是失败）", () => {
    const d = diagnosePatch(mk({ patterns: ["AAA"] }), host.aiBase);
    assert.equal(d.state, "absent");
    assert.deepEqual(d.targetFiles, []);
  });
});

describe("diagnoseAll — 汇总与退出码", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("全部健康时 broken=0，退出码 0", () => {
    host.write(FILE, "AAA BBB\n");
    const report = diagnoseAll([mk({ id: 1, patterns: ["AAA"] }), mk({ id: 2, patterns: ["BBB"] })], host.aiBase);
    assert.equal(report.summary.broken, 0);
    assert.equal(driftExitCode(report), 0);
  });

  it("存在 partial/dead 时 broken>0，退出码 1", () => {
    host.write(FILE, "AAA\n");
    const report = diagnoseAll(
      [mk({ id: 1, patterns: ["AAA"] }), mk({ id: 2, patterns: ["GONE"] })],
      host.aiBase,
    );
    assert.equal(report.summary.dead, 1);
    assert.equal(report.summary.broken, 1);
    assert.equal(driftExitCode(report), 1);
  });

  it("absent 不拉红（桌面专属补丁在 web 宿主上）", () => {
    const report = diagnoseAll([mk({ id: 1, patterns: ["AAA"], file: "desktop-shell" })], host.aiBase);
    assert.equal(report.summary.absent, 1);
    assert.equal(report.summary.broken, 0);
    assert.equal(driftExitCode(report), 0);
  });

  it("汇总数字自洽（各状态之和 = total）", () => {
    host.write(FILE, "AAA\n");
    const report = diagnoseAll(
      [
        mk({ id: 1, patterns: ["AAA"] }),
        mk({ id: 2, patterns: ["GONE"] }),
        mk({ id: 3, patterns: ["AAA", "GONE2"] }),
      ],
      host.aiBase,
    );
    const s = report.summary;
    assert.equal(s.healthy + s.applied + s.partial + s.dead + s.absent + s.reverted, s.total);
  });
});

describe("漂移检测与 apply 的一致性", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("healthy 的补丁 apply 后确实 changed", () => {
    host.write(FILE, "AAA\n");
    const p = mk({ patterns: ["AAA"] });
    assert.equal(diagnosePatch(p, host.aiBase).state, "healthy");
    const r = applyPatches([p], host.aiBase);
    assert.equal(r.outcomes[0]?.status, "applied");
  });

  it("dead 的补丁 apply 后是 pattern_not_found（不是 already）", () => {
    host.write(FILE, "rewritten entirely\n");
    const p = mk({ patterns: ["GONE"] });
    assert.equal(diagnosePatch(p, host.aiBase).state, "dead");
    const r = applyPatches([p], host.aiBase);
    assert.equal(r.outcomes[0]?.status, "pattern_not_found");
  });

  it("apply 之后状态变 applied，不再报 healthy", () => {
    host.write(FILE, "AAA\n");
    const p = mk({ patterns: ["AAA"], replace: "AAA_MARKED", markers: ["AAA_MARKED"] });
    assert.equal(diagnosePatch(p, host.aiBase).state, "healthy");
    applyPatches([p], host.aiBase);
    assert.equal(diagnosePatch(p, host.aiBase).state, "applied");
  });
});

describe("formatDriftReport", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("列出 broken 补丁及命中比例", () => {
    host.write(FILE, "AAA\n");
    const report = diagnoseAll(
      [mk({ id: 42, patterns: ["AAA", "MISSING"] })],
      host.aiBase,
    );
    const text = formatDriftReport(report);
    assert.match(text, /#42/);
    assert.match(text, /1\/2/);
    assert.match(text, /broken: 1/);
  });

  it("verbose 输出 stale pattern 摘要", () => {
    host.write(FILE, "AAA\n");
    const report = diagnoseAll([mk({ patterns: ["AAA", "UNIQUE_STALE_TEXT"] })], host.aiBase);
    const text = formatDriftReport(report, { verbose: true });
    assert.match(text, /UNIQUE_STALE_TEXT/);
  });

  it("pattern 摘要里的换行被转义，不会把报告撑成多行", () => {
    host.write(FILE, "nothing\n");
    const report = diagnoseAll([mk({ patterns: ["line1\n\tline2"] })], host.aiBase);
    const text = formatDriftReport(report, { verbose: true });
    assert.match(text, /line1\\n\\tline2/);
  });
});

describe("升级链补丁（pattern 匹配自己的早先产物）", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("干净宿主上 0 命中 → pending-upgrade，不是 dead", () => {
    // 真实 #21 的形态：只匹配「已应用过」之后才存在的文本
    host.write(FILE, "timeoutMs: 60000\n");
    const p = mk({
      patterns: [
        {
          $regex: "timeoutMs: 60{5,}[ \\t]*(?:#|\\/\\/)[ \\t]*\\[dsh-qilin\\] bash timeout raised",
          flags: "g",
        },
      ],
      replace: "$1600000",
    });
    const d = diagnosePatch(p, host.aiBase);
    assert.equal(d.state, "pending-upgrade", "干净宿主上不该报 dead");
  });

  it("真实 #21 补丁在真实宿主源码上被正确识别为升级链", () => {
    const real = loadBundledPatches().find((p) => p.id === 21);
    assert.ok(real, "#21 应当存在");
    assert.equal(isUpgradeChainPatch(real), true);
  });

  it("升级链补丁不拉红，不把 exit code 变成 1", () => {
    host.write(FILE, "timeoutMs: 60000\n");
    const p = mk({
      id: 21,
      patterns: [{ $regex: "\\[dsh-qilin\\] bash timeout raised", flags: "g" }],
    });
    const report = diagnoseAll([p], host.aiBase);
    assert.equal(report.summary.pendingUpgrade, 1);
    assert.equal(report.summary.broken, 0);
    assert.equal(driftExitCode(report), 0);
  });

  it("升级链补丁一旦真的命中 → 变 healthy（说明可升级）", () => {
    host.write(FILE, "timeoutMs: 600000 # [dsh-qilin] bash timeout raised\n");
    const p = mk({
      id: 21,
      patterns: [{ $regex: "\\[dsh-qilin\\] bash timeout raised", flags: "g" }],
    });
    assert.equal(diagnosePatch(p, host.aiBase).state, "healthy");
  });

  it("转义写法的标记也能识别（\\[dsh-qilin\\] 而不是 [dsh-qilin]）", () => {
    const p = mk({ patterns: [{ $regex: "\\[dsh-qilin\\] something", flags: "g" }] });
    assert.equal(isUpgradeChainPatch(p), true);
  });

  it("普通补丁不会被误判为升级链", () => {
    const p = mk({ patterns: ["const A = 1;"] });
    assert.equal(isUpgradeChainPatch(p), false);
  });
});
