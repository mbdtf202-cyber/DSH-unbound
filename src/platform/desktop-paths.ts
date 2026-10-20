/**
 * 桌面安装形态判定（纯路径逻辑，不碰平台 API）。
 *
 * 迁移自 dsh-qilin/lib/desktop.js 的判定部分。
 *
 * ## 这里有一条用 bug 换来的教训
 *
 * `looksLikeDesktopName()` 用 `includes("/deepseek harness/")` 匹配，会命中**任意祖先目录**。
 * 而 npm 前缀（`D:\DeepSeek Harness\npm-global\…`）和 DSH_HOME 的父目录恰好都叫这个名字，
 * 于是 Web 安装根被误判成桌面安装 —— 接着 `findAiBaseWeb` 里每处
 * `!isInsideDesktopInstall(cand)` 守卫都会把正确答案踢掉，Web 面定位不到宿主。
 *
 * 修正版 `looksLikeDesktopNameTail()` 只看路径最后一段。
 * 两个函数都保留（旧调用点仍在用宽匹配），但新的判定一律走 Tail 版。
 *
 * ## 为什么不合并成一个
 *
 * 语义不同：宽匹配回答「这个路径是否在某棵桌面安装树里」，
 * 严格匹配回答「这一级目录本身是否就是安装根」。合并会让其中一个失真。
 */
import path from "node:path";

/** 路径归一：分隔符转 `/`、转小写、去尾斜杠。 */
export function slashNorm(p: string): string {
  return path.normalize(String(p ?? "")).replace(/\\/g, "/").toLowerCase();
}

/**
 * child 是否在 root 之下（含相等）。
 *
 * 拒绝三种退化情况，否则会误判：
 *  - 空路径
 *  - root 是根目录 `/`（任何路径都在其下，等于「永远为真」）
 *  - root 是盘符本身（`c:`，同上）
 */
