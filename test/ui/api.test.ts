/**
 * 桥接客户端测试。
 *
 * 最关键的一组是「**永不 reject**」：原实现的 `fetch` 没有 catch，
 * 宿主重启 / 断网时 Promise 链会 reject，而多数调用点只写了
 * `.then((r) => ...)` 一个参数 → unhandled rejection + loading 永不结束。
 *
 * 这里逐个验证失败路径都变成 `{ok:false}` 而不是抛。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  API_PATH,
  makeApi,
  makeApiClient,
  messageOfCause,
  type ApiRequest,
  type ApiResponse,
} from "../../src/redteam/client/api.js";
import type { FetchLike, MinimalFetchInit, MinimalFetchResponse } from "../../src/redteam/client/dom.js";

/** 造一个可编程的假 fetch。 */
function fakeFetch(script: {
  readonly status?: number;
  readonly statusText?: string;
  readonly body?: string;
  readonly throws?: unknown;
  readonly textThrows?: unknown;
}): FetchLike & { readonly calls: { readonly input: string; readonly init: MinimalFetchInit }[] } {
  const calls: { readonly input: string; readonly init: MinimalFetchInit }[] = [];
  const fn = async (input: string, init: MinimalFetchInit): Promise<MinimalFetchResponse> => {
    calls.push({ input, init });
    if (script.throws !== undefined) throw script.throws;
    const status = script.status ?? 200;
    const response: MinimalFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      statusText: script.statusText ?? "OK",
      async text() {
        if (script.textThrows !== undefined) throw script.textThrows;
        return script.body ?? "";
      },
    };
    return response;
  };
  return Object.assign(fn, { calls });
}

/** 造一个客户端，默认端点。 */
function client(script: Parameters<typeof fakeFetch>[0]) {
  return makeApi({ fetch: fakeFetch(script) });
}

describe("API_PATH", () => {
  it("端点是 /redteam/api（与 Host 半侧注册路径一致）", () => {
    assert.equal(API_PATH, "/redteam/api");
  });
});

