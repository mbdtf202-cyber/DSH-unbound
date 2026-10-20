/**
 * 工具层的共享上下文：会话绑定、靶标解析、并发预留。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 顶部的辅助函数群（原 1–363 行）。
 *
 * ## 这一层为什么值得单独拎出来
 *
 * 原实现把这些函数和 56 个工具写在同一个 2000 行文件里，导致：
 * 会话解析错了只能靠"跑一次看看靶标对不对"发现。抽出来后可以单独测。
 *
 * ## 三条从原注释继承下来的硬约束
 *
 * 1. **靶标按根会话隔离**。绑定键是会话的**根祖先 id**，子智能体顺着
 *    `session.header.parentSession` 继承父会话的靶标 —— 多会话并行时互不串写。
 *    v0.9.0 之前的全局「当前靶标」指针正是串写的根源。
 * 2. **绑定缓存有上限**（FIFO 500）。长会话会累积失效的 session id，
 *    无上限的 Map 就是内存泄漏。
 * 3. **解析不到靶标时抛错，不"随便挑一个"**。多会话并行时挑错靶标 =
 *    把 A 单位的成果写进 B 单位的库。这是刻意的。
 */

import type { ToolExecContext } from "../../host-api/types.js";

/* ── 会话解析 ──────────────────────────────────────────────────────────── */

/** 从 exec 里解析出的会话信息。 */
export interface SessionInfo {
  readonly id?: string;
  readonly parentId?: string;
  readonly session?: unknown;
}

/** 会话上的最小可读形状（宿主 `Session` 的实际字段因面而异）。 */
interface SessionLike {
  readonly id?: unknown;
  readonly header?: unknown;
  readonly store?: unknown;
}

/** 会话存储的最小形状（`store.get(id)` 取父会话）。 */
interface SessionStoreLike {
  readonly get?: (id: string) => unknown;
}

/** 从 `unknown` 里按字段名窄化（不用 `as`，逐字段查）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** 取字符串字段（非字符串视为缺失）。 */
function strField(rec: Record<string, unknown> | null, key: string): string | undefined {
  if (rec === null) return undefined;
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * 解析一次调用的会话信息。
 *
 * 注意 `exec.agent.session`：工具的 `exec` 由宿主组装，`agent` 是可选链式访问的。
 * 这里逐层查字段而不是 `as any`，缺一层就返回空对象（工具随后会提示"取不到会话 id"）。
 */
export function sessionInfoOf(exec: ToolExecContext | null | undefined): SessionInfo {
  const execRec = asRecord(exec);
  if (execRec === null) return {};
  const agentRec = asRecord(execRec["agent"]);
  if (agentRec === null) return {};
  const session = agentRec["session"];
  const sessionRec = asRecord(session);
  if (sessionRec === null) return {};
  const rawId = sessionRec["id"];
  const id = rawId === undefined ? undefined : String(rawId);
  let parentId: string | undefined;
  const headerRec = asRecord(sessionRec["header"]);
  if (headerRec !== null) {
    const rawParent = headerRec["parentSession"];
    if (rawParent !== undefined && rawParent !== null) parentId = String(rawParent);
  }
  return { ...(id === undefined ? {} : { id }), ...(parentId === undefined ? {} : { parentId }), session };
}

/** 会话 id（兼容旧调用点）。 */
export function sessionOf(exec: ToolExecContext | null | undefined): string | undefined {
  return sessionInfoOf(exec).id;
}

/** 沿 parentSession 走到底的结果。 */
export interface RootSessionResolution {
  readonly rootId?: string;
  readonly chain: readonly string[];
}

/**
 * 解析"根会话"：一路沿 `parentSession` 走到最顶层的会话 id。
 *
 * 主会话派出的子智能体因此共享同一个绑定键，而**不同主会话之间天然隔离**。
 * 顺手把沿途会话 id 都返回，便于把绑定缓存到子会话上。
 *
 * `guard < 64` 是防环：宿主理论上不会造出环，但一个坏掉的 `parentSession`
 * 会让 while 永远转下去 —— 那种挂死比报错难查得多。
 *
 * 父会话不在内存里（被回收 / 冷启动）时，**父 id 本身就是稳定的根键**。
 */
export function resolveRootSession(session: unknown): RootSessionResolution {
  const chain: string[] = [];
  let cur: unknown = session;
  let guard = 0;
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } } as unknown as ToolExecContext);
    if (info.id === undefined) break;
    chain.push(info.id);
    if (info.parentId === undefined || info.parentId === "") break;
    let parent: unknown;
    const curRec = asRecord(cur);
    const storeRec = curRec === null ? null : asRecord(curRec["store"]);
    const get = storeRec === null ? undefined : storeRec["get"];
    if (typeof get === "function") {
      try {
        parent = (get as (id: string) => unknown)(info.parentId);
      } catch {
        parent = undefined;
      }
    }
    if (parent === undefined || parent === null) {
      const last = info.parentId;
      return { rootId: last, chain: chain.concat([last]) };
    }
    cur = parent;
    guard += 1;
  }
  const last = chain[chain.length - 1];
  return { ...(last === undefined ? {} : { rootId: last }), chain };
}

