/**
 * 宿主目标文件解析。
 *
 * ## 为什么改写成数据驱动
 *
 * dsh-qilin 用 238 行 `firstExisting([...])` / `allExisting([...])` 的手写分支
 * 表达「这个 key 可能在哪几个路径」。这段代码无法测试（路径全硬编码绝对位置）、
 * 无法审计（65 个 key 散在 238 行里）、而且每次上游改布局就要改代码。
 *
 * 这里改成：**每条候选路径是一个带命名空间的模板**。
 *   `@deepseek-ai` → aiBase 下的包目录（这就是 aiBase 的定义）
 *   `@earendil-works` → 兄弟命名空间（pi-ai 实际在这，原项目没覆盖）
 * 解析顺序由数组顺序决定，`all` 表示全部收集（用于「实现+类型残留」这类双写目标）。
 *
 * ## 为什么保留 targets.json
 *
 * 那份文件是在**真实 0.2.1-rc.2 宿主上跑原 targetFiles() 得到的解析结果**，
 * 是「已知布局」的地面真值。作为最高优先级候选，它让行为与旧版逐字节一致；
 * 模板解析负责在布局变化时兜底。两者都失败 → 该 key 为空 → 补丁标记 missing_file。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectory, isRegularFile } from "../fs/atomic.js";

/**
 * 目标候选。`spec` 是包内相对路径；`scope` 决定在哪个命名空间下找。
 */
interface TargetSpec {
  /** 允许的包命名空间前缀，按序尝试。 */
  readonly scopes: readonly string[];
  /** 包内相对路径（posix 分隔）。 */
  readonly rel: string;
}

export interface TargetResolution {
  /** 该 key 命中的绝对路径（可能多个）。空数组表示宿主上没有这个目标。 */
  readonly paths: readonly string[];
  /** 解析来源，便于诊断：'known' = targets.json 命中，'template' = 模板兜底。 */
  readonly via: "known" | "template" | "none";
}

/** 一个 aiBase 上可用的命名空间根。 */
export interface NamespaceRoots {
  /** `@deepseek-ai` 包目录本身（aiBase）。 */
  readonly primary: string;
  /**
   * 其它命名空间的 scope 目录，key 是 scope 名（如 `@earendil-works`），
   * value 是该 scope 目录的绝对路径。
   *
   * 注意：value 已经是 scope 目录本身，**不要再拼一次 scope 名**。
   * 早期的实现把 siblings 当 node_modules 根用，导致 `@earendil-works/@earendil-works`。
   */
  readonly siblingScopes: ReadonlyMap<string, string>;
}

/**
 * 65 个 key 的候选模板。
 *
 * 这里刻意保留「多个候选」而不是单一路径：上游经常把实现搬进 `lib/types/`，
 * 或者把 yml 从包根搬到 `lib/`。候选顺序 = 优先级。
 */
