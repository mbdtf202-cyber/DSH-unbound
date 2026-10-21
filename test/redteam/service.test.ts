/**
 * `src/redteam/service.ts` 的测试 —— 服务端聚合入口。
 *
 * ## 这一层是**唯一**做过真 HTTP 的地方
 *
 * `test/ui/bridge.test.ts` 用假 `EventEmitter` 喂 `handleRequest`，验证的是管线逻辑；
 * 这里起**真 `http.createServer`**，走真 socket、真 `IncomingMessage`、真 `ServerResponse`，
 * 验证的是「整条链路能通」—— 也就是原来那个 404 断点是否真的补上了。
 *
 * ## 数据安全（硬约束）
 *
 * 每一条用例都 `mkdtemp` 到系统临时目录，**绝不触碰 `~/.dsh/redteam`**
 * （那是用户的真实靶标库）。`makeTempRoot()` 在 `after` 里先 `close` 再删目录 ——
 * 顺序反了 macOS 上 WAL 文件还被持有，删不掉。
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostContext } from "../../src/host-api/types.js";
import { RedteamStore } from "../../src/redteam/store/index.js";
import type { GatewayPorts } from "../../src/redteam/ui/gateway.js";
import { parseRequest } from "../../src/redteam/ui/ops.js";
import {
  ROUTE_KIND,
  ROUTE_PATH,
  applyWith,
  bridgeRequestOf,
  createBridgePorts,
  createGatewayPorts,
  injectorOf,
  createRouteSink,
  mountRoute,
  name as SERVICE_NAME,
  narrowPresets,
  narrowSessions,
  narrowSkillEntry,
  narrowSkills,
  narrowSubagents,
  providerOf,
  readPluginIdentity,
  serviceOf,
  skillFallbackOf,
  snapshotOf,
  unmountAllRoutes,
  webServerOf,
  type ServiceLogger,
  type WebServerRealFace,
} from "../../src/redteam/service.js";

/* ══════════════════════════════════════════════════ 夹具 */

/** 收集日志的假 logger（方法**必选**，与 service 内部的 ServiceLogger 对齐）。 */
function collectLogger(): ServiceLogger & { readonly lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, ...args: unknown[]): void => {
    lines.push(`${level} ${message}${args.length === 0 ? "" : " " + args.map(String).join(" ")}`);
  };
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

/** 一个用完可丢的临时数据根。 */
interface TempRoot {
  readonly root: string;
  readonly store: RedteamStore;
  dispose(): void;
}

