#!/usr/bin/env node
/**
 * dsh-unbound CLI。
 *
 * 命令设计原则：
 *  - `status` / `drift` 是**只读**的，可以随便跑；
 *  - `apply` / `revert` 会写宿主文件，必须先备份；
 *  - 所有命令都支持 `--json` 方便脚本消费；
 *  - 退出码有语义：0 成功，1 需要人工介入（漂移/失败），2 用法错误。
 */
import process from "node:process";
import { loadBundledPatches } from "../patches/load.js";
import { applyPatches, revertPatches } from "../engine/apply.js";
import { diagnoseAll, driftExitCode, formatDriftReport } from "../engine/drift.js";
import { discoverHosts, findHost } from "../host/discover.js";
import { isAiBase, resolveTarget } from "../host/targets.js";
import type { ApplyReport } from "../engine/apply.js";

interface Args {
  readonly command: string;
  readonly aiBase: string | undefined;
  readonly surface: "web" | "desktop" | undefined;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly only: readonly number[];
  readonly skip: readonly number[];
}

const USAGE = `dsh-unbound — type-safe DeepSeek Harness patcher

用法:
  dsh-unbound status   [--ai-base PATH] [--json]
  dsh-unbound drift    [--ai-base PATH] [--json] [--verbose]
  dsh-unbound apply    [--ai-base PATH] [--surface web|desktop] [--dry-run] [--only 1,2] [--skip 3]
  dsh-unbound revert   [--ai-base PATH] [--dry-run]
  dsh-unbound hosts    [--json]          列出发现的所有宿主
  dsh-unbound targets  [--ai-base PATH]   打印每个补丁目标的解析结果

选项:
  --ai-base PATH   指定 @deepseek-ai 包目录（省略则自动探测）
  --surface NAME   限定 web 或 desktop 专属补丁
  --dry-run        只报告会改什么，不写盘
  --only LIST      只处理这些 id（逗号分隔正整数，如 --only 1,2）
  --skip LIST      跳过这些 id（逗号分隔正整数，如 --skip 3）
  --json           机器可读输出
  --verbose, -v    详情
  --help, -h       本帮助

每个子命令也支持 \`dsh-unbound <命令> --help\` 看自己的说明。

退出码:
  0  成功 / 无漂移
  1  存在需要人工介入的漂移或失败
  2  用法错误
`;

/**
 * 每个子命令的专属帮助。
 *
 * 为什么需要：早先 `<命令> --help` 一律打印全局用法，用户在 `apply --help` 里
 * 看不到 `--only`/`--skip`/`--dry-run` 各自的作用与取舍，只能去翻 README。
 * 帮助文本本身就是交付物的一部分，缺了等于接口没有文档。
 */
const COMMAND_HELP: Readonly<Record<string, string>> = {
  status: `dsh-unbound status — 诊断每条补丁在本宿主上的状态（只读）

用法:
  dsh-unbound status [--ai-base PATH] [--json] [--verbose]

说明:
  与 drift 输出相同的诊断，但**总是退出 0**（不把漂移当失败）。
  适合只想看一眼状态的场景；CI 里请用 drift（它有退出码语义）。

状态含义:
  healthy         所有 pattern 仍命中，可以正常打
  applied         已带标记（打完且未回退）
  partial         部分 pattern 命中（最危险：看起来能用）
  dead            0 命中，整条失效
  absent          目标文件不在本宿主（非失败）
  reverted        命中 forbid 标记（曾被回滚）
  pending-upgrade 升级链补丁未就位（非漂移）

退出码: 恒为 0（--ai-base 非法时为 2）
`,

  drift: `dsh-unbound drift — 检测上游漂移，带退出码（只读，可进 CI）

用法:
  dsh-unbound drift [--ai-base PATH] [--json] [--verbose]

说明:
  上游改版会把 pattern 改掉，补丁随之静默 no-op。本命令把这件事变成
  可重复执行、可进 CI 的检查。

退出码（契约）:
  0  broken === 0           没有需要人工重核的补丁
  1  broken > 0             partial + dead > 0，需要重核 pattern
  2  --ai-base 非法

注意 absent **不算失败**：桌面专属补丁在 web 宿主上本来就没有目标。

--verbose 额外列出每个 broken 补丁的目标文件与失效 pattern 摘要。
`,

  apply: `dsh-unbound apply — 把补丁打到宿主（会写盘；先备份）

用法:
  dsh-unbound apply [--ai-base PATH] [--surface web|desktop]
                    [--dry-run] [--only 1,2] [--skip 3] [--json] [--verbose]

选项:
  --dry-run        算出会发生什么，但一个字节都不写
  --only LIST      只处理这些 id（逗号分隔正整数）；省略或空 = 不过滤
  --skip LIST      跳过这些 id；优先级高于 --only
  --surface NAME   只处理该 surface 的补丁（web | desktop）
  --verbose        列出每个被改动/出错的文件

幂等性契约:
  对已 apply 过的宿主再跑一次，filesChanged 必须为 0。

备份与回滚:
  首次改动某文件时生成 <file>.dsh-unbound.bak（若已有 .dshqilin.bak 则复用它，
  不会用「已打过补丁的当前文件」污染备份）。revert 用它还原原文。

退出码:
  0  failed === 0
  1  failed > 0（读失败 / 写失败）
  2  用法错误
`,

  revert: `dsh-unbound revert — 从备份还原被本工具改过的文件（会写盘）

用法:
  dsh-unbound revert [--ai-base PATH] [--dry-run] [--json]

说明:
  只还原**有备份的**文件。没有备份说明本工具没动过它，
  还原它等于用旧版覆盖用户刚升级的宿主——那比不还原更糟。
  因此无备份的文件被列进 missing 并原样保留。

备份优先级: <file>.dsh-unbound.bak  >  <file>.dshqilin.bak（旧的 qilin 备份）

--dry-run 只列出会还原哪些文件，不写盘。

退出码: 恒为 0（--ai-base 非法时为 2）
`,

  hosts: `dsh-unbound hosts — 列出本机发现的所有 DeepSeek Harness 宿主

用法:
  dsh-unbound hosts [--json]

说明:
  扫描已知安装位置，输出每条宿主的 surface（web / desktop）与 aiBase 路径。
  拿到路径后可用 --ai-base 显式指定给其它命令。

退出码: 恒为 0
`,

  targets: `dsh-unbound targets — 打印每个补丁文件 key 的解析结果

用法:
  dsh-unbound targets [--ai-base PATH] [--json]

说明:
  对补丁表里用到的每个 file key，显示它在当前宿主上解析到哪些绝对路径。
  " -- " 表示该 key 在本宿主上没有命中（对应补丁会判 missing_file / absent）。

用途: 上游改了包布局、补丁突然大面积 missing_file 时，先跑这个看是哪个 key 解析空了。

退出码: 恒为 0（--ai-base 非法时为 2）
`,
};

