/**
 * 工具层所需的 store 能力（**窄视图**，不是 `RedteamStore` 的副本）。
 *
 * ## 为什么需要这一层
 *
 * `RedteamStore`（`src/redteam/store/store.ts`）由 W1 维护，它的过滤参数大量声明为
 * `f: unknown = {}`：
 *
 * ```ts
 * listAssets(id: string, f: unknown = {}): AssetListResult
 * ```
 *
 * 工具层不能照抄这个签名 —— 那等于把 `unknown` 带进 56 个工具的 `execute`，
 * 又回到"参数名写错编译器不响"的起点。所以这里按**工具真正需要的形状**
 * 重新声明一遍，参数用具体类型。
 *
 * ## 定位（重要）
 *
 * - 这是「工具层所需能力的窄视图」，**不是** store 的副本，也不追求覆盖 store 全部方法。
 * - 只声明 `src/redteam/tools/**` 实际调用的那部分。工具不用到的方法不写。
 * - 将来 store 侧把签名收窄后，本接口应逐步退化（理想终态：`type StoreForTools = RedteamStore`）。
 *
 * ## 为什么用结构类型而不是 `implements`
 *
 * 这里不做 `interface X extends RedteamStore`：那会把 store 的全部方法拖进来，
 * 失去"窄"的意义。改为让调用点接受 `StoreForTools`，`RedteamStore` 因结构兼容而自动满足。
 *
 * `store-drift.test.ts` 会遍历本接口声明的方法名，与 `RedteamStore.prototype` 对比，
 * 断言"声明了但 store 上不存在"为空 —— store 改名时这里先红，而不是运行时才炸。
 */

import type { ResolvedTool } from "../../platform/platform-config.js";

/* ── 基础行类型（从 store/schema 的形状收敛为本层所需字段） ──────────────── */

/** 资产上的一条端口。 */
export interface ToolPort {
  readonly port: number;
  readonly proto: string;
  readonly state: string;
  readonly service?: string | null;
  readonly product?: string | null;
  readonly version?: string | null;
  readonly banner?: string | null;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly provenance: string;
  readonly tool?: string | null;
}

/** 资产上的一个名字。 */
export interface ToolAssetName {
  readonly name: string;
  readonly kind?: string | null;
  readonly provenance?: string | null;
}

/** 资产上的一个指纹。 */
export interface ToolFingerprint {
  readonly category: string;
  readonly vendor?: string | null;
  readonly product?: string | null;
  readonly version?: string | null;
  readonly evidence?: string | null;
  readonly confidence?: number | null;
  readonly provenance: string;
}

/**
 * 资产行（`compactAsset` 读取的字段）。
 *
 * 字段可空性与 store 的 `AssetRow` 保持一致的**语义**，但只列工具用到的：
 * 报告与面板用的其它字段不在工具读取范围内。
 */
export interface ToolAssetRow {
  readonly id: number;
  readonly ip: string;
  readonly segment_cidr: string;
  readonly state: string;
  readonly primary_name: string | null;
  readonly names: readonly ToolAssetName[];
  readonly ports: readonly ToolPort[];
  readonly fingerprints: readonly ToolFingerprint[];
  readonly passive: number;
  readonly active: number;
  readonly discovered_at: string | null;
  readonly first_seen: string | null;
  readonly last_seen: string | null;
  readonly test_status: string;
  readonly priority: string;
}

/** 资产列表结果。 */
export interface ToolAssetList {
  readonly total: number;
  readonly items: readonly ToolAssetRow[];
}

/** 分段行（`listSegments` 的返回）。 */
export interface ToolSegment {
  readonly cidr: string;
  readonly assets: number;
  readonly [key: string]: unknown;
}

/** 图谱节点（工具只读 `label` 与 `meta.owned`）。 */
export interface ToolGraphNode {
  readonly id: string;
  readonly label: string;
  readonly meta?: { readonly owned?: boolean } | null;
  readonly [key: string]: unknown;
}

/** 图谱边。 */
export interface ToolGraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
}

