/**
 * 各表 CRUD 与"入参语义"。
 *
 * 这组测两件事：
 *   1. **每类实体能写能读**（建 → 读 → 改 → 再读）；
 *   2. **`undefined` / 空串 / 缺字段的落库结果**与上游一致 ——
 *      这是最容易静默漂移的一类：`undefined` 在 `node:sqlite` 里会**直接抛**，
 *      空串则会被存成 `''` 而不是 `NULL`，两者在 `COALESCE(...) <> ''` 之类
 *      的条件里行为完全不同。
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { makeEngagement, makeTempStore, sampleBundle, TINY_PNG_BASE64 } from "./fixtures.js";

const temps: { dispose(): void }[] = [];
after(() => {
  for (const t of temps) t.dispose();
});
function setup(): { store: ReturnType<typeof makeTempStore>["store"]; id: string } {
  const t = makeTempStore();
  temps.push(t);
  const id = makeEngagement(t.store);
  return { store: t.store, id };
}

describe("crud: importBundle（采集入库）", () => {
  it("完整 bundle：段/资产/端口/服务/域名/指纹/边全部落库，计数对得上", () => {
    const { store, id } = setup();
    const result = store.importBundle(id, sampleBundle());
    assert.deepEqual(result.counts, {
      segments: 1, assets: 1, ports: 2, services: 2, fingerprints: 1, names: 1, edges: 1,
    });
    assert.ok(result.scan_run_id !== null);
    const stats = store.stats(id);
    assert.equal(stats.assets, 1);
    assert.equal(stats.openPorts, 2);
    assert.equal(stats.services, 2);
    assert.equal(stats.fingerprints, 1);
  });

  it("幂等：同一 bundle 导入两次不产生重复资产/端口", () => {
    const { store, id } = setup();
    store.importBundle(id, sampleBundle());
    const second = store.importBundle(id, sampleBundle());
    assert.equal(second.stats.assets, 1, "资产不该翻倍");
    assert.equal(second.stats.openPorts, 2, "端口不该翻倍");
    assert.equal(second.stats.services, 4, "服务是按次追加的（上游就是这样：service 表无唯一约束）");
  });

  it("discovered_at 不随重复采集刷新（发现时间只记第一次）", () => {
    const { store, id } = setup();
    store.importBundle(id, { assets: [{ ip: "10.0.0.11", provenance: "active", ports: [] }] });
    const first = store.listAssets(id, {}).items[0]?.discovered_at;
    assert.ok(first !== undefined && first !== null && first !== "");
    /* 第二次采集（间隔靠数据区分，不靠 sleep） */
    store.importBundle(id, { assets: [{ ip: "10.0.0.11", state: "live", provenance: "active", ports: [] }] });
    const second = store.listAssets(id, {}).items[0];
    assert.equal(second?.discovered_at, first, "discovered_at 不能被刷成最后一次采集时间");
    assert.equal(second?.state, "live", "其余字段该刷新");
  });

  it("事务：assets 中途抛错 → 整份回滚（段也不该留下）", () => {
    const { store, id } = setup();
    const before = store.stats(id);
    /* 第二个资产的 ports 是字符串 → Number("not-a-port") = NaN → SQLite 会抛 */
    const bundle = {
      segments: [{ cidr: "10.9.0.0/24" }],
      assets: [
        { ip: "10.9.0.1", provenance: "active", ports: [] },
        { ip: "10.9.0.2", provenance: "active", ports: [{ port: "not-a-port" }] },
      ],
    };
    assert.throws(() => store.importBundle(id, bundle));
    const afterStats = store.stats(id);
    assert.equal(afterStats.assets, before.assets, "事务必须回滚：资产数不变");
    assert.equal(afterStats.segments, before.segments, "事务必须回滚：段数不变");
  });
});

