/**
 * 回退决策测试。
 *
 * 主判据是**差分对照**：同一批事件流喂给 dsh-qilin 原实现与本实现，
 * 断言 planRewind / pendingInboxInserts / lastTurnSubagentIds / lastHumanUserText
 * 输出逐一相等。
 *
 * 回退逻辑错了不报错，只会让用户退到错误位置或清掉不该清的内容，
 * 所以这里不靠"看起来对"，只靠对照。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isHumanUserEvent,
  isPluginDraft,
  isRewindMarkerEvent,
  isRoundPromptEvent,
  lastHumanUserText,
  lastTurnSubagentIds,
  pendingInboxInserts,
  planRewind,
  userTextFromEvent,
  type SessionEvent,
} from "../../src/features/rewind.js";
import { findUpstreamRoot } from "../helpers/upstream.js";

const QILIN_CANDIDATES = [
  // 不写死作者机器路径：由 helpers/upstream 按 DSH_QILIN_ROOT / 同级检出 / 子目录顺序解析。
  // 早期这里写死绝对路径，导致 CI 上对照测试直接 ERR_MODULE_NOT_FOUND 崩掉整个 job。
  ...(findUpstreamRoot() === null ? [] : [findUpstreamRoot() as string]),
];
function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "rewind.js"))) return c;
  }
  return null;
}

const ev = (seq: number, type: string, data?: Record<string, unknown>): SessionEvent => ({
  seq,
  type,
  ...(data === undefined ? {} : { data }),
});

/** 覆盖各分支的事件流。 */
const FIXTURES: Record<string, unknown> = {
  empty: [],
  noTurnStruct: [ev(1, "user/message", { content: "hello", source: { kind: "user" } })],
  openTurn: [
    ev(1, "user/message", { content: "第一句", source: { kind: "user" } }),
    ev(2, "turn/start", { turn: 1 }),
    ev(3, "step/start", { turn: 1, step: 1 }),
  ],
  closedTurn: [
    ev(1, "user/message", { content: "第一句", source: { kind: "user" } }),
    ev(2, "turn/start", { turn: 1 }),
    ev(3, "step/start", { turn: 1, step: 1 }),
    ev(4, "turn/end", { turn: 1 }),
  ],
  twoTurns: [
    ev(1, "user/message", { content: "第一句", source: { kind: "user" } }),
    ev(2, "turn/start", { turn: 1 }),
    ev(3, "step/start", { turn: 1, step: 1 }),
    ev(4, "turn/end", { turn: 1 }),
    ev(5, "user/message", { content: "第二句", source: { kind: "user" } }),
    ev(6, "turn/start", { turn: 2 }),
    ev(7, "step/start", { turn: 2, step: 1 }),
  ],
  multiStep: [
    ev(1, "user/message", { content: "q", source: { kind: "user" } }),
    ev(2, "turn/start", { turn: 1 }),
    ev(3, "step/start", { turn: 1, step: 1 }),
    ev(4, "step/start", { turn: 1, step: 2 }),
  ],
  pluginOnly: [ev(1, "user/message", { content: "x", source: { kind: "plugin" } })],
  goalRound: [ev(1, "user/message", { content: "goal text", source: { kind: "goal", round: 0 } })],
  mnemonic: [ev(1, "user/message", { content: "[MNEMON] snapshot", source: { kind: "user" } })],
  rewindMarker: [ev(1, "user/message", { id: "rewind-1", content: "x", source: { kind: "user" } })],
  inbox: [
    ev(1, "turn/start", { turn: 1 }),
    ev(2, "turn/end", { turn: 1 }),
    ev(3, "agent/inbox/spliced", { target: "next-turn", inserted: [{ id: "a" }, { id: "b" }] }),
    ev(4, "agent/inbox/spliced", { inserted: [{ id: "c" }] }),
  ],
  subagents: [
    ev(1, "turn/start", { turn: 1 }),
    ev(2, "subagent/catalog", { childId: "s1" }),
    ev(3, "subagent/descriptor", { sessionId: "s2" }),
  ],
  nullEvents: null,
  messy: [null, undefined, ev(2, "user/message", { content: "z", source: { kind: "user" } }), { type: "turn/start" }],
};

describe("userTextFromEvent", () => {
  it("字符串内容", () => {
    assert.equal(userTextFromEvent({ data: { content: "  hi  " } }), "hi");
  });
  it("content block 数组只取 text", () => {
    const e: SessionEvent = {
      data: {
        content: [
          { type: "text", text: "a" },
          { type: "image" },
          "plain",
          { text: "b" },
        ],
      },
    };
    assert.equal(userTextFromEvent(e), "aplainb");
  });
  it("从 message.content 兜底", () => {
    assert.equal(userTextFromEvent({ data: { message: { content: "m" } } }), "m");
  });
  it("无内容返回空串", () => {
    assert.equal(userTextFromEvent(null), "");
    assert.equal(userTextFromEvent({}), "");
  });
});

describe("isPluginDraft", () => {
  it("识别 MNEMON 三种形态", () => {
    assert.equal(isPluginDraft("[MNEMON] x"), true);
    assert.equal(isPluginDraft("MNEMON RUNTIME MEMORY SNAPSHOT"), true);
    assert.equal(isPluginDraft("MNEMON VIEW TOOLS"), true);
  });
  it("普通文本不算", () => {
    assert.equal(isPluginDraft("hello"), false);
    assert.equal(isPluginDraft(""), false);
  });
});