/** 造临时数据根 + store（绝对不碰 ~/.dsh/redteam）。 */
function makeTempRoot(): TempRoot {
  const root = mkdtempSync(join(tmpdir(), "dsh-unbound-service-"));
  const store = new RedteamStore(root);
  let disposed = false;
  return {
    root,
    store,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        store.close();
      } catch {
        /* 忽略 */
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 起一条真 HTTP 服务，挂上 `/redteam/api`。 */
interface LiveServer {
  readonly origin: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** 把 handler 挂到真 http server 上（不经 `mountRoute`，直接验 serveRequest 链路）。 */
async function startServer(
  store: RedteamStore,
  env: Readonly<Record<string, string | undefined>>,
): Promise<LiveServer> {
  const gateway = createGatewayPorts({ ctx: {}, root: store.root, env });
  const ports = createBridgePorts(store, gateway);

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      // 与 mountRoute 的 handler 完全同一条路径：真 IncomingMessage → 适配 → serveRequest。
      const { serveRequest } = await import("../../src/redteam/ui/server.js");
      await serveRequest(bridgeRequestOf(req), res, ports);
    })();
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}

/** 真发一次 `POST /redteam/api`（带正确 Origin，模拟同源浏览器）。 */
async function post(
  origin: string,
  body: unknown,
): Promise<{ readonly status: number; readonly json: Readonly<Record<string, unknown>> }> {
  const response = await fetch(`${origin}${ROUTE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 带上与 Host 同源的 Origin：浏览器对跨源 fetch 必定加 Origin，
      // `origin.ts` 的回环分支现在按三态判（缺失 / 本机 / 外部），
      // 同源 Origin 走放行 —— 这才是真实浏览器页面的形态。
      origin,
      host: new URL(origin).host,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = JSON.parse(text);
  assert.notEqual(parsed, null);
  assert.equal(typeof parsed, "object");
  return { status: response.status, json: parsed as Readonly<Record<string, unknown>> };
}

/* ══════════════════════════════════════════════════ 真 HTTP 端到端 */

describe("真 HTTP 端到端 —— POST /redteam/api", () => {
  let temp: TempRoot;
  let live: LiveServer;

  before(async () => {
    temp = makeTempRoot();
    // 造一个真靶标（走 store 的 openEngagement，落真 SQLite）。
    temp.store.openEngagement("端到端靶标", ["10.0.0.0/24"], { bindCurrent: true });
    live = await startServer(temp.store, { DSH_HOME: temp.root });
  });

  after(async () => {
    await live.close();
    temp.dispose();
    unmountAllRoutes();
  });

  it("bootstrap → 200 且返回靶标名册", async () => {
    const result = await post(live.origin, { op: "bootstrap" });

    assert.equal(result.status, 200, `期望 200，实际 ${result.status}`);
    assert.equal(result.json["ok"], true);

    // 名册：至少一条，且名字是我们刚才建的那个。
    const engagements = result.json["engagements"];
    assert.ok(Array.isArray(engagements), "engagements 必须是数组");
    assert.ok(engagements.length >= 1, "至少一个靶标");
    const names = engagements.map((row: unknown) => {
      assert.equal(typeof row, "object");
      const record = row as Record<string, unknown>;
      return record["name"];
    });
    assert.ok(names.includes("端到端靶标"), `名册里应有「端到端靶标」，实际 ${JSON.stringify(names)}`);

    // root 必须是临时目录，绝不是 ~/.dsh/redteam。
    assert.equal(result.json["root"], temp.root);
    assert.ok(!String(result.json["root"]).includes(".dsh/redteam"));

    // current 指向刚建的那个（bindCurrent: true）。
    assert.equal(typeof result.json["current"], "string");
  });

  it("未知 op → 400 且 code=unknown_op（不是 500、不是静默空态）", async () => {
    const result = await post(live.origin, { op: "unknown_op" });
    assert.equal(result.status, 400);
    assert.equal(result.json["ok"], false);
    assert.equal(result.json["code"], "unknown_op");
    assert.equal(result.json["op"], "unknown_op");
  });

  it("缺 op → 400 missing_op", async () => {
    const result = await post(live.origin, {});
    assert.equal(result.status, 400);
    assert.equal(result.json["code"], "missing_op");
  });

  it("网关 op（version）也通：不 404、不转发资产库", async () => {
    const result = await post(live.origin, { op: "version" });
    assert.equal(result.status, 200);
    assert.equal(result.json["ok"], true);
    const plugin = result.json["plugin"] as Record<string, unknown>;
    assert.equal(typeof plugin, "object");
    // 身份从本包 package.json 读出来（不是硬编码的兜底）。
    assert.equal(plugin["name"], "dsh-unbound");
  });

  it("资产库 op（assets）通：真读临时库里的资产（空列表也算通）", async () => {
    const result = await post(live.origin, { op: "assets" });
    assert.equal(result.status, 200);
    assert.equal(result.json["ok"], true);
    assert.ok(Array.isArray(result.json["items"]));
    assert.equal(result.json["total"], 0, "刚建的靶标没有资产");
  });

  it("GET → 405（方法闸在最前）", async () => {
    const response = await fetch(`${live.origin}${ROUTE_PATH}`, {
      method: "GET",
      headers: { host: new URL(live.origin).host },
    });
    assert.equal(response.status, 405);
    const parsed: unknown = JSON.parse(await response.text());
    assert.equal((parsed as Record<string, unknown>)["code"], "method_not_allowed");
  });

  it("🔒 回环 socket 上伪造外部 Origin **被拒绝**（CSRF 已修）", async () => {
    const host = new URL(live.origin).host;
    const response = await fetch(`${live.origin}${ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 非回环 Host + 外部 Origin。
        host: "dsh.example.com",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ op: "bootstrap" }),
    });
    const parsed: unknown = JSON.parse(await response.text());

    // ## 这条曾经断言的是「漏洞存在」
    //
    // 本用例最早写的是 `assert.equal(response.status, 200, "回环 socket 放行是既有设计")`
    // —— 即如实记录一个**已知安全缺陷**：`origin.ts` 的第一条分支曾是
    // 「回环 socket 一律放行」，而这条服务只监听 127.0.0.1，所以所有请求的
    // remoteAddress 都是回环 → 用户浏览器里任何恶意页面都能
    // `fetch('http://127.0.0.1:PORT/redteam/api', {method:'POST', body:...})`
    // 让**写操作真的执行**（同源策略只挡读响应，不挡发请求）。
    //
    // 该缺陷已修（`origin.ts` 的回环分支现在按 Origin 三态判：缺失/本机放行，
    // 外部 host 拒绝）。本用例随之改为断言**修复后的正确行为**，
    // 防止将来有人把「无条件放行」改回去。
    assert.notEqual(response.status, 200, "伪造外部 Origin 必须被拒绝，不能再放行");
    assert.equal(response.status, 403, "拒绝应走 403（origin 拒绝），不是 400/500");
    assert.equal(parsed !== null && typeof parsed === "object", true);
    // Host 伪造本身不改变请求实际发往的地址，这里只留作事实记录。
    assert.equal(host, new URL(live.origin).host);
  });

  it("非回环 socket 才走严格同源（用 handleRequest 直验，避开只监听回环的限制）", async () => {
    // 真 HTTP 服务只监听 127.0.0.1，造不出非回环 peer；这里直接喂端口，
    // 验的是同一条 request 一旦来自外部地址时的结论（管线逻辑归 bridge.test 全覆盖，
    // 此处只确认 service 造出来的 ports 在拒绝路径上不抛）。
    const { handleRequest } = await import("../../src/redteam/ui/bridge.js");
    const gateway = createGatewayPorts({ ctx: {} as HostContext, root: temp.root, env: { DSH_HOME: temp.root } });
    const ports = createBridgePorts(temp.store, gateway);
    const { EventEmitter } = await import("node:events");

    class Fake extends EventEmitter {
      get method(): string {
        return "POST";
      }
      get socket(): { remoteAddress: string } {
        return { remoteAddress: "203.0.113.9" };
      }
      get headers(): Record<string, string> {
        return { host: "dsh.example.com", origin: "https://evil.example" };
      }
      destroy(): unknown {
        return this;
      }
    }
    const request = new Fake();
    const pending = handleRequest(request, ports);
    queueMicrotask(() => {
      request.emit("data", Buffer.from('{"op":"bootstrap"}', "utf8"));
      request.emit("end");
    });
    const result = await pending;
    assert.equal(result.status, 403);
    assert.equal(result.body["code"], "cross_origin");
  });
});

