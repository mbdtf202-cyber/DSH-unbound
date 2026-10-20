/**
 * 得分目标页（`scores` 页签）的渲染。
 *
 * 数据与保存语义全在 `score-model.ts`，这里只排版。
 *
 * ## 布局
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 得分目标  总分 320 分  42 个得分点  命中 9 次  [新增] [刷新]   │
 * ├──────────────────────────────────────────────────────────────┤
 * │ 一、获取权限 · 12 项 · 各项上限合计 300 分（各项独立…）  +120 分│
 * │ ▸ 10分 服务器主机权限        3 次命中  上限 50/50   +50 分    │
 * │ ▾ 10分 域名控制权限          1 次命中              +20 分    │
 * │     得分条件 / 状态 / 命中记录…                               │
 * └──────────────────────────────────────────────────────────────┘
 *
 * ## 一个真实的产品决策，这里保留
 *
 * 内置得分点（`builtin`）的名称/分类/分值/说明**全部 `readOnly`**，
 * 删除按钮**禁用**。原因写在 `BUILTIN_NOTICE_BODY` 里：同一条规则的上限
 * 按组内所有得分点累计，单独改分值会让一条命中吃掉整组上限。
 * 以前界面「能改、提示已保存、刷新后变回去」，用户以为是 bug。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { MinimalPointerEventLike } from "./h.js";
import { clickable, formatTimestamp } from "./helpers.js";
import {
  BUILTIN_DELETE_LABEL,
  BUILTIN_DELETE_TITLE,
  BUILTIN_NOTICE_BODY,
  BUILTIN_NOTICE_TITLE,
  EMPTY_POINTS_TEXT,
  EMPTY_SCORE_SUMMARY,
  NO_ENGAGEMENT_TEXT,
  NO_HIT_HINT,
  POINTS_HINT,
  SELF_CREATED_SUMMARY_TITLE,
  SELF_CREATED_TITLE,
  SERVICE_CAPPED_SUMMARY_TITLE,
  SERVICE_CAP_SUFFIX,
  SHOT_COUNT_TITLE,
  builtinRuleText,
  capText,
  cappedLabel,
  cappedTitle,
  countedText,
  countedTitle,
  detailRowKey,
  earnedText,
  groupKeyOf,
  groupSubtitle,
  hitAssetLabel,
  hitCopyText,
  hitEvidenceText,
  hitHasEvidence,
  hitRowKey,
  hitsSectionTitle,
  isAchieved,
  isFieldLocked,
  lockedTitle,
  pointNameText,
  pointsBadgeClass,
  pointsBadgeStyle,
  statusText,
  type ScoreBoard,
  type ScoreForm,
  type ScoreGroup,
  type ScoreHit,
  type ScorePoint,
} from "./score-model.js";

/** 得分页的 props。 */
export interface ScoreTabProps {
  readonly engagement: string | null;
  /** 看板（`null` = 还没加载）。 */
  readonly board: ScoreBoard | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 是否在请求中。 */
  readonly busy: boolean;
  /** 当前展开的得分点 id。 */
  readonly openId: number | null;
  /** 表单（`null` = 关闭）。 */
  readonly form: ScoreForm | null;
  /** 表单消息。 */
  readonly message: { readonly err?: string; readonly ok?: string } | null;
  readonly onRefresh: () => void;
  readonly onToggle: (id: number) => void;
  readonly onEdit: (point: ScorePoint) => void;
  readonly onNew: () => void;
  readonly onFormChange: (form: ScoreForm) => void;
  readonly onSave: () => void;
  readonly onRemove: () => void;
  readonly onCancel: () => void;
  readonly onCopy: (text: string) => void;
}

/** 从事件里读 input 的值。 */
function inputValue(event: MinimalPointerEventLike): string {
  const target = event.target as { value?: unknown } | null | undefined;
  return typeof target?.value === "string" ? target.value : "";
}

/** 从事件里读 checkbox 的勾选态。 */
function checkedOf(event: MinimalPointerEventLike): boolean {
  const target = event.target as { checked?: unknown } | null | undefined;
  return target?.checked === true;
}

