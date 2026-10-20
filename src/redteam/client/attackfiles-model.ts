/**
 * 攻击文件页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `AttackFilesTab` 只有 84 行，但里面有三个必须钉住的细节：
 *
 * 1. **文件类型的显示名**（`FILE_KIND`）：`poc` → `POC`、`exp` → `EXP`、
 *    `script` → `脚本`、`wordlist` → `字典`、`other` → `其他`。
 *    未知类型**原样显示**（不兜底成「其他」）—— 上游加了新类型时界面能暴露出来。
 * 2. **详情只能同时展开一个**：`detail.id === f.id` 判定，点同一条收起。
 * 3. **文件夹计数与文件数可能不一致**：`folder.count` 是服务端统计，
 *    `folder.files` 是本页拿到的（可能被截断）。工具栏的「N 个文件」
 *    用 `count` 求和（与文件夹头一致），不数数组长度。
 *
 * ## 一个真实的空态分支
 *
 * `folder.files` 为空但文件夹存在时，展开后显示「（空）」而不是整块消失 ——
 * 这与「没有任何文件夹」是两种状态。
 */

import { formatTimestamp, isFailure } from "./helpers.js";

/** 文件类型 → 中文。 */
export const FILE_KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  poc: "POC",
  exp: "EXP",
  script: "脚本",
  wordlist: "字典",
  other: "其他",
});

/** 空态文案。 */
export const EMPTY_FILES_MESSAGE = "暂无攻击文件（打通的脚本/POC/EXP 会按目标文件夹出现在这里）";

/** 底部说明。 */
export const FILES_FOOTER = "目录：attack-files/<IP|URL主机|C段>/ ｜ 只收录实际生效的文件";

/** 读取失败的兜底文案。 */
export const FILES_ERROR_FALLBACK = "读取失败";

/** 一个文件夹。 */
export interface FileFolder {
  /** 文件夹名（目标 IP / URL 主机 / C 段）。 */
  readonly folder: string;
  /** 服务端统计的条数（可能与 `files.length` 不同）。 */
  readonly count: number;
  readonly files: readonly FileRow[];
}

/** 一个文件（列表行）。 */
export interface FileRow {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly description: string;
}

