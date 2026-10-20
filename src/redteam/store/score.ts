/**
 * 计分引擎：判定口径 + 封顶 + 倍率（面板 / 报告 / 攻击链的**唯一**实现）。
 *
 * 迁移自 dsh-qilin `lib/redteam/score-rules.js`（936 行）的判定部分。
 * 原注释把"为什么必须只有一份"讲透了，这里保留：
 * 面板 / 报告 / 攻击链三处总分必须一致，靠的就是 `applyScoreCaps` 与
 * `evaluateScoreBoard` 是唯一实现 —— 三处各写一遍必然漂移成不同口径
 * （实测出现过"面板 6340 分、报告 7930 分"这种自相矛盾的交付物）。
 *
 * ## 计分口径（数据驱动，不靠代码里的名单）
 *
 *   · `dedup_scope = service` —— 同一（资产, 端口）只算分值最高的一条；
 *   · `dedup_scope = system`  —— 同一（资产, 端口, 系统名）只算最高权限一条；
 *   · `dedup_scope = target`  —— 整个目标只算一次（突破网络边界）；
 *   · `dedup_scope = none`    —— 不去重，按台/卡/节点数累加。
 * 之后按 `rule` 分组累计，超过该规则 `cap` 的部分标 `capped`（cap = 0 不设上限）。
 *
 * ## 三条"宁可少封顶也不能错封"的纪律（都是线上 bug 换来的）
 *
 * 1. **拿不到服务键就不参与去重**。退回"每条自成一键"会让 `svc:#hit7` 这种键
 *    把同一口径的命中互相顶掉：实测 62 条无 target 的 terminal-access 命中里
 *    61 条被判不计分、只留 1 条。
 * 2. **`system_key` 必须能被服务键校验**。调用方预造的 `资产名|端口` 键在资产
 *    还没有名字时会退化成 `"|8080"`；直接采信会把 10.7.7.7:8080 与 10.7.7.8:8080
 *    并成"同一个系统"，白白封顶另一台主机的成果。
 * 3. **兜底键不能用 `Math.random()`**。同一个 hit 在两次调用（面板/报告/攻击链）
 *    里会拿到不同的键，计分口径就不稳定了 —— 用 `#hit<id>`（互不相同）。
 */
import type { DedupScope } from "./types.js";
import { isIpv6, scopeOfIp } from "../../platform/ip-utils.js";

/* ══════════════════════════════════════════════════════════════ 判定规则常量 */

/** 什么算"真隧道"（边界突破的凭证）：必须跨越靶标边界，即通道一端在目标侧。 */
export const TUNNEL_ENTRY_KINDS: Readonly<Record<string, string>> = {
  "target-outbound": "目标主动连出（反弹 shell / 目标上跑 frp 客户端）",
  "target-http": "经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）",
  "target-agent": "经目标已控进程/会话转发（SSH -R 等）",
  "self-only": "只在自己 VPS/自建服务器上（不算突破）",
};

/**
 * 这条隧道算不算"跨越了靶标边界"。
 * 未声明（老数据/没填）返回 null —— 界面按"待确认"显示，**不能当成 false**，
 * 否则"没填"与"填了 self-only"就分不开了。
 */
export function tunnelIsLegit(entryKind: unknown): boolean | null {
  const k = String(entryKind ?? "").trim();
  if (k === "") return null;
  return k !== "self-only";
}

/** 账号/权限类得分点：自己注册/自建的账号不算拿到权限（演练得分针对"拿到别人已有的"）。 */
export const ACCOUNT_POINT_CODES: readonly string[] = [
  "web-account-user", "web-account-admin", "server-shell", "db-access", "internal-pivot", "core-system",
];

/** 按「服务」封顶的得分点：同一资产的同一端口只算一次分。 */
export const SERVICE_CAPPED_POINT_CODES: readonly string[] = [
  "web-account-user", "web-account-admin", "db-access",
];

/**
 * 从 target 里解析端口：`http://h:8080/x`、`10.0.0.5:6379`、`10.0.0.5:22`。
 * 没有端口或解析不出返回 null（**不要编造 80/443**，否则会把不同服务并成一个）。
 */
export function parseTargetPort(target: unknown): number | null {
  const t = String(target ?? "").trim();
  if (t === "") return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t);
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) ?? [])[1];
  if (authority === undefined || authority === "") return null;
  const m = /:(\d{1,5})$/.exec(authority);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** 库列的 port 值（老库可能是 null/0/空串）。 */
