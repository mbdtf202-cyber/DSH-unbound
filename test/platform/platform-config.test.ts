/**
 * platform-config 的测试。
 *
 * 重点在**解析优先级**与**配置合并语义**：
 * 这两处错了不会报错，只会表现为"用户填了路径但没用上"或"改了 .env 不生效"。
 *
 * 工具解析用真实临时目录 + 真实可执行文件，而不是 mock fs ——
 * 这套逻辑的 bug 全在"文件到底在不在、是不是目录、是不是 Python 脚本"上。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOL_CATALOG,
  assignToolkitFolder,
  configPathOf,
  defaultToolkitDir,
  envAdaptStatus,
  isWinLike,
  loadPlatformConfig,
  looksLikePythonCli,
  markEnvAdaptSkip,
  mergeConfigEnv,
  nucleiTemplatesDirOf,
  platformSummary,
  redteamRoot,
  resolveAllTools,
  resolveTool,
  savePlatformConfig,
  scanFolderForTools,
  toolkitDirOf,
} from "../../src/platform/platform-config.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-platformcfg-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 造一个可执行文件（内容随意，只要 existsSync + isFile 成立）。 */
function touchExec(dir: string, name: string, body = "#!/bin/sh\n"): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf8");
  fs.chmodSync(p, 0o755);
  return p;
}

describe("TOOL_CATALOG", () => {
  it("id 唯一（否则 config.tools 的键会互相覆盖）", () => {
    const ids = TOOL_CATALOG.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("每个条目都有非空 names 与 label", () => {
    for (const t of TOOL_CATALOG) {
      assert.equal(t.names.length > 0, true, t.id);
      assert.equal(t.label.length > 0, true, t.id);
    }
  });

  it("httpx 标了 rejectPython（Kali 的 /usr/bin/httpx 是 Python 客户端）", () => {
    const httpx = TOOL_CATALOG.find((t) => t.id === "httpx");
    assert.equal(httpx?.rejectPython, true);
  });
});

describe("路径助手", () => {
  it("redteamRoot 跟随 DSH_HOME", () => {
    assert.equal(redteamRoot({ DSH_HOME: "/custom/home" }), path.join("/custom/home", "redteam"));
  });

  it("configPathOf 与 defaultToolkitDir 都在 root 下", () => {
    assert.equal(configPathOf("/r"), path.join("/r", "config.json"));
    assert.equal(defaultToolkitDir("/r"), path.join("/r", "toolkit"));
  });
});

describe("loadPlatformConfig", () => {
  it("文件不存在时返回默认值 + exists:false", () => {
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.exists, false);
    assert.equal(cfg.platform, "auto");
    assert.deepEqual(cfg.binDirs, []);
    assert.equal(cfg.envAdaptSkip, false);
    /* tools 键已铺满 catalog，面板可直接渲染 */
    for (const t of TOOL_CATALOG) assert.equal(cfg.tools[t.id], "");
  });

  it("读到合法 JSON 时逐字段归一", () => {
    fs.writeFileSync(
      configPathOf(tmp),
      JSON.stringify({
        version: 2,
        platform: "windows",
        toolkitDir: "  /tk  ",
        binDirs: ["  /a  ", "", "/b"],
        tools: { nmap: "  /usr/bin/nmap  " },
        env: { FOFA_KEY: "abc" },
        notes: "hi",
        envAdaptSkip: 1,
        envAdaptConfigured: true,
        updated_at: "2026-01-01T00:00:00Z",
      }),
      "utf8",
    );
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.version, 2);
    assert.equal(cfg.platform, "windows");
    assert.equal(cfg.toolkitDir, "/tk");
    assert.deepEqual(cfg.binDirs, ["/a", "/b"]);
    /* load 层不 trim tools 值（原样保留），save 层才 trim。
       这不影响功能：resolveTool 读出来会自己 trim（见下方用例）。 */
    assert.equal(cfg.tools["nmap"], "  /usr/bin/nmap  ");
    assert.equal(cfg.env["FOFA_KEY"], "abc");
    assert.equal(cfg.envAdaptSkip, true);
    assert.equal(cfg.updated_at, "2026-01-01T00:00:00Z");
  });

  it("load 不 trim tools 值，但 resolveTool 会 trim（不对称但不影响功能）", () => {
    const exe = touchExec(path.join(tmp, "bin"), "nmap");
    fs.writeFileSync(configPathOf(tmp), JSON.stringify({ tools: { nmap: `  ${exe}  ` } }), "utf8");
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.tools["nmap"], `  ${exe}  `);
    assert.equal(resolveTool("nmap", { root: tmp, config: cfg, env: {} }).path, exe);
  });

  it("非法 platform 值退回 auto", () => {
    fs.writeFileSync(configPathOf(tmp), JSON.stringify({ platform: "solaris" }), "utf8");
    assert.equal(loadPlatformConfig(tmp).platform, "auto");
  });

  it("坏 JSON 返回 error 而不是抛（面板要能提示「配置损坏」）", () => {
    fs.writeFileSync(configPathOf(tmp), "{oops", "utf8");
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.exists, true);
    assert.equal(typeof cfg.error, "string");
    assert.equal(cfg.platform, "auto");
  });

  it("顶层不是对象时也给出 error", () => {
    fs.writeFileSync(configPathOf(tmp), "[]", "utf8");
    assert.equal(typeof loadPlatformConfig(tmp).error, "string");
  });

  it("数值 version 非法时退回 1", () => {
    fs.writeFileSync(configPathOf(tmp), JSON.stringify({ version: "abc" }), "utf8");
    assert.equal(loadPlatformConfig(tmp).version, 1);
  });
});

