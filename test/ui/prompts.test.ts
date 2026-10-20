/**
 * 智能体提示词页的模型 + 渲染测试。
 *
 * 重点是**条件分支**：
 * - `catalog === null` / 加载失败 / 内置默认 / 正常
 * - `active` 指向一个已消失的角色（标题必须回退，不能崩）
 * - 无靶标时保存/恢复被拦下（不发请求）且给出可执行提示
 * - 三个按钮的禁用条件各不相同（「全部恢复」不依赖 active）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  applySavedDraft,
  draftOfLoad,
  promptErrorMessage,
  loadPrompts,
  resetPrompts,
  renderPromptsTab,
  savePrompt,
  type PromptsTabProps,
} from "../../src/redteam/client/prompts-tab.js";
import {
  BUILTIN_NOTICE,
  DRAFT_PLACEHOLDER,
  EMPTY_PROMPTS_MESSAGE,
  PROMPT_SAVED_MESSAGE,
  activeRoleOf,
  canResetAll,
  canResetCurrent,
  canSave,
  draftFor,
  previewOf,
  promptCatalogOf,
  promptFileName,
  promptHint,
  promptItemClass,
  promptItemLabel,
  promptLoadOf,
  promptRoleOf,
  promptFor,
  promptHeading,
  resetBlockedMessage,
  resetOutcomeOf,
  saveBlockedMessage,
  saveOutcomeOf,
  shouldSyncDraft,
  updatedLabel,
  withLocalContent,
  type PromptLoad,
  type PromptRole,
} from "../../src/redteam/client/prompts-model.js";
import type { ApiResponse } from "../../src/redteam/client/api.js";
import type { ReactLike, ModuleRequire } from "../../src/redteam/client/dom.js";

/** 造运行时。 */
function makeRuntime(): ConsoleRuntime {
  const react = makeTestReact();
  const requireModule: ModuleRequire = () => react as unknown as ReactLike;
  return createRuntime(requireModule, {
    innerWidth: 1280,
    innerHeight: 800,
    location: { hash: "", href: "http://h/", hostname: "h", port: "1", reload: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    document: {
      createElement: () => { throw new Error("unused"); },
      head: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      body: { append: () => undefined, appendChild: () => undefined, removeChild: () => undefined },
      execCommand: () => false,
    },
    open: () => null,
    close: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Parameters<typeof createRuntime>[1]);
}

/** 造一个角色。 */
function role(overrides: Partial<PromptRole> = {}): PromptRole {
  return {
    role: "recon",
    title: "信息收集",
    content: "## 目标\n收集资产",
    updatedAt: "2026-01-02T03:04:05Z",
    ...overrides,
  };
}

/** 造读取结果。 */
function load(overrides: Partial<PromptLoad> = {}): PromptLoad {
  const roles = overrides.roles ?? [role()];
  return {
    ok: true,
    roles,
    builtin: false,
    error: null,
    ...overrides,
  };
}

/** 默认 props。 */
function props(overrides: Partial<PromptsTabProps> = {}): PromptsTabProps {
  return {
    catalog: load(),
    active: "recon",
    draft: "## 目标\n收集资产",
    message: null,
    busy: false,
    onRefresh: () => undefined,
    onSelect: () => undefined,
    onDraftChange: () => undefined,
    onSave: () => undefined,
    onReset: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<PromptsTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderPromptsTab(runtime, props(overrides))) };
}

/** 造一个记录调用的 api 替身。 */
function fakeApi(responses: readonly ApiResponse[]): {
  readonly requests: Record<string, unknown>[];
  readonly api: { raw: (request: Record<string, unknown>) => Promise<ApiResponse> };
} {
  const requests: Record<string, unknown>[] = [];
  let index = 0;
  return {
    requests,
    api: {
      raw: async (request) => {
        requests.push(request);
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        return response ?? { ok: true };
      },
    },
  };
}

describe("prompts-model — 角色解析", () => {
  it("解析完整字段", () => {
    const parsed = promptRoleOf({
      role: "recon",
      title: "信息收集",
      content: "正文",
      updated_at: "2026-01-01T00:00:00Z",
    });
    assert.deepEqual(parsed, {
      role: "recon",
      title: "信息收集",
      content: "正文",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("title 缺失时回退成 role（否则界面渲染出 undefined）", () => {
    assert.equal(promptRoleOf({ role: "recon" })?.title, "recon");
  });

  it("**role 为空的行被丢弃**（它是 key、选中判定与文件名主干）", () => {
    assert.equal(promptRoleOf({ role: "", title: "空" }), null);
    assert.equal(promptRoleOf({ title: "没有 role" }), null);
  });

  it("非对象输入不抛", () => {
    assert.equal(promptRoleOf(null), null);
    assert.equal(promptRoleOf("recon"), null);
    assert.equal(promptRoleOf([1, 2]), null);
  });

  it("兼容 updatedAt 的驼峰写法", () => {
    assert.equal(promptRoleOf({ role: "r", updatedAt: "X" })?.updatedAt, "X");
  });

  it("解析目录并识别内置标记", () => {
    const catalog = promptCatalogOf({ roles: [{ role: "a" }, { role: "b" }], builtin: true });
    assert.equal(catalog.roles.length, 2);
    assert.equal(catalog.builtin, true);
  });

  it("roles 不是数组时给空表", () => {
    assert.deepEqual(promptCatalogOf({ roles: "nope" }).roles, []);
  });

  it("失败响应给出错误文案", () => {
    const parsed = promptLoadOf({ ok: false, error: "磁盘错误" });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "磁盘错误");
    assert.deepEqual(parsed.roles, []);
  });

  it("失败响应缺 error 时用兜底文案", () => {
    assert.equal(promptLoadOf({ ok: false }).error, "读取失败");
  });

  it("null 响应按失败处理", () => {
    assert.equal(promptLoadOf(null).ok, false);
  });

  it("成功响应带内置默认标记", () => {
    const parsed = promptLoadOf({ ok: true, roles: [{ role: "a" }], builtin: true });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.builtin, true);
    assert.equal(parsed.error, null);
  });
});

describe("prompts-model — 选中与草稿", () => {
  it("没有选中时自动选第一个", () => {
    assert.equal(activeRoleOf([role({ role: "a" }), role({ role: "b" })], null), "a");
  });

  it("**已有选中时不改动**（哪怕它在列表里已不存在）", () => {
    assert.equal(activeRoleOf([role({ role: "a" })], "gone"), "gone");
  });

  it("空列表 + 无选中 → null", () => {
    assert.equal(activeRoleOf([], null), null);
  });

  it("空串选中视同「没有选中」", () => {
    assert.equal(activeRoleOf([role({ role: "a" })], ""), "a");
  });

  it("promptFor 找得到 / 找不到", () => {
    const roles = [role({ role: "a" })];
    assert.equal(promptFor(roles, "a")?.role, "a");
    assert.equal(promptFor(roles, "zzz"), null);
    assert.equal(promptFor(roles, null), null);
  });

  it("draftFor 取正文，找不到给空串", () => {
    const roles = [role({ role: "a", content: "正文" })];
    assert.equal(draftFor(roles, "a"), "正文");
    assert.equal(draftFor(roles, "zzz"), "");
  });

  it("shouldSyncDraft：不同才需要同步", () => {
    const roles = [role({ role: "a", content: "服务端" })];
    assert.equal(shouldSyncDraft("a", roles, "本地"), true);
    assert.equal(shouldSyncDraft("a", roles, "服务端"), false);
  });

  it("shouldSyncDraft：没有选中时不同步", () => {
    assert.equal(shouldSyncDraft(null, [role()], "本地"), false);
  });

  it("previewOf 剥掉 Markdown 记号再截断", () => {
    assert.equal(previewOf(role({ content: "## 标题 **粗**" })), " 标题 粗");
  });

  it("**previewOf 截断到 60 字符**", () => {
    const long = "a".repeat(200);
    assert.equal(previewOf(role({ content: long })).length, 60);
  });

  it("空正文 → （空）", () => {
    assert.equal(previewOf(role({ content: "" })), "（空）");
  });

  it("只有 Markdown 记号 → （空）", () => {
    assert.equal(previewOf(role({ content: "###" })), "（空）");
  });

  it("null 角色 → （空）", () => {
    assert.equal(previewOf(null), "（空）");
  });

  it("promptHeading：有角色给标题", () => {
    assert.equal(promptHeading([role({ title: "信息收集" })], "recon"), "信息收集");
  });

  it("**promptHeading：角色消失时回退成「提示词」**（不能崩）", () => {
    assert.equal(promptHeading([role({ role: "a" })], "gone"), "提示词");
  });

  it("updatedLabel 拼接更新时间", () => {
    assert.match(updatedLabel([role({ updatedAt: "2026-01-02T03:04:05Z" })], "recon"), /^更新 2026-01-02 03:04$/);
  });

  it("**updatedLabel：0 值时间戳显示 —**（formatTimestamp 的真值语义）", () => {
    assert.equal(updatedLabel([role({ updatedAt: "" })], "recon"), "更新 —");
  });

  it("promptItemClass 选中加 on", () => {
    assert.equal(promptItemClass(role(), "recon"), "rt-item on");
    assert.equal(promptItemClass(role(), "other"), "rt-item");
  });

  it("promptItemLabel 拼出 aria-label", () => {
    assert.equal(promptItemLabel(role({ title: "信息收集" })), "查看「信息收集」提示词");
  });
});

describe("prompts-model — 按钮可用性与消息", () => {
  it("canSave：需有 active 且不忙", () => {
    assert.equal(canSave(false, "recon"), true);
    assert.equal(canSave(true, "recon"), false);
    assert.equal(canSave(false, null), false);
    assert.equal(canSave(false, ""), false);
  });

  it("canResetCurrent 与 canSave 同条件", () => {
    assert.equal(canResetCurrent(false, "recon"), true);
    assert.equal(canResetCurrent(false, null), false);
  });

  it("**canResetAll 不看 active**（角色表还没读回来时也要能兜底）", () => {
    assert.equal(canResetAll(false), true);
    assert.equal(canResetAll(true), false);
  });

  it("无靶标时保存被拦下并给出可执行提示", () => {
    assert.equal(saveBlockedMessage(null), "请先创建靶标，再保存提示词");
    assert.equal(saveBlockedMessage(""), "请先创建靶标，再保存提示词");
    assert.equal(saveBlockedMessage("eng-1"), null);
  });

  it("无靶标时恢复被拦下", () => {
    assert.equal(resetBlockedMessage(null), "请先创建靶标，再恢复默认提示词");
    assert.equal(resetBlockedMessage("eng-1"), null);
  });

  it("保存成功给「已保存」", () => {
    assert.deepEqual(saveOutcomeOf({ ok: true }), { kind: "ok", text: PROMPT_SAVED_MESSAGE });
  });

  it("保存失败透传服务端文案", () => {
    assert.deepEqual(saveOutcomeOf({ ok: false, error: "只读文件系统" }), { kind: "err", text: "只读文件系统" });
  });

  it("保存失败缺 error 时用兜底文案", () => {
    assert.deepEqual(saveOutcomeOf({ ok: false }), { kind: "err", text: "保存失败" });
  });

  it("恢复默认把 reset 数组拼进文案", () => {
    const message = resetOutcomeOf({ ok: true, reset: ["recon", "assess"] });
    assert.equal(message.kind, "ok");
    assert.equal(message.text, "已恢复内置默认：recon、assess");
  });

  it("恢复默认的 reset 缺失时文案仍成立", () => {
    assert.equal(resetOutcomeOf({ ok: true }).text, "已恢复内置默认：");
  });

  it("恢复默认的 reset 里有非字符串项时过滤掉", () => {
    assert.equal(resetOutcomeOf({ ok: true, reset: ["a", 1, null, "b"] }).text, "已恢复内置默认：a、b");
  });

  it("恢复失败给错误", () => {
    assert.deepEqual(resetOutcomeOf({ ok: false, error: "权限不足" }), { kind: "err", text: "权限不足" });
  });

  it("promptFileName 用 active 作文件名", () => {
    assert.equal(promptFileName("recon"), "agents/recon.md");
  });

  it("**promptFileName：没有 active 时用 role 兜底**", () => {
    assert.equal(promptFileName(null), "agents/role.md");
    assert.equal(promptFileName(""), "agents/role.md");
  });

  it("promptHint 说明落盘位置与加载机制", () => {
    const hint = promptHint("recon");
    assert.match(hint, /agents\/recon\.md/);
    assert.match(hint, /redteamRole/);
  });

  it("withLocalContent 只改命中的那一行", () => {
    const roles = [role({ role: "a", content: "旧" }), role({ role: "b", content: "别动" })];
    const next = withLocalContent(roles, "a", "新", "2026-02-02T00:00:00Z");
    assert.equal(next[0]?.content, "新");
    assert.equal(next[0]?.updatedAt, "2026-02-02T00:00:00Z");
    assert.equal(next[1]?.content, "别动");
  });

  it("withLocalContent 不改原数组", () => {
    const roles = [role({ role: "a", content: "旧" })];
    withLocalContent(roles, "a", "新", "X");
    assert.equal(roles[0]?.content, "旧");
  });
});

describe("prompts-tab — 流程", () => {
  it("有靶标时 prompts 请求带 engagement", async () => {
    const { api, requests } = fakeApi([{ ok: true, roles: [] }]);
    await loadPrompts(api as never, "eng-1");
    assert.equal(requests[0]?.["engagement"], "eng-1");
    assert.equal(requests[0]?.["op"], "prompts");
  });

  it("**无靶标时不发 engagement 字段**（服务端回内置默认）", async () => {
    const { api, requests } = fakeApi([{ ok: true, roles: [] }]);
    await loadPrompts(api as never, null);
    assert.equal(Object.hasOwn(requests[0] ?? {}, "engagement"), false);
  });

  it("保存：有靶标才发请求", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    const result = await savePrompt(api as never, "eng-1", "recon", "正文");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.["op"], "savePrompt");
    assert.equal(requests[0]?.["content"], "正文");
    assert.equal(result.message.kind, "ok");
  });

  it("**保存：无靶标时不发请求，直接给提示**", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    const result = await savePrompt(api as never, null, "recon", "正文");
    assert.equal(requests.length, 0);
    assert.equal(result.message.kind, "err");
    assert.match(result.message.text, /请先创建靶标/);
  });

  it("保存：没有选中角色时给错误", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    const result = await savePrompt(api as never, "eng-1", null, "正文");
    assert.equal(requests.length, 0);
    assert.equal(result.message.kind, "err");
  });

  it("恢复当前角色时带 role", async () => {
    const { api, requests } = fakeApi([{ ok: true, reset: ["recon"] }]);
    await resetPrompts(api as never, "eng-1", "recon", false);
    assert.equal(requests[0]?.["role"], "recon");
  });

  it("**全部恢复时不带 role 字段**", async () => {
    const { api, requests } = fakeApi([{ ok: true, reset: [] }]);
    await resetPrompts(api as never, "eng-1", "recon", true);
    assert.equal(Object.hasOwn(requests[0] ?? {}, "role"), false);
  });

  it("无靶标时恢复不发请求", async () => {
    const { api, requests } = fakeApi([{ ok: true }]);
    await resetPrompts(api as never, null, "recon", false);
    assert.equal(requests.length, 0);
  });

  it("applySavedDraft 就地更新列表", () => {
    const updated = applySavedDraft(load(), "recon", "新正文", "2026-03-03T00:00:00Z");
    assert.equal(updated?.roles[0]?.content, "新正文");
  });

  it("applySavedDraft 对 null 保持 null", () => {
    assert.equal(applySavedDraft(null, "recon", "正文", "X"), null);
  });

  it("draftOfLoad 取草稿", () => {
    assert.equal(draftOfLoad(load(), "recon"), "## 目标\n收集资产");
    assert.equal(draftOfLoad(null, "recon"), "");
  });

  it("promptErrorMessage 归一各种异常", () => {
    assert.equal(promptErrorMessage("字符串"), "字符串");
    assert.equal(promptErrorMessage(new Error("错误")), "错误");
    assert.equal(promptErrorMessage(42), "读取失败");
  });
});

