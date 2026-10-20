/**
 * 演练台样式层：上游样式表（原样保真）+ 战术主题叠加层。
 *
 * ## 为什么这个文件是「两块」而不是「一块改好的样式表」
 *
 * 上游 `dsh-qilin/client.js` 里有一整套演练台样式表（539 行 / 422 条规则），
 * 它是这个控制台**唯一**的视觉定义 —— 布局、密度、状态色、表格列宽全在里面。
 * TypeScript 重写时逻辑迁过来了、样式没迁，所以有一段时间控制台是「有结构、
 * 无外观」的。
 *
 * 补的时候有两条路：
 *
 * 1. 边迁边改：直接把新视觉写进那 422 条规则里。
 * 2. 原样保真 + 叠加：`CSS` 一个字节不动，`THEME` 单独一层覆盖。
 *
 * 选 2。理由：
 * - 上游样式表是**对照测试的依据** —— 把它改了，「行为等价」就无从验证。
 *   以后做 drift 检测也要靠它逐字比对。
 * - 新视觉是**演进的**，会反复调。叠加层改动只需 diff `THEME`，
 *   不会把上游 422 条规则搅成一片红绿。
 * - 层叠顺序天然正确：`CSS` 先注入、`THEME` 后注入，后者赢。
 *
 * ## 为什么可以安全内联进 `String.raw`
 *
 * 已校验 `CSS` 的内容：**0 个反引号、0 个 `\${`、0 个反斜杠**。
 * 三者任一出现都会让模板字符串截断或转义走样，所以这不是「运气好」，
 * 是提取时确认过的前提（见 `test/ui/styles.test.ts` 里对应的断言）。
 */

/** 宿主 `--dsw-alias-*` 令牌白名单（`CSS` 段用到的 9 个）。 */
export const UPSTREAM_TOKENS: readonly string[] = Object.freeze([
  "--dsw-alias-label-secondary",
  "--dsw-alias-border-l1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-label-primary",
  "--dsw-alias-bg-base",
  "--dsw-alias-border-l2",
  "--dsw-alias-state-error-primary",
]);

/**
 * `THEME` 允许引用的宿主令牌全集。
 *
 * 只列**宿主里真实存在**的令牌：拼错一个不存在的名字，`var()` 会静默失败
 * （回落成非法值或空），样式悄悄不生效，比报错难查得多。
 */
export const THEME_TOKENS: readonly string[] = Object.freeze([
  // 上游已在用的 9 个
  ...UPSTREAM_TOKENS,
  // THEME 额外用到的（均已核对存在于 dsh-client-ui-theme）
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-layer-4",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-border-l3",
  "--dsw-alias-border-l4",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-static-blue-500",
  "--dsw-static-neutral-bluish-1000",
  "--dsw-static-neutral-bluish-50",
]);

/**
 * 上游演练台样式表 —— **逐字节保真，不要格式化、不要"顺手改好"**。
 *
 * 来源：`dsh-qilin/client.js` 中 `const CSS = \`…\`` 的整块内容，
 * 起于 `.rt-dock{…}`，止于 `.rt-shot-zoom-cap{…}`。
 */
