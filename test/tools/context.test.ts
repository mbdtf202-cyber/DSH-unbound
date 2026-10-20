/**
 * 工具层共享上下文的测试。
 *
 * 重点在**会话隔离**：这是 v0.9.0 之前真实串过数据的地方。
 * 多会话并行时靶标挑错，会把 A 单位的成果写进 B 单位的库、A 的报告里出现 B 的数据。
 * 这类错误不会报错，只会让交付物变成假的。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ToolExecContext } from "../../src/host-api/types.js";
import {
  BINDINGS_CAP,
  CappedMap,
  addReservation,
  agentOf,
  bindKeysOf,
  bindingKeyOf,
  bindingViewOf,
  bindings,
  dropOldestReservation,
  dropReservation,
  reservationList,
  reservations,
  resetToolState,
  resolveEngagement,
  resolveRootSession,
  sessionInfoOf,
  sessionOf,
  splitList,
} from "../../src/redteam/tools/context.js";

/** 造一个会话对象（含 header 与可选 store）。 */
function mkSession(
  id: string,
  parentSession?: string,
  store?: { get: (id: string) => unknown },
): Record<string, unknown> {
  return {
    id,
    header: parentSession === undefined ? {} : { parentSession },
    ...(store === undefined ? {} : { store }),
  };
}

/** 把会话包成工具 exec。 */
function mkExec(session: unknown): ToolExecContext {
  return { agent: { session } } as unknown as ToolExecContext;
}

/** 造一个内存会话存储。 */
function mkStore(sessions: Record<string, unknown>): { get: (id: string) => unknown } {
  return {
    get: (id: string): unknown => sessions[id],
  };
}

beforeEach(() => {
  resetToolState();
});

describe("sessionInfoOf", () => {
  it("取出 id 与 parentId", () => {
    const info = sessionInfoOf(mkExec(mkSession("s1", "p1")));
    assert.equal(info.id, "s1");
    assert.equal(info.parentId, "p1");
  });

  it("没有父会话时 parentId 为 undefined", () => {
    assert.equal(sessionInfoOf(mkExec(mkSession("s1"))).parentId, undefined);
  });

  it("数字 id 被转成字符串（宿主两面类型不一致）", () => {
    const info = sessionInfoOf(mkExec({ id: 42, header: {} }));
    assert.equal(info.id, "42");
  });

  it("缺 agent / session 时返回空对象，不抛", () => {
    assert.deepEqual(sessionInfoOf(undefined), {});
    assert.deepEqual(sessionInfoOf(null), {});
    assert.deepEqual(sessionInfoOf({} as ToolExecContext), {});
    assert.deepEqual(sessionInfoOf({ agent: {} } as unknown as ToolExecContext), {});
    assert.deepEqual(sessionInfoOf({ agent: { session: null } } as unknown as ToolExecContext), {});
  });

  it("header 缺失时不炸（子智能体继承靠它，但不能假设一定有）", () => {
    const info = sessionInfoOf(mkExec({ id: "s1" }));
    assert.equal(info.id, "s1");
    assert.equal(info.parentId, undefined);
  });

  it("parentSession 为 null 时当作无父", () => {
    assert.equal(sessionInfoOf(mkExec({ id: "s", header: { parentSession: null } })).parentId, undefined);
  });

  it("sessionOf 是 sessionInfoOf().id 的简写", () => {
    assert.equal(sessionOf(mkExec(mkSession("s9"))), "s9");
    assert.equal(sessionOf(undefined), undefined);
  });
});

describe("resolveRootSession", () => {
  it("单层会话的根是自己", () => {
    const r = resolveRootSession(mkSession("only"));
    assert.equal(r.rootId, "only");
    assert.deepEqual(r.chain, ["only"]);
  });

  it("沿 parentSession 走到顶层，chain 记录全路径", () => {
    const root = mkSession("root");
    const mid = mkSession("mid", "root", mkStore({ root }));
    const leaf = mkSession("leaf", "mid", mkStore({ root, mid }));
    const r = resolveRootSession(leaf);
    assert.equal(r.rootId, "root");
    assert.deepEqual(r.chain, ["leaf", "mid", "root"]);
  });

  it("父会话不在内存时，父 id 直接当根键（冷启动 / 被回收）", () => {
    const orphan = mkSession("leaf", "gone-parent", mkStore({}));
    const r = resolveRootSession(orphan);
    assert.equal(r.rootId, "gone-parent");
    assert.deepEqual(r.chain, ["leaf", "gone-parent"]);
  });

  it("环路防护：parentSession 成环时不死循环", () => {
    const a: Record<string, unknown> = { id: "a", header: { parentSession: "b" } };
    const b: Record<string, unknown> = { id: "b", header: { parentSession: "a" } };
    const store = mkStore({ a, b });
    a["store"] = store;
    b["store"] = store;
    const r = resolveRootSession(a);
    /* 不死循环即达标；具体停在哪一层不重要 */
    assert.equal(Array.isArray(r.chain), true);
    assert.equal(r.chain.length <= 64, true);
  });

  it("store.get 抛异常时不炸", () => {
    const s = mkSession("leaf", "p", {
      get: () => {
        throw new Error("boom");
      },
    });
    const r = resolveRootSession(s);
    assert.equal(r.rootId, "p");
  });

  it("非会话输入返回空 chain", () => {
    assert.deepEqual(resolveRootSession(undefined).chain, []);
    assert.deepEqual(resolveRootSession({}).chain, []);
  });
});

