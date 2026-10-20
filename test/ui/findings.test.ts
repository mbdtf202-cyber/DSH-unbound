/**
 * 漏洞战果页的模型 + 渲染测试。
 *
 * 重点是**四条容易错的行为**：
 * - `targetKeyOf` 必须砍掉 URL 路径（否则同一台机器拆成多组）
 * - 聚合排序是复合的（最高严重级 → 条数降序）
 * - 「拿到什么」的分割（顿号/逗号/分号混用）
 * - 证据缺失的红线（未验证/无证据的漏洞不进报告）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  DEFAULT_FINDINGS_FILTER,
  loadFindings,
  loadSideLists,
  renderFindingsTab,
  updateVulnStatus,
  vulnLacksEvidence,
  evidenceCopyable,
  isSeverity,
  type FindingsFilter,
  type FindingsTabProps,
} from "../../src/redteam/client/findings-tab.js";
import {
  EMPTY_ACCESS_MESSAGE,
  EMPTY_CREDENTIALS_MESSAGE,
  EMPTY_FINDINGS_MESSAGE,
  FINDINGS_LIMIT,
  MISSING_ATTACK_FILE_MESSAGE,
  MISSING_EVIDENCE_MESSAGE,
  MISSING_GAINED_MESSAGE,
  RESTART_HINT,
  SEVERITY_OPTIONS,
  STATUS_ACTIONS,
  STATUS_OPTIONS,
  accessHeading,
  accessesOf,
  attackFileGroupsOf,
  attackFilesHint,
  conclusionClass,
  conclusionItems,
  conclusionLabel,
  confidenceLabel,
  countOrZero,
  credentialMeta,
  credentialsHeading,
  credentialsOf,
  evidenceHeadLabel,
  evidenceMissing,
  findingsOf,
  gainedListOf,
  gainedSummary,
  groupByTarget,
  groupCountLabel,
  groupGainedLabel,
  groupSubtitle,
  httpBlockClass,
  httpLineClass,
  httpLineKind,
  httpLinesOf,
  indexFilesByVuln,
  looksLikeHttp,
  needsRestart,
  severityClass,
  severityLabel,
  statusLabel,
  statusUpdatedMessage,
  statusUpdatedMessage as _statusUpdatedMessage,
  subTabAriaLabel,
  subTabClass,
  subTabLabel,
  targetKeyOf,
  targetSummary,
  vulnAssetLine,
  vulnOf,
  vulnSourceLine,
  vulnStatusOf,
  vulnTarget,
  vulnTitle,
  type AccessRow,
  type AttackFileGroup,
  type CredentialRow,
  type FindingsList,
  type VulnItem,
} from "../../src/redteam/client/findings-model.js";
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

/** 造一条漏洞。 */
function vuln(overrides: Partial<VulnItem> = {}): VulnItem {
  return {
    id: 1,
    title: "未授权访问",
    severity: "high",
    status: "confirmed",
    cve: "CVE-2024-1",
    target: "https://a.example.com/x?id=1",
    assetIp: "10.0.0.5",
    segmentCidr: "10.0.0.0/24",
    gained: "",
    gainedList: [],
    source: "nuclei",
    foundByAgent: "vuln-scan",
    foundAt: "2026-01-02T03:04:05Z",
    confidence: 0.92,
    evidence: "",
    httpEvidence: [],
    ...overrides,
  };
}

/** 造查询结果。 */
function findings(overrides: Partial<FindingsList> = {}): FindingsList {
  const items = overrides.items ?? [vuln()];
  return {
    total: overrides.total ?? items.length,
    items,
    stats: overrides.stats ?? {
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      byStatus: { candidate: 0, confirmed: 1, exploited: 0, "false-positive": 0, fixed: 0 },
      withGained: 0,
      targetGroups: 1,
    },
    error: overrides.error ?? null,
    loading: overrides.loading ?? false,
  };
}

/** 默认 props。 */
function props(overrides: Partial<FindingsTabProps> = {}): FindingsTabProps {
  return {
    findings: findings(),
    credentials: [],
    accesses: [],
    fileGroups: [],
    filter: DEFAULT_FINDINGS_FILTER,
    subTab: "vulns",
    grouped: false,
    openId: null,
    collapse: {},
    message: null,
    onFilterChange: () => undefined,
    onSubmitQuery: () => undefined,
    onSubTabChange: () => undefined,
    onToggleGrouped: () => undefined,
    onToggleOpen: () => undefined,
    onCollapseChange: () => undefined,
    onSetAllCollapsed: () => undefined,
    onUpdateStatus: () => undefined,
    onCopy: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<FindingsTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderFindingsTab(runtime, props(overrides))) };
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

