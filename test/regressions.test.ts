/**
 * 回归测试：在 dsh-qilin 里发现并修掉的真实缺陷。
 *
 * 这些用例的价值是「防止同样的错误再次写出来」，所以每条都注明原 bug 的形态。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBackupSync, findBackup, restoreFromBackupSync, atomicWriteFileSync } from "../src/fs/atomic.js";

/** 仓库根。 */
const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("回归 BUG-1：未导入的 fs 导致 realpath 静默失效", () => {
  it("本项目的 realpath 调用都有真实绑定（不是靠全局 fs）", () => {
    // 原 bug：lib/skills.js 只 import { promises as fsp }，却用了 fs.realpathSync，
    // 外面套 try/catch，ReferenceError 被吞 → symlink 永不解析 → 安全守卫空转。
    // 这里验证：本项目任何 .ts 源码里出现 fs.xxx，都必须有 fs 的 import。
    const srcDir = path.join(import.meta.dirname, "..", "..", "src");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fp);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const text = fs.readFileSync(fp, "utf8");
        // 使用了 fs.<member>
        const usesFs = /(^|[^.\w$])fs\.[a-zA-Z]/.test(text);
        if (!usesFs) continue;
        // 必须有 import ... fs ... from "node:fs"
        const importsFs =
          /import\s+fs\s+from\s+["']node:fs["']/.test(text) ||
          /import\s+\*\s+as\s+fs\s+from\s+["']node:fs["']/.test(text) ||
          /import\s+\{[^}]*\bfs\b[^}]*\}\s+from\s+["']node:fs["']/.test(text) ||
          /const\s+fs\s*=/.test(text);
        if (!importsFs) offenders.push(path.relative(srcDir, fp));
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], `这些文件用了 fs. 却没导入 fs：${offenders.join(", ")}`);
  });

  it("realpathSync 在 symlink 上真的解析（行为证明，不是只看 import）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-realpath-"));
    try {
      const real = path.join(root, "real");
      fs.mkdirSync(real);
      const link = path.join(root, "link");
      fs.symlinkSync(real, link);
      const resolved = fs.realpathSync(link);
      assert.notEqual(resolved, link, "symlink 必须被解析到真实路径");
      assert.equal(path.basename(resolved), "real");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("回归 BUG-2：未定义标识符被 try/catch 吞掉", () => {
  /**
   * 这条测试两度误报，根因相同：**用正则判断绑定关系是不可靠的**。
   *   1. 只看名字是否出现 → 把定义处也当违规
   *   2. 只认 import/const → 漏了 `export { X } from "./y.js"` 再导出
   * 多行 import、再导出、别名、`import type`、解构……每种写法都要一条正则。
   *
   * 改为**交给编译器**：未定义标识符是 TS2304，`npm run typecheck` 是必经门禁。
   * 这条测试只负责证明「那道门真的会响」，而不是自己重写一个不完整的检查器。
   */
  it("tsc 对未定义标识符确实报 TS2304（验证门禁有效）", () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-undefined-probe-"));
    try {
      const probe = path.join(probeDir, "probe.ts");
      fs.writeFileSync(probe, "export const x = NOT_DEFINED_ANYWHERE;\n", "utf8");
      const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
      const result = spawnSync(process.execPath, [tscBin, "--noEmit", "--strict", probe], {
        encoding: "utf8",
        cwd: ROOT,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.notEqual(result.status, 0, "对未定义标识符，tsc 必须非零退出");
      assert.match(output, /TS2304|Cannot find name/, `tsc 应报 TS2304，实际：${output.slice(0, 300)}`);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });

  it("schema 迁移用到的那两个名字确实被导出（防止被人删掉）", () => {
    const schemaPath = path.join(ROOT, "src", "redteam", "store", "schema.ts");
    if (!fs.existsSync(schemaPath)) return;
    const schema = fs.readFileSync(schemaPath, "utf8");
    assert.match(schema, /export const LEGACY_STAGE_MAP\b/, "LEGACY_STAGE_MAP 必须导出");
    assert.match(schema, /export const SCOPE_SQL\b/, "SCOPE_SQL 必须导出");
  });
});

describe("回归 BUG-3：engines 与实际运行时需求不符", () => {
  it("engines.node 覆盖 node:sqlite（>=22.5）", () => {
    const pkgPath = path.join(import.meta.dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { engines?: { node?: string } };
    const range = pkg.engines?.node ?? "";
    assert.notEqual(range, "", "必须声明 engines.node");
    // 原 bug：engines 写 >=18，但代码用了 node:sqlite（需 >=22.5），Node 20 上运行才炸。
    // 本重写不依赖 sqlite，产物只用稳定 node: 内置模块，下限由测试工具链决定（20.x）。
    const m = /^>=\s*(\d+)\.(\d+)/.exec(range);
    assert.ok(m, `engines.node 应当是可解析的 >=X.Y 形式，实际是 "${range}"`);
    const major = Number(m[1]);
    const minor = Number(m[2]);
    // 之所以是 22.5：store 层用 node:sqlite，该模块自 22.5 起提供。
    // 这正是原项目 BUG-3 的同一个坑（声明 >=18 实际要 22.5），不能重犯。
    const ok = major > 22 || (major === 22 && minor >= 5) || major >= 23;
    assert.equal(ok, true, `engines.node 至少 >=22.5（当前 "${range}"）`);
  });

  it("产物引用的实验性模块必须在 engines 覆盖范围内", () => {
    const distDir = path.join(import.meta.dirname, "..", "..", "dist");
    if (!fs.existsSync(distDir)) return; // 未构建时跳过（CI 会先 build）
    // node:sqlite 是允许的（engines 已声明 >=22.5），但测试框架模块绝不能进产物。
    const banned = ["node:test", "node:test/reporters"];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(fp);
          continue;
        }
        if (!e.name.endsWith(".js")) continue;
        const text = fs.readFileSync(fp, "utf8");
        for (const b of banned) if (text.includes(`"${b}"`)) hits.push(`${e.name}: ${b}`);
      }
    };
    walk(distDir);
    assert.deepEqual(hits, [], `发布产物不应引用这些模块：${hits.join(", ")}`);
  });

  it("本机 Node 满足 package.json 的 engines 下限", () => {
    const pkgPath = path.join(import.meta.dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { engines?: { node?: string } };
    const m = /^>=\s*(\d+)\.(\d+)/.exec(pkg.engines?.node ?? "");
    assert.ok(m);
    const need = [Number(m[1]), Number(m[2])] as const;
    const have = process.versions.node.split(".").map(Number) as [number, number, number];
    const ok = have[0] > need[0] || (have[0] === need[0] && have[1] >= need[1]);
    assert.equal(ok, true, `当前 Node ${process.versions.node} 低于要求的 >=${need[0]}.${need[1]}`);
  });
});

describe("原子写与备份的边界行为", () => {
  it("写失败不留 .tmp", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-atomic-"));
    try {
      // 把目标目录设成只读，让 rename 失败
      const dir = path.join(root, "locked");
      fs.mkdirSync(dir);
      const target = path.join(dir, "f.txt");
      fs.writeFileSync(target, "old", "utf8");
      fs.chmodSync(dir, 0o500);
      let threw = false;
      try {
        atomicWriteFileSync(target, "new");
      } catch {
        threw = true;
      }
      fs.chmodSync(dir, 0o700);
      if (threw) {
        const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
        assert.deepEqual(leftovers, [], "失败后不应残留临时文件");
      }
      // 无论是否抛出，原文件都必须是完整的（不能截断）
      const content = fs.readFileSync(target, "utf8");
      assert.ok(content === "old" || content === "new", `文件内容必须是完整的一份，实际 "${content}"`);
    } finally {
      fs.chmodSync(path.join(root, "locked"), 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("备份只做一次（第二次不覆盖已有备份）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-backup-"));
    try {
      const f = path.join(root, "x.js");
      fs.writeFileSync(f, "v1", "utf8");
      const b1 = ensureBackupSync(f);
      assert.equal(b1.created, true);
      fs.writeFileSync(f, "v2", "utf8");
      const b2 = ensureBackupSync(f);
      assert.equal(b2.created, false, "已有备份时不应重建");
      assert.equal(fs.readFileSync(b1.backupPath, "utf8"), "v1", "备份必须保留最早的原文");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("无备份时 findBackup 返回 null，restore 返回 false", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-nobak-"));
    try {
      const f = path.join(root, "missing.js");
      assert.equal(findBackup(f), null);
      assert.equal(restoreFromBackupSync(f), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
