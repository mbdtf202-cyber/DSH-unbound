/**
 * 攻击链页（`chain` 页签）的渲染。
 *
 * 数据与判定全在 `chain-model.ts`，这里只排版。
 *
 * ## 两个视图
 *
 * - **A（竖向）**：五个阶段自上而下，每段给「阶段目标 → 本阶段命中 / 资产 /
 *   隧道 → 累计分」，段间用 `▼` 连接并重复累计分。
 * - **B（横向）**：一屏五列，只留数字与列表项，`▶` 连接。
 *
 * 两个视图共用同一份 `stages` —— 切换只改渲染形态，不重新取数。
 *
 * ## 一个原实现的取舍，这里保留
 *
 * 攻击链**只讲「打到哪了、拿了多少分」**，不展示打法要点与工具清单。
 * 原注释写得很清楚：那些是执行细节，混在链路里会淹没得分与资产信息。
 */

import type { ConsoleRuntime } from "./runtime.js";
import type { ReactNode } from "./dom.js";
import type { ApiClient, ApiResponse } from "./api.js";
import {
  CHAIN_FLOW_LABEL,
  COMPACT_LIMIT,
  COMPACT_TUNNEL_LIMIT,
  EMPTY_CHAIN_MESSAGE,
  SELF_ONLY_WARNING,
  assetHitsLabel,
  assetPointsLabel,
  assetPortsLabel,
  assetPriorityLabel,
  assetScopeClass,
  assetScopeLabel,
  assetVulnsLabel,
  chainDataOf,
  compactAssetCountLabel,
  compactAssetScope,
  compactHitsLabel,
  compactReconHit,
  compactTunnelHit,
  cumulativeLabel,
  hitActionLabel,
  hitPointsLabel,
  hitRecordedLine,
  hitTarget,
  hitTimesLine,
  hitVulnLine,
  isBoundaryStage,
  isReconStage,
  moreHitsLabel,
  nthLabel,
  reconAssetsLabel,
  stageAssetsLabel,
  stageEmptyMessage,
  stageHeadStyle,
  stageHitsLabel,
  stageNumber,
  stageNumberCompact,
  stageNumberCompactStyle,
  stageNumberStyle,
  stagePointsStyle,
  showsSelfOnlyWarning,
  totalLabel,
  tunnelStatusClass,
  tunnelStatusLabel,
  tunnelStatusStyle,
  tunnelsLabel,
  viewButtonClass,
  viewButtonLabel,
  viewButtonTitle,
  viewRootClass,
  type ChainAsset,
  type ChainData,
  type ChainHit,
  type ChainStage,
  type ChainTunnel,
  type ChainView,
} from "./chain-model.js";

/** 攻击链页的 props。 */
export interface ChainTabProps {
  /** 读取结果（`null` = 还没读回来）。 */
  readonly data: ChainData | null;
  /** 读取错误。 */
  readonly error: string | null;
  /** 是否在请求中。 */
  readonly loading: boolean;
  readonly view: ChainView;
  /** 当前展开的命中 id。 */
  readonly openId: number | null;
  readonly onViewChange: (view: ChainView) => void;
  readonly onToggleHit: (id: number) => void;
  readonly onRefresh: () => void;
}

/** 单次得分的详情。 */
function hitDetail(runtime: ConsoleRuntime, hit: ChainHit): ReactNode {
  const { h } = runtime;
  const vulnLine = hitVulnLine(hit);
  return h("div", { className: "rt-flow-detail" },
    h("div", { className: "rt-kv" },
      h("b", null, "目标"),
      h("span", { className: "rt-mono", style: { wordBreak: "break-all" } },
        hit.target !== "" ? hit.target : "—"),
    ),
    hit.assetIp !== ""
      ? h("div", { className: "rt-kv" }, h("b", null, "资产"), h("span", { className: "rt-mono" }, hit.assetIp))
      : null,
    hit.vulnTitle !== ""
      ? h("div", { className: "rt-kv" }, h("b", null, "利用漏洞"), h("span", null, vulnLine))
      : null,
    h("div", { className: "rt-kv" }, h("b", null, "次数"), h("span", null, hitTimesLine(hit))),
    h("div", { className: "rt-kv" }, h("b", null, "记录"), h("span", null, hitRecordedLine(hit))),
    hit.evidence !== ""
      ? h("div", { className: "rt-kv" },
          h("b", null, "结果与证据"),
          h("span", null, hit.evidence))
      : null,
  );
}

