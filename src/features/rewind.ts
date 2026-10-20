/**
 * 回退（rewind）决策与草稿状态。
 *
 * 迁移自 dsh-qilin/lib/rewind.js 的纯逻辑部分。
 *
 * ## 为什么这块必须逐字对齐
 *
 * `planRewind` 决定「回退到哪一条、回退后输入框里放什么文字」。
 * 逻辑错了不会报错，只会让用户回退到错误的位置、或者把不该清的内容清掉。
 * 所以这里不重构算法，只加类型；每条分支都有对照测试。
 *
 * ## 事件模型
 *
 * 会话事件流是按 `seq` 递增的记录。这块用到的类型：
 *   - `turn/start` / `turn/end`  一轮的开始与结束边界
 *   - `step/start`              一轮里的一步（一次模型调用）
 *   - `user/message`            用户消息，`data.source.kind` 区分来源
 *   - `agent/inbox/spliced`     往下一轮插消息
 *   - `subagent/catalog` / `subagent/descriptor`  子智能体登记
 *
 * 未知事件类型一律容忍（只当作不匹配），因为宿主会持续加新事件，
 * 把不认识的事件当错误会让回退在新版宿主上直接坏掉。
 */

/** 一处会话事件。字段按实际用到的建模，其余保持开放。 */
export interface SessionEvent {
  readonly type?: string;
  readonly seq?: number;
  readonly data?: {
    readonly content?: unknown;
    readonly message?: { readonly content?: unknown };
    readonly id?: unknown;
    readonly source?: {
      readonly kind?: string;
      readonly round?: unknown;
    };
    readonly target?: string;
    readonly inserted?: readonly { readonly id?: string }[];
    readonly turn?: unknown;
    readonly step?: unknown;
    readonly childId?: string;
    readonly sessionId?: string;
    readonly origin?: string;
    readonly delegationDepth?: number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/** 从事件里抽出用户可见文本（支持字符串与 content block 数组）。 */
export function userTextFromEvent(event: SessionEvent | null | undefined): string {
  const data = event?.data;
  const content = data?.content ?? data?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    if (block === null || block === undefined) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block === "object") {
      const rec = block as { type?: unknown; text?: unknown };
      if (rec.type === "text" || typeof rec.text === "string") {
        parts.push(String(rec.text ?? ""));
      }
    }
  }
  return parts.join("").trim();
}

/**
 * 是否属于插件自己写入的草稿（MNEMON 运行时记忆快照）。
 * 这类内容不该被当成「用户说过的话」参与回退。
 */
export function isPluginDraft(text: string): boolean {
  const value = String(text ?? "").trim();
  if (value === "") return false;
  return (
    /^\[MNEMON\]/i.test(value) ||
    /MNEMON RUNTIME MEMORY SNAPSHOT/i.test(value) ||
    /^MNEMON VIEW TOOLS/im.test(value)
  );
}

/** 是否是本插件插入的回退标记消息。 */
export function isRewindMarkerEvent(event: SessionEvent | null | undefined): boolean {
  if (event === null || event === undefined || event.type !== "user/message") return false;
  const id = event.data?.id;
  return typeof id === "string" && id.startsWith("rewind-");
}

/** 是否是真人用户发出的消息（排除插件与系统来源）。 */
export function isHumanUserEvent(event: SessionEvent | null | undefined): boolean {
  if (event?.type !== "user/message") return false;
  const kind = event.data?.source?.kind;
  if (kind === "plugin") return false;
  if (kind !== undefined && kind !== null && kind !== "user") return false;
  const text = userTextFromEvent(event);
  if (text === "" || isPluginDraft(text)) return false;
  return true;
}

/**
 * 是否是「这一轮真正发出去的那句」。
 *
 * 手打消息是 `kind: "user"`；goal 的每一轮也算（round 0 是首轮 goal）。
 * 其他来源（plugin / 系统）都不算。
 */
export function isRoundPromptEvent(event: SessionEvent | null | undefined): boolean {
  if (event === null || event === undefined) return false;
  if (event.type !== "user/message" || isRewindMarkerEvent(event)) return false;
  const source = event.data?.source;
  const kind = source?.kind;
  if (kind === "plugin") return false;
  const text = userTextFromEvent(event);
  if (text === "" || isPluginDraft(text)) return false;
  if (kind === undefined || kind === null || kind === "user") return true;
  if (kind === "goal") {
    const round = Number(source?.round);
    return Number.isFinite(round) && round >= 0;
  }
  return false;
}