/** 文件详情（`readAttackFile` 的响应）。 */
export interface FileDetail {
  readonly id: number;
  readonly name: string;
  readonly content: string;
  readonly path: string;
  readonly evidence: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

/** 从不可信值读字符串。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 从不可信值读对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从不可信值读数组。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 读有限数字（非有限 → `null`）。 */
function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 读计数字段（非有限 / 负数 → 0）。 */
export function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 类型的中文名（未知原样显示；空串 → `—`）。 */
export function kindLabel(kind: string): string {
  if (kind === "") return "—";
  return FILE_KIND_LABEL[kind] ?? kind;
}

/** 解析一个文件行。 */
export function fileRowOf(raw: unknown): FileRow | null {
  const item = asRecord(raw);
  const id = numberOrNull(item["id"]);
  if (id === null) return null;
  return {
    id,
    name: text(item["name"]),
    kind: text(item["kind"]),
    description: text(item["description"]),
  };
}

/** 解析一个文件夹。 */
export function fileFolderOf(raw: unknown): FileFolder | null {
  const item = asRecord(raw);
  const folder = text(item["folder"]);
  if (folder === "") return null;
  const files = asArray(item["files"])
    .map(fileRowOf)
    .filter((entry): entry is FileRow => entry !== null);
  // `count` 缺失时退回数组长度：否则工具栏会显示「0 个文件」而列表里有内容。
  const rawCount = numberOrNull(item["count"]);
  return {
    folder,
    count: rawCount === null ? files.length : countOrZero(rawCount),
    files,
  };
}

/** 解析 `attackFiles` 响应。 */
export function fileFoldersOf(response: unknown): readonly FileFolder[] {
  if (isFailure(response)) return [];
  return asArray(asRecord(response)["items"])
    .map(fileFolderOf)
    .filter((entry): entry is FileFolder => entry !== null);
}

/** 文件夹总数（工具栏的「N 个目标」）。 */
export function folderCount(folders: readonly FileFolder[]): number {
  return folders.length;
}

/**
 * 文件总数（工具栏的「N 个文件」）。
 *
 * 用 `count` 求和而不是 `files.length` —— 与文件夹头上的计数一致，
 * 也包含服务端统计到但本页没取回的文件。
 */
export function fileCount(folders: readonly FileFolder[]): number {
  return folders.reduce((sum, folder) => sum + folder.count, 0);
}

/** 文件夹的标题（`folder/`）。 */
export function folderTitle(folder: FileFolder): string {
  return folder.folder + "/";
}

/** 文件夹的计数文案。 */
export function folderCountLabel(folder: FileFolder): string {
  return folder.count + " 个文件";
}

/** 文件夹的折叠键（`folder:<name>`）。 */
export function folderCollapseKey(folder: FileFolder): string {
  return "folder:" + folder.folder;
}

/** 解析文件详情。 */
export function fileDetailOf(response: unknown): FileDetail | null {
  if (isFailure(response)) return null;
  const body = asRecord(response);
  const id = numberOrNull(body["id"]);
  if (id === null) return null;
  return {
    id,
    name: text(body["name"]),
    content: text(body["content"]),
    path: text(body["path"]),
    evidence: text(body["evidence"]),
    createdAt: text(body["created_at"]) || text(body["createdAt"]),
    createdBy: text(body["created_by"]) || text(body["createdBy"]),
  };
}

/** 详情里的「记录」行（时间 + 记录人）。 */
export function detailRecordedLine(detail: FileDetail): string {
  return formatTimestamp(detail.createdAt)
    + (detail.createdBy !== "" ? " · " + detail.createdBy : "");
}

/** 详情正文（空 → `（空）`）。 */
export function detailContent(detail: FileDetail): string {
  return detail.content !== "" ? detail.content : "（空）";
}

/** 详情里的「效果」行（空 → `—`）。 */
export function detailEvidence(detail: FileDetail): string {
  return detail.evidence !== "" ? detail.evidence : "—";
}

/** 行首的折叠箭头（展开 → `▾`，否则 `▸`）。 */
export function caretOf(open: boolean): string {
  return open ? "▾" : "▸";
}

/** 行是否展开（`detail` 存在且 id 相同）。 */
export function isRowOpen(detail: FileDetail | null, fileId: number): boolean {
  return detail !== null && detail.id === fileId;
}

/**
 * 点击一个文件后的目标状态。
 *
 * 原实现：点同一条（已展开）→ 收起；点别的 → 先清空再重新读。
 * 这里只决定「应选中谁」，`null` 表示收起。
 */
export function nextDetailId(current: number | null, clicked: number): number | null {
  return current === clicked ? null : clicked;
}

/** 工具栏的计数文案（`N 个目标 / M 个文件`）。 */
export function toolbarCountLabel(folders: readonly FileFolder[]): string {
  return folderCount(folders) + " 个目标 / " + fileCount(folders) + " 个文件";
}

/** 刷新按钮的文案。 */
export function refreshLabel(busy: boolean): string {
  return busy ? "刷新中…" : "刷新";
}

/** 读取错误的文案（失败响应里的 `error`，缺失回退）。 */
export function filesErrorOf(response: unknown, fallback = FILES_ERROR_FALLBACK): string {
  const error = asRecord(response)["error"];
  return typeof error === "string" && error !== "" ? error : fallback;
}

/** 文件行的 title（描述；空 → 空串）。 */
export function rowTitle(file: FileRow): string {
  return file.description;
}

/** 文件行的描述显示值（空 → `—`）。 */
export function rowDescription(file: FileRow): string {
  return file.description !== "" ? file.description : "—";
}

/** 文件行的文件名（空 → `(未命名)`）。 */
export function rowName(file: FileRow): string {
  return file.name !== "" ? file.name : "(未命名)";
}