describe("crud: 资产查询与筛选", () => {
  function seed(): { store: ReturnType<typeof makeTempStore>["store"]; id: string } {
    const { store, id } = setup();
    store.importBundle(id, {
      assets: [
        { ip: "10.0.0.5", state: "live", primary_name: "portal.example.test", provenance: "active", ports: [{ port: 8080, state: "open", service: "http", title: "门户", provenance: "active" }] },
        { ip: "10.0.0.6", state: "live", primary_name: "mail.example.test", provenance: "passive", ports: [{ port: 443, state: "open", service: "https", provenance: "passive" }] },
        { ip: "10.0.1.7", state: "down", provenance: "active", ports: [] },
      ],
    });
    return { store, id };
  }

  it("按 C 段 / 状态 / IP 筛选", () => {
    const { store, id } = seed();
    assert.equal(store.listAssets(id, { cidr: "10.0.0.0/24" }).total, 2);
    assert.equal(store.listAssets(id, { state: "live" }).total, 2);
    assert.equal(store.listAssets(id, { ip: "10.0.1.7" }).total, 1);
  });

  it("按端口 / 服务 / 来源筛选（EXISTS 子查询）", () => {
    const { store, id } = seed();
    assert.equal(store.listAssets(id, { port: 8080 }).total, 1);
    assert.equal(store.listAssets(id, { provenance: "passive" }).total, 1);
    /* ⚠️ service 筛选用的是 `s.name LIKE '%http%' OR s.product LIKE '%http%'`，
       所以 `service=http` 会**同时命中 https**（2 台）。
       这是上游行为（实测 dsh-qilin 同样返回 2），不是缺陷 ——
       它的用途是"模糊找 HTTP 面"，精确筛服务请用 port。 */
    assert.equal(store.listAssets(id, { service: "http" }).total, 2, "LIKE %http% 会一并命中 https（上游口径）");
    assert.equal(store.listAssets(id, { service: "https" }).total, 1);
  });

  it("全文检索能命中主域名（FTS 索引里没有 primary_name，靠 LIKE 兜）", () => {
    const { store, id } = seed();
    const hit = store.listAssets(id, { q: "portal.example.test" });
    assert.equal(hit.total, 1, "主域名必须能搜到 —— FTS 的 asset_fts 里只有 ip/names/banners/titles/fingerprints");
  });

  it("test_status 支持多值（逗号分隔）", () => {
    const { store, id } = seed();
    store.updateAssetTest(id, { ip: "10.0.0.5", status: "tested" });
    store.updateAssetTest(id, { ip: "10.0.0.6", status: "blocked" });
    assert.equal(store.listAssets(id, { test_status: "tested,blocked" }).total, 2);
    assert.equal(store.listAssets(id, { test_status: "tested" }).total, 1);
  });

  it("排序口径：priority 把 high 排前面、todo 把未测排前面", () => {
    const { store, id } = setup();
    store.importBundle(id, {
      assets: [
        { ip: "10.0.0.1", provenance: "active", ports: [] },
        { ip: "10.0.0.2", provenance: "active", ports: [] },
        { ip: "10.0.0.3", provenance: "active", ports: [] },
      ],
    });
    store.assessAsset(id, { ip: "10.0.0.3", priority: "high", potential: "服务器权限" });
    store.assessAsset(id, { ip: "10.0.0.1", priority: "low", potential: "无" });
    const byPriority = store.listAssets(id, { sort: "priority" });
    assert.equal(byPriority.items[0]?.ip, "10.0.0.3", "high 必须在最前");
    assert.equal(byPriority.sort, "priority");
    /* todo：已测的沉底 */
    store.updateAssetTest(id, { ip: "10.0.0.3", status: "tested" });
    const todo = store.listAssets(id, { sort: "todo" });
    assert.notEqual(todo.items[0]?.ip, "10.0.0.3", "已测的应该沉底");
  });

  it("分页：total 是命中总数而不是本页条数", () => {
    const { store, id } = setup();
    const assets = Array.from({ length: 5 }, (_, i) => ({ ip: `10.0.2.${String(i + 1)}`, provenance: "active", ports: [] }));
    store.importBundle(id, { assets });
    const page = store.listAssets(id, { limit: 2, offset: 2 });
    assert.equal(page.total, 5);
    assert.equal(page.items.length, 2);
  });

  it("assetChildren 一次预取（N+1 不再发生）", () => {
    const { store, id } = seed();
    const rows = store.listAssets(id, {});
    const db = store.db(id);
    const children = store.assetChildren(db, rows.items.map((r) => r.id));
    assert.equal(children.ports.size, 2, "有两台资产带端口");
    assert.ok((children.ports.get(rows.items.find((r) => r.ip === "10.0.0.5")?.id ?? -1)?.length ?? 0) === 1);
  });
});

