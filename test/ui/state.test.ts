/**
 * UI 状态测试。
 *
 * 这些函数看起来「只是算术」，但每一条都对应原实现里的具体行为：
 * 几何钳制顺序、`defaultOpen !== false` 的语义、未读判定的**或**关系。
 * 写错了不会报错，只会表现为「面板跑到屏幕外」「折叠点了没反应」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_UI_STATE,
  DEFAULT_VIEWPORT,
  DOCK_DEFAULT_WIDTH,
  DOCK_MIN_HEIGHT,
  DOCK_MIN_WIDTH,
  ENGAGEMENT_TABS,
  TABS,
  applyUiPatch,
  clampDockGeometry,
  defaultDockGeometry,
  hasUnread,
  isSectionOpen,
  markSeen,
  normalizeDigest,
  setSections,
  toggleSection,
  type ConsoleTabId,
} from "../../src/redteam/client/state.js";

describe("状态补丁", () => {
  it("默认打开且停在资产测绘", () => {
    assert.equal(DEFAULT_UI_STATE.open, true);
    assert.equal(DEFAULT_UI_STATE.tab, "assets");
  });

  it("补丁只改指定字段", () => {
    const next = applyUiPatch(DEFAULT_UI_STATE, { tab: "scores" });
    assert.equal(next.tab, "scores");
    assert.equal(next.open, true, "未指定的 open 应保持");
  });

  it("不修改原对象", () => {
    const before = { ...DEFAULT_UI_STATE };
    applyUiPatch(DEFAULT_UI_STATE, { open: false });
    assert.deepEqual({ ...DEFAULT_UI_STATE }, before);
  });
});

describe("TABS", () => {
  it("标签栏有 10 个页签", () => {
    assert.equal(TABS.length, 10);
  });

  it("第一个是资产测绘（默认页）", () => {
    assert.equal(TABS[0]?.id, "assets");
  });

  it("id 不重复", () => {
    const ids = TABS.map((tab) => tab.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("每个页签都有非空显示名", () => {
    for (const tab of TABS) {
      assert.ok(tab.label.length > 0, `${tab.id} 缺显示名`);
    }
  });

  it("已冻结（防止运行期被改）", () => {
    assert.equal(Object.isFrozen(TABS), true);
  });
});

describe("ENGAGEMENT_TABS", () => {
  it("资产测绘需要靶标", () => {
    assert.equal(ENGAGEMENT_TABS.has("assets"), true);
  });

  it("知识库 / 环境 / 技能库不需要靶标（全局页）", () => {
    for (const tab of ["knowledge", "env", "skills"] as const) {
      assert.equal(ENGAGEMENT_TABS.has(tab), false, `${tab} 不该要求靶标`);
    }
  });

  it("testing / attackfiles 别名归入需要靶标", () => {
    assert.equal(ENGAGEMENT_TABS.has("testing"), true);
    assert.equal(ENGAGEMENT_TABS.has("attackfiles"), true);
  });

  it("集合里每个 id 都是合法页签（防手抄错）", () => {
    const valid: ReadonlySet<ConsoleTabId> = new Set<ConsoleTabId>([
      "assets", "env", "agents", "sessions", "findings", "chain",
      "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
    ]);
    for (const tab of ENGAGEMENT_TABS) {
      assert.equal(valid.has(tab), true, `${tab} 不是合法页签`);
    }
  });
});

describe("clampDockGeometry — 钳制规则", () => {
  it("正常值原样通过", () => {
    const result = clampDockGeometry({ x: 10, y: 20, w: 500, h: 400 }, { width: 1280, height: 800 });
    assert.deepEqual(result, { x: 10, y: 20, w: 500, h: 400 });
  });

  it("宽度小于最小宽 → 提到最小宽", () => {
    const result = clampDockGeometry({ w: 100 }, DEFAULT_VIEWPORT);
    assert.equal(result.w, DOCK_MIN_WIDTH);
  });

  it("高度小于最小高 → 提到最小高", () => {
    const result = clampDockGeometry({ h: 10 }, DEFAULT_VIEWPORT);
    assert.equal(result.h, DOCK_MIN_HEIGHT);
  });

  it("宽度超过视口 → 收到视口宽", () => {
    const result = clampDockGeometry({ w: 5000 }, { width: 800, height: 600 });
    assert.equal(result.w, 800);
  });

  it("视口比最小宽还窄时取最小宽（宁可溢出也不压成不可用）", () => {
    const result = clampDockGeometry({ w: 100 }, { width: 200, height: 200 });
    assert.equal(result.w, DOCK_MIN_WIDTH);
  });

  it("x 为负 → 0", () => {
    assert.equal(clampDockGeometry({ x: -100 }, DEFAULT_VIEWPORT).x, 0);
  });

  it("y 为负 → 0", () => {
    assert.equal(clampDockGeometry({ y: -50 }, DEFAULT_VIEWPORT).y, 0);
  });

  it("x 超右边界 → 收到 vw - w（先钳尺寸再钳位置）", () => {
    const result = clampDockGeometry({ x: 2000, w: 600 }, { width: 1000, height: 700 });
    assert.equal(result.x, 400, "1000 - 600 = 400");
  });

  it("y 超下边界 → 收到 vh - h", () => {
    const result = clampDockGeometry({ y: 2000, h: 400 }, { width: 1000, height: 700 });
    assert.equal(result.y, 300, "700 - 400 = 300");
  });

  it("NaN / undefined 回退到默认值（不产生 NaN 几何）", () => {
    const result = clampDockGeometry({ x: Number.NaN, w: undefined }, DEFAULT_VIEWPORT);
    assert.equal(Number.isFinite(result.x), true);
    assert.equal(Number.isFinite(result.w), true);
    assert.equal(result.w, DOCK_DEFAULT_WIDTH);
  });

  it("Infinity 也回退（不产生 Infinity 几何）", () => {
    const result = clampDockGeometry({ w: Number.POSITIVE_INFINITY }, DEFAULT_VIEWPORT);
    assert.equal(Number.isFinite(result.w), true);
  });

  it("空对象得到可用几何", () => {
    const result = clampDockGeometry({}, DEFAULT_VIEWPORT);
    assert.ok(result.w >= DOCK_MIN_WIDTH);
    assert.ok(result.h >= DOCK_MIN_HEIGHT);
  });
});

describe("defaultDockGeometry", () => {
  it("贴右上角", () => {
    const viewport = { width: 1280, height: 800 };
    const result = defaultDockGeometry(viewport, null);
    assert.equal(result.y, 12);
    assert.equal(result.x, viewport.width - DOCK_DEFAULT_WIDTH - 12);
  });

  it("沿用上次宽度（合法范围内）", () => {
    const result = defaultDockGeometry(DEFAULT_VIEWPORT, 900);
    assert.equal(result.w, 900);
  });

  it("上次宽度过小 → 忽略，用默认宽", () => {
    const result = defaultDockGeometry(DEFAULT_VIEWPORT, 100);
    assert.equal(result.w, DOCK_DEFAULT_WIDTH);
  });

  it("上次宽度过大 → 忽略，用默认宽", () => {
    const result = defaultDockGeometry(DEFAULT_VIEWPORT, 5000);
    assert.equal(result.w, DOCK_DEFAULT_WIDTH);
  });

  it("高度不超出上限", () => {
    const result = defaultDockGeometry({ width: 1280, height: 2000 }, null);
    assert.ok(result.h <= 640, "高度上限 640");
  });
});

describe("isSectionOpen — defaultOpen 语义", () => {
  it("没记过 + 不传 defaultOpen → 展开", () => {
    assert.equal(isSectionOpen({}, "k"), true);
  });

  it("没记过 + defaultOpen=true → 展开", () => {
    assert.equal(isSectionOpen({}, "k", true), true);
  });

  it("没记过 + defaultOpen=false → 折叠（这是容易写错的一条）", () => {
    assert.equal(isSectionOpen({}, "k", false), false);
  });

  it("记过 true → 展开（即使 defaultOpen=false）", () => {
    assert.equal(isSectionOpen({ k: true }, "k", false), true);
  });

  it("记过 false → 折叠（即使 defaultOpen=true）", () => {
    assert.equal(isSectionOpen({ k: false }, "k", true), false);
  });
});

describe("toggleSection / setSections", () => {
  it("切换展开 → 折叠", () => {
    assert.deepEqual(toggleSection({ k: true }, "k"), { k: false });
  });

  it("切换折叠 → 展开", () => {
    assert.deepEqual(toggleSection({ k: false }, "k"), { k: true });
  });

  it("切换没记过的项（按 defaultOpen 取反）", () => {
    assert.deepEqual(toggleSection({}, "k", true), { k: false });
    assert.deepEqual(toggleSection({}, "k", false), { k: true });
  });

  it("不修改原状态", () => {
    const state = { k: true };
    toggleSection(state, "k");
    assert.deepEqual(state, { k: true });
  });

  it("setSections 批量设置", () => {
    assert.deepEqual(setSections({ a: true }, ["a", "b"], false), { a: false, b: false });
  });

  it("setSections 空列表不改动", () => {
    assert.deepEqual(setSections({ a: true }, [], false), { a: true });
  });
});

describe("hasUnread — 或关系", () => {
  it("没有当前指针 → 不算新（无可比）", () => {
    assert.equal(hasUnread(undefined, undefined), false);
  });

  it("有当前、无历史 → 算新", () => {
    assert.equal(hasUnread(undefined, { count: 1, at: "2026-01-01T00:00:00" }), true);
  });

  it("条数变多 → 算新", () => {
    assert.equal(
      hasUnread({ count: 1, at: "2026-01-01T00:00:00" }, { count: 2, at: "2026-01-01T00:00:00" }),
      true,
    );
  });

  it("条数相同但时间更晚 → 算新（删两条加两条也能发现）", () => {
    assert.equal(
      hasUnread({ count: 2, at: "2026-01-01T00:00:00" }, { count: 2, at: "2026-01-02T00:00:00" }),
      true,
    );
  });

  it("条数相同、时间相同 → 不算新", () => {
    assert.equal(
      hasUnread({ count: 2, at: "2026-01-01T00:00:00" }, { count: 2, at: "2026-01-01T00:00:00" }),
      false,
    );
  });

  it("条数变少、时间更晚 → 算新（有新内容）", () => {
    assert.equal(
      hasUnread({ count: 5, at: "2026-01-01T00:00:00" }, { count: 3, at: "2026-01-03T00:00:00" }),
      true,
    );
  });

  it("时间为空串时不靠时间判新", () => {
    assert.equal(hasUnread({ count: 1, at: "" }, { count: 1, at: "" }), false);
  });

  it("at 为 null 时不抛", () => {
    assert.equal(hasUnread({ count: 1, at: null }, { count: 1, at: null }), false);
  });
});

describe("markSeen", () => {
  it("写入当前指针", () => {
    const next = markSeen({}, "assets", { count: 3, at: "2026-01-01T00:00:00" });
    assert.deepEqual(next["assets"], { count: 3, at: "2026-01-01T00:00:00" });
  });

  it("没有当前指针时原样返回", () => {
    const state = { assets: { count: 1, at: null } };
    assert.equal(markSeen(state, "assets", undefined), state);
  });

  it("标记后该页签不再算新", () => {
    const current = { count: 3, at: "2026-01-01T00:00:00" };
    const seen = markSeen({}, "assets", current);
    assert.equal(hasUnread(seen["assets"], current), false);
  });
});

describe("normalizeDigest", () => {
  it("归一正常 digest", () => {
    const result = normalizeDigest({ assets: { count: 3, at: "t1" } });
    assert.deepEqual(result["assets"], { count: 3, at: "t1" });
  });

  it("count 是字符串时转数字（SQLite 聚合的形态）", () => {
    const result = normalizeDigest({ assets: { count: "7", at: "t" } });
    assert.equal(result["assets"]?.count, 7);
  });

  it("count 缺失 → 0", () => {
    assert.equal(normalizeDigest({ assets: { at: "t" } })["assets"]?.count, 0);
  });

  it("count 非数字 → 0", () => {
    assert.equal(normalizeDigest({ assets: { count: "abc" } })["assets"]?.count, 0);
  });

  it("at 非字符串 → null", () => {
    assert.equal(normalizeDigest({ assets: { count: 1, at: 42 } })["assets"]?.at, null);
  });

  it("非对象输入 → 空", () => {
    assert.deepEqual(normalizeDigest(null), {});
    assert.deepEqual(normalizeDigest("x"), {});
    assert.deepEqual(normalizeDigest([1, 2]), {});
  });

  it("值的形态不对时跳过该项", () => {
    assert.deepEqual(normalizeDigest({ assets: "bad", vulns: { count: 1, at: null } }), {
      vulns: { count: 1, at: null },
    });
  });
});
