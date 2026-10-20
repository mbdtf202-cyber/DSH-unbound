/**
 * 知识库（POC/EXP）+ 角色提示词 组工具（7 个）。
 *
 * 迁移自 `dsh-qilin/lib/redteam/tools.js` 的 977–997、1807–1991 行。
 *
 * ## 知识库的定位
 *
 * 通用 POC/EXP 是一次性投入、长期复用的资产：打 Nday/1day 之前先查这里，
 * 能省掉整轮"去互联网找 + 手搓 + 调试"的时间。
 *
 * ## `redteam_poc_add` 有一个参数陷阱
 *
 * 它的 `engagement` 参数表示**来源靶标**（这条知识是在哪个靶标上发现的），
 * **不是**"作用在哪个靶标"。
 *
 * 所以它**不能走 `resolveEngagement`** —— 那会把"来源"误解成"作用域"，
 * 导致知识被记到错误的靶标下。原实现专门为此写了注释，这里保留并测试。
 */

import type { ToolExecContext } from "../../host-api/types.js";
import { ROLE_ORDER } from "../store/constants.js";
import { resolveEngagement } from "./context.js";
import { defineTool, renderText, toToolJson } from "./define.js";
import type { AnyTypedTool } from "./define.js";
import { TOOL_DESCRIPTIONS } from "./descriptions.js";
import type { StoreForTools } from "./store-contract.js";
import type { ToolRuntimeContext } from "./session-tools.js";

