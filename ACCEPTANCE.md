# 验收矩阵 — v0.1.0

每条都是**可重复执行的命令 + 明确判据**，不是"已完成"的声明。
`脚本列`里的命令都能在本仓库根目录直接跑。

> **本次修订说明**：上一版标题写 `v0.0.1`、测试写 `131 tests / 34 suites`、
> 汇总写 `67 项`，并声称红队控制台"不在范围"。三项都已过期：
> 实测测试量是 **4,007 / 681 suites**，红队五层（store / tools / ui / client / service）
> 共 **37,844 行**已经写完并有测试。本文档已按实测重写。
> 基线：commit `0da8067` + 未提交的控制台接线改动，Node `v22.22.1`，macOS，
> 测量时刻 **2026-10-21 16:20**。

> 本文件记录的是 **2026-10-21 17:21 的最终状态**（控制台接线全部完成之后）。
> 数字仍会随开发变化，复验请自己跑 `npm test`。

---

## A. 类型正确性

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| A1 | 全严格档类型检查通过 | `npm run typecheck` | 退出码 0，`error TS` 计数 = 0 | ✅ |
| A2 | 类型检查真的在检查（非空转） | 往 `src/` 放一个 `const n: number = "x"` | `tsc` 报 ≥1 个错误 | ✅ |
| A3 | 覆盖的严格开关 | 检查 `tsconfig.json` | 含 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitReturns`、`useUnknownInCatchVariables` | ✅ |
| A4 | 被检查的文件数 | `npx tsc -p tsconfig.json --noEmit --listFiles \| grep -c '/src/'` | ≥ 11 | ✅ (**110**) |

**A4 说明**：上一版写 `11`，那是只有补丁引擎时的数字。现在 `src/` 有
**115 个 `.ts`**（49,786 行），A4 的实测值是 115。

**A2 实测**：注入 `const n: number = "definitely not a number"` → `1 error`，删除后 `0 error`。

---

## B. 补丁表完整性

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| B1 | 补丁条数 = 原项目 | `npm run verify:patches` | `patches: 86` | ✅ |
| B2 | id 唯一 | 同上 + `test/patches.test.ts` | 无 repeated id | ✅ |
| B3 | 无空 pattern | 同上 | `empty literal` 计数 = 0 | ✅ |
| B4 | 所有正则可构造 | 同上 | `invalid regex` 计数 = 0 | ✅ |
| B5 | 每条都有目标文件 | 同上 | 无 `has no file key` | ✅ |
| B6 | 正则未在序列化中丢字段 | `node -e` 读 `patches.json` 查 `$regex` | 5 条正则完整保留 source+flags | ✅ (5) |
| B7 | 两套历史 schema 都被折叠 | `test/patches.test.ts` | `patterns[]+replace` → 2 条 replacements | ✅ |

**B1 实测输出**：

```text
patches: 86
literal patterns: 210
regex patterns: 5
with markers: 79
skipIfMarked: 38
optional: 48
ok: patch table is well-formed
```

---

## C. 行为等价性（最硬的验收）

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| C1 | 新旧引擎输出逐字节一致 | `npm test`（`test/equivalence.test.ts`） | 对比 ≥20 对，`diffs` 为空 | ✅ (100 对, 0 差异) |
| C2 | 等价性在**真实宿主源码**上成立 | 同上 | 用原引擎的 `targetFiles()` 解析出的真实路径 | ✅ |
| C3 | 连跑三次不再变化（防膨胀） | 同上 | `thrice === twice` | ✅ |
| C4 | 样本量足够 | 同上 | `compared > 20` 断言 | ✅ |

**C1 独立复核**（不依赖测试框架的一次性脚本，本次重跑）：

```
compared (patch,file) pairs: 100
  byte-identical: 100
  DIFFERED:       0
