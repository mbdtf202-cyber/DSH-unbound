/**
 * 补丁表同步与一致性测试。
 *
 * 核心保证：本仓库的 patches/patches.json 与 dsh-qilin 的补丁表**逐条一致**。
 * 这是跨仓库契约；不一致就说明两边开始漂了，必须立刻知道。
 *
 * 找不到 dsh-qilin 时 skip —— 不能因为外部仓库不存在就让 CI 红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadBundledPatches } from "../src/patches/load.js";
import { findUpstreamRoot } from "./helpers/upstream.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const QILIN_CANDIDATES = [
  // 不写死作者机器路径：由 helpers/upstream 按 DSH_QILIN_ROOT / 同级检出 / 子目录顺序解析。
  // 早期这里写死绝对路径，导致 CI 上对照测试直接 ERR_MODULE_NOT_FOUND 崩掉整个 job。
  ...(findUpstreamRoot() === null ? [] : [findUpstreamRoot() as string]),
];

function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "patches-data.js"))) return c;
  }
  return null;
}

const qilin = findQilin();

describe("补丁表与 dsh-qilin 同步", { skip: qilin === null }, () => {
  it("两条补丁表的 id 集合一致", () => {
    const local = loadBundledPatches().map((p) => p.id).sort((a, b) => a - b);
    // 用 qilin 自己的导出脚本取表（它承诺的稳定出口）
    const tmp = path.join("/tmp", `dsh-unbound-sync-${process.pid}.json`);
    execFileSync(process.execPath, [path.join(qilin!, "scripts", "export-patches.mjs"), tmp], {
      stdio: "pipe",
    });
    const parsed = JSON.parse(fs.readFileSync(tmp, "utf8")) as
      | { patches?: { id: number }[] }
      | { id: number }[];
    const raw = Array.isArray(parsed) ? parsed : parsed.patches!;
    const remote = raw.map((p) => p.id).sort((a, b) => a - b);
    fs.unlinkSync(tmp);
    assert.deepEqual(local, remote, "id 集合必须一致");
  });

  it("verify 脚本报告 in sync（退出码 0）", () => {
    // 直接跑，退出码非 0 会抛
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, [path.join(ROOT, "scripts", "sync-patches.mjs"), "verify"], {
        stdio: "pipe",
      });
    });
  });
});

describe("sync 脚本的失败检测", () => {
  it("表被篡改时 verify 退出码为 1", () => {
    if (qilin === null) return; // 需要外部仓库才能验证
    const tablePath = path.join(ROOT, "patches", "patches.json");
    const original = fs.readFileSync(tablePath, "utf8");
    try {
      const parsed = JSON.parse(original) as { replacements?: { replace: string }[] }[];
      parsed[0]!.replacements![0]!.replace = "TAMPERED_FOR_TEST";
      fs.writeFileSync(tablePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      let code = 0;
      try {
        execFileSync(process.execPath, [path.join(ROOT, "scripts", "sync-patches.mjs"), "verify"], {
          stdio: "pipe",
        });
      } catch (e) {
        code = (e as { status?: number }).status ?? 0;
      }
      assert.equal(code, 1, "篡改后必须退出 1");
    } finally {
      fs.writeFileSync(tablePath, original, "utf8");
    }
  });
});
