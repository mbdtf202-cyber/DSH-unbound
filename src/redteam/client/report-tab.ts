/**
 * 得分复现报告页（`report` 页签）的渲染。
 *
 * 数据与分组逻辑全在 `report-model.ts`，这里只排版。
 *
 * ## 版面（一条得分 = 一张卡）
 *
 * ```
 * 工具栏：合计 / 项数 / 带请求数 / 可复现数 / 同服务已拿满 | 复制全文 下载 重新生成
 * 阶段分组（可折叠，默认全开）
 *   └ 条目卡
 *       · 序号 + 得分点 + 得分 + 次数
 *       · 目标 / 拿到 / 利用漏洞 / 结果 / 取得时间
 *       · 证据截图
 *       · 复现步骤（details，缺材料时默认展开）
 *           动作 → 执行命令（可复制）→ 结果 → 证据
 *           凭据（来源可追溯）/ 隧道 / WebShell
 *       · 复现请求（可粘贴进 Yakit）
 * ```
 *
 * ## 两个原实现的细节，这里保留
 *
 * 1. **`<details>` 的 `open` 是「缺材料时默认展开」**：材料齐全时收起来
 *    （报告很长），缺材料时必须摊开让人看见缺口 —— 藏起来的缺口等于没有。
 * 2. **阶段折叠状态默认全开**：`isSectionOpen(state, key, true)`。
 *    默认折叠会让用户以为报告是空的。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import { formatTimestamp } from "./helpers.js";
import { isSectionOpen, toggleSection, type CollapseState } from "./state.js";
import {
  COPY_FAILED_MESSAGE,
  EMPTY_REPORT_HINT,
  EMPTY_REPORT_TITLE,
  LOADING_REPORT_MESSAGE,
  MISSING_REQUESTS_MESSAGE,
  MISSING_STEPS_MESSAGE,
  MISSING_TOOL_MESSAGE,
  REPORT_FOOTER,
  canCopyOrDownload,
  circledOf,
  copyCommandLabel,
  copyRequestsLabel,
  copiedMessage,
  credentialLine,
  groupByStage,
  itemEvidenceLine,
  itemNthLabel,
  itemPointsLabel,
  itemRecordedLine,
  itemSeqLabel,
  itemTarget,
  itemVulnLine,
  needsStageGrouping,
  requestBody,
  requestLabel,
  reportDataOf,
  requestTitle,
  requestsText,
  responsePreview,
  stageCollapseKey,
  stageCountLabel,
  stageRefsFromChain,
  stageCumulativeLabel,
  stageKeys,
  stageOrdinalStyle,
  stagePointsLabel,
  stagePointsStyle,
  stepAgentLabel,
  stepIndexLabel,
  stepResultLine,
  stepTitleLabel,
  stepToolLine,
  summaryCappedLabel,
  summaryCappedTitle,
  summaryCompleteLabel,
  summaryCompleteWarn,
  summaryCountLabel,
  summaryPointsLabel,
  summaryRequestsLabel,
  summaryRequestsLive,
  tunnelHeading,
  tunnelLine,
  webshellHeading,
  webshellLine,
  withStages,
  type ReportData,
  type ReportItem,
  type ReportRequest,
  type ReportStage,
  type ReportStep,
  type ReportSummary,
} from "./report-model.js";

/** 报告消息。 */
export interface ReportMessage {
  readonly kind: "ok" | "err";
  readonly text: string;
}

/** 报告的 props。 */
export interface ReportTabProps {
  /** 报告数据（`null` = 还没读回来）。 */
  readonly data: ReportData | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 表单消息（复制/下载的结果）。 */
  readonly message: ReportMessage | null;
  readonly busy: boolean;
  /** 阶段折叠状态。 */
  readonly collapse: CollapseState;
  /** 证据截图条（由容器渲染 —— 它需要异步取字节）。 */
  readonly renderShots?: (item: ReportItem) => ReactNode;
  readonly onRefresh: () => void;
  readonly onCopy: (text: string, label: string) => void;
  readonly onDownload: (text: string, label: string) => void;
  readonly onCollapseChange: (state: CollapseState) => void;
  readonly onSetAllCollapsed: (keys: readonly string[], open: boolean) => void;
}

