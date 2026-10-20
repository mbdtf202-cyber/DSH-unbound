/**
 * 桌面路径判定的测试。
 *
 * 核心是**差分对照**：同一批输入分别喂给原实现（dsh-qilin/lib/desktop.js）
 * 与新实现（src/platform/desktop-paths.ts），断言输出逐一相等。
 * 找不到 dsh-qilin 时只用快照值断言（保证独立可跑）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  appAsarPath,
  isAsarSealedPath,
  isDesktopExecutable,
  isOfficialHarnessExecutable,
  isSubPath,
  looksLikeDesktopName,
  looksLikeDesktopNameTail,
  resourceDirCandidates,
  resourcesDirForExecutable,
  slashNorm,
} from "../../src/platform/desktop-paths.js";

const QILIN_CANDIDATES = [
  "/Users/raki/Documents/deepseek-harness/default-workspace/dsh-qilin",
  path.resolve(import.meta.dirname, "..", "..", "..", "dsh-qilin"),
];
function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "desktop.js"))) return c;
  }
  return null;
}

/** 一批覆盖各平台的代表性路径。 */
const PATHS = [
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
  "/Applications/DeepSeek Harness.app",
  "/Applications/DeepSeek Harness.app/Contents",
  "/Applications/DeepSeek Harness.app/Contents/Resources",
  "C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe",
  "C:\\Program Files\\DeepSeek Harness\\resources",
  "/home/u/.dsh/profiles/web/node_modules/@deepseek-ai",
  "/opt/dsh-desktop/resources",
  "/tmp/DeepSeek Harness/npm-global/lib",
  "/x/dsh desktop.app/Contents/MacOS/dsh desktop",
  "/y/resources",
  "",
] as const;

describe("slashNorm / isSubPath", () => {
  it("归一分隔符为 / 并小写", () => {
    assert.equal(slashNorm("C:\\A\\B"), "c:/a/b");
  });

  it("isSubPath 真值", () => {
    assert.equal(isSubPath("/a/b/c", "/a/b"), true);
    assert.equal(isSubPath("/a/b", "/a/b"), true);
  });

  it("isSubPath 假值", () => {
    assert.equal(isSubPath("/a/bc", "/a/b"), false, "前缀但非路径边界");
    assert.equal(isSubPath("/a", "/a/b"), false);
  });

  it("isSubPath 拒绝退化 root（否则恒真）", () => {
    assert.equal(isSubPath("/anything", "/"), false);
    assert.equal(isSubPath("/anything", ""), false);
  });

  it("isSubPath 拒绝盘符 root", () => {
    assert.equal(isSubPath("c:/x", "c:"), false);
  });

  it("Windows 路径子判定", () => {
    assert.equal(isSubPath("C:\\Program Files\\X\\resources", "C:\\Program Files\\X"), true);
  });
});

describe("looksLikeDesktopNameTail — 祖先目录误判的修正", () => {
  it("路径最后一段是安装根 → true", () => {
    assert.equal(looksLikeDesktopNameTail("/Applications/DeepSeek Harness.app"), true);
    assert.equal(looksLikeDesktopNameTail("/opt/dsh-desktop"), true);
  });

  it("★ 祖先目录叫 DeepSeek Harness 但末段不是 → false", () => {
    // 这是原 bug 的核心场景：npm-global 装在名为 DeepSeek Harness 的目录下
    const p = "/tmp/DeepSeek Harness/npm-global/lib";
    assert.equal(looksLikeDesktopName(p), true, "宽匹配会命中（已知行为）");
    assert.equal(looksLikeDesktopNameTail(p), false, "严格匹配不能命中");
  });

  it("DeepSeek Harness 作为中间目录也判 false", () => {
    assert.equal(looksLikeDesktopNameTail("D:/DeepSeek Harness/.dsh/profiles"), false);
  });

  it("可执行文件名本身算", () => {
    assert.equal(looksLikeDesktopNameTail("/x/DeepSeek Harness.exe"), true);
  });
});

describe("isDesktopExecutable / isOfficialHarnessExecutable", () => {
  it("识别官方 exe 名", () => {
    assert.equal(isDesktopExecutable("DeepSeek Harness.exe"), true);
    assert.equal(isDesktopExecutable("/a/deepseek-harness"), true);
  });

  it("识别 dsh desktop", () => {
    assert.equal(isDesktopExecutable("/a/dsh desktop.exe"), true);
  });

  it("普通文件名不算", () => {
    assert.equal(isDesktopExecutable("/a/node"), false);
    assert.equal(isOfficialHarnessExecutable("/a/node"), false);
  });
});

