/**
 * 靶标元数据（`engagement.yaml`）的读写。
 *
 * 迁移自 dsh-qilin `store-core.js` 里两个模块级函数。**不是真 YAML**：
 * 原实现就是一个"`key: value` + `key: [a, b]`"的极简格式，自己写自己读，
 * 从不交给外部 YAML 解析器。保持等价比引入 yaml 库安全 ——
 * 已有的靶标目录里全是这个格式，换解析器会读不出来。
 *
 * 三个必须保留的行为：
 *   1. 读的时候**剥掉值两端的引号**（`target_name: "某单位"` 与 `target_name: 某单位` 等价）；
 *   2. 数组值的元素也剥引号、去空白、丢空项；
 *   3. 写的时候**数组用 `[a, b]`**、`undefined`/`null` 的键**整行不写**（不是写 `null`）。
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../fs/atomic.js";

/** 元数据（任意 `key: value`，值是字符串或字符串数组）。 */
export type EngagementMeta = Record<string, string | readonly string[]>;

/**
 * 读元数据。文件不存在返回 `undefined`（**不是空对象**）——
 * 调用方靠这个区分"没有元数据"与"元数据是空的"（前者用默认名，后者用 id）。
 */
export function readMeta(path: string): EngagementMeta | undefined {
  if (!existsSync(path)) return undefined;
  const out: Record<string, string | readonly string[]> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m === null || m[1] === undefined) continue;
    const key = m[1];
    const v = (m[2] ?? "").trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      out[key] = v
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      out[key] = v.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

/** 写元数据（原子写：宿主运行中，截断的 yaml 会让该靶标整个读不出来）。 */
export function writeMeta(path: string, meta: EngagementMeta): void {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else if (v !== undefined && v !== null) lines.push(`${k}: ${String(v)}`);
  }
  atomicWriteFileSync(path, lines.join("\n") + "\n", "utf8");
}

/** 从元数据里取字符串字段（非字符串 / 缺失 → fallback）。 */
export function metaString(meta: EngagementMeta | undefined, key: string, fallback: string): string {
  const v = meta === undefined ? undefined : meta[key];
  return typeof v === "string" && v !== "" ? v : fallback;
}

/** 从元数据里取数组字段（缺失 / 非数组 → 空数组）。 */
export function metaList(meta: EngagementMeta | undefined, key: string): readonly string[] {
  const v = meta === undefined ? undefined : meta[key];
  return Array.isArray(v) ? v : [];
}
