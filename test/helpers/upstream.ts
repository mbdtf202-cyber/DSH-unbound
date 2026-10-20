/**
 * 上游仓库（dsh-qilin）的发现逻辑。
 *
 * ## 为什么需要这个模块
 *
 * 本仓库有一批**对照测试**：同一输入分别喂给新实现与上游实现，断言输出一致。
 * 这类测试是本项目最重要的质量保证（它们抓到过软链逃逸、静默回归、markdown 漏句）。
 *
 * 但它们依赖上游仓库存在于磁盘上。早期各处都写死了一个绝对路径：
 * ```
 * "/Users/raki/Documents/.../dsh-qilin"
 * ```
 * 后果：本地全绿，CI 上 9 个测试文件因为 `ERR_MODULE_NOT_FOUND` 直接崩，
 * 而且**整个 job 都失败**（不是 skip）。也就是说这份代码的"最硬的验证"
 * 只能在作者机器上跑。
 *
 * ## 现在的策略
 *
 * 1. 按优先级找：显式环境变量 → 同级目录 → 常见位置
 * 2. **找不到时返回 null，调用方 skip 而不是失败**
 * 3. CI 通过 checkout 上游来启用这些测试（见 workflow），找不到时明确跳过并留下原因
 *
 * 关键取舍：**skip 而不是 fail**。对照测试是"增强验证"，不是"基本正确性"。
 * 上游不可得时让整个构建红掉，会迫使人们删掉这些测试——那是更坏的结果。
 * 但 skip 必须**可见**：每个被跳过的用例都要输出原因，不能让"跳过"看起来像"通过"。
 */
import fs from "node:fs";
import path from "node:path";

/** 相对本仓库根，允许的上游目录名。 */
const SIBLING_NAMES = ["dsh-qilin", "dsh-purge"] as const;

/** 仓库根（`test/` 的上一级，编译后 `dist-test/test/` 的上两级）。 */
function repoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let up = 0; up < 6; up += 1) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** 判定一个目录是不是可用的上游检出。 */
function looksLikeQilin(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "lib", "core.js")) ||
    fs.existsSync(path.join(dir, "lib", "redteam", "store-core.js")) ||
    fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "lib"))
  );
}

let cached: string | null | undefined;

/**
 * 找上游仓库根目录。
 *
 * 顺序：
 *   1. `DSH_QILIN_ROOT` 环境变量（CI 与特殊布局用）
 *   2. `<repo>/../dsh-qilin`、`<repo>/../dsh-purge`（默认的并列检出）
 *   3. `<repo>/dsh-qilin`（子目录检出）
 */
export function findUpstreamRoot(): string | null {
  if (cached !== undefined) return cached;

  const candidates: string[] = [];
  const explicit = process.env["DSH_QILIN_ROOT"];
  if (explicit !== undefined && explicit.trim() !== "") candidates.push(path.resolve(explicit.trim()));

  const root = repoRoot();
  for (const name of SIBLING_NAMES) {
    candidates.push(path.resolve(root, "..", name));
    candidates.push(path.join(root, name));
  }

  for (const dir of candidates) {
    if (looksLikeQilin(dir)) {
      cached = dir;
      return dir;
    }
  }
  cached = null;
  return null;
}

/** 上游某个文件的绝对路径；上游不存在或该文件缺失时返回 null。 */
export function upstreamFile(...segments: string[]): string | null {
  const root = findUpstreamRoot();
  if (root === null) return null;
  const fp = path.join(root, ...segments);
  return fs.existsSync(fp) ? fp : null;
}

/**
 * 跳过原因文案。
 *
 * 用于 `{ skip: ... }` 的第二个参数——**必须写出来**，
 * 否则"跳过"在输出里和"通过"没有区别。
 */
export function skipReason(): string {
  const root = findUpstreamRoot();
  if (root === null) {
    return (
      "上游 dsh-qilin 未检出：对照测试需要它来比对行为。" +
      "设置 DSH_QILIN_ROOT 或把 dsh-qilin 检出到本仓库同级目录即可启用。"
    );
  }
  return `上游已找到但缺少所需文件：${root}`;
}

/** 该跑还是该跳过（给 `{ skip: shouldSkip() }` 用）。 */
export function shouldSkip(): false | string {
  const root = findUpstreamRoot();
  return root === null ? skipReason() : false;
}
