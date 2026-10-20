/**
 * @generated 逐字节取自 dsh-qilin lib/redteam/store-core.js:227-372（攻击链阶段 / 得分点短名 / 旧阶段映射）
 * 
 *
 * 为什么是"生成"而不是手抄：这些是**数据**（规则原文、提示词正文、阶段定义），
 * 手抄一遍必然出现标点/换行漂移，而它们直接进交付报告与库表。生成 + 等价性测试
 * （test/store/equivalence.test.ts 逐字段比对旧实现）是唯一可靠的做法。
 * 改内容请改上游源，再重跑 tools/gen-store-data.mjs。
 */
/* eslint-disable */
import type { DefaultStage, StageCode } from "../types.js";

const DEFAULT_STAGES_RAW = [
  {
    code: 'recon', name: '信息收集', subtitle: 'RECON · 互联网侧', color: '#06b6d4', scored: 0,
    goal: '在互联网侧展开信息收集，确定值得打的资产面',
    sections: [
      { label: '资产测绘', items: ['子域名 / C 段 / 端口指纹', 'FOFA、被动 DNS、证书透明、主动扫描'] },
      { label: '攻击面确认', items: ['Web 标题与指纹、暴露的服务与管理端口', '归属、WAF / CDN 识别'] },
      { label: '攻击面排序', items: ['按易打性与预期得分排序', '确定先打哪几台'] },
    ],
    tools: 'ARL / 灯塔、fscan、gogo、OneForAll、ENScan、Goby、Nmap、Burp、Nuclei',
    transition: '确认互联网攻击面，转入利用',
  },
  {
    code: 'internet', name: '互联网资产权限', subtitle: 'INTERNET-SIDE PRIVILEGE', color: '#ef4444', scored: 1,
    goal: '在互联网侧资产上拿到账号、权限等得分',
    sections: [
      { label: '拿账号', items: ['弱口令 / 越权 / 未授权 / 逻辑漏洞', '后台管理员、普通账号'] },
      { label: '拿权限', items: ['Nday / 1day RCE、文件上传、反序列化', 'WebShell、命令执行、服务器权限'] },
      { label: '拿数据', items: ['数据库、配置泄露、批量敏感信息'] },
    ],
    tools: 'sqlmap、Nuclei、冰蝎 / 哥斯拉 / 蚁剑、fscan、Burp、自定义 POC',
    transition: '用已控主机打通出网通道',
  },
  {
    code: 'boundary', name: '边界突破', subtitle: 'BOUNDARY BREACH · TUNNEL', color: '#f59e0b', scored: 1,
    goal: '成功搭建隧道，把控制能力延伸进内网',
    sections: [
      { label: '隧道', items: ['suo5 / frp / Stowaway / Neo-reGeorg / Venom', 'socks5 落地、多级级联'] },
      { label: '出网通道', items: ['域名前置、CDN 隐藏、云函数转发', 'DNS / ICMP / 443 隐蔽信道'] },
    ],
    tools: 'suo5、frp、Stowaway、Neo-reGeorg、GOST、proxychains、chisel',
    transition: '隧道就绪，转入内网',
  },
  {
    code: 'internal', name: '内网资产权限', subtitle: 'INTERNAL-SIDE PRIVILEGE', color: '#8b5cf6', scored: 1,
    goal: '通过隧道在内网资产上拿分',
    sections: [
      { label: '内网测绘', items: ['存活 / 端口 / 服务 / 共享目录', '数据库、中间件、备份系统'] },
      { label: '横向与提权', items: ['凭据复用、Pass-the-Hash、票据', 'PsExec / WMIExec / SSH / RDP'] },
      { label: '数据', items: ['批量导出敏感信息，落 runs/ 并记引用'] },
    ],
    tools: 'gogo / fscan（走隧道）、Impacket、Mimikatz / LaZagne、BloodHound、suo5',
    transition: '定位内网核心靶标',
  },
  {
    code: 'target', name: '靶标权限', subtitle: 'TARGET SYSTEM', color: '#10b981', scored: 1,
    goal: '获取内网重要资产（靶标）的权限',
    sections: [
      { label: '靶标定位', items: ['按演练规则确认靶标系统 / 服务器范围', '明确得分判定口径'] },
      { label: '拿靶标', items: ['root / SYSTEM / 管理员 / 云 AK', '业务数据读写与配置变更能力'] },
      { label: '成果固化', items: ['证据链归档（配置 / 数据 / 主机信息 / 截图）', '攻击时间线回顾'] },
    ],
    tools: '凭据复用、内网横向工具、证据链归档与报告',
    transition: '',
  },
] as const

