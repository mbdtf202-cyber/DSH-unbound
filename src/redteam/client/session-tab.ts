/**
 * 会话隧道页（`sessions` 页签）的渲染。
 *
 * 数据与提示判定全在 `session-model.ts`，这里只排版。
 *
 * ## 布局
 *
 * ```
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 会话与入口  WebShell 2/3 在线  隧道 1/2 可用  凭据 4  访问会话 2 │
 * │                                          [检测连通性] [刷新]     │
 * ├────────────────────────────────────────────────────────────────┤
 * │ ⚠ 有 1 个入口不是冰蝎马/哥斯拉马（用户连不上，不算可交付入口）   │
 * │   怎么做（点击展开）▸                                          │
 * ├────────────────────────────────────────────────────────────────┤
 * │ ▾ WebShell 2/3 在线   已上线的可控入口                          │
 * │   ● https://x/shell.jsp  [哥斯拉] [root]   [复制 URL] [标记失效]│
 * ├────────────────────────────────────────────────────────────────┤
 * │ ▾ 内网隧道 1/2 可用   可直接给扫描器当代理用                    │
 * │   ● 127.0.0.1:1080  [suo5] [目标侧通道] [可达 10.0.0.0/8]      │
 * └────────────────────────────────────────────────────────────────┘
 *
 * ## 一个原实现的取舍，这里保留
 *
 * 「建立命令」与「走这条隧道扫描」都**默认折叠**（`<details>` 无 `open`）：
 * 卡片首要信息是「这条通道能不能用、通向哪」，命令按需展开。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { CollapseState } from "./state.js";
import type { MinimalPointerEventLike } from "./h.js";
import { clickable, formatTimestamp } from "./helpers.js";
import {
  COPIED_RESET_MS,
  EMPTY_DETAIL,
  EMPTY_SHELLS_TEXT,
  EMPTY_TITLE,
  EMPTY_TUNNELS_TEXT,
  HINT_SUMMARY,
  NO_ENGAGEMENT_TEXT,
  copyMessage,
  fscanCommand,
  gogoCommand,
  isCopied,
  isEncryptedShell,
  isSuo5,
  lastCheckText,
  legitClass,
  legitFactText,
  legitLabel,
  legitTitle,
  sessionHints,
  shellCopyCommand,
  shellCopyKey,
  shellTypeText,
  statusDotClass,
  tunnelCommandKey,
  tunnelFscanKey,
  tunnelGogoKey,
  tunnelListenKey,
  type SessionData,
  type TunnelItem,
  type WebShellItem,
} from "./session-model.js";

/** 会话页的 props。 */
export interface SessionTabProps {
  readonly engagement: string | null;
  /** 会话数据（`null` = 还没加载）。 */
  readonly data: SessionData | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 是否在检测中。 */
  readonly busy: boolean;
  /** 操作消息。 */
  readonly message: { readonly err?: string; readonly ok?: string } | null;
  /** 当前亮着「已复制」的按钮键。 */
  readonly copied: string | null;
  /** 两个区块的折叠状态。 */
  readonly collapsed: CollapseState;
  readonly onRefresh: () => void;
  readonly onProbe: () => void;
  readonly onToggleSection: (key: string) => void;
  readonly onMarkShell: (shell: WebShellItem, status: "offline") => void;
  readonly onMarkTunnel: (tunnel: TunnelItem, status: "active" | "down") => void;
  /** 复制（失败时要回报真实结果，`copied` 由外层按结果设置）。 */
  readonly onCopy: (key: string, text: string, label: string) => void;
}

/** 两个区块的默认展开态（都默认展开）。 */
const SECTION_DEFAULT_OPEN = true;

/** 取区块展开态。 */
function sectionOpen(collapsed: CollapseState, key: string): boolean {
  const stored = collapsed[key];
  return stored === undefined ? SECTION_DEFAULT_OPEN : stored === true;
}

/** 状态点。 */
function statusDot(runtime: ConsoleRuntime, status: string): ReactNode {
  return runtime.h("span", { className: statusDotClass(status) });
}