describe("bindingKeyOf / bindKeysOf", () => {
  it("rootId 是根会话，sessionId 是当前会话", () => {
    const root = mkSession("root");
    const leaf = mkSession("leaf", "root", mkStore({ root }));
    const k = bindingKeyOf(mkExec(leaf));
    assert.equal(k.rootId, "root");
    assert.equal(k.sessionId, "leaf");
  });

  it("取不到会话时返回空 chain", () => {
    assert.deepEqual(bindingKeyOf(undefined).chain, []);
  });

  it("bindKeysOf 去重并包含全链", () => {
    const root = mkSession("root");
    const mid = mkSession("mid", "root", mkStore({ root }));
    const leaf = mkSession("leaf", "mid", mkStore({ root, mid }));
    const keys = bindKeysOf(mkExec(leaf));
    assert.deepEqual([...keys].sort(), ["leaf", "mid", "root"]);
  });
});

describe("CappedMap", () => {
  it("到达上限后淘汰最老的一条（FIFO）", () => {
    const m = new CappedMap<number>(3);
    m.set("a", 1).set("b", 2).set("c", 3);
    assert.equal(m.size, 3);
    m.set("d", 4);
    assert.equal(m.size, 3, "不应超过上限");
    assert.equal(m.has("a"), false, "最老的 a 应被淘汰");
    assert.equal(m.has("d"), true);
  });

  it("覆盖已存在的键不触发淘汰", () => {
    const m = new CappedMap<number>(2);
    m.set("a", 1).set("b", 2);
    m.set("a", 99);
    assert.equal(m.size, 2);
    assert.equal(m.get("a"), 99);
    assert.equal(m.has("b"), true);
  });

  it("容量常量与实现一致（防手滑改小）", () => {
    const m = new CappedMap<number>(BINDINGS_CAP);
    assert.equal(BINDINGS_CAP, 500);
    assert.equal(m.size, 0);
  });

  it("delete / keys / entries 正常", () => {
    const m = new CappedMap<string>(5);
    m.set("a", "1");
    assert.deepEqual([...m.keys()], ["a"]);
    assert.deepEqual([...m.entries()], [["a", "1"]]);
    assert.equal(m.delete("a"), true);
    assert.equal(m.get("a"), undefined);
  });
});

describe("resolveEngagement —— 会话隔离", () => {
  const storeOf = (list: readonly { id: string; name: string; created_at: string }[], active?: string) => ({
    activeEngagementId: (): string | undefined => active,
    listEngagements: (): readonly { id: string; name: string; created_at: string }[] => list,
  });

  it("显式传入优先级最高", () => {
    const store = storeOf([{ id: "e1", name: "A", created_at: "t" }]);
    assert.equal(resolveEngagement(store, mkExec(mkSession("s")), "explicit"), "explicit");
  });

  it("本会话绑定优先于全局当前靶标", () => {
    const store = storeOf([{ id: "e1", name: "A", created_at: "t" }], "e1");
    const exec = mkExec(mkSession("s"));
    bindings.set("s", "bound-by-me");
    assert.equal(resolveEngagement(store, exec, undefined), "bound-by-me");
  });

  it("子智能体继承父会话绑定（沿链查找）", () => {
    const root = mkSession("root");
    const leaf = mkSession("leaf", "root", mkStore({ root }));
    bindings.set("root", "e-root");
    assert.equal(resolveEngagement(storeOf([]), mkExec(leaf), undefined), "e-root");
  });

  it("只有一个靶标时自动绑定（首次使用的顺滑路径）", () => {
    const store = storeOf([{ id: "only", name: "A", created_at: "t" }]);
    const exec = mkExec(mkSession("s"));
    assert.equal(resolveEngagement(store, exec, undefined), "only");
    assert.equal(bindings.get("s"), "only", "应顺手记住绑定");
  });

  it("全局靶标被别的会话占用时报错，绝不静默串写", () => {
    const store = storeOf([{ id: "e1", name: "A", created_at: "t" }], "e1");
    /* 另一个会话先占住了 e1 */
    bindings.set("other-session", "e1");
    const exec = mkExec(mkSession("mine"));
    assert.throws(() => resolveEngagement(store, exec, undefined), /已被另一个会话占用/);
    /* 关键：报错而不是"就用 e1" */
    assert.equal(bindings.get("mine"), undefined);
  });

  it("无绑定且多个靶标时报错（要求显式选择）", () => {
    const store = storeOf([
      { id: "e1", name: "A", created_at: "t" },
      { id: "e2", name: "B", created_at: "t" },
    ]);
    assert.throws(() => resolveEngagement(store, mkExec(mkSession("s")), undefined), /尚未绑定靶标/);
  });

  it("无绑定且零靶标时也报错", () => {
    assert.throws(() => resolveEngagement(storeOf([]), mkExec(mkSession("s")), undefined), /尚未绑定靶标/);
  });

  it("空字符串显式参数不算显式（当没传）", () => {
    const store = storeOf([{ id: "only", name: "A", created_at: "t" }]);
    assert.equal(resolveEngagement(store, mkExec(mkSession("s")), ""), "only");
  });

  it("两个会话各自绑定互不影响", () => {
    const store = storeOf([], undefined);
    const execA = mkExec(mkSession("A"));
    const execB = mkExec(mkSession("B"));
    bindings.set("A", "e-a");
    bindings.set("B", "e-b");
    assert.equal(resolveEngagement(store, execA, undefined), "e-a");
    assert.equal(resolveEngagement(store, execB, undefined), "e-b");
  });
});

