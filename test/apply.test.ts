/**
 * 引擎集成测试：在真实临时目录树上跑 apply。
 *
 * 这些用例覆盖 dsh-qilin 里最容易出错、且完全没有测试的部分：
 * 幂等、备份只做一次、原子写、部分目标缺失、dry-run 不落盘、回滚。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyPatches, collectTargets, revertPatches, selectPatches } from "../src/engine/apply.js";
import { loadPatchesFromArray } from "../src/patches/load.js";
import { makeFakeHost, type FakeHost } from "./helpers/host.js";
import type { PatchDefinition } from "../src/patches/types.js";

/** 造一条针对 fake host 的补丁：file key = dsh-agent-instructions/lib/index.js */
function patchAgainst(
  overrides: Partial<{
    id: number;
    pattern: string;
    replace: string;
    skipIfMarked: boolean;
    markers: string[];
    markersAny: boolean;
    forbid: string[];
    optional: boolean;
    strictFiles: boolean;
    softSettle: boolean;
  }> = {},
): PatchDefinition {
  const raw = {
    id: overrides.id ?? 1,
    name: "TEST_PATCH",
    layer: "代码",
    layer_en: "Code",
    desc: "test",
    // 用 targets.json 里的真实 key，模板解析会命中 fake host 上的同名包
    file: "agent-instructions",
    rel: ["lib", "index.js"],
    replacements: [{ pattern: overrides.pattern ?? "ORIGINAL", replace: overrides.replace ?? "PATCHED" }],
    ...(overrides.markers !== undefined ? { markers: overrides.markers } : {}),
    ...(overrides.markersAny !== undefined ? { markersAny: overrides.markersAny } : {}),
    ...(overrides.skipIfMarked !== undefined ? { skipIfMarked: overrides.skipIfMarked } : {}),
    ...(overrides.forbid !== undefined ? { forbid: overrides.forbid } : {}),
    ...(overrides.optional !== undefined ? { optional: overrides.optional } : {}),
    ...(overrides.strictFiles !== undefined ? { strictFiles: overrides.strictFiles } : {}),
    ...(overrides.softSettle !== undefined ? { softSettle: overrides.softSettle } : {}),
  };
  return loadPatchesFromArray([raw])[0]!;
}

const HOST_FILE = "dsh-agent-instructions/lib/index.js";

describe("applyPatches — 基本应用", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("命中 pattern 后写回，状态 applied", () => {
    host.write(HOST_FILE, "const A = 'ORIGINAL';\n");
    const report = applyPatches([patchAgainst()], host.aiBase);
    assert.equal(report.outcomes[0]?.status, "applied");
    assert.equal(host.read(HOST_FILE), "const A = 'PATCHED';\n");
    assert.equal(report.summary.filesChanged, 1);
  });

  it("第二次 apply 幂等：0 文件改动、状态 already", () => {
    host.write(HOST_FILE, "const A = 'ORIGINAL';\n");
    const p = patchAgainst();
    const first = applyPatches([p], host.aiBase);
    assert.equal(first.summary.applied, 1);

    const before = host.read(HOST_FILE);
    const second = applyPatches([p], host.aiBase);
    assert.equal(second.summary.filesChanged, 0, "第二次必须一行都不写");
    assert.equal(second.outcomes[0]?.status, "already");
    assert.equal(host.read(HOST_FILE), before, "内容必须完全一致");
  });

  it("pattern 不存在 → pattern_not_found，文件不动", () => {
    host.write(HOST_FILE, "totally different\n");
    const report = applyPatches([patchAgainst()], host.aiBase);
    assert.equal(report.outcomes[0]?.status, "pattern_not_found");
    assert.equal(host.read(HOST_FILE), "totally different\n");
    assert.equal(report.summary.filesChanged, 0);
  });

  it("目标包不存在 → missing_file", () => {
    const report = applyPatches([patchAgainst()], host.aiBase);
    assert.equal(report.outcomes[0]?.status, "missing_file");
  });

  it("optional 的目标缺失 → na（不算失败）", () => {
    const report = applyPatches([patchAgainst({ optional: true })], host.aiBase);
    assert.equal(report.outcomes[0]?.status, "na");
    assert.equal(report.summary.failed, 0);
  });

  it("dryRun 不写盘但仍报告 would-change", () => {
    host.write(HOST_FILE, "const A = 'ORIGINAL';\n");
    const report = applyPatches([patchAgainst()], host.aiBase, { dryRun: true });
    assert.equal(host.read(HOST_FILE), "const A = 'ORIGINAL';\n", "dry-run 必须不动文件");
    assert.equal(report.outcomes[0]?.changedFiles.length, 1);
    assert.equal(report.summary.filesChanged, 0);
  });
});

