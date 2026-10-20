/**
 * 用户 Skill 的安装 / 读取 / 导入导出（`$DSH_HOME/skills`）。
 *
 * ## 修复的原 bug（本文件存在的主要理由之一）
 *
 * 原 `lib/skills.js` 第一行只写了：
 *
 * ```js
 * import { promises as fsp } from "node:fs";
 * ```
 *
 * 却在 `pathsOverlap()` 里用了未导入的 `realpathSync.native`，外层套 `try/catch`。
 * 于是每次调用先抛 `ReferenceError: fs is not defined`，被 catch 吞掉（这正是
 * test/regressions.test.ts 里 BUG-1 那条用例要防的形态）→
 * **realpath 永远不执行** → 比较的是 `path.resolve` 的字面路径 →
 * 「源目录是软链、指向 skills 内部」这种真实场景检测不到 →
 * `removeOfficialSkill` 顺链把 `$DSH_HOME/skills` 删穿。
 *
 * 新实现的三条硬约束：
 *   1. `fs` 真的 import 了，并且**没有任何**路径比较依赖「报错后 fallback」。
 *   2. `resolvePhysical()` 对**尚不存在**的路径也能给出物理路径
 *      （向上找到最近的存在祖先做 realpath，再把不存在的尾段接回去）。
 *      原实现遇到不存在路径直接退回 `path.resolve`，即使 fs 修好了，
 *      「目标还不存在、源是软链」这种情况仍会漏判。
 *   3. 守卫与写入共用同一个物理路径判定，不存在「检查用 A 路径、动作用 B 路径」。
 *
 * ## 命名与边界
 *
 * 与官方 `@deepseek-ai/dsh-skill` 一致用 kebab-case；插件只**安装**目录，
 * 调用走官方 skill 工具，不在 system prompt 里另设入口。
 */
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteFile } from "../fs/atomic.js";
import { extractZipArchive, listZipFile } from "../platform/zip.js";

/** 与官方一致：kebab-case。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_IMPORT_FILES = 200;
const MAX_DESCRIPTION = 500;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const MAX_FIND_DEPTH = 4;

const SKIP_COPY_NAMES: ReadonlySet<string> = new Set([
  ".",
  "..",
  ".system",
  ".git",
  "node_modules",
  "__MACOSX",
  ".DS_Store",
]);

/** 一条 skill 的完整读取结果。 */
export interface SkillRecord {
  readonly id: string;
  readonly kind: "bundle" | "flat";
  readonly path: string;
  readonly content: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
  readonly valid: boolean;
  readonly error: string | null;
  readonly size: number;
}

/** 对外展示用的 skill（路径折叠成 `$DSH_HOME/...`）。 */
export interface PublicSkill {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly path?: string;
  readonly backup?: string;
}

export interface SaveSkillResult {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly backup: string | null;
  readonly size: number;
  readonly content: string;
}

export interface ImportResult {
  readonly imported: readonly PublicSkill[];
}

/** frontmatter 解析结果。 */
export type ParsedSkill =
  | {
      readonly ok: true;
      readonly name: string;
      readonly description: string;
      readonly whenToUse: string;
      readonly modelInvocable: boolean;
      readonly userInvocable: boolean;
      readonly body: string;
      readonly head: string;
    }
  | { readonly ok: false; readonly error: string };

// ───────────────────────────── 路径 ─────────────────────────────

export function validSkillName(id: unknown): id is string {
  return typeof id === "string" && SKILL_NAME_RE.test(id);
}

export function skillsDir(dshHome: string): string {
  return path.join(dshHome, "skills");
}

export function skillBackupDir(dshHome: string): string {
  return path.join(dshHome, "dsh-qilin-backups", "skills");
}

export function skillBundleDir(dshHome: string, id: string): string {
  return path.join(skillsDir(dshHome), id);
}

export function skillBundleFile(dshHome: string, id: string): string {
  return path.join(skillBundleDir(dshHome, id), "SKILL.md");
}

export function skillFlatFile(dshHome: string, id: string): string {
  return path.join(skillsDir(dshHome), `${id}.md`);
}