/** 卡片里的一行「标签 + 值」。 */
function fact(runtime: ConsoleRuntime, label: string, value: ReactNode): ReactNode {
  return runtime.h("div", { className: "rt-sess-fact" }, runtime.h("b", null, label), runtime.h("span", null, value));
}

/** 统一折叠头（原 `Section` 组件的最小面）。 */
function section(
  runtime: ConsoleRuntime,
  props: SessionTabProps,
  key: string,
  tone: string,
  title: string,
  count: string,
  sub: string,
  children: ReactNode,
): ReactNode {
  const { h } = runtime;
  const open = sectionOpen(props.collapsed, key);
  return h("div", { className: "rt-sec-wrap" },
    h("div", {
      className: "rt-sec t-" + tone,
      ...clickable(() => props.onToggleSection(key), { label: title, expanded: open }),
    },
      h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
      h("span", { className: "rt-sec-title" }, title),
      h("span", { className: "rt-sec-count" }, count),
      h("span", { className: "rt-sec-sub" }, sub),
    ),
    open ? h("div", { className: "rt-sec-body" }, children) : null,
  );
}

/** 提示条（只留一句结论 + 可展开的做法）。 */
function hintNode(runtime: ConsoleRuntime, key: string, title: string, detail: string): ReactNode {
  const { h } = runtime;
  return h("div", { key, className: "rt-hint" },
    h("b", null, title),
    h("details", { className: "rt-sess-fold", style: { marginTop: 3 } },
      h("summary", null, HINT_SUMMARY),
      h("div", { style: { marginTop: 4 } }, detail),
    ),
  );
}

/** WebShell 卡片。 */
function shellCard(runtime: ConsoleRuntime, props: SessionTabProps, shell: WebShellItem): ReactNode {
  const { h } = runtime;
  const key = shellCopyKey(shell);
  return h("div", { key: "w" + shell.id, className: "rt-sess" },
    h("div", { className: "rt-sess-head" },
      statusDot(runtime, shell.status),
      h("span", { className: "rt-sess-title" }, shell.url),
      h("span", { className: "rt-tag rt-tag-active" }, shell.shellType !== "" ? shell.shellType : "webshell"),
      isEncryptedShell(shell.shellType) ? null : h("span", { className: "rt-tag rt-tag-warn" }, "用户连不上"),
      shell.privilege !== "" ? h("span", { className: "rt-tag" }, shell.privilege) : null,
      h("div", { className: "rt-spacer" }),
      isCopied(props.copied, key)
        ? h("span", { className: "rt-tag", style: { color: "#10b981" } }, "已复制")
        : h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onCopy(key, shellCopyCommand(shell), shellCopyCommand(shell)),
          }, "复制 URL"),
      h("button", {
        className: "rt-btn",
        style: { padding: "0 6px", fontSize: 11 },
        onClick: () => props.onMarkShell(shell, "offline"),
      }, "标记失效"),
    ),
    h("div", { className: "rt-sess-facts" },
      fact(runtime, "类型", shellTypeText(shell)),
      shell.passKey !== "" ? fact(runtime, "连接口令", h("span", { className: "rt-mono" }, shell.passKey)) : null,
      shell.assetIp !== "" ? fact(runtime, "所在资产", shell.assetIp) : null,
      shell.privilege !== "" ? fact(runtime, "权限", shell.privilege) : null,
      shell.secretRef !== "" ? fact(runtime, "凭据引用", h("span", { className: "rt-mono" }, shell.secretRef)) : null,
      fact(runtime, "最后检测", lastCheckText(shell.lastCheck, shell.latencyMs, formatTimestamp(shell.lastCheck))),
      shell.checkNote !== "" ? fact(runtime, "检测说明", shell.checkNote) : null,
      shell.note !== "" ? fact(runtime, "备注", shell.note) : null,
    ),
  );
}

