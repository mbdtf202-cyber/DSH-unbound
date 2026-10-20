/**
 * skill-availability 的测试。
 *
 * 这一层决定「技能能不能用」，判错的方向性后果不对称：
 * - 误报可用 → 人已经在靶场里才发现缺 key；
 * - 误报不可用 → 用户以为环境坏了，实际上换个写法就能跑。
 *
 * 所以测试重点在**两条边界的取舍**：
 * ① 正文在手就判 available（路径指空只是"旧安装痕迹"，不许打成 broken）；
 * ② 正文读不到且文件确实不在，才判 broken。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bundledSkillSummaries,
  checkSkill,
  dshHomeCandidates,
  existsUnderAnyHome,
  expandSkillPath,
  officialSkillSummaries,
  pathCountsOnThisHost,
  readSkillFromRoot,
  redteamSummariesForCheck,
  referencedPathsOf,
  requiredEnvOf,
  skillLibraryOf,
  summarizeSkills,
} from "../../src/platform/skill-availability.js";
import type { SkillSummary } from "../../src/platform/skill-availability.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-skillavail-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("expandSkillPath", () => {
  it("展开 ${DSH_HOME}", () => {
    assert.equal(expandSkillPath("${DSH_HOME}/redteam/toolkit", { DSH_HOME: "/h" }), path.join("/h", "redteam", "toolkit"));
  });

  it("展开 $DSH_HOME", () => {
    assert.equal(expandSkillPath("$DSH_HOME/redteam", { DSH_HOME: "/h" }), path.join("/h", "redteam"));
  });

  it("展开 ~/", () => {
    assert.equal(expandSkillPath("~/go/bin/x"), path.resolve(os.homedir(), "go/bin/x"));
  });

  it("普通路径原样（去空白）", () => {
    assert.equal(expandSkillPath("  /usr/bin/nmap  ", {}), "/usr/bin/nmap");
  });

  it("没有 DSH_HOME 时用 ~/.dsh 兜底", () => {
    assert.equal(expandSkillPath("$DSH_HOME/x", {}), path.resolve(os.homedir(), ".dsh", "x"));
  });

  it("非字符串输入不炸", () => {
    assert.equal(typeof expandSkillPath(null, {}), "string");
    assert.equal(typeof expandSkillPath(undefined, {}), "string");
  });
});

describe("dshHomeCandidates", () => {
  it("含 DSH_HOME 与 homedir/.dsh 两个候选", () => {
    const c = dshHomeCandidates({ DSH_HOME: "/custom" });
    assert.equal(c.includes("/custom"), true);
    assert.equal(c.includes(path.resolve(os.homedir(), ".dsh")), true);
  });

  it("没有 DSH_HOME 时只留一个候选，且不重复", () => {
    const c = dshHomeCandidates({});
    assert.equal(c.length, 1);
    assert.equal(new Set(c).size, c.length);
  });

  it("自定义 HOME 不影响候选（用的是 os.homedir，不是 env.HOME）", () => {
    const a = dshHomeCandidates({ DSH_HOME: "/h", HOME: "/x" });
    const b = dshHomeCandidates({ DSH_HOME: "/h", HOME: "/y" });
    assert.deepEqual(a, b);
  });
});

describe("existsUnderAnyHome", () => {
  it("任一候选 home 下存在就算存在", () => {
    const home = path.join(tmp, "home1");
    fs.mkdirSync(path.join(home, "redteam", "toolkit"), { recursive: true });
    assert.equal(existsUnderAnyHome("$DSH_HOME/redteam/toolkit", { DSH_HOME: home }), true);
  });

  it("都不存在返回 false", () => {
    assert.equal(existsUnderAnyHome("$DSH_HOME/redteam/nope", { DSH_HOME: path.join(tmp, "no") }), false);
  });

  it("绝对路径不受 home 影响", () => {
    const f = path.join(tmp, "real");
    fs.writeFileSync(f, "x");
    assert.equal(existsUnderAnyHome(f, { DSH_HOME: path.join(tmp, "no") }), true);
  });
});

describe("requiredEnvOf", () => {
  it("process.env.X 算必需", () => {
    assert.deepEqual(requiredEnvOf("const k = process.env.FOFA_KEY"), ["FOFA_KEY"]);
  });

  it("os.environ[...] 算必需", () => {
    assert.deepEqual(requiredEnvOf('os.environ["REDTEAM_VPS_HOST"]'), ["REDTEAM_VPS_HOST"]);
  });

  it("os.environ.get 带默认值不算必需（有兜底）", () => {
    assert.deepEqual(requiredEnvOf('os.environ.get("OPT_KEY", "default")'), []);
  });

  it("${X:?} 算必需，裸 $X 不算（技能里到处是 $TARGET 占位）", () => {
    assert.deepEqual(requiredEnvOf("${MUST_KEY:?required}"), ["MUST_KEY"]);
    assert.deepEqual(requiredEnvOf("echo $NOT_REQUIRED"), []);
  });

  it("单引号写法也认", () => {
    assert.deepEqual(requiredEnvOf("os.environ['ABC_KEY']"), ["ABC_KEY"]);
  });

  it("去重", () => {
    const out = requiredEnvOf("process.env.FOFA_KEY\nprocess.env.FOFA_KEY");
    assert.deepEqual(out, ["FOFA_KEY"]);
  });

  it("名字至少 3 字符（避免把 $A 这类循环变量当必需）", () => {
    assert.deepEqual(requiredEnvOf("process.env.AB"), []);
    assert.deepEqual(requiredEnvOf("process.env.ABC"), ["ABC"]);
  });

  it("非字符串输入返回空数组", () => {
    assert.deepEqual(requiredEnvOf(null), []);
    assert.deepEqual(requiredEnvOf(undefined), []);
  });
});

describe("pathCountsOnThisHost", () => {
  it("说明文件不是工具", () => {
    for (const f of ["/x/toolkit/a/README.md", "/x/toolkit/a/notes.txt", "/x/toolkit/a/c.yaml", "/x/bin/a.json"]) {
      assert.equal(pathCountsOnThisHost(f, "linux", "x64"), false, f);
    }
  });

  it("平台专属二进制按平台判", () => {
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap.exe", "linux", "x64"), false);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap.exe", "win32", "x64"), true);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap_linux_amd64", "linux", "x64"), true);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap_windows_amd64.exe", "linux", "x64"), false);
  });

  it("架构专属名按 arch 判", () => {
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/suo5-linux-amd64", "linux", "arm64"), false);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/suo5-linux-arm64", "linux", "arm64"), true);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/x_linux_arm64", "linux", "x64"), false);
  });

  it("Windows 上 .sh / ~/.local 不算", () => {
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/run.sh", "win32", "x64"), false);
    assert.equal(pathCountsOnThisHost("/x/.local/bin/tool", "win32", "x64"), false);
  });

  it("macOS 上 Windows/Linux 专属名不算", () => {
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap.exe", "darwin", "arm64"), false);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap_linux_amd64", "darwin", "arm64"), false);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/nmap", "darwin", "arm64"), true);
  });

  it("反斜杠路径也能判（Windows 正文写法）", () => {
    assert.equal(pathCountsOnThisHost("C:\\x\\toolkit\\a\\nmap.exe", "win32", "x64"), true);
  });

  it("无平台/架构标记的裸名在所有平台都算", () => {
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/fscan", "linux", "x64"), true);
    assert.equal(pathCountsOnThisHost("/x/toolkit/a/fscan", "win32", "x64"), true);
  });
});

describe("referencedPathsOf", () => {
  it("收 $DSH_HOME / ~ / /home 下的 toolkit·bin·local 路径", () => {
    const body = [
      "ls $DSH_HOME/redteam/toolkit/fscan/fscan",
      "run ~/go/bin/subfinder",
      "/x/local/bin/thing",
    ].join("\n");
    const got = referencedPathsOf(body);
    assert.equal(got.includes("$DSH_HOME/redteam/toolkit/fscan/fscan"), true);
    assert.equal(got.includes("~/go/bin/subfinder"), true);
    assert.ok(got.length >= 2);
  });

  it("不收 URL 路径（否则每条技能都判缺失）", () => {
    assert.deepEqual(referencedPathsOf("GET /api/v1/users HTTP/1.1"), []);
    assert.deepEqual(referencedPathsOf("curl https://x.test/v1/bin/y"), []);
  });

  it("去掉句末中文标点", () => {
    const got = referencedPathsOf("见 ~/go/bin/subfinder，还有更多");
    assert.equal(got.includes("~/go/bin/subfinder"), true);
  });

  /**
   * 已实测：正则遇到 `<` 或 `*` 就停在它们前面，于是留下一个**截断片段**
   * `"$DSH_HOME/toolkit/"`。这个片段本身不含 `<>{}*|`，所以通不过"占位符过滤"
   * 也照样被收下 —— 也就是说原注释说的"含占位符的跳过"只对
   * "占位符出现在路径中间且前后都是普通字符"的情况成立。
   *
   * 后果很轻：`$DSH_HOME/toolkit/` 通常存在（工具目录），不会被报缺失；
   * 即使不存在，报出来的也是目录而不是怪串。锁住现状，不制造行为变更。
   */
  it("占位符路径被截断成前缀片段（已知：截断后才过滤，前缀仍会被收）", () => {
    assert.deepEqual(referencedPathsOf("$DSH_HOME/toolkit/<name>/fscan"), ["$DSH_HOME/toolkit/"]);
    assert.deepEqual(referencedPathsOf("$DSH_HOME/toolkit/x/*"), ["$DSH_HOME/toolkit/x/"]);
  });

  it("别的平台/架构的二进制跳过", () => {
    assert.deepEqual(referencedPathsOf("$DSH_HOME/toolkit/x/fscan_windows_amd64.exe"), []);
  });

  it("去重", () => {
    const body = "~/go/bin/x\n~/go/bin/x";
    assert.equal(referencedPathsOf(body).filter((p) => p === "~/go/bin/x").length, 1);
  });

  /**
   * 已实测：`/usr/local/bin/nuclei` **不会**被收到。
   * 正则要求路径以 `~`、`$DSH_HOME` 或 `/home/` 开头，所以 `/usr/`、`/opt/` 开头的一律漏掉。
   *
   * 原注释写的是"toolkit / bin / local 下的绝对路径"，读起来像"任何 abs 路径"，
   * 但实测只覆盖三种前缀 —— 又一处「注释与实现不符」（和 zip 那个同类）。
   * 后果：技能里写 `/usr/local/bin/nuclei` 时不会被判缺失（漏报，不是误报），
   * 属于"少提醒一次"，不会造成破坏。锁住现状，决定权交 Lead。
   */
  it("/usr/ 等前缀的绝对路径收不到（已知：只有 ~ / $DSH_HOME / /home 三种前缀）", () => {
    assert.deepEqual(referencedPathsOf("/usr/local/bin/nuclei"), []);
    assert.deepEqual(referencedPathsOf("/opt/tools/bin/x"), []);
  });

  it("${DSH_HOME} 花括号写法也收不到（正则只认 $DSH_HOME）", () => {
    assert.deepEqual(referencedPathsOf("${DSH_HOME}/redteam/toolkit/x/y"), []);
  });
});