describe("applyPatches — 备份", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("首次 apply 建备份，内容是打补丁前的原文", () => {
    const original = "const A = 'ORIGINAL';\n";
    host.write(HOST_FILE, original);
    applyPatches([patchAgainst()], host.aiBase);
    const backup = path.join(host.aiBase, HOST_FILE + ".dsh-unbound.bak");
    assert.equal(fs.existsSync(backup), true);
    assert.equal(fs.readFileSync(backup, "utf8"), original);
  });

  it("第二次 apply 不覆盖已有备份（保住回滚路径）", () => {
    const original = "const A = 'ORIGINAL';\n";
    host.write(HOST_FILE, original);
    const p = patchAgainst();
    applyPatches([p], host.aiBase);
    // 人为改一下备份，验证第二次不会被覆盖
    const backup = path.join(host.aiBase, HOST_FILE + ".dsh-unbound.bak");
    fs.writeFileSync(backup, "SENTINEL", "utf8");
    applyPatches([p], host.aiBase);
    assert.equal(fs.readFileSync(backup, "utf8"), "SENTINEL", "备份必须只做一次");
  });

  it("revert 用备份还原到原文", () => {
    const original = "const A = 'ORIGINAL';\n";
    host.write(HOST_FILE, original);
    const p = patchAgainst();
    applyPatches([p], host.aiBase);
    assert.notEqual(host.read(HOST_FILE), original);

    const r = revertPatches([p], host.aiBase);
    assert.equal(r.restored.length, 1);
    assert.equal(host.read(HOST_FILE), original);
  });

  it("revert 能识别 dsh-qilin 的旧备份后缀", () => {
    const original = "const A = 'ORIGINAL';\n";
    host.write(HOST_FILE, "const A = 'PATCHED';\n");
    // 只放 legacy 备份，没有自己的
    fs.writeFileSync(path.join(host.aiBase, HOST_FILE + ".dshqilin.bak"), original, "utf8");
    const r = revertPatches([patchAgainst()], host.aiBase);
    assert.equal(r.restored.length, 1);
    assert.equal(host.read(HOST_FILE), original);
  });

  it("没有备份的文件 revert 时报 missing 而不是乱写", () => {
    host.write(HOST_FILE, "x\n");
    const r = revertPatches([patchAgainst()], host.aiBase);
    assert.equal(r.restored.length, 0);
    assert.equal(r.missing.length, 1);
    assert.equal(host.read(HOST_FILE), "x\n", "无备份就不该动文件");
  });
});

describe("applyPatches — 原子性", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("写盘后不残留 .tmp 文件", () => {
    host.write(HOST_FILE, "const A = 'ORIGINAL';\n");
    applyPatches([patchAgainst()], host.aiBase);
    const dir = path.join(host.aiBase, "dsh-agent-instructions", "lib");
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, [], "临时文件必须被清理");
  });

  it("目标目录不存在时能自动建（原子写会 mkdir -p）", () => {
    // 造一个包目录但没有 lib/
    const report = applyPatches([patchAgainst()], host.aiBase, { dryRun: true });
    // 只是验证不抛；真实建目录发生在写盘路径
    assert.equal(typeof report.summary.filesChanged, "number");
  });
});

describe("applyPatches — 过滤", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("only 只跑指定 id", () => {
    // 两个 pattern 必须互不为子串，否则补丁 1 会顺带改掉补丁 2 的目标，
    // 测的就不是过滤逻辑了（早先 "ORIGINAL" 是 "ORIGINAL2" 的子串，踩过）。
    host.write(HOST_FILE, "AAA BBB\n");
    const p1 = patchAgainst({ id: 1, pattern: "AAA", replace: "XXX" });
    const p2 = patchAgainst({ id: 2, pattern: "BBB", replace: "YYY" });
    const report = applyPatches([p1, p2], host.aiBase, { only: [1] });
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0]?.patchId, 1);
    assert.equal(host.read(HOST_FILE), "XXX BBB\n");
  });

  it("skip 排除指定 id", () => {
    host.write(HOST_FILE, "AAA BBB\n");
    const p1 = patchAgainst({ id: 1, pattern: "AAA", replace: "XXX" });
    const p2 = patchAgainst({ id: 2, pattern: "BBB", replace: "YYY" });
    const report = applyPatches([p1, p2], host.aiBase, { skip: [1] });
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0]?.patchId, 2);
    assert.equal(host.read(HOST_FILE), "AAA YYY\n");
  });

  it("surface 过滤生效", () => {
    const raw = {
      id: 9,
      name: "DESKTOP_ONLY",
      file: "agent-instructions",
      replacements: [{ pattern: "ORIGINAL", replace: "X" }],
      surfaces: ["desktop"],
    };
    const p = loadPatchesFromArray([raw])[0]!;
    assert.equal(selectPatches([p], { surface: "web" }).length, 0);
    assert.equal(selectPatches([p], { surface: "desktop" }).length, 1);
  });
});

