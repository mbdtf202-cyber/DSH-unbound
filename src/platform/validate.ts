/**
 * 写库前的校验与规范化（零依赖）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/validate.js`，**并补了一处真实缺口**（见下）。
 */

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** 马类型白名单。 */
export const WEBSHELL_TYPES = ["behinder", "godzilla", "antSword", "antsword", "custom"] as const;

/** 规范化后的马类型（`antSword` 是唯一保留驼峰的值，历史数据就是这么写的）。 */
export type ShellType = "behinder" | "godzilla" | "antSword" | "custom";

/** 马状态白名单。 */
export const WEBSHELL_STATUSES = ["online", "offline", "dead", "unknown"] as const;

/** 规范化后的状态。 */
export type ShellStatus = (typeof WEBSHELL_STATUSES)[number];

/**
 * 规范化马类型：大小写不敏感、允许中文别名（冰蝎/哥斯拉/蚁剑）。
 *
 * 认不出就抛错而不是静默存原文 —— 面板的"用户连不上"红标、会话页的连接口令复制
 * 都按这个字段判断，存进去一个拼错的值不会报错，只会让这两处判定静默失效。
 *
 * 注意匹配用的是**子串**正则（`/behinder|冰蝎/`），所以 `behinder2`、`my-behinder`
 * 也会归到 `behinder`。这是原实现的既有行为，保留：这批正则的真实目的是
 * "用户把中文别名、发行版叫法都写进来也能认"，而误归一个带后缀的名字
 * 只会让它显示成正规马，不会造成数据损坏。若要收紧成精确匹配，
 * 属于行为变更，需同时迁移历史数据 —— 见交接报告。
 *
 * @param value 原始值（可为空）。
 * @returns 规范化后的值，或 `null`（空值合法 = 未声明）。
 * @throws 无法识别的类型。
 */
export function normalizeShellType(value: unknown): ShellType | null {
  const raw = value === undefined || value === null ? "" : String(value).trim();
  if (raw === "") return null;
  const lower = raw.toLowerCase();
  if (/behinder|冰蝎/.test(lower)) return "behinder";
  if (/godzilla|哥斯拉/.test(lower)) return "godzilla";
  if (/antsword|蚁剑/.test(lower)) return "antSword";
  if (lower === "custom" || lower === "custom-shell" || /自定义|自研/.test(raw)) return "custom";
  throw new Error(
    "webshell shell_type 非法：" +
      JSON.stringify(value) +
      "。交付要求是**冰蝎马（behinder）/ 哥斯拉马（godzilla）**（用户要能自己连上）；" +
      "其它类型请填 custom（只作临时中转，面板会标\"用户连不上\"）。",
  );
}

/**
 * 规范化马状态（界面按 `online` / `offline` / `unknown` 三态显示）。
 *
 * 空值默认 `online`：登记一条马时它刚打通，这是最诚实的默认。
 *
 * @throws 不在白名单内。
 */
export function normalizeShellStatus(value: unknown): ShellStatus {
  const raw = String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase();
  const aliases: Readonly<Record<string, ShellStatus>> = {
    up: "online",
    alive: "online",
    down: "offline",
    failed: "offline",
    removed: "dead",
  };
  const normalized = aliases[raw] ?? raw;
  if (normalized === "") return "online";
  if (!(WEBSHELL_STATUSES as readonly string[]).includes(normalized)) {
    throw new Error(
      "webshell status 非法：" + JSON.stringify(value) + "。合法值只有 " + WEBSHELL_STATUSES.join(" / ") + "。",
    );
  }
  return normalized as ShellStatus;
}

/** 真实路径；文件不存在或解析失败（悬空链接、权限）时返回 `null`。 */
function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 目标路径的"真实落点"—— 即使叶子不存在也尽量解析。
 *
 * 只对叶子做 `realpath` 会漏掉**最现实**的逃逸形态：
 * `<root>/out → /somewhere` 是软链，而智能体刚写下的 `<root>/out/leaf.txt` 还不存在。
 * 此时叶子的 `realpath` 必然失败，只能退回词法判定 —— 而词法判定恰好是通过的。
 *
 * 所以这里沿路径向上找到**最深的存在祖先**解析真实路径，再把剩余段拼回去。
 * 这样 `<root>/out/leaf.txt` 会解析成 `/somewhere/leaf.txt`，正确判为越界。
 *
 * @returns `{ real, existed }`；`existed` 表示整条路径（含叶子）是否真实存在。
 */