/**
 * 本 CLI 认识的所有选项。
 *
 * 用途：区分「`--only` 后面没值」与「`--only -1`（值本身以 - 开头但确实是坏值）」。
 * 只有下一个 token 是本表里的选项时，才认定「缺值」。
 */
const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "--ai-base",
  "--surface",
  "--only",
  "--skip",
  "--json",
  "--dry-run",
  "--verbose",
  "-v",
  "--help",
  "-h",
]);

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let aiBase: string | undefined;
  let surface: "web" | "desktop" | undefined;
  let json = false;
  let dryRun = false;
  let verbose = false;
  let only: number[] = [];
  let skip: number[] = [];

  const numlist = (v: string, flag: string): number[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) {
          console.error(`${flag} expects comma-separated positive integers, got "${s}"`);
          process.exit(2);
        }
        return n;
      });

  /**
   * 取下一个参数作为值。
   *
   * 关键：**不能**把「缺失」或「下一个是另一个 flag」当成空值静默接受。
   * 早先 `--only` 后面没跟值时会退化成「不过滤」，也就是**打全部补丁**——
   * 对一个会写宿主的命令来说，把「我只想打 #1」误解成「打全部」是最坏的方向。
   *
   * 注意 `-1` 这种**看起来像 flag 的坏值**：它应当被当成「值」收下，
   * 再交给 numlist 报 "got \"-1\""，而不是报缺值。否则用户写
   * `--only -1` 得到的提示是「你没给值」，与实际错误完全不同。
   */
  const takeValue = (cursor: { i: number }, flag: string): string => {
    const v = argv[cursor.i + 1];
    // 只有「下一个是已知选项」才算缺值；其它以 - 开头的东西照收，交给后续校验。
    const looksLikeKnownOption = v !== undefined && v.startsWith("-") && KNOWN_OPTIONS.has(v);
    if (v === undefined || looksLikeKnownOption) {
      console.error(`${flag} requires a value (用法: ${flag} 1,2)`);
      process.exit(2);
    }
    cursor.i += 1;
    return v;
  };

  // `--help` 的位置决定打印哪份帮助：`apply --help` 要看 apply 的说明。
  const commandHint = argv.find((a) => !a.startsWith("-"));

  const cursor = { i: 0 };
  for (; cursor.i < argv.length; cursor.i += 1) {
    const i = cursor.i;
    const a = argv[i]!;
    if (a === "--ai-base") {
      aiBase = takeValue(cursor, "--ai-base");
    } else if (a === "--surface") {
      const v = argv[i + 1];
      if (v !== "web" && v !== "desktop") {
        console.error('--surface must be "web" or "desktop"');
        process.exit(2);
      }
      surface = v;
      cursor.i += 1;
    } else if (a === "--only") {
      only = numlist(takeValue(cursor, "--only"), "--only");
    } else if (a === "--skip") {
      skip = numlist(takeValue(cursor, "--skip"), "--skip");
    } else if (a === "--json") {
      json = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--verbose" || a === "-v") {
      verbose = true;
    } else if (a === "--help" || a === "-h") {
      const specific = commandHint === undefined ? undefined : COMMAND_HELP[commandHint];
      console.log(specific ?? USAGE);
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`unknown option: ${a}\n`);
      console.error(USAGE);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }

  return {
    command: positional[0] ?? "status",
    aiBase,
    surface,
    json,
    dryRun,
    verbose,
    only,
    skip,
  };
}