/** 工具栏。 */
function toolbar(runtime: ConsoleRuntime, props: ScoreTabProps): ReactNode {
  const { h } = runtime;
  const summary = props.board?.summary ?? EMPTY_SCORE_SUMMARY;
  return h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "得分目标"),
    // 只显示已拿下的总分，不显示目标分数、不显示进度条。
    h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)", marginLeft: 4 } }, "总分"),
    h("span", { className: "rt-total" }, String(summary.achievedPoints)),
    h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, "分"),
    h("span", { className: "rt-tag" }, summary.pointCount + " 个得分点"),
    h("span", { className: "rt-tag" }, "命中 " + summary.countedHits + " 次"),
    summary.selfCreatedHits > 0
      ? h("span", { className: "rt-tag rt-tag-warn", title: SELF_CREATED_SUMMARY_TITLE },
          "自建不计分 " + summary.selfCreatedHits)
      : null,
    summary.serviceCappedHits > 0
      ? h("span", { className: "rt-tag rt-tag-warn", title: SERVICE_CAPPED_SUMMARY_TITLE },
          "服务已拿满不计分 " + summary.serviceCappedHits)
      : null,
    h("div", { className: "rt-spacer" }),
    h("button", { className: "rt-btn", onClick: () => props.onNew() }, "+ 新增得分点"),
    h("button", {
      className: "rt-btn",
      disabled: props.busy,
      onClick: () => props.onRefresh(),
    }, props.busy ? "刷新中…" : "刷新"),
  );
}

