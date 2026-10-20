/**
 * 红队平台适配配置。
 *
 * 迁移自 `dsh-qilin/lib/redteam/platform-config.js`。
 *
 * ## 用途
 *
 * - Windows / 非 Kali 机器上，由用户填写工具绝对路径或搜索目录；
 * - preflight / 技能可用性 / nuclei 模板目录统一走这里；
 * - 不往官方 `$DSH_HOME/skills` 写任何东西。
 *
 * ## 迁移时刻意保留的行为
 *
 * 1. **配置合并是"逐字段"的**：`savePlatformConfig` 对每个字段分别判断
 *    "patch 里有这个类型就覆盖，否则用 prev"。不是 `Object.assign` ——
 *    因为要让"只改 binDirs 不动 toolkitDir"成为可能。
 * 2. **`tools` 键始终补齐整个 catalog**：面板要能一次渲染全部输入框。
 * 3. **`env` 合并不覆盖已有值**：`mergeConfigEnv` 是"进程/.env 优先"，
 *    盘上的 config 只作兜底。这条顺序反了会出现"改了 .env 不生效"。
 * 4. **`httpx` 拒收 Python 版本**：Kali 的 `/usr/bin/httpx` 是 Python 的
 *    HTTP 客户端，不是 ProjectDiscovery 的扫描器。拿错工具不会报错，
 *    只会让整轮探测静默少结果 —— 所以按 shebang 判 Python 并跳过。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

/** 工具解析来源。 */
export type ToolSource = "config" | "toolkit" | "binDir" | "path" | "missing";

/** 一个内置工具的定义。 */
export interface ToolCatalogEntry {
  readonly id: string;
  readonly label: string;
  /** 候选文件名（不是绝对路径）。顺序即优先级。 */
  readonly names: readonly string[];
  /** 拒收 Python 脚本（`httpx` 用）。 */
  readonly rejectPython?: boolean;
  /** 发行版别名正则：目录里碰见才用，按小写匹配。 */
  readonly adapt?: readonly RegExp[];
}

/**
 * 内置工具清单：id → 可能的可执行名（含 Windows `.exe`）。
 *
 * 用户可在 `config.tools[id]` 填绝对路径覆盖；也可在 `binDirs` 里放整包工具目录。
 */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { id: "nmap", label: "Nmap", names: ["nmap.exe", "nmap"] },
  { id: "nuclei", label: "Nuclei", names: ["nuclei.exe", "nuclei"] },
  { id: "masscan", label: "Masscan", names: ["masscan.exe", "masscan"] },
  { id: "fscan", label: "fscan", names: ["fscan.exe", "fscan"] },
  { id: "gogo", label: "gogo", names: ["gogo.exe", "gogo"] },
  { id: "suo5", label: "suo5", names: ["suo5.exe", "suo5-windows-amd64.exe", "suo5-linux-amd64", "suo5"] },
  { id: "frpc", label: "frp 客户端", names: ["frpc.exe", "frpc"] },
  { id: "frps", label: "frp 服务端", names: ["frps.exe", "frps"] },
  { id: "chisel", label: "chisel", names: ["chisel.exe", "chisel"] },
  { id: "ffuf", label: "ffuf", names: ["ffuf.exe", "ffuf"] },
  /* names 是候选文件名，不是某台机器的绝对路径。adapt 是发行版常见别名，目录里碰见才用。 */
  {
    id: "httpx",
    label: "httpx",
    names: ["httpx-toolkit", "pd-httpx", "httpx.exe", "httpx"],
    rejectPython: true,
    adapt: [/^httpx-toolkit$/, /^pd-httpx$/, /^httpx$/],
  },
  { id: "dnsx", label: "dnsx", names: ["dnsx.exe", "dnsx"] },
  { id: "subfinder", label: "subfinder", names: ["subfinder.exe", "subfinder"] },
  { id: "ksubdomain", label: "ksubdomain", names: ["ksubdomain.exe", "ksubdomain"] },
  {
    id: "impacket",
    label: "impacket（目录或入口）",
    names: ["impacket-secretsdump", "impacket-secretsdump.exe", "secretsdump.py", "impacket"],
    adapt: [/^impacket-secretsdump$/, /^secretsdump\.py$/],
  },
];

/** 平台选择：`auto` 跟 Node `process.platform`。 */
export type PlatformChoice = "auto" | "windows" | "linux";

