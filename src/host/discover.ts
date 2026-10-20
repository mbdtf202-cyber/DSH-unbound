/**
 * 宿主发现。
 *
 * 目标：找到所有需要打补丁的 `@deepseek-ai` 包目录（aiBase）。
 *
 * ## 与原实现的取舍
 *
 * 原 dsh-qilin 的 findAiBase() 有 300+ 行，包含：
 *   - 从 require 解析、从运行进程、从 DSH_HOME 推断
 *   - 从 npm prefix / shim 目录猜
 *   - 最后递归扫描 $HOME（原注释自述实测 94 秒 / 十万次 fs 调用）
 *
 * 递归扫描那一段**必须去掉**：它把一个「启动路径」变成了「磁盘全盘搜」，
 * 而且结果不确定（先扫到哪个算哪个）。这里只做**确定性**探测：
 *   1. 显式 DSH_BASE
 *   2. 从正在运行的宿主进程路径推断
 *   3. 从 DSH_HOME 下的 profiles 目录推断（profiles/{name}/node_modules）
 *   4. macOS 桌面 app 的 Resources/app/dsh/node_modules
 *
 * 找不到就明确报错，让用户用 --ai-base 指定——比静默扫半小时好。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDirectory } from "../fs/atomic.js";
import { isAiBase } from "./targets.js";

export interface HostCandidate {
  readonly aiBase: string;
  readonly surface: "web" | "desktop";
  /** 探测来源，便于用户判断「为什么选了这个」。 */
  readonly via: string;
}

/** DSH_HOME：显式环境变量优先，Windows 上 HOME 常空所以回退 homedir。 */
export function findDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["DSH_HOME"];
  if (explicit !== undefined && explicit.trim() !== "") return path.normalize(explicit.trim());
  return path.join(os.homedir(), ".dsh");
}

function isDesktopPath(p: string): boolean {
  const n = path.normalize(p).replace(/\\/g, "/").toLowerCase();
  return n.includes("/resources/app") || n.includes(".app/contents/resources");
}

function candidate(aiBase: string, via: string): HostCandidate | null {
  if (!isAiBase(aiBase)) return null;
  return {
    aiBase: path.normalize(aiBase),
    surface: isDesktopPath(aiBase) ? "desktop" : "web",
    via,
  };
}

/** 在 profiles/<name>/node_modules 下找 aiBase。 */
function profileCandidates(dshHome: string): HostCandidate[] {
  const out: HostCandidate[] = [];
  const profilesDir = path.join(dshHome, "profiles");
  if (!isDirectory(profilesDir)) return out;
  let names: string[] = [];
  try {
    names = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const base = path.join(profilesDir, name, "node_modules", "@deepseek-ai");
    const hit = candidate(base, `profile:${name}`);
    if (hit) out.push(hit);
  }
  return out;
}

/** macOS 桌面安装：/Applications/<X>.app/Contents/Resources/app/{dsh,}/node_modules/@deepseek-ai */
function desktopCandidates(): HostCandidate[] {
  const out: HostCandidate[] = [];
  const appDirs = ["/Applications"];
  for (const root of appDirs) {
    if (!isDirectory(root)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.endsWith(".app")) continue;
      const resources = path.join(root, e.name, "Contents", "Resources", "app");
      for (const sub of ["dsh", ""]) {
        const base = sub === "" ? path.join(resources, "node_modules", "@deepseek-ai") : path.join(resources, sub, "node_modules", "@deepseek-ai");
        const hit = candidate(base, `desktop:${e.name}`);
        if (hit) out.push(hit);
      }
    }
  }
  return out;
}

/** 从运行中的进程路径（process.argv / execPath）推断，用于「宿主自己被加载」的场景。 */
function runningProcessCandidates(env: NodeJS.ProcessEnv): HostCandidate[] {
  const out: HostCandidate[] = [];
  const bases: string[] = [];
  const entry = process.argv[1];
  if (entry !== undefined) bases.push(path.dirname(entry));
  if (process.execPath !== "") bases.push(path.dirname(process.execPath));
  for (const start of bases) {
    let dir = start;
    for (let up = 0; up < 10; up += 1) {
      const probe = path.join(dir, "node_modules", "@deepseek-ai");
      const hit = candidate(probe, "process");
      if (hit) {
        out.push(hit);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const explicit = env["DSH_BASE"];
  if (explicit !== undefined && explicit.trim() !== "") {
    const hit = candidate(path.normalize(explicit.trim()), "DSH_BASE");
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * 发现所有宿主候选（去重，按可信度排序）。
 *
 * 排序理由：显式 > 进程 > 桌面 > profile。用户明确指定的永远优先。
 */
export function discoverHosts(env: NodeJS.ProcessEnv = process.env): readonly HostCandidate[] {
  const dshHome = findDshHome(env);
  const found: HostCandidate[] = [
    ...runningProcessCandidates(env),
    ...desktopCandidates(),
    ...profileCandidates(dshHome),
  ];

  const seen = new Set<string>();
  const out: HostCandidate[] = [];
  for (const c of found) {
    const key = c.aiBase.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 语法糖：只取第一个匹配 surface 的宿主。 */
export function findHost(
  surface?: "web" | "desktop",
  env: NodeJS.ProcessEnv = process.env,
): HostCandidate | null {
  const all = discoverHosts(env);
  if (surface === undefined) return all[0] ?? null;
  return all.find((c) => c.surface === surface) ?? null;
}
