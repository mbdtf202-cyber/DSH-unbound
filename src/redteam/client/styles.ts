import type { MinimalStyleElement } from "./dom.js";

/**
 * 演练台样式层：上游样式表（逐字节保真）+ 战术主题叠加层。
 *
 * ## 这个文件为什么是「两块」而不是「一块改好的样式表」
 *
 * 上游 `dsh-qilin/client.js` 里有一整套演练台样式表（539 行 / 45,782 字节 /
 * 422 条规则），它是这个控制台**唯一**的视觉定义 —— 布局、密度、状态色、
 * 表格列宽全在里面。TypeScript 重写时逻辑迁过来了、样式没迁，所以有一段时间
 * 控制台是「有结构、无外观」的。
 *
 * 补的时候有两条路：
 *
 * 1. 边迁边改：直接把新视觉写进那 422 条规则里。
 * 2. 原样保真 + 叠加：`CSS` 一个字节不动，`THEME` 单独一层覆盖。
 *
 * 选 2。理由：
 *
 * - 上游样式表是**对照测试的依据** —— 把它改了，「行为等价」就无从验证。
 *   以后做 drift 检测（上游又改了样式、我们没跟上）也要靠它逐字比对。
 * - 新视觉是**演进的**，会反复调。叠加层改动只需 diff `THEME`，
 *   不会把上游 422 条规则搅成一片红绿，review 也就看得清。
 * - 层叠顺序天然正确：`CSS` 先注入、`THEME` 后注入，后者赢。
 *   叠加层因此**只叠加、不改写** —— 它不复制任何上游规则，只覆盖需要变的属性。
 *
 * ## 为什么可以安全内联进 `String.raw`
 *
 * 提取时就校验过 `CSS` 的内容：**0 个反引号、0 个 ${、0 个反斜杠**。
 * 三者任一出现都会让模板字符串截断或转义走样（TS 照样编译通过，只是样式
 * 少了半截 —— 这种 bug 肉眼极难发现）。所以这不是「运气好」，是前提，
 * 而且由 `test/ui/styles.test.ts` 逐条断言锁住：将来上游样式里混进反引号，
 * 测试会先红，而不是运行时静默少样式。
 *
 * `THEME` 由我们手写，同样遵守这三条，于是两个常量可以分别内联，
 * 不需要任何转义。
 */

/** 上游 `CSS` 段实际引用到的宿主令牌（9 个，按出现频次排列）。 */
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
 * `THEME` 允许引用的宿主令牌全集 = 上游那 9 个 + 官方确实存在的扩展档。
 *
 * 为什么要有白名单：`var(--dsw-xxx)` 拼错**不会报错**，只会静默失效
 * （整条声明被丢弃）。这类错误在浏览器里表现为「某个样式没生效」，
 * 归因成本极高。所以把允许的名字写成常量，测试用集合断言把不在名单里的
 * 名字打出来 —— 拼错当场红。
 *
 * 名单逐条核对过宿主 `dsh-client-ui-theme`：`alias-bg-layer-3/4`、
 * `alias-bg-overlay`、`alias-label-tertiary`、`alias-border-l3/l4`、
 * `alias-state-warn/success-primary`、`radius-sm/md/lg`、`elevation-soft`、
 * 以及 `--dsw-static-*` 色阶（本文件只用到 amber-400/600、blue-300/500）。
 */
export const THEME_TOKENS: readonly string[] = Object.freeze([
  // 上游已在用的 9 个
  ...UPSTREAM_TOKENS,
  // 层级 / 描边 / 文本：深色下靠底色阶与细线分层，不堆阴影
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-layer-4",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-border-l3",
  "--dsw-alias-border-l4",
  // 语义状态：严重度的 fg 全部从这里派生，不自己发明红色
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-success-primary",
  // 圆角与浮层阴影：宿主已按主题算好，直接跟随
  "--dsw-radius-sm",
  "--dsw-radius-md",
  "--dsw-radius-lg",
  "--dsw-elevation-soft",
  // 静态色阶：只用于「muted 档需要独立色相」的两处（amber=medium、blue=low）
  "--dsw-static-amber-400",
  "--dsw-static-amber-600",
  "--dsw-static-blue-300",
  "--dsw-static-blue-500",
]);

/**
 * 令牌白名单（测试用）= `THEME_TOKENS` 的集合形态。
 *
 * 单独导出这个名字，是为了让断言读起来是「引用集 ⊆ 白名单」，
 * 而不是「引用集 ⊆ THEME_TOKENS」—— 后者容易被误读成「THEME 里出现过的」。
 */
export const TOKEN_WHITELIST: ReadonlySet<string> = new Set(THEME_TOKENS);

