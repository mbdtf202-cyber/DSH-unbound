/**
 * 会话 / 靶标 / 闸门 组工具（6 个）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 的 407–483、486–726、728–781 行。
 *
 * ## description 是**指令的一部分**
 *
 * 每个工具的 `description` 都逐字照搬原文。它们不是给人看的注释 ——
 * 模型读这段文字决定"什么时候调、怎么调、失败了要不要重试"。
 * 改一个字都可能改变模型行为，所以迁移时一个字都不改。
 *
 * ## 本组为什么先做
 *
 * 这 6 个工具依赖 `tools/context.ts` 的会话解析与靶标绑定，
 * 且 `agent_slot` 是并发闸门 —— 骨架对不对，跑通这一组就能验证。
 *
 * ## 宿主能力探测的原则
 *
 * `preflight` 要读 `ctx.get('skills')` / `ctx.get('agentPresets')`，这些服务**没有类型声明**。
 * 处理方式统一为：`unknown` + 类型守卫逐字段窄化，**不用 `as` 硬转**。
 * 服务不可用时走原实现已有的降级分支（它在桌面端本来就常常没有 skills inject）。
 */

import type { ToolExecContext } from "../../host-api/types.js";
import { PLANNER_ROLE, ROLE_ORDER, ROLE_TITLES } from "../store/constants.js";
import {
  DEFAULT_MAX_AGENTS,
  MAX_AGENTS_LIMIT,
  maxAgentsOf,
} from "../../platform/settings.js";
import { loadPlatformConfig, mergeConfigEnv, platformSummary, toolkitDirOf } from "../../platform/platform-config.js";
import {
  bundledSkillSummaries,
  checkSkill,
  expandSkillPath,
  redteamSummariesForCheck,
  summarizeSkills,
} from "../../platform/skill-availability.js";
import type { SkillSummary, SkillVerdict } from "../../platform/skill-availability.js";
import { fixesForIssue } from "../../platform/skill-fixes.js";
import { defineTool, renderText, toToolJson, withStructuredErrors } from "./define.js";
import type { AnyTypedTool, TypedToolDefinition } from "./define.js";
import {
  addReservation,
  agentOf,
  bindKeysOf,
  bindingViewOf,
  bindings,
  dropReservation,
  reservationList,
  resolveEngagement,
  splitList,
} from "./context.js";
import type { StoreForTools } from "./store-contract.js";

/** 工具可用的宿主上下文（只列本组用到的）。 */
export interface ToolRuntimeContext {
  readonly exec?: ToolExecContext | undefined;
  /** 宿主服务读取器（`ctx.get` 的包装；不可用返回 `null`）。 */
  readonly getService?: ((name: string) => unknown) | undefined;
  /** 宿主环境变量表（便于测试注入）。 */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** 数据根（`ctx.redteam.root`）。 */
  readonly root?: string | undefined;
}

/** 角色 code 的合法值说明（写进工具 description，模型不用猜）。 */
export const ROLE_HINT =
  "角色 code：" +
  ROLE_ORDER.map((r: string) => "`" + r + "`（" + (ROLE_TITLES[r] ?? r) + "）").join("、");

/** 写库工具共用的 agent 参数（角色 code 白名单提示写进 description）。 */
export const AGENT_PARAM = {
  type: "string",
  description:
    "【建议填】产出这条记录的角色 —— " +
    ROLE_HINT +
    "。报告里会按它标注\"这一步是谁做的\"，不填按主会话记账。",
} as const;

/** 会话总览里的一条预留。 */
interface LiveChildren {
  readonly available: boolean;
  readonly running: number;
  readonly running_labels?: readonly string[];
  readonly total_children?: number;
  readonly error?: string;
}

