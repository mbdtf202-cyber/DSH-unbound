/**
 * WebShell / 隧道 / 会话总览 / 连通性检查 组工具（7 个）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 的 1259–1424 行。
 *
 * ## description 全部来自 `descriptions.ts`
 *
 * 本组 description 是 56 个工具里最长的（`tunnel_add` 497 字），
 * 所以没有手写进 `defineTool`，而是统一从 `descriptions.ts` 引用 ——
 * 那份文件是脚本从原实现 `eval` 原文生成的，测试会比对两者一致。
 *
 * ## `tunnel_add` 的红线说明是本组最重要的语义
 *
 * 原文用 497 字讲清"什么不算隧道"：自己 VPS 上开的 socks5/frp **不算**突破。
 * 这不是啰嗦 —— 报告里把"自己的服务器"算成"内网突破"就是虚报战果。
 * 工具层只做透传，判定在 `store/score.ts` 的 `tunnelIsLegit`。
 */

import type { ToolExecContext } from "../../host-api/types.js";
import { PLANNER_ROLE } from "../store/constants.js";
import { agentOf, resolveEngagement } from "./context.js";
import { defineTool, renderText, toToolJson } from "./define.js";
import type { AnyTypedTool } from "./define.js";
import { TOOL_DESCRIPTIONS } from "./descriptions.js";
import type { StoreForTools } from "./store-contract.js";
import type { ToolRuntimeContext } from "./session-tools.js";
import { AGENT_PARAM } from "./session-tools.js";

