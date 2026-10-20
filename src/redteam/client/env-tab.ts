/**
 * 环境适配页（`env` 页签）的渲染。
 *
 * 数据与计算全在 `env-model.ts`（77 用例），这里只做排版。
 * 这样分工的好处：表单字段映射的正确性由纯函数测试保证，
 * 渲染层只需保证「该显示的都显示了」。
 *
 * ## 一个原实现的取舍，这里保留
 *
 * 原 `EnvTab` 的「自动分配」按钮**不发请求就直接报错**（目录为空时）：
 * ```js
 * if (!dir) { setMsg({ err: '请先填写工具所在文件夹路径' }); return }
 * ```
 * 这比「发一个注定失败的空路径请求」好：用户立刻得到提示，
 * 服务端不必处理无意义请求。`assignDirOf` 保留了这个前置校验。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import {
  ASSIGN_EMPTY_DIR_MESSAGE,
  PLATFORM_OPTIONS,
  KNOWN_ENV_KEYS,
  assignDirOf,
  defaultNucleiDir,
  displayProxy,
  draftFromResponse,
  egressOf,
  foundToolCount,
  payloadFromDraft,
  summaryOf,
  toolsOf,
  type EnvDraft,
  type FormMessage,
  type ToolItem,
} from "./env-model.js";

/** 环境页的 props。 */
export interface EnvTabProps {
  /** 当前草稿（`null` = 还没加载）。 */
  readonly draft: EnvDraft | null;
  /** 最近一次读取的响应（用于摘要 / 出网状态）。 */
  readonly data: ApiResponse | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 表单消息。 */
  readonly message: FormMessage | null;
  /** 是否在请求中。 */
  readonly busy: boolean;
  /** 自动分配的输入框内容。 */
  readonly folderPath: string;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onAssign: () => void;
  readonly onFolderPathChange: (value: string) => void;
  readonly onDraftChange: (next: EnvDraft) => void;
}

/** 平台标签。 */
function platformTag(runtime: ConsoleRuntime, label: string, className: string): ReactNode {
  return runtime.h("span", { className }, label);
}

