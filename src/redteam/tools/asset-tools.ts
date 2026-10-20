/**
 * 资产组工具（11 个）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 的 783–1032、1456–1489、1993–2018 行。
 *
 * ## `description` 逐字照搬
 *
 * 见 `session-tools.ts` 头部说明：description 是指令的一部分。
 *
 * ## `asset_add` 的嵌套 schema
 *
 * 这是 56 个工具里参数最深的一个：`assets[] → ports[] → fingerprints[]`。
 * 原实现靠 `JSON` 隐式传递，类型层完全空白；这里用嵌套 `ParamDecl` 声明，
 * 让 `args.ports[0].fingerprints[0].category` 有真实类型。
 *
 * 注意 `additionalProperties: false` 在宿主 schema 里存在但不在我们的 `ParamDecl` 上 ——
 * 它只影响宿主的参数校验严格度，不影响工具内部类型，故不引入。
 */

import type { ToolExecContext } from "../../host-api/types.js";
import { agentOf } from "./context.js";
import { defineTool, renderText, toToolJson } from "./define.js";
import type { AnyTypedTool } from "./define.js";
import { bindingViewOf, resolveEngagement } from "./context.js";
import type { StoreForTools } from "./store-contract.js";
import type { ToolRuntimeContext } from "./session-tools.js";
import { AGENT_PARAM } from "./session-tools.js";
import { PLANNER_ROLE } from "../store/constants.js";

/* ── 紧凑行：把一行资产压成模型可读的结构 ──────────────────────────────── */

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
export function compactAsset(a: {
  readonly id: number;
  readonly ip: string;
  readonly segment_cidr: string;
  readonly state: string;
  readonly primary_name: string | null;
  readonly names: readonly { readonly name: string }[];
  readonly ports: readonly {
    readonly port: number;
    readonly proto: string;
    readonly state: string;
    readonly service?: string | null;
    readonly product?: string | null;
    readonly version?: string | null;
    readonly provenance: string;
  }[];
  readonly fingerprints: readonly {
    readonly category: string;
    readonly vendor?: string | null;
    readonly product?: string | null;
    readonly version?: string | null;
    readonly provenance: string;
  }[];
  readonly passive: number;
  readonly active: number;
  readonly discovered_at: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly test_status: string;
  readonly priority: string;
}): Record<string, unknown> {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports
      .filter((p) => p.state === "open")
      .map(
        (p) =>
          String(p.port) +
          "/" +
          p.proto +
          (p.service
            ? " " + [p.service, p.product, p.version].filter(Boolean).join(" ")
            : "") +
          " [" +
          p.provenance +
          "]",
      ),
    fingerprints: a.fingerprints.map(
      (f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(" ") + " [" + f.provenance + "]",
    ),
    passive: a.passive,
    active: a.active,
    /* 发现时间：这条资产第一次进入本库的时刻（面板与报告都按它排时间线） */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  };
}