export const CSS = String.raw`
.rt-dock{position:fixed;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1c) 52%,transparent);
  backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 70%,transparent);
  border-radius:12px;
  box-shadow:0 18px 48px color-mix(in srgb,#000 28%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:transparent!important;backdrop-filter:none;-webkit-backdrop-filter:none}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c)}
/* 未读红点：该页签有新内容（新资产/新漏洞/新得分/新步骤…），点开看过就消失 */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, #ef4444 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,#1c1c1c);color:var(--dsw-alias-label-primary,#f2f2f2)}
.rt-eng-select{color:var(--dsw-alias-label-primary,#f2f2f2);background:var(--dsw-alias-bg-layer-2,#2a2a2a)}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag-warn{color:#ef4444;border-color:#ef444455;background:#ef44441a}
/* 纪律提示条：不满足交付要求（非冰蝎/哥斯拉马、没有 suo5 隧道）时顶在区块最上方 */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px;line-height:1.6;
  border:1px dashed #ef444488;background:#ef44440f;color:var(--dsw-alias-label-primary)}
.rt-hint b{color:#ef4444}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* 图谱视图已移除（见 AssetsTab：资产关系由「域名维度」与 redteam_attack_path 工具承担） */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 75%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#2a2a2a) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-test-tested{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-test-blocked{color:#fff;background:#ef4444;border-color:#ef4444}
.rt-test-abandoned{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
.rt-test-no_surface{color:#6366f1;border-color:#6366f155;background:#6366f11a}
.rt-scope-testing{color:#5b21b6;background:#ddd6fe}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:#fff;background:#ef4444}
.rt-pri-medium{color:#fff;background:#f59e0b}
.rt-pri-low{color:#fff;background:#94a3b8}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 得分目标按合并版的 8 个类别分组：类别头 + 组内按分值升序 */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 会话与入口：每张卡片分「标题行 / 关键事实 / 可用命令 / 备注」四段，避免一行糊在一起 ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:11.5px}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:#fff;background:#64748b;margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:#6366f1}
.rt-stage-vuln{background:#f59e0b}
.rt-stage-exploit{background:#ef4444}
.rt-stage-access{background:#10b981}
.rt-stage-pivot{background:#8b5cf6}
.rt-stage-data{background:#0ea5e9}
.rt-stage-other{background:#64748b}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:#fff;font-weight:600}
.rt-st-recon{background:#6366f1}.rt-st-vuln{background:#f59e0b}.rt-st-exploit{background:#ef4444}
.rt-st-access{background:#10b981}.rt-st-pivot{background:#8b5cf6}.rt-st-data{background:#0ea5e9}.rt-st-other{background:#64748b}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:#fff;background:#b91c1c}.rt-sev-high{color:#fff;background:#ef4444}
.rt-sev-medium{color:#7c2d12;background:#fdba74}.rt-sev-low{color:#1e3a8a;background:#bfdbfe}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #10b98133}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444433}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #94a3b833}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:#10b981;font-weight:600}
.rt-hl-res{color:#0ea5e9;font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:#065f46;background:#a7f3d0;border:1px solid #10b98155}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:#0e7490;background:#a5f3fc}
.rt-scope-external{color:#9a3412;background:#fed7aa}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:#10b981;color:#fff;font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b;border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:#fef3c7;color:#78350f;
  border:1px solid #f59e0b66;border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:#10b981}
.rt-counted{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:#94a3b8;animation:none}
@keyframes rt-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98166}50%{opacity:.5;box-shadow:0 0 0 5px #10b98100}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:#94a3b8;opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── 折叠层次体系 ─────────────────────────────────────────────────────────────
   L1 折叠头 .rt-sec   ：通栏、无圆角无边框、左色条、深底 —— 永远是"扁"的
   L2 内容卡 .rt-atest/.rt-hit/.rt-cred/.rt-evi：内缩、有边框、圆角 —— 立起来
   L3 详情/长文本 .rt-clip-body / .rt-evi-body ：无边框、最浅、等宽
   L4 子项容器 .rt-sec-body：左缩进 + 竖引导线，表明"属于上面那个头"
   ──────────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:13px;white-space:nowrap}
.rt-sec-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:#8b5cf6}
.rt-sec.t-target{border-left-color:#0ea5e9}
.rt-sec.t-folder{border-left-color:#64748b}
.rt-sec.t-test{border-left-color:#10b981}
.rt-sec.t-queue{border-left-color:#f59e0b}
.rt-sec.t-past{border-left-color:#94a3b8}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* 长文本折叠（L3）：默认预览 2 行并渐隐，展开后限高滚动 */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent);mask-image:linear-gradient(180deg,#000 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:11px;flex:none}
.rt-flow-action{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:#10b981;color:#fff;font-size:11px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:#94a3b8}
.rt-flow-name{font-weight:600;font-size:13px}
.rt-flow-pts{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:700;color:#065f46;
  background:#a7f3d0;border:1px solid #10b98155;border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:13px;flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid #10b981;border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:#94a3b8;opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:11.5px}
.rt-hflow-n{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:15px;color:#10b981;font-weight:700;flex:none}
.rt-rep-name{font-weight:600;font-size:13px}
.rt-rep-meta{font-size:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:11.5px;font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── 报告里的「这一步怎么来的」：动作步骤 / 命令 / 凭据 / 隧道 ───────────── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:12.5px}
.rt-rep-trace-how{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:#fff;
  font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:12.5px}
.rt-rep-step-detail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:11.5px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:11.5px;margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:12px;margin-bottom:3px}
/* ── 全链路攻击路径图 ─────────────────────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid #64748b;border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:700;font-size:13.5px}
.rt-ap-en{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.3px}
.rt-ap-phase{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:12px;
  border-left:4px solid #64748b;background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:10.5px;font-weight:700;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border:1px solid #10b98155;border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* 按服务封顶/自建而不计分的命中：分值标灰（+0），避免看着像又加了分 */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:12.5px}
.rt-ap-hit-target{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 横向路径图 */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:12px;flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid #64748b;border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:11px;color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:1.45;
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b}
.rt-hcol-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* 资产与内容都自适应换行：长域名/长口令/长结果一律换行显示，不截断成省略号 */
.rt-hit-asset{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* 自己注册/自建的账号：留痕但不计分，整行压暗 */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid #ef444488}
/* 同一资产同一端口的重复账号/库权限：服务已拿满，不计分（只作留痕） */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid #f59e0b88}
.rt-hit-row.service-capped .rt-hit-idx{background:#f59e0b}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid #64748b;border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:700;font-size:13px}
.rt-rep-stage-n{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 折叠后仍要能一眼看到"这一阶段拿了多少分"，所以分数留在头上 */
.rt-rep-pts{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── 知识库（POC/EXP） ──────────────────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库归类总览：一行标签，点一下按该类筛选 */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库分组标题（按归类分组时每组一条） */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:12.5px}
/* 技能可用性徽章（技能库页签） */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-avail-broken{color:#ef4444;border-color:#ef444455;background:#ef44441a}
.rt-avail-unknown{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
/* 版本 / 更新弹窗 */
.rt-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.7;
  box-shadow:0 18px 48px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.rt-kb-kind{font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;
  color:#fff;background:#64748b;flex:none}
.rt-kb-kind.k-exp{background:#ef4444}
.rt-kb-kind.k-poc{background:#f59e0b}
.rt-kb-kind.k-template{background:#8b5cf6}
.rt-kb-kind.k-script{background:#0ea5e9}
.rt-kb-kind.k-payload{background:#10b981}
.rt-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* 本机 nuclei 模板命中：路径要能完整看到（复制成命令直接跑） */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:#0b1020;
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:10.5px;overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.5)}
.rt-shot-zoom-cap{color:#e5e7eb;font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}`;

