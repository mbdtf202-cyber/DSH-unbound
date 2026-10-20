/**
 * 能力选用协议：先读 skill / MCP 目录，再按当前任务选用。
 * 不改官方 skill 注册、不改 MCP 挂载、不 deny 任何工具。
 * 官方 DSH 已写工具用法，这里不另挂 Host tools 纪律。
 */

/**
 * 能力协议段的段名。
 *
 * ## 为什么不带 `dsh-qilin` 前缀
 *
 * 宿主 `renderPrompt` 内部有一步
 * `filter(s => s.name.startsWith("dsh-qilin"))`，把这类段**按插入序挪到最前**。
 * 旧名 `dsh-qilin:capabilities` 命中前缀，结果 cap 跑到 inject 前头（dump line 1），
 * 反而制造出「cap 在前、inject 在后」的渲染反转。换成 `dshql-` 绕开这一步过滤。
 *
 * 这一条是「看起来无害的命名」直接导致线上行为反了——测试里钉死。
 */
export const CAPABILITY_SECTION = "dshql-capabilities";

/** 官方通用协议。 */
const OFFICIAL_PROTOCOL = `## Capability selection by task (mandatory)

1. **Read first**: Inspect \`<available_skills>\` / the skill catalog and the installed MCP / host tools for this session. Know what exists before acting.
2. **Match the task**: From that catalog, pick the skill(s) and MCP/CLI tool(s) that fit *this* user task — not “always use something”, not “never use something”.
3. **Call what matches**:
   - Matching **Skill** → load it with the host \`skill\` tool, then follow it (methods, premises, branches, counter-evidence).
   - Matching **MCP / CLI** → call that tool with real schema and context; treat failures by the tool’s semantics.
4. **Only then DIY**: If nothing in the catalog fits the task, use shell / ad-hoc steps and say what was missing.
5. **Subagents / sub-delegates inherit this rule**: Any \`subagent\`, teammate, or child agent you start must also read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief when you dispatch.
6. Host skills and MCP stay available; this prompt does not remove them.`;

/** 红队主代理协议：多一段「派活」纪律。 */
const REDTEAM_LEAD_PROTOCOL = `## Capability selection by task (redteam lead)

1. You plan, dispatch with \`subagent\`, verify results, and report. Executors do hands-on work.
2. Before dispatch, know which skills/MCP fit the next stage (from \`<available_skills>\` / redteam skills / session MCP).
3. In every \`subagent\` brief: require the child to **read the skill/MCP catalog, then call only what the assigned task needs** (name concrete skill codes when you know them).
4. Do not ban skill or MCP for children. Leaf limits apply only to further delegation tools (\`subagent_fork\` / workflow / ralph), not to skill/MCP.
5. Vague “go investigate” briefs are wrong; task-matched skill/MCP instructions are right.`;

export interface CapabilityProtocolOptions {
  /** 主会话是不是红队预设。 */
  readonly redteam?: boolean;
  /** 是不是红队的子智能体。 */
  readonly redteamChild?: boolean;
  /** `false` 时整段不注入。 */
  readonly enabled?: boolean;
}

/**
 * 选协议文本。
 *
 * 子智能体 / 子代理跟主会话同一条：读目录 → 按任务调 skill/MCP。
 * 红队 extras（角色 / 调度）另段挂上，这里不再换成另一套流程。
 */
export function capabilityProtocolText(opts: CapabilityProtocolOptions = {}): string {
  if (opts.enabled === false) return "";
  if (opts.redteamChild === true) return OFFICIAL_PROTOCOL;
  if (opts.redteam === true) return REDTEAM_LEAD_PROTOCOL;
  return OFFICIAL_PROTOCOL;
}

/** 测试与调试用：拿到三份协议原文，不改可见 API。 */
export const PROTOCOL_TEXTS = {
  official: OFFICIAL_PROTOCOL,
  redteamLead: REDTEAM_LEAD_PROTOCOL,
} as const;
