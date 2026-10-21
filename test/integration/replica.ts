/**
 * 真实宿主隔离副本（只读源，写副本）。
 *
 * ## 为什么必须在副本上跑
 *
 * 真实宿主在 `/Applications/DeepSeek Harness.app/...`，那是用户**正在使用**的
 * app bundle。任何 apply/revert 实验都必须发生在 `/tmp` 的副本上：
 *   - 写真实宿主 = 直接改用户的 DSH 安装；
 *   - 上一轮会话用 `mv` 移走工作目录导致整会话死锁，本项目已有事故记录。
 * 所以本模块**永不**写 SRC，只在 SRC 上 `readFileSync` / `statSync`。
 *
 * ## 为什么副本由备份重建，而不是整包 rsync
 *
 * 整包 `@deepseek-ai` 是 261 MB / 7030 个文件，每个用例拷一遍要 5 秒以上。
 * 而补丁实际只触及 54 个文件（约 2.7 MB）。更关键的是：**哪些字节才算「原始」**。
 *
 * 实测这个宿主的备份状态分两类：
 *   - 39 个文件的 `.dshqilin.bak` 是**干净原文**（不含任何本工具标记）
 *   - 15 个文件的 `.dshqilin.bak` **已经含标记**（旧版 qilin 打完之后才做的备份），
 *     对这些文件来说 `.bak` 与当前文件同字节，拿它当「原始」是错的
 *
 * 所以 `replicaFromBackups()` 接受一个 `pristineFilter`：只有调用方确认「这份备份
 * 确实不含补丁产物」时才会被采纳。不传则全部采纳（适合只验证 apply/revert 往返
 * 的用例——那种场景下「原始」等于「副本建立时的字节」，不涉及真伪判断）。
 *
 * ## 红线
 *
 * 任何写操作都先断言目标路径在副本根之下。这条断言不是形式主义：
 * 一个 `path.join` 拼错就会写到 `/Applications`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadBundledPatches } from "../../src/patches/load.js";
import { resolveTarget } from "../../src/host/targets.js";
import type { PatchDefinition } from "../../src/patches/types.js";

/**
 * 真实宿主 `@deepseek-ai` 目录。
 *
 * 允许用 `DSH_UNBOUND_REAL_AIBASE` 覆盖（CI / 其它机器）。默认值就是本机实际布局。
 * 注意这是 **read-only 源**：本文件所有函数只从它读。
 */
export const REAL_AIBASE =
  process.env["DSH_UNBOUND_REAL_AIBASE"] ??
  "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai";

/** 真实宿主是否可用（不存在则相关用例 skip 而不是 fail）。 */
export function realHostAvailable(): boolean {
  try {
    return fs.statSync(REAL_AIBASE).isDirectory();
  } catch {
    return false;
  }
}

/** 跳过原因：必须写出来，否则「跳过」在输出里和「通过」没区别。 */
export function realHostSkipReason(): false | string {
  return realHostAvailable()
    ? false
    : `真实宿主不存在（${REAL_AIBASE}）：端到端用例需要它来提供真实字节。` +
        `可设置 DSH_UNBOUND_REAL_AIBASE 指向另一份 @deepseek-ai 目录。`;
}

/** 一份隔离副本。 */
export interface Replica {
  /** 副本根（一个临时目录）。 */
  readonly root: string;
  /** 副本里的 aiBase（`<root>/dsh/node_modules/@deepseek-ai`）。 */
  readonly aiBase: string;
  /** 被补丁涉及的、已复制进副本的源文件绝对路径（指向**真实宿主**，只读）。 */
  readonly sourceFiles: readonly string[];
  /** 副本内对应的文件绝对路径，与 sourceFiles 同序。 */
  readonly replicaFiles: readonly string[];
}

/** 清掉副本（幂等，对已删除的目录再调用不抛）。 */
export function disposeReplica(r: Pick<Replica, "root">): void {
  fs.rmSync(r.root, { recursive: true, force: true });
}

/** sha256 of a file's bytes. */
export function sha256File(fp: string): string {
  return createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

/** 断言某个路径确实位于 root 之下（防拼错把真实宿主写掉）。 */
export function assertInside(root: string, target: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`refusing to touch path outside replica: ${target} (root ${root})`);
  }
}

/** 找出补丁表在本宿主上实际触及的文件（去重），并按稳定顺序排好。 */
export function involvedFiles(patches: readonly PatchDefinition[], aiBase: string): readonly string[] {
  const out = new Set<string>();
  for (const p of patches) {
    for (const key of p.fileKeys) {
      for (const fp of resolveTarget(key, aiBase).paths) out.add(fp);
    }
  }
  return [...out].sort();
}

export interface ReplicaOptions {
  /**
   * 决定某个源文件用哪份字节建副本。
   *
   * 返回绝对路径。默认：优先 `<file>.dshqilin.bak`，其次 `<file>.dsh-unbound.bak`，
   * 都没有就用当前文件本身。
   */
  readonly sourceFor?: (sourceFile: string) => string;
  /** 是否给副本里的每个文件铺一份 `.dshqilin.bak`（模拟「已由旧版打过补丁、可回滚」的宿主）。 */
  readonly seedBackups?: boolean;
}

/**
 * 用真实宿主的字节建一份隔离副本。
 *
 * 只复制补丁涉及的文件，共 54 个 / 约 2.7 MB —— 比整包 261 MB 快两个数量级。
 */
export function replicaFromRealHost(opts: ReplicaOptions = {}): Replica {
  const patches = loadBundledPatches();
  const sourceFiles = involvedFiles(patches, REAL_AIBASE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-replica-"));
  const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
  fs.mkdirSync(aiBase, { recursive: true });

  const pick = opts.sourceFor ?? defaultSourceFor;
  const replicaFiles: string[] = [];
  for (const src of sourceFiles) {
    const chosen = pick(src);
    const rel = path.relative(REAL_AIBASE, src);
    const dst = path.join(aiBase, rel);
    assertInside(root, dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(chosen, dst);
    if (opts.seedBackups === true) {
      // 副本自带备份，使 revert 有东西可还原。
      fs.copyFileSync(chosen, dst + ".dshqilin.bak");
    }
    replicaFiles.push(dst);
  }
  return { root, aiBase, sourceFiles, replicaFiles };
}

/** 默认选源：旧版备份优先（那是原文），不留备份才用当前文件。 */
function defaultSourceFor(sourceFile: string): string {
  for (const suffix of [".dshqilin.bak", ".dsh-unbound.bak"]) {
    const candidate = sourceFile + suffix;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 没有这份备份，继续找 */
    }
  }
  return sourceFile;
}

/** 一次性记录一组文件的哈希，用于「字节是否变了」的比对。 */
export function snapshotHashes(files: readonly string[]): ReadonlyMap<string, string> {
  const m = new Map<string, string>();
  for (const fp of files) m.set(fp, sha256File(fp));
  return m;
}

/** 与快照比对，返回**字节发生了变化**的文件。 */
export function diffAgainstSnapshot(
  files: readonly string[],
  snapshot: ReadonlyMap<string, string>,
): readonly string[] {
  const changed: string[] = [];
  for (const fp of files) {
    const before = snapshot.get(fp);
    if (before === undefined) continue;
    if (sha256File(fp) !== before) changed.push(fp);
  }
  return changed;
}