/**
 * 战术主题叠加层。
 *
 * ## 设计方向
 *
 * 「贴官方令牌 + 战术仪表盘感」。宿主的主色在两个主题下都是**近中性**的
 * （浅色 `--dsw-alias-brand-primary` = `#0f1115`，深色 = `#f9fafb`），
 * 没有彩色主色可用 —— 所以「作战台」的感觉不能靠大色块，只能靠四件事：
 *
 * 1. **密度**：行高 29px、表头 25px，比默认更紧，一屏多装三分之一。
 * 2. **等宽数字**：端口 / 分值 / 计数 / 时间戳全部 `tabular-nums`，
 *    列与列之间数字对齐，扫读时眼睛不用重新找位置。
 * 3. **语义状态色**：五档严重度 + 六档测试状态，颜色只承担「轻重」，
 *    不承担装饰。
 * 4. **1px 细线分隔**：用 `--dsw-alias-border-l1` 切块，不用阴影堆叠。
 *
 * ## ⚠ 一个必须遵守的层叠陷阱（实测踩过）
 *
 * CSS 自定义属性的 `var()` 在**声明处**就完成替换，值再沿树继承。
 *
 * 宿主把深色主题加在 **`body`** 上（`body[data-ds-dark-theme]`），
 * 而 `:root` 是 **`html`**。所以：
 *
 * ```css
 * :root { --dsw-alias-state-error-primary: #ec1313;
 *         --dsu-sev-critical-fg: var(--dsw-alias-state-error-primary); }  // → #ec1313 被冻结
 * [data-ds-dark-theme] { --dsw-alias-state-error-primary: #f87171; }       // body 上覆盖了
 * ```
 *
 * 结果 `body` 上 alias 确实是 `#f87171`，但 `--dsu-sev-critical-fg` 仍是
 * **`#ec1313`**（在 html 上算好并继承下来的），所有消费它的规则在深色下
 * 用浅色值 —— 静默错色，肉眼在深色背景上看着像"红色偏暗"，很难归因。
 *
 * 实测证据（Playwright 取 computed style）：
 * ```
 * dark: body 上 --dsw-alias-state-error-primary = #f87171
 *       :root 上 --dsu-sev-critical-fg           = #ec1313   ← 没跟着变
 *       .rt-sev-critical 渲染色                   = rgb(236,19,19)
 * ```
 *
 * **因此**：任何 `var(--dsw-alias-*)` 派生的 `--dsu-*`，都必须在深色块里
 * **重声明一遍**。`test/ui/styles.test.ts` 用集合断言锁住这件事
 * （派生变量集 ⊆ 深色块重声明集），以后谁漏写就红。
 *
 * 不依赖主题的派生变量（spacing / radius / 字体栈）只在 `:root` 声明一次即可。
 */
