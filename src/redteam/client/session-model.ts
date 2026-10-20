/**
 * 会话隧道页（`sessions` 页签）的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `SessionTab`（242 行）里真正复杂的是**三条提示的判定**与**卡片文案**，
 * 而不是排版：
 *
 * 1. 有 WebShell 不是冰蝎/哥斯拉 → 提示「用户连不上」。判定是**正则**：
 *    `/behinder|godzilla|冰蝎|哥斯拉/i`，覆盖中英文与大小写（用户可能填
 *    `Behinder`、`冰蝎`、`BEHINDER`）。
 * 2. 有隧道但**一条都不算突破** → 提示「现有 N 条通道都不算跨越靶标边界」。
 *    判定是 `legit === true`；`legit === null`（未声明 `entry_kind`）**不算**。
 * 3. 有 WebShell 但没有可用 suo5 → 提示「还没有可用的 suo5 隧道」。
 *    判定是 `kind` 匹配 `/suo5/i` **且** `status === 'active'`。
 *
 * 三条提示是**独立**的（可以同时出现），且顺序固定为 1 → 3 → 2（原实现的
 * push 顺序是 badShells、legitTunnels、activeSuo5，但渲染顺序就是 push 顺序）。
 * 等等 —— 原实现的实际顺序是 h1、h3、h2，这里逐字保留。
 */

import { err, ok, type Result } from "../../shared/result.js";
import type { ApiClient, ApiRequest } from "./api.js";

/* ══════════════════════════════════════════════════════════════ 窄化原语 */

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** 可空数字（延迟毫秒）。 */
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ══════════════════════════════════════════════════════════════ WebShell */

/** 一个 WebShell。 */
export interface WebShellItem {
  readonly id: number;
  readonly url: string;
  readonly shellType: string;
  readonly passKey: string;
  readonly secretRef: string;
  readonly privilege: string;
  readonly status: string;
  readonly lastCheck: string;
  readonly checkNote: string;
  readonly latencyMs: number | null;
  readonly note: string;
  readonly assetIp: string;
}

/** 解析一个 WebShell。 */
export function webShellOf(raw: unknown): WebShellItem {
  const entry = recordOf(raw);
  return {
    id: countOrZero(entry["id"]),
    url: text(entry["url"]),
    shellType: text(entry["shell_type"]) || text(entry["shellType"]),
    passKey: text(entry["pass_key"]) || text(entry["passKey"]),
    secretRef: text(entry["secret_ref"]) || text(entry["secretRef"]),
    privilege: text(entry["privilege"]),
    status: text(entry["status"]),
    lastCheck: text(entry["last_check"]) || text(entry["lastCheck"]),
    checkNote: text(entry["check_note"]) || text(entry["checkNote"]),
    latencyMs: nullableNumber(entry["latency_ms"]) ?? nullableNumber(entry["latencyMs"]),
    note: text(entry["note"]),
    assetIp: text(entry["asset_ip"]) || text(entry["assetIp"]),
  };
}

/**
 * 是否是冰蝎/哥斯拉加密马。
 *
 * **交付红线**：只有加密马用户能用客户端直连；一句话马/自研马在界面上
 * 看着像入口，实际交付不出去。判定用正则覆盖中英文写法。
 */
export function isEncryptedShell(shellType: string): boolean {
  return /behinder|godzilla|冰蝎|哥斯拉/i.test(shellType);
}

/** WebShell 卡片的类型说明。 */
export function shellTypeText(shell: WebShellItem): string {
  return isEncryptedShell(shell.shellType)
    ? "加密马（冰蝎/哥斯拉，用户可直连）"
    : "非加密马 —— 用户连不上，仅可作临时中转";
}

/** 「复制 URL」要复制的命令（`curl -s "URL"`）。 */
export function shellCopyCommand(shell: WebShellItem): string {
  return 'curl -s "' + shell.url + '"';
}

