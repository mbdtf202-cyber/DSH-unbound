/**
 * 类型化的工具定义层。
 *
 * ## 为什么要这一层
 *
 * 宿主的 `@deepseek-ai/dsh-tools` **不带任何 `.d.ts`**。原 `dsh-qilin` 因此
 * 56 个工具全是裸对象：`parameters` 是随便写的字面量，`execute(args)` 的
 * `args` 是 `any` —— 参数名写错、类型写错、少写一个必填项，编译器全程沉默，
 * 只有模型调用时才会在运行时炸，而且往往被 `withStructuredErrors` 的 `catch` 吞成
 * 一条 `{ok:false}`。
 *
 * 这里要做的不是"再包一层 `any`"，而是让 **`parameters` 声明成为唯一事实来源**：
 *
 * ```
 * const t = defineTool({
 *   name: "x",
 *   parameters: {
 *     ip:   { type: "string", required: true },
 *     port: { type: "number" },
 *     mode: { type: "string", enum: ["a", "b"] as const },
 *   },
 *   execute(args) {
 *     args.ip    // string
 *     args.port  // number | undefined
 *     args.mode  // "a" | "b" | undefined
 *   },
 * });
 * ```
 *
 * ## 三条硬约束（都由编译器强制，不靠人记得）
 *
 * 1. **`execute` 必须返回 `string`**。原实现一律 `JSON.stringify(...)`，
 *    模型看到的就是那串 JSON；返回对象会静默改变模型可见输出。
 *    见 `ToolExecuteResult`。
 * 2. **`args` 由 `parameters` 推导**，不是 `Record<string, unknown>`。
 *    可选参数在 `exactOptionalPropertyTypes` 下是 `T | undefined`。
 * 3. **`enum` 必须 `as const`**，否则推导出来是 `string` 而不是字面量联合 ——
 *    这一条只能靠代码评审，类型系统无法强制（`readonly string[]` 与
 *    `readonly "a"[]` 在 `ToolParamDecl.enum` 上都合法）。
 *
 * ## 为什么 enum 的字面量联合很重要
 *
 * 工具里到处是 `args.action === 'status'` 这种分支。如果推导成 `string`，
 * 拼错的 `'staus'` 不会报错，只会静默走到 else 分支。
 */

import type { ToolDefinition, ToolExecContext, ToolParamDecl } from "../../host-api/types.js";

/* ── parameters → args 的类型推导 ──────────────────────────────────────── */

/** 参数字段声明，`enum` 收窄成字面量元组。 */
export interface ParamDecl extends Omit<ToolParamDecl, "enum" | "items"> {
  /** 字面量元组（`as const`），用于把 enum 推导成联合类型。 */
  readonly enum?: readonly string[] | undefined;
  readonly items?: ParamDecl | undefined;
  /**
   * 对象类型的字段声明（仅 `type: "object"` 时有意义）。
   *
   * 加这一条是为了让 `assets[] → ports[] → fingerprints[]` 这种三层嵌套
   * 能真正推导出具体类型；少了它，嵌套对象只能退化成 `Record<string, unknown>`，
   * 工具里 `args.ports[0].port` 就失去类型 —— 那正是 `asset_add` 最容易出隐蔽 bug 的地方。
   */
  readonly properties?: Readonly<Record<string, ParamDecl>> | undefined;
}

/** 从单个声明取出它的 TS 类型。 */
type TypeOf<P extends ParamDecl> = P extends { readonly type: "string" }
  ? P extends { readonly enum: readonly (infer E)[] }
    ? E & string
    : string
  : P extends { readonly type: "number" }
    ? number
    : P extends { readonly type: "boolean" }
      ? boolean
      : P extends { readonly type: "array"; readonly items: infer I }
        ? I extends ParamDecl
          ? readonly TypeOf<I>[]
          : readonly unknown[]
        : P extends { readonly type: "object"; readonly properties: infer Props }
          ? Props extends Record<string, ParamDecl>
            ? ArgsOf<Props>
            : Readonly<Record<string, unknown>>
          : P extends { readonly type: "object" }
            ? Readonly<Record<string, unknown>>
            : unknown;

/** 必填参数的名字集合。 */
type RequiredKeys<Ps extends Record<string, ParamDecl>> = {
  [K in keyof Ps]: Ps[K] extends { readonly required: true } ? K : never;
}[keyof Ps];

