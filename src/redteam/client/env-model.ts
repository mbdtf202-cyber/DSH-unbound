/**
 * 环境适配页的表单模型（纯逻辑）。
 *
 * ## 为什么抽出来
 *
 * 原 `EnvTab` 有 150 行渲染里夹着这些逻辑：
 * ```js
 * applyDraftFrom(r)          // 服务端响应 → 表单草稿
 * config = { ...draft, binDirs: draft.binDirsText.split(/\r?\n/)... }   // 表单 → 请求
 * setTool(id, value)         // 改一个工具路径
 * setEnv(key, value)         // 改一个环境变量
 * ```
 * 全都是纯数据变换，但埋在 JSX 里只能整页渲染才能测。抽出来后：
 * - 「表单 → 请求」的字段映射可逐条断言（漏一个字段就是保存时丢配置）
 * - 「响应 → 表单」的兜底可穷举（缺字段、null、类型不对）
 *
 * ## 一个容易丢的细节
 *
 * 保存时**强制** `envAdaptConfigured: true` 与 `envAdaptSkip: false`。
 * 原实现如此，理由在 `platform-config.js` 的注释里：用户点「保存」
 * 就是明确表示「我配好了」，此时必须清掉「暂不跳过」的标记，
 * 否则发送门禁永远认为环境未就绪。
 */

import type { ApiBody } from "../ui/protocol.js";

/** 表单草稿。字段与原实现的 `draft` 一一对应。 */
export interface EnvDraft {
  readonly platform: "auto" | "windows" | "linux";
  readonly toolkitDir: string;
  readonly nucleiTemplatesDir: string;
  /** 多行文本，一行一个目录。 */
  readonly binDirsText: string;
  /** 工具 id → 路径。 */
  readonly tools: Readonly<Record<string, string>>;
  /** 环境变量名 → 值。 */
  readonly env: Readonly<Record<string, string>>;
  readonly notes: string;
}

/** 提交给 `platformConfigSave` 的 config。 */
export interface EnvConfigPayload {
  readonly platform: "auto" | "windows" | "linux";
  readonly toolkitDir: string;
  readonly nucleiTemplatesDir: string;
  readonly binDirs: readonly string[];
  readonly tools: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly envAdaptConfigured: true;
  readonly envAdaptSkip: false;
}

/**
 * 环境变量的已知键。
 *
 * 顺序即界面顺序。这三个是原实现显式预置的（`Object.assign({FOFA_KEY:'',...}, c.env)`），
 * 所以即使用户没填过，输入框也会出现 —— 换成 `Object.keys(c.env)`
 * 会让从未保存过的用户看不到输入框。
 */
export const KNOWN_ENV_KEYS: readonly string[] = Object.freeze([
  "FOFA_KEY",
  "REDTEAM_VPS_HOST",
  "REDTEAM_VPS_KEY",
]);

/** 平台选项。 */
export const PLATFORM_OPTIONS: readonly { readonly value: EnvDraft["platform"]; readonly label: string }[] = Object.freeze([
  { value: "auto", label: "自动识别" },
  { value: "windows", label: "Windows" },
  { value: "linux", label: "Linux / Kali" },
]);

/** 从不可信值里读字符串（缺失/非字符串 → 空串）。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 从不可信值里读对象（缺失/数组 → 空对象）。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 归一平台取值。 */
function platformOf(value: unknown): EnvDraft["platform"] {
  return value === "windows" || value === "linux" ? value : "auto";
}

