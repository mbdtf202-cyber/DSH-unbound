/**
 * 客户端产物装配：把编译后的工厂片段嵌进宿主模块模板。
 *
 * ## 与原 `build-client.mjs` 的关系
 *
 * 原脚本做三件事，只有第一件是「机械可判定」的：
 * 1. 从源文件切出工厂正文（**已改为标记注释**，见 `extract.ts`）。
 * 2. 用正则删掉 `exports.apply = apply` / `exports.inject = inject`。
 * 3. 把 `function apply(ctx) {...}` 整段替换成 `applyDrillParts()`。
 *
 * 第 2、3 步都是**语义改写**，靠字符串/正则猜结构。这里换成：
 * - **不删 exports**：产物直接 `return module.exports`，exports 上的
 *   `apply` / `inject` 由宿主读取，没必要剥离。
 * - **不替换 apply**：宿主契约就是 `factory(require)` 返回带 `apply` 的对象。
 *   原脚本要替换，是因为它把「浏览器侧模块」当成「宿主插件模块」两套语义
 *   混在一起；现在明确只导出 `apply` + `inject` + 调试用的 `__parts`。
 *
 * 所以本模块只做一件事：**把片段放进模板的标记之间**，正文一个字节都不改。
 *
 * ## 幂等性
 *
 * `assemble(assemble(x)) === assemble(x)`，由 `verifyRoundTrip` 保证。
 * 构建入口每次运行都断言这一条 —— 不通过就退出码 1，绝不产出可疑产物。
 */

import { ok, err, type Result } from "../../shared/result.js";
import {
  FACTORY_BEGIN,
  FACTORY_END,
  byteLength,
  embedFragment,
  extractFragment,
  toLf,
  verifyRoundTrip,
  type MarkerError,
} from "../ui/extract.js";

/** 宿主模块模板：`window.__ModuleLoader__.load({ id, factory })` 的骨架。 */
export interface HostTemplate {
  /** 模块 id（宿主的 `__ModuleLoader__` 用它做注册键）。 */
  readonly id: string;
  /**
   * 工厂前置代码：`var module = ...` / `const h = React.createElement` 之类。
   * 它会出现在标记**之前**，因此不参与提取。
   */
  readonly prologue: string;
  /**
   * 工厂后置代码：`return module.exports` 之类。出现在标记**之后**。
   */
  readonly epilogue: string;
}

/** 默认模板：把 `require('react')` 与 `h` 绑定放在前置，`return` 放在后置。 */
export function defaultTemplate(id: string): HostTemplate {
  return {
    id,
    prologue: [
      "    var module = { exports: {} }",
      "    var exports = module.exports",
      "    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })",
      "",
      "    const React = require('react')",
      "    const { useState, useEffect, useRef, useCallback, Component } = React",
      "",
    ].join("\n"),
    epilogue: [
      "",
      "    return module.exports",
      "  },",
      "})",
      "",
    ].join("\n"),
  };
}

/** 把模板拼成「带标记的空壳」（片段位置留占位）。 */
export function renderTemplate(template: HostTemplate): string {
  return [
    "/**",
    " * RedTeam 控制台 —— 浏览器半侧（生成产物，勿手改）。",
    " *",
    " * 由 src/redteam/ui/build.ts 从 src/redteam/client/ 装配；",
    " * 标记之间是编译后的工厂正文，改源码后重跑构建。",
    " */",
    `window.__ModuleLoader__.load({`,
    `  id: '${template.id}',`,
    "  factory: (require) => {",
    template.prologue,
    FACTORY_BEGIN,
    "/* 片段占位：由构建脚本填充 */",
    FACTORY_END,
    template.epilogue,
  ].join("\n");
}

/** 装配结果：产物文本 + 字节数（便于日志比对）。 */
export interface AssembleResult {
  readonly text: string;
  readonly bytes: number;
  readonly fragmentBytes: number;
}

/** 装配失败：要么模板坏，要么片段坏，要么往返不一致。 */
export type AssembleError =
  | MarkerError
  | { readonly kind: "roundtrip_mismatch"; readonly detail: string };

/**
 * 把片段装配进模板。
 *
 * 步骤：
 * 1. `renderTemplate` 造空壳（每次调用都重新造，保证确定性）。
 * 2. `embedFragment` 放入片段。
 * 3. `verifyRoundTrip` 自检幂等。
 *
 * 第 3 步**不可省**：它是「产物可信」的唯一证据。
 */
export function assemble(template: HostTemplate, fragment: string): Result<AssembleResult, AssembleError> {
  const shell = renderTemplate(template);
  const embedded = embedFragment(shell, fragment);
  if (!embedded.ok) return err(embedded.error);

  const check = verifyRoundTrip(shell, fragment);
  if (!check.ok) return err(check.error);

  // 再跑一次装配，确认整体（不只是 embed）也幂等。
  const second = embedFragment(embedded.value, fragment);
  if (!second.ok) return err(second.error);
  if (second.value !== embedded.value) {
    return err({
      kind: "roundtrip_mismatch",
      detail: "重复装配产物不一致：模板拼接或片段写入引入了不确定内容",
    });
  }

  return ok({
    text: embedded.value,
    bytes: byteLength(embedded.value),
    fragmentBytes: byteLength(fragment),
  });
}

/**
 * 从产物里取回片段（用于「产物 → 源码」的反向校验）。
 *
 * 单独导出是因为它有一个非显然用途：发布前对比「上次产物的片段」
 * 与「这次源码的片段」，不一致说明产物过期（源码改了没重建）。
 */
export function fragmentOf(artifact: string): Result<string, MarkerError> {
  const extracted = extractFragment(artifact);
  if (!extracted.ok) return err(extracted.error);
  return ok(extracted.value.body);
}

/**
 * 判断产物是否与片段同步。
 *
 * `true` 表示产物已是最新（片段一致），无需重建；
 * `false` 表示源码改过但没重建 —— 这是 CI 里最该抓的状态。
 */
export function isUpToDate(artifact: string, fragment: string): boolean {
  const current = fragmentOf(artifact);
  if (!current.ok) return false;
  const expected = fragment.endsWith("\n") ? fragment : fragment + "\n";
  return current.value === expected;
}

/**
 * 组装整个浏览器模块（模板 + 片段）并把行尾归一为 LF。
 *
 * 为什么要显式归一：Windows 上 `writeFileSync` 不转换行尾，但源码可能在
 * `core.autocrlf=true` 的检出里是 CRLF。「同一输入在不同平台产出不同字节」
 * 会让产物校验永远失败，而且看不出原因。
 */
export function assembleNormalized(
  template: HostTemplate,
  fragment: string,
): Result<AssembleResult, AssembleError> {
  const result = assemble(template, toLf(fragment));
  return result;
}

/** 供诊断：产物的行数与字节数（不含正文，避免日志刷屏）。 */
export function describeArtifact(artifact: string): string {
  return `artifact: ${artifact.split("\n").length} 行 / ${byteLength(artifact)} 字节`;
}
