/**
 * 事实库 schema 与增量迁移。
 *
 * 迁移自 dsh-qilin `lib/redteam/schema.js`。**DDL 与迁移是"数据形状"的唯一定义处**，
 * 与"怎么用这些数据"（Store 的方法）分开之后，看 schema 不用翻过 500 行计分逻辑。
 *
 * ## 两处迁移遵循同一条纪律
 *
 * **先查 PRAGMA 再 ADD COLUMN**，可重复执行、老库不用重建。
 * 读不到表结构一律按"没有这一列"处理（返回 false），交给 ensure 去尝试 ALTER；
 * **反过来当成"列已存在"会让迁移被静默跳过**，故障点从"迁移失败"漂到远端 SQL 执行处
 * （表现是某条查询报 `no such column`，而调用点通常有 `catch {}`，于是面板某块永远空白）。
 *
 * ## FTS5 是编译期可选，必须检测
 *
 * 不同 Node 构建并不一致 —— Node 22.14 的 `node:sqlite` **没有**（`no such module: fts5`），
 * 22.23 有。不能假定它存在：CI 与本地 Node 版本不一致时，一句 `USING fts5` 抛错
 * 会把**整份 DDL** 一起带崩，连普通表都建不出来。
 * 语义：只有 FTS5 缺席时才降级成 LIKE 检索 —— 装了 FTS5 的机器行为完全不变。
 *
 * `REDTEAM_NO_FTS5=1` 可强制走降级路径：CI 的 Node 一旦换了带 FTS5 的版本，
 * 降级分支就再没人执行了，得留一个能主动触发它的开关。
 */
import { DatabaseSync } from "node:sqlite";
import type { TypedDb } from "./sqlite.js";
import { parseTargetPort } from "./score.js";
import { DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL } from "./data/ddl.js";
import type { PocCategory } from "./types.js";

export { DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL };

/* ══════════════════════════════════════════════════════════════ FTS5 能力检测 */

/**
 * 本机 `node:sqlite` 是否带 FTS5。
 *
 * 检测方式是在内存库里真建一张 fts5 表 —— 只有这一种判据可靠：
 * 查 `sqlite_compileoptions` 之类的旁路在不同构建上不可用。
 */
