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
  --json           机器可读输出
  --verbose, -v    详情
  --help, -h       本帮助

退出码:
  0  成功 / 无漂移
  1  存在需要人工介入的漂移或失败
  2  用法错误
`;

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

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--ai-base") {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error("--ai-base requires a path");
        process.exit(2);
      }
      aiBase = v;
      i += 1;
    } else if (a === "--surface") {
      const v = argv[i + 1];
      if (v !== "web" && v !== "desktop") {
        console.error('--surface must be "web" or "desktop"');
        process.exit(2);
      }
      surface = v;
      i += 1;
    } else if (a === "--only") {
      only = numlist(argv[i + 1] ?? "", "--only");
      i += 1;
    } else if (a === "--skip") {
      skip = numlist(argv[i + 1] ?? "", "--skip");
      i += 1;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--verbose" || a === "-v") {
      verbose = true;
    } else if (a === "--help" || a === "-h") {
      console.log(USAGE);
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
