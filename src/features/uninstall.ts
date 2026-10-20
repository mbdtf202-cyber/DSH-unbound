/**
 * 卸载决策的纯逻辑。
 *
 * 迁移自 dsh-qilin/lib/uninstall.js 的判定部分。
 *
 * ## 为什么这块要格外小心
 *
 * 卸载会**删目录、改 package.json**。判错一次就可能毁掉用户的 profile 或整个插件树。
 * 所以这里的原则是：
 *   - 只删「明确属于本插件」的东西
 *   - 拿不准就**不删**（宁可留垃圾，也不误伤）
 *
 * ## 一个原实现里的坑
 *
 * `shouldDeletePluginTree` 的第二条规则是「在 `$DSH_HOME/profiles/` 下就允许删」。
 * 这条比听起来危险：如果 `dir` 恰好是 profiles 根本身（或某个 profile 的根），
 * 也会命中。原实现依赖调用方只传插件目录来规避，这里保持同样语义但把风险写清楚。
 */
import fs from "node:fs";
import path from "node:path";

/** 能安全处理的包名。 */
export const PLUGIN_NAME = "dsh-qilin";

/** 卸载前的状态快照（来自 gatherState）。 */
export interface AppliedState {
  readonly has_backup?: boolean;
  readonly patches_applied?: number | string;
  readonly shim_cmd?: string;
  readonly shim_ps1?: string;
  readonly shim_bin?: string;
}

/**
 * 是否曾经「应用」过补丁。
 *
 * 三种证据任一即可：有备份、有已应用补丁数、shim 被改成 patched。
 * 卸载时若曾应用过，必须先 revert 再删文件——否则用户宿主停在半改状态。
 */
export function wasApplied(state: AppliedState | null | undefined): boolean {
  if (state === null || state === undefined) return false;
  if (state.has_backup === true) return true;
  if (Number(state.patches_applied) > 0) return true;
  const shims = [state.shim_cmd, state.shim_ps1, state.shim_bin];
  return shims.includes("patched");
}

/** 路径归一：反斜杠转正斜杠、小写、去掉末尾斜杠。 */
function normPath(p: string): string {
  return p.replace(/[/\\]+/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * 这个目录能否被整棵删除。
 *
 * 命中任一即允许：
 *   1. 路径里含 `<sep>node_modules/dsh-qilin`（明确是插件安装目录）
 *   2. 位于 `$DSH_HOME/profiles/` 之下（插件装进 profile 的形态）
 *
 * 其余一律返回 false —— 拿不准就不删。
 */
export function shouldDeletePluginTree(dir: string | null | undefined, dshHome: string): boolean {
  if (dir === null || dir === undefined || dir === "") return false;

  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = path.resolve(dir);
  }
  const n = normPath(real);

  if (n.includes(`/node_modules/${PLUGIN_NAME}`)) return true;

  let home: string;
  try {
    home = fs.realpathSync(dshHome);
  } catch {
    home = path.resolve(dshHome);
  }
  const homeN = normPath(home);
  return n.startsWith(`${homeN}/profiles/`);
}

/** package.json 里各种「插件清单」的条目形状。 */
type BundleItem = string | { readonly id?: string; readonly name?: string; readonly package?: string };

/**
 * 这一条是不是本插件。
 *
 * 支持两种写法：字符串（`dsh-qilin` / `dsh-qilin@1.2.0`）与对象（`id`/`name`/`package` 任一命中）。
 * `@` 后面跟版本号要能识别，否则升级过的条目会漏删。
 */
export function isPluginBundleItem(item: BundleItem): boolean {
  if (typeof item === "string") {
    return item === PLUGIN_NAME || item.startsWith(`${PLUGIN_NAME}@`);
  }
  if (item === null || typeof item !== "object") return false;
  const id = item.id ?? item.name ?? item.package;
  return id === PLUGIN_NAME;
}

/** 从列表里剔除本插件。返回新列表与是否有变化（不改原数组）。 */
export function stripPluginFromList(list: unknown): { readonly list: unknown; readonly changed: boolean } {
  if (!Array.isArray(list)) return { list, changed: false };
  const next = (list as BundleItem[]).filter((item) => !isPluginBundleItem(item));
  return { list: next, changed: next.length !== list.length };
}

/** 会被清理的声明字段。 */
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
/** 会被清理的清单字段。 */
const LIST_FIELDS = ["bundles", "plugins"] as const;

/**
 * 从 package.json 对象里剔掉本插件的所有痕迹。
 *
 * 覆盖两处层级：
 *   - 顶层 `dependencies` 等四类依赖表
 *   - 顶层 `bundles` / `plugins`，以及 `dsh.profile` 下的同名两个字段
 *
 * **原地修改**传入对象并返回是否有变化（原实现语义，调用方依赖这个原地性）。
 */
export function stripPluginFromPackage(pkg: Record<string, unknown> | null | undefined): boolean {
  if (pkg === null || pkg === undefined || typeof pkg !== "object") return false;
  let changed = false;

  for (const key of DEP_FIELDS) {
    const table = pkg[key];
    if (table !== null && typeof table === "object" && Object.prototype.hasOwnProperty.call(table, PLUGIN_NAME)) {
      delete (table as Record<string, unknown>)[PLUGIN_NAME];
      changed = true;
    }
  }

  for (const key of LIST_FIELDS) {
    const result = stripPluginFromList(pkg[key]);
    if (result.changed) {
      pkg[key] = result.list;
      changed = true;
    }
  }

  const dsh = pkg["dsh"];
  if (dsh !== null && typeof dsh === "object") {
    const profile = (dsh as Record<string, unknown>)["profile"];
    if (profile !== null && typeof profile === "object") {
      for (const key of LIST_FIELDS) {
        const result = stripPluginFromList((profile as Record<string, unknown>)[key]);
        if (result.changed) {
          (profile as Record<string, unknown>)[key] = result.list;
          changed = true;
        }
      }
    }
  }

  return changed;
}

/** package.json 里是否还提到本插件（不需要真改也能判定）。 */
export function pkgMentionsPlugin(pkg: Record<string, unknown> | null | undefined): boolean {
  if (pkg === null || pkg === undefined || typeof pkg !== "object") return false;

  for (const key of DEP_FIELDS) {
    const table = pkg[key];
    if (table !== null && typeof table === "object" && Object.prototype.hasOwnProperty.call(table, PLUGIN_NAME)) {
      return true;
    }
  }
  for (const key of LIST_FIELDS) {
    const list = pkg[key];
    if (Array.isArray(list) && list.some((item) => isPluginBundleItem(item as BundleItem))) return true;
  }
  const dsh = pkg["dsh"];
  if (dsh !== null && typeof dsh === "object") {
    const profile = (dsh as Record<string, unknown>)["profile"];
    if (profile !== null && typeof profile === "object") {
      for (const key of LIST_FIELDS) {
        const list = (profile as Record<string, unknown>)[key];
        if (Array.isArray(list) && list.some((item) => isPluginBundleItem(item as BundleItem))) return true;
      }
    }
  }
  return false;
}
