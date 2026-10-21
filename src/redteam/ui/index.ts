/**
 * 控制台 Host 半侧的出口。
 *
 * 分三层暴露，边界清楚：
 * - **`protocol`**：线上 JSON 契约（错误分类、状态码派生）。
 * - **`ops`**：op 词汇表与载荷校验（80 个 op）。
 * - **`bridge` / `server`**：请求管线与 HTTP 适配。
 *
 * `origin` / `body` / `extract` 单独导出：它们各自有独立职责与测试，
 * 但 `bridge` 已经用了它们，所以这里不做隐藏。
 */

export {
  apiError,
  apiOk,
  statusOf,
} from "./protocol.js";
export type { ApiBody, ApiErrorBody, ApiErrorCode } from "./protocol.js";

export {
  GATEWAY_OP_NAMES,
  OP_NAMES,
  OP_TABLE,
  STORE_OP_NAMES,
  describe,
  fieldBoolean,
  fieldNumber,
  fieldString,
  fieldUnknown,
  isOpName,
  parseRequest,
} from "./ops.js";
export type {
  FieldType,
  GatewayOp,
  OpKind,
  OpMeta,
  OpName,
  ParseFailure,
  ParsedRequest,
  StoreOp,
} from "./ops.js";

export { checkOrigin, isLocalHost, isLoopbackAddress, originHostOf, readOriginFacts } from "./origin.js";
export type { OriginDecision, RequestOriginFacts } from "./origin.js";

export { MAX_BODY_BYTES, messageOf, readBody } from "./body.js";
export type { BodyFailure, ReadableRequest } from "./body.js";

export { handleGateway, GATEWAY_LOCAL_OPS } from "./gateway.js";
export type {
  GatewayPorts,
  GatewayResult,
  InstallInfo,
  PluginIdentity,
  SessionRegistry,
  SkillEntry,
  SkillService,
  SubagentRegistry,
  UpdateApply,
  UpdateCheck,
  UpdatePreflight,
} from "./gateway.js";

export { handleRequest, normalizeStringField, peekOp } from "./bridge.js";
export type { BridgePorts, BridgeRequest, BridgeResponse, StorePort } from "./bridge.js";

export { serveRequest, writeJsonResponse } from "./server.js";
export type { WritableResponse } from "./server.js";

export {
  FACTORY_BEGIN,
  FACTORY_END,
  byteLength,
  describeFragment,
  embedFragment,
  extractFragment,
  toLf,
  verifyRoundTrip,
  wrapFragment,
} from "./extract.js";
export type { ExtractedFragment, MarkerError } from "./extract.js";

/**
 * 客户端产物装配（源码 → `client.js`）。
 *
 * 这三个是 `scripts/build-client.mjs` 的全部依赖面：构建脚本只用
 * `defaultTemplate` + `assemble` 就能产出宿主契约文件，因此**装配逻辑
 * 只有一份**，脚本里不再有第二套拼接代码。
 *
 * `HostTemplate` 之所以一起导出：测试要能给自定义 id / 自定义 prologue
 * 的模板跑装配，而不必复制 `defaultTemplate` 的结构。
 */
export { assemble, assembleNormalized, defaultTemplate, describeArtifact, fragmentOf, isUpToDate, renderTemplate } from "./build.js";
export type { AssembleError, AssembleResult, HostTemplate } from "./build.js";
