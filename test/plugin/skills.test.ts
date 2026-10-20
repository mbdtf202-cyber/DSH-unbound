/**
 * skills 层测试。
 *
 * ## 重点：symlink 守卫必须**真的**生效
 *
 * 原 `lib/skills.js` 只 `import { promises as fsp }`，却在 `pathsOverlap()` 里用
 * `fs.realpathSync`，异常被 catch 吞掉 → realpath 从未执行 → 守卫空转。
 *
 * 这里的用例全部建**真实临时目录 + 真 symlink**（`fs.symlinkSync`），
 * 断言的是「守卫拦住了 / 没拦住」这个行为，而不是「代码里有没有写 realpath」。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertInside,
  displayUnderHome,
  findSkillRoots,
  formatSize,
  hasRealFsBinding,
  importFromPath,
  isUnsafeArchiveEntry,
  listSkills,
  mergeSkillDocument,
  parseSkillDocument,
  pathsOverlap,
  readSkill,
  renderSkillDocument,
  resolvePhysical,
  saveSkill,
  skillBundleFile,
  skillsDir,
  skillsStatus,
  splitFrontmatter,
  validSkillName,
  deleteSkill,
} from "../../src/plugin/skills.js";
import {
  parseSkillDocument as parseReference,
  splitFrontmatter as splitReference,
} from "./fixtures/reference/skills-yaml.js";

/** 建一个临时 $DSH_HOME，返回路径与清理函数。 */
function makeHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "w4-skills-home-"));
  return {
    home,
    cleanup: (): void => {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 建一个临时工作区（放源目录）。 */
function makeScratch(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "w4-skills-src-"));
  return {
    root,
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const skillDoc = (name: string, description = "test skill", body = "body\n"): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

// ───────────────────────────── 基础知识 ─────────────────────────────

describe("validSkillName：与官方一致的 kebab-case", () => {
  it("接受 code-review", () => {
    assert.equal(validSkillName("code-review"), true);
  });
  it("接受单个词", () => {
    assert.equal(validSkillName("review"), true);
  });
  it("接受数字", () => {
    assert.equal(validSkillName("v2-review"), true);
  });
  it("拒绝大写", () => {
    assert.equal(validSkillName("Code-Review"), false);
  });
  it("拒绝下划线", () => {
    assert.equal(validSkillName("code_review"), false);
  });
  it("拒绝首尾连字符", () => {
    assert.equal(validSkillName("-code"), false);
    assert.equal(validSkillName("code-"), false);
  });
  it("拒绝连续连字符", () => {
    assert.equal(validSkillName("code--review"), false);
  });
  it("拒绝空串与非字符串", () => {
    assert.equal(validSkillName(""), false);
    assert.equal(validSkillName(42), false);
    assert.equal(validSkillName(null), false);
  });
});

describe("formatSize", () => {
  it("小于 1KB 用 B", () => {
    assert.equal(formatSize(512), "512 B");
  });
  it("1KB 以上保留一位小数", () => {
    assert.equal(formatSize(1536), "1.5 KB");
  });
  it("100KB 以上取整（避免长小数）", () => {
    assert.equal(formatSize(200 * 1024), "200 KB");
  });
  it("非法输入回 0 B", () => {
    assert.equal(formatSize(Number.NaN), "0 B");
    assert.equal(formatSize(-1), "0 B");
  });
});

describe("displayUnderHome：不泄露盘符", () => {
  const home = path.resolve("/tmp/fake-home");
  it("home 自身", () => {
    assert.equal(displayUnderHome(home, home), "$DSH_HOME");
  });
  it("home 下的文件", () => {
    assert.equal(displayUnderHome(home, path.join(home, "skills", "a", "SKILL.md")), "$DSH_HOME/skills/a/SKILL.md");
  });
  it("home 外的路径折叠成 $DSH_HOME（不外泄）", () => {
    assert.equal(displayUnderHome(home, path.resolve("/etc/passwd")), "$DSH_HOME");
  });
  it("空路径 → 空串", () => {
    assert.equal(displayUnderHome(home, ""), "");
  });
});

// ───────────────────────────── 物理路径 / symlink ─────────────────────────────

describe("resolvePhysical：真的解开 symlink", () => {
  it("fs 绑定是真的（不是 undefined 被 catch 吞掉）", () => {
    assert.equal(hasRealFsBinding(), true);
  });

  it("软链解析到目标真实路径", () => {
    const scratch = makeScratch();
    try {
      const real = path.join(scratch.root, "real");
      fs.mkdirSync(real);
      const link = path.join(scratch.root, "link");
      fs.symlinkSync(real, link);
      const got = resolvePhysical(link);
      assert.equal(got, resolvePhysical(real));
      assert.notEqual(path.basename(got), "link");
    } finally {
      scratch.cleanup();
    }
  });

  it("软链的**子路径**也解析（尾段不存在也给出物理前缀）", () => {
    const scratch = makeScratch();
    try {
      const real = path.join(scratch.root, "real");
      fs.mkdirSync(real);
      const link = path.join(scratch.root, "link");
      fs.symlinkSync(real, link);
      // link/skills/foo 里 skills/foo 还不存在
      const got = resolvePhysical(path.join(link, "skills", "foo"));
      assert.equal(got, path.join(resolvePhysical(real), "skills", "foo"));
      assert.equal(got.includes(`${path.sep}link${path.sep}`), false, "路径里不该残留软链名");
    } finally {
      scratch.cleanup();
    }
  });

  it("不存在的路径：接在最近存在祖先的物理路径后", () => {
    const scratch = makeScratch();
    try {
      const deep = path.join(scratch.root, "a", "b", "c");
      const got = resolvePhysical(deep);
      assert.equal(got, path.join(resolvePhysical(scratch.root), "a", "b", "c"));
    } finally {
      scratch.cleanup();
    }
  });
});

describe("pathsOverlap：真实 symlink 才能拦住的场景（原 bug 的回归）", () => {
  it("同一路径 → 重叠", () => {
    const scratch = makeScratch();
    try {
      assert.equal(pathsOverlap(scratch.root, scratch.root), true);
    } finally {
      scratch.cleanup();
    }
  });

  it("父子目录 → 重叠", () => {
    const scratch = makeScratch();
    try {
      assert.equal(pathsOverlap(scratch.root, path.join(scratch.root, "sub")), true);
      assert.equal(pathsOverlap(path.join(scratch.root, "sub"), scratch.root), true);
    } finally {
      scratch.cleanup();
    }
  });

  it("无关键 → 不重叠", () => {
    const scratch = makeScratch();
    try {
      assert.equal(pathsOverlap(path.join(scratch.root, "a"), path.join(scratch.root, "b")), false);
    } finally {
      scratch.cleanup();
    }
  });

  it("软链指向目标 → 判为重叠（只 path.resolve 会判错）", () => {
    const scratch = makeScratch();
    try {
      const target = path.join(scratch.root, "target");
      fs.mkdirSync(target);
      const link = path.join(scratch.root, "link");
      fs.symlinkSync(target, link);

      // 字面路径完全不同
      assert.notEqual(path.resolve(link), path.resolve(target));
      // 物理路径相同 → 必须判重叠
      assert.equal(pathsOverlap(link, target), true);
      assert.equal(pathsOverlap(target, link), true);
    } finally {
      scratch.cleanup();
    }
  });

  it("软链指向目标的子目录 → 也判重叠（#54 的形态）", () => {
    const scratch = makeScratch();
    try {
      const target = path.join(scratch.root, "target");
      const inner = path.join(target, "skills");
      fs.mkdirSync(inner, { recursive: true });
      const link = path.join(scratch.root, "link");
      fs.symlinkSync(inner, link);
      assert.equal(pathsOverlap(link, target), true);
    } finally {
      scratch.cleanup();
    }
  });

  it("不存在的路径通过已存在祖先仍能判重叠", () => {
    const scratch = makeScratch();
    try {
      const target = path.join(scratch.root, "target");
      fs.mkdirSync(target);
      const link = path.join(scratch.root, "link");
      fs.symlinkSync(target, link);
      // link/not-yet-created 尚不存在
      assert.equal(pathsOverlap(path.join(link, "not-yet-created"), target), true);
    } finally {
      scratch.cleanup();
    }
  });
});

describe("assertInside：两层防护", () => {
  it("root 内的路径通过", () => {
    const scratch = makeScratch();
    try {
      assert.doesNotThrow(() => assertInside(scratch.root, path.join(scratch.root, "a")));
    } finally {
      scratch.cleanup();
    }
  });

  it("字面逃逸被拒（第一层）", () => {
    const scratch = makeScratch();
    try {
      assert.throws(() => assertInside(scratch.root, path.resolve(scratch.root, "..", "outside")), /escaped/);
    } finally {
      scratch.cleanup();
    }
  });

  it("root 内的软链指向外部 → 被拒（第二层，只比字面路径会漏）", () => {
    const scratch = makeScratch();
    try {
      const outside = path.join(scratch.root, "outside");
      const root = path.join(scratch.root, "root");
      fs.mkdirSync(outside, { recursive: true });
      fs.mkdirSync(root, { recursive: true });
      const escape = path.join(root, "escape");
      fs.symlinkSync(outside, escape);
      // 字面确实在 root 里
      assert.equal(path.relative(root, escape).startsWith(".."), false);
      assert.throws(() => assertInside(root, path.join(escape, "file")), /symlink/);
    } finally {
      scratch.cleanup();
    }
  });
});

// ───────────────────────────── frontmatter 解析 ─────────────────────────────

describe("splitFrontmatter", () => {
  it("标准三段", () => {
    const parts = splitFrontmatter("---\nname: a\n---\nbody");
    assert.deepEqual(parts, { head: "name: a", body: "body" });
  });

  it("CRLF 也认", () => {
    const parts = splitFrontmatter("---\r\nname: a\r\n---\r\nbody");
    assert.deepEqual(parts, { head: "name: a", body: "body" });
  });

  it("去 BOM", () => {
    const parts = splitFrontmatter("\uFEFF---\nname: a\n---\nbody");
    assert.deepEqual(parts, { head: "name: a", body: "body" });
  });

  it("没有开头 --- → null", () => {
    assert.equal(splitFrontmatter("name: a\n---\nbody"), null);
  });

  it("开 --- 后没有换行 → null", () => {
    assert.equal(splitFrontmatter("---name: a"), null);
  });

  it("没有闭合 --- → null", () => {
    assert.equal(splitFrontmatter("---\nname: a\nbody"), null);
  });
});

describe("parseSkillDocument", () => {
  it("最小合法文档", () => {
    const parsed = parseSkillDocument(skillDoc("code-review", "review code"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.name, "code-review");
    assert.equal(parsed.description, "review code");
    assert.equal(parsed.modelInvocable, true, "缺省时模型可调");
    assert.equal(parsed.userInvocable, true, "缺省时可 /名称调用");
  });

  it("缺 frontmatter 给中文原因", () => {
    const parsed = parseSkillDocument("just text");
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.error, /frontmatter/);
  });

  it("name 不是 kebab-case → 报错", () => {
    const parsed = parseSkillDocument(skillDoc("Bad_Name"));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.error, /kebab-case/);
  });

  it("description 为空 → 报错", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription:\n---\nb");
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.error, /description/);
  });

  it("disable-model-invocation: true → 模型不可调", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.modelInvocable, false);
  });

  it("user-invocable: false → 不可 /名称", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: d\nuser-invocable: false\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.userInvocable, false);
  });

  it("布尔字段的 yes/no/on/off/1/0 都认", () => {
    for (const yes of ["yes", "on", "1", "TRUE"]) {
      const parsed = parseSkillDocument(`---\nname: a\ndescription: d\ndisable-model-invocation: ${yes}\n---\nb`);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) continue;
      assert.equal(parsed.modelInvocable, false, `${yes} 应视为 true`);
    }
    for (const no of ["no", "off", "0", "FALSE"]) {
      const parsed = parseSkillDocument(`---\nname: a\ndescription: d\ndisable-model-invocation: ${no}\n---\nb`);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) continue;
      assert.equal(parsed.modelInvocable, true, `${no} 应视为 false`);
    }
  });

  it("布尔字段写错 → 明确报错（不是静默当 false）", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: d\ndisable-model-invocation: maybe\n---\nb");
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.error, /布尔/);
  });

  it("引号包裹的 description 去掉引号", () => {
    const parsed = parseSkillDocument('---\nname: a\ndescription: "带: 冒号"\n---\nb');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.description, "带: 冒号");
  });

  it("单引号包裹也去引号", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: 'single'\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.description, "single");
  });

  it("行尾注释被剥掉", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: d # 说明\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.description, "d");
  });

  it("block 标量 description（|）被压成单行", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: |\n  第一行\n  第二行\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.description, "第一行 第二行");
  });

  it("block 标量 folded 形态（>）", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: >\n  one\n  two\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.description, "one two");
  });

  it("block 标量的符号顺序：|-2 与 |+2 命中，|2- 与 >2+ 不命中（原语义，逐字保留）", () => {
    // 原实现的正则是 `[|>][+-]?\d*`：符号在前、缩进在后。
    // YAML 规范同样合法的 `|2-`（缩进在前）在原实现里**不命中**，会被当成普通标量。
    // 这里逐字保留：改动它会让同一份 SKILL.md 在旧新两版解析出不同 description。
    const pick = (head: string): string => {
      const parsed = parseSkillDocument(`---\nname: a\ndescription: ${head}\n  x\n  y\n---\nb`);
      return parsed.ok ? parsed.description : `<invalid:${parsed.error}>`;
    };
    assert.equal(pick("|-2"), "x y");
    assert.equal(pick("|+2"), "x y");
    assert.equal(pick("|2-"), "|2-");
    assert.equal(pick(">2+"), ">2+");
  });

  it("whenToUse 被读出", () => {
    const parsed = parseSkillDocument("---\nname: a\ndescription: d\nwhenToUse: 当需要审查时\n---\nb");
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.whenToUse, "当需要审查时");
  });
});

