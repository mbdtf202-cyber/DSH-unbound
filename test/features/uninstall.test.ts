/**
 * 卸载决策测试。
 *
 * 这块错了会删错目录或改坏 package.json，所以测试重点是**不该删的不删**，
 * 而不只是"该删的删了"。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PLUGIN_NAME,
  isPluginBundleItem,
  pkgMentionsPlugin,
  shouldDeletePluginTree,
  stripPluginFromList,
  stripPluginFromPackage,
  wasApplied,
} from "../../src/features/uninstall.js";

const QILIN_CANDIDATES = [
  "/Users/raki/Documents/deepseek-harness/default-workspace/dsh-qilin",
  path.resolve(import.meta.dirname, "..", "..", "..", "dsh-qilin"),
];
function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "uninstall.js"))) return c;
  }
  return null;
}

describe("wasApplied", () => {
  it("有备份即算应用过", () => {
    assert.equal(wasApplied({ has_backup: true }), true);
  });
  it("补丁数 > 0 算应用过", () => {
    assert.equal(wasApplied({ patches_applied: 1 }), true);
    assert.equal(wasApplied({ patches_applied: "3" }), true);
  });
  it("补丁数为 0 不算", () => {
    assert.equal(wasApplied({ patches_applied: 0 }), false);
    assert.equal(wasApplied({ patches_applied: "0" }), false);
  });
  it("shim 被改成 patched 算应用过", () => {
    assert.equal(wasApplied({ shim_cmd: "patched" }), true);
    assert.equal(wasApplied({ shim_bin: "patched" }), true);
  });
  it("空状态不算", () => {
    assert.equal(wasApplied(null), false);
    assert.equal(wasApplied({}), false);
  });
});

describe("isPluginBundleItem", () => {
  it("字符串形态", () => {
    assert.equal(isPluginBundleItem("dsh-qilin"), true);
    assert.equal(isPluginBundleItem("dsh-qilin@1.2.0"), true, "带版本号也要认");
    assert.equal(isPluginBundleItem("dsh-qilin-extra"), false, "前缀相似不算");
  });
  it("对象形态看 id/name/package", () => {
    assert.equal(isPluginBundleItem({ id: "dsh-qilin" }), true);
    assert.equal(isPluginBundleItem({ name: "dsh-qilin" }), true);
    assert.equal(isPluginBundleItem({ package: "dsh-qilin" }), true);
  });
  it("其他包不算", () => {
    assert.equal(isPluginBundleItem({ id: "other" }), false);
  });
});

describe("stripPluginFromList", () => {
  it("剔除并报告变化（不改原数组）", () => {
    const orig = ["dsh-qilin", "other"];
    const r = stripPluginFromList(orig);
    assert.deepEqual(r.list, ["other"]);
    assert.equal(r.changed, true);
    assert.deepEqual(orig, ["dsh-qilin", "other"], "原数组不得被修改");
  });
  it("无变化时 changed=false", () => {
    const r = stripPluginFromList(["other"]);
    assert.equal(r.changed, false);
  });
  it("非数组原样返回", () => {
    const r = stripPluginFromList(null);
    assert.equal(r.changed, false);
    assert.equal(r.list, null);
  });
});

describe("stripPluginFromPackage — 四个依赖表", () => {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    it(`清理 ${field}`, () => {
      const pkg = { [field]: { "dsh-qilin": "1.0.0", other: "2" } } as Record<string, unknown>;
      assert.equal(stripPluginFromPackage(pkg), true);
      assert.deepEqual(pkg[field], { other: "2" });
    });
  }
});

describe("stripPluginFromPackage — 清单字段", () => {
  it("清理顶层 bundles（含带版本号）", () => {
    const pkg: Record<string, unknown> = { bundles: ["dsh-qilin@1.2.0", "keep"] };
    assert.equal(stripPluginFromPackage(pkg), true);
    assert.deepEqual(pkg["bundles"], ["keep"]);
  });

  it("清理顶层 plugins（对象形态）", () => {
    const pkg: Record<string, unknown> = { plugins: [{ id: "dsh-qilin" }, { id: "keep" }] };
    assert.equal(stripPluginFromPackage(pkg), true);
    assert.deepEqual(pkg["plugins"], [{ id: "keep" }]);
  });

  it("清理 dsh.profile 下的 bundles", () => {
    const pkg: Record<string, unknown> = { dsh: { profile: { bundles: ["dsh-qilin"] } } };
    assert.equal(stripPluginFromPackage(pkg), true);
    assert.deepEqual((pkg["dsh"] as { profile: { bundles: unknown } }).profile.bundles, []);
  });

  it("多处同时存在都清理", () => {
    const pkg: Record<string, unknown> = {
      dependencies: { "dsh-qilin": "x" },
      bundles: ["dsh-qilin"],
      dsh: { profile: { plugins: ["dsh-qilin"] } },
    };
    assert.equal(stripPluginFromPackage(pkg), true);
    assert.deepEqual(pkg["dependencies"], {});
    assert.deepEqual(pkg["bundles"], []);
  });
});

describe("stripPluginFromPackage — 边界", () => {
  it("null/非对象返回 false 不抛", () => {
    assert.equal(stripPluginFromPackage(null), false);
    assert.equal(stripPluginFromPackage(undefined), false);
    assert.equal(stripPluginFromPackage({}), false);
  });

  it("与本插件无关的包返回 false（不动它）", () => {
    const pkg: Record<string, unknown> = { dependencies: { other: "1" }, bundles: ["x"] };
    assert.equal(stripPluginFromPackage(pkg), false);
    assert.deepEqual(pkg, { dependencies: { other: "1" }, bundles: ["x"] });
  });

  it("破坏的 dsh/profile 结构不抛", () => {
    assert.equal(stripPluginFromPackage({ dsh: null }), false);
    assert.equal(stripPluginFromPackage({ dsh: { profile: "x" } }), false);
    assert.equal(stripPluginFromPackage({ bundles: "not-an-array" }), false);
  });

  it("原地修改（调用方依赖这个语义）", () => {
    const pkg: Record<string, unknown> = { dependencies: { "dsh-qilin": "1" } };
    const returned = stripPluginFromPackage(pkg);
    assert.equal(returned, true);
    assert.deepEqual(pkg["dependencies"], {}, "同一个对象被改了");
  });
});

describe("pkgMentionsPlugin", () => {
  it("依赖表里提到 → true", () => {
    assert.equal(pkgMentionsPlugin({ dependencies: { "dsh-qilin": "1" } }), true);
  });
  it("清单里提到 → true", () => {
    assert.equal(pkgMentionsPlugin({ bundles: ["dsh-qilin"] }), true);
    assert.equal(pkgMentionsPlugin({ dsh: { profile: { plugins: ["dsh-qilin"] } } }), true);
  });
  it("无关 → false", () => {
    assert.equal(pkgMentionsPlugin({ dependencies: { x: "1" } }), false);
    assert.equal(pkgMentionsPlugin(null), false);
  });
  it("与 strip 结果一致：strip 后不再 mention", () => {
    const pkg: Record<string, unknown> = { dependencies: { "dsh-qilin": "1" }, bundles: ["dsh-qilin"] };
    assert.equal(pkgMentionsPlugin(pkg), true);
    stripPluginFromPackage(pkg);
    assert.equal(pkgMentionsPlugin(pkg), false);
  });
});

describe("shouldDeletePluginTree — 安全边界", () => {
  it("node_modules 下的插件目录允许删", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "un-"));
    try {
      const dir = path.join(root, "node_modules", PLUGIN_NAME);
      fs.mkdirSync(dir, { recursive: true });
      assert.equal(shouldDeletePluginTree(dir, path.join(root, "home")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("profiles 下的目录允许删", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "un-"));
    try {
      const home = path.join(root, "home");
      const dir = path.join(home, "profiles", "web");
      fs.mkdirSync(dir, { recursive: true });
      assert.equal(shouldDeletePluginTree(dir, home), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("★ 无关目录一律不删（宁可留垃圾也不误伤）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "un-"));
    try {
      const home = path.join(root, "home");
      fs.mkdirSync(home, { recursive: true });
      const unrelated = path.join(root, "precious");
      fs.mkdirSync(unrelated, { recursive: true });
      assert.equal(shouldDeletePluginTree(unrelated, home), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("空输入返回 false", () => {
    assert.equal(shouldDeletePluginTree("", "/tmp"), false);
    assert.equal(shouldDeletePluginTree(null, "/tmp"), false);
    assert.equal(shouldDeletePluginTree(undefined, "/tmp"), false);
  });

  it("路径不存在时按 resolve 判定（不抛）", () => {
    assert.equal(shouldDeletePluginTree("/nonexistent/x/node_modules/dsh-qilin", "/tmp"), true);
  });
});

describe("差分对照：新实现 === dsh-qilin 原实现", () => {
  const qilin = findQilin();

  it("wasApplied 与 stripPluginFromPackage 输出逐一相等", { skip: qilin === null }, async () => {
    const old = (await import(`file://${qilin}/lib/uninstall.js`)) as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    let compared = 0;

    for (const s of [
      null, undefined, {}, { has_backup: true }, { patches_applied: 1 },
      { patches_applied: "0" }, { patches_applied: "3" }, { shim_cmd: "patched" },
      { shim_ps1: "patched" }, { shim_bin: "patched" }, { shim_cmd: "no" },
    ]) {
      assert.deepEqual(wasApplied(s as never), old["wasApplied"]!(s), `wasApplied(${JSON.stringify(s)})`);
      compared += 1;
    }

    const shapes: unknown[] = [
      null, {}, { dependencies: { "dsh-qilin": "1.0.0" } },
      { devDependencies: { "dsh-qilin": "x" } }, { bundles: ["dsh-qilin", "other"] },
      { bundles: ["dsh-qilin@1.2.0"] }, { plugins: [{ id: "dsh-qilin" }] },
      { dsh: { profile: { bundles: ["dsh-qilin"] } } }, { dependencies: { other: "1" } },
    ];
    for (const s of shapes) {
      const a = s === null ? null : JSON.parse(JSON.stringify(s));
      const b = s === null ? null : JSON.parse(JSON.stringify(s));
      const ra = old["stripPluginFromPackage"]!(a);
      const rb = stripPluginFromPackage(b);
      assert.deepEqual(rb, ra, `strip 返回值 ${JSON.stringify(s)}`);
      assert.deepEqual(b, a, `strip 后对象 ${JSON.stringify(s)}`);
      compared += 2;
    }

    assert.ok(compared >= 25, `对比样本过少：${compared}`);
  });
});
