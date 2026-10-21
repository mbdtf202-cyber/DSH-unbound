/**
 * 控制台「B 组页签」的真实取数与 props 构造。
 *
 * 负责 6 个页签：`knowledge` / `skills` / `testing` / `attackfiles` /
 * `prompts` / `report`。
 *
 * `agents` **不在**这里（也不是本文件能补的）：`tab-registry.ts` 的
 * `TabRegistryProps` 没有 `agents` 字段，分派分支无条件返回空态，
 * `client/` 下也没有对应的页签渲染器。详见文件末尾
 * `AGENTS_NOT_WIRED_REASON`。
 *
 * ## 为什么这一层长这样
 *
 * `client/` 里的 6 个页签都是**纯函数**：props 进、元素出、不留状态。它们各自
 * 还导出了模型层解析函数（`knowledgeDataOf` / `catalogLoadOf` / `activeTestsOf` /
 * `fileFoldersOf` / `promptLoadOf` / `reportDataOf`）把不可信响应解析成结构化数据。
 * 也就是说「怎么解析」已经写好了，缺的只是**谁去调 `api.raw`、把结果放哪、
 * 回调怎么接回去**。
 *
 * 这一层就是那个「谁」：
 *
 * ```
 *  api.raw({op}) ──► 模型层解析函数 ──► TabsBState（纯容器，可在 node:test 里跑）
 *                                            │
 *                                   propsForWithEngagement()
 *                                            │
 *                                            ▼
 *                                   TabRegistryProps → renderXxxTab
 * ```
 *
 * 状态刻意**不进 React**：`TabsBState` 是普通闭包容器（`get` / `subscribe` /
 * `refreshXxx`），于是 6 个页签的取数路径可以用假 `ApiClient` 直接跑完，不需要
 * React 运行时，也不需要「渲染一次看它有没有发请求」这种间接断言。React 只出现在
 * `makeTabsBSlot`（约 30 行胶水），它把容器变更转成一次 `setState`。
 *
 * ## 不伪造数据
 *
 * 任何 op 失败只写进该页签自己的 `error`；拿不到的字段就**不传**
 * （`TabRegistryProps` 每项可缺失，缺的那项页签走自己的空态）。这里不存在
 * 「先塞个空对象让类型检查过」的中间态 —— 那会让人以为「读到了但没有数据」，
 * 而实际是「压根没读成功」。
 *
 * ## 构建产物约束
 *
 * 本文件会被打进浏览器产物 `client.js`，所以：
 * - 只 import `../client/*.js`；**不 import `node:*`**，也**不 import
 *   `../store/**`**（服务端代码含 `node:sqlite`，前端只能经 HTTP 走 `api.raw`）。
 * - **模块顶层没有不可复现的东西**：`new Date()` 收在 `nowIso()` / `nowDate()`
 *   函数体内，构建产物因此字节可复现（两次构建 sha256 相同）。
 */

import type { ApiClient, ApiResponse } from "../client/api.js";
import type { ConsoleRuntime } from "../client/runtime.js";
import type { ReactNode } from "../client/dom.js";
import type { CollapseState, ConsoleTabId } from "../client/state.js";
import { setSections, toggleSection } from "../client/state.js";
import type { TabRegistryProps } from "../client/tab-registry.js";
import { shotDataUrl } from "../client/helpers.js";

/* ────────────────────────────────────────────── 知识库 */

import {
  EMPTY_QUERY,
  detailFor,
  knowledgeDataOf,
  pocDetailOf,
  type KnowledgeData,
  type KnowledgeQuery,
  type PocDetail,
  type PocItem,
} from "../client/knowledge-model.js";
import {
  detailFailureText,
  failureText,
  loadPocDetail,
  queryAfterCategory,
  searchPoc,
  usePoc,
  useSuccessMessage,
  type KnowledgeMessage,
} from "../client/knowledge-tab.js";

/* ────────────────────────────────────────────── 技能库 */

import {
  DEFAULT_SKILL_FILTER,
  toggleActive,
  type CatalogLoad,
  type SkillDetail,
  type SkillFilter,
  type SkillItem,
} from "../client/skills-model.js";
import { loadSkillCatalog, loadSkillDetail } from "../client/skills-tab.js";

/* ────────────────────────────────────────────── 当前测试 */

import {
  ACTIVE_TESTS_LIMIT,
  SECTION_DEFAULTS,
  activeTestsOf,
  createPollGuard,
  sectionKeys,
  type ActiveTestsData,
  type PollGuard,
} from "../client/testing-model.js";

/* ────────────────────────────────────────────── 攻击文件 */

import {
  fileDetailOf,
  fileFoldersOf,
  nextDetailId,
  type FileDetail,
  type FileFolder,
  type FileRow,
} from "../client/attackfiles-model.js";
import { loadAttackFile, loadAttackFiles } from "../client/attackfiles-tab.js";

/* ────────────────────────────────────────────── 提示词 */

import {
  activeRoleOf,
  draftFor,
  promptLoadOf,
  type PromptLoad,
  type PromptMessage,
} from "../client/prompts-model.js";
import { applySavedDraft, loadPrompts, resetPrompts, savePrompt } from "../client/prompts-tab.js";

/* ────────────────────────────────────────────── 报告 */

import {
  COPY_FAILED_MESSAGE,
  copiedMessage,
  downloadFailedMessage,
  downloadedMessage,
  reportDataOf,
  type ReportData,
  type ReportItem,
} from "../client/report-model.js";
import { copyFeedback, loadReportWithGrouping, type ReportMessage } from "../client/report-tab.js";

/* ══════════════════════════════════════════════════════════════ 常量 */

/** 读取失败的兜底文案（各 tab 自己的 `*_FALLBACK` 也是这个串）。 */
const LOAD_FAILED = "读取失败";

/** 详情读取失败的兜底文案。 */
const DETAIL_FAILED = "读取失败";

/** 无靶标时报告页的提示（与 `testing` 页的 `NO_ENGAGEMENT_TEXT` 同口径）。 */
export const REPORT_NEED_ENGAGEMENT = "请先在顶部选择或创建靶标，再生成报告。";

/* ══════════════════════════════════════════════════════════════ 依赖 */