describe("renderSkillDocument / mergeSkillDocument", () => {
  it("render 生成可被 parse 的文档（往返一致）", () => {
    const doc = renderSkillDocument("code-review", "审查代码", "正文");
    const parsed = parseSkillDocument(doc);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.name, "code-review");
    assert.equal(parsed.description, "审查代码");
  });

  it("render 的非法 id 抛错", () => {
    assert.throws(() => renderSkillDocument("Bad_Name", "d"), /invalid skill name/);
  });

  it("render 空 description 用 id 兜底", () => {
    const doc = renderSkillDocument("a", "  ");
    assert.match(doc, /description: a/);
  });

  it("merge 只改 name/description，保留 whenToUse 与 body", () => {
    const raw = "---\nname: old\ndescription: old desc\nwhenToUse: keep me\n---\n\n正文保留";
    const merged = mergeSkillDocument("new-id", "new desc", raw);
    const parsed = parseSkillDocument(merged);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.name, "new-id");
    assert.equal(parsed.description, "new desc");
    assert.equal(parsed.whenToUse, "keep me");
    assert.match(parsed.body, /正文保留/);
  });

  it("merge 遇到无 frontmatter 的原文 → 走 render（不丢正文）", () => {
    const merged = mergeSkillDocument("a", "d", "纯正文");
    assert.match(merged, /纯正文/);
    assert.equal(parseSkillDocument(merged).ok, true);
  });

  it("merge 时 description 超长被截到 500", () => {
    const long = "x".repeat(900);
    const merged = mergeSkillDocument("a", long, skillDoc("a"));
    const parsed = parseSkillDocument(merged);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.description.length, 500);
  });
});