/** 把字符串表里的非字符串值丢掉（配置可能被手改坏）。 */
function stringMapOf(value: unknown): Record<string, string> {
  const raw = recordOf(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/**
 * 服务端响应 → 表单草稿。
 *
 * 对应原实现的 `applyDraftFrom`。所有字段都做兜底：
 * 服务端可能给出残缺配置（首次运行、旧版本配置、手改坏的文件）。
 */
export function draftFromResponse(response: unknown): EnvDraft {
  const config = recordOf(recordOf(response)["config"]);
  const binDirs = Array.isArray(config["binDirs"])
    ? config["binDirs"].filter((item): item is string => typeof item === "string")
    : [];
  const env = stringMapOf(config["env"]);
  // 已知键先占位（保证输入框存在），再用配置里的值覆盖。
  const merged: Record<string, string> = {};
  for (const key of KNOWN_ENV_KEYS) merged[key] = "";
  for (const [key, value] of Object.entries(env)) merged[key] = value;

  return {
    platform: platformOf(config["platform"]),
    toolkitDir: text(config["toolkitDir"]),
    nucleiTemplatesDir: text(config["nucleiTemplatesDir"]),
    binDirsText: binDirs.join("\n"),
    tools: stringMapOf(config["tools"]),
    env: merged,
    notes: text(config["notes"]),
  };
}

/**
 * 表单草稿 → 请求载荷。
 *
 * 对应原实现 `save()` 里拼 `config` 的那一段。**逐字段对齐**：
 * 漏一个字段的后果是「保存后该配置消失」，而且界面上看不出来。
 */
export function payloadFromDraft(draft: EnvDraft): EnvConfigPayload {
  return {
    platform: draft.platform,
    toolkitDir: draft.toolkitDir,
    nucleiTemplatesDir: draft.nucleiTemplatesDir,
    binDirs: splitLines(draft.binDirsText),
    tools: draft.tools,
    env: draft.env,
    notes: draft.notes,
    // 用户点保存 = 明确表示配好了：必须清掉「跳过」标记，
    // 否则发送门禁永远认为环境未就绪（原实现同样强制）。
    envAdaptConfigured: true,
    envAdaptSkip: false,
  };
}

/**
 * 多行文本 → 目录数组。
 *
 * `split(/\r?\n/)` + trim + 去空。**必须处理 CRLF**：
 * Windows 用户粘贴的路径带 `\r`，不 trim 会得到带尾随 `\r` 的路径，
 * 后续 `existsSync` 全部失败（而界面上看起来路径是对的）。
 */
export function splitLines(value: unknown): readonly string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** 改一个工具路径（返回新草稿）。 */
export function withTool(draft: EnvDraft, id: string, value: string): EnvDraft {
  return { ...draft, tools: { ...draft.tools, [id]: value } };
}

/** 改一个环境变量（返回新草稿）。 */
export function withEnv(draft: EnvDraft, key: string, value: string): EnvDraft {
  return { ...draft, env: { ...draft.env, [key]: value } };
}

/** 改一个顶层字段（返回新草稿）。 */
export function withField<K extends keyof EnvDraft>(draft: EnvDraft, key: K, value: EnvDraft[K]): EnvDraft {
  return { ...draft, [key]: value };
}

/** 工具清单项（服务端 `tools.items`）。 */
export interface ToolItem {
  readonly id: string;
  readonly label: string;
  readonly path: string | null;
  readonly source: string;
}

/** 从响应里读工具清单。 */
export function toolsOf(response: unknown): readonly ToolItem[] {
  const tools = recordOf(recordOf(response)["tools"]);
  const items = tools["items"];
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const entry = recordOf(item);
    return {
      id: text(entry["id"]),
      label: text(entry["label"]) || text(entry["id"]),
      path: typeof entry["path"] === "string" ? entry["path"] : null,
      source: text(entry["source"]) || "missing",
    };
  }).filter((item) => item.id !== "");
}

/** 已找到工具数。 */
export function foundToolCount(tools: readonly ToolItem[]): number {
  return tools.filter((tool) => tool.path !== null).length;
}

/** 环境适配状态摘要（工具栏上的标签）。 */
export interface EnvSummary {
  readonly platformLabel: string;
  readonly kali: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly readyLabel: string;
  readonly toolLabel: string;
  readonly toolCount: number;
  readonly totalTools: number;
  readonly message: string;
  readonly hint: string;
}

/** 从响应算摘要。 */
export function summaryOf(response: unknown): EnvSummary {
  const body = recordOf(response);
  const runtime = recordOf(body["runtime"]);
  const adapt = recordOf(body["adapt"]);
  const tools = toolsOf(response);
  const found = foundToolCount(tools);
  const effective = text(runtime["effective"]);
  const ready = adapt["ready"] === true;
  const reason = text(adapt["reason"]);

  return {
    platformLabel: effective === "windows" ? "Windows" : "Linux/Kali",
    kali: adapt["kali"] === true,
    ready,
    reason,
    // 就绪时把 reason 拼进去（原实现：`'就绪 · ' + reason`）。
    readyLabel: ready ? "就绪 · " + reason : "待配置",
    toolLabel: "工具 " + found + "/" + tools.length,
    toolCount: found,
    totalTools: tools.length,
    message: text(adapt["message"]),
    hint: text(body["hint"]),
  };
}

