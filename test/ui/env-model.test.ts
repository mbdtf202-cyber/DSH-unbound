/**
 * 环境适配表单模型测试。
 *
 * 核心是**字段映射的完整性**：漏一个字段的后果是「保存后配置消失」，
 * 而界面上完全看不出来。所以这里对 `payloadFromDraft` 做逐字段断言，
 * 并用「往返」测试锁住 `draft → payload → draft` 不丢信息。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGN_EMPTY_DIR_MESSAGE,
  DEFAULT_TOOLKIT_DIR,
  KNOWN_ENV_KEYS,
  PLATFORM_OPTIONS,
  assignDirOf,
  assignOutcomeOf,
  assignedMessage,
  defaultNucleiDir,
  displayProxy,
  draftFromResponse,
  egressOf,
  errorOf,
  failed,
  foundToolCount,
  payloadFromDraft,
  saveOutcomeOf,
  savedMessage,
  splitLines,
  summaryOf,
  toolsOf,
  withEnv,
  withField,
  withTool,
  type EnvDraft,
} from "../../src/redteam/client/env-model.js";

/** 造一份完整草稿。 */
function draft(overrides: Partial<EnvDraft> = {}): EnvDraft {
  return {
    platform: "auto",
    toolkitDir: "/opt/toolkit",
    nucleiTemplatesDir: "/opt/toolkit/nuclei-templates",
    binDirsText: "/usr/local/bin\n/opt/bin",
    tools: { nmap: "/usr/bin/nmap", nuclei: "/opt/nuclei" },
    env: { FOFA_KEY: "abc", REDTEAM_VPS_HOST: "", REDTEAM_VPS_KEY: "" },
    notes: "备注",
    ...overrides,
  };
}

describe("KNOWN_ENV_KEYS / PLATFORM_OPTIONS", () => {
  it("预置三个环境变量键（即使没保存过也要出现输入框）", () => {
    assert.deepEqual(KNOWN_ENV_KEYS, ["FOFA_KEY", "REDTEAM_VPS_HOST", "REDTEAM_VPS_KEY"]);
  });

  it("平台有 auto / windows / linux 三项", () => {
    assert.deepEqual(PLATFORM_OPTIONS.map((option) => option.value), ["auto", "windows", "linux"]);
  });
});

describe("splitLines", () => {
  it("按 LF 拆分", () => {
    assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  });

  it("**按 CRLF 拆分（Windows 粘贴）**", () => {
    assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
  });

  it("去掉每行首尾空白", () => {
    assert.deepEqual(splitLines("  a  \n\tb\t"), ["a", "b"]);
  });

  it("去掉空行", () => {
    assert.deepEqual(splitLines("a\n\n\nb"), ["a", "b"]);
  });

  it("**CRLF 不留尾随 \\r**（不 trim 会让 existsSync 全失败）", () => {
    const result = splitLines("/opt/a\r\n/opt/b\r\n");
    assert.equal(result[0], "/opt/a");
    assert.equal(result[0]?.endsWith("\r"), false);
  });

  it("全空白给空数组", () => {
    assert.deepEqual(splitLines("   \n\n  "), []);
  });

  it("null / undefined 给空数组", () => {
    assert.deepEqual(splitLines(null), []);
    assert.deepEqual(splitLines(undefined), []);
  });
});

