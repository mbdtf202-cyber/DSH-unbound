/**
 * 当前测试页（`testing` 页签，也是资产页的「当前测试」视图）的数据模型。
 *
 * ## 抽取重点
 *
 * 原 `TestingTab`（138 行）里有两处**活的并发逻辑**：
 *
 * 1. **5 秒轮询 + 在途守卫**：
 *    ```js
 *    const inflight = React.useRef(false)
 *    const seq = React.useRef(0)
 *    const load = () => {
 *      if (!eng || inflight.current) return    // ← 在途时直接跳过，不排队
 *      inflight.current = true
 *      const my = ++seq.current
 *      api({...}).then((r) => { if (my !== seq.current) return; ... })
 *        .finally(() => { if (my === seq.current) inflight.current = false })
 *    }
 *    ```
 *    守卫的作用是「网络慢/后端卡住时请求不堆积」+「旧响应不覆盖新状态」。
 *    `finally` 里**又判了一次 seq**：切靶标后旧请求的 finally 不能把新请求的
 *    inflight 清掉（否则并发闸门失效）。
 * 2. **三块折叠的记忆**：`testing:eng` / `recent:eng` / `queue:eng`
 *    三条键都带靶标 id（切靶标时各自独立），其中「正在测」虽然理论上
 *    可折叠，但原注释说「正在测永远常显，不参与折叠」—— 实际代码里
 *    `open: collapse.isOpen('testing:' + eng, true)` 是**可折叠**的，
 *    只是默认展开、且「全部收起」按钮会把它一起收起。这里按**代码**迁，
 *    不按注释（注释与代码不一致时以代码为准，因为用户看到的是代码行为）。
 */

import { err, ok, type Result } from "../../shared/result.js";
import type { ApiClient, ApiRequest } from "./api.js";
import { TEST_STATUS_LABEL } from "./label.js";

/* ══════════════════════════════════════════════════════════════ 窄化原语 */

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function countOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/* ══════════════════════════════════════════════════════════════ 资产卡 */

/** 一台正在/曾经测试的资产。 */
export interface TestedAsset {
  readonly id: number;
  readonly ip: string;
  readonly segmentCidr: string;
  readonly scope: "internal" | "external";
  readonly testStatus: string;
  readonly testNotes: string;
  readonly testSurface: string;
  readonly testUpdatedAt: string;
  readonly testUpdatedBy: string;
  readonly blockedCount: number;
  readonly priority: string;
  readonly potential: string;
  readonly openPorts: number;
  readonly vulns: number;
  readonly webshells: number;
  readonly tunnels: number;
}

/** 解析一台资产。 */
export function testedAssetOf(raw: unknown): TestedAsset {
  const entry = recordOf(raw);
  return {
    id: countOrZero(entry["id"]),
    ip: text(entry["ip"]),
    segmentCidr: text(entry["segment_cidr"]) || text(entry["segmentCidr"]),
    scope: entry["scope"] === "internal" ? "internal" : "external",
    testStatus: text(entry["test_status"]) || text(entry["testStatus"]),
    testNotes: text(entry["test_notes"]) || text(entry["testNotes"]),
    testSurface: text(entry["test_surface"]) || text(entry["testSurface"]),
    testUpdatedAt: text(entry["test_updated_at"]) || text(entry["testUpdatedAt"]),
    testUpdatedBy: text(entry["test_updated_by"]) || text(entry["testUpdatedBy"]),
    blockedCount: countOrZero(entry["blocked_count"]) || countOrZero(entry["blockedCount"]),
    priority: text(entry["priority"]),
    potential: text(entry["potential"]),
    openPorts: countOrZero(entry["open_ports"]) || countOrZero(entry["openPorts"]),
    vulns: countOrZero(entry["vulns"]),
    webshells: countOrZero(entry["webshells"]),
    tunnels: countOrZero(entry["tunnels"]),
  };
}

