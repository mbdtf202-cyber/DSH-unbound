/**
 * 得分复现报告页的模型 + 渲染测试。
 *
 * 重点是**兼容场景的分组逻辑**：
 * - 老 host 只给平铺条目时，前端按 `scoreChain` 的阶段信息重新分组
 * - 没被任何阶段认领的条目归「其他得分」，**不能凭空消失**
 * - `needsStageGrouping` 的两个条件必须同时成立（否则白跑一次请求）
 *
 * 以及复现材料的红线：没有步骤 / 没写命令 / 没有原始请求，三者都是硬缺口。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  copyFeedback,
  loadChainForGrouping,
  loadReport,
  loadReportWithGrouping,
  renderReportTab,
  reportErrorOf,
  type ReportTabProps,
} from "../../src/redteam/client/report-tab.js";
import {
  CIRCLED,
  COPY_FAILED_MESSAGE,
  EMPTY_REPORT_HINT,
  EMPTY_REPORT_TITLE,
  LOADING_REPORT_MESSAGE,
  MISSING_REQUESTS_MESSAGE,
  MISSING_STEPS_MESSAGE,
  MISSING_TOOL_MESSAGE,
  OTHER_STAGE_CODE,
  OTHER_STAGE_COLOR,
  OTHER_STAGE_NAME,
  REPORT_FOOTER,
  RESPONSE_PREVIEW_LIMIT,
  canCopyOrDownload,
  circledOf,
  copiedMessage,
  credentialLine,
  downloadFailedMessage,
  downloadFileName,
  downloadedMessage,
  groupByStage,
  hasStages,
  isLoaded,
  itemEvidenceLine,
  itemNthLabel,
  itemPointsLabel,
  itemRecordedLine,
  itemSeqLabel,
  itemTarget,
  itemVulnLine,
  needsStageGrouping,
  reportCredentialOf,
  reportDataOf,
  reportItemOf,
  reportRequestOf,
  reportShotOf,
  reportStageOf,
  reportStepOf,
  reportSummaryOf,
  reportTunnelOf,
  reportWebshellOf,
  requestBody,
  requestLabel,
  requestTitle,
  requestsText,
  responsePreview,
  stageCollapseKey,
  stageCountLabel,
  stageCumulativeLabel,
  stageKeys,
  stageOrdinalStyle,
  stagePointsLabel,
  stagePointsStyle,
  stageRefsFromChain,
  stepAgentLabel,
  stepIndexLabel,
  stepResultLine,
  stepTitleLabel,
  stepToolLine,
  summaryCappedLabel,
  summaryCappedTitle,
  summaryCompleteLabel,
  summaryCompleteWarn,
  summaryCountLabel,
  summaryPointsLabel,
  summaryRequestsLabel,
  summaryRequestsLive,
  tunnelHeading,
  tunnelLine,
  webshellHeading,
  webshellLine,
  withStages,
  type ReportData,
  type ReportItem,
  type ReportStage,
  type ReportStep,
} from "../../src/redteam/client/report-model.js";
import type { ApiResponse } from "../../src/redteam/client/api.js";
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
      createElement: () => { throw new Error("unused"); },
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

/** 造一条步骤。 */
function step(overrides: Partial<ReportStep> = {}): ReportStep {
  return {
    id: 1,
    title: "上传马",
    detail: "后台模板管理可上传",
    tool: "curl -F file=@shell.jsp http://x/upload",
    result: "上传成功",
    agent: "exploit",
    stageCode: "internet",
    evidenceRef: "runs/x.md",
    recordedAt: "2026-01-02T03:04:05Z",
    inferred: false,
    ...overrides,
  };
}

/** 造一条报告条目。 */
function item(overrides: Partial<ReportItem> = {}): ReportItem {
  return {
    id: 1,
    seq: 1,
    pointName: "服务器权限",
    points: 10,
    counted: true,
    nthOfPoint: 1,
    target: "10.0.0.5",
    assetIp: "10.0.0.5",
    gained: "服务器权限",
    evidence: "uid=0",
    recordedAt: "2026-01-02T03:04:05Z",
    recordedBy: "exploit",
    note: "",
    vulnCve: "",
    vulnTitle: "",
    how: "",
    incomplete: false,
    gaps: [],
    requests: [],
    steps: [step()],
    credentials: [],
    tunnels: [],
    webshells: [],
    shots: [],
    shotTotal: 0,
    ...overrides,
  };
}

/** 造一个阶段。 */
function stage(overrides: Partial<ReportStage> = {}): ReportStage {
  const items = overrides.items ?? [item()];
  return {
    code: "internet",
    name: "互联网资产权限",
    color: "#3b82f6",
    ordinal: 1,
    points: 10,
    cumulative: 10,
    items,
    ...overrides,
  };
}

/** 造报告数据。 */
function data(overrides: Partial<ReportData> = {}): ReportData {
  // 每个字段都判 `hasOwn`：`markdown: ""` / `target: ""` / `summary: null`
  // 都是**有意义的输入**（对应禁用/兜底分支），`??` 会把它们换成默认值。
  // `overrides[key]` 可能是 `undefined`（Partial 的可选字段），只有**非 undefined**
  // 才算「显式传了」—— `null` 要原样保留（它是有意义的输入）。
  const pick = <K extends keyof ReportData>(key: K, fallback: ReportData[K]): ReportData[K] => {
    const value = overrides[key];
    return value === undefined ? fallback : value;
  };
  return {
    target: pick("target", "eng-1"),
    markdown: pick("markdown", "# 报告正文"),
    items: pick("items", [item()]),
    stages: pick("stages", [stage()]),
    summary: pick("summary", {
      points: 10,
      count: 1,
      withRequests: 1,
      incomplete: 0,
      missingRequests: false,
      serviceCappedExcluded: 0,
      serviceCapped: [],
    }),
  };
}