/** 盘上的配置形状。 */
export interface PlatformConfig {
  readonly version: number;
  readonly platform: PlatformChoice;
  readonly toolkitDir: string;
  readonly nucleiTemplatesDir: string;
  readonly binDirs: readonly string[];
  readonly tools: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly envAdaptSkip: boolean;
  readonly envAdaptConfigured: boolean;
  readonly updated_at: string | null;
}

/** 带来源信息的配置（`loadPlatformConfig` 的返回）。 */
export interface LoadedPlatformConfig extends PlatformConfig {
  readonly path: string;
  readonly exists: boolean;
  /** 读取失败时的原因（`exists` 仍为 true）。 */
  readonly error?: string;
}

/** 一个工具的可写补丁（`savePlatformConfig` 的入参）。 */
export interface PlatformConfigPatch {
  readonly platform?: PlatformChoice;
  readonly toolkitDir?: string;
  readonly nucleiTemplatesDir?: string;
  readonly binDirs?: readonly string[];
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
  readonly envAdaptSkip?: boolean;
  readonly envAdaptConfigured?: boolean;
}

/** 单个工具的解析结果。 */
export interface ResolvedTool {
  readonly id: string;
  readonly label: string;
  readonly path: string | null;
  readonly source: ToolSource;
  readonly names: readonly string[];
  /** `source==='config'` 但路径不存在时，记录用户填的那个路径。 */
  readonly configured?: string;
  /** `source==='binDir'` 时命中的目录。 */
  readonly binDir?: string;
  /** 补充说明（通常是"config 路径不存在"）。 */
  readonly note?: string;
}

/**
 * 解析选项。
 *
 * 三个字段都显式允许 `undefined`：项目开了 `exactOptionalPropertyTypes`，
 * 用它才能把 `{ root: maybeUndefined }` 这类"确实可能是 undefined"的对象
 * 直接传进来，而不必在几十个调用点手动铺开 `... (root ? {root} : {})`。
 */
export interface ResolveOptions {
  readonly root?: string | undefined;
  readonly config?: (PlatformConfig & { readonly path?: string; readonly exists?: boolean }) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** 红队数据根：`$DSH_HOME/redteam`。 */
export function redteamRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env["DSH_HOME"] || join(homedir(), ".dsh");
  return join(home, "redteam");
}

/** 配置文件路径。 */
export function configPathOf(root?: string): string {
  return join(root || redteamRoot(), "config.json");
}

/** 默认工具箱目录。 */
export function defaultToolkitDir(root?: string): string {
  return join(root || redteamRoot(), "toolkit");
}

/** 空配置的工厂。 */
function emptyConfig(): PlatformConfig {
  return {
    version: 1,
    platform: "auto",
    toolkitDir: "",
    nucleiTemplatesDir: "",
    binDirs: [],
    tools: Object.fromEntries(TOOL_CATALOG.map((t) => [t.id, ""])),
    env: {
      FOFA_KEY: "",
      REDTEAM_VPS_HOST: "",
      REDTEAM_VPS_KEY: "",
    },
    notes: "",
    envAdaptSkip: false,
    envAdaptConfigured: false,
    updated_at: null,
  };
}

/** 生效平台是否 Windows。 */
export function isWinLike(cfg: Pick<PlatformConfig, "platform"> | null | undefined): boolean {
  const p = cfg?.platform ?? "auto";
  if (p === "windows") return true;
  if (p === "linux") return false;
  return osPlatform() === "win32";
}

/** 只接受白名单的平台值。 */
function asPlatformChoice(value: unknown, fallback: PlatformChoice): PlatformChoice {
  return value === "auto" || value === "windows" || value === "linux" ? value : fallback;
}

/** 把任意输入收敛成"去重后的非空字符串数组"。 */
function asDirList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/** 记录是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 读配置（读不到 / 坏了都返回带默认值的对象，**绝不抛**）。
 *
 * 坏配置返回 `{ ...默认值, path, exists: true, error }` ——
 * 面板据此提示"配置文件损坏"，而不是假装没有配置。
 */