/** 对外只报 `$DSH_HOME/...`，不暴露本机盘符或安装目录。 */
export function displayUnderHome(dshHome: string, absPath: string): string {
  if (absPath === "") return "";
  const home = path.resolve(dshHome);
  const abs = path.resolve(absPath);
  if (abs === home) return "$DSH_HOME";
  const rel = path.relative(home, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "$DSH_HOME";
  return `$DSH_HOME/${rel.split(/[/\\]/).join("/")}`;
}

/** 把记录里的绝对路径换成 `$DSH_HOME/...` 形态。 */
export function toPublicSkill(dshHome: string, item: SkillRecord | SaveSkillResult | null): PublicSkill | null {
  if (item === null) return null;
  const next: Record<string, unknown> = { ...item };
  if (typeof next["path"] === "string") next["path"] = displayUnderHome(dshHome, next["path"]);
  if (typeof next["backup"] === "string") next["backup"] = displayUnderHome(dshHome, next["backup"]);
  return next as PublicSkill;
}

// ───────────────────────────── 物理路径（真 symlink 解析） ─────────────────────────────

/**
 * 把路径解析成**物理**路径，对不存在的路径也尽力而为。
 *
 * 算法：从自身开始向上找第一个存在的祖先，对它做 `realpath`，
 * 再把中间**不存在的那几段**按原样接回去。
 *
 * 为什么要处理不存在的路径：导入时目标目录通常还不存在
 * （`$DSH_HOME/skills/<id>` 要等导入完成才建）。原实现遇到 ENOENT 直接
 * 退回 `path.resolve`，于是「源是软链、目标还没建」永远判不出重叠。
 *
 * `realpathSync.native` 在 Windows 上还能纠正大小写差异（`C:\Foo` vs `c:\foo`），
 * 所以优先用它；平台没有这个成员时退回 `realpathSync`。
 */
export function resolvePhysical(input: string): string {
  const abs = path.resolve(String(input));
  if (abs === "") return "";
  const missing: string[] = [];
  let probe = abs;
  for (let i = 0; i <= 64; i += 1) {
    const resolved = tryRealpath(probe);
    if (resolved !== null) {
      const physical = missing.length === 0 ? resolved : path.join(resolved, ...missing.slice().reverse());
      return path.normalize(physical);
    }
    const parent = path.dirname(probe);
    if (parent === probe) return path.normalize(abs);
    missing.push(path.basename(probe));
    probe = parent;
  }
  return path.normalize(abs);
}

/** 只对存在的路径调 realpath；不存在 → null（**不是**异常吞掉，是明确的「这里没有实体」）。 */
function tryRealpath(p: string): string | null {
  try {
    // native 在 Windows 上还会纠正大小写差异，优先用；没有就退回普通 realpath。
    const native = fs.realpathSync.native;
    return typeof native === "function" ? native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 两段路径是否重叠（含互相包含）。用物理路径比较，软链会被解开。 */
export function pathsOverlap(a: string, b: string): boolean {
  const left = resolvePhysical(a);
  const right = resolvePhysical(b);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  const leftPrefix = left.endsWith(path.sep) ? left : left + path.sep;
  const rightPrefix = right.endsWith(path.sep) ? right : right + path.sep;
  return left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
}

/**
 * 断言 target 在 root 之内。
 *
 * **两层**：先比字面路径（快、给出好错误），再比物理路径
 * （挡 root 里已有指向外部的 symlink）。第二层不是冗余——第一层只看字符串。
 */
export function assertInside(root: string, target: string): void {
  const a = path.resolve(root);
  const b = path.resolve(target);
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  const literalInside = b === a || b.startsWith(prefix);
  if (!literalInside) throw new Error("skill path escaped official skills directory");
  const physicalRoot = resolvePhysical(a);
  const physicalTarget = resolvePhysical(b);
  if (physicalRoot !== "" && physicalTarget !== "") {
    const physPrefix = physicalRoot.endsWith(path.sep) ? physicalRoot : physicalRoot + path.sep;
    if (physicalTarget !== physicalRoot && !physicalTarget.startsWith(physPrefix)) {
      throw new Error("skill path escaped official skills directory (symlink)");
    }
  }
}

/** 源与 `$DSH_HOME/skills` 重叠时先删后拷会把自己删空（上游 #54）。 */
function assertImportSourceOutsideSkills(dshHome: string, srcPath: string): void {
  if (!pathsOverlap(srcPath, skillsDir(dshHome))) return;
  throw new Error("不能从 $DSH_HOME/skills 自身（或其子目录）导入，请换一个源目录");
}

// ───────────────────────────── YAML frontmatter ─────────────────────────────

function yamlScalar(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text === "") return '""';
  if (/^[A-Za-z0-9._+/-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

export interface FrontmatterParts {
  readonly head: string;
  readonly body: string;
}

/** 切出 `---` 之间的 head 与之后的 body；没有合法 frontmatter → null。 */
export function splitFrontmatter(raw: string): FrontmatterParts | null {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return null;
  const afterOpen = text.slice(3);
  if (!/^\r?\n/.test(afterOpen)) return null;
  const rest = afterOpen.replace(/^\r?\n/, "");
  const close = rest.match(/\r?\n---(?:\r?\n|$)/);
  if (close === null || close.index === undefined) return null;
  return {
    head: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

/**
 * 转义进 RegExp 的字面量。
 *
 * 当前调用点都是硬编码 key，但 key 一旦变成数据驱动，`.` / `$` / `(` 会成为
 * 元字符：轻则错配，重则 ReDoS。
 */
function escapeYamlKey(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * YAML 块标量解析：覆盖 `|`、`>`、`|-`、`|+`、`>-`、`>+`、`|2` 等 chomp/indent 指示。
 *
 * 只扫 frontmatter，返回**压成单行**的字符串（换行 → 空格），因为上游面板按单行描述渲染。
 * 不支持 anchor / alias / tag / 多行 flow——SKILL.md 不该出现。
 */
function blockScalarValue(head: string, key: string): string {
  const lines = head.split(/\r?\n/);
  const headerRe = new RegExp(`^(\\s*)${escapeYamlKey(key)}:\\s*([|>])([+-]?)(\\d*)\\s*(?:#.*)?$`);
  let headerIdx = -1;
  let keyIndent = 0;
  let style = "|";
  let chomp = "";
  let indentHint = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(headerRe);
    if (m === null) continue;
    headerIdx = i;
    keyIndent = (m[1] ?? "").length;
    style = m[2] ?? "|";
    chomp = m[3] ?? "";
    indentHint = m[4] !== undefined && m[4] !== "" ? Number.parseInt(m[4], 10) : 0;
    break;
  }
  if (headerIdx < 0) return "";
  const body: string[] = [];
  let blockIndent = indentHint > 0 ? keyIndent + indentHint : 0;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (indent <= keyIndent) break;
    if (blockIndent === 0) blockIndent = indent;
    if (indent < blockIndent) break;
    body.push(line.slice(blockIndent));
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  let text: string;
  if (style === "|") {
    text = body.join("\n");
  } else {
    text = "";
    for (let i = 0; i < body.length; i += 1) {
      const cur = body[i] ?? "";
      if (i === 0) {
        text += cur;
        continue;
      }
      if (cur === "") {
        text += "\n";
        continue;
      }
      if (body[i - 1] === "") {
        text += cur;
        continue;
      }
      text += " " + cur;
    }
  }
  if (chomp === "+") text += "\n";
  else if (chomp !== "-" && text.length > 0) text += "\n";
  return text.replace(/\s+/g, " ").trim();
}

function yamlLineField(head: string, key: string): string {
  const re = new RegExp(`^${escapeYamlKey(key)}:\\s*(.*)$`, "m");
  const match = head.match(re);
  const raw = match?.[1];
  if (raw === undefined) return "";
  const value = raw.trim();
  if (value === "") return "";
  // 块标量：`|` / `>`，可带 chomp（`-`/`+`）或 indent 指示（`|2`）→ 交给正文解析。
  //
  // 注意这个字符类是 `[+-]?\d*`（符号在前、缩进在后），所以 `|-2` / `|+2` 命中，
  // 而 YAML 规范同样合法的 `|2-` / `>2+`（缩进在前）**不命中**，会被当成普通标量
  // 原样返回 "|2-"。这是原实现的既有行为，这里逐字保留（差分测试钉死），
  // 因为改动会让同一份 SKILL.md 在旧新两版解析出不同 description。
  if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(value)) return blockScalarValue(head, key);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return value.startsWith('"') ? String(JSON.parse(value)) : value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  const comment = value.indexOf(" #");
  const trimmed = comment >= 0 ? value.slice(0, comment).trim() : value;
  return trimmed;
}

interface BoolField {
  readonly present: boolean;
  readonly value?: boolean;
  readonly invalid?: true;
}

function yamlBoolField(head: string, key: string): BoolField {
  const re = new RegExp(`^${escapeYamlKey(key)}:\\s*(.*)$`, "m");
  const match = head.match(re);
  const raw = match?.[1];
  if (raw === undefined) return { present: false };
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  const comment = value.indexOf(" #");
  if (comment >= 0) value = value.slice(0, comment).trim();
  const norm = value.toLowerCase();
  if (norm === "true" || norm === "yes" || norm === "on" || norm === "1") return { present: true, value: true };
  if (norm === "false" || norm === "no" || norm === "off" || norm === "0") return { present: true, value: false };
  return { present: true, invalid: true };
}

/** 解析 SKILL.md。`ok: false` 时 `error` 是可展示给用户的中文原因。 */
export function parseSkillDocument(raw: string): ParsedSkill {
  const parts = splitFrontmatter(raw);
  if (parts === null) return { ok: false, error: "缺少 YAML frontmatter（须以 --- 包围）" };
  const name = yamlLineField(parts.head, "name");
  const description = yamlLineField(parts.head, "description");
  if (!validSkillName(name)) {
    return { ok: false, error: "frontmatter.name 必须是 kebab-case，例如 code-review" };
  }
  if (description === "") return { ok: false, error: "frontmatter.description 必填（单行）" };
  const disableModel = yamlBoolField(parts.head, "disable-model-invocation");
  const userInvocable = yamlBoolField(parts.head, "user-invocable");
  if (disableModel.invalid === true) {
    return { ok: false, error: "disable-model-invocation 必须是布尔值（true/false）" };
  }
  if (userInvocable.invalid === true) {
    return { ok: false, error: "user-invocable 必须是布尔值（true/false）" };
  }
  return {
    ok: true,
    name,
    description,
    whenToUse: yamlLineField(parts.head, "whenToUse"),
    modelInvocable: disableModel.value !== true,
    userInvocable: userInvocable.value !== false,
    body: parts.body,
    head: parts.head,
  };
}

/** 生成一份最小 SKILL.md。 */
export function renderSkillDocument(id: string, description: string, body = ""): string {
  if (!validSkillName(id)) throw new Error("invalid skill name");
  const desc = description.trim() === "" ? id : description.trim();
  const text = body.replace(/^\uFEFF/, "");
  const parts = splitFrontmatter(text);
  const inner = parts === null ? text : parts.body;
  return `---\nname: ${id}\ndescription: ${yamlScalar(desc.slice(0, MAX_DESCRIPTION))}\n---\n\n${inner.replace(/^\r?\n/, "")}`;
}

function upsertYamlLine(head: string, key: string, value: string): string {
  const line = `${key}: ${yamlScalar(value)}`;
  const re = new RegExp(`^${escapeYamlKey(key)}:\\s*.*$`, "m");
  if (re.test(head)) return head.replace(re, line);
  return `${line}\n${head.replace(/^\r?\n/, "")}`;
}

/** 保留官方 whenToUse / invocation / metadata，只改 name 与 description。 */
export function mergeSkillDocument(id: string, description: string, raw = ""): string {
  const parsed = parseSkillDocument(raw);
  const desc =
    description.trim() !== "" ? description.trim() : parsed.ok ? parsed.description : "";
  if (!parsed.ok) return renderSkillDocument(id, desc === "" ? id : desc, raw);
  const head = upsertYamlLine(
    upsertYamlLine(parsed.head, "name", id),
    "description",
    (desc === "" ? id : desc).slice(0, MAX_DESCRIPTION),
  );
  return `---\n${head.replace(/^\r?\n/, "").replace(/\r?\n$/, "")}\n---\n\n${parsed.body.replace(/^\r?\n/, "")}`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

// ───────────────────────────── 读 ─────────────────────────────

async function pathExists(fp: string): Promise<boolean> {
  try {
    await fsp.access(fp);
    return true;
  } catch {
    return false;
  }
}

async function skillFromFile(id: string, fp: string, kind: "bundle" | "flat"): Promise<SkillRecord> {
  const content = await fsp.readFile(fp, "utf8");
  const parsed = parseSkillDocument(content);
  return {
    id,
    kind,
    path: fp,
    content,
    description: parsed.ok ? parsed.description : "",
    whenToUse: parsed.ok ? parsed.whenToUse : "",
    modelInvocable: parsed.ok ? parsed.modelInvocable : false,
    userInvocable: parsed.ok ? parsed.userInvocable : false,
    valid: parsed.ok,
    error: parsed.ok ? null : parsed.error,
    size: Buffer.byteLength(content, "utf8"),
  };
}

/** 按 id 读一条 skill：bundle 优先，再 flat，最后扫目录按 frontmatter.name 匹配。 */
export async function readSkill(dshHome: string, id: string): Promise<SkillRecord | null> {
  if (!validSkillName(id)) throw new Error(`invalid skill name: ${id}`);
  const bundle = skillBundleFile(dshHome, id);
  if (await pathExists(bundle)) return skillFromFile(id, bundle, "bundle");
  const flat = skillFlatFile(dshHome, id);
  if (await pathExists(flat)) return skillFromFile(id, flat, "flat");
  const dir = skillsDir(dshHome);
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".system") continue;
    const fp = path.join(dir, entry.name, "SKILL.md");
    if (!(await pathExists(fp))) continue;
    const parsed = parseSkillDocument(await fsp.readFile(fp, "utf8"));
    if (parsed.ok && parsed.name === id) return skillFromFile(id, fp, "bundle");
  }
  return null;
}

/** 列出所有可识别的 skill，按 id 去重、按目录名排序。 */
export async function listSkills(dshHome: string): Promise<readonly SkillRecord[]> {
  const dir = skillsDir(dshHome);
  const out: SkillRecord[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".system") continue;
    if (entry.isDirectory()) {
      const fp = path.join(dir, entry.name, "SKILL.md");
      if (!(await pathExists(fp))) continue;
      const parsed = parseSkillDocument(await fsp.readFile(fp, "utf8"));
      const id = parsed.ok ? parsed.name : validSkillName(entry.name) ? entry.name : "";
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      out.push(await skillFromFile(id, fp, "bundle"));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
    const fallback = entry.name.slice(0, -3);
    const fp = path.join(dir, entry.name);
    const parsed = parseSkillDocument(await fsp.readFile(fp, "utf8"));
    const id = parsed.ok ? parsed.name : validSkillName(fallback) ? fallback : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(await skillFromFile(id, fp, "flat"));
  }
  return out;
}

// ───────────────────────────── 写 ─────────────────────────────

/**
 * 递归复制目录。
 *
 * 安全点：**跳过符号链接**。`entry.isSymbolicLink()` 先判，
 * 否则软链到外部的大目录会被整棵拷进来，甚至形成环。
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    if (SKIP_COPY_NAMES.has(entry.name) || entry.name.startsWith("._")) continue;
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    assertInside(dest, to);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

async function backupExisting(dshHome: string, id: string): Promise<string | null> {
  const existing = await readSkill(dshHome, id).catch(() => null);
  const root = skillsDir(dshHome);
  const bundleDir = existing?.kind === "bundle" ? path.dirname(existing.path) : skillBundleDir(dshHome, id);
  const flat = existing?.kind === "flat" ? existing.path : skillFlatFile(dshHome, id);
  const hasBundle = await pathExists(bundleDir);
  const hasFlat = await pathExists(flat);
  if (!hasBundle && !hasFlat) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniq = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const dest = path.join(skillBackupDir(dshHome), `${id}_${stamp}_${uniq}`);
  assertInside(path.join(dshHome, "dsh-qilin-backups"), dest);
  await fsp.mkdir(dest, { recursive: true });
  if (hasBundle) {
    assertInside(root, bundleDir);
    await copyDir(bundleDir, path.join(dest, id));
  }
  if (hasFlat) {
    assertInside(root, flat);
    await fsp.copyFile(flat, path.join(dest, `${id}.md`));
  }
  return dest;
}

async function removeOfficialSkill(dshHome: string, id: string): Promise<void> {
  const existing = await readSkill(dshHome, id).catch(() => null);
  const root = skillsDir(dshHome);
  const bundleDir = existing?.kind === "bundle" ? path.dirname(existing.path) : skillBundleDir(dshHome, id);
  const flat = existing?.kind === "flat" ? existing.path : skillFlatFile(dshHome, id);
  if (await pathExists(bundleDir)) {
    assertInside(root, bundleDir);
    await fsp.rm(bundleDir, { recursive: true, force: true });
  }
  if (await pathExists(flat)) {
    assertInside(root, flat);
    await fsp.rm(flat, { force: true });
  }
  const canonical = skillBundleDir(dshHome, id);
  if (canonical !== bundleDir && (await pathExists(canonical))) {
    assertInside(root, canonical);
    await fsp.rm(canonical, { recursive: true, force: true });
  }
}

async function restoreSkillFromBackup(dshHome: string, id: string, backup: string | null): Promise<void> {
  if (backup === null) return;
  const root = skillsDir(dshHome);
  const bundleSrc = path.join(backup, id);
  const flatSrc = path.join(backup, `${id}.md`);
  try {
    if (await pathExists(bundleSrc)) {
      const dest = skillBundleDir(dshHome, id);
      assertInside(root, dest);
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => undefined);
      await copyDir(bundleSrc, dest);
    }
    if (await pathExists(flatSrc)) {
      const dest = skillFlatFile(dshHome, id);
      assertInside(root, dest);
      await fsp.copyFile(flatSrc, dest);
    }
  } catch {
    // 回滚失败时保留 backup 路径给调用方。
  }
}

/**
 * 保存一条 skill（写成 `<id>/SKILL.md`）。
 *
 * 写失败必须**回滚**：先备份，再删旧的，再原子写。任何一步失败都把备份还原回去，
 * 否则用户手上那条就成了半个文件。
 */
export async function saveSkill(
  dshHome: string,
  id: string,
  content: string,
  description = "",
): Promise<SaveSkillResult> {
  if (!validSkillName(id)) throw new Error(`invalid skill name: ${id}`);
  const parsed = parseSkillDocument(content);
  const desc = description.trim() !== "" ? description.trim() : parsed.ok ? parsed.description : "";
  const document = mergeSkillDocument(id, desc, content);
  if (Buffer.byteLength(document, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("skill too large (max 256KB)");
  }
  const check = parseSkillDocument(document);
  if (!check.ok) throw new Error(check.error);
  const root = skillsDir(dshHome);
  const dest = skillBundleFile(dshHome, id);
  assertInside(root, dest);
  const backup = await backupExisting(dshHome, id);
  try {
    await removeOfficialSkill(dshHome, id);
    await fsp.mkdir(skillBundleDir(dshHome, id), { recursive: true });
    await atomicWriteFile(dest, document);
  } catch (err) {
    try {
      await restoreSkillFromBackup(dshHome, id, backup);
    } catch {
      /* 回滚也失败时保留原始错误 */
    }
    throw err;
  }
  return {
    id,
    path: dest,
    description: check.description,
    backup,
    size: Buffer.byteLength(document, "utf8"),
    content: document,
  };
}

export async function deleteSkill(
  dshHome: string,
  id: string,
): Promise<{ readonly id: string; readonly backup: string | null; readonly path: string }> {
  if (!validSkillName(id)) throw new Error(`invalid skill name: ${id}`);
  const existing = await readSkill(dshHome, id);
  if (existing === null) throw new Error(`skill not found: ${id}`);
  const backup = await backupExisting(dshHome, id);
  await removeOfficialSkill(dshHome, id);
  return { id, backup, path: existing.path };
}

// ───────────────────────────── 导入 ─────────────────────────────

function kebabFromLabel(name: string): string {
  const base = String(name ?? "")
    .replace(/\.(zip|tgz|tar\.gz|tar|skill)$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return validSkillName(base) ? base : "";
}

/**
 * 压缩包条目名是否危险（绝对路径 / `..` / 空段）。
 *
 * ## 与原实现的刻意分歧（安全收紧，不是放宽）
 *
 * 原实现第一步就 `.replace(/^\.?\//, "")`，**把开头的 `/` 先删掉了**，
 * 于是 `"/etc/passwd"` 变成 `"etc/passwd"`，后续 `rel.startsWith("/")` 永远为假
 * → 绝对路径条目被判成「安全」。实测：
 *
 * ```js
 * isUnsafeArchiveEntry("/etc/passwd")   // 原实现 → false（漏判）
 * ```
 *
 * 漏判本身没直接造成写入逃逸（真正兜底的是 `extractZipBuffer` 的第二层
 * 绝对路径校验和 `assertInside`），但「第一层防护拦不住绝对路径」这件事
 * 意味着任何**绕过第二层**的后端（外部 `tar`/`unzip` 命令）都会失守。
 *
 * 所以这里在剥前导斜杠**之前**先判绝对路径。契约是「严格超集」：
 * 原实现判 true 的，这里一定 true（差分测试钉死）；原实现漏的，这里补上。
 */
export function isUnsafeArchiveEntry(name: string): boolean {
  const raw = String(name ?? "").replace(/\\/g, "/");
  // 先看原样：绝对路径（POSIX / UNC / Windows 盘符）。
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return true;
  const rel = raw.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (rel === "") return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return true;
  return rel.split("/").some((part) => part === ".." || part === "");
}

function splitLines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function listArchiveEntries(archivePath: string): string[] | null {
  const tar = spawnSync("tar", ["-tf", archivePath], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
  if (tar.status === 0) return splitLines(tar.stdout);
  if (/\.zip$/i.test(archivePath)) {
    const unzip = spawnSync("unzip", ["-Z1", archivePath], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (unzip.status === 0) return splitLines(unzip.stdout);
    try {
      return listZipFile(archivePath);
    } catch {
      return null;
    }
  }
  return null;
}

function extractArchive(archivePath: string, dest: string): void {
  const entries = listArchiveEntries(archivePath);
  if (entries !== null && entries.some(isUnsafeArchiveEntry)) {
    throw new Error("压缩包路径不合法");
  }
  if (entries !== null && entries.length > MAX_IMPORT_FILES) {
    throw new Error("压缩包里文件太多");
  }
  if (/\.zip$/i.test(archivePath)) {
    try {
      extractZipArchive(archivePath, dest);
      return;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }
  const result = spawnSync("tar", ["-xf", archivePath, "-C", dest], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status === 0) return;
  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(detail === "" ? "无法解压，请改用文件夹导入" : detail);
}

async function walkFiles(root: string, onFile: (fp: string) => Promise<void>, depth = 0): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name === "." ||
      entry.name === ".." ||
      entry.name === ".system" ||
      entry.name === "__MACOSX" ||
      entry.name === ".DS_Store"
    ) {
      continue;
    }
    if (entry.name.startsWith("._")) continue;
    const full = path.join(root, entry.name);
    assertInside(root, full);
    if (entry.isDirectory()) await walkFiles(full, onFile, depth + 1);
    else if (entry.isFile()) await onFile(full);
  }
}

/** 在一个目录里找 skill 根（含 `SKILL.md` 的目录，或合法 flat `.md`）。 */
export async function findSkillRoots(root: string): Promise<{ dirs: string[]; flats: string[] }> {
  const dirs: string[] = [];
  const flats: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > MAX_FIND_DEPTH) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      dirs.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        const raw = await fsp.readFile(path.join(dir, entry.name), "utf8");
        if (parseSkillDocument(raw).ok) flats.push(path.join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "." || entry.name === ".." || entry.name === ".system" || entry.name === "__MACOSX") {
        continue;
      }
      const next = path.join(dir, entry.name);
      assertInside(root, next);
      await visit(next, depth + 1);
    }
  }
  await visit(root, 0);
  return { dirs, flats };
}

async function installBundleDir(dshHome: string, srcDir: string, fallbackId: string): Promise<SaveSkillResult> {
  assertImportSourceOutsideSkills(dshHome, srcDir);
  const mdPath = path.join(srcDir, "SKILL.md");
  const raw = await fsp.readFile(mdPath, "utf8");
  const parsed = parseSkillDocument(raw);
  const id = parsed.ok ? parsed.name : kebabFromLabel(fallbackId === "" ? path.basename(srcDir) : fallbackId);
  if (!validSkillName(id)) throw new Error("压缩包/文件夹里没有合法的 Skill 名称");
  const dest = skillBundleDir(dshHome, id);
  assertInside(skillsDir(dshHome), dest);
  // 目标目录本身也在 skills 里，用它自己的物理路径再判一次重叠。
  if (pathsOverlap(srcDir, dest)) {
    throw new Error("不能从目标技能目录自身导入，请换一个源目录");
  }
  const backup = await backupExisting(dshHome, id);
  await removeOfficialSkill(dshHome, id);
  try {
    await copyDir(srcDir, dest);
    const destMd = path.join(dest, "SKILL.md");
    if (!(await pathExists(destMd))) throw new Error("导入后缺少 SKILL.md");
    if (parsed.ok && parsed.name !== id) {
      await fsp.writeFile(destMd, mergeSkillDocument(id, parsed.description, raw), "utf8");
    } else if (!parsed.ok && !raw.replace(/^\uFEFF/, "").startsWith("---")) {
      await fsp.writeFile(destMd, renderSkillDocument(id, id, raw), "utf8");
    }
    return {
      id,
      path: destMd,
      backup,
      description: parsed.ok ? parsed.description : id,
      size: Buffer.byteLength(raw, "utf8"),
      content: raw,
    };
  } catch (err) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    await restoreSkillFromBackup(dshHome, id, backup);
    throw err;
  }
}

async function installFlatFile(dshHome: string, srcFile: string, fallbackId: string): Promise<SaveSkillResult> {
  assertImportSourceOutsideSkills(dshHome, srcFile);
  const raw = await fsp.readFile(srcFile, "utf8");
  const parsed = parseSkillDocument(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const id = parsed.name === "" ? kebabFromLabel(fallbackId || path.basename(srcFile, ".md")) : parsed.name;
  return saveSkill(dshHome, id, raw, parsed.description);
}

async function installFoundSkills(
  dshHome: string,
  root: string,
  fallbackId: string,
): Promise<readonly SaveSkillResult[]> {
  assertImportSourceOutsideSkills(dshHome, root);
  const found = await findSkillRoots(root);
  const imported: SaveSkillResult[] = [];
  for (const dir of found.dirs) {
    imported.push(await installBundleDir(dshHome, dir, fallbackId === "" ? path.basename(dir) : fallbackId));
  }
  if (imported.length === 0) {
    for (const file of found.flats) {
      imported.push(await installFlatFile(dshHome, file, fallbackId));
    }
  }
  if (imported.length === 0) throw new Error("未找到 SKILL.md 或合法的 Skill 文件");
  return imported;
}

/** 导入一个压缩包（zip / tar / tar.gz / skill）。 */
export async function importArchive(
  dshHome: string,
  buffer: Buffer,
  filename = "skill.zip",
): Promise<ImportResult> {
  if (buffer.length === 0) throw new Error("压缩包是空的");
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error("压缩包太大（最大 12MB）");
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "dshp-skill-"));
  const archive = path.join(temp, path.basename(filename) === "" ? "skill.zip" : path.basename(filename));
  const unpacked = path.join(temp, "unpacked");
  try {
    await fsp.mkdir(unpacked, { recursive: true });
    await fsp.writeFile(archive, buffer);
    extractArchive(archive, unpacked);
    let total = 0;
    await walkFiles(unpacked, async (fp) => {
      // 非 ENOENT 的 fs 错误要 rethrow：否则磁盘损坏 / EACCES / EMFILE 都被吞，
      // size 累计漏算，导入看似成功但产物坏。ENOENT 是「枚举后被外部删了」，安全跳过。
      let st: import("node:fs").Stats;
      try {
        st = await fsp.stat(fp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      total += st.size;
      if (total > MAX_UNPACKED_BYTES) {
        throw new Error(`压缩包解压后超过 ${Math.floor(MAX_UNPACKED_BYTES / 1024 / 1024)}MB`);
      }
    });
    const imported = await installFoundSkills(dshHome, unpacked, kebabFromLabel(filename));
    return { imported: imported.map((item) => toPublicSkill(dshHome, item)).filter(isPublicSkill) };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isPublicSkill(value: PublicSkill | null): value is PublicSkill {
  return value !== null;
}

/** 导入一组内存中的文件（浏览器上传的目录树）。 */
export async function importFileTree(
  dshHome: string,
  files: readonly { readonly path?: string; readonly name?: string; readonly content?: unknown; readonly encoding?: string }[],
  fallbackId = "",
): Promise<ImportResult> {
  if (files.length === 0) throw new Error("文件夹是空的");
  if (files.length > MAX_IMPORT_FILES) throw new Error("文件夹里文件太多");
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "dshp-skill-"));
  try {
    let total = 0;
    for (const file of files) {
      const rel = String(file.path ?? file.name ?? "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
      if (rel === "" || rel.includes("..") || path.isAbsolute(rel) || isUnsafeArchiveEntry(rel)) {
        throw new Error("文件夹路径不合法");
      }
      const dest = path.join(temp, rel);
      assertInside(temp, dest);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const text = typeof file.content === "string" ? file.content : "";
      const raw = file.encoding === "base64" ? Buffer.from(text, "base64") : Buffer.from(text, "utf8");
      total += raw.length;
      if (raw.length > MAX_ARCHIVE_BYTES || total > MAX_ARCHIVE_BYTES) throw new Error("文件太大");
      await fsp.writeFile(dest, raw);
    }
    const imported = await installFoundSkills(dshHome, temp, fallbackId);
    return { imported: imported.map((item) => toPublicSkill(dshHome, item)).filter(isPublicSkill) };
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 从磁盘路径导入（目录或压缩包或单个 md）。 */
export async function importFromPath(dshHome: string, sourcePath: string): Promise<ImportResult> {
  const src = path.resolve(String(sourcePath ?? ""));
  if (src === "") throw new Error("只能导入压缩包或文件夹");
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    const imported = await installFoundSkills(dshHome, src, kebabFromLabel(path.basename(src)));
    return { imported: imported.map((item) => toPublicSkill(dshHome, item)).filter(isPublicSkill) };
  }
  if (stat.isFile()) {
    const name = path.basename(src);
    if (/\.(zip|tgz|tar\.gz|tar|skill)$/i.test(name)) {
      return importArchive(dshHome, await fsp.readFile(src), name);
    }
    const saved = await installFlatFile(dshHome, src, kebabFromLabel(name));
    const pub = toPublicSkill(dshHome, saved);
    return { imported: pub === null ? [] : [pub] };
  }
  throw new Error("只能导入压缩包或文件夹");
}

/** 给 `/skills list` 用的状态快照。 */
export interface SkillsStatus {
  readonly skills_dir: string;
  readonly skills: readonly {
    readonly id: string;
    readonly description: string;
    readonly kind: "bundle" | "flat";
    readonly valid: boolean;
    readonly error: string | null;
    readonly size: number;
    readonly path: string;
  }[];
}

export async function skillsStatus(dshHome: string): Promise<SkillsStatus> {
  const listed = await listSkills(dshHome);
  return {
    skills_dir: "$DSH_HOME/skills",
    skills: listed.map((item) => ({
      id: item.id,
      description: item.description,
      kind: item.kind,
      valid: item.valid,
      error: item.error,
      size: item.size,
      path: displayUnderHome(dshHome, item.path),
    })),
  };
}

/** 只给测试/诊断用：确认本模块拿到的 `fs` 是真模块而不是 undefined。 */
export function hasRealFsBinding(): boolean {
  return typeof fs.realpathSync === "function" && typeof fs.realpathSync.native === "function";
}