/**
 * 由 `parameters` 推导出的 `args` 类型。
 *
 * - 必填项（`required: true`）：直接是 `TypeOf`
 * - 其余：`TypeOf | undefined`（`exactOptionalPropertyTypes` 下就是「可能没有」）
 */
export type ArgsOf<Ps extends Record<string, ParamDecl>> = Readonly<
  { [K in RequiredKeys<Ps>]: TypeOf<Ps[K]> } & {
    [K in Exclude<keyof Ps, RequiredKeys<Ps>>]?: TypeOf<Ps[K]> | undefined;
  }
>;

/* ── execute 的返回类型 ────────────────────────────────────────────────── */

/**
 * 工具 execute 的返回类型：**只能是字符串**。
 *
 * 这样写而不是 `unknown` 的目的：任何工具误返回对象都会编译失败。
 * 把"必须是 JSON 字符串"这个约束交给编译器，而不是靠人记得 ——
 * 模型看到的就是这串字符串，改结构等于改行为。
 */
export type ToolExecuteResult = string;

/**
 * 失败返回（结构化错误）。
 *
 * 不是 throw —— 模型拿到 `{ok:false}` 能换参数重试，拿到异常往往直接放弃这次调用。
 */
export interface ToolFailure {
  readonly ok: false;
  readonly error: string;
  readonly error_kind: "bad_input" | "failed";
  readonly hint: string;
}

/** 把失败对象序列化成工具返回值。 */
export function failureJson(failure: ToolFailure): ToolExecuteResult {
  return JSON.stringify(failure, null, 2);
}

/**
 * 把任意值序列化成工具返回值。
 *
 * 统一出口便于以后换序列化策略（比如压缩缩进）时只改一处。
 */
export function toToolJson(value: unknown): ToolExecuteResult {
  return JSON.stringify(value, null, 2);
}

/* ── 工具定义 ──────────────────────────────────────────────────────────── */

/**
 * 工具的输出声明。
 *
 * `render` 收到的 `value` 就是 `execute` 返回的字符串；原实现一律包成
 * `[{ type: 'text', text: value }]`，这里保留同样形状。
 */
export interface ToolOutputSpec {
  readonly schema: { readonly type: string };
  readonly render?: (args: unknown, value: ToolExecuteResult) => unknown;
}

/**
 * 一个类型化工具定义。
 *
 * 与宿主 `ToolDefinition` 的差别：`parameters` 是 {@link ParamDecl}（保留 enum 字面量），
 * `execute` 的 `args` 是从 `parameters` 推导的，返回值固定 `string`。
 */
export interface TypedToolDefinition<Ps extends Record<string, ParamDecl> = Record<string, ParamDecl>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Ps;
  readonly output?: ToolOutputSpec | undefined;
  execute(args: ArgsOf<Ps>, exec: ToolExecContext): Promise<ToolExecuteResult> | ToolExecuteResult;
}

/**
 * 定义工具。纯粹是类型层的手续，运行时原样返回对象。
 *
 * 用 `const Ps` 泛型参数保住 `parameters` 的字面量类型 ——
 * 否则 `enum` 会被拓宽成 `string[]`，args 就退化成 `string`。
 */
export function defineTool<const Ps extends Record<string, ParamDecl>>(
  tool: TypedToolDefinition<Ps>,
): TypedToolDefinition<Ps> {
  return tool;
}

/* ── 结构化错误包装 ────────────────────────────────────────────────────── */

/** 参数类错误的关键词：模型据此判断"改参数重试"还是"放弃"。 */
const BAD_INPUT_PATTERN = /非法|invalid|required|不能为空|not found|不存在/i;

/** 从任意抛出物里取消息。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 为什么需要：同一类错误（对象不存在 / 参数非法）此前有两种形态 ——
 * 有的工具 `return { ok:false, error }`，有的直接抛。模型拿到前者能换参数重试，
 * 拿到后者往往直接放弃这一次调用，行为不可预测。统一成前者，且**不吞原始信息**。
 *
 * 注意返回类型仍是 `string`：错误也走同一个通道，模型看到的格式保持一致。
 */