/**
 * 取数依赖（全部注入）。
 *
 * 注入而不是让本模块摸 `window`：测试里喂假 `api` 就能跑完每条路径；
 * 生产里的真 `api` 由 `console.ts` 用 `makeApiClient` 造好传进来。
 */
export interface TabsBDeps {
  /** 桥接客户端（`api.raw({op})`）。 */
  readonly api: ApiClient;
  /**
   * 当前靶标 id（`null` = 还没选）。
   *
   * 用**函数**而不是值：靶标切换后不必重建整个容器，下一次刷新自然读到新的。
   */
  readonly engagement: () => string | null;
  /** 变更通知（React 胶水用它触发重渲染；测试不传时直接读 `get()` 断言）。 */
  readonly notify?: (() => void) | undefined;
  /**
   * 复制到剪贴板。
   *
   * 由容器提供（只有它知道 `navigator.clipboard` / `execCommand` 的降级顺序）。
   * **不提供时复制会如实报失败**，而不是静默成功 —— 静默成功会让用户以为
   * 「复制好了」，粘出来却是旧内容。
   */
  readonly copy?: ((text: string, label: string) => Promise<boolean>) | undefined;
  /** 下载文件（报告页用）。不提供时给出明确的「未提供下载能力」消息。 */
  readonly download?: ((text: string, label: string) => Promise<boolean>) | undefined;
  /** 当前时间（ISO 串）。注入以便测试可控；默认在**函数体内**取当前时刻。 */
  readonly nowIso?: (() => string) | undefined;
  /** 当前时刻（`Date`）。测试注入固定值。 */
  readonly nowDate?: (() => Date) | undefined;
  /**
   * 定时器（当前测试页自动刷新用）。
   *
   * 不提供 = 不轮询（`auto` 标记仍可切，只是不会自己触发刷新）。
   * **不在这里默认塞 `setInterval`**：本文件进浏览器产物也可能被 Node 测试直接
   * import，两边全局不同；定时器交给宿主那侧决定更诚实。
   */
  readonly setInterval?: ((handler: () => void, ms: number) => unknown) | undefined;
  /** 清定时器（与 `setInterval` 配套）。 */
  readonly clearInterval?: ((handle: unknown) => void) | undefined;
}

/* ══════════════════════════════════════════════════════════════ 容器状态 */

/** 一个页签的「数据 / 错误 / 在途」三元组。 */
interface Loadable<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly busy: boolean;
}

/** 空三元组。 */
function idle<T>(): Loadable<T> {
  return { data: null, error: null, busy: false };
}

/** 知识库页状态。 */
export interface KnowledgeState extends Loadable<KnowledgeData> {
  readonly query: KnowledgeQuery;
  readonly openId: number | null;
  readonly detail: PocDetail | null;
  readonly detailBusy: boolean;
  readonly message: KnowledgeMessage | null;
  readonly grouped: boolean;
}

/** 技能库页状态。 */
export interface SkillsState extends Loadable<CatalogLoad> {
  readonly filter: SkillFilter;
  readonly activeKey: string | null;
  readonly detail: SkillDetail | null;
  readonly detailBusy: boolean;
}

/** 当前测试页状态。 */
export interface TestingState extends Loadable<ActiveTestsData> {
  readonly updatedAt: Date | null;
  readonly auto: boolean;
  readonly collapsed: CollapseState;
  readonly openNotes: readonly number[];
}

/** 攻击文件页状态。 */
export interface AttackFilesState extends Loadable<readonly FileFolder[]> {
  readonly detail: FileDetail | null;
  readonly collapse: CollapseState;
}

/** 提示词页状态。 */
export interface PromptsState extends Loadable<PromptLoad> {
  readonly active: string | null;
  readonly draft: string;
  readonly message: PromptMessage | null;
}

/** 报告页状态。 */
export interface ReportState extends Loadable<ReportData> {
  readonly message: ReportMessage | null;
  readonly collapse: CollapseState;
}

/** 容器快照（每项独立，互不影响）。 */
export interface TabsBSnapshot {
  readonly knowledge: KnowledgeState;
  readonly skills: SkillsState;
  readonly testing: TestingState;
  readonly attackfiles: AttackFilesState;
  readonly prompts: PromptsState;
  readonly report: ReportState;
  /** 截图缓存：截图 id → data URL。 */
  readonly shots: ReadonlyMap<number, string>;
}

/** 造一个空快照（测试与初始状态共用）。 */
export function emptySnapshot(): TabsBSnapshot {
  return {
    knowledge: {
      ...idle(),
      query: EMPTY_QUERY,
      openId: null,
      detail: null,
      detailBusy: false,
      message: null,
      grouped: false,
    },
    skills: { ...idle(), filter: DEFAULT_SKILL_FILTER, activeKey: null, detail: null, detailBusy: false },
    testing: { ...idle(), updatedAt: null, auto: false, collapsed: {}, openNotes: [] },
    attackfiles: { ...idle(), detail: null, collapse: {} },
    prompts: { ...idle(), active: null, draft: "", message: null },
    report: { ...idle(), message: null, collapse: {} },
    shots: new Map<number, string>(),
  };
}

/**
 * 容器接口。
 *
 * 全部方法都是「读当前 → 发请求 → 写回 + 通知」。没有 React、没有全局、
 * 没有隐藏定时器（轮询要显式 `setAuto(true)` 且注入了定时器才生效）。
 */
export interface TabsBState {
  /** 读快照（不可变对象，供 `propsForWithEngagement` 用）。 */
  get(): TabsBSnapshot;
  /** 订阅变更，返回退订函数。 */
  subscribe(listener: () => void): () => void;
  /** 当前靶标 id（容器自己记着，`propsForWithEngagement` 也可显式传）。 */
  engagement(): string | null;

  /* 知识库 */
  refreshKnowledge(): Promise<void>;
  setKnowledgeQuery(query: KnowledgeQuery): void;
  submitKnowledge(): Promise<void>;
  setKnowledgeCategory(code: string): Promise<void>;
  toggleKnowledgeGrouped(): void;
  openPoc(id: number): Promise<void>;
  useKnowledgeItem(item: PocItem): Promise<void>;
  copyKnowledgeText(text: string, label: string): Promise<void>;

