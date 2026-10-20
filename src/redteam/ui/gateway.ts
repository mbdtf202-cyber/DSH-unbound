/**
 * 网关本地 op（9 个）：不转资产库，由 HTTP 桥自己处理。
 *
 * ## 为什么正好是这 9 个
 *
 * 原 `ui.js` 在 `dispatchAsync` **之前**依次拦了四层：
 * `handlePlatformOp` → `handleAgentsOp` → `handleUpdateOp` → `handleSkillOp`。
 * 其中 `platformConfigGet` / `platformConfigSave` / `platformAssignToolkit`
 * 三个资产库也有（CLI/智能体会用），**按实现归属算 store**，HTTP 侧转发过去即可，
 * 不必有两份实现。真正只存在于网关的是：
 *
 * | op | 原处理函数 | 依赖 |
 * |---|---|---|
 * | `platformEnvAdaptStatus` | handlePlatformOp | envAdaptStatus |
 * | `platformEnvAdaptSkip` | handlePlatformOp | markEnvAdaptSkip |
 * | `agentsStatus` | handleAgentsOp | subagents/sessions 注册表 |
 * | `setAgentsMax` | handleAgentsOp | saveMaxAgents |
 * | `version` | handleUpdateOp | 包身份 + 更新检查 |
 * | `updateCheck` | handleUpdateOp | 更新检查 |
 * | `updateApply` | handleUpdateOp | 更新执行 |
 * | `skillCatalog` | handleSkillOp | skills 服务 / 本包技能目录 |
 * | `skillRead` | handleSkillOp | skills 服务 / 本包技能目录 |
 *
 * ## 端口化
 *
 * 依赖宿主服务（`ctx.get('subagents')`）、子进程（npm）、网络（GitHub API）
 * 的东西全部收进 `GatewayPorts`。这样单测不需要真宿主、真网络、真 npm，
 * 而 `gateway.ts` 本身只剩「读输入 → 调端口 → 拼响应」的确定性逻辑。
 *
 * 缺能力时**明确报错**，不猜、不降级：`{ ok: false, error: "..." }`。
 * 这是本项目的一条纪律——两份实现里总有一份不知道另一份修了什么。
 */

import { apiError } from "./protocol.js";
import { fieldBoolean, fieldNumber, fieldString, fieldUnknown } from "./ops.js";
import type { ParsedRequest } from "./ops.js";
import type { ApiBody, ApiErrorBody } from "./protocol.js";

/** 宿主侧智能体注册表（原样复刻 `ctx.get('subagents')` 的用法）。 */
export interface SubagentRegistry {
  listChildren(parentId: unknown): Promise<readonly unknown[]>;
}

/** 宿主会话注册表。 */
export interface SessionRegistry {
  list(): readonly unknown[];
}

/** 技能目录项：原实现只读这些字段。 */
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly provider?: string;
  readonly source?: string;
  readonly path?: string | null;
  readonly content?: string;
  readonly resourceBase?: { readonly kind?: string; readonly path?: string } | null;
  readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean } | null;
}

/** 技能服务。 */
export interface SkillService {
  list(options: { readonly scope: unknown }): Promise<readonly SkillEntry[]>;
  get(name: string, options: { readonly scope: unknown }): Promise<SkillEntry | undefined>;
}

/** preset 服务：`standingKeyFor('redteam')` 给技能根。 */
export interface PresetService {
  standingKeyFor(preset: string): Promise<unknown>;
}

/** 包身份（从 store.plugin 读，读不到则报未知版本）。 */
export interface PluginIdentity {
  readonly name: string;
  readonly version: string | null;
  readonly description: string;
  readonly homepage: string | null;
}

/** 更新检查结果。 */
export type UpdateCheck =
  | { readonly ok: true; readonly latest: string }
  | { readonly ok: false; readonly error: string };

/** 安装模式。 */
export interface InstallInfo {
  readonly mode: "dev" | "package";
  readonly dir?: string;
  readonly declared?: string | null;
  readonly packageManager?: string;
}

/** 更新前置检查：能不能更、更了会不会打断智能体。 */
export interface UpdatePreflight {
  readonly install: InstallInfo;
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
  readonly runningAgents: readonly { readonly session: string; readonly label: string }[];
}

/** 更新执行结果。 */
export type UpdateApply =
  | { readonly ok: true; readonly restart: { readonly log: string } }
  | { readonly ok: false; readonly error: string };