/** 表单面板。 */
function formPane(runtime: ConsoleRuntime, props: ScoreTabProps): ReactNode {
  const { h } = runtime;
  const form = props.form;
  if (form === null) return null;
  const locked = isFieldLocked(form);
  const ruleText = builtinRuleText(form);

  return h("div", {
    className: "rt-pane",
    style: { flex: "none", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  },
    // 内置项的说明：分值 / 上限 / 口径由《得分规则》锁定。
    form.builtin
      ? h("div", { className: "rt-hint", style: { marginBottom: 8 } },
          h("b", null, BUILTIN_NOTICE_TITLE),
          h("div", { style: { marginTop: 3 } }, BUILTIN_NOTICE_BODY),
          ruleText !== null
            ? h("div", { style: { marginTop: 3, color: "var(--dsw-alias-label-secondary)" } }, ruleText)
            : null,
        )
      : null,
    h("div", { className: "rt-score-form" },
      h("input", {
        className: "rt-input",
        placeholder: "名称（必填）",
        value: form.name,
        readOnly: locked,
        title: lockedTitle(form, "name"),
        onChange: (event) => props.onFormChange({ ...form, name: inputValue(event) }),
      }),
      h("input", {
        className: "rt-input",
        placeholder: "分类，如 账号权限",
        value: form.category,
        readOnly: locked,
        title: lockedTitle(form, "category"),
        onChange: (event) => props.onFormChange({ ...form, category: inputValue(event) }),
      }),
      h("input", {
        className: "rt-input",
        type: "number",
        placeholder: "单次分值",
        readOnly: locked,
        title: locked ? lockedTitle(form, "points") : POINTS_HINT,
        value: form.points,
        onChange: (event) => {
          const parsed = Number(inputValue(event));
          props.onFormChange({ ...form, points: Number.isFinite(parsed) ? parsed : 0 });
        },
      }),
      h("select", {
        className: "rt-input",
        value: form.enabled ? "1" : "0",
        onChange: (event) => props.onFormChange({ ...form, enabled: inputValue(event) === "1" }),
      },
        h("option", { value: "1" }, "启用"),
        h("option", { value: "0" }, "停用"),
      ),
    ),
    h("input", {
      className: "rt-input",
      style: { width: "100%", marginBottom: 6, boxSizing: "border-box" },
      placeholder: "得分条件说明",
      value: form.description,
      readOnly: locked,
      title: locked ? lockedTitle(form, "description") : "",
      onChange: (event) => props.onFormChange({ ...form, description: inputValue(event) }),
    }),
    h("div", { className: "rt-actions" },
      h("button", {
        className: "rt-btn rt-btn-primary",
        disabled: props.busy,
        onClick: () => props.onSave(),
      }, "保存"),
      form.id !== null
        ? (form.builtin
            ? h("button", {
                className: "rt-btn",
                disabled: true,
                title: BUILTIN_DELETE_TITLE,
              }, BUILTIN_DELETE_LABEL)
            : h("button", {
                className: "rt-btn",
                disabled: props.busy,
                onClick: () => props.onRemove(),
              }, "删除"))
        : null,
      h("button", { className: "rt-btn", onClick: () => props.onCancel() }, "取消"),
    ),
  );
}

/** 一条命中的行。 */
function hitRow(runtime: ConsoleRuntime, props: ScoreTabProps, hit: ScoreHit, index: number): ReactNode {
  const { h } = runtime;
  return h("div", {
    key: hitRowKey(hit),
    className: "rt-hit-row" + (hit.selfCreated ? " self-created" : "") + (hit.capped ? " service-capped" : ""),
  },
    h("span", { className: "rt-hit-idx" }, String(index + 1)),
    h("span", { className: "rt-hit-asset", title: hit.target !== "" ? hit.target : hit.assetIp },
      hitAssetLabel(hit)),
    hit.selfCreated
      ? h("span", { className: "rt-tag rt-tag-warn", title: SELF_CREATED_TITLE }, "自建 · 不计分")
      : null,
    hit.capped
      ? h("span", { className: "rt-tag rt-tag-warn", title: cappedTitle(hit) }, cappedLabel(hit))
      : null,
    hit.shotCount > 0
      ? h("span", { className: "rt-tag", title: SHOT_COUNT_TITLE }, "图 " + hit.shotCount)
      : null,
    h("span", { className: "rt-hit-time" }, formatTimestamp(hit.recordedAt)),
    h("button", {
      className: "rt-btn",
      style: { padding: "0 5px", fontSize: 10.5 },
      title: "复制这一条",
      onClick: (event) => {
        event.stopPropagation?.();
        props.onCopy(hitCopyText(hit));
      },
    }, "复制"),
    hitHasEvidence(hit)
      ? h("span", { className: "rt-hit-txt", title: hit.evidence }, hitEvidenceText(hit))
      : h("span", { className: "rt-hit-txt none" }, "未填账号密码/结果"),
  );
}

/** 展开后的得分点详情。 */
function pointDetail(runtime: ConsoleRuntime, props: ScoreTabProps, point: ScorePoint): ReactNode {
  const { h } = runtime;
  return h("div", {
    key: detailRowKey(point),
    className: "rt-score-row",
    style: { cursor: "default", gridTemplateColumns: "1fr" },
  },
    h("div", { className: "rt-score-detail" },
      point.description !== ""
        ? h("div", { className: "rt-kv" },
            h("b", null, "得分条件"),
            h("span", null, point.description))
        : null,
      h("div", { className: "rt-kv" },
        h("b", null, "状态"),
        h("span", null, statusText(point)),
      ),
      point.capped > 0
        ? h("div", { className: "rt-kv" },
            h("b", null, "服务封顶"),
            h("span", null, point.serviceSummary + SERVICE_CAP_SUFFIX))
        : null,
      point.hits.length > 0
        ? h("div", null,
            h("div", { className: "rt-section", style: { padding: "6px 0 0" } }, hitsSectionTitle(point)),
            h("div", { className: "rt-hits" },
              point.hits.map((hit, index) => hitRow(runtime, props, hit, index))),
          )
        : h("div", { className: "rt-kv" },
            h("b", null, "命中记录"),
            h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, NO_HIT_HINT)),
      h("div", { className: "rt-actions" },
        h("button", {
          className: "rt-btn",
          onClick: (event) => {
            event.stopPropagation?.();
            props.onEdit(point);
          },
        }, "编辑"),
      ),
    ),
  );
}