describe("checkSkill —— 两条边界", () => {
  it("正文读不到 + 文件确实不在 → broken / file-missing", () => {
    const v = checkSkill({ name: "s", content: "", path: path.join(tmp, "ghost.md") });
    assert.equal(v.status, "broken");
    assert.equal(v.issues[0]?.kind, "file-missing");
  });

  it("正文读不到 + 没有 path → unknown / content-missing（判不了，不冤枉）", () => {
    const v = checkSkill({ name: "s", content: "" });
    assert.equal(v.status, "unknown");
    assert.equal(v.issues[0]?.kind, "content-missing");
  });

  it("正文在手但路径指空 → 仍 available，只记 file-stale（换机器的正常现象）", () => {
    const v = checkSkill(
      { name: "s", content: "# title\nbody", path: path.join(tmp, "ghost.md") },
      { env: {} },
    );
    assert.equal(v.status, "available");
    assert.equal(v.issues.some((i) => i.kind === "file-stale"), true);
  });

  it("缺环境变量只记缺口，不改 status", () => {
    const v = checkSkill({ name: "s", content: "k = os.environ['FOFA_KEY']" }, { env: {} });
    assert.equal(v.status, "available");
    const issue = v.issues.find((i) => i.kind === "env-missing");
    assert.equal(issue?.env, "FOFA_KEY");
    assert.equal(v.needs_user.includes("环境变量 FOFA_KEY"), true);
  });

  it("环境变量有值时不报缺口", () => {
    const v = checkSkill({ name: "s", content: "k = os.environ['FOFA_KEY']" }, { env: { FOFA_KEY: "x" } });
    assert.equal(v.issues.some((i) => i.kind === "env-missing"), false);
  });

  it("环境变量是空字符串时仍算缺（空值等于没配）", () => {
    const v = checkSkill({ name: "s", content: "k = os.environ['FOFA_KEY']" }, { env: { FOFA_KEY: "" } });
    assert.equal(v.issues.some((i) => i.kind === "env-missing"), true);
  });

  it("引用的路径不存在时记 path-missing 并列出", () => {
    const v = checkSkill(
      { name: "s", content: "$DSH_HOME/redteam/toolkit/nope/nope" },
      { env: { DSH_HOME: path.join(tmp, "nohome") } },
    );
    const issue = v.issues.find((i) => i.kind === "path-missing");
    assert.notEqual(issue, undefined);
    assert.equal(issue?.paths?.length, 1);
  });

  it("路径存在时不报 path-missing", () => {
    const home = path.join(tmp, "h");
    const toolFile = path.join(home, "redteam", "toolkit", "fscan", "fscan");
    fs.mkdirSync(path.dirname(toolFile), { recursive: true });
    fs.writeFileSync(toolFile, "#!/bin/sh\n", "utf8");
    const v = checkSkill(
      { name: "s", content: "$DSH_HOME/redteam/toolkit/fscan/fscan" },
      { env: { DSH_HOME: home } },
    );
    assert.equal(v.issues.some((i) => i.kind === "path-missing"), false);
  });

  it("VPS 占位符：没配时报 placeholder 且进 needs_user", () => {
    const v = checkSkill({ name: "s", content: "ssh root@<你的VPS_IP>" }, { env: {} });
    assert.equal(v.issues.some((i) => i.kind === "placeholder"), true);
    assert.equal(v.needs_user.includes("VPS 地址"), true);
  });

  it("VPS 已配时不报占位符（配好的机器不该永远显示 broken）", () => {
    const v = checkSkill(
      { name: "s", content: "ssh root@<你的VPS_IP>" },
      { env: { REDTEAM_VPS_HOST: "ubuntu@203.0.113.10" } },
    );
    assert.equal(v.issues.some((i) => i.kind === "placeholder"), false);
  });

  it("VPS 主机名占位符单独判定", () => {
    const v = checkSkill({ name: "s", content: "<VPS 主机名>" }, { env: {} });
    assert.equal(v.needs_user.includes("VPS 主机名"), true);
  });

  it("needs_user 去重", () => {
    const v = checkSkill(
      { name: "s", content: "os.environ['FOFA_KEY'] + os.environ['FOFA_KEY'] + <你的VPS_IP>" },
      { env: {} },
    );
    const dup = v.needs_user.filter((x) => x === "环境变量 FOFA_KEY");
    assert.equal(dup.length, 1);
  });

  it("checked 里如实回填检查过的 env 与 paths", () => {
    const v = checkSkill({ name: "s", content: "os.environ['FOFA_KEY']\n~/go/bin/subfinder" }, { env: {} });
    assert.deepEqual(v.checked.env, ["FOFA_KEY"]);
    assert.equal(v.checked.paths.includes("~/go/bin/subfinder"), true);
    assert.deepEqual(v.checked.missing_env, ["FOFA_KEY"]);
  });

  it("未命名技能用占位名，不炸", () => {
    assert.equal(checkSkill({}).name, "(未命名)");
    assert.equal(checkSkill(null).name, "(未命名)");
  });

  it("fixFor 注入后每条 issue 都带 fix", () => {
    const v = checkSkill(
      { name: "s", content: "os.environ['FOFA_KEY']" },
      { env: {}, fixFor: (i) => "修复:" + i.kind },
    );
    assert.equal(v.issues[0]?.fix.startsWith("修复:"), true);
  });

  it("fixFor 抛异常时降级成空串（判定不能因为文案挂了而挂）", () => {
    const v = checkSkill(
      { name: "s", content: "os.environ['FOFA_KEY']" },
      {
        env: {},
        fixFor: () => {
          throw new Error("boom");
        },
      },
    );
    assert.equal(v.status, "available");
    assert.equal(v.issues[0]?.fix, "");
  });
});

