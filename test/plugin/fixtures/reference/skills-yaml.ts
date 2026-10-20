// @ts-nocheck
/**
 * 冻结参考实现（逐字复制，勿改）。
 *
 * 来源：dsh-qilin/lib/skills.js 的 frontmatter 解析段（splitFrontmatter、
 * escapeYamlKey、blockScalarValue、yamlLineField、yamlBoolField、parseSkillDocument），
 * commit 6e6f13d。差分测试的对照组。
 */
export function splitFrontmatter(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return null;
  const afterOpen = text.slice(3);
  if (!/^\r?\n/.test(afterOpen)) return null;
  const rest = afterOpen.replace(/^\r?\n/, "");
  const close = rest.match(/\r?\n---(?:\r?\n|$)/);
  if (!close || close.index == null) return null;
  return {
    head: rest.slice(0, close.index),
    body: rest.slice(close.index + close[0].length),
  };
}

function escapeYamlKey(s) {
  // frontmatter key 走到 RegExp 构造前必须 escape:当前调用点都是硬编码字面量,
  // 但万一未来有数据驱动场景,点 / 美元符 / 括号在正则里是元字符,会错配或 ReDoS。
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockScalarValue(head, key) {
  const lines = String(head || "").split(/\r?\n/);
  const headerRe = new RegExp(`^(\\s*)${escapeYamlKey(key)}:\\s*([|>])([+-]?)(\\d*)\\s*(?:#.*)?$`);
  let headerIdx = -1;
  let keyIndent = 0;
  let style = "|";
  let chomp = "";
  let indentHint = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    headerIdx = i;
    keyIndent = m[1].length;
    style = m[2];
    chomp = m[3] || "";
    indentHint = m[4] ? parseInt(m[4], 10) : 0;
    break;
  }
  if (headerIdx < 0) return "";
  const body = [];
  let blockIndent = indentHint > 0 ? keyIndent + indentHint : 0;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") { body.push(""); continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= keyIndent) break;
    if (!blockIndent) blockIndent = indent;
    if (indent < blockIndent) break;
    body.push(line.slice(blockIndent));
  }
  while (body.length && body[body.length - 1] === "") body.pop();
  let text;
  if (style === "|") {
    text = body.join("\n");
  } else {
    text = "";
    for (let i = 0; i < body.length; i += 1) {
      const cur = body[i];
      if (i === 0) { text += cur; continue; }
      if (cur === "") { text += "\n"; continue; }
      if (body[i - 1] === "") { text += cur; continue; }
      text += " " + cur;
    }
  }
  if (chomp === "+") text += "\n";
  else if (chomp !== "-" && text.length > 0) text += "\n";
  return text.replace(/\s+/g, " ").trim();
}

function yamlLineField(head, key) {
  const re = new RegExp(`^${escapeYamlKey(key)}:\\s*(.*)$`, "m");
  const match = String(head || "").match(re);
  if (!match) return "";
  let value = match[1].trim();
  if (!value) return "";
  // 块标量：`|`, `>`, 加 chomp (`-`/`+`) 或 indent 指示（`|2`）—— 调用 blockScalarValue 解析正文。
  if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(value)) return blockScalarValue(head, key);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return value.startsWith("\"") ? JSON.parse(value) : value.slice(1, -1);
    } catch {
      return value.slice(1, -1);
    }
  }
  const comment = value.indexOf(" #");
  if (comment >= 0) value = value.slice(0, comment).trim();
  return value;
}

function yamlBoolField(head, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const match = String(head || "").match(re);
  if (!match) return { present: false };
  let value = match[1].trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  const comment = value.indexOf(" #");
  if (comment >= 0) value = value.slice(0, comment).trim();
  const norm = value.toLowerCase();
  if (["true", "yes", "on", "1"].includes(norm)) return { present: true, value: true };
  if (["false", "no", "off", "0"].includes(norm)) return { present: true, value: false };
  return { present: true, invalid: true };
}

export function parseSkillDocument(raw) {
  const parts = splitFrontmatter(raw);
  if (!parts) return { ok: false, error: "缺少 YAML frontmatter（须以 --- 包围）" };
  const name = yamlLineField(parts.head, "name");
  const description = yamlLineField(parts.head, "description");
  if (!validSkillName(name)) return { ok: false, error: "frontmatter.name 必须是 kebab-case，例如 code-review" };
  if (!description) return { ok: false, error: "frontmatter.description 必填（单行）" };
  const disableModel = yamlBoolField(parts.head, "disable-model-invocation");
  const userInvocable = yamlBoolField(parts.head, "user-invocable");
  if (disableModel.invalid) return { ok: false, error: "disable-model-invocation 必须是布尔值（true/false）" };
  if (userInvocable.invalid) return { ok: false, error: "user-invocable 必须是布尔值（true/false）" };
  return {
    ok: true,
    name,
    description,
    whenToUse: yamlLineField(parts.head, "whenToUse"),
    modelInvocable: disableModel.value !== true,
    userInvocable: userInvocable.value !== false,
    body: parts.body,
    head: parts.head,
  };
}


/** 逐字取自 lib/skills.js：与官方一致的 kebab-case 校验（原文件里是 export function）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function validSkillName(id) {
  return typeof id === "string" && SKILL_NAME_RE.test(id);
}

// 原文件里这些是私有函数；差分测试需要调用，函数体逐字未改。
export { yamlLineField, yamlBoolField, blockScalarValue, escapeYamlKey };