export const HAS_FTS5: boolean = ((): boolean => {
  if (process.env["REDTEAM_NO_FTS5"] === "1") return false;
  try {
    const probe = new DatabaseSync(":memory:");
    try {
      probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
      return true;
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
})();

/* ══════════════════════════════════════════════════════════════ 知识库归类 */

/**
 * 知识库归类（与得分点/攻击面口径对齐）：智能体回填时必须选一个，
 * 面板按它分组，用户才能"一类一类看"而不是几百条平铺。
 */
export const POC_CATEGORIES: readonly PocCategory[] = [
  { code: "rce", name: "远程命令执行", hint: "框架/中间件/组件 RCE、表达式注入、模板注入" },
  { code: "deserialization", name: "反序列化", hint: "Java/PHP/.NET 反序列化链、fastjson/jackson 等" },
  { code: "file-upload", name: "文件上传 getshell", hint: "上传绕过、解析漏洞、二次渲染、竞争" },
  { code: "sqli", name: "SQL 注入", hint: "注入点验证、拖库、写文件、提权" },
  { code: "unauthorized", name: "未授权访问", hint: "未鉴权接口/服务（Redis、Docker、Actuator、Swagger 调用）" },
  { code: "auth-bypass", name: "认证绕过 / 越权", hint: "登录绕过、JWT 缺陷、越权读写、逻辑缺陷" },
  { code: "weak-password", name: "弱口令 / 口令爆破", hint: "管理端弱口令、数据库弱口令、默认口令" },
  { code: "ssrf", name: "SSRF", hint: "服务端请求伪造、云元数据、内网探测跳板" },
  { code: "xxe", name: "XXE", hint: "XML 外部实体读取与 SSRF" },
  { code: "path-traversal", name: "目录穿越 / 任意文件读取", hint: "路径穿越、任意文件读、源码/配置读取" },
  { code: "info-leak", name: "信息泄露", hint: "配置/凭据/源码/备份泄露（能升级为得分的那些）" },
  { code: "privesc", name: "提权 / 横向", hint: "本地提权、凭据复用、Pass-the-Hash、横向工具" },
  { code: "tunnel", name: "隧道 / 代理", hint: "suo5、frp、chisel、Neo-ReGeorg、内网代理" },
  { code: "other", name: "其它", hint: "不属于上面任何一类（写清用途）" },
];

/** 归类 code → 中文名（未知值原样返回，允许用户自定义）。 */
export function pocCategoryName(code: unknown): string {
  const key = String(code ?? "");
  const hit = POC_CATEGORIES.find((c) => c.code === key);
  if (hit !== undefined) return hit.name;
  return key !== "" ? key : "未归类";
}

/**
 * 老条目的归类推测（迁移时给 category 为空的条目打标）。
 * 依据是 code/title/component 里的关键词 —— 命中就归那一类，都不中才落 `other`。
 * **顺序即优先级**：越具体的越靠前（例如"任意文件上传"要压过泛化的"上传"）。
 */
export function guessPocCategory(text: unknown): string {
  const t = String(text ?? "").toLowerCase();
  const has = (...words: readonly string[]): boolean => words.some((w) => t.includes(w));
  if (has("反序列化", "deserial", "shiro", "fastjson", "weblogic", "log4j", "jackson")) return "deserialization";
  if (has("文件上传", "file-upload", "fileupload", "upload", "getshell", "webshell", "写马")) return "file-upload";
  if (has("sql 注入", "sqli", "sql注入", "注入拖库", "union select")) return "sqli";
  if (has("弱口令", "爆破", "brute", "默认口令", "默认凭据", "hydra")) return "weak-password";
  if (has("隧道", "socks", "suo5", "frp", "chisel", "regeorg", "代理")) return "tunnel";
  if (has("未授权", "unauth", "免认证", "免鉴权", "未鉴权", "无鉴权")) return "unauthorized";
  if (has("越权", "认证绕过", "鉴权绕过", "jwt", "逻辑漏洞", "验证码绕过", "auth-bypass")) return "auth-bypass";
  if (has("rce", "命令执行", "代码执行", "表达式注入", "模板注入", "ssti", "命令注入", "远程执行")) return "rce";
  if (has("ssrf", "服务端请求伪造")) return "ssrf";
  if (has("xxe", "外部实体")) return "xxe";
  if (has("任意文件读", "文件读取", "目录穿越", "路径穿越", "path traversal", "lfi", "任意文件下载")) return "path-traversal";
  if (has("提权", "横向", "pass-the-hash", "mimikatz", "impacket", "凭据复用")) return "privesc";
  if (has("信息泄露", "配置泄露", "敏感信息", "源码泄露", "泄露", "leak")) return "info-leak";
  return "other";
}

/* ══════════════════════════════════════════════════════════════ 迁移辅助 */

/** 迁移结果：补了哪些列、清了哪些旧行。测试用它断言"可重复执行"。 */
export interface MigrationOutcome {
  /** 本次真正 ALTER 出来的列，形如 `vuln.target`。 */
  readonly addedColumns: readonly string[];
  /** 本次删掉的旧得分点/命中数（`migrate` 自己不删，恒 0，保留字段供调用方汇总）。 */
  readonly stripped: number;
}

/**
 * 判断"表里有没有这一列"。
 *
 * 读不到表结构**必须返回 false**（= 没有这一列），让 ensure 去尝试 ALTER。
 * 返回 true 会让迁移被静默跳过，代码随后按新列写 SQL，
 * 故障表现为远端 SQL 报错而不是迁移失败。
 */
function hasColumn(db: TypedDb, table: string, column: string): boolean {
  try {
    const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => row.name === column);
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════ 靶标库迁移 */

/**
 * 轻量迁移：给既有库补列。先查 PRAGMA 再 ADD COLUMN，重复执行安全。
 * 只在新增列时执行，因此老靶标库不需要重建。
 */
export function migrate(db: TypedDb): MigrationOutcome {
  const added: string[] = [];
  const ensure = (table: string, column: string, ddl: string): boolean => {
    if (hasColumn(db, table, column)) return false;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      added.push(`${table}.${column}`);
    } catch {
      /* 并发迁移时忽略（另一个连接刚补上同一列） */
    }
    return true;
  };

  ensure("vuln", "target", "TEXT");
  ensure("vuln", "found_by_agent", "TEXT");
  ensure("vuln", "found_at", "TEXT");
  ensure("port", "url", "TEXT");
  ensure("port", "title", "TEXT");
  ensure("asset", "test_status", "TEXT DEFAULT 'untested'");
  ensure("asset", "test_notes", "TEXT");
  ensure("asset", "test_surface", "TEXT");
  ensure("asset", "test_updated_at", "TEXT");
  ensure("asset", "test_updated_by", "TEXT");
  ensure("asset", "blocked_count", "INTEGER DEFAULT 0");
  ensure("asset", "priority", "TEXT");
  ensure("asset", "potential", "TEXT");
  ensure("asset", "assess_reason", "TEXT");
  ensure("asset", "assessed_at", "TEXT");
  ensure("asset", "assessed_by", "TEXT");
  /* 发现时间：本条资产**第一次进入本库**的时刻（不随重复采集刷新）。
     与 first_seen（数据源给出的首次出现时间）不是一回事，两个都留。 */
  ensure("asset", "discovered_at", "TEXT");
  /* 产出这条记录的智能体角色（recon/assess/vuln-scan/exploit/internal） */
  ensure("vuln", "agent", "TEXT");
  ensure("credential", "agent", "TEXT");
  ensure("webshell", "agent", "TEXT");
  ensure("tunnel", "agent", "TEXT");
  /* 攻击步骤：用了什么工具/命令、由谁记录 */
  ensure("attack_step", "tool", "TEXT");
  ensure("attack_step", "agent", "TEXT");
  ensure("attack_step", "result", "TEXT");
  /* 内外网维度：internal（内网/私网地址）| external（互联网可达） */
  ensure("asset", "scope", "TEXT");
  /* 通过这个漏洞拿到了什么 */
  ensure("vuln", "gained", "TEXT");
  /* 凭据明文（面板要直接显示口令，不再只存引用） */
  ensure("credential", "secret_value", "TEXT");
  /* 得分点按《突破入侵类得分规则》重构（v0.11.0） */
  ensure("score_point", "rule", "INTEGER");
  ensure("score_point", "tier", "TEXT");
  ensure("score_point", "cap", "INTEGER DEFAULT 0");
  ensure("score_point", "dedup_scope", "TEXT DEFAULT 'service'");
  ensure("score_point", "legacy", "INTEGER DEFAULT 0");
  /* builtin：区分内置点与用户自建点。老库先按 0 建列，再由播种回填。 */
  ensure("score_point", "builtin", "INTEGER DEFAULT 0");
  ensure("score_point", "src", "INTEGER");
  /* G5 / G6 倍率（老库补列，默认 1 = 不放大） */
  ensure("score_hit", "multiplier", "REAL DEFAULT 1");
  /* 每条命中自带分值（合并版把档位并进一条后必需） */
  ensure("score_hit", "points", "INTEGER");
  /* 得分 ↔ 漏洞/步骤 关联：报告取原始请求、流程图连线用 */
  ensure("score_hit", "vuln_id", "INTEGER");
  ensure("score_hit", "step_id", "INTEGER");
  ensure("attack_step", "point_id", "INTEGER");

  /* 攻击链已推倒重来：老的五阶段行整体作废。 */
  try {
    /* 注意：'target' 在新老两版里同名，**必须按名称区分**，
       否则第二次打开会把新版阶段删掉。 */
    db.prepare("DELETE FROM stage WHERE code IN ('external','foothold','tunnel','privilege')").run();
    db.prepare("DELETE FROM stage WHERE code = 'target' AND name = '靶标系统权限'").run();
    db.prepare("DELETE FROM stage WHERE code NOT IN ('recon','internet','boundary','internal','target')").run();
  } catch {
    /* 表还不存在，忽略 */
  }
  if (hasColumn(db, "stage", "attck")) {
    try {
      db.exec("ALTER TABLE stage DROP COLUMN attck");
    } catch {
      /* 老 SQLite 不支持 DROP COLUMN 则保留 */
    }
  }
  /* 攻击步骤上的阶段：老值是上一版的阶段 code，清掉以便按 legacy stage 重新映射。
     注意：'target' 在新版里仍是合法阶段（⑤ 靶标权限），**不能一起清** ——
     否则每次打开靶标都会把「显式指定 ⑤」的步骤与得分打回自动推导。 */
  try {
    db.prepare("UPDATE attack_step SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run();
    db.prepare("UPDATE score_hit SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run();
  } catch {
    /* 忽略 */
  }
  /* 阶段归属改为按每条得分自动推导，得分点上的 stage_code 已废弃 */
  if (hasColumn(db, "score_point", "stage_code")) {
    try {
      db.exec("ALTER TABLE score_point DROP COLUMN stage_code");
    } catch {
      /* 忽略 */
    }
  }
  /* 蓝队视角已从作战阶段中移除 */
  if (hasColumn(db, "stage", "blue_team")) {
    try {
      db.exec("ALTER TABLE stage DROP COLUMN blue_team");
    } catch {
      /* 老 SQLite 不支持则保留 */
    }
  }
  /* 阶段归属：得分命中可显式覆盖（默认自动推导）；攻击步骤记录所属阶段 */
  ensure("score_hit", "stage_code", "TEXT");
  /* 自建账号标记：自己注册/自己创建的账号不算得分权限 */
  ensure("score_hit", "self_created", "INTEGER DEFAULT 0");
  /* 得分落在哪个「服务」上：账号类得分按 (资产, 端口) 封顶。
     端口在写入时解析；老数据打开靶标时按 target 回填一次。 */
  ensure("score_hit", "port", "INTEGER");
  try {
    const pending = db
      .prepare<{ id: number; target: string }>(
        "SELECT id, target FROM score_hit WHERE port IS NULL AND target IS NOT NULL AND target <> ''",
      )
      .all();
    if (pending.length > 0) {
      const upd = db.prepare("UPDATE score_hit SET port = ? WHERE id = ?");
      for (const row of pending) {
        const port = parseTargetPort(row.target);
        if (port !== null) upd.run(port, row.id);
      }
    }
  } catch {
    /* 表还不存在，忽略 */
  }
  /* 隧道入口归属：判断这条通道有没有真的跨越靶标边界（self-only 不算突破） */
  ensure("tunnel", "entry_kind", "TEXT");
  if (ensure("attack_step", "stage_code", "TEXT")) {
    try {
      const stmt = db.prepare("UPDATE attack_step SET stage_code = ? WHERE stage = ?");
      for (const [legacy, code] of Object.entries(LEGACY_STAGE_MAP)) stmt.run(code, legacy);
    } catch {
      /* 忽略 */
    }
  }
  /* 老库回填：按 IP 归属自动区分内外网 */
  try {
    db.exec(`UPDATE asset SET scope = (${SCOPE_SQL}) WHERE scope IS NULL OR scope = ''`);
  } catch {
    /* 首次建库时表为空，忽略 */
  }
  /* 老库回填发现时间：没有 discovered_at 的用 first_seen 顶上 */
  try {
    db.exec("UPDATE asset SET discovered_at = COALESCE(first_seen, last_seen) WHERE discovered_at IS NULL OR discovered_at = ''");
  } catch {
    /* 忽略 */
  }
  return { addedColumns: added, stripped: 0 };
}

/** 旧攻击链 stage → 新阶段 code 的兜底映射（`migrate` 与 `addChainStep` 共用）。 */
export const LEGACY_STAGE_MAP: Readonly<Record<string, string>> = {
  recon: "recon", vuln: "internet", exploit: "internet",
  access: "internal", pivot: "boundary", data: "internal", other: "recon",
};

/**
 * 内外网判定（SQL 片段，作用于 asset.ip）：
 * RFC1918 私网 + 回环 + 链路本地 + CGNAT 视为内网，其余为外网。
 *
 * **必须与 `scopeOfIp()` 同口径**：一处按 SQL 判、一处按 JS 判，两边漂移会让
 * 面板分组与报告附录的"内/外网"对不上。
 */
export const SCOPE_SQL = `CASE
  WHEN ip LIKE '10.%' OR ip LIKE '192.168.%' OR ip LIKE '127.%' OR ip LIKE '169.254.%'
    OR (ip LIKE '172.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 16 AND 31)
    OR (ip LIKE '100.%' AND CAST(substr(ip, 5, instr(substr(ip, 5), '.') - 1) AS INTEGER) BETWEEN 64 AND 127)
  THEN 'internal' ELSE 'external' END`;

/* ══════════════════════════════════════════════════════════════ 知识库迁移 */

/**
 * 知识库轻量迁移：给既有 knowledge.db 补列（归类 / 来源溯源）。
 * 与靶标库迁移同样先查 PRAGMA 再 ADD COLUMN，重复执行安全、老库不用重建。
 *
 * 注意 `poc` 表的 `category` / `engagement_*` 索引**不能写进 KNOWLEDGE_DDL** ——
 * 老 knowledge.db 的 poc 表还没有这两列，CREATE INDEX 会在 exec(DDL) 阶段直接抛
 * `no such column: category`，连补列的迁移都跑不到。所以它们在补完列之后才建。
 */
export function migrateKnowledge(db: TypedDb): MigrationOutcome {
  const added: string[] = [];
  const ensure = (column: string, ddl: string): void => {
    if (hasColumn(db, "poc", column)) return;
    try {
      db.exec(`ALTER TABLE poc ADD COLUMN ${column} ${ddl}`);
      added.push(`poc.${column}`);
    } catch {
      /* 并发迁移时忽略 */
    }
  };
  ensure("category", "TEXT");
  ensure("engagement_id", "TEXT");
  ensure("engagement_name", "TEXT");
  ensure("asset_target", "TEXT");
  ensure("found_by_agent", "TEXT");
  try {
    db.exec("CREATE INDEX IF NOT EXISTS ix_poc_category ON poc(category)");
  } catch {
    /* 忽略 */
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS ix_poc_engagement ON poc(engagement_id)");
  } catch {
    /* 忽略 */
  }
  /* 老条目没有归类：按 code/标题/组件的关键词推一个（推测逻辑只有一份，见 guessPocCategory） */
  try {
    const rows = db
      .prepare<{ id: number; code: string | null; title: string | null; component: string | null }>(
        "SELECT id, code, title, component FROM poc WHERE COALESCE(category, '') = ''",
      )
      .all();
    const upd = db.prepare("UPDATE poc SET category = ? WHERE id = ?");
    for (const row of rows) {
      upd.run(guessPocCategory([row.code, row.title, row.component].filter(Boolean).join(" ")), row.id);
    }
  } catch {
    /* 忽略 */
  }
  return { addedColumns: added, stripped: 0 };
}