describe("renderPromptsTab — 列表与工具栏", () => {
  it("渲染角色列表", () => {
    const { result } = render({ catalog: load({ roles: [role(), role({ role: "assess", title: "资产梳理" })] }) });
    assert.match(result.text, /信息收集/);
    assert.match(result.text, /资产梳理/);
  });

  it("渲染角色正文预览", () => {
    assert.match(render().result.text, /收集资产/);
  });

  it("工具栏标题是当前角色标题", () => {
    const { result } = render();
    // 两个工具栏：左侧「角色」列表头 + 右侧主体工具栏，标题在后者。
    const toolbars = findAll(result, (element) => classOf(element) === "rt-toolbar");
    assert.equal(toolbars.length, 2);
    assert.ok(toolbars.some((element) => textOf(element).includes("信息收集")));
  });

  it("**当前角色消失时标题回退成「提示词」**", () => {
    const { result } = render({ active: "gone" });
    assert.match(result.text, /提示词/);
  });

  it("工具栏显示更新时间", () => {
    assert.match(render().result.text, /更新 2026-01-02 03:04/);
  });

  it("角色数为 0 时显示计数 0 个", () => {
    assert.match(render({ catalog: load({ roles: [] }) }).result.text, /0 个/);
  });
});

describe("renderPromptsTab — 空态与错误态", () => {
  it("**catalog 为 null 时列表区显示空态**（不整页空白）", () => {
    const { result } = render({ catalog: null });
    assert.ok(result.text.includes(EMPTY_PROMPTS_MESSAGE));
  });

  it("catalog 为 null 时工具栏仍渲染（界面结构稳定）", () => {
    const { result } = render({ catalog: null });
    assert.match(result.text, /保存/);
    assert.match(result.text, /恢复默认为当前/);
  });

  it("角色列表为空时显示空态", () => {
    assert.ok(render({ catalog: load({ roles: [] }) }).result.text.includes(EMPTY_PROMPTS_MESSAGE));
  });

  it("加载失败显示 rt-err", () => {
    const { result } = render({ catalog: { ok: false, roles: [], builtin: false, error: "磁盘错误" } });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
    assert.match(result.text, /磁盘错误/);
  });

  it("**内置默认时的提示是 rt-foot 而不是 rt-err**（不是故障）", () => {
    const { result } = render({ catalog: load({ builtin: true }) });
    assert.match(result.text, /当前为内置默认提示词/);
    const node = findOne(result, (element) => classOf(element) === "rt-foot" && textOf(element) === BUILTIN_NOTICE);
    assert.notEqual(node, null);
  });

  it("非内置时不显示内置提示", () => {
    assert.doesNotMatch(render().result.text, /当前为内置默认提示词/);
  });

  it("保存成功的消息渲染成 rt-foot", () => {
    const { result } = render({ message: { kind: "ok", text: PROMPT_SAVED_MESSAGE } });
    const node = findOne(result, (element) => classOf(element) === "rt-foot" && textOf(element) === PROMPT_SAVED_MESSAGE);
    assert.notEqual(node, null);
  });

  it("保存失败的消息渲染成 rt-err", () => {
    const { result } = render({ message: { kind: "err", text: "保存失败" } });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
  });
});

