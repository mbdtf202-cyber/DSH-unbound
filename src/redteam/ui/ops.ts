/**
 * op 词汇表（81 个）与载荷校验。
 *
 * ## 数字从哪来
 *
 * - `store` 类 **72** 个：`store-core.js` 的 `dispatch`（71 个不同 op，`prompts` 出现两次
 *   也算一个）+ `dispatchAsync` 独有的 `probeSessions`。
 * - `gateway` 类 **9** 个：只存在于 HTTP 桥这一层，原 `ui.js` 自己的
 *   `handleAgentsOp` / `handleUpdateOp` / `handleSkillOp` / `handlePlatformOp` 分支
 *   （`agentsStatus`、`setAgentsMax`、`version`、`updateCheck`、`updateApply`、
 *   `skillCatalog`、`skillRead`、`platformEnvAdaptStatus`、`platformEnvAdaptSkip`）。
 * - `platformConfigGet` / `platformConfigSave` / `platformAssignToolkit` 两边都有，
 *   只算一次，归 `store`（资产库那份带 root 参数，网关这份是纯转发）。
 *
 * 合计 72 + 9 = **81**。
 *
 * ## 为什么要一张表
 *
 * 原实现靠 71 条 `if (op === '...')` 顺序执行，`store` 里再抛
 * `unknown op: x`。没有地方能回答「这个 op 存在吗、必填什么」，
 * 于是浏览器侧传错字段只会在深层炸出 `undefined is not a function`。
 * 表把三件事钉死：存在性、归属层（本地 / 转资产库）、必填字段与类型。
 */

import { err, ok, type Result } from "../../shared/result.js";

/** 载荷字段的运行时类型。`scalar` = 字符串或数字（id 两处口径不一致）。 */
export type FieldType = "string" | "number" | "boolean" | "object" | "array" | "scalar";

/** op 归谁处理。`gateway` 在 HTTP 桥本地，`store` 转给资产库服务。 */
export type OpKind = "store" | "gateway";

/** 单个 op 的元数据：归属层 + 必填 + 可选。 */
export interface OpMeta {
  readonly kind: OpKind;
  /** 必填字段 → 期望类型。缺失或类型不符即 `invalid_payload`。 */
  readonly required: Readonly<Record<string, FieldType>>;
  /** 可选字段 → 期望类型；**存在且类型不符**同样报错，避免把垃圾透传下去。 */
  readonly optional: Readonly<Record<string, FieldType>>;
}

/** 资产库可处理的 op（72）。顺序与 `store-core.js` 的 if 链一致，便于对照。 */
export const STORE_OP_NAMES = [
  // —— 靶标生命周期
  "bootstrap",
  "openEngagement",
  "activateEngagement",
  // —— 知识库（全局，不依赖靶标）
  "pocSearch",
  "pocList",
  "templateSearch",
  "templateStats",
  "pocGet",
  "pocSave",
  "pocUpdate",
  "pocDelete",
  "pocUse",
  "pocStats",
  // —— 平台配置（store 份）
  "platformConfigGet",
  "platformConfigSave",
  "platformAssignToolkit",
  // —— 快照与资产测绘
  "prompts",
  "snapshot",
  "assets",
  "asset",
  "graph",
  "attackGraph",
  "stats",
  // —— 漏洞
  "vulns",
  "addVuln",
  "updateVuln",
  "vulnStats",
  // —— 凭据与权限
  "credentials",
  "addCredential",
  "access",
  "addAccess",
  // —— 会话、隧道、webshell
  "sessions",
  "webshells",
  "addWebshell",
  "updateWebshell",
  "tunnels",
  "addTunnel",
  "updateTunnel",
  // —— 证据截图
  "shots",
  "shotAdd",
  "shotDelete",
  "shotData",
  // —— 域名与 Web
  "domains",
  "web",
  "httpEvidence",
  "addHttpEvidence",
  // —— 攻击链与报告
  "chain",
  "addChainStep",
  "report",
  "reportTargets",
  // —— 资产测试与评估
  "assetTest",
  "assessAsset",
  // —— 得分
  "scores",
  "saveScorePoint",
  "deleteScorePoint",
  "addScoreHit",
  "scoreChain",
  "scoreReport",
  "activeTests",
  "testStats",
  // —— 页签未读指针
  "consoleDigest",
  // —— 阶段与时间线
  "stages",
  "saveStage",
  "discoveryTimeline",
  // —— 攻击文件
  "attackFiles",
  "addAttackFile",
  "readAttackFile",
  // —— 整包导入
  "import",
  // —— 提示词
  "savePrompt",
  "resetPrompts",
  // —— 异步唯一：在 host 侧真实发起 TCP/HTTP 探测
  "probeSessions",
] as const;