/** 默认 props。 */
function props(overrides: Partial<ReportTabProps> = {}): ReportTabProps {
  return {
    data: data(),
    error: null,
    message: null,
    busy: false,
    collapse: {},
    onRefresh: () => undefined,
    onCopy: () => undefined,
    onDownload: () => undefined,
    onCollapseChange: () => undefined,
    onSetAllCollapsed: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<ReportTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderReportTab(runtime, props(overrides))) };
}

/** 造 api 替身。 */
function fakeApi(responses: readonly ApiResponse[]): {
  readonly requests: Record<string, unknown>[];
  readonly api: { raw: (request: Record<string, unknown>) => Promise<ApiResponse> };
} {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  return {
    requests,
    api: {
      raw: async (request) => {
        requests.push(request);
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return response ?? { ok: true };
      },
    },
  };
}

describe("report-model — 解析", () => {
  it("解析一条条目（含嵌套结构）", () => {
    const parsed = reportItemOf({
      id: 1,
      seq: 2,
      point_name: "RCE",
      points: 50,
      nth_of_point: 2,
      target: "http://x/",
      gained: "服务器权限",
      evidence: "uid=0",
      vuln: { cve: "CVE-1", title: "T" },
      steps: [{ id: 1, title: "s", tool: "cmd" }],
      requests: [{ request: "GET / HTTP/1.1" }],
      shots: [{ id: 1, kind: "screenshot" }],
      shot_total: 3,
    });
    assert.equal(parsed?.seq, 2);
    assert.equal(parsed?.vulnCve, "CVE-1");
    assert.equal(parsed?.steps.length, 1);
    assert.equal(parsed?.requests.length, 1);
    assert.equal(parsed?.shotTotal, 3);
  });

  it("丢没有 id 的条目", () => {
    assert.equal(reportItemOf({ seq: 1 }), null);
  });

  it("**counted 缺省算「计分」**", () => {
    assert.equal(reportItemOf({ id: 1 })?.counted, true);
    assert.equal(reportItemOf({ id: 1, counted: false })?.counted, false);
  });

  it("解析步骤", () => {
    const parsed = reportStepOf({ id: 1, title: "t", tool: "cmd", inferred: true });
    assert.equal(parsed?.tool, "cmd");
    assert.equal(parsed?.inferred, true);
  });

  it("解析原始请求（没有 id 字段，按「有没有字段」判空）", () => {
    assert.equal(reportRequestOf({}), null);
    const parsed = reportRequestOf({ method: "GET", status: 200, request: "GET / HTTP/1.1" });
    assert.equal(parsed?.method, "GET");
    assert.equal(parsed?.status, 200);
  });

  it("**只有响应没有请求也保留**（用来核对响应）", () => {
    const parsed = reportRequestOf({ response: "HTTP/1.1 200" });
    assert.equal(parsed?.request, "");
    assert.equal(parsed?.response, "HTTP/1.1 200");
  });

  it("解析凭据 / 隧道 / WebShell / 截图", () => {
    assert.equal(reportCredentialOf({ id: 1, host: "h" })?.host, "h");
    assert.equal(reportTunnelOf({ id: 1, kind: "suo5" })?.kind, "suo5");
    assert.equal(reportWebshellOf({ id: 1, shell_type: "godzilla" })?.shellType, "godzilla");
    assert.equal(reportShotOf({ id: 1, kind: "card" })?.kind, "card");
  });

  it("**隧道的 legit 三态**（true / false / null）", () => {
    assert.equal(reportTunnelOf({ id: 1, legit: true })?.legit, true);
    assert.equal(reportTunnelOf({ id: 1, legit: false })?.legit, false);
    assert.equal(reportTunnelOf({ id: 1 })?.legit, null);
  });

  it("解析摘要", () => {
    const parsed = reportSummaryOf({
      points: 100, count: 5, withRequests: 3, incomplete: 2, missingRequests: 4,
      serviceCappedExcluded: 1, serviceCapped: [{ service: "ssh", point_name: "服务器权限" }],
    });
    assert.equal(parsed?.points, 100);
    assert.equal(parsed?.missingRequests, true);
    assert.equal(parsed?.serviceCapped[0]?.service, "ssh");
  });

  it("空摘要 → null（工具栏不显示一排 0）", () => {
    assert.equal(reportSummaryOf({}), null);
    assert.equal(reportSummaryOf(undefined), null);
  });

  it("解析阶段（color 缺失时给默认灰）", () => {
    assert.equal(reportStageOf({ code: "recon" })?.color, OTHER_STAGE_COLOR);
  });

  it("丢没有 code 的阶段", () => {
    assert.equal(reportStageOf({ name: "没有 code" }), null);
  });

  it("reportDataOf 解析完整报告", () => {
    const parsed = reportDataOf({
      ok: true,
      target: "eng",
      markdown: "# md",
      items: [{ id: 1 }],
      stages: [{ code: "recon", items: [{ id: 1 }] }],
      summary: { points: 10 },
    });
    assert.equal(parsed?.target, "eng");
    assert.equal(parsed?.items.length, 1);
    assert.equal(parsed?.stages.length, 1);
  });

  it("失败响应 → null", () => {
    assert.equal(reportDataOf({ ok: false }), null);
  });
});

