/**
 * 漏洞战果页（`findings` 页签）的渲染。
 *
 * 数据与判定全在 `findings-model.ts`，这里只排版。
 *
 * ## 结构（原实现是一个页签套四个子页签）
 *
 * ```
 * 工具栏：搜索 / 等级 / 状态
 * 结论行：已确认 3 · 已利用 1 · 严重 2 · 高危 5 · 中危 8 · 拿到权限 4
 * 子页签：漏洞 N ｜ 攻击文件 N ｜ 凭据 N ｜ 访问会话 N
 * 正文：
 *   漏洞   → 按目标聚合（可折叠的分组）/ 平铺表格
 *   攻击文件 → 复用攻击文件页
 *   凭据   → 明文直显（带复制）
 *   访问会话 → 一行一条
 * ```
 *
 * ## 两个原实现的细节，这里保留
 *
 * 1. **「拿到权限」不可点**：它来自独立统计（`stats.withGained`），
 *    后端没有对应筛选参数。原实现给的是空回调 —— 不给空按钮看起来像坏了，
 *    但把它做成筛选项会得到一个永远空的结果集。
 * 2. **聚合视图的折叠头是分组标题，不是漏洞行**：`全部展开/全部收起`
 *    两个按钮只在聚合视图出现，平铺视图下没有意义。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import type { CollapseState } from "./state.js";
import { isSectionOpen, toggleSection } from "./state.js";
import { formatTimestamp } from "./helpers.js";
import {
  EMPTY_ACCESS_MESSAGE,
  EMPTY_CREDENTIALS_MESSAGE,
  EMPTY_FINDINGS_MESSAGE,
  MISSING_ATTACK_FILE_MESSAGE,
  MISSING_EVIDENCE_MESSAGE,
  MISSING_GAINED_MESSAGE,
  RESTART_HINT,
  SEVERITY_OPTIONS,
  STATUS_ACTIONS,
  STATUS_OPTIONS,
  accessHeading,
  accessesOf,
  attackFileGroupsOf,
  attackFilesHint,
  conclusionClass,
  conclusionItems,
  conclusionLabel,
  confidenceLabel,
  credentialMeta,
  credentialsHeading,
  credentialsOf,
  evidenceHeadLabel,
  evidenceMissing,
  gainedSummary,
  groupByTarget,
  groupCountLabel,
  groupGainedLabel,
  groupSubtitle,
  httpBlockClass,
  httpLineClass,
  httpLineKind,
  httpLinesOf,
  indexFilesByVuln,
  looksLikeHttp,
  needsRestart,
  severityClass,
  severityLabel,
  statusLabel,
  statusUpdatedMessage,
  subTabAriaLabel,
  subTabClass,
  subTabLabel,
  targetKeyOf,
  targetSummary,
  vulnAssetLine,
  vulnSourceLine,
  vulnTarget,
  vulnTitle,
  type AccessRow,
  type AttackFileGroup,
  type AttackFileRow,
  type ConclusionItem,
  type CredentialRow,
  type FindingsList,
  type FindingsSubTab,
  type HttpEvidence,
  type Severity,
  type VulnItem,
  type VulnStatus,
} from "./findings-model.js";

/** 表单消息（与其它页签同形）。 */
export interface FindingsMessage {
  readonly kind: "ok" | "err";
  readonly text: string;
}

/** 查询过滤条件。 */
export interface FindingsFilter {
  /** 输入框里的搜索词（未提交）。 */
  readonly query: string;
  /** 已提交的搜索词（改它才触发查询）。 */
  readonly queryApplied: string;
  readonly severity: string;
  readonly status: string;
}

/** 默认过滤（全显示）。 */
export const DEFAULT_FINDINGS_FILTER: FindingsFilter = Object.freeze({
  query: "",
  queryApplied: "",
  severity: "",
  status: "",
});