/** 一条得分命中。 */
function hitRow(runtime: ConsoleRuntime, props: ChainTabProps, hit: ChainHit): ReactNode {
  const { h } = runtime;
  const open = props.openId === hit.id;
  const nth = nthLabel(hit);
  return h("div", {
    key: "h" + hit.id,
    className: "rt-ap-hit" + (open ? " open" : ""),
    role: "button",
    tabIndex: 0,
    onClick: () => props.onToggleHit(hit.id),
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        props.onToggleHit(hit.id);
      }
    },
  },
    h("div", { className: "rt-ap-hit-head" },
      h("span", {
        className: "rt-ap-pts" + (hit.counted ? "" : " uncounted"),
        title: hit.cappedReason !== "" ? hit.cappedReason : undefined,
      }, hitPointsLabel(hit)),
      h("span", { className: "rt-ap-hit-name" }, hit.pointName),
      hit.capped
        ? h("span", {
            className: "rt-tag rt-tag-warn",
            title: hit.cappedReason !== "" ? hit.cappedReason : "同一资产同一端口只算分值最高的一条",
          }, "服务已拿满 · 不计分")
        : null,
      nth !== null ? h("span", { className: "rt-ap-nth" }, nth) : null,
      h("span", { className: "rt-ap-hit-target" }, hitTarget(hit)),
    ),
    hit.hasAction
      ? h("div", { className: "rt-ap-act" + (hit.actionInferred ? " inferred" : "") }, hitActionLabel(hit))
      : null,
    open ? hitDetail(runtime, hit) : null,
  );
}

/** 一行资产。 */
function assetRow(runtime: ConsoleRuntime, asset: ChainAsset): ReactNode {
  const { h } = runtime;
  const priority = assetPriorityLabel(asset);
  const vulns = assetVulnsLabel(asset);
  return h("div", { key: "a" + asset.id, className: "rt-ap-asset" },
    h("span", { className: assetScopeClass(asset) }, assetScopeLabel(asset)),
    h("span", { className: "rt-mono", style: { fontWeight: 600 } }, asset.ip),
    asset.segmentCidr !== "" ? h("span", { className: "rt-ap-nth" }, asset.segmentCidr) : null,
    h("span", { className: "rt-ap-nth" }, assetPortsLabel(asset)),
    vulns !== null ? h("span", { className: "rt-ap-nth" }, vulns) : null,
    priority !== null ? h("span", { className: "rt-tag" }, priority) : null,
    h("div", { className: "rt-spacer" }),
    h("span", { className: "rt-ap-pts" }, assetPointsLabel(asset)),
    h("span", { className: "rt-ap-nth" }, assetHitsLabel(asset)),
  );
}

/** 一条隧道。 */
function tunnelRow(runtime: ConsoleRuntime, tunnel: ChainTunnel): ReactNode {
  const { h } = runtime;
  return h("div", { key: "t" + tunnel.id, className: "rt-ap-tunnel" },
    h("span", { className: "rt-tag rt-tag-passive" }, tunnel.kind !== "" ? tunnel.kind : "tunnel"),
    h("span", { className: "rt-mono", style: { fontWeight: 600 } },
      tunnel.listen !== "" ? tunnel.listen : "—"),
    h("span", {
      className: tunnelStatusClass(tunnel),
      style: tunnelStatusStyle(tunnel) ?? {},
    }, tunnelStatusLabel(tunnel)),
    h("span", {
      className: "rt-ap-nth",
      style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
    }, "可达 " + (tunnel.reach !== "" ? tunnel.reach : "—")),
  );
}

