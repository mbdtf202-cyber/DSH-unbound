/**
 * 插件级设置（零依赖）：目前只有一项 —— **并发执行智能体上限**。
 *
 * 迁移自 `dsh-qilin/lib/redteam/settings.js`。
 *
 * ## 为什么不用环境变量
 *
 * `REDTEAM_MAX_AGENTS` 只能启动前设，改完得重启 dsh web；
 * 而"同时派几个执行智能体"是使用中最常调的一项，面板上应该能直接改。
 * 所以落一份 JSON 到事实库根目录：`$DSH_HOME/redteam/settings.json`。
 *
 * ## 生效顺序
 *
 * settings.json → 环境变量 `REDTEAM_MAX_AGENTS` → 默认 3。
 * 工具侧（`redteam_agent_slot` 闸门）与面板侧（「智能体」页）读的是同一份，
 * 避免两处口径漂移。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 默认并发上限（用户口径：整个项目默认 3 个执行智能体）。 */
export const DEFAULT_MAX_AGENTS = 3;

/** 硬上限：再多也不会更快 —— 同一个 API Key 的并发/速率限制会先到，反而扰动测试。 */
export const MAX_AGENTS_LIMIT = 10;

/** 设置项的来源。 */
export type MaxAgentsSource = "settings" | "env" | "default";

/** 设置文件的形状。未知键保留（前向兼容），所以带索引签名。 */
export interface RedteamSettings {
  readonly maxAgents?: number;
  readonly [key: string]: unknown;
}

/** 设置文件路径（跟事实库同一个根，随事实库一起备份/迁移）。 */
export function settingsPathOf(root: unknown): string {
  return join(String(root || "."), "settings.json");
}

/**
 * 读全部设置（读不到 / 坏了都当空对象，**绝不抛**）。
 *
 * 设置文件坏掉不该让整个插件起不来：并发上限有默认值，坏文件等价于"没设置过"。
 * 数组与 `null` 也不算设置对象。
 */
export function readSettings(root: unknown): RedteamSettings {
  try {
    const file = settingsPathOf(root);
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as RedteamSettings;
  } catch {
    return {};
  }
}

/**
 * 合并写入若干项设置，返回写入后的完整设置。
 *
 * 浅合并：设置项都是标量，嵌套合并只会让"清空某一项"变得没有表达方式。
 */
export function writeSettings(root: unknown, patch: Readonly<Record<string, unknown>>): RedteamSettings {
  const next: Record<string, unknown> = { ...readSettings(root), ...patch };
  const dir = String(root || ".");
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPathOf(root), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/**
 * 把任意输入收敛到 `[1, MAX_AGENTS_LIMIT]` 的整数。
 *
 * 非有限数（`NaN` / `Infinity` / 非数字字符串）退回默认值 3；
 * 小数向下取整 —— 「2.9 个智能体」只能是 2 个。
 */
export function clampMaxAgents(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS;
  return Math.min(Math.max(n, 1), MAX_AGENTS_LIMIT);
}

/** 从设置文件里取一个"有效正数"，没有就返回 `null`。 */
function positiveFromFile(root: unknown): number | null {
  const fromFile = Number(readSettings(root).maxAgents);
  return Number.isFinite(fromFile) && fromFile > 0 ? fromFile : null;
}

/** 从环境变量里取一个"有效正数"，没有就返回 `null`。 */
function positiveFromEnv(env: Readonly<Record<string, string | undefined>>): number | null {
  const fromEnv = Number(env["REDTEAM_MAX_AGENTS"]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

/**
 * 当前生效的并发上限。
 *
 * @param root 事实库根目录（`ctx.redteam.root`）。
 * @param env 环境变量表（便于测试注入）。
 */
export function maxAgentsOf(root: unknown, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const fromFile = positiveFromFile(root);
  if (fromFile !== null) return clampMaxAgents(fromFile);
  const fromEnv = positiveFromEnv(env);
  if (fromEnv !== null) return clampMaxAgents(fromEnv);
  return DEFAULT_MAX_AGENTS;
}

/** 保存并发上限，返回实际生效值（已被 clamp 过，不是用户原值）。 */
export function saveMaxAgents(root: unknown, value: unknown): number {
  const applied = clampMaxAgents(value);
  writeSettings(root, { maxAgents: applied });
  return applied;
}

/**
 * 当前设置是从哪来的（面板上要如实说明，避免"我改了没生效"的错觉）。
 *
 * 判定顺序与 {@link maxAgentsOf} 必须一致，否则面板会显示"来自 settings"
 * 但实际生效的是环境变量。
 */
export function maxAgentsSourceOf(
  root: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MaxAgentsSource {
  if (positiveFromFile(root) !== null) return "settings";
  if (positiveFromEnv(env) !== null) return "env";
  return "default";
}
