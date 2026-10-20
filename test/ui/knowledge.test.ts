/**
 * 知识库页的模型 + 渲染测试。
 *
 * 重点：
 * - 归类计数是「知识库 + 本机模板」的和（只数知识库会让用户以为那类武器是空的）
 * - 空态的**五种**解读各给不同行动建议（这是全项目分支最多的页签）
 * - `tplMatched` 兜底成 `tpl.total`（老 host 不给 matched 时不显示 0–0 / 0）
 * - 检索是显式动作（边打字不发请求）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  detailFailureText,
  detailOf,
  failureText,
  knowledgeOf,
  loadPocDetail,
  queryAfterCategory,
  renderKnowledgeTab,
  searchPoc,
  usePoc,
  useSuccessMessage,
  type KnowledgeMessage,
  type KnowledgeTabProps,
} from "../../src/redteam/client/knowledge-tab.js";
import {
  CONTENT_LIMIT,
  DETAIL_LOADING_MESSAGE,
  EMPTY_KB_MESSAGE,
  EMPTY_QUERY,
  KB_ERROR_FALLBACK,
  KB_FOOTER,
  LOADING_KB_MESSAGE,
  MISSING_CONTENT_MESSAGE,
  NO_MATCH_MESSAGE,
  OLD_HOST_MESSAGE,
  POC_CATEGORY_OPTIONS,
  POC_CAT_NAME,
  POC_CAT_ORDER_LIST,
  POC_KIND_LABEL,
  POC_KIND_OPTIONS,
  POC_SOURCE_LABEL,
  STANDARD_ORDER_HINT,
  TEMPLATE_PAGE_SIZE,
  UNCATEGORIZED_TITLE,
  USED_ON_MANUAL,
  bucketKeyOf,
  canNextPage,
  canPrevPage,
  cardClass,
  categoryLabel,
  categoryName,
  categoryQuery,
  categoryShown,
  categoryTitle,
  contentBody,
  countOrZero,
  dbPathLine,
  detailFor,
  emptyDiagnosis,
  emptyTitle,
  errorText,
  groupCount,
  groupCountText,
  groupKey,
  groupOrder,
  groupRecentLabel,
  groupVerified,
  groupVerifiedText,
  hasFilters,
  hitCountLabel,
  isOldHostError,
  itemSubLine,
  kindClass,
  knowledgeDataOf,
  pageOffset,
  pocDetailOf,
  pocItemOf,
  pocKindLabel,
  pocSourceLabel,
  pocStatsOf,
  queryParams,
  searchLabel,
  showsCategory,
  showsDbPath,
  showsTemplateBlock,
  showsTemplateDir,
  showsUncategorized,
  statsLabels,
  templateCategoryLabel,
  templateCategoryMap,
  templateCommand,
  templateDirLine,
  templatePageOf,
  templateRangeLabel,
  templateRowOf,
  templateSeverity,
  toggleCategory,
  usedMessage,
  verifiedClass,
  verifiedLabel,
  verifiedOf,
  withQueryField,
  type CategoryCount,
  type KnowledgeData,
  type PocDetail,
  type PocItem,
  type TemplatePage,
} from "../../src/redteam/client/knowledge-model.js";
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

/** 造一条知识库条目。 */
function poc(overrides: Partial<PocItem> = {}): PocItem {
  return {
    id: 1,
    code: "weblogic-t3",
    title: "Weblogic T3 反序列化",
    kind: "poc",
    category: "deserialization",
    source: "web",
    cve: "CVE-2023-21839",
    component: "Weblogic",
    versions: "12.2.1.3",
    language: "python",
    tags: "java,反序列化",
    verified: true,
    hitCount: 2,
    createdAt: "2026-01-02T03:04:05Z",
    engagementId: "eng-1",
    engagementName: "示例单位",
    assetTarget: "10.0.0.5:7001",
    foundByAgent: "vuln-scan",
    sourceUrl: "https://example.com/p",
    ...overrides,
  };
}

/** 造模板分页块。 */
function templates(overrides: Partial<TemplatePage> = {}): TemplatePage {
  return {
    dir: "/opt/nuclei-templates",
    total: 0,
    matched: 0,
    offset: 0,
    items: [],
    byCategory: [],
    ...overrides,
  };
}

/** 造检索结果。 */
function knowledge(overrides: Partial<KnowledgeData> = {}): KnowledgeData {
  return {
    items: overrides.items ?? [poc()],
    stats: overrides.stats ?? {
      total: 1,
      verified: 1,
      reused: 2,
      uncategorized: 0,
      byCategory: [{ code: "deserialization", n: 1, verified: 1, hint: "反序列化 POC" }],
      byEngagement: [{ engagement: "eng-1", n: 1 }],
    },
    templates: overrides.templates ?? templates(),
    dbPath: overrides.dbPath ?? "$DSH_HOME/redteam/pocs.db",
    root: overrides.root ?? "$DSH_HOME/redteam",
  };
}

/** 默认 props。 */
function props(overrides: Partial<KnowledgeTabProps> = {}): KnowledgeTabProps {
  return {
    data: knowledge(),
    query: EMPTY_QUERY,
    openId: null,
    detail: null,
    detailBusy: false,
    busy: false,
    error: null,
    message: null,
    grouped: true,
    onQueryChange: () => undefined,
    onSubmit: () => undefined,
    onCategoryChange: () => undefined,
    onToggleGrouped: () => undefined,
    onOpen: () => undefined,
    onCopy: () => undefined,
    onUse: () => undefined,
    onPage: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<KnowledgeTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderKnowledgeTab(runtime, props(overrides))) };
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

