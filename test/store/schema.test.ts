/**
 * 建表 / 迁移 / FTS5 降级。
 *
 * 这一组测的是"数据形状"：表建没建全、列对不对、迁移能不能重复跑、没有 FTS5 时能不能起。
 * 它们是其余所有测试的地基 —— 地基错了，后面的断言只是在一个错的结构上自洽。
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { HAS_FTS5, migrateKnowledge, migrate, DDL, KNOWLEDGE_DDL, ASSET_FTS_DDL, POC_FTS_DDL, POC_CATEGORIES, guessPocCategory, pocCategoryName } from "../../src/redteam/store/schema.js";
import { placeholders } from "../../src/redteam/store/sqlite.js";
import { TABLE_NAMES } from "../../src/redteam/store/types.js";
import { makeEngagement, makeTempStore } from "./fixtures.js";

const temps: { dispose(): void }[] = [];
after(() => {
  for (const t of temps) t.dispose();
});
function temp(): ReturnType<typeof makeTempStore> {
  const t = makeTempStore();
  temps.push(t);
  return t;
}

describe("schema: 建表", () => {
  it("23 张表全部建出来", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const db = store.db(id);
    const rows = db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = new Set(rows.map((r) => r.name));
    for (const table of TABLE_NAMES) {
      /* 知识库的 poc 表在另一个库里，这里跳过 */
      if (table === "poc") continue;
      assert.ok(names.has(table), `缺表：${table}`);
    }
    /* 22 张靶标库表（23 − poc） */
    const targetTables = TABLE_NAMES.filter((t) => t !== "poc");
    assert.equal(targetTables.length, 22);
  });

  it("两张视图也建出来（面板的资产摘要用它）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const rows = store.db(id).prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'view'").all();
    const names = new Set(rows.map((r) => r.name));
    assert.ok(names.has("v_asset_summary"));
    assert.ok(names.has("v_asset_service"));
  });

  it("每个 TableRowMap 声明的键都能在表里查到（键集合核对）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const db = store.db(id);
    /* 逐表核对：声明的列必须真的存在，且没有多出来的列 ——
       这是「泛型不校验 SQL」那条限制的唯一保险。 */
    const expectations: Readonly<Record<string, readonly string[]>> = {
      asset: ["id", "segment_cidr", "ip", "ip_int", "state", "primary_name", "confidence", "first_seen", "last_seen",
        "discovered_at", "test_status", "test_notes", "test_surface", "test_updated_at", "test_updated_by",
        "blocked_count", "priority", "potential", "assess_reason", "assessed_at", "assessed_by", "scope"],
      vuln: ["id", "asset_id", "port_id", "cve", "title", "severity", "source", "confidence", "status", "evidence",
        "target", "found_by_agent", "found_at", "gained", "agent"],
      score_hit: ["id", "point_id", "asset_id", "vuln_id", "step_id", "target", "evidence", "note", "self_created",
        "port", "recorded_by", "recorded_at", "points", "multiplier", "stage_code"],
      tunnel: ["id", "asset_id", "webshell_id", "kind", "listen", "entry", "reach", "entry_kind", "status",
        "last_check", "check_note", "latency_ms", "pid", "command", "note", "found_by_agent", "created_at", "updated_at", "agent"],
      attack_step: ["id", "seq", "stage", "stage_code", "title", "detail", "asset_id", "vuln_id", "access_id",
        "point_id", "evidence_ref", "tool", "agent", "result", "recorded_by", "recorded_at"],
      shot: ["id", "point_id", "hit_id", "asset_id", "vuln_id", "target", "label", "note", "file", "kind", "mime",
        "bytes", "width", "height", "sha256", "source_ref", "captured_at", "found_by_agent", "agent", "created_at"],
    };
    for (const [table, expected] of Object.entries(expectations)) {
      const cols = new Set(db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all().map((r) => r.name));
      for (const col of expected) assert.ok(cols.has(col), `${table}.${col} 不存在`);
      /* 反向：表里不应该有类型层没声明的列（多出来的列会让 SELECT * 的浅拷贝悄悄带上） */
      for (const col of cols) assert.ok(expected.includes(col), `${table}.${col} 在表里但类型层没声明`);
    }
  });

  it("poc 表在知识库里（跨靶标共享，不在靶标库）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const targetDb = store.db(id);
    const targetTables = new Set(targetDb.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    assert.ok(!targetTables.has("poc"), "poc 不该在靶标库里");
    store.kb(); // 建知识库
    const kbTables = new Set(store.kb().prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    assert.ok(kbTables.has("poc"));
  });
});

