/**
 * 报告复现工具（纯函数）。
 *
 * 迁移自 dsh-qilin `lib/redteam/report-replay.js`。目标：让报告里**每一条得分**
 * 都有"可照做"的复现入口，而不是只有一句"没有原始请求记录"。
 *
 * 两条底线（原注释，必须保留）：
 *   · **合成的东西必须标注来源**：推断出来的请求与真实抓包在可信度上不是一回事，
 *     报告里要能一眼分辨，不能让验收人把推断当实证。
 *   · 合成只在"信息足够"时做：有 URL 或有明确的 curl/httpie 命令才合成，
 *     否则宁可留空，不编造。
 */

/** 解析出的目标。`scheme` 为 null 表示原文没写协议。 */
export interface ParsedTarget {
  readonly scheme: string | null;
  readonly host: string;
  readonly port: number | null;
  readonly path: string | null;
  readonly authority: string;
  readonly ipv6: boolean;
}

/** 命令类别的粗分类（决定能不能直接当复现命令用）。 */
export type CommandKind = "curl" | "httpie" | "scanner" | "msf" | "script" | "other";

/**
 * 从 target 里解析出 scheme / host / port / path，用于补全合成请求。
 *
 * **必须显式处理 IPv6 方括号**：`http://[2001:db8::1]:8080/x` 里"IPv6 地址内部的冒号"
 * 与"端口分隔冒号"混在一起，用一条正则一起抓会错位 —— 实测把 host 解析成 `2001:db8:`、
 * path 变成 `:8080/x`，合成出来的报文首行成了 `GET :8080/x HTTP/1.1`。
 * 所以分两步：先按方括号取 authority，再按"最后一个冒号"剥端口。
 */