describe("knowledge-model — 解析", () => {
  it("解析一条知识库条目", () => {
    const parsed = pocItemOf({
      id: 1,
      code: "c",
      title: "t",
      kind: "exp",
      category: "rce",
      source: "self",
      cve: "CVE-1",
      verified: 1,
      hit_count: 3,
      created_at: "2026-01-01T00:00:00Z",
    });
    assert.equal(parsed?.title, "t");
    assert.equal(parsed?.verified, true);
    assert.equal(parsed?.hitCount, 3);
  });

  it("**verified 兼容 1 与 true**（SQLite 给整数，也可能给布尔）", () => {
    assert.equal(verifiedOf(1), true);
    assert.equal(verifiedOf(true), true);
    assert.equal(verifiedOf(0), false);
    assert.equal(verifiedOf("1"), false);
  });

  it("丢没有 id 的条目", () => {
    assert.equal(pocItemOf({ title: "没有 id" }), null);
  });

  it("兼容驼峰的 hitCount / createdAt", () => {
    const parsed = pocItemOf({ id: 1, hitCount: 5, createdAt: "X" });
    assert.equal(parsed?.hitCount, 5);
    assert.equal(parsed?.createdAt, "X");
  });

  it("解析统计", () => {
    const stats = pocStatsOf({
      total: 10,
      verified: 3,
      reused: 7,
      uncategorized: 2,
      byCategory: [{ code: "rce", n: 5, verified: 1, hint: "h" }],
      byEngagement: [{ engagement: "e", n: 2 }],
    });
    assert.equal(stats.total, 10);
    assert.equal(stats.byCategory[0]?.n, 5);
    assert.equal(stats.byEngagement[0]?.engagement, "e");
  });

  it("统计里丢空的 code / engagement", () => {
    const stats = pocStatsOf({ byCategory: [{ code: "", n: 1 }], byEngagement: [{ engagement: "", n: 1 }] });
    assert.equal(stats.byCategory.length, 0);
    assert.equal(stats.byEngagement.length, 0);
  });

  it("解析模板行（丢没有 path 的）", () => {
    assert.equal(templateRowOf({ path: "/x.yaml", name: "n" })?.path, "/x.yaml");
    assert.equal(templateRowOf({ name: "没有 path" }), null);
  });

  it("**matched 缺失时兜底成 total**（否则页码显示 0–0 / 0）", () => {
    const page = templatePageOf({ total: 800, items: [] });
    assert.equal(page.matched, 800);
  });

  it("matched 显式给 0 时保留 0", () => {
    const page = templatePageOf({ total: 800, matched: 0 });
    assert.equal(page.matched, 0);
  });

  it("解析模板分页块", () => {
    const page = templatePageOf({
      dir: "/d",
      total: 100,
      matched: 5,
      offset: 40,
      items: [{ path: "/a.yaml" }],
      byCategory: [{ code: "rce", n: 3 }],
    });
    assert.equal(page.dir, "/d");
    assert.equal(page.offset, 40);
    assert.equal(page.items.length, 1);
  });

  it("模板 dir 缺失时给 null", () => {
    assert.equal(templatePageOf({}).dir, null);
  });

  it("解析完整检索结果", () => {
    const parsed = knowledgeDataOf({
      ok: true,
      items: [{ id: 1 }],
      stats: { total: 1 },
      templates: { total: 10 },
      dbPath: "/db",
      root: "/root",
    });
    assert.equal(parsed?.items.length, 1);
    assert.equal(parsed?.dbPath, "/db");
  });

  it("失败响应 → null", () => {
    assert.equal(knowledgeDataOf({ ok: false }), null);
  });

  it("解析详情", () => {
    const parsed = pocDetailOf({
      ok: true,
      id: 1,
      title: "t",
      content: "c",
      usage: "u",
      verified_note: "v",
      source_url: "http://x",
    });
    assert.equal(parsed?.content, "c");
    assert.equal(parsed?.verifiedNote, "v");
    assert.equal(parsed?.sourceUrl, "http://x");
  });

  it("详情失败 / 没有 id → null", () => {
    assert.equal(pocDetailOf({ ok: false }), null);
    assert.equal(pocDetailOf({ ok: true, title: "x" }), null);
  });

  it("countOrZero 兜底", () => {
    assert.equal(countOrZero("4"), 4);
    assert.equal(countOrZero(-1), 0);
    assert.equal(countOrZero(null), 0);
  });
});

describe("knowledge-model — 归类聚合", () => {
  const category: CategoryCount = { code: "rce", n: 5, verified: 2, hint: "远程命令执行" };

  it("**归类计数 = 知识库 + 本机模板**（只数知识库会让用户以为那类武器是空的）", () => {
    const map = new Map([["rce", 800]]);
    assert.equal(categoryShown(category, map), 805);
  });

  it("没有模板时就是知识库条数", () => {
    assert.equal(categoryShown(category, new Map()), 5);
  });

  it("templateCategoryMap 造表", () => {
    const map = templateCategoryMap(templates({ byCategory: [{ code: "rce", n: 3 }, { code: "sqli", n: 2 }] }));
    assert.equal(map.get("rce"), 3);
  });

  it("有内容的归类一定显示", () => {
    assert.equal(showsCategory({ code: "weird", n: 1, verified: 0, hint: "" }, 1), true);
  });

  it("**内置归类即使为空也显示**（让用户知道这一类还没有武器）", () => {
    assert.equal(showsCategory({ code: "xxe", n: 0, verified: 0, hint: "" }, 0), true);
  });

  it("**既没内容又不是内置归类 → 藏起来**", () => {
    assert.equal(showsCategory({ code: "weird", n: 0, verified: 0, hint: "" }, 0), false);
  });

  it("归类条的 title 说明三个数", () => {
    const title = categoryTitle(category, 805, 800);
    assert.match(title, /本机模板 800/);
    assert.match(title, /知识库 5/);
    assert.match(title, /已验证 2/);
  });

  it("归类条 title 在没有 hint 时用中文名", () => {
    assert.match(categoryTitle({ code: "rce", n: 0, verified: 0, hint: "" }, 0, 0), /远程命令执行/);
  });

  it("归类条的显示名带已验证数", () => {
    assert.equal(categoryLabel(category), "远程命令执行（已验证 2）");
    assert.equal(categoryLabel({ code: "rce", n: 1, verified: 0, hint: "" }), "远程命令执行");
  });

  it("**未知归类原样显示 code**", () => {
    assert.equal(categoryName("weird"), "weird");
  });

  it("类型与来源的中文名兜底", () => {
    assert.equal(pocKindLabel("poc"), "POC");
    assert.equal(pocKindLabel("weird"), "weird");
    assert.equal(pocKindLabel(""), "POC");
    assert.equal(pocSourceLabel("web"), "互联网");
    assert.equal(pocSourceLabel("weird"), "weird");
    assert.equal(pocSourceLabel(""), "—");
  });

  it("类型表有五个键、来源表有五个键", () => {
    assert.equal(Object.keys(POC_KIND_LABEL).length, 5);
    assert.equal(Object.keys(POC_SOURCE_LABEL).length, 5);
  });
});