/** 漏洞战果页的 props。 */
export interface FindingsTabProps {
  /** 漏洞查询结果（`null` = 还没加载）。 */
  readonly findings: FindingsList | null;
  readonly credentials: readonly CredentialRow[];
  readonly accesses: readonly AccessRow[];
  /** 攻击文件分组（含 vuln_id 的关联关系）。 */
  readonly fileGroups: readonly AttackFileGroup[];
  readonly filter: FindingsFilter;
  readonly subTab: FindingsSubTab;
  /** 是否按目标聚合（`false` = 平铺）。 */
  readonly grouped: boolean;
  /** 当前展开的漏洞 id。 */
  readonly openId: number | null;
  /** 折叠状态（聚合分组用）。 */
  readonly collapse: CollapseState;
  readonly message: FindingsMessage | null;
  /** 攻击文件子页签的内容（由容器渲染，避免本页依赖攻击文件页的 props）。 */
  readonly attackFilesNode?: ReactNode;
  readonly onFilterChange: (filter: FindingsFilter) => void;
  /** 提交搜索（回车或点「搜索」）。 */
  readonly onSubmitQuery: () => void;
  readonly onSubTabChange: (tab: FindingsSubTab) => void;
  readonly onToggleGrouped: () => void;
  readonly onToggleOpen: (id: number) => void;
  readonly onCollapseChange: (state: CollapseState) => void;
  readonly onSetAllCollapsed: (keys: readonly string[], open: boolean) => void;
  readonly onUpdateStatus: (id: number, status: VulnStatus) => void;
  readonly onCopy: (text: string, label: string) => void;
}

/**
 * 折叠分组头（原实现的 `Section` 组件）。
 *
 * 上游把它做成可复用组件，但它不在本工作流的写入域里，所以这里按同样的
 * 元素结构与 class 名复刻一份 —— 样式表里的 `rt-sec*` 是现成的。
 */
function sectionNode(
  runtime: ConsoleRuntime,
  options: {
    readonly key: string;
    readonly tone: string;
    readonly title: string;
    readonly count: string;
    readonly sub: string;
    readonly right: string;
    readonly open: boolean;
    readonly onToggle: (event: unknown) => void;
  },
  children: ReactNode,
): ReactNode {
  const { h } = runtime;
  return h("div", { key: options.key, className: "rt-sec-wrap" },
    h("div", {
      className: "rt-sec t-" + options.tone,
      role: "button",
      tabIndex: 0,
      "aria-expanded": options.open ? "true" : "false",
      onClick: options.onToggle,
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          options.onToggle(event);
        }
      },
    },
      h("span", { className: "rt-sec-caret" }, options.open ? "▾" : "▸"),
      options.title !== "" ? h("span", { className: "rt-sec-title" }, options.title) : null,
      h("span", { className: "rt-sec-count" }, options.count),
      options.sub !== "" ? h("span", { className: "rt-sec-sub" }, options.sub) : null,
      options.right !== "" ? h("span", { className: "rt-sec-right" }, options.right) : null,
    ),
    options.open ? h("div", { className: "rt-sec-body" }, children) : null,
  );
}

/**
 * 一段原始 HTTP 报文（原 `HttpBlock`）。
 *
 * 逐行加 `<div>` 而不是整段塞 `<pre>`：行级着色才能在长报文里一眼找到
 * 请求行与关键头。
 */
function httpBlock(runtime: ConsoleRuntime, text: string, compact: boolean): ReactNode {
  if (text === "") return null;
  const lines = httpLinesOf(text);
  return runtime.h("pre", { className: httpBlockClass(compact) },
    lines.map((line, index) => {
      const cls = httpLineClass(httpLineKind(line, index));
      return runtime.h("div", { key: "l" + index, className: cls }, line);
    }),
  );
}

