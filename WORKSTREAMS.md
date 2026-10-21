# 全量重写工作流（现状与写入域）

目标：把 `dsh-qilin` 的其余部分迁到 DSH-unbound 的严格 TS。

**当前进度：五个工作流全部已落地，共 49,786 行 / 115 文件 / 4,007 用例**
（commit `0da8067` + 未提交改动，实测于 Node v22.22.1，2026-10-21 16:20）。

> 数字为某一时刻快照。控制台接线（`src/redteam/ui/console.ts`、
> `scripts/build-client.mjs`、`test/integration/`）与引擎改动正在并行落地，
> 稍后重跑可能得到不同的数量与个别失败。复验以自己跑 `npm test` 为准。上一版标题写"772h 分解 /
剩余 ~28,400 行"，那个数字已经过期 —— 实测口径见下。

## 写入域纪律

每个工作流**只**改自己目录，避免并行冲突：

| 工作流 | 独占写入域 | 上游依赖 | 状态 |
|---|---|---|---|
| W1 存储层 | `src/redteam/store/**`, `test/store/**` | host-api, shared, platform | ✅ 15 文件 / 10,636 行 / 131 用例 |
| W2 工具层 | `src/redteam/tools/**`, `test/tools/**` | store 的**类型**（不读实现） | ✅ 11 文件 / 4,238 行 / 286 用例 |
| W3 控制台 | `src/redteam/ui/**`, `src/redteam/client/**`, `test/ui/**`, `test/redteam/**` | store 类型 | ✅ 51 文件 / 22,970 行 / 2,284 用例 |
| W4 插件层 | `src/plugin/**`, `src/index.ts`, `test/plugin/**` | host-api | ✅ 10 文件 / 4,825 行 / 480 用例 |
| W5 平台层 | `src/platform/**`, `src/features/**`, `test/platform/**` | host-api | ✅ 14 文件 / 4,331 行 / 577 用例 |

**共享只读**（已由 Lead 建立，改它要先说）：`src/host-api/**`, `src/shared/**`,
`src/engine/**`, `src/patches/**`, `src/fs/**`, `src/host/**`, `tsconfig*.json`。

## 关键约定

1. `@deepseek-ai/*` **没有 .d.ts**。一切宿主交互走 `src/host-api` 的
   `HostContext`；不要新建 `any`。
2. 未类型化输入用 `unknown` + 窄化，不用 `any`。
3. 预期内失败用 `Result`（`src/shared/result.ts`），编程错误才 throw。
4. 每个模块必须带测试。实测已远超"≥30 用例/工作流"的目标（最少的是 store 的 131）。
5. 迁移时**先读原实现**，用行为等价性测试锁住，再重构。不许凭印象重写。

## 还剩什么（这才是真正的待办）

五个工作流的**代码与测试**都完成了，剩下的不是"再迁多少行"，而是三类收口。

### 0. 历史记录：控制台接线曾经断在 7 处（现已全部补齐）

这段是**本轮工作的真实历史**，保留它是为了给后来人一个排查起点 ——
"当初断了哪 7 处、每处的判据是什么"是有价值的：这 7 处里有 5 处
**不会让任何测试变红**，只能靠逐个判据命令查出来。

下表状态核实于 2026-10-21 17:21（最终状态）。