/** 「最后检测」的文本（含延迟）。 */
export function lastCheckText(lastCheck: string, latencyMs: number | null, timeText: string): string {
  const when = lastCheck !== "" ? timeText : "未检测";
  return latencyMs !== null ? when + "（" + latencyMs + "ms）" : when;
}

/* ══════════════════════════════════════════════════════════════ 隧道 */

/** 一条隧道。 */
export interface TunnelItem {
  readonly id: number;
  readonly kind: string;
  readonly listen: string;
  readonly entry: string;
  readonly reach: string;
  readonly entryKind: string;
  readonly entryKindLabel: string;
  readonly status: string;
  readonly lastCheck: string;
  readonly checkNote: string;
  readonly latencyMs: number | null;
  readonly command: string;
  readonly note: string;
  readonly assetIp: string;
  /**
   * 是否算「跨越靶标边界」。
   *
   * - `true`：目标侧发起的通道（目标反弹 shell / 目标跑 frp 客户端 / 经 WebShell 的 suo5）
   * - `false`：只在自己 VPS / 自建服务器上开的代理 —— **不算突破**
   * - `null`：未声明 `entry_kind`，待确认
   */
  readonly legit: boolean | null;
}

/** 解析一条隧道。 */
export function tunnelOf(raw: unknown): TunnelItem {
  const entry = recordOf(raw);
  const legitRaw = entry["legit"];
  return {
    id: countOrZero(entry["id"]),
    kind: text(entry["kind"]),
    listen: text(entry["listen"]),
    entry: text(entry["entry"]),
    reach: text(entry["reach"]),
    entryKind: text(entry["entry_kind"]) || text(entry["entryKind"]),
    entryKindLabel: text(entry["entry_kind_label"]) || text(entry["entryKindLabel"]),
    status: text(entry["status"]),
    lastCheck: text(entry["last_check"]) || text(entry["lastCheck"]),
    checkNote: text(entry["check_note"]) || text(entry["checkNote"]),
    latencyMs: nullableNumber(entry["latency_ms"]) ?? nullableNumber(entry["latencyMs"]),
    command: text(entry["command"]),
    note: text(entry["note"]),
    assetIp: text(entry["asset_ip"]) || text(entry["assetIp"]),
    // 三态：true / false / null（未声明）。**不能**用 `=== true` 压成布尔。
    legit: legitRaw === true ? true : legitRaw === false ? false : null,
  };
}

/** 是否是 suo5 通道（内网突破的标准通道）。 */
export function isSuo5(kind: string): boolean {
  return /suo5/i.test(kind);
}

/** 隧道的代理地址（`socks5://host:port`，无监听地址 → 空串）。 */
export function tunnelProxy(tunnel: TunnelItem): string {
  return tunnel.listen !== "" ? "socks5://" + tunnel.listen : "";
}

/**
 * 走这条隧道跑 gogo 的命令。
 *
 * 原实现逐字：
 * `./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy socks5://listen`
 */
export function gogoCommand(tunnel: TunnelItem): string {
  if (tunnel.listen === "") return "";
  return "./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy " + tunnelProxy(tunnel);
}

/**
 * 走这条隧道跑 fscan 的命令。
 *
 * 原实现逐字：
 * `./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 listen -o intranet.txt`
 */
export function fscanCommand(tunnel: TunnelItem): string {
  if (tunnel.listen === "") return "";
  return "./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 " + tunnel.listen + " -o intranet.txt";
}

/** 隧道「跨越边界」徽章的状态。 */
export type LegitKind = "legit" | "self-only" | "unknown";

/** 归一键。 */
export function legitKindOf(tunnel: TunnelItem): LegitKind {
  if (tunnel.legit === true) return "legit";
  if (tunnel.legit === false) return "self-only";
  return "unknown";
}

/** 徽章文案。 */
export function legitLabel(tunnel: TunnelItem): string {
  switch (legitKindOf(tunnel)) {
    case "legit":
      return "目标侧通道";
    case "self-only":
      return "不算突破";
    case "unknown":
      return "待确认";
  }
}