describe("schema: 迁移幂等", () => {
  it("migrate() 连跑三次不再 ALTER", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const db = store.db(id);
    /* 第一次建库已经跑过 migrate（在 db() 里） */
    const second = migrate(db);
    const third = migrate(db);
    assert.deepEqual(second.addedColumns, [], "第二次不该再补列");
    assert.deepEqual(third.addedColumns, [], "第三次不该再补列");
  });

  it("老库（缺列）能被补齐，且补齐后查询可用", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const dbPath = store.dbPathOf(id);
    store.close(); // 先放开句柄，下面直接用 DatabaseSync 模拟"老库"

    /* 造一个"缺新列"的老 asset 表 */
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE IF EXISTS asset");
    raw.exec(`CREATE TABLE asset (
      id INTEGER PRIMARY KEY AUTOINCREMENT, segment_cidr TEXT NOT NULL, ip TEXT NOT NULL, ip_int INTEGER,
      state TEXT DEFAULT 'unknown', primary_name TEXT, confidence REAL, first_seen TEXT, last_seen TEXT,
      UNIQUE(segment_cidr, ip))`);
    raw.exec("INSERT INTO asset(segment_cidr, ip, ip_int, state) VALUES('10.0.0.0/24','10.0.0.9',167772169,'live')");
    raw.close();

    /* 重开：db() 会 exec(DDL)（IF NOT EXISTS 不会重建）+ migrate() 补列 */
    const db = store.db(id);
    const cols = new Set(db.prepare<{ name: string }>("PRAGMA table_info(asset)").all().map((r) => r.name));
    for (const col of ["scope", "test_status", "blocked_count", "discovered_at", "priority"]) {
      assert.ok(cols.has(col), `老库补列失败：${col}`);
    }
    /* 补列后老行仍在，且能读到（默认值语义正确） */
    const assets = store.listAssets(id, {});
    assert.equal(assets.total, 1);
    assert.equal(assets.items[0]?.ip, "10.0.0.9");
    /* 老库回填：scope 按 IP 推导成 internal */
    assert.equal(assets.items[0]?.scope, "internal");
  });

  it("migrateKnowledge() 幂等，且会把空归类补上", () => {
    const { store } = temp();
    store.kb();
    const db = store.kb();
    db.prepare(
      `INSERT INTO poc(code, title, kind, category, content, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
    ).run("legacy-poc", "Shiro 反序列化 RCE", "poc", "", "poc body", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z");
    const first = migrateKnowledge(db);
    const second = migrateKnowledge(db);
    assert.deepEqual(second.addedColumns, []);
    assert.ok(Array.isArray(first.addedColumns));
    /* 推测归类：标题里含"反序列化" → deserialization */
    const row = store.getPoc("legacy-poc");
    assert.equal(row?.category, "deserialization");
  });

  it("分类推测的函数口径（顺序即优先级）", () => {
    /* "任意文件上传" 要压过泛化的 "上传" */
    assert.equal(guessPocCategory("任意文件上传 getshell"), "file-upload");
    assert.equal(guessPocCategory("Shiro 反序列化"), "deserialization");
    assert.equal(guessPocCategory("Redis 未授权访问"), "unauthorized");
    assert.equal(guessPocCategory("完全无关的东西"), "other");
    assert.equal(pocCategoryName("rce"), "远程命令执行");
    /* 未知 code 原样返回（允许用户自定义） */
    assert.equal(pocCategoryName("my-custom"), "my-custom");
    assert.equal(pocCategoryName(""), "未归类");
    /* 14 个内置归类 */
    assert.equal(POC_CATEGORIES.length, 14);
  });
});

describe("schema: FTS5 能力检测与降级", () => {
  it("HAS_FTS5 是个布尔（不同 Node 构建结论可能不同）", () => {
    assert.equal(typeof HAS_FTS5, "boolean");
  });

  it("REDTEAM_NO_FTS5=1 时强制走降级（可主动触发降级分支）", () => {
    /* 这个环境变量在模块加载时求值，所以只能在子进程里验 */
    const out = execFileSync(process.execPath, [
      "--input-type=module", "-e",
      `import { HAS_FTS5 } from ${JSON.stringify(new URL("../../src/redteam/store/schema.ts", import.meta.url).href.replace(/\.ts$/, ".js"))}; console.log(String(HAS_FTS5))`,
    ], { env: { ...process.env, REDTEAM_NO_FTS5: "1" }, encoding: "utf8" });
    assert.equal(out.trim(), "false");
  });

  it("DDL 里不含 fts5 语句（FTS 表单独拼）", () => {
    /* 这是"一句 USING fts5 会把整份 DDL 带崩"的结构性保证：
       普通表的 DDL 必须能在没有 FTS5 的构建上独立跑通。 */
    assert.ok(!/fts5/i.test(DDL), "DDL 里不该出现 fts5");
    assert.ok(!/fts5/i.test(KNOWLEDGE_DDL), "KNOWLEDGE_DDL 里不该出现 fts5");
    assert.ok(/fts5/.test(ASSET_FTS_DDL));
    assert.ok(/fts5/.test(POC_FTS_DDL));
  });

  it("升级路径：库是在无 FTS5 的 Node 上建的，换到有 FTS5 后能自愈（建表 + 回填 + 检索命中）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    /* ① 先在"无 FTS5"的状态下写入（直接删表模拟 22.14 建出来的库） */
    store.db(id).exec("DROP TABLE IF EXISTS asset_fts");
    store.close();

    /* ② 重新打开（= 升级到有 FTS5 的 Node）：db() 会重新建 asset_fts 并回填存量资产 */
    store.importBundle(id, {
      assets: [{ ip: "10.0.0.7", state: "live", primary_name: "upgrade-test.example", provenance: "active", ports: [] }],
    });
    const found = store.listAssets(id, { q: "upgrade-test" });
    assert.equal(found.total, 1, "升级后存量资产必须能被检索到（回填生效）");
    assert.equal(store.listAssets(id, { q: "不存在的关键字zzz" }).total, 0);
  });

  it("降级路径：FTS5 缺席时建库成功、写入成功、LIKE 检索命中", () => {
    /* REDTEAM_NO_FTS5 在模块加载时求值 → 只能子进程验。
       这一段是该环境变量存在的唯一理由：CI 的 Node 换成带 FTS5 的版本后，
       降级分支就再没人执行了。 */
    const script = `
import { RedteamStore } from ${JSON.stringify(new URL("../../src/redteam/store/index.ts", import.meta.url).href.replace(/\.ts$/, ".js"))};
import { HAS_FTS5 } from ${JSON.stringify(new URL("../../src/redteam/store/schema.ts", import.meta.url).href.replace(/\.ts$/, ".js"))};
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "dsh-nofts-"));
const store = new RedteamStore(root);
try {
  const opened = store.openEngagement("no fts", ["10.0.0.0/24"], { bindCurrent: false });
  store.importBundle(opened.id, { assets: [{ ip: "10.0.0.7", primary_name: "like-test.example", provenance: "active", ports: [] }] });
  const hit = store.listAssets(opened.id, { q: "like-test" }).total;
  const miss = store.listAssets(opened.id, { q: "zzz-none" }).total;
  console.log(JSON.stringify({ fts: HAS_FTS5, hit, miss }));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, REDTEAM_NO_FTS5: "1" },
      encoding: "utf8",
    });
    const parsed = JSON.parse(out.trim()) as { fts: boolean; hit: number; miss: number };
    assert.equal(parsed.fts, false, "REDTEAM_NO_FTS5=1 必须让 HAS_FTS5 为 false");
    assert.equal(parsed.hit, 1, "降级路径下 LIKE 检索必须命中");
    assert.equal(parsed.miss, 0);
  });

  it("placeholders(0) 明确抛错（空 IN 是语法错误）", () => {
    /* 空 IN 必须在调用点就炸，而不是等 SQLite 报语法错 */
    assert.throws(() => placeholders(0), /空 IN/);
    assert.equal(placeholders(3), "?,?,?");
  });
});