describe("crud: 漏洞 / 凭据 / 访问", () => {
  it("addVuln 幂等键：带 cve 时按 (asset_id, cve, target) 更新", () => {
    const { store, id } = setup();
    const first = store.addVuln(id, { title: "Shiro RCE", cve: "CVE-2016-4437", severity: "critical", target: "http://10.0.0.5:8080/" });
    assert.equal(first.updated, false);
    const second = store.addVuln(id, { title: "Shiro RCE (确认)", cve: "CVE-2016-4437", severity: "critical", status: "confirmed", target: "http://10.0.0.5:8080/" });
    assert.equal(second.updated, true, "同 cve + 同 target 必须走更新");
    assert.equal(second.id, first.id);
    assert.equal(store.listVulns(id, {}).total, 1);
  });

  it("addVuln 不带 cve 时按 (asset_id, title, target) 幂等", () => {
    const { store, id } = setup();
    store.addVuln(id, { title: "未授权访问", target: "10.0.0.5" });
    const again = store.addVuln(id, { title: "未授权访问", target: "10.0.0.5" });
    assert.equal(again.updated, true);
    assert.equal(store.listVulns(id, {}).total, 1);
  });

  it("非法 severity / status 回落到 info / candidate（不抛错）", () => {
    const { store, id } = setup();
    store.addVuln(id, { title: "测试", severity: "超级严重", status: "也许" });
    const v = store.listVulns(id, {}).items[0];
    assert.equal(v?.severity, "info");
    assert.equal(v?.status, "candidate");
  });

  it("gained 归一：数组 / 分隔串 → 「A、B」；null → NULL", () => {
    const { store, id } = setup();
    store.addVuln(id, { title: "a", gained: ["账号权限", "服务器权限"] });
    store.addVuln(id, { title: "b", gained: "账号权限;服务器权限" });
    store.addVuln(id, { title: "c", gained: null });
    const items = store.listVulns(id, {}).items;
    const byTitle = new Map(items.map((v) => [v.title, v.gained]));
    assert.equal(byTitle.get("a"), "账号权限、服务器权限");
    assert.equal(byTitle.get("b"), "账号权限、服务器权限");
    assert.equal(byTitle.get("c"), null);
  });

  it("凭据：secret_value 直存明文，别名 password 也能进", () => {
    const { store, id } = setup();
    store.addCredential(id, { host: "10.0.0.5", username: "root", password: "P@ssw0rd" });
    const creds = store.listCredentials(id, {});
    assert.equal(creds.length, 1);
    assert.equal(creds[0]?.secret_value, "P@ssw0rd");
    assert.equal(creds[0]?.secret_type, "password", "secret_type 默认 password");
  });

  it("凭据：同 (host, username, secret_type) 走 COALESCE 合并，不覆盖已有值", () => {
    const { store, id } = setup();
    store.addCredential(id, { host: "10.0.0.5", username: "root", secret_type: "password", secret_value: "first", privilege: "admin" });
    store.addCredential(id, { host: "10.0.0.5", username: "root", secret_type: "password", note: "补充备注" });
    const creds = store.listCredentials(id, {});
    assert.equal(creds.length, 1, "同键不该产生第二条");
    assert.equal(creds[0]?.secret_value, "first", "没给新值时不该被 NULL 覆盖");
    assert.equal(creds[0]?.note, "补充备注");
    assert.equal(creds[0]?.privilege, "admin");
  });

  it("缺 host 抛错（含中文说明）", () => {
    const { store, id } = setup();
    assert.throws(() => store.addCredential(id, { username: "root" }), /credential\.host required/);
    assert.throws(() => store.addAccess(id, { username: "root" }), /access\.host required/);
  });
});

