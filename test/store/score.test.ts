/**
 * 计分引擎：封顶 / 去重 / 倍率 / 阶段推导。
 *
 * 这一组是"三处口径必须一致"的保障（面板 / 报告 / 攻击链）。测的是**判定逻辑本身**
 * （`applyScoreCaps` / `evaluateScoreBoard`），不经过 SQLite —— 它们是纯函数，
 * 用内存里的行就能把每条纪律钉住。
 *
 * 三条纪律（原注释记的线上 bug）各有用例：
 *   1. 拿不到服务键 → **不参与去重**（否则 62 条命中会有 61 条被静默吃掉）；
 *   2. `system_key` 必须能被服务键校验（否则 10.7.7.7 与 10.7.7.8 会被并成一个系统）；
 *   3. 兜底键不能用随机数（否则同一个 hit 三次调用三种结论）。
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  applyScoreCaps, evaluateScoreBoard, hitPointsOf, normalizePort, parseRowCount, parseTargetPort,
  scoreCapReasonText, scoreMetaFromRow, scoreMultiplierOf, scoreServiceKey, scoreStageOf,
  serviceLabel, systemKeyOf, targetAuthority, targetHasIpv6Host, targetKey,
  formatRows, SENSITIVE_DATA_MIN_ROWS, tunnelIsLegit, TUNNEL_ENTRY_KINDS,
  type ScoreMeta, type ScoreHitLike,
} from "../../src/redteam/store/score.js";
import { DEFAULT_SCORE_POINTS } from "../../src/redteam/store/data/score-points.js";
import { makeEngagement, makeTempStore } from "./fixtures.js";

const temps: { dispose(): void }[] = [];
after(() => {
  for (const t of temps) t.dispose();
});

/**
 * 造一行命中。
 *
 * `extra` 里**排除 code**：`ScoreHitLike.code` 是可空（`string | null`），
 * 而这里要的是非空 code（用例都按 code 查元数据）。先展开再赋值，
 * 让显式参数赢 —— 否则 `...extra` 会把 `string | null` 覆盖进来。
 */
function hit(
  id: number,
  code: string,
  points: number,
  extra: Omit<Partial<ScoreHitLike>, "id" | "code" | "points"> = {},
): ScoreHitLike & { readonly code: string } {
  const base: ScoreHitLike & { readonly code: string } = { id, code, points, self_created: 0 };
  return { ...base, ...extra };
}

/** 从默认得分点造元数据表。 */
function metaTable(): Map<string, ScoreMeta> {
  const m = new Map<string, ScoreMeta>();
  for (const p of DEFAULT_SCORE_POINTS) {
    m.set(p.code, {
      rule: p.rule, cap: p.cap, dedup_scope: p.dedup_scope, points: p.points,
      enabled: 1, builtin: true, src: p.src,
    });
  }
  return m;
}

describe("score: 服务键与服务标签", () => {
  it("targetAuthority：路径/参数丢掉，按协议补默认端口", () => {
    assert.equal(targetAuthority("http://H:8080/a/b?c=1"), "h:8080");
    assert.equal(targetAuthority("http://h/x"), "h:80", "没写端口时按 http 补 80");
    assert.equal(targetAuthority("https://h/x"), "h:443");
    assert.equal(targetAuthority("10.0.0.5:6379"), "10.0.0.5:6379");
    assert.equal(targetAuthority("bare-host"), "bare-host", "没协议没端口 → 只有 host");
    assert.equal(targetAuthority(""), null);
  });

  it("parseTargetPort：不编造 80/443", () => {
    assert.equal(parseTargetPort("http://h:8080/x"), 8080);
    assert.equal(parseTargetPort("10.0.0.5:22"), 22);
    assert.equal(parseTargetPort("http://h/x"), null, "**不要猜 80** —— 会把不同服务并成一个");
    assert.equal(parseTargetPort("pc-001"), null);
    assert.equal(parseTargetPort("h:999999"), null, "超范围端口不算");
  });

  it("normalizePort：0/负数/空串都当没写", () => {
    assert.equal(normalizePort(null), null);
    assert.equal(normalizePort(""), null);
    assert.equal(normalizePort(0), null);
    assert.equal(normalizePort(-1), null);
    assert.equal(normalizePort(8080), 8080);
    assert.equal(normalizePort("3306"), 3306);
  });

  it("scoreServiceKey：t<host:port> 优先，退到 a<id>:<port>", () => {
    assert.equal(scoreServiceKey({ id: 1, target: "http://h:8080/a" }), "th:8080");
    assert.equal(scoreServiceKey({ id: 2, asset_id: 7, port: 3306 }), "a7:3306");
    assert.equal(scoreServiceKey({ id: 3, asset_id: 7 }), "a7:0", "没端口记 0（该资产的未知端口）");
    assert.equal(scoreServiceKey({ id: 4 }), null, "两样都没有 → null（不参与封顶）");
  });

  it("serviceLabel：有资产 IP 用它，没有就退到 target 的 host[:port]", () => {
    assert.equal(serviceLabel({ id: 1, port: 8080, target: "http://h/x" }, "10.0.0.5"), "10.0.0.5:8080");
    assert.equal(serviceLabel({ id: 1, target: "pc-001" }), "pc-001");
    assert.equal(serviceLabel({ id: 1 }), "(未标注服务)");
    /* 没有资产 IP 时走 targetAuthority，而它会按协议补默认端口 ——
       所以 target 是 `http://h/x` 时给出 `h:80`（**不是**端口列的 8080）。
       这是上游行为（实测确认）：authority 自带端口后就不再拼端口列。 */
    assert.equal(serviceLabel({ id: 1, port: 8080, target: "http://h/x" }), "h:80");
    assert.equal(serviceLabel({ id: 1, port: 8080, target: "http://h:8080/x" }), "h:8080");
  });
});

