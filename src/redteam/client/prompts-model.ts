/**
 * 智能体提示词页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `PromptsTab` 把五件事塞在同一个组件里：
 *
 * ```js
 * const [roles, setRoles] = React.useState([])
 * const [active, setActive] = React.useState(null)
 * const [draft, setDraft] = React.useState('')
 * ...
 * if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
 * const cur = roles.find((x) => x.role === active)
 * ```
 *
 * 三个**容易错**的点，抽出来后可以逐条钉死：
 *
 * 1. **`active` 不会因为角色消失而重置**：原实现是 `cur || roles[0].role`
 *    —— `cur` 有值就原样保留。所以「服务端删掉了某个角色、界面还停在它上面」
 *    时，工具栏标题必须回退成「提示词」而不是崩溃或显示上一份正文。
 * 2. **草稿只在 `active`/`roles` 变化时同步**：用户正在编辑的内容不能被
 *    一次后台刷新覆盖。这条在模型层表现为 `draftFor()` 的纯函数语义 ——
 *    组件决定何时调它。
 * 3. **没靶标也能读，但不能保存**：`prompts` 不带 engagement 时服务端回
 *    内置默认（`builtin: true`）；而保存/恢复必须显式拦下并给出可执行提示，
 *    否则用户会对着一个永远失败的按钮反复点。
 */

import { formatTimestamp, isFailure } from "./helpers.js";

/** 一个角色的提示词。 */
export interface PromptRole {
  /** 角色 code（`recon` / `assess` / ...），也是文件名主干。 */
  readonly role: string;
  /** 显示名。空标题回退成 `role`（原实现会渲染出 `undefined`）。 */
  readonly title: string;
  /** 正文（Markdown）。 */
  readonly content: string;
  /** 最近更新时间（服务端原样透传）。 */
  readonly updatedAt: string;
}

/** 一次读取的结果。 */
export interface PromptLoad {
  readonly ok: boolean;
  readonly roles: readonly PromptRole[];
  /** 当前是内置默认（未按靶标保存过）。 */
  readonly builtin: boolean;
  readonly error: string | null;
}

/** 表单消息。 */
export type PromptMessage = { readonly kind: "ok"; readonly text: string } | { readonly kind: "err"; readonly text: string };

/** 读取失败时的兜底文案。 */
export const PROMPTS_ERROR_FALLBACK = "读取失败";

/** 保存成功的文案。 */
export const PROMPT_SAVED_MESSAGE = "已保存";

/** 内置默认时的提示（原实现 `setMsg({ ok: ... })`）。 */
export const BUILTIN_NOTICE = "当前为内置默认提示词（创建靶标后可按靶标保存修改）";

/** 列表为空时的空态文案。 */
export const EMPTY_PROMPTS_MESSAGE = "还没有角色提示词";

/** 从不可信值读字符串。 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 从不可信值读对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 从失败响应里取错误文案。 */
function errorTextOf(response: unknown, fallback: string): string {
  const error = asRecord(response)["error"];
  return typeof error === "string" && error !== "" ? error : fallback;
}

/**
 * 解析一个角色。
 *
 * `role` 为空的行直接丢弃：它是文件主干的来源，也是 React key 与选中判定
 * 的唯一依据 —— 空 role 的行既点不中、也保存不了，留着只会在列表里出空白行。
 */
export function promptRoleOf(raw: unknown): PromptRole | null {
  const item = asRecord(raw);
  const role = text(item["role"]);
  if (role === "") return null;
  return {
    role,
    title: text(item["title"]) || role,
    content: text(item["content"]),
    // 两个写法都收：老 store 给 `updated_at`，早期实现有过 `updatedAt`。
    updatedAt: text(item["updated_at"]) || text(item["updatedAt"]),
  };
}

/** 解析 `prompts` 响应。 */
export function promptCatalogOf(response: unknown): { readonly roles: readonly PromptRole[]; readonly builtin: boolean } {
  const body = asRecord(response);
  const roles = (Array.isArray(body["roles"]) ? body["roles"] : [])
    .map(promptRoleOf)
    .filter((item): item is PromptRole => item !== null);
  return { roles, builtin: body["builtin"] === true };
}

/** 解析一次读取结果（失败 → `ok: false` + 错误文案）。 */
export function promptLoadOf(response: unknown): PromptLoad {
  if (isFailure(response)) {
    return { ok: false, roles: [], builtin: false, error: errorTextOf(response, PROMPTS_ERROR_FALLBACK) };
  }
  const catalog = promptCatalogOf(response);
  return { ok: true, roles: catalog.roles, builtin: catalog.builtin, error: null };
}

/**
 * 当前应选中的角色。
 *
 * **保留原实现语义**：已有选择就不动（哪怕它在新的角色列表里已不存在）。
 * 自动“纠正”成第一个角色会让用户正在编辑的正文在后台刷新后突然换掉。
 */
export function activeRoleOf(roles: readonly PromptRole[], current: string | null): string | null {
  if (current !== null && current !== "") return current;
  const first = roles[0];
  return first === undefined ? null : first.role;
}

/** 找当前角色（找不到 → `null`）。 */
export function promptFor(roles: readonly PromptRole[], active: string | null): PromptRole | null {
  if (active === null) return null;
  return roles.find((item) => item.role === active) ?? null;
}