export function loadPlatformConfig(root?: string): LoadedPlatformConfig {
  const base = emptyConfig();
  const file = configPathOf(root);
  if (!existsSync(file)) return { ...base, path: file, exists: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(raw)) {
      return { ...base, path: file, exists: true, error: "config.json 的顶层不是对象" };
    }
    const tools: Record<string, string> = { ...base.tools };
    if (isRecord(raw["tools"])) {
      for (const [k, v] of Object.entries(raw["tools"])) tools[k] = String(v ?? "");
    }
    const env: Record<string, string> = { ...base.env };
    if (isRecord(raw["env"])) {
      for (const [k, v] of Object.entries(raw["env"])) env[k] = String(v ?? "");
    }
    const version = Number(raw["version"]);
    return {
      version: Number.isFinite(version) && version > 0 ? version : 1,
      platform: asPlatformChoice(raw["platform"], "auto"),
      toolkitDir: typeof raw["toolkitDir"] === "string" ? raw["toolkitDir"].trim() : "",
      nucleiTemplatesDir: typeof raw["nucleiTemplatesDir"] === "string" ? raw["nucleiTemplatesDir"].trim() : "",
      binDirs: asDirList(raw["binDirs"]),
      tools,
      env,
      notes: typeof raw["notes"] === "string" ? raw["notes"] : "",
      envAdaptSkip: Boolean(raw["envAdaptSkip"]),
      envAdaptConfigured: Boolean(raw["envAdaptConfigured"]),
      updated_at: typeof raw["updated_at"] === "string" && raw["updated_at"] !== "" ? raw["updated_at"] : null,
      path: file,
      exists: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, path: file, exists: true, error: message };
  }
}

/**
 * 合并写入配置，返回写入后重新读到的完整配置。
 *
 * **逐字段判定**：patch 里某个字段"缺失或类型不对"时保留 prev 的值，
 * 而不是写进一个空值。这样面板只提交 `{ binDirs: [...] }` 不会把 toolkitDir 清空。
 */
export function savePlatformConfig(patch: PlatformConfigPatch, root?: string): LoadedPlatformConfig {
  const dir = root || redteamRoot();
  mkdirSync(dir, { recursive: true });
  const prev = loadPlatformConfig(dir);
  const next = {
    version: 1,
    platform: asPlatformChoice(patch.platform, prev.platform),
    toolkitDir: typeof patch.toolkitDir === "string" ? patch.toolkitDir.trim() : prev.toolkitDir,
    nucleiTemplatesDir:
      typeof patch.nucleiTemplatesDir === "string" ? patch.nucleiTemplatesDir.trim() : prev.nucleiTemplatesDir,
    binDirs: Array.isArray(patch.binDirs) ? asDirList(patch.binDirs) : prev.binDirs,
    tools: { ...prev.tools, ...(isRecord(patch.tools) ? patch.tools : {}) } as Record<string, string>,
    env: { ...prev.env, ...(isRecord(patch.env) ? patch.env : {}) } as Record<string, string>,
    notes: typeof patch.notes === "string" ? patch.notes : prev.notes,
    envAdaptSkip: patch.envAdaptSkip !== undefined ? Boolean(patch.envAdaptSkip) : prev.envAdaptSkip,
    envAdaptConfigured:
      patch.envAdaptConfigured !== undefined ? Boolean(patch.envAdaptConfigured) : prev.envAdaptConfigured,
    updated_at: new Date().toISOString(),
  };
  /* 空 tools 键保留 catalog 全量，方便面板编辑；已有的值统一 trim */
  for (const t of TOOL_CATALOG) {
    const cur = next.tools[t.id];
    next.tools[t.id] = cur === undefined || cur === null ? "" : String(cur).trim();
  }
  const file = configPathOf(dir);
  writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  return loadPlatformConfig(dir);
}

/** 生效的工具箱根。 */
export function toolkitDirOf(cfg?: PlatformConfig | null, root?: string): string {
  const c = cfg ?? loadPlatformConfig(root);
  if (c.toolkitDir !== "") return resolve(c.toolkitDir);
  return defaultToolkitDir(root);
}

/** 生效的 nuclei 模板目录（不存在就返回 null）。 */
export function nucleiTemplatesDirOf(cfg?: PlatformConfig | null, root?: string): string | null {
  const c = cfg ?? loadPlatformConfig(root);
  if (c.nucleiTemplatesDir !== "" && existsSync(c.nucleiTemplatesDir)) return resolve(c.nucleiTemplatesDir);
  return null;
}

/**
 * 看文件开头是否是 `#!...python`。
 *
 * 只在 `rejectPython` 的工具上调用：Kali 自带 `/usr/bin/httpx` 属于
 * Python 的 HTTP 客户端库，撞名 ProjectDiscovery 的扫描器。
 */
export function looksLikePythonCli(file: string): boolean {
  let fd: number | undefined;
  try {
    const buf = Buffer.alloc(96);
    fd = openSync(file, "r");
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString("utf8");
    return head.startsWith("#!") && /python/i.test(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关不上不影响判定结果 */
      }
    }
  }
}

