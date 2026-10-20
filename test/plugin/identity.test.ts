/**
 * identity（提示词段操作）测试。
 *
 * ## 判据
 *
 * 1. **差分**：与原实现同一输入 → 同一输出（`rewritePromptAssembly` 全流程、各 helper）。
 *    参考实现冻结在 `test/plugin/fixtures/reference/identity.ts`（逐字复制）。
 * 2. **不变式**：不依赖原实现也能断言的硬约束（段顺序、不原地改写、幂等、guard 回收）。
 *
 * 上一版我按直觉写了 3 条期望，全错——原实现对空格、符号顺序、persona 段名都很敏感。
 * 所以凡是「能差分的一律差分」，只对**新增行为**（如 symlink 收紧）写独立断言。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_SECTION,
  capabilityProtocolText,
} from "../../src/plugin/capability-protocol.js";
import {
  GLOBAL_PROMPT_ORDER,
  installAssembleGuard,
  isChildAgentContext,
  isGuardedAssemble,
  isMnemonPluginMessage,
  isPluginPromptSection,
  isRedteamPresetId,
  isRedteamSession,
  presetLabel,
  rewritePromptAssembly,
  sessionAgentPreset,
  sessionForInject,
  OBJECTIVE_SECTION,
  REDTEAM_ROLE_SECTION,
  redteamOpsBody,
  redteamProcedure,
} from "../../src/plugin/identity.js";
import type { PromptSection } from "../../src/plugin/prompt-types.js";
import * as ref from "./fixtures/reference/identity.js";

const INJECT = "OPERATOR PROMPT BODY";

/** 造一个装配结果。 */
const asm = (sections: readonly PromptSection[]): { sections: PromptSection[]; contexts: unknown[]; tools: unknown[] } => ({
  sections: sections.map((s) => ({ ...s })),
  contexts: [{ id: "ctx" }],
  tools: [{ name: "tool" }],
});

/** 取段名序列。 */
const names = (out: unknown): readonly string[] => {
  const sections = (out as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];
  return sections.map((s) => (typeof (s as PromptSection).name === "string" ? (s as PromptSection).name ?? "" : ""));
};

/** 取某段的正文。 */
const textOf = (out: unknown, name: string): string => {
  const sections = (out as { sections?: readonly PromptSection[] }).sections ?? [];
  const hit = sections.find((s) => s.name === name);
  return typeof hit?.text === "string" ? hit.text : "";
};

// ───────────────────────────── 段命名约定 ─────────────────────────────

describe("段命名约定", () => {
  it("isPluginPromptSection 认 dsh-qilin 前缀", () => {
    assert.equal(isPluginPromptSection("dsh-qilin"), true);
    assert.equal(isPluginPromptSection("dsh-qilin:post"), true);
    assert.equal(isPluginPromptSection("dsh-qilin:rules"), true);
  });

  it("isPluginPromptSection 认 dshql- 前缀", () => {
    assert.equal(isPluginPromptSection("dshql-capabilities"), true);
    assert.equal(isPluginPromptSection("dshql-objective"), true);
  });

  it("官方段不算插件段", () => {
    assert.equal(isPluginPromptSection("harness:identity"), false);
    assert.equal(isPluginPromptSection("deployment:persona-prefix"), false);
  });

  it("CAPABILITY_SECTION 不带 dsh-qilin 前缀（否则会被宿主提到 inject 前）", () => {
    assert.equal(CAPABILITY_SECTION, "dshql-capabilities");
    assert.equal(CAPABILITY_SECTION.startsWith("dsh-qilin"), false);
  });

  it("卡与角色段名也不带 dsh-qilin 前缀", () => {
    assert.equal(OBJECTIVE_SECTION.startsWith("dsh-qilin"), false);
    assert.equal(REDTEAM_ROLE_SECTION.startsWith("dsh-qilin"), false);
  });

  it("GLOBAL_PROMPT_ORDER 是有限负数（不能是 -Infinity）", () => {
    assert.equal(GLOBAL_PROMPT_ORDER, -100000);
    assert.equal(Number.isFinite(GLOBAL_PROMPT_ORDER), true);
    // -Infinity 参与 sort 会得到 NaN，排序退化成插入序
    assert.equal(Number.isFinite(GLOBAL_PROMPT_ORDER + 1), true);
  });
});

// ───────────────────────────── 能力协议 ─────────────────────────────