describe("findings-model — 严重级与状态", () => {
  it("严重级归一：五个合法值", () => {
    assert.equal(severityLabel("critical"), "严重");
    assert.equal(severityLabel("high"), "高危");
    assert.equal(severityLabel("medium"), "中危");
    assert.equal(severityLabel("low"), "低危");
    assert.equal(severityLabel("info"), "信息");
  });

  it("**未知严重级原样显示**（暴露上游新值，而不是一片「未知」）", () => {
    assert.equal(severityLabel("catastrophic"), "catastrophic");
  });

  it("**空严重级原样返回空串**（保留上游 `SEV_LABEL[s] || s` 语义）", () => {
    assert.equal(severityLabel(""), "");
    assert.equal(severityLabel(null), "");
  });

  it("状态归一", () => {
    assert.equal(statusLabel("candidate"), "待验证");
    assert.equal(statusLabel("confirmed"), "已确认");
    assert.equal(statusLabel("false-positive"), "误报");
    assert.equal(statusLabel("exploited"), "已利用");
    assert.equal(statusLabel("fixed"), "已修复");
  });

  it("未知状态原样显示", () => {
    assert.equal(statusLabel("wontfix"), "wontfix");
  });

  it("severityClass 给五个类名", () => {
    assert.equal(severityClass("critical"), "rt-sev rt-sev-critical");
    assert.equal(severityClass("low"), "rt-sev rt-sev-low");
  });

  it("**未知严重级的 className 兜底成 info**（否则没有任何颜色）", () => {
    assert.equal(severityClass("weird"), "rt-sev rt-sev-info");
  });

  it("vulnStatusOf 未知 → candidate（最保守的解读）", () => {
    assert.equal(vulnStatusOf("weird"), "candidate");
    assert.equal(vulnStatusOf("exploited"), "exploited");
  });

  it("下拉选项的顺序与文案", () => {
    assert.equal(SEVERITY_OPTIONS[0]?.value, "");
    assert.equal(SEVERITY_OPTIONS[0]?.label, "全部等级");
    assert.equal(STATUS_OPTIONS.length, 6);
  });

  it("置信度显示（null → —，其余百分比取整）", () => {
    assert.equal(confidenceLabel(null), "—");
    assert.equal(confidenceLabel(0.92), "92%");
    assert.equal(confidenceLabel(1), "100%");
  });

  it("**置信度 0 显示 0% 而不是 —**（0 是有效值）", () => {
    assert.equal(confidenceLabel(0), "0%");
  });

  it("countOrZero 兜底", () => {
    assert.equal(countOrZero("3"), 3);
    assert.equal(countOrZero(-1), 0);
    assert.equal(countOrZero("abc"), 0);
    assert.equal(countOrZero(null), 0);
  });
});

describe("findings-model — 拿到什么", () => {
  it("按中文顿号拆分", () => {
    assert.deepEqual(gainedListOf("服务器权限、内网隧道"), ["服务器权限", "内网隧道"]);
  });

  it("按半角/全角逗号与分号拆分", () => {
    assert.deepEqual(gainedListOf("a,b;c，d；e"), ["a", "b", "c", "d", "e"]);
  });

  it("去空项与首尾空白", () => {
    assert.deepEqual(gainedListOf(" a 、 、 b "), ["a", "b"]);
  });

  it("空值 → 空数组", () => {
    assert.deepEqual(gainedListOf(""), []);
    assert.deepEqual(gainedListOf(null), []);
  });

  it("gainedSummary 只有一项时原样", () => {
    assert.equal(gainedSummary(["服务器权限"]), "服务器权限");
  });

  it("gainedSummary 多余项收成 +N", () => {
    assert.equal(gainedSummary(["a", "b", "c"]), "a +2");
  });

  it("gainedSummary 空数组 → 空串（由调用方决定显示 —）", () => {
    assert.equal(gainedSummary([]), "");
  });
});

describe("findings-model — 目标归并", () => {
  it("**带路径的 URL 砍掉路径**（否则同一台机器拆成多组）", () => {
    assert.equal(
      targetKeyOf({ target: "https://a.example.com/x?id=1" }),
      "https://a.example.com",
    );
  });

  it("保留端口", () => {
    assert.equal(
      targetKeyOf({ target: "https://a.example.com:8443/x" }),
      "https://a.example.com:8443",
    );
  });

  it("裸 host:port 也砍掉路径", () => {
    assert.equal(targetKeyOf({ target: "10.0.0.5:8080/admin" }), "10.0.0.5:8080");
  });

  it("裸 host 原样", () => {
    assert.equal(targetKeyOf({ target: "10.0.0.5" }), "10.0.0.5");
  });

  it("target 为空时用 asset_ip", () => {
    assert.equal(targetKeyOf({ target: "", asset_ip: "10.0.0.9" }), "10.0.0.9");
  });

  it("**两者都为空时给哨兵值**", () => {
    assert.equal(targetKeyOf({}), "(未指定目标)");
  });

  it("target 只有空白时退回 asset_ip", () => {
    assert.equal(targetKeyOf({ target: "   ", asset_ip: "1.1.1.1" }), "1.1.1.1");
  });
});

