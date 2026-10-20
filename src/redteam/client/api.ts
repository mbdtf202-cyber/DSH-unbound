/**
 * 浏览器侧的桥接客户端：`POST /redteam/api`。
 *
 * ## 原实现的一个真实缺陷
 *
 * ```js
 * const api = (req) => fetch('/redteam/api', {...}).then(async (res) => {
 *   const text = await res.text().catch(() => '')
 *   ...
 * })
 * ```
 *
 * **`fetch` 本身没有 catch**。宿主重启、网络断开、请求被 CORS 预检拦掉时，
 * `fetch` 会 reject —— 而这个 reject 会沿着 Promise 链冒到每个调用点的
 * `.then(...)` 第二参数。原实现的调用点有两种写法：
 *
 * ```js
 * api({...}).then((r) => {...})              // 没有 onRejected → unhandled rejection
 * api({...}).then((r) => {...}, () => {...}) // 有
 * ```
 *
 * 前者占多数（如 `api({ op: 'activateEngagement' }).catch(() => {})` 有 catch，
 * 但 `api({ op: 'domains' }).then(...)` 只有一个参数）。未处理的 rejection
 * 在浏览器控制台里是一条红字，在 Electron 里可能触发 `unhandledRejection`
 * 处理器 —— 而且界面上的 loading 状态**永远不结束**。
 *
 * 这里统一成「**永不 reject**」：任何失败都变成 `{ ok: false, error, code }`，
 * 调用点只需要判 `ok`。这是桥接层的契约，与 Host 半侧的 `ApiErrorBody` 对齐。
 *
 * ## 错误分类透传
 *
 * Host 半侧现在返回 `code`（`unknown_op` / `cross_origin` / `body_too_large` …）。
 * 这里原样透传，调用点可据此分支，不必解析文案。
 */

import type { MinimalFetchResponse, FetchLike } from "./dom.js";

/** 桥接请求：op 必填，其余字段透传给资产库。 */
export interface ApiRequest {
  readonly op: string;
  readonly engagement?: string | undefined;
  readonly [field: string]: unknown;
}

/** 桥接响应：成功时是扁平的任意字段，失败时至少含 `error`。 */
export interface ApiResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly [field: string]: unknown;
}

/** 桥接端点。 */
export const API_PATH = "/redteam/api";

/** 客户端可用依赖（便于测试注入假 fetch）。 */
export interface ApiDeps {
  readonly fetch: FetchLike;
  /** 端点路径，默认 `/redteam/api`。 */
  readonly path?: string;
}

/**
 * 造一个 api 客户端。
 *
 * `deps` 注入而不是直接读全局 `fetch`：测试里可以喂任意响应，
 * 也不必在 Node 下伪造 `globalThis.fetch`。
 */
