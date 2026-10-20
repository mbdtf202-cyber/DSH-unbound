/**
 * drift 检测：`StoreForTools` 声明的方法必须真实存在于 `RedteamStore` 上。
 *
 * ## 为什么需要这条测试
 *
 * `StoreForTools`（`src/redteam/tools/store-contract.ts`）是手写的窄视图。
 * 手写就有 drift 风险：store 侧改名 / 删方法后，如果没有这条测试，
 * 表现是**运行时** `store.xxx is not a function`，而且会被
 * `withStructuredErrors` 的 catch 吞成一条 `{ok:false}` —— 看起来像"业务失败"。
 *
 * ## 主判据：运行时原型反射（不是文本解析）
 *
 * `interface` / `type` 会被类型擦除，但 **`class` 的方法真实存在于 `prototype` 上**
 * （`Object.getOwnPropertyNames(RedteamStore.prototype)`）。所以这里直接读运行时，
 * 而不是正则扫源码：
 *
 * - 不受写法影响：`method(){}` / `async method(){}` / `get x(){}` / `static` 全覆盖
 * - 不受格式影响：缩进、注释、换行变化都不用改测试
 * - 测的是**真实可调用性**，而不只是"源码文本里有这个名字"
 *
 * ## 正则只负责一件事：探测已知的例外写法
 *
 * 如果 store 改用**箭头函数属性** `method = (x) => ...`，方法会挂在**实例**上、
 * 不在 `prototype` 上，原型反射就看不到它。这种写法当前是 0 处，
 * 但一旦出现，"反射漏检"会静默导致 false negative。
 *
 * 所以额外用一条正则专门找这种写法：**发现就失败**，提示改用原型反射或扩检测。
 * 这样正则从"必须永远正确"降级成"只探测一种已知例外"，脆弱性暴露在出现的那一刻。
 *
 * ## 检查方向是单向的
 *
 * 只断言「`StoreForTools` 声明了，但 `RedteamStore` 上不存在」为空。
 * **不**断言反向（store 有但接口没声明）—— 那正是窄视图的设计。
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/** 从接口源码里抽方法名与可选性。 */
interface DeclaredMethod {
  readonly name: string;
  readonly optional: boolean;
}

/** 读仓库内的源码文件（按 cwd 与 dist-test 相对位置尝试）。 */
function readRepoFile(rel: string): string {
  const candidates = [rel, `../../${rel}`, `../../../${rel}`];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error(`读不到 ${rel}（cwd=${process.cwd()}）`);
}

/**
 * 解析接口体里的方法声明。
 *
 * 这里必须读源码：`StoreForTools` 是 `interface`，运行时被完全擦除，
 * 没有任何反射手段能枚举它的成员。与 store 侧的原型反射正好互补。
 */
function declaredMethodsOf(source: string, interfaceName: string): readonly DeclaredMethod[] {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  assert.notEqual(start, -1, `interface ${interfaceName} 不存在于源码`);
  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      if (depth === 1 && bodyStart === -1) bodyStart = i + 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `${interfaceName} 找不到接口体起点`);
  assert.notEqual(bodyEnd, -1, `${interfaceName} 找不到接口体终点`);
  const body = source.slice(bodyStart, bodyEnd);

  const out: DeclaredMethod[] = [];
  /* 方法签名形如 `  name?(...): X;` —— 只取方法，不取属性（属性没有 `(`） */
  const re = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)(\??)\s*\(/gm;
  for (const m of body.matchAll(re)) {
    const name = m[1];
    if (name === undefined) continue;
    out.push({ name, optional: m[2] === "?" });
  }
  return out;
}

/**
 * 已知尚未在 store 侧落地的方法（**债务清单，不是白名单**）。
 *
 * - 每条必须写明"为什么现在可以缺"
 * - 测试对名单本身也做校验：一旦 store 补上，会因为"名单里有已存在项"而红
 */
const PENDING_IN_STORE: ReadonlyMap<string, string> = new Map([]);

/* ── 运行时原型反射：延迟 import，避免顶层 import 在低版本 Node 上直接炸 ── */

/** Node 最低版本（`node:sqlite` 需要）。 */
const MIN_NODE_MAJOR = 22;

/** 当前 Node 主版本是否满足要求。 */
function nodeVersionOk(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}

/** 动态载入 RedteamStore；失败时返回原因而不是抛。 */
async function loadStoreClass(): Promise<
  { readonly ok: true; readonly names: ReadonlySet<string> } | { readonly ok: false; readonly reason: string }