describe("findings-model — 解析与聚合", () => {
  it("vulnOf 解析完整字段", () => {
    const parsed = vulnOf({
      id: 7,
      title: "T",
      severity: "critical",
      status: "exploited",
      cve: "CVE-1",
      target: "http://x/",
      asset_ip: "10.0.0.1",
      segment_cidr: "10.0.0.0/24",
      gained: "服务器权限、隧道",
      source: "nuclei",
      found_by_agent: "exploit",
      found_at: "2026-01-01T00:00:00Z",
      confidence: 0.5,
      evidence: "evi",
      http_evidence: [{ id: 1, method: "GET", status: 200, request: "GET / HTTP/1.1" }],
    });
    assert.equal(parsed?.id, 7);
    assert.equal(parsed?.severity, "critical");
    assert.deepEqual(parsed?.gainedList, ["服务器权限", "隧道"]);
    assert.equal(parsed?.httpEvidence.length, 1);
  });

  it("vulnOf 丢没有 id 的行", () => {
    assert.equal(vulnOf({ title: "没有 id" }), null);
    assert.equal(vulnOf("string"), null);
  });

  it("vulnOf 缺 confidence 时给 null", () => {
    assert.equal(vulnOf({ id: 1 })?.confidence, null);
  });

  it("findingsOf 解析列表与统计", () => {
    const list = findingsOf({
      ok: true,
      total: 2,
      items: [{ id: 1 }, { id: 2 }],
      stats: { bySeverity: { high: 2 }, byStatus: { confirmed: 1 }, withGained: 1, targetGroups: 1 },
    });
    assert.equal(list.total, 2);
    assert.equal(list.items.length, 2);
    assert.equal(list.stats.bySeverity["high"], 2);
    assert.equal(list.stats.withGained, 1);
  });

  it("findingsOf 失败时给错误文案与空表", () => {
    const list = findingsOf({ ok: false, error: "查询失败" });
    assert.equal(list.error, "查询失败");
    assert.deepEqual(list.items, []);
    assert.equal(list.stats.targetGroups, 0);
  });

  it("**findingsOf 在 stats 缺失时给空统计**（结论行仍渲染一排 0）", () => {
    const list = findingsOf({ ok: true, items: [] });
    assert.deepEqual(list.stats.bySeverity, {});
    assert.equal(list.stats.withGained, 0);
  });

  it("按目标聚合并按最高严重级排序", () => {
    const groups = groupByTarget([
      vuln({ id: 1, target: "http://a/", severity: "low" }),
      vuln({ id: 2, target: "http://b/", severity: "critical" }),
    ]);
    assert.equal(groups[0]?.key, "http://b");
    assert.equal(groups[1]?.key, "http://a");
  });

  it("**同一严重级按条数降序**（哪台被打得最狠排前面）", () => {
    const groups = groupByTarget([
      vuln({ id: 1, target: "http://few/", severity: "high" }),
      vuln({ id: 2, target: "http://many/", severity: "high" }),
      vuln({ id: 3, target: "http://many/", severity: "high" }),
    ]);
    assert.equal(groups[0]?.key, "http://many");
    assert.equal(groups[0]?.vulns.length, 2);
  });

  it("同一目标的「拿到什么」去重合并且保持出现顺序", () => {
    const groups = groupByTarget([
      vuln({ id: 1, target: "http://a/", gained: "隧道、服务器权限", gainedList: ["隧道", "服务器权限"] }),
      vuln({ id: 2, target: "http://a/", gained: "服务器权限", gainedList: ["服务器权限"] }),
    ]);
    assert.deepEqual(groups[0]?.gained, ["隧道", "服务器权限"]);
  });

  it("聚合统计已利用条数", () => {
    const groups = groupByTarget([
      vuln({ id: 1, target: "http://a/", status: "exploited" }),
      vuln({ id: 2, target: "http://a/", status: "confirmed" }),
    ]);
    assert.equal(groups[0]?.exploited, 1);
  });

  it("空输入 → 空分组", () => {
    assert.deepEqual(groupByTarget([]), []);
  });

  it("聚合组的文案", () => {
    const groups = groupByTarget([vuln({ id: 1, status: "exploited" })]);
    const group = groups[0]!;
    assert.match(groupSubtitle(group), /高危/);
    assert.match(groupSubtitle(group), /已利用 1/);
    assert.equal(groupCountLabel(group), "1 个漏洞");
    assert.equal(groupGainedLabel(group), "未记录权限");
  });

  it("聚合组有多项权限时只显示前两项 +N", () => {
    const groups = groupByTarget([
      vuln({ id: 1, gainedList: ["a", "b", "c"] }),
    ]);
    assert.equal(groupGainedLabel(groups[0]!), "a / b +1");
  });
});

describe("findings-model — 结论行", () => {
  it("六项的计数来自统计", () => {
    const items = conclusionItems(
      {
        bySeverity: { critical: 2, high: 3, medium: 4 },
        byStatus: { confirmed: 5, exploited: 1 },
        withGained: 6,
        targetGroups: 2,
      },
      "",
      "",
    );
    assert.deepEqual(items.map((item) => item.code), ["confirmed", "exploited", "critical", "high", "medium", "gained"]);
    assert.equal(items[0]?.count, 5);
    assert.equal(items[5]?.count, 6);
  });

  it("**点已选中的项取消筛选**（next 变空串）", () => {
    const items = conclusionItems(
      { bySeverity: {}, byStatus: {}, withGained: 0, targetGroups: 0 },
      "critical",
      "confirmed",
    );
    const critical = items.find((item) => item.code === "critical");
    assert.equal(critical?.next, "");
    assert.equal(critical?.active, true);
  });

  it("点未选中的项设上筛选", () => {
    const items = conclusionItems(
      { bySeverity: {}, byStatus: {}, withGained: 0, targetGroups: 0 },
      "",
      "",
    );
    assert.equal(items.find((item) => item.code === "high")?.next, "high");
  });

  it("**「拿到权限」永远不可选**（后端没有对应筛选参数）", () => {
    const items = conclusionItems(
      { bySeverity: {}, byStatus: {}, withGained: 3, targetGroups: 0 },
      "",
      "",
    );
    const gained = items.find((item) => item.code === "gained");
    assert.equal(gained?.active, false);
    assert.equal(gained?.next, "");
  });

  it("缺失的统计键给 0（不是 undefined）", () => {
    const items = conclusionItems(
      { bySeverity: {}, byStatus: {}, withGained: 0, targetGroups: 0 },
      "",
      "",
    );
    assert.ok(items.every((item) => typeof item.count === "number"));
    assert.equal(items[0]?.count, 0);
  });

  it("aria-label 说明点击行为与数量", () => {
    const items = conclusionItems(
      { bySeverity: { high: 7 }, byStatus: {}, withGained: 0, targetGroups: 0 },
      "",
      "",
    );
    assert.equal(conclusionLabel(items[3]!), "按「高危」筛选（7）");
  });

  it("选中项的 className 带 on", () => {
    const items = conclusionItems(
      { bySeverity: {}, byStatus: {}, withGained: 0, targetGroups: 0 },
      "high",
      "",
    );
    assert.equal(conclusionClass(items[3]!), "rt-concl-i on");
    assert.equal(conclusionClass(items[0]!), "rt-concl-i");
  });

  it("目标数说明", () => {
    assert.equal(
      targetSummary({ bySeverity: {}, byStatus: {}, withGained: 0, targetGroups: 4 }),
      "默认按目标聚合 · 共 4 个目标",
    );
  });
});

