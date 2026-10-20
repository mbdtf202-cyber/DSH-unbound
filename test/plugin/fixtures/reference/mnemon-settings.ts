// @ts-nocheck
/**
 * 冻结参考实现（逐字复制，勿改）。
 *
 * 来源：dsh-qilin/lib/mnemon-settings.js（commit 6e6f13d）。
 *
 * 这个文件**不是产品代码**：它只作为差分测试的对照组，证明新实现在
 * 「同一输入 → 同一输出」上与原实现一致。任何修改都会让对照失效。
 *
 * `@ts-nocheck` 是刻意的——为了保持逐字（含原实现的松散类型），
 * 不在迁移时给参考实现补类型。类型检查只覆盖 src/。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SETTINGS = Object.freeze({ keepMnemon: false });
const SETTINGS_FILE = "mnemon.json";

function mnemonSettingsPath(dshHome) {
  return path.join(dshHome, "dsh-qilin", SETTINGS_FILE);
}

export function loadMnemonSettings(dshHome, configValue) {
  let file = {};
  try {
    const fp = mnemonSettingsPath(dshHome);
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (parsed && typeof parsed === "object") file = parsed;
    }
  } catch {
    file = {};
  }
  const pick = [file.keepMnemon, configValue, DEFAULT_SETTINGS.keepMnemon];
  const value = pick.find((v) => typeof v === "boolean");
  return { keepMnemon: value === undefined ? false : value };
}

function atomicWriteFileSync(fp, content, encoding = "utf8") {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, encoding);
    try { fs.fsyncSync(fd); } catch { /* FS 不支持 fsync 时忽略 */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function saveMnemonSettings(dshHome, patch) {
  const fp = mnemonSettingsPath(dshHome);
  const current = loadMnemonSettings(dshHome);
  const next = {
    keepMnemon: typeof patch?.keepMnemon === "boolean"
      ? patch.keepMnemon
      : current.keepMnemon,
  };
  atomicWriteFileSync(fp, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, ...next, path: fp };
}