/** 证据区（原 `detailEvidence`）。 */
function evidenceNode(runtime: ConsoleRuntime, props: FindingsTabProps, vuln: VulnItem): ReactNode {
  const { h } = runtime;
  const blocks: ReactNode[] = [];
  const evidence = vuln.evidence.trim();
  if (evidence !== "") {
    const isHttp = looksLikeHttp(evidence);
    blocks.push(h("div", { key: "ev", className: "rt-evi" },
      h("div", { className: "rt-evi-head" }, "证据摘要",
        h("span", { className: "rt-tag" }, isHttp ? "原始报文" : "文本"),
        h("div", { className: "rt-spacer" }),
        h("button", {
          className: "rt-btn",
          style: { padding: "0 6px", fontSize: 11 },
          onClick: (event) => {
            event.stopPropagation?.();
            props.onCopy(evidence, "证据摘要");
          },
        }, "复制"),
      ),
      isHttp ? httpBlock(runtime, evidence, false) : h("pre", { className: "rt-evi-body" }, evidence),
    ));
  }
  for (const entry of vuln.httpEvidence) {
    blocks.push(h("div", { key: "h" + entry.id, className: "rt-evi" },
      h("div", { className: "rt-evi-head" },
        entry.label !== "" ? entry.label : "HTTP 证据",
        h("span", { className: "rt-tag" }, evidenceHeadLabel(entry)),
        h("div", { className: "rt-spacer" }),
        h("span", { style: { fontWeight: 400, color: "var(--dsw-alias-label-secondary)" } },
          formatTimestamp(entry.capturedAt)),
      ),
      entry.request !== ""
        ? h("div", null,
            h("div", { className: "rt-evi-head", style: { borderTop: "none" } },
              "▸ 请求（可直接粘进 Burp Repeater）"),
            httpBlock(runtime, entry.request, true),
          )
        : null,
      entry.response !== ""
        ? h("div", null,
            h("div", { className: "rt-evi-head" }, "▸ 响应"),
            httpBlock(runtime, entry.response, false),
          )
        : null,
      entry.note !== ""
        ? h("pre", { className: "rt-evi-body", style: { maxHeight: 80 } }, entry.note)
        : null,
    ));
  }
  if (blocks.length === 0) {
    blocks.push(h("div", { key: "none", className: "rt-kv" },
      h("b", null, "证据"),
      h("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, MISSING_EVIDENCE_MESSAGE),
    ));
  }
  return h("div", { key: "eviwrap" }, blocks);
}

/**
 * 取「拿到什么」的列表，**缺字段时退化为空数组**。
 *
 * `VulnItem.gainedList` 类型上是必填，由 `vulnOf()` 从 `gained` 字符串解析而来。
 * 但渲染层是公开纯函数，容器可能把**未经 `vulnOf` 的原始对象**直接喂进来
 * （宿主新增字段、或上层漏跑一次解析）—— 此时 `vuln.gainedList` 是
 * `undefined`，直接 `.length` 会让**整个漏洞页签崩掉**：
 *
 *     TypeError: Cannot read properties of undefined (reading 'length')
 *
 * 页签级崩溃比「某一列显示 —」严重得多：用户看到整页空白且无法自救。
 * 这里做一次防御，宁可少显示一列。
 */
function gainedListOfRow(vuln: VulnItem): readonly string[] {
  const value = (vuln as { readonly gainedList?: unknown }).gainedList;
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** 一条漏洞的展开详情。 */
function vulnDetail(
  runtime: ConsoleRuntime,
  props: FindingsTabProps,
  vuln: VulnItem,
  mine: readonly AttackFileRow[],
): ReactNode {
  const { h } = runtime;
  return h("div", { className: "rt-vdetail" },
    h("div", { className: "rt-kv" },
      h("b", null, "拿到什么"),
      gainedListOfRow(vuln).length > 0
        ? h("span", null, gainedListOfRow(vuln).map((item, index) =>
            h("span", { key: "g" + index, className: "rt-gain", style: { marginRight: 6 } }, item)))
        : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, MISSING_GAINED_MESSAGE),
    ),
    h("div", { className: "rt-kv" },
      h("b", null, "目标"),
      h("span", { className: "rt-mono", style: { wordBreak: "break-all" } },
        vuln.target !== "" ? vuln.target : "—"),
    ),
    h("div", { className: "rt-kv" }, h("b", null, "资产"), h("span", null, vulnAssetLine(vuln))),
    h("div", { className: "rt-kv" }, h("b", null, "来源"), h("span", null, vulnSourceLine(vuln))),
    evidenceNode(runtime, props, vuln),
    h("div", { className: "rt-kv" },
      h("b", null, "攻击文件"),
      mine.length > 0
        ? h("span", null, mine.map((file, index) =>
            h("div", { key: "af" + index, style: { marginBottom: 3 } },
              "· " + (file.kind !== "" ? "[" + file.kind + "] " : "") + (file.name !== "" ? file.name : "(未命名)")
              + (file.description !== "" ? " — " + file.description : ""),
              h("div", {
                className: "rt-mono",
                style: {
                  fontSize: 11,
                  marginLeft: 12,
                  color: "var(--dsw-alias-label-secondary)",
                  overflowWrap: "anywhere",
                },
              }, file.path),
            )))
        : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, MISSING_ATTACK_FILE_MESSAGE),
    ),
    h("div", { className: "rt-actions" },
      STATUS_ACTIONS.map((action) =>
        h("button", {
          key: action.status,
          className: "rt-btn",
          onClick: (event) => {
            event.stopPropagation?.();
            props.onUpdateStatus(vuln.id, action.status);
          },
        }, action.label))),
  );
}

