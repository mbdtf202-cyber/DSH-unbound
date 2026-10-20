import { FILE_SUFFIXES } from "./net-tables.js";

/**
 * 网络范围判定（纯函数部分）。
 *
 * 迁移自 dsh-qilin/lib/net-scope.js。这一层决定「哪些主机算自有网络，
 * 不算外部目标」——它是安全边界，必须精确。
 *
 * ## 关于原实现里的魔法数
 *
 * 原代码写的是 `(value >> 118n) === 0x3fan` 和 `(value >> 121n) === 0x7en`，
 * 没有任何注释说明含义。我实测解码后确认：
 *   - `0x3fa` = `fe80::/10` 的位模式 → **IPv6 链路本地**
 *   - `0x7e`  = `fc00::/7`  的位模式 → **IPv6 唯一本地地址（ULA）**
 * 两者都是「不可路由到公网」的地址段，属于自有网络。
 * 这里改成具名常量并写清推导，避免下一个人再猜一遍。
 *
 * ## 边界
 *
 * - IPv4 判定包含 RFC1918、回环、链路本地、CGNAT、组播与保留段
 * - IPv6 判定包含 ::、::1、fe80::/10、fc00::/7
 * - 域名后缀表覆盖中文/IDN 国别域（`.中国`、`.xn--fiqs8s` 等）
 */

/** IPv4 地址转 32 位无符号整数；非法返回 null。 */
export function ipv4ToInt(ip: string): number | null {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = value * 256 + number;
  }
  return value >>> 0;
}

/**
 * 该 IPv4 是否属于「不应作为外部目标」的段。
 *
 * 覆盖：
 *  - 0.0.0.0/8（本网络）、10/8、127/8（回环）
 *  - 169.254/16（链路本地）、172.16/12、192.168/16
 *  - 224/4 及以上（组播 + 保留 + 广播）
 */
export function isPrivateIpv4(value: number): boolean {
  const a = value >>> 24;
  const b = (value >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

/** IPv6 地址转 128 位大整数；非法返回 null。支持内嵌 IPv4 与 `::` 压缩。 */
export function parseIpv6(input: string): bigint | null {
  let text = String(input || "").trim().toLowerCase().split("%")[0] ?? "";
  if (text === "") return null;

  // 内嵌 IPv4（::ffff:192.168.0.1）先转成两个 16 位组
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const tail = ipv4ToInt(text.slice(colon + 1));
    if (tail === null) return null;
    const hi = (tail >>> 16).toString(16);
    const lo = (tail & 0xffff).toString(16);
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;

  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;

  const parts = halves.length === 2 ? [...left, ...Array<string>(missing).fill("0"), ...right] : left;
  if (parts.length !== 8) return null;

  let out = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    out = (out << 16n) + BigInt(parseInt(part, 16));
  }
  return out;
}

/**
 * `fe80::/10` 的位模式：取 128 位地址的最高 10 位。
 * 推导：fe80 的最高 10 位 = 0b1111111010 = 0x3fa
 */
const IPV6_LINK_LOCAL_PREFIX = 0x3fan;
/** 取最高 10 位所需的右移量。 */
const IPV6_PREFIX_10_SHIFT = 118n;

/**
 * `fc00::/7` 的位模式：取最高 7 位。
 * 推导：fc00 的最高 7 位 = 0b1111110 = 0x7e
 */
const IPV6_UNIQUE_LOCAL_PREFIX = 0x7en;
/** 取最高 7 位所需的右移量。 */
const IPV6_PREFIX_7_SHIFT = 121n;

/** 该 IPv6 是否属于自有/不可路由段。 */
export function isPrivateIpv6(value: bigint): boolean {
  // :: 与 ::1
  if (value === 0n || value === 1n) return true;
  if (value >> IPV6_PREFIX_10_SHIFT === IPV6_LINK_LOCAL_PREFIX) return true;
  if (value >> IPV6_PREFIX_7_SHIFT === IPV6_UNIQUE_LOCAL_PREFIX) return true;
  return false;
}

/**
 * 从原始输入提取主机名。
 *
 * 处理：`user@host`、`[::1]:8080`、`1.2.3.4:80`、`host:80`、尾点。
 */
export function hostOf(raw: string): string {
  let host = String(raw ?? "").trim().toLowerCase();
  if (host === "") return "";
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 1 ? host.slice(1, end) : "";
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(host)) return host.replace(/:\d+$/, "");
  if (/^[a-z0-9.-]+:\d+$/.test(host)) return host.replace(/:\d+$/, "");
  return host.replace(/\.$/, "");
}

/** 该主机是否属于自有网络（不应被当作外部目标）。 */
export function isOwnNetwork(host: string): boolean {
  const name = hostOf(host);
  if (name === "") return false;

  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;

  if (name.includes(":")) {
    const value = parseIpv6(name);
    return value !== null && isPrivateIpv6(value);
  }

  const value = ipv4ToInt(name);
  return value !== null && isPrivateIpv4(value);
}