```

**C 组的前置条件必须说清**：`test/equivalence.test.ts` 带
`{ skip: !canRun }`，`canRun` 要求同时存在 `dsh-qilin` 检出与真实宿主
`@deepseek-ai` 目录。**缺任一条件时这 2 个用例是 skip 而不是 fail** ——
也就是说在没有上游检出的 CI 里，C1–C4 不会给你任何信号。本次验收
两种情况都确认过：

- 本机（两者都在）：`# pass 2 / # skipped 0`，100 对 0 差异。
- 若 `QILIN_PATH` 未设：用例被标记 skip，其余 3,627 个照常跑。

---

## D. 被保留的隐式语义（7 条，全部有测试）

| # | 语义 | 为什么必须保留 | 测试 |
|---|---|---|---|
| D1 | CRLF 往返 | 不做则 `\n` pattern 在 CRLF 文件上永不命中 → 静默 no-op | `text.test.ts` — CRLF 往返 3 例 |
| D2 | `$1` 展开（字符串形态 replace） | 回调形态会把 `$1` 字面写进宿主文件 | `text.test.ts` — `$1 展开生效` |
| D3 | `lastIndex` 隔离 | 共享 `/g` 正则第二次从中间开始 → 时灵时不灵 | `text.test.ts` — 连续调用 4 次 |
| D4 | 强制全局替换 | 补丁语义是"改所有出现"，不是"改第一个" | `text.test.ts` — 强制全局 |
| D5 | YAML `//`→`#`（引号/`!!js` 例外） | 否则 YAML 解析失败 | `text.test.ts` — 9 例 |
| D6 | YAML 里跳过裸 identity needle | 破坏块标量缩进 | `text.test.ts` — 2 例 |
| D7 | `skipIfMarked` 防重复插入 | 原注释记 +841 字符/次，永不收敛 | `apply.test.ts` — 连跑 3 次长度不变 |

---

## E. 引擎正确性

| # | 验收项 | 判据 | 状态 |
|---|---|---|---|
| E1 | 首次 apply 状态 `applied` 且文件真改 | `apply.test.ts` | ✅ |
| E2 | 第二次 apply **0 文件写入**、状态 `already` | 同上 | ✅ |
| E3 | 幂等：mtime 不被无谓更新 | 20ms 间隔后 mtime 不变 | ✅ |
| E4 | pattern 不存在 → `pattern_not_found`，文件不动 | 同上 | ✅ |
| E5 | 目标包不存在 → `missing_file` | 同上 | ✅ |
| E6 | `optional` 目标缺失 → `na`（不算失败） | 同上 | ✅ |
| E7 | `dryRun` 一个字节都不写 | 同上 | ✅ |
| E8 | 写盘后无 `.tmp` 残留 | 同上 + `regressions.test.ts` | ✅ |
| E9 | 备份只在首次创建，内容为**打补丁前**原文 | `apply.test.ts` — 第二次不覆盖 | ✅ |
| E10 | `revert` 能用备份还原 | 同上 | ✅ |
| E11 | `revert` 能识别 dsh-qilin 旧后缀 `.dshqilin.bak` | 同上 | ✅ |
| E12 | 无备份的文件 `revert` 报 missing 且不写 | 同上 | ✅ |
| E13 | 多目标补丁写多个文件 | 同上 | ✅ |
| E14 | `only` / `skip` / `surface` 过滤 | 同上 | ✅ |
| E15 | 写失败不留半截文件（内容仍是完整的一份） | `regressions.test.ts` — 只读目录 | ✅ |

---

## F. 漂移检测（本项目新增能力）

| # | 验收项 | 判据 | 状态 |
|---|---|---|---|
| F1 | 七种状态各有区分 | `drift.test.ts` | ✅ |
| F2 | `partial` 被识别为 broken（"看起来能用"最危险） | `broken = partial + dead` | ✅ |
| F3 | `absent` **不**被算成 broken | 桌面补丁在 web 宿主上 | ✅ |
| F4 | 汇总自洽：各状态和 = total | 断言 | ✅ |
| F5 | `drift` 退出码语义：broken=0→0，broken>0→1 | `driftExitCode()` | ✅ |
| F6 | 升级链补丁在干净宿主上判 `pending-upgrade` 而非 `dead` | 见下方说明 | ✅ |
| F7 | 与 `apply` 结论一致：healthy→applied，dead→pattern_not_found | 交叉断言 | ✅ |
| F8 | 报告里 pattern 摘要折叠换行，不撑破多行 | `formatDriftReport` | ✅ |

