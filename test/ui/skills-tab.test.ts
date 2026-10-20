/**
 * 技能库页渲染测试。
 *
 * 重点是**条件分支**：
 * - `catalog === null`（未加载）/ 加载中 / 失败 / 成功
 * - `restartHint` 时的行动建议（而不是让用户对着 `unknown op` 发呆）
 * - 「只看不可用」复选框**只在真有缺口时出现**
 * - 展开/折叠同一技能的语义
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  loadSkillCatalog,
  loadSkillDetail,
  nextActiveKey,
  renderSkillsTab,
  resetFilter,
  toggleFilterFlag,
  type SkillsTabProps,
} from "../../src/redteam/client/skills-tab.js";
import {
  DEFAULT_SKILL_FILTER,
  catalogLoadOf,
  type CatalogLoad,
  type SkillFilter,
  type SkillItem,
} from "../../src/redteam/client/skills-model.js";
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

/** 造一条技能。 */
function skill(overrides: Partial<SkillItem> = {}): SkillItem {
  return {
    name: "recon",
    description: "信息收集",
    whenToUse: "开始前",
    provider: "dsh-qilin",
    source: "plugin",
    dir: "/skills/redteam",
    modelInvocable: true,
    userInvocable: true,
    fromPlugin: true,
    library: "redteam",
    availability: "available",
    problems: [],
    needsUser: [],
    ...overrides,
  };
}

/** 造目录加载结果。 */
function catalog(overrides: {
  readonly items?: readonly SkillItem[];
  readonly summary?: { available: number; broken: number; unknown: number };
  readonly fromPlugin?: number;
  readonly error?: string | null;
  readonly restartHint?: boolean;
} = {}): CatalogLoad {
  const items = overrides.items ?? [skill()];
  const summary = overrides.summary ?? { available: items.length, broken: 0, unknown: 0 };
  return {
    ok: overrides.error === undefined || overrides.error === null,
    items,
    meta: {
      total: items.length,
      fromPlugin: overrides.fromPlugin ?? items.filter((item) => item.fromPlugin).length,
      availability: summary,
      checkedAt: 1700000000000,
      cached: false,
      broken: [],
      byDir: [{ key: "/skills/redteam", n: items.length }],
      bySource: [{ key: "plugin", n: items.length }],
      note: "",
    },
    error: overrides.error ?? null,
    restartHint: overrides.restartHint ?? false,
  };
}

/** 默认 props。 */
function props(overrides: Partial<SkillsTabProps> = {}): SkillsTabProps {
  return {
    catalog: catalog(),
    filter: DEFAULT_SKILL_FILTER,
    activeKey: null,
    detail: null,
    busy: false,
    detailBusy: false,
    onRefresh: () => undefined,
    onFilterChange: () => undefined,
    onToggle: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<SkillsTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderSkillsTab(runtime, props(overrides))) };
}

