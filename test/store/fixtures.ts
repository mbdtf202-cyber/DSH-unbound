/**
 * 测试夹具：造一个隔离的 store，跑完即删。
 *
 * ## 为什么用真实 SQLite 而不是 mock
 *
 * 这一层的行为几乎全在 SQL 里（`COALESCE` 的返回值、`ORDER BY` 的稳定性、
 * `ON CONFLICT` 的合并语义、迁移的幂等性）。mock 掉 SQLite 等于把被测物换掉，
 * 剩下的只是"函数被调用了"。
 *
 * ## 隔离
 *
 * 每个 store 一个临时目录（`mkdtempSync`），测试之间不共享状态。
 * `after()` 里删目录 —— 但**先 close**，否则 WAL 文件还会被持有（macOS 上删不掉）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedteamStore } from "../../src/redteam/store/index.js";

/** 一个用完可丢的 store。 */
export interface TempStore {
  readonly store: RedteamStore;
  readonly root: string;
  /** 关闭句柄并删目录。重复调用安全。 */
  dispose(): void;
}

/** 造一个临时 store。 */
export function makeTempStore(): TempStore {
  const root = mkdtempSync(join(tmpdir(), "dsh-store-test-"));
  const store = new RedteamStore(root);
  let disposed = false;
  return {
    store,
    root,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        store.close();
      } catch {
        /* 忽略 */
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

/** 造一个已打开、已播种默认得分点的靶标。 */
export function makeEngagement(store: RedteamStore, name = "test-engagement", scope: readonly string[] = ["10.0.0.0/24"]): string {
  const opened = store.openEngagement(name, scope, { bindCurrent: false });
  return opened.id;
}

/** 一个最小可用的 ingest bundle：1 个 C 段、1 台资产、2 个端口、1 个指纹、1 个域名。 */
export function sampleBundle(): Record<string, unknown> {
  return {
    scan: { tool: "nmap", argv: ["-sV", "10.0.0.5"], agent_session_id: "sess-1" },
    segments: [{ cidr: "10.0.0.0/24", org: "内网测试段", asn: "AS64512", country: "CN", city: "北京", source: "manual" }],
    assets: [
      {
        ip: "10.0.0.5",
        state: "live",
        primary_name: "portal.example.test",
        provenance: "active",
        tool: "nmap",
        names: [{ name: "portal.example.test", kind: "domain" }],
        ports: [
          {
            port: 8080, proto: "tcp", state: "open",
            service: "http", product: "nginx", version: "1.24.0",
            banner: "nginx/1.24.0", url: "http://10.0.0.5:8080/", title: "门户系统",
            provenance: "active",
            fingerprints: [{ category: "web", vendor: "F5", product: "nginx", version: "1.24.0", evidence: "Server: nginx" }],
          },
          { port: 3306, proto: "tcp", state: "open", service: "mysql", product: "MySQL", version: "8.0.35", provenance: "active" },
        ],
      },
    ],
    edges: [{ src_kind: "segment", src_id: "10.0.0.0/24", dst_kind: "asset", dst_id: "10.0.0.5", relation: "contains" }],
  };
}

/** 一个最小的合法 PNG（1×1 透明），用作截图字节。 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
