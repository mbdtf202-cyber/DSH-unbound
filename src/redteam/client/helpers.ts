/**
 * 界面层的纯助手：把原 `client.js` 里那些能脱离 React 与 DOM 的逻辑搬出来。
 *
 * 之所以先做这一层：组件层有 1,228 个 `h()` 调用点，如果助手还混在组件里，
 * 每个组件都得连着 React 一起测。抽出来之后它们都是纯函数，
 * 可以穷举、可以对照原实现、不需要 mock。
 *
 * ## 与原实现的关系
 *
 * 每个函数都在注释里标了原实现的对应片段。**行为必须等价** ——
 * 有几处原实现的行为看着像 bug（比如 `fmt` 把 `T` 换成空格后又 slice），
 * 但它们是界面上已经定型的样子，改动属于产品决策，不该夹带在迁移里。
 * 这类地方显式标注「保留原行为」。
 */

import type { MinimalPointerEventLike } from "./h.js";

/** 可点击元素的 props 片段。 */
export interface ClickableProps {
  readonly role: "button";
  readonly tabIndex: number;
  readonly onClick: (event: MinimalPointerEventLike) => void;
  readonly onKeyDown: (event: MinimalPointerEventLike) => void;
  readonly "aria-label"?: string;
  readonly "aria-expanded"?: "true" | "false";
}

/** `clickable` 的选项。 */
export interface ClickableOptions {
  /** 进 `aria-label`：读屏软件播报的名字。 */
  readonly label?: string;
  /** 进 `aria-expanded`：折叠控件的展开态。 */
  readonly expanded?: boolean;
}

/**
 * 给「可点击但不是 `<button>`」的元素补上键盘可达性。
 *
 * 原实现的注释记了动机：面板里大量用 div/span 当按钮（表格行、页签、
 * 结论条、C 段条目），鼠标能点、键盘够不着；而且这类元素此前有 16 处
 * 各写各的、写法还不一致（有的只有 role，有的漏了 Space 键）。
 *
 * **不要**用它包真正的 `<button>`（原生按钮自带全部语义）。
 */
export function clickable(
  onActivate: (event: MinimalPointerEventLike) => void,
  options: ClickableOptions = {},
): ClickableProps {
  const props: ClickableProps = {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event) => {
      // Enter 与 Space 是按钮的标准激活键；Space 还要阻止页面滚动。
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        onActivate(event);
      }
    },
    ...(options.label !== undefined ? { "aria-label": String(options.label) } : {}),
    ...(options.expanded !== undefined
      ? { "aria-expanded": options.expanded ? ("true" as const) : ("false" as const) }
      : {}),
  };
  return props;
}

/**
 * 时间戳 → `YYYY-MM-DD HH:MM`。
 *
 * 原实现：`(s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')`
 *
 * **保留原行为**：它不是真日期解析，只是把 ISO 串里第一个 `T` 换成空格
 * 再截 16 字符。好处是零依赖、对任何形态的串都不会抛；
 * 坏处是时区不做转换（显示的是 UTC 串的字面值）。
 * 这是界面已定型的样子，改成 `Intl.DateTimeFormat` 会改变所有已有截图与报告。
 */
export function formatTimestamp(value: unknown): string {
  // **必须用原样的真值判定**：`0` 在这里应显示 `—`（原实现是 `s ? ... : '—'`）。
  // 改成 `value === ""` 之类会把 `0` 显示成 `"0"`，与既有界面/报告不一致。
  return value ? String(value).replace("T", " ").slice(0, 16) : "—";
}

/**
 * 时间戳 → `MM-DD HH:MM`（列表里宽度紧张时用）。
 *
 * 原实现：先 `replace('T',' ')`，长度 ≥16 时 `slice(5, 16)`。
 * 也就是从第 5 个字符开始（跳过 `YYYY-`），保留 `MM-DD HH:MM`。
 */
export function formatTimestampShort(value: unknown): string {
  const text = String(value ?? "").replace("T", " ");
  return text.length >= 16 ? text.slice(5, 16) : text || "—";
}

/**
 * 把任意值收敛为「人类可读的一行」。
 *
 * 用于 `error` 字段：它可能是 `Error`、字符串、或某种对象。
 * 原实现各处写 `e && e.message ? e.message : String(e)`，这里统一。
 */
export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const candidate = (value as Record<string, unknown>)["message"];
    if (typeof candidate === "string") return candidate;
  }
  return String(value);
}

/**
 * 判断某个响应是否表示业务失败。
 *
 * 桥接层的错误响应是 `{ ok: false, error }`；成功响应可能带
 * 数组 / 对象 / `{ ok: true }`。这里把「失败」的判定集中一处，
 * 避免组件里散落 `if (!r || r.ok === false)`。
 */
export function isFailure(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  if (typeof response !== "object") return false;
  return (response as Record<string, unknown>)["ok"] === false;
}

