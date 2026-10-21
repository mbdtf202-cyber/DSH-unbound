/**
 * CLI 交付层面契约（C 部分）。
 *
 * 这一组测的不是引擎算法，而是「人/脚本能不能可靠地用这个东西」：
 *   1. 每个子命令都有可读帮助（`apply --help` 要看得到 apply 的选项）
 *   2. 错误输入给**可操作**的信息，不是 stack trace
 *   3. 退出码契约被锁住（drift 有漂移 → 1、无 → 0；apply 失败 → 非 0）
 *   4. `--json` 输出是**合法 JSON 且字段稳定**，可被程序消费
 *
 * ## 为什么用 `spawnSync` 而不是直接调函数
 *
 * 退出码与 stdout/stderr 的分离是**进程级契约**。在进程内调 main() 既拿不到
 * 真实退出码（`process.exit` 会终止测试进程），也验证不了「错误是否走了 stderr」。
 * 所以这里全部通过真实子进程跑。
 *
 * 所有会写盘的用例都指向 `/tmp` 里的一次性宿主，**绝不**指向真实 app bundle。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 仓库根（`dist-test/test/integration` 往上三级）。 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** 编译后的 CLI 入口。 */
const CLI = path.join(REPO_ROOT, "dist", "cli", "index.js");

const CLI_AVAILABLE = fs.existsSync(CLI);

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 跑一次 CLI（子进程），返回退出码与分离后的输出。 */
function run(args: readonly string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 建一个会被 --ai-base 接受的最小宿主（目录名必须是 @deepseek-ai 且有 dsh-* 包）。 */
function fakeAiBase(files: Record<string, string> = {}): { root: string; aiBase: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-cli-"));
  const aiBase = path.join(root, "dsh", "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(aiBase, "dsh-agent-instructions", "lib"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(aiBase, ...rel.split("/"));
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf8");
  }
  return { root, aiBase, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 补丁 #1 会命中的上游原文。 */
const PATCH_ONE_UPSTREAM =
  'const WORKSPACE_CONTEXT_INTRO = "The following workspace instructions may be relevant to your work. ' +
  "Use them as guidance when applicable. More specific instructions take precedence over broader ones. " +
  'They do not override system, developer, or direct user instructions."\n';

describe("CLI：每个子命令都有可读帮助", { skip: CLI_AVAILABLE ? false : "dist/cli/index.js 未构建，先跑 npm run build" }, () => {
  const commands = ["status", "drift", "apply", "revert", "hosts", "targets"] as const;

  it("顶层 --help 列出全部子命令与退出码", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    for (const c of commands) assert.ok(r.stdout.includes(c), `顶层帮助必须提到子命令 ${c}`);
    assert.ok(r.stdout.includes("退出码"), "必须说明退出码语义");
    assert.match(r.stdout, /0\s+成功|0\s+.*无漂移/, "必须写清 0 的含义");
  });

  for (const cmd of commands) {
    it(`${cmd} --help 给出该命令专属说明（不是只重复全局帮助）`, () => {
      const r = run([cmd, "--help"]);
      assert.equal(r.status, 0, `${cmd} --help 必须成功退出`);
      assert.ok(r.stdout.includes(cmd), `帮助里必须出现命令名 ${cmd}`);
      assert.ok(r.stdout.includes("退出码"), `${cmd} 的帮助必须说明退出码`);
      // 专属帮助的标志：出现「用法:」且以该命令开头
      assert.match(r.stdout, new RegExp(`dsh-unbound ${cmd}`), `${cmd} 帮助必须写明自己的用法行`);
    });
  }

  it("apply --help 必须解释 --only / --skip / --dry-run", () => {
    const r = run(["apply", "--help"]);
    for (const flag of ["--only", "--skip", "--dry-run"]) {
      assert.ok(r.stdout.includes(flag), `apply 帮助必须解释 ${flag}`);
    }
    // 幂等契约与备份策略属于交付承诺，必须写出来。
    assert.match(r.stdout, /幂等/, "apply 帮助必须说明幂等契约");
    assert.match(r.stdout, /\.bak/, "apply 帮助必须说明备份后缀");
  });

  it("drift --help 必须写清 0/1 两种退出码", () => {
    const r = run(["drift", "--help"]);
    assert.match(r.stdout, /0\s+broken|0\s+.*无/, "必须写 0 的含义");
    assert.match(r.stdout, /1\s+broken|1\s+.*partial|1\s+.*需要/, "必须写 1 的含义");
  });
});

describe("CLI：错误输入给可操作信息，不是 stack trace", { skip: CLI_AVAILABLE ? false : "dist/cli/index.js 未构建" }, () => {
  /** 断言：没有 stack trace 泄漏到用户面前。 */
  function assertNoStackTrace(r: Run): void {
    assert.equal(r.stdout.includes("    at "), false, `stdout 不应含 stack trace：${r.stdout}`);
    assert.equal(r.stderr.includes("    at "), false, `stderr 不应含 stack trace：${r.stderr}`);
    assert.equal(/Error:\s*\n/.test(r.stderr), false, "不应输出裸 'Error:'");
  }

  it("未知命令：退出 2，报错并给用法", () => {
    const r = run(["definitely-not-a-command"]);
    assert.equal(r.status, 2, "用法错误必须是退出码 2");
    assert.ok(r.stderr.includes("unknown command"), "必须说明是什么错了");
    assert.ok(r.stderr.includes("用法"), "必须顺手给出用法");
    assertNoStackTrace(r);
  });

  it("未知选项：退出 2，指出是哪个选项", () => {
    const r = run(["drift", "--nope"]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("--nope"), "必须回显用户写错的选项名");
    assertNoStackTrace(r);
  });

  it("--ai-base 指向不存在的路径：退出 2，说明要求", () => {
    const r = run(["drift", "--ai-base", "/nope/definitely/missing"]);
    assert.equal(r.status, 2, "--ai-base 非法属于用法错误");
    assert.ok(r.stderr.includes("@deepseek-ai"), "必须告诉用户要什么样的目录");
    assert.ok(r.stderr.includes("dsh-"), "必须写明目录里得有 dsh-* 包");
    assertNoStackTrace(r);
  });

  it("--ai-base 指向一个普通目录（名字不对）：退出 2 且解释原因", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-notai-"));
    try {
      const r = run(["drift", "--ai-base", tmp]);
      assert.equal(r.status, 2);
      assert.ok(r.stderr.includes("@deepseek-ai"), "必须说明目录名要求");
      assertNoStackTrace(r);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--surface 非法值：退出 2", () => {
    for (const bad of ["mobile", "", "WEB"]) {
      const r = run(["apply", "--surface", bad]);
      assert.equal(r.status, 2, `--surface ${JSON.stringify(bad)} 必须被拒`);
      assert.ok(r.stderr.includes("web"), "必须提示合法值");
    }
  });

  it("--only / --skip 非数字：退出 2 并回显坏值", () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const r1 = run(["apply", "--only", bad]);
      assert.equal(r1.status, 2, `--only ${bad} 必须被拒`);
      assert.ok(r1.stderr.includes(bad), `必须回显坏值 ${bad}`);
      const r2 = run(["apply", "--skip", bad]);
      assert.equal(r2.status, 2, `--skip ${bad} 必须被拒`);
    }
  });

  it("--only / --skip 缺少值时必须报错，不能静默当成『不过滤』", () => {
    // 这是真实修过的坑：`apply --only` 后面没值，早先会退化成「打全部补丁」。
    // 对一个会写宿主的命令来说，「只打 #1」被误解成「打全部」是最坏的方向。
    for (const args of [["apply", "--only"], ["apply", "--skip"], ["apply", "--only", "--dry-run"]]) {
      const r = run(args);
      assert.equal(r.status, 2, `${args.join(" ")} 必须退出 2`);
      assert.match(r.stderr, /requires a value/, `${args.join(" ")} 必须说明缺值`);
    }
  });

  it("--ai-base 缺少值：退出 2", () => {
    const r = run(["drift", "--ai-base"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /requires a value/);
  });
});

describe("CLI：退出码契约", { skip: CLI_AVAILABLE ? false : "dist/cli/index.js 未构建" }, () => {
  it("drift 无漂移 → 0；有漂移 → 1（同一份数据两头都验）", () => {
    // 用真实宿主做「无漂移」样本：实测 broken=0。
    const realAiBase =
      process.env["DSH_UNBOUND_REAL_AIBASE"] ??
      "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai";
    if (fs.existsSync(realAiBase)) {
      const ok = run(["drift", "--ai-base", realAiBase, "--json"]);
      const parsed = JSON.parse(ok.stdout) as { summary: { broken: number } };
      assert.equal(
        ok.status,
        parsed.summary.broken === 0 ? 0 : 1,
        `退出码必须与 broken 一致（broken=${parsed.summary.broken}）`,
      );
    }

    // 造一个必然 broken 的宿主：放一个含补丁 target 但内容完全不对的文件。
    const host = fakeAiBase({
      "dsh-agent-instructions/lib/index.js": "// totally unrelated content\n",
    });
    try {
      const r = run(["drift", "--ai-base", host.aiBase, "--json"]);
      const parsed = JSON.parse(r.stdout) as { summary: { broken: number } };
      if (parsed.summary.broken > 0) {
        assert.equal(r.status, 1, "有 broken 必须退出 1");
      } else {
        assert.equal(r.status, 0, "无 broken 必须退出 0");
      }
    } finally {
      host.cleanup();
    }
  });

  it("status 永远退出 0（即使有漂移）—— 与 drift 的区别就在这里", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": "// unrelated\n" });
    try {
      const r = run(["status", "--ai-base", host.aiBase]);
      assert.equal(r.status, 0, "status 是只读查看，不该用退出码表达漂移");
    } finally {
      host.cleanup();
    }
  });

  it("apply 成功 → 0；revert 成功 → 0", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      const a = run(["apply", "--ai-base", host.aiBase, "--only", "1"]);
      assert.equal(a.status, 0, `apply 成功应退出 0，stderr=${a.stderr}`);
      const rv = run(["revert", "--ai-base", host.aiBase]);
      assert.equal(rv.status, 0, "revert 成功应退出 0");
    } finally {
      host.cleanup();
    }
  });

  it("apply 失败 → 非 0（只读目录制造真实写失败）", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      const libDir = path.join(host.aiBase, "dsh-agent-instructions", "lib");
      fs.chmodSync(libDir, 0o555); // 目录只读 → 备份 copyFileSync 失败
      let r: Run;
      try {
        r = run(["apply", "--ai-base", host.aiBase, "--only", "1"]);
      } finally {
        fs.chmodSync(libDir, 0o755);
      }
      assert.equal(r.status, 1, `写失败必须退出 1，实际 ${r.status}`);
    } finally {
      host.cleanup();
    }
  });

  it("apply --dry-run 不改变退出码语义（仍按 failed 判定）", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      const r = run(["apply", "--ai-base", host.aiBase, "--only", "1", "--dry-run"]);
      assert.equal(r.status, 0, "dry-run 没有失败就该退出 0");
    } finally {
      host.cleanup();
    }
  });
});