/* ══════════════════════════════════════════════════ 库隔离 */

describe("store 隔离：不同临时 root 互不影响", () => {
  it("两个 root 各自的靶标名册互不串", async () => {
    const alpha = makeTempRoot();
    const beta = makeTempRoot();
    const liveAlpha = await startServer(alpha.store, { DSH_HOME: alpha.root });
    const liveBeta = await startServer(beta.store, { DSH_HOME: beta.root });

    try {
      alpha.store.openEngagement("alpha-靶标", ["10.1.0.0/24"], { bindCurrent: true });
      beta.store.openEngagement("beta-靶标", ["10.2.0.0/24"], { bindCurrent: true });

      const fromAlpha = await post(liveAlpha.origin, { op: "bootstrap" });
      const fromBeta = await post(liveBeta.origin, { op: "bootstrap" });

      assert.equal(fromAlpha.json["root"], alpha.root);
      assert.equal(fromBeta.json["root"], beta.root);

      const namesOf = (body: Readonly<Record<string, unknown>>): string[] => {
        const rows = body["engagements"];
        assert.ok(Array.isArray(rows));
        return rows.map((row: unknown) => String((row as Record<string, unknown>)["name"]));
      };

      assert.deepEqual(namesOf(fromAlpha.json), ["alpha-靶标"]);
      assert.deepEqual(namesOf(fromBeta.json), ["beta-靶标"]);
    } finally {
      await liveAlpha.close();
      await liveBeta.close();
      alpha.dispose();
      beta.dispose();
    }
  });
});

/* ══════════════════════════════════════════════════ ctx 缺能力不抛 */

describe("ctx 缺能力时只留 warning，不抛", () => {
  it("完全没有 webServer / provide / effect 的 ctx：applyWith 返回而非抛", () => {
    const temp = makeTempRoot();
    const logger = collectLogger();
    try {
      const outcome = applyWith({ logger } as HostContext, {
        root: temp.root,
        env: { DSH_HOME: temp.root },
      });
      assert.equal(outcome.error, null, "不该有致命错误");
      assert.notEqual(outcome.store, null, "store 仍然要造出来");
      assert.equal(outcome.provided, false, "没有 provide 就没发布服务");
      assert.equal(outcome.route, null, "没有 webServer 也没法挂路由");
      // 三条警告分别对应三个缺失的能力。
      const joined = logger.lines.join("\n");
      assert.match(joined, /ctx\.provide/);
      assert.match(joined, /ctx\.effect/);
      assert.match(joined, /webServer/);
    } finally {
      temp.dispose();
    }
  });

  it("ctx.provide 抛错（已有同名服务）时不影响路由与 store", () => {
    const temp = makeTempRoot();
    const logger = collectLogger();
    const registered: unknown[] = [];
    try {
      const outcome = applyWith(
        {
          logger,
          provide(): void {
            throw new Error('service "redteam" has been registered at <other-fiber>');
          },
          webServer: {
            register(route: unknown): unknown {
              registered.push(route);
              return (): void => {};
            },
          },
        } as unknown as HostContext,
        { root: temp.root, env: { DSH_HOME: temp.root } },
      );
      assert.notEqual(outcome.store, null);
      assert.equal(outcome.provided, false, "provide 抛错 → 未发布");
      assert.equal(outcome.route?.registered, true, "路由仍应挂上");
      assert.equal(registered.length, 1);
      assert.match(logger.lines.join("\n"), /provide\("redteam"\) 失败/);
    } finally {
      temp.dispose();
    }
  });

  it("数据根不可写（store 构造抛）时不抛，返回 error", () => {
    const logger = collectLogger();
    // /dev/null/xxx 在任何 POSIX 上都无法 mkdir（ENOTDIR）。
    const outcome = applyWith({ logger } as HostContext, {
      root: "/dev/null/definitely-not-a-dir",
      env: { DSH_HOME: "/dev/null/definitely-not-a-dir" },
    });
    assert.equal(outcome.store, null);
    assert.notEqual(outcome.error, null);
    assert.match(String(outcome.error), /红队事实库打开失败/);
    assert.match(logger.lines.join("\n"), /红队事实库打开失败/);
  });
});

/* ══════════════════════════════════════════════════ apply 的形状契约 */