/** 在目录里按候选名找可执行文件。 */
function findInDir(dir: string, names: readonly string[], options: FindOptions): string | null {
  if (dir === "" || !existsSync(dir)) return null;
  const tryOne = (base: string): string | null => {
    for (const name of names) {
      const p = join(base, name);
      if (!existsSync(p)) continue;
      try {
        if (!statSync(p).isFile()) continue;
        if (options.rejectPython === true && looksLikePythonCli(p)) continue;
        return p;
      } catch {
        /* 单个文件 stat 失败继续看下一个候选 */
      }
    }
    return null;
  };
  const hit = tryOne(dir) ?? adaptInDir(dir, options);
  if (hit !== null) return hit;
  for (const sub of ["bin", "Bins", "tools", "Tools"]) {
    const nested = tryOne(join(dir, sub)) ?? adaptInDir(join(dir, sub), options);
    if (nested !== null) return nested;
  }
  return null;
}

/** 查找选项（同样显式容纳 `undefined`，理由见 `ResolveOptions`）。 */
interface FindOptions {
  readonly rejectPython?: boolean | undefined;
  readonly adapt?: readonly RegExp[] | undefined;
}

/** 精确文件名没有时，用发行版别名在这一层目录里对。对上才算找到。 */
function adaptInDir(dir: string, options: FindOptions): string | null {
  const patterns = options.adapt;
  if (dir === "" || patterns === undefined || patterns.length === 0 || !existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const pattern of patterns) {
    for (const name of names) {
      if (!pattern.test(String(name).toLowerCase())) continue;
      const file = join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        if (options.rejectPython === true && looksLikePythonCli(file)) continue;
        return file;
      } catch {
        /* 继续下一个候选名 */
      }
    }
  }
  return null;
}

/** PATH 上的 which（同步，不 spawn shell）。 */
function findOnPath(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: FindOptions,
): string | null {
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  const parts = pathVar.split(delimiter).filter(Boolean);
  for (const part of parts) {
    const hit = findInDir(part, names, options);
    if (hit !== null) return hit;
  }
  return null;
}

/** dsh 的 PATH 经常比登录 shell 短。Linux 再补发行版和用户目录。 */
function linuxFallbackDirs(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const home = env["HOME"] || homedir();
  const dirs = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/bin", "/snap/bin"];
  if (home !== "") {
    dirs.push(join(home, "go", "bin"), join(home, ".local", "bin"), join(home, ".pdtm", "go", "bin"));
  }
  return dirs;
}

/**
 * 解析单个工具：用户指定路径 → toolkit → binDirs → PATH → Linux 兜底目录。
 *
 * 顺序固定，不要重排：用户显式填的路径必须优先（他可能故意用某个特定版本）。
 */
export function resolveTool(id: string, options: ResolveOptions = {}): ResolvedTool {
  const root = options.root ?? redteamRoot();
  const cfg = options.config ?? loadPlatformConfig(root);
  const env = options.env ?? process.env;
  const def = TOOL_CATALOG.find((t) => t.id === id);
  if (def === undefined) {
    return { id, label: id, path: null, source: "missing", names: [] };
  }
  const configuredRaw = cfg.tools[id];
  const configured = typeof configuredRaw === "string" ? configuredRaw.trim() : "";
  if (configured !== "") {
    const abs = isAbsolute(configured) ? configured : resolve(configured);
    if (existsSync(abs)) return { id, label: def.label, path: abs, source: "config", names: def.names };
    return {
      id,
      label: def.label,
      path: null,
      source: "missing",
      names: def.names,
      configured: abs,
      note: "config 路径不存在：" + abs,
    };
  }
  const findOpts: FindOptions = { rejectPython: def.rejectPython === true, adapt: def.adapt };
  const toolkit = toolkitDirOf(cfg, root);
  const fromToolkit = findInDir(toolkit, def.names, findOpts);
  if (fromToolkit !== null) return { id, label: def.label, path: fromToolkit, source: "toolkit", names: def.names };

  for (const dir of cfg.binDirs) {
    const hit = findInDir(dir, def.names, findOpts);
    if (hit !== null) return { id, label: def.label, path: hit, source: "binDir", names: def.names, binDir: dir };
  }

  const fromPath = findOnPath(def.names, env, findOpts);
  if (fromPath !== null) return { id, label: def.label, path: fromPath, source: "path", names: def.names };

  if (!isWinLike(cfg)) {
    for (const dir of linuxFallbackDirs(env)) {
      const hit = findInDir(dir, def.names, findOpts);
      if (hit !== null) return { id, label: def.label, path: hit, source: "path", names: def.names };
    }
  }

  return { id, label: def.label, path: null, source: "missing", names: def.names };
}

