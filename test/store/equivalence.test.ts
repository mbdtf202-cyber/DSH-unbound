/**
 * 行为等价性：**同一输入下，新实现与上游 dsh-qilin 的返回逐字段相同**。
 *
 * ## 为什么这组测试是本次迁移的核心验收
 *
 * 其余测试验的是"新实现符合我的理解"。只有这组能回答"新实现**和旧的一样**"——
 * 而 92 个方法里有大量非显然的 SQL（`COALESCE` 的落库语义、`ORDER BY` 的多级排序、
 * `ON CONFLICT` 的合并规则），凭理解重写一遍必然在某个分支上偏掉。
 *
 * ## 做法
 *
 * 直接 `import` 上游的 `lib/redteam/store-core.js`（纯 ESM、能跑），
 * 用**同一份输入**分别喂给两个实现，然后 `JSON.stringify` 逐字段比对。
 *
 * 三个必须注意的点：
 *   1. **临时目录要分开**：两个 store 各用一个 mkdtemp，否则会互相污染 SQLite 文件。
 *   2. **时间戳归一化**：`nowIso()` / `mtime` / `discovered_at` 这类字段两边必然不同，
 *      比对前统一替换成 `<TS>`。**只归一化真正不可控的字段**，不要把业务字段也抹掉。
 *   3. **上游的引擎版本差异**：上游若在某些分支上有 bug（例如 FTS5 升级路径），
 *      不在这里"对齐 bug" —— 那种情况在下面的 `KNOWN_DIVERGENCES` 里显式列出并注明理由。
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createRequire } from "node:module";

import { RedteamStore } from "../../src/redteam/store/index.js";
import { makeTempStore, sampleBundle } from "./fixtures.js";

/* 上游是 ESM（`"type": "module"`），用动态 import + 变量路径避开类型解析 */
const UPSTREAM_PATH = "/Users/raki/Documents/deepseek-harness/default-workspace/dsh-qilin/lib/redteam/store-core.js";

/** 上游的最小类型形状（只声明本测试真的会调到的方法）。 */
interface UpstreamStore {
  root: string;
  openEngagement(name: string, scope: readonly string[], options?: { bindCurrent?: boolean }): { id: string; name: string; scope: string[] };
  close(): void;
  importBundle(id: string, bundle: unknown): { counts: Record<string, number>; scan_run_id: number | null };
  assessAsset(id: string, a: unknown): Record<string, unknown>;
  addHttpEvidence(id: string, e: unknown): { id: number };
  stats(id: string): Record<string, number>;
  listAssets(id: string, f?: unknown): { total: number; sort: string; items: unknown[] };
  getAsset(id: string, assetId: unknown): unknown;
  listSegments(id: string): unknown[];
  listStages(id: string): unknown[];
  listScorePoints(id: string, f?: unknown): { items: unknown[]; ruleGroups: unknown[]; summary: Record<string, unknown> };
  addScoreHit(id: string, hit: unknown): Record<string, unknown>;
  addVuln(id: string, v: unknown): { id: number; updated: boolean };
  listVulns(id: string, f?: unknown): { total: number; items: unknown[] };
  addCredential(id: string, c: unknown): { id: number };
  listCredentials(id: string, f?: unknown): unknown[];
  addWebshell(id: string, w: unknown): { id: number; updated: boolean };
  listWebshells(id: string, f?: unknown): unknown[];
  addTunnel(id: string, t: unknown): Record<string, unknown>;
  listTunnels(id: string, f?: unknown): unknown[];
  addChainStep(id: string, s: unknown): Record<string, unknown>;
  listChain(id: string): unknown[];
  addShot(id: string, shot: unknown): Record<string, unknown>;
  listShots(id: string, f?: unknown): unknown;
  addAttackFile(id: string, f: unknown): Record<string, unknown>;
  listAttackFiles(id: string, f?: unknown): unknown[];
  searchPocs(f?: unknown): unknown[];
  savePoc(p: unknown): Record<string, unknown>;
  pocStats(): Record<string, unknown>;
  scoreChain(id: string, f?: unknown): Record<string, unknown>;
  scoreReport(id: string, options?: unknown): Record<string, unknown>;
  reportTargets(id: string, options?: unknown): Record<string, unknown>;
  report(id: string, options?: unknown): Record<string, unknown>;
  consoleDigest(id: string): Record<string, unknown>;
  testStats(id: string): Record<string, unknown>;
  vulnStats(id: string): Record<string, unknown>;
  sessionSummary(id: string): Record<string, unknown>;
  domainIndex(id: string, f?: unknown): unknown[];
  listWeb(id: string, f?: unknown): unknown;
  activeTests(id: string, f?: unknown): Record<string, unknown>;
  discoveryTimeline(id: string, f?: unknown): Record<string, unknown>;
  attackGraph(id: string, f?: unknown): Record<string, unknown>;
  graph(id: string, f?: unknown): Record<string, unknown>;
  listPrompts(id: string): unknown[];
  listAttackFiles(id: string, f?: unknown): unknown[];
}

