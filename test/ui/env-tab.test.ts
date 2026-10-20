/**
 * 环境适配页渲染测试。
 *
 * 渲染层只做排版，但有几处**分支**必须验证：
 * - `draft === null`（未加载）时输入框与保存按钮禁用
 * - `busy` 时按钮文案变化
 * - 目录为空时**提前**提示（不等点击）
 * - 失败消息与成功消息用不同样式类
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  assignEnv,
  envKeysOf,
  loadEnv,
  refreshDraftFrom,
  renderEnvTab,
  saveEnv,
  type EnvTabProps,
} from "../../src/redteam/client/env-tab.js";
import { draftFromResponse, payloadFromDraft, type EnvDraft } from "../../src/redteam/client/env-model.js";
import type { ApiClient, ApiResponse } from "../../src/redteam/client/api.js";
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

/** 一份草稿。 */
function draft(overrides: Partial<EnvDraft> = {}): EnvDraft {
  return draftFromResponse({
    config: {
      platform: "linux",
      toolkitDir: "/t",
      nucleiTemplatesDir: "/t/n",
      binDirs: ["/a"],
      tools: { nmap: "/usr/bin/nmap" },
      env: { FOFA_KEY: "k" },
      notes: "备",
      ...overrides as Record<string, unknown>,
    },
  });
}

/** 默认 props。 */
function props(overrides: Partial<EnvTabProps> = {}): EnvTabProps {
  return {
    draft: draft(),
    data: {
      ok: true,
      runtime: { effective: "linux" },
      adapt: { ready: true, reason: "configured", kali: false, message: "" },
      tools: { items: [{ id: "nmap", label: "Nmap", path: "/usr/bin/nmap", source: "path" }] },
      egress: { http_proxy: "", https_proxy: "", all_proxy: "", no_proxy: "", note: "只读" },
      hint: "",
      toolkitDir: "/t",
      nucleiTemplatesDir: "/t/n",
    },
    error: null,
    message: null,
    busy: false,
    folderPath: "",
    onRefresh: () => undefined,
    onSave: () => undefined,
    onAssign: () => undefined,
    onFolderPathChange: () => undefined,
    onDraftChange: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<EnvTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderEnvTab(runtime, props(overrides))) };
}