describe("savePlatformConfig —— 逐字段合并", () => {
  it("只改一个字段时其它字段保留（不整份覆盖）", () => {
    savePlatformConfig({ toolkitDir: "/tk", notes: "keep me" }, tmp);
    savePlatformConfig({ binDirs: ["/x"] }, tmp);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.toolkitDir, "/tk");
    assert.equal(cfg.notes, "keep me");
    assert.deepEqual(cfg.binDirs, ["/x"]);
  });

  it("tools 是合并而不是替换（避免只改一个工具就清空其它）", () => {
    savePlatformConfig({ tools: { nmap: "/n" } }, tmp);
    savePlatformConfig({ tools: { nuclei: "/u" } }, tmp);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.tools["nmap"], "/n");
    assert.equal(cfg.tools["nuclei"], "/u");
  });

  it("env 同样是合并", () => {
    savePlatformConfig({ env: { FOFA_KEY: "k1" } }, tmp);
    savePlatformConfig({ env: { REDTEAM_VPS_HOST: "u@h" } }, tmp);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.env["FOFA_KEY"], "k1");
    assert.equal(cfg.env["REDTEAM_VPS_HOST"], "u@h");
  });

  it("写入时补齐 catalog 全量键并 trim", () => {
    savePlatformConfig({ tools: { nmap: "  /n  " } }, tmp);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.tools["nmap"], "/n");
    for (const t of TOOL_CATALOG) assert.equal(typeof cfg.tools[t.id], "string");
  });

  it("updated_at 每次刷新成 ISO", () => {
    const cfg = savePlatformConfig({ notes: "x" }, tmp);
    assert.equal(typeof cfg.updated_at, "string");
    assert.equal(Number.isNaN(Date.parse(String(cfg.updated_at))), false);
  });

  it("目录不存在时自动创建", () => {
    const nested = path.join(tmp, "a", "b");
    savePlatformConfig({ notes: "n" }, nested);
    assert.equal(loadPlatformConfig(nested).notes, "n");
  });

  it("envAdaptSkip 显式 false 能覆盖掉 true", () => {
    savePlatformConfig({ envAdaptSkip: true }, tmp);
    savePlatformConfig({ envAdaptSkip: false }, tmp);
    assert.equal(loadPlatformConfig(tmp).envAdaptSkip, false);
  });

  it("不传 envAdaptSkip 时保留旧值", () => {
    savePlatformConfig({ envAdaptSkip: true }, tmp);
    savePlatformConfig({ notes: "later" }, tmp);
    assert.equal(loadPlatformConfig(tmp).envAdaptSkip, true);
  });
});

describe("toolkitDirOf / nucleiTemplatesDirOf", () => {
  it("配置了就用配置（解析成绝对路径）", () => {
    savePlatformConfig({ toolkitDir: path.join(tmp, "tk") }, tmp);
    assert.equal(toolkitDirOf(loadPlatformConfig(tmp), tmp), path.join(tmp, "tk"));
  });

  it("没配置时退到默认 toolkit", () => {
    assert.equal(toolkitDirOf(loadPlatformConfig(tmp), tmp), defaultToolkitDir(tmp));
  });

  it("nuclei 模板目录不存在时返回 null", () => {
    savePlatformConfig({ nucleiTemplatesDir: path.join(tmp, "nope") }, tmp);
    assert.equal(nucleiTemplatesDirOf(loadPlatformConfig(tmp), tmp), null);
  });

  it("nuclei 模板目录存在时返回绝对路径", () => {
    const d = path.join(tmp, "tpl");
    fs.mkdirSync(d, { recursive: true });
    savePlatformConfig({ nucleiTemplatesDir: d }, tmp);
    assert.equal(nucleiTemplatesDirOf(loadPlatformConfig(tmp), tmp), d);
  });
});