/** 网关所需的全部外部能力。测试逐项注入。 */
export interface GatewayPorts {
  /** 资产库根目录（`ctx.redteam.root`）。 */
  readonly storeRoot: string | null;
  /** 智能体上限：读当前生效值。 */
  maxAgents(): number;
  /** 智能体上限：保存并返回实际生效值。 */
  saveMaxAgents(value: number): number;
  /** 上限的来源（settings / env / default），面板要如实说明。 */
  maxAgentsSource(): string;
  /** 并发上限的硬顶。 */
  readonly maxAgentsLimit: number;
  /** 默认并发数。 */
  readonly defaultMaxAgents: number;
  readonly subagents: SubagentRegistry | null;
  readonly sessions: SessionRegistry | null;
  /** 环境适配状态。 */
  envAdaptStatus(): ApiBody;
  /** 标记「暂不配置」。 */
  envAdaptSkip(skip: boolean): ApiBody;
  /** 包身份。 */
  pluginIdentity(): PluginIdentity;
  /** 更新前置检查。 */
  updatePreflight(): Promise<UpdatePreflight>;
  /** 查最新版本。 */
  checkLatest(): Promise<UpdateCheck>;
  /** 执行更新。 */
  applyUpdate(target: string | null): Promise<UpdateApply>;
  /** 版本比较：remote 是否比 local 新。 */
  versionIsNewer(remote: string, local: string): boolean;
  readonly skillService: SkillService | null;
  readonly presetService: PresetService | null;
  /** 技能服务不可用时的本包技能目录兜底。 */
  skillFallback(request: ParsedRequest): Promise<ApiBody>;
}

/** 网关处理结果：`null` 表示「不是这个层负责」。 */
export type GatewayResult = ApiBody | ApiErrorBody | null;

/** 当前网关负责的 op（与 `OP_TABLE` 里 kind=gateway 的条目一一对应）。 */
export const GATEWAY_LOCAL_OPS: ReadonlySet<string> = new Set([
  "platformEnvAdaptStatus",
  "platformEnvAdaptSkip",
  "agentsStatus",
  "setAgentsMax",
  "version",
  "updateCheck",
  "updateApply",
  "skillCatalog",
  "skillRead",
]);

/** 把一个未知项读成带字段的对象（不可读则 null）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 读字符串字段，缺失回退。 */
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 网关总入口。
 *
 * 分派顺序与原 `apply()` 一致：env→agents→update→skill。
 * 五个 platform op 里只有两个在网关（另三个归 store），所以先判这两个。
 */
export async function handleGateway(
  request: ParsedRequest,
  ports: GatewayPorts,
): Promise<GatewayResult> {
  switch (request.op) {
    // ---------- 环境适配（网关独有） ----------
    case "platformEnvAdaptStatus":
      return ports.envAdaptStatus();
    case "platformEnvAdaptSkip":
      return ports.envAdaptSkip(fieldBoolean(request, "skip") ?? true);

    // ---------- 智能体并发 ----------
    case "agentsStatus":
      return handleAgentsStatus(ports);
    case "setAgentsMax": {
      const raw = fieldNumber(request, "max");
      if (raw === null) {
        // 表里已声明必填，这里只防「声明为 number 但传了 NaN 以外的东西」的残留路径。
        return apiError("invalid_payload", "setAgentsMax 需要数字型 max", { op: request.op });
      }
      const next = ports.saveMaxAgents(raw);
      return {
        ok: true,
        max: next,
        source: "settings",
        limit: ports.maxAgentsLimit,
        note: `已保存为 ${next} 个并发执行智能体，**立即生效**（派活时按新值放行，不用重启 dsh web）。`,
      };
    }

    // ---------- 版本与更新 ----------
    case "version":
      return handleVersion(ports);
    case "updateCheck":
      return handleUpdateCheck(ports);
    case "updateApply":
      return handleUpdateApply(request, ports);

    // ---------- 技能库 ----------
    case "skillCatalog":
      return handleSkillCatalog(request, ports);
    case "skillRead":
      return handleSkillRead(request, ports);

    default:
      // 不在网关词汇表里：交回上层判未知 op。
      return null;
  }
}