describe("report-model — 分组的兼容逻辑", () => {
  it("**服务端没阶段但有平铺条目 → 需要补分组**", () => {
    assert.equal(needsStageGrouping(data({ stages: [], items: [item()] })), true);
  });

  it("**已有阶段时不需要补**", () => {
    assert.equal(needsStageGrouping(data({ stages: [stage()] })), false);
  });

  it("**既没阶段也没条目时不需要补**（白跑一次请求）", () => {
    assert.equal(needsStageGrouping(data({ stages: [], items: [] })), false);
  });

  it("data 为 null 时不需要补", () => {
    assert.equal(needsStageGrouping(null), false);
  });

  it("按 id 把条目分到阶段", () => {
    const groups = groupByStage(
      [item({ id: 1 }), item({ id: 2 })],
      [{ code: "recon", name: "信息收集", color: "#111", ordinal: 1, points: 0, cumulative: 0, itemIds: [1] }],
    );
    assert.equal(groups[0]?.items.length, 1);
    assert.equal(groups[0]?.items[0]?.id, 1);
  });

  it("**空阶段不出现**（不占版面）", () => {
    const groups = groupByStage(
      [item({ id: 1 })],
      [
        { code: "recon", name: "信息收集", color: "#111", ordinal: 1, points: 0, cumulative: 0, itemIds: [1] },
        { code: "internal", name: "内网", color: "#222", ordinal: 2, points: 0, cumulative: 0, itemIds: [] },
      ],
    );
    assert.equal(groups.length, 1);
  });

  it("**没被认领的条目归「其他得分」**（不能凭空消失）", () => {
    const groups = groupByStage(
      [item({ id: 1 }), item({ id: 2 })],
      [{ code: "recon", name: "信息收集", color: "#111", ordinal: 1, points: 0, cumulative: 0, itemIds: [1] }],
    );
    const other = groups.find((group) => group.code === OTHER_STAGE_CODE);
    assert.equal(other?.name, OTHER_STAGE_NAME);
    assert.equal(other?.items.length, 1);
  });

  it("**完全没有阶段信息时所有条目进「其他得分」**", () => {
    const groups = groupByStage([item({ id: 1 }), item({ id: 2 })], []);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.code, OTHER_STAGE_CODE);
    assert.equal(groups[0]?.items.length, 2);
  });

  it("「其他得分」的分数只算 counted 的条目", () => {
    const groups = groupByStage(
      [item({ id: 1, points: 10 }), item({ id: 2, points: 50, counted: false })],
      [],
    );
    assert.equal(groups[0]?.points, 10);
  });

  it("阶段顺序沿用 chain 的顺序", () => {
    const groups = groupByStage(
      [item({ id: 1 }), item({ id: 2 })],
      [
        { code: "internal", name: "内网", color: "#222", ordinal: 2, points: 0, cumulative: 0, itemIds: [2] },
        { code: "recon", name: "信息收集", color: "#111", ordinal: 1, points: 0, cumulative: 0, itemIds: [1] },
      ],
    );
    assert.equal(groups[0]?.code, "internal");
  });

  it("**ordinal 为 0 时用数组序号兜底**", () => {
    const groups = groupByStage(
      [item({ id: 1 })],
      [{ code: "recon", name: "信息收集", color: "#111", ordinal: 0, points: 0, cumulative: 0, itemIds: [1] }],
    );
    assert.equal(groups[0]?.ordinal, 1);
  });

  it("stageRefsFromChain 抽取阶段引用", () => {
    const refs = stageRefsFromChain({
      ok: true,
      stages: [
        { code: "recon", name: "信息收集", color: "#111", ordinal: 1, points: 5, cumulative: 5, items: [{ id: 1 }, { id: 2 }] },
      ],
    });
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0]?.itemIds, [1, 2]);
  });

  it("stageRefsFromChain 丢没有 code 的阶段", () => {
    assert.deepEqual(stageRefsFromChain({ ok: true, stages: [{ name: "x" }] }), []);
  });

  it("stageRefsFromChain 失败 → 空表", () => {
    assert.deepEqual(stageRefsFromChain({ ok: false }), []);
  });

  it("withStages 只换 stages", () => {
    const base = data({ stages: [] });
    const next = withStages(base, [stage()]);
    assert.equal(next.stages.length, 1);
    assert.equal(next.markdown, base.markdown);
  });

  it("circledOf 用圈号，超出 20 个退化成数字", () => {
    assert.equal(circledOf(1), "①");
    assert.equal(circledOf(20), "⑳");
    assert.equal(circledOf(21), "21");
  });

  it("**circledOf(0) 不抛**", () => {
    assert.equal(circledOf(0), "0");
    assert.equal(circledOf(-1), "-1");
  });

  it("CIRCLED 有 20 个", () => {
    assert.equal(CIRCLED.length, 20);
  });
});