  /* 技能库 */
  refreshSkills(force: boolean): Promise<void>;
  setSkillFilter(filter: SkillFilter): void;
  toggleSkill(item: SkillItem): Promise<void>;

  /* 当前测试 */
  refreshTesting(): Promise<void>;
  setAuto(auto: boolean): void;
  toggleTestingSection(key: string): void;
  expandTestingSections(): void;
  collapseTestingSections(): void;
  toggleTestingNotes(assetId: number): void;
  copyTestingText(text: string): Promise<void>;
  /** 停止轮询并清订阅（容器卸载时调）。 */
  dispose(): void;

  /* 攻击文件 */
  refreshAttackFiles(): Promise<void>;
  openAttackFile(file: FileRow): Promise<void>;
  setAttackFileCollapse(state: CollapseState): void;

  /* 提示词 */
  refreshPrompts(): Promise<void>;
  selectPromptRole(role: string): void;
  setPromptDraft(draft: string): void;
  savePromptDraft(): Promise<void>;
  resetPromptRoles(all: boolean): Promise<void>;

  /* 报告 */
  refreshReport(): Promise<void>;
  copyReportText(text: string, label: string): Promise<void>;
  downloadReportText(text: string, label: string): Promise<void>;
  setReportCollapse(state: CollapseState): void;
  setReportAllCollapsed(keys: readonly string[], open: boolean): void;

  /* 报告证据截图 */
  /** 已取回的截图 data URL（`undefined` = 还没取 / 取失败）。 */
  shotUrl(shotId: number): string | undefined;
  /** 触发一次截图取数（幂等：同一 id 只发一次）。 */
  ensureShot(shotId: number): void;
}

/* ══════════════════════════════════════════════════════════════ 小工具 */

/** 从失败响应里取错误文案。 */
function responseError(response: ApiResponse, fallback: string): string | null {
  if (response.ok !== false) return null;
  return typeof response.error === "string" && response.error !== "" ? response.error : fallback;
}

/** 从异常里取可读文案。 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 从 `shotData` 响应里取图片 data URL。
 *
 * 不可信输入逐项窄化：`base64` 必须是字符串、`mime` 缺失时按 `image/png`
 * （`shotDataUrl` 已经做了这两件事，拿不到就返回空串 → 这里再收成 `null`）。
 */
export function shotImageOf(response: ApiResponse): string | null {
  if (response.ok === false) return null;
  const url = shotDataUrl(response["base64"], response["mime"]);
  return url === "" ? null : url;
}

/* ══════════════════════════════════════════════════════════════ 容器实现 */

/**
 * 造状态容器。
 *
 * 所有取数方法都**不抛**：失败写进 `error`，由页签自己的错误态呈现。
 * 这与 `api.ts` 的「永不 reject」契约配套 —— 两边都抛会让容器里到处是 try。
 */