/** 一个得分点行（未展开时的行）。 */
function pointRow(runtime: ConsoleRuntime, props: ScoreTabProps, point: ScorePoint): ReactNode {
  const { h } = runtime;
  const open = props.openId === point.id;
  const achieved = isAchieved(point);
  const badgeStyle = pointsBadgeStyle(point);
  const cap = capText(point);
  return h("div", {
    key: "sp" + point.id,
    className: "rt-score-row",
    ...clickable(() => props.onToggle(point.id), {
      label: "展开得分点 " + point.name,
      expanded: open,
    }),
  },
    h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"),
    h("span", null,
      h("span", {
        className: pointsBadgeClass(point),
        ...(badgeStyle !== null ? { style: badgeStyle } : {}),
      }, point.points + "分")),
    h("span", { title: point.description },
      pointNameText(point)),
    h("span", { title: countedTitle(point) },
      h("span", { className: "rt-sec-count" }, countedText(point)),
      cap !== null ? h("span", { className: "rt-scope" }, cap) : null,
    ),
    h("span", { style: { textAlign: "right" } },
      achieved || point.earned > 0
        ? h("span", { className: "rt-tag rt-tag-active" }, earnedText(point))
        : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, "—"),
    ),
  );
}

/** 一组得分点（含组头）。 */
function groupBlock(
  runtime: ConsoleRuntime,
  props: ScoreTabProps,
  group: ScoreGroup,
  index: number,
): readonly ReactNode[] {
  const { h } = runtime;
  const out: ReactNode[] = [];
  if (group.name !== "") {
    out.push(h("div", { key: "g-" + groupKeyOf(group, index), className: "rt-score-group" },
      h("span", null, group.name),
      h("span", { className: "rt-sg-sub" }, groupSubtitle(group)),
      h("div", { className: "rt-spacer" }),
      group.points > 0
        ? h("span", { className: "rt-tag rt-tag-active" }, "+" + group.points + " 分")
        : null,
    ));
  }
  for (const point of group.tiers) {
    out.push(pointRow(runtime, props, point));
    if (props.openId === point.id) out.push(pointDetail(runtime, props, point));
  }
  return out;
}

/**
 * 渲染得分目标页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderScoreTab(runtime: ConsoleRuntime, props: ScoreTabProps): ReactNode {
  const { h } = runtime;

  if (props.engagement === null || props.engagement === "") {
    return h("div", { className: "rt-main" },
      h("div", { className: "rt-empty" }, NO_ENGAGEMENT_TEXT),
    );
  }

  const board = props.board;
  const items = board?.items ?? [];
  const groups = board?.groups ?? [];
  const rows: ReactNode[] = [];
  groups.forEach((group, index) => {
    rows.push(...groupBlock(runtime, props, group, index));
  });

  const message = props.message;
  const head = h("div", { className: "rt-score-row head" },
    h("span", null, ""),
    h("span", null, "分值"),
    h("span", null, "得分点（按分值从低到高）"),
    h("span", null, "命中 / 上限"),
    h("span", { style: { textAlign: "right" } }, "已得分"),
  );

  return h("div", { className: "rt-main" },
    toolbar(runtime, props),
    message !== null
      ? h("div", { className: message.err !== undefined ? "rt-err" : "rt-foot" },
          message.err ?? message.ok ?? "")
      : null,
    props.error !== null ? h("div", { className: "rt-err" }, props.error) : null,
    formPane(runtime, props),
    h("div", { className: "rt-table" },
      head,
      rows,
      items.length === 0 ? h("div", { className: "rt-empty" }, EMPTY_POINTS_TEXT) : null,
    ),
  );
}

/** 默认 props（供测试与未接线场景）。 */
export function defaultScoreProps(engagement: string | null): ScoreTabProps {
  return {
    engagement,
    board: null,
    error: null,
    busy: false,
    openId: null,
    form: null,
    message: null,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onNew: () => undefined,
    onFormChange: () => undefined,
    onSave: () => undefined,
    onRemove: () => undefined,
    onCancel: () => undefined,
    onCopy: () => undefined,
  };
}

/** 供外部断言用的内部助手导出（渲染层测试需要读启用态勾选）。 */
export { checkedOf };