describe("checkSkill —— shadowed", () => {
  it("别的根里有更好的同名技能时如实说明", () => {
    const good = path.join(tmp, "good");
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, "s.md"), "# s\n干净正文", "utf8");

    const v = checkSkill(
      { name: "s", content: "os.environ['FOFA_KEY']", root: path.join(tmp, "bad") },
      { env: {}, sameNameIn: [good] },
    );
    assert.equal(v.issues.some((i) => i.kind === "shadowed"), true);
    assert.equal(typeof v.shadowed_by, "string");
  });

  it("同名技能内容相同则不报 shadowed", () => {
    const other = path.join(tmp, "o");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "s.md"), "同样的正文", "utf8");
    const v = checkSkill({ name: "s", content: "同样的正文", root: path.join(tmp, "r") }, { env: {}, sameNameIn: [other] });
    assert.equal(v.issues.some((i) => i.kind === "shadowed"), false);
  });

  it("自己那个根不算（other === root）", () => {
    const v = checkSkill({ name: "s", content: "x", root: "/same" }, { env: {}, sameNameIn: ["/same"] });
    assert.equal(v.issues.some((i) => i.kind === "shadowed"), false);
  });
});

describe("readSkillFromRoot", () => {
  it("读 <root>/<name>.md", () => {
    const root = path.join(tmp, "r");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "s.md"), "body", "utf8");
    assert.equal(readSkillFromRoot(root, "s")?.content, "body");
  });

  it("读 <root>/<name>/SKILL.md", () => {
    const root = path.join(tmp, "r");
    fs.mkdirSync(path.join(root, "s"), { recursive: true });
    fs.writeFileSync(path.join(root, "s", "SKILL.md"), "nested", "utf8");
    assert.equal(readSkillFromRoot(root, "s")?.content, "nested");
  });

  it("读不到返回 null", () => {
    assert.equal(readSkillFromRoot(path.join(tmp, "nope"), "s"), null);
  });

  it("root 非法时返回 null（不炸）", () => {
    assert.equal(readSkillFromRoot(null, "s"), null);
    assert.equal(readSkillFromRoot("", "s"), null);
    assert.equal(readSkillFromRoot(123, "s"), null);
  });
});

