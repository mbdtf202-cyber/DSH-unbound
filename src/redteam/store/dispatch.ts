/**
 * 统一操作分发：CLI、HTTP 桥接、智能体工具共用同一套 op 词汇。
 *
 * 迁移自 dsh-qilin `store-core.js:739-895`。**同一套 op 词汇**是原项目最重要的
 * 一个决定：界面看到的、命令行验的、智能体写的是**同一条路径**。
 * 如果面板走一套、工具走另一套，"面板能看到的成果工具写不进去"这类问题会反复出现。
 *
 * ## 三条纪律（原注释记的线上故障，全部保留）
 *
 * 1. **没选靶标时不抛英文 `engagement required`**：提示词 op 回内置默认、
 *    只读查询回空结果。用户刚装好插件、一个靶标都没有时，面板要能打开。
 * 2. **写操作在没靶标时明确拒绝**（`请先在顶部选择或创建一个靶标`），
 *    用正则 `/^(add|save|update|delete|import|assess|open)/` 区分读写 ——
 *    漏一个前缀会让某个写操作静默变成 no-op。
 * 3. **未知 op 抛错**，不返回 `{ ok:true, items:[] }`：静默成功是最难查的一类 bug。
 *
 * ## 与上游的一处差异（有意）
 *
 * `platformAssignToolkit` 依赖 platform 层的 `assignToolkitFolder`。
 * 上游把它内联在 store-core 里；这里**只走 platform 层的唯一实现**，
 * 缺能力时明确报错而不是自己再写一份 —— 同一个能力有两份代码，
 * 就永远有一份不知道另一份修了什么。
 */
import { DEFAULT_PROMPTS } from "./data/prompts.js";
import { ROLE_TITLES, PLANNER_ROLE } from "./constants.js";
import { assignToolkitFolder, platformSummary, savePlatformConfig } from "../../platform/platform-config.js";
import type { RedteamStore } from "./store.js";

/** 一次分发的返回（可 JSON 序列化）。 */
export interface DispatchResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

/**
 * 合并返回体：与上游 `Object.assign({ ok: true }, result)` 语义一致 ——
 * **被展开对象的字段覆盖前面的 `ok`**。显式写出来，避免"重复 key"这类误读，
 * 也保住"某个方法自己回了 ok:false（例如 markPocUsed 找不到 POC）"这个行为。
 */
function merge(base: DispatchResult, extra: object): DispatchResult {
  /* 用 `Object.assign` 而不是展开：接口类型（没有 index signature）也能传进来，
     且语义与上游逐字一致。返回类型显式断言成 DispatchResult —— 这是安全的，
     因为 base 已带 `ok`，extra 只可能把它盖成另一个 boolean。 */
  return Object.assign({}, base, extra) as DispatchResult;
}

/**
 * 命中「写操作」前缀的 op 在缺少靶标时必须被拒绝。
 *
 * **必须与 `dispatch` 里实际的分支名对齐**：漏一个就会让某个写操作
 * 在"没有靶标"时静默变成空操作，而界面显示成功。
 */
const WRITE_OP_PREFIX = /^(add|save|update|delete|import|assess|open)/;

/** 不需要靶标就能跑的 op（知识库与平台适配是全局的）。 */
const GLOBAL_OPS = new Set<string>([
  "bootstrap", "openEngagement", "activateEngagement",
  "pocSearch", "pocList", "templateSearch", "templateStats", "pocGet", "pocSave",
  "pocUpdate", "pocDelete", "pocUse", "pocStats",
  "platformConfigGet", "platformConfigSave", "platformAssignToolkit",
]);

/** 分发上下文：除了 store 与请求，还允许注入"取当前靶标"的实现（便于测试）。 */
export interface DispatchContext {
  readonly store: RedteamStore;
  readonly req: Record<string, unknown>;
}

/** 从请求里取靶标 id（显式优先，否则当前靶标，再否则空串）。 */
function resolveEngagement(store: RedteamStore, req: Record<string, unknown>): string {
  const explicit = typeof req["engagement"] === "string" ? req["engagement"].trim() : "";
  if (explicit !== "") return explicit;
  return store.activeEngagementId() ?? "";
}

/** 无靶标时提示词 op 的返回（内置默认，不用建靶标就能看）。 */
function builtinPrompts(): DispatchResult {
  return {
    ok: true,
    builtin: true,
    roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({
      role,
      title,
      planner: role === PLANNER_ROLE,
      dispatcher: role !== PLANNER_ROLE,
      content: DEFAULT_PROMPTS[role] ?? "",
      updated_at: null,
    })),
  };
}

