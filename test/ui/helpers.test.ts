/**
 * 纯助手测试。
 *
 * 重点：`formatTimestamp` / `formatTimestampShort` 的**行为与原生实现逐字等价**。
 * 这两处看着像 bug（不做真日期解析、不做时区转换），但它们是界面与报告
 * 已经定型的样子，所以这里用原实现的表达式做**对照断言** ——
 * 任何人「顺手修好」它们，测试就会红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FULL_WINDOW_HASH,
  arrayOf,
  clickable,
  compactQuery,
  cx,
  dataOpen,
  formatTimestamp,
  formatTimestampShort,
  fullWindowUrl,
  isFailure,
  isFullWindowHash,
  messageOf,
  numberOf,
  optionEntries,
  pairToTab,
  recordOf,
  shotCacheKey,
  shotDataUrl,
  stringOf,
} from "../../src/redteam/client/helpers.js";
import type { MinimalPointerEventLike } from "../../src/redteam/client/h.js";

/** 造一个最小的键盘/鼠标事件。 */
function event(overrides: Partial<MinimalPointerEventLike> = {}): MinimalPointerEventLike & {
  prevented: number;
  stopped: number;
} {
  const state = { prevented: 0, stopped: 0 };
  return {
    ...overrides,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      state.prevented += 1;
      (this as unknown as { prevented: number }).prevented = state.prevented;
    },
    stopPropagation() {
      state.stopped += 1;
      (this as unknown as { stopped: number }).stopped = state.stopped;
    },
  };
}

describe("clickable — 键盘可达性", () => {
  it("给出 role=button 与 tabIndex=0", () => {
    const props = clickable(() => {});
    assert.equal(props.role, "button");
    assert.equal(props.tabIndex, 0);
  });

  it("点击触发回调", () => {
    let calls = 0;
    const props = clickable(() => { calls += 1; });
    props.onClick(event());
    assert.equal(calls, 1);
  });

  it("Enter 触发回调并 preventDefault", () => {
    let calls = 0;
    const props = clickable(() => { calls += 1; });
    const e = event({ key: "Enter" });
    props.onKeyDown(e);
    assert.equal(calls, 1);
    assert.equal(e.prevented, 1);
  });

  it("Space 触发回调并 preventDefault（防页面滚动）", () => {
    let calls = 0;
    const props = clickable(() => { calls += 1; });
    const e = event({ key: " " });
    props.onKeyDown(e);
    assert.equal(calls, 1);
    assert.equal(e.prevented, 1);
  });

  it("其它键不触发", () => {
    let calls = 0;
    const props = clickable(() => { calls += 1; });
    for (const key of ["a", "Escape", "Tab", "ArrowDown"]) {
      const e = event({ key });
      props.onKeyDown(e);
      assert.equal(e.prevented, 0, `${key} 不该 preventDefault`);
    }
    assert.equal(calls, 0);
  });

  it("label 进 aria-label", () => {
    assert.equal(clickable(() => {}, { label: "全部 C 段" })["aria-label"], "全部 C 段");
  });

  it("不传 label 时**没有** aria-label 键（不是空串）", () => {
    assert.equal("aria-label" in clickable(() => {}), false);
  });

  it("expanded=true → aria-expanded='true'", () => {
    assert.equal(clickable(() => {}, { expanded: true })["aria-expanded"], "true");
  });

  it("expanded=false → aria-expanded='false'（不是省略）", () => {
    assert.equal(clickable(() => {}, { expanded: false })["aria-expanded"], "false");
  });

  it("不传 expanded 时没有该键", () => {
    assert.equal("aria-expanded" in clickable(() => {}), false);
  });

  it("回调收到同一个事件对象", () => {
    let received: MinimalPointerEventLike | null = null;
    const props = clickable((e) => { received = e; });
    const e = event({ key: "Enter" });
    props.onKeyDown(e);
    assert.equal(received, e);
  });
});