describe("renderEnvTab — 工具栏", () => {
  it("渲染标题「环境适配」", () => {
    assert.match(render().result.text, /环境适配/);
  });

  it("显示平台标签", () => {
    assert.match(render().result.text, /Linux\/Kali/);
  });

  it("Windows 平台标签", () => {
    const result = render({ data: { ok: true, runtime: { effective: "windows" } } }).result;
    assert.match(result.text, /Windows/);
  });

  it("Kali 标记只在 adapt.kali 时出现", () => {
    // 平台标签本身就是「Linux/Kali」，所以不能用 /Kali/ 判定。
    // 改为数「独立的 Kali 标签」：kali=true 时应比 false 时多一个。
    const withoutKali = render({ data: { ok: true, adapt: { kali: false } } }).result.text;
    const withKali = render({ data: { ok: true, adapt: { kali: true } } }).result.text;
    const count = (text: string): number => text.split("Kali").length - 1;
    assert.equal(count(withKali), count(withoutKali) + 1, "kali=true 应多一个 Kali 标签");
  });

  it("就绪时显示「就绪 · reason」", () => {
    assert.match(render().result.text, /就绪 · configured/);
  });

  it("未就绪时显示「待配置」", () => {
    const result = render({ data: { ok: true, adapt: { ready: false } } }).result;
    assert.match(result.text, /待配置/);
  });

  it("显示工具计数", () => {
    assert.match(render().result.text, /工具 1\/1/);
  });

  it("busy 时刷新按钮文案变成「读取中…」", () => {
    assert.match(render({ busy: true }).result.text, /读取中/);
  });

  it("busy 时刷新与保存按钮禁用", () => {
    const { result } = render({ busy: true });
    const buttons = findAll(result, "button");
    const refresh = buttons.find((button) => textOf(button).includes("读取中"));
    const save = buttons.find((button) => textOf(button) === "保存");
    assert.equal(refresh?.props["disabled"], true);
    assert.equal(save?.props["disabled"], true);
  });

  it("点击刷新触发 onRefresh", () => {
    let refreshed = 0;
    const { result } = render({ onRefresh: () => { refreshed += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(refreshed, 1);
  });

  it("点击保存触发 onSave", () => {
    let saved = 0;
    const { result } = render({ onSave: () => { saved += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "保存");
    fire(button!, "onClick");
    assert.equal(saved, 1);
  });
});

describe("renderEnvTab — draft 为 null（未加载）", () => {
  it("保存按钮禁用（防写入空配置覆盖原配置）", () => {
    const { result } = render({ draft: null });
    const save = findAll(result, "button").find((element) => textOf(element) === "保存");
    assert.equal(save?.props["disabled"], true);
  });

  it("**受草稿驱动的输入框**全部禁用（自动分配路径框不受草稿约束）", () => {
    const { result } = render({ draft: null });
    // 自动分配路径框的值来自独立的 `folderPath`，不来自草稿，所以它不该被禁用。
    const all = [...findAll(result, "input"), ...findAll(result, "textarea")];
    const assignInput = all.find((element) =>
      String(element.props["placeholder"] ?? "").includes("pentest-tools"));
    assert.notEqual(assignInput, undefined, "应能找到自动分配路径框");
    assert.notEqual(assignInput?.props["disabled"], true, "自动分配路径框应可用");

    const draftInputs = all.filter((element) => element !== assignInput);
    assert.ok(draftInputs.length > 0, "应该还有受草稿驱动的输入框");
    for (const input of draftInputs) {
      assert.equal(input.props["disabled"], true, `输入框 ${String(input.props["placeholder"] ?? "")} 应禁用`);
    }
  });

  it("平台下拉框禁用", () => {
    const { result } = render({ draft: null });
    assert.equal(findOne(result, "select")?.props["disabled"], true);
  });

  it("环境变量区域仍渲染已知键（保证界面结构稳定）", () => {
    const { result } = render({ draft: null });
    assert.match(result.text, /FOFA_KEY/);
  });

  it("不抛错", () => {
    assert.doesNotThrow(() => render({ draft: null }));
  });
});

describe("renderEnvTab — 消息", () => {
  it("错误消息用 rt-err 类", () => {
    const { result } = render({ error: "读取失败" });
    const errorNode = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(errorNode, null);
    assert.match(result.text, /读取失败/);
  });

  it("成功消息用 rt-foot 类", () => {
    const { result } = render({ message: { kind: "ok", text: "已保存" } });
    const foot = findOne(result, (element) => classOf(element) === "rt-foot");
    assert.notEqual(foot, null);
    assert.match(result.text, /已保存/);
  });

  it("失败消息用 rt-err 类", () => {
    const { result } = render({ message: { kind: "err", text: "保存失败" } });
    assert.match(String(findOne(result, (element) => classOf(element) === "rt-err")?.props["className"]), /rt-err/);
  });

  it("error 与 message 可同时显示", () => {
    const { result } = render({ error: "读错", message: { kind: "err", text: "存错" } });
    assert.match(result.text, /读错/);
    assert.match(result.text, /存错/);
  });

  it("无消息时不渲染空容器", () => {
    const { result } = render();
    assert.equal(findOne(result, (element) => classOf(element) === "rt-err"), null);
  });
});

describe("renderEnvTab — 自动分配卡片", () => {
  it("渲染说明文字", () => {
    assert.match(render().result.text, /整包文件夹/);
  });

  it("**目录为空时提前提示**（不等点击才报错）", () => {
    const { result } = render({ folderPath: "", draft: draft({ toolkitDir: "" }) });
    assert.match(result.text, /请先填写工具所在文件夹路径/);
  });

  it("目录非空时不显示提示", () => {
    const { result } = render({ folderPath: "/opt/tools" });
    assert.doesNotMatch(result.text, /请先填写工具所在文件夹路径/);
  });

  it("输入框变化触发 onFolderPathChange", () => {
    const changes: string[] = [];
    const { result } = render({ onFolderPathChange: (value) => changes.push(value) });
    const input = findAll(result, "input").find((element) =>
      String(element.props["placeholder"]).includes("pentest-tools"));
    fire(input!, "onChange", { target: { value: "/opt/x" } });
    assert.deepEqual(changes, ["/opt/x"]);
  });

  it("Enter 键触发自动分配", () => {
    let assigned = 0;
    const { result } = render({ folderPath: "/opt/x", onAssign: () => { assigned += 1; } });
    const input = findAll(result, "input").find((element) =>
      String(element.props["placeholder"]).includes("pentest-tools"));
    fire(input!, "onKeyDown", { key: "Enter" });
    assert.equal(assigned, 1);
  });

  it("busy 时自动分配按钮文案变成「扫描中…」", () => {
    assert.match(render({ busy: true }).result.text, /扫描中/);
  });
});

describe("renderEnvTab — 出网状态", () => {
  it("空代理显示 (空)", () => {
    assert.match(render().result.text, /HTTP_PROXY=\(空\)/);
  });

  it("有代理值时显示值", () => {
    const { result } = render({
      data: { ok: true, egress: { http_proxy: "http://p:8080" } },
    });
    assert.match(result.text, /HTTP_PROXY=http:\/\/p:8080/);
  });

  it("渲染四项代理", () => {
    const text = render().result.text;
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
      assert.ok(text.includes(name), `缺 ${name}`);
    }
  });

  it("note 非空时显示", () => {
    assert.match(render().result.text, /只读/);
  });
});

describe("renderEnvTab — 表单区域", () => {
  it("渲染平台下拉框，含三个选项", () => {
    const { result } = render();
    assert.equal(findAll(result, "option").length, 3);
  });

  it("平台下拉框预选当前值", () => {
    assert.equal(findOne(render().result, "select")?.props["value"], "linux");
  });

  it("改平台触发 onDraftChange", () => {
    const changes: EnvDraft[] = [];
    const { result } = render({ onDraftChange: (next) => changes.push(next) });
    fire(findOne(result, "select")!, "onChange", { target: { value: "windows" } });
    assert.equal(changes[0]?.platform, "windows");
  });

  it("**非法平台值归一为 auto**", () => {
    const changes: EnvDraft[] = [];
    const { result } = render({ onDraftChange: (next) => changes.push(next) });
    fire(findOne(result, "select")!, "onChange", { target: { value: "solaris" } });
    assert.equal(changes[0]?.platform, "auto");
  });

  it("渲染工具目录输入框并预填", () => {
    const { result } = render();
    const input = findAll(result, "input").find((element) => element.props["value"] === "/t");
    assert.notEqual(input, undefined);
  });

  it("渲染 bin 目录 textarea", () => {
    const { result } = render();
    const area = findAll(result, "textarea").find((element) => element.props["value"] === "/a");
    assert.notEqual(area, undefined);
  });

  it("渲染环境变量输入框（含已知键）", () => {
    const { result } = render();
    assert.match(result.text, /FOFA_KEY/);
    assert.match(result.text, /REDTEAM_VPS_HOST/);
  });

  it("渲染工具行与找到状态", () => {
    assert.match(render().result.text, /nmap/);
    assert.match(render().result.text, /已找到/);
  });

  it("工具清单为空时显示空态", () => {
    const { result } = render({ data: { ok: true, tools: { items: [] } } });
    assert.match(result.text, /暂无工具清单/);
  });

  it("未找到的工具显示「未找到」", () => {
    const { result } = render({
      data: { ok: true, tools: { items: [{ id: "fscan", path: null, source: "missing" }] } },
    });
    assert.match(result.text, /未找到/);
  });
});

describe("loadEnv / saveEnv / assignEnv —— 流程", () => {
  /** 假 api 客户端。 */
  function fakeApi(response: ApiResponse): ApiClient & { readonly calls: readonly Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const raw = async (request: { readonly op: string; readonly [key: string]: unknown }): Promise<ApiResponse> => {
      calls.push(request as unknown as Record<string, unknown>);
      return response;
    };
    return {
      calls,
      raw,
      snapshot: raw as never,
      assets: raw as never,
      asset: raw as never,
      vulns: raw as never,
      sessions: raw as never,
      chain: raw as never,
      scores: raw as never,
      report: raw as never,
      consoleDigest: raw as never,
      shotData: raw as never,
      activateEngagement: raw as never,
    } as unknown as ApiClient & { readonly calls: readonly Record<string, unknown>[] };
  }

  it("loadEnv 成功时回调响应", async () => {
    const api = fakeApi({ ok: true, config: { toolkitDir: "/t" } });
    let loaded: ApiResponse | null = null;
    await loadEnv(api, (response) => { loaded = response; }, () => undefined);
    assert.notEqual(loaded, null);
  });

  it("loadEnv 失败时回调错误，不调 onLoaded", async () => {
    const api = fakeApi({ ok: false, error: "磁盘错误" });
    let loaded: ApiResponse | null = null;
    let error: string | null = null;
    await loadEnv(api, (response) => { loaded = response; }, (message) => { error = message; });
    assert.equal(loaded, null);
    assert.equal(error, "磁盘错误");
  });

  it("loadEnv 发的是 platformConfigGet", async () => {
    const api = fakeApi({ ok: true });
    await loadEnv(api, () => undefined, () => undefined);
    assert.equal(api.calls[0]?.["op"], "platformConfigGet");
  });

  it("saveEnv 发的是 platformConfigSave 且带完整 config", async () => {
    const api = fakeApi({ ok: true, config: { path: "/c.json" } });
    await saveEnv(api, draft());
    const call = api.calls[0]!;
    assert.equal(call["op"], "platformConfigSave");
    const config = call["config"] as Record<string, unknown>;
    assert.equal(config["toolkitDir"], "/t");
    assert.equal(config["envAdaptConfigured"], true);
    assert.equal(config["envAdaptSkip"], false);
  });

  it("saveEnv 成功返回 ok:true 与响应", async () => {
    const api = fakeApi({ ok: true });
    const result = await saveEnv(api, draft());
    assert.equal(result.ok, true);
    assert.notEqual(result.response, null);
  });

  it("saveEnv 失败返回 ok:false 且无响应", async () => {
    const api = fakeApi({ ok: false, error: "x" });
    const result = await saveEnv(api, draft());
    assert.equal(result.ok, false);
    assert.equal(result.response, null);
  });

  it("**assignEnv 空目录不发请求**", async () => {
    const api = fakeApi({ ok: true });
    const result = await assignEnv(api, "", draft({ toolkitDir: "" }));
    assert.equal(result.ok, false);
    assert.equal(api.calls.length, 0, "不该发注定失败的请求");
    assert.match(String(result.error), /请先填写/);
  });

  it("assignEnv 有目录时发 platformAssignToolkit", async () => {
    const api = fakeApi({ ok: true, assignedCount: 3 });
    await assignEnv(api, "/opt/tools", draft());
    assert.equal(api.calls[0]?.["op"], "platformAssignToolkit");
    assert.equal(api.calls[0]?.["dir"], "/opt/tools");
  });

  it("assignEnv 失败时带回错误文案", async () => {
    const api = fakeApi({ ok: false, error: "无此目录" });
    const result = await assignEnv(api, "/nope", draft());
    assert.equal(result.ok, false);
    assert.equal(result.error, "无此目录");
  });
});

describe("refreshDraftFrom / envKeysOf", () => {
  it("成功响应可重建草稿", () => {
    const result = refreshDraftFrom({ ok: true, config: { toolkitDir: "/new" } });
    assert.equal(result?.toolkitDir, "/new");
  });

  it("失败响应给 null（不清空现有草稿）", () => {
    assert.equal(refreshDraftFrom({ ok: false, error: "x" }), null);
  });

  it("envKeysOf 用草稿的键（**含已知键**，因为 draftFromResponse 会预置它们）", () => {
    const keys = envKeysOf(draft({ env: { A: "1", B: "2" } }));
    // draftFromResponse 把 KNOWN_ENV_KEYS 预置进 env，所以草稿的键天然包含它们。
    assert.deepEqual([...keys].sort(), ["A", "B", "FOFA_KEY", "REDTEAM_VPS_HOST", "REDTEAM_VPS_KEY"]);
  });

  it("envKeysOf 在草稿为 null 时给已知键", () => {
    const keys = envKeysOf(null);
    assert.ok(keys.includes("FOFA_KEY"));
  });
});

describe("往返一致性（渲染层的保存路径）", () => {
  it("渲染 → 取草稿 → 转载荷，字段不丢", () => {
    const original = draft({ tools: { nmap: "/a", nuclei: "/b" } });
    const payload = payloadFromDraft(original);
    assert.deepEqual(payload.tools, { nmap: "/a", nuclei: "/b" });
    assert.equal(payload.toolkitDir, "/t");
  });
});