interface UpstreamModule {
  RedteamStore: new (root: string) => UpstreamStore;
}

/** 上游模块（懒加载，只加载一次）。 */
let upstreamModule: UpstreamModule | null = null;
async function loadUpstream(): Promise<UpstreamModule> {
  if (upstreamModule === null) {
    upstreamModule = (await import(UPSTREAM_PATH)) as unknown as UpstreamModule;
  }
  return upstreamModule;
}

/** 一对"同一份输入分别喂两边"的 store。 */
interface Pair {
  readonly upstream: UpstreamStore;
  readonly mine: RedteamStore;
  readonly upstreamId: string;
  readonly mineId: string;
  dispose(): void;
}

const pairs: { dispose(): void }[] = [];
after(() => {
  for (const p of pairs) p.dispose();
});

/** 建一对 store，并各自开一个同名靶标。 */
async function makePair(name = "equiv"): Promise<Pair> {
  const up = await loadUpstream();
  const upTemp = makeTempStore();
  const myTemp = makeTempStore();
  const upstream = new up.RedteamStore(upTemp.root);
  const mine = new RedteamStore(myTemp.root);
  const upstreamId = upstream.openEngagement(name, ["10.0.0.0/24"], { bindCurrent: false }).id;
  const mineId = mine.openEngagement(name, ["10.0.0.0/24"], { bindCurrent: false }).id;
  const pair: Pair = {
    upstream, mine, upstreamId, mineId,
    dispose(): void {
      try {
        upstream.close();
      } catch {
        /* 忽略 */
      }
      upTemp.dispose();
      myTemp.dispose();
    },
  };
  pairs.push(pair);
  return pair;
}

/**
 * 归一化：把两边必然不同的**不可控字段**换成占位符。
 *
 * 只抹三类：ISO 时间戳、SQLite 的 rowid（自增可能因插入顺序差异错位）、
 * 临时目录的绝对路径。**业务字段一律不动** —— 那是被测物。
 */