describe("score: 去重（dedup_scope）", () => {
  it("service 口径：同服务只留分值最高的一条", () => {
    const meta = metaTable();
    const rows = [
      hit(1, "server-host", 10, { target: "http://10.0.0.5:8080/", recorded_at: "2024-01-01T00:00:00Z" }),
      hit(2, "server-host", 50, { target: "http://10.0.0.5:8080/admin", recorded_at: "2024-01-02T00:00:00Z" }),
    ];
    const out = applyScoreCaps(rows, meta, null);
    const byId = new Map(out.items.map((x) => [x.id, x]));
    assert.equal(byId.get(1)?.capped, true, "低分那条被封顶");
    assert.equal(byId.get(1)?.capped_reason_kind, "dedup");
    assert.equal(byId.get(1)?.capped_by_id, 2, "被高分那条压住");
    assert.equal(byId.get(2)?.capped, false);
    assert.equal(out.capped, 1);
  });

  it("service 口径：同分取更早记的（id 小的）", () => {
    const meta = metaTable();
    const rows = [
      hit(5, "server-host", 50, { target: "10.0.0.5:22" }),
      hit(9, "server-host", 50, { target: "10.0.0.5:22" }),
    ];
    const out = applyScoreCaps(rows, meta, null);
    const byId = new Map(out.items.map((x) => [x.id, x]));
    assert.equal(byId.get(5)?.capped, false, "同分取 id 小的");
    assert.equal(byId.get(9)?.capped, true);
  });

  it("⚠️ 拿不到服务键 → **不参与 dedup**（否则会静默吃掉成果）", () => {
    const meta = metaTable();
    /* 62 条无 target 的 terminal-access 命中。上游实测"只留 1 条"是 dedup 的 bug ——
       正确行为：认不出服务就各算各的，不该被判成重复。
       但注意它们**仍会撞该规则的 cap**（rule 2 上限 600，62×10=620 → 2 条超额），
       那是规则上限的正常行为，不是去重。 */
    const rows = Array.from({ length: 62 }, (_, i) => hit(i + 1, "terminal-access", 10));
    const out = applyScoreCaps(rows, meta, null);
    const byDedup = out.items.filter((x) => x.capped_reason_kind === "dedup");
    assert.equal(byDedup.length, 0, "拿不到服务键的命中一条都不该被判为 dedup");
    /* 超 cap 的是另外一码事：62×10 = 620 > 600 → 恰好 2 条 */
    const byCap = out.items.filter((x) => x.capped_reason_kind === "cap");
    assert.equal(byCap.length, 2);
    assert.equal(out.capped, 2);
  });

  it("target 口径：整个目标只算一次（突破网络边界）", () => {
    const meta = metaTable();
    const rows = [
      hit(1, "boundary-logical", 1000, { target: "10.20.30.0/24" }),
      hit(2, "boundary-logical", 1000, { target: "10.99.0.0/16" }),
    ];
    const out = applyScoreCaps(rows, meta, null);
    assert.equal(out.capped, 1, "target 口径只留一条");
  });

  it("none 口径：按台/卡数累加，不去重", () => {
    const meta = metaTable();
    /* computepower-cards 的 dedup_scope 是 none */
    const def = DEFAULT_SCORE_POINTS.find((p) => p.code === "computepower-cards");
    assert.equal(def?.dedup_scope, "none");
    const rows = [
      hit(1, "computepower-cards", 10, { target: "10.0.0.5" }),
      hit(2, "computepower-cards", 10, { target: "10.0.0.5" }),
    ];
    const out = applyScoreCaps(rows, meta, null);
    assert.equal(out.capped, 0, "none 口径不该去重");
  });

  it("self_created=1 既不参与竞争也不占位", () => {
    const meta = metaTable();
    const rows = [
      hit(1, "server-host", 10, { target: "10.0.0.5:22", self_created: 1 }),
      hit(2, "server-host", 10, { target: "10.0.0.5:22", self_created: 0 }),
    ];
    const out = applyScoreCaps(rows, meta, null);
    const byId = new Map(out.items.map((x) => [x.id, x]));
    assert.equal(byId.get(1)?.capped, false, "自建账号不该被去重标掉（它本来就不计分）");
    assert.equal(byId.get(2)?.capped, false, "真实那条计分");
    assert.equal(out.capped, 0);
  });

  it("system 口径：同系统只算最高权限一次（靠资产名 + 服务键）", () => {
    const meta = metaTable();
    const names = new Map([[7, "mail.example.test"]]);
    const rows = [
      hit(1, "web-app", 50, { asset_id: 7, port: 443 }),
      hit(2, "web-app", 100, { asset_id: 7, port: 443 }),
    ];
    const out = applyScoreCaps(rows, meta, names);
    const byId = new Map(out.items.map((x) => [x.id, x]));
    assert.equal(byId.get(1)?.capped, true);
    assert.equal(byId.get(2)?.capped, false);
  });

  it("⚠️ system_key 必须能被服务键校验（否则两台主机会被并成一个系统）", () => {
    const names = new Map<number, string>();
    /* 资产没有名字时，调用方预造的键会退化成 "|8080" —— 直接采信会把
       10.7.7.7:8080 与 10.7.7.8:8080 并成同一个系统，白白封顶另一台主机的成果。 */
    const keyA = systemKeyOf({ id: 1, asset_id: 100, port: 8080, target: "http://10.7.7.7:8080/", system_key: "|8080" }, names);
    const keyB = systemKeyOf({ id: 2, asset_id: 101, port: 8080, target: "http://10.7.7.8:8080/", system_key: "|8080" }, names);
    assert.notEqual(keyA, keyB, "不能采信无法校验的 system_key");
    assert.equal(keyA, "t10.7.7.7:8080", "应退到服务键");
    assert.equal(keyB, "t10.7.7.8:8080");
  });

  it("⚠️ 兜底键稳定（不能用随机数）", () => {
    /* 同一个 hit 在面板/报告/攻击链三次调用里必须拿到同一个键 */
    const h: ScoreHitLike = { id: 42 };
    const k1 = systemKeyOf(h, null);
    const k2 = systemKeyOf(h, null);
    const k3 = systemKeyOf(h, null);
    assert.equal(k1, "#hit42");
    assert.equal(k1, k2);
    assert.equal(k2, k3);
  });
});

