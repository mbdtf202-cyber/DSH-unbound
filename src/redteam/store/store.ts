/**
 * RedTeam 事实库。
 *
 * 迁移自 dsh-qilin `lib/redteam/store-core.js`（5,385 行 / 92 个方法 / 72 个 op）。
 * 分工、迁移纪律见文件头注释的姊妹篇（`store-part2` 起为各功能域）。
 *
 * **SQL 一律照抄上游**：包括 `COALESCE` 的嵌套写法、`ORDER BY` 的多级排序、
 * `CASE` 分桶顺序。重写 SQL 是"排序悄悄变"这类漂移的唯一来源，
 * 迁移期不做这种优化。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { connect as tcpConnect } from "node:net";

import { openTypedDb, placeholders } from "./sqlite.js";
import type { TypedDb, TypedStatement } from "./sqlite.js";
import {
  DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, HAS_FTS5,
  migrate, migrateKnowledge, SCOPE_SQL, POC_CATEGORIES, pocCategoryName,
} from "./schema.js";
import { readMeta, writeMeta, metaList, metaString } from "./meta.js";
import type { EngagementMeta } from "./meta.js";
import {
  evaluateScoreBoard, hitPointsOf, normalizePort, parseRowCount, parseTargetPort,
  scoreCapReasonText, scoreMetaFromRow, scoreMultiplierOf, serviceLabel, scoreStageOf, targetKey,
  SENSITIVE_DATA_MIN_ROWS, formatRows, tunnelIsLegit, TUNNEL_ENTRY_KINDS,
  type ScoreMeta, type ScoredHit,
} from "./score.js";
import { cidrOf, ipToInt, nowIso, scopeOfIp, slugify, slugTarget, slugPoc, defaultPocFilename } from "../../platform/ip-utils.js";
import { assertPathWithin, normalizeShellStatus, normalizeShellType } from "../../platform/validate.js";
import { loadPlatformConfig, nucleiTemplatesDirOf } from "../../platform/platform-config.js";
import { parseTarget, parseCurl, commandKind, buildHttpRequest, buildCurlCommand, fillTemplate } from "./replay.js";
import { DEFAULT_STAGES, POINT_SHORT_NAME, LEGACY_STAGE_MAP, VALID_STAGE_CODES } from "./data/stages.js";
import { DEFAULT_PROMPTS } from "./data/prompts.js";
import { DEFAULT_SCORE_POINTS, SCORE_GROUPS, scoreConfirmOf } from "./data/score-points.js";
import {
  ROLE_TITLES, ROLE_ORDER, PLANNER_ROLE, SEVERITIES, VULN_STATUSES, POC_KINDS, POC_SOURCES,
  VALID_TEST_STATUSES, VALID_PRIORITIES, TUNNEL_STATUSES, ATTACK_FILE_KINDS,
} from "./constants.js";
import type {
  AccessSessionRow, AssetNameRow, AssetRow, AttackFileRow, AttackStepRow, CredentialRow,
  FingerprintRow, HttpEvidenceRow, ObservationRow, PocRow, PortRow, ScanRunRow, ScoreHitRow,
  ScorePointRow, SegmentRow, ServiceRow, ShotRow, StageRow, TableName, TableRowMap, TunnelRow,
  VulnRow, WebshellRow,
} from "./types.js";
import type {
  AssetDetail, AssetListResult, AssetFingerprintView, AssetNameView, AssetPortView, AssetView, ChainItem, ChainStage,
  ConsoleDigest, DigestSection, EngagementSummary, GraphEdge, GraphNode, GraphResult, HitTrace,
  OpenedEngagement, PocListItem, PocStats, ProbeResult, PromptRefresh, PromptRole, ReportItem,
  ReportRequest, ReportStage, ReportSummary, ReportTarget, ReportTargets, ScoreBoard, ScoreChain,
  ScoreHitAdded, ScoreHitView, ScorePointSaved, ScorePointView, ScoreReport, ScoreRuleGroup,
  ScoreSummary, SessionSummary, ShotBrief, ShotListItem, StageView, TargetStats, TemplateHit,
  TemplateSearch, TemplateStats, TestStats, TracedAccess, TracedCredential, TracedShell,
  TracedStep, TracedTunnel, TracedVuln, TunnelView, VulnReport, VulnStats, WebshellView, WebRow,
} from "./views.js";

/* ══════════════════════════════════════════════════════════════ 窄化助手 */