/** 徽章的 tooltip。 */
export function legitTitle(tunnel: TunnelItem): string {
  switch (legitKindOf(tunnel)) {
    case "legit":
      return tunnel.entryKindLabel;
    case "self-only":
      return "只在自己 VPS/自建服务器上开的通道，没有碰到目标 —— 不算边界突破/内网突破";
    case "unknown":
      return "未声明 entry_kind：请说明目标侧的那一端是什么（target-outbound / target-http / target-agent）";
  }
}

/** 徽章的类名。 */
export function legitClass(tunnel: TunnelItem): string {
  switch (legitKindOf(tunnel)) {
    case "legit":
      return "rt-tag rt-tag-live";
    case "self-only":
      return "rt-tag rt-tag-warn";
    case "unknown":
      return "rt-tag";
  }
}

/** 详情里「跨越边界」行的值（纯文本）。 */
export function legitFactText(tunnel: TunnelItem): string {
  switch (legitKindOf(tunnel)) {
    case "legit":
      return tunnel.entryKindLabel !== "" ? tunnel.entryKindLabel : (tunnel.entryKind !== "" ? tunnel.entryKind : "已确认目标侧");
    case "self-only":
      return "不算突破（只在自己 VPS 上开代理）";
    case "unknown":
      return "未声明 entry_kind，待确认";
  }
}

/* ══════════════════════════════════════════════════════════════ 汇总 */

/** 一屏计数。 */
export interface SessionTotals {
  readonly webshells: number;
  readonly webshellsOnline: number;
  readonly tunnels: number;
  readonly tunnelsActive: number;
  readonly credentials: number;
  readonly access: number;
}

/** 空计数。 */
export const EMPTY_TOTALS: SessionTotals = Object.freeze({
  webshells: 0,
  webshellsOnline: 0,
  tunnels: 0,
  tunnelsActive: 0,
  credentials: 0,
  access: 0,
});

/** 会话页数据。 */
export interface SessionData {
  readonly shells: readonly WebShellItem[];
  readonly tunnels: readonly TunnelItem[];
  readonly totals: SessionTotals;
}

/** 解析 `op: sessions` 的响应。 */
export function sessionDataOf(response: unknown): SessionData {
  const body = recordOf(response);
  const totals = recordOf(body["totals"]);
  return {
    shells: arrayOf(body["webshells"]).map(webShellOf),
    tunnels: arrayOf(body["tunnels"]).map(tunnelOf),
    totals: {
      webshells: countOrZero(totals["webshells"]),
      webshellsOnline: countOrZero(totals["webshellsOnline"]) || countOrZero(totals["webshells_online"]),
      tunnels: countOrZero(totals["tunnels"]),
      tunnelsActive: countOrZero(totals["tunnelsActive"]) || countOrZero(totals["tunnels_active"]),
      credentials: countOrZero(totals["credentials"]),
      access: countOrZero(totals["access"]),
    },
  };
}

/** 状态点类名。
 *
 * 原实现：`s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off')`
 * —— `null`/`undefined`/空串都算「未知」，不是「离线」。
 */
export function statusDotClass(status: string): string {
  if (status === "online" || status === "active") return "rt-dot-on";
  if (status === "unknown" || status === "") return "rt-dot-unk";
  return "rt-dot-off";
}

/* ══════════════════════════════════════════════════════════════ 提示 */

