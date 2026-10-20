/**
 * validate 的边界穷举测试 —— 这是**安全边界**。
 *
 * `assertPathWithin` 存在的唯一理由：数据库里的 `path` 列是智能体写入的不可信输入，
 * 面板点一下就把文件内容读进浏览器。所以这里不只测 `../`，
 * 还测绝对路径、前缀混淆（`/root` vs `/root-evil`）、以及**软链逃逸**。
 *
 * 软链那组是在迁移时补的：原实现只做词法前缀比较，`<root>/link → /etc/passwd`
 * 能绕过去。测试用真实文件系统建软链，因为这类漏洞只在真实解析时出现。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WEBSHELL_STATUSES,
  WEBSHELL_TYPES,
  assertPathWithin,
  checkPathWithin,
  isPathWithin,
  normalizeShellStatus,
  normalizeShellType,
} from "../../src/platform/validate.js";

describe("normalizeShellType", () => {
  it("认出三种正规马（大小写不敏感）", () => {
    assert.equal(normalizeShellType("behinder"), "behinder");
    assert.equal(normalizeShellType("BEHINDER"), "behinder");
    assert.equal(normalizeShellType("Godzilla"), "godzilla");
    assert.equal(normalizeShellType("antSword"), "antSword");
    assert.equal(normalizeShellType("ANTSWORD"), "antSword");
  });

  it("认出中文别名", () => {
    assert.equal(normalizeShellType("冰蝎"), "behinder");
    assert.equal(normalizeShellType("哥斯拉"), "godzilla");
    assert.equal(normalizeShellType("蚁剑"), "antSword");
  });

  it("custom 与自研/自定义", () => {
    assert.equal(normalizeShellType("custom"), "custom");
    assert.equal(normalizeShellType("custom-shell"), "custom");
    assert.equal(normalizeShellType("自研马"), "custom");
    assert.equal(normalizeShellType("自定义"), "custom");
  });

  it("空值合法，返回 null（= 未声明）", () => {
    assert.equal(normalizeShellType(""), null);
    assert.equal(normalizeShellType("   "), null);
    assert.equal(normalizeShellType(null), null);
    assert.equal(normalizeShellType(undefined), null);
  });

  it("认不出的抛错，绝不静默存原文", () => {
    /* 静默存原文会让"用户连不上"红标与会话页口令复制静默失效 —— 这是原注释点明的理由 */
    for (const bad of ["behinedr", "一句话", "memshell", "jsp", "unknown"]) {
      assert.throws(() => normalizeShellType(bad), /shell_type 非法/, bad);
    }
  });

  /**
   * 已实测的原实现怪癖：匹配用的是子串正则，所以带前后缀的写法也会被归到正规马。
   * 这不是 bug 的正确形态，但**收紧它是行为变更**（需同时迁移历史数据），
   * 迁移阶段先锁住现状，把决定权留给 Lead。见交接报告。
   */
  it("子串匹配会把带后缀的写法归到正规马（已知怪癖，锁住现状）", () => {
    assert.equal(normalizeShellType("behinder2"), "behinder");
    assert.equal(normalizeShellType("my-behinder"), "behinder");
    assert.equal(normalizeShellType("godzilla-pro"), "godzilla");
  });

  it("错误信息里带原文与建议（模型据此改参数）", () => {
    try {
      normalizeShellType("weird");
      assert.fail("should throw");
    } catch (error) {
      const msg = (error as Error).message;
      assert.equal(msg.includes('"weird"'), true);
      assert.equal(msg.includes("behinder"), true);
      assert.equal(msg.includes("custom"), true);
    }
  });

  it("白名单常量与规范化结果自洽", () => {
    for (const t of WEBSHELL_TYPES) {
      const normalized = normalizeShellType(t);
      assert.notEqual(normalized, null, t);
    }
  });
});