/**
 * 上游演练台样式表 —— **逐字节保真，不要格式化、不要「顺手改好」**。
 *
 * 来源：`dsh-qilin/client.js` 中演练台样式表的整块内容，
 * 起于 `.rt-dock{…}`，止于 `.rt-shot-zoom-cap{…}`。
 * 539 行 / 45,782 字节 / 422 条规则。
 *
 * 开头那个换行是**内容的一部分**（上游原文以换行开头），不是排版。
 * 若编辑器或格式化工具把它删了，行数与字节数都会变，对照测试会红
 * —— 这就是「保真」的可执行含义。
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
 * 战术主题叠加层 —— **只叠加、不改写**（注入顺序排在 `CSS` 之后）。
 *
 * ## 设计方向
 *
 * 「贴官方令牌 + 战术仪表盘感」。宿主的主色在两个主题下都是**近中性**的
 * （浅色 `--dsw-alias-brand-primary` 是深灰、深色是近白），没有彩色主色可用
 * —— 所以「作战台」的感觉不能靠大色块，只能靠四件事：
 *
 * 1. **密度**：行高 29px、表头 25px，比宿主默认紧一档，一屏多装约三分之一行。
 * 2. **等宽数字**：端口 / 分值 / 计数 / 时间戳一律 `tabular-nums`，
 *    列与列之间数字对齐，扫读时眼睛不用为「7 比 1 窄」重新找位置。
 * 3. **语义状态色**：五档严重度各三件（fg / bg / border），三件永远同源
 *    —— 换主题只重声明，不会出现「字红了底还是绿的」。
 * 4. **1px 细线分层**：用 `--dsw-alias-border-l1/l2` 切块，不堆阴影。
 *
 * 硬约束：**不硬编码任何主色**。THEME 里没有一处十六进制色值，
 * 全部走 `var(--dsw-*)` 或从它 `color-mix()` 派生（有测试守着）。
 *
 * ## 一个必须遵守的层叠陷阱（实测踩过，别再踩）
 *
 * CSS 自定义属性的 `var()` 在**声明处**就完成替换，值再沿树继承。
 * 宿主把深色主题加在 **`body`** 上，而 `:root` 是 **`html`**，于是：
 *
 *     :root { --dsw-alias-state-error-primary: 浅色值;
 *             --dsu-sev-critical-fg: var(--dsw-alias-state-error-primary); }  // 浅色值被冻结
 *     [data-ds-dark-theme] { --dsw-alias-state-error-primary: 深色值; }       // body 上覆盖了
 *
 * 结果 `body` 上 alias 确实是深色值，但 `--dsu-sev-critical-fg` 仍是浅色值
 * （在 html 上算好并继承下来的），消费它的规则在深色下一律用浅色 —— 静默错色。
 *
 * **因此**：任何 `var(--dsw-alias-*)` 派生的 `--dsu-*`，都必须在深色块里
 * **整组重声明一遍**（只重声明 fg 会得到「深色字压浅色底」，更难读）。
 * 不依赖主题的派生变量（spacing / radius / 字体栈 / 行高梯度）只在 `:root`
 * 声明一次即可 —— 它们不引用 alias，不会被冻结。
 *
 * ## 深色选择器为什么写两遍
 *
 * 宿主两套写法都用过：`<html data-ds-dark-theme>` 与 `<body data-ds-dark-theme>`。
 * 只覆盖一种，另一种主题下就完全不补偿。两个选择器并列在同一条规则里，
 * 值只写一份。
 */