describe("score: 规则上限（cap）", () => {
  it("同 rule 的命中累计超上限后，超出的标 capped(rule)", () => {
    const meta = metaTable();
    /* server-host: rule 3, cap 600, dedup system */
    const rows = Array.from({ length: 15 }, (_, i) =>
      hit(i + 1, "server-host", 50, { target: `10.0.0.${String(i + 1)}:22` }));
    const out = applyScoreCaps(rows, meta, null);
    /* 600 / 50 = 12 条可计，剩下 3 条超上限 */
    const counted = out.items.filter((x) => !x.capped);
    assert.equal(counted.length, 12);
    const cappedByRule = out.items.filter((x) => x.capped_reason_kind === "cap");
    assert.equal(cappedByRule.length, 3);
    assert.equal(out.caps.get("rule:3")?.used, 600);
  });

  it("按分值从高到低累计（不是按 id 顺序）", () => {
    const meta = metaTable();
    /* target 口径 cap 2000，先给几条极端高分，确认优先吃掉上限的是高分那条 */
    const rows = [
      hit(1, "boundary-logical", 1000, { target: "a" }),
      hit(2, "boundary-logical", 1000, { target: "a" }),
      hit(3, "boundary-logical", 1000, { target: "a" }),
    ];
    const out = applyScoreCaps(rows, meta, null);
    /* target 口径先去重（只留一条），然后 cap 2000 那条 1000 也能进 */
    const counted = out.items.filter((x) => !x.capped);
    assert.equal(counted.length, 1);
    assert.equal(counted[0]?.id, 1, "同分取 id 小的");
  });

  it("cap=0 表示不设上限", () => {
    const meta = metaTable();
    const zeroCap: ScoreMeta = { rule: 99, cap: 0, dedup_scope: "none", points: 10, enabled: 1, builtin: false, src: null };
    meta.set("custom-unlimited", zeroCap);
    const rows = Array.from({ length: 100 }, (_, i) => hit(i + 1, "custom-unlimited", 10, { target: `t${String(i)}` }));
    const out = applyScoreCaps(rows, meta, null);
    assert.equal(out.capped, 0, "cap=0 不该封顶");
  });
});