export function parseTarget(target: unknown): ParsedTarget | null {
  const t = String(target ?? "").trim();
  if (t === "") return null;
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)([^?#\s]*)?/i.exec(t);
  if (url !== null) {
    const scheme = String(url[1]).toLowerCase();
    const authority = String(url[2]);
    const rawPath = url[3];
    const path = rawPath !== undefined && rawPath !== "" ? rawPath : "/";
    const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(authority);
    if (bracket !== null && bracket[1] !== undefined) {
      return {
        scheme, host: bracket[1],
        port: bracket[2] === undefined ? (scheme === "https" ? 443 : 80) : Number(bracket[2]),
        path, authority, ipv6: true,
      };
    }
    const portMatch = /:(\d{1,5})$/.exec(authority);
    const host = portMatch === null ? authority : authority.slice(0, -portMatch[0].length);
    return {
      scheme, host,
      port: portMatch === null ? (scheme === "https" ? 443 : 80) : Number(portMatch[1]),
      path, authority, ipv6: false,
    };
  }
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(t);
  if (bracket !== null && bracket[1] !== undefined) {
    return {
      scheme: null, host: bracket[1],
      port: bracket[2] === undefined ? null : Number(bracket[2]),
      path: null, authority: t, ipv6: true,
    };
  }
  const bare = /^([^\s/?#:]+)(?::(\d{1,5}))?$/.exec(t);
  if (bare !== null && bare[1] !== undefined) {
    return {
      scheme: null, host: bare[1],
      port: bare[2] === undefined ? null : Number(bare[2]),
      path: null, authority: t, ipv6: false,
    };
  }
  const head = /^([^\s/?#]+)/.exec(t);
  if (head === null || head[1] === undefined) return null;
  return { scheme: null, host: head[1], port: null, path: null, authority: t, ipv6: false };
}

/** 这条命令看起来是什么工具（决定能不能直接当复现命令用）。 */
export function commandKind(tool: unknown): CommandKind | null {
  const t = String(tool ?? "").trim();
  if (t === "") return null;
  if (/^curl\b/i.test(t)) return "curl";
  if (/^http(ie| x)?\b/i.test(t) || /^http\s/i.test(t)) return "httpie";
  if (/^(nuclei|ffuf|feroxbuster|gobuster|dirsearch|sqlmap|hydra|nmap|masscan|fscan|gogo)\b/i.test(t)) return "scanner";
  if (/^(msfconsole|use\s|set\s)/i.test(t)) return "msf";
  if (/^(python|python3|java|go run|node)\b/i.test(t)) return "script";
  return "other";
}

/** 从一条 curl 命令里抽出的可重放信息。 */
export interface ParsedCurl {
  readonly url: string;
  readonly method: string;
  readonly data: string | null;
  readonly headers: readonly string[];
  readonly cookie: string | null;
  readonly insecure: boolean;
  readonly followRedirect: boolean;
}

/** 从一条 curl 命令里抽出 URL 与方法。只做保守解析：抽不出就返回 null，不猜。 */
export function parseCurl(tool: unknown): ParsedCurl | null {
  const t = String(tool ?? "").trim();
  if (!/^curl\b/i.test(t)) return null;
  const urlMatch = /(https?:\/\/[^\s'"]+)/i.exec(t);
  if (urlMatch === null || urlMatch[1] === undefined) return null;
  const methodMatch = /(?:-X|--request)\s+([A-Z]+)/.exec(t);
  const dataMatch = /(?:-d|--data(?:-raw|-binary|-urlencode)?)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(t);
  const headerMatches = Array.from(t.matchAll(/(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)")/gi))
    .map((m) => (m[1] !== undefined ? m[1] : m[2]))
    .filter((x): x is string => typeof x === "string" && x.includes(":"));
  const cookieMatch = /(?:-b|--cookie)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(t);
  const data = dataMatch === null ? null : (dataMatch[1] ?? dataMatch[2] ?? dataMatch[3] ?? null);
  const method = methodMatch !== null && methodMatch[1] !== undefined
    ? methodMatch[1].toUpperCase()
    : (data === null ? "GET" : "POST");
  return {
    url: urlMatch[1], method, data,
    headers: headerMatches,
    cookie: cookieMatch === null ? null : (cookieMatch[1] ?? cookieMatch[2] ?? cookieMatch[3] ?? null),
    insecure: /(^|\s)-k(\s|$)|--insecure/.test(t),
    followRedirect: /(^|\s)-L(\s|$)|--location/.test(t),
  };
}

/** 合成 HTTP 报文的参数。 */
export interface BuildHttpRequestOptions {
  readonly url: unknown;
  readonly method?: unknown;
  readonly data?: unknown;
  readonly headers?: readonly string[];
  readonly cookie?: string | null;
  readonly insecure?: boolean;
  readonly followRedirect?: boolean;
  /** 显式路径（覆盖 URL 里的 path，保住查询串）。 */
  readonly path?: string | null;
}

/**
 * 合成一条可粘进 Yakit Repeater 的 HTTP 报文。
 * 信息不足（URL 解析不出）时返回 null。
 */
export function buildHttpRequest(options: BuildHttpRequestOptions): string | null {
  const target = parseTarget(options.url);
  if (target === null) return null;
  const scheme = target.scheme ?? "http";
  /* IPv6 的 Host 头必须带方括号（RFC 3986），否则是非法头 */
  const hostText = target.ipv6 ? "[" + target.host + "]" : target.host;
  const defaultPort = scheme === "https" ? 443 : 80;
  const hostHeader = target.port !== null && target.port !== defaultPort
    ? hostText + ":" + target.port
    : hostText;
  const path = options.path !== undefined && options.path !== null && options.path !== ""
    ? options.path
    : (target.path ?? "/");
  const method = String(options.method ?? (options.data === undefined || options.data === null ? "GET" : "POST")).toUpperCase();
  const lines = [method + " " + path + " HTTP/1.1", "Host: " + hostHeader];
  const headers = Array.isArray(options.headers) ? options.headers.slice() : [];
  const hasHeader = (name: string): boolean =>
    headers.some((h) => h.toLowerCase().startsWith(name.toLowerCase() + ":"));
  if (!hasHeader("User-Agent")) headers.push("User-Agent: Mozilla/5.0");
  if (!hasHeader("Accept")) headers.push("Accept: */*");
  if (options.cookie !== undefined && options.cookie !== null && options.cookie !== "" && !hasHeader("Cookie")) {
    headers.push("Cookie: " + options.cookie);
  }
  const body = options.data === undefined || options.data === null ? "" : String(options.data);
  if (body !== "" && !hasHeader("Content-Type")) {
    headers.push(/^\{.*\}$/.test(body.trim()) ? "Content-Type: application/json" : "Content-Type: application/x-www-form-urlencoded");
  }
  if (body !== "" && !hasHeader("Content-Length")) headers.push("Content-Length: " + Buffer.byteLength(body, "utf8"));
  if (!hasHeader("Connection")) headers.push("Connection: close");
  const first = lines[0] ?? "";
  return [first, ...headers, "", body].join("\r\n");
}

/** 合成复现命令的参数。 */
export interface BuildCurlCommandOptions {
  readonly url: unknown;
  readonly method?: unknown;
  readonly data?: unknown;
  readonly headers?: readonly string[];
  readonly cookie?: string | null;
  readonly insecure?: boolean;
  readonly followRedirect?: boolean;
  readonly path?: string | null;
  /** 已存在的真实命令：是 curl 就原样返回（最可信）。 */
  readonly tool?: string;
}

/**
 * 合成一条"可直接在终端跑"的复现命令。
 * 优先用真实的 curl 命令（原样保留，最可信）；否则按 URL/方法拼一条。
 */
export function buildCurlCommand(options: BuildCurlCommandOptions): string | null {
  const raw = String(options.tool ?? "").trim();
  if (commandKind(raw) === "curl") return raw;
  const target = parseTarget(options.url);
  if (target === null) return null;
  const scheme = target.scheme ?? "http";
  const hostText = target.ipv6 ? "[" + target.host + "]" : target.host;
  const defaultPort = scheme === "https" ? 443 : 80;
  const hostPart = target.port !== null && target.port !== defaultPort
    ? hostText + ":" + target.port
    : hostText;
  const url = scheme + "://" + hostPart + (options.path ?? target.path ?? "/");
  const parts = ["curl -i -s" + (options.insecure === true ? " -k" : "") + (options.followRedirect === true ? " -L" : "")];
  if (options.method !== undefined && options.method !== null && String(options.method).toUpperCase() !== "GET") {
    parts.push("-X " + String(options.method).toUpperCase());
  }
  if (options.cookie !== undefined && options.cookie !== null && options.cookie !== "") {
    parts.push("-b '" + options.cookie + "'");
  }
  if (options.data !== undefined && options.data !== null && String(options.data) !== "") {
    parts.push("-d '" + String(options.data).replace(/'/g, "'\\''") + "'");
  }
  parts.push("'" + url + "'");
  return parts.join(" ");
}

/** 模板填充用的已知值。 */
export interface TemplateValues {
  readonly host?: string | null;
  readonly port?: string | number | null;
  readonly user?: string | null;
  readonly pass?: string | null;
  readonly url?: string | null;
}

/** `fillTemplate` 的结果：填好的命令 + 填了哪些 + 还剩哪些占位符。 */
export interface FilledTemplate {
  readonly cmd: string;
  readonly filled: readonly string[];
  readonly remaining: readonly string[];
}

/**
 * 用本条得分**已经记录的信息**填充动作模板里的占位符。
 *
 * 为什么值得做：数据库/终端/隧道这类得分项的模板长这样
 * `mysql -h <host> -u <user> -p -e "..."`，而这条得分自己就知道 host（target）与账号（凭据）。
 * 填不上的占位符**保持原样并如实报告**，不猜、不假装能直接跑。
 */
export function fillTemplate(template: unknown, values: TemplateValues): FilledTemplate {
  let cmd = String(template ?? "");
  const filled: string[] = [];
  const table: readonly (readonly [RegExp, string | number | null | undefined])[] = [
    [/<host>/gi, values.host],
    [/<ip>/gi, values.host],
    [/<port>/gi, values.port],
    [/<user(name)?>/gi, values.user],
    [/<账号>/g, values.user],
    [/<用户名>/g, values.user],
    [/<pass(word)?>/gi, values.pass],
    [/<口令>/g, values.pass],
    [/<密钥>/g, values.pass],
    [/<pwd>/gi, values.pass],
    [/<url>/gi, values.url],
    [/<域名>/g, values.host],
    [/<目标IP>/g, values.host],
    [/<内网IP>/g, values.host],
    [/<端口>/g, values.port],
    [/<listen端口>/g, values.port],
    [/<u>/g, values.user],
    [/<p>/g, values.pass],
  ];
  for (const [re, value] of table) {
    if (value === undefined || value === null || String(value) === "") continue;
    /* 用去掉 g 的副本探测：`test()` 会推进 lastIndex，导致带 g 的正则时灵时不灵 */
    const needle = new RegExp(re.source, re.flags.replace("g", ""));
    if (!needle.test(cmd)) continue;
    cmd = cmd.replace(new RegExp(re.source, re.flags), String(value));
    /* 记录填了什么，报告里要如实说明（模板被改过，读者需要知道哪些是补进去的） */
    filled.push(re.source.replace(/[\\<>?()/]|gi$/g, "") + " → " + String(value));
  }
  const remaining = Array.from(new Set(Array.from(cmd.matchAll(/<[^>\s]{1,24}>/g)).map((m) => m[0])));
  return { cmd, filled, remaining };
}