/** 网关自身处理的 op（9）。 */
export const GATEWAY_OP_NAMES = [
  "agentsStatus",
  "setAgentsMax",
  "version",
  "updateCheck",
  "updateApply",
  "skillCatalog",
  "skillRead",
  "platformEnvAdaptStatus",
  "platformEnvAdaptSkip",
] as const;

export type StoreOp = (typeof STORE_OP_NAMES)[number];
export type GatewayOp = (typeof GATEWAY_OP_NAMES)[number];
export type OpName = StoreOp | GatewayOp;

/**
 * 只读查询类 op 的公共基片段。
 *
 * `kind` 在这里写成 `"store"` 而不是留空：`...QUERY` 只用于转资产库的那批，
 * 网关类条目逐个显式写 `kind: "gateway"`。`OpMeta.kind` 保持**必填**是有意的 ——
 * `parseRequest` 的路由完全靠它，「每个 op 恰好属于一层」由编译器兜住，
 * 不会出现某个 op 因为忘写 kind 而在运行时落错处理器。
 */
const QUERY = { kind: "store", required: {}, optional: { engagement: "string" } } as const;

/** 写操作：要靶标，载荷是对象（原实现 `req.x || req`）。 */
function write(field: string): OpMeta {
  return {
    kind: "store",
    required: { [field]: "object" },
    optional: { engagement: "string" },
  };
}

/** 按 id 操作：`id` 可能是主键或 code。 */
function byId(optional: Readonly<Record<string, FieldType>> = {}): OpMeta {
  return { kind: "store", required: { id: "scalar" }, optional: { engagement: "string", ...optional } };
}

/**
 * 完整 op 表。
 *
 * 类型注解用 `{ readonly [K in OpName]: OpMeta }`：**漏一个 op 编译失败**，
 * 这是「词汇表与分派不可能漂移」的机械保证。
 */
