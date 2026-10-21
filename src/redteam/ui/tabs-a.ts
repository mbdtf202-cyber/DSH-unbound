/**
 * A 组六个页签的**取数与状态**接线：
 * 资产测绘 / 会话隧道 / 漏洞战果 / 攻击链 / 得分目标 / 环境适配。
 *
 * ## 这一层在整条链上的位置
 *
 * ```
 * 宿主 fetch ──► client/api.ts (makeApiClient, 永不 reject)
 *                     │
 *                     ▼
 *           ┌─────────────────────┐
 *           │  本文件 tabs-a.ts    │  ← 唯一的「有状态」层
 *           │  取数 + 状态 + 回调   │
 *           └─────────────────────┘
 *                     │  props（纯值 + 真回调）
 *                     ▼
 *        client/*-tab.ts  renderXxxTab(runtime, props)   ← 纯函数
 *                     │
 *                     ▼
 *            client/*-model.ts   响应 → props 值的转换（已存在，直接复用）
 * ```
 *
 * **本文件不发明任何数据结构**。`client/*-model.ts`（约 18,275 行测试撑着）
 * 已经写好了「响应 → props 值」的全部转换（`assetListOf` / `sessionDataOf` /
 * `findingsOf` / `chainDataOf` / `scoreBoardOf` / `draftFromResponse` …）与
 * 全部请求构造（`assetsRequest` / `sessionsRequest` / `scoresRequest` …）。
 * 这里只做三件事：
 *
 * 1. 调 `api.raw(...)` 拿响应，喂给上面那些转换函数；
 * 2. 把结果存进一份不可变 state，并在变化时通知订阅者；
 * 3. 把 state 与**真的会生效的回调**拼成每个页签要求的 props。
 *
 * ## 为什么是「工厂 + 显式 state」而不是 React 组件
 *
 * 页签本身是纯函数（无 hook），所以「状态放哪」是自由的。放这里的好处：
 * 取数逻辑可以脱离 React 直接测（喂假 fetch → 断言 state → 断言渲染文本），
 * 而容器只需要 `subscribe()` + 重新渲染。这与 `client/` 里 3,700+ 用例
 * 的组织方式一致。
 *
 * ## 三条实现纪律
 *
 * 1. **不塞空函数**。每个 `onXxx` 都真的改 state 或真的发请求 ——
 *    `() => {}` 能骗过类型检查，但等于没接（本任务的意义就在这）。
 * 2. **拿不到的宿主能力如实降级**。`renderTesting` / `attackFilesNode` /
 *    剪贴板这类需要别的页签或宿主注入的东西，缺了就让它 `undefined` 走
 *    页签自己的空态，**不造假数据**。见文末「未填满的 props」。
 * 3. **零 `any`**。不可信响应一律 `unknown` + 窄化，与 `assets-model.ts` 同风格。
 *
 * ## 模块顶层零副作用
 *
 * `client.js` 的构建产物要求**两次构建字节一致**。所以本模块在顶层
 * 只允许 `const` 字面量与 `function` 声明：没有 `Date.now()` /
 * `Math.random()` / `Object.keys()` 拼串 / 任何 I/O。
 * 时间只在函数体内取（运行时的值不进产物字节）。
 */

import type { FetchLike, MinimalWindow } from "../client/dom.js";
import type { ConsoleTabId } from "../client/state.js";
import { setSections, toggleSection } from "../client/state.js";
import type { TabRegistryProps } from "../client/tab-registry.js";
import { makeApiClient, type ApiClient, type ApiResponse } from "../client/api.js";

/* ── 定时器的最小声明 ──────────────────────────────────────────────────
 *
 * 本文件会被打进**浏览器产物**（`scripts/build-client.mjs` 的 AMD 构建），
 * 那个 tsconfig 是 `lib: ["ES2020"]` + `types: []` —— 既没有 DOM 也没有 Node，
 * 所以 `setTimeout` 在那里**根本不存在**，裸用会 `TS2304: Cannot find name`。
 * 而 Node 侧的 `tsconfig.json` 有 `types: ["node"]`，能过。
 *
 * 这就是「本地绿、产物构建红」的典型来源，`artifact.test.ts` 的
 * 「两次构建字节一致」用例正是靠这一点抓到的。
 *
 * 处理方式与 `client/dom.ts` 一致：**手写最小声明**，不引入整个 `lib.dom`
 * （那会把 `fetch` / `document` 等一大堆全局塞进来，与本项目"显式最小"
 * 的原则冲突，也容易和 `dom.ts` 自己的声明打架）。
 *
 * 声明成可选：运行时用 `typeof setTimeout === "function"` 判存在，
 * 宿主没有定时器时静默跳过（见下方 `schedule`）。
 */
declare const setTimeout: ((fn: () => void, ms: number) => unknown) | undefined;

/* ── 资产测绘 ─────────────────────────────────────────────────────────── */
import {
  DEFAULT_ASSET_FILTER,
  applyConclusion,
  assetRequest,
  assetDetailOf,
  assetListOf,
  discoveryOf,
  discoveryRequest,
  domainGroupsOf,
  domainsRequest,
  loadAssets,
  loadAssetDetail,
  loadDiscovery,
  loadDomains,
  loadWebAssets,
  webAssetsOf,
  webRequest,
  type AssetFilter,
  type AssetItem,
  type AssetListState,
  type AssetScope,
  type AssetViewKind,
  type ConclusionKey,
  type DiscoveryData,
  type DomainGroup,
  type WebAsset,
} from "../client/assets-model.js";
import type { AssetsTabProps } from "../client/assets-tab.js";
import { EMPTY_ASSET_LIST } from "../client/assets-model.js";

/* ── 会话隧道 ─────────────────────────────────────────────────────────── */
import {
  COPIED_RESET_MS,
  copyMessage,
  loadSessions,
  markShell,
  markTunnel,
  probeSessions,
  type ProbeSummary,
  type SessionData,
} from "../client/session-model.js";
import type { SessionTabProps } from "../client/session-tab.js";