describe("findings-model — 攻击文件关联", () => {
  it("按 vuln_id 归堆并挑出孤儿", () => {
    const groups: AttackFileGroup[] = [{
      target: "10.0.0.5",
      files: [
        { id: 1, name: "a", kind: "poc", description: "", path: "/p", vulnId: 3, target: "10.0.0.5" },
        { id: 2, name: "b", kind: "exp", description: "", path: "/p", vulnId: null, target: "10.0.0.5" },
      ],
    }];
    const index = indexFilesByVuln(groups);
    assert.equal(index.all.length, 2);
    assert.equal(index.byVuln.get(3)?.length, 1);
    assert.equal(index.orphans.length, 1);
  });

  it("多个文件挂同一漏洞时都归到一起", () => {
    const groups: AttackFileGroup[] = [{
      target: "t",
      files: [
        { id: 1, name: "a", kind: "", description: "", path: "", vulnId: 9, target: "t" },
        { id: 2, name: "b", kind: "", description: "", path: "", vulnId: 9, target: "t" },
      ],
    }];
    assert.equal(indexFilesByVuln(groups).byVuln.get(9)?.length, 2);
  });

  it("空分组 → 空索引", () => {
    const index = indexFilesByVuln([]);
    assert.equal(index.all.length, 0);
    assert.equal(index.orphans.length, 0);
    assert.equal(index.byVuln.size, 0);
  });

  it("attackFileGroupsOf 解析分组并带上 target", () => {
    const groups = attackFileGroupsOf({
      ok: true,
      items: [{ target: "10.0.0.5", files: [{ id: 1, name: "x", vuln_id: 2 }] }],
    });
    assert.equal(groups[0]?.target, "10.0.0.5");
    assert.equal(groups[0]?.files[0]?.vulnId, 2);
  });

  it("失败响应 → 空分组（不抛）", () => {
    assert.deepEqual(attackFileGroupsOf({ ok: false }), []);
  });

  it("孤儿文件提醒只在有孤儿时出现", () => {
    assert.doesNotMatch(attackFilesHint(0), /没挂 vuln_id/);
    assert.match(attackFilesHint(2), /2 个文件没挂 vuln_id/);
  });
});

describe("findings-model — 证据与 HTTP 着色", () => {
  it("认请求行", () => {
    assert.equal(looksLikeHttp("GET /x HTTP/1.1\nHost: a"), true);
  });

  it("认状态行", () => {
    assert.equal(looksLikeHttp("HTTP/1.1 200 OK"), true);
  });

  it("认「换行 + 头字段」形态", () => {
    assert.equal(looksLikeHttp("随便一句\nContent-Type: text/html"), true);
  });

  it("纯文本不当报文", () => {
    assert.equal(looksLikeHttp("uid=0(root) gid=0(root)"), false);
  });

  it("空文本不当报文", () => {
    assert.equal(looksLikeHttp("   "), false);
  });

  it("第 0 行方法名 → 请求行高亮", () => {
    assert.equal(httpLineKind("GET / HTTP/1.1", 0), "req");
    assert.equal(httpLineClass("req"), "rt-hl-req");
  });

  it("**非第 0 行的方法名不高亮**（正文里出现 GET 不该着色）", () => {
    assert.equal(httpLineKind("GET / HTTP/1.1", 3), null);
  });

  it("第 0 行 HTTP/ → 状态行高亮", () => {
    assert.equal(httpLineKind("HTTP/1.1 200 OK", 0), "res");
    assert.equal(httpLineClass("res"), "rt-hl-res");
  });

  it("关键请求头高亮", () => {
    assert.equal(httpLineKind("Host: a", 2), "header");
    assert.equal(httpLineKind("Cookie: a=b", 5), "header");
    assert.equal(httpLineKind("Authorization: Bearer x", 3), "header");
    assert.equal(httpLineKind("Content-Type: text/html", 4), "header");
  });

  it("普通头不高亮", () => {
    assert.equal(httpLineKind("Accept: */*", 2), null);
  });

  it("不分大小写识别头名", () => {
    assert.equal(httpLineKind("HOST: a", 2), "header");
  });

  it("httpBlockClass 紧凑模式加 req", () => {
    assert.equal(httpBlockClass(true), "rt-evi-body req");
    assert.equal(httpBlockClass(false), "rt-evi-body");
  });

  it("空行渲染成不换行空格（否则高度塌成 0）", () => {
    const lines = httpLinesOf("a\n\nb");
    assert.equal(lines.length, 3);
    assert.equal(lines[1], "\u00a0");
  });

  it("空文本给空行表", () => {
    assert.deepEqual(httpLinesOf(""), []);
  });

  it("CRLF 也能切行", () => {
    assert.deepEqual(httpLinesOf("a\r\nb"), ["a", "b"]);
  });

  it("证据头的标签", () => {
    assert.equal(
      evidenceHeadLabel({ id: 1, label: "", method: "GET", status: 200, request: "", response: "", note: "", capturedAt: "" }),
      "GET 200",
    );
  });

  it("**状态码 null 时标签不出现 undefined**", () => {
    assert.equal(
      evidenceHeadLabel({ id: 1, label: "", method: "POST", status: null, request: "", response: "", note: "", capturedAt: "" }),
      "POST ",
    );
  });

  it("证据缺失判定（文本与结构化都空 → 缺）", () => {
    assert.equal(evidenceMissing(vuln({ evidence: "", httpEvidence: [] })), true);
    assert.equal(evidenceMissing(vuln({ evidence: "有", httpEvidence: [] })), false);
  });

  it("只有空白文本也算缺失", () => {
    assert.equal(evidenceMissing(vuln({ evidence: "   " })), true);
  });

  it("证据的可复制性", () => {
    assert.equal(
      evidenceCopyable({ id: 1, label: "", method: "", status: null, request: "", response: "", note: "", capturedAt: "" }),
      false,
    );
  });
});

