/**
 * settings 的测试。
 *
 * 重点在**优先级**与**收敛**：settings.json → env → 默认 3，
 * 以及"任何怪值都不能让并发上限变成 0 或负数"（那会让闸门永远关门）。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_AGENTS,
  MAX_AGENTS_LIMIT,
  clampMaxAgents,
  maxAgentsOf,
  maxAgentsSourceOf,
  readSettings,
  saveMaxAgents,
  settingsPathOf,
  writeSettings,
} from "../../src/platform/settings.js";

describe("settingsPathOf", () => {
  it("拼到 root 下的 settings.json", () => {
    assert.equal(settingsPathOf("/data/redteam"), path.join("/data/redteam", "settings.json"));
  });

  it("空 root 退化成 ./settings.json（不抛）", () => {
    assert.equal(settingsPathOf(""), path.join(".", "settings.json"));
    assert.equal(settingsPathOf(null), path.join(".", "settings.json"));
    assert.equal(settingsPathOf(undefined), path.join(".", "settings.json"));
  });
});

describe("clampMaxAgents", () => {
  it("区间内原样返回", () => {
    assert.equal(clampMaxAgents(1), 1);
    assert.equal(clampMaxAgents(3), 3);
    assert.equal(clampMaxAgents(MAX_AGENTS_LIMIT), MAX_AGENTS_LIMIT);
  });

  it("低于 1 收敛到 1，高于上限收敛到上限", () => {
    assert.equal(clampMaxAgents(0), 1);
    assert.equal(clampMaxAgents(-5), 1);
    assert.equal(clampMaxAgents(11), MAX_AGENTS_LIMIT);
    assert.equal(clampMaxAgents(1e9), MAX_AGENTS_LIMIT);
  });

  it("小数向下取整（2.9 个智能体只能是 2 个）", () => {
    assert.equal(clampMaxAgents(2.9), 2);
    assert.equal(clampMaxAgents(3.999), 3);
    assert.equal(clampMaxAgents(0.9), 1);
  });

  it("数字字符串也能收敛", () => {
    assert.equal(clampMaxAgents("5"), 5);
    assert.equal(clampMaxAgents("99"), MAX_AGENTS_LIMIT);
  });

  it("非有限数退回默认值（绝不让上限变成 0）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "abc", undefined, {}]) {
      assert.equal(clampMaxAgents(bad), DEFAULT_MAX_AGENTS, String(bad));
    }
  });

  /**
   * 已实测的原实现怪癖：`Number(null) === 0` 是有限数，所以 `null` 不走
   * "退回默认值" 分支，而是被 clamp 成 **1**（比默认 3 更严）。
   *
   * 影响面：只有 `saveMaxAgents(root, null)` 这类调用会看到它，
   * 结果是"上限 1"而不是"默认 3" —— 更保守、不会超卖，但用户会疑惑。
   * 改它属于行为变更，先锁住现状，决定权交 Lead（见交接报告）。
   */
  it("null 被收敛成 1 而不是默认值（已知怪癖：Number(null)===0）", () => {
    assert.equal(clampMaxAgents(null), 1);
  });
});

describe("readSettings / writeSettings", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-settings-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("文件不存在时返回空对象", () => {
    assert.deepEqual(readSettings(tmp), {});
  });

  it("写后能读回，且是浅合并", () => {
    writeSettings(tmp, { maxAgents: 4 });
    writeSettings(tmp, { other: "x" });
    const got = readSettings(tmp);
    assert.equal(got["maxAgents"], 4);
    assert.equal(got["other"], "x");
  });

  it("写入的文件是可读 JSON（带尾换行）", () => {
    writeSettings(tmp, { maxAgents: 2 });
    const raw = fs.readFileSync(settingsPathOf(tmp), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.equal(JSON.parse(raw).maxAgents, 2);
  });

  it("目录不存在时自动创建", () => {
    const nested = path.join(tmp, "a", "b", "c");
    writeSettings(nested, { maxAgents: 5 });
    assert.equal(readSettings(nested)["maxAgents"], 5);
  });

  it("坏 JSON 当成空对象，绝不抛（坏文件不能拦住插件启动）", () => {
    fs.writeFileSync(settingsPathOf(tmp), "{not json", "utf8");
    assert.deepEqual(readSettings(tmp), {});
  });

  it("JSON 是数组 / null / 标量时也当空对象", () => {
    for (const bad of ["[]", "null", "42", '"str"']) {
      fs.writeFileSync(settingsPathOf(tmp), bad, "utf8");
      assert.deepEqual(readSettings(tmp), {}, bad);
    }
  });

  it("未知键原样保留（前向兼容）", () => {
    fs.writeFileSync(settingsPathOf(tmp), JSON.stringify({ maxAgents: 3, future: { a: 1 } }), "utf8");
    const got = readSettings(tmp);
    assert.deepEqual(got["future"], { a: 1 });
  });
});