export function isSubPath(child: string, root: string): boolean {
  const c = slashNorm(child).replace(/\/+$/, "");
  const r = slashNorm(root).replace(/\/+$/, "");
  if (c === "" || r === "" || r === "/") return false;
  if (/^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

/** 官方宿主可执行文件的基本名（小写）。 */
const OFFICIAL_HARNESS_BASES: ReadonlySet<string> = new Set([
  "deepseek harness.exe",
  "deepseek-harness.exe",
  "deepseek harness",
  "deepseek-harness",
]);

/** 该基本名是否像官方 DeepSeek Harness 的可执行文件。 */
export function isOfficialHarnessBaseName(base: string): boolean {
  const b = String(base ?? "").toLowerCase();
  if (OFFICIAL_HARNESS_BASES.has(b)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(b);
}

/**
 * 宽匹配：路径里任意位置出现桌面安装名。
 *
 * ⚠️ 会命中祖先目录。仅用于「这棵树里可能有桌面安装」的粗筛，
 * 不要用它单独判定某个目录是不是安装根（见 looksLikeDesktopNameTail）。
 */
export function looksLikeDesktopName(p: string): boolean {
  const n = slashNorm(p);
  if (n === "") return false;
  return (
    n.includes("/dsh desktop/") ||
    n.includes("/dsh desktop.app/") ||
    n.endsWith("/dsh desktop") ||
    n.endsWith("/dsh desktop.app") ||
    n.includes("dsh-desktop") ||
    n.includes("/deepseek harness/") ||
    n.includes("/deepseek-harness/") ||
    n.includes("/deepseekharness") ||
    /\/deepseek[\s._-]*harness(\/|$)/.test(n) ||
    n.includes("/deepseek harness.app/") ||
    n.endsWith("/deepseek harness.app") ||
    /\/dsh desktop\.exe$/i.test(n) ||
    /\/deepseek[\s._-]*harness\.exe$/i.test(n)
  );
}

/**
 * 严格匹配：只看路径**最后一段**是否就是安装根的名字。
 *
 * 这是修正祖先目录误判后的版本。所有新判定都应该用它。
 */
export function looksLikeDesktopNameTail(p: string): boolean {
  const n = slashNorm(p).replace(/\/+$/, "");
  if (n === "") return false;
  const cut = n.lastIndexOf("/");
  const tail = cut >= 0 ? n.slice(cut + 1) : n;
  if (tail === "") return false;
  return (
    tail === "dsh desktop" ||
    tail === "dsh desktop.app" ||
    tail === "deepseek harness" ||
    tail === "deepseek harness.app" ||
    tail === "deepseek-harness" ||
    tail === "deepseekharness" ||
    /^dsh-desktop/.test(tail) ||
    /^deepseek[\s._-]*harness(\.exe)?$/.test(tail)
  );
}

/** 该文件路径是否像桌面端的可执行文件。 */
export function isDesktopExecutable(fp: string): boolean {
  const base = path.basename(String(fp ?? "")).toLowerCase();
  if (base === "dsh desktop.exe" || base === "dsh desktop") return true;
  if (OFFICIAL_HARNESS_BASES.has(base)) return true;
  return /^deepseek[\s._-]*harness(\.exe)?$/.test(base);
}

/**
 * 只有官方 DeepSeek Harness 会把宿主封进 app.asar 并在「应用」时解开。
 * 第三方 DSH Desktop 不走这条路径。
 */
export function isOfficialHarnessExecutable(fp: string): boolean {
  return isOfficialHarnessBaseName(path.basename(String(fp ?? "")));
}

/**
 * 某个安装目录下可能的 resources 目录候选。
 *
 * mac 的盘可能大小写敏感，所以 `Resources` 和 `resources` 都要试。
 * 顺序即优先顺序。
 */
export function resourceDirCandidates(installDir: string): readonly string[] {
  if (installDir === "") return [];
  const name = path.basename(installDir);
  const lower = name.toLowerCase();

  // 可执行文件在 .app/Contents/MacOS/ 里
  if (lower === "macos") {
    const contents = path.dirname(installDir);
    return [path.join(contents, "Resources"), path.join(contents, "resources")];
  }
  if (lower === "contents") {
    return [path.join(installDir, "Resources"), path.join(installDir, "resources")];
  }
  if (lower.endsWith(".app")) {
    return [
      path.join(installDir, "Contents", "Resources"),
      path.join(installDir, "Contents", "resources"),
    ];
  }
  // 已经指着 resources 目录本身时，唯一候选就是它（再拼一层 resources 就错了）
  if (lower === "resources") return [installDir];
  return [path.join(installDir, "resources"), path.join(installDir, "Resources")];
}

/** 文件系统探测注入，便于单测（默认走真 fs）。 */
export interface FsProbe {
  readonly isFile: (p: string) => boolean;
  readonly isDir: (p: string) => boolean;
}

/**
 * 从可执行文件路径推出它所属安装的 resources 目录。
 *
 * 三段优先（与原实现一致）：
 *   1. 含 app.asar 的候选 —— 官方封包形态最确定
 *   2. 存在的目录
 *   3. 第一个候选（都不存在时仍给出合理默认，让调用方决定后续）
 */
export function resourcesDirForExecutable(exe: string, probe: FsProbe): string {
  const exeDir = path.dirname(path.normalize(String(exe ?? "")));
  if (exeDir === "") return "";
  const candidates = resourceDirCandidates(exeDir);
  const withAsar = candidates.find((dir) => probe.isFile(path.join(dir, "app.asar")));
  if (withAsar !== undefined) return withAsar;
  const existing = candidates.find((dir) => probe.isDir(dir));
  if (existing !== undefined) return existing;
  return candidates[0] ?? "";
}

/** 官方宿主封包路径：resources/app.asar */
export function appAsarPath(exe: string, probe: FsProbe): string {
  const dir = resourcesDirForExecutable(exe, probe);
  return dir === "" ? "" : path.join(dir, "app.asar");
}

/** 官方宿主解开后的目录：resources/app */
export function appDirForExecutable(exe: string, probe: FsProbe): string {
  const dir = resourcesDirForExecutable(exe, probe);
  return dir === "" ? "" : path.join(dir, "app");
}

/** asar 封包路径判定。 */
export function isAsarSealedPath(p: string): boolean {
  return slashNorm(p).endsWith(".asar");
}