describe("apply 的形状契约：provide 收到 store、register 收到 {path}", () => {
  it("provide 收到 ('redteam', RedteamStore 实例)", () => {
    const temp = makeTempRoot();
    const provided: { name: string; value: unknown }[] = [];
    try {
      const outcome = applyWith(
        {
          logger: collectLogger(),
          provide(serviceName: string, value: unknown): void {
            provided.push({ name: serviceName, value });
          },
          effect(fn: () => void | (() => void)): unknown {
            return fn();
          },
        } as unknown as HostContext,
        { root: temp.root, env: { DSH_HOME: temp.root } },
      );

      assert.equal(provided.length, 1);
      assert.equal(provided[0]?.name, "redteam");
      assert.ok(provided[0]?.value instanceof RedteamStore, "provide 的值必须是真的 RedteamStore");
      assert.equal(outcome.provided, true);
      assert.equal((provided[0]?.value as RedteamStore).root, temp.root);
    } finally {
      temp.dispose();
    }
  });

  it("register 收到 {kind:'exact', path:'/redteam/api', handler}", () => {
    const temp = makeTempRoot();
    const routes: Record<string, unknown>[] = [];
    try {
      applyWith(
        {
          logger: collectLogger(),
          webServer: {
            register(route: unknown): unknown {
              assert.equal(typeof route, "object");
              routes.push(route as Record<string, unknown>);
              return (): void => {};
            },
          },
        } as unknown as HostContext,
        { root: temp.root, env: { DSH_HOME: temp.root } },
      );

      assert.equal(routes.length, 1);
      assert.equal(routes[0]?.["kind"], "exact", "kind 必须是 exact：漏了会进 prefix 表，语义变成前缀路由");
      assert.equal(routes[0]?.["path"], "/redteam/api");
      assert.equal(typeof routes[0]?.["handler"], "function");
    } finally {
      temp.dispose();
    }
  });

  it("注释/常量与真实契约一致（防止文档与代码漂移）", () => {
    assert.equal(ROUTE_PATH, "/redteam/api");
    assert.equal(ROUTE_KIND, "exact");
    assert.equal(SERVICE_NAME, "dsh-unbound-service");
  });

  it("没有 webServer 但支持 ctx.inject 时走延迟注册（不永久 pending）", () => {
    const temp = makeTempRoot();
    const injected: string[][] = [];
    const logger = collectLogger();
    try {
      const outcome = applyWith(
        {
          logger,
          inject(names: readonly string[], _cb: (host: HostContext) => void): unknown {
            injected.push([...names]);
            return {};
          },
        } as unknown as HostContext,
        { root: temp.root, env: { DSH_HOME: temp.root } },
      );
      assert.deepEqual(injected, [["webServer"]]);
      assert.equal(outcome.route?.reason, "deferred");
      assert.equal(outcome.route?.registered, false);
    } finally {
      temp.dispose();
    }
  });

  it("延迟注册的回调真跑时，路由能挂上", () => {
    const temp = makeTempRoot();
    const routes: Record<string, unknown>[] = [];
    let pending: ((host: HostContext) => void) | null = null;
    try {
      applyWith(
        {
          logger: collectLogger(),
          inject(_names: readonly string[], cb: (host: HostContext) => void): unknown {
            pending = cb;
            return {};
          },
          effect(fn: () => void | (() => void)): unknown {
            return fn();
          },
        } as unknown as HostContext,
        { root: temp.root, env: { DSH_HOME: temp.root } },
      );

      assert.notEqual(pending, null, "必须挂上了 inject 回调");
      const fire = pending as unknown as (host: HostContext) => void;
      fire({
        logger: collectLogger(),
        effect(fn: () => void | (() => void)): unknown {
          return fn();
        },
        webServer: {
          register(route: unknown): unknown {
            routes.push(route as Record<string, unknown>);
            return (): void => {};
          },
        },
      } as unknown as HostContext);

      assert.equal(routes.length, 1);
      assert.equal(routes[0]?.["path"], "/redteam/api");
    } finally {
      temp.dispose();
    }
  });
});

/* ══════════════════════════════════════════════════ 路由挂载细节 */