export const THEME = String.raw`/* ═══════════════════════════════════════════════════════════════════════
   设计变量阶梯 —— 不依赖主题，只在 :root 声明一次
   理由：spacing / radius / 字体栈 / 行高在明暗下是同一套值，
   放进深色块重声明只会增加噪音（且它们不引用 --dsw-alias-*，不会被冻结）。
   ═══════════════════════════════════════════════════════════════════════ */
:root{
  /* 依赖主题的值也要在 :root 给一份，供**非 body 继承链**（如 portal 到 body
     之外的元素、测试环境直接挂 documentElement）使用。 */
  --dsu-space-1:4px;--dsu-space-2:6px;--dsu-space-3:8px;
  --dsu-space-4:12px;--dsu-space-5:16px;--dsu-space-6:24px;
  --dsu-radius-xs:4px;--dsu-radius-sm:6px;--dsu-radius-md:8px;--dsu-radius-lg:12px;
  --dsu-font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  --dsu-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --dsu-fs-micro:10.5px;--dsu-fs-tiny:11px;--dsu-fs-small:11.5px;
  --dsu-fs-body:12.5px;--dsu-fs-lead:13px;
  --dsu-row-h:29px;--dsu-row-h-head:25px;
  --dsu-line:1px solid var(--dsw-alias-border-l1);

  /* 五档严重度（浅色） */
  --dsu-sev-critical-fg:var(--dsw-alias-state-error-primary);
  --dsu-sev-critical-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent);
  --dsu-sev-critical-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);
  --dsu-sev-high-fg:var(--dsw-alias-state-warn-primary);
  --dsu-sev-high-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent);
  --dsu-sev-high-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 36%,transparent);
  --dsu-sev-medium-fg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 76%,var(--dsw-alias-label-primary));
  --dsu-sev-medium-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);
  --dsu-sev-medium-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 28%,transparent);
  --dsu-sev-low-fg:color-mix(in srgb,var(--dsw-alias-label-primary) 62%,var(--dsw-alias-state-warn-primary));
  --dsu-sev-low-bg:color-mix(in srgb,var(--dsu-sev-low-fg) 10%,transparent);
  --dsu-sev-low-border:color-mix(in srgb,var(--dsu-sev-low-fg) 28%,transparent);
  --dsu-sev-info-fg:var(--dsw-alias-label-tertiary);
  --dsu-sev-info-bg:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);
  --dsu-sev-info-border:var(--dsw-alias-border-l2);
}

/* ═══════════════════════════════════════════════════════════════════════
   深色：**所有引用 --dsw-alias-* 的派生变量都要在这里重声明**
   不重声明就会被 :root 上的浅色值冻结（详见文件头注释的实测证据）。
   ═══════════════════════════════════════════════════════════════════════ */
[data-ds-dark-theme],
body[data-ds-dark-theme]{
  --dsu-sev-critical-fg:var(--dsw-alias-state-error-primary);
  --dsu-sev-critical-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent);
  --dsu-sev-critical-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);
  --dsu-sev-high-fg:var(--dsw-alias-state-warn-primary);
  --dsu-sev-high-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent);
  --dsu-sev-high-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 36%,transparent);
  --dsu-sev-medium-fg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 88%,var(--dsw-alias-label-primary));
  --dsu-sev-medium-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);
  --dsu-sev-medium-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);
  --dsu-sev-low-fg:color-mix(in srgb,var(--dsw-alias-label-primary) 62%,var(--dsw-alias-state-warn-primary));
  --dsu-sev-low-bg:color-mix(in srgb,var(--dsu-sev-low-fg) 14%,transparent);
  --dsu-sev-low-border:color-mix(in srgb,var(--dsu-sev-low-fg) 32%,transparent);
  --dsu-sev-info-fg:var(--dsw-alias-label-tertiary);
  --dsu-sev-info-bg:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);
  --dsu-sev-info-border:var(--dsw-alias-border-l2);
  --dsu-line:1px solid var(--dsw-alias-border-l1);
}

/* ═══════════════════════════════════════════════════════════════════════
   密度与等宽数字 —— 战术感的两个主要来源
   ═══════════════════════════════════════════════════════════════════════ */

/* 数字列一律等宽对齐：端口、分值、计数、时间戳、IP */
.rt-mono,.rt-ip,.rt-tag,.rt-sev,.rt-score-pts,.rt-score-big,.rt-score-of,
.rt-score-scope,.rt-score-group .rt-sg-sub,.rt-avail,.rt-step-time,
.rt-step-dot,.rt-foot,.rt-sess-fact,.rt-kv b{
  font-variant-numeric:tabular-nums;
}
.rt-tag,.rt-sev,.rt-avail{font-feature-settings:"tnum" 1}

/* 行高与表头高度收紧：一屏多装三分之一的信息 */
.rt-row{min-height:var(--dsu-row-h);align-items:center;transition:background .1s}
.rt-row.head{
  min-height:var(--dsu-row-h-head);
  text-transform:uppercase;letter-spacing:.045em;
  color:var(--dsw-alias-label-tertiary);
  border-bottom:1px solid var(--dsw-alias-border-l2);
}
.rt-vrow,.rt-score-row{min-height:27px;align-items:center}
.rt-toolbar{padding:7px 10px}
.rt-foot{
  padding:6px 12px;font-family:var(--dsu-font-mono);font-size:var(--dsu-fs-tiny);
}

/* 选中态：细左轨 + 极淡底，避免整行变色的噪声 */
.rt-row:hover,.rt-vrow:hover,.rt-score-row:hover,.rt-item:hover,.rt-seg:hover{
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);
}
.rt-row.on,.rt-item.on,.rt-seg.on{
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent);
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);
}

/* 页签：下划线用品牌色，未读红点描一圈，深色下也立得住 */
.rt-tab{font-size:var(--dsu-fs-small);transition:color .12s,border-color .12s}
.rt-tab.on{
  font-weight:620;border-bottom-color:var(--dsw-alias-brand-primary);
}
.rt-tab-dot{
  box-shadow:0 0 0 2px color-mix(in srgb,var(--dsu-sev-critical-fg) 24%,transparent);
}

/* 按钮：hover 用叠加而非换色，两个主题下都稳 */
.rt-btn{
  border-radius:var(--dsu-radius-sm);
  transition:background .12s,border-color .12s;
}
.rt-btn:hover{
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-layer-2));
  border-color:var(--dsw-alias-border-l3);
}
.rt-btn-primary{color:var(--dsw-alias-bg-base);font-weight:560}
.rt-btn-primary:hover{opacity:.88}

/* ═══════════════════════════════════════════════════════════════════════
   语义状态色 —— 颜色只承担「轻重」，不承担装饰
   ═══════════════════════════════════════════════════════════════════════ */
.rt-sev{display:inline-flex;align-items:center;justify-content:center;
  min-width:34px;height:17px;padding:0 5px;border-radius:var(--dsu-radius-xs);
  font-size:var(--dsu-fs-micro);font-weight:620;
  border:1px solid transparent;white-space:nowrap}
.rt-sev-critical{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-sev-high{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-sev-medium{color:var(--dsu-sev-medium-fg);background:var(--dsu-sev-medium-bg);border-color:var(--dsu-sev-medium-border)}
.rt-sev-low{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
.rt-sev-info{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}

/* 测试状态：靠前置小圆点区分，不靠整块填色 */
.rt-test{display:inline-flex;align-items:center;gap:4px;height:17px;padding:0 5px;
  border-radius:var(--dsu-radius-xs);font-size:var(--dsu-fs-micro);white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.rt-test::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.rt-test-testing{color:var(--dsu-sev-high-fg);border-color:var(--dsu-sev-high-border);background:var(--dsu-sev-high-bg)}
.rt-test-testing::before{animation:rt-dsu-pulse 1.6s ease-in-out infinite}
.rt-test-tested{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.rt-test-blocked{color:var(--dsw-alias-bg-base);background:var(--dsu-sev-critical-fg);border-color:var(--dsu-sev-critical-fg)}
.rt-test-no_surface{color:var(--dsu-sev-low-fg);border-color:var(--dsu-sev-low-border);background:var(--dsu-sev-low-bg)}
@keyframes rt-dsu-pulse{0%,100%{opacity:1}50%{opacity:.35}}
/* 尊重系统「减少动态效果」 */
@media (prefers-reduced-motion:reduce){
  .rt-test-testing::before{animation:none}
  .rt-row,.rt-vrow,.rt-score-row,.rt-btn,.rt-item,.rt-seg,.rt-tab{transition:none}
}

/* 来源标签沿用上游配色，但底色从令牌派生，深色下不过曝 */
.rt-tag{height:17px;border-radius:var(--dsu-radius-xs);font-size:var(--dsu-fs-micro)}
.rt-tag-passive{color:var(--dsu-sev-low-fg);border-color:var(--dsu-sev-low-border);background:var(--dsu-sev-low-bg)}
.rt-tag-active{color:var(--dsu-sev-high-fg);border-color:var(--dsu-sev-high-border);background:var(--dsu-sev-high-bg)}
.rt-tag-live{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 34%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.rt-tag-warn{color:var(--dsu-sev-critical-fg);border-color:var(--dsu-sev-critical-border);background:var(--dsu-sev-critical-bg)}

/* 易打性 / 可用性 / 内外网：同族语义，复用五档 */
.rt-pri{display:inline-flex;align-items:center;justify-content:center;
  min-width:30px;height:17px;padding:0 5px;border-radius:var(--dsu-radius-xs);
  font-size:var(--dsu-fs-micro);font-weight:620;border:1px solid transparent}
.rt-pri-high{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-pri-medium{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-pri-low{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}

.rt-avail{display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 4px;
  border-radius:var(--dsu-radius-xs);font-size:var(--dsu-fs-micro);font-weight:560;
  border:1px solid transparent;white-space:nowrap}
.rt-avail-available{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.rt-avail-broken{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-avail-unknown{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsw-alias-border-l2)}

/* ═══════════════════════════════════════════════════════════════════════
   得分目标：大号数字 + 进度条 + 命中整行淡绿
   ═══════════════════════════════════════════════════════════════════════ */
.rt-score-big{font-size:25px;font-weight:620;line-height:1;letter-spacing:-.03em;
  font-family:var(--dsu-font-mono)}
.rt-score-cap{font-size:var(--dsu-fs-micro);letter-spacing:.07em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary);margin-bottom:3px}
.rt-meter{flex:1;min-width:80px;height:5px;border-radius:3px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);overflow:hidden}
.rt-meter>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}
.rt-score-group{font-size:var(--dsu-fs-tiny);font-weight:630;letter-spacing:.025em;
  color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}
.rt-score-row.hit{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent)}
.rt-score-row.hit .rt-score-pts{color:var(--dsw-alias-state-success-primary)}
.rt-score-ck{width:13px;height:13px;border-radius:3px;
  border:1.5px solid var(--dsw-alias-border-l3);
  display:flex;align-items:center;justify-content:center;
  font-size:9px;line-height:1;color:transparent}
.rt-score-row.hit .rt-score-ck{background:var(--dsw-alias-state-success-primary);
  border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}
.rt-score-pts{font-family:var(--dsu-font-mono);font-size:var(--dsu-fs-tiny)}
.rt-score-scope{font-family:var(--dsu-font-mono);font-size:9.5px;color:var(--dsw-alias-label-tertiary)}

/* ═══════════════════════════════════════════════════════════════════════
   攻击链：阶段色只染小圆点，不染整行
   ═══════════════════════════════════════════════════════════════════════ */
.rt-step{margin-left:8px;padding-left:12px;border-left:1.5px solid var(--dsw-alias-border-l2);position:relative}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{position:absolute;left:-8px;top:7px;width:15px;height:15px;
  border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:8.5px;font-weight:700;font-family:var(--dsu-font-mono);
  color:var(--dsw-alias-bg-base);
  box-shadow:0 0 0 2.5px var(--dsw-alias-bg-base)}
.rt-step-title{font-size:var(--dsu-fs-body);font-weight:620;letter-spacing:-.006em}
.rt-step-time{font-family:var(--dsu-font-mono);font-size:var(--dsu-fs-micro)}
.rt-step-detail{font-family:var(--dsu-font-mono);font-size:var(--dsu-fs-micro);line-height:1.65;
  color:var(--dsw-alias-label-tertiary);
  border-left:2px solid var(--dsw-alias-border-l2);padding:5px 0 5px 9px}

/* ═══════════════════════════════════════════════════════════════════════
   焦点可见性：键盘 Tab 一定看得见，鼠标点击不抢戏
   上游有几处用了 outline:none —— 这里补回 :focus-visible
   ═══════════════════════════════════════════════════════════════════════ */
.rt-dock :focus-visible,.rt-full :focus-visible,.rt-embedded :focus-visible,
.dshp-dock-body :focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px;
}

/* 提示条 / 错误：语义化，别再用写死的 #ef4444 */
.rt-hint{border:1px dashed var(--dsu-sev-critical-border);background:var(--dsu-sev-critical-bg)}
.rt-hint b{color:var(--dsu-sev-critical-fg)}
.rt-err{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);
  border:1px solid var(--dsu-sev-critical-border);border-radius:var(--dsu-radius-sm);
  padding:6px 10px}
`;