describe("knowledge-model — 条目文案", () => {
  it("条目来源行把「什么时候在哪台资产上发现的」说清", () => {
    const line = itemSubLine(poc());
    assert.match(line, /归类 反序列化/);
    assert.match(line, /影响版本 12\.2\.1\.3/);
    assert.match(line, /建立时间 2026-01-02 03:04/);
    assert.match(line, /来源靶标 示例单位/);
    assert.match(line, /发现资产 10\.0\.0\.5:7001/);
    assert.match(line, /发现角色 漏洞发现/);
  });

  it("**没有来源靶标时退回 engagement_id**", () => {
    const line = itemSubLine(poc({ engagementName: "" }));
    assert.match(line, /来源靶标 eng-1/);
  });

  it("空字段全部省略（不留空分隔符）", () => {
    const line = itemSubLine(poc({
      category: "", versions: "", language: "", tags: "", engagementId: "", engagementName: "",
      assetTarget: "", foundByAgent: "", sourceUrl: "",
    }));
    assert.equal(line, "建立时间 2026-01-02 03:04");
  });

  it("复用标签只在 >0 时出现", () => {
    assert.equal(hitCountLabel(poc({ hitCount: 0 })), null);
    assert.equal(hitCountLabel(poc({ hitCount: 3 })), "复用 3");
  });

  it("验证徽章的文案与样式", () => {
    assert.equal(verifiedLabel(poc({ verified: true })), "已验证");
    assert.equal(verifiedLabel(poc({ verified: false })), "未验证");
    assert.equal(verifiedClass(poc({ verified: true })), "rt-tag rt-tag-live");
    assert.equal(verifiedClass(poc({ verified: false })), "rt-tag rt-tag-warn");
  });

  it("类型块 className（空类型守成 poc）", () => {
    assert.equal(kindClass(poc({ kind: "exp" })), "rt-kb-kind k-exp");
    assert.equal(kindClass(poc({ kind: "" })), "rt-kb-kind k-poc");
  });

  it("卡片 className 展开加 open", () => {
    assert.equal(cardClass(true), "rt-kb open");
    assert.equal(cardClass(false), "rt-kb");
  });

  it("正文超 12000 字符时截断并提示", () => {
    const long = "a".repeat(CONTENT_LIMIT + 100);
    const body = contentBody(long);
    assert.ok(body.length < long.length + 40);
    assert.match(body, /已截断，完整内容见落盘文件/);
  });

  it("正文不超时不加提示", () => {
    assert.equal(contentBody("short"), "short");
    assert.equal(contentBody(""), "");
  });

  it("detailFor 只返回当前展开项的详情", () => {
    const detail: PocDetail = {
      id: 1, title: "t", content: "c", usage: "", description: "", verifiedNote: "", usedOn: "", path: "", sourceUrl: "",
    };
    assert.equal(detailFor(detail, 1)?.id, 1);
    assert.equal(detailFor(detail, 2), null);
    assert.equal(detailFor(detail, null), null);
    assert.equal(detailFor(null, 1), null);
  });

  it("检索按钮文案", () => {
    assert.equal(searchLabel(false), "刷新");
    assert.equal(searchLabel(true), "检索中…");
  });

  it("复用成功的文案", () => {
    assert.equal(usedMessage("T"), "已记一次复用：T");
    assert.equal(USED_ON_MANUAL, "控制台手动标记");
  });
});

describe("knowledge-model — 模板分页", () => {
  const page = templates({ total: 800, matched: 812, offset: 40, items: [{ path: "/a.yaml", name: "a", severity: "high", category: "rce" }] });

  it("页码区间文案", () => {
    assert.match(templateRangeLabel(page, 40), /41–80 \/ 812/);
  });

  it("**上一页在 offset=0 时禁用**", () => {
    assert.equal(canPrevPage(false, 0), false);
    assert.equal(canPrevPage(false, 40), true);
  });

  it("**下一页到底时禁用**", () => {
    assert.equal(canNextPage(false, 800, 12, 812), false);
    assert.equal(canNextPage(false, 0, 40, 812), true);
  });

  it("busy 时两页都禁用", () => {
    assert.equal(canPrevPage(true, 40), false);
    assert.equal(canNextPage(true, 0, 40, 812), false);
  });

  it("**翻页 offset 不小于 0**（上一页按到底不会出现负值）", () => {
    assert.equal(pageOffset(-40), 0);
    assert.equal(pageOffset(40), 40);
  });

  it("模板命令", () => {
    assert.equal(templateCommand("/x.yaml"), "nuclei -t /x.yaml -u <目标>");
  });

  it("模板行的类别与严重级兜底", () => {
    assert.equal(templateCategoryLabel({ path: "/x", name: "", severity: "", category: "rce" }), "远程命令执行");
    assert.equal(templateCategoryLabel({ path: "/x", name: "", severity: "", category: "" }), null);
    assert.equal(templateSeverity({ path: "/x", name: "", severity: "", category: "" }), "—");
  });

  it("模板块只在有条目时渲染", () => {
    assert.equal(showsTemplateBlock(templates()), false);
    assert.equal(showsTemplateBlock(page), true);
  });

  it("模板目录行", () => {
    assert.equal(templateDirLine(page), "模板目录：/opt/nuclei-templates");
  });
});

describe("knowledge-model — 分组", () => {
  it("内置顺序优先、未知归类挂末尾", () => {
    assert.deepEqual(
      [...groupOrder(["weird", "rce", "sqli"])],
      ["rce", "sqli", "weird"],
    );
  });

  it("**只有出现的归类进顺序**", () => {
    assert.deepEqual([...groupOrder(["sqli"])], ["sqli"]);
  });

  it("空输入 → 空顺序", () => {
    assert.deepEqual([...groupOrder([])], []);
  });

  it("**未知归类归到 other**", () => {
    assert.equal(bucketKeyOf(poc({ category: "weird" })), "other");
    assert.equal(bucketKeyOf(poc({ category: "" })), "other");
    assert.equal(bucketKeyOf(poc({ category: "rce" })), "rce");
  });

  it("分组头的三个数字", () => {
    const list = [poc({ verified: true }), poc({ id: 2, verified: false })];
    assert.equal(groupCount(list), 2);
    assert.equal(groupVerified(list), 1);
    assert.equal(groupCountText(list), "2 条");
    assert.equal(groupVerifiedText(list), "已验证 1");
  });

  it("分组头的「最近建立」取最大时间", () => {
    const list = [
      poc({ createdAt: "2026-01-01T00:00:00Z" }),
      poc({ id: 2, createdAt: "2026-05-05T00:00:00Z" }),
    ];
    assert.match(groupRecentLabel(list), /2026-05-05 00:00/);
  });

  it("**全无时间时显示 —**", () => {
    assert.equal(groupRecentLabel([poc({ createdAt: "" })]), "最近建立 —");
  });

  it("分组 key", () => {
    assert.equal(groupKey("rce"), "grce");
  });
});

