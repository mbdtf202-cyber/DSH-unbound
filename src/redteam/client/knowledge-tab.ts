/**
 * 知识库页（`knowledge` 页签）的渲染。
 *
 * 数据与判定全在 `knowledge-model.ts`，这里只排版。
 *
 * ## 版面
 *
 * ```
 * 工具栏：知识库 · POC/EXP ｜ N 条 已验证 N 累计复用 N 本机模板 N ｜ 分组/刷新
 * 归类总览：RCE 12 · 反序列化 3 · 文件上传 0 · …
 * 检索行：搜索框 / 归类 / 来源靶标 / 发现资产 / 类型 / 只看已验证 / 检索
 * 消息 / 错误 / 知识库路径
 * 条目（按归类分组，或平铺）+ 本机 nuclei 模板分页
 * ```
 *
 * ## 两个原实现的细节，这里保留
 *
 * 1. **检索是显式动作**：输入框只改本地状态，回车或点「检索」才发请求。
 *    原注释：避免边打字边打接口。
 * 2. **归类条点一下就是筛选、再点取消**，并且**立即**重发检索 ——
 *    只改状态不重查会让用户以为没有匹配项。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import {
  DETAIL_LOADING_MESSAGE,
  LOADING_KB_MESSAGE,
  MISSING_CONTENT_MESSAGE,
  POC_CATEGORY_OPTIONS,
  POC_KIND_OPTIONS,
  STANDARD_ORDER_HINT,
  UNCATEGORIZED_TITLE,
  USED_ON_MANUAL,
  bucketKeyOf,
  cardClass,
  canNextPage,
  canPrevPage,
  categoryLabel,
  categoryName,
  categoryQuery,
  categoryTitle,
  contentBody,
  dbPathLine,
  detailFor,
  emptyDiagnosis,
  emptyTitle,
  errorText,
  groupCount,
  groupOrder,
  groupRecentLabel,
  groupVerified,
  hitCountLabel,
  itemSubLine,
  kindClass,
  knowledgeDataOf,
  pageOffset,
  pocDetailOf,
  pocKindLabel,
  pocSourceLabel,
  queryParams,
  searchLabel,
  showsCategory,
  showsDbPath,
  showsTemplateBlock,
  showsTemplateDir,
  showsUncategorized,
  statsLabels,
  templateCategoryLabel,
  templateCategoryMap,
  templateCommand,
  templateDirLine,
  templateRangeLabel,
  templateSeverity,
  usedMessage,
  verifiedClass,
  verifiedLabel,
  type KnowledgeData,
  type KnowledgeQuery,
  type PocDetail,
  type PocItem,
  type TemplatePage,
} from "./knowledge-model.js";
import { TEMPLATE_PAGE_SIZE } from "./knowledge-model.js";

/** 知识库页的消息。 */
export interface KnowledgeMessage {
  readonly kind: "ok" | "err";
  readonly text: string;
}

/** 知识库页的 props。 */
export interface KnowledgeTabProps {
  /** 检索结果（`null` = 还没读回来）。 */
  readonly data: KnowledgeData | null;
  /** 检索条件（本地状态）。 */
  readonly query: KnowledgeQuery;
  /** 当前展开的条目 id。 */
  readonly openId: number | null;
  /** 展开条目的详情（`null` = 还没读回来 / 读失败）。 */
  readonly detail: PocDetail | null;
  readonly detailBusy: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly message: KnowledgeMessage | null;
  /** 是否按归类分组（`false` = 平铺）。 */
  readonly grouped: boolean;
  readonly onQueryChange: (query: KnowledgeQuery) => void;
  /** 发起检索（用当前条件）。 */
  readonly onSubmit: () => void;
  /** 点归类条（立即检索）。 */
  readonly onCategoryChange: (code: string) => void;
  readonly onToggleGrouped: () => void;
  readonly onOpen: (id: number) => void;
  readonly onCopy: (text: string, label: string) => void;
  /** 记一次复用。 */
  readonly onUse: (item: PocItem) => void;
  /** 翻模板页。 */
  readonly onPage: (offset: number) => void;
}

