/**
 * 漏洞 / 凭据 / 访问 / 截图 组工具（10 个）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 的 1036–1257 行。
 *
 * ## `description` 逐字照搬
 *
 * 尤其 `redteam_credential_add`：它明确要求"**必须把口令/密钥明文写进 secret_value**"，
 * 并解释了为什么（面板要直接显示明文供复用）。这类句子改了会改变模型行为。
 *
 * ## 与 store 的边界
 *
 * 本组全部是"参数整形 + 调 store + 拼返回"，**不在此层做任何计分/去重/封顶**。
 * 那些逻辑在 `store/score.ts`，工具层不复制。
 */

import type { ToolExecContext } from "../../host-api/types.js";
import { PLANNER_ROLE } from "../store/constants.js";
import { agentOf, resolveEngagement } from "./context.js";
import { TOOL_DESCRIPTIONS } from "./descriptions.js";
import { defineTool, renderText, toToolJson } from "./define.js";
import type { AnyTypedTool } from "./define.js";
import type { StoreForTools } from "./store-contract.js";
import type { ToolRuntimeContext } from "./session-tools.js";
import { AGENT_PARAM } from "./session-tools.js";

/** 严重级（与 store 的 `Severity` 一致）。 */
export const SEVERITY_ENUM = ["critical", "high", "medium", "low", "info"] as const;

/** 漏洞状态（与 store 的 `VulnStatus` 一致）。 */
export const VULN_STATUS_ENUM = ["candidate", "confirmed", "false-positive", "exploited", "fixed"] as const;