/** 一条漏洞行（含展开详情）。 */
function vulnRowNodes(
  runtime: ConsoleRuntime,
  props: FindingsTabProps,
  vuln: VulnItem,
  compact: boolean,
  filesByVuln: ReadonlyMap<number, readonly AttackFileRow[]>,
): readonly ReactNode[] {
  const { h } = runtime;
  const open = props.openId === vuln.id;
  const out: ReactNode[] = [];
  out.push(h("div", {
    key: "v" + vuln.id,
    className: "rt-vrow",
    role: "button",
    tabIndex: 0,
    style: compact
      ? { cursor: "pointer", gridTemplateColumns: "58px minmax(0,1fr) 104px 68px" }
      : { cursor: "pointer" },
    onClick: () => props.onToggleOpen(vuln.id),
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        props.onToggleOpen(vuln.id);
      }
    },
  },
    h("span", null, h("span", { className: severityClass(vuln.severity) }, severityLabel(vuln.severity))),
    h("span", { title: vuln.title },
      h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
      vulnTitle(vuln)),
    compact ? null : h("span", { className: "rt-mono", title: vuln.target }, vulnTarget(vuln)),
    h("span", { title: vuln.gained },
      gainedListOfRow(vuln).length > 0
        ? h("span", {
            className: "rt-gain",
            style: {
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "inline-block",
            },
          }, gainedSummary(gainedListOfRow(vuln)))
        : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, "—")),
    h("span", null, h("span", { className: "rt-tag" }, statusLabel(vuln.status))),
    compact ? null : h("span", null, confidenceLabel(vuln.confidence)),
  ));
  if (!open) return out;
  out.push(h("div", {
    key: "vd" + vuln.id,
    className: "rt-vrow",
    style: { cursor: "default", gridTemplateColumns: "1fr" },
  }, vulnDetail(runtime, props, vuln, filesByVuln.get(vuln.id) ?? [])));
  return out;
}

/** 聚合视图的一个分组。 */
function groupNode(
  runtime: ConsoleRuntime,
  props: FindingsTabProps,
  group: ReturnType<typeof groupByTarget>[number],
  filesByVuln: ReadonlyMap<number, readonly AttackFileRow[]>,
): ReactNode {
  const key = "target:" + group.key;
  const open = isSectionOpen(props.collapse, key, false);
  return sectionNode(
    runtime,
    {
      key: "sec:" + group.key,
      tone: "target",
      title: group.key,
      count: groupCountLabel(group),
      sub: groupSubtitle(group),
      right: groupGainedLabel(group),
      open,
      onToggle: () => props.onCollapseChange(toggleSection(props.collapse, key, false)),
    },
    group.vulns.map((vuln) => vulnRowNodes(runtime, props, vuln, true, filesByVuln)),
  );
}

/** 结论行的一项。 */
function conclusionNode(runtime: ConsoleRuntime, item: ConclusionItem, onClick: () => void): ReactNode {
  return runtime.h("span", {
    key: item.code,
    className: conclusionClass(item),
    title: "点击筛选 / 再点取消",
    role: "button",
    tabIndex: 0,
    "aria-label": conclusionLabel(item),
    "aria-expanded": item.active ? "true" : "false",
    onClick,
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        onClick();
      }
    },
  },
    runtime.h("b", null, String(item.count)),
    runtime.h("span", null, item.label),
  );
}

