/**
 * 规则集（rules）：`$DSH_HOME/rules/*.md` 的增删改，以及「激活」——把某条规则写进
 * `$DSH_HOME/AGENTS.md` 或 `CLAUDE.md`。
 *
 * ## 为什么规则集不参与 system 注入链
 *
 * 提示词（inject）与规则集是两条独立通道：
 *   - inject 走 `prompt-inject.md` → system prompt 段；
 *   - 规则集只改 agents 目标文件（`AGENTS.md` / `CLAUDE.md`），由官方
 *     `dsh-agent-instructions` 读进系统提示。
 *
 * 原实现把两者混在一个 `resolveInjectText` 里，导致「激活规则」到底改了什么说不清。
 * 这里分开：`injectSource` 只陈述状态，`activateRule` 只动目标文件。
 *
 * ## 保留的硬约束（原注释踩过的坑）
 *
 * 1. **激活前备份，但只备份「不是插件自己写的那份」**。否则反复激活会把
 *    插件产物当原件备份，回滚就回不到原始 AGENTS.md。
 * 2. **写目标文件用原子写**；写规则文件 + 元数据要能双回滚。
 * 3. **cwd 规则只认当前 cwd 扫描结果里的路径**，防止切换目录后旧勾选跨目录穿越注入。
 * 4. **`writeLastCwd` 有进程内去重**：assemble 空闲时每秒 7~9 次调用，
 *    无条件 mkdir+write 等于持续写盘。
 */
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { atomicWriteFile, atomicWriteFileSync, isRegularFile } from "../fs/atomic.js";
import type { PromptState, ResolvedInject } from "./prompt-state.js";

const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_RULE_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 64;

/** 规则能被写进的两个目标文件。顺序即回滚顺序。 */
export const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"] as const;
export type RuleTarget = (typeof RULE_TARGETS)[number];

/** 备份后缀。与 dsh-qilin 一致，便于用户从旧安装迁移时复用备份。 */
const BACKUP_SUFFIX = ".dsh-qilin-rule.bak";

// CWD 规则：扫 cwd → projectRoot 范围内的工作区指令文件，给 UI 展示并允许勾选参与注入。
// 命中与 @deepseek-ai/dsh-agent-instructions 的默认候选保持一致。
const CWD_CANDIDATE_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"] as const;
const PROJECT_ROOT_MARKERS = [".git", ".hg", ".svn"] as const;
/** 工作区策略：`fallback` 有 inject 就丢 baseline；`strict` 永远丢；`always` 永远留。 */
export const WORKSPACE_POLICIES = ["fallback", "strict", "always"] as const;
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number];
const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = "fallback";
const MAX_CWD_WALK_DEPTH = 32;
const MAX_LOCAL_INJECT_BYTES = 512 * 1024;

/** 一条规则的列表项。 */
export interface RuleEntry {
  readonly id: string;
  readonly name: string;
  readonly target: RuleTarget;
  readonly size: number;
}

/** 规则元数据。 */
export interface RuleMeta {
  readonly name: string;
  readonly target: RuleTarget;
}

// ───────────────────────────── 路径 ─────────────────────────────

function qilinStateDir(dshHome: string): string {
  return path.join(dshHome, "dsh-qilin");
}

function cwdSelectionsPath(dshHome: string): string {
  return path.join(qilinStateDir(dshHome), "cwd-selections.json");
}

function workspacePolicyPath(dshHome: string): string {
  return path.join(qilinStateDir(dshHome), "workspace-policy.json");
}

function lastCwdPath(dshHome: string): string {
  return path.join(qilinStateDir(dshHome), "last-cwd.txt");
}

export function rulesDir(dshHome: string): string {
  return path.join(dshHome, "rules");
}

export function stateFile(dshHome: string): string {
  return path.join(rulesDir(dshHome), "state.json");
}

export function rulePath(dshHome: string, id: string): string {
  return path.join(rulesDir(dshHome), `${id}.md`);
}

export function ruleMetaPath(dshHome: string, id: string): string {
  return path.join(rulesDir(dshHome), `${id}.json`);
}

export function validRuleId(id: unknown): id is string {
  return typeof id === "string" && RULE_ID_RE.test(id);
}

export function validTarget(target: unknown): target is RuleTarget {
  return typeof target === "string" && (RULE_TARGETS as readonly string[]).includes(target);
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

export function targetPath(dshHome: string, target: RuleTarget): string {
  return path.join(dshHome, target);
}

// ───────────────────────────── 元数据 ─────────────────────────────

export function normalizeMeta(id: string, meta: unknown): RuleMeta {
  const record = meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>) : null;
  const rawName = record?.["name"];
  const name =
    typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim().slice(0, MAX_NAME_LENGTH) : id;
  const rawTarget = record?.["target"];
  return { name, target: validTarget(rawTarget) ? rawTarget : "AGENTS.md" };
}

