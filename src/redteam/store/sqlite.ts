/**
 * `node:sqlite` 的类型化薄包装。
 *
 * ## 为什么需要它
 *
 * `node:sqlite` 官方是 **experimental**，@types/node 里的签名只有一种：
 * `all(): Record<string, SQLOutputValue>[]`。每条查询都要写
 * `const rows = stmt.all() as unknown as AssetRow[]` —— 334 处行访问每处都要断言一次，
 * 断言散落等于没有类型（`as unknown as` 可以断言成任何东西，写错也没人管）。
 *
 * 这里把断言**收敛到一个函数**：`prepare<AssetRow>(sql)`。
 * 调用点写 `db.prepare<AssetRow>("SELECT * FROM asset")`，行类型由泛型决定，
 * 断言只发生在 `all`/`get` 的内部实现里，并带上"为什么可以断言"的说明。
 *
 * ## 边界在哪（必须说清，否则这个包装会给人虚假的安全感）
 *
 * 泛型**不校验 SQL 与类型的对应关系**：`prepare<VulnRow>("SELECT 1")` 编译通过、
 * 运行时拿到一个没有 `id` 的对象。编译器挡不住这种错误，能挡的是"用错列名后的
 * 下游代码"（例如把 `row.severity` 传给一个要求 `Severity` 的函数）。
 * 因此**每张表都要有一条 `SELECT *` 的冒烟测试**（test/store/schema.test.ts），
 * 断言返回行的键集合与 TableRowMap 里的声明一致 —— 那才是真正的核查点。
 *
 * ## 事务
 *
 * `transaction()` 用显式 BEGIN/COMMIT/ROLLBACK：`node:sqlite` 没有 better-sqlite3 的
 * `.transaction()` 包装，原实现也是自己 `db.exec('BEGIN')`。嵌套调用会抛
 * "cannot start a transaction within a transaction"，这里用计数器把嵌套变成幂等
 * （内层不再 BEGIN），与 SQLite 的 SAVEPOINT 语义近似但**不做局部回滚** ——
 * 只在最外层失败时整体回滚，这正是原实现 `importBundle` 需要的行为。
 */
import { DatabaseSync } from "node:sqlite";
import type { StatementResultingChanges } from "node:sqlite";
import type { SqlValue } from "./types.js";

/** 一条预处理语句的类型化视图。 */
export interface TypedStatement<T> {
  /** 全部结果行。 */
  all(...params: readonly SqlValue[]): T[];
  /** 第一行；没有则 undefined。 */
  get(...params: readonly SqlValue[]): T | undefined;
  /** 执行写入，返回改动行数与最后插入 rowid。 */
  run(...params: readonly SqlValue[]): { readonly changes: number; readonly lastInsertRowid: number };
}

/** 类型化数据库句柄。 */
export interface TypedDb {
  prepare<T>(sql: string): TypedStatement<T>;
  exec(sql: string): void;
  close(): void;
  /** 在一个事务里跑 fn；最外层失败时整体回滚并重新抛出。 */
  transaction<R>(fn: () => R): R;
  /** 底层句柄（仅用于 PRAGMA 之类必须拿原始对象的地方）。 */
  readonly raw: DatabaseSync;
}

/**
 * 把驱动返回的 `Record<string, SQLOutputValue>` 断言成行类型。
 *
 * **为什么可以断言**：SQLite 的列在运行时有亲和性（TEXT/INTEGER/REAL/NULL），
 * 而我们的 `XxxRow` 正是按 DDL 逐列写的（见 types.ts）。类型与列一旦不一致，
 * 由 schema.test.ts 的键集合核对兜住，不靠这个断言。
 */
function toRow<T>(row: Record<string, unknown>): T {
  return row as unknown as T;
}

/** 打开一个数据库并返回类型化句柄。 */
export function openTypedDb(path: string): TypedDb {
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    prepare<T>(sql: string): TypedStatement<T> {
      const stmt = db.prepare(sql);
      return {
        all: (...params) => stmt.all(...params).map((r) => toRow<T>(r)),
        get: (...params) => {
          const row = stmt.get(...params);
          return row === undefined ? undefined : toRow<T>(row);
        },
        run: (...params) => {
          const out: StatementResultingChanges = stmt.run(...params);
          /* lastInsertRowid 在 64 位 INTEGER 上可能是 bigint；调用方一律按 number 用
             （id 不可能超过 2^53），这里统一收窄，避免每个调用点各写一遍 Number()。 */
          return { changes: Number(out.changes), lastInsertRowid: Number(out.lastInsertRowid) };
        },
      };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => {
      db.close();
    },
    transaction<R>(fn: () => R): R {
      if (depth > 0) return fn();
      depth += 1;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (cause) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* 事务可能已被 SQLite 自己回滚（例如语句级错误），再 ROLLBACK 会报
             "no transaction is active"。这不该掩盖原始错误。 */
        }
        throw cause;
      } finally {
        depth -= 1;
      }
    },
    raw: db,
  };
}

/**
 * 生成 `?, ?, ?` 占位符串（`IN (...)` 用）。
 *
 * 原实现里有 14 处 `list.map(() => '?').join(',')`，还有一处漏了 `.join`（传了个数组）。
 * 收敛成一个函数，顺带把"空数组"这件事显式化：空 IN 在 SQLite 里是语法错误，
 * 调用方必须先拦空数组——这里直接抛，把运行时错误提前到写错的调用点。
 */
export function placeholders(count: number): string {
  if (count <= 0) throw new Error("placeholders(0)：空 IN (...) 在 SQLite 里是语法错误，调用方必须先拦空数组");
  return new Array(count).fill("?").join(",");
}

/** 把 JS 值收窄成可绑定的 SQL 值（undefined → null，布尔 → 0/1）。 */
export function bind(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value;
  /* 对象/数组不该直接进库：原实现有 3 处把对象塞进 TEXT 列，SQLite 会存成 "[object Object]"。
     这里强制调用方显式 JSON.stringify，避免那种静默损坏。 */
  throw new Error("bind()：只接受标量或 Uint8Array；对象请显式 JSON.stringify");
}