export function makeTabsBState(deps: TabsBDeps): TabsBState {
  const { api } = deps;
  let snapshot: TabsBSnapshot = emptySnapshot();
  const listeners = new Set<() => void>();
  /** 截图取数在途集合：同一 id 不发第二次。 */
  const shotPending = new Set<number>();
  /** 当前测试页的在途守卫。 */
  const guard: PollGuard = createPollGuard();
  /** 轮询定时器句柄（`undefined` = 没开）。 */
  let pollHandle: unknown = undefined;
  /** 已加载时使用的靶标 id：变了就清旧数据。 */
  let loadedEngagement: string | null = null;

  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        /* 一个坏订阅者不该让整个面板停摆（与 runtime.ts 的 store 同策略） */
      }
    }
  };

  const commit = (patch: Partial<TabsBSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    deps.notify?.();
    notify();
  };

  /** 当前时间（ISO）。 */
  const nowIso = (): string => deps.nowIso?.() ?? new Date().toISOString();

  /** 当前时刻。 */
  const nowDate = (): Date => deps.nowDate?.() ?? new Date();

  /** 读靶标 id（空串归一成 `null`）。 */
  const engagementOf = (): string | null => {
    const id = deps.engagement();
    return id === null || id === "" ? null : id;
  };

  /** 复制一段文本，返回结果消息。 */
  async function copyText(
    text: string,
    label: string,
  ): Promise<{ readonly ok: boolean; readonly text: string }> {
    if (deps.copy === undefined) {
      return { ok: false, text: "宿主未提供剪贴板能力，请手动选中复制" };
    }
    try {
      const ok = await deps.copy(text, label);
      return ok ? { ok: true, text: copiedMessage(label) } : { ok: false, text: COPY_FAILED_MESSAGE };
    } catch (cause) {
      return { ok: false, text: "复制失败：" + messageOf(cause) };
    }
  }

  /* ────────────────────────────────────────── 知识库（全局，不依赖靶标） */

  async function refreshKnowledge(): Promise<void> {
    commit({ knowledge: { ...snapshot.knowledge, busy: true, error: null } });
    let response: ApiResponse;
    try {
      response = await searchPoc(api, snapshot.knowledge.query);
    } catch (cause) {
      commit({ knowledge: { ...snapshot.knowledge, busy: false, error: messageOf(cause) } });
      return;
    }
    const error = failureText(response);
    if (error !== null) {
      // 失败时**保留上一次的数据**：网络抖一下不该把用户正在看的列表清空。
      commit({ knowledge: { ...snapshot.knowledge, busy: false, error } });
      return;
    }
    commit({
      knowledge: { ...snapshot.knowledge, busy: false, error: null, data: knowledgeDataOf(response) },
    });
  }

  async function openPoc(id: number): Promise<void> {
    const current = snapshot.knowledge;
    // 点同一条 = 收起（与 `detailFor` 的派生语义配套）。
    if (current.openId === id) {
      commit({ knowledge: { ...current, openId: null, detail: null, detailBusy: false } });
      return;
    }
    commit({ knowledge: { ...current, openId: id, detail: null, detailBusy: true } });
    let response: ApiResponse;
    try {
      response = await loadPocDetail(api, id);
    } catch (cause) {
      commit({
        knowledge: {
          ...snapshot.knowledge,
          detailBusy: false,
          message: { kind: "err", text: messageOf(cause) },
        },
      });
      return;
    }
    const error = detailFailureText(response);
    if (error !== null) {
      // 详情读失败：给消息，但不把整页变成错误态（列表还是可用的）。
      commit({
        knowledge: { ...snapshot.knowledge, detailBusy: false, detail: null, message: { kind: "err", text: error } },
      });
      return;
    }
    commit({ knowledge: { ...snapshot.knowledge, detailBusy: false, detail: pocDetailOf(response) } });
  }

  /* ────────────────────────────────────────── 技能库 */

  async function refreshSkills(force: boolean): Promise<void> {
    commit({ skills: { ...snapshot.skills, busy: true, error: null } });
    let load: CatalogLoad;
    try {
      load = await loadSkillCatalog(api, force);
    } catch (cause) {
      const message = messageOf(cause);
      commit({
        skills: {
          ...snapshot.skills,
          busy: false,
          error: message,
          // 仍然给出结构化的失败结果：页签同时显示错误与「读到了但没有技能」两态。
          data: { ok: false, items: [], meta: null, error: message, restartHint: false },
        },
      });
      return;
    }
    // `catalogLoadOf` 把失败也收成结构（`ok:false` + `error` + `restartHint`），
    // 页签据此同时显示错误与「宿主版本不含该 op」的行动建议。
    commit({
      skills: { ...snapshot.skills, busy: false, error: load.ok ? null : load.error, data: load },
    });
  }

  async function toggleSkill(item: SkillItem): Promise<void> {
    const nextKey = toggleActive(snapshot.skills.activeKey, item);
    if (nextKey === null) {
      commit({ skills: { ...snapshot.skills, activeKey: null, detail: null, detailBusy: false } });
      return;
    }
    commit({ skills: { ...snapshot.skills, activeKey: nextKey, detail: null, detailBusy: true } });
    let result: { readonly detail: SkillDetail | null; readonly error: string | null };
    try {
      result = await loadSkillDetail(api, item);
    } catch (cause) {
      result = { detail: null, error: messageOf(cause) };
    }
    if (result.error !== null) {
      commit({ skills: { ...snapshot.skills, detailBusy: false, detail: null, error: result.error } });
      return;
    }
    commit({ skills: { ...snapshot.skills, detailBusy: false, detail: result.detail } });
  }

  /* ────────────────────────────────────────── 当前测试 */

  function stopPolling(): void {
    if (pollHandle !== undefined && deps.clearInterval !== undefined) {
      deps.clearInterval(pollHandle);
    }
    pollHandle = undefined;
  }

  function startPolling(): void {
    if (pollHandle !== undefined) return;
    // 宿主没给定时器：不轮询（不假装在实时刷新）。
    if (deps.setInterval === undefined) return;
    pollHandle = deps.setInterval(() => {
      void refreshTesting();
    }, 5000);
  }

  async function refreshTesting(): Promise<void> {
    const engagement = engagementOf();
    if (engagement === null) {
      // 没靶标：不发请求；`data` 留 `null`，页签显示「请先选择靶标」。
      commit({ testing: { ...snapshot.testing, busy: false, error: null, data: null, updatedAt: null } });
      return;
    }
    if (loadedEngagement !== engagement) {
      // 切靶标：旧请求作废、旧数据清掉（否则会短暂显示上一个靶标的资产）。
      guard.invalidate();
      loadedEngagement = engagement;
      commit({ testing: { ...snapshot.testing, data: null, error: null, collapsed: {}, openNotes: [] } });
    }
    const token = guard.begin();
    // 在途：本轮跳过（不排队、不并发 —— `createPollGuard` 的语义）。
    if (token === null) return;
    commit({ testing: { ...snapshot.testing, busy: true } });
    let response: ApiResponse;
    try {
      response = await api.raw({ op: "activeTests", engagement, limit: ACTIVE_TESTS_LIMIT });
    } catch (cause) {
      guard.finish(token);
      commit({ testing: { ...snapshot.testing, busy: false, error: messageOf(cause) } });
      return;
    }
    const stillCurrent = guard.isCurrent(token);
    guard.finish(token);
    // 切靶标后回来的旧响应由 `isCurrent` 拦掉：它属于上一个靶标。
    if (!stillCurrent) return;
    const error = responseError(response, LOAD_FAILED);
    if (error !== null) {
      commit({ testing: { ...snapshot.testing, busy: false, error } });
      return;
    }
    commit({
      testing: {
        ...snapshot.testing,
        busy: false,
        error: null,
        data: activeTestsOf(response),
        updatedAt: nowDate(),
      },
    });
  }

  /* ────────────────────────────────────────── 攻击文件 */

  async function refreshAttackFiles(): Promise<void> {
    const engagement = engagementOf();
    if (engagement === null) {
      // 没靶标 = 没有攻击文件（不是错误）。空数组让页签显示自己的空态。
      commit({ attackfiles: { ...snapshot.attackfiles, busy: false, error: null, data: [] } });
      return;
    }
    commit({ attackfiles: { ...snapshot.attackfiles, busy: true, error: null } });
    let response: ApiResponse;
    try {
      response = await loadAttackFiles(api, engagement);
    } catch (cause) {
      commit({ attackfiles: { ...snapshot.attackfiles, busy: false, error: messageOf(cause) } });
      return;
    }
    const error = responseError(response, LOAD_FAILED);
    if (error !== null) {
      commit({ attackfiles: { ...snapshot.attackfiles, busy: false, error } });
      return;
    }
    commit({
      attackfiles: {
        ...snapshot.attackfiles,
        busy: false,
        error: null,
        data: fileFoldersOf(response),
        // 刷新后原来展开的文件可能已不在：detail 一并清掉，避免显示幽灵行。
        detail: null,
      },
    });
  }

  async function openAttackFile(file: FileRow): Promise<void> {
    const engagement = engagementOf();
    const current = snapshot.attackfiles;
    const nextId = nextDetailId(current.detail === null ? null : current.detail.id, file.id);
    if (engagement === null || nextId === null) {
      commit({ attackfiles: { ...current, detail: null } });
      return;
    }
    let response: ApiResponse;
    try {
      response = await loadAttackFile(api, engagement, nextId);
    } catch (cause) {
      commit({ attackfiles: { ...snapshot.attackfiles, error: messageOf(cause) } });
      return;
    }
    const error = responseError(response, DETAIL_FAILED);
    if (error !== null) {
      commit({ attackfiles: { ...snapshot.attackfiles, detail: null, error } });
      return;
    }
    commit({ attackfiles: { ...snapshot.attackfiles, detail: fileDetailOf(response), error: null } });
  }

  /* ────────────────────────────────────────── 提示词 */

  async function refreshPrompts(): Promise<void> {
    const engagement = engagementOf();
    commit({ prompts: { ...snapshot.prompts, busy: true } });
    let response: ApiResponse;
    try {
      response = await loadPrompts(api, engagement);
    } catch (cause) {
      commit({ prompts: { ...snapshot.prompts, busy: false, error: messageOf(cause) } });
      return;
    }
    const load = promptLoadOf(response);
    // 保持已选中的角色（`activeRoleOf`：已有选择就不动），草稿跟随服务端值。
    const active = activeRoleOf(load.roles, snapshot.prompts.active);
    commit({
      prompts: {
        ...snapshot.prompts,
        busy: false,
        error: load.error,
        data: load,
        active,
        draft: draftFor(load.roles, active),
      },
    });
  }

  async function savePromptDraft(): Promise<void> {
    const engagement = engagementOf();
    const current = snapshot.prompts;
    commit({ prompts: { ...current, busy: true, message: null } });
    let outcome: { readonly message: PromptMessage; readonly response: ApiResponse | null };
    try {
      outcome = await savePrompt(api, engagement, current.active, current.draft);
    } catch (cause) {
      commit({ prompts: { ...snapshot.prompts, busy: false, message: { kind: "err", text: messageOf(cause) } } });
      return;
    }
    if (outcome.response === null) {
      // 被前置条件拦下（无靶标 / 无角色）：不发请求，直接把原因当消息。
      commit({ prompts: { ...snapshot.prompts, busy: false, message: outcome.message } });
      return;
    }
    // 保存成功：本地先改一行（少一次往返），再回读让服务端时间戳生效。
    const patched = applySavedDraft(current.data, current.active, current.draft, nowIso());
    commit({ prompts: { ...snapshot.prompts, busy: false, message: outcome.message, data: patched } });
    await refreshPrompts();
  }

  async function resetPromptRoles(all: boolean): Promise<void> {
    const engagement = engagementOf();
    const current = snapshot.prompts;
    commit({ prompts: { ...current, busy: true, message: null } });
    let outcome: { readonly message: PromptMessage; readonly response: ApiResponse | null };
    try {
      outcome = await resetPrompts(api, engagement, current.active, all);
    } catch (cause) {
      commit({ prompts: { ...snapshot.prompts, busy: false, message: { kind: "err", text: messageOf(cause) } } });
      return;
    }
    commit({ prompts: { ...snapshot.prompts, busy: false, message: outcome.message } });
    if (outcome.response === null) return;
    await refreshPrompts();
  }

  /* ────────────────────────────────────────── 报告 */

  async function refreshReport(): Promise<void> {
    const engagement = engagementOf();
    if (engagement === null) {
      commit({ report: { ...snapshot.report, busy: false, error: REPORT_NEED_ENGAGEMENT, data: null } });
      return;
    }
    commit({ report: { ...snapshot.report, busy: true, error: null } });
    let result: { readonly data: ReportData | null; readonly error: string | null };
    try {
      result = await loadReportWithGrouping(api, engagement);
    } catch (cause) {
      result = { data: null, error: messageOf(cause) };
    }
    commit({ report: { ...snapshot.report, busy: false, error: result.error, data: result.data } });
  }

  async function downloadText(text: string, label: string): Promise<void> {
    if (deps.download === undefined) {
      commit({
        report: { ...snapshot.report, message: { kind: "err", text: "宿主未提供下载能力 —— 可先复制全文" } },
      });
      return;
    }
    let ok = false;
    let failure = "";
    try {
      ok = await deps.download(text, label);
    } catch (cause) {
      failure = downloadFailedMessage(cause);
    }
    commit({
      report: {
        ...snapshot.report,
        message: failure !== ""
          ? { kind: "err", text: failure }
          : ok
            ? { kind: "ok", text: downloadedMessage(label) }
            : { kind: "err", text: "下载失败：浏览器未授权" },
      },
    });
  }

  /* ────────────────────────────────────────── 证据截图 */

  function ensureShot(shotId: number): void {
    if (snapshot.shots.has(shotId) || shotPending.has(shotId)) return;
    const engagement = engagementOf();
    if (engagement === null) return;
    shotPending.add(shotId);
    void api.raw({ op: "shotData", engagement, id: shotId }).then(
      (response) => {
        shotPending.delete(shotId);
        const url = shotImageOf(response);
        // 取不到就不放图（不塞占位图假装有）。
        if (url === null) return;
        const next = new Map(snapshot.shots);
        next.set(shotId, url);
        commit({ shots: next });
      },
      () => {
        shotPending.delete(shotId);
      },
    );
  }

  /* ────────────────────────────────────────── 组装 */

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    engagement: engagementOf,

    refreshKnowledge,
    setKnowledgeQuery(query) {
      commit({ knowledge: { ...snapshot.knowledge, query } });
    },
    async submitKnowledge() {
      // **只检索，不动 query**：`onSubmit`（用户点检索）与 `onPage`（翻模板页）
      // 各自先把 query 改好再调这里。在这里顺手把 offset 归零会让翻页永远失效。
      await refreshKnowledge();
    },
    async setKnowledgeCategory(code) {
      commit({ knowledge: { ...snapshot.knowledge, query: queryAfterCategory(snapshot.knowledge.query, code) } });
      await refreshKnowledge();
    },
    toggleKnowledgeGrouped() {
      commit({ knowledge: { ...snapshot.knowledge, grouped: !snapshot.knowledge.grouped } });
    },
    openPoc,
    async useKnowledgeItem(item) {
      let response: ApiResponse;
      try {
        response = await usePoc(api, item.id);
      } catch (cause) {
        commit({ knowledge: { ...snapshot.knowledge, message: { kind: "err", text: messageOf(cause) } } });
        return;
      }
      const error = responseError(response, "标记失败");
      if (error !== null) {
        commit({ knowledge: { ...snapshot.knowledge, message: { kind: "err", text: error } } });
        return;
      }
      commit({ knowledge: { ...snapshot.knowledge, message: useSuccessMessage(item) } });
      // 复用次数会变：重新检索让排序生效。
      await refreshKnowledge();
    },
    async copyKnowledgeText(text, label) {
      const outcome = await copyText(text, label);
      commit({
        knowledge: { ...snapshot.knowledge, message: { kind: outcome.ok ? "ok" : "err", text: outcome.text } },
      });
    },

    refreshSkills,
    setSkillFilter(filter) {
      commit({ skills: { ...snapshot.skills, filter } });
    },
    toggleSkill,

    refreshTesting,
    setAuto(auto) {
      commit({ testing: { ...snapshot.testing, auto } });
      if (auto) {
        startPolling();
        // 打开即先取一次：否则要等 5 秒才有数据，看起来像没生效。
        void refreshTesting();
      } else {
        stopPolling();
      }
    },
    toggleTestingSection(key) {
      const current = snapshot.testing;
      const fallback = key.startsWith("testing:")
        ? SECTION_DEFAULTS.testing
        : key.startsWith("recent:")
          ? SECTION_DEFAULTS.recent
          : SECTION_DEFAULTS.queue;
      commit({ testing: { ...current, collapsed: toggleSection(current.collapsed, key, fallback) } });
    },
    expandTestingSections() {
      const engagement = engagementOf();
      if (engagement === null) return;
      commit({
        testing: {
          ...snapshot.testing,
          collapsed: setSections(snapshot.testing.collapsed, sectionKeys(engagement), true),
        },
      });
    },
    collapseTestingSections() {
      const engagement = engagementOf();
      if (engagement === null) return;
      commit({
        testing: {
          ...snapshot.testing,
          collapsed: setSections(snapshot.testing.collapsed, sectionKeys(engagement), false),
        },
      });
    },
    toggleTestingNotes(assetId) {
      const open = snapshot.testing.openNotes;
      const next = open.includes(assetId) ? open.filter((id) => id !== assetId) : [...open, assetId];
      commit({ testing: { ...snapshot.testing, openNotes: next } });
    },
    async copyTestingText(text) {
      await copyText(text, "测试记录");
    },
    dispose() {
      stopPolling();
      listeners.clear();
    },

    refreshAttackFiles,
    openAttackFile,
    setAttackFileCollapse(state) {
      commit({ attackfiles: { ...snapshot.attackfiles, collapse: state } });
    },

    refreshPrompts,
    selectPromptRole(role) {
      const load = snapshot.prompts.data;
      const roles = load === null ? [] : load.roles;
      // 换角色时草稿切到该角色的服务端正文。
      commit({ prompts: { ...snapshot.prompts, active: role, draft: draftFor(roles, role), message: null } });
    },
    setPromptDraft(draft) {
      commit({ prompts: { ...snapshot.prompts, draft } });
    },
    savePromptDraft,
    resetPromptRoles,

    refreshReport,
    async copyReportText(text, label) {
      const outcome = await copyText(text, label);
      commit({ report: { ...snapshot.report, message: copyFeedback(outcome.ok, label) } });
    },
    downloadReportText: downloadText,
    setReportCollapse(state) {
      commit({ report: { ...snapshot.report, collapse: state } });
    },
    setReportAllCollapsed(keys, open) {
      commit({ report: { ...snapshot.report, collapse: setSections(snapshot.report.collapse, keys, open) } });
    },

    shotUrl: (shotId) => snapshot.shots.get(shotId),
    ensureShot,
  };
}