/** 工具行。 */
function toolRow(runtime: ConsoleRuntime, props: EnvTabProps, tool: ToolItem): ReactNode {
  const found = tool.path !== null;
  return runtime.h("div", { key: tool.id, className: "rt-kv" },
    runtime.h("span", { className: "rt-mono" }, tool.id),
    runtime.h("span", { className: found ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn" },
      found ? tool.source : "未找到"),
    runtime.h("input", {
      className: "rt-input",
      style: { flex: 1 },
      placeholder: found ? (tool.path ?? "") : "留空则自动查找",
      // 未加载草稿时禁用：否则用户输入会被随后的 load 覆盖。
      disabled: props.draft === null,
      value: props.draft?.tools[tool.id] ?? "",
      onChange: (event) => {
        if (props.draft === null) return;
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onDraftChange({ ...props.draft, tools: { ...props.draft.tools, [tool.id]: value } });
      },
    }),
  );
}

/**
 * 渲染环境适配页。
 *
 * 无 hook、不读全局，只按 props 拼元素树 —— 因此可以直接测。
 */
export function renderEnvTab(runtime: ConsoleRuntime, props: EnvTabProps): ReactNode {
  const { h } = runtime;
  const summary = summaryOf(props.data);
  const tools = toolsOf(props.data);
  const egress = egressOf(props.data);
  const draft = props.draft;

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "环境适配"),
    platformTag(runtime, summary.platformLabel, "rt-tag"),
    summary.kali ? platformTag(runtime, "Kali", "rt-tag rt-tag-live") : null,
    platformTag(runtime, summary.readyLabel, summary.ready ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn"),
    platformTag(runtime, summary.toolLabel, summary.toolCount > 0 ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn"),
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn",
      disabled: props.busy,
      onClick: () => props.onRefresh(),
    }, props.busy ? "读取中…" : "刷新"),
    h("button", {
      className: "rt-btn rt-btn-primary",
      // 没加载出草稿时不能保存（否则会写入一份空配置覆盖原有配置）。
      disabled: props.busy || draft === null,
      onClick: () => props.onSave(),
    }, "保存"),
  );

  const messages: ReactNode[] = [];
  if (props.error !== null) {
    messages.push(h("div", { key: "err", className: "rt-err" }, props.error));
  }
  if (props.message !== null) {
    messages.push(h("div", {
      key: "msg",
      className: props.message.kind === "err" ? "rt-err" : "rt-foot",
    }, props.message.text));
  }

  const noticeCard = h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.6 } },
    summary.message !== ""
      ? summary.message
      : "均可选填：留空则用默认路径/自动查找。填了的覆盖默认。密钥类只在需要测绘/反弹时才填。",
  );

  const assignCard = h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.6 } },
    h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "整包文件夹 → 自动分配工具"),
    h("div", { style: { marginBottom: 8, opacity: 0.9 } },
      "工具都在同一个文件夹（含子目录）时，填路径后点「自动分配」："
      + "会写入 toolkitDir，并按文件名匹配 nmap / nuclei / fscan 等填到下方。"),
    h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
      h("input", {
        className: "rt-input",
        style: { flex: 1 },
        placeholder: "例如 D:\\pentest-tools 或 /opt/toolkit",
        value: props.folderPath,
        onChange: (event) => {
          const value = String((event.target as { value?: string } | null)?.value ?? "");
          props.onFolderPathChange(value);
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") props.onAssign();
        },
      }),
      h("button", {
        className: "rt-btn rt-btn-primary",
        disabled: props.busy,
        onClick: () => props.onAssign(),
      }, props.busy ? "扫描中…" : "自动分配"),
    ),
    // 目录为空时**提前提示**，而不是等用户点了才报错。
    assignDirOf(props.folderPath, draft) === ""
      ? h("div", { style: { marginTop: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
          ASSIGN_EMPTY_DIR_MESSAGE)
      : null,
  );

  const hintCard = summary.hint !== ""
    ? h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.6 } }, summary.hint)
    : null;

  const egressCard = h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.55 } },
    h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "出网状态（借鉴 Z3r0 egress，只读）"),
    h("div", { className: "rt-mono", style: { fontSize: 11 } }, "HTTP_PROXY=" + displayProxy(egress.httpProxy)),
    h("div", { className: "rt-mono", style: { fontSize: 11 } }, "HTTPS_PROXY=" + displayProxy(egress.httpsProxy)),
    h("div", { className: "rt-mono", style: { fontSize: 11 } }, "ALL_PROXY=" + displayProxy(egress.allProxy)),
    h("div", { className: "rt-mono", style: { fontSize: 11 } }, "NO_PROXY=" + displayProxy(egress.noProxy)),
    egress.note !== "" ? h("div", { style: { marginTop: 6, opacity: 0.85 } }, egress.note) : null,
  );

  const platformField = h("div", { className: "rt-kv" },
    h("span", null, "平台"),
    h("select", {
      className: "rt-input",
      value: draft?.platform ?? "auto",
      disabled: draft === null,
      onChange: (event) => {
        if (draft === null) return;
        const raw = String((event.target as { value?: string } | null)?.value ?? "auto");
        const platform = raw === "windows" || raw === "linux" ? raw : "auto";
        props.onDraftChange({ ...draft, platform });
      },
    }, PLATFORM_OPTIONS.map((option) =>
      h("option", { key: option.value, value: option.value }, option.label))),
  );

  const dirFields = h("div", null,
    h("div", { className: "rt-kv" },
      h("span", null, "工具目录"),
      h("input", {
        className: "rt-input",
        style: { flex: 1 },
        placeholder: DEFAULT_TOOLKIT_PLACEHOLDER,
        disabled: draft === null,
        value: draft?.toolkitDir ?? "",
        onChange: (event) => {
          if (draft === null) return;
          const value = String((event.target as { value?: string } | null)?.value ?? "");
          props.onDraftChange({ ...draft, toolkitDir: value });
        },
      }),
    ),
    h("div", { className: "rt-kv" },
      h("span", null, "nuclei 模板"),
      h("input", {
        className: "rt-input",
        style: { flex: 1 },
        placeholder: defaultNucleiDir(props.data),
        disabled: draft === null,
        value: draft?.nucleiTemplatesDir ?? "",
        onChange: (event) => {
          if (draft === null) return;
          const value = String((event.target as { value?: string } | null)?.value ?? "");
          props.onDraftChange({ ...props.draft!, nucleiTemplatesDir: value });
        },
      }),
    ),
    h("div", { className: "rt-kv" },
      h("span", null, "额外 bin 目录"),
      h("textarea", {
        className: "rt-input",
        style: { flex: 1 },
        rows: 3,
        placeholder: "一行一个目录",
        disabled: draft === null,
        value: draft?.binDirsText ?? "",
        onChange: (event) => {
          if (draft === null) return;
          const value = String((event.target as { value?: string } | null)?.value ?? "");
          props.onDraftChange({ ...draft, binDirsText: value });
        },
      }),
    ),
  );

  // **必须用 `envKeysOf` 而不是 `Object.keys(draft?.env ?? {})`**：
  // 草稿未加载时后者给空数组，整个环境变量区渲染成空白 ——
  // 界面看起来像「这个功能没有环境变量」，而实际上只是还没加载完。
  const envFields = h("div", null,
    envKeysOf(draft).map((key) =>
      h("div", { key, className: "rt-kv" },
        h("span", { className: "rt-mono" }, key),
        h("input", {
          className: "rt-input",
          style: { flex: 1 },
          // 与其它受草稿驱动的输入框保持一致：未加载时禁用，
          // 否则用户输入会被随后的 load 覆盖（看起来像「输入没生效」）。
          disabled: draft === null,
          value: draft?.env[key] ?? "",
          onChange: (event) => {
            if (draft === null) return;
            const value = String((event.target as { value?: string } | null)?.value ?? "");
            props.onDraftChange({ ...draft, env: { ...draft.env, [key]: value } });
          },
        }),
      )),
  );

  const toolRows = tools.map((tool) => toolRow(runtime, props, tool));

  const notesField = h("div", { className: "rt-kv" },
    h("span", null, "备注"),
    h("textarea", {
      className: "rt-input",
      style: { flex: 1 },
      rows: 2,
      disabled: draft === null,
      value: draft?.notes ?? "",
      onChange: (event) => {
        if (draft === null) return;
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onDraftChange({ ...draft, notes: value });
      },
    }),
  );

  return h("div", { className: "rt-main" },
    toolbar,
    h("div", { className: "rt-pane", style: { minHeight: 0 } },
      messages,
      noticeCard,
      assignCard,
      hintCard,
      egressCard,
      h("div", { className: "rt-card", style: { margin: "0 0 8px" } },
        h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "平台与目录"),
        platformField,
        dirFields,
      ),
      h("div", { className: "rt-card", style: { margin: "0 0 8px" } },
        h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "环境变量"),
        envFields,
      ),
      h("div", { className: "rt-card", style: { margin: "0 0 8px" } },
        h("div", { style: { fontWeight: 600, marginBottom: 6 } },
          "工具路径（" + foundToolCount(tools) + "/" + tools.length + " 已找到）"),
        toolRows.length > 0
          ? toolRows
          : h("div", { className: "rt-empty" }, "暂无工具清单"),
      ),
      h("div", { className: "rt-card", style: { margin: "0 0 8px" } },
        h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "备注"),
        notesField,
      ),
    ),
  );
}

