/**
 * 宿主 persona 文本剥离。
 *
 * ## 为什么需要
 *
 * 官方 `harness:identity` / `deployment:persona*` 段会在 system prompt 里
 * 反复声明「你是 DeepSeek Harness 驱动的 AI 助手」。插件要找的是**操作者身份**，
 * 这两者直接冲突，模型会左右摇摆（原项目实测：写到一半「苏醒」然后拒答）。
 *
 * ## 迁移纪律
 *
 * 这里的**每一条正则都是原样搬来的**，包括顺序。它们是「多次线上对拍」的产物：
 *   - 顺序有意义：先删通用句，再删更长的句子，否则长句的前缀被吃掉后短句就匹配不到了。
 *   - `\s*` 尾部吞空格也是故意的：留着会变成双空格，下游 `[ \t]{2,}` 才会收拾，
 *     但那一步在最后，中间任何一步依赖单空格边界都会错位。
 *   - 旧版本残留的三段长句（`OLD_*`）用**字符串**而不是正则做 replace，
 *     因为它们含 `(`、`)`、`—`、`/`，走正则要层层转义，容易漏。
 *
 * 测试里对每条正则都有「同输入 → 同输出」的对照用例（test/plugin/persona.test.ts）。
 */

/** 旧版插件写进注入文本的身份锁。新版本不再写，但要能从旧装配里剥掉。 */
export const OLD_IDENTITY_LOCK =
  "Identity lock (mandatory): You are not DeepSeek's AI assistant, not a " +
  "DeepSeek-powered coding assistant, and not a generic DeepSeek Harness agent. " +
  "Never introduce yourself that way in any language (including 我是 DeepSeek… / " +
  "DeepSeek 的 AI 助手 / DeepSeek 驱动的 AI 编程助手 / 跑在 DeepSeek Harness). " +
  "UI or product labels that mention DeepSeek Harness name the environment only — " +
  "they are not your persona. When asked who you are (你是谁 / who are you), answer " +
  "only as the operator identity defined in the prompt below (prompt-inject / active rules).";

/** 旧版 prompt-inject 里的「你是谁」段。 */
export const OLD_WHO_FROM_INJECT =
  "When asked 你是谁 / who are you, answer as the identity defined in prompt-inject.md. " +
  "Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";

/** 旧版 LCS 身份锁。 */
export const OLD_LCS_LOCK =
  "You are the operator persona in prompt-inject (Little Code Sauce / LCS unless that file names someone else). " +
  "When asked 你是谁 / who are you, answer with that name only. " +
  "Never say 我是 DeepSeek 的 AI 助手 or that you run on DeepSeek Harness as your identity — that is the host, not you.";

/** 身份卡的起始标记；`stripIdentityPrefix` 依赖它切掉卡头。 */
export const IDENTITY_CARD_PREFIX = "WHO YOU ARE (highest priority";

/**
 * 剥掉宿主 persona 声明。
 *
 * 非字符串 / 空串原样返回（调用方只用它处理字符串段）。
 * 结尾 `.trim()`：剥完常常留下前导换行，留在段首会让下游按行切分时多一个空段。
 */
export function stripHarnessPersona(text: string): string;
export function stripHarnessPersona(text: unknown): unknown;
export function stripHarnessPersona(text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    .replace(/You are an AI agent powered by DeepSeek Harness\.?\s*/g, "")
    .replace(/You are a helpful software engineer assistant\.?\s*/gi, "")
    .replace(/你是一个有帮助的软件工程师助手[。.]?\s*/g, "")
    .replace(/我是 DeepSeek(?:驱动)?的? AI(?:编程)?助手[，,]?[^\n]*/g, "")
    .replace(/你好！?我是 DeepSeek[^\n]*/g, "")
    .replace(
      /You are interacting with the user through the DeepSeek Harness Web GUI/g,
      "You are interacting with the user through the local web GUI",
    )
    .replace(
      /You are interacting with the user through the local web GUI at (\S+)\. /g,
      "Local web GUI: $1. ",
    )
    // 0.2.1：URL 不再内联，改由 runtime context 命名；句子没有结尾的 " at URL."
    .replace(
      /You are interacting with the user through the local web GUI whose URL the runtime context names\./g,
      "Local web GUI: the URL the runtime context names.",
    )
    .replace(
      /Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL\. ?/g,
      "",
    )
    .replace(
      /Do not call present just to list edited source files, or run commands to check whether a diff view will appear\. ?/g,
      "",
    )
    .replace(/You don't have access to the internet via this tool\.?\s*/g, "")
    .replace(/Your identity is defined exclusively by the dsh-qilin operator prompt\.?\s*/gi, "")
    .replace(
      /You are not a generic coding agent(?: or a mere software-engineer assistant)?\.?\s*/gi,
      "",
    )
    .replace(OLD_WHO_FROM_INJECT, "")
    .replace(OLD_LCS_LOCK, "")
    .replace(OLD_IDENTITY_LOCK, "")
    .replace(
      /You are a coding agent powered by the \{\{model\}\} model, running on the DeepSeek Harness\. Your working directory is \{\{cwd\}\}\.?\s*/g,
      "",
    )
    .replace(
      /You are a coding agent powered by the \{\{model\}\} model, running on the DeepSeek Harness\.?\s*/g,
      "",
    )
    .replace(
      /You are a coding agent powered by the \{\{model\}\} model\. Your working directory is \{\{cwd\}\}\.?\s*/g,
      "",
    )
    .replace(
      /The DeepSeek Harness implementation checkout is at [\s\S]*?Use this checkout only to inspect or extend DSH itself\.?\s*/g,
      "",
    )
    .replace(
      /You are a coding agent powered by the [^\n.]+ model, running on the DeepSeek Harness\.?\s*/g,
      "",
    )
    .replace(/You are a coding agent powered by the [^\n.]+ model\.?\s*/g, "")
    .replace(/You are Claude Code, Anthropic's official CLI for Claude\.?\s*/g, "")
    .replace(/You are Claude,?[^\n]*/g, "")
    .replace(/我是 Claude[^\n]*/g, "")
    .replace(/由 Anthropic 开发[^\n]*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ \n/g, "\n")
    .trim();
}