/* ══════════════════════════════════════════════════════════════ props 构造 */

/**
 * 报告证据截图条。
 *
 * 结构对齐 `client/styles.ts` 里已有的 `.rt-shots` CSS 契约：
 *
 * ```
 * .rt-shots
 *   .rt-shots-head   → 「证据截图」+ 张数
 *   .rt-shot-row
 *     .rt-shot
 *       .rt-shot-thumb  (img)
 *       .rt-shot-cap    → 说明文字
 * ```
 *
 * 这几个类名与上游一致（`styles.ts` 的注释说该段落复刻自上游），
 * 自己另起一套类名会让截图**完全没有样式**（裸 `<img>` 200px 宽挤成一排）。
 *
 * **只在真能取到字节时才渲染 `<img>`**：`shotData` op 返回 base64，这里用
 * `shotDataUrl` 转成 data URL 内联，避免为图片再开一条带鉴权的路由。
 * 还没取回来的先触发一次取数并跳过（这一帧不渲染图），取回后容器通知重渲染。
 * **不放占位图**：一个灰色方块会让人以为「图坏了」。
 */
export function renderShotStrip(
  runtime: ConsoleRuntime,
  state: TabsBState,
  item: ReportItem,
): ReactNode {
  if (item.shots.length === 0) return null;
  const { h } = runtime;
  const cards: ReactNode[] = [];
  for (const shot of item.shots) {
    const url = state.shotUrl(shot.id);
    if (url === undefined) {
      state.ensureShot(shot.id);
      continue;
    }
    const label = shot.label !== "" ? shot.label : "证据截图";
    cards.push(h("div", { key: "shot" + shot.id, className: "rt-shot" },
      h("img", {
        className: "rt-shot-thumb",
        src: url,
        alt: label,
        title: shot.note !== "" ? shot.note : label,
      }),
      h("div", { className: "rt-shot-cap" },
        h("span", { className: "rt-shot-label", title: label }, label),
        shot.target !== "" ? h("span", { className: "rt-shots-n" }, shot.target) : null,
      ),
    ));
  }
  if (cards.length === 0) return null;
  return h("div", { className: "rt-shots" },
    h("div", { className: "rt-shots-head" },
      h("b", null, "证据截图"),
      h("span", { className: "rt-shots-n" },
        cards.length + " / " + item.shotTotal + " 张（每个得分点最多 3 张）"),
    ),
    h("div", { className: "rt-shot-row" }, cards),
  );
}

