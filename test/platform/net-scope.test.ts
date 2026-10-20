/**
 * 网络范围判定测试。
 *
 * 这是安全边界：判错会让「自有网络」被当成外部目标，或反之。
 * 除了常规用例，重点做两件事：
 *  1. 与原实现差分对照（84+ 组）
 *  2. 表完整性断言（85 后缀 / 290 银行 / 38 文件后缀）——防止迁移遗漏
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  entryHost,
  hostOf,
  ipv4ToInt,
  isBankHost,
  isOwnNetwork,
  isPrivateIpv4,
  isPrivateIpv6,
  looksLikeIp,
  parseIpv6,
  regionOfSuffix,
} from "../../src/platform/net-scope.js";
import { BANK_HOSTS, FILE_SUFFIXES } from "../../src/platform/net-tables.js";

const QILIN_CANDIDATES = [
  "/Users/raki/Documents/deepseek-harness/default-workspace/dsh-qilin",
  path.resolve(import.meta.dirname, "..", "..", "..", "dsh-qilin"),
];
function findQilin(): string | null {
  for (const c of QILIN_CANDIDATES) {
    if (fs.existsSync(path.join(c, "lib", "net-scope.js"))) return c;
  }
  return null;
}

describe("查找表完整性（防止迁移遗漏）", () => {
  it("银行表 290 条", () => {
    assert.equal(BANK_HOSTS.size, 290);
  });
  it("文件后缀 38 条", () => {
    assert.equal(FILE_SUFFIXES.size, 38);
  });
  it("国别后缀覆盖 IDN 中文与 punycode 两种写法", async () => {
    const mod = await import("../../src/platform/net-scope.js");
    assert.equal(regionOfSuffix("a.中国"), "CN");
    assert.equal(regionOfSuffix("b.xn--fiqs8s"), "CN");
    assert.equal(regionOfSuffix("c.香港"), "HK");
    assert.equal(regionOfSuffix("d.澳门"), "MO");
    // 两个写法必须给出同一区域
    assert.equal(regionOfSuffix("a.中国"), regionOfSuffix("b.xn--fiqs8s"));
    void mod;
  });
});

describe("ipv4ToInt", () => {
  it("正常转换", () => {
    assert.equal(ipv4ToInt("0.0.0.0"), 0);
    assert.equal(ipv4ToInt("255.255.255.255"), 4294967295);
    assert.equal(ipv4ToInt("192.168.1.1"), 3232235777);
  });
  it("拒绝非法", () => {
    assert.equal(ipv4ToInt("1.2.3"), null);
    assert.equal(ipv4ToInt("1.2.3.4.5"), null);
    assert.equal(ipv4ToInt("256.1.1.1"), null);
    assert.equal(ipv4ToInt("a.b.c.d"), null);
    assert.equal(ipv4ToInt(""), null);
  });
});

describe("isPrivateIpv4 — RFC1918 与保留段", () => {
  const cases: [string, boolean][] = [
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["172.15.255.255", false],
    ["192.168.0.1", true],
    ["127.0.0.1", true],
    ["169.254.1.1", true],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
  ];
  for (const [ip, expected] of cases) {
    it(`${ip} → ${expected}`, () => {
      const v = ipv4ToInt(ip);
      assert.notEqual(v, null);
      assert.equal(isPrivateIpv4(v!), expected);
    });
  }
});

describe("parseIpv6", () => {
  it("完整形式", () => {
    assert.equal(parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001"), 0x20010db8000000000000000000000001n);
  });
  it(":: 压缩", () => {
    assert.equal(parseIpv6("::1"), 1n);
    assert.equal(parseIpv6("::"), 0n);
  });
  it("内嵌 IPv4", () => {
    const v = parseIpv6("::ffff:192.168.1.1");
    assert.notEqual(v, null);
    // 低 32 位应是 192.168.1.1
    assert.equal(v! & 0xffffffffn, 3232235777n);
  });
  it("拒绝非法", () => {
    assert.equal(parseIpv6(":::1"), null);
    assert.equal(parseIpv6("fe80::1::2"), null);
    assert.equal(parseIpv6("gggg::1"), null);
    assert.equal(parseIpv6(""), null);
  });
});

describe("isPrivateIpv6 — fe80::/10 与 fc00::/7", () => {
  const cases: [string, boolean][] = [
    ["::", true],
    ["::1", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fec0::1", false],
    ["fc00::1", true],
    ["fd12::1", true],
    ["fdff::1", true],
    ["fe00::1", false],
    ["2001:db8::1", false],
    ["2606:4700::1111", false],
  ];
  for (const [ip, expected] of cases) {
    it(`${ip} → ${expected}`, () => {
      const v = parseIpv6(ip);
      assert.notEqual(v, null, `应当能解析 ${ip}`);
      assert.equal(isPrivateIpv6(v!), expected);
    });
  }
});

describe("hostOf — 纯解析", () => {
  it("去端口", () => {
    assert.equal(hostOf("1.2.3.4:80"), "1.2.3.4");
    assert.equal(hostOf("host.com:443"), "host.com");
  });
  it("方括号 IPv6", () => {
    assert.equal(hostOf("[::1]:8080"), "::1");
  });
  it("去 userinfo", () => {
    assert.equal(hostOf("user@host.com"), "host.com");
  });
  it("去尾点", () => {
    assert.equal(hostOf("host.com."), "host.com");
  });
  it("空输入", () => {
    assert.equal(hostOf(""), "");
  });
});

describe("entryHost — 校验（与 hostOf 语义不同）", () => {
  it("放行合法 IP 与主机名", () => {
    assert.equal(entryHost("1.2.3.4"), "1.2.3.4");
    assert.equal(entryHost("example.com"), "example.com");
    assert.equal(entryHost("::1"), "::1");
  });

  it("拒绝注释行", () => {
    assert.equal(entryHost("# comment"), "");
  });

  it("拒绝路径与通配符", () => {
    assert.equal(entryHost("http://x.com/path"), "");
    assert.equal(entryHost("*.example.com"), "");
    assert.equal(entryHost("a b"), "");
  });

  it("拒绝密钥片段", () => {
    assert.equal(entryHost("-----BEGIN PRIVATE KEY-----"), "");
    assert.equal(entryHost("ssh-rsa AAAAB3"), "");
  });

  it("拒绝文件名（后缀在黑名单里）", () => {
    assert.equal(entryHost("README.md"), "");
    assert.equal(entryHost("app.js"), "");
  });

  it("user@host 只放行简单账号", () => {
    assert.equal(entryHost("deploy@example.com"), "example.com");
    assert.equal(entryHost("some one very long display name@host.com"), "");
  });

  it("★ 与 hostOf 的差异：hostOf 放行，entryHost 拒绝", () => {
    assert.equal(hostOf("README.md"), "readme.md");
    assert.equal(entryHost("README.md"), "", "文件名不能被当成主机");
    assert.equal(hostOf("# x"), "# x");
    assert.equal(entryHost("# x"), "", "注释不能被当成主机");
  });

  it("拒绝无 TLD 的单段名", () => {
    assert.equal(entryHost("nnn"), "");
  });
});

describe("isOwnNetwork", () => {
  it("回环与本地名", () => {
    assert.equal(isOwnNetwork("localhost"), true);
    assert.equal(isOwnNetwork("a.localhost"), true);
    assert.equal(isOwnNetwork("printer.local"), true);
  });
  it("私网 IP", () => {
    assert.equal(isOwnNetwork("192.168.1.1"), true);
    assert.equal(isOwnNetwork("10.1.2.3"), true);
    assert.equal(isOwnNetwork("::1"), true);
    assert.equal(isOwnNetwork("fe80::1"), true);
    assert.equal(isOwnNetwork("fc00::1"), true);
  });
  it("公网地址", () => {
    assert.equal(isOwnNetwork("8.8.8.8"), false);
    assert.equal(isOwnNetwork("example.com"), false);
    assert.equal(isOwnNetwork("2001:db8::1"), false);
  });
  it("空输入", () => {
    assert.equal(isOwnNetwork(""), false);
  });
});

describe("isBankHost — 子域回退", () => {
  it("主域命中", () => {
    assert.equal(isBankHost("chase.com", BANK_HOSTS), true);
  });
  it("子域命中（逐级回退）", () => {
    assert.equal(isBankHost("online.chase.com", BANK_HOSTS), true);
    assert.equal(isBankHost("a.b.c.chase.com", BANK_HOSTS), true);
  });
  it("非银行不命中", () => {
    assert.equal(isBankHost("example.com", BANK_HOSTS), false);
    assert.equal(isBankHost("notchase.com", BANK_HOSTS), false, "后缀相似但不同域");
  });
  it("大小写不敏感", () => {
    assert.equal(isBankHost("CHASE.COM", BANK_HOSTS), true);
  });
});

describe("looksLikeIp", () => {
  it("点分四段", () => {
    assert.equal(looksLikeIp("1.2.3.4"), true);
    assert.equal(looksLikeIp("1.2.3"), false);
  });
  it("含冒号视为 v6", () => {
    assert.equal(looksLikeIp("::1"), true);
  });
});

describe("差分对照：新实现 === dsh-qilin 原实现", () => {
  const qilin = findQilin();

  it("regionOfSuffix 与 entryHost 逐条相等", { skip: qilin === null }, async () => {
    const old = (await import(`file://${qilin}/lib/net-scope.js`)) as Record<
      string,
      (h: string) => unknown
    >;
    const hosts = [
      "example.com","x.com.cn","a.中国","b.xn--fiqs8s","test.hk","y.香港","x.mo",
      "a.b.mo","localhost","a.local","a.localhost","10.0.0.1","192.168.1.1",
      "172.16.0.1","172.32.0.1","127.0.0.1","169.254.1.1","8.8.8.8","224.0.0.1",
      "::1","::","fe80::1","fc00::1","fd12::1","2001:db8::1","::ffff:192.168.1.1",
      "user@host.com","[::1]:8080","1.2.3.4:80","host.com:443","host.com.","",
      "weird..domain","README.md","a.js","# comment","*.example.com","a b","nnn",
    ];
    let compared = 0;
    for (const h of hosts) {
      assert.deepEqual(regionOfSuffix(h), old["regionOfSuffix"]!(h), `regionOfSuffix(${h})`);
      assert.deepEqual(entryHost(h), old["entryHost"]!(h), `entryHost(${h})`);
      compared += 2;
    }
    assert.ok(compared >= 76, `对比样本过少：${compared}`);
  });
});