describe("report-model — 展示文案", () => {
  it("阶段标题的三块", () => {
    assert.equal(stageCountLabel(stage()), "1 项");
    assert.equal(stagePointsLabel(stage({ points: 30 })), "+30 分");
    assert.equal(stageCumulativeLabel(stage({ cumulative: 30 })), "累计 30 分");
  });

  it("阶段折叠键", () => {
    assert.equal(stageCollapseKey("recon"), "st:recon");
    assert.deepEqual([...stageKeys([stage({ code: "a" }), stage({ code: "b" })])], ["st:a", "st:b"]);
  });

  it("阶段样式", () => {
    assert.deepEqual(stagePointsStyle("#fff"), { background: "#fff22", color: "#fff", borderColor: "#fff66" });
    assert.deepEqual(stageOrdinalStyle("#fff"), { background: "#fff" });
  });

  it("条目的基础文案", () => {
    assert.equal(itemSeqLabel(item({ seq: 3 })), "3");
    assert.equal(itemPointsLabel(item({ points: 50 })), "+50 分");
    assert.equal(itemTarget(item({ target: "http://x/" })), "http://x/");
    assert.equal(itemTarget(item({ target: "" })), "10.0.0.5");
    assert.equal(itemTarget(item({ target: "", assetIp: "" })), "—");
  });

  it("「同类第 N 次」只在 >1 时显示", () => {
    assert.equal(itemNthLabel(item({ nthOfPoint: 1 })), null);
    assert.equal(itemNthLabel(item({ nthOfPoint: 2 })), "同类第 2 次");
  });

  it("漏洞行（都空 → null）", () => {
    assert.equal(itemVulnLine(item()), null);
    assert.equal(itemVulnLine(item({ vulnCve: "CVE-1" })), "CVE-1");
    assert.equal(itemVulnLine(item({ vulnCve: "CVE-1", vulnTitle: "T" })), "CVE-1 T");
  });

  it("取得时间行带角色中文名", () => {
    assert.match(itemRecordedLine(item()), /2026-01-02 03:04（漏洞利用）/);
  });

  it("**取得时间没有角色时不加空括号**", () => {
    assert.equal(itemRecordedLine(item({ recordedBy: "" })), "2026-01-02 03:04");
  });

  it("结果行的换行压成空格", () => {
    assert.equal(itemEvidenceLine(item({ evidence: "a\nb\n\nc" })), "a b c");
  });

  it("步骤的文案", () => {
    assert.equal(stepTitleLabel(step()), "上传马");
    assert.equal(stepTitleLabel(step({ title: "" })), "(未命名动作)");
    assert.equal(stepIndexLabel(0), "1");
    assert.equal(stepIndexLabel(9), "10");
    assert.equal(stepToolLine(step()), "curl -F file=@shell.jsp http://x/upload");
    assert.equal(stepToolLine(step({ tool: "" })), null);
    assert.equal(stepResultLine(step({ result: "a\nb" })), "a b");
    assert.equal(stepAgentLabel(step()), "漏洞利用");
    assert.equal(stepAgentLabel(step({ agent: "" })), null);
  });

  it("**未知角色 code 原样显示**", () => {
    assert.equal(stepAgentLabel(step({ agent: "weird" })), "weird");
  });

  it("凭据行说明来源可追溯", () => {
    const line = credentialLine({
      id: 1, host: "h", username: "root", secretType: "password", privilege: "admin",
      source: "dump", tool: "hashcat\n-x",
    });
    assert.match(line, /root \/ password/);
    assert.match(line, /来源 dump/);
    assert.match(line, /取得方式 hashcat/);
  });

  it("**凭据没有用户名时显示（无用户名）**", () => {
    const line = credentialLine({
      id: 1, host: "h", username: "", secretType: "", privilege: "", source: "", tool: "",
    });
    assert.match(line, /\(无用户名\) \/ password · 来源 未标注/);
  });

  it("隧道行说明目标侧归属", () => {
    const line = tunnelLine({
      id: 1, kind: "suo5", listen: "127.0.0.1:1080", entry: "http://x/shell.jsp",
      entryKind: "target-http", reach: "10.0.0.0/8", status: "active", command: "suo5 -t x", legit: false,
    });
    assert.match(line, /目标侧 target-http/);
    assert.match(line, /不算跨越靶标边界/);
  });

  it("**隧道 legit 为 null 时不出现越界警告**", () => {
    const line = tunnelLine({
      id: 1, kind: "", listen: "", entry: "", entryKind: "", reach: "", status: "", command: "", legit: null,
    });
    assert.doesNotMatch(line, /不算跨越靶标边界/);
    assert.match(line, /目标侧 未声明/);
  });

  it("隧道标题（kind 空时默认 socks5）", () => {
    assert.equal(tunnelHeading({
      id: 1, kind: "", listen: "127.0.0.1:1", entry: "", entryKind: "", reach: "", status: "", command: "", legit: null,
    }), "socks5 127.0.0.1:1");
  });

  it("WebShell 行与标题", () => {
    const line = webshellLine({
      id: 1, shellType: "godzilla", url: "http://x/a.jsp", passKey: "key", privilege: "root", status: "online",
    });
    assert.match(line, /口令\/密钥 key/);
    assert.equal(webshellHeading({
      id: 1, shellType: "", url: "", passKey: "", privilege: "", status: "",
    }), "shell");
  });

  it("请求标题带自动匹配说明", () => {
    const request = {
      request: "GET / HTTP/1.1", response: "", method: "GET", status: 200, url: "http://x/", source: "auto",
    };
    assert.match(requestTitle(0, request), /按目标路径自动匹配，请核对/);
  });

  it("**请求正文缺失时合成一行请求行**", () => {
    const request = { request: "", response: "", method: "POST", status: null, url: "http://x/a", source: "" };
    assert.equal(requestBody(request), "POST http://x/a HTTP/1.1");
  });

  it("请求标签（方法 + 状态码）", () => {
    assert.equal(requestLabel({ request: "", response: "", method: "GET", status: 200, url: "", source: "" }), "GET 200");
    assert.equal(requestLabel({ request: "", response: "", method: "", status: null, url: "", source: "" }), "GET ");
  });

  it("响应摘要截断到 1600 字符", () => {
    const long = "a".repeat(5000);
    const preview = responsePreview({ request: "", response: long, method: "", status: null, url: "", source: "" });
    assert.equal(preview?.length, RESPONSE_PREVIEW_LIMIT);
  });

  it("空响应 → null", () => {
    assert.equal(responsePreview({ request: "", response: "", method: "", status: null, url: "", source: "" }), null);
  });

  it("requestsText 过滤空请求并用双换行连接", () => {
    const text = requestsText(item({
      requests: [
        { request: "A", response: "", method: "", status: null, url: "", source: "" },
        { request: "", response: "R", method: "", status: null, url: "", source: "" },
        { request: "B", response: "", method: "", status: null, url: "", source: "" },
      ],
    }));
    assert.equal(text, "A\n\nB");
  });
});

