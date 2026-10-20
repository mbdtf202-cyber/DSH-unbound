/**
 * rules 层测试（真实临时目录）。
 *
 * 规则集只改 `AGENTS.md` / `CLAUDE.md` 目标文件，不参与 system 注入链——
 * 这个分离是原实现没有、而这里明确下来的契约，测试也按它来断言。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PromptState } from "../../src/plugin/prompt-state.js";
import {
  activateRule,
  ancestorChainForCwd,
  BACKUP_SUFFIX,
  createLastCwdMemo,
  deleteRule,
  ensureInitialState,
  formatSize,
  hasRuleBackup,
  listRules,
  normalizeMeta,
  pickCwd,
  readActive,
  readCwdSelections,
  readLastCwd,
  readRule,
  readRuleMeta,
  readSelectedCwdInject,
  readWorkspacePolicy,
  resetToOriginal,
  RULE_TARGETS,
  rulesDir,
  rulesStatus,
  rulePath,
  saveRule,
  scanCwdInstructions,
  setActive,
  targetPath,
  toggleCwdSelection,
  validRuleId,
  validTarget,
  WORKSPACE_POLICIES,
  writeCwdSelections,
  writeLastCwd,
  writeRuleMeta,
  writeWorkspacePolicy,
} from "../../src/plugin/rules.js";

function makeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "w4-rules-"));
  return {
    home,
    cleanup: (): void => {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const promptState = (): PromptState => new PromptState({ bundledDefault: () => "" });

describe("id / target 校验", () => {
  it("validRuleId 接受字母数字开头 + 字母数字._-", () => {
    assert.equal(validRuleId("abc"), true);
    assert.equal(validRuleId("a-b_c.d"), true);
    assert.equal(validRuleId("1abc"), true);
  });

  it("validRuleId 拒绝空/超长/非法字符", () => {
    assert.equal(validRuleId(""), false);
    assert.equal(validRuleId("-abc"), false);
    assert.equal(validRuleId("a b"), false);
    assert.equal(validRuleId("a".repeat(65)), false);
    assert.equal(validRuleId(42), false);
  });

  it("validTarget 只认 AGENTS.md / CLAUDE.md", () => {
    assert.equal(validTarget("AGENTS.md"), true);
    assert.equal(validTarget("CLAUDE.md"), true);
    assert.equal(validTarget("OTHER.md"), false);
    assert.equal(validTarget(undefined), false);
  });

  it("RULE_TARGETS 顺序稳定（回滚按这个顺序）", () => {
    assert.deepEqual([...RULE_TARGETS], ["AGENTS.md", "CLAUDE.md"]);
  });

  it("WORKSPACE_POLICIES 三种策略", () => {
    assert.deepEqual([...WORKSPACE_POLICIES], ["fallback", "strict", "always"]);
  });
});

describe("formatSize", () => {
  it("B / KB 形态", () => {
    assert.equal(formatSize(512), "512 B");
    assert.equal(formatSize(1536), "1.5 KB");
    assert.equal(formatSize(200 * 1024), "200 KB");
  });
  it("非法回 0 B", () => {
    assert.equal(formatSize(Number.NaN), "0 B");
    assert.equal(formatSize(-5), "0 B");
  });
});

describe("normalizeMeta", () => {
  it("缺失时用 id 与 AGENTS.md", () => {
    assert.deepEqual(normalizeMeta("abc", null), { name: "abc", target: "AGENTS.md" });
  });
  it("name 被 trim 并截到 64", () => {
    const long = "x".repeat(200);
    assert.equal(normalizeMeta("id", { name: `  ${long}  ` }).name.length, 64);
  });
  it("非法 target 回落 AGENTS.md", () => {
    assert.equal(normalizeMeta("id", { target: "OTHER.md" }).target, "AGENTS.md");
  });
  it("name 为空白串时用 id", () => {
    assert.equal(normalizeMeta("id", { name: "   " }).name, "id");
  });
});

describe("元数据读写（真实磁盘）", () => {
  it("写入后可读回", async () => {
    const { home, cleanup } = makeHome();
    try {
      await writeRuleMeta(home, "a", { name: "别名", target: "CLAUDE.md" });
      assert.deepEqual(await readRuleMeta(home, "a"), { name: "别名", target: "CLAUDE.md" });
    } finally {
      cleanup();
    }
  });

  it("读不存在 → 默认元数据（不抛）", async () => {
    const { home, cleanup } = makeHome();
    try {
      assert.deepEqual(await readRuleMeta(home, "nope"), { name: "nope", target: "AGENTS.md" });
    } finally {
      cleanup();
    }
  });

  it("损坏的 JSON → 默认元数据", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(rulesDir(home), { recursive: true });
      fs.writeFileSync(path.join(rulesDir(home), "a.json"), "{ not json");
      assert.deepEqual(await readRuleMeta(home, "a"), { name: "a", target: "AGENTS.md" });
    } finally {
      cleanup();
    }
  });

  it("非法 id 写入抛错", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => writeRuleMeta(home, "", {}), /invalid rule id/);
    } finally {
      cleanup();
    }
  });
});

describe("saveRule / listRules / readRule / deleteRule", () => {
  it("保存后可读回", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则正文", { name: "A", target: "AGENTS.md" });
      assert.equal(await readRule(home, "a"), "规则正文");
      assert.deepEqual(await readRuleMeta(home, "a"), { name: "A", target: "AGENTS.md" });
    } finally {
      cleanup();
    }
  });

  it("超过 256KB 被拒", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => saveRule(home, "a", "x".repeat(300 * 1024), {}), /too large/);
    } finally {
      cleanup();
    }
  });

  it("非法 id 被拒", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => saveRule(home, "a b", "x", {}), /invalid rule id/);
    } finally {
      cleanup();
    }
  });

  it("listRules 按 id 排序，只认 .md", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "zeta", "z", {});
      await saveRule(home, "alpha", "a", {});
      fs.writeFileSync(path.join(rulesDir(home), "not-a-rule.txt"), "x");
      assert.deepEqual((await listRules(home)).map((r) => r.id), ["alpha", "zeta"]);
    } finally {
      cleanup();
    }
  });

  it("rules 目录不存在 → 空列表", async () => {
    const { home, cleanup } = makeHome();
    try {
      assert.deepEqual(await listRules(home), []);
    } finally {
      cleanup();
    }
  });

  it("目录名不是合法 id 的 .md 被忽略", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(rulesDir(home), { recursive: true });
      fs.writeFileSync(path.join(rulesDir(home), "Bad Name.md"), "x");
      assert.deepEqual(await listRules(home), []);
    } finally {
      cleanup();
    }
  });

  it("deleteRule 删掉 .md 与 .json", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "x", {});
      await deleteRule(home, "a");
      assert.equal(fs.existsSync(rulePath(home, "a")), false);
      assert.equal(fs.existsSync(path.join(rulesDir(home), "a.json")), false);
    } finally {
      cleanup();
    }
  });

  it("deleteRule 删不存在的规则不抛（ENOENT 吞掉）", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.doesNotReject(() => deleteRule(home, "nope"));
    } finally {
      cleanup();
    }
  });

  it("readRule 不存在 → null", async () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(await readRule(home, "nope"), null);
    } finally {
      cleanup();
    }
  });
});

describe("active 状态", () => {
  it("setActive / readActive 往返", async () => {
    const { home, cleanup } = makeHome();
    try {
      await setActive(home, "a");
      assert.equal(await readActive(home), "a");
    } finally {
      cleanup();
    }
  });

  it("非法 active 值被读成 null（不信任磁盘内容）", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(rulesDir(home), { recursive: true });
      fs.writeFileSync(path.join(rulesDir(home), "state.json"), JSON.stringify({ active: "a b" }));
      assert.equal(await readActive(home), null);
    } finally {
      cleanup();
    }
  });

  it("ensureInitialState 清掉指向不存在规则的 active", async () => {
    const { home, cleanup } = makeHome();
    try {
      await setActive(home, "ghost");
      assert.deepEqual(await ensureInitialState(home), { active: null });
    } finally {
      cleanup();
    }
  });

  it("ensureInitialState 保留有效 active", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "real", "x", {});
      await setActive(home, "real");
      assert.deepEqual(await ensureInitialState(home), { active: "real" });
    } finally {
      cleanup();
    }
  });
});

describe("activateRule：备份语义（关键）", () => {
  it("激活写入目标文件并记 active", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则正文", { target: "AGENTS.md" });
      const meta = await activateRule(home, "a");
      assert.equal(meta.target, "AGENTS.md");
      assert.equal(fs.readFileSync(targetPath(home, "AGENTS.md"), "utf8"), "规则正文");
      assert.equal(await readActive(home), "a");
    } finally {
      cleanup();
    }
  });

  it("目标文件原本有用户内容 → 先备份", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(targetPath(home, "AGENTS.md"), "用户原始内容");
      await saveRule(home, "a", "规则正文", {});
      await activateRule(home, "a");
      assert.equal(hasRuleBackup(home, "AGENTS.md"), true);
      assert.equal(
        fs.readFileSync(`${targetPath(home, "AGENTS.md")}${BACKUP_SUFFIX}`, "utf8"),
        "用户原始内容",
      );
    } finally {
      cleanup();
    }
  });

  it("目标文件原本就是某条规则 → 不备份（那是插件产物，不是原件）", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则 A", {});
      await saveRule(home, "b", "规则 B", {});
      await activateRule(home, "a");
      // 现在 AGENTS.md 里是「规则 A」
      await activateRule(home, "b");
      assert.equal(hasRuleBackup(home, "AGENTS.md"), false, "插件自己写的文件不该被当原件备份");
    } finally {
      cleanup();
    }
  });

  it("已有备份不覆盖（回滚路径只保留最早那份）", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(targetPath(home, "AGENTS.md"), "第一次原始");
      await saveRule(home, "a", "规则 A", {});
      await activateRule(home, "a");
      // 手动把目标文件改回用户内容，再激活一次
      fs.writeFileSync(targetPath(home, "AGENTS.md"), "第二次原始");
      await activateRule(home, "a");
      assert.equal(
        fs.readFileSync(`${targetPath(home, "AGENTS.md")}${BACKUP_SUFFIX}`, "utf8"),
        "第一次原始",
      );
    } finally {
      cleanup();
    }
  });

  it("激活不存在的规则 → 抛错", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => activateRule(home, "nope"), /rule not found/);
    } finally {
      cleanup();
    }
  });

  it("目标文件不存在时也能激活（无需备份）", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "正文", {});
      await assert.doesNotReject(() => activateRule(home, "a"));
      assert.equal(hasRuleBackup(home, "AGENTS.md"), false);
    } finally {
      cleanup();
    }
  });

  it("目标文件是 CLAUDE.md 时备份也用 CLAUDE.md", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(targetPath(home, "CLAUDE.md"), "claude 原始");
      await saveRule(home, "a", "正文", { target: "CLAUDE.md" });
      await activateRule(home, "a");
      assert.equal(hasRuleBackup(home, "CLAUDE.md"), true);
      assert.equal(hasRuleBackup(home, "AGENTS.md"), false);
    } finally {
      cleanup();
    }
  });
});

describe("resetToOriginal", () => {
  it("有备份时用备份恢复并删掉备份", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(targetPath(home, "AGENTS.md"), "原始");
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      const report = await resetToOriginal(home);
      assert.equal(report.restored.length, 1);
      assert.equal(fs.readFileSync(targetPath(home, "AGENTS.md"), "utf8"), "原始");
      assert.equal(hasRuleBackup(home, "AGENTS.md"), false);
    } finally {
      cleanup();
    }
  });

  it("无备份且目标文件内容就是规则 → 删掉目标文件", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      const report = await resetToOriginal(home);
      assert.equal(report.removed.length, 1);
      assert.equal(fs.existsSync(targetPath(home, "AGENTS.md")), false);
    } finally {
      cleanup();
    }
  });

  it("无备份但目标文件被手动改过 → 跳过（不误删用户内容）", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      fs.writeFileSync(targetPath(home, "AGENTS.md"), "用户后来改的");
      const report = await resetToOriginal(home);
      assert.equal(report.skipped.length, 1);
      assert.equal(fs.readFileSync(targetPath(home, "AGENTS.md"), "utf8"), "用户后来改的");
    } finally {
      cleanup();
    }
  });

  it("清空 active 状态", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      await resetToOriginal(home);
      assert.equal(await readActive(home), null);
    } finally {
      cleanup();
    }
  });

  it("规则库内容保留（只清状态，不删规则）", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      await resetToOriginal(home);
      assert.equal(await readRule(home, "a"), "规则");
    } finally {
      cleanup();
    }
  });
});

describe("workspace policy", () => {
  it("默认 fallback", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(readWorkspacePolicy(home), "fallback");
    } finally {
      cleanup();
    }
  });

  it("写入后可读回", async () => {
    const { home, cleanup } = makeHome();
    try {
      await writeWorkspacePolicy(home, "strict");
      assert.equal(readWorkspacePolicy(home), "strict");
    } finally {
      cleanup();
    }
  });

  it("非法策略被拒", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => writeWorkspacePolicy(home, "nope"), /invalid workspace policy/);
    } finally {
      cleanup();
    }
  });

  it("磁盘上的非法值被读成默认", () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(path.join(home, "dsh-qilin"), { recursive: true });
      fs.writeFileSync(path.join(home, "dsh-qilin", "workspace-policy.json"), JSON.stringify({ policy: "weird" }));
      assert.equal(readWorkspacePolicy(home), "fallback");
    } finally {
      cleanup();
    }
  });
});

describe("cwd 勾选", () => {
  it("写入时去重、绝对化、trim", async () => {
    const { home, cleanup } = makeHome();
    try {
      const written = await writeCwdSelections(home, ["  /a/b  ", "/a/b", "", 42, "/c"]);
      assert.deepEqual([...written], ["/a/b", "/c"]);
      assert.deepEqual([...readCwdSelections(home)], ["/a/b", "/c"]);
    } finally {
      cleanup();
    }
  });

  it("toggle 打开与关闭", async () => {
    const { home, cleanup } = makeHome();
    try {
      await toggleCwdSelection(home, "/x/y", true);
      assert.deepEqual([...readCwdSelections(home)], ["/x/y"]);
      await toggleCwdSelection(home, "/x/y", false);
      assert.deepEqual([...readCwdSelections(home)], []);
    } finally {
      cleanup();
    }
  });

  it("空路径被拒", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => toggleCwdSelection(home, "   ", true), /invalid file path/);
    } finally {
      cleanup();
    }
  });

  it("没有文件时读成空数组", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.deepEqual([...readCwdSelections(home)], []);
    } finally {
      cleanup();
    }
  });
});

describe("cwd 扫描", () => {
  it("ancestorChainForCwd 遇到 .git 停下", () => {
    const { home, cleanup } = makeHome();
    try {
      const root = path.join(home, "proj");
      const deep = path.join(root, "a", "b");
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.mkdirSync(deep, { recursive: true });
      const chain = ancestorChainForCwd(deep);
      assert.equal(chain[0], path.resolve(root), "链首应是 .git 所在目录");
      assert.equal(chain[chain.length - 1], path.resolve(deep), "链尾应是 cwd");
    } finally {
      cleanup();
    }
  });

  it("没有根标记时只扫 cwd 这一层（链长为 1）", () => {
    const { home, cleanup } = makeHome();
    try {
      // 临时目录的祖先里通常没有 .git，但为了确定，把 cwd 放在一个「无标记」的新目录下
      const bare = path.join(home, "bare");
      fs.mkdirSync(bare, { recursive: true });
      const chain = ancestorChainForCwd(bare);
      // 可能因为上层目录恰好有 .git 而变长，所以只断言 cwd 在末尾
      assert.equal(chain[chain.length - 1], path.resolve(bare));
    } finally {
      cleanup();
    }
  });

  it("空 cwd → 空链", () => {
    assert.deepEqual(ancestorChainForCwd(""), []);
  });

  it("扫描命中四个候选文件名，scope 分类正确", () => {
    const { home, cleanup } = makeHome();
    try {
      const root = path.join(home, "proj");
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "AGENTS.md"), "# root agents");
      const leaf = path.join(root, "sub");
      fs.mkdirSync(leaf, { recursive: true });
      fs.writeFileSync(path.join(leaf, "CLAUDE.local.md"), "# leaf claude");
      const found = scanCwdInstructions(leaf);
      const byName = new Map(found.map((c) => [c.name, c]));
      assert.equal(byName.get("AGENTS.md")?.scope, "root");
      assert.equal(byName.get("CLAUDE.local.md")?.scope, "cwd");
    } finally {
      cleanup();
    }
  });

  it("预览被压成单行且截到 160", () => {
    const { home, cleanup } = makeHome();
    try {
      const dir = path.join(home, "p");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "第一行\n\n第二行  有很多   空格" + "x".repeat(400));
      const found = scanCwdInstructions(dir).find((c) => c.name === "AGENTS.md");
      assert.notEqual(found, undefined);
      assert.equal((found?.preview ?? "").includes("\n"), false);
      assert.equal((found?.preview ?? "").length <= 160, true);
    } finally {
      cleanup();
    }
  });

  it("空 cwd → 空结果", () => {
    assert.deepEqual([...scanCwdInstructions("")], []);
  });
});

describe("readSelectedCwdInject", () => {
  it("只注入「仍在当前扫描结果里」的勾选文件（防跨目录穿越）", async () => {
    const { home, cleanup } = makeHome();
    try {
      const dir = path.join(home, "p");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "AGENTS.md");
      fs.writeFileSync(target, "本地规则");
      await writeCwdSelections(home, [target, "/somewhere/else/AGENTS.md"]);
      const inject = readSelectedCwdInject(home, dir);
      assert.match(inject, /本地规则/);
      assert.equal(inject.includes("elsewhere"), false);
    } finally {
      cleanup();
    }
  });

  it("没有勾选 → 空串", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(readSelectedCwdInject(home, home), "");
    } finally {
      cleanup();
    }
  });

  it("勾选文件被删除 → 跳过（不抛）", async () => {
    const { home, cleanup } = makeHome();
    try {
      const dir = path.join(home, "p");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "AGENTS.md");
      fs.writeFileSync(target, "x");
      await writeCwdSelections(home, [target]);
      fs.rmSync(target);
      assert.equal(readSelectedCwdInject(home, dir), "");
    } finally {
      cleanup();
    }
  });

  it("带 dsh-unbound 标记头", async () => {
    const { home, cleanup } = makeHome();
    try {
      const dir = path.join(home, "p");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, "AGENTS.md");
      fs.writeFileSync(target, "内容");
      await writeCwdSelections(home, [target]);
      assert.match(readSelectedCwdInject(home, dir), /<!-- dsh-unbound:cwd-rule AGENTS\.md -->/);
    } finally {
      cleanup();
    }
  });
});

describe("last cwd 记账", () => {
  it("writeLastCwd 写入后可读", () => {
    const { home, cleanup } = makeHome();
    try {
      const memo = createLastCwdMemo();
      writeLastCwd(home, "/tmp/a", memo);
      assert.equal(readLastCwd(home), path.normalize("/tmp/a").trim());
    } finally {
      cleanup();
    }
  });

  it("同一个 cwd 第二次不重写（进程内去重，防每秒 7~9 次写盘）", () => {
    const { home, cleanup } = makeHome();
    try {
      const memo = createLastCwdMemo();
      writeLastCwd(home, "/tmp/a", memo);
      const stat1 = fs.statSync(path.join(home, "dsh-qilin", "last-cwd.txt")).mtimeMs;
      // 记下 mtime 后立刻再写一次（同一 cwd）
      const before = Date.now();
      writeLastCwd(home, "/tmp/a", memo);
      const stat2 = fs.statSync(path.join(home, "dsh-qilin", "last-cwd.txt")).mtimeMs;
      assert.equal(stat2, stat1, "相同 cwd 不该重写文件");
      assert.ok(Date.now() - before >= 0);
    } finally {
      cleanup();
    }
  });

  it("cwd 变化时会重写", () => {
    const { home, cleanup } = makeHome();
    try {
      const memo = createLastCwdMemo();
      writeLastCwd(home, "/tmp/a", memo);
      writeLastCwd(home, "/tmp/b", memo);
      assert.equal(readLastCwd(home), path.normalize("/tmp/b").trim());
    } finally {
      cleanup();
    }
  });

  it("空 cwd 不写", () => {
    const { home, cleanup } = makeHome();
    try {
      const memo = createLastCwdMemo();
      writeLastCwd(home, "   ", memo);
      assert.equal(readLastCwd(home), "");
    } finally {
      cleanup();
    }
  });

  it("pickCwd 优先 hint，其次 last", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(pickCwd(home, "/tmp/hint"), path.resolve("/tmp/hint"));
      const memo = createLastCwdMemo();
      writeLastCwd(home, "/tmp/last", memo);
      assert.equal(pickCwd(home), path.resolve("/tmp/last"));
    } finally {
      cleanup();
    }
  });

  it("没有 last 也没有 hint → 空串", () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(pickCwd(home), "");
    } finally {
      cleanup();
    }
  });
});

describe("rulesStatus：状态快照", () => {
  it("没有规则时给出完整结构", async () => {
    const { home, cleanup } = makeHome();
    try {
      const status = await rulesStatus(home, promptState());
      assert.deepEqual([...status.rules], []);
      assert.equal(status.active, null);
      assert.equal(status.injectSource, "none");
      assert.equal(status.active_target, null);
      assert.equal(status.agents_exists, false);
      assert.equal(status.agents_synced, false);
      assert.deepEqual([...status.workspace_policies], [...WORKSPACE_POLICIES]);
    } finally {
      cleanup();
    }
  });

  it("激活后 agents_synced = true", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      const status = await rulesStatus(home, promptState());
      assert.equal(status.active, "a");
      assert.equal(status.agents_exists, true);
      assert.equal(status.agents_synced, true);
      assert.equal(status.active_target, "AGENTS.md");
    } finally {
      cleanup();
    }
  });

  it("目标文件被改过 → agents_synced = false", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveRule(home, "a", "规则", {});
      await activateRule(home, "a");
      fs.writeFileSync(targetPath(home, "AGENTS.md"), "别的");
      assert.equal((await rulesStatus(home, promptState())).agents_synced, false);
    } finally {
      cleanup();
    }
  });

  it("injectSource 反映 prompt-inject.md", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.writeFileSync(path.join(home, "prompt-inject.md"), "我的提示词");
      const status = await rulesStatus(home, promptState());
      assert.equal(status.injectSource, "prompt");
    } finally {
      cleanup();
    }
  });

  it("cwd 候选带 selected 标记", async () => {
    const { home, cleanup } = makeHome();
    try {
      const dir = path.join(home, "p");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "AGENTS.md");
      fs.writeFileSync(file, "x");
      await writeCwdSelections(home, [file]);
      const status = await rulesStatus(home, promptState(), dir);
      const candidate = status.cwd_candidates.find((c) => c.name === "AGENTS.md");
      assert.equal(candidate?.selected, true);
    } finally {
      cleanup();
    }
  });
});
