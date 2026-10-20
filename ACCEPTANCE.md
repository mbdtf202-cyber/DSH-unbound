# 验收矩阵 — v0.0.1

每条都是**可重复执行的命令 + 明确判据**，不是"已完成"的声明。
`脚本列`里的命令都能在本仓库根目录直接跑。

---

## A. 类型正确性

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| A1 | 全严格档类型检查通过 | `npm run typecheck` | 退出码 0，`error TS` 计数 = 0 | ✅ |
| A2 | 类型检查真的在检查（非空转） | 往 `src/` 放一个 `const n: number = "x"` | `tsc` 报 ≥1 个错误 | ✅ |
| A3 | 覆盖的严格开关 | 检查 `tsconfig.json` | 含 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitReturns`、`useUnknownInCatchVariables` | ✅ |
| A4 | 被检查的文件数 | `npx tsc -p tsconfig.json --noEmit --listFiles \| grep -c src/` | ≥ 11 | ✅ (11) |

**A2 实测**：注入 `const n: number = "definitely not a number"` → `1 error`，删除后 `0 error`。证明 tsc 确实在处理这些文件。

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

**B1 具体数字**：literal patterns 210、regex patterns 5、with markers 79、skipIfMarked 38、optional 48。

---

## C. 行为等价性（最硬的验收）

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| C1 | 新旧引擎输出逐字节一致 | `npm test`（`test/equivalence.test.ts`） | 对比 ≥20 对，`diffs` 为空 | ✅ (100 对, 0 差异) |
| C2 | 等价性在**真实宿主源码**上成立 | 同上 | 用原引擎的 `targetFiles()` 解析出的真实路径 | ✅ |
| C3 | 连跑三次不再变化（防膨胀） | 同上 | `thrice === twice` | ✅ |
| C4 | 样本量足够 | 同上 | `compared > 20` 断言 | ✅ |

**C1 独立复核**（不依赖测试框架的一次性脚本）：

```
compared (patch,file) pairs: 100
  byte-identical: 100
  DIFFERED:       0
```

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

**F6 为什么重要**：补丁 `#21` 的 pattern 只匹配 `timeoutMs: 600000 # [dsh-qilin] bash timeout raised`，那是**上一次应用之后才存在**的文本。在干净宿主上它必然 0 命中。若判 `dead`，`drift` 会在健康宿主上永远退出 1，告警立刻失去意义。实测修好后：

```
patches 86 | ... | dead 0 | absent 12 | pending-upgrade 1
broken: 0  ✓
```

---

## G. 原项目 3 个真 bug 的回归防护

| # | bug | 回归测试 | 判据 |
|---|---|---|---|
| G1 | `skills.js` 用了 `fs` 却没 import，`catch` 吞掉 ReferenceError → symlink 守卫空转 | `regressions.test.ts` 静态扫描 | `src/` 下任何 `fs.` 必须有 `fs` import |
| G2 | `schema.js` 的 `LEGACY_STAGE_MAP` / `SCOPE_SQL` 未定义，两段迁移永不执行 | 同上 | 这些名字不得以裸引用出现 |
| G3 | `engines: ">=18"` 但需要 `node:sqlite`（≥22.5） | 同上 | `engines.node` 可解析且 major ≥20 |

**G1 的实证**（真实 ESM 文件，不是 `node -e` 那种注入全局 `fs` 的环境）：

```
$ node prove.mjs
realpath resolved? => /tmp/symtest/real/skills/link    # 未被解析
```

注意 `node -e` 里有全局 `fs`，所以用 `node -e` 复现会"看起来正常" —— 这也是原项目没发现它的原因之一。

---

## H. 测试有效性（变异测试）

测试全绿不代表测试有用。注入原 bug 验证：

| 注入的变异 | 期望 | 实测 |
|---|---|---|
| 删除某 src 文件的 `import fs` | 类型检查失败 + 测试失败 | typecheck 13 错、测试 28 失败 ✅ |
| 删除 `text.ts` 里真正的 `skipIfMarked` 守卫 | 至少 1 个测试失败 | 1 失败 ✅ |
| 把 `desktop-shell` 指向错误文件 | 目标解析测试失败 | 被 target 测试抓住 ✅ |

---

## I. CLI

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| I1 | `--help` 正常 | `node dist/cli/index.js --help` | 退出 0，打印用法 | ✅ |
| I2 | `hosts` 能发现宿主 | `node dist/cli/index.js hosts` | 列出真实桌面宿主 | ✅ |
| I3 | `drift` 只读 | `drift` | 不写任何文件 | ✅ |
| I4 | `drift --json` 可被脚本消费 | 同上 | 合法 JSON | ✅ |
| I5 | `--dry-run` 不落盘 | `apply --dry-run` | `filesChanged: 0` | ✅ |
| I6 | 退出码语义 | `drift`(0/1) / 用法错(2) | 符合 | ✅ |
| I7 | 未知命令/参数 → 2 | `dsh-unbound bogus` | 退出 2 | ✅ |

---

## J. 构建与打包

| # | 验收项 | 命令 | 判据 | 状态 |
|---|---|---|---|---|
| J1 | 构建产出 `dist/` | `npm run build` | 退出 0 | ✅ |
| J2 | 有 `.d.ts` 与 `declarationMap` | `ls dist/**/*.d.ts` | 存在 | ✅ |
| J3 | `package.json` exports 指向真实文件 | 检查 4 个 export 路径 | 都存在 | ✅ |
| J4 | 产物不引用实验性模块 | `regressions.test.ts` 扫 `dist/` | 无 `node:sqlite` / `node:test` | ✅ |
| J5 | 从零状态 `npm test` 可跑 | `rm -rf dist-test && npm test` | 131 pass | ✅ |

---

## K. CI 门禁

`.github/workflows/ci.yml` 四道门，任一失败即红：

1. `npm run typecheck` — 全严格类型检查
2. `npm run verify:patches` — 补丁表完整性
3. `npm test` — 130+ 测试
4. `npm run build` + CLI 冒烟

矩阵：Node `20.11` / `22.x` / `24.x`。另有 `coverage` job。

---

## 汇总

| 组 | 项数 | 全绿 |
|---|---|---|
| A 类型 | 4 | ✅ |
| B 补丁表 | 7 | ✅ |
| C 行为等价 | 4 | ✅ |
| D 隐式语义 | 7 | ✅ |
| E 引擎 | 15 | ✅ |
| F 漂移检测 | 8 | ✅ |
| G 原 bug 回归 | 3 | ✅ |
| H 变异测试 | 3 | ✅ |
| I CLI | 7 | ✅ |
| J 构建 | 5 | ✅ |
| K CI | 4 门 | ✅ |
| **合计** | **67 项** | **全部通过** |

测试总量：**131 tests / 34 suites / 0 failures**。

---

## 明确不在 v0.0.1 范围（不装作做了）

| 未做 | 原因 |
|---|---|
| Cordis 插件注册、prompt-inject 注入 | 属于 `dsh-qilin`，本次只重写补丁引擎 |
| 红队控制台 / SQLite 事实库 | 同上，且它正是 `node:sqlite` 版本坑的来源 |
| 桌面 asar 解包、自动重启 | 需要平台专属路径处理，值得单独设计 |
| 更新通道（codeload/git/zip） | 同上 |
| 把 12 条 `absent` 补丁"修好" | 目标代码上游已删除，**凭空猜路径会制造假告警** |