/** 构造 WebShell / 隧道组工具。 */
export function tunnelTools(store: StoreForTools, ctx: ToolRuntimeContext): readonly AnyTypedTool[] {
  void ctx;

  /* ── redteam_sessions ───────────────────────────────────────────────── */
  const sessions = defineTool({
    name: "redteam_sessions",
    description: TOOL_DESCRIPTIONS.redteam_sessions,
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const summary = store.sessionSummary(id);
      return toToolJson({
        ok: true,
        engagement: id,
        totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id,
          url: w.url,
          type: w.shell_type,
          pass_key: w.pass_key,
          privilege: w.privilege,
          status: w.status,
          asset_ip: w.asset_ip,
          last_check: w.last_check,
          note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id,
          kind: t.kind,
          listen: t.listen,
          entry: t.entry,
          reach: t.reach,
          entry_kind: t.entry_kind,
          legit: t.legit,
          status: t.status,
          asset_ip: t.asset_ip,
          command: t.command,
          last_check: t.last_check,
          note: t.note,
        })),
        hint:
          "隧道 status=active 时可直接给扫描器用：-socks5 <listen> 或 --proxy socks5://<listen>；webshell status=online 时用对应客户端连接。" +
          " 注意 legit=false（entry_kind=self-only，只在自己的 VPS/自建服务器上）**不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind，用 redteam_tunnel_update 补上目标侧那一端。",
      });
    },
  });

  /* ── redteam_webshell_add ───────────────────────────────────────────── */
  const webshellAdd = defineTool({
    name: "redteam_webshell_add",
    description: TOOL_DESCRIPTIONS.redteam_webshell_add,
    parameters: {
      engagement: { type: "string" },
      agent: AGENT_PARAM,
      url: { type: "string", required: true, description: "WebShell 完整 URL" },
      shell_type: {
        type: "string",
        description: "godzilla（哥斯拉）| behinder（冰蝎）；其它形式才用 antsword/other 并说明原因",
      },
      pass_key: { type: "string", description: "连接密码 / 密钥（冰蝎马写 pass，哥斯拉写 key）" },
      privilege: { type: "string", description: "当前权限，例如 www-data / root / iis" },
      secret_ref: { type: "string", description: "凭据/证据引用，例如 runs/ws-10.0.0.5.txt（不要把明文口令写进库）" },
      asset_id: { type: "number" },
      note: { type: "string" },
      found_by_agent: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addWebshell(id, { ...rest, status: "online", agent: agentOf(args, PLANNER_ROLE) });
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_webshell_list ──────────────────────────────────────────── */
  const webshellList = defineTool({
    name: "redteam_webshell_list",
    description: TOOL_DESCRIPTIONS.redteam_webshell_list,
    parameters: {
      engagement: { type: "string" },
      status: { type: "string", description: "online | offline | unknown" },
      asset_id: { type: "number" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({
        ok: true,
        engagement: id,
        items: store.listWebshells(id, {
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.asset_id === undefined ? {} : { asset_id: args.asset_id }),
        }),
      });
    },
  });

  /* ── redteam_webshell_update ────────────────────────────────────────── */
  const webshellUpdate = defineTool({
    name: "redteam_webshell_update",
    description: TOOL_DESCRIPTIONS.redteam_webshell_update,
    parameters: {
      engagement: { type: "string" },
      id: { type: "number", required: true, description: "WebShell 记录 id" },
      status: { type: "string", description: "online | offline | dead | unknown" },
      privilege: { type: "string" },
      note: { type: "string" },
      check_note: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement);
      /* 原实现把整个 args 当 patch 传（含 id），store 侧会忽略 id；保持一致 */
      const result = store.updateWebshell(eng, args.id, { ...args });
      return toToolJson({ ok: true, engagement: eng, ...result });
    },
  });

  /* ── redteam_tunnel_add ─────────────────────────────────────────────── */
  const tunnelAdd = defineTool({
    name: "redteam_tunnel_add",
    description: TOOL_DESCRIPTIONS.redteam_tunnel_add,
    parameters: {
      engagement: { type: "string" },
      agent: AGENT_PARAM,
      kind: { type: "string", required: true, description: "suo5（首选，走 WebShell/HTTP）| socks5 | ssh-r | frp | chisel | other" },
      listen: { type: "string", required: true, description: "本地监听地址 host:port" },
      entry: { type: "string", description: "入口：WebShell URL / 跳板机 / 命令" },
      reach: { type: "string", description: "可达网段，例如 10.0.0.0/8" },
      entry_kind: {
        type: "string",
        description:
          "【重要】通道的目标侧那一端是什么：target-outbound（目标反弹 shell 到我方/目标上跑 frp 客户端）| target-http（经目标 WebShell 的 suo5/Neo-ReGeorg）| target-agent（经目标已控进程转发）| self-only（只在自己 VPS/自建服务器上，**不算突破**）",
      },
      webshell_id: { type: "number", description: "由哪个 WebShell 建立" },
      asset_id: { type: "number" },
      command: { type: "string", description: "建立命令，便于重建" },
      pid: { type: "string" },
      note: { type: "string" },
      found_by_agent: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addTunnel(id, { ...rest, status: "active", agent: agentOf(args, PLANNER_ROLE) });
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_tunnel_list ────────────────────────────────────────────── */
  const tunnelList = defineTool({
    name: "redteam_tunnel_list",
    description: TOOL_DESCRIPTIONS.redteam_tunnel_list,
    parameters: {
      engagement: { type: "string" },
      status: { type: "string", description: "active | down | unknown" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({
        ok: true,
        engagement: id,
        items: store.listTunnels(id, args.status === undefined ? {} : { status: args.status }),
      });
    },
  });

  /* ── redteam_tunnel_update ──────────────────────────────────────────── */
  const tunnelUpdate = defineTool({
    name: "redteam_tunnel_update",
    description: TOOL_DESCRIPTIONS.redteam_tunnel_update,
    parameters: {
      engagement: { type: "string" },
      id: { type: "number", required: true },
      status: { type: "string", description: "active | down | closed | unknown" },
      listen: { type: "string" },
      reach: { type: "string" },
      entry: { type: "string", description: "入口：WebShell URL / 跳板机 / 命令" },
      entry_kind: {
        type: "string",
        description: "补声明目标侧那一端：target-outbound | target-http | target-agent | self-only（只在自己服务器上，不算突破）",
      },
      note: { type: "string" },
      check_note: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement);
      const result = store.updateTunnel(eng, args.id, { ...args });
      return toToolJson({ ok: true, engagement: eng, ...result });
    },
  });

  /* ── redteam_session_check ──────────────────────────────────────────── */
  const sessionCheck = defineTool({
    name: "redteam_session_check",
    description: TOOL_DESCRIPTIONS.redteam_session_check,
    parameters: {
      engagement: { type: "string" },
      timeoutMs: { type: "number", description: "单次探测超时，默认 6000ms" },
    },
    output: { schema: { type: "string" }, render: renderText },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = await store.probeSessions(id, args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs });
      const online = result.webshells.filter((w) => w.status === "online").length;
      const active = result.tunnels.filter((t) => t.status === "active").length;
      return toToolJson({
        ok: true,
        engagement: id,
        checked_at: result.checkedAt,
        summary: `WebShell 在线 ${String(online)}/${String(result.webshells.length)}，隧道可用 ${String(active)}/${String(result.tunnels.length)}`,
        webshells: result.webshells,
        tunnels: result.tunnels,
      });
    },
  });

  /* ── redteam_attack_path ────────────────────────────────────────────── */
  const attackPath = defineTool({
    name: "redteam_attack_path",
    description: TOOL_DESCRIPTIONS.redteam_attack_path,
    parameters: {
      engagement: { type: "string" },
      cidr: { type: "string" },
      maxNodes: { type: "number", description: "默认 400" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500);
      const attackGraph = store.attackGraph;
      if (attackGraph === undefined) {
        /**
         * `attackGraph` 是窄接口里的**可选**方法（store 侧尚未落地时降级）。
         * 明确报错而不是静默退化成 `graph()` —— 两者语义不同：
         * `graph()` 只有资产拓扑，`attackGraph()` 才含漏洞节点与 `meta.owned`。
         * 拿 `graph()` 冒充会让"攻击路径"缺掉一半信息。
         */
        throw new Error(
          "store 未提供 attackGraph()：无法导出含漏洞节点与已控标记的攻击图谱。" +
            "请先用 redteam_asset_graph 看拓扑，或等 store 侧补齐该能力。",
        );
      }
      const graph = attackGraph(id, args.cidr === undefined ? {} : { cidr: args.cidr });
      if (graph.nodes.length > maxNodes) {
        return toToolJson({
          ok: false,
          error: "图谱节点过多（" + String(graph.nodes.length) + " > " + String(maxNodes) + "），请指定 cidr 缩小范围",
          summary: graph.summary,
        });
      }
      return toToolJson({
        ok: true,
        engagement: id,
        summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta?.owned === true).map((n) => n.label),
        nodes: graph.nodes,
        edges: graph.edges,
      });
    },
  });

  return [
    sessions,
    webshellAdd,
    webshellList,
    webshellUpdate,
    tunnelAdd,
    tunnelList,
    tunnelUpdate,
    sessionCheck,
    attackPath,
  ];
}

/** 本组工具名。 */
export const TUNNEL_TOOL_NAMES = [
  "redteam_sessions",
  "redteam_webshell_add",
  "redteam_webshell_list",
  "redteam_webshell_update",
  "redteam_tunnel_add",
  "redteam_tunnel_list",
  "redteam_tunnel_update",
  "redteam_session_check",
  "redteam_attack_path",
] as const;

export type { ToolExecContext };