/* ── 漏洞战果 ─────────────────────────────────────────────────────────── */
import {
  EMPTY_FINDINGS,
  findingsOf,
  type AccessRow,
  type AttackFileGroup,
  type CredentialRow,
  type FindingsSubTab,
  type FindingsList,
  type VulnStatus,
} from "../client/findings-model.js";
import {
  DEFAULT_FINDINGS_FILTER,
  loadFindings,
  loadSideLists,
  updateVulnStatus,
  type FindingsFilter,
  type FindingsMessage,
  type FindingsTabProps,
} from "../client/findings-tab.js";

/* ── 攻击链 ───────────────────────────────────────────────────────────── */
import { chainDataOf, type ChainData, type ChainView } from "../client/chain-model.js";
import { chainErrorOf, loadChain, nextView, toggleHitOpen, type ChainTabProps } from "../client/chain-tab.js";

/* ── 得分目标 ─────────────────────────────────────────────────────────── */
import {
  editFormOf,
  loadScores,
  newScoreForm,
  removeScorePoint,
  saveScorePoint,
  shouldSkipDelete,
  type FormMessage,
  type ScoreBoard,
  type ScoreForm,
  type ScorePoint,
} from "../client/score-model.js";
import type { ScoreTabProps } from "../client/score-tab.js";

/* ── 环境适配 ─────────────────────────────────────────────────────────── */
import {
  assignEnv,
  refreshDraftFrom,
  saveEnv,
  type EnvTabProps,
} from "../client/env-tab.js";
import {
  assignedMessage,
  draftFromResponse,
  savedMessage,
  type EnvDraft,
  type FormMessage as EnvFormMessage,
} from "../client/env-model.js";

/* ══════════════════════════════════════════════════════════════ 窄化原语 */

/** 从不可信值读对象（数组 / `null` 都算没有）。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从不可信值读字符串。 */
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* ══════════════════════════════════════════════════════════════ 依赖 */

/**
 * 复制文本的能力。
 *
 * 剪贴板是**宿主能力**（要 `navigator.clipboard` 或 `document.execCommand`），
 * 不是本层能凭空造的东西。返回 `true` 表示真的复制成功 —— 页签据此显示
 * 「已复制」；返回 `false` 就显示模型层那句真实的失败文案
 * （`复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制`）。
 *
 * 允许返回 Promise：`navigator.clipboard.writeText` 本来就是异步的。
 */
export type CopyFn = (text: string) => boolean | Promise<boolean>;

/** 工厂依赖。 */
export interface TabsADeps {
  /** 宿主 `window.fetch`（首选；测试里喂假 fetch 即可驱动全部取数）。 */
  readonly fetch?: FetchLike | undefined;
  /** 已造好的客户端（高级用法；给了就优先用它，忽略 `fetch`）。 */
  readonly api?: ApiClient | undefined;
  /** 复制能力；缺省时复制一律失败（页签显示真实失败文案，不撒谎）。 */
  readonly copyText?: CopyFn | undefined;
  /** 当前靶标；可在运行时通过 `setEngagement` 换。 */
  readonly engagement?: string | null | undefined;
  /** 每次 state 变化后回调（容器据此重渲染）。 */
  readonly onChange?: (() => void) | undefined;
}

/** 用注入的 window 造一个真实的复制实现（控制台容器可直接用）。 */
export function makeWindowCopy(windowRef: MinimalWindow): CopyFn {
  return (text: string): Promise<boolean> => {
    const clipboard = windowRef.navigator?.clipboard;
    if (clipboard !== undefined) {
      return clipboard.writeText(text).then(() => true, () => false);
    }
    // 老浏览器 / 无 navigator：退回 textarea + execCommand('copy')。
    try {
      const control = windowRef.document.createElement("textarea");
      control.value = text;
      control.setAttribute("readonly", "");
      control.style.position = "fixed";
      control.style.left = "-9999px";
      windowRef.document.body.appendChild(control);
      control.select();
      const ok = windowRef.document.execCommand("copy");
      windowRef.document.body.removeChild(control);
      return Promise.resolve(ok);
    } catch {
      return Promise.resolve(false);
    }
  };
}

/* ══════════════════════════════════════════════════════════════ 各页签 state */

/** 资产测绘 state。 */
export interface AssetsState {
  readonly snapshot: unknown;
  readonly filter: AssetFilter;
  readonly searchDraft: string;
  readonly view: AssetViewKind;
  readonly list: AssetListState | null;
  readonly domains: readonly DomainGroup[] | null;
  readonly web: readonly WebAsset[] | null;
  readonly detail: AssetItem | null;
  readonly openId: number | null;
  readonly showAllId: number | null;
  readonly notesOpen: boolean;
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly discovery: DiscoveryData | null;
  readonly discoveryError: string | null;
  readonly discoveryDay: string;
  readonly loading: boolean;
}

/** 会话隧道 state。 */
export interface SessionsState {
  readonly data: SessionData | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly message: { readonly err?: string; readonly ok?: string } | null;
  readonly copied: string | null;
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly probe: ProbeSummary | null;
}

/** 漏洞战果 state。 */
export interface FindingsState {
  readonly findings: FindingsList | null;
  readonly credentials: readonly CredentialRow[];
  readonly accesses: readonly AccessRow[];
  readonly fileGroups: readonly AttackFileGroup[];
  readonly filter: FindingsFilter;
  readonly subTab: FindingsSubTab;
  readonly grouped: boolean;
  readonly openId: number | null;
  readonly collapse: Readonly<Record<string, boolean>>;
  readonly message: FindingsMessage | null;
  readonly busy: boolean;
}

/** 攻击链 state。 */
export interface ChainState {
  readonly data: ChainData | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly view: ChainView;
  readonly openId: number | null;
}