/**
 * 把容器状态映射成 6 个页签的 props。
 *
 * 每个回调都**接到容器的真实方法**（不是 `() => {}`）：`onRefresh` 真的重拉、
 * `onSubmit` 真的换关键词重查、`onToggleSection` 真的改折叠、`onSave` 真的提交。
 *
 * `engagement` 参数是当前靶标 id：`testing` 页签靠它区分「没选靶标」与
 * 「选了但还没数据」，两者显示完全不同的内容（前者是提示，后者是空列表）。
 */
export function propsForWithEngagement(
  runtime: ConsoleRuntime,
  state: TabsBState,
  engagement: string | null,
): TabRegistryProps {
  const snapshot = state.get();

  const knowledge = snapshot.knowledge;
  const skills = snapshot.skills;
  const testing = snapshot.testing;
  const attackfiles = snapshot.attackfiles;
  const prompts = snapshot.prompts;
  const report = snapshot.report;

  return {
    knowledge: {
      data: knowledge.data,
      query: knowledge.query,
      openId: knowledge.openId,
      // 派生：切到别的条目后 detail 不再被读到（防「显示上一条正文」）。
      detail: detailFor(knowledge.detail, knowledge.openId),
      detailBusy: knowledge.detailBusy,
      busy: knowledge.busy,
      error: knowledge.error,
      message: knowledge.message,
      grouped: knowledge.grouped,
      onQueryChange: (query) => state.setKnowledgeQuery(query),
      onSubmit: () => {
        // 用户点「检索」：换条件重查，模板分页回到第一页
        // （否则会停在旧偏移上，看到的是新结果集的第 3 页 —— 多半是空的）。
        state.setKnowledgeQuery({ ...state.get().knowledge.query, templateOffset: 0 });
        void state.submitKnowledge();
      },
      onCategoryChange: (code) => {
        void state.setKnowledgeCategory(code);
      },
      onToggleGrouped: () => state.toggleKnowledgeGrouped(),
      onOpen: (id) => {
        void state.openPoc(id);
      },
      onCopy: (text, label) => {
        void state.copyKnowledgeText(text, label);
      },
      onUse: (item) => {
        void state.useKnowledgeItem(item);
      },
      onPage: (offset) => {
        // 翻模板页：只改 offset，再检索一次（不动其它条件）。
        // **必须读 `state.get()` 而不是上面的 `knowledge`**：`knowledge` 是这次渲染
        // 开始时的快照，隔了几次 setState 之后它已经过期 —— 拿它去覆盖会把用户
        // 刚改的关键词/归类一起冲掉（实测：翻页后 offset 变成 0）。
        state.setKnowledgeQuery({ ...state.get().knowledge.query, templateOffset: offset });
        void state.submitKnowledge();
      },
    },
    skills: {
      catalog: skills.data,
      filter: skills.filter,
      activeKey: skills.activeKey,
      detail: skills.detail,
      busy: skills.busy,
      detailBusy: skills.detailBusy,
      onRefresh: (force) => {
        void state.refreshSkills(force);
      },
      onFilterChange: (filter) => state.setSkillFilter(filter),
      onToggle: (item) => {
        void state.toggleSkill(item);
      },
    },
    testing: {
      engagement,
      data: testing.data,
      error: testing.error,
      updatedAt: testing.updatedAt,
      auto: testing.auto,
      collapsed: testing.collapsed,
      onRefresh: () => {
        void state.refreshTesting();
      },
      // 读 `state.get()` 而不是这次渲染的 `testing` 快照：连点两次时旧快照的
      // `auto` 不会变，会把两次点击都算成「打开」（实测：点两下仍停在「实时」）。
      onToggleAuto: () => state.setAuto(!state.get().testing.auto),
      onToggleSection: (key) => state.toggleTestingSection(key),
      onExpandAll: () => state.expandTestingSections(),
      onCollapseAll: () => state.collapseTestingSections(),
      openNotes: testing.openNotes,
      onToggleNotes: (assetId) => state.toggleTestingNotes(assetId),
      onCopy: (text) => {
        void state.copyTestingText(text);
      },
    },
    attackfiles: {
      folders: attackfiles.data ?? [],
      detail: attackfiles.detail,
      error: attackfiles.error,
      busy: attackfiles.busy,
      collapse: attackfiles.collapse,
      onRefresh: () => {
        void state.refreshAttackFiles();
      },
      onOpenFile: (file) => {
        void state.openAttackFile(file);
      },
      onCollapseChange: (next) => state.setAttackFileCollapse(next),
    },
    prompts: {
      catalog: prompts.data,
      active: prompts.active,
      draft: prompts.draft,
      message: prompts.message,
      busy: prompts.busy,
      onRefresh: () => {
        void state.refreshPrompts();
      },
      onSelect: (role) => state.selectPromptRole(role),
      onDraftChange: (draft) => state.setPromptDraft(draft),
      onSave: () => {
        void state.savePromptDraft();
      },
      onReset: (all) => {
        void state.resetPromptRoles(all);
      },
    },
    report: {
      data: report.data,
      error: report.error,
      message: report.message,
      busy: report.busy,
      collapse: report.collapse,
      // 截图槽：`shotData` 返 base64，真能取到字节 —— 所以真的实现，
      // 而不是传一个返回空 div 的假函数。
      renderShots: (item) => renderShotStrip(runtime, state, item),
      onRefresh: () => {
        void state.refreshReport();
      },
      onCopy: (text, label) => {
        void state.copyReportText(text, label);
      },
      onDownload: (text, label) => {
        void state.downloadReportText(text, label);
      },
      onCollapseChange: (next) => state.setReportCollapse(next),
      onSetAllCollapsed: (keys, open) => state.setReportAllCollapsed(keys, open),
    },
  };
}