describe("skillLibraryOf", () => {
  it("显式 library 优先", () => {
    assert.equal(skillLibraryOf({ name: "a", library: "official" }), "official");
    assert.equal(skillLibraryOf({ name: "a", library: "redteam" }), "redteam");
  });

  it("按路径推断 redteam", () => {
    assert.equal(skillLibraryOf({ name: "a", path: "/x/skills/redteam/a.md" }), "redteam");
    assert.equal(skillLibraryOf({ name: "a", path: "/x/redteam/skills/a.md" }), "redteam");
  });

  it("按路径推断 official", () => {
    assert.equal(skillLibraryOf({ name: "a", path: "/x/skills/a/SKILL.md" }), "official");
  });

  it("resourceBase.path 也参与判定", () => {
    assert.equal(
      skillLibraryOf({ name: "a", resourceBase: { kind: "directory", path: "/x/skills/redteam" } }),
      "redteam",
    );
  });

  it("认不出返回空串", () => {
    assert.equal(skillLibraryOf({ name: "a" }), "");
    assert.equal(skillLibraryOf(null), "");
    assert.equal(skillLibraryOf(undefined), "");
  });
});

describe("redteamSummariesForCheck", () => {
  const mk = (name: string, library?: string, extras: Partial<SkillSummary> = {}): SkillSummary => ({
    name,
    ...(library === undefined ? {} : { library }),
    ...extras,
  });

  it("官方技能被排除（不拿红队工具路径判它们）", () => {
    const out = redteamSummariesForCheck([mk("a", "official"), mk("r", "redteam")], [], false);
    assert.deepEqual(out.map((s) => s.name), ["r"]);
  });

  it("bundled 里的名字即使宿主没标 library 也保留", () => {
    const out = redteamSummariesForCheck([mk("known")], [mk("known")], false);
    assert.deepEqual(out.map((s) => s.name), ["known"]);
  });

  it("scoped=true 时信任宿主列表（除官方外全收）", () => {
    const out = redteamSummariesForCheck([mk("x"), mk("y")], [], true);
    assert.deepEqual(out.map((s) => s.name), ["x", "y"]);
  });

  it("未标记且不在 bundled 里的被跳过", () => {
    assert.deepEqual(redteamSummariesForCheck([mk("stranger")], [], false), []);
  });

  it("bundled 里宿主没列出的也补进来", () => {
    const out = redteamSummariesForCheck([], [mk("only-bundle")], false);
    assert.deepEqual(out.map((s) => s.name), ["only-bundle"]);
  });

  it("去重（宿主与 bundled 同名只留一份）", () => {
    const out = redteamSummariesForCheck([mk("a", "redteam")], [mk("a")], false);
    assert.equal(out.length, 1);
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(redteamSummariesForCheck(null, null, false), []);
    assert.deepEqual(redteamSummariesForCheck([], [], false), []);
  });
});