describe("findings-model — 凭据与访问会话", () => {
  it("解析凭据（含明文）", () => {
    const list = credentialsOf({ ok: true, items: [{ id: 1, host: "h", username: "u", secret_value: "p", secret_type: "password" }] });
    assert.equal(list[0]?.secretValue, "p");
  });

  it("失败响应 → 空数组", () => {
    assert.deepEqual(credentialsOf({ ok: false }), []);
  });

  it("凭据区标题在有内容时提示明文风险", () => {
    assert.match(credentialsHeading(2), /明文直显/);
    assert.equal(credentialsHeading(0), "凭据 · 0");
  });

  it("凭据元信息行拼接", () => {
    const line = credentialMeta({
      id: 1, host: "h", username: "u", secretType: "password", secretValue: "p",
      privilege: "admin", source: "dump", tool: "hashcat", secretRef: "runs/x", foundByAgent: "exploit",
      foundAt: "2026-01-01T00:00:00Z", note: "",
    });
    assert.match(line, /来源 dump/);
    assert.match(line, /工具 hashcat/);
    assert.match(line, /证据 runs\/x/);
  });

  it("解析访问会话", () => {
    const list = accessesOf({ ok: true, items: [{ id: 1, host: "h", method: "rdp" }] });
    assert.equal(list[0]?.method, "rdp");
  });

  it("访问会话失败 → 空数组", () => {
    assert.deepEqual(accessesOf({ ok: false }), []);
  });

  it("访问会话标题", () => {
    assert.equal(accessHeading(3), "已获得访问会话 · 3");
  });
});

describe("findings-model — 状态操作与子页签", () => {
  it("四个状态按钮的顺序", () => {
    assert.deepEqual(STATUS_ACTIONS.map((action) => action.status), [
      "confirmed", "exploited", "false-positive", "fixed",
    ]);
  });

  it("状态更新成功的文案用中文名", () => {
    assert.equal(statusUpdatedMessage("exploited"), "已更新为「已利用」");
  });

  it("子页签文案与 aria-label", () => {
    assert.equal(subTabLabel("漏洞", 3), "漏洞 3");
    assert.equal(subTabAriaLabel("漏洞", 3), "漏洞（3）");
  });

  it("子页签 className 选中加 on", () => {
    assert.equal(subTabClass("vulns", "vulns"), "rt-subtab on");
    assert.equal(subTabClass("creds", "vulns"), "rt-subtab");
  });

  it("**unknown op 给重启建议**", () => {
    assert.equal(needsRestart("unknown op: vulns"), true);
    assert.equal(needsRestart("磁盘错误"), false);
    assert.equal(needsRestart(null), false);
  });

  it("漏洞标题与目标显示", () => {
    assert.equal(vulnTitle(vuln()), "CVE-2024-1 未授权访问");
    assert.equal(vulnTitle(vuln({ cve: "" })), "未授权访问");
    assert.equal(vulnTarget(vuln({ target: "" })), "10.0.0.5");
    assert.equal(vulnTarget(vuln({ target: "", assetIp: "" })), "—");
  });

  it("资产行与来源行", () => {
    assert.equal(vulnAssetLine(vuln()), "10.0.0.5 · 10.0.0.0/24");
    assert.match(vulnSourceLine(vuln()), /nuclei · vuln-scan · 2026-01-02 03:04/);
  });

  it("isSeverity 只认五个值", () => {
    assert.equal(isSeverity("high"), true);
    assert.equal(isSeverity("weird"), false);
  });
});