/** 便捷入口：靶标取容器自己记的那一个。 */
export function propsFor(runtime: ConsoleRuntime, state: TabsBState): TabRegistryProps {
  return propsForWithEngagement(runtime, state, state.engagement());
}

/**
 * 首屏取数（6 个页签各一次）。
 *
 * 分开导出而不是塞进 `makeTabsBState`：容器可能想在挂载前就预热，
 * 也可能想在重连后只重取某几个 —— 让调用方决定。
 */
export function loadAll(state: TabsBState): void {
  void state.refreshKnowledge();
  void state.refreshSkills(false);
  void state.refreshTesting();
  void state.refreshAttackFiles();
  void state.refreshPrompts();
  void state.refreshReport();
}

/* ══════════════════════════════════════════════════════════════ React 胶水 */

/** `makeTabsBSlot` 的额外依赖（`api` / `engagement` / `notify` 由它自己给）。 */
export type TabsBSlotExtra = Omit<TabsBDeps, "api" | "engagement" | "notify">;

/**
 * 造一个可直接传给 `ConsoleInit.tabProps` 的槽。
 *
 * 职责只有三件：挂载时首屏取数、靶标变化时重取、把容器变更变成一次 `setState`。
 * **取数逻辑一行都不在这里** —— 全在 `makeTabsBState` 里，所以那部分能在没有
 * React 的测试里跑完。
 *
 * ```ts
 * makeConsoleModule({
 *   ...,
 *   tabProps: makeTabsBSlot(runtime, makeApiClient({ fetch }), () => currentEngagement),
 * })
 * ```
 */