// ───────────────────────────── 读写 ─────────────────────────────

describe("saveSkill / readSkill / listSkills（真实磁盘）", () => {
  it("保存后能读回，写在 bundle 目录里", async () => {
    const { home, cleanup } = makeHome();
    try {
      const saved = await saveSkill(home, "code-review", skillDoc("code-review", "review"), "review");
      assert.equal(saved.path, skillBundleFile(home, "code-review"));
      assert.equal(fs.existsSync(saved.path), true);
      const read = await readSkill(home, "code-review");
      assert.notEqual(read, null);
      assert.equal(read?.kind, "bundle");
      assert.equal(read?.valid, true);
    } finally {
      cleanup();
    }
  });

  it("保存非法 id 抛错", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => saveSkill(home, "Bad", "x"), /invalid skill name/);
    } finally {
      cleanup();
    }
  });

  it("超过 256KB 被拒", async () => {
    const { home, cleanup } = makeHome();
    try {
      const huge = `---\nname: a\ndescription: d\n---\n\n${"x".repeat(300 * 1024)}`;
      await assert.rejects(() => saveSkill(home, "a", huge), /too large/);
    } finally {
      cleanup();
    }
  });

  it("覆盖保存会留备份（备份里有旧内容）", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveSkill(home, "a", skillDoc("a", "v1"));
      const second = await saveSkill(home, "a", skillDoc("a", "v2"));
      assert.notEqual(second.backup, null);
      const backupMd = path.join(second.backup ?? "", "a", "SKILL.md");
      assert.match(fs.readFileSync(backupMd, "utf8"), /v1/);
    } finally {
      cleanup();
    }
  });

  it("listSkills 按目录名顺序、按 id 去重", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveSkill(home, "zeta", skillDoc("zeta"));
      await saveSkill(home, "alpha", skillDoc("alpha"));
      const listed = await listSkills(home);
      assert.deepEqual(listed.map((s) => s.id), ["alpha", "zeta"]);
    } finally {
      cleanup();
    }
  });

  it("listSkills 在目录不存在时返回空数组（不抛）", async () => {
    const { home, cleanup } = makeHome();
    try {
      assert.deepEqual(await listSkills(home), []);
    } finally {
      cleanup();
    }
  });

  it("跳过 .system 目录", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(path.join(skillsDir(home), ".system", "x"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(home), ".system", "x", "SKILL.md"), skillDoc("hidden"));
      assert.deepEqual(await listSkills(home), []);
    } finally {
      cleanup();
    }
  });

  it("flat 形态（<id>.md）也能读", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(skillsDir(home), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(home), "flat-one.md"), skillDoc("flat-one", "flat"));
      const read = await readSkill(home, "flat-one");
      assert.equal(read?.kind, "flat");
      const listed = await listSkills(home);
      assert.deepEqual(listed.map((s) => s.id), ["flat-one"]);
    } finally {
      cleanup();
    }
  });

  it("目录名与 frontmatter.name 不一致时以 frontmatter 为准", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(path.join(skillsDir(home), "dir-name"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(home), "dir-name", "SKILL.md"), skillDoc("real-id"));
      const listed = await listSkills(home);
      assert.deepEqual(listed.map((s) => s.id), ["real-id"]);
    } finally {
      cleanup();
    }
  });

  it("readSkill 对非法 id 抛错", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => readSkill(home, "Bad"), /invalid skill name/);
    } finally {
      cleanup();
    }
  });

  it("readSkill 找不到 → null", async () => {
    const { home, cleanup } = makeHome();
    try {
      assert.equal(await readSkill(home, "nope"), null);
    } finally {
      cleanup();
    }
  });

  it("deleteSkill 删掉目录并留备份", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveSkill(home, "gone", skillDoc("gone"));
      const removed = await deleteSkill(home, "gone");
      assert.notEqual(removed.backup, null);
      assert.equal(fs.existsSync(path.join(skillsDir(home), "gone")), false);
      assert.equal(await readSkill(home, "gone"), null);
    } finally {
      cleanup();
    }
  });

  it("deleteSkill 找不到 → 抛错", async () => {
    const { home, cleanup } = makeHome();
    try {
      await assert.rejects(() => deleteSkill(home, "nope"), /not found/);
    } finally {
      cleanup();
    }
  });

  it("skillsStatus 只暴露 $DSH_HOME 形态路径", async () => {
    const { home, cleanup } = makeHome();
    try {
      await saveSkill(home, "a", skillDoc("a"));
      const status = await skillsStatus(home);
      assert.equal(status.skills_dir, "$DSH_HOME/skills");
      assert.equal(status.skills[0]?.path, "$DSH_HOME/skills/a/SKILL.md");
      assert.equal(status.skills[0]?.path.includes(home), false);
    } finally {
      cleanup();
    }
  });
});