/** 得分目标 state。 */
export interface ScoreState {
  readonly board: ScoreBoard | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly openId: number | null;
  readonly form: ScoreForm | null;
  readonly message: FormMessage | null;
}

/** 环境适配 state。 */
export interface EnvState {
  readonly draft: EnvDraft | null;
  readonly data: ApiResponse | null;
  readonly error: string | null;
  readonly message: EnvFormMessage | null;
  readonly busy: boolean;
  readonly folderPath: string;
}

/** 六个页签的完整 state。 */
export interface TabsAState {
  readonly engagement: string | null;
  readonly assets: AssetsState;
  readonly sessions: SessionsState;
  readonly findings: FindingsState;
  readonly chain: ChainState;
  readonly scores: ScoreState;
  readonly env: EnvState;
}

/** 初始 state：全部 `null` = 各页签走自己的空态（不是白屏）。 */
export function initialState(engagement: string | null = null): TabsAState {
  return {
    engagement,
    assets: {
      snapshot: null,
      filter: DEFAULT_ASSET_FILTER,
      searchDraft: "",
      view: "list",
      list: null,
      domains: null,
      web: null,
      detail: null,
      openId: null,
      showAllId: null,
      notesOpen: false,
      collapsed: {},
      discovery: null,
      discoveryError: null,
      discoveryDay: "",
      loading: false,
    },
    sessions: {
      data: null,
      error: null,
      busy: false,
      message: null,
      copied: null,
      collapsed: {},
      probe: null,
    },
    findings: {
      findings: null,
      credentials: [],
      accesses: [],
      fileGroups: [],
      filter: DEFAULT_FINDINGS_FILTER,
      subTab: "vulns",
      grouped: true,
      openId: null,
      collapse: {},
      message: null,
      busy: false,
    },
    chain: {
      data: null,
      error: null,
      loading: false,
      view: "A",
      openId: null,
    },
    scores: {
      board: null,
      error: null,
      busy: false,
      openId: null,
      form: null,
      message: null,
    },
    env: {
      draft: null,
      data: null,
      error: null,
      message: null,
      busy: false,
      folderPath: "",
    },
  };
}

/* ══════════════════════════════════════════════════════════════ 工厂 */

/** A 组接线器的对外面。 */
export interface TabsA {
  /** 读当前 state（渲染时用，非 hook）。 */
  readonly state: () => TabsAState;
  /** 订阅变化，返回退订函数。 */
  readonly subscribe: (listener: () => void) => () => void;
  /** 换靶标（会清掉上一靶标的数据，避免串台）。 */
  readonly setEngagement: (engagement: string | null) => void;

  /** 单个页签的 props（回调已接真）。 */
  readonly assetsProps: () => AssetsTabProps;
  readonly sessionsProps: () => SessionTabProps;
  readonly findingsProps: () => FindingsTabProps;
  readonly chainProps: () => ChainTabProps;
  readonly scoresProps: () => ScoreTabProps;
  readonly envProps: () => EnvTabProps;

  /** 只装某个页签的 `TabRegistryProps`（切页签时用，减少无用数据）。 */
  readonly propsFor: (tab: ConsoleTabId) => TabRegistryProps;
  /** 六个页签一起装（一次给全）。 */
  readonly allProps: () => TabRegistryProps;

  /** 为某个页签取数（切页签时调）。不属本组的页签是 no-op。 */
  readonly load: (tab: ConsoleTabId) => Promise<void>;
  /** 取全部六页签（首屏并行）。 */
  readonly loadAll: () => Promise<void>;

  readonly loadAssets: () => Promise<void>;
  readonly loadSessions: () => Promise<void>;
  readonly loadFindings: () => Promise<void>;
  readonly loadChain: () => Promise<void>;
  readonly loadScores: () => Promise<void>;
  readonly loadEnv: () => Promise<void>;
}

/** 本组负责的页签（顺序即首屏取数顺序）。 */
export const TABS_A_OWNED: readonly ConsoleTabId[] = Object.freeze([
  "assets",
  "sessions",
  "findings",
  "chain",
  "scores",
  "env",
]);

/** 是否是本组负责的页签。 */
export function ownsTab(tab: ConsoleTabId): boolean {
  return TABS_A_OWNED.includes(tab);
}

/**
 * **已知的服务端形状问题，本层垫平。**
 *
 * `platformConfigGet` / `platformConfigSave` / `platformAssignToolkit` 三个
 * op 的响应把 `platformSummary` 包在 `platform` 下：
 *
 * ```json
 * { "ok": true, "platform": { "config": {...}, "runtime": {...},
 *                            "tools": {...}, "adapt": {...}, "egress": {...},
 *                            "hint": "...", "toolkitDir": "...",
 *                            "nucleiTemplatesDir": "..." } }
 * ```
 *
 * 而 `env-model.ts` 的 `draftFromResponse` / `toolsOf` / `summaryOf` /
 * `egressOf` / `savedMessage` 都按**扁平**形态读（`response.config` …）。
 * 两者差一层，不展开的后果是：草稿全空、工具全「未找到」、保存消息
 * 永远退化成 `$DSH_HOME/...` 默认路径（都是静默错，界面上看不出来）。
 *
 * ## 这是垫层，不是设计
 *
 * 服务端 `dispatch` 返回 `{ok, platform:{...}}`；本层展开成扁平
 * `{ok, config, tools, adapt}`。**若将来 `src/redteam/store/dispatch.ts`
 * 改为直接展开**（`{ok:true, ...platformSummary()}），本函数应退化为
 * 恒等并删除 —— 这两条路只走一条，别两边都做（那会变成两份真相）。
 *
 * 之所以把展开放在**接线层**而不是改 `env-model.ts`：model 的扁平假设
 * 已被 `env-tab.test.ts` 的夹具与 77 个用例钉死，且它描述的其实是
 * **正确**的契约（响应本该扁平），只是服务端没做到。
 *
 * 回归防线：`tabs-a.test.ts` 有专门用例断言「保存消息要带真实路径、
 * 不许退化成 `$DSH_HOME`」，删掉本函数会让那条用例变红。
 *
 * 记录此事的常量：`UNFILLED_PROPS` 同级的 `KNOWN_SHAPE_GAPS`。
 */