**F6 为什么重要**：补丁 `#21` 的 pattern 只匹配 `timeoutMs: 600000 # [dsh-qilin] bash timeout raised`，那是**上一次应用之后才存在**的文本。在干净宿主上它必然 0 命中。若判 `dead`，`drift` 会在健康宿主上永远退出 1，告警立刻失去意义。

**本次实测**（`node dist/cli/index.js drift`，真实宿主）：

```text
aiBase: /Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai
patches 86 | healthy 0 | applied 73 | partial 0 | dead 0 | absent 12 | reverted 0 | pending-upgrade 1
broken: 0  ✓
```

> 这组数字是**某一时刻该宿主的状态**，不是常量。同一台机器在宿主文件被
> 替换/回滚后再跑，会出现 `applied 31 | dead 39 | pending-upgrade 3`
> （本次修订期间实测到过）。`drift` 描述的是"宿主现在长什么样"，
> 只有 `broken: 0` 才是健康信号；各状态计数随宿主变化。

---

## G. 原项目 3 个真 bug 的回归防护

| # | bug | 回归测试 | 判据 |
|---|---|---|---|
| G1 | `skills.js` 用了 `fs` 却没 import，`catch` 吞掉 ReferenceError → symlink 守卫空转 | `regressions.test.ts` 静态扫描 | `src/` 下任何 `fs.` 必须有 `fs` import |
| G2 | `schema.js` 的 `LEGACY_STAGE_MAP` / `SCOPE_SQL` 未定义，两段迁移永不执行 | 同上 | 这些名字不得以裸引用出现 |
| G3 | `engines: ">=18"` 但需要 `node:sqlite` | 同上 | `engines.node` 可解析且 major ≥22，minor ≥15 |

**G3 的口径已修正**：这一版自身也踩过同一个坑 —— 迁移完 store 层后
`engines` 曾写 `>=20.11`（理由是"本重写不用 `node:sqlite`"，**但实际用了**），
被 G3 这条回归测试抓住。现在 `package.json` 是 `>=22.15.0`，CI 保留一个
专门的 `22.15` job。实测依据：

```text
22.5 / 22.9 / 22.12 -> node:sqlite 不存在（ERR_UNKNOWN_BUILTIN_MODULE）
22.15               -> 有 node:sqlite，无 FTS5（store 降级成 LIKE 检索）
22.18+              -> 有 FTS5
```

**G1 的实证**（真实 ESM 文件，不是 `node -e` 那种注入全局 `fs` 的环境）：

```
$ node prove.mjs
realpath resolved? => /tmp/symtest/real/skills/link    # 未被解析
```

注意 `node -e` 里有全局 `fs`，所以用 `node -e` 复现会"看起来正常" —— 这也是原项目没发现它的原因之一。

---

## H. 测试有效性（变异测试）

测试全绿不代表测试有用。注入原 bug 验证（**人工执行，不在 CI 自动化**）：

| 注入的变异 | 期望 | 实测 |
|---|---|---|
| 删除某 src 文件的 `import fs` | 类型检查失败 + 测试失败 | typecheck 13 错、测试 28 失败 ✅ |
| 删除 `text.ts` 里真正的 `skipIfMarked` 守卫 | 至少 1 个测试失败 | 1 失败 ✅ |
| 把 `desktop-shell` 指向错误文件 | 目标解析测试失败 | 被 target 测试抓住 ✅ |

> 这一组**没有**写成 CI 断言：没有任何测试会在你改动实现时自动做变异。
> 它是"曾经做过一次"的记录，不是持续保证。

---

