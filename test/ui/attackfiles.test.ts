/**
 * 攻击文件页的模型 + 渲染测试。
 *
 * 重点：
 * - 类型显示名的兜底（未知类型原样显示，不折叠成「其他」）
 * - 文件夹计数用 `count` 求和而不是数组长度（服务端可能截断文件列表）
 * - 详情只能同时展开一个（同一条再点收起）
 * - `folder.files` 为空但文件夹存在时显示「（空）」而不是整块消失
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTestReact, renderToText, findAll, findOne, fire, classOf, textOf } from "./helpers/react.js";
import { createRuntime, type ConsoleRuntime } from "../../src/redteam/client/runtime.js";
import {
  loadAttackFile,
  loadAttackFiles,
  renderAttackFilesTab,
  totalFileCount,
  type AttackFilesTabProps,
} from "../../src/redteam/client/attackfiles-tab.js";
import {
  EMPTY_FILES_MESSAGE,
  FILE_KIND_LABEL,
  FILES_ERROR_FALLBACK,
  FILES_FOOTER,
  caretOf,
  countOrZero,
  detailContent,
  detailEvidence,
  detailRecordedLine,
  fileCount,
  fileDetailOf,
  fileFolderOf,
  fileFoldersOf,
  fileRowOf,
  folderCollapseKey,
  folderCount,
  folderCountLabel,
  folderTitle,
  isRowOpen,
  kindLabel,
  nextDetailId,
  refreshLabel,
  rowDescription,
  rowName,
  rowTitle,
  toolbarCountLabel,
  type FileDetail,
  type FileFolder,
  type FileRow,
} from "../../src/redteam/client/attackfiles-model.js";
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

/** 造一个文件行。 */
function row(overrides: Partial<FileRow> = {}): FileRow {
  return { id: 1, name: "poc.py", kind: "poc", description: "验证未授权", ...overrides };
}

/** 造一个文件夹。 */
function folder(overrides: Partial<FileFolder> = {}): FileFolder {
  return {
    folder: "10.0.0.5",
    count: 1,
    files: [row()],
    ...overrides,
  };
}

/** 造一份详情。 */
function detail(overrides: Partial<FileDetail> = {}): FileDetail {
  return {
    id: 1,
    name: "poc.py",
    content: "print('uid=0')",
    path: "attack-files/10.0.0.5/poc.py",
    evidence: "回显 uid=0",
    createdAt: "2026-01-02T03:04:05Z",
    createdBy: "exploit",
    ...overrides,
  };
}

/** 默认 props。 */
function props(overrides: Partial<AttackFilesTabProps> = {}): AttackFilesTabProps {
  return {
    folders: [folder()],
    detail: null,
    error: null,
    busy: false,
    collapse: {},
    onRefresh: () => undefined,
    onOpenFile: () => undefined,
    onCollapseChange: () => undefined,
    ...overrides,
  };
}

/** 渲染。 */
function render(overrides: Partial<AttackFilesTabProps> = {}): {
  readonly runtime: ConsoleRuntime;
  readonly result: ReturnType<typeof renderToText>;
} {
  const runtime = makeRuntime();
  return { runtime, result: renderToText(renderAttackFilesTab(runtime, props(overrides))) };
}

/** 造 api 替身。 */
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

describe("attackfiles-model — 类型名", () => {
  it("五个已知类型的显示名", () => {
    assert.equal(kindLabel("poc"), "POC");
    assert.equal(kindLabel("exp"), "EXP");
    assert.equal(kindLabel("script"), "脚本");
    assert.equal(kindLabel("wordlist"), "字典");
    assert.equal(kindLabel("other"), "其他");
  });

  it("**未知类型原样显示**（暴露上游新值，不折叠成「其他」）", () => {
    assert.equal(kindLabel("payload"), "payload");
  });

  it("空类型显示 —", () => {
    assert.equal(kindLabel(""), "—");
  });

  it("类型表有五个键", () => {
    assert.equal(Object.keys(FILE_KIND_LABEL).length, 5);
  });
});