describe("draftFromResponse — 响应 → 表单", () => {
  it("读全部字段", () => {
    const result = draftFromResponse({
      config: {
        platform: "windows",
        toolkitDir: "/t",
        nucleiTemplatesDir: "/n",
        binDirs: ["/a", "/b"],
        tools: { nmap: "/usr/bin/nmap" },
        env: { FOFA_KEY: "k" },
        notes: "n",
      },
    });
    assert.equal(result.platform, "windows");
    assert.equal(result.toolkitDir, "/t");
    assert.equal(result.nucleiTemplatesDir, "/n");
    assert.equal(result.binDirsText, "/a\n/b");
    assert.deepEqual(result.tools, { nmap: "/usr/bin/nmap" });
    assert.equal(result.notes, "n");
  });

  it("**预置已知环境变量键**（配置里没有也给空串）", () => {
    const result = draftFromResponse({ config: {} });
    for (const key of KNOWN_ENV_KEYS) {
      assert.equal(result.env[key], "", `${key} 应有空串占位`);
    }
  });

  it("配置里的环境变量覆盖空串占位", () => {
    const result = draftFromResponse({ config: { env: { FOFA_KEY: "secret" } } });
    assert.equal(result.env["FOFA_KEY"], "secret");
  });

  it("配置里的未知环境变量键也保留", () => {
    const result = draftFromResponse({ config: { env: { CUSTOM: "x" } } });
    assert.equal(result.env["CUSTOM"], "x");
  });

  it("缺 config 时全用默认值", () => {
    const result = draftFromResponse({});
    assert.equal(result.platform, "auto");
    assert.equal(result.toolkitDir, "");
    assert.equal(result.binDirsText, "");
    assert.deepEqual(result.tools, {});
    assert.equal(result.notes, "");
  });

  it("响应是 null / 非对象时不抛", () => {
    assert.doesNotThrow(() => draftFromResponse(null));
    assert.doesNotThrow(() => draftFromResponse("x"));
    assert.doesNotThrow(() => draftFromResponse([]));
  });

  it("**非法 platform 归一为 auto**", () => {
    assert.equal(draftFromResponse({ config: { platform: "solaris" } }).platform, "auto");
    assert.equal(draftFromResponse({ config: { platform: 42 } }).platform, "auto");
  });

  it("**binDirs 里的非字符串项被过滤**（配置被手改坏）", () => {
    const result = draftFromResponse({ config: { binDirs: ["/a", 42, null, "/b"] } });
    assert.equal(result.binDirsText, "/a\n/b");
  });

  it("tools 里的非字符串值被丢弃", () => {
    const result = draftFromResponse({ config: { tools: { a: "/x", b: 42, c: null } } });
    assert.deepEqual(result.tools, { a: "/x" });
  });

  it("binDirs 不是数组时给空串", () => {
    assert.equal(draftFromResponse({ config: { binDirs: "notarray" } }).binDirsText, "");
  });
});

describe("payloadFromDraft — 表单 → 请求（逐字段完整性）", () => {
  it("**每个字段都进载荷**（漏一个 = 保存后配置消失）", () => {
    const payload = payloadFromDraft(draft());
    assert.equal(payload.platform, "auto");
    assert.equal(payload.toolkitDir, "/opt/toolkit");
    assert.equal(payload.nucleiTemplatesDir, "/opt/toolkit/nuclei-templates");
    assert.deepEqual(payload.binDirs, ["/usr/local/bin", "/opt/bin"]);
    assert.deepEqual(payload.tools, { nmap: "/usr/bin/nmap", nuclei: "/opt/nuclei" });
    assert.deepEqual(payload.env, { FOFA_KEY: "abc", REDTEAM_VPS_HOST: "", REDTEAM_VPS_KEY: "" });
    assert.equal(payload.notes, "备注");
  });

  it("**强制 envAdaptConfigured=true**（点保存 = 配好了）", () => {
    assert.equal(payloadFromDraft(draft()).envAdaptConfigured, true);
  });

  it("**强制 envAdaptSkip=false**（清掉「暂不配置」标记）", () => {
    assert.equal(payloadFromDraft(draft()).envAdaptSkip, false);
  });

  it("binDirsText 转成数组", () => {
    assert.deepEqual(payloadFromDraft(draft({ binDirsText: "/a\n/b\n" })).binDirs, ["/a", "/b"]);
  });

  it("空 binDirsText → 空数组", () => {
    assert.deepEqual(payloadFromDraft(draft({ binDirsText: "" })).binDirs, []);
  });
});