/** 解析目标 aiBase；找不到就给可操作的报错。 */
function resolveAiBase(args: Args): string {
  if (args.aiBase !== undefined) {
    if (!isAiBase(args.aiBase)) {
      console.error(
        `--ai-base 不是有效的 @deepseek-ai 包目录：${args.aiBase}\n` +
          "  要求：目录名是 @deepseek-ai，且里面有 dsh-* 包。",
      );
      process.exit(2);
    }
    return args.aiBase;
  }
  const host = findHost(args.surface);
  if (host === null) {
    console.error("未找到宿主。请用 --ai-base 指定 @deepseek-ai 包目录，或先跑 `dsh-unbound hosts`。");
    process.exit(1);
  }
  return host.aiBase;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function reportJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function formatApply(report: ApplyReport, verbose: boolean): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`aiBase: ${report.aiBase}`);
  lines.push(
    `total ${s.total} | applied ${s.applied} | already ${s.already} | ` +
      `pattern_not_found ${s.patternNotFound} | missing ${s.missingFile} | ` +
      `skipped ${s.skipped} | failed ${s.failed}`,
  );
  lines.push(`files changed: ${s.filesChanged}`);

  const interesting = report.outcomes.filter(
    (o) => o.status !== "already" && o.status !== "na" && o.status !== "skipped",
  );
  if (interesting.length > 0) {
    lines.push("");
    for (const o of interesting) {
      lines.push(`  #${pad(o.patchId, 3)} ${pad(o.status, 17)} ${o.name}`);
      if (verbose) {
        for (const f of o.changedFiles) lines.push(`        wrote: ${f}`);
        if (o.error !== undefined) lines.push(`        error: ${o.error}`);
      }
    }
  }
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const patches = loadBundledPatches();

  switch (args.command) {
    case "hosts": {
      const hosts = discoverHosts();
      if (args.json) {
        reportJson(hosts);
        return;
      }
      if (hosts.length === 0) {
        console.log("未发现任何宿主。");
        return;
      }
      for (const h of hosts) console.log(`${pad(h.surface, 8)} ${h.aiBase}   (via ${h.via})`);
      return;
    }

    case "targets": {
      const aiBase = resolveAiBase(args);
      const keys = [...new Set(patches.flatMap((p) => p.fileKeys))].sort();
      let resolved = 0;
      for (const key of keys) {
        const r = resolveTarget(key, aiBase);
        if (r.paths.length > 0) resolved += 1;
        if (args.json) continue;
        const mark = r.paths.length > 0 ? "OK  " : " -- ";
        console.log(`${mark} ${pad(key, 32)} ${pad(r.via, 9)} ${r.paths.join(", ")}`);
      }
      if (args.json) {
        reportJson(
          keys.map((k) => ({ key: k, ...resolveTarget(k, aiBase) })),
        );
        return;
      }
      console.log(`\nresolved ${resolved}/${keys.length} target keys`);
      return;
    }

    case "status": {
      const aiBase = resolveAiBase(args);
      const report = diagnoseAll(patches, aiBase);
      if (args.json) {
        reportJson(report);
      } else {
        console.log(formatDriftReport(report, { verbose: args.verbose }));
      }
      return;
    }

    case "drift": {
      const aiBase = resolveAiBase(args);
      const report = diagnoseAll(patches, aiBase);
      if (args.json) {
        reportJson(report);
      } else {
        console.log(formatDriftReport(report, { verbose: args.verbose }));
      }
      process.exit(driftExitCode(report));
      return;
    }

    case "apply": {
      const aiBase = resolveAiBase(args);
      const report = applyPatches(patches, aiBase, {
        ...(args.surface !== undefined ? { surface: args.surface } : {}),
        dryRun: args.dryRun,
        ...(args.only.length > 0 ? { only: args.only } : {}),
        ...(args.skip.length > 0 ? { skip: args.skip } : {}),
      });
      if (args.json) {
        reportJson(report);
      } else {
        if (args.dryRun) console.log("(dry-run: 没有写任何文件)\n");
        console.log(formatApply(report, args.verbose));
      }
      process.exit(report.summary.failed > 0 ? 1 : 0);
      return;
    }

    case "revert": {
      const aiBase = resolveAiBase(args);
      const result = revertPatches(patches, aiBase, { dryRun: args.dryRun });
      if (args.json) {
        reportJson(result);
      } else {
        if (args.dryRun) console.log("(dry-run: 没有写任何文件)\n");
        console.log(`restored ${result.restored.length} file(s)`);
        for (const f of result.restored) console.log(`  ${f}`);
        if (result.missing.length > 0) {
          console.log(`no backup for ${result.missing.length} file(s) (未改动):`);
          for (const f of result.missing) console.log(`  ${f}`);
        }
      }
      process.exit(0);
      return;
    }

    default: {
      console.error(`unknown command: ${args.command}\n`);
      console.error(USAGE);
      process.exit(2);
    }
  }
}

main();