const TARGETS: Readonly<Record<string, { readonly all?: boolean; readonly specs: readonly TargetSpec[] }>> = {
  "agent-instructions": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-agent-instructions/lib/index.js" }] },
  "agent-loop": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-agent-loop/lib/index.js" }] },
  "agent-preset": {
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-web-app/presets/standard.patch.yml" },
      { scopes: ["@deepseek-ai"], rel: "dsh-agent-preset/lib/index.js" },
    ],
  },
  "api-session-controller": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-api-session-controller/lib/index.js" }] },
  "app-boot": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-app-boot/lib/index.js" }] },
  "auto-review": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-experimental-auto-review/lib/index.js" }] },
  base: {
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-base/cordis.patch.yml" },
      { scopes: ["@deepseek-ai"], rel: "dsh-base/lib/cordis.patch.yml" },
    ],
  },
  "base-package": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-base/package.json" }] },
  "compaction-tool-result-pruner": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-compaction-tool-result-pruner/lib/index.js" }],
  },
  "conversation-client": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-client-ui-conversation/lib/client.js" }] },
  "deliverables-prompt": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-client-ui-deliverables/lib/index.js" }] },
  "dsh-tools": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tools/lib/index.js" }] },
  "dsh-tools-ptc": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tools/lib/types/ptc.js" }] },
  "dsh-tools-types": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tools/lib/types/index.js" }] },
  escalation: {
    all: true,
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-sandbox/lib/index.js" },
      { scopes: ["@deepseek-ai"], rel: "dsh-sandbox/lib/types/escalation.js" },
    ],
  },
  "fs-observation-policy": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-fs-observation-policy/lib/index.js" }] },
  "fs-sandbox": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-fs-sandbox/lib/index.js" }] },
  "harness-dev-context": {
    all: true,
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-harness-dev-context/lib/index.js" },
      { scopes: ["@deepseek-ai"], rel: "dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js" },
    ],
  },
  headless: {
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-headless/cordis.patch.yml" },
      { scopes: ["@deepseek-ai"], rel: "dsh-headless/lib/cordis.patch.yml" },
    ],
  },
  "llm-deepseek": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-llm-deepseek/lib/index.js" }] },
  "permission-presets": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-permission-presets/lib/index.js" }] },
  "permission-presets-types": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-permission-presets/lib/types/index.js" }],
  },
  persona: { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-persona/lib/index.js" }] },
  // pi-ai 不在 @deepseek-ai 下，这是原项目漏掉的部分
  "pi-ai-anthropic-messages": {
    specs: [{ scopes: ["@earendil-works", "@deepseek-ai"], rel: "pi-ai/dist/api/anthropic-messages.js" }],
  },
  "pi-ai-completions": {
    specs: [{ scopes: ["@earendil-works", "@deepseek-ai"], rel: "pi-ai/dist/api/openai-completions.js" }],
  },
  "pi-ai-responses-shared": {
    specs: [{ scopes: ["@earendil-works", "@deepseek-ai"], rel: "pi-ai/dist/api/openai-responses-shared.js" }],
  },
  "preset-acp-app": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-acp-app/cordis.patch.yml" }] },
  "preset-cordis": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-web-app/presets/cordis.patch.yml" }] },
  "preset-minimal": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-web-app/presets/minimal.patch.yml" }] },
  "preset-ptc": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-web-app/presets/ptc.patch.yml" }] },
  "preset-sdk-app": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-sdk-app/cordis.patch.yml" }] },
  "preset-sdk-minimal": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-sdk-minimal/cordis.patch.yml" }] },
  "preset-standard": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-web-app/presets/standard.patch.yml" }] },
  "preset-unrestricted": {
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-web-app/presets/unrestricted.patch.yml" },
      { scopes: ["@deepseek-ai"], rel: "dsh-agent-preset/unrestricted/agent.cordis.yml" },
    ],
  },
  "repeat-tool-reminder": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-repeat-tool-reminder/lib/index.js" }] },
  "sandbox-local": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-sandbox-local/lib/index.js" }] },
  "sandbox-policy": {
    all: true,
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-sandbox-policy/lib/index.js" },
      { scopes: ["@deepseek-ai"], rel: "dsh-sandbox-policy/lib/types/index.js" },
    ],
  },
  session: { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-session/lib/index.js" }] },
  "session-format-v0": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-session-format-v0-to-v1/lib/index.js" }] },
  "session-log-deepseek": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-session-log-deepseek/lib/index.js" }] },
  "session-log-deepseek-types": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-session-log-deepseek/lib/types/index.js" }],
  },
  "session-reference": {
    all: true,
    specs: [
      { scopes: ["@deepseek-ai"], rel: "dsh-session-reference/lib/index.js" },
      { scopes: ["@deepseek-ai"], rel: "dsh-session-reference/lib/types/index.js" },
    ],
  },
  settings: { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-settings/lib/index.js" }] },
  subagent: { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-subagent/lib/index.js" }] },
  "subagent-types": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-subagent/lib/types/child-agent.js" }] },
  "system-prompt": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-system-prompt/lib/index.js" }] },
  "system-prompt-nested": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-system-prompt/lib/types/index.js" }],
  },
  "tool-bash": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-bash/lib/index.js" }] },
  "tool-fs": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-fs/lib/index.js" }] },
  "tool-pwsh": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-pwsh/lib/index.js" }] },
  "tool-subagent": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-subagent/lib/index.js" }] },
  "tool-todo": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-todo/lib/index.js" }] },
  "tool-web": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-web/lib/index.js" }] },
  "tool-web-nested": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-tool-web/lib/types/index.js" }] },
  // ---- 以下 key 在当前 0.2.1-rc.2 宿主上已不存在 ----
  // 保留模板是为了在旧版或第三方分支上仍能命中；缺失时补丁会被判 missing_file，
  // 由 optional/absent 语义处理，不会污染 drift 报告。
  // desktop-shell：0.2.1-rc.2 已把目标代码整体移除。
  // 我全盘搜过宿主 5 条相关补丁的 7 个 pattern，0 命中（连 dsh-desktop-host 里也没有），
  // 所以这里**故意不提供模板** —— 解析为空 → 补丁判 absent → drift 不拉红。
  // 硬指到 dsh-desktop-host 会制造 5 条假漂移告警，比不解析更糟。
  "desktop-shell": { specs: [] },
  "hooks-claude-code": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-hooks-claude-code/lib/index.js" }],
  },
  "hooks-claude-code-nested": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-hooks-claude-code/lib/types/index.js" }],
  },
  "hooks-codex": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-hooks-codex/lib/index.js" }] },
  "hooks-codex-nested": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-hooks-codex/lib/types/index.js" }] },
  "liangshen-tool-bootstrap": {
    specs: [{ scopes: ["@deepseek-ai", "@linxin666"], rel: "dsh-liangshen/lib/tool-bootstrap.js" }],
  },
  "preset-liangshen": {
    specs: [
      { scopes: ["@linxin666", "@deepseek-ai"], rel: "dsh-liangshen/presets/liangshen/preset.yml" },
      { scopes: ["@linxin666", "@deepseek-ai"], rel: "dsh-liangshen/presets/liangshen/agent.cordis.yml" },
    ],
  },
  "preset-liangshen-pkg": {
    specs: [{ scopes: ["@linxin666", "@deepseek-ai"], rel: "dsh-liangshen/package.json" }],
  },
  "user-approval": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-user-approval/lib/types/index.js" }] },
  "user-approval-code": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-user-approval/lib/index.js" }] },
  "user-approval-invariant": {
    specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-user-approval/lib/invariant.js" }],
  },
  "web-app": { specs: [{ scopes: ["@deepseek-ai"], rel: "dsh-web-app/cordis.patch.yml" }] },
};