export const OP_TABLE: { readonly [K in OpName]: OpMeta } = {
  // ---------- store ----------
  bootstrap: { kind: "store", required: {}, optional: { engagement: "string" } },
  openEngagement: { kind: "store", required: { name: "string" }, optional: { scope: "string" } },
  activateEngagement: { kind: "store", required: { engagement: "string" }, optional: {} },

  pocSearch: {
    kind: "store",
    required: {},
    optional: {
      q: "string", query: "string", cve: "string", component: "string",
      templateLimit: "number", engagement: "string",
    },
  },
  pocList: { kind: "store", required: {}, optional: { q: "string", engagement: "string" } },
  templateSearch: { kind: "store", required: {}, optional: { q: "string", limit: "number" } },
  templateStats: { kind: "store", required: {}, optional: {} },
  pocGet: { kind: "store", required: {}, optional: { id: "scalar", code: "string" } },
  pocSave: { kind: "store", required: {}, optional: { poc: "object" } },
  pocUpdate: { kind: "store", required: {}, optional: { id: "scalar", code: "string", patch: "object" } },
  pocDelete: { kind: "store", required: {}, optional: { id: "scalar", code: "string" } },
  pocUse: { kind: "store", required: {}, optional: { id: "scalar", code: "string", used_on: "string" } },
  pocStats: { kind: "store", required: {}, optional: {} },

  platformConfigGet: { kind: "store", required: {}, optional: {} },
  platformConfigSave: { kind: "store", required: { config: "object" }, optional: {} },
  platformAssignToolkit: { kind: "store", required: { dir: "string" }, optional: {} },

  prompts: { ...QUERY },
  snapshot: { ...QUERY },
  assets: {
    kind: "store",
    required: {},
    optional: {
      engagement: "string", cidr: "string", q: "string", service: "string", port: "string",
      provenance: "string", test_status: "string", priority: "string", scope: "string",
      state: "string", sort: "string", limit: "number",
    },
  },
  asset: byId(),
  graph: { ...QUERY, optional: { engagement: "string", depth: "number" } },
  attackGraph: { ...QUERY },
  stats: { ...QUERY },

  vulns: { ...QUERY, optional: { engagement: "string", state: "string", severity: "string", limit: "number" } },
  addVuln: write("vuln"),
  updateVuln: byId({ patch: "object" }),
  vulnStats: { ...QUERY },

  credentials: { ...QUERY, optional: { engagement: "string", q: "string" } },
  addCredential: write("credential"),
  access: { ...QUERY, optional: { engagement: "string", q: "string" } },
  addAccess: write("access"),

  sessions: { ...QUERY },
  webshells: { ...QUERY, optional: { engagement: "string", status: "string" } },
  addWebshell: write("webshell"),
  updateWebshell: byId({ patch: "object" }),
  tunnels: { ...QUERY, optional: { engagement: "string", status: "string" } },
  addTunnel: write("tunnel"),
  updateTunnel: byId({ patch: "object" }),

  shots: { ...QUERY, optional: { engagement: "string", kind: "string", score_id: "scalar" } },
  shotAdd: write("shot"),
  shotDelete: { kind: "store", required: {}, optional: { id: "scalar", shot_id: "scalar", engagement: "string" } },
  shotData: { kind: "store", required: {}, optional: { id: "scalar", shot_id: "scalar", engagement: "string" } },

  domains: { ...QUERY, optional: { engagement: "string", cidr: "string" } },
  web: { ...QUERY, optional: { engagement: "string", cidr: "string" } },
  httpEvidence: { ...QUERY, optional: { engagement: "string", host: "string" } },
  addHttpEvidence: write("evidence"),

  chain: { ...QUERY },
  addChainStep: write("step"),
  report: { ...QUERY },
  reportTargets: { ...QUERY, optional: { engagement: "string", format: "string" } },

  assetTest: { kind: "store", required: {}, optional: { test: "object", engagement: "string", id: "scalar" } },
  assessAsset: { kind: "store", required: {}, optional: { assess: "object", engagement: "string", id: "scalar" } },

  scores: { ...QUERY, optional: { engagement: "string", stage: "string" } },
  saveScorePoint: write("point"),
  deleteScorePoint: { kind: "store", required: { id: "scalar" }, optional: { engagement: "string" } },
  addScoreHit: write("hit"),
  scoreChain: { ...QUERY, optional: { engagement: "string", stage: "string" } },
  scoreReport: { ...QUERY, optional: { engagement: "string", format: "string" } },
  activeTests: { ...QUERY, optional: { engagement: "string", since: "number" } },
  testStats: { ...QUERY },

  consoleDigest: { ...QUERY },

  stages: { ...QUERY },
  saveStage: write("stage"),
  discoveryTimeline: { ...QUERY, optional: { engagement: "string", cidr: "string" } },

  attackFiles: { ...QUERY },
  addAttackFile: write("file"),
  readAttackFile: { kind: "store", required: { id: "scalar" }, optional: { engagement: "string" } },

  import: { kind: "store", required: {}, optional: { bundle: "object", file: "string", engagement: "string" } },

  savePrompt: { kind: "store", required: { role: "string", content: "string" }, optional: { engagement: "string" } },
  resetPrompts: { kind: "store", required: { role: "string" }, optional: { engagement: "string" } },

  probeSessions: { ...QUERY, optional: { engagement: "string", timeout_ms: "number" } },

  // ---------- gateway（本地） ----------
  agentsStatus: { kind: "gateway", required: {}, optional: {} },
  setAgentsMax: { kind: "gateway", required: { max: "number" }, optional: {} },
  version: { kind: "gateway", required: {}, optional: {} },
  updateCheck: { kind: "gateway", required: {}, optional: {} },
  // target 只允许纯 semver；此处只保证形态是字符串，语义校验在 preflight 里做。
  updateApply: { kind: "gateway", required: {}, optional: { target: "string" } },
  skillCatalog: { kind: "gateway", required: {}, optional: { refresh: "boolean" } },
  skillRead: { kind: "gateway", required: { name: "string" }, optional: { library: "string" } },
  platformEnvAdaptStatus: { kind: "gateway", required: {}, optional: {} },
  platformEnvAdaptSkip: { kind: "gateway", required: {}, optional: { skip: "boolean" } },
};