describe("report-model — 摘要标签", () => {
  const summary = {
    points: 100, count: 5, withRequests: 3, incomplete: 2, missingRequests: true,
    serviceCappedExcluded: 1, serviceCapped: [{ service: "ssh", point_name: "服务器权限" }],
  };

  it("合计 / 项数 / 带请求 / 可复现", () => {
    assert.equal(summaryPointsLabel(summary), "合计 100 分");
    assert.equal(summaryCountLabel(summary), "5 项得分");
    assert.equal(summaryRequestsLabel(summary), "3/5 项带原始请求");
    assert.equal(summaryCompleteLabel(summary), "可复现 3/5");
  });

  it("summary 为 null 时全部返回 null", () => {
    assert.equal(summaryPointsLabel(null), null);
    assert.equal(summaryCountLabel(null), null);
    assert.equal(summaryRequestsLabel(null), null);
    assert.equal(summaryCompleteLabel(null), null);
    assert.equal(summaryCappedLabel(null), null);
  });

  it("**全带请求时用绿色**", () => {
    assert.equal(summaryRequestsLive({ ...summary, missingRequests: false }), true);
    assert.equal(summaryRequestsLive(summary), false);
  });

  it("**有缺口时用警示色**", () => {
    assert.equal(summaryCompleteWarn(summary), true);
    assert.equal(summaryCompleteWarn({ ...summary, incomplete: 0 }), false);
  });

  it("同服务已拿满的标签只在有排除项时出现", () => {
    assert.equal(summaryCappedLabel(summary), "同服务已拿满不计分 1");
    assert.equal(summaryCappedLabel({ ...summary, serviceCappedExcluded: 0 }), null);
  });

  it("同服务已拿满的 tooltip 列出服务", () => {
    assert.equal(summaryCappedTitle(summary), "ssh｜服务器权限");
  });

  it("**tooltip 空列表时给解释**", () => {
    assert.match(summaryCappedTitle({ ...summary, serviceCapped: [] }), /服务已拿满/);
  });
});

describe("report-model — 下载与复制", () => {
  it("**下载文件名把非标识符字符逐个换成下划线**", () => {
    assert.equal(downloadFileName("eng-1"), "report-eng-1.md");
    // 汉字各占一个 `_`，空格与 `/` 也各占一个 —— 逐字符替换，不是整段折叠。
    assert.equal(downloadFileName("靶标 A/B"), "report-___A_B.md");
  });

  it("中文 label 变成下划线（保留原行为）", () => {
    const name = downloadFileName("示例");
    assert.match(name, /^report-_+\.md$/);
  });

  it("空 label 用 score 兜底", () => {
    assert.equal(downloadFileName(""), "report-score.md");
  });

  it("下载与复制提示文案", () => {
    assert.equal(downloadedMessage("eng"), "已下载：eng");
    assert.match(downloadFailedMessage(new Error("配额满")), /下载失败：配额满/);
    assert.equal(copiedMessage("整份报告"), "已复制：整份报告");
    assert.match(COPY_FAILED_MESSAGE, /复制失败/);
  });

  it("没正文时不能复制/下载", () => {
    assert.equal(canCopyOrDownload(false, ""), false);
    assert.equal(canCopyOrDownload(false, "md"), true);
    assert.equal(canCopyOrDownload(true, "md"), false);
  });

  it("isLoaded / hasStages 区分「没读回」与「读到但空」", () => {
    assert.equal(isLoaded(null), false);
    assert.equal(isLoaded(data()), true);
    assert.equal(hasStages(null), false);
    assert.equal(hasStages(data({ stages: [] })), false);
    assert.equal(hasStages(data()), true);
  });

  it("copyFeedback 的两种结果", () => {
    assert.deepEqual(copyFeedback(true, "x"), { kind: "ok", text: "已复制：x" });
    assert.deepEqual(copyFeedback(false, "x"), { kind: "err", text: COPY_FAILED_MESSAGE });
  });
});