describe("resourceDirCandidates — 平台形态", () => {
  it("macOS .app 走 Contents/Resources", () => {
    const c = resourceDirCandidates("/Applications/X.app");
    assert.equal(c[0], "/Applications/X.app/Contents/Resources");
  });

  it("Contents 目录直接用", () => {
    const c = resourceDirCandidates("/Applications/X.app/Contents");
    assert.ok(c.includes("/Applications/X.app/Contents/Resources"));
  });

  it("MacOS 目录回到 Contents", () => {
    const c = resourceDirCandidates("/Applications/X.app/Contents/MacOS");
    assert.equal(c[0], "/Applications/X.app/Contents/Resources");
  });

  it("已经是 resources 时只有自己一个候选（不再拼一层）", () => {
    assert.deepEqual(resourceDirCandidates("/y/resources"), ["/y/resources"]);
  });

  it("普通安装目录给 resources / Resources 两个", () => {
    assert.deepEqual(resourceDirCandidates("/opt/app"), ["/opt/app/resources", "/opt/app/Resources"]);
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(resourceDirCandidates(""), []);
  });
});

describe("resourcesDirForExecutable — 三段优先", () => {
  const probeNone = { isFile: () => false, isDir: () => false };

  it("有 app.asar 时优先选它所在的 resources", () => {
    const exe = "/Applications/X.app/Contents/MacOS/X";
    const probe = { isFile: (p: string) => p.endsWith("Contents/Resources/app.asar"), isDir: () => false };
    assert.equal(resourcesDirForExecutable(exe, probe), "/Applications/X.app/Contents/Resources");
  });

  it("无 app.asar 时退回第一个存在的目录", () => {
    const exe = "/opt/app/bin/x";
    const probe = { isFile: () => false, isDir: (p: string) => p === "/opt/app/bin/resources" };
    assert.equal(resourcesDirForExecutable(exe, probe), "/opt/app/bin/resources");
  });

  it("都不存在时给第一个候选（不返回空）", () => {
    const got = resourcesDirForExecutable("/opt/app/bin/x", probeNone);
    assert.equal(got, "/opt/app/bin/resources");
  });

  it("appAsarPath 拼出 resources/app.asar", () => {
    assert.equal(
      appAsarPath("/opt/app/bin/x", probeNone),
      "/opt/app/bin/resources/app.asar",
    );
  });
});

describe("isAsarSealedPath", () => {
  it("以 .asar 结尾才算", () => {
    assert.equal(isAsarSealedPath("/a/b/app.asar"), true);
    assert.equal(isAsarSealedPath("/a/b/app.asar.unpacked"), false);
  });
});

describe("差分对照：新实现 === dsh-qilin 原实现", () => {
  const qilin = findQilin();

  it("7 个函数 x 12 条路径 输出逐一相等", { skip: qilin === null }, async () => {
    const old = (await import(new URL(`file://${qilin}/lib/desktop.js`).href)) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const probeNone = { isFile: () => false, isDir: () => false };
    let compared = 0;

    for (const p of PATHS) {
      const cases: [string, unknown, unknown][] = [
        ["looksLikeDesktopName", old["looksLikeDesktopName"]!(p), looksLikeDesktopName(p)],
        ["looksLikeDesktopNameTail", old["looksLikeDesktopNameTail"]!(p), looksLikeDesktopNameTail(p)],
        ["isDesktopExecutable", old["isDesktopExecutable"]!(p), isDesktopExecutable(p)],
        ["isOfficialHarnessExecutable", old["isOfficialHarnessExecutable"]!(p), isOfficialHarnessExecutable(p)],
        ["resourceDirCandidates", old["resourceDirCandidates"]!(p), resourceDirCandidates(p)],
        ["isAsarSealedPath", old["isAsarSealedPath"]!(p), isAsarSealedPath(p)],
        ["appAsarPath", old["appAsarPath"]!(p), appAsarPath(p, probeNone)],
      ];
      for (const [name, expected, actual] of cases) {
        assert.deepEqual(actual, expected, `${name}(${JSON.stringify(p)})`);
        compared += 1;
      }
    }
    assert.ok(compared >= 84, `对比样本过少：${compared}`);
  });

  it("快照断言（无需外部仓库也能跑）", () => {
    assert.equal(looksLikeDesktopNameTail("/tmp/DeepSeek Harness/npm-global/lib"), false);
    assert.equal(looksLikeDesktopName("/tmp/DeepSeek Harness/npm-global/lib"), true);
    assert.deepEqual(resourceDirCandidates("/y/resources"), ["/y/resources"]);
    assert.equal(isSubPath("/a/bc", "/a/b"), false);
  });
});
