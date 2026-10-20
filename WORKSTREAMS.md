# 全量重写工作流（772h 分解）

目标：把 dsh-qilin 剩余 ~28,400 行迁到 DSH-unbound 的严格 TS。

## 写入域纪律

每个工作流**只**改自己目录，避免并行冲突：

| 工作流 | 独占写入域 | 上游依赖 |
|---|---|---|
| W1 存储层 | `src/redteam/store/**`, `test/store/**` | host-api, shared |
| W2 工具层 | `src/redteam/tools/**`, `test/tools/**` | store 的**类型**（不读实现） |
| W3 控制台 | `src/redteam/ui/**`, `src/redteam/client/**`, `test/ui/**` | store 类型 |
| W4 插件层 | `src/plugin/**`, `src/index.ts`, `test/plugin/**` | host-api |
| W5 平台层 | `src/platform/**`, `src/features/**`, `test/platform/**` | host-api |

**共享只读**（已由 Lead 建立，改它要先说）：`src/host-api/**`, `src/shared/**`,
`src/engine/**`, `src/patches/**`, `src/fs/**`, `src/host/**`, `tsconfig*.json`。

## 关键约定

1. `@deepseek-ai/*` **没有 .d.ts**。一切宿主交互走 `src/host-api` 的
   `HostContext`；不要新建 `any`。
2. 未类型化输入用 `unknown` + 窄化，不用 `any`。
3. 预期内失败用 `Result`（`src/shared/result.ts`），编程错误才 throw。
4. 每个模块必须带测试。目标：每个工作流 ≥30 用例。
5. 迁移时**先读原实现**，用行为等价性测试锁住，再重构。不许凭印象重写。