/** 出网状态（`egress`）。 */
export interface EgressState {
  readonly httpProxy: string;
  readonly httpsProxy: string;
  readonly allProxy: string;
  readonly noProxy: string;
  readonly note: string;
}

/** 从响应读出网状态。 */
export function egressOf(response: unknown): EgressState {
  const egress = recordOf(recordOf(response)["egress"]);
  return {
    httpProxy: text(egress["http_proxy"]),
    httpsProxy: text(egress["https_proxy"]),
    allProxy: text(egress["all_proxy"]),
    noProxy: text(egress["no_proxy"]),
    note: text(egress["note"]),
  };
}

/** 出网代理的显示值（空 → `(空)`，与原实现一致）。 */
export function displayProxy(value: string): string {
  return value === "" ? "(空)" : value;
}

/**
 * 默认工具目录（未配置时的提示值）。
 *
 * 原实现：`data.toolkitDir || '$DSH_HOME/redteam/toolkit'`。
 */
export const DEFAULT_TOOLKIT_DIR = "$DSH_HOME/redteam/toolkit";

/** 默认 nuclei 模板目录。 */
export function defaultNucleiDir(response: unknown): string {
  const toolkit = text(recordOf(response)["toolkitDir"]) || DEFAULT_TOOLKIT_DIR;
  return text(recordOf(response)["nucleiTemplatesDir"]) || toolkit + "/nuclei-templates";
}

/** 保存成功的提示文案。 */
export function savedMessage(response: unknown): string {
  const path = text(recordOf(recordOf(response)["config"])["path"]);
  return "已保存到 " + (path === "" ? "$DSH_HOME/redteam/config.json" : path);
}

/** 自动分配成功的提示文案。 */
export function assignedMessage(response: unknown): string {
  const body = recordOf(response);
  const count = Number(body["assignedCount"]);
  const safeCount = Number.isFinite(count) ? count : 0;
  const nuclei = typeof body["nucleiTemplatesDir"] === "string" && body["nucleiTemplatesDir"] !== "";
  return "已从文件夹分配 " + safeCount + " 个工具"
    + (nuclei ? "，并识别 nuclei-templates" : "");
}

/** 表单消息（成功或失败）。 */
export type FormMessage = { readonly kind: "ok"; readonly text: string } | { readonly kind: "err"; readonly text: string };

/** 从任意失败响应造错误消息。 */
export function errorOf(response: unknown, fallback: string): FormMessage {
  const body = recordOf(response);
  const error = body["error"];
  return { kind: "err", text: typeof error === "string" && error !== "" ? error : fallback };
}

/** 判断响应是否失败。 */
export function failed(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  return recordOf(response)["ok"] === false;
}

/** 自动分配时的目录校验：空路径直接拦下（不发请求）。 */
export function assignDirOf(folderPath: unknown, draft: EnvDraft | null): string {
  const raw = typeof folderPath === "string" ? folderPath.trim() : "";
  if (raw !== "") return raw;
  return draft === null ? "" : draft.toolkitDir.trim();
}

/** 自动分配的错误提示（原实现文案）。 */
export const ASSIGN_EMPTY_DIR_MESSAGE = "请先填写工具所在文件夹路径";

/** 供组件使用的「一次保存」结果。 */
export interface SaveOutcome {
  readonly message: FormMessage;
  /** 成功时带回的服务端响应（用于刷新 data）。 */
  readonly response: ApiBody | null;
}

/** 从保存响应算结果。 */
export function saveOutcomeOf(response: unknown): SaveOutcome {
  if (failed(response)) {
    return { message: errorOf(response, "保存失败"), response: null };
  }
  return {
    message: { kind: "ok", text: savedMessage(response) },
    response: response as ApiBody,
  };
}

/** 从自动分配响应算结果。 */
export function assignOutcomeOf(response: unknown): SaveOutcome {
  if (failed(response)) {
    return { message: errorOf(response, "自动分配失败"), response: null };
  }
  return {
    message: { kind: "ok", text: assignedMessage(response) },
    response: response as ApiBody,
  };
}