export function makeTabsBSlot(
  runtime: ConsoleRuntime,
  api: ApiClient,
  engagement: () => string | null,
  extra: TabsBSlotExtra = {},
): () => TabRegistryProps {
  const React = runtime.React;
  /** 容器只造一次（每次渲染都重建会把状态全丢掉）。 */
  let cached: TabsBState | null = null;
  /** 上一次取数用的靶标（变化 = 要重取）。 */
  let loadedFor: string | null | undefined = undefined;

  return function tabsBProps(): TabRegistryProps {
    const [, setVersion] = React.useState(0);
    const current = engagement();

    if (cached === null) {
      cached = makeTabsBState({
        ...extra,
        api,
        engagement,
        notify: () => setVersion((value) => value + 1),
      });
    }
    const state = cached;

    React.useEffect(() => {
      if (loadedFor === undefined) {
        // 首屏：6 个页签各取一次。失败各自进 error，互不影响。
        loadedFor = current;
        loadAll(state);
        return;
      }
      if (loadedFor !== current) {
        // 靶标变了：清掉依赖靶标的页签并重取（知识库是全局的，也一起刷）。
        loadedFor = current;
        void state.refreshTesting();
        void state.refreshAttackFiles();
        void state.refreshPrompts();
        void state.refreshReport();
        void state.refreshKnowledge();
      }
    }, [current, state]);

    return propsForWithEngagement(runtime, state, current);
  };
}

/* ══════════════════════════════════════════════════════════════ 未能接线 */

/**
 * `agents` 页签为什么这里没接（如实记录）。
 *
 * `tab-registry.ts` 的 `TabRegistryProps` 里**没有 `agents` 字段**，
 * 分派分支是：
 *
 * ```ts
 * case "agents": {
 *   // 智能体概览属于插件生命周期层（`src/plugin/`），不在客户端渲染。
 *   return empty(tab);
 * }
 * ```
 *
 * 它**无条件**返回「智能体概览未接入」，不读任何 props；`client/` 下也没有
 * `agents-tab.ts`（没有 `AgentsTabProps` 这个类型）。要接它必须同时改
 * `client/tab-registry.ts` 并新增一个页签渲染器 —— 两者都在本任务的写入域之外
 * （`client/**` 明确不许改）。
 *
 * 数据侧是**齐的**：网关的 `agentsStatus` op（`ui/gateway.ts` 的
 * `handleAgentsStatus`）返回 `{ max, used, free, running, total_children, source }`。
 * 所以这是**纯前端缺口**，不是后端缺口。
 *
 * 本文件因此不提供 `agents` 的 props，也不写「只返回空 div 的假函数」凑数 ——
 * 那会让人以为已经接了，而页面上什么都没变。
 */
export const AGENTS_NOT_WIRED_REASON =
  "agents 页签在 tab-registry.ts 里无 props 槽位，client/ 下也无对应渲染器；"
  + "后端 agentsStatus op 已就绪，缺的是前端槽位（属 client/** 写入域，本任务不改）。";

/* ══════════════════════════════════════════════════════════════ 诊断 */

/** 本文件实际接线的页签 id（不含 `agents`，理由见上）。 */
export const TABS_B_WIRED: readonly ConsoleTabId[] = Object.freeze([
  "knowledge",
  "skills",
  "testing",
  "attackfiles",
  "prompts",
  "report",
]);

/**
 * 每个页签实际用到的 op。
 *
 * 报告与诊断据此核对，**不靠记忆**。注意两处与任务书的差异（都是读 `dispatch.ts`
 * 后按实际返回形状定的）：
 * - `report` 用 `scoreReport`（不是 `report`）+ `scoreChain`（补阶段分组时）
 *   —— `report-tab.ts` 的 `loadReport` 就是发 `scoreReport`。
 * - `skills` 用 `skillCatalog` / `skillRead`：它们是**网关 op**
 *   （`ui/gateway.ts`），走的是同一条 `/redteam/api`，所以前端拿得到。
 */
export const TABS_B_OPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  knowledge: Object.freeze(["pocSearch", "pocGet", "pocUse"]),
  skills: Object.freeze(["skillCatalog", "skillRead"]),
  testing: Object.freeze(["activeTests"]),
  attackfiles: Object.freeze(["attackFiles", "readAttackFile"]),
  prompts: Object.freeze(["prompts", "savePrompt", "resetPrompts"]),
  report: Object.freeze(["scoreReport", "scoreChain", "shotData"]),
});

/** 供容器判断「这个 op 是不是我这组负责」（未知 op 一律 `false`）。 */
export function tabBOwnsOp(op: string): boolean {
  for (const ops of Object.values(TABS_B_OPS)) {
    if (ops.includes(op)) return true;
  }
  return false;
}

/** 重新导出：测试构造假响应时复用同一套解析（不另写一份）。 */
export { reportDataOf };