/** 绑定键 + 会话链。 */
export interface BindingKey {
  readonly rootId?: string;
  readonly sessionId?: string;
  readonly chain: readonly string[];
}

/** 绑定键 + 会话链。 */
export function bindingKeyOf(exec: ToolExecContext | null | undefined): BindingKey {
  const info = sessionInfoOf(exec);
  if (info.id === undefined) return { chain: [] };
  const resolved = resolveRootSession(info.session);
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId;
  return { rootId, sessionId: info.id, chain: resolved.chain };
}

/** 本次调用涉及的所有候选绑定键（去重、去空）。 */
export function bindKeysOf(exec: ToolExecContext | null | undefined): readonly string[] {
  const { rootId, sessionId, chain } = bindingKeyOf(exec);
  const keys = [rootId, sessionId, ...chain].filter((k): k is string => typeof k === "string" && k !== "");
  return Array.from(new Set(keys));
}

/* ── 绑定表（有上限的 Map） ────────────────────────────────────────────── */

/** 绑定表容量。长会话累积失效 session id，无上限就是内存泄漏。 */
export const BINDINGS_CAP = 500;

/** 并发预留表容量。 */
export const RESERVATIONS_CAP = 500;

/**
 * 带 FIFO 淘汰的 Map。
 *
 * 为什么不用 `new Map()`：长会话会不断写入新 session id（每次换子智能体都是新 id），
 * 无上限的 Map 会跟着会话时长线性增长。淘汰最老的一条（近似 LRU），
 * 代价是"极老的会话重新绑定一次"，可接受。
 */
export class CappedMap<V> {
  private readonly inner = new Map<string, V>();
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get size(): number {
    return this.inner.size;
  }

  get(key: string): V | undefined {
    return this.inner.get(key);
  }

  has(key: string): boolean {
    return this.inner.has(key);
  }

  /** 写入；新键且已满时先淘汰最老的一条。 */
  set(key: string, value: V): this {
    if (!this.inner.has(key) && this.inner.size >= this.cap) {
      const first = this.inner.keys().next();
      if (first.done !== true) this.inner.delete(first.value);
    }
    this.inner.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    return this.inner.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.inner.keys();
  }

  entries(): IterableIterator<[string, V]> {
    return this.inner.entries();
  }

  /** 清空（测试用）。 */
  clear(): void {
    this.inner.clear();
  }
}

/** 根会话 id → engagementId 绑定（一次会话内稳定；进程重启后由 agent 重新绑定）。 */
export const bindings = new CappedMap<string>(BINDINGS_CAP);

/** 并发闸门：根会话 id → Map(子智能体键 → 预留时间戳)。 */
export const reservations = new CappedMap<Map<string, number>>(RESERVATIONS_CAP);

/** 清空进程内状态（测试用）。 */
export function resetToolState(): void {
  bindings.clear();
  reservations.clear();
}

/* ── 靶标解析 ──────────────────────────────────────────────────────────── */

/** 解析靶标所需的 store 能力（只这两条，避免把整个窄接口拖进本模块）。 */
export interface EngagementResolverStore {
  activeEngagementId(): string | undefined;
  listEngagements(): readonly { readonly id: string; readonly name: string; readonly created_at: string }[];
}

/** 绑定视图（`redteam_session_info` 与面板展示用）。 */
export interface BindingView {
  readonly session_id: string | null;
  readonly parent_session: string | null;
  readonly root_session: string | null;
  readonly session_chain: readonly string[];
  readonly is_subagent: boolean;
  readonly bound_engagement: string | null;
}