describe("knowledge-model — 空态诊断（五种）", () => {
  it("**有筛选条件 → 没命中**", () => {
    assert.equal(emptyDiagnosis({ ...EMPTY_QUERY, q: "x" }, templates()).kind, "no-match");
  });

  it("**类型筛选也算筛选**", () => {
    assert.equal(emptyDiagnosis({ ...EMPTY_QUERY, kind: "poc" }, templates()).kind, "no-match");
  });

  it("**只看已验证也算筛选**", () => {
    assert.equal(emptyDiagnosis({ ...EMPTY_QUERY, verifiedOnly: true }, templates()).kind, "no-match");
  });

  it("**库空 + 模板有但没列 → 重启客户端**", () => {
    const diagnosis = emptyDiagnosis(EMPTY_QUERY, templates({ total: 800, items: [] }));
    assert.equal(diagnosis.kind, "templates-not-listed");
    assert.match(emptyTitle(diagnosis), /已有 800 个 nuclei 模板/);
  });

  it("**模板目录存在但没有 yaml**", () => {
    const diagnosis = emptyDiagnosis(EMPTY_QUERY, templates({ dir: "/opt/t", total: 0 }));
    assert.equal(diagnosis.kind, "templates-dir-empty");
    assert.match(emptyTitle(diagnosis), /nuclei -update-templates/);
  });

  it("**模板目录都没有**", () => {
    const diagnosis = emptyDiagnosis(EMPTY_QUERY, templates({ dir: null, total: 0 }));
    assert.equal(diagnosis.kind, "no-templates");
    assert.match(emptyTitle(diagnosis), /setup\.sh/);
  });

  it("**五种文案各不相同**", () => {
    const titles = new Set([
      emptyTitle({ kind: "no-match" }),
      emptyTitle({ kind: "templates-not-listed", total: 1 }),
      emptyTitle({ kind: "templates-dir-empty", dir: "/d" }),
      emptyTitle({ kind: "no-templates" }),
      emptyTitle({ kind: "none" }),
    ]);
    assert.equal(titles.size, 5);
  });

  it("没命中的文案给出行动建议", () => {
    assert.equal(emptyTitle({ kind: "no-match" }), NO_MATCH_MESSAGE);
    assert.match(NO_MATCH_MESSAGE, /换个关键字/);
  });

  it("「库空」的兜底文案", () => {
    assert.equal(emptyTitle({ kind: "none" }), EMPTY_KB_MESSAGE);
  });

  it("打 Nday 的标准顺序说明", () => {
    assert.match(STANDARD_ORDER_HINT, /redteam_poc_search/);
    assert.match(STANDARD_ORDER_HINT, /redteam_poc_add/);
  });
});

describe("knowledge-model — 错误与路径", () => {
  it("**老 host 的两种错误都识别**", () => {
    assert.equal(isOldHostError("engagement required"), true);
    assert.equal(isOldHostError("unknown op: pocSearch"), true);
    assert.equal(isOldHostError("磁盘错误"), false);
    assert.equal(isOldHostError(null), false);
  });

  it("**老 host 错误换成可执行的恢复步骤**", () => {
    assert.equal(errorText("unknown op: pocSearch"), OLD_HOST_MESSAGE);
  });

  it("普通错误原样显示", () => {
    assert.equal(errorText("磁盘错误"), "磁盘错误");
  });

  it("null 错误 → 空串", () => {
    assert.equal(errorText(null), "");
  });

  it("知识库路径行（有 root 时补进去）", () => {
    assert.equal(dbPathLine(knowledge()), "知识库：$DSH_HOME/redteam/pocs.db（根目录 $DSH_HOME/redteam）");
  });

  it("**没有 root 时只显示库路径**", () => {
    assert.equal(dbPathLine(knowledge({ root: "" })), "知识库：$DSH_HOME/redteam/pocs.db");
  });

  it("dbPath 为空时不显示路径行", () => {
    assert.equal(showsDbPath(knowledge({ dbPath: "" })), false);
    assert.equal(showsDbPath(null), false);
  });

  it("模板目录为空时不显示目录行", () => {
    assert.equal(showsTemplateDir(templates({ dir: null })), false);
    assert.equal(showsTemplateDir(templates({ dir: "" })), false);
  });

  it("工具栏计数项", () => {
    const labels = statsLabels(
      { total: 10, verified: 3, reused: 7, uncategorized: 0, byCategory: [], byEngagement: [] },
      800,
    );
    assert.deepEqual([...labels], ["10 条", "已验证 3", "累计复用 7", "本机模板 800"]);
  });

  it("**未归类与总数相同时不显示「未归类」**（等于全都没归类，说了没用）", () => {
    const labels = statsLabels(
      { total: 5, verified: 0, reused: 0, uncategorized: 5, byCategory: [], byEngagement: [] },
      0,
    );
    assert.ok(!labels.some((label) => label.includes("未归类")));
  });

  it("未归类标签的显示条件", () => {
    assert.equal(showsUncategorized({ total: 10, verified: 0, reused: 0, uncategorized: 3, byCategory: [], byEngagement: [] }), true);
    assert.equal(showsUncategorized({ total: 3, verified: 0, reused: 0, uncategorized: 3, byCategory: [], byEngagement: [] }), false);
    assert.equal(showsUncategorized({ total: 3, verified: 0, reused: 0, uncategorized: 0, byCategory: [], byEngagement: [] }), false);
  });

  it("未归类标签的 title", () => {
    assert.match(UNCATEGORIZED_TITLE, /category/);
  });
});