export function flattenPlatform(response: ApiResponse): ApiResponse {
  if (response.ok === false) return response;
  const platform = response["platform"];
  if (typeof platform !== "object" || platform === null || Array.isArray(platform)) {
    return response;
  }
  const body = recordOf(platform);
  // 展开体覆盖外层，但保留 `ok`（外层为真时以它为真）。
  return { ...response, ...body, ok: response.ok };
}

/** 造 A 组接线器。 */
export function makeTabsA(deps: TabsADeps): TabsA {
  const api: ApiClient = deps.api ?? makeApiClient({ fetch: requireFetch(deps) });
  const copyFn: CopyFn = deps.copyText ?? (() => false);

  let state: TabsAState = initialState(deps.engagement ?? null);
  const listeners = new Set<() => void>();

  /* ── 状态读写 ─────────────────────────────────────────────────────── */

  const emit = (): void => {
    deps.onChange?.();
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        /* 一个坏订阅者不该让整块界面停摆（与 runtime 的 ui store 同策略） */
      }
    }
  };

  const patch = (next: Partial<TabsAState>): void => {
    state = { ...state, ...next };
    emit();
  };

  const patchAssets = (next: Partial<AssetsState>): void => {
    patch({ assets: { ...state.assets, ...next } });
  };
  const patchSessions = (next: Partial<SessionsState>): void => {
    patch({ sessions: { ...state.sessions, ...next } });
  };
  const patchFindings = (next: Partial<FindingsState>): void => {
    patch({ findings: { ...state.findings, ...next } });
  };
  const patchChain = (next: Partial<ChainState>): void => {
    patch({ chain: { ...state.chain, ...next } });
  };
  const patchScores = (next: Partial<ScoreState>): void => {
    patch({ scores: { ...state.scores, ...next } });
  };
  const patchEnv = (next: Partial<EnvState>): void => {
    patch({ env: { ...state.env, ...next } });
  };

  /** 当前靶标 id（空串 = 没选）。 */
  const eng = (): string => state.engagement ?? "";

  /** 复制并回调结果（同步实现与 Promise 实现都支持）。 */
  const runCopy = (text: string, done: (ok: boolean) => void): void => {
    let result: boolean | Promise<boolean>;
    try {
      result = copyFn(text);
    } catch {
      done(false);
      return;
    }
    if (typeof result === "boolean") {
      done(result);
      return;
    }
    void Promise.resolve(result).then(done, () => done(false));
  };

  /* ══════════════════════════════════════════════════════════ 资产测绘 */

  /**
   * 读快照（`segments` / `stats` / `tests`）与资产列表。
   *
   * 两个请求并行：快照管侧栏与结论行，列表管主表，互不阻塞。
   * **快照失败不影响列表**；只有列表也失败时错误才二选一显示 ——
   * 页签的 `error` 只从 `props.list.error` 读（没有第二个错误槽）。
   */
  const loadAssetsFn = async (): Promise<void> => {
    const engagement = eng();
    if (engagement === "") {
      patchAssets({ list: null, snapshot: null, loading: false });
      return;
    }
    patchAssets({ loading: true });
    const filter = state.assets.filter;
    const [snapshotResponse, listResult] = await Promise.all([
      api.raw({ op: "snapshot", engagement }),
      loadAssets(api, engagement, filter),
    ]);
    const snapshotOk = snapshotResponse.ok !== false;
    const list = listResult.ok
      ? listResult.value
      : { ...EMPTY_ASSET_LIST, error: listResult.error };

    // 快照失败但列表成功：把快照的错误挂到列表错误槽上，否则它会静默消失
    // （侧栏全是 0，用户看不出是「没有资产」还是「快照没读回来」）。
    const withSnapshotError: AssetListState = snapshotOk || list.error !== null
      ? list
      : { ...list, error: snapshotResponse.error ?? "读取快照失败" };

    patchAssets({
      loading: false,
      snapshot: snapshotOk ? snapshotResponse : null,
      list: withSnapshotError,
    });
  };

  /** 按当前视图懒加载域名 / Web / 发现时间线（切到该视图才拉）。 */
  const loadAssetsView = async (view: AssetViewKind): Promise<void> => {
    const engagement = eng();
    if (engagement === "") return;
    const cidr = state.assets.filter.cidr;
    if (view === "domain") {
      const result = await loadDomains(api, engagement, cidr);
      patchAssets({ domains: result.ok ? result.value : [] });
      return;
    }
    if (view === "web") {
      const result = await loadWebAssets(api, engagement, cidr);
      patchAssets({ web: result.ok ? result.value : [] });
      return;
    }
    if (view === "timeline") {
      const result = await loadDiscovery(api, engagement);
      patchAssets(
        result.ok
          ? { discovery: result.value, discoveryError: null }
          : { discovery: null, discoveryError: result.error },
      );
    }
  };

  const assetsProps = (): AssetsTabProps => {
    const s = state.assets;
    return {
      engagement: state.engagement,
      snapshot: s.snapshot,
      filter: s.filter,
      searchDraft: s.searchDraft,
      view: s.view,
      list: s.list,
      domains: s.domains,
      web: s.web,
      detail: s.detail,
      openId: s.openId,
      showAllId: s.showAllId,
      notesOpen: s.notesOpen,
      collapsed: s.collapsed,
      discovery: s.discovery,
      discoveryError: s.discoveryError,
      discoveryDay: s.discoveryDay,
      // `renderTesting` 需要 TestingTabProps（另一个页签的域）。留空 → 页签渲染
      // 自己的「当前测试页面未接线」空态，不造假内容。见文末「未填满的 props」。

      onFilterChange: (filter) => {
        // 过滤条件变化 = 重新查询（`onSort` 改排序也走这里，会真的重查）。
        patchAssets({ filter, openId: null });
        void loadAssetsFn();
      },
      onSearchDraftChange: (value) => {
        // 只改草稿，不发请求（回车/点「搜索」才生效，与页签的 q / qApplied 一致）。
        patchAssets({ searchDraft: value });
      },
      onSearch: () => {
        patchAssets({ filter: { ...state.assets.filter, query: state.assets.searchDraft } });
        void loadAssetsFn();
      },
      onViewChange: (view) => {
        patchAssets({ view });
        void loadAssetsView(view);
      },
      onToggleRow: (id) => {
        if (state.assets.openId === id) {
          patchAssets({ openId: null, detail: null });
          return;
        }
        patchAssets({ openId: id, detail: null });
        const engagement = eng();
        if (engagement === "") return;
        void loadAssetDetail(api, engagement, id).then((result) => {
          // 响应慢于切换时不要把上一台的详情贴到下一台下面（模型层已定此语义）。
          if (state.assets.openId !== id) return;
          patchAssets({ detail: result.ok ? result.value : null });
        });
      },
      onToggleShowAll: (id) => patchAssets({ showAllId: id }),
      onToggleNotes: () => patchAssets({ notesOpen: !state.assets.notesOpen }),
      onToggleSideGroup: (scope: AssetScope) => {
        const key = "scope:" + scope;
        patchAssets({ collapsed: toggleSection(state.assets.collapsed, key) });
      },
      onDiscoveryDayChange: (day) => patchAssets({ discoveryDay: day }),
      onDomainAssetClick: (ip) => {
        // 点域名下的一台资产 → 回列表并搜索该 IP（与原始交互一致）。
        patchAssets({
          view: "list",
          searchDraft: ip,
          filter: { ...state.assets.filter, query: ip },
        });
        void loadAssetsFn();
      },
      onRefresh: () => {
        void loadAssetsFn();
        void loadAssetsView(state.assets.view);
      },
      onCopy: (text) => {
        runCopy(text, () => undefined);
      },
    };
  };

  /* ══════════════════════════════════════════════════════════ 会话隧道 */

  /**
   * `op: sessions` 一次给出 WebShell、隧道与一屏计数
   * （`store.sessionSummary` 已经把三张表并好了），
   * 所以**不再单独调** `webshells` / `tunnels` —— 两个来源会打架。
   */
  const loadSessionsFn = async (): Promise<void> => {
    const engagement = eng();
    if (engagement === "") {
      patchSessions({ data: null, error: null, busy: false });
      return;
    }
    patchSessions({ busy: true });
    const result = await loadSessions(api, engagement);
    patchSessions({
      busy: false,
      data: result.ok ? result.value : null,
      error: result.ok ? null : result.error,
    });
  };

  const sessionsProps = (): SessionTabProps => {
    const s = state.sessions;
    return {
      engagement: state.engagement,
      data: s.data,
      error: s.error,
      busy: s.busy,
      message: s.message,
      copied: s.copied,
      collapsed: s.collapsed,
      onRefresh: () => {
        patchSessions({ message: null, copied: null });
        void loadSessionsFn();
      },
      onProbe: () => {
        const engagement = eng();
        if (engagement === "") return;
        patchSessions({ busy: true, message: null });
        void probeSessions(api, engagement).then((result) => {
          patchSessions(
            result.ok
              ? {
                  probe: result.value,
                  // `ProbeSummary.message` 已经是现成的摘要文案
                  //（"检测完成：WebShell 在线 2/3，隧道可用 1/2"）。
                  message: { ok: result.value.message },
                }
              : { message: { err: result.error } },
          );
          // 探测会回写 status / last_check，所以必须重读一遍。
          void loadSessionsFn();
        });
      },
      onToggleSection: (key) => {
        patchSessions({ collapsed: toggleSection(state.sessions.collapsed, key) });
      },
      onMarkShell: (shell, status) => {
        const engagement = eng();
        if (engagement === "") return;
        void markShell(api, engagement, shell.id, status).then((result) => {
          patchSessions({ message: result.ok ? { ok: "已标记该 WebShell" } : { err: result.error } });
          void loadSessionsFn();
        });
      },
      onMarkTunnel: (tunnel, status) => {
        const engagement = eng();
        if (engagement === "") return;
        void markTunnel(api, engagement, tunnel.id, status).then((result) => {
          patchSessions({ message: result.ok ? { ok: "已标记该隧道" } : { err: result.error } });
          void loadSessionsFn();
        });
      },
      onCopy: (key, text, label) => {
        runCopy(text, (ok) => {
          patchSessions({
            // 复制失败时**不点亮**按钮（原实现记过的 bug：失败也显示「已复制」）。
            copied: ok ? key : null,
            message: { ...(ok ? { ok: copyMessage(true, label) } : { err: copyMessage(false, label) }) },
          });
          if (!ok) return;
          // 自己在 COPIED_RESET_MS 后撤销高亮；不依赖宿主定时器一定可用。
          schedule(() => {
            if (state.sessions.copied === key) patchSessions({ copied: null });
          }, COPIED_RESET_MS);
        });
      },
    };
  };

  /* ══════════════════════════════════════════════════════════ 漏洞战果 */

  /**
   * 漏洞列表与三张附属表并行读。
   *
   * `op: vulns` 的响应里**已经带** `stats`（`dispatch` 里
   * `{ ok:true, stats: store.vulnStats(id), ...store.listVulns(...) }`），
   * 所以不再单独调 `vulnStats` —— 同一份数字取两次没有意义。
   */
  const loadFindingsFn = async (): Promise<void> => {
    const engagement = eng();
    if (engagement === "") {
      patchFindings({ findings: null, busy: false });
      return;
    }
    patchFindings({ busy: true });
    const [vulnResponse, side] = await Promise.all([
      loadFindings(api, engagement, state.findings.filter),
      loadSideLists(api, engagement),
    ]);
    // `findingsOf` 把 `{ok:false}` 收成带 error 的列表（页签据此渲染错误态）。
    patchFindings({
      busy: false,
      findings: findingsOf(vulnResponse),
      credentials: side.credentials,
      accesses: side.accesses,
      fileGroups: side.fileGroups,
    });
  };

  const findingsProps = (): FindingsTabProps => {
    const s = state.findings;
    return {
      findings: s.findings ?? (s.busy ? { ...EMPTY_FINDINGS, loading: true } : null),
      credentials: s.credentials,
      accesses: s.accesses,
      fileGroups: s.fileGroups,
      filter: s.filter,
      subTab: s.subTab,
      grouped: s.grouped,
      openId: s.openId,
      collapse: s.collapse,
      message: s.message,
      // `attackFilesNode` 由容器注入（攻击文件是另一个页签的 props）。
      // 这里不给 → findings 页签渲染自己的兜底文案。

      onFilterChange: (filter) => {
        const needsQuery = filter.severity !== s.filter.severity
          || filter.status !== s.filter.status;
        patchFindings({ filter });
        // 严重级/状态走服务端过滤 → 必须重查；搜索词改动还没提交，不查。
        if (needsQuery) void loadFindingsFn();
      },
      onSubmitQuery: () => {
        patchFindings({ filter: { ...s.filter, queryApplied: s.filter.query } });
        void loadFindingsFn();
      },
      onSubTabChange: (subTab) => patchFindings({ subTab }),
      onToggleGrouped: () => patchFindings({ grouped: !s.grouped }),
      onToggleOpen: (id) => patchFindings({ openId: s.openId === id ? null : id }),
      onCollapseChange: (collapse) => patchFindings({ collapse }),
      onSetAllCollapsed: (keys, open) => {
        patchFindings({ collapse: setSections(s.collapse, keys, open) });
      },
      onUpdateStatus: (id, status: VulnStatus) => {
        const engagement = eng();
        if (engagement === "") return;
        void updateVulnStatus(api, engagement, id, status).then((result) => {
          patchFindings({ message: result.message });
          if (result.ok) void loadFindingsFn();
        });
      },
      onCopy: (text, label) => {
        runCopy(text, (ok) => {
          patchFindings({
            message: ok ? { kind: "ok", text: copyMessage(true, label) } : { kind: "err", text: copyMessage(false, label) },
          });
        });
      },
    };
  };

  /* ══════════════════════════════════════════════════════════ 攻击链 */

  /**
   * `op: scoreChain` 是攻击链页的**唯一**数据源（`chainDataOf` 读它的
   * `stages` / `summary`）。`op: attackGraph` 返回的是资产拓扑图，
   * `ChainTabProps` 里没有它的槽位，所以本页不发这个请求。
   */
  const loadChainFn = async (): Promise<void> => {
    const engagement = eng();
    if (engagement === "") {
      patchChain({ data: null, error: null, loading: false });
      return;
    }
    patchChain({ loading: true });
    const response = await loadChain(api, engagement);
    patchChain({
      loading: false,
      error: chainErrorOf(response),
      data: chainDataOf(response),
    });
  };

  const chainProps = (): ChainTabProps => ({
    data: state.chain.data,
    error: state.chain.error,
    loading: state.chain.loading,
    view: state.chain.view,
    openId: state.chain.openId,
    onViewChange: (view) => patchChain({ view: nextView(view) }),
    onToggleHit: (id) => patchChain({ openId: toggleHitOpen(state.chain.openId, id) }),
    onRefresh: () => {
      void loadChainFn();
    },
  });

  /* ══════════════════════════════════════════════════════════ 得分目标 */

  const loadScoresFn = async (): Promise<void> => {
    const engagement = eng();
    if (engagement === "") {
      patchScores({ board: null, error: null, busy: false });
      return;
    }
    patchScores({ busy: true });
    const result = await loadScores(api, engagement);
    patchScores({
      busy: false,
      board: result.ok ? result.value : null,
      error: result.ok ? null : result.error,
    });
  };

  const scoresProps = (): ScoreTabProps => {
    const s = state.scores;
    return {
      engagement: state.engagement,
      board: s.board,
      error: s.error,
      busy: s.busy,
      openId: s.openId,
      form: s.form,
      message: s.message,
      onRefresh: () => {
        patchScores({ message: null });
        void loadScoresFn();
      },
      onToggle: (id) => patchScores({ openId: s.openId === id ? null : id }),
      onEdit: (point: ScorePoint) => {
        patchScores({ form: editFormOf(point), openId: point.id, message: null });
      },
      onNew: () => patchScores({ form: newScoreForm(), openId: null, message: null }),
      onFormChange: (form) => patchScores({ form }),
      onSave: () => {
        const engagement = eng();
        const form = s.form;
        if (engagement === "" || form === null) return;
        void saveScorePoint(api, engagement, form).then((outcome) => {
          patchScores({
            message: outcome.message,
            ...(outcome.closeForm ? { form: null } : {}),
          });
          if (outcome.reload) void loadScoresFn();
        });
      },
      onRemove: () => {
        const engagement = eng();
        const form = s.form;
        if (engagement === "") return;
        // 新增表单（没有 id）不需要发请求，直接关掉。
        if (shouldSkipDelete(form)) {
          patchScores({ form: null });
          return;
        }
        if (form === null || form.id === null) return;
        void removeScorePoint(api, engagement, form.id).then((outcome) => {
          patchScores({
            message: outcome.message,
            ...(outcome.closeForm ? { form: null } : {}),
            ...(outcome.closeDetail ? { openId: null } : {}),
          });
          if (outcome.reload) void loadScoresFn();
        });
      },
      onCancel: () => patchScores({ form: null, message: null }),
      onCopy: (text) => {
        runCopy(text, () => undefined);
      },
    };
  };

  /* ══════════════════════════════════════════════════════════ 环境适配 */

  /**
   * 环境适配的取数走两个 op：
   *
   * - `platformConfigGet`（store 侧）→ **props.data 的全部来源**：
   *   `config` / `runtime` / `tools` / `adapt` / `egress` / `hint` /
   *   `toolkitDir` / `nucleiTemplatesDir`。响应外面包了一层 `platform`，
   *   用 `flattenPlatform` 展开。
   * - `platformEnvAdaptStatus`（网关侧）→ 只有 `ready` / `reason` / `kali` /
   *   `message` / `found` / `missing`。`EnvTabProps` 没有它的专属槽位，
   *   所以只在 `config` 响应缺 `adapt` 时补进 `data.adapt`（老宿主兜底）。
   */
  const loadEnvFn = async (): Promise<void> => {
    patchEnv({ busy: true, error: null });
    const configResponse = await api.raw({ op: "platformConfigGet" });
    if (configResponse.ok === false) {
      patchEnv({ busy: false, error: configResponse.error ?? "读取失败" });
      return;
    }
    const flat = flattenPlatform(configResponse);
    const hasAdapt = typeof flat["adapt"] === "object" && flat["adapt"] !== null;
    if (hasAdapt) {
      patchEnv({ busy: false, data: flat, draft: draftFromResponse(flat), error: null });
      return;
    }
    const statusResponse = await api.raw({ op: "platformEnvAdaptStatus" });
    const adapt = statusResponse.ok === false
      ? undefined
      : {
          ready: statusResponse["ready"] === true,
          reason: textOf(statusResponse["reason"]),
          kali: statusResponse["kali"] === true,
          message: textOf(statusResponse["message"]),
        };
    const merged: ApiResponse = adapt === undefined ? flat : { ...flat, adapt };
    patchEnv({ busy: false, data: merged, draft: draftFromResponse(merged), error: null });
  };

  const envProps = (): EnvTabProps => {
    const s = state.env;
    return {
      draft: s.draft,
      data: s.data,
      error: s.error,
      message: s.message,
      busy: s.busy,
      folderPath: s.folderPath,
      onRefresh: () => {
        void loadEnvFn();
      },
      onSave: () => {
        const draft = s.draft;
        // 没加载出草稿就不能保存（否则会写入一份空配置覆盖原有配置）。
        if (draft === null) return;
        patchEnv({ busy: true, message: null });
        void saveEnv(api, draft).then((result) => {
          if (!result.ok || result.response === null) {
            patchEnv({ busy: false, message: { kind: "err", text: "保存失败" } });
            return;
          }
          // **先展开再读**：`platformConfigSave` 的响应同样包一层 `platform`，
          // 直接读 `response.config.path` 永远读不到（路径会退化成默认文案）。
          const flat = flattenPlatform(result.response);
          const refreshed = refreshDraftFrom(flat);
          patchEnv({
            busy: false,
            ...(refreshed !== null ? { draft: refreshed } : {}),
            data: flat,
            message: { kind: "ok", text: savedMessage(flat) },
          });
        });
      },
      onAssign: () => {
        const draft = s.draft;
        patchEnv({ busy: true, message: null });
        void assignEnv(api, s.folderPath, draft).then((result) => {
          if (!result.ok || result.response === null) {
            patchEnv({ busy: false, message: { kind: "err", text: result.error ?? "自动分配失败" } });
            return;
          }
          const flat = flattenPlatform(result.response);
          const refreshed = refreshDraftFrom(flat);
          patchEnv({
            busy: false,
            ...(refreshed !== null ? { draft: refreshed } : {}),
            data: flat,
            message: { kind: "ok", text: assignedMessage(flat) },
          });
        });
      },
      onFolderPathChange: (value) => patchEnv({ folderPath: value }),
      onDraftChange: (next) => patchEnv({ draft: next }),
    };
  };

  /* ══════════════════════════════════════════════════════════ 分发 */

  const load = async (tab: ConsoleTabId): Promise<void> => {
    switch (tab) {
      case "assets":
        await loadAssetsFn();
        return;
      case "sessions":
        await loadSessionsFn();
        return;
      case "findings":
        await loadFindingsFn();
        return;
      case "chain":
        await loadChainFn();
        return;
      case "scores":
        await loadScoresFn();
        return;
      case "env":
        await loadEnvFn();
        return;
      default:
        // 不属于本组的页签：不做任何事（由 B 组或容器负责）。
        return;
    }
  };

  const propsFor = (tab: ConsoleTabId): TabRegistryProps => {
    switch (tab) {
      case "assets":
        return { assets: assetsProps() };
      case "sessions":
        return { sessions: sessionsProps() };
      case "findings":
        return { findings: findingsProps() };
      case "chain":
        return { chain: chainProps() };
      case "scores":
        return { scores: scoresProps() };
      case "env":
        return { env: envProps() };
      default:
        return {};
    }
  };

  const allProps = (): TabRegistryProps => ({
    assets: assetsProps(),
    sessions: sessionsProps(),
    findings: findingsProps(),
    chain: chainProps(),
    scores: scoresProps(),
    env: envProps(),
  });

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEngagement: (engagement) => {
      // 换靶标必须清掉旧数据：否则上一家的资产会短暂出现在新靶标下。
      const fresh = initialState(engagement);
      state = fresh;
      emit();
    },
    assetsProps,
    sessionsProps,
    findingsProps,
    chainProps,
    scoresProps,
    envProps,
    propsFor,
    allProps,
    load,
    loadAll: async () => {
      await Promise.all([
        loadAssetsFn(),
        loadSessionsFn(),
        loadFindingsFn(),
        loadChainFn(),
        loadScoresFn(),
        loadEnvFn(),
      ]);
    },
    loadAssets: loadAssetsFn,
    loadSessions: loadSessionsFn,
    loadFindings: loadFindingsFn,
    loadChain: loadChainFn,
    loadScores: loadScoresFn,
    loadEnv: loadEnvFn,
  };
}

