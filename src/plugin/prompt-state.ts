/**
 * 操作者正文（inject）的状态解析。
 *
 * ## 三种来源与优先级
 *
 *   1. `$DSH_HOME/prompt-inject.md`（用户点「保存」落盘的那份）——最高
 *   2. 本进程提示词框刚提交、还没落盘的正文
 *   3. 插件内置的加密默认（出厂稿）
 *
 * 原实现这一段散在 `core.js`（`defaultOverrideText` / `peekCommittedOverride` /
 * `hangOperatorPrompt` / `syncPromptInjectOnDiskSync`）与 `index.js`
 * （`refreshHungOperator` 的 mtime 缓存）里，互相依赖，无法单测。
 *
 * 这里把状态收进一个显式对象（`PromptState`），并把「加密默认」做成可注入的端口：
 * core.js 那 4,900 行不在本工作流的写入域内，等它迁移完成时把这个端口接上即可，
 * 行为契约由测试钉死。
 *
 * ## 高频读取的坑（原注释）
 *
 * `assemble` 空闲时 **33ms** 就调一次。原实现每轮都做 `statSync` + 3 次
 * `hashOverride`，等于每秒 30 次白做。所以：
 *   - 200ms 窗口内直接返回缓存，**连 stat 都不做**；
 *   - 窗口外先 stat，mtime 没变也复用（但刷新 `at`）。
 *
 * 顺序是「先看时间窗、再看 mtime」，不是反过来——原实现先 stat 再判缓存，
 * 缓存形同虚设。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 归一化：CRLF → LF，再 trim。所有比较与哈希都基于它。 */
export function normalizeOverride(text: unknown): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/** inject 的稳定哈希（用于判「是不是还是出厂默认」）。 */
export function hashOverride(text: unknown): string {
  return createHash("sha256").update(normalizeOverride(text), "utf8").digest("hex");
}

/**
 * 归一化 home。
 *
 * **不能直接用 `path.normalize`**：它对空串返回 `"."`（当前目录），
 * 于是「home 未知」会被当成「home = cwd」，把提示词挂到错误的键上。
 * 这个坑在 force-inject 之外很难发现——只有在 home 探测失败（无 DSH_HOME、
 * 非标准安装）时才暴露，而那时用户看到的是「注入串到了别的会话」。
 */
function normalizeHome(dshHome: string): string {
  const raw = String(dshHome ?? "").trim();
  return raw === "" ? "" : path.normalize(raw);
}

/** 拼接 `$DSH_HOME/prompt-inject.md`。 */
export function findOverrideFile(dshHome: string): string {
  return path.join(dshHome, "prompt-inject.md");
}

/** 读磁盘上的 inject 原文（去掉 BOM）；不存在 / 读失败 → 空串。 */
export function readPromptInjectFileSync(dshHome: string): string {
  const fp = findOverrideFile(dshHome);
  try {
    if (fs.existsSync(fp)) return fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
  } catch {
    /* 读失败当空：注入保底还有默认稿 */
  }
  return "";
}

/** inject 的解析结果。 */
export interface ResolvedInject {
  readonly text: string;
  readonly source: "prompt" | "default" | "none";
  readonly ruleId: null;
}

/**
 * 可注入的 prompt 状态端口。
 *
 * `bundledDefault` 是「插件内置加密稿」，迁移期由调用方提供；
 * 返回空串表示「本次构建没有内置稿」。
 */
export interface PromptStatePorts {
  readonly bundledDefault: () => string;
}

/** 本进程的内存态：提示词框提交的正文 + 挂上的正文。 */
export interface InProcessPrompt {
  readonly committed: { readonly home: string; readonly text: string } | null;
  readonly hung: string;
}

/**
 * 进程级状态。故意做成可重建的（不是模块级全局）：
 * 原实现的模块级 `committedOverride` / `hungOperatorPromptText` 在热重载后
 * 保留旧值，导致「改了名字的 home 还在用上一份挂稿」。
 */
export class PromptState {
  #committed: { home: string; text: string } | null = null;
  #hung = "";
  readonly #ports: PromptStatePorts;

  constructor(ports: PromptStatePorts = { bundledDefault: () => "" }) {
    this.#ports = ports;
  }

  /** 本次进程里提示词框刚提交的正文；与磁盘上用户自改正文合并使用。 */
  rememberCommitted(dshHome: string, text: string): void {
    const home = normalizeHome(dshHome);
    if (home === "") return;
    this.#committed = { home, text: typeof text === "string" ? text : "" };
  }

  /** 仅本进程提示词框提交；重启后为空，注入改读 prompt-inject.md（上游 #74）。 */
  peekCommitted(dshHome: string): string | null {
    const record = this.#committed;
    if (record === null) return null;
    const home = normalizeHome(dshHome);
    if (home === "" || home !== record.home) return null;
    return record.text;
  }

