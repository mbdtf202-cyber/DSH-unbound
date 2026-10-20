/**
 * 迁移期校验工具：`skill-fixes.ts` 的文案是否与原 JS 逐字一致。
 *
 * ## 这不是 CI 的一部分
 *
 * 它只在**迁移期间**有用：517 行几乎全是给用户看的文案（可直接粘贴执行的命令），
 * 改写一个字符用户照跑就会失败。靠眼力核对必然漏，而在测试里抄 159 条断言
 * 会变成维护负担（原实现改一个字就要改测试）。
 *
 * 一次性脚本 + 少量行为断言，是成本与保真的最优解。
 *
 * ## 什么时候重跑
 *
 * - 要修改 `src/platform/skill-fixes.ts` 的文案时
 * - 怀疑迁移引入偏差时
 *
 * 用法：
 *   npx tsc -p tsconfig.test.json
 *   node scripts/verify-skill-fixes.mjs
 *
 * 需要原项目位于 `../dsh-qilin`（与本仓库同级）。
 */
const orig = await import("../../dsh-qilin/lib/redteam/skill-fixes.js");
const mine = await import("../dist-test/src/platform/skill-fixes.js");

const diffs = [];
function cmp(label, a, b) {
  if (a === b) return;
  diffs.push({ label, orig: a, mine: b });
}

// TOOL_FIXES
const oKeys = Object.keys(orig.TOOL_FIXES).sort();
const mKeys = Object.keys(mine.TOOL_FIXES).sort();
cmp("TOOL_FIXES keys", JSON.stringify(oKeys), JSON.stringify(mKeys));
for (const k of oKeys) {
  cmp(`TOOL_FIXES.${k}.what`, orig.TOOL_FIXES[k].what, mine.TOOL_FIXES[k]?.what);
  cmp(`TOOL_FIXES.${k}.install`, orig.TOOL_FIXES[k].install, mine.TOOL_FIXES[k]?.install);
}
// SKILL_FIXES
const osK = Object.keys(orig.SKILL_FIXES).sort();
const msK = Object.keys(mine.SKILL_FIXES).sort();
cmp("SKILL_FIXES keys", JSON.stringify(osK), JSON.stringify(msK));
for (const k of osK) cmp(`SKILL_FIXES.${k}`, orig.SKILL_FIXES[k], mine.SKILL_FIXES[k]);

// toolNameOfPath 行为
const pathCases = [
  "$DSH_HOME/redteam/toolkit/fscan/fscan", "$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64",
  "~/.local/bin/xxx", "/usr/bin/nuclei", "/usr/share/wordlists/rockyou.txt",
  "fscan_windows_x64.exe", "gogo_linux_arm64", "清单.md", "", "impacket-wmiexec",
  "/opt/tools/bin/godzilla.jar", "x", "..", "./foo", "a b c",
];
for (const p of pathCases) cmp(`toolNameOfPath(${JSON.stringify(p)})`, orig.toolNameOfPath(p), mine.toolNameOfPath(p));

// fixesForIssue 各分支
const issueCases = [
  { kind: "path-missing", skill: "s", paths: ["$DSH_HOME/redteam/toolkit/fscan/fscan"] },
  { kind: "path-missing", skill: "s", paths: ["$DSH_HOME/redteam/toolkit/unknown-tool/x"] },
  { kind: "path-missing", skill: "s", paths: "single/string" },
  { kind: "env-missing", skill: "s", env: ["FOFA_KEY"] },
  { kind: "env-missing", skill: "s", env: ["SOMETHING_ELSE"] },
  { kind: "placeholder", skill: "s", placeholder: "VPS 地址" },
  { kind: "shadowed", skill: "some-skill" },
  { kind: "file-stale", skill: "s" },
  { kind: "file-missing", skill: "s" },
  { kind: "content-missing", skill: "s" },
  { kind: "unknown-kind", skill: "redteam-setup" },
  { skill: "redteam-setup" },
  { kind: "env-missing" },
];
for (const iss of issueCases) {
  cmp(`fixesForIssue(${JSON.stringify(iss)})`, orig.fixesForIssue(iss), mine.fixesForIssue(iss));
}
console.log(diffs.length === 0 ? "✅ 全部逐字一致" : "❌ 有差异：");
if (diffs.length !== 0) process.exitCode = 1;
for (const d of diffs.slice(0, 8)) console.log(" -", d.label, "\n   orig:", JSON.stringify(d.orig)?.slice(0,160), "\n   mine:", JSON.stringify(d.mine)?.slice(0,160));
console.log("diffs:", diffs.length, "| checks:", oKeys.length*2 + osK.length + pathCases.length + issueCases.length);