/** 资产卡上的一枚 chip。 */
export interface AssetChip {
  readonly key: string;
  readonly className: string;
  readonly label: string;
  readonly title?: string;
}

/**
 * 资产卡的 chips。
 *
 * 顺序即界面顺序，逐条对应原实现：归属 → C 段 → 开放端口 → 已确认漏洞 →
 * WebShell → 隧道 → 易打性 → 被封次数。**每一项都在非 0/非空时才出现**。
 */
export function assetChips(asset: TestedAsset): readonly AssetChip[] {
  const chips: AssetChip[] = [
    {
      key: "sc",
      className: "rt-scope rt-scope-" + (asset.scope === "internal" ? "internal" : "external"),
      label: asset.scope === "internal" ? "内网" : "外网",
    },
  ];
  if (asset.segmentCidr !== "") {
    chips.push({ key: "seg", className: "rt-tag", label: asset.segmentCidr });
  }
  if (asset.openPorts > 0) {
    chips.push({ key: "p", className: "rt-tag rt-tag-active", label: "开放 " + asset.openPorts + " 端口" });
  }
  if (asset.vulns > 0) {
    chips.push({ key: "v", className: "rt-tag rt-tag-live", label: "已确认漏洞 " + asset.vulns });
  }
  if (asset.webshells > 0) {
    chips.push({ key: "w", className: "rt-tag rt-tag-passive", label: "WebShell " + asset.webshells });
  }
  if (asset.tunnels > 0) {
    chips.push({ key: "t", className: "rt-tag rt-tag-passive", label: "隧道 " + asset.tunnels });
  }
  if (asset.priority !== "") {
    chips.push({ key: "pr", className: "rt-tag", label: "易打 " + asset.priority });
  }
  if (asset.blockedCount > 0) {
    chips.push({
      key: "b",
      className: "rt-tag",
      label: "被封 " + asset.blockedCount + " 次",
    });
  }
  return chips;
}

/** 测试记录最多显示的行数（原实现 `slice(-3)`：**取最后 3 行**）。 */
export const MAX_NOTE_LINES = 3;

/** 单行测试记录的最大字符数（超出截断并加 ` …`）。 */
export const MAX_NOTE_CHARS = 240;

/**
 * 资产卡的测试记录（最后 3 行，每行最长 240 字符）。
 *
 * `slice(-3)` 是关键：测试记录是**追加**的，最近的动作在最后几行；
 * 取前 3 行会永远显示最早的「开始测试」而看不到最新进展。
 */
export function noteLines(asset: TestedAsset): readonly string[] {
  if (asset.testNotes === "") return [];
  return asset.testNotes
    .split("\n")
    .slice(-MAX_NOTE_LINES)
    .map((line) => (line.length > MAX_NOTE_CHARS ? line.slice(0, MAX_NOTE_CHARS) + " …" : line));
}

/** 资产卡的标题状态标签。 */
export function statusLabel(asset: TestedAsset): string {
  const key = asset.testStatus as keyof typeof TEST_STATUS_LABEL;
  return TEST_STATUS_LABEL[key] ?? asset.testStatus;
}

/** 状态标签的类名（测试中才高亮）。 */
export function statusClass(asset: TestedAsset): string {
  return "rt-tag " + (asset.testStatus === "testing" ? "rt-tag-live" : "");
}

/** 「测试面」行（空 → `null`，不渲染）。 */
export function surfaceLine(asset: TestedAsset): string | null {
  return asset.testSurface !== "" ? "测试面：" + asset.testSurface : null;
}

/** 「预期得分」行（空 → `null`，不渲染）。 */
export function potentialLine(asset: TestedAsset): string | null {
  return asset.potential !== "" ? "预期得分：" + asset.potential : null;
}