/** 解析全部工具。 */
export function resolveAllTools(options: ResolveOptions = {}): readonly ResolvedTool[] {
  return TOOL_CATALOG.map((t) => resolveTool(t.id, options));
}

/**
 * 把配置里的 env 合并进 effectiveEnv。
 *
 * **进程 / `.env` 已有的值优先，config 只作兜底** —— 顺序反了会出现
 * "改了 `.env` 却不生效"这种最难查的问题。
 */
export function mergeConfigEnv(
  effectiveEnv: Readonly<Record<string, string | undefined>>,
  cfg: Pick<PlatformConfig, "env"> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(effectiveEnv)) {
    if (typeof v === "string") out[k] = v;
  }
  for (const [k, v] of Object.entries(cfg?.env ?? {})) {
    if (typeof v !== "string") continue;
    const val = v.trim();
    if (val === "") continue;
    const cur = out[k];
    if (cur === undefined || cur === "") out[k] = val;
  }
  return out;
}

/** Kali 探测结果。 */
export interface KaliDetection {
  readonly kali: boolean;
  readonly source: string | null;
  readonly detail: string | null;
}

/** 探测本机是否 Kali / 同系演练发行版。 */
export function detectKali(): KaliDetection {
  if (osPlatform() !== "linux") return { kali: false, source: null, detail: "非 Linux 宿主" };
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    if (/ID\s*=\s*"?kali"?/i.test(text) || /ID_LIKE\s*=[^\n]*kali/i.test(text) || /NAME\s*=\s*".*Kali/i.test(text)) {
      return { kali: true, source: "os-release", detail: "os-release 标明 Kali" };
    }
  } catch {
    /* 没有 os-release：继续看路径标记 */
  }
  const markers = ["/usr/share/kali-menu", "/etc/apt/sources.list.d/kali.list", "/usr/share/kali-defaults"];
  for (const p of markers) {
    if (existsSync(p)) return { kali: true, source: "paths", detail: p };
  }
  return { kali: false, source: null, detail: null };
}

/** 环境适配门禁状态。 */
export interface EnvAdaptStatus {
  readonly ok: true;
  readonly ready: boolean;
  readonly reason: "kali" | "skipped" | "configured" | "tools-found" | "need-config";
  readonly message: string;
  readonly kali: boolean;
  readonly kaliSource: string | null;
  readonly kaliDetail: string | null;
  readonly skipped: boolean;
  readonly configured: boolean;
  readonly found: number;
  readonly missing: number;
  readonly total: number;
  readonly foundIds: readonly string[];
  readonly missingIds: readonly string[];
}

/**
 * 红队发送前环境门禁状态：Kali → 直接就绪；否则需配置/已分配工具，或用户确认跳过。
 */
export function envAdaptStatus(root?: string): EnvAdaptStatus {
  const cfg = loadPlatformConfig(root);
  const kaliInfo = detectKali();
  const tools = resolveAllTools({ root, config: cfg });
  const foundItems = tools.filter((t) => t.path !== null);
  const missingItems = tools.filter((t) => t.path === null);
  const found = foundItems.length;
  const skipped = cfg.envAdaptSkip;
  /* 只有记下的路径算已配置。单独的 envAdaptConfigured 可能是空的自动初始化。 */
  const savedPaths =
    (cfg.toolkitDir !== "" && cfg.toolkitDir.trim() !== "") ||
    cfg.binDirs.length > 0 ||
    TOOL_CATALOG.some((t) => (cfg.tools[t.id] ?? "").trim() !== "");

  let reason: EnvAdaptStatus["reason"] = "need-config";
  let ready = false;
  let message = "";

  if (kaliInfo.kali) {
    ready = true;
    reason = "kali";
    message = "已检测到 Kali，默认直接使用本机工具（PATH / 默认查找）。";
  } else if (skipped) {
    ready = true;
    reason = "skipped";
    message = "你已确认暂不配置工具，可正常对话（扫描类技能可能不可用）。";
  } else if (savedPaths) {
    ready = true;
    reason = "configured";
    message = "已保存的工具路径还在，更新插件不会要求重配。当前找到 " + found + "/" + tools.length + " 个工具。";
  } else if (found >= 2) {
    ready = true;
    reason = "tools-found";
    message = "本机已能找到 " + found + " 个工具，视为可用。";
  } else {
    ready = false;
    reason = "need-config";
    message =
      "未检测到 Kali，且工具未配置。请打开 dsh-qilin → 环境适配，填写路径或选整包文件夹自动分配；也可确认暂不配置后继续对话。";
  }

  return {
    ok: true,
    ready,
    reason,
    message,
    kali: kaliInfo.kali,
    kaliSource: kaliInfo.source,
    kaliDetail: kaliInfo.detail,
    skipped,
    configured: savedPaths,
    found,
    missing: missingItems.length,
    total: tools.length,
    foundIds: foundItems.map((t) => t.id),
    missingIds: missingItems.map((t) => t.id),
  };
}