describe("mountRoute：disposer / 重复注册", () => {
  /** 造一个记录调用的假 webServer。 */
  function fakeServer(): WebServerRealFace & {
    readonly routes: Record<string, unknown>[];
    readonly disposed: number[];
  } {
    const routes: Record<string, unknown>[] = [];
    const disposed: number[] = [];
    return {
      routes,
      disposed,
      register(route): unknown {
        routes.push(route as unknown as Record<string, unknown>);
        const index = routes.length;
        return (): void => {
          disposed.push(index);
        };
      },
    };
  }

  it("返回的 disposer 会被 unmountAllRoutes 调用", () => {
    const temp = makeTempRoot();
    const server = fakeServer();
    try {
      const ports = createBridgePorts(
        temp.store,
        createGatewayPorts({ ctx: {}, root: temp.root, env: { DSH_HOME: temp.root } }),
      );
      unmountAllRoutes();
      const result = mountRoute(server, ports, collectLogger());
      assert.equal(result.registered, true);
      assert.equal(server.routes.length, 1);

      const removed = unmountAllRoutes();
      assert.equal(removed, 1, "应当撤掉一条");
      assert.deepEqual(server.disposed, [1]);
      // 幂等：再撤一次不再调 disposer。
      assert.equal(unmountAllRoutes(), 0);
    } finally {
      temp.dispose();
    }
  });

  it("重复注册（duplicate）只 warning，不抛", () => {
    const temp = makeTempRoot();
    const logger = collectLogger();
    try {
      const ports = createBridgePorts(
        temp.store,
        createGatewayPorts({ ctx: {}, root: temp.root, env: { DSH_HOME: temp.root } }),
      );
      const server: WebServerRealFace = {
        register(): unknown {
          throw new Error('webserver: duplicate exact route "/redteam/api"');
        },
      };
      const result = mountRoute(server, ports, logger);
      assert.equal(result.registered, false);
      assert.equal(result.reason, "duplicate");
      assert.match(logger.lines.join("\n"), /已存在/);
    } finally {
      temp.dispose();
    }
  });

  it("注册抛别的错 → reason 带原因，仍不抛", () => {
    const temp = makeTempRoot();
    try {
      const ports = createBridgePorts(
        temp.store,
        createGatewayPorts({ ctx: {}, root: temp.root, env: { DSH_HOME: temp.root } }),
      );
      const server: WebServerRealFace = {
        register(): unknown {
          throw new Error("webserver not initialized");
        },
      };
      const result = mountRoute(server, ports, collectLogger());
      assert.equal(result.registered, false);
      assert.match(result.reason, /not initialized/);
    } finally {
      temp.dispose();
    }
  });

  it("createRouteSink：各自独立，卸载一个不影响另一个（防跨实例泄漏回归）", () => {
    const sinkA = createRouteSink();
    const sinkB = createRouteSink();
    const disposedA: string[] = [];
    const disposedB: string[] = [];

    sinkA.add(() => disposedA.push("a1"));
    sinkB.add(() => disposedB.push("b1"));

    assert.equal(sinkA.unmount(), 1);
    assert.deepEqual(disposedA, ["a1"]);
    assert.deepEqual(disposedB, [], "撤 A 不能连坐撤 B");

    assert.equal(sinkB.unmount(), 1);
    assert.deepEqual(disposedB, ["b1"]);
    // 幂等。
    assert.equal(sinkA.unmount(), 0);
    assert.equal(sinkB.unmount(), 0);
  });

  it("两次 applyWith 各自持有独立 sink：撤第一份不撤第二份", () => {
    const tempA = makeTempRoot();
    const tempB = makeTempRoot();
    const routesA: Record<string, unknown>[] = [];
    const routesB: Record<string, unknown>[] = [];
    const disposersA: (() => void)[] = [];
    const disposersB: (() => void)[] = [];

    /** 造一个 ctx：register 时把 disposer 交给自己的 effect 收起来。 */
    const makeCtx = (
      routes: Record<string, unknown>[],
      keep: (() => void)[],
    ): HostContext => {
      const own: (() => void)[] = [];
      return {
        logger: collectLogger(),
        effect(fn: () => void | (() => void)): unknown {
          const disposer = fn();
          if (typeof disposer === "function") own.push(disposer);
          return disposer;
        },
        webServer: {
          register(route: unknown): unknown {
            routes.push(route as Record<string, unknown>);
            const dispose = (): void => {
              const at = routes.indexOf(route as Record<string, unknown>);
              if (at >= 0) routes.splice(at, 1);
            };
            keep.push(dispose);
            return dispose;
          },
        },
      } as unknown as HostContext;
    };

    try {
      const ctxA = makeCtx(routesA, disposersA);
      const ctxB = makeCtx(routesB, disposersB);

      const outcomeA = applyWith(ctxA, { root: tempA.root, env: { DSH_HOME: tempA.root } });
      const outcomeB = applyWith(ctxB, { root: tempB.root, env: { DSH_HOME: tempB.root } });
      assert.equal(outcomeA.route?.registered, true);
      assert.equal(outcomeB.route?.registered, true);
      assert.equal(routesA.length, 1);
      assert.equal(routesB.length, 1);

      // 触发 A 的 effect 清理（模拟 A 卸载）。
      for (const dispose of disposersA) dispose();

      assert.equal(routesA.length, 0, "A 的路由必须撤掉");
      assert.equal(routesB.length, 1, "B 的路由必须还在 —— 模块级共享 sink 会在这里红");
    } finally {
      tempA.dispose();
      tempB.dispose();
    }
  });
});

/* ══════════════════════════════════════════════════ 宿主能力窄化 */