/** 事件列表规范化为数组（容忍 null / 非数组）。 */
function asEventList(events: unknown): SessionEvent[] {
  return Array.isArray(events) ? (events as SessionEvent[]) : [];
}

/** 按 seq 排序（缺 seq 的用下标兜底）。 */
function eventsInOrder(events: unknown): { event: SessionEvent; seq: number }[] {
  return asEventList(events)
    .map((event, index) => {
      const raw = Number(event?.seq);
      return { event, seq: Number.isFinite(raw) ? raw : index };
    })
    .sort((left, right) => left.seq - right.seq);
}

/** 找到最后一个未结束的 turn/start；遇到 turn/end 就说明已收口。 */
function lastOpenTurn(events: unknown): SessionEvent | null {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const type = list[i]?.type;
    if (type === "turn/start") return list[i] ?? null;
    if (type === "turn/end") return null;
  }
  return null;
}

/** 最后一个指定类型的事件。 */
function lastEventOfType(events: unknown, type: string): SessionEvent | null {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === type) return list[i] ?? null;
  }
  return null;
}

/** cutSeq 之前最后一个事件的 seq；没有则 null。 */
function seqBefore(events: unknown, cutSeq: unknown): number | null {
  const floor = Number(cutSeq);
  let prev: { event: SessionEvent; seq: number } | null = null;
  for (const row of eventsInOrder(events)) {
    if (!Number.isFinite(row.seq)) continue;
    if (Number.isFinite(floor) && row.seq >= floor) break;
    prev = row;
  }
  return prev !== null && Number.isFinite(prev.seq) ? prev.seq : null;
}

/** 从 fromSeq 起（含）往前找最近一句本轮提示语。 */
function userTextFromRange(events: unknown, fromSeq: unknown): string {
  const list = asEventList(events);
  const floor = Number(fromSeq);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    const seq = Number(event?.seq);
    if (Number.isFinite(floor) && Number.isFinite(seq) && seq < floor) break;
    if (isRoundPromptEvent(event)) return userTextFromEvent(event);
  }
  return "";
}

/** 这个 step/start 是不是本轮的第一步。 */
function isFirstStepOfTurn(events: unknown, start: SessionEvent): boolean {
  const turn = start.data?.turn;
  const startSeq = Number(start.seq);
  return !asEventList(events).some((event) => {
    if (event?.type !== "step/start" || event === start) return false;
    if (!(Number(event.seq) < startSeq)) return false;
    return turn === undefined || turn === null || event.data?.turn === turn;
  });
}

/** 找某一轮的 turn/start（在 beforeSeq 之前）。 */
function turnStartFor(events: unknown, turn: unknown, beforeSeq: unknown): SessionEvent | null {
  const limit = Number(beforeSeq);
  let found: SessionEvent | null = null;
  for (const row of eventsInOrder(events)) {
    if (row.event.type !== "turn/start") continue;
    if (Number.isFinite(limit) && row.seq >= limit) break;
    if (turn === undefined || turn === null || row.event.data?.turn === turn) found = row.event;
  }
  return found;
}

/** 回退单位。 */
export type RewindUnit = "step" | "turn";

/**
 * 回退计划。
 *
 * 三态：
 *  - `fork`   从 atSeq 处切出分支（前面还有历史）
 *  - `blank`  前面没有历史，回去等于开新会话（只带 text）
 *  - 失败     没有可回退的内容
 */
export type RewindPlan =
  | {
      readonly ok: true;
      readonly mode: "fork";
      readonly atSeq: number;
      readonly text: string;
      readonly unit: RewindUnit;
      readonly turn?: unknown;
      readonly step?: unknown;
      readonly fromSeq: number;
    }
  | {
      readonly ok: true;
      readonly mode: "blank";
      readonly text: string;
      readonly unit: RewindUnit;
      readonly turn?: unknown;
      readonly step?: unknown;
      readonly fromSeq: number;
    }
  | { readonly ok: false; readonly error: string };

/** 回退模式：`once` 退一步，`round` 退一轮。 */
export type RewindMode = "once" | "round";

export function planRewind(events: unknown, mode: RewindMode = "once"): RewindPlan {
  return mode === "round" ? planRewindTurn(events) : planRewindStep(events);
}