describe("事件谓词", () => {
  it("isRewindMarkerEvent 认 rewind- 前缀", () => {
    assert.equal(isRewindMarkerEvent(ev(1, "user/message", { id: "rewind-1" })), true);
    assert.equal(isRewindMarkerEvent(ev(1, "user/message", { id: "user-1" })), false);
  });

  it("isHumanUserEvent 排除 plugin 来源", () => {
    assert.equal(isHumanUserEvent(ev(1, "user/message", { content: "a", source: { kind: "user" } })), true);
    assert.equal(isHumanUserEvent(ev(1, "user/message", { content: "a", source: { kind: "plugin" } })), false);
  });

  it("isHumanUserEvent 排除 MNEMON 草稿", () => {
    assert.equal(isHumanUserEvent(ev(1, "user/message", { content: "[MNEMON] x", source: { kind: "user" } })), false);
  });

  it("isRoundPromptEvent 接受 goal 的非负 round", () => {
    assert.equal(isRoundPromptEvent(ev(1, "user/message", { content: "g", source: { kind: "goal", round: 0 } })), true);
    assert.equal(isRoundPromptEvent(ev(1, "user/message", { content: "g", source: { kind: "goal", round: -1 } })), false);
  });

  it("isRoundPromptEvent 排除 rewind 标记", () => {
    assert.equal(
      isRoundPromptEvent(ev(1, "user/message", { id: "rewind-1", content: "x", source: { kind: "user" } })),
      false,
    );
  });
});

describe("planRewind — 结构语义", () => {
  it("空事件流返回错误", () => {
    const p = planRewind([]);
    assert.equal(p.ok, false);
  });

  it("首步回退会把切点推到 turn/start，此时提示语落在切点之前（text 为空）", () => {
    // 这是实测行为（与原实现一致）：cutSeq 被推到 turn/start，
    // 而 userTextFromRange 只从 cutSeq 起往前找，所以 seq=1 的那句
    // 提示语落在切点之外 → text 为空。
    // 直觉上会以为「应当带上本轮提示语」，但回退后的语义是
    // 「把提示语留在输入框」由另一条路径（draft）负责，不在这里。
    const p = planRewind(FIXTURES["openTurn"]);
    assert.equal(p.ok, true);
    if (p.ok) {
      assert.equal(p.unit, "step");
      assert.equal(p.mode, "fork");
      assert.equal(p.text, "");
      assert.equal(p.mode === "fork" ? p.atSeq : null, 1, "切点落在提示语那一条");
      assert.equal(p.fromSeq, 2, "从 turn/start 处切");
    }
  });

  it("多步骤时退的是当前步，不是整轮", () => {
    const p = planRewind(FIXTURES["multiStep"], "once");
    assert.equal(p.ok, true);
    if (p.ok) assert.equal(p.mode, "fork");
  });

  it("round 模式退整轮", () => {
    const p = planRewind(FIXTURES["twoTurns"], "round");
    assert.equal(p.ok, true);
    if (p.ok) assert.equal(p.unit, "turn");
  });

  it("没有任何历史时返回 blank（不是 fork）", () => {
    const p = planRewind(FIXTURES["noTurnStruct"], "round");
    assert.equal(p.ok, true);
    if (p.ok) {
      assert.equal(p.mode, "blank");
      assert.equal(p.text, "hello");
    }
  });

  it("只有插件消息时不提供回退", () => {
    const p = planRewind(FIXTURES["pluginOnly"]);
    assert.equal(p.ok, false);
  });

  it("MNEMON 草稿不参与回退", () => {
    const p = planRewind(FIXTURES["mnemonic"]);
    assert.equal(p.ok, false);
  });
});

describe("pendingInboxInserts", () => {
  it("只取最后一个 turn/end 之后、且 target 为 next-turn 的插入", () => {
    const ids = pendingInboxInserts(FIXTURES["inbox"]);
    assert.deepEqual(ids, ["a", "b", "c"]);
  });
  it("非数组输入返回空", () => {
    assert.deepEqual(pendingInboxInserts(null), []);
  });
});

describe("lastTurnSubagentIds", () => {
  it("收集 childId 与 sessionId", () => {
    const ids = lastTurnSubagentIds(FIXTURES["subagents"]);
    assert.deepEqual(ids, ["s1", "s2"]);
  });
  it("没有 turn/start 时返回空", () => {
    assert.deepEqual(lastTurnSubagentIds(FIXTURES["empty"]), []);
  });
});

describe("lastHumanUserText", () => {
  it("取最近一条人类消息", () => {
    assert.equal(lastHumanUserText(FIXTURES["twoTurns"]), "第二句");
  });
  it("只有插件消息时返回空", () => {
    assert.equal(lastHumanUserText(FIXTURES["pluginOnly"]), "");
  });
});

describe("差分对照：新实现 === dsh-qilin 原实现", () => {
  const qilin = findQilin();

  it("4 个函数 x 14 组事件流输出逐一相等", { skip: qilin === null }, async () => {
    const old = (await import(`file://${qilin}/lib/rewind.js`)) as Record<string, (a: unknown, b?: unknown) => unknown>;
    let compared = 0;

    for (const [name, events] of Object.entries(FIXTURES)) {
      assert.deepEqual(planRewind(events, "once"), old["planRewind"]!(events, "once"), `once/${name}`);
      assert.deepEqual(planRewind(events, "round"), old["planRewind"]!(events, "round"), `round/${name}`);
      assert.deepEqual(lastHumanUserText(events), old["lastHumanUserText"]!(events), `humanText/${name}`);
      assert.deepEqual(pendingInboxInserts(events), old["pendingInboxInserts"]!(events), `inbox/${name}`);
      assert.deepEqual(lastTurnSubagentIds(events), old["lastTurnSubagentIds"]!(events), `subagents/${name}`);
      compared += 5;
    }
    assert.ok(compared >= 65, `对比样本过少：${compared}`);
  });
});