/** 竖向视图的一个阶段。 */
function stageVertical(
  runtime: ConsoleRuntime,
  props: ChainTabProps,
  stage: ChainStage,
  index: number,
  total: number,
): ReactNode {
  const { h } = runtime;
  const body: ReactNode[] = [];
  if (isReconStage(stage)) {
    body.push(h("div", { key: "at", className: "rt-ap-sub" }, reconAssetsLabel(stage)));
    body.push(h("div", { key: "al", className: "rt-ap-assets" },
      stage.assets.length > 0
        ? stage.assets.map((asset) => assetRow(runtime, asset))
        : h("div", { className: "rt-ap-none" }, stageEmptyMessage(stage))));
  } else {
    body.push(h("div", { key: "ht", className: "rt-ap-sub" }, stageHitsLabel(stage)));
    body.push(h("div", { key: "hl", className: "rt-ap-hits" },
      stage.items.length > 0
        ? stage.items.map((hit) => hitRow(runtime, props, hit))
        : h("div", { className: "rt-ap-none" }, stageEmptyMessage(stage))));
    if (isBoundaryStage(stage)) {
      body.push(h("div", { key: "tt", className: "rt-ap-sub" }, tunnelsLabel(stage)));
      if (showsSelfOnlyWarning(stage)) {
        body.push(h("div", { key: "tw", className: "rt-ap-none" }, SELF_ONLY_WARNING));
      }
      body.push(h("div", { key: "tl", className: "rt-ap-tunnels" },
        stage.tunnels.length > 0
          ? stage.tunnels.map((tunnel) => tunnelRow(runtime, tunnel))
          : h("div", { className: "rt-ap-none" }, "还没有建立隧道（建好后用 redteam_tunnel_add 登记）")));
    }
    if (stage.assets.length > 0 && !isBoundaryStage(stage)) {
      body.push(h("div", { key: "at", className: "rt-ap-sub" }, stageAssetsLabel(stage)));
      body.push(h("div", { key: "al", className: "rt-ap-assets" },
        stage.assets.map((asset) => assetRow(runtime, asset))));
    }
  }

  const accent = { borderLeftColor: stage.color };
  return h("div", { key: "st" + stage.code, className: "rt-ap-stage" },
    h("div", { className: "rt-ap-head", style: stageHeadStyle(stage.color) },
      h("span", { className: "rt-ap-no", style: stageNumberStyle(stage.color) }, stageNumber(index)),
      h("span", { className: "rt-ap-name" }, stage.name),
      stage.subtitle !== "" ? h("span", { className: "rt-ap-en" }, stage.subtitle) : null,
      h("div", { className: "rt-spacer" }),
      stage.points > 0
        ? h("span", { className: "rt-ap-pts", style: stagePointsStyle(stage.color) },
            "+" + stage.points)
        : null,
      h("span", { className: "rt-ap-cum" }, cumulativeLabel(stage)),
    ),
    h("div", { className: "rt-ap-goal", style: accent },
      h("span", {
        className: "rt-ap-goal-tag",
        style: { color: stage.color, borderColor: stage.color + "66" },
      }, "阶段目标"),
      h("span", null, stage.goal),
    ),
    h("div", { className: "rt-ap-result", style: accent }, body),
    index < total - 1
      ? h("div", { className: "rt-ap-trans" },
          h("span", { className: "rt-flow-arrow" }, "▼"),
          stage.transition !== "" ? h("span", { className: "rt-ap-trans-t" }, stage.transition) : null,
          h("span", { className: "rt-ap-trans-t", style: { marginLeft: "auto" } }, cumulativeLabel(stage)),
        )
      : h("div", { className: "rt-ap-trans" },
          h("span", { className: "rt-flow-arrow" }, "▼"),
          h("span", { className: "rt-ap-trans-t" }, totalLabel(props.data?.summary ?? null)),
        ),
  );
}

/** 横向视图的正文。 */
function stageHorizontalBody(
  runtime: ConsoleRuntime,
  stage: ChainStage,
): ReactNode {
  const { h } = runtime;
  if (isBoundaryStage(stage)) {
    return h("div", null,
      h("div", { className: "rt-hcol-hit" },
        h("span", { className: "rt-hcol-pts" }, "+" + stage.points),
        h("span", { className: "rt-hcol-name" }, compactTunnelHit(stage))),
      stage.tunnels.slice(0, COMPACT_TUNNEL_LIMIT).map((tunnel) =>
        h("div", { key: "t" + tunnel.id, className: "rt-hcol-sub" },
          "▸ " + tunnel.kind + " " + tunnel.listen)),
    );
  }
  if (isReconStage(stage)) {
    return h("div", null,
      h("div", { className: "rt-hcol-hit" },
        h("span", { className: "rt-hcol-pts" }, String(stage.assetCount)),
        h("span", { className: "rt-hcol-name" }, compactReconHit(stage))),
      stage.assets.slice(0, COMPACT_LIMIT).map((asset) =>
        h("div", {
          key: "a" + asset.id,
          className: "rt-hcol-sub",
          title: asset.ip + "  +" + asset.points + " 分",
        }, compactAssetScope(asset) + asset.ip + "  +" + asset.points)),
    );
  }
  const more = moreHitsLabel(stage.items.length);
  const assetCount = compactAssetCountLabel(stage);
  return h("div", null,
    h("div", { className: "rt-hcol-hit" },
      h("span", { className: "rt-hcol-pts" }, "+" + stage.points),
      h("span", { className: "rt-hcol-name" }, compactHitsLabel(stage))),
    stage.items.slice(0, COMPACT_LIMIT).map((hit) =>
      h("div", {
        key: "c" + hit.id,
        className: "rt-hcol-sub",
        title: hit.pointName + "  " + hit.target,
      },
        h("span", { className: "rt-hcol-pts" }, "+" + hit.points),
        h("span", { className: "rt-hcol-name" }, hit.pointName))),
    more !== null ? h("div", { className: "rt-hcol-none" }, more) : null,
    assetCount !== null ? h("div", { className: "rt-hcol-none" }, assetCount) : null,
  );
}