export function withStructuredErrors<Ps extends Record<string, ParamDecl>>(
  tool: TypedToolDefinition<Ps>,
): TypedToolDefinition<Ps> {
  const inner = tool.execute;
  return {
    ...tool,
    async execute(args: ArgsOf<Ps>, exec: ToolExecContext): Promise<string> {
      try {
        return await inner(args, exec);
      } catch (error) {
        const message = messageOf(error);
        const kind: ToolFailure["error_kind"] = BAD_INPUT_PATTERN.test(message) ? "bad_input" : "failed";
        return failureJson({
          ok: false,
          error: message,
          error_kind: kind,
          hint:
            kind === "bad_input"
              ? "这是参数或对象标识的问题：核对参数名与取值（可用对应的 *_list / *_query 工具先看实际 id），修正后重试。"
              : "工具执行失败，错误原文见 error 字段；不要静默跳过，先向用户或指挥者说明卡点。",
        });
      }
    },
  };
}

/* ── 注册桥 ────────────────────────────────────────────────────────────── */

/**
 * 把类型化声明递归转成宿主声明（剥掉 `undefined` 键）。
 *
 * 单独成函数是因为 `items` 也可能是嵌套声明（数组元素、对象属性）。
 */
function toHostParam(decl: ParamDecl): ToolParamDecl {
  const out: Record<string, unknown> = { type: decl.type };
  if (decl.description !== undefined) out["description"] = decl.description;
  if (decl.required !== undefined) out["required"] = decl.required;
  if (decl.enum !== undefined) out["enum"] = decl.enum;
  if (decl.default !== undefined) out["default"] = decl.default;
  if (decl.items !== undefined) out["items"] = toHostParam(decl.items);
  if (decl.properties !== undefined) {
    const props: Record<string, ToolParamDecl> = {};
    for (const [key, sub] of Object.entries(decl.properties)) props[key] = toHostParam(sub);
    out["properties"] = props;
    /* 宿主 schema 对对象参数用 additionalProperties 控制严格度；原实现一律 false */
    out["additionalProperties"] = false;
  }
  return out as unknown as ToolParamDecl;
}

/**
 * 把类型化定义转成宿主能收的形状。
 *
 * 宿主的 `ToolRegistry.register` 声明收 `ToolDefinition<never|Record<string,unknown>, unknown>`。
 * 我们的 `args` 是从 schema 推导的具体类型，与 `Record<string, unknown>` 不兼容
 * （这是**有意的**：真正的类型安全在工具内部，注册边界是唯一放宽的地方）。
 *
 * 所以放宽只发生在这一处，并且用 `unknown` 中转而不是 `any` ——
 * `any` 会污染整条链，`unknown` 需要显式断言。
 */
export function toHostTool<Ps extends Record<string, ParamDecl>>(tool: TypedToolDefinition<Ps>): ToolDefinition {
  const parameters: Record<string, ToolParamDecl> = {};
  for (const [key, decl] of Object.entries(tool.parameters)) {
    parameters[key] = toHostParam(decl);
  }
  const definition: ToolDefinition = {
    name: tool.name,
    description: tool.description,
    parameters,
    ...(tool.output === undefined
      ? {}
      : {
          output: {
            schema: tool.output.schema,
            ...(tool.output.render === undefined
              ? {}
              : { render: (args: unknown, value: unknown): unknown => tool.output?.render?.(args, value as string) }),
          },
        }),
    execute: async (args: Record<string, unknown>, exec: ToolExecContext): Promise<unknown> => {
      /* 注册边界：宿主按 JSON Schema 校验后的参数进来，信任它符合我们的声明 */
      return tool.execute(args as unknown as ArgsOf<Ps>, exec);
    },
  };
  return definition;
}

/**
 * 文本渲染器：把 execute 返回的字符串包成宿主能显示的 content 数组。
 *
 * 原实现：`(value) => [{ type: 'text', text: value }]`。
 */
export function renderText(_args: unknown, value: ToolExecuteResult): readonly { readonly type: "text"; readonly text: string }[] {
  return [{ type: "text", text: value }];
}

/**
 * 任意一个具体的工具定义（擦掉 `parameters` 的具体形状，但**保留** `execute` 的类型）。
 *
 * 用于「一组工具」的返回类型：`readonly TypedToolDefinition<never>[]` 会让
 * `parameters: never` 变得无法构造（`never` 不接受任何具体 schema），
 * 而 `readonly AnyTypedTool[]` 正好表达"一组类型各异的工具"。
 */
export type AnyTypedTool = TypedToolDefinition<Record<string, ParamDecl>>;