describe("renderPromptsTab — 交互", () => {
  it("点击角色触发 onSelect", () => {
    const selected: string[] = [];
    const { result } = render({
      catalog: load({ roles: [role(), role({ role: "assess", title: "资产梳理" })] }),
      onSelect: (value) => selected.push(value),
    });
    const item = findAll(result, (element) => classOf(element).startsWith("rt-item"))
      .find((element) => textOf(element).includes("资产梳理"));
    fire(item!, "onClick");
    assert.deepEqual(selected, ["assess"]);
  });

  it("键盘 Enter 也能选角色", () => {
    const selected: string[] = [];
    const { result } = render({ onSelect: (value) => selected.push(value) });
    const item = findOne(result, (element) => classOf(element).startsWith("rt-item"));
    fire(item!, "onKeyDown", { key: "Enter" });
    assert.deepEqual(selected, ["recon"]);
  });

  it("点保存触发 onSave", () => {
    let count = 0;
    const { result } = render({ onSave: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "保存");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("busy 时保存按钮文案变「保存中…」且禁用", () => {
    const { result } = render({ busy: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("保存中"));
    assert.equal(button?.props["disabled"], true);
  });

  it("「恢复默认为当前」传 all=false", () => {
    const calls: boolean[] = [];
    const { result } = render({ onReset: (all) => calls.push(all) });
    const button = findAll(result, "button").find((element) => textOf(element) === "恢复默认为当前");
    fire(button!, "onClick");
    assert.deepEqual(calls, [false]);
  });

  it("「全部恢复默认」传 all=true", () => {
    const calls: boolean[] = [];
    const { result } = render({ onReset: (all) => calls.push(all) });
    const button = findAll(result, "button").find((element) => textOf(element) === "全部恢复默认");
    fire(button!, "onClick");
    assert.deepEqual(calls, [true]);
  });

  it("**没有选中角色时「恢复默认为当前」禁用，但「全部恢复默认」仍可点**", () => {
    const { result } = render({ active: null });
    const current = findAll(result, "button").find((element) => textOf(element) === "恢复默认为当前");
    const all = findAll(result, "button").find((element) => textOf(element) === "全部恢复默认");
    assert.equal(current?.props["disabled"], true);
    assert.equal(all?.props["disabled"], false);
  });

  it("恢复按钮的 title 说明作用范围", () => {
    const { result } = render();
    const current = findAll(result, "button").find((element) => textOf(element) === "恢复默认为当前");
    const all = findAll(result, "button").find((element) => textOf(element) === "全部恢复默认");
    assert.match(String(current?.props["title"]), /当前角色/);
    assert.match(String(all?.props["title"]), /四个角色/);
  });

  it("编辑正文触发 onDraftChange", () => {
    const changes: string[] = [];
    const { result } = render({ onDraftChange: (value) => changes.push(value) });
    const textarea = findOne(result, "textarea");
    fire(textarea!, "onChange", { target: { value: "新内容" } });
    assert.deepEqual(changes, ["新内容"]);
  });

  it("编辑框预填当前草稿", () => {
    assert.equal(findOne(render({ draft: "已有正文" }).result, "textarea")?.props["value"], "已有正文");
  });

  it("编辑框有占位提示", () => {
    assert.equal(findOne(render().result, "textarea")?.props["placeholder"], DRAFT_PLACEHOLDER);
  });

  it("点刷新触发 onRefresh", () => {
    let count = 0;
    const { result } = render({ onRefresh: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("**busy 时刷新入口仍存在**（不会整块消失）", () => {
    const { result } = render({ busy: true });
    assert.equal(findAll(result, "button").some((element) => textOf(element).includes("读取中")), true);
  });

  it("落盘说明跟着当前角色变", () => {
    assert.match(render({ active: "recon" }).result.text, /agents\/recon\.md/);
  });

  it("没有选中角色时落盘说明用 role 兜底", () => {
    assert.match(render({ active: null }).result.text, /agents\/role\.md/);
  });
});