/** 一张条目卡。 */
function cardNode(runtime: ConsoleRuntime, props: KnowledgeTabProps, item: PocItem): ReactNode {
  const { h } = runtime;
  const open = props.openId === item.id;
  const detail = detailFor(props.detail, props.openId);
  const hit = hitCountLabel(item);
  return h("div", { key: "p" + item.id, className: cardClass(open) },
    h("div", {
      className: "rt-kb-head",
      role: "button",
      tabIndex: 0,
      "aria-expanded": open ? "true" : "false",
      onClick: () => props.onOpen(item.id),
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          props.onOpen(item.id);
        }
      },
    },
      h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
      h("span", { className: kindClass(item) }, pocKindLabel(item.kind)),
      h("span", { className: "rt-kb-title" }, item.title),
      item.cve !== "" ? h("span", { className: "rt-tag rt-tag-passive" }, item.cve) : null,
      item.component !== "" ? h("span", { className: "rt-tag" }, item.component) : null,
      h("span", { className: verifiedClass(item) }, verifiedLabel(item)),
      h("div", { className: "rt-spacer" }),
      h("span", { className: "rt-tag" }, pocSourceLabel(item.source)),
      hit !== null ? h("span", { className: "rt-tag" }, hit) : null,
    ),
    h("div", { className: "rt-kb-sub" }, itemSubLine(item)),
    open
      ? h("div", { className: "rt-kb-body" },
          props.detailBusy && detail === null
            ? h("div", { className: "rt-empty" }, DETAIL_LOADING_MESSAGE)
            : null,
          detail !== null
            ? h("div", null,
                detail.usage !== ""
                  ? h("div", { className: "rt-kv" },
                      h("b", null, "用法"),
                      h("span", { className: "rt-mono" }, detail.usage))
                  : null,
                detail.description !== ""
                  ? h("div", { className: "rt-kv" },
                      h("b", null, "说明"),
                      h("span", null, detail.description))
                  : null,
                detail.verifiedNote !== ""
                  ? h("div", { className: "rt-kv" },
                      h("b", null, "验证证据"),
                      h("span", null, detail.verifiedNote))
                  : null,
                detail.usedOn !== ""
                  ? h("div", { className: "rt-kv" },
                      h("b", null, "最近使用"),
                      h("span", null, detail.usedOn))
                  : null,
                detail.path !== ""
                  ? h("div", { className: "rt-kv" },
                      h("b", null, "落盘"),
                      h("span", { className: "rt-mono" }, detail.path))
                  : null,
                h("div", { className: "rt-kb-actions" },
                  h("button", {
                    className: "rt-btn",
                    disabled: detail.content === "",
                    onClick: () => props.onCopy(detail.content, "POC 正文"),
                  }, "复制正文"),
                  h("button", {
                    className: "rt-btn",
                    onClick: () => props.onUse(item),
                  }, "记一次复用"),
                  detail.sourceUrl !== ""
                    ? h("button", {
                        className: "rt-btn",
                        onClick: () => props.onCopy(detail.sourceUrl, "来源链接"),
                      }, "复制来源")
                    : null,
                ),
                detail.content !== ""
                  ? h("pre", { className: "rt-rep-http" }, contentBody(detail.content))
                  : h("div", { className: "rt-empty" }, MISSING_CONTENT_MESSAGE),
              )
            : null,
        )
      : null,
  );
}

/** 归类总览条。 */
function categoryChips(
  runtime: ConsoleRuntime,
  props: KnowledgeTabProps,
  data: KnowledgeData,
): ReactNode {
  const { h } = runtime;
  const templateCounts = templateCategoryMap(data.templates);
  const chips: ReactNode[] = [];
  for (const category of data.stats.byCategory) {
    const shown = category.n + (templateCounts.get(category.code) ?? 0);
    if (!showsCategory(category, shown)) continue;
    chips.push(h("span", {
      key: category.code,
      className: "rt-concl-i" + (props.query.category === category.code ? " on" : ""),
      title: categoryTitle(category, shown, templateCounts.get(category.code) ?? 0),
      role: "button",
      tabIndex: 0,
      onClick: () => props.onCategoryChange(category.code),
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          props.onCategoryChange(category.code);
        }
      },
    },
      h("b", null, String(shown)),
      h("span", null, categoryLabel(category)),
    ));
  }
  return h("div", { className: "rt-kb-cats" }, chips);
}