/** 构造知识库 + 角色提示词组工具。 */
export function knowledgeTools(store: StoreForTools, ctx: ToolRuntimeContext): readonly AnyTypedTool[] {
  void ctx;

  /* ── redteam_role_prompt ────────────────────────────────────────────── */
  const rolePrompt = defineTool({
    name: "redteam_role_prompt",
    description: TOOL_DESCRIPTIONS.redteam_role_prompt,
    parameters: {
      engagement: { type: "string" },
      role: { type: "string", required: true, enum: ROLE_ORDER },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement);
      const found = store.listPrompts(id).find((p) => p.role === args.role);
      if (found === undefined) return toToolJson({ ok: false, error: "unknown role" });
      return toToolJson({
        ok: true,
        role: found.role,
        title: found.title,
        updated_at: found.updated_at,
        prompt: found.content,
      });
    },
  });

  /* ── redteam_poc_search ─────────────────────────────────────────────── */
  const pocSearch = defineTool({
    name: "redteam_poc_search",
    description: TOOL_DESCRIPTIONS.redteam_poc_search,
    parameters: {
      q: { type: "string", description: "关键字：组件+版本、漏洞名、路径片段、正文里的特征串都行" },
      cve: { type: "string", description: "CVE / CNVD 编号，例如 CVE-2023-21839" },
      component: { type: "string", description: "组件/产品名，例如 Weblogic、Shiro、泛微 OA、Nacos" },
      kind: { type: "string", description: "poc | exp | script | template | payload" },
      category: {
        type: "string",
        description:
          "按**归类**筛（可多值，逗号分隔）：rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other",
      },
      engagement: { type: "string", description: "按**来源靶标**筛（靶标 id 或名称关键词）：只看\"在某个单位上验证过的\"经验" },
      asset_target: { type: "string", description: "按**发现资产**筛（IP / 域名 / URL 片段）" },
      language: { type: "string", description: "python | go | java | bash | http | nuclei | js | php" },
      source: { type: "string", description: "web（互联网）| self（手搓）| manual（人工）| nuclei-template" },
      verified: { type: "boolean", description: "true 只看实测验证过的（优先用这些）" },
      templateLimit: { type: "number", description: "本机 nuclei 模板最多返回几条，默认 20" },
      limit: { type: "number", description: "知识库条目上限，默认 200" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args) {
      /* 注意：本工具没有 engagement 作用域概念（它的 engagement 参数是"来源靶标"），
         所以**不调 resolveEngagement** */
      const items = store.searchPocs(args);
      const stats = store.pocStats();
      const q = args.q ?? args.cve ?? args.component ?? "";
      /* templateStats() / nucleiTemplatesDir() 都要扫模板目录：**一次调用只算一次**。
         原实现里这段曾把 templateStats() 连算三遍（13k 模板的目录每次都要走一遍）。 */
      const tplStats = store.templateStats();
      const hasQuery = q !== "" || (args.category !== undefined && args.category !== "");
      const tpl = hasQuery
        ? store.searchTemplates(
            q,
            Math.min(Number(args.templateLimit) || 20, 100),
            0,
            args.category ?? "",
          )
        : {
            dir: tplStats.dir ?? store.nucleiTemplatesDir() ?? null,
            total: tplStats.total,
            items: [],
            byCategory: tplStats.byCategory,
          };
      const hit = items.length > 0 || (tpl.items ?? []).length > 0;
      return toToolJson({
        ok: true,
        knowledge_base: {
          total: stats.total,
          verified: stats.verified,
          reused: stats.reused,
          /* 归类概览：让智能体知道"哪类武器已经攒了多少"，缺哪类心里有数 */
          by_category: (stats.byCategory ?? [])
            .filter((c) => c.n > 0)
            .map((c) => c.name + " " + String(c.n) + "（已验证 " + String(c.verified) + "）"),
          by_engagement: (stats.byEngagement ?? []).slice(0, 10).map((e) => e.engagement + " " + String(e.n)),
        },
        local_templates: {
          dir: tplStats.dir,
          total: tplStats.total,
          cve_templates: tplStats.cve,
          matched: (tpl.items ?? []).length,
          by_category: (tplStats.byCategory ?? []).filter((c) => c.n > 0).map((c) => c.name + " " + String(c.n)),
        },
        count: items.length,
        hint: hit
          ? "命中现成的：知识库条目用 redteam_poc_get 取全文；nuclei 模板直接用 `nuclei -t <模板相对路径>`。用完 redteam_poc_use 记一次复用。"
          : "知识库与本机模板库都没有：去互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓，验证有效后务必 redteam_poc_add 回填知识库（带 category + engagement + asset_target + verified_note）。",
        templates: (tpl.items ?? []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id,
          code: x.code,
          title: x.title,
          kind: x.kind,
          category: x.category,
          cve: x.cve,
          component: x.component,
          versions: x.versions,
          language: x.language,
          source: x.source,
          source_url: x.source_url,
          verified: x.verified === 1,
          verified_note: x.verified_note,
          hit_count: x.hit_count,
          /* 来源溯源：哪条经验、哪个靶标、哪台资产、什么时候建的 */
          engagement: x.engagement_name ?? x.engagement_id ?? null,
          asset_target: x.asset_target ?? null,
          found_by_agent: x.found_by_agent ?? null,
          created_at: x.created_at,
          tags: x.tags,
          usage: x.usage,
          path: x.path,
          has_content: x.has_content === 1,
        })),
      });
    },
  });

  /* ── redteam_poc_get ────────────────────────────────────────────────── */
  const pocGet = defineTool({
    name: "redteam_poc_get",
    description: TOOL_DESCRIPTIONS.redteam_poc_get,
    parameters: {
      id: { type: "number", description: "知识库条目 id" },
      code: { type: "string", description: "知识库条目的稳定标识（search 结果里的 code）" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args) {
      const row = store.getPoc(args.id !== undefined ? args.id : args.code);
      if (row === undefined || row === null) {
        return toToolJson({ ok: false, error: "知识库没有这一条（先用 redteam_poc_search 检索）" });
      }
      return toToolJson({ ok: true, ...(typeof row === "object" ? (row as Record<string, unknown>) : { value: row }) });
    },
  });

  /* ── redteam_poc_add ────────────────────────────────────────────────── */
  const pocAdd = defineTool({
    name: "redteam_poc_add",
    description: TOOL_DESCRIPTIONS.redteam_poc_add,
    parameters: {
      title: { type: "string", required: true, description: "标题：组件 + 漏洞名/编号，例如「Weblogic T3 反序列化 CVE-2023-21839」" },
      kind: { type: "string", description: "poc（验证）| exp（利用）| script | template | payload" },
      category: {
        type: "string",
        description:
          "【归类，建议必填】rce 远程命令执行 | deserialization 反序列化 | file-upload 文件上传 getshell | sqli SQL 注入 | unauthorized 未授权访问 | auth-bypass 认证绕过/越权 | weak-password 弱口令 | ssrf | xxe | path-traversal 目录穿越/任意文件读 | info-leak 信息泄露 | privesc 提权/横向 | tunnel 隧道/代理 | other 其它",
      },
      cve: { type: "string", description: "CVE / CNVD 编号" },
      component: { type: "string", description: "组件/产品名（便于按组件检索）" },
      versions: { type: "string", description: "影响版本范围" },
      severity: { type: "string", description: "critical | high | medium | low" },
      language: { type: "string", description: "python | go | java | bash | http | nuclei | js | php" },
      source: { type: "string", description: "web（互联网扒的）| self（自己手搓）| manual（人工）| nuclei-template" },
      source_url: { type: "string", description: "来源链接（互联网来源必填，便于复核）" },
      description: { type: "string", description: "这个 POC 干什么、原理要点、前提条件" },
      usage: { type: "string", description: "用法：完整命令行示例 + 需要替换的参数" },
      content: { type: "string", description: "正文：脚本/POC 源码、原始请求包、nuclei 模板、调用步骤" },
      path: { type: "string", description: "也可以给本机已有文件路径（相对 pocs/ 或绝对路径），由知识库读取正文" },
      filename: { type: "string", description: "正文落盘文件名，默认按语言给（poc.py / poc.sh / poc.yaml…）" },
      verified: { type: "boolean", description: "是否已实测验证（**只有在真实目标上验证过的才填 true**）" },
      verified_note: { type: "string", description: "验证证据：在哪台目标、什么回显/结果、是否需要认证" },
      engagement: { type: "string", description: "【来源靶标】这条知识是在哪个靶标上发现/验证的（填靶标 id 或单位名称）" },
      asset_target: { type: "string", description: "【发现资产】具体是在哪台资产/哪个目标上验证成功的，例如 10.1.2.3:8080 或 http://oa.demo.com" },
      found_by_agent: { type: "string", description: "发现它的角色 code（recon / assess / vuln-scan / exploit / internal）" },
      tags: { type: "string", description: "逗号分隔标签，例如「java,反序列化,rce」" },
      created_by: { type: "string", description: "哪个角色/智能体沉淀的" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args) {
      /**
       * **这里不走 `resolveEngagement`**：本工具的 `engagement` 参数表示"来源靶标"，
       * 不是"作用在哪个靶标"。走 resolveEngagement 会把来源误解成作用域，
       * 把知识记到错误的靶标下。原实现专门写注释说明过这一点。
       *
       * 只做名称补全：把 id 与中文名都记下来，便于面板归类。
       */
      const payload: Record<string, unknown> = { ...args };
      const wanted = typeof args.engagement === "string" ? args.engagement.trim() : "";
      if (wanted !== "") {
        const hit = store
          .listEngagements()
          .find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted));
        payload["engagement_id"] = hit === undefined ? wanted : hit.id;
        payload["engagement_name"] = hit === undefined ? wanted : hit.name;
      }
      const r = store.savePoc(payload);
      const stats = store.pocStats();
      return toToolJson({
        ok: true,
        created: r.created,
        code: r.poc.code,
        path: r.path,
        category: r.poc.category,
        engagement: r.poc.engagement_name ?? r.poc.engagement_id ?? null,
        asset_target: r.poc.asset_target ?? null,
        created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint:
          "已进知识库（归类：" +
          (r.poc.category ?? "other") +
          "，建立时间：" +
          r.poc.created_at +
          "），" +
          "后续任何靶标的智能体 redteam_poc_search 都能直接命中；知识库共 " +
          String(stats.total) +
          " 条。",
      });
    },
  });

  /* ── redteam_poc_list ───────────────────────────────────────────────── */
  const pocList = defineTool({
    name: "redteam_poc_list",
    description: TOOL_DESCRIPTIONS.redteam_poc_list,
    parameters: {
      kind: { type: "string" },
      source: { type: "string" },
      component: { type: "string" },
      verified: { type: "boolean" },
      limit: { type: "number" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args) {
      const items = store.searchPocs(args);
      const stats = store.pocStats();
      return toToolJson({
        ok: true,
        stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({
          id: x.id,
          code: x.code,
          title: x.title,
          kind: x.kind,
          cve: x.cve,
          component: x.component,
          language: x.language,
          source: x.source,
          verified: x.verified === 1,
          hit_count: x.hit_count,
          tags: x.tags,
        })),
      });
    },
  });

  /* ── redteam_poc_update ─────────────────────────────────────────────── */
  const pocUpdate = defineTool({
    name: "redteam_poc_update",
    description: TOOL_DESCRIPTIONS.redteam_poc_update,
    parameters: {
      id: { type: "number", description: "知识库条目 id" },
      code: { type: "string", description: "或用 code 指定条目" },
      patch: {
        type: "object",
        description:
          "{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }",
      },
      verified: { type: "boolean", description: "便捷写法：直接传 verified" },
      verified_note: { type: "string", description: "便捷写法：直接传验证证据" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args) {
      const patch: Record<string, unknown> = { ...(args.patch ?? {}) };
      if (args.verified !== undefined) patch["verified"] = args.verified;
      if (args.verified_note !== undefined) patch["verified_note"] = args.verified_note;
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch);
      return toToolJson({
        ok: true,
        id: row.id,
        code: row.code,
        verified: row.verified === 1,
        verified_note: row.verified_note,
        updated_at: row.updated_at,
      });
    },
  });

  /* ── redteam_poc_use ────────────────────────────────────────────────── */
  const pocUse = defineTool({
    name: "redteam_poc_use",
    description: TOOL_DESCRIPTIONS.redteam_poc_use,
    parameters: {
      id: { type: "number" },
      code: { type: "string" },
      used_on: { type: "string", description: "用在哪：靶标名 / 目标 IP / URL" },
    },
    output: { schema: { type: "string" }, render: renderText },
    execute(args) {
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on);
      return toToolJson(r);
    },
  });

  return [rolePrompt, pocSearch, pocGet, pocAdd, pocList, pocUpdate, pocUse];
}

/** 本组工具名。 */
export const KNOWLEDGE_TOOL_NAMES = [
  "redteam_role_prompt",
  "redteam_poc_search",
  "redteam_poc_get",
  "redteam_poc_add",
  "redteam_poc_list",
  "redteam_poc_update",
  "redteam_poc_use",
] as const;

export type { ToolExecContext };