/**
 * 入参窄化：把 `unknown` 变成"可安全读字段的对象"。
 *
 * 原实现所有方法都是 `(id, x = {})`，`x` 是什么完全靠调用方自觉 ——
 * 智能体传 `null`、传字符串、传数组都能走到 `x.field` 那一行然后抛 TypeError。
 * 这里统一收成"非对象一律当空对象"，与 `x = {}` 的默认语义一致。
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

/** 取字符串（缺失/非字符串 → fallback）。 */
function str(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

/** 取可空字符串（空串视为 null，与上游 `x ?? null` 的落库语义一致）。 */
function nullableStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 取可空整数。 */
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 取整数（缺失/非法 → fallback）。 */
function intOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 取布尔（真值语义与上游 `x === true || x === 1 || x === '1'` 对齐处单独处理）。 */
function boolish(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** 安全解析 JSON 列（坏数据回退默认值，与上游 `parseJson` 等价）。 */
function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/**
 * 把「通过这个漏洞拿到了什么」规范化成一行短标签：数组或分隔串 → 「A、B」。
 * 上游同样在这里做归一：null/undefined → null，空数组 → null。
 */
function normGained(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const parts: unknown[] = Array.isArray(value) ? value : String(value).split(/[,;，；]/);
  const out = parts.map((x) => String(x).trim()).filter(Boolean);
  return out.length > 0 ? out.join("、") : null;
}

/* ══════════════════════════════════════════════════════════════ 图片尺寸 */

/** 图片尺寸（读不出时两个字段都是 null）。 */
export interface ImageSize {
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * 从图片字节里读出尺寸（PNG / JPEG / WebP），读不出返回 `{ width: null, height: null }`。
 *
 * 只为了在面板与报告里标"这张图多大"以及防止把 0 字节文件当截图收进来 ——
 * **不值得为它引一个图像库**（本包刻意保持零外部依赖）。
 */
export function pngSize(buf: Uint8Array): ImageSize {
  try {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (b.length > 24 && b.subarray(1, 4).toString("latin1") === "PNG") {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = b[i + 1] ?? 0;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
    if (b.length > 30 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
      const fmt = b.subarray(12, 16).toString("latin1");
      if (fmt === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (fmt === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    /* 尺寸读不出不影响入库 */
  }
  return { width: null, height: null };
}

/* ══════════════════════════════════════════════════════════════ Store */

/**
 * 红队事实库。
 *
 * **零宿主依赖**：只用 `node:` 内置模块。这样命令行、插件、测试三方共用同一实现，
 * 也避免 profile 下解析不到 `node_modules`。
 */
export class RedteamStore {
  /** 数据根目录（`$DSH_HOME/redteam` 或显式配置）。 */
  readonly root: string;
  /** 靶标目录：`<root>/engagements`。 */
  readonly engagementsDir: string;
  /** 已打开的库句柄，按靶标 id 缓存。 */
  private readonly handles = new Map<string, TypedDb>();
  /** 全局知识库句柄（跨靶标共享）。 */
  private kbHandle: TypedDb | null = null;
  /** `asset_fts` 是否存在的按句柄缓存（见 `hasFtsTable`）。 */
  private readonly ftsTableCache = new WeakMap<TypedDb, boolean>();

  /** @param root 数据根目录。 */
  constructor(root: string) {
    this.root = root;
    this.engagementsDir = join(root, "engagements");
    mkdirSync(this.engagementsDir, { recursive: true });
  }

  /* ---------- 当前靶标 ---------- */

  /** 「当前靶标」指针文件路径。 */
  currentPath(): string {
    return join(this.root, "current");
  }

  /**
   * 当前生效的靶标 id：显式指针优先，否则最近创建的靶标。
   *
   * 指针文件里写的是裸 id；**必须校验对应的库文件还在**，
   * 否则靶标目录被删掉之后指针会把所有操作导向一个不存在的靶标。
   */
  activeEngagementId(): string | undefined {
    try {
      const raw = readFileSync(this.currentPath(), "utf8").trim();
      if (raw !== "" && existsSync(this.dbPathOf(raw))) return raw;
    } catch {
      /* 无指针时回退 */
    }
    const list = this.listEngagements();
    return list.length > 0 ? list[0]?.id : undefined;
  }

  /** 切换当前靶标（界面切换或智能体绑定时调用）。 */
  setActiveEngagement(id: unknown): boolean {
    const target = typeof id === "string" ? id : "";
    if (target === "" || !existsSync(this.dbPathOf(target))) return false;
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.currentPath(), target, "utf8");
    return true;
  }

  /* ---------- 路径 ---------- */

  dirOf(id: string): string {
    return join(this.engagementsDir, id);
  }
  metaPathOf(id: string): string {
    return join(this.dirOf(id), "engagement.yaml");
  }
  dbPathOf(id: string): string {
    return join(this.dirOf(id), "assets.db");
  }
  promptsDirOf(id: string): string {
    return join(this.dirOf(id), "agents");
  }
  shotsDirOf(id: string): string {
    return join(this.dirOf(id), "shots");
  }
  attackFilesDirOf(id: string): string {
    return join(this.dirOf(id), "attack-files");
  }
  knowledgePath(): string {
    return join(this.root, "knowledge.db");
  }
  pocsDirOf(): string {
    return join(this.root, "pocs");
  }

  /* ---------- 数据库句柄 ---------- */

  /**
   * 打开（或按需创建）某个靶标的数据库句柄。
   *
   * @param options `{ create: true }` 时允许新建库文件（`openEngagement` 用）。
   *   不给 create 又不存在 → 抛 `engagement not found`（**不是静默新建**：
   *   打错靶标 id 时静默建一个空库，比报错难查得多）。
   */
  db(id: string, options: { readonly create?: boolean } = {}): TypedDb {
    const cached = this.handles.get(id);
    if (cached !== undefined) return cached;
    if (!existsSync(this.dbPathOf(id))) {
      if (options.create !== true) throw new Error(`engagement not found: ${id}`);
      mkdirSync(this.dirOf(id), { recursive: true });
    }
    const handle = openTypedDb(this.dbPathOf(id));
    /* FTS5 缺席的 Node 构建（如 22.14）上**不能**带上 fts5 建表语句：
       一句 `USING fts5` 抛错会把整份 DDL 一起带崩，连普通表都建不出来。
       降级后 asset 检索走 LIKE（见 listAssets 的 f.q 分支）。 */
    handle.exec(HAS_FTS5 ? DDL + ASSET_FTS_DDL : DDL);
    migrate(handle);
    if (HAS_FTS5) this.ensureFtsBackfill(handle);
    this.handles.set(id, handle);
    return handle;
  }

  /** 关闭全部句柄（插件 unload 时由 effect 调用）。 */
  close(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.close();
      } catch {
        /* 关闭失败不阻断卸载 */
      }
    }
    this.handles.clear();
    if (this.kbHandle !== null) {
      try {
        this.kbHandle.close();
      } catch {
        /* 忽略 */
      }
      this.kbHandle = null;
    }
  }

  /* ---------- 靶标生命周期 ---------- */

  /**
   * 列出全部靶标（按创建时间倒序）。
   *
   * 库损坏时**仍然列出靶标**（`stats` 置 null）：一个坏靶标不该让整个列表消失，
   * 否则用户连"打开它去修"的入口都没有。
   */
  listEngagements(): EngagementSummary[] {
    mkdirSync(this.engagementsDir, { recursive: true });
    const out: EngagementSummary[] = [];
    for (const entry of readdirSync(this.engagementsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const meta = readMeta(this.metaPathOf(id)) ?? {};
      let stats: TargetStats | null = null;
      try {
        if (existsSync(this.dbPathOf(id))) stats = this.stats(id);
      } catch {
        /* 库损坏时仍列出靶标 */
      }
      out.push({
        id,
        name: metaString(meta, "target_name", id),
        scope: metaList(meta, "scope_cidrs"),
        status: metaString(meta, "status", "active"),
        created_at: metaString(meta, "created_at", "") || null,
        stats,
      });
    }
    return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  /**
   * 打开/创建一个靶标工作区。
   *
   * @param options `{ bindCurrent?: boolean }`：是否同时把全局「当前靶标」指针指过来。
   *   默认 true（界面/命令行语义）；**智能体工具要传 false** —— 多会话并行时，
   *   让某个会话 open 一个靶标就改掉全局指针，是"报告被写串"的直接原因。
   */
  openEngagement(name: unknown, scope: unknown, options: unknown = {}): OpenedEngagement {
    const targetName = str(name, "");
    const id = slugify(targetName);
    mkdirSync(this.dirOf(id), { recursive: true });
    for (const sub of ["agents", "runs", "reports"]) mkdirSync(join(this.dirOf(id), sub), { recursive: true });
    const existing = readMeta(this.metaPathOf(id));
    const scopeList = Array.isArray(scope)
      ? scope.filter((x): x is string => typeof x === "string")
      : (existing !== undefined ? [...metaList(existing, "scope_cidrs")] : []);
    writeMeta(this.metaPathOf(id), {
      target_name: targetName,
      scope_cidrs: scopeList,
      status: "active",
      created_at: (existing !== undefined ? metaString(existing, "created_at", "") : "") || nowIso(),
      updated_at: nowIso(),
    });
    this.db(id, { create: true }); // 建库 + 建表
    this.seedScorePoints(id);
    for (const p of this.listPrompts(id)) {
      if (p.content === "") this.savePrompt(id, p.role, DEFAULT_PROMPTS[p.role] ?? "");
    }
    const opts = asRecord(options);
    if (opts["bindCurrent"] !== false) this.setActiveEngagement(id);
    return { id, name: targetName, scope: scopeList };
  }

  /**
   * 资产发现时间线：按"哪一天发现了多少、最近发现了哪些"聚合。
   * 资产测绘页用它回答"这条是什么时候发现的"，报告附录用它做收口时间线。
   */
  discoveryTimeline(id: string, f: unknown = {}): {
    readonly days: readonly { readonly day: string; readonly assets: number; readonly internal: number | null; readonly external: number | null }[];
    readonly recent: readonly (AssetRow & { readonly scope: string | null; readonly open_ports: number })[];
    readonly span: { readonly first: string | null; readonly last: string | null; readonly total: number };
  } {
    const db = this.db(id);
    const fo = asRecord(f);
    const limit = Math.min(Number(fo["limit"]) || 50, 500);
    const days = db
      .prepare<{ day: string | null; assets: number; internal: number | null; external: number | null }>(
        `SELECT substr(COALESCE(discovered_at, first_seen, ''), 1, 10) AS day,
        COUNT(*) AS assets,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'internal' THEN 1 ELSE 0 END) AS internal,
        SUM(CASE WHEN COALESCE(scope, (${SCOPE_SQL})) = 'external' THEN 1 ELSE 0 END) AS external
      FROM asset GROUP BY day ORDER BY day DESC`,
      )
      .all();
    const recent = db
      .prepare<AssetRow & { scope: string | null; open_ports: number }>(
        `SELECT id, ip, segment_cidr, state, primary_name, discovered_at, first_seen, last_seen,
        COALESCE(scope, (${SCOPE_SQL})) AS scope, priority,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = asset.id AND p.state = 'open') AS open_ports
      FROM asset ORDER BY COALESCE(discovered_at, first_seen, '') DESC, id DESC LIMIT ?`,
      )
      .all(limit);
    const span = db
      .prepare<{ first: string | null; last: string | null; total: number }>(
        `SELECT MIN(COALESCE(discovered_at, first_seen)) AS first,
        MAX(COALESCE(discovered_at, first_seen)) AS last, COUNT(*) AS total FROM asset`,
      )
      .get() ?? { first: null, last: null, total: 0 };
    return {
      days: days.map((d) => ({ ...d, day: d.day !== null && d.day !== "" ? d.day : "(未知时间)" })),
      recent,
      span: { first: span.first ?? null, last: span.last ?? null, total: span.total || 0 },
    };
  }

  /* ---------- 统计 ---------- */

  /** 一屏计数。`one()` 取第一列（上游同样按 `Object.values(...)[0]` 取）。 */
  stats(id: string): TargetStats {
    const db = this.db(id);
    const one = (sql: string): number => {
      const row = db.prepare<Record<string, number | null>>(sql).get();
      if (row === undefined) return 0;
      const first = Object.values(row)[0];
      return Number(first ?? 0);
    };
    return {
      segments: one("SELECT COUNT(*) FROM segment"),
      assets: one("SELECT COUNT(*) FROM asset"),
      liveAssets: one("SELECT COUNT(*) FROM asset WHERE state = 'live'"),
      openPorts: one("SELECT COUNT(*) FROM port WHERE state = 'open'"),
      services: one("SELECT COUNT(*) FROM service"),
      fingerprints: one("SELECT COUNT(*) FROM fingerprint"),
      passiveSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'passive'"),
      activeSignals: one("SELECT COUNT(*) FROM observation WHERE provenance = 'active'"),
      vulns: one("SELECT COUNT(*) FROM vuln"),
      credentials: one("SELECT COUNT(*) FROM credential"),
      accesses: one("SELECT COUNT(*) FROM access_session"),
      untestedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, 'untested') = 'untested'"),
      blockedAssets: one("SELECT COUNT(*) FROM asset WHERE COALESCE(test_status, '') = 'blocked' OR blocked_count > 0"),
    };
  }

  /**
   * 控制台「未读」摘要：每个页签给一个「条数 + 最近一条时间」的轻量指针。
   *
   * 面板拿它跟本地记住的上次查看状态比：有新条数、或最新时间晚于上次查看，就在页签上点红点。
   * **只读、只数数**，不做任何重活 —— 它被轮询调用。
   */
  consoleDigest(id: string): ConsoleDigest {
    const db = this.db(id);
    const count = (sql: string): number => {
      try {
        const row = db.prepare<{ n: number | null }>(sql).get();
        return Number(row?.n ?? 0) || 0;
      } catch {
        return 0;
      }
    };
    const at = (sql: string): string | null => {
      try {
        const row = db.prepare<{ t: string | null }>(sql).get();
        return row?.t ?? null;
      } catch {
        return null;
      }
    };
    const maxOf = (a: string | null, b: string | null): string | null =>
      a === null ? b : (b === null ? a : (a > b ? a : b));
    /* 知识库是跨靶标共享的另一个库：拿不到就当作 0，不影响其它页签 */
    let kb: DigestSection = { count: 0, at: null };
    try {
      const k = this.kb();
      kb = {
        count: Number(k.prepare<{ n: number | null }>("SELECT COUNT(*) AS n FROM poc").get()?.n ?? 0),
        at: k.prepare<{ t: string | null }>("SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM poc").get()?.t ?? null,
      };
    } catch {
      /* 知识库还没建：视为无更新 */
    }
    const hits = "SELECT COUNT(*) AS n FROM score_hit";
    const hitsAt = "SELECT MAX(recorded_at) AS t FROM score_hit";
    const steps = "SELECT COUNT(*) AS n FROM attack_step";
    const stepsAt = "SELECT MAX(recorded_at) AS t FROM attack_step";
    const sections: Record<string, DigestSection> = {
      assets: {
        count: count("SELECT COUNT(*) AS n FROM asset"),
        at: at("SELECT MAX(COALESCE(discovered_at, first_seen, last_seen)) AS t FROM asset"),
      },
      testing: {
        count: count("SELECT COUNT(*) AS n FROM asset WHERE COALESCE(test_status, 'untested') <> 'untested'"),
        at: at("SELECT MAX(test_updated_at) AS t FROM asset"),
      },
      /* 「智能体」页签看的是"谁在执行"：用攻击步骤的最新动作当指针 */
      agents: { count: count(steps), at: at(stepsAt) },
      sessions: {
        count: count("SELECT COUNT(*) AS n FROM webshell") + count("SELECT COUNT(*) AS n FROM tunnel"),
        at: maxOf(
          at("SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM webshell"),
          at("SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM tunnel"),
        ),
      },
      findings: {
        count: count("SELECT COUNT(*) AS n FROM vuln"),
        at: at("SELECT MAX(found_at) AS t FROM vuln"),
      },
      chain: { count: count(steps), at: at(stepsAt) },
      scores: { count: count(hits), at: at(hitsAt) },
      report: { count: count(hits), at: at(hitsAt) },
      attackfiles: {
        count: count("SELECT COUNT(*) AS n FROM attack_file"),
        at: at("SELECT MAX(created_at) AS t FROM attack_file"),
      },
      knowledge: kb,
      /* 提示词与技能库是随包分发的静态内容：没有"新条目"一说，永不点红点 */
      prompts: { count: 0, at: null },
      skills: { count: 0, at: null },
    };
    return { engagement: id, at: nowIso(), sections };
  }

  /** 一次拿全"打开靶标时首屏要的一切"。 */
  snapshot(id: string): {
    readonly engagement: { readonly id: string; readonly name: string; readonly scope: readonly string[]; readonly status: string; readonly created_at: string | null };
    readonly stats: TargetStats;
    readonly tests: TestStats;
    readonly segments: readonly (SegmentRow & { readonly assets: number; readonly live: number; readonly open_ports: number; readonly passive_ports: number; readonly active_ports: number; readonly scope: string })[];
  } {
    const meta = readMeta(this.metaPathOf(id)) ?? {};
    return {
      engagement: {
        id,
        name: metaString(meta, "target_name", id),
        scope: metaList(meta, "scope_cidrs"),
        status: metaString(meta, "status", "active"),
        created_at: metaString(meta, "created_at", "") || null,
      },
      stats: this.stats(id),
      tests: this.testStats(id),
      segments: this.listSegments(id),
    };
  }

  /** C 段列表（含资产/端口计数与内外网归属）。 */
  listSegments(id: string): readonly (SegmentRow & {
    readonly assets: number;
    readonly live: number;
    readonly open_ports: number;
    readonly passive_ports: number;
    readonly active_ports: number;
    readonly scope: string;
  })[] {
    const rows = this.db(id)
      .prepare<SegmentRow & { assets: number; live: number; open_ports: number; passive_ports: number; active_ports: number }>(
        `SELECT s.cidr, s.org, s.asn, s.country, s.city, s.source,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr) AS assets,
        (SELECT COUNT(*) FROM asset a WHERE a.segment_cidr = s.cidr AND a.state = 'live') AS live,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'passive') AS passive_ports,
        (SELECT COUNT(*) FROM port p JOIN asset a ON a.id = p.asset_id WHERE a.segment_cidr = s.cidr AND p.provenance = 'active') AS active_ports
      FROM segment s ORDER BY assets DESC, s.cidr`,
      )
      .all();
    /* C 段也分内外网：按网段起始地址归属判定 */
    return rows.map((r) => ({ ...r, scope: scopeOfIp(String(r.cidr ?? "").split("/")[0] ?? "") }));
  }

  /* ---------- 资产 ---------- */

  /**
   * 把一组资产的 ports / fingerprints / names **一次查完**，按 asset_id 分组返回。
   *
   * 为什么需要：`assetRow` 原本对每个资产各跑 3 条查询，而资产列表默认 `limit=400` ——
   * 一次列表请求就是 1200 条 SQL，而面板每次改筛选条件都会重查。
   * 这里改成 3 条 `IN (...)` 查询，成本与**资产数无关**。
   */
  assetChildren(db: TypedDb, ids: readonly unknown[] = []): {
    readonly ports: ReadonlyMap<number, readonly AssetPortView[]>;
    readonly fingerprints: ReadonlyMap<number, readonly AssetFingerprintView[]>;
    readonly names: ReadonlyMap<number, readonly AssetNameView[]>;
  } {
    const ports = new Map<number, AssetPortView[]>();
    const fingerprints = new Map<number, AssetFingerprintView[]>();
    const names = new Map<number, AssetNameView[]>();
    const list = Array.from(new Set(ids.filter((x) => x !== null && x !== undefined).map((x) => Number(x))))
      .filter((n) => Number.isFinite(n));
    if (list.length === 0) return { ports, fingerprints, names };
    const ph = placeholders(list.length);
    for (const row of db
      .prepare<AssetPortView & { asset_id: number }>(
        `SELECT p.asset_id, p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
        s.name AS service, s.product, s.version
      FROM port p LEFT JOIN service s ON s.port_id = p.id
      WHERE p.asset_id IN (${ph}) ORDER BY p.asset_id, p.port`,
      )
      .all(...list)) {
      const key = Number(row.asset_id);
      const bucket = ports.get(key);
      if (bucket === undefined) ports.set(key, [row]);
      else bucket.push(row);
    }
    for (const row of db
      .prepare<AssetFingerprintView & { asset_id: number }>(
        `SELECT asset_id, category, vendor, product, version, evidence, provenance
      FROM fingerprint WHERE asset_id IN (${ph}) ORDER BY asset_id, id`,
      )
      .all(...list)) {
      const key = Number(row.asset_id);
      const bucket = fingerprints.get(key);
      if (bucket === undefined) fingerprints.set(key, [row]);
      else bucket.push(row);
    }
    for (const row of db
      .prepare<AssetNameView & { asset_id: number }>(
        `SELECT asset_id, name, kind, provenance
      FROM asset_name WHERE asset_id IN (${ph}) ORDER BY asset_id, id`,
      )
      .all(...list)) {
      const key = Number(row.asset_id);
      const bucket = names.get(key);
      if (bucket === undefined) names.set(key, [row]);
      else bucket.push(row);
    }
    return { ports, fingerprints, names };
  }

  /**
   * 单个资产 → 行结构。
   *
   * @param children 可选：`assetChildren()` 的预取结果。**传了就零额外查询**；
   *                 不传则退回单资产查询（详情页只用一次，N+1 无影响）。
   */
  assetRow(
    db: TypedDb,
    a: AssetRow,
    children: {
      readonly ports: ReadonlyMap<number, readonly AssetPortView[]>;
      readonly fingerprints: ReadonlyMap<number, readonly AssetFingerprintView[]>;
      readonly names: ReadonlyMap<number, readonly AssetNameView[]>;
    } | null = null,
  ): AssetView {
    let ports: readonly AssetPortView[];
    let fingerprints: readonly AssetFingerprintView[];
    let names: readonly AssetNameView[];
    if (children !== null) {
      const key = Number(a.id);
      ports = children.ports.get(key) ?? [];
      fingerprints = children.fingerprints.get(key) ?? [];
      names = children.names.get(key) ?? [];
    } else {
      ports = db
        .prepare<AssetPortView>(
          `SELECT p.port, p.proto, p.state, p.provenance, p.banner, p.url, p.title,
          s.name AS service, s.product, s.version
        FROM port p LEFT JOIN service s ON s.port_id = p.id
        WHERE p.asset_id = ? ORDER BY p.port`,
        )
        .all(a.id);
      fingerprints = db
        .prepare<AssetFingerprintView>(
          "SELECT category, vendor, product, version, evidence, provenance FROM fingerprint WHERE asset_id = ?",
        )
        .all(a.id);
      names = db
        .prepare<AssetNameView>("SELECT name, kind, provenance FROM asset_name WHERE asset_id = ?")
        .all(a.id);
    }
    const testStatus = (VALID_TEST_STATUSES as readonly string[]).includes(a.test_status ?? "untested")
      ? ((a.test_status ?? "untested") as "untested")
      : "untested";
    return {
      id: a.id,
      ip: a.ip,
      segment_cidr: a.segment_cidr,
      state: a.state,
      primary_name: a.primary_name,
      first_seen: a.first_seen,
      last_seen: a.last_seen,
      /* discovered_at 回落到 first_seen：老库没有 discovered_at 时不能让面板显示空白 */
      discovered_at: a.discovered_at !== null && a.discovered_at !== "" ? a.discovered_at : (a.first_seen ?? null),
      test_status: testStatus,
      test_notes: a.test_notes ?? "",
      test_surface: a.test_surface ?? "",
      test_updated_at: a.test_updated_at ?? null,
      test_updated_by: a.test_updated_by ?? null,
      blocked_count: a.blocked_count ?? 0,
      priority: a.priority ?? null,
      potential: a.potential ?? "",
      assess_reason: a.assess_reason ?? "",
      assessed_at: a.assessed_at ?? null,
      assessed_by: a.assessed_by ?? null,
      scope: a.scope === "internal" || a.scope === "external" ? a.scope : scopeOfIp(a.ip),
      open_ports: ports.filter((p) => p.state === "open").length,
      ports,
      fingerprints,
      names,
      passive: ports.filter((p) => p.provenance === "passive").length,
      active: ports.filter((p) => p.provenance === "active").length,
    };
  }

  /**
   * 资产列表（支持 C 段/状态/IP/端口/服务/指纹/来源/优先级/测试状态/内外网/全文检索）。
   *
   * 排序口径见 `sort` 分支：默认 `priority`（最该打的排前面）。
   * **`ORDER BY` 的子句顺序不能动** —— 它决定同优先级内谁在前，
   * 面板与导出的排序都依赖它。
   */
  listAssets(id: string, f: unknown = {}): AssetListResult {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    const push = (...vs: readonly unknown[]): void => {
      for (const v of vs) args.push(v);
    };
    if (fo["cidr"]) {
      where.push("a.segment_cidr = ?");
      push(fo["cidr"]);
    }
    if (fo["state"]) {
      where.push("a.state = ?");
      push(fo["state"]);
    }
    if (fo["ip"]) {
      where.push("a.ip = ?");
      push(fo["ip"]);
    }
    if (fo["port"]) {
      where.push("EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.port = ?)");
      push(Number(fo["port"]));
    }
    if (fo["service"]) {
      where.push("EXISTS (SELECT 1 FROM port p JOIN service s ON s.port_id = p.id WHERE p.asset_id = a.id AND (s.name LIKE ? OR s.product LIKE ?))");
      push(`%${str(fo["service"], "")}%`, `%${str(fo["service"], "")}%`);
    }
    if (fo["fingerprint"]) {
      where.push("EXISTS (SELECT 1 FROM fingerprint fp WHERE fp.asset_id = a.id AND (fp.product LIKE ? OR fp.vendor LIKE ? OR fp.category LIKE ?))");
      const q = `%${str(fo["fingerprint"], "")}%`;
      push(q, q, q);
    }
    if (fo["provenance"]) {
      where.push("EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)");
      push(fo["provenance"]);
    }
    if (fo["priority"]) {
      where.push("a.priority = ?");
      push(fo["priority"]);
    }
    if (fo["test_status"]) {
      /* 支持多值：test_status=abandoned,blocked */
      const list = String(fo["test_status"]).split(",").map((x) => x.trim()).filter(Boolean);
      if (list.length > 1) {
        where.push(`COALESCE(a.test_status, 'untested') IN (${placeholders(list.length)})`);
        for (const x of list) push(x);
      } else {
        where.push("COALESCE(a.test_status, 'untested') = ?");
        push(fo["test_status"]);
      }
    }
    /* 内外网维度：internal | external（老数据在迁移时已回填） */
    if (fo["scope"]) {
      where.push(`COALESCE(a.scope, (${SCOPE_SQL})) = ?`);
      push(fo["scope"]);
    }
    if (fo["q"]) {
      const terms = String(fo["q"]).split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        if (HAS_FTS5 && this.hasFtsTable(db)) {
          /* 主域名（asset.primary_name）**没有**进 asset_fts 索引（FTS 表里只有
             ip / names / banners / titles / fingerprints），只靠 MATCH 会搜不到主域名 ——
             例如按 "portal.example.test" 查是 0 条。这里并入 LIKE 兜住它，
             顺带覆盖 LIKE 能匹配而 FTS 词元切分匹配不到的情形。 */
          where.push("(a.id IN (SELECT CAST(asset_id AS INTEGER) FROM asset_fts WHERE asset_fts MATCH ?)"
            + " OR a.primary_name LIKE ?)");
          push(terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND "), "%" + String(fo["q"]) + "%");
        } else {
          /* 无 FTS5 的 Node 构建：退化成子串匹配。
             语义比 FTS 弱（不做前缀/词干切分、LIKE 只对 ASCII 大小写不敏感），
             但**检索不报错、内容找得到**，比"整个面板打不开"好得多。
             检索面与 #reindex 喂给 asset_fts 的一致：
             资产 IP / 主域名 + asset_name + port.banner/title/url + service + fingerprint。 */
          const sub = [
            "EXISTS(SELECT 1 FROM asset_name n WHERE n.asset_id = a.id AND n.name LIKE ?)",
            "EXISTS(SELECT 1 FROM port p WHERE p.asset_id = a.id AND (p.banner LIKE ? OR p.title LIKE ? OR p.url LIKE ?))",
            "EXISTS(SELECT 1 FROM service s JOIN port p2 ON p2.id = s.port_id WHERE p2.asset_id = a.id"
              + " AND (s.name LIKE ? OR s.product LIKE ? OR s.version LIKE ?))",
            "EXISTS(SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id"
              + " AND (f.vendor LIKE ? OR f.product LIKE ? OR f.version LIKE ? OR f.category LIKE ?))",
          ];
          for (const t of terms) {
            where.push("(a.ip LIKE ? OR a.primary_name LIKE ? OR " + sub.join(" OR ") + ")");
            push("%" + t + "%", "%" + t + "%");
            for (let i = 0; i < 11; i += 1) push("%" + t + "%");
          }
        }
      }
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const totalRow = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM asset a ${clause}`).get(...(args as never[]));
    const total = Number(totalRow?.n ?? 0);
    const limit = Math.min(Number(fo["limit"]) || 200, 2000);
    const offset = Number(fo["offset"]) || 0;
    const openPorts = "COALESCE((SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open'), 0)";
    /* 排序：默认「最该打的排前面」—— 易打性高 → 未测 → 端口多；sort=ip / sort=ports 可切换 */
    const sort = str(fo["sort"], "priority");
    let orderBy = "a.ip_int";
    if (sort === "ports") {
      orderBy = `${openPorts} DESC, a.ip_int`;
    } else if (sort === "discovered") {
      /* 按发现时间倒序：新收集到的资产排前面（"刚发现了什么"最直观） */
      orderBy = "COALESCE(a.discovered_at, a.first_seen, '') DESC, a.id DESC";
    } else if (sort === "todo") {
      /* 待测优先：把这轮还能打的先顶上来，已测/放弃的沉底 */
      orderBy = `CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        ${openPorts} DESC, a.ip_int`;
    } else if (sort === "priority") {
      orderBy = `CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        CASE COALESCE(a.test_status, 'untested')
          WHEN 'untested' THEN 0 WHEN 'testing' THEN 1 WHEN 'tested' THEN 2
          WHEN 'blocked' THEN 3 WHEN 'abandoned' THEN 4 WHEN 'no_surface' THEN 5 ELSE 6 END,
        ${openPorts} DESC, a.ip_int`;
    }
    const rows = db
      .prepare<AssetRow & { open_port_count: number }>(
        `SELECT a.*, ${openPorts} AS open_port_count FROM asset a ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...(args as never[]), limit, offset);
    /* 一次预取、逐行组装：把 3N 条查询压成 3 条（默认 N 最多 400） */
    const children = this.assetChildren(db, rows.map((r) => r.id));
    return { total, sort, items: rows.map((r) => this.assetRow(db, r, children)) };
  }

  /** 资产详情（含观测与关系边）。 */
  getAsset(id: string, assetId: unknown): AssetDetail | undefined {
    const db = this.db(id);
    const a = db.prepare<AssetRow>("SELECT * FROM asset WHERE id = ?").get(nullableInt(assetId) ?? -1);
    if (a === undefined) return undefined;
    const detail = this.assetRow(db, a);
    /* ⚠️ 原实现是 `ORDER BY collected_at DESC LIMIT 200`，**缺唯一键**：
       `collected_at` 只精确到毫秒，而 `importBundle` 一次采集会连插几条观测
       （name / primary_name / fingerprint…），它们常落在**同一毫秒**。
       并列时 SQLite 的返回顺序未定义 —— 更糟的是有 `LIMIT 200`：
       观测数超过 200 时，**究竟留下哪 200 条本身就不确定**。
       补 `, id DESC` 后语义确定："同一毫秒内后写入的排前面"，
       同时让 LIMIT 的取舍也确定下来。
       这不是行为变更：原先是**未定义**行为，给未定义行为定义出一个确定答案
       是修正 —— 没有调用方会依赖"SQLite 恰好返回的那个顺序"。 */
    const observations = db
      .prepare<{ attr: string | null; value: string | null; provenance: string | null; tool: string | null; collected_at: string | null }>(
        `SELECT attr, value, provenance, tool, collected_at FROM observation
      WHERE entity_kind = 'asset' AND entity_id = ? ORDER BY collected_at DESC, id DESC LIMIT 200`,
      )
      .all(a.id);
    const edges = db
      .prepare<{
        src_kind: string; src_id: string; dst_kind: string; dst_id: string; relation: string; confidence: number | null;
      }>(
        `SELECT src_kind, src_id, dst_kind, dst_id, relation, confidence FROM edge
      WHERE (src_kind = 'asset' AND src_id = ?) OR (dst_kind = 'asset' AND dst_id = ?)`,
      )
      .all(String(a.id), String(a.id));
    return { ...detail, observations, edges };
  }

  /** 图谱投影：C 段 → 资产 → 开放端口（+ 域名解析关系）。 */
  graph(id: string, f: unknown = {}): GraphResult {
    const db = this.db(id);
    const fo = asRecord(f);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    const push = (node: GraphNode): void => {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    };
    const segs = fo["cidr"]
      ? db.prepare<SegmentRow>("SELECT * FROM segment WHERE cidr = ?").all(String(fo["cidr"]))
      : db.prepare<SegmentRow>("SELECT * FROM segment").all();
    for (const s of segs) {
      push({ id: `seg:${s.cidr}`, kind: "segment", label: s.cidr, meta: { org: s.org, asn: s.asn } });
      for (const a of db
        .prepare<AssetRow>("SELECT * FROM asset WHERE segment_cidr = ? ORDER BY ip_int")
        .all(s.cidr)) {
        const nid = `asset:${a.id}`;
        const ports = Number(
          db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM port WHERE asset_id = ? AND state = 'open'").get(a.id)?.n ?? 0,
        );
        push({ id: nid, kind: "asset", label: a.ip, meta: { state: a.state, name: a.primary_name, ports, segment: a.segment_cidr } });
        edges.push({ source: `seg:${s.cidr}`, target: nid, relation: "contains" });
        for (const p of db
          .prepare<{ id: number; port: number; proto: string | null; provenance: string | null }>(
            "SELECT id, port, proto, provenance FROM port WHERE asset_id = ? AND state = ?",
          )
          .all(a.id, "open")) {
          const pid = `port:${p.id}`;
          push({ id: pid, kind: "port", label: `${p.port}/${p.proto ?? ""}`, meta: { provenance: p.provenance, asset: a.ip } });
          edges.push({ source: nid, target: pid, relation: "exposes" });
        }
        if (a.primary_name !== null && a.primary_name !== "") {
          const did = `name:${a.primary_name}`;
          push({ id: did, kind: "domain", label: a.primary_name, meta: {} });
          edges.push({ source: did, target: nid, relation: "resolves" });
        }
      }
    }
    return { nodes, edges };
  }

  /* ---------- 作战阶段 ---------- */

  /**
   * 作战阶段：首次读取时补种默认五阶段（与得分点同策略，老靶标自动获得）。
   *
   * **自愈式补种**：缺哪个补哪个（老库被上一版迁移误删的阶段会自动补回来）。
   * 不能写成"一条都没有才播种"——那样被误删一条就永远补不回来。
   */
  seedStages(id: string): { readonly seeded: number } {
    const db = this.db(id);
    const have = new Set(db.prepare<{ code: string }>("SELECT code FROM stage").all().map((r) => r.code));
    if (DEFAULT_STAGES.every((st) => have.has(st.code))) return { seeded: 0 };
    const maxRow = db.prepare<{ n: number | null }>("SELECT COALESCE(MAX(sort_order), -1) AS n FROM stage").get();
    let order = Number(maxRow?.n ?? -1) + 1;
    const stmt = db.prepare(
      `INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    let seeded = 0;
    for (const st of DEFAULT_STAGES) {
      if (have.has(st.code)) continue;
      stmt.run(st.code, st.name, st.subtitle, st.color, st.goal, JSON.stringify(st.sections),
        st.tools, st.transition, order, nowIso());
      order += 1;
      seeded += 1;
    }
    return { seeded };
  }

  /** 阶段列表（含链路里的真实位置 `ordinal`）。 */
  listStages(id: string): StageView[] {
    const db = this.db(id);
    this.seedStages(id);
    return db
      .prepare<StageRow>("SELECT * FROM stage ORDER BY sort_order, code")
      .all()
      .map((r, i) => ({
        code: r.code,
        name: r.name,
        subtitle: r.subtitle ?? "",
        color: r.color ?? "#64748b",
        goal: r.goal ?? "",
        sections: parseJson<readonly unknown[]>(r.sections, []),
        tools: r.tools ?? "",
        transition: r.transition ?? "",
        /* 链路里的真实位置（第几阶段）：界面画 ①②③ 与报告排序都用它，**不要另行编号** */
        ordinal: i + 1,
        updated_at: r.updated_at ?? null,
      }));
  }

  /** 编辑阶段内容（名称/目标/手段分组/工具/过渡语）。 */
  saveStage(id: string, patch: unknown = {}): { readonly code: string; readonly updated: boolean } {
    const db = this.db(id);
    const p = asRecord(patch);
    const code = str(p["code"], "");
    if (code === "") throw new Error("stage.code required");
    const cur = db.prepare<StageRow>("SELECT * FROM stage WHERE code = ?").get(code);
    /* 逐字段读：显式走 `??` 链（上游用的是 `patch.x ?? (cur ? cur.x : default)`，
       注意 `??` 与 `!== undefined` 的区别 —— 上游对空串是**采纳**的，所以这里用
       "键存在就用键值（含空串），否则回落旧值"。 */
    const pick = (key: string, fallback: string): string => {
      const raw = p[key];
      if (typeof raw === "string") return raw;
      if (raw === undefined) {
        const old = cur === undefined ? undefined : (cur as unknown as Record<string, unknown>)[key];
        return typeof old === "string" ? old : fallback;
      }
      return fallback;
    };
    db.prepare(
      `INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name, subtitle = excluded.subtitle, color = excluded.color, goal = excluded.goal,
        sections = excluded.sections, tools = excluded.tools,
        transition = excluded.transition, updated_at = excluded.updated_at`,
    ).run(
      code,
      pick("name", code),
      pick("subtitle", ""),
      pick("color", "#64748b"),
      pick("goal", ""),
      p["sections"] !== undefined ? JSON.stringify(p["sections"]) : (cur?.sections ?? "[]"),
      pick("tools", ""),
      pick("transition", ""),
      intOr(p["sort_order"] !== undefined ? p["sort_order"] : cur?.sort_order, 0),
      nowIso(),
    );
    return { code, updated: true };
  }

  /* ---------- 得分点播种 ---------- */

  /**
   * 首次打开靶标时播种默认得分点（已有则不动）。
   *
   * ## 这个方法是幂等的，并且**每次读面板都会跑**（不是"只跑一次"）
   *
   * 它同时承担四件事，缺一件都会出线上问题：
   *   ① 空库首次播种；
   *   ② 新规则 / 被误删的默认点**自愈补齐**（缺哪条补哪条）；
   *   ③ 老库的 `builtin` 列回填（刚建列时全是 0）；
   *   ④ 老库的**内置点元数据同步** + 旧体系残留清理。
   *
   * 早先只在"一个得分点都没有"时才调它，于是老库（已有旧点）永远不会被迁移 ——
   * 面板上同一类别被拆成两组（`NETINFRA` 与「网络基础设施」各一组）。
   *
   * ## 两条不可逆操作各有一道闸
   *
   * · 清理旧得分点前**先导出存档**到 `<靶标>/runs/legacy-score-<时间>.json`；
   * · 判定"是否内置"**必须看 `builtin` 列**，不能用 code 名单 ——
   *   用户自建点一旦被判成旧体系残留，会在下次读面板时连同命中一起静默删除，
   *   而 `saveScorePoint` 照样返回 ok、界面照样弹「已保存」。
   */
  seedScorePoints(id: string): {
    readonly seeded: number;
    readonly strippedLegacyPoints?: number;
    readonly strippedLegacyHits?: number;
    readonly stripped?: boolean;
  } {
    const db = this.db(id);
    const insert = (point: (typeof DEFAULT_SCORE_POINTS)[number], order: number): void => {
      db.prepare(
        `INSERT INTO score_point
        (code, name, category, points, description, enabled, sort_order, created_at, updated_at,
         src, rule, tier, cap, dedup_scope, legacy, builtin)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        point.code, point.name, point.category, point.points, point.description,
        point.enabled === 0 ? 0 : 1, order, nowIso(), nowIso(),
        point.src, point.rule, point.tier, point.cap, point.dedup_scope, point.legacy === 1 ? 1 : 0,
        /* 内置点：随规则分发，分值/口径锁定、不可删除 */
        point.legacy === 1 ? 0 : 1,
      );
    };
    const have = new Set(db.prepare<{ code: string | null }>("SELECT code FROM score_point").all().map((r) => String(r.code)));

    const builtinCodes = DEFAULT_SCORE_POINTS.map((x) => x.code);
    const keep = new Set(builtinCodes);
    try {
      db.prepare(`UPDATE score_point SET builtin = 1 WHERE code IN (${placeholders(builtinCodes.length)})`)
        .run(...builtinCodes);
    } catch {
      /* 老库结构异常：不影响计分，下次播种再试 */
    }

    let strippedPoints = 0;
    let strippedHits = 0;
    try {
      const doomed = db.prepare<ScorePointRow>("SELECT id, code, name, category, points, legacy, builtin FROM score_point")
        .all()
        .filter((r) => !keep.has(String(r.code)) && (Number(r.legacy) === 1 || Number(r.builtin) === 1));
      if (doomed.length > 0) {
        const ids = doomed.map((r) => r.id);
        const ph = placeholders(ids.length);
        const hits = db.prepare<ScoreHitRow>(`SELECT * FROM score_hit WHERE point_id IN (${ph})`).all(...ids);
        if (hits.length > 0) {
          /* 存档：放靶标目录的 runs/ 下，与其它证据同处一地 */
          try {
            const dir = join(this.dirOf(id), "runs");
            mkdirSync(dir, { recursive: true });
            const stamp = nowIso().replace(/[:.]/g, "-");
            writeFileSync(
              join(dir, "legacy-score-" + stamp + ".json"),
              JSON.stringify({
                archived_at: nowIso(),
                reason: "按《突破入侵类得分规则（合并版）》重构：旧得分项整套作废",
                points: doomed, hits,
              }, null, 2),
              "utf8",
            );
          } catch {
            /* 存档失败不阻断清理，但要照实记账 */
          }
        }
        db.prepare(`DELETE FROM score_hit WHERE point_id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM score_point WHERE id IN (${ph})`).run(...ids);
        strippedPoints = doomed.length;
        strippedHits = hits.length;
      }
    } catch {
      /* 表还不存在等异常：忽略，不阻断播种 */
    }

    /* 内置得分点的**规则元数据同步**：规则文档改了（类别分组、上限、计分口径、档位说明），
       这里要把它同步到已存在的行上。
       ⚠️ 分值/上限/口径**由规则锁定**（builtin=1），用户改不动：这不仅是"有意覆盖"，
       更是**必须** —— 同一 rule 的 cap 按规则内所有点累计，若允许改单条分值，
       用户把 50 改成 500 就能让整条规则的上限被一条命中吃掉。
       **「启用/停用」仍由用户控制，不在此覆盖。** */
    let synced = 0;
    if (have.size > 0) {
      const upd = db.prepare(
        `UPDATE score_point SET name = ?, category = ?, points = ?, description = ?,
          src = ?, rule = ?, tier = ?, cap = ?, dedup_scope = ?, builtin = 1, updated_at = ?
        WHERE code = ? AND legacy = 0`,
      );
      for (const point of DEFAULT_SCORE_POINTS) {
        if (!have.has(point.code)) continue;
        try {
          const r = upd.run(point.name, point.category, point.points, point.description,
            point.src, point.rule, point.tier, point.cap, point.dedup_scope, nowIso(), point.code);
          if (r.changes > 0) synced += 1;
        } catch {
          /* 忽略单条失败 */
        }
      }
    }

    /* 缺哪条补哪条：新增规则、被误删的默认点都能靠这一条自愈 */
    const missing = DEFAULT_SCORE_POINTS.filter((p) => !have.has(p.code));
    if (missing.length > 0) {
      const maxRow = db.prepare<{ n: number | null }>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point").get();
      let order = Number(maxRow?.n ?? 0);
      for (const point of missing) {
        insert(point, order);
        order += 1;
      }
    }
    if (missing.length === 0 && strippedPoints === 0 && synced === 0) return { seeded: 0 };
    return {
      seeded: missing.length,
      /* 本次清掉的旧得分点与命中条数（面板/工具据此告诉用户"旧口径已作废"） */
      strippedLegacyPoints: strippedPoints,
      strippedLegacyHits: strippedHits,
      stripped: strippedPoints > 0,
    };
  }

  /**
   * 得分面板（按分值从低到高展示，已得分的排前面）。
   *
   * 每次都跑一次播种：它是幂等的，同时承担首次播种/自愈/老库迁移三件事。
   *
   * **计分口径与报告、攻击链共用 `evaluateScoreBoard`**：三处各写一遍必然出现
   * 不同口径，总分对不上（实测面板 6340 / 报告 7930）。
   */
  listScorePoints(id: string, f: unknown = {}): ScoreBoard {
    const db = this.db(id);
    const fo = asRecord(f);
    this.seedScorePoints(id);
    const rows = db.prepare<ScorePointRow>("SELECT * FROM score_point ORDER BY COALESCE(points, 0) ASC, sort_order ASC, id ASC").all();
    const hits = db.prepare<ScoreHitRow>("SELECT * FROM score_hit ORDER BY recorded_at DESC, id DESC").all();
    /* 资产 IP：告警与命中记录里要能直接看出是哪个服务（asset_ip:port） */
    const assetIp = new Map(db.prepare<{ id: number; ip: string }>("SELECT id, ip FROM asset").all().map((a) => [a.id, a.ip]));
    const codeOf = new Map(rows.map((r) => [r.id, r.code]));
    const pointsOf = new Map(rows.map((r) => [r.id, Number(r.points) || 0]));
    /* 命中行的有效分值：档位分值 × 倍率 */
    const effPointsOf = (h: ScoreHitRow): number =>
      hitPointsOf(
        { points: h.points, multiplier: h.multiplier, code: codeOf.get(h.point_id) ?? null },
        new Map([[String(codeOf.get(h.point_id) ?? ""), { points: pointsOf.get(h.point_id) ?? 0 }]]),
      );
    const byPoint = new Map<number, ScoreHitRow[]>();
    for (const h of hits) {
      const bucket = byPoint.get(h.point_id);
      if (bucket === undefined) byPoint.set(h.point_id, [h]);
      else bucket.push(h);
    }
    const pointsMeta = new Map<string, ScoreMeta>(
      rows.map((r) => scoreMetaFromRow(r) as [string, ScoreMeta]),
    );
    const nameOf = new Map(
      db.prepare<{ id: number; primary_name: string | null }>("SELECT id, primary_name FROM asset")
        .all()
        .filter((a) => a.primary_name !== null && a.primary_name !== "")
        .map((a) => [Number(a.id), String(a.primary_name)] as const),
    );
    const evalRows = hits.map((h) => ({
      id: h.id,
      code: codeOf.get(h.point_id) ?? null,
      points: effPointsOf(h),
      asset_id: h.asset_id,
      port: h.port,
      target: h.target,
      recorded_at: h.recorded_at,
      self_created: h.self_created,
      evidence: h.evidence,
      multiplier: h.multiplier,
    }));
    const cappedAll = evaluateScoreBoard(evalRows, pointsMeta, nameOf);
    const cappedById = new Map(cappedAll.items.map((h) => [h.id, h] as const));
    const enabled = rows.filter((r) => r.enabled === 1);
    const enabledIds = new Set(enabled.map((r) => r.id));
    /* 该得分点是否参与"同口径只算最高一条"的去重（供界面显示"已拿满"提示） */
    const isCappedPoint = (pid: number): boolean => {
      const meta = pointsMeta.get(String(codeOf.get(pid) ?? ""));
      return meta !== undefined && meta.dedup_scope !== "none";
    };
    const items: ScorePointView[] = rows
      .filter((r) => fo["enabledOnly"] !== true || r.enabled === 1)
      .map((r) => {
        const list: ScoreHitView[] = (byPoint.get(r.id) ?? []).map((h) => {
          const flag = cappedById.get(h.id);
          const capped = flag !== undefined && flag.capped;
          const hit: ScoreHitView = {
            id: h.id,
            asset_id: h.asset_id,
            vuln_id: h.vuln_id,
            step_id: h.step_id,
            target: h.target,
            evidence: h.evidence,
            note: h.note,
            points: effPointsOf(h),
            points_overridden: h.points !== null && h.points !== undefined,
            port: normalizePort(h.port) ?? parseTargetPort(h.target),
            self_created: Number(h.self_created) === 1,
            capped,
            capped_by_id: capped ? (flag.capped_by_id ?? null) : null,
            capped_reason: capped
              ? scoreCapReasonText(
                {
                  id: h.id, target: h.target, port: h.port,
                  rule: flag.rule, rule_cap: flag.rule_cap,
                  capped_reason_kind: flag.capped_reason_kind,
                },
                flag.capped_by_points,
              )
              : null,
            capped_reason_kind: capped ? flag.capped_reason_kind : null,
            recorded_by: h.recorded_by,
            recorded_at: h.recorded_at,
            /* service 下面立刻覆盖成带资产 IP 的版本，这里先给"无 IP"的形态 */
            service: serviceLabel({ id: h.id, target: h.target, port: h.port }, assetIp.get(h.asset_id ?? -1) ?? null),
          };
          return capped ? { ...hit, capped_by: flag.capped_by_evidence ?? null } : hit;
        });
        /* 不设上限的得分点：命中次数 × 分值累加。
           自建账号（self_created）不计分；账号类/数据库类按服务封顶，只算最高那一条。 */
        const valid = list.filter((h) => !h.self_created);
        const countedList = valid.filter((h) => !h.capped);
        const counted = countedList.length;
        const cappedList = valid.filter((h) => h.capped);
        const meta: ScoreMeta = pointsMeta.get(String(r.code ?? "")) ?? {
          rule: null, cap: 0, dedup_scope: "service", points: 0, enabled: 1, builtin: false, src: null,
        };
        const capUsed = meta.rule === null ? null : cappedAll.caps.get("rule:" + meta.rule);
        const scopeLabel = {
          service: "同一服务只算最高一条",
          system: "同一系统只算最高权限一次",
          target: "整个目标只算一次",
          none: "按台 / 卡 / 节点数累加",
        }[meta.dedup_scope];
        return {
          id: r.id,
          code: r.code,
          name: r.name,
          category: r.category,
          points: r.points,
          rule: meta.rule,
          tier: r.tier ?? null,
          cap: meta.cap,
          dedup_scope: meta.dedup_scope,
          src: r.src === null ? null : Number(r.src),
          builtin: Number(r.builtin) === 1,
          legacy: Number(r.legacy) === 1,
          counted,
          /* 按"计入命中的实际分值"累加 —— 合并后同一 code 含多档，不能再拿默认分值乘次数 */
          earned: countedList.reduce((n, h) => n + h.points, 0),
          self_created: list.length - valid.length,
          capped: cappedList.length,
          capped_hits: cappedList,
          /* 规则上限用量（同一 rule 的得分点共用；界面按规则分组显示"已用 / 上限"） */
          cap_used: capUsed === undefined || capUsed === null ? null : capUsed.used,
          cap_capped: capUsed === undefined || capUsed === null ? 0 : capUsed.capped,
          scope_label: scopeLabel,
          service_summary: meta.dedup_scope !== "none" && cappedList.length > 0
            ? "计分口径「" + scopeLabel + "」：已达 " + counted + " 个，另有 " + cappedList.length + " 条重复命中不计分"
            : null,
          description: r.description ?? "",
          enabled: r.enabled === 1,
          sort_order: r.sort_order,
          hits: list,
        };
      });

    /* ── 证据截图：每个得分点最多挂 3 张代表图 ─────────────────────────────
       批量得分点（终端权限一次 60 台）逐条贴图既没信息量、又把页面撑爆，
       所以按"得分点"给代表图。选图优先级见 `representativeShots`。 */
    const shotPicks = this.representativeShots(
      id,
      items.map((it) => ({ point_id: it.id, point_code: it.code ?? "", hit_ids: it.hits.map((h) => h.id) })),
      3,
    );
    const shotCountByPoint = new Map<number, number>();
    const shotCountByHit = new Map<number, number>();
    try {
      for (const row of db.prepare<{ point_id: number | null; hit_id: number | null; n: number }>(
        "SELECT point_id, hit_id, COUNT(*) AS n FROM shot GROUP BY point_id, hit_id",
      ).all()) {
        if (row.point_id !== null) shotCountByPoint.set(Number(row.point_id), (shotCountByPoint.get(Number(row.point_id)) ?? 0) + Number(row.n));
        if (row.hit_id !== null) shotCountByHit.set(Number(row.hit_id), Number(row.n));
      }
    } catch {
      /* 老库还没有 shot 表时忽略 */
    }
    const shotBrief = (x: ShotRow): ShotBrief => ({
      id: Number(x.id),
      url: this.shotUrlOf(id, x),
      label: x.label ?? "",
      note: x.note ?? "",
      kind: x.kind ?? "screenshot",
      mime: x.mime ?? "image/png",
      bytes: Number(x.bytes) || 0,
      target: x.target ?? "",
      captured_at: x.captured_at ?? "",
      source_ref: x.source_ref ?? "",
    });
    for (const it of items) {
      const picked = shotPicks.get(Number(it.id)) ?? [];
      it.shots = picked.map(shotBrief);
      it.shot_total = shotCountByPoint.get(Number(it.id)) ?? 0;
      it.shot_shown = picked.length;
      for (const h of it.hits) h.shot_count = shotCountByHit.get(Number(h.id)) ?? 0;
    }

    /* 排序：**已得分的排前面**（一眼看到战绩），未得分的在后；
       两组内部都按分值从低到高（同分按定义顺序，结果稳定可预期）。 */
    const achievedRank = (it: ScorePointView): number => (it.hits.length > 0 ? 0 : 1);
    const sortedItems = items.slice().sort((a, b) => {
      const ra = achievedRank(a);
      const rb = achievedRank(b);
      if (ra !== rb) return ra - rb;
      const pa = Number(a.points) || 0;
      const pb = Number(b.points) || 0;
      if (pa !== pb) return pa - pb;
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    });

    /* ── 按合并版的 8 个类别分组 ───────────────────────────────────────── */
    const groupOrder = new Map(SCORE_GROUPS.map((g, i) => [g.code, i] as const));
    const groupName = new Map(SCORE_GROUPS.map((g) => [g.code, g.name] as const));
    interface MutableGroup {
      key: string; code: string; name: string; capSum: number; points: number;
      counted: number; capped: number; order: number; tiers: ScorePointView[];
    }
    const ruleGroups: MutableGroup[] = [];
    const gmap = new Map<string, MutableGroup>();
    for (const it of sortedItems) {
      if (it.legacy) continue;
      const code = it.category ?? "OTHER";
      let g = gmap.get(code);
      if (g === undefined) {
        g = {
          key: code,
          code,
          name: groupName.get(code) ?? code,
          /* 该类别下所有条目的上限之和（仅作参考值 —— 各项上限独立，不跨条累加，见 G3） */
          capSum: 0, points: 0, counted: 0, capped: 0, tiers: [],
          order: groupOrder.get(code) ?? 99,
        };
        gmap.set(code, g);
        ruleGroups.push(g);
      }
      g.capSum += Number(it.cap) || 0;
      g.points += it.earned;
      g.counted += it.counted;
      g.capped += it.capped;
      g.tiers.push(it);
    }
    ruleGroups.sort((a, b) => a.order - b.order);
    /* 组内再兜一次底（防止调用方改过顺序）：已得分优先，再按分值升序 */
    for (const g of ruleGroups) {
      g.tiers.sort((a, b) => {
        const ra = achievedRank(a);
        const rb = achievedRank(b);
        if (ra !== rb) return ra - rb;
        return (Number(a.points) || 0) - (Number(b.points) || 0);
      });
    }
    const legacyItems = items.filter((it) => it.legacy);
    const legacyHits = legacyItems.reduce((n, p) => n + p.hits.length, 0);
    const enabledItems = items.filter((p) => p.enabled);
    /* 只保留"被标 capped、且所属得分点存在且启用"的命中 —— 与面板口径一致。
       原实现写成一行 `filter` 里带三个条件，读不出在筛什么；拆成两步。 */
    const pointIdOfHit = new Map<number, number>();
    for (const h of hits) pointIdOfHit.set(h.id, h.point_id);
    const cappedFiltered = cappedAll.items.filter((h) => {
      if (!h.capped) return false;
      const pointId = pointIdOfHit.get(h.id);
      return pointId !== undefined && enabledIds.has(pointId);
    });
    const latestCapped = cappedFiltered.length === 0
      ? null
      : (cappedFiltered.slice().sort((a, b) => {
        const ha = hits.find((x) => x.id === a.id);
        const hb = hits.find((x) => x.id === b.id);
        const sa = String(ha?.recorded_at ?? "") + "#" + String(a.id).padStart(8, "0");
        const sb = String(hb?.recorded_at ?? "") + "#" + String(b.id).padStart(8, "0");
        return sb.localeCompare(sa);
      })[0] ?? null);
    return {
      items: sortedItems,
      ruleGroups,
      summary: {
        achievedPoints: enabledItems.reduce((n, p) => n + p.earned, 0),
        pointCount: enabledItems.length,
        hitPointCount: enabledItems.filter((p) => p.counted > 0).length,
        hitCount: items.reduce((n, p) => n + p.hits.length, 0),
        countedHits: enabledItems.reduce((n, p) => n + p.counted, 0),
        /* 自己注册/自建而被剔除的命中数 */
        selfCreatedHits: items.reduce((n, p) => n + p.self_created, 0),
        serviceCappedHits: cappedFiltered.length,
        cappedByDedup: cappedFiltered.filter((h) => h.capped_reason_kind === "dedup").length,
        cappedByRuleLimit: cappedFiltered.filter((h) => h.capped_reason_kind === "cap").length,
        legacyPointCount: legacyItems.length,
        legacyHitCount: legacyHits,
        latestCapped: latestCapped === null ? null : (() => {
          const h = hits.find((x) => x.id === latestCapped.id);
          if (h === undefined) return null;
          return {
            hit_id: latestCapped.id,
            point_id: h.point_id,
            code: codeOf.get(h.point_id) ?? null,
            service: serviceLabel({ id: h.id, target: h.target, port: h.port }, assetIp.get(h.asset_id ?? -1) ?? null),
            evidence: h.evidence,
            points: latestCapped.points,
            recorded_at: h.recorded_at,
            reason: scoreCapReasonText(
              {
                id: h.id, target: h.target, port: h.port,
                rule: latestCapped.rule, rule_cap: latestCapped.rule_cap,
                capped_reason_kind: latestCapped.capped_reason_kind,
              },
              latestCapped.capped_by_points,
            ),
          };
        })(),
      },
    };
  }

  /** 这个得分点所属的「服务」端口（服务级封顶的粒度）。 */
  private servicePortOf(db: TypedDb, hit: Record<string, unknown>): number | null {
    const explicit = normalizePort(hit["port"]);
    if (explicit !== null) return explicit;
    const fromTarget = parseTargetPort(hit["target"]);
    if (fromTarget !== null) return fromTarget;
    const assetId = nullableInt(hit["asset_id"]);
    if (assetId === null) return null;
    try {
      const ports = db.prepare<{ port: number }>("SELECT port FROM port WHERE asset_id = ? ORDER BY port").all(assetId);
      if (ports.length === 1) return normalizePort(ports[0]?.port);
    } catch {
      /* 忽略 */
    }
    return null;
  }

  /**
   * 记录一次得分（某个得分点在某个目标上被拿下）。
   *
   * ## 三段校验（都是线上 bug 换来的，不能省）
   *
   * 1. **先播种**：新建靶标后直接记分时默认得分点还没写入，不播种会报
   *    `score point not found`，而真实原因是"还没播种"。
   * 2. **旧 code 不静默改派**：改派目标本身可能已不存在，静默吞掉会让用户
   *    "记了却没分"且查不出原因 —— 宁可报错并指路 `redteam_score_list`。
   * 3. **`points` 必须边界校验**：它是"某一档的分值"，不是自由填写的加分。
   *    没有校验时 `points=999999999` 会把总分刷到 9 位数、`points=-500` 会拉低总分，
   *    两者都让交付报告的数字失去意义。
   *    上限 = max(该条规则上限, 默认分值 × 100, 1000)。
   */
  addScoreHit(id: string, hit: unknown = {}): ScoreHitAdded {
    const db = this.db(id);
    this.seedScorePoints(id);
    const h = asRecord(hit);
    let pointId = nullableInt(h["point_id"]);
    if (pointId === null && h["code"]) {
      const row = db.prepare<{ id: number }>("SELECT id FROM score_point WHERE code = ?").get(String(h["code"]));
      if (row !== undefined) pointId = row.id;
    }
    if (pointId === null && h["point_name"]) {
      const row = db.prepare<{ id: number }>("SELECT id FROM score_point WHERE name = ?").get(String(h["point_name"]));
      if (row !== undefined) pointId = row.id;
    }
    if (pointId === null) {
      throw new Error("score point not found：得分规则已按《突破入侵类得分规则（合并版）》重构为 25 项，"
        + "旧 code（web-account-*、webshell、rce、server-shell、db-access、sensitive-data、boundary、internal-pivot、core-system 等）已作废。"
        + "请先用 redteam_score_list 读实际 code，或用 point_id / point_name 指定。");
    }
    const evidence = str(h["evidence"], "").trim();
    if (evidence === "") throw new Error("score hit evidence required：得分必须写明证据（账号/回显/数据量/路径）");
    /* 自己注册/自建的账号：允许记录（留过程），但不计分 */
    const selfCreated = boolish(h["self_created"]) ? 1 : 0;
    const port = this.servicePortOf(db, h);
    const pointMeta = db.prepare<{ points: number | null; cap: number | null }>(
      "SELECT points, cap FROM score_point WHERE id = ?",
    ).get(pointId) ?? { points: null, cap: null };
    const pointsMax = Math.max(Number(pointMeta.cap) || 0, (Number(pointMeta.points) || 0) * 100, 1000);
    let hitPoints: number | null = null;
    const rawPoints = h["points"];
    if (rawPoints !== undefined && rawPoints !== null && rawPoints !== "") {
      const n = Number(rawPoints);
      if (!Number.isFinite(n)) {
        throw new Error("score hit points invalid：points 必须是有限数字（收到 " + JSON.stringify(rawPoints) + "）");
      }
      if (n <= 0) {
        throw new Error("score hit points invalid：points 必须大于 0（收到 " + n + "）。"
          + "分值按《突破入侵类得分规则》的档位填写，不要用它调分。");
      }
      if (n > pointsMax) {
        throw new Error("score hit points invalid：points=" + n + " 超出该得分点的合理上限 " + pointsMax
          + "（= max(规则上限 " + (Number(pointMeta.cap) || 0) + ", 默认分值 " + (Number(pointMeta.points) || 0)
          + " × 100)）。请按规则档位填写，或修正得分点的分值设置。");
      }
      hitPoints = n;
    }
    /* G5 / G6 倍率：数据规模翻倍、IPv6 ×3。作用在权限分上，随上限一起被 cap 约束。 */
    const mult = scoreMultiplierOf({ ip_version: h["ip_version"], data_scale: h["data_scale"], target: h["target"] });
    const r = db.prepare(
      `INSERT INTO score_hit(point_id, asset_id, vuln_id, step_id, target, evidence, note, self_created, port, recorded_by, recorded_at, points, multiplier)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      pointId, nullableInt(h["asset_id"]), nullableInt(h["vuln_id"]), nullableInt(h["step_id"]),
      nullableStr(h["target"]), evidence, nullableStr(h["note"]), selfCreated, port,
      nullableStr(h["recorded_by"]), nowIso(), hitPoints, mult.multiplier,
    );
    const hitId = r.lastInsertRowid;
    const point = db.prepare<{ name: string; points: number | null; code: string | null }>(
      "SELECT name, points, code FROM score_point WHERE id = ?",
    ).get(pointId);
    const board = this.listScorePoints(id);
    const summary = board.summary;
    const allHits = board.items.flatMap((p) => p.hits);
    const row = allHits.find((x) => x.id === hitId);
    /* 服务级封顶：同一资产同一端口只算分值最高的那条（账号类 / 数据库权限） */
    const cappedByService = selfCreated === 0 && row !== undefined && row.capped;
    const capService = row === undefined ? null : row.service;
    const capBy = row === undefined ? null : (row.capped_by ?? null);
    const capByPoints = row === undefined || row.capped_by_id === null
      ? null
      : (allHits.find((x) => x.id === row.capped_by_id)?.points ?? null);
    /* 反过来：这条是不是把同服务上原本计分的命中顶掉了（总分因此不会增加）。
       直接以「本次插入之后谁还被封顶」为准，避免受"先被别的重复命中顶掉过一次"的干扰。 */
    const demoted = selfCreated === 0 && row !== undefined && !row.capped
      ? allHits.filter((x) => x.capped_by_id === hitId && x.id < hitId)
      : [];
    const warnings: string[] = [];
    if (selfCreated === 1) {
      warnings.push("已记录，但**自己注册/自己创建的账号不计分**（演练得分针对\"拿到别人已有的账号/权限\"）。这条只作过程留痕，不占上限、不进报告。");
    }
    /* G5「含大量数据系统得分翻倍」要有量级依据：门槛是 **1 亿条 / 10TB**。
       判不出来只**警告不阻断** —— 数据量常在报告正文里而不是 evidence 里，
       硬拦会把真实成果挡在门外；但一定要提醒补齐，否则翻倍站不住。 */
    if (mult.multiplier > 1 && mult.reasons.some((x) => x.startsWith("G5"))) {
      const rows = parseRowCount(evidence);
      if (rows === null) {
        warnings.push("注意：这条按 G5 记了「数据规模翻倍」，但 evidence 里**看不出数据量**。"
          + "请在 evidence 里写明实际规模（例如「导出 1.3 亿条用户数据」或「12TB 训练数据」），否则这条翻倍站不住。");
      } else if (rows < SENSITIVE_DATA_MIN_ROWS) {
        warnings.push("注意：这条按 G5 记了翻倍，但 evidence 里的量是 **" + formatRows(rows) + " 条/行**，"
          + "远低于「大量数据系统」的门槛（文档为超 1 亿条或 10TB）。请核对数据规模；确实是 1 亿条以上时"
          + "用更明确的写法（如「1.32 亿条」）写进 evidence。");
      }
    }
    if (cappedByService && row !== undefined) {
      /* 规则号/上限挂在得分点上（ScoreHitView 不带），从同一块面板里按 point_id 取 */
      const owner = board.items.find((p) => p.hits.some((x) => x.id === row.id));
      warnings.push(scoreCapReasonText(
        {
          id: row.id, target: row.target, port: row.port,
          rule: owner?.rule ?? null, rule_cap: owner?.cap ?? 0,
          capped_reason_kind: row.capped_reason_kind,
        },
        capByPoints,
      ));
      if (capBy !== null) warnings.push("计分的是同服务的另一条：" + String(capBy).slice(0, 120));
    } else if (demoted.length > 0) {
      warnings.push("注意：这条把同服务上分值更低的 " + demoted.length + " 条旧命中顶掉了——**同一资产同一端口只算一次**，所以本次记分不会让总分增加（旧命中转为不计分）。");
    }
    const basePoints = hitPoints === null ? (point?.points ?? 0) : hitPoints;
    return {
      id: hitId,
      point_id: pointId,
      point: point === undefined ? null : point.name,
      /* 单次档位分值与最终计入的分值分开给：倍率让我们能解释"50 分怎么变成 150 分" */
      base_points: basePoints,
      multiplier: mult.multiplier,
      multiplier_reasons: mult.reasons.length > 0 ? mult.reasons : undefined,
      points: Math.round(basePoints * mult.multiplier),
      port,
      service: capService,
      /* G5 量级核对结果（没按 G5 记分的条目为 null）：让界面/模型一眼看出"翻倍有没有依据" */
      volume: mult.reasons.some((x) => x.startsWith("G5"))
        ? (() => {
          const rows = parseRowCount(evidence);
          return { rows, min_rows: SENSITIVE_DATA_MIN_ROWS, meets_threshold: rows === null ? null : rows >= SENSITIVE_DATA_MIN_ROWS };
        })()
        : null,
      self_created: selfCreated === 1,
      counted: selfCreated === 0 && !cappedByService,
      capped_by_service: cappedByService,
      capped_by: capBy,
      demoted_hits: demoted.map((x) => ({ id: x.id, evidence: x.evidence, points: x.points })),
      warning: warnings.length === 0 ? undefined : warnings.join("\n"),
      summary,
    };
  }

  /**
   * 保存得分点（带 id 更新，不带 id 新增）。
   *
   * 两条路径差别很大，返回结构里用 `builtin` / `overridden` / `locked_fields` 说清楚：
   *   · **内置点**（builtin=1）：分值/上限/计分口径/名称由规则锁定，只能改「启用/停用」。
   *     **不允许改分值不只是纪律问题** —— 同一 rule 的 cap 按组内所有点累计，
   *     改了单条分值就能让一条命中吃掉整组上限。这里照样返回 `ok`（启用状态确实存下去了），
   *     但用 `overridden:false` 明确告诉调用方"你提交的分值没被采纳"。
   *   · **用户自建点**（builtin=0）：字段全部可改，且不会被播种逻辑清掉。
   */
  saveScorePoint(id: string, point: unknown = {}): ScorePointSaved {
    const db = this.db(id);
    const p = asRecord(point);
    const enabled = p["enabled"] === false ? 0 : 1;
    /* name 的必填校验**必须放在内置点分支之后**：内置点只接受 enabled / sort_order，
       调用方（界面开关、工具只改启用状态）本来就不该被迫回传 name。
       放在前面会让"只想停用一个内置得分点"直接报 name required。 */
    const name = str(p["name"], "").trim();
    const pid = nullableInt(p["id"]);
    if (pid !== null && pid > 0) {
      const row = db.prepare<{
        id: number; code: string | null; name: string; points: number | null; cap: number | null;
        rule: number | null; tier: string | null; dedup_scope: string | null; builtin: number | null; legacy: number | null;
      }>("SELECT id, code, name, points, cap, rule, tier, dedup_scope, builtin, legacy FROM score_point WHERE id = ?").get(pid);
      if (row === undefined) throw new Error("score point not found: id=" + pid);
      if (Number(row.builtin) === 1 || Number(row.legacy) === 1) {
        /* 内置点：只落 enabled / sort_order，其余字段留给 seedScorePoints 按规则同步 */
        db.prepare("UPDATE score_point SET enabled = ?, sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?")
          .run(enabled, nullableInt(p["sort_order"]), nowIso(), pid);
        const after = db.prepare<ScorePointRow>("SELECT * FROM score_point WHERE id = ?").get(pid);
        return {
          id: pid,
          code: after?.code ?? row.code,
          updated: true,
          builtin: true,
          points: after?.points ?? row.points,
          cap: after?.cap ?? row.cap,
          rule: after?.rule ?? row.rule,
          overridden: Number(p["points"]) === Number(after?.points ?? row.points),
          locked_fields: ["name", "category", "points", "cap", "rule", "tier", "dedup_scope", "description"],
          note: "这是随《突破入侵类得分规则》分发的内置得分点：分值、上限、计分口径、名称与条款正文"
            + "都由规则锁定（同一条规则的上限按组内所有得分点累计，单独改分值会让一条命中吃掉整组上限）。"
            + "已保存你修改的「启用/停用」。要自定义分值时请**新增一个得分点**。",
        };
      }
      if (name === "") throw new Error("score point name required");
      const points = Number.isFinite(Number(p["points"])) ? Number(p["points"]) : 0;
      db.prepare(
        `UPDATE score_point SET name = ?, category = ?, points = ?, description = ?, enabled = ?,
          sort_order = COALESCE(?, sort_order), updated_at = ? WHERE id = ?`,
      ).run(name, nullableStr(p["category"]), points, nullableStr(p["description"]), enabled,
        nullableInt(p["sort_order"]), nowIso(), pid);
      return { id: pid, code: row.code, updated: true, builtin: false, overridden: true, points, note: "已保存（自建得分点）" };
    }
    if (name === "") throw new Error("score point name required");
    const points = Number.isFinite(Number(p["points"])) ? Number(p["points"]) : 0;
    const nextRow = db.prepare<{ n: number | null }>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM score_point").get();
    const next = Number(nextRow?.n ?? 0);
    /* 自建点可能带上与内置点相同的 code（面板默认按名称生成）：code 有 UNIQUE 约束，
       撞了就换一个，避免"新增失败但界面看不出原因"。 */
    let code = p["code"] === undefined || p["code"] === null || String(p["code"]).trim() === ""
      ? null
      : String(p["code"]).trim();
    if (code !== null && db.prepare<{ id: number }>("SELECT id FROM score_point WHERE code = ?").get(code) !== undefined) {
      code = code + "-custom-" + Date.now().toString(36);
    }
    const r = db.prepare(
      `INSERT INTO score_point(code, name, category, points, description, enabled, sort_order, created_at, updated_at, builtin)
      VALUES(?,?,?,?,?,?,?,?,?,0)`,
    ).run(code, name, nullableStr(p["category"]), points, nullableStr(p["description"]), enabled,
      next, nowIso(), nowIso());
    return {
      id: r.lastInsertRowid, code, updated: false, builtin: false, overridden: true,
      points, note: "已新增自建得分点（不受规则分值锁定，也不会被旧体系清理删除）",
    };
  }

  /** 删除得分点。内置点不允许删除（否则面板会缺一条规则，且下次播种又会长回来）。 */
  deleteScorePoint(id: string, pointId: unknown): { readonly deleted: number } {
    const db = this.db(id);
    const pid = intOr(pointId, -1);
    const row = db.prepare<{ id: number; code: string | null; name: string; builtin: number | null }>(
      "SELECT id, code, name, builtin FROM score_point WHERE id = ?",
    ).get(pid);
    if (row === undefined) throw new Error("score point not found: id=" + pid);
    if (Number(row.builtin) === 1) {
      throw new Error("内置得分点不能删除：「" + (row.name || row.code) + "」来自《突破入侵类得分规则（合并版）》，"
        + "删掉会让面板缺一条规则、报告少一类成果（下次启动还会自动补回来）。"
        + "要让它不参与计分，请改用「停用」。");
    }
    db.prepare("DELETE FROM score_hit WHERE point_id = ?").run(pid);
    db.prepare("DELETE FROM score_point WHERE id = ?").run(pid);
    return { deleted: pid };
  }

  /* ---------- 资产评估与测试状态 ---------- */

  /** 资产易打性评估：预期能拿到哪些成果、优先级多高。 */
  assessAsset(id: string, a: unknown = {}): {
    readonly asset_id: number; readonly ip: string; readonly priority: string;
    readonly potential: string; readonly assessed_at: string;
  } {
    const db = this.db(id);
    const input = asRecord(a);
    let row: AssetRow | undefined;
    const assetId = nullableInt(input["asset_id"]);
    if (assetId !== null) row = db.prepare<AssetRow>("SELECT * FROM asset WHERE id = ?").get(assetId);
    else if (input["ip"]) row = db.prepare<AssetRow>("SELECT * FROM asset WHERE ip = ?").get(String(input["ip"]));
    if (row === undefined) throw new Error("asset not found（请传 asset_id 或 ip）");
    const wanted = String(input["priority"] ?? "");
    const priority = (VALID_PRIORITIES as readonly string[]).includes(wanted) ? wanted : (row.priority ?? "medium");
    const stamp = nowIso();
    const potential = nullableStr(input["potential"]) ?? (row.potential ?? "");
    db.prepare("UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?")
      .run(priority, potential, nullableStr(input["reason"]) ?? (row.assess_reason ?? ""), stamp, nullableStr(input["assessed_by"]), row.id);
    this.observe(db, "asset", row.id, "assess", priority + " " + str(input["potential"], ""), "active", nullableStr(input["assessed_by"]), null);
    return { asset_id: row.id, ip: row.ip, priority, potential, assessed_at: stamp };
  }

  /**
   * 记录对某个资产的测试情况。
   *
   * · `test` 会**追加**到测试记录（带时间戳）；
   * · `surface` 覆盖「剩余可测攻击面」；
   * · `blocked=true` 时封禁计数 +1。
   *
   * 提示词历史上把这条记录叫 `notes`，模型也常照抄这个参数名；两种写法都收，
   * 统一落到 `test_notes`（追加式），避免"记了一行结论"其实什么都没写进去。
   */
  updateAssetTest(id: string, t: unknown = {}): {
    readonly asset_id: number; readonly ip: string; readonly status: string; readonly blocked_count: number;
    readonly test_notes: string; readonly tests: string; readonly surface: string;
    readonly updated_at: string; readonly hint: string | undefined;
  } {
    const db = this.db(id);
    const input = asRecord(t);
    let row: AssetRow | undefined;
    const assetId = nullableInt(input["asset_id"]);
    if (assetId !== null) {
      row = db.prepare<AssetRow>("SELECT * FROM asset WHERE id = ?").get(assetId);
    } else if (input["ip"]) {
      row = db.prepare<AssetRow>("SELECT * FROM asset WHERE ip = ?").get(String(input["ip"]));
    }
    if (row === undefined) throw new Error("asset not found（请传 asset_id 或 ip）");
    const wanted = String(input["status"] ?? "");
    const status = (VALID_TEST_STATUSES as readonly string[]).includes(wanted)
      ? wanted
      : (row.test_status ?? "untested");
    const stamp = nowIso();
    const testText = [input["test"], input["notes"]]
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => x.trim())
      .join("；");
    let notes = row.test_notes ?? "";
    if (testText !== "") {
      notes = (notes === "" ? "" : notes.replace(/\n+$/, "") + "\n") + "[" + stamp + "] " + testText;
    }
    const surface = typeof input["surface"] === "string" ? input["surface"] : (row.test_surface ?? "");
    const blockedCount = (row.blocked_count ?? 0) + (input["blocked"] === true ? 1 : 0);
    db.prepare(
      `UPDATE asset SET test_status = ?, test_notes = ?, test_surface = ?,
        test_updated_at = ?, test_updated_by = ?, blocked_count = ? WHERE id = ?`,
    ).run(status, notes, surface, stamp, nullableStr(input["updated_by"]), blockedCount, row.id);
    if (testText !== "") {
      this.observe(db, "asset", row.id, "test", testText, "active", nullableStr(input["updated_by"]), null);
    }
    if (input["blocked"] === true) {
      this.observe(db, "asset", row.id, "blocked", "第 " + blockedCount + " 次被封禁", "active", nullableStr(input["updated_by"]), null);
    }
    return {
      asset_id: row.id,
      ip: row.ip,
      status,
      blocked_count: blockedCount,
      test_notes: notes,
      tests: notes,
      surface,
      updated_at: stamp,
      hint: blockedCount >= 3
        ? "已累计被封 " + blockedCount + " 次（>3 次口径）：请在这次调用里把 status 置 abandoned 并写清剩余攻击面，然后换目标。"
        : undefined,
    };
  }

  /** 测试状态统计（供概览与筛选）。 */
  testStats(id: string): TestStats {
    const db = this.db(id);
    const rows = db.prepare<{ s: string; n: number }>(
      "SELECT COALESCE(test_status, 'untested') AS s, COUNT(*) AS n FROM asset GROUP BY s",
    ).all();
    const out: Record<string, number> = { untested: 0, testing: 0, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 };
    for (const r of rows) out[r.s] = r.n;
    return out as unknown as TestStats;
  }

  /* ---------- 漏洞 ---------- */

  /** 记录一条漏洞；带 cve 时按 (asset_id, cve, target) 幂等更新。 */
  addVuln(id: string, v: unknown = {}): { readonly id: number; readonly updated: boolean } {
    const db = this.db(id);
    const input = asRecord(v);
    const wantedSeverity = String(input["severity"] ?? "");
    const severity = (SEVERITIES as readonly string[]).includes(wantedSeverity) ? wantedSeverity : "info";
    const wantedStatus = String(input["status"] ?? "");
    const status = (VULN_STATUSES as readonly string[]).includes(wantedStatus) ? wantedStatus : "candidate";
    const assetId = nullableInt(input["asset_id"]);
    const existing = input["cve"]
      ? db.prepare<{ id: number }>("SELECT id FROM vuln WHERE asset_id IS ? AND cve = ? AND COALESCE(target, '') = ?")
        .get(assetId, String(input["cve"]), str(input["target"], ""))
      : db.prepare<{ id: number }>("SELECT id FROM vuln WHERE asset_id IS ? AND COALESCE(cve, '') = '' AND title = ? AND COALESCE(target, '') = ?")
        .get(assetId, str(input["title"], ""), str(input["target"], ""));
    if (existing !== undefined) {
      db.prepare(
        `UPDATE vuln SET
          title = COALESCE(?, title), severity = ?, status = COALESCE(?, status),
          evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
          source = COALESCE(?, source), target = COALESCE(?, target),
          found_by_agent = COALESCE(?, found_by_agent), gained = COALESCE(?, gained),
          agent = COALESCE(?, agent)
        WHERE id = ?`,
      ).run(
        nullableStr(input["title"]), severity, nullableStr(input["status"]), nullableStr(input["evidence"]),
        nullableInt(input["confidence"]), nullableStr(input["source"]), nullableStr(input["target"]),
        nullableStr(input["found_by_agent"]), normGained(input["gained"]),
        nullableStr(input["agent"]), existing.id,
      );
      return { id: existing.id, updated: true };
    }
    const result = db.prepare(
      `INSERT INTO vuln(asset_id, port_id, cve, title, severity, source, confidence, status, evidence, target, gained, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      assetId, nullableInt(input["port_id"]), nullableStr(input["cve"]), nullableStr(input["title"]), severity,
      nullableStr(input["source"]), nullableInt(input["confidence"]), status, nullableStr(input["evidence"]),
      nullableStr(input["target"]), normGained(input["gained"]), nullableStr(input["found_by_agent"]),
      nowIso(), nullableStr(input["agent"]),
    );
    const vulnId = result.lastInsertRowid;
    if (assetId !== null) {
      this.observe(db, "asset", assetId, "vuln", [input["cve"], input["title"]].filter(Boolean).join(" "), "active", nullableStr(input["source"]), null);
    }
    return { id: vulnId, updated: false };
  }

  /** 漏洞列表（严重级升序 → id 倒序；带关联的原始请求）。 */
  listVulns(id: string, f: unknown = {}): {
    readonly total: number;
    readonly items: readonly (VulnRow & {
      readonly asset_ip: string | null;
      readonly segment_cidr: string | null;
      http_evidence: readonly {
        readonly id: number; readonly label: string | null; readonly method: string | null; readonly url: string | null;
        readonly status: number | null; readonly request: string | null; readonly response: string | null;
        readonly note: string | null; readonly captured_by: string | null; readonly captured_at: string | null;
      }[];
    })[];
  } {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["severity"]) {
      where.push("v.severity = ?");
      args.push(fo["severity"]);
    }
    if (fo["status"]) {
      where.push("v.status = ?");
      args.push(fo["status"]);
    }
    if (fo["cve"]) {
      where.push("v.cve LIKE ?");
      args.push(`%${str(fo["cve"], "")}%`);
    }
    const assetId = nullableInt(fo["asset_id"]);
    if (assetId !== null) {
      where.push("v.asset_id = ?");
      args.push(assetId);
    }
    if (fo["cidr"]) {
      where.push("a.segment_cidr = ?");
      args.push(fo["cidr"]);
    }
    if (fo["q"]) {
      where.push("(v.title LIKE ? OR v.cve LIKE ? OR v.target LIKE ? OR v.evidence LIKE ?)");
      const like = `%${str(fo["q"], "")}%`;
      args.push(like, like, like, like);
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 200, 1000);
    const totalRow = db.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}`,
    ).get(...(args as never[]));
    const total = Number(totalRow?.n ?? 0);
    const items = db.prepare<VulnRow & { asset_ip: string | null; segment_cidr: string | null }>(
      `SELECT v.*, a.ip AS asset_ip, a.segment_cidr
      FROM vuln v LEFT JOIN asset a ON a.id = v.asset_id ${clause}
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               v.id DESC LIMIT ?`,
    ).all(...(args as never[]), limit);
    /* 详情里要直接展示原始请求/响应，这里一并带上（请求体可能很大，做长度保护） */
    const eviStmt = db.prepare<{
      id: number; label: string | null; method: string | null; url: string | null; status: number | null;
      request: string | null; response: string | null; note: string | null; captured_by: string | null; captured_at: string | null;
    }>(
      `SELECT id, label, method, url, status, request, response, note, captured_by, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`,
    );
    const clipped = (t: string | null): string | null =>
      (t === null ? null : (t.length > 60000 ? t.slice(0, 60000) + "\n…（截断）" : t));
    return {
      total,
      items: items.map((item) => ({
        ...item,
        http_evidence: eviStmt.all(item.id).map((e) => ({ ...e, request: clipped(e.request), response: clipped(e.response) })),
      })),
    };
  }

  /** 更新漏洞（只改状态/严重级/证据/置信度/拿到什么/标题）。 */
  updateVuln(id: string, vulnId: unknown, patch: unknown = {}): { readonly updated: boolean; readonly id?: number } {
    const db = this.db(id);
    const p = asRecord(patch);
    const target = intOr(vulnId, -1);
    const current = db.prepare<VulnRow>("SELECT * FROM vuln WHERE id = ?").get(target);
    if (current === undefined) return { updated: false };
    const wantedStatus = String(p["status"] ?? "");
    const wantedSeverity = String(p["severity"] ?? "");
    db.prepare(
      `UPDATE vuln SET status = ?, severity = ?, evidence = COALESCE(?, evidence), confidence = COALESCE(?, confidence),
        gained = COALESCE(?, gained), title = COALESCE(?, title)
      WHERE id = ?`,
    ).run(
      (VULN_STATUSES as readonly string[]).includes(wantedStatus) ? wantedStatus : current.status,
      (SEVERITIES as readonly string[]).includes(wantedSeverity) ? wantedSeverity : current.severity,
      nullableStr(p["evidence"]), nullableInt(p["confidence"]), normGained(p["gained"]), nullableStr(p["title"]), target,
    );
    return { updated: true, id: target };
  }

  /** 漏洞统计（按严重级/状态分组 + 有证据数 + 目标归并组数）。 */
  vulnStats(id: string): VulnStats {
    const db = this.db(id);
    const bySeverity: Record<string, number> = {};
    for (const row of db.prepare<{ severity: string | null; n: number }>("SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity").all()) {
      bySeverity[String(row.severity)] = row.n;
    }
    const byStatus: Record<string, number> = {};
    for (const row of db.prepare<{ status: string | null; n: number }>("SELECT status, COUNT(*) AS n FROM vuln GROUP BY status").all()) {
      byStatus[String(row.status)] = row.n;
    }
    const withGained = Number(
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(gained,'') <> ''").get()?.n ?? 0,
    );
    const withEvidence = Number(
      db.prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM vuln WHERE COALESCE(evidence,'') <> '' OR id IN (SELECT vuln_id FROM http_evidence WHERE vuln_id IS NOT NULL)",
      ).get()?.n ?? 0,
    );
    /* 按目标聚合所需的组数（漏洞页默认视图）：先按「站点/服务」归并再数 */
    const rawTargets = db.prepare<{ target: string | null; ip: string | null }>(
      "SELECT target, (SELECT ip FROM asset WHERE id = vuln.asset_id) AS ip FROM vuln",
    ).all();
    const targetGroups = new Set(rawTargets.map((r) => targetKey(r.target, r.ip))).size;
    return {
      total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
      bySeverity, byStatus, withGained, withEvidence, targetGroups,
    };
  }

  /* ---------- 凭据 / 访问会话 ---------- */

  /** 凭据：明文写 `secret_value`（面板直接显示），同时保留 `secret_ref` 指向证据文件。 */
  addCredential(id: string, c: unknown = {}): { readonly id: number } {
    const db = this.db(id);
    const input = asRecord(c);
    const host = str(input["host"], "");
    if (host === "") throw new Error("credential.host required");
    /* 明文凭据：secret_value 为准，兼容 secret / password / value 等别名 */
    const value = input["secret_value"] ?? input["secret"] ?? input["password"] ?? input["value"] ?? null;
    const username = str(input["username"], "");
    const secretType = str(input["secret_type"], "password");
    db.prepare(
      `INSERT INTO credential(asset_id, host, username, secret_type, secret_value, secret_ref, privilege, source, tool, note, found_by_agent, found_at, agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, username, secret_type) DO UPDATE SET
        secret_value = COALESCE(excluded.secret_value, credential.secret_value),
        secret_ref = COALESCE(excluded.secret_ref, credential.secret_ref),
        privilege = COALESCE(excluded.privilege, credential.privilege),
        note = COALESCE(excluded.note, credential.note),
        agent = COALESCE(excluded.agent, credential.agent),
        found_at = excluded.found_at`,
    ).run(
      nullableInt(input["asset_id"]), host, username, secretType,
      value === null || value === undefined ? null : String(value),
      nullableStr(input["secret_ref"]), nullableStr(input["privilege"]), nullableStr(input["source"]),
      nullableStr(input["tool"]), nullableStr(input["note"]), nullableStr(input["found_by_agent"]),
      nowIso(), nullableStr(input["agent"]),
    );
    const row = db.prepare<{ id: number }>("SELECT id FROM credential WHERE host = ? AND username = ? AND secret_type = ?")
      .get(host, username, secretType);
    return { id: row?.id ?? 0 };
  }

  /** 凭据列表（最新在前）。 */
  listCredentials(id: string, f: unknown = {}): readonly CredentialRow[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["host"]) {
      where.push("host = ?");
      args.push(fo["host"]);
    }
    if (fo["username"]) {
      where.push("username = ?");
      args.push(fo["username"]);
    }
    if (fo["withValue"] === true) where.push("COALESCE(secret_value,'') <> ''");
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 200, 1000);
    return db.prepare<CredentialRow>(`SELECT * FROM credential ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...(args as never[]), limit);
  }

  /** 访问会话：一次可控访问（横向移动的起点）。 */
  addAccess(id: string, a: unknown = {}): { readonly id: number } {
    const db = this.db(id);
    const input = asRecord(a);
    const host = str(input["host"], "");
    if (host === "") throw new Error("access.host required");
    const assetId = nullableInt(input["asset_id"]);
    const result = db.prepare(
      `INSERT INTO access_session(asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      assetId, host, nullableStr(input["username"]), nullableStr(input["method"]), nullableStr(input["privilege"]),
      nullableStr(input["session_ref"]), nullableStr(input["note"]), nullableStr(input["found_by_agent"]), nowIso(),
    );
    if (assetId !== null) {
      this.observe(db, "asset", assetId, "access",
        [input["method"], input["username"], input["privilege"]].filter(Boolean).join(" "), "active", "exploit", null);
    }
    return { id: result.lastInsertRowid };
  }

  /** 访问会话列表（最新在前）。 */
  listAccess(id: string, f: unknown = {}): readonly AccessSessionRow[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["host"]) {
      where.push("host = ?");
      args.push(fo["host"]);
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 200, 1000);
    return db.prepare<AccessSessionRow>(`SELECT * FROM access_session ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...(args as never[]), limit);
  }

  /* ---------- WebShell / 隧道 ---------- */

  /**
   * 登记一个已上线的 WebShell。同一 `url+pass_key` 视为同一条，重复登记即刷新。
   *
   * 新增与更新走**同一套规范化**（`normalizeShellType` / `normalizeShellStatus`）：
   * 以前更新路径能写任意字符串，面板的"非冰蝎马用户连不上"红标会因此静默失效。
   */
  addWebshell(id: string, w: unknown = {}): { readonly id: number; readonly updated: boolean } {
    const db = this.db(id);
    const input = asRecord(w);
    const url = str(input["url"], "");
    if (url === "") throw new Error("webshell.url required");
    const ts = nowIso();
    const existing = db.prepare<{ id: number }>("SELECT id FROM webshell WHERE url = ? AND COALESCE(pass_key, '') = COALESCE(?, '')")
      .get(url, nullableStr(input["pass_key"]));
    if (existing !== undefined) {
      db.prepare(
        `UPDATE webshell SET shell_type = COALESCE(?, shell_type), secret_ref = COALESCE(?, secret_ref),
        privilege = COALESCE(?, privilege), status = COALESCE(?, status), note = COALESCE(?, note),
        asset_id = COALESCE(?, asset_id), agent = COALESCE(?, agent), updated_at = ? WHERE id = ?`,
      ).run(normalizeShellType(input["shell_type"]), nullableStr(input["secret_ref"]), nullableStr(input["privilege"]),
        normalizeShellStatus(input["status"]), nullableStr(input["note"]), nullableInt(input["asset_id"]),
        nullableStr(input["agent"]), ts, existing.id);
      return { id: Number(existing.id), updated: true };
    }
    const result = db.prepare(
      `INSERT INTO webshell(asset_id, url, shell_type, pass_key, secret_ref, privilege,
      status, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nullableInt(input["asset_id"]), url, normalizeShellType(input["shell_type"]), nullableStr(input["pass_key"]),
      nullableStr(input["secret_ref"]), nullableStr(input["privilege"]), normalizeShellStatus(input["status"]),
      nullableStr(input["note"]), nullableStr(input["found_by_agent"]), ts, ts, nullableStr(input["agent"]),
    );
    const assetId = nullableInt(input["asset_id"]);
    if (assetId !== null) {
      this.observe(db, "asset", assetId, "webshell", url, "active", "exploit", null);
    }
    return { id: result.lastInsertRowid, updated: false };
  }

  /** 马列表（带资产 IP）。 */
  listWebshells(id: string, f: unknown = {}): WebshellView[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["status"]) {
      where.push("w.status = ?");
      args.push(fo["status"]);
    }
    if (fo["asset_id"]) {
      where.push("w.asset_id = ?");
      args.push(fo["asset_id"]);
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 200, 1000);
    return db.prepare<WebshellRow & { asset_ip: string | null }>(
      `SELECT w.*, a.ip AS asset_ip FROM webshell w
      LEFT JOIN asset a ON a.id = w.asset_id ${clause} ORDER BY w.id DESC LIMIT ?`,
    ).all(...(args as never[]), limit);
  }

  /** 更新马（只改可运维字段；`shell_type`/`status` 走同一套规范化）。 */
  updateWebshell(id: string, wsId: unknown, patch: unknown = {}): { readonly updated: boolean } {
    const db = this.db(id);
    const p = asRecord(patch);
    const fields = ["status", "check_note", "latency_ms", "last_check", "privilege", "note", "secret_ref", "shell_type"] as const;
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const key of fields) {
      if (p[key] === undefined) continue;
      let value: unknown = p[key];
      if (key === "shell_type") value = normalizeShellType(value);
      if (key === "status") value = normalizeShellStatus(value);
      sets.push(`${key} = ?`);
      args.push(value);
    }
    if (sets.length === 0) throw new Error("nothing to update");
    sets.push("updated_at = ?");
    args.push(nowIso());
    const result = db.prepare(`UPDATE webshell SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]), intOr(wsId, -1));
    if (result.changes === 0) throw new Error("webshell not found");
    return { updated: true };
  }

  /**
   * 登记一条内网隧道（suo5 / socks5 / ssh -R / frp …）。
   *
   * **判定规则**：只有跨越了靶标边界（通道一端在目标侧）的才算突破凭证：
   *   · `target-outbound` 目标主动连出（反弹 shell / 目标上跑 frp 客户端）
   *   · `target-http`     经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）
   *   · `target-agent`    经目标已控进程/会话转发（SSH -R 由目标发起）
   *   · `self-only`       只在自己 VPS/自建服务器上 —— **不算突破**
   *
   * `entry_kind` 是**边界突破得分的凭证字段**：写错必须报错，不能静默归零。
   * 认不出的值写成 NULL 会让 `legit=null`，界面显示"待确认" —— 与"没填"无法区分，
   * 而模型只是多打了一个空格（`target-http `）就踩到，事后完全查不出原因。
   */
  addTunnel(id: string, t: unknown = {}): {
    readonly id: number; readonly entry_kind: string | null; readonly legit: boolean | null; readonly warning: string | undefined;
  } {
    const db = this.db(id);
    const input = asRecord(t);
    const ts = nowIso();
    const rawEntryKind = input["entry_kind"] === undefined || input["entry_kind"] === null
      ? ""
      : String(input["entry_kind"]).trim();
    if (rawEntryKind !== "" && TUNNEL_ENTRY_KINDS[rawEntryKind] === undefined) {
      throw new Error("entry_kind 非法：" + JSON.stringify(input["entry_kind"]) + "。合法值只有 "
        + Object.keys(TUNNEL_ENTRY_KINDS).join(" / ") + "（" + Object.values(TUNNEL_ENTRY_KINDS).join(" / ") + "）。"
        + "留空会被当作\"待确认\"、不计入边界突破。");
    }
    const result = db.prepare(
      `INSERT INTO tunnel(asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, pid, command, note, found_by_agent, created_at, updated_at, agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nullableInt(input["asset_id"]), nullableInt(input["webshell_id"]), str(input["kind"], "socks5"),
      nullableStr(input["listen"]), nullableStr(input["entry"]), nullableStr(input["reach"]),
      rawEntryKind === "" ? null : rawEntryKind, str(input["status"], "active"),
      nullableStr(input["pid"]), nullableStr(input["command"]), nullableStr(input["note"]),
      nullableStr(input["found_by_agent"]), ts, ts, nullableStr(input["agent"]),
    );
    const assetId = nullableInt(input["asset_id"]);
    if (assetId !== null) {
      this.observe(db, "asset", assetId, "tunnel",
        `${str(input["kind"], "socks5")} ${str(input["listen"], "")}`.trim(), "active", "exploit", null);
    }
    const entryKind = rawEntryKind === "" ? null : rawEntryKind;
    const legit = tunnelIsLegit(entryKind);
    return {
      id: result.lastInsertRowid,
      entry_kind: entryKind,
      legit,
      warning: legit === false
        ? "已登记，但 entry_kind=self-only（只在自己 VPS/自建服务器上开的通道）—— **这不算隧道、不算边界突破/内网突破**。必须是目标侧发起的通道：目标反弹 shell 到我的服务器、目标上跑 frp 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道。"
        : (legit === null
          ? "建议补 entry_kind 说明\"目标侧的那一端是什么\"（target-outbound / target-http / target-agent）；不声明时界面按\"待确认\"显示，也不计入突破凭证。"
          : undefined),
    };
  }

  /** 隧道列表（带 `legit` 判定与可读标签）。 */
  listTunnels(id: string, f: unknown = {}): TunnelView[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["status"]) {
      where.push("t.status = ?");
      args.push(fo["status"]);
    }
    if (fo["asset_id"]) {
      where.push("t.asset_id = ?");
      args.push(fo["asset_id"]);
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 200, 1000);
    return db.prepare<TunnelRow & { asset_ip: string | null; webshell_url: string | null }>(
      `SELECT t.*, a.ip AS asset_ip, w.url AS webshell_url FROM tunnel t
      LEFT JOIN asset a ON a.id = t.asset_id
      LEFT JOIN webshell w ON w.id = t.webshell_id ${clause} ORDER BY t.id DESC LIMIT ?`,
    ).all(...(args as never[]), limit).map((t) => ({
      ...t,
      legit: tunnelIsLegit(t.entry_kind),
      entry_kind_label: t.entry_kind === null ? null : (TUNNEL_ENTRY_KINDS[t.entry_kind] ?? null),
    }));
  }

  /**
   * 更新隧道。
   *
   * 此前**完全不校验** `entry_kind` / `status`：新增时被规范化成 NULL，
   * 更新时却能直接写任意字符串进库，把 legit 判定彻底绕过。这里与新增路径对齐。
   */
  updateTunnel(id: string, tId: unknown, patch: unknown = {}): { readonly updated: boolean } {
    const db = this.db(id);
    const p = asRecord(patch);
    const fields = ["status", "check_note", "latency_ms", "last_check", "listen", "reach", "entry", "entry_kind", "pid", "command", "note"] as const;
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const key of fields) {
      if (p[key] === undefined) continue;
      let value: unknown = p[key];
      if (key === "entry_kind") {
        const raw = value === null ? "" : String(value).trim();
        if (raw !== "" && TUNNEL_ENTRY_KINDS[raw] === undefined) {
          throw new Error("entry_kind 非法：" + JSON.stringify(value) + "。合法值只有 "
            + Object.keys(TUNNEL_ENTRY_KINDS).join(" / ") + "。");
        }
        value = raw === "" ? null : raw;
      }
      if (key === "status") {
        const raw = String(value).trim();
        if (!TUNNEL_STATUSES.includes(raw)) {
          throw new Error("tunnel status 非法：" + JSON.stringify(value) + "。合法值只有 " + TUNNEL_STATUSES.join(" / ") + "。");
        }
        value = raw;
      }
      sets.push(`${key} = ?`);
      args.push(value);
    }
    if (sets.length === 0) throw new Error("nothing to update");
    sets.push("updated_at = ?");
    args.push(nowIso());
    const result = db.prepare(`UPDATE tunnel SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]), intOr(tId, -1));
    if (result.changes === 0) throw new Error("tunnel not found");
    return { updated: true };
  }

  /* ---------- 当前测试面板 ---------- */

  /**
   * 当前测试面板：正在测的资产 + 最近动过的资产 + 待测队列。
   * 攻击链页面的「当前正在测」区块用它，客户端每隔几秒轮询一次实现实时更新。
   */
  activeTests(id: string, f: unknown = {}): {
    readonly testing: readonly unknown[];
    readonly recent: readonly unknown[];
    readonly queue: readonly unknown[];
    readonly stats: TestStats;
    readonly untested: number;
    readonly at: string;
  } {
    const db = this.db(id);
    const fo = asRecord(f);
    const limit = Math.min(Number(fo["limit"]) || 8, 50);
    const select = `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state,
        COALESCE(a.test_status, 'untested') AS test_status, a.test_notes, a.test_surface,
        a.test_updated_at, a.test_updated_by, COALESCE(a.blocked_count, 0) AS blocked_count,
        a.priority, a.potential,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
        (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns,
        (SELECT COUNT(*) FROM webshell w WHERE w.asset_id = a.id) AS webshells,
        (SELECT COUNT(*) FROM tunnel t WHERE t.asset_id = a.id) AS tunnels`;
    const testing = db.prepare<Record<string, unknown>>(
      `${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'testing'
      ORDER BY a.test_updated_at DESC, a.id DESC LIMIT ?`,
    ).all(limit);
    /* 最近动过：排除正在测的，避免两个区块重复 */
    const recent = db.prepare<Record<string, unknown>>(
      `${select} FROM asset a
      WHERE a.test_updated_at IS NOT NULL AND COALESCE(a.test_status, 'untested') <> 'testing'
      ORDER BY a.test_updated_at DESC LIMIT ?`,
    ).all(limit);
    /* 待测队列：还没动的，按易打性 + 端口数排出先打哪几台 */
    const queue = db.prepare<Record<string, unknown>>(
      `${select} FROM asset a
      WHERE COALESCE(a.test_status, 'untested') = 'untested'
      ORDER BY CASE COALESCE(a.priority, '') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') DESC, a.ip_int
      LIMIT ?`,
    ).all(limit);
    const untested = Number(
      db.prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM asset a WHERE COALESCE(a.test_status, 'untested') = 'untested'",
      ).get()?.n ?? 0,
    );
    return { testing, recent, queue, stats: this.testStats(id), untested, at: nowIso() };
  }

  /* ---------- 写库原语 ---------- */

  /** 插入一条观测事实。 */
  private observe(
    db: TypedDb, entityKind: string, entityId: number, attr: string | null,
    value: unknown, provenance: string | null, tool: string | null, rawRef: string | number | null,
  ): void {
    db.prepare(
      `INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at, raw_ref)
      VALUES(?,?,?,?,?,?,?,?)`,
    ).run(entityKind, entityId, attr, value === null || value === undefined ? null : String(value),
      provenance ?? "unknown", tool, nowIso(), rawRef === null ? null : String(rawRef));
  }

  /** 插入/刷新一条关系边（`last_seen` 随每次采集刷新）。 */
  private edge(
    db: TypedDb, srcKind: string, srcId: unknown, dstKind: string, dstId: unknown,
    relation: string, confidence: number | null = null,
  ): void {
    db.prepare(
      `INSERT INTO edge(src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET last_seen = excluded.last_seen`,
    ).run(srcKind, String(srcId), dstKind, String(dstId), relation, confidence, nowIso(), nowIso());
  }

  /** 插入/刷新一个 C 段。 */
  private upsertSegment(db: TypedDb, seg: Record<string, unknown>): void {
    const cidr = str(seg["cidr"], "");
    db.prepare(
      `INSERT INTO segment(cidr, ip_start, ip_end, org, asn, country, city, source, first_seen, last_seen)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(cidr) DO UPDATE SET
        org = COALESCE(excluded.org, segment.org),
        asn = COALESCE(excluded.asn, segment.asn),
        country = COALESCE(excluded.country, segment.country),
        city = COALESCE(excluded.city, segment.city),
        last_seen = excluded.last_seen`,
    ).run(
      cidr, nullableStr(seg["ip_start"]), nullableStr(seg["ip_end"]), nullableStr(seg["org"]),
      nullableStr(seg["asn"]), nullableStr(seg["country"]), nullableStr(seg["city"]),
      nullableStr(seg["source"]), nullableStr(seg["first_seen"]) ?? nowIso(), nowIso(),
    );
  }

  /**
   * 插入/刷新一台资产，返回其 id。
   *
   * `discovered_at` = 本库第一次看到这条资产的时刻；重复采集只刷新 `last_seen`，
   * **不动 `discovered_at`**（否则"发现时间"会变成"最后一次采集时间"，等于没记）。
   */
  private upsertAsset(db: TypedDb, a: Record<string, unknown>): number {
    const ip = str(a["ip"], "");
    const cidr = str(a["segment_cidr"], "") || cidrOf(ip);
    this.upsertSegment(db, { cidr, source: a["provenance"], first_seen: a["first_seen"] });
    const t = nowIso();
    db.prepare(
      `INSERT INTO asset(segment_cidr, ip, ip_int, state, primary_name, confidence, first_seen, last_seen, discovered_at, scope)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(segment_cidr, ip) DO UPDATE SET
        state = COALESCE(excluded.state, asset.state),
        primary_name = COALESCE(excluded.primary_name, asset.primary_name),
        scope = COALESCE(NULLIF(asset.scope, ''), excluded.scope),
        discovered_at = COALESCE(NULLIF(asset.discovered_at, ''), excluded.discovered_at),
        last_seen = excluded.last_seen`,
    ).run(
      cidr, ip, ipToInt(ip), str(a["state"], "unknown"), nullableStr(a["primary_name"]),
      nullableInt(a["confidence"]), nullableStr(a["first_seen"]) ?? t, t, nullableStr(a["discovered_at"]) ?? t,
      str(a["scope"], "") || scopeOfIp(ip),
    );
    const row = db.prepare<{ id: number }>("SELECT id FROM asset WHERE segment_cidr = ? AND ip = ?").get(cidr, ip);
    return row?.id ?? 0;
  }

  /**
   * `asset_fts` 这张虚拟表在这个库里存在吗。
   *
   * **为什么需要单独的守卫**：`HAS_FTS5` 是**进程级**常量（模块加载时探一次），
   * 而"这个库有没有建过 asset_fts"是**数据级**事实。两者会不一致：
   *
   *   · 用户先在 Node 22.14（无 FTS5）上建了库 → 库里没有 asset_fts；
   *   · 升级到 22.23（有 FTS5）后跑同一个库 → HAS_FTS5=true，但表不存在。
   *
   * 此时任何写资产的路径（`importBundle` / `#reindex`）都会在
   * `DELETE FROM asset_fts` 上抛 `no such table` —— 而它在事务里，
   * 于是**整份采集结果被回滚**，用户只看到一句 SQL 报错。
   */
  private hasFtsTable(db: TypedDb): boolean {
    /* 缓存：它在两条热路径上（每次检索、每次写资产）。表只会在建库/升级时出现，
       结果在同一个句柄生命周期内不会变。 */
    const cached = this.ftsTableCache.get(db);
    if (cached !== undefined) return cached;
    let present = false;
    try {
      present = db.prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'asset_fts'",
      ).get() !== undefined;
    } catch {
      present = false;
    }
    this.ftsTableCache.set(db, present);
    return present;
  }

  /**
   * 升级路径补索引：库里已有资产但 `asset_fts` 为空时，把存量资产灌进索引。
   *
   * **只在"索引空 + 资产非空"时触发** —— 这正是"库是在无 FTS5 的 Node 上建的、
   * 现在换到有 FTS5 的 Node"这一种情形。不做这一步的话，升级后所有**存量**资产
   * 都搜不到（`listAssets({q})` 走 MATCH 返回 0 条），而新采集的能搜到 ——
   * 表现是"按关键字只搜得到最近的数据"，极难归因。
   *
   * 代价是升级后首次打开靶标时多一轮全量 reindex；之后索引不再为空，不再触发。
   */
  private ensureFtsBackfill(db: TypedDb): void {
    try {
      if (!this.hasFtsTable(db)) return;
      const indexed = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM asset_fts").get();
      if (Number(indexed?.n ?? 0) > 0) return;
      const assets = db.prepare<{ id: number }>("SELECT id FROM asset").all();
      if (assets.length === 0) return;
      for (const a of assets) this.reindex(db, a.id);
    } catch {
      /* 回填失败不该阻断打开靶标：检索会少命中，但面板与写入都还能用 */
    }
  }

  /**
   * 重建单个资产的全文索引行（列表、图谱、后续智能体共用一份索引）。
   *
   * 没有 FTS5 时不建索引表，这里直接跳过 —— 检索走 `listAssets` 的 LIKE 分支，
   * 所以上面那几段取值也不用白跑。
   */
  private reindex(db: TypedDb, assetId: number): void {
    if (!HAS_FTS5 || !this.hasFtsTable(db)) return;
    const a = db.prepare<AssetRow>("SELECT * FROM asset WHERE id = ?").get(assetId);
    if (a === undefined) return;
    const names = db.prepare<{ name: string }>("SELECT name FROM asset_name WHERE asset_id = ?").all(assetId).map((r) => r.name).join(" ");
    const banners = db.prepare<{ banner: string | null }>("SELECT banner FROM port WHERE asset_id = ? AND banner IS NOT NULL")
      .all(assetId).map((r) => r.banner ?? "").join(" ");
    const titles = db.prepare<{ title: string | null }>("SELECT title FROM port WHERE asset_id = ? AND title IS NOT NULL")
      .all(assetId).map((r) => r.title ?? "").join(" ")
      + " " + db.prepare<{ url: string | null }>("SELECT url FROM port WHERE asset_id = ? AND url IS NOT NULL")
        .all(assetId).map((r) => r.url ?? "").join(" ")
      + " " + db.prepare<{ name: string | null; product: string | null; version: string | null }>(
        "SELECT s.product, s.name, s.version FROM service s JOIN port p ON p.id = s.port_id WHERE p.asset_id = ?",
      ).all(assetId).map((r) => [r.name, r.product, r.version].filter(Boolean).join(" ")).join(" ");
    const fps = db.prepare<{ vendor: string | null; product: string | null; version: string | null; category: string | null }>(
      "SELECT vendor, product, version, category FROM fingerprint WHERE asset_id = ?",
    ).all(assetId).map((r) => [r.category, r.vendor, r.product, r.version].filter(Boolean).join(" ")).join(" ");
    db.prepare("DELETE FROM asset_fts WHERE asset_id = ?").run(String(assetId));
    db.prepare("INSERT INTO asset_fts(asset_id, ip, names, banners, titles, fingerprints) VALUES(?,?,?,?,?,?)")
      .run(String(assetId), a.ip, names, banners, titles, fps);
  }

  /* ---------- 证据截图 ---------- */

  /** 截图的可访问引用：面板/报告里贴的就是它（相对靶标目录）。 */
  shotUrlOf(id: string, shot: { readonly file: string }): string {
    void id;
    return "shots/" + shot.file;
  }

  /**
   * 登记一张证据截图（把图片拷进靶标目录，库里只存文件名与元数据）。
   *
   * ## 为什么必须显式区分 kind
   *
   * · `screenshot` —— 现场截图，可以直接当验收材料；
   * · `card`       —— 由当日记录生成的"证据摘录卡"，**不是现场截图**。
   *
   * 两者混在一起，验收人会把生成的卡当成现场证据 —— 这是最不能出的事，
   * 所以库里存 kind、面板与报告都按它标不同颜色与文案。
   */
  addShot(id: string, shot: unknown = {}): {
    readonly ok: boolean; readonly id: number; readonly file: string; readonly kind: string;
    readonly bytes: number; readonly sha256: string;
  } {
    const db = this.db(id);
    const input = asRecord(shot);
    const dir = this.shotsDirOf(id);
    mkdirSync(dir, { recursive: true });
    const kind = input["kind"] === "card" ? "card" : "screenshot";
    /* 文件名：显式给就用给的（去路径分隔符），否则按 时间-得分点-序号 生成 */
    const ext = (() => {
      const src = str(input["path"], "");
      const m = /\.([A-Za-z0-9]{2,5})$/.exec(src);
      return m !== null && m[1] !== undefined ? m[1].toLowerCase() : "png";
    })();
    const stamp = String(input["captured_at"] ?? new Date().toISOString()).replace(/[-:T]/g, "").slice(0, 14);
    const slug = str(input["point_code"], "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "shot";
    let file = str(input["file"], "").trim().replace(/[/\\]/g, "-");
    if (file === "") {
      let n = 1;
      do {
        file = stamp + "-" + slug + "-" + String(n).padStart(2, "0") + "." + ext;
        n += 1;
      } while (existsSync(join(dir, file)));
    }
    const dest = assertPathWithin(join(dir, file), [dir]);
    let buf: Buffer;
    const dataBase64 = input["data_base64"];
    const srcPath = input["path"];
    if (typeof dataBase64 === "string" && dataBase64.trim() !== "") {
      buf = Buffer.from(dataBase64.replace(/^data:[^,]+,/, ""), "base64");
    } else if (typeof srcPath === "string" && srcPath.trim() !== "") {
      const src = isAbsolute(srcPath) ? srcPath : join(this.dirOf(id), srcPath);
      if (!existsSync(src)) throw new Error("shot source not found: " + srcPath);
      buf = readFileSync(src);
    } else {
      throw new Error("shot path or data_base64 required");
    }
    if (buf.length === 0) throw new Error("shot file is empty");
    writeFileSync(dest, buf);
    const head4 = buf.subarray(0, 4).toString("latin1");
    const mime = /^\x89PNG/.test(head4)
      ? "image/png"
      : (buf.subarray(0, 2).toString("latin1") === "\xff\xd8"
        ? "image/jpeg"
        : (head4 === "RIFF" ? "image/webp" : "application/octet-stream"));
    const dim = pngSize(buf);
    const pointId = (() => {
      const code = str(input["point_code"], "").trim();
      if (code === "") return nullableInt(input["point_id"]);
      const row = db.prepare<{ id: number }>("SELECT id FROM score_point WHERE code = ?").get(code);
      return row === undefined ? null : Number(row.id);
    })();
    const now = nowIso();
    const agent = str(input["agent"], "").trim() || null;
    const sha = createHash("sha256").update(buf).digest("hex");
    const cur = db.prepare(
      `INSERT INTO shot (point_id, hit_id, asset_id, vuln_id, target, label, note,
        file, kind, mime, bytes, width, height, sha256, source_ref, captured_at, found_by_agent, agent, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      pointId,
      nullableInt(input["hit_id"]),
      nullableInt(input["asset_id"]),
      nullableInt(input["vuln_id"]),
      str(input["target"], "").trim() || null,
      str(input["label"], "").trim() || null,
      str(input["note"], "").trim() || null,
      file, kind, mime, buf.length, dim.width, dim.height, sha,
      str(input["source_ref"], "").trim() || str(input["path"], "").trim() || null,
      str(input["captured_at"], now).trim() || now,
      agent,
      agent,
      now,
    );
    return { ok: true, id: cur.lastInsertRowid, file, kind, bytes: buf.length, sha256: sha };
  }

  /** 证据截图列表（可按得分点 / 命中 / 资产 / 漏洞过滤）。 */
  listShots(id: string, f: unknown = {}): { readonly ok: boolean; readonly items: readonly ShotListItem[]; readonly total: number } {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["point_code"] !== undefined && fo["point_code"] !== null && String(fo["point_code"]) !== "") {
      where.push("s.point_id = (SELECT id FROM score_point WHERE code = ?)");
      args.push(String(fo["point_code"]));
    }
    for (const key of ["hit_id", "asset_id", "vuln_id"] as const) {
      if (fo[key] !== undefined && fo[key] !== null && String(fo[key]) !== "") {
        where.push("s." + key + " = ?");
        args.push(Number(fo[key]));
      }
    }
    const sql = `SELECT s.*, p.code AS point_code, p.name AS point_name
      FROM shot s LEFT JOIN score_point p ON p.id = s.point_id
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY s.captured_at, s.id LIMIT ?`;
    const items = db.prepare<ShotRow & { point_code: string | null; point_name: string | null }>(sql)
      .all(...(args as never[]), Math.min(Number(fo["limit"]) || 500, 2000));
    return {
      ok: true,
      items: items.map((x) => ({ ...x, url: this.shotUrlOf(id, x) })),
      total: items.length,
    };
  }

  /** 删除一张截图（连同磁盘文件）。 */
  deleteShot(id: string, shotId: unknown): { readonly ok: boolean; readonly id: number } {
    const db = this.db(id);
    const target = intOr(shotId, -1);
    const row = db.prepare<ShotRow>("SELECT * FROM shot WHERE id = ?").get(target);
    if (row === undefined) throw new Error("shot not found: " + target);
    try {
      const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)]);
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* 文件不在就当已删 */
    }
    db.prepare("DELETE FROM shot WHERE id = ?").run(target);
    return { ok: true, id: target };
  }

  /**
   * 读一张截图的字节（面板用 `<img src="data:...">` 显示）。
   *
   * 走 base64 而不是新开静态路由：这条 HTTP 桥已经做了同源校验，
   * 再开一个能按文件名读任意路径的静态入口，等于绕开校验读靶标目录。
   */
  readShot(id: string, shotId: unknown): {
    readonly ok: boolean; readonly id: number; readonly mime: string; readonly bytes: number; readonly base64: string;
  } {
    const db = this.db(id);
    const target = intOr(shotId, -1);
    const row = db.prepare<ShotRow>("SELECT * FROM shot WHERE id = ?").get(target);
    if (row === undefined) throw new Error("shot not found: " + target);
    const p = assertPathWithin(join(this.shotsDirOf(id), row.file), [this.shotsDirOf(id)]);
    if (!existsSync(p)) throw new Error("shot file missing on disk: " + row.file);
    const buf = readFileSync(p);
    return { ok: true, id: Number(row.id), mime: row.mime ?? "image/png", bytes: buf.length, base64: buf.toString("base64") };
  }

  /**
   * 给一批得分条目挂"代表截图"，**每个得分点最多 3 张**。
   *
   * 批量得分点（终端权限会有几十条命中）逐条贴图既没信息量又把页面/报告撑爆。
   * 选取优先级：命中级 > 得分点+目标级 > 得分点级；
   * 同一优先级里**现场截图优先于生成的证据卡** —— 否则批量得分点里
   * 后补的卡片会把真截图挤出前 3 张（实测：60 台终端只挑出 3 张卡片）。
   */
  private representativeShots(
    id: string,
    groups: readonly { readonly point_id: number; readonly point_code?: string; readonly hit_ids?: readonly number[]; readonly asset_id?: number | null; readonly target?: string | null }[],
    limit = 3,
  ): Map<number, ShotRow[]> {
    const db = this.db(id);
    let all: ShotRow[] = [];
    try {
      all = db.prepare<ShotRow>("SELECT * FROM shot ORDER BY captured_at, id").all();
    } catch {
      all = [];
    }
    const out = new Map<number, ShotRow[]>();
    if (all.length === 0) return out;
    const byHit = new Map<number, ShotRow[]>();
    const byPoint = new Map<number, ShotRow[]>();
    for (const sh of all) {
      if (sh.hit_id !== null) {
        const bucket = byHit.get(Number(sh.hit_id));
        if (bucket === undefined) byHit.set(Number(sh.hit_id), [sh]);
        else bucket.push(sh);
      }
      if (sh.point_id !== null) {
        const bucket = byPoint.get(Number(sh.point_id));
        if (bucket === undefined) byPoint.set(Number(sh.point_id), [sh]);
        else bucket.push(sh);
      }
    }
    const rank = (sh: ShotRow): number => (sh.kind === "card" ? 1 : 0);
    for (const g of groups) {
      /* 候选池按"关联强度"分层：命中级 → 目标/资产级 → 得分点级 */
      const pool: ShotRow[] = [];
      for (const hid of g.hit_ids ?? []) pool.push(...(byHit.get(Number(hid)) ?? []));
      const pointShots = byPoint.get(Number(g.point_id)) ?? [];
      const gTarget = g.target ?? null;
      const gAsset = g.asset_id ?? null;
      for (const sh of pointShots) {
        if (gTarget !== null && sh.target !== null && String(sh.target) === String(gTarget)) pool.push(sh);
        else if (gAsset !== null && sh.asset_id === gAsset) pool.push(sh);
      }
      for (const sh of pointShots) pool.push(sh);
      const picked: ShotRow[] = [];
      const seen = new Set<number>();
      const orderedList = pool.slice().sort((a, b) => rank(a) - rank(b)
        || String(a.captured_at ?? "").localeCompare(String(b.captured_at ?? ""))
        || Number(a.id) - Number(b.id));
      for (const sh of orderedList) {
        if (seen.has(sh.id)) continue;
        seen.add(sh.id);
        picked.push(sh);
        if (picked.length >= limit) break;
      }
      out.set(Number(g.point_id), picked);
    }
    return out;
  }

  /* ---------- 攻击文件 ---------- */

  /**
   * 保存一个攻击文件到「目标文件夹」并登记。`evidence` 必填 ——
   * 只收录实际生效的东西（"存档一堆跑不通的脚本"是这列存在的唯一理由）。
   */
  addAttackFile(id: string, f: unknown = {}): { readonly target: string; readonly name: string; readonly kind: string; readonly path: string } {
    const db = this.db(id);
    const input = asRecord(f);
    const target = str(input["target"], "").trim();
    if (target === "") throw new Error("attack file target required（IP / URL / C 段）");
    const name = str(input["name"], "").trim().replace(/[/\\]/g, "-");
    if (name === "") throw new Error("attack file name required");
    const evidence = str(input["evidence"], "").trim();
    if (evidence === "") throw new Error("attack file evidence required：只收录实际生效的脚本/POC/EXP，请写明验证效果");
    const slug = slugTarget(target);
    const dir = join(this.attackFilesDirOf(id), slug);
    mkdirSync(dir, { recursive: true });
    /* target 为 `..`/`.` 时 slugTarget 会原样返回，join 之后就跑出 attack-files/ 了。
       写路径也过一遍根目录校验，保证文件一定落在本靶标目录内。 */
    const filePath = assertPathWithin(join(dir, name), [this.attackFilesDirOf(id)]);
    const content = input["content"];
    const srcPath = input["path"];
    if (typeof content === "string" && content.length > 0) {
      writeFileSync(filePath, content, "utf8");
    } else if (typeof srcPath === "string" && srcPath.length > 0) {
      const src = isAbsolute(srcPath) ? srcPath : join(this.dirOf(id), srcPath);
      if (!existsSync(src)) throw new Error("source path not found: " + srcPath);
      copyFileSync(src, filePath);
    } else {
      throw new Error("attack file content or path required");
    }
    const wanted = str(input["kind"], "");
    const kind = (ATTACK_FILE_KINDS as readonly string[]).includes(wanted) ? wanted : "script";
    db.prepare(
      `INSERT INTO attack_file(target, target_kind, name, kind, path, description, evidence, asset_id, vuln_id, created_by, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target, name) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, description = excluded.description,
        evidence = excluded.evidence, created_at = excluded.created_at`,
    ).run(
      target, nullableStr(input["target_kind"]), name, kind, filePath,
      nullableStr(input["description"]), evidence, nullableInt(input["asset_id"]), nullableInt(input["vuln_id"]),
      nullableStr(input["created_by"]), nowIso(),
    );
    return { target, name, kind, path: filePath };
  }

  /** 攻击文件列表（按目标 + 名称排序）。 */
  listAttackFiles(id: string, f: unknown = {}): readonly AttackFileRow[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    if (fo["target"]) {
      where.push("target = ?");
      args.push(fo["target"]);
    }
    if (fo["kind"]) {
      where.push("kind = ?");
      args.push(fo["kind"]);
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    return db.prepare<AttackFileRow>(`SELECT * FROM attack_file ${clause} ORDER BY target, name`).all(...(args as never[]));
  }

  /** 攻击文件按目标分组（每个 IP / URL / C 段一个文件夹）。 */
  attackFileTree(id: string): readonly { readonly target: string; readonly folder: string; readonly count: number; readonly files: readonly AttackFileRow[] }[] {
    const groups = new Map<string, { target: string; folder: string; count: number; files: AttackFileRow[] }>();
    for (const row of this.listAttackFiles(id, {})) {
      let g = groups.get(row.target);
      if (g === undefined) {
        g = { target: row.target, folder: slugTarget(row.target), count: 0, files: [] };
        groups.set(row.target, g);
      }
      g.files.push(row);
      g.count += 1;
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
  }

  /** 读一个攻击文件的内容（路径必须在本靶标目录内）。 */
  readAttackFile(id: string, fileId: unknown): (AttackFileRow & { readonly content: string }) | undefined {
    const row = this.db(id).prepare<AttackFileRow>("SELECT * FROM attack_file WHERE id = ?").get(intOr(fileId, -1));
    if (row === undefined) return undefined;
    let content = "";
    try {
      /* path 来自库列（智能体写过）：必须限定在本靶标目录内，
         否则面板会变成任意文件读取器 */
      const safe = assertPathWithin(row.path, [this.dirOf(id)]);
      content = readFileSync(safe, "utf8");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      content = "（拒绝或读取失败：" + message + "）";
    }
    return { ...row, content };
  }

  /* ---------- 知识库（全局共享） ---------- */

  /** 打开（必要时创建）全局知识库。与靶标库分开，跨靶标共享。 */
  kb(): TypedDb {
    if (this.kbHandle !== null) return this.kbHandle;
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.pocsDirOf(), { recursive: true });
    const handle = openTypedDb(this.knowledgePath());
    /* 同上：没有 FTS5 就不建 poc_fts，POC 检索退化成 LIKE（见 searchPocs） */
    handle.exec(HAS_FTS5 ? KNOWLEDGE_DDL + POC_FTS_DDL : KNOWLEDGE_DDL);
    migrateKnowledge(handle);
    this.kbHandle = handle;
    return handle;
  }

  /** 重建一条 POC 的全文索引行。无 FTS5 时直接跳过。 */
  private reindexPoc(db: TypedDb, pocId: number): void {
    if (!HAS_FTS5) return;
    db.prepare("DELETE FROM poc_fts WHERE poc_id = ?").run(String(pocId));
    const p = db.prepare<PocRow>("SELECT * FROM poc WHERE id = ?").get(pocId);
    if (p === undefined) return;
    db.prepare("INSERT INTO poc_fts(poc_id, title, cve, component, versions, tags, description, content) VALUES(?,?,?,?,?,?,?,?)")
      .run(String(p.id), p.title, p.cve ?? "", p.component ?? "", p.versions ?? "", p.tags ?? "", p.description ?? "", p.content ?? "");
  }

  /**
   * 落库一份通用 POC/EXP。同名（code）会合并刷新，便于"同一漏洞的新版本 POC"覆盖旧版。
   *
   * `code` 会被当成目录名：**必须净化**。`code='../../escaped-poc'` 曾能把正文
   * 写到数据根目录之外（`deletePoc` 早有 startsWith 防护，写路径却漏了）。
   */
  savePoc(p: unknown = {}): { readonly poc: PocRow; readonly created: boolean; readonly path: string | null } {
    const db = this.kb();
    const input = asRecord(p);
    const title = str(input["title"], "").trim();
    if (title === "") throw new Error("poc.title required（写清是什么漏洞/组件的 POC）");
    const wantedKind = String(input["kind"] ?? "");
    const kind = POC_KINDS.includes(wantedKind) ? wantedKind : (wantedKind.toLowerCase() === "exp" ? "exp" : "poc");
    const wantedSource = String(input["source"] ?? "");
    const source = POC_SOURCES.includes(wantedSource) ? wantedSource : "self";
    const rawCode = str(input["code"], "").trim();
    const code = rawCode === ""
      ? slugPoc(title, input["cve"])
      : rawCode.replace(/[^\w.\u4e00-\u9fa5-]+/g, "-").replace(/^[.-]+/, "");
    if (code === "") throw new Error("poc.code invalid（净化后为空，请用字母/数字/中文/短横线）");
    const dir = assertPathWithin(join(this.pocsDirOf(), code), [this.pocsDirOf()]);
    mkdirSync(dir, { recursive: true });

    /* 正文：优先用传入 content，其次从 path 读；两者都没有则只登记元数据 */
    let content = typeof input["content"] === "string" ? input["content"] : "";
    if (content === "" && typeof input["path"] === "string" && input["path"].length > 0) {
      const src = isAbsolute(input["path"]) ? input["path"] : join(this.pocsDirOf(), input["path"]);
      if (!existsSync(src)) throw new Error("poc content or existing path required: " + input["path"]);
      content = readFileSync(src, "utf8");
    }
    let filePath: string | null = null;
    if (content !== "") {
      /* filename 也不能带路径分隔符，否则能从 code 目录里再跳出去 */
      const filename = str(input["filename"], "").trim().replace(/[/\\]/g, "-") || defaultPocFilename(title, kind, input["language"]);
      filePath = assertPathWithin(join(dir, filename), [this.pocsDirOf()]);
      writeFileSync(filePath, content, "utf8");
    }
    const existing = db.prepare<PocRow>("SELECT * FROM poc WHERE code = ?").get(code);
    const verified = input["verified"] === undefined || input["verified"] === null
      ? (existing?.verified ?? 0)
      : (input["verified"] ? 1 : 0);
    const now = nowIso();
    /* 归类：允许自定义值，但内置 code 之外一律归 other，避免面板出现一堆拼写变体 */
    const rawCategory = str(input["category"], "").trim() || (existing?.category ?? "");
    const category = rawCategory === ""
      ? "other"
      : (POC_CATEGORIES.some((c) => c.code === rawCategory) ? rawCategory : "other");
    db.prepare(
      `INSERT INTO poc(code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, content, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title, kind = excluded.kind, category = excluded.category,
        cve = COALESCE(excluded.cve, poc.cve),
        component = COALESCE(excluded.component, poc.component), versions = COALESCE(excluded.versions, poc.versions),
        severity = COALESCE(excluded.severity, poc.severity), language = COALESCE(excluded.language, poc.language),
        source = excluded.source, source_url = COALESCE(excluded.source_url, poc.source_url),
        description = COALESCE(excluded.description, poc.description), usage = COALESCE(excluded.usage, poc.usage),
        content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE poc.content END,
        path = COALESCE(excluded.path, poc.path),
        verified = excluded.verified, verified_note = COALESCE(excluded.verified_note, poc.verified_note),
        engagement_id = COALESCE(excluded.engagement_id, poc.engagement_id),
        engagement_name = COALESCE(excluded.engagement_name, poc.engagement_name),
        asset_target = COALESCE(excluded.asset_target, poc.asset_target),
        found_by_agent = COALESCE(excluded.found_by_agent, poc.found_by_agent),
        tags = COALESCE(excluded.tags, poc.tags), updated_at = excluded.updated_at`,
    ).run(
      code, title, kind, category, nullableStr(input["cve"]), nullableStr(input["component"]), nullableStr(input["versions"]),
      nullableStr(input["severity"]), nullableStr(input["language"]), source, nullableStr(input["source_url"]),
      nullableStr(input["description"]), nullableStr(input["usage"]), content, filePath, verified,
      nullableStr(input["verified_note"]), existing?.hit_count ?? 0, existing?.used_on ?? null, nullableStr(input["tags"]),
      nullableStr(input["engagement_id"]), nullableStr(input["engagement_name"]), nullableStr(input["asset_target"]),
      nullableStr(input["found_by_agent"]), nullableStr(input["created_by"]), existing?.created_at ?? now, now,
    );
    const row = db.prepare<PocRow>("SELECT * FROM poc WHERE code = ?").get(code);
    if (row === undefined) throw new Error("poc save failed: " + code);
    this.reindexPoc(db, row.id);
    return { poc: row, created: existing === undefined, path: filePath };
  }

  /**
   * 检索知识库：Nday/1day 动手前的第一步。
   *
   * 全文优先（标题/编号/组件/版本/标签/描述/正文），命中不到再退化成 LIKE 子串匹配 ——
   * FTS5 缺席的构建上第一步会直接抛 `no such module`，被 catch 吃掉后走 LIKE。
   */
  searchPocs(f: unknown = {}): PocListItem[] {
    const db = this.kb();
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    const q = str(fo["q"], "").trim() || str(fo["query"], "").trim();
    if (q !== "") {
      const match = q.split(/\s+/).filter(Boolean).map((t) => "\"" + t.replace(/"/g, "") + "\"").join(" AND ");
      let ids: number[] = [];
      try {
        ids = db.prepare<{ poc_id: string }>("SELECT poc_id FROM poc_fts WHERE poc_fts MATCH ? LIMIT 200")
          .all(match).map((r) => Number(r.poc_id));
      } catch {
        ids = [];
      }
      if (ids.length === 0) {
        const like = "%" + q + "%";
        ids = db.prepare<{ id: number }>(
          `SELECT id FROM poc WHERE title LIKE ? OR cve LIKE ? OR component LIKE ?
          OR versions LIKE ? OR tags LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 200`,
        ).all(like, like, like, like, like, like, like).map((r) => r.id);
      }
      if (ids.length === 0) return [];
      where.push(`id IN (${placeholders(ids.length)})`);
      for (const id of ids) args.push(id);
    }
    if (fo["cve"]) {
      where.push("cve LIKE ?");
      args.push("%" + str(fo["cve"], "") + "%");
    }
    if (fo["component"]) {
      where.push("component LIKE ?");
      args.push("%" + str(fo["component"], "") + "%");
    }
    if (fo["kind"]) {
      where.push("kind = ?");
      args.push(String(fo["kind"]));
    }
    /* 归类筛选：支持一次给多个（category=rce,tunnel） */
    if (fo["category"]) {
      const list = String(fo["category"]).split(",").map((x) => x.trim()).filter(Boolean);
      if (list.length > 1) {
        where.push(`COALESCE(NULLIF(category, ''), 'other') IN (${placeholders(list.length)})`);
        for (const x of list) args.push(x);
      } else if (list.length === 1) {
        where.push("COALESCE(NULLIF(category, ''), 'other') = ?");
        args.push(list[0]);
      }
    }
    /* 来源溯源筛选：这条知识是在哪个靶标 / 哪台资产上发现并验证的 */
    if (fo["engagement"]) {
      where.push("(engagement_id = ? OR engagement_name LIKE ?)");
      args.push(String(fo["engagement"]), "%" + String(fo["engagement"]) + "%");
    }
    if (fo["asset_target"]) {
      where.push("asset_target LIKE ?");
      args.push("%" + str(fo["asset_target"], "") + "%");
    }
    if (fo["language"]) {
      where.push("language = ?");
      args.push(String(fo["language"]));
    }
    if (fo["source"]) {
      where.push("source = ?");
      args.push(String(fo["source"]));
    }
    if (fo["tag"]) {
      where.push("tags LIKE ?");
      args.push("%" + str(fo["tag"], "") + "%");
    }
    if (fo["verified"] === true || fo["verified"] === 1) where.push("verified = 1");
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 200, 1000);
    return db.prepare<PocListItem>(
      `SELECT id, code, title, kind, category, cve, component, versions, severity, language, source, source_url,
        description, usage, path, verified, verified_note, hit_count, used_on, tags,
        engagement_id, engagement_name, asset_target, found_by_agent, created_by, created_at, updated_at,
        LENGTH(COALESCE(content, '')) AS content_bytes,
        CASE WHEN COALESCE(content, '') = '' THEN 0 ELSE 1 END AS has_content
      FROM poc ${clause} ORDER BY verified DESC, hit_count DESC, updated_at DESC, id DESC LIMIT ?`,
    ).all(...(args as never[]), limit);
  }

  /** 取一条 POC 的完整内容（智能体要直接拿去用，所以连正文一起给）。 */
  getPoc(key: unknown): (PocRow & { readonly content: string }) | undefined {
    const db = this.kb();
    const raw = String(key ?? "").trim();
    if (raw === "") return undefined;
    const numeric = Number(raw);
    const row = Number.isFinite(numeric) && String(numeric) === raw
      ? db.prepare<PocRow>("SELECT * FROM poc WHERE id = ?").get(numeric)
      : db.prepare<PocRow>("SELECT * FROM poc WHERE code = ?").get(raw);
    if (row === undefined) return undefined;
    let content = row.content ?? "";
    if (content === "" && row.path !== null && row.path !== "") {
      try {
        /* 同 readAttackFile：path 是库列，读之前限定在 pocs/ 内 */
        content = readFileSync(assertPathWithin(row.path, [this.pocsDirOf()]), "utf8");
      } catch {
        content = "";
      }
    }
    return { ...row, content };
  }

  /** 标一条 POC 被用过（后续按复用次数排序，用得多的排前面）。 */
  markPocUsed(key: unknown, usedOn: unknown): { readonly ok: boolean; readonly id?: number; readonly code?: string; readonly hit_count?: number; readonly error?: string } {
    const db = this.kb();
    const row = this.getPoc(key);
    if (row === undefined) return { ok: false, error: "poc not found: " + String(key) };
    db.prepare("UPDATE poc SET hit_count = COALESCE(hit_count, 0) + 1, used_on = ?, updated_at = ? WHERE id = ?")
      .run(nullableStr(usedOn), nowIso(), row.id);
    return { ok: true, id: row.id, code: row.code, hit_count: (row.hit_count ?? 0) + 1 };
  }

  /** 补验证结论：只有验证过的 POC 才算"可直接用"，界面上会标出来。 */
  updatePoc(key: unknown, patch: unknown = {}): (PocRow & { readonly content: string }) | undefined {
    const db = this.kb();
    const row = this.getPoc(key);
    if (row === undefined) throw new Error("poc not found: " + String(key));
    const p = asRecord(patch);
    const next = {
      title: p["title"] !== undefined ? str(p["title"], row.title) : row.title,
      kind: p["kind"] !== undefined ? str(p["kind"], row.kind ?? "") : row.kind,
      category: p["category"] !== undefined ? str(p["category"], row.category ?? "") : row.category,
      cve: p["cve"] !== undefined ? nullableStr(p["cve"]) : row.cve,
      component: p["component"] !== undefined ? nullableStr(p["component"]) : row.component,
      versions: p["versions"] !== undefined ? nullableStr(p["versions"]) : row.versions,
      severity: p["severity"] !== undefined ? nullableStr(p["severity"]) : row.severity,
      language: p["language"] !== undefined ? nullableStr(p["language"]) : row.language,
      source: p["source"] !== undefined ? nullableStr(p["source"]) : row.source,
      source_url: p["source_url"] !== undefined ? nullableStr(p["source_url"]) : row.source_url,
      description: p["description"] !== undefined ? nullableStr(p["description"]) : row.description,
      usage: p["usage"] !== undefined ? nullableStr(p["usage"]) : row.usage,
      verified: p["verified"] === undefined || p["verified"] === null ? row.verified : (p["verified"] ? 1 : 0),
      verified_note: p["verified_note"] !== undefined ? nullableStr(p["verified_note"]) : row.verified_note,
      tags: p["tags"] !== undefined ? nullableStr(p["tags"]) : row.tags,
      engagement_id: p["engagement_id"] !== undefined ? nullableStr(p["engagement_id"]) : row.engagement_id,
      engagement_name: p["engagement_name"] !== undefined ? nullableStr(p["engagement_name"]) : row.engagement_name,
      asset_target: p["asset_target"] !== undefined ? nullableStr(p["asset_target"]) : row.asset_target,
      found_by_agent: p["found_by_agent"] !== undefined ? nullableStr(p["found_by_agent"]) : row.found_by_agent,
      content: typeof p["content"] === "string" && p["content"] !== "" ? p["content"] : row.content,
      path: row.path,
    };
    if (next.content !== row.content) {
      const dir = join(this.pocsDirOf(), row.code);
      mkdirSync(dir, { recursive: true });
      const filename = row.path !== null && row.path !== "" ? basename(row.path) : "poc.txt";
      next.path = join(dir, filename);
      writeFileSync(next.path, next.content ?? "", "utf8");
    }
    db.prepare(
      `UPDATE poc SET title = ?, kind = ?, category = ?, cve = ?, component = ?, versions = ?, severity = ?, language = ?,
      source = ?, source_url = ?, description = ?, usage = ?, verified = ?, verified_note = ?, tags = ?,
      engagement_id = ?, engagement_name = ?, asset_target = ?, found_by_agent = ?, content = ?, path = ?, updated_at = ?
      WHERE id = ?`,
    ).run(
      next.title, next.kind, next.category, next.cve, next.component, next.versions, next.severity, next.language,
      next.source, next.source_url, next.description, next.usage, next.verified, next.verified_note,
      next.tags, next.engagement_id, next.engagement_name, next.asset_target, next.found_by_agent,
      next.content, next.path, nowIso(), row.id,
    );
    this.reindexPoc(db, row.id);
    return this.getPoc(row.id);
  }

  /** 删除一条 POC（含落盘目录）。 */
  deletePoc(key: unknown): {
    readonly ok: boolean; readonly id?: number; readonly code?: string; readonly deleted?: boolean;
    readonly removed_files?: number; readonly error?: string;
  } {
    const db = this.kb();
    const row = this.getPoc(key);
    if (row === undefined) return { ok: false, error: "poc not found: " + String(key) };
    db.prepare("DELETE FROM poc WHERE id = ?").run(row.id);
    if (HAS_FTS5) db.prepare("DELETE FROM poc_fts WHERE poc_id = ?").run(String(row.id));
    /* 连落盘目录一起删（只在 pocs/ 内按 code 精确删除；删不掉不影响数据一致性） */
    let removedFiles = 0;
    try {
      const dir = join(this.pocsDirOf(), row.code);
      const root = this.pocsDirOf();
      if (existsSync(dir) && dir.startsWith(root)) {
        removedFiles = readdirSync(dir).length;
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* 忽略 */
    }
    return { ok: true, id: row.id, code: row.code, deleted: true, removed_files: removedFiles };
  }

  /** 知识库概览：界面顶部标签与智能体"先查库"时的一屏摘要。 */
  pocStats(): PocStats {
    const db = this.kb();
    /**
     * 取第一列的原值。
     *
     * ⚠️ **不能一律 `Number()`**：上游的 `one()` 是 `Object.values(...)[0] ?? 0`，
     * 原样返回 —— 所以 `MIN(created_at)` 给的是**时间戳字符串**（`"2024-01-01T…"`），
     * 而 `SUM(hit_count)` 给的是数字。我最初写成"一律转数字"，
     * 结果 `earliest` / `latest` 变成 `0`，面板的"最早/最近建立时间"整块消失。
     */
    const one = (sql: string, ...args: readonly string[]): number | string => {
      const row = db.prepare<Record<string, number | string | null>>(sql).get(...(args as never[]));
      if (row === undefined) return 0;
      const first = Object.values(row)[0];
      return first ?? 0;
    };
    /** 明确要数字的那几处（计数/求和）。 */
    const count = (sql: string, ...args: readonly string[]): number => {
      const v = one(sql, ...args);
      return typeof v === "number" ? v : (Number(v) || 0);
    };
    const byKind = db.prepare<{ kind: string; n: number }>(
      "SELECT COALESCE(kind, ?) AS kind, COUNT(*) AS n FROM poc GROUP BY kind ORDER BY n DESC",
    ).all("poc");
    const bySource = db.prepare<{ source: string; n: number }>(
      "SELECT COALESCE(source, ?) AS source, COUNT(*) AS n FROM poc GROUP BY source ORDER BY n DESC",
    ).all("self");
    const topComponents = db.prepare<{ component: string; n: number }>(
      `SELECT component, COUNT(*) AS n FROM poc WHERE component IS NOT NULL AND component <> ''
      GROUP BY component ORDER BY n DESC, component LIMIT 12`,
    ).all();
    /* 归类：面板按它分组，顺序按内置归类表走（不是按数量），这样面板分组稳定、不跳来跳去 */
    const catRows = db.prepare<{ category: string; n: number; verified: number | null }>(
      "SELECT COALESCE(NULLIF(category, ''), 'other') AS category, COUNT(*) AS n, SUM(verified) AS verified FROM poc GROUP BY category",
    ).all();
    const catMap = new Map(catRows.map((r) => [r.category, r] as const));
    const byCategory: { code: string; name: string; hint: string; n: number; verified: number }[] = POC_CATEGORIES.map((c) => {
      const row = catMap.get(c.code);
      return { code: c.code, name: c.name, hint: c.hint, n: row?.n ?? 0, verified: row?.verified ?? 0 };
    });
    /* 内置表之外的归类（用户自定义）也列出来，别让它们凭空消失 */
    for (const [code, row] of catMap) {
      if (POC_CATEGORIES.some((c) => c.code === code)) continue;
      byCategory.push({ code, name: pocCategoryName(code), hint: "", n: row.n, verified: row.verified ?? 0 });
    }
    const byEngagement = db.prepare<{ engagement: string; n: number; latest: string | null }>(
      `SELECT COALESCE(NULLIF(engagement_name, ''), NULLIF(engagement_id, ''), '(未标注来源靶标)') AS engagement,
        COUNT(*) AS n, MAX(created_at) AS latest FROM poc GROUP BY engagement ORDER BY n DESC, latest DESC LIMIT 30`,
    ).all();
    const topAssets = db.prepare<{ asset_target: string; n: number }>(
      `SELECT asset_target, COUNT(*) AS n FROM poc WHERE COALESCE(asset_target, '') <> ''
      GROUP BY asset_target ORDER BY n DESC, asset_target LIMIT 15`,
    ).all();
    return {
      total: count("SELECT COUNT(*) FROM poc"),
      verified: count("SELECT COUNT(*) FROM poc WHERE verified = 1"),
      withContent: count("SELECT COUNT(*) FROM poc WHERE COALESCE(content, '') <> ''"),
      reused: count("SELECT COALESCE(SUM(hit_count), 0) FROM poc"),
      /* 没标归类的条目数：面板会提示"还有 N 条未归类" */
      uncategorized: count("SELECT COUNT(*) FROM poc WHERE COALESCE(NULLIF(category, ''), 'other') = 'other'"),
      /* 这两个是**时间戳字符串**（上游原样返回 MIN/MAX 的结果），不是数字 */
      earliest: one("SELECT MIN(created_at) FROM poc"),
      latest: one("SELECT MAX(created_at) FROM poc"),
      byKind, bySource, byCategory, byEngagement, topAssets, topComponents,
      categories: POC_CATEGORIES.map((c) => ({ code: c.code, name: c.name, hint: c.hint })),
      dbPath: this.knowledgePath(),
    };
  }

  /* ---------- nuclei 模板库 ---------- */

  /** 找本机 nuclei 模板目录（装了模板才有；找不到返回 null）。 */
  nucleiTemplatesDir(): string | null {
    /* 环境适配里手填/自动分配的路径优先（Windows 尤其依赖这一条）。
       走 platform 层的唯一实现：模板目录探测有两份代码时，"用户配了却不生效"
       这类问题永远说不清是哪一份在起作用。 */
    try {
      const configured = nucleiTemplatesDirOf(loadPlatformConfig(this.root), this.root);
      if (configured !== null) return configured;
    } catch {
      /* 忽略配置读失败，继续默认探测 */
    }
    const candidates = [
      join(this.root, "toolkit", "nuclei-templates"),
      join(homedir(), ".local", "nuclei-templates"),
      join(homedir(), "nuclei-templates"),
      "/usr/share/nuclei-templates",
      "/opt/nuclei-templates",
    ];
    for (const p of candidates) if (existsSync(p)) return p;
    return null;
  }

  /** 模板索引缓存路径。 */
  private nucleiIndexPath(): string {
    return join(this.pocsDirOf(), ".nuclei-index.json");
  }

  /**
   * 模板索引（按需构建 + 落盘缓存）。
   *
   * 13k 个 yaml 逐个解析太慢，所以只抽 `path / name / severity / tags` 这几个检索字段，
   * 构建一次后一直复用。缓存**目录没变、且不超过 7 天**才用；否则重建。
   */
  private nucleiIndex(force = false): {
    readonly dir: string | null;
    readonly items: readonly (readonly [string, string, string, string])[];
    readonly cached?: boolean;
  } {
    const dir = this.nucleiTemplatesDir();
    if (dir === null) return { dir: null, items: [] };
    const cachePath = this.nucleiIndexPath();
    if (!force && existsSync(cachePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
        const cached = asRecord(parsed);
        const items = cached["items"];
        const fresh = cached["dir"] === dir && Array.isArray(items)
          && (Date.now() - Number(cached["built_at"] ?? 0) < 7 * 24 * 3600 * 1000);
        if (fresh && Array.isArray(items)) {
          const rows: (readonly [string, string, string, string])[] = [];
          for (const it of items) {
            if (Array.isArray(it) && it.length >= 4) {
              rows.push([String(it[0]), String(it[1]), String(it[2]), String(it[3])]);
            }
          }
          return { dir, items: rows, cached: true };
        }
      } catch {
        /* 缓存坏了就重建 */
      }
    }
    const items: (readonly [string, string, string, string])[] = [];
    const walk = (base: string, rel: string): void => {
      let entries: { name: string; isDirectory(): boolean }[] = [];
      try {
        entries = readdirSync(join(base, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const next = rel === "" ? e.name : rel + "/" + e.name;
        if (e.isDirectory()) {
          walk(base, next);
          continue;
        }
        if (!/\.ya?ml$/i.test(e.name)) continue;
        let head = "";
        try {
          head = readFileSync(join(base, next), "utf8").slice(0, 2000);
        } catch {
          continue;
        }
        const pick = (re: RegExp): string => {
          const m = re.exec(head);
          return m === null || m[1] === undefined ? "" : m[1].trim().replace(/^["']|["']$/g, "");
        };
        items.push([
          next,
          pick(/^\s*name:\s*(.+)$/m),
          pick(/^\s*severity:\s*(.+)$/m),
          pick(/^\s*tags:\s*(.+)$/m),
        ]);
      }
    };
    walk(dir, "");
    try {
      mkdirSync(this.pocsDirOf(), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ built_at: Date.now(), dir, items }), "utf8");
    } catch {
      /* 缓存写不进去不影响检索 */
    }
    return { dir, items, cached: false };
  }

  /** 模板库概览（界面与智能体"先查现成的"都能用）。 */
  templateStats(): TemplateStats {
    const { dir, items } = this.nucleiIndex();
    const cve = items.filter((x) => /cve-\d{4}-\d+/i.test(x[0])).length;
    return { dir, total: items.length, cve };
  }

  /**
   * 在本机 nuclei 模板库里检索：CVE 编号按文件名就能命中，组件/关键字再匹配 name 与 tags。
   * 这是"知识库里没有、但本机其实已有现成 POC"的那一层，先查它能省掉一轮互联网检索。
   */
  searchTemplates(q: unknown, limit = 40): TemplateSearch {
    const { dir, items } = this.nucleiIndex();
    if (dir === null) return { dir: null, total: 0, items: [] };
    const raw = String(q ?? "").trim();
    if (raw === "") return { dir, total: items.length, items: [] };
    const needle = raw.toLowerCase();
    const out: TemplateHit[] = [];
    for (const [path, name, severity, tags] of items) {
      const hay = (path + " " + name + " " + tags).toLowerCase();
      if (hay.includes(needle)) out.push({ path, name, severity, tags });
      if (out.length >= limit) break;
    }
    return { dir, total: items.length, items: out };
  }

  /* ---------- 会话总览与连通性实测 ---------- */

  /** 会话总览：给界面和提示词用的一屏摘要（含在线/离线统计）。 */
  sessionSummary(id: string): SessionSummary {
    const db = this.db(id);
    const shells = this.listWebshells(id, { limit: 1000 });
    const tunnels = this.listTunnels(id, { limit: 1000 });
    const creds = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM credential").get();
    const access = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM access_session").get();
    return {
      webshells: shells,
      tunnels,
      totals: {
        webshells: shells.length,
        webshellsOnline: shells.filter((s) => s.status === "online").length,
        tunnels: tunnels.length,
        tunnelsActive: tunnels.filter((s) => s.status === "active").length,
        /* 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算） */
        tunnelsLegit: tunnels.filter((s) => s.legit === true).length,
        tunnelsSelfOnly: tunnels.filter((s) => s.legit === false).length,
        credentials: Number(creds?.n ?? 0),
        access: Number(access?.n ?? 0),
      },
    };
  }

  /**
   * 实测连通性（host 平面专有：智能体跑在沙箱里，只有这里能直接发起连接）。
   * WebShell 发一次不带参数的 GET；隧道做一次 TCP 连接。
   * 结果回写 status / last_check / latency_ms / check_note。
   */
  async probeSessions(id: string, options: unknown = {}): Promise<ProbeResult> {
    const opts = asRecord(options);
    const timeout = Math.min(Math.max(Number(opts["timeoutMs"]) || 6000, 1000), 20000);
    const out: {
      webshells: { id: number; url: string; status: string; note: string; latency_ms: number }[];
      tunnels: { id: number; kind: string | null; listen: string | null; status: string; note: string; latency_ms: number }[];
      checkedAt: string;
    } = { webshells: [], tunnels: [], checkedAt: nowIso() };

    for (const s of this.listWebshells(id, { limit: 500 })) {
      const started = Date.now();
      let status = "offline";
      let note = "";
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(s.url, { method: "GET", redirect: "manual", signal: controller.signal });
        clearTimeout(timer);
        status = res.status < 500 ? "online" : "offline";
        note = `HTTP ${res.status}`;
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        note = name === "AbortError"
          ? `超时 >${timeout}ms`
          : (cause instanceof Error ? cause.message : String(cause)).slice(0, 160);
      }
      const latency = Date.now() - started;
      try {
        this.updateWebshell(id, s.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note });
      } catch {
        /* ignore */
      }
      out.webshells.push({ id: s.id, url: s.url, status, note, latency_ms: latency });
    }

    for (const t of this.listTunnels(id, { limit: 500 })) {
      const target = String(t.listen ?? "").replace(/^socks5:\/\//, "").replace(/^https?:\/\//, "");
      const started = Date.now();
      let status = "down";
      let note = "";
      if (target === "") {
        note = "缺少 listen 地址，无法探测";
      } else {
        const idx = target.lastIndexOf(":");
        const host = idx > 0 ? target.slice(0, idx) : "127.0.0.1";
        const port = Number(idx > 0 ? target.slice(idx + 1) : target);
        if (!Number.isFinite(port) || port <= 0) {
          note = `无法解析端口：${String(t.listen ?? "")}`;
        } else {
          note = await new Promise<string>((resolve) => {
            let done = false;
            const socket = tcpConnect({ host, port });
            const finish = (ok: boolean, text: string): void => {
              if (done) return;
              done = true;
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
              resolve(ok ? "" : text);
            };
            socket.setTimeout(timeout);
            socket.on("connect", () => {
              status = "active";
              finish(true, "");
            });
            socket.on("timeout", () => {
              finish(false, `超时 >${timeout}ms`);
            });
            socket.on("error", (cause: NodeJS.ErrnoException) => {
              finish(false, String(cause.code ?? cause.message ?? String(cause)).slice(0, 120));
            });
          });
        }
      }
      const latency = Date.now() - started;
      try {
        this.updateTunnel(id, t.id, { status, last_check: nowIso(), latency_ms: latency, check_note: note });
      } catch {
        /* ignore */
      }
      out.tunnels.push({ id: t.id, kind: t.kind, listen: t.listen, status, note, latency_ms: latency });
    }
    return out;
  }

  /* ---------- 域名维度 / Web 资产 / HTTP 证据 ---------- */

  /**
   * 按域名聚合资产：域名 → 该域名下的资产清单（无域名的资产归入「(未关联域名)」）。
   * @param f `{ cidr? }` 只看某个 C 段（与左侧 C 段选择保持一致，避免维度串台）。
   */
  domainIndex(id: string, f: unknown = {}): readonly {
    readonly domain: string;
    readonly count: number;
    readonly assets: readonly { readonly id: number; readonly ip: string; readonly segment: string; readonly state: string | null; readonly names: readonly string[] }[];
  }[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const assets = fo["cidr"]
      ? db.prepare<{ id: number; ip: string; segment_cidr: string; state: string | null; primary_name: string | null }>(
        "SELECT id, ip, segment_cidr, state, primary_name FROM asset WHERE segment_cidr = ? ORDER BY ip_int",
      ).all(String(fo["cidr"]))
      : db.prepare<{ id: number; ip: string; segment_cidr: string; state: string | null; primary_name: string | null }>(
        "SELECT id, ip, segment_cidr, state, primary_name FROM asset ORDER BY ip_int",
      ).all();
    const names = db.prepare<AssetNameRow>("SELECT asset_id, name, kind, provenance FROM asset_name").all();
    const byAsset = new Map<number, AssetNameRow[]>();
    for (const n of names) {
      const bucket = byAsset.get(n.asset_id);
      if (bucket === undefined) byAsset.set(n.asset_id, [n]);
      else bucket.push(n);
    }
    const groups = new Map<string, { id: number; ip: string; segment: string; state: string | null; names: readonly string[] }[]>();
    for (const a of assets) {
      const domains = new Set<string>();
      if (a.primary_name !== null && a.primary_name !== "") domains.add(a.primary_name);
      const own = byAsset.get(a.id) ?? [];
      for (const n of own) domains.add(n.name);
      if (domains.size === 0) domains.add("(未关联域名)");
      for (const domain of domains) {
        const bucket = groups.get(domain);
        const entry = {
          id: a.id, ip: a.ip, segment: a.segment_cidr, state: a.state,
          names: own.map((n) => n.name),
        };
        if (bucket === undefined) groups.set(domain, [entry]);
        else bucket.push(entry);
      }
    }
    return Array.from(groups.entries())
      .map(([domain, list]) => ({ domain, count: list.length, assets: list }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  }

  /** Web 资产清单：有 URL/标题或常见 Web 端口的资产。 */
  listWeb(id: string, f: unknown = {}): { readonly total: number; readonly items: readonly WebRow[] } {
    const db = this.db(id);
    const fo = asRecord(f);
    const rows = db.prepare<WebRow>(
      `SELECT p.id AS port_id, p.port, p.proto, p.url, p.title, p.banner, p.provenance, p.tool,
        a.id AS asset_id, a.ip, a.segment_cidr, a.primary_name, a.state,
        s.name AS service, s.product, s.version
      FROM port p JOIN asset a ON a.id = p.asset_id
      LEFT JOIN service s ON s.port_id = p.id
      WHERE p.state = 'open' AND (
        p.url IS NOT NULL OR p.title IS NOT NULL
        OR s.name IN ('http', 'https', 'http-proxy', 'ssl/http')
        OR p.port IN (80, 81, 443, 8000, 8001, 8080, 8081, 8082, 8443, 8888, 9090, 7001, 9000, 9443)
      )
      ORDER BY a.ip_int, p.port`,
    ).all();
    const filtered = fo["cidr"] ? rows.filter((r) => r.segment_cidr === fo["cidr"]) : rows;
    const limited = fo["limit"] ? filtered.slice(0, Number(fo["limit"])) : filtered;
    return { total: filtered.length, items: limited };
  }

  /** 落一条原始请求/响应。 */
  addHttpEvidence(id: string, e: unknown = {}): { readonly id: number } {
    const db = this.db(id);
    const input = asRecord(e);
    const result = db.prepare(
      `INSERT INTO http_evidence(vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      nullableInt(input["vuln_id"]), nullableInt(input["asset_id"]), nullableStr(input["label"]),
      str(input["method"], "GET"), nullableStr(input["url"]), nullableInt(input["status"]),
      nullableStr(input["request"]), nullableStr(input["response"]), nullableStr(input["note"]),
      nullableStr(input["captured_by"]), nowIso(),
    );
    return { id: result.lastInsertRowid };
  }

  /** 原始请求/响应列表（最新在前）。 */
  listHttpEvidence(id: string, f: unknown = {}): readonly HttpEvidenceRow[] {
    const db = this.db(id);
    const fo = asRecord(f);
    const where: string[] = [];
    const args: unknown[] = [];
    const vulnId = nullableInt(fo["vuln_id"]);
    const assetId = nullableInt(fo["asset_id"]);
    if (vulnId !== null) {
      where.push("vuln_id = ?");
      args.push(vulnId);
    }
    if (assetId !== null) {
      where.push("asset_id = ?");
      args.push(assetId);
    }
    const clause = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.min(Number(fo["limit"]) || 100, 500);
    return db.prepare<HttpEvidenceRow>(`SELECT * FROM http_evidence ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...(args as never[]), limit);
  }

  /* ---------- 攻击链步骤 ---------- */

  /**
   * 写一步攻击链。如果这一步拿到了分，带上 `point_code`（或 `point_id`）即可：
   * 服务端会自动记一条 `score_hit` 并把两者互相挂上，避免
   * "写了步骤忘了记分 / 记了分说不清怎么拿的"。
   *
   * 只有这 5 个阶段 code 会被攻击链页面分桶；其它值（含已废弃的
   * external/foothold/tunnel/privilege）写了等于步骤不落在任何阶段，
   * 所以退回按老 stage 兜底，**并显式告警**。
   */
  addChainStep(id: string, s: unknown = {}): {
    readonly id: number; readonly seq: number; readonly stage_code: string; readonly point_id: number | null;
    readonly hit: ScoreHitAdded | null; readonly score_hint: string | null; readonly stage_hint: string | null;
  } {
    const db = this.db(id);
    const input = asRecord(s);
    const nextRow = db.prepare<{ n: number | null }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM attack_step").get();
    let pointId = nullableInt(input["point_id"]);
    if (pointId === null && input["point_code"]) {
      const row = db.prepare<{ id: number }>("SELECT id FROM score_point WHERE code = ?").get(String(input["point_code"]));
      if (row !== undefined) pointId = row.id;
    }
    const next = Number(nextRow?.n ?? 1);
    const seq = input["seq"] === undefined || input["seq"] === null ? next : intOr(input["seq"], next);
    const legacyStage = str(input["stage"], "other");
    let stageWarning: string | null = null;
    let stageCode: string;
    const wantedRaw = input["stage_code"];
    if (typeof wantedRaw === "string" && wantedRaw.trim() !== "") {
      const wanted = wantedRaw.trim();
      if ((VALID_STAGE_CODES as readonly string[]).includes(wanted)) {
        stageCode = wanted;
      } else {
        stageCode = LEGACY_STAGE_MAP[legacyStage] ?? "recon";
        stageWarning = "无效的 stage_code=\"" + wanted + "\"（已忽略）：只接受 " + VALID_STAGE_CODES.join("/")
          + "；本步按 stage 兜底落到 " + stageCode + "。";
      }
    } else {
      stageCode = LEGACY_STAGE_MAP[legacyStage] ?? "recon";
    }
    const result = db.prepare(
      `INSERT INTO attack_step(seq, stage, stage_code, title, detail, asset_id, vuln_id, access_id, point_id, evidence_ref, tool, agent, result, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      seq, legacyStage, stageCode, str(input["title"], ""), nullableStr(input["detail"]),
      nullableInt(input["asset_id"]), nullableInt(input["vuln_id"]), nullableInt(input["access_id"]), pointId,
      nullableStr(input["evidence_ref"]), nullableStr(input["tool"]), nullableStr(input["agent"]),
      nullableStr(input["result"]), nullableStr(input["recorded_by"]), nowIso(),
    );
    const stepId = result.lastInsertRowid;
    let hit: ScoreHitAdded | null = null;
    let scoreHint: string | null = null;
    /* 带 point_code 且给了 evidence → 顺手记分（同一次调用完成"动作 + 得分"） */
    const evidence = input["evidence"];
    if (pointId !== null && typeof evidence === "string" && evidence.trim() !== "") {
      try {
        hit = this.addScoreHit(id, {
          point_id: pointId,
          asset_id: nullableInt(input["asset_id"]),
          vuln_id: nullableInt(input["vuln_id"]),
          step_id: stepId,
          target: nullableStr(input["target"]),
          evidence,
          note: nullableStr(input["note"]),
          recorded_by: nullableStr(input["recorded_by"]),
          /* 自己注册/自建的账号不计分（只留过程） */
          self_created: input["self_created"],
        });
        /* 服务级封顶（账号类 / 数据库权限）：步骤照常入库，但这笔分不再累加，
           必须把原因回给模型 —— 否则它会以为"又刷了一个账号 = 又加了分"。 */
        if (hit !== null && hit.warning !== null && hit.warning !== undefined) scoreHint = hit.warning;
      } catch (cause) {
        /* 步骤照常入库，但把原因回给模型 —— 静默吞掉会让"记了分"其实是空的 */
        scoreHint = "步骤已入库，但记分失败：" + (cause instanceof Error ? cause.message : String(cause));
      }
    } else if (pointId !== null) {
      scoreHint = "带了 point_code 但没给 evidence，本次**没有记分**（步骤已入库）：需要记分请补 redteam_score_hit，evidence 只写结果（目标资产 + 账号/权限/数据量）。";
    }
    return { id: stepId, seq, stage_code: stageCode, point_id: pointId, hit, score_hint: scoreHint, stage_hint: stageWarning };
  }

  /** 攻击链全量（按 seq, id 排序）。 */
  listChain(id: string): readonly (AttackStepRow & {
    readonly asset_ip: string | null;
    readonly vuln_title: string | null;
    readonly vuln_severity: string | null;
    readonly vuln_cve: string | null;
  })[] {
    return this.db(id).prepare<AttackStepRow & {
      asset_ip: string | null; vuln_title: string | null; vuln_severity: string | null; vuln_cve: string | null;
    }>(
      `SELECT s.*, a.ip AS asset_ip, v.title AS vuln_title, v.severity AS vuln_severity, v.cve AS vuln_cve
      FROM attack_step s
      LEFT JOIN asset a ON a.id = s.asset_id
      LEFT JOIN vuln v ON v.id = s.vuln_id
      ORDER BY s.seq, s.id`,
    ).all();
  }

  /* ---------- 采集结果入库 ---------- */

  /**
   * 采集结果入库（信息收集智能体与外部工具的统一 ingest 格式）。
   *
   * bundle = `{ scan:{tool,argv,agent_session_id}, segments:[], assets:[], edges:[] }`
   * asset  = `{ ip, state, primary_name, provenance, tool, names:[{name,kind}],
   *            ports:[{port,proto,service,product,version,banner,url,title,provenance,tool,
   *                    fingerprints:[{category,vendor,product,version,evidence}]}] }`
   *
   * **整段包在事务里**：中途抛错必须整体回滚 —— 半份采集结果比没有结果更糟
   * （资产建了一半、端口挂不上，下次采集的 upsert 会把残缺记录当成基线）。
   */
  importBundle(id: string, bundle: unknown = {}): {
    readonly scan_run_id: number | null;
    readonly counts: {
      readonly segments: number; readonly assets: number; readonly ports: number;
      readonly services: number; readonly fingerprints: number; readonly names: number; readonly edges: number;
    };
    readonly stats: TargetStats;
  } {
    const db = this.db(id);
    const b = asRecord(bundle);
    const counts = { segments: 0, assets: 0, ports: 0, services: 0, fingerprints: 0, names: 0, edges: 0 };
    let runId: number | null = null;
    const scan = b["scan"];
    if (scan !== undefined && scan !== null) {
      const s = asRecord(scan);
      const r = db.prepare(
        `INSERT INTO scan_run(agent_session_id, tool, argv, started_at, status)
        VALUES(?,?,?,?,'completed')`,
      ).run(
        nullableStr(s["agent_session_id"]), nullableStr(s["tool"]),
        s["argv"] !== undefined && s["argv"] !== null ? JSON.stringify(s["argv"]) : null, nowIso(),
      );
      runId = r.lastInsertRowid;
    }
    const scannedTool = nullableStr(asRecord(scan)["tool"]);
    db.transaction(() => {
      const segments = Array.isArray(b["segments"]) ? b["segments"] : [];
      for (const seg of segments) {
        this.upsertSegment(db, asRecord(seg));
        counts.segments += 1;
      }
      const assets = Array.isArray(b["assets"]) ? b["assets"] : [];
      for (const raw of assets) {
        const a = asRecord(raw);
        const provenance = str(a["provenance"], "") || "active";
        const tool = str(a["tool"], "") || scannedTool;
        const assetId = this.upsertAsset(db, { ...a, provenance });
        counts.assets += 1;
        const names = Array.isArray(a["names"]) ? a["names"] : [];
        for (const rawName of names) {
          const n = asRecord(rawName);
          const name = str(n["name"], "");
          const kind = str(n["kind"], "domain");
          db.prepare(
            `INSERT INTO asset_name(asset_id, name, kind, provenance, tool, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id, name, kind) DO UPDATE SET last_seen = excluded.last_seen`,
          ).run(assetId, name, kind, str(n["provenance"], "") || provenance, tool, nowIso(), nowIso());
          counts.names += 1;
          this.observe(db, "asset", assetId, "name", name, str(n["provenance"], "") || provenance, tool, runId);
          this.edge(db, "domain", name, "asset", assetId, "resolves");
        }
        const primaryName = nullableStr(a["primary_name"]);
        if (primaryName !== null) this.observe(db, "asset", assetId, "primary_name", primaryName, provenance, tool, runId);
        const ports = Array.isArray(a["ports"]) ? a["ports"] : [];
        for (const rawPort of ports) {
          const p = asRecord(rawPort);
          const pProv = str(p["provenance"], "") || provenance;
          const proto = str(p["proto"], "tcp");
          const port = Number(p["port"]);
          db.prepare(
            `INSERT INTO port(asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(asset_id, proto, port) DO UPDATE SET
              state = excluded.state,
              banner = COALESCE(excluded.banner, port.banner),
              url = COALESCE(excluded.url, port.url),
              title = COALESCE(excluded.title, port.title),
              last_seen = excluded.last_seen`,
          ).run(
            assetId, proto, port, str(p["state"], "open"), pProv, str(p["tool"], "") || tool,
            nullableStr(p["banner"]), nullableStr(p["url"]), nullableStr(p["title"]), nowIso(), nowIso(),
          );
          const portRow = db.prepare<{ id: number }>("SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?")
            .get(assetId, proto, port);
          const portId = portRow?.id ?? 0;
          counts.ports += 1;
          this.observe(db, "port", portId, "open", `${port}/${proto}`, pProv, str(p["tool"], "") || tool, runId);
          if (p["service"] !== undefined || p["product"] !== undefined || p["version"] !== undefined) {
            db.prepare(
              `INSERT INTO service(port_id, name, product, version, cpe, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?)`,
            ).run(
              portId, nullableStr(p["service"]), nullableStr(p["product"]), nullableStr(p["version"]),
              nullableStr(p["cpe"]), pProv, str(p["tool"], "") || tool, nowIso(), nowIso(),
            );
            counts.services += 1;
            this.observe(db, "port", portId, "service",
              [p["service"], p["product"], p["version"]].filter(Boolean).join(" "), pProv, str(p["tool"], "") || tool, runId);
          }
          const fps = Array.isArray(p["fingerprints"]) ? p["fingerprints"] : [];
          for (const rawFp of fps) {
            const fp = asRecord(rawFp);
            db.prepare(
              `INSERT INTO fingerprint(asset_id, port_id, category, vendor, product, version, evidence, confidence, provenance, tool, first_seen, last_seen)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              assetId, portId, nullableStr(fp["category"]), nullableStr(fp["vendor"]), nullableStr(fp["product"]),
              nullableStr(fp["version"]), nullableStr(fp["evidence"]), nullableInt(fp["confidence"]),
              str(fp["provenance"], "") || pProv, str(fp["tool"], "") || tool, nowIso(), nowIso(),
            );
            counts.fingerprints += 1;
            this.observe(db, "asset", assetId, "fingerprint",
              [fp["category"], fp["vendor"], fp["product"], fp["version"]].filter(Boolean).join(" "),
              str(fp["provenance"], "") || pProv, str(fp["tool"], "") || tool, runId);
          }
        }
        this.reindex(db, assetId);
      }
      const edges = Array.isArray(b["edges"]) ? b["edges"] : [];
      for (const rawEdge of edges) {
        const e = asRecord(rawEdge);
        this.edge(db, str(e["src_kind"], ""), e["src_id"], str(e["dst_kind"], ""), e["dst_id"],
          str(e["relation"], ""), nullableInt(e["confidence"]));
        counts.edges += 1;
      }
    });
    return { scan_run_id: runId, counts, stats: this.stats(id) };
  }

  /* ---------- 提示词 ---------- */

  /** 默认提示词指纹清单路径（记录本靶标上次被写入默认时的内容指纹）。 */
  promptManifestPathOf(id: string): string {
    return join(this.promptsDirOf(id), ".defaults.json");
  }

  /** 读指纹清单（读不到返回空对象，不抛）。 */
  readPromptManifest(id: string): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.promptManifestPathOf(id), "utf8"));
      const rec = asRecord(parsed);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  }

  /** 写指纹清单（写不进去不影响使用）。 */
  writePromptManifest(id: string, manifest: Record<string, string>): void {
    try {
      mkdirSync(this.promptsDirOf(id), { recursive: true });
      writeFileSync(this.promptManifestPathOf(id), JSON.stringify(manifest, null, 2), "utf8");
    } catch {
      /* 写不进去不影响使用 */
    }
  }

  /**
   * 把"仍是旧版内置默认"的角色提示词换成当前版本；用户自己改过的原样保留。
   *
   * 判断依据：内容指纹等于 ① 本靶标上次写入默认时的指纹（manifest），或
   * ② 任一历史版本的默认指纹（`LEGACY_PROMPT_HASHES`）。两者都不匹配 = 用户自己写的。
   * 每次读提示词（面板打开）时顺带跑一遍，所以老靶标也会自动跟上新版。
   *
   * @param options `{ force?: boolean }`：force 时连"用户自写"也覆盖（脚本批量升级用）。
   */
  refreshDefaultPrompts(id: string, options: unknown = {}): PromptRefresh {
    const opts = asRecord(options);
    const manifest = this.readPromptManifest(id);
    let changed = 0;
    let created = 0;
    const kept: string[] = [];
    for (const role of Object.keys(ROLE_TITLES)) {
      const next = DEFAULT_PROMPTS[role] ?? "";
      const p = join(this.promptsDirOf(id), `${role}.md`);
      /* 新增角色（如 v0.9.0 的资产梳理 assess / 主会话 plan）：老靶标没有这个文件，
         直接按当前默认建一份，不用用户手动补 */
      if (!existsSync(p)) {
        if (next !== "") {
          mkdirSync(this.promptsDirOf(id), { recursive: true });
          writeFileSync(p, next, "utf8");
          manifest[role] = promptHash(next);
          created += 1;
        }
        continue;
      }
      const cur = readFileSync(p, "utf8");
      const h = promptHash(cur);
      const hNext = promptHash(next);
      if (h === hNext) {
        manifest[role] = hNext;
        continue;
      }
      const wasDefault = opts["force"] === true || manifest[role] === h;
      if (!wasDefault) {
        kept.push(role);
        continue;
      }
      /* 覆盖前留一份 .bak，万一判错还能找回 */
      try {
        copyFileSync(p, `${p}.bak-${Date.now()}`);
      } catch {
        /* 忽略 */
      }
      writeFileSync(p, next, "utf8");
      manifest[role] = hNext;
      changed += 1;
    }
    this.writePromptManifest(id, manifest);
    return { changed, kept, created };
  }

  /** 角色提示词清单（顺带跑一次默认刷新）。 */
  listPrompts(id: string): PromptRole[] {
    const dir = this.promptsDirOf(id);
    mkdirSync(dir, { recursive: true });
    this.refreshDefaultPrompts(id);
    return Object.entries(ROLE_TITLES).map(([role, title]) => {
      const p = join(dir, `${role}.md`);
      const exists = existsSync(p);
      return {
        role,
        title,
        /* 主会话（plan）不派出去，只作人设参考 —— 面板上标注一下，别让人以为要派它 */
        planner: role === PLANNER_ROLE,
        dispatcher: role !== PLANNER_ROLE,
        content: exists ? readFileSync(p, "utf8") : "",
        updated_at: exists ? statSync(p).mtime.toISOString() : null,
      };
    });
  }

  /** 把角色提示词恢复成内置默认（用户在界面上改坏了 / 老靶标要用新版提示词时用）。 */
  resetPrompts(id: string, role?: unknown): { readonly reset: readonly string[] } {
    if (role !== undefined && role !== null) {
      const r = String(role);
      this.savePrompt(id, r, DEFAULT_PROMPTS[r] ?? "");
      return { reset: [r] };
    }
    const done: string[] = [];
    for (const r of Object.keys(ROLE_TITLES)) {
      this.savePrompt(id, r, DEFAULT_PROMPTS[r] ?? "");
      done.push(r);
    }
    return { reset: done };
  }

  /** 保存一个角色的提示词（顺带记"这是不是当前默认"，决定将来能否自动升级）。 */
  savePrompt(id: string, role: unknown, content: unknown): { readonly role: string; readonly bytes: number } {
    const r = String(role ?? "");
    if (ROLE_TITLES[r] === undefined) throw new Error(`unknown role: ${r}`);
    mkdirSync(this.promptsDirOf(id), { recursive: true });
    const text = String(content ?? "");
    writeFileSync(join(this.promptsDirOf(id), `${r}.md`), text, "utf8");
    /* 记下这是不是"当前内置默认"：是则将来能随新版自动升级，
       否则视为用户自写、永不覆盖 */
    const manifest = this.readPromptManifest(id);
    if (promptHash(text) === promptHash(DEFAULT_PROMPTS[r] ?? "")) manifest[r] = promptHash(text);
    else delete manifest[r];
    this.writePromptManifest(id, manifest);
    return { role: r, bytes: Buffer.byteLength(text) };
  }

  /* ---------- 图谱（攻击视图） ---------- */

  /**
   * 攻击图谱：在资产拓扑上叠加漏洞与已控制资产。
   *
   * 节点 kind：`segment` / `asset`（meta.vulns 按严重级计数、meta.owned）/ `vuln`（已确认与已利用）。
   * 边 relation：`contains` / `exposes` / `resolves` / `has_vuln`。
   */
  attackGraph(id: string, f: unknown = {}): GraphResult & { readonly summary: VulnStats } {
    const base = this.graph(id, f);
    const db = this.db(id);
    const nodes: GraphNode[] = base.nodes.slice();
    const edges: GraphEdge[] = base.edges.slice();
    const byId = new Map(nodes.map((n) => [n.id, n] as const));

    const vulnRows = db.prepare<{ asset_id: number | null; severity: string | null; n: number }>(
      `SELECT asset_id, severity, COUNT(*) AS n FROM vuln
      WHERE asset_id IS NOT NULL GROUP BY asset_id, severity`,
    ).all();
    for (const row of vulnRows) {
      const node = byId.get(`asset:${String(row.asset_id)}`);
      if (node === undefined) continue;
      const meta = { ...asRecord(node.meta) };
      const vulns = { ...asRecord(meta["vulns"]) };
      vulns[String(row.severity)] = row.n;
      meta["vulns"] = vulns;
      /* nodes 里存的是只读对象；这里替换成带新 meta 的副本（不改原对象，
         避免同一次调用里多次聚合读到半成品）。 */
      const idx = nodes.findIndex((n) => n.id === node.id);
      if (idx >= 0) nodes[idx] = { ...node, meta };
      byId.set(node.id, { ...node, meta });
    }
    const owned = db.prepare<{ asset_id: number | null }>("SELECT DISTINCT asset_id FROM access_session WHERE asset_id IS NOT NULL").all();
    for (const row of owned) {
      const node = byId.get(`asset:${String(row.asset_id)}`);
      if (node === undefined) continue;
      const meta = { ...asRecord(node.meta), owned: true };
      const idx = nodes.findIndex((n) => n.id === node.id);
      if (idx >= 0) nodes[idx] = { ...node, meta };
      byId.set(node.id, { ...node, meta });
    }
    const confirmed = db.prepare<{ id: number; asset_id: number | null; cve: string | null; title: string | null; severity: string | null; status: string | null }>(
      `SELECT v.id, v.asset_id, v.cve, v.title, v.severity, v.status
      FROM vuln v WHERE v.status IN ('confirmed','exploited') AND v.asset_id IS NOT NULL
      ORDER BY CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 200`,
    ).all();
    for (const v of confirmed) {
      const nodeId = `vuln:${String(v.id)}`;
      nodes.push({
        id: nodeId, kind: "vuln",
        label: v.cve ?? (v.title ?? "").slice(0, 18),
        meta: { severity: v.severity, status: v.status, title: v.title },
      });
      edges.push({ source: `asset:${String(v.asset_id)}`, target: nodeId, relation: "has_vuln" });
    }
    return { nodes, edges, summary: this.vulnStats(id) };
  }

  /* ---------- 成果报告（按目标分组） ---------- */

  /**
   * 按目标分组的成果报告：每个 IP / URL / C 段一份，供界面展开收起。
   * 收录口径与 `report()` 一致（已验证/已利用且中危以上）。
   */
  reportTargets(id: string, options: unknown = {}): ReportTargets {
    const opts = asRecord(options);
    const meta = readMeta(this.metaPathOf(id)) ?? {};
    const includeAll = opts["all"] === true;
    const allVulns = this.listVulns(id, { limit: 2000 }).items;
    const severityOrder: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const isResult = (v: VulnRow): boolean => v.status === "confirmed" || v.status === "exploited";
    const isReal = (v: VulnRow): boolean =>
      v.severity === "critical" || v.severity === "high" || v.severity === "medium";
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity ?? ""] ?? 9) - (severityOrder[b.severity ?? ""] ?? 9));
    const chain = this.listChain(id);
    const creds = this.listCredentials(id, {});
    const access = this.listAccess(id, {});
    const files = this.listAttackFiles(id, {});

    interface TargetGroup {
      key: string;
      label: string;
      kind: string;
      segment: string;
      vulns: (VulnRow & { asset_ip: string | null; segment_cidr: string | null })[];
      chain: (AttackStepRow & { asset_ip: string | null })[];
      access: AccessSessionRow[];
      creds: CredentialRow[];
      files: AttackFileRow[];
    }
    const targets = new Map<string, TargetGroup>();
    const ensure = (key: string): TargetGroup => {
      let g = targets.get(key);
      if (g === undefined) {
        g = {
          key, label: key,
          kind: /^\d{1,3}(\.\d{1,3}){3}$/.test(key) ? "ip" : "host",
          segment: "", vulns: [], chain: [], access: [], creds: [], files: [],
        };
        targets.set(key, g);
      }
      return g;
    };
    const assetIpOf = (assetId: number | null): string | undefined => {
      if (assetId === null) return undefined;
      const asset = this.getAsset(id, assetId);
      return asset === undefined ? undefined : asset.ip;
    };
    for (const v of vulns) {
      const key = v.asset_ip ?? (v.target !== null && v.target !== "" ? slugTarget(v.target) : "未归属目标");
      const g = ensure(key);
      g.vulns.push(v);
      if (g.segment === "" && v.segment_cidr !== null) g.segment = v.segment_cidr;
    }
    for (const a of access) {
      const key = assetIpOf(a.asset_id) ?? slugTarget(a.host);
      const g = ensure(key);
      g.access.push(a);
      if (g.segment === "") {
        const asset = a.asset_id === null ? undefined : this.getAsset(id, a.asset_id);
        if (asset !== undefined && asset.segment_cidr !== "") g.segment = asset.segment_cidr;
      }
    }
    for (const c of creds) ensure(assetIpOf(c.asset_id) ?? slugTarget(c.host)).creds.push(c);
    for (const f of files) ensure(assetIpOf(f.asset_id) ?? slugTarget(f.target)).files.push(f);
    for (const st of chain) if (st.asset_ip !== null && st.asset_ip !== "") ensure(st.asset_ip).chain.push(st);

    const renderVuln = (v: VulnRow & { asset_ip: string | null }): string[] => {
      const out: string[] = [];
      out.push(`#### [${String(v.severity ?? "info").toUpperCase()}] ${v.cve !== null ? v.cve + " — " : ""}${v.title ?? ""}`, "");
      out.push(`- 目标：${v.target ?? "—"}`);
      out.push(`- 状态：${v.status === "exploited" ? "已成功利用" : "已验证"} · 置信度：${v.confidence === null ? "—" : v.confidence} · 发现方式：${v.source ?? "—"}`);
      out.push(`- 危害与证据：${v.evidence ?? "—"}`);
      const evidence = this.listHttpEvidence(id, { vuln_id: v.id });
      if (evidence.length > 0) {
        out.push("", "**复现请求（可直接粘贴进 Burp Suite / Yakit）**：", "");
        for (const e of evidence) {
          out.push(`*${e.label ?? (e.method ?? "") + " " + (e.url ?? "")}*`, "");
          if (e.request !== null && e.request !== "") out.push("```http", e.request.replace(/\r/g, "").trim(), "```", "");
          if (e.response !== null && e.response !== "") {
            out.push("响应摘要：", "```http", String(e.response).replace(/\r/g, "").trim().slice(0, 2000), "```", "");
          }
        }
      }
      out.push("");
      return out;
    };

    const groups = new Map<string, { cidr: string; targets: ReportTarget[] }>();
    const list: ReportTarget[] = [];
    for (const g of targets.values()) {
      const lines: string[] = [];
      lines.push(`## ${g.label}${g.segment !== "" ? "（" + g.segment + "）" : ""}`, "");
      const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0 };
      for (const v of g.vulns) bySeverity[String(v.severity)] = (bySeverity[String(v.severity)] ?? 0) + 1;
      lines.push(`- 成果：漏洞 ${g.vulns.length} 个（严重 ${bySeverity["critical"] ?? 0} · 高危 ${bySeverity["high"] ?? 0} · 中危 ${bySeverity["medium"] ?? 0}）· 已控 ${g.access.length} · 凭据 ${g.creds.length} · 攻击文件 ${g.files.length}`, "");
      if (g.vulns.length > 0) {
        lines.push("### 成果漏洞", "");
        for (const v of g.vulns) lines.push(...renderVuln(v));
      }
      if (g.access.length > 0) {
        lines.push("### 已获得权限", "");
        for (const a of g.access) lines.push(`- ${String(a.host)} · ${a.username ?? "—"} · ${a.method ?? "—"} · ${a.privilege ?? "—"} · ${a.session_ref ?? ""}`);
        lines.push("");
      }
      if (g.creds.length > 0) {
        lines.push("### 凭据", "");
        for (const c of g.creds) lines.push(`- ${String(c.host)} · ${c.username ?? "—"} · ${c.secret_type ?? "—"} · ${c.privilege ?? "—"} · ${c.secret_ref ?? ""}`);
        lines.push("");
      }
      if (g.files.length > 0) {
        lines.push("### 攻击文件", "");
        for (const f of g.files) lines.push(`- \`${f.name}\`（${String(f.kind)}）：${f.description ?? "—"}｜效果：${f.evidence ?? ""}｜路径：${f.path}`);
        lines.push("");
      }
      if (g.chain.length > 0) {
        lines.push("### 攻击链", "");
        for (const st of g.chain) lines.push(`${String(st.seq)}. [${String(st.stage)}] ${String(st.title)}${st.detail !== null ? " — " + st.detail : ""}`);
        lines.push("");
      }
      const entry: ReportTarget = {
        key: g.key, label: g.label, kind: g.kind, segment: g.segment !== "" ? g.segment : "未归属",
        stats: {
          vulns: g.vulns.length, bySeverity,
          accesses: g.access.length, credentials: g.creds.length, files: g.files.length, chainSteps: g.chain.length,
        },
        markdown: lines.join("\n"),
      };
      list.push(entry);
      const cidr = entry.segment;
      let bucket = groups.get(cidr);
      if (bucket === undefined) {
        bucket = { cidr, targets: [] };
        groups.set(cidr, bucket);
      }
      bucket.targets.push(entry);
    }
    const grouped = Array.from(groups.values())
      .map((g) => ({
        cidr: g.cidr,
        targets: g.targets.slice().sort((a, b) => b.stats.vulns - a.stats.vulns || a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.cidr.localeCompare(b.cidr));
    return {
      generated_at: nowIso(),
      engagement: { id, name: metaString(meta, "target_name", id), scope: metaList(meta, "scope_cidrs") },
      groups: grouped,
      targets: list,
      totals: {
        targets: list.length,
        vulns: vulns.length,
        accesses: access.length,
        credentials: creds.length,
        files: files.length,
        filteredOut: allVulns.length - vulns.length,
      },
    };
  }

  /**
   * 生成 Markdown 成果报告。
   *
   * **只交付「成果漏洞」**：状态为 confirmed / exploited，且严重级为 critical / high / medium。
   * 待验证（candidate）、误报（false-positive）、低危与信息级（low/info）都不进报告 ——
   * 它们是过程噪声（水洞）。信息收集的资产清单也不进报告（在资产测绘页面看）。
   */
  report(id: string, options: unknown = {}): VulnReport {
    const opts = asRecord(options);
    const meta = readMeta(this.metaPathOf(id)) ?? {};
    const includeAll = opts["all"] === true;
    const chain = this.listChain(id);
    const creds = this.listCredentials(id, {});
    const access = this.listAccess(id, {});
    const allVulns = this.listVulns(id, { limit: 2000 }).items;
    const severityOrder: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const isResult = (v: VulnRow): boolean => v.status === "confirmed" || v.status === "exploited";
    const isReal = (v: VulnRow): boolean =>
      v.severity === "critical" || v.severity === "high" || v.severity === "medium";
    const vulns = (includeAll ? allVulns : allVulns.filter((v) => isResult(v) && isReal(v)))
      .slice()
      .sort((a, b) => (severityOrder[a.severity ?? ""] ?? 9) - (severityOrder[b.severity ?? ""] ?? 9));
    const filteredOut = allVulns.length - vulns.length;

    const lines: string[] = [];
    const push = (...xs: readonly string[]): void => {
      lines.push(...xs);
    };
    const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const v of vulns) bySeverity[String(v.severity)] = (bySeverity[String(v.severity)] ?? 0) + 1;
    const exploited = vulns.filter((v) => v.status === "exploited").length;

    push(`# 攻防演练成果报告 — ${metaString(meta, "target_name", id)}`, "");
    push(`- 生成时间：${nowIso()}`);
    push(`- 授权范围：${metaList(meta, "scope_cidrs").join(", ")}` || "- 授权范围：（未记录）");
    push(`- 成果概览：成果漏洞 ${vulns.length} 个（严重 ${bySeverity["critical"] ?? 0} · 高危 ${bySeverity["high"] ?? 0} · 中危 ${bySeverity["medium"] ?? 0}）· 已成功利用 ${exploited} 个 · 已控制资产 ${access.length} 台 · 已获取凭据 ${creds.length} 条`);
    push("");

    push("## 一、成果漏洞", "");
    if (vulns.length === 0) {
      push("本次演练暂无可交付的成果漏洞（只收录已验证/已利用且中危及以上的漏洞）。", "");
    } else {
      for (const v of vulns) {
        push(`### [${String(v.severity ?? "info").toUpperCase()}] ${v.cve !== null ? v.cve + " — " : ""}${v.title ?? ""}`, "");
        push(`- 目标：${v.target ?? "—"}`);
        push(`- 资产：${v.asset_ip ?? "—"}（${v.segment_cidr ?? "—"}）`);
        push(`- 状态：${v.status === "exploited" ? "已成功利用" : "已验证"} · 置信度：${v.confidence === null ? "—" : v.confidence} · 发现方式：${v.source ?? "—"}`);
        push(`- 危害与证据：${v.evidence ?? "—"}`);
        const evidence = this.listHttpEvidence(id, { vuln_id: v.id });
        if (evidence.length > 0) {
          push("", "**复现请求（可直接粘贴进 Burp Suite / Yakit）**：", "");
          for (const e of evidence) {
            push(`*${e.label ?? (e.method ?? "") + " " + (e.url ?? "")}*`, "");
            if (e.request !== null && e.request !== "") push("```http", e.request.replace(/\r/g, "").trim(), "```", "");
            if (e.response !== null && e.response !== "") {
              push("响应摘要：", "```http", String(e.response).replace(/\r/g, "").trim().slice(0, 2000), "```", "");
            }
          }
        }
        push("");
      }
    }

    push("## 二、攻击链", "");
    if (chain.length > 0) {
      for (const s of chain) {
        push(`${String(s.seq)}. **[${String(s.stage)}] ${String(s.title)}**`);
        if (s.asset_ip !== null && s.asset_ip !== "") push(`   - 资产：${s.asset_ip}`);
        if ((s.vuln_title !== null && s.vuln_title !== "") || (s.vuln_cve !== null && s.vuln_cve !== "")) {
          push(`   - 漏洞：${s.vuln_cve !== null ? s.vuln_cve + " " : ""}${s.vuln_title ?? ""}`);
        }
        if (s.detail !== null && s.detail !== "") push(`   - 说明：${s.detail}`);
        if (s.evidence_ref !== null && s.evidence_ref !== "") push(`   - 证据：${s.evidence_ref}`);
      }
    } else {
      push("（未记录攻击链步骤）");
    }
    push("");

    push("## 三、已获得权限与凭据", "");
    if (access.length > 0) {
      push("| 主机 | 账号 | 方式 | 权限 | 证据 |", "| --- | --- | --- | --- | --- |");
      for (const a of access) push(`| ${String(a.host)} | ${a.username ?? "—"} | ${a.method ?? "—"} | ${a.privilege ?? "—"} | ${a.session_ref ?? "—"} |`);
    } else {
      push("（未获得可用访问）");
    }
    push("");
    if (creds.length > 0) {
      push("| 主机 | 账号 | 类型 | 权限 | 引用 |", "| --- | --- | --- | --- | --- |");
      for (const c of creds) push(`| ${String(c.host)} | ${c.username ?? "—"} | ${c.secret_type ?? "—"} | ${c.privilege ?? "—"} | ${c.secret_ref ?? "—"} |`);
    } else {
      push("（未获取凭据）");
    }
    push("");

    push("## 四、修复建议", "");
    const advice: string[] = [];
    if (vulns.some((v) => v.cve !== null && v.cve !== "")) advice.push("1. 按上方 CVE 编号优先修补受影响组件，建立组件版本基线并纳入补丁管理。");
    if (access.some((a) => a.method === "webshell" || a.method === "rce" || a.method === "upload")) advice.push("2. 收紧文件上传与命令执行面：上传目录禁止执行、白名单校验、最小权限运行 Web 进程。");
    if (access.some((a) => a.method === "vnc" || a.method === "rdp" || a.method === "ssh")) advice.push("3. 收敛远程管理暴露面（VNC/RDP/SSH 不暴露公网），强制强口令与多因子认证。");
    if (creds.some((c) => c.secret_type === "connection-string")) advice.push("4. 禁止通过接口/配置泄露数据库连接串，密钥统一纳入密钥管理并对接口做鉴权。");
    advice.push(`${advice.length + 1}. 对本次涉及的接口做统一鉴权与越权校验，建立接口资产台账与自动化回归测试。`);
    push(...advice, "");

    if (filteredOut > 0 && !includeAll) {
      push(`> 本报告只收录已验证/已利用且中危以上的成果漏洞；另有 ${filteredOut} 条待验证、误报或低危/信息级记录未纳入（可在「漏洞战果」页面查看）。`);
      push("");
    }

    return {
      markdown: lines.join("\n"),
      generated_at: nowIso(),
      stats: {
        results: vulns.length, bySeverity, exploited, filteredOut,
        accesses: access.length, credentials: creds.length, chainSteps: chain.length,
      },
    };
  }

  /* ---------- 得分的"怎么来的" ---------- */

  /**
   * 一条得分的链路追踪：动作步骤 + 利用的漏洞 + 拿到手的凭据/入口。
   *
   * ## 归因规则（先准后宽）
   *
   *   ① 显式关联的步骤（`score_hit.step_id`）
   *   ② 这个漏洞的步骤（`vuln_id`）—— "靠这个洞拿到的分"就该看到打这个洞的动作
   *   ③ 同资产 + 同得分点的步骤（推断）
   * 只有上面都没有时，才退到"同资产的全部步骤"（为了让报告不至于空白），并标成推断。
   * `step_source` 会如实告诉调用方这次用的是哪一档。
   *
   * ## 凭据/会话/马/隧道：必须与"本条得分"是同一件事才挂
   *
   * 原实现只按 `asset_id` 取，于是同一台资产上登记的**全部**凭据与会话被挂到该资产的
   * 每一条得分上。实测后果：一条「终端权限 pc-001」下面挂着「MySQL root（配置文件泄露）」——
   * 与终端毫无关系；一条资产 4 条得分各自重复列出同一批凭据，报告因此又长又假。
   *
   * 判定：**本条写了 target 时**要求 target 主机与该资产（IP / 首选名）对得上；
   * 没写 target（纯资产级成果，如"控下 1 台终端"）时按资产挂载是合理的。
   */
  private hitTrace(db: TypedDb, hit: ScoreHitRow & { readonly code?: string | null }, engagementId: string): HitTrace {
    const evidenceDir = engagementId !== "" ? this.dirOf(engagementId) : null;
    interface StepWithInferred extends AttackStepRow {
      inferred?: boolean;
    }
    const steps: TracedStep[] = [];
    const stepById = new Map<number, TracedStep>();
    const pushStep = (row: StepWithInferred | undefined): void => {
      if (row === undefined) return;
      const existing = stepById.get(row.id);
      if (existing !== undefined) {
        /* 同一步骤先被标成"推断"、后来又拿到显式证据 → 升级成非推断 */
        if (existing.inferred && row.inferred !== true) {
          const i = steps.findIndex((s) => s.id === existing.id);
          if (i >= 0) steps[i] = { ...existing, inferred: false };
          stepById.set(existing.id, { ...existing, inferred: false });
        }
        return;
      }
      const step: TracedStep = {
        id: row.id,
        seq: row.seq,
        stage_code: row.stage_code,
        title: row.title ?? "",
        detail: row.detail ?? "",
        tool: row.tool ?? "",
        result: row.result ?? "",
        agent: (row.agent ?? "") !== "" ? String(row.agent) : (row.recorded_by ?? ""),
        recorded_at: row.recorded_at,
        vuln_id: row.vuln_id,
        asset_id: row.asset_id,
        point_id: row.point_id,
        evidence_ref: row.evidence_ref ?? "",
        inferred: row.inferred === true,
      };
      stepById.set(step.id, step);
      steps.push(step);
    };
    const cols = "id, seq, stage_code, title, detail, tool, agent, result, asset_id, vuln_id, access_id, point_id, evidence_ref, recorded_at";
    let stepSource: string | null = null;
    try {
      if (hit.step_id !== null) {
        pushStep(db.prepare<AttackStepRow>(`SELECT ${cols} FROM attack_step WHERE id = ?`).get(hit.step_id));
        if (steps.length > 0) stepSource = "linked";
      }
      if (hit.vuln_id !== null) {
        for (const row of db.prepare<AttackStepRow>(`SELECT ${cols} FROM attack_step WHERE vuln_id = ? ORDER BY seq, id`).all(hit.vuln_id)) {
          pushStep(row);
        }
        if (stepSource === null && steps.length > 0) stepSource = "vuln";
      }
      if (hit.asset_id !== null && hit.point_id !== null) {
        for (const row of db.prepare<AttackStepRow>(`SELECT ${cols} FROM attack_step WHERE asset_id = ? AND point_id = ? ORDER BY seq, id`)
          .all(hit.asset_id, hit.point_id)) {
          pushStep({ ...row, inferred: true });
          if (stepSource === null) stepSource = "point";
        }
      }
      if (steps.length === 0 && hit.asset_id !== null) {
        for (const row of db.prepare<AttackStepRow>(`SELECT ${cols} FROM attack_step WHERE asset_id = ? ORDER BY seq, id LIMIT 40`)
          .all(hit.asset_id)) {
          pushStep({ ...row, inferred: true });
        }
        if (steps.length > 0) stepSource = "asset";
      }
    } catch {
      /* 老库缺列时降级为"无步骤"，报告会标成无法复现 */
    }
    steps.sort((a, b) => (a.seq === b.seq ? a.id - b.id : (a.seq ?? 0) - (b.seq ?? 0)));

    /* 这条得分用到的漏洞 */
    let vuln: TracedVuln | null = null;
    if (hit.vuln_id !== null) {
      try {
        const v = db.prepare<TracedVuln>(
          "SELECT id, cve, title, severity, status, target, evidence, gained, source, found_by_agent, found_at FROM vuln WHERE id = ?",
        ).get(hit.vuln_id);
        if (v !== undefined) vuln = v;
      } catch {
        vuln = null;
      }
    }

    /* target 里的主机部分（去掉协议、方括号、端口）。null = 本条没写 target。 */
    const targetHost = (() => {
      const t = (hit.target ?? "").trim();
      if (t === "") return null;
      const url = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#\s]+)/i.exec(t);
      let authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) ?? [])[1];
      if (authority === undefined || authority === "") return null;
      authority = authority.replace(/^\[|\]$/g, "").replace(/:\d{1,5}$/, "").toLowerCase();
      return authority === "" ? null : authority;
    })();
    const asset = hit.asset_id === null
      ? undefined
      : (() => {
        try {
          return db.prepare<{ ip: string; primary_name: string | null; segment_cidr: string }>(
            "SELECT ip, primary_name, segment_cidr FROM asset WHERE id = ?",
          ).get(Number(hit.asset_id));
        } catch {
          return undefined;
        }
      })();
    const targetMatchesAsset = (): boolean => {
      if (targetHost === null) return true; /* 没写 target：按资产挂载 */
      if (asset === undefined) return false; /* 写了 target 又查不到资产：不挂 */
      const ip = String(asset.ip ?? "").toLowerCase();
      const name = String(asset.primary_name ?? "").toLowerCase();
      const cidr = String(asset.segment_cidr ?? "").toLowerCase();
      /* ① 目标就是这台资产（IP 或首选域名） */
      if (targetHost === ip || targetHost === name) return true;
      /* ② 目标"看着不像单台主机"：边界突破常把 target 写成可达网段（10.20.30.0/24）、
         终端类会写成设备名（pc-001）。这类条目本质是"资产级成果"，
         它用到的隧道/马/凭据就挂在这台入口资产上 —— 不挂会丢掉"通道怎么搭的"。 */
      const raw = (hit.target ?? "").trim();
      if (raw.includes("/")) return true;
      if (cidr !== "" && (targetHost === cidr || cidr.startsWith(targetHost + "/"))) return true;
      const looksLikeHost = /^[0-9a-f.:[\]]+$/i.test(targetHost) || targetHost.includes(".");
      return !looksLikeHost;
    };
    const sameAsset = targetMatchesAsset();

    const credentials: TracedCredential[] = [];
    const accesses: TracedAccess[] = [];
    const webshells: TracedShell[] = [];
    const tunnels: TracedTunnel[] = [];
    if (sameAsset) {
      try {
        if (hit.asset_id !== null) {
          credentials.push(...db.prepare<TracedCredential>(
            `SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE asset_id = ? ORDER BY id LIMIT 20`,
          ).all(hit.asset_id));
        } else if (targetHost !== null) {
          credentials.push(...db.prepare<TracedCredential>(
            `SELECT id, host, username, secret_value, secret_type, privilege, source, tool, agent, found_at
            FROM credential WHERE host LIKE ? ORDER BY id LIMIT 20`,
          ).all("%" + targetHost + "%"));
        }
      } catch {
        /* 忽略 */
      }
      if (hit.asset_id !== null) {
        try {
          accesses.push(...db.prepare<TracedAccess>(
            "SELECT id, host, username, method, privilege, session_ref, obtained_at FROM access_session WHERE asset_id = ? ORDER BY id LIMIT 20",
          ).all(hit.asset_id));
        } catch {
          /* 忽略 */
        }
        try {
          webshells.push(...db.prepare<TracedShell>(
            "SELECT id, url, shell_type, pass_key, privilege, status, agent FROM webshell WHERE asset_id = ? ORDER BY id LIMIT 20",
          ).all(hit.asset_id));
        } catch {
          /* 忽略 */
        }
        try {
          tunnels.push(...db.prepare<Omit<TracedTunnel, "legit">>(
            "SELECT id, kind, listen, entry, reach, entry_kind, status, command, agent FROM tunnel WHERE asset_id = ? ORDER BY id LIMIT 20",
          ).all(hit.asset_id).map((t) => ({ ...t, legit: tunnelIsLegit(t.entry_kind) })));
        } catch {
          /* 忽略 */
        }
      }
    }

    /* 复现完整性判定：一条得分至少要"有步骤 + （有命令 或 有漏洞 或 有原始请求）" */
    const hasCommand = steps.some((s) => s.tool.trim() !== "");
    const gaps: string[] = [];
    if (steps.length === 0) gaps.push("没有攻击步骤记录（`redteam_chain_add`）：说不清这一步的动作是怎么做的");
    else if (!hasCommand) gaps.push("攻击步骤没有写 `tool`（实际命令）：复现时不知道当时敲的是什么");
    if (hit.vuln_id === null) gaps.push("没有关联 `vuln_id`：报告拿不到对应的原始请求");
    const code = hit.code ?? null;
    if (credentials.length === 0 && (code === "web-account-user" || code === "web-account-admin" || code === "db-access")) {
      gaps.push("账号类得分但没有登记凭据（`redteam_credential_add`）：说不清账号密码从哪来");
    }
    if ((code === "boundary" || code === "internal-pivot") && tunnels.length === 0) {
      gaps.push("突破类得分但没有登记隧道（`redteam_tunnel_add`）：说不清通道怎么搭的");
    }

    /* how：一句话交代"靠什么拿到的"，优先用最有信息量的那条 */
    const primary = steps.find((s) => s.title.trim() !== "") ?? steps[0];
    let how = "";
    if (hit.vuln_id !== null && vuln !== null) {
      how = "利用漏洞 " + ((vuln.cve ?? "") !== "" ? vuln.cve + " " : "") + (vuln.title ?? "") + "（" + (vuln.severity ?? "unknown") + "）";
    } else if (primary !== undefined) {
      how = primary.title;
    }
    if (primary !== undefined && primary.tool.trim() !== "") {
      how = (how === "" ? "" : how + "；") + "命令：" + primary.tool.trim();
    }
    return {
      engagement_dir: evidenceDir,
      steps, vuln, credentials, accesses, webshells, tunnels,
      how,
      /* 步骤是怎么归因到这条得分的：linked（显式）> vuln（同漏洞）> point（同资产同得分点）> asset（同资产兜底） */
      step_source: stepSource,
      evidence_refs: steps.map((s) => s.evidence_ref).filter((x) => x !== ""),
      complete: gaps.length === 0,
      gaps,
    };
  }


  /* ---------- 得分链路（攻击链页面） ---------- */

  /**
   * 得分链路：把 `score_hit` 按时间拉平成一条链，只含"得分"相关的东西，
   * 不掺任何信息收集流水账。攻击链页面的「得分链路」视图用它。
   *
   * 计分口径与 `listScorePoints` **完全一致**（共用 `evaluateScoreBoard`）：
   *   ① 自己注册/自建的账号不计分（只留过程）；
   *   ② 按得分点自带的 `dedup_scope` 去重；
   *   ③ 按 `rule + cap` 执行规则上限，超出部分不计分。
   */
  scoreChain(id: string, f: unknown = {}): ScoreChain {
    const db = this.db(id);
    const fo = asRecord(f);
    const limit = Math.min(Number(fo["limit"]) || 500, 2000);
    interface ChainRow {
      id: number; point_id: number; asset_id: number | null; vuln_id: number | null; step_id: number | null;
      target: string | null; evidence: string | null; note: string | null; self_created: number | null;
      port: number | null; recorded_by: string | null; recorded_at: string | null;
      code: string | null; point_name: string | null; category: string | null;
      point_default: number | null; points: number | null; enabled: number | null;
      hit_points: number | null; multiplier: number | null; stage_code: string | null;
      asset_ip: string | null; vuln_title: string | null; vuln_cve: string | null;
    }
    const rows = db.prepare<ChainRow>(
      `SELECT h.id, h.point_id, h.asset_id, h.vuln_id, h.step_id, h.target,
        h.evidence, h.note, h.self_created, h.port, h.recorded_by, h.recorded_at,
        p.code, p.name AS point_name, p.category, p.points AS point_default, p.points, p.enabled, h.points AS hit_points, h.multiplier, h.stage_code,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`,
    ).all(limit);
    /* 每一步"靠什么动作拿到的"：① 显式关联的步骤 ② 同一资产上时间最近的步骤（标注为推断） */
    const stepById = new Map<number, {
      id: number; seq: number | null; stage: string | null; title: string | null;
      detail: string | null; asset_id: number | null; point_id: number | null; recorded_at: string | null;
    }>(
      db.prepare<{
        id: number; seq: number | null; stage: string | null; title: string | null;
        detail: string | null; asset_id: number | null; point_id: number | null; recorded_at: string | null;
      }>("SELECT id, seq, stage, title, detail, asset_id, point_id, recorded_at FROM attack_step").all()
        .map((x) => [x.id, x] as const),
    );
    const stepsByAsset = new Map<number, { id: number; seq: number | null; stage: string | null; title: string | null; detail: string | null; asset_id: number | null; point_id: number | null; recorded_at: string | null }[]>();
    for (const st of stepById.values()) {
      if (st.asset_id === null) continue;
      const bucket = stepsByAsset.get(st.asset_id);
      if (bucket === undefined) stepsByAsset.set(st.asset_id, [st]);
      else bucket.push(st);
    }
    for (const list of stepsByAsset.values()) {
      list.sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
    }
    /* 计分口径（与 listScorePoints 完全一致，避免报表和面板分数对不上） */
    const chainMeta = new Map(
      db.prepare<ScorePointRow>("SELECT code, rule, cap, dedup_scope, points, enabled, builtin, src FROM score_point")
        .all()
        .map((r) => scoreMetaFromRow(r) as [string, ScoreMeta]),
    );
    const chainNames = new Map(
      db.prepare<{ id: number; primary_name: string | null }>("SELECT id, primary_name FROM asset")
        .all()
        .filter((a) => a.primary_name !== null && a.primary_name !== "")
        .map((a) => [Number(a.id), String(a.primary_name)] as const),
    );
    /* 本条命中的实际分值：**命中自带档位优先**（合并版里同一条含多档）。
       SQL 用 hit_points / point_default 两个别名把两列分开取：直接取 h.points 会被
       同名的 p.points 遮蔽，攻击链页的档位判定会整个判反。 */
    const chainPointsOf = (it: ChainRow): number => hitPointsOf({
      points: Number(it.hit_points) || Number(it.point_default) || 0,
      multiplier: it.multiplier,
      code: it.code,
    });
    const chainEval = evaluateScoreBoard(
      rows.map((it) => ({
        id: it.id, code: it.code, points: chainPointsOf(it), asset_id: it.asset_id,
        port: it.port, target: it.target, recorded_at: it.recorded_at,
        self_created: it.self_created, evidence: it.evidence, multiplier: it.multiplier,
      })),
      chainMeta, chainNames, { enabledOnly: true },
    );
    const capFlagById = chainEval.byId;
    const items: ChainItem[] = rows.map((it) => {
      let step = it.step_id === null ? undefined : stepById.get(it.step_id);
      let inferred = false;
      if (step === undefined) {
        step = Array.from(stepById.values()).find((x) => x.point_id === it.point_id && x.asset_id === it.asset_id);
      }
      if (step === undefined && it.asset_id !== null) {
        const cands = (stepsByAsset.get(it.asset_id) ?? []).filter((x) => String(x.recorded_at) <= String(it.recorded_at));
        if (cands.length > 0) {
          step = cands[cands.length - 1];
          inferred = true;
        }
      }
      const flag = capFlagById.get(it.id);
      const capped = flag !== undefined && flag.capped;
      const meta = chainMeta.get(String(it.code ?? "")) ?? {
        rule: null, cap: 0, dedup_scope: "service" as const, points: 0, enabled: 1, builtin: false, src: null,
      };
      const selfCreated = Number(it.self_created) === 1;
      const points = chainPointsOf(it);
      return {
        id: it.id,
        point_id: it.point_id,
        asset_id: it.asset_id,
        vuln_id: it.vuln_id,
        step_id: it.step_id,
        target: it.target,
        evidence: it.evidence,
        note: it.note,
        code: it.code,
        point_name: it.point_name,
        category: it.category,
        point_default: Number(it.point_default) || 0,
        points,
        multiplier: it.multiplier,
        asset_ip: it.asset_ip,
        vuln_title: it.vuln_title,
        vuln_cve: it.vuln_cve,
        action: step === undefined ? null : { id: step.id, seq: step.seq, stage: step.stage, title: step.title, detail: step.detail },
        action_inferred: inferred,
        self_created: selfCreated,
        capped,
        port: normalizePort(it.port) ?? parseTargetPort(it.target),
        service: meta.dedup_scope === "none"
          ? null
          : serviceLabel({ id: it.id, target: it.target, port: it.port }),
        capped_reason_kind: flag === undefined ? null : flag.capped_reason_kind,
        rule: meta.rule,
        rule_cap: meta.cap,
        capped_reason: capped
          ? scoreCapReasonText(
            {
              id: it.id, target: it.target, port: it.port,
              rule: meta.rule, rule_cap: meta.cap,
              capped_reason_kind: flag?.capped_reason_kind ?? null,
            },
            flag?.capped_by_points ?? null,
          )
          : null,
        nth_of_point: 1,
        /* 停用得分点的命中不计分（与面板/报告口径一致：enabledOnly） */
        counted: !selfCreated && !capped && !chainEval.disabledIds.has(it.id),
      };
    });
    /* `nth_of_point` 要在整批算完之后统一回填：边算边写会拿到只到当前行的计数 */
    const seenOf = new Map<number, number>();
    for (const it of items) {
      const seen = seenOf.get(it.point_id) ?? 0;
      if (!it.self_created && !it.capped) seenOf.set(it.point_id, seen + 1);
      it.nth_of_point = seen + 1;
    }
    /* 按得分点聚合出"哪些还没拿下"，方便一眼看出缺口 */
    const points = db.prepare<{ id: number; code: string | null; name: string; category: string | null; points: number | null; enabled: number | null }>(
      "SELECT id, code, name, category, points, enabled FROM score_point ORDER BY sort_order, id",
    ).all();
    const hitPointIds = new Set(items.map((x) => x.point_id));
    const achieved = points.filter((p) => hitPointIds.has(p.id) && p.enabled === 1)
      .map((p) => ({ id: p.id, code: p.code, name: p.name, category: p.category }));
    const missing = points.filter((p) => !hitPointIds.has(p.id) && p.enabled === 1)
      .map((p) => ({ id: p.id, code: p.code, name: p.name, category: p.category }));

    /* ── 攻击链：按「攻击面位置」把得分串成五阶段，并给出累计分 ────────────── */
    const assetIds = Array.from(new Set(items.map((x) => x.asset_id).filter((v): v is number => v !== null)));
    interface AssetInfo {
      id: number; ip: string; segment_cidr: string; scope: string | null; state: string | null;
      priority: string | null; open_ports: number; vulns: number;
    }
    const assetInfo = new Map<number, AssetInfo>();
    if (assetIds.length > 0) {
      const ph = placeholders(assetIds.length);
      const rows2 = db.prepare<AssetInfo>(
        `SELECT a.id, a.ip, a.segment_cidr, COALESCE(a.scope, (${SCOPE_SQL})) AS scope, a.state, a.priority,
          (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
          (SELECT COUNT(*) FROM vuln v WHERE v.asset_id = a.id AND v.status IN ('confirmed','exploited')) AS vulns
        FROM asset a WHERE a.id IN (${ph})`,
      ).all(...assetIds);
      for (const row of rows2) assetInfo.set(row.id, row);
    }
    /* 每条得分落在哪个阶段：自动推导（显式 stage_code > 类型特判 > 资产内外网 > target 地址） */
    for (const it of items) {
      const info = it.asset_id === null ? undefined : assetInfo.get(it.asset_id);
      it.stage_code = scoreStageOf(
        { stage_code: it.stage_code, code: it.code, target: it.target },
        info?.scope ?? null,
      );
    }
    const assetChip = (assetId: number): AssetInfo | null => assetInfo.get(assetId) ?? null;
    /* 攻击步骤按阶段计数（攻击链只看"各阶段有多少动作"，不展开明细） */
    const stepsByStage = new Map<string, number>();
    try {
      for (const row of db.prepare<{ stage: string | null; stage_code: string | null }>(
        "SELECT stage, stage_code FROM attack_step LIMIT 5000",
      ).all()) {
        const code = row.stage_code ?? LEGACY_STAGE_MAP[row.stage ?? ""] ?? "recon";
        stepsByStage.set(code, (stepsByStage.get(code) ?? 0) + 1);
      }
    } catch {
      /* ignore */
    }
    /* 会话隧道表的真实隧道：属于「边界突破」阶段的实锤 */
    let tunnels: TunnelView[] = [];
    try {
      tunnels = db.prepare<TunnelRow>(
        "SELECT id, kind, listen, entry, reach, entry_kind, status, note FROM tunnel ORDER BY id DESC LIMIT 50",
      ).all().map((t) => ({
        ...t,
        asset_id: null, webshell_id: null, last_check: null, check_note: null, latency_ms: null,
        pid: null, command: null, found_by_agent: null, created_at: null, updated_at: null, agent: null,
        asset_ip: null, webshell_url: null,
        legit: tunnelIsLegit(t.entry_kind),
        entry_kind_label: t.entry_kind === null ? null : (TUNNEL_ENTRY_KINDS[t.entry_kind] ?? null),
      }));
    } catch {
      tunnels = [];
    }
    /* 只有真正跨越靶标边界的隧道才算"边界突破"的实锤 */
    const legitTunnels = tunnels.filter((t) => t.legit === true);
    const selfOnlyTunnels = tunnels.filter((t) => t.legit === false);

    const stageDefs = this.listStages(id);
    let cumulative = 0;
    const stages: ChainStage[] = stageDefs.map((st, si) => {
      const sItems = items.filter((x) => x.stage_code === st.code);
      const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0);
      cumulative += pts;
      /* 本阶段涉及的资产（去重）。信息收集阶段给"所有拿到分数的资产"，其余阶段给自己的 */
      const ids = st.code === "recon"
        ? Array.from(new Set(items.map((x) => x.asset_id).filter((v): v is number => v !== null)))
        : Array.from(new Set(sItems.map((x) => x.asset_id).filter((v): v is number => v !== null)));
      const assets = ids.map(assetChip)
        .filter((a): a is AssetInfo => a !== null)
        .map((a) => {
          const mine = items.filter((x) => x.asset_id === a.id);
          return {
            ...a,
            points: mine.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
            hits: mine.length,
            /* 该资产的分落在哪个阶段（同一资产可能被内外网两侧都打到） */
            stage_code: mine.length > 0 ? (mine[0]?.stage_code ?? st.code) : st.code,
          };
        })
        .sort((a, b) => b.points - a.points || b.hits - a.hits);
      return {
        ...st,
        ordinal: si + 1,
        items: sItems,
        hits: sItems.length,
        counted: sItems.filter((x) => x.counted).length,
        points: pts,
        cumulative,
        assets,
        assetCount: assets.length,
        tunnels: st.code === "boundary" ? legitTunnels : [],
        tunnels_self_only: st.code === "boundary" ? selfOnlyTunnels : [],
        steps: stepsByStage.get(st.code) ?? 0,
      };
    });

    const scores = this.listScorePoints(id);
    return {
      items,
      stages,
      achieved,
      missing,
      summary: {
        hits: items.length,
        /* 计分口径与得分面板一致：同类得分不设上限，按命中次数累加 */
        points: scores.summary.achievedPoints,
        countedHits: scores.summary.countedHits,
        achievedCount: achieved.length,
        missingCount: missing.length,
        missingPoints: missing.reduce((n, p) => n + (Number(points.find((x) => x.id === p.id)?.points) || 0), 0),
        selfCreatedHits: scores.summary.selfCreatedHits,
        /* 同资产同端口重复命中、按服务封顶而不计分的条数（账号类 / 数据库权限） */
        serviceCappedHits: scores.summary.serviceCappedHits,
        tunnelsLegit: legitTunnels.length,
        tunnelsSelfOnly: selfOnlyTunnels.length,
      },
    };
  }


  /* ---------- 得分复现报告 ---------- */

  /**
   * 攻击得分链路复现报告：只收录"拿到了分"的成果，平铺成列表。
   *
   * 每条都尽量带上能直接粘进 Yakit Repeater 的原始请求：
   *   ① 显式关联的漏洞（`score_hit.vuln_id`）→ 该漏洞的 `http_evidence`（最准）；
   *   ② 兜底：同资产 + 按目标 URL 路径匹配（标注为自动匹配）；
   *   ③ 都没有 → 只给证据文本，并标 `missing_evidence`。
   *
   * 每条另附 **「怎么拿到的」**（`hitTrace`）：动作步骤（含实际命令与回显）+
   * 利用的漏洞 + 拿到的凭据 / WebShell / 隧道 —— 回答"账号密码怎么来的、隧道怎么搭建的"。
   *
   * ## 计分口径必须与面板一致
   *
   * 三个"排除"与 `listScorePoints` 完全对齐：自建账号、被去重/封顶的、停用得分点的；
   * 否则同一个交付物里会出现两个总分（实测面板 50 分、报告 150 分）。
   */
  scoreReport(id: string, options: unknown = {}): ScoreReport {
    const db = this.db(id);
    const opts = asRecord(options);
    const meta = readMeta(this.metaPathOf(id)) ?? {};
    const limit = Math.min(Number(opts["limit"]) || 500, 2000);
    interface ReportRow {
      id: number; point_id: number; asset_id: number | null; vuln_id: number | null; step_id: number | null;
      target: string | null; evidence: string | null; note: string | null; self_created: number | null;
      port: number | null; recorded_by: string | null; recorded_at: string | null;
      points: number | null; multiplier: number | null; stage_code: string | null;
      code: string | null; point_name: string | null; point_default: number | null; category: string | null;
      point_enabled: number | null; point_rule: number | null; point_tier: string | null; point_cap: number | null;
      point_dedup: string | null; point_src: number | null; point_desc: string | null;
      asset_ip: string | null; vuln_title: string | null; vuln_cve: string | null;
      vuln_gained: string | null; vuln_severity: string | null;
    }
    const rows = db.prepare<ReportRow>(
      `SELECT h.*, p.code, p.name AS point_name, p.points AS point_default, p.category,
        p.enabled AS point_enabled, p.rule AS point_rule, p.tier AS point_tier, p.cap AS point_cap,
        p.dedup_scope AS point_dedup, p.src AS point_src, p.description AS point_desc,
        a.ip AS asset_ip, v.title AS vuln_title, v.cve AS vuln_cve, v.gained AS vuln_gained, v.severity AS vuln_severity
      FROM score_hit h
      LEFT JOIN score_point p ON p.id = h.point_id
      LEFT JOIN asset a ON a.id = h.asset_id
      LEFT JOIN vuln v ON v.id = h.vuln_id
      ORDER BY h.recorded_at, h.id LIMIT ?`,
    ).all(limit);

    const perPoint = new Map<number, number>();
    const eviByVuln = db.prepare<{
      id: number; label: string | null; method: string | null; url: string | null; status: number | null;
      request: string | null; response: string | null; note: string | null; captured_at: string | null;
    }>(
      `SELECT id, label, method, url, status, request, response, note, captured_at
      FROM http_evidence WHERE vuln_id = ? ORDER BY id`,
    );
    const clip = (t: string | null, n: number): string => {
      const s = t ?? "";
      return s.length > n ? s.slice(0, n) + "\n…（截断，完整内容见证据文件）" : s;
    };

    /* 每条命中落在攻击链的哪个阶段（与攻击链页同一套推导规则） */
    const scopeOf = new Map<number, string | null>();
    if (rows.length > 0) {
      const ids = Array.from(new Set(rows.map((r) => r.asset_id).filter((v): v is number => v !== null)));
      if (ids.length > 0) {
        const ph = placeholders(ids.length);
        for (const a of db.prepare<{ id: number; scope: string | null }>(
          `SELECT id, COALESCE(scope, (${SCOPE_SQL})) AS scope FROM asset WHERE id IN (${ph})`,
        ).all(...ids)) {
          scopeOf.set(a.id, a.scope);
        }
      }
    }
    /* 自己注册/自建的账号不算成果：从报告主体剔除，只在页脚给一个数字 */
    const selfCreatedRows = rows.filter((h) => Number(h.self_created) === 1);
    /* 计分评估走共享实现，且**带上 enabledOnly**：面板只累加启用的得分点，
       报告如果不看 enabled 就会出现"面板 50 分、报告 150 分"这种自相矛盾的交付物。 */
    const reportMeta = new Map(
      db.prepare<ScorePointRow>("SELECT code, rule, cap, dedup_scope, points, enabled, builtin, src FROM score_point")
        .all()
        .map((r) => scoreMetaFromRow(r) as [string, ScoreMeta]),
    );
    const reportNames = new Map(
      db.prepare<{ id: number; primary_name: string | null }>("SELECT id, primary_name FROM asset")
        .all()
        .filter((a) => a.primary_name !== null && a.primary_name !== "")
        .map((a) => [Number(a.id), String(a.primary_name)] as const),
    );
    /* 命中自带 points 时以命中为准（合并版一条含多档）。倍率乘在档位分值上 ——
       调共享的 hitPointsOf，保证面板/报告/攻击链三处口径一致。 */
    const effPoints = (h: ReportRow): number => hitPointsOf(
      { points: h.points, multiplier: h.multiplier, code: h.code },
      new Map([[String(h.code ?? ""), {
        points: h.point_default !== null ? Number(h.point_default) || 0 : (reportMeta.get(String(h.code ?? ""))?.points ?? 0),
      }]]),
    );
    const reportEval = evaluateScoreBoard(
      rows.map((h) => ({
        id: h.id, code: h.code, points: effPoints(h), asset_id: h.asset_id, port: h.port,
        target: h.target, recorded_at: h.recorded_at, self_created: h.self_created, evidence: h.evidence,
        multiplier: h.multiplier,
      })),
      reportMeta, reportNames, { enabledOnly: true },
    );
    const capFlagById = reportEval.byId;
    const isCappedRow = (h: ReportRow): boolean => {
      const flag = capFlagById.get(h.id);
      return flag !== undefined && flag.capped;
    };
    const isDisabledRow = (h: ReportRow): boolean => h.point_enabled !== null && Number(h.point_enabled) !== 1;
    const reportRows = rows.filter((h) => Number(h.self_created) !== 1 && !isCappedRow(h) && !isDisabledRow(h));
    const serviceCappedRows = rows.filter((h) => Number(h.self_created) !== 1 && isCappedRow(h));

    const items: ReportItem[] = reportRows.map((h, i) => {
      const seen = perPoint.get(h.point_id) ?? 0;
      perPoint.set(h.point_id, seen + 1);
      const counted = true;
      const hitPoints = effPoints(h);

      /* "怎么拿到的"：动作步骤 + 漏洞 + 凭据/入口（报告的核心，缺了就是没法交付） */
      const trace = this.hitTrace(db, h, id);

      /* 原始请求：先按显式关联的漏洞取 */
      let requests: ReportRequest[] = h.vuln_id === null
        ? []
        : eviByVuln.all(h.vuln_id).map((e) => ({
          label: e.label ?? (e.method ?? "") + " " + (e.url ?? ""),
          method: e.method, url: e.url, status: e.status,
          request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: "linked",
        }));
      /* 兜底：同资产 + 目标路径逐级降级匹配（先精确到两级路径，再退到一级、再到整个授权） */
      if (requests.length === 0 && h.target !== null && h.target !== "") {
        const full = h.target.trim();
        const um = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]+)(\/[^?#\s]*)?/i.exec(full);
        const candidates: string[] = [];
        if (um !== null) {
          const authority = um[2] ?? "";
          const segs = (um[3] ?? "").split("/").filter(Boolean);
          if (segs.length >= 2) candidates.push("%" + authority + "/" + segs.slice(0, 2).join("/") + "%");
          if (segs.length >= 1) candidates.push("%" + authority + "/" + (segs[0] ?? "") + "%");
          candidates.push("%" + authority + "%");
          if (segs.length >= 2) candidates.push("%/" + segs.slice(0, 2).join("/") + "%");
        } else {
          const auth = full.split("/")[0]?.split("?")[0] ?? "";
          if (auth !== "") candidates.push("%" + auth + "%");
        }
        const SQL_ASSET = "SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE asset_id = ? AND url LIKE ? ORDER BY id LIMIT 3";
        const SQL = "SELECT id, label, method, url, status, request, response, note FROM http_evidence WHERE url LIKE ? ORDER BY id LIMIT 3";
        interface EvRow {
          id: number; label: string | null; method: string | null; url: string | null;
          status: number | null; request: string | null; response: string | null; note: string | null;
        }
        let found: EvRow[] = [];
        if (h.asset_id !== null) {
          for (const like of candidates) {
            found = db.prepare<EvRow>(SQL_ASSET).all(h.asset_id, like);
            if (found.length > 0) break;
          }
        }
        if (found.length === 0) {
          for (const like of candidates) {
            found = db.prepare<EvRow>(SQL).all(like);
            if (found.length > 0) break;
          }
        }
        requests = found.map((e) => ({
          label: e.label ?? (e.method ?? "") + " " + (e.url ?? ""),
          method: e.method, url: e.url, status: e.status,
          request: clip(e.request, 20000), response: clip(e.response, 8000), note: e.note, source: "auto",
        }));
      }
      /* ── 复现入口：请求 / 命令 / 判定标准 ──────────────────────────────────
         库里其实有料：攻击步骤的 tool 常常就是那条 curl，target 就是这个请求的地址。
         这里整理成三样东西：
           · replay_cmd  —— 能直接粘进终端跑的命令（真实 curl 原样保留，其余按 URL 合成）
           · replay_http —— 能粘进 Yakit Repeater 的原始报文（有真实抓包用真实的，否则合成）
           · confirm     —— 这条凭什么算拿到、要附什么材料、从哪复现
         **合成的一律标 synthesized + 说明来源**，不能让验收人把推断当实证。 */
      const firstStepTool = (trace.steps.find((x) => x.tool.trim() !== "")?.tool) ?? "";
      const parsedCurl = parseCurl(firstStepTool);
      const targetParsed = parseTarget(h.target ?? "");
      const schemeIsHttp = targetParsed !== null && (targetParsed.scheme === "http" || targetParsed.scheme === "https");
      /* 判定"这条是 HTTP 交互"的三条依据，命中任一即可 */
      const isHttpEntry = parsedCurl !== null
        || (requests.length > 0 && (requests[0]?.request ?? "").trim() !== "")
        || schemeIsHttp;
      const confirm = scoreConfirmOf(h.code);

      /* ── 复现命令：先看"这条得分靠什么资产成立"，再挑命令 ────────────────────
           · real        —— 攻击时确实敲过、且就是这次 HTTP 交互的 curl
           · synthesized —— 由**真实抓获请求**或目标 URL 合成的 curl（命令行等价形式）
           · template    —— 该得分点自己的动作模板（资产已把它填成可跑的命令）
           · from_step   —— 取自攻击步骤的真实命令（可能不是"本步"的动作，如实标注）
         ⚠️ 顺序错误的代价（实测）：边界突破条目靠**隧道**成立，但同资产的攻击步骤里
         记着"上传冰蝎马"的 curl；若先判"步骤里有 curl 就用它"，报告就会把上传命令
         当成边界突破的复现命令 —— 张冠李戴，用户照着跑根本复现不出"跨进内网"。 */
      const capturedRequest = requests.length > 0 ? (requests[0]?.request ?? "").trim() : "";
      const capturedCurl = (() => {
        if (capturedRequest === "") return null;
        const firstLine = capturedRequest.split(/\r?\n/)[0] ?? "";
        const m = /^([A-Z]+)\s+(\S+)/.exec(firstLine);
        const hostLine = /^host:\s*(\S+)/im.exec(capturedRequest);
        if (m === null || hostLine === null || hostLine[1] === undefined || m[1] === undefined || m[2] === undefined) return null;
        const scheme = /:443$/.test(hostLine[1]) ? "https" : "http";
        /* path 单独带出来：parseTarget 会在 '?' 处截断，只给 url 会丢掉查询串。
           鉴权与内容类型头同样要带（Basic 少了就是 401，POST 少了就是 415）。 */
        const keep: string[] = [];
        for (const line of capturedRequest.split(/\r?\n/).slice(1)) {
          if (/^(authorization|content-type|accept|x-requested-with|referer):/i.test(line.trim())) keep.push(line.trim());
        }
        return { url: scheme + "://" + hostLine[1] + m[2], method: m[1], path: m[2], headers: keep };
      })();

      const tunnel0 = trace.tunnels[0] ?? null;
      const listenPort = tunnel0 === null || (tunnel0.listen ?? "") === ""
        ? null
        : ((/:([0-9]{1,5})$/.exec(String(tunnel0.listen)) ?? [])[1] ?? null);
      const reach = tunnel0 === null ? null : String(tunnel0.reach ?? "").trim();
      const t0 = parseTarget(h.target ?? "");
      const cred0 = trace.credentials.find((c) => (c.username ?? "") !== "") ?? trace.credentials[0];
      const templateValues = {
        host: (reach === null || reach === "" ? null : reach.replace(/\/[0-9]{1,3}$/, "")) ?? t0?.host ?? null,
        port: listenPort ?? t0?.port ?? null,
        user: cred0?.username ?? null,
        pass: cred0?.secret_value ?? null,
        url: h.target ?? null,
      };

      let replayCmd: string | null = null;
      let replayCmdKind: string | null = null;
      let replayCmdUnfilled: readonly string[] = [];
      const curlIsThisAction = commandKind(firstStepTool) === "curl";
      /* 本条**显式关联**的那条攻击步骤里记的命令：这才是"这次动作到底敲了什么"。
         只认显式关联（h.step_id），不认同资产推断出来的历史步骤。 */
      const linkedStep = trace.steps.find((st) => st.id === h.step_id) ?? null;
      const linkedTool = linkedStep === null ? "" : linkedStep.tool.trim();
      const looksLikeCommand = (t: string): boolean => t.length >= 8 && /^[A-Za-z0-9_./~$-]+/.test(t) && /\s/.test(t);

      if (capturedRequest !== "" && capturedCurl !== null) {
        /* ① 有真实抓获报文：命令行等价形式与报文严格对应，最不会误导。
           请求体**只从这份报文里取**，不能借用攻击步骤里那条 curl 的 data。 */
        const sep = capturedRequest.search(/\r?\n\r?\n/);
        const body = sep === -1 ? "" : capturedRequest.slice(sep).replace(/^\r?\n\r?\n/, "").trim();
        replayCmd = buildCurlCommand({
          url: capturedCurl.url, path: capturedCurl.path, method: capturedCurl.method,
          headers: capturedCurl.headers,
          data: body === "" ? null : body,
          cookie: parsedCurl === null ? null : parsedCurl.cookie,
        });
        replayCmdKind = "synthesized";
      } else if (linkedTool !== "" && looksLikeCommand(linkedTool)) {
        /* ①′ 本条动作的真实命令（含 impacket / nxc / mysql / redis-cli 这类非 curl 工具）。
            这类命令过去会被丢掉、退回通用模板（模板是"id; whoami; hostname"这种判定语），
            用户照着跑什么也复现不出来 —— 报告里最误导的一处，现在改成原样给出。 */
        replayCmd = linkedTool;
        replayCmdKind = commandKind(linkedTool) === "curl" ? "real" : "linked";
      } else if (curlIsThisAction && !(tunnel0 !== null && confirm !== null && confirm.script !== "")) {
        /* ② 真实 curl，且这条得分不是"靠隧道成立"的 */
        replayCmd = firstStepTool;
        replayCmdKind = "real";
      } else if (confirm !== null && confirm.script !== "") {
        /* ③ 得分点自己的动作模板：用本条记录的目标/隧道/凭据填成可跑的命令 */
        replayCmdKind = "template";
        const filled = fillTemplate(confirm.script, templateValues);
        replayCmd = filled.cmd;
        replayCmdUnfilled = filled.remaining;
      } else if (curlIsThisAction) {
        replayCmd = firstStepTool;
        replayCmdKind = "real";
      } else if (commandKind(firstStepTool) !== null) {
        /* ④ 步骤里的其它真实命令：如实说明它不是"本步"的动作 */
        replayCmd = firstStepTool;
        replayCmdKind = "from_step";
      }

      /* 原始报文：优先真实抓包；其次从真实 curl 合成；否则仅当 target 写了 http(s):// 才合成 */
      let replayHttp: string | null = null;
      let replayHttpSynthesized = false;
      if (requests.length > 0 && (requests[0]?.request ?? "").trim() !== "") {
        replayHttp = requests[0]?.request ?? null;
      } else if (parsedCurl !== null) {
        replayHttp = buildHttpRequest({
          url: parsedCurl.url, method: parsedCurl.method, data: parsedCurl.data,
          headers: parsedCurl.headers, cookie: parsedCurl.cookie,
          insecure: parsedCurl.insecure, followRedirect: parsedCurl.followRedirect,
        });
        replayHttpSynthesized = replayHttp !== null;
      } else if (schemeIsHttp) {
        replayHttp = buildHttpRequest({ url: h.target, method: "GET" });
        replayHttpSynthesized = replayHttp !== null;
      }
      return {
        seq: i + 1,
        id: h.id,
        point_id: h.point_id,
        asset_id: h.asset_id,
        /* 显式关联的动作步骤 id：报告据此把"同一次批量动作"的条目合并成一条 + 台账表 */
        step_id: h.step_id,
        point_rule: h.point_rule,
        point_tier: h.point_tier ?? "",
        point_cap: Number(h.point_cap) || 0,
        point_dedup: h.point_dedup ?? "",
        code: h.code ?? "",
        stage_code: scoreStageOf(
          { stage_code: h.stage_code, code: h.code, target: h.target },
          h.asset_id === null ? null : (scopeOf.get(h.asset_id) ?? null),
        ),
        point_name: h.point_name ?? "（已删除的得分点）",
        category: h.category ?? "",
        points: hitPoints,
        counted,
        nth_of_point: seen + 1,
        target: h.target ?? "",
        asset_ip: h.asset_ip ?? "",
        gained: h.vuln_gained ?? "",
        vuln: h.vuln_id === null ? null : { id: h.vuln_id, title: h.vuln_title ?? "", cve: h.vuln_cve, severity: h.vuln_severity },
        evidence: h.evidence ?? "",
        note: h.note ?? "",
        recorded_by: h.recorded_by ?? "",
        recorded_at: h.recorded_at ?? "",
        requests,
        missing_evidence: requests.length === 0,
        replay_cmd: replayCmd,
        replay_cmd_kind: replayCmdKind,
        replay_cmd_unfilled: replayCmdKind === "template" && replayCmdUnfilled.length > 0 ? replayCmdUnfilled : undefined,
        shots: [],
        replay_http: replayHttp,
        replay_http_synthesized: replayHttpSynthesized,
        /* 这份报文是当日真实抓包，还是按当日命令/回显重建的 */
        replay_http_rebuilt: requests.length > 0
          && /重建|按当日.*(命令|回显)|未留存原始抓包/.test(String(requests[0]?.note ?? "")),
        /* 这条得分是不是"靠 HTTP 交互"拿到的 */
        http_entry: isHttpEntry,
        replay_source: requests.length > 0
          ? (capturedRequest !== "" ? (requests[0]?.source === "linked" ? "linked" : "auto")
            : (replayCmdKind === "from_step" ? "step" : "request"))
          : (replayCmdKind === "from_step"
            ? "step"
            : (replayCmdKind === "template" ? "template" : (replayCmd !== null || replayHttp !== null ? "synthesized" : null))),
        confirm,
        confirm_missing: confirm === null,
        trace,
        how: trace.how,
        steps: trace.steps,
        credentials: trace.credentials,
        accesses: trace.accesses,
        webshells: trace.webshells,
        tunnels: trace.tunnels,
        incomplete: !trace.complete,
        gaps: trace.gaps,
        shot_total: 0,
      };
    });

    const summary: ReportSummary = {
      count: items.length,
      points: items.reduce((n, x) => n + (x.counted ? x.points : 0), 0),
      withRequests: items.filter((x) => x.requests.length > 0).length,
      autoMatched: items.filter((x) => x.requests.some((r) => r.source === "auto")).length,
      missingRequests: items.filter((x) => x.missing_evidence).length,
      /* 复现完整性：有步骤且有命令的条目数 / 缺步骤或命令的条目数 */
      withSteps: items.filter((x) => x.steps.length > 0).length,
      withCommands: items.filter((x) => x.steps.some((s) => s.tool.trim() !== "")).length,
      incomplete: items.filter((x) => x.incomplete).length,
      credentials: items.reduce((n, x) => n + x.credentials.length, 0),
      tunnels: items.reduce((n, x) => n + x.tunnels.length, 0),
      selfCreatedExcluded: selfCreatedRows.length,
      serviceCappedExcluded: serviceCappedRows.length,
      disabledExcluded: rows.filter((h) => Number(h.self_created) !== 1 && isDisabledRow(h)).length,
      serviceCapped: serviceCappedRows.map((h) => ({
        id: h.id,
        point_name: h.point_name ?? h.code ?? "",
        code: h.code,
        service: serviceLabel({ id: h.id, target: h.target, port: h.port }, h.asset_ip),
        evidence: h.evidence ?? "",
        target: h.target ?? "",
        points: h.points ?? 0,
        recorded_at: h.recorded_at ?? "",
      })),
    };
    /* ── 条目合并：同一得分点 + 同一动作（同一批攻击步骤）、只有目标不同的条目 ──────
       典型场景：一次批量动作打下 60 台终端。逐台一条会把报告撑成流水账（实测占全文 64%），
       读者反而找不到"这一步到底是怎么做的"。合并成一条 + 目标台账表，
       复现入口只写一次，台数用表格堆。 */
    const groupMin = Math.max(2, Number(opts["groupMin"]) || 5);
    const stepKeyOf = (x: ReportItem): string => (x.step_id === null ? "" : String(x.step_id));
    const merged = ((): ReportItem[] => {
      const buckets = new Map<string, ReportItem[]>();
      for (const x of items) {
        const k = x.point_id + "|" + stepKeyOf(x);
        const bucket = buckets.get(k);
        if (bucket === undefined) buckets.set(k, [x]);
        else bucket.push(x);
      }
      const out: ReportItem[] = [];
      const done = new Set<number>();
      for (const x of items) {
        if (done.has(x.id)) continue;
        const k = x.point_id + "|" + stepKeyOf(x);
        const members = buckets.get(k) ?? [x];
        done.add(x.id);
        if (members.length < groupMin || stepKeyOf(x) === "") {
          out.push(x);
          continue;
        }
        for (const m of members) done.add(m.id);
        /* 代表条目 = 证据文本出现次数最多的那条（众数），而不是时间最早的那条：
           同一批动作里个别目标可能是另一种打法（实测 64 台终端里第一台用的是域管账号），
           拿它当整组说明会把特例写成通例。
           证据文本逐台不同（里面写着各自的 IP/主机名），所以先做"数字归一化"再取众数。 */
        const freq = new Map<string, number>();
        const norm = (t: string | null): string => String(t ?? "").replace(/[0-9]/g, "#");
        for (const m of members) {
          const key = norm(m.evidence);
          freq.set(key, (freq.get(key) ?? 0) + 1);
        }
        const rep = members.slice().sort((a, b) => (freq.get(norm(b.evidence)) ?? 0) - (freq.get(norm(a.evidence)) ?? 0)
          || String(a.recorded_at).localeCompare(String(b.recorded_at)))[0] ?? x;
        out.push({
          ...rep,
          is_group: true,
          group_size: members.length,
          /* 合并条目在链路里的位置按"最早那一台"算：批量动作从第一台成功起就算发生了 */
          order_at: members.map((m) => String(m.recorded_at)).sort()[0] ?? rep.recorded_at,
          points: members.reduce((n, m) => n + m.points, 0),
          group_targets: members.map((m) => ({
            id: m.id, target: m.target, points: m.points, evidence: m.evidence, recorded_at: m.recorded_at,
          })),
        });
      }
      return out;
    })();

    /* ── 证据截图：按"得分点"取代表图（最多 3 张），分组条目用全体成员的命中一起去认领 ──
       ⚠️ 代表图按**得分点**选，不是按条目选：一个得分点有 6 台域控就是 6 个条目，
       按条目各选 3 张会让同 3 张图在正文里重复出现 6 遍（实测 22 条正文贴出 58 张图）。 */
    const pointHitIds = new Map<number, number[]>();
    for (const x of merged) {
      const pid = Number(x.point_id);
      let list = pointHitIds.get(pid);
      if (list === undefined) {
        list = [];
        pointHitIds.set(pid, list);
      }
      const ids = x.is_group === true ? (x.group_targets ?? []).map((g) => g.id) : [x.id];
      for (const hid of ids) if (list.indexOf(hid) === -1) list.push(hid);
    }
    const shotPicks = this.representativeShots(
      id,
      Array.from(pointHitIds.entries()).map(([pid, ids]) => ({ point_id: pid, hit_ids: ids })),
      3,
    );
    const shotBriefOf = (sh: ShotRow): ShotBrief => ({
      id: Number(sh.id),
      url: this.shotUrlOf(id, sh),
      label: sh.label ?? "",
      note: sh.note ?? "",
      kind: sh.kind ?? "screenshot",
      mime: sh.mime ?? "image/png",
      bytes: Number(sh.bytes) || 0,
      width: sh.width === null ? null : Number(sh.width),
      height: sh.height === null ? null : Number(sh.height),
      target: sh.target ?? "",
      captured_at: sh.captured_at ?? "",
      source_ref: sh.source_ref ?? "",
    });
    const shotTotalByPoint = new Map<number, number>();
    try {
      for (const row of db.prepare<{ point_id: number | null; n: number }>(
        "SELECT point_id, COUNT(*) AS n FROM shot GROUP BY point_id",
      ).all()) {
        if (row.point_id !== null) shotTotalByPoint.set(Number(row.point_id), Number(row.n));
      }
    } catch {
      /* 老库没有 shot 表时忽略 */
    }
    const seenPoint = new Set<number>();
    for (const x of merged) {
      const pid = Number(x.point_id);
      const list = shotPicks.get(pid) ?? [];
      const mine = new Set(x.is_group === true ? (x.group_targets ?? []).map((g) => g.id) : [x.id]);
      const own = list.filter((sh) => sh.hit_id !== null && mine.has(Number(sh.hit_id)));
      const pointLevel = list.filter((sh) => sh.hit_id === null);
      const isFirst = !seenPoint.has(pid);
      seenPoint.add(pid);
      x.shots = own.concat(isFirst ? pointLevel : []).map(shotBriefOf);
      x.shot_total = shotTotalByPoint.get(pid) ?? x.shots.length;
    }

    /* ── 链路排序：阶段顺序（信息收集 → 互联网 → 边界 → 内网 → 靶标）+ 阶段内按动作先后 ──
       ⚠️ ordinal 是**链路里的真实位置**，不是"过滤后的第几条"：`listStages` 的注释写明
       "界面画 ①②③ 与报告排序都用它，不要另行编号"。先编号再过滤掉空阶段，
       会把第 3 阶段的"边界突破"标成 ② —— 攻击链页、报告页、导出的 markdown 会一起错。 */
    const stageRows = this.listStages(id);
    const stageOrder = new Map(stageRows.map((s, i) => [s.code, i] as const));
    const stageOfItem = (x: ReportItem): string =>
      (x.stage_code !== "" && stageOrder.has(x.stage_code) ? x.stage_code : "internet");
    const stepSeqOf = (x: ReportItem): number => {
      const seqs = x.steps.map((s) => Number(s.seq)).filter((n) => Number.isFinite(n));
      return seqs.length > 0 ? Math.min(...seqs) : Number.MAX_SAFE_INTEGER;
    };
    const ordered = merged.slice().sort((a, b) => {
      const sa = stageOrder.get(stageOfItem(a)) ?? 99;
      const sb = stageOrder.get(stageOfItem(b)) ?? 99;
      if (sa !== sb) return sa - sb;
      const ra = String(a.order_at ?? a.recorded_at);
      const rb = String(b.order_at ?? b.recorded_at);
      if (ra !== rb) return ra.localeCompare(rb);
      return stepSeqOf(a) - stepSeqOf(b);
    });
    ordered.forEach((x, i) => {
      x.chain_no = i + 1;
    });

    /* ── 前置推导：这条成果是靠哪条成果铺出来的 ──────────────────────────────
       只用**库里已有的文字**推：把本条的步骤（命令/说明/回显）、凭据（来源/取得方式/备注）
       与证据文本拼成一份语料，看里面出现了别的计分成果的目标 IP —— 出现了就说明
       "这条是站在那条的肩膀上做的"。推不出来就不写，不编造依赖关系。 */
    const ipOfTarget = (t: unknown): string | null => {
      const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(t ?? ""));
      return m === null || m[1] === undefined || m[1] === "127.0.0.1" ? null : m[1];
    };
    const ipsIn = (t: unknown): string[] => {
      const out: string[] = [];
      const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g;
      let m: RegExpExecArray | null;
      const s = String(t ?? "");
      while ((m = re.exec(s)) !== null) {
        if (m[1] !== undefined && m[1] !== "127.0.0.1") out.push(m[1]);
      }
      return out;
    };
    /* 本条用到的凭据：用"证据里出现的口令/账号/主机"去认领凭据库里的记录。 */
    const credsAllForDeps = this.listCredentials(id, {});
    const ownsCred = (x: ReportItem, c: CredentialRow): boolean => {
      /* ⚠️ 判定只能用"本条证据自己写出来的东西"，**不能**把 trace 挂上来的凭据也算进去：
         trace 是"同资产/同主机"的宽松匹配（目标 10.1.2.142 会挂上所有 host 里带该地址的凭据），
         拿它当依据会推出"MySQL 条目依赖域控"这种结论。 */
      const text = [x.evidence, x.note, x.gained, x.target].join("\n");
      const sv = String(c.secret_value ?? "").trim();
      if (sv.length >= 6 && text.indexOf(sv) !== -1) return true;
      const un = String(c.username ?? "").trim();
      /* 账号要"像账号"才算特征串：纯英文单词会撞车 —— 实测边界条目的证据里写着
         `default via 10.1.2.1`，于是把用户名 default 的 Redis 凭据认成了本条的来处。
         带数字/反斜杠/@ 的（工号、域账号）才认。 */
      const accountLike = (v: string): boolean => /[\d\\@]/.test(v) || v.length >= 10;
      if (un.length >= 6 && accountLike(un) && text.indexOf(un) !== -1) {
        /* 账号是共享的（一个域管账号会出现在几十条证据里），所以还要主机对得上 */
        const cip = ipOfTarget(c.host);
        if (cip === null) return true;
        return cip === ipOfTarget(x.target) || text.indexOf(cip) !== -1;
      }
      /* 不用"凭据 host 出现在证据里"来认领：目标 10.1.2.142 的证据里当然写着它，
         那会把同主机上所有 config-leak 凭据都算成本条用到的。只认口令/账号这类**特征串**。 */
      return false;
    };
    /* 前置候选 = 本条证据里直接提到的地址 + **所认领凭据的来源指针**。
       凭据的 tool/note 里"第一个 IP"通常就是这条口令/权限的来处。 */
    interface DepInfo { no: number; name: string; short: string; target: string }
    const depIds = new Map<number, number[]>();
    for (const x of ordered) {
      /* 强线索：本条用到的凭据是从哪来的（凭据 tool/note 的第一个 IP）。
         弱线索：本条证据里顺带提到的地址（边界条目会把整个网段清单都写进证据，
                 拿它当依赖依据会推出"跨境突破依赖 Redis"这种噪声）。 */
      const strong = new Set<string>();
      for (const c of credsAllForDeps.filter((v) => ownsCred(x, v))) {
        const a = ipOfTarget(c.tool);
        const b = ipOfTarget(c.note);
        if (a !== null) strong.add(a);
        if (b !== null) strong.add(b);
      }
      const weakText = [x.evidence, x.note, x.target].join("\n");
      const weak = new Map<string, number>();
      for (const ip of ipsIn(weakText)) weak.set(ip, (weak.get(ip) ?? 0) + 1);
      /* 弱线索按"在本条证据里被提到的次数"从多到少取 */
      const pick = (get: (ip: string) => number | undefined): { y: ReportItem; w: number }[] => {
        const out: { y: ReportItem; w: number }[] = [];
        for (const y of ordered) {
          if (y === x || y.point_id === x.point_id) continue;
          const ip = ipOfTarget(y.target);
          if (ip === null) continue;
          const w = get(ip);
          if (w === undefined) continue;
          out.push({ y, w });
        }
        out.sort((a, b) => b.w - a.w);
        return out.slice(0, 3);
      };
      const deps: ReportItem[] = pick((ip) => (strong.has(ip) ? 1 : undefined)).map((v) => v.y);
      if (deps.length < 3) {
        for (const v of pick((ip) => weak.get(ip))) {
          if (deps.length >= 3) break;
          if (deps.indexOf(v.y) === -1) deps.push(v.y);
        }
      }
      x.deps = deps.map((y): DepInfo => ({
        no: y.chain_no ?? 0, name: y.code, short: y.code, target: y.target,
      })).sort((a, b) => a.no - b.no);
      depIds.set(x.id, deps.map((y) => y.id));
      /* 环境前置：互联网侧以外的成果都建在"通道"上（隧道 / 被控入口），单独标一句 */
      x.needs_channel = stageOfItem(x) !== "internet" && x.tunnels.length > 0;
    }
    /* 互为前置的两条一起撤掉（例：域控 445 与域控 389 同 IP，会互相指认）：
       报告宁可少写一条前置，也不能出现"A 依赖 B、B 依赖 A"这种自相矛盾的链路。 */
    for (const x of ordered) {
      const kept = (x.deps ?? []).filter((d) => {
        const y = ordered.find((v) => v.chain_no === d.no);
        if (y === undefined) return true;
        return (depIds.get(y.id) ?? []).indexOf(x.id) === -1;
      });
      x.deps = kept;
    }

    /* ── 复现入口分类：决定报告里给"可粘贴报文"还是"命令行"，以及索引表怎么标 ────
       · http    —— 有真实抓包，或被判定为 HTTP 入口且能重建报文 → Burp / Yakit 可直接重放
       · cli     —— 真实命令（当日敲过的那条）→ 终端可跑（非 HTTP 协议，Burp/Yakit 不适用）
       · method  —— 只有该得分点的标准复现动作描述（没有留存命令）→ 如实给动作，不伪造命令 */
    const looksLikeHttpTarget = (t: string): boolean => /^https?:\/\//i.test(t.trim());
    for (const x of ordered) {
      const captured = x.requests.length > 0 && (x.requests[0]?.request ?? "").trim() !== "";
      /* ⚠️ 只有"目标本身就是个 http(s) 地址"或"真有抓包"才给报文。
         否则会把隧道/数据库条目的同资产无关 curl 合成成一份报文（实测出现过
         `POST / HTTP/1.1` + body `-` 这种粘进 Yakit 什么也复现不出来的假报文）。 */
      const httpOk = captured || (looksLikeHttpTarget(x.target) && x.replay_http !== null);
      /* 命令：真实命令优先；模板命令只有在占位符全部填好时才当"可跑的命令"用 */
      const unfilled = x.replay_cmd_unfilled ?? [];
      const cmdOk = x.replay_cmd !== null && x.replay_cmd.trim() !== ""
        && (x.replay_cmd_kind !== "template" || unfilled.length === 0);
      x.repro_kind = httpOk ? "http" : (cmdOk ? "cli" : "method");
      x.repro_http_captured = captured;
      /* 非 HTTP 协议的复现说明（Burp/Yakit 发不了 SMB/数据库/NFS，要写清为什么） */
      const cmd = x.replay_cmd ?? "";
      x.repro_nonhttp = x.repro_kind === "cli"
        && /atexec|nxc |smbclient|impacket|secretsdump|mysql|redis-cli|showmount|mount |winrm|proxychains/.test(cmd);
    }

    /* 阶段分桶（界面与正文共用）：入桶的是**合并后**的条目，分值也是合并后的合计 */
    let cumulative = 0;
    const stages: ReportStage[] = stageRows.map((st) => {
      const sItems = ordered.filter((x) => stageOfItem(x) === st.code);
      const pts = sItems.reduce((n, x) => n + (x.counted ? x.points : 0), 0);
      cumulative += pts;
      return {
        code: st.code, name: st.name, color: st.color, goal: st.goal, transition: st.transition,
        ordinal: st.ordinal, points: pts, cumulative, items: sItems,
      };
    }).filter((st) => st.items.length > 0);

    const markdown = this.renderScoreReportMarkdown({
      id, meta, ordered, stages, summary, rows, reportRows, serviceCappedRows,
      credsAll: credsAllForDeps, ownsCred, ipOfTarget, stageOfItem, shotRefOf: (sh) =>
        (opts["shotRef"] === "relative"
          ? sh.url
          : join(this.shotsDirOf(id), String(sh.url).replace(/^shots\//, ""))),
    });
    return { items: merged, stages, summary, markdown, target: metaString(meta, "target_name", id) };
  }


  /**
   * 把得分报告渲染成 Markdown（`scoreReport` 的最后一段）。
   *
   * ## 结构按"用户要照着复现"来排，不是按"我们记录了多完整"来排
   *
   *   ⓪ 摘要与对账 + 复现索引表（验收人先看这个）
   *   ① 复现前置条件（通道 / 凭据 / 工具接入 / 工具能力边界）
   *   ② 攻击链（按依赖顺序，标注前置）
   *   ③ 逐条明细（复现入口放最前，目标台账、证据索引）
   *   ④ 得分点说明（判定标准与材料要求只讲一次，不在每条重复）
   *   ⑤ 附录（资产、记录与计分对账）
   *
   * ## 两条长度纪律
   *
   * 请求体保完整（Yakit 要能直接重放，截断就废了）；
   * 响应体只做验证，截到 1000 字符并标长度。
   */
  private renderScoreReportMarkdown(ctx: {
    readonly id: string;
    readonly meta: EngagementMeta;
    readonly ordered: readonly ReportItem[];
    readonly stages: readonly ReportStage[];
    readonly summary: ReportSummary;
    readonly rows: readonly { readonly id: number; readonly evidence: string | null; readonly note: string | null; readonly target: string | null; readonly recorded_at: string | null; readonly point_id: number }[];
    readonly reportRows: readonly { readonly id: number; readonly note: string | null; readonly target: string | null; readonly point_name: string | null; readonly code: string | null }[];
    readonly serviceCappedRows: readonly { readonly id: number; readonly target: string | null; readonly code: string | null; readonly evidence: string | null; readonly recorded_at: string | null }[];
    readonly credsAll: readonly CredentialRow[];
    readonly ownsCred: (x: ReportItem, c: CredentialRow) => boolean;
    readonly ipOfTarget: (t: unknown) => string | null;
    readonly stageOfItem: (x: ReportItem) => string;
    readonly shotRefOf: (sh: ShotBrief) => string;
  }): string {
    const { id, meta, ordered, stages, summary, rows, reportRows } = ctx;
    const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
    const AGENT_LABEL = (a: string): string => ROLE_TITLES[a] ?? (a !== "" ? a : "未标注角色");
    const oneLine = (t: unknown, n = 300): string => String(t ?? "").replace(/\s*\n+\s*/g, " ").trim().slice(0, n);
    const shortName = (x: ReportItem): string => POINT_SHORT_NAME[x.code] ?? (x.point_name !== "" ? x.point_name : x.code);
    /* 早期记录里 `->` 被写成了 `-&gt;`（表单转义残留），报告里要还原，否则目标列没法看 */
    const unesc = (t: unknown): string => String(t ?? "")
      .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    /* 合并条目在表格里只写"首台 + 台数"，否则 64 台的长清单会把索引表撑爆 */
    const targetBrief = (x: ReportItem): string => (x.is_group === true
      ? String(x.target) + " 等 " + String(x.group_size ?? 0) + " 个目标"
      : unesc(x.target));
    const md: string[] = [];
    const block = (lang: string, text: string): void => {
      md.push("```" + lang, text.replace(/\r/g, "").trim(), "```", "");
    };
    /* 截断落在句子/分句边界上：直接 slice 会切出"…后端是 3 台 LB 轮询("这种半截句子 */
    const clipText = (t: unknown, n: number): string => {
      const s0 = oneLine(t, n);
      if (s0.length < n) return s0;
      for (const sep of ["。", "；", "）", ")", "，"]) {
        const i = s0.lastIndexOf(sep);
        if (i > n * 0.5) return s0.slice(0, i + 1);
      }
      return s0;
    };
    const targetName = metaString(meta, "target_name", id);
    const httpCount = ordered.filter((x) => x.repro_kind === "http").length;
    const cliCount = ordered.filter((x) => x.repro_kind === "cli").length;
    const methodCount = ordered.filter((x) => x.repro_kind === "method").length;

    md.push("# " + targetName + " · 红队成果复现报告", "");
    md.push("> 本报告只收录**计分成果**：每条给出复现入口（Burp / Yakit 可直放的原始报文，"
      + "或经隧道执行的命令行）、成功判定标准与证据索引，并按攻击链**依赖顺序**编排与标注前置。", "");

    /* ── ⓪ 摘要与对账 ──────────────────────────────────────────────────── */
    md.push("## 0. 摘要与对账", "");
    const shotItems = ordered.filter((x) => x.shots.length > 0);
    const shotTotal = ordered.reduce((n, x) => n + x.shots.length, 0);
    const shotReal = ordered.reduce((n, x) => n + x.shots.filter((v) => v.kind !== "card").length, 0);
    md.push("| 合计得分 | 计分项 | Burp/Yakit 可直放 | 命令行复现 | 其他方式 | 证据截图 |", "| --- | --- | --- | --- | --- | --- |");
    md.push("| **" + summary.points + " 分** | " + ordered.length + " 项 | " + httpCount
      + " 项 | " + cliCount + " 项 | " + methodCount + " 项 | " + shotTotal + " 张 / " + shotItems.length
      + " 条正文" + (shotReal < shotTotal ? "（现场截图 " + shotReal + " 张，其余为记录生成的证据摘录）" : "") + " |", "");
    md.push("### 0.1 得分点占用", "");
    md.push("| 得分点 | 命中 | 本次得分 | 单条上限 |", "| --- | --- | --- | --- |");
    const byPoint = new Map<string, { code: string; name: string; hits: number; points: number; cap: number }>();
    for (const x of ordered) {
      const k = x.code;
      let rec = byPoint.get(k);
      if (rec === undefined) {
        rec = { code: k, name: shortName(x), hits: 0, points: 0, cap: x.point_cap };
        byPoint.set(k, rec);
      }
      rec.hits += x.is_group === true ? (x.group_size ?? 1) : 1;
      rec.points += x.points;
    }
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      md.push("| " + rec.name + "（`" + rec.code + "`） | " + rec.hits + " | +" + rec.points + " 分 | "
        + (Number(rec.cap) > 0 ? Number(rec.cap) + " 分" + (rec.points >= Number(rec.cap) ? "（已满）" : "") : "—") + " |");
    }
    md.push("");
    md.push("### 0.2 记录与计分对账", "");
    md.push("- 库内得分记录 **" + rows.length + " 条** → 计分命中 **" + summary.count + " 条**"
      + " → 合并同动作条目后正文 **" + ordered.length + " 条**（一次批量动作写一条 + 目标台账）"
      + "；另有 **" + (summary.selfCreatedExcluded + summary.serviceCappedExcluded + summary.disabledExcluded)
      + " 条**未计分（见下）。");
    if (summary.serviceCappedExcluded > 0) {
      md.push("- 排除原因：同资产同端口重复的账号/数据库权限 " + summary.serviceCappedExcluded
        + " 条（同一服务取得最高权限即计满，重复不再累加，见附录 5.2）。");
    }
    if (summary.selfCreatedExcluded > 0) md.push("- 排除原因：自己注册/自建账号 " + summary.selfCreatedExcluded + " 条（得分针对拿到别人已有的权限）。");
    if (summary.disabledExcluded > 0) md.push("- 排除原因：所属得分点已被停用 " + summary.disabledExcluded + " 条。");
    const corrected = reportRows.filter((h) => /校正/.test(String(h.note ?? "")));
    if (corrected.length > 0) {
      md.push("", "> **档位校正**：以下 " + corrected.length + " 条在收口复核时下调了档位（面板原始记录值见备注）：", "");
      for (const h of corrected) {
        md.push("- `" + (h.target ?? "") + "`　" + (h.point_name ?? h.code ?? "") + "　" + oneLine(h.note, 200));
      }
    }
    md.push("");
    md.push("### 0.3 复现索引", "");
    md.push("| # | 得分点 | 分值 | 目标 | 前置 | 复现入口 |", "| --- | --- | --- | --- | --- | --- |");
    for (const x of ordered) {
      const dep = (x.deps ?? []).map((d) => "#" + String(d.no)).join("、");
      const entry = x.repro_kind === "http" ? "Burp / Yakit 报文（§3." + String(x.chain_no) + "）"
        : (x.repro_kind === "cli" ? "命令行（§3." + String(x.chain_no) + "）" : "复现方式（§3." + String(x.chain_no) + "）");
      md.push("| " + String(x.chain_no) + " | " + shortName(x) + " | +" + x.points + " | `" + oneLine(targetBrief(x), 60) + "` | "
        + (dep === "" ? (x.needs_channel === true ? "通道（§1.1）" : "—") : dep) + " | " + entry + " |");
    }
    md.push("");

    /* ── ① 复现前置条件 ────────────────────────────────────────────────── */
    const tunnelsAll = this.listTunnels(id);
    const shellsAll = this.listWebshells(id);
    const credsAll = ctx.credsAll;
    /* "本条用到的凭据"再用一遍 ownsCred（证据里写了口令/账号）+ 主机就落在计分目标上的凭据。
       不用 trace 挂上来的那批：它是同资产宽松匹配，会把与本条无关的接口 token 也列进前置条件表。 */
    const scoredHosts = new Set(ordered.map((x) => ctx.ipOfTarget(x.target)).filter((v): v is string => v !== null));
    const referencedCred = new Set<string>();
    for (const x of ordered) {
      for (const c of credsAll.filter((v) => ctx.ownsCred(x, v))) referencedCred.add(String(c.id));
    }
    for (const c of credsAll) {
      const ip = ctx.ipOfTarget(c.host);
      if (ip !== null && scoredHosts.has(ip)) referencedCred.add(String(c.id));
    }
    const credRank = (c: CredentialRow): number => {
      const p = String(c.privilege ?? "");
      if (/domain-admin/.test(p)) return 0;
      if (/local-admin|domain-admin|admin/.test(p)) return 1;
      if (/db-|redis|mysql|system/.test(p)) return 2;
      if (/sso|sharekey|api/.test(p)) return 3;
      return 9;
    };
    /* 排除记录里已写明"没验证通过/只留档"的候选 —— 它们不是可复现入口，列出来只会误导 */
    const usablePool = credsAll.filter((c) => !/未通过|未验证|仅留档|不可作为有效凭据|unknown/.test(String(c.note ?? "") + String(c.privilege ?? "")));
    const usefulCreds = usablePool
      .filter((c) => referencedCred.has(String(c.id)))
      .slice()
      .sort((a, b) => credRank(a) - credRank(b))
      .slice(0, 12);
    md.push("---", "");
    md.push("## 1. 复现前置条件", "");
    md.push("> 先把这一节搭起来，后面每条的复现入口才跑得通。", "");
    md.push("### 1.1 通道", "");
    if (tunnelsAll.length === 0) {
      md.push("本靶标未登记隧道；内网条目需自备到目标的通道。", "");
    } else {
      for (const t of tunnelsAll) {
        md.push("- **" + (t.kind ?? "隧道") + "**：监听 `" + (t.listen ?? "") + "`　入口 `" + (t.entry ?? "") + "`"
          + ((t.entry_kind ?? "") !== "" ? "（entry_kind=" + String(t.entry_kind) + "）" : "")
          + ((t.reach ?? "") !== "" ? "　可达 " + String(t.reach) : "")
          + ((t.status ?? "") !== "" ? "　状态 " + String(t.status) : ""));
        if ((t.command ?? "") !== "") {
          md.push("  - 启动命令：");
          block("bash", String(t.command));
        }
        if ((t.note ?? "") !== "") md.push("  - 说明：" + clipText(t.note, 320));
      }
    }
    if (shellsAll.length > 0) {
      md.push("", "**WebShell / 会话入口**", "");
      for (const w of shellsAll) {
        md.push("- `" + w.url + "`　" + (w.shell_type ?? "") + ((w.pass_key ?? "") !== "" ? "　连接密码 `" + String(w.pass_key) + "`" : "")
          + ((w.status ?? "") !== "" ? "　状态 " + String(w.status) : "") + ((w.note ?? "") !== "" ? "　" + clipText(w.note, 200) : ""));
      }
      md.push("");
    }
    md.push("### 1.2 凭据", "");
    if (usefulCreds.length === 0) {
      md.push("本靶标未登记凭据。", "");
    } else {
      md.push("| 目标 | 账号 | 权限 | 来源 | 取得方式 |", "| --- | --- | --- | --- | --- |");
      for (const c of usefulCreds) {
        md.push("| `" + oneLine(c.host, 40) + "` | `" + oneLine(c.username, 40) + "` | " + oneLine(c.privilege ?? "—", 30)
          + " | " + oneLine(c.source ?? "—", 40) + " | `" + oneLine(c.tool ?? "—", 120) + "` |");
      }
      md.push("");
    }
    md.push("### 1.3 工具接入", "");
    md.push("- **Burp Suite**：Settings → Network → Connections → SOCKS proxy 填 `127.0.0.1:<隧道端口>`，"
      + "并勾选 \"Use SOCKS proxy for DNS lookups\"；Repeater 里整段粘贴本报告的报文即可。", "");
    md.push("- **Yakit**：在「下游代理 / 链式代理」里配置同一个 SOCKS5（含认证），"
      + "「Repeater → 粘贴原始请求」发送。", "");
    md.push("- **命令行**：`proxychains4 -q -f <proxychains 配置>` 前缀挂到 impacket / nxc / smbclient / mysql / redis-cli 等命令前；"
      + "HTTP 面也可用 `curl --socks5-hostname <账号>:<口令>@127.0.0.1:<端口>`。", "");
    md.push("### 1.4 工具能力边界", "");
    md.push("| 目标类型 | 协议 | 推荐工具 |", "| --- | --- | --- |");
    md.push("| Web 应用、管理后台、REST API（含内网） | HTTP / HTTPS | Burp Suite、Yakit（经 SOCKS 上游） |");
    md.push("| WebShell / 隧道 | HTTP / WebSocket | 冰蝎、哥斯拉、suo5（见 §1.1） |");
    md.push("| Windows 主机、域控、共享 | SMB / RPC / WinRM | `impacket-atexec`、`nxc`、`smbclient`、`evil-winrm`、pywinrm（经 proxychains） |");
    md.push("| 数据库 | MySQL / Redis / PostgreSQL | `mysql`、`redis-cli`、`psql`（经 proxychains） |");
    md.push("| 文件共享 | NFS | `showmount`、`mount -t nfs4`（经 proxychains 或被控主机） |");
    md.push("");
    md.push("> Burp / Yakit 只能重放 HTTP(S) 与 WebSocket。SMB、WinRM、数据库、NFS 这类协议"
      + "请按上表用命令行复现 —— 报告里对应的条目给的就是可直接跑的命令。", "");

    /* ── ② 攻击链（按依赖顺序）──────────────────────────────────────────── */
    md.push("---", "");
    md.push("## 2. 攻击链（按依赖顺序）", "");
    md.push("> 序号即文档顺序（按攻击链阶段 ① → ⑤、阶段内按取得时间）。`前置`列写\"这一步之前要先做过的成果\"；"
      + "阶段分桶按得分点类型固定排序，所以前置的编号**可能大于本条目**（例：跨境突破依赖先拿下域控 #16），"
      + "按编号跳过去看即可。", "");
    md.push("| # | 得分点 | 分值 | 目标 | 前置 |", "| --- | --- | --- | --- | --- |");
    for (const x of ordered) {
      const dep = (x.deps ?? []).map((d) => "#" + String(d.no) + " " + (POINT_SHORT_NAME[d.name] ?? d.name)).join("、");
      md.push("| " + String(x.chain_no) + " | " + shortName(x) + " | +" + x.points + " | `" + oneLine(targetBrief(x), 60) + "` | "
        + (dep === "" ? (x.needs_channel === true ? "通道（§1.1）" : "—") : dep) + " |");
    }
    md.push("");
    for (const st of stages) {
      md.push("- " + st.name + "：" + st.items.length + " 项 · +" + st.points + " 分（累计 +" + st.cumulative + " 分）");
    }
    md.push("");

    /* ── ③ 逐条明细 ────────────────────────────────────────────────────── */
    md.push("---", "");
    md.push("## 3. 逐条明细", "");
    md.push("> 按攻击链阶段 ① → ⑤ 排列（阶段序号即链路里的真实位置）；阶段内按动作先后排序，"
      + "序号 `3.N` 与前面的复现索引一一对应。", "");
    let lastStage: string | null = null;
    for (const x of ordered) {
      const st = ctx.stageOfItem(x);
      if (st !== lastStage) {
        lastStage = st;
        const sr = stages.find((v) => v.code === st);
        if (sr !== undefined) {
          const circled = CIRCLED[sr.ordinal - 1] ?? "";
          md.push("## " + circled + " " + sr.name + "（" + sr.items.length + " 项 · +" + sr.points + " 分）", "");
        }
      }
      const depTxt = (x.deps ?? []).map((d) => "#" + String(d.no) + " " + (POINT_SHORT_NAME[d.name] ?? d.name)
        + "（`" + oneLine(d.target, 40) + "`）").join("、");
      md.push("### 3." + String(x.chain_no) + " " + shortName(x) + " · `" + oneLine(targetBrief(x), 80) + "`　**+" + x.points + " 分**", "");
      md.push("- **得分点**：" + x.point_name + "　`" + x.code + "`"
        + (x.point_rule !== null ? "　规则 " + String(x.point_rule) : "")
        + (x.point_tier !== "" ? "　档位 " + oneLine(x.point_tier, 40) : "")
        + (Number(x.point_cap) > 0 ? "　单条上限 " + String(x.point_cap) + " 分" : ""));
      if (x.is_group === true) md.push("- **本条目含 " + String(x.group_size ?? 0) + " 个目标**（同一动作批量命中，逐台清单见下方台账）");
      if (x.gained !== "") md.push("- **拿到**：" + oneLine(x.gained, 120));
      if (x.is_group === true) {
        const list = (x.group_targets ?? []).map((g) => "`" + g.target + "`");
        md.push("- **结果**：同一动作在 " + String(x.group_size ?? 0) + " 个目标上均取得同一成果（"
          + (list[0] ?? "") + " … " + (list[list.length - 1] ?? "") + "），逐台回显见下表与证据索引");
      } else if (x.evidence !== "") {
        md.push("- **结果**：" + oneLine(x.evidence, 400));
      }
      if (x.confirm !== null && x.confirm.need !== "") md.push("- **判定标准**：" + oneLine(x.confirm.need, 160));
      md.push("- **前置**：" + (depTxt !== "" ? depTxt : (x.needs_channel === true ? "通道（见 §1.1）" : "无（链路起点）")));
      md.push("");

      /* 复现入口：① HTTP 报文（可直放） ② 命令行 ③ 复现方式说明 */
      md.push("#### 复现", "");
      if (x.repro_kind === "http") {
        const lead = x.repro_http_captured === true && x.replay_http_rebuilt !== true
          ? "**原始报文**（当日真实抓包，整段复制 → Burp Repeater / Yakit「粘贴原始请求」→ 发送）"
          : (x.repro_http_captured === true
            ? "**重建报文**（当日的请求未逐字节留存；这份按当日命令与回显重建，字段已按目标与凭据填好）"
            : "**等价报文**（按当日实际命令重建；未留存原始抓包，字段已按目标与凭据填好）");
        md.push(lead + "：", "");
        block("http", x.replay_http ?? "");
        const firstResp = x.requests[0];
        if (firstResp !== undefined && firstResp.response !== "") {
          const full = firstResp.response;
          md.push("**服务端响应**（" + (firstResp.status === null ? "状态未记录" : "HTTP " + String(firstResp.status)) + "）：", "");
          md.push("```http", full.replace(/\r/g, "").trim().slice(0, 1000)
            + (full.length > 1000 ? "\n…（响应共 " + String(full.length) + " 字符，完整内容见证据库）" : ""), "```", "");
        }
        if (x.requests.length > 1) md.push("> 另有 " + String(x.requests.length - 1) + " 条报文证据，见证据库。", "");
        /* 同一动作的 curl 等价形式也给出：有人习惯直接跑命令，有人习惯 Repeater */
        if (x.replay_cmd !== null && x.replay_cmd.trim() !== "") {
          md.push("**命令行等价形式**（与上面这份报文一致）：", "");
          block("bash", x.replay_cmd);
        }
      }
      if (x.repro_kind === "cli") {
        const lead = (x.replay_cmd_kind === "real" || x.replay_cmd_kind === "linked")
          ? "**命令行**（本条动作当日实际执行的命令，可直接重跑）"
          : (x.replay_cmd_kind === "synthesized" ? "**命令行等价形式**（由上面那份报文推导，地址与方法与报文一致）"
            : "**命令行**（取自当日的攻击步骤）");
        md.push(lead + "：", "");
        block("bash", x.replay_cmd ?? "");
        if (x.repro_nonhttp === true) {
          md.push("> 该动作走的是 SMB / RPC / 数据库 / 文件共享协议，Burp 与 Yakit 无法直接重放；"
            + "按 §1.3 用 proxychains 挂到隧道上执行即可。", "");
        }
      }
      if (x.repro_kind === "method") {
        md.push("**复现方式**：" + (x.confirm !== null && x.confirm.replay !== ""
          ? oneLine(x.confirm.replay, 200)
          : "按该得分点的判定标准，在目标上复现同一动作并留存回显。"), "");
        if (x.steps.length > 0) {
          md.push("> 当日的动作要点见下面「怎么做的」；命令未单独留存，可按该动作在目标上重放。", "");
        }
      }

      /* 证据截图：贴在图里比写十行字有用；kind=card 的必须写明"生成的"，不能冒充现场截图 */
      if (x.shots.length > 0) {
        const shotNote: string[] = [];
        if (x.shot_total > x.shots.length) shotNote.push("该得分点共 " + String(x.shot_total) + " 张，此处取代表 " + String(x.shots.length) + " 张");
        if (x.is_group === true) shotNote.push("本组 " + String(x.group_size ?? 0) + " 个目标");
        md.push("**证据截图**" + (shotNote.length > 0 ? "（" + shotNote.join("；") + "）" : "") + "：", "");
        for (const sh of x.shots) {
          const alt = String(sh.label !== "" ? sh.label : "证据 " + String(sh.id)).replace(/[[\]]/g, "");
          md.push("![" + alt + "](" + ctx.shotRefOf(sh) + ")", "");
          const cap: string[] = [];
          if (sh.label !== "") cap.push(sh.label);
          else if (sh.target !== "") cap.push("`" + sh.target + "`");
          if (sh.kind === "card") cap.push("**由当日记录生成的证据摘录（非现场截图）**");
          if (sh.captured_at !== "") cap.push(String(sh.captured_at).replace("T", " ").slice(0, 16));
          if (sh.source_ref !== "") cap.push("原始文件 `" + oneLine(sh.source_ref, 120) + "`");
          if (sh.note !== "") cap.push(oneLine(sh.note, 160));
          if (cap.length > 0) md.push("> " + cap.join("　·　"), "");
        }
        md.push("");
      } else if (Number(x.shot_total) > 0) {
        /* 本条没分到代表图（同一得分点的图已在前面的条目展示）—— 指明去哪看，别让人以为漏了 */
        md.push("> 本条的证据截图见该得分点的代表图（同一得分点共 " + String(x.shot_total) + " 张，报告每个得分点最多展示 3 张）。", "");
      }

      /* 目标台账（合并条目）：一台一行，含逐台证据 */
      if (x.is_group === true) {
        md.push("**目标台账（" + String(x.group_size ?? 0) + " 台，逐台回显见证据索引）**", "");
        md.push("| # | 目标 | 结果 | 计分 |", "| --- | --- | --- | --- |");
        const brief = (ev: string): string => {
          const m = /（([^）]{1,60})）/.exec(ev);
          if (m !== null && m[1] !== undefined) return oneLine(m[1], 60);
          return oneLine(ev, 80);
        };
        (x.group_targets ?? []).forEach((g, gi) => {
          md.push("| " + String(gi + 1) + " | `" + g.target + "` | " + brief(g.evidence) + " | +" + String(g.points) + " |");
        });
        const extra = summary.serviceCapped.filter((c) => c.code === x.code);
        if (extra.length > 0) {
          md.push("", "> 另有 " + String(extra.length) + " 台取得同等权限但因**单项上限**未计分（留痕）："
            + extra.map((c) => "`" + c.target + "`").join("、") + "，见附录 5.2。", "");
        }
        md.push("");
      }

      /* 怎么做的：动作步骤（含真实命令与回显） */
      const evFiles = Array.from(new Set(x.steps.map((s) => s.evidence_ref.trim()).filter((v) => v !== "")));
      if (x.steps.length > 0 || x.how !== "" || x.vuln !== null || evFiles.length > 0) {
        md.push("#### 动作记录", "");
        if (x.how !== "") md.push("> " + oneLine(x.how, 240), "");
        x.steps.forEach((s, si) => {
          md.push("**" + String(si + 1) + ". " + oneLine(s.title !== "" ? s.title : "（未命名动作）", 80) + "**"
            + (s.agent !== "" ? "　—　" + AGENT_LABEL(s.agent) : "")
            + (s.inferred ? "　·　（按同资产推断）" : ""));
          if (s.detail !== "") md.push("- " + oneLine(s.detail, 400));
          if (s.result !== "") md.push("- 回显：" + oneLine(s.result, 300));
          if (s.tool !== "" && s.tool.trim() !== String(x.replay_cmd ?? "").trim()) {
            md.push("- 命令：");
            md.push("  ```bash", "  " + s.tool.replace(/\r/g, "").trim().slice(0, 1500), "  ```");
          }
          if (s.evidence_ref !== "") md.push("- 证据：`" + oneLine(s.evidence_ref, 200) + "`");
        });
        md.push("");
      }
      /* 逐条的凭据只留"本条真的用到的那几条"：trace 会把同资产的凭据一并挂上来，
         那是给界面看的宽松视图；报告里挂一串无关的接口 token 只会让人怀疑真实性。 */
      const itemCreds = credsAll.filter((c) => ctx.ownsCred(x, c)
        || (ctx.ipOfTarget(c.host) !== null && ctx.ipOfTarget(c.host) === ctx.ipOfTarget(x.target)));
      if (itemCreds.length > 0) {
        md.push("**凭据**：" + itemCreds.map((c) => "`" + (c.host ?? "") + "` " + (c.username ?? "—")
          + ((c.privilege ?? "") !== "" ? "（" + String(c.privilege) + "）" : "") + "　来源：" + (c.source ?? "未标注")).join("<br>"), "");
      }
      if (x.webshells.length > 0) {
        md.push("**WebShell**：" + x.webshells.map((w) => "`" + (w.url ?? "") + "`　" + (w.shell_type ?? "")
          + ((w.pass_key ?? "") !== "" ? "　密钥 `" + String(w.pass_key) + "`" : "")).join("<br>"), "");
      }
      if (x.tunnels.length > 0) {
        md.push("**通道**：" + x.tunnels.map((t) => "`" + (t.kind ?? "") + "` 监听 `" + (t.listen ?? "") + "`").join("<br>"), "");
      }
      const meta2: string[] = [];
      if (x.vuln !== null) meta2.push("漏洞 " + ((x.vuln.cve ?? "") !== "" ? x.vuln.cve + " " : "") + oneLine(x.vuln.title, 80));
      if (x.recorded_at !== "") {
        meta2.push("取得 " + String(x.recorded_at).replace("T", " ").slice(0, 16)
          + (x.recorded_by !== "" ? "（" + AGENT_LABEL(x.recorded_by) + "）" : ""));
      }
      if (Number(x.point_cap) > 0) {
        const used = byPoint.get(x.code)?.points ?? x.points;
        meta2.push("该得分点已用 " + String(used) + "/" + String(x.point_cap) + " 分");
      }
      if (meta2.length > 0) md.push("> " + meta2.join("　·　"), "");
      md.push("");
    }

    /* ── ④ 得分点说明（判定标准与材料要求只讲一次）──────────────────────── */
    md.push("---", "");
    md.push("## 4. 得分点说明", "");
    md.push("> 正文不再逐条重复这些口径。通用规则：权限取高只计一次（G1）、数据成果另行计分（G2）、"
      + "上限针对单个防守单位（G3）、终端与设备按台计分（G4）、证明材料按 G7。", "");
    md.push("| 得分点 | 规则 / 档位 | 判定标准 | 要附的材料 | 标准复现动作 |", "| --- | --- | --- | --- | --- |");
    for (const rec of Array.from(byPoint.values()).sort((a, b) => b.points - a.points)) {
      const c = scoreConfirmOf(rec.code);
      const sample = ordered.find((x) => x.code === rec.code);
      md.push("| " + rec.name + "（`" + rec.code + "`） | "
        + (sample !== undefined && sample.point_rule !== null ? "规则 " + String(sample.point_rule) + "　" : "")
        + oneLine(sample?.point_tier !== undefined && sample.point_tier !== "" ? sample.point_tier : "—", 50) + " | "
        + oneLine(c?.need ?? "—", 160) + " | " + oneLine(c?.proof ?? "—", 160) + " | "
        + "`" + oneLine(c?.replay ?? "—", 140) + "` |");
    }
    md.push("");

    /* ── ⑤ 附录 ────────────────────────────────────────────────────────── */
    /* 对账用的资产清单：命中/步骤显式挂的资产 ∪ **得分目标 IP 对应的资产**。
       后者不能少 —— 多数命中记的是"目标地址"而没挂 asset_id，
       只按 asset_id 收集会让附录里只剩零星几台，验收时对不上账。 */
    const assetsTouched = new Set<number>();
    for (const x of ordered) {
      if (x.asset_id !== null) assetsTouched.add(x.asset_id);
      for (const s of x.steps) if (s.asset_id !== null) assetsTouched.add(s.asset_id);
    }
    const targetIps = Array.from(new Set(ordered.map((x) => ctx.ipOfTarget(x.target)).filter((v): v is string => v !== null)));
    if (targetIps.length > 0) {
      const phIp = placeholders(targetIps.length);
      for (const a of this.db(id).prepare<{ id: number }>(`SELECT id FROM asset WHERE ip IN (${phIp})`).all(...targetIps)) {
        assetsTouched.add(a.id);
      }
    }
    const assetsTouchedList = Array.from(assetsTouched);
    if (assetsTouchedList.length > 0) {
      const ph = placeholders(assetsTouchedList.length);
      const rowsA = this.db(id).prepare<{
        id: number; ip: string; primary_name: string | null; discovered_at: string | null;
        first_seen: string | null; last_seen: string | null; test_status: string | null;
        priority: string | null; scope: string | null;
      }>(
        `SELECT a.id, a.ip, a.primary_name, a.discovered_at, a.first_seen, a.last_seen,
          a.test_status, a.priority, COALESCE(a.scope, (${SCOPE_SQL})) AS scope
        FROM asset a WHERE a.id IN (${ph}) ORDER BY a.discovered_at, a.id`,
      ).all(...assetsTouchedList);
      md.push("---", "");
      md.push("## 5. 附录", "");
      md.push("### 5.1 本报告涉及的资产（含发现时间）", "");
      md.push("| 资产 | 名称 | 内/外网 | 发现时间 | 最近采集 |");
      md.push("| --- | --- | --- | --- | --- |");
      for (const a of rowsA) {
        md.push("| `" + a.ip + "` | " + (a.primary_name ?? "—")
          + " | " + (a.scope === "internal" ? "内网" : "外网")
          + " | " + (a.discovered_at !== null ? String(a.discovered_at).replace("T", " ").slice(0, 19) : "—")
          + " | " + (a.last_seen !== null ? String(a.last_seen).replace("T", " ").slice(0, 19) : "—") + " |");
      }
      md.push("");
    }
    if (summary.serviceCapped.length > 0) {
      md.push("### 5.2 未计分的重复记录（同服务已计满）", "");
      md.push("| 目标 | 得分点 | 记录分值 | 记录时间 |", "| --- | --- | --- | --- |");
      for (const c of summary.serviceCapped) {
        md.push("| `" + (c.target !== "" ? c.target : c.service) + "` | " + c.point_name + " | "
          + String(c.points) + " | " + String(c.recorded_at).replace("T", " ").slice(0, 16) + " |");
      }
      md.push("");
    }
    return md.join("\n");
  }

}

/**
 * 提示词内容指纹（sha1 前 12 位）：用来判断"靶标里存的是不是某一版内置默认"。
 *
 * 语义：**是默认就跟着新版走，用户自己改过的永不覆盖**。
 */
export function promptHash(text: unknown): string {
  return createHash("sha1").update(String(text ?? "").trim()).digest("hex").slice(0, 12);
}

/** 角色标题表（面板/工具/提示词刷新脚本共用）。 */
export { ROLE_TITLES, ROLE_ORDER, PLANNER_ROLE };
