/**
 * 同源校验测试：**每个分支一个用例**。
 *
 * 原实现的两条补丁各自对应线上事故（详见 `origin.ts` 的注释），
 * 所以这里不是「测几个代表性组合」，而是把 6 个放行 + 3 个拒绝的
 * `reason` 逐一对齐 —— 任何人改动某个分支，对应用例会红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkOrigin,
  isLocalHost,
  isLoopbackAddress,
  originHostOf,
  readOriginFacts,
  type OriginDecision,
} from "../../src/redteam/ui/origin.js";

/** 断言放行，并锁定具体 reason（分支身份，不只是布尔结果）。 */
function assertAllow(decision: OriginDecision, reason: string): void {
  assert.equal(decision.allow, true, `应放行（期望 reason=${reason}）`);
  assert.equal(decision.reason, reason);
}

/** 断言拒绝，并锁定具体 reason。 */
function assertDeny(decision: OriginDecision, reason: string): void {
  assert.equal(decision.allow, false, `应拒绝（期望 reason=${reason}）`);
  assert.equal(decision.reason, reason);
}

describe("isLoopbackAddress", () => {
  it("认 IPv4 回环", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
  });

  it("认 IPv6 回环", () => {
    assert.equal(isLoopbackAddress("::1"), true);
  });

  it("认 IPv4-mapped-IPv6 回环", () => {
    // 双栈监听的 Node 服务常见这个形态；漏掉会让本机桌面端被 403。
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  });

  it("不认局域网地址", () => {
    assert.equal(isLoopbackAddress("192.168.1.10"), false);
  });

  it("不认 0.0.0.0（监听地址不是可路由目标）", () => {
    assert.equal(isLoopbackAddress("0.0.0.0"), false);
  });

  it("null 不是回环", () => {
    assert.equal(isLoopbackAddress(null), false);
  });
});

describe("isLocalHost", () => {
  it("localhost 无端口", () => {
    assert.equal(isLocalHost("localhost"), true);
  });

  it("localhost 带端口", () => {
    assert.equal(isLocalHost("localhost:8080"), true);
  });

  it("127.0.0.1 带端口", () => {
    assert.equal(isLocalHost("127.0.0.1:3000"), true);
  });

  it("[::1] 带端口", () => {
    assert.equal(isLocalHost("[::1]:3000"), true);
  });

  it("大小写不敏感", () => {
    assert.equal(isLocalHost("LOCALHOST:1"), true);
  });

  it("0.0.0.0 不算本机 Host（防伪造走进放宽分支）", () => {
    assert.equal(isLocalHost("0.0.0.0:3000"), false);
  });

  it("外部域名不算", () => {
    assert.equal(isLocalHost("dsh.example.com"), false);
  });

  it("null 不算", () => {
    assert.equal(isLocalHost(null), false);
  });
});

describe("originHostOf", () => {
  it("https URL 取出 host:port", () => {
    assert.equal(originHostOf("https://a.example:8443"), "a.example:8443");
  });

  it("file:// 的 host 是空串（与解析失败语义不同）", () => {
    assert.equal(originHostOf("file:///tmp/x.html"), "");
  });

  it("不可解析返回 null", () => {
    assert.equal(originHostOf("null"), null);
  });
});

describe("checkOrigin — 放行分支（6 个）", () => {
  it("① 回环 socket + 缺失 Origin 放行（真正的本机进程）", () => {
    // 本机进程（CLI、内嵌 webview）可能根本不带 Origin。
    assertAllow(
      checkOrigin({ remoteAddress: "127.0.0.1", host: "127.0.0.1:3000", origin: null }),
      "loopback",
    );
  });

  it("① 回环 socket + 本机 Origin 放行（本机页面）", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "127.0.0.1", host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }),
      "loopback",
    );
    assertAllow(
      checkOrigin({ remoteAddress: "::1", host: "localhost:3000", origin: "http://localhost:43120" }),
      "loopback",
    );
  });

  it("🔒 回环 socket + 外部 Origin **必须拒绝**（CSRF 回归）", () => {
    /* 这条是安全回归测试。
     *
     * 宿主 HTTP 服务只监听 `127.0.0.1`，所以**所有**请求的 remoteAddress 都是
     * 回环 —— 包括用户浏览器里恶意页面发起的跨源 fetch。旧实现在这里无条件
     * `return allow`，于是：
     *
     *   fetch('http://127.0.0.1:PORT/redteam/api',
     *         { method: 'POST', body: '{"op":"addCredential",...}' })
     *
     * 从 `https://evil.example` 发起会返回 200 并真的写库。同源策略只阻止
     * **读**响应，不阻止**发**请求。
     *
     * 如果有人把这里改回「无条件放行」，这条会立刻红。
     */
    assertDeny(
      checkOrigin({ remoteAddress: "127.0.0.1", host: "127.0.0.1:3000", origin: "https://evil.example" }),
      "cross-origin",
    );
    assertDeny(
      checkOrigin({ remoteAddress: "::ffff:127.0.0.1", host: "localhost:1", origin: "http://attacker.test" }),
      "cross-origin",
    );
    /* 伪造 Host 也挡不住 —— 判据是 Origin，不是 Host。 */
    assertDeny(
      checkOrigin({ remoteAddress: "127.0.0.1", host: "127.0.0.1:3000", origin: "http://127.0.0.1.evil.example:3000" }),
      "cross-origin",
    );
  });

  it("②-a 本机 Host + Origin 缺失", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: null }),
      "local-host-bare-origin",
    );
  });

  it("②-a 本机 Host + Origin 空串", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "" }),
      "local-host-bare-origin",
    );
  });

  it("②-a 本机 Host + Origin 字面量 null（沙箱 iframe / file 页面）", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "null" }),
      "local-host-bare-origin",
    );
  });

  it("②-b 本机 Host + app:// 自定义协议（桌面外壳）", () => {
    // 这条分支就是「桌面端技能库/知识库/SQLite 全挂」那次事故的修复。
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "app://dsh" }),
      "local-host-app-scheme",
    );
  });

  it("②-b app: 判定大小写不敏感", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "APP://x" }),
      "local-host-app-scheme",
    );
  });

  it("②-c 本机 Host + Origin 的 host 为空（file://）", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "file:///a/b.html" }),
      "local-host-matching-origin",
    );
  });

  it("②-c 本机 Host + Origin 的 host 与 Host 相同", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }),
      "local-host-matching-origin",
    );
  });

  it("⑤ 非本机 Host + Origin 与 Host 完全一致（严格同源）", () => {
    assertAllow(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "https://dsh.example.com" }),
      "same-origin",
    );
  });
});