## I. CLI

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| I1 | `--help` 正常 | `node dist/cli/index.js --help` | 退出 0，打印用法 | ✅ |
| I2 | `hosts` 能发现宿主 | `node dist/cli/index.js hosts` | 列出真实桌面宿主 | ✅ (2 条) |
| I3 | `drift` 只读 | `drift` | 不写任何文件 | ✅ |
| I4 | `drift --json` 可被脚本消费 | 同上 | 合法 JSON | ✅ |
| I5 | `--dry-run` 不落盘 | `apply --dry-run` | `filesChanged: 0` | ✅ |
| I6 | 退出码语义 | `drift`(0/1) / 用法错(2) | 符合 | ✅ |
| I7 | 未知命令/参数 → 2 | `dsh-unbound bogus` | 退出 2 | ✅ |

**I2/I5/I7 本次实测**：

```text
$ node dist/cli/index.js hosts
desktop  .../app/dsh/node_modules/@deepseek-ai   (via desktop:DeepSeek Harness.app)
desktop  .../app/node_modules/@deepseek-ai       (via desktop:DeepSeek Harness.app)

$ node dist/cli/index.js apply --dry-run --verbose
(dry-run: 没有写任何文件)
total 86 | applied 0 | already 73 | pattern_not_found 1 | missing 1 | skipped 11 | failed 0
files changed: 0

$ node dist/cli/index.js bogus   # exit=2
unknown command: bogus
```

---

## J. 构建与打包

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| J1 | 构建产出 `dist/` | `npm run build` | 退出 0 | ✅ |
| J2 | 有 `.d.ts` 与 `declarationMap` | `ls dist/**/*.d.ts` | 存在 | ✅ |
| J3 | `package.json` exports 指向真实文件 | 检查 4 个 export 路径 | 都存在 | ✅ |
| J4 | 产物不引用测试框架模块 | `regressions.test.ts` 扫 `dist/` | 无 `node:test` / `node:test/reporters` | ✅ |
| J5 | 从零状态 `npm test` 可跑 | `npm run build:test && npm test` | **4,007 pass** | ✅ |

**J5 实测**（本次真的删了 `dist-test/` 重建）：

```text
# tests 4007
# suites 681
# pass 4007
# fail 0
# skipped 0
```

**J4 需要修正上一版的措辞**：criteria 里原本写"无 `node:sqlite`"，
与实际不符 —— `dist/redteam/store/schema.js` 与 `dist/redteam/store/sqlite.js`
**确实**引用 `node:sqlite`，而这是允许的（`engines` 已声明 ≥22.15）。
测试实际禁止的只有测试框架模块。`dist/` 里出现的 `node:test` 字样全在注释中，
不在 import 里。

**J1 补充**：`npm run build` 只做 `tsc` + `chmod +x`，**没有打包器**
（`devDependencies` 只有 `@types/node` 和 `typescript`）。产物包含
`dist/redteam/**` 72 个文件。`exports` 现声明 `.`、`./client`、`./engine`、
`./patches`、`./package.json` —— 控制台产物可按包名导入，但 **`./plugin`
仍不可**（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。

---

## K. CI 门禁

`.github/workflows/ci.yml` 三道门（`verify` / `min-node` / `coverage`）：

1. `npm run typecheck` — 全严格类型检查
2. `npm run verify:patches` — 补丁表完整性
3. `npm test` — 4,007 测试
4. `npm run build` + CLI 冒烟

矩阵：Node `22.15` / `22.x` / `24.x`。另有独立的 `min-node` job（钉死 22.15）
与 `coverage` job（**只跑不设阈值**）。

---

## L. 红队五层（本版新增的验收组）

这五层上一版被写成"不在范围"，实际已全部迁移完成并有测试。
数字均为本次实测（`find … -exec cat {} + | wc -l`）。

