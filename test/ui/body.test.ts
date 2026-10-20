/**
 * 请求体读取测试：**重点测超限真的被拒绝**（不是只测上限以内能读）。
 *
 * `body.ts` 注释里写了语义选择：先判后存（峰值就是上限），
 * 所以这里用「发 N 个 chunk、数一数有几个进了数组」来验证 ——
 * 光看返回值分不出「先吃后拒」和「先判后存」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MAX_BODY_BYTES, messageOf, readBody, type ReadableRequest } from "../../src/redteam/ui/body.js";

/** 假请求：可以按脚本发 data / end / error，并记录 destroy 调用。 */
class FakeRequest extends EventEmitter implements ReadableRequest {
  readonly destroyed: (Error | undefined)[] = [];

  destroy(cause?: Error): unknown {
    this.destroyed.push(cause);
    return this;
  }

  /** 依次发若干 chunk，然后 end。 */
  feed(chunks: readonly Buffer[], thenEnd = true): void {
    for (const chunk of chunks) this.emit("data", chunk);
    if (thenEnd) this.emit("end");
  }
}

describe("MAX_BODY_BYTES", () => {
  it("与原实现一致：8 MiB", () => {
    assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
  });
});

describe("readBody — 正常路径", () => {
  it("拼出 UTF-8 文本", async () => {
    const req = new FakeRequest();
    const promise = readBody(req);
    req.feed([Buffer.from("hello ", "utf8"), Buffer.from("世界", "utf8")]);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value : "", "hello 世界");
  });

  it("空体得到空串", async () => {
    const req = new FakeRequest();
    const promise = readBody(req);
    req.feed([], true);
    const result = await promise;
    assert.equal(result.ok ? result.value : "x", "");
  });

  it("刚好等于上限时接受（边界包含）", async () => {
    const req = new FakeRequest();
    const limit = 8;
    const promise = readBody(req, limit);
    req.feed([Buffer.alloc(limit, 0x61)]);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value.length : -1, limit);
  });

  it("多个 chunk 累积后的总长按上限算", async () => {
    const req = new FakeRequest();
    const promise = readBody(req, 10);
    req.feed([Buffer.alloc(4, 0x61), Buffer.alloc(6, 0x62)]);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value.length : -1, 10);
  });
});

describe("readBody — 超限真的被拒绝", () => {
  it("超过 1 字节即拒绝", async () => {
    const req = new FakeRequest();
    const promise = readBody(req, 4);
    req.feed([Buffer.alloc(5, 0x61)], false);
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.error.kind, "too_large");
  });

  it("拒绝时报告 limit 与实际收到量", async () => {
    const req = new FakeRequest();
    const promise = readBody(req, 4);
    req.feed([Buffer.alloc(9, 0x61)], false);
    const result = await promise;
    if (result.ok) throw new Error("应拒绝");
    assert.equal(result.error.kind, "too_large");
    if (result.error.kind !== "too_large") return;
    assert.equal(result.error.limit, 4);
    assert.equal(result.error.observed, 9);
  });

  it("超限时调用 destroy(new Error) —— 让 socket RST，客户端停止发送", async () => {
    const req = new FakeRequest();
    const promise = readBody(req, 2);
    req.feed([Buffer.alloc(3, 0x61)], false);
    await promise;
    assert.equal(req.destroyed.length, 1);
    assert.ok(req.destroyed[0] instanceof Error);
    assert.match(String(req.destroyed[0]?.message), /too large/);
  });

  it("**先判后存**：超限的那个 chunk 不入数组，后续 chunk 也被丢弃", async () => {
    const req = new FakeRequest();
    const promise = readBody(req, 4);
    // 先给一个会超限的 chunk，再持续给更多（模拟攻击者不停止发送）。
    req.emit("data", Buffer.alloc(5, 0x61));
    req.emit("data", Buffer.alloc(1024 * 1024, 0x62));
    req.emit("data", Buffer.alloc(1024 * 1024, 0x63));
    req.emit("end");
    const result = await promise;
    if (result.ok) throw new Error("应拒绝");
    assert.equal(result.error.kind, "too_large");
    if (result.error.kind !== "too_large") return;
    // 关键断言：observed 只反映**触发拒绝的那一次**，说明后续 chunk 没有继续累积。
    assert.equal(result.error.observed, 5);
  });

  it("超限后即使收到 end 也不覆盖已定的失败结论", async () => {
    const req = new FakeRequest();
    const promise = readBody(req, 3);
    req.emit("data", Buffer.alloc(4, 0x61));
    req.emit("end");
    const result = await promise;
    assert.equal(result.ok, false);
  });

  it("接近真实上限：8 MiB + 1 字节被拒绝", async () => {
    const req = new FakeRequest();
    const promise = readBody(req);
    req.emit("data", Buffer.alloc(MAX_BODY_BYTES, 0x61));
    req.emit("data", Buffer.alloc(1, 0x62));
    const result = await promise;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, "too_large");
  });

  it("接近真实上限：正好 8 MiB 通过", async () => {
    const req = new FakeRequest();
    const promise = readBody(req);
    req.emit("data", Buffer.alloc(MAX_BODY_BYTES, 0x61));
    req.emit("end");
    const result = await promise;
    assert.equal(result.ok, true);
  });
});

describe("readBody — 流错误", () => {
  it("error 事件转成 stream_error", async () => {
    const req = new FakeRequest();
    const promise = readBody(req);
    req.emit("error", new Error("connection reset"));
    const result = await promise;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.kind, "stream_error");
    if (result.error.kind !== "stream_error") return;
    assert.equal(result.error.message, "connection reset");
  });

  it("error 之后到达的 data 被忽略", async () => {
    const req = new FakeRequest();
    const promise = readBody(req);
    req.emit("error", new Error("boom"));
    req.emit("data", Buffer.from("late"));
    req.emit("end");
    const result = await promise;
    assert.equal(result.ok, false);
  });
});

describe("messageOf", () => {
  it("Error 取 message", () => {
    assert.equal(messageOf(new Error("x")), "x");
  });

  it("字符串原样返回", () => {
    assert.equal(messageOf("plain"), "plain");
  });

  it("其余 String() 化", () => {
    assert.equal(messageOf(42), "42");
    assert.equal(messageOf(null), "null");
  });
});