describe("checkOrigin — 拒绝分支（3 个）", () => {
  it("③ 非本机 Host + Origin 缺失 → missing-origin", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: null }),
      "missing-origin",
    );
  });

  it("③ 非本机 Host + Origin 空串 → missing-origin", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "" }),
      "missing-origin",
    );
  });

  it("④ 非本机 Host + Origin 不可解析 → unparsable-origin", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "null" }),
      "unparsable-origin",
    );
  });

  it("④ 非本机 Host + Origin 的 host 与 Host 不同 → host-mismatch", () => {
    // 这就是主威胁：恶意页面跨源 fetch 本地服务。
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "https://evil.example" }),
      "host-mismatch",
    );
  });

  it("④ 非本机 Host + Origin 是 app:// 也拒绝（放宽只对本机 Host 生效）", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "app://dsh" }),
      "host-mismatch",
    );
  });

  it("④ Origin 的 host 为空但 Host 非本机 → host-mismatch（空 host 不是通配）", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com", origin: "file:///x" }),
      "host-mismatch",
    );
  });

  it("④ 端口不同即不同源", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "10.0.0.5", host: "dsh.example.com:3000", origin: "https://dsh.example.com:3001" }),
      "host-mismatch",
    );
  });
});

describe("checkOrigin — 分支顺序", () => {
  it("回环优先于一切：本机 socket + 本机 Host + 坏 Origin 仍放行", () => {
    // 顺序本身是语义：若把回环判定放到后面，桌面端会被严格路径先拒掉。
    assertAllow(
      checkOrigin({ remoteAddress: "::ffff:127.0.0.1", host: "127.0.0.1:1", origin: "null" }),
      "loopback",
    );
  });

  it("本机 Host 的放宽不适用于非回环 + 外部 Host", () => {
    assertDeny(
      checkOrigin({ remoteAddress: "203.0.113.7", host: "public.example", origin: null }),
      "missing-origin",
    );
  });
});

describe("readOriginFacts", () => {
  it("从完整请求里抽出三个事实", () => {
    const facts = readOriginFacts({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    assert.deepEqual(facts, {
      remoteAddress: "127.0.0.1",
      host: "localhost:3000",
      origin: "http://localhost:3000",
    });
  });

  it("缺 socket / 缺 headers 时给 null，不抛", () => {
    assert.deepEqual(readOriginFacts(null), { remoteAddress: null, host: null, origin: null });
    assert.deepEqual(readOriginFacts({}), { remoteAddress: null, host: null, origin: null });
  });

  it("空串 remoteAddress 归一为 null（不是回环）", () => {
    const facts = readOriginFacts({ socket: { remoteAddress: "" } });
    assert.equal(facts.remoteAddress, null);
  });

  it("数组形态的 header 取首项（中间件可能这么归一）", () => {
    const facts = readOriginFacts({ headers: { host: ["a.example", "b.example"], origin: ["https://a.example"] } });
    assert.equal(facts.host, "a.example");
    assert.equal(facts.origin, "https://a.example");
  });

  it("非字符串 header 归一为 null", () => {
    const facts = readOriginFacts({ headers: { host: undefined, origin: undefined } });
    assert.equal(facts.host, null);
    assert.equal(facts.origin, null);
  });
});