describe("成功路径", () => {
  it("返回扁平响应体", async () => {
    const api = client({ body: JSON.stringify({ ok: true, items: [1, 2], total: 2 }) });
    const result = await api({ op: "assets", engagement: "e1" });
    assert.equal(result.ok, true);
    assert.deepEqual(result["items"], [1, 2]);
    assert.equal(result["total"], 2);
  });

  it("请求是 POST + JSON 体", async () => {
    const fetchFn = fakeFetch({ body: JSON.stringify({ ok: true }) });
    const api = makeApi({ fetch: fetchFn });
    await api({ op: "snapshot", engagement: "e1" });
    const call = fetchFn.calls[0];
    assert.equal(call?.input, API_PATH);
    assert.equal(call?.init.method, "POST");
    assert.equal(call?.init.headers["content-type"], "application/json");
    assert.equal(call?.init.body, JSON.stringify({ op: "snapshot", engagement: "e1" }));
  });

  it("响应缺 ok 字段时补 ok:true（窄契约，业务体可能没有 ok）", async () => {
    const api = client({ body: JSON.stringify({ items: [] }) });
    const result = await api({ op: "assets" });
    assert.equal(result.ok, true);
  });

  it("响应自带 ok:false 时保持（2xx 里的业务失败）", async () => {
    const api = client({ body: JSON.stringify({ ok: false, error: "请先选靶标" }) });
    const result = await api({ op: "assets" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "请先选靶标");
  });

  it("自定义端点路径", async () => {
    const fetchFn = fakeFetch({ body: JSON.stringify({ ok: true }) });
    const api = makeApi({ fetch: fetchFn, path: "/custom/api" });
    await api({ op: "version" });
    assert.equal(fetchFn.calls[0]?.input, "/custom/api");
  });
});

describe("**永不 reject** —— 原实现的核心缺陷", () => {
  /**
   * 原实现：`fetch(...).then(async (res) => {...})` —— fetch 本身没有 catch。
   * 这里逐个失败路径确认：**返回 {ok:false}，不抛**。
   */
  it("fetch 抛错（宿主重启 / 断网）→ network_error，不 reject", async () => {
    const api = client({ throws: new TypeError("Failed to fetch") });
    const result = await api({ op: "snapshot" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "network_error");
    assert.match(String(result.error), /Failed to fetch/);
  });

  it("fetch 抛非 Error（字符串）也不 reject", async () => {
    const api = client({ throws: "weird throw" });
    const result = await api({ op: "snapshot" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "network_error");
  });

  it("读响应体失败 → read_error，不 reject", async () => {
    const api = client({ textThrows: new Error("stream closed") });
    const result = await api({ op: "snapshot" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "read_error");
  });

  it("**任何**失败路径都不产生 rejection（穷举）", async () => {
    const scripts: Parameters<typeof fakeFetch>[0][] = [
      { throws: new Error("net") },
      { throws: "str" },
      { textThrows: new Error("stream") },
      { status: 404, statusText: "Not Found", body: "" },
      { status: 500, statusText: "Server Error", body: "not json" },
      { status: 200, body: "" },
      { status: 200, body: "not json" },
      { status: 200, body: "[]" },
      { status: 200, body: "null" },
      { status: 403, body: JSON.stringify({ ok: false, error: "cross-origin", code: "cross_origin" }) },
    ];
    for (const [index, script] of scripts.entries()) {
      const api = client(script);
      // 如果用 .then 单参数写法且真 reject 了，这里会变成 unhandled。
      // 我们直接 await —— reject 会以 reject 形式抛出并被 catch 到。
      const result = await api({ op: "snapshot" }).then(
        (value) => value,
        (cause: unknown) => ({ ok: "REJECTED" as unknown as boolean, cause }),
      );
      assert.equal(result.ok, false, `第 ${index} 个脚本应返回 ok:false，实际 ${String(result.ok)}`);
    }
  });
});

describe("HTTP 错误", () => {
  it("403 使用 Host 半侧的 error 与 code", async () => {
    const api = client({
      status: 403,
      statusText: "Forbidden",
      body: JSON.stringify({ ok: false, error: "cross-origin request rejected", code: "cross_origin" }),
    });
    const result = await api({ op: "snapshot" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "cross-origin request rejected");
    assert.equal(result.code, "cross_origin");
  });

  it("403 无 error 字段时回退到 message", async () => {
    const api = client({ status: 400, statusText: "Bad Request", body: JSON.stringify({ message: "bad" }) });
    const result = await api({ op: "snapshot" });
    assert.equal(result.error, "bad");
  });

  it("错误体无 error/message 时用状态行", async () => {
    const api = client({ status: 500, statusText: "Internal Server Error", body: JSON.stringify({}) });
    const result = await api({ op: "snapshot" });
    assert.equal(result.error, "500 Internal Server Error");
  });

  it("保留错误体里的其它字段（details / op）", async () => {
    const api = client({
      status: 400,
      body: JSON.stringify({ ok: false, error: "e", code: "invalid_payload", details: ["name"], op: "openEngagement" }),
    });
    const result = await api({ op: "openEngagement" });
    assert.deepEqual(result["details"], ["name"]);
    assert.equal(result["op"], "openEngagement");
  });

  it("错误体缺 code 时补 http_error", async () => {
    const api = client({ status: 502, body: JSON.stringify({ error: "bad gateway" }) });
    const result = await api({ op: "snapshot" });
    assert.equal(result.code, "http_error");
  });
});

describe("非 JSON / 空体 / 形状异常", () => {
  it("空体 + 2xx → empty_response", async () => {
    const api = client({ status: 200, body: "" });
    const result = await api({ op: "snapshot" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "empty_response");
  });

  it("空体 + 非 2xx → http_error", async () => {
    const api = client({ status: 404, statusText: "Not Found", body: "" });
    const result = await api({ op: "snapshot" });
    assert.equal(result.code, "http_error");
    assert.match(String(result.error), /404/);
  });

  it("非 JSON（反代错误页）→ invalid_json，且截断到 120 字符", async () => {
    const longHtml = "<html>" + "x".repeat(500) + "</html>";
    const api = client({ status: 502, body: longHtml });
    const result = await api({ op: "snapshot" });
    assert.equal(result.code, "invalid_json");
    const errorText = String(result.error);
    assert.ok(errorText.length < 160, "错误文案应截断");
    assert.match(errorText, /non-json/);
  });

  it("JSON 数组 → invalid_shape（不是我们的契约）", async () => {
    const api = client({ body: "[1,2,3]" });
    const result = await api({ op: "snapshot" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_shape");
  });

  it("JSON null → invalid_shape", async () => {
    const api = client({ body: "null" });
    const result = await api({ op: "snapshot" });
    assert.equal(result.code, "invalid_shape");
  });

  it("JSON 字符串 → invalid_shape", async () => {
    const api = client({ body: '"text"' });
    const result = await api({ op: "snapshot" });
    assert.equal(result.code, "invalid_shape");
  });
});

describe("messageOfCause", () => {
  it("Error 取 message", () => {
    assert.equal(messageOfCause(new Error("x")), "x");
  });

  it("字符串原样", () => {
    assert.equal(messageOfCause("y"), "y");
  });

  it("带 message 的对象取 message", () => {
    assert.equal(messageOfCause({ message: "z" }), "z");
  });

  it("其余 String() 化", () => {
    assert.equal(messageOfCause(42), "42");
  });
});

describe("makeApiClient — 薄包装", () => {
  /** 记录发出的请求。 */
  function recorder(): { readonly client: ReturnType<typeof makeApiClient>; readonly sent: ApiRequest[] } {
    const sent: ApiRequest[] = [];
    const fetchFn: FetchLike = async (_input, init) => {
      sent.push(JSON.parse(init.body) as ApiRequest);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ ok: true }),
      };
    };
    return { client: makeApiClient({ fetch: fetchFn }), sent };
  }

  it("snapshot 带 op + engagement", async () => {
    const { client: api, sent } = recorder();
    await api.snapshot("e1");
    assert.deepEqual(sent[0], { op: "snapshot", engagement: "e1" });
  });

  it("assets 透传过滤条件", async () => {
    const { client: api, sent } = recorder();
    await api.assets("e1", { cidr: "10.0.0.0/24", limit: 400 });
    assert.deepEqual(sent[0], { op: "assets", engagement: "e1", cidr: "10.0.0.0/24", limit: 400 });
  });

  it("asset 带 id", async () => {
    const { client: api, sent } = recorder();
    await api.asset("e1", 7);
    assert.deepEqual(sent[0], { op: "asset", engagement: "e1", id: 7 });
  });

  it("vulns / sessions / chain / scores / report / consoleDigest 各自 op 正确", async () => {
    const { client: api, sent } = recorder();
    await api.vulns("e1");
    await api.sessions("e1");
    await api.chain("e1");
    await api.scores("e1");
    await api.report("e1");
    await api.consoleDigest("e1");
    assert.deepEqual(sent.map((request) => request.op), [
      "vulns", "sessions", "chain", "scores", "report", "consoleDigest",
    ]);
  });

  it("shotData 带 id", async () => {
    const { client: api, sent } = recorder();
    await api.shotData("e1", "s3");
    assert.deepEqual(sent[0], { op: "shotData", engagement: "e1", id: "s3" });
  });

  it("activateEngagement 是**自己带 engagement** 的写操作", async () => {
    const { client: api, sent } = recorder();
    await api.activateEngagement("e2");
    assert.deepEqual(sent[0], { op: "activateEngagement", engagement: "e2" });
  });

  it("raw 可发任意 op（网关 op 用）", async () => {
    const { client: api, sent } = recorder();
    await api.raw({ op: "version" });
    assert.deepEqual(sent[0], { op: "version" });
  });

  it("所有包装方法都返回 ApiResponse（不抛）", async () => {
    const { client: api } = recorder();
    const results: ApiResponse[] = [
      await api.snapshot("e"),
      await api.assets("e"),
      await api.asset("e", 1),
      await api.vulns("e"),
      await api.sessions("e"),
      await api.chain("e"),
      await api.scores("e"),
      await api.report("e"),
      await api.consoleDigest("e"),
      await api.shotData("e", 1),
      await api.activateEngagement("e"),
    ];
    for (const result of results) {
      assert.equal(typeof result.ok, "boolean");
    }
  });
});