function resolveRealWithAncestors(abs: string): { readonly real: string | null; readonly existed: boolean } {
  const direct = realpathOrNull(abs);
  if (direct !== null) return { real: direct, existed: true };

  let cur = abs;
  const tail: string[] = [];
  /* 最多回溯到文件系统根，够用且必然终止 */
  while (true) {
    const parent = resolve(cur, "..");
    if (parent === cur) return { real: null, existed: false };
    const name = cur.slice(parent.length).replace(/^[/\\]+/, "");
    if (name !== "") tail.unshift(name);
    cur = parent;
    const realAncestor = realpathOrNull(cur);
    if (realAncestor !== null) {
      return { real: tail.length === 0 ? realAncestor : resolve(realAncestor, ...tail), existed: false };
    }
  }
}

/** 越界判定结果。 */
export type PathVerdict =
  | { readonly ok: true; readonly abs: string; readonly real: string | null }
  | { readonly ok: false; readonly abs: string; readonly real: string | null; readonly reason: "lexical" | "symlink" };

/**
 * 路径是否落在允许的根内（不抛异常的判定版）。
 *
 * @param target 待校验的路径（不可信）。
 * @param allowedRoots 允许的根目录。
 */
export function isPathWithin(target: unknown, allowedRoots: readonly string[] | undefined): boolean {
  return checkPathWithin(target, allowedRoots).ok;
}

/**
 * 判定并给出细节（失败也算成功返回，不抛）。
 *
 * 判定策略（顺序很重要）：
 *
 * 1. **目标真实存在** → **只**看解析后的真实路径是否落在（解析后的）真实根内。
 *    这一条同时解决两件事：堵住软链逃逸（词法通过、真实越界 → 拒绝），
 *    并让"根目录本身是软链"的正常部署（`$DSH_HOME` 挂到别的盘）不被误杀。
 * 2. **目标不存在** → 用 {@link resolveRealWithAncestors} 取最深存在祖先的真实落点再判。
 * 3. 连祖先都解析不了（全是悬空链接）→ 退回词法判定。此时调用方随后必然读不到文件。
 *
 * @param target 待校验的路径（不可信）。
 * @param allowedRoots 允许的根目录。
 */
export function checkPathWithin(target: unknown, allowedRoots: readonly string[] | undefined): PathVerdict {
  const abs = resolve(String(target ?? ""));
  const roots = (allowedRoots ?? []).filter((r): r is string => typeof r === "string" && r !== "").map((r) => resolve(r));
  const within = (p: string, list: readonly string[]): boolean =>
    list.some((root) => p === root || p.startsWith(root + sep));

  const realRoots = roots.map((r) => resolveRealWithAncestors(r).real ?? r);
  const { real } = resolveRealWithAncestors(abs);

  if (real !== null) {
    /* 真实落点可解析 → 以它为准（这是唯一安全的判定） */
    if (within(real, realRoots)) return { ok: true, abs, real };
    /* 词法通过而真实越界 = 软链逃逸；词法也越界就是普通越界 */
    return { ok: false, abs, real, reason: within(abs, roots) ? "symlink" : "lexical" };
  }

  /* 整条路径都解析不了：只能按词法判 */
  if (within(abs, roots)) return { ok: true, abs, real: null };
  return { ok: false, abs, real: null, reason: "lexical" };
}

/**
 * 路径必须在允许的根目录内（防目录穿越）。
 *
 * 为什么需要：`readAttackFile` / `pocGet` 读的是**数据库里的 path 列**，
 * 而那个列是智能体自己经 `addAttackFile` / `savePoc` 写进去的 —— 也就是不可信输入。
 * 一旦填成 `/etc/passwd` 或 `~/.ssh/id_rsa`，面板点一下就把文件读到浏览器里了。
 * `deletePoc` 早有 `startsWith` 防护，读路径与写路径却漏了，这里补成一处共用实现。
 *
 * @param target 待校验的路径。
 * @param allowedRoots 允许的根目录。
 * @returns 规范化后的绝对路径。
 * @throws 越界时抛错（调用方按"查不到"处理，不要静默返回内容）。
 */
export function assertPathWithin(target: unknown, allowedRoots: readonly string[] | undefined): string {
  const verdict = checkPathWithin(target, allowedRoots);
  if (verdict.ok) return verdict.abs;
  const roots = (allowedRoots ?? []).filter((r) => typeof r === "string" && r !== "");
  if (verdict.reason === "symlink") {
    throw new Error(
      "path escapes allowed roots through a symlink: " +
        verdict.abs +
        " -> " +
        String(verdict.real) +
        "（允许的根：" +
        roots.join(", ") +
        "）。解析软链后已不在本靶标目录内，已拒绝读取。",
    );
  }
  throw new Error(
    "path outside allowed roots: " +
      verdict.abs +
      "（允许的根：" +
      roots.join(", ") +
      "）。这条记录的文件路径不在本靶标目录内，已拒绝读取。",
  );
}