const POINT_STAGE_OVERRIDE_RAW = {
  /* 旧 code 的兜底（老数据仍可能有） */
  'core-system': 'target',
  boundary: 'boundary',
  /* 新口径：按《突破入侵类得分规则》的规则号判阶段。
     规则 5/6/7 = 邮箱系统 / 办公业务系统 / 集权系统 —— 这些就是演练的"靶标"，
     拿到它们即算打到核心目标，归入 ⑤ 靶标权限；
     规则 22-25 = 突破网络边界，归入 ③ 边界突破（§二 明确规定是"进入内网"）。 */
  'mail-admin': 'target', 'mail-user': 'target',
  'biz-admin': 'target', 'biz-user': 'target',
  'central-admin': 'target', 'central-user': 'target', 'central-managed': 'target',
  /* 合并版 code：邮箱/业务系统、集权系统 = 演练的靶标 → ⑤ 靶标权限 */
  'web-app': 'target', 'central-system': 'target',
  'boundary-logical': 'boundary', 'boundary-strong': 'boundary',
  'boundary-physical': 'boundary', 'boundary-supply': 'boundary',
} as const

const POINT_SHORT_NAME_RAW = {
  'domain-control': '域名控制',
  'terminal-access': '终端权限',
  'server-host': '服务器主机',
  'db-credential': '数据库凭据',
  'web-app': 'Web 应用',
  'central-system': '集权系统',
  'bigdata-system': '大数据系统',
  'netdev': '网络设备',
  'netdev-redirect': '网络重定向',
  'netdev-implant': '网络设备植入',
  'iiot': '工业互联网',
  'cloud-platform': '云管理平台',
  'iot-platform': '物联网平台',
  'secdev': '安全设备',
  'file-storage': '文件存储',
  'ai-agent': '模型智能体',
  'model-compute': '算力 / 知识库系统',
  'model-data': '模型数据系统',
  'computepower-admin': '算力基础设施',
  'computepower-cards': '算力卡资源',
  'boundary-logical': '进入逻辑隔离内网',
  'boundary-strong': '进入强隔离内网',
  'boundary-physical': '进入物理隔离内网',
  'boundary-supply': '供应链 / 云服务通道',
  'iot-corenet': '物联网打入核心网',
  'core-system': '核心系统（旧口径）',
} as const

const LEGACY_STAGE_MAP_RAW = {
  recon: 'recon', vuln: 'internet', exploit: 'internet',
  access: 'internal', pivot: 'boundary', data: 'internal', other: 'recon',
} as const

const VALID_STAGE_CODES_RAW = ['recon', 'internet', 'boundary', 'internal', 'target'] as const

export const DEFAULT_STAGES: readonly DefaultStage[] = DEFAULT_STAGES_RAW
export const POINT_STAGE_OVERRIDE: Readonly<Record<string, StageCode>> = POINT_STAGE_OVERRIDE_RAW
export const POINT_SHORT_NAME: Readonly<Record<string, string>> = POINT_SHORT_NAME_RAW
export const LEGACY_STAGE_MAP: Readonly<Record<string, StageCode>> = LEGACY_STAGE_MAP_RAW
export const VALID_STAGE_CODES: readonly StageCode[] = VALID_STAGE_CODES_RAW