function planRewindStep(events: unknown): RewindPlan {
  const start = lastEventOfType(events, "step/start");
  if (start === null) return planRewindTurn(events);

  const turn = start.data?.turn;
  const step = start.data?.step;
  let cutSeq = Number(start.seq);

  // 第一步退的就是整轮：把切点推到 turn/start，否则会只退掉模型那半步
  if (isFirstStepOfTurn(events, start)) {
    const turnStart = turnStartFor(events, turn, start.seq);
    if (turnStart !== null && Number.isFinite(Number(turnStart.seq))) {
      cutSeq = Number(turnStart.seq);
    }
  }

  const text = userTextFromRange(events, cutSeq);
  const atSeq = seqBefore(events, cutSeq);
  if (atSeq === null) {
    if (text === "") return { ok: false, error: "没有可回退的上一句" };
    return { ok: true, mode: "blank", text, unit: "step", turn, step, fromSeq: cutSeq };
  }
  return { ok: true, mode: "fork", atSeq, text, unit: "step", turn, step, fromSeq: cutSeq };
}

function planRewindTurn(events: unknown): RewindPlan {
  const list = asEventList(events);
  const open = lastOpenTurn(list);

  let turnStart: SessionEvent | null = open;
  if (turnStart === null) {
    const ended = lastEventOfType(list, "turn/end");
    if (ended !== null) {
      turnStart = turnStartFor(list, ended.data?.turn, ended.seq) ?? ended;
    }
  }

  if (turnStart === null) {
    // 完全没有 turn 结构：退回最近一句用户话
    const lastUser = [...list].reverse().find((event) => isRoundPromptEvent(event));
    if (lastUser === undefined) return { ok: false, error: "没有可回退的上一句" };
    const cutSeq = Number(lastUser.seq);
    const text = userTextFromEvent(lastUser);
    const atSeq = seqBefore(list, cutSeq);
    if (atSeq === null) return { ok: true, mode: "blank", text, unit: "turn", fromSeq: cutSeq };
    return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
  }

  const cutSeq = Number(turnStart.seq);
  const text = userTextFromRange(list, cutSeq);
  const atSeq = seqBefore(list, cutSeq);
  if (text === "" && atSeq === null) return { ok: false, error: "没有可回退的上一句" };
  if (atSeq === null) return { ok: true, mode: "blank", text, unit: "turn", fromSeq: cutSeq };
  return { ok: true, mode: "fork", atSeq, text, unit: "turn", fromSeq: cutSeq };
}

/** 上一轮真正发出去的那句（人类来源）。 */
export function lastHumanUserText(events: unknown): string {
  const list = asEventList(events);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isHumanUserEvent(list[i])) return userTextFromEvent(list[i]);
  }
  return "";
}

/**
 * 待插入的消息 id（`agent/inbox/spliced` 且 target 为 next-turn）。
 *
 * 只取「最后一次 turn/end 之后、最后一次 turn/start 之前」这一段，
 * 因为那是真正还没被消费的插入。
 */
export function pendingInboxInserts(events: unknown): string[] {
  const list = asEventList(events);
  let lastEnd = -1;
  let lastStart = -1;
  for (const event of list) {
    const seq = Number(event?.seq);
    if (event?.type === "turn/end") lastEnd = seq;
    if (event?.type === "turn/start") lastStart = seq;
  }
  const after = lastEnd >= 0 ? lastEnd : -1;
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const event of list) {
    const seq = Number(event?.seq);
    if (!event || seq <= after) continue;
    if (lastStart > after && seq >= lastStart) continue;
    if (event.type !== "agent/inbox/spliced") continue;
    const target = event.data?.target;
    if (target !== undefined && target !== "next-turn") continue;
    for (const message of event.data?.inserted ?? []) {
      const id = message?.id;
      if (id === undefined || id === "" || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 最近一轮里出现过的子智能体 id。 */
export function lastTurnSubagentIds(events: unknown, fromSeq = -1): string[] {
  const list = asEventList(events);
  let floor = Number(fromSeq);
  if (!Number.isFinite(floor) || floor < 0) {
    floor = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.type === "turn/start") {
        floor = Number(list[i]?.seq);
        break;
      }
    }
  }
  if (floor < 0) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const event of list) {
    const seq = Number(event?.seq);
    if (!event || seq < floor) continue;
    if (event.type !== "subagent/catalog" && event.type !== "subagent/descriptor") continue;
    const id = event.data?.childId ?? event.data?.sessionId ?? event.data?.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