describe("往返：draft → payload → draft 不丢信息", () => {
  it("**环境变量一个不丢**", () => {
    const original = draft({ env: { FOFA_KEY: "k1", REDTEAM_VPS_HOST: "h", REDTEAM_VPS_KEY: "k2", EXTRA: "e" } });
    const payload = payloadFromDraft(original);
    const restored = draftFromResponse({ config: payload });
    for (const [key, value] of Object.entries(original.env)) {
      assert.equal(restored.env[key], value, `${key} 在往返中丢失`);
    }
  });

  it("**工具路径一个不丢**", () => {
    const original = draft({ tools: { nmap: "/a", nuclei: "/b", fscan: "/c" } });
    const restored = draftFromResponse({ config: payloadFromDraft(original) });
    assert.deepEqual(restored.tools, original.tools);
  });

  it("**binDirs 顺序保持**", () => {
    const original = draft({ binDirsText: "/z\n/a\n/m" });
    const restored = draftFromResponse({ config: payloadFromDraft(original) });
    assert.equal(restored.binDirsText, "/z\n/a\n/m");
  });

  it("platform / 目录 / notes 保持", () => {
    const original = draft();
    const restored = draftFromResponse({ config: payloadFromDraft(original) });
    assert.equal(restored.platform, original.platform);
    assert.equal(restored.toolkitDir, original.toolkitDir);
    assert.equal(restored.nucleiTemplatesDir, original.nucleiTemplatesDir);
    assert.equal(restored.notes, original.notes);
  });
});

describe("草稿更新助手（不可变）", () => {
  it("withTool 改一个工具", () => {
    const next = withTool(draft(), "fscan", "/opt/fscan");
    assert.equal(next.tools["fscan"], "/opt/fscan");
    assert.equal(next.tools["nmap"], "/usr/bin/nmap", "其它工具不受影响");
  });

  it("withTool 不修改原草稿", () => {
    const original = draft();
    withTool(original, "x", "/x");
    assert.equal(original.tools["x"], undefined);
  });

  it("withEnv 改一个变量", () => {
    const next = withEnv(draft(), "FOFA_KEY", "new");
    assert.equal(next.env["FOFA_KEY"], "new");
  });

  it("withEnv 不修改原草稿", () => {
    const original = draft();
    withEnv(original, "FOFA_KEY", "new");
    assert.equal(original.env["FOFA_KEY"], "abc");
  });

  it("withField 改顶层字段", () => {
    assert.equal(withField(draft(), "notes", "新备注").notes, "新备注");
  });

  it("withField 不修改原草稿", () => {
    const original = draft();
    withField(original, "notes", "新");
    assert.equal(original.notes, "备注");
  });
});

describe("toolsOf / foundToolCount", () => {
  it("读出工具清单", () => {
    const tools = toolsOf({
      tools: { items: [{ id: "nmap", label: "Nmap", path: "/usr/bin/nmap", source: "path" }] },
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.id, "nmap");
    assert.equal(tools[0]?.path, "/usr/bin/nmap");
  });

  it("path 为 null 表示未找到", () => {
    const tools = toolsOf({ tools: { items: [{ id: "x", path: null, source: "missing" }] } });
    assert.equal(tools[0]?.path, null);
  });

  it("label 缺失时回退 id", () => {
    assert.equal(toolsOf({ tools: { items: [{ id: "nmap" }] } })[0]?.label, "nmap");
  });

  it("缺 items 给空数组", () => {
    assert.deepEqual(toolsOf({}), []);
    assert.deepEqual(toolsOf({ tools: {} }), []);
  });

  it("**id 缺失的项被过滤**（无法渲染的项留着只会出空白行）", () => {
    const tools = toolsOf({ tools: { items: [{ label: "无 id" }, { id: "ok" }] } });
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.id, "ok");
  });

  it("foundToolCount 只数有 path 的", () => {
    const tools = toolsOf({
      tools: { items: [{ id: "a", path: "/a" }, { id: "b", path: null }, { id: "c", path: "/c" }] },
    });
    assert.equal(foundToolCount(tools), 2);
  });

  it("空清单给 0", () => {
    assert.equal(foundToolCount([]), 0);
  });
});