export const THEME = String.raw`/* ═══════════════════════════════════════════════════════════════════════
   0. 设计变量阶梯
   ─────────────────────────────────────────────────────────────────────
   先立梯子再写规则：所有间距 / 圆角 / 字号 / 行高 / 字重都从这里取，
   规则里不再出现裸数字。改一档 = 改一行，不会在 400 条规则里做手术。

   这一块**不依赖主题**（不引用 --dsw-alias-*），所以只在 :root 声明一次，
   不需要在深色块里重声明。
   ═══════════════════════════════════════════════════════════════════════ */
:root{
  /* 间距：4 的倍数一档，够密也分得开 */
  --dsu-space-1:4px;--dsu-space-2:6px;--dsu-space-3:8px;
  --dsu-space-4:12px;--dsu-space-5:16px;--dsu-space-6:24px;

  /* 圆角：xs 给徽章，sm 给按钮/输入，md 给卡片，lg 给面板壳。
     sm 及以上直接跟随宿主令牌（带像素回落，宿主换皮时不至于塌掉）；
     xs 宿主没有对应档位，用固定 4px —— 不引用不存在的令牌名。 */
  --dsu-radius-xs:4px;
  --dsu-radius-sm:var(--dsw-radius-sm,6px);
  --dsu-radius-md:var(--dsw-radius-md,8px);
  --dsu-radius-lg:var(--dsw-radius-lg,12px);
  /* 浮层阴影：宿主已按主题算好，直接借用，避免自己拼写死黑色 */
  --dsu-shadow-soft:var(--dsw-elevation-soft);

  /* 字体栈：UI 走系统栈（宿主没暴露字体令牌，不硬拼不存在的名字），数字列走等宽 */
  --dsu-font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --dsu-font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;

  /* 字号梯度：micro 给徽章，tiny 给表格数字，small 给页签，body 给正文 */
  --dsu-fs-micro:10.5px;--dsu-fs-tiny:11px;--dsu-fs-small:11.5px;
  --dsu-fs-body:12.5px;--dsu-fs-lead:13px;--dsu-fs-title:15px;

  /* 行高梯度：徽章=1（垂直居中不飘），表格行=tight，正文=base，长文本=loose */
  --dsu-lh-none:1;--dsu-lh-tight:1.28;--dsu-lh-base:1.5;--dsu-lh-loose:1.7;

  /* 字重梯度：表头 semi、数字 semi、标题 bold、普通 400 */
  --dsu-fw-regular:400;--dsu-fw-medium:500;--dsu-fw-semi:600;--dsu-fw-bold:650;

  /* 垂直节奏：表体 29 / 表头 25，比宿主默认紧一档，一屏多装约三分之一行 */
  --dsu-row-h:29px;--dsu-row-h-head:25px;
  --dsu-cell-py:5px;--dsu-cell-px:10px;

  /* ── 以下派生变量引用了 --dsw-alias-*，**深色块必须重声明**
        （var() 在声明处替换，:root 上算好的值会被浅色冻结，详见文件头注释） */
  --dsu-line:1px solid var(--dsw-alias-border-l1);
  --dsu-hover-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 45%,var(--dsw-alias-bg-layer-2));
  --dsu-selected-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-4,var(--dsw-alias-bg-layer-3)) 55%,var(--dsw-alias-bg-layer-2));

  /* ── 五档严重度（浅色）：fg 取语义色的本体，bg/border 从同一色混出来
        这样三件套永远同源 —— 换主题只需重声明，不会出现「字红了底还是绿的」 */
  --dsu-sev-critical-fg:var(--dsw-alias-state-error-primary);
  --dsu-sev-critical-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent);
  --dsu-sev-critical-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);
  --dsu-sev-high-fg:var(--dsw-alias-state-warn-primary);
  --dsu-sev-high-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent);
  --dsu-sev-high-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 36%,transparent);
  --dsu-sev-medium-fg:var(--dsw-static-amber-600);
  --dsu-sev-medium-bg:color-mix(in srgb,var(--dsw-static-amber-600) 12%,transparent);
  --dsu-sev-medium-border:color-mix(in srgb,var(--dsw-static-amber-600) 30%,transparent);
  --dsu-sev-low-fg:var(--dsw-static-blue-500);
  --dsu-sev-low-bg:color-mix(in srgb,var(--dsw-static-blue-500) 11%,transparent);
  --dsu-sev-low-border:color-mix(in srgb,var(--dsw-static-blue-500) 30%,transparent);
  --dsu-sev-info-fg:var(--dsw-alias-label-tertiary);
  --dsu-sev-info-bg:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);
  --dsu-sev-info-border:var(--dsw-alias-border-l2);

  /* success 的浅色值要压深：宿主 green-500（浅色主题下的 success 值）在白底只有 2.28:1，
     11px 小字不够（WCAG AA 要 4.5:1）。混入 label-primary（浅色下近黑）后约 5.1:1。
     派生自 alias，所以深色块必须重声明（见下方层叠陷阱说明）。 */
  --dsu-success-fg:color-mix(in srgb,var(--dsw-alias-state-success-primary) 62%,var(--dsw-alias-label-primary));
}

/* ═══════════════════════════════════════════════════════════════════════
   1. 等宽数字
   ─────────────────────────────────────────────────────────────────────
   端口 / 分值 / 计数 / 时间戳一律 tabular-nums：数字列等宽，扫读时
   眼睛不用为「7 比 1 窄」重新找位置。.rt-sev 家族也带上（分值徽章里是数字）。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-mono,.rt-row,.rt-vrow,.rt-score-row,.rt-tag,
.rt-sev,.rt-sev-critical,.rt-sev-high,.rt-sev-medium,.rt-sev-low,.rt-sev-info,
.rt-ip,.rt-score-pts,.rt-score-scope,.rt-sg-sub,.rt-step-time,.rt-step-dot,
.rt-foot,.rt-kv b,.rt-sess-fact b,.rt-cred-meta,.rt-hit-time{
  font-variant-numeric:tabular-nums;
}
.rt-mono,.rt-score-pts,.rt-score-scope,.rt-step-time,.rt-step-dot,.rt-foot{
  font-family:var(--dsu-font-mono);
}

/* ═══════════════════════════════════════════════════════════════════════
   2. 表格密度
   ─────────────────────────────────────────────────────────────────────
   三张表（资产 / 漏洞 / 得分）共用一套节奏：行高 29、表头 25、内边距 5/10。
   hover 与选中态**全部从 --dsw-alias-bg-layer-* 混出来**，不写死色值 ——
   浅色下是「更浅一层」，深色下自然变成「更亮一层」，同一套规则两边都成立。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-row,.rt-vrow,.rt-score-row{
  min-height:var(--dsu-row-h);
  align-items:center;
  line-height:var(--dsu-lh-tight);
  padding-block:var(--dsu-cell-py);
  padding-inline:var(--dsu-cell-px);
  transition:background-color .12s ease;
}
.rt-row.head,.rt-vrow.head,.rt-score-row.head{
  min-height:var(--dsu-row-h-head);
  text-transform:uppercase;
  letter-spacing:.045em;
  font-size:var(--dsu-fs-micro);
  font-weight:var(--dsu-fw-semi);
  color:var(--dsw-alias-label-tertiary);
  border-bottom:1px solid var(--dsw-alias-border-l2);
}
/* hover：整行提一层，不换色相（避免和严重度色抢注意力） */
.rt-row:hover,.rt-vrow:hover,.rt-score-row:hover{background:var(--dsu-hover-bg)}
.rt-row.head:hover,.rt-vrow.head:hover,.rt-score-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
/* 选中：细左轨 + 更亮一层，不整行填色 */
.rt-row.on,.rt-vrow.on,.rt-score-row.on{
  background:var(--dsu-selected-bg);
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);
}
.rt-row.on:hover,.rt-vrow.on:hover,.rt-score-row.on:hover{
  background:color-mix(in srgb,var(--dsu-selected-bg) 82%,var(--dsw-alias-bg-layer-3) 18%);
}
/* 得分命中：淡绿底只染行，勾选框与分值另给强调 */
.rt-score-row.hit{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.rt-score-row.hit .rt-score-pts{color:var(--dsw-alias-state-success-primary);font-weight:var(--dsu-fw-semi)}

/* 单元格文本：正文行高，超长换行不截断（域名 / 口令 / 回显都要看全） */
.rt-row,.rt-vrow,.rt-score-row,.rt-hit-row,.rt-cred,.rt-evi{overflow-wrap:anywhere}

/* ═══════════════════════════════════════════════════════════════════════
   3. 五档严重度落到 .rt-sev 家族
   ─────────────────────────────────────────────────────────────────────
   上游给 .rt-sev-* 写死了十六进制色值，深色下过曝。
   这里接管成三件套变量 —— 同一档的 fg/bg/border 永远同源。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-sev{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:34px;height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  border:1px solid transparent;
  font-family:var(--dsu-font-ui);
  font-size:var(--dsu-fs-micro);
  font-weight:var(--dsu-fw-semi);
  line-height:var(--dsu-lh-none);
  white-space:nowrap;
}
.rt-sev-critical{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-sev-high{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-sev-medium{color:var(--dsu-sev-medium-fg);background:var(--dsu-sev-medium-bg);border-color:var(--dsu-sev-medium-border)}
.rt-sev-low{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
.rt-sev-info{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}
/* 严重度色条：与徽章同源，避免两处各写一份色 */
.rt-sevbar{background:var(--dsu-sev-info-fg)}
.rt-hit-row:has(.rt-sev-critical) .rt-sevbar{background:var(--dsu-sev-critical-fg)}
.rt-hit-row:has(.rt-sev-high) .rt-sevbar{background:var(--dsu-sev-high-fg)}

/* ═══════════════════════════════════════════════════════════════════════
   4. 同族语义（易打性 / 可用性 / 来源标签）：复用五档，不新造颜色
   ═══════════════════════════════════════════════════════════════════════ */
.rt-pri{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:30px;height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  font-size:var(--dsu-fs-micro);
  font-weight:var(--dsu-fw-semi);
  line-height:var(--dsu-lh-none);
  border:1px solid transparent;
}
.rt-pri-high{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-pri-medium{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-pri-low{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}

.rt-tag,.rt-avail{
  display:inline-flex;align-items:center;gap:var(--dsu-space-1);
  height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  border:1px solid var(--dsw-alias-border-l2);
  font-size:var(--dsu-fs-micro);
  line-height:var(--dsu-lh-none);
  white-space:nowrap;
}
.rt-tag-passive{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
.rt-tag-active{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-tag-live{color:var(--dsu-success-fg);background:color-mix(in srgb,var(--dsu-success-fg) 11%,transparent);border-color:color-mix(in srgb,var(--dsu-success-fg) 32%,transparent)}
.rt-tag-warn{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}

.rt-avail-available{color:var(--dsu-success-fg);background:color-mix(in srgb,var(--dsu-success-fg) 11%,transparent);border-color:color-mix(in srgb,var(--dsu-success-fg) 30%,transparent)}
.rt-avail-broken{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-avail-unknown{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}

/* 测试状态：靠前置小圆点区分，不整块填色（一行里同时出现 3 个状态也不吵） */
.rt-test{
  display:inline-flex;align-items:center;gap:var(--dsu-space-1);
  height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-tertiary);
  font-size:var(--dsu-fs-micro);
  line-height:var(--dsu-lh-none);
  white-space:nowrap;
}
.rt-test::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.rt-test-testing{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-test-testing::before{animation:rt-dsu-pulse 1.6s ease-in-out infinite}
.rt-test-tested{color:var(--dsu-success-fg);background:color-mix(in srgb,var(--dsu-success-fg) 11%,transparent);border-color:color-mix(in srgb,var(--dsu-success-fg) 32%,transparent)}
.rt-test-blocked{color:var(--dsw-alias-bg-base);background:var(--dsu-sev-critical-fg);border-color:var(--dsu-sev-critical-fg)}
.rt-test-no_surface{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
@keyframes rt-dsu-pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ═══════════════════════════════════════════════════════════════════════
   5. 大号数字 / 表头工具条 / 提示条
   ═══════════════════════════════════════════════════════════════════════ */
.rt-score-big{
  font-family:var(--dsu-font-mono);
  font-size:25px;font-weight:var(--dsu-fw-bold);line-height:var(--dsu-lh-none);
  letter-spacing:-.03em;
}
.rt-score-group{
  font-size:var(--dsu-fs-tiny);font-weight:var(--dsu-fw-semi);letter-spacing:.025em;
  line-height:var(--dsu-lh-tight);
  color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);
}
.rt-meter{height:5px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}
.rt-meter>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}
.rt-toolbar{padding:var(--dsu-space-1) var(--dsu-space-3);border-bottom:var(--dsu-line)}
.rt-foot{font-size:var(--dsu-fs-micro);color:var(--dsw-alias-label-tertiary);padding:var(--dsu-space-1) var(--dsu-space-4)}
.rt-hint{border:1px dashed var(--dsu-sev-critical-border);background:var(--dsu-sev-critical-bg);border-radius:var(--dsu-radius-sm)}
.rt-hint b{color:var(--dsu-sev-critical-fg);font-weight:var(--dsu-fw-semi)}
.rt-err{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border:1px solid var(--dsu-sev-critical-border);border-radius:var(--dsu-radius-sm);padding:var(--dsu-space-2) var(--dsu-space-3)}

/* ═══════════════════════════════════════════════════════════════════════
   6. 焦点可见性
   ─────────────────────────────────────────────────────────────────────
   上游有几处 outline:none，键盘用户会彻底失去位置感。这里补回 :focus-visible
   —— 只在键盘导航时出现，鼠标点击不抢戏。**不要**用 outline:none 再干掉它。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-dock :focus-visible,.rt-full :focus-visible,.rt-embedded :focus-visible,
.rt-pane :focus-visible,.rt-modal-box :focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px;
  border-radius:var(--dsu-radius-xs);
}
.rt-dock:focus-visible,.rt-full:focus-visible{outline-offset:-2px}

/* ═══════════════════════════════════════════════════════════════════════
   7. 深色补偿
   ─────────────────────────────────────────────────────────────────────
   两套选择器都要覆盖：宿主既有 <html data-ds-dark-theme>，也用过
   <body data-ds-dark-theme>。**凡是值里引用了 --dsw-alias-* 的 --dsu-*
   都必须在这里重声明一遍**，否则会在 :root 上被浅色值冻结（只重声明
   fg 而不重声明 bg 会得到「深色字压在浅色底上」，比不补偿更难读）。
   ═══════════════════════════════════════════════════════════════════════ */
[data-ds-dark-theme],
body[data-ds-dark-theme]{
  --dsu-line:1px solid var(--dsw-alias-border-l1);
  --dsu-hover-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 60%,var(--dsw-alias-bg-layer-2));
  --dsu-selected-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-4,var(--dsw-alias-bg-layer-3)) 70%,var(--dsw-alias-bg-layer-2));

  --dsu-sev-critical-fg:var(--dsw-alias-state-error-primary);
  --dsu-sev-critical-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);
  --dsu-sev-critical-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);
  --dsu-sev-high-fg:var(--dsw-alias-state-warn-primary);
  --dsu-sev-high-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);
  --dsu-sev-high-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 44%,transparent);
  /* amber / blue 在深底上按同一色相提亮一档（600 → 400 / 500 → 300） */
  --dsu-sev-medium-fg:var(--dsw-static-amber-400);
  --dsu-sev-medium-bg:color-mix(in srgb,var(--dsw-static-amber-400) 16%,transparent);
  --dsu-sev-medium-border:color-mix(in srgb,var(--dsw-static-amber-400) 36%,transparent);
  --dsu-sev-low-fg:var(--dsw-static-blue-300);
  --dsu-sev-low-bg:color-mix(in srgb,var(--dsw-static-blue-300) 15%,transparent);
  --dsu-sev-low-border:color-mix(in srgb,var(--dsw-static-blue-300) 34%,transparent);
  --dsu-sev-info-fg:var(--dsw-alias-label-tertiary);
  --dsu-sev-info-bg:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);
  --dsu-sev-info-border:var(--dsw-alias-border-l3);

  /* 深色下同一个表达式自动变成"提亮"（label-primary 在深色是近白），
     约 7.9:1。因为引用 alias，必须在这里重声明，否则被 :root 的浅色值冻结。 */
  --dsu-success-fg:color-mix(in srgb,var(--dsw-alias-state-success-primary) 62%,var(--dsw-alias-label-primary));
}

/* 深色下把「更亮一层」的语义反过来用：阴影没用了，靠底色阶与细线分层 */
[data-ds-dark-theme] .rt-row:hover,
[data-ds-dark-theme] .rt-vrow:hover,
[data-ds-dark-theme] .rt-score-row:hover,
body[data-ds-dark-theme] .rt-row:hover,
body[data-ds-dark-theme] .rt-vrow:hover,
body[data-ds-dark-theme] .rt-score-row:hover{
  background:var(--dsu-hover-bg);
}
[data-ds-dark-theme] .rt-row.head,
[data-ds-dark-theme] .rt-vrow.head,
[data-ds-dark-theme] .rt-score-row.head,
body[data-ds-dark-theme] .rt-row.head,
body[data-ds-dark-theme] .rt-vrow.head,
body[data-ds-dark-theme] .rt-score-row.head{
  border-bottom-color:var(--dsw-alias-border-l2);
}

/* ═══════════════════════════════════════════════════════════════════════
   页签条单行收紧 + 等宽数字
   ═══════════════════════════════════════════════════════════════════════ */
/* 10 个页签在 620px 宽下必须排成一排：默认 padding 会把最后一个挤到第二排，
   既浪费纵向空间，看着也像渲染错位。内边距收到 7px 正好放下；
   保留 wrap 作保险 —— 更窄时换行总比横向滚动把页签藏起来好。 */
.rt-tabs{gap:1px;padding:0 var(--dsu-space-3)}
.rt-tab{flex:none;padding:9px 7px 8px}

/* 数字列一律等宽对齐（端口 / 分值 / 计数 / 时间戳 / IP）。
   拆成逐条类规则：测试能按类名逐个断言覆盖，也便于以后单独调某一类。 */
.rt-mono{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-ip{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-row{font-variant-numeric:tabular-nums}
.rt-vrow{font-variant-numeric:tabular-nums}
.rt-score-row{font-variant-numeric:tabular-nums}
.rt-score-pts{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-score-big{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-tag{font-variant-numeric:tabular-nums}
.rt-sev{font-variant-numeric:tabular-nums}
.rt-sev-critical{font-variant-numeric:tabular-nums}
.rt-sev-high{font-variant-numeric:tabular-nums}
.rt-sev-medium{font-variant-numeric:tabular-nums}
.rt-sev-low{font-variant-numeric:tabular-nums}
.rt-sev-info{font-variant-numeric:tabular-nums}
.rt-avail{font-variant-numeric:tabular-nums}
.rt-step-time{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-foot{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}

/* ═══════════════════════════════════════════════════════════════════════
   表格列宽：上游按「全宽窗口」设计的固定像素列，在 620px dock 里会把
   最后一列压成竖排单字（实测：「开放端口 / 指纹」逐字换行，列宽被算成 0）。

   做法分两步：
   ① 给滚动容器声明 container-type，让下面的容器查询真的能命中
      （不声明的话 @container 永不匹配，这是第一次修没生效的原因）；
   ② 窄容器下**少显示一列**而不是硬压五列 —— 401px 内容宽里塞 5 列，
      无论怎么分配都不够读。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-table,.rt-pane,.rt-chain,.rt-list{container-type:inline-size}

/* 宽容器（full 窗口 / 大屏）：五列全显示 */
.rt-row{grid-template-columns:minmax(120px,150px) 50px 84px minmax(120px,1.3fr) minmax(110px,1fr)}
.rt-vrow{grid-template-columns:62px minmax(0,1.8fr) minmax(120px,180px) 110px 74px 54px}
.rt-score-row{grid-template-columns:14px minmax(0,1fr) 76px 64px}

/* 窄容器（dock 常态）：按真实列序精确减列。
   资产表 5 列：①IP ②易打 ③测试状态 ④端口服务 ⑤指纹
   漏洞表 6 列：①等级 ②漏洞 ③目标 ④拿到什么 ⑤状态 ⑥置信
   被砍的列在详情面板里都还能看到，不是信息丢失。 */
@container (max-width: 560px){
  /* 资产：砍第 5 列（指纹） */
  .rt-row{grid-template-columns:minmax(108px,1.1fr) 46px 78px minmax(96px,1.2fr)}
  .rt-row > *:nth-child(5){display:none}
  /* 漏洞：砍第 6 列（置信） */
  .rt-vrow{grid-template-columns:58px minmax(0,1.6fr) minmax(84px,1fr) 96px 56px}
  .rt-vrow > *:nth-child(6){display:none}
  .rt-score-row{grid-template-columns:14px minmax(0,1fr) 70px 56px}
}
/* 极窄（拖到最小宽 320px）：再砍到 3 列 */
@container (max-width: 420px){
  /* 资产：①IP ②易打 ③测试状态 —— 砍 ④⑤ */
  .rt-row{grid-template-columns:minmax(100px,1fr) 44px 76px}
  .rt-row > *:nth-child(4){display:none}
  .rt-row > *:nth-child(5){display:none}
  /* 漏洞：①等级 ②漏洞 ③目标 —— 砍 ④⑤⑥ */
  .rt-vrow{grid-template-columns:54px minmax(0,1fr) minmax(76px,.8fr)}
  .rt-vrow > *:nth-child(4){display:none}
  .rt-vrow > *:nth-child(5){display:none}
  .rt-vrow > *:nth-child(6){display:none}
  /* 得分：①勾选 ②名称 ③分值 —— 砍 ④口径 */
  .rt-score-row{grid-template-columns:14px minmax(0,1fr) 64px}
  .rt-score-row > *:nth-child(4){display:none}
}

/* full 模式（独立窗口）：最宽松 */
.rt-full .rt-row{grid-template-columns:180px 56px 96px minmax(0,1.3fr) minmax(150px,1fr)}
.rt-full .rt-vrow{grid-template-columns:76px minmax(0,1.8fr) minmax(160px,240px) 130px 84px 60px}

/* 单元格一律允许收缩、不竖排：
   word-break: break-all 会把 443/tcp 断成 4 4 3，逐字换行 */
.rt-row > *,.rt-vrow > *,.rt-score-row > *{
  min-width:0;
  overflow-wrap:normal;
  word-break:keep-all;
}

/* 尊重系统「减少动态效果」：不做过渡与脉冲，信息一个不少 */
@media (prefers-reduced-motion:reduce){
  .rt-test-testing::before{animation:none}
  .rt-row,.rt-vrow,.rt-score-row,.rt-btn,.rt-item,.rt-seg,.rt-tab{transition:none}
}
`;