describe("crud: WebShell 与隧道", () => {
  it("WebShell：同 url+pass_key 走更新，其它字段 COALESCE 保留", () => {
    const { store, id } = setup();
    const first = store.addWebshell(id, { url: "http://10.0.0.5/shell.jsp", shell_type: "冰蝎", pass_key: "k1", privilege: "root" });
    assert.equal(first.updated, false);
    const second = store.addWebshell(id, { url: "http://10.0.0.5/shell.jsp", pass_key: "k1", note: "已实测可连" });
    assert.equal(second.updated, true);
    const shells = store.listWebshells(id, {});
    assert.equal(shells.length, 1);
    assert.equal(shells[0]?.shell_type, "behinder", "中文别名要规范化成 beholder");
    assert.equal(shells[0]?.privilege, "root", "没给新值不该被覆盖");
  });

  it("WebShell：非法 shell_type 抛错并给出交付要求", () => {
    const { store, id } = setup();
    assert.throws(
      () => store.addWebshell(id, { url: "http://x/s.jsp", shell_type: "一句话木马" }),
      /shell_type 非法.*冰蝎马/,
    );
  });

  it("WebShell status 别名：up→online、failed→offline、空→online", () => {
    const { store, id } = setup();
    store.addWebshell(id, { url: "http://a/1.jsp", status: "up" });
    store.addWebshell(id, { url: "http://a/2.jsp", status: "failed" });
    store.addWebshell(id, { url: "http://a/3.jsp" });
    const byUrl = new Map(store.listWebshells(id, {}).map((s) => [s.url, s.status]));
    assert.equal(byUrl.get("http://a/1.jsp"), "online");
    assert.equal(byUrl.get("http://a/2.jsp"), "offline");
    assert.equal(byUrl.get("http://a/3.jsp"), "online");
  });

  it("updateWebshell 走同一套规范化（更新路径不能绕过校验）", () => {
    const { store, id } = setup();
    const { id: wsId } = store.addWebshell(id, { url: "http://a/1.jsp" });
    assert.throws(() => store.updateWebshell(id, wsId, { shell_type: "乱写" }), /shell_type 非法/);
    store.updateWebshell(id, wsId, { shell_type: "哥斯拉", status: "down" });
    const shell = store.listWebshells(id, {})[0];
    assert.equal(shell?.shell_type, "godzilla");
    assert.equal(shell?.status, "offline");
  });

  it("隧道：entry_kind 决定 legit（self-only 不算突破、空值待确认）", () => {
    const { store, id } = setup();
    const ok = store.addTunnel(id, { kind: "suo5", listen: "127.0.0.1:1080", entry_kind: "target-http" });
    assert.equal(ok.legit, true);
    assert.equal(ok.warning, undefined);
    const selfOnly = store.addTunnel(id, { kind: "socks5", listen: "127.0.0.1:1081", entry_kind: "self-only" });
    assert.equal(selfOnly.legit, false);
    assert.match(String(selfOnly.warning), /不算隧道/);
    const unknown = store.addTunnel(id, { kind: "frp", listen: "127.0.0.1:1082" });
    assert.equal(unknown.legit, null, "没填 → null（待确认），不能当成 false");
    assert.match(String(unknown.warning), /建议补 entry_kind/);
  });

  it("隧道：entry_kind 先 trim 再校验（尾随空格合法、真乱写才抛）", () => {
    const { store, id } = setup();
    /* 上游 `String(t.entry_kind).trim()` —— 尾随空格被吃掉后就是合法值（实测确认） */
    const trimmed = store.addTunnel(id, { kind: "suo5", entry_kind: "target-http " });
    assert.equal(trimmed.entry_kind, "target-http");
    assert.equal(trimmed.legit, true);
    /* 真正认不出的值必须抛：静默存 NULL 会让 `legit=null`（"待确认"）与"没填"无法区分 */
    assert.throws(() => store.addTunnel(id, { entry_kind: "随便写" }), /entry_kind 非法/);
  });

  it("隧道：update 路径同样校验 entry_kind / status", () => {
    const { store, id } = setup();
    const { id: tId } = store.addTunnel(id, { kind: "suo5", entry_kind: "target-http" });
    assert.throws(() => store.updateTunnel(id, tId, { entry_kind: "乱写" }), /entry_kind 非法/);
    assert.throws(() => store.updateTunnel(id, tId, { status: "乱写" }), /tunnel status 非法/);
    store.updateTunnel(id, tId, { status: "down", entry_kind: "self-only" });
    const t = store.listTunnels(id, {})[0];
    assert.equal(t?.status, "down");
    assert.equal(t?.legit, false, "更新后 legit 判定必须跟着变");
  });

  it("隧道列表带 legit 与可读标签", () => {
    const { store, id } = setup();
    store.addTunnel(id, { kind: "suo5", entry_kind: "target-outbound" });
    const t = store.listTunnels(id, {})[0];
    assert.equal(t?.legit, true);
    assert.match(String(t?.entry_kind_label), /目标主动连出/);
  });
});