/* ══════════════════════════════════════════════════════════════ 内部工具 */

/** 取 `fetch`（缺失是**编程错误**，按项目惯例抛而不是静默降级）。 */
function requireFetch(deps: TabsADeps): FetchLike {
  if (deps.fetch !== undefined) return deps.fetch;
  throw new Error("makeTabsA 需要 deps.fetch 或 deps.api 之一");
}

/**
 * 尽力调度一个延时回调。
 *
 * ## 为什么不能直接写 `setTimeout(fn, ms)`
 *
 * 浏览器产物由 `scripts/build-client.mjs` 编译，它的 tsconfig 是
 * `lib: ["ES2020"]` + `types: []` —— **既没有 DOM 也没有 Node 全局**。
 * 直接引用 `setTimeout` 标识符会让产物构建报 `TS2304: Cannot find name`，
 * 而 `test/ui/artifact.test.js` 恰恰会真跑一次构建，于是整个「产物可复现」
 * 套件挂掉（这个坑我踩过一次，这是修法）。
 *
 * 所以这里从 `globalThis` 上**按名字取**，取不到就静默跳过 ——
 * 复制高亮不复位，远好过让整块界面抛错。
 */
function schedule(fn: () => void, ms: number): void {
  const candidate = (globalThis as unknown as Record<string, unknown>)["setTimeout"];
  if (typeof candidate !== "function") return;
  const timer = candidate as (handler: () => void, timeout: number) => unknown;
  timer(fn, ms);
}