/** 检索表单。 */
function filterRow(runtime: ConsoleRuntime, props: KnowledgeTabProps, data: KnowledgeData | null): ReactNode {
  const { h } = runtime;
  const query = props.query;
  return h("div", { className: "rt-kb-filter" },
    h("input", {
      className: "rt-input",
      style: { flex: 1, minWidth: 140 },
      placeholder: "搜 CVE / 组件 / 关键字（正文也会搜）",
      value: query.q,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onQueryChange({ ...query, q: value });
      },
      onKeyDown: (event) => {
        if (event.key === "Enter") props.onSubmit();
      },
    }),
    h("select", {
      className: "rt-input",
      style: { maxWidth: 120 },
      value: query.category,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        // 归类下拉是「改了立即检索」（与原实现一致）。
        props.onCategoryChange(value === "" ? "" : value);
      },
    }, POC_CATEGORY_OPTIONS.map((option) =>
      h("option", { key: option.value, value: option.value }, option.label))),
    h("select", {
      className: "rt-input",
      style: { maxWidth: 120 },
      value: query.engagement,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onQueryChange({ ...query, engagement: value });
      },
    },
      h("option", { value: "" }, "全部来源靶标"),
      (data?.stats.byEngagement ?? []).map((entry) =>
        h("option", { key: entry.engagement, value: entry.engagement },
          entry.engagement + "（" + entry.n + "）")),
    ),
    h("input", {
      className: "rt-input",
      style: { width: 120 },
      placeholder: "发现资产筛选",
      value: query.assetTarget,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onQueryChange({ ...query, assetTarget: value });
      },
      onKeyDown: (event) => {
        if (event.key === "Enter") props.onSubmit();
      },
    }),
    h("select", {
      className: "rt-input",
      style: { maxWidth: 110 },
      value: query.kind,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onQueryChange({ ...query, kind: value });
      },
    }, [
      h("option", { key: "all", value: "" }, "全部类型"),
      ...POC_KIND_OPTIONS.map((option) =>
        h("option", { key: option.value, value: option.value }, option.label)),
    ]),
    h("label", { className: "rt-kb-check" },
      h("input", {
        type: "checkbox",
        checked: query.verifiedOnly,
        onChange: (event) => {
          const checked = (event.target as { checked?: boolean } | null)?.checked === true;
          props.onQueryChange({ ...query, verifiedOnly: checked });
        },
      }),
      "只看已验证",
    ),
    h("button", { className: "rt-btn rt-btn-primary", onClick: () => props.onSubmit() }, "检索"),
  );
}

/** 本机 nuclei 模板块。 */
function templateBlock(
  runtime: ConsoleRuntime,
  props: KnowledgeTabProps,
  templates: TemplatePage,
): ReactNode {
  const { h } = runtime;
  if (!showsTemplateBlock(templates)) return null;
  const start = templates.offset;
  const shown = templates.items.length;
  return h("div", { className: "rt-kb-tpl" },
    h("div", { className: "rt-ap-sub" }, templateRangeLabel(templates, shown)),
    templates.items.map((template, index) =>
      h("div", { key: "t" + start + "-" + index, className: "rt-kb-tpl-row" },
        h("span", { className: "rt-tag" }, templateSeverity(template)),
        templateCategoryLabel(template) !== null
          ? h("span", { className: "rt-tag" }, templateCategoryLabel(template))
          : null,
        h("span", { className: "rt-mono rt-kb-tpl-path", title: template.path }, template.path),
        h("span", { className: "rt-kb-tpl-name", title: template.name }, template.name),
        h("button", {
          className: "rt-btn",
          style: { padding: "0 6px", fontSize: 10.5 },
          onClick: () => props.onCopy(templateCommand(template.path), "模板命令"),
        }, "复制命令"),
      )),
    h("div", { className: "rt-kb-actions" },
      h("button", {
        className: "rt-btn",
        disabled: !canPrevPage(props.busy, start),
        onClick: () => props.onPage(pageOffset(start - TEMPLATE_PAGE_SIZE)),
      }, "上一页"),
      h("button", {
        className: "rt-btn",
        disabled: !canNextPage(props.busy, start, shown, templates.matched),
        onClick: () => props.onPage(pageOffset(start + TEMPLATE_PAGE_SIZE)),
      }, "下一页"),
    ),
    showsTemplateDir(templates)
      ? h("div", { className: "rt-foot" }, h("span", null, templateDirLine(templates)))
      : null,
  );
}

/** 空态（含五种诊断）。 */
function emptyNode(
  runtime: ConsoleRuntime,
  props: KnowledgeTabProps,
  data: KnowledgeData | null,
): ReactNode {
  const { h } = runtime;
  if (data === null) {
    // 还没读回来：不诊断（否则首次进入会闪一下「知识库还是空的」）。
    return props.error === null ? h("div", { className: "rt-empty" }, LOADING_KB_MESSAGE) : null;
  }
  const templates = data.templates;
  if (data.items.length > 0 || templates.items.length > 0) return null;
  const diagnosis = emptyDiagnosis(props.query, templates);
  return h("div", { className: "rt-empty" },
    h("div", null, emptyTitle(diagnosis)),
    h("div", { style: { marginTop: 6, fontSize: 12 } }, STANDARD_ORDER_HINT),
    showsDbPath(data)
      ? h("div", { className: "rt-mono", style: { marginTop: 6, fontSize: 11 } },
          "知识库文件：" + data.dbPath)
      : null,
    showsTemplateDir(templates)
      ? h("div", { className: "rt-mono", style: { marginTop: 6, fontSize: 11 } },
          "模板目录：" + templates.dir)
      : null,
  );
}