describe("crud: 攻击步骤与原始请求", () => {
  it("addChainStep：seq 自增、stage 兜底映射", () => {
    const { store, id } = setup();
    const s1 = store.addChainStep(id, { title: "扫描", stage: "recon" });
    const s2 = store.addChainStep(id, { title: "打点", stage: "exploit" });
    assert.equal(s1.seq, 1);
    assert.equal(s2.seq, 2);
    assert.equal(s1.stage_code, "recon");
    assert.equal(s2.stage_code, "internet", "老的 exploit 要映射到 internet");
  });

  it("addChainStep：非法 stage_code 被忽略并显式告警（步骤仍落库）", () => {
    const { store, id } = setup();
    const s = store.addChainStep(id, { title: "x", stage: "pivot", stage_code: "tunnel" });
    assert.equal(s.stage_code, "boundary", "退回按 stage 兜底");
    assert.match(String(s.stage_hint), /无效的 stage_code/);
    assert.equal(store.listChain(id).length, 1, "步骤仍需入库");
  });

  it("addChainStep 带 point_code + evidence → 顺手记分并回挂 step_id", () => {
    const { store, id } = setup();
    const step = store.addChainStep(id, {
      title: "拿下域控", stage: "internal", point_code: "central-system",
      evidence: "10.0.0.5｜域管理员 administrator", self_created: false,
    });
    assert.ok(step.hit !== null);
    /* 得分点 name 是规则文档里的全名（不是短名 —— 短名在 POINT_SHORT_NAME 里，
       只有报告正文用） */
    assert.match(String(step.hit?.point), /^集权系统/);
    const board = store.listScorePoints(id);
    const hit = board.items.flatMap((p) => p.hits).find((h) => h.id === step.hit?.id);
    assert.equal(hit?.step_id, step.id, "命中必须回挂到这一步");
  });

  it("addChainStep 带 point_code 但没 evidence → 不记分，但给出明确提示", () => {
    const { store, id } = setup();
    const step = store.addChainStep(id, { title: "只记步骤", point_code: "central-system" });
    assert.equal(step.hit, null);
    assert.match(String(step.score_hint), /没有记分/);
    assert.equal(store.listChain(id).length, 1);
  });

  it("http_evidence：列表按 id 倒序、按 vuln_id 过滤", () => {
    const { store, id } = setup();
    const { id: vulnId } = store.addVuln(id, { title: "SQL 注入" });
    const e1 = store.addHttpEvidence(id, { vuln_id: vulnId, url: "http://x/a", method: "GET", request: "GET /a HTTP/1.1\r\nHost: x\r\n\r\n" });
    const e2 = store.addHttpEvidence(id, { vuln_id: vulnId, url: "http://x/b", method: "POST" });
    assert.ok(e2.id > e1.id);
    const listed = store.listHttpEvidence(id, { vuln_id: vulnId });
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, e2.id, "最新的在前");
  });

  it("listVulns 把关联的原始请求一并带上", () => {
    const { store, id } = setup();
    const { id: vulnId } = store.addVuln(id, { title: "SQL 注入" });
    store.addHttpEvidence(id, { vuln_id: vulnId, request: "GET /?id=1' HTTP/1.1\r\nHost: x\r\n\r\n" });
    const v = store.listVulns(id, {}).items[0];
    assert.equal(v?.http_evidence.length, 1);
    assert.match(String(v?.http_evidence[0]?.request), /id=1'/);
  });
});