/** 卡的更新时间文本（`时间 · 角色`）。 */
export function updatedText(asset: TestedAsset, timeText: string): string {
  return asset.testUpdatedBy !== "" ? timeText + " · " + asset.testUpdatedBy : timeText;
}

/* ══════════════════════════════════════════════════════════════ 计数 */

/** 一屏计数。 */
export interface TestStats {
  readonly testing: number;
  readonly untested: number;
  readonly tested: number;
  readonly abandoned: number;
  readonly blocked: number;
  readonly noSurface: number;
}

/** 空计数。 */
export const EMPTY_TEST_STATS: TestStats = Object.freeze({
  testing: 0,
  untested: 0,
  tested: 0,
  abandoned: 0,
  blocked: 0,
  noSurface: 0,
});

/** 解析 `stats`。 */
export function testStatsOf(raw: unknown): TestStats {
  const entry = recordOf(raw);
  return {
    testing: countOrZero(entry["testing"]),
    untested: countOrZero(entry["untested"]),
    tested: countOrZero(entry["tested"]),
    abandoned: countOrZero(entry["abandoned"]),
    blocked: countOrZero(entry["blocked"]),
    noSurface: countOrZero(entry["no_surface"]) || countOrZero(entry["noSurface"]),
  };
}

/** 一条结论项。 */
export interface TestConclusionItem {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/** 五条结论项（顺序即界面顺序）。 */
export function conclusionItems(stats: TestStats): readonly TestConclusionItem[] {
  return [
    { key: "testing", label: "测试中", value: stats.testing },
    { key: "untested", label: "待测", value: stats.untested },
    { key: "tested", label: "已测", value: stats.tested },
    // 「放弃」是两类之和：已放弃 + 被封禁。
    { key: "giveup", label: "放弃", value: stats.abandoned + stats.blocked },
    { key: "noSurface", label: "无攻击面", value: stats.noSurface },
  ];
}

/* ══════════════════════════════════════════════════════════════ 数据 */

/** 当前测试页的数据。 */
export interface ActiveTestsData {
  readonly testing: readonly TestedAsset[];
  readonly recent: readonly TestedAsset[];
  readonly queue: readonly TestedAsset[];
  readonly stats: TestStats;
  readonly untested: number;
}

/** 解析 `op: activeTests` 的响应。 */
export function activeTestsOf(response: unknown): ActiveTestsData {
  const body = recordOf(response);
  return {
    testing: arrayOf(body["testing"]).map(testedAssetOf),
    recent: arrayOf(body["recent"]).map(testedAssetOf),
    queue: arrayOf(body["queue"]).map(testedAssetOf),
    stats: testStatsOf(body["stats"]),
    untested: countOrZero(body["untested"]),
  };
}

/* ══════════════════════════════════════════════════════════════ 折叠键 */

/** 三个区块的折叠键都带靶标 id（切靶标各自独立）。 */
export function collapseKey(kind: "testing" | "recent" | "queue", engagement: string): string {
  return kind + ":" + engagement;
}

/** 三个区块的键（「全部展开/收起」一次设三个）。 */
export function sectionKeys(engagement: string): readonly string[] {
  return [
    collapseKey("testing", engagement),
    collapseKey("recent", engagement),
    collapseKey("queue", engagement),
  ];
}

/** 三个区块的默认展开态：「正在测」展开，另两个折叠。 */
export const SECTION_DEFAULTS: Readonly<Record<"testing" | "recent" | "queue", boolean>> = Object.freeze({
  testing: true,
  recent: false,
  queue: false,
});

/* ══════════════════════════════════════════════════════════════ 轮询 */

/** 轮询间隔（毫秒）。 */
export const POLL_INTERVAL_MS = 5000;

/** 每次拉的条数上限。 */
export const ACTIVE_TESTS_LIMIT = 20;

/**
 * 在途守卫。
 *
 * 抽成一个纯对象而不是闭包，是为了让它**可测**：原实现的守卫藏在
 * `useRef` + `api().then()` 的链里，只能靠「跑一遍组件」验证；
 * 这里可以直接断言「在途时第二次 begin 返回 false」「切靶标后旧请求的
 * finish 不释放闸门」。
 */
export interface PollGuard {
  /** 尝试开始一次请求；在途时返回 `null`（本次跳过，不排队）。 */
  begin(): number | null;
  /** 该序号是否仍是当前有效请求（切靶标 / 更新的请求会让它失效）。 */
  isCurrent(token: number): boolean;
  /** 结束一次请求：**只有仍是当前序号时才释放闸门**。 */
  finish(token: number): void;
  /** 是否在途。 */
  readonly inflight: boolean;
  /** 让所有在途请求失效（切靶标时调）。 */
  invalidate(): void;
}

/** 造一个在途守卫。 */
export function createPollGuard(): PollGuard {
  let seq = 0;
  let running = false;
  return {
    get inflight() {
      return running;
    },
    begin() {
      // 在途时**直接跳过**：不排队、不并发（原实现的语义）。
      if (running) return null;
      running = true;
      seq += 1;
      return seq;
    },
    isCurrent(token) {
      return token === seq;
    },
    finish(token) {
      // 切靶标后旧请求的 finish 不能把新请求的闸门释放掉。
      if (token === seq) running = false;
    },
    invalidate() {
      seq += 1;
      running = false;
    },
  };
}

/* ══════════════════════════════════════════════════════════════ 请求 */

/** 请求 `op: activeTests`。 */
export function activeTestsRequest(engagement: string): ApiRequest {
  return { op: "activeTests", engagement, limit: ACTIVE_TESTS_LIMIT };
}

/** 从响应里取错误文案。 */
function errorOf(response: unknown, fallback: string): string | null {
  if (response === null || response === undefined) return fallback;
  const body = recordOf(response);
  if (body["ok"] !== false) return null;
  const message = body["error"];
  return typeof message === "string" && message !== "" ? message : fallback;
}

/** 加载当前测试数据。 */
export async function loadActiveTests(
  api: ApiClient,
  engagement: string,
): Promise<Result<ActiveTestsData, string>> {
  const response = await api.raw(activeTestsRequest(engagement));
  const error = errorOf(response, "读取失败");
  if (error !== null) return err(error);
  return ok(activeTestsOf(response));
}

/* ══════════════════════════════════════════════════════════════ 空态 */

/** 未选靶标。 */
export const NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看当前测试。";

/** 加载中。 */
export const LOADING_TEXT = "加载中…";

/** 「正在测」为空时的说明。 */
export const EMPTY_TESTING_TEXT = "当前没有资产处于「测试中」";

/** 「最近动过」为空。 */
export const EMPTY_RECENT_TEXT = "暂无";

/** 「待测队列」为空。 */
export const EMPTY_QUEUE_TEXT = "没有待测资产";

/** 待测队列尾部的引导。 */
export const QUEUE_HINT = "完整清单（含筛选与排序）见「资产测绘」页";

/** 「正在测」区块的副标题（空/非空两态）。 */
export function testingSubtitle(count: number): string {
  return count > 0 ? "agent 正在打这些资产" : "agent 开始测某台资产后会实时出现在这里";
}

/** 结论行的「更新于 HH:MM:SS」。 */
export function updatedAtText(time: Date | null): string | null {
  if (time === null) return null;
  return "更新于 " + time.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 实时开关的文案。 */
export function autoLabel(auto: boolean): string {
  return auto ? "实时 · 5s" : "已暂停";
}

/** 实时开关的 tooltip。 */
export const AUTO_TITLE = "每 5 秒自动刷新";

/** 「全部展开」的 tooltip。 */
export const EXPAND_ALL_TITLE = "展开最近动过与待测队列";

/** 「全部收起」的 tooltip。 */
export const COLLAPSE_ALL_TITLE = "只留正在测";