| # | 断点 | 判据命令 | 当时状态 |
|---|---|---|---|
| 1 | `package.json` 缺 `dsh.client` | `python3 -c "import json;print(json.load(open('package.json')).get('dsh'))"` | ✅ 已补 |
| 2 | 缺 `cordis.patch.yml`（`dsh.bundle.patch` 指向它） | `ls cordis.patch.yml` | ✅ 已建（72 行） |
| 3 | store 无 Cordis 入口（`provide('redteam', store)`） | `grep -rn 'new RedteamStore' src/ --include='*.ts'` | ✅ `service.ts:1145` |
| 4 | 无 `/redteam/api` 路由注册 | `grep -n 'ROUTE_PATH' src/redteam/service.ts` | ✅ `ROUTE_PATH = "/redteam/api"`，经 `webServerOf()` 注册 |
| 5 | `exports` 无 service 子路径 | `python3 -c "import json;print(list(json.load(open('package.json'))['exports']))"` | ✅ 含 `./service` |
| 6 | `insert` 只有 1 行（缺服务端那行） | `grep -A99 '^\- insert:' cordis.patch.yml \| grep '^\s\+- id:'` | ✅ 2 行（`dsh-unbound` + `dsh-unbound-service`） |
| 7 | 无页签数据接线（`TabPropsSlot` 未实现） | `grep -c 'makeTabPropsSlot' src/redteam/ui/console.ts` | ✅ `console.ts` → `tab-data.ts` → `tabs-a.ts`(6) + `tabs-b.ts`(6) |

**为什么 #1/#2 是致命项而不是"少一项配置"**：宿主有专门的清单校验器
（`dsh-client-modules` 的 `parseDshClient()`），它要求 `dsh.client.platform`
是 string、`inject` / `external` 是 string 数组。`dsh` 字段整个缺失时，
宿主**不认为这是个 DSH 插件** —— `client.js` 永远不会被加载。这时候
`console.ts` 写得再对也没用。

**为什么 #3/#4 比 #1/#2 更隐蔽**：补完 #1/#2 之后，控制台会**出现**，
但每个页签都是空的。因为 `src/redteam/client/api.ts` 的契约是"永不 reject"
（任何失败都变成 `{ok:false}`），路由 404 时页签静默走空态。
`src/redteam/ui/server.ts:39` 的注释写着"这是 `webServer.register(...)` 的
handler 本体" —— handler 写了，**调用点从来没写**。这比完全没写更坑人：
后来人读到注释会以为已经接了。

**与上游的结构差异（不是缺失）**：`dsh-qilin` 的 `insert` 是 4 行
（宿主半侧 + `redteam` 预设 + `redteam/store` + `redteam/ui`）。本包合并成
**2 行**（`dsh-unbound` 宿主半侧 + `dsh-unbound-service` 服务端），因为本包
的 store 与 ui 是**同进程内的库**（导出 `RedteamStore` 类、`handleGateway`、
`serveRequest` 等函数，不是插件对象），没必要模仿上游拆成多个 Cordis 模块。
看过上游的人容易误判"漏了两行"，实际是有意合并。

### 1. W3 的最后一环：装配进插件运行时（已完成）

这张表记录的是**接线之前**的状态，保留作为"当初缺什么"的清单：

| 缺口 | 证据 |
|---|---|
| `src/plugin/**` 不引用 `src/redteam/**` | **保持如此，且是有意的**：两者是 `cordis.patch.yml` 里两个独立入口，headless 面因此不会在加载时拉进 `node:sqlite` |
| 无 `/redteam/api` 路由 | 已由 `src/redteam/service.ts` 注册（`ROUTE_PATH`），真 cordis 内核实测：挂 1 路由 → HTTP 200 → 卸载后 0 路由 |
| 无 store 服务发布 | `service.ts:1145` `new RedteamStore(root)` + `provide("redteam", store)`，`store.close()` 挂独立 effect（不与 provide 的 disposer 混用）|
| 56 个工具未注册 | `src/redteam/tools/index.ts::registerTools(ctx, store)` 仍未在此接线 —— 工具注册属于 Cordis 半侧，与本轮控制台接线是两件事，见下方"仍未做" |
| 客户端产物未挂载 | 产物 `client.js` 732,637 字节 / sha256 `7673d34a…`，`check:client` up to date；`console.ts` 已由 `client.js` 入口装配（`makeConsoleModule`）并挂 `shell.overlay` |

**验收口径**（接线完成时应能复现，现在也就绪了一半）：