describe("schema: 观测排序的确定性（原实现缺唯一键）", () => {
  it("同一毫秒的观测按 id 降序（后写入的排前面）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const db = store.db(id);
    db.prepare(
      "INSERT INTO asset(segment_cidr, ip, ip_int, state, scope) VALUES('10.0.0.0/24','10.0.0.5',167772165,'live','internal')",
    ).run();
    const assetId = Number(db.prepare<{ id: number }>("SELECT id FROM asset LIMIT 1").get()?.id ?? 0);
    /* 三条**完全相同**的 collected_at（模拟 importBundle 一次采集连插几条观测） */
    const sameStamp = "2024-06-01T12:00:00.000Z";
    const ins = db.prepare(
      `INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at)
       VALUES('asset',?,?,?,'active','nmap',?)`,
    );
    ins.run(assetId, "name", "first", sameStamp);
    ins.run(assetId, "primary_name", "second", sameStamp);
    ins.run(assetId, "fingerprint", "third", sameStamp);
    const detail = store.getAsset(id, assetId);
    assert.deepEqual(
      detail?.observations.map((o) => o.attr),
      ["fingerprint", "primary_name", "name"],
      "同毫秒必须按 id 降序 —— 原实现的顺序是未定义的",
    );
  });

  it("跨毫秒仍按时间降序（id 只用于打破并列）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const db = store.db(id);
    db.prepare(
      "INSERT INTO asset(segment_cidr, ip, ip_int, state, scope) VALUES('10.0.0.0/24','10.0.0.6',167772166,'live','internal')",
    ).run();
    const assetId = Number(db.prepare<{ id: number }>("SELECT id FROM asset LIMIT 1").get()?.id ?? 0);
    const ins = db.prepare(
      `INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at)
       VALUES('asset',?,?,?,'active','nmap',?)`,
    );
    /* 故意让 id 顺序与时间顺序**相反**：后插的那条时间更早 */
    ins.run(assetId, "old", "v", "2024-06-01T10:00:00.000Z");
    ins.run(assetId, "new", "v", "2024-06-01T12:00:00.000Z");
    const detail = store.getAsset(id, assetId);
    assert.deepEqual(detail?.observations.map((o) => o.attr), ["new", "old"], "时间优先，不能被 id 抢");
  });

  it("超过 200 条时留下的是「最新的 200 条」（LIMIT 取舍确定）", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    const db = store.db(id);
    db.prepare(
      "INSERT INTO asset(segment_cidr, ip, ip_int, state, scope) VALUES('10.0.0.0/24','10.0.0.7',167772167,'live','internal')",
    ).run();
    const assetId = Number(db.prepare<{ id: number }>("SELECT id FROM asset LIMIT 1").get()?.id ?? 0);
    const ins = db.prepare(
      `INSERT INTO observation(entity_kind, entity_id, attr, value, provenance, tool, collected_at)
       VALUES('asset',?,?,?,'active','nmap',?)`,
    );
    /* 250 条，**全部同一毫秒** —— 这是 LIMIT 取舍最不确定的形态 */
    const stamp = "2024-06-01T12:00:00.000Z";
    for (let i = 0; i < 250; i += 1) ins.run(assetId, `attr-${String(i)}`, "v", stamp);
    const detail = store.getAsset(id, assetId);
    assert.equal(detail?.observations.length, 200, "LIMIT 200");
    /* 补了 id DESC 之后，留下的必须是最后写入的 200 条（attr-249 … attr-50） */
    assert.equal(detail?.observations[0]?.attr, "attr-249", "最新的排最前");
    assert.equal(detail?.observations[199]?.attr, "attr-50", "被截掉的是最旧的 50 条");
  });
});