/**
 * `<style>` 元素的最小面 —— 直接复用 `dom.ts` 的 `MinimalStyleElement`。
 *
 * 不新造形状：注入器写进去的东西，与仓库其它 DOM 代码是同一个契约。
 */
export type StyleElementLike = MinimalStyleElement;

/**
 * 注入用的最小 `document` 面。
 *
 * 为什么自定义而不用 `MinimalDocument`：后者**没有 `querySelector`**，
 * 而幂等（「已有节点就复用」）必须能查到既有节点。`dom.ts` 的
 * `MinimalDocument` 是按「只声明我们真读的成员」长的，那里确实不需要查询；
 * 这里需要，所以单独声明一个更宽一点的窄接口 —— 比给全局 `MinimalDocument`
 * 加成员（那会逼所有调用点都实现它）影响面小得多。
 *
 * `querySelector` 仍是可选的：拿不到它时退化为「按实例记忆」的幂等
 * （见 `installStyles`），而不是抛错 —— 注入样式是**尽力而为**的事，
 * 不该因为宿主文档对象不完整就让整个面板挂掉。
 */
export interface DocumentLike {
  createElement(tag: "style"): StyleElementLike;
  readonly head: {
    append(child: StyleElementLike): void;
  };
  querySelector?(selector: string): unknown;
}

