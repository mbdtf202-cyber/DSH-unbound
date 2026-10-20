/**
 * ZIP 解压（零外部依赖，纯 Node）。
 *
 * 迁移自 dsh-qilin/lib/zip-extract.js。
 *
 * ## 为什么自己实现 ZIP 解析
 *
 * 包里不能引第三方依赖（宿主 profile 下解析不到 node_modules），而
 * `node:zlib` 只有 raw inflate，没有 ZIP 容器。所以需要自己读
 * EOCD → 中央目录 → 本地头，再用 inflateRawSync 解压。
 *
 * ## 安全边界（重点）
 *
 * ZIP 条目名是**不可信输入**。攻击者可以构造 `../../etc/passwd` 或
 * 绝对路径条目，解压时写到任意位置（Zip Slip）。原实现做了两层防护，
 * 这里都保留并加强测试：
 *   1. `safeZipName()` 规范化并拒绝 `..` / 绝对路径 / 空段
 *   2. 落盘前再校验 `resolve(root, rel)` 仍在 root 下（防符号链接等间接逃逸）
 *
 * 第二层不是冗余：第一层只看字符串，若 root 内已有指向外部的 symlink，
 * 只有第二层的路径校验能挡住。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** 调外部工具时的统一选项：不弹窗、超时、只收输出。 */
const HIDDEN = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"] as const,
  windowsHide: true,
  timeout: 60_000,
} as const;

/** 解压后端，按平台给出首选项。最后一项总是 `node`（内置、最可靠）。 */
export type UnzipTool = "tar" | "unzip" | "python3" | "bsdtar" | "powershell" | "node";

export function unzipTools(platform: NodeJS.Platform = process.platform): readonly UnzipTool[] {
  if (platform === "win32") return ["tar", "powershell", "node"];
  return ["tar", "unzip", "python3", "bsdtar", "node"];
}

/** ZIP 本地文件头签名。 */
const LOCAL_SIG = 0x04034b50;
/** ZIP 中央目录项签名。 */
const CENTRAL_SIG = 0x02014b50;
/** ZIP 中央目录结束记录签名。 */
const EOCD_SIG = 0x06054b50;
/** ZIP64 的 32 位溢出哨兵值。 */
const ZIP64_SENTINEL = 0xffffffff;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/**
 * 规范化条目名并做第一层防护。
 *
 * 返回空串表示「应跳过」（空名或纯目录层）。
 *
 * ## 绝对路径：拒绝，不是降级（已与 plugin 层对齐）
 *
 * 早期实现先 `replace(/^\.?\//, "")` 剥掉开头斜杠，导致 `/etc/passwd`
 * 变成 `etc/passwd` —— 落在目标目录内，安全，但**语义上与
 * `plugin/skills.ts` 的 `isUnsafeArchiveEntry` 不一致**（那边拒绝）。
 *
 * 两个函数服务同一类安全边界（zip/tar 条目名是不可信输入），
 * 现在统一为**拒绝**：先判原样是否绝对路径，再剥前缀做后续校验。
 *
 * 判据：
 *   - POSIX 绝对路径 `/...`、Windows 盘符 `C:...`、UNC `\\server\...` → 拒绝
 *   - 含 `..` 段、空段（`a//b`）→ 拒绝
 *   - 其余规范化后返回相对路径
 *
 * @returns 规范化后的相对路径；空串表示该条目应被跳过
 * @throws ZipError 名字非法
 */
export function safeZipName(name: string): string {
  const raw = String(name ?? "").replace(/\\/g, "/");

  // 第一层：原样判定绝对路径。必须在剥前缀**之前**做，
  // 否则 "/etc/passwd" 会被降级成 "etc/passwd" 而绕过这道检查。
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new ZipError("zip 路径不合法（绝对路径）");
  }

  // 第二层：规范化（去 ./ 前缀、去尾斜杠）后再判一次，
  // 覆盖 "./C:/x" 这类绕过。
  const rel = raw.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (rel === "") return "";
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) {
    throw new ZipError("zip 路径不合法（绝对路径）");
  }

  // 第三层：段级校验
  const parts = rel.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new ZipError("zip 路径不合法（穿越或空段）");
  }
  return parts.join("/");
}

/** 从尾部找 EOCD（可能带最长 65535 字节的注释）。 */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError("不是 zip");
}