/** 智能体并发状态：直接读注册表里真正在跑的子会话（只读不占位）。 */
async function handleAgentsStatus(ports: GatewayPorts): Promise<ApiBody> {
  const max = ports.maxAgents();
  const { subagents, sessions } = ports;
  if (subagents === null || sessions === null) {
    return {
      ok: false,
      error: "subagents / sessions 注册表不可用：读不到并发占用。",
      max,
    };
  }

  const children: {
    readonly parent: string;
    readonly label: string;
    readonly activity: unknown;
    readonly mode: unknown;
  }[] = [];

  try {
    // 只枚举「根会话」：子会话的 header.parentSession 已设置。
    const roots = sessions.list().filter((candidate) => {
      const header = asRecord(asRecord(candidate)?.["header"]);
      if (header === null) return false;
      const parentSession = header["parentSession"];
      return parentSession === undefined || parentSession === null;
    });
    for (const root of roots) {
      const rootRecord = asRecord(root);
      if (rootRecord === null) continue;
      const rootId = rootRecord["id"];
      try {
        const kids = await subagents.listChildren(rootId);
        for (const kid of kids) {
          const kidRecord = asRecord(kid);
          if (kidRecord === null) continue;
          if (kidRecord["kind"] !== "child") continue;
          children.push({
            parent: String(rootId),
            label: text(kidRecord["label"]) || String(kidRecord["id"]),
            activity: kidRecord["activity"],
            mode: kidRecord["mode"],
          });
        }
      } catch {
        // 单个会话读不到不影响其它（原实现同样吞掉）。
      }
    }
  } catch (cause) {
    return {
      ok: false,
      error: "列子会话失败：" + (cause instanceof Error ? cause.message : String(cause)),
      max,
    };
  }

  const running = children.filter((child) => child.activity === "running");
  return {
    ok: true,
    max,
    used: running.length,
    free: Math.max(max - running.length, 0),
    running: running.slice(0, 20),
    total_children: children.length,
    source: ports.maxAgentsSource(),
    limit: ports.maxAgentsLimit,
    default_max: ports.defaultMaxAgents,
    note: `同一会话（靶标）同时最多 ${max} 个执行智能体；默认顺序派活。`,
  };
}

/** 版本信息：本地版本、安装态、有没有更新。 */
async function handleVersion(ports: GatewayPorts): Promise<ApiBody> {
  const identity = ports.pluginIdentity();
  const preflight = await ports.updatePreflight();
  const isDev = preflight.install.mode === "dev";
  const check = isDev ? null : await ports.checkLatest();
  const latest = check !== null && check.ok ? check.latest : null;

  const updateAvailable = check !== null && check.ok && identity.version !== null
    ? ports.versionIsNewer(check.latest, identity.version)
    : false;
  // 本地版本比 registry 还新：本机跑的是尚未发布的开发版本。
  // 不区分这一种，「检查更新」会一直显示「已是最新」，把「这个版本根本没发出去」藏起来。
  const localAhead = check !== null && check.ok && identity.version !== null
    ? ports.versionIsNewer(identity.version, check.latest)
    : false;

  return {
    ok: true,
    plugin: identity,
    install: preflight.install,
    latest,
    updateAvailable,
    localAhead,
    ...(check !== null && !check.ok ? { check_error: check.error } : {}),
    blockers: preflight.blockers,
    notes: preflight.notes,
    running_agents: preflight.runningAgents,
  };
}

/** 检查更新。 */
async function handleUpdateCheck(ports: GatewayPorts): Promise<ApiBody> {
  const identity = ports.pluginIdentity();
  const preflight = await ports.updatePreflight();
  const check = await ports.checkLatest();
  if (!check.ok) {
    return {
      ok: false,
      error: check.error,
      current: identity.version,
      install: { mode: preflight.install.mode },
    };
  }
  const localAhead = identity.version !== null
    ? ports.versionIsNewer(identity.version, check.latest)
    : false;
  const notes = [...preflight.notes];
  if (localAhead && identity.version !== null) {
    notes.push(
      `本机版本（${identity.version}）比 registry 上的最新版（${check.latest}）还新：`
      + "当前跑的是尚未发布的开发版本，包管理器更新不适用（要回退版本请显式指定）。",
    );
  }
  return {
    ok: true,
    current: identity.version,
    latest: check.latest,
    updateAvailable: identity.version !== null
      ? ports.versionIsNewer(check.latest, identity.version)
      : true,
    localAhead,
    install: preflight.install,
    blockers: preflight.blockers,
    notes,
    running_agents: preflight.runningAgents,
  };
}

