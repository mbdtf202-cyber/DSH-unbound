/**
 * `/redteam/api` 的同源校验。
 *
 * ## 为什么这块必须逐分支保留
 *
 * 原 `ui.js` 的判定是一条被压平的 `if` 链，注释里记了两次线上事故：
 *
 * 1. **第一版只比 `Origin.host === Host`** —— 官方桌面端的 `Origin` 是
 *    `app://` 或字面量 `null`，`new URL('null')` 抛错 → 判空 → 直接 403，
 *    技能库 / 知识库 / SQLite 三个页签全挂。修法是「本机 Host 时放宽」。
 * 2. **第二版又只看 Origin** —— 宿主自己的 `fetch('/redteam/api')` 在某些
 *    内嵌 webview 里根本不带 `Origin`，于是连自己都挡。修法是「回环 socket 一律放行」。
 *
 * 这两条补丁各自对应一组真实环境组合，**看起来能合并、合并就回归**。
 * 所以这里把每个分支做成具名 `reason`，一个分支一个测试用例；
 * 改动任何一个分支都会让对应测试红。
 *
 * ## 威胁模型
 *
 * 恶意页面 `https://evil.example` 里 `fetch('http://127.0.0.1:PORT/redteam/api')`
 * 会带上 `Origin: https://evil.example`。浏览器**总会**给跨源请求加 `Origin`，
 * 所以「`Origin` 缺失」只可能来自本机进程 / 桌面外壳 —— 这正是放宽的依据。
 * 而 `Origin: null` 来自沙箱 iframe、`data:`、`file:` 页面，桌面端会这么发，
 * 这里按本机信任处理（与宿主一致）。
 *
 * 反过来说：**非回环** socket（局域网/公网来访）一律走严格比对，
 * 因为那时 `Origin` 缺失可能被中间层伪造。
 */

/** 校验结论。`allow` 为假时 `reason` 说明拒绝依据。 */
export type OriginDecision =
  | {
      readonly allow: true;
      readonly reason:
        /** 连接来自本机回环地址：宿主自己的界面，无条件放行。 */
        | "loopback"
        /** 本机 Host 且 Origin 缺失 / 空串 / 字面量 null（桌面外壳）。 */
        | "local-host-bare-origin"
        /** 本机 Host 且 Origin 是 `app://` 自定义协议（桌面外壳）。 */
        | "local-host-app-scheme"
        /** 本机 Host 且 Origin 解析出的 host 为空（`file://` 之类）或与 Host 相同。 */
        | "local-host-matching-origin"
        /** 严格比对：Origin 的 host 与 Host 完全一致。 */
        | "same-origin";
    }
  | {
      readonly allow: false;
      readonly reason:
        /** 非回环且 Origin 不是非空字符串。 */
        | "missing-origin"
        /** Origin 在严格路径下无法解析成 URL。 */
        | "unparsable-origin"
        /** Origin 可解析，但 host 与 Host 不同。 */
        | "host-mismatch";
    };

/** 只需要我们读的那几个字段，便于测试直接构造，不必造完整 IncomingMessage。 */
export interface RequestOriginFacts {
  /** `req.socket.remoteAddress`；不可用时为 `null`。 */
  readonly remoteAddress: string | null;
  /** `req.headers.host`；非字符串时为 `null`。 */
  readonly host: string | null;
  /** `req.headers.origin`；非字符串时为 `null`。 */
  readonly origin: string | null;
}

/** 本机回环地址集合（IPv4 / IPv6 / IPv4-mapped-IPv6 三种形态）。 */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

/**
 * `Host` 指向本机的判定。
 *
 * 只认三种写法：`localhost`、`127.0.0.1`、`[::1]`，可带端口。
 * 刻意**不**认 `0.0.0.0` —— 那是监听地址，不是可路由的目标，
 * 拿它当「本机」会让 `Host: 0.0.0.0:x` 的伪造请求走进放宽分支。
 */
const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

/** 桌面外壳的自定义协议。 */
const APP_SCHEME_PATTERN = /^app:/i;