describe("formatTimestamp — 行为与原生表达式等价", () => {
  /** 原实现：`(s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')` */
  const original = (s: unknown): string =>
    s ? String(s).replace("T", " ").slice(0, 16) : "—";

  const samples: readonly unknown[] = [
    "2026-01-02T03:04:05.678Z",
    "2026-01-02 03:04:05",
    "2026-01-02T03:04:05+08:00",
    "2026-01-02",
    "",
    null,
    undefined,
    0,
    42,
    "no-t-at-all",
    "T",
  ];

  it("逐样本与原生实现一致", () => {
    for (const sample of samples) {
      assert.equal(
        formatTimestamp(sample),
        original(sample),
        `输入 ${JSON.stringify(sample)} 与原生不一致`,
      );
    }
  });

  /**
   * 这条用例锁的是**原实现的裸真值语义**，不是"测试 0 怎么显示"。
   *
   * 原实现为 `s ? String(s).replace('T',' ').slice(0,16) : '—'`：
   * `0` 落进 falsy 分支 → 显示 `—`（"无数据"）。
   *
   * ⚠️ 后人注意：**不要**把它换成"更干净"的判断
   * （如 `value === null || value === undefined || value === ""`）。
   * 那样 `0` 会被格式化成 `1970-01-01 08:00` —— 一个**看起来完全合法**的
   * 时间戳，不报错、不告警，用户会以为是数据问题而不是显示 bug。
   * 这类"合理但错误"的结果是最难查的一类。
   *
   * 迁移时我正好犯过这个错（换成三段判断），是这条逐样本对照把它抓回来的。
   */
  it("**锁住裸真值语义**：falsy 输入（含 0）一律显示 —，不得格式化成 1970", () => {
    assert.equal(formatTimestamp("2026-01-02T03:04:05.678Z"), "2026-01-02 03:04");
  });

  it("空值给破折号", () => {
    assert.equal(formatTimestamp(null), "—");
    assert.equal(formatTimestamp(""), "—");
    assert.equal(formatTimestamp(undefined), "—");
  });

  it("超过 16 字符的部分被截掉（秒与时区不显示）", () => {
    assert.equal(formatTimestamp("2026-01-02T03:04:05"), "2026-01-02 03:04");
  });
});

describe("formatTimestampShort — 行为与原生表达式等价", () => {
  /** 原实现：先 replace，再 `length >= 16 ? slice(5,16) : text || '—'` */
  const original = (s: unknown): string => {
    const t = String(s ?? "").replace("T", " ");
    return t.length >= 16 ? t.slice(5, 16) : t || "—";
  };

  const samples: readonly unknown[] = [
    "2026-01-02T03:04:05.678Z",
    "2026-01-02 03:04:05",
    "2026-01-02",
    "",
    null,
    0,
    "short",
  ];

  it("逐样本与原生实现一致", () => {
    for (const sample of samples) {
      assert.equal(formatTimestampShort(sample), original(sample), `输入 ${JSON.stringify(sample)}`);
    }
  });

  it("长串取 'MM-DD HH:MM'", () => {
    assert.equal(formatTimestampShort("2026-01-02T03:04:05"), "01-02 03:04");
  });

  it("短串原样返回", () => {
    assert.equal(formatTimestampShort("2026-01-02"), "2026-01-02");
  });

  it("空值给破折号", () => {
    assert.equal(formatTimestampShort(null), "—");
    assert.equal(formatTimestampShort(""), "—");
  });
});

describe("messageOf", () => {
  it("Error 取 message", () => {
    assert.equal(messageOf(new Error("boom")), "boom");
  });

  it("字符串原样", () => {
    assert.equal(messageOf("plain"), "plain");
  });

  it("带 message 的对象取 message", () => {
    assert.equal(messageOf({ message: "nested" }), "nested");
  });

  it("其余 String() 化", () => {
    assert.equal(messageOf(42), "42");
    assert.equal(messageOf(null), "null");
    assert.equal(messageOf({ a: 1 }), "[object Object]");
  });
});