export async function readRuleMeta(dshHome: string, id: string): Promise<RuleMeta> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(ruleMetaPath(dshHome, id), "utf8"));
    return normalizeMeta(id, parsed);
  } catch {
    return normalizeMeta(id, null);
  }
}

export async function writeRuleMeta(dshHome: string, id: string, meta: unknown): Promise<void> {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });
  await atomicWriteFile(ruleMetaPath(dshHome, id), JSON.stringify(normalizeMeta(id, meta), null, 2));
}

// ───────────────────────────── 读 ─────────────────────────────

function readRuleContentSync(dshHome: string, id: string): string | null {
  try {
    return fs.readFileSync(rulePath(dshHome, id), "utf8");
  } catch {
    return null;
  }
}

/** 收集所有规则正文（判「目标文件里的是不是插件写的」用）。 */
async function collectRuleContents(dshHome: string): Promise<ReadonlySet<string>> {
  const listed = await listRules(dshHome);
  const contents = new Set<string>();
  for (const rule of listed) {
    const content = readRuleContentSync(dshHome, rule.id);
    if (content !== null) contents.add(content);
  }
  return contents;
}

export async function listRules(dshHome: string): Promise<readonly RuleEntry[]> {
  const dir = rulesDir(dshHome);
  const out: RuleEntry[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // rules 目录不存在时按空列表返回
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    if (!validRuleId(id)) continue;
    let size = 0;
    try {
      size = (await fsp.stat(path.join(dir, entry.name))).size;
    } catch {
      /* 统计失败按 0，不影响列表 */
    }
    const meta = await readRuleMeta(dshHome, id);
    out.push({ id, name: meta.name, target: meta.target, size });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function readRule(dshHome: string, id: string): Promise<string | null> {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  try {
    return await fsp.readFile(rulePath(dshHome, id), "utf8");
  } catch {
    return null;
  }
}

export async function readActive(dshHome: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(stateFile(dshHome), "utf8"));
    const active = (parsed as { active?: unknown } | null)?.active;
    return validRuleId(active) ? active : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── 写 ─────────────────────────────

export async function setActive(dshHome: string, id: string): Promise<void> {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });
  await fsp.writeFile(stateFile(dshHome), JSON.stringify({ active: id }, null, 2), "utf8");
}

/**
 * 保存一条规则。
 *
 * 双写（`.md` + `.json`）失败时回滚**两边**：只有一边成功会让列表项与正文不匹配，
 * 用户看到「有这条规则但打不开」。
 */