/** 凭据区。 */
function credentialsSection(runtime: ConsoleRuntime, props: FindingsTabProps): ReactNode {
  const { h } = runtime;
  return h("div", null,
    h("div", { className: "rt-section" }, credentialsHeading(props.credentials.length)),
    props.credentials.length > 0
      ? h("div", { style: { padding: "4px 10px 0" } },
          props.credentials.map((cred) =>
            h("div", { key: "c" + cred.id, className: "rt-cred" },
              h("div", { className: "rt-cred-head" },
                h("span", { className: "rt-cred-host" }, cred.host),
                cred.username !== "" ? h("span", { className: "rt-tag" }, cred.username) : null,
                h("span", { className: "rt-tag rt-tag-passive" },
                  cred.secretType !== "" ? cred.secretType : "password"),
                cred.privilege !== "" ? h("span", { className: "rt-tag rt-tag-active" }, cred.privilege) : null,
                h("div", { className: "rt-spacer" }),
                h("button", {
                  className: "rt-btn",
                  style: { padding: "0 6px", fontSize: 11 },
                  onClick: (event) => {
                    event.stopPropagation?.();
                    props.onCopy(cred.secretValue, "凭据 " + cred.host);
                  },
                }, "复制"),
              ),
              cred.secretValue !== ""
                ? h("div", { className: "rt-secret", title: "点击可全选" }, cred.secretValue)
                : h("div", { className: "rt-secret-none" },
                    "未记明文 —— 请用 redteam_credential_add 的 secret_value 补上，面板才能直显"),
              h("div", { className: "rt-cred-meta" }, credentialMeta(cred)),
              cred.note !== "" ? h("div", { className: "rt-cred-meta" }, "备注：" + cred.note) : null,
            )))
      : h("div", { className: "rt-empty" }, EMPTY_CREDENTIALS_MESSAGE),
  );
}

/** 访问会话区。 */
function accessSection(runtime: ConsoleRuntime, props: FindingsTabProps): ReactNode {
  const { h } = runtime;
  return h("div", null,
    h("div", { className: "rt-section" }, accessHeading(props.accesses.length)),
    props.accesses.length > 0
      ? props.accesses.map((access) =>
          h("div", {
            key: "a" + access.id,
            className: "rt-vrow",
            style: { cursor: "default", gridTemplateColumns: "1fr 110px 80px 80px 1fr" },
          },
            h("span", { className: "rt-mono" }, access.host),
            h("span", null, access.username !== "" ? access.username : "—"),
            h("span", null, h("span", { className: "rt-tag rt-tag-active" },
              access.method !== "" ? access.method : "—")),
            h("span", null, access.privilege !== "" ? access.privilege : "—"),
            h("span", { className: "rt-mono", title: access.sessionRef },
              access.sessionRef !== "" ? access.sessionRef : "—"),
          ))
      : h("div", { className: "rt-empty" }, EMPTY_ACCESS_MESSAGE),
  );
}

