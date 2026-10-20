/**
 * 请求体读取：8 MiB 上限，**流式截断**（不是先读满再检查）。
 *
 * ## 语义选择（为什么不是「事后检查」）
 *
 * 原 `ui.js` 是边收边累加，超限才 reject：
 * ```js
 * size += chunk.length
 * if (size > MAX_BODY_BYTES) { reject(...); req.destroy(err) }
 * chunks.push(chunk)     // ← 注意：这行在 reject 之后仍然执行
 * ```
 * 也就是说它已经在内存里留了「上限 + 最后一个 chunk」。对 8 MiB 的上限而言
 * 这不是灾难，但语义上仍是「先吃进来再不要」——攻击者只要不断发 chunk，
 * 每次一个新请求，峰值内存是 `N × (8 MiB + chunk)`，`N` 由并发连接数决定。
 *
 * 这里改成**先判后存**：算出 `size + chunk.length` 超限时，
 * 立刻丢弃该 chunk（不入数组）、停止累积、`destroy` 掉 socket，
 * 此后所有 `data` 事件一律直接 return。峰值就是 `MAX_BODY_BYTES` 本身。
 *
 * ## 为什么必须 `destroy(Error)`
 *
 * 只 `reject` 不 destroy，客户端会继续把 body 发完 —— 服务端已经不要了，
 * 但连接还在，白白占用一个 socket 与一条上游链路。带 Error 的 destroy
 * 会让 TCP 直接 RST，客户端立即知道「别发了」。
 *
 * ## 返回值形态
 *
 * 用 `Result` 而不是 throw：超限、连接错误都是**预期内**失败
 * （浏览器发大包、网络断开），不是编程错误。
 */

import { err, ok, type Result } from "../../shared/result.js";

/** 请求体上限（资产导入可能较大）。与原实现一致：8 MiB。 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 读取失败的原因。 */
export type BodyFailure =
  | { readonly kind: "too_large"; readonly limit: number; readonly observed: number }
  | { readonly kind: "stream_error"; readonly message: string };

/** 只依赖我们实际用到的那些成员，便于测试直接喂假对象。 */
export interface ReadableRequest {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (cause: Error) => void): unknown;
  destroy(cause?: Error): unknown;
}

/**
 * 读取请求体为 UTF-8 文本。
 *
 * `maxBytes` 默认 8 MiB；测试用小值直接验证截断路径，不必真的发 8 MiB。
 */
export function readBody(
  request: ReadableRequest,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Result<string, BodyFailure>> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (value: Result<string, BodyFailure>): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    request.on("data", (chunk: Buffer) => {
      // 已经结束（超限或出错）后到达的 chunk 一律丢弃，不再累积。
      if (settled) return;
      const next = size + chunk.length;
      if (next > maxBytes) {
        // 先判后存：这个 chunk **不入数组**，峰值就是 maxBytes。
        settle(err({ kind: "too_large", limit: maxBytes, observed: next }));
        // 带 Error destroy → socket RST，客户端立即停止发送。
        try {
          request.destroy(new Error("request body too large"));
        } catch {
          /* 已经断开时 destroy 可能抛；不影响结论 */
        }
        chunks.length = 0;
        return;
      }
      size = next;
      chunks.push(chunk);
    });

    request.on("end", () => {
      settle(ok(Buffer.concat(chunks).toString("utf8")));
    });

    request.on("error", (cause: Error) => {
      settle(err({ kind: "stream_error", message: messageOf(cause) }));
    });
  });
}

/** 从未知异常里取一段可读文案。 */
export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}
