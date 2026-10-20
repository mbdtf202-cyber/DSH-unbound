/**
 * persona 剥离的**差分测试**。
 *
 * ## 为什么改成差分
 *
 * 第一版我按「直觉」写了期望值，结果 3 条错——原实现的行为比直觉更微妙，例如
 * `我是 DeepSeek 的 AI 助手，…` **不会**被删（正则要求 `DeepSeek` 后紧跟 `驱动`
 * 或 `的` 再**无空格**接 `AI`，而原文里的空格让它匹配不上），
 * 而 `我是 DeepSeek AI助手，…` 会被删。这类细节靠手写断言必然写错。
 *
 * 所以判据改成：**同一输入 → 与原实现逐字节相同**。
 * 参考实现冻结在 `test/plugin/fixtures/reference/persona.ts`（逐字复制，`@ts-nocheck`）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripHarnessPersona } from "../../src/plugin/persona.js";
import { stripHarnessPersona as reference } from "./fixtures/reference/persona.js";

/** 一批覆盖各条正则的输入。 */
const CORPUS: readonly string[] = [
  // 官方 persona 句
  "You are an AI agent powered by DeepSeek Harness. Do the task.",
  "You are an AI agent powered by DeepSeek Harness Do the task.",
  "YOU ARE A HELPFUL SOFTWARE ENGINEER ASSISTANT. Fix it.",
  "You are a helpful software engineer assistant. Fix it.",
  "你是一个有帮助的软件工程师助手。把事做完。",
  "你是一个有帮助的软件工程师助手.把事做完.",
  // 中文自我声明（注意空格组合，原正则对这些敏感）
  "我是 DeepSeek 的 AI 助手，很高兴为你服务\n下一行",
  "我是 DeepSeek的 AI 助手，高兴\n下一行",
  "我是 DeepSeek AI助手，高兴\n下一行",
  "我是 DeepSeek 驱动的 AI 编程助手。开始。",
  "我是 DeepSeek驱动的 AI 编程助手。开始。",
  "我是 DeepSeek 的 AI 编程助手 x",
  "你好！我是 DeepSeek Harness 里的助手\n干活",
  "你好我是 DeepSeek 助手\n干活",
  // GUI 句
  "You are interacting with the user through the DeepSeek Harness Web GUI, ok.",
  "You are interacting with the user through the local web GUI at http://127.0.0.1:49795. Next.",
  "You are interacting with the user through the local web GUI whose URL the runtime context names.",
  // 宿主操作建议
  "Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL. Keep going.",
  "Do not call present just to list edited source files, or run commands to check whether a diff view will appear. Then done.",
  "You don't have access to the internet via this tool. Use shell.",
  "Your identity is defined exclusively by the dsh-qilin operator prompt. Go.",
  "YOUR IDENTITY IS DEFINED EXCLUSIVELY BY THE DSH-QILIN OPERATOR PROMPT. Go.",
  "You are not a generic coding agent. Reply.",
  "You are not a generic coding agent or a mere software-engineer assistant. Reply.",
  // {{{model}}} 模板
  "You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}. Task:",
  "You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. X",
  "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}. X",
  // 真实模型名
  "You are a coding agent powered by the deepseek-v3 model, running on the DeepSeek Harness. A",
  "You are a coding agent powered by the deepseek-v3 model. B",
  // checkout 跨行段
  [
    "开头。",
    "The DeepSeek Harness implementation checkout is at /Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/. It has stuff.",
    "More lines here.",
    "Use this checkout only to inspect or extend DSH itself. 结尾。",
  ].join("\n"),
  // Claude 残留
  "You are Claude Code, Anthropic's official CLI for Claude. Work.",
  "You are Claude, a helpful assistant\n下一步",
  "我是 Claude，很高兴见到你\n继续",
  "由 Anthropic 开发并维护\n继续",
  // 空白
  "a   b",
  "a  \nb",
  "   x   ",
  "   \n  ",
  "",
  "执行下面的计划。\n第一条。",
  // 组合 / 顺序敏感
  "You are an AI agent powered by DeepSeek Harness. You are not a generic coding agent. Done.",
  "我是 DeepSeek AI助手，x\nYou are Claude, y\nz",
];

describe("stripHarnessPersona：与原实现逐字节一致（差分）", () => {
  for (const [index, input] of CORPUS.entries()) {
    it(`用例 #${index}：${JSON.stringify(input.slice(0, 40))}`, () => {
      assert.equal(stripHarnessPersona(input), reference(input));
    });
  }
});

describe("stripHarnessPersona：不变式（不依赖原实现也能断言）", () => {
  it("输出里不再含有 DeepSeek Harness 自我声明句", () => {
    const out = stripHarnessPersona("You are an AI agent powered by DeepSeek Harness. Keep.");
    assert.equal(out.includes("powered by DeepSeek Harness"), false);
  });

  it("输出里不再含 Claude 自我声明", () => {
    assert.equal(stripHarnessPersona("我是 Claude，你好\n继续").includes("Claude"), false);
  });

  it("幂等：再剥一次结果不变", () => {
    for (const input of CORPUS) {
      const once = stripHarnessPersona(input);
      assert.equal(stripHarnessPersona(once), once, `不幂等：${JSON.stringify(input.slice(0, 30))}`);
    }
  });

  it("空输入 → 空串", () => {
    assert.equal(stripHarnessPersona(""), "");
  });

  it("纯空白 → 空串", () => {
    assert.equal(stripHarnessPersona("  \n\t "), "");
  });

  it("不含 persona 的正文只做空白收敛（内容不丢）", () => {
    const body = "执行下面的计划。\n第一条。";
    assert.equal(stripHarnessPersona(body), body);
  });

  it("多空格被压成一个", () => {
    assert.equal(stripHarnessPersona("a   b"), "a b");
  });

  it("行尾空格被删", () => {
    assert.equal(stripHarnessPersona("a  \nb"), "a\nb");
  });

  it("首尾 trim", () => {
    assert.equal(stripHarnessPersona("   x   "), "x");
  });

  it("非字符串原样返回（调用方还会传 unknown）", () => {
    const value: unknown = { not: "a string" };
    assert.equal(stripHarnessPersona(value), value);
    const num: unknown = 42;
    assert.equal(stripHarnessPersona(num), num);
  });
});