describe("findings-tab — 流程", () => {
  it("查询带过滤条件", async () => {
    const { api, requests } = fakeApi([{ ok: true, items: [] }]);
    await loadFindings(api as never, "eng-1", { ...DEFAULT_FINDINGS_FILTER, severity: "high", queryApplied: "ssti" });
    assert.equal(requests[0]?.["severity"], "high");
    assert.equal(requests[0]?.["q"], "ssti");
    assert.equal(requests[0]?.["limit"], FINDINGS_LIMIT);
  });

  it("**空过滤条件不下发**（避免后端把空串当筛选值）", async () => {
    const { api, requests } = fakeApi([{ ok: true, items: [] }]);
    await loadFindings(api as never, "eng-1", DEFAULT_FINDINGS_FILTER);
    assert.equal(Object.hasOwn(requests[0] ?? {}, "severity"), false);
    assert.equal(Object.hasOwn(requests[0] ?? {}, "status"), false);
    assert.equal(Object.hasOwn(requests[0] ?? {}, "q"), false);
  });

  it("侧列表并行拉三个请求", async () => {
    const { api, requests } = fakeApi([
      { ok: true, items: [{ id: 1, host: "h" }] },
      { ok: true, items: [{ id: 2, host: "h2", method: "rdp" }] },
      { ok: true, items: [{ target: "t", files: [] }] },
    ]);
    const result = await loadSideLists(api as never, "eng-1");
    assert.equal(requests.length, 3);
    assert.equal(result.credentials.length, 1);
    assert.equal(result.accesses.length, 1);
    assert.equal(result.fileGroups.length, 1);
  });

  it("**侧列表的某个请求失败不影响其它两个**", async () => {
    const { api } = fakeApi([
      { ok: false, error: "x" },
      { ok: true, items: [{ id: 2, host: "h2" }] },
      { ok: true, items: [] },
    ]);
    const result = await loadSideLists(api as never, "eng-1");
    assert.deepEqual(result.credentials, []);
    assert.equal(result.accesses.length, 1);
  });

  it("更新状态成功", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    const result = await updateVulnStatus(api as never, "eng-1", 5, "exploited");
    assert.equal(requests[0]?.["op"], "updateVuln");
    assert.deepEqual(requests[0]?.["patch"], { status: "exploited" });
    assert.equal(result.message.kind, "ok");
  });

  it("更新状态失败透传文案", async () => {
    const { api } = fakeApi([{ ok: false, error: "没有这条漏洞" }]);
    const result = await updateVulnStatus(api as never, "eng-1", 5, "exploited");
    assert.equal(result.message.kind, "err");
    assert.equal(result.message.text, "没有这条漏洞");
  });

  it("vulnLacksEvidence 复用模型判定", () => {
    assert.equal(vulnLacksEvidence(vuln()), true);
    assert.equal(vulnLacksEvidence(vuln({ evidence: "x" })), false);
  });
});

