/**
 * 技能可用性自检（零依赖，tools 与 UI 共用的**唯一一份**判定逻辑）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/skill-availability.js`。
 *
 * ## 为什么要有它
 *
 * 技能正文里写着"本机路径 / 环境变量 / VPS 地址"，但**技能能列出来 ≠ 能跑**。
 * 缺 `FOFA_KEY`、工具没落到 toolkit、VPS 还是占位符，都要等真正动手才发现 ——
 * 那时候人已经在靶场里了。这里把判定收成一份：
 *
 * - 智能体侧：`redteam_preflight` 开工前跑一次，缺什么直接找用户要；
 * - 面板侧：「技能库」页签给每个技能标出可用性状态。
 *
 * ## 判定维度（都是能从技能正文里客观读出来的）
 *
 * 1. **正文能否加载** —— 只有"正文也读不到、文件又确实不在这台机器上"才判 broken。
 *    正文在手（宿主给了 content）就等于模型能加载这条技能；此时记录路径不存在只是
 *    旧安装 / 另一台机器留下的痕迹（技能路径是绝对路径，换机器必然指空），
 *    不能再据此报不可用。
 * 2. **环境变量**（`os.environ["X"]` / `process.env.X`；带默认值的
 *    `os.environ.get("X", "…")` 不算）。
 * 3. **正文里引用的本机路径**（toolkit / bin / local 下的绝对路径、`$DSH_HOME`、`~/`）。
 * 4. **外部基础设施占位符**（如 `<你的VPS_IP>` 没填）。
 *
 * 2/3/4 只记在缺口里。技能正文里写了替代做法，缺工具或缺密钥时仍然可以加载。
 *
 * 不判定：语义正确性、权限、目标可达性 —— 那些只有真打一次才知道。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 环境变量表（只读）。 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** 解析 `$DSH_HOME` / `${DSH_HOME}` / `~`（技能正文里几种写法都有）。 */
export function expandSkillPath(p: unknown, env: EnvLike = process.env): string {
  const dshHome = env["DSH_HOME"] ?? resolve(homedir(), ".dsh");
  let out = String(p).trim();
  out = out.replace(/\$\{DSH_HOME\}/g, dshHome).replace(/\$DSH_HOME/g, dshHome);
  if (out.startsWith("~/")) out = resolve(homedir(), out.slice(2));
  return out;
}

/**
 * 这台机器上 `$DSH_HOME` 的两个可能来源。
 *
 * 插件进程按 `process.env.DSH_HOME || homedir()/.dsh` 解析；宿主侧的 `dshHomePath()`
 * 走的是它自己的 home。换过盘 / 换过 profile / `HOME` 为空的机器上两者会分叉，只认一边
 * 就会把技能副本、toolkit 路径全判成"不存在"（别人电脑上技能显示不可用的主因）。
 */
export function dshHomeCandidates(env: EnvLike = process.env): readonly string[] {
  const out: string[] = [];
  const push = (p: string | undefined): void => {
    if (p !== undefined && p !== "" && !out.includes(p)) out.push(p);
  };
  push(env["DSH_HOME"]);
  push(resolve(homedir(), ".dsh"));
  return out;
}

/** 正文里的本机路径在**任一**候选 home 下存在就算存在。 */
export function existsUnderAnyHome(raw: unknown, env: EnvLike = process.env): boolean {
  for (const home of dshHomeCandidates(env)) {
    if (existsSync(expandSkillPath(raw, { ...env, DSH_HOME: home }))) return true;
  }
  return false;
}