/** 横向视图的一个阶段。 */
function stageCompact(runtime: ConsoleRuntime, stage: ChainStage, index: number): ReactNode {
  const { h } = runtime;
  return h("div", { key: "c" + stage.code, className: "rt-ap-col" },
    index > 0 ? h("span", { className: "rt-ap-col-arrow" }, "▶") : null,
    h("div", { className: "rt-hcol", style: { borderTopColor: stage.color } },
      h("div", {
        className: "rt-ap-head",
        style: { borderLeftColor: stage.color, padding: "5px 8px" },
      },
        h("span", { className: "rt-ap-no", style: stageNumberCompactStyle(stage.color) },
          stageNumberCompact(index)),
        h("span", { className: "rt-ap-name", style: { fontSize: 12 } }, stage.name),
        h("div", { className: "rt-spacer" }),
        h("span", { className: "rt-ap-cum", style: { fontWeight: 700 } }, String(stage.cumulative)),
      ),
      h("div", { className: "rt-hcol-goal", title: stage.goal }, stage.goal),
      h("div", { className: "rt-hcol-body" }, stageHorizontalBody(runtime, stage)),
    ),
  );
}

/**
 * 渲染攻击链页。
 *
 * 无 hook、不读全局，只按 props 拼元素树。
 */
export function renderChainTab(runtime: ConsoleRuntime, props: ChainTabProps): ReactNode {
  const { h } = runtime;
  const data = props.data;
  const stages = data?.stages ?? [];
  const summary = data?.summary ?? null;

  const toolbar = h("div", { className: "rt-toolbar" },
    h("span", { style: { fontWeight: 600 } }, "攻击链"),
    h("span", { className: "rt-tag", style: { fontSize: 10.5 } }, CHAIN_FLOW_LABEL),
    summary !== null ? h("span", { className: "rt-tag rt-tag-live" }, "总分 " + summary.points + " 分") : null,
    h("div", { className: "rt-spacer" }),
    h("button", {
      className: viewButtonClass("A", props.view),
      title: viewButtonTitle("A"),
      onClick: () => props.onViewChange("A"),
    }, viewButtonLabel("A")),
    h("button", {
      className: viewButtonClass("B", props.view),
      title: viewButtonTitle("B"),
      onClick: () => props.onViewChange("B"),
    }, viewButtonLabel("B")),
    h("button", {
      className: "rt-btn",
      disabled: props.loading,
      onClick: () => props.onRefresh(),
    }, props.loading ? "加载中…" : "刷新"),
  );

  const errorNode = props.error !== null
    ? h("div", { className: "rt-err" }, props.error)
    : null;

  // 三种状态分开：还没读回来（data === null）/ 读到了但没有阶段 / 有阶段。
  // 合并会让首次加载闪一下「还没有得分记录」。
  const emptyNode = data !== null && stages.length === 0 && props.error === null
    ? h("div", { className: "rt-empty" }, EMPTY_CHAIN_MESSAGE)
    : null;

  const view = props.view === "A"
    ? h("div", { className: viewRootClass("A") },
        stages.map((stage, index) => stageVertical(runtime, props, stage, index, stages.length)))
    : h("div", { className: viewRootClass("B") },
        stages.map((stage, index) => stageCompact(runtime, stage, index)));

  return h("div", { className: "rt-main" },
    toolbar,
    errorNode,
    emptyNode,
    stages.length > 0 ? view : null,
  );
}

/** 读取攻击链。 */
export async function loadChain(api: ApiClient, engagement: string): Promise<ApiResponse> {
  return api.raw({ op: "scoreChain", engagement });
}

/** 从响应解析攻击链（失败 → `null`，错误由容器单独保存）。 */
export function chainOf(response: ApiResponse): ChainData | null {
  return chainDataOf(response);
}

/** 错误文案。 */
export function chainErrorOf(response: ApiResponse): string | null {
  if (response.ok === false) return response.error ?? "读取失败";
  return null;
}

/** 切换视图（无效值归一成 A）。 */
export function nextView(value: unknown): ChainView {
  return value === "B" ? "B" : "A";
}

/** 切换展开的命中（同一条再点收起）。 */
export function toggleHitOpen(current: number | null, id: number): number | null {
  return current === id ? null : id;
}