describe("normalizeShellStatus", () => {
  it("接受四个合法值", () => {
    for (const s of WEBSHELL_STATUSES) assert.equal(normalizeShellStatus(s), s);
  });

  it("别名映射", () => {
    assert.equal(normalizeShellStatus("up"), "online");
    assert.equal(normalizeShellStatus("alive"), "online");
    assert.equal(normalizeShellStatus("down"), "offline");
    assert.equal(normalizeShellStatus("failed"), "offline");
    assert.equal(normalizeShellStatus("removed"), "dead");
  });

  it("大小写与空白不敏感", () => {
    assert.equal(normalizeShellStatus("  ONLINE  "), "online");
    assert.equal(normalizeShellStatus("Dead"), "dead");
  });

  it("空值默认 online（刚登记的马刚打通，这是最诚实的默认）", () => {
    assert.equal(normalizeShellStatus(""), "online");
    assert.equal(normalizeShellStatus(null), "online");
    assert.equal(normalizeShellStatus(undefined), "online");
  });

  it("非法值抛错并列出合法值", () => {
    try {
      normalizeShellStatus("bogus");
      assert.fail("should throw");
    } catch (error) {
      const msg = (error as Error).message;
      assert.equal(msg.includes('"bogus"'), true);
      for (const s of WEBSHELL_STATUSES) assert.equal(msg.includes(s), true, s);
    }
  });

  it("只接受白名单，不接受任意真值字符串", () => {
    for (const bad of ["running", "connect", "1", "0"]) {
      assert.throws(() => normalizeShellStatus(bad), /status 非法/, bad);
    }
  });
});

/* ── 路径越界防护 ─────────────────────────────────────────────────────── */

describe("assertPathWithin —— 词法层", () => {
  const root = path.resolve("/tmp/redteam-root");
  const roots = [root];

  it("根目录自身通过", () => {
    assert.equal(assertPathWithin(root, roots), root);
  });

  it("根目录下的普通文件通过", () => {
    const p = path.join(root, "runs", "evidence.txt");
    assert.equal(assertPathWithin(p, roots), p);
  });

  it("相对路径按 cwd 解析后判定", () => {
    /* 相对路径一定会被 resolve 成绝对路径，不能用它绕过前缀检查 */
    const verdict = checkPathWithin("../../../etc/passwd", roots);
    assert.equal(verdict.ok, false);
  });

  it("拒绝 ../ 穿越", () => {
    for (const bad of [
      path.join(root, "..", "etc", "passwd"),
      path.join(root, "runs", "..", "..", "etc", "passwd"),
      root + "/../../root-evil/x",
    ]) {
      assert.throws(() => assertPathWithin(bad, roots), /path outside allowed roots/, bad);
    }
  });

  it("拒绝绝对路径 /etc/passwd", () => {
    assert.throws(() => assertPathWithin("/etc/passwd", roots), /path outside allowed roots/);
  });

  it("拒绝 ~/.ssh/id_rsa（这里是字面量，不展开 —— 展开后的路径同样越界）", () => {
    assert.throws(() => assertPathWithin("~/.ssh/id_rsa", roots), /path outside allowed roots/);
  });

  it("前缀混淆：/tmp/redteam-root-evil 不算在 /tmp/redteam-root 内", () => {
    /* 单纯 startsWith 的经典漏洞：root="...root"，evil="...root-evil" */
    assert.equal(isPathWithin(root + "-evil", roots), false);
    assert.equal(isPathWithin(path.join(root + "-evil", "x"), roots), false);
  });

  it("多个允许根时任一命中即可", () => {
    const a = path.resolve("/tmp/root-a");
    const b = path.resolve("/tmp/root-b");
    assert.equal(isPathWithin(path.join(b, "x"), [a, b]), true);
    assert.equal(isPathWithin(path.join(a, "x"), [a, b]), true);
    assert.equal(isPathWithin(path.resolve("/tmp/root-c/x"), [a, b]), false);
  });

  it("空 / 非法根目录被过滤，不会因为根是空串而全部放行", () => {
    /* 若空串被当成根，resolve("") = cwd，任何路径都可能命中 */
    assert.equal(isPathWithin("/etc/passwd", [""]), false);
    assert.equal(isPathWithin("/etc/passwd", []), false);
    assert.equal(isPathWithin("/etc/passwd", undefined), false);
  });

  it("根目录带尾斜杠也能正确匹配", () => {
    assert.equal(isPathWithin(path.join(root, "x"), [root + "/"]), true);
  });

  it("目标是空值时按 cwd 解析后判定，不崩", () => {
    const verdict = checkPathWithin("", [root]);
    assert.equal(typeof verdict.ok, "boolean");
    assert.equal(verdict.abs, process.cwd());
  });
});

