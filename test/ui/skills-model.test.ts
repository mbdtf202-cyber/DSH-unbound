/**
 * 技能库模型测试。
 *
 * 重点锁住三个易错点：
 * 1. **过滤器叠加**（`pluginOnly` + `brokenOnly` 是 AND，且都仅限红队）
 * 2. **未知算缺口**（`brokenOnly` 把 unknown 也算进来）
 * 3. **搜索是三字段拼接**（只搜 name 会漏「按描述找」）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SKILL_FILTER,
  MAX_DIR_CHIPS,
  availabilityLabel,
  availabilityTitle,
  catalogError,
  catalogLoadOf,
  catalogOf,
  detailOf,
  filterSkills,
  gapCount,
  groupSkills,
  matchesQuery,
  needsRestart,
  problemLine,
  showsBrokenFilter,
  showsProblemLine,
  skillItemOf,
  skillKeyOf,
  skillSubtitle,
  toggleActive,
  visibleDirs,
  type SkillItem,
} from "../../src/redteam/client/skills-model.js";

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

describe("skillItemOf — 归一", () => {
  it("读全部字段", () => {
    const item = skillItemOf({
      name: "recon",
      description: "d",
      whenToUse: "w",
      provider: "p",
      source: "s",
      dir: "/x",
      modelInvocable: false,
      userInvocable: false,
      fromPlugin: true,
      library: "official",
      availability: "broken",
      problems: ["缺 nmap"],
      needs_user: ["FOFA_KEY"],
    });
    assert.equal(item.name, "recon");
    assert.equal(item.modelInvocable, false);
    assert.equal(item.library, "official");
    assert.equal(item.availability, "broken");
    assert.deepEqual(item.problems, ["缺 nmap"]);
    assert.deepEqual(item.needsUser, ["FOFA_KEY"]);
  });

  it("**modelInvocable 缺省为 true**（原实现 `!== false` 语义）", () => {
    assert.equal(skillItemOf({ name: "x" }).modelInvocable, true);
  });

  it("modelInvocable 显式 false 才为 false", () => {
    assert.equal(skillItemOf({ name: "x", modelInvocable: false }).modelInvocable, false);
  });

  it("whenToUse 支持 snake_case 与 camelCase 两种写法", () => {
    assert.equal(skillItemOf({ when_to_use: "a" }).whenToUse, "a");
    assert.equal(skillItemOf({ whenToUse: "b" }).whenToUse, "b");
  });

  it("**library 非法值归一为 redteam**", () => {
    assert.equal(skillItemOf({ library: "third-party" }).library, "redteam");
    assert.equal(skillItemOf({}).library, "redteam");
  });

  it("**availability 非法值归一为 unknown**（比猜成 available 安全）", () => {
    assert.equal(skillItemOf({ availability: "great" }).availability, "unknown");
    assert.equal(skillItemOf({}).availability, "unknown");
  });

  it("availability 的合法值原样保留", () => {
    for (const value of ["available", "broken", "unknown", "listed"] as const) {
      assert.equal(skillItemOf({ availability: value }).availability, value);
    }
  });

  it("dir 非字符串给 null", () => {
    assert.equal(skillItemOf({ dir: 42 }).dir, null);
    assert.equal(skillItemOf({}).dir, null);
  });

  it("problems 里的非字符串项被过滤", () => {
    assert.deepEqual(skillItemOf({ problems: ["a", 1, null, "b"] }).problems, ["a", "b"]);
  });

  it("problems 非数组给空数组", () => {
    assert.deepEqual(skillItemOf({ problems: "x" }).problems, []);
  });

  it("fromPlugin 必须是布尔 true", () => {
    assert.equal(skillItemOf({ fromPlugin: "true" }).fromPlugin, false);
    assert.equal(skillItemOf({ fromPlugin: true }).fromPlugin, true);
  });
});

describe("catalogOf", () => {
  it("解析 items 与 meta", () => {
    const parsed = catalogOf({
      ok: true,
      items: [{ name: "a" }, { name: "b", library: "official" }],
      byDir: [{ key: "/x", n: 2 }],
      bySource: [{ key: "plugin", n: 2 }],
      note: "说明",
    });
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.meta.total, 2);
    assert.equal(parsed.meta.note, "说明");
    assert.deepEqual(parsed.meta.byDir, [{ key: "/x", n: 2 }]);
  });

  it("**无名技能被过滤**（无法渲染也无法读取）", () => {
    const parsed = catalogOf({ items: [{ name: "" }, { description: "无名字" }, { name: "ok" }] });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0]?.name, "ok");
  });

  it("fromPlugin 计数来自 items", () => {
    const parsed = catalogOf({
      items: [{ name: "a", fromPlugin: true }, { name: "b", fromPlugin: false }],
    });
    assert.equal(parsed.meta.fromPlugin, 1);
  });

  it("availability 缺失时 summary 为 null", () => {
    assert.equal(catalogOf({ items: [] }).meta.availability, null);
  });

  it("availability.summary 解析为三个计数", () => {
    const parsed = catalogOf({
      availability: { summary: { available: 5, broken: 2, unknown: 1 } },
    });
    assert.deepEqual(parsed.meta.availability, { available: 5, broken: 2, unknown: 1 });
  });

  it("**计数字段非数字时按 0**（不显示 NaN）", () => {
    const parsed = catalogOf({ availability: { summary: { available: "abc", broken: 2 } } });
    assert.equal(parsed.meta.availability?.available, 0);
    assert.equal(parsed.meta.availability?.broken, 2);
  });

  it("负计数按 0", () => {
    assert.equal(catalogOf({ availability: { summary: { available: -3 } } }).meta.availability?.available, 0);
  });

  it("checked_at 解析为数字", () => {
    assert.equal(catalogOf({ availability: { checked_at: 1700000000000 } }).meta.checkedAt, 1700000000000);
  });

  it("checked_at 缺失给 null", () => {
    assert.equal(catalogOf({ availability: {} }).meta.checkedAt, null);
  });

  it("cached 必须是布尔 true", () => {
    assert.equal(catalogOf({ availability: { cached: true } }).meta.cached, true);
    assert.equal(catalogOf({ availability: { cached: "yes" } }).meta.cached, false);
  });

  it("broken 列表解析", () => {
    const parsed = catalogOf({
      availability: { broken: [{ name: "x", problems: ["缺 key"], needs_user: ["K"] }] },
    });
    assert.equal(parsed.meta.broken.length, 1);
    assert.deepEqual(parsed.meta.broken[0]?.needsUser, ["K"]);
  });

  it("空响应不抛", () => {
    assert.doesNotThrow(() => catalogOf(null));
    assert.doesNotThrow(() => catalogOf("x"));
    assert.deepEqual(catalogOf(null).items, []);
  });

  it("byDir 里 key 为空的项被过滤", () => {
    assert.deepEqual(catalogOf({ byDir: [{ key: "", n: 1 }, { key: "/x", n: 2 }] }).meta.byDir, [{ key: "/x", n: 2 }]);
  });
});

describe("matchesQuery — 三字段拼接", () => {
  const item = skill({ name: "recon", description: "信息收集与测绘", whenToUse: "项目开始时" });

  it("空搜索词命中一切", () => {
    assert.equal(matchesQuery(item, ""), true);
  });

  it("**按名字搜到**", () => {
    assert.equal(matchesQuery(item, "recon"), true);
  });

  it("**按描述搜到**（只搜 name 会漏掉这个主用例）", () => {
    assert.equal(matchesQuery(item, "测绘"), true);
  });

  it("**按 whenToUse 搜到**", () => {
    assert.equal(matchesQuery(item, "项目开始"), true);
  });

  it("大小写不敏感", () => {
    assert.equal(matchesQuery(skill({ name: "Recon" }), "RECON"), true);
  });

  it("都不匹配时 false", () => {
    assert.equal(matchesQuery(item, "zzz"), false);
  });

  it("搜索词有首尾空白时由 filterSkills 去空白（matchesQuery 本身不去）", () => {
    // 直接调用 matchesQuery 不去空白；filterSkills 会先 trim。
    assert.equal(matchesQuery(item, " recon "), false);
  });
});

describe("filterSkills — 条件叠加", () => {
  const redteamPlugin = skill({ name: "a", library: "redteam", fromPlugin: true, availability: "available" });
  const redteamOther = skill({ name: "b", library: "redteam", fromPlugin: false, availability: "available" });
  const redteamBroken = skill({ name: "c", library: "redteam", fromPlugin: true, availability: "broken" });
  const redteamUnknown = skill({ name: "d", library: "redteam", fromPlugin: true, availability: "unknown" });
  const official = skill({ name: "e", library: "official", fromPlugin: false, availability: "listed" });
  const all = [redteamPlugin, redteamOther, redteamBroken, redteamUnknown, official];

  it("默认过滤器返回全部", () => {
    assert.deepEqual(filterSkills(all, DEFAULT_SKILL_FILTER).map((item) => item.name), ["a", "b", "c", "d", "e"]);
  });

  it("**搜索词去首尾空白**", () => {
    assert.deepEqual(filterSkills(all, { ...DEFAULT_SKILL_FILTER, query: "  a  " }).map((item) => item.name), ["a"]);
  });

  it("pluginOnly 只留本插件自带", () => {
    assert.deepEqual(
      filterSkills(all, { ...DEFAULT_SKILL_FILTER, pluginOnly: true }).map((item) => item.name),
      ["a", "c", "d"],
    );
  });

  it("**brokenOnly 把 unknown 也算缺口**", () => {
    assert.deepEqual(
      filterSkills(all, { ...DEFAULT_SKILL_FILTER, brokenOnly: true }).map((item) => item.name),
      ["c", "d"],
    );
  });

  it("**brokenOnly 不含官方**（官方不做检查，标「不可用」是错的）", () => {
    const result = filterSkills(all, { ...DEFAULT_SKILL_FILTER, brokenOnly: true });
    assert.equal(result.some((item) => item.library === "official"), false);
  });

  it("**两个过滤器叠加是 AND**", () => {
    // pluginOnly 给出 a/c/d；brokenOnly 给出 c/d；交集 c/d。
    const result = filterSkills(all, { query: "", pluginOnly: true, brokenOnly: true });
    assert.deepEqual(result.map((item) => item.name), ["c", "d"]);
  });

  it("搜索 + 过滤器叠加", () => {
    const result = filterSkills(all, { query: "c", pluginOnly: true, brokenOnly: false });
    assert.deepEqual(result.map((item) => item.name), ["c"]);
  });

  it("过滤后顺序保持不变", () => {
    assert.deepEqual(
      filterSkills(all, { ...DEFAULT_SKILL_FILTER, pluginOnly: true }).map((item) => item.name),
      ["a", "c", "d"],
    );
  });

  it("空列表返回空", () => {
    assert.deepEqual(filterSkills([], DEFAULT_SKILL_FILTER), []);
  });
});

describe("groupSkills", () => {
  it("按库归属分组", () => {
    const groups = groupSkills([
      skill({ name: "a", library: "official" }),
      skill({ name: "b", library: "redteam" }),
      skill({ name: "c", library: "official" }),
    ]);
    assert.deepEqual(groups.redteam.map((item) => item.name), ["b"]);
    assert.deepEqual(groups.official.map((item) => item.name), ["a", "c"]);
  });

  it("空输入给两个空组", () => {
    const groups = groupSkills([]);
    assert.deepEqual(groups.redteam, []);
    assert.deepEqual(groups.official, []);
  });
});

describe("skillKeyOf / toggleActive", () => {
  it("键是 library:name", () => {
    assert.equal(skillKeyOf(skill({ name: "x", library: "official" })), "official:x");
    assert.equal(skillKeyOf(skill({ name: "y", library: "redteam" })), "redteam:y");
  });

  it("**同名不同库的键不同**（防止点官方技能时折叠了红队技能）", () => {
    assert.notEqual(
      skillKeyOf(skill({ name: "same", library: "redteam" })),
      skillKeyOf(skill({ name: "same", library: "official" })),
    );
  });

  it("点新技能 → 展开成新键", () => {
    assert.equal(toggleActive(null, skill({ name: "a" })), "redteam:a");
  });

  it("点同一条 → 关闭（null）", () => {
    assert.equal(toggleActive("redteam:a", skill({ name: "a" })), null);
  });

  it("点另一条 → 切换", () => {
    assert.equal(toggleActive("redteam:a", skill({ name: "b" })), "redteam:b");
  });
});

describe("visibleDirs / gapCount / showsBrokenFilter", () => {
  it("**最多显示 6 个目录聚合**", () => {
    const meta = catalogOf({
      byDir: Array.from({ length: 10 }, (_, index) => ({ key: "/d" + index, n: 1 })),
    }).meta;
    assert.equal(visibleDirs(meta).length, MAX_DIR_CHIPS);
  });

  it("过滤掉计数为 0 的目录", () => {
    const meta = catalogOf({ byDir: [{ key: "/a", n: 0 }, { key: "/b", n: 3 }] }).meta;
    assert.deepEqual(visibleDirs(meta).map((entry) => entry.key), ["/b"]);
  });

  it("gapCount 是 broken + unknown", () => {
    assert.equal(gapCount({ available: 5, broken: 2, unknown: 1 }), 3);
  });

  it("summary 为 null 时 gapCount 是 0", () => {
    assert.equal(gapCount(null), 0);
  });

  it("**有缺口时才显示「只看不可用」**", () => {
    assert.equal(showsBrokenFilter({ available: 3, broken: 0, unknown: 0 }), false);
    assert.equal(showsBrokenFilter({ available: 3, broken: 1, unknown: 0 }), true);
    assert.equal(showsBrokenFilter({ available: 3, broken: 0, unknown: 2 }), true);
    assert.equal(showsBrokenFilter(null), false);
  });
});

describe("needsRestart", () => {
  it("错误含 'unknown op' 时提示需重启/升级", () => {
    assert.equal(needsRestart("unknown op: skillCatalog"), true);
  });

  it("其它错误不提示", () => {
    assert.equal(needsRestart("读取失败"), false);
  });

  it("非字符串不提示", () => {
    assert.equal(needsRestart(null), false);
    assert.equal(needsRestart(new Error("unknown op")), false);
  });
});

describe("availabilityLabel / availabilityTitle", () => {
  it("available → 可用", () => {
    assert.equal(availabilityLabel("available"), "可用");
  });

  it("broken → 不可用", () => {
    assert.equal(availabilityLabel("broken"), "不可用");
  });

  it("unknown → 未知", () => {
    assert.equal(availabilityLabel("unknown"), "未知");
  });

  it("listed → 已列出（官方技能不检查）", () => {
    assert.equal(availabilityLabel("listed"), "已列出");
  });

  it("available 的 title 说明「不阻止调用」", () => {
    assert.match(availabilityTitle(skill({ availability: "available" })), /不阻止调用/);
  });

  it("broken 的 title 列出 problems", () => {
    assert.equal(
      availabilityTitle(skill({ availability: "broken", problems: ["缺 nmap", "缺 FOFA_KEY"] })),
      "缺 nmap\n缺 FOFA_KEY",
    );
  });

  it("broken 但无 problems 时 title 是「未知」", () => {
    assert.equal(availabilityTitle(skill({ availability: "broken", problems: [] })), "未知");
  });
});

describe("skillSubtitle / showsProblemLine / problemLine", () => {
  it("副标题拼接来源 / 本插件 / provider / 目录", () => {
    const subtitle = skillSubtitle(skill({ source: "plugin", fromPlugin: true, provider: "p", dir: "/d" }));
    assert.equal(subtitle, "来源 plugin · 本插件自带 · p · /d");
  });

  it("**跳过空字段**（不出现多余的分隔符）", () => {
    const subtitle = skillSubtitle(skill({ source: "", fromPlugin: false, provider: "", dir: null }));
    assert.equal(subtitle, "");
  });

  it("dir 为 null 时不拼", () => {
    const subtitle = skillSubtitle(skill({ dir: null }));
    assert.doesNotMatch(subtitle, /null/);
  });

  it("有问题 + 不可用 + 非官方 → 显示提示行", () => {
    assert.equal(showsProblemLine(skill({ problems: ["x"], availability: "broken", library: "redteam" })), true);
  });

  it("**可用的技能不显示提示行**（缺工具不阻止调用）", () => {
    assert.equal(showsProblemLine(skill({ problems: ["x"], availability: "available" })), false);
  });

  it("**官方技能不显示提示行**（避免让人以为官方技能坏了）", () => {
    assert.equal(
      showsProblemLine(skill({ problems: ["x"], availability: "broken", library: "official" })),
      false,
    );
  });

  it("无问题不显示提示行", () => {
    assert.equal(showsProblemLine(skill({ problems: [], availability: "broken" })), false);
  });

  it("problemLine 截断到 60 字符", () => {
    const long = "x".repeat(200);
    const line = problemLine(skill({ problems: [long] }));
    // "⚠ " 占 2 字符 + 60 = 62
    assert.equal(line.length, 62);
  });

  it("problemLine 无问题时给空串", () => {
    assert.equal(problemLine(skill({ problems: [] })), "");
  });
});

describe("detailOf", () => {
  it("解析详情", () => {
    const detail = detailOf({
      ok: true,
      name: "recon",
      description: "d",
      whenToUse: "w",
      provider: "p",
      source: "s",
      path: "/skills/recon.md",
      content: "# 正文",
    });
    assert.equal(detail?.name, "recon");
    assert.equal(detail?.content, "# 正文");
    assert.equal(detail?.path, "/skills/recon.md");
  });

  it("ok:false 给 null", () => {
    assert.equal(detailOf({ ok: false, error: "x" }), null);
  });

  it("**无名详情给 null**（无法确定展开的是哪条）", () => {
    assert.equal(detailOf({ ok: true, content: "x" }), null);
  });

  it("path 缺失给 null", () => {
    assert.equal(detailOf({ ok: true, name: "a" })?.path, null);
  });

  it("content 缺失给空串", () => {
    assert.equal(detailOf({ ok: true, name: "a" })?.content, "");
  });
});

describe("catalogError / catalogLoadOf", () => {
  it("成功响应无错误", () => {
    assert.equal(catalogError({ ok: true }), null);
  });

  it("失败响应用其 error", () => {
    assert.equal(catalogError({ ok: false, error: "读不到" }), "读不到");
  });

  it("null 响应用兜底", () => {
    assert.equal(catalogError(null), "读取失败");
  });

  it("catalogLoadOf 成功时带回 items 与 meta", () => {
    const load = catalogLoadOf({ ok: true, items: [{ name: "a" }] });
    assert.equal(load.ok, true);
    assert.equal(load.items.length, 1);
    assert.notEqual(load.meta, null);
    assert.equal(load.error, null);
  });

  it("catalogLoadOf 失败时给空 items", () => {
    const load = catalogLoadOf({ ok: false, error: "unknown op: skillCatalog" });
    assert.equal(load.ok, false);
    assert.deepEqual(load.items, []);
    assert.equal(load.meta, null);
  });

  it("**失败时算出 restartHint**", () => {
    const load = catalogLoadOf({ ok: false, error: "unknown op: skillCatalog" });
    assert.equal(load.restartHint, true);
  });

  it("普通失败 restartHint 为 false", () => {
    assert.equal(catalogLoadOf({ ok: false, error: "磁盘错误" }).restartHint, false);
  });
});