| 层 | 源码 | 文件 | 行数 | 测试文件 | 用例 |
|---|---|---:|---:|---:|---:|
| store（SQLite 事实库） | `src/redteam/store` | 15 | 10,636 | 4 | 131 |
| tools（56 个宿主工具） | `src/redteam/tools` | 11 | 4,238 | 9 | 286 |
| ui（bridge/gateway/tabs/console） | `src/redteam/ui` | 14 | 5,450 | — | — |
| client（浏览器渲染层） | `src/redteam/client` | 36 | 16,213 | 34 | 2,228 |
| service（服务端聚合入口） | `src/redteam/service.ts` | 1 | 1,307 | 1 | 56 |
| **合计** | | **77** | **37,844** | **48** | **2,701** |

能力有验收、可复现的部分：

| # | 验收项 | 命令/判据 | 状态 |
|---|---|---|---|
| L1 | store 表结构完整 | `TABLE_NAMES.length === 23` | ✅ |
| L2 | op 词汇表覆盖 | `OP_NAMES.length === 80`（store 71 + gateway 9） | ✅ |
| L3 | 工具清单完整 | `ALL_TOOL_NAMES.length === 56` | ✅ |
| L4 | bridge 端到端可跑（真 HTTP） | `serveRequest` + `http.createServer` | ✅ |
| L5 | 未知 op 分类正确 | `400 {"code":"unknown_op"}` | ✅ |
| L6 | 缺 op 分类正确 | `400 {"code":"missing_op"}` | ✅ |
| L7 | FTS5 缺席时降级而非崩溃 | 探测 + `LIKE` 回退，两路径都有测试 | ✅ |
| L8 | 服务端有 Cordis 契约 | `service.ts` 导出 `name="dsh-unbound-service"` / `inject=[]` / `apply` | ✅ |
| L9 | 路由注册 + 卸载后撤销 | 真 cordis 内核：挂 1 路由 → HTTP 200 → 卸载后 0 路由、服务注销 | ✅ |
| L10 | CSRF：回环 socket 上的外部 Origin 被拒 | `checkOrigin()` 返回 `"cross-origin"`；`test/ui/origin.test.ts` 3 处断言 | ✅ |
| L11 | 页签数据接线 | `console.ts` → `tab-data.ts` → `tabs-a`(6) + `tabs-b`(6) | ✅ |
| L12 | 插件清单完整 | `dsh.bundle.patch` + `dsh.client` + `exports["./client"]` + `exports["./service"]` | ✅ |

**L4–L6 实测**（起真 HTTP server，store 用真实 `RedteamStore`）：

```text
POST {"op":"bootstrap"} -> 200 {"ok":true,"root":"/tmp/...","engagements":[],"current":null}
POST {"op":"version"}   -> 200 {"ok":true,"plugin":{...},"updateAvailable":false,...}
POST {"op":"nope"}      -> 400 {"ok":false,"error":"unknown op: nope","code":"unknown_op"}
POST {}                 -> 400 {"ok":false,"error":"missing op","code":"missing_op"}
```

**仍然存在的缺口**（如实标注，不影响控制台可用）：

| 缺口 | 证据 |
|---|---|
| 56 个工具仍未注册 | `src/redteam/tools/index.ts::registerTools(ctx, store)` 无人调用；`src/plugin/index.ts` 用的是自己的同名函数（只注册 3 个 `qilin_*`）。工具层代码与测试齐备，缺最后一个 `ctx.tools.register` 循环 |
| `src/plugin/**` 不 import `src/redteam/**` | **有意如此**：Cordis 半侧与服务端是 `cordis.patch.yml` 里两个独立入口，headless 面因此不会在加载时拉进 `node:sqlite` |

**接线前曾经断掉的 7 处**（历史记录，现已全部补齐）：`dsh.client` 缺失、
`cordis.patch.yml` 缺失、store 无 Cordis 入口、无 `/redteam/api` 路由、
`exports` 无 service 子路径、`insert` 只 1 行、无页签数据接线。
逐项判据见 `WORKSTREAMS.md` 的「历史记录」表。

另外两处 `ops.ts` 注释与代码不符（注释写 81 / 72，实测 80 / 71）：
`src/redteam/ui/ops.ts` 自己的说明文字是过期的，以 `OP_NAMES.length` 为准。
本文件不改代码，仅记录。