describe("宿主能力窄化：形状不符一律 null / undefined，不抛", () => {
  it("webServerOf：缺 webServer / register 不是函数 → null", () => {
    assert.equal(webServerOf({} as HostContext), null);
    assert.equal(webServerOf({ webServer: {} } as HostContext), null);
    assert.equal(webServerOf({ webServer: { register: 1 } } as unknown as HostContext), null);
    const face = webServerOf({ webServer: { register: (): void => {} } } as unknown as HostContext);
    assert.notEqual(face, null);
  });

  it("webServerOf：ctx 属性读取抛（Proxy 未 inject）→ null", () => {
    const throwing = new Proxy(
      {},
      {
        get(): never {
          throw new Error('cannot get property "webServer" without inject');
        },
      },
    ) as HostContext;
    assert.equal(webServerOf(throwing), null);
  });

  it("providerOf：没有 provide / 不是函数 → null", () => {
    assert.equal(providerOf({} as HostContext), null);
    assert.equal(providerOf({ provide: "redteam" } as unknown as HostContext), null);
  });

  it("injectorOf：没有 inject / 不是函数 → null", () => {
    assert.equal(injectorOf({} as HostContext), null);
    assert.equal(injectorOf({ inject: [1, 2] } as unknown as HostContext), null);
  });

  it("serviceOf：ctx.get 抛 / 返回 undefined → undefined，不冒泡", () => {
    assert.equal(serviceOf({}, "subagents"), undefined);
    assert.equal(
      serviceOf({ get: (): never => { throw new Error("not injected"); } } as unknown as HostContext, "skills"),
      undefined,
    );
    assert.equal(serviceOf({ get: (): undefined => undefined } as unknown as HostContext, "skills"), undefined);
  });

  it("narrowSubagents：缺 listChildren → null；有则包装结果", async () => {
    assert.equal(narrowSubagents(null), null);
    assert.equal(narrowSubagents({}), null);
    const registry = narrowSubagents({
      listChildren: async (): Promise<unknown> => [{ id: "a" }],
    });
    assert.notEqual(registry, null);
    assert.deepEqual(await registry?.listChildren("root"), [{ id: "a" }]);
    // 返回非数组 → 空数组（不把 undefined 透给网关）。
    const bad = narrowSubagents({ listChildren: async (): Promise<unknown> => null });
    assert.deepEqual(await bad?.listChildren("root"), []);
  });

  it("narrowSessions：list 抛错 → 空数组", () => {
    const registry = narrowSessions({
      list: (): never => {
        throw new Error("session registry not ready");
      },
    });
    assert.deepEqual(registry?.list(), []);
    assert.equal(narrowSessions({}), null);
  });

  it("narrowSkillEntry：缺 name → null；可空字段保住 null", () => {
    assert.equal(narrowSkillEntry(null), null);
    assert.equal(narrowSkillEntry({ description: "x" }), null);
    const entry = narrowSkillEntry({
      name: "recon",
      description: "信息收集",
      path: null,
      invocation: null,
      resourceBase: null,
      content: "# recon",
    });
    assert.equal(entry?.name, "recon");
    assert.equal(entry?.path, null);
    assert.equal(entry?.invocation, null);
    assert.equal(entry?.resourceBase, null);
    assert.equal(entry?.content, "# recon");
  });

  it("narrowSkills：只要一个方法缺 → null", () => {
    assert.equal(narrowSkills({ list: async (): Promise<unknown[]> => [] }), null);
    assert.equal(narrowSkills({ get: async (): Promise<undefined> => undefined }), null);
    const service = narrowSkills({
      list: async (): Promise<unknown[]> => [{ name: "recon", description: "d" }, { bad: true }],
      get: async (): Promise<unknown> => ({ name: "recon", description: "d" }),
    });
    assert.notEqual(service, null);
  });

  it("narrowPresets：缺 standingKeyFor → null", async () => {
    assert.equal(narrowPresets({}), null);
    const presets = narrowPresets({ standingKeyFor: async (): Promise<string> => "scope-1" });
    assert.equal(await presets?.standingKeyFor("redteam"), "scope-1");
  });
});

/* ══════════════════════════════════════════════════ GatewayPorts 逐字段 */