describe("isFailure", () => {
  it("null / undefined → 失败", () => {
    assert.equal(isFailure(null), true);
    assert.equal(isFailure(undefined), true);
  });

  it("{ok:false} → 失败", () => {
    assert.equal(isFailure({ ok: false, error: "x" }), true);
  });

  it("{ok:true} → 不是失败", () => {
    assert.equal(isFailure({ ok: true }), false);
  });

  it("没有 ok 字段的对象 → 不是失败（可能是裸数组字段）", () => {
    assert.equal(isFailure({ items: [] }), false);
  });

  it("原始值 → 不是失败", () => {
    assert.equal(isFailure("text"), false);
    assert.equal(isFailure(42), false);
  });
});

describe("字段读取助手", () => {
  const response: Readonly<Record<string, unknown>> = {
    items: [1, 2],
    stats: { total: 3 },
    count: "7",
    name: "x",
    notArray: { a: 1 },
    notObject: [1],
  };

  it("arrayOf 取数组，形态不对给空数组", () => {
    assert.deepEqual(arrayOf(response, "items"), [1, 2]);
    assert.deepEqual(arrayOf(response, "notArray"), []);
    assert.deepEqual(arrayOf(response, "missing"), []);
    assert.deepEqual(arrayOf(null, "items"), []);
  });

  it("recordOf 取对象，数组不算对象", () => {
    assert.deepEqual(recordOf(response, "stats"), { total: 3 });
    assert.equal(recordOf(response, "notObject"), null);
    assert.equal(recordOf(response, "missing"), null);
  });

  it("numberOf 转换字符串数字，非数字给 0", () => {
    assert.equal(numberOf(response, "count"), 7);
    assert.equal(numberOf(response, "missing"), 0);
    assert.equal(numberOf({ x: "abc" }, "x"), 0);
    assert.equal(numberOf({ x: Number.NaN }, "x"), 0);
  });

  it("stringOf 取字符串，非字符串给空串", () => {
    assert.equal(stringOf(response, "name"), "x");
    // `count` 的值本身就是字符串 "7"，所以 stringOf 原样返回它；
    // 非字符串（这里是数组）才给空串。
    assert.equal(stringOf(response, "count"), "7");
    assert.equal(stringOf(response, "items"), "");
    assert.equal(stringOf(null, "name"), "");
  });
});

describe("cx — className 拼接", () => {
  it("拼接多个类名", () => {
    assert.equal(cx("a", "b", "c"), "a b c");
  });

  it("跳过 false / null / undefined / 空串", () => {
    assert.equal(cx("a", false, null, undefined, "", "b"), "a b");
  });

  it("全空给空串", () => {
    assert.equal(cx(false, null, undefined), "");
  });

  it("不会把两个类名粘成一个（原实现 `'a'+'b'` 的坑）", () => {
    assert.equal(cx("rt-btn", "on"), "rt-btn on");
    assert.notEqual(cx("rt-btn", "on"), "rt-btnon");
  });

  it("支持条件类名的常见写法", () => {
    const active = true;
    const disabled = false;
    assert.equal(cx("rt-tab", active && "on", disabled && "off"), "rt-tab on");
  });
});

describe("compactQuery", () => {
  it("去掉空串 / null / undefined", () => {
    assert.deepEqual(
      compactQuery({ a: "x", b: "", c: null, d: undefined, e: 1 }),
      { a: "x", e: 1 },
    );
  });

  it("保留 false（是有效筛选值）", () => {
    assert.deepEqual(compactQuery({ showAll: false }), { showAll: false });
  });

  it("保留 0", () => {
    assert.deepEqual(compactQuery({ offset: 0 }), { offset: 0 });
  });

  it("空对象给空对象", () => {
    assert.deepEqual(compactQuery({}), {});
  });
});