/**
 * 渲染知识库页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderKnowledgeTab(runtime: ConsoleRuntime, props: KnowledgeTabProps): ReactNode {
  const { h } = runtime;
  const data = props.data;
  const items = data?.items ?? [];
  const stats = data?.stats ?? null;
  const templates = data?.templates ?? null;

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "知识库 · POC / EXP"),
    stats !== null
      ? statsLabels(stats, templates?.total ?? 0).map((label) =>
          h("span", { key: label, className: "rt-tag" }, label))
      : null,
    stats !== null && showsUncategorized(stats)
      ? h("span", { className: "rt-tag rt-tag-warn", title: UNCATEGORIZED_TITLE },
          "未归类 " + stats.uncategorized)
      : null,
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn" + (props.grouped ? " rt-btn-primary" : ""),
      title: "按归类分组显示 / 平铺显示",
      onClick: () => props.onToggleGrouped(),
    }, props.grouped ? "按归类分组" : "平铺显示"),
    h("button", {
      className: "rt-btn",
      disabled: props.busy,
      onClick: () => props.onSubmit(),
    }, searchLabel(props.busy)),
  );

  const messageNode = props.message !== null
    ? h("div", { className: props.message.kind === "err" ? "rt-err" : "rt-foot" }, props.message.text)
    : null;

  const errorNode = props.error !== null
    ? h("div", { className: "rt-err" }, errorText(props.error))
    : null;

  const dbNode = props.error === null && data !== null && data.dbPath !== ""
    ? h("div", { className: "rt-foot", style: { marginBottom: 6, fontSize: 11 } }, dbPathLine(data))
    : null;

  const listBody: ReactNode[] = [];
  if (props.grouped) {
    const buckets = new Map<string, PocItem[]>();
    for (const item of items) {
      const code = bucketKeyOf(item);
      const bucket = buckets.get(code);
      if (bucket === undefined) buckets.set(code, [item]);
      else bucket.push(item);
    }
    const order = groupOrder([...buckets.keys()]);
    for (const code of order) {
      const list = buckets.get(code) ?? [];
      listBody.push(h("div", { key: "g" + code, className: "rt-kb-cat" },
        h("span", { className: "rt-kb-cat-name" }, categoryName(code)),
        h("span", { className: "rt-tag" }, groupCount(list) + " 条"),
        h("span", { className: "rt-tag rt-tag-live" }, "已验证 " + groupVerified(list)),
        h("span", { className: "rt-spacer" }),
        h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } },
          groupRecentLabel(list)),
      ));
      for (const item of list) listBody.push(cardNode(runtime, props, item));
    }
  } else {
    for (const item of items) listBody.push(cardNode(runtime, props, item));
  }

  return h("div", { className: "rt-main" },
    toolbar,
    data !== null ? categoryChips(runtime, props, data) : null,
    filterRow(runtime, props, data),
    messageNode,
    errorNode,
    dbNode,
    h("div", { className: "rt-table" },
      listBody,
      templates !== null ? templateBlock(runtime, props, templates) : null,
      emptyNode(runtime, props, data),
    ),
    h("div", { className: "rt-foot" },
      h("span", null, "全局共享（跨靶标）｜ 落盘：pocs/<code>/ ｜ 只收录通用可复用的 POC/EXP，靶标专用脚本走「攻击文件」")),
  );
}

/** 检索。 */
export async function searchPoc(api: ApiClient, query: KnowledgeQuery): Promise<ApiResponse> {
  return api.raw({ op: "pocSearch", ...queryParams(query) });
}

/** 读详情。 */
export async function loadPocDetail(api: ApiClient, id: number): Promise<ApiResponse> {
  return api.raw({ op: "pocGet", id });
}

/** 记一次复用。 */
export async function usePoc(api: ApiClient, id: number): Promise<ApiResponse> {
  return api.raw({ op: "pocUse", id, used_on: USED_ON_MANUAL });
}

/** 从检索响应解析（失败 → `null`，错误由容器单独保存）。 */
export function knowledgeOf(response: ApiResponse): KnowledgeData | null {
  return knowledgeDataOf(response);
}

/** 检索错误文案。 */
export function failureText(response: ApiResponse): string | null {
  if (response.ok === false) return response.error ?? "读取失败";
  return null;
}

/** 详情错误文案。 */
export function detailFailureText(response: ApiResponse): string | null {
  if (response.ok === false) return response.error ?? "读取失败";
  return null;
}

/** 复用成功的消息。 */
export function useSuccessMessage(item: PocItem): KnowledgeMessage {
  return { kind: "ok", text: usedMessage(item.title) };
}

/** 点归类条后应使用的新检索条件。 */
export function queryAfterCategory(query: KnowledgeQuery, code: string): KnowledgeQuery {
  return categoryQuery(query, code);
}

/** 详情解析（供容器直接用）。 */
export function detailOf(response: ApiResponse): PocDetail | null {
  return pocDetailOf(response);
}