describe("report-tab — 流程", () => {
  it("读报告", async () => {
    const { api, requests } = fakeApi([{ ok: true, items: [] }]);
    await loadReport(api as never, "eng-1");
    assert.equal(requests[0]?.["op"], "scoreReport");
  });

  it("读攻击链（补分组用）", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    await loadChainForGrouping(api as never, "eng-1");
    assert.equal(requests[0]?.["op"], "scoreChain");
  });

  it("reportErrorOf 取错误", () => {
    assert.equal(reportErrorOf({ ok: false, error: "生成失败" }), "生成失败");
    assert.equal(reportErrorOf({ ok: false }), "生成失败");
    assert.equal(reportErrorOf({ ok: true }), null);
  });

  it("**服务端已给阶段时不发第二次请求**", async () => {
    const { api, requests } = fakeApi([
      { ok: true, items: [{ id: 1 }], stages: [{ code: "recon", items: [{ id: 1 }] }] },
    ]);
    const result = await loadReportWithGrouping(api as never, "eng-1");
    assert.equal(requests.length, 1);
    assert.equal(result.data?.stages.length, 1);
  });

  it("**只给平铺条目时补分组**（老 host 兼容）", async () => {
    const { api, requests } = fakeApi([
      { ok: true, items: [{ id: 1 }], stages: [] },
      { ok: true, stages: [{ code: "recon", name: "信息收集", color: "#111", ordinal: 1, items: [{ id: 1 }] }] },
    ]);
    const result = await loadReportWithGrouping(api as never, "eng-1");
    assert.equal(requests.length, 2);
    assert.equal(result.data?.stages.length, 1);
    assert.equal(result.data?.stages[0]?.code, "recon");
  });

  it("**补分组请求失败时条目全部归「其他得分」**（一条都不丢）", async () => {
    const { api } = fakeApi([
      { ok: true, items: [{ id: 1 }, { id: 2 }], stages: [] },
      { ok: false, error: "x" },
    ]);
    const result = await loadReportWithGrouping(api as never, "eng-1");
    assert.equal(result.error, null);
    assert.equal(result.data?.stages.length, 1);
    assert.equal(result.data?.stages[0]?.code, OTHER_STAGE_CODE);
    assert.equal(result.data?.stages[0]?.items.length, 2);
  });

  it("**既没阶段也没条目时不发第二次请求**", async () => {
    const { api, requests } = fakeApi([{ ok: true, items: [], stages: [] }]);
    await loadReportWithGrouping(api as never, "eng-1");
    assert.equal(requests.length, 1);
  });

  it("主请求失败时返回错误且不发第二次", async () => {
    const { api, requests } = fakeApi([{ ok: false, error: "库损坏" }]);
    const result = await loadReportWithGrouping(api as never, "eng-1");
    assert.equal(result.error, "库损坏");
    assert.equal(result.data, null);
    assert.equal(requests.length, 1);
  });
});

describe("renderReportTab — 工具栏", () => {
  it("渲染标题与摘要标签", () => {
    const { result } = render();
    assert.match(result.text, /攻击得分链路复现报告/);
    assert.match(result.text, /合计 10 分/);
    assert.match(result.text, /1 项得分/);
  });

  it("摘要缺失时不渲染那一排标签", () => {
    assert.doesNotMatch(render({ data: data({ summary: null }) }).result.text, /合计/);
  });

  it("**有缺口时「可复现」用警示色**", () => {
    const { result } = render({
      data: data({ summary: {
        points: 10, count: 2, withRequests: 1, incomplete: 1, missingRequests: true,
        serviceCappedExcluded: 0, serviceCapped: [],
      } }),
    });
    const badge = findAll(result, (element) => classOf(element) === "rt-tag rt-tag-warn");
    assert.ok(badge.some((element) => textOf(element).includes("可复现")));
  });

  it("同服务已拿满时渲染警示标签与 tooltip", () => {
    const { result } = render({
      data: data({ summary: {
        points: 10, count: 1, withRequests: 1, incomplete: 0, missingRequests: false,
        serviceCappedExcluded: 2, serviceCapped: [{ service: "ssh", point_name: "服务器权限" }],
      } }),
    });
    assert.match(result.text, /同服务已拿满不计分 2/);
    const badge = findAll(result, (element) => classOf(element) === "rt-tag rt-tag-warn")
      .find((element) => textOf(element).includes("同服务已拿满"));
    assert.equal(String(badge?.props["title"]), "ssh｜服务器权限");
  });

  it("点「复制全文」传 markdown", () => {
    const copied: { text: string; label: string }[] = [];
    const { result } = render({ onCopy: (text, label) => copied.push({ text, label }) });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制全文");
    fire(button!, "onClick");
    assert.equal(copied[0]?.text, "# 报告正文");
    assert.equal(copied[0]?.label, "整份报告");
  });

  it("**没有 markdown 时「复制全文」禁用**", () => {
    const { result } = render({ data: data({ markdown: "" }) });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制全文");
    assert.equal(button?.props["disabled"], true);
  });

  it("点「下载 .md」传文件名用的 label", () => {
    const downloads: { text: string; label: string }[] = [];
    const { result } = render({ onDownload: (text, label) => downloads.push({ text, label }) });
    const button = findAll(result, "button").find((element) => textOf(element) === "下载 .md");
    fire(button!, "onClick");
    assert.equal(downloads[0]?.label, "eng-1");
  });

  it("**没有 target 时下载 label 是空串**（文件名用 score 兜底）", () => {
    const downloads: { text: string; label: string }[] = [];
    const { result } = render({
      data: data({ target: "" }),
      onDownload: (text, label) => downloads.push({ text, label }),
    });
    const button = findAll(result, "button").find((element) => textOf(element) === "下载 .md");
    fire(button!, "onClick");
    assert.equal(downloads[0]?.label, "");
  });

  it("busy 时「重新生成」文案变「生成中…」且禁用", () => {
    const { result } = render({ busy: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("生成中"));
    assert.equal(button?.props["disabled"], true);
  });

  it("点「重新生成」触发 onRefresh", () => {
    let count = 0;
    const { result } = render({ onRefresh: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "重新生成");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("底部有口径说明", () => {
    assert.match(render().result.text, /只收录得分成果/);
  });
});

describe("renderReportTab — 阶段与条目", () => {
  it("渲染阶段标题与计数", () => {
    const { result } = render();
    assert.match(result.text, /互联网资产权限/);
    assert.match(result.text, /1 项/);
    assert.match(result.text, /\+10 分/);
    assert.match(result.text, /累计 10 分/);
  });

  it("阶段默认展开", () => {
    assert.match(render().result.text, /服务器权限/);
  });

  it("**阶段可折叠，折叠后条目不渲染**", () => {
    const { result } = render({ collapse: { "st:internet": false } });
    assert.doesNotMatch(result.text, /uid=0/);
  });

  it("点阶段头切换折叠", () => {
    const states: unknown[] = [];
    const { result } = render({ onCollapseChange: (state) => states.push(state) });
    const head = findOne(result, (element) => classOf(element) === "rt-rep-stage");
    fire(head!, "onClick");
    assert.equal(states.length, 1);
  });

  it("「全部展开/折叠」传全部键", () => {
    const calls: { keys: readonly string[]; open: boolean }[] = [];
    const { result } = render({ onSetAllCollapsed: (keys, open) => calls.push({ keys, open }) });
    const expand = findAll(result, "button").find((element) => textOf(element) === "全部展开");
    fire(expand!, "onClick");
    assert.deepEqual([...calls[0]!.keys], ["st:internet"]);
    assert.equal(calls[0]?.open, true);
  });

  it("渲染条目卡的目标 / 拿到 / 结果", () => {
    const { result } = render();
    assert.match(result.text, /目标 /);
    assert.match(result.text, /拿到 /);
    assert.match(result.text, /结果 /);
    assert.match(result.text, /uid=0/);
  });

  it("**条目缺 vuln / 缺 gained 时不渲染对应行**", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ gained: "", vulnCve: "", vulnTitle: "" })] })] }),
    });
    assert.doesNotMatch(result.text, /利用漏洞/);
  });

  it("**条目没有取得时间时不渲染时间行**", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ recordedAt: "" })] })] }),
    });
    assert.doesNotMatch(result.text, /取得时间/);
  });

  it("条目有备注时渲染备注行", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ note: "这里要人工复核" })] })] }),
    });
    assert.match(result.text, /这里要人工复核/);
  });

  it("点「复制请求」传拼好的请求文本", () => {
    const copied: { text: string; label: string }[] = [];
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            seq: 3,
            requests: [{ request: "GET / HTTP/1.1", response: "", method: "GET", status: 200, url: "", source: "" }],
          })],
        })],
      }),
      onCopy: (text, label) => copied.push({ text, label }),
    });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制请求");
    fire(button!, "onClick");
    assert.equal(copied[0]?.text, "GET / HTTP/1.1");
    assert.equal(copied[0]?.label, "第 3 项请求");
  });

  it("**证据截图的渲染槽可以注入**", () => {
    const { result } = render({ renderShots: (reportItem) => "截图条 " + reportItem.id });
    assert.match(result.text, /截图条 1/);
  });

  it("没有 renderShots 时不渲染截图区", () => {
    assert.doesNotMatch(render().result.text, /截图条/);
  });
});