/** 标记"用户确认暂不配置"，返回最新状态。 */
export function markEnvAdaptSkip(root?: string, skip = true): EnvAdaptStatus {
  savePlatformConfig({ envAdaptSkip: skip }, root);
  return envAdaptStatus(root);
}

/** 平台摘要（给面板与 preflight 用）。 */
export interface PlatformSummary {
  readonly ok: true;
  readonly config: LoadedPlatformConfig;
  readonly runtime: {
    readonly nodePlatform: string;
    readonly effective: "windows" | "linux";
    readonly windows: boolean;
    readonly sep: string;
  };
  readonly toolkitDir: string;
  readonly toolkitExists: boolean;
  readonly nucleiTemplatesDir: string | null;
  readonly tools: {
    readonly total: number;
    readonly found: number;
    readonly missing: number;
    readonly items: readonly ResolvedTool[];
  };
  readonly adapt: EnvAdaptStatus;
  readonly hint: string;
  readonly egress: {
    readonly http_proxy: string;
    readonly https_proxy: string;
    readonly all_proxy: string;
    readonly no_proxy: string;
    readonly note: string;
  };
}

/** 平台摘要：给面板与 preflight 用。 */
export function platformSummary(root?: string): PlatformSummary {
  const cfg = loadPlatformConfig(root);
  const win = isWinLike(cfg);
  const tools = resolveAllTools({ root, config: cfg });
  const found = tools.filter((t) => t.path !== null);
  const missing = tools.filter((t) => t.path === null);
  const toolkit = toolkitDirOf(cfg, root);
  const nuclei =
    nucleiTemplatesDirOf(cfg, root) ??
    (existsSync(join(toolkit, "nuclei-templates")) ? join(toolkit, "nuclei-templates") : null);
  const adapt = envAdaptStatus(root);
  return {
    ok: true,
    config: cfg,
    runtime: { nodePlatform: osPlatform(), effective: win ? "windows" : "linux", windows: win, sep },
    toolkitDir: toolkit,
    toolkitExists: existsSync(toolkit),
    nucleiTemplatesDir: nuclei,
    tools: { total: tools.length, found: found.length, missing: missing.length, items: tools },
    adapt,
    hint: adapt.kali
      ? "已检测到 Kali。系统包按发行版文件名认：impacket-secretsdump、httpx-toolkit（不把 Python 的 /usr/bin/httpx 当成扫描器）。fscan、gogo、suo5、frp、chisel、dnsx、subfinder、ksubdomain 不是 Kali 自带命令，没放进 /usr/bin 或 ~/go/bin 就会显示未找到。"
      : win
        ? "当前按 Windows 适配：建议在 Kali 虚拟机里跑，或在本页填工具路径/整包文件夹自动分配。出网代理看下方「出网状态」。"
        : "当前按 Linux 适配：可用 setup.sh 装工具箱，也可在本页手填或整包文件夹自动分配。出网代理看下方「出网状态」。",
    egress: {
      http_proxy: process.env["HTTP_PROXY"] ?? process.env["http_proxy"] ?? "",
      https_proxy: process.env["HTTPS_PROXY"] ?? process.env["https_proxy"] ?? "",
      all_proxy: process.env["ALL_PROXY"] ?? process.env["all_proxy"] ?? "",
      no_proxy: process.env["NO_PROXY"] ?? process.env["no_proxy"] ?? "",
      note: "只读进程环境；改系统/终端代理后需重启宿主。命令级代理请用技能 cn-proxy-pool，不改本机网络配置。",
    },
  };
}

/* ── 整包工具文件夹：扫描与分配 ───────────────────────────────────────────── */