/** 每种 scope 对应的包目录（scopeValue 已经是该 scope 的目录）。 */
function scopeBaseOf(roots: NamespaceRoots, scope: string): string[] {
  if (scope === "@deepseek-ai") return [roots.primary];
  const dir = roots.siblingScopes.get(scope);
  return dir === undefined ? [] : [dir];
}

/**
 * 从 aiBase 推出可用的命名空间根。
 *
 * aiBase 形如 `.../node_modules/@deepseek-ai`，其父即 node_modules。
 * 同级还有 `@earendil-works`、`@anthropic-ai` 等 scope 目录 —— pi-ai 就住在
 * `@earendil-works` 下，这是原项目完全没覆盖的一块。
 */
export function namespaceRootsOf(aiBase: string): NamespaceRoots {
  const primary = path.normalize(aiBase);
  const nodeModules = path.dirname(primary);
  const siblingScopes = new Map<string, string>();
  try {
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("@")) continue;
      if (entry.name === path.basename(primary)) continue;
      siblingScopes.set(entry.name, path.join(nodeModules, entry.name));
    }
  } catch {
    /* 读不到目录就当没有兄弟 scope */
  }
  return { primary, siblingScopes };
}

function trySpec(roots: NamespaceRoots, spec: TargetSpec): string | null {
  for (const scope of spec.scopes) {
    for (const base of scopeBaseOf(roots, scope)) {
      const candidate = path.join(base, ...spec.rel.split("/"));
      if (isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 读已知布局表（可选；不存在则只用模板）。 */
function loadKnownTargets(): Record<string, readonly string[]> | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "patches", "targets.json"),
    path.join(here, "..", "..", "..", "patches", "targets.json"),
  ];
  for (const c of candidates) {
    if (!isRegularFile(c)) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(c, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, readonly string[]> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
        }
        return out;
      }
    } catch {
      /* 表坏了就退回模板 */
    }
  }
  return null;
}

/** 解析单个 key。 */
export function resolveTarget(
  key: string,
  aiBase: string,
  known: Record<string, readonly string[]> | null = loadKnownTargets(),
): TargetResolution {
  // 1) 已知布局表优先，保证与真实宿主上原实现逐字节一致。
  if (known) {
    const listed = known[key];
    if (listed && listed.length > 0) {
      const abs = listed.map((rel) => path.join(aiBase, ...rel.split("/"))).filter(isRegularFile);
      if (abs.length > 0) return { paths: abs, via: "known" };
    }
  }
  // 2) 模板兜底（布局变化时仍能命中）。
  const def = TARGETS[key];
  if (!def) return { paths: [], via: "none" };
  const roots = namespaceRootsOf(aiBase);
  const found: string[] = [];
  for (const spec of def.specs) {
    const hit = trySpec(roots, spec);
    if (hit) {
      if (!found.includes(hit)) found.push(hit);
      if (def.all !== true) break;
    }
  }
  return found.length > 0 ? { paths: found, via: "template" } : { paths: [], via: "none" };
}

/** 解析全部 key（一次建表，避免每个补丁都 walk 一遍目录）。 */
export function resolveAllTargets(aiBase: string): Record<string, TargetResolution> {
  const known = loadKnownTargets();
  const out: Record<string, TargetResolution> = {};
  for (const key of Object.keys(TARGETS)) {
    out[key] = resolveTarget(key, aiBase, known);
  }
  return out;
}

/** 暴露 key 列表，供测试与 CLI 覆盖检查。 */
export function knownTargetKeys(): readonly string[] {
  return Object.keys(TARGETS).sort();
}

/** aiBase 是不是一个合法的 `@deepseek-ai` 包目录。 */
export function isAiBase(p: string): boolean {
  if (!isDirectory(p)) return false;
  const base = path.basename(path.normalize(p));
  if (base !== "@deepseek-ai") return false;
  // 至少要有一个 dsh-* 包在里面，否则只是同名空目录
  try {
    return fs.readdirSync(p).some((n) => n.startsWith("dsh"));
  } catch {
    return false;
  }
}
