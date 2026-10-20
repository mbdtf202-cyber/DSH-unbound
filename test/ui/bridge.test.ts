/**
 * 桥接管线测试：真喂 `EventEmitter` 当请求，拿 `{status, body}` 断言。
 *
 * 覆盖 lead 要求的三项：op 分派（每大类至少一个）、未知 op、跨源拒绝，
 * 外加管线其余层（方法、JSON、体积、网关异常、资产库异常）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleRequest, normalizeStringField, peekOp, type BridgePorts, type BridgeRequest } from "../../src/redteam/ui/bridge.js";
import type { GatewayPorts } from "../../src/redteam/ui/gateway.js";
import type { ApiBody } from "../../src/redteam/ui/protocol.js";

/** 假请求：可配置 method / socket / headers，body 按 chunk 脚本发送。 */
class FakeRequest extends EventEmitter implements BridgeRequest {
  readonly destroyed: (Error | undefined)[] = [];

  constructor(
    private readonly config: {
      readonly method?: string;
      readonly remoteAddress?: string;
      readonly host?: string;
      readonly origin?: string;
      readonly body?: string;
    },
  ) {
    super();
  }

  get method(): string {
    return this.config["method"] ?? "POST";
  }

  get socket(): { readonly remoteAddress?: string } {
    return { remoteAddress: this.config["remoteAddress"] ?? "127.0.0.1" };
  }

  get headers(): Readonly<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = {};
    if (this.config["host"] !== undefined) out["host"] = this.config["host"];
    if (this.config["origin"] !== undefined) out["origin"] = this.config["origin"];
    return out;
  }

  destroy(cause?: Error): unknown {
    this.destroyed.push(cause);
    return this;
  }

  /** 在下一 tick 发 body（必须在 handler 挂上监听之后）。 */
  scheduleBody(): void {
    const body = this.config["body"] ?? "";
    queueMicrotask(() => {
      if (body !== "") this.emit("data", Buffer.from(body, "utf8"));
      this.emit("end");
    });
  }
}

/** 记录调用的假资产库。 */
function fakeStore(): BridgePorts["store"] & {
  readonly calls: (Readonly<Record<string, unknown>>)[];
  next: unknown;
  shouldThrow: Error | null;
} {
  const calls: (Readonly<Record<string, unknown>>)[] = [];
  const state: {
    calls: (Readonly<Record<string, unknown>>)[];
    next: unknown;
    shouldThrow: Error | null;
    dispatch(req: Readonly<Record<string, unknown>>): Promise<unknown>;
  } = {
    calls,
    next: { ok: true, items: [] },
    shouldThrow: null,
    async dispatch(req) {
      calls.push(req);
      if (state.shouldThrow !== null) throw state.shouldThrow;
      return state.next;
    },
  };
  return state;
}

/** 最小网关端口：默认全返回固定值，测试按需覆盖。 */
function fakeGateway(overrides: Partial<GatewayPorts> = {}): GatewayPorts {
  const base: GatewayPorts = {
    storeRoot: "/tmp/rt",
    maxAgents: () => 3,
    saveMaxAgents: (value) => value,
    maxAgentsSource: () => "default",
    maxAgentsLimit: 10,
    defaultMaxAgents: 3,
    subagents: null,
    sessions: null,
    envAdaptStatus: () => ({ ok: true, ready: true, reason: "kali" }),
    envAdaptSkip: () => ({ ok: true, skipped: true }),
    pluginIdentity: () => ({ name: "dsh-unbound", version: "0.1.0", description: "", homepage: null }),
    updatePreflight: async () => ({
      install: { mode: "package" },
      blockers: [],
      notes: [],
      runningAgents: [],
    }),
    checkLatest: async () => ({ ok: true, latest: "0.2.0" }),
    applyUpdate: async () => ({ ok: true, restart: { log: "/tmp/log" } }),
    versionIsNewer: (remote, local) => remote > local,
    skillService: null,
    presetService: null,
    skillFallback: async () => ({ ok: true, fromFallback: true }),
    ...overrides,
  };
  return base;
}