export function normalizePort(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/**
 * 从 target 里取「服务标识」：`host[:port]`。
 *   · 端口取显式写的那个；没写就按协议推默认端口（http→80、https→443、其它→不推断），
 *     这样 `http://h/x` 与 `http://h:80/y` 会归到同一个服务；
 *   · 路径/参数/查询串一律丢掉（`http://h:8080/a/b?c=1` → `h:8080`）。
 * 解析不出 host 时返回 null。
 */
export function targetAuthority(target: unknown): string | null {
  const t = String(target ?? "").trim();
  if (t === "") return null;
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t);
  const scheme = url !== null && url[1] !== undefined ? url[1].toLowerCase() : null;
  const authority = url !== null && url[2] !== undefined ? url[2] : (/^([^\s/?#]+)/.exec(t) ?? [])[1];
  if (authority === undefined || authority === "") return null;
  const host = authority.replace(/:\d{1,5}$/, "").toLowerCase();
  if (host === "") return null;
  let port = parseTargetPort(t);
  /* 没写端口时按协议补默认端口：避免同一个服务的两种写法被算成两个服务而重复计分 */
  if (port === null) {
    if (scheme === "http") port = 80;
    else if (scheme === "https") port = 443;
  }
  return port === null ? host : host + ":" + port;
}

/** 参与计分的一行（命中行的最小信息）。 */
export interface ScoreHitLike {
  readonly id: number;
  readonly code?: string | null;
  readonly points?: number | string | null;
  readonly multiplier?: number | string | null;
  readonly asset_id?: number | string | null;
  readonly port?: number | string | null;
  readonly target?: string | null;
  readonly recorded_at?: string | null;
  /** 显式指定的系统键（调用方预造）；只有能被服务键校验时才采信。 */
  readonly system_key?: string | null;
  readonly self_created?: number | string | boolean | null;
  readonly evidence?: string | null;
}

/**
 * 「服务」键：得分封顶的粒度 = 同一个资产的同一个端口。
 *   · target 能解析出 host[:port] → 就用它（`t10.20.30.40:3306`）——
 *     同一个服务可能由不同的人记分，有的带 asset_id、有的只写 target，
 *     以目标为准才能把它们归到一起；
 *   · target 解析不出 → 退到资产：有端口用 `a<id>:<port>`，没端口记 `a<id>:0`；
 *   · 两样都没有 → null（拿不到服务信息，这条**不参与封顶**）。
 */
export function scoreServiceKey(hit: ScoreHitLike): string | null {
  const authority = targetAuthority(hit.target);
  if (authority !== null) return "t" + authority;
  const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === ""
    ? null
    : Number(hit.asset_id);
  if (assetId === null || !Number.isFinite(assetId)) return null;
  const port = normalizePort(hit.port);
  return "a" + assetId + ":" + (port === null ? 0 : port);
}

/** 「服务」的可读标签，给告警/报告用（如 `10.1.2.3:8080`）。 */
export function serviceLabel(hit: ScoreHitLike, assetIp?: string | null): string {
  const ip = assetIp !== undefined && assetIp !== null && assetIp !== "" ? assetIp : "";
  const port = normalizePort(hit.port) ?? parseTargetPort(hit.target);
  if (ip !== "") return port === null ? ip : ip + ":" + port;
  const authority = targetAuthority(hit.target);
  if (authority === null) return hit.target !== undefined && hit.target !== null && hit.target !== "" ? String(hit.target) : "(未标注服务)";
  if (port !== null && !/:\d{1,5}$/.test(authority)) return authority + ":" + port;
  return authority;
}

/**
 * 目标归并：同一条漏洞的 target 可能带路径/参数（`http://h:8080/a/b`、`10.0.0.5:6379`），
 * 聚合视图要按「站点/服务」而不是按完整 URL 分组，否则 300 条漏洞会聚成 300 组。
 */
export function targetKey(target: unknown, fallbackIp?: string | null): string {
  const t = String(target ?? "").trim();
  if (t !== "") {
    const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(t);
    if (url !== null && url[1] !== undefined) return url[1];
    const head = /^([^\s/?#]+)/.exec(t);
    if (head !== null && head[1] !== undefined) return head[1];
    return t;
  }
  return fallbackIp !== undefined && fallbackIp !== null && fallbackIp !== "" ? fallbackIp : "(未指定目标)";
}

/* ══════════════════════════════════════════════════════════════ 封顶 */

/** 得分点元数据（`score_point` 的判定字段）。 */
export interface ScoreMeta {
  readonly rule: number | null;
  readonly cap: number;
  readonly dedup_scope: DedupScope;
  readonly points: number;
  readonly enabled: number;
  readonly builtin: boolean;
  readonly src: number | null;
}

/** 打分后的行：原字段 + 计分标记。 */
export interface ScoredHit<T> {
  readonly row: T;
  readonly id: number;
  readonly code: string | null;
  readonly points: number;
  readonly capped: boolean;
  readonly capped_by_id: number | null;
  readonly capped_by_points: number | null;
  readonly capped_by_evidence: string | null;
  readonly capped_reason_kind: "dedup" | "cap" | null;
  readonly rule: number | null;
  readonly rule_cap: number;
  readonly cap_group: string;
  readonly dedup_scope: DedupScope;
  readonly service_key: string | null;
}

/** 某条规则的用量。 */
export interface RuleCapUsage {
  readonly rule: number | null;
  readonly cap: number;
  readonly used: number;
  readonly capped: number;
}

/** `applyScoreCaps` 的结果。 */
export interface ScoreCapsResult<T> {
  readonly capped: number;
  readonly items: readonly ScoredHit<T>[];
  readonly caps: ReadonlyMap<string, RuleCapUsage>;
}

/** 旧口径分组（兼容 v0.10 及以前：账号类与数据库类按"同资产同端口"封顶）。 */
function legacyCapGroup(code: unknown): DedupScope | null {
  const c = String(code ?? "").trim();
  if (c === "web-account-user" || c === "web-account-admin") return "service";
  return SERVICE_CAPPED_POINT_CODES.includes(c) ? "service" : null;
}

/** 从一组同口径命中里挑"计分的那一条"：分值最高，同分取更早记的（id 小的）。 */
function pickBestHit<T extends ScoredHit<unknown>>(list: readonly T[]): T | undefined {
  return list.reduce<T | undefined>((a, b) => {
    if (a === undefined) return b;
    const pa = a.points;
    const pb = b.points;
    if (pb !== pa) return pb > pa ? b : a;
    return b.id < a.id ? b : a;
  }, undefined);
}

/**
 * 参与 `system` 口径去重的"系统键"。
 *
 * 规则原文是"同一个系统只计算一次最高权限分"。判定顺序：
 *   ① 命中自带的 `system_key`（**只有能被服务键校验时才采信**）；
 *   ② 资产的 `primary_name` + 服务键（system 口径的主力路径）；
 *   ③ 退到服务键；
 *   ④ 都没有 → `#hit<id>`（互不相同；**不能**用随机数，见文件头）。
 */
export function systemKeyOf(hit: ScoreHitLike, nameByAsset?: ReadonlyMap<number, string> | null): string {
  const svc = scoreServiceKey(hit);
  const svcText = svc === null ? "" : svc;

  const explicit = String(hit.system_key ?? "").trim();
  if (explicit !== "" && (svcText === "" || explicit.includes(svcText))) {
    const head = explicit.split("|")[0] ?? "";
    if (svcText !== "" || head.trim() !== "") return explicit;
  }

  const rawId = hit.asset_id;
  const id = rawId === null || rawId === undefined || rawId === "" ? null : Number(rawId);
  const nameOf = (assetId: number | null): string | null => {
    if (assetId === null || nameByAsset === undefined || nameByAsset === null) return null;
    const raw = nameByAsset.get(assetId);
    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    return text === "" ? null : text;
  };
  const name = nameOf(id !== null && Number.isFinite(id) ? id : null);
  if (name !== null) return name + "|" + svcText;
  if (svcText !== "") return svcText;
  return "#hit" + String(hit.id ?? "0");
}

/**
 * 得分封顶与去重的**唯一实现**。
 *
 * @param rows - 命中行（需带 `id` / `code` / `points`(本条实际分值) / `asset_id` / `port` /
 *               `target` / `self_created`；可选 `system_key`）。
 * @param pointsByCode - code → 元数据；省略时退化为"每个 code 自成一组、只去重不封顶"。
 */
export function applyScoreCaps<T extends ScoreHitLike>(
  rows: readonly T[],
  pointsByCode: ReadonlyMap<string, ScoreMeta> | null,
  nameByAsset?: ReadonlyMap<number, string> | null,
  extra?: (row: T) => { readonly evidence: string | null },
): ScoreCapsResult<T> {
  const metaOf = (r: T): { group: string; cap: number; scope: DedupScope; rule: number | null } => {
    const m = pointsByCode === null ? undefined : pointsByCode.get(String(r.code ?? ""));
    const rule = m !== undefined && m.rule !== null ? Number(m.rule) : null;
    const legacyScope = legacyCapGroup(r.code);
    return {
      group: rule === null ? "code:" + String(r.code ?? "") : "rule:" + rule,
      cap: m !== undefined && Number(m.cap) > 0 ? Number(m.cap) : 0,
      scope: (m !== undefined ? m.dedup_scope : null) ?? legacyScope ?? "none",
      rule,
    };
  };

  /* 先把所有行打上"未封顶"的初始标记。用可变记录，最后再冻结给调用方 ——
     原实现是直接在行对象上 `r.capped = true`（隐式给每行加了字段），
     这里改成显式包装对象，读的人不用猜哪些字段是 SQL 来的。 */
  interface Mutable extends ScoredHit<T> {
    capped: boolean;
    capped_by_id: number | null;
    capped_by_points: number | null;
    capped_by_evidence: string | null;
    capped_reason_kind: "dedup" | "cap" | null;
    capped_by?: unknown;
  }
  const flagged: Mutable[] = rows.map((row) => {
    const m = metaOf(row);
    const points = Number(row.points) || 0;
    return {
      row,
      id: row.id,
      code: row.code === undefined || row.code === null ? null : String(row.code),
      points,
      capped: false,
      capped_by_id: null,
      capped_by_points: null,
      capped_by_evidence: null,
      capped_reason_kind: null,
      rule: m.rule,
      rule_cap: m.cap,
      cap_group: m.group,
      dedup_scope: m.scope,
      service_key: scoreServiceKey(row),
    };
  });

  /* ① 计分口径去重：同一口径键内只保留分值最高的一条（同分取更早记的） */
  const buckets = new Map<string, Mutable[]>();
  for (const r of flagged) {
    if (Number(r.row.self_created) === 1) continue;
    const scope = r.dedup_scope;
    if (scope === "none") continue;
    let key: string;
    if (scope === "target") {
      key = "target";
    } else if (scope === "system") {
      key = "sys:" + String(systemKeyOf(r.row, nameByAsset) ?? "");
    } else {
      /* 拿不到服务信息时**不参与去重**（见文件头第 1 条纪律） */
      const svc = r.service_key;
      if (svc === null || svc === "") continue;
      key = "svc:" + svc;
    }
    if (key === "" || key === "svc:null" || key === "sys:null") continue;
    const k = r.cap_group + "|" + key;
    const list = buckets.get(k);
    if (list === undefined) buckets.set(k, [r]);
    else list.push(r);
  }
  let capped = 0;
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const best = pickBestHit(list);
    for (const r of list) {
      if (r === best) continue;
      r.capped = true;
      r.capped_by_id = best === undefined ? null : best.id;
      r.capped_by_points = best === undefined ? 0 : best.points;
      r.capped_by_evidence = best === undefined ? null : (extra === undefined ? null : extra(best.row).evidence);
      r.capped_reason_kind = "dedup";
      capped += 1;
    }
  }

  /* ② 规则上限：同一 rule 的计分命中累计不得超过 cap（按分值从高到低累计，超出的标 capped） */
  const caps = new Map<string, RuleCapUsage>();
  const byRule = new Map<string, Mutable[]>();
  for (const r of flagged) {
    if (r.capped || Number(r.row.self_created) === 1) continue;
    if (r.rule_cap <= 0) continue;
    const list = byRule.get(r.cap_group);
    if (list === undefined) byRule.set(r.cap_group, [r]);
    else list.push(r);
  }
  for (const [group, list] of byRule) {
    const first = list[0];
    if (first === undefined) continue;
    const cap = first.rule_cap;
    const orderedList = list.slice().sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return a.id - b.id;
    });
    let used = 0;
    let nCapped = 0;
    for (const r of orderedList) {
      if (used + r.points > cap) {
        r.capped = true;
        r.capped_reason_kind = "cap";
        r.capped_by_points = null;
        nCapped += 1;
        capped += 1;
      } else {
        used += r.points;
      }
    }
    caps.set(group, { rule: first.rule, cap, used, capped: nCapped });
  }
  return { capped, items: flagged, caps };
}

/* ══════════════════════════════════════════════════════════════ 倍率与分值 */

/**
 * 这个 target 的主机部分是 IPv6 字面量吗。
 *
 * **不能用一条粗糙的字符类正则代替**：IPv6 里混着十六进制字母（a-f），
 * 写成 `/^\[[0-9a-f:]+\]/` 这类"只看冒号和十六进制"的写法会把带字母的地址漏判
 * （实测 `2001:db8::1` 里的 `db8` 就被漏掉，G6 的 ×3 完全不生效）。
 */
export function targetHasIpv6Host(target: unknown): boolean {
  const text = String(target ?? "").trim();
  if (text === "") return false;
  const bracket = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\])/i.exec(text);
  if (bracket !== null && bracket[1] !== undefined) return isIpv6(bracket[1].replace(/^\[|\]$/g, ""));
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(text);
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(text) ?? [])[1];
  if (authority === undefined || authority === "") return false;
  const host = authority.replace(/^\[|\]$/g, "").replace(/:\d{1,5}$/, "");
  return isIpv6(host);
}

