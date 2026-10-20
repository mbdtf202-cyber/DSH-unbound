/**
 * 资产测绘页测试（模型层 + 渲染层）。
 *
 * 这是四个页签里最大的一个，重点锁住三类容易迁错的行为：
 *
 * 1. **结论行的六种点击语义**（清除范围各不相同，含组合值 `abandoned,blocked`）
 * 2. **端口/指纹的文本收敛**（最多 3 个端口 + `+N`、指纹截 30 字符）
 * 3. **四种视图的空态区分**（未选靶标 / 未加载 / 无数据 / 过滤后为空）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  defaultAssetsProps,
  renderAssetsTab,
  type AssetsTabProps,
} from "../../src/redteam/client/assets-tab.js";
import {
  DEFAULT_ASSET_FILTER,
  GIVEUP_STATUS_COMBINED,
  MAX_SHOWN_PORTS,
  NO_ENGAGEMENT_TEXT,
  assetsRequest,
  applyConclusion,
  assetOf,
  assessLongText,
  assessText,
  conclusionItems,
  conclusionStatsOf,
  detailFor,
  discoveryOf,
  domainEmptyText,
  domainGroupsOf,
  filterDiscoveryByDay,
  fingerprintSummary,
  groupSegments,
  hasConclusionFilter,
  isConclusionActive,
  loadAssets,
  loadDiscovery,
  loadDomains,
  loadWebAssets,
  namesText,
  noteLinesOf,
  openPortsOf,
  portServiceText,
  portSummary,
  provenanceText,
  scopeLongLabel,
  scopeOf,
  scopeShortLabel,
  segmentTitle,
  segmentsOf,
  sideGroupKey,
  surfaceText,
  testMetaText,
  totalAssetsOf,
  webAssetUrl,
  webAssetsOf,
  webEmptyText,
  webServiceText,
  type AssetFilter,
  type AssetItem,
  type AssetSegment,
} from "../../src/redteam/client/assets-model.js";
import type { ApiClient, ApiResponse } from "../../src/redteam/client/api.js";
import type { ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

/** 造运行时。 */
function makeRuntime(): ConsoleRuntime {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  return createRuntime(requireModule, {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://h/", hostname: "h", port: "1", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => {
        throw new Error("unused");
      },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Parameters<typeof createRuntime>[1]);
}

/** 造一条 C 段。 */
function segment(overrides: Partial<AssetSegment> = {}): AssetSegment {
  return {
    cidr: "203.0.113.0/24",
    org: "示例机房",
    assets: 10,
    live: 7,
    openPorts: 20,
    passivePorts: 12,
    activePorts: 8,
    scope: "external",
    ...overrides,
  };
}

/** 造一台资产（模型层）。 */
function asset(overrides: Record<string, unknown> = {}): AssetItem {
  return assetOf({
    id: 1,
    ip: "203.0.113.5",
    segment_cidr: "203.0.113.0/24",
    scope: "external",
    state: "live",
    priority: "high",
    potential: "账号权限+RCE",
    assess_reason: "指纹命中 Nday",
    test_status: "untested",
    blocked_count: 0,
    discovered_at: "2026-09-17T09:30:00Z",
    last_seen: "2026-09-18T10:00:00Z",
    ports: [
      { port: 22, proto: "tcp", state: "open", service: "ssh", provenance: "active" },
      { port: 80, proto: "tcp", state: "open", service: "http", provenance: "active" },
    ],
    fingerprints: [{ vendor: "Apache", product: "httpd", version: "2.4.49", provenance: "active" }],
    ...overrides,
  });
}

/** 默认 props。 */
function props(overrides: Partial<AssetsTabProps> = {}): AssetsTabProps {
  return { ...defaultAssetsProps("eng-1"), ...overrides };
}

/** 渲染。 */
function render(overrides: Partial<AssetsTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderAssetsTab(runtime, props(overrides))) };
}

/** 快照夹具。 */
function snapshot(overrides: {
  readonly segments?: readonly AssetSegment[];
  readonly assets?: number;
  readonly liveAssets?: number;
  readonly untested?: number;
  readonly testing?: number;
  readonly tested?: number;
  readonly abandoned?: number;
  readonly blocked?: number;
} = {}): Record<string, unknown> {
  return {
    stats: {
      assets: overrides.assets ?? 10,
      liveAssets: overrides.liveAssets ?? 7,
    },
    tests: {
      untested: overrides.untested ?? 4,
      testing: overrides.testing ?? 1,
      tested: overrides.tested ?? 3,
      abandoned: overrides.abandoned ?? 1,
      blocked: overrides.blocked ?? 1,
    },
    segments: overrides.segments ?? [segment()],
  };
}

/* ══════════════════════════════════════════════════════════════ 模型：窄化 */