describe("score: 倍率（G5 / G6）", () => {
  it("IPv6 target → ×3", () => {
    const m = scoreMultiplierOf({ target: "http://[2001:db8::1]:8080/x" });
    assert.equal(m.multiplier, 3);
    assert.ok(m.reasons.some((r) => r.startsWith("G6")));
  });

  it("IPv6 里的十六进制字母也要认（db8 曾被漏判）", () => {
    assert.equal(targetHasIpv6Host("2001:db8::1"), true);
    /* 带协议的方括号写法走的是专门分支，能正确认出来 */
    assert.equal(targetHasIpv6Host("http://[::1]:22/"), true);
    assert.equal(targetHasIpv6Host("10.0.0.5:8080"), false);
    /* 内网主机名:端口 只有一个冒号，**不能**误判成 IPv6（否则成果静默 ×3） */
    assert.equal(targetHasIpv6Host("dc01:389"), false);
    assert.equal(targetHasIpv6Host("ad01:8080"), false);
    /* ⚠️ 裸写 `[::1]:22`（没协议）上游判 **false**：方括号剥离用的是
       `.replace(/^\[|\]$/g, "")`，对 `[::1]:22` 只剥掉前括号、剩下的
       `::1]:22` 剥端口后仍带 `]`，isIpv6 不认。这是上游的既有行为，
       迁移时原样保留（改它就等于悄悄改变 G6 的 ×3 判定）。
       想让它生效请写 `ip_version: 6` 或带协议。 */
    assert.equal(targetHasIpv6Host("[::1]:22"), false);
    /* 但显式 ip_version=6 仍然生效 */
    assert.equal(scoreMultiplierOf({ ip_version: 6, target: "[::1]:22" }).multiplier, 3);
  });

  it("data_scale=large → ×2；knowledge-base → ×2；两者叠加 → ×6", () => {
    assert.equal(scoreMultiplierOf({ data_scale: "large" }).multiplier, 2);
    assert.equal(scoreMultiplierOf({ data_scale: "knowledge-base" }).multiplier, 2);
    const both = scoreMultiplierOf({ data_scale: "large", target: "http://[::1]/" });
    assert.equal(both.multiplier, 6, "文档没写禁止叠加，取对演练方有利的解释并如实标注");
    assert.equal(both.reasons.length, 2);
  });

  it("hitPointsOf：档位分值 × 倍率，四舍五入", () => {
    assert.equal(hitPointsOf({ points: 50, multiplier: 3 }), 150);
    assert.equal(hitPointsOf({ points: 10, multiplier: 1.5 }), 15);
    /* 回落到默认分值时必须带 code —— 没有 code 就查不到元数据，上游同样得 0 */
    assert.equal(hitPointsOf({ points: null, multiplier: 1, code: "x" }, new Map([["x", { points: 100 }]])), 100);
    assert.equal(hitPointsOf({ points: null, multiplier: 1 }, new Map([["x", { points: 100 }]])), 0, "没 code 就查不到默认值");
    assert.equal(hitPointsOf({ points: 50, multiplier: null }), 50, "倍率非法按 1");
  });
});