/** 一条可复制的代码块（点击复制）。 */
function copyCode(
  runtime: ConsoleRuntime,
  props: SessionTabProps,
  key: string,
  text: string,
  label: string,
  extraStyle?: Readonly<Record<string, string | number>>,
): ReactNode {
  const { h } = runtime;
  return h("div", {
    className: "rt-code",
    title: "点击复制",
    ...(extraStyle !== undefined ? { style: extraStyle } : {}),
    ...clickable(() => props.onCopy(key, text, text), { label }),
  }, isCopied(props.copied, key) ? "已复制" : text);
}

/** 隧道卡片。 */
function tunnelCard(runtime: ConsoleRuntime, props: SessionTabProps, tunnel: TunnelItem): ReactNode {
  const { h } = runtime;
  const listenKey = tunnelListenKey(tunnel);
  return h("div", { key: "t" + tunnel.id, className: "rt-sess" },
    h("div", { className: "rt-sess-head" },
      statusDot(runtime, tunnel.status),
      h("span", { className: "rt-sess-title" }, tunnel.listen !== "" ? tunnel.listen : "(未填监听地址)"),
      h("span", { className: "rt-tag rt-tag-passive" }, tunnel.kind !== "" ? tunnel.kind : "tunnel"),
      isSuo5(tunnel.kind) ? null : h("span", { className: "rt-tag rt-tag-warn" }, "非 suo5 标准通道"),
      // 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算）。
      h("span", { className: legitClass(tunnel), title: legitTitle(tunnel) }, legitLabel(tunnel)),
      tunnel.reach !== "" ? h("span", { className: "rt-tag" }, "可达 " + tunnel.reach) : null,
      h("div", { className: "rt-spacer" }),
      h("button", {
        className: "rt-btn",
        style: { padding: "0 6px", fontSize: 11 },
        onClick: () => props.onCopy(listenKey, tunnel.listen, tunnel.listen),
      }, isCopied(props.copied, listenKey) ? "已复制" : "复制地址"),
      tunnel.status === "active"
        ? h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onMarkTunnel(tunnel, "down"),
          }, "标记失效")
        : h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onMarkTunnel(tunnel, "active"),
          }, "标记可用"),
    ),
    h("div", { className: "rt-sess-facts" },
      fact(runtime, "目标侧入口", tunnel.entry !== "" ? tunnel.entry : "未登记"),
      fact(runtime, "跨越边界", legitFactText(tunnel)),
      tunnel.reach !== "" ? fact(runtime, "可达网段", tunnel.reach) : null,
      tunnel.assetIp !== "" ? fact(runtime, "所在资产", tunnel.assetIp) : null,
      fact(runtime, "最后检测", lastCheckText(tunnel.lastCheck, tunnel.latencyMs, formatTimestamp(tunnel.lastCheck))),
      tunnel.checkNote !== "" ? fact(runtime, "检测说明", tunnel.checkNote) : null,
      tunnel.note !== "" ? fact(runtime, "备注", tunnel.note) : null,
    ),
    // 命令默认折叠：卡片首要信息是「这条通道能不能用、通向哪」。
    tunnel.command !== ""
      ? h("details", { className: "rt-sess-fold" },
          h("summary", null, "建立命令（点击展开 / 复制）"),
          copyCode(runtime, props, tunnelCommandKey(tunnel), tunnel.command, "复制命令"),
        )
      : null,
    tunnel.status === "active" && tunnel.listen !== ""
      ? h("details", { className: "rt-sess-fold" },
          h("summary", null, "走这条隧道扫描（gogo / fscan 命令）"),
          h("div", { className: "rt-sess-cmd" },
            copyCode(runtime, props, tunnelGogoKey(tunnel), gogoCommand(tunnel), "复制 gogo 命令"),
            copyCode(
              runtime,
              props,
              tunnelFscanKey(tunnel),
              fscanCommand(tunnel),
              "复制 fscan 命令",
              { display: "block", marginTop: 3 },
            ),
          ),
        )
      : null,
  );
}