/** 发一次请求，拿到响应。 */
async function call(
  config: ConstructorParameters<typeof FakeRequest>[0],
  ports: BridgePorts,
  maxBodyBytes?: number,
): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> }> {
  const request = new FakeRequest(config);
  const promise = handleRequest(request, ports, maxBodyBytes);
  request.scheduleBody();
  const response = await promise;
  return { status: response.status, body: response.body as Readonly<Record<string, unknown>> };
}

/** 标准端口。 */
function ports(overrides: { gateway?: Partial<GatewayPorts> } = {}): BridgePorts & {
  readonly store: ReturnType<typeof fakeStore>;
} {
  return { gateway: fakeGateway(overrides.gateway), store: fakeStore() };
}

describe("管线 ①：方法", () => {
  it("非 POST → 405 + method_not_allowed", async () => {
    const result = await call({ method: "GET" }, ports());
    assert.equal(result.status, 405);
    assert.equal(result.body["code"], "method_not_allowed");
  });

  it("PUT / DELETE 同样 405", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const result = await call({ method }, ports());
      assert.equal(result.status, 405, `${method} 应 405`);
    }
  });
});

describe("管线 ②：跨源拒绝", () => {
  it("外部 Origin + 外部 Host → 403 cross_origin", async () => {
    const result = await call(
      { remoteAddress: "203.0.113.9", host: "dsh.example.com", origin: "https://evil.example", body: '{"op":"bootstrap"}' },
      ports(),
    );
    assert.equal(result.status, 403);
    assert.equal(result.body["code"], "cross_origin");
  });

  it("拒绝时附带分支 reason（便于运维定位）", async () => {
    const result = await call(
      { remoteAddress: "203.0.113.9", host: "dsh.example.com", origin: "https://evil.example" },
      ports(),
    );
    assert.deepEqual(result.body["details"], ["host-mismatch"]);
  });

  it("非本机 Host + 缺 Origin → 403 missing-origin", async () => {
    const result = await call({ remoteAddress: "203.0.113.9", host: "dsh.example.com" }, ports());
    assert.equal(result.status, 403);
    assert.deepEqual(result.body["details"], ["missing-origin"]);
  });

  it("本机回环放行（桌面端形态）", async () => {
    const result = await call(
      { remoteAddress: "127.0.0.1", host: "127.0.0.1:3000", body: '{"op":"bootstrap"}' },
      ports(),
    );
    assert.equal(result.status, 200);
  });

  it("本机 Host + app:// 放行", async () => {
    const result = await call(
      { remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "app://dsh", body: '{"op":"bootstrap"}' },
      ports(),
    );
    assert.equal(result.status, 200);
  });

  it("同源严格匹配放行", async () => {
    const result = await call(
      { remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "https://dsh.example.com", body: '{"op":"bootstrap"}' },
      ports(),
    );
    assert.equal(result.status, 200);
  });

  it("跨源请求**不会**触达资产库（拒绝发生在最前）", async () => {
    const p = ports();
    await call({ remoteAddress: "203.0.113.9", host: "h.example", origin: "https://evil.example", body: '{"op":"bootstrap"}' }, p);
    assert.equal(p.store.calls.length, 0);
  });
});

describe("管线 ③：请求体", () => {
  it("超限 → 413 body_too_large", async () => {
    const result = await call({ body: "x".repeat(100) }, ports(), 10);
    assert.equal(result.status, 413);
    assert.equal(result.body["code"], "body_too_large");
  });

  it("超限时不触达资产库", async () => {
    const p = ports();
    await call({ body: JSON.stringify({ op: "bootstrap", pad: "x".repeat(200) }) }, p, 20);
    assert.equal(p.store.calls.length, 0);
  });

  it("非法 JSON → 400 invalid_json", async () => {
    const result = await call({ body: "{not json" }, ports());
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "invalid_json");
  });

  it("空体当作 {} → missing_op", async () => {
    const result = await call({ body: "   " }, ports());
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "missing_op");
  });
});