describe("score: 阶段推导", () => {
  it("① 显式 stage_code 优先", () => {
    assert.equal(scoreStageOf({ stage_code: "target", code: "server-host", target: "10.0.0.5" }), "target");
  });

  it("② 类型特判：集权/邮箱/业务系统 → target，突破边界 → boundary", () => {
    assert.equal(scoreStageOf({ code: "central-system", target: "10.0.0.5" }), "target");
    assert.equal(scoreStageOf({ code: "web-app", target: "10.0.0.5" }), "target");
    assert.equal(scoreStageOf({ code: "boundary-logical", target: "10.0.0.5" }), "boundary");
  });

  it("③ 按资产内外网归属", () => {
    assert.equal(scoreStageOf({ code: "server-host", target: "x" }, "internal"), "internal");
    assert.equal(scoreStageOf({ code: "server-host", target: "x" }, "external"), "internet");
  });

  it("④ 按 target 里的地址判断（私网 → internal）", () => {
    assert.equal(scoreStageOf({ code: "server-host", target: "10.1.2.3:22" }), "internal");
    assert.equal(scoreStageOf({ code: "server-host", target: "8.8.8.8:22" }), "internet");
  });

  it("④ 兜底：设备名解析不出 IP → internet（不能留空）", () => {
    /* 留空会让这条得分不落任何阶段，报告里凭空消失 */
    assert.equal(scoreStageOf({ code: "terminal-access", target: "pc-001" }), "internet");
  });
});

describe("score: 隧道合法性", () => {
  it("四种 entry_kind 的 legit 判定", () => {
    assert.equal(tunnelIsLegit("target-outbound"), true);
    assert.equal(tunnelIsLegit("target-http"), true);
    assert.equal(tunnelIsLegit("target-agent"), true);
    assert.equal(tunnelIsLegit("self-only"), false);
    assert.equal(tunnelIsLegit(""), null, "没填 → null（待确认），不能当 false");
    assert.equal(tunnelIsLegit(null), null);
    assert.equal(Object.keys(TUNNEL_ENTRY_KINDS).length, 4);
  });
});

describe("score: 数据量解析（G5 量级核对）", () => {
  it("带量词的中文量级", () => {
    assert.equal(parseRowCount("导出 1.3 亿条用户数据"), 130000000);
    assert.equal(parseRowCount("120 万条"), 1200000);
    assert.equal(parseRowCount("1300万行"), 13000000);
    assert.equal(parseRowCount("2.5万行"), 25000);
  });

  it("带千分位与英文量词", () => {
    assert.equal(parseRowCount("1,200,000 条记录"), 1200000);
    assert.equal(parseRowCount("1200000 records"), 1200000);
    assert.equal(parseRowCount("5000 rows"), 5000);
  });

  it("⚠️ 裸数字不认（口令里的 123456 不能被当数据量）", () => {
    assert.equal(parseRowCount("口令 P@ss123456"), null);
    assert.equal(parseRowCount("端口 6379"), null);
    assert.equal(parseRowCount(""), null);
  });

  it("多个数字取最大（保守取\"最多看到的那次\"）", () => {
    assert.equal(parseRowCount("先导出 30 万条，后导出 120 万条"), 1200000);
  });

  it("formatRows 千分位 + 门槛常量", () => {
    assert.equal(formatRows(1234567), "1,234,567");
    assert.equal(SENSITIVE_DATA_MIN_ROWS, 1000000);
  });
});

describe("score: 目标归并", () => {
  it("按站点/服务归并（不是按完整 URL）", () => {
    assert.equal(targetKey("http://h:8080/a/b?c=1"), "http://h:8080");
    assert.equal(targetKey("10.0.0.5:6379"), "10.0.0.5:6379");
    assert.equal(targetKey("pc-001"), "pc-001");
    assert.equal(targetKey("", "10.0.0.5"), "10.0.0.5", "没 target 时用资产 IP");
    assert.equal(targetKey(null), "(未指定目标)");
  });
});

describe("score: 封顶文案", () => {
  it("dedup 与 cap 两种原因文案不同、且都带服务名", () => {
    const dedup = scoreCapReasonText(
      { id: 1, target: "10.0.0.5:22", port: 22, capped_reason_kind: "dedup" }, 50,
    );
    assert.match(dedup, /10\.0\.0\.5:22/);
    assert.match(dedup, /权限已经拿满/);
    assert.match(dedup, /\+50 分/);
    const cap = scoreCapReasonText(
      { id: 2, target: "10.0.0.5:22", port: 22, rule: 3, rule_cap: 600, capped_reason_kind: "cap" },
    );
    assert.match(cap, /规则 3/);
    assert.match(cap, /上限（600 分）/);
  });
});