describe("bundledSkillSummaries", () => {
  it("扫 <here>/../../skills/redteam 与各 home 下的 redteam/skills", () => {
    const skillDir = path.join(tmp, "skills", "redteam");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "demo.md"), "# Demo 技能\n正文", "utf8");
    const home = path.join(tmp, "home");
    /* hereOverride = <tmp>/a/b，则 ../../skills/redteam 正好落在 <tmp>/skills/redteam */
    const out = bundledSkillSummaries({ DSH_HOME: home }, path.join(tmp, "a", "b"));
    assert.equal(out.some((s) => s.name === "demo"), true);
    const demo = out.find((s) => s.name === "demo");
    assert.equal(demo?.description, "Demo 技能");
    assert.equal(demo?.library, "redteam");
  });

  it("跳过空文件与非常规后缀", () => {
    const base = path.join(tmp, "skills", "redteam");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "empty.md"), "   ", "utf8");
    fs.writeFileSync(path.join(base, "note.txt"), "x", "utf8");
    const out = bundledSkillSummaries({ DSH_HOME: path.join(tmp, "h") }, path.join(tmp, "a", "b"));
    assert.equal(out.some((s) => s.name === "empty"), false);
    assert.equal(out.some((s) => s.name === "note.txt"), false);
  });

  /**
   * 不能直接断言"返回空数组"：`dshHomeCandidates` 总会追加真实的 `~/.dsh`，
   * 开发机上那里通常真有红队技能。改成断言"没有一条来自我造的空目录"，
   * 这样与跑测试的机器无关。
   */
  it("目录不存在时不产出该目录下的条目（且不崩）", () => {
    const emptyHere = path.join(tmp, "nope", "a", "b");
    const out = bundledSkillSummaries({ DSH_HOME: path.join(tmp, "nope-home") }, emptyHere);
    assert.equal(Array.isArray(out), true);
    const fromEmpty = out.filter((s) => (s.path ?? "").includes(path.join(tmp, "nope")));
    assert.equal(fromEmpty.length, 0);
  });

  it("无 H1 标题时用文件名当 description", () => {
    const base = path.join(tmp, "skills", "redteam");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "plain.md"), "没有标题", "utf8");
    const out = bundledSkillSummaries({ DSH_HOME: path.join(tmp, "h") }, path.join(tmp, "a", "b"));
    assert.equal(out.find((s) => s.name === "plain")?.description, "plain");
  });
});