/** 注入用的最小 `document` 面（见 `dom.ts` 的 `MinimalDocument`）。 */
export interface StylesDocument {
  readonly head: {
    append(node: unknown): void;
    appendChild(node: unknown): unknown;
  };
  createElement(tag: "style"): {
    textContent: string | null;
    setAttribute(name: string, value: string): void;
    remove?(): void;
  };
  querySelector?(selector: string): unknown;
}

/** 默认注入标记属性名。 */
export const STYLE_ATTR = "data-dsh-unbound-drill";

/** `installStyles` 的选项。 */
export interface InstallStylesOptions {
  /** 去重用的属性名（默认 `data-dsh-unbound-drill`）。 */
  readonly attr?: string | undefined;
  /** 去重用的属性值（默认 `"1"`）。 */
  readonly value?: string | undefined;
}

/**
 * 把 `CSS` + `THEME` 注入 `<head>`，返回清理函数。
 *
 * ## 为什么合成一个 `<style>` 而不是两个
 *
 * 两者的层叠顺序是**语义上的依赖**（THEME 必须赢 CSS），写进同一个
 * `<style>` 里，顺序由字符串拼接位置保证，不依赖「两次 append 的先后」
 * —— 后者在样式重算上是成立的，但如果将来有人在中间插了别的注入，
 * 顺序就会变得脆弱。合成一个节点后，去重也只需一次查询。
 *
 * ## 幂等
 *
 * 已有同 attr+value 的节点时**复用**，不重复插入：宿主的 hot reload 会
 * 反复调 `apply()`，每轮插一个 `<style>` 会让样式表无限增长。
 * 复用而不是提前返回，是因为复用能顺手刷新内容（改完 THEME 立刻生效）。
 */
export function installStyles(
  doc: StylesDocument,
  options: InstallStylesOptions = {},
): () => void {
  const attr = options.attr ?? STYLE_ATTR;
  const value = options.value ?? "1";
  const payload = CSS + "\n\n" + THEME;

  const selector = "style[" + attr + '="' + value + '"]';
  const existing = doc.querySelector?.(selector) as
    | { textContent: string | null; remove?(): void }
    | null
    | undefined;

  if (existing !== null && existing !== undefined) {
    existing.textContent = payload;
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      existing.remove?.();
    };
  }

  const node = doc.createElement("style");
  node.setAttribute(attr, value);
  node.textContent = payload;
  doc.head.append(node);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    node.remove?.();
  };
}