describe("crud: 截图（文件落盘 + 元数据入库）", () => {
  it("从 data_base64 收图：落盘、读回、尺寸、mime 都对", () => {
    const { store, id } = setup();
    const added = store.addShot(id, { data_base64: TINY_PNG_BASE64, label: "后台首页", kind: "screenshot" });
    assert.equal(added.ok, true);
    assert.equal(added.kind, "screenshot");
    assert.match(added.file, /\.png$/);
    const read = store.readShot(id, added.id);
    assert.equal(read.mime, "image/png");
    assert.ok(read.base64.length > 0);
    /* 1×1 PNG */
    const shot = store.listShots(id, {}).items[0];
    assert.equal(shot?.width, 1);
    assert.equal(shot?.height, 1);
  });

  it("kind=card 必须原样保留（生成的证据卡不能冒充现场截图）", () => {
    const { store, id } = setup();
    store.addShot(id, { data_base64: TINY_PNG_BASE64, kind: "card" });
    store.addShot(id, { data_base64: TINY_PNG_BASE64, kind: "瞎写" });
    const kinds = store.listShots(id, {}).items.map((s) => s.kind);
    assert.ok(kinds.includes("card"));
    assert.ok(kinds.includes("screenshot"), "非法 kind 回落 screenshot");
  });

  it("sha256 稳定：同字节得到同摘要", () => {
    const { store, id } = setup();
    const a = store.addShot(id, { data_base64: TINY_PNG_BASE64 });
    const b = store.addShot(id, { data_base64: TINY_PNG_BASE64 });
    assert.equal(a.sha256, b.sha256);
    assert.notEqual(a.file, b.file, "文件名自增，不互相覆盖");
  });

  it("空字节 / 无来源必须抛错", () => {
    const { store, id } = setup();
    assert.throws(() => store.addShot(id, {}), /shot path or data_base64 required/);
    assert.throws(() => store.addShot(id, { data_base64: "" }), /shot path or data_base64 required/);
  });

  it("deleteShot 连磁盘文件一起删", () => {
    const { store, id } = setup();
    const added = store.addShot(id, { data_base64: TINY_PNG_BASE64 });
    const before = store.readShot(id, added.id);
    assert.ok(before.bytes > 0);
    store.deleteShot(id, added.id);
    assert.equal(store.listShots(id, {}).total, 0);
    assert.throws(() => store.readShot(id, added.id), /shot not found/);
  });

  it("readShot 的路径校验：库里的 file 被改成 ../ 也读不出去", () => {
    const { store, id } = setup();
    const added = store.addShot(id, { data_base64: TINY_PNG_BASE64 });
    /* 直接改库（模拟攻击者控制了 file 列） */
    store.db(id).prepare("UPDATE shot SET file = ? WHERE id = ?").run("../../../etc/passwd", added.id);
    assert.throws(() => store.readShot(id, added.id), /outside allowed roots|escapes allowed roots/);
  });
});

describe("crud: 攻击文件（路径穿越防护）", () => {
  it("内容入库 + 落盘 + 读回", () => {
    const { store, id } = setup();
    const added = store.addAttackFile(id, {
      target: "10.0.0.5", name: "exp.py", kind: "exp", content: "print('pwn')", evidence: "拿到 root 回显 uid=0",
    });
    assert.equal(added.kind, "exp");
    const tree = store.attackFileTree(id);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]?.folder, "10.0.0.5", "同一 IP 的多个端口归一个文件夹");
    const fileId = tree[0]?.files[0]?.id ?? -1;
    const read = store.readAttackFile(id, fileId);
    assert.equal(read?.content, "print('pwn')");
  });

  it("evidence 必填（只收录实际生效的东西）", () => {
    const { store, id } = setup();
    assert.throws(
      () => store.addAttackFile(id, { target: "10.0.0.5", name: "x.py", content: "x" }),
      /evidence required/,
    );
  });

  it("target='..' 被写路径校验拦住（上游也抛，实测确认）", () => {
    const { store, id } = setup();
    /* slugTarget('..') 原样返回 '..'，join 之后会跑出 attack-files/。
       上游靠 assertPathWithin 在这里抛错；这里锁住同样的行为 ——
       **不抛就等于让智能体把文件写到靶标目录外**。 */
    assert.throws(
      () => store.addAttackFile(id, { target: "..", name: "escape.sh", content: "echo hi", evidence: "验证过" }),
      /path outside allowed roots/,
    );
  });

  it("name 里的路径分隔符被替换成短横线（.. 退化成字面字符，不构成穿越）", () => {
    const { store, id } = setup();
    const added = store.addAttackFile(id, {
      target: "10.0.0.5", name: "../../evil.sh", content: "x", evidence: "y",
    });
    /* 上游把 `/` 与 `\` 换成 `-`：`../../evil.sh` → `..-..-evil.sh`。
       文件名里**仍会出现 `..` 这两个字符**，但那不是路径段，不构成穿越 ——
       判据是"解析后的绝对路径仍在根内"，不是"字符串里没有 .."。 */
    assert.equal(added.name, "..-..-evil.sh");
    assert.ok(added.path.startsWith(store.attackFilesDirOf(id)));
    assert.ok(!added.path.includes("/../"), "不能出现真正的上级目录段");
  });

  it("readAttackFile：库里的 path 被改成绝对越界路径时拒绝读取（不返回内容）", () => {
    const { store, id } = setup();
    const added = store.addAttackFile(id, { target: "10.0.0.5", name: "a.sh", content: "secret", evidence: "e" });
    const row = store.listAttackFiles(id, {}).find((f) => f.path === added.path);
    store.db(id).prepare("UPDATE attack_file SET path = ? WHERE id = ?").run("/etc/hosts", row?.id ?? -1);
    const read = store.readAttackFile(id, row?.id ?? -1);
    assert.match(String(read?.content), /拒绝或读取失败/, "必须拒绝，而不是把 /etc/hosts 读出来");
    assert.ok(!String(read?.content).includes("localhost"), "绝不能读到真实文件内容");
  });
});