/** 图谱结果。 */
export interface ToolGraph {
  readonly nodes: readonly ToolGraphNode[];
  readonly edges: readonly ToolGraphEdge[];
}

/** 目标统计（`stats()`）。字段由面板与工具共同读取，这里只要求"是个对象"。 */
export interface ToolStats {
  readonly [key: string]: unknown;
}

/** 靶标摘要（`listEngagements()` 的一项）。 */
export interface ToolEngagementSummary {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly stats?: ToolStats;
}

/** `openEngagement` 的返回。 */
export interface ToolOpenedEngagement {
  readonly id: string;
  readonly name: string;
  readonly [key: string]: unknown;
}

/* ── 过滤 / 排序参数：这里是"具体类型"的落脚点 ──────────────────────────── */

/** 资产列表排序。 */
export type AssetSort = "priority" | "todo" | "ports" | "ip";

/** 资产列表过滤。 */
export interface AssetFilter {
  /** 精确匹配单个 IP（`asset_add` 回读刚写入那条时用）。 */
  readonly ip?: string | undefined;
  readonly cidr?: string | undefined;
  readonly port?: number | undefined;
  readonly service?: string | undefined;
  readonly fingerprint?: string | undefined;
  readonly provenance?: "passive" | "active" | undefined;
  readonly q?: string | undefined;
  readonly state?: "live" | "dead" | "unknown" | undefined;
  readonly scope?: "internal" | "external" | undefined;
  readonly sort?: AssetSort | undefined;
  readonly limit?: number | undefined;
}

/** 漏洞列表过滤。 */
export interface VulnFilter {
  readonly severity?: "critical" | "high" | "medium" | "low" | "info" | undefined;
  readonly status?: "candidate" | "confirmed" | "false-positive" | "exploited" | "fixed" | undefined;
  readonly cve?: string | undefined;
  readonly asset_id?: number | undefined;
  readonly cidr?: string | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
}

/** 分页列表结果（漏洞 / Web / 攻击文件等共用形状）。 */
export interface ToolListResult<T> {
  readonly total: number;
  readonly items: readonly T[];
}

/* ── 写入载荷：工具传给 store 的对象 ────────────────────────────────────── */

/** 资产导入载荷（`importBundle` 的支持子集）。 */
export interface AssetBundle {
  readonly scan?: { readonly tool?: string | null; readonly argv?: readonly string[] };
  readonly assets?: readonly {
    readonly ip: string;
    readonly state?: string | undefined;
    readonly primary_name?: string | undefined;
    readonly provenance: "passive" | "active";
    readonly tool?: string | undefined;
    readonly names?: readonly {
      readonly name: string;
      readonly kind?: string | undefined;
      readonly provenance?: "passive" | "active" | undefined;
    }[] | undefined;
    readonly ports?: readonly {
      readonly port: number;
      readonly proto?: string | undefined;
      readonly service?: string | undefined;
      readonly product?: string | undefined;
      readonly version?: string | undefined;
      readonly banner?: string | undefined;
      readonly url?: string | undefined;
      readonly title?: string | undefined;
      readonly provenance?: "passive" | "active" | undefined;
      readonly tool?: string | undefined;
      readonly fingerprints?: readonly {
        readonly category: string;
        readonly vendor?: string | undefined;
        readonly product?: string | undefined;
        readonly version?: string | undefined;
        readonly evidence?: string | undefined;
        readonly confidence?: number | undefined;
      }[] | undefined;
    }[] | undefined;
    readonly discovered_at?: string | undefined;
    readonly first_seen?: string | undefined;
  }[] | undefined;
  readonly edges?: readonly {
    readonly src_kind: string;
    readonly src_id: string;
    readonly dst_kind: string;
    readonly dst_id: string;
    readonly relation: string;
    readonly confidence?: number;
  }[];
}

/** `importBundle` 的计数结果。 */
export interface ImportCounts {
  readonly edges: number;
  readonly [key: string]: number;
}

/* ── 窄接口本体 ─────────────────────────────────────────────────────────── */