describe("knowledge-model — 检索条件", () => {
  it("**空条件不下发空字段**（后端不该收到空串筛选）", () => {
    const params = queryParams(EMPTY_QUERY);
    assert.equal(Object.hasOwn(params, "q"), false);
    assert.equal(Object.hasOwn(params, "kind"), false);
    assert.equal(Object.hasOwn(params, "verified"), false);
    assert.equal(params["templateLimit"], TEMPLATE_PAGE_SIZE);
  });

  it("有值的字段下发（q 去首尾空白）", () => {
    const params = queryParams({ ...EMPTY_QUERY, q: "  ssti  ", kind: "poc" });
    assert.equal(params["q"], "ssti");
    assert.equal(params["kind"], "poc");
  });

  it("**verifiedOnly 为 false 时不下发**（后端没有「只要未验证」语义）", () => {
    assert.equal(Object.hasOwn(queryParams(EMPTY_QUERY), "verified"), false);
    assert.equal(queryParams({ ...EMPTY_QUERY, verifiedOnly: true })["verified"], true);
  });

  it("负 offset 归零", () => {
    assert.equal(queryParams({ ...EMPTY_QUERY, templateOffset: -10 })["templateOffset"], 0);
  });

  it("withQueryField 不改原对象", () => {
    const next = withQueryField(EMPTY_QUERY, "q", "x");
    assert.equal(next.q, "x");
    assert.equal(EMPTY_QUERY.q, "");
  });

  it("**点归类条：同一条再点清空**", () => {
    assert.equal(toggleCategory("rce", "rce"), "");
    assert.equal(toggleCategory("", "rce"), "rce");
    assert.equal(toggleCategory("sqli", "rce"), "rce");
  });

  it("点归类条后 offset 归零（换筛选要回到第一页）", () => {
    const next = categoryQuery({ ...EMPTY_QUERY, templateOffset: 80 }, "rce");
    assert.equal(next.category, "rce");
    assert.equal(next.templateOffset, 0);
  });

  it("hasFilters 覆盖六个字段", () => {
    assert.equal(hasFilters(EMPTY_QUERY), false);
    assert.equal(hasFilters({ ...EMPTY_QUERY, q: "x" }), true);
    assert.equal(hasFilters({ ...EMPTY_QUERY, engagement: "e" }), true);
    assert.equal(hasFilters({ ...EMPTY_QUERY, verifiedOnly: true }), true);
  });

  it("下拉选项：归类含「全部归类」，类型不含空值", () => {
    assert.equal(POC_CATEGORY_OPTIONS[0]?.value, "");
    assert.equal(POC_CATEGORY_OPTIONS.length, POC_CAT_ORDER_LIST.length + 1);
    assert.equal(POC_KIND_OPTIONS.length, 5);
  });

  it("归类表与 label.ts 共用一份（中文不会对不上）", () => {
    assert.equal(POC_CAT_NAME["rce"], "远程命令执行");
    assert.equal(POC_CAT_NAME["tunnel"], "隧道 / 代理");
  });
});

describe("knowledge-tab — 流程", () => {
  it("检索带参数", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    await searchPoc(api as never, { ...EMPTY_QUERY, q: "ssti", category: "sqli" });
    assert.equal(requests[0]?.["op"], "pocSearch");
    assert.equal(requests[0]?.["q"], "ssti");
    assert.equal(requests[0]?.["category"], "sqli");
  });

  it("读详情", async () => {
    const { api, requests } = fakeApi([{ ok: true, id: 3 }]);
    await loadPocDetail(api as never, 3);
    assert.equal(requests[0]?.["op"], "pocGet");
    assert.equal(requests[0]?.["id"], 3);
  });

  it("记一次复用带固定 used_on", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    await usePoc(api as never, 5);
    assert.equal(requests[0]?.["op"], "pocUse");
    assert.equal(requests[0]?.["used_on"], USED_ON_MANUAL);
  });

  it("knowledgeOf 解析", () => {
    assert.equal(knowledgeOf({ ok: true, items: [{ id: 1 }] })?.items.length, 1);
    assert.equal(knowledgeOf({ ok: false }), null);
  });

  it("failureText 取错误", () => {
    assert.equal(failureText({ ok: false, error: "x" }), "x");
    assert.equal(failureText({ ok: false }), KB_ERROR_FALLBACK);
    assert.equal(failureText({ ok: true }), null);
  });

  it("detailFailureText 取错误", () => {
    assert.equal(detailFailureText({ ok: false, error: "y" }), "y");
    assert.equal(detailFailureText({ ok: true }), null);
  });

  it("detailOf 解析详情", () => {
    assert.equal(detailOf({ ok: true, id: 1, content: "c" })?.content, "c");
  });

  it("useSuccessMessage 造消息", () => {
    assert.deepEqual(useSuccessMessage(poc({ title: "T" })), { kind: "ok", text: "已记一次复用：T" });
  });

  it("queryAfterCategory 复用模型", () => {
    const next = queryAfterCategory(EMPTY_QUERY, "rce");
    assert.equal(next.category, "rce");
  });
});