describe("管线 ④：op 分派 —— 每个大类至少一个", () => {
  /** 走资产库的一个 op，断言真的转发且保留原始字段。 */
  async function expectStore(
    body: Readonly<Record<string, unknown>>,
    opName: string,
  ): Promise<void> {
    const p = ports();
    const result = await call({ body: JSON.stringify(body) }, p);
    assert.equal(result.status, 200, `${opName} 应 200，实际 ${result.status}`);
    assert.equal(p.store.calls.length, 1, `${opName} 应转发一次`);
    assert.equal(p.store.calls[0]?.["op"], opName);
  }

  it("靶标生命周期：bootstrap", async () => {
    await expectStore({ op: "bootstrap" }, "bootstrap");
  });

  it("靶标生命周期：openEngagement（必填 name）", async () => {
    await expectStore({ op: "openEngagement", name: "示例" }, "openEngagement");
  });

  it("知识库：pocSearch", async () => {
    await expectStore({ op: "pocSearch", q: "shiro" }, "pocSearch");
  });

  it("知识库：pocSave", async () => {
    await expectStore({ op: "pocSave", poc: { name: "x" } }, "pocSave");
  });

  it("资产测绘：assets（带过滤条件）", async () => {
    await expectStore({ op: "assets", engagement: "e1", limit: 400, sort: "priority" }, "assets");
  });

  it("资产测绘：graph", async () => {
    await expectStore({ op: "graph", engagement: "e1" }, "graph");
  });

  it("漏洞：vulns", async () => {
    await expectStore({ op: "vulns", engagement: "e1", severity: "high" }, "vulns");
  });

  it("漏洞：addVuln（载荷是对象）", async () => {
    await expectStore({ op: "addVuln", engagement: "e1", vuln: { title: "t" } }, "addVuln");
  });

  it("凭据：addCredential", async () => {
    await expectStore({ op: "addCredential", engagement: "e1", credential: { user: "a" } }, "addCredential");
  });

  it("会话隧道：sessions / webshells / tunnels", async () => {
    await expectStore({ op: "sessions", engagement: "e1" }, "sessions");
    await expectStore({ op: "webshells", engagement: "e1" }, "webshells");
    await expectStore({ op: "tunnels", engagement: "e1" }, "tunnels");
  });

  it("证据：shotData（读截图字节）", async () => {
    await expectStore({ op: "shotData", engagement: "e1", id: 3 }, "shotData");
  });

  it("攻击链：addChainStep", async () => {
    await expectStore({ op: "addChainStep", engagement: "e1", step: { stage_code: "recon" } }, "addChainStep");
  });

  it("得分：saveScorePoint / addScoreHit", async () => {
    await expectStore({ op: "saveScorePoint", engagement: "e1", point: { code: "x" } }, "saveScorePoint");
    await expectStore({ op: "addScoreHit", engagement: "e1", hit: { code: "y" } }, "addScoreHit");
  });

  it("报告：report / reportTargets", async () => {
    await expectStore({ op: "report", engagement: "e1" }, "report");
    await expectStore({ op: "reportTargets", engagement: "e1" }, "reportTargets");
  });

  it("攻击文件：readAttackFile", async () => {
    await expectStore({ op: "readAttackFile", engagement: "e1", id: 1 }, "readAttackFile");
  });

  it("提示词：savePrompt（必填 role + content）", async () => {
    await expectStore({ op: "savePrompt", engagement: "e1", role: "recon", content: "x" }, "savePrompt");
  });

  it("异步唯一：probeSessions（宿主侧真实探测）", async () => {
    await expectStore({ op: "probeSessions", engagement: "e1" }, "probeSessions");
  });

  it("平台配置（store 份）：platformAssignToolkit", async () => {
    await expectStore({ op: "platformAssignToolkit", dir: "/opt/tools" }, "platformAssignToolkit");
  });

  it("网关本地：version 不走资产库", async () => {
    const p = ports();
    const result = await call({ body: '{"op":"version"}' }, p);
    assert.equal(result.status, 200);
    assert.equal(p.store.calls.length, 0, "网关 op 不该转发");
    assert.equal(result.body["ok"], true);
  });

  it("网关本地：platformEnvAdaptStatus", async () => {
    const p = ports();
    const result = await call({ body: '{"op":"platformEnvAdaptStatus"}' }, p);
    assert.equal(result.body["ready"], true);
    assert.equal(p.store.calls.length, 0);
  });

  it("网关本地：skillCatalog（无 skills 服务时走兜底）", async () => {
    const p = ports();
    const result = await call({ body: '{"op":"skillCatalog"}' }, p);
    assert.equal(result.body["fromFallback"], true);
    assert.equal(p.store.calls.length, 0);
  });

  it("网关本地：setAgentsMax 保存并回报", async () => {
    const p = ports({ gateway: { saveMaxAgents: () => 5 } });
    const result = await call({ body: '{"op":"setAgentsMax","max":5}' }, p);
    assert.equal(result.body["max"], 5);
    assert.equal(result.body["source"], "settings");
  });
});