/** 一条提示。 */
export interface SessionHint {
  /** 稳定 key（`h1` / `h2` / `h3`）。 */
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

/** 折叠条的展开文案。 */
export const HINT_SUMMARY = "怎么做（点击展开）";

/** 判定要显示的提示（顺序与原实现一致：坏马 → 无 suo5 → 全不算突破）。 */
export function sessionHints(data: SessionData): readonly SessionHint[] {
  const hints: SessionHint[] = [];

  const badShells = data.shells.filter((shell) => !isEncryptedShell(shell.shellType));
  if (badShells.length > 0) {
    hints.push({
      key: "h1",
      title: "有 " + badShells.length + " 个入口不是冰蝎马/哥斯拉马（用户连不上，不算可交付入口）",
      detail: "用技能 webshell-toolkit 重新上传冰蝎马（behinder）或哥斯拉马（godzilla），"
        + "并把 shell_type + pass_key 写进 redteam_webshell_add。只作临时中转的可在备注里写明。",
    });
  }

  const legitTunnels = data.tunnels.filter((tunnel) => tunnel.legit === true);
  if (data.tunnels.length > 0 && legitTunnels.length === 0) {
    hints.push({
      key: "h3",
      title: "现有 " + data.tunnels.length + ' 条通道都不算"跨越靶标边界"（不算边界/内网突破）',
      detail: "自己的 VPS / 自建服务器上开的 socks5、frp、代理不算隧道。必须是目标侧发起的通道："
        + "目标反弹 shell 到我方、目标上跑 frp/Stowaway 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道；"
        + "登记时用 entry_kind 说明。",
    });
  }

  const activeSuo5 = data.tunnels.filter((tunnel) => isSuo5(tunnel.kind) && tunnel.status === "active");
  if (data.shells.length > 0 && activeSuo5.length === 0) {
    hints.push({
      key: "h2",
      title: "还没有可用的 suo5 隧道（打进内网的标准通道）",
      detail: "用技能 suo5-tunnel 通过上面的 WebShell 建 socks5 隧道，再 redteam_tunnel_add"
        + "（kind=suo5、listen=127.0.0.1:1080、entry=WebShell URL、reach=可达网段）登记，"
        + "最后点「检测连通性」确认 status=active。",
    });
  }

  return hints;
}

/* ══════════════════════════════════════════════════════════════ 检测 */

/** 检测结果摘要。 */
export interface ProbeSummary {
  readonly onlineShells: number;
  readonly totalShells: number;
  readonly activeTunnels: number;
  readonly totalTunnels: number;
  readonly message: string;
}

/** 从 `op: probeSessions` 的响应算摘要。 */
export function probeSummaryOf(response: unknown): ProbeSummary {
  const body = recordOf(response);
  const shells = arrayOf(body["webshells"]);
  const tunnels = arrayOf(body["tunnels"]);
  const onlineShells = shells.filter((raw) => text(recordOf(raw)["status"]) === "online").length;
  const activeTunnels = tunnels.filter((raw) => text(recordOf(raw)["status"]) === "active").length;
  return {
    onlineShells,
    totalShells: shells.length,
    activeTunnels,
    totalTunnels: tunnels.length,
    message: "检测完成：WebShell 在线 " + onlineShells + "/" + shells.length
      + "，隧道可用 " + activeTunnels + "/" + tunnels.length,
  };
}

/** 检测请求的超时（毫秒，原实现写死 6000）。 */
export const PROBE_TIMEOUT_MS = 6000;

/* ══════════════════════════════════════════════════════════════ 请求 */

/** 请求 `op: sessions`。 */
export function sessionsRequest(engagement: string): ApiRequest {
  return { op: "sessions", engagement };
}

/** 请求 `op: probeSessions`。 */
export function probeRequest(engagement: string): ApiRequest {
  return { op: "probeSessions", engagement, timeoutMs: PROBE_TIMEOUT_MS };
}

/** 标记隧道的请求。 */
export function updateTunnelRequest(engagement: string, id: number, status: string): ApiRequest {
  return {
    op: "updateTunnel",
    engagement,
    id,
    patch: { status, check_note: "界面手动标记" },
  };
}

/** 标记 WebShell 的请求。 */
export function updateWebshellRequest(engagement: string, id: number, status: string): ApiRequest {
  return {
    op: "updateWebshell",
    engagement,
    id,
    patch: { status, check_note: "界面手动标记" },
  };
}

/** 从响应里取错误文案。 */
function errorOf(response: unknown, fallback: string): string | null {
  if (response === null || response === undefined) return fallback;
  const body = recordOf(response);
  if (body["ok"] !== false) return null;
  const message = body["error"];
  return typeof message === "string" && message !== "" ? message : fallback;
}

/** 加载会话数据。 */
export async function loadSessions(api: ApiClient, engagement: string): Promise<Result<SessionData, string>> {
  const response = await api.raw(sessionsRequest(engagement));
  const error = errorOf(response, "读取失败");
  if (error !== null) return err(error);
  return ok(sessionDataOf(response));
}

/** 实测连通性。 */
export async function probeSessions(
  api: ApiClient,
  engagement: string,
): Promise<Result<ProbeSummary, string>> {
  const response = await api.raw(probeRequest(engagement));
  const error = errorOf(response, "检测失败");
  if (error !== null) return err(error);
  return ok(probeSummaryOf(response));
}

/** 标记隧道状态（`active` / `down`）。 */
export async function markTunnel(
  api: ApiClient,
  engagement: string,
  id: number,
  status: "active" | "down",
): Promise<Result<null, string>> {
  const response = await api.raw(updateTunnelRequest(engagement, id, status));
  const error = errorOf(response, "标记失败");
  return error !== null ? err(error) : ok(null);
}

/** 标记 WebShell 状态（`offline` / `online`）。 */
export async function markShell(
  api: ApiClient,
  engagement: string,
  id: number,
  status: "offline" | "online",
): Promise<Result<null, string>> {
  const response = await api.raw(updateWebshellRequest(engagement, id, status));
  const error = errorOf(response, "标记失败");
  return error !== null ? err(error) : ok(null);
}

/* ══════════════════════════════════════════════════════════════ 复制 */

/**
 * 复制反馈的文案。
 *
 * 原实现：成功 `'已复制：' + label`，失败
 * `'复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制'`。
 * **不能**把失败也说成成功 —— 那正是原实现记录过的 bug。
 */
export function copyMessage(ok: boolean, label: string): string {
  return ok ? "已复制：" + label : "复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制";
}

/* ══════════════════════════════════════════════════════════════ 空态 */

/** 未选靶标。 */
export const NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看会话与入口。";

/** 两条都没有时的空态标题。 */
export const EMPTY_TITLE = "还没有登记任何 WebShell 或隧道。";

/** 两条都没有时的空态说明。 */
export const EMPTY_DETAIL =
  "拿到 WebShell 用 redteam_webshell_add；建好隧道用 redteam_tunnel_add（suo5 / socks5 / ssh -R）；"
  + "之后智能体用 redteam_sessions 就能看到。";

/** WebShell 区块的空态。 */
export const EMPTY_SHELLS_TEXT = "暂无（拿到 WebShell 后用 redteam_webshell_add 登记）";

/** 隧道区块的空态。 */
export const EMPTY_TUNNELS_TEXT = "暂无（建好隧道后用 redteam_tunnel_add 登记）";

/* ══════════════════════════════════════════════════════════════ 复制按钮 */

/**
 * 复制按钮的状态：`已复制` 还是按钮。
 *
 * 原实现用一个 `copied` 状态存**当前亮起的那一个按钮的键**，1.5 秒后清掉。
 * 这里把「该不该亮」抽成纯函数，1.5 秒的定时器由组件层管。
 */
export function isCopied(copiedKey: string | null, key: string): boolean {
  return copiedKey === key;
}

/** 「已复制」提示的自动消失时长（毫秒）。 */
export const COPIED_RESET_MS = 1500;

/** 各复制按钮的键（集中一处，避免组件层拼错）。 */
export function shellCopyKey(shell: WebShellItem): string {
  return "cmd" + shell.id;
}

export function tunnelListenKey(tunnel: TunnelItem): string {
  return "sock" + tunnel.id;
}

export function tunnelCommandKey(tunnel: TunnelItem): string {
  return "c" + tunnel.id;
}

export function tunnelGogoKey(tunnel: TunnelItem): string {
  return "g" + tunnel.id;
}

export function tunnelFscanKey(tunnel: TunnelItem): string {
  return "f" + tunnel.id;
}