describe("renderReportTab — 复现步骤", () => {
  it("渲染步骤的标题 / 命令 / 结果 / 证据", () => {
    const { result } = render();
    assert.match(result.text, /上传马/);
    assert.match(result.text, /执行 /);
    assert.match(result.text, /curl -F file/);
    assert.match(result.text, /结果 /);
    assert.match(result.text, /runs\/x\.md/);
  });

  it("**缺材料时 `<details>` 默认展开**（藏起来的缺口等于没有）", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ incomplete: true })] })] }),
    });
    const details = findOne(result, "details");
    assert.equal(details?.props["open"], true);
    assert.match(result.text, /复现材料待补/);
  });

  it("**没有步骤时也默认展开**（否则用户看不到缺什么）", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ steps: [] })] })] }),
    });
    assert.equal(findOne(result, "details")?.props["open"], true);
    assert.ok(result.text.includes(MISSING_STEPS_MESSAGE));
  });

  it("材料齐全时默认收起", () => {
    assert.equal(findOne(render().result, "details")?.props["open"], false);
    assert.match(render().result.text, /可复现/);
  });

  it("**步骤没写 tool 时给明确的补录提示**", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ steps: [step({ tool: "" })] })] })] }),
    });
    assert.ok(result.text.includes(MISSING_TOOL_MESSAGE));
  });

  it("有 tool 时渲染「复制命令」", () => {
    const copied: string[] = [];
    const { result } = render({ onCopy: (text) => copied.push(text) });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制命令");
    fire(button!, "onClick");
    assert.match(copied[0] ?? "", /curl/);
  });

  it("步骤的推断标记", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ steps: [step({ inferred: true })] })] })] }),
    });
    assert.match(result.text, /按同资产推断/);
  });

  it("步骤的角色与阶段标签", () => {
    const { result } = render();
    assert.match(result.text, /漏洞利用/);
    assert.match(result.text, /internet/);
  });

  it("**步骤的序号从 1 开始**", () => {
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({ steps: [step({ id: 1 }), step({ id: 2, title: "第二步" })] })],
        })],
      }),
    });
    assert.match(result.text, /<span>1<\/span>/);
    assert.match(result.text, /<span>2<\/span>/);
  });
});