describe("score: 与面板/报告/攻击链的口径一致（integration）", () => {
  it("三处算出的总分相同（包含封顶与自建账号）", () => {
    const t = makeTempStore();
    temps.push(t);
    const id = makeEngagement(t.store);
    /* 场景：同服务先记低档、后记高档；再记一条自建账号；再记一条 target 口径 */
    t.store.addScoreHit(id, { code: "server-host", target: "http://10.0.0.5:8080/", evidence: "10.0.0.5｜普通权限", points: 10 });
    t.store.addScoreHit(id, { code: "server-host", target: "http://10.0.0.5:8080/admin", evidence: "10.0.0.5｜root", points: 50 });
    t.store.addScoreHit(id, { code: "server-host", target: "http://10.0.0.5:8080/self", evidence: "自己注册的账号", points: 10, self_created: true });
    t.store.addScoreHit(id, { code: "boundary-logical", target: "10.20.30.0/24", evidence: "搭通 suo5，可达 10.20.30.0/24" });
    const board = t.store.listScorePoints(id);
    const chain = t.store.scoreChain(id);
    const report = t.store.scoreReport(id);
    assert.equal(board.summary.achievedPoints, chain.summary.points, "面板总分必须等于攻击链总分");
    assert.equal(board.summary.achievedPoints, report.summary.points, "面板总分必须等于报告总分");
    /* 50（root）+ 1000（边界）= 1050 */
    assert.equal(board.summary.achievedPoints, 1050);
  });

  it("停用得分点后三处一起排除（与 enabledOnly 一致）", () => {
    const t = makeTempStore();
    temps.push(t);
    const id = makeEngagement(t.store);
    const added = t.store.addScoreHit(id, { code: "server-host", target: "10.0.0.5:22", evidence: "root", points: 50 });
    assert.ok(added.id > 0);
    const point = t.store.listScorePoints(id).items.find((p) => p.code === "server-host");
    assert.ok(point !== undefined);
    t.store.saveScorePoint(id, { id: point.id, enabled: false });
    const board = t.store.listScorePoints(id);
    const report = t.store.scoreReport(id);
    assert.equal(board.summary.achievedPoints, 0, "停用后不计分");
    assert.equal(report.summary.points, 0);
    assert.equal(report.summary.disabledExcluded, 1, "报告要报出\"因停用排除\"的条数");
  });
});

describe("score: 元数据读取", () => {
  it("scoreMetaFromRow 的字段映射与默认值", () => {
    const [code, meta] = scoreMetaFromRow({
      code: "x", rule: null, cap: null, dedup_scope: null, points: null, enabled: null, builtin: null, src: null,
    });
    assert.equal(code, "x");
    assert.equal(meta.rule, null);
    assert.equal(meta.cap, 0);
    assert.equal(meta.dedup_scope, "service", "老库 dedup_scope 为空时默认 service");
    assert.equal(meta.points, 0);
    assert.equal(meta.enabled, 1, "enabled 为空当启用");
    assert.equal(meta.builtin, false);
    assert.equal(meta.src, null);
  });
});

describe("score: evaluateScoreBoard 的 enabledOnly", () => {
  it("停用得分点的命中进 disabledIds，且不进 cap 统计", () => {
    const meta = metaTable();
    meta.set("disabled-code", { rule: 1, cap: 100, dedup_scope: "none", points: 50, enabled: 0, builtin: false, src: null });
    const rows = [hit(1, "disabled-code", 50), hit(2, "server-host", 50, { target: "10.0.0.5:22" })];
    const out = evaluateScoreBoard(rows, meta, new Map(), { enabledOnly: true });
    assert.ok(out.disabledIds.has(1));
    assert.ok(!out.disabledIds.has(2));
  });

  it("不给 enabledOnly 时不产生 disabledIds", () => {
    const meta = metaTable();
    const rows = [hit(1, "server-host", 50, { target: "10.0.0.5:22" })];
    const out = evaluateScoreBoard(rows, meta, new Map());
    assert.equal(out.disabledIds.size, 0);
  });
});
