/**
 * op 词汇表测试。
 *
 * 除了「能解析」，这里固定住三个**结构性断言**（lead 明确要求）：
 * 1. 总数 80；
 * 2. `store + gateway === 总数`，即「每个 op 恰好属于一层」；
 * 3. 集合相等 + 无重叠，抓「漏 A 多 B」这类数量断言抓不到漂移。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GATEWAY_OP_NAMES,
  OP_NAMES,
  OP_TABLE,
  STORE_OP_NAMES,
  describe as describeValue,
  fieldBoolean,
  fieldNumber,
  fieldString,
  fieldUnknown,
  isOpName,
  parseRequest,
} from "../../src/redteam/ui/ops.js";

describe("词汇表结构 —— 数量即断言", () => {
  it("总数是 80", () => {
    assert.equal(OP_NAMES.length, 80);
  });

  it("store 71（70 个 store-core op + probeSessions）", () => {
    assert.equal(STORE_OP_NAMES.length, 71);
  });

  it("gateway 9（只存在于 HTTP 桥本地）", () => {
    assert.equal(GATEWAY_OP_NAMES.length, 9);
  });

  it("**每个 op 恰好属于一层**：store + gateway === 总数", () => {
    assert.equal(STORE_OP_NAMES.length + GATEWAY_OP_NAMES.length, OP_NAMES.length);
  });

  it("表与词汇表**集合相等**（抓「漏 A 多 B」）", () => {
    assert.deepEqual([...OP_NAMES].sort(), Object.keys(OP_TABLE).sort());
  });

  it("store 与 gateway 无重叠", () => {
    // 两个列表是互斥的字面量联合，先宽成 string 才能做交集判定。
    const gatewayNames: readonly string[] = GATEWAY_OP_NAMES;
    assert.equal(STORE_OP_NAMES.filter((name) => gatewayNames.includes(name)).length, 0);
  });

  it("每个 op 都有 kind，且只有两种取值", () => {
    for (const name of OP_NAMES) {
      const meta = OP_TABLE[name];
      assert.ok(meta.kind === "store" || meta.kind === "gateway", `${name} 的 kind 异常：${String(meta.kind)}`);
    }
  });

  it("kind 分布与两个列表一致", () => {
    const storeInTable = OP_NAMES.filter((name) => OP_TABLE[name].kind === "store");
    const gatewayInTable = OP_NAMES.filter((name) => OP_TABLE[name].kind === "gateway");
    assert.deepEqual([...storeInTable].sort(), [...STORE_OP_NAMES].sort());
    assert.deepEqual([...gatewayInTable].sort(), [...GATEWAY_OP_NAMES].sort());
  });

  it("没有重复名", () => {
    assert.equal(new Set(OP_NAMES).size, OP_NAMES.length);
  });
});

describe("isOpName", () => {
  it("认识的 op 返回 true", () => {
    assert.equal(isOpName("bootstrap"), true);
    assert.equal(isOpName("version"), true);
  });

  it("不认识的返回 false", () => {
    assert.equal(isOpName("nope"), false);
  });

  it("原型链上的名字不算（防 'toString' 之类穿透）", () => {
    assert.equal(isOpName("toString"), false);
    assert.equal(isOpName("constructor"), false);
    assert.equal(isOpName("__proto__"), false);
  });

  it("非字符串返回 false", () => {
    assert.equal(isOpName(42), false);
    assert.equal(isOpName(null), false);
    assert.equal(isOpName({}), false);
  });
});

describe("parseRequest — op 解析", () => {
  it("正常解析并带回 kind", () => {
    const result = parseRequest({ op: "bootstrap" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.op, "bootstrap");
    assert.equal(result.value.kind, "store");
  });

  it("网关 op 得到 kind=gateway", () => {
    const result = parseRequest({ op: "version" });
    assert.equal(result.ok ? result.value.kind : "", "gateway");
  });

  it("去首尾空白", () => {
    const result = parseRequest({ op: "  bootstrap  " });
    assert.equal(result.ok ? result.value.op : "", "bootstrap");
  });

  it("缺 op → missing_op", () => {
    const result = parseRequest({});
    assert.equal(result.ok ? "" : result.error.code, "missing_op");
  });

  it("op 是空串/空白 → missing_op", () => {
    assert.equal(parseRequest({ op: "" }).ok, false);
    assert.equal(parseRequest({ op: "   " }).ok, false);
  });

  it("op 非字符串 → missing_op", () => {
    const result = parseRequest({ op: 42 });
    assert.equal(result.ok ? "" : result.error.code, "missing_op");
  });

  it("未知 op → unknown_op，**不是** 500", () => {
    const result = parseRequest({ op: "definitelyNotAnOp" });
    assert.equal(result.ok ? "" : result.error.code, "unknown_op");
    if (result.ok || result.error.code !== "unknown_op") return;
    assert.equal(result.error.op, "definitelyNotAnOp");
    assert.match(result.error.message, /unknown op/);
  });

  it("请求体不是对象 → missing_op", () => {
    assert.equal(parseRequest([]).ok, false);
    assert.equal(parseRequest("str").ok, false);
    assert.equal(parseRequest(null).ok, false);
  });
});

describe("parseRequest — 必填与类型", () => {
  it("openEngagement 缺 name → invalid_payload", () => {
    const result = parseRequest({ op: "openEngagement" });
    assert.equal(result.ok ? "" : result.error.code, "invalid_payload");
    if (result.ok || result.error.code !== "invalid_payload") return;
    assert.match(result.error.details.join(" "), /name/);
  });

  it("openEngagement 带 name 通过", () => {
    assert.equal(parseRequest({ op: "openEngagement", name: "示例" }).ok, true);
  });

  it("activateEngagement 缺 engagement → invalid_payload", () => {
    assert.equal(parseRequest({ op: "activateEngagement" }).ok, false);
  });

  it("setAgentsMax 缺 max → invalid_payload", () => {
    assert.equal(parseRequest({ op: "setAgentsMax" }).ok, false);
  });

  it("setAgentsMax 的 max 非数字 → invalid_payload", () => {
    const result = parseRequest({ op: "setAgentsMax", max: "5" });
    assert.equal(result.ok ? "" : result.error.code, "invalid_payload");
  });

  it("setAgentsMax 的 max 是 NaN 之外的非有限数 → invalid_payload", () => {
    assert.equal(parseRequest({ op: "setAgentsMax", max: Number.NaN }).ok, false);
    assert.equal(parseRequest({ op: "setAgentsMax", max: Number.POSITIVE_INFINITY }).ok, false);
  });

  it("skillRead 缺 name → invalid_payload", () => {
    assert.equal(parseRequest({ op: "skillRead" }).ok, false);
  });

  it("skillRead 带 name 通过", () => {
    assert.equal(parseRequest({ op: "skillRead", name: "recon" }).ok, true);
  });

  it("deleteScorePoint 缺 id → invalid_payload", () => {
    assert.equal(parseRequest({ op: "deleteScorePoint" }).ok, false);
  });

  it("deleteScorePoint 的 id 接受数字（id 有两套口径）", () => {
    assert.equal(parseRequest({ op: "deleteScorePoint", id: 7 }).ok, true);
    assert.equal(parseRequest({ op: "deleteScorePoint", id: "7" }).ok, true);
  });

  it("deleteScorePoint 的 id 不接受对象", () => {
    assert.equal(parseRequest({ op: "deleteScorePoint", id: { a: 1 } }).ok, false);
  });

  it("可选字段类型不符也报错（不让垃圾透传）", () => {
    const result = parseRequest({ op: "assets", limit: "400" });
    assert.equal(result.ok ? "" : result.error.code, "invalid_payload");
    if (result.ok || result.error.code !== "invalid_payload") return;
    assert.match(result.error.details.join(" "), /limit/);
  });

  it("可选字段类型正确则通过", () => {
    assert.equal(parseRequest({ op: "assets", limit: 400, cidr: "10.0.0.0/24" }).ok, true);
  });

  it("可选字段缺失不报错", () => {
    assert.equal(parseRequest({ op: "assets" }).ok, true);
  });

  it("可选字段为 null 视同缺失", () => {
    assert.equal(parseRequest({ op: "assets", limit: null }).ok, true);
  });

  it("多个错误一起报告（便于一次修完）", () => {
    const result = parseRequest({ op: "skillsRead", name: 1 });
    // 未知 op 先挡住，不会进字段校验。
    assert.equal(result.ok ? "" : result.error.code, "unknown_op");
  });

  it("载荷错误带 op 名（便于定位）", () => {
    const result = parseRequest({ op: "openEngagement" });
    if (result.ok || result.error.code !== "invalid_payload") throw new Error("应失败");
    assert.equal(result.error.op, "openEngagement");
  });
});

describe("parseRequest — engagement 归一", () => {
  it("取出去空白后的 engagement", () => {
    const result = parseRequest({ op: "snapshot", engagement: "  eng-1  " });
    assert.equal(result.ok ? result.value.engagement : null, "eng-1");
  });

  it("空串 → null", () => {
    const result = parseRequest({ op: "snapshot", engagement: "   " });
    assert.equal(result.ok ? result.value.engagement : "x", null);
  });

  it("缺失 → null", () => {
    const result = parseRequest({ op: "snapshot" });
    assert.equal(result.ok ? result.value.engagement : "x", null);
  });
});

describe("parseRequest — raw 保留原样", () => {
  it("未声明的字段仍在 raw 里（资产库要透传）", () => {
    const input = { op: "assets", engagement: "e1", someFutureField: { nested: true } };
    const result = parseRequest(input);
    if (!result.ok) throw new Error("应成功");
    assert.deepEqual(result.value.raw["someFutureField"], { nested: true });
  });

  it("raw 与输入是同一个对象引用（不做拷贝，避免丢字段）", () => {
    const input = { op: "bootstrap" };
    const result = parseRequest(input);
    if (!result.ok) throw new Error("应成功");
    assert.equal(result.value.raw, input);
  });
});

describe("字段读取助手", () => {
  const parsed = parseRequest({ op: "snapshot", engagement: "e", n: 3, b: true, s: "x" });
  if (!parsed.ok) throw new Error("夹具应解析成功");
  const request = parsed.value;

  it("fieldString 读字符串", () => {
    assert.equal(fieldString(request, "s"), "x");
    assert.equal(fieldString(request, "missing"), null);
    assert.equal(fieldString(request, "n"), null);
  });

  it("fieldNumber 读数字，非有限数给 null", () => {
    assert.equal(fieldNumber(request, "n"), 3);
    assert.equal(fieldNumber(request, "s"), null);
  });

  it("fieldBoolean 读布尔，缺失给 null（不是 false）", () => {
    assert.equal(fieldBoolean(request, "b"), true);
    assert.equal(fieldBoolean(request, "missing"), null);
  });

  it("fieldUnknown 原样返回", () => {
    assert.equal(fieldUnknown(request, "n"), 3);
    assert.equal(fieldUnknown(request, "nope"), undefined);
  });
});

describe("describe（错误文案用）", () => {
  it("区分 null / array / 原始类型", () => {
    assert.equal(describeValue(null), "null");
    assert.equal(describeValue([1]), "array");
    assert.equal(describeValue("x"), "string");
    assert.equal(describeValue(1), "number");
    assert.equal(describeValue(true), "boolean");
    assert.equal(describeValue({}), "object");
  });
});
