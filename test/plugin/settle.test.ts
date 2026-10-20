/**
 * settle 策略测试。
 *
 * 这些判定原本散在 `index.js` 的 `settleInstalledPatches` 里、与 IO 混在一起，
 * 无法单测。每条都对应一次真实事故（注释记在 `src/plugin/settle-policy.ts`）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyShouldRestart,
  DESKTOP_SETTLE_DELAY_MS,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
} from "../../src/plugin/settle-policy.js";

describe("isInactiveContextError", () => {
  it("code === INACTIVE_EFFECT → true", () => {
    const error = Object.assign(new Error("whatever"), { code: "INACTIVE_EFFECT" });
    assert.equal(isInactiveContextError(error), true);
  });

  it("消息含 inactive context → true（大小写不敏感）", () => {
    assert.equal(isInactiveContextError(new Error("Inactive context")), true);
    assert.equal(isInactiveContextError(new Error("[cordis] INACTIVE CONTEXT while apply")), true);
  });

  it("字符串形态也认", () => {
    assert.equal(isInactiveContextError("inactive context"), true);
  });

  it("普通错误 → false", () => {
    assert.equal(isInactiveContextError(new Error("boom")), false);
  });

  it("null / undefined / 数字 → false", () => {
    assert.equal(isInactiveContextError(null), false);
    assert.equal(isInactiveContextError(undefined), false);
    assert.equal(isInactiveContextError(42), false);
  });

  it("空消息不误判", () => {
    assert.equal(isInactiveContextError(new Error("")), false);
    assert.equal(isInactiveContextError({}), false);
  });

  it("code 是别的值、消息也不匹配 → false", () => {
    assert.equal(isInactiveContextError(Object.assign(new Error("x"), { code: "ECONNRESET" })), false);
  });
});

describe("settleDelayMs：桌面要等，web 不等", () => {
  it("desktop → 4000ms", () => {
    assert.equal(settleDelayMs("desktop"), 4000);
    assert.equal(settleDelayMs("desktop"), DESKTOP_SETTLE_DELAY_MS);
  });

  it("web → 0ms（不额外等）", () => {
    assert.equal(settleDelayMs("web"), 0);
  });

  it("延迟是正的有限数（不能是 NaN）", () => {
    assert.equal(Number.isFinite(DESKTOP_SETTLE_DELAY_MS), true);
    assert.equal(DESKTOP_SETTLE_DELAY_MS > 0, true);
  });
});

describe("settleMayRestart：桌面启动时绝不重启", () => {
  it("desktop → false（官方 Fiber._reload 还在挂载）", () => {
    assert.equal(settleMayRestart({ surface: "desktop", sealed: false }), false);
  });

  it("desktop + sealed → false", () => {
    assert.equal(settleMayRestart({ surface: "desktop", sealed: true }), false);
  });

  it("web + sealed → false（换包必须走用户点应用）", () => {
    assert.equal(settleMayRestart({ surface: "web", sealed: true }), false);
  });

  it("web + 不 sealed → true", () => {
    assert.equal(settleMayRestart({ surface: "web", sealed: false }), true);
  });
});

describe("settleMayReapply：密封桌面不自愈", () => {
  it("desktop + sealed → false（会和 Fiber._reload 抢锁）", () => {
    assert.equal(settleMayReapply({ surface: "desktop", sealed: true }), false);
  });

  it("desktop + 不 sealed → true", () => {
    assert.equal(settleMayReapply({ surface: "desktop", sealed: false }), true);
  });

  it("web + sealed → true（web 面没有密封概念，仍可写盘）", () => {
    assert.equal(settleMayReapply({ surface: "web", sealed: true }), true);
  });

  it("web + 不 sealed → true", () => {
    assert.equal(settleMayReapply({ surface: "web", sealed: false }), true);
  });
});

describe("applyShouldRestart：点应用后的重启判定", () => {
  it("sealed 一律重启（与补丁状态无关）", () => {
    assert.equal(applyShouldRestart({ sealed: true }), true);
    assert.equal(applyShouldRestart({ sealed: true, complete: false, appliedCount: 0 }), true);
  });

  it("complete → 重启", () => {
    assert.equal(applyShouldRestart({ complete: true }), true);
  });

  it("promptReady → 重启（提示词写好也值得重启）", () => {
    assert.equal(applyShouldRestart({ promptReady: true }), true);
  });

  it("写了补丁 → 重启", () => {
    assert.equal(applyShouldRestart({ appliedCount: 1 }), true);
    assert.equal(applyShouldRestart({ appliedCount: 42 }), true);
  });

  it("什么都没变 → 不重启", () => {
    assert.equal(applyShouldRestart({}), false);
    assert.equal(applyShouldRestart({ complete: false, appliedCount: 0, promptReady: false, sealed: false }), false);
  });

  it("appliedCount 为 0 / 负数 / NaN → 不重启", () => {
    assert.equal(applyShouldRestart({ appliedCount: 0 }), false);
    assert.equal(applyShouldRestart({ appliedCount: -1 }), false);
    assert.equal(applyShouldRestart({ appliedCount: Number.NaN }), false);
  });

  it("冷却不参与判定（否则第一次没换掉 asar 会被当成取消）", () => {
    // 同样的输入，无论「刚重启过」与否都必须给同一答案：
    // 函数签名里根本没有 cooldown 字段，这里用两次连续调用证明稳定。
    const input = { complete: true, sealed: false, appliedCount: 0, promptReady: false };
    assert.equal(applyShouldRestart(input), applyShouldRestart(input));
    assert.equal(applyShouldRestart(input), true);
  });

  it("无参调用默认不重启", () => {
    assert.equal(applyShouldRestart(), false);
  });
});