describe("crud: 句柄生命周期（多靶标并发 + close 幂等）", () => {
  it("多个靶标的句柄互不干扰，各自数据独立", () => {
    const t = makeTempStore();
    temps.push(t);
    const a = t.store.openEngagement("alpha", ["10.0.0.0/24"], { bindCurrent: false }).id;
    const b = t.store.openEngagement("beta", ["10.9.9.0/24"], { bindCurrent: false }).id;
    assert.notEqual(a, b, "两个靶标必须是不同的 id");
    t.store.importBundle(a, { assets: [{ ip: "10.0.0.5", provenance: "active", ports: [] }] });
    t.store.importBundle(b, { assets: [{ ip: "10.9.9.5", provenance: "active", ports: [] }] });
    assert.equal(t.store.stats(a).assets, 1);
    assert.equal(t.store.stats(b).assets, 1);
    assert.equal(t.store.listAssets(a, {}).items[0]?.ip, "10.0.0.5");
    assert.equal(t.store.listAssets(b, {}).items[0]?.ip, "10.9.9.5");
  });

  it("同一靶标的多次 db() 返回同一个句柄（缓存生效，不重复打开）", () => {
    const t = makeTempStore();
    temps.push(t);
    const id = makeEngagement(t.store);
    assert.equal(t.store.db(id), t.store.db(id), "必须命中缓存 —— 每次重开会丢失 prepared statement 与事务状态");
  });

  it("close() 后句柄被清空，再次 db() 能重新打开（不炸）", () => {
    const t = makeTempStore();
    temps.push(t);
    const id = makeEngagement(t.store);
    t.store.importBundle(id, { assets: [{ ip: "10.0.0.5", provenance: "active", ports: [] }] });
    const before = t.store.db(id);
    t.store.close();
    /* close 之后不能再拿旧句柄 */
    const after = t.store.db(id);
    assert.notEqual(after, before, "close 之后必须重新打开");
    /* 数据还在（落盘了） */
    assert.equal(t.store.stats(id).assets, 1);
  });

  it("close() 幂等：连调两次不抛（插件 unload 可能重复触发）", () => {
    const t = makeTempStore();
    temps.push(t);
    makeEngagement(t.store);
    assert.doesNotThrow(() => {
      t.store.close();
      t.store.close();
    });
  });

  it("close() 同时关掉知识库句柄", () => {
    const t = makeTempStore();
    temps.push(t);
    makeEngagement(t.store);
    t.store.kb(); // 打开知识库
    t.store.close();
    /* 重新打开后仍能读（说明句柄被正确重建，而不是留了个已关闭的死引用） */
    assert.doesNotThrow(() => t.store.pocStats());
  });

  it("未建库的靶标 id 调 db() 明确抛错（不静默新建空库）", () => {
    const t = makeTempStore();
    temps.push(t);
    /* 打错 id 时静默建一个空库，比报错难查得多 */
    assert.throws(() => t.store.db("no-such-engagement"), /engagement not found/);
  });

  it("activeEngagementId：指针优先，其次最近创建的", () => {
    const t = makeTempStore();
    temps.push(t);
    const first = makeEngagement(t.store, "first-target");
    /* 没有指针时回退到列表第一个 */
    assert.equal(t.store.activeEngagementId(), first);
    const second = makeEngagement(t.store, "second-target");
    t.store.setActiveEngagement(second);
    assert.equal(t.store.activeEngagementId(), second, "显式指针必须优先");
    /* 指针指向一个已被删掉的靶标时，回退到列表 */
    assert.equal(t.store.setActiveEngagement("deleted-target"), false, "不存在的靶标不允许设为当前");
  });
});