/** 一条攻击步骤。 */
function stepNode(runtime: ConsoleRuntime, props: ReportTabProps, step: ReportStep, index: number): ReactNode {
  const { h } = runtime;
  const tool = stepToolLine(step);
  const agentLabel = stepAgentLabel(step);
  return h("div", { key: "s" + step.id, className: "rt-rep-step" },
    h("div", { className: "rt-rep-step-head" },
      h("span", { className: "rt-rep-step-no" }, stepIndexLabel(index)),
      h("span", { className: "rt-rep-step-title" }, stepTitleLabel(step)),
      agentLabel !== null ? h("span", { className: "rt-tag" }, agentLabel) : null,
      step.stageCode !== "" ? h("span", { className: "rt-tag" }, step.stageCode) : null,
      step.inferred ? h("span", { className: "rt-tag" }, "按同资产推断") : null,
      h("div", { className: "rt-spacer" }),
      step.recordedAt !== ""
        ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } },
            formatTimestamp(step.recordedAt))
        : null,
    ),
    step.detail !== "" ? h("div", { className: "rt-rep-step-detail" }, step.detail) : null,
    h("div", { className: "rt-rep-step-cmd" },
      h("b", null, "执行 "),
      tool !== null
        ? h("span", { className: "rt-mono" }, tool)
        : h("span", { style: { color: "var(--dsw-alias-state-warn-primary, #f59e0b)" } }, MISSING_TOOL_MESSAGE),
    ),
    tool !== null
      ? h("div", { style: { marginTop: 3 } },
          h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onCopy(tool, copyCommandLabel(index)),
          }, "复制命令"),
        )
      : null,
    step.result !== ""
      ? h("div", { className: "rt-rep-step-result" }, h("b", null, "结果 "), stepResultLine(step))
      : null,
    step.evidenceRef !== ""
      ? h("div", { className: "rt-rep-step-result" },
          h("b", null, "证据 "),
          h("span", { className: "rt-mono" }, step.evidenceRef))
      : null,
  );
}