/** 组合：asset 详情请求的 op（供外部诊断/测试断言用）。 */
export function assetDetailRequest(engagement: string, id: number): ReturnType<typeof assetRequest> {
  return assetRequest(engagement, id);
}

/** 组合：域名请求（同上）。 */
export function domainsRequestOf(engagement: string, cidr: string | null): ReturnType<typeof domainsRequest> {
  return domainsRequest(engagement, cidr);
}

/** 组合：Web 请求（同上）。 */
export function webRequestOf(engagement: string, cidr: string | null): ReturnType<typeof webRequest> {
  return webRequest(engagement, cidr);
}

/** 组合：发现时间线请求（同上）。 */
export function discoveryRequestOf(engagement: string): ReturnType<typeof discoveryRequest> {
  return discoveryRequest(engagement);
}

/** 组合：单台资产详情（用于「点了没反应」这类排查）。 */
export { assetDetailOf, assetListOf, domainGroupsOf, webAssetsOf, discoveryOf };

/** 结论键点击的纯函数（页签内部也用，这里导出便于容器复用）。 */
export function conclusionFilter(filter: AssetFilter, key: ConclusionKey): AssetFilter {
  return applyConclusion(filter, key);
}

/** 本组未填满的 props（如实记录，供报告与后续接线）。 */
export interface UnfilledProps {
  readonly tab: ConsoleTabId;
  readonly prop: string;
  readonly reason: string;
}

