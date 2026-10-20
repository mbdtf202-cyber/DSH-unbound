/**
 * HTTP 适配层：把 `bridge.ts` 的 `BridgeResponse` 写进真实的 `res`。
 *
 * 单独一层的理由：`bridge.ts` 是纯函数，可以穷举测试；只有这里碰 socket。
 * 换宿主（Node http / Electron / 测试用假 res）时只改这一处。
 */

import type { BridgeRequest, BridgeResponse, BridgePorts } from "./bridge.js";
import { handleRequest } from "./bridge.js";
import { MAX_BODY_BYTES } from "./body.js";

/**
 * 可写响应（`ServerResponse` 的子集）。
 *
 * `writeHead` 的 headers 用字符串键 + 数字/字符串值：Node 接受这两种。
 */
export interface WritableResponse {
  writeHead(status: number, headers: Readonly<Record<string, string | number>>): unknown;
  end(body: string): unknown;
}

/** 响应序列化：与原实现一致的四个头。 */
export function writeJsonResponse(response: WritableResponse, result: BridgeResponse): void {
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    // 这个接口的响应永远不该被缓存（含靶标数据、凭据、报告）。
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    // 明确禁止内容嗅探：响应体里可能有报表片段。
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

/**
 * 处理一次 HTTP 请求并写响应。
 *
 * 这是 `webServer.register({ path: '/redteam/api', handler })` 的 handler 本体。
 * 返回 `Promise<void>`：宿主不关心返回值，但我们等它写完再释放。
 */
export async function serveRequest(
  request: BridgeRequest,
  response: WritableResponse,
  ports: BridgePorts,
  maxBodyBytes: number = MAX_BODY_BYTES,
): Promise<void> {
  const result = await handleRequest(request, ports, maxBodyBytes);
  writeJsonResponse(response, result);
}