export function makeApi(deps: ApiDeps): (request: ApiRequest) => Promise<ApiResponse> {
  const path = deps.path ?? API_PATH;
  const fetchFn = deps.fetch;

  return async function api(request: ApiRequest): Promise<ApiResponse> {
    let response: MinimalFetchResponse;
    try {
      response = await fetchFn(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (cause) {
      // 网络层失败（宿主重启、断网、CORS 预检）：**不能 reject**，
      // 否则调用点的 loading 状态永远不会结束。
      return {
        ok: false,
        code: "network_error",
        error: "无法连接控制台后端：" + messageOfCause(cause),
      };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      return {
        ok: false,
        code: "read_error",
        error: "读取响应失败（" + String(response.status) + "）：" + messageOfCause(cause),
      };
    }

    // 空体：桥接层永远返回 JSON，空体说明不是我们的响应（代理拦截页之类）。
    if (text === "") {
      return {
        ok: false,
        code: response.ok ? "empty_response" : "http_error",
        error: response.status + " " + response.statusText + "（响应体为空）",
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 非 JSON：很可能是反向代理的错误页。截 120 字符便于定位，不刷屏。
      return {
        ok: false,
        code: "invalid_json",
        error: response.status + " non-json: " + text.slice(0, 120),
      };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        code: "invalid_shape",
        error: "响应不是 JSON 对象：" + text.slice(0, 120),
      };
    }

    const body = parsed as Record<string, unknown>;

    if (!response.ok) {
      // 非 2xx：Host 半侧的错误响应带 `error`；兜底用状态行。
      const hostError = body["error"];
      const hostMessage = body["message"];
      const message = typeof hostError === "string"
        ? hostError
        : typeof hostMessage === "string"
          ? hostMessage
          : response.status + " " + response.statusText;
      return {
        ...body,
        ok: false,
        code: typeof body["code"] === "string" ? body["code"] : "http_error",
        error: message,
      } as ApiResponse;
    }

    // 2xx：Host 半侧的成功响应是扁平的。`ok` 缺失说明它不是我们的契约，
    // 按成功处理（业务体里可能没有 ok 字段），但补上 `ok: true` 便于调用点判断。
    const ok = body["ok"];
    if (typeof ok === "boolean") return body as ApiResponse;
    return { ...body, ok: true };
  };
}

/** 从任意异常里取一段可读文案。 */
export function messageOfCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null) {
    const candidate = (cause as Record<string, unknown>)["message"];
    if (typeof candidate === "string") return candidate;
  }
  return String(cause);
}

/**
 * 常用 op 的薄包装：让调用点只写业务字段。
 *
 * 原实现的 48 处 `api({ op: 'x', engagement: eng, ... })` 手写了 op 名与
 * 靶标字段，打错 op 名只会在运行时收到 `unknown_op`。这里给出带类型的包装，
 * 至少让 `op` 名字面量有校验、`engagement` 不再手抄。
 */
export interface ApiClient {
  readonly raw: (request: ApiRequest) => Promise<ApiResponse>;
  /** 读快照（靶标全量）。 */
  snapshot(engagement: string): Promise<ApiResponse>;
  /** 资产列表（带过滤）。 */
  assets(engagement: string, filter?: Readonly<Record<string, unknown>>): Promise<ApiResponse>;
  /** 单个资产详情。 */
  asset(engagement: string, id: string | number): Promise<ApiResponse>;
  /** 漏洞列表。 */
  vulns(engagement: string, filter?: Readonly<Record<string, unknown>>): Promise<ApiResponse>;
  /** 会话/隧道/webshell 汇总。 */
  sessions(engagement: string): Promise<ApiResponse>;
  /** 攻击链。 */
  chain(engagement: string): Promise<ApiResponse>;
  /** 得分点。 */
  scores(engagement: string): Promise<ApiResponse>;
  /** 报告。 */
  report(engagement: string): Promise<ApiResponse>;
  /** 页签未读指针。 */
  consoleDigest(engagement: string): Promise<ApiResponse>;
  /** 证据截图字节。 */
  shotData(engagement: string, id: string | number): Promise<ApiResponse>;
  /** 切换当前靶标（服务端持久化指针）。 */
  activateEngagement(engagement: string): Promise<ApiResponse>;
}

/** 造带类型包装的客户端。 */
export function makeApiClient(deps: ApiDeps): ApiClient {
  const raw = makeApi(deps);
  return {
    raw,
    snapshot: (engagement) => raw({ op: "snapshot", engagement }),
    assets: (engagement, filter) => raw({ op: "assets", engagement, ...filter }),
    asset: (engagement, id) => raw({ op: "asset", engagement, id }),
    vulns: (engagement, filter) => raw({ op: "vulns", engagement, ...filter }),
    sessions: (engagement) => raw({ op: "sessions", engagement }),
    chain: (engagement) => raw({ op: "chain", engagement }),
    scores: (engagement) => raw({ op: "scores", engagement }),
    report: (engagement) => raw({ op: "report", engagement }),
    consoleDigest: (engagement) => raw({ op: "consoleDigest", engagement }),
    shotData: (engagement, id) => raw({ op: "shotData", engagement, id }),
    activateEngagement: (engagement) => raw({ op: "activateEngagement", engagement }),
  };
}
