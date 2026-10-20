/**
 * ZIP 解压测试。
 *
 * 重点不是「能解压普通 zip」，而是 **Zip Slip 防护真的挡得住**。
 * 用 buildZip 手工构造恶意条目名来实际攻击，而不是只测一个纯函数。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ZipError,
  extractZipArchive,
  extractZipBuffer,
  listZipEntries,
  listZipFile,
  safeZipName,
  unzipTools,
} from "../../src/platform/zip.js";
import { buildZip } from "../helpers/zip.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unbound-zip-"));
}

describe("safeZipName — 第一层防护", () => {
  it("保留正常相对路径", () => {
    assert.equal(safeZipName("a/b/c.txt"), "a/b/c.txt");
  });

  it("反斜杠归一为斜杠", () => {
    assert.equal(safeZipName("a\\b\\c.txt"), "a/b/c.txt");
  });

  it("去掉开头的 ./", () => {
    assert.equal(safeZipName("./a.txt"), "a.txt");
  });

  it("★ 绝对路径被拒绝（不是降级）", () => {
    // 与 plugin/skills.ts 的 isUnsafeArchiveEntry 对齐：
    // 早期实现会把 "/a.txt" 降级成 "a.txt"，语义与那边不一致。
    // 现在统一为拒绝——两个函数服务同一类不可信输入。
    assert.throws(() => safeZipName("/a.txt"), ZipError);
    assert.throws(() => safeZipName("/etc/passwd"), ZipError);
  });

  it("去掉末尾斜杠（目录条目）", () => {
    assert.equal(safeZipName("dir/"), "dir");
  });

  it("空名返回空串（调用方跳过）", () => {
    assert.equal(safeZipName(""), "");
  });

  it("单独的 / 是绝对路径 → 拒绝", () => {
    assert.throws(() => safeZipName("/"), ZipError);
  });

  it("拒绝 .. 穿越", () => {
    assert.throws(() => safeZipName("../evil"), ZipError);
    assert.throws(() => safeZipName("a/../../evil"), ZipError);
  });

  it("拒绝位于中间的 ..", () => {
    assert.throws(() => safeZipName("a/../b"), ZipError);
  });

  it("拒绝 Windows 盘符绝对路径", () => {
    assert.throws(() => safeZipName("C:/evil"), ZipError);
  });

  it("拒绝空段（a//b）", () => {
    assert.throws(() => safeZipName("a//b"), ZipError);
  });
});

describe("listZipEntries / listZipFile", () => {
  it("列出条目名", () => {
    const zip = buildZip([
      { name: "a.txt", content: "A" },
      { name: "dir/b.txt", content: "B" },
    ]);
    assert.deepEqual(listZipEntries(zip), ["a.txt", "dir/b.txt"]);
  });

  it("从文件列出（与 buffer 一致）", () => {
    const root = tmp();
    try {
      const zipPath = path.join(root, "x.zip");
      fs.writeFileSync(zipPath, buildZip([{ name: "only.txt", content: "1" }]));
      assert.deepEqual(listZipFile(zipPath), ["only.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("非 zip 数据抛错（不静默返回空）", () => {
    assert.throws(() => listZipEntries(Buffer.from("not a zip at all, definitely not")), ZipError);
  });

  it("过短的 buffer 抛错", () => {
    assert.throws(() => listZipEntries(Buffer.alloc(4)), ZipError);
  });
});

describe("extractZipBuffer — 正常解压", () => {
  it("deflate 条目内容正确", () => {
    const root = tmp();
    try {
      extractZipBuffer(buildZip([{ name: "hello.txt", content: "hello world" }]), root);
      assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hello world");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stored（method=0）条目内容正确", () => {
    const root = tmp();
    try {
      extractZipBuffer(buildZip([{ name: "s.txt", content: "stored", method: 0 }]), root);
      assert.equal(fs.readFileSync(path.join(root, "s.txt"), "utf8"), "stored");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("多条目 + 嵌套目录自动创建", () => {
    const root = tmp();
    try {
      extractZipBuffer(
        buildZip([
          { name: "a/x.txt", content: "1" },
          { name: "a/b/y.txt", content: "2" },
        ]),
        root,
      );
      assert.equal(fs.readFileSync(path.join(root, "a", "x.txt"), "utf8"), "1");
      assert.equal(fs.readFileSync(path.join(root, "a", "b", "y.txt"), "utf8"), "2");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("UTF-8 文件名正确", () => {
    const root = tmp();
    try {
      extractZipBuffer(buildZip([{ name: "中文/文件.txt", content: "内容" }]), root);
      assert.equal(fs.readFileSync(path.join(root, "中文", "文件.txt"), "utf8"), "内容");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("空内容条目也能落盘", () => {
    const root = tmp();
    try {
      extractZipBuffer(buildZip([{ name: "empty.txt", content: "" }]), root);
      assert.equal(fs.readFileSync(path.join(root, "empty.txt"), "utf8"), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractZipBuffer — Zip Slip 攻击（核心安全测试）", () => {
  it("拒绝 ../ 逃逸条目，且不在目标外写文件", () => {
    const root = tmp();
    const outside = path.join(root, "outside");
    const dest = path.join(root, "dest");
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    try {
      const evil = buildZip([{ name: "../outside/pwned.txt", content: "PWNED" }]);
      assert.throws(() => extractZipBuffer(evil, dest), ZipError);
      // 关键断言：文件真的没被写到外面
      assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false, "不得写出目标目录");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝深层穿越 a/../../escape", () => {
    const root = tmp();
    const dest = path.join(root, "dest");
    fs.mkdirSync(dest, { recursive: true });
    try {
      const evil = buildZip([{ name: "a/../../escape.txt", content: "X" }]);
      assert.throws(() => extractZipBuffer(evil, dest), ZipError);
      assert.equal(fs.existsSync(path.join(root, "escape.txt")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("★ 绝对路径条目整包拒绝，且不写任何文件", () => {
    // 对齐后：绝对路径直接抛，连 dest 里也不留东西。
    // 这比"降级后落进 dest"更强——降级虽然不写到系统路径，但会让
    // 恶意包"看起来解压成功"，掩盖了攻击意图。
    const root = tmp();
    const dest = path.join(root, "dest");
    fs.mkdirSync(dest, { recursive: true });
    try {
      const zip = buildZip([{ name: "/tmp/absolute-pwn.txt", content: "X" }]);
      assert.throws(() => extractZipBuffer(zip, dest), ZipError);
      assert.equal(fs.existsSync("/tmp/absolute-pwn.txt"), false, "绝不能写到系统路径");
      assert.equal(
        fs.existsSync(path.join(dest, "tmp", "absolute-pwn.txt")),
        false,
        "拒绝时不应留下降级产物",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("带盘符的绝对路径（C:/）被拒绝", () => {
    const root = tmp();
    const dest = path.join(root, "dest");
    fs.mkdirSync(dest, { recursive: true });
    try {
      const zip = buildZip([{ name: "C:/evil.txt", content: "X" }]);
      assert.throws(() => extractZipBuffer(zip, dest), ZipError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("混合条目时，恶意条目会导致整体失败（不会「先写好的再报错」）", () => {
    const root = tmp();
    const dest = path.join(root, "dest");
    fs.mkdirSync(dest, { recursive: true });
    try {
      const mixed = buildZip([
        { name: "good.txt", content: "ok" },
        { name: "../evil.txt", content: "bad" },
      ]);
      assert.throws(() => extractZipBuffer(mixed, dest), ZipError);
      assert.equal(fs.existsSync(path.join(root, "evil.txt")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractZipBuffer — 畸形输入", () => {
  it("数据被截断时抛错", () => {
    const root = tmp();
    try {
      const zip = buildZip([{ name: "a.txt", content: "hello" }]);
      const truncated = zip.subarray(0, zip.length - 30);
      assert.throws(() => extractZipBuffer(truncated, root), ZipError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("不支持的压缩方式（method=99）抛错", () => {
    const root = tmp();
    try {
      // 手工把 method 改成 99：buildZip 只支持 0/8，这里改中央目录里的字节
      const zip = buildZip([{ name: "a.txt", content: "x", method: 0 }]);
      const idx = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      assert.ok(idx > 0, "应有中央目录");
      zip.writeUInt16LE(99, idx + 10);
      assert.throws(() => extractZipBuffer(zip, root), ZipError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("extractZipArchive — 后端选择", () => {
  it("unzipTools 在 win32 上以 tar 开头、以 node 结尾", () => {
    const tools = unzipTools("win32");
    assert.equal(tools[0], "tar");
    assert.equal(tools.at(-1), "node");
  });

  it("unzipTools 在 linux 上包含 node 兜底", () => {
    const tools = unzipTools("linux");
    assert.equal(tools.at(-1), "node");
    assert.ok(tools.includes("unzip"));
  });

  it("只给 node 后端时能解压", () => {
    const root = tmp();
    try {
      const zipPath = path.join(root, "x.zip");
      fs.writeFileSync(zipPath, buildZip([{ name: "n.txt", content: "via node" }]));
      const dest = path.join(root, "out");
      const used = extractZipArchive(zipPath, dest, ["node"]);
      assert.equal(used, "node");
      assert.equal(fs.readFileSync(path.join(dest, "n.txt"), "utf8"), "via node");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("全部后端都不可用时抛出含诊断的错误", () => {
    const root = tmp();
    try {
      const zipPath = path.join(root, "bad.zip");
      fs.writeFileSync(zipPath, Buffer.from("definitely not a zip file"));
      const dest = path.join(root, "out");
      assert.throws(
        () => extractZipArchive(zipPath, dest, ["node"]),
        (e: unknown) => e instanceof ZipError && /解压失败/.test((e as ZipError).message),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