// ───────────────────────────── 导入 ─────────────────────────────

describe("importFromPath：symlink 源必须被挡住（#54 回归）", () => {
  it("源目录就是 skills 自身 → 拒绝", async () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(path.join(skillsDir(home), "a"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(home), "a", "SKILL.md"), skillDoc("a"));
      await assert.rejects(() => importFromPath(home, skillsDir(home)), /不能从 \$DSH_HOME\/skills/);
    } finally {
      cleanup();
    }
  });

  it("源是**软链**、指向 skills 内部 → 拒绝（原 bug 下会放行）", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      fs.mkdirSync(path.join(skillsDir(home), "a"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(home), "a", "SKILL.md"), skillDoc("a"));
      const link = path.join(scratch.root, "sneaky-link");
      fs.symlinkSync(skillsDir(home), link);

      // 字面路径在 scratch 里，与 skills 无关；只有物理路径相同。
      assert.equal(link.startsWith(skillsDir(home)), false);
      await assert.rejects(() => importFromPath(home, link), /不能从 \$DSH_HOME\/skills/);
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  it("源是软链、指向 skills 的**子目录** → 也拒绝", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      fs.mkdirSync(path.join(skillsDir(home), "a"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir(home), "a", "SKILL.md"), skillDoc("a"));
      const link = path.join(scratch.root, "inner-link");
      fs.symlinkSync(path.join(skillsDir(home), "a"), link);
      await assert.rejects(() => importFromPath(home, link), /不能从 \$DSH_HOME\/skills/);
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  it("正常外部源目录 → 导入成功（守卫不误伤）", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      const src = path.join(scratch.root, "my-skill");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "SKILL.md"), skillDoc("my-skill", "from disk"));
      const result = await importFromPath(home, src);
      assert.equal(result.imported.length, 1);
      const read = await readSkill(home, "my-skill");
      assert.equal(read?.description, "from disk");
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  it("外部源里的嵌套 SKILL.md 也能找到", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      const src = path.join(scratch.root, "pack");
      const inner = path.join(src, "one", "deep");
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, "SKILL.md"), skillDoc("deep-skill"));
      const found = await findSkillRoots(src);
      assert.equal(found.dirs.length, 1);
      const result = await importFromPath(home, src);
      assert.equal(result.imported.length, 1);
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  it("外部源里的 flat md 也能导入", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      const src = path.join(scratch.root, "flats");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "one.md"), skillDoc("one-flat"));
      const result = await importFromPath(home, src);
      assert.equal(result.imported.length, 1);
      assert.equal((await readSkill(home, "one-flat"))?.valid, true);
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  it("空目录 → 明确报错", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      const src = path.join(scratch.root, "empty");
      fs.mkdirSync(src, { recursive: true });
      await assert.rejects(() => importFromPath(home, src), /未找到 SKILL/);
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });

  it("导入时目标技能目录自身被判自我导入", async () => {
    const { home, cleanup } = makeHome();
    const scratch = makeScratch();
    try {
      // 源目录 name 与目标 id 相同，且源本身就在目标位置上（软链过去）
      const src = path.join(scratch.root, "self");
      fs.mkdirSync(src, { recursive: true });
      fs.writeFileSync(path.join(src, "SKILL.md"), skillDoc("self"));
      // 预先把目标目录做成指向源的软链 → 物理路径重叠
      fs.mkdirSync(skillsDir(home), { recursive: true });
      fs.symlinkSync(src, path.join(skillsDir(home), "self"));
      // 两种守卫都算「拦住」：路径逃逸检查（软链解析后指向 root 外）或自我导入检查。
      await assert.rejects(() => importFromPath(home, src), /不能从目标技能目录自身导入|escaped official skills directory/);
    } finally {
      scratch.cleanup();
      cleanup();
    }
  });
});

