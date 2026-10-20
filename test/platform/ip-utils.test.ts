/**
 * ip-utils 的边界穷举测试。
 *
 * 每一条都对应原实现注释里点明的行为约束（不编造 0、不拼四不像 CIDR、
 * IPv6 按 /64 归段、IPv4-mapped 剥壳）。这些行为丢了不会报错，
 * 只会让面板的网段分组与内外网归属悄悄错掉。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cidrOf,
  defaultPocFilename,
  expandIpv6,
  ipToInt,
  isIpv6,
  nowIso,
  scopeOfIp,
  slugPoc,
  slugTarget,
  slugify,
} from "../../src/platform/ip-utils.js";

describe("ipToInt", () => {
  it("把 IPv4 转成 32 位无符号整数", () => {
    assert.equal(ipToInt("0.0.0.0"), 0);
    assert.equal(ipToInt("0.0.0.1"), 1);
    assert.equal(ipToInt("10.0.0.1"), 167772161);
    assert.equal(ipToInt("255.255.255.255"), 4294967295);
  });

  it("保持地址顺序与整数顺序一致（ORDER BY 依赖这一点）", () => {
    /* 9.255.255.255 紧贴在 10.0.0.0 之下 —— 这是"按整数排序等于按地址排序"的关键边界，
       用字符串排序会得到 10.* < 9.*，那正是要避免的错误。 */
    const addrs = ["10.0.0.2", "9.255.255.255", "10.0.0.10", "192.168.0.1"];
    const ints = addrs.map((a) => ipToInt(a));
    for (const v of ints) assert.notEqual(v, null);
    const sorted = [...ints].sort((x, y) => (x as number) - (y as number));
    assert.deepEqual(sorted, [167772159, 167772162, 167772170, 3232235521]);
    /* 字符串排序会把 10.* 排到 9.* 前面，整数排序不会 */
    assert.deepEqual([...addrs].sort(), ["10.0.0.10", "10.0.0.2", "192.168.0.1", "9.255.255.255"]);
  });

  it("IPv6 返回 null —— 绝不编造 0，让排序退回文本", () => {
    assert.equal(ipToInt("::1"), null);
    assert.equal(ipToInt("2001:db8::1"), null);
    assert.equal(ipToInt("::ffff:10.0.0.1"), null);
  });

  it("非 IP 文本返回 null", () => {
    assert.equal(ipToInt(""), null);
    assert.equal(ipToInt(null), null);
    assert.equal(ipToInt(undefined), null);
    assert.equal(ipToInt("example.com"), null);
    assert.equal(ipToInt("10.0.0"), null);
    assert.equal(ipToInt("10.0.0.1.2"), null);
    assert.equal(ipToInt("10.0.0.1:80"), null);
  });

  it("容忍首尾空白", () => {
    assert.equal(ipToInt("  10.0.0.1  "), 167772161);
  });

  it("八位组超范围不报错（只用于排序，不判定合法性，与旧行为一致）", () => {
    assert.equal(ipToInt("999.1.1.1"), (999 * 256 ** 3 + 1 * 256 ** 2 + 1 * 256 + 1) >>> 0);
  });

  it("4 个八位组是硬边界：3 组与 5 组都不认", () => {
    assert.equal(ipToInt("1.2.3"), null);
    assert.equal(ipToInt("1.2.3.4.5"), null);
  });
});