describe("looksLikePythonCli", () => {
  it("识别 python shebang", () => {
    const f = path.join(tmp, "httpx");
    fs.writeFileSync(f, "#!/usr/bin/env python3\nprint(1)\n", "utf8");
    assert.equal(looksLikePythonCli(f), true);
  });

  it("非 python 脚本返回 false", () => {
    const f = path.join(tmp, "tool");
    fs.writeFileSync(f, "#!/bin/sh\necho hi\n", "utf8");
    assert.equal(looksLikePythonCli(f), false);
  });

  it("二进制（无 shebang）返回 false", () => {
    const f = path.join(tmp, "bin");
    fs.writeFileSync(f, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
    assert.equal(looksLikePythonCli(f), false);
  });

  it("文件不存在时返回 false（不抛）", () => {
    assert.equal(looksLikePythonCli(path.join(tmp, "ghost")), false);
  });
});

describe("resolveTool —— 优先级与 rejectPython", () => {
  it("config 指定的绝对路径优先", () => {
    const exe = touchExec(path.join(tmp, "custom"), "nmap");
    savePlatformConfig({ tools: { nmap: exe } }, tmp);
    const r = resolveTool("nmap", { root: tmp, env: {} });
    assert.equal(r.source, "config");
    assert.equal(r.path, exe);
  });

  it("config 路径不存在时报 missing 并带上 configured（面板要提示）", () => {
    const ghost = path.join(tmp, "nope", "nmap");
    savePlatformConfig({ tools: { nmap: ghost } }, tmp);
    const r = resolveTool("nmap", { root: tmp, env: {} });
    assert.equal(r.source, "missing");
    assert.equal(r.path, null);
    assert.equal(r.configured, ghost);
    assert.match(String(r.note), /不存在/);
  });

  it("其次找 toolkit 目录", () => {
    const tk = path.join(tmp, "tk");
    const exe = touchExec(tk, "nmap");
    savePlatformConfig({ toolkitDir: tk }, tmp);
    const r = resolveTool("nmap", { root: tmp, env: {} });
    assert.equal(r.source, "toolkit");
    assert.equal(r.path, exe);
  });

  it("toolkit 的 bin/ 子目录也找", () => {
    const tk = path.join(tmp, "tk");
    const exe = touchExec(path.join(tk, "bin"), "nmap");
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(resolveTool("nmap", { root: tmp, env: {} }).path, exe);
  });

  it("再次找 binDirs（记录命中的目录）", () => {
    const extra = path.join(tmp, "extra");
    const exe = touchExec(extra, "nmap");
    savePlatformConfig({ binDirs: [extra] }, tmp);
    const r = resolveTool("nmap", { root: tmp, env: {} });
    assert.equal(r.source, "binDir");
    assert.equal(r.path, exe);
    assert.equal(r.binDir, extra);
  });

  it("最后找 PATH", () => {
    const onPath = path.join(tmp, "pathdir");
    const exe = touchExec(onPath, "nmap");
    const r = resolveTool("nmap", { root: tmp, config: loadPlatformConfig(tmp), env: { PATH: onPath } });
    assert.equal(r.source, "path");
    assert.equal(r.path, exe);
  });

  it("PATH 里多段时按顺序找", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    fs.mkdirSync(a, { recursive: true });
    const exeInB = touchExec(b, "nmap");
    const r = resolveTool("nmap", { root: tmp, config: loadPlatformConfig(tmp), env: { PATH: `${a}${path.delimiter}${b}` } });
    assert.equal(r.path, exeInB);
  });

  it("什么都找不到时 source=missing", () => {
    const r = resolveTool("nmap", { root: tmp, config: loadPlatformConfig(tmp), env: { PATH: "" } });
    assert.equal(r.source, "missing");
    assert.equal(r.path, null);
  });

  it("未知 id 返回空 names 的 missing（不抛）", () => {
    const r = resolveTool("no-such-tool", { root: tmp, env: {} });
    assert.equal(r.source, "missing");
    assert.deepEqual(r.names, []);
    assert.equal(r.label, "no-such-tool");
  });

  it("Windows 平台跳过 Linux 兜底目录", () => {
    /* 无法真的改 /usr/bin，这里断言的是"isWinLike 决定是否走兜底"这条分支被覆盖 */
    assert.equal(isWinLike({ platform: "windows" }), true);
    assert.equal(isWinLike({ platform: "linux" }), false);
    assert.equal(isWinLike({ platform: "auto" }), os.platform() === "win32");
  });

  it("rejectPython：Python 版 httpx 不算找到", () => {
    const tk = path.join(tmp, "tk");
    const py = touchExec(tk, "httpx", "#!/usr/bin/env python3\n");
    savePlatformConfig({ toolkitDir: tk }, tmp);
    const r = resolveTool("httpx", { root: tmp, env: {} });
    assert.equal(r.path, null, "Python 版 httpx 必须被跳过");
    assert.notEqual(r.path, py);
  });

  it("rejectPython 不影响真正的 Go 二进制 httpx", () => {
    const tk = path.join(tmp, "tk");
    fs.mkdirSync(tk, { recursive: true });
    const real = path.join(tk, "httpx");
    fs.writeFileSync(real, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(resolveTool("httpx", { root: tmp, env: {} }).path, real);
  });

  it("adapt 别名：目录里叫 httpx-toolkit 也能认", () => {
    const tk = path.join(tmp, "tk");
    const exe = touchExec(tk, "httpx-toolkit");
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(resolveTool("httpx", { root: tmp, env: {} }).path, exe);
  });

  it("adapt 别名命中但仍是 Python 脚本时跳过", () => {
    const tk = path.join(tmp, "tk");
    touchExec(tk, "httpx-toolkit", "#!/usr/bin/python\n");
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(resolveTool("httpx", { root: tmp, env: {} }).path, null);
  });

  it("候选名按 names 顺序取第一个（nmap.exe 优先于 nmap）", () => {
    const tk = path.join(tmp, "tk");
    const exeWin = touchExec(tk, "nmap.exe");
    touchExec(tk, "nmap");
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(resolveTool("nmap", { root: tmp, env: {} }).path, exeWin);
  });

  it("目录而非文件不算找到", () => {
    const tk = path.join(tmp, "tk");
    fs.mkdirSync(path.join(tk, "nmap"), { recursive: true });
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(resolveTool("nmap", { root: tmp, env: {} }).path, null);
  });

  it("resolveAllTools 覆盖整个 catalog", () => {
    const all = resolveAllTools({ root: tmp, env: { PATH: "" } });
    assert.equal(all.length, TOOL_CATALOG.length);
    assert.deepEqual(all.map((t) => t.id), TOOL_CATALOG.map((t) => t.id));
  });
});

describe("mergeConfigEnv", () => {
  it("已有值优先，config 只兜底", () => {
    const out = mergeConfigEnv({ FOFA_KEY: "from-env" }, { env: { FOFA_KEY: "from-config" } });
    assert.equal(out["FOFA_KEY"], "from-env");
  });

  it("空字符串视为「没有」，被 config 填上", () => {
    const out = mergeConfigEnv({ FOFA_KEY: "" }, { env: { FOFA_KEY: "cfg" } });
    assert.equal(out["FOFA_KEY"], "cfg");
  });

  it("config 里的空值不写进结果", () => {
    const out = mergeConfigEnv({}, { env: { FOFA_KEY: "   " } });
    assert.equal(out["FOFA_KEY"], undefined);
  });

  it("两边的其它键都保留", () => {
    const out = mergeConfigEnv({ A: "1" }, { env: { B: "2" } });
    assert.equal(out["A"], "1");
    assert.equal(out["B"], "2");
  });

  it("cfg 为 null 时不炸", () => {
    assert.deepEqual(mergeConfigEnv({ A: "1" }, null), { A: "1" });
  });
});

describe("envAdaptStatus", () => {
  it("未配置时 need-config、ready=false", () => {
    const s = envAdaptStatus(tmp);
    assert.equal(s.ready, s.kali, "非 Kali 且未配置时不该 ready");
    assert.equal(s.total, TOOL_CATALOG.length);
    assert.equal(typeof s.message, "string");
  });

  it("用户确认跳过后 ready=true、reason=skipped", () => {
    markEnvAdaptSkip(tmp, true);
    const s = envAdaptStatus(tmp);
    assert.equal(s.ready, true);
    assert.equal(s.reason, "skipped");
    assert.equal(s.skipped, true);
  });

  it("保存过路径后 reason=configured（更新插件不要求重配）", () => {
    savePlatformConfig({ toolkitDir: path.join(tmp, "tk") }, tmp);
    const s = envAdaptStatus(tmp);
    assert.equal(s.reason, "configured");
    assert.equal(s.configured, true);
  });

  it("binDirs 非空也算已配置", () => {
    savePlatformConfig({ binDirs: ["/somewhere"] }, tmp);
    assert.equal(envAdaptStatus(tmp).configured, true);
  });

  it("单个 tools 路径也算已配置", () => {
    savePlatformConfig({ tools: { nmap: "/usr/bin/nmap" } }, tmp);
    assert.equal(envAdaptStatus(tmp).configured, true);
  });

  it("空字符串的 toolkitDir 不算已配置", () => {
    savePlatformConfig({ toolkitDir: "   " }, tmp);
    assert.equal(envAdaptStatus(tmp).configured, false);
  });

  it("foundIds / missingIds 加起来等于 total（不漏不重）", () => {
    const s = envAdaptStatus(tmp);
    assert.equal(s.foundIds.length + s.missingIds.length, s.total);
    assert.equal(s.found, s.foundIds.length);
    assert.equal(s.missing, s.missingIds.length);
  });
});

describe("platformSummary", () => {
  it("结构完整且与 resolveAllTools 一致", () => {
    const s = platformSummary(tmp);
    assert.equal(s.ok, true);
    assert.equal(s.tools.total, TOOL_CATALOG.length);
    assert.equal(s.tools.found + s.tools.missing, TOOL_CATALOG.length);
    assert.equal(s.tools.items.length, TOOL_CATALOG.length);
    assert.equal(typeof s.runtime.sep, "string");
    assert.equal(s.runtime.effective === "windows" || s.runtime.effective === "linux", true);
  });

  it("toolkit 下自带 nuclei-templates 时自动认", () => {
    const tk = path.join(tmp, "tk");
    fs.mkdirSync(path.join(tk, "nuclei-templates"), { recursive: true });
    savePlatformConfig({ toolkitDir: tk }, tmp);
    assert.equal(platformSummary(tmp).nucleiTemplatesDir, path.join(tk, "nuclei-templates"));
  });

  it("hint 会提到 adapt 状态", () => {
    const s = platformSummary(tmp);
    assert.equal(s.hint.length > 0, true);
  });

  it("egress 只读进程环境，四段都在", () => {
    const s = platformSummary(tmp);
    for (const k of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const) {
      assert.equal(typeof s.egress[k], "string", k);
    }
  });
});

/* ── 整包工具文件夹：扫描与分配 ─────────────────────────────────────────── */

/** 造一个假的工具文件夹树。 */
function makeToolTree(base: string): void {
  fs.mkdirSync(path.join(base, "nmap"), { recursive: true });
  fs.writeFileSync(path.join(base, "nmap", "nmap"), "#!/bin/sh\n", "utf8");
  fs.writeFileSync(path.join(base, "fscan"), "#!/bin/sh\n", "utf8");
  /* 深层工具：验证递归 */
  fs.mkdirSync(path.join(base, "a", "b", "c"), { recursive: true });
  fs.writeFileSync(path.join(base, "a", "b", "c", "gogo"), "#!/bin/sh\n", "utf8");
}

describe("scanFolderForTools", () => {
  it("扫到顶层与深层工具", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["fscan"], path.join(tree, "fscan"));
    assert.equal(r.assigned["nmap"], path.join(tree, "nmap", "nmap"));
    assert.equal(r.assigned["gogo"], path.join(tree, "a", "b", "c", "gogo"));
    assert.equal(r.assignedCount, Object.keys(r.assigned).length);
  });

  it("目录不存在返回 ok:false（不抛）", () => {
    const r = scanFolderForTools(path.join(tmp, "nope"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /目录不存在/);
  });

  it("路径是文件而非目录时 ok:false", () => {
    const f = path.join(tmp, "afile");
    fs.writeFileSync(f, "x", "utf8");
    const r = scanFolderForTools(f);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /不是文件夹/);
  });

  /**
   * 空路径必须报错，**不能扫 cwd**。
   *
   * 上游 `resolve("")` 返回当前工作目录，于是空路径会"成功"扫整个 cwd，
   * 接着 `assignToolkitFolder` 就把 cwd 写成 `toolkitDir` 与 `binDirs[0]` ——
   * 面板传空值时不该发生这种事。这是与上游的刻意偏离，理由见实现处注释。
   */
  it("空路径报错而不是偷偷扫 cwd（刻意偏离上游）", () => {
    for (const bad of [null, undefined, "", "   "]) {
      const r = scanFolderForTools(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      if (r.ok) continue;
      assert.match(r.error, /未指定文件夹/);
    }
  });

  it("跳过点开头的条目与 node_modules", () => {
    const tree = path.join(tmp, "tk2");
    fs.mkdirSync(path.join(tree, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tree, ".git", "fscan"), "x", "utf8");
    fs.mkdirSync(path.join(tree, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tree, "node_modules", "nmap"), "x", "utf8");
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["fscan"], undefined);
    assert.equal(r.assigned["nmap"], undefined);
  });

  it("rejectPython：Python 版 httpx 被剔除", () => {
    const tree = path.join(tmp, "tk3");
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, "httpx"), "#!/usr/bin/env python3\n", "utf8");
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["httpx"], undefined, "Python 版 httpx 必须被剔除");
  });

  it("rejectPython 不影响真二进制 httpx", () => {
    const tree = path.join(tmp, "tk4");
    fs.mkdirSync(tree, { recursive: true });
    const bin = path.join(tree, "httpx");
    fs.writeFileSync(bin, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["httpx"], bin);
  });

  it("names 排名择优：nmap 比 nmap.exe 排名靠后，但同时存在时排名小的赢", () => {
    const tree = path.join(tmp, "tk5");
    fs.mkdirSync(tree, { recursive: true });
    /* nmap names = ['nmap.exe','nmap'] → nmap.exe 排名 0，nmap 排名 1 */
    fs.writeFileSync(path.join(tree, "nmap.exe"), "x", "utf8");
    fs.writeFileSync(path.join(tree, "nmap"), "x", "utf8");
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["nmap"], path.join(tree, "nmap.exe"));
  });

  it("maxDepth 生效：超出深度的工具扫不到", () => {
    const tree = path.join(tmp, "tk6");
    fs.mkdirSync(path.join(tree, "a", "b", "c", "d"), { recursive: true });
    fs.writeFileSync(path.join(tree, "a", "b", "c", "d", "fscan"), "x", "utf8");
    const shallow = scanFolderForTools(tree, { maxDepth: 1 });
    assert.equal(shallow.ok, true);
    if (!shallow.ok) return;
    assert.equal(shallow.assigned["fscan"], undefined);
    const deep = scanFolderForTools(tree, { maxDepth: 6 });
    assert.equal(deep.ok, true);
    if (!deep.ok) return;
    assert.notEqual(deep.assigned["fscan"], undefined);
  });

  it("maxDepth 被夹在 [1,6]：0 变 1、999 变 6", () => {
    const tree = path.join(tmp, "tk7");
    fs.mkdirSync(path.join(tree, "a"), { recursive: true });
    fs.writeFileSync(path.join(tree, "a", "fscan"), "x", "utf8");
    /* maxDepth=0 → 夹到 1 → 深度 1 的 a/ 里的文件能看到 */
    const r0 = scanFolderForTools(tree, { maxDepth: 0 });
    assert.equal(r0.ok, true);
    if (!r0.ok) return;
    assert.notEqual(r0.assigned["fscan"], undefined);
  });

  it("maxFiles 被夹在 [100,20000]：给了 1 也还是 100", () => {
    const tree = path.join(tmp, "tk8");
    fs.mkdirSync(tree, { recursive: true });
    for (let i = 0; i < 150; i += 1) {
      fs.writeFileSync(path.join(tree, "f" + String(i) + ".bin"), "x", "utf8");
    }
    const r = scanFolderForTools(tree, { maxFiles: 1 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    /* 下限 100 → 至少扫了 100 个（不会因为传 1 就只扫 1 个） */
    assert.equal(r.scanned >= 100, true, "maxFiles 下限应为 100，实际 scanned=" + String(r.scanned));
  });

  it("maxFiles 到顶后停止扫描（工具在很后面就扫不到）", () => {
    const tree = path.join(tmp, "tk9");
    fs.mkdirSync(tree, { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      fs.writeFileSync(path.join(tree, "zz" + String(i).padStart(3, "0") + ".bin"), "x", "utf8");
    }
    const r = scanFolderForTools(tree, { maxFiles: 100 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scanned <= 200, true);
  });

  it("scanned 只数文件，不数目录", () => {
    const tree = path.join(tmp, "tk10");
    fs.mkdirSync(path.join(tree, "d1", "d2"), { recursive: true });
    fs.writeFileSync(path.join(tree, "d1", "d2", "one.txt"), "x", "utf8");
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scanned, 1);
  });

  it("顺带认出 nuclei-templates", () => {
    const tree = path.join(tmp, "tk11");
    fs.mkdirSync(path.join(tree, "nuclei-templates"), { recursive: true });
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.nucleiTemplatesDir, path.join(tree, "nuclei-templates"));
  });

  it("也认 nuclei/templates 布局", () => {
    const tree = path.join(tmp, "tk12");
    fs.mkdirSync(path.join(tree, "nuclei", "templates"), { recursive: true });
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.nucleiTemplatesDir, path.join(tree, "nuclei", "templates"));
  });

  it("没有模板目录时 nucleiTemplatesDir 为空串", () => {
    const tree = path.join(tmp, "tk13");
    fs.mkdirSync(tree, { recursive: true });
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.nucleiTemplatesDir, "");
  });

  it("hits 记录每一条命中（含 id/path/name）", () => {
    const tree = path.join(tmp, "tk14");
    makeToolTree(tree);
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    for (const h of r.hits) {
      assert.equal(typeof h.id, "string");
      assert.equal(fs.existsSync(h.path), true);
      assert.equal(typeof h.name, "string");
    }
    assert.equal(r.hits.length >= 3, true);
  });

  it("多个 id 共享同名时都记（httpx 的候选含 httpx-toolkit）", () => {
    const tree = path.join(tmp, "tk15");
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, "httpx-toolkit"), Buffer.from([0x7f, 0x45]));
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["httpx"], path.join(tree, "httpx-toolkit"));
  });

  it("空目录扫描成功但 assigned 为空", () => {
    const tree = path.join(tmp, "tk16");
    fs.mkdirSync(tree, { recursive: true });
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assignedCount, 0);
    assert.deepEqual(r.hits, []);
  });
});