/** 复现步骤块（`<details>`）。 */
function traceNode(runtime: ConsoleRuntime, props: ReportTabProps, item: ReportItem): ReactNode {
  const { h } = runtime;
  // 缺材料时必须默认摊开：藏起来的缺口等于没有。
  const open = item.incomplete || item.steps.length === 0;
  return h("details", { className: "rt-rep-trace", open },
    h("summary", { className: "rt-rep-trace-head", style: { cursor: "pointer" } },
      h("span", { className: "rt-rep-trace-title" }, "复现步骤（点击展开）"),
      item.steps.length > 0 ? h("span", { className: "rt-tag" }, item.steps.length + " 个动作") : null,
      item.credentials.length > 0 ? h("span", { className: "rt-tag" }, item.credentials.length + " 条凭据") : null,
      item.tunnels.length > 0 ? h("span", { className: "rt-tag" }, item.tunnels.length + " 条隧道") : null,
      item.incomplete
        ? h("span", { className: "rt-tag rt-tag-warn" }, "复现材料待补")
        : h("span", { className: "rt-tag rt-tag-live" }, "可复现"),
    ),
    h("div", { style: { paddingTop: 6 } },
      item.how !== "" ? h("div", { className: "rt-rep-trace-how" }, item.how) : null,
      item.steps.length === 0
        ? h("div", { className: "rt-rep-missing" }, MISSING_STEPS_MESSAGE)
        : item.steps.map((step, index) => stepNode(runtime, props, step, index)),
      item.credentials.length > 0
        ? h("div", { className: "rt-rep-src" },
            h("div", { className: "rt-rep-src-title" }, "拿到的凭据（来源可追溯）"),
            item.credentials.map((cred) =>
              h("div", { key: "c" + cred.id, className: "rt-kv" },
                h("b", { className: "rt-mono", style: { minWidth: 120 } },
                  cred.host !== "" ? cred.host : "—"),
                h("span", null, credentialLine(cred)),
              )))
        : null,
      item.tunnels.length > 0
        ? h("div", { className: "rt-rep-src" },
            h("div", { className: "rt-rep-src-title" }, "用到的隧道 / 通道"),
            item.tunnels.map((tunnel) =>
              h("div", { key: "t" + tunnel.id, className: "rt-kv" },
                h("b", { className: "rt-mono", style: { minWidth: 120 } }, tunnelHeading(tunnel)),
                h("span", null, tunnelLine(tunnel)),
              )))
        : null,
      item.webshells.length > 0
        ? h("div", { className: "rt-rep-src" },
            h("div", { className: "rt-rep-src-title" }, "用到的 WebShell"),
            item.webshells.map((shell) =>
              h("div", { key: "w" + shell.id, className: "rt-kv" },
                h("b", { className: "rt-mono", style: { minWidth: 120 } }, webshellHeading(shell)),
                h("span", null, webshellLine(shell)),
              )))
        : null,
      item.gaps.length > 0
        ? h("div", { className: "rt-rep-missing" }, "⚠️ 复现缺口：" + item.gaps.join("；"))
        : null,
    ),
  );
}

/** 一条复现请求。 */
function requestNode(
  runtime: ConsoleRuntime,
  props: ReportTabProps,
  request: ReportRequest,
  index: number,
): ReactNode {
  const { h } = runtime;
  const preview = responsePreview(request);
  return h("div", { key: "q" + index, className: "rt-rep-req" },
    h("div", { className: "rt-rep-req-head" },
      h("span", null, requestTitle(index, request)),
      h("span", { className: "rt-tag" }, requestLabel(request)),
      h("div", { className: "rt-spacer" }),
      h("button", {
        className: "rt-btn",
        style: { padding: "0 6px", fontSize: 11 },
        onClick: () => props.onCopy(request.request, "请求 " + (index + 1)),
      }, "复制到 Yakit"),
    ),
    h("pre", { className: "rt-rep-http" }, requestBody(request)),
    preview !== null
      ? h("div", null,
          h("div", { className: "rt-rep-req-head" }, h("span", null, "响应摘要")),
          h("pre", { className: "rt-rep-http", style: { maxHeight: 160 } }, preview))
      : null,
  );
}

/** 一张条目卡。 */
function cardNode(runtime: ConsoleRuntime, props: ReportTabProps, item: ReportItem): ReactNode {
  const { h } = runtime;
  const nth = itemNthLabel(item);
  const vuln = itemVulnLine(item);
  return h("div", { key: "r" + item.id, className: "rt-rep" },
    h("div", { className: "rt-rep-head" },
      h("span", { className: "rt-rep-idx" }, itemSeqLabel(item)),
      h("span", { className: "rt-rep-name" }, item.pointName),
      h("span", { className: "rt-flow-pts" }, itemPointsLabel(item)),
      nth !== null ? h("span", { className: "rt-tag" }, nth) : null,
      h("div", { className: "rt-spacer" }),
      h("button", {
        className: "rt-btn",
        style: { padding: "0 6px", fontSize: 11 },
        onClick: () => props.onCopy(requestsText(item), copyRequestsLabel(item)),
      }, "复制请求"),
    ),
    h("div", { className: "rt-rep-meta" },
      h("span", null, h("b", null, "目标 ")),
      h("span", { className: "rt-mono" }, itemTarget(item)),
    ),
    item.gained !== ""
      ? h("div", { className: "rt-rep-meta" }, h("b", null, "拿到 "), h("span", null, item.gained))
      : null,
    vuln !== null
      ? h("div", { className: "rt-rep-meta" }, h("b", null, "利用漏洞 "), h("span", null, vuln))
      : null,
    item.evidence !== ""
      ? h("div", { className: "rt-rep-meta" }, h("b", null, "结果 "), h("span", null, itemEvidenceLine(item)))
      : null,
    item.recordedAt !== ""
      ? h("div", { className: "rt-rep-meta" },
          h("b", null, "取得时间 "),
          h("span", null, itemRecordedLine(item)))
      : null,
    props.renderShots !== undefined ? props.renderShots(item) : null,
    traceNode(runtime, props, item),
    item.requests.length === 0
      ? h("div", { className: "rt-rep-missing" }, MISSING_REQUESTS_MESSAGE)
      : item.requests.map((request, index) => requestNode(runtime, props, request, index)),
    item.note !== ""
      ? h("div", { className: "rt-rep-meta" }, h("b", null, "备注 "), h("span", null, item.note))
      : null,
  );
}

