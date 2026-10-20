/**
 * `/redteam/api` 的请求处理管线。
 *
 * ## 管线
 *
 * ```
 * POST?              → 405
 * Origin/Host 同源?  → 403
 * 读 body（8 MiB）   → 413 / 400
 * JSON 解析          → 400
 * parseRequest       → 400（missing_op / unknown_op / invalid_payload）
 * handleGateway      → 本地 9 个 op
 * store 转发         → 其余 71 个 op
 * ```
 *
 * 每一层都产出**结构化错误码**（`ApiErrorCode`），状态码由分类派生，
 * 不在各处手写数字。原实现的未知 op 会因为 store 抛 `unknown op: x`
 * 而被外层 catch 成 400 —— 结果对，但原因是「碰巧」，无法区分
 * 「op 不存在」和「op 存在但炸了」。这里在进门处就把两者分开。
 *
 * ## 为什么不自己处理 `res`
 *
 * `bridge.ts` 只产出 `{ status, body }`，写响应交给 `server.ts`。
 * 这样整条管线是**纯函数**：喂请求描述、拿响应描述，不需要真 socket。
 */

import { messageOf, readBody, type ReadableRequest } from "./body.js";
import { handleGateway, type GatewayPorts } from "./gateway.js";
import { fieldString } from "./ops.js";
import { parseRequest } from "./ops.js";
import { checkOrigin, readOriginFacts, type OriginDecision } from "./origin.js";
import { apiError, apiOk, statusOf, type ApiBody, type ApiErrorBody } from "./protocol.js";

/** 转发给资产库的端口。资产库不在本域，只声明这里用到的形状。 */
export interface StorePort {
  /**
   * 执行一个 op。
   *
   * 资产库**同步为主、`probeSessions` 异步**（要真实发 TCP/HTTP 连接），
   * 所以统一 `Promise`，同步实现直接 `return`。
   */
  dispatch(request: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** 桥接所需的全部外部能力。 */
export interface BridgePorts {
  readonly gateway: GatewayPorts;
  readonly store: StorePort;
}

/** 最小请求形状（`IncomingMessage` 的子集）。 */
export interface BridgeRequest extends ReadableRequest {
  readonly method?: string | null;
  readonly socket?: { readonly remoteAddress?: string | null } | null;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | null;
}

/** 响应描述：状态码 + JSON 体。 */
export interface BridgeResponse {
  readonly status: number;
  readonly body: ApiBody | ApiErrorBody;
}

/** 便捷构造：由错误码派生状态码。 */
function fail(
  code: Parameters<typeof apiError>[0],
  message: string,
  extras: { readonly op?: string; readonly details?: readonly string[] } = {},
): BridgeResponse {
  return { status: statusOf(code), body: apiError(code, message, extras) };
}

/**
 * 处理一次请求。
 *
 * 不抛异常：所有预期内失败都变成 `BridgeResponse`。
 * 唯一可能抛的是端口实现的编程错误，那属于 bug，应当暴露。
 */
export async function handleRequest(
  request: BridgeRequest,
  ports: BridgePorts,
  maxBodyBytes?: number,
): Promise<BridgeResponse> {
  // ① 方法：只接受 POST。
  if (request.method !== "POST") {
    return fail("method_not_allowed", "POST only");
  }

  // ② 同源：回环放行，非回环严格比对（详见 origin.ts 的两个事故注释）。
  const decision: OriginDecision = checkOrigin(readOriginFacts(request));
  if (!decision.allow) {
    return fail("cross_origin", "cross-origin request rejected", { details: [decision.reason] });
  }

  // ③ 读体：流式截断，超限时 body 根本没进内存。
  const body = await readBody(request, maxBodyBytes);
  if (!body.ok) {
    if (body.error.kind === "too_large") {
      return fail(
        "body_too_large",
        `request body too large: limit ${body.error.limit} bytes, got at least ${body.error.observed}`,
      );
    }
    return fail("handler_failed", "read request body failed: " + body.error.message);
  }

  // ④ JSON：空体当 `{}`（原实现语义：`raw.trim() ? JSON.parse(raw) : {}`）。
  const rawText = body.value.trim();
  let parsedJson: unknown = {};
  if (rawText !== "") {
    try {
      parsedJson = JSON.parse(rawText);
    } catch (cause) {
      return fail("invalid_json", "request body is not valid JSON: " + messageOf(cause));
    }
  }

  // ⑤ 词汇表 + 载荷校验。
  const parsed = parseRequest(parsedJson);
  if (!parsed.ok) {
    return fail(parsed.error.code, parsed.error.message, {
      ...(parsed.error.op !== undefined ? { op: parsed.error.op } : {}),
      details: parsed.error.details,
    });
  }
  const op = parsed.value.op;

  // ⑥ 网关本地 op。
  if (parsed.value.kind === "gateway") {
    try {
      const result = await handleGateway(parsed.value, ports.gateway);
      if (result === null) {
        // 表里说是 gateway，网关却不认 —— 表与实现漂移，属于 bug。
        return fail("unknown_op", `unknown op: ${op}`, { op });
      }
      return { status: 200, body: result };
    } catch (cause) {
      return fail("handler_failed", `${op} failed: ${messageOf(cause)}`, { op });
    }
  }

  // ⑦ 转发资产库。
  try {
    const result = await ports.store.dispatch(parsed.value.raw);
    return { status: 200, body: apiOk(result) };
  } catch (cause) {
    // 资产库不该抛（它的 dispatch 内部已 catch 成 `{ok:false,error}`）；
    // 真抛了说明是编程错误或服务未就绪。
    return fail("store_failed", `${op} failed: ${messageOf(cause)}`, { op });
  }
}

/**
 * 读一个已声明的字符串字段并去空白（转发前做轻量归一，避免空串混入）。
 *
 * `null` 表示「没有这个字段」或「只有空白」——两者对下游等价。
 */
export function normalizeStringField(
  request: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = request[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 供测试与诊断：读 op 名（**不校验**词汇表）。 */
export function peekOp(request: Readonly<Record<string, unknown>>): string | null {
  const value = request["op"];
  return typeof value === "string" ? value : null;
}