describe("maxAgentsOf —— 优先级", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-maxagents-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("都没有时用默认 3", () => {
    assert.equal(maxAgentsOf(tmp, {}), DEFAULT_MAX_AGENTS);
  });

  it("settings.json 优先于环境变量", () => {
    writeSettings(tmp, { maxAgents: 7 });
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "2" }), 7);
  });

  it("没有 settings 时读环境变量", () => {
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "5" }), 5);
  });

  it("settings 里的坏值不生效，落到环境变量", () => {
    writeSettings(tmp, { maxAgents: 0 });
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "4" }), 4);
    writeSettings(tmp, { maxAgents: "abc" });
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "4" }), 4);
  });

  it("两边都超上限时都收敛到上限", () => {
    writeSettings(tmp, { maxAgents: 99 });
    assert.equal(maxAgentsOf(tmp, {}), MAX_AGENTS_LIMIT);
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "99" }), MAX_AGENTS_LIMIT);
  });

  it("负数与 0 都当无效值", () => {
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "0" }), DEFAULT_MAX_AGENTS);
    assert.equal(maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: "-3" }), DEFAULT_MAX_AGENTS);
  });

  it("返回值恒为 1..MAX 之间（闸门不会永远关门或永远开门）", () => {
    for (const v of ["-1", "0", "1", "10", "11", "1e9", "abc", "", undefined]) {
      const got = maxAgentsOf(tmp, { REDTEAM_MAX_AGENTS: v });
      assert.equal(got >= 1 && got <= MAX_AGENTS_LIMIT, true, String(v));
    }
  });
});

describe("saveMaxAgents", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-save-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("返回实际生效值（已 clamp）", () => {
    assert.equal(saveMaxAgents(tmp, 6), 6);
    assert.equal(saveMaxAgents(tmp, 99), MAX_AGENTS_LIMIT);
    assert.equal(saveMaxAgents(tmp, 0), 1);
  });

  it("落盘后 maxAgentsOf 立刻生效", () => {
    saveMaxAgents(tmp, 5);
    assert.equal(maxAgentsOf(tmp, {}), 5);
  });

  it("返回值与读回值一致（面板显示的就是生效的）", () => {
    const applied = saveMaxAgents(tmp, 8);
    assert.equal(Number(readSettings(tmp)["maxAgents"]), applied);
  });
});

describe("maxAgentsSourceOf", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-source-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("如实报告来源", () => {
    assert.equal(maxAgentsSourceOf(tmp, {}), "default");
    assert.equal(maxAgentsSourceOf(tmp, { REDTEAM_MAX_AGENTS: "5" }), "env");
    saveMaxAgents(tmp, 4);
    assert.equal(maxAgentsSourceOf(tmp, { REDTEAM_MAX_AGENTS: "5" }), "settings");
  });

  it("与 maxAgentsOf 的优先级判定一致（避免面板显示和实际生效不符）", () => {
    saveMaxAgents(tmp, 4);
    const env = { REDTEAM_MAX_AGENTS: "9" } as const;
    assert.equal(maxAgentsSourceOf(tmp, env), "settings");
    assert.equal(maxAgentsOf(tmp, env), 4);
  });
});