describe("isIpv6", () => {
  it("认出常见 IPv6 写法", () => {
    for (const v of ["::1", "::", "2001:db8::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1"]) {
      assert.equal(isIpv6(v), true, v);
    }
  });

  /**
   * 已实测的原实现怪癖（不是我的笔误）：`isIpv6` 的字符集不含方括号，
   * 所以 `[2001:db8::1]` 判 false；而 `expandIpv6` **会**剥方括号。
   * 两者不一致的后果是 `cidrOf("[2001:db8::1]")` 原样返回带括号的文本，
   * 面板会多出一个假网段。
   *
   * 我不敢在这里"顺手修好"：`isIpv6` 的返回值同时决定资产是否按 /64 归组，
   * 改它会静默重排已有资产归属。这条留给 Lead 决定（见交接报告），
   * 测试先锁住现状，防止迁移中无意改变。
   */
  it("方括号写法判 false（已知怪癖：与 expandIpv6 不一致）", () => {
    assert.equal(isIpv6("[2001:db8::1]"), false);
    assert.deepEqual(expandIpv6("[2001:db8::1]"), ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
  });

  it("没有冒号的都不是 IPv6", () => {
    assert.equal(isIpv6("10.0.0.1"), false);
    assert.equal(isIpv6("example.com"), false);
    assert.equal(isIpv6(""), false);
  });

  it("冒号段数边界是 9：9 段仍放行，10 段拒绝", () => {
    /* 9 段放行是原实现的既有行为（`split(':').length <= 9`）。
       9 段的地址本身不合法，但它只会让 cidrOf 多算一个 /64，
       不会损坏数据，所以保持宽松。 */
    assert.equal(isIpv6("1:2:3:4:5:6:7:8:9"), true);
    assert.equal(isIpv6("1:2:3:4:5:6:7:8"), true);
    assert.equal(isIpv6("1:2:3:4:5:6:7:8:a:b"), false);
  });

  it("含非法字符的判为非 IPv6", () => {
    assert.equal(isIpv6("2001:db8::zzzz"), false);
    assert.equal(isIpv6("gggg::1"), false);
  });

  it("IPv4-mapped 带域名的不是 IPv6", () => {
    assert.equal(isIpv6("::ffff:example.com"), false);
  });
});

describe("expandIpv6", () => {
  it("展开 :: 缩写补零到 8 组", () => {
    assert.deepEqual(expandIpv6("::1"), ["0", "0", "0", "0", "0", "0", "0", "1"]);
    assert.deepEqual(expandIpv6("::"), ["0", "0", "0", "0", "0", "0", "0", "0"]);
    assert.deepEqual(expandIpv6("2001:db8::1"), ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
  });

  it("完整 8 组原样小写返回", () => {
    assert.deepEqual(expandIpv6("2001:DB8:0:0:0:0:0:1"), ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
  });

  it("剥掉 URL 里的方括号", () => {
    assert.deepEqual(expandIpv6("[2001:db8::1]"), ["2001", "db8", "0", "0", "0", "0", "0", "1"]);
  });

  it("只有前导 :: 或只有尾随 ::", () => {
    assert.equal(expandIpv6("::1:2").length, 8);
    assert.deepEqual(expandIpv6("::1:2"), ["0", "0", "0", "0", "0", "0", "1", "2"]);
    assert.deepEqual(expandIpv6("1:2::"), ["1", "2", "0", "0", "0", "0", "0", "0"]);
  });

  it("超出 8 组时不截断（截断会悄悄改变网段归属）", () => {
    assert.equal(expandIpv6("1:2:3:4:5:6:7:8:9").length, 9);
  });
});

describe("cidrOf", () => {
  it("IPv4 取前三段拼 .0/24", () => {
    assert.equal(cidrOf("203.0.113.45"), "203.0.113.0/24");
    assert.equal(cidrOf("10.0.0.1"), "10.0.0.0/24");
    assert.equal(cidrOf("255.255.255.255"), "255.255.255.0/24");
  });

  it("IPv6 取前四组拼 ::/64", () => {
    assert.equal(cidrOf("2001:db8:1234:5678::1"), "2001:db8:1234:5678::/64");
    assert.equal(cidrOf("::1"), "0:0:0:0::/64");
    assert.equal(cidrOf("fe80::1"), "fe80:0:0:0::/64");
  });

  it("认不出来的原样返回 —— 绝不拼出四不像 CIDR", () => {
    for (const v of ["example.com", "", "not-an-ip", "10.0.0"]) {
      assert.equal(cidrOf(v), v.trim(), v);
    }
    /* 关键回归：IPv6 不能得到 "2001:db8::1.0/24" */
    assert.equal(cidrOf("2001:db8::1").endsWith(".0/24"), false);
  });

  it("方括号 IPv6 原样返回（isIpv6 怪癖的连带效果，锁住现状）", () => {
    assert.equal(cidrOf("[2001:db8::1]"), "[2001:db8::1]");
  });

  it("容忍首尾空白后仍能识别", () => {
    assert.equal(cidrOf("  10.0.0.1  "), "10.0.0.0/24");
  });

  it("非字符串输入不炸", () => {
    assert.equal(cidrOf(null), "");
    assert.equal(cidrOf(undefined), "");
  });
});

describe("scopeOfIp", () => {
  it("IPv4 私网段判 internal", () => {
    const internal = [
      "10.0.0.1",
      "10.255.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "100.64.0.1",
      "100.127.255.255",
    ];
    for (const v of internal) assert.equal(scopeOfIp(v), "internal", v);
  });

  it("IPv4 公网段判 external（含 172/100 的边界外）", () => {
    const external = [
      "8.8.8.8",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "192.169.0.1",
      "11.0.0.1",
    ];
    for (const v of external) assert.equal(scopeOfIp(v), "external", v);
  });

  it("IPv6 ULA 与链路本地判 internal", () => {
    for (const v of ["fc00::1", "fd12:3456::1", "fe80::1", "fe80::abcd", "febf::1"]) {
      assert.equal(scopeOfIp(v), "internal", v);
    }
  });

  it("IPv6 全球单播判 external", () => {
    for (const v of ["2001:db8::1", "2606:4700::1111", "fe00::1"]) {
      assert.equal(scopeOfIp(v), "external", v);
    }
  });

  it("IPv4-mapped 剥壳后按 IPv4 判", () => {
    assert.equal(scopeOfIp("::ffff:10.0.0.1"), "internal");
    assert.equal(scopeOfIp("::ffff:192.168.1.1"), "internal");
    assert.equal(scopeOfIp("::ffff:8.8.8.8"), "external");
    assert.equal(scopeOfIp("::FFFF:10.0.0.1"), "internal");
  });

  it("空值与垃圾输入判 external（不崩）", () => {
    for (const v of ["", null, undefined, "not-an-ip"]) assert.equal(scopeOfIp(v), "external");
  });

  it("172.16-31 是闭区间，32 立刻出界", () => {
    assert.equal(scopeOfIp("172.16.0.1"), "internal");
    assert.equal(scopeOfIp("172.31.0.1"), "internal");
    assert.equal(scopeOfIp("172.32.0.1"), "external");
  });

  it("100.64-127 是闭区间，63 与 128 出界", () => {
    assert.equal(scopeOfIp("100.64.0.1"), "internal");
    assert.equal(scopeOfIp("100.127.0.1"), "internal");
    assert.equal(scopeOfIp("100.63.0.1"), "external");
    assert.equal(scopeOfIp("100.128.0.1"), "external");
  });
});

describe("slugify", () => {
  it("转小写并把非字母数字换成短横线", () => {
    assert.equal(slugify("Example Corp"), "example-corp");
    assert.equal(slugify("示例科技有限公司"), "示例科技有限公司");
    assert.equal(slugify("A/B\\C"), "a-b-c");
  });

  it("去掉首尾短横线", () => {
    assert.equal(slugify("--hello--"), "hello");
    assert.equal(slugify("  ...hello...  "), "hello");
  });

  it("空名字退化成 engagement-<时间戳>（靶标目录名必须非空）", () => {
    assert.equal(slugify("", 1700000000000), "engagement-1700000000000");
    assert.equal(slugify("   ", 42), "engagement-42");
    assert.equal(slugify(null, 7), "engagement-7");
  });

  it("连续分隔符合并成一个短横线", () => {
    assert.equal(slugify("a   b"), "a-b");
    assert.equal(slugify("a___b"), "a-b");
  });
});

describe("slugTarget", () => {
  it("IP 原样返回", () => {
    assert.equal(slugTarget("10.0.0.1"), "10.0.0.1");
  });

  it("ip:port 只取 IP（同一 IP 多端口归一个文件夹）", () => {
    assert.equal(slugTarget("10.0.0.1:8080"), "10.0.0.1");
    assert.equal(slugTarget("10.0.0.1:443"), "10.0.0.1");
  });

  it("URL 只取 host（去协议、端口、路径、query）", () => {
    assert.equal(slugTarget("https://oa.example.com:8443/portal?x=1"), "oa.example.com");
    assert.equal(slugTarget("http://example.com/a/b"), "example.com");
    assert.equal(slugTarget("https://example.com"), "example.com");
  });

  it("C 段归一成 下划线 形式", () => {
    assert.equal(slugTarget("10.0.0.0/24"), "10.0.0.0_24");
  });

  it("空目标返回 unknown", () => {
    assert.equal(slugTarget(""), "unknown");
    assert.equal(slugTarget("   "), "unknown");
    assert.equal(slugTarget(null), "unknown");
  });

  it("非法字符替换成下划线并去掉尾随下划线", () => {
    assert.equal(slugTarget("host name!!"), "host_name");
    assert.equal(slugTarget("a b c"), "a_b_c");
  });

  it("全非法字符退化成 unknown，不产生空目录名", () => {
    assert.equal(slugTarget("///"), "unknown");
  });

  it("大小写保留（host 是大小写不敏感的，但目录名要可读）", () => {
    assert.equal(slugTarget("https://OA.Example.COM/x"), "OA.Example.COM");
  });
});

describe("slugPoc", () => {
  it("标题 + CVE 拼成稳定标识", () => {
    assert.equal(slugPoc("Weblogic T3 反序列化", "CVE-2023-21839"), "cve-2023-21839-weblogic-t3-反序列化");
  });

  it("标题里已含 CVE 时不重复拼接", () => {
    const out = slugPoc("Weblogic CVE-2023-21839 反序列化", "CVE-2023-21839");
    assert.equal(out.includes("cve-2023-21839-cve-2023-21839"), false);
    /* 已含编号时以标题为基，编号在标题里的自然位置保留 */
    assert.equal(out, "weblogic-cve-2023-21839-反序列化");
  });

  it("无 CVE 时只用标题", () => {
    assert.equal(slugPoc("Shiro RememberMe", ""), "shiro-rememberme");
  });

  it("空标题退化成 poc-<时间戳>", () => {
    assert.equal(slugPoc("", "", 1234), "poc-1234");
    assert.equal(slugPoc(null, null, 9), "poc-9");
  });

  it("截断到 80 字符且不留尾随短横线", () => {
    const long = "a".repeat(200);
    const out = slugPoc(long, "");
    assert.equal(out.length <= 80, true);
    assert.equal(out.endsWith("-"), false);
  });

  it("合并连续短横线", () => {
    assert.equal(slugPoc("a+++b", ""), "a-b");
  });

  it("保留中文", () => {
    assert.equal(slugPoc("泛微 OA 前台 RCE", ""), "泛微-oa-前台-rce");
  });
});

describe("defaultPocFilename", () => {
  it("按语言给扩展名", () => {
    assert.equal(defaultPocFilename("t", "poc", "python"), "poc.py");
    assert.equal(defaultPocFilename("t", "poc", "Python"), "poc.py");
    assert.equal(defaultPocFilename("t", "poc", "go"), "poc.go");
    assert.equal(defaultPocFilename("t", "poc", "bash"), "poc.sh");
    assert.equal(defaultPocFilename("t", "poc", "nuclei"), "poc.yaml");
    assert.equal(defaultPocFilename("t", "poc", "powershell"), "poc.ps1");
  });

  it("未知语言按 kind 兜底", () => {
    assert.equal(defaultPocFilename("t", "template", "brainfuck"), "poc.yaml");
    assert.equal(defaultPocFilename("t", "poc", ""), "poc.txt");
    assert.equal(defaultPocFilename("t", undefined, undefined), "poc.txt");
  });
});

describe("nowIso", () => {
  it("返回可被 Date 解析的 ISO 串", () => {
    const s = nowIso();
    assert.equal(typeof s, "string");
    assert.equal(Number.isNaN(Date.parse(s)), false);
  });
});