  /** 本进程挂上的操作者正文。 */
  hang(text: unknown): void {
    this.#hung = typeof text === "string" ? text : "";
  }

  hung(): string {
    return this.#hung;
  }

  /** 内置默认稿。 */
  bundledDefault(): string {
    return this.#ports.bundledDefault();
  }

  /** 内置默认稿的哈希（用于判「磁盘上的是不是出厂稿」）。 */
  bundledDefaultHash(): string {
    return hashOverride(this.#ports.bundledDefault());
  }

  /**
   * 解析注入正文。
   *
   * 顺序：磁盘 > 进程内提交 > 内置默认 > 空。
   * 「空」是明确的第四种状态（`source: "none"`），调用方据此决定要不要报
   * 「提示词和规则集都是空的」。
   */
  resolve(dshHome: string): ResolvedInject {
    const home = normalizeHome(dshHome);
    const disk = readPromptInjectFileSync(home);
    if (normalizeOverride(disk) !== "") {
      const source = hashOverride(disk) === this.bundledDefaultHash() ? "default" : "prompt";
      return { text: disk, source, ruleId: null };
    }
    const pinned = this.peekCommitted(home);
    if (typeof pinned === "string" && normalizeOverride(pinned) !== "") {
      return { text: pinned.replace(/\r\n/g, "\n"), source: "prompt", ruleId: null };
    }
    const bundled = this.bundledDefault();
    if (normalizeOverride(bundled) !== "") return { text: bundled, source: "default", ruleId: null };
    return { text: "", source: "none", ruleId: null };
  }

  /** 组装前挂上操作者正文（磁盘 / 进程提交 / 内置默认）。 */
  ensureOperatorBody(dshHome: string): string {
    const resolved = this.resolve(dshHome);
    if (resolved.text !== "") this.hang(resolved.text);
    return resolved.text !== "" ? resolved.text : normalizeOverride(this.hung());
  }
}

/** 缓存窗口（毫秒）。原实现同样是 200。 */
export const HUNG_CACHE_MS = 200;

/** 一次 refresh 的结果：解析结果 + 实际的挂上正文。 */
export interface RefreshedInject extends ResolvedInject {
  readonly text: string;
}

interface HungCacheEntry {
  readonly home: string;
  readonly mtime: number;
  readonly at: number;
  readonly resolved: RefreshedInject;
}

/** 读 inject 文件的 mtime（毫秒，向下取整）；不存在 → 0。 */
export function statInjectMtimeMs(dshHome: string): number {
  if (dshHome === "") return 0;
  try {
    return Math.floor(fs.statSync(findOverrideFile(dshHome)).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * inject 的高频读取缓存。
 *
 * 单独成类（而不是模块级变量）是为了可测：注入时钟后，
 * 「窗口内不 stat」「mtime 相同不重算」两条都能用计数断言。
 */
export class InjectRefreshCache {
  #entry: HungCacheEntry | null = null;
  readonly #state: PromptState;
  readonly #now: () => number;
  readonly #statMtime: (dshHome: string) => number;
  #statCalls = 0;

  constructor(options: {
    readonly state: PromptState;
    readonly now?: () => number;
    readonly statMtime?: (dshHome: string) => number;
  }) {
    this.#state = options.state;
    this.#now = options.now ?? (() => Date.now());
    this.#statMtime = options.statMtime ?? statInjectMtimeMs;
  }

  /** 统计 stat 次数（测试用）。 */
  statCalls(): number {
    return this.#statCalls;
  }

  /**
   * 刷新并返回当前 inject。
   *
   * 兜底顺序：resolved.text > 内置默认 > 空串。
   * 非空时同时 `hang` 与 `rememberCommitted`——后者是「框里刚提交但还没保存」
   * 的等价物，保证下一次组装还读得到这份全文。
   */
  refresh(dshHome: string): RefreshedInject {
    const home = normalizeHome(dshHome);
    const now = this.#now();
    const cached = this.#entry;
    if (cached !== null && cached.home === home && now - cached.at < HUNG_CACHE_MS) {
      return cached.resolved;
    }
    this.#statCalls += 1;
    const mtimeBefore = this.#statMtime(home);
    if (cached !== null && cached.home === home && cached.mtime === mtimeBefore) {
      this.#entry = { ...cached, at: now };
      return cached.resolved;
    }
    const resolved = this.#state.resolve(home);
    const fallback = normalizeOverride(this.#state.bundledDefault());
    const text = resolved.text !== "" ? resolved.text : fallback;
    if (text !== "") {
      this.#state.hang(text);
      this.#state.rememberCommitted(home, text);
    }
    const out: RefreshedInject = { ...resolved, text: text !== "" ? text : resolved.text };
    this.#statCalls += 1;
    this.#entry = { home, mtime: this.#statMtime(home), at: now, resolved: out };
    return out;
  }

  /** 丢弃缓存（home 切换 / 测试隔离）。 */
  reset(): void {
    this.#entry = null;
  }
}