describe("optionEntries", () => {
  const table = { high: "高", medium: "中", low: "低" } as const;

  it("按给定顺序输出", () => {
    const result = optionEntries(table, ["low", "high", "medium"]);
    assert.deepEqual(result.map((entry) => entry.value), ["low", "high", "medium"]);
  });

  it("不传顺序时用表的键序", () => {
    assert.deepEqual(optionEntries(table).map((entry) => entry.value), ["high", "medium", "low"]);
  });

  it("表里有但顺序没列出的项追加在末尾（不漏）", () => {
    const result = optionEntries(table, ["high"]);
    assert.deepEqual(result.map((entry) => entry.value), ["high", "medium", "low"]);
  });

  it("顺序里有但表里没有的项被跳过", () => {
    const result = optionEntries(table, ["nope", "high"]);
    assert.deepEqual(result.map((entry) => entry.value), ["high", "medium", "low"]);
  });

  /**
   * 意图断言：**表外键绝不能出现在输出里**。
   *
   * 上一版实现写的是 `table[key] ?? key`，结果是下拉框里冒出一个
   * `{ value: "nope", label: "nope" }` —— 用户选了它，请求发到后端
   * 会得到"未知状态"。这个 bug 是**跨层**的：前端多一项、后端不认识，
   * 而界面上完全看不出异常。
   *
   * 所以不能用"输出等于期望数组"来间接表达（那样读的人不知道在防什么），
   * 要直接断言「表外键不存在」。
   */
  it("**表外键绝不出现在输出里**（前端多一项 = 后端收到未知值）", () => {
    const result = optionEntries(table, ["nope", "alsoNope", "high"]);
    const values = result.map((entry) => entry.value);
    assert.equal(values.includes("nope"), false, "表外键 nope 不应成为选项");
    assert.equal(values.includes("alsoNope"), false, "表外键 alsoNope 不应成为选项");
    // label 也不能被伪造成键名（`?? key` 的兜底会把 key 当 label）。
    const labels = result.map((entry) => entry.label);
    assert.equal(labels.includes("nope"), false, "表外键不应被当作 label");
  });

  it("顺序里有重复项时去重", () => {
    const result = optionEntries(table, ["high", "high", "low"]);
    assert.deepEqual(result.map((entry) => entry.value), ["high", "low", "medium"]);
  });

  it("label 取自表值", () => {
    assert.deepEqual(optionEntries({ a: "甲" }), [{ value: "a", label: "甲" }]);
  });
});

describe("全面浏览窗口", () => {
  it("hash 常量与原生一致", () => {
    assert.equal(FULL_WINDOW_HASH, "#redteam-full");
  });

  it("识别全面浏览 hash", () => {
    assert.equal(isFullWindowHash("#redteam-full"), true);
  });

  it("其它 hash 不识别", () => {
    assert.equal(isFullWindowHash("#other"), false);
    assert.equal(isFullWindowHash(""), false);
    assert.equal(isFullWindowHash(null), false);
  });

  it("fullWindowUrl 拼上 hash", () => {
    assert.equal(fullWindowUrl("http://h/x"), "http://h/x#redteam-full");
  });

  it("**先砍已有 hash 再拼**（防重复）", () => {
    assert.equal(fullWindowUrl("http://h/x#redteam-full"), "http://h/x#redteam-full");
    assert.equal(fullWindowUrl("http://h/x#other"), "http://h/x#redteam-full");
  });
});

describe("截图助手", () => {
  it("缓存键格式是 eng:id", () => {
    assert.equal(shotCacheKey("eng-1", 3), "eng-1:3");
    assert.equal(shotCacheKey("eng-1", "3"), "eng-1:3");
  });

  it("缓存键在两处调用下一致（防 id/eng 写反）", () => {
    assert.equal(shotCacheKey("a", 1), shotCacheKey("a", 1));
  });

  it("shotDataUrl 默认 image/png", () => {
    assert.equal(shotDataUrl("AAA", null), "data:image/png;base64,AAA");
  });

  it("shotDataUrl 用给定 mime", () => {
    assert.equal(shotDataUrl("AAA", "image/jpeg"), "data:image/jpeg;base64,AAA");
  });

  it("空 base64 给空串（不产出坏 img src）", () => {
    assert.equal(shotDataUrl("", "image/png"), "");
    assert.equal(shotDataUrl(null, "image/png"), "");
  });
});

describe("dataOpen / pairToTab", () => {
  it("dataOpen 给字符串 '1' / '0'（供 CSS 属性选择器）", () => {
    assert.equal(dataOpen(true), "1");
    assert.equal(dataOpen(false), "0");
  });

  it("pairToTab 转元组为对象", () => {
    assert.deepEqual(pairToTab(["assets", "资产测绘"]), { id: "assets", label: "资产测绘" });
  });
});