/** 工具目录的输入提示（与原实现一致）。 */
const DEFAULT_TOOLKIT_PLACEHOLDER = "$DSH_HOME/redteam/toolkit";

/**
 * 加载流程（供组件调用）。
 *
 * 抽出来是为了让「读取 → 设草稿」的时序可测：先清错误、再发请求、
 * 失败时保留上次草稿（而不是清空 —— 清空会让用户正在编辑的内容消失）。
 */
export async function loadEnv(
  api: ApiClient,
  onLoaded: (response: ApiResponse) => void,
  onError: (message: string) => void,
): Promise<void> {
  const response = await api.raw({ op: "platformConfigGet" });
  if (response.ok === false) {
    onError(response.error ?? "读取失败");
    return;
  }
  onLoaded(response);
}

/** 保存流程。 */
export async function saveEnv(
  api: ApiClient,
  draft: EnvDraft,
): Promise<{ readonly ok: boolean; readonly response: ApiResponse | null }> {
  const response = await api.raw({ op: "platformConfigSave", config: payloadFromDraft(draft) });
  return { ok: response.ok !== false, response: response.ok === false ? null : response };
}

/** 自动分配流程。 */
export async function assignEnv(
  api: ApiClient,
  folderPath: string,
  draft: EnvDraft | null,
): Promise<{ readonly ok: boolean; readonly response: ApiResponse | null; readonly error: string | null }> {
  const dir = assignDirOf(folderPath, draft);
  if (dir === "") {
    // 前置校验：不发注定失败的空路径请求。
    return { ok: false, response: null, error: ASSIGN_EMPTY_DIR_MESSAGE };
  }
  const response = await api.raw({ op: "platformAssignToolkit", dir });
  if (response.ok === false) {
    return { ok: false, response: null, error: response.error ?? "自动分配失败" };
  }
  return { ok: true, response, error: null };
}

/**
 * 从保存响应刷新草稿。
 *
 * 保存成功后要用服务端返回值重建草稿 —— 服务端可能对输入做了归一
 * （如 clamps 平台、展开 `~`），不回读就会显示成用户输入的原样，
 * 与磁盘上的实际配置不一致。
 */
export function refreshDraftFrom(response: ApiResponse): EnvDraft | null {
  if (response.ok === false) return null;
  return draftFromResponse(response);
}

/** 环境变量键列表（组件渲染时用）。 */
export function envKeysOf(draft: EnvDraft | null): readonly string[] {
  if (draft === null) return KNOWN_ENV_KEYS;
  return Object.keys(draft.env);
}