describe("assertPathWithin —— 真实文件系统 / 软链逃逸", () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-validate-"));
    root = path.join(tmp, "root");
    outside = path.join(tmp, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("真实存在的文件在根内通过，并返回绝对路径", () => {
    const file = path.join(root, "evidence.txt");
    fs.writeFileSync(file, "hello", "utf8");
    assert.equal(assertPathWithin(file, [root]), file);
  });

  it("软链指向根外部时拒绝（原实现漏掉的那一类）", () => {
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET", "utf8");
    const link = path.join(root, "link.txt");
    fs.symlinkSync(secret, link);

    /* 词法层会通过 —— 这正是不加真实路径判定的危险之处 */
    assert.equal(link.startsWith(root), true);
    /* 真实判定必须拒绝 */
    assert.throws(() => assertPathWithin(link, [root]), /symlink/);
    assert.equal(isPathWithin(link, [root]), false);

    const verdict = checkPathWithin(link, [root]);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.reason, "symlink");
      assert.equal(verdict.real, fs.realpathSync(secret));
    }
  });

  /**
   * **攻击性测试：真的读不到。**
   *
   * 前面几条只断言"守卫返回 false"。这条复刻真实调用链 ——
   * `readAttackFile` / `getPoc` 的形态就是「守卫通过 → readFileSync」——
   * 断言的是**内容没有泄漏**，而不只是返回值。
   *
   * 为什么必须这么测：如果哪天有人把守卫改回纯词法版，返回值断言会红，
   * 但"红在哪、后果是什么"不够直观；这条用例直接告诉你"secret 被读出来了"。
   * 对齐 Lead 那边 Zip Slip 测试的做法（构造真恶意输入，断言真后果）。
   */
  it("攻击性：软链逃逸时文件内容绝不可读（复刻 readAttackFile 调用链）", () => {
    const secretBody = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const secret = path.join(outside, "id_rsa");
    fs.writeFileSync(secret, secretBody, "utf8");
    const link = path.join(root, "stolen_key");
    fs.symlinkSync(secret, link);

    /** 复刻生产代码：守卫通过就往下读。 */
    const guardedRead = (p: string, roots: readonly string[]): string => {
      assertPathWithin(p, roots);
      return fs.readFileSync(p, "utf8");
    };

    let leaked: string | null = null;
    try {
      leaked = guardedRead(link, [root]);
    } catch (error) {
      assert.match((error as Error).message, /symlink|outside allowed roots/);
    }
    assert.equal(leaked, null, "守卫必须拦住，内容不得泄漏");
    assert.notEqual(leaked, secretBody);

    /* 反证：绕过守卫直接读是读得到的 —— 证明上面那条不是因为路径本身不可读才通过 */
    assert.equal(fs.readFileSync(link, "utf8"), secretBody);
  });

  it("攻击性：软链目录穿越读外部文件也被拦（含未落盘叶子）", () => {
    const secretBody = "db_password=hunter2";
    fs.writeFileSync(path.join(outside, "app.conf"), secretBody, "utf8");
    fs.symlinkSync(outside, path.join(root, "etc"));

    for (const p of [path.join(root, "etc", "app.conf"), path.join(root, "etc", "not-yet-there.conf")]) {
      let leaked: string | null = null;
      try {
        assertPathWithin(p, [root]);
        leaked = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      } catch (error) {
        assert.match((error as Error).message, /symlink|outside allowed roots/);
      }
      assert.equal(leaked, null, p);
    }
  });

  it("对照：根内正常文件守卫后仍可读（守卫不是一刀切）", () => {
    const body = "evidence ok";
    const f = path.join(root, "runs", "out.txt");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, "utf8");
    assertPathWithin(f, [root]);
    assert.equal(fs.readFileSync(f, "utf8"), body);
  });

  it("软链指向根外目录时同样拒绝", () => {
    const linkDir = path.join(root, "evil-dir");
    fs.symlinkSync(outside, linkDir);
    const p = path.join(linkDir, "secret.txt");
    fs.writeFileSync(path.join(outside, "secret.txt"), "x", "utf8");
    assert.throws(() => assertPathWithin(p, [root]), /symlink/);
  });

  it("软链指向根**内**时放行（不该误杀正常布局）", () => {
    const real = path.join(root, "real.txt");
    fs.writeFileSync(real, "ok", "utf8");
    const link = path.join(root, "alias.txt");
    fs.symlinkSync(real, link);
    assert.equal(assertPathWithin(link, [root]), link);
  });

  it("根目录本身是软链时，以解析后的真实根为准", () => {
    /* $DSH_HOME 被软链到别的盘是常见部署；此时根内文件必须仍然通过 */
    const realRoot = path.join(tmp, "real-root");
    fs.mkdirSync(realRoot, { recursive: true });
    const linkedRoot = path.join(tmp, "linked-root");
    fs.symlinkSync(realRoot, linkedRoot);
    const file = path.join(realRoot, "f.txt");
    fs.writeFileSync(file, "x", "utf8");
    assert.equal(isPathWithin(file, [linkedRoot]), true);
  });

  it("不存在的路径：仍通过最深存在祖先解析真实落点（随后必然读不到，仍然安全）", () => {
    const ghost = path.join(root, "nope", "ghost.txt");
    const verdict = checkPathWithin(ghost, [root]);
    assert.equal(verdict.ok, true);
    /* real 不是 null：叶子不存在，但祖先存在，能拼出真实落点。
       这比"解析失败就不管"更安全 —— 见下一条用例（软链目录 + 不存在的叶子）。 */
    assert.notEqual(verdict.real, null);
    assert.equal(verdict.real?.endsWith(path.join("nope", "ghost.txt")), true);
  });

  it("软链目录 + 尚不存在的叶子：必须拒绝（只对叶子做 realpath 会漏掉这一形态）", () => {
    const linkDir = path.join(root, "out");
    fs.symlinkSync(outside, linkDir);
    /* leaf.txt 不存在 —— 这是最现实的场景：智能体刚写下路径，文件还没落盘 */
    const ghostLeaf = path.join(linkDir, "leaf.txt");
    assert.equal(fs.existsSync(ghostLeaf), false);
    assert.equal(isPathWithin(ghostLeaf, [root]), false);
    const verdict = checkPathWithin(ghostLeaf, [root]);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "symlink");
  });

  it("不存在的路径在根外：词法层就挡住", () => {
    assert.equal(isPathWithin(path.join(outside, "ghost.txt"), [root]), false);
  });

  it("悬空软链不崩（realpath 失败退化为词法判定）", () => {
    const dangling = path.join(root, "dangling");
    fs.symlinkSync(path.join(tmp, "nope-target"), dangling);
    assert.equal(isPathWithin(dangling, [root]), true);
  });

  it("软链 + ../ 组合逃逸被拒绝", () => {
    fs.symlinkSync(outside, path.join(root, "out"));
    assert.equal(isPathWithin(path.join(root, "out", "..", "out", "x"), [root]), false);
  });
});

describe("checkPathWithin", () => {
  it("成功时给出 abs，且 real 记录解析结果", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-cpw-"));
    try {
      const file = path.join(root, "a.txt");
      fs.writeFileSync(file, "x", "utf8");
      const verdict = checkPathWithin(file, [root]);
      assert.equal(verdict.ok, true);
      assert.equal(verdict.abs, file);
      assert.equal(verdict.real, fs.realpathSync(file));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("词法越界时 reason=lexical", () => {
    const verdict = checkPathWithin("/etc/passwd", ["/tmp"]);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "lexical");
  });
});