/** 一个阶段分组。 */
function stageNode(runtime: ConsoleRuntime, props: ReportTabProps, stage: ReportStage): ReactNode {
  const { h } = runtime;
  const key = stageCollapseKey(stage.code);
  const open = isSectionOpen(props.collapse, key, true);
  const toggle = (): void => {
    props.onCollapseChange(toggleSection(props.collapse, key, true));
  };
  return h("div", { key: "g" + stage.code, className: "rt-rep-group" },
    h("div", {
      className: "rt-rep-stage",
      role: "button",
      tabIndex: 0,
      style: { borderLeftColor: stage.color },
      "aria-expanded": open ? "true" : "false",
      onClick: toggle,
      onKeyDown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          toggle();
        }
      },
    },
      h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
      h("span", { className: "rt-rep-no", style: stageOrdinalStyle(stage.color) }, circledOf(stage.ordinal)),
      h("span", { className: "rt-rep-stage-name" }, stage.name),
      h("span", { className: "rt-rep-stage-n" }, stageCountLabel(stage)),
      h("div", { className: "rt-spacer" }),
      h("span", { className: "rt-rep-pts", style: stagePointsStyle(stage.color) }, stagePointsLabel(stage)),
      h("span", { className: "rt-ap-cum" }, stageCumulativeLabel(stage)),
    ),
    open ? h("div", { className: "rt-rep-body" },
      stage.items.map((item) => cardNode(runtime, props, item))) : null,
  );
}

