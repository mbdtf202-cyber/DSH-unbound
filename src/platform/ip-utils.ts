/**
 * IP / 文本归一化工具（纯函数，零依赖）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/ip-utils.js`。
 *
 * ## 为什么单独一层
 *
 * 这些函数不碰数据库、不依赖 Store 实例，却原本散落在 5000 行的 core.js 里，
 * 单测只能连同 SQLite 一起加载。抽出来后可以单独测、单独读。
 *
 * ## 迁移时钉死的行为
 *
 * 1. **IPv6 不走整数排序**：`ipToInt` 只认 IPv4，其余返回 `null`，
 *    让 `ip_int` 列保持 NULL、排序退回按文本。绝不编造 0，也绝不把地址拼坏。
 * 2. **认不出来的 IP 原样返回**：`cidrOf` 绝不拼出 `2001:db8::1.0/24` 这种四不像 ——
 *    面板左侧会因此多出一个假网段、资产归属也错。
 * 3. **`isIpv6` 是启发式**：只要"含冒号 + 字符集像 + 冒号段数 ≤ 9"就认。
 *    它不追求 RFC 严谨（不做双重 `::`、组数超限的严格校验），
 *    因为调用方只拿它决定"按 /64 分组还是按 /24 分组"，宽松不会造成数据损坏，
 *    严格反而会把带 zone id / 括号写法的真实资产判成"认不出来"。
 */

/**
 * IPv4 → 32 位整数（用于 ORDER BY 的自然排序）。
 *
 * 八位组不校验范围（`999.1.1.1` 也算通过正则），与旧实现一致 ——
 * 整数只用于排序，不用于判定合法性，改了反而会让历史数据排序变动。
 *
 * @param ip 任意值，非字符串会被 `String()` 化。
 * @returns 32 位无符号整数；非 IPv4 字面量返回 `null`。
 */
export function ipToInt(ip: unknown): number | null {
  const text = String(ip ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null;
  return text.split(".").reduce((n, o) => (n * 256 + Number(o)) >>> 0, 0);
}

/** 是不是 IPv6 字面量（含 `::` 缩写与 IPv4-mapped 写法）。 */
export function isIpv6(ip: unknown): boolean {
  const text = String(ip ?? "").trim();
  if (!text.includes(":")) return false;
  return /^[0-9a-fA-F:]+(:\d{1,3}(\.\d{1,3}){3})?$/.test(text) && text.split(":").length <= 9;
}

/**
 * 把 IPv6 展开成 8 组十六进制（只用于取前 4 组算 /64，不追求完全严谨）。
 *
 * 会剥掉 `[` `]`（URL 里的写法）。缺失的组补 `0`；超出 8 组时原样返回、
 * 不再截断 —— 截断会悄悄改变网段归属。
 */
export function expandIpv6(ip: unknown): string[] {
  const text = String(ip ?? "").trim().replace(/^\[|\]$/g, "");
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  const groups = left.concat(new Array(Math.max(missing, 0)).fill("0")).concat(right);
  return groups.map((g) => (g === "" ? "0" : g.toLowerCase()));
}

/**
 * 这个 IP 属于哪个"段"（资产测绘左侧按 C 段分组）。
 *
 * - IPv4 → 前三段 + `.0/24`
 * - IPv6 → 前四组 + `::/64`（IPv6 的一个网段就是 /64，与 IPv4 的 /24 对应）
 * - 认不出来 → 返回原文
 */
export function cidrOf(ip: unknown): string {
  const text = String(ip ?? "").trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text.split(".").slice(0, 3).join(".") + ".0/24";
  if (isIpv6(text)) {
    const groups = expandIpv6(text);
    return groups.slice(0, 4).join(":") + "::/64";
  }
  return text;
}

/** 内外网归属。 */
export type IpScope = "internal" | "external";

/**
 * 判断 IP 属于内网还是外网。
 *
 * - IPv4：`10/8`、`192.168/16`、`127/8`、`169.254/16`、`172.16-31/12`、`100.64-127/10`（CGNAT）
 * - IPv6：ULA（`fc00::/7`）与链路本地（`fe80::/10`）
 * - IPv4-mapped 的 `::ffff:a.b.c.d` 剥壳后按 IPv4 判
 *
 * @param ip 待判定地址。
 */
export function scopeOfIp(ip: unknown): IpScope {
  const s = String(ip ?? "");
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(s);
  if (mapped !== null) {
    const inner = mapped[1];
    if (inner !== undefined) return scopeOfIp(inner);
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(s) || /^fe[89ab][0-9a-f]:/i.test(s)) return "internal";
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(s)) return "internal";
  const m = /^172\.(\d{1,3})\./.exec(s);
  if (m !== null) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return "internal";
  }
  const c = /^100\.(\d{1,3})\./.exec(s);
  if (c !== null) {
    const n = Number(c[1]);
    if (n >= 64 && n <= 127) return "internal";
  }
  return "external";
}