/** 标记属性名：注入的每个 `<style>` 都带它，便于查重与人工定位。 */
export const STYLE_ATTR = "data-dsh-unbound-drill";

/** `key` 的默认值 —— 与标记属性的名字一致，方便在 DevTools 里直接搜。 */
export const DEFAULT_STYLE_KEY = STYLE_ATTR;

/** `installStyles` 的选项。 */
export interface InstallStylesOptions {
  /**
   * 标记属性的**值**，默认 `"data-dsh-unbound-drill"`。
   *
   * 同一个 `key` = 同一个实例（重复调用复用同一节点）；
   * 不同 `key` = 各自独立的节点（同一页面挂两个控制台时，清理互不牵连）。
   */
  readonly key?: string | undefined;
}

/**
 * 按 `document` 记住「本实例装过哪些 key 的节点」。
 *
 * 两个用途：`querySelector` 缺失时仍能保证幂等；清理函数能拿到自己那个节点
 * （而不是误删别人后插进来的同 key 节点）。用 `WeakMap` 是为了不把文档对象
 * 钉在内存里 —— 文档销毁即整条记录消失。
 */
const INSTALLED = new WeakMap<DocumentLike, Map<string, StyleElementLike>>();

/** 取（或建）某个文档的 key→node 记忆表。 */
function slotOf(doc: DocumentLike): Map<string, StyleElementLike> {
  const existing = INSTALLED.get(doc);
  if (existing !== undefined) return existing;
  const created = new Map<string, StyleElementLike>();
  INSTALLED.set(doc, created);
  return created;
}