describe("管线 ⑤：未知 op 必须结构化", () => {
  it("未知 op → 400 unknown_op（不是 500）", async () => {
    const result = await call({ body: '{"op":"notARealOp"}' }, ports());
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "unknown_op");
    assert.equal(result.body["op"], "notARealOp");
  });

  it("未知 op 不触达资产库", async () => {
    const p = ports();
    await call({ body: '{"op":"nope"}' }, p);
    assert.equal(p.store.calls.length, 0);
  });

  it("缺 op → 400 missing_op", async () => {
    const result = await call({ body: "{}" }, ports());
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "missing_op");
  });

  it("载荷不合法 → 400 invalid_payload，并带 details", async () => {
    const result = await call({ body: '{"op":"openEngagement"}' }, ports());
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "invalid_payload");
    assert.ok(Array.isArray(result.body["details"]));
  });

  it("错误响应都带人类可读 error（兼容旧客户端）", async () => {
    for (const body of ['{"op":"nope"}', "{}", '{"op":"openEngagement"}']) {
      const result = await call({ body }, ports());
      assert.equal(typeof result.body["error"], "string");
      assert.equal(result.body["ok"], false);
    }
  });
});

describe("管线 ⑥：故障隔离", () => {
  it("资产库抛错 → 400 store_failed（不冒泡成 500）", async () => {
    const p = ports();
    p.store.shouldThrow = new Error("sqlite locked");
    const result = await call({ body: '{"op":"bootstrap"}' }, p);
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "store_failed");
    assert.match(String(result.body["error"]), /sqlite locked/);
  });

  it("网关抛错 → 400 handler_failed", async () => {
    const p = ports({
      gateway: {
        envAdaptStatus: () => {
          throw new Error("platform config unreadable");
        },
      },
    });
    const result = await call({ body: '{"op":"platformEnvAdaptStatus"}' }, p);
    assert.equal(result.status, 400);
    assert.equal(result.body["code"], "handler_failed");
    assert.match(String(result.body["error"]), /platform config unreadable/);
  });

  it("资产库返回非对象（数组）→ 包成 {ok:true, value}", async () => {
    const p = ports();
    p.store.next = [1, 2, 3];
    const result = await call({ body: '{"op":"bootstrap"}' }, p);
    assert.deepEqual(result.body["value"], [1, 2, 3]);
  });

  it("资产库返回的 {ok:false} 保持 200（业务失败不是传输失败）", async () => {
    const p = ports();
    p.store.next = { ok: false, error: "请先选靶标" };
    const result = await call({ body: '{"op":"assets"}' }, p);
    assert.equal(result.status, 200);
    assert.equal(result.body["ok"], false);
    assert.equal(result.body["error"], "请先选靶标");
  });
});

describe("辅助导出", () => {
  it("normalizeStringField 去空白，空串给 null", () => {
    assert.equal(normalizeStringField({ a: " x " }, "a"), "x");
    assert.equal(normalizeStringField({ a: "   " }, "a"), null);
    assert.equal(normalizeStringField({ a: 1 }, "a"), null);
    assert.equal(normalizeStringField({}, "a"), null);
  });

  it("peekOp 不校验词汇表", () => {
    assert.equal(peekOp({ op: "bootstrap" }), "bootstrap");
    assert.equal(peekOp({ op: "whatever" }), "whatever");
    assert.equal(peekOp({}), null);
    assert.equal(peekOp({ op: 1 }), null);
  });
});

describe("响应体是**扁平**的（兼容旧调用点）", () => {
  it("资产库返回的字段直接平铺，不套 data", async () => {
    const p = ports();
    p.store.next = { ok: true, items: [1], total: 1 };
    const result: { readonly status: number; readonly body: ApiBody } = await call({ body: '{"op":"assets"}' }, p) as never;
    assert.equal(result.body["items"] !== undefined, true);
    assert.equal(result.body["data"], undefined, "不应出现 data 包裹层");
  });
});