/** 全部 op 名（表驱动，顺序稳定：先 store 后 gateway）。 */
export const OP_NAMES: readonly OpName[] = [...STORE_OP_NAMES, ...GATEWAY_OP_NAMES];

/** 运行期快速判定：`unknown` → op 名。 */
export function isOpName(value: unknown): value is OpName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OP_TABLE, value);
}

/** 解析失败的原因。`missing_op` / `unknown_op` / `invalid_payload` 三分类。 */
export interface ParseFailure {
  readonly code: "missing_op" | "unknown_op" | "invalid_payload";
  readonly message: string;
  readonly op?: string;
  readonly details: readonly string[];
}

/**
 * 校验通过后的请求。
 *
 * `raw` 是**原样**的 JSON 对象：资产库读取 `req.engagement` / `req.id` / `req.q` 等
 * 几十个字段，重打包会丢掉未声明的键。类型化只发生在本层读取处。
 */
export interface ParsedRequest {
  readonly op: OpName;
  readonly kind: OpKind;
  readonly meta: OpMeta;
  /** 去空白后的靶标 id；空串/非字符串 → `null`。 */
  readonly engagement: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

function typeMatches(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "scalar":
      return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把一次请求体解析成 `ParsedRequest`。
 *
 * 刻意**不做**字段名白名单拒绝：资产库允许透传扩展字段（导入包、报表参数）。
 * 但**声明过的**字段类型必须对，否则会把 `{id: {}}` 一路送到 SQL 绑定处。
 */
export function parseRequest(input: unknown): Result<ParsedRequest, ParseFailure> {
  if (!isRecord(input)) {
    return err({ code: "missing_op", message: "request must be a JSON object", details: [] });
  }
  const rawOp = input["op"];
  const opText = typeof rawOp === "string" ? rawOp.trim() : "";
  if (opText === "") {
    return err({ code: "missing_op", message: "missing op", details: [] });
  }
  if (!isOpName(opText)) {
    return err({ code: "unknown_op", message: `unknown op: ${opText}`, op: opText, details: [] });
  }
  const meta = OP_TABLE[opText];
  const details: string[] = [];
  for (const [field, type] of Object.entries(meta.required)) {
    const value = input[field];
    if (value === undefined || value === null) {
      details.push(`missing required field: ${field} (${type})`);
      continue;
    }
    if (!typeMatches(value, type)) {
      details.push(`field ${field} must be ${type}, got ${describe(value)}`);
    }
  }
  for (const [field, type] of Object.entries(meta.optional)) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!typeMatches(value, type)) {
      details.push(`field ${field} must be ${type}, got ${describe(value)}`);
    }
  }
  if (details.length > 0) {
    return err({
      code: "invalid_payload",
      message: `invalid payload for ${opText}: ${details.join("; ")}`,
      op: opText,
      details,
    });
  }
  const rawEngagement = input["engagement"];
  const engagement = typeof rawEngagement === "string" && rawEngagement.trim() !== ""
    ? rawEngagement.trim()
    : null;
  return ok({ op: opText, kind: meta.kind, meta, engagement, raw: input });
}

/** 供错误文案用的值描述（不泄露大对象内容）。 */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** 读一个已声明的字符串字段（缺失 → `null`）。 */
export function fieldString(req: ParsedRequest, key: string): string | null {
  const value = req.raw[key];
  return typeof value === "string" ? value : null;
}

/** 读一个已声明的数字字段（缺失/非有限数 → `null`）。 */
export function fieldNumber(req: ParsedRequest, key: string): number | null {
  const value = req.raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 读一个已声明的布尔字段（缺失 → `null`，不是 false）。 */
export function fieldBoolean(req: ParsedRequest, key: string): boolean | null {
  const value = req.raw[key];
  return typeof value === "boolean" ? value : null;
}

/** 读一个未声明的任意字段（仍以 `unknown` 返回，调用点自行窄化）。 */
export function fieldUnknown(req: ParsedRequest, key: string): unknown {
  return req.raw[key];
}