describe("summaryOf", () => {
  it("Windows 平台标签", () => {
    assert.equal(summaryOf({ runtime: { effective: "windows" } }).platformLabel, "Windows");
  });

  it("非 Windows 一律 Linux/Kali", () => {
    assert.equal(summaryOf({ runtime: { effective: "linux" } }).platformLabel, "Linux/Kali");
    assert.equal(summaryOf({}).platformLabel, "Linux/Kali");
  });

  it("就绪时标签含 reason", () => {
    const summary = summaryOf({ adapt: { ready: true, reason: "configured" } });
    assert.equal(summary.ready, true);
    assert.equal(summary.readyLabel, "就绪 · configured");
  });

  it("未就绪时标签是「待配置」", () => {
    assert.equal(summaryOf({ adapt: { ready: false } }).readyLabel, "待配置");
  });

  it("**ready 必须是布尔 true**（字符串 'true' 不算）", () => {
    assert.equal(summaryOf({ adapt: { ready: "true" } }).ready, false);
  });

  it("kali 标记", () => {
    assert.equal(summaryOf({ adapt: { kali: true } }).kali, true);
    assert.equal(summaryOf({ adapt: {} }).kali, false);
  });

  it("工具计数标签", () => {
    const summary = summaryOf({
      tools: { items: [{ id: "a", path: "/a" }, { id: "b", path: null }] },
    });
    assert.equal(summary.toolLabel, "工具 1/2");
    assert.equal(summary.toolCount, 1);
    assert.equal(summary.totalTools, 2);
  });

  it("空响应不抛，计数是 0/0", () => {
    const summary = summaryOf(null);
    assert.equal(summary.toolLabel, "工具 0/0");
  });
});

describe("egressOf / displayProxy", () => {
  it("读出四项代理", () => {
    const state = egressOf({
      egress: { http_proxy: "http://p:8080", https_proxy: "h", all_proxy: "a", no_proxy: "n", note: "只读" },
    });
    assert.equal(state.httpProxy, "http://p:8080");
    assert.equal(state.noProxy, "n");
    assert.equal(state.note, "只读");
  });

  it("缺字段给空串", () => {
    assert.equal(egressOf({}).httpProxy, "");
    assert.equal(egressOf(null).note, "");
  });

  it("**空值显示 '(空)'**（与原实现一致，不显示空白）", () => {
    assert.equal(displayProxy(""), "(空)");
  });

  it("非空值原样显示", () => {
    assert.equal(displayProxy("http://p:8080"), "http://p:8080");
  });
});

describe("defaultNucleiDir", () => {
  it("用响应里的 toolkitDir 拼", () => {
    assert.equal(defaultNucleiDir({ toolkitDir: "/t" }), "/t/nuclei-templates");
  });

  it("响应没给时用默认 toolkit 路径", () => {
    assert.equal(defaultNucleiDir({}), DEFAULT_TOOLKIT_DIR + "/nuclei-templates");
  });

  it("响应直接给 nucleiTemplatesDir 时优先", () => {
    assert.equal(
      defaultNucleiDir({ toolkitDir: "/t", nucleiTemplatesDir: "/custom/n" }),
      "/custom/n",
    );
  });
});