/** `target` 只接受纯版本号：它会原样进 `npm install <target>`。 */
const SEMVER_ONLY = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 执行更新。 */
async function handleUpdateApply(
  request: ParsedRequest,
  ports: GatewayPorts,
): Promise<ApiBody> {
  const identity = ports.pluginIdentity();
  const preflight = await ports.updatePreflight();

  if (preflight.blockers.length > 0) {
    return {
      ok: false,
      error: "现在不能更新：" + preflight.blockers.join(" "),
      blockers: preflight.blockers,
      notes: preflight.notes,
    };
  }

  // target 会被原样拼进 `npm install <target>`：不校验就等于把
  // 「装任意包并重启进程」暴露给浏览器侧输入。只接受纯 semver。
  const rawTarget = (fieldString(request, "target") ?? "").trim();
  if (rawTarget !== "" && !SEMVER_ONLY.test(rawTarget)) {
    return {
      ok: false,
      current: identity.version,
      error: `updateApply 的 target 必须是纯版本号（如 0.11.0），收到 ${JSON.stringify(rawTarget)}。`
        + "不接受包名、路径、URL 或 npm 参数 —— 它会原样传给包管理器，等于允许远程指定安装内容。",
    };
  }

  const result = await ports.applyUpdate(rawTarget === "" ? null : rawTarget);
  if (!result.ok) {
    return { ok: false, current: identity.version, error: result.error };
  }
  return {
    ok: true,
    current: identity.version,
    latest: fieldString(request, "target"),
    restart: result.restart,
    note: "已安装，正在重启当前宿主（页面会在几秒内断开，重启完成后刷新即可看到新版本）。"
      + "重启日志：" + result.restart.log,
  };
}

/** 取红队 preset 的 standing scope；拿不到就当注册表未就绪。 */
async function standingScopeOf(ports: GatewayPorts): Promise<
  { readonly ready: true; readonly scope: unknown } | { readonly ready: false }
> {
  const presets = ports.presetService;
  if (presets === null) return { ready: false };
  try {
    const scope = await presets.standingKeyFor("redteam");
    return scope === null || scope === undefined ? { ready: false } : { ready: true, scope };
  } catch {
    return { ready: false };
  }
}

/** 技能目录：红队技能 + 官方技能合并。 */
async function handleSkillCatalog(
  request: ParsedRequest,
  ports: GatewayPorts,
): Promise<ApiBody> {
  const skills = ports.skillService;
  const standing = await standingScopeOf(ports);
  // 桌面端 inject 缺失时绝不 400：直接走本包技能目录兜底。
  if (skills === null || !standing.ready) return ports.skillFallback(request);

  let list: readonly SkillEntry[] = [];
  try {
    list = await skills.list({ scope: standing.scope });
  } catch {
    list = [];
  }
  if (list.length === 0) return ports.skillFallback(request);

  const bySource = new Map<string, number>();
  const byDir = new Map<string, number>();
  const items = list.map((skill) => {
    const dir = skill.resourceBase?.kind === "directory" ? skill.resourceBase.path ?? null : null;
    const dirKey = dir === null ? "(非文件系统来源)" : dir;
    byDir.set(dirKey, (byDir.get(dirKey) ?? 0) + 1);
    const source = skill.source ?? "unknown";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse ?? "",
      provider: skill.provider,
      source: skill.source,
      dir,
      modelInvocable: skill.invocation ? skill.invocation.modelInvocable !== false : true,
      userInvocable: skill.invocation ? skill.invocation.userInvocable !== false : true,
      library: "redteam",
      availability: "unknown",
      problems: [] as readonly string[],
      needs_user: [] as readonly string[],
    };
  });

  return {
    ok: true,
    total: items.length,
    bySource: [...bySource].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
    byDir: [...byDir].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
    note: "红队技能和官方技能分开。红队技能才做工具路径检查；官方技能在 $DSH_HOME/skills，由宿主按任务调用。",
    items,
  };
}

/** 读单个技能正文。 */
async function handleSkillRead(
  request: ParsedRequest,
  ports: GatewayPorts,
): Promise<ApiBody> {
  const name = fieldString(request, "name") ?? "";
  if (name === "") return { ok: false, error: "name required" };

  const skills = ports.skillService;
  const standing = await standingScopeOf(ports);
  if (skills !== null && standing.ready) {
    try {
      const skill = await skills.get(name, { scope: standing.scope });
      if (skill !== undefined) {
        return {
          ok: true,
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse ?? "",
          provider: skill.provider,
          source: skill.source,
          path: skill.path ?? null,
          content: skill.content ?? "",
        };
      }
    } catch {
      // 落到本包目录兜底。
    }
  }
  return ports.skillFallback(request);
}

/** 只读地取一个未声明字段（网关目前未用到，保留给扩展）。 */
export function rawField(request: ParsedRequest, key: string): unknown {
  return fieldUnknown(request, key);
}
