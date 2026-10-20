/**
 * 会话隧道页测试（模型层 + 渲染层）。
 *
 * 重点锁住三件事：
 * 1. **三条提示的判定与顺序**（坏马 → 无 suo5 → 全部不算突破）
 * 2. **`legit` 三态**（`true` / `false` / `null` 各有不同文案，不能压成布尔）
 * 3. **空态四分支** + 复制失败必须如实报错
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  defaultSessionProps,
  renderSessionTab,
  type SessionTabProps,
} from "../../src/redteam/client/session-tab.js";
import {
  EMPTY_TITLE,
  EMPTY_TUNNELS_TEXT,
  NO_ENGAGEMENT_TEXT,
  PROBE_TIMEOUT_MS,
  copyMessage,
  fscanCommand,
  gogoCommand,
  isEncryptedShell,
  isSuo5,
  lastCheckText,
  legitClass,
  legitFactText,
  legitKindOf,
  legitLabel,
  legitTitle,
  loadSessions,
  markShell,
  markTunnel,
  probeRequest,
  probeSessions,
  probeSummaryOf,
  sessionDataOf,
  sessionHints,
  shellCopyCommand,
  shellTypeText,
  statusDotClass,
  updateTunnelRequest,
  updateWebshellRequest,
  type SessionData,
  type TunnelItem,
  type WebShellItem,
} from "../../src/redteam/client/session-model.js";
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
      createElement: () => {
        throw new Error("unused");
      },
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

/** 造一个 WebShell。 */
function shell(overrides: Partial<WebShellItem> = {}): WebShellItem {
  return {
    id: 1,
    url: "https://203.0.113.5:8443/shell.jsp",
    shellType: "godzilla",
    passKey: "pass123",
    secretRef: "runs/ws-1.txt",
    privilege: "root",
    status: "online",
    lastCheck: "2026-09-18T10:00:00Z",
    checkNote: "",
    latencyMs: 120,
    note: "",
    assetIp: "203.0.113.5",
    ...overrides,
  };
}

/** 造一条隧道。 */
function tunnel(overrides: Partial<TunnelItem> = {}): TunnelItem {
  return {
    id: 1,
    kind: "suo5",
    listen: "127.0.0.1:1080",
    entry: "https://203.0.113.5:8443/shell.jsp",
    reach: "10.0.0.0/8",
    entryKind: "target-http",
    entryKindLabel: "经目标 WebShell 的 HTTP 通道",
    status: "active",
    lastCheck: "2026-09-18T10:00:00Z",
    checkNote: "",
    latencyMs: 80,
    command: "suo5 -t https://x/shell.jsp -l 1080",
    note: "",
    assetIp: "203.0.113.5",
    legit: true,
    ...overrides,
  };
}

/** 造会话数据。 */
function data(overrides: {
  readonly shells?: readonly WebShellItem[];
  readonly tunnels?: readonly TunnelItem[];
  readonly totals?: Partial<SessionData["totals"]>;
} = {}): SessionData {
  const shells = overrides.shells ?? [shell()];
  const tunnels = overrides.tunnels ?? [tunnel()];
  return {
    shells,
    tunnels,
    totals: {
      webshells: shells.length,
      webshellsOnline: shells.filter((item) => item.status === "online").length,
      tunnels: tunnels.length,
      tunnelsActive: tunnels.filter((item) => item.status === "active").length,
      credentials: 4,
      access: 2,
      ...overrides.totals,
    },
  };
}

/** 默认 props。 */
function props(overrides: Partial<SessionTabProps> = {}): SessionTabProps {
  return { ...defaultSessionProps("eng-1"), data: data(), ...overrides };
}

/** 渲染。 */
function render(overrides: Partial<SessionTabProps> = {}): ReturnType<typeof renderToText> {
  const runtime = makeRuntime();
  return renderToText(renderSessionTab(runtime, props(overrides)));
}

/* ══════════════════════════════════════════════════════════════ 模型：加密马 */

