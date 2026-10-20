// @ts-nocheck
/**
 * 冻结参考实现的依赖桩。
 *
 * 原 `lib/core.js` 有 4,915 行，identity.js 只从里面拿 `findDshHome`。
 * 这里给一个明确空值：参考实现里 `findDshHome()` 只用于读 mnemon 设置，
 * 返回 "" 表示「读不到」，这正是差分测试要固定的一端。
 */
export function findDshHome() {
  return "";
}