/** 判断一个 socket 对端地址是否为本机回环。 */
export function isLoopbackAddress(address: string | null): boolean {
  return address !== null && LOOPBACK_ADDRESSES.has(address);
}

/** 判断 `Host` 头是否指向本机。 */
export function isLocalHost(host: string | null): boolean {
  return host !== null && LOCAL_HOST_PATTERN.test(host);
}

/**
 * 尝试从 Origin 取出 host。
 *
 * 返回 `string` 表示解析成功（可能是空串，`file://` 的 host 就是空）；
 * 返回 `null` 表示解析失败 —— 两者语义**不同**，不能合并：
 * 空 host 走「本机放宽」，解析失败走「拒绝」。
 */
export function originHostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * 同源校验主入口。
 *
 * 分支顺序与原实现一致，**顺序本身是语义的一部分**：
 * 回环放行必须在最前，否则带 `Origin: app://...` 的桌面请求会先被严格路径拒掉。
 */
export function checkOrigin(facts: RequestOriginFacts): OriginDecision {
  const { remoteAddress, host, origin } = facts;

  // ① 回环 socket：本机进程，无条件放行（不看 Origin —— 内嵌 webview 可能不带）。
  if (isLoopbackAddress(remoteAddress)) {
    return { allow: true, reason: "loopback" };
  }

  // ② 本机 Host：桌面外壳的三种 Origin 形态各自放行。
  if (isLocalHost(host)) {
    // ②-a Origin 缺失 / 空串 / 字面量 "null"（沙箱 iframe、file: 页面）。
    if (origin === null || origin === "" || origin === "null") {
      return { allow: true, reason: "local-host-bare-origin" };
    }
    // ②-b app:// 自定义协议。
    if (APP_SCHEME_PATTERN.test(origin)) {
      return { allow: true, reason: "local-host-app-scheme" };
    }
    // ②-c 能解析且 host 为空（file://）或与 Host 相同。
    const localOriginHost = originHostOf(origin);
    if (localOriginHost !== null && (localOriginHost === host || localOriginHost === "")) {
      return { allow: true, reason: "local-host-matching-origin" };
    }
    // 落到严格路径继续判（可能仍匹配）。
  }

  // ③ 严格路径前置：Origin 必须是非空字符串。
  if (origin === null || origin === "") {
    return { allow: false, reason: "missing-origin" };
  }

  // ④ 严格路径：Origin 必须可解析，且 host 与 Host 完全一致。
  const originHost = originHostOf(origin);
  if (originHost === null) {
    return { allow: false, reason: "unparsable-origin" };
  }
  if (originHost === "" || originHost !== host) {
    return { allow: false, reason: "host-mismatch" };
  }
  return { allow: true, reason: "same-origin" };
}

/**
 * 从宿主请求对象里抽出三个事实。
 *
 * 单独一层的原因：`IncomingMessage` 的形状随 Node 版本与中间件变化，
 * 抽完后 `checkOrigin` 就是纯函数，可以穷举测试而不必造 socket。
 */
export function readOriginFacts(request: {
  readonly socket?: { readonly remoteAddress?: string | null } | null;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | null;
} | null): RequestOriginFacts {
  if (request === null) return { remoteAddress: null, host: null, origin: null };
  const rawRemote = request.socket?.remoteAddress;
  const rawHost = request.headers?.["host"];
  const rawOrigin = request.headers?.["origin"];
  return {
    remoteAddress: typeof rawRemote === "string" && rawRemote !== "" ? rawRemote : null,
    // Host 头理论上只有一个；取数组首项以兼容被中间件归一成数组的情况。
    host: typeof rawHost === "string"
      ? rawHost
      : Array.isArray(rawHost) && typeof rawHost[0] === "string" ? rawHost[0] : null,
    origin: typeof rawOrigin === "string"
      ? rawOrigin
      : Array.isArray(rawOrigin) && typeof rawOrigin[0] === "string" ? rawOrigin[0] : null,
  };
}