describe("attackfiles-model — 解析", () => {
  it("解析文件行", () => {
    const parsed = fileRowOf({ id: 2, name: "n", kind: "exp", description: "d" });
    assert.equal(parsed?.id, 2);
    assert.equal(parsed?.kind, "exp");
  });

  it("丢没有 id 的行", () => {
    assert.equal(fileRowOf({ name: "x" }), null);
  });

  it("解析文件夹并保留 count", () => {
    const parsed = fileFolderOf({ folder: "10.0.0.5", count: 5, files: [{ id: 1 }] });
    assert.equal(parsed?.count, 5);
    assert.equal(parsed?.files.length, 1);
  });

  it("**count 缺失时退回数组长度**（否则工具栏显示「0 个文件」而列表有内容）", () => {
    const parsed = fileFolderOf({ folder: "f", files: [{ id: 1 }, { id: 2 }] });
    assert.equal(parsed?.count, 2);
  });

  it("丢没有文件夹名的项", () => {
    assert.equal(fileFolderOf({ files: [] }), null);
  });

  it("解析列表响应", () => {
    const folders = fileFoldersOf({ ok: true, items: [{ folder: "a" }, { folder: "b" }] });
    assert.equal(folders.length, 2);
  });

  it("失败响应 → 空数组", () => {
    assert.deepEqual(fileFoldersOf({ ok: false }), []);
  });

  it("解析详情", () => {
    const parsed = fileDetailOf({
      ok: true,
      id: 1,
      name: "n",
      content: "c",
      path: "p",
      evidence: "e",
      created_at: "2026-01-01T00:00:00Z",
      created_by: "exploit",
    });
    assert.equal(parsed?.content, "c");
    assert.equal(parsed?.createdBy, "exploit");
  });

  it("详情失败 → null", () => {
    assert.equal(fileDetailOf({ ok: false }), null);
  });

  it("详情没有 id → null", () => {
    assert.equal(fileDetailOf({ ok: true, name: "x" }), null);
  });

  it("countOrZero 兜底", () => {
    assert.equal(countOrZero("3"), 3);
    assert.equal(countOrZero(-2), 0);
    assert.equal(countOrZero("abc"), 0);
  });
});

describe("attackfiles-model — 计数与文案", () => {
  it("文件夹数", () => {
    assert.equal(folderCount([folder(), folder({ folder: "b" })]), 2);
  });

  it("**文件数用 count 求和**（包含服务端统计到但没取回的文件）", () => {
    assert.equal(fileCount([folder({ count: 5, files: [row()] })]), 5);
  });

  it("**混合多个文件夹的计数**", () => {
    assert.equal(fileCount([folder({ count: 3 }), folder({ count: 2 })]), 5);
  });

  it("空列表 → 0", () => {
    assert.equal(fileCount([]), 0);
    assert.equal(folderCount([]), 0);
  });

  it("工具栏计数文案", () => {
    assert.equal(toolbarCountLabel([folder({ count: 3 })]), "1 个目标 / 3 个文件");
  });

  it("文件夹标题与计数", () => {
    assert.equal(folderTitle(folder()), "10.0.0.5/");
    assert.equal(folderCountLabel(folder({ count: 4 })), "4 个文件");
  });

  it("折叠键", () => {
    assert.equal(folderCollapseKey(folder()), "folder:10.0.0.5");
  });

  it("刷新文案", () => {
    assert.equal(refreshLabel(false), "刷新");
    assert.equal(refreshLabel(true), "刷新中…");
  });

  it("折叠箭头", () => {
    assert.equal(caretOf(true), "▾");
    assert.equal(caretOf(false), "▸");
  });

  it("行的显示值兜底", () => {
    assert.equal(rowName(row({ name: "" })), "(未命名)");
    assert.equal(rowDescription(row({ description: "" })), "—");
    assert.equal(rowTitle(row({ description: "d" })), "d");
  });

  it("详情的显示值兜底", () => {
    assert.equal(detailContent(detail({ content: "" })), "（空）");
    assert.equal(detailEvidence(detail({ evidence: "" })), "—");
    assert.match(detailRecordedLine(detail()), /2026-01-02 03:04 · exploit/);
  });

  it("**详情没有记录人时不加多余分隔符**", () => {
    assert.equal(detailRecordedLine(detail({ createdBy: "" })), "2026-01-02 03:04");
  });
});