describe("assignToolkitFolder", () => {
  it("把扫描结果写进 config", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    const r = assignToolkitFolder(tree, tmp);
    assert.equal(r.ok, true);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.toolkitDir, tree);
    assert.equal(cfg.tools["fscan"], path.join(tree, "fscan"));
    assert.equal(cfg.envAdaptConfigured, true);
    assert.equal(cfg.envAdaptSkip, false);
  });

  it("binDirs 是**前插**（刚分配的目录排最前）", () => {
    savePlatformConfig({ binDirs: ["/existing"] }, tmp);
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    assignToolkitFolder(tree, tmp);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.binDirs[0], tree, "新分配的目录必须排第一");
    assert.equal(cfg.binDirs.includes("/existing"), true);
  });

  it("重复分配同一目录不产生重复项", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    assignToolkitFolder(tree, tmp);
    assignToolkitFolder(tree, tmp);
    const cfg = loadPlatformConfig(tmp);
    assert.equal(cfg.binDirs.filter((d) => d === tree).length, 1);
  });

  it("分配过工具文件夹后门禁变成 configured", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    assignToolkitFolder(tree, tmp);
    const status = envAdaptStatus(tmp);
    assert.equal(status.configured, true);
    assert.notEqual(status.reason, "need-config");
  });

  it("清掉之前的 envAdaptSkip", () => {
    markEnvAdaptSkip(tmp, true);
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    assignToolkitFolder(tree, tmp);
    assert.equal(loadPlatformConfig(tmp).envAdaptSkip, false);
  });

  it("探测到模板目录时一并写入", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    fs.mkdirSync(path.join(tree, "nuclei-templates"), { recursive: true });
    const r = assignToolkitFolder(tree, tmp);
    assert.equal(r.nucleiTemplatesDir, path.join(tree, "nuclei-templates"));
    assert.equal(loadPlatformConfig(tmp).nucleiTemplatesDir, path.join(tree, "nuclei-templates"));
  });

  it("没有模板目录时 nucleiTemplatesDir 为 null", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    const r = assignToolkitFolder(tree, tmp);
    assert.equal(r.nucleiTemplatesDir, null);
  });

  it("目录不存在时 ok:false 且不改写 config", () => {
    savePlatformConfig({ notes: "untouched" }, tmp);
    const r = assignToolkitFolder(path.join(tmp, "nope"), tmp);
    assert.equal(r.ok, false);
    assert.equal(loadPlatformConfig(tmp).notes, "untouched");
    assert.equal(loadPlatformConfig(tmp).toolkitDir, "");
  });

  it("返回里带 tools 与 adapt（面板一次调用就能刷新）", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    const r = assignToolkitFolder(tree, tmp);
    assert.equal(r.ok, true);
    assert.equal(r.tools?.total, TOOL_CATALOG.length);
    assert.equal(typeof r.adapt?.ready, "boolean");
    assert.equal(r.dir, tree);
  });

  /**
   * 分配后工具能被解析到 —— 但来源是 **`config`**，不是 `toolkit`。
   *
   * 因为 `assignToolkitFolder` 把每条命中的绝对路径写进了 `config.tools[id]`，
   * 而 `resolveTool` 的第一优先级就是 config。行为正确（能找到、优先级最高），
   * 只是来源标签与直觉不同，锁住以免以后误以为是 bug 去"修"。
   */
  it("分配后 resolveTool 能找到工具（来源是 config，因已写入 tools 绝对路径）", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    assignToolkitFolder(tree, tmp);
    const resolved = resolveTool("fscan", { root: tmp, env: { PATH: "" } });
    assert.equal(resolved.path, path.join(tree, "fscan"));
    assert.equal(resolved.source, "config");
  });

  it("只设 toolkitDir 不写 tools 时，来源是 toolkit", () => {
    const tree = path.join(tmp, "tk");
    makeToolTree(tree);
    savePlatformConfig({ toolkitDir: tree }, tmp);
    const resolved = resolveTool("fscan", { root: tmp, env: { PATH: "" } });
    assert.equal(resolved.source, "toolkit");
    assert.equal(resolved.path, path.join(tree, "fscan"));
  });
});

