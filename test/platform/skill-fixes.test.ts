/**
 * skill-fixes 的测试。
 *
 * 这一层全是**给用户看的文案**：判错方向没关系，文案错了用户就修不好环境。
 * 所以测试分两类：
 *
 * 1. **行为**：`toolNameOfPath` 从各种路径里抽工具名、`fixesForIssue` 按 kind 分支给建议；
 * 2. **文案保真**：关键串必须逐字包含（这些是可直接粘贴执行的命令）。
 *
 * 第 2 类的断言不是"我写了个好看的句子"，而是钉住**原实现里已有的具体文本** ——
 * 迁移时改写一个字符，用户照着跑就会失败。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SKILL_FIXES, TOOL_FIXES, fixesForIssue, toolNameOfPath } from "../../src/platform/skill-fixes.js";

describe("TOOL_FIXES / SKILL_FIXES", () => {
  it("每条工具修法都有 what 与 install", () => {
    const ids = Object.keys(TOOL_FIXES);
    assert.equal(ids.length > 10, true, "工具修法条目过少");
    for (const id of ids) {
      const fix = TOOL_FIXES[id];
      assert.notEqual(fix, undefined, id);
      if (fix === undefined) continue;
      assert.equal(fix.what.length > 0, true, id + ".what");
      assert.equal(fix.install.length > 0, true, id + ".install");
    }
  });

  /**
   * 不是所有工具都由 `setup.sh` 提供：`nmap` / `sqlmap` / `hydra` 这类是**系统包**
   * （apt 装），`dirsearch` 明确写了"不在 setup.sh 的下载清单里"。
   * 真正的不变量是：**每条 install 都给出了一个可执行的下一步**
   * （反引号包住的命令或明确的取件位置），而不是干说"缺了"。
   */
  it("每条 install 都给出可执行的下一步（命令在反引号里或写明取件位置）", () => {
    for (const [id, fix] of Object.entries(TOOL_FIXES)) {
      const actionable =
        /`[^`]+`/.test(fix.install) || /GitHub releases|官方发布页|release 资产/.test(fix.install);
      assert.equal(actionable, true, id + " 的 install 没有可执行步骤：" + fix.install.slice(0, 80));
    }
  });

  it("至少有一部分工具走一键脚本（setup.sh 是主路径）", () => {
    const withSetup = Object.values(TOOL_FIXES).filter((f) => /redteam\/setup\.sh/.test(f.install));
    assert.equal(withSetup.length > 5, true, "应当有多个工具靠 setup.sh 安装");
  });

  it("系统包类工具用系统包管理器安装", () => {
    for (const id of ["nmap", "sqlmap", "hydra"]) {
      const fix = TOOL_FIXES[id];
      assert.notEqual(fix, undefined, id);
      if (fix === undefined) continue;
      assert.match(fix.install, /apt install|dnf install|pacman -S/, id);
    }
  });

  it("每条技能修法都是非空字符串", () => {
    for (const [name, text] of Object.entries(SKILL_FIXES)) {
      assert.equal(typeof text, "string", name);
      assert.equal(text.trim().length > 0, true, name);
    }
  });

  it("文案里不出现 markdown 强调符（面板按纯文本渲染）", () => {
    for (const [id, fix] of Object.entries(TOOL_FIXES)) {
      assert.equal(/\*\*/.test(fix.what + fix.install), false, id + " 含 **");
    }
  });
});

describe("toolNameOfPath", () => {
  it("toolkit/ 之后的第一段目录名", () => {
    assert.equal(toolNameOfPath("$DSH_HOME/redteam/toolkit/fscan/fscan"), "fscan");
    assert.equal(toolNameOfPath("/x/redteam/toolkit/gogo/gogo"), "gogo");
  });

  it("剥掉平台与架构后缀", () => {
    assert.equal(toolNameOfPath("$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64"), "suo5");
    assert.equal(toolNameOfPath("fscan_windows_x64.exe"), "fscan");
    assert.equal(toolNameOfPath("gogo_linux_arm64"), "gogo");
  });

  it("bin/ 与 .local/ 下取文件名", () => {
    assert.equal(toolNameOfPath("~/.local/bin/mybin"), "mybin");
    assert.equal(toolNameOfPath("/usr/bin/nuclei"), "nuclei");
  });

  it("裸名字直接当工具名", () => {
    assert.equal(toolNameOfPath("fscan"), "fscan");
  });

  it("其它路径返回 null（不是工具）", () => {
    assert.equal(toolNameOfPath("/usr/share/wordlists/rockyou.txt"), null);
    assert.equal(toolNameOfPath("skills/x.md"), null);
  });

  it("剥掉首尾引号与中文标点", () => {
    assert.equal(toolNameOfPath('"~/.local/bin/tool"'), "tool");
    assert.equal(toolNameOfPath("~/.local/bin/tool，"), "tool");
  });

  it("反斜杠路径也认", () => {
    assert.equal(toolNameOfPath("C:\\x\\redteam\\toolkit\\fscan\\fscan.exe"), "fscan");
  });

  it("清完不含 ASCII 字母返回 null", () => {
    assert.equal(toolNameOfPath("清单.md"), null);
    assert.equal(toolNameOfPath("***"), null);
  });

  it("非字符串与空串返回 null", () => {
    assert.equal(toolNameOfPath(null), null);
    assert.equal(toolNameOfPath(undefined), null);
    assert.equal(toolNameOfPath(123), null);
    assert.equal(toolNameOfPath(""), null);
    assert.equal(toolNameOfPath("   "), null);
  });
});

describe("fixesForIssue —— path-missing", () => {
  it("已知工具给出逐条装法", () => {
    const out = fixesForIssue({ kind: "path-missing", skill: "s", paths: ["$DSH_HOME/redteam/toolkit/fscan/fscan"] });
    assert.match(out, /fscan/);
    assert.match(out, /setup\.sh/);
  });

  it("未知工具回退到通用下载指引", () => {
    const out = fixesForIssue({ kind: "path-missing", skill: "s", paths: ["$DSH_HOME/redteam/toolkit/weird/x"] });
    assert.match(out, /weird/);
    assert.match(out, /官方发布页/);
  });

  it("同一工具只列一次（多个路径指向同一工具）", () => {
    const out = fixesForIssue({
      kind: "path-missing",
      skill: "s",
      paths: ["$DSH_HOME/redteam/toolkit/fscan/fscan.exe", "$DSH_HOME/redteam/toolkit/fscan/fscan"],
    });
    assert.match(out, /缺 1 个工具/);
  });

  it("接受单个字符串（不要求数组）", () => {
    const out = fixesForIssue({ kind: "path-missing", skill: "s", paths: "~/.local/bin/mybin" });
    assert.match(out, /mybin/);
  });

  it("抽不出工具名时给通用建议", () => {
    const out = fixesForIssue({ kind: "path-missing", skill: "s", paths: ["/usr/share/x/y.txt"] });
    assert.equal(out.length > 0, true);
    assert.match(out, /setup\.sh/);
  });
});

describe("fixesForIssue —— env-missing", () => {
  it("FOFA_KEY 带具体获取方式", () => {
    const out = fixesForIssue({ kind: "env-missing", skill: "s", env: ["FOFA_KEY"] });
    assert.match(out, /FOFA_KEY/);
    assert.match(out, /fofa\.info/);
    assert.match(out, /export /);
  });

  it("未知变量不编造来源", () => {
    const out = fixesForIssue({ kind: "env-missing", skill: "s", env: ["MY_CUSTOM_KEY"] });
    assert.match(out, /MY_CUSTOM_KEY/);
    assert.match(out, /值由你自己提供/);
  });

  it("提醒写入 .env 并重启才生效", () => {
    const out = fixesForIssue({ kind: "env-missing", skill: "s", env: ["FOFA_KEY"] });
    assert.match(out, /\$DSH_HOME\/\.env/);
    assert.match(out, /重启/);
  });
});

describe("fixesForIssue —— 其余分支", () => {
  it("placeholder 给出 VPS 填法", () => {
    const out = fixesForIssue({ kind: "placeholder", skill: "s", placeholder: "VPS 地址" });
    assert.match(out, /占位符/);
    assert.match(out, /REDTEAM_VPS_HOST/);
    assert.match(out, /REDTEAM_VPS_KEY/);
    assert.match(out, /chmod 600/);
  });

  it("shadowed 说明同名覆盖与修法", () => {
    const out = fixesForIssue({ kind: "shadowed", skill: "redteam-recon" });
    assert.match(out, /redteam-recon/);
    assert.match(out, /技能根/);
  });

  it("file-stale 说明「换机器必然指空」且不影响调用", () => {
    const out = fixesForIssue({ kind: "file-stale", skill: "s" });
    assert.match(out, /换机器/);
    assert.match(out, /重启/);
  });

  it("file-missing 指向重装插件", () => {
    const out = fixesForIssue({ kind: "file-missing", skill: "s" });
    assert.match(out, /重新安装/);
  });

  it("content-missing 建议用 skill 工具实测", () => {
    const out = fixesForIssue({ kind: "content-missing", skill: "my-skill" });
    assert.match(out, /`skill` 工具/);
    assert.match(out, /my-skill/);
  });

  it("未知 kind 回退到技能专属文案", () => {
    const first = Object.keys(SKILL_FIXES)[0];
    assert.notEqual(first, undefined);
    const out = fixesForIssue({ kind: "nonsense-kind", skill: String(first) });
    assert.equal(out, SKILL_FIXES[String(first)]);
  });

  it("完全无信息时给通用兜底", () => {
    const out = fixesForIssue({ kind: "nonsense" });
    assert.match(out, /setup\.sh/);
    assert.match(out, /幂等/);
  });

  it("issue 为 null / undefined 时不炸", () => {
    assert.equal(fixesForIssue(null as never).length > 0, true);
    assert.equal(fixesForIssue(undefined as never).length > 0, true);
    assert.equal(fixesForIssue({}).length > 0, true);
  });

  it("返回值不含换行（当列表项渲染不塌）", () => {
    /* 回退到 SKILL_FIXES 的分支可能带换行，但逐 kind 的分支必须是单行 */
    for (const kind of ["path-missing", "env-missing", "placeholder", "shadowed", "file-stale", "file-missing", "content-missing"]) {
      const out = fixesForIssue({ kind, skill: "s", paths: ["~/.local/bin/x"], env: ["FOFA_KEY"] });
      assert.equal(out.includes("\n"), false, kind);
    }
  });
});