/**
 * 工具层实际用到的 store 能力。
 *
 * **只增不改**：新增工具需要新能力时在这里加一条，并在 `store-drift.test.ts` 里仍能通过。
 */
export interface StoreForTools {
  /* 靶标 / 会话 */
  activeEngagementId(): string | undefined;
  listEngagements(): readonly ToolEngagementSummary[];
  /**
   * 打开/创建靶标。
   *
   * 参数刻意收窄成工具真正传的形状：`name` 是字符串（工具侧 `target` 参数，required string），
   * `scope` 是 CIDR 列表或 `undefined`，`options` 只用到 `bindCurrent`。
   * store 侧的 `openEngagement(name: unknown, scope: unknown, options: unknown)`
   * 更宽，宽参数可以接受窄实参，所以结构兼容。
   */
  openEngagement(
    name: string,
    scope?: readonly string[] | undefined,
    options?: { readonly bindCurrent?: boolean } | undefined,
  ): ToolOpenedEngagement;
  getEngagement?(id: string): ToolEngagementSummary | undefined;
  stats(id: string): ToolStats;

  /* 资产 */
  importBundle(id: string, bundle: AssetBundle): { readonly counts: ImportCounts };
  listAssets(id: string, filter?: AssetFilter): ToolAssetList;
  getAsset(id: string, assetId: number): unknown;
  listSegments(id: string): readonly ToolSegment[];
  graph(id: string, filter?: { readonly cidr?: string }): ToolGraph;
  attackGraph?(id: string, filter?: { readonly cidr?: string }): ToolGraph & { readonly summary?: unknown };
  listWeb(id: string, filter?: { readonly cidr?: string; readonly limit?: number }): ToolListResult<{
    readonly url: string | null;
    readonly title: string | null;
    readonly ip: string;
    readonly segment_cidr: string;
    readonly port: number;
    readonly service: string | null;
    readonly product: string | null;
    readonly version: string | null;
    readonly provenance: string;
    readonly asset_id: number;
  }>;
  domainIndex(id: string): readonly unknown[];
  discoveryTimeline(
    id: string,
    filter?: { readonly limit?: number },
  ): {
    readonly span: unknown;
    readonly days: readonly unknown[];
    readonly recent: readonly {
      readonly id: number;
      readonly ip: string;
      readonly scope: string;
      readonly state: string;
      readonly primary_name: string | null;
      readonly discovered_at: string | null;
      readonly last_seen: string | null;
      readonly open_ports: number;
      readonly priority: string;
    }[];
  };
  updateAssetTest(id: string, patch: Record<string, unknown>): Record<string, unknown>;
  assessAsset(id: string, patch: Record<string, unknown>): Record<string, unknown>;