---

## 汇总

| 组 | 项数 | 全绿 |
|---|---|---|
| A 类型 | 4 | ✅ |
| B 补丁表 | 7 | ✅ |
| C 行为等价 | 4 | ✅（需上游检出，否则 skip） |
| D 隐式语义 | 7 | ✅ |
| E 引擎 | 15 | ✅ |
| F 漂移检测 | 8 | ✅ |
| G 原 bug 回归 | 3 | ✅ |
| H 变异测试 | 3 | ✅（人工执行） |
| I CLI | 7 | ✅ |
| J 构建 | 5 | ✅ |
| K CI | 3 job / 4 门 | ✅ |
| L 红队五层 + 接线 | 12 | ✅（56 工具未注册，见缺口表） |
| **合计** | **78 项 + 3 个 CI job** | **全部通过** |

> 上一版写的是 **67 项**。差额来自 A4 计数更新、L 组由 7 项扩到 12 项
> （红队四层此前被错写成"不在范围"，没有验收项；本轮补入接线与 CSRF 四项）。

**测试总量（本次实测，Node v22.22.1）**：

```text
# tests 4007
# suites 681
# pass 4007
# fail 0
# skipped 0
```

分布（各层相加正好等于 4,007）：

| 来源 | 用例 |
|---|---:|
| `test/*.test.ts`（引擎/补丁/回归，7 文件） | 135 |
| `test/plugin`（7 文件） | 480 |
| `test/platform`（10 文件） | 477 |
| `test/features`（3 文件） | 100 |
| `test/store`（4 文件） | 131 |
| `test/tools`（9 文件） | 286 |
| `test/redteam`（1 文件，service 模块） | 56 |
| `test/ui`（34 文件，含 client 与 bridge 层） | 2,228 |
| `test/integration`（7 文件） | 114 |
| **合计** | **4,007** |

---

## 明确不在本版范围（不装作做了）

| 未做 | 证据 / 原因 |
|---|---|
| 56 个工具**注册到宿主** | `src/redteam/tools/index.ts::registerTools(ctx, store)` 无人调用；`src/plugin/index.ts` 用的是自己的同名函数（3 个 `qilin_*`）。工具代码与 286 用例齐备，缺最后一个注册循环 |
| `platformConfigGet` 等 3 个 op 的**嵌套形状** | 服务端返回 `{ok, platform:{...}}`，`env-model.ts` 按扁平读。现有垫层 `flattenPlatform()`（`tabs-a.ts`）+ `KNOWN_SHAPE_GAPS` 常量标注「这是垫层不是设计」 |
| `agents` 页签的**渲染槽位** | `TabRegistryProps` 无 `agents` 字段、无 `client/agents-tab.ts`、`tab-registry.ts` 的 `case "agents"` 无条件 `empty()`。后端 `agentsStatus` op 是齐的，纯前端缺口（`AGENTS_NOT_WIRED_REASON`） |
| 桌面 asar 解包 / 自动重打包 | `src/platform/desktop-paths.ts` 只做**路径判定**；`src/plugin/settle-policy.ts` 只做"密封 asar 不就地打"的拒绝；`grep -rn 'extractAsar' src/` 为空 |
| 更新通道执行（下载/替换） | `updateCheck` / `updateApply` 有类型化实现与测试，但下载、替换、重启的实现不在本仓库 |
| 随包技能目录 | `skill-availability.ts` 找 `<pkg>/skills/redteam`，但仓库无 `skills/`，`package.json` `files` 也不含 |
| 把 12 条 `absent` 补丁"修好" | 目标代码上游已删除，**凭空猜路径会制造假告警** |
| `src/features/*` 与 4 个 platform 模块的调用方 | `continue-retry` / `rewind` / `uninstall` / `desktop-paths` / `net-scope` / `net-tables` / `version` 均为纯逻辑且已测，但**无生产代码调用** |