/** `assignToolkitFolder` 的最小类型形状（platform 层提供，不在此重复实现）。 */
interface ToolkitAssignment {
  readonly ok: boolean;
  readonly error?: string;
  readonly assigned?: Readonly<Record<string, string>>;
  readonly assignedCount?: number;
  readonly hits?: readonly unknown[];
  readonly scanned?: number;
  readonly dir?: string;
  readonly nucleiTemplatesDir?: string | null;
  readonly config?: unknown;
  readonly tools?: unknown;
  readonly adapt?: unknown;
}

/**
 * 执行一次分发。
 *
 * 失败一律收成 `{ ok: false, error }` —— 调用方（HTTP 桥、工具）都按这个形状解析，
 * 抛异常会让桥接层返回 500 而不是可读的错误。
 */
export function dispatch(store: RedteamStore, request: unknown = {}): DispatchResult {
  const req: Record<string, unknown> =
    request !== null && typeof request === "object" && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : {};
  const rawOp = req["op"];
  const op = typeof rawOp === "string" ? rawOp.trim() : "";
  try {
    if (op === "") return { ok: false, error: "missing op" };

    /* ── 全局 op：不需要靶标 ──────────────────────────────────────────── */
    if (op === "bootstrap") {
      const engagements = store.listEngagements();
      /* 优先沿用「当前靶标」指针，其次才是最近创建的靶标 */
      const active = store.activeEngagementId();
      const explicit = typeof req["engagement"] === "string" ? req["engagement"] : "";
      return {
        ok: true,
        root: store.root,
        engagements,
        current: explicit !== "" ? explicit : (active ?? engagements[0]?.id ?? null),
      };
    }
    if (op === "openEngagement") {
      return { ok: true, engagement: store.openEngagement(req["name"], req["scope"]) };
    }
    if (op === "activateEngagement") {
      const activated = store.setActiveEngagement(req["engagement"]);
      return { ok: activated, current: store.activeEngagementId() };
    }
    /* 知识库是全局的（跨靶标共享），所以这几个 op 不需要 engagement */
    if (op === "pocSearch") {
      const items = store.searchPocs(req);
      /* "现成的"有两层：本机沉淀的 POC/EXP + 本机 nuclei 模板库。一次返回，省一轮往返。 */
      const q = req["q"] ?? req["query"] ?? req["cve"] ?? req["component"] ?? "";
      const templates = q !== null && q !== undefined && String(q) !== ""
        ? store.searchTemplates(q, Math.min(Number(req["templateLimit"]) || 20, 100))
        : { dir: store.nucleiTemplatesDir(), total: store.templateStats().total, items: [] };
      return { ok: true, items, stats: store.pocStats(), templates, dbPath: store.knowledgePath(), root: store.root };
    }
    if (op === "pocList") {
      return { ok: true, items: store.searchPocs(req), stats: store.pocStats(), dbPath: store.knowledgePath(), root: store.root };
    }
    if (op === "templateSearch") {
      return merge({ ok: true }, store.searchTemplates(req["q"], Math.min(Number(req["limit"]) || 40, 200)));
    }
    if (op === "templateStats") return { ok: true, stats: store.templateStats() };
    if (op === "pocGet") return { ok: true, ...(store.getPoc(req["id"] !== undefined ? req["id"] : req["code"]) ?? {}) };
    if (op === "pocSave") return merge({ ok: true }, store.savePoc(req["poc"] ?? req));
    if (op === "pocUpdate") {
      return { ok: true, poc: store.updatePoc(req["id"] !== undefined ? req["id"] : req["code"], req["patch"] ?? req) };
    }
    if (op === "pocDelete") {
      return merge({ ok: true }, store.deletePoc(req["id"] !== undefined ? req["id"] : req["code"]));
    }
    if (op === "pocUse") {
      return merge({ ok: true }, store.markPocUsed(req["id"] !== undefined ? req["id"] : req["code"], req["used_on"]));
    }
    if (op === "pocStats") return { ok: true, stats: store.pocStats() };
    /* 环境适配：全局，不依赖靶标；面板 / CLI / 工具共用 */
    if (op === "platformConfigGet") return { ok: true, platform: platformSummary(store.root) };
    if (op === "platformConfigSave") {
      savePlatformConfig(req["config"] ?? {}, store.root);
      return { ok: true, platform: platformSummary(store.root) };
    }
    if (op === "platformAssignToolkit") {
      /* 走 platform 层的唯一实现。它现在返回结构化结果（含 ok:false + error），
         这里**原样透传 error** —— 用户需要看到"为什么拒绝"（例如空目录），
         不能被改写成通用失败。 */
      const assigned = assignToolkitFolder(req["dir"], store.root) as ToolkitAssignment;
      if (assigned.ok) {
        return {
          ok: true,
          assigned: assigned.assigned ?? {},
          assignedCount: assigned.assignedCount ?? 0,
          hits: assigned.hits ?? [],
          scanned: assigned.scanned ?? 0,
          dir: assigned.dir ?? "",
          nucleiTemplatesDir: assigned.nucleiTemplatesDir ?? null,
          config: assigned.config,
          tools: assigned.tools,
          adapt: assigned.adapt,
        };
      }
      return { ok: false, error: assigned.error ?? "分配工具文件夹失败（未给出原因）" };
    }

    /* ── 以下都需要靶标 ──────────────────────────────────────────────── */
    /* 没选靶标时：提示词回内置默认；只读查询回空结果。
       **不要抛英文 engagement required** —— 新装插件、一个靶标都没有时面板要能打开。 */
    const id = resolveEngagement(store, req);
    if (id === "") {
      if (GLOBAL_OPS.has(op)) return { ok: false, error: "内部错误：全局 op 不应走到这里" };
      if (op === "prompts") return builtinPrompts();
      if (WRITE_OP_PREFIX.test(op)) return { ok: false, error: "请先在顶部选择或创建一个靶标" };
      return { ok: true, items: [], total: 0, stats: null, segments: [], stages: [], roles: [] };
    }

    if (op === "snapshot") return merge({ ok: true }, store.snapshot(id));
    if (op === "assets") return merge({ ok: true }, store.listAssets(id, req));
    if (op === "asset") return { ok: true, asset: store.getAsset(id, req["id"]) };
    if (op === "graph") return merge({ ok: true }, store.graph(id, req));
    if (op === "attackGraph") return merge({ ok: true }, store.attackGraph(id, req));
    if (op === "stats") return { ok: true, stats: store.stats(id) };
    if (op === "vulns") return { ok: true, stats: store.vulnStats(id), ...store.listVulns(id, req) };
    if (op === "addVuln") return merge({ ok: true }, store.addVuln(id, req["vuln"] ?? req));
    if (op === "updateVuln") return merge({ ok: true }, store.updateVuln(id, req["id"], req["patch"] ?? req));
    if (op === "vulnStats") return { ok: true, stats: store.vulnStats(id) };
    if (op === "credentials") return { ok: true, items: store.listCredentials(id, req) };
    if (op === "addCredential") return merge({ ok: true }, store.addCredential(id, req["credential"] ?? req));
    if (op === "access") return { ok: true, items: store.listAccess(id, req) };
    if (op === "addAccess") return merge({ ok: true }, store.addAccess(id, req["access"] ?? req));
    if (op === "sessions") return merge({ ok: true }, store.sessionSummary(id));
    if (op === "webshells") return { ok: true, items: store.listWebshells(id, req) };
    if (op === "addWebshell") return merge({ ok: true }, store.addWebshell(id, req["webshell"] ?? req));
    if (op === "updateWebshell") return merge({ ok: true }, store.updateWebshell(id, req["id"], req["patch"] ?? req));
    if (op === "tunnels") return { ok: true, items: store.listTunnels(id, req) };
    if (op === "shots") return merge({ ok: true }, store.listShots(id, req));
    if (op === "shotAdd") return merge({ ok: true }, store.addShot(id, req["shot"] ?? req));
    if (op === "shotDelete") return merge({ ok: true }, store.deleteShot(id, req["id"] !== undefined ? req["id"] : req["shot_id"]));
    if (op === "shotData") return merge({ ok: true }, store.readShot(id, req["id"] !== undefined ? req["id"] : req["shot_id"]));
    if (op === "addTunnel") return merge({ ok: true }, store.addTunnel(id, req["tunnel"] ?? req));
    if (op === "updateTunnel") return merge({ ok: true }, store.updateTunnel(id, req["id"], req["patch"] ?? req));
    if (op === "domains") return { ok: true, items: store.domainIndex(id, req) };
    if (op === "web") return merge({ ok: true }, store.listWeb(id, req));
    if (op === "httpEvidence") return { ok: true, items: store.listHttpEvidence(id, req) };
    if (op === "addHttpEvidence") return merge({ ok: true }, store.addHttpEvidence(id, req["evidence"] ?? req));
    if (op === "chain") return { ok: true, items: store.listChain(id) };
    if (op === "addChainStep") return merge({ ok: true }, store.addChainStep(id, req["step"] ?? req));
    if (op === "report") return merge({ ok: true }, store.report(id));
    if (op === "assetTest") return merge({ ok: true }, store.updateAssetTest(id, req["test"] ?? req));
    if (op === "assessAsset") return merge({ ok: true }, store.assessAsset(id, req["assess"] ?? req));
    if (op === "scores") return merge({ ok: true }, store.listScorePoints(id, req));
    if (op === "saveScorePoint") return merge({ ok: true }, store.saveScorePoint(id, req["point"] ?? req));
    if (op === "deleteScorePoint") return merge({ ok: true }, store.deleteScorePoint(id, req["id"]));
    if (op === "addScoreHit") return merge({ ok: true }, store.addScoreHit(id, req["hit"] ?? req));
    if (op === "scoreChain") return merge({ ok: true }, store.scoreChain(id, req));
    if (op === "scoreReport") return merge({ ok: true }, store.scoreReport(id, req));
    if (op === "activeTests") return merge({ ok: true }, store.activeTests(id, req));
    if (op === "testStats") return { ok: true, stats: store.testStats(id) };
    /* 控制台页签的未读指针（每个页签的条数 + 最近更新时间）：面板据此点红点 */
    if (op === "consoleDigest") return merge({ ok: true }, store.consoleDigest(id));
    if (op === "stages") return { ok: true, items: store.listStages(id) };
    if (op === "saveStage") return merge({ ok: true }, store.saveStage(id, req["stage"] ?? req));
    if (op === "reportTargets") return merge({ ok: true }, store.reportTargets(id, req));
    /* 资产发现时间线：资产测绘页的「发现时间」视图 + 报告附录共用 */
    if (op === "discoveryTimeline") return merge({ ok: true }, store.discoveryTimeline(id, req));
    if (op === "attackFiles") return { ok: true, items: store.attackFileTree(id) };
    if (op === "addAttackFile") return merge({ ok: true }, store.addAttackFile(id, req["file"] ?? req));
    if (op === "readAttackFile") return { ok: true, ...(store.readAttackFile(id, req["id"]) ?? {}) };
    if (op === "import") return merge({ ok: true }, store.importBundle(id, req));
    if (op === "prompts") return { ok: true, roles: store.listPrompts(id) };
    if (op === "savePrompt") return merge({ ok: true }, store.savePrompt(id, req["role"], req["content"]));
    if (op === "resetPrompts") return merge({ ok: true }, store.resetPrompts(id, req["role"]));
    /* 未知 op 必须报错：静默成功是最难查的一类 bug */
    throw new Error(`unknown op: ${op}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: message };
  }
}

/**
 * 异步分发：只多一条 `probeSessions`（需要真实发起网络连接），其余转发给同步 dispatch。
 * 智能体的沙箱里连不出去，所以在 host 侧做连通性实测。
 */
export async function dispatchAsync(store: RedteamStore, request: unknown = {}): Promise<DispatchResult> {
  const req: Record<string, unknown> =
    request !== null && typeof request === "object" && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : {};
  if (req["op"] === "probeSessions") {
    try {
      const id = resolveEngagement(store, req);
      if (id === "") return { ok: true, items: [], note: "还没有靶标" };
      const result = await store.probeSessions(id, req);
      return merge({ ok: true }, result);
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return dispatch(store, req);
}

/** 全部已实现的 op（面板/工具用它核对"我发的 op 后端是否认识"）。 */
export const KNOWN_OPS: readonly string[] = [
  "bootstrap", "openEngagement", "activateEngagement",
  "pocSearch", "pocList", "templateSearch", "templateStats", "pocGet", "pocSave",
  "pocUpdate", "pocDelete", "pocUse", "pocStats",
  "platformConfigGet", "platformConfigSave", "platformAssignToolkit",
  "snapshot", "assets", "asset", "graph", "attackGraph", "stats",
  "vulns", "addVuln", "updateVuln", "vulnStats",
  "credentials", "addCredential", "access", "addAccess", "sessions",
  "webshells", "addWebshell", "updateWebshell", "tunnels", "addTunnel", "updateTunnel",
  "shots", "shotAdd", "shotDelete", "shotData",
  "domains", "web", "httpEvidence", "addHttpEvidence",
  "chain", "addChainStep", "report", "assetTest", "assessAsset",
  "scores", "saveScorePoint", "deleteScorePoint", "addScoreHit", "scoreChain", "scoreReport",
  "activeTests", "testStats", "consoleDigest", "stages", "saveStage", "reportTargets",
  "discoveryTimeline", "attackFiles", "addAttackFile", "readAttackFile",
  "import", "prompts", "savePrompt", "resetPrompts",
  "probeSessions",
];