describe("bindingViewOf", () => {
  it("主会话视图", () => {
    const v = bindingViewOf(mkExec(mkSession("s")));
    assert.equal(v.session_id, "s");
    assert.equal(v.parent_session, null);
    assert.equal(v.is_subagent, false);
    assert.deepEqual(v.session_chain, ["s"]);
  });

  it("子智能体视图标记 is_subagent", () => {
    const root = mkSession("root");
    const leaf = mkSession("leaf", "root", mkStore({ root }));
    const v = bindingViewOf(mkExec(leaf));
    assert.equal(v.is_subagent, true);
    assert.equal(v.parent_session, "root");
    assert.equal(v.root_session, "root");
  });

  it("已绑定时回显 bound_engagement", () => {
    bindings.set("s", "e-1");
    assert.equal(bindingViewOf(mkExec(mkSession("s"))).bound_engagement, "e-1");
  });

  it("未绑定时为 null", () => {
    assert.equal(bindingViewOf(mkExec(mkSession("s"))).bound_engagement, null);
  });

  it("取不到会话时全 null，不抛", () => {
    const v = bindingViewOf(undefined);
    assert.equal(v.session_id, null);
    assert.equal(v.root_session, null);
    assert.equal(v.bound_engagement, null);
  });
});

describe("并发预留", () => {
  it("加/列/删", () => {
    addReservation("r1", "k1");
    assert.equal(reservationList("r1").length, 1);
    assert.equal(dropReservation("r1", "k1"), true);
    assert.equal(reservationList("r1").length, 0);
  });

  it("无 key 时只释放最早的一条（清空会超卖名额）", () => {
    addReservation("r1", "first");
    /* 时间戳可能相同，靠插入顺序；这里强制错开 */
    const map = reservations.get("r1");
    assert.notEqual(map, undefined);
    map?.set("first", 1000);
    addReservation("r1", "second");
    map?.set("second", 2000);
    assert.equal(dropReservation("r1", undefined), true);
    const left = reservationList("r1");
    assert.equal(left.length, 1, "只该少一条");
    assert.equal(left[0]?.key, "second");
  });

  it("表里没东西时 delete 返回 false", () => {
    assert.equal(dropReservation("nope", "k"), false);
    assert.equal(dropReservation("nope", undefined), false);
  });

  it("dropOldestReservation 等价于无 key 的 dropReservation", () => {
    addReservation("r2", "a");
    assert.equal(dropOldestReservation("r2"), true);
    assert.equal(reservationList("r2").length, 0);
  });

  it("不同根会话的预留互不干扰", () => {
    addReservation("r1", "a");
    addReservation("r2", "b");
    dropReservation("r1", "a");
    assert.equal(reservationList("r2").length, 1);
  });

  it("同一根会话下同一 key 重复加只算一条", () => {
    addReservation("r1", "dup");
    addReservation("r1", "dup");
    assert.equal(reservationList("r1").length, 1);
  });
});

describe("splitList", () => {
  it("逗号 / 中文逗号 / 空白都能分", () => {
    assert.deepEqual(splitList("a,b"), ["a", "b"]);
    assert.deepEqual(splitList("a，b"), ["a", "b"]);
    assert.deepEqual(splitList("a b  c"), ["a", "b", "c"]);
  });

  it("去空白与空项", () => {
    assert.deepEqual(splitList("  a , , b  "), ["a", "b"]);
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(splitList(""), []);
    assert.deepEqual(splitList(null), []);
    assert.deepEqual(splitList(undefined), []);
  });

  it("混合分隔符", () => {
    assert.deepEqual(splitList("a,b c，d"), ["a", "b", "c", "d"]);
  });
});

describe("agentOf", () => {
  it("显式角色优先", () => {
    assert.equal(agentOf({ agent: "recon" }, "plan"), "recon");
  });

  it("缺省用主会话角色", () => {
    assert.equal(agentOf({}, "plan"), "plan");
    assert.equal(agentOf({ agent: "" }, "plan"), "plan");
    assert.equal(agentOf({ agent: "   " }, "plan"), "plan");
  });

  it("trim 掉空白", () => {
    assert.equal(agentOf({ agent: "  exploit  " }, "plan"), "exploit");
  });
});