/** 从响应里取数组字段（缺失或形态不对 → 空数组）。 */
export function arrayOf<T>(response: unknown, key: string): readonly T[] {
  if (typeof response !== "object" || response === null) return [];
  const value = (response as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/** 从响应里取对象字段（缺失或形态不对 → `null`）。 */
export function recordOf(response: unknown, key: string): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) return null;
  const value = (response as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从响应里取数字字段（缺失或非有限 → 0）。 */
export function numberOf(response: unknown, key: string): number {
  if (typeof response !== "object" || response === null) return 0;
  const value = Number((response as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : 0;
}

/** 从响应里取字符串字段（缺失 → `""`）。 */
export function stringOf(response: unknown, key: string): string {
  if (typeof response !== "object" || response === null) return "";
  const value = (response as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * 拼接 className，跳过假值。
 *
 * 原实现到处写 `'rt-btn' + (disabled ? ' on' : '')`，拼错空格就会出现
 * `rt-btnon` 这种静默失效的类名。用小工具收敛，多类名也安全。
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" ");
}

/**
 * 把过滤条件对象里的空值去掉。
 *
 * 原实现每个查询都写 `cidr: cidr || undefined`，一个字段一行。
 * 这里统一：空串 / null / undefined / 空数组都视为「不过滤」。
 *
 * 注意布尔 `false` **保留** —— 它是有效筛选值（如 `showAll: false`）。
 */
export function compactQuery(
  input: Readonly<Record<string, string | number | boolean | null | undefined>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * 生成 `<option>` 列表需要的「值 + 显示名」数组。
 *
 * 输入是「表」+「顺序」，输出保持顺序；表里有的但顺序没列出的项
 * **追加在末尾**（防止上游加了新状态后下拉框里看不到它 —— 原实现用
 * `Object.keys` 直接当顺序，不会漏；这里显式补一步，等价但更清楚）。
 */
export function optionEntries(
  table: Readonly<Record<string, string>>,
  order?: readonly string[],
): readonly { readonly value: string; readonly label: string }[] {
  const keys = order ?? Object.keys(table);
  const seen = new Set<string>();
  const out: { readonly value: string; readonly label: string }[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    const label = table[key];
    // 顺序数组里出现表外的键：**跳过**，不要凭空造一个 value=key/label=key 的选项
    // （那会让下拉框里冒出一个后端根本不认识的值）。
    if (label === undefined) continue;
    seen.add(key);
    out.push({ value: key, label });
  }
  for (const [key, label] of Object.entries(table)) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: key, label });
  }
  return out;
}

/**
 * 判断 URL hash 是否是「全面浏览」独立窗口。
 *
 * 原实现：`String(window.location.hash || '') === '#redteam-full'`。
 * 这个窗口复用同一套界面代码，只靠 hash 区分外壳形态。
 */
export const FULL_WINDOW_HASH = "#redteam-full";

/** 判断 hash 是否是全面浏览窗口。 */
export function isFullWindowHash(hash: unknown): boolean {
  return String(hash ?? "") === FULL_WINDOW_HASH;
}

/**
 * 构造「全面浏览」窗口的 URL。
 *
 * 原实现：`window.location.href.split('#')[0] + '#redteam-full'`。
 * 保留「先砍掉已有 hash 再拼」的行为，否则从全面浏览窗口再点一次
 * 会得到 `...#redteam-full#redteam-full`。
 */
export function fullWindowUrl(href: string): string {
  return href.split("#")[0] + FULL_WINDOW_HASH;
}

/**
 * 证据截图的缓存键。
 *
 * 原实现用 `eng + ':' + id` 拼字符串；这里保留同样格式（现有缓存逻辑依赖它），
 * 但集中一处，避免某处写成 `id + eng` 导致同一张图命中不了缓存。
 */
export function shotCacheKey(engagement: string, shotId: string | number): string {
  return `${engagement}:${shotId}`;
}

/** 图片 data URL（证据截图走 base64 内联，避免额外鉴权路由）。 */
export function shotDataUrl(base64: unknown, mime: unknown): string {
  if (typeof base64 !== "string" || base64 === "") return "";
  const type = typeof mime === "string" && mime !== "" ? mime : "image/png";
  return `data:${type};base64,${base64}`;
}

/**
 * 面板元素的 `data-open` 属性值。
 *
 * 原实现写 `st.open ? '1' : '0'`（字符串，供 CSS 属性选择器用）。
 */
export function dataOpen(open: boolean): "1" | "0" {
  return open ? "1" : "0";
}

/**
 * 把标签栏的 `[id, label]` 元组转成对象。
 *
 * 原实现直接用元组数组（`tabs = [['assets', '资产测绘'], ...]`），
 * 取值靠 `t[0]` / `t[1]` —— 打错索引不会报错。集中转换一次。
 */
export function pairToTab(pair: readonly [string, string]): { readonly id: string; readonly label: string } {
  return { id: pair[0], label: pair[1] };
}