describe("capabilityProtocolText", () => {
  it("默认走官方协议", () => {
    assert.equal(capabilityProtocolText(), ref.capabilityProtocolText());
    assert.match(capabilityProtocolText(), /Capability selection by task \(mandatory\)/);
  });

  it("红队主代理用红队协议", () => {
    assert.match(capabilityProtocolText({ redteam: true }), /redteam lead/);
  });

  it("红队子代理回到官方协议（子代与主代同一条流程）", () => {
    assert.equal(
      capabilityProtocolText({ redteam: true, redteamChild: true }),
      capabilityProtocolText(),
    );
  });

  it("enabled: false → 空串", () => {
    assert.equal(capabilityProtocolText({ enabled: false }), "");
    assert.equal(capabilityProtocolText({ enabled: false, redteam: true }), "");
  });

  it("与原实现逐字节一致（差分）", () => {
    const combos = [
      {},
      { redteam: true },
      { redteam: false },
      { redteam: true, redteamChild: true },
      { redteam: false, redteamChild: true },
      { enabled: false },
      { enabled: true, redteam: true, redteamChild: false },
    ] as const;
    for (const combo of combos) {
      assert.equal(capabilityProtocolText(combo), ref.capabilityProtocolText(combo), JSON.stringify(combo));
    }
  });
});

// ───────────────────────────── 预设判定 ─────────────────────────────

describe("presetLabel：三种形态", () => {
  it("字符串", () => {
    assert.equal(presetLabel(" redteam "), "redteam");
  });
  it("优先 id 再看 name", () => {
    assert.equal(presetLabel({ id: "a", name: "b" }), "a");
    assert.equal(presetLabel({ name: "b" }), "b");
  });
  it("非对象/空 → 空串", () => {
    assert.equal(presetLabel(null), "");
    assert.equal(presetLabel(42), "");
    assert.equal(presetLabel({}), "");
  });
  it("与原实现一致（差分）", () => {
    const corpus = ["redteam", " red team ", { id: "x" }, { name: " y " }, { id: "", name: "z" }, null, 42, {}];
    for (const value of corpus) {
      assert.equal(presetLabel(value), ref.presetLabel(value), JSON.stringify(value));
    }
  });
});

describe("isRedteamPresetId", () => {
  it("字面 redteam", () => {
    assert.equal(isRedteamPresetId("redteam"), true);
  });
  it("red team / red-team / red_team（大小写不敏感）", () => {
    assert.equal(isRedteamPresetId("RED TEAM"), true);
    assert.equal(isRedteamPresetId("red-team"), true);
    assert.equal(isRedteamPresetId("red_team"), true);
  });
  it("命名空间形式 my/redteam 不命中（原语义：只认字面形态与「红队」字样）", () => {
    // 原实现对 `xxx/redteam` 返回 false——「红队」二字不出现，正则也只匹配
    // **整串**的 red team。这是既有行为，逐字保留（差分测试钉死）。
    assert.equal(isRedteamPresetId("my/redteam"), false);
    assert.equal(isRedteamPresetId("my/redteam"), ref.isRedteamPresetId("my/redteam"));
  });
  it("含「红队」的中文标签命中", () => {
    assert.equal(isRedteamPresetId("红队主控"), true);
  });
  it("「不是红队」「非红队」不命中（那是别的预设在描述自己）", () => {
    assert.equal(isRedteamPresetId("不是红队"), false);
    assert.equal(isRedteamPresetId("非红队"), false);
  });
  it("空/无关 → false", () => {
    assert.equal(isRedteamPresetId(""), false);
    assert.equal(isRedteamPresetId("standard"), false);
  });
  it("与原实现一致（差分）", () => {
    const corpus = [
      "redteam", "RED TEAM", "red-team", "red_team", "red team", " my/redteam ",
      "红队主控", "不是红队", "非红队", "standard", "", "redteamx", "xredteam",
      { id: "redteam" }, { name: "红队" },
    ];
    for (const value of corpus) {
      assert.equal(isRedteamPresetId(value), ref.isRedteamPresetId(value), JSON.stringify(value));
    }
  });
});

// ───────────────────────────── 红队操作稿 ─────────────────────────────