describe("isUnsafeArchiveEntry（Zip Slip 第一层）", () => {
  it("普通相对路径安全", () => {
    assert.equal(isUnsafeArchiveEntry("a/b/SKILL.md"), false);
  });
  it(".. 危险", () => {
    assert.equal(isUnsafeArchiveEntry("../../etc/passwd"), true);
  });
  it("绝对路径危险（原实现漏判，新实现收紧）", () => {
    // 原实现第一步 `replace(/^\.?\//, "")` 把开头 "/" 删掉了，
    // 于是 "/etc/passwd" → "etc/passwd" → 后续 startsWith("/") 永假 → 判「安全」。
    // 这是第一层防护的漏判，新实现先判再剥。
    assert.equal(isUnsafeArchiveEntry("/etc/passwd"), true);
    assert.equal(isUnsafeArchiveEntry("//etc/passwd"), true);
  });
  it("Windows 盘符危险", () => {
    assert.equal(isUnsafeArchiveEntry("C:\\Windows\\x"), true);
  });
  it("空段危险（a//b）", () => {
    assert.equal(isUnsafeArchiveEntry("a//b"), true);
  });
  it("空名安全（跳过）", () => {
    assert.equal(isUnsafeArchiveEntry(""), false);
  });
});

// ───────────────────────────── 差分：YAML frontmatter ─────────────────────────────