/** 扫描命中的一条。 */
export interface ToolScanHit {
  readonly id: string;
  readonly path: string;
  readonly name: string;
}

/** 扫描失败。 */
export interface ToolScanFailure {
  readonly ok: false;
  readonly error: string;
  readonly assigned: Readonly<Record<string, string>>;
  readonly hits: readonly ToolScanHit[];
}

/** 扫描成功。 */
export interface ToolScanSuccess {
  readonly ok: true;
  readonly dir: string;
  readonly scanned: number;
  readonly assigned: Readonly<Record<string, string>>;
  readonly hits: readonly ToolScanHit[];
  readonly nucleiTemplatesDir: string;
  readonly assignedCount: number;
}

/** 扫描结果。 */
export type ToolScanResult = ToolScanSuccess | ToolScanFailure;

/** 扫描选项。 */
export interface ScanOptions {
  /** 递归深度（夹在 [1, 6]，默认 4）。 */
  readonly maxDepth?: number | undefined;
  /** 最多看多少个文件（夹在 [100, 20000]，默认 8000）。 */
  readonly maxFiles?: number | undefined;
}

/** 文件名（小写）→ 可能的 tool id。同名可能属于多个 id（如 `httpx-toolkit`）。 */
const NAME_TO_IDS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const t of TOOL_CATALOG) {
    for (const name of t.names) {
      const key = name.toLowerCase();
      const cur = map.get(key);
      if (cur === undefined) map.set(key, [t.id]);
      else cur.push(t.id);
    }
  }
  return map;
})();

/** 双向夹取：`Math.min(Math.max(v, lo), hi)`，保留上游语义。 */
function clampBounded(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(value) || fallback;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * 在文件夹内递归扫工具名（限深度），返回 id → 绝对路径。
 *
 * 语义要点（逐条来自上游实现，不要"顺手优化"）：
 *
 * - **`rejectPython` 生效**：命中但文件是 Python 脚本时跳过（Kali 的
 *   `/usr/bin/httpx` 是 Python 客户端，不是扫描器）。
 * - **同名多候选时按 `names` 顺序择优**：`ranks[id]` 记住已分配的排名，
 *   只有找到*更靠前*的候选才替换。所以 `fscan` 与 `fscan.exe` 同时存在时，
 *   取决于哪个先被遍历到 + 排名 —— 排名小的赢。
 * - **`scanned` 只数文件、不数目录**，且到 `maxFiles` 就硬停（连 `walk` 都不再进入）。
 * - 跳过点开头的名字与 `node_modules` / `.git`（工具夹里常有这些）。
 * - `nuclei-templates` 顺带认两个位置。
 *
 * @param dir 待扫的文件夹。
 * @param options 深度与文件数上限。
 */
export function scanFolderForTools(dir: unknown, options: ScanOptions = {}): ToolScanResult {
  const maxDepth = clampBounded(options.maxDepth, 4, 1, 6);
  const maxFiles = clampBounded(options.maxFiles, 8000, 100, 20000);
  const raw = String(dir ?? "").trim();
  /* ── 与上游的一处**刻意偏离** ──
     上游直接 `resolve(String(dir||'').trim())`，而 `resolve("")` 返回 **cwd**，
     于是 `scanFolderForTools("")` 会把当前工作目录整个扫一遍并"成功"返回；
     接着 `assignToolkitFolder("")` 就把 cwd 写进 `toolkitDir` 与 `binDirs[0]`。
     这显然不是调用方想要的（面板传空路径时应当报错，而不是偷偷记录 cwd）。
     同理 `resolve(" ")` 也是 cwd。这里对空输入明确报错。
     非空但不存在 / 不是目录的情况，语义与上游完全一致。 */
  if (raw === "") {
    return { ok: false, error: "未指定文件夹（空路径会指向当前工作目录，已拒绝）", assigned: {}, hits: [] };
  }
  const root = resolve(raw);
  const assigned: Record<string, string> = {};
  const hits: ToolScanHit[] = [];
  if (!existsSync(root)) {
    return { ok: false, error: "目录不存在：" + root, assigned, hits };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(root);
  } catch {
    return { ok: false, error: "无法读取目录：" + root, assigned, hits };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: "不是文件夹：" + root, assigned, hits };
  }

  let scanned = 0;
  const ranks: Record<string, number> = {};

  const walk = (base: string, depth: number): void => {
    if (scanned >= maxFiles || depth > maxDepth) return;
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (scanned >= maxFiles) break;
      const name = ent.name;
      if (name === "" || name === "." || name === "..") continue;
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(base, name);
      let isDir = false;
      let isFile = false;
      try {
        isDir = ent.isDirectory();
        isFile = ent.isFile();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full, depth + 1);
        continue;
      }
      if (!isFile) continue;
      scanned += 1;
      const key = name.toLowerCase();
      const ids = NAME_TO_IDS.get(key);
      if (ids === undefined) continue;
      for (const id of ids) {
        const def = TOOL_CATALOG.find((t) => t.id === id);
        if (def?.rejectPython === true && looksLikePythonCli(full)) continue;
        const rank = def === undefined ? 99 : def.names.findIndex((n) => n.toLowerCase() === key);
        const prevRank = ranks[id] === undefined ? 99 : ranks[id];
        if (assigned[id] !== undefined && rank >= prevRank) continue;
        ranks[id] = rank < 0 ? 99 : rank;
        assigned[id] = full;
        hits.push({ id, path: full, name });
      }
    }
  };
  walk(root, 0);

  /* nuclei-templates 目录顺带认一下 */
  let nucleiTemplatesDir = "";
  for (const p of [join(root, "nuclei-templates"), join(root, "nuclei", "templates")]) {
    if (!existsSync(p)) continue;
    try {
      if (statSync(p).isDirectory()) {
        nucleiTemplatesDir = p;
        break;
      }
    } catch {
      /* 读不到就换下一个候选位置 */
    }
  }

  return {
    ok: true,
    dir: root,
    scanned,
    assigned,
    hits,
    nucleiTemplatesDir,
    assignedCount: Object.keys(assigned).length,
  };
}