describe("assets-model — 窄化与解析", () => {
  it("scopeOf：只有 internal 算内网，其余一律外网", () => {
    assert.equal(scopeOf("internal"), "internal");
    assert.equal(scopeOf("external"), "external");
    assert.equal(scopeOf("INTERNAL"), "external");
    assert.equal(scopeOf(undefined), "external");
    assert.equal(scopeOf(42), "external");
  });

  it("归属标签：内/外 与 内网资产/外网资产", () => {
    assert.equal(scopeShortLabel("internal"), "内");
    assert.equal(scopeShortLabel("external"), "外");
    assert.equal(scopeLongLabel("internal"), "内网资产");
    assert.equal(scopeLongLabel("external"), "外网资产");
  });

  it("segmentsOf：丢掉没有 cidr 的段（点它会发空 cidr 请求）", () => {
    const segments = segmentsOf({
      segments: [
        { cidr: "10.0.0.0/24", assets: 3, live: 2, scope: "internal" },
        { cidr: "", assets: 99 },
        { assets: 1 },
      ],
    });
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.cidr, "10.0.0.0/24");
  });

  it("segmentsOf：计数容错（非数字 → 0）", () => {
    const segments = segmentsOf({ segments: [{ cidr: "10.0.0.0/24", assets: "abc", live: -1 }] });
    assert.equal(segments[0]?.assets, 0);
    assert.equal(segments[0]?.live, 0);
  });

  it("groupSegments：外网在前、内网在后，顺序保持输入顺序", () => {
    const groups = groupSegments([
      segment({ cidr: "a", scope: "external" }),
      segment({ cidr: "b", scope: "internal" }),
      segment({ cidr: "c", scope: "external" }),
    ]);
    assert.deepEqual(groups.external.map((s) => s.cidr), ["a", "c"]);
    assert.deepEqual(groups.internal.map((s) => s.cidr), ["b"]);
  });

  it("totalAssetsOf 是资产数之和（不是 C 段数）", () => {
    assert.equal(totalAssetsOf([segment({ assets: 3 }), segment({ assets: 4 })]), 7);
  });

  it("segmentTitle：归属 + 存活/总数，空归属显示「未知归属」", () => {
    assert.equal(segmentTitle(segment({ org: "机房A", live: 3, assets: 5 })), "机房A · 存活 3/5 台");
    assert.match(segmentTitle(segment({ org: "" })), /未知归属/);
  });

  it("sideGroupKey 拼出稳定的折叠键", () => {
    assert.equal(sideGroupKey("external"), "scope:external");
    assert.equal(sideGroupKey("internal"), "scope:internal");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：端口与指纹 */

describe("assets-model — 端口与指纹收敛", () => {
  it("openPortsOf 只留 state=open", () => {
    const item = asset({
      ports: [
        { port: 22, state: "open" },
        { port: 23, state: "closed" },
        { port: 80, state: "open" },
      ],
    });
    assert.deepEqual(openPortsOf(item).map((p) => p.port), [22, 80]);
  });

  it("**最多列 3 个端口，其余用 +N**", () => {
    const item = asset({
      ports: [80, 443, 8080, 8443, 9000].map((port) => ({ port, state: "open" })),
    });
    const summary = portSummary(item.ports);
    assert.equal(summary.shown, "80, 443, 8080 +2");
    assert.equal(summary.full, "80, 443, 8080, 8443, 9000");
  });

  it("端口数正好等于上限时不加 +N", () => {
    const item = asset({ ports: [80, 443, 8080].map((port) => ({ port, state: "open" })) });
    assert.equal(portSummary(item.ports).shown, "80, 443, 8080");
  });

  it("没有开放端口时显示 —", () => {
    const summary = portSummary(asset({ ports: [{ port: 22, state: "closed" }] }).ports);
    assert.equal(summary.shown, "—");
    assert.equal(summary.full, "—");
  });

  it("端口带服务名时是 22/ssh 形态", () => {
    const summary = portSummary([{ port: 22, service: "ssh", state: "open" } as never]);
    assert.equal(summary.shown, "22/ssh");
  });

  it("MAX_SHOWN_PORTS 常量就是 3", () => {
    assert.equal(MAX_SHOWN_PORTS, 3);
  });

  it("指纹拼成 厂商 产品 版本", () => {
    const summary = fingerprintSummary([{ vendor: "Apache", product: "httpd", version: "2.4.49" } as never]);
    assert.equal(summary.shown, "Apache httpd 2.4.49");
    assert.equal(summary.full, "Apache httpd 2.4.49");
  });

  it("**指纹超过 30 字符截断并加省略号**，完整值进 title", () => {
    const long = {
      vendor: "VeryLongVendorName",
      product: "VeryLongProductName",
      version: "9.9.9.9",
    } as never;
    const summary = fingerprintSummary([long]);
    assert.ok(summary.shown.length <= 31, "截断后不超过 31 字符（含省略号）");
    assert.ok(summary.shown.endsWith("…"));
    assert.equal(summary.full, "VeryLongVendorName VeryLongProductName 9.9.9.9");
  });

  it("没有指纹时显示 —", () => {
    assert.equal(fingerprintSummary([]).shown, "—");
    assert.equal(fingerprintSummary([]).full, "—");
  });

  it("portServiceText：三项拼接，全空显示「未知服务」", () => {
    assert.equal(
      portServiceText({ service: "http", product: "nginx", version: "1.24" } as never),
      "http nginx 1.24",
    );
    assert.equal(portServiceText({ service: "", product: "", version: "" } as never), "未知服务");
  });

  it("webServiceText 同口径（空 → 空串，不是「未知」）", () => {
    assert.equal(webServiceText({ service: "", product: "", version: "" } as never), "");
    assert.equal(webServiceText({ service: "http", product: "nginx", version: "" } as never), "http nginx");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：详情文本 */

describe("assets-model — 详情文本", () => {
  it("namesText：逗号分隔，空显示 —", () => {
    assert.equal(namesText(asset({ names: [{ name: "a.example.com" }, { name: "b.example.com" }] })), "a.example.com, b.example.com");
    assert.equal(namesText(asset({ names: [] })), "—");
  });

  it("noteLinesOf 跳过空行", () => {
    assert.deepEqual(noteLinesOf(asset({ test_notes: "a\n\nb\n" })), ["a", "b"]);
  });

  it("testMetaText：测过显示时间，没测过显示「未测过」", () => {
    assert.equal(testMetaText(asset({ test_updated_at: "" , test_updated_by: "" }), "—"), "未测过");
    assert.equal(
      testMetaText(asset({ test_updated_at: "2026-09-18T10:00:00Z", test_updated_by: "recon" }), "2026-09-18 10:00"),
      "2026-09-18 10:00 · recon",
    );
  });

  it("assessText：预期优先，缺省「未评估」", () => {
    assert.equal(assessText(asset({ potential: "RCE", assess_reason: "命中 CVE" })), "RCE · 命中 CVE");
    assert.equal(assessText(asset({ potential: "", assess_reason: "" })), "未评估");
  });

  it("surfaceText：有记录用记录，无记录看有无开放端口", () => {
    assert.equal(surfaceText(asset({ test_surface: "SMB 445" }), 2), "SMB 445");
    assert.equal(surfaceText(asset({ test_surface: "" }), 2), "未记录（开放端口见下）");
    assert.equal(surfaceText(asset({ test_surface: "" }), 0), "无开放端口");
  });

  it("provenanceText 报被动/主动端口数", () => {
    assert.equal(provenanceText(asset({ passive: 3, active: 5 })), "被动端口 3 · 主动端口 5");
  });

  it("assessLongText 拼优先级/预期/依据/时间，缺项自动跳过", () => {
    assert.equal(
      assessLongText(asset({ priority: "high", potential: "RCE", assess_reason: "命中", assessed_at: "T" }), "2026-09-18 10:00"),
      "high · 预期：RCE · 依据：命中（2026-09-18 10:00）",
    );
    assert.equal(assessLongText(asset({ priority: "", potential: "", assess_reason: "", assessed_at: "" }), "—"), "未评估");
  });

  it("detailFor：id 不匹配时不给详情（防止上一台的详情串到下一台）", () => {
    const item = asset({ id: 7 });
    assert.equal(detailFor(item, asset({ id: 8 })), null);
    assert.equal(detailFor(item, asset({ id: 7 }))?.id, 7);
    assert.equal(detailFor(item, null), null);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：过滤 */

describe("assets-model — 结论行语义", () => {
  it("**「全部」不算 query/service/port**（纯搜索不该让「全部」失亮）", () => {
    const filter: AssetFilter = { ...DEFAULT_ASSET_FILTER, query: "abc", service: "http", port: "80" };
    assert.equal(hasConclusionFilter(filter), false);
    assert.equal(isConclusionActive(filter, "all"), true);
  });

  it("任一家底筛选项生效时「全部」失亮", () => {
    assert.equal(isConclusionActive({ ...DEFAULT_ASSET_FILTER, priority: "high" }, "all"), false);
    assert.equal(isConclusionActive({ ...DEFAULT_ASSET_FILTER, cidr: "10.0.0.0/24" }, "all"), false);
    assert.equal(isConclusionActive({ ...DEFAULT_ASSET_FILTER, state: "live" }, "all"), false);
  });

  it("点「全部」清掉六项家底筛选（含 cidr），保留 sort", () => {
    const filter: AssetFilter = {
      ...DEFAULT_ASSET_FILTER,
      cidr: "10.0.0.0/24",
      testStatus: "tested",
      priority: "high",
      scope: "internal",
      provenance: "active",
      state: "live",
      sort: "ip",
    };
    const next = applyConclusion(filter, "all");
    assert.equal(next.cidr, null);
    assert.equal(next.testStatus, "");
    assert.equal(next.priority, "");
    assert.equal(next.scope, "");
    assert.equal(next.provenance, "");
    assert.equal(next.state, "");
    assert.equal(next.sort, "ip", "排序不属于筛选，不该被清");
  });

  it("**「存活」只动 state 并清 testStatus**（不碰其它）", () => {
    const filter: AssetFilter = { ...DEFAULT_ASSET_FILTER, testStatus: "tested", priority: "high" };
    const next = applyConclusion(filter, "live");
    assert.equal(next.state, "live");
    assert.equal(next.testStatus, "");
    assert.equal(next.priority, "high", "易打性筛选不该被清");
  });

  it("「存活」再点一次取消", () => {
    const next = applyConclusion({ ...DEFAULT_ASSET_FILTER, state: "live" }, "live");
    assert.equal(next.state, "");
  });

  it("**四个测试状态键共用一个字段，且都清 state**", () => {
    for (const key of ["untested", "testing", "tested"] as const) {
      const next = applyConclusion({ ...DEFAULT_ASSET_FILTER, state: "live", priority: "low" }, key);
      assert.equal(next.testStatus, key);
      assert.equal(next.state, "", key + " 必须清 state");
      assert.equal(next.priority, "low");
    }
  });

  it("**「放弃」是组合值 abandoned,blocked**", () => {
    const next = applyConclusion(DEFAULT_ASSET_FILTER, "giveup");
    assert.equal(next.testStatus, GIVEUP_STATUS_COMBINED);
    assert.equal(GIVEUP_STATUS_COMBINED, "abandoned,blocked");
    assert.equal(next.state, "");
  });

  it("「放弃」再点一次取消", () => {
    const on: AssetFilter = { ...DEFAULT_ASSET_FILTER, testStatus: GIVEUP_STATUS_COMBINED };
    assert.equal(applyConclusion(on, "giveup").testStatus, "");
  });

  it("互斥：从 tested 点 untested 会替换而不是叠加", () => {
    const next = applyConclusion({ ...DEFAULT_ASSET_FILTER, testStatus: "tested" }, "untested");
    assert.equal(next.testStatus, "untested");
  });

  it("conclusionItems 的六项顺序固定，且「放弃」是 abandoned + blocked", () => {
    const items = conclusionItems(
      conclusionStatsOf(snapshot({ assets: 10, liveAssets: 7, untested: 4, testing: 1, tested: 3, abandoned: 1, blocked: 2 })),
      DEFAULT_ASSET_FILTER,
    );
    assert.deepEqual(items.map((item) => item.key), ["all", "live", "untested", "testing", "tested", "giveup"]);
    assert.equal(items[5]?.value, 3, "放弃 = 已放弃 1 + 被封禁 2");
  });

  it("conclusionItems 的 value 在计数缺失时是 0 而不是 NaN", () => {
    const items = conclusionItems(conclusionStatsOf({}), DEFAULT_ASSET_FILTER);
    assert.equal(items[0]?.value, 0);
    assert.ok(items.every((item) => Number.isFinite(item.value)));
  });
});

describe("assets-model — 请求构造", () => {
  it("空串筛选项被丢掉（不发空 filter）", () => {
    const request = assetsRequest("eng-1", DEFAULT_ASSET_FILTER);
    assert.equal(request["cidr"], undefined);
    assert.equal(request["q"], undefined);
    assert.equal(request["service"], undefined);
    assert.equal(request["port"], undefined);
    assert.equal(request["provenance"], undefined);
    assert.equal(request["test_status"], undefined);
    assert.equal(request["priority"], undefined);
    assert.equal(request["scope"], undefined);
    assert.equal(request["state"], undefined);
  });

  it("sort 与 limit 恒定带上", () => {
    const request = assetsRequest("eng-1", DEFAULT_ASSET_FILTER);
    assert.equal(request["sort"], "priority");
    assert.equal(request["limit"], 400);
    assert.equal(request["engagement"], "eng-1");
    assert.equal(request["op"], "assets");
  });

  it("填了的筛选项透传（含 test_status 组合值）", () => {
    const request = assetsRequest("eng-1", {
      ...DEFAULT_ASSET_FILTER,
      cidr: "10.0.0.0/24",
      query: "oa",
      testStatus: GIVEUP_STATUS_COMBINED,
      scope: "internal",
    });
    assert.equal(request["cidr"], "10.0.0.0/24");
    assert.equal(request["q"], "oa");
    assert.equal(request["test_status"], "abandoned,blocked");
    assert.equal(request["scope"], "internal");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：域名/Web/时间线 */

describe("assets-model — 域名维度", () => {
  it("domainGroupsOf 解析域名与资产（丢空域名）", () => {
    const groups = domainGroupsOf({
      items: [
        { domain: "oa.example.com", count: 2, assets: [{ id: 1, ip: "1.1.1.1", segment: "1.1.1.0/24", state: "live", names: ["oa"] }] },
        { domain: "", assets: [] },
      ],
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.domain, "oa.example.com");
    assert.equal(groups[0]?.assets[0]?.ip, "1.1.1.1");
  });

  it("count 缺失时用 assets 长度兜底", () => {
    const groups = domainGroupsOf({ items: [{ domain: "a", assets: [{ ip: "1.1.1.1" }, { ip: "1.1.1.2" }] }] });
    assert.equal(groups[0]?.count, 2);
  });

  it("domainEmptyText：C 段筛选与全量两套文案", () => {
    assert.match(domainEmptyText("10.0.0.0/24"), /该 C 段下暂无域名/);
    assert.match(domainEmptyText(null), /暂无域名数据/);
  });
});

describe("assets-model — Web 维度", () => {
  it("webAssetsOf 解析并丢无 IP 项", () => {
    const assets = webAssetsOf({
      items: [
        { port_id: 1, port: 80, ip: "1.1.1.1", segment_cidr: "1.1.1.0/24", title: "首页" },
        { port_id: 2, port: 80 },
      ],
    });
    assert.equal(assets.length, 1);
    assert.equal(assets[0]?.title, "首页");
  });

  it("**有 url 就用 url**", () => {
    assert.equal(
      webAssetUrl({ port: 8080, ip: "1.1.1.1", url: "https://oa.example.com/" } as never),
      "https://oa.example.com/",
    );
  });

  it("**443/8443/9443 按 https，且默认端口不带端口号**", () => {
    assert.equal(webAssetUrl({ port: 443, ip: "1.1.1.1", url: "" } as never), "https://1.1.1.1");
    assert.equal(webAssetUrl({ port: 9443, ip: "1.1.1.1", url: "" } as never), "https://1.1.1.1:9443");
  });

  it("80 按 http 且不带端口号", () => {
    assert.equal(webAssetUrl({ port: 80, ip: "1.1.1.1", url: "" } as never), "http://1.1.1.1");
  });

  it("其它端口按 http 带端口号", () => {
    assert.equal(webAssetUrl({ port: 8080, ip: "1.1.1.1", url: "" } as never), "http://1.1.1.1:8080");
  });

  it("webEmptyText：C 段筛选与全量两套文案", () => {
    assert.match(webEmptyText("10.0.0.0/24"), /该 C 段下暂无 Web 资产/);
    assert.match(webEmptyText(null), /暂无 Web 资产/);
  });
});

describe("assets-model — 发现时间线", () => {
  it("discoveryOf：ok=false → null", () => {
    assert.equal(discoveryOf({ ok: false, error: "x" }), null);
  });

  it("discoveryOf：空对象 → null（失败与「没加载」要分开）", () => {
    assert.equal(discoveryOf({}), null);
  });

  it("discoveryOf 解析 span/days/recent", () => {
    const data = discoveryOf({
      span: { total: 3, first: "2026-09-01T00:00:00Z", last: "2026-09-18T00:00:00Z" },
      days: [{ day: "2026-09-17", assets: 2, internal: 1, external: 1 }],
      recent: [{ id: 1, ip: "1.1.1.1", scope: "internal", primary_name: "oa", open_ports: 3, priority: "high" }],
    });
    assert.equal(data?.total, 3);
    assert.equal(data?.days[0]?.assets, 2);
    assert.equal(data?.recent[0]?.scope, "internal");
  });

  it("**按天筛选比对 ISO 串前 10 字符**（不做时区换算）", () => {
    const recent = discoveryOf({
      span: {},
      days: [],
      recent: [
        { id: 1, ip: "1.1.1.1", discovered_at: "2026-09-17T23:59:00Z" },
        { id: 2, ip: "1.1.1.2", discovered_at: "2026-09-18T00:01:00Z" },
      ],
    })?.recent ?? [];
    assert.deepEqual(filterDiscoveryByDay(recent, "2026-09-17").map((a) => a.id), [1]);
    assert.equal(filterDiscoveryByDay(recent, "").length, 2);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：空态 */

describe("renderAssetsTab — 四种空态", () => {
  it("**未选靶标**：渲染真实空态提示", () => {
    const { result } = render({ engagement: null });
    assert.match(result.text, new RegExp(NO_ENGAGEMENT_TEXT.slice(0, 8)));
  });

  it("未选靶标时不渲染侧栏与工具栏（不该有半截界面）", () => {
    const { result } = render({ engagement: null });
    assert.doesNotMatch(result.text, /全部 C 段/);
    assert.doesNotMatch(result.text, /排序：易打性优先/);
  });

  it("**列表未加载**（list=null）时表头仍渲染、不显示空态", () => {
    const { result } = render({ list: null });
    assert.match(result.text, /开放端口 \/ 服务/);
    assert.doesNotMatch(result.text, /没有匹配的资产/);
  });

  it("**无数据**（list 空数组）显示「没有匹配的资产」", () => {
    const { result } = render({ list: { loading: false, error: null, total: 0, items: [] } });
    assert.match(result.text, /没有匹配的资产/);
  });

  it("**请求失败**时显示错误条", () => {
    const { result } = render({ list: { loading: false, error: "查询超时", total: 0, items: [] } });
    const errorNode = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(errorNode, null);
    assert.match(result.text, /查询超时/);
  });

  it("加载中（loading=true 且空）不显示空态（避免闪一下「没有匹配」）", () => {
    const { result } = render({ list: { loading: true, error: null, total: 0, items: [] } });
    assert.doesNotMatch(result.text, /没有匹配的资产/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：侧栏 */

describe("renderAssetsTab — 侧栏", () => {
  it("固定两项「全部 C 段」「当前测试」", () => {
    const { result } = render({ snapshot: snapshot() });
    assert.match(result.text, /全部 C 段/);
    assert.match(result.text, /当前测试/);
    assert.match(result.text, /1 个网段/);
  });

  it("外网与内网分组各带 C 段数与资产总数", () => {
    const { result } = render({
      snapshot: snapshot({
        segments: [
          segment({ cidr: "203.0.113.0/24", scope: "external", assets: 10 }),
          segment({ cidr: "10.0.0.0/24", scope: "internal", assets: 4 }),
        ],
      }),
    });
    assert.match(result.text, /外网资产 · 1 个 C 段/);
    assert.match(result.text, /内网资产 · 1 个 C 段/);
    assert.match(result.text, /4 资产/);
  });

  it("被选中的 C 段带 on 类名与 aria-expanded", () => {
    const { result } = render({
      snapshot: snapshot(),
      filter: { ...DEFAULT_ASSET_FILTER, cidr: "203.0.113.0/24" },
    });
    const selected = findAll(result, (element) => classOf(element) === "rt-seg on");
    assert.ok(selected.length >= 1);
    assert.equal(selected[0]?.props["aria-expanded"], "true");
  });

  it("点 C 段 → 切回列表并设 cidr", () => {
    const changes: AssetFilter[] = [];
    const views: string[] = [];
    const { result } = render({
      snapshot: snapshot(),
      onFilterChange: (filter) => changes.push(filter),
      onViewChange: (view) => views.push(view),
    });
    const seg = findAll(result, (element) => classOf(element) === "rt-seg")
      .find((element) => textOf(element).includes("203.0.113.0/24"));
    fire(seg!, "onClick");
    assert.equal(changes[0]?.cidr, "203.0.113.0/24");
    assert.equal(views[0], "list");
  });

  it("**内网分组默认展开**（`stored === undefined` → 展开）", () => {
    const { result } = render({
      snapshot: snapshot({ segments: [segment({ cidr: "10.0.0.0/24", scope: "internal" })] }),
    });
    assert.match(result.text, /10.0.0.0\/24/);
  });

  it("折叠后不渲染 C 段条目，但组标题还在", () => {
    const { result } = render({
      snapshot: snapshot({ segments: [segment({ cidr: "203.0.113.0/24" })] }),
      collapsed: { "scope:external": false },
    });
    assert.match(result.text, /外网资产 · 1 个 C 段/);
    assert.doesNotMatch(result.text, /203\.0\.113\.0\/24/);
  });

  it("点组标题 → 切回列表并切换折叠", () => {
    const views: string[] = [];
    const toggles: string[] = [];
    const { result } = render({
      snapshot: snapshot(),
      onViewChange: (view) => views.push(view),
      onToggleSideGroup: (scope) => toggles.push(scope),
    });
    const head = findAll(result, (element) => classOf(element) === "rt-sidehead rt-sidehead-btn")[0];
    fire(head!, "onClick");
    assert.deepEqual(views, ["list"]);
    assert.deepEqual(toggles, ["external"]);
  });

  it("组标题键盘可达（Enter / Space）", () => {
    const toggles: string[] = [];
    const { result } = render({ snapshot: snapshot(), onToggleSideGroup: (scope) => toggles.push(scope) });
    const head = findAll(result, (element) => classOf(element) === "rt-sidehead rt-sidehead-btn")[0];
    fire(head!, "onKeyDown", { key: "Enter" });
    fire(head!, "onKeyDown", { key: " " });
    assert.deepEqual(toggles, ["external", "external"]);
  });

  it("「当前测试」高亮时 aria-expanded=true", () => {
    const { result } = render({ snapshot: snapshot(), view: "testing" });
    const seg = findAll(result, (element) => classOf(element) === "rt-seg on")
      .find((element) => textOf(element).includes("当前测试"));
    assert.equal(seg?.props["aria-expanded"], "true");
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：工具栏 */

describe("renderAssetsTab — 工具栏", () => {
  it("搜索框预填草稿值（不是已生效值）", () => {
    const { result } = render({ searchDraft: "草稿", filter: { ...DEFAULT_ASSET_FILTER, query: "已生效" } });
    const search = findAll(result, "input").find((element) => String(element.props["placeholder"]).includes("搜索 IP"));
    assert.equal(search?.props["value"], "草稿");
  });

  it("回车触发 onSearch（草稿 → 已生效）", () => {
    const searches: number[] = [];
    const { result } = render({ onSearch: () => searches.push(1) });
    const search = findAll(result, "input").find((element) => String(element.props["placeholder"]).includes("搜索 IP"));
    fire(search!, "onKeyDown", { key: "Enter" });
    assert.equal(searches.length, 1);
  });

  it("点「搜索」也触发 onSearch", () => {
    const searches: number[] = [];
    const { result } = render({ onSearch: () => searches.push(1) });
    const button = findAll(result, "button").find((element) => textOf(element) === "搜索");
    fire(button!, "onClick");
    assert.equal(searches.length, 1);
  });

  it("改搜索草稿触发 onSearchDraftChange（不直接改 filter）", () => {
    const drafts: string[] = [];
    const changes: AssetFilter[] = [];
    const { result } = render({
      onSearchDraftChange: (value) => drafts.push(value),
      onFilterChange: (filter) => changes.push(filter),
    });
    const search = findAll(result, "input").find((element) => String(element.props["placeholder"]).includes("搜索 IP"));
    fire(search!, "onChange", { target: { value: "oa" } });
    assert.deepEqual(drafts, ["oa"]);
    assert.deepEqual(changes, []);
  });

  it("服务与端口输入框直接改 filter", () => {
    const changes: AssetFilter[] = [];
    const { result } = render({ onFilterChange: (filter) => changes.push(filter) });
    const service = findAll(result, "input").find((element) => element.props["placeholder"] === "服务");
    const port = findAll(result, "input").find((element) => element.props["placeholder"] === "端口");
    fire(service!, "onChange", { target: { value: "http" } });
    fire(port!, "onChange", { target: { value: "443" } });
    assert.equal(changes[0]?.service, "http");
    assert.equal(changes[1]?.port, "443");
  });

  it("内外网下拉的非法值收敛为「不限」", () => {
    const changes: AssetFilter[] = [];
    const { result } = render({ onFilterChange: (filter) => changes.push(filter) });
    const select = findAll(result, "select")
      .find((element) => textOf(element).includes("内外网不限"));
    fire(select!, "onChange", { target: { value: "乱填" } });
    assert.equal(changes[0]?.scope, "");
  });

  it("四个视图按钮，当前视图带 primary 类", () => {
    const { result } = render({ view: "domain" });
    const buttons = findAll(result, "button").filter((element) =>
      ["列表", "发现时间", "域名", "Web"].includes(textOf(element)));
    assert.equal(buttons.length, 4);
    const active = buttons.find((element) => classOf(element).includes("rt-btn-primary"));
    assert.equal(textOf(active!), "域名");
  });

  it("点视图按钮触发 onViewChange", () => {
    const views: string[] = [];
    const { result } = render({ onViewChange: (view) => views.push(view) });
    const button = findAll(result, "button").find((element) => textOf(element) === "Web");
    fire(button!, "onClick");
    assert.deepEqual(views, ["web"]);
  });

  it("刷新按钮带 title 并触发 onRefresh", () => {
    let count = 0;
    const { result } = render({ onRefresh: () => (count += 1) });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    assert.match(String(button?.props["title"]), /重新拉取/);
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("**测试视图不渲染工具栏**（内嵌页自带界面）", () => {
    const { result } = render({ view: "testing", renderTesting: () => null });
    assert.doesNotMatch(result.text, /搜索 IP/);
  });

  it("结论行在任何视图都渲染（家底分布始终可见）", () => {
    const { result } = render({ view: "testing", snapshot: snapshot(), renderTesting: () => null });
    assert.match(result.text, /台资产/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：结论行 */

describe("renderAssetsTab — 结论行", () => {
  it("六项计数与标签都在", () => {
    const { result } = render({ snapshot: snapshot({ assets: 10, liveAssets: 7, untested: 4, testing: 1, tested: 3, abandoned: 1, blocked: 2 }) });
    for (const label of ["台资产", "存活", "待测", "测试中", "已测", "放弃"]) {
      assert.match(result.text, new RegExp(label));
    }
    assert.match(result.text, /10/);
  });

  it("**计数为 0 时渲染 0 而不是空白**（React 假值坑）", () => {
    const { result } = render({ snapshot: snapshot({ assets: 0, liveAssets: 0, untested: 0, testing: 0, tested: 0, abandoned: 0, blocked: 0 }) });
    const concl = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    assert.equal(concl.length, 6);
    // textOf 会把子元素渲染成 `<b>0</b>`：以它开头就证明 0 真的被渲染成了文本
    // （`{value && <b/>}` 在 0 时会退化成裸 "0" 甚至什么都不渲染）。
    for (const item of concl) {
      assert.match(textOf(item), /^<b>0<\/b>/, "每一项的计数都应是渲染出的 0");
    }
    assert.doesNotMatch(result.text, /undefined|NaN/);
  });

  it("点「放弃」写入组合值", () => {
    const changes: AssetFilter[] = [];
    const { result } = render({ snapshot: snapshot(), onFilterChange: (filter) => changes.push(filter) });
    const node = findAll(result, (element) => classOf(element) === "rt-concl-i")
      .find((element) => textOf(element).includes("放弃"));
    fire(node!, "onClick");
    assert.equal(changes[0]?.testStatus, GIVEUP_STATUS_COMBINED);
  });

  it("点「全部」清空筛选", () => {
    const changes: AssetFilter[] = [];
    const { result } = render({
      snapshot: snapshot(),
      filter: { ...DEFAULT_ASSET_FILTER, priority: "high", state: "live" },
      onFilterChange: (filter) => changes.push(filter),
    });
    const node = findAll(result, (element) => classOf(element) === "rt-concl-i")
      .find((element) => textOf(element).includes("台资产"));
    fire(node!, "onClick");
    assert.equal(changes[0]?.priority, "");
    assert.equal(changes[0]?.state, "");
  });

  it("生效的结论项带 on 类名", () => {
    const { result } = render({ snapshot: snapshot(), filter: { ...DEFAULT_ASSET_FILTER, testStatus: "tested" } });
    const active = findAll(result, (element) => classOf(element) === "rt-concl-i on");
    assert.equal(active.length, 1);
    assert.match(textOf(active[0]!), /已测/);
  });

  it("结论项键盘可达（Enter）", () => {
    const changes: AssetFilter[] = [];
    const { result } = render({ snapshot: snapshot(), onFilterChange: (filter) => changes.push(filter) });
    const node = findAll(result, (element) => classOf(element) === "rt-concl-i")
      .find((element) => textOf(element).includes("存活"));
    fire(node!, "onKeyDown", { key: "Enter" });
    assert.equal(changes[0]?.state, "live");
  });

  it("排序下拉的非法值回落到 priority", () => {
    const changes: AssetFilter[] = [];
    const { result } = render({ snapshot: snapshot(), onFilterChange: (filter) => changes.push(filter) });
    const select = findAll(result, "select").find((element) => textOf(element).includes("排序：按 IP"));
    fire(select!, "onChange", { target: { value: "乱填" } });
    assert.equal(changes[0]?.sort, "priority");
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：列表 */

describe("renderAssetsTab — 列表行", () => {
  it("渲染 IP / 易打性 / 测试状态 / 端口 / 指纹", () => {
    const { result } = render({ list: { loading: false, error: null, total: 1, items: [asset()] } });
    assert.match(result.text, /203\.0\.113\.5/);
    assert.match(result.text, /高/);
    assert.match(result.text, /未测试/);
    assert.match(result.text, /22\/ssh, 80\/http/);
    assert.match(result.text, /Apache httpd 2\.4\.49/);
  });

  it("**未评估的易打性显示「未评」**（列不塌）", () => {
    const { result } = render({ list: { loading: false, error: null, total: 1, items: [asset({ priority: "" })] } });
    assert.match(result.text, /未评/);
  });

  it("有封禁次数时显示「封N」", () => {
    const { result } = render({ list: { loading: false, error: null, total: 1, items: [asset({ blocked_count: 3 })] } });
    assert.match(result.text, /封3/);
  });

  it("**封禁次数为 0 时不渲染「封0」**（三元而非 &&）", () => {
    const { result } = render({ list: { loading: false, error: null, total: 1, items: [asset({ blocked_count: 0 })] } });
    assert.doesNotMatch(result.text, /封0/);
  });

  it("发现时间未知时显示「发现时间未知」", () => {
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [asset({ discovered_at: "" })] },
    });
    assert.match(result.text, /发现时间未知/);
  });

  it("点资产行触发 onToggleRow", () => {
    const toggles: number[] = [];
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [asset({ id: 9 })] },
      onToggleRow: (id) => toggles.push(id),
    });
    const row = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => String(element.props["aria-label"]).includes("展开资产"));
    fire(row!, "onClick");
    assert.deepEqual(toggles, [9]);
  });

  it("资产行键盘可达（Enter / Space）", () => {
    const toggles: number[] = [];
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [asset({ id: 9 })] },
      onToggleRow: (id) => toggles.push(id),
    });
    const row = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => String(element.props["aria-label"]).includes("展开资产"));
    fire(row!, "onKeyDown", { key: "Enter" });
    fire(row!, "onKeyDown", { key: " " });
    assert.deepEqual(toggles, [9, 9]);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：详情 */

describe("renderAssetsTab — 展开详情", () => {
  it("未取到详情时显示「加载中…」", () => {
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [asset({ id: 1 })] },
      openId: 1,
      detail: null,
    });
    assert.match(result.text, /加载中/);
  });

  it("详情必读三行：测试 / 易打性 / 攻击面", () => {
    const item = asset({ id: 1, test_status: "tested", potential: "RCE", test_surface: "SMB 445" });
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
    });
    assert.match(result.text, /测试/);
    assert.match(result.text, /易打性/);
    assert.match(result.text, /攻击面/);
    assert.match(result.text, /SMB 445/);
    assert.match(result.text, /内网资产|外网资产/);
  });

  it("未展开「全部」时不显示端口明细与采集溯源", () => {
    const item = asset({ id: 1 });
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
    });
    assert.match(result.text, /展开全部/);
    assert.doesNotMatch(result.text, /采集溯源（最近 8 条）/);
    // 表头那行本来就有「开放端口 / 服务」，所以断言端口**明细行**不出现。
    assert.doesNotMatch(result.text, /22\/tcp/);
    assert.doesNotMatch(result.text, /主机名/);
  });

  it("展开「全部」后显示端口明细 / 指纹 / 采集溯源", () => {
    const item = asset({ id: 1, observations: [{ attr: "title", value: "首页", tool: "httpx" }] });
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
      showAllId: 1,
    });
    assert.match(result.text, /收起全部/);
    assert.match(result.text, /开放端口 \/ 服务/);
    assert.match(result.text, /指纹/);
    assert.match(result.text, /采集溯源（最近 8 条）/);
    assert.match(result.text, /首页/);
  });

  it("点「展开全部」触发 onToggleShowAll", () => {
    const item = asset({ id: 1 });
    const toggles: (number | null)[] = [];
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
      onToggleShowAll: (id) => toggles.push(id),
    });
    const more = findAll(result, (element) => classOf(element) === "rt-more")[0];
    fire(more!, "onClick");
    assert.deepEqual(toggles, [1]);
  });

  it("测试记录折叠块出现并可复制", () => {
    const item = asset({ id: 1, test_notes: "扫了端口\n扫了目录" });
    const copied: string[] = [];
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
      showAllId: 1,
      onCopy: (text) => copied.push(text),
    });
    assert.match(result.text, /测试记录（2 条）/);
    const button = findAll(result, "button").find((element) => textOf(element) === "复制");
    fire(button!, "onClick");
    assert.deepEqual(copied, ["扫了端口\n扫了目录"]);
  });

  it("测试记录展开态由 props 决定", () => {
    const item = asset({ id: 1, test_notes: "a" });
    const closed = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
      showAllId: 1,
      notesOpen: false,
    });
    const closedClip = findOne(closed.result, (element) => classOf(element) === "rt-clip");
    assert.notEqual(closedClip, null);
    assert.doesNotMatch(classOf(closedClip!), /open/);

    const open = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: item,
      showAllId: 1,
      notesOpen: true,
    });
    const openClip = findOne(open.result, (element) => classOf(element) === "rt-clip open");
    assert.notEqual(openClip, null);
  });

  it("详情里的旧 id 不显示（防串台）", () => {
    const item = asset({ id: 1 });
    const { result } = render({
      list: { loading: false, error: null, total: 1, items: [item] },
      openId: 1,
      detail: asset({ id: 99, ip: "9.9.9.9" }),
    });
    assert.match(result.text, /加载中/);
    assert.doesNotMatch(result.text, /9\.9\.9\.9/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：域名/Web/时间线 */

describe("renderAssetsTab — 域名视图", () => {
  it("加载中显示「加载中…」", () => {
    const { result } = render({ view: "domain", domains: null });
    assert.match(result.text, /加载中/);
  });

  it("无数据显示域名空态（C 段筛选时文案不同）", () => {
    const all = render({ view: "domain", domains: [] });
    assert.match(all.result.text, /暂无域名数据/);
    const filtered = render({
      view: "domain",
      domains: [],
      filter: { ...DEFAULT_ASSET_FILTER, cidr: "10.0.0.0/24" },
    });
    assert.match(filtered.result.text, /该 C 段下暂无域名/);
  });

  it("渲染域名分组与资产数", () => {
    const { result } = render({
      view: "domain",
      domains: [{ domain: "oa.example.com", count: 1, assets: [{ id: 1, ip: "1.1.1.1", segment: "1.1.1.0/24", state: "live", names: ["oa"] }] }],
    });
    assert.match(result.text, /oa\.example\.com/);
    assert.match(result.text, /1 个资产/);
    assert.match(result.text, /存活/);
  });

  it("点域名下的资产行回调 IP（回列表搜索它）", () => {
    const clicks: string[] = [];
    const { result } = render({
      view: "domain",
      domains: [{ domain: "a", count: 1, assets: [{ id: 1, ip: "1.1.1.1", segment: "s", state: "live", names: [] }] }],
      onDomainAssetClick: (ip) => clicks.push(ip),
    });
    const row = findAll(result, (element) => classOf(element) === "rt-row")
      .find((element) => textOf(element).includes("1.1.1.1"));
    fire(row!, "onClick");
    assert.deepEqual(clicks, ["1.1.1.1"]);
  });
});

describe("renderAssetsTab — Web 视图", () => {
  it("加载中显示「加载中…」", () => {
    const { result } = render({ view: "web", web: null });
    assert.match(result.text, /加载中/);
  });

  it("无数据时显示 Web 空态", () => {
    const { result } = render({ view: "web", web: [] });
    assert.match(result.text, /暂无 Web 资产/);
  });

  it("有数据时渲染可点击 URL 与标题", () => {
    const { result } = render({
      view: "web",
      web: [{ portId: 1, port: 443, url: "", title: "登录页", ip: "1.1.1.1", segmentCidr: "1.1.1.0/24", service: "https", product: "nginx", version: "1.24" }],
    });
    assert.match(result.text, /https:\/\/1\.1\.1\.1/);
    assert.match(result.text, /登录页/);
    assert.match(result.text, /https nginx 1\.24/);
  });
});

describe("renderAssetsTab — 发现时间视图", () => {
  it("错误优先显示", () => {
    const { result } = render({ view: "timeline", discoveryError: "加载失败" });
    assert.match(result.text, /加载失败/);
  });

  it("未加载显示加载中", () => {
    const { result } = render({ view: "timeline", discovery: null });
    assert.match(result.text, /加载中/);
  });

  it("没有资产时提示「还没有资产。」", () => {
    const { result } = render({
      view: "timeline",
      discovery: { total: 0, first: "", last: "", days: [], recent: [] },
    });
    assert.match(result.text, /还没有资产/);
  });

  it("渲染摘要、按天统计与最近资产", () => {
    const { result } = render({
      view: "timeline",
      discovery: {
        total: 2,
        first: "2026-09-01T00:00:00Z",
        last: "2026-09-18T00:00:00Z",
        days: [{ day: "2026-09-17", assets: 2, internal: 1, external: 1 }],
        recent: [
          { id: 1, ip: "1.1.1.1", scope: "internal", primaryName: "oa", discoveredAt: "2026-09-17T00:00:00Z", lastSeen: "", openPorts: 3, priority: "high" },
        ],
      },
    });
    assert.match(result.text, /共 2 台/);
    assert.match(result.text, /2026-09-17/);
    assert.match(result.text, /2 台 · 内 1 \/ 外 1/);
    assert.match(result.text, /oa · 3 端口/);
  });

  it("按天筛选后只留该天（空则提示）", () => {
    const { result } = render({
      view: "timeline",
      discoveryDay: "2026-09-01",
      discovery: {
        total: 1,
        first: "",
        last: "",
        days: [{ day: "2026-09-17", assets: 1, internal: 0, external: 1 }],
        recent: [{ id: 1, ip: "1.1.1.1", scope: "external", primaryName: "", discoveredAt: "2026-09-17T00:00:00Z", lastSeen: "", openPorts: 0, priority: "" }],
      },
    });
    assert.match(result.text, /这一天没有新增资产/);
    assert.match(result.text, /清除筛选：2026-09-01/);
  });

  it("点某一天切换筛选（再点取消）", () => {
    const days: string[] = [];
    const { result } = render({
      view: "timeline",
      discovery: {
        total: 1,
        first: "",
        last: "",
        days: [{ day: "2026-09-17", assets: 1, internal: 0, external: 1 }],
        recent: [],
      },
      onDiscoveryDayChange: (day) => days.push(day),
    });
    const chip = findAll(result, (element) => classOf(element).includes("rt-seg"))
      .find((element) => textOf(element).includes("2026-09-17"));
    fire(chip!, "onClick");
    assert.deepEqual(days, ["2026-09-17"]);
  });
});

/* ══════════════════════════════════════════════════════════════ 流程 */

describe("assets-model — 加载流程", () => {
  /** 假 api（记录请求）。 */
  function fakeApi(response: ApiResponse): ApiClient & { readonly calls: readonly Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const raw = async (request: { readonly op: string; readonly [key: string]: unknown }): Promise<ApiResponse> => {
      calls.push(request as unknown as Record<string, unknown>);
      return response;
    };
    return {
      calls,
      raw,
      snapshot: raw as never, assets: raw as never, asset: raw as never, vulns: raw as never,
      sessions: raw as never, chain: raw as never, scores: raw as never, report: raw as never,
      consoleDigest: raw as never, shotData: raw as never, activateEngagement: raw as never,
    } as unknown as ApiClient & { readonly calls: readonly Record<string, unknown>[] };
  }

  it("loadAssets 成功时返回解析后的列表", async () => {
    const api = fakeApi({ ok: true, total: 1, items: [{ id: 1, ip: "1.1.1.1" }] });
    const result = await loadAssets(api, "eng-1", DEFAULT_ASSET_FILTER);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.items.length, 1);
  });

  it("loadAssets 失败时返回 err（预期内失败不抛）", async () => {
    const api = fakeApi({ ok: false, error: "查询失败" });
    const result = await loadAssets(api, "eng-1", DEFAULT_ASSET_FILTER);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error, "查询失败");
  });

  it("loadDomains 带 cidr（null 时不带）", async () => {
    const api = fakeApi({ ok: true, items: [] });
    await loadDomains(api, "eng-1", "10.0.0.0/24");
    assert.equal(api.calls[0]?.["cidr"], "10.0.0.0/24");
    await loadDomains(api, "eng-1", null);
    assert.equal(api.calls[1]?.["cidr"], undefined);
  });

  it("loadWebAssets 失败时 err", async () => {
    const api = fakeApi({ ok: false, error: "读取失败" });
    const result = await loadWebAssets(api, "eng-1", null);
    assert.equal(result.ok, false);
  });

  it("loadDiscovery 成功返回数据", async () => {
    const good = fakeApi({ ok: true, span: { total: 1 }, days: [], recent: [] });
    const result = await loadDiscovery(good, "eng-1");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.total, 1);
  });

  it("loadDiscovery：**空响应体算失败**（不是「0 台资产」）", async () => {
    const empty = fakeApi({} as ApiResponse);
    const result = await loadDiscovery(empty, "eng-1");
    assert.equal(result.ok, false);
  });

  it("loadDiscovery：失败响应带回后端文案", async () => {
    const bad = fakeApi({ ok: false, error: "数据库忙" });
    const result = await loadDiscovery(bad, "eng-1");
    assert.equal(result.ok === false && result.error, "数据库忙");
  });

  it("loadDomains 成功时解析出分组", async () => {
    const api = fakeApi({ ok: true, items: [{ domain: "a", assets: [] }] });
    const result = await loadDomains(api, "eng-1", null);
    assert.equal(result.ok && result.value.length, 1);
  });
});