  /* 漏洞 */
  addVuln(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listVulns(id: string, filter?: VulnFilter): ToolListResult<unknown>;
  updateVuln(id: string, vulnId: number, patch: Record<string, unknown>): { readonly updated: boolean } & Record<string, unknown>;
  vulnStats(id: string): Record<string, unknown>;

  /* 凭据 / 访问 / 截图 */
  addCredential(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listCredentials(id: string, filter?: { readonly host?: string; readonly username?: string }): readonly unknown[];
  addAccess(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listAccess(id: string, filter?: { readonly host?: string }): readonly unknown[];
  addShot(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listShots(id: string, filter?: { readonly point_code?: string; readonly hit_id?: number; readonly asset_id?: number }): Record<string, unknown>;
  deleteShot(id: string, shotId: number): Record<string, unknown>;

  /* WebShell / 隧道 / 会话总览 */
  addWebshell(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listWebshells(id: string, filter?: { readonly status?: string; readonly asset_id?: number }): Record<string, unknown>;
  updateWebshell(id: string, shellId: number, patch: Record<string, unknown>): Record<string, unknown>;
  addTunnel(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listTunnels(id: string, filter?: { readonly status?: string }): Record<string, unknown>;
  updateTunnel(id: string, tunnelId: number, patch: Record<string, unknown>): Record<string, unknown>;
  sessionSummary(id: string): {
    readonly totals: unknown;
    readonly webshells: readonly {
      readonly id: number;
      readonly url: string;
      readonly shell_type: string;
      readonly pass_key: string | null;
      readonly privilege: string | null;
      readonly status: string;
      readonly asset_ip: string | null;
      readonly last_check: string | null;
      readonly note: string | null;
    }[];
    readonly tunnels: readonly {
      readonly id: number;
      readonly kind: string;
      readonly listen: string;
      readonly entry: string | null;
      readonly reach: string | null;
      readonly entry_kind: string | null;
      readonly legit: boolean | null;
      readonly status: string;
      readonly asset_ip: string | null;
      readonly command: string | null;
      readonly last_check: string | null;
      readonly note: string | null;
    }[];
  };
  probeSessions(
    id: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<{
    readonly checkedAt: string;
    readonly webshells: readonly { readonly status: string }[];
    readonly tunnels: readonly { readonly status: string }[];
  }>;

  /* 角色提示词 */
  listPrompts(id: string): readonly { readonly role: string; readonly title: string; readonly updated_at: string; readonly content: string }[];
  resetPrompts(id: string, role?: string): { readonly reset: readonly string[] };

  /* 得分 */
  listScorePoints(id: string, filter?: Record<string, never>): {
    readonly summary: unknown;
    readonly items: readonly {
      readonly id: number;
      readonly code: string;
      readonly name: string;
      readonly category: string;
      readonly points: number;
      readonly tier: string;
      readonly cap: number;
      readonly cap_used: number;
      readonly dedup_scope: string;
      readonly scope_label: string;
      readonly enabled: boolean;
      readonly counted: number;
      readonly earned: number;
      readonly capped: number;
      readonly service_summary: string;
      readonly hits: readonly { readonly target: string | null; readonly evidence: string }[];
    }[];
    readonly ruleGroups?: readonly {
      readonly name: string;
      readonly tiers: readonly unknown[];
      readonly points: number;
      readonly capSum: number;
    }[];
  };
  addScoreHit(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  saveScorePoint(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  scoreChain(id: string): {
    readonly summary: {
      readonly points: number;
      readonly totalPoints?: number;
      readonly hits: number;
      readonly serviceCappedHits?: number;
    };
    readonly stages: readonly {
      readonly code: string;
      readonly name: string;
      readonly goal: string;
      readonly points: number;
      readonly cumulative: number;
      readonly counted: number;
      readonly hits: number;
      readonly steps: number;
      readonly tools: number;
      readonly sections?: readonly { readonly label: string; readonly items?: readonly string[] }[];
      readonly items: readonly {
        readonly point_name: string;
        readonly points: number;
        readonly counted: boolean;
        readonly target: string | null;
        readonly service?: string | null;
        readonly capped?: boolean;
        readonly capped_reason?: string | null;
      }[];
      readonly assets?: readonly { readonly ip: string; readonly scope: string; readonly points: number }[];
      readonly tunnels?: readonly { readonly kind: string; readonly listen: string; readonly status: string; readonly reach?: string | null }[];
    }[];
  };

  /* 证据 / 攻击链 / 攻击文件 / 报告 */
  addHttpEvidence(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  addChainStep(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listChain(id: string): readonly unknown[];
  addAttackFile(id: string, payload: Record<string, unknown>): Record<string, unknown>;
  listAttackFiles(id: string, filter?: { readonly target?: string }): readonly unknown[];
  attackFileTree(id: string): readonly unknown[];
  scoreReport(
    id: string,
    options?: { readonly limit?: number },
  ): {
    readonly summary: unknown;
    readonly markdown: string;
    readonly items: readonly {
      readonly seq: number;
      readonly point_name: string;
      readonly points: number;
      readonly counted: boolean;
      readonly target: string | null;
      readonly gained: string | null;
      readonly requests: readonly unknown[];
      readonly missing_evidence: unknown;
    }[];
  };
  report(id: string): { readonly generated_at: string; readonly stats: unknown; readonly markdown: string };
  reportTargets(
    id: string,
    options?: Record<string, never>,
  ): {
    readonly generated_at: string;
    readonly totals: unknown;
    readonly targets: readonly {
      readonly key: string;
      readonly label: string;
      readonly segment: string;
      readonly stats: unknown;
    }[];
  };

  /* 知识库（POC/EXP） */
  searchPocs(filter: PocSearchFilter): readonly PocSearchRow[];
  getPoc(idOrCode: number | string | undefined): unknown;
  savePoc(payload: Record<string, unknown>): { readonly created: boolean; readonly poc: PocSavedRow; readonly path: string | null };
  updatePoc(idOrCode: number | string | undefined, patch: Record<string, unknown>): PocSavedRow;
  markPocUsed(idOrCode: number | string | undefined, usedOn?: string): unknown;
  pocStats(): PocStats;
  searchTemplates(q: string, limit: number, offset: number, category: string): TemplateSearchResult;
  templateStats(): TemplateStats;
  nucleiTemplatesDir(): string | null;
}

/** 知识库检索条件。 */
export interface PocSearchFilter {
  readonly q?: string | undefined;
  readonly cve?: string | undefined;
  readonly component?: string | undefined;
  readonly kind?: string | undefined;
  readonly category?: string | undefined;
  readonly engagement?: string | undefined;
  readonly asset_target?: string | undefined;
  readonly language?: string | undefined;
  readonly source?: string | undefined;
  readonly verified?: boolean | undefined;
  readonly limit?: number | undefined;
}

/** 知识库检索结果的一行（工具只读这些字段）。 */
export interface PocSearchRow {
  readonly id: number;
  readonly code: string;
  readonly title: string;
  readonly kind: string;
  readonly category: string | null;
  readonly cve: string | null;
  readonly component: string | null;
  readonly versions: string | null;
  readonly language: string | null;
  readonly source: string | null;
  readonly source_url: string | null;
  readonly verified: number;
  readonly verified_note: string | null;
  readonly hit_count: number;
  readonly engagement_id: string | null;
  readonly engagement_name: string | null;
  readonly asset_target: string | null;
  readonly found_by_agent: string | null;
  readonly created_at: string;
  readonly tags: string | null;
  readonly usage: string | null;
  readonly path: string | null;
  readonly has_content: number;
}

/** 保存后的 POC 行。 */
export interface PocSavedRow {
  readonly id: number;
  readonly code: string;
  readonly category: string | null;
  readonly engagement_id: string | null;
  readonly engagement_name: string | null;
  readonly asset_target: string | null;
  readonly created_at: string;
  readonly verified: number;
  readonly verified_note: string | null;
  readonly updated_at: string;
}

/** 知识库统计。 */
export interface PocStats {
  readonly total: number;
  readonly verified: number;
  readonly reused: number;
  readonly byCategory?: readonly { readonly name: string; readonly n: number; readonly verified: number }[];
  readonly byEngagement?: readonly { readonly engagement: string; readonly n: number }[];
  readonly byKind?: Readonly<Record<string, number>>;
  readonly bySource?: Readonly<Record<string, number>>;
}

/** 模板检索结果。 */
export interface TemplateSearchResult {
  readonly dir: string | null;
  readonly total: number;
  readonly items: readonly {
    readonly path: string;
    readonly name: string;
    readonly severity: string | null;
    readonly tags: readonly string[];
  }[];
  readonly byCategory?: readonly { readonly name: string; readonly n: number }[];
}

/** 模板统计。 */
export interface TemplateStats {
  readonly dir: string | null;
  readonly total: number;
  readonly cve: number;
  readonly byCategory?: readonly { readonly name: string; readonly n: number }[];
}

/** 工具侧解析出的平台工具集（preflight 用）。 */
export interface PlatformToolsView {
  readonly total: number;
  readonly found: number;
  readonly missing: number;
  readonly items: readonly ResolvedTool[];
}