> {
  if (!nodeVersionOk()) {
    return { ok: false, reason: `Node ${process.versions.node} < ${String(MIN_NODE_MAJOR)}，跳过原型反射` };
  }
  try {
    const mod: unknown = await import("../../src/redteam/store/store.js");
    const rec = mod !== null && typeof mod === "object" ? (mod as Record<string, unknown>) : null;
    const ctor = rec === null ? undefined : rec["RedteamStore"];
    if (typeof ctor !== "function") return { ok: false, reason: "模块里没有 RedteamStore 类" };
    const proto: unknown = (ctor as { prototype?: unknown }).prototype;
    if (proto === null || typeof proto !== "object") return { ok: false, reason: "RedteamStore 没有 prototype" };
    const names = new Set(Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor"));
    return { ok: true, names };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

describe("StoreForTools ↔ RedteamStore drift", () => {
  it("必选方法必须存在（原型反射，已登记 pending 的除外）", async () => {
    const contractSrc = readRepoFile("src/redteam/tools/store-contract.ts");
    const declared = declaredMethodsOf(contractSrc, "StoreForTools");
    assert.equal(declared.length > 0, true, "没解析出任何方法，正则可能已失效");

    const loaded = await loadStoreClass();
    if (!loaded.ok) {
      /* 环境不满足时不能假装通过：明确要求人工确认，而不是静默 skip */
      assert.fail(`无法做原型反射校验：${loaded.reason}。请在 Node >= ${String(MIN_NODE_MAJOR)} 下运行。`);
    }
    const actual = loaded.names;

    const missing = declared
      .filter((d) => !d.optional && !actual.has(d.name) && !PENDING_IN_STORE.has(d.name))
      .map((d) => d.name);
    assert.deepEqual(
      missing,
      [],
      "StoreForTools 声明了但 RedteamStore.prototype 上不存在的方法：" +
        missing.join(", ") +
        "（要么 store 改名了，要么接口写早了 —— 别让它在运行时才炸。"
        + "确认是 W1 未落地的，加进 PENDING_IN_STORE 并写明原因）",
    );
  });

  it("原型反射确实看到了方法（自检：反射不是空集）", async () => {
    const loaded = await loadStoreClass();
    if (!loaded.ok) assert.fail(`无法做原型反射校验：${loaded.reason}`);
    assert.equal(loaded.names.size > 40, true, "原型上方法数过少，反射可能没生效");
    /* 抽两个确定存在的做断言，防止"反射对象搞错了"这类静默失败 */
    assert.equal(loaded.names.has("stats"), true);
    assert.equal(loaded.names.has("listAssets"), true);
  });

  it("store 不使用箭头函数属性写法（否则原型反射会漏检）", () => {
    const storeSrc = readRepoFile("src/redteam/store/store.ts");
    /* 只找类成员位置的 `name = (` / `name = async (`；字段初始化不在 prototype 上 */
    const offenders: string[] = [];
    for (const m of storeSrc.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(/gm)) {
      const n = m[1];
      if (n !== undefined) offenders.push(n);
    }
    assert.deepEqual(
      offenders,
      [],
      "store 里出现箭头函数属性写法：" +
        offenders.join(", ") +
        "。这类成员挂在**实例**上、不在 prototype 上 → 本文件的原型反射会漏检。" +
        "请改用普通方法语法，或扩展 drift 测试的检测手段。",
    );
  });

  it("债务清单不腐烂：登记为 pending 的方法一旦落地就必须移除", async () => {
    const loaded = await loadStoreClass();
    if (!loaded.ok) assert.fail(`无法做原型反射校验：${loaded.reason}`);
    const resolved = [...PENDING_IN_STORE.keys()].filter((n) => loaded.names.has(n));
    assert.deepEqual(
      resolved,
      [],
      "这些方法 store 已经实现了，请从 PENDING_IN_STORE 删除（否则债务清单变成永久豁免）：" + resolved.join(", "),
    );
  });

  it("可选方法允许不存在（设计为可降级）", () => {
    const contractSrc = readRepoFile("src/redteam/tools/store-contract.ts");
    const declared = declaredMethodsOf(contractSrc, "StoreForTools");
    const optional = declared.filter((d) => d.optional);
    assert.equal(declared.length > optional.length, true, "应当至少有一个必选方法");
  });

  it("接口里没有裸 unknown 类型的方法参数（窄接口的意义所在）", () => {
    const contractSrc = readRepoFile("src/redteam/tools/store-contract.ts");
    const start = contractSrc.indexOf("export interface StoreForTools {");
    const body = contractSrc.slice(start);
    /* `payload: Record<string, unknown>` 这类是**数据对象**，不是"参数类型未知"，允许。
       禁止的是直接写成 `x: unknown` 的参数。 */
    const offenders: string[] = [];
    for (const m of body.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??\(([^)]*)\)/gm)) {
      const params = m[2] ?? "";
      for (const raw of params.split(",")) {
        const part = raw.trim();
        if (part === "") continue;
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        if (part.slice(colon + 1).trim() === "unknown") offenders.push(`${m[1] ?? "?"}(${part})`);
      }
    }
    assert.deepEqual(offenders, [], "这些参数是裸 unknown，应当换成具体类型：" + offenders.join(", "));
  });

  it("方法名在接口内不重复（重复声明会被 TS 合并，掩盖笔误）", () => {
    const contractSrc = readRepoFile("src/redteam/tools/store-contract.ts");
    const declared = declaredMethodsOf(contractSrc, "StoreForTools");
    const seen = new Map<string, number>();
    for (const d of declared) seen.set(d.name, (seen.get(d.name) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    assert.deepEqual(dups, [], "重复声明：" + dups.join(", "));
  });
});

/* 原型反射会真的载入 store 模块（含 node:sqlite），跑完主动释放句柄，
   避免测试进程因为残留的数据库连接而不退出。 */
after(() => {
  /* 没有需要显式关闭的句柄：本文件只读 prototype，未实例化 RedteamStore */
});