describe("renderReportTab — 凭据 / 隧道 / WebShell", () => {
  it("渲染凭据块（来源可追溯）", () => {
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            credentials: [{
              id: 1, host: "10.0.0.5", username: "root", secretType: "password",
              privilege: "admin", source: "dump", tool: "hashcat",
            }],
          })],
        })],
      }),
    });
    assert.match(result.text, /拿到的凭据（来源可追溯）/);
    assert.match(result.text, /root \/ password/);
  });

  it("渲染隧道块（含目标侧归属）", () => {
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            tunnels: [{
              id: 1, kind: "suo5", listen: "127.0.0.1:1080", entry: "http://x/s.jsp",
              entryKind: "target-http", reach: "10.0.0.0/8", status: "active", command: "suo5", legit: true,
            }],
          })],
        })],
      }),
    });
    assert.match(result.text, /用到的隧道 \/ 通道/);
    assert.match(result.text, /目标侧 target-http/);
  });

  it("渲染 WebShell 块", () => {
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            webshells: [{
              id: 1, shellType: "godzilla", url: "http://x/a.jsp", passKey: "key", privilege: "root", status: "online",
            }],
          })],
        })],
      }),
    });
    assert.match(result.text, /用到的 WebShell/);
    assert.match(result.text, /godzilla/);
  });

  it("**没有凭据/隧道/WebShell 时不渲染对应块**", () => {
    const { result } = render();
    assert.doesNotMatch(result.text, /拿到的凭据/);
    assert.doesNotMatch(result.text, /用到的隧道/);
    assert.doesNotMatch(result.text, /用到的 WebShell/);
  });

  it("复现缺口列表", () => {
    const { result } = render({
      data: data({ stages: [stage({ items: [item({ gaps: ["缺命令", "缺证据"] })] })] }),
    });
    assert.match(result.text, /复现缺口：缺命令；缺证据/);
  });
});

describe("renderReportTab — 复现请求", () => {
  it("渲染请求块与「复制到 Yakit」", () => {
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            requests: [{
              request: "GET / HTTP/1.1\nHost: x", response: "", method: "GET", status: 200, url: "", source: "",
            }],
          })],
        })],
      }),
    });
    assert.match(result.text, /复现请求 1/);
    assert.match(result.text, /复制到 Yakit/);
  });

  it("**有响应时渲染响应摘要**", () => {
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            requests: [{
              request: "GET / HTTP/1.1", response: "HTTP/1.1 200 OK", method: "GET", status: 200, url: "", source: "",
            }],
          })],
        })],
      }),
    });
    assert.match(result.text, /响应摘要/);
  });

  it("**没有原始请求时给红字提示**", () => {
    const { result } = render();
    assert.ok(result.text.includes(MISSING_REQUESTS_MESSAGE));
  });

  it("复制单个请求传对应文本", () => {
    const copied: string[] = [];
    const { result } = render({
      data: data({
        stages: [stage({
          items: [item({
            requests: [{
              request: "POST /a HTTP/1.1", response: "", method: "POST", status: 201, url: "", source: "",
            }],
          })],
        })],
      }),
      onCopy: (text) => copied.push(text),
    });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制到 Yakit");
    fire(button!, "onClick");
    assert.equal(copied[0], "POST /a HTTP/1.1");
  });
});

describe("renderReportTab — 空态与错误态", () => {
  it("**data 为 null 时显示「加载中…」**", () => {
    assert.ok(render({ data: null }).result.text.includes(LOADING_REPORT_MESSAGE));
  });

  it("**data 为 null 时工具栏仍渲染**（不整页空白）", () => {
    const { result } = render({ data: null });
    assert.match(result.text, /攻击得分链路复现报告/);
    assert.match(result.text, /重新生成/);
  });

  it("读到但没有阶段时显示「还没有可交付的成果」", () => {
    const { result } = render({ data: data({ stages: [], items: [] }) });
    assert.ok(result.text.includes(EMPTY_REPORT_TITLE));
    assert.ok(result.text.includes(EMPTY_REPORT_HINT));
  });

  it("**空态与加载中不是同一句话**", () => {
    const empty = render({ data: data({ stages: [], items: [] }) }).result.text;
    const loading = render({ data: null }).result.text;
    assert.notEqual(empty.includes(LOADING_REPORT_MESSAGE), true);
    assert.notEqual(loading.includes(EMPTY_REPORT_TITLE), true);
  });

  it("读失败时显示 rt-err", () => {
    const { result } = render({ data: null, error: "库损坏" });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
    assert.match(result.text, /库损坏/);
  });

  it("**读失败时仍渲染工具栏与底部说明**", () => {
    const { result } = render({ data: null, error: "库损坏" });
    assert.match(result.text, /复制全文/);
    assert.ok(result.text.includes(REPORT_FOOTER));
  });

  it("成功消息渲染成 rt-foot", () => {
    const { result } = render({ message: { kind: "ok", text: "已下载：eng" } });
    const node = findOne(result, (element) => classOf(element) === "rt-foot" && textOf(element) === "已下载：eng");
    assert.notEqual(node, null);
  });

  it("失败消息渲染成 rt-err", () => {
    const { result } = render({ message: { kind: "err", text: COPY_FAILED_MESSAGE } });
    const node = findOne(result, (element) => classOf(element) === "rt-err" && textOf(element) === COPY_FAILED_MESSAGE);
    assert.notEqual(node, null);
  });

  it("**错误与消息同时存在时都渲染**", () => {
    const { result } = render({ error: "生成失败", message: { kind: "err", text: "复制失败" } });
    assert.match(result.text, /生成失败/);
    assert.match(result.text, /复制失败/);
  });
});
