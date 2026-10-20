/**
 * 版本逻辑测试。
 *
 * 除常规用例外，这里**故意**固定了一个已知偏差：
 * prerelease 用字符串比较，导致 beta10 < beta9。
 * 那不是我们要的行为，但它是原实现的行为，改写属于独立决策。
 * 用测试记录它，比在注释里留一句话更难被忽略。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  hideListedVersion,
  isBetaName,
  isWithdrawnVersion,
  latestStableVersion,
  normalizeChannel,
  splitVersion,
  versionIsNewer,
} from "../../src/platform/version.js";
import { findUpstreamRoot } from "../helpers/upstream.js";

const QILIN_CANDIDATES = [
  // 不写死作者机器路径：由 helpers/upstream 按 DSH_QILIN_ROOT / 同级检出 / 子目录顺序解析。
  // 早期这里写死绝对路径，导致 CI 上对照测试直接 ERR_MODULE_NOT_FOUND 崩掉整个 job。
  ...(findUpstreamRoot() === null ? [] : [findUpstreamRoot() as string]),
];
function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "update.js"))) return c;
  }
  return null;
}

describe("normalizeChannel", () => {
  it("beta 归一为 beta（大小写不敏感）", () => {
    assert.equal(normalizeChannel("beta"), "beta");
    assert.equal(normalizeChannel("BETA"), "beta");
  });

  it("★ 不做 trim：带空格视为 stable（原实现如此）", () => {
    // 原实现是 String(value||"").toLowerCase() === "beta"，没有 trim。
    // 这是既有行为，改成 trim 会让 " Beta " 的调用点语义变化，属于独立决策。
    assert.equal(normalizeChannel(" Beta "), "stable");
  });
  it("其余一律 stable", () => {
    assert.equal(normalizeChannel("stable"), "stable");
    assert.equal(normalizeChannel(""), "stable");
    assert.equal(normalizeChannel(null), "stable");
    assert.equal(normalizeChannel(undefined), "stable");
    assert.equal(normalizeChannel("preview"), "stable");
  });
});

describe("isBetaName", () => {
  it("识别 beta/rc/pre/preview/test 作为独立词段", () => {
    assert.equal(isBetaName("1.2.0-beta1"), true);
    assert.equal(isBetaName("1.2.0.rc2"), true);
    assert.equal(isBetaName("1.2.0_pre"), true);
    assert.equal(isBetaName("preview3"), true);
    assert.equal(isBetaName("v1.0.0-test"), true);
  });
  it("不误判包含这些子串的正常名字", () => {
    assert.equal(isBetaName("betamax"), false);
    assert.equal(isBetaName("1.0.0"), false);
    assert.equal(isBetaName("prestigious"), false);
    assert.equal(isBetaName(""), false);
  });
});

describe("splitVersion", () => {
  it("拆主版本与 pre", () => {
    assert.deepEqual(splitVersion("1.2.3"), { core: [1, 2, 3], pre: "" });
    assert.deepEqual(splitVersion("v1.2.3"), { core: [1, 2, 3], pre: "" });
    assert.deepEqual(splitVersion("1.2.3-beta1"), { core: [1, 2, 3], pre: "beta1" });
  });
  it("缺段补 0", () => {
    assert.deepEqual(splitVersion("1"), { core: [1, 0, 0], pre: "" });
    assert.deepEqual(splitVersion("1.2"), { core: [1, 2, 0], pre: "" });
  });
  it("非数字段当 0", () => {
    assert.deepEqual(splitVersion("x.y.z"), { core: [0, 0, 0], pre: "" });
  });
  it("多段 pre 保留完整尾巴", () => {
    assert.deepEqual(splitVersion("1.2.3-beta-2-x"), { core: [1, 2, 3], pre: "beta-2-x" });
  });
});

describe("versionIsNewer — 主版本", () => {
  it("remote 更高", () => {
    assert.equal(versionIsNewer("1.2.0", "1.1.9"), true);
    assert.equal(versionIsNewer("2.0.0", "1.99.99"), true);
    assert.equal(versionIsNewer("1.10.0", "1.9.0"), true);
  });
  it("remote 更低", () => {
    assert.equal(versionIsNewer("1.1.9", "1.2.0"), false);
  });
  it("相等", () => {
    assert.equal(versionIsNewer("1.1.9", "1.1.9"), false);
    assert.equal(versionIsNewer("v1.2.0", "1.2.0"), false, "v 前缀不算差异");
  });
  it("空值语义", () => {
    assert.equal(versionIsNewer("", "1.0.0"), false, "remote 空 → 不更新");
    assert.equal(versionIsNewer("1.0.0", ""), true, "local 空 → 视为需要更新");
  });
});

describe("versionIsNewer — prerelease", () => {
  it("正式版比同号 prerelease 新", () => {
    assert.equal(versionIsNewer("1.2.0", "1.2.0-beta"), true);
  });
  it("prerelease 不比同号正式版新", () => {
    assert.equal(versionIsNewer("1.2.0-beta", "1.2.0"), false);
  });

  it("★ 已知偏差：beta10 与 beta9 按字典序比较，方向是反的", () => {
    // 原实现 `return a.pre > b.pre` 是纯字符串比较：
    //   "beta10" > "beta9" → false （'1' < '9'） → beta10 不被认为更新
    //   "beta9"  > "beta10" → true  （'9' > '1'） → beta9 反而被认为更新
    // 正确 semver 下 beta10 > beta9。这里**固定现状**（含反向），
    // 若要修正必须单独评估对已发布版本判定历史的影响。
    assert.equal(versionIsNewer("1.2.0-beta10", "1.2.0-beta9"), false);
    assert.equal(versionIsNewer("1.2.0-beta9", "1.2.0-beta10"), true, "字典序导致旧版被认为更新");
  });

  it("同长度 prerelease 的字典序结果", () => {
    assert.equal(versionIsNewer("1.2.0-beta2", "1.2.0-beta1"), true, "'2' > '1'");
    assert.equal(versionIsNewer("1.2.0-rc1", "1.2.0-beta1"), true, "'r'(0x72) > 'b'(0x62)");
  });
});

describe("latestStableVersion", () => {
  it("挑最大稳定版", () => {
    const list = [{ version: "1.0.0" }, { version: "1.2.0" }, { version: "1.1.0" }];
    assert.equal(latestStableVersion(list), "1.2.0");
  });
  it("忽略 beta 频道", () => {
    assert.equal(
      latestStableVersion([{ version: "1.0.0" }, { version: "2.0.0", channel: "beta" }]),
      "1.0.0",
    );
  });
  it("忽略 beta 命名", () => {
    assert.equal(latestStableVersion([{ version: "1.0.0" }, { version: "1.5.0-beta1" }]), "1.0.0");
  });
  it("容忍 v 前缀", () => {
    assert.equal(latestStableVersion([{ version: "v1.0.0" }, { version: "1.1.0" }]), "1.1.0");
  });
  it("空列表返回空串", () => {
    assert.equal(latestStableVersion([]), "");
    assert.equal(latestStableVersion(null), "");
    assert.equal(latestStableVersion(undefined), "");
  });
  it("全部非稳定版时返回空串", () => {
    assert.equal(latestStableVersion([{ version: "1.1.11-beta" }]), "");
  });
  it("跳过非法版本号格式", () => {
    assert.equal(latestStableVersion([{ version: "not-a-version" }, { version: "1.0.0" }]), "1.0.0");
  });
});

describe("isWithdrawnVersion", () => {
  it("识别 1.1.11-beta 系列", () => {
    assert.equal(isWithdrawnVersion({ version: "1.1.11-beta" }), true);
    assert.equal(isWithdrawnVersion({ version: "v1.1.11-beta3" }), true);
    assert.equal(isWithdrawnVersion({ ref: "1.1.11-beta" }), true);
    assert.equal(isWithdrawnVersion({ id: "x 1.1.11-beta" }), true);
  });
  it("其他版本不算撤回", () => {
    assert.equal(isWithdrawnVersion({ version: "1.1.11" }), false);
    assert.equal(isWithdrawnVersion({ version: "1.1.12-beta" }), false);
    assert.equal(isWithdrawnVersion(null), false);
  });
});

describe("hideListedVersion", () => {
  it("撤回版本隐藏", () => {
    assert.equal(hideListedVersion({ version: "1.1.11-beta" }), true);
  });
  it("beta 频道隐藏", () => {
    assert.equal(hideListedVersion({ version: "1.2.0", channel: "beta" }), true);
  });
  it("beta 分支头保留（例外）", () => {
    assert.equal(hideListedVersion({ ref: "beta", channel: "beta" }), false);
  });
  it("beta 命名隐藏", () => {
    assert.equal(hideListedVersion({ id: "x-rc1" }), true);
  });
  it("正常稳定版显示", () => {
    assert.equal(hideListedVersion({ version: "1.0.0" }), false);
  });
  it("null 隐藏", () => {
    assert.equal(hideListedVersion(null), true);
  });
});

describe("差分对照：新实现 === dsh-qilin 原实现", () => {
  const qilin = findQilin();

  it("三个导出函数输出逐条相等", { skip: qilin === null }, async () => {
    const old = (await import(`file://${qilin}/lib/update.js`)) as Record<string, (...a: never[]) => unknown>;

    const pairs: [string, string][] = [
      ["1.2.0", "1.1.9"], ["1.1.9", "1.2.0"], ["1.1.9", "1.1.9"], ["v1.2.0", "1.2.0"],
      ["1.2.0-beta", "1.2.0"], ["1.2.0", "1.2.0-beta"], ["1.2.0-beta9", "1.2.0-beta10"],
      ["1.0.0", "0.9.9"], ["2.0.0", "1.99.99"], ["", "1.0.0"], ["1.0.0", ""],
      ["1.2.10", "1.2.9"], ["1.10.0", "1.9.0"],
    ];
    let compared = 0;
    for (const [a, b] of pairs) {
      assert.equal(versionIsNewer(a, b), old["versionIsNewer"]!(a as never, b as never), `${a} vs ${b}`);
      compared += 1;
    }

    const lists = [
      [{ version: "1.0.0" }, { version: "1.2.0" }, { version: "1.1.0" }],
      [{ version: "1.0.0" }, { version: "2.0.0-beta", channel: "beta" }],
      [{ version: "v1.0.0" }, { version: "1.1.0" }],
      [{ version: "1.1.11-beta" }],
    ];
    for (const list of lists) {
      assert.equal(latestStableVersion(list), old["latestStableVersion"]!(list as never));
      compared += 1;
    }

    const items = [
      { version: "1.0.0" },
      { version: "1.2.0-beta", channel: "beta" },
      { ref: "beta", channel: "beta" },
      { version: "1.1.11-beta" },
      { id: "x-rc1" },
    ];
    for (const item of items) {
      assert.equal(hideListedVersion(item), old["hideListedVersion"]!(item as never));
      compared += 1;
    }

    assert.ok(compared >= 20, `对比样本过少：${compared}`);
  });
});
