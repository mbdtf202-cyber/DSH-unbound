// @ts-nocheck
/**
 * 冻结的**有缺陷**参考实现（逐字复制原 `lib/skills.js` 的 `pathsOverlap`）。
 *
 * ## 这不是「对照基准」，是「反例」
 *
 * 原文件第 1 行只写了：
 *   import { promises as fsp } from "node:fs";
 * 却在 `pathsOverlap()` 里用 `fs.realpathSync.native`。真实 ESM 环境下
 * 每次调用都抛 `ReferenceError: fs is not defined`，被外层 `try/catch` 吞掉 →
 * **realpath 从未执行** → 比较的是 `path.resolve` 的字面路径。
 *
 * 于是「源目录是软链、指向 $DSH_HOME/skills」这种场景判不出重叠，
 * `removeOfficialSkill()` 顺链把整个 skills 目录删穿（上游 #54）。
 *
 * 测试 `skills.test.ts` 里的「原 bug 反例」用它证明：
 * **同一输入，原实现放行、新实现拦住**。
 *
 * `@ts-nocheck` 是刻意的：保持逐字，包括那个缺失的 import。
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

function pathsOverlap(a, b) {
  const toReal = (p) => {
    const abs = path.resolve(String(p || ""));
    if (!abs) return "";
    // ↓ 原实现这一行：fs 未导入 → ReferenceError → catch 吞掉 → 永不 realpath
    try { return fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs); }
    catch { return abs; }
  };
  const left = toReal(a);
  const right = toReal(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftPrefix = left.endsWith(path.sep) ? left : left + path.sep;
  const rightPrefix = right.endsWith(path.sep) ? right : right + path.sep;
  return left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
}

export { pathsOverlap };
void fsp;