/** 构造漏洞 / 凭据 / 访问 / 截图组工具。 */
export function findingTools(store: StoreForTools, ctx: ToolRuntimeContext): readonly AnyTypedTool[] {
  void ctx;

  /* ── redteam_vuln_add ───────────────────────────────────────────────── */
  const vulnAdd = defineTool({
    name: "redteam_vuln_add",
    description:
      TOOL_DESCRIPTIONS.redteam_vuln_add,
    parameters: {
      engagement: { type: "string" },
      agent: AGENT_PARAM,
      asset_id: { type: "number", description: "资产 id（来自 redteam_asset_query）" },
      cve: { type: "string", description: "CVE / CNVD 编号（无编号可省略）" },
      title: { type: "string", required: true, description: "漏洞标题" },
      severity: { type: "string", required: true, enum: SEVERITY_ENUM },
      status: { type: "string", enum: VULN_STATUS_ENUM },
      target: { type: "string", description: "受影响的目标，如 https://host:443/path 或 ip:port" },
      source: { type: "string", description: "发现方式：nuclei / sqlmap / curl / manual …" },
      confidence: { type: "number", description: "0–1" },
      evidence: { type: "string", description: "证据：请求/响应摘要、命令、证据文件路径" },
      found_by_agent: { type: "string", description: "发现角色，默认 vuln-scan" },
      gained: {
        type: "string",
        description:
          "【重要】通过这个漏洞拿到了什么权限/成果，写得分口径的短标签，多项用顿号或逗号分隔，例如「服务器权限、内网隧道」「后台管理员账号」「数据库权限」",
      },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addVuln(id, {
        ...rest,
        agent: agentOf(args, PLANNER_ROLE),
        found_by_agent: args.found_by_agent ?? args.agent ?? "vuln-scan",
      });
      return toToolJson({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) });
    },
  });

  /* ── redteam_vuln_query ─────────────────────────────────────────────── */
  const vulnQuery = defineTool({
    name: "redteam_vuln_query",
    description: TOOL_DESCRIPTIONS.redteam_vuln_query,
    parameters: {
      engagement: { type: "string" },
      severity: { type: "string", enum: SEVERITY_ENUM },
      status: { type: "string", enum: VULN_STATUS_ENUM },
      cve: { type: "string" },
      asset_id: { type: "number" },
      cidr: { type: "string" },
      q: { type: "string", description: "标题/CVE/目标/证据关键词" },
      limit: { type: "number", description: "默认 50，最大 200" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, limit, ...filter } = args;
      void _ignored;
      const result = store.listVulns(id, {
        ...filter,
        limit: Math.min(Number(limit) || 50, 200),
      });
      return toToolJson({
        ok: true,
        engagement: id,
        total: result.total,
        items: result.items,
        stats: store.vulnStats(id),
      });
    },
  });

  /* ── redteam_vuln_update ────────────────────────────────────────────── */
  const vulnUpdate = defineTool({
    name: "redteam_vuln_update",
    description:
      TOOL_DESCRIPTIONS.redteam_vuln_update,
    parameters: {
      engagement: { type: "string" },
      id: { type: "number", required: true, description: "漏洞 id" },
      status: { type: "string", enum: VULN_STATUS_ENUM },
      severity: { type: "string", enum: SEVERITY_ENUM },
      evidence: { type: "string" },
      confidence: { type: "number" },
      gained: { type: "string", description: "通过这个漏洞拿到了什么权限/成果（得分口径短标签，多项用顿号分隔）" },
      title: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.updateVuln(id, args.id, {
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.severity === undefined ? {} : { severity: args.severity }),
        ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
        ...(args.gained === undefined ? {} : { gained: args.gained }),
        ...(args.title === undefined ? {} : { title: args.title }),
      });
      return toToolJson({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) });
    },
  });

  /* ── redteam_credential_add ─────────────────────────────────────────── */
  const credentialAdd = defineTool({
    name: "redteam_credential_add",
    description:
      TOOL_DESCRIPTIONS.redteam_credential_add,
    parameters: {
      engagement: { type: "string" },
      agent: AGENT_PARAM,
      host: { type: "string", required: true, description: "所属主机（IP 或域名）" },
      username: { type: "string" },
      secret_type: { type: "string", description: "password | hash | key | token | connection-string，默认 password" },
      secret_value: { type: "string", description: "【必填】凭据明文：口令 / Hash / 私钥 / Token / 连接串" },
      secret_ref: { type: "string", description: "证据引用路径，例如 runs/cred-vnc-10.0.0.5.txt" },
      privilege: { type: "string", description: "该凭据的权限级别，如 admin / user / db-read" },
      asset_id: { type: "number" },
      source: { type: "string", description: "来源：exploit / dump / config-leak …" },
      tool: { type: "string" },
      note: { type: "string" },
      found_by_agent: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addCredential(id, { ...rest, agent: agentOf(args, PLANNER_ROLE) });
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_credential_list ────────────────────────────────────────── */
  const credentialList = defineTool({
    name: "redteam_credential_list",
    description: TOOL_DESCRIPTIONS.redteam_credential_list,
    parameters: {
      engagement: { type: "string" },
      host: { type: "string" },
      username: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({
        ok: true,
        engagement: id,
        items: store.listCredentials(id, {
          ...(args.host === undefined ? {} : { host: args.host }),
          ...(args.username === undefined ? {} : { username: args.username }),
        }),
      });
    },
  });

  /* ── redteam_access_add ─────────────────────────────────────────────── */
  const accessAdd = defineTool({
    name: "redteam_access_add",
    description:
      TOOL_DESCRIPTIONS.redteam_access_add,
    parameters: {
      engagement: { type: "string" },
      host: { type: "string", required: true },
      username: { type: "string" },
      method: { type: "string", required: true, description: "获得访问的方式" },
      privilege: { type: "string" },
      asset_id: { type: "number" },
      session_ref: { type: "string", description: "会话/证据引用，例如 runs/session-vnc-10.0.0.5.md" },
      note: { type: "string" },
      found_by_agent: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addAccess(id, rest);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_access_list ────────────────────────────────────────────── */
  const accessList = defineTool({
    name: "redteam_access_list",
    description: TOOL_DESCRIPTIONS.redteam_access_list,
    parameters: {
      engagement: { type: "string" },
      host: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({
        ok: true,
        engagement: id,
        items: store.listAccess(id, args.host === undefined ? {} : { host: args.host }),
      });
    },
  });

  /* ── redteam_shot_add ───────────────────────────────────────────────── */
  const shotAdd = defineTool({
    name: "redteam_shot_add",
    description:
      TOOL_DESCRIPTIONS.redteam_shot_add,
    parameters: {
      engagement: { type: "string" },
      agent: AGENT_PARAM,
      path: { type: "string", description: "图片在本机的路径（相对靶标目录或绝对路径）；与 data_base64 二选一" },
      data_base64: { type: "string", description: "图片内容（base64，可带 data: 前缀）；截图工具没落盘时用这个" },
      label: { type: "string", description: "图片说明，例如「域控 WEB-SHDC1 atexec 回显 nt authority\\system」" },
      kind: { type: "string", description: "screenshot（现场截图，默认）| card（由记录生成的证据摘录卡，报告里会标注）" },
      point_code: { type: "string", description: "关联的得分点 code，如 terminal-access / central-system" },
      hit_id: { type: "number", description: "关联到具体某条得分命中（score_hit id）；给了它这张图就只挂在那一条上" },
      asset_id: { type: "number" },
      target: { type: "string", description: "这张图对应的目标（IP / URL）" },
      note: { type: "string", description: "补充说明：这张图证明了什么" },
      source_ref: { type: "string", description: "原始来源：截图的落盘路径或 runs/ 下的证据文件" },
      captured_at: { type: "string", description: "截图时间（ISO），缺省用当前时间" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addShot(id, { ...rest, agent: agentOf(args, PLANNER_ROLE) });
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_shot_list ──────────────────────────────────────────────── */
  const shotList = defineTool({
    name: "redteam_shot_list",
    description: TOOL_DESCRIPTIONS.redteam_shot_list,
    parameters: {
      engagement: { type: "string" },
      point_code: { type: "string" },
      hit_id: { type: "number" },
      asset_id: { type: "number" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({
        ok: true,
        engagement: id,
        ...store.listShots(id, {
          ...(args.point_code === undefined ? {} : { point_code: args.point_code }),
          ...(args.hit_id === undefined ? {} : { hit_id: args.hit_id }),
          ...(args.asset_id === undefined ? {} : { asset_id: args.asset_id }),
        }),
      });
    },
  });

  /* ── redteam_shot_delete ────────────────────────────────────────────── */
  const shotDelete = defineTool({
    name: "redteam_shot_delete",
    description: TOOL_DESCRIPTIONS.redteam_shot_delete,
    parameters: {
      engagement: { type: "string" },
      id: { type: "number", required: true, description: "shot id（redteam_shot_list 里返回的 id）" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement);
      return toToolJson({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) });
    },
  });

  return [
    vulnAdd,
    vulnQuery,
    vulnUpdate,
    credentialAdd,
    credentialList,
    accessAdd,
    accessList,
    shotAdd,
    shotList,
    shotDelete,
  ];
}

/** 本组工具名。 */
export const FINDING_TOOL_NAMES = [
  "redteam_vuln_add",
  "redteam_vuln_query",
  "redteam_vuln_update",
  "redteam_credential_add",
  "redteam_credential_list",
  "redteam_access_add",
  "redteam_access_list",
  "redteam_shot_add",
  "redteam_shot_list",
  "redteam_shot_delete",
] as const;

export type { ToolExecContext };