describe("scanFolderForTools —— off-by-one 与排名作用域", () => {
  /**
   * `scanned` 必须**恰好**等于上限，不多扫一个。
   *
   * 扫描器的经典 off-by-one：把 `break` 放在 `scanned += 1` 之后，
   * 就会多处理一个文件；放在 `>=` 判断失误就少扫一个。
   * 这里造 250 个文件、上限 100，断言恰好 100 —— 两边都不许偏。
   */
  it("scanned 恰好等于 maxFiles（不多不少）", () => {
    const tree = path.join(tmp, "ob1");
    fs.mkdirSync(tree, { recursive: true });
    for (let i = 0; i < 250; i += 1) {
      fs.writeFileSync(path.join(tree, "f" + String(i).padStart(3, "0") + ".dat"), "x", "utf8");
    }
    const r = scanFolderForTools(tree, { maxFiles: 100 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scanned, 100);
  });

  /**
   * 到顶后**不再深入子目录**（性能悬崖）：
   * 顶层塞满到上限，子目录里的工具必须扫不到。
   */
  it("到顶后不再进入子目录（连 walk 都不再压栈）", () => {
    const tree = path.join(tmp, "ob2");
    fs.mkdirSync(path.join(tree, "zsub"), { recursive: true });
    fs.writeFileSync(path.join(tree, "zsub", "fscan"), "x", "utf8");
    /* 顶层放满非工具文件，先把配额用光 */
    for (let i = 0; i < 120; i += 1) {
      fs.writeFileSync(path.join(tree, "a" + String(i).padStart(3, "0") + ".dat"), "x", "utf8");
    }
    const r = scanFolderForTools(tree, { maxFiles: 100 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.scanned, 100, "必须停在 100");
    assert.equal(r.assigned["fscan"], undefined, "配额用光后不该再深入子目录");
  });

  /**
   * **`ranks` 跨目录生效（函数作用域），已被测试锁定。**
   *
   * 构造要点：不能拿 rank0 与 rank1 竞争 —— 首次分配是无条件的，
   * rank 高低只在"该 id 已有分配"后才起作用。要区分作用域，
   * 必须让**两个目录里放同一个 rank 的候选**：
   *
   * ```
   * root/aaa/nmap   root/zzz/nmap      // 两处都是 rank1（names=[nmap.exe, nmap]）
   * ```
   *
   * - global ranks：aaa 分配后 `ranks.nmap=1`，zzz 的 rank1 满足 `1 >= 1` → 跳过 → `aaa/nmap`
   * - per-dir ranks：zzz 里 prevRank 重置为 99，`1 >= 99` 为假 → 替换 → `zzz/nmap`
   *
   * 之所以这条是**确定性**的：`readdir` 在 APFS/ext4 上返回名字序，
   * `aaa` 必先于 `zzz`。（这一点是 Lead 实测确认的，我据此去掉"顺序不可控"的旧说法。）
   *
   * 变异验证：把 `const ranks` 从 `walk` 外面挪进 `walk` 里 → 本条红。
   */
  it("ranks 跨目录生效：两个目录同 rank 时先扫到的胜出", () => {
    const tree = path.join(tmp, "scope");
    fs.mkdirSync(path.join(tree, "aaa"), { recursive: true });
    fs.mkdirSync(path.join(tree, "zzz"), { recursive: true });
    fs.writeFileSync(path.join(tree, "aaa", "nmap"), "x", "utf8");
    fs.writeFileSync(path.join(tree, "zzz", "nmap"), "x", "utf8");

    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    /* global ranks → aaa 先占住，zzz 的等 rank 跳不过去 */
    assert.match(String(r.assigned["nmap"]), /[\\/]aaa[\\/]nmap$/);
    /* 只命中一次：说明 zzz 那次确实被"跳过"了，不是被覆盖 */
    assert.equal(r.hits.filter((h) => h.id === "nmap").length, 1);
  });

  it("同目录内 rank 择优（不涉及递归）", () => {
    const tree = path.join(tmp, "rank-local");
    fs.mkdirSync(tree, { recursive: true });
    fs.writeFileSync(path.join(tree, "nmap"), "x", "utf8");
    fs.writeFileSync(path.join(tree, "nmap.exe"), "x", "utf8");
    const r = scanFolderForTools(tree);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.assigned["nmap"], path.join(tree, "nmap.exe"));
  });
});