describe("officialSkillSummaries", () => {
  it("读目录形式的 SKILL.md 与散落的 .md", () => {
    const dir = path.join(tmp, "skills");
    fs.mkdirSync(path.join(dir, "dirmode"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dirmode", "SKILL.md"), "# Dir Skill", "utf8");
    fs.writeFileSync(path.join(dir, "flat.md"), "# Flat Skill", "utf8");
    const out = officialSkillSummaries({ DSH_HOME: tmp });
    assert.equal(out.map((s) => s.name).sort().join(","), "dirmode,flat");
    assert.equal(out.every((s) => s.library === "official"), true);
  });

  it("跳过 .system 与点开头的条目", () => {
    const dir = path.join(tmp, "skills");
    fs.mkdirSync(path.join(dir, ".system"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".system", "SKILL.md"), "x", "utf8");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "x", "utf8");
    assert.deepEqual(officialSkillSummaries({ DSH_HOME: tmp }), []);
  });

  it("目录不存在返回空数组", () => {
    assert.deepEqual(officialSkillSummaries({ DSH_HOME: path.join(tmp, "nope") }), []);
  });

  it("优先用 frontmatter 的 description", () => {
    const dir = path.join(tmp, "skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndescription: 官方技能描述\n---\n# Title", "utf8");
    assert.equal(officialSkillSummaries({ DSH_HOME: tmp })[0]?.description, "官方技能描述");
  });
});

describe("summarizeSkills", () => {
  it("按状态计数", () => {
    const mk = (status: "available" | "broken" | "unknown") => ({
      name: "x",
      status,
      issues: [],
      problems: [],
      needs_user: [],
      checked: { file: null, env: [], paths: [] },
    });
    const s = summarizeSkills([mk("available"), mk("available"), mk("broken"), mk("unknown")]);
    assert.deepEqual(s, { total: 4, available: 2, broken: 1, unknown: 1 });
  });

  it("空列表全 0", () => {
    assert.deepEqual(summarizeSkills([]), { total: 0, available: 0, broken: 0, unknown: 0 });
  });
});