/**
 * 与原实现的差分对照。
 *
 * 判据是「同一输入 → 同一输出」。原实现的 frontmatter 解析对空格、符号顺序、
 * 引号形态都很敏感（`|2-` 不命中、`我是 DeepSeek 的 AI 助手` 不删……），
 * 手写期望值极易写错——上一版我就写错了 3 条。
 */
describe("frontmatter 解析：与原实现逐字段一致（差分）", () => {
  const DOCS: readonly string[] = [
    "---\nname: a\ndescription: d\n---\nb",
    "---\nname: code-review\ndescription: review code\n---\n\nbody\n",
    "---\r\nname: a\r\ndescription: d\r\n---\r\nbody",
    "\uFEFF---\nname: a\ndescription: d\n---\nb",
    "no frontmatter at all",
    "---\nname: Bad_Name\ndescription: d\n---\nb",
    "---\nname: a\ndescription:\n---\nb",
    "---\ndescription: d\n---\nb",
    "---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\nb",
    "---\nname: a\ndescription: d\ndisable-model-invocation: yes\n---\nb",
    "---\nname: a\ndescription: d\ndisable-model-invocation: TRUE\n---\nb",
    "---\nname: a\ndescription: d\ndisable-model-invocation: 0\n---\nb",
    "---\nname: a\ndescription: d\ndisable-model-invocation: maybe\n---\nb",
    "---\nname: a\ndescription: d\nuser-invocable: false\n---\nb",
    "---\nname: a\ndescription: d\nuser-invocable: nope\n---\nb",
    '---\nname: a\ndescription: "带: 冒号"\n---\nb',
    "---\nname: a\ndescription: 'single'\n---\nb",
    "---\nname: a\ndescription: d # comment\n---\nb",
    "---\nname: a\ndescription: |\n  第一行\n  第二行\n---\nb",
    "---\nname: a\ndescription: >\n  one\n  two\n---\nb",
    "---\nname: a\ndescription: |-\n  keep\n---\nb",
    "---\nname: a\ndescription: |+\n  keep\n---\nb",
    "---\nname: a\ndescription: |2\n    indented\n    lines\n---\nb",
    "---\nname: a\ndescription: |2-\n  x\n  y\n---\nb",
    "---\nname: a\ndescription: >-\n  folded\n  text\n---\nb",
    "---\nname: a\ndescription: d\nwhenToUse: 当需要审查时\n---\nb",
    "---\nname: a\ndescription: d\nwhenToUse: |\n  multi\n  line\n---\nb",
    "---\nname: v2-review\ndescription: 数字开头\n---\nb",
    "---\nname: a\ndescription: d\n---\nb\n---\nsecond",
    "---\nname: a\ndescription: d\n---",
    "---\nname: a\ndescription: d\n---\n",
  ];

  for (const [index, doc] of DOCS.entries()) {
    it(`文档 #${index}`, () => {
      const mine = parseSkillDocument(doc);
      const ref = parseReference(doc);
      assert.deepEqual(mine, ref, `解析结果必须与原实现一致：${JSON.stringify(doc.slice(0, 50))}`);
    });
  }

  it("splitFrontmatter 与原实现一致", () => {
    for (const doc of DOCS) {
      assert.deepEqual(splitFrontmatter(doc), splitReference(doc), JSON.stringify(doc.slice(0, 40)));
    }
  });
});