/** 构造资产组工具。 */
export function assetTools(store: StoreForTools, ctx: ToolRuntimeContext): readonly AnyTypedTool[] {
  void ctx;

  /* ── redteam_asset_add ──────────────────────────────────────────────── */
  const assetAdd = defineTool({
    name: "redteam_asset_add",
    description:
      "把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。",
    parameters: {
      engagement: { type: "string", description: "靶标 id；省略则用当前会话绑定的靶标" },
      ip: { type: "string", required: true, description: "资产 IP（IPv4）" },
      state: { type: "string", description: "live | dead | unknown，默认 unknown" },
      primary_name: { type: "string", description: "主域名/主机名" },
      provenance: {
        type: "string",
        required: true,
        enum: ["passive", "active"] as const,
        description: "本条发现的来源：被动或主动",
      },
      tool: { type: "string", description: "数据源或工具名，例如 crt.sh / nmap / nuclei / curl" },
      discovered_at: {
        type: "string",
        description:
          '【可选】这条资产的发现时间（ISO，如 2026-09-17T09:30:00Z）。不填则按"第一次入库的时刻"自动记录；数据源给出历史首次出现时间时传进来更准。**重复采集不会覆盖它**。',
      },
      first_seen: { type: "string", description: "【可选】数据源/工具报告的首次出现时间（与发现时间分开记）" },
      names: {
        type: "array",
        description: "该资产关联的域名/证书名",
        items: {
          type: "object",
          properties: {
            name: { type: "string", required: true },
            kind: { type: "string", description: "domain | hostname | cert_cn，默认 domain" },
            provenance: { type: "string", enum: ["passive", "active"] as const },
          },
        },
      },
      ports: {
        type: "array",
        description: "开放端口及其服务/指纹",
        items: {
          type: "object",
          properties: {
            port: { type: "number", required: true },
            proto: { type: "string", description: "tcp（默认）| udp" },
            service: { type: "string", description: "服务名，例如 http / mysql" },
            product: { type: "string", description: "产品名，例如 nginx" },
            version: { type: "string", description: "版本，例如 1.24.0" },
            banner: { type: "string", description: "原始 banner 片段" },
            url: {
              type: "string",
              description: "Web 服务可直接访问的完整 URL，例如 https://oa.example.com:8443/portal",
            },
            title: { type: "string", description: "Web 页面标题（HTTP 探测获取），例如「致远OA 登录」" },
            provenance: { type: "string", enum: ["passive", "active"] as const },
            tool: { type: "string" },
            fingerprints: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  /* 原实现漏了 required:true —— 但指纹没有 category 就无法归类，
                     报告里会显示成一条空分类。这里补上（与下游 Consumer 的必填一致）。 */
                  category: {
                    type: "string",
                    required: true,
                    description: "Web服务器 | 中间件 | 框架 | CMS | 数据库 | VPN网关 …",
                  },
                  vendor: { type: "string" },
                  product: { type: "string" },
                  version: { type: "string" },
                  evidence: { type: "string", description: "判定依据，例如响应头 / 路径 / banner" },
                  confidence: { type: "number", description: "0–1" },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const asset = {
        ip: args.ip,
        state: args.state,
        primary_name: args.primary_name,
        provenance: args.provenance,
        tool: args.tool,
        names: args.names,
        ports: args.ports,
        /* 发现时间：不传则由服务端按"第一次入库的时刻"自动记录；
           数据源能给历史时间（FOFA 的 first_seen 等）就传进来，报告时间线更准 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      };
      const result = store.importBundle(id, {
        scan: { tool: args.tool ?? null, argv: ["redteam_asset_add"] },
        assets: [asset],
      });
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0];
      return toToolJson({
        ok: true,
        engagement: id,
        counts: result.counts,
        asset: written === undefined ? null : compactAsset(written),
        discovered_at: written === undefined ? null : written.discovered_at,
        hint:
          "本条资产的发现时间已记为 " +
          (written?.discovered_at ?? "(未知)") +
          "；重复采集只刷新 last_seen，不会改动发现时间。",
      });
    },
  });

  /* ── redteam_asset_link ─────────────────────────────────────────────── */
  const assetLink = defineTool({
    name: "redteam_asset_link",
    description:
      "在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。",
    parameters: {
      engagement: { type: "string" },
      src_kind: { type: "string", required: true, description: "segment | asset | domain | port …" },
      src_id: { type: "string", required: true },
      dst_kind: { type: "string", required: true },
      dst_id: { type: "string", required: true },
      relation: { type: "string", required: true },
      confidence: { type: "number" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.importBundle(id, {
        edges: [
          {
            src_kind: args.src_kind,
            src_id: args.src_id,
            dst_kind: args.dst_kind,
            dst_id: args.dst_id,
            relation: args.relation,
            ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
          },
        ],
      });
      return toToolJson({ ok: true, edges: result.counts.edges });
    },
  });

  /* ── redteam_asset_query ────────────────────────────────────────────── */
  const assetQuery = defineTool({
    name: "redteam_asset_query",
    description:
      "检索资产库。支持按 C 段、端口、服务、指纹、来源、内外网维度（scope）、排序（sort）、关键词（全文，覆盖 IP/域名/banner/服务/指纹）过滤。返回紧凑结果，含每个资产的开放端口与指纹及内外网归属。",
    parameters: {
      engagement: { type: "string" },
      cidr: { type: "string", description: "C 段，例如 203.0.113.0/24" },
      port: { type: "number", description: "开放端口" },
      service: { type: "string", description: "服务/产品名关键词，例如 nginx" },
      fingerprint: { type: "string", description: "指纹关键词，例如 Tomcat / Spring" },
      provenance: { type: "string", enum: ["passive", "active"] as const, description: "只看被动或主动来源" },
      q: { type: "string", description: "全文检索词（空格分隔多词为 AND）" },
      state: { type: "string", enum: ["live", "dead", "unknown"] as const },
      scope: {
        type: "string",
        enum: ["internal", "external"] as const,
        description: "内外网维度：internal=内网/私网地址，external=互联网可达",
      },
      sort: {
        type: "string",
        enum: ["priority", "todo", "ports", "ip"] as const,
        description: "排序：priority=易打性优先（默认），todo=待测优先，ports=端口多优先，ip=按 IP",
      },
      limit: { type: "number", description: "返回条数上限，默认 50，最大 200" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const limit = Math.min(Number(args.limit) || 50, 200);
      const result = store.listAssets(id, {
        ...(args.cidr === undefined ? {} : { cidr: args.cidr }),
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.service === undefined ? {} : { service: args.service }),
        ...(args.fingerprint === undefined ? {} : { fingerprint: args.fingerprint }),
        ...(args.provenance === undefined ? {} : { provenance: args.provenance }),
        ...(args.q === undefined ? {} : { q: args.q }),
        ...(args.state === undefined ? {} : { state: args.state }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.sort === undefined ? {} : { sort: args.sort }),
        limit,
      });
      return toToolJson({
        ok: true,
        engagement: id,
        total: result.total,
        returned: result.items.length,
        items: result.items.map(compactAsset),
      });
    },
  });

  /* ── redteam_asset_get ──────────────────────────────────────────────── */
  const assetGet = defineTool({
    name: "redteam_asset_get",
    description: "取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。",
    parameters: {
      engagement: { type: "string" },
      id: { type: "number", required: true, description: "资产 id（来自 redteam_asset_query 结果）" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const asset = store.getAsset(id, args.id);
      if (asset === undefined) return toToolJson({ ok: false, error: "asset not found" });
      return toToolJson({ ok: true, asset });
    },
  });

  /* ── redteam_asset_stats ────────────────────────────────────────────── */
  const assetStats = defineTool({
    name: "redteam_asset_stats",
    description: "资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。",
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) });
    },
  });

  /* ── redteam_asset_graph ────────────────────────────────────────────── */
  const assetGraph = defineTool({
    name: "redteam_asset_graph",
    description:
      "导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。",
    parameters: {
      engagement: { type: "string" },
      cidr: { type: "string", description: "只取某个 C 段的子图" },
      maxNodes: { type: "number", description: "节点上限，默认 300" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000);
      const graph = store.graph(id, args.cidr === undefined ? {} : { cidr: args.cidr });
      if (graph.nodes.length > maxNodes) {
        return toToolJson({
          ok: false,
          error: "图谱节点过多（" + String(graph.nodes.length) + " > " + String(maxNodes) + "），请指定 cidr 缩小范围",
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        });
      }
      return toToolJson({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges });
    },
  });

  /* ── redteam_asset_test ─────────────────────────────────────────────── */
  const assetTest = defineTool({
    name: "redteam_asset_test",
    description:
      "记录对某个资产的测试情况：本次做了什么测试（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、当前测试状态、是否被 WAF 封禁。**每个资产开始测之前先调一次（status=testing），测完/放弃再调一次**——资产测绘页面据此显示「未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面」。排除结论、登录失败原因、重测理由都写在 `test` 里。",
    parameters: {
      engagement: { type: "string" },
      asset_id: { type: "number", description: "资产 id（与 ip 二选一，优先 asset_id）" },
      ip: { type: "string", description: "资产 IP" },
      status: {
        type: "string",
        enum: ["untested", "testing", "tested", "blocked", "abandoned", "no_surface"] as const,
        description: "测试状态：未测试/测试中/已测试/被封禁/已放弃/无攻击面",
      },
      test: {
        type: "string",
        description:
          "本次做了什么测试（**追加**到测试记录，例如「nmap 全端口 + nuclei cve 模板 + 接口越权」）。排除结论、登录失败原因、重测理由都写这里。",
      },
      notes: { type: "string", description: "test 的兼容别名（老提示词里的写法），效果与 test 相同，会一并追加到测试记录。" },
      surface: { type: "string", description: "还剩什么攻击面可测（覆盖式，例如「SMB 445 未测；Web /api 未做越权」）" },
      blocked: { type: "boolean", description: "本次是否被 WAF/防护封禁（true 时封禁计数 +1）" },
      updated_by: { type: "string", description: "记录角色，例如 recon / vuln-scan" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      /* `engagement` 从 payload 里剔掉：它是"作用在哪个靶标"，不是资产字段 */
      const { engagement: _ignored, ...patch } = args;
      void _ignored;
      const result = store.updateAssetTest(id, patch);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_asset_assess ───────────────────────────────────────────── */
  const assetAssess = defineTool({
    name: "redteam_asset_assess",
    description:
      "给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。",
    parameters: {
      engagement: { type: "string" },
      asset_id: { type: "number" },
      ip: { type: "string" },
      priority: {
        type: "string",
        enum: ["high", "medium", "low"] as const,
        description: "high 容易出成果 / medium 一般 / low 难打或价值低",
      },
      potential: { type: "string", description: "预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」" },
      reason: {
        type: "string",
        description: "判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等",
      },
      assessed_by: { type: "string" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const { engagement: _ignored, ...patch } = args;
      void _ignored;
      const result = store.assessAsset(id, patch);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  /* ── redteam_asset_timeline ─────────────────────────────────────────── */
  const assetTimeline = defineTool({
    name: "redteam_asset_timeline",
    description:
      "资产「发现时间」视图：按天聚合\"哪天收了多少资产\"（区分内网/外网），并列出最近发现的资产。用于回答\"这个资产是什么时候发现的\"、检查信息收集有没有断层，也用于本轮收集的收口核对。",
    parameters: {
      engagement: { type: "string" },
      limit: { type: "number", description: "最近资产条数，默认 50" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const data = store.discoveryTimeline(id, args.limit === undefined ? {} : { limit: args.limit });
      return toToolJson({
        ok: true,
        engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id,
          ip: a.ip,
          scope: a.scope,
          state: a.state,
          name: a.primary_name,
          discovered_at: a.discovered_at,
          last_seen: a.last_seen,
          open_ports: a.open_ports,
          priority: a.priority,
        })),
        hint:
          "发现时间 = 这条资产**第一次进入本库**的时刻；重复采集只刷新 last_seen。" +
          "报告附录与资产测绘页都按它排序。",
      });
    },
  });

  /* ── redteam_web_list ───────────────────────────────────────────────── */
  const webList = defineTool({
    name: "redteam_web_list",
    description: "列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。",
    parameters: {
      engagement: { type: "string" },
      cidr: { type: "string" },
      limit: { type: "number" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.listWeb(id, {
        ...(args.cidr === undefined ? {} : { cidr: args.cidr }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return toToolJson({
        ok: true,
        engagement: id,
        total: result.total,
        items: result.items.map((w) => ({
          /* URL 缺失时按端口推一个：443/8443/9443 走 https，80/443 不带端口 */
          url:
            w.url ||
            ("http" + (w.port === 443 || w.port === 8443 || w.port === 9443 ? "s" : "") + "://" + w.ip +
              (w.port === 80 || w.port === 443 ? "" : ":" + String(w.port))),
          title: w.title,
          ip: w.ip,
          segment: w.segment_cidr,
          port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(" "),
          provenance: w.provenance,
          asset_id: w.asset_id,
        })),
      });
    },
  });

  /* ── redteam_domain_index ───────────────────────────────────────────── */
  const domainIndex = defineTool({
    name: "redteam_domain_index",
    description: "按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。",
    parameters: { engagement: { type: "string" } },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      return toToolJson({ ok: true, engagement: id, items: store.domainIndex(id) });
    },
  });

  return [
    assetAdd,
    assetLink,
    assetQuery,
    assetGet,
    assetStats,
    assetGraph,
    assetTest,
    assetAssess,
    assetTimeline,
    webList,
    domainIndex,
  ];
}

/** 本组工具名（顺序即注册顺序）。 */
export const ASSET_TOOL_NAMES = [
  "redteam_asset_add",
  "redteam_asset_link",
  "redteam_asset_query",
  "redteam_asset_get",
  "redteam_asset_stats",
  "redteam_asset_graph",
  "redteam_asset_test",
  "redteam_asset_assess",
  "redteam_asset_timeline",
  "redteam_web_list",
  "redteam_domain_index",
] as const;

/* 保留导出：本组工具与其他组共用这些助手 */
export { AGENT_PARAM, PLANNER_ROLE, agentOf, bindingViewOf };
export type { ToolExecContext };