/**
 * 在文档里查同 key 的既有 `<style>`。
 *
 * 两条路：优先 `doc.querySelector`（真实 DOM 走这条，跨实例都查得到）；
 * 退路是模块级记忆表（假文档 / 精简文档对象走这条）。查不到返回 `undefined`。
 */
function findInstalled(doc: DocumentLike, key: string): StyleElementLike | undefined {
  const remembered = INSTALLED.get(doc)?.get(key);
  if (remembered !== undefined) return remembered;
  if (typeof doc.querySelector !== "function") return undefined;
  const found = doc.querySelector("style[" + STYLE_ATTR + '="' + key + '"]');
  if (found !== null && typeof found === "object") return found as StyleElementLike;
  return undefined;
}

/**
 * 把 `CSS` + `THEME` 注入 `<head>`，返回清理函数。
 *
 * ## 为什么合成一个 `<style>` 而不是两个
 *
 * `THEME` 必须**排在** `CSS` 之后才能赢 —— 这是语义上的顺序依赖，不是巧合。
 * 合成一个节点后，顺序由字符串拼接位置保证：它是一份文本内部的先后，
 * 不依赖「两次 append 的时间先后」。后者在浏览器里也成立，但是脆的：
 * 将来任何人在中间插一次别的注入、或宿主把两个节点挪进不同层叠上下文，
 * 顺序就悄悄反了 —— 而「顺序反了」的症状是「主题没生效」，极难归因。
 *
 * 附带好处：查重只查一个节点，清理只移除一个节点。
 *
 * ## 幂等
 *
 * 已有同 `key` 的节点时**复用并刷新内容**，不重复插入。宿主 hot reload 会
 * 反复调注入，每轮插一个 `<style>` 会让样式表无限增长（旧规则还在生效，
 * 改一版留一层，调样式时永远看到最旧的）。复用而不是提前返回，是为了
 * 「改完立刻生效」：刷新 `textContent` 就够，浏览器会重新解析。
 *
 * ## 清理函数
 *
 * 移除节点，并把记忆表里的记录清掉。**可重复调用**（第二次是 no-op）：
 * React 的 effect 清理在热重载下会跑不止一次，清理函数抛错会把整棵面板带崩。
 */
export function installStyles(doc: DocumentLike, options: InstallStylesOptions = {}): () => void {
  const key = options.key ?? DEFAULT_STYLE_KEY;
  const payload = CSS + "\n\n" + THEME;

  const existing = findInstalled(doc, key);
  const node = existing ?? doc.createElement("style");
  if (existing === undefined) {
    node.setAttribute(STYLE_ATTR, key);
    doc.head.append(node);
  }
  node.textContent = payload;
  slotOf(doc).set(key, node);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const table = INSTALLED.get(doc);
    if (table !== undefined && table.get(key) === node) table.delete(key);
    node.remove();
  };
}
