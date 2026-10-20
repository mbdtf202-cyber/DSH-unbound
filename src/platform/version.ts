/**
 * 版本号比较与频道判定。
 *
 * 迁移自 dsh-qilin/lib/update.js 的纯逻辑部分。
 *
 * ## 一个已知的正确性弱点（保留，但显式记录）
 *
 * 原实现的 prerelease 比较是**字符串比较**：
 *   `versionIsNewer("1.2.0-beta10", "1.2.0-beta9")` → **false**（错，应为 true）
 * 因为 `"beta10" > "beta9"` 在字典序下为假（`"1" < "9"`）。
 *
 * 真正的 semver 要求按点分段、数字段按数值比较。
 * 这里**保留原行为**，因为改它会让「升级判定」与已发布版本历史产生偏移，
 * 属于需要单独决策的行为变更，不该夹带在迁移里。
 * 但把差异写成测试固定下来（见 `versionIsNewer` 的已知偏差用例），
 * 避免后人以为这里是正确的 semver 实现。
 */

/** 发布频道。 */
export type Channel = "stable" | "beta";

/** 把任意输入归一为频道。只有 `beta` 是 beta，其余（含空）都是 stable。 */
export function normalizeChannel(value: unknown): Channel {
  return String(value ?? "").toLowerCase() === "beta" ? "beta" : "stable";
}

/**
 * 版本名/引用名里是否含 beta 类标记。
 *
 * 识别 `-beta1`、`.rc2`、`_pre`、`preview3`、`test` 等
 * 作为**分隔后的独立词**出现的情况，避免误判 `betamax` 这种正常名字。
 */
export function isBetaName(name: unknown): boolean {
  return /(?:^|[-._])(beta|rc|pre|preview|test)(?:\d|$|[-._])/i.test(String(name ?? ""));
}

/** 拆出版本的主版本三元组与 prerelease 尾巴。 */
export function splitVersion(raw: unknown): {
  readonly core: readonly [number, number, number];
  readonly pre: string;
} {
  const text = String(raw ?? "").trim().replace(/^v/i, "");
  const cut = text.split("-");
  const coreText = String(cut[0] ?? "").split(".");
  const nums = coreText.map((n) => {
    const parsed = parseInt(n, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  return {
    core: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
    pre: cut.slice(1).join("-"),
  };
}

/**
 * remote 是否比 local 新。
 *
 * 规则（与原实现一致）：
 *  - remote 为空 → false
 *  - local 为空 → true（任何版本都比「没有」新）
 *  - 字符串完全相等 → false
 *  - 逐段比较主版本号
 *  - 同主版本：有 pre 的**旧于**无 pre 的（1.2.0-beta < 1.2.0）
 *  - 都有 pre：字符串比较（⚠️ 见文件头，不是严格的 semver）
 */
export function versionIsNewer(remote: unknown, local: unknown): boolean {
  if (!remote) return false;
  if (!local) return true;
  if (String(remote) === String(local)) return false;

  const a = splitVersion(remote);
  const b = splitVersion(local);
  for (let i = 0; i < 3; i += 1) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (a.pre !== "" && b.pre === "") return false;
  if (a.pre === "" && b.pre !== "") return true;
  return a.pre > b.pre;
}

/** 从版本列表里挑出最新的稳定版（排除 beta 频道与 beta 命名）。 */
export function latestStableVersion(
  versions: readonly { readonly version?: unknown; readonly channel?: unknown }[] | null | undefined,
): string {
  let best = "";
  for (const item of versions ?? []) {
    if (item === null || item === undefined) continue;
    if (item.channel === "beta") continue;
    const ver = String(item.version ?? "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+/.test(ver) || isBetaName(ver)) continue;
    if (best === "" || versionIsNewer(ver, best)) best = ver;
  }
  return best;
}

/**
 * 是否应把这个版本从「可选升级」列表里藏掉。
 *
 * 藏掉的三种情况：
 *  1. 被撤回的特定版本（1.1.11-beta 系列，历史事故版本）
 *  2. 频道是 beta
 *  3. 版本号/ref/id 里带 beta 类标记
 *
 * 例外：beta 分支的头本身（`ref === "beta"` 且 `channel === "beta"`）保留。
 */
export function hideListedVersion(item: {
  readonly version?: unknown;
  readonly ref?: unknown;
  readonly id?: unknown;
  readonly channel?: unknown;
} | null | undefined): boolean {
  if (item === null || item === undefined) return true;
  if (isWithdrawnVersion(item)) return true;
  if (item.ref === "beta" && item.channel === "beta") return false;
  return (
    item.channel === "beta" ||
    isBetaName(item.version) ||
    isBetaName(item.ref) ||
    isBetaName(item.id)
  );
}

/**
 * 历史上被撤回的版本。
 *
 * 原实现硬编码 `1.1.11-beta`：那个版本发出去有问题，必须永不提示升级。
 * 保留为常量+函数的形式，便于将来加更多撤回项。
 */
const WITHDRAWN_PATTERNS: readonly RegExp[] = [/(?:^|[\sv])1\.1\.11-beta/i];

export function isWithdrawnVersion(item: {
  readonly version?: unknown;
  readonly ref?: unknown;
  readonly id?: unknown;
} | null | undefined): boolean {
  if (item === null || item === undefined) return false;
  const text = [item.version, item.ref, item.id]
    .filter((v) => v !== undefined && v !== null && v !== "")
    .join(" ");
  const stripped = String(text).replace(/^v/i, " ");
  return WITHDRAWN_PATTERNS.some((re) => re.test(stripped));
}