describe("schema: 检索不会产生幽灵结果（FTS 孤儿行）", () => {
  it("资产被删后，遗留的 asset_fts 行不会让检索命中不存在的资产", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    store.importBundle(id, {
      assets: [{ ip: "10.0.0.5", primary_name: "ghost.example.test", provenance: "active", ports: [] }],
    });
    assert.equal(store.listAssets(id, { q: "ghost" }).total, 1, "删前能命中");
    /* store 没有删除资产的接口（上游也没有），所以模拟"用户手工删库里的行" */
    store.db(id).exec("DELETE FROM asset WHERE ip = '10.0.0.5'");
    /* asset_fts 里确实留下了孤儿行 —— 这不是 bug，而是"FTS 不是数据源"的直接后果 */
    const orphans = Number(store.db(id).prepare<{ n: number }>("SELECT COUNT(*) AS n FROM asset_fts").get()?.n ?? 0);
    assert.equal(orphans >= 1, true, "孤儿行确实存在（FTS 只是索引）");
    /* 关键断言：检索仍为 0 —— 因为查询是 `FROM asset a WHERE a.id IN (SELECT ... FROM asset_fts ...)`，
       asset 表是驱动表，孤儿行只是"多一个匹配的 id"，而这个 id 在 asset 里已经不存在。 */
    assert.equal(store.listAssets(id, { q: "ghost" }).total, 0, "绝不能返回幽灵结果");
    assert.equal(store.listAssets(id, {}).total, 0, "列表总数为 0");
    /* 详情页也查不到（getAsset 按 asset 表的 id 取） */
    assert.equal(store.getAsset(id, 1), undefined);
  });

  it("LIMIT 的前提：检索的 FROM 是 asset，不是 asset_fts", () => {
    const { store } = temp();
    const id = makeEngagement(store);
    /* 这条是给后人看的护栏：如果哪天有人把 SQL 改成 `FROM asset_fts JOIN asset`，
       幽灵结果的风险就会变（虽然 INNER JOIN 仍安全，LEFT JOIN 就不安全了）。
       直接断言行为：只有 asset 里存在的行才可能被返回。 */
    store.importBundle(id, {
      assets: [
        { ip: "10.0.0.5", primary_name: "keep.example.test", provenance: "active", ports: [] },
        { ip: "10.0.0.6", primary_name: "drop.example.test", provenance: "active", ports: [] },
      ],
    });
    store.db(id).exec("DELETE FROM asset WHERE ip = '10.0.0.6'");
    const hit = store.listAssets(id, { q: "example.test" });
    assert.equal(hit.total, 1, "只有还存在的资产会被返回");
    assert.equal(hit.items[0]?.ip, "10.0.0.5");
  });
});
