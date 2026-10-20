/**
 * 领域常量与枚举。
 *
 * 迁移自 dsh-qilin `store-core.js:76-108`。这些数组同时是**写库前的白名单**：
 * `addVuln` 用 `SEVERITIES.includes(v.severity)` 决定落库值，非法值静默回落到
 * `'info'`；`updateAssetTest` 同理回落到原状态。所以数组的顺序与成员不能动 ——
 * 顺序即展示优先级（严重级按 critical→info）。
 */
import type { Priority, Severity, TestStatus, VulnStatus } from "./types.js";

/**
 * 作战角色（六个）。角色 code 同时用于：
 *   · 角色提示词文件 `engagements/<靶标>/agents/<code>.md`；
 *   · 攻击步骤/漏洞/凭据上的 `agent` 列（报告要写清"这条是谁做的"）；
 *   · 主会话派活时的角色选择。
 * `plan` 是主会话（指挥）自己，不派出去，只用于提示词面板里查看/微调人设。
 */
export const ROLE_TITLES: Readonly<Record<string, string>> = {
  plan: "主会话（指挥）",
  recon: "信息收集",
  assess: "资产梳理",
  "vuln-scan": "漏洞发现",
  exploit: "漏洞利用",
  internal: "内网渗透",
};

/** 角色清单（工具、面板、提示词刷新脚本共用）：顺序即推荐执行顺序。 */
export const ROLE_ORDER: readonly string[] = ["recon", "assess", "vuln-scan", "exploit", "internal"];

/** 主会话（指挥）角色 code。 */
export const PLANNER_ROLE = "plan";

/** 漏洞严重级（按展示优先级排列）。 */
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

/** 漏洞处置状态。 */
export const VULN_STATUSES: readonly VulnStatus[] = ["candidate", "confirmed", "false-positive", "exploited", "fixed"];

/** POC 类型：poc=验证性利用、exp=可执行利用、template=nuclei 等模板、script=辅助脚本、payload=载荷。 */
export const POC_KINDS: readonly string[] = ["poc", "exp", "script", "template", "payload"];

/** 来源：web=互联网扒的、self=智能体手搓、manual=人写的、nuclei-template=模板库。 */
export const POC_SOURCES: readonly string[] = ["web", "self", "manual", "nuclei-template", "kb"];

/** 资产测试状态白名单（写入前校验，非法值回落到原值）。 */
export const VALID_TEST_STATUSES: readonly TestStatus[] = ["untested", "testing", "tested", "blocked", "abandoned", "no_surface"];

/** 资产易打性优先级白名单。 */
export const VALID_PRIORITIES: readonly Priority[] = ["high", "medium", "low"];

/** 隧道状态白名单（新增与更新两条路径共用，避免更新路径绕过校验）。 */
export const TUNNEL_STATUSES: readonly string[] = ["active", "down", "closed", "unknown"];

/** 攻击文件类型白名单（非法值回落 `script`）。 */
export const ATTACK_FILE_KINDS: readonly string[] = ["poc", "exp", "script", "wordlist", "other"];