/** 一个中央目录条目的解码结果。 */
export interface ZipEntry {
  readonly name: string;
  /** 0 = stored，8 = deflate。 */
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

/** 读中央目录。 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("不是 zip");
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < total; n += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new ZipError("zip 目录损坏");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 列出条目名（不解压）。 */
export function listZipEntries(buf: Buffer): string[] {
  return readZipEntries(buf).map((entry) => entry.name.replace(/\\/g, "/"));
}

/** 列出 zip 文件里的条目名。 */
export function listZipFile(zipPath: string): string[] {
  return listZipEntries(fs.readFileSync(zipPath));
}

/** 计算条目数据在 buffer 中的起点（跳过本地头）。 */
function localDataOffset(buf: Buffer, localOffset: number): number {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
    throw new ZipError("zip 本地头损坏");
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  return localOffset + 30 + nameLen + extraLen;
}

/**
 * 从内存解压到 dest。
 *
 * 第二层防护在这里：每个条目落盘前都验证解析后的绝对路径仍在 root 之内。
 */
export function extractZipBuffer(buf: Buffer, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;

  for (const entry of readZipEntries(buf)) {
    const rel = safeZipName(entry.name);
    if (rel === "") continue;
    if (entry.compressedSize === ZIP64_SENTINEL || entry.localOffset === ZIP64_SENTINEL) {
      throw new ZipError("不支持 zip64");
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`不支持的 zip 压缩方式 ${entry.method}`);
    }
    const start = localDataOffset(buf, entry.localOffset);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipError("zip 数据被截断");
    const compressed = buf.subarray(start, end);
    const body = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed);

    const out = path.resolve(root, rel);
    if (out !== root && !out.startsWith(prefix)) {
      throw new ZipError("zip 路径不合法");
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  }
}

/** 试一个外部命令，成功返回空串，失败返回一行诊断。 */
function attempt(file: string, args: readonly string[], extra: Record<string, unknown> = {}): string {
  try {
    execFileSync(file, args, {
      ...HIDDEN,
      stdio: ["ignore", "pipe", "pipe"],
      ...extra,
    });
    return "";
  } catch (cause) {
    const err = cause as { stderr?: string; stdout?: string; message?: string };
    const detail = String(err.stderr ?? err.stdout ?? err.message ?? "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)[0];
    return detail === undefined ? file : `${file}: ${detail}`;
  }
}

/**
 * 按顺序试解压工具，全部失败才抛。
 * @returns 实际成功用的工具名
 */
export function extractZipArchive(
  zipPath: string,
  dest: string,
  tools: readonly UnzipTool[] = unzipTools(),
): UnzipTool {
  fs.mkdirSync(dest, { recursive: true });
  const notes: string[] = [];

  for (const tool of tools) {
    if (tool === "node") {
      try {
        extractZipBuffer(fs.readFileSync(zipPath), dest);
        return "node";
      } catch (cause) {
        notes.push(`node: ${(cause as Error).message}`);
        break; // 内置后端都失败，外部工具更不可能成
      }
    }
    if (tool === "tar" || tool === "bsdtar") {
      const note = attempt(tool, ["-xf", zipPath, "-C", dest]);
      if (note === "") return tool;
      notes.push(note);
      continue;
    }
    if (tool === "unzip") {
      const note = attempt("unzip", ["-o", "-q", zipPath, "-d", dest]);
      if (note === "") return "unzip";
      notes.push(note);
      continue;
    }
    if (tool === "python3") {
      const note = attempt("python3", ["-m", "zipfile", "-e", zipPath, dest]);
      if (note === "") return "python3";
      notes.push(note);
      continue;
    }
    if (tool === "powershell") {
      // 用环境变量传参，避免路径里的空格/引号破坏命令行
      const note = attempt(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Expand-Archive -LiteralPath $env:DSH_UPD_ZIP -DestinationPath $env:DSH_UPD_DIR -Force",
        ],
        { env: { ...process.env, DSH_UPD_ZIP: zipPath, DSH_UPD_DIR: dest } },
      );
      if (note === "") return "powershell";
      notes.push(note);
    }
  }
  throw new ZipError(`解压失败：${notes.join(" | ") || "没有可用的解压工具"}`);
}