/**
 * 渲染会话隧道页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderSessionTab(runtime: ConsoleRuntime, props: SessionTabProps): ReactNode {
  const { h } = runtime;

  if (props.engagement === null || props.engagement === "") {
    return h("div", { className: "rt-main" },
      h("div", { className: "rt-empty" }, NO_ENGAGEMENT_TEXT),
    );
  }

  const data = props.data;
  const totals = data?.totals ?? { webshells: 0, webshellsOnline: 0, tunnels: 0, tunnelsActive: 0, credentials: 0, access: 0 };
  const shells = data?.shells ?? [];
  const tunnels = data?.tunnels ?? [];
  const hints = data !== null ? sessionHints(data) : [];

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "会话与入口"),
    h("span", { className: "rt-tag" }, "WebShell " + totals.webshellsOnline + "/" + totals.webshells + " 在线"),
    h("span", { className: "rt-tag" }, "隧道 " + totals.tunnelsActive + "/" + totals.tunnels + " 可用"),
    h("span", { className: "rt-tag" }, "凭据 " + totals.credentials),
    h("span", { className: "rt-tag" }, "访问会话 " + totals.access),
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn rt-btn-primary",
      disabled: props.busy,
      onClick: () => props.onProbe(),
    }, props.busy ? "检测中…" : "检测连通性"),
    h("button", { className: "rt-btn", onClick: () => props.onRefresh() }, "刷新"),
  );

  const emptyNode = shells.length === 0 && tunnels.length === 0
    ? h("div", { className: "rt-empty" },
        h("div", null, EMPTY_TITLE),
        h("div", { style: { marginTop: 6, fontSize: 12 } }, EMPTY_DETAIL),
      )
    : null;

  const shellSection = section(
    runtime,
    props,
    "shells",
    "queue",
    "WebShell",
    totals.webshellsOnline + "/" + totals.webshells + " 在线",
    "已上线的可控入口",
    shells.length > 0
      ? h("div", { className: "rt-sess-grid", style: { padding: 0 } }, shells.map((shell) => shellCard(runtime, props, shell)))
      : h("div", { className: "rt-atest-meta" }, EMPTY_SHELLS_TEXT),
  );

  const tunnelSection = section(
    runtime,
    props,
    "tunnels",
    "test",
    "内网隧道",
    totals.tunnelsActive + "/" + totals.tunnels + " 可用",
    "可直接给扫描器当代理用",
    tunnels.length > 0
      ? h("div", { className: "rt-sess-grid", style: { padding: 0 } }, tunnels.map((tunnel) => tunnelCard(runtime, props, tunnel)))
      : h("div", { className: "rt-atest-meta" }, EMPTY_TUNNELS_TEXT),
  );

  const message = props.message;

  return h("div", { className: "rt-main" },
    toolbar,
    message !== null
      ? h("div", { className: message.err !== undefined ? "rt-err" : "rt-foot" }, message.err ?? message.ok ?? "")
      : null,
    props.error !== null ? h("div", { className: "rt-err" }, props.error) : null,
    h("div", { className: "rt-body", style: { overflow: "auto" } },
      emptyNode,
      hints.length > 0
        ? h("div", { style: { padding: "8px 10px 0" } }, hints.map((hint) => hintNode(runtime, hint.key, hint.title, hint.detail)))
        : null,
      shellSection,
      tunnelSection,
    ),
  );
}

/** 默认 props（供测试与未接线场景）。 */
export function defaultSessionProps(engagement: string | null): SessionTabProps {
  return {
    engagement,
    data: null,
    error: null,
    busy: false,
    message: null,
    copied: null,
    collapsed: {},
    onRefresh: () => undefined,
    onProbe: () => undefined,
    onToggleSection: () => undefined,
    onMarkShell: () => undefined,
    onMarkTunnel: () => undefined,
    onCopy: () => undefined,
  };
}

/** 供测试断言：复制成功后按钮亮起的自动消失时长（毫秒）。 */
export const COPY_FEEDBACK_MS = COPIED_RESET_MS;

/** 供测试断言：复制失败提示。 */
export function copyFailureText(label: string): string {
  return copyMessage(false, label);
}

/** 供渲染层之外的调用点复用：从一个按键事件里取按键名。 */
export function keyOf(event: MinimalPointerEventLike): string {
  return event.key ?? "";
}