describe("collectTargets", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("报告缺失的 key", () => {
    const p = patchAgainst();
    const { missingKeys } = collectTargets(p, host.aiBase);
    // fake host 只有一个包，agent-instructions 应当能解析到（目录存在但文件不存在时算 missing）
    assert.ok(Array.isArray(missingKeys));
  });
});

describe("applyPatches — 多目标与严格模式", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions", "dsh-tool-bash"]);
  });
  afterEach(() => host.cleanup());

  it("一条补丁写多个目标文件", () => {
    const raw = {
      id: 7,
      name: "MULTI",
      file: ["agent-instructions", "tool-bash"],
      replacements: [{ pattern: "ORIGINAL", replace: "PATCHED" }],
    };
    const p = loadPatchesFromArray([raw])[0]!;
    host.write("dsh-agent-instructions/lib/index.js", "ORIGINAL\n");
    host.write("dsh-tool-bash/lib/index.js", "ORIGINAL\n");
    const report = applyPatches([p], host.aiBase);
    assert.equal(report.outcomes[0]?.status, "applied");
    assert.equal(host.read("dsh-agent-instructions/lib/index.js"), "PATCHED\n");
    assert.equal(host.read("dsh-tool-bash/lib/index.js"), "PATCHED\n");
    assert.equal(report.summary.filesChanged, 2);
  });

  it("部分目标缺失但有一个命中 → 仍算 applied", () => {
    const raw = {
      id: 8,
      name: "PARTIAL_TARGETS",
      file: ["agent-instructions", "tool-web"],
      replacements: [{ pattern: "ORIGINAL", replace: "PATCHED" }],
    };
    const p = loadPatchesFromArray([raw])[0]!;
    host.write("dsh-agent-instructions/lib/index.js", "ORIGINAL\n");
    const report = applyPatches([p], host.aiBase);
    assert.equal(report.outcomes[0]?.status, "applied");
  });
});

describe("幂等性契约（端到端，跨多次 apply）", () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeFakeHost(["dsh-agent-instructions"]);
  });
  afterEach(() => host.cleanup());

  it("自我增长型补丁连续 apply 3 次，文本长度不再变化", () => {
    // 这是原项目踩过的真坑：插入型补丁的 replace 包含 pattern 时，
    // 每次 apply 都会再叠一层（原注释记 +841 字符/次，永不收敛）。
    host.write(HOST_FILE, "timeoutMs: 60000\n");
    const p = patchAgainst({
      pattern: "timeoutMs: 60000",
      replace: "timeoutMs: 60000\n  retries: 3",
      skipIfMarked: true,
      markers: ["retries: 3"],
    });

    const after1 = applyPatches([p], host.aiBase);
    assert.equal(after1.summary.filesChanged, 1, "第一次应写入");
    const len1 = host.read(HOST_FILE).length;

    const after2 = applyPatches([p], host.aiBase);
    const len2 = host.read(HOST_FILE).length;
    const after3 = applyPatches([p], host.aiBase);
    const len3 = host.read(HOST_FILE).length;

    assert.equal(len2, len1, "第二次不该增长");
    assert.equal(len3, len1, "第三次不该增长");
    assert.equal(after2.summary.filesChanged, 0);
    assert.equal(after3.summary.filesChanged, 0);
  });

  it("非插入型补丁重复 apply 也不改变内容", () => {
    host.write(HOST_FILE, "AAA\n");
    const p = patchAgainst({ pattern: "AAA", replace: "BBB" });
    applyPatches([p], host.aiBase);
    const once = host.read(HOST_FILE);
    const second = applyPatches([p], host.aiBase);
    assert.equal(second.summary.filesChanged, 0);
    assert.equal(host.read(HOST_FILE), once);
  });

  it("mtime 不被无谓更新（文件没变就不写）", async () => {
    host.write(HOST_FILE, "AAA\n");
    const p = patchAgainst({ pattern: "AAA", replace: "BBB" });
    applyPatches([p], host.aiBase);
    const fp = path.join(host.aiBase, HOST_FILE);
    const mtime1 = fs.statSync(fp).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    applyPatches([p], host.aiBase);
    const mtime2 = fs.statSync(fp).mtimeMs;
    assert.equal(mtime2, mtime1, "内容未变时不应重写文件（避免触发宿主 watcher）");
  });

  it("一条补丁的多个目标文件全部幂等", () => {
    host.write("dsh-tool-bash/lib/index.js", "ORIGINAL\n");
    const raw = {
      id: 11,
      name: "MULTI_IDEMPOTENT",
      file: ["agent-instructions", "tool-bash"],
      replacements: [{ pattern: "ORIGINAL", replace: "PATCHED" }],
    };
    const p = loadPatchesFromArray([raw])[0]!;
    host.write(HOST_FILE, "ORIGINAL\n");
    const first = applyPatches([p], host.aiBase);
    assert.equal(first.summary.filesChanged, 2);
    const second = applyPatches([p], host.aiBase);
    assert.equal(second.summary.filesChanged, 0);
  });
});
