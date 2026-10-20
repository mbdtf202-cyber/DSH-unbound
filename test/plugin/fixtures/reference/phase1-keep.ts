// @ts-nocheck
/**
 * 冻结参考实现（逐字复制，勿改）。
 *
 * 来源：dsh-qilin/lib/phase1-keep.js（commit 6e6f13d）。
 *
 * 这个文件**不是产品代码**：它只作为差分测试的对照组，证明新实现在
 * 「同一输入 → 同一输出」上与原实现一致。任何修改都会让对照失效。
 *
 * `@ts-nocheck` 是刻意的——为了保持逐字（含原实现的松散类型），
 * 不在迁移时给参考实现补类型。类型检查只覆盖 src/。
 */
export const PHASE1_KEEP_EXPR =
  'PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("dsh-qilin") || String(section?.name || "").startsWith("dshql-")';

/**
 * 把官方 phase-1 白名单放宽到 dsh-qilin* + dshql-*。
 * 已放行 dsh-qilin 的旧补丁会升到带 dshpg。
 */
export function widenPhase1KeepFilter(text) {
  const raw = String(text || "");
  const crlf = raw.includes("\r\n");
  let next = raw.replace(/\r\n/g, "\n");
  next = next.replace(
    /PERSONA_SECTION_NAMES\.has\(section\?\.name\) \|\| String\(section\?\.name \|\| ""\)\.startsWith\("dsh-qilin"\)(?! \|\| String\(section\?\.name \|\| ""\)\.startsWith\("dshql-"\))/g,
    PHASE1_KEEP_EXPR,
  );
  next = next.replace(
    /section => PERSONA_SECTION_NAMES\.has\(section\?\.name\)(?! \|\|)/g,
    `section => ${PHASE1_KEEP_EXPR}`,
  );
  return crlf ? next.replace(/\n/g, "\r\n") : next;
}
