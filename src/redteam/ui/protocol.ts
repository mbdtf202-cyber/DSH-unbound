/**
 * `POST /redteam/api` 的线上协议。
 *
 * ## 为什么单独一层
 *
 * 原 `lib/redteam/ui.js` 的桥接把「HTTP 状态码」「JSON 外形」「错误来源」
 * 三者混在一个 `catch` 里：未知 op 走 `throw new Error('unknown op: x')`，
 * 被最外层 catch 成 **400 + `{ok:false,error}`**，浏览器侧只能靠字符串前缀
 * 猜发生了什么。此处把错误**分类**成稳定的 `code`，状态码由分类派生，
 * 这样：未知 op 永远不会变成 500，客户端也不必解析人类可读文案。
 *
 * ## 兼容性
 *
 * 成功响应保持**扁平**（`{ ok: true, ...业务字段 }`）——原调用点有 44 处
 * 直接读 `r.items` / `r.stats`，包一层 `data` 会让整个浏览器半侧失效。
 * 错误响应只**增加**字段（`code` / `op` / `details`），不删除原有 `error`。
 */

/** 稳定的错误分类。客户端可据此分支，不依赖文案。 */
export type ApiErrorCode =
  /** 请求体里没有 op。 */
  | "missing_op"
  /** op 不在词汇表里。 */
  | "unknown_op"
  /** op 认识，但必填字段缺失或类型不对。 */
  | "invalid_payload"
  /** 请求体不是合法 JSON。 */
  | "invalid_json"
  /** 请求体超过 8 MiB。 */
  | "body_too_large"
  /** 非 POST。 */
  | "method_not_allowed"
  /** Origin/Host 不同源。 */
  | "cross_origin"
  /** 网关本地处理器抛错。 */
  | "handler_failed"
  /** 资产库转发失败。 */
  | "store_failed"
  /** 宿主没提供资产库服务。 */
  | "no_store";

/** 失败状态码只由分类派生，不手写。 */
export function statusOf(code: ApiErrorCode): number {
  switch (code) {
    case "method_not_allowed":
      return 405;
    case "cross_origin":
      return 403;
    case "body_too_large":
      return 413;
    case "unknown_op":
    case "missing_op":
    case "invalid_payload":
    case "invalid_json":
    case "handler_failed":
    case "store_failed":
    case "no_store":
      return 400;
  }
}

/**
 * 线上 JSON 对象。
 *
 * `ok` 是唯一稳定字段；其余由各 op 自行填充（原实现的平铺契约）。
 * 用 `Record<string, unknown>` 而不是 `any`：取值必须窄化。
 */
export interface ApiBody extends Readonly<Record<string, unknown>> {
  readonly ok: boolean;
}

/** 失败响应体。`error` 保留原文案形态，新增字段全部可选。 */
export interface ApiErrorBody extends Readonly<Record<string, unknown>> {
  readonly ok: false;
  readonly error: string;
  readonly code: ApiErrorCode;
  readonly op?: string;
  readonly details?: readonly string[];
}

/** 错误响应的可序列化内容（`details` 为空时不写，避免噪声）。 */
export function apiError(
  code: ApiErrorCode,
  message: string,
  extras: { readonly op?: string; readonly details?: readonly string[] } = {},
): ApiErrorBody {
  // `noPropertyAccessFromIndexSignature` 生效：动态键必须走下标访问。
  const body: Record<string, unknown> = { ok: false, error: message, code };
  if (extras.op !== undefined) body["op"] = extras.op;
  if (extras.details !== undefined && extras.details.length > 0) body["details"] = extras.details;
  return body as ApiErrorBody;
}

/**
 * 成功响应的**扁平**投影。
 *
 * 若处理器返回的不是对象（数组 / 字符串 / null），按原实现语义包成 `{ ok: true, value }`：
 * 否则 `Object.assign({ok:true}, data)` 会把数组拍成 `{0:..,1:..}`。
 */
export function apiOk(value: unknown): ApiBody {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    // 处理器自己带 `ok` 时以它为准：`{ok:false}` 也是合法的业务失败（HTTP 仍 200）。
    if (typeof record["ok"] === "boolean") return record as ApiBody;
    return { ok: true, ...record };
  }
  return { ok: true, value };
}