/** 当前角色对应的草稿正文（找不到 → 空串）。 */
export function draftFor(roles: readonly PromptRole[], active: string | null): string {
  return promptFor(roles, active)?.content ?? "";
}

/**
 * 列表项的一行预览。
 *
 * 原实现：`(r.content || '').replace(/[#*`]/g, '').slice(0, 60) || '（空）'`。
 * 先剥 Markdown 记号再截 60 字符 —— 不剥的话整行都是 `###`，看不出写的是什么。
 */
export function previewOf(role: PromptRole | null): string {
  if (role === null) return "（空）";
  const stripped = role.content.replace(/[#*`]/g, "").slice(0, 60);
  return stripped === "" ? "（空）" : stripped;
}

/** 工具栏标题（没有当前角色 → 「提示词」）。 */
export function promptHeading(roles: readonly PromptRole[], active: string | null): string {
  return promptFor(roles, active)?.title ?? "提示词";
}

/** 工具栏上的更新时间标签。 */
export function updatedLabel(roles: readonly PromptRole[], active: string | null): string {
  return "更新 " + formatTimestamp(promptFor(roles, active)?.updatedAt ?? "");
}

/** 列表项的 aria-label（原实现同样拼法）。 */
export function promptItemLabel(role: PromptRole): string {
  return "查看「" + role.title + "」提示词";
}

/** 列表项的 className（选中加 `on`）。 */
export function promptItemClass(role: PromptRole, active: string | null): string {
  return "rt-item" + (active === role.role ? " on" : "");
}

/**
 * 保存前的靶标校验。
 *
 * `prompts` 支持无靶标读取，但保存必须落在一个靶标上 —— 原实现同样在
 * 发请求前拦下并给出「请先创建靶标」。
 */
export function saveBlockedMessage(engagement: string | null): string | null {
  return engagement === null || engagement === "" ? "请先创建靶标，再保存提示词" : null;
}

/** 恢复默认前的靶标校验。 */
export function resetBlockedMessage(engagement: string | null): string | null {
  return engagement === null || engagement === "" ? "请先创建靶标，再恢复默认提示词" : null;
}

/** 保存按钮是否可用（无靶标仍可点 —— 点了会给出提示，原实现同样如此）。 */
export function canSave(busy: boolean, active: string | null): boolean {
  return !busy && active !== null && active !== "";
}

/** 「恢复默认为当前」是否可用。 */
export function canResetCurrent(busy: boolean, active: string | null): boolean {
  return !busy && active !== null && active !== "";
}

/** 「全部恢复默认」是否可用。 */
export function canResetAll(busy: boolean): boolean {
  return !busy;
}

/** 保存结果 → 消息。 */
export function saveOutcomeOf(response: unknown): PromptMessage {
  if (isFailure(response)) {
    return { kind: "err", text: errorTextOf(response, "保存失败") };
  }
  return { kind: "ok", text: PROMPT_SAVED_MESSAGE };
}

/**
 * 恢复默认结果 → 消息。
 *
 * 成功时把服务端返回的 `reset` 数组拼进文案 —— 「恢复了哪几个角色」是
 * 用户唯一能验证这次操作范围的信息（全部恢复 vs 只恢复当前）。
 */
export function resetOutcomeOf(response: unknown): PromptMessage {
  if (isFailure(response)) {
    return { kind: "err", text: errorTextOf(response, "恢复失败") };
  }
  const raw = asRecord(response)["reset"];
  const names = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  return { kind: "ok", text: "已恢复内置默认：" + names.join("、") };
}

/** 服务端返回的提示词文件名（保存后的落盘位置）。 */
export function promptFileName(active: string | null): string {
  return "agents/" + (active !== null && active !== "" ? active : "role") + ".md";
}

/** 底部说明文案（与提示词文件的加载机制对齐）。 */
export function promptHint(active: string | null): string {
  return "保存后写入 " + promptFileName(active)
    + "。子会话任务第一行写 redteamRole: recon、assess、vuln-scan、exploit 或 internal 后，对应文件进入系统提示词。";
}

/** 对话框占位文案。 */
export const DRAFT_PLACEHOLDER = "该角色的系统提示词（Markdown）";

/**
 * 保存成功后本地刷新一行。
 *
 * 原实现用 `Object.assign({}, x, { content: draft, updated_at: new Date() })`
 * 就地更新，不等服务端回读 —— 少一次往返，但要求这里的行为完全一致。
 */
export function withLocalContent(
  roles: readonly PromptRole[],
  active: string | null,
  content: string,
  now: string,
): readonly PromptRole[] {
  return roles.map((item) => (item.role === active ? { ...item, content, updatedAt: now } : item));
}

/**
 * 服务端刷新后要不要替换草稿。
 *
 * 原实现的草稿同步是 `useEffect([active, roles])` —— `roles` 换了就
 * **无条件**把草稿重置成该角色在服务端的正文。也就是说：保存/恢复默认后
 * 会重读一次角色表，草稿随之回到服务端值。这里给出判定条件，
 * 让组件与测试共用同一条规则。
 */
export function shouldSyncDraft(
  active: string | null,
  roles: readonly PromptRole[],
  currentDraft: string,
): boolean {
  if (active === null) return false;
  return draftFor(roles, active) !== currentDraft;
}