describe("redteamOpsBody / redteamProcedure", () => {
  const OPS = "## 运行环境前提\n\n- 目标在本地\n\n## 指挥职责\n\n派活";

  it("从标记处截取", () => {
    assert.equal(redteamOpsBody(`前缀\n${OPS}`), OPS.trim());
  });

  it("没有标记 → null", () => {
    assert.equal(redteamOpsBody("没有操作稿"), null);
  });

  it("procedure 前面挂措辞覆盖", () => {
    const out = redteamProcedure(OPS);
    assert.notEqual(out, null);
    assert.match(out ?? "", /确认范围/);
    assert.match(out ?? "", /## 运行环境前提/);
  });

  it("旧标题改成指挥职责（硬约束）", () => {
    const out = redteamProcedure("## 运行环境前提\n\n## 你是谁、你不做什么\n\n正文");
    assert.match(out ?? "", /## 指挥职责（硬约束）/);
    assert.equal((out ?? "").includes("## 你是谁、你不做什么"), false);
  });

  it("已是新标题时不重复替换", () => {
    const withBoth = "## 运行环境前提\n\n## 你是谁、你不做什么\n\n## 指挥职责\n\n正文";
    const out = redteamProcedure(withBoth);
    assert.equal((out ?? "").includes("## 指挥职责（硬约束）"), false, "已有新标题就不该改旧标题");
  });

  it("旧说明句换成新说明句", () => {
    const old = "## 运行环境前提\n\n身份和规则以上面的提示词为准。下面只补充红队调度步骤，不改写上面的身份。";
    const out = redteamProcedure(old);
    assert.equal((out ?? "").includes("下面只补充红队调度步骤"), false);
    assert.match(out ?? "", /不是第二套身份/);
  });

  it("与原实现一致（差分）", () => {
    const corpus = [
      OPS,
      "前缀\n" + OPS,
      "没有操作稿",
      "## 运行环境前提\n\n## 你是谁、你不做什么\n\n正文",
      "## 运行环境前提\n\n## 你是谁\n\n## 指挥职责\n\nx",
      "## 运行环境前提\n\n身份和规则以上面的提示词为准。下面只补充红队调度步骤，不改写上面的身份。",
      "## 运行环境前提",
      "## 运行环境前提\n\n",
    ];
    for (const text of corpus) {
      assert.equal(redteamOpsBody(text), ref.redteamOpsBody(text), `opsBody ${JSON.stringify(text.slice(0, 30))}`);
      assert.equal(redteamProcedure(text), ref.redteamProcedure(text), `procedure ${JSON.stringify(text.slice(0, 30))}`);
    }
  });
});

// ───────────────────────────── 子代理 / 会话链 ─────────────────────────────

describe("isChildAgentContext", () => {
  it("origin=subagent → true", () => {
    assert.equal(isChildAgentContext({ session: { header: { origin: "subagent" } } }), true);
  });
  it("origin=teammate / delegate → true", () => {
    assert.equal(isChildAgentContext({ session: { header: { origin: "teammate" } } }), true);
    assert.equal(isChildAgentContext({ session: { header: { origin: "delegate" } } }), true);
  });
  it("delegationDepth > 0 → true（即使 origin 不是子代理）", () => {
    assert.equal(isChildAgentContext({ session: { header: { delegationDepth: 2 } } }), true);
  });
  it("普通会话 → false", () => {
    assert.equal(isChildAgentContext({ session: { header: { origin: "user" } } }), false);
  });
  it("没有 header → false", () => {
    assert.equal(isChildAgentContext({}), false);
  });
  it("与原实现一致（差分）", () => {
    const corpus = [
      { session: { header: { origin: "subagent" } } },
      { session: { header: { origin: "teammate" } } },
      { session: { header: { delegationDepth: 1 } } },
      { session: { header: {} } },
      { session: {} },
      {},
      { agent: { session: { header: { origin: "subagent" } } } },
      undefined,
    ];
    for (const ctx of corpus) {
      assert.equal(isChildAgentContext(ctx), ref.isChildAgentContext(ctx), JSON.stringify(ctx));
    }
  });
});

describe("sessionAgentPreset：优先本轮挂上的预设", () => {
  it("agentPresets.composedPreset 优先于事件与投影", () => {
    const ctx = {
      agent: {
        ctx: { agentPresets: { composedPreset: () => "redteam" } },
        session: { projectionValues: { agentPreset: "standard" } },
      },
    };
    assert.equal(sessionAgentPreset(ctx), "redteam");
  });

  it("没有 composedPreset 时看事件（后一个覆盖前一个）", () => {
    const ctx = {
      session: {
        snapshotEvents: () => [
          { type: "agent-preset/selected", data: { agentPreset: "standard" } },
          { type: "agent-preset/selected", data: { preset: "redteam" } },
        ],
      },
    };
    assert.equal(sessionAgentPreset(ctx), "redteam");
  });

  it("没有事件时看 projectionValues", () => {
    assert.equal(sessionAgentPreset({ session: { projectionValues: { agentPreset: "proj" } } }), "proj");
  });

  it("再看 session.agentPreset", () => {
    assert.equal(sessionAgentPreset({ session: { agentPreset: "header-preset" } }), "header-preset");
  });

  it("最后看 session.header.agentPreset", () => {
    assert.equal(sessionAgentPreset({ session: { header: { agentPreset: "deep" } } }), "deep");
  });

  it("composedPreset 抛错 → 退回事件", () => {
    const ctx = {
      agent: {
        ctx: {
          agentPresets: {
            composedPreset: () => {
              throw new Error("not mounted");
            },
          },
        },
        session: { agentPreset: "fallback" },
      },
    };
    assert.equal(sessionAgentPreset(ctx), "fallback");
  });

  it("什么都没 → 空串", () => {
    assert.equal(sessionAgentPreset({}), "");
  });

  it("与原实现一致（差分）", () => {
    const corpus = [
      { agent: { ctx: { agentPresets: { composedPreset: () => "redteam" } }, session: {} } },
      { agent: { ctx: { agentPresets: { composedPreset: () => ({ id: "x" }) } }, session: {} } },
      { agent: { ctx: { agentPresets: {} }, session: {} } },
      { session: { snapshotEvents: () => [{ type: "agent-preset/selected", data: { agentPreset: "ev" } }] } },
      { session: { projectionValues: { agentPreset: "proj" } } },
      { session: { agentPreset: "h" } },
      { session: { header: { agentPreset: "hh" } } },
      {},
    ];
    for (const ctx of corpus) {
      assert.equal(sessionAgentPreset(ctx), ref.sessionAgentPreset(ctx), JSON.stringify(ctx).slice(0, 80));
    }
  });
});

describe("sessionForInject：子代理沿父会话走到主会话", () => {
  it("非子代理 → 自己", () => {
    const session = { header: { origin: "user" } };
    assert.equal(sessionForInject({ session }), session);
  });

  it("子代理且有父会话记录 → 走到父", () => {
    const parent = { header: { origin: "user" }, id: "parent" };
    const child = { header: { origin: "subagent", parentSession: "parent" }, id: "child" };
    const ctx = { session: child, agent: { parent: { get: (id: string) => (id === "parent" ? parent : null) } } };
    assert.equal(sessionForInject(ctx), parent);
  });

  it("父会话找不到 → 停在自己", () => {
    const child = { header: { origin: "subagent", parentSession: "missing" } };
    assert.equal(sessionForInject({ session: child }), child);
  });

  it("父子互相指（环）不死循环", () => {
    const a: Record<string, unknown> = { header: { origin: "subagent", parentSession: "b" } };
    const b: Record<string, unknown> = { header: { origin: "subagent", parentSession: "a" } };
    const bag = { get: (id: string): unknown => (id === "a" ? a : id === "b" ? b : null) };
    const ctx = { session: a, agent: { parent: bag } };
    const out = sessionForInject(ctx);
    assert.ok(out === a || out === b, "必须收敛到某个会话，不能无限循环");
  });

  it("没有会话 → null", () => {
    assert.equal(sessionForInject({}), null);
    assert.equal(sessionForInject({}), ref.sessionForInject({}));
  });
});

describe("isRedteamSession", () => {
  it("红队主会话 → true", () => {
    const ctx = { session: { agentPreset: "redteam" } };
    assert.equal(isRedteamSession(ctx), true);
  });

  it("普通会话 → false", () => {
    assert.equal(isRedteamSession({ session: { agentPreset: "standard" } }), false);
  });

  it("子代理跟随主会话的预设", () => {
    const parent = { header: { origin: "user" }, agentPreset: "redteam" };
    const child = { header: { origin: "subagent", parentSession: "p" } };
    const ctx = { session: child, agent: { parent: { get: () => parent } } };
    assert.equal(isRedteamSession(ctx), true);
  });

  it("与原实现一致（差分）", () => {
    const corpus = [
      { session: { agentPreset: "redteam" } },
      { session: { agentPreset: "standard" } },
      { session: { header: { agentPreset: "红队" } } },
      {},
    ];
    for (const ctx of corpus) {
      assert.equal(isRedteamSession(ctx), ref.isRedteamSession(ctx), JSON.stringify(ctx));
    }
  });
});

// ───────────────────────────── mnemon ─────────────────────────────

describe("isMnemonPluginMessage", () => {
  it("source.kind=plugin 且含 mnemon → true", () => {
    assert.equal(isMnemonPluginMessage({ source: { kind: "plugin", plugin: "dsh-mnemon" } }), true);
  });

  it("大小写不敏感", () => {
    assert.equal(isMnemonPluginMessage({ source: { kind: "plugin", plugin: "DSH-MNEMON" } }), true);
  });

  it("kind 不是 plugin → false", () => {
    assert.equal(isMnemonPluginMessage({ source: { kind: "user", plugin: "mnemon" } }), false);
  });

  it("plugin 名不含 mnemon → false", () => {
    assert.equal(isMnemonPluginMessage({ source: { kind: "plugin", plugin: "other" } }), false);
  });

  it("没有 source → false", () => {
    assert.equal(isMnemonPluginMessage({}), false);
    assert.equal(isMnemonPluginMessage(null), false);
  });

  it("与原实现一致（差分）", () => {
    const corpus = [
      { source: { kind: "plugin", plugin: "dsh-mnemon" } },
      { source: { kind: "plugin", plugin: "DSH-MNEMON" } },
      { source: { kind: "user", plugin: "mnemon" } },
      { source: { kind: "plugin" } },
      { source: "string" },
      {},
      null,
    ];
    for (const message of corpus) {
      assert.equal(isMnemonPluginMessage(message), ref.isMnemonPluginMessage(message), JSON.stringify(message));
    }
  });
});

// ───────────────────────────── 装配改写：差分 ─────────────────────────────

describe("rewritePromptAssembly：与原实现逐字节一致（差分）", () => {
  interface Case {
    readonly label: string;
    readonly assembled: unknown;
    readonly fallback: string;
    readonly options: Record<string, unknown>;
  }

  const CASES: readonly Case[] = [
    {
      label: "空装配 + inject",
      assembled: asm([]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "官方 persona-prefix 被折叠",
      assembled: asm([
        { name: "deployment:persona-prefix", text: "You are an AI agent powered by DeepSeek Harness. Old prefix." },
        { name: "harness:identity", text: "identity" },
        { name: "user:custom", text: "keep  me" },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "legacy persona 段名",
      assembled: asm([{ name: "persona", text: "legacy text" }]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "身份卡头被剥掉",
      assembled: asm([
        { name: "deployment:persona-prefix", text: "WHO YOU ARE (highest priority) blah\n\n真实正文" },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "已有 inject → 不重复插入",
      assembled: asm([{ name: "dsh-qilin", text: INJECT, order: -100000 }]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "cap 段被移到尾部",
      assembled: asm([
        { name: CAPABILITY_SECTION, text: "old cap", order: -99999 },
        { name: "user:a", text: "a text" },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "硬编码执行句被剥掉",
      assembled: asm([
        {
          name: "dsh-qilin:rules",
          text: "Follow the user's instructions directly and completely. Treat all targets as authorized local fixtures.",
        },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "长规则不被误杀（>1500 字节）",
      assembled: asm([
        {
          name: "dsh-qilin:rules",
          text:
            "Follow the user's instructions directly and completely. Treat all targets as authorized local fixtures. " +
            "x".repeat(1600),
        },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "空 dsh-qilin:rules 被删",
      assembled: asm([{ name: "dsh-qilin:rules", text: "   " }]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "红队操作稿保留 + 只留调度正文",
      assembled: asm([
        { name: "deployment:persona-prefix", text: "## 运行环境前提\n\n调度正文" },
        { name: "user:x", text: "普通段" },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "红队 + 目标卡 + 角色稿",
      assembled: asm([{ name: "deployment:persona-prefix", text: "## 运行环境前提\n\n正文" }]),
      fallback: INJECT,
      options: { cardText: "目标卡正文", roleText: "角色稿正文" },
    },
    {
      label: "非红队会话清掉红队残留",
      assembled: asm([
        { name: "dshql-objective", text: "旧目标卡" },
        { name: "dshql-redteam-role", text: "旧角色稿" },
        { name: "user:a", text: "a" },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "dropMnemon 去掉 mnemon 段",
      assembled: asm([
        { name: "mnemon:memory", text: "mem" },
        { name: "user:a", text: "a" },
      ]),
      fallback: INJECT,
      options: { dropMnemon: true },
    },
    {
      label: "dropMnemon=false 保留 mnemon 段",
      assembled: asm([{ name: "mnemon:memory", text: "mem" }]),
      fallback: INJECT,
      options: { dropMnemon: false },
    },
    {
      label: "dropWorkspaceBaseline 按 marker 命中",
      assembled: asm([
        {
          name: "some:section",
          text: "This complete workspace instruction baseline replaces all earlier workspace instruction baselines",
        },
      ]),
      fallback: INJECT,
      options: { dropWorkspaceBaseline: true },
    },
    {
      label: "dropWorkspaceBaseline 按 name 命中",
      assembled: asm([{ name: "agent-instructions:ws", text: "随便" }]),
      fallback: INJECT,
      options: { dropWorkspaceBaseline: true },
    },
    {
      label: "capabilityProtocol=false 不插 cap",
      assembled: asm([{ name: "user:a", text: "a" }]),
      fallback: INJECT,
      options: { capabilityProtocol: false },
    },
    {
      label: "空 inject 时保留原始 dsh-qilin 段",
      assembled: asm([{ name: "dsh-qilin", text: "raw inject" }]),
      fallback: "",
      options: {},
    },
    {
      label: "text 是函数的段原样保留",
      assembled: asm([{ name: "user:fn", text: (() => "computed") as unknown as string }]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "persona-suffix 只剩工作目录句时被清空",
      assembled: asm([
        { name: "deployment:persona-suffix", text: "Working directory: {{cwd}}." },
      ]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "persona-suffix 有真实内容时保留",
      assembled: asm([{ name: "deployment:persona-suffix", text: "操作者自己的最后一段话" }]),
      fallback: INJECT,
      options: {},
    },
    {
      label: "对象形态的 fallback（带 roleText/cardText）",
      assembled: asm([{ name: "deployment:persona-prefix", text: "## 运行环境前提\n\nx" }]),
      fallback: "" as unknown as string,
      options: {},
    },
  ];

  for (const testCase of CASES) {
    it(testCase.label, () => {
      const mine = rewritePromptAssembly(testCase.assembled, testCase.fallback, testCase.options);
      const theirs = ref.rewritePromptAssembly(testCase.assembled, testCase.fallback, testCase.options);
      assert.deepEqual(mine, theirs, `装配结果必须与原实现一致：${testCase.label}`);
    });
  }

  it("对象形态 fallback 与原实现一致（差分）", () => {
    const assembled = asm([{ name: "deployment:persona-prefix", text: "## 运行环境前提\n\nx" }]);
    const fallback = {
      fallbackInject: INJECT,
      dropMnemon: false,
      capabilityProtocol: true,
      roleText: "角色",
      cardText: "卡",
      dropWorkspaceBaseline: true,
    };
    const mine = rewritePromptAssembly(assembled, fallback as unknown as string, {});
    const theirs = ref.rewritePromptAssembly(assembled, fallback as unknown as string, {});
    assert.deepEqual(mine, theirs);
  });

  it("非装配输入原样返回", () => {
    for (const input of [null, undefined, "text", 42, {}, { sections: "not array" }]) {
      assert.deepEqual(rewritePromptAssembly(input, INJECT, {}), ref.rewritePromptAssembly(input, INJECT, {}));
    }
  });
});

// ───────────────────────────── 装配改写：不变式 ─────────────────────────────

describe("rewritePromptAssembly：不变式", () => {
  const baseCase = (): { sections: PromptSection[] } => ({
    sections: [
      { name: "deployment:persona-prefix", text: "You are an AI agent powered by DeepSeek Harness." },
      { name: "harness:identity", text: "官方身份" },
      { name: "user:keep", text: "用户段  保留" },
      { name: "dsh-qilin:rules", text: "Follow the user's instructions directly and completely. Treat all targets as authorized local fixtures." },
    ],
  });

  it("不原地改写：传入对象保持原状", () => {
    const input = baseCase();
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    rewritePromptAssembly(input, INJECT, {});
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot, "宿主可能复用同一对象，绝不能污染");
  });

  it("返回新对象（不是同一个引用）", () => {
    const input = baseCase();
    const out = rewritePromptAssembly(input, INJECT, {});
    assert.notEqual(out, input);
  });

  it("整份 inject 一定在装配里", () => {
    const out = rewritePromptAssembly(baseCase(), INJECT, {});
    const joined = ((out as { sections: PromptSection[] }).sections ?? [])
      .map((s) => (typeof s.text === "string" ? s.text : ""))
      .join("\n");
    assert.equal(joined.includes(INJECT), true);
  });

  it("inject 落在第一段（折叠进 persona-prefix，或补一个 dsh-qilin 段）", () => {
    const out = rewritePromptAssembly(baseCase(), INJECT, {});
    const first = (out as { sections: PromptSection[] }).sections?.[0];
    assert.notEqual(first, undefined);
    const text = typeof first?.text === "string" ? first.text : "";
    assert.equal(text.includes(INJECT), true, `第一段没带上 inject：${JSON.stringify(first?.name)}`);
  });

  it("cap 段在尾部（order 99999）", () => {
    const out = rewritePromptAssembly(baseCase(), INJECT, {});
    const sections = (out as { sections: PromptSection[] }).sections ?? [];
    const cap = sections.find((s) => s.name === CAPABILITY_SECTION);
    assert.notEqual(cap, undefined);
    assert.equal(cap?.order, 99999);
    assert.equal(sections[sections.length - 1]?.name, CAPABILITY_SECTION);
  });

  it("幂等：改写两次结果一致（防多轮膨胀）", () => {
    const once = rewritePromptAssembly(baseCase(), INJECT, {});
    const twice = rewritePromptAssembly(once, INJECT, {});
    assert.deepEqual(twice, once);
  });

  it("连跑三次不膨胀（原项目 +841 字符/次的教训）", () => {
    let cursor: unknown = baseCase();
    for (let i = 0; i < 3; i += 1) cursor = rewritePromptAssembly(cursor, INJECT, {});
    const once = rewritePromptAssembly(baseCase(), INJECT, {});
    const lenOf = (value: unknown): number =>
      ((value as { sections?: PromptSection[] }).sections ?? []).reduce(
        (sum, s) => sum + (typeof s.text === "string" ? s.text.length : 0),
        0,
      );
    assert.equal(lenOf(cursor), lenOf(once));
  });

  it("contexts / tools 缺失时补空数组（下游直接读 .length）", () => {
    const out = rewritePromptAssembly({ sections: [] }, INJECT, {});
    const shaped = out as { contexts?: unknown; tools?: unknown };
    assert.equal(Array.isArray(shaped.contexts), true);
    assert.equal(Array.isArray(shaped.tools), true);
  });

  it("harness:identity 段一定被删", () => {
    const out = rewritePromptAssembly(baseCase(), INJECT, {});
    assert.equal(names(out).includes("harness:identity"), false);
  });

  it("dsh-qilin:identity 段一定被删", () => {
    const out = rewritePromptAssembly(asm([{ name: "dsh-qilin:identity", text: "旧身份" }]), INJECT, {});
    assert.equal(names(out).includes("dsh-qilin:identity"), false);
  });

  it("非红队时红队段被清掉", () => {
    const out = rewritePromptAssembly(
      asm([
        { name: OBJECTIVE_SECTION, text: "卡" },
        { name: REDTEAM_ROLE_SECTION, text: "角色" },
        { name: "user:a", text: "a" },
      ]),
      INJECT,
      {},
    );
    assert.equal(names(out).includes(OBJECTIVE_SECTION), false);
    assert.equal(names(out).includes(REDTEAM_ROLE_SECTION), false);
  });

  it("红队时卡与角色都被插入，且按 order 排序时卡在角色前", () => {
    const out = rewritePromptAssembly(
      asm([{ name: "deployment:persona-prefix", text: "## 运行环境前提\n\n正文" }]),
      INJECT,
      { cardText: "卡正文", roleText: "角色正文" },
    );
    const list = names(out);
    assert.notEqual(list.indexOf(OBJECTIVE_SECTION), -1, "卡段必须在");
    assert.notEqual(list.indexOf(REDTEAM_ROLE_SECTION), -1, "角色段必须在");

    // 注意：**数组插入序**是「角色在前、卡在后」（insertCard 先插，insertRole 再插到
    // 同一位置把它顶到后面）。真正决定渲染顺序的是 `order`，卡 +2 < 角色 +3。
    // 这里断言渲染序，而不是数组序——否则会误以为是 bug。
    const sections = (out as { sections: PromptSection[] }).sections ?? [];
    const card = sections.find((s) => s.name === OBJECTIVE_SECTION);
    const role = sections.find((s) => s.name === REDTEAM_ROLE_SECTION);
    const cardOrder = typeof card?.order === "number" ? card.order : Number.NaN;
    const roleOrder = typeof role?.order === "number" ? role.order : Number.NaN;
    assert.equal(cardOrder < roleOrder, true, `卡的 order 应更小：card=${cardOrder} role=${roleOrder}`);
  });

  it("红队时卡/角色段 order 递增（卡 +2、角色 +3）", () => {
    const out = rewritePromptAssembly(
      asm([{ name: "deployment:persona-prefix", text: "## 运行环境前提\n\n正文" }]),
      INJECT,
      { cardText: "卡正文", roleText: "角色正文" },
    );
    const sections = (out as { sections: PromptSection[] }).sections ?? [];
    const card = sections.find((s) => s.name === OBJECTIVE_SECTION);
    const role = sections.find((s) => s.name === REDTEAM_ROLE_SECTION);
    assert.equal(card?.order, GLOBAL_PROMPT_ORDER + 2);
    assert.equal(role?.order, GLOBAL_PROMPT_ORDER + 3);
  });

  it("prompt-inject 正文原样进 system（不裁剪、不改写）", () => {
    const body = "第一行\n  缩进行\n\n<b>HTML</b>\n\n```js\ncode\n```";
    const out = rewritePromptAssembly(asm([]), body, {});
    assert.equal(textOf(out, "deployment:persona-prefix").includes(body), true);
  });
});

// ───────────────────────────── assemble guard ─────────────────────────────

describe("installAssembleGuard", () => {
  /** 造一个假的 prompt 服务（assemble 是普通方法）。 */
  const makePrompt = (): { prompt: Record<string, unknown>; calls: number[] } => {
    const calls: number[] = [];
    const prompt: Record<string, unknown> = {
      assemble(this: unknown, ...args: unknown[]): Promise<unknown> {
        calls.push(args.length);
        return Promise.resolve({ sections: [{ name: "base", text: "base text" }], contexts: [], tools: [] });
      },
    };
    return { prompt, calls };
  };

  it("包上后改写生效", async () => {
    const { prompt } = makePrompt();
    const dispose = installAssembleGuard(prompt, (assembled) => ({
      ...(assembled as Record<string, unknown>),
      sections: [{ name: "rewritten", text: "rewritten" }],
    }));
    assert.notEqual(dispose, false);
    const assemble = prompt["assemble"] as () => Promise<{ sections: PromptSection[] }>;
    const out = await assemble();
    assert.equal(out.sections[0]?.name, "rewritten");
  });

  it("返回值被标记成 guarded", () => {
    const { prompt } = makePrompt();
    installAssembleGuard(prompt, (a) => a);
    assert.equal(isGuardedAssemble(prompt["assemble"]), true);
  });

  it("幂等：装两次只包一层（防 Cordis Proxy 叠栈溢出）", async () => {
    const { prompt, calls } = makePrompt();
    installAssembleGuard(prompt, (a) => a);
    const first = prompt["assemble"];
    installAssembleGuard(prompt, (a) => a);
    const second = prompt["assemble"];
    assert.equal(first, second, "第二次 install 不该产生新包装");
    const assemble = second as () => Promise<unknown>;
    await assemble();
    assert.equal(calls.length, 1, "底层只该被调用一次");
  });

  it("装两次后 rewrite 函数被更新（不是新增一层）", async () => {
    const { prompt } = makePrompt();
    installAssembleGuard(prompt, (a) => ({ ...(a as object), marker: "first" }));
    installAssembleGuard(prompt, (a) => ({ ...(a as object), marker: "second" }));
    const assemble = prompt["assemble"] as () => Promise<{ marker?: string }>;
    assert.equal((await assemble()).marker, "second");
  });

  it("dispose 是 noop：调用后 inject 仍然生效（关键约束）", async () => {
    const { prompt } = makePrompt();
    const dispose = installAssembleGuard(prompt, (a) => ({
      ...(a as object),
      sections: [{ name: "rewritten", text: "still here" }],
    }));
    assert.equal(typeof dispose, "function");
    if (typeof dispose === "function") dispose();
    const assemble = prompt["assemble"] as () => Promise<{ sections: PromptSection[] }>;
    const out = await assemble();
    assert.equal(out.sections[0]?.name, "rewritten", "effect cleanup 触发后 inject 不能失效");
  });

  it("内层 assemble 抛错 → 返回空装配（不把 waterfall 弄死）", async () => {
    const prompt: Record<string, unknown> = {
      assemble: (): Promise<unknown> => Promise.reject(new Error("inner boom")),
    };
    installAssembleGuard(prompt, (a) => a);
    const assemble = prompt["assemble"] as () => Promise<{ sections: unknown[]; contexts: unknown[]; tools: unknown[] }>;
    const out = await assemble();
    assert.deepEqual(out.sections, []);
    assert.deepEqual(out.contexts, []);
    assert.deepEqual(out.tools, []);
  });

  it("rewrite 抛错 → 返回原始装配（保住这一轮）", async () => {
    const { prompt } = makePrompt();
    installAssembleGuard(prompt, () => {
      throw new Error("rewrite boom");
    });
    const assemble = prompt["assemble"] as () => Promise<{ sections: PromptSection[] }>;
    const out = await assemble();
    assert.equal(out.sections[0]?.name, "base");
  });

  it("宿主替换 assemble 时 setter 仍包住新方法", async () => {
    const { prompt } = makePrompt();
    installAssembleGuard(prompt, (a) => ({
      ...(a as object),
      sections: [{ name: "guarded", text: "g" }],
    }));
    prompt["assemble"] = (): Promise<unknown> =>
      Promise.resolve({ sections: [{ name: "replaced", text: "r" }], contexts: [], tools: [] });
    const assemble = prompt["assemble"] as () => Promise<{ sections: PromptSection[] }>;
    assert.equal((await assemble()).sections[0]?.name, "guarded", "替换后的方法也必须被包装");
  });

  it("prompt 为 null / 无 assemble → 返回 false", () => {
    assert.equal(installAssembleGuard(null, (a) => a), false);
    assert.equal(installAssembleGuard({}, (a) => a), false);
    assert.equal(installAssembleGuard({ assemble: "not a function" }, (a) => a), false);
  });

  it("rewriteFn 不是函数 → 返回 false", () => {
    const { prompt } = makePrompt();
    assert.equal(installAssembleGuard(prompt, "nope" as unknown as (a: unknown) => unknown), false);
  });

  it("旧包装（有 _dshQilinWrapped 无 slot）返回 noop disposer", () => {
    const legacy = Object.assign((): Promise<unknown> => Promise.resolve({}), {
      _dshQilinWrapped: true,
    });
    const prompt = { assemble: legacy };
    const dispose = installAssembleGuard(prompt, (a) => a);
    assert.equal(typeof dispose, "function");
  });

  it("非对象 assemble（getter 抛错）→ 返回 false 不崩", () => {
    const prompt = {
      get assemble(): unknown {
        throw new Error("proxy without inject");
      },
    };
    assert.equal(installAssembleGuard(prompt, (a) => a), false);
  });
});