describe("attackfiles-model — 展开态", () => {
  it("isRowOpen 判定 id 相同才算展开", () => {
    assert.equal(isRowOpen(detail({ id: 1 }), 1), true);
    assert.equal(isRowOpen(detail({ id: 1 }), 2), false);
    assert.equal(isRowOpen(null, 1), false);
  });

  it("**点已展开的行 → 收起**", () => {
    assert.equal(nextDetailId(1, 1), null);
  });

  it("点别的行 → 换成新的", () => {
    assert.equal(nextDetailId(1, 2), 2);
    assert.equal(nextDetailId(null, 2), 2);
  });
});

describe("attackfiles-tab — 流程", () => {
  it("读列表", async () => {
    const { api, requests } = fakeApi([{ ok: true, items: [] }]);
    await loadAttackFiles(api as never, "eng-1");
    assert.equal(requests[0]?.["op"], "attackFiles");
  });

  it("读正文带 id", async () => {
    const { api, requests } = fakeApi([{ ok: true, id: 7 }]);
    await loadAttackFile(api as never, "eng-1", 7);
    assert.equal(requests[0]?.["op"], "readAttackFile");
    assert.equal(requests[0]?.["id"], 7);
  });

  it("totalFileCount 复用模型", () => {
    assert.equal(totalFileCount([folder({ count: 2 })]), 2);
  });
});

