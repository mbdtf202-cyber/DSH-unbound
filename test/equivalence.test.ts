/**
 * 行为等价性守护：新引擎 vs dsh-qilin 原引擎。
 *
 * 这是本项目的「不回归」底线：重写可以改结构、改类型、加能力，
 * **但不能改变对同一份源码产出的字节**。任何语义漂移都会在这里被抓到。
 *
 * 为什么做成测试而不是一次性脚本：补丁表未来会继续演化，
 * 每次改 text.ts 都必须重新证明等价性。
 *
 * 依赖：需要本机存在 dsh-qilin 源码。不存在时自动 skip（不能因此让 CI 红）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyPatchToText } from "../src/engine/text.js";
import { loadBundledPatches } from "../src/patches/load.js";
import { findUpstreamRoot } from "./helpers/upstream.js";

const QILIN_CANDIDATES = [
  // 不写死作者机器路径：由 helpers/upstream 按 DSH_QILIN_ROOT / 同级检出 / 子目录顺序解析。
  // 早期这里写死绝对路径，导致 CI 上对照测试直接 ERR_MODULE_NOT_FOUND 崩掉整个 job。
  ...(findUpstreamRoot() === null ? [] : [findUpstreamRoot() as string]),
];

function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "core.js"))) return c;
  }
  return null;
}

const REAL_AI_BASE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai";

interface OldEngine {
  readonly ALL_PATCHES: readonly Record<string, unknown>[];
  readonly targetFiles: (aiBase: string) => Record<string, unknown>;
  readonly applyReplacementsToText: (
    text: string,
    patch: unknown,
    fp: string,
  ) => { text: string; changed: boolean };
}

const qilinRoot = findQilin();
const hostAvailable = fs.existsSync(REAL_AI_BASE);
const canRun = qilinRoot !== null && hostAvailable;

describe("行为等价性：新引擎 === dsh-qilin 原引擎", { skip: !canRun }, () => {
  it("在真实宿主源码上逐 (补丁, 文件) 对比输出字节", async () => {
    const oldEngine = (await import(
      pathToFileURL(path.join(qilinRoot!, "lib", "core.js")).href
    )) as unknown as OldEngine;

    const newPatches = loadBundledPatches();
    assert.equal(
      newPatches.length,
      oldEngine.ALL_PATCHES.length,
      "补丁条数必须一致（表是从原实现导出的）",
    );

    // 用原引擎的目标解析作为地面真值，保证比的是同一批文件
    const files = oldEngine.targetFiles(REAL_AI_BASE);
    const keyPaths: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(files)) {
      keyPaths[k] = Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
    }

    let compared = 0;
    const diffs: string[] = [];

    for (const np of newPatches) {
      const op = oldEngine.ALL_PATCHES.find((x) => x["id"] === np.id);
      assert.ok(op !== undefined, `原引擎缺少 #${np.id}`);

      const paths: string[] = [];
      for (const key of np.fileKeys) {
        for (const p of keyPaths[key] ?? []) if (!paths.includes(p)) paths.push(p);
      }

      for (const fp of paths) {
        if (!fs.existsSync(fp)) continue;
        const src = fs.readFileSync(fp, "utf8");
        const before = (oldEngine.applyReplacementsToText(src, op, fp) as { text: string }).text;
        const after = applyPatchToText(src, np, fp).text;
        compared += 1;
        if (before !== after) {
          diffs.push(`#${np.id} ${np.name} on ${path.basename(fp)}`);
        }
      }
    }

    assert.ok(compared > 20, `对比样本太少（${compared}），等价性结论不可信`);
    assert.deepEqual(diffs, [], `存在语义漂移：\n${diffs.join("\n")}`);
  });

  it("幂等性在真实宿主源码上成立（连跑两次结果相同）", { skip: !canRun }, async () => {
    const oldEngine = (await import(
      pathToFileURL(path.join(qilinRoot!, "lib", "core.js")).href
    )) as unknown as OldEngine;

    const patches = loadBundledPatches();
    const files = oldEngine.targetFiles(REAL_AI_BASE);
    const keyPaths: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(files)) {
      keyPaths[k] = Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
    }

    let checked = 0;
    for (const p of patches) {
      const paths: string[] = [];
      for (const key of p.fileKeys) {
        for (const fp of keyPaths[key] ?? []) if (!paths.includes(fp)) paths.push(fp);
      }
      for (const fp of paths) {
        if (!fs.existsSync(fp)) continue;
        const src = fs.readFileSync(fp, "utf8");
        const once = applyPatchToText(src, p, fp).text;
        const twice = applyPatchToText(once, p, fp).text;
        // 允许 skipIfMarked 之外的自我增长型补丁（那是补丁表本身的设计），
        // 但第二次之后必须稳定（不能线性膨胀）。
        const thrice = applyPatchToText(twice, p, fp).text;
        assert.equal(thrice, twice, `#${p.id} ${p.name} 在 ${path.basename(fp)} 上第三次仍在变化 ⇒ 会无限膨胀`);
        checked += 1;
      }
    }
    assert.ok(checked > 20, `幂等检查样本太少（${checked}）`);
  });
});
