/**
 * 智能体提示词页（`prompts` 页签）的渲染。
 *
 * 数据与判定全在 `prompts-model.ts`，这里只排版。
 *
 * ## 布局（原实现是左右分栏）
 *
 * ```
 * ┌─────────────┬────────────────────────────────────┐
 * │ 角色列表    │ 工具栏：标题 / 更新 / 恢复 / 全部恢复 / 保存 │
 * │  信息收集   │ 消息（成功 / 失败）                  │
 * │  资产梳理   │ 正文编辑框                          │
 * │  …          │ 落盘位置说明                        │
 * └─────────────┴────────────────────────────────────┘
 * ```
 *
 * ## 一个原实现的细节，这里保留
 *
 * 「恢复默认为当前」与「保存」在**没有选中角色时禁用**，但「全部恢复默认」
 * 仍然可点 —— 后者不依赖 `active`，把它一起禁用会让用户在角色表还没读回来
 * 时连兜底都做不到。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import {
  BUILTIN_NOTICE,
  DRAFT_PLACEHOLDER,
  EMPTY_PROMPTS_MESSAGE,
  PROMPTS_ERROR_FALLBACK,
  canResetAll,
  canResetCurrent,
  canSave,
  draftFor,
  promptFor,
  promptHeading,
  promptHint,
  promptItemClass,
  promptItemLabel,
  previewOf,
  resetOutcomeOf,
  saveBlockedMessage,
  saveOutcomeOf,
  resetBlockedMessage,
  updatedLabel,
  withLocalContent,
  type PromptLoad,
  type PromptMessage,
  type PromptRole,
} from "./prompts-model.js";

/** 提示词页的 props。 */
export interface PromptsTabProps {
  /** 角色列表与内置标记（`null` = 还没加载）。 */
  readonly catalog: PromptLoad | null;
  /** 当前选中角色。 */
  readonly active: string | null;
  /** 编辑中的正文。 */
  readonly draft: string;
  /** 表单消息。 */
  readonly message: PromptMessage | null;
  /** 是否在请求中。 */
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly onSelect: (role: string) => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onSave: () => void;
  /** `all=true` 时恢复四个角色。 */
  readonly onReset: (all: boolean) => void;
}

/** 一行角色。 */
function roleRow(runtime: ConsoleRuntime, props: PromptsTabProps, role: PromptRole): ReactNode {
  return runtime.h("div", {
    key: role.role,
    className: promptItemClass(role, props.active),
    role: "button",
    tabIndex: 0,
    "aria-label": promptItemLabel(role),
    "aria-expanded": props.active === role.role ? "true" : "false",
    onClick: () => props.onSelect(role.role),
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        props.onSelect(role.role);
      }
    },
  },
    runtime.h("div", { className: "rt-item-name" }, role.title),
    runtime.h("div", { className: "rt-item-desc" }, previewOf(role)),
  );
}