/** 从技能正文里抽出"必需但没有设"的环境变量名。 */
export function requiredEnvOf(content: unknown): readonly string[] {
  const names = new Set<string>();
  const body = String(content ?? "");
  /* Node 侧：process.env.X（没有默认值这一说） */
  for (const m of body.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
    const g = m[1];
    if (g !== undefined) names.add(g);
  }
  /* Python 侧：os.environ["X"] 必需；os.environ.get("X", "默认") 有兜底，不算必需 */
  for (const m of body.matchAll(/os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]{2,})["']\s*(,)?/g)) {
    const name = m[1];
    if (name !== undefined && m[2] === undefined) names.add(name);
  }
  /* shell 侧：${X:?必填} 是显式必需；裸 $X 不判定（技能里大量出现 $TARGET 这类占位） */
  for (const m of body.matchAll(/\$\{([A-Z][A-Z0-9_]{2,}):\?/g)) {
    const g = m[1];
    if (g !== undefined) names.add(g);
  }
  return Array.from(names);
}

/**
 * 说明文件不是工具。另一套系统、另一套 CPU 的文件名也不拿来判当前系统不可用。
 *
 * @param raw 正文里引用的路径。
 * @param platform 目标平台（默认当前）。
 * @param arch 目标架构（默认当前）。
 */
export function pathCountsOnThisHost(
  raw: unknown,
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  const slashed = String(raw).replace(/\\/g, "/");
  const base = slashed.split("/").pop() ?? "";
  /* 文档 / 配置不是可执行工具 */
  if (/\.(md|txt|json|ya?ml|csv)$/i.test(base)) return false;
  const token = (name: string): boolean => new RegExp("(?:^|[._-])(?:" + name + ")(?:[._-]|$)", "i").test(base);
  /* 平台专属脚本：Windows 上 .sh/.bash 用不了 */
  if (platform === "win32" && /\.(sh|bash)$/i.test(base)) return false;
  if (platform === "win32" && /\/\.local\/|\/\.kimi-webbridge\//.test(slashed)) return false;
  const isWinName = /\.exe$/i.test(base) || token("windows|win32|win64");
  const isDarwin = token("darwin|macos");
  const isLinux = token("linux");
  const isArm = token("arm64|aarch64");
  const isAmd = token("amd64|x64|x86_64");
  if (platform === "win32" && (isLinux || isDarwin)) return false;
  if (platform === "darwin" && (isWinName || isLinux)) return false;
  if (platform !== "win32" && platform !== "darwin" && (isWinName || isDarwin)) return false;
  if (isArm && arch !== "arm64") return false;
  if (isAmd && arch !== "x64") return false;
  return true;
}

/**
 * 正文里引用的、可判定存在性的本机路径（toolkit / bin / local 下的绝对路径）。
 *
 * 只收这三类目录下的路径：技能正文里到处是 `/api/v1/users` 这种 URL 路径，
 * 全收会把每条技能都判成"路径缺失"。
 */
export function referencedPathsOf(content: unknown): readonly string[] {
  const out = new Set<string>();
  for (const m of String(content ?? "").matchAll(/(?:~|\$DSH_HOME|\/home\/[^\s"'`,)]+?)\/[\w./\u4e00-\u9fa5-]+/g)) {
    /* 去掉句末标点：中文标点常常紧贴路径 */
    const raw = m[0].replace(/[，。；、：)）\]]+$/, "");
    if (!/\/(toolkit|bin|local)\//.test(raw)) continue;
    /* 含占位符 / 通配符的路径无法判定，跳过 */
    if (/[<>{}*|]/.test(raw)) continue;
    if (!pathCountsOnThisHost(raw)) continue;
    out.add(raw);
  }
  return Array.from(out);
}

/** 一条技能摘要（宿主 `skills.list()` 的形状，只取用到的字段）。 */
export interface SkillSummary {
  readonly name: string;
  readonly description?: string;
  readonly content?: string;
  readonly path?: string;
  readonly dir?: string;
  readonly root?: string;
  readonly library?: string;
  readonly whenToUse?: string;
  readonly resourceBase?: { readonly kind?: string; readonly path?: string };
}

/** 技能库归属。 */
export type SkillLibrary = "official" | "redteam" | "";

/** 宿主技能服务列不出来时，用本包 `skills/redteam` 和 `$DSH_HOME/redteam/skills`。 */
export function bundledSkillSummaries(
  env: EnvLike = process.env,
  /** 本模块所在目录（注入以便测试；默认用 `import.meta.url`）。 */
  hereOverride?: string,
): readonly SkillSummary[] {
  const here = hereOverride ?? dirname(fileURLToPath(import.meta.url));
  /* 两个候选 home 都扫：宿主按 dshHomePath 列技能时用的是它自己的 home，
     只扫 env 那一份会在分叉的机器上"装了却列不出来"。 */
  const dirs: string[] = [join(here, "..", "..", "skills", "redteam")];
  for (const home of dshHomeCandidates(env)) {
    const dir = join(home, "redteam", "skills");
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  const seen = new Set<string>();
  const out: SkillSummary[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of names) {
      if (!file.endsWith(".md")) continue;
      const name = file.slice(0, -3);
      if (seen.has(name)) continue;
      const filePath = join(dir, file);
      let content = "";
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        content = "";
      }
      if (content.trim() === "") continue;
      seen.add(name);
      const title = (content.match(/^#\s+(.+)$/m) ?? [])[1] ?? name;
      out.push({
        name,
        description: String(title).trim(),
        content,
        path: filePath,
        library: "redteam",
        resourceBase: { kind: "directory", path: dir },
      });
    }
  }
  return out;
}

/** 官方技能在 `$DSH_HOME/skills`。红队技能在本包 `skills/redteam` 或 `$DSH_HOME/redteam/skills`。 */
export function skillLibraryOf(summary: SkillSummary | null | undefined): SkillLibrary {
  if (summary === null || summary === undefined) return "";
  if (summary.library === "official" || summary.library === "redteam") return summary.library;
  const n = [summary.path, summary.dir, summary.root, summary.resourceBase?.path]
    .filter((item): item is string => typeof item === "string")
    .join("\n")
    .replace(/\\/g, "/");
  if (/\/skills\/redteam(\/|$)/.test(n) || /\/redteam\/skills(\/|$)/.test(n)) return "redteam";
  if (/\/skills(\/|$)/.test(n)) return "official";
  return "";
}

/** 官方用户技能。不拿红队工具路径去判它们可不可用。 */
export function officialSkillSummaries(env: EnvLike = process.env): readonly SkillSummary[] {
  const home = env["DSH_HOME"] ?? join(homedir(), ".dsh");
  const dir = join(home, "skills");
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.name === ".system" || entry.name.startsWith(".")) continue;
    let filePath = "";
    let name = "";
    if (entry.isDirectory()) {
      filePath = join(dir, entry.name, "SKILL.md");
      name = entry.name;
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
      filePath = join(dir, entry.name);
      name = entry.name.slice(0, -3);
    } else {
      continue;
    }
    if (seen.has(name) || !existsSync(filePath)) continue;
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (content.trim() === "") continue;
    seen.add(name);
    const title =
      (content.match(/^description:\s*(.+)$/m) ?? content.match(/^#\s+(.+)$/m) ?? [])[1] ?? name;
    out.push({
      name,
      description: String(title).trim().replace(/^['"]|['"]$/g, ""),
      content,
      path: filePath,
      library: "official",
      resourceBase: { kind: "directory", path: dir },
    });
  }
  return out;
}

/**
 * 红队自检只用红队技能。官方技能即使出现在宿主列表里也不参与路径判断。
 *
 * @param summaries 宿主列出的技能。
 * @param bundled 随包/本机红队技能（作为名字白名单与兜底内容）。
 * @param scoped 宿主是否按预设 scope 过滤过（是则宿主列表可信）。
 */
export function redteamSummariesForCheck(
  summaries: readonly SkillSummary[] | null | undefined,
  bundled: readonly SkillSummary[] | null | undefined,
  scoped: boolean,
): readonly SkillSummary[] {
  const base = Array.isArray(bundled) ? bundled : [];
  const names = new Set(base.map((item) => item.name).filter(Boolean));
  const picked: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    if (typeof summary?.name !== "string" || summary.name === "" || seen.has(summary.name)) continue;
    const library = skillLibraryOf(summary);
    if (library === "official") continue;
    if (library === "redteam" || scoped || names.has(summary.name)) {
      seen.add(summary.name);
      picked.push(summary);
    }
  }
  for (const item of base) {
    if (item.name === "" || seen.has(item.name)) continue;
    seen.add(item.name);
    picked.push(item);
  }
  return picked;
}

/** 从某个技能根里读同名技能的正文（读不到返回 null）。 */
export function readSkillFromRoot(root: unknown, name: unknown): { path: string; content: string } | null {
  if (typeof root !== "string" || root === "") return null;
  const n = String(name ?? "");
  for (const dir of [root, resolve(root, n)]) {
    for (const file of [resolve(dir, n + ".md"), resolve(dir, "SKILL.md")]) {
      try {
        if (existsSync(file)) return { path: file, content: readFileSync(file, "utf8") };
      } catch {
        /* 继续试下一个 */
      }
    }
  }
  return null;
}

/** 问题类型。`kind` 决定 `fixesForIssue` 生成哪类修复建议。 */
export type SkillIssueKind =
  | "file-missing"
  | "content-missing"
  | "file-stale"
  | "env-missing"
  | "path-missing"
  | "placeholder"
  | "shadowed";

/** 一条缺口。 */
export interface SkillIssue {
  readonly kind: SkillIssueKind;
  readonly detail: string;
  readonly fix: string;
  readonly file?: string;
  readonly env?: string;
  readonly paths?: readonly string[];
  readonly placeholder?: string;
  readonly other_root?: string;
}

/** 检查判定状态。 */
export type SkillStatus = "available" | "broken" | "unknown";

/** `checkSkill` 的结果。 */
export interface SkillVerdict {
  readonly name: string;
  readonly status: SkillStatus;
  readonly issues: readonly SkillIssue[];
  readonly problems: readonly string[];
  readonly needs_user: readonly string[];
  readonly shadowed_by?: string;
  readonly shadowed_path?: string;
  readonly checked: {
    readonly file: string | null;
    readonly env: readonly string[];
    readonly missing_env?: readonly string[];
    readonly paths: readonly string[];
    readonly missing_paths?: readonly string[];
  };
}

/** 待检查的技能。 */
export interface SkillInput {
  readonly name?: string;
  readonly content?: string;
  readonly path?: string;
  readonly root?: string;
}

/** 检查选项。 */
export interface CheckSkillOptions {
  readonly env?: EnvLike | undefined;
  /** 其它也注册了同名技能的根目录。 */
  readonly sameNameIn?: readonly string[] | undefined;
  /**
   * 修复文案生成器。默认返回空串 ——
   * 由 `skill-fixes` 注入，避免这里硬依赖那一层（也用不着在纯判定里加载 500 行文案表）。
   */
  readonly fixFor?: ((issue: { readonly kind: string; readonly skill: string } & Record<string, unknown>) => string) | undefined;
}

/** 调修复文案生成器，任何异常都退化成空串（判定不能因为文案出错而挂）。 */
function safeFix(
  fixFor: CheckSkillOptions["fixFor"],
  payload: { readonly kind: string; readonly skill: string } & Record<string, unknown>,
): string {
  if (fixFor === undefined) return "";
  try {
    return String(fixFor(payload) ?? "");
  } catch {
    return "";
  }
}

/**
 * 检查一个技能的可用性。
 *
 * @param skill `{ name, description?, content?, path?, root? }`（content 是技能正文，root 是它来自哪个技能根）。
 * @param options 见 {@link CheckSkillOptions}。
 *
 * @returns `issues` 是缺口列表（`kind` 见 {@link SkillIssueKind}），`problems` 是它的 detail 文本视图。
 * 缺路径、缺密钥、占位符未填都留在 issues 里，**不把 status 打成 broken**。
 * `status==='unknown'` 表示"正文读不到，判不了"（例如只有元数据、正文加载失败的远端技能）。
 */
export function checkSkill(skill: SkillInput | null | undefined, options: CheckSkillOptions = {}): SkillVerdict {
  const env = options.env ?? process.env;
  const name = typeof skill?.name === "string" && skill.name !== "" ? skill.name : "(未命名)";
  const content = typeof skill?.content === "string" ? skill.content : "";
  const file = typeof skill?.path === "string" ? skill.path : null;
  const root = typeof skill?.root === "string" ? skill.root : null;
  const issues: SkillIssue[] = [];
  const needsUser: string[] = [];

  /** 记一条问题：detail 给用户看"不可用原因"，fix 给"怎么修"。 */
  const addIssue = (
    kind: SkillIssueKind,
    detail: string,
    extra?: Partial<Omit<SkillIssue, "kind" | "detail" | "fix">>,
  ): void => {
    const payload = { kind, skill: name, ...(extra ?? {}) };
    const fix = safeFix(options.fixFor, payload);
    issues.push({ kind, detail, fix, ...(extra ?? {}) });
  };

  if (content.trim() === "") {
    /* 正文读不到，再分两种：文件本来该在本机却没有（真的加载不出来 → broken），
       其余（只有元数据 / 远端技能源 / 宿主没给正文 → 判不了 → unknown）。 */
    const gone = file !== null && !existsSync(file);
    const detail = gone
      ? "技能文件在本机不存在，正文也读不到：" + file
      : "技能正文读不到（只有元数据）：无法判断可用性，需要时用 `skill` 工具实际加载一次";
    const kind: SkillIssueKind = gone ? "file-missing" : "content-missing";
    return {
      name,
      status: gone ? "broken" : "unknown",
      issues: [{ kind, detail, fix: safeFix(options.fixFor, { kind, skill: name, ...(file === null ? {} : { file }) }) }],
      problems: [detail],
      needs_user: [],
      checked: { file, env: [], paths: [] },
    };
  }
  /* 正文在手 = 技能能加载。这里的路径只作提示：它是上一次在某台机器上解析出来的绝对路径，
     换机器必然指空 —— 记一条非阻塞的 file-stale，不把整条技能标成不可用。 */
  if (file !== null && !existsSync(file)) {
    addIssue("file-stale", "技能记录的文件路径在本机不存在（技能正文仍可加载）：" + file, { file });
  }

  const envNames = requiredEnvOf(content);
  const missingEnv = envNames.filter((n) => {
    const v = env[n];
    return v === undefined || v === "";
  });
  for (const n of missingEnv) addIssue("env-missing", "缺环境变量 " + n, { env: n });

  const paths = referencedPathsOf(content);
  const missingPaths = paths.filter((p) => !existsUnderAnyHome(p, env));
  if (missingPaths.length > 0) {
    const shown = missingPaths.slice(0, 6).join("、");
    addIssue(
      "path-missing",
      "引用的本机路径不存在：" + shown + (missingPaths.length > 6 ? " 等 " + missingPaths.length + " 处" : ""),
      { paths: missingPaths },
    );
  }

  /* 外部基础设施占位符：技能里出现 `<你的VPS_IP>` 这类说明还没配。
     但**已经配好的部署不该被误报**：只要 REDTEAM_VPS_HOST 有值，
     技能正文里的占位符就只是文档写法（实际命令会用配置值替换），不再算缺口。
     判定顺序必须是"先看配置、再看占位符"，否则配好 VPS 的机器上
     这几个技能会永远显示 broken（模板占位符与真实配置混在一起）。 */
  const vpsHost = env["REDTEAM_VPS_HOST"];
  const vpsConfigured = typeof vpsHost === "string" && vpsHost.trim() !== "";
  const placeholders: string[] = [];
  if (!vpsConfigured) {
    if (content.includes("<你的VPS_IP>") || content.includes("<VPS_IP>")) placeholders.push("VPS 地址");
    if (content.includes("<你的VPS_主机名>") || content.includes("<VPS 主机名>")) placeholders.push("VPS 主机名");
  }
  for (const p of placeholders) {
    addIssue("placeholder", p + "还是占位符（技能里写的是占位符，说明本机/本环境还没配）", { placeholder: p });
    needsUser.push(p);
  }
  for (const n of missingEnv) needsUser.push("环境变量 " + n);

  /* 兜底：同名技能在别的根里有一份"问题更少"的版本（通常是用户自己配过的那份，
     但被排在前面的随包占位符版本盖住了）。这时如实说明，而不是让用户以为环境没配。 */
  let shadowed: { root: string; path: string; status: SkillStatus } | null = null;
  for (const other of options.sameNameIn ?? []) {
    if (other === root) continue;
    const alt = readSkillFromRoot(other, name);
    if (alt === null || alt.content === content) continue;
    const verdict = checkSkill({ name, content: alt.content, path: alt.path }, { env, ...(options.fixFor === undefined ? {} : { fixFor: options.fixFor }) });
    if (verdict.status === "available" || verdict.problems.length < issues.length) {
      shadowed = { root: other, path: alt.path, status: verdict.status };
      addIssue(
        "shadowed",
        "`" + other + "` 里还有一份同名技能（" + verdict.status + "），" +
          "但按技能根顺序当前加载的是这一份（上面这些不可用原因来自这一份）",
        { other_root: other },
      );
      break;
    }
  }

  /* 走到这里正文一定读到了 → 可用。缺工具 / 缺密钥 / 占位符 / 路径来自别的机器都只记缺口。 */
  return {
    name,
    status: "available",
    issues,
    problems: issues.map((x) => x.detail),
    needs_user: Array.from(new Set(needsUser)),
    ...(shadowed === null ? {} : { shadowed_by: shadowed.root, shadowed_path: shadowed.path }),
    checked: { file, env: envNames, missing_env: missingEnv, paths, missing_paths: missingPaths },
  };
}

/** 技能状态汇总（面板顶部标签与 preflight 的返回值都用它）。 */
export interface SkillSummaryCounts {
  readonly total: number;
  readonly available: number;
  readonly broken: number;
  readonly unknown: number;
}

/** 汇总一批技能的状态。 */
export function summarizeSkills(results: readonly SkillVerdict[]): SkillSummaryCounts {
  const out = { total: results.length, available: 0, broken: 0, unknown: 0 };
  for (const r of results) {
    if (r.status === "available") out.available += 1;
    else if (r.status === "broken") out.broken += 1;
    else out.unknown += 1;
  }
  return out;
}