/**
 * 把任意名字归一化成 slug（全小写、非字母数字转短横线）。
 *
 * 空名字退化成 `engagement-<时间戳>`：靶标目录名必须非空，
 * 否则 `join(root, '')` 会写到根目录上去。
 *
 * @param name 原始名字。
 * @param now 空名字时的时间戳来源（便于测试注入，默认 `Date.now()`）。
 */
export function slugify(name: unknown, now: number = Date.now()): string {
  const s = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "engagement-" + String(now) : s;
}

/**
 * 把目标（IP / URL / C 段）归一化成攻击文件目录名。
 *
 * - IP 或 `ip:port` → 只取 IP（同一 IP 的多个端口归一个文件夹）
 * - URL → 只取 host（去掉协议、端口、路径）
 * - C 段 `10.0.0.0/24` → `10.0.0.0_24`
 */
export function slugTarget(target: unknown): string {
  const raw = String(target ?? "").trim();
  if (raw === "") return "unknown";
  const ipMatch = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(raw);
  if (ipMatch !== null) {
    const ip = ipMatch[1];
    if (ip !== undefined) return ip;
  }
  const urlMatch = /^https?:\/\/([^/?#]+)/i.exec(raw);
  const hostPort = urlMatch !== null ? (urlMatch[1] ?? raw) : raw;
  const host = hostPort.replace(/:(\d+)$/, "");
  return host.replace(/[^\w.\-]/g, "_").replace(/_+$/, "") || "unknown";
}

/**
 * 生成知识库条目的稳定标识：组件 + 编号/标题，便于智能体直接引用。
 *
 * 标题里往往已经写了 CVE，别再拼一遍 ——
 * 否则 code 会变成 `xxx-cve-2023-21839-cve-2023-21839`。
 *
 * @param title 标题。
 * @param cve CVE / CNVD 编号（可空）。
 * @param now 空结果时的时间戳来源（便于测试注入）。
 */
export function slugPoc(title: unknown, cve: unknown, now: number = Date.now()): string {
  const t = String(title ?? "").trim();
  const c = String(cve ?? "").trim();
  const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = c !== "" && !flat(t).includes(flat(c)) ? c + " " + t : t;
  const slug = base
    .toLowerCase()
    .replace(/cve[-_ ]?(\d{4})[-_ ]?(\d+)/g, "cve-$1-$2")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug === "" ? "poc-" + String(now) : slug;
}

/** 语言 → 扩展名。表里没有就按 kind 兜底。 */
const LANG_EXT: Readonly<Record<string, string>> = {
  python: "py",
  py: "py",
  go: "go",
  java: "java",
  bash: "sh",
  sh: "sh",
  shell: "sh",
  js: "js",
  node: "js",
  php: "php",
  ruby: "rb",
  powershell: "ps1",
  http: "http",
  nuclei: "yaml",
  yaml: "yaml",
};

/**
 * 按语言给正文一个合适的文件名（智能体可以直接照着运行）。
 *
 * @param title 标题（当前实现不参与取名，保留参数以维持调用点稳定）。
 * @param kind 条目类型，`template` 兜底成 `poc.yaml`。
 * @param language 语言名，大小写不敏感。
 */
export function defaultPocFilename(title: unknown, kind: unknown, language: unknown): string {
  void title;
  const key = String(language ?? "").toLowerCase();
  const ext = LANG_EXT[key];
  if (ext !== undefined) return "poc." + ext;
  if (kind === "template") return "poc.yaml";
  return "poc.txt";
}

/** ISO 时间戳（统一出口，便于测试注入）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