/**
 * 渲染漏洞战果页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderFindingsTab(runtime: ConsoleRuntime, props: FindingsTabProps): ReactNode {
  const { h } = runtime;
  const findings = props.findings;
  const items = findings?.items ?? [];
  const stats = findings?.stats;
  const error = findings?.error ?? null;
  const loading = findings?.loading === true;
  const total = findings?.total ?? 0;
  const grouped = props.grouped;
  const restartHint = needsRestart(error);

  const conclusion = h("div", { className: "rt-concl" },
    conclusionItems(stats ?? EMPTY_STATS, props.filter.severity, props.filter.status)
      .map((item) =>
        conclusionNode(runtime, item, () => {
          // 「拿到权限」不是筛选项：既不筛也不取消（原实现给的空回调）。
          if (item.code === "gained") return;
          if (item.code === "confirmed" || item.code === "exploited") {
            props.onFilterChange({ ...props.filter, status: item.next });
            return;
          }
          props.onFilterChange({ ...props.filter, severity: item.next });
        })),
    h("div", { className: "rt-spacer" }),
    h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } },
      targetSummary(stats ?? EMPTY_STATS)),
  );

  const toolbar = h("div", { className: "rt-toolbar" },
    h("input", {
      className: "rt-input",
      style: { flex: "1 1 140px" },
      placeholder: "搜索标题 / CVE / 目标（回车）",
      value: props.filter.query,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onFilterChange({ ...props.filter, query: value });
      },
      onKeyDown: (event) => {
        if (event.key === "Enter") props.onSubmitQuery();
      },
    }),
    h("button", { className: "rt-btn", onClick: () => props.onSubmitQuery() }, "搜索"),
    h("select", {
      className: "rt-input",
      value: props.filter.severity,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onFilterChange({ ...props.filter, severity: value });
      },
    }, SEVERITY_OPTIONS.map((option) =>
      h("option", { key: option.value, value: option.value }, option.label))),
    h("select", {
      className: "rt-input",
      value: props.filter.status,
      onChange: (event) => {
        const value = String((event.target as { value?: string } | null)?.value ?? "");
        props.onFilterChange({ ...props.filter, status: value });
      },
    }, STATUS_OPTIONS.map((option) =>
      h("option", { key: option.value, value: option.value }, option.label))),
  );

  const indexed = indexFilesByVuln(props.fileGroups);

  const subTabs = h("div", { className: "rt-subtabs" },
    (["vulns", "files", "creds", "access"] as const).map((key) => {
      const label = key === "vulns" ? "漏洞" : key === "files" ? "攻击文件" : key === "creds" ? "凭据" : "访问会话";
      const count = key === "vulns"
        ? total
        : key === "files"
          ? indexed.all.length
          : key === "creds"
            ? props.credentials.length
            : props.accesses.length;
      return h("span", {
        key,
        className: subTabClass(key, props.subTab),
        role: "button",
        tabIndex: 0,
        "aria-label": subTabAriaLabel(label, count),
        "aria-expanded": props.subTab === key ? "true" : "false",
        onClick: () => props.onSubTabChange(key),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault?.();
            props.onSubTabChange(key);
          }
        },
      }, subTabLabel(label, count));
    }),
    h("div", { className: "rt-spacer" }),
    grouped
      ? h("button", {
          className: "rt-btn",
          title: "展开所有目标",
          onClick: () => props.onSetAllCollapsed(
            items.map((vuln) => "target:" + targetKeyOfVuln(vuln)),
            true,
          ),
        }, "全部展开")
      : null,
    grouped
      ? h("button", {
          className: "rt-btn",
          title: "收起所有目标",
          onClick: () => props.onSetAllCollapsed(
            items.map((vuln) => "target:" + targetKeyOfVuln(vuln)),
            false,
          ),
        }, "全部收起")
      : null,
    h("button", {
      className: "rt-btn" + (grouped ? " rt-btn-primary" : ""),
      title: grouped ? "当前：按目标聚合（先看哪台被打下什么）" : "当前：平铺每条漏洞",
      onClick: () => props.onToggleGrouped(),
    }, grouped ? "按目标聚合" : "平铺列表"),
  );

  const messageNode = props.message !== null
    ? h("div", { className: props.message.kind === "err" ? "rt-err" : "rt-foot" }, props.message.text)
    : null;

  const restartNode = restartHint ? h("div", { className: "rt-empty" }, RESTART_HINT) : null;
  const errorNode = error !== null && !restartHint ? h("div", { className: "rt-err" }, error) : null;

  const body = props.subTab === "files"
    ? h("div", { className: "rt-body", style: { overflow: "auto" } },
        h("div", { className: "rt-hint", style: { marginBottom: 8 } },
          attackFilesHint(indexed.orphans.length)),
        props.attackFilesNode ?? null,
      )
    : props.subTab === "creds"
      ? h("div", { className: "rt-body", style: { overflow: "auto" } }, credentialsSection(runtime, props))
      : props.subTab === "access"
        ? h("div", { className: "rt-body", style: { overflow: "auto" } }, accessSection(runtime, props))
        : vulnsBody(runtime, props, grouped, items, loading, error, indexed.byVuln);

  return h("div", { className: "rt-main" },
    toolbar,
    conclusion,
    subTabs,
    messageNode,
    restartNode,
    errorNode,
    body,
  );
}

/** 漏洞子页签的正文。 */
function vulnsBody(
  runtime: ConsoleRuntime,
  props: FindingsTabProps,
  grouped: boolean,
  items: readonly VulnItem[],
  loading: boolean,
  error: string | null,
  filesByVuln: ReadonlyMap<number, readonly AttackFileRow[]>,
): ReactNode {
  const { h } = runtime;
  const head = h("div", { className: "rt-vrow head" },
    h("span", null, "等级"),
    h("span", null, "漏洞 / 编号"),
    h("span", null, "目标"),
    h("span", null, "拿到什么"),
    h("span", null, "状态"),
    h("span", null, "置信"),
  );

  if (grouped) {
    const groups = groupByTarget(items);
    const emptyNode = groups.length === 0 && !loading && error === null
      ? h("div", { className: "rt-empty" }, EMPTY_FINDINGS_MESSAGE)
      : null;
    return h("div", { className: "rt-table" },
      groups.map((group) => groupNode(runtime, props, group, filesByVuln)),
      emptyNode,
    );
  }

  const rows: ReactNode[] = [];
  for (const vuln of items) {
    rows.push(...vulnRowNodes(runtime, props, vuln, false, filesByVuln));
  }
  const emptyNode = !loading && items.length === 0 && error === null
    ? h("div", { className: "rt-empty" }, EMPTY_FINDINGS_MESSAGE)
    : null;
  return h("div", { className: "rt-table" }, head, rows, emptyNode);
}