describe("renderKnowledgeTab — 工具栏与归类总览", () => {
  it("渲染标题与计数标签", () => {
    const { result } = render();
    assert.match(result.text, /知识库 · POC \/ EXP/);
    assert.match(result.text, /1 条/);
    assert.match(result.text, /已验证 1/);
  });

  it("**有未归类时显示警示标签与 tooltip**", () => {
    const { result } = render({
      data: knowledge({
        stats: {
          total: 10, verified: 3, reused: 2, uncategorized: 4,
          byCategory: [], byEngagement: [],
        },
      }),
    });
    assert.match(result.text, /未归类 4/);
    const badge = findAll(result, (element) => classOf(element) === "rt-tag rt-tag-warn")
      .find((element) => textOf(element).includes("未归类"));
    assert.equal(String(badge?.props["title"]), UNCATEGORIZED_TITLE);
  });

  it("**未归类等于总数时不显示**（等于全都没归类）", () => {
    const { result } = render({
      data: knowledge({
        stats: { total: 5, verified: 0, reused: 0, uncategorized: 5, byCategory: [], byEngagement: [] },
      }),
    });
    assert.doesNotMatch(result.text, /未归类/);
  });

  it("本机模板数非 0 时显示标签", () => {
    const { result } = render({ data: knowledge({ templates: templates({ total: 800 }) }) });
    assert.match(result.text, /本机模板 800/);
  });

  it("**归类条的计数是知识库 + 模板的和**", () => {
    const { result } = render({
      data: knowledge({
        stats: {
          total: 5, verified: 2, reused: 0, uncategorized: 0,
          byCategory: [{ code: "rce", n: 5, verified: 2, hint: "" }],
          byEngagement: [],
        },
        templates: templates({ byCategory: [{ code: "rce", n: 800 }] }),
      }),
    });
    assert.match(result.text, /<b>805<\/b>/);
  });

  it("点归类条触发 onCategoryChange", () => {
    const codes: string[] = [];
    const { result } = render({ onCategoryChange: (code) => codes.push(code) });
    const chip = findOne(result, (element) => classOf(element).startsWith("rt-concl-i"));
    fire(chip!, "onClick");
    assert.deepEqual(codes, ["deserialization"]);
  });

  it("键盘 Enter 也能点归类条", () => {
    const codes: string[] = [];
    const { result } = render({ onCategoryChange: (code) => codes.push(code) });
    const chip = findOne(result, (element) => classOf(element).startsWith("rt-concl-i"));
    fire(chip!, "onKeyDown", { key: "Enter" });
    assert.equal(codes.length, 1);
  });

  it("当前归类高亮", () => {
    const { result } = render({ query: { ...EMPTY_QUERY, category: "deserialization" } });
    const chips = findAll(result, (element) => classOf(element).startsWith("rt-concl-i"));
    assert.ok(chips.some((element) => classOf(element) === "rt-concl-i on"));
  });

  it("点分组/平铺切换", () => {
    let count = 0;
    const { result } = render({ onToggleGrouped: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "按归类分组");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("平铺时按钮文案变「平铺显示」", () => {
    assert.match(render({ grouped: false }).result.text, /平铺显示/);
  });

  it("点刷新触发 onSubmit", () => {
    let count = 0;
    const { result } = render({ onSubmit: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });
});

describe("renderKnowledgeTab — 检索表单", () => {
  it("**改搜索框只改本地状态，不发请求**（避免边打字边打接口）", () => {
    const changes: string[] = [];
    let submitted = 0;
    const { result } = render({
      onQueryChange: (query) => changes.push(query.q),
      onSubmit: () => { submitted += 1; },
    });
    const search = findAll(result, "input").find((element) =>
      String(element.props["placeholder"]).includes("搜 CVE"));
    fire(search!, "onChange", { target: { value: "ssti" } });
    assert.deepEqual(changes, ["ssti"]);
    assert.equal(submitted, 0);
  });

  it("**回车才提交检索**", () => {
    let submitted = 0;
    const { result } = render({ onSubmit: () => { submitted += 1; } });
    const search = findAll(result, "input").find((element) =>
      String(element.props["placeholder"]).includes("搜 CVE"));
    fire(search!, "onKeyDown", { key: "Enter" });
    assert.equal(submitted, 1);
  });

  it("点「检索」提交", () => {
    let submitted = 0;
    const { result } = render({ onSubmit: () => { submitted += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "检索");
    fire(button!, "onClick");
    assert.equal(submitted, 1);
  });

  it("搜索框预填当前值", () => {
    const { result } = render({ query: { ...EMPTY_QUERY, q: "ssti" } });
    const search = findAll(result, "input").find((element) =>
      String(element.props["placeholder"]).includes("搜 CVE"));
    assert.equal(search?.props["value"], "ssti");
  });

  it("**归类下拉改了立即检索**（与原实现一致）", () => {
    const codes: string[] = [];
    const { result } = render({ onCategoryChange: (code) => codes.push(code) });
    const selects = findAll(result, "select");
    fire(selects[0]!, "onChange", { target: { value: "rce" } });
    assert.deepEqual(codes, ["rce"]);
  });

  it("来源靶标下拉列出统计里的靶标", () => {
    const { result } = render();
    assert.match(result.text, /eng-1（1）/);
  });

  it("改来源靶标只改本地状态", () => {
    const changes: string[] = [];
    const { result } = render({ onQueryChange: (query) => changes.push(query.engagement) });
    const selects = findAll(result, "select");
    fire(selects[1]!, "onChange", { target: { value: "eng-1" } });
    assert.deepEqual(changes, ["eng-1"]);
  });

  it("改发现资产不改请求", () => {
    const changes: string[] = [];
    const { result } = render({ onQueryChange: (query) => changes.push(query.assetTarget) });
    const input = findAll(result, "input").find((element) =>
      element.props["placeholder"] === "发现资产筛选");
    fire(input!, "onChange", { target: { value: "10.0.0.5" } });
    assert.deepEqual(changes, ["10.0.0.5"]);
  });

  it("勾选「只看已验证」", () => {
    const changes: boolean[] = [];
    const { result } = render({ onQueryChange: (query) => changes.push(query.verifiedOnly) });
    const checkbox = findAll(result, "input").find((element) => element.props["type"] === "checkbox");
    fire(checkbox!, "onChange", { target: { checked: true } });
    assert.deepEqual(changes, [true]);
  });

  it("类型下拉改了只改本地状态", () => {
    const changes: string[] = [];
    const { result } = render({ onQueryChange: (query) => changes.push(query.kind) });
    const selects = findAll(result, "select");
    fire(selects[2]!, "onChange", { target: { value: "exp" } });
    assert.deepEqual(changes, ["exp"]);
  });

  it("**data 为 null 时表单仍渲染**（不整页空白）", () => {
    const { result } = render({ data: null });
    assert.match(result.text, /检索/);
    assert.match(result.text, /只看已验证/);
  });
});

describe("renderKnowledgeTab — 条目", () => {
  it("渲染条目标题 / CVE / 组件", () => {
    const { result } = render();
    assert.match(result.text, /Weblogic T3 反序列化/);
    assert.match(result.text, /CVE-2023-21839/);
    assert.match(result.text, /Weblogic/);
  });

  it("渲染类型块与来源", () => {
    const { result } = render();
    assert.match(result.text, /POC/);
    assert.match(result.text, /互联网/);
  });

  it("渲染复用标签", () => {
    assert.match(render().result.text, /复用 2/);
  });

  it("**0 次复用时不留「复用 0」**", () => {
    const { result } = render({ data: knowledge({ items: [poc({ hitCount: 0 })] }) });
    assert.doesNotMatch(result.text, /复用 0/);
  });

  it("渲染验证状态", () => {
    const verified = render();
    assert.match(verified.result.text, /已验证/);
    const unverified = render({ data: knowledge({ items: [poc({ verified: false })] }) });
    assert.match(unverified.result.text, /未验证/);
  });

  it("渲染来源行", () => {
    const { result } = render();
    assert.match(result.text, /来源靶标 示例单位/);
    assert.match(result.text, /发现资产 10\.0\.0\.5:7001/);
  });

  it("点条目展开", () => {
    const opened: number[] = [];
    const { result } = render({ onOpen: (id) => opened.push(id) });
    const head = findOne(result, (element) => classOf(element) === "rt-kb-head");
    fire(head!, "onClick");
    assert.deepEqual(opened, [1]);
  });

  it("**展开且详情未回来时显示「读取中…」**", () => {
    const { result } = render({ openId: 1, detailBusy: true });
    assert.ok(result.text.includes(DETAIL_LOADING_MESSAGE));
  });

  it("**展开且详情已回来时渲染正文与操作**", () => {
    const detail: PocDetail = {
      id: 1, title: "T", content: "print(1)", usage: "python poc.py", description: "说明",
      verifiedNote: "在 10.0.0.5 验证成功", usedOn: "示例单位", path: "pocs/c/poc.py", sourceUrl: "https://x",
    };
    const { result } = render({ openId: 1, detail });
    assert.match(result.text, /用法/);
    assert.match(result.text, /python poc\.py/);
    assert.match(result.text, /验证证据/);
    assert.match(result.text, /在 10\.0\.0\.5 验证成功/);
    assert.match(result.text, /最近使用/);
    assert.match(result.text, /pocs\/c\/poc\.py/);
    assert.match(result.text, /print\(1\)/);
  });

  it("**详情没有正文时给补录提示**", () => {
    const detail: PocDetail = {
      id: 1, title: "T", content: "", usage: "", description: "", verifiedNote: "",
      usedOn: "", path: "", sourceUrl: "",
    };
    const { result } = render({ openId: 1, detail });
    assert.ok(result.text.includes(MISSING_CONTENT_MESSAGE));
  });

  it("**「复制正文」在没有正文时禁用**", () => {
    const detail: PocDetail = {
      id: 1, title: "T", content: "", usage: "", description: "", verifiedNote: "",
      usedOn: "", path: "", sourceUrl: "",
    };
    const { result } = render({ openId: 1, detail });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制正文");
    assert.equal(button?.props["disabled"], true);
  });

  it("点「复制正文」传正文", () => {
    const copied: string[] = [];
    const detail: PocDetail = {
      id: 1, title: "T", content: "print(1)", usage: "", description: "", verifiedNote: "",
      usedOn: "", path: "", sourceUrl: "",
    };
    const { result } = render({ openId: 1, detail, onCopy: (text) => copied.push(text) });
    const button = findAll(result, "button").find((element) => textOf(element) === "复制正文");
    fire(button!, "onClick");
    assert.deepEqual(copied, ["print(1)"]);
  });

  it("点「记一次复用」回传条目", () => {
    const used: number[] = [];
    const detail: PocDetail = {
      id: 1, title: "T", content: "c", usage: "", description: "", verifiedNote: "",
      usedOn: "", path: "", sourceUrl: "",
    };
    const { result } = render({ openId: 1, detail, onUse: (item) => used.push(item.id) });
    const button = findAll(result, "button").find((element) => textOf(element) === "记一次复用");
    fire(button!, "onClick");
    assert.deepEqual(used, [1]);
  });

  it("**有 sourceUrl 时才显示「复制来源」**", () => {
    const withUrl: PocDetail = {
      id: 1, title: "T", content: "c", usage: "", description: "", verifiedNote: "",
      usedOn: "", path: "", sourceUrl: "https://x",
    };
    const without: PocDetail = { ...withUrl, sourceUrl: "" };
    assert.match(render({ openId: 1, detail: withUrl }).result.text, /复制来源/);
    assert.doesNotMatch(render({ openId: 1, detail: without }).result.text, /复制来源/);
  });

  it("**详情属于别的条目时不渲染**（切走后不留上一条）", () => {
    const detail: PocDetail = {
      id: 99, title: "T", content: "不该出现", usage: "", description: "", verifiedNote: "",
      usedOn: "", path: "", sourceUrl: "",
    };
    const { result } = render({ openId: 1, detail });
    assert.doesNotMatch(result.text, /不该出现/);
  });
});

describe("renderKnowledgeTab — 分组与平铺", () => {
  it("分组视图渲染归类标题与计数", () => {
    const { result } = render({ grouped: true });
    assert.match(result.text, /反序列化/);
    assert.match(result.text, /1 条/);
    assert.match(result.text, /已验证 1/);
  });

  it("**未知归类挂到「其它」**", () => {
    const { result } = render({
      grouped: true,
      data: knowledge({
        items: [poc({ category: "weird" })],
        stats: {
          total: 1, verified: 0, reused: 0, uncategorized: 1,
          byCategory: [{ code: "weird", n: 1, verified: 0, hint: "" }],
          byEngagement: [],
        },
      }),
    });
    assert.match(result.text, /其它/);
  });

  it("平铺视图不渲染归类标题", () => {
    const { result } = render({ grouped: false });
    const cats = findAll(result, (element) => classOf(element) === "rt-kb-cat");
    assert.equal(cats.length, 0);
  });

  it("分组视图渲染「最近建立」", () => {
    assert.match(render({ grouped: true }).result.text, /最近建立 2026-01-02 03:04/);
  });
});

describe("renderKnowledgeTab — 模板块", () => {
  const page = templates({
    total: 800,
    matched: 812,
    offset: 0,
    items: [
      { path: "/t/cve.yaml", name: "cve", severity: "high", category: "rce" },
      { path: "/t/x.yaml", name: "x", severity: "", category: "" },
    ],
  });

  it("渲染模板行与页码", () => {
    const { result } = render({ data: knowledge({ templates: page }) });
    assert.match(result.text, /本机 nuclei 模板 · 1–2 \/ 812/);
    assert.match(result.text, /\/t\/cve\.yaml/);
  });

  it("模板的严重级兜底成 —", () => {
    const { result } = render({ data: knowledge({ templates: page }) });
    assert.match(result.text, /—/);
  });

  it("点「复制命令」传完整命令", () => {
    const copied: string[] = [];
    const { result } = render({
      data: knowledge({ templates: page }),
      onCopy: (text) => copied.push(text),
    });
    const buttons = findAll(result, "button").filter((element) => textOf(element) === "复制命令");
    fire(buttons[0]!, "onClick");
    assert.equal(copied[0], "nuclei -t /t/cve.yaml -u <目标>");
  });

  it("**第一页时「上一页」禁用**", () => {
    const { result } = render({ data: knowledge({ templates: page }) });
    const button = findAll(result, "button").find((element) => textOf(element) === "上一页");
    assert.equal(button?.props["disabled"], true);
  });

  it("**最后一页时「下一页」禁用**", () => {
    const last = templates({ total: 800, matched: 2, offset: 0, items: page.items });
    const { result } = render({ data: knowledge({ templates: last }) });
    const button = findAll(result, "button").find((element) => textOf(element) === "下一页");
    assert.equal(button?.props["disabled"], true);
  });

  it("翻页传新 offset", () => {
    const offsets: number[] = [];
    const { result } = render({
      data: knowledge({ templates: templates({ total: 800, matched: 800, offset: 40, items: page.items }) }),
      onPage: (offset) => offsets.push(offset),
    });
    const prev = findAll(result, "button").find((element) => textOf(element) === "上一页");
    fire(prev!, "onClick");
    assert.deepEqual(offsets, [0]);
  });

  it("下一页加一页的偏移", () => {
    const offsets: number[] = [];
    const { result } = render({
      data: knowledge({ templates: templates({ total: 800, matched: 800, offset: 0, items: page.items }) }),
      onPage: (offset) => offsets.push(offset),
    });
    const next = findAll(result, "button").find((element) => textOf(element) === "下一页");
    fire(next!, "onClick");
    assert.deepEqual(offsets, [TEMPLATE_PAGE_SIZE]);
  });

  it("**没有模板条目时不渲染模板块**", () => {
    assert.doesNotMatch(render().result.text, /本机 nuclei 模板/);
  });

  it("模板目录在块底部显示", () => {
    const { result } = render({ data: knowledge({ templates: page }) });
    assert.match(result.text, /模板目录：\/opt\/nuclei-templates/);
  });
});

describe("renderKnowledgeTab — 空态与错误态", () => {
  it("**data 为 null 时显示「加载中…」**", () => {
    assert.ok(render({ data: null }).result.text.includes(LOADING_KB_MESSAGE));
  });

  it("**data 为 null 且无错误时不显示空态诊断**（避免闪一下「知识库还是空的」）", () => {
    const text = render({ data: null }).result.text;
    assert.ok(!text.includes(EMPTY_KB_MESSAGE));
    assert.ok(!text.includes(NO_MATCH_MESSAGE));
  });

  it("**有筛选条件但没命中 → 换关键字**", () => {
    const { result } = render({
      data: knowledge({ items: [] }),
      query: { ...EMPTY_QUERY, q: "ssti" },
    });
    assert.ok(result.text.includes(NO_MATCH_MESSAGE));
  });

  it("**库空 + 模板有但没列 → 重启客户端**", () => {
    const { result } = render({
      data: knowledge({ items: [], templates: templates({ total: 800 }) }),
    });
    assert.match(result.text, /已有 800 个 nuclei 模板/);
  });

  it("**模板目录存在但没有 yaml**", () => {
    const { result } = render({
      data: knowledge({ items: [], templates: templates({ dir: "/opt/t", total: 0 }) }),
    });
    assert.match(result.text, /nuclei -update-templates/);
  });

  it("**都没有 → 装模板库**", () => {
    const { result } = render({
      data: knowledge({ items: [], templates: templates({ dir: null, total: 0 }) }),
    });
    assert.match(result.text, /setup\.sh/);
  });

  it("空态里有打 Nday 的标准顺序", () => {
    const { result } = render({ data: knowledge({ items: [], templates: templates({ dir: null }) }) });
    assert.ok(result.text.includes(STANDARD_ORDER_HINT));
  });

  it("空态里显示知识库文件与模板目录", () => {
    const { result } = render({
      data: knowledge({ items: [], templates: templates({ dir: "/opt/t" }) }),
    });
    assert.match(result.text, /知识库文件：\$DSH_HOME\/redteam\/pocs\.db/);
    assert.match(result.text, /模板目录：\/opt\/t/);
  });

  it("**有模板条目时不显示空态**（模板块本身就是内容）", () => {
    const { result } = render({
      data: knowledge({
        items: [],
        templates: templates({ total: 5, matched: 5, items: [{ path: "/a.yaml", name: "a", severity: "low", category: "" }] }),
      }),
    });
    assert.ok(!result.text.includes(EMPTY_KB_MESSAGE));
    assert.doesNotMatch(result.text, /setup\.sh/);
  });

  it("**普通错误显示 rt-err 且原样透出**", () => {
    const { result } = render({ data: null, error: "磁盘错误" });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
    assert.match(result.text, /磁盘错误/);
  });

  it("**老 host 错误换成恢复步骤**", () => {
    const { result } = render({ data: null, error: "unknown op: pocSearch" });
    assert.ok(result.text.includes(OLD_HOST_MESSAGE));
    assert.doesNotMatch(result.text, /unknown op/);
  });

  it("**出错时仍渲染工具栏与检索表单**", () => {
    const { result } = render({ data: null, error: "磁盘错误" });
    assert.match(result.text, /知识库 · POC \/ EXP/);
    assert.match(result.text, /检索/);
  });

  it("知识库路径行在有 dbPath 且无错误时显示", () => {
    assert.match(render().result.text, /知识库：\$DSH_HOME\/redteam\/pocs\.db/);
  });

  it("**出错时不显示知识库路径**（避免两条信息互相干扰）", () => {
    const { result } = render({ data: knowledge(), error: "磁盘错误" });
    const pathNodes = findAll(result, (element) =>
      classOf(element) === "rt-foot" && textOf(element).startsWith("知识库："));
    assert.equal(pathNodes.length, 0);
  });

  it("成功消息渲染成 rt-foot", () => {
    const message: KnowledgeMessage = { kind: "ok", text: "已记一次复用：T" };
    const { result } = render({ message });
    const node = findOne(result, (element) => classOf(element) === "rt-foot" && textOf(element) === message.text);
    assert.notEqual(node, null);
  });

  it("失败消息渲染成 rt-err", () => {
    const { result } = render({ message: { kind: "err", text: "复制失败" } });
    const node = findOne(result, (element) => classOf(element) === "rt-err" && textOf(element) === "复制失败");
    assert.notEqual(node, null);
  });

  it("底部有全局共享说明", () => {
    assert.ok(render().result.text.includes(KB_FOOTER));
  });
});
