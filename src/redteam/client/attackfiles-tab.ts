/**
 * 攻击文件页（`attackfiles` 页签）的渲染。
 *
 * 数据与判定全在 `attackfiles-model.ts`，这里只排版。
 *
 * ## 版面（按目标文件夹折叠）
 *
 * ```
 * 工具栏：攻击文件 · N 个目标 / M 个文件 | 刷新
 * ▾ 10.0.0.5/  3 个文件
 *     ▸ vnc_brute.py   [脚本]  VNC 弱口令爆破
 *     ▾ poc.sh         [POC]   回显 uid=0
 *       效果 … / 路径 … / 记录 … / 正文
 * ```
 *
 * ## 一个原实现的细节，这里保留
 *
 * 文件夹**默认展开**（`isSectionOpen(state, key, true)`）：攻击文件页的
 * 全部内容就是这些文件，默认折叠会让第一次进来的人看到一片空白标题。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import { isSectionOpen, toggleSection, type CollapseState } from "./state.js";
import {
  EMPTY_FILES_MESSAGE,
  FILES_FOOTER,
  caretOf,
  detailContent,
  detailEvidence,
  detailRecordedLine,
  fileCount,
  folderCollapseKey,
  folderCount,
  folderCountLabel,
  folderTitle,
  isRowOpen,
  kindLabel,
  rowDescription,
  rowName,
  rowTitle,
  toolbarCountLabel,
  refreshLabel,
  type FileDetail,
  type FileFolder,
  type FileRow,
} from "./attackfiles-model.js";

/** 攻击文件页的 props。 */
export interface AttackFilesTabProps {
  /** 文件夹列表（空数组 = 读到了但没有文件；`null` 由容器传空数组 + error）。 */
  readonly folders: readonly FileFolder[];
  /** 当前展开的文件详情（`null` = 都没展开）。 */
  readonly detail: FileDetail | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 是否在请求中。 */
  readonly busy: boolean;
  /** 折叠状态。 */
  readonly collapse: CollapseState;
  readonly onRefresh: () => void;
  /** 点击一行文件（同一条再点收起）。 */
  readonly onOpenFile: (file: FileRow) => void;
  readonly onCollapseChange: (state: CollapseState) => void;
}

/** 一行文件。 */
function fileRowNode(
  runtime: ConsoleRuntime,
  props: AttackFilesTabProps,
  file: FileRow,
): ReactNode {
  const { h } = runtime;
  // 展开态是 `detail` 的派生值：不额外加布尔 props，避免第二个真相来源。
  const open = isRowOpen(props.detail, file.id);
  return h("div", {
    key: "a" + file.id,
    className: "rt-vrow",
    style: { gridTemplateColumns: "18px 1.2fr 60px 1.6fr", cursor: "pointer" },
    role: "button",
    tabIndex: 0,
    onClick: () => props.onOpenFile(file),
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        props.onOpenFile(file);
      }
    },
  },
    h("span", { className: "rt-sec-caret" }, caretOf(open)),
    h("span", { className: "rt-mono" }, rowName(file)),
    h("span", null, h("span", { className: "rt-tag rt-tag-active" }, kindLabel(file.kind))),
    h("span", {
      style: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary)" },
      title: rowTitle(file),
    }, rowDescription(file)),
  );
}

/** 一个文件夹（含展开详情的行）。 */
function folderNode(runtime: ConsoleRuntime, props: AttackFilesTabProps, folder: FileFolder): ReactNode {
  const { h } = runtime;
  const key = folderCollapseKey(folder);
  const open = isSectionOpen(props.collapse, key, true);
  const children: ReactNode[] = [];
  for (const file of folder.files) {
    children.push(fileRowNode(runtime, props, file));
    const detail = props.detail;
    if (detail === null || detail.id !== file.id) continue;
    children.push(h("div", {
      key: "ad" + file.id,
      className: "rt-vrow",
      style: { cursor: "default", gridTemplateColumns: "1fr" },
    }, h("div", { className: "rt-vdetail" },
      h("div", { className: "rt-kv" }, h("b", null, "效果"), h("span", null, detailEvidence(detail))),
      h("div", { className: "rt-kv" },
        h("b", null, "路径"),
        h("span", { className: "rt-mono", style: { wordBreak: "break-all" } }, detail.path)),
      h("div", { className: "rt-kv" }, h("b", null, "记录"), h("span", null, detailRecordedLine(detail))),
      h("pre", {
        className: "rt-md",
        style: {
          border: "1px solid var(--dsw-alias-border-l1)",
          borderRadius: 6,
          maxHeight: "40vh",
          padding: "10px 12px",
        },
      }, detailContent(detail)),
    )));
  }

  return h("div", { key: "sec:" + folder.folder, className: "rt-sec-wrap" },
    h("div", {
      className: "rt-sec t-folder",
      role: "button",
      tabIndex: 0,
      "aria-expanded": open ? "true" : "false",
      onClick: () => props.onCollapseChange(toggleSection(props.collapse, key, true)),
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          props.onCollapseChange(toggleSection(props.collapse, key, true));
        }
      },
    },
      h("span", { className: "rt-sec-caret" }, caretOf(open)),
      h("span", { className: "rt-sec-title" }, folderTitle(folder)),
      h("span", { className: "rt-sec-count" }, folderCountLabel(folder)),
    ),
    open
      ? h("div", { className: "rt-sec-body" },
          children.length > 0
            ? children
            : h("div", { className: "rt-atest-meta" }, "（空）"))
      : null,
  );
}

/**
 * 渲染攻击文件页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderAttackFilesTab(runtime: ConsoleRuntime, props: AttackFilesTabProps): ReactNode {
  const { h } = runtime;

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "攻击文件"),
    h("span", { className: "rt-tag" }, toolbarCountLabel(props.folders)),
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn",
      disabled: props.busy,
      onClick: () => props.onRefresh(),
    }, refreshLabel(props.busy)),
  );

  const errorNode = props.error !== null ? h("div", { className: "rt-err" }, props.error) : null;

  return h("div", { className: "rt-main" },
    toolbar,
    errorNode,
    h("div", { className: "rt-table" },
      props.folders.map((folder) => folderNode(runtime, props, folder)),
      folderCount(props.folders) === 0
        ? h("div", { className: "rt-empty" }, EMPTY_FILES_MESSAGE)
        : null,
    ),
    h("div", { className: "rt-foot" }, h("span", null, FILES_FOOTER)),
  );
}

/** 读攻击文件列表。 */
export async function loadAttackFiles(api: ApiClient, engagement: string): Promise<ApiResponse> {
  return api.raw({ op: "attackFiles", engagement });
}

/** 读一个文件的正文。 */
export async function loadAttackFile(
  api: ApiClient,
  engagement: string,
  id: number,
): Promise<ApiResponse> {
  return api.raw({ op: "readAttackFile", engagement, id });
}

/** 文件总数（供容器在外部统计用）。 */
export function totalFileCount(folders: readonly FileFolder[]): number {
  return fileCount(folders);
}