/** 当前会话的绑定关系。 */
export function bindingViewOf(exec: ToolExecContext | null | undefined): BindingView {
  const info = sessionInfoOf(exec);
  const { rootId, chain } = bindingKeyOf(exec);
  const rootKey = rootId ?? null;
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootKey,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootKey === null ? null : (bindings.get(rootKey) ?? null),
  };
}

/**
 * 解析本次调用应作用在哪个靶标上（会话隔离版）。
 *
 * 顺序：① 显式传入 → ② 本会话/父链上的绑定 → ③ 全局「当前靶标」指针
 * （仅当没有被别的会话占用；被占用时报错并提示显式绑定，**绝不静默串写**）。
 *
 * 抛错而不是"随便挑一个"是刻意的：多会话并行时挑错靶标 = 把 A 单位的成果写进
 * B 单位的库、A 的报告里出现 B 的数据（这正是要多会话隔离的原因）。
 *
 * @param store 靶标解析所需的最小能力。
 * @param exec 工具执行上下文。
 * @param explicit 显式传入的靶标 id。
 * @throws 无绑定 / 被别的会话占用 / 存在多个靶标而无法推断。
 */
export function resolveEngagement(
  store: EngagementResolverStore,
  exec: ToolExecContext | null | undefined,
  explicit: string | undefined,
): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const { rootId, sessionId, chain } = bindingKeyOf(exec);
  const rawKeys = [rootId, sessionId, ...chain];
  const keys = Array.from(new Set(rawKeys.filter((k): k is string => typeof k === "string" && k !== "")));
  for (const key of keys) {
    const bound = bindings.get(key);
    if (typeof bound === "string" && bound.length > 0) return bound;
  }
  const active = store.activeEngagementId();
  if (active !== undefined) {
    const holderEntry = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k));
    if (holderEntry !== undefined) {
      throw new Error(
        "本会话尚未绑定靶标，而全局「当前靶标」" +
          active +
          " 已被另一个会话占用；" +
          "为避免多会话串写同一个靶标库，请显式绑定：redteam_engagement_open（新建/打开）" +
          " 或 redteam_session_bind（绑定到已有靶标）。",
      );
    }
    for (const key of keys) bindings.set(key, active);
    return active;
  }
  const list = store.listEngagements();
  const only = list[0];
  if (list.length === 1 && only !== undefined) {
    for (const key of keys) bindings.set(key, only.id);
    return only.id;
  }
  throw new Error("尚未绑定靶标：请先调用 redteam_engagement_open 传入靶标单位名称");
}

/* ── 并发预留 ──────────────────────────────────────────────────────────── */

/** 一条预留。 */
export interface Reservation {
  readonly key: string;
  readonly at: number;
}

/** 某个靶标/根会话下的预留列表。 */
export function reservationList(rootId: string): readonly Reservation[] {
  const map = reservations.get(rootId);
  if (map === undefined) return [];
  return Array.from(map, ([key, at]) => ({ key, at }));
}

/** 加一条预留。 */
export function addReservation(rootId: string, key: string): void {
  let map = reservations.get(rootId);
  if (map === undefined) {
    map = new Map<string, number>();
    reservations.set(rootId, map);
  }
  map.set(key, Date.now());
}

/**
 * 释放一条预留。
 *
 * `key` 省略时**只释放最早的一条** —— 清空整张表会把别的在途预留一起放掉，
 * 名额就超卖了。这是原注释明确记过的一条。
 *
 * @returns 是否真的删除了一条。
 */
export function dropReservation(rootId: string, key?: string): boolean {
  const map = reservations.get(rootId);
  if (map === undefined) return false;
  if (key === undefined) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, at] of map) {
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = k;
      }
    }
    return oldestKey === null ? false : map.delete(oldestKey);
  }
  return map.delete(key);
}

/** 淘汰某根会话下最早的一条预留（子智能体结束时兜底）。 */
export function dropOldestReservation(rootId: string): boolean {
  return dropReservation(rootId, undefined);
}

/* ── 小工具 ────────────────────────────────────────────────────────────── */

/** 逗号/空白分隔的清单 → 去重数组。 */
export function splitList(value: unknown): readonly string[] {
  return String(value ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 产出这条记录的智能体角色：显式传的优先，否则默认按主会话记账。 */
export function agentOf(args: { readonly agent?: string | undefined }, plannerRole: string): string {
  const raw = typeof args.agent === "string" ? args.agent.trim() : "";
  return raw !== "" ? raw : plannerRole;
}