/** `assignToolkitFolder` 的返回值。 */
export interface AssignToolkitResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly assigned?: Readonly<Record<string, string>>;
  readonly assignedCount?: number;
  readonly hits?: readonly ToolScanHit[];
  readonly scanned?: number;
  readonly dir?: string;
  readonly nucleiTemplatesDir?: string | null;
  readonly config?: LoadedPlatformConfig;
  readonly tools?: PlatformSummary["tools"];
  readonly adapt?: EnvAdaptStatus;
}

/**
 * 把整包工具文件夹写入 config：`toolkitDir` + 匹配到的 `tools` 路径。
 *
 * **`binDirs` 是 `unshift` 前插，不是 `push`。** 顺序会影响 `resolveTool` 的
 * 解析优先级（`binDirs` 在 `toolkit` 之后、`PATH` 之前按数组顺序找），
 * 刚分配的这个目录应当排在最前 —— 用户刚指定它，意图最明确。
 *
 * 同时把 `envAdaptConfigured` 置 true、`envAdaptSkip` 清 false：
 * 用户既然分配了工具文件夹，就不该再停留在"确认跳过"状态。
 *
 * @param dir 整包工具文件夹。
 * @param root 数据根（默认 `redteamRoot()`）。
 */
export function assignToolkitFolder(dir: unknown, root?: string): AssignToolkitResult {
  const scan = scanFolderForTools(dir);
  if (!scan.ok) return { ok: false, error: scan.error, assigned: scan.assigned, hits: scan.hits };
  const prev = loadPlatformConfig(root);
  const tools: Record<string, string> = { ...prev.tools };
  for (const [id, p] of Object.entries(scan.assigned)) tools[id] = p;
  const binDirs = [...prev.binDirs];
  if (!binDirs.includes(scan.dir)) binDirs.unshift(scan.dir);
  const patch: {
    toolkitDir: string;
    binDirs: readonly string[];
    tools: Readonly<Record<string, string>>;
    envAdaptConfigured: boolean;
    envAdaptSkip: boolean;
    nucleiTemplatesDir?: string;
  } = {
    toolkitDir: scan.dir,
    binDirs,
    tools,
    envAdaptConfigured: true,
    envAdaptSkip: false,
  };
  if (scan.nucleiTemplatesDir !== "") patch.nucleiTemplatesDir = scan.nucleiTemplatesDir;
  const cfg = savePlatformConfig(patch, root);
  const summary = platformSummary(root);
  return {
    ok: true,
    assigned: scan.assigned,
    assignedCount: scan.assignedCount,
    hits: scan.hits,
    scanned: scan.scanned,
    dir: scan.dir,
    nucleiTemplatesDir: scan.nucleiTemplatesDir === "" ? null : scan.nucleiTemplatesDir,
    config: cfg,
    tools: summary.tools,
    adapt: summary.adapt,
  };
}