describe("renderSkillsTab — 工具栏", () => {
  it("渲染标题与总数", () => {
    const { result } = render();
    assert.match(result.text, /技能库/);
    assert.match(result.text, /共 1 个/);
  });

  it("显示本插件数量", () => {
    assert.match(render({ catalog: catalog({ fromPlugin: 2 }) }).result.text, /本插件 2/);
  });

  it("显示可用性徽章", () => {
    const text = render({ catalog: catalog({ summary: { available: 5, broken: 2, unknown: 1 } }) }).result.text;
    assert.match(text, /可用 5/);
    assert.match(text, /不可用 2/);
    assert.match(text, /未知 1/);
  });

  it("**broken=0 时不显示「不可用 0」**（无噪声）", () => {
    const text = render({ catalog: catalog({ summary: { available: 3, broken: 0, unknown: 0 } }) }).result.text;
    assert.doesNotMatch(text, /不可用 0/);
  });

  it("点击刷新传 force=true（跳过后端缓存）", () => {
    const forces: boolean[] = [];
    const { result } = render({ onRefresh: (force) => forces.push(force) });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.deepEqual(forces, [true]);
  });

  it("busy 时按钮文案「读取中…」且禁用", () => {
    const { result } = render({ busy: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("读取中"));
    assert.equal(button?.props["disabled"], true);
  });

  it("刷新按钮 title 说明跳过缓存", () => {
    const { result } = render();
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    assert.match(String(button?.props["title"]), /缓存/);
  });
});

describe("renderSkillsTab — 加载状态", () => {
  it("catalog 为 null 时不抛，显示空态", () => {
    const { result } = render({ catalog: null });
    assert.match(result.text, /没有技能/);
  });

  it("**catalog 为 null 时工具栏仍渲染**（界面结构稳定，不整页空白）", () => {
    const { result } = render({ catalog: null });
    assert.match(result.text, /技能库/);
  });

  it("加载失败时显示错误", () => {
    const { result } = render({ catalog: catalog({ items: [], error: "磁盘错误" }) });
    const errorNode = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(errorNode, null);
    assert.match(result.text, /磁盘错误/);
  });

  it("**restartHint 时给行动建议**", () => {
    const { result } = render({
      catalog: catalog({
        items: [],
        error: "unknown op: skillCatalog",
        restartHint: true,
      }),
    });
    assert.match(result.text, /重启 dsh web/);
  });

  it("普通错误不给重启建议", () => {
    const { result } = render({ catalog: catalog({ items: [], error: "磁盘错误" }) });
    assert.doesNotMatch(result.text, /重启 dsh web/);
  });

  it("目录为空时提示目录为空（而不是「没有匹配」）", () => {
    const { result } = render({ catalog: catalog({ items: [] }) });
    assert.match(result.text, /skills\/redteam 目录为空/);
  });

  it("有技能但过滤后为空时提示「没有匹配」", () => {
    const { result } = render({ filter: { ...DEFAULT_SKILL_FILTER, query: "zzz" } });
    assert.match(result.text, /没有匹配/);
  });
});

describe("renderSkillsTab — 过滤控件", () => {
  it("搜索框预填当前值", () => {
    const { result } = render({ filter: { ...DEFAULT_SKILL_FILTER, query: "abc" } });
    assert.equal(findOne(result, "input")?.props["value"], "abc");
  });

  it("改搜索框触发 onFilterChange", () => {
    const changes: SkillFilter[] = [];
    const { result } = render({ onFilterChange: (filter) => changes.push(filter) });
    const search = findAll(result, "input").find((element) => element.props["placeholder"] === "过滤技能");
    fire(search!, "onChange", { target: { value: "rec" } });
    assert.equal(changes[0]?.query, "rec");
  });

  it("「只看本插件」显示数量", () => {
    assert.match(render({ catalog: catalog({ fromPlugin: 4 }) }).result.text, /只看本插件自带（4 个）/);
  });

  it("勾选「只看本插件」触发 onFilterChange", () => {
    const changes: SkillFilter[] = [];
    const { result } = render({ onFilterChange: (filter) => changes.push(filter) });
    const checkbox = findAll(result, "input").find((element) => element.props["type"] === "checkbox");
    fire(checkbox!, "onChange", { target: { checked: true } });
    assert.equal(changes[0]?.pluginOnly, true);
  });

  it("**有缺口时才显示「只看不可用」**", () => {
    const withGap = render({ catalog: catalog({ summary: { available: 3, broken: 1, unknown: 0 } }) });
    assert.match(withGap.result.text, /只看不可用\/未知/);

    const noGap = render({ catalog: catalog({ summary: { available: 3, broken: 0, unknown: 0 } }) });
    assert.doesNotMatch(noGap.result.text, /只看不可用\/未知/);
  });

  it("「只看不可用」的数量是 broken + unknown", () => {
    const { result } = render({ catalog: catalog({ summary: { available: 1, broken: 2, unknown: 3 } }) });
    assert.match(result.text, /只看不可用\/未知（5 个）/);
  });

  it("「只看不可用」的 title 说明判定口径", () => {
    const { result } = render({ catalog: catalog({ summary: { available: 1, broken: 1, unknown: 0 } }) });
    const label = findAll(result, (element) => element.props["className"] === "rt-kb-check")
      .find((element) => textOf(element).includes("只看不可用"));
    assert.match(String(label?.props["title"]), /缺口/);
  });

  it("目录聚合显示前 6 个", () => {
    const items = [skill()];
    const load = catalog({ items });
    const many = {
      ...load,
      meta: { ...load.meta!, byDir: Array.from({ length: 10 }, (_, index) => ({ key: "/d" + index, n: 1 })) },
    };
    const { result } = render({ catalog: many });
    // 6 个目录 chip + 各种 tag，数 "/d" 开头的出现次数。
    const matches = result.text.match(/\/d\d/g) ?? [];
    assert.ok(new Set(matches).size <= 6, "最多 6 个目录聚合");
  });
});

describe("renderSkillsTab — 技能列表", () => {
  it("渲染技能名与描述", () => {
    const { result } = render();
    assert.match(result.text, /recon/);
    assert.match(result.text, /信息收集/);
  });

  it("无描述时显示（无描述）", () => {
    const { result } = render({ catalog: catalog({ items: [skill({ description: "" })] }) });
    assert.match(result.text, /（无描述）/);
  });

  it("**按库分组显示组标题**", () => {
    const { result } = render({
      catalog: catalog({
        items: [
          skill({ name: "r1", library: "redteam" }),
          skill({ name: "o1", library: "official", availability: "listed" }),
        ],
      }),
    });
    assert.match(result.text, /红队技能/);
    assert.match(result.text, /官方技能/);
  });

  it("只有红队技能时不显示官方组标题", () => {
    const { result } = render({ catalog: catalog({ items: [skill()] }) });
    assert.doesNotMatch(result.text, /官方技能/);
  });

  it("**仅人工的技能标「仅人工」**", () => {
    const { result } = render({ catalog: catalog({ items: [skill({ modelInvocable: false })] }) });
    assert.match(result.text, /仅人工/);
  });

  it("官方技能标「官方」而不是可用性", () => {
    const { result } = render({
      catalog: catalog({ items: [skill({ library: "official", availability: "listed" })] }),
    });
    assert.match(result.text, /官方/);
    // 不该出现「已列出」这种内部状态名。
    assert.doesNotMatch(result.text, /已列出/);
  });

  it("红队技能标可用性", () => {
    const { result } = render({ catalog: catalog({ items: [skill({ availability: "broken", problems: ["缺 nmap"] })] }) });
    assert.match(result.text, /不可用/);
  });

  it("显示副标题（来源 · 目录）", () => {
    assert.match(render().result.text, /来源 plugin/);
  });

  it("不可用且有问题时显示 ⚠ 提示行", () => {
    const { result } = render({
      catalog: catalog({ items: [skill({ availability: "broken", problems: ["缺 nmap 工具"] })] }),
    });
    assert.match(result.text, /⚠ 缺 nmap 工具/);
  });

  it("**可用的技能不显示 ⚠**（缺工具不阻止调用）", () => {
    const { result } = render({
      catalog: catalog({ items: [skill({ availability: "available", problems: ["缺 nmap"] })] }),
    });
    assert.doesNotMatch(result.text, /⚠/);
  });

  it("点击技能触发 onToggle", () => {
    const toggled: SkillItem[] = [];
    const { result } = render({ onToggle: (item) => toggled.push(item) });
    const row = findOne(result, (element) => element.props["role"] === "button");
    fire(row!, "onClick");
    assert.equal(toggled[0]?.name, "recon");
  });

  it("**技能行键盘可达**（Enter）", () => {
    const toggled: SkillItem[] = [];
    const { result } = render({ onToggle: (item) => toggled.push(item) });
    const row = findOne(result, (element) => element.props["role"] === "button");
    fire(row!, "onKeyDown", { key: "Enter" });
    assert.equal(toggled.length, 1);
  });

  it("**技能行键盘可达**（Space）", () => {
    const toggled: SkillItem[] = [];
    const { result } = render({ onToggle: (item) => toggled.push(item) });
    const row = findOne(result, (element) => element.props["role"] === "button");
    fire(row!, "onKeyDown", { key: " " });
    assert.equal(toggled.length, 1);
  });

  it("展开的技能带 on 类名与 aria-expanded", () => {
    const { result } = render({ activeKey: "redteam:recon" });
    const row = findOne(result, (element) => element.props["role"] === "button");
    assert.match(classOf(row!), /on/);
    assert.equal(row?.props["aria-expanded"], "true");
  });

  it("未展开的技能 aria-expanded=false", () => {
    const { result } = render();
    const row = findOne(result, (element) => element.props["role"] === "button");
    assert.equal(row?.props["aria-expanded"], "false");
  });
});

describe("renderSkillsTab — 详情面板", () => {
  it("未展开时提示点左侧", () => {
    assert.match(render().result.text, /点左侧技能查看正文/);
  });

  it("详情加载中显示「载入中…」", () => {
    assert.match(render({ activeKey: "redteam:recon", detailBusy: true }).result.text, /载入中/);
  });

  it("详情为空时提示读取失败", () => {
    assert.match(render({ activeKey: "redteam:recon", detail: null }).result.text, /读取失败或没有正文/);
  });

  it("渲染详情名称、描述、适用场景、路径与正文", () => {
    const { result } = render({
      activeKey: "redteam:recon",
      detail: {
        name: "recon",
        description: "信息收集",
        whenToUse: "项目开始",
        provider: "p",
        source: "s",
        path: "/skills/recon.md",
        content: "# 正文内容",
      },
    });
    assert.match(result.text, /recon/);
    assert.match(result.text, /适用：项目开始/);
    assert.match(result.text, /\/skills\/recon\.md/);
    assert.match(result.text, /# 正文内容/);
  });

  it("path 为 null 时不渲染路径行", () => {
    const { result } = render({
      activeKey: "redteam:recon",
      detail: { name: "x", description: "", whenToUse: "", provider: "", source: "", path: null, content: "c" },
    });
    assert.doesNotMatch(result.text, /null/);
  });

  it("空描述时不渲染描述行", () => {
    const { result } = render({
      activeKey: "redteam:recon",
      detail: { name: "x", description: "", whenToUse: "", provider: "", source: "", path: null, content: "c" },
    });
    assert.doesNotMatch(result.text, /（无描述）/, "详情面板不该用列表的兜底文案");
  });
});

describe("流程函数", () => {
  /** 假 api。 */
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

  it("loadSkillCatalog 带 refresh 参数", async () => {
    const api = fakeApi({ ok: true, items: [] });
    await loadSkillCatalog(api, true);
    assert.equal(api.calls[0]?.["op"], "skillCatalog");
    assert.equal(api.calls[0]?.["refresh"], true);
  });

  it("loadSkillCatalog force=false 时 refresh=false", async () => {
    const api = fakeApi({ ok: true, items: [] });
    await loadSkillCatalog(api, false);
    assert.equal(api.calls[0]?.["refresh"], false);
  });

  it("loadSkillCatalog 成功时返回 items", async () => {
    const api = fakeApi({ ok: true, items: [{ name: "a" }] });
    const load = await loadSkillCatalog(api, false);
    assert.equal(load.ok, true);
    assert.equal(load.items.length, 1);
  });

  it("loadSkillDetail 发 skillRead 带 library", async () => {
    const api = fakeApi({ ok: true, name: "recon", content: "c" });
    await loadSkillDetail(api, skill({ name: "recon", library: "official" }));
    assert.equal(api.calls[0]?.["op"], "skillRead");
    assert.equal(api.calls[0]?.["name"], "recon");
    assert.equal(api.calls[0]?.["library"], "official");
  });

  it("loadSkillDetail 失败时带回错误", async () => {
    const api = fakeApi({ ok: false, error: "无此技能" });
    const result = await loadSkillDetail(api, skill());
    assert.equal(result.detail, null);
    assert.equal(result.error, "无此技能");
  });

  it("loadSkillDetail 成功时解析详情", async () => {
    const api = fakeApi({ ok: true, name: "recon", content: "# 正文" });
    const result = await loadSkillDetail(api, skill());
    assert.equal(result.detail?.content, "# 正文");
    assert.equal(result.error, null);
  });
});

describe("过滤助手", () => {
  it("toggleFilterFlag 切换 pluginOnly", () => {
    assert.equal(toggleFilterFlag(DEFAULT_SKILL_FILTER, "pluginOnly").pluginOnly, true);
  });

  it("toggleFilterFlag 切换 brokenOnly", () => {
    assert.equal(toggleFilterFlag(DEFAULT_SKILL_FILTER, "brokenOnly").brokenOnly, true);
  });

  it("toggleFilterFlag 不修改原对象", () => {
    const original = { ...DEFAULT_SKILL_FILTER };
    toggleFilterFlag(original, "pluginOnly");
    assert.equal(original.pluginOnly, false);
  });

  it("resetFilter 给默认值", () => {
    assert.deepEqual(resetFilter(), DEFAULT_SKILL_FILTER);
  });

  it("nextActiveKey 复用模型层语义：点同一条折叠", () => {
    const item = skill();
    assert.equal(nextActiveKey("redteam:recon", item), null);
    assert.equal(nextActiveKey(null, item), "redteam:recon");
  });
});

describe("端到端：catalogLoadOf 与渲染衔接", () => {
  it("从原始响应一路渲染到界面", () => {
    const runtime = makeRuntime();
    const load = catalogLoadOf({
      ok: true,
      total: 2,
      fromPlugin: 1,
      availability: { summary: { available: 1, broken: 1, unknown: 0 }, checked_at: 1700000000000, cached: false },
      byDir: [{ key: "/skills/redteam", n: 2 }],
      bySource: [{ key: "plugin", n: 1 }],
      items: [
        { name: "recon", description: "信息收集", fromPlugin: true, library: "redteam", availability: "available" },
        { name: "scan", description: "扫描", fromPlugin: false, library: "redteam", availability: "broken", problems: ["缺 nuclei"] },
      ],
    });
    const result = renderToText(renderSkillsTab(runtime, props({ catalog: load })));
    assert.match(result.text, /recon/);
    assert.match(result.text, /scan/);
    assert.match(result.text, /不可用 1/);
    assert.match(result.text, /⚠ 缺 nuclei/);
  });
});