describe("GatewayPorts：15 个字段的降级行为", () => {
  /** 最小环境：无任何宿主服务。 */
  function barePorts(root: string, env: Readonly<Record<string, string | undefined>>): GatewayPorts {
    return createGatewayPorts({ ctx: {} as HostContext, root, env });
  }

  it("storeRoot 就是传入的数据根", () => {
    const temp = makeTempRoot();
    try {
      assert.equal(barePorts(temp.root, {}).storeRoot, temp.root);
    } finally {
      temp.dispose();
    }
  });

  it("maxAgents / maxAgentsSource / limit / default：无 settings 时给默认值", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, {});
      assert.equal(ports.maxAgents(), 3);
      assert.equal(ports.maxAgentsSource(), "default");
      assert.equal(ports.maxAgentsLimit, 10);
      assert.equal(ports.defaultMaxAgents, 3);
    } finally {
      temp.dispose();
    }
  });

  it("saveMaxAgents：真落盘，且 clamp 到 [1, 10]", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, {});
      assert.equal(ports.saveMaxAgents(7), 7);
      assert.equal(ports.maxAgents(), 7, "保存后立即生效");
      assert.equal(ports.maxAgentsSource(), "settings");
      // 越界被夹。
      assert.equal(ports.saveMaxAgents(999), 10);
      assert.equal(ports.saveMaxAgents(-5), 1);
    } finally {
      temp.dispose();
    }
  });

  it("saveMaxAgents：写盘失败（root 不可写）时退化成 clamp 值，不抛", () => {
    const ports = barePorts("/dev/null/nope", {});
    const applied = ports.saveMaxAgents(6);
    assert.equal(applied, 6, "clamp 结果仍然回报（面板不会整个炸）");
  });

  it("maxAgentsSource：环境变量生效时报 env", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, { REDTEAM_MAX_AGENTS: "5" });
      assert.equal(ports.maxAgents(), 5);
      assert.equal(ports.maxAgentsSource(), "env");
    } finally {
      temp.dispose();
    }
  });

  it("subagents / sessions：宿主不提供时是 null（网关据此报「注册表不可用」）", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, {});
      assert.equal(ports.subagents, null);
      assert.equal(ports.sessions, null);
    } finally {
      temp.dispose();
    }
  });

  it("subagents / sessions：宿主提供时被窄化（形状不符仍 null）", () => {
    const temp = makeTempRoot();
    try {
      const ports = createGatewayPorts({
        ctx: {
          get(serviceName: string): unknown {
            if (serviceName === "subagents") return { listChildren: async (): Promise<unknown[]> => [] };
            if (serviceName === "sessions") return { list: (): unknown[] => [] };
            return undefined;
          },
        } as unknown as HostContext,
        root: temp.root,
        env: {},
      });
      assert.notEqual(ports.subagents, null);
      assert.notEqual(ports.sessions, null);
    } finally {
      temp.dispose();
    }
  });

  it("envAdaptStatus：返回带 ready/reason 的对象（不抛）", () => {
    const temp = makeTempRoot();
    try {
      const body = barePorts(temp.root, {}).envAdaptStatus();
      // 非 Kali + 无配置 → ready:false、reason:need-config。都是明确状态，不是 undefined。
      assert.equal(typeof body["ok"], "boolean");
      assert.equal(typeof body["ready"], "boolean");
      assert.equal(typeof body["reason"], "string");
      assert.equal(Array.isArray(body["missingIds"]), true);
    } finally {
      temp.dispose();
    }
  });

  it("envAdaptSkip：落盘后 skipped 变 true", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, {});
      const body = ports.envAdaptSkip(true);
      assert.equal(body["skipped"], true);
      assert.equal(ports.envAdaptStatus()["skipped"], true);
    } finally {
      temp.dispose();
    }
  });

  it("pluginIdentity：从本包 package.json 读到真值", () => {
    const temp = makeTempRoot();
    try {
      const identity = barePorts(temp.root, {}).pluginIdentity();
      assert.equal(identity.name, "dsh-unbound");
      assert.equal(identity.version, "0.1.0");
      assert.match(identity.description, /DeepSeek Harness unbound/);
    } finally {
      temp.dispose();
    }
  });

  it("pluginIdentity：package.json 缺失时给「未知版本」，不抛", () => {
    const identity = readPluginIdentity("/nonexistent/package.json");
    assert.equal(identity.name, "dsh-unbound");
    assert.equal(identity.version, null, "版本未知必须是 null，不能假报一个");
  });

  it("updatePreflight：无 profile 时按 dev 处理，并说明更新通道未实现", async () => {
    const temp = makeTempRoot();
    try {
      const preflight = await barePorts(temp.root, {}).updatePreflight();
      assert.equal(preflight.install.mode, "dev");
      assert.deepEqual(preflight.runningAgents, []);
      assert.ok(preflight.notes.some((note) => /开发态/.test(note)));
      assert.ok(preflight.notes.some((note) => /自动更新通道未接入/.test(note)));
    } finally {
      temp.dispose();
    }
  });

  it("updatePreflight：有智能体在跑时进 blockers", async () => {
    const temp = makeTempRoot();
    try {
      const ports = createGatewayPorts({
        ctx: {
          get(serviceName: string): unknown {
            if (serviceName === "subagents") {
              return {
                listChildren: async (): Promise<unknown[]> => [
                  { id: "c1", kind: "child", activity: "running", label: "侦察" },
                ],
              };
            }
            if (serviceName === "sessions") return { list: (): unknown[] => [{ id: "r1", header: {} }] };
            return undefined;
          },
        } as unknown as HostContext,
        root: temp.root,
        env: {},
      });
      const preflight = await ports.updatePreflight();
      assert.equal(preflight.runningAgents.length, 1);
      assert.equal(preflight.runningAgents[0]?.label, "侦察");
      assert.ok(preflight.blockers.some((item) => /正在跑/.test(item)));
    } finally {
      temp.dispose();
    }
  });

  it("checkLatest：明确「未实现」，不是假装成功", async () => {
    const temp = makeTempRoot();
    try {
      const result = await barePorts(temp.root, {}).checkLatest();
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /更新检查未实现/);
        assert.match(result.error, /npm registry/);
      }
    } finally {
      temp.dispose();
    }
  });

  it("applyUpdate：明确「未实现」，且不接受 target", async () => {
    const temp = makeTempRoot();
    try {
      const result = await barePorts(temp.root, {}).applyUpdate("0.2.0");
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /自动更新未实现/);
    } finally {
      temp.dispose();
    }
  });

  it("versionIsNewer：走 platform/version 的唯一实现", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, {});
      assert.equal(ports.versionIsNewer("0.2.0", "0.1.0"), true);
      assert.equal(ports.versionIsNewer("0.1.0", "0.2.0"), false);
      assert.equal(ports.versionIsNewer("0.1.0", "0.1.0"), false);
      // 已知偏差（platform/version.ts 文件头声明）：prerelease 按字符串比较。
      assert.equal(ports.versionIsNewer("1.2.0-beta10", "1.2.0-beta9"), false);
    } finally {
      temp.dispose();
    }
  });

  it("skillService / presetService：宿主不提供时 null", () => {
    const temp = makeTempRoot();
    try {
      const ports = barePorts(temp.root, {});
      assert.equal(ports.skillService, null);
      assert.equal(ports.presetService, null);
    } finally {
      temp.dispose();
    }
  });

  it("skillFallback：读不到宿主技能服务时给兜底目录（ok:true，不是 400）", async () => {
    const temp = makeTempRoot();
    try {
      // 临时 DSH_HOME 下建一个红队技能，验证兜底真的读得到。
      //
      // ⚠️ 这里必须知道一件事（实测，不是推测）：`bundledSkillSummaries`
      // **有意**同时扫 `$DSH_HOME/redteam/skills` 与 `~/.dsh/redteam/skills`
      // 两个候选 home（见 `platform/skill-availability.ts` 的
      // `dshHomeCandidates`，注释写明分叉的机器上只扫一边会「装了却列不出来」）。
      // 所以本条用例会**读**到开发机上真实的红队技能目录 —— 只读，不写。
      // 因此断言不能依赖 total（那会随本机装的技能数变化），只能断言
      // 「我建的那一条在里面」。
      const skillDir = join(temp.root, "redteam", "skills");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "service-test-skill.md"),
        "---\nname: service-test-skill\ndescription: 测试用技能\n---\n\n# service-test-skill\n\n只用于本测试。\n",
        "utf8",
      );

      const parsed = parseRequest({ op: "skillCatalog" });
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      const body = await skillFallbackOf(parsed.value, { DSH_HOME: temp.root });

      assert.equal(body["ok"], true);
      const items = body["items"];
      assert.ok(Array.isArray(items));
      const names = items.map((row: unknown) => (row as Record<string, unknown>)["name"]);
      assert.ok(
        names.includes("service-test-skill"),
        `兜底目录里应有临时目录建的那条，实际共 ${names.length} 条`,
      );

      // 红队技能要带 availability（官方技能是 "listed"）。
      const mine = items.find(
        (row: unknown) => (row as Record<string, unknown>)["name"] === "service-test-skill",
      ) as Record<string, unknown>;
      assert.equal(mine["library"], "redteam");
      assert.equal(typeof mine["availability"], "string");
      // 目录必须指向临时目录，而不是真实 home。
      assert.equal(mine["dir"], skillDir);
    } finally {
      temp.dispose();
    }
  });

  it("skillFallback：skillRead 读正文；找不到时 ok:false 但不炸", async () => {
    const temp = makeTempRoot();
    try {
      const skillDir = join(temp.root, "redteam", "skills");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "service-test-read.md"),
        "---\nname: service-test-read\ndescription: 读正文用\n---\n\n# service-test-read\n\n先拿服务器权限。\n",
        "utf8",
      );

      const hit = parseRequest({ op: "skillRead", name: "service-test-read" });
      assert.equal(hit.ok, true);
      if (hit.ok) {
        const body = await skillFallbackOf(hit.value, { DSH_HOME: temp.root });
        assert.equal(body["ok"], true);
        assert.equal(body["name"], "service-test-read");
        assert.match(String(body["content"]), /先拿服务器权限/);
      }

      // 用一个几乎不可能存在的名字，避免命中本机真实技能。
      const miss = parseRequest({ op: "skillRead", name: "service-test-no-such-skill-xyz" });
      assert.equal(miss.ok, true);
      if (miss.ok) {
        const body = await skillFallbackOf(miss.value, { DSH_HOME: temp.root });
        assert.equal(body["ok"], false);
        assert.match(String(body["error"]), /skill not found/);
      }
    } finally {
      temp.dispose();
    }
  });

  it("skillFallback：非技能 op 明确报错而不是返回空目录", async () => {
    const parsed = parseRequest({ op: "platformEnvAdaptStatus" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const body = await skillFallbackOf(parsed.value, { DSH_HOME: "/tmp/nowhere" });
    assert.equal(body["ok"], false);
    assert.match(String(body["error"]), /不处理 op/);
  });
});