/** 从宿主 `subagents` 服务里读"真正在跑"的直接子会话数。 */
async function liveRunningChildren(ctx: ToolRuntimeContext, rootSessionId: string): Promise<LiveChildren> {
  const subagents = ctx.getService?.("subagents") ?? null;
  if (subagents === null || typeof subagents !== "object") {
    return { available: false, running: 0, error: "subagents 注册表不可用（无法核对实际并发数，只能按预留计数）" };
  }
  const rec = subagents as Record<string, unknown>;
  const listChildren = rec["listChildren"];
  if (typeof listChildren !== "function") {
    return { available: false, running: 0, error: "subagents 注册表不可用（无法核对实际并发数，只能按预留计数）" };
  }
  try {
    const entries: unknown = await (listChildren as (id: string) => unknown).call(subagents, rootSessionId);
    const rows = Array.isArray(entries) ? entries : [];
    const isChild = (e: unknown): e is Record<string, unknown> =>
      e !== null && typeof e === "object" && (e as Record<string, unknown>)["kind"] === "child";
    const children = rows.filter(isChild);
    const running = children.filter((e) => e["activity"] === "running");
    const labels = running
      .map((e) => {
        const label = e["label"];
        const id = e["id"];
        return typeof label === "string" && label !== "" ? label : typeof id === "string" ? id : "";
      })
      .filter((x) => x !== "")
      .slice(0, 20);
    return { available: true, running: running.length, running_labels: labels, total_children: children.length };
  } catch (error) {
    return {
      available: false,
      running: 0,
      error: "列子会话失败：" + (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** 本次调用用于统计并发的归属键。 */
function ownerOf(exec: ToolExecContext | null | undefined): string | undefined {
  const view = bindingViewOf(exec);
  return view.root_session ?? view.session_id ?? undefined;
}

/**
 * 构造本组的 6 个工具。
 *
 * @param store 靶标库（窄接口）。
 * @param ctx 运行上下文（宿主服务、env、root）。
 */
export function sessionTools(
  store: StoreForTools,
  ctx: ToolRuntimeContext,
): readonly AnyTypedTool[] {
  const env = ctx.env ?? process.env;

  /** 读 `$DSH_HOME/.env` 里的键名与值（用于 preflight 展示"这些变量从哪来"）。 */
  async function readEnvFile(): Promise<{ readonly path: string; readonly keys: readonly string[]; readonly values: Record<string, string> }> {
    const path = expandSkillPath("$DSH_HOME/.env", env);
    const keys: string[] = [];
    const values: Record<string, string> = {};
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      if (!existsSync(path)) return { path, keys, values };
      for (const line of readFileSync(path, "utf8").split("\n")) {
        /* 兼容 shell 习惯写法：`export KEY=value`；未加引号的行内注释（`KEY=v # 备注`）剥掉 */
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (m === null) continue;
        const key = m[1];
        const rawValue = m[2];
        if (key === undefined || rawValue === undefined) continue;
        let raw = rawValue.trim();
        if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, "");
        const value = raw.replace(/^["']|["']$/g, "").trim();
        if (value === "") continue;
        keys.push(key);
        values[key] = value;
      }
    } catch {
      /* .env 读不到不影响主流程 */
    }
    return { path, keys, values };
  }

  /* ── redteam_engagement_open ─────────────────────────────────────────── */
  const engagementOpen = defineTool({
    name: "redteam_engagement_open",
    description:
      "打开或创建一次攻防演练靶标（按单位名称），并把**当前会话**绑定到该靶标（子智能体会自动继承）。后续所有资产工具默认作用于它。若靶标已存在则复用其资产库。写入的是本会话的绑定，不会改动其它会话正在用的靶标。",
    parameters: {
      target: { type: "string", required: true, description: "靶标单位名称，例如「示例科技有限公司」" },
      scope: {
        type: "array",
        description: "授权范围 CIDR 列表（可选：用户没给就不用问，按公开可见资产面自主推进）",
        items: { type: "string" },
      },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      /* bindCurrent: false —— 不动全局「当前靶标」指针：多会话并行时那个指针是串写的根源 */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false });
      const keys = bindKeysOf(exec);
      for (const key of keys) bindings.set(key, engagement.id);
      const view = bindingViewOf(exec);
      return toToolJson({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note:
          "已绑定到本会话（会话隔离：其它会话的绑定不受影响）；子智能体会继承本靶标。" +
          (view.is_subagent
            ? " 注意：本会话是子智能体，通常不需要再 open，直接继承父会话靶标即可。"
            : ""),
      });
    },
  });

  /* ── redteam_session_bind ───────────────────────────────────────────── */
  const sessionBind = defineTool({
    name: "redteam_session_bind",
    description:
      "把一个**已经存在**的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。可用靶标 id 或单位名称，省略则列出可绑定的靶标。",
    parameters: {
      engagement: { type: "string", description: "靶标 id 或单位名称；省略只列出候选" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const list = store.listEngagements();
      const wanted = typeof args.engagement === "string" ? args.engagement.trim() : "";
      if (wanted === "") {
        return toToolJson({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: "请传 engagement（靶标 id 或单位名称）完成绑定。",
        });
      }
      const hit =
        list.find((e) => e.id === wanted) ??
        list.find((e) => String(e.name) === wanted) ??
        list.find((e) => String(e.name).includes(wanted));
      if (hit === undefined) {
        return toToolJson({ ok: false, error: "靶标不存在：" + wanted, candidates: list.map((e) => e.id) });
      }
      const keys = bindKeysOf(exec);
      for (const key of keys) bindings.set(key, hit.id);
      return toToolJson({
        ok: true,
        engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec),
        note: "本会话已绑定到「" + hit.name + "」；后续工具与报告都只作用于它。",
      });
    },
  });

  /* ── redteam_session_info ───────────────────────────────────────────── */
  const sessionInfo = defineTool({
    name: "redteam_session_info",
    description:
      "查看**当前会话绑定的是哪个靶标**（会话 id、父会话、根会话、绑定链）。多会话同时开工时，先跑它确认自己没串到别人的靶标上。",
    parameters: {},
    output: { schema: { type: "string" }, render: renderText },
    execute(_args, exec) {
      const view = bindingViewOf(exec);
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null;
      return toToolJson({
        ok: true,
        session: view,
        stats: changed,
        bindings_now: Array.from(bindings.entries(), ([k, v]) => ({ session: k, engagement: v })),
        note: "绑定是进程内状态：dsh 重启后各会话需要重新绑定一次（redteam_engagement_open / redteam_session_bind）。",
      });
    },
  });

  /* ── redteam_agent_slot ─────────────────────────────────────────────── */
  const agentSlot = defineTool({
    name: "redteam_agent_slot",
    description:
      "【主会话派活前后用】执行智能体的并发闸门：同一靶标**最多同时 3 个**在跑（可用 REDTEAM_MAX_AGENTS 配置）。action=status 看还剩几个名额与谁在跑；action=acquire 占一个名额（满了会直接拒绝，**不要重试硬塞**）；action=release 释放（子智能体结束时服务端也会自动释放）。",
    parameters: {
      action: {
        type: "string",
        required: true,
        enum: ["status", "acquire", "release"] as const,
        description: "status 查看 / acquire 占用 / release 释放",
      },
      label: { type: "string", description: "acquire 时的任务标签，例如「信息收集：主域与 C 段」" },
      key: { type: "string", description: "release 时指定要释放的键（省略则释放最早的一个预留）" },
    },
    output: { schema: { type: "string" }, render: renderText },
    async execute(args, exec) {
      const owner = ownerOf(exec);
      if (owner === undefined) {
        return toToolJson({ ok: false, error: "取不到会话 id：无法统计并发（请确认工具调用带着 agent 上下文）。" });
      }
      const live = await liveRunningChildren(ctx, owner);
      const reserved = reservationList(owner);
      /* 注册表里 running 的子会话已经包含正在跑的；预留是"刚占位还没出现在注册表"的那部分，
         两者取较大值，避免重复计数又不会漏计 */
      const used = Math.max(live.running, reserved.length);
      const cap = maxAgentsOf(ctx.root, env);
      const free = Math.max(cap - used, 0);
      const base = {
        ok: true,
        max: cap,
        used,
        free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      };
      if (args.action === "status") {
        return toToolJson({
          ...base,
          hint:
            free === 0
              ? "名额已满：等现有智能体回报后再派（每次只派一个、按顺序推进是最稳的节奏）。"
              : "还有 " + String(free) + " 个名额。默认一个一个派；只有确实互不依赖的活才并行。",
        });
      }
      if (args.action === "acquire") {
        if (free <= 0) {
          /**
           * 拒绝必须是**调用方无法误判为成功**的形状。
           *
           * Lead 提醒的点：类型化时很容易写成"返回一个 ok:false 的对象"，但调用方只看
           * `slot` 字段存不存在就会误判 —— 那闸门等于失效。所以这里：
           * - 无 `slot` 字段（拿不到名额就不给凭证）
           * - `ok:false` + `error` + `rejected:true` 三个信号同时给
           * - 明确写 `acquired:false`，让"是否占到名额"成为可机读的布尔量
           */
          return toToolJson({
            ...base,
            ok: false,
            acquired: false,
            rejected: true,
            error: "并发已满（最多 " + String(cap) + " 个）：现在不能派新智能体。先等当前的在跑智能体回报，或先 release 掉已经结束的。",
          });
        }
        const key = (typeof args.label === "string" && args.label.trim() !== "" ? args.label.trim() : "slot") + "#" + String(Date.now());
        addReservation(owner, key);
        return toToolJson({
          ...base,
          acquired: true,
          slot: key,
          used: used + 1,
          free: Math.max(cap - used - 1, 0),
          hint:
            "已占位（" +
            key +
            "）。**派完之后要记得**：子智能体结束会自动释放；若你派活失败（比如工具报错），手动 redteam_agent_slot action=release key=" +
            key +
            " 把它放掉。",
        });
      }
      if (args.action === "release") {
        const dropped = dropReservation(
          owner,
          typeof args.key === "string" && args.key.trim() !== "" ? args.key.trim() : undefined,
        );
        return toToolJson({
          ...base,
          ok: true,
          released: dropped,
          used: Math.max(used - (dropped ? 1 : 0), 0),
        });
      }
      /**
       * 非法 action 兜底 —— **必须显式拒绝**。
       *
       * 原实现把 `release` 写成"落到最后"，于是 `action: "releaes"`（拼错）/
       * `action: undefined` / 任何未知值都会**静默释放一个名额**，还返回 `ok: true`。
       * 后果是安全的反面：模型拼错一个词就放掉了别人的并发名额，而返回值让它以为成功。
       *
       * 这不属于"改变有效输入的结果"——有效输入是 status/acquire/release 三者，
       * 其余从来就不是有效输入，只是被当成了有效输入执行。
       *
       * 返回里**刻意不含 `released` 字段**：带了它，调用方仍可能从
       * `"released" in result` 误读成"执行了释放"。
       */
      return toToolJson({
        ...base,
        ok: false,
        rejected: true,
        error:
          "未知 action：" +
          JSON.stringify(args.action) +
          "。合法值只有 status / acquire / release（本次未释放任何名额）。",
      });
    },
  });

  /* ── redteam_preflight ──────────────────────────────────────────────── */
  const preflight = defineTool({
    name: "redteam_preflight",
    description:
      "【开工前必须跑一次】平台技能与资源自检：逐个检查红队技能的必需环境变量（如 FOFA 测绘的 FOFA_KEY）、本机工具与二进制（suo5 / fscan / gogo / frp / 冰蝎 / 哥斯拉 / nmap / nuclei…）、外部基础设施（反弹 Shell 用的 VPS）。返回 available/broken 清单与每个坏掉的技能\"缺什么、怎么补\"。**缺 key / 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。**",
    parameters: {
      include: { type: "string", description: "只检查这些技能（逗号分隔）；省略则检查全部红队技能" },
    },
    output: { schema: { type: "string" }, render: renderText },
    async execute(args) {
      const skills = ctx.getService?.("skills") ?? null;
      const plat = platformSummary(ctx.root);
      const cfg = loadPlatformConfig(ctx.root);
      const envFile = await readEnvFile();
      const baseEnv: Record<string, string | undefined> = { ...env };
      const effectiveEnv = mergeConfigEnv(baseEnv, cfg);
      for (const [k, v] of Object.entries(envFile.values)) {
        if (effectiveEnv[k] === undefined || effectiveEnv[k] === "") effectiveEnv[k] = v;
      }

      const toolkit = toolkitDirOf(cfg, ctx.root);
      let toolkitEntries: readonly string[] = [];
      try {
        const { existsSync, readdirSync } = await import("node:fs");
        if (existsSync(toolkit)) toolkitEntries = readdirSync(toolkit).slice(0, 60);
      } catch {
        /* 忽略 */
      }

      const redteamDir = expandSkillPath("$DSH_HOME/redteam", env);
      const markerFile = redteamDir + "/.setup-complete";
      const setupScript = redteamDir + "/setup.sh";
      const { existsSync } = await import("node:fs");
      const hasMarker = existsSync(markerFile);
      const hasSetupScript = existsSync(setupScript);
      const toolkitHint =
        "本插件不替用户下载或安装工具。Windows 与没有 setup.sh 时，到演练台「环境适配」填路径、FOFA_KEY 和 VPS；本机已有 `$DSH_HOME/redteam/setup.sh` 时，由用户自己执行 `--check`，不要由智能体跑 `--yes` 去下载二进制。";
      const fofaKey = effectiveEnv["FOFA_KEY"] ?? "";
      const vpsKey =
        effectiveEnv["REDTEAM_VPS_KEY"] ?? toolkit + (plat.runtime.windows ? "\\vps\\id_rsa" : "/vps/id_rsa");
      const vpsHost = effectiveEnv["REDTEAM_VPS_HOST"] ?? "";
      const hasVps = existsSync(vpsKey);
      const missing: string[] = [];
      if (fofaKey === "") missing.push("FOFA_KEY（资产测绘：在「环境适配」页填写，或写进 $DSH_HOME/.env）");
      if (!hasVps) {
        missing.push(
          plat.runtime.windows
            ? "VPS 私钥（在「环境适配」填写 REDTEAM_VPS_KEY 路径与 REDTEAM_VPS_HOST；Windows 不依赖 setup.sh）"
            : "VPS 登录方式——私钥放到 " +
                vpsKey +
                "，并设 REDTEAM_VPS_HOST（步骤见技能 redteam-setup，或演练台「环境适配」）",
        );
      }
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + "…" + fofaKey.slice(-4) : "(已配置)";
      const runtimeHint = plat.runtime.windows
        ? "当前为 **Windows 适配**：请在演练台「环境适配」页配置工具路径/搜索目录与 FOFA/VPS；不要假设存在 Kali/`bash setup.sh`。仍建议用专用演练机，勿在日常办公机上落私钥与扫描器。"
        : "本模式建议在**专供演练的 Kali 虚拟机**里运行，不要跑在日常办公电脑/宿主机上" +
          "（本机落 VPS 私钥与 WebShell 马，扫描流量也从常用出口 IP 出去；演练完虚拟机可直接丢弃）。";

      const bundledSkills = bundledSkillSummaries(env);
      const skillsMissing = skills === null || typeof skills !== "object" || typeof (skills as Record<string, unknown>)["list"] !== "function";
      const configured = {
        fofa_key: fofaKey === "" ? "missing" : "configured(" + fofaShown + ")",
        vps_key: hasVps ? "configured(" + vpsKey + ")" : "missing",
        vps_host: vpsHost,
        env_file: { path: envFile.path, exists: existsSync(envFile.path), keys: envFile.keys },
        platform_config: { path: cfg.path, exists: cfg.exists },
      };

      if (skillsMissing && bundledSkills.length === 0) {
        /* 桌面端常无 skills inject：仍返回平台工具探测，避免整条 preflight 报废 */
        const toolMissing = plat.tools.items.filter((t) => t.path === null).map((t) => t.id);
        if (toolMissing.length > 0) {
          missing.push("未解析到的工具（在「环境适配」填路径或加搜索目录）：" + toolMissing.slice(0, 12).join(", "));
        }
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          setup_script: { path: setupScript, exists: hasSetupScript },
          toolkit_hint: toolkitHint,
          configured,
          missing,
        };
        const next = plat.runtime.windows
          ? "打开演练台「环境适配」：① 填 binDirs（你的工具文件夹）或逐个 tools 路径 ② 填 FOFA_KEY / VPS ③ 保存后重新 preflight。不要替用户下载工具。"
          : hasSetupScript
            ? '可由用户自己执行 bash "$DSH_HOME/redteam/setup.sh" --check，或到「环境适配」手填路径。不要由智能体下载工具。'
            : "本机没有 setup.sh，这是正常情况。到演练台「环境适配」手填路径，或按技能 redteam-setup 逐项配置。";
        return toToolJson({
          ok: missing.length === 0 && toolMissing.length === 0,
          /**
           * 显式降级标记（Lead 要求）：宿主 skills 服务不可用时，
           * "检查过了但没能力查技能正文" 与 "检查过了且一切正常" 必须可区分。
           * 只靠 `skills_root_hint` 是否存在是隐含表达，调用方容易漏读。
           */
          degraded: true,
          degraded_reason: "skills_unavailable",
          onboarding,
          platform: plat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          skills_root_hint: "宿主 skills 服务不可用：已跳过技能正文体检，仅返回平台工具探测。请到「环境适配」配置路径。",
          next,
        });
      }

      let summaries: readonly SkillSummary[] = [];
      let fromBundle = skillsMissing;
      let scoped = false;
      if (fromBundle) {
        summaries = bundledSkills;
      } else {
        try {
          let scope: unknown = null;
          const presets = ctx.getService?.("agentPresets") ?? null;
          if (presets !== null && typeof presets === "object") {
            const standingKeyFor = (presets as Record<string, unknown>)["standingKeyFor"];
            if (typeof standingKeyFor === "function") {
              scope = await (standingKeyFor as (n: string) => unknown).call(presets, "redteam");
            }
          }
          scoped = scope !== null && scope !== undefined;
          const listFn = (skills as Record<string, unknown>)["list"];
          if (typeof listFn !== "function") throw new Error("skills.list 不可用");
          const listed: unknown = scoped
            ? await (listFn as (o: unknown) => unknown).call(skills, { scope })
            : await (listFn as () => unknown).call(skills);
          const arr: SkillSummary[] = Array.isArray(listed) ? (listed as SkillSummary[]) : [];
          summaries = redteamSummariesForCheck(arr, bundledSkills, scoped);
          fromBundle = summaries.every((item) => item.library === "redteam" && item.content !== undefined && item.content !== "");
        } catch (error) {
          if (bundledSkills.length === 0) {
            return toToolJson({
              ok: false,
              error: "读取技能目录失败：" + (error instanceof Error ? error.message : String(error)),
              platform: plat,
            });
          }
          summaries = bundledSkills;
          fromBundle = true;
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped);
      const only = splitList(args.include);
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name));
      /* include 时只体检点名的技能：否则 ok 被无关 broken 拖成 false，模型会误以为目标技能坏了 */
      const toCheck = only.length > 0 ? wanted : summaries;
      const unknownIncludes = only.filter((n) => !summaries.some((s) => s.name === n));
      const rootsWith = new Map<string, string[]>();
      for (const x of summaries) {
        const dir = x.resourceBase?.kind === "directory" ? (x.resourceBase.path ?? null) : null;
        if (dir === null) continue;
        const cur = rootsWith.get(x.name) ?? [];
        if (!cur.includes(dir)) cur.push(dir);
        rootsWith.set(x.name, cur);
      }

      const checked: (SkillVerdict & { title: string; path: string | null; when_to_use: string })[] = [];
      for (const summary of toCheck) {
        let def: unknown;
        const getFn = (skills as Record<string, unknown> | null)?.["get"];
        if (!fromBundle && skills !== null && typeof getFn === "function") {
          try {
            def = await (getFn as (n: string) => unknown).call(skills, summary.name);
          } catch {
            def = undefined;
          }
        }
        const defRec = def !== null && typeof def === "object" ? (def as Record<string, unknown>) : null;
        const defPath = typeof defRec?.["path"] === "string" ? defRec["path"] : null;
        const defContent = typeof defRec?.["content"] === "string" ? defRec["content"] : null;
        const path = defPath ?? (typeof summary.path === "string" ? summary.path : (summary.resourceBase?.path ?? null));
        const content = defContent !== null && defContent.trim() !== "" ? defContent : (summary.content ?? "");
        const rootPath = summary.resourceBase?.path;
        const verdict = checkSkill(
          {
            name: summary.name,
            content,
            ...(path === null ? {} : { path }),
            ...(rootPath === undefined ? {} : { root: rootPath }),
          },
          {
            env: effectiveEnv,
            sameNameIn: rootsWith.get(summary.name) ?? [],
            fixFor: (issue) => fixesForIssue(issue),
          },
        );
        checked.push({
          ...verdict,
          title: summary.description ?? "",
          path,
          when_to_use: summary.whenToUse ?? "",
          needs_user: verdict.needs_user.map((n) =>
            n.startsWith("环境变量")
              ? n + (plat.runtime.windows ? "（可在「环境适配」页填写）" : "（拿到后 export 并重启 dsh web）")
              : n === "VPS 地址" || n === "VPS 主机名"
                ? "反弹 Shell / 载荷投递用的 " + n + "（技能里还是占位符）"
                : n,
          ),
        });
      }
      const allBroken = checked.filter((s) => s.status === "broken");
      const allAvailable = checked.filter((s) => s.status === "available");
      const shown = (x: { name: string }): boolean => only.length === 0 || only.includes(x.name);
      const broken = allBroken.filter(shown);
      const available = allAvailable.filter(shown);
      const toolMissing = plat.tools.items.filter((t) => t.path === null);
      if (toolMissing.length > 0) {
        missing.push("未解析到的本机工具（「环境适配」填路径）：" + toolMissing.slice(0, 10).map((t) => t.id).join(", "));
      }
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)));
      const onboarding = {
        complete: hasMarker && missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        setup_script: { path: setupScript, exists: hasSetupScript },
        toolkit_hint: toolkitHint,
        configured,
        missing,
      };
      let next: string;
      if (plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)) {
        next =
          "Windows：打开演练台「环境适配」配置 toolkit/binDirs/tools 路径与 FOFA/VPS，保存后重跑 redteam_preflight；技能正文缺路径时优先用已解析的工具绝对路径。";
      } else if (!hasMarker && !hasSetupScript) {
        next =
          "首次使用，且本机没有安装脚本 " +
          setupScript +
          "（这是正常情况，不是故障）。" +
          toolkitHint +
          " 把 onboarding.missing 一次性列给用户；补不齐就说明降级：没有 FOFA 用 crt.sh / 被动 DNS，没有 VPS 只做不落地的成果。";
      } else if (!hasMarker) {
        next = "**首次使用**：让用户自己执行 `bash " + setupScript + " --check`，或打开演练台「环境适配」。不要由智能体执行 --yes 去下载工具。";
      } else if (missing.length > 0) {
        next = "有缺口：把 onboarding.missing 一次性列给用户。Windows 或没有 setup.sh 时走「环境适配」；有脚本时也只让用户自己跑，不要替用户下载工具。";
      } else if (allBroken.length > 0) {
        next = "把 broken 里 needs_user 一次性列给用户；补不齐则说明降级方案。";
      } else {
        next = "全部可用，可以开工。";
      }

      const degradedFromBundle = fromBundle && skillsMissing;
      return toToolJson({
        /* include 模式：ok 只反映点名技能的体检结果；测绘 key/VPS 等 missing 与此无关，降为参考不拖 ok */
        ok: allBroken.length === 0 && (only.length > 0 || missing.length === 0),
        degraded: degradedFromBundle,
        ...(degradedFromBundle
          ? {
              degraded_reason: "skills_unavailable_used_bundled",
              degraded_note:
                "宿主 skills 服务不可用，已改用随包技能正文体检（结果可信度略低：可能缺少用户自定义的技能）。",
            }
          : {}),
        include:
          only.length > 0
            ? { requested: only, unknown: unknownIncludes, note: "ok 只覆盖点名的技能；onboarding.missing 是全局参考，不影响本次 ok" }
            : undefined,
        all_checked: {
          registry_total: summaries.length,
          checked: checked.length,
          broken: allBroken.length,
          available: allAvailable.length,
        },
        onboarding,
        platform: plat,
        summary: summarizeSkills(checked),
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({
          name: s.name,
          problems: s.problems,
          needs_user: s.needs_user,
          fixes: s.issues.map((i) => i.fix).filter(Boolean),
          fix_note: "修复步骤由用户执行（或经「环境适配」页）；不要由你下载/安装工具。",
        })),
        unknown: checked.filter((s) => s.status === "unknown").map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        skills_root_hint: "这里只检查红队技能。官方技能在 $DSH_HOME/skills，不按红队工具路径判不可用。",
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      });
    },
  });

  /* ── redteam_roles ──────────────────────────────────────────────────── */
  const roles = defineTool({
    name: "redteam_roles",
    description: "列出红队角色及其职责标题（信息收集 / 漏洞检测 / 漏洞利用 / 内网渗透）。",
    parameters: {},
    output: { schema: { type: "string" }, render: renderText },
    execute() {
      return toToolJson({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      });
    },
  });

  /* ── redteam_role_prompt_reset ──────────────────────────────────────── */
  const rolePromptReset = defineTool({
    name: "redteam_role_prompt_reset",
    description:
      "把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则四个角色全部重置。",
    parameters: {
      engagement: { type: "string" },
      role: { type: "string", enum: ROLE_ORDER },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const result = store.resetPrompts(id, args.role);
      return toToolJson({ ok: true, engagement: id, ...result });
    },
  });

  return [
    engagementOpen,
    sessionBind,
    sessionInfo,
    preflight,
    agentSlot,
    roles,
    rolePromptReset,
  ];
}

/** 本组工具导出的常量，供测试与面板引用。 */
export const SESSION_TOOL_NAMES = [
  "redteam_engagement_open",
  "redteam_session_bind",
  "redteam_session_info",
  "redteam_preflight",
  "redteam_agent_slot",
  "redteam_roles",
  "redteam_role_prompt_reset",
] as const;

export { DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT, PLANNER_ROLE, agentOf, withStructuredErrors };