/** 看起来像 IP（v4 点分或含冒号）。 */
export function looksLikeIp(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * 国别后缀到区域的映射。
 *
 * 包含 IDN（punycode 与中文两种写法），因为 `.中国` 和 `.xn--fiqs8s`
 * 指向同一片区域，漏掉任一种都会让判定不一致。
 */
export const REGION_SUFFIXES: readonly (readonly [string, string])[] = Object.freeze([
  [".xn--fiqs8s", "CN"],
  [".xn--fiqz9s", "CN"],
  [".xn--j6w193g", "HK"],
  [".xn--mix082f", "MO"],
  [".xn--55qx5d", "CN"],
  [".xn--io0a7i", "CN"],
  [".xn--55qw42g", "CN"],
  [".xn--zfr164b", "CN"],
  [".xn--czru2d", "CN"],
  [".xn--hxt814e", "CN"],
  [".xn--fiq228c5hs", "CN"],
  [".xn--3bst00m", "CN"],
  [".xn--ses554g", "CN"],
  [".中国", "CN"],
  [".中國", "CN"],
  [".公司", "CN"],
  [".网络", "CN"],
  [".網絡", "CN"],
  [".公益", "CN"],
  [".政务", "CN"],
  [".商城", "CN"],
  [".网店", "CN"],
  [".中文网", "CN"],
  [".集团", "CN"],
  [".网址", "CN"],
  [".在线", "CN"],
  [".移动", "CN"],
  [".我爱你", "CN"],
  [".香港", "HK"],
  [".澳门", "MO"],
  [".澳門", "MO"],
  [".com.cn", "CN"],
  [".net.cn", "CN"],
  [".org.cn", "CN"],
  [".gov.cn", "CN"],
  [".edu.cn", "CN"],
  [".ac.cn", "CN"],
  [".mil.cn", "CN"],
  [".ah.cn", "CN"],
  [".bj.cn", "CN"],
  [".cq.cn", "CN"],
  [".fj.cn", "CN"],
  [".gd.cn", "CN"],
  [".gs.cn", "CN"],
  [".gx.cn", "CN"],
  [".gz.cn", "CN"],
  [".ha.cn", "CN"],
  [".hb.cn", "CN"],
  [".he.cn", "CN"],
  [".hi.cn", "CN"],
  [".hl.cn", "CN"],
  [".hn.cn", "CN"],
  [".jl.cn", "CN"],
  [".js.cn", "CN"],
  [".jx.cn", "CN"],
  [".ln.cn", "CN"],
  [".nm.cn", "CN"],
  [".nx.cn", "CN"],
  [".qh.cn", "CN"],
  [".sc.cn", "CN"],
  [".sd.cn", "CN"],
  [".sh.cn", "CN"],
  [".sn.cn", "CN"],
  [".sx.cn", "CN"],
  [".tj.cn", "CN"],
  [".xj.cn", "CN"],
  [".xz.cn", "CN"],
  [".yn.cn", "CN"],
  [".zj.cn", "CN"],
  [".hk.cn", "HK"],
  [".mo.cn", "MO"],
  [".cn", "CN"],
  [".com.hk", "HK"],
  [".edu.hk", "HK"],
  [".gov.hk", "HK"],
  [".idv.hk", "HK"],
  [".net.hk", "HK"],
  [".org.hk", "HK"],
  [".hk", "HK"],
  [".com.mo", "MO"],
  [".edu.mo", "MO"],
  [".gov.mo", "MO"],
  [".net.mo", "MO"],
  [".org.mo", "MO"],
  [".mo", "MO"],
] as const);

/** IPv4 点分十进制文本。 */
const V4_TEXT = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** 严格的主机名（必须有点、有至少 2 位 TLD）。 */
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * 从一段允许清单文本里解析出**一个**主机。
 *
 * 注意：这与 `hostOf` 语义不同。`hostOf` 只做解析（给什么拆什么），
 * `entryHost` 做**校验**——拒绝注释、路径、通配符、密钥、文件名，
 * 只放行一个 IP 或一个完整主机名。两者不能互换。
 *
 * @returns 合法主机名，或空串（调用方跳过该行）
 */
export function entryHost(raw: string): string {
  const text = String(raw ?? "").trim();
  if (text === "" || text.startsWith("#")) return "";
  if (text.length > 253 || /[\s/\\*]/.test(text)) return "";
  if (/BEGIN |PRIVATE KEY|ssh-(?:rsa|ed25519|dss) /i.test(text)) return "";

  let body = text;
  const at = body.lastIndexOf("@");
  if (at >= 0) {
    const user = body.slice(0, at);
    // user@host 形式：账号只能是简单标识符，否则多半是邮箱签名/密钥注释
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) return "";
    body = body.slice(at + 1);
  }

  const host = hostOf(body);
  if (host === "" || host.length > 253) return "";
  if (V4_TEXT.test(host)) return host;
  if (host.includes(":")) return parseIpv6(host) !== null ? host : "";
  if (!HOST_NAME.test(host)) return "";
  // 以文件后缀结尾的「主机」其实是文件名
  const tail = host.slice(host.lastIndexOf(".") + 1);
  if (FILE_SUFFIXES.has(tail)) return "";
  return host;
}

/**
 * 判断主机是否命中银行表（含子域）。
 * 子域会逐级回退：online.chase.com → chase.com
 */
export function isBankHost(host: string, banks: ReadonlySet<string>): boolean {
  const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (name === "") return false;
  let candidate = name;
  for (;;) {
    if (banks.has(candidate)) return true;
    const dot = candidate.indexOf(".");
    if (dot < 0) return false;
    candidate = candidate.slice(dot + 1);
  }
}

/** 根据域名后缀推断区域；识别不出返回空串。 */
export function regionOfSuffix(host: string): string {
  const name = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (name === "" || name === "localhost" || name.endsWith(".local")) return "";
  for (const [suffix, region] of REGION_SUFFIXES) {
    if (name === suffix.slice(1) || name.endsWith(suffix)) return region;
  }
  return "";
}