/** 空统计（`findings` 未加载时结论行仍要渲染出一排 0，不能整块消失）。 */
const EMPTY_STATS = Object.freeze({
  bySeverity: Object.freeze({}),
  byStatus: Object.freeze({}),
  withGained: 0,
  targetGroups: 0,
});

/** 取一条漏洞的聚合键（供「全部展开」把键列全）。 */
function targetKeyOfVuln(vuln: VulnItem): string {
  // 复用模型层的判定：分组键必须与 `groupByTarget` 完全一致，
  // 否则「全部展开」会把另一批键设成展开、当前组仍然是折的。
  return targetKeyOf({ target: vuln.target, asset_ip: vuln.assetIp });
}

/** 查询漏洞（过滤条件走服务端，与原实现一致）。 */
export async function loadFindings(
  api: ApiClient,
  engagement: string,
  filter: FindingsFilter,
): Promise<ApiResponse> {
  return api.raw({
    op: "vulns",
    engagement,
    ...(filter.severity !== "" ? { severity: filter.severity } : {}),
    ...(filter.status !== "" ? { status: filter.status } : {}),
    ...(filter.queryApplied !== "" ? { q: filter.queryApplied } : {}),
    limit: 200,
  });
}

/** 读凭据 / 访问会话 / 攻击文件（三个独立请求，任一失败只影响自己）。 */
export async function loadSideLists(
  api: ApiClient,
  engagement: string,
): Promise<{
  readonly credentials: readonly CredentialRow[];
  readonly accesses: readonly AccessRow[];
  readonly fileGroups: readonly AttackFileGroup[];
}> {
  const [credResponse, accessResponse, filesResponse] = await Promise.all([
    api.raw({ op: "credentials", engagement }),
    api.raw({ op: "access", engagement }),
    api.raw({ op: "attackFiles", engagement }),
  ]);
  // 三个都走模型层的窄化函数：失败 → 空数组（与原实现的 `(r && r.items) || []` 一致）。
  return {
    credentials: credentialsOf(credResponse),
    accesses: accessesOf(accessResponse),
    fileGroups: attackFileGroupsOf(filesResponse),
  };
}

/** 更新一条漏洞的状态。 */
export async function updateVulnStatus(
  api: ApiClient,
  engagement: string,
  id: number,
  status: VulnStatus,
): Promise<{ readonly message: FindingsMessage; readonly ok: boolean }> {
  const response = await api.raw({ op: "updateVuln", engagement, id, patch: { status } });
  if (response.ok === false) {
    return { message: { kind: "err", text: response.error ?? "更新失败" }, ok: false };
  }
  return { message: { kind: "ok", text: statusUpdatedMessage(status) }, ok: true };
}

/** 严重级下拉的当前值（供容器初始化时校验）。 */
export function isSeverity(value: string): value is Severity {
  return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info";
}

/** 一条证据是否可复制（空请求 + 空响应就没意义）。 */
export function evidenceCopyable(entry: HttpEvidence): boolean {
  return entry.request !== "" || entry.response !== "";
}

/** 漏洞是否缺证据（红线：报告只收录有证据的）。 */
export function vulnLacksEvidence(vuln: VulnItem): boolean {
  return evidenceMissing(vuln);
}