describe("renderFindingsTab — 工具栏与结论行", () => {
  it("渲染搜索框与两个下拉", () => {
    const { result } = render();
    assert.equal(findAll(result, "input").length >= 1, true);
    assert.equal(findAll(result, "select").length, 2);
  });

  it("搜索框预填未提交的值", () => {
    const filter: FindingsFilter = { ...DEFAULT_FINDINGS_FILTER, query: "abc" };
    assert.equal(findOne(render({ filter }).result, "input")?.props["value"], "abc");
  });

  it("改搜索框只改本地状态（不提交）", () => {
    const changes: FindingsFilter[] = [];
    let submitted = 0;
    const { result } = render({
      onFilterChange: (filter) => changes.push(filter),
      onSubmitQuery: () => { submitted += 1; },
    });
    fire(findAll(result, "input")[0]!, "onChange", { target: { value: "ssti" } });
    assert.equal(changes[0]?.query, "ssti");
    assert.equal(submitted, 0);
  });

  it("**回车才提交搜索**", () => {
    let submitted = 0;
    const { result } = render({ onSubmitQuery: () => { submitted += 1; } });
    fire(findAll(result, "input")[0]!, "onKeyDown", { key: "Enter" });
    assert.equal(submitted, 1);
  });

  it("点「搜索」提交", () => {
    let submitted = 0;
    const { result } = render({ onSubmitQuery: () => { submitted += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "搜索");
    fire(button!, "onClick");
    assert.equal(submitted, 1);
  });

  it("结论行渲染六项", () => {
    const { result } = render({
      findings: findings({
        stats: {
          bySeverity: { critical: 1, high: 2, medium: 3 },
          byStatus: { confirmed: 4, exploited: 5 },
          withGained: 6,
          targetGroups: 2,
        },
      }),
    });
    const chips = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    assert.equal(chips.length, 6);
    assert.match(result.text, /已确认/);
    assert.match(result.text, /拿到权限/);
  });

  it("**结论行的 0 值渲染成 0 而不是消失**", () => {
    const { result } = render();
    const chips = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    // 数字在 <b> 里：0 必须真的渲染出来，而不是被 `&&` 吞成空。
    assert.ok(chips.some((element) => textOf(element).includes("<b>0</b>")));
  });

  it("点结论项设置筛选", () => {
    const changes: FindingsFilter[] = [];
    const { result } = render({ onFilterChange: (filter) => changes.push(filter) });
    const chips = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    fire(chips[2]!, "onClick");
    assert.equal(changes[0]?.severity, "critical");
  });

  it("点已选中的结论项取消筛选", () => {
    const changes: FindingsFilter[] = [];
    const { result } = render({
      filter: { ...DEFAULT_FINDINGS_FILTER, severity: "critical" },
      onFilterChange: (filter) => changes.push(filter),
    });
    const chips = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    fire(chips[2]!, "onClick");
    assert.equal(changes[0]?.severity, "");
  });

  it("**点「拿到权限」不触发筛选**（后端没有这个参数）", () => {
    const changes: FindingsFilter[] = [];
    const { result } = render({ onFilterChange: (filter) => changes.push(filter) });
    const chips = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    fire(chips[5]!, "onClick");
    assert.equal(changes.length, 0);
  });
});

describe("renderFindingsTab — 子页签", () => {
  it("渲染四个子页签与计数", () => {
    const { result } = render({
      findings: findings({ total: 3 }),
      credentials: [{ id: 1, host: "h", username: "", secretType: "", secretValue: "", privilege: "", source: "", tool: "", secretRef: "", foundByAgent: "", foundAt: "", note: "" }],
      accesses: [],
      fileGroups: [{ target: "t", files: [{ id: 1, name: "a", kind: "poc", description: "", path: "", vulnId: 1, target: "t" }] }],
    });
    assert.match(result.text, /漏洞 3/);
    assert.match(result.text, /攻击文件 1/);
    assert.match(result.text, /凭据 1/);
    assert.match(result.text, /访问会话 0/);
  });

  it("点子页签切换", () => {
    const tabs: string[] = [];
    const { result } = render({ onSubTabChange: (tab) => tabs.push(tab) });
    // `rt-subtabs` 容器也以 `rt-subtab` 开头 —— 用精确匹配排除它。
    const subtabs = findAll(result, (element) => {
      const value = classOf(element);
      return value === "rt-subtab" || value === "rt-subtab on";
    });
    fire(subtabs[2]!, "onClick");
    assert.deepEqual(tabs, ["creds"]);
  });

  it("凭据子页签显示明文与空态", () => {
    const empty = render({ subTab: "creds" });
    assert.match(empty.result.text, /暂无凭据/);

    const filled = render({
      subTab: "creds",
      credentials: [{
        id: 1, host: "10.0.0.5", username: "root", secretType: "password", secretValue: "toor",
        privilege: "admin", source: "dump", tool: "", secretRef: "", foundByAgent: "", foundAt: "", note: "备注",
      }],
    });
    assert.match(filled.result.text, /toor/);
    assert.match(filled.result.text, /root/);
  });

  it("凭据缺明文时给出补录提示", () => {
    const { result } = render({
      subTab: "creds",
      credentials: [{
        id: 1, host: "h", username: "", secretType: "", secretValue: "", privilege: "",
        source: "", tool: "", secretRef: "", foundByAgent: "", foundAt: "", note: "",
      }],
    });
    assert.match(result.text, /未记明文/);
  });

  it("访问会话子页签的空态与内容", () => {
    assert.match(render({ subTab: "access" }).result.text, new RegExp(EMPTY_ACCESS_MESSAGE));

    const filled = render({
      subTab: "access",
      accesses: [{ id: 1, host: "10.0.0.5", username: "admin", method: "rdp", privilege: "admin", sessionRef: "runs/x" }],
    });
    assert.match(filled.result.text, /rdp/);
    assert.match(filled.result.text, /admin/);
  });

  it("攻击文件子页签渲染说明与注入的内容", () => {
    const { result } = render({
      subTab: "files",
      fileGroups: [{ target: "t", files: [{ id: 1, name: "a", kind: "poc", description: "", path: "", vulnId: null, target: "t" }] }],
      attackFilesNode: "注入的攻击文件节点",
    });
    assert.match(result.text, /按靶标目录组织/);
    assert.match(result.text, /1 个文件没挂 vuln_id/);
    assert.match(result.text, /注入的攻击文件节点/);
  });

  it("**攻击文件子页签没有注入内容时也不空白**（说明行仍在）", () => {
    const { result } = render({ subTab: "files" });
    assert.match(result.text, /按靶标目录组织/);
  });
});

describe("renderFindingsTab — 聚合/平铺与展开", () => {
  it("聚合视图渲染分组标题与计数", () => {
    const { result } = render({
      grouped: true,
      findings: findings({
        items: [vuln({ id: 1, target: "http://a/" }), vuln({ id: 2, target: "http://b/" })],
      }),
    });
    assert.match(result.text, /http:\/\/a/);
    assert.match(result.text, /http:\/\/b/);
    assert.match(result.text, /1 个漏洞/);
  });

  it("**聚合视图的组默认折叠**（不把 200 条全摊开）", () => {
    const { result } = render({ grouped: true });
    // 折叠时漏洞标题不应出现在正文里。
    assert.doesNotMatch(result.text, /未授权访问/);
  });

  it("聚合视图展开后渲染漏洞行", () => {
    const { result } = render({
      grouped: true,
      collapse: { "target:https://a.example.com": true },
    });
    assert.match(result.text, /CVE-2024-1/);
  });

  it("点分组头切换折叠", () => {
    const states: unknown[] = [];
    const { result } = render({ grouped: true, onCollapseChange: (state) => states.push(state) });
    const head = findOne(result, (element) => classOf(element) === "rt-sec t-target");
    fire(head!, "onClick");
    assert.equal(states.length, 1);
  });

  it("平铺视图渲染表头与漏洞行", () => {
    const { result } = render({ grouped: false });
    assert.match(result.text, /等级/);
    assert.match(result.text, /置信/);
    assert.match(result.text, /CVE-2024-1/);
  });

  it("**平铺视图不渲染「全部展开/收起」**（聚合才有意义）", () => {
    const { result } = render({ grouped: false });
    assert.doesNotMatch(result.text, /全部展开/);
  });

  it("聚合视图渲染「全部展开/收起」", () => {
    const { result } = render({ grouped: true });
    assert.match(result.text, /全部展开/);
    assert.match(result.text, /全部收起/);
  });

  it("点「全部展开」传全部键与 open=true", () => {
    const calls: { keys: readonly string[]; open: boolean }[] = [];
    const { result } = render({
      grouped: true,
      onSetAllCollapsed: (keys, open) => calls.push({ keys, open }),
    });
    const button = findAll(result, "button").find((element) => textOf(element) === "全部展开");
    fire(button!, "onClick");
    assert.equal(calls[0]?.open, true);
    assert.equal(calls[0]?.keys.length, 1);
  });

  it("视图切换按钮", () => {
    let toggles = 0;
    const { result } = render({ grouped: true, onToggleGrouped: () => { toggles += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "按目标聚合");
    fire(button!, "onClick");
    assert.equal(toggles, 1);
  });

  it("平铺时切换按钮文案变「平铺列表」", () => {
    assert.match(render({ grouped: false }).result.text, /平铺列表/);
  });

  it("点漏洞行展开", () => {
    const opened: number[] = [];
    const { result } = render({ grouped: false, onToggleOpen: (id) => opened.push(id) });
    const row = findAll(result, (element) => classOf(element) === "rt-vrow" && element.props["role"] === "button");
    fire(row[0]!, "onClick");
    assert.deepEqual(opened, [1]);
  });

  it("展开的漏洞渲染详情（资产/来源/状态按钮）", () => {
    const { result } = render({ grouped: false, openId: 1 });
    assert.match(result.text, /拿到什么/);
    assert.match(result.text, /确认/);
    assert.match(result.text, /已利用/);
    assert.match(result.text, /误报/);
    assert.match(result.text, /已修复/);
  });

  it("**展开的漏洞没有「拿到什么」时给补录提示**", () => {
    const { result } = render({ grouped: false, openId: 1 });
    assert.ok(result.text.includes(MISSING_GAINED_MESSAGE));
  });

  it("展开的漏洞没有攻击文件时给补录提示", () => {
    const { result } = render({ grouped: false, openId: 1 });
    assert.ok(result.text.includes(MISSING_ATTACK_FILE_MESSAGE));
  });

  it("**展开的漏洞没有证据时给红线提示**", () => {
    const { result } = render({ grouped: false, openId: 1 });
    assert.ok(result.text.includes(MISSING_EVIDENCE_MESSAGE));
  });

  it("点状态按钮回传 id 与新状态", () => {
    const calls: { id: number; status: string }[] = [];
    const { result } = render({
      grouped: false,
      openId: 1,
      onUpdateStatus: (id, status) => calls.push({ id, status }),
    });
    const button = findAll(result, "button").find((element) => textOf(element) === "已利用");
    fire(button!, "onClick", { stopPropagation: () => undefined });
    assert.equal(calls[0]?.id, 1);
    assert.equal(calls[0]?.status, "exploited");
  });

  it("展开的漏洞有证据时渲染报文块", () => {
    const { result } = render({
      grouped: false,
      openId: 1,
      findings: findings({
        items: [vuln({
          id: 1,
          evidence: "GET /x HTTP/1.1\nHost: a",
          httpEvidence: [{
            id: 1, label: "越权", method: "GET", status: 200,
            request: "GET / HTTP/1.1", response: "HTTP/1.1 200 OK", note: "备注", capturedAt: "2026-01-01T00:00:00Z",
          }],
        })],
      }),
    });
    assert.match(result.text, /原始报文/);
    assert.match(result.text, /越权/);
    assert.match(result.text, /▸ 响应/);
  });

  it("展开的漏洞有攻击文件时列出文件", () => {
    const { result } = render({
      grouped: false,
      openId: 1,
      fileGroups: [{
        target: "t",
        files: [{ id: 9, name: "poc.py", kind: "poc", description: "验证", path: "/pocs/poc.py", vulnId: 1, target: "t" }],
      }],
    });
    assert.match(result.text, /poc\.py/);
    assert.match(result.text, /\/pocs\/poc\.py/);
  });
});

describe("renderFindingsTab — 空态与错误态", () => {
  it("**findings 为 null 时工具栏与结论行仍渲染**（不整页空白）", () => {
    const { result } = render({ findings: null });
    assert.match(result.text, /搜索/);
    assert.match(result.text, /拿到权限/);
  });

  it("findings 为 null 时平铺视图显示空态", () => {
    const { result } = render({ findings: null });
    assert.ok(result.text.includes(EMPTY_FINDINGS_MESSAGE));
  });

  it("findings 为 null 时聚合视图显示空态", () => {
    const { result } = render({ findings: null, grouped: true });
    assert.ok(result.text.includes(EMPTY_FINDINGS_MESSAGE));
  });

  it("有数据但过滤后为空时也显示空态", () => {
    const { result } = render({ findings: findings({ items: [], total: 0 }) });
    assert.ok(result.text.includes(EMPTY_FINDINGS_MESSAGE));
  });

  it("查询失败显示 rt-err", () => {
    const { result } = render({ findings: findings({ items: [], error: "SQL 错误" }) });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
    assert.match(result.text, /SQL 错误/);
  });

  it("**查询失败时仍渲染工具栏**（不整页空白）", () => {
    const { result } = render({ findings: findings({ items: [], error: "SQL 错误" }) });
    assert.match(result.text, /搜索/);
  });

  it("**unknown op 时给重启建议而不是红色错误**", () => {
    const { result } = render({ findings: findings({ items: [], error: "unknown op: vulns" }) });
    assert.ok(result.text.includes(RESTART_HINT));
    assert.doesNotMatch(result.text, /unknown op/);
  });

  it("加载中不显示空态（避免闪一下「暂无漏洞记录」）", () => {
    const { result } = render({ findings: findings({ items: [], loading: true }) });
    assert.doesNotMatch(result.text, /暂无漏洞记录/);
  });

  it("成功消息渲染成 rt-foot", () => {
    const { result } = render({ message: { kind: "ok", text: "已更新为「已利用」" } });
    const node = findOne(result, (element) => classOf(element) === "rt-foot" && textOf(element).includes("已更新"));
    assert.notEqual(node, null);
  });

  it("失败消息渲染成 rt-err", () => {
    const { result } = render({ message: { kind: "err", text: "更新失败" } });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
  });
});