/**
 * 渲染报告页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderReportTab(runtime: ConsoleRuntime, props: ReportTabProps): ReactNode {
  const { h } = runtime;
  const data = props.data;
  const stages = data?.stages ?? [];
  const summary = data?.summary ?? null;
  const markdown = data?.markdown ?? "";
  const busy = props.busy;

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "攻击得分链路复现报告"),
    summary !== null ? h("span", { className: "rt-tag rt-tag-live" }, summaryPointsLabel(summary)) : null,
    summary !== null ? h("span", { className: "rt-tag" }, summaryCountLabel(summary)) : null,
    summary !== null
      ? h("span", {
          className: "rt-tag" + (summaryRequestsLive(summary) ? " rt-tag-live" : ""),
        }, summaryRequestsLabel(summary))
      : null,
    summary !== null
      ? h("span", {
          className: "rt-tag" + (summaryCompleteWarn(summary) ? " rt-tag-warn" : " rt-tag-live"),
          title: "复现链是否完整：有攻击步骤、写了实际命令、关联了漏洞/凭据/隧道",
        }, summaryCompleteLabel(summary))
      : null,
    summary !== null && summaryCappedLabel(summary) !== null
      ? h("span", {
          className: "rt-tag rt-tag-warn",
          title: summaryCappedTitle(summary),
        }, summaryCappedLabel(summary))
      : null,
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: "rt-btn",
      disabled: !canCopyOrDownload(busy, markdown),
      onClick: () => props.onCopy(markdown, "整份报告"),
    }, "复制全文"),
    h("button", {
      className: "rt-btn",
      disabled: !canCopyOrDownload(busy, markdown),
      onClick: () => props.onDownload(markdown, data?.target ?? ""),
    }, "下载 .md"),
    h("button", {
      className: "rt-btn",
      disabled: busy,
      onClick: () => props.onRefresh(),
    }, busy ? "生成中…" : "重新生成"),
  );

  const messageNode = props.message !== null
    ? h("div", { className: props.message.kind === "err" ? "rt-err" : "rt-foot" }, props.message.text)
    : null;
  const errorNode = props.error !== null ? h("div", { className: "rt-err" }, props.error) : null;

  const body = stages.length > 0
    ? h("div", { className: "rt-rep-list" },
        h("div", { className: "rt-rep-tools" },
          h("button", {
            className: "rt-btn",
            onClick: () => props.onSetAllCollapsed(stageKeys(stages), true),
          }, "全部展开"),
          h("button", {
            className: "rt-btn",
            onClick: () => props.onSetAllCollapsed(stageKeys(stages), false),
          }, "全部折叠"),
        ),
        stages.map((stage) => stageNode(runtime, props, stage)))
    : (data === null
      ? h("div", { className: "rt-empty" }, LOADING_REPORT_MESSAGE)
      : h("div", { className: "rt-empty" },
          h("div", null, EMPTY_REPORT_TITLE),
          h("div", { style: { marginTop: 6, fontSize: 12 } }, EMPTY_REPORT_HINT)));

  return h("div", { className: "rt-main" },
    toolbar,
    messageNode,
    errorNode,
    h("div", { className: "rt-body", style: { overflow: "auto" } }, body),
    h("div", { className: "rt-foot" }, h("span", null, REPORT_FOOTER)),
  );
}

/** 读报告。 */
export async function loadReport(api: ApiClient, engagement: string): Promise<ApiResponse> {
  return api.raw({ op: "scoreReport", engagement });
}

/** 读攻击链（补分组用）。 */
export async function loadChainForGrouping(api: ApiClient, engagement: string): Promise<ApiResponse> {
  return api.raw({ op: "scoreChain", engagement });
}

/** 报告的错误文案。 */
export function reportErrorOf(response: ApiResponse): string | null {
  if (response.ok === false) return response.error ?? "生成失败";
  return null;
}

/**
 * 二次请求的结果应用：给平铺条目补阶段分组。
 *
 * 原实现在 `scoreReport` 之后判断 `needsStageGrouping`，成立时再发一次
 * `scoreChain`；**第二次请求失败时退回原始数据**（不报错）——
 * 报告仍然可读，只是没分组。这里把两步收成一个函数，行为一致。
 */
export async function loadReportWithGrouping(
  api: ApiClient,
  engagement: string,
): Promise<{ readonly data: ReportData | null; readonly error: string | null }> {
  const response = await loadReport(api, engagement);
  const error = reportErrorOf(response);
  if (error !== null) return { data: null, error };
  const data = reportDataOf(response);
  if (data === null) return { data: null, error: "生成失败" };
  if (!needsStageGrouping(data)) return { data, error: null };
  // 二次请求失败时退回原始数据（不报错）：报告仍可读，只是没分组。
  const chain = await loadChainForGrouping(api, engagement);
  return { data: withStages(data, groupByStage(data.items, stageRefsFromChain(chain))), error: null };
}

/** 复制结果的提示文案（成功 / 失败统一一处）。 */
export function copyFeedback(ok: boolean, label: string): ReportMessage {
  return ok
    ? { kind: "ok", text: copiedMessage(label) }
    : { kind: "err", text: COPY_FAILED_MESSAGE };
}