describe("renderAttackFilesTab — 工具栏", () => {
  it("渲染标题与计数", () => {
    const { result } = render();
    assert.match(result.text, /攻击文件/);
    assert.match(result.text, /1 个目标 \/ 1 个文件/);
  });

  it("点刷新触发 onRefresh", () => {
    let count = 0;
    const { result } = render({ onRefresh: () => { count += 1; } });
    const button = findAll(result, "button").find((element) => textOf(element) === "刷新");
    fire(button!, "onClick");
    assert.equal(count, 1);
  });

  it("busy 时按钮文案变「刷新中…」且禁用", () => {
    const { result } = render({ busy: true });
    const button = findAll(result, "button").find((element) => textOf(element).includes("刷新中"));
    assert.equal(button?.props["disabled"], true);
  });

  it("底部有目录说明", () => {
    assert.match(render().result.text, /attack-files\/<IP\|URL主机\|C段>\//);
  });
});

describe("renderAttackFilesTab — 文件夹与文件", () => {
  it("渲染文件夹标题与计数", () => {
    const { result } = render();
    assert.match(result.text, /10\.0\.0\.5\//);
    assert.match(result.text, /1 个文件/);
  });

  it("**文件夹默认展开**（否则第一次进来是一片空白标题）", () => {
    assert.match(render().result.text, /poc\.py/);
  });

  it("折叠后文件不渲染", () => {
    const { result } = render({ collapse: { "folder:10.0.0.5": false } });
    assert.doesNotMatch(result.text, /poc\.py/);
  });

  it("点文件夹头切换折叠", () => {
    const states: unknown[] = [];
    const { result } = render({ onCollapseChange: (state) => states.push(state) });
    const head = findOne(result, (element) => classOf(element) === "rt-sec t-folder");
    fire(head!, "onClick");
    assert.equal(states.length, 1);
  });

  it("键盘 Enter 也能折叠", () => {
    const states: unknown[] = [];
    const { result } = render({ onCollapseChange: (state) => states.push(state) });
    const head = findOne(result, (element) => classOf(element) === "rt-sec t-folder");
    fire(head!, "onKeyDown", { key: "Enter" });
    assert.equal(states.length, 1);
  });

  it("渲染文件行的类型与描述", () => {
    const { result } = render();
    assert.match(result.text, /POC/);
    assert.match(result.text, /验证未授权/);
  });

  it("**未知类型的文件原样显示**", () => {
    const { result } = render({
      folders: [folder({ files: [row({ kind: "payload" })] })],
    });
    assert.match(result.text, /payload/);
  });

  it("文件名缺失时显示（未命名）", () => {
    const { result } = render({ folders: [folder({ files: [row({ name: "" })] })] });
    assert.match(result.text, /\(未命名\)/);
  });

  it("描述缺失时显示 —", () => {
    const { result } = render({ folders: [folder({ files: [row({ description: "" })] })] });
    assert.match(result.text, /—/);
  });

  it("点文件行触发 onOpenFile", () => {
    const opened: FileRow[] = [];
    const { result } = render({ onOpenFile: (file) => opened.push(file) });
    const fileNode = findOne(result, (element) => classOf(element) === "rt-vrow");
    fire(fileNode!, "onClick");
    assert.equal(opened[0]?.id, 1);
  });

  it("键盘 Enter 也能打开文件", () => {
    const opened: FileRow[] = [];
    const { result } = render({ onOpenFile: (file) => opened.push(file) });
    const fileNode = findOne(result, (element) => classOf(element) === "rt-vrow");
    fire(fileNode!, "onKeyDown", { key: "Enter" });
    assert.equal(opened.length, 1);
  });

  it("**展开的文件渲染详情（效果/路径/记录/正文）**", () => {
    const { result } = render({ detail: detail() });
    assert.match(result.text, /效果/);
    assert.match(result.text, /回显 uid=0/);
    assert.match(result.text, /attack-files\/10\.0\.0\.5\/poc\.py/);
    assert.match(result.text, /print\('uid=0'\)/);
  });

  it("**详情只挂在对应的文件行下**", () => {
    const { result } = render({
      folders: [folder({ count: 2, files: [row({ id: 1 }), row({ id: 2, name: "b.sh" })] })],
      detail: detail({ id: 2 }),
    });
    // 只有 b.sh 的箭头是展开的。
    assert.match(result.text, /▾/);
    assert.match(result.text, /▸/);
  });

  it("展开行的箭头变 ▾", () => {
    const { result } = render({ detail: detail() });
    const carets = findAll(result, (element) => classOf(element) === "rt-sec-caret")
      .map((element) => textOf(element));
    assert.ok(carets.includes("▾"));
  });

  it("**文件列表为空但文件夹存在时显示（空）**", () => {
    const { result } = render({ folders: [folder({ count: 0, files: [] })] });
    assert.match(result.text, /（空）/);
  });

  it("**多个文件夹都渲染**", () => {
    const { result } = render({
      folders: [
        folder({ folder: "10.0.0.5", files: [row({ id: 1 })] }),
        folder({ folder: "10.0.0.6", files: [row({ id: 2, name: "x.sh" })] }),
      ],
    });
    assert.match(result.text, /10\.0\.0\.5\//);
    assert.match(result.text, /10\.0\.0\.6\//);
  });
});

describe("renderAttackFilesTab — 空态与错误态", () => {
  it("**空列表显示空态**（不整页空白）", () => {
    const { result } = render({ folders: [] });
    assert.ok(result.text.includes(EMPTY_FILES_MESSAGE));
  });

  it("空列表时工具栏仍渲染", () => {
    const { result } = render({ folders: [] });
    assert.match(result.text, /攻击文件/);
    assert.match(result.text, /0 个目标 \/ 0 个文件/);
  });

  it("读取失败显示 rt-err", () => {
    const { result } = render({ folders: [], error: "磁盘错误" });
    const node = findOne(result, (element) => classOf(element) === "rt-err");
    assert.notEqual(node, null);
    assert.match(result.text, /磁盘错误/);
  });

  it("**读取失败时工具栏仍渲染**", () => {
    const { result } = render({ folders: [], error: "磁盘错误" });
    assert.match(result.text, /刷新/);
  });

  it("**失败 + 空列表：错误与空态都在**（两种信息不互斥）", () => {
    const { result } = render({ folders: [], error: "磁盘错误" });
    assert.match(result.text, /磁盘错误/);
    assert.ok(result.text.includes(EMPTY_FILES_MESSAGE));
  });

  it("**有数据但被折叠时不显示空态**", () => {
    const { result } = render({ collapse: { "folder:10.0.0.5": false } });
    assert.ok(!result.text.includes(EMPTY_FILES_MESSAGE));
  });

  it("底部说明即使空态也在", () => {
    assert.ok(render({ folders: [] }).result.text.includes(FILES_FOOTER));
  });

  it("错误兜底文案常量可用", () => {
    assert.equal(FILES_ERROR_FALLBACK, "读取失败");
  });
});
