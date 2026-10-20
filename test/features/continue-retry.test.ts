/**
 * 自动续跑 / 自动重试判定测试。
 *
 * 主判据是差分对照（96 组）。这块的安全性是**方向性**的：
 * 判错会导致「该重试的不重试」（用户白等）或「永久错误疯狂重试」（放大故障）。
 * 所以每个码都单独钉一遍。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONTINUE_RETRY,
  clampCount,
  failureCodeOf,
  isAbnormalReason,
  isPermanentFailure,
  isUserAbort,
  lastTurnEnd,
  mergeConfig,
  normalizeConfig,
  shouldAutoContinue,
  shouldAutoRetry,
} from "../../src/features/continue-retry.js";
import { findUpstreamRoot } from "../helpers/upstream.js";

const QILIN_CANDIDATES = [
  // 不写死作者机器路径：由 helpers/upstream 按 DSH_QILIN_ROOT / 同级检出 / 子目录顺序解析。
  // 早期这里写死绝对路径，导致 CI 上对照测试直接 ERR_MODULE_NOT_FOUND 崩掉整个 job。
  ...(findUpstreamRoot() === null ? [] : [findUpstreamRoot() as string]),
];
function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "continue-retry.js"))) return c;
  }
  return null;
}

describe("默认配置", () => {
  it("★ autoContinue 默认关闭（防与用户 submit 抢跑的线上问题）", () => {
    assert.equal(DEFAULT_CONTINUE_RETRY.autoContinue, false);
    assert.equal(DEFAULT_CONTINUE_RETRY.autoRetry, true);
  });
  it("默认上限 3", () => {
    assert.equal(DEFAULT_CONTINUE_RETRY.retryMax, 3);
    assert.equal(DEFAULT_CONTINUE_RETRY.continueMax, 3);
  });
  it("默认续跑文本", () => {
    assert.equal(DEFAULT_CONTINUE_RETRY.continueText, "继续");
  });
});

describe("clampCount", () => {
  it("夹到 [0,20]", () => {
    assert.equal(clampCount(0), 0);
    assert.equal(clampCount(5), 5);
    assert.equal(clampCount(20), 20);
    assert.equal(clampCount(21), 20);
    assert.equal(clampCount(-1), 0);
  });
  it("小数截断", () => {
    assert.equal(clampCount(3.7), 3);
  });
  it("非有限数回落 fallback", () => {
    assert.equal(clampCount("abc"), 3);
    assert.equal(clampCount(NaN), 3);
    assert.equal(clampCount(Infinity), 3);
    assert.equal(clampCount("abc", 7), 7);
  });
  it("字符串数字可解析", () => {
    assert.equal(clampCount("5"), 5);
  });
});

describe("normalizeConfig", () => {
  it("空输入给默认值", () => {
    const c = normalizeConfig({});
    assert.equal(c.retryMax, 3);
    assert.equal(c.autoRetry, true);
    assert.equal(c.autoContinue, false);
  });

  it("null/非对象输入不抛", () => {
    assert.equal(normalizeConfig(null).retryMax, 3);
    assert.equal(normalizeConfig(undefined).retryMax, 3);
    assert.equal(normalizeConfig("x").retryMax, 3);
  });

  it("★ 上限为 0 时自动关闭对应开关（用户不必改两处）", () => {
    const a = normalizeConfig({ retryMax: 0, autoRetry: true });
    assert.equal(a.autoRetry, false, "retryMax=0 应关掉 autoRetry");
    const b = normalizeConfig({ continueMax: 0, autoContinue: true });
    assert.equal(b.autoContinue, false, "continueMax=0 应关掉 autoContinue");
  });

  it("autoRetry=false 生效", () => {
    assert.equal(normalizeConfig({ autoRetry: false }).autoRetry, false);
  });

  it("空白 continueText 回落默认", () => {
    assert.equal(normalizeConfig({ continueText: "   " }).continueText, "继续");
  });

  it("自定义 continueText 保留（含 trim）", () => {
    assert.equal(normalizeConfig({ continueText: " go " }).continueText, "go");
  });
});

describe("mergeConfig", () => {
  it("保存的设置覆盖插件配置", () => {
    const c = mergeConfig({ retryMax: 1 }, { retryMax: 9 });
    assert.equal(c.retryMax, 9);
  });

  it("★ autoContinue 只有插件显式开启才可能为 true", () => {
    // 保存的旧配置里 autoContinue:true 不能把它带回来
    const c = mergeConfig({}, { autoContinue: true });
    assert.equal(c.autoContinue, false, "插件未开启时保存的 true 不应生效");
  });

  it("插件显式开启 + 保存开启 → 生效", () => {
    const c = mergeConfig({ autoContinue: true }, { autoContinue: true });
    assert.equal(c.autoContinue, true);
  });
});

describe("lastTurnEnd", () => {
  it("取最后一个 turn/end", () => {
    const e = lastTurnEnd([{ type: "turn/end", n: 1 }, { type: "x" }, { type: "turn/end", n: 2 }]);
    assert.equal((e as { n?: number } | null)?.n, 2);
  });
  it("没有则 null", () => {
    assert.equal(lastTurnEnd([{ type: "x" }]), null);
    assert.equal(lastTurnEnd(null), null);
  });
});

describe("isUserAbort", () => {
  it("kind=aborted + 用户原因", () => {
    assert.equal(isUserAbort({ kind: "aborted", reason: "user" }), true);
    assert.equal(isUserAbort({ kind: "aborted", reason: "cancel" }), true);
    assert.equal(isUserAbort({ kind: "aborted", reason: { kind: "user" } }), true);
  });
  it("非用户原因的 abort 不算", () => {
    assert.equal(isUserAbort({ kind: "aborted", reason: "timeout" }), false);
  });
  it("非 aborted 一律不算", () => {
    assert.equal(isUserAbort({ kind: "error" }), false);
    assert.equal(isUserAbort(null), false);
  });
});

describe("isAbnormalReason", () => {
  it("识别 error/aborted/interrupted/max-tokens", () => {
    for (const kind of ["error", "aborted", "interrupted", "max-tokens"]) {
      assert.equal(isAbnormalReason({ kind }), true, kind);
    }
  });
  it("正常结束不算异常", () => {
    assert.equal(isAbnormalReason({ kind: "done" }), false);
    assert.equal(isAbnormalReason(null), false);
  });
});

describe("failureCodeOf — 三个来源的优先级", () => {
  it("error.code 优先", () => {
    assert.equal(failureCodeOf({ error: { code: "a" }, failure: { code: "b" }, code: "c" }), "A");
  });
  it("其次 failure.code", () => {
    assert.equal(failureCodeOf({ failure: { code: "b" }, code: "c" }), "B");
  });
  it("最后 reason.code", () => {
    assert.equal(failureCodeOf({ code: "c" }), "C");
  });
  it("都没有返回空串", () => {
    assert.equal(failureCodeOf({}), "");
    assert.equal(failureCodeOf(null), "");
  });
});

describe("shouldAutoContinue — 方向性判定", () => {
  it("纯中断（无错误码）可以继续", () => {
    assert.equal(shouldAutoContinue({ kind: "interrupted" }), true);
    assert.equal(shouldAutoContinue({ kind: "max-tokens" }), true);
  });

  it("用户主动中断不继续", () => {
    assert.equal(shouldAutoContinue({ kind: "aborted", reason: "user" }), false);
  });

  it("★ 永久码不继续（换问法也没用）", () => {
    for (const code of ["AUTH", "UNAUTHORIZED", "FORBIDDEN", "QUOTA", "CONTEXT_OVERFLOW", "MODEL_NOT_FOUND"]) {
      assert.equal(shouldAutoContinue({ kind: "error", code }), false, code);
    }
  });

  it("★ RATE_LIMIT / TRANSPORT 也不继续（官方已重试，再插只会加剧拥塞）", () => {
    assert.equal(shouldAutoContinue({ kind: "error", code: "RATE_LIMIT" }), false);
    assert.equal(shouldAutoContinue({ kind: "error", code: "TRANSPORT" }), false);
  });

  it("未知错误码可以继续", () => {
    assert.equal(shouldAutoContinue({ kind: "error", code: "WEIRD_UNKNOWN" }), true);
  });

  it("正常结束不继续", () => {
    assert.equal(shouldAutoContinue({ kind: "done" }), false);
  });

  it("小写错误码按大写处理", () => {
    assert.equal(shouldAutoContinue({ kind: "error", code: "auth" }), false);
  });
});

describe("isPermanentFailure", () => {
  it("永久码", () => {
    for (const code of ["AUTH", "QUOTA", "BILLING", "NO_ADAPTER", "INVALID_CREDENTIAL"]) {
      assert.equal(isPermanentFailure(code), true, code);
    }
  });
  it("大小写不敏感", () => {
    assert.equal(isPermanentFailure("auth"), true);
  });
  it("非永久码", () => {
    for (const code of ["RATE_LIMIT", "TRANSPORT", "UNKNOWN", "", null, undefined]) {
      assert.equal(isPermanentFailure(code), false, String(code));
    }
  });
});

describe("shouldAutoRetry", () => {
  it("非永久失败可重试", () => {
    assert.equal(shouldAutoRetry({ code: "RATE_LIMIT" }, {}), true);
  });
  it("永久失败不重试", () => {
    assert.equal(shouldAutoRetry({ code: "AUTH" }, {}), false);
  });
  it("★ 已 abort 的请求不重试（用户已经不要了）", () => {
    assert.equal(shouldAutoRetry({ code: "X" }, { aborted: true }), false);
  });
  it("无 failure 时可重试", () => {
    assert.equal(shouldAutoRetry(null, {}), true);
  });
});

describe("差分对照：新实现 === dsh-qilin 原实现", () => {
  const qilin = findQilin();

  it("全部导出函数输出逐一相等（96 组）", { skip: qilin === null }, async () => {
    const old = (await import(`file://${qilin}/lib/continue-retry.js`)) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    let compared = 0;

    for (const v of [0, 1, 3, 20, 21, -1, "5", "abc", null, undefined, 3.7, NaN, Infinity]) {
      assert.deepEqual(clampCount(v), old["clampCount"]!(v), `clampCount(${String(v)})`);
      compared += 1;
    }

    const cfgs: unknown[] = [
      {}, { autoRetry: false }, { retryMax: 0 }, { continueMax: 0 }, { autoContinue: true },
      { autoContinue: true, continueMax: 0 }, { continueText: "  " }, { continueText: "go" },
      { retryMax: 99 }, { retryMax: "x" },
    ];
    for (const c of cfgs) {
      assert.deepEqual(normalizeConfig(c), old["normalizeConfig"]!(c), `normalizeConfig(${JSON.stringify(c)})`);
      compared += 1;
    }

    const reasons: unknown[] = [
      null, undefined, { kind: "error" }, { kind: "error", code: "AUTH" },
      { kind: "error", error: { code: "rate_limit" } }, { kind: "aborted", reason: "user" },
      { kind: "aborted", reason: "cancel" }, { kind: "aborted", reason: { kind: "user" } },
      { kind: "aborted", reason: "other" }, { kind: "max-tokens" }, { kind: "interrupted" },
      { kind: "done" }, { kind: "error", failure: { code: "TRANSPORT" } },
      { kind: "error", code: "QUOTA" }, { kind: "error", code: "UNKNOWN_X" },
    ];
    for (const r of reasons) {
      const label = JSON.stringify(r) ?? "undefined";
      assert.deepEqual(isUserAbort(r as never), old["isUserAbort"]!(r), `isUserAbort(${label})`);
      assert.deepEqual(isAbnormalReason(r as never), old["isAbnormalReason"]!(r), `isAbnormal(${label})`);
      assert.deepEqual(failureCodeOf(r as never), old["failureCodeOf"]!(r), `failureCode(${label})`);
      assert.deepEqual(shouldAutoContinue(r as never), old["shouldAutoContinue"]!(r), `autoContinue(${label})`);
      compared += 4;
    }

    for (const c of ["AUTH", "auth", "RATE_LIMIT", "TRANSPORT", "OK", "", null, undefined]) {
      assert.deepEqual(isPermanentFailure(c), old["isPermanentFailure"]!(c), `permanent(${String(c)})`);
      compared += 1;
    }

    for (const [f, s] of [
      [{ code: "AUTH" }, {}],
      [{ code: "X" }, { aborted: true }],
      [null, {}],
      [{}, { aborted: false }],
    ] as const) {
      assert.deepEqual(shouldAutoRetry(f as never, s as never), old["shouldAutoRetry"]!(f, s), "autoRetry");
      compared += 1;
    }

    assert.deepEqual(mergeConfig({}, { autoContinue: true }), old["mergeConfig"]!({}, { autoContinue: true }));
    compared += 1;

    assert.ok(compared >= 90, `对比样本过少：${compared}`);
  });
});
