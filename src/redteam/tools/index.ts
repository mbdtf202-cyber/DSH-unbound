/**
 * 全部红队工具的统一注册入口。
 *
 * ## 56 个工具的分布
 *
 * | 文件 | 工具数 |
 * |---|---|
 * | `session-tools.ts` | 7 |
 * | `asset-tools.ts` | 11 |
 * | `finding-tools.ts` | 10 |
 * | `tunnel-tools.ts` | 9 |
 * | `score-tools.ts` | 12 |
 * | `knowledge-tools.ts` | 7 |
 * | **合计** | **56** |
 *
 * ## 注册流程
 *
 * 每个工具都过两道：`defineTool`（类型化）→ `withStructuredErrors`（异常收敛）
 * → `toHostTool`（转成宿主形状）→ `ctx.tools.register`。
 *
 * 顺序不能反：`withStructuredErrors` 必须在 `toHostTool` 之前，
 * 否则被包装的是宿主层的 `execute`，而它的参数已经被放宽成
 * `Record<string, unknown>`，拿不到工具内部的类型。
 */

import type { HostContext } from "../../host-api/types.js";
import { assetTools } from "./asset-tools.js";
import { withStructuredErrors } from "./define.js";
import type { AnyTypedTool } from "./define.js";
import { findingTools } from "./finding-tools.js";
import { knowledgeTools } from "./knowledge-tools.js";
import { scoreTools } from "./score-tools.js";
import { sessionTools } from "./session-tools.js";
import type { ToolRuntimeContext } from "./session-tools.js";
import { tunnelTools } from "./tunnel-tools.js";
import { toHostTool } from "./define.js";
import type { StoreForTools } from "./store-contract.js";

export { ASSET_TOOL_NAMES } from "./asset-tools.js";
export { FINDING_TOOL_NAMES } from "./finding-tools.js";
export { KNOWLEDGE_TOOL_NAMES } from "./knowledge-tools.js";
export { SCORE_TOOL_NAMES } from "./score-tools.js";
export { SESSION_TOOL_NAMES } from "./session-tools.js";
export { TUNNEL_TOOL_NAMES } from "./tunnel-tools.js";

import { ASSET_TOOL_NAMES } from "./asset-tools.js";
import { FINDING_TOOL_NAMES } from "./finding-tools.js";
import { KNOWLEDGE_TOOL_NAMES } from "./knowledge-tools.js";
import { SCORE_TOOL_NAMES } from "./score-tools.js";
import { SESSION_TOOL_NAMES } from "./session-tools.js";
import { TUNNEL_TOOL_NAMES } from "./tunnel-tools.js";

/**
 * 全部 56 个工具名（按注册顺序）。
 *
 * 这个常量是**规格**：测试用它比对实际构造出的工具集合，
 * 少一个多一个都会红。
 */
export const ALL_TOOL_NAMES = [
  ...SESSION_TOOL_NAMES,
  ...ASSET_TOOL_NAMES,
  ...FINDING_TOOL_NAMES,
  ...TUNNEL_TOOL_NAMES,
  ...SCORE_TOOL_NAMES,
  ...KNOWLEDGE_TOOL_NAMES,
] as const;

/** 构造全部工具（不注册，便于测试）。 */
export function buildAllTools(store: StoreForTools, ctx: ToolRuntimeContext): readonly AnyTypedTool[] {
  return [
    ...sessionTools(store, ctx),
    ...assetTools(store, ctx),
    ...findingTools(store, ctx),
    ...tunnelTools(store, ctx),
    ...scoreTools(store, ctx),
    ...knowledgeTools(store, ctx),
  ];
}

/**
 * 把 `ctx.get` 包成安全的服务读取器。
 *
 * 宿主在服务未就绪时会抛（`get` 内部取 fiber），所以必须 try/catch ——
 * 而这一层薄包装让工具层不必重复写 try/catch。
 */
function safeServiceGetter(ctx: HostContext): ((name: string) => unknown) | undefined {
  if (typeof ctx.get !== "function") return undefined;
  return (name: string): unknown => {
    try {
      return ctx.get?.(name);
    } catch {
      return null;
    }
  };
}

/**
 * 注册全部 56 个工具到宿主。
 *
 * @param ctx 宿主上下文（需要 `ctx.tools`）。
 * @param store 靶标库。
 * @param options 环境变量与数据根（便于测试注入）。
 * @returns 实际注册成功的工具名（按顺序）。
 */
export function registerTools(
  ctx: HostContext,
  store: StoreForTools,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly root?: string | undefined;
  } = {},
): readonly string[] {
  const registry = ctx.tools;
  if (registry === undefined || typeof registry.register !== "function") {
    throw new Error("registerTools: 宿主没有提供 ctx.tools.register");
  }
  const runtime: ToolRuntimeContext = {
    getService: safeServiceGetter(ctx),
    env: options.env,
    root: options.root,
  };
  const registered: string[] = [];
  for (const tool of buildAllTools(store, runtime)) {
    const guarded = withStructuredErrors(tool);
    registry.register(toHostTool(guarded) as Parameters<typeof registry.register>[0]);
    registered.push(tool.name);
  }
  return registered;
}