describe("CLI：--json 输出可被程序消费", { skip: CLI_AVAILABLE ? false : "dist/cli/index.js 未构建" }, () => {
  it("drift --json 是合法 JSON，且字段稳定", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      const r = run(["drift", "--ai-base", host.aiBase, "--json"]);
      // 纯 stdout 必须是合法 JSON（不能混进人类可读文字）。
      const parsed: unknown = JSON.parse(r.stdout);
      assert.equal(typeof parsed, "object");
      const obj = parsed as Record<string, unknown>;
      for (const key of ["aiBase", "generatedAt", "patches", "summary"]) {
        assert.ok(key in obj, `drift JSON 必须含字段 ${key}`);
      }
      const summary = obj["summary"] as Record<string, unknown>;
      for (const key of [
        "total",
        "healthy",
        "applied",
        "partial",
        "dead",
        "absent",
        "reverted",
        "pendingUpgrade",
        "broken",
      ]) {
        assert.equal(typeof summary[key], "number", `summary.${key} 必须是数字`);
      }
      assert.ok(Array.isArray(obj["patches"]));
      // 每条 patch 的必备字段
      const first = (obj["patches"] as Record<string, unknown>[])[0]!;
      for (const key of ["patchId", "name", "layer", "state", "targetFiles", "totalPatterns", "matchedPatterns"]) {
        assert.ok(key in first, `patch 条目必须含 ${key}`);
      }
      // 数字字段类型稳定（脚本会直接比较）
      assert.equal(typeof first["patchId"], "number");
      assert.equal(typeof first["totalPatterns"], "number");
      assert.ok(Array.isArray(first["targetFiles"]));
    } finally {
      host.cleanup();
    }
  });

  it("apply --json 是合法 JSON，summary 字段齐全且为数字", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      const r = run(["apply", "--ai-base", host.aiBase, "--only", "1", "--dry-run", "--json"]);
      const obj = JSON.parse(r.stdout) as Record<string, unknown>;
      const summary = obj["summary"] as Record<string, unknown>;
      for (const key of [
        "total",
        "applied",
        "already",
        "patternNotFound",
        "missingFile",
        "skipped",
        "failed",
        "filesChanged",
      ]) {
        assert.equal(typeof summary[key], "number", `apply summary.${key} 必须是数字`);
      }
      assert.ok(Array.isArray(obj["outcomes"]));
      assert.ok(Array.isArray(obj["writtenFiles"]));
    } finally {
      host.cleanup();
    }
  });

  it("revert --json 是合法 JSON", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      run(["apply", "--ai-base", host.aiBase, "--only", "1"]);
      const r = run(["revert", "--ai-base", host.aiBase, "--json"]);
      const obj = JSON.parse(r.stdout) as Record<string, unknown>;
      assert.ok(Array.isArray(obj["restored"]), "revert JSON 必须含 restored 数组");
      assert.ok(Array.isArray(obj["missing"]), "revert JSON 必须含 missing 数组");
    } finally {
      host.cleanup();
    }
  });

  it("targets --json 是合法 JSON 数组", () => {
    const host = fakeAiBase({ "dsh-agent-instructions/lib/index.js": PATCH_ONE_UPSTREAM });
    try {
      const r = run(["targets", "--ai-base", host.aiBase, "--json"]);
      const arr = JSON.parse(r.stdout) as unknown[];
      assert.ok(Array.isArray(arr), "targets --json 必须是数组");
      assert.ok(arr.length > 0, "至少有一个 key");
      const first = arr[0] as Record<string, unknown>;
      assert.equal(typeof first["key"], "string");
      assert.equal(typeof first["via"], "string");
      assert.ok(Array.isArray(first["paths"]));
    } finally {
      host.cleanup();
    }
  });

  it("hosts --json 是合法 JSON 数组（可能为空）", () => {
    const r = run(["hosts", "--json"]);
    const arr = JSON.parse(r.stdout) as unknown[];
    assert.ok(Array.isArray(arr), "hosts --json 必须是数组");
  });
});
