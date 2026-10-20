/**
 * 得分 / 攻击链 / 证据 / 报告 组工具（12 个）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 的 1491–1805 行。
 *
 * ## 本组最重要的一条：**不复制计分逻辑**
 *
 * 封顶、去重、多档取值、服务口径 —— 全部在 `store/score.ts`
 * （`applyScoreCaps` / `scoreServiceKey` / `targetKey` / `systemKeyOf`）。
 * 工具层只做参数整形 + 调 store + 拼返回。
 *
 * 为什么强调：计分口径散成两份，A 处改了 B 处不知道，
 * 结果就是"面板显示 50 分、报告算 10 分"，而这种偏差没人会当成 bug 报上来。
 *
 * ## `score_hit` 的 description 有 1124 字
 *
 * 含三条红线（账号必须实测可登录 / 自己注册的账号不算 / 注意计分口径）。
 * 逐字来自 `descriptions.ts`，测试会比对。
 */

import type { ToolExecContext } from "../../host-api/types.js";
import { agentOf, resolveEngagement } from "./context.js";
import { defineTool, renderText, toToolJson } from "./define.js";
import type { AnyTypedTool } from "./define.js";
import { TOOL_DESCRIPTIONS } from "./descriptions.js";
import type { StoreForTools } from "./store-contract.js";
import type { ToolRuntimeContext } from "./session-tools.js";
import { AGENT_PARAM } from "./session-tools.js";
import { PLANNER_ROLE } from "../store/constants.js";

/** 攻击链动作类型（与 store 的 `AttackStepRow.stage` 对齐）。 */
export const CHAIN_STAGE_ENUM = ["recon", "vuln", "exploit", "access", "pivot", "data", "other"] as const;

/** 作战阶段（与 `store/data/stages.ts` 的 `VALID_STAGE_CODES` 对齐）。 */
export const STAGE_CODE_ENUM = ["recon", "internet", "boundary", "internal", "target"] as const;