/**
 * 渲染提示词页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderPromptsTab(runtime: ConsoleRuntime, props: PromptsTabProps): ReactNode {
  const { h } = runtime;
  const load = props.catalog;
  const roles = load?.roles ?? [];
  const current = promptFor(roles, props.active);

  const list = roles.length > 0
    ? roles.map((role) => roleRow(runtime, props, role))
    : h("div", { className: "rt-empty" }, EMPTY_PROMPTS_MESSAGE);

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, promptHeading(roles, props.active)),
    h("span", { className: "rt-tag" }, updatedLabel(roles, props.active)),
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn",
      disabled: !canResetCurrent(props.busy, props.active),
      title: "把当前角色恢复成内置最新版提示词",
      onClick: () => props.onReset(false),
    }, "恢复默认为当前"),
    h("button", {
      className: "rt-btn",
      disabled: !canResetAll(props.busy),
      title: "四个角色全部恢复成内置最新版提示词",
      onClick: () => props.onReset(true),
    }, "全部恢复默认"),
    h("button", {
      className: "rt-btn rt-btn-primary",
      disabled: !canSave(props.busy, props.active),
      onClick: () => props.onSave(),
    }, props.busy ? "保存中…" : "保存"),
  );

  // 加载失败与内置默认是**两种不同**的提示：前者是错误（红），
  // 后者是正常状态说明（灰）。合并会让「内置默认」看起来像故障。
  const loadError = load !== null && load.error !== null
    ? h("div", { className: "rt-err" }, load.error)
    : null;

  const builtinNotice = load !== null && load.ok && load.builtin
    ? h("div", { className: "rt-foot" }, BUILTIN_NOTICE)
    : null;

  const messageNode = props.message !== null
    ? h("div", {
        className: props.message.kind === "err" ? "rt-err" : "rt-foot",
      }, props.message.text)
    : null;

  const editor = h("div", { className: "rt-pane" },
    h("textarea", {
      className: "rt-textarea",
      value: props.draft,
      placeholder: DRAFT_PLACEHOLDER,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onDraftChange(value);
      },
    }),
    h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", marginTop: 6 } },
      promptHint(props.active)),
  );

  return h("div", { className: "rt-split" },
    h("div", { className: "rt-list" },
      // 刷新按钮挂在列表顶上：没有靶标时也能重读内置默认
      // （原实现靠外层 refreshKey 驱动，这里给一个显式入口）。
      h("div", { className: "rt-toolbar" },
        h("span", { style: { fontWeight: 600 } }, "角色"),
        h("span", { className: "rt-tag" }, roles.length + " 个"),
        h("div", { className: "rt-spacer" }),
        h("button", {
          className: "rt-btn",
          disabled: props.busy,
          onClick: () => props.onRefresh(),
        }, props.busy ? "读取中…" : "刷新"),
      ),
      loadError,
      builtinNotice,
      list,
    ),
    h("div", { className: "rt-main" },
      toolbar,
      messageNode,
      editor,
    ),
  );
}

/** 读取角色提示词（`engagement` 为 `null` 时读内置默认）。 */
export async function loadPrompts(api: ApiClient, engagement: string | null): Promise<ApiResponse> {
  return engagement === null || engagement === ""
    ? api.raw({ op: "prompts" })
    : api.raw({ op: "prompts", engagement });
}

/**
 * 保存一个角色的正文。
 *
 * 无靶标时**不发请求**直接返回错误消息 —— 原实现同样在发请求前拦下。
 */
export async function savePrompt(
  api: ApiClient,
  engagement: string | null,
  role: string | null,
  content: string,
): Promise<{ readonly message: PromptMessage; readonly response: ApiResponse | null }> {
  const blocked = saveBlockedMessage(engagement);
  if (blocked !== null) return { message: { kind: "err", text: blocked }, response: null };
  if (role === null || role === "") {
    return { message: { kind: "err", text: "没有选中角色" }, response: null };
  }
  const response = await api.raw({
    op: "savePrompt",
    engagement: engagement as string,
    role,
    content,
  });
  return {
    message: saveOutcomeOf(response),
    response: response.ok === false ? null : response,
  };
}

/** 恢复内置默认（`all=true` 时不带 `role`）。 */
export async function resetPrompts(
  api: ApiClient,
  engagement: string | null,
  role: string | null,
  all: boolean,
): Promise<{ readonly message: PromptMessage; readonly response: ApiResponse | null }> {
  const blocked = resetBlockedMessage(engagement);
  if (blocked !== null) return { message: { kind: "err", text: blocked }, response: null };
  const response = await api.raw({
    op: "resetPrompts",
    engagement: engagement as string,
    ...(all ? {} : { role }),
  });
  return {
    message: resetOutcomeOf(response),
    response: response.ok === false ? null : response,
  };
}

/**
 * 保存成功后本地更新列表（不等服务端回读）。
 *
 * 时间戳用 ISO 串（与原实现的 `new Date().toISOString()` 同形），
 * 这样 `formatTimestamp` 的截断结果一致。
 */
export function applySavedDraft(
  load: PromptLoad | null,
  active: string | null,
  content: string,
  now: string,
): PromptLoad | null {
  if (load === null) return null;
  return { ...load, roles: withLocalContent(load.roles, active, content, now) };
}

/** 从响应解析出的草稿（供保存后回读用）。 */
export function draftOfLoad(load: PromptLoad | null, active: string | null): string {
  if (load === null) return "";
  return draftFor(load.roles, active);
}

/** 错误文案兜底（供组件在异常路径上用）。 */
export function promptErrorMessage(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  if (error instanceof Error && error.message !== "") return error.message;
  return PROMPTS_ERROR_FALLBACK;
}