describe("session-model — 加密马判定", () => {
  it("**识别冰蝎 / 哥斯拉 / behinder / godzilla（中英文）**", () => {
    for (const value of ["behinder", "godzilla", "冰蝎", "哥斯拉", "Behinder", "GODZILLA"]) {
      assert.equal(isEncryptedShell(value), true, value + " 应识别为加密马");
    }
  });

  it("一句话马 / 蚁剑 / 空串都不算加密马", () => {
    for (const value of ["one-liner", "antsword", "", "custom"]) {
      assert.equal(isEncryptedShell(value), false, value + " 不该算加密马");
    }
  });

  it("类型说明分两套（加密马可直连 / 非加密马连不上）", () => {
    assert.match(shellTypeText(shell({ shellType: "godzilla" })), /加密马（冰蝎\/哥斯拉，用户可直连）/);
    assert.match(shellTypeText(shell({ shellType: "one-liner" })), /用户连不上/);
  });

  it("复制命令是 `curl -s \"URL\"`", () => {
    assert.equal(shellCopyCommand(shell({ url: "https://x/s.jsp" })), 'curl -s "https://x/s.jsp"');
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：legit 三态 */

describe("session-model — legit 三态", () => {
  it("**true / false / null 必须是三个不同的值**（不能压成布尔）", () => {
    assert.equal(tunnel({ legit: true }).legit, true);
    assert.equal(tunnel({ legit: false }).legit, false);
    assert.equal(tunnel({ legit: null }).legit, null);
  });

  it("tunnelOf 把缺失的 legit 归一为 null（不是 false）", () => {
    const parsed = sessionDataOf({ tunnels: [{ id: 1 }] });
    assert.equal(parsed.tunnels[0]?.legit, null);
  });

  it("legitKindOf 三分支", () => {
    assert.equal(legitKindOf(tunnel({ legit: true })), "legit");
    assert.equal(legitKindOf(tunnel({ legit: false })), "self-only");
    assert.equal(legitKindOf(tunnel({ legit: null })), "unknown");
  });

  it("三种徽章文案各不相同", () => {
    assert.equal(legitLabel(tunnel({ legit: true })), "目标侧通道");
    assert.equal(legitLabel(tunnel({ legit: false })), "不算突破");
    assert.equal(legitLabel(tunnel({ legit: null })), "待确认");
  });

  it("三种徽章类名不同（live / warn / 默认）", () => {
    assert.equal(legitClass(tunnel({ legit: true })), "rt-tag rt-tag-live");
    assert.equal(legitClass(tunnel({ legit: false })), "rt-tag rt-tag-warn");
    assert.equal(legitClass(tunnel({ legit: null })), "rt-tag");
  });

  it("**self-only 的说明要点明「只在自己 VPS 上开」**", () => {
    assert.match(legitTitle(tunnel({ legit: false })), /只在自己 VPS\/自建服务器上开的通道/);
  });

  it("unknown 的说明要列出三个合法 entry_kind", () => {
    const title = legitTitle(tunnel({ legit: null }));
    for (const kind of ["target-outbound", "target-http", "target-agent"]) {
      assert.match(title, new RegExp(kind));
    }
  });

  it("详情行的文案三态（legit 优先用 entry_kind_label）", () => {
    assert.equal(legitFactText(tunnel({ legit: true, entryKindLabel: "目标反弹" })), "目标反弹");
    assert.match(legitFactText(tunnel({ legit: false })), /不算突破/);
    assert.match(legitFactText(tunnel({ legit: null })), /未声明 entry_kind/);
  });

  it("legit=true 但 label 缺失时回退 entry_kind，再到默认文案", () => {
    assert.equal(legitFactText(tunnel({ legit: true, entryKindLabel: "", entryKind: "target-http" })), "target-http");
    assert.equal(legitFactText(tunnel({ legit: true, entryKindLabel: "", entryKind: "" })), "已确认目标侧");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：suo5 */

describe("session-model — suo5 判定", () => {
  it("识别 suo5（大小写不敏感）", () => {
    assert.equal(isSuo5("suo5"), true);
    assert.equal(isSuo5("SUO5"), true);
    assert.equal(isSuo5("suo5-http"), true);
  });

  it("其它 kind 不算 suo5", () => {
    assert.equal(isSuo5("frp"), false);
    assert.equal(isSuo5("socks5"), false);
    assert.equal(isSuo5(""), false);
  });

  it("gogo 命令走 socks5 代理（逐字对齐原型）", () => {
    assert.equal(
      gogoCommand(tunnel({ listen: "127.0.0.1:1080" })),
      "./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy socks5://127.0.0.1:1080",
    );
  });

  it("fscan 命令带 -socks5 与输出文件", () => {
    assert.equal(
      fscanCommand(tunnel({ listen: "127.0.0.1:1080" })),
      "./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 127.0.0.1:1080 -o intranet.txt",
    );
  });

  it("**没有监听地址时命令是空串**（不生成 `--proxy socks5://` 这种坏命令）", () => {
    assert.equal(gogoCommand(tunnel({ listen: "" })), "");
    assert.equal(fscanCommand(tunnel({ listen: "" })), "");
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：提示 */

describe("session-model — 三条提示", () => {
  it("**坏马提示**：有非加密马时才出现，报条数", () => {
    const hints = sessionHints(data({ shells: [shell({ shellType: "one-liner" }), shell({ id: 2 })] }));
    const badShell = hints.find((hint) => hint.key === "h1");
    assert.notEqual(badShell, undefined);
    assert.match(badShell!.title, /有 1 个入口不是冰蝎马\/哥斯拉马/);
  });

  it("全是加密马时不出现坏马提示", () => {
    const hints = sessionHints(data({ shells: [shell({ shellType: "behinder" }), shell({ id: 2, shellType: "冰蝎" })] }));
    assert.equal(hints.find((hint) => hint.key === "h1"), undefined);
  });

  it("**全不算突破提示**：有隧道但一条 legit 都没有", () => {
    const hints = sessionHints(data({ tunnels: [tunnel({ legit: false }), tunnel({ id: 2, legit: null })] }));
    const hint = hints.find((item) => item.key === "h3");
    assert.notEqual(hint, undefined);
    assert.match(hint!.title, /现有 2 条通道都不算/);
  });

  it("有一条 legit 就不出现该提示", () => {
    const hints = sessionHints(data({ tunnels: [tunnel({ legit: false }), tunnel({ id: 2, legit: true })] }));
    assert.equal(hints.find((item) => item.key === "h3"), undefined);
  });

  it("没有隧道时也不出现该提示", () => {
    const hints = sessionHints(data({ tunnels: [] }));
    assert.equal(hints.find((item) => item.key === "h3"), undefined);
  });

  it("**无 suo5 提示**：有 WebShell 但没有 active 的 suo5", () => {
    const hints = sessionHints(data({ tunnels: [tunnel({ kind: "frp", status: "active" })] }));
    assert.notEqual(hints.find((item) => item.key === "h2"), undefined);
  });

  it("suo5 存在但状态不是 active 时仍提示", () => {
    const hints = sessionHints(data({ tunnels: [tunnel({ kind: "suo5", status: "down" })] }));
    assert.notEqual(hints.find((item) => item.key === "h2"), undefined);
  });

  it("有 active suo5 时不提示", () => {
    const hints = sessionHints(data({ tunnels: [tunnel({ kind: "suo5", status: "active" })] }));
    assert.equal(hints.find((item) => item.key === "h2"), undefined);
  });

  it("没有 WebShell 时不提示 suo5（先得有马）", () => {
    const hints = sessionHints(data({ shells: [], tunnels: [] }));
    assert.equal(hints.find((item) => item.key === "h2"), undefined);
  });

  it("**三条提示可以同时出现**（互不覆盖）", () => {
    const hints = sessionHints(data({
      shells: [shell({ shellType: "one-liner" })],
      tunnels: [tunnel({ kind: "frp", legit: false, status: "active" })],
    }));
    assert.deepEqual(hints.map((hint) => hint.key), ["h1", "h3", "h2"]);
  });

  it("提示顺序固定为 坏马 → 全不算突破 → 无 suo5", () => {
    const hints = sessionHints(data({
      shells: [shell({ shellType: "custom" })],
      tunnels: [tunnel({ kind: "frp", legit: false })],
    }));
    assert.deepEqual(hints.map((hint) => hint.key), ["h1", "h3", "h2"]);
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：状态与检测 */

describe("session-model — 状态点与检测", () => {
  it("**online/active 是绿点，unknown/空是灰点，其余是黑点**", () => {
    assert.equal(statusDotClass("online"), "rt-dot-on");
    assert.equal(statusDotClass("active"), "rt-dot-on");
    assert.equal(statusDotClass("unknown"), "rt-dot-unk");
    assert.equal(statusDotClass(""), "rt-dot-unk");
    assert.equal(statusDotClass("offline"), "rt-dot-off");
    assert.equal(statusDotClass("down"), "rt-dot-off");
  });

  it("lastCheckText：带延迟 / 不带延迟 / 未检测", () => {
    assert.equal(lastCheckText("T", 120, "2026-09-18 10:00"), "2026-09-18 10:00（120ms）");
    assert.equal(lastCheckText("T", null, "2026-09-18 10:00"), "2026-09-18 10:00");
    assert.equal(lastCheckText("", null, "—"), "未检测");
  });

  it("**延迟为 0 也要显示（不是假值跳过）**", () => {
    assert.equal(lastCheckText("T", 0, "t"), "t（0ms）");
  });

  it("probeSummaryOf 统计在线数与可用数", () => {
    const summary = probeSummaryOf({
      webshells: [{ status: "online" }, { status: "offline" }, { status: "online" }],
      tunnels: [{ status: "active" }, { status: "down" }],
    });
    assert.equal(summary.onlineShells, 2);
    assert.equal(summary.totalShells, 3);
    assert.equal(summary.activeTunnels, 1);
    assert.equal(summary.message, "检测完成：WebShell 在线 2/3，隧道可用 1/2");
  });

  it("PROBE_TIMEOUT_MS 是 6000，且进了请求体", () => {
    assert.equal(PROBE_TIMEOUT_MS, 6000);
    assert.equal(probeRequest("eng-1")["timeoutMs"], 6000);
  });

  it("标记请求带 check_note（留下「界面手动标记」痕迹）", () => {
    const request = updateTunnelRequest("eng-1", 3, "down");
    assert.equal(request["id"], 3);
    assert.deepEqual(request["patch"], { status: "down", check_note: "界面手动标记" });
  });

  it("WebShell 标记请求同口径", () => {
    const request = updateWebshellRequest("eng-1", 4, "offline");
    assert.equal(request["op"], "updateWebshell");
    assert.deepEqual(request["patch"], { status: "offline", check_note: "界面手动标记" });
  });
});

/* ══════════════════════════════════════════════════════════════ 模型：复制文案 */

describe("session-model — 复制文案", () => {
  it("**失败必须如实说失败**（不能假装「已复制」）", () => {
    const text = copyMessage(false, "127.0.0.1:1080");
    assert.match(text, /复制失败/);
    assert.match(text, /手动选中文本复制/);
    assert.doesNotMatch(text, /^已复制/);
  });

  it("成功带复制内容", () => {
    assert.equal(copyMessage(true, "127.0.0.1:1080"), "已复制：127.0.0.1:1080");
  });
});

/* ══════════════════════════════════════════════════════════════ 假 api */

function fakeApi(
  response: ApiResponse,
  calls: Record<string, unknown>[] = [],
): ApiClient {
  const raw = async (request: { readonly op: string; readonly [key: string]: unknown }): Promise<ApiResponse> => {
    calls.push(request as unknown as Record<string, unknown>);
    return response;
  };
  return {
    raw,
    snapshot: raw as never, assets: raw as never, asset: raw as never, vulns: raw as never,
    sessions: raw as never, chain: raw as never, scores: raw as never, report: raw as never,
    consoleDigest: raw as never, shotData: raw as never, activateEngagement: raw as never,
  } as unknown as ApiClient;
}

/* ══════════════════════════════════════════════════════════════ 渲染：空态 */

describe("renderSessionTab — 四种空态", () => {
  it("**未选靶标**：渲染真实空态", () => {
    const text = render({ engagement: null }).text;
    assert.match(text, new RegExp(NO_ENGAGEMENT_TEXT.slice(0, 8)));
  });

  it("未选靶标时不渲染工具栏", () => {
    assert.doesNotMatch(render({ engagement: null }).text, /检测连通性/);
  });

  it("**未加载**（data=null）时工具栏仍渲染、徽章显示 0/0", () => {
    const text = render({ data: null }).text;
    assert.match(text, /会话与入口/);
    assert.match(text, /WebShell 0\/0 在线/);
    assert.match(text, /隧道 0\/0 可用/);
  });

  it("**没有 WebShell 也没有隧道**时显示引导空态", () => {
    const text = render({ data: data({ shells: [], tunnels: [] }) }).text;
    assert.match(text, new RegExp(EMPTY_TITLE.slice(0, 8)));
    assert.match(text, /redteam_webshell_add/);
    assert.match(text, /redteam_tunnel_add/);
  });

  it("**请求失败**时显示错误条（区块仍然渲染）", () => {
    const result = render({ data: null, error: "读取失败" });
    assert.notEqual(findOne(result, (element) => classOf(element) === "rt-err"), null);
    assert.match(result.text, /WebShell/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：工具栏 */

describe("renderSessionTab — 工具栏", () => {
  it("显示四项计数", () => {
    const text = render({
      data: data({ totals: { webshells: 3, webshellsOnline: 2, tunnels: 2, tunnelsActive: 1, credentials: 7, access: 5 } }),
    }).text;
    assert.match(text, /WebShell 2\/3 在线/);
    assert.match(text, /隧道 1\/2 可用/);
    assert.match(text, /凭据 7/);
    assert.match(text, /访问会话 5/);
  });

  it("**计数为 0 时显示 0/0 而不是空白**", () => {
    const text = render({
      data: data({
        shells: [],
        tunnels: [],
        totals: { webshells: 0, webshellsOnline: 0, tunnels: 0, tunnelsActive: 0, credentials: 0, access: 0 },
      }),
    }).text;
    assert.match(text, /WebShell 0\/0 在线/);
    assert.match(text, /隧道 0\/0 可用/);
    assert.match(text, /凭据 0/);
    assert.match(text, /访问会话 0/);
  });

  it("busy 时按钮禁用且文案为「检测中…」", () => {
    const result = render({ busy: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("检测中"));
    assert.equal(button?.props["disabled"], true);
  });

  it("点检测 / 刷新各自回调", () => {
    let probes = 0;
    let refreshes = 0;
    const result = render({ onProbe: () => (probes += 1), onRefresh: () => (refreshes += 1) });
    fire(findAll(result, "button").find((element) => textOf(element).includes("检测连通性"))!, "onClick");
    fire(findAll(result, "button").find((element) => textOf(element) === "刷新")!, "onClick");
    assert.deepEqual([probes, refreshes], [1, 1]);
  });

  it("成功消息用 rt-foot、失败用 rt-err", () => {
    assert.notEqual(findOne(render({ message: { ok: "检测完成" } }), (element) => classOf(element) === "rt-foot"), null);
    assert.notEqual(findOne(render({ message: { err: "检测失败" } }), (element) => classOf(element) === "rt-err"), null);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：WebShell 卡 */

describe("renderSessionTab — WebShell 卡片", () => {
  it("渲染 URL / 类型 / 权限 / 口令 / 资产", () => {
    const text = render({ data: data({ tunnels: [] }) }).text;
    assert.match(text, /shell\.jsp/);
    assert.match(text, /godzilla/);
    assert.match(text, /pass123/);
    assert.match(text, /root/);
    assert.match(text, /203\.0\.113\.5/);
  });

  it("**加密马标「用户可直连」，非加密马标「用户连不上」**", () => {
    assert.doesNotMatch(render({ data: data({ shells: [shell({ shellType: "godzilla" })], tunnels: [] }) }).text, /用户连不上/);
    assert.match(render({ data: data({ shells: [shell({ shellType: "one-liner" })], tunnels: [] }) }).text, /用户连不上/);
  });

  it("点「复制 URL」回调 curl 命令", () => {
    const copies: { key: string; text: string }[] = [];
    const s = shell({ id: 5, url: "https://x/s.jsp" });
    const result = render({
      data: data({ shells: [s], tunnels: [] }),
      onCopy: (key, text) => copies.push({ key, text }),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "复制 URL")!, "onClick");
    assert.deepEqual(copies, [{ key: "cmd5", text: 'curl -s "https://x/s.jsp"' }]);
  });

  it("**copied 命中时按钮换成「已复制」**", () => {
    const s = shell({ id: 5 });
    const result = render({ data: data({ shells: [s], tunnels: [] }), copied: "cmd5" });
    assert.match(result.text, /已复制/);
    assert.equal(findAll(result, "button").filter((element) => textOf(element) === "复制 URL").length, 0);
  });

  it("点「标记失效」回调 offline", () => {
    const marks: { shell: WebShellItem; status: string }[] = [];
    const s = shell({ id: 6 });
    const result = render({
      data: data({ shells: [s], tunnels: [] }),
      onMarkShell: (item, status) => marks.push({ shell: item, status }),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "标记失效")!, "onClick");
    assert.equal(marks[0]?.shell.id, 6);
    assert.equal(marks[0]?.status, "offline");
  });

  it("没有 WebShell 时区块显示登记提示", () => {
    assert.match(render({ data: data({ shells: [], tunnels: [] }) }).text, /redteam_webshell_add/);
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：隧道卡 */

describe("renderSessionTab — 隧道卡片", () => {
  it("渲染监听地址 / kind / 可达网段 / 入口", () => {
    const text = render().text;
    assert.match(text, /127\.0\.0\.1:1080/);
    assert.match(text, /suo5/);
    assert.match(text, /10\.0\.0\.0\/8/);
    assert.match(text, /目标侧入口/);
  });

  it("**legit 三态的徽章文案都渲染正确**", () => {
    assert.match(render({ data: data({ tunnels: [tunnel({ legit: true })] }) }).text, /目标侧通道/);
    assert.match(render({ data: data({ tunnels: [tunnel({ legit: false })] }) }).text, /不算突破/);
    assert.match(render({ data: data({ tunnels: [tunnel({ legit: null })] }) }).text, /待确认/);
  });

  it("非 suo5 的 kind 带「非 suo5 标准通道」", () => {
    assert.match(render({ data: data({ tunnels: [tunnel({ kind: "frp" })] }) }).text, /非 suo5 标准通道/);
    assert.doesNotMatch(render({ data: data({ tunnels: [tunnel({ kind: "suo5" })] }) }).text, /非 suo5 标准通道/);
  });

  it("active 时按钮是「标记失效」，否则是「标记可用」", () => {
    assert.match(render({ data: data({ tunnels: [tunnel({ status: "active" })] }) }).text, /标记失效/);
    assert.match(render({ data: data({ tunnels: [tunnel({ status: "down" })] }) }).text, /标记可用/);
  });

  it("点标记回调对应状态", () => {
    const marks: { tunnel: TunnelItem; status: string }[] = [];
    const active = tunnel({ id: 9, status: "active" });
    // 只留隧道、清掉 WebShell：否则第一个「标记失效」是 WebShell 卡上的那个。
    const result = render({
      data: data({ shells: [], tunnels: [active] }),
      onMarkTunnel: (item, status) => marks.push({ tunnel: item, status }),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "标记失效")!, "onClick");
    assert.equal(marks[0]?.tunnel.id, 9);
    assert.equal(marks[0]?.status, "down");
  });

  it("down 状态的隧道点「标记可用」回调 active", () => {
    const marks: { tunnel: TunnelItem; status: string }[] = [];
    const down = tunnel({ id: 10, status: "down" });
    const result = render({
      data: data({ shells: [], tunnels: [down] }),
      onMarkTunnel: (item, status) => marks.push({ tunnel: item, status }),
    });
    fire(findAll(result, "button").find((element) => textOf(element) === "标记可用")!, "onClick");
    assert.equal(marks[0]?.status, "active");
  });

  it("**建立命令默认折叠**（details 无 open）", () => {
    const result = render({ data: data({ tunnels: [tunnel({ command: "suo5 -l 1080" })] }) });
    const details = findAll(result, "details");
    assert.ok(details.length >= 1);
    assert.equal(details[0]?.props["open"], undefined, "默认折叠时不传 open");
    assert.match(result.text, /建立命令（点击展开 \/ 复制）/);
  });

  it("没有 command 时不渲染命令块", () => {
    assert.doesNotMatch(render({ data: data({ tunnels: [tunnel({ command: "" })] }) }).text, /建立命令/);
  });

  it("**active 且有监听地址时才有扫描命令**", () => {
    const active = render({ data: data({ tunnels: [tunnel({ status: "active", listen: "127.0.0.1:1080" })] }) });
    assert.match(active.text, /走这条隧道扫描/);

    const down = render({ data: data({ tunnels: [tunnel({ status: "down" })] }) });
    assert.doesNotMatch(down.text, /走这条隧道扫描/);

    const noListen = render({ data: data({ tunnels: [tunnel({ listen: "" })] }) });
    assert.doesNotMatch(noListen.text, /走这条隧道扫描/);
  });

  it("扫描命令块里的 gogo / fscan 命令文本正确", () => {
    const text = render({ data: data({ tunnels: [tunnel()] }) }).text;
    assert.match(text, /\.\/gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy socks5:\/\/127\.0\.0\.1:1080/);
    assert.match(text, /\.\/fscan -h <内网CIDR> -np -nobr -nopoc -socks5 127\.0\.0\.1:1080 -o intranet\.txt/);
  });

  it("点「复制地址」回调监听地址", () => {
    const copies: string[] = [];
    const result = render({ onCopy: (key, text) => copies.push(key + "=" + text) });
    fire(findAll(result, "button").find((element) => textOf(element) === "复制地址")!, "onClick");
    assert.deepEqual(copies, ["sock1=127.0.0.1:1080"]);
  });

  it("没有隧道时区块显示登记提示", () => {
    assert.match(render({ data: data({ shells: [], tunnels: [] }) }).text, new RegExp(EMPTY_TUNNELS_TEXT.slice(0, 4)));
  });
});

/* ══════════════════════════════════════════════════════════════ 渲染：提示与折叠 */

describe("renderSessionTab — 提示条与折叠", () => {
  it("坏马时渲染提示条（含可展开做法）", () => {
    const result = render({ data: data({ shells: [shell({ shellType: "one-liner" })], tunnels: [] }) });
    const hint = findOne(result, (element) => classOf(element) === "rt-hint");
    assert.notEqual(hint, null);
    assert.match(result.text, /怎么做（点击展开）/);
    assert.match(result.text, /webshell-toolkit/);
  });

  it("没有提示时不渲染提示区", () => {
    const result = render({ data: data({ tunnels: [tunnel({ kind: "suo5", legit: true, status: "active" })] }) });
    assert.equal(findOne(result, (element) => classOf(element) === "rt-hint"), null);
  });

  it("两个区块默认展开（能看到卡片内容）", () => {
    const text = render().text;
    assert.match(text, /类型/);
    assert.match(text, /目标侧入口/);
  });

  it("折叠后不渲染卡片内容，但区块标题还在", () => {
    const result = render({ collapsed: { shells: false, tunnels: false } });
    assert.match(result.text, /WebShell/);
    assert.match(result.text, /内网隧道/);
    assert.doesNotMatch(result.text, /连接口令/);
  });

  it("点区块标题触发 onToggleSection", () => {
    const keys: string[] = [];
    const result = render({ onToggleSection: (key) => keys.push(key) });
    const head = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => textOf(element).includes("WebShell"));
    fire(head!, "onClick");
    assert.deepEqual(keys, ["shells"]);
  });

  it("区块标题键盘可达（Enter）", () => {
    const keys: string[] = [];
    const result = render({ onToggleSection: (key) => keys.push(key) });
    const head = findAll(result, (element) => element.props["role"] === "button")
      .find((element) => textOf(element).includes("内网隧道"));
    fire(head!, "onKeyDown", { key: "Enter" });
    assert.deepEqual(keys, ["tunnels"]);
  });
});

/* ══════════════════════════════════════════════════════════════ 流程 */

describe("session-model — 流程", () => {
  it("loadSessions 成功返回解析后的数据", async () => {
    const api = fakeApi({ ok: true, webshells: [{ id: 1, url: "u" }], tunnels: [], totals: {} });
    const result = await loadSessions(api, "eng-1");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.shells.length, 1);
  });

  it("loadSessions 失败返回 err", async () => {
    const api = fakeApi({ ok: false, error: "读取失败" });
    const result = await loadSessions(api, "eng-1");
    assert.equal(result.ok, false);
  });

  it("probeSessions 成功返回摘要", async () => {
    const api = fakeApi({ ok: true, webshells: [{ status: "online" }], tunnels: [] });
    const result = await probeSessions(api, "eng-1");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.onlineShells, 1);
  });

  it("probeSessions 失败返回 err（界面要保留旧数据）", async () => {
    const api = fakeApi({ ok: false, error: "网络不可达" });
    const result = await probeSessions(api, "eng-1");
    assert.equal(result.ok === false && result.error, "网络不可达");
  });

  it("markTunnel 成功返回 ok(null)", async () => {
    const api = fakeApi({ ok: true });
    const result = await markTunnel(api, "eng-1", 1, "down");
    assert.equal(result.ok, true);
  });

  it("markTunnel 失败带回文案", async () => {
    const api = fakeApi({ ok: false, error: "隧道不存在" });
    const result = await markTunnel(api, "eng-1", 1, "down");
    assert.equal(result.ok === false && result.error, "隧道不存在");
  });

  it("markShell 发 updateWebshell", async () => {
    const calls: Record<string, unknown>[] = [];
    await markShell(fakeApi({ ok: true }, calls), "eng-1", 2, "offline");
    assert.equal(calls[0]?.["op"], "updateWebshell");
    assert.equal(calls[0]?.["id"], 2);
  });

  it("sessionDataOf 解析 totals 的 snake_case", async () => {
    const parsed = sessionDataOf({
      webshells: [],
      tunnels: [],
      totals: { webshells: 2, webshells_online: 1, tunnels: 3, tunnels_active: 2 },
    });
    assert.equal(parsed.totals.webshellsOnline, 1);
    assert.equal(parsed.totals.tunnelsActive, 2);
  });
});

/* ══════════════════════════════════════════════════════════════ 端到端 */

describe("端到端：从原始响应一路渲染", () => {
  it("完整会话响应渲染出工具栏计数、卡片与三条提示", () => {
    const parsed = sessionDataOf({
      ok: true,
      totals: { webshells: 2, webshellsOnline: 1, tunnels: 1, tunnelsActive: 0, credentials: 3, access: 1 },
      webshells: [
        { id: 1, url: "https://a/s.jsp", shell_type: "godzilla", status: "online", pass_key: "p", privilege: "root" },
        { id: 2, url: "https://b/s.php", shell_type: "one-liner", status: "offline" },
      ],
      tunnels: [
        { id: 1, kind: "frp", listen: "127.0.0.1:7000", status: "down", legit: false, entry_kind: "self-only" },
      ],
    });
    const runtime = makeRuntime();
    const text = renderToText(renderSessionTab(runtime, props({ data: parsed }))).text;
    assert.match(text, /WebShell 1\/2 在线/);
    assert.match(text, /隧道 0\/1 可用/);
    assert.match(text, /godzilla/);
    assert.match(text, /one-liner/);
    assert.match(text, /127\.0\.0\.1:7000/);
    // 三条提示全中：坏马 / 全不算突破 / 无 suo5。
    assert.match(text, /不是冰蝎马\/哥斯拉马/);
    assert.match(text, /都不算"跨越靶标边界"/);
    assert.match(text, /还没有可用的 suo5 隧道/);
  });
});