```js
// 已实测通过（真 HTTP server + 真 RedteamStore）
POST {"op":"bootstrap"} -> 200 {"ok":true,...}
POST {"op":"nope"}      -> 400 {"code":"unknown_op"}
```

接线完成后应额外满足：宿主 UI 里出现 `⛨ RedTeam` 入口（`client/entry.ts`
的 `SidebarButton` / `HeaderButton` 被真实渲染），点开是 10 个页签的 dock
（`TABS` = assets/env/agents/sessions/findings/chain/scores/report/knowledge/skills）。

**排查顺序（接线后不工作时）**：先看宿主日志里 `console.ts` 的四道早退守卫
—— 无 `window` / 无 `fetch` / 无 `ctx.slots` / `require('react')` 失败，各留一条
`[dsh-unbound] 控制台未挂载：...` 的 warn。四道都过才轮到查 `POST /redteam/api`
是否 404（浏览器 devtools）。

### 2. 无人调用的纯逻辑模块

迁完、测完、但**没有任何生产代码引用**。它们不是死代码 —— 是等接线或等
对应功能落地的部分，但必须如实标注，别让读者以为在跑：

| 模块 | 行数 | 情况 |
|---|---:|---|
| `src/features/continue-retry.ts` | 203 | 纯判定逻辑，无调用方 |
| `src/features/rewind.ts` | 378 | 同上 |
| `src/features/uninstall.ts` | 186 | 同上 |
| `src/platform/desktop-paths.ts` | 194 | 只做 asar/资源路径**判定**，无调用方 |
| `src/platform/net-scope.ts` | 317 | 无调用方（`net-tables.ts` 被它引用） |
| `src/platform/net-tables.ts` | 85 | 只被 `net-scope.ts` 引用 |
| `src/platform/version.ts` | 144 | 无调用方 |

`src/platform` 里**有**调用方的是：`ip-utils`（store 4 处）、
`platform-config`（store/tools 4 处）、`validate`（store 3 处）、
`skill-availability`/`skill-fixes`/`settings`（tools 各 1–2 处）、
`zip`（plugin/skills.ts 1 处）。

### 3. 平台专属能力仍未实现

| 未做 | 证据 |
|---|---|
| 桌面 asar 解包 / 重打包 | `grep -rn 'extractAsar\|asarUnpack\|writeAsar' src/` 为空；只有路径判定 + "密封 asar 不就地打"策略 |
| 更新通道执行 | `updateCheck` / `updateApply` 仅为 `GatewayPorts` 端口（`src/redteam/ui/gateway.ts`），下载/替换/重启实现在别处 |
| 随包技能目录 | `skill-availability.ts` 找 `<pkg>/skills/redteam`，仓库无 `skills/`；`package.json` `files` 是 `["dist","patches","client.js","cordis.patch.yml","README.md","LICENSE"]` |

## 规模对照（实测口径）

```text
dsh-qilin lib/            39,098 行（52 个 .js）
  └ lib/redteam/          17,690 行（17 个 .js）
DSH-unbound src/          49,786 行（115 个 .ts）
DSH-unbound test/         43,464 行（96 个 .ts，其中 82 个 .test.ts）
```

本包 `src/` 比上游 `lib/` 多出的部分主要来自：类型声明与注释（严格档要求
每个非显然取舍写清理由）、`src/redteam/ui` 这一层（上游 `ui.js` 1,156 行，
本包拆成 14 个模块 5,450 行：bridge 要能脱离 socket 穷举测试，页签取数又拆成
`tabs-a` / `tabs-b` / `tab-data` 三层以便逐页签单测），以及新增的
`src/redteam/service.ts`（1,307 行，服务端聚合入口，上游没有对应文件
——它对应上游拆成两个 Cordis 模块的那两行）。

> 旧版本文档里的"剩余 ~28,400 行"无法与上述任何数字对应，已删除 —— 
> `lib/` 总量 39,098、红队部分 17,690，两者相减是 21,408，都不是 28,400。
> 如果那个数字来自更早的某次粗估，它现在已经没有意义。