/**
 * 六个页签里**需要宿主或其它页签能力**、因而留空的 props。
 *
 * 留空比塞假数据好：页签各自有对应的空态文案，用户能看出「没接线」
 * 而不是「没有数据」。
 */
export const UNFILLED_PROPS: readonly UnfilledProps[] = Object.freeze([
  {
    tab: "assets",
    prop: "renderTesting",
    reason: "需要 TestingTabProps（测试页签属于另一组）；留空 → 渲染「当前测试页面未接线」",
  },
  {
    tab: "findings",
    prop: "attackFilesNode",
    reason: "由容器注入攻击文件页签的渲染节点（不是 props 值）；无注入 → 页签走自己的兜底文案",
  },
]);

/**
 * 已知的服务端返回形状缺口（本层用垫层处理，等 dispatch 侧修）。
 *
 * 与 `UNFILLED_PROPS` 同级：都是「如实记录我们绕过了什么」，
 * 免得后人以为这是本层的设计意图。
 */
export interface KnownShapeGap {
  /** 涉及哪些 op。 */
  readonly ops: readonly string[];
  /** 缺口的形态。 */
  readonly gap: string;
  /** 本层怎么垫的。 */
  readonly mitigation: string;
  /** 服务端修好之后该做什么。 */
  readonly whenFixed: string;
}