/** 构造得分 / 证据 / 报告组工具。 */
export function scoreTools(store: StoreForTools, ctx: ToolRuntimeContext): readonly AnyTypedTool[] {
  void ctx;

  /* ── redteam_score_list ─────────────────────────────────────────────── */
  const scoreList = defineTool({
    name: "redteam_score_list",
    description: TOOL_DESCRIPTIONS.redteam_score_list,
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.listScorePoints(id, {});
      /* 按合并版的 8 个类别分组返回：智能体一眼看到"哪些类别还没打、每项上限用了多少" */
      const groups = (result.ruleGroups ?? []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }));
      return toToolJson({
        ok: true,
        engagement: id,
        summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          category: p.category,
          points: p.points,
          /* 合并版的档位说明（一条含多档时，记分要用 points 参数指定本档分值） */
          tier: p.tier,
          cap: p.cap,
          cap_used: p.cap_used,
          dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled,
          achieved: p.hits.length > 0,
          hits: p.hits.length,
          counted: p.counted,
          earned: p.earned,
          /* 该条因计分口径 / 已达上限而不计分的条数（把它当停止信号，别在同一条上刷） */
          capped: p.capped,
          /* 两个字段各司其职：service_summary 是"这条为什么有命中不计分"的整段说明；
             capped_reason 留给**逐条命中**的具体原因（在 hits[] 里），不要拿摘要冒充它。 */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + "：" : "") + h.evidence).slice(0, 3),
        })),
      });
    },
  });

  /* ── redteam_score_hit ──────────────────────────────────────────────── */
  const scoreHit = defineTool({
    name: "redteam_score_hit",
    description: TOOL_DESCRIPTIONS.redteam_score_hit,
    parameters: {
      engagement: { type: "string" },
      code: { type: "string", description: "得分点 code（或 point_id / point_name 任选其一）；先用 redteam_score_list 核对实际 code" },
      point_id: { type: "number" },
      point_name: { type: "string" },
      points: {
        type: "number",
        description:
          "【多档条目必填】本次命中按哪一档计分（如服务器主机权限：普通权限填 10、管理员填 50；域名控制：一级 50、二级 20）。不填则用该条主档默认值。",
      },
      target: { type: "string", description: "目标资产：URL / ip:port / 主机名（**带上端口**，服务/系统口径按它判定）" },
      asset_id: { type: "number", description: "目标资产在库里的 id" },
      port: { type: "number", description: "【建议填】这条得分落在哪个端口（口径判定按「资产 + 端口」；target 里已带端口时可不填）" },
      vuln_id: { type: "number", description: "【建议填】用哪个漏洞拿到的分（报告据此附原始请求）" },
      step_id: { type: "number", description: "对应的攻击链步骤 id（可选）" },
      evidence: {
        type: "string",
        required: true,
        description:
          "【必填】结果：拿到的东西，例如「后台管理员 tomcat/Tomcat@2024（已实测浏览器可登录）」「数据库账号 root/xxx」「导出 132 万条用户数据」。多档条目请写明档位（如\"管理员权限\"）。",
      },
      self_created: {
        type: "boolean",
        description:
          "【重要】这个账号/权限是不是**自己注册、自己创建**的？是则填 true —— 只作过程记录，不计分、不进报告。拿到别人已有的账号/权限不要填（默认 false）。",
      },
      note: { type: "string" },
      recorded_by: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addScoreHit(id, rest);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_score_point_save ───────────────────────────────────────── */
  const scorePointSave = defineTool({
    name: "redteam_score_point_save",
    description: TOOL_DESCRIPTIONS.redteam_score_point_save,
    parameters: {
      engagement: { type: "string" },
      id: { type: "number", description: "已有得分点 id（修改时传）" },
      name: { type: "string", required: true },
      code: { type: "string", description: "短代码（新增时建议给，便于记录得分）" },
      category: { type: "string", description: "分类，如 账号权限 / 服务器权限 / 数据库 / 网络突破 / 数据 / 核心目标" },
      points: { type: "number", description: "分值" },
      description: { type: "string", description: "得分条件说明" },
      enabled: { type: "boolean" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.saveScorePoint(id, rest);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_score_report ───────────────────────────────────────────── */
  const scoreReport = defineTool({
    name: "redteam_score_report",
    description: TOOL_DESCRIPTIONS.redteam_score_report,
    parameters: {
      engagement: { type: "string" },
      limit: { type: "number", description: "最多多少项，默认 500" },
      markdown: { type: "boolean", description: "true=返回 markdown 全文（默认 true）；false=只返回条目摘要" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const r = store.scoreReport(id, args.limit === undefined ? {} : { limit: args.limit });
      if (args.markdown === false) {
        return toToolJson({
          ok: true,
          engagement: id,
          summary: r.summary,
          items: r.items.map((x) => ({
            seq: x.seq,
            point: x.point_name,
            points: x.points,
            counted: x.counted,
            target: x.target,
            gained: x.gained,
            requests: x.requests.length,
            missing_evidence: x.missing_evidence,
          })),
        });
      }
      return toToolJson({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown });
    },
  });

  /* ── redteam_attack_chain ───────────────────────────────────────────── */
  const attackChain = defineTool({
    name: "redteam_attack_chain",
    description: TOOL_DESCRIPTIONS.redteam_attack_chain,
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const chain = store.scoreChain(id);
      return toToolJson({
        ok: true,
        engagement: id,
        totals: {
          points: chain.summary.points,
          totalPoints: chain.summary.totalPoints,
          hits: chain.summary.hits,
          /* 按服务封顶（同资产同端口只算一次）而没计分的条数：账号类/数据库权限 */
          serviceCappedHits: chain.summary.serviceCappedHits ?? 0,
        },
        stages: chain.stages.map((st) => ({
          code: st.code,
          name: st.name,
          goal: st.goal,
          points: st.points,
          cumulative: st.cumulative,
          counted: st.counted,
          hits: st.hits,
          steps: st.steps,
          tools: st.tools,
          methods: (st.sections ?? []).map((x) => x.label + "：" + (x.items ?? []).join("、")),
          scored: st.items.map((x) => ({
            point: x.point_name,
            points: x.points,
            counted: x.counted,
            target: x.target,
            service: x.service ?? null,
            capped: x.capped === true,
            capped_reason: x.capped_reason ?? null,
          })),
          assets: (st.assets ?? []).map((a) => a.ip + (a.scope === "internal" ? "(内网)" : "(外网)") + " 贡献" + String(a.points) + "分"),
          tunnels: (st.tunnels ?? []).map((t) => t.kind + " " + t.listen + " [" + t.status + "] 可达 " + (t.reach ?? "—")),
        })),
        hint:
          "得分阶段是自动推导的（core-system→靶标、boundary→边界突破，其余按资产内外网归属）；写攻击链步骤时带 stage_code（只接受 recon/internet/boundary/internal/target）步骤计数才会落到正确阶段，写别的值会被忽略。账号权限与数据库权限按「同资产同端口」封顶：一个服务拿到最高权限即拿满，同服务重复命中标 capped=true 且不计分。",
      });
    },
  });

  /* ── redteam_http_evidence_add ──────────────────────────────────────── */
  const httpEvidenceAdd = defineTool({
    name: "redteam_http_evidence_add",
    description: TOOL_DESCRIPTIONS.redteam_http_evidence_add,
    parameters: {
      engagement: { type: "string" },
      vuln_id: { type: "number", description: "关联的漏洞 id（建议填）" },
      asset_id: { type: "number" },
      label: { type: "string", description: "这条证据的用途，例如「越权读取用户列表」" },
      method: { type: "string", description: "GET/POST/…" },
      url: { type: "string" },
      status: { type: "number", description: "响应状态码" },
      request: { type: "string", required: true, description: "原始请求全文（Burp 可直接粘贴）" },
      response: { type: "string", description: "响应全文或关键片段" },
      note: { type: "string" },
      captured_by: { type: "string", description: "采集角色" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addHttpEvidence(id, rest);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_chain_add ──────────────────────────────────────────────── */
  const chainAdd = defineTool({
    name: "redteam_chain_add",
    description: TOOL_DESCRIPTIONS.redteam_chain_add,
    parameters: {
      engagement: { type: "string" },
      agent: AGENT_PARAM,
      stage: {
        type: "string",
        required: true,
        enum: CHAIN_STAGE_ENUM,
        description:
          "动作类型（兼容字段）：recon 信息收集 | vuln 漏洞发现 | exploit 利用 | access 获得权限 | pivot 内网突破 | data 敏感数据 | other。**阶段归属用 stage_code**，这个字段只用于老数据兜底。",
      },
      title: {
        type: "string",
        required: true,
        description: "一句话描述这一步做了什么，例如「通过后台模板上传点上传冰蝎马」「用 suo5 建 socks5 隧道」",
      },
      detail: {
        type: "string",
        description: "为什么这么做、线索从哪来，例如「登录页泄露版本 Coremail XT 5.0 → 匹配 CVE-2023-xxxx → 后台模板管理可上传」",
      },
      tool: {
        type: "string",
        description:
          "【报告复现的关键】**实际执行的命令原文**，例如 `nuclei -t CVE-2021-xxxx.yaml -u http://x`、`suo5-linux-amd64 -t http://x/shell.jsp -l 1080`、`sqlmap -u \"http://x?id=1\" --dump`。不写这条，报告里这一步就没法复现。",
      },
      result: {
        type: "string",
        description:
          "【报告复现的关键】实际结果/回显摘要，例如 `uid=0(root) gid=0(root)`、「返回 200，含 1.2 万条用户数据」、「后台管理员 tomcat 登录成功」",
      },
      asset_id: { type: "number" },
      vuln_id: { type: "number" },
      access_id: { type: "number" },
      evidence_ref: { type: "string", description: "证据文件/会话引用，例如 runs/session-vnc.md" },
      recorded_by: { type: "string" },
      point_code: {
        type: "string",
        description:
          "【这一步拿了分就填】得分点 code（如 rce / webshell / boundary），服务端会自动记一次分并把步骤与得分互相挂上。**必须同时给 evidence，否则不会记分**（步骤照常入库）。",
      },
      stage_code: {
        type: "string",
        enum: STAGE_CODE_ENUM,
        description:
          "所属作战阶段（只有这 5 个合法值）：recon(信息收集) | internet(互联网资产权限) | boundary(边界突破·搭隧道) | internal(内网资产权限) | target(靶标系统权限)。写别的值（如外部工具常见的 external/foothold/tunnel/privilege）会被忽略并退回按 stage 兜底，步骤就不落在任何阶段。",
      },
      evidence: {
        type: "string",
        description: "配合 point_code 使用：这一分拿到了什么（目标资产 + 账号/权限/数据量）——**不填就不记分**。",
      },
      self_created: { type: "boolean", description: "配合 point_code 使用：这一步拿到的账号/权限是**自己注册/自建**的吗？是则 true（只留过程，不计分）" },
      target: { type: "string", description: "配合 point_code 使用：目标资产" },
      seq: { type: "number", description: "不填则自动追加到链尾" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addChainStep(id, {
        ...rest,
        agent: agentOf(args, PLANNER_ROLE),
        recorded_by: args.recorded_by ?? args.agent,
      });
      /* 步骤落库后提醒两件事：报告要用的 tool/result 有没有写、这一步的得分有没有记 */
      const hints: string[] = [];
      if (!args.tool) hints.push('这一步没写 `tool`（实际命令）：报告里"怎么做的"会变成空白，建议补一条步骤把命令写上。');
      if (!args.result) hints.push('这一步没写 `result`（实际回显/结果）：报告复现时会缺"打没打通"的证据。');
      const scoreHint = result["score_hint"];
      if (typeof scoreHint === "string" && scoreHint !== "") hints.push(scoreHint);
      return toToolJson({
        ok: true,
        engagement: id,
        ...result,
        hints: hints.length > 0 ? hints : undefined,
      });
    },
  });

  /* ── redteam_chain ──────────────────────────────────────────────────── */
  const chain = defineTool({
    name: "redteam_chain",
    description: TOOL_DESCRIPTIONS.redteam_chain,
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({ ok: true, engagement: id, items: store.listChain(id) });
    },
  });

  /* ── redteam_attack_file_add ────────────────────────────────────────── */
  const attackFileAdd = defineTool({
    name: "redteam_attack_file_add",
    description: TOOL_DESCRIPTIONS.redteam_attack_file_add,
    parameters: {
      engagement: { type: "string" },
      target: { type: "string", required: true, description: "目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）" },
      name: { type: "string", required: true, description: "文件名，例如 cve-2021-22893.sh / vnc_brute.py" },
      kind: { type: "string", enum: ["poc", "exp", "script", "wordlist", "other"] as const, description: "类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典" },
      description: { type: "string", description: "这个文件做什么（一句话）" },
      evidence: { type: "string", required: true, description: "有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id" },
      content: { type: "string", description: "文件内容（与 path 二选一）" },
      path: { type: "string", description: "已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）" },
      asset_id: { type: "number" },
      vuln_id: { type: "number" },
      created_by: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...rest } = args;
      void _ignored;
      const result = store.addAttackFile(id, rest);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_attack_file_list ───────────────────────────────────────── */
  const attackFileList = defineTool({
    name: "redteam_attack_file_list",
    description: TOOL_DESCRIPTIONS.redteam_attack_file_list,
    parameters: {
      engagement: { type: "string" },
      target: { type: "string", description: "只看某个目标" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      /* 给了 target 就列该目标的文件，否则列整个目录树 */
      if (args.target !== undefined && args.target !== "") {
        return toToolJson({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) });
      }
      return toToolJson({ ok: true, engagement: id, folders: store.attackFileTree(id) });
    },
  });

  /* ── redteam_report_targets ─────────────────────────────────────────── */
  const reportTargets = defineTool({
    name: "redteam_report_targets",
    description: TOOL_DESCRIPTIONS.redteam_report_targets,
    parameters: {
      engagement: { type: "string" },
      target: { type: "string", description: "只看某个目标的报告" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.reportTargets(id, {});
      const picked =
        args.target === undefined || args.target === ""
          ? result.targets
          : result.targets.filter((t) => t.key === args.target || t.label === args.target);
      return toToolJson({
        ok: true,
        engagement: id,
        generated_at: result.generated_at,
        totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      });
    },
  });

  /* ── redteam_report ─────────────────────────────────────────────────── */
  const report = defineTool({
    name: "redteam_report",
    description: TOOL_DESCRIPTIONS.redteam_report,
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.report(id);
      return toToolJson({
        ok: true,
        engagement: id,
        generated_at: result.generated_at,
        stats: result.stats,
        markdown: result.markdown,
      });
    },
  });

  return [
    scoreList,
    scoreHit,
    scorePointSave,
    scoreReport,
    attackChain,
    httpEvidenceAdd,
    chainAdd,
    chain,
    attackFileAdd,
    attackFileList,
    reportTargets,
    report,
  ];
}

/** 本组工具名。 */
export const SCORE_TOOL_NAMES = [
  "redteam_score_list",
  "redteam_score_hit",
  "redteam_score_point_save",
  "redteam_score_report",
  "redteam_attack_chain",
  "redteam_http_evidence_add",
  "redteam_chain_add",
  "redteam_chain",
  "redteam_attack_file_add",
  "redteam_attack_file_list",
  "redteam_report_targets",
  "redteam_report",
] as const;

export type { ToolExecContext };