describe("提示文案", () => {
  it("savedMessage 用响应里的 path", () => {
    assert.equal(savedMessage({ config: { path: "/x/config.json" } }), "已保存到 /x/config.json");
  });

  it("savedMessage 无 path 时用默认提示", () => {
    assert.match(savedMessage({}), /\$DSH_HOME\/redteam\/config\.json/);
  });

  it("assignedMessage 报数量", () => {
    assert.equal(assignedMessage({ assignedCount: 5 }), "已从文件夹分配 5 个工具");
  });

  it("assignedMessage 识别到 nuclei-templates 时补一句", () => {
    assert.match(assignedMessage({ assignedCount: 3, nucleiTemplatesDir: "/n" }), /nuclei-templates/);
  });

  it("**assignedCount 缺失或非数字时按 0**（不显示 NaN）", () => {
    assert.equal(assignedMessage({}), "已从文件夹分配 0 个工具");
    assert.equal(assignedMessage({ assignedCount: "abc" }), "已从文件夹分配 0 个工具");
    assert.doesNotMatch(assignedMessage({ assignedCount: Number.NaN }), /NaN/);
  });

  it("nucleiTemplatesDir 是空串时不算识别到", () => {
    assert.doesNotMatch(assignedMessage({ assignedCount: 1, nucleiTemplatesDir: "" }), /nuclei-templates/);
  });
});

describe("失败判定与错误文案", () => {
  it("null / undefined 算失败", () => {
    assert.equal(failed(null), true);
    assert.equal(failed(undefined), true);
  });

  it("{ok:false} 算失败", () => {
    assert.equal(failed({ ok: false }), true);
  });

  it("{ok:true} 不算失败", () => {
    assert.equal(failed({ ok: true }), false);
  });

  it("无 ok 字段不算失败（裸业务体）", () => {
    assert.equal(failed({ config: {} }), false);
  });

  it("errorOf 用响应里的 error", () => {
    assert.deepEqual(errorOf({ error: "读不到配置" }, "兜底"), { kind: "err", text: "读不到配置" });
  });

  it("errorOf 在 error 为空时用兜底", () => {
    assert.deepEqual(errorOf({}, "保存失败"), { kind: "err", text: "保存失败" });
    assert.deepEqual(errorOf({ error: "" }, "兜底"), { kind: "err", text: "兜底" });
  });
});

describe("saveOutcomeOf / assignOutcomeOf", () => {
  it("保存成功带回响应与提示", () => {
    const outcome = saveOutcomeOf({ ok: true, config: { path: "/c.json" } });
    assert.equal(outcome.message.kind, "ok");
    assert.notEqual(outcome.response, null);
  });

  it("保存失败不带响应", () => {
    const outcome = saveOutcomeOf({ ok: false, error: "磁盘满" });
    assert.equal(outcome.message.kind, "err");
    assert.equal(outcome.response, null);
    assert.equal(outcome.message.text, "磁盘满");
  });

  it("分配成功提示数量", () => {
    const outcome = assignOutcomeOf({ ok: true, assignedCount: 4 });
    assert.match(outcome.message.text, /4 个工具/);
  });

  it("分配失败用兜底文案", () => {
    assert.equal(assignOutcomeOf({ ok: false }).message.text, "自动分配失败");
  });
});

describe("assignDirOf", () => {
  it("优先用输入框的值（去空白）", () => {
    assert.equal(assignDirOf("  /opt/tools  ", draft()), "/opt/tools");
  });

  it("输入框为空时回退到草稿的 toolkitDir", () => {
    assert.equal(assignDirOf("", draft({ toolkitDir: "/from/draft" })), "/from/draft");
  });

  it("两者都空时给空串", () => {
    assert.equal(assignDirOf("", null), "");
    assert.equal(assignDirOf("", draft({ toolkitDir: "" })), "");
  });

  it("非字符串输入按空处理", () => {
    assert.equal(assignDirOf(42, draft({ toolkitDir: "/d" })), "/d");
  });

  it("空目录的错误文案与原实现一致", () => {
    assert.equal(ASSIGN_EMPTY_DIR_MESSAGE, "请先填写工具所在文件夹路径");
  });
});