/** 倍率计算结果。 */
export interface MultiplierResult {
  readonly multiplier: number;
  readonly reasons: readonly string[];
}

/**
 * 把 G5 / G6 的倍率规则算成倍率值（只对权限分生效，不突破原上限 —— 由 cap 兜住）。
 *   · `ip_version === 6` 或 target 是 IPv6 字面量 → ×3（G6）；
 *   · `data_scale === "large"` → ×2（G5：超 1 亿条 或 10TB）；
 *   · `data_scale === "knowledge-base"` → ×2（G5：控制知识库相关系统）；
 *   · 两者都命中 → 相乘（文档没写禁止叠加，取对演练方有利的解释并**如实标注原因**）。
 */
export function scoreMultiplierOf(hit: {
  readonly ip_version?: unknown;
  readonly data_scale?: unknown;
  readonly target?: unknown;
}): MultiplierResult {
  const reasons: string[] = [];
  let multiplier = 1;
  const target = String(hit.target ?? "");
  const ipv6 = Number(hit.ip_version) === 6 || targetHasIpv6Host(target)
    /* 裸写 IPv6 兜底的正则必须含 ≥2 个冒号：dc01:389 / ad01:8080 这类内网主机名:端口
       只有一个冒号，旧正则会把它们误判成 IPv6 让成果静默 ×3 */
    || /(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i.test(target);
  if (ipv6) {
    multiplier *= 3;
    reasons.push("G6 IPv6 成果 ×3");
  }
  const scale = String(hit.data_scale ?? "").trim().toLowerCase();
  if (scale === "large") {
    multiplier *= 2;
    reasons.push("G5 数据规模超 1 亿条 / 10TB ×2");
  } else if (scale === "knowledge-base" || scale === "kb") {
    multiplier *= 2;
    reasons.push("G5 控制知识库相关系统 ×2");
  }
  return { multiplier, reasons };
}

/**
 * 本条命中的**实际分值** = 档位分值 × 倍率。
 *   · 档位分值：命中自带优先（合并版同一条含多档），缺省回落到得分点默认分值；
 *   · 倍率：G5 / G6，乘在分值里、随上限一起被 cap 约束。
 */
export function hitPointsOf(
  hit: { readonly points?: unknown; readonly multiplier?: unknown; readonly code?: string | null },
  metaByCode?: ReadonlyMap<string, { readonly points: number }> | null,
): number {
  let base = 0;
  const rawPoints = hit.points;
  if (rawPoints !== null && rawPoints !== undefined && rawPoints !== "") {
    base = Number(rawPoints) || 0;
  } else {
    const code = hit.code === null || hit.code === undefined ? null : String(hit.code);
    if (code !== null && metaByCode !== undefined && metaByCode !== null) {
      const meta = metaByCode.get(code);
      if (meta !== undefined) base = Number(meta.points) || 0;
    }
  }
  const mult = Number(hit.multiplier);
  return Math.round(base * (Number.isFinite(mult) && mult > 0 ? mult : 1));
}

/* ══════════════════════════════════════════════════════════════ 阶段推导 */

/** 特殊得分点 → 固定阶段（优先级高于按资产内外网推导）。 */
const POINT_STAGE_OVERRIDE: Readonly<Record<string, string>> = {
  /* 旧 code 的兜底（老数据仍可能有） */
  "core-system": "target",
  boundary: "boundary",
  /* 新口径：规则 5/6/7 = 邮箱系统 / 办公业务系统 / 集权系统 —— 这些就是演练的"靶标"；
     规则 22-25 = 突破网络边界，归入 ③ 边界突破（§二 明确规定是"进入内网"）。 */
  "mail-admin": "target", "mail-user": "target",
  "biz-admin": "target", "biz-user": "target",
  "central-admin": "target", "central-user": "target", "central-managed": "target",
  "web-app": "target", "central-system": "target",
  "boundary-logical": "boundary", "boundary-strong": "boundary",
  "boundary-physical": "boundary", "boundary-supply": "boundary",
};

/**
 * 自动推导一条得分属于哪个阶段（允许显式覆盖）：
 *   ① 显式 `stage_code` 优先；
 *   ② 类型特判（集权/邮箱/业务系统 → target，突破网络边界 → boundary）；
 *   ③ 按命中资产的内外网归属（`asset.scope`）；
 *   ④ 没有 asset_id 时按 target 里的地址判断（私有 IP → 内网，公网/域名 → 互联网）。
 *
 * ④ 的兜底很关键：`target='pc-001'` 这种设备名解析不出 IP，必须落到 `internet`
 * 而不是留空 —— 留空会让这条得分不落任何阶段，报告里凭空消失。
 */
export function scoreStageOf(
  hit: { readonly stage_code?: unknown; readonly code?: unknown; readonly target?: unknown } | null | undefined,
  assetScope?: string | null,
): string {
  if (hit !== null && hit !== undefined && typeof hit.stage_code === "string" && hit.stage_code !== "") {
    return hit.stage_code;
  }
  const code = hit === null || hit === undefined ? undefined : String(hit.code ?? "");
  const override = code === undefined ? undefined : POINT_STAGE_OVERRIDE[code];
  if (override !== undefined) return override;
  if (assetScope === "internal") return "internal";
  if (assetScope === "external") return "internet";
  const t = hit === null || hit === undefined ? "" : String(hit.target ?? "");
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(t);
  if (m !== null && m[1] !== undefined) return scopeOfIp(m[1]) === "internal" ? "internal" : "internet";
  return "internet";
}

/* ══════════════════════════════════════════════════════════════ 统一评估入口 */

/** `evaluateScoreBoard` 的输入行：比 `ScoreHitLike` 多一个 code 供查元数据。 */
export interface BoardRow extends ScoreHitLike {
  readonly code: string | null;
}

/** `evaluateScoreBoard` 的结果。 */
export interface BoardResult<T extends BoardRow> {
  readonly byId: ReadonlyMap<number, ScoredHit<T>>;
  readonly items: readonly ScoredHit<T>[];
  readonly caps: ReadonlyMap<string, RuleCapUsage>;
  readonly disabledIds: ReadonlySet<number>;
}

/**
 * **统一的计分评估**：面板 / 报告 / 攻击链都调这一个函数算出"哪条计分、哪条被封顶"。
 *
 * 调用方只需保证每行带 `{ id, code, points, asset_id, port, target, self_created }`
 * 与**本条命中的实际分值**（`points`；不要传得分点默认值 —— 合并版里同一条含多档，
 * 传默认值会把哪条计分判反）。
 *
 * `enabledOnly` 为 true 时"停用得分点"的命中进 `disabledIds`：面板与报告**必须**用它，
 * 否则会出现"面板 50 分、报告 150 分"。
 */
export function evaluateScoreBoard<T extends BoardRow>(
  rows: readonly T[],
  meta: ReadonlyMap<string, ScoreMeta>,
  names: ReadonlyMap<number, string>,
  options?: { readonly enabledOnly?: boolean },
): BoardResult<T> {
  const disabledIds = new Set<number>();
  const evaluated = applyScoreCaps(rows, meta, names, (row) => ({ evidence: row.evidence ?? null }));
  const byId = new Map<number, ScoredHit<T>>();
  for (const item of evaluated.items) byId.set(item.id, item);
  if (options !== undefined && options.enabledOnly === true) {
    for (const h of rows) {
      const m = h.code === null ? undefined : meta.get(h.code);
      if (m !== undefined && Number(m.enabled) !== 1) disabledIds.add(h.id);
    }
  }
  return { byId, items: evaluated.items, caps: evaluated.caps, disabledIds };
}

/**
 * 这条命中为什么不计分（告警 / 界面 / 报告共用一句话，避免三处口径写歪）。
 * @param hit - 命中行（带 code / target / port / rule / rule_cap / capped_reason_kind）
 * @param bestPoints - 去重时被哪条压住（该条的分值）
 */
export function scoreCapReasonText(
  hit: ScoreHitLike & { readonly rule?: number | null; readonly rule_cap?: number | null; readonly capped_reason_kind?: string | null },
  bestPoints?: number | null,
): string {
  const label = serviceLabel(hit);
  if (hit.capped_reason_kind === "cap") {
    return "「" + label + "」这条不计分："
      + (hit.rule === null || hit.rule === undefined ? "" : "规则 " + hit.rule + " ")
      + "的**累计得分已达该规则上限（" + (Number(hit.rule_cap) || 0) + " 分）**——同一规则超出上限的部分不再累加。"
      + "把精力换到别的规则或别的资产上，不要在已达上限的规则里继续刷。";
  }
  return "「" + label + "」这个目标上的权限已经拿满（计分口径：同一目标只算分值最高的那条"
    + (bestPoints === undefined || bestPoints === null ? "" : "，+" + bestPoints + " 分")
    + "）——这条按规则不再计分，只作过程留痕；**换目标或换规则推进，不要在同一个目标上刷同类成果**。";
}

/** 兼容旧名（v0.10 及以前叫 serviceCapReason）。 */
export const serviceCapReason = scoreCapReasonText;

/**
 * 数据规模的**粗判门槛**：100 万条/行。
 * 用途是 G5 翻倍的量级自检（文档正式门槛是"超 1 亿条 或 10TB"）：
 * 低于它会提示核对，但**不阻断记分**。
 */
export const SENSITIVE_DATA_MIN_ROWS = 1000000;

/**
 * 从证据文本里解析数据量（行/条/记录数）。
 *
 * **只认带量词（条/行/记录/records/rows）或中文量级（亿/万…）的写法** ——
 * 裸数字不认，否则会把口令里的 `123456`、端口号当成数据量。
 * 解析不出返回 null（由调用方提示补齐量级，不猜、不编数）。
 */
export function parseRowCount(evidence: unknown): number | null {
  const text = String(evidence ?? "");
  if (text.trim() === "") return null;
  const units: Readonly<Record<string, number>> = {
    亿: 1e8, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 千: 1e3,
  };
  const nums: number[] = [];
  const cn = /(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千)?\s*(条|行|记录|数据|records?|rows?|entries)/gi;
  for (const m of text.matchAll(cn)) {
    const rawBase = m[1];
    if (rawBase === undefined) continue;
    const base = Number(rawBase.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const unit = m[2];
    const mult = unit === undefined ? 1 : (units[unit] ?? 1);
    nums.push(Math.round(base * mult));
  }
  if (nums.length > 0) return Math.max(...nums);
  /* 只写了「导出 120 万」这类（没写条/行）也认，但必须带中文量级 */
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千)/g)) {
    const rawBase = m[1];
    const unit = m[2];
    if (rawBase === undefined || unit === undefined) continue;
    const base = Number(rawBase.replace(/,/g, ""));
    if (Number.isFinite(base)) nums.push(Math.round(base * (units[unit] ?? 1)));
  }
  return nums.length === 0 ? null : Math.max(...nums);
}

/** 千分位展示，告警里读数更直观。 */
export function formatRows(n: number): string {
  return Number(n).toLocaleString("en-US");
}

/** 从 `score_point` 行读元数据（面板/报告/攻击链三处共用，避免字段各漏一个）。 */
export function scoreMetaFromRow(row: {
  readonly code: string | null;
  readonly rule: number | null;
  readonly cap: number | null;
  readonly dedup_scope: string | null;
  readonly points: number | null;
  readonly enabled: number | null;
  readonly builtin: number | null;
  readonly src: number | null;
}): readonly [string, ScoreMeta] {
  return [String(row.code), {
    rule: row.rule === null ? null : Number(row.rule),
    cap: Number(row.cap) || 0,
    dedup_scope: (row.dedup_scope ?? "service") as DedupScope,
    points: Number(row.points) || 0,
    enabled: row.enabled === null ? 1 : Number(row.enabled),
    builtin: Number(row.builtin) === 1,
    src: row.src === null ? null : Number(row.src),
  }];
}