/* ══════════════════════════════════════════════════ 诊断快照 */

describe("snapshotOf：自检快照读不到时给安全值", () => {
  it("正常数据根：数出靶标数与技能文件数", () => {
    const temp = makeTempRoot();
    try {
      temp.store.openEngagement("快照靶标", [], { bindCurrent: false });
      const skillDir = join(temp.root, "redteam", "skills");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "a.md"), "---\ndescription: a\n---\n", "utf8");

      const snap = snapshotOf(temp.root, { DSH_HOME: temp.root });
      assert.equal(snap.name, SERVICE_NAME);
      assert.equal(snap.root, temp.root);
      assert.equal(snap.engagementCount, 1);
      assert.equal(snap.skillDirCount, 1);
      assert.equal(snap.packageVersion, "0.1.0");
      assert.match(snap.configPath, /config\.json$/);
    } finally {
      temp.dispose();
    }
  });

  it("空目录 / 不存在的根：全部给 0，不抛", () => {
    const snap = snapshotOf("/nonexistent-service-root", { DSH_HOME: "/nonexistent-service-home" });
    assert.equal(snap.engagementCount, 0);
    assert.equal(snap.skillDirCount, 0);
  });
});

/* ══════════════════════════════════════════════════ 请求适配 */

describe("bridgeRequestOf：IncomingMessage → BridgeRequest", () => {
  it("method 缺失翻译成 null（origin.ts 按 null 走严格分支）", () => {
    const fake = {
      method: undefined,
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:1" },
      on: (): unknown => fake,
      destroy: (): unknown => fake,
    } as unknown as IncomingMessage;
    const adapted = bridgeRequestOf(fake);
    assert.equal(adapted.method, null);
    assert.equal(adapted.socket?.remoteAddress, "127.0.0.1");
    assert.deepEqual(adapted.headers, { host: "127.0.0.1:1" });
  });

  it("socket 缺失时 remoteAddress 是 null 而不是 undefined", () => {
    const fake = {
      method: "POST",
      socket: undefined,
      headers: {},
      on: (): unknown => fake,
      destroy: (): unknown => fake,
    } as unknown as IncomingMessage;
    const adapted = bridgeRequestOf(fake);
    assert.equal(adapted.socket?.remoteAddress, null);
    assert.equal(adapted.method, "POST");
  });
});

/* ══════════════════════════════════════════════════ 清理 */

/**
 * 模块级兜底：任何用例漏了 unmount，这里统一收。
 *
 * 必须放在文件末尾（`afterEach` 与 `after` 的顺序按注册顺序执行，
 * 而 `describe` 内的 `after` 只在该 describe 结束时跑）。
 */
afterEach(() => {
  // 单条用例内挂的路由不该泄漏到下一轮 —— 泄漏会让下一条用例
  // 看到 `duplicate` 而不是第一次注册。
});

after(() => {
  unmountAllRoutes();
});
