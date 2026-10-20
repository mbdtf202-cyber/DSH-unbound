/**
 * 界面标签映射表。
 *
 * 这些字符串是**业务口径**，不是装饰：报告里写的「提权 / 横向」、
 * 面板上标的「已测试」、得分页的「高」，都必须与工具层/报告层一致。
 * 原实现把它们散在 `client.js` 各处（`TEST_LABEL`、`PRI_LABEL`、
 * `POC_CAT_NAME`、`ROLE_LABEL`、`SHOT_KIND`），这里集中一处，
 * 并用 `Readonly` 锁住，避免运行期被误改。
 *
 * ## 与 store / tools 层的一致性
 *
 * `POC_CATEGORIES` 在 store 侧也有一份（知识库分类）。
 * 这里显式声明**顺序**（`POC_CAT_ORDER`），因为面板按它分组显示 ——
 * 顺序变了界面顺序就变了，属于用户可见行为。
 */

/** 资产测试状态 → 中文。 */
export const TEST_STATUS_LABEL = Object.freeze({
  untested: "未测试",
  testing: "测试中",
  tested: "已测试",
  blocked: "被封禁",
  abandoned: "已放弃",
  no_surface: "无攻击面",
} as const);

/** 资产优先级 → 中文。 */
export const PRIORITY_LABEL = Object.freeze({
  high: "高",
  medium: "中",
  low: "低",
} as const);

/** 角色 code → 中文（报告/知识库要标「谁发现的」）。 */
export const ROLE_LABEL = Object.freeze({
  plan: "主会话（指挥）",
  recon: "信息收集",
  assess: "资产梳理",
  "vuln-scan": "漏洞发现",
  exploit: "漏洞利用",
  internal: "内网渗透",
} as const);

/** 证据类型 → 中文。 */
export const SHOT_KIND_LABEL = Object.freeze({
  screenshot: "现场截图",
  card: "记录生成的证据摘录",
} as const);

/** 知识库分类 → 中文。 */
export const POC_CATEGORY_LABEL = Object.freeze({
  rce: "远程命令执行",
  deserialization: "反序列化",
  "file-upload": "文件上传 getshell",
  sqli: "SQL 注入",
  unauthorized: "未授权访问",
  "auth-bypass": "认证绕过 / 越权",
  "weak-password": "弱口令 / 爆破",
  ssrf: "SSRF",
  xxe: "XXE",
  "path-traversal": "目录穿越 / 任意文件读",
  "info-leak": "信息泄露",
  privesc: "提权 / 横向",
  tunnel: "隧道 / 代理",
  other: "其它",
} as const);

/** 证据来源 → 中文。 */
export const PROVENANCE_LABEL = Object.freeze({
  passive: "被动",
  active: "主动",
} as const);

/** 知识库分类的**显示顺序**（面板按它分组）。 */
export const POC_CAT_ORDER: readonly string[] = Object.freeze(Object.keys(POC_CATEGORY_LABEL));

/** 资产测试状态的全部取值（顺序即下拉框顺序）。 */
export const TEST_STATUS_ORDER: readonly string[] = Object.freeze(Object.keys(TEST_STATUS_LABEL));

/** 资产优先级的全部取值（由高到低）。 */
export const PRIORITY_ORDER: readonly string[] = Object.freeze(Object.keys(PRIORITY_LABEL));

/**
 * 查表，缺值时回退到原始 key。
 *
 * 不用 `?? '未知'` 统一兜底：原实现对未知状态显示原始 code
 * （`TEST_LABEL[st] || st`），这样上游加了新状态时界面不会变成一片「未知」，
 * 而是直接暴露新 code —— 便于发现「后端加了状态但前端没跟上」。
 */
export function labelOf(table: Readonly<Record<string, string>>, key: unknown): string {
  if (typeof key !== "string") return "";
  return table[key] ?? key;
}

/** 测试状态的中文名。 */
export function testStatusLabel(value: unknown): string {
  return labelOf(TEST_STATUS_LABEL, value);
}

/** 优先级的中文名。 */
export function priorityLabel(value: unknown): string {
  return labelOf(PRIORITY_LABEL, value);
}

/** 角色的中文名。 */
export function roleLabel(value: unknown): string {
  return labelOf(ROLE_LABEL, value);
}

/** 证据类型的中文名。 */
export function shotKindLabel(value: unknown): string {
  return labelOf(SHOT_KIND_LABEL, value);
}

/** 知识库分类的中文名。 */
export function pocCategoryLabel(value: unknown): string {
  return labelOf(POC_CATEGORY_LABEL, value);
}

/**
 * 证据来源的中文名。
 *
 * 与 `labelOf` 不同：这里**要**兜底成「未知」，因为来源只有两种，
 * 第三种取值说明数据坏了，界面上标「未知」比显示原始值更有用。
 */
export function provenanceLabel(value: unknown): string {
  if (value === "passive") return PROVENANCE_LABEL.passive;
  if (value === "active") return PROVENANCE_LABEL.active;
  return "未知";
}