describe("isUnsafeArchiveEntry：严格超集（原实现判危险的，新实现一定判危险）", () => {
  const CORPUS: readonly string[] = [
    "a/b/SKILL.md",
    "../../etc/passwd",
    "..",
    "a/../b",
    "/etc/passwd",
    "//etc/passwd",
    "C:\\Windows\\x",
    "C:/Windows/x",
    "a//b",
    "a/b/",
    "./a/b",
    "",
    "a\\b\\c",
    "a/./b",
  ];

  it("原实现判 true 的，新实现也判 true", () => {
    // 原实现逐字复刻（用于判「原实现判什么」）。
    const reference = (name: string): boolean => {
      const rel = String(name ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "")
        .replace(/\/+$/, "");
      if (rel === "") return false;
      if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return true;
      return rel.split("/").some((part) => part === ".." || part === "");
    };
    for (const name of CORPUS) {
      if (reference(name)) {
        assert.equal(isUnsafeArchiveEntry(name), true, `超集违约：${JSON.stringify(name)}`);
      }
    }
  });

  it("新实现比原实现多拦的只有绝对路径（已知收紧点）", () => {
    const reference = (name: string): boolean => {
      const rel = String(name ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "")
        .replace(/\/+$/, "");
      if (rel === "") return false;
      if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return true;
      return rel.split("/").some((part) => part === ".." || part === "");
    };
    const extra = CORPUS.filter((n) => isUnsafeArchiveEntry(n) && !reference(n));
    assert.deepEqual(extra.sort(), ["/etc/passwd"]);
  });
});