export async function saveRule(dshHome: string, id: string, content: string, meta: unknown): Promise<void> {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  if (Buffer.byteLength(content, "utf8") > MAX_RULE_BYTES) {
    throw new Error("rule too large (max 256KB)");
  }
  await fsp.mkdir(rulesDir(dshHome), { recursive: true });

  const rulePathStr = rulePath(dshHome, id);
  const metaPathStr = ruleMetaPath(dshHome, id);
  let prevRule: string | null = null;
  let prevMeta: string | null = null;
  try {
    prevRule = await fsp.readFile(rulePathStr, "utf8");
  } catch {
    /* 新 rule */
  }
  try {
    prevMeta = await fsp.readFile(metaPathStr, "utf8");
  } catch {
    /* 新 rule */
  }

  let wroteRule = false;
  let wroteMeta = false;
  try {
    await atomicWriteFile(rulePathStr, content);
    wroteRule = true;
    await writeRuleMeta(dshHome, id, meta);
    wroteMeta = true;
    if ((await readActive(dshHome)) === id) await activateRule(dshHome, id);
  } catch (err) {
    if (wroteRule) {
      try {
        if (prevRule === null) await fsp.unlink(rulePathStr).catch(() => undefined);
        else await atomicWriteFile(rulePathStr, prevRule);
      } catch {
        /* 回滚失败，原错继续抛 */
      }
    }
    if (wroteMeta && prevMeta !== null) {
      try {
        await atomicWriteFile(metaPathStr, prevMeta);
      } catch {
        /* ignore */
      }
    } else if (wroteMeta && prevMeta === null) {
      try {
        await fsp.unlink(metaPathStr).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

export async function deleteRule(dshHome: string, id: string): Promise<void> {
  if (!validRuleId(id)) throw new Error(`invalid rule id: ${id}`);
  try {
    await fsp.unlink(rulePath(dshHome, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await fsp.unlink(ruleMetaPath(dshHome, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if ((await readActive(dshHome)) === id) {
    try {
      await fsp.unlink(stateFile(dshHome));
    } catch {
      /* 状态文件可能已不存在 */
    }
  }
}

/**
 * 激活一条规则：写进它的目标文件，并把 id 记成 active。
 *
 * 备份规则（唯一的回滚路径）：**目标文件的内容如果本身就是某条规则**，
 * 说明它是插件的产物，不该被当成原件备份。
 */
export async function activateRule(dshHome: string, id: string): Promise<RuleMeta> {
  const content = await readRule(dshHome, id);
  if (content === null) throw new Error(`rule not found: ${id}`);
  const meta = await readRuleMeta(dshHome, id);
  const target = targetPath(dshHome, meta.target);
  const backup = `${target}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) {
    try {
      const existing = await fsp.readFile(target, "utf8");
      const ruleContents = await collectRuleContents(dshHome);
      if (!ruleContents.has(existing)) {
        atomicWriteFileSync(backup, existing);
      }
    } catch {
      /* target 不存在 → 无需备份 */
    }
  }
  await atomicWriteFile(target, content);
  await setActive(dshHome, id);
  return meta;
}

/** 启动时的状态自检：active 指向的规则已经不存在就清掉状态。 */
export async function ensureInitialState(dshHome: string): Promise<{ readonly active: string | null }> {
  const listed = await listRules(dshHome);
  let active = await readActive(dshHome);
  if (active !== null && !listed.some((rule) => rule.id === active)) {
    try {
      await fsp.unlink(stateFile(dshHome));
    } catch {
      /* ignore */
    }
    active = null;
  }
  return { active };
}

export interface ResetReport {
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
  readonly restored: readonly string[];
}

/** 还原到「插件介入之前」：优先用备份恢复，其次删除「内容仍是某条规则」的目标文件。 */
export async function resetToOriginal(dshHome: string): Promise<ResetReport> {
  const active = await readActive(dshHome);
  const removed: string[] = [];
  const skipped: string[] = [];
  const restored: string[] = [];

  for (const target of RULE_TARGETS) {
    const fp = targetPath(dshHome, target);
    const bak = `${fp}${BACKUP_SUFFIX}`;
    if (!fs.existsSync(bak)) continue;
    try {
      await fsp.copyFile(bak, fp);
      await fsp.unlink(bak);
      restored.push(fp);
    } catch {
      /* restore 失败，落到下面的老逻辑 */
    }
  }

  if (active !== null) {
    const meta = await readRuleMeta(dshHome, active);
    const fp = targetPath(dshHome, meta.target);
    if (!restored.includes(fp)) {
      const ruleContent = await readRule(dshHome, active);
      try {
        const fileContent = await fsp.readFile(fp, "utf8");
        if (ruleContent !== null && fileContent === ruleContent) {
          await fsp.unlink(fp);
          removed.push(fp);
        } else {
          skipped.push(fp);
        }
      } catch {
        /* 目标文件不存在：没什么可删的 */
      }
    }
  }
  try {
    await fsp.unlink(stateFile(dshHome));
  } catch {
    /* ignore */
  }
  return { removed, skipped, restored };
}

// ───────────────────────────── cwd 规则 ─────────────────────────────

/** 一个候选的 cwd 指令文件。 */
export interface CwdCandidate {
  readonly path: string;
  readonly name: string;
  readonly dir: string;
  readonly scope: "cwd" | "root" | "ancestor";
  readonly size: number;
  readonly mtime: number;
  readonly preview: string;
}

/**
 * 向上走若干层，把 cwd 自身也算一层；遇到 `.git`/`.hg`/`.svn` 这类根标记就停住。
 *
 * `dsh-agent-instructions` 的 `findProjectRoot` 用类似做法。没找到 root 就只扫 cwd 这一层。
 * 返回**从根到 cwd**的顺序（UI 按这个顺序展示）。
 */
export function ancestorChainForCwd(cwd: string): readonly string[] {
  if (cwd === "") return [];
  const normalized = path.resolve(cwd);
  let root: string | null = null;
  let cur = normalized;
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (fs.existsSync(path.join(cur, marker))) {
          root = cur;
          break;
        }
      } catch {
        /* 权限问题当「没有标记」 */
      }
    }
    if (root !== null) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const chain: string[] = [];
  const pushed = new Set<string>();
  const stopAt = root === null ? normalized : path.resolve(root);
  let walker = normalized;
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    if (!pushed.has(walker)) {
      chain.push(walker);
      pushed.add(walker);
    }
    if (walker === stopAt) break;
    const parent = path.dirname(walker);
    if (parent === walker) break;
    walker = parent;
  }
  return chain.reverse();
}

/** 扫 cwd → projectRoot 之间的工作区指令文件。 */
export function scanCwdInstructions(cwd: string): readonly CwdCandidate[] {
  const out: CwdCandidate[] = [];
  if (cwd === "") return out;
  const chain = ancestorChainForCwd(cwd);
  const seen = new Set<string>();
  const leaf = path.resolve(cwd);
  const rootDir = chain[0];
  for (const dir of chain) {
    for (const name of CWD_CANDIDATE_FILES) {
      const fp = path.join(dir, name);
      if (seen.has(fp)) continue;
      let stat: import("node:fs").Stats;
      try {
        stat = fs.statSync(fp);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seen.add(fp);
      let preview = "";
      try {
        preview = fs
          .readFileSync(fp, "utf8")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
      } catch {
        /* 读不到正文时只报元信息 */
      }
      const scope: CwdCandidate["scope"] = dir === leaf ? "cwd" : dir === rootDir ? "root" : "ancestor";
      out.push({
        path: fp,
        name,
        dir,
        scope,
        size: stat.size,
        mtime: stat.mtimeMs || 0,
        preview,
      });
    }
  }
  return out;
}

// ───────────────────────────── 工作区策略 / cwd 勾选 ─────────────────────────────

export function readWorkspacePolicy(dshHome: string): WorkspacePolicy {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(workspacePolicyPath(dshHome), "utf8"));
    const policy = (parsed as { policy?: unknown } | null)?.policy;
    if (typeof policy === "string" && (WORKSPACE_POLICIES as readonly string[]).includes(policy)) {
      return policy as WorkspacePolicy;
    }
  } catch {
    /* 没有配置就用默认 */
  }
  return DEFAULT_WORKSPACE_POLICY;
}

export async function writeWorkspacePolicy(dshHome: string, policy: string): Promise<WorkspacePolicy> {
  if (!(WORKSPACE_POLICIES as readonly string[]).includes(policy)) {
    throw new Error(`invalid workspace policy: ${policy}`);
  }
  const fp = workspacePolicyPath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, JSON.stringify({ policy }, null, 2));
  return policy as WorkspacePolicy;
}

function normalizeSelectionList(input: unknown): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(input)) return out;
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const abs = path.resolve(trimmed);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function readCwdSelections(dshHome: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cwdSelectionsPath(dshHome), "utf8"));
    return normalizeSelectionList((parsed as { paths?: unknown } | null)?.paths);
  } catch {
    return [];
  }
}

export async function writeCwdSelections(dshHome: string, paths: unknown): Promise<readonly string[]> {
  const unique = normalizeSelectionList(paths);
  const fp = cwdSelectionsPath(dshHome);
  await fsp.mkdir(path.dirname(fp), { recursive: true });
  await atomicWriteFile(fp, JSON.stringify({ paths: unique }, null, 2));
  return unique;
}

export async function toggleCwdSelection(
  dshHome: string,
  filePath: string,
  enabled: boolean,
): Promise<readonly string[]> {
  if (!filePath.trim()) throw new Error("invalid file path");
  const abs = path.resolve(filePath.trim());
  const set = new Set(readCwdSelections(dshHome));
  if (enabled) set.add(abs);
  else set.delete(abs);
  return writeCwdSelections(dshHome, [...set]);
}

export function readLastCwd(dshHome: string): string {
  try {
    return fs.readFileSync(lastCwdPath(dshHome), "utf8").trim();
  } catch {
    return "";
  }
}

/** `writeLastCwd` 的进程内去重状态（见文件头注释第 4 条）。 */
export interface LastCwdMemo {
  lastWritten: string;
  lastHome: string;
}

export function createLastCwdMemo(): LastCwdMemo {
  return { lastWritten: "", lastHome: "" };
}

/**
 * 记录当前 cwd。
 *
 * `assemble` 每次都会调到这里（实测空闲时每秒 7~9 次）。多数调用 cwd 与上次相同，
 * 进程内记住上次写入值，相同就跳过——否则等于持续写盘。
 */
export function writeLastCwd(dshHome: string, cwd: string, memo: LastCwdMemo): void {
  if (cwd.trim() === "") return;
  const value = cwd.trim();
  if (value === memo.lastWritten && dshHome === memo.lastHome) return;
  try {
    const fp = lastCwdPath(dshHome);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWriteFileSync(fp, value);
    memo.lastWritten = value;
    memo.lastHome = dshHome;
  } catch {
    /* 记账失败不影响注入 */
  }
}

/** 当前用于展示/扫描的 cwd：显式 hint > 上次记住的。 */
export function pickCwd(dshHome: string, cwdHint?: string): string {
  const hint = typeof cwdHint === "string" ? cwdHint.trim() : "";
  if (hint !== "") return path.resolve(hint);
  const last = readLastCwd(dshHome);
  return last === "" ? "" : path.resolve(last);
}

/**
 * 勾选的本地指令文件拼接内容。
 *
 * 仅当文件**仍在当前 cwd 的扫描结果里**才会被用上——避免切换目录后
 * 旧勾选跨目录穿越注入。超过 512KB 的内容会被截断（不是报错：
 * 用户只是勾了个大文件，注入被截断比整个会话起不来好）。
 */
export function readSelectedCwdInject(dshHome: string, cwd: string): string {
  const selections = readCwdSelections(dshHome);
  if (selections.length === 0) return "";
  const candidates = cwd === "" ? [] : scanCwdInstructions(cwd);
  const candidateSet = new Set(candidates.map((c) => c.path));
  const chosen = selections.filter((p) => candidateSet.has(p));
  if (chosen.length === 0) return "";
  const parts: string[] = [];
  let total = 0;
  for (const fp of chosen) {
    let text = "";
    try {
      text = fs.readFileSync(fp, "utf8").trim();
    } catch {
      continue;
    }
    if (text === "") continue;
    const header = `<!-- dsh-unbound:cwd-rule ${path.basename(fp)} -->`;
    const block = `${header}\n${text}`;
    total += Buffer.byteLength(block, "utf8");
    if (total > MAX_LOCAL_INJECT_BYTES) break;
    parts.push(block);
  }
  return parts.join("\n\n---\n\n");
}

// ───────────────────────────── 状态快照 ─────────────────────────────

/** `/rules list` 与设置页共用的状态快照。 */
export interface RulesStatus {
  readonly rules: readonly RuleEntry[];
  readonly active: string | null;
  readonly injectSource: ResolvedInject["source"];
  readonly injectRuleId: string | null;
  readonly active_target: RuleTarget | null;
  readonly agents_exists: boolean;
  readonly agents_synced: boolean;
  readonly agents_path: string;
  readonly rules_dir: string;
  readonly cwd: string;
  readonly cwd_candidates: readonly (CwdCandidate & { readonly selected: boolean })[];
  readonly cwd_selections: readonly string[];
  readonly workspace_policy: WorkspacePolicy;
  readonly workspace_policies: readonly WorkspacePolicy[];
}

export async function rulesStatus(
  dshHome: string,
  promptState: PromptState,
  cwdHint?: string,
): Promise<RulesStatus> {
  const listed = await listRules(dshHome);
  const active = await readActive(dshHome);
  let activeTarget: RuleTarget | null = null;
  let agentsExists = false;
  let agentsSynced = false;
  let agentsPath = targetPath(dshHome, "AGENTS.md");
  if (active !== null) {
    const meta = await readRuleMeta(dshHome, active);
    activeTarget = meta.target;
    agentsPath = targetPath(dshHome, meta.target);
    try {
      const content = await fsp.readFile(agentsPath, "utf8");
      agentsExists = true;
      const ruleContent = await readRule(dshHome, active);
      agentsSynced = ruleContent !== null && ruleContent === content;
    } catch {
      /* 目标文件不存在：exists=false */
    }
  }
  const inject = promptState.resolve(dshHome);
  const cwd = pickCwd(dshHome, cwdHint);
  const cwdCandidates = cwd === "" ? [] : scanCwdInstructions(cwd);
  const selections = readCwdSelections(dshHome);
  const workspacePolicy = readWorkspacePolicy(dshHome);
  return {
    rules: listed,
    active,
    injectSource: inject.source,
    injectRuleId: inject.ruleId,
    active_target: activeTarget,
    agents_exists: agentsExists,
    agents_synced: agentsSynced,
    agents_path: agentsPath,
    rules_dir: rulesDir(dshHome),
    cwd,
    cwd_candidates: cwdCandidates.map((item) => ({ ...item, selected: selections.includes(item.path) })),
    cwd_selections: selections,
    workspace_policy: workspacePolicy,
    workspace_policies: [...WORKSPACE_POLICIES],
  };
}

/** 备份文件是否已经存在（`resetToOriginal` 的判据，测试直接用）。 */
export function hasRuleBackup(dshHome: string, target: RuleTarget): boolean {
  return isRegularFile(`${targetPath(dshHome, target)}${BACKUP_SUFFIX}`);
}

export { BACKUP_SUFFIX };