/** 已知形状缺口清单。 */
export const KNOWN_SHAPE_GAPS: readonly KnownShapeGap[] = Object.freeze([
  {
    ops: ["platformConfigGet", "platformConfigSave", "platformAssignToolkit"],
    gap: "返回 {ok, platform:{config,tools,adapt,egress,...}}，比消费方期望的扁平形状多包一层",
    mitigation: "`flattenPlatform()` 在接线层展开（不改 model：model 的扁平假设是正确契约）",
    whenFixed: "dispatch 侧改为 {ok, ...platformSummary()} 后，flattenPlatform 退化为恒等并删除",
  },
]);

/** 供断言用：被页签消费、但本组**有意不发**的 op 及原因。 */
export const UNUSED_OPS: readonly { readonly op: string; readonly reason: string }[] = Object.freeze([
  { op: "tunnels", reason: "sessions 已并好隧道表（sessionSummary），两个来源会打架" },
  { op: "webshells", reason: "同上：sessions 已并好 WebShell 表" },
  { op: "vulnStats", reason: "vulns 响应里已带 stats（dispatch 合并了 vulnStats）" },
  { op: "attackGraph", reason: "ChainTabProps 没有拓扑图槽位（消费方是 report/graph 视图）" },
  { op: "scoreChain", reason: "ScoreBoard 来自 scores op；scoreChain 是攻击链页的数据源" },
  { op: "access", reason: "findings 的附属表已由 loadSideLists 覆盖（已用）" },
]);