// ───────────────────────────── 原 bug 反例（证明修复真的有效） ─────────────────────────────

describe("原 bug 反例：同一输入，原实现放行、新实现拦住", () => {
  it("#54 场景：源是软链、指向 $DSH_HOME/skills", async () => {
    const { pathsOverlap: buggyOverlap } = await import("./fixtures/reference/skills-buggy.js");

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "w4-bug54-home-"));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "w4-bug54-src-"));
    try {
      const skills = skillsDir(home);
      fs.mkdirSync(path.join(skills, "victim"), { recursive: true });
      fs.writeFileSync(path.join(skills, "victim", "SKILL.md"), skillDoc("victim"));
      // 攻击者视角：一个看起来在 scratch 里、实际指向 skills 的软链
      const link = path.join(scratch, "sneaky");
      fs.symlinkSync(skills, link);

      // 前提：字面路径确实无关（所以纯词法比较必然误判）
      assert.equal(link.startsWith(skills), false);

      // 原实现：false = 守卫放行 = 会顺着软链把 skills 删穿
      assert.equal(buggyOverlap(link, skills), false, "原实现（缺 fs import）判不出重叠，这正是那个 bug");

      // 新实现：true = 拦住
      assert.equal(pathsOverlap(link, skills), true, "新实现必须真的解析 symlink");

      // 端到端：导入被拒绝，且 skills 里的内容一个字节都没少
      await assert.rejects(() => importFromPath(home, link), /不能从 \$DSH_HOME\/skills/);
      assert.equal(fs.existsSync(path.join(skills, "victim", "SKILL.md")), true, "skills 内容必须完好");
      assert.match(fs.readFileSync(path.join(skills, "victim", "SKILL.md"), "utf8"), /name: victim/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("原实现在**非软链**场景下结论正确（说明差异只来自 realpath）", async () => {
    const { pathsOverlap: buggyOverlap } = await import("./fixtures/reference/skills-buggy.js");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "w4-bug54-plain-"));
    try {
      const a = path.join(scratch, "a");
      const b = path.join(scratch, "b");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      // 普通路径：两版结论一致
      assert.equal(buggyOverlap(a, b), pathsOverlap(a, b), "无软链时不该有差异");
      assert.equal(buggyOverlap(a, a), pathsOverlap(a, a));
      assert.equal(buggyOverlap(a, path.join(a, "sub")), pathsOverlap(a, path.join(a, "sub")));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("原实现对「不存在的目标」也判不出（新实现靠祖先解析解决）", async () => {
    const { pathsOverlap: buggyOverlap } = await import("./fixtures/reference/skills-buggy.js");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "w4-bug54-missing-"));
    try {
      const target = path.join(scratch, "target");
      fs.mkdirSync(target);
      const link = path.join(scratch, "link");
      fs.symlinkSync(target, link);
      // 叶子还没落盘（导入时目标目录通常还不存在）
      const notYet = path.join(link, "not-yet-created");
      assert.equal(buggyOverlap(notYet, target), false, "原实现判不出");
      assert.equal(pathsOverlap(notYet, target), true, "新实现沿祖先解析后能判出");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