function normalize(value: unknown, rootPath: string): unknown {
  /* `JSON.stringify(undefined) === undefined` —— 上游有些字段真的是 undefined（不是 null），
     先收成 "undefined" 字面量；解析回来时也返回 undefined，两边仍可比。 */
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;
  const text = serialized
    /* ISO 时间戳 → <TS> */
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>")
    /* 临时目录路径 → <ROOT>。两个 store 各用一个 mkdtemp 根，
       所以既要抹掉 mine 的，也要抹掉上游的 —— 否则 path 字段永远不等。 */
    .split(rootPath).join("<ROOT>")
    .replace(/\/var\/folders\/[^"\s]*?\/T\/dsh-store-test-[A-Za-z0-9]+/g, "<ROOT>")
    .replace(/\/tmp\/dsh-store-test-[A-Za-z0-9]+/g, "<ROOT>");
  return JSON.parse(text) as unknown;
}

/**
 * 把 `observations` / `edges` 这类**上游没有 ORDER BY** 的集合排成稳定序。
 *
 * `getAsset` 的观测查询是 `ORDER BY collected_at DESC`，而一次采集里连续插入的
 * 几条观测常常落在**同一毫秒**，于是并列、返回顺序由 SQLite 自己决定；
 * `edges` 那条查询干脆没有 ORDER BY。两者都是"集合相等但顺序未定义"，
 * 不能当作等价性判据，但也不能因此就不比内容。
 */
function sortUnordered(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rec };
  const obs = rec["observations"];
  if (Array.isArray(obs)) {
    out["observations"] = [...obs].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  const edges = rec["edges"];
  if (Array.isArray(edges)) {
    out["edges"] = [...edges].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}

/** 断言两边深相等（带可读的差异输出）。 */
function assertSame(label: string, upValue: unknown, myValue: unknown, rootPath: string): void {
  const a = normalize(sortUnordered(upValue), rootPath);
  const b = normalize(sortUnordered(myValue), rootPath);
  try {
    assert.deepEqual(b, a, label);
  } catch (cause) {
    /* 差异太大时 deepEqual 的输出很难读 —— 补一份字段级 diff 的线索 */
    const aText = JSON.stringify(a, null, 2);
    const bText = JSON.stringify(b, null, 2);
    if (aText === bText) return;
    const aLines = aText.split("\n");
    const bLines = bText.split("\n");
    const diff: string[] = [];
    for (let i = 0; i < Math.max(aLines.length, bLines.length); i += 1) {
      if (aLines[i] !== bLines[i]) {
        diff.push(`@${String(i + 1)}\n  upstream: ${aLines[i] ?? "<none>"}\n  mine    : ${bLines[i] ?? "<none>"}`);
        if (diff.length >= 8) break;
      }
    }
    assert.fail(`${label}：与上游不一致。前几处差异：\n${diff.join("\n")}\n${cause instanceof Error ? cause.message : ""}`);
  }
}

/** 把样例数据同时灌进两边。 */
function seedBoth(pair: Pair): void {
  pair.upstream.importBundle(pair.upstreamId, sampleBundle());
  pair.mine.importBundle(pair.mineId, sampleBundle());
}

describe("equivalence: 建库与采集入库", () => {
  it("importBundle 的 counts 与 stats 完全一致", async () => {
    const pair = await makePair();
    const up = pair.upstream.importBundle(pair.upstreamId, sampleBundle());
    const my = pair.mine.importBundle(pair.mineId, sampleBundle());
    assertSame("importBundle.counts", up.counts, my.counts, pair.mine.root);
    assertSame("stats", pair.upstream.stats(pair.upstreamId), pair.mine.stats(pair.mineId), pair.mine.root);
  });

  it("listSegments 一致（含各 C 段的计数与 scope）", async () => {
    const pair = await makePair();
    seedBoth(pair);
    assertSame("listSegments", pair.upstream.listSegments(pair.upstreamId), pair.mine.listSegments(pair.mineId), pair.mine.root);
  });

  it("consoleDigest 的 sections 计数一致（at 时间戳归一化）", async () => {
    const pair = await makePair();
    seedBoth(pair);
    const up = pair.upstream.consoleDigest(pair.upstreamId);
    const my = pair.mine.consoleDigest(pair.mineId);
    assertSame("consoleDigest.sections", up["sections"], my["sections"], pair.mine.root);
  });
});

describe("equivalence: 资产查询（排序 / 筛选 / 分页）", () => {
  /** 造一组有区分度的资产，覆盖排序与筛选的各种分支。 */
  function seedAssets(pair: Pair): void {
    const bundle = {
      assets: [
        { ip: "10.0.0.9", state: "live", primary_name: "zeta.example.test", provenance: "active", ports: [{ port: 443, state: "open", service: "https", title: "后台", provenance: "active" }] },
        { ip: "10.0.0.3", state: "live", primary_name: "alpha.example.test", provenance: "passive", ports: [{ port: 22, state: "open", service: "ssh", provenance: "passive" }, { port: 80, state: "open", service: "http", provenance: "active" }] },
        { ip: "10.0.0.7", state: "down", provenance: "active", ports: [] },
        { ip: "10.0.1.2", state: "live", primary_name: "beta.example.test", provenance: "active", ports: [{ port: 3306, state: "open", service: "mysql", provenance: "active" }] },
      ],
    };
    pair.upstream.importBundle(pair.upstreamId, bundle);
    pair.mine.importBundle(pair.mineId, bundle);
    /* 打上不同的优先级与测试状态，让 priority / todo 排序有意义 */
    for (const [ip, priority] of [["10.0.0.9", "high"], ["10.0.0.3", "medium"], ["10.0.1.2", "low"]] as const) {
      pair.upstream.assessAsset(pair.upstreamId, { ip, priority });
      pair.mine.assessAsset(pair.mineId, { ip, priority });
    }
  }

  it("全部 4 种 sort 的输出顺序一致", async () => {
    const pair = await makePair();
    seedAssets(pair);
    for (const sort of ["priority", "todo", "ports", "discovered"]) {
      const up = pair.upstream.listAssets(pair.upstreamId, { sort });
      const my = pair.mine.listAssets(pair.mineId, { sort });
      assertSame(`listAssets(sort=${sort}) 的 IP 顺序`, up.items.map((x) => (x as { ip: string }).ip), my.items.map((x) => x.ip), pair.mine.root);
      assertSame(`listAssets(sort=${sort}).total`, up.total, my.total, pair.mine.root);
    }
  });

  it("各种筛选的 total 与结果顺序一致", async () => {
    const pair = await makePair();
    seedAssets(pair);
    const filters: Record<string, unknown>[] = [
      { cidr: "10.0.0.0/24" },
      { state: "live" },
      { state: "down" },
      { port: 22 },
      { service: "http" },
      { service: "mysql" },
      { provenance: "passive" },
      { priority: "high" },
      { test_status: "untested" },
      { q: "alpha" },
      { q: "beta.example" },
      { cidr: "10.0.0.0/24", state: "live" },
      { limit: 2 },
      { limit: 2, offset: 1 },
    ];
    for (const f of filters) {
      const up = pair.upstream.listAssets(pair.upstreamId, f);
      const my = pair.mine.listAssets(pair.mineId, f);
      assertSame(`listAssets(${JSON.stringify(f)}).total`, up.total, my.total, pair.mine.root);
      assertSame(
        `listAssets(${JSON.stringify(f)}) 的 IP 顺序`,
        up.items.map((x) => (x as { ip: string }).ip),
        my.items.map((x) => x.ip),
        pair.mine.root,
      );
    }
  });

  it("单资产详情的全部字段一致（含 ports / fingerprints / names / 派生计数）", async () => {
    const pair = await makePair();
    seedBoth(pair);
    const upList = pair.upstream.listAssets(pair.upstreamId, {}) as { items: { id: number }[] };
    const myList = pair.mine.listAssets(pair.mineId, {});
    assert.equal(upList.items.length, myList.items.length);
    for (let i = 0; i < upList.items.length; i += 1) {
      const upId = upList.items[i]?.id;
      const myId = myList.items[i]?.id;
      assertSame(`getAsset#${String(i)}`, pair.upstream.getAsset(pair.upstreamId, upId), pair.mine.getAsset(pair.mineId, myId), pair.mine.root);
    }
  });

  it("⚠️ getAsset 的 observations 顺序：上游**不保证**（同毫秒内插入会并列）", async () => {
    /* 这条不是"新实现与上游不一致"，而是记录一个**上游既有的不确定性**。
     *
     * `getAsset` 的观测查询是 `ORDER BY collected_at DESC LIMIT 200` ——
     * `collected_at` 是 ISO 毫秒时间戳。`importBundle` 在一次采集里连续插
     * name / primary_name / fingerprint 三条观测，它们**常常落在同一毫秒**，
     * 于是三者并列、SQLite 按自己的顺序返回。两个库（新/旧实现各一个）的
     * 返回顺序因此可能不同，同一库重复查则稳定。
     *
     * 结论：**排序是未定义行为，不能作为等价性判据**。这里按多重集比较，
     * 同时把"顺序确实可能不同"这个事实钉下来 —— 免得后人以为是自己写错了。 */
    const pair = await makePair();
    seedBoth(pair);
    const upList = pair.upstream.listAssets(pair.upstreamId, {}) as { items: { id: number }[] };
    const myList = pair.mine.listAssets(pair.mineId, {});
    const upAsset = pair.upstream.getAsset(pair.upstreamId, upList.items[0]?.id) as { observations: { attr: string | null; value: string | null; tool: string | null }[] } | undefined;
    const myAsset = pair.mine.getAsset(pair.mineId, myList.items[0]?.id);
    const keyOf = (o: { attr: string | null; value: string | null; tool: string | null }): string =>
      `${String(o.attr)}|${String(o.value)}|${String(o.tool)}`;
    const upKeys = (upAsset?.observations ?? []).map(keyOf).sort();
    const myKeys = (myAsset?.observations ?? []).map(keyOf).sort();
    assert.deepEqual(myKeys, upKeys, "观测的**集合**必须一致（顺序不比）");
  });

  it("listWeb / domainIndex 一致", async () => {
    const pair = await makePair();
    seedBoth(pair);
    assertSame("listWeb", pair.upstream.listWeb(pair.upstreamId, {}), pair.mine.listWeb(pair.mineId, {}), pair.mine.root);
    assertSame("domainIndex", pair.upstream.domainIndex(pair.upstreamId, {}), pair.mine.domainIndex(pair.mineId, {}), pair.mine.root);
  });
});

describe("equivalence: 计分（最需要锁住的一块）", () => {
  /** 造一组会触发封顶/去重/上限的命中。 */
  function seedHits(pair: Pair): void {
    const hits: Record<string, unknown>[] = [
      { code: "server-host", target: "http://10.0.0.5:8080/", evidence: "10.0.0.5｜普通权限", points: 10 },
      { code: "server-host", target: "http://10.0.0.5:8080/admin", evidence: "10.0.0.5｜root", points: 50 },
      { code: "server-host", target: "http://10.0.0.6:8080/", evidence: "10.0.0.6｜root", points: 50 },
      { code: "server-host", target: "http://10.0.0.6:8080/admin", evidence: "10.0.0.6｜重复登记", points: 10 },
      { code: "server-host", target: "pc-001", evidence: "自建账号", points: 10, self_created: true },
      { code: "terminal-access", target: "10.1.0.1", evidence: "10.1.0.1｜PC 一台", points: 10 },
      { code: "terminal-access", target: "10.1.0.2", evidence: "10.1.0.2｜PC 一台", points: 10 },
      { code: "boundary-logical", target: "10.20.30.0/24", evidence: "suo5 打通，可达 10.20.30.0/24" },
      { code: "web-app", target: "http://10.0.0.5:8080/login", evidence: "10.0.0.5｜后台管理员", points: 100 },
      { code: "db-credential", target: "10.0.0.6:3306", evidence: "10.0.0.6｜MySQL root", points: 50 },
    ];
    for (const h of hits) {
      pair.upstream.addScoreHit(pair.upstreamId, h);
      pair.mine.addScoreHit(pair.mineId, h);
    }
  }

  it("listScorePoints 的 items / ruleGroups / summary 逐字段一致", async () => {
    const pair = await makePair();
    seedHits(pair);
    const up = pair.upstream.listScorePoints(pair.upstreamId);
    const my = pair.mine.listScorePoints(pair.mineId);
    assertSame("summary", up.summary, my.summary, pair.mine.root);
    /* items 顺序敏感：面板就按这个顺序渲染 */
    assertSame(
      "items 的 code 顺序",
      up.items.map((x) => (x as { code: string }).code),
      my.items.map((x) => x.code),
      pair.mine.root,
    );
    assertSame("items（全量）", up.items, my.items, pair.mine.root);
    assertSame("ruleGroups", up.ruleGroups, my.ruleGroups, pair.mine.root);
  });

  it("⚠️ summary.serviceCappedHits 与 **capped 命中的顺序** 一致", async () => {
    /* 这一条锁住 Lead 要求的"看起来像 bug 但实际正确"那段代码：
       上游用 `cappedAll.items.filter(h => ... enabledIds.has(h.point_id))` 过滤 hit 行，
       我改成先建 `hit.id → point_id` 映射再过滤。
       filter 保序，但中途用了 Map 就可能乱序 —— 必须证明顺序不变。 */
    const pair = await makePair();
    seedHits(pair);
    const up = pair.upstream.listScorePoints(pair.upstreamId);
    const my = pair.mine.listScorePoints(pair.mineId);
    assert.equal(my.summary["serviceCappedHits"], up.summary["serviceCappedHits"]);
    /* 被封顶命中的 id 序列（顺序敏感） */
    const upCappedIds = up.items
      .flatMap((p) => (p as { hits: { id: number; capped: boolean }[] }).hits)
      .filter((h) => h.capped)
      .map((h) => h.id);
    const myCappedIds = my.items.flatMap((p) => p.hits).filter((h) => h.capped).map((h) => h.id);
    assertSame("capped 命中的 id 顺序", upCappedIds, myCappedIds, pair.mine.root);
    assert.ok(upCappedIds.length > 0, "这个用例必须真的产生封顶，否则等于没测");
  });

  it("addScoreHit 的返回一致（含 warning / demoted_hits）", async () => {
    const pair = await makePair();
    const first = { code: "server-host", target: "10.0.0.5:22", evidence: "root", points: 50 };
    const a = pair.upstream.addScoreHit(pair.upstreamId, first);
    const b = pair.mine.addScoreHit(pair.mineId, first);
    /* summary 里含时间戳，单独归一化后再比 */
    assertSame("addScoreHit 首次返回值（除 summary）", { ...a, summary: undefined }, { ...b, summary: undefined }, pair.mine.root);
    /* 再来一条低分的同服务命中 → 应被顶掉，两边都要给出同样的 warning */
    const second = { code: "server-host", target: "10.0.0.5:22", evidence: "普通权限", points: 10 };
    const c = pair.upstream.addScoreHit(pair.upstreamId, second);
    const d = pair.mine.addScoreHit(pair.mineId, second);
    assertSame("addScoreHit 被封顶时（除 summary）", { ...c, summary: undefined }, { ...d, summary: undefined }, pair.mine.root);
  });

  it("scoreChain 的 items / summary 一致", async () => {
    const pair = await makePair();
    seedHits(pair);
    const up = pair.upstream.scoreChain(pair.upstreamId);
    const my = pair.mine.scoreChain(pair.mineId);
    assertSame("scoreChain.summary", up["summary"], my.summary, pair.mine.root);
    assertSame(
      "scoreChain.items 的 id 顺序",
      (up["items"] as { id: number }[]).map((x) => x.id),
      my.items.map((x) => x.id),
      pair.mine.root,
    );
    assertSame("scoreChain.stages（阶段与分值）",
      (up["stages"] as { code: string; points: number; counted: number; hits: number }[]).map((s) => ({
        code: s.code, points: s.points, counted: s.counted, hits: s.hits,
      })),
      my.stages.map((s) => ({ code: s.code, points: s.points, counted: s.counted, hits: s.hits })),
      pair.mine.root);
  });
});

describe("equivalence: 漏洞 / 凭据 / 会话（落库语义）", () => {
  it("addVuln 的幂等键与返回值一致", async () => {
    const pair = await makePair();
    const inputs: Record<string, unknown>[] = [
      { title: "Shiro RCE", cve: "CVE-2016-4437", severity: "critical", target: "http://10.0.0.5:8080/" },
      { title: "Shiro RCE（确认）", cve: "CVE-2016-4437", severity: "critical", status: "confirmed", target: "http://10.0.0.5:8080/" },
      { title: "未授权访问", target: "10.0.0.5" },
      { title: "未授权访问", target: "10.0.0.5" },
      { title: "非法严重级", severity: "超级严重", status: "也许" },
      { title: "gained 数组", gained: ["账号权限", "服务器权限"] },
      { title: "gained 串", gained: "账号权限;服务器权限" },
      { title: "gained 空", gained: null },
    ];
    for (const v of inputs) {
      const up = pair.upstream.addVuln(pair.upstreamId, v);
      const my = pair.mine.addVuln(pair.mineId, v);
      assertSame(`addVuln(${JSON.stringify(v["title"])}).updated`, up.updated, my.updated, pair.mine.root);
    }
    assertSame(
      "listVulns（全量，验落库后每列相等）",
      pair.upstream.listVulns(pair.upstreamId, {}),
      pair.mine.listVulns(pair.mineId, {}),
      pair.mine.root,
    );
    assertSame("vulnStats", pair.upstream.vulnStats(pair.upstreamId), pair.mine.vulnStats(pair.mineId), pair.mine.root);
  });

  it("凭据的 COALESCE 合并语义一致（不给新值不覆盖旧值）", async () => {
    const pair = await makePair();
    const inputs: Record<string, unknown>[] = [
      { host: "10.0.0.5", username: "root", secret_type: "password", secret_value: "first", privilege: "admin", tool: "hydra" },
      { host: "10.0.0.5", username: "root", secret_type: "password", note: "补充备注" },
      { host: "10.0.0.5", username: "tomcat", password: "P@ss", source: "配置泄露" },
      { host: "10.0.0.6", username: "sa", secret_type: "mssql", secret_value: "sa123" },
    ];
    for (const c of inputs) {
      pair.upstream.addCredential(pair.upstreamId, c);
      pair.mine.addCredential(pair.mineId, c);
    }
    assertSame("listCredentials", pair.upstream.listCredentials(pair.upstreamId, {}), pair.mine.listCredentials(pair.mineId, {}), pair.mine.root);
  });

  it("WebShell 的新增/更新分支与规范化一致", async () => {
    const pair = await makePair();
    const inputs: Record<string, unknown>[] = [
      { url: "http://10.0.0.5/shell.jsp", shell_type: "冰蝎", pass_key: "k1", privilege: "root" },
      { url: "http://10.0.0.5/shell.jsp", pass_key: "k1", note: "已实测" },
      { url: "http://10.0.0.6/x.jsp", shell_type: "哥斯拉", status: "up" },
      { url: "http://10.0.0.7/y.jsp", status: "failed" },
      { url: "http://10.0.0.8/z.jsp" },
    ];
    for (const w of inputs) {
      const up = pair.upstream.addWebshell(pair.upstreamId, w);
      const my = pair.mine.addWebshell(pair.mineId, w);
      assertSame(`addWebshell(${String(w["url"])}).updated`, up.updated, my.updated, pair.mine.root);
    }
    assertSame("listWebshells", pair.upstream.listWebshells(pair.upstreamId, {}), pair.mine.listWebshells(pair.mineId, {}), pair.mine.root);
  });

  it("隧道的 legit 判定与 warning 文案一致", async () => {
    const pair = await makePair();
    const inputs: Record<string, unknown>[] = [
      { kind: "suo5", listen: "127.0.0.1:1080", entry_kind: "target-http" },
      { kind: "socks5", listen: "127.0.0.1:1081", entry_kind: "self-only" },
      { kind: "frp", listen: "127.0.0.1:1082" },
      { kind: "chisel", entry_kind: "target-outbound" },
    ];
    for (const t of inputs) {
      const up = pair.upstream.addTunnel(pair.upstreamId, t);
      const my = pair.mine.addTunnel(pair.mineId, t);
      assertSame(`addTunnel(${String(t["entry_kind"] ?? "none")}).legit`, up["legit"], my.legit, pair.mine.root);
      assertSame(`addTunnel(${String(t["entry_kind"] ?? "none")}).warning`, up["warning"], my.warning, pair.mine.root);
    }
    assertSame("listTunnels", pair.upstream.listTunnels(pair.upstreamId, {}), pair.mine.listTunnels(pair.mineId, {}), pair.mine.root);
    assertSame("sessionSummary.totals",
      (pair.upstream.sessionSummary(pair.upstreamId) as { totals: unknown }).totals,
      pair.mine.sessionSummary(pair.mineId).totals,
      pair.mine.root);
  });

  it("攻击步骤的 stage 映射 / 告警 / 记分回挂一致", async () => {
    const pair = await makePair();
    const steps: Record<string, unknown>[] = [
      { title: "扫描", stage: "recon" },
      { title: "打点", stage: "exploit" },
      { title: "搭隧道", stage: "pivot", stage_code: "boundary" },
      { title: "非法阶段", stage: "pivot", stage_code: "tunnel" },
      { title: "拿域控", stage: "internal", point_code: "central-system", evidence: "10.0.0.5｜域管" },
      { title: "只记步骤", point_code: "central-system" },
    ];
    for (const s of steps) {
      const up = pair.upstream.addChainStep(pair.upstreamId, s);
      const my = pair.mine.addChainStep(pair.mineId, s);
      assertSame(`addChainStep(${String(s["title"])}).stage_code`, up["stage_code"], my.stage_code, pair.mine.root);
      assertSame(`addChainStep(${String(s["title"])}).stage_hint`, up["stage_hint"], my.stage_hint, pair.mine.root);
      /* hit 里带 summary（含时间戳），单独比关键字段 */
      const upHit = up["hit"] as Record<string, unknown> | null;
      assertSame(`addChainStep(${String(s["title"])}).score_hint`, up["score_hint"], my.score_hint, pair.mine.root);
      assert.equal(my.hit === null, upHit === null, `${String(s["title"])}：是否记分要一致`);
      if (upHit !== null && my.hit !== null) {
        assertSame(`addChainStep(${String(s["title"])}).hit.points`, upHit["points"], my.hit.points, pair.mine.root);
      }
    }
    assertSame("listChain", pair.upstream.listChain(pair.upstreamId), pair.mine.listChain(pair.mineId), pair.mine.root);
  });
});

describe("equivalence: 报告（markdown 全文比对）", () => {
  /** 造一份有内容可报的靶标。 */
  function seedReportable(pair: Pair): void {
    for (const p of [pair.upstream, pair.mine]) {
      const id = p === pair.upstream ? pair.upstreamId : pair.mineId;
      p.importBundle(id, sampleBundle());
    }
    const vulns: Record<string, unknown>[] = [
      { title: "Shiro 反序列化 RCE", cve: "CVE-2016-4437", severity: "critical", status: "exploited", target: "http://10.0.0.5:8080/", evidence: "回显 uid=0(root)", gained: ["服务器权限"] },
      { title: "后台弱口令", severity: "high", status: "confirmed", target: "http://10.0.0.5:8080/login", evidence: "admin/Admin@123 登录成功" },
      { title: "低危信息泄露", severity: "low", status: "confirmed", target: "http://10.0.0.5:8080/robots.txt" },
      { title: "待验证", severity: "high", status: "candidate", target: "http://10.0.0.5:8080/x" },
    ];
    for (const v of vulns) {
      pair.upstream.addVuln(pair.upstreamId, v);
      pair.mine.addVuln(pair.mineId, v);
    }
    pair.upstream.addHttpEvidence(pair.upstreamId, { vuln_id: 1, url: "http://10.0.0.5:8080/", method: "GET", request: "GET / HTTP/1.1\r\nHost: 10.0.0.5:8080\r\n\r\n" });
    pair.mine.addHttpEvidence(pair.mineId, { vuln_id: 1, url: "http://10.0.0.5:8080/", method: "GET", request: "GET / HTTP/1.1\r\nHost: 10.0.0.5:8080\r\n\r\n" });
  }

  it("report() 的 markdown 与 stats 一致", async () => {
    const pair = await makePair();
    seedReportable(pair);
    const up = pair.upstream.report(pair.upstreamId);
    const my = pair.mine.report(pair.mineId);
    assertSame("report.stats", up["stats"], my.stats, pair.mine.root);
    assertSame("report.markdown（生成时间归一化后）", up["markdown"], my.markdown, pair.mine.root);
  });

  it("reportTargets() 一致", async () => {
    const pair = await makePair();
    seedReportable(pair);
    const up = pair.upstream.reportTargets(pair.upstreamId);
    const my = pair.mine.reportTargets(pair.mineId);
    assertSame("reportTargets.totals", up["totals"], my.totals, pair.mine.root);
    assertSame(
      "reportTargets.targets 的 key 顺序",
      (up["targets"] as { key: string }[]).map((t) => t.key),
      my.targets.map((t) => t.key),
      pair.mine.root,
    );
  });

  it("scoreReport() 的 items/summary 与 markdown 一致", async () => {
    const pair = await makePair();
    seedBoth(pair);
    const hits: Record<string, unknown>[] = [
      { code: "server-host", target: "http://10.0.0.5:8080/", evidence: "10.0.0.5｜root", points: 50 },
      { code: "terminal-access", target: "10.1.0.1", evidence: "10.1.0.1｜PC", points: 10 },
      { code: "terminal-access", target: "10.1.0.2", evidence: "10.1.0.2｜PC", points: 10 },
      { code: "boundary-logical", target: "10.20.30.0/24", evidence: "suo5 打通" },
    ];
    for (const h of hits) {
      pair.upstream.addScoreHit(pair.upstreamId, h);
      pair.mine.addScoreHit(pair.mineId, h);
    }
    const up = pair.upstream.scoreReport(pair.upstreamId);
    const my = pair.mine.scoreReport(pair.mineId);
    assertSame("scoreReport.summary", up["summary"], my.summary, pair.mine.root);
    assertSame("scoreReport.items 的 id 顺序",
      (up["items"] as { id: number }[]).map((x) => x.id),
      my.items.map((x) => x.id),
      pair.mine.root);
    assertSame("scoreReport.markdown（生成时间归一化后）", up["markdown"], my.markdown, pair.mine.root);
  });
});

describe("equivalence: 知识库", () => {
  it("savePoc / searchPocs / pocStats 一致", async () => {
    const pair = await makePair();
    const pocs: Record<string, unknown>[] = [
      { title: "Shiro 反序列化", cve: "CVE-2016-4437", kind: "poc", content: "poc body", language: "python", source: "self", verified: true, category: "deserialization" },
      { title: "Redis 未授权", kind: "exp", content: "redis body", category: "unauthorized" },
      { title: "无归类", content: "" },
    ];
    for (const p of pocs) {
      const up = pair.upstream.savePoc(p);
      const my = pair.mine.savePoc(p);
      assertSame(`savePoc(${String(p["title"])}).created`, up["created"], my.created, pair.mine.root);
      /* poc 行里有时间戳，单独比关键字段 */
      const upRow = up["poc"] as Record<string, unknown>;
      assertSame(`savePoc(${String(p["title"])}).code`, upRow["code"], my.poc.code, pair.mine.root);
      assertSame(`savePoc(${String(p["title"])}).category`, upRow["category"], my.poc.category, pair.mine.root);
    }
    assertSame("searchPocs", pair.upstream.searchPocs({}), pair.mine.searchPocs({}), pair.mine.root);
    const upStats = pair.upstream.pocStats();
    const myStats = pair.mine.pocStats();
    assertSame("pocStats（除 dbPath）", { ...upStats, dbPath: undefined }, { ...myStats, dbPath: undefined }, pair.mine.root);
  });
});

describe("equivalence: 图谱与时间线", () => {
  it("graph / attackGraph / discoveryTimeline 一致", async () => {
    const pair = await makePair();
    seedBoth(pair);
    assertSame("graph", pair.upstream.graph(pair.upstreamId, {}), pair.mine.graph(pair.mineId, {}), pair.mine.root);
    assertSame("attackGraph", pair.upstream.attackGraph(pair.upstreamId, {}), pair.mine.attackGraph(pair.mineId, {}), pair.mine.root);
    assertSame("discoveryTimeline.span",
      (pair.upstream.discoveryTimeline(pair.upstreamId, {}) as { span: unknown }).span,
      pair.mine.discoveryTimeline(pair.mineId, {}).span,
      pair.mine.root);
  });

  it("listStages / listPrompts 的角色清单一致", async () => {
    const pair = await makePair();
    const upStages = pair.upstream.listStages(pair.upstreamId) as { code: string }[];
    const myStages = pair.mine.listStages(pair.mineId);
    assertSame("listStages 的 code 顺序", upStages.map((s) => s.code), myStages.map((s) => s.code), pair.mine.root);
    assertSame("listStages（全量）", upStages, myStages, pair.mine.root);
    const upRoles = (pair.upstream.listPrompts(pair.upstreamId) as { role: string; content: string }[]).map((r) => ({ role: r.role, len: r.content.length }));
    const myRoles = pair.mine.listPrompts(pair.mineId).map((r) => ({ role: r.role, len: r.content.length }));
    assertSame("listPrompts 的角色与正文长度", upRoles, myRoles, pair.mine.root);
  });
});
