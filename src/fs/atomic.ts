/**
 * 原子文件操作。
 *
 * 为什么不用 `fs.writeFile` 直接覆盖：宿主正在运行，文件可能被读；
 * 写到一半断电/被杀 → 宿主文件截断 → **DSH 直接起不来**，用户只剩重装一条路。
 * write-to-tmp + rename 保证「要么是旧的完整文件，要么是新的完整文件」。
 *
 * 原 dsh-qilin 的注释明确记下：不走 FileHandle（hostFs 只包了少数方法），
 * 也不显式 fsync（KB 级配置断电丢最新一次可接受，下次 apply 会补）。
 * 这里保留同样的取舍，但把 rename 失败的临时文件清理做成强制。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** 原子写：写临时文件再 rename。同目录保证 rename 不跨设备。 */
export function atomicWriteFileSync(filePath: string, content: string, encoding: BufferEncoding = "utf8"): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, encoding);
    fs.renameSync(tmp, filePath);
  } catch (cause) {
    // 失败时绝不留垃圾：临时文件会污染宿主目录，还可能被下次 glob 命中。
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能压根没建出来 */
    }
    throw cause;
  }
}

/** 原子写（异步形态，供 CLI 的批量路径用）。 */
export async function atomicWriteFile(filePath: string, content: string, encoding: BufferEncoding = "utf8"): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, encoding);
    await fs.promises.rename(tmp, filePath);
  } catch (cause) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 同上 */
    }
    throw cause;
  }
}

/** 读文本；不存在返回 null（不抛，让调用方区分「缺失」与「读失败」）。 */
export function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw cause;
  }
}

/** 文件是否存在且是普通文件。 */
export function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 目录是否存在。 */
export function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/** 备份后缀，与 dsh-qilin 保持兼容，便于迁移/回滚时复用同一套备份。 */
export const BACKUP_SUFFIX = ".dsh-unbound.bak";
/** 兼容读取 dsh-qilin 的备份，避免用户迁移时丢掉原始副本。 */
export const LEGACY_BACKUP_SUFFIXES: readonly string[] = [".dshqilin.bak"];

export function backupPathOf(filePath: string): string {
  return filePath + BACKUP_SUFFIX;
}

/** 找一份可用备份：优先自己的，再退到 legacy。 */
export function findBackup(filePath: string): string | null {
  const own = backupPathOf(filePath);
  if (isRegularFile(own)) return own;
  for (const suffix of LEGACY_BACKUP_SUFFIXES) {
    const legacy = filePath + suffix;
    if (isRegularFile(legacy)) return legacy;
  }
  return null;
}

export interface BackupResult {
  readonly created: boolean;
  readonly backupPath: string;
}

/**
 * 备份一个文件。
 *
 * 关键：**只备份一次**。如果备份已存在，说明它是「上一个版本的原始件」，
 * 再覆盖就把用户唯一的回滚路径弄丢了。原项目用 `.bak` 存在即跳过。
 */
export function ensureBackupSync(filePath: string): BackupResult {
  const own = backupPathOf(filePath);
  if (isRegularFile(own)) return { created: false, backupPath: own };
  if (!isRegularFile(filePath)) return { created: false, backupPath: own };
  fs.copyFileSync(filePath, own);
  return { created: true, backupPath: own };
}

/** 从备份还原；无备份返回 false。 */
export function restoreFromBackupSync(filePath: string): boolean {
  const backup = findBackup(filePath);
  if (backup === null) return false;
  const content = fs.readFileSync(backup, "utf8");
  atomicWriteFileSync(filePath, content);
  return true;
}

/** 内容哈希（用于「文件是否真的变了」的判定与幂等测试）。 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
