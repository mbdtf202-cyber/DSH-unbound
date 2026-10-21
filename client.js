/**
 * RedTeam 控制台 —— 浏览器半侧（生成产物，勿手改）。
 *
 * 由 src/redteam/ui/build.ts 从 src/redteam/client/ 装配；
 * 标记之间是编译后的工厂正文，改源码后重跑构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-unbound',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useCallback, Component } = React

/* @dsh-unbound:factory-begin */
/* ── AMD 运行时 shim（由 scripts/build-client.mjs 注入，不是 tsc 输出） ──
 *
 * 只做三件事：登记 define、lazy 解析依赖、给外部依赖（react）留一个通透口。
 * 不含任何模块逻辑 —— 模块正文全部来自下面的 tsc 输出，一字未改。 */
var __amdRegistry = new Map()
var __amdInstances = new Map()

function __amdDefine(id, deps, factory) {
  __amdRegistry.set(id, { deps: deps, factory: factory })
}

/** 实例化一个模块（懒、幂等）。循环依赖时先返回半成品 exports。 */
function __amdLoad(id) {
  var cached = __amdInstances.get(id)
  if (cached !== undefined) return cached
  var entry = __amdRegistry.get(id)
  if (entry === undefined) {
    throw new Error("[dsh-unbound] 产物缺少模块：" + id + "（构建 include 漏了它）")
  }
  // 先占位再执行工厂：循环依赖回指自己时拿到同一个 exports 对象。
  var module = { exports: {} }
  __amdInstances.set(id, module.exports)
  var args = entry.deps.map(function (dep) {
    if (dep === "require") return __amdRequire
    if (dep === "exports") return module.exports
    if (dep === "module") return module
    return __amdLoad(dep)
  })
  entry.factory.apply(null, args)
  // 工厂可能整体替换 module.exports（tsc 的 AMD 输出不会，但保留正确语义）。
  __amdInstances.set(id, module.exports)
  return module.exports
}

/** 内部 require：宿主 provide 的走宿主，我们打进去的走登记表。 */
function __amdRequire(id) {
  if (id === "react") return React
  return __amdLoad(id)
}

/* tsc 把下面这部份当作全局 AMD define 调用；别名过来喂给我们的登记表。 */
var define = __amdDefine

/* ── 以下为 tsc --module AMD --outFile 的原样输出（未改写） ────────── */
/**
 * 最小浏览器类型声明。
 *
 * ## 为什么不引入 `lib.dom`
 *
 * `tsconfig.json` 的 `lib` 只有 `["ES2023"]` —— 这是**故意的**：
 * 本仓库的主体是 Node 侧库代码（补丁引擎、文件操作、宿主交互），
 * 一旦把整套 DOM 类型塞进全局，`fetch` / `setTimeout` / `document`
 * 这些名字会与 Node 侧的 `node:timers`、`undici` 等声明**竞争合并**，
 * 典型症状是 `fetch` 的返回类型在两个库之间反复覆盖，报错指向用户代码。
 *
 * 浏览器半侧真正用到的 DOM 面积很小（就 6 个全局 + 若干属性），
 * 手写一遍反而更准，也把「这一层依赖浏览器」标得清清楚楚。
 *
 * ## 覆盖范围
 *
 * 只声明**本模块真正读取**的成员。多写一个就多一处需要跟上游对齐的负担。
 */
define("redteam/client/dom", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
});
/**
 * 浏览器侧的桥接客户端：`POST /redteam/api`。
 *
 * ## 原实现的一个真实缺陷
 *
 * ```js
 * const api = (req) => fetch('/redteam/api', {...}).then(async (res) => {
 *   const text = await res.text().catch(() => '')
 *   ...
 * })
 * ```
 *
 * **`fetch` 本身没有 catch**。宿主重启、网络断开、请求被 CORS 预检拦掉时，
 * `fetch` 会 reject —— 而这个 reject 会沿着 Promise 链冒到每个调用点的
 * `.then(...)` 第二参数。原实现的调用点有两种写法：
 *
 * ```js
 * api({...}).then((r) => {...})              // 没有 onRejected → unhandled rejection
 * api({...}).then((r) => {...}, () => {...}) // 有
 * ```
 *
 * 前者占多数（如 `api({ op: 'activateEngagement' }).catch(() => {})` 有 catch，
 * 但 `api({ op: 'domains' }).then(...)` 只有一个参数）。未处理的 rejection
 * 在浏览器控制台里是一条红字，在 Electron 里可能触发 `unhandledRejection`
 * 处理器 —— 而且界面上的 loading 状态**永远不结束**。
 *
 * 这里统一成「**永不 reject**」：任何失败都变成 `{ ok: false, error, code }`，
 * 调用点只需要判 `ok`。这是桥接层的契约，与 Host 半侧的 `ApiErrorBody` 对齐。
 *
 * ## 错误分类透传
 *
 * Host 半侧现在返回 `code`（`unknown_op` / `cross_origin` / `body_too_large` …）。
 * 这里原样透传，调用点可据此分支，不必解析文案。
 */
define("redteam/client/api", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.API_PATH = void 0;
    exports.makeApi = makeApi;
    exports.messageOfCause = messageOfCause;
    exports.makeApiClient = makeApiClient;
    /** 桥接端点。 */
    exports.API_PATH = "/redteam/api";
    /**
     * 造一个 api 客户端。
     *
     * `deps` 注入而不是直接读全局 `fetch`：测试里可以喂任意响应，
     * 也不必在 Node 下伪造 `globalThis.fetch`。
     */
    function makeApi(deps) {
        const path = deps.path ?? exports.API_PATH;
        const fetchFn = deps.fetch;
        return async function api(request) {
            let response;
            try {
                response = await fetchFn(path, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(request),
                });
            }
            catch (cause) {
                // 网络层失败（宿主重启、断网、CORS 预检）：**不能 reject**，
                // 否则调用点的 loading 状态永远不会结束。
                return {
                    ok: false,
                    code: "network_error",
                    error: "无法连接控制台后端：" + messageOfCause(cause),
                };
            }
            let text;
            try {
                text = await response.text();
            }
            catch (cause) {
                return {
                    ok: false,
                    code: "read_error",
                    error: "读取响应失败（" + String(response.status) + "）：" + messageOfCause(cause),
                };
            }
            // 空体：桥接层永远返回 JSON，空体说明不是我们的响应（代理拦截页之类）。
            if (text === "") {
                return {
                    ok: false,
                    code: response.ok ? "empty_response" : "http_error",
                    error: response.status + " " + response.statusText + "（响应体为空）",
                };
            }
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                // 非 JSON：很可能是反向代理的错误页。截 120 字符便于定位，不刷屏。
                return {
                    ok: false,
                    code: "invalid_json",
                    error: response.status + " non-json: " + text.slice(0, 120),
                };
            }
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                return {
                    ok: false,
                    code: "invalid_shape",
                    error: "响应不是 JSON 对象：" + text.slice(0, 120),
                };
            }
            const body = parsed;
            if (!response.ok) {
                // 非 2xx：Host 半侧的错误响应带 `error`；兜底用状态行。
                const hostError = body["error"];
                const hostMessage = body["message"];
                const message = typeof hostError === "string"
                    ? hostError
                    : typeof hostMessage === "string"
                        ? hostMessage
                        : response.status + " " + response.statusText;
                return {
                    ...body,
                    ok: false,
                    code: typeof body["code"] === "string" ? body["code"] : "http_error",
                    error: message,
                };
            }
            // 2xx：Host 半侧的成功响应是扁平的。`ok` 缺失说明它不是我们的契约，
            // 按成功处理（业务体里可能没有 ok 字段），但补上 `ok: true` 便于调用点判断。
            const ok = body["ok"];
            if (typeof ok === "boolean")
                return body;
            return { ...body, ok: true };
        };
    }
    /** 从任意异常里取一段可读文案。 */
    function messageOfCause(cause) {
        if (cause instanceof Error)
            return cause.message;
        if (typeof cause === "string")
            return cause;
        if (typeof cause === "object" && cause !== null) {
            const candidate = cause["message"];
            if (typeof candidate === "string")
                return candidate;
        }
        return String(cause);
    }
    /** 造带类型包装的客户端。 */
    function makeApiClient(deps) {
        const raw = makeApi(deps);
        return {
            raw,
            snapshot: (engagement) => raw({ op: "snapshot", engagement }),
            assets: (engagement, filter) => raw({ op: "assets", engagement, ...filter }),
            asset: (engagement, id) => raw({ op: "asset", engagement, id }),
            vulns: (engagement, filter) => raw({ op: "vulns", engagement, ...filter }),
            sessions: (engagement) => raw({ op: "sessions", engagement }),
            chain: (engagement) => raw({ op: "chain", engagement }),
            scores: (engagement) => raw({ op: "scores", engagement }),
            report: (engagement) => raw({ op: "report", engagement }),
            consoleDigest: (engagement) => raw({ op: "consoleDigest", engagement }),
            shotData: (engagement, id) => raw({ op: "shotData", engagement, id }),
            activateEngagement: (engagement) => raw({ op: "activateEngagement", engagement }),
        };
    }
});
/**
 * 统一结果类型。
 *
 * 原项目大量函数「成功返回对象、失败抛异常、再被 catch 吞掉」，
 * 导致失败与「没有数据」无法区分。新代码对**预期内**的失败用 Result，
 * 对**编程错误**才抛。
 */
define("shared/result", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ok = ok;
    exports.err = err;
    exports.unwrapOr = unwrapOr;
    exports.unwrap = unwrap;
    function ok(value) {
        return { ok: true, value };
    }
    function err(error) {
        return { ok: false, error };
    }
    /** 取值，失败时返回 fallback。 */
    function unwrapOr(r, fallback) {
        return r.ok ? r.value : fallback;
    }
    /** 抛异常的取值，用于「失败即 bug」的位置。 */
    function unwrap(r) {
        if (!r.ok)
            throw new Error(typeof r.error === "string" ? r.error : JSON.stringify(r.error));
        return r.value;
    }
});
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
define("redteam/client/label", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.PRIORITY_ORDER = exports.TEST_STATUS_ORDER = exports.POC_CAT_ORDER = exports.PROVENANCE_LABEL = exports.POC_CATEGORY_LABEL = exports.SHOT_KIND_LABEL = exports.ROLE_LABEL = exports.PRIORITY_LABEL = exports.TEST_STATUS_LABEL = void 0;
    exports.labelOf = labelOf;
    exports.testStatusLabel = testStatusLabel;
    exports.priorityLabel = priorityLabel;
    exports.roleLabel = roleLabel;
    exports.shotKindLabel = shotKindLabel;
    exports.pocCategoryLabel = pocCategoryLabel;
    exports.provenanceLabel = provenanceLabel;
    /** 资产测试状态 → 中文。 */
    exports.TEST_STATUS_LABEL = Object.freeze({
        untested: "未测试",
        testing: "测试中",
        tested: "已测试",
        blocked: "被封禁",
        abandoned: "已放弃",
        no_surface: "无攻击面",
    });
    /** 资产优先级 → 中文。 */
    exports.PRIORITY_LABEL = Object.freeze({
        high: "高",
        medium: "中",
        low: "低",
    });
    /** 角色 code → 中文（报告/知识库要标「谁发现的」）。 */
    exports.ROLE_LABEL = Object.freeze({
        plan: "主会话（指挥）",
        recon: "信息收集",
        assess: "资产梳理",
        "vuln-scan": "漏洞发现",
        exploit: "漏洞利用",
        internal: "内网渗透",
    });
    /** 证据类型 → 中文。 */
    exports.SHOT_KIND_LABEL = Object.freeze({
        screenshot: "现场截图",
        card: "记录生成的证据摘录",
    });
    /** 知识库分类 → 中文。 */
    exports.POC_CATEGORY_LABEL = Object.freeze({
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
    });
    /** 证据来源 → 中文。 */
    exports.PROVENANCE_LABEL = Object.freeze({
        passive: "被动",
        active: "主动",
    });
    /** 知识库分类的**显示顺序**（面板按它分组）。 */
    exports.POC_CAT_ORDER = Object.freeze(Object.keys(exports.POC_CATEGORY_LABEL));
    /** 资产测试状态的全部取值（顺序即下拉框顺序）。 */
    exports.TEST_STATUS_ORDER = Object.freeze(Object.keys(exports.TEST_STATUS_LABEL));
    /** 资产优先级的全部取值（由高到低）。 */
    exports.PRIORITY_ORDER = Object.freeze(Object.keys(exports.PRIORITY_LABEL));
    /**
     * 查表，缺值时回退到原始 key。
     *
     * 不用 `?? '未知'` 统一兜底：原实现对未知状态显示原始 code
     * （`TEST_LABEL[st] || st`），这样上游加了新状态时界面不会变成一片「未知」，
     * 而是直接暴露新 code —— 便于发现「后端加了状态但前端没跟上」。
     */
    function labelOf(table, key) {
        if (typeof key !== "string")
            return "";
        return table[key] ?? key;
    }
    /** 测试状态的中文名。 */
    function testStatusLabel(value) {
        return labelOf(exports.TEST_STATUS_LABEL, value);
    }
    /** 优先级的中文名。 */
    function priorityLabel(value) {
        return labelOf(exports.PRIORITY_LABEL, value);
    }
    /** 角色的中文名。 */
    function roleLabel(value) {
        return labelOf(exports.ROLE_LABEL, value);
    }
    /** 证据类型的中文名。 */
    function shotKindLabel(value) {
        return labelOf(exports.SHOT_KIND_LABEL, value);
    }
    /** 知识库分类的中文名。 */
    function pocCategoryLabel(value) {
        return labelOf(exports.POC_CATEGORY_LABEL, value);
    }
    /**
     * 证据来源的中文名。
     *
     * 与 `labelOf` 不同：这里**要**兜底成「未知」，因为来源只有两种，
     * 第三种取值说明数据坏了，界面上标「未知」比显示原始值更有用。
     */
    function provenanceLabel(value) {
        if (value === "passive")
            return exports.PROVENANCE_LABEL.passive;
        if (value === "active")
            return exports.PROVENANCE_LABEL.active;
        return "未知";
    }
});
/**
 * 资产测绘页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `AssetsTab`（436 行）把 5 件事揉在同一个组件里：
 *
 * 1. **12 个 `useState`** 的过滤条件（`cidr` / `q` / `qApplied` / `service` /
 *    `port` / `prov` / `testStatus` / `priority` / `scope` / `assetState` /
 *    `sort` / `showAll`），其中 `q` 与 `qApplied` 是**两个**值 —— 输入框
 *    自由输入、回车/点搜索才生效。
 * 2. 4 种视图（列表 / 发现时间 / 域名 / Web）+ 一个内嵌的「当前测试」。
 * 3. 结论行的**六种点击语义**（互斥 + 组合键 `abandoned,blocked`）。
 * 4. 三张子表的响应解析（`domains` / `web` / `discoveryTimeline`）。
 * 5. 端口与指纹的**文本收敛**（最多 3 个端口 + `+N`、指纹截 30 字符）。
 *
 * 这里把 1–4 全部搬出来，逐条钉死；`assets-tab.ts` 只留排版。
 *
 * ## 一个容易迁错的语义：结论行的互斥
 *
 * ```js
 * const toggleTest = (v) => { setTestStatus(cur => cur === v ? '' : v); setAssetState('') }
 * ```
 *
 * 「待测 / 测试中 / 已测 / 放弃」四个键**共用** `testStatus` 一个字段（后者是
 * `'abandoned,blocked'` 这样一个**逗号组合值**），且点它们时**必然清掉**
 * `assetState`；而「存活」键只动 `assetState` 且清掉 `testStatus`；
 * 「全部」键清掉除 `sort` 之外的一切。四个分支的清除范围各不相同，
 * 迁漏一个就会出现「点全部之后筛选没撤干净」。
 */
define("redteam/client/assets-model", ["require", "exports", "shared/result", "redteam/client/label"], function (require, exports, result_js_1, label_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NO_ENGAGEMENT_TEXT = exports.DISCOVERY_NOTE = exports.VIEW_BUTTONS = exports.MAX_OBSERVATIONS = exports.MAX_FINGERPRINT_CHARS = exports.MAX_SHOWN_PORTS = exports.DEFAULT_ASSET_FILTER = exports.GIVEUP_STATUS_COMBINED = exports.TEST_STATUS_OPTIONS = exports.PRIORITY_OPTIONS = exports.PROVENANCE_OPTIONS = exports.SCOPE_OPTIONS = exports.SORT_OPTIONS = exports.EMPTY_ASSET_LIST = void 0;
    exports.scopeOf = scopeOf;
    exports.scopeShortLabel = scopeShortLabel;
    exports.scopeLongLabel = scopeLongLabel;
    exports.segmentsOf = segmentsOf;
    exports.groupSegments = groupSegments;
    exports.totalAssetsOf = totalAssetsOf;
    exports.segmentTitle = segmentTitle;
    exports.assetOf = assetOf;
    exports.assetListOf = assetListOf;
    exports.assetDetailOf = assetDetailOf;
    exports.detailFor = detailFor;
    exports.hasConclusionFilter = hasConclusionFilter;
    exports.assetsRequest = assetsRequest;
    exports.applyConclusion = applyConclusion;
    exports.isConclusionActive = isConclusionActive;
    exports.conclusionStatsOf = conclusionStatsOf;
    exports.conclusionItems = conclusionItems;
    exports.openPortsOf = openPortsOf;
    exports.portLabel = portLabel;
    exports.portSummary = portSummary;
    exports.fingerprintLabel = fingerprintLabel;
    exports.fingerprintSummary = fingerprintSummary;
    exports.portServiceText = portServiceText;
    exports.fingerprintDetailText = fingerprintDetailText;
    exports.observationText = observationText;
    exports.noteLinesOf = noteLinesOf;
    exports.namesText = namesText;
    exports.testMetaText = testMetaText;
    exports.assessText = assessText;
    exports.surfaceText = surfaceText;
    exports.provenanceText = provenanceText;
    exports.assessLongText = assessLongText;
    exports.domainGroupsOf = domainGroupsOf;
    exports.webAssetsOf = webAssetsOf;
    exports.webAssetUrl = webAssetUrl;
    exports.webServiceText = webServiceText;
    exports.discoveryOf = discoveryOf;
    exports.filterDiscoveryByDay = filterDiscoveryByDay;
    exports.discoverySpanText = discoverySpanText;
    exports.domainsRequest = domainsRequest;
    exports.webRequest = webRequest;
    exports.assetRequest = assetRequest;
    exports.discoveryRequest = discoveryRequest;
    exports.loadAssets = loadAssets;
    exports.loadDomains = loadDomains;
    exports.loadWebAssets = loadWebAssets;
    exports.loadAssetDetail = loadAssetDetail;
    exports.loadDiscovery = loadDiscovery;
    exports.listEmptyText = listEmptyText;
    exports.domainEmptyText = domainEmptyText;
    exports.webEmptyText = webEmptyText;
    exports.sideGroupKey = sideGroupKey;
    /* ══════════════════════════════════════════════════════════════ 窄化原语 */
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象（数组与 null 都算没有）。 */
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组（其它形态 → 空数组）。 */
    function arrayOf(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 从不可信值读计数（非有限或负数 → 0）。 */
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 从不可信值读可空字符串（`""` → `null`）。 */
    function nullableText(value) {
        return typeof value === "string" && value !== "" ? value : null;
    }
    /** 归一归属：除 `internal` 之外一律算外网（与原实现的二选一一致）。 */
    function scopeOf(value) {
        return value === "internal" ? "internal" : "external";
    }
    /** 归属徽章的短标签（列表里占一列，只能是单字）。 */
    function scopeShortLabel(scope) {
        return scope === "internal" ? "内" : "外";
    }
    /** 归属徽章的完整标签。 */
    function scopeLongLabel(scope) {
        return scope === "internal" ? "内网资产" : "外网资产";
    }
    /** 解析 `snapshot.segments`。 */
    function segmentsOf(response) {
        return arrayOf(recordOf(response)["segments"])
            .map((raw) => {
            const entry = recordOf(raw);
            return {
                cidr: text(entry["cidr"]),
                org: text(entry["org"]),
                assets: countOrZero(entry["assets"]),
                live: countOrZero(entry["live"]),
                openPorts: countOrZero(entry["open_ports"]) || countOrZero(entry["openPorts"]),
                passivePorts: countOrZero(entry["passive_ports"]) || countOrZero(entry["passivePorts"]),
                activePorts: countOrZero(entry["active_ports"]) || countOrZero(entry["activePorts"]),
                scope: scopeOf(entry["scope"]),
            };
        })
            // 没有 cidr 的段无法筛选（点它会发一个空 cidr 的请求），丢掉。
            .filter((segment) => segment.cidr !== "");
    }
    /** 分组。 */
    function groupSegments(segments) {
        return {
            external: segments.filter((segment) => segment.scope !== "internal"),
            internal: segments.filter((segment) => segment.scope === "internal"),
        };
    }
    /** 一组 C 段的资产总数（侧栏组标题右侧的那个数字）。 */
    function totalAssetsOf(segments) {
        return segments.reduce((sum, segment) => sum + segment.assets, 0);
    }
    /**
     * C 段的悬浮提示。
     *
     * 原实现：`(s.org || '未知归属') + ' · 存活 ' + live + '/' + assets + ' 台'`
     * —— 端口数不占位，归属与存活都塞进 title。
     */
    function segmentTitle(segment) {
        const org = segment.org !== "" ? segment.org : "未知归属";
        return org + " · 存活 " + segment.live + "/" + segment.assets + " 台";
    }
    /** 解析一个端口。 */
    function portOf(raw) {
        const entry = recordOf(raw);
        return {
            port: countOrZero(entry["port"]),
            proto: text(entry["proto"]) || "tcp",
            state: text(entry["state"]),
            provenance: text(entry["provenance"]),
            url: nullableText(entry["url"]),
            title: text(entry["title"]),
            service: text(entry["service"]),
            product: text(entry["product"]),
            version: text(entry["version"]),
        };
    }
    /** 解析一个指纹。 */
    function fingerprintOf(raw) {
        const entry = recordOf(raw);
        return {
            category: text(entry["category"]),
            vendor: text(entry["vendor"]),
            product: text(entry["product"]),
            version: text(entry["version"]),
            evidence: text(entry["evidence"]),
            provenance: text(entry["provenance"]),
        };
    }
    /** 解析一个观测。 */
    function observationOf(raw) {
        const entry = recordOf(raw);
        return {
            attr: text(entry["attr"]),
            value: text(entry["value"]),
            provenance: text(entry["provenance"]),
            tool: text(entry["tool"]),
            collectedAt: text(entry["collected_at"]) || text(entry["collectedAt"]),
        };
    }
    /** 解析一个资产。 */
    function assetOf(raw) {
        const entry = recordOf(raw);
        return {
            id: countOrZero(entry["id"]),
            ip: text(entry["ip"]),
            segmentCidr: text(entry["segment_cidr"]) || text(entry["segmentCidr"]),
            scope: scopeOf(entry["scope"]),
            state: text(entry["state"]),
            priority: text(entry["priority"]),
            potential: text(entry["potential"]),
            assessReason: text(entry["assess_reason"]) || text(entry["assessReason"]),
            assessedAt: text(entry["assessed_at"]) || text(entry["assessedAt"]),
            testStatus: text(entry["test_status"]) || text(entry["testStatus"]),
            blockedCount: countOrZero(entry["blocked_count"]) || countOrZero(entry["blockedCount"]),
            testSurface: text(entry["test_surface"]) || text(entry["testSurface"]),
            testNotes: text(entry["test_notes"]) || text(entry["testNotes"]),
            testUpdatedAt: text(entry["test_updated_at"]) || text(entry["testUpdatedAt"]),
            testUpdatedBy: text(entry["test_updated_by"]) || text(entry["testUpdatedBy"]),
            discoveredAt: text(entry["discovered_at"]) || text(entry["discoveredAt"]),
            lastSeen: text(entry["last_seen"]) || text(entry["lastSeen"]),
            firstSeen: text(entry["first_seen"]) || text(entry["firstSeen"]),
            passive: countOrZero(entry["passive"]),
            active: countOrZero(entry["active"]),
            ports: arrayOf(entry["ports"]).map(portOf),
            fingerprints: arrayOf(entry["fingerprints"]).map(fingerprintOf),
            names: arrayOf(entry["names"]).map((name) => ({ name: text(recordOf(name)["name"]) })).filter((name) => name.name !== ""),
            observations: arrayOf(entry["observations"]).map(observationOf),
        };
    }
    /** 空列表状态（未加载 / 无数据）。 */
    exports.EMPTY_ASSET_LIST = Object.freeze({
        loading: false,
        error: null,
        total: 0,
        items: [],
    });
    /** 解析 `op: assets` 的响应。 */
    function assetListOf(response) {
        const body = recordOf(response);
        return {
            loading: false,
            error: null,
            total: countOrZero(body["total"]),
            items: arrayOf(body["items"]).map(assetOf),
        };
    }
    /** 解析 `op: asset` 的响应（单台详情）。 */
    function assetDetailOf(response) {
        const body = recordOf(response);
        if (body["ok"] === false)
            return null;
        const asset = body["asset"];
        if (typeof asset !== "object" || asset === null)
            return null;
        const parsed = assetOf(asset);
        return parsed.id > 0 ? parsed : null;
    }
    /**
     * 取要展开的详情。
     *
     * 原实现：`detail && detail.id === it.id ? detail : null` ——
     * 详情响应回来得比切换慢时，**不能**把上一台的详情显示在下一台下面。
     */
    function detailFor(item, detail) {
        return detail !== null && detail.id === item.id ? detail : null;
    }
    /** 排序选项（顺序即下拉框顺序）。 */
    exports.SORT_OPTIONS = Object.freeze([
        { value: "priority", label: "排序：易打性优先" },
        { value: "todo", label: "排序：待测优先" },
        { value: "discovered", label: "排序：最近发现优先" },
        { value: "ports", label: "排序：端口多优先" },
        { value: "ip", label: "排序：按 IP" },
    ]);
    /** 归属筛选选项。 */
    exports.SCOPE_OPTIONS = Object.freeze([
        { value: "", label: "内外网不限" },
        { value: "external", label: "仅外网资产" },
        { value: "internal", label: "仅内网资产" },
    ]);
    /** 端口来源筛选选项。 */
    exports.PROVENANCE_OPTIONS = Object.freeze([
        { value: "", label: "来源不限" },
        { value: "passive", label: "仅被动" },
        { value: "active", label: "仅主动" },
    ]);
    /** 易打性筛选选项。 */
    exports.PRIORITY_OPTIONS = Object.freeze([
        { value: "", label: "易打性不限" },
        { value: "high", label: "易打（高）" },
        { value: "medium", label: "一般（中）" },
        { value: "low", label: "难打（低）" },
    ]);
    /** 测试状态筛选选项（由共享标签表派生，顺序即后端枚举顺序）。 */
    exports.TEST_STATUS_OPTIONS = Object.freeze([
        { value: "", label: "测试状态不限" },
        ...label_js_1.TEST_STATUS_ORDER.map((code) => ({
            value: code,
            label: label_js_1.TEST_STATUS_LABEL[code] ?? code,
        })),
    ]);
    /**
     * 测试状态筛选里的**组合值**：结论行的「放弃」= 已放弃 + 被封禁。
     *
     * 它是唯一一个逗号组合，后端按 `IN` 拆开处理（见 store 的 `listAssets`）。
     */
    exports.GIVEUP_STATUS_COMBINED = "abandoned,blocked";
    /** 默认过滤：全部资产、易打性优先。 */
    exports.DEFAULT_ASSET_FILTER = Object.freeze({
        cidr: null,
        query: "",
        service: "",
        port: "",
        provenance: "",
        testStatus: "",
        priority: "",
        scope: "",
        state: "",
        sort: "priority",
    });
    /**
     * 是否有任何筛选生效（「全部」结论键的高亮判定）。
     *
     * 原实现：`!testStatus && !priority && !scope && !prov && !assetState && !cidr`
     * —— **不含** `query` / `service` / `port`。这不是笔误：搜索与服务/端口是
     * 「查」而不是「筛家底」，把它们算进「已筛选」会让「全部」键在纯搜索时
     * 也高亮，看起来像「家底只剩搜索命中的那几台」。
     */
    function hasConclusionFilter(filter) {
        return filter.testStatus !== ""
            || filter.priority !== ""
            || filter.scope !== ""
            || filter.provenance !== ""
            || filter.state !== ""
            || filter.cidr !== null;
    }
    /** 构造 `op: assets` 的请求（空串视为不过滤）。 */
    function assetsRequest(engagement, filter) {
        return {
            op: "assets",
            engagement,
            cidr: filter.cidr !== null && filter.cidr !== "" ? filter.cidr : undefined,
            q: filter.query !== "" ? filter.query : undefined,
            service: filter.service !== "" ? filter.service : undefined,
            port: filter.port !== "" ? filter.port : undefined,
            provenance: filter.provenance !== "" ? filter.provenance : undefined,
            test_status: filter.testStatus !== "" ? filter.testStatus : undefined,
            priority: filter.priority !== "" ? filter.priority : undefined,
            scope: filter.scope !== "" ? filter.scope : undefined,
            state: filter.state !== "" ? filter.state : undefined,
            sort: filter.sort,
            limit: 400,
        };
    }
    /**
     * 点击结论行的**新过滤条件**。
     *
     * 四个分支的清除范围各不相同（原实现逐行不同），见文件头注释：
     * - `all`：清掉 everything（除 sort）
     * - `live`：只切 `state`，并清掉 `testStatus`
     * - `untested` / `testing` / `tested`：切 `testStatus`，并清掉 `state`
     * - `giveup`：`testStatus` 设为组合值 `abandoned,blocked`，并清掉 `state`
     *
     * 切换语义是「再点一次取消」：值已经等于目标时清成空串。
     */
    function applyConclusion(filter, key) {
        switch (key) {
            case "all":
                return {
                    ...filter,
                    cidr: null,
                    testStatus: "",
                    priority: "",
                    scope: "",
                    provenance: "",
                    state: "",
                };
            case "live":
                return { ...filter, state: filter.state === "live" ? "" : "live", testStatus: "" };
            case "untested":
                return { ...filter, testStatus: filter.testStatus === "untested" ? "" : "untested", state: "" };
            case "testing":
                return { ...filter, testStatus: filter.testStatus === "testing" ? "" : "testing", state: "" };
            case "tested":
                return { ...filter, testStatus: filter.testStatus === "tested" ? "" : "tested", state: "" };
            case "giveup":
                return {
                    ...filter,
                    testStatus: filter.testStatus === exports.GIVEUP_STATUS_COMBINED ? "" : exports.GIVEUP_STATUS_COMBINED,
                    state: "",
                };
        }
    }
    /** 结论行高亮判定（与 `applyConclusion` 的分支一一对应）。 */
    function isConclusionActive(filter, key) {
        switch (key) {
            case "all":
                return !hasConclusionFilter(filter);
            case "live":
                return filter.state === "live";
            case "untested":
                return filter.testStatus === "untested";
            case "testing":
                return filter.testStatus === "testing";
            case "tested":
                return filter.testStatus === "tested";
            case "giveup":
                return filter.testStatus === exports.GIVEUP_STATUS_COMBINED;
        }
    }
    /** 从快照读计数。 */
    function conclusionStatsOf(snapshot) {
        const body = recordOf(snapshot);
        const stats = recordOf(body["stats"]);
        const tests = recordOf(body["tests"]);
        return {
            assets: countOrZero(stats["assets"]),
            liveAssets: countOrZero(stats["liveAssets"]) || countOrZero(stats["live_assets"]),
            untested: countOrZero(tests["untested"]),
            testing: countOrZero(tests["testing"]),
            tested: countOrZero(tests["tested"]),
            abandoned: countOrZero(tests["abandoned"]),
            blocked: countOrZero(tests["blocked"]),
        };
    }
    /** 六条结论项（顺序即界面顺序）。 */
    function conclusionItems(stats, filter) {
        return [
            { key: "all", label: "台资产", value: stats.assets, active: isConclusionActive(filter, "all") },
            { key: "live", label: "存活", value: stats.liveAssets, active: isConclusionActive(filter, "live") },
            { key: "untested", label: "待测", value: stats.untested, active: isConclusionActive(filter, "untested") },
            { key: "testing", label: "测试中", value: stats.testing, active: isConclusionActive(filter, "testing") },
            { key: "tested", label: "已测", value: stats.tested, active: isConclusionActive(filter, "tested") },
            {
                key: "giveup",
                label: "放弃",
                // 「放弃」是两类之和：已放弃 + 被封禁（后者往往是「被迫放弃」）。
                value: stats.abandoned + stats.blocked,
                active: isConclusionActive(filter, "giveup"),
            },
        ];
    }
    /* ══════════════════════════════════════════════════════════════ 列表行文本 */
    /** 只取状态为 open 的端口。 */
    function openPortsOf(item) {
        return item.ports.filter((port) => port.state === "open");
    }
    /** 端口的短标签：`443/https`（无服务名时只有端口）。 */
    function portLabel(port) {
        return String(port.port) + (port.service !== "" ? "/" + port.service : "");
    }
    /** 最多列 3 个端口，其余用 `+N`。 */
    exports.MAX_SHOWN_PORTS = 3;
    /** 收敛端口列文本。 */
    function portSummary(ports) {
        const open = ports.filter((port) => port.state === "open");
        const labels = open.map(portLabel);
        const full = labels.length > 0 ? labels.join(", ") : "—";
        const shownLabels = labels.slice(0, exports.MAX_SHOWN_PORTS).join(", ");
        const hidden = labels.length > exports.MAX_SHOWN_PORTS ? " +" + (labels.length - exports.MAX_SHOWN_PORTS) : "";
        return { shown: (shownLabels !== "" ? shownLabels : "—") + hidden, full };
    }
    /** 指纹列里单个指纹的文本：`厂商 产品 版本`（缺项自动跳过）。 */
    function fingerprintLabel(fingerprint) {
        return [fingerprint.vendor, fingerprint.product, fingerprint.version]
            .filter((part) => part !== "")
            .join(" ");
    }
    /** 指纹列最多显示的字符数（超出截断并加省略号）。 */
    exports.MAX_FINGERPRINT_CHARS = 30;
    /** 收敛指纹列文本。 */
    function fingerprintSummary(fingerprints) {
        const labels = fingerprints.map(fingerprintLabel).filter((label) => label !== "");
        const full = labels.length > 0 ? labels.join(" / ") : "—";
        return {
            shown: full.length > exports.MAX_FINGERPRINT_CHARS ? full.slice(0, exports.MAX_FINGERPRINT_CHARS) + "…" : full,
            full,
        };
    }
    /** 详情里端口的服务描述：`服务 产品 版本`，全空时「未知服务」。 */
    function portServiceText(port) {
        const joined = [port.service, port.product, port.version].filter((part) => part !== "").join(" ");
        return joined !== "" ? joined : "未知服务";
    }
    /** 详情里指纹的描述：`厂商 产品 版本（依据）`。 */
    function fingerprintDetailText(fingerprint) {
        const head = fingerprintLabel(fingerprint);
        return fingerprint.evidence !== ""
            ? head + "（" + fingerprint.evidence + "）"
            : head;
    }
    /** 详情里观测的文本：`值 · 工具 · 时间`。 */
    function observationText(observation, timeText) {
        return observation.value + " · " + (observation.tool !== "" ? observation.tool : "未知工具") + " · " + timeText;
    }
    /** 观测最多列 8 条（原实现的 `slice(0, 8)`）。 */
    exports.MAX_OBSERVATIONS = 8;
    /** 测试记录按行拆开（去掉空行）。 */
    function noteLinesOf(item) {
        return item.testNotes.split("\n").filter((line) => line !== "");
    }
    /** 主机名列表的文本（逗号分隔，空 → `—`）。 */
    function namesText(item) {
        const joined = item.names.map((name) => name.name).join(", ");
        return joined !== "" ? joined : "—";
    }
    /** 详情里「测试」行的尾部文本：`时间 · 角色`（没测过显示「未测过」）。 */
    function testMetaText(item, timeText) {
        const when = item.testUpdatedAt !== "" ? timeText : "未测过";
        return item.testUpdatedBy !== "" ? when + " · " + item.testUpdatedBy : when;
    }
    /** 详情里「易打性」行的文本：`预期 · 依据`。 */
    function assessText(item) {
        const potential = item.potential !== "" ? item.potential : "未评估";
        return item.assessReason !== "" ? potential + " · " + item.assessReason : potential;
    }
    /** 详情里「攻击面」行的文本。 */
    function surfaceText(item, openPortCount) {
        if (item.testSurface !== "")
            return item.testSurface;
        return openPortCount > 0 ? "未记录（开放端口见下）" : "无开放端口";
    }
    /** 详情里「来源」行的文本。 */
    function provenanceText(item) {
        return "被动端口 " + item.passive + " · 主动端口 " + item.active;
    }
    /** 详情里「易打性」长篇（展开全部后）：`优先级 · 预期 · 依据（时间）`。 */
    function assessLongText(item, timeText) {
        const priority = item.priority !== "" ? item.priority : "未评估";
        return priority
            + (item.potential !== "" ? " · 预期：" + item.potential : "")
            + (item.assessReason !== "" ? " · 依据：" + item.assessReason : "")
            + (item.assessedAt !== "" ? "（" + timeText + "）" : "");
    }
    /** 视图按钮（顺序即界面顺序）。 */
    exports.VIEW_BUTTONS = Object.freeze([
        { value: "list", label: "列表" },
        { value: "timeline", label: "发现时间", title: "按发现时间看资产（什么时候发现、哪天收了多少）" },
        { value: "domain", label: "域名" },
        { value: "web", label: "Web" },
    ]);
    /** 解析 `op: domains` 的响应。 */
    function domainGroupsOf(response) {
        return arrayOf(recordOf(response)["items"])
            .map((raw) => {
            const entry = recordOf(raw);
            const domain = text(entry["domain"]);
            const assets = arrayOf(entry["assets"]).map((assetRaw) => {
                const asset = recordOf(assetRaw);
                return {
                    id: countOrZero(asset["id"]),
                    ip: text(asset["ip"]),
                    segment: text(asset["segment"]),
                    state: text(asset["state"]),
                    names: arrayOf(asset["names"]).filter((name) => typeof name === "string"),
                };
            });
            return { domain, count: countOrZero(entry["count"]) || assets.length, assets };
        })
            .filter((group) => group.domain !== "");
    }
    /** 解析 `op: web` 的响应。 */
    function webAssetsOf(response) {
        return arrayOf(recordOf(response)["items"])
            .map((raw) => {
            const entry = recordOf(raw);
            return {
                portId: countOrZero(entry["port_id"]) || countOrZero(entry["portId"]),
                port: countOrZero(entry["port"]),
                url: text(entry["url"]),
                title: text(entry["title"]),
                ip: text(entry["ip"]),
                segmentCidr: text(entry["segment_cidr"]) || text(entry["segmentCidr"]),
                service: text(entry["service"]),
                product: text(entry["product"]),
                version: text(entry["version"]),
            };
        })
            .filter((asset) => asset.ip !== "");
    }
    /** 这些端口按 HTTPS 处理（原实现的白名单，逐字保留）。 */
    const HTTPS_PORTS = new Set([443, 8443, 9443]);
    /** 这些端口是默认端口，URL 里不写端口号。 */
    const DEFAULT_PORTS = new Set([80, 443]);
    /**
     * Web 资产的可点击 URL。
     *
     * 原实现：有 `url` 就用它，否则按端口推：
     * `http` + (443/8443/9443 ? `s` : ``) + `://` + ip + (80/443 ? `` : `:port`)
     * —— 端口白名单是硬编码的，这里逐字保留（改成「按证书判断」会改变既有链接）。
     */
    function webAssetUrl(asset) {
        if (asset.url !== "")
            return asset.url;
        const scheme = "http" + (HTTPS_PORTS.has(asset.port) ? "s" : "");
        const portPart = DEFAULT_PORTS.has(asset.port) ? "" : ":" + asset.port;
        return scheme + "://" + asset.ip + portPart;
    }
    /** Web 资产的服务描述（`服务 产品 版本`）。 */
    function webServiceText(asset) {
        return [asset.service, asset.product, asset.version].filter((part) => part !== "").join(" ");
    }
    /** 解析 `op: discoveryTimeline` 的响应（失败 → `null`）。 */
    function discoveryOf(response) {
        const body = recordOf(response);
        if (body["ok"] === false)
            return null;
        // 空响应（`null`）与「还没加载」要分开：前者是失败，后者由 props 的 `null` 表示。
        if (Object.keys(body).length === 0)
            return null;
        const span = recordOf(body["span"]);
        return {
            total: countOrZero(span["total"]),
            first: text(span["first"]),
            last: text(span["last"]),
            days: arrayOf(body["days"])
                .map((raw) => {
                const entry = recordOf(raw);
                return {
                    day: text(entry["day"]),
                    assets: countOrZero(entry["assets"]),
                    internal: countOrZero(entry["internal"]),
                    external: countOrZero(entry["external"]),
                };
            })
                .filter((day) => day.day !== ""),
            recent: arrayOf(body["recent"])
                .map((raw) => {
                const entry = recordOf(raw);
                return {
                    id: countOrZero(entry["id"]),
                    ip: text(entry["ip"]),
                    scope: scopeOf(entry["scope"]),
                    primaryName: text(entry["primary_name"]) || text(entry["primaryName"]),
                    discoveredAt: text(entry["discovered_at"]) || text(entry["discoveredAt"]),
                    lastSeen: text(entry["last_seen"]) || text(entry["lastSeen"]),
                    openPorts: countOrZero(entry["open_ports"]) || countOrZero(entry["openPorts"]),
                    priority: text(entry["priority"]),
                };
            })
                .filter((asset) => asset.ip !== ""),
        };
    }
    /**
     * 按天筛选「最近发现的资产」。
     *
     * 原实现：`day === '' || String(a.discovered_at || '').slice(0, 10) === day`
     * —— 比对的是 ISO 串的**前 10 个字符**（`YYYY-MM-DD`），不做时区换算。
     */
    function filterDiscoveryByDay(recent, day) {
        if (day === "")
            return recent;
        return recent.filter((asset) => asset.discoveredAt.slice(0, 10) === day);
    }
    /** 时间线的摘要行（`共 N 台 · 最早 … · 最近 …`）。 */
    function discoverySpanText(data, firstText, lastText) {
        return "共 " + data.total + " 台 · 最早 " + firstText + " · 最近 " + lastText;
    }
    /** 首页说明（发现时间口径）。 */
    exports.DISCOVERY_NOTE = "（发现时间 = 第一次进入资产库的时刻；重复采集只刷新\"最近采集\"）";
    /* ══════════════════════════════════════════════════════════════ 请求与加载 */
    /** 请求 `op: domains`。 */
    function domainsRequest(engagement, cidr) {
        return { op: "domains", engagement, cidr: cidr !== null && cidr !== "" ? cidr : undefined };
    }
    /** 请求 `op: web`。 */
    function webRequest(engagement, cidr) {
        return { op: "web", engagement, cidr: cidr !== null && cidr !== "" ? cidr : undefined };
    }
    /** 请求 `op: asset`（单台详情）。 */
    function assetRequest(engagement, id) {
        return { op: "asset", engagement, id };
    }
    /** 请求 `op: discoveryTimeline`。 */
    function discoveryRequest(engagement) {
        return { op: "discoveryTimeline", engagement, limit: 200 };
    }
    /** 从响应里取错误文案（非失败 → `null`）。 */
    function errorOf(response, fallback) {
        if (response === null || response === undefined)
            return fallback;
        const body = recordOf(response);
        if (body["ok"] !== false)
            return null;
        const message = body["error"];
        return typeof message === "string" && message !== "" ? message : fallback;
    }
    /** 加载资产列表（预期内失败走 Result）。 */
    async function loadAssets(api, engagement, filter) {
        const response = await api.raw(assetsRequest(engagement, filter));
        const error = errorOf(response, "查询失败");
        if (error !== null)
            return (0, result_js_1.err)(error);
        return (0, result_js_1.ok)(assetListOf(response));
    }
    /** 加载域名维度。 */
    async function loadDomains(api, engagement, cidr) {
        const response = await api.raw(domainsRequest(engagement, cidr));
        const error = errorOf(response, "读取域名失败");
        if (error !== null)
            return (0, result_js_1.err)(error);
        return (0, result_js_1.ok)(domainGroupsOf(response));
    }
    /** 加载 Web 维度。 */
    async function loadWebAssets(api, engagement, cidr) {
        const response = await api.raw(webRequest(engagement, cidr));
        const error = errorOf(response, "读取 Web 资产失败");
        if (error !== null)
            return (0, result_js_1.err)(error);
        return (0, result_js_1.ok)(webAssetsOf(response));
    }
    /** 加载单台资产详情。 */
    async function loadAssetDetail(api, engagement, id) {
        const response = await api.raw(assetRequest(engagement, id));
        const error = errorOf(response, "读取资产详情失败");
        if (error !== null)
            return (0, result_js_1.err)(error);
        const detail = assetDetailOf(response);
        return detail === null ? (0, result_js_1.err)("资产不存在或已删除") : (0, result_js_1.ok)(detail);
    }
    /** 加载发现时间线。 */
    async function loadDiscovery(api, engagement) {
        const response = await api.raw(discoveryRequest(engagement));
        const error = errorOf(response, "加载失败");
        if (error !== null)
            return (0, result_js_1.err)(error);
        const data = discoveryOf(response);
        return data === null ? (0, result_js_1.err)("加载失败") : (0, result_js_1.ok)(data);
    }
    /** 资产列表的空态文案。 */
    function listEmptyText() {
        return "没有匹配的资产";
    }
    /** 域名维度的空态文案。 */
    function domainEmptyText(cidr) {
        return cidr !== null && cidr !== ""
            ? "该 C 段下暂无域名（切换到「全部 C 段」看全量）"
            : "暂无域名数据（信息收集阶段会写入域名）";
    }
    /** Web 维度的空态文案。 */
    function webEmptyText(cidr) {
        return cidr !== null && cidr !== ""
            ? "该 C 段下暂无 Web 资产"
            : "暂无 Web 资产（HTTP 探测后会写入 URL 与标题）";
    }
    /** 侧栏两个固定项（「全部 C 段」「当前测试」）之外的分组键。 */
    function sideGroupKey(scope) {
        return "scope:" + scope;
    }
    /** 未选靶标时的提示文案。 */
    exports.NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看资产测绘。";
});
/**
 * 类型化的 `h()`：保留 `createElement` 调用形态，让 props 有类型检查。
 *
 * ## 为什么不改 JSX
 *
 * 浏览器半侧有 **1,111 处** `createElement` 调用。改 JSX 需要：
 * Babel/esbuild 的 JSX 配置、`jsxImportSource`、宿主加载器的配合，
 * 而收益集中在「元素属性拼错能报错」这一点上——JSX 并不会让
 * `h(Div, {...})` 里的业务 props 变得更有类型（真正的类型来自组件签名）。
 *
 * 更关键的是：**这个文件会被原样嵌进宿主 `client.js` 的工厂函数**，
 * 不能依赖构建期转换。JSX 必须编译才能跑，而这里要求「源码即产物」。
 *
 * 所以选择：留调用形态，把类型加在 `h()` 的签名上。
 *
 * ## 类型收益具体是什么
 *
 * 1. `h('div', {...})` —— 标签名收窄到已知 HTML 标签联合，`h('dv', ...)` 报错。
 * 2. 已知标签的 props 有具体形状：`className`/`style`/`onClick`/`title`/`aria-*`
 *    拼错（`classname`、`onclick`）报错，这是原实现最容易犯的错。
 * 3. 组件函数（`(props: P) => ReactElement`）由 `P` 推导 props，
 *    缺必填字段、传多余字段都报错。
 * 4. 子节点接受 `ReactNode`，`null`/`false`/数组都可，与 React 语义一致。
 *
 * ## `data-*` 与 `aria-*`
 *
 * React 允许任意 `data-*` / `aria-*`。TS 无法表达「任意前缀 + 任意后缀」的
 * 可选键（模板字面量索引签名在 `exactOptionalPropertyTypes` 下会与
 * `ReactNode` 竞争），所以这两类用显式索引签名 + 值类型约束开放。
 */
define("redteam/client/h", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.NO_PROPS = void 0;
    exports.makeH = makeH;
    /**
     * 用宿主给的 React 造一个类型化 `h`。
     *
     * 运行时它**就是** `React.createElement`（同一次调用、同一份行为），
     * 类型层额外收窄。这样嵌入产物后的行为与原来完全一致 —— 不存在
     * 「类型化版本和原版本行为不同」的风险。
     */
    function makeH(react) {
        const create = react.createElement;
        return create;
    }
    /**
     * 空 props 的常量。
     *
     * `h('div', null, ...)` 与 `h('div', {}, ...)` 在 React 里等价，
     * 但 `{}` 每次渲染都是新对象（会破坏 memo）。用共享冻结对象避免这个开销。
     */
    exports.NO_PROPS = Object.freeze({});
});
/**
 * 控制台 UI 状态的类型。
 *
 * ## 为什么要单独建模
 *
 * 原 `client.js` 的状态是几坨裸对象：
 * ```js
 * let ui = { open: true, tab: 'assets' }
 * let geom = { x, y, w, h }              // 面板几何，来自 localStorage
 * let collapse = {}                      // 折叠状态，键是任意字符串
 * let unread = {}                        // 每个页签的已读指针
 * ```
 * 问题不是「没有类型」，而是**边界不清楚**：页签名是裸字符串
 * （`setUI({ tab: t[0] })` 里 `t[0]` 来自一个 `[[id, label], ...]` 数组，
 * 编译器不知道有哪些合法值），于是打错页签名会在 `body` 分支里
 * 静默落到 `'未知页签'`，看起来像「数据没加载」。
 *
 * 这里把四块状态分别建模：
 * - `ConsoleTabId`：页签**枚举**（12 个，含 2 个未在标签栏出现的兼容值）。
 * - `DockGeometry`：面板几何，含钳制规则。
 * - `CollapseState`：折叠状态（开放键，因为每个页签的键各不相同）。
 * - `UnreadState`：每页签的未读指针。
 */
define("redteam/client/state", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_VIEWPORT = exports.DOCK_MAX_HEIGHT = exports.DOCK_DEFAULT_WIDTH = exports.DOCK_MIN_HEIGHT = exports.DOCK_MIN_WIDTH = exports.ENGAGEMENT_TABS = exports.TABS = exports.DEFAULT_UI_STATE = void 0;
    exports.applyUiPatch = applyUiPatch;
    exports.clampDockGeometry = clampDockGeometry;
    exports.defaultDockGeometry = defaultDockGeometry;
    exports.isSectionOpen = isSectionOpen;
    exports.toggleSection = toggleSection;
    exports.setSections = setSections;
    exports.hasUnread = hasUnread;
    exports.markSeen = markSeen;
    exports.normalizeDigest = normalizeDigest;
    /** 默认状态：打开面板，停在资产测绘页。 */
    exports.DEFAULT_UI_STATE = Object.freeze({ open: true, tab: "assets" });
    /** 合并补丁（与原实现的 `Object.assign({}, ui, patch)` 同语义）。 */
    function applyUiPatch(state, patch) {
        return {
            open: patch.open ?? state.open,
            tab: patch.tab ?? state.tab,
        };
    }
    /**
     * 标签栏。顺序即界面顺序（原实现同样把顺序编在数组里）。
     *
     * 只列 10 个真正显示在标签栏的页签；`testing` / `attackfiles` / `prompts`
     * 是可以在状态里出现、但不由标签栏直接切换的兼容值。
     */
    exports.TABS = Object.freeze([
        { id: "assets", label: "资产测绘" },
        { id: "env", label: "环境适配" },
        { id: "agents", label: "智能体" },
        { id: "sessions", label: "会话隧道" },
        { id: "findings", label: "漏洞战果" },
        { id: "chain", label: "攻击链" },
        { id: "scores", label: "得分目标" },
        { id: "report", label: "报告" },
        { id: "knowledge", label: "知识库" },
        { id: "skills", label: "技能库" },
    ]);
    /**
     * 需要靶标才能显示的页签。
     *
     * 「没有靶标时显示什么」是原实现里散在三处的判断
     * （`else if (!eng) body = ...`），这里变成一个集合，
     * 让「无靶标时的空状态」只有一个来源。
     */
    exports.ENGAGEMENT_TABS = new Set([
        "assets",
        "testing",
        "sessions",
        "findings",
        "attackfiles",
        "chain",
        "report",
        "scores",
    ]);
    /** 尺寸约束。 */
    exports.DOCK_MIN_WIDTH = 320;
    exports.DOCK_MIN_HEIGHT = 240;
    exports.DOCK_DEFAULT_WIDTH = 620;
    exports.DOCK_MAX_HEIGHT = 640;
    /** 默认视口（与原实现的兜底一致）。 */
    exports.DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
    /**
     * 把任意几何钳制进视口。
     *
     * 规则逐条对应原实现，**顺序有意义**：
     * 1. 宽先钳到 `[MIN_WIDTH, max(MIN_WIDTH, vw)]` —— 视口比最小宽还窄时，
     *    取最小宽（宁可溢出也不把面板压成不可用）。
     * 2. 高同理。
     * 3. x/y 再按「不超出右下边界」钳一次 —— 先钳尺寸再钳位置，否则
     *    用未钳制的 w 算右边界会把面板推出屏幕。
     */
    function clampDockGeometry(input, viewport = exports.DEFAULT_VIEWPORT) {
        const vw = Math.max(viewport.width, exports.DOCK_MIN_WIDTH);
        const vh = Math.max(viewport.height, exports.DOCK_MIN_HEIGHT);
        const w = Math.min(Math.max(exports.DOCK_MIN_WIDTH, finiteOr(input.w, exports.DOCK_DEFAULT_WIDTH)), vw);
        const h = Math.min(Math.max(exports.DOCK_MIN_HEIGHT, finiteOr(input.h, 520)), vh);
        const x = Math.min(Math.max(0, finiteOr(input.x, 0)), Math.max(0, vw - w));
        const y = Math.min(Math.max(0, finiteOr(input.y, 0)), Math.max(0, vh - h));
        return { x, y, w, h };
    }
    /** 非有限数回退到默认值（`Number(undefined)` 是 NaN，不能直接用）。 */
    function finiteOr(value, fallback) {
        return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    }
    /**
     * 默认几何：贴右上角。
     *
     * 宽度优先取用户上次拖的宽度（`rt-dock-width`），受 320~1200 约束 ——
     * 这条「上次宽度」是原实现里唯一从 localStorage 读进几何的字段。
     */
    function defaultDockGeometry(viewport = exports.DEFAULT_VIEWPORT, savedWidth = null) {
        const w = savedWidth !== null && savedWidth >= exports.DOCK_MIN_WIDTH && savedWidth <= 1200
            ? savedWidth
            : exports.DOCK_DEFAULT_WIDTH;
        const h = Math.max(exports.DOCK_MIN_HEIGHT, Math.min(exports.DOCK_MAX_HEIGHT, viewport.height - 24));
        return clampDockGeometry({ x: Math.max(0, viewport.width - w - 12), y: 12, w, h }, viewport);
    }
    /**
     * 查折叠项是否展开。
     *
     * `defaultOpen` 的语义容易写错：原实现是 `defaultOpen !== false`，
     * 也就是「不传就展开」，传 `false` 才折叠。
     */
    function isSectionOpen(state, key, defaultOpen = true) {
        const value = state[key];
        return value === undefined ? defaultOpen !== false : value === true;
    }
    /** 切换一个折叠项，返回新状态（不改原对象）。 */
    function toggleSection(state, key, defaultOpen = true) {
        return { ...state, [key]: !isSectionOpen(state, key, defaultOpen) };
    }
    /** 批量设置。 */
    function setSections(state, keys, open) {
        const next = { ...state };
        for (const key of keys)
            next[key] = open;
        return next;
    }
    /**
     * 这个页签相对上次查看有没有新内容。
     *
     * 判定是**或**关系：条数变多 **或** 最新更新时间变了且更晚。
     * 只比条数会漏掉「删了两条又加了两条」这种等量变化。
     */
    function hasUnread(previous, current) {
        if (current === undefined)
            return false;
        if (previous === undefined)
            return true;
        if (current.count > previous.count)
            return true;
        const previousAt = previous.at ?? "";
        const currentAt = current.at ?? "";
        return currentAt !== "" && currentAt !== previousAt && currentAt > previousAt;
    }
    /** 把一个页签标记为已读（写入当前指针）。 */
    function markSeen(state, tab, current) {
        if (current === undefined)
            return state;
        return { ...state, [tab]: { count: current.count, at: current.at } };
    }
    /**
     * 把宿主 `consoleDigest` 的响应归一成 `UnreadState`。
     *
     * 宿主的字段是 `{ [tab]: { count, at } }`，但 `count` 可能是字符串
     * （SQLite 聚合结果的形态），所以显式转数字。
     */
    function normalizeDigest(raw) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            return {};
        const out = {};
        for (const [tab, value] of Object.entries(raw)) {
            if (typeof value !== "object" || value === null || Array.isArray(value))
                continue;
            const record = value;
            const count = Number(record["count"]);
            const at = typeof record["at"] === "string" ? record["at"] : null;
            out[tab] = { count: Number.isFinite(count) ? count : 0, at };
        }
        return out;
    }
});
/**
 * 控制台运行时上下文。
 *
 * ## 为什么要这一层
 *
 * 原实现的组件直接闭包引用模块级的 `ui` / `setUI` / `window`：
 * ```js
 * function SidebarButton(props) {
 *   const st = useUI()                    // ← 闭包里的模块级 store
 *   return h('button', { onClick: () => setUI({ open: !st.open }) })
 * }
 * ```
 * 后果是**组件不可测**：任何一次渲染都要求页面里存在 `document`、
 * `localStorage`，还要先把模块级 store 初始化好。测试只能靠「整包加载
 * 一次」来做，粒度粗到无法断言单个分支。
 *
 * 这里把「React + 窗口 + UI store」收进 `ConsoleRuntime`，组件通过参数
 * 拿到它。于是：
 * - 生产：`createRuntime()` 用真 `window` 与真 React 造一份；
 * - 测试：手写一份 runtime，`window` 是个普通对象，store 是个变量。
 *
 * setter 不再是模块级单例，而是 runtime 的一部分 —— 这也顺带修掉了
 * 原实现里「多个控制台实例共享一份 state」的隐患（全面浏览窗口与主窗口
 * 在同一页面里同时存在时）。
 */
define("redteam/client/runtime", ["require", "exports", "redteam/client/h", "redteam/client/state"], function (require, exports, h_js_1, state_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.STORAGE_KEYS = void 0;
    exports.safeStorage = safeStorage;
    exports.readStorage = readStorage;
    exports.writeStorage = writeStorage;
    exports.createUiStore = createUiStore;
    exports.createRuntime = createRuntime;
    exports.isConsoleTabId = isConsoleTabId;
    exports.renderWith = renderWith;
    /** 存储键（与原实现逐字一致，改动会让老用户的界面状态丢失）。 */
    exports.STORAGE_KEYS = Object.freeze({
        /** 面板几何。 */
        geometry: "rt-dock-geom-v1",
        /** 上次拖动的宽度。 */
        width: "rt-dock-width",
        /** 每页签未读指针的前缀（后缀是靶标 id）。 */
        unreadPrefix: "rt-unread:",
        /** 折叠状态的前缀（后缀是页签 + 靶标）。 */
        collapsePrefix: "rt-collapse:",
    });
    /**
     * 安全读 localStorage。
     *
     * 隐私模式 / 沙箱 iframe 下访问 `localStorage` 会**抛异常**（不是返回 null）。
     * 原实现每处都包 `try/catch`，这里统一成一个函数，避免漏包。
     */
    function safeStorage(windowRef) {
        try {
            return windowRef.localStorage;
        }
        catch {
            return null;
        }
    }
    /** 安全读一个存储项。 */
    function readStorage(windowRef, key) {
        const storage = safeStorage(windowRef);
        if (storage === null)
            return null;
        try {
            return storage.getItem(key);
        }
        catch {
            return null;
        }
    }
    /** 安全写一个存储项（写失败不影响功能）。 */
    function writeStorage(windowRef, key, value) {
        const storage = safeStorage(windowRef);
        if (storage === null)
            return;
        try {
            storage.setItem(key, value);
        }
        catch {
            /* 配额满 / 隐私模式：不持久化也能用 */
        }
    }
    /** 造 UI store。`notifyOnSet` 供测试观察通知。 */
    function createUiStore(react, initial = state_js_1.DEFAULT_UI_STATE) {
        let state = initial;
        const subscribers = new Set();
        const notify = () => {
            // **冻结的拷贝**，不是内部对象的引用：
            // · 拷贝：订阅者改了也影响不到 store（否则它改的是内部 state 本身）；
            // · 冻结：订阅者想改会抛（严格模式下），而不是静默污染。
            const snapshot = Object.freeze({ open: state.open, tab: state.tab });
            // 复制订阅者列表再遍历：回调里退订不该影响本轮通知。
            for (const subscriber of Array.from(subscribers)) {
                try {
                    subscriber(snapshot);
                }
                catch {
                    /* 一个坏订阅者不该让整个界面停摆（原实现同样吞掉） */
                }
            }
        };
        return {
            get: () => state,
            set(patch) {
                const next = (0, state_js_1.applyUiPatch)(state, patch);
                // 无变化时**不通知**：避免无意义的重渲染（原实现每次 set 都通知）。
                if (next.open === state.open && next.tab === state.tab)
                    return;
                // **先更新再通知**：订阅者在回调里调 `get()` 必须看到新值。
                state = next;
                notify();
            },
            subscribe(subscriber) {
                subscribers.add(subscriber);
                return () => {
                    subscribers.delete(subscriber);
                };
            },
            useUi() {
                const [snapshot, setSnapshot] = react.useState(() => state);
                react.useEffect(() => {
                    const subscriber = (next) => setSnapshot(next);
                    subscribers.add(subscriber);
                    // 挂载时同步一次：订阅之前可能已经变过。
                    setSnapshot(Object.freeze({ open: state.open, tab: state.tab }));
                    return () => {
                        subscribers.delete(subscriber);
                    };
                }, []);
                return snapshot;
            },
        };
    }
    /** 造运行时。`require` 来自宿主的工厂参数。 */
    function createRuntime(requireModule, windowRef, options = {}) {
        const React = requireModule("react");
        const ui = createUiStore(React, options.initial ?? state_js_1.DEFAULT_UI_STATE);
        const log = options.log ?? (() => undefined);
        return {
            h: (0, h_js_1.makeH)(React),
            React,
            window: windowRef,
            ui,
            log,
        };
    }
    /** 页签是否合法（运行时校验未受信输入用）。 */
    function isConsoleTabId(value) {
        return typeof value === "string" && [
            "assets", "env", "agents", "sessions", "findings", "chain",
            "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
        ].includes(value);
    }
    /** 渲染一个节点（测试便利：把组件当函数调用）。 */
    function renderWith(runtime, node) {
        return node();
    }
});
/**
 * 界面层的纯助手：把原 `client.js` 里那些能脱离 React 与 DOM 的逻辑搬出来。
 *
 * 之所以先做这一层：组件层有 1,228 个 `h()` 调用点，如果助手还混在组件里，
 * 每个组件都得连着 React 一起测。抽出来之后它们都是纯函数，
 * 可以穷举、可以对照原实现、不需要 mock。
 *
 * ## 与原实现的关系
 *
 * 每个函数都在注释里标了原实现的对应片段。**行为必须等价** ——
 * 有几处原实现的行为看着像 bug（比如 `fmt` 把 `T` 换成空格后又 slice），
 * 但它们是界面上已经定型的样子，改动属于产品决策，不该夹带在迁移里。
 * 这类地方显式标注「保留原行为」。
 */
define("redteam/client/helpers", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.FULL_WINDOW_HASH = void 0;
    exports.clickable = clickable;
    exports.formatTimestamp = formatTimestamp;
    exports.formatTimestampShort = formatTimestampShort;
    exports.messageOf = messageOf;
    exports.isFailure = isFailure;
    exports.arrayOf = arrayOf;
    exports.recordOf = recordOf;
    exports.numberOf = numberOf;
    exports.stringOf = stringOf;
    exports.cx = cx;
    exports.compactQuery = compactQuery;
    exports.optionEntries = optionEntries;
    exports.isFullWindowHash = isFullWindowHash;
    exports.fullWindowUrl = fullWindowUrl;
    exports.shotCacheKey = shotCacheKey;
    exports.shotDataUrl = shotDataUrl;
    exports.dataOpen = dataOpen;
    exports.pairToTab = pairToTab;
    /**
     * 给「可点击但不是 `<button>`」的元素补上键盘可达性。
     *
     * 原实现的注释记了动机：面板里大量用 div/span 当按钮（表格行、页签、
     * 结论条、C 段条目），鼠标能点、键盘够不着；而且这类元素此前有 16 处
     * 各写各的、写法还不一致（有的只有 role，有的漏了 Space 键）。
     *
     * **不要**用它包真正的 `<button>`（原生按钮自带全部语义）。
     */
    function clickable(onActivate, options = {}) {
        const props = {
            role: "button",
            tabIndex: 0,
            onClick: onActivate,
            onKeyDown: (event) => {
                // Enter 与 Space 是按钮的标准激活键；Space 还要阻止页面滚动。
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    onActivate(event);
                }
            },
            ...(options.label !== undefined ? { "aria-label": String(options.label) } : {}),
            ...(options.expanded !== undefined
                ? { "aria-expanded": options.expanded ? "true" : "false" }
                : {}),
        };
        return props;
    }
    /**
     * 时间戳 → `YYYY-MM-DD HH:MM`。
     *
     * 原实现：`(s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '—')`
     *
     * **保留原行为**：它不是真日期解析，只是把 ISO 串里第一个 `T` 换成空格
     * 再截 16 字符。好处是零依赖、对任何形态的串都不会抛；
     * 坏处是时区不做转换（显示的是 UTC 串的字面值）。
     * 这是界面已定型的样子，改成 `Intl.DateTimeFormat` 会改变所有已有截图与报告。
     */
    function formatTimestamp(value) {
        // **必须用原样的真值判定**：`0` 在这里应显示 `—`（原实现是 `s ? ... : '—'`）。
        // 改成 `value === ""` 之类会把 `0` 显示成 `"0"`，与既有界面/报告不一致。
        return value ? String(value).replace("T", " ").slice(0, 16) : "—";
    }
    /**
     * 时间戳 → `MM-DD HH:MM`（列表里宽度紧张时用）。
     *
     * 原实现：先 `replace('T',' ')`，长度 ≥16 时 `slice(5, 16)`。
     * 也就是从第 5 个字符开始（跳过 `YYYY-`），保留 `MM-DD HH:MM`。
     */
    function formatTimestampShort(value) {
        const text = String(value ?? "").replace("T", " ");
        return text.length >= 16 ? text.slice(5, 16) : text || "—";
    }
    /**
     * 把任意值收敛为「人类可读的一行」。
     *
     * 用于 `error` 字段：它可能是 `Error`、字符串、或某种对象。
     * 原实现各处写 `e && e.message ? e.message : String(e)`，这里统一。
     */
    function messageOf(value) {
        if (value instanceof Error)
            return value.message;
        if (typeof value === "string")
            return value;
        if (typeof value === "object" && value !== null) {
            const candidate = value["message"];
            if (typeof candidate === "string")
                return candidate;
        }
        return String(value);
    }
    /**
     * 判断某个响应是否表示业务失败。
     *
     * 桥接层的错误响应是 `{ ok: false, error }`；成功响应可能带
     * 数组 / 对象 / `{ ok: true }`。这里把「失败」的判定集中一处，
     * 避免组件里散落 `if (!r || r.ok === false)`。
     */
    function isFailure(response) {
        if (response === null || response === undefined)
            return true;
        if (typeof response !== "object")
            return false;
        return response["ok"] === false;
    }
    /** 从响应里取数组字段（缺失或形态不对 → 空数组）。 */
    function arrayOf(response, key) {
        if (typeof response !== "object" || response === null)
            return [];
        const value = response[key];
        return Array.isArray(value) ? value : [];
    }
    /** 从响应里取对象字段（缺失或形态不对 → `null`）。 */
    function recordOf(response, key) {
        if (typeof response !== "object" || response === null)
            return null;
        const value = response[key];
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : null;
    }
    /** 从响应里取数字字段（缺失或非有限 → 0）。 */
    function numberOf(response, key) {
        if (typeof response !== "object" || response === null)
            return 0;
        const value = Number(response[key]);
        return Number.isFinite(value) ? value : 0;
    }
    /** 从响应里取字符串字段（缺失 → `""`）。 */
    function stringOf(response, key) {
        if (typeof response !== "object" || response === null)
            return "";
        const value = response[key];
        return typeof value === "string" ? value : "";
    }
    /**
     * 拼接 className，跳过假值。
     *
     * 原实现到处写 `'rt-btn' + (disabled ? ' on' : '')`，拼错空格就会出现
     * `rt-btnon` 这种静默失效的类名。用小工具收敛，多类名也安全。
     */
    function cx(...parts) {
        return parts.filter((part) => typeof part === "string" && part !== "").join(" ");
    }
    /**
     * 把过滤条件对象里的空值去掉。
     *
     * 原实现每个查询都写 `cidr: cidr || undefined`，一个字段一行。
     * 这里统一：空串 / null / undefined / 空数组都视为「不过滤」。
     *
     * 注意布尔 `false` **保留** —— 它是有效筛选值（如 `showAll: false`）。
     */
    function compactQuery(input) {
        const out = {};
        for (const [key, value] of Object.entries(input)) {
            if (value === null || value === undefined)
                continue;
            if (typeof value === "string" && value === "")
                continue;
            out[key] = value;
        }
        return out;
    }
    /**
     * 生成 `<option>` 列表需要的「值 + 显示名」数组。
     *
     * 输入是「表」+「顺序」，输出保持顺序；表里有的但顺序没列出的项
     * **追加在末尾**（防止上游加了新状态后下拉框里看不到它 —— 原实现用
     * `Object.keys` 直接当顺序，不会漏；这里显式补一步，等价但更清楚）。
     */
    function optionEntries(table, order) {
        const keys = order ?? Object.keys(table);
        const seen = new Set();
        const out = [];
        for (const key of keys) {
            if (seen.has(key))
                continue;
            const label = table[key];
            // 顺序数组里出现表外的键：**跳过**，不要凭空造一个 value=key/label=key 的选项
            // （那会让下拉框里冒出一个后端根本不认识的值）。
            if (label === undefined)
                continue;
            seen.add(key);
            out.push({ value: key, label });
        }
        for (const [key, label] of Object.entries(table)) {
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push({ value: key, label });
        }
        return out;
    }
    /**
     * 判断 URL hash 是否是「全面浏览」独立窗口。
     *
     * 原实现：`String(window.location.hash || '') === '#redteam-full'`。
     * 这个窗口复用同一套界面代码，只靠 hash 区分外壳形态。
     */
    exports.FULL_WINDOW_HASH = "#redteam-full";
    /** 判断 hash 是否是全面浏览窗口。 */
    function isFullWindowHash(hash) {
        return String(hash ?? "") === exports.FULL_WINDOW_HASH;
    }
    /**
     * 构造「全面浏览」窗口的 URL。
     *
     * 原实现：`window.location.href.split('#')[0] + '#redteam-full'`。
     * 保留「先砍掉已有 hash 再拼」的行为，否则从全面浏览窗口再点一次
     * 会得到 `...#redteam-full#redteam-full`。
     */
    function fullWindowUrl(href) {
        return href.split("#")[0] + exports.FULL_WINDOW_HASH;
    }
    /**
     * 证据截图的缓存键。
     *
     * 原实现用 `eng + ':' + id` 拼字符串；这里保留同样格式（现有缓存逻辑依赖它），
     * 但集中一处，避免某处写成 `id + eng` 导致同一张图命中不了缓存。
     */
    function shotCacheKey(engagement, shotId) {
        return `${engagement}:${shotId}`;
    }
    /** 图片 data URL（证据截图走 base64 内联，避免额外鉴权路由）。 */
    function shotDataUrl(base64, mime) {
        if (typeof base64 !== "string" || base64 === "")
            return "";
        const type = typeof mime === "string" && mime !== "" ? mime : "image/png";
        return `data:${type};base64,${base64}`;
    }
    /**
     * 面板元素的 `data-open` 属性值。
     *
     * 原实现写 `st.open ? '1' : '0'`（字符串，供 CSS 属性选择器用）。
     */
    function dataOpen(open) {
        return open ? "1" : "0";
    }
    /**
     * 把标签栏的 `[id, label]` 元组转成对象。
     *
     * 原实现直接用元组数组（`tabs = [['assets', '资产测绘'], ...]`），
     * 取值靠 `t[0]` / `t[1]` —— 打错索引不会报错。集中转换一次。
     */
    function pairToTab(pair) {
        return { id: pair[0], label: pair[1] };
    }
});
/**
 * 资产测绘页（`assets` 页签）的渲染。
 *
 * 数据与过滤全在 `assets-model.ts`，这里只排版。
 *
 * ## 布局（原实现是左右分栏）
 *
 * ```
 * ┌──────────┬───────────────────────────────────────────┐
 * │ 全部 C 段 │ 搜索 / 服务 / 端口 / 内外网 / 来源 / 易打性  │
 * │ 当前测试  │ 测试状态 / 刷新 / 列表·发现时间·域名·Web    │
 * │ 外网资产▾ │ 结论行：台账资产 存活 待测 测试中 已测 放弃   │
 * │  10.0.0/24│ ─────────────────────────────────────────  │
 * │ 内网资产▾ │ 表头 / 资产行（点开是详情）                  │
 * └──────────┴───────────────────────────────────────────┘
 * ```
 *
 * ## 两个原实现细节，这里保留
 *
 * 1. **测试视图隐藏工具栏**（`view === 'testing' ? null : toolbar`），但
 *    结论行仍然渲染 —— 内嵌的测试页自己带一条自己的结论行，两条并存是
 *    原样（外层那条是「家底分布」，内层那条是「当前测试进度」）。
 * 2. **`q` 与 `qApplied` 是两个值**：输入框自由输入，回车或点「搜索」才生效。
 *    渲染层因此需要 `searchDraft` 单独进 props。
 */
define("redteam/client/assets-tab", ["require", "exports", "redteam/client/helpers", "redteam/client/label", "redteam/client/assets-model"], function (require, exports, helpers_js_1, label_js_2, assets_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderAssetsTab = renderAssetsTab;
    exports.defaultAssetsProps = defaultAssetsProps;
    /** C 段折叠的默认展开态（外网/内网两组默认都展开）。 */
    const SIDE_GROUP_DEFAULT_OPEN = true;
    /** 从事件里读 input 的值（React 合成事件与原生事件都能用）。 */
    function inputValue(event) {
        const target = event.target;
        return typeof target?.value === "string" ? target.value : "";
    }
    /** 归属徽章（单字）。 */
    function scopeBadge(runtime, scope, style) {
        return runtime.h("span", {
            className: "rt-scope rt-scope-" + scope,
            ...(style !== undefined ? { style } : {}),
        }, (0, assets_model_js_1.scopeShortLabel)(scope));
    }
    /**
     * 易打性徽章。
     *
     * 原实现：`props.p` 假值时显示「未评」（而不是空）—— 未评估的资产也要占位，
     * 否则表格这一列会塌。
     */
    function priorityBadge(runtime, priority, title) {
        if (priority === "") {
            return runtime.h("span", { className: "rt-tag" }, "未评");
        }
        return runtime.h("span", {
            className: "rt-pri rt-pri-" + priority,
            title,
        }, (0, label_js_2.priorityLabel)(priority));
    }
    /** 测试状态徽章（未知状态直接显示原始 code，便于发现「后端加了状态前端没跟上」）。 */
    function testStatusBadge(runtime, status) {
        const value = status !== "" ? status : "untested";
        return runtime.h("span", { className: "rt-test rt-test-" + value }, (0, label_js_2.testStatusLabel)(value));
    }
    /** 来源徽章。 */
    function provenanceBadge(runtime, provenance) {
        if (provenance === "")
            return runtime.h("span", { className: "rt-tag" }, "未知");
        const label = provenance === "passive" ? "被动" : provenance === "active" ? "主动" : "未知";
        return runtime.h("span", { className: "rt-tag rt-tag-" + provenance }, label);
    }
    /** 侧栏：一个 C 段分组（外网/内网）。 */
    function sideGroup(runtime, props, title, list, kind) {
        const { h } = runtime;
        const key = (0, assets_model_js_1.sideGroupKey)(kind);
        const stored = props.collapsed[key];
        const open = stored === undefined ? SIDE_GROUP_DEFAULT_OPEN : stored === true;
        const activate = (event) => {
            event?.stopPropagation?.();
            props.onToggleSideGroup(kind);
        };
        const out = [
            h("div", {
                key: "h" + kind,
                className: "rt-sidehead rt-sidehead-btn",
                role: "button",
                tabIndex: 0,
                "aria-expanded": open ? "true" : "false",
                title: (open ? "收起本组" : "展开本组") + "（并切回资产列表）",
                onClick: () => {
                    props.onViewChange("list");
                    activate();
                },
                onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault?.();
                        props.onViewChange("list");
                        activate(event);
                    }
                },
            }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), h("span", { className: "rt-scope rt-scope-" + kind }, kind === "internal" ? "内网" : "外网"), h("span", null, title + " · " + list.length + " 个 C 段"), h("span", { className: "rt-spacer" }), h("span", { style: { fontWeight: 400 } }, (0, assets_model_js_1.totalAssetsOf)(list) + " 资产")),
        ];
        if (!open)
            return out;
        for (const segment of list) {
            const active = props.filter.cidr === segment.cidr;
            out.push(h("div", {
                key: segment.cidr,
                className: "rt-seg" + (active ? " on" : ""),
                title: (0, assets_model_js_1.segmentTitle)(segment),
                ...(0, helpers_js_1.clickable)(() => {
                    props.onViewChange("list");
                    props.onFilterChange({ ...props.filter, cidr: segment.cidr });
                }, { label: "筛选 C 段 " + segment.cidr, expanded: active && props.view !== "testing" }),
            }, h("div", { className: "rt-seg-cidr", style: { display: "flex", alignItems: "baseline", gap: 5 } }, h("span", { className: "rt-scope rt-scope-" + kind }, kind === "internal" ? "内" : "外"), h("span", { style: { flex: 1 } }, segment.cidr), h("span", { className: "rt-seg-meta", style: { margin: 0, whiteSpace: "nowrap" } }, segment.assets + " 台"))));
        }
        return out;
    }
    /** 侧栏。 */
    function sidePane(runtime, props) {
        const { h } = runtime;
        const segments = (0, assets_model_js_1.segmentsOf)(props.snapshot);
        const groups = (0, assets_model_js_1.groupSegments)(segments);
        const allActive = props.filter.cidr === null && props.view !== "testing";
        const testingActive = props.view === "testing";
        const children = [
            h("div", {
                key: "all",
                className: "rt-seg" + (allActive ? " on" : ""),
                ...(0, helpers_js_1.clickable)(() => {
                    props.onViewChange("list");
                    props.onFilterChange({ ...props.filter, cidr: null });
                }, { label: "全部 C 段", expanded: allActive }),
            }, h("div", { className: "rt-seg-cidr" }, "全部 C 段"), h("div", { className: "rt-seg-meta" }, segments.length + " 个网段")),
            h("div", {
                key: "testing",
                className: "rt-seg" + (testingActive ? " on" : ""),
                title: "正在跑的扫描 / 探测与进度（5 秒自动刷新）",
                ...(0, helpers_js_1.clickable)(() => {
                    props.onViewChange("testing");
                    props.onFilterChange({ ...props.filter, cidr: null });
                }, { label: "当前测试", expanded: testingActive }),
            }, h("div", { className: "rt-seg-cidr", style: { display: "flex", alignItems: "baseline", gap: 5 } }, h("span", { className: "rt-scope rt-scope-testing", title: "当前测试（既非内网也非外网）" }, "测"), h("span", { style: { flex: 1 } }, "当前测试")), h("div", { className: "rt-seg-meta" }, "正在跑的扫描与探测")),
        ];
        // 先外网（互联网可达，通常是入口）再内网（打进去之后才看得到）。
        if (groups.external.length > 0) {
            children.push(...sideGroup(runtime, props, "外网资产", groups.external, "external"));
        }
        if (groups.internal.length > 0) {
            children.push(...sideGroup(runtime, props, "内网资产", groups.internal, "internal"));
        }
        return h("div", { className: "rt-side" }, children);
    }
    /** 一个下拉筛选。 */
    function filterSelect(runtime, value, options, onChange, title) {
        return runtime.h("select", {
            className: "rt-input",
            value,
            ...(title !== undefined ? { title } : {}),
            onChange: (event) => onChange(inputValue(event)),
        }, options.map((option) => runtime.h("option", { key: option.value, value: option.value }, option.label)));
    }
    /** 工具栏。 */
    function toolbar(runtime, props) {
        const { h } = runtime;
        const set = (patch) => props.onFilterChange({ ...props.filter, ...patch });
        return h("div", { className: "rt-toolbar" }, h("input", {
            className: "rt-input",
            style: { flex: "1 1 150px" },
            placeholder: "搜索 IP / 域名 / 指纹（回车）",
            value: props.searchDraft,
            onChange: (event) => props.onSearchDraftChange(inputValue(event)),
            onKeyDown: (event) => {
                if (event.key === "Enter")
                    props.onSearch();
            },
        }), h("button", { className: "rt-btn", onClick: () => props.onSearch() }, "搜索"), h("input", {
            className: "rt-input",
            style: { width: "78px" },
            placeholder: "服务",
            value: props.filter.service,
            onChange: (event) => set({ service: inputValue(event) }),
        }), h("input", {
            className: "rt-input",
            style: { width: "60px" },
            placeholder: "端口",
            value: props.filter.port,
            onChange: (event) => set({ port: inputValue(event) }),
        }), filterSelect(runtime, props.filter.scope, assets_model_js_1.SCOPE_OPTIONS, (value) => {
            // 只允许三个字面值，其它一律当「不限」。
            set({ scope: value === "external" || value === "internal" ? value : "" });
        }), filterSelect(runtime, props.filter.provenance, assets_model_js_1.PROVENANCE_OPTIONS, (value) => set({ provenance: value }), "按端口来源过滤（列表已不再单列显示，详情里可见）"), filterSelect(runtime, props.filter.priority, assets_model_js_1.PRIORITY_OPTIONS, (value) => set({ priority: value })), filterSelect(runtime, props.filter.testStatus, assets_model_js_1.TEST_STATUS_OPTIONS, (value) => set({ testStatus: value })), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            title: "重新拉取快照与当前视图数据",
            onClick: () => props.onRefresh(),
        }, "刷新"), assets_model_js_1.VIEW_BUTTONS.map((button) => h("button", {
            key: button.value,
            className: "rt-btn" + (props.view === button.value ? " rt-btn-primary" : ""),
            ...(button.title !== undefined ? { title: button.title } : {}),
            onClick: () => props.onViewChange(button.value),
        }, button.label)));
    }
    /** 结论行（一屏看清家底，数字点一下就是筛选）。 */
    function conclusionBar(runtime, props) {
        const { h } = runtime;
        const stats = (0, assets_model_js_1.conclusionStatsOf)(props.snapshot);
        const items = (0, assets_model_js_1.conclusionItems)(stats, props.filter);
        return h("div", { className: "rt-concl" }, items.map((item) => h("span", {
            key: item.key,
            className: "rt-concl-i" + (item.active ? " on" : ""),
            title: "点击筛选 / 再点取消",
            ...(0, helpers_js_1.clickable)(() => props.onFilterChange((0, assets_model_js_1.applyConclusion)(props.filter, item.key)), { label: "按「" + item.label + "」筛选（" + item.value + "）", expanded: item.active }),
        }, h("b", null, String(item.value)), h("span", null, item.label))), h("div", { className: "rt-spacer" }), h("select", {
            className: "rt-input",
            value: props.filter.sort,
            title: "列表排序方式",
            onChange: (event) => {
                const value = inputValue(event);
                const known = assets_model_js_1.SORT_OPTIONS.some((option) => option.value === value);
                props.onFilterChange({ ...props.filter, sort: known ? value : "priority" });
            },
        }, assets_model_js_1.SORT_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))));
    }
    /** 列表视图。 */
    function listPane(runtime, props) {
        const { h } = runtime;
        const state = props.list;
        const items = state?.items ?? [];
        const head = h("div", { className: "rt-row head" }, h("span", null, "IP"), h("span", null, "易打"), h("span", null, "测试状态"), h("span", null, "开放端口 / 服务"), h("span", null, "指纹"));
        const rows = [];
        for (const item of items) {
            const ports = (0, assets_model_js_1.portSummary)(item.ports);
            const fingerprints = (0, assets_model_js_1.fingerprintSummary)(item.fingerprints);
            const open = props.openId === item.id;
            rows.push(h("div", {
                key: "r" + item.id,
                className: "rt-row",
                ...(0, helpers_js_1.clickable)(() => props.onToggleRow(item.id), {
                    label: "展开资产 " + item.ip,
                    expanded: open,
                }),
            }, h("span", { className: "rt-mono", style: { display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap" } }, scopeBadge(runtime, item.scope), h("span", {
                title: item.state === "live" ? "存活" : item.state,
                style: {
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flex: "none",
                    marginTop: 4,
                    background: item.state === "live" ? "#10b981" : "#94a3b8",
                },
            }), h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, item.ip), 
            // 发现时间挂在 IP 下面一行：IP 列宽度有限，不另开列。
            h("span", {
                style: {
                    fontSize: 10.5,
                    color: "var(--dsw-alias-label-secondary)",
                    whiteSpace: "nowrap",
                },
                title: "发现时间：" + (item.discoveredAt !== "" ? (0, helpers_js_1.formatTimestamp)(item.discoveredAt) : "未记录")
                    + (item.lastSeen !== "" ? "\n最近采集：" + (0, helpers_js_1.formatTimestamp)(item.lastSeen) : ""),
            }, item.discoveredAt !== "" ? (0, helpers_js_1.formatTimestampShort)(item.discoveredAt) : "发现时间未知")), h("span", null, priorityBadge(runtime, item.priority, item.potential)), h("span", null, testStatusBadge(runtime, item.testStatus), item.blockedCount > 0
                ? h("span", {
                    className: "rt-tag",
                    style: { color: "#ef4444", borderColor: "#ef444455", marginLeft: 4 },
                }, "封" + item.blockedCount)
                : null), h("span", { title: ports.full }, ports.shown), h("span", { title: fingerprints.full }, fingerprints.shown)));
            if (!open)
                continue;
            rows.push(h("div", {
                key: "d" + item.id,
                className: "rt-row",
                style: { cursor: "default", gridTemplateColumns: "1fr" },
            }, h("div", { className: "rt-expand" }, detailBody(runtime, props, item))));
        }
        return h("div", { className: "rt-table" }, head, rows, state !== null && !state.loading && items.length === 0
            ? h("div", { className: "rt-empty" }, (0, assets_model_js_1.listEmptyText)())
            : null);
    }
    /** 展开后的详情。 */
    function detailBody(runtime, props, item) {
        const { h } = runtime;
        const detail = (0, assets_model_js_1.detailFor)(item, props.detail);
        if (detail === null)
            return h("div", null, "加载中…");
        const openPorts = (0, assets_model_js_1.openPortsOf)(detail);
        const all = props.showAllId === item.id;
        const noteLines = (0, assets_model_js_1.noteLinesOf)(detail);
        const portRows = openPorts.map((port) => h("div", { key: "p" + port.port, className: "rt-kv" }, h("b", { className: "rt-mono" }, port.port + "/" + port.proto), h("span", null, (0, assets_model_js_1.portServiceText)(port)), port.url !== null
            ? h("a", {
                className: "rt-link",
                href: port.url,
                target: "_blank",
                rel: "noreferrer",
                title: port.url,
            }, port.title !== "" ? port.title : port.url)
            : null, provenanceBadge(runtime, port.provenance)));
        const fingerprintRows = detail.fingerprints.map((fingerprint) => h("div", {
            key: "f" + fingerprint.product + fingerprint.version + fingerprint.evidence,
            className: "rt-kv",
        }, h("b", null, fingerprint.category !== "" ? fingerprint.category : "—"), h("span", null, (0, assets_model_js_1.fingerprintDetailText)(fingerprint)), provenanceBadge(runtime, fingerprint.provenance)));
        const observationRows = detail.observations.slice(0, assets_model_js_1.MAX_OBSERVATIONS).map((observation) => h("div", {
            key: "o" + observation.attr + observation.value + observation.collectedAt,
            className: "rt-kv",
        }, h("b", null, observation.attr !== "" ? observation.attr : "—"), h("span", null, (0, assets_model_js_1.observationText)(observation, (0, helpers_js_1.formatTimestamp)(observation.collectedAt))), provenanceBadge(runtime, observation.provenance)));
        return h("div", null, 
        // 必读三行。
        h("div", { className: "rt-kv" }, h("b", null, "测试"), h("span", null, testStatusBadge(runtime, detail.testStatus), detail.blockedCount > 0
            ? h("span", {
                className: "rt-tag",
                style: { marginLeft: 6, color: "#ef4444", borderColor: "#ef444455" },
            }, "被封 " + detail.blockedCount + " 次")
            : null, h("span", { style: { marginLeft: 8, color: "var(--dsw-alias-label-secondary)" } }, (0, assets_model_js_1.testMetaText)(detail, (0, helpers_js_1.formatTimestamp)(detail.testUpdatedAt))))), h("div", { className: "rt-kv" }, h("b", null, "易打性"), h("span", null, priorityBadge(runtime, detail.priority, detail.assessReason), h("span", { style: { marginLeft: 8 } }, detail.potential !== "" ? detail.potential : "未评估"), detail.assessReason !== ""
            ? h("span", { style: { marginLeft: 8, color: "var(--dsw-alias-label-secondary)" } }, detail.assessReason)
            : null)), h("div", { className: "rt-kv" }, h("b", null, "攻击面"), h("span", null, (0, assets_model_js_1.surfaceText)(detail, openPorts.length), h("span", {
            className: "rt-scope rt-scope-" + detail.scope,
            style: { marginLeft: 8 },
        }, (0, assets_model_js_1.scopeLongLabel)(detail.scope)))), h("span", {
            className: "rt-more",
            ...(0, helpers_js_1.clickable)(() => props.onToggleShowAll(all ? null : item.id), { label: all ? "收起资产详情" : "展开资产详情", expanded: all }),
        }, all ? "收起全部 ▲" : "展开全部（端口 · 指纹 · 采集溯源 · 测试记录）▼"), all
            ? h("div", null, h("div", { className: "rt-kv" }, h("b", null, "主机名"), h("span", null, (0, assets_model_js_1.namesText)(detail))), h("div", { className: "rt-kv" }, h("b", null, "发现时间"), h("span", { title: "本条资产第一次进入资产库的时刻（重复采集只刷新\"最近采集\"）" }, (0, helpers_js_1.formatTimestamp)(detail.discoveredAt)), h("b", { style: { minWidth: 0, marginLeft: 8 } }, "最近采集"), h("span", null, (0, helpers_js_1.formatTimestamp)(detail.lastSeen)), h("b", { style: { minWidth: 0, marginLeft: 8 } }, "数据源首见"), h("span", null, (0, helpers_js_1.formatTimestamp)(detail.firstSeen))), h("div", { className: "rt-kv" }, h("b", null, "C 段"), h("span", null, detail.segmentCidr)), h("div", { className: "rt-kv" }, h("b", null, "易打性"), h("span", null, (0, assets_model_js_1.assessLongText)(detail, (0, helpers_js_1.formatTimestamp)(detail.assessedAt)))), h("div", { className: "rt-kv" }, h("b", null, "来源"), h("span", null, (0, assets_model_js_1.provenanceText)(detail))), h("div", { style: { margin: "6px 0 3px", fontWeight: 600 } }, "开放端口 / 服务"), h("div", null, portRows.length > 0 ? portRows : "—"), h("div", { style: { margin: "6px 0 3px", fontWeight: 600 } }, "指纹"), h("div", null, fingerprintRows.length > 0 ? fingerprintRows : "—"), noteLines.length > 0
                ? clip(runtime, props, "测试记录（" + noteLines.length + " 条）", noteLines.join("\n"))
                : null, h("div", { style: { margin: "6px 0 3px", fontWeight: 600 } }, "采集溯源（最近 8 条）"), h("div", null, observationRows.length > 0 ? observationRows : "—"))
            : null);
    }
    /**
     * 长文本折叠。
     *
     * 原 `Clip` 用 `useState` 管展开态 —— 本层无 hook，展开态与复制回调整体
     * 由 props 承载（`notesOpen` / `onToggleNotes` / `onCopy`），行为不变。
     */
    function clip(runtime, props, label, text) {
        const { h } = runtime;
        if (text.trim() === "")
            return null;
        return h("div", { className: "rt-clip" + (props.notesOpen ? " open" : "") }, h("div", { className: "rt-clip-head" }, h("span", { className: "rt-clip-label" }, label), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: (event) => {
                event.stopPropagation?.();
                props.onCopy(text);
            },
        }, "复制"), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: (event) => {
                event.stopPropagation?.();
                props.onToggleNotes();
            },
        }, props.notesOpen ? "收起" : "展开")), h("div", { className: "rt-clip-body" }, text));
    }
    /** 域名维度。 */
    function domainPane(runtime, props) {
        const { h } = runtime;
        const domains = props.domains;
        if (domains === null)
            return h("div", { className: "rt-table" }, h("div", { className: "rt-empty" }, "加载中…"));
        if (domains.length === 0) {
            return h("div", { className: "rt-table" }, h("div", { className: "rt-empty" }, (0, assets_model_js_1.domainEmptyText)(props.filter.cidr)));
        }
        const rows = [];
        for (const group of domains) {
            rows.push(h("div", { key: group.domain, className: "rt-section", style: { padding: "8px 10px 4px" } }, h("a", {
                className: "rt-link",
                href: "http://" + group.domain,
                target: "_blank",
                rel: "noreferrer",
            }, group.domain), h("span", { className: "rt-tag", style: { marginLeft: 8 } }, group.count + " 个资产")));
            for (const asset of group.assets) {
                rows.push(h("div", {
                    key: group.domain + "\u0000" + asset.id + "\u0000" + asset.ip,
                    className: "rt-row",
                    style: { gridTemplateColumns: "150px 130px 70px 1fr", cursor: "pointer" },
                    onClick: () => props.onDomainAssetClick(asset.ip),
                }, h("span", { className: "rt-mono" }, asset.ip), h("span", { className: "rt-mono" }, asset.segment), h("span", null, h("span", { className: "rt-tag rt-tag-" + (asset.state === "live" ? "live" : "dead") }, asset.state === "live" ? "存活" : asset.state)), h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, asset.names.join(", "))));
            }
        }
        return h("div", { className: "rt-table" }, rows);
    }
    /** Web 维度。 */
    function webPane(runtime, props) {
        const { h } = runtime;
        const web = props.web;
        const columns = "1.6fr 1.2fr 130px 110px";
        return h("div", { className: "rt-table" }, h("div", { className: "rt-row head", style: { gridTemplateColumns: columns } }, h("span", null, "URL（可点击）"), h("span", null, "标题"), h("span", null, "资产"), h("span", null, "服务")), (web ?? []).map((asset) => {
            const url = (0, assets_model_js_1.webAssetUrl)(asset);
            return h("div", {
                key: "w" + asset.portId,
                className: "rt-row",
                style: { gridTemplateColumns: columns, cursor: "default" },
            }, h("a", {
                className: "rt-link rt-mono",
                href: url,
                target: "_blank",
                rel: "noreferrer",
                title: url,
            }, url), h("span", { title: asset.title }, asset.title !== "" ? asset.title : "—"), h("span", { className: "rt-mono" }, asset.ip + " · " + asset.segmentCidr), h("span", { style: { fontSize: 11 } }, (0, assets_model_js_1.webServiceText)(asset)));
        }), web === null
            ? h("div", { className: "rt-empty" }, "加载中…")
            : (web.length === 0 ? h("div", { className: "rt-empty" }, (0, assets_model_js_1.webEmptyText)(props.filter.cidr)) : null));
    }
    /** 发现时间线。 */
    function timelinePane(runtime, props) {
        const { h } = runtime;
        if (props.discoveryError !== null) {
            return h("div", { className: "rt-pane" }, h("div", { className: "rt-err" }, props.discoveryError));
        }
        const data = props.discovery;
        if (data === null)
            return h("div", { className: "rt-empty" }, "加载中…");
        const recent = (0, assets_model_js_1.filterDiscoveryByDay)(data.recent, props.discoveryDay);
        return h("div", { className: "rt-pane", style: { flex: 1, minHeight: 0 } }, h("div", { className: "rt-card" }, h("h4", null, "资产发现时间线"), h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, (0, assets_model_js_1.discoverySpanText)(data, (0, helpers_js_1.formatTimestamp)(data.first), (0, helpers_js_1.formatTimestamp)(data.last)) + assets_model_js_1.DISCOVERY_NOTE)), data.days.length === 0 ? h("div", { className: "rt-empty" }, "还没有资产。") : null, h("div", { className: "rt-card" }, h("h4", null, "按天统计", props.discoveryDay !== ""
            ? h("span", {
                className: "rt-tag",
                style: { marginLeft: 6, cursor: "pointer" },
                ...(0, helpers_js_1.clickable)(() => props.onDiscoveryDayChange(""), {
                    label: "清除按天筛选：" + props.discoveryDay,
                }),
            }, "清除筛选：" + props.discoveryDay)
            : null), h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } }, data.days.map((day) => {
            const active = props.discoveryDay === day.day;
            return h("div", {
                key: day.day,
                className: "rt-seg" + (active ? " on" : ""),
                style: { marginBottom: 0, cursor: "pointer" },
                title: day.day + "：新增 " + day.assets + " 台（内网 " + day.internal + " / 外网 " + day.external + "）",
                ...(0, helpers_js_1.clickable)(() => props.onDiscoveryDayChange(active ? "" : day.day), { label: "筛选 " + day.day + " 发现的资产", expanded: active }),
            }, h("div", { className: "rt-seg-cidr" }, day.day), h("div", { className: "rt-seg-meta" }, day.assets + " 台 · 内 " + day.internal + " / 外 " + day.external));
        }))), h("div", { className: "rt-card" }, h("h4", null, props.discoveryDay !== ""
            ? props.discoveryDay + " 发现的资产（" + recent.length + "）"
            : "最近发现的资产（" + recent.length + "）"), recent.length === 0 ? h("div", { className: "rt-empty" }, "这一天没有新增资产。") : null, recent.map((asset) => h("div", { key: asset.id, className: "rt-kv" }, h("b", { className: "rt-mono", style: { minWidth: 110 } }, scopeBadge(runtime, asset.scope, { marginRight: 4 }), asset.ip), h("span", { style: { minWidth: 132, fontSize: 11.5, color: "var(--dsw-alias-label-secondary)" } }, asset.discoveredAt !== "" ? (0, helpers_js_1.formatTimestamp)(asset.discoveredAt) : "时间未知"), h("span", { style: { flex: 1 } }, (asset.primaryName !== "" ? asset.primaryName : "—")
            + (asset.openPorts > 0 ? " · " + asset.openPorts + " 端口" : "")), priorityBadge(runtime, asset.priority, "")))));
    }
    /**
     * 渲染资产测绘页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderAssetsTab(runtime, props) {
        const { h } = runtime;
        // 未选靶标：渲染真实空态（不是空白），与面板的 `!eng` 分支文案对齐。
        if (props.engagement === null || props.engagement === "") {
            return h("div", { className: "rt-main" }, h("div", { className: "rt-empty" }, assets_model_js_1.NO_ENGAGEMENT_TEXT));
        }
        let pane;
        switch (props.view) {
            case "testing":
                pane = props.renderTesting !== undefined
                    ? props.renderTesting()
                    : h("div", { className: "rt-empty" }, "当前测试页面未接线");
                break;
            case "domain":
                pane = domainPane(runtime, props);
                break;
            case "web":
                pane = webPane(runtime, props);
                break;
            case "timeline":
                pane = timelinePane(runtime, props);
                break;
            case "list":
                pane = listPane(runtime, props);
                break;
        }
        const error = props.list?.error ?? null;
        return h("div", { className: "rt-split" }, sidePane(runtime, props), h("div", { className: "rt-main" }, props.view === "testing" ? null : toolbar(runtime, props), conclusionBar(runtime, props), error !== null ? h("div", { className: "rt-err" }, error) : null, pane));
    }
    /** 默认 props（供测试与「未接线」场景使用）。 */
    function defaultAssetsProps(engagement) {
        return {
            engagement,
            snapshot: null,
            filter: assets_model_js_1.DEFAULT_ASSET_FILTER,
            searchDraft: "",
            view: "list",
            list: null,
            domains: null,
            web: null,
            detail: null,
            openId: null,
            showAllId: null,
            notesOpen: false,
            collapsed: {},
            discovery: null,
            discoveryError: null,
            discoveryDay: "",
            onFilterChange: () => undefined,
            onSearchDraftChange: () => undefined,
            onSearch: () => undefined,
            onViewChange: () => undefined,
            onToggleRow: () => undefined,
            onToggleShowAll: () => undefined,
            onToggleNotes: () => undefined,
            onToggleSideGroup: () => undefined,
            onDiscoveryDayChange: () => undefined,
            onDomainAssetClick: () => undefined,
            onRefresh: () => undefined,
            onCopy: () => undefined,
        };
    }
});
/**
 * 攻击文件页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `AttackFilesTab` 只有 84 行，但里面有三个必须钉住的细节：
 *
 * 1. **文件类型的显示名**（`FILE_KIND`）：`poc` → `POC`、`exp` → `EXP`、
 *    `script` → `脚本`、`wordlist` → `字典`、`other` → `其他`。
 *    未知类型**原样显示**（不兜底成「其他」）—— 上游加了新类型时界面能暴露出来。
 * 2. **详情只能同时展开一个**：`detail.id === f.id` 判定，点同一条收起。
 * 3. **文件夹计数与文件数可能不一致**：`folder.count` 是服务端统计，
 *    `folder.files` 是本页拿到的（可能被截断）。工具栏的「N 个文件」
 *    用 `count` 求和（与文件夹头一致），不数数组长度。
 *
 * ## 一个真实的空态分支
 *
 * `folder.files` 为空但文件夹存在时，展开后显示「（空）」而不是整块消失 ——
 * 这与「没有任何文件夹」是两种状态。
 */
define("redteam/client/attackfiles-model", ["require", "exports", "redteam/client/helpers"], function (require, exports, helpers_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.FILES_ERROR_FALLBACK = exports.FILES_FOOTER = exports.EMPTY_FILES_MESSAGE = exports.FILE_KIND_LABEL = void 0;
    exports.countOrZero = countOrZero;
    exports.kindLabel = kindLabel;
    exports.fileRowOf = fileRowOf;
    exports.fileFolderOf = fileFolderOf;
    exports.fileFoldersOf = fileFoldersOf;
    exports.folderCount = folderCount;
    exports.fileCount = fileCount;
    exports.folderTitle = folderTitle;
    exports.folderCountLabel = folderCountLabel;
    exports.folderCollapseKey = folderCollapseKey;
    exports.fileDetailOf = fileDetailOf;
    exports.detailRecordedLine = detailRecordedLine;
    exports.detailContent = detailContent;
    exports.detailEvidence = detailEvidence;
    exports.caretOf = caretOf;
    exports.isRowOpen = isRowOpen;
    exports.nextDetailId = nextDetailId;
    exports.toolbarCountLabel = toolbarCountLabel;
    exports.refreshLabel = refreshLabel;
    exports.filesErrorOf = filesErrorOf;
    exports.rowTitle = rowTitle;
    exports.rowDescription = rowDescription;
    exports.rowName = rowName;
    /** 文件类型 → 中文。 */
    exports.FILE_KIND_LABEL = Object.freeze({
        poc: "POC",
        exp: "EXP",
        script: "脚本",
        wordlist: "字典",
        other: "其他",
    });
    /** 空态文案。 */
    exports.EMPTY_FILES_MESSAGE = "暂无攻击文件（打通的脚本/POC/EXP 会按目标文件夹出现在这里）";
    /** 底部说明。 */
    exports.FILES_FOOTER = "目录：attack-files/<IP|URL主机|C段>/ ｜ 只收录实际生效的文件";
    /** 读取失败的兜底文案。 */
    exports.FILES_ERROR_FALLBACK = "读取失败";
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组。 */
    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 读有限数字（非有限 → `null`）。 */
    function numberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 读计数字段（非有限 / 负数 → 0）。 */
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 类型的中文名（未知原样显示；空串 → `—`）。 */
    function kindLabel(kind) {
        if (kind === "")
            return "—";
        return exports.FILE_KIND_LABEL[kind] ?? kind;
    }
    /** 解析一个文件行。 */
    function fileRowOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            name: text(item["name"]),
            kind: text(item["kind"]),
            description: text(item["description"]),
        };
    }
    /** 解析一个文件夹。 */
    function fileFolderOf(raw) {
        const item = asRecord(raw);
        const folder = text(item["folder"]);
        if (folder === "")
            return null;
        const files = asArray(item["files"])
            .map(fileRowOf)
            .filter((entry) => entry !== null);
        // `count` 缺失时退回数组长度：否则工具栏会显示「0 个文件」而列表里有内容。
        const rawCount = numberOrNull(item["count"]);
        return {
            folder,
            count: rawCount === null ? files.length : countOrZero(rawCount),
            files,
        };
    }
    /** 解析 `attackFiles` 响应。 */
    function fileFoldersOf(response) {
        if ((0, helpers_js_2.isFailure)(response))
            return [];
        return asArray(asRecord(response)["items"])
            .map(fileFolderOf)
            .filter((entry) => entry !== null);
    }
    /** 文件夹总数（工具栏的「N 个目标」）。 */
    function folderCount(folders) {
        return folders.length;
    }
    /**
     * 文件总数（工具栏的「N 个文件」）。
     *
     * 用 `count` 求和而不是 `files.length` —— 与文件夹头上的计数一致，
     * 也包含服务端统计到但本页没取回的文件。
     */
    function fileCount(folders) {
        return folders.reduce((sum, folder) => sum + folder.count, 0);
    }
    /** 文件夹的标题（`folder/`）。 */
    function folderTitle(folder) {
        return folder.folder + "/";
    }
    /** 文件夹的计数文案。 */
    function folderCountLabel(folder) {
        return folder.count + " 个文件";
    }
    /** 文件夹的折叠键（`folder:<name>`）。 */
    function folderCollapseKey(folder) {
        return "folder:" + folder.folder;
    }
    /** 解析文件详情。 */
    function fileDetailOf(response) {
        if ((0, helpers_js_2.isFailure)(response))
            return null;
        const body = asRecord(response);
        const id = numberOrNull(body["id"]);
        if (id === null)
            return null;
        return {
            id,
            name: text(body["name"]),
            content: text(body["content"]),
            path: text(body["path"]),
            evidence: text(body["evidence"]),
            createdAt: text(body["created_at"]) || text(body["createdAt"]),
            createdBy: text(body["created_by"]) || text(body["createdBy"]),
        };
    }
    /** 详情里的「记录」行（时间 + 记录人）。 */
    function detailRecordedLine(detail) {
        return (0, helpers_js_2.formatTimestamp)(detail.createdAt)
            + (detail.createdBy !== "" ? " · " + detail.createdBy : "");
    }
    /** 详情正文（空 → `（空）`）。 */
    function detailContent(detail) {
        return detail.content !== "" ? detail.content : "（空）";
    }
    /** 详情里的「效果」行（空 → `—`）。 */
    function detailEvidence(detail) {
        return detail.evidence !== "" ? detail.evidence : "—";
    }
    /** 行首的折叠箭头（展开 → `▾`，否则 `▸`）。 */
    function caretOf(open) {
        return open ? "▾" : "▸";
    }
    /** 行是否展开（`detail` 存在且 id 相同）。 */
    function isRowOpen(detail, fileId) {
        return detail !== null && detail.id === fileId;
    }
    /**
     * 点击一个文件后的目标状态。
     *
     * 原实现：点同一条（已展开）→ 收起；点别的 → 先清空再重新读。
     * 这里只决定「应选中谁」，`null` 表示收起。
     */
    function nextDetailId(current, clicked) {
        return current === clicked ? null : clicked;
    }
    /** 工具栏的计数文案（`N 个目标 / M 个文件`）。 */
    function toolbarCountLabel(folders) {
        return folderCount(folders) + " 个目标 / " + fileCount(folders) + " 个文件";
    }
    /** 刷新按钮的文案。 */
    function refreshLabel(busy) {
        return busy ? "刷新中…" : "刷新";
    }
    /** 读取错误的文案（失败响应里的 `error`，缺失回退）。 */
    function filesErrorOf(response, fallback = exports.FILES_ERROR_FALLBACK) {
        const error = asRecord(response)["error"];
        return typeof error === "string" && error !== "" ? error : fallback;
    }
    /** 文件行的 title（描述；空 → 空串）。 */
    function rowTitle(file) {
        return file.description;
    }
    /** 文件行的描述显示值（空 → `—`）。 */
    function rowDescription(file) {
        return file.description !== "" ? file.description : "—";
    }
    /** 文件行的文件名（空 → `(未命名)`）。 */
    function rowName(file) {
        return file.name !== "" ? file.name : "(未命名)";
    }
});
/**
 * 攻击文件页（`attackfiles` 页签）的渲染。
 *
 * 数据与判定全在 `attackfiles-model.ts`，这里只排版。
 *
 * ## 版面（按目标文件夹折叠）
 *
 * ```
 * 工具栏：攻击文件 · N 个目标 / M 个文件 | 刷新
 * ▾ 10.0.0.5/  3 个文件
 *     ▸ vnc_brute.py   [脚本]  VNC 弱口令爆破
 *     ▾ poc.sh         [POC]   回显 uid=0
 *       效果 … / 路径 … / 记录 … / 正文
 * ```
 *
 * ## 一个原实现的细节，这里保留
 *
 * 文件夹**默认展开**（`isSectionOpen(state, key, true)`）：攻击文件页的
 * 全部内容就是这些文件，默认折叠会让第一次进来的人看到一片空白标题。
 */
define("redteam/client/attackfiles-tab", ["require", "exports", "redteam/client/state", "redteam/client/attackfiles-model"], function (require, exports, state_js_2, attackfiles_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderAttackFilesTab = renderAttackFilesTab;
    exports.loadAttackFiles = loadAttackFiles;
    exports.loadAttackFile = loadAttackFile;
    exports.totalFileCount = totalFileCount;
    /** 一行文件。 */
    function fileRowNode(runtime, props, file) {
        const { h } = runtime;
        // 展开态是 `detail` 的派生值：不额外加布尔 props，避免第二个真相来源。
        const open = (0, attackfiles_model_js_1.isRowOpen)(props.detail, file.id);
        return h("div", {
            key: "a" + file.id,
            className: "rt-vrow",
            style: { gridTemplateColumns: "18px 1.2fr 60px 1.6fr", cursor: "pointer" },
            role: "button",
            tabIndex: 0,
            onClick: () => props.onOpenFile(file),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onOpenFile(file);
                }
            },
        }, h("span", { className: "rt-sec-caret" }, (0, attackfiles_model_js_1.caretOf)(open)), h("span", { className: "rt-mono" }, (0, attackfiles_model_js_1.rowName)(file)), h("span", null, h("span", { className: "rt-tag rt-tag-active" }, (0, attackfiles_model_js_1.kindLabel)(file.kind))), h("span", {
            style: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary)" },
            title: (0, attackfiles_model_js_1.rowTitle)(file),
        }, (0, attackfiles_model_js_1.rowDescription)(file)));
    }
    /** 一个文件夹（含展开详情的行）。 */
    function folderNode(runtime, props, folder) {
        const { h } = runtime;
        const key = (0, attackfiles_model_js_1.folderCollapseKey)(folder);
        const open = (0, state_js_2.isSectionOpen)(props.collapse, key, true);
        const children = [];
        for (const file of folder.files) {
            children.push(fileRowNode(runtime, props, file));
            const detail = props.detail;
            if (detail === null || detail.id !== file.id)
                continue;
            children.push(h("div", {
                key: "ad" + file.id,
                className: "rt-vrow",
                style: { cursor: "default", gridTemplateColumns: "1fr" },
            }, h("div", { className: "rt-vdetail" }, h("div", { className: "rt-kv" }, h("b", null, "效果"), h("span", null, (0, attackfiles_model_js_1.detailEvidence)(detail))), h("div", { className: "rt-kv" }, h("b", null, "路径"), h("span", { className: "rt-mono", style: { wordBreak: "break-all" } }, detail.path)), h("div", { className: "rt-kv" }, h("b", null, "记录"), h("span", null, (0, attackfiles_model_js_1.detailRecordedLine)(detail))), h("pre", {
                className: "rt-md",
                style: {
                    border: "1px solid var(--dsw-alias-border-l1)",
                    borderRadius: 6,
                    maxHeight: "40vh",
                    padding: "10px 12px",
                },
            }, (0, attackfiles_model_js_1.detailContent)(detail)))));
        }
        return h("div", { key: "sec:" + folder.folder, className: "rt-sec-wrap" }, h("div", {
            className: "rt-sec t-folder",
            role: "button",
            tabIndex: 0,
            "aria-expanded": open ? "true" : "false",
            onClick: () => props.onCollapseChange((0, state_js_2.toggleSection)(props.collapse, key, true)),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onCollapseChange((0, state_js_2.toggleSection)(props.collapse, key, true));
                }
            },
        }, h("span", { className: "rt-sec-caret" }, (0, attackfiles_model_js_1.caretOf)(open)), h("span", { className: "rt-sec-title" }, (0, attackfiles_model_js_1.folderTitle)(folder)), h("span", { className: "rt-sec-count" }, (0, attackfiles_model_js_1.folderCountLabel)(folder))), open
            ? h("div", { className: "rt-sec-body" }, children.length > 0
                ? children
                : h("div", { className: "rt-atest-meta" }, "（空）"))
            : null);
    }
    /**
     * 渲染攻击文件页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderAttackFilesTab(runtime, props) {
        const { h } = runtime;
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "攻击文件"), h("span", { className: "rt-tag" }, (0, attackfiles_model_js_1.toolbarCountLabel)(props.folders)), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            disabled: props.busy,
            onClick: () => props.onRefresh(),
        }, (0, attackfiles_model_js_1.refreshLabel)(props.busy)));
        const errorNode = props.error !== null ? h("div", { className: "rt-err" }, props.error) : null;
        return h("div", { className: "rt-main" }, toolbar, errorNode, h("div", { className: "rt-table" }, props.folders.map((folder) => folderNode(runtime, props, folder)), (0, attackfiles_model_js_1.folderCount)(props.folders) === 0
            ? h("div", { className: "rt-empty" }, attackfiles_model_js_1.EMPTY_FILES_MESSAGE)
            : null), h("div", { className: "rt-foot" }, h("span", null, attackfiles_model_js_1.FILES_FOOTER)));
    }
    /** 读攻击文件列表。 */
    async function loadAttackFiles(api, engagement) {
        return api.raw({ op: "attackFiles", engagement });
    }
    /** 读一个文件的正文。 */
    async function loadAttackFile(api, engagement, id) {
        return api.raw({ op: "readAttackFile", engagement, id });
    }
    /** 文件总数（供容器在外部统计用）。 */
    function totalFileCount(folders) {
        return (0, attackfiles_model_js_1.fileCount)(folders);
    }
});
/**
 * 攻击链页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `ChainTab` 的 205 行里，约 120 行是**五个阶段的排版**，而真正需要
 * 被测试锁住的是这几条规则：
 *
 * 1. **阶段编号来自数组顺序，不是 `ordinal` 字段**：原实现用
 *    `CIRCLED[i] || ('0' + (i + 1))` —— 第六个阶段起退化成 `06`、`07`。
 *    这不是缺陷，是「只设计了五个圈号」的诚实降级。
 * 2. **累计分取服务端值**：`st.cumulative` 直接显示，不在前端累加 ——
 *    前端的漏洞状态与后端可能不一致，用本地累加会让总分与得分页对不上。
 * 3. **边界突破阶段的「只在自己 VPS 上」的通道不算突破**：`self-only`
 *    必须单独提示，否则用户会以为「有 socks5 就算打进内网了」。
 *
 * ## 一个容易漏的空态
 *
 * `data !== null && stages.length === 0` 与 `data === null` 是**两种不同**状态：
 * 前者是「读到了，但还没有得分记录」，后者是「还没读回来」。
 * 合并会让首次加载时闪一下「还没有得分记录」。
 */
define("redteam/client/chain-model", ["require", "exports", "redteam/client/helpers"], function (require, exports, helpers_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.COMPACT_TUNNEL_LIMIT = exports.COMPACT_LIMIT = exports.SELF_ONLY_WARNING = exports.CIRCLED = exports.CHAIN_FLOW_LABEL = exports.EMPTY_CHAIN_MESSAGE = void 0;
    exports.stageNumber = stageNumber;
    exports.stageNumberCompact = stageNumberCompact;
    exports.chainHitOf = chainHitOf;
    exports.chainAssetOf = chainAssetOf;
    exports.chainTunnelOf = chainTunnelOf;
    exports.chainStageOf = chainStageOf;
    exports.chainDataOf = chainDataOf;
    exports.isReconStage = isReconStage;
    exports.isBoundaryStage = isBoundaryStage;
    exports.stageHitsLabel = stageHitsLabel;
    exports.reconAssetsLabel = reconAssetsLabel;
    exports.stageAssetsLabel = stageAssetsLabel;
    exports.tunnelsLabel = tunnelsLabel;
    exports.showsSelfOnlyWarning = showsSelfOnlyWarning;
    exports.stageEmptyMessage = stageEmptyMessage;
    exports.tunnelStatusLabel = tunnelStatusLabel;
    exports.tunnelStatusClass = tunnelStatusClass;
    exports.tunnelStatusStyle = tunnelStatusStyle;
    exports.cumulativeLabel = cumulativeLabel;
    exports.totalLabel = totalLabel;
    exports.hitPointsLabel = hitPointsLabel;
    exports.nthLabel = nthLabel;
    exports.hitTarget = hitTarget;
    exports.hitActionLabel = hitActionLabel;
    exports.hitTimesLine = hitTimesLine;
    exports.hitRecordedLine = hitRecordedLine;
    exports.hitVulnLine = hitVulnLine;
    exports.assetPriorityLabel = assetPriorityLabel;
    exports.assetPortsLabel = assetPortsLabel;
    exports.assetVulnsLabel = assetVulnsLabel;
    exports.assetPointsLabel = assetPointsLabel;
    exports.assetHitsLabel = assetHitsLabel;
    exports.assetScopeLabel = assetScopeLabel;
    exports.assetScopeClass = assetScopeClass;
    exports.compactAssetScope = compactAssetScope;
    exports.compactTunnelHit = compactTunnelHit;
    exports.compactReconHit = compactReconHit;
    exports.compactHitsLabel = compactHitsLabel;
    exports.moreHitsLabel = moreHitsLabel;
    exports.compactAssetCountLabel = compactAssetCountLabel;
    exports.viewRootClass = viewRootClass;
    exports.viewButtonClass = viewButtonClass;
    exports.viewButtonTitle = viewButtonTitle;
    exports.viewButtonLabel = viewButtonLabel;
    exports.stageHeadStyle = stageHeadStyle;
    exports.stagePointsStyle = stagePointsStyle;
    exports.stageNumberStyle = stageNumberStyle;
    exports.stageNumberCompactStyle = stageNumberCompactStyle;
    /** 空态文案。 */
    exports.EMPTY_CHAIN_MESSAGE = "还没有得分记录。拿到成果后用 redteam_score_hit 记分，这条链才会长出来。";
    /** 阶段目标说明条（工具栏上的提示）。 */
    exports.CHAIN_FLOW_LABEL = "信息收集 → 互联网资产权限 → 边界突破 → 内网资产权限 → 靶标权限";
    /** 圈号（只有五个；第六个起退化成两位数字）。 */
    exports.CIRCLED = Object.freeze(["①", "②", "③", "④", "⑤", "⑥"]);
    /** 阶段序号标签（`CIRCLED[i]` 或零填充）。 */
    function stageNumber(index) {
        return exports.CIRCLED[index] ?? "0" + String(index + 1);
    }
    /**
     * 横向视图的阶段序号（与竖向不同：横向只显示阿拉伯数字）。
     *
     * 原实现：竖向用圈号、横向用 `String(i + 1)` —— 横向列窄，圈号会挤。
     */
    function stageNumberCompact(index) {
        return String(index + 1);
    }
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组。 */
    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 读有限数字（非有限 → 0）。 */
    function numberOf(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    /** 读有限数字（非有限 → `null`）。 */
    function numberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 解析一次得分命中。 */
    function chainHitOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        const action = asRecord(item["action"]);
        const hasAction = Object.keys(action).length > 0;
        return {
            id,
            pointName: text(item["point_name"]),
            points: numberOf(item["points"]),
            // 缺省算「计分」：`counted !== false` —— 老 host 不给这个字段。
            counted: item["counted"] !== false,
            capped: item["capped"] === true,
            cappedReason: text(item["capped_reason"]),
            nthOfPoint: numberOf(item["nth_of_point"]),
            target: text(item["target"]),
            assetIp: text(item["asset_ip"]),
            vulnTitle: text(item["vuln_title"]),
            vulnCve: text(item["vuln_cve"]),
            recordedAt: text(item["recorded_at"]),
            recordedBy: text(item["recorded_by"]),
            evidence: text(item["evidence"]),
            actionTitle: text(action["title"]),
            actionInferred: item["action_inferred"] === true,
            hasAction,
        };
    }
    /** 解析一个资产。 */
    function chainAssetOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            ip: text(item["ip"]),
            scope: text(item["scope"]),
            segmentCidr: text(item["segment_cidr"]),
            openPorts: numberOf(item["open_ports"]),
            vulns: numberOf(item["vulns"]),
            priority: text(item["priority"]),
            points: numberOf(item["points"]),
            hits: numberOf(item["hits"]),
        };
    }
    /** 解析一条隧道。 */
    function chainTunnelOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            kind: text(item["kind"]),
            listen: text(item["listen"]),
            reach: text(item["reach"]),
            status: text(item["status"]),
        };
    }
    /** 解析一个阶段。 */
    function chainStageOf(raw) {
        const item = asRecord(raw);
        const code = text(item["code"]);
        if (code === "")
            return null;
        const selfOnly = asArray(item["tunnels_self_only"])
            .map(chainTunnelOf)
            .filter((entry) => entry !== null);
        return {
            code,
            name: text(item["name"]) || code,
            subtitle: text(item["subtitle"]),
            goal: text(item["goal"]),
            color: text(item["color"]),
            points: numberOf(item["points"]),
            cumulative: numberOf(item["cumulative"]),
            hits: numberOf(item["hits"]),
            assetCount: numberOf(item["assetCount"]) || numberOf(item["asset_count"]),
            assets: asArray(item["assets"])
                .map(chainAssetOf)
                .filter((entry) => entry !== null),
            items: asArray(item["items"])
                .map(chainHitOf)
                .filter((entry) => entry !== null),
            tunnels: asArray(item["tunnels"])
                .map(chainTunnelOf)
                .filter((entry) => entry !== null),
            tunnelsSelfOnly: selfOnly,
            transition: text(item["transition"]),
        };
    }
    /** 解析 `scoreChain` 响应（失败 → `null`）。 */
    function chainDataOf(response) {
        if ((0, helpers_js_3.isFailure)(response))
            return null;
        const body = asRecord(response);
        const summary = asRecord(body["summary"]);
        return {
            stages: asArray(body["stages"])
                .map(chainStageOf)
                .filter((entry) => entry !== null),
            summary: Object.keys(summary).length > 0 ? { points: numberOf(summary["points"]) } : null,
        };
    }
    /** 是否信息收集阶段（渲染分支不同）。 */
    function isReconStage(stage) {
        return stage.code === "recon";
    }
    /** 是否边界突破阶段（要额外渲染隧道清单）。 */
    function isBoundaryStage(stage) {
        return stage.code === "boundary";
    }
    /** 阶段的「本阶段命中」小标题。 */
    function stageHitsLabel(stage) {
        return "本阶段命中 " + stage.hits + " 次" + (stage.points !== 0 ? " · +" + stage.points + " 分" : "");
    }
    /** 信息收集阶段的资产小标题。 */
    function reconAssetsLabel(stage) {
        return "拿到分数的资产 · " + stage.assetCount + " 台";
    }
    /** 其它阶段涉及资产的小标题。 */
    function stageAssetsLabel(stage) {
        return "涉及资产 · " + stage.assetCount + " 台";
    }
    /** 边界突破阶段的隧道小标题（含 self-only 说明）。 */
    function tunnelsLabel(stage) {
        const selfOnly = stage.tunnelsSelfOnly.length;
        return "跨越靶标边界的通道 · " + stage.tunnels.length + " 条"
            + (selfOnly > 0
                ? "（另有 " + selfOnly + " 条只在自己 VPS/自建服务器上，不算突破）"
                : "");
    }
    /**
     * 是否要显示「现有通道都在自己服务器上」的警示。
     *
     * 条件：**有** self-only 通道，且**没有**任何真正跨越边界的通道。
     * 只要有一条真通道就不警示 —— 那时 self-only 只是补充信息。
     */
    function showsSelfOnlyWarning(stage) {
        return stage.tunnelsSelfOnly.length > 0 && stage.tunnels.length === 0;
    }
    /** self-only 警示文案。 */
    exports.SELF_ONLY_WARNING = "⚠️ 现有的通道都在自己的服务器上，没有碰到目标 —— 不计边界突破。"
        + "需要目标侧发起的通道（反弹 shell 到我这 / 目标上跑 frp 客户端 / 经目标 WebShell 的 suo5）。";
    /** 阶段空的文案。 */
    function stageEmptyMessage(stage) {
        return isReconStage(stage) ? "还没有产生得分的资产" : "本阶段还没有得分";
    }
    /** 隧道的状态标签（`active` → 可用）。 */
    function tunnelStatusLabel(tunnel) {
        if (tunnel.status === "active")
            return "可用";
        return tunnel.status !== "" ? tunnel.status : "未知";
    }
    /** 隧道状态块的 className。 */
    function tunnelStatusClass(tunnel) {
        return "rt-tag " + (tunnel.status === "active" ? "rt-tag-live" : "");
    }
    /** 隧道状态块的 style（非可用时降低不透明度）。 */
    function tunnelStatusStyle(tunnel) {
        return tunnel.status === "active" ? undefined : { opacity: 0.7 };
    }
    /** 累计分标签。 */
    function cumulativeLabel(stage) {
        return "累计 " + stage.cumulative + " 分";
    }
    /** 合计说明（最后一个阶段之后那条）。 */
    function totalLabel(summary) {
        return "合计 " + (summary?.points ?? 0) + " 分";
    }
    /** 得分徽章上的显示值（`capped` 时算 0 —— 服务已拿满不计分）。 */
    function hitPointsLabel(hit) {
        return "+" + (hit.counted ? hit.points : 0);
    }
    /**
     * 「同类第 N 次」标签。
     *
     * 只在 `nth_of_point > 1` 时显示 —— 第一次是常态，标出来只是噪声。
     */
    function nthLabel(hit) {
        return hit.nthOfPoint > 1 ? "第 " + hit.nthOfPoint + " 次" : null;
    }
    /** 命中行的目标（`target` → `asset_ip` → `—`）。 */
    function hitTarget(hit) {
        if (hit.target !== "")
            return hit.target;
        return hit.assetIp !== "" ? hit.assetIp : "—";
    }
    /** 命中行的动作说明。 */
    function hitActionLabel(hit) {
        const title = hit.actionTitle !== "" ? hit.actionTitle : "（未命名步骤）";
        return "动作：" + title + (hit.actionInferred ? "（推断）" : "");
    }
    /** 命中详情的「次数」行。 */
    function hitTimesLine(hit) {
        return "同类第 " + hit.nthOfPoint + " 次 · +" + hit.points + " 分";
    }
    /** 命中详情的「记录」行。 */
    function hitRecordedLine(hit) {
        return (0, helpers_js_3.formatTimestamp)(hit.recordedAt) + (hit.recordedBy !== "" ? " · " + hit.recordedBy : "");
    }
    /** 命中详情的「利用漏洞」行（CVE + 标题）。 */
    function hitVulnLine(hit) {
        return [hit.vulnCve, hit.vulnTitle].filter((part) => part !== "").join(" ");
    }
    /** 资产行的优先级标签（`易打 N`；无优先级 → `null`）。 */
    function assetPriorityLabel(asset) {
        return asset.priority !== "" ? "易打 " + asset.priority : null;
    }
    /** 资产行的端口说明。 */
    function assetPortsLabel(asset) {
        return "端口 " + asset.openPorts;
    }
    /** 资产行的漏洞说明（0 条时不显示）。 */
    function assetVulnsLabel(asset) {
        return asset.vulns !== 0 ? "漏洞 " + asset.vulns : null;
    }
    /** 资产行的得分。 */
    function assetPointsLabel(asset) {
        return "+" + asset.points + " 分";
    }
    /** 资产行的命中次数。 */
    function assetHitsLabel(asset) {
        return asset.hits + " 次";
    }
    /** 资产行的内外网标签。 */
    function assetScopeLabel(asset) {
        return asset.scope === "internal" ? "内" : "外";
    }
    /** 资产行的内外网 className。 */
    function assetScopeClass(asset) {
        return "rt-scope rt-scope-" + (asset.scope === "internal" ? "internal" : "external");
    }
    /** 横向视图里资产行的前缀（`内 ` / `外 `）。 */
    function compactAssetScope(asset) {
        return asset.scope === "internal" ? "内 " : "外 ";
    }
    /** 横向视图里边界阶段的命中说明。 */
    function compactTunnelHit(stage) {
        return "隧道 " + stage.tunnels.length + " 条";
    }
    /** 横向视图里信息收集阶段的命中说明。 */
    function compactReconHit(stage) {
        return stage.assetCount + " 台资产拿到分";
    }
    /** 横向视图里其它阶段的命中说明。 */
    function compactHitsLabel(stage) {
        return stage.hits + " 次命中";
    }
    /** 横向视图的截断：只列前 N 条，余下用「另有 N 次」。 */
    exports.COMPACT_LIMIT = 6;
    /** 横向视图隧道的截断数。 */
    exports.COMPACT_TUNNEL_LIMIT = 3;
    /** 「另有 N 次」的文案（不足时 → `null`）。 */
    function moreHitsLabel(total) {
        return total > exports.COMPACT_LIMIT ? "…另有 " + (total - exports.COMPACT_LIMIT) + " 次" : null;
    }
    /** 「涉及 N 台资产」的文案（0 台时 → `null`）。 */
    function compactAssetCountLabel(stage) {
        return stage.assetCount !== 0 ? "涉及 " + stage.assetCount + " 台资产" : null;
    }
    /** 竖向视图根容器的 className。 */
    function viewRootClass(view) {
        return view === "A" ? "rt-ap" : "rt-ap-h";
    }
    /** 视图切换按钮的 className。 */
    function viewButtonClass(view, current) {
        return "rt-btn" + (current === view ? " rt-btn-primary" : "");
    }
    /** 视图切换按钮的 title。 */
    function viewButtonTitle(view) {
        return view === "A"
            ? "竖向攻击链：逐阶段向下看细节"
            : "横向攻击链：一屏看完五个阶段";
    }
    /** 视图切换按钮的文案。 */
    function viewButtonLabel(view) {
        return view === "A" ? "链路 A" : "链路 B";
    }
    /** 阶段标题块的 className（带颜色的左边框）。 */
    function stageHeadStyle(color) {
        return { borderLeftColor: color };
    }
    /** 阶段的得分徽章 style（带透明背景与边框）。 */
    function stagePointsStyle(color) {
        return { background: color + "22", color, borderColor: color + "66" };
    }
    /** 阶段编号块的 style。 */
    function stageNumberStyle(color) {
        return { background: color };
    }
    /** 横向视图阶段编号块的 style（更小）。 */
    function stageNumberCompactStyle(color) {
        return { background: color, width: 16, height: 16, fontSize: 10 };
    }
});
/**
 * 攻击链页（`chain` 页签）的渲染。
 *
 * 数据与判定全在 `chain-model.ts`，这里只排版。
 *
 * ## 两个视图
 *
 * - **A（竖向）**：五个阶段自上而下，每段给「阶段目标 → 本阶段命中 / 资产 /
 *   隧道 → 累计分」，段间用 `▼` 连接并重复累计分。
 * - **B（横向）**：一屏五列，只留数字与列表项，`▶` 连接。
 *
 * 两个视图共用同一份 `stages` —— 切换只改渲染形态，不重新取数。
 *
 * ## 一个原实现的取舍，这里保留
 *
 * 攻击链**只讲「打到哪了、拿了多少分」**，不展示打法要点与工具清单。
 * 原注释写得很清楚：那些是执行细节，混在链路里会淹没得分与资产信息。
 */
define("redteam/client/chain-tab", ["require", "exports", "redteam/client/chain-model"], function (require, exports, chain_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderChainTab = renderChainTab;
    exports.loadChain = loadChain;
    exports.chainOf = chainOf;
    exports.chainErrorOf = chainErrorOf;
    exports.nextView = nextView;
    exports.toggleHitOpen = toggleHitOpen;
    /** 单次得分的详情。 */
    function hitDetail(runtime, hit) {
        const { h } = runtime;
        const vulnLine = (0, chain_model_js_1.hitVulnLine)(hit);
        return h("div", { className: "rt-flow-detail" }, h("div", { className: "rt-kv" }, h("b", null, "目标"), h("span", { className: "rt-mono", style: { wordBreak: "break-all" } }, hit.target !== "" ? hit.target : "—")), hit.assetIp !== ""
            ? h("div", { className: "rt-kv" }, h("b", null, "资产"), h("span", { className: "rt-mono" }, hit.assetIp))
            : null, hit.vulnTitle !== ""
            ? h("div", { className: "rt-kv" }, h("b", null, "利用漏洞"), h("span", null, vulnLine))
            : null, h("div", { className: "rt-kv" }, h("b", null, "次数"), h("span", null, (0, chain_model_js_1.hitTimesLine)(hit))), h("div", { className: "rt-kv" }, h("b", null, "记录"), h("span", null, (0, chain_model_js_1.hitRecordedLine)(hit))), hit.evidence !== ""
            ? h("div", { className: "rt-kv" }, h("b", null, "结果与证据"), h("span", null, hit.evidence))
            : null);
    }
    /** 一条得分命中。 */
    function hitRow(runtime, props, hit) {
        const { h } = runtime;
        const open = props.openId === hit.id;
        const nth = (0, chain_model_js_1.nthLabel)(hit);
        return h("div", {
            key: "h" + hit.id,
            className: "rt-ap-hit" + (open ? " open" : ""),
            role: "button",
            tabIndex: 0,
            onClick: () => props.onToggleHit(hit.id),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onToggleHit(hit.id);
                }
            },
        }, h("div", { className: "rt-ap-hit-head" }, h("span", {
            className: "rt-ap-pts" + (hit.counted ? "" : " uncounted"),
            title: hit.cappedReason !== "" ? hit.cappedReason : undefined,
        }, (0, chain_model_js_1.hitPointsLabel)(hit)), h("span", { className: "rt-ap-hit-name" }, hit.pointName), hit.capped
            ? h("span", {
                className: "rt-tag rt-tag-warn",
                title: hit.cappedReason !== "" ? hit.cappedReason : "同一资产同一端口只算分值最高的一条",
            }, "服务已拿满 · 不计分")
            : null, nth !== null ? h("span", { className: "rt-ap-nth" }, nth) : null, h("span", { className: "rt-ap-hit-target" }, (0, chain_model_js_1.hitTarget)(hit))), hit.hasAction
            ? h("div", { className: "rt-ap-act" + (hit.actionInferred ? " inferred" : "") }, (0, chain_model_js_1.hitActionLabel)(hit))
            : null, open ? hitDetail(runtime, hit) : null);
    }
    /** 一行资产。 */
    function assetRow(runtime, asset) {
        const { h } = runtime;
        const priority = (0, chain_model_js_1.assetPriorityLabel)(asset);
        const vulns = (0, chain_model_js_1.assetVulnsLabel)(asset);
        return h("div", { key: "a" + asset.id, className: "rt-ap-asset" }, h("span", { className: (0, chain_model_js_1.assetScopeClass)(asset) }, (0, chain_model_js_1.assetScopeLabel)(asset)), h("span", { className: "rt-mono", style: { fontWeight: 600 } }, asset.ip), asset.segmentCidr !== "" ? h("span", { className: "rt-ap-nth" }, asset.segmentCidr) : null, h("span", { className: "rt-ap-nth" }, (0, chain_model_js_1.assetPortsLabel)(asset)), vulns !== null ? h("span", { className: "rt-ap-nth" }, vulns) : null, priority !== null ? h("span", { className: "rt-tag" }, priority) : null, h("div", { className: "rt-spacer" }), h("span", { className: "rt-ap-pts" }, (0, chain_model_js_1.assetPointsLabel)(asset)), h("span", { className: "rt-ap-nth" }, (0, chain_model_js_1.assetHitsLabel)(asset)));
    }
    /** 一条隧道。 */
    function tunnelRow(runtime, tunnel) {
        const { h } = runtime;
        return h("div", { key: "t" + tunnel.id, className: "rt-ap-tunnel" }, h("span", { className: "rt-tag rt-tag-passive" }, tunnel.kind !== "" ? tunnel.kind : "tunnel"), h("span", { className: "rt-mono", style: { fontWeight: 600 } }, tunnel.listen !== "" ? tunnel.listen : "—"), h("span", {
            className: (0, chain_model_js_1.tunnelStatusClass)(tunnel),
            style: (0, chain_model_js_1.tunnelStatusStyle)(tunnel) ?? {},
        }, (0, chain_model_js_1.tunnelStatusLabel)(tunnel)), h("span", {
            className: "rt-ap-nth",
            style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
        }, "可达 " + (tunnel.reach !== "" ? tunnel.reach : "—")));
    }
    /** 竖向视图的一个阶段。 */
    function stageVertical(runtime, props, stage, index, total) {
        const { h } = runtime;
        const body = [];
        if ((0, chain_model_js_1.isReconStage)(stage)) {
            body.push(h("div", { key: "at", className: "rt-ap-sub" }, (0, chain_model_js_1.reconAssetsLabel)(stage)));
            body.push(h("div", { key: "al", className: "rt-ap-assets" }, stage.assets.length > 0
                ? stage.assets.map((asset) => assetRow(runtime, asset))
                : h("div", { className: "rt-ap-none" }, (0, chain_model_js_1.stageEmptyMessage)(stage))));
        }
        else {
            body.push(h("div", { key: "ht", className: "rt-ap-sub" }, (0, chain_model_js_1.stageHitsLabel)(stage)));
            body.push(h("div", { key: "hl", className: "rt-ap-hits" }, stage.items.length > 0
                ? stage.items.map((hit) => hitRow(runtime, props, hit))
                : h("div", { className: "rt-ap-none" }, (0, chain_model_js_1.stageEmptyMessage)(stage))));
            if ((0, chain_model_js_1.isBoundaryStage)(stage)) {
                body.push(h("div", { key: "tt", className: "rt-ap-sub" }, (0, chain_model_js_1.tunnelsLabel)(stage)));
                if ((0, chain_model_js_1.showsSelfOnlyWarning)(stage)) {
                    body.push(h("div", { key: "tw", className: "rt-ap-none" }, chain_model_js_1.SELF_ONLY_WARNING));
                }
                body.push(h("div", { key: "tl", className: "rt-ap-tunnels" }, stage.tunnels.length > 0
                    ? stage.tunnels.map((tunnel) => tunnelRow(runtime, tunnel))
                    : h("div", { className: "rt-ap-none" }, "还没有建立隧道（建好后用 redteam_tunnel_add 登记）")));
            }
            if (stage.assets.length > 0 && !(0, chain_model_js_1.isBoundaryStage)(stage)) {
                body.push(h("div", { key: "at", className: "rt-ap-sub" }, (0, chain_model_js_1.stageAssetsLabel)(stage)));
                body.push(h("div", { key: "al", className: "rt-ap-assets" }, stage.assets.map((asset) => assetRow(runtime, asset))));
            }
        }
        const accent = { borderLeftColor: stage.color };
        return h("div", { key: "st" + stage.code, className: "rt-ap-stage" }, h("div", { className: "rt-ap-head", style: (0, chain_model_js_1.stageHeadStyle)(stage.color) }, h("span", { className: "rt-ap-no", style: (0, chain_model_js_1.stageNumberStyle)(stage.color) }, (0, chain_model_js_1.stageNumber)(index)), h("span", { className: "rt-ap-name" }, stage.name), stage.subtitle !== "" ? h("span", { className: "rt-ap-en" }, stage.subtitle) : null, h("div", { className: "rt-spacer" }), stage.points > 0
            ? h("span", { className: "rt-ap-pts", style: (0, chain_model_js_1.stagePointsStyle)(stage.color) }, "+" + stage.points)
            : null, h("span", { className: "rt-ap-cum" }, (0, chain_model_js_1.cumulativeLabel)(stage))), h("div", { className: "rt-ap-goal", style: accent }, h("span", {
            className: "rt-ap-goal-tag",
            style: { color: stage.color, borderColor: stage.color + "66" },
        }, "阶段目标"), h("span", null, stage.goal)), h("div", { className: "rt-ap-result", style: accent }, body), index < total - 1
            ? h("div", { className: "rt-ap-trans" }, h("span", { className: "rt-flow-arrow" }, "▼"), stage.transition !== "" ? h("span", { className: "rt-ap-trans-t" }, stage.transition) : null, h("span", { className: "rt-ap-trans-t", style: { marginLeft: "auto" } }, (0, chain_model_js_1.cumulativeLabel)(stage)))
            : h("div", { className: "rt-ap-trans" }, h("span", { className: "rt-flow-arrow" }, "▼"), h("span", { className: "rt-ap-trans-t" }, (0, chain_model_js_1.totalLabel)(props.data?.summary ?? null))));
    }
    /** 横向视图的正文。 */
    function stageHorizontalBody(runtime, stage) {
        const { h } = runtime;
        if ((0, chain_model_js_1.isBoundaryStage)(stage)) {
            return h("div", null, h("div", { className: "rt-hcol-hit" }, h("span", { className: "rt-hcol-pts" }, "+" + stage.points), h("span", { className: "rt-hcol-name" }, (0, chain_model_js_1.compactTunnelHit)(stage))), stage.tunnels.slice(0, chain_model_js_1.COMPACT_TUNNEL_LIMIT).map((tunnel) => h("div", { key: "t" + tunnel.id, className: "rt-hcol-sub" }, "▸ " + tunnel.kind + " " + tunnel.listen)));
        }
        if ((0, chain_model_js_1.isReconStage)(stage)) {
            return h("div", null, h("div", { className: "rt-hcol-hit" }, h("span", { className: "rt-hcol-pts" }, String(stage.assetCount)), h("span", { className: "rt-hcol-name" }, (0, chain_model_js_1.compactReconHit)(stage))), stage.assets.slice(0, chain_model_js_1.COMPACT_LIMIT).map((asset) => h("div", {
                key: "a" + asset.id,
                className: "rt-hcol-sub",
                title: asset.ip + "  +" + asset.points + " 分",
            }, (0, chain_model_js_1.compactAssetScope)(asset) + asset.ip + "  +" + asset.points)));
        }
        const more = (0, chain_model_js_1.moreHitsLabel)(stage.items.length);
        const assetCount = (0, chain_model_js_1.compactAssetCountLabel)(stage);
        return h("div", null, h("div", { className: "rt-hcol-hit" }, h("span", { className: "rt-hcol-pts" }, "+" + stage.points), h("span", { className: "rt-hcol-name" }, (0, chain_model_js_1.compactHitsLabel)(stage))), stage.items.slice(0, chain_model_js_1.COMPACT_LIMIT).map((hit) => h("div", {
            key: "c" + hit.id,
            className: "rt-hcol-sub",
            title: hit.pointName + "  " + hit.target,
        }, h("span", { className: "rt-hcol-pts" }, "+" + hit.points), h("span", { className: "rt-hcol-name" }, hit.pointName))), more !== null ? h("div", { className: "rt-hcol-none" }, more) : null, assetCount !== null ? h("div", { className: "rt-hcol-none" }, assetCount) : null);
    }
    /** 横向视图的一个阶段。 */
    function stageCompact(runtime, stage, index) {
        const { h } = runtime;
        return h("div", { key: "c" + stage.code, className: "rt-ap-col" }, index > 0 ? h("span", { className: "rt-ap-col-arrow" }, "▶") : null, h("div", { className: "rt-hcol", style: { borderTopColor: stage.color } }, h("div", {
            className: "rt-ap-head",
            style: { borderLeftColor: stage.color, padding: "5px 8px" },
        }, h("span", { className: "rt-ap-no", style: (0, chain_model_js_1.stageNumberCompactStyle)(stage.color) }, (0, chain_model_js_1.stageNumberCompact)(index)), h("span", { className: "rt-ap-name", style: { fontSize: 12 } }, stage.name), h("div", { className: "rt-spacer" }), h("span", { className: "rt-ap-cum", style: { fontWeight: 700 } }, String(stage.cumulative))), h("div", { className: "rt-hcol-goal", title: stage.goal }, stage.goal), h("div", { className: "rt-hcol-body" }, stageHorizontalBody(runtime, stage))));
    }
    /**
     * 渲染攻击链页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderChainTab(runtime, props) {
        const { h } = runtime;
        const data = props.data;
        const stages = data?.stages ?? [];
        const summary = data?.summary ?? null;
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "攻击链"), h("span", { className: "rt-tag", style: { fontSize: 10.5 } }, chain_model_js_1.CHAIN_FLOW_LABEL), summary !== null ? h("span", { className: "rt-tag rt-tag-live" }, "总分 " + summary.points + " 分") : null, h("div", { className: "rt-spacer" }), h("button", {
            className: (0, chain_model_js_1.viewButtonClass)("A", props.view),
            title: (0, chain_model_js_1.viewButtonTitle)("A"),
            onClick: () => props.onViewChange("A"),
        }, (0, chain_model_js_1.viewButtonLabel)("A")), h("button", {
            className: (0, chain_model_js_1.viewButtonClass)("B", props.view),
            title: (0, chain_model_js_1.viewButtonTitle)("B"),
            onClick: () => props.onViewChange("B"),
        }, (0, chain_model_js_1.viewButtonLabel)("B")), h("button", {
            className: "rt-btn",
            disabled: props.loading,
            onClick: () => props.onRefresh(),
        }, props.loading ? "加载中…" : "刷新"));
        const errorNode = props.error !== null
            ? h("div", { className: "rt-err" }, props.error)
            : null;
        // 三种状态分开：还没读回来（data === null）/ 读到了但没有阶段 / 有阶段。
        // 合并会让首次加载闪一下「还没有得分记录」。
        const emptyNode = data !== null && stages.length === 0 && props.error === null
            ? h("div", { className: "rt-empty" }, chain_model_js_1.EMPTY_CHAIN_MESSAGE)
            : null;
        const view = props.view === "A"
            ? h("div", { className: (0, chain_model_js_1.viewRootClass)("A") }, stages.map((stage, index) => stageVertical(runtime, props, stage, index, stages.length)))
            : h("div", { className: (0, chain_model_js_1.viewRootClass)("B") }, stages.map((stage, index) => stageCompact(runtime, stage, index)));
        return h("div", { className: "rt-main" }, toolbar, errorNode, emptyNode, stages.length > 0 ? view : null);
    }
    /** 读取攻击链。 */
    async function loadChain(api, engagement) {
        return api.raw({ op: "scoreChain", engagement });
    }
    /** 从响应解析攻击链（失败 → `null`，错误由容器单独保存）。 */
    function chainOf(response) {
        return (0, chain_model_js_1.chainDataOf)(response);
    }
    /** 错误文案。 */
    function chainErrorOf(response) {
        if (response.ok === false)
            return response.error ?? "读取失败";
        return null;
    }
    /** 切换视图（无效值归一成 A）。 */
    function nextView(value) {
        return value === "B" ? "B" : "A";
    }
    /** 切换展开的命中（同一条再点收起）。 */
    function toggleHitOpen(current, id) {
        return current === id ? null : id;
    }
});
/**
 * 面板拖拽 / 缩放：纯几何计算。
 *
 * ## 为什么单独一层
 *
 * 原实现把六种拖拽（拖动、左/右/下/角缩放）写在组件的闭包里，
 * 每个都直接调 `setGeom` 与 `window.addEventListener`。后果是：
 * - 无法测试（要真 window + 真鼠标事件）；
 * - 六段逻辑高度重复（都是「记起点 → 算 delta → clamp」），
 *   但每段的基准量不同（`ox+dx` vs `ow-dx` vs `ow+dx`），改一处容易漏别的。
 *
 * 这里把「起点状态 + 鼠标位移 → 新几何」抽成纯函数，六种操作变成一张表。
 * 组件只剩「监听 mousemove → 调用对应函数」。
 *
 * ## 一个必须保留的细节：左缩放的符号
 *
 * 左侧缩放时，`x` 增加量与 `w` 减少量**必须对称**（`x + dx` 与 `w - dx`），
 * 否则拖动左边缘会同时改变面板右边界 —— 视觉上像「整个面板在滑动」。
 * 原实现的 `startResizeLeft` 是对的，这里逐字保留。
 *
 * ## 另一个：clamp 的先后
 *
 * 每次都走 `clampDockGeometry`，它内部「先钳尺寸再钳位置」。
 * 若顺序反了，拖出屏幕时面板会先被钳位置、再被钳尺寸，边界会跳动。
 */
define("redteam/client/drag", ["require", "exports", "redteam/client/state"], function (require, exports, state_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.INTERACTIVE_SELECTOR = void 0;
    exports.dragOriginOf = dragOriginOf;
    exports.applyDrag = applyDrag;
    exports.shouldIgnoreDrag = shouldIgnoreDrag;
    exports.isPrimaryButton = isPrimaryButton;
    exports.beginDrag = beginDrag;
    /** 从（鼠标位置, 几何）造起点。 */
    function dragOriginOf(clientX, clientY, geometry) {
        return { clientX, clientY, geometry };
    }
    /**
     * 按位移算新几何。
     *
     * 六种操作在同一张表里，避免六段近似代码各自漂移。
     */
    function applyDrag(kind, origin, clientX, clientY, viewport = state_js_3.DEFAULT_VIEWPORT) {
        const dx = clientX - origin.clientX;
        const dy = clientY - origin.clientY;
        const { x, y, w, h } = origin.geometry;
        let next;
        switch (kind) {
            case "move":
                next = { x: x + dx, y: y + dy, w, h };
                break;
            case "resize-left":
                // 左边缘：x 与 w 反向变化，保证右边界不动。
                next = { x: x + dx, y, w: w - dx, h };
                break;
            case "resize-right":
                next = { x, y, w: w + dx, h };
                break;
            case "resize-bottom":
                next = { x, y, w, h: h + dy };
                break;
            case "resize-corner":
                next = { x, y, w: w + dx, h: h + dy };
                break;
        }
        return (0, state_js_3.clampDockGeometry)(next, viewport);
    }
    /**
     * 该不该开始拖动面板？
     *
     * 原实现：`if (e.target.closest('button,a,input,select,textarea,label')) return`
     * —— 面板头部里放了「刷新 / 全面浏览 / 收起」等按钮，点头部空白处才拖动。
     *
     * 这里把「是否交互元素」抽成可测判断。缺失 `closest` 时按「不是交互元素」处理
     * （原实现同样直接放过，因为 `e.target.closest &&` 的短路）。
     */
    exports.INTERACTIVE_SELECTOR = "button,a,input,select,textarea,label";
    /** 判断拖拽是否应被忽略（点到交互元素）。 */
    function shouldIgnoreDrag(target) {
        if (target === null || target === undefined)
            return false;
        if (typeof target.closest !== "function")
            return false;
        try {
            return target.closest(exports.INTERACTIVE_SELECTOR) !== null
                && target.closest(exports.INTERACTIVE_SELECTOR) !== undefined;
        }
        catch {
            // `closest` 在非 Element 节点上可能抛（Text 节点等）。
            return false;
        }
    }
    /**
     * 是否只响应主键（左键）。
     *
     * 原实现：`if (e.button !== 0) return`。右键 / 中键不该触发拖拽
     * （右键要出上下文菜单，中键是滚动）。
     */
    function isPrimaryButton(button) {
        return button === 0;
    }
    /**
     * 开始一次拖拽。
     *
     * 返回会话对象，`end()` 时解绑 —— 调用点不必自己记两个监听器的引用
     * （原实现里 `up` 闭包捕获 `move`，六个入口各写一遍，容易漏解绑）。
     */
    function beginDrag(host, kind, origin, onUpdate, viewport = state_js_3.DEFAULT_VIEWPORT) {
        let ended = false;
        const move = (event) => {
            if (ended)
                return;
            const clientX = typeof event.clientX === "number" ? event.clientX : origin.clientX;
            const clientY = typeof event.clientY === "number" ? event.clientY : origin.clientY;
            onUpdate(applyDrag(kind, origin, clientX, clientY, viewport));
        };
        const end = () => {
            if (ended)
                return;
            ended = true;
            host.removeEventListener("mousemove", move);
            host.removeEventListener("mouseup", end);
        };
        host.addEventListener("mousemove", move);
        host.addEventListener("mouseup", end);
        return { end };
    }
});
/**
 * 入口按钮：侧栏、会话头部、全面浏览。
 *
 * ## 这一组为什么先做
 *
 * 它们是**控制台的唯一入口**，且不依赖任何业务数据 —— 只依赖
 * 已完成的三块：`runtime`（window + ui store）、`helpers`（`fullWindowUrl`）、
 * `state`（`open` 开关）。用来验证「组件 + runtime 注入」这套骨架是否成立，
 * 比一上来就啃 `AssetsTab`（依赖 8 个 API 调用）成本低得多。
 *
 * ## 与原实现的差异（有意为之）
 *
 * 原实现的三个按钮直接闭包引用模块级 `setUI` / `window`：
 * ```js
 * onClick: () => setUI({ open: !st.open })
 * ```
 * 这里改成通过 `runtime` 拿 —— 于是同一个组件可以在测试里跑，
 * 也可以在同一页面的两个控制台实例里各自持有独立状态。
 *
 * **行为逐条对齐原实现**（className、title、显示器、`wide` 分支）。
 */
define("redteam/client/entry", ["require", "exports", "redteam/client/helpers"], function (require, exports, helpers_js_4) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SidebarButton = SidebarButton;
    exports.HeaderButton = HeaderButton;
    exports.FullButton = FullButton;
    exports.isFullWindow = isFullWindow;
    exports.exitFullWindow = exitFullWindow;
    /**
     * 侧栏「RedTeam」开关按钮。
     *
     * 原实现：
     * ```js
     * h('button', {
     *   className: 'rt-icon-btn' + (st.open ? ' on' : ''),
     *   title: 'RedTeam 控制台（常驻右侧栏）',
     *   onClick: () => setUI({ open: !st.open }),
     * }, h('span', { style: { fontSize: 14 } }, '⛨'), props.wide ? h('span', null, 'RedTeam') : null)
     * ```
     *
     * 注意 `props.wide ? ... : null` 的写法是对的（三元而非 `&&`）：
     * 若写成 `props.wide && h(...)`，`wide === false` 时不会渲染任何东西，
     * 但 `wide` 若是 `0` 之类会渲染出 `0` —— 三元避开了这个坑。
     */
    function SidebarButton(runtime, props) {
        const state = runtime.ui.useUi();
        return runtime.h("button", {
            className: "rt-icon-btn" + (state.open ? " on" : ""),
            title: "RedTeam 控制台（常驻右侧栏）",
            // 点击时**读当前值**而不是捕获渲染时的 `state`：
            // React 里每次渲染都会给出新闭包，所以两种写法在真 React 下等价；
            // 但读当前值对「重渲染前连点」「元素被缓存复用」都成立，没有代价。
            onClick: () => runtime.ui.set({ open: !runtime.ui.get().open }),
        }, runtime.h("span", { style: { fontSize: 14 } }, "⛨"), props.wide === true ? runtime.h("span", null, "RedTeam") : null);
    }
    /**
     * 会话头部的「RedTeam」开关按钮。
     *
     * 与侧栏按钮共用同一份状态（`open`），但样式类不同（`rt-hbtn`），
     * 且始终显示文字（原实现如此）。
     */
    function HeaderButton(runtime) {
        const state = runtime.ui.useUi();
        return runtime.h("button", {
            className: "rt-hbtn" + (state.open ? " on" : ""),
            title: "RedTeam 控制台（常驻右侧栏）",
            onClick: () => runtime.ui.set({ open: !runtime.ui.get().open }),
        }, "⛨ RedTeam");
    }
    /**
     * 侧栏「全面浏览」：在新浏览器窗口打开完整控制台。
     *
     * 原实现把 `window.open` 包在 `try/catch` 里 —— 弹出窗口被浏览器拦截时
     * `window.open` 返回 `null`（不抛），但某些环境下会抛。
     * 两种都不该让点击看起来「没反应」：这里保留 catch，且**不改变**任何状态。
     */
    function FullButton(runtime, props) {
        const open = () => {
            try {
                const href = runtime.window.location.href;
                runtime.window.open((0, helpers_js_4.fullWindowUrl)(href), "_blank", "noopener");
            }
            catch {
                /* 被浏览器拦截：静默（原实现同样静默） */
            }
        };
        return runtime.h("button", {
            className: "rt-icon-btn",
            title: "全面浏览：在新窗口打开完整控制台（当前窗口不受影响；新窗口内按 Esc 退出）",
            onClick: open,
        }, runtime.h("span", { style: { fontSize: 14 } }, "⛶"), props.wide === true ? runtime.h("span", null, "全面浏览") : null);
    }
    /**
     * 判断当前是否在「全面浏览」独立窗口里。
     *
     * 原实现读 `window.location.hash`，并整体包 `try/catch`
     * （某些沙箱里读 `location` 会抛）。这里同样包住。
     */
    function isFullWindow(runtime) {
        try {
            const hash = String(runtime.window.location.hash || "");
            return hash === "#redteam-full";
        }
        catch {
            return false;
        }
    }
    /** 退出全面浏览：优先 `window.close()`，关不掉则清 hash 并重载。 */
    function exitFullWindow(runtime) {
        try {
            runtime.window.close();
        }
        catch {
            /* 非脚本打开的窗口无法 close */
        }
        try {
            if (runtime.window.location.hash) {
                runtime.window.location.hash = "";
                runtime.window.location.reload();
            }
        }
        catch {
            /* ignore */
        }
    }
});
/**
 * `POST /redteam/api` 的线上协议。
 *
 * ## 为什么单独一层
 *
 * 原 `lib/redteam/ui.js` 的桥接把「HTTP 状态码」「JSON 外形」「错误来源」
 * 三者混在一个 `catch` 里：未知 op 走 `throw new Error('unknown op: x')`，
 * 被最外层 catch 成 **400 + `{ok:false,error}`**，浏览器侧只能靠字符串前缀
 * 猜发生了什么。此处把错误**分类**成稳定的 `code`，状态码由分类派生，
 * 这样：未知 op 永远不会变成 500，客户端也不必解析人类可读文案。
 *
 * ## 兼容性
 *
 * 成功响应保持**扁平**（`{ ok: true, ...业务字段 }`）——原调用点有 44 处
 * 直接读 `r.items` / `r.stats`，包一层 `data` 会让整个浏览器半侧失效。
 * 错误响应只**增加**字段（`code` / `op` / `details`），不删除原有 `error`。
 */
define("redteam/ui/protocol", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.statusOf = statusOf;
    exports.apiError = apiError;
    exports.apiOk = apiOk;
    /** 失败状态码只由分类派生，不手写。 */
    function statusOf(code) {
        switch (code) {
            case "method_not_allowed":
                return 405;
            case "cross_origin":
                return 403;
            case "body_too_large":
                return 413;
            case "unknown_op":
            case "missing_op":
            case "invalid_payload":
            case "invalid_json":
            case "handler_failed":
            case "store_failed":
            case "no_store":
                return 400;
        }
    }
    /** 错误响应的可序列化内容（`details` 为空时不写，避免噪声）。 */
    function apiError(code, message, extras = {}) {
        // `noPropertyAccessFromIndexSignature` 生效：动态键必须走下标访问。
        const body = { ok: false, error: message, code };
        if (extras.op !== undefined)
            body["op"] = extras.op;
        if (extras.details !== undefined && extras.details.length > 0)
            body["details"] = extras.details;
        return body;
    }
    /**
     * 成功响应的**扁平**投影。
     *
     * 若处理器返回的不是对象（数组 / 字符串 / null），按原实现语义包成 `{ ok: true, value }`：
     * 否则 `Object.assign({ok:true}, data)` 会把数组拍成 `{0:..,1:..}`。
     */
    function apiOk(value) {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            const record = value;
            // 处理器自己带 `ok` 时以它为准：`{ok:false}` 也是合法的业务失败（HTTP 仍 200）。
            if (typeof record["ok"] === "boolean")
                return record;
            return { ok: true, ...record };
        }
        return { ok: true, value };
    }
});
/**
 * 环境适配页的表单模型（纯逻辑）。
 *
 * ## 为什么抽出来
 *
 * 原 `EnvTab` 有 150 行渲染里夹着这些逻辑：
 * ```js
 * applyDraftFrom(r)          // 服务端响应 → 表单草稿
 * config = { ...draft, binDirs: draft.binDirsText.split(/\r?\n/)... }   // 表单 → 请求
 * setTool(id, value)         // 改一个工具路径
 * setEnv(key, value)         // 改一个环境变量
 * ```
 * 全都是纯数据变换，但埋在 JSX 里只能整页渲染才能测。抽出来后：
 * - 「表单 → 请求」的字段映射可逐条断言（漏一个字段就是保存时丢配置）
 * - 「响应 → 表单」的兜底可穷举（缺字段、null、类型不对）
 *
 * ## 一个容易丢的细节
 *
 * 保存时**强制** `envAdaptConfigured: true` 与 `envAdaptSkip: false`。
 * 原实现如此，理由在 `platform-config.js` 的注释里：用户点「保存」
 * 就是明确表示「我配好了」，此时必须清掉「暂不跳过」的标记，
 * 否则发送门禁永远认为环境未就绪。
 */
define("redteam/client/env-model", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ASSIGN_EMPTY_DIR_MESSAGE = exports.DEFAULT_TOOLKIT_DIR = exports.PLATFORM_OPTIONS = exports.KNOWN_ENV_KEYS = void 0;
    exports.draftFromResponse = draftFromResponse;
    exports.payloadFromDraft = payloadFromDraft;
    exports.splitLines = splitLines;
    exports.withTool = withTool;
    exports.withEnv = withEnv;
    exports.withField = withField;
    exports.toolsOf = toolsOf;
    exports.foundToolCount = foundToolCount;
    exports.summaryOf = summaryOf;
    exports.egressOf = egressOf;
    exports.displayProxy = displayProxy;
    exports.defaultNucleiDir = defaultNucleiDir;
    exports.savedMessage = savedMessage;
    exports.assignedMessage = assignedMessage;
    exports.errorOf = errorOf;
    exports.failed = failed;
    exports.assignDirOf = assignDirOf;
    exports.saveOutcomeOf = saveOutcomeOf;
    exports.assignOutcomeOf = assignOutcomeOf;
    /**
     * 环境变量的已知键。
     *
     * 顺序即界面顺序。这三个是原实现显式预置的（`Object.assign({FOFA_KEY:'',...}, c.env)`），
     * 所以即使用户没填过，输入框也会出现 —— 换成 `Object.keys(c.env)`
     * 会让从未保存过的用户看不到输入框。
     */
    exports.KNOWN_ENV_KEYS = Object.freeze([
        "FOFA_KEY",
        "REDTEAM_VPS_HOST",
        "REDTEAM_VPS_KEY",
    ]);
    /** 平台选项。 */
    exports.PLATFORM_OPTIONS = Object.freeze([
        { value: "auto", label: "自动识别" },
        { value: "windows", label: "Windows" },
        { value: "linux", label: "Linux / Kali" },
    ]);
    /** 从不可信值里读字符串（缺失/非字符串 → 空串）。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值里读对象（缺失/数组 → 空对象）。 */
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 归一平台取值。 */
    function platformOf(value) {
        return value === "windows" || value === "linux" ? value : "auto";
    }
    /** 把字符串表里的非字符串值丢掉（配置可能被手改坏）。 */
    function stringMapOf(value) {
        const raw = recordOf(value);
        const out = {};
        for (const [key, item] of Object.entries(raw)) {
            if (typeof item === "string")
                out[key] = item;
        }
        return out;
    }
    /**
     * 服务端响应 → 表单草稿。
     *
     * 对应原实现的 `applyDraftFrom`。所有字段都做兜底：
     * 服务端可能给出残缺配置（首次运行、旧版本配置、手改坏的文件）。
     */
    function draftFromResponse(response) {
        const config = recordOf(recordOf(response)["config"]);
        const binDirs = Array.isArray(config["binDirs"])
            ? config["binDirs"].filter((item) => typeof item === "string")
            : [];
        const env = stringMapOf(config["env"]);
        // 已知键先占位（保证输入框存在），再用配置里的值覆盖。
        const merged = {};
        for (const key of exports.KNOWN_ENV_KEYS)
            merged[key] = "";
        for (const [key, value] of Object.entries(env))
            merged[key] = value;
        return {
            platform: platformOf(config["platform"]),
            toolkitDir: text(config["toolkitDir"]),
            nucleiTemplatesDir: text(config["nucleiTemplatesDir"]),
            binDirsText: binDirs.join("\n"),
            tools: stringMapOf(config["tools"]),
            env: merged,
            notes: text(config["notes"]),
        };
    }
    /**
     * 表单草稿 → 请求载荷。
     *
     * 对应原实现 `save()` 里拼 `config` 的那一段。**逐字段对齐**：
     * 漏一个字段的后果是「保存后该配置消失」，而且界面上看不出来。
     */
    function payloadFromDraft(draft) {
        return {
            platform: draft.platform,
            toolkitDir: draft.toolkitDir,
            nucleiTemplatesDir: draft.nucleiTemplatesDir,
            binDirs: splitLines(draft.binDirsText),
            tools: draft.tools,
            env: draft.env,
            notes: draft.notes,
            // 用户点保存 = 明确表示配好了：必须清掉「跳过」标记，
            // 否则发送门禁永远认为环境未就绪（原实现同样强制）。
            envAdaptConfigured: true,
            envAdaptSkip: false,
        };
    }
    /**
     * 多行文本 → 目录数组。
     *
     * `split(/\r?\n/)` + trim + 去空。**必须处理 CRLF**：
     * Windows 用户粘贴的路径带 `\r`，不 trim 会得到带尾随 `\r` 的路径，
     * 后续 `existsSync` 全部失败（而界面上看起来路径是对的）。
     */
    function splitLines(value) {
        return String(value ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== "");
    }
    /** 改一个工具路径（返回新草稿）。 */
    function withTool(draft, id, value) {
        return { ...draft, tools: { ...draft.tools, [id]: value } };
    }
    /** 改一个环境变量（返回新草稿）。 */
    function withEnv(draft, key, value) {
        return { ...draft, env: { ...draft.env, [key]: value } };
    }
    /** 改一个顶层字段（返回新草稿）。 */
    function withField(draft, key, value) {
        return { ...draft, [key]: value };
    }
    /** 从响应里读工具清单。 */
    function toolsOf(response) {
        const tools = recordOf(recordOf(response)["tools"]);
        const items = tools["items"];
        if (!Array.isArray(items))
            return [];
        return items.map((item) => {
            const entry = recordOf(item);
            return {
                id: text(entry["id"]),
                label: text(entry["label"]) || text(entry["id"]),
                path: typeof entry["path"] === "string" ? entry["path"] : null,
                source: text(entry["source"]) || "missing",
            };
        }).filter((item) => item.id !== "");
    }
    /** 已找到工具数。 */
    function foundToolCount(tools) {
        return tools.filter((tool) => tool.path !== null).length;
    }
    /** 从响应算摘要。 */
    function summaryOf(response) {
        const body = recordOf(response);
        const runtime = recordOf(body["runtime"]);
        const adapt = recordOf(body["adapt"]);
        const tools = toolsOf(response);
        const found = foundToolCount(tools);
        const effective = text(runtime["effective"]);
        const ready = adapt["ready"] === true;
        const reason = text(adapt["reason"]);
        return {
            platformLabel: effective === "windows" ? "Windows" : "Linux/Kali",
            kali: adapt["kali"] === true,
            ready,
            reason,
            // 就绪时把 reason 拼进去（原实现：`'就绪 · ' + reason`）。
            readyLabel: ready ? "就绪 · " + reason : "待配置",
            toolLabel: "工具 " + found + "/" + tools.length,
            toolCount: found,
            totalTools: tools.length,
            message: text(adapt["message"]),
            hint: text(body["hint"]),
        };
    }
    /** 从响应读出网状态。 */
    function egressOf(response) {
        const egress = recordOf(recordOf(response)["egress"]);
        return {
            httpProxy: text(egress["http_proxy"]),
            httpsProxy: text(egress["https_proxy"]),
            allProxy: text(egress["all_proxy"]),
            noProxy: text(egress["no_proxy"]),
            note: text(egress["note"]),
        };
    }
    /** 出网代理的显示值（空 → `(空)`，与原实现一致）。 */
    function displayProxy(value) {
        return value === "" ? "(空)" : value;
    }
    /**
     * 默认工具目录（未配置时的提示值）。
     *
     * 原实现：`data.toolkitDir || '$DSH_HOME/redteam/toolkit'`。
     */
    exports.DEFAULT_TOOLKIT_DIR = "$DSH_HOME/redteam/toolkit";
    /** 默认 nuclei 模板目录。 */
    function defaultNucleiDir(response) {
        const toolkit = text(recordOf(response)["toolkitDir"]) || exports.DEFAULT_TOOLKIT_DIR;
        return text(recordOf(response)["nucleiTemplatesDir"]) || toolkit + "/nuclei-templates";
    }
    /** 保存成功的提示文案。 */
    function savedMessage(response) {
        const path = text(recordOf(recordOf(response)["config"])["path"]);
        return "已保存到 " + (path === "" ? "$DSH_HOME/redteam/config.json" : path);
    }
    /** 自动分配成功的提示文案。 */
    function assignedMessage(response) {
        const body = recordOf(response);
        const count = Number(body["assignedCount"]);
        const safeCount = Number.isFinite(count) ? count : 0;
        const nuclei = typeof body["nucleiTemplatesDir"] === "string" && body["nucleiTemplatesDir"] !== "";
        return "已从文件夹分配 " + safeCount + " 个工具"
            + (nuclei ? "，并识别 nuclei-templates" : "");
    }
    /** 从任意失败响应造错误消息。 */
    function errorOf(response, fallback) {
        const body = recordOf(response);
        const error = body["error"];
        return { kind: "err", text: typeof error === "string" && error !== "" ? error : fallback };
    }
    /** 判断响应是否失败。 */
    function failed(response) {
        if (response === null || response === undefined)
            return true;
        return recordOf(response)["ok"] === false;
    }
    /** 自动分配时的目录校验：空路径直接拦下（不发请求）。 */
    function assignDirOf(folderPath, draft) {
        const raw = typeof folderPath === "string" ? folderPath.trim() : "";
        if (raw !== "")
            return raw;
        return draft === null ? "" : draft.toolkitDir.trim();
    }
    /** 自动分配的错误提示（原实现文案）。 */
    exports.ASSIGN_EMPTY_DIR_MESSAGE = "请先填写工具所在文件夹路径";
    /** 从保存响应算结果。 */
    function saveOutcomeOf(response) {
        if (failed(response)) {
            return { message: errorOf(response, "保存失败"), response: null };
        }
        return {
            message: { kind: "ok", text: savedMessage(response) },
            response: response,
        };
    }
    /** 从自动分配响应算结果。 */
    function assignOutcomeOf(response) {
        if (failed(response)) {
            return { message: errorOf(response, "自动分配失败"), response: null };
        }
        return {
            message: { kind: "ok", text: assignedMessage(response) },
            response: response,
        };
    }
});
/**
 * 环境适配页（`env` 页签）的渲染。
 *
 * 数据与计算全在 `env-model.ts`（77 用例），这里只做排版。
 * 这样分工的好处：表单字段映射的正确性由纯函数测试保证，
 * 渲染层只需保证「该显示的都显示了」。
 *
 * ## 一个原实现的取舍，这里保留
 *
 * 原 `EnvTab` 的「自动分配」按钮**不发请求就直接报错**（目录为空时）：
 * ```js
 * if (!dir) { setMsg({ err: '请先填写工具所在文件夹路径' }); return }
 * ```
 * 这比「发一个注定失败的空路径请求」好：用户立刻得到提示，
 * 服务端不必处理无意义请求。`assignDirOf` 保留了这个前置校验。
 */
define("redteam/client/env-tab", ["require", "exports", "redteam/client/env-model"], function (require, exports, env_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderEnvTab = renderEnvTab;
    exports.loadEnv = loadEnv;
    exports.saveEnv = saveEnv;
    exports.assignEnv = assignEnv;
    exports.refreshDraftFrom = refreshDraftFrom;
    exports.envKeysOf = envKeysOf;
    /** 平台标签。 */
    function platformTag(runtime, label, className) {
        return runtime.h("span", { className }, label);
    }
    /** 工具行。 */
    function toolRow(runtime, props, tool) {
        const found = tool.path !== null;
        return runtime.h("div", { key: tool.id, className: "rt-kv" }, runtime.h("span", { className: "rt-mono" }, tool.id), runtime.h("span", { className: found ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn" }, found ? tool.source : "未找到"), runtime.h("input", {
            className: "rt-input",
            style: { flex: 1 },
            placeholder: found ? (tool.path ?? "") : "留空则自动查找",
            // 未加载草稿时禁用：否则用户输入会被随后的 load 覆盖。
            disabled: props.draft === null,
            value: props.draft?.tools[tool.id] ?? "",
            onChange: (event) => {
                if (props.draft === null)
                    return;
                const value = String(event.target?.value ?? "");
                props.onDraftChange({ ...props.draft, tools: { ...props.draft.tools, [tool.id]: value } });
            },
        }));
    }
    /**
     * 渲染环境适配页。
     *
     * 无 hook、不读全局，只按 props 拼元素树 —— 因此可以直接测。
     */
    function renderEnvTab(runtime, props) {
        const { h } = runtime;
        const summary = (0, env_model_js_1.summaryOf)(props.data);
        const tools = (0, env_model_js_1.toolsOf)(props.data);
        const egress = (0, env_model_js_1.egressOf)(props.data);
        const draft = props.draft;
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "环境适配"), platformTag(runtime, summary.platformLabel, "rt-tag"), summary.kali ? platformTag(runtime, "Kali", "rt-tag rt-tag-live") : null, platformTag(runtime, summary.readyLabel, summary.ready ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn"), platformTag(runtime, summary.toolLabel, summary.toolCount > 0 ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn"), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            disabled: props.busy,
            onClick: () => props.onRefresh(),
        }, props.busy ? "读取中…" : "刷新"), h("button", {
            className: "rt-btn rt-btn-primary",
            // 没加载出草稿时不能保存（否则会写入一份空配置覆盖原有配置）。
            disabled: props.busy || draft === null,
            onClick: () => props.onSave(),
        }, "保存"));
        const messages = [];
        if (props.error !== null) {
            messages.push(h("div", { key: "err", className: "rt-err" }, props.error));
        }
        if (props.message !== null) {
            messages.push(h("div", {
                key: "msg",
                className: props.message.kind === "err" ? "rt-err" : "rt-foot",
            }, props.message.text));
        }
        const noticeCard = h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.6 } }, summary.message !== ""
            ? summary.message
            : "均可选填：留空则用默认路径/自动查找。填了的覆盖默认。密钥类只在需要测绘/反弹时才填。");
        const assignCard = h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.6 } }, h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "整包文件夹 → 自动分配工具"), h("div", { style: { marginBottom: 8, opacity: 0.9 } }, "工具都在同一个文件夹（含子目录）时，填路径后点「自动分配」："
            + "会写入 toolkitDir，并按文件名匹配 nmap / nuclei / fscan 等填到下方。"), h("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("input", {
            className: "rt-input",
            style: { flex: 1 },
            placeholder: "例如 D:\\pentest-tools 或 /opt/toolkit",
            value: props.folderPath,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onFolderPathChange(value);
            },
            onKeyDown: (event) => {
                if (event.key === "Enter")
                    props.onAssign();
            },
        }), h("button", {
            className: "rt-btn rt-btn-primary",
            disabled: props.busy,
            onClick: () => props.onAssign(),
        }, props.busy ? "扫描中…" : "自动分配")), 
        // 目录为空时**提前提示**，而不是等用户点了才报错。
        (0, env_model_js_1.assignDirOf)(props.folderPath, draft) === ""
            ? h("div", { style: { marginTop: 6, color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, env_model_js_1.ASSIGN_EMPTY_DIR_MESSAGE)
            : null);
        const hintCard = summary.hint !== ""
            ? h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.6 } }, summary.hint)
            : null;
        const egressCard = h("div", { className: "rt-card", style: { margin: "0 0 8px", fontSize: 12, lineHeight: 1.55 } }, h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "出网状态（借鉴 Z3r0 egress，只读）"), h("div", { className: "rt-mono", style: { fontSize: 11 } }, "HTTP_PROXY=" + (0, env_model_js_1.displayProxy)(egress.httpProxy)), h("div", { className: "rt-mono", style: { fontSize: 11 } }, "HTTPS_PROXY=" + (0, env_model_js_1.displayProxy)(egress.httpsProxy)), h("div", { className: "rt-mono", style: { fontSize: 11 } }, "ALL_PROXY=" + (0, env_model_js_1.displayProxy)(egress.allProxy)), h("div", { className: "rt-mono", style: { fontSize: 11 } }, "NO_PROXY=" + (0, env_model_js_1.displayProxy)(egress.noProxy)), egress.note !== "" ? h("div", { style: { marginTop: 6, opacity: 0.85 } }, egress.note) : null);
        const platformField = h("div", { className: "rt-kv" }, h("span", null, "平台"), h("select", {
            className: "rt-input",
            value: draft?.platform ?? "auto",
            disabled: draft === null,
            onChange: (event) => {
                if (draft === null)
                    return;
                const raw = String(event.target?.value ?? "auto");
                const platform = raw === "windows" || raw === "linux" ? raw : "auto";
                props.onDraftChange({ ...draft, platform });
            },
        }, env_model_js_1.PLATFORM_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))));
        const dirFields = h("div", null, h("div", { className: "rt-kv" }, h("span", null, "工具目录"), h("input", {
            className: "rt-input",
            style: { flex: 1 },
            placeholder: DEFAULT_TOOLKIT_PLACEHOLDER,
            disabled: draft === null,
            value: draft?.toolkitDir ?? "",
            onChange: (event) => {
                if (draft === null)
                    return;
                const value = String(event.target?.value ?? "");
                props.onDraftChange({ ...draft, toolkitDir: value });
            },
        })), h("div", { className: "rt-kv" }, h("span", null, "nuclei 模板"), h("input", {
            className: "rt-input",
            style: { flex: 1 },
            placeholder: (0, env_model_js_1.defaultNucleiDir)(props.data),
            disabled: draft === null,
            value: draft?.nucleiTemplatesDir ?? "",
            onChange: (event) => {
                if (draft === null)
                    return;
                const value = String(event.target?.value ?? "");
                props.onDraftChange({ ...props.draft, nucleiTemplatesDir: value });
            },
        })), h("div", { className: "rt-kv" }, h("span", null, "额外 bin 目录"), h("textarea", {
            className: "rt-input",
            style: { flex: 1 },
            rows: 3,
            placeholder: "一行一个目录",
            disabled: draft === null,
            value: draft?.binDirsText ?? "",
            onChange: (event) => {
                if (draft === null)
                    return;
                const value = String(event.target?.value ?? "");
                props.onDraftChange({ ...draft, binDirsText: value });
            },
        })));
        // **必须用 `envKeysOf` 而不是 `Object.keys(draft?.env ?? {})`**：
        // 草稿未加载时后者给空数组，整个环境变量区渲染成空白 ——
        // 界面看起来像「这个功能没有环境变量」，而实际上只是还没加载完。
        const envFields = h("div", null, envKeysOf(draft).map((key) => h("div", { key, className: "rt-kv" }, h("span", { className: "rt-mono" }, key), h("input", {
            className: "rt-input",
            style: { flex: 1 },
            // 与其它受草稿驱动的输入框保持一致：未加载时禁用，
            // 否则用户输入会被随后的 load 覆盖（看起来像「输入没生效」）。
            disabled: draft === null,
            value: draft?.env[key] ?? "",
            onChange: (event) => {
                if (draft === null)
                    return;
                const value = String(event.target?.value ?? "");
                props.onDraftChange({ ...draft, env: { ...draft.env, [key]: value } });
            },
        }))));
        const toolRows = tools.map((tool) => toolRow(runtime, props, tool));
        const notesField = h("div", { className: "rt-kv" }, h("span", null, "备注"), h("textarea", {
            className: "rt-input",
            style: { flex: 1 },
            rows: 2,
            disabled: draft === null,
            value: draft?.notes ?? "",
            onChange: (event) => {
                if (draft === null)
                    return;
                const value = String(event.target?.value ?? "");
                props.onDraftChange({ ...draft, notes: value });
            },
        }));
        return h("div", { className: "rt-main" }, toolbar, h("div", { className: "rt-pane", style: { minHeight: 0 } }, messages, noticeCard, assignCard, hintCard, egressCard, h("div", { className: "rt-card", style: { margin: "0 0 8px" } }, h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "平台与目录"), platformField, dirFields), h("div", { className: "rt-card", style: { margin: "0 0 8px" } }, h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "环境变量"), envFields), h("div", { className: "rt-card", style: { margin: "0 0 8px" } }, h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "工具路径（" + (0, env_model_js_1.foundToolCount)(tools) + "/" + tools.length + " 已找到）"), toolRows.length > 0
            ? toolRows
            : h("div", { className: "rt-empty" }, "暂无工具清单")), h("div", { className: "rt-card", style: { margin: "0 0 8px" } }, h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "备注"), notesField)));
    }
    /** 工具目录的输入提示（与原实现一致）。 */
    const DEFAULT_TOOLKIT_PLACEHOLDER = "$DSH_HOME/redteam/toolkit";
    /**
     * 加载流程（供组件调用）。
     *
     * 抽出来是为了让「读取 → 设草稿」的时序可测：先清错误、再发请求、
     * 失败时保留上次草稿（而不是清空 —— 清空会让用户正在编辑的内容消失）。
     */
    async function loadEnv(api, onLoaded, onError) {
        const response = await api.raw({ op: "platformConfigGet" });
        if (response.ok === false) {
            onError(response.error ?? "读取失败");
            return;
        }
        onLoaded(response);
    }
    /** 保存流程。 */
    async function saveEnv(api, draft) {
        const response = await api.raw({ op: "platformConfigSave", config: (0, env_model_js_1.payloadFromDraft)(draft) });
        return { ok: response.ok !== false, response: response.ok === false ? null : response };
    }
    /** 自动分配流程。 */
    async function assignEnv(api, folderPath, draft) {
        const dir = (0, env_model_js_1.assignDirOf)(folderPath, draft);
        if (dir === "") {
            // 前置校验：不发注定失败的空路径请求。
            return { ok: false, response: null, error: env_model_js_1.ASSIGN_EMPTY_DIR_MESSAGE };
        }
        const response = await api.raw({ op: "platformAssignToolkit", dir });
        if (response.ok === false) {
            return { ok: false, response: null, error: response.error ?? "自动分配失败" };
        }
        return { ok: true, response, error: null };
    }
    /**
     * 从保存响应刷新草稿。
     *
     * 保存成功后要用服务端返回值重建草稿 —— 服务端可能对输入做了归一
     * （如 clamps 平台、展开 `~`），不回读就会显示成用户输入的原样，
     * 与磁盘上的实际配置不一致。
     */
    function refreshDraftFrom(response) {
        if (response.ok === false)
            return null;
        return (0, env_model_js_1.draftFromResponse)(response);
    }
    /** 环境变量键列表（组件渲染时用）。 */
    function envKeysOf(draft) {
        if (draft === null)
            return env_model_js_1.KNOWN_ENV_KEYS;
        return Object.keys(draft.env);
    }
});
/**
 * 漏洞战果页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `FindingsTab` 的 286 行里，有 130 行是**四件互不相干的逻辑**：
 *
 * 1. **漏洞行 + 展开详情**（`vulnRows`）
 * 2. **按目标聚合**（`targetKeyOf` + 分组排序）
 * 3. **攻击文件按漏洞聚合**（`filesByVuln` / `orphanFiles`）
 * 4. **证据区**（`detailEvidence` + HTTP 报文的行级着色）
 *
 * 这四块全是纯数据变换，埋在组件里只能整页渲染才能测。抽出来后：
 * - 「按目标聚合」的**归并规则**可逐条断言（带路径的 URL 不能把分组打散）
 * - 「拿到什么」的分割规则可穷举（`gained` 用中文顿号/逗号/分号分隔）
 * - 「证据缺失」这条红线可钉死（未验证/无证据的漏洞不计入报告）
 *
 * ## 三个容易错的地方
 *
 * 1. **`targetKeyOf` 必须砍掉路径**：`https://a/b` 与 `https://a/c` 是同一台。
 *    原实现用两条正则分别处理「带 scheme 的 URL」与「裸 host:port」，顺序有意义。
 * 2. **排序是复合的**：先按最高严重级，再按漏洞条数降序 —— 只按严重级排，
 *    同一档里 20 条的目标会混在 1 条的目标后面。
 * 3. **`stats` 缺失时不能崩**：原实现 `(state.stats && state.stats.bySeverity) ? ... : { bySeverity:{}, byStatus:{} }`。
 *    `stats` 为空对象但缺 `bySeverity` 时也要兜底 —— 否则结论行直接抛。
 */
define("redteam/client/findings-model", ["require", "exports", "redteam/client/helpers", "redteam/client/label"], function (require, exports, helpers_js_5, label_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.STATUS_ACTIONS = exports.MISSING_ATTACK_FILE_MESSAGE = exports.MISSING_GAINED_MESSAGE = exports.EMPTY_ACCESS_MESSAGE = exports.EMPTY_CREDENTIALS_MESSAGE = exports.EMPTY_FINDINGS = exports.MISSING_EVIDENCE_MESSAGE = exports.RESTART_HINT = exports.EMPTY_FINDINGS_MESSAGE = exports.FINDINGS_LIMIT = exports.SEVERITY_RANK = exports.STATUS_OPTIONS = exports.SEVERITY_OPTIONS = exports.STATUS_LABEL = exports.SEVERITY_LABEL = void 0;
    exports.countOrZero = countOrZero;
    exports.severityOf = severityOf;
    exports.vulnStatusOf = vulnStatusOf;
    exports.severityClass = severityClass;
    exports.severityLabel = severityLabel;
    exports.statusLabel = statusLabel;
    exports.gainedListOf = gainedListOf;
    exports.gainedSummary = gainedSummary;
    exports.targetKeyOf = targetKeyOf;
    exports.httpEvidenceOf = httpEvidenceOf;
    exports.vulnOf = vulnOf;
    exports.statsOf = statsOf;
    exports.findingsOf = findingsOf;
    exports.needsRestart = needsRestart;
    exports.credentialOf = credentialOf;
    exports.credentialsOf = credentialsOf;
    exports.accessOf = accessOf;
    exports.accessesOf = accessesOf;
    exports.attackFileOf = attackFileOf;
    exports.attackFileGroupsOf = attackFileGroupsOf;
    exports.indexFilesByVuln = indexFilesByVuln;
    exports.groupByTarget = groupByTarget;
    exports.groupSubtitle = groupSubtitle;
    exports.groupGainedLabel = groupGainedLabel;
    exports.groupCountLabel = groupCountLabel;
    exports.conclusionItems = conclusionItems;
    exports.targetSummary = targetSummary;
    exports.conclusionLabel = conclusionLabel;
    exports.conclusionClass = conclusionClass;
    exports.confidenceLabel = confidenceLabel;
    exports.vulnTitle = vulnTitle;
    exports.vulnTarget = vulnTarget;
    exports.vulnAssetLine = vulnAssetLine;
    exports.vulnSourceLine = vulnSourceLine;
    exports.credentialMeta = credentialMeta;
    exports.credentialsHeading = credentialsHeading;
    exports.accessHeading = accessHeading;
    exports.subTabLabel = subTabLabel;
    exports.subTabClass = subTabClass;
    exports.subTabAriaLabel = subTabAriaLabel;
    exports.attackFilesHint = attackFilesHint;
    exports.statusUpdatedMessage = statusUpdatedMessage;
    exports.updateVulnPatch = updateVulnPatch;
    exports.looksLikeHttp = looksLikeHttp;
    exports.evidenceMissing = evidenceMissing;
    exports.httpLineKind = httpLineKind;
    exports.httpLineClass = httpLineClass;
    exports.httpBlockClass = httpBlockClass;
    exports.httpLinesOf = httpLinesOf;
    exports.evidenceHeadLabel = evidenceHeadLabel;
    /** 严重级 → 中文（顺序即下拉框顺序）。 */
    exports.SEVERITY_LABEL = Object.freeze({
        critical: "严重",
        high: "高危",
        medium: "中危",
        low: "低危",
        info: "信息",
    });
    /** 状态 → 中文。 */
    exports.STATUS_LABEL = Object.freeze({
        candidate: "待验证",
        confirmed: "已确认",
        "false-positive": "误报",
        exploited: "已利用",
        fixed: "已修复",
    });
    /** 严重级下拉的选项（值 + 显示名）。 */
    exports.SEVERITY_OPTIONS = Object.freeze([
        { value: "", label: "全部等级" },
        { value: "critical", label: "严重" },
        { value: "high", label: "高危" },
        { value: "medium", label: "中危" },
        { value: "low", label: "低危" },
        { value: "info", label: "信息" },
    ]);
    /** 状态下拉的选项。 */
    exports.STATUS_OPTIONS = Object.freeze([
        { value: "", label: "全部状态" },
        { value: "candidate", label: "待验证" },
        { value: "confirmed", label: "已确认" },
        { value: "exploited", label: "已利用" },
        { value: "false-positive", label: "误报" },
        { value: "fixed", label: "已修复" },
    ]);
    /**
     * 严重级的排序权重。
     *
     * 未知级别取 `9`（原实现 `SEV_RANK[a.severity] ?? 9`）—— 排在最后，
     * 但**不会消失**。上游加了新级别时界面会把它放在末尾，便于发现「前端没跟上」。
     */
    exports.SEVERITY_RANK = Object.freeze({
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
        info: 4,
    });
    /** 默认每页条数（与原实现一致）。 */
    exports.FINDINGS_LIMIT = 200;
    /** 空态文案。 */
    exports.EMPTY_FINDINGS_MESSAGE = "暂无漏洞记录";
    /** 重启提示（宿主版本不含该 op 时）。 */
    exports.RESTART_HINT = "该模块的宿主代码已更新，需重启一次当前宿主（官方 exe / 社区版 / dsh web）后生效";
    /** 证据缺失的警示（原实现的红线文案）。 */
    exports.MISSING_EVIDENCE_MESSAGE = "缺失 —— 未验证/无证据的漏洞不计入报告，请补 redteam_http_evidence_add";
    /** 空结果（避免每处手写一份）。 */
    exports.EMPTY_FINDINGS = Object.freeze({
        total: 0,
        items: Object.freeze([]),
        stats: Object.freeze({
            bySeverity: Object.freeze({}),
            byStatus: Object.freeze({}),
            withGained: 0,
            targetGroups: 0,
        }),
        error: null,
        loading: false,
    });
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组。 */
    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 读一个有限数字（非有限 → `null`）。 */
    function numberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 计数字段兜底（非数字 / 负数 → 0）。 */
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 归一严重级（未知 → `info`，与原实现的 `sevClass` 兜底一致）。 */
    function severityOf(value) {
        switch (value) {
            case "critical":
            case "high":
            case "medium":
            case "low":
            case "info":
                return value;
            default:
                return "info";
        }
    }
    /** 归一状态（未知 → `candidate`：还没验证是最保守的解读）。 */
    function vulnStatusOf(value) {
        switch (value) {
            case "candidate":
            case "confirmed":
            case "exploited":
            case "false-positive":
            case "fixed":
                return value;
            default:
                return "candidate";
        }
    }
    /** 严重级徽章的 className。 */
    function severityClass(value) {
        return "rt-sev rt-sev-" + severityOf(value);
    }
    /**
     * 严重级的中文名。
     *
     * 未知取值**原样显示 code**（`SEV_LABEL[s] || s`）—— 上游加了新级别时界面
     * 会暴露新值而不是变成一片「未知」，便于发现「后端加了、前端没跟上」。
     *
     * 注意空串/null 也原样返回空串（不是 `—`）：原实现是 `||` 短路，
     * 空值走的是「返回原值」那条路。要显示 `—` 的地方由调用方自己判断。
     */
    function severityLabel(value) {
        return (0, label_js_3.labelOf)(exports.SEVERITY_LABEL, value);
    }
    /** 状态的中文名（未知同样原样显示）。 */
    function statusLabel(value) {
        return (0, label_js_3.labelOf)(exports.STATUS_LABEL, value);
    }
    /**
     * 拆分「拿到什么」。
     *
     * 原实现：`String(v.gained || '').split(/[、,;，；]/).map(trim).filter(Boolean)`。
     * 支持中文顿号/逗号/分号与半角逗号/分号 —— 智能体回填时分隔符不统一。
     */
    function gainedListOf(value) {
        const raw = typeof value === "string" ? value : "";
        return raw
            .split(/[、,;，；]/)
            .map((part) => part.trim())
            .filter((part) => part !== "");
    }
    /**
     * 「拿到什么」的一行摘要。
     *
     * 多余项收成 `+N`（原实现 `gainedList[0] + ' +' + (len-1)`）——
     * 表格列宽有限，铺开会把整个网格挤变形。空列表返回空串，由调用方决定显示 `—`。
     */
    function gainedSummary(list) {
        const first = list[0];
        if (first === undefined)
            return "";
        return list.length > 1 ? first + " +" + (list.length - 1) : first;
    }
    /**
     * 目标归并键：按「scheme://host:port」聚合，避免带路径的 URL 把分组打散。
     *
     * **保留原实现的判定顺序**：
     * 1. `target` 为空 → 用 `asset_ip`，都没有 → `(未指定目标)`；
     * 2. 带 scheme 的 URL 只取 `scheme://host[:port]`（砍掉 path/query/hash）；
     * 3. 裸串按第一个 `/`、`?`、`#`、空白切一刀；
     * 4. 全都不匹配（极端空白）→ 原样。
     */
    function targetKeyOf(v) {
        const raw = typeof v.target === "string" ? v.target.trim() : "";
        if (raw !== "") {
            const url = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)/i.exec(raw);
            if (url !== null && url[1] !== undefined)
                return url[1];
            const head = /^([^\s/?#]+)/.exec(raw);
            if (head !== null && head[1] !== undefined)
                return head[1];
            return raw;
        }
        const ip = typeof v.asset_ip === "string" ? v.asset_ip : "";
        return ip !== "" ? ip : "(未指定目标)";
    }
    /** 解析一条 HTTP 证据。 */
    function httpEvidenceOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            label: text(item["label"]),
            method: text(item["method"]),
            status: numberOrNull(item["status"]),
            request: text(item["request"]),
            response: text(item["response"]),
            note: text(item["note"]),
            capturedAt: text(item["captured_at"]) || text(item["created_at"]),
        };
    }
    /** 解析一条漏洞。 */
    function vulnOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        const gained = text(item["gained"]);
        return {
            id,
            title: text(item["title"]),
            severity: severityOf(item["severity"]),
            status: vulnStatusOf(item["status"]),
            cve: text(item["cve"]),
            target: text(item["target"]),
            assetIp: text(item["asset_ip"]),
            segmentCidr: text(item["segment_cidr"]),
            gained,
            gainedList: gainedListOf(gained),
            source: text(item["source"]),
            foundByAgent: text(item["found_by_agent"]),
            foundAt: text(item["found_at"]),
            confidence: numberOrNull(item["confidence"]),
            evidence: text(item["evidence"]),
            httpEvidence: asArray(item["http_evidence"])
                .map(httpEvidenceOf)
                .filter((entry) => entry !== null),
        };
    }
    /** 解析统计块。 */
    function statsOf(raw) {
        const item = asRecord(raw);
        const bySeverity = asRecord(item["bySeverity"]);
        const byStatus = asRecord(item["byStatus"]);
        const severityCounts = {};
        for (const [key, value] of Object.entries(bySeverity))
            severityCounts[key] = countOrZero(value);
        const statusCounts = {};
        for (const [key, value] of Object.entries(byStatus))
            statusCounts[key] = countOrZero(value);
        return {
            bySeverity: severityCounts,
            byStatus: statusCounts,
            withGained: countOrZero(item["withGained"]),
            targetGroups: countOrZero(item["targetGroups"]),
        };
    }
    /**
     * 解析 `vulns` 响应。
     *
     * `stats` 缺失时给一份空表（结论行据此渲染 0）—— 原实现的兜底也一样，
     * 只是它写成 `(state.stats && state.stats.bySeverity) ? ... : {bySeverity:{},byStatus:{}}`，
     * 也就是说 `stats` 存在但缺少 `bySeverity` 时也走空表分支。
     */
    function findingsOf(response) {
        if ((0, helpers_js_5.isFailure)(response)) {
            const error = asRecord(response)["error"];
            return {
                ...exports.EMPTY_FINDINGS,
                error: typeof error === "string" && error !== "" ? error : "查询失败",
            };
        }
        const body = asRecord(response);
        const items = asArray(body["items"])
            .map(vulnOf)
            .filter((item) => item !== null);
        return {
            total: countOrZero(body["total"]),
            items,
            stats: statsOf(body["stats"]),
            error: null,
            loading: false,
        };
    }
    /** 是否是「宿主版本不含该 op」的错误。 */
    function needsRestart(error) {
        return error !== null && error.includes("unknown op");
    }
    /** 一条凭据。 */
    function credentialOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            host: text(item["host"]),
            username: text(item["username"]),
            secretType: text(item["secret_type"]),
            secretValue: text(item["secret_value"]),
            privilege: text(item["privilege"]),
            source: text(item["source"]),
            tool: text(item["tool"]),
            secretRef: text(item["secret_ref"]),
            foundByAgent: text(item["found_by_agent"]),
            foundAt: text(item["found_at"]),
            note: text(item["note"]),
        };
    }
    /** 解析凭据列表响应（失败 → 空数组，与原实现的 `(r && r.items) || []` 一致）。 */
    function credentialsOf(response) {
        if ((0, helpers_js_5.isFailure)(response))
            return [];
        return asArray(asRecord(response)["items"])
            .map(credentialOf)
            .filter((item) => item !== null);
    }
    /** 一条访问会话。 */
    function accessOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            host: text(item["host"]),
            username: text(item["username"]),
            method: text(item["method"]),
            privilege: text(item["privilege"]),
            sessionRef: text(item["session_ref"]),
        };
    }
    /** 解析访问会话列表。 */
    function accessesOf(response) {
        if ((0, helpers_js_5.isFailure)(response))
            return [];
        return asArray(asRecord(response)["items"])
            .map(accessOf)
            .filter((item) => item !== null);
    }
    /** 一条攻击文件（已带上所属目标）。 */
    function attackFileOf(raw, target) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        const rawVuln = item["vuln_id"];
        const vulnId = rawVuln === null || rawVuln === undefined ? null : numberOrNull(rawVuln);
        return {
            id,
            name: text(item["name"]),
            kind: text(item["kind"]),
            description: text(item["description"]),
            path: text(item["path"]),
            vulnId,
            target,
        };
    }
    /** 解析 `attackFiles` 响应（按目标分组）。 */
    function attackFileGroupsOf(response) {
        if ((0, helpers_js_5.isFailure)(response))
            return [];
        return asArray(asRecord(response)["items"]).map((raw) => {
            const group = asRecord(raw);
            const target = text(group["target"]);
            return {
                target,
                files: asArray(group["files"])
                    .map((file) => attackFileOf(file, target))
                    .filter((file) => file !== null),
            };
        });
    }
    /**
     * 把攻击文件按漏洞 id 归堆，并挑出没挂漏洞的。
     *
     * 原实现用 `vuln_id === null || undefined ? orphan : byVuln`。
     * **注意 `0` 的处理**：`vuln_id: 0` 在原实现里因为 `Number(0)` 不是 null，
     * 会被当成有效 id 归堆（虽然实际不会出现 id 0）—— 这里保持一致。
     */
    function indexFilesByVuln(groups) {
        const byVuln = new Map();
        const orphans = [];
        const all = [];
        for (const group of groups) {
            for (const file of group.files) {
                all.push(file);
                if (file.vulnId === null) {
                    orphans.push(file);
                    continue;
                }
                const bucket = byVuln.get(file.vulnId);
                if (bucket === undefined)
                    byVuln.set(file.vulnId, [file]);
                else
                    bucket.push(file);
            }
        }
        return { byVuln, orphans, all };
    }
    /**
     * 按目标聚合 + 排序。
     *
     * 排序是**复合**的：先按最高严重级升序（critical 在前），再按漏洞条数降序。
     * 只按严重级排会让同档次里 20 条的目标沉到 1 条的目标后面，看不出「哪台被打得最狠」。
     */
    function groupByTarget(vulns) {
        const buckets = new Map();
        for (const vuln of vulns) {
            const key = targetKeyOf({ target: vuln.target, asset_ip: vuln.assetIp });
            const bucket = buckets.get(key);
            if (bucket === undefined)
                buckets.set(key, [vuln]);
            else
                bucket.push(vuln);
        }
        const groups = [];
        for (const [key, list] of buckets) {
            const sorted = list.slice().sort((a, b) => rankOf(a.severity) - rankOf(b.severity));
            const top = sorted[0];
            if (top === undefined)
                continue;
            const gained = [];
            const seen = new Set();
            for (const vuln of list) {
                for (const item of vuln.gainedList) {
                    if (seen.has(item))
                        continue;
                    seen.add(item);
                    gained.push(item);
                }
            }
            groups.push({
                key,
                vulns: list,
                top,
                gained,
                exploited: list.filter((vuln) => isExploited(vuln)).length,
            });
        }
        return groups.sort((a, b) => rankOf(a.top.severity) - rankOf(b.top.severity) || b.vulns.length - a.vulns.length);
    }
    /** 取严重级权重（未知 → 9）。 */
    function rankOf(severity) {
        return exports.SEVERITY_RANK[severity] ?? 9;
    }
    /** 是否已利用（拆出来避免在 sort/filter 里重复写字符串）。 */
    function isExploited(vuln) {
        return vuln.status === "exploited";
    }
    /** 聚合组的副标题：严重级 · 已利用 N · 资产 IP（与分组键不同时才给）。 */
    function groupSubtitle(group) {
        return [
            severityLabel(group.top.severity),
            group.exploited > 0 ? "已利用 " + group.exploited : null,
            group.top.assetIp !== "" && group.top.assetIp !== group.key ? "资产 " + group.top.assetIp : null,
        ].filter((part) => part !== null).join(" · ");
    }
    /** 聚合组右侧的「拿到什么」：最多两项 + `+N`。 */
    function groupGainedLabel(group) {
        if (group.gained.length === 0)
            return "未记录权限";
        const head = group.gained.slice(0, 2).join(" / ");
        return group.gained.length > 2 ? head + " +" + (group.gained.length - 2) : head;
    }
    /** 聚合组的计数文案（`N 个漏洞`）。 */
    function groupCountLabel(group) {
        return group.vulns.length + " 个漏洞";
    }
    /**
     * 结论行的六项。
     *
     * 原实现把「已确认 / 已利用 / 严重 / 高危 / 中危 / 拿到权限」六个数字并排放，
     * 点一下就是筛选、再点取消。这里把「值的来源 + 点完变什么」集中算出来，
     * 组件只负责渲染与派发。
     *
     * **「拿到权限」不可点**：它不是筛选项（`stats.withGained` 是独立统计，
     * 后端没有对应的筛选参数）。原实现同样给了一个空回调。
     */
    function conclusionItems(stats, severity, status) {
        return [
            {
                code: "confirmed",
                label: "已确认",
                count: stats.byStatus["confirmed"] ?? 0,
                active: status === "confirmed",
                next: status === "confirmed" ? "" : "confirmed",
            },
            {
                code: "exploited",
                label: "已利用",
                count: stats.byStatus["exploited"] ?? 0,
                active: status === "exploited",
                next: status === "exploited" ? "" : "exploited",
            },
            {
                code: "critical",
                label: "严重",
                count: stats.bySeverity["critical"] ?? 0,
                active: severity === "critical",
                next: severity === "critical" ? "" : "critical",
            },
            {
                code: "high",
                label: "高危",
                count: stats.bySeverity["high"] ?? 0,
                active: severity === "high",
                next: severity === "high" ? "" : "high",
            },
            {
                code: "medium",
                label: "中危",
                count: stats.bySeverity["medium"] ?? 0,
                active: severity === "medium",
                next: severity === "medium" ? "" : "medium",
            },
            {
                code: "gained",
                label: "拿到权限",
                count: stats.withGained,
                active: false,
                next: "",
            },
        ];
    }
    /** 结论行右侧的目标数说明。 */
    function targetSummary(stats) {
        return "默认按目标聚合 · 共 " + stats.targetGroups + " 个目标";
    }
    /** 结论项的 aria-label（读屏播报「按 X 筛选（N）」）。 */
    function conclusionLabel(item) {
        return "按「" + item.label + "」筛选（" + item.count + "）";
    }
    /** 结论项的 className（选中加 `on`）。 */
    function conclusionClass(item) {
        return "rt-concl-i" + (item.active ? " on" : "");
    }
    /** 置信度的显示值（`null` → `—`，否则百分比取整）。 */
    function confidenceLabel(value) {
        if (value === null)
            return "—";
        return Math.round(value * 100) + "%";
    }
    /** 漏洞标题的显示串（`CVE-xxx 标题`）。 */
    function vulnTitle(vuln) {
        return (vuln.cve !== "" ? vuln.cve + " " : "") + vuln.title;
    }
    /** 漏洞目标的显示值（`target` → `asset_ip` → `—`）。 */
    function vulnTarget(vuln) {
        if (vuln.target !== "")
            return vuln.target;
        return vuln.assetIp !== "" ? vuln.assetIp : "—";
    }
    /** 详情里的资产行（`IP · C 段`）。 */
    function vulnAssetLine(vuln) {
        return (vuln.assetIp !== "" ? vuln.assetIp : "—") + " · " + vuln.segmentCidr;
    }
    /** 详情里的来源行（`来源 · 角色 · 时间`）。 */
    function vulnSourceLine(vuln) {
        return (vuln.source !== "" ? vuln.source : "—")
            + " · " + (vuln.foundByAgent !== "" ? vuln.foundByAgent : "—")
            + " · " + (0, helpers_js_5.formatTimestamp)(vuln.foundAt);
    }
    /** 凭据的元信息行。 */
    function credentialMeta(cred) {
        return [
            cred.source !== "" ? "来源 " + cred.source : null,
            cred.tool !== "" ? "工具 " + cred.tool : null,
            cred.secretRef !== "" ? "证据 " + cred.secretRef : null,
            cred.foundByAgent !== "" ? "by " + cred.foundByAgent : null,
            cred.foundAt !== "" ? (0, helpers_js_5.formatTimestamp)(cred.foundAt) : null,
        ].filter((part) => part !== null).join(" · ");
    }
    /** 凭据区的标题（有凭据时提示明文直显的风险）。 */
    function credentialsHeading(count) {
        return "凭据 · " + count + (count > 0 ? "（明文直显，注意屏幕分享/录屏）" : "");
    }
    /** 凭据区的空态。 */
    exports.EMPTY_CREDENTIALS_MESSAGE = "暂无凭据（拿到口令/密钥/Hash 后用 redteam_credential_add 落库，秒级可复用）";
    /** 访问会话区的标题。 */
    function accessHeading(count) {
        return "已获得访问会话 · " + count;
    }
    /** 访问会话密码区的空态。 */
    exports.EMPTY_ACCESS_MESSAGE = "暂无";
    /** 子页签按钮的文案（原实现是 `label + ' ' + n`）。 */
    function subTabLabel(label, count) {
        return label + " " + count;
    }
    /** 子页签按钮的 className。 */
    function subTabClass(key, current) {
        return "rt-subtab" + (key === current ? " on" : "");
    }
    /** 子页签按钮的 aria-label（原实现 `label + '（' + n + '）'`）。 */
    function subTabAriaLabel(label, count) {
        return label + "（" + count + "）";
    }
    /** 攻击文件子页签的说明文案（含孤儿文件提醒）。 */
    function attackFilesHint(orphanCount) {
        return "攻击文件按靶标目录组织（原「攻击文件」页签）；每条漏洞的关联文件也能在该漏洞详情里直接看到。"
            + (orphanCount > 0
                ? " 目前有 " + orphanCount + " 个文件没挂 vuln_id，建议补上以便与漏洞对应。"
                : "");
    }
    /** 漏洞详情里「拿到什么」的缺失说明。 */
    exports.MISSING_GAINED_MESSAGE = "未记录 —— 拿到权限/成果后请用 redteam_vuln_update 补 gained（例：服务器权限、内网隧道、后台管理员账号）";
    /** 漏洞详情里「攻击文件」的缺失说明。 */
    exports.MISSING_ATTACK_FILE_MESSAGE = "（无）用 redteam_attack_file_add 把这条漏洞打通的脚本/马/EXP 归档，并带上 vuln_id";
    /** 四个状态按钮（顺序即界面顺序）。 */
    exports.STATUS_ACTIONS = Object.freeze([
        { status: "confirmed", label: "确认" },
        { status: "exploited", label: "已利用" },
        { status: "false-positive", label: "误报" },
        { status: "fixed", label: "已修复" },
    ]);
    /** 更新状态成功后的提示（原实现 `已更新为「X」`）。 */
    function statusUpdatedMessage(next) {
        return "已更新为「" + (exports.STATUS_LABEL[next] ?? next) + "」";
    }
    /** 更新状态的请求载荷（`patch.status`）。 */
    function updateVulnPatch(next) {
        return { status: next };
    }
    /**
     * 证据区的判定：这段文本看起来是不是原始 HTTP 报文。
     *
     * 原实现：`/^(GET|POST|...|HTTP\/)/m` 或 `/\n[A-Za-z-]+: /`。
     * 前者匹配「首行是请求行或状态行」，后者匹配「任意行的头字段」。
     * 判错的后果是：把报文明文塞进 `<pre>` 而不是按行着色，人眼很难扫读。
     */
    function looksLikeHttp(text) {
        const value = text.trim();
        if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|HTTP\/)/m.test(value))
            return true;
        return /\n[A-Za-z-]+: /.test(value);
    }
    /** 证据是否缺失（红线：没有证据的漏洞不进报告）。 */
    function evidenceMissing(vuln) {
        return vuln.evidence.trim() === "" && vuln.httpEvidence.length === 0;
    }
    /**
     * 给一行 HTTP 报文着色。
     *
     * 原实现逐行判定：
     * - 第 0 行以方法名开头 → 请求行（`rt-hl-req`）；
     * - 第 0 行以 `HTTP/` 开头 → 状态行（`rt-hl-res`）；
     * - 任意行 `Name:` 且名字是 host/cookie/authorization/content-type → 请求头高亮。
     *
     * 「第 0 行」是硬条件 —— 报文中间的正文里出现 `GET xxx` 不该被着色。
     */
    function httpLineKind(line, index) {
        if (index === 0) {
            if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s/.test(line))
                return "req";
            if (/^HTTP\//.test(line))
                return "res";
        }
        if (/^[A-Za-z0-9-]+:/.test(line)) {
            const name = line.split(":")[0];
            if (name === undefined)
                return null;
            const lower = name.toLowerCase();
            if (lower === "host" || lower === "cookie" || lower === "authorization" || lower === "content-type") {
                return "header";
            }
        }
        return null;
    }
    /**
     * 行类别 → className。
     *
     * 请求行与请求头（host/cookie/authorization/content-type）共用 `rt-hl-req`，
     * 状态行用 `rt-hl-res`；其余不加类。`compact` 只影响外层 `<pre>` 的类
     * （见 `httpBlockClass`），单行不加额外类。
     */
    function httpLineClass(kind) {
        if (kind === "req" || kind === "header")
            return "rt-hl-req";
        if (kind === "res")
            return "rt-hl-res";
        return undefined;
    }
    /** `<pre>` 的 className（紧凑模式给 `rt-evi-body req`，否则 `rt-evi-body`）。 */
    function httpBlockClass(compact) {
        return compact ? "rt-evi-body req" : "rt-evi-body";
    }
    /**
     * 把报文切成行。
     *
     * 空行渲染成 `\u00a0`：`<div></div>` 在部分浏览器里高度塌成 0，
     * 报文里的空行（头/体分隔）就会消失，看起来像报文被截断了。
     */
    function httpLinesOf(text) {
        if (text === "")
            return [];
        return text.split(/\r?\n/).map((line) => (line === "" ? "\u00a0" : line));
    }
    /** 一条证据的标题（`方法 状态码`）。 */
    function evidenceHeadLabel(ev) {
        return (ev.method !== "" ? ev.method : "") + " " + (ev.status === null ? "" : String(ev.status));
    }
});
/**
 * 漏洞战果页（`findings` 页签）的渲染。
 *
 * 数据与判定全在 `findings-model.ts`，这里只排版。
 *
 * ## 结构（原实现是一个页签套四个子页签）
 *
 * ```
 * 工具栏：搜索 / 等级 / 状态
 * 结论行：已确认 3 · 已利用 1 · 严重 2 · 高危 5 · 中危 8 · 拿到权限 4
 * 子页签：漏洞 N ｜ 攻击文件 N ｜ 凭据 N ｜ 访问会话 N
 * 正文：
 *   漏洞   → 按目标聚合（可折叠的分组）/ 平铺表格
 *   攻击文件 → 复用攻击文件页
 *   凭据   → 明文直显（带复制）
 *   访问会话 → 一行一条
 * ```
 *
 * ## 两个原实现的细节，这里保留
 *
 * 1. **「拿到权限」不可点**：它来自独立统计（`stats.withGained`），
 *    后端没有对应筛选参数。原实现给的是空回调 —— 不给空按钮看起来像坏了，
 *    但把它做成筛选项会得到一个永远空的结果集。
 * 2. **聚合视图的折叠头是分组标题，不是漏洞行**：`全部展开/全部收起`
 *    两个按钮只在聚合视图出现，平铺视图下没有意义。
 */
define("redteam/client/findings-tab", ["require", "exports", "redteam/client/state", "redteam/client/helpers", "redteam/client/findings-model"], function (require, exports, state_js_4, helpers_js_6, findings_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_FINDINGS_FILTER = void 0;
    exports.renderFindingsTab = renderFindingsTab;
    exports.loadFindings = loadFindings;
    exports.loadSideLists = loadSideLists;
    exports.updateVulnStatus = updateVulnStatus;
    exports.isSeverity = isSeverity;
    exports.evidenceCopyable = evidenceCopyable;
    exports.vulnLacksEvidence = vulnLacksEvidence;
    /** 默认过滤（全显示）。 */
    exports.DEFAULT_FINDINGS_FILTER = Object.freeze({
        query: "",
        queryApplied: "",
        severity: "",
        status: "",
    });
    /**
     * 折叠分组头（原实现的 `Section` 组件）。
     *
     * 上游把它做成可复用组件，但它不在本工作流的写入域里，所以这里按同样的
     * 元素结构与 class 名复刻一份 —— 样式表里的 `rt-sec*` 是现成的。
     */
    function sectionNode(runtime, options, children) {
        const { h } = runtime;
        return h("div", { key: options.key, className: "rt-sec-wrap" }, h("div", {
            className: "rt-sec t-" + options.tone,
            role: "button",
            tabIndex: 0,
            "aria-expanded": options.open ? "true" : "false",
            onClick: options.onToggle,
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    options.onToggle(event);
                }
            },
        }, h("span", { className: "rt-sec-caret" }, options.open ? "▾" : "▸"), options.title !== "" ? h("span", { className: "rt-sec-title" }, options.title) : null, h("span", { className: "rt-sec-count" }, options.count), options.sub !== "" ? h("span", { className: "rt-sec-sub" }, options.sub) : null, options.right !== "" ? h("span", { className: "rt-sec-right" }, options.right) : null), options.open ? h("div", { className: "rt-sec-body" }, children) : null);
    }
    /**
     * 一段原始 HTTP 报文（原 `HttpBlock`）。
     *
     * 逐行加 `<div>` 而不是整段塞 `<pre>`：行级着色才能在长报文里一眼找到
     * 请求行与关键头。
     */
    function httpBlock(runtime, text, compact) {
        if (text === "")
            return null;
        const lines = (0, findings_model_js_1.httpLinesOf)(text);
        return runtime.h("pre", { className: (0, findings_model_js_1.httpBlockClass)(compact) }, lines.map((line, index) => {
            const cls = (0, findings_model_js_1.httpLineClass)((0, findings_model_js_1.httpLineKind)(line, index));
            return runtime.h("div", { key: "l" + index, className: cls }, line);
        }));
    }
    /** 证据区（原 `detailEvidence`）。 */
    function evidenceNode(runtime, props, vuln) {
        const { h } = runtime;
        const blocks = [];
        const evidence = vuln.evidence.trim();
        if (evidence !== "") {
            const isHttp = (0, findings_model_js_1.looksLikeHttp)(evidence);
            blocks.push(h("div", { key: "ev", className: "rt-evi" }, h("div", { className: "rt-evi-head" }, "证据摘要", h("span", { className: "rt-tag" }, isHttp ? "原始报文" : "文本"), h("div", { className: "rt-spacer" }), h("button", {
                className: "rt-btn",
                style: { padding: "0 6px", fontSize: 11 },
                onClick: (event) => {
                    event.stopPropagation?.();
                    props.onCopy(evidence, "证据摘要");
                },
            }, "复制")), isHttp ? httpBlock(runtime, evidence, false) : h("pre", { className: "rt-evi-body" }, evidence)));
        }
        for (const entry of vuln.httpEvidence) {
            blocks.push(h("div", { key: "h" + entry.id, className: "rt-evi" }, h("div", { className: "rt-evi-head" }, entry.label !== "" ? entry.label : "HTTP 证据", h("span", { className: "rt-tag" }, (0, findings_model_js_1.evidenceHeadLabel)(entry)), h("div", { className: "rt-spacer" }), h("span", { style: { fontWeight: 400, color: "var(--dsw-alias-label-secondary)" } }, (0, helpers_js_6.formatTimestamp)(entry.capturedAt))), entry.request !== ""
                ? h("div", null, h("div", { className: "rt-evi-head", style: { borderTop: "none" } }, "▸ 请求（可直接粘进 Burp Repeater）"), httpBlock(runtime, entry.request, true))
                : null, entry.response !== ""
                ? h("div", null, h("div", { className: "rt-evi-head" }, "▸ 响应"), httpBlock(runtime, entry.response, false))
                : null, entry.note !== ""
                ? h("pre", { className: "rt-evi-body", style: { maxHeight: 80 } }, entry.note)
                : null));
        }
        if (blocks.length === 0) {
            blocks.push(h("div", { key: "none", className: "rt-kv" }, h("b", null, "证据"), h("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, findings_model_js_1.MISSING_EVIDENCE_MESSAGE)));
        }
        return h("div", { key: "eviwrap" }, blocks);
    }
    /**
     * 取「拿到什么」的列表，**缺字段时退化为空数组**。
     *
     * `VulnItem.gainedList` 类型上是必填，由 `vulnOf()` 从 `gained` 字符串解析而来。
     * 但渲染层是公开纯函数，容器可能把**未经 `vulnOf` 的原始对象**直接喂进来
     * （宿主新增字段、或上层漏跑一次解析）—— 此时 `vuln.gainedList` 是
     * `undefined`，直接 `.length` 会让**整个漏洞页签崩掉**：
     *
     *     TypeError: Cannot read properties of undefined (reading 'length')
     *
     * 页签级崩溃比「某一列显示 —」严重得多：用户看到整页空白且无法自救。
     * 这里做一次防御，宁可少显示一列。
     */
    function gainedListOfRow(vuln) {
        const value = vuln.gainedList;
        return Array.isArray(value) ? value : [];
    }
    /** 一条漏洞的展开详情。 */
    function vulnDetail(runtime, props, vuln, mine) {
        const { h } = runtime;
        return h("div", { className: "rt-vdetail" }, h("div", { className: "rt-kv" }, h("b", null, "拿到什么"), gainedListOfRow(vuln).length > 0
            ? h("span", null, gainedListOfRow(vuln).map((item, index) => h("span", { key: "g" + index, className: "rt-gain", style: { marginRight: 6 } }, item)))
            : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, findings_model_js_1.MISSING_GAINED_MESSAGE)), h("div", { className: "rt-kv" }, h("b", null, "目标"), h("span", { className: "rt-mono", style: { wordBreak: "break-all" } }, vuln.target !== "" ? vuln.target : "—")), h("div", { className: "rt-kv" }, h("b", null, "资产"), h("span", null, (0, findings_model_js_1.vulnAssetLine)(vuln))), h("div", { className: "rt-kv" }, h("b", null, "来源"), h("span", null, (0, findings_model_js_1.vulnSourceLine)(vuln))), evidenceNode(runtime, props, vuln), h("div", { className: "rt-kv" }, h("b", null, "攻击文件"), mine.length > 0
            ? h("span", null, mine.map((file, index) => h("div", { key: "af" + index, style: { marginBottom: 3 } }, "· " + (file.kind !== "" ? "[" + file.kind + "] " : "") + (file.name !== "" ? file.name : "(未命名)")
                + (file.description !== "" ? " — " + file.description : ""), h("div", {
                className: "rt-mono",
                style: {
                    fontSize: 11,
                    marginLeft: 12,
                    color: "var(--dsw-alias-label-secondary)",
                    overflowWrap: "anywhere",
                },
            }, file.path))))
            : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, findings_model_js_1.MISSING_ATTACK_FILE_MESSAGE)), h("div", { className: "rt-actions" }, findings_model_js_1.STATUS_ACTIONS.map((action) => h("button", {
            key: action.status,
            className: "rt-btn",
            onClick: (event) => {
                event.stopPropagation?.();
                props.onUpdateStatus(vuln.id, action.status);
            },
        }, action.label))));
    }
    /** 一条漏洞行（含展开详情）。 */
    function vulnRowNodes(runtime, props, vuln, compact, filesByVuln) {
        const { h } = runtime;
        const open = props.openId === vuln.id;
        const out = [];
        out.push(h("div", {
            key: "v" + vuln.id,
            className: "rt-vrow",
            role: "button",
            tabIndex: 0,
            style: compact
                ? { cursor: "pointer", gridTemplateColumns: "58px minmax(0,1fr) 104px 68px" }
                : { cursor: "pointer" },
            onClick: () => props.onToggleOpen(vuln.id),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onToggleOpen(vuln.id);
                }
            },
        }, h("span", null, h("span", { className: (0, findings_model_js_1.severityClass)(vuln.severity) }, (0, findings_model_js_1.severityLabel)(vuln.severity))), h("span", { title: vuln.title }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), (0, findings_model_js_1.vulnTitle)(vuln)), compact ? null : h("span", { className: "rt-mono", title: vuln.target }, (0, findings_model_js_1.vulnTarget)(vuln)), h("span", { title: vuln.gained }, gainedListOfRow(vuln).length > 0
            ? h("span", {
                className: "rt-gain",
                style: {
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "inline-block",
                },
            }, (0, findings_model_js_1.gainedSummary)(gainedListOfRow(vuln)))
            : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, "—")), h("span", null, h("span", { className: "rt-tag" }, (0, findings_model_js_1.statusLabel)(vuln.status))), compact ? null : h("span", null, (0, findings_model_js_1.confidenceLabel)(vuln.confidence))));
        if (!open)
            return out;
        out.push(h("div", {
            key: "vd" + vuln.id,
            className: "rt-vrow",
            style: { cursor: "default", gridTemplateColumns: "1fr" },
        }, vulnDetail(runtime, props, vuln, filesByVuln.get(vuln.id) ?? [])));
        return out;
    }
    /** 聚合视图的一个分组。 */
    function groupNode(runtime, props, group, filesByVuln) {
        const key = "target:" + group.key;
        const open = (0, state_js_4.isSectionOpen)(props.collapse, key, false);
        return sectionNode(runtime, {
            key: "sec:" + group.key,
            tone: "target",
            title: group.key,
            count: (0, findings_model_js_1.groupCountLabel)(group),
            sub: (0, findings_model_js_1.groupSubtitle)(group),
            right: (0, findings_model_js_1.groupGainedLabel)(group),
            open,
            onToggle: () => props.onCollapseChange((0, state_js_4.toggleSection)(props.collapse, key, false)),
        }, group.vulns.map((vuln) => vulnRowNodes(runtime, props, vuln, true, filesByVuln)));
    }
    /** 结论行的一项。 */
    function conclusionNode(runtime, item, onClick) {
        return runtime.h("span", {
            key: item.code,
            className: (0, findings_model_js_1.conclusionClass)(item),
            title: "点击筛选 / 再点取消",
            role: "button",
            tabIndex: 0,
            "aria-label": (0, findings_model_js_1.conclusionLabel)(item),
            "aria-expanded": item.active ? "true" : "false",
            onClick,
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    onClick();
                }
            },
        }, runtime.h("b", null, String(item.count)), runtime.h("span", null, item.label));
    }
    /** 凭据区。 */
    function credentialsSection(runtime, props) {
        const { h } = runtime;
        return h("div", null, h("div", { className: "rt-section" }, (0, findings_model_js_1.credentialsHeading)(props.credentials.length)), props.credentials.length > 0
            ? h("div", { style: { padding: "4px 10px 0" } }, props.credentials.map((cred) => h("div", { key: "c" + cred.id, className: "rt-cred" }, h("div", { className: "rt-cred-head" }, h("span", { className: "rt-cred-host" }, cred.host), cred.username !== "" ? h("span", { className: "rt-tag" }, cred.username) : null, h("span", { className: "rt-tag rt-tag-passive" }, cred.secretType !== "" ? cred.secretType : "password"), cred.privilege !== "" ? h("span", { className: "rt-tag rt-tag-active" }, cred.privilege) : null, h("div", { className: "rt-spacer" }), h("button", {
                className: "rt-btn",
                style: { padding: "0 6px", fontSize: 11 },
                onClick: (event) => {
                    event.stopPropagation?.();
                    props.onCopy(cred.secretValue, "凭据 " + cred.host);
                },
            }, "复制")), cred.secretValue !== ""
                ? h("div", { className: "rt-secret", title: "点击可全选" }, cred.secretValue)
                : h("div", { className: "rt-secret-none" }, "未记明文 —— 请用 redteam_credential_add 的 secret_value 补上，面板才能直显"), h("div", { className: "rt-cred-meta" }, (0, findings_model_js_1.credentialMeta)(cred)), cred.note !== "" ? h("div", { className: "rt-cred-meta" }, "备注：" + cred.note) : null)))
            : h("div", { className: "rt-empty" }, findings_model_js_1.EMPTY_CREDENTIALS_MESSAGE));
    }
    /** 访问会话区。 */
    function accessSection(runtime, props) {
        const { h } = runtime;
        return h("div", null, h("div", { className: "rt-section" }, (0, findings_model_js_1.accessHeading)(props.accesses.length)), props.accesses.length > 0
            ? props.accesses.map((access) => h("div", {
                key: "a" + access.id,
                className: "rt-vrow",
                style: { cursor: "default", gridTemplateColumns: "1fr 110px 80px 80px 1fr" },
            }, h("span", { className: "rt-mono" }, access.host), h("span", null, access.username !== "" ? access.username : "—"), h("span", null, h("span", { className: "rt-tag rt-tag-active" }, access.method !== "" ? access.method : "—")), h("span", null, access.privilege !== "" ? access.privilege : "—"), h("span", { className: "rt-mono", title: access.sessionRef }, access.sessionRef !== "" ? access.sessionRef : "—")))
            : h("div", { className: "rt-empty" }, findings_model_js_1.EMPTY_ACCESS_MESSAGE));
    }
    /**
     * 渲染漏洞战果页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderFindingsTab(runtime, props) {
        const { h } = runtime;
        const findings = props.findings;
        const items = findings?.items ?? [];
        const stats = findings?.stats;
        const error = findings?.error ?? null;
        const loading = findings?.loading === true;
        const total = findings?.total ?? 0;
        const grouped = props.grouped;
        const restartHint = (0, findings_model_js_1.needsRestart)(error);
        const conclusion = h("div", { className: "rt-concl" }, (0, findings_model_js_1.conclusionItems)(stats ?? EMPTY_STATS, props.filter.severity, props.filter.status)
            .map((item) => conclusionNode(runtime, item, () => {
            // 「拿到权限」不是筛选项：既不筛也不取消（原实现给的空回调）。
            if (item.code === "gained")
                return;
            if (item.code === "confirmed" || item.code === "exploited") {
                props.onFilterChange({ ...props.filter, status: item.next });
                return;
            }
            props.onFilterChange({ ...props.filter, severity: item.next });
        })), h("div", { className: "rt-spacer" }), h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, (0, findings_model_js_1.targetSummary)(stats ?? EMPTY_STATS)));
        const toolbar = h("div", { className: "rt-toolbar" }, h("input", {
            className: "rt-input",
            style: { flex: "1 1 140px" },
            placeholder: "搜索标题 / CVE / 目标（回车）",
            value: props.filter.query,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onFilterChange({ ...props.filter, query: value });
            },
            onKeyDown: (event) => {
                if (event.key === "Enter")
                    props.onSubmitQuery();
            },
        }), h("button", { className: "rt-btn", onClick: () => props.onSubmitQuery() }, "搜索"), h("select", {
            className: "rt-input",
            value: props.filter.severity,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onFilterChange({ ...props.filter, severity: value });
            },
        }, findings_model_js_1.SEVERITY_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))), h("select", {
            className: "rt-input",
            value: props.filter.status,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onFilterChange({ ...props.filter, status: value });
            },
        }, findings_model_js_1.STATUS_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))));
        const indexed = (0, findings_model_js_1.indexFilesByVuln)(props.fileGroups);
        const subTabs = h("div", { className: "rt-subtabs" }, ["vulns", "files", "creds", "access"].map((key) => {
            const label = key === "vulns" ? "漏洞" : key === "files" ? "攻击文件" : key === "creds" ? "凭据" : "访问会话";
            const count = key === "vulns"
                ? total
                : key === "files"
                    ? indexed.all.length
                    : key === "creds"
                        ? props.credentials.length
                        : props.accesses.length;
            return h("span", {
                key,
                className: (0, findings_model_js_1.subTabClass)(key, props.subTab),
                role: "button",
                tabIndex: 0,
                "aria-label": (0, findings_model_js_1.subTabAriaLabel)(label, count),
                "aria-expanded": props.subTab === key ? "true" : "false",
                onClick: () => props.onSubTabChange(key),
                onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault?.();
                        props.onSubTabChange(key);
                    }
                },
            }, (0, findings_model_js_1.subTabLabel)(label, count));
        }), h("div", { className: "rt-spacer" }), grouped
            ? h("button", {
                className: "rt-btn",
                title: "展开所有目标",
                onClick: () => props.onSetAllCollapsed(items.map((vuln) => "target:" + targetKeyOfVuln(vuln)), true),
            }, "全部展开")
            : null, grouped
            ? h("button", {
                className: "rt-btn",
                title: "收起所有目标",
                onClick: () => props.onSetAllCollapsed(items.map((vuln) => "target:" + targetKeyOfVuln(vuln)), false),
            }, "全部收起")
            : null, h("button", {
            className: "rt-btn" + (grouped ? " rt-btn-primary" : ""),
            title: grouped ? "当前：按目标聚合（先看哪台被打下什么）" : "当前：平铺每条漏洞",
            onClick: () => props.onToggleGrouped(),
        }, grouped ? "按目标聚合" : "平铺列表"));
        const messageNode = props.message !== null
            ? h("div", { className: props.message.kind === "err" ? "rt-err" : "rt-foot" }, props.message.text)
            : null;
        const restartNode = restartHint ? h("div", { className: "rt-empty" }, findings_model_js_1.RESTART_HINT) : null;
        const errorNode = error !== null && !restartHint ? h("div", { className: "rt-err" }, error) : null;
        const body = props.subTab === "files"
            ? h("div", { className: "rt-body", style: { overflow: "auto" } }, h("div", { className: "rt-hint", style: { marginBottom: 8 } }, (0, findings_model_js_1.attackFilesHint)(indexed.orphans.length)), props.attackFilesNode ?? null)
            : props.subTab === "creds"
                ? h("div", { className: "rt-body", style: { overflow: "auto" } }, credentialsSection(runtime, props))
                : props.subTab === "access"
                    ? h("div", { className: "rt-body", style: { overflow: "auto" } }, accessSection(runtime, props))
                    : vulnsBody(runtime, props, grouped, items, loading, error, indexed.byVuln);
        return h("div", { className: "rt-main" }, toolbar, conclusion, subTabs, messageNode, restartNode, errorNode, body);
    }
    /** 漏洞子页签的正文。 */
    function vulnsBody(runtime, props, grouped, items, loading, error, filesByVuln) {
        const { h } = runtime;
        const head = h("div", { className: "rt-vrow head" }, h("span", null, "等级"), h("span", null, "漏洞 / 编号"), h("span", null, "目标"), h("span", null, "拿到什么"), h("span", null, "状态"), h("span", null, "置信"));
        if (grouped) {
            const groups = (0, findings_model_js_1.groupByTarget)(items);
            const emptyNode = groups.length === 0 && !loading && error === null
                ? h("div", { className: "rt-empty" }, findings_model_js_1.EMPTY_FINDINGS_MESSAGE)
                : null;
            return h("div", { className: "rt-table" }, groups.map((group) => groupNode(runtime, props, group, filesByVuln)), emptyNode);
        }
        const rows = [];
        for (const vuln of items) {
            rows.push(...vulnRowNodes(runtime, props, vuln, false, filesByVuln));
        }
        const emptyNode = !loading && items.length === 0 && error === null
            ? h("div", { className: "rt-empty" }, findings_model_js_1.EMPTY_FINDINGS_MESSAGE)
            : null;
        return h("div", { className: "rt-table" }, head, rows, emptyNode);
    }
    /** 空统计（`findings` 未加载时结论行仍要渲染出一排 0，不能整块消失）。 */
    const EMPTY_STATS = Object.freeze({
        bySeverity: Object.freeze({}),
        byStatus: Object.freeze({}),
        withGained: 0,
        targetGroups: 0,
    });
    /** 取一条漏洞的聚合键（供「全部展开」把键列全）。 */
    function targetKeyOfVuln(vuln) {
        // 复用模型层的判定：分组键必须与 `groupByTarget` 完全一致，
        // 否则「全部展开」会把另一批键设成展开、当前组仍然是折的。
        return (0, findings_model_js_1.targetKeyOf)({ target: vuln.target, asset_ip: vuln.assetIp });
    }
    /** 查询漏洞（过滤条件走服务端，与原实现一致）。 */
    async function loadFindings(api, engagement, filter) {
        return api.raw({
            op: "vulns",
            engagement,
            ...(filter.severity !== "" ? { severity: filter.severity } : {}),
            ...(filter.status !== "" ? { status: filter.status } : {}),
            ...(filter.queryApplied !== "" ? { q: filter.queryApplied } : {}),
            limit: 200,
        });
    }
    /** 读凭据 / 访问会话 / 攻击文件（三个独立请求，任一失败只影响自己）。 */
    async function loadSideLists(api, engagement) {
        const [credResponse, accessResponse, filesResponse] = await Promise.all([
            api.raw({ op: "credentials", engagement }),
            api.raw({ op: "access", engagement }),
            api.raw({ op: "attackFiles", engagement }),
        ]);
        // 三个都走模型层的窄化函数：失败 → 空数组（与原实现的 `(r && r.items) || []` 一致）。
        return {
            credentials: (0, findings_model_js_1.credentialsOf)(credResponse),
            accesses: (0, findings_model_js_1.accessesOf)(accessResponse),
            fileGroups: (0, findings_model_js_1.attackFileGroupsOf)(filesResponse),
        };
    }
    /** 更新一条漏洞的状态。 */
    async function updateVulnStatus(api, engagement, id, status) {
        const response = await api.raw({ op: "updateVuln", engagement, id, patch: { status } });
        if (response.ok === false) {
            return { message: { kind: "err", text: response.error ?? "更新失败" }, ok: false };
        }
        return { message: { kind: "ok", text: (0, findings_model_js_1.statusUpdatedMessage)(status) }, ok: true };
    }
    /** 严重级下拉的当前值（供容器初始化时校验）。 */
    function isSeverity(value) {
        return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info";
    }
    /** 一条证据是否可复制（空请求 + 空响应就没意义）。 */
    function evidenceCopyable(entry) {
        return entry.request !== "" || entry.response !== "";
    }
    /** 漏洞是否缺证据（红线：报告只收录有证据的）。 */
    function vulnLacksEvidence(vuln) {
        return (0, findings_model_js_1.evidenceMissing)(vuln);
    }
});
/**
 * 知识库页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `KnowledgeTab` 的 271 行是全项目**分支最多**的一个页签：
 * 检索表单（6 个字段）、归类分组、知识库条目、nuclei 模板分页、
 * 空态的**五种**不同解读。抽出来后要钉住的是：
 *
 * 1. **归类计数是「知识库 + 本机模板」的和**：`catShown(c) = c.n + tplByCat.get(c.code)`。
 *    只数知识库会让「有 800 个 nuclei 模板但库里 0 条」的归类显示成 0，
 *    用户以为那类武器是空的。
 * 2. **空态有五种解读**，每种给不同行动建议（见 `emptyDiagnosis`）：
 *    有筛选条件 → 换关键字；库空+模板有但没列 → 重启客户端；
 *    模板目录存在但没 yaml → 跑 update-templates；都没有 → 装模板库；
 *    有条目 → 不该走空态。
 * 3. **`tplMatched` 兜底成 `tpl.total`**：老 host 不给 `matched`，
 *    用 total 当 matched 才不会显示 `0–0 / 0`。
 *
 * ## 两个原实现的行为，别改
 *
 * - **首次进入拉全量、检索是显式动作**：原注释写「避免边打字边打接口」。
 *   所以输入框的 `onChange` 只改本地状态，回车/点「检索」才发请求。
 * - **模板分页的 offset 归一**：`Math.max(0, next)` —— 上一页按到底时
 *   不能出现负 offset。
 */
define("redteam/client/knowledge-model", ["require", "exports", "redteam/client/helpers", "redteam/client/label"], function (require, exports, helpers_js_7, label_js_4) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.POC_CATEGORY_OPTIONS = exports.POC_KIND_OPTIONS = exports.UNCATEGORIZED_TITLE = exports.USED_ON_MANUAL = exports.DETAIL_LOADING_MESSAGE = exports.MISSING_CONTENT_MESSAGE = exports.EMPTY_QUERY = exports.KB_ERROR_FALLBACK = exports.NO_MATCH_MESSAGE = exports.LOADING_KB_MESSAGE = exports.KB_FOOTER = exports.STANDARD_ORDER_HINT = exports.OLD_HOST_MESSAGE = exports.EMPTY_KB_MESSAGE = exports.CONTENT_LIMIT = exports.TEMPLATE_PAGE_SIZE = exports.POC_CAT_ORDER_LIST = exports.POC_CAT_NAME = exports.POC_SOURCE_LABEL = exports.POC_KIND_LABEL = void 0;
    exports.countOrZero = countOrZero;
    exports.verifiedOf = verifiedOf;
    exports.pocItemOf = pocItemOf;
    exports.pocDetailOf = pocDetailOf;
    exports.pocStatsOf = pocStatsOf;
    exports.templateRowOf = templateRowOf;
    exports.templatePageOf = templatePageOf;
    exports.knowledgeDataOf = knowledgeDataOf;
    exports.categoryShown = categoryShown;
    exports.templateCategoryMap = templateCategoryMap;
    exports.showsCategory = showsCategory;
    exports.categoryTitle = categoryTitle;
    exports.categoryLabel = categoryLabel;
    exports.groupKey = groupKey;
    exports.groupCountText = groupCountText;
    exports.groupVerifiedText = groupVerifiedText;
    exports.categoryName = categoryName;
    exports.pocKindLabel = pocKindLabel;
    exports.pocSourceLabel = pocSourceLabel;
    exports.itemSubLine = itemSubLine;
    exports.hitCountLabel = hitCountLabel;
    exports.verifiedLabel = verifiedLabel;
    exports.verifiedClass = verifiedClass;
    exports.kindClass = kindClass;
    exports.cardClass = cardClass;
    exports.contentBody = contentBody;
    exports.detailFor = detailFor;
    exports.searchLabel = searchLabel;
    exports.usedMessage = usedMessage;
    exports.templateRangeLabel = templateRangeLabel;
    exports.canPrevPage = canPrevPage;
    exports.canNextPage = canNextPage;
    exports.pageOffset = pageOffset;
    exports.templateCommand = templateCommand;
    exports.templateCategoryLabel = templateCategoryLabel;
    exports.templateSeverity = templateSeverity;
    exports.showsTemplateBlock = showsTemplateBlock;
    exports.groupOrder = groupOrder;
    exports.bucketKeyOf = bucketKeyOf;
    exports.groupRecentLabel = groupRecentLabel;
    exports.groupCount = groupCount;
    exports.groupVerified = groupVerified;
    exports.emptyDiagnosis = emptyDiagnosis;
    exports.emptyTitle = emptyTitle;
    exports.showsDbPath = showsDbPath;
    exports.showsTemplateDir = showsTemplateDir;
    exports.isOldHostError = isOldHostError;
    exports.errorText = errorText;
    exports.statsLabels = statsLabels;
    exports.showsUncategorized = showsUncategorized;
    exports.dbPathLine = dbPathLine;
    exports.templateDirLine = templateDirLine;
    exports.queryParams = queryParams;
    exports.withQueryField = withQueryField;
    exports.toggleCategory = toggleCategory;
    exports.categoryQuery = categoryQuery;
    exports.hasFilters = hasFilters;
    /** POC 类型 → 中文。 */
    exports.POC_KIND_LABEL = Object.freeze({
        poc: "POC",
        exp: "EXP",
        script: "脚本",
        template: "模板",
        payload: "载荷",
    });
    /** 来源 → 中文。 */
    exports.POC_SOURCE_LABEL = Object.freeze({
        web: "互联网",
        self: "手搓",
        manual: "人工",
        "nuclei-template": "nuclei 模板",
        kb: "知识库",
    });
    /** 归类名（与 `label.ts` 共用一张表，避免两份中文对不上）。 */
    exports.POC_CAT_NAME = label_js_4.POC_CATEGORY_LABEL;
    /** 归类顺序（面板按它分组）。 */
    exports.POC_CAT_ORDER_LIST = label_js_4.POC_CAT_ORDER;
    /** 模板每页条数。 */
    exports.TEMPLATE_PAGE_SIZE = 40;
    /** 正文的截断长度（超出提示去看落盘文件）。 */
    exports.CONTENT_LIMIT = 12000;
    /** 空态：知识库还是空的。 */
    exports.EMPTY_KB_MESSAGE = "知识库还是空的";
    /** 老 host 没有知识库接口时的恢复说明。 */
    exports.OLD_HOST_MESSAGE = "知识库接口由 host 侧提供，当前宿主还是旧进程 —— "
        + "请完全退出后重新打开（官方 exe / 社区版 / dsh web 任一），再刷新页面。";
    /** 打 Nday 的标准顺序（空态里的行动建议）。 */
    exports.STANDARD_ORDER_HINT = "打 Nday/1day 的标准顺序：① redteam_poc_search 先查这里"
        + "（顺带搜本机 nuclei 模板库）→ ② 都没有就互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）"
        + "或自己手搓 → ③ 在真实目标上验证有效后 redteam_poc_add 回填，后面的靶标直接就能用。";
    /** 底部说明。 */
    exports.KB_FOOTER = "全局共享（跨靶标）｜ 落盘：pocs/<code>/ ｜ 只收录通用可复用的 POC/EXP，靶标专用脚本走「攻击文件」";
    /** 加载中文案。 */
    exports.LOADING_KB_MESSAGE = "加载中…";
    /** 没命中的提示。 */
    exports.NO_MATCH_MESSAGE = "没有命中：换个关键字再试，或去互联网找 / 自己手搓后回填。";
    /** 检索失败兜底。 */
    exports.KB_ERROR_FALLBACK = "读取失败";
    /** 默认检索条件（空 = 拉全量）。 */
    exports.EMPTY_QUERY = Object.freeze({
        q: "",
        kind: "",
        category: "",
        engagement: "",
        assetTarget: "",
        verifiedOnly: false,
        templateOffset: 0,
    });
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组。 */
    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 读有限数字（非有限 → 0）。 */
    function numberOf(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    /** 读有限数字（非有限 → `null`）。 */
    function numberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 计数字段（非有限 / 负数 → 0）。 */
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /**
     * 归一 `verified` 字段。
     *
     * 原实现判 `x.verified === 1`（SQLite 给整数），但 `true` 也可能出现。
     * 两种都认；其它一律 false。
     */
    function verifiedOf(value) {
        return value === 1 || value === true;
    }
    /** 解析一条知识库条目。 */
    function pocItemOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            code: text(item["code"]),
            title: text(item["title"]),
            kind: text(item["kind"]),
            category: text(item["category"]),
            source: text(item["source"]),
            cve: text(item["cve"]),
            component: text(item["component"]),
            versions: text(item["versions"]),
            language: text(item["language"]),
            tags: text(item["tags"]),
            verified: verifiedOf(item["verified"]),
            hitCount: numberOf(item["hit_count"]) || numberOf(item["hitCount"]),
            createdAt: text(item["created_at"]) || text(item["createdAt"]),
            engagementId: text(item["engagement_id"]) || text(item["engagementId"]),
            engagementName: text(item["engagement_name"]) || text(item["engagementName"]),
            assetTarget: text(item["asset_target"]) || text(item["assetTarget"]),
            foundByAgent: text(item["found_by_agent"]) || text(item["foundByAgent"]),
            sourceUrl: text(item["source_url"]) || text(item["sourceUrl"]),
        };
    }
    /** 解析条目详情。 */
    function pocDetailOf(response) {
        if ((0, helpers_js_7.isFailure)(response))
            return null;
        const body = asRecord(response);
        const id = numberOrNull(body["id"]);
        if (id === null)
            return null;
        return {
            id,
            title: text(body["title"]),
            content: text(body["content"]),
            usage: text(body["usage"]),
            description: text(body["description"]),
            verifiedNote: text(body["verified_note"]) || text(body["verifiedNote"]),
            usedOn: text(body["used_on"]) || text(body["usedOn"]),
            path: text(body["path"]),
            sourceUrl: text(body["source_url"]) || text(body["sourceUrl"]),
        };
    }
    /** 解析统计块。 */
    function pocStatsOf(raw) {
        const item = asRecord(raw);
        return {
            total: numberOf(item["total"]),
            verified: numberOf(item["verified"]),
            reused: numberOf(item["reused"]),
            uncategorized: numberOf(item["uncategorized"]),
            byCategory: asArray(item["byCategory"]).map((entry) => {
                const record = asRecord(entry);
                return {
                    code: text(record["code"]),
                    n: numberOf(record["n"]),
                    verified: numberOf(record["verified"]),
                    hint: text(record["hint"]),
                };
            }).filter((entry) => entry.code !== ""),
            byEngagement: asArray(item["byEngagement"]).map((entry) => {
                const record = asRecord(entry);
                return { engagement: text(record["engagement"]), n: numberOf(record["n"]) };
            }).filter((entry) => entry.engagement !== ""),
        };
    }
    /** 解析一条模板。 */
    function templateRowOf(raw) {
        const item = asRecord(raw);
        const path = text(item["path"]);
        if (path === "")
            return null;
        return {
            path,
            name: text(item["name"]),
            severity: text(item["severity"]),
            category: text(item["category"]),
        };
    }
    /** 解析模板分页块。 */
    function templatePageOf(raw) {
        const item = asRecord(raw);
        const items = asArray(item["items"])
            .map(templateRowOf)
            .filter((entry) => entry !== null);
        const total = numberOf(item["total"]);
        const matchedRaw = numberOrNull(item["matched"]);
        return {
            dir: typeof item["dir"] === "string" ? item["dir"] : null,
            total,
            // 老 host 不给 matched：用 total 兜底，否则页码显示成「0–0 / 0」。
            matched: matchedRaw === null ? total : countOrZero(matchedRaw),
            offset: countOrZero(item["offset"]),
            items,
            byCategory: asArray(item["byCategory"]).map((entry) => {
                const record = asRecord(entry);
                return { code: text(record["code"]), n: numberOf(record["n"]) };
            }).filter((entry) => entry.code !== ""),
        };
    }
    /** 解析 `pocSearch` 响应（失败 → `null`）。 */
    function knowledgeDataOf(response) {
        if ((0, helpers_js_7.isFailure)(response))
            return null;
        const body = asRecord(response);
        return {
            items: asArray(body["items"])
                .map(pocItemOf)
                .filter((entry) => entry !== null),
            stats: pocStatsOf(body["stats"]),
            templates: templatePageOf(body["templates"]),
            dbPath: text(body["dbPath"]) || text(body["db_path"]),
            root: text(body["root"]),
        };
    }
    /**
     * 某归类的显示计数。
     *
     * `知识库条数 + 本机模板条数` —— 只数知识库会让「有 800 个模板但库里 0 条」
     * 的归类显示成 0，用户以为那类武器是空的。
     */
    function categoryShown(category, templateCounts) {
        return category.n + (templateCounts.get(category.code) ?? 0);
    }
    /** 从模板分页块造「归类 → 条数」表。 */
    function templateCategoryMap(templates) {
        const map = new Map();
        for (const entry of templates.byCategory)
            map.set(entry.code, entry.n);
        return map;
    }
    /**
     * 归类条要不要显示。
     *
     * 原实现：`catShown(c) > 0 || POC_CAT_ORDER.includes(c.code)` ——
     * 有内容的归类一定显示；内置归类即使为空也显示（让用户知道「这一类还没有武器」）。
     * 既没内容又不是内置归类 → 藏起来（避免脏数据撑爆横向空间）。
     */
    function showsCategory(category, shown) {
        return shown > 0 || exports.POC_CAT_ORDER_LIST.includes(category.code);
    }
    /** 归类条的 title（悬浮说明）。 */
    function categoryTitle(category, shown, templateCount) {
        return (category.hint !== "" ? category.hint : (exports.POC_CAT_NAME[category.code] ?? category.code))
            + " · 本机模板 " + templateCount
            + " · 知识库 " + category.n
            + (category.verified > 0 ? "（已验证 " + category.verified + "）" : "");
    }
    /** 归类条的显示名（含已验证数）。 */
    function categoryLabel(category) {
        const name = exports.POC_CAT_NAME[category.code] ?? category.code;
        return category.verified > 0 ? name + "（已验证 " + category.verified + "）" : name;
    }
    /** 归类标题块的 key（`g<code>`）。 */
    function groupKey(code) {
        return "g" + code;
    }
    /** 归类标题块的计数文案。 */
    function groupCountText(items) {
        return items.length + " 条";
    }
    /** 归类标题块的已验证文案。 */
    function groupVerifiedText(items) {
        return "已验证 " + items.filter((item) => item.verified).length;
    }
    /** 归类的中文名（未知原样显示）。 */
    function categoryName(code) {
        return exports.POC_CAT_NAME[code] ?? code;
    }
    /** 类型的中文名。 */
    function pocKindLabel(kind) {
        return exports.POC_KIND_LABEL[kind] ?? (kind !== "" ? kind : "POC");
    }
    /** 来源的中文名。 */
    function pocSourceLabel(source) {
        return exports.POC_SOURCE_LABEL[source] ?? (source !== "" ? source : "—");
    }
    /**
     * 条目的来源行（归类 · 版本 · 语言 · 标签 · 时间 · 来源靶标 · 发现资产 · 角色 · 链接）。
     *
     * 一行把「什么时候、在哪个单位的哪台资产上发现的」说清 —— 这是知识库
     * 能被人信任的原因（不是凭空冒出来的一条 POC）。
     */
    function itemSubLine(item) {
        return [
            item.category !== "" ? "归类 " + categoryName(item.category) : null,
            item.versions !== "" ? "影响版本 " + item.versions : null,
            item.language !== "" ? item.language : null,
            item.tags !== "" ? item.tags : null,
            "建立时间 " + (0, helpers_js_7.formatTimestamp)(item.createdAt),
            (item.engagementName !== "" || item.engagementId !== "")
                ? "来源靶标 " + (item.engagementName !== "" ? item.engagementName : item.engagementId)
                : null,
            item.assetTarget !== "" ? "发现资产 " + item.assetTarget : null,
            item.foundByAgent !== ""
                ? "发现角色 " + (0, label_js_4.labelOf)(label_js_4.ROLE_LABEL, item.foundByAgent)
                : null,
            item.sourceUrl !== "" ? "来源 " + item.sourceUrl : null,
        ].filter((part) => part !== null).join(" · ");
    }
    /** 条目的复用标签（`复用 N`；0 次 → `null`）。 */
    function hitCountLabel(item) {
        return item.hitCount !== 0 ? "复用 " + item.hitCount : null;
    }
    /** 验证徽章的文案。 */
    function verifiedLabel(item) {
        return item.verified ? "已验证" : "未验证";
    }
    /** 验证徽章的 className。 */
    function verifiedClass(item) {
        return item.verified ? "rt-tag rt-tag-live" : "rt-tag rt-tag-warn";
    }
    /** 条目头部的类型块 className（`rt-kb-kind k-<kind>`）。 */
    function kindClass(item) {
        return "rt-kb-kind k-" + (item.kind !== "" ? item.kind : "poc");
    }
    /** 卡片容器的 className（展开加 `open`）。 */
    function cardClass(open) {
        return "rt-kb" + (open ? " open" : "");
    }
    /** 详情正文的截断处理（超 12000 字符时加提示）。 */
    function contentBody(content) {
        if (content === "")
            return "";
        return content.length > exports.CONTENT_LIMIT
            ? content.slice(0, exports.CONTENT_LIMIT) + "\n…（已截断，完整内容见落盘文件）"
            : content;
    }
    /** 详情里没有正文时的提示。 */
    exports.MISSING_CONTENT_MESSAGE = "这条只有元数据，没有正文 —— 拿到正文后用 redteam_poc_update 补上";
    /** 详情读取中。 */
    exports.DETAIL_LOADING_MESSAGE = "读取中…";
    /** 详情是否属于当前展开项（防止切到别的条目后还显示上一条）。 */
    function detailFor(detail, openId) {
        if (detail === null || openId === null)
            return null;
        return detail.id === openId ? detail : null;
    }
    /** 检索按钮的文案。 */
    function searchLabel(busy) {
        return busy ? "检索中…" : "刷新";
    }
    /** 「记一次复用」成功的提示。 */
    function usedMessage(title) {
        return "已记一次复用：" + title;
    }
    /** 复用请求的 `used_on` 固定值（原实现硬编码）。 */
    exports.USED_ON_MANUAL = "控制台手动标记";
    /** 模板列表的状态行（`本机 nuclei 模板 · 1–40 / 812`）。 */
    function templateRangeLabel(templates, shown) {
        const start = templates.offset;
        return "本机 nuclei 模板 · " + (start + 1) + "–" + (start + shown) + " / " + templates.matched
            + "（直接 `nuclei -t <模板路径>`）";
    }
    /** 上一页是否可用（`offset <= 0` 时禁用）。 */
    function canPrevPage(busy, offset) {
        return !busy && offset > 0;
    }
    /** 下一页是否可用（已经到底时禁用）。 */
    function canNextPage(busy, offset, shown, matched) {
        return !busy && offset + shown < matched;
    }
    /** 翻页后的 offset（不小于 0）。 */
    function pageOffset(next) {
        return Math.max(0, next);
    }
    /** 模板命令（点击复制的文本）。 */
    function templateCommand(path) {
        return "nuclei -t " + path + " -u <目标>";
    }
    /** 模板行的类别标签（有归类才显示）。 */
    function templateCategoryLabel(template) {
        return template.category !== "" ? categoryName(template.category) : null;
    }
    /** 模板行的严重级（空 → `—`）。 */
    function templateSeverity(template) {
        return template.severity !== "" ? template.severity : "—";
    }
    /** 模板列表为空 + 知识库有内容时，模板块不渲染（`null`）。 */
    function showsTemplateBlock(templates) {
        return templates.items.length > 0;
    }
    /**
     * 分组渲染时的归类顺序。
     *
     * 内置顺序优先，未知归类挂末尾（`POC_CAT_ORDER` 里没有的 code）——
     * 原实现同样在遍历完内置顺序后 `push` 剩余 key。
     */
    function groupOrder(codes) {
        const present = new Set(codes);
        const ordered = exports.POC_CAT_ORDER_LIST.filter((code) => present.has(code));
        for (const code of codes) {
            if (!ordered.includes(code))
                ordered.push(code);
        }
        return ordered;
    }
    /** 一条条目的分组键（内置归类 → 归到自己；未知 → `other`）。 */
    function bucketKeyOf(item) {
        return exports.POC_CAT_NAME[item.category] !== undefined ? item.category : "other";
    }
    /** 分组头部的「最近建立」说明。 */
    function groupRecentLabel(items) {
        const latest = items
            .map((item) => item.createdAt)
            .filter((value) => value !== "")
            .sort()
            .pop();
        return "最近建立 " + (0, helpers_js_7.formatTimestamp)(latest ?? "");
    }
    /** 分组头部的计数。 */
    function groupCount(items) {
        return items.length;
    }
    /** 分组头部的已验证数。 */
    function groupVerified(items) {
        return items.filter((item) => item.verified).length;
    }
    /**
     * 空态诊断：**五种**不同的解读。
     *
     * 原实现是一条嵌套三元链，这就是它最值得被抽出来的原因 ——
     * 六种情况三种文案，埋在一行里没人能确认改动有没有打破分支。
     */
    function emptyDiagnosis(query, templates) {
        const filtered = query.q !== "" || query.kind !== "" || query.verifiedOnly;
        if (filtered)
            return { kind: "no-match" };
        if (templates.total > 0)
            return { kind: "templates-not-listed", total: templates.total };
        if (templates.dir !== null)
            return { kind: "templates-dir-empty", dir: templates.dir };
        return { kind: "no-templates" };
    }
    /** 空态的主文案。 */
    function emptyTitle(diagnosis) {
        switch (diagnosis.kind) {
            case "no-match":
                return exports.NO_MATCH_MESSAGE;
            case "templates-not-listed":
                return "POC/EXP 库还是空的；本机已有 " + diagnosis.total + " 个 nuclei 模板，但这一页没有列出来。请完全退出后重新打开客户端。";
            case "templates-dir-empty":
                return "知识库还是空的（本机模板目录存在但没有 yaml，请跑 nuclei -update-templates）。";
            case "no-templates":
                return "知识库还是空的。本机也还没有 nuclei 模板库 —— 在演练机上跑 setup.sh 或 `nuclei -update-templates`，装好后这里会出现「本机模板 N」。";
            case "none":
                return exports.EMPTY_KB_MESSAGE;
        }
    }
    /** 空态里是否显示「知识库文件」行。 */
    function showsDbPath(data) {
        return data !== null && data.dbPath !== "";
    }
    /** 空态里是否显示「模板目录」行。 */
    function showsTemplateDir(templates) {
        return templates.dir !== null && templates.dir !== "";
    }
    /** 检索失败是否为「宿主太旧」（`engagement required` / `unknown op`）。 */
    function isOldHostError(error) {
        if (error === null)
            return false;
        return /engagement required|unknown op/i.test(error);
    }
    /** 检索失败的显示文案（老宿主给可执行的恢复步骤）。 */
    function errorText(error) {
        if (error === null)
            return "";
        return isOldHostError(error) ? exports.OLD_HOST_MESSAGE : error;
    }
    /** 工具栏的计数项。 */
    function statsLabels(stats, templateTotal) {
        const out = [];
        out.push(stats.total + " 条");
        out.push("已验证 " + stats.verified);
        out.push("累计复用 " + stats.reused);
        if (stats.uncategorized > 0 && stats.uncategorized !== stats.total) {
            out.push("未归类 " + stats.uncategorized);
        }
        if (templateTotal !== 0)
            out.push("本机模板 " + templateTotal);
        return out;
    }
    /** 未归类标签的 title。 */
    exports.UNCATEGORIZED_TITLE = "这些条目还没归类：智能体回填时用 redteam_poc_add 的 category 参数标一下";
    /** 未归类标签是否显示。 */
    function showsUncategorized(stats) {
        return stats.uncategorized > 0 && stats.uncategorized !== stats.total;
    }
    /** 知识库文件行的文案。 */
    function dbPathLine(data) {
        return "知识库：" + data.dbPath + (data.root !== "" ? "（根目录 " + data.root + "）" : "");
    }
    /** 模板目录行的文案。 */
    function templateDirLine(templates) {
        return "模板目录：" + (templates.dir ?? "");
    }
    /**
     * 造检索请求参数。
     *
     * 空值一律不下发（原实现 `q.trim() || undefined`），`verified=false` 也
     * 不下发（区别于「只要未验证」—— 后端没有这个语义）。
     */
    function queryParams(query) {
        const offset = pageOffset(query.templateOffset);
        return {
            ...(query.q.trim() !== "" ? { q: query.q.trim() } : {}),
            ...(query.kind !== "" ? { kind: query.kind } : {}),
            ...(query.category !== "" ? { category: query.category } : {}),
            ...(query.engagement !== "" ? { engagement: query.engagement } : {}),
            ...(query.assetTarget.trim() !== "" ? { asset_target: query.assetTarget.trim() } : {}),
            ...(query.verifiedOnly ? { verified: true } : {}),
            templateOffset: offset,
            templateLimit: exports.TEMPLATE_PAGE_SIZE,
        };
    }
    /** 改一个检索字段（返回新条件，不改原对象）。 */
    function withQueryField(query, key, value) {
        return { ...query, [key]: value };
    }
    /** 点归类条后的新归类（同一条再点 → 清空）。 */
    function toggleCategory(current, code) {
        return current === code ? "" : code;
    }
    /**
     * 归类条点击后的完整请求条件。
     *
     * 原实现是 `setCategory(next); query({ category: next || undefined })` ——
     * 既改本地状态又**立即**发一次带新归类的检索。这里一次算清。
     */
    function categoryQuery(query, code) {
        return { ...query, category: toggleCategory(query.category, code), templateOffset: 0 };
    }
    /** 类型下拉的选项（顺序即 `POC_KIND_LABEL` 的键顺序）。 */
    exports.POC_KIND_OPTIONS = Object.freeze(Object.entries(exports.POC_KIND_LABEL).map(([value, label]) => ({ value, label })));
    /** 归类下拉的选项（含「全部归类」）。 */
    exports.POC_CATEGORY_OPTIONS = Object.freeze([
        { value: "", label: "全部归类" },
        ...exports.POC_CAT_ORDER_LIST.map((code) => ({ value: code, label: exports.POC_CAT_NAME[code] ?? code })),
    ]);
    /** 检索条件是否有筛选（用于空态诊断与「清空筛选」）。 */
    function hasFilters(query) {
        return query.q !== "" || query.kind !== "" || query.category !== "" || query.engagement !== ""
            || query.assetTarget !== "" || query.verifiedOnly;
    }
});
/**
 * 知识库页（`knowledge` 页签）的渲染。
 *
 * 数据与判定全在 `knowledge-model.ts`，这里只排版。
 *
 * ## 版面
 *
 * ```
 * 工具栏：知识库 · POC/EXP ｜ N 条 已验证 N 累计复用 N 本机模板 N ｜ 分组/刷新
 * 归类总览：RCE 12 · 反序列化 3 · 文件上传 0 · …
 * 检索行：搜索框 / 归类 / 来源靶标 / 发现资产 / 类型 / 只看已验证 / 检索
 * 消息 / 错误 / 知识库路径
 * 条目（按归类分组，或平铺）+ 本机 nuclei 模板分页
 * ```
 *
 * ## 两个原实现的细节，这里保留
 *
 * 1. **检索是显式动作**：输入框只改本地状态，回车或点「检索」才发请求。
 *    原注释：避免边打字边打接口。
 * 2. **归类条点一下就是筛选、再点取消**，并且**立即**重发检索 ——
 *    只改状态不重查会让用户以为没有匹配项。
 */
define("redteam/client/knowledge-tab", ["require", "exports", "redteam/client/knowledge-model", "redteam/client/knowledge-model"], function (require, exports, knowledge_model_js_1, knowledge_model_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderKnowledgeTab = renderKnowledgeTab;
    exports.searchPoc = searchPoc;
    exports.loadPocDetail = loadPocDetail;
    exports.usePoc = usePoc;
    exports.knowledgeOf = knowledgeOf;
    exports.failureText = failureText;
    exports.detailFailureText = detailFailureText;
    exports.useSuccessMessage = useSuccessMessage;
    exports.queryAfterCategory = queryAfterCategory;
    exports.detailOf = detailOf;
    /** 一张条目卡。 */
    function cardNode(runtime, props, item) {
        const { h } = runtime;
        const open = props.openId === item.id;
        const detail = (0, knowledge_model_js_1.detailFor)(props.detail, props.openId);
        const hit = (0, knowledge_model_js_1.hitCountLabel)(item);
        return h("div", { key: "p" + item.id, className: (0, knowledge_model_js_1.cardClass)(open) }, h("div", {
            className: "rt-kb-head",
            role: "button",
            tabIndex: 0,
            "aria-expanded": open ? "true" : "false",
            onClick: () => props.onOpen(item.id),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onOpen(item.id);
                }
            },
        }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), h("span", { className: (0, knowledge_model_js_1.kindClass)(item) }, (0, knowledge_model_js_1.pocKindLabel)(item.kind)), h("span", { className: "rt-kb-title" }, item.title), item.cve !== "" ? h("span", { className: "rt-tag rt-tag-passive" }, item.cve) : null, item.component !== "" ? h("span", { className: "rt-tag" }, item.component) : null, h("span", { className: (0, knowledge_model_js_1.verifiedClass)(item) }, (0, knowledge_model_js_1.verifiedLabel)(item)), h("div", { className: "rt-spacer" }), h("span", { className: "rt-tag" }, (0, knowledge_model_js_1.pocSourceLabel)(item.source)), hit !== null ? h("span", { className: "rt-tag" }, hit) : null), h("div", { className: "rt-kb-sub" }, (0, knowledge_model_js_1.itemSubLine)(item)), open
            ? h("div", { className: "rt-kb-body" }, props.detailBusy && detail === null
                ? h("div", { className: "rt-empty" }, knowledge_model_js_1.DETAIL_LOADING_MESSAGE)
                : null, detail !== null
                ? h("div", null, detail.usage !== ""
                    ? h("div", { className: "rt-kv" }, h("b", null, "用法"), h("span", { className: "rt-mono" }, detail.usage))
                    : null, detail.description !== ""
                    ? h("div", { className: "rt-kv" }, h("b", null, "说明"), h("span", null, detail.description))
                    : null, detail.verifiedNote !== ""
                    ? h("div", { className: "rt-kv" }, h("b", null, "验证证据"), h("span", null, detail.verifiedNote))
                    : null, detail.usedOn !== ""
                    ? h("div", { className: "rt-kv" }, h("b", null, "最近使用"), h("span", null, detail.usedOn))
                    : null, detail.path !== ""
                    ? h("div", { className: "rt-kv" }, h("b", null, "落盘"), h("span", { className: "rt-mono" }, detail.path))
                    : null, h("div", { className: "rt-kb-actions" }, h("button", {
                    className: "rt-btn",
                    disabled: detail.content === "",
                    onClick: () => props.onCopy(detail.content, "POC 正文"),
                }, "复制正文"), h("button", {
                    className: "rt-btn",
                    onClick: () => props.onUse(item),
                }, "记一次复用"), detail.sourceUrl !== ""
                    ? h("button", {
                        className: "rt-btn",
                        onClick: () => props.onCopy(detail.sourceUrl, "来源链接"),
                    }, "复制来源")
                    : null), detail.content !== ""
                    ? h("pre", { className: "rt-rep-http" }, (0, knowledge_model_js_1.contentBody)(detail.content))
                    : h("div", { className: "rt-empty" }, knowledge_model_js_1.MISSING_CONTENT_MESSAGE))
                : null)
            : null);
    }
    /** 归类总览条。 */
    function categoryChips(runtime, props, data) {
        const { h } = runtime;
        const templateCounts = (0, knowledge_model_js_1.templateCategoryMap)(data.templates);
        const chips = [];
        for (const category of data.stats.byCategory) {
            const shown = category.n + (templateCounts.get(category.code) ?? 0);
            if (!(0, knowledge_model_js_1.showsCategory)(category, shown))
                continue;
            chips.push(h("span", {
                key: category.code,
                className: "rt-concl-i" + (props.query.category === category.code ? " on" : ""),
                title: (0, knowledge_model_js_1.categoryTitle)(category, shown, templateCounts.get(category.code) ?? 0),
                role: "button",
                tabIndex: 0,
                onClick: () => props.onCategoryChange(category.code),
                onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault?.();
                        props.onCategoryChange(category.code);
                    }
                },
            }, h("b", null, String(shown)), h("span", null, (0, knowledge_model_js_1.categoryLabel)(category))));
        }
        return h("div", { className: "rt-kb-cats" }, chips);
    }
    /** 检索表单。 */
    function filterRow(runtime, props, data) {
        const { h } = runtime;
        const query = props.query;
        return h("div", { className: "rt-kb-filter" }, h("input", {
            className: "rt-input",
            style: { flex: 1, minWidth: 140 },
            placeholder: "搜 CVE / 组件 / 关键字（正文也会搜）",
            value: query.q,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onQueryChange({ ...query, q: value });
            },
            onKeyDown: (event) => {
                if (event.key === "Enter")
                    props.onSubmit();
            },
        }), h("select", {
            className: "rt-input",
            style: { maxWidth: 120 },
            value: query.category,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                // 归类下拉是「改了立即检索」（与原实现一致）。
                props.onCategoryChange(value === "" ? "" : value);
            },
        }, knowledge_model_js_1.POC_CATEGORY_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label))), h("select", {
            className: "rt-input",
            style: { maxWidth: 120 },
            value: query.engagement,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onQueryChange({ ...query, engagement: value });
            },
        }, h("option", { value: "" }, "全部来源靶标"), (data?.stats.byEngagement ?? []).map((entry) => h("option", { key: entry.engagement, value: entry.engagement }, entry.engagement + "（" + entry.n + "）"))), h("input", {
            className: "rt-input",
            style: { width: 120 },
            placeholder: "发现资产筛选",
            value: query.assetTarget,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onQueryChange({ ...query, assetTarget: value });
            },
            onKeyDown: (event) => {
                if (event.key === "Enter")
                    props.onSubmit();
            },
        }), h("select", {
            className: "rt-input",
            style: { maxWidth: 110 },
            value: query.kind,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onQueryChange({ ...query, kind: value });
            },
        }, [
            h("option", { key: "all", value: "" }, "全部类型"),
            ...knowledge_model_js_1.POC_KIND_OPTIONS.map((option) => h("option", { key: option.value, value: option.value }, option.label)),
        ]), h("label", { className: "rt-kb-check" }, h("input", {
            type: "checkbox",
            checked: query.verifiedOnly,
            onChange: (event) => {
                const checked = event.target?.checked === true;
                props.onQueryChange({ ...query, verifiedOnly: checked });
            },
        }), "只看已验证"), h("button", { className: "rt-btn rt-btn-primary", onClick: () => props.onSubmit() }, "检索"));
    }
    /** 本机 nuclei 模板块。 */
    function templateBlock(runtime, props, templates) {
        const { h } = runtime;
        if (!(0, knowledge_model_js_1.showsTemplateBlock)(templates))
            return null;
        const start = templates.offset;
        const shown = templates.items.length;
        return h("div", { className: "rt-kb-tpl" }, h("div", { className: "rt-ap-sub" }, (0, knowledge_model_js_1.templateRangeLabel)(templates, shown)), templates.items.map((template, index) => h("div", { key: "t" + start + "-" + index, className: "rt-kb-tpl-row" }, h("span", { className: "rt-tag" }, (0, knowledge_model_js_1.templateSeverity)(template)), (0, knowledge_model_js_1.templateCategoryLabel)(template) !== null
            ? h("span", { className: "rt-tag" }, (0, knowledge_model_js_1.templateCategoryLabel)(template))
            : null, h("span", { className: "rt-mono rt-kb-tpl-path", title: template.path }, template.path), h("span", { className: "rt-kb-tpl-name", title: template.name }, template.name), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 10.5 },
            onClick: () => props.onCopy((0, knowledge_model_js_1.templateCommand)(template.path), "模板命令"),
        }, "复制命令"))), h("div", { className: "rt-kb-actions" }, h("button", {
            className: "rt-btn",
            disabled: !(0, knowledge_model_js_1.canPrevPage)(props.busy, start),
            onClick: () => props.onPage((0, knowledge_model_js_1.pageOffset)(start - knowledge_model_js_2.TEMPLATE_PAGE_SIZE)),
        }, "上一页"), h("button", {
            className: "rt-btn",
            disabled: !(0, knowledge_model_js_1.canNextPage)(props.busy, start, shown, templates.matched),
            onClick: () => props.onPage((0, knowledge_model_js_1.pageOffset)(start + knowledge_model_js_2.TEMPLATE_PAGE_SIZE)),
        }, "下一页")), (0, knowledge_model_js_1.showsTemplateDir)(templates)
            ? h("div", { className: "rt-foot" }, h("span", null, (0, knowledge_model_js_1.templateDirLine)(templates)))
            : null);
    }
    /** 空态（含五种诊断）。 */
    function emptyNode(runtime, props, data) {
        const { h } = runtime;
        if (data === null) {
            // 还没读回来：不诊断（否则首次进入会闪一下「知识库还是空的」）。
            return props.error === null ? h("div", { className: "rt-empty" }, knowledge_model_js_1.LOADING_KB_MESSAGE) : null;
        }
        const templates = data.templates;
        if (data.items.length > 0 || templates.items.length > 0)
            return null;
        const diagnosis = (0, knowledge_model_js_1.emptyDiagnosis)(props.query, templates);
        return h("div", { className: "rt-empty" }, h("div", null, (0, knowledge_model_js_1.emptyTitle)(diagnosis)), h("div", { style: { marginTop: 6, fontSize: 12 } }, knowledge_model_js_1.STANDARD_ORDER_HINT), (0, knowledge_model_js_1.showsDbPath)(data)
            ? h("div", { className: "rt-mono", style: { marginTop: 6, fontSize: 11 } }, "知识库文件：" + data.dbPath)
            : null, (0, knowledge_model_js_1.showsTemplateDir)(templates)
            ? h("div", { className: "rt-mono", style: { marginTop: 6, fontSize: 11 } }, "模板目录：" + templates.dir)
            : null);
    }
    /**
     * 渲染知识库页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderKnowledgeTab(runtime, props) {
        const { h } = runtime;
        const data = props.data;
        const items = data?.items ?? [];
        const stats = data?.stats ?? null;
        const templates = data?.templates ?? null;
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "知识库 · POC / EXP"), stats !== null
            ? (0, knowledge_model_js_1.statsLabels)(stats, templates?.total ?? 0).map((label) => h("span", { key: label, className: "rt-tag" }, label))
            : null, stats !== null && (0, knowledge_model_js_1.showsUncategorized)(stats)
            ? h("span", { className: "rt-tag rt-tag-warn", title: knowledge_model_js_1.UNCATEGORIZED_TITLE }, "未归类 " + stats.uncategorized)
            : null, h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn" + (props.grouped ? " rt-btn-primary" : ""),
            title: "按归类分组显示 / 平铺显示",
            onClick: () => props.onToggleGrouped(),
        }, props.grouped ? "按归类分组" : "平铺显示"), h("button", {
            className: "rt-btn",
            disabled: props.busy,
            onClick: () => props.onSubmit(),
        }, (0, knowledge_model_js_1.searchLabel)(props.busy)));
        const messageNode = props.message !== null
            ? h("div", { className: props.message.kind === "err" ? "rt-err" : "rt-foot" }, props.message.text)
            : null;
        const errorNode = props.error !== null
            ? h("div", { className: "rt-err" }, (0, knowledge_model_js_1.errorText)(props.error))
            : null;
        const dbNode = props.error === null && data !== null && data.dbPath !== ""
            ? h("div", { className: "rt-foot", style: { marginBottom: 6, fontSize: 11 } }, (0, knowledge_model_js_1.dbPathLine)(data))
            : null;
        const listBody = [];
        if (props.grouped) {
            const buckets = new Map();
            for (const item of items) {
                const code = (0, knowledge_model_js_1.bucketKeyOf)(item);
                const bucket = buckets.get(code);
                if (bucket === undefined)
                    buckets.set(code, [item]);
                else
                    bucket.push(item);
            }
            const order = (0, knowledge_model_js_1.groupOrder)([...buckets.keys()]);
            for (const code of order) {
                const list = buckets.get(code) ?? [];
                listBody.push(h("div", { key: "g" + code, className: "rt-kb-cat" }, h("span", { className: "rt-kb-cat-name" }, (0, knowledge_model_js_1.categoryName)(code)), h("span", { className: "rt-tag" }, (0, knowledge_model_js_1.groupCount)(list) + " 条"), h("span", { className: "rt-tag rt-tag-live" }, "已验证 " + (0, knowledge_model_js_1.groupVerified)(list)), h("span", { className: "rt-spacer" }), h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, (0, knowledge_model_js_1.groupRecentLabel)(list))));
                for (const item of list)
                    listBody.push(cardNode(runtime, props, item));
            }
        }
        else {
            for (const item of items)
                listBody.push(cardNode(runtime, props, item));
        }
        return h("div", { className: "rt-main" }, toolbar, data !== null ? categoryChips(runtime, props, data) : null, filterRow(runtime, props, data), messageNode, errorNode, dbNode, h("div", { className: "rt-table" }, listBody, templates !== null ? templateBlock(runtime, props, templates) : null, emptyNode(runtime, props, data)), h("div", { className: "rt-foot" }, h("span", null, "全局共享（跨靶标）｜ 落盘：pocs/<code>/ ｜ 只收录通用可复用的 POC/EXP，靶标专用脚本走「攻击文件」")));
    }
    /** 检索。 */
    async function searchPoc(api, query) {
        return api.raw({ op: "pocSearch", ...(0, knowledge_model_js_1.queryParams)(query) });
    }
    /** 读详情。 */
    async function loadPocDetail(api, id) {
        return api.raw({ op: "pocGet", id });
    }
    /** 记一次复用。 */
    async function usePoc(api, id) {
        return api.raw({ op: "pocUse", id, used_on: knowledge_model_js_1.USED_ON_MANUAL });
    }
    /** 从检索响应解析（失败 → `null`，错误由容器单独保存）。 */
    function knowledgeOf(response) {
        return (0, knowledge_model_js_1.knowledgeDataOf)(response);
    }
    /** 检索错误文案。 */
    function failureText(response) {
        if (response.ok === false)
            return response.error ?? "读取失败";
        return null;
    }
    /** 详情错误文案。 */
    function detailFailureText(response) {
        if (response.ok === false)
            return response.error ?? "读取失败";
        return null;
    }
    /** 复用成功的消息。 */
    function useSuccessMessage(item) {
        return { kind: "ok", text: (0, knowledge_model_js_1.usedMessage)(item.title) };
    }
    /** 点归类条后应使用的新检索条件。 */
    function queryAfterCategory(query, code) {
        return (0, knowledge_model_js_1.categoryQuery)(query, code);
    }
    /** 详情解析（供容器直接用）。 */
    function detailOf(response) {
        return (0, knowledge_model_js_1.pocDetailOf)(response);
    }
});
define("redteam/client/styles", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DEFAULT_STYLE_KEY = exports.STYLE_ATTR = exports.THEME = exports.CSS = exports.TOKEN_WHITELIST = exports.THEME_TOKENS = exports.UPSTREAM_TOKENS = void 0;
    exports.installStyles = installStyles;
    /**
     * 演练台样式层：上游样式表（逐字节保真）+ 战术主题叠加层。
     *
     * ## 这个文件为什么是「两块」而不是「一块改好的样式表」
     *
     * 上游 `dsh-qilin/client.js` 里有一整套演练台样式表（539 行 / 45,782 字节 /
     * 422 条规则），它是这个控制台**唯一**的视觉定义 —— 布局、密度、状态色、
     * 表格列宽全在里面。TypeScript 重写时逻辑迁过来了、样式没迁，所以有一段时间
     * 控制台是「有结构、无外观」的。
     *
     * 补的时候有两条路：
     *
     * 1. 边迁边改：直接把新视觉写进那 422 条规则里。
     * 2. 原样保真 + 叠加：`CSS` 一个字节不动，`THEME` 单独一层覆盖。
     *
     * 选 2。理由：
     *
     * - 上游样式表是**对照测试的依据** —— 把它改了，「行为等价」就无从验证。
     *   以后做 drift 检测（上游又改了样式、我们没跟上）也要靠它逐字比对。
     * - 新视觉是**演进的**，会反复调。叠加层改动只需 diff `THEME`，
     *   不会把上游 422 条规则搅成一片红绿，review 也就看得清。
     * - 层叠顺序天然正确：`CSS` 先注入、`THEME` 后注入，后者赢。
     *   叠加层因此**只叠加、不改写** —— 它不复制任何上游规则，只覆盖需要变的属性。
     *
     * ## 为什么可以安全内联进 `String.raw`
     *
     * 提取时就校验过 `CSS` 的内容：**0 个反引号、0 个 ${、0 个反斜杠**。
     * 三者任一出现都会让模板字符串截断或转义走样（TS 照样编译通过，只是样式
     * 少了半截 —— 这种 bug 肉眼极难发现）。所以这不是「运气好」，是前提，
     * 而且由 `test/ui/styles.test.ts` 逐条断言锁住：将来上游样式里混进反引号，
     * 测试会先红，而不是运行时静默少样式。
     *
     * `THEME` 由我们手写，同样遵守这三条，于是两个常量可以分别内联，
     * 不需要任何转义。
     */
    /** 上游 `CSS` 段实际引用到的宿主令牌（9 个，按出现频次排列）。 */
    exports.UPSTREAM_TOKENS = Object.freeze([
        "--dsw-alias-label-secondary",
        "--dsw-alias-border-l1",
        "--dsw-alias-bg-layer-2",
        "--dsw-alias-brand-primary",
        "--dsw-alias-bg-layer-1",
        "--dsw-alias-label-primary",
        "--dsw-alias-bg-base",
        "--dsw-alias-border-l2",
        "--dsw-alias-state-error-primary",
    ]);
    /**
     * `THEME` 允许引用的宿主令牌全集 = 上游那 9 个 + 官方确实存在的扩展档。
     *
     * 为什么要有白名单：`var(--dsw-xxx)` 拼错**不会报错**，只会静默失效
     * （整条声明被丢弃）。这类错误在浏览器里表现为「某个样式没生效」，
     * 归因成本极高。所以把允许的名字写成常量，测试用集合断言把不在名单里的
     * 名字打出来 —— 拼错当场红。
     *
     * 名单逐条核对过宿主 `dsh-client-ui-theme`：`alias-bg-layer-3/4`、
     * `alias-bg-overlay`、`alias-label-tertiary`、`alias-border-l3/l4`、
     * `alias-state-warn/success-primary`、`radius-sm/md/lg`、`elevation-soft`、
     * 以及 `--dsw-static-*` 色阶（本文件只用到 amber-400/600、blue-300/500）。
     */
    exports.THEME_TOKENS = Object.freeze([
        // 上游已在用的 9 个
        ...exports.UPSTREAM_TOKENS,
        // 层级 / 描边 / 文本：深色下靠底色阶与细线分层，不堆阴影
        "--dsw-alias-bg-layer-3",
        "--dsw-alias-bg-layer-4",
        "--dsw-alias-bg-overlay",
        "--dsw-alias-label-tertiary",
        "--dsw-alias-border-l3",
        "--dsw-alias-border-l4",
        // 语义状态：严重度的 fg 全部从这里派生，不自己发明红色
        "--dsw-alias-state-warn-primary",
        "--dsw-alias-state-success-primary",
        // 圆角与浮层阴影：宿主已按主题算好，直接跟随
        "--dsw-radius-sm",
        "--dsw-radius-md",
        "--dsw-radius-lg",
        "--dsw-elevation-soft",
        // 静态色阶：只用于「muted 档需要独立色相」的两处（amber=medium、blue=low）
        "--dsw-static-amber-400",
        "--dsw-static-amber-600",
        "--dsw-static-blue-300",
        "--dsw-static-blue-500",
    ]);
    /**
     * 令牌白名单（测试用）= `THEME_TOKENS` 的集合形态。
     *
     * 单独导出这个名字，是为了让断言读起来是「引用集 ⊆ 白名单」，
     * 而不是「引用集 ⊆ THEME_TOKENS」—— 后者容易被误读成「THEME 里出现过的」。
     */
    exports.TOKEN_WHITELIST = new Set(exports.THEME_TOKENS);
    /**
     * 上游演练台样式表 —— **逐字节保真，不要格式化、不要「顺手改好」**。
     *
     * 来源：`dsh-qilin/client.js` 中演练台样式表的整块内容，
     * 起于 `.rt-dock{…}`，止于 `.rt-shot-zoom-cap{…}`。
     * 539 行 / 45,782 字节 / 422 条规则。
     *
     * 开头那个换行是**内容的一部分**（上游原文以换行开头），不是排版。
     * 若编辑器或格式化工具把它删了，行数与字节数都会变，对照测试会红
     * —— 这就是「保真」的可执行含义。
     */
    exports.CSS = String.raw `
.rt-dock{position:fixed;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;box-sizing:border-box;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#1c1c1c) 52%,transparent);
  backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 70%,transparent);
  border-radius:12px;
  box-shadow:0 18px 48px color-mix(in srgb,#000 28%,transparent);pointer-events:auto;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.5}
.rt-dock.rt-embedded{position:relative;inset:auto;width:100%;height:100%;max-width:none;border:0;border-radius:0;box-shadow:none;background:transparent!important;backdrop-filter:none;-webkit-backdrop-filter:none}
.rt-grip,.rt-resize-r,.rt-resize-b,.rt-resize-c{position:absolute;z-index:3;touch-action:none}
.rt-grip{left:-3px;top:0;bottom:0;width:8px;cursor:ew-resize;background:transparent}
.rt-resize-r{right:-3px;top:0;bottom:14px;width:8px;cursor:ew-resize}
.rt-resize-b{left:8px;right:14px;bottom:-3px;height:8px;cursor:ns-resize}
.rt-resize-c{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.rt-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-title{font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.rt-spacer{flex:1}
.rt-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;
  border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.rt-btn:hover{border-color:var(--dsw-alias-border-l2)}
.rt-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.rt-btn-primary:hover{opacity:.9}
.rt-btn:disabled{opacity:.5;cursor:default}
.rt-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-tab{padding:8px 10px 7px;border-radius:0;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;gap:5px;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent}
.rt-tab:hover{color:var(--dsw-alias-label-primary)}
.rt-tab.on{color:var(--dsw-alias-label-primary);background:transparent;font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary,#6dbf8c)}
/* 未读红点：该页签有新内容（新资产/新漏洞/新得分/新步骤…），点开看过就消失 */
.rt-tab-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none;
  box-shadow:0 0 0 2px color-mix(in srgb, #ef4444 22%, transparent)}
.rt-body{flex:1;min-height:0;display:flex;flex-direction:column}
.rt-split{flex:1;min-height:0;display:flex}
.rt-side{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.rt-seg{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-seg:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-seg.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-seg-cidr{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.rt-seg-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-toolbar{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;align-items:center}
.rt-input{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:inherit;
  border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;outline:none;min-width:0}
.rt-input:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-input option,.rt-eng-select option{background:var(--dsw-alias-bg-layer-1,#1c1c1c);color:var(--dsw-alias-label-primary,#f2f2f2)}
.rt-eng-select{color:var(--dsw-alias-label-primary,#f2f2f2);background:var(--dsw-alias-bg-layer-2,#2a2a2a)}
.rt-table{flex:1;overflow:auto}
.rt-row{display:grid;grid-template-columns:150px 74px 104px 1.15fr 1fr;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;cursor:pointer;font-size:12.5px}
.rt-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;position:sticky;top:0;
  background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-mono{font-family:ui-monospace,Menlo,monospace}
.rt-tag{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;margin-right:4px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-tag-passive{color:#8b5cf6;border-color:#8b5cf655;background:#8b5cf61a}
.rt-tag-active{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-tag-live{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-tag-warn{color:#ef4444;border-color:#ef444455;background:#ef44441a}
/* 纪律提示条：不满足交付要求（非冰蝎/哥斯拉马、没有 suo5 隧道）时顶在区块最上方 */
.rt-hint{border-radius:6px;padding:7px 9px;margin-bottom:8px;font-size:11.5px;line-height:1.6;
  border:1px dashed #ef444488;background:#ef44440f;color:var(--dsw-alias-label-primary)}
.rt-hint b{color:#ef4444}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}
.rt-expand{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-kv{display:flex;gap:8px;margin-bottom:3px;align-items:baseline}
.rt-kv b{color:var(--dsw-alias-label-primary);font-weight:600;min-width:64px;flex:none}
/* 图谱视图已移除（见 AssetsTab：资产关系由「域名维度」与 redteam_attack_path 工具承担） */
.rt-pane{flex:1;min-height:0;overflow:auto;padding:12px}
.rt-card{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,#444) 75%,transparent);border-radius:8px;padding:10px;margin-bottom:10px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#2a2a2a) 48%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.rt-card h4{margin:0 0 6px;font-size:13px}
.rt-textarea{width:100%;min-height:260px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);
  color:inherit;border-radius:6px;padding:8px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;
  line-height:1.6;resize:vertical;outline:none;box-sizing:border-box}
.rt-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.rt-list{width:210px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:8px}
.rt-item{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
.rt-item:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-item.on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.rt-item-name{font-weight:600;font-size:12.5px}
.rt-item-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rt-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.rt-foot{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;
  color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.rt-icon-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:12.5px}
.rt-icon-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-icon-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-hbtn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;border-radius:6px;
  padding:2px 8px;font-size:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px}
.rt-hbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-hbtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.rt-test{display:inline-block;padding:0 5px;border-radius:4px;font-size:11px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-test-testing{color:#f59e0b;border-color:#f59e0b55;background:#f59e0b1a}
.rt-test-tested{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-test-blocked{color:#fff;background:#ef4444;border-color:#ef4444}
.rt-test-abandoned{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
.rt-test-no_surface{color:#6366f1;border-color:#6366f155;background:#6366f11a}
.rt-scope-testing{color:#5b21b6;background:#ddd6fe}
.rt-pri{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;white-space:nowrap}
.rt-pri-high{color:#fff;background:#ef4444}
.rt-pri-medium{color:#fff;background:#f59e0b}
.rt-pri-low{color:#fff;background:#94a3b8}
.rt-score-row{display:grid;grid-template-columns:16px 62px minmax(0,1fr) 116px 66px;gap:8px;padding:7px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-score-row:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-score-row.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-score-detail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
/* 得分目标按合并版的 8 个类别分组：类别头 + 组内按分值升序 */
.rt-score-group{display:flex;align-items:center;gap:8px;padding:7px 10px 5px;margin-top:2px;
  font-size:12px;font-weight:600;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.rt-score-group:first-child{border-top:none}
.rt-score-group .rt-sg-sub{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* ── 会话与入口：每张卡片分「标题行 / 关键事实 / 可用命令 / 备注」四段，避免一行糊在一起 ── */
.rt-sess-facts{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.rt-sess-fact{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.rt-sess-fact>b{flex:none;min-width:62px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-sess-fact>span{min-width:0;overflow-wrap:anywhere}
.rt-sess-cmd{margin-top:6px}
.rt-sess-cmd>b{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:3px;font-weight:600}
.rt-sess-fold{margin-top:6px;font-size:11.5px}
.rt-sess-fold>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.rt-sess-fold>summary:hover{color:var(--dsw-alias-label-primary)}
.rt-score-row .rt-scope{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-score-form{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px}
.rt-score-form input,.rt-score-form select{width:100%;box-sizing:border-box}
.rt-vrow{display:grid;grid-template-columns:62px minmax(0,1fr) 132px 108px 74px 52px;gap:8px;padding:6px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center;font-size:12.5px;cursor:pointer}
.rt-vrow:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-vrow.head{cursor:default;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;
  position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.rt-vdetail{grid-column:1/-1;padding:8px 4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-vdetail .rt-kv{margin-bottom:4px}
.rt-actions{display:flex;gap:6px;margin-top:6px}
.rt-section{padding:8px 10px 2px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.rt-link{color:var(--dsw-alias-brand-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-link:hover{text-decoration:underline}
.rt-full{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;
  border-top:3px solid var(--dsw-alias-brand-primary)}
.rt-full .rt-head{padding:12px 18px}
.rt-full .rt-tabs{padding:10px 18px 0;gap:6px;flex-wrap:wrap}
.rt-full .rt-side{width:260px}
.rt-full .rt-list{width:280px}
.rt-full .rt-row{grid-template-columns:190px 90px 130px 1.4fr 1.2fr}
.rt-full .rt-vrow{grid-template-columns:80px minmax(0,1.6fr) 200px 150px 90px 64px}
.rt-full .rt-pane{padding:18px}
.rt-full .rt-textarea{min-height:60vh}
.rt-full .rt-foot{padding:10px 18px;font-size:12px}
.rt-full .rt-body{max-width:1400px;width:100%;margin:0 auto;flex:1;min-height:0;display:flex;flex-direction:column}
.rt-chain{flex:1;overflow:auto;padding:10px 12px}
.rt-step{display:flex;gap:10px;padding:8px 6px;border-left:2px solid var(--dsw-alias-border-l1);margin-left:6px}
.rt-step:last-child{border-left-color:transparent}
.rt-step-dot{width:22px;height:22px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:#fff;background:#64748b;margin-left:-13px}
.rt-step-body{min-width:0}
.rt-step-title{font-weight:600;font-size:13px}
.rt-step-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;word-break:break-word}
.rt-stage-recon{background:#6366f1}
.rt-stage-vuln{background:#f59e0b}
.rt-stage-exploit{background:#ef4444}
.rt-stage-access{background:#10b981}
.rt-stage-pivot{background:#8b5cf6}
.rt-stage-data{background:#0ea5e9}
.rt-stage-other{background:#64748b}
.rt-step-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.rt-step-time{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;white-space:nowrap}
.rt-step-detail{font-size:12px;margin-top:5px;white-space:pre-wrap;word-break:break-word;
  border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 9px;line-height:1.6}
.rt-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);margin:4px 5px 0 0;max-width:100%}
.rt-chip>i{font-style:normal;color:var(--dsw-alias-label-secondary);font-size:10.5px}
.rt-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}
.rt-stage-tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;color:#fff;font-weight:600}
.rt-st-recon{background:#6366f1}.rt-st-vuln{background:#f59e0b}.rt-st-exploit{background:#ef4444}
.rt-st-access{background:#10b981}.rt-st-pivot{background:#8b5cf6}.rt-st-data{background:#0ea5e9}.rt-st-other{background:#64748b}
.rt-sev{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid transparent}
.rt-sev-critical{color:#fff;background:#b91c1c}.rt-sev-high{color:#fff;background:#ef4444}
.rt-sev-medium{color:#7c2d12;background:#fdba74}.rt-sev-low{color:#1e3a8a;background:#bfdbfe}
.rt-sev-info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.rt-dot-on{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 3px #10b98133}
.rt-dot-off{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444433}
.rt-dot-unk{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;box-shadow:0 0 0 3px #94a3b833}
.rt-sess-grid{display:grid;grid-template-columns:1fr;gap:8px;padding:10px 12px}
.rt-sess{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px 10px;background:var(--dsw-alias-bg-layer-2)}
.rt-sess-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-sess-title{font-weight:600;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
.rt-sess-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 5px;cursor:pointer;word-break:break-all}
.rt-code:hover{border-color:var(--dsw-alias-brand-primary)}
.rt-evi{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin-top:8px}
.rt-evi-head{display:flex;align-items:center;gap:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-2);
  font-size:11.5px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-evi-body{margin:0;padding:9px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-base)}
.rt-evi-body.req{max-height:220px}
.rt-hl-req{color:#10b981;font-weight:600}
.rt-hl-res{color:#0ea5e9;font-weight:600}
.rt-gain{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:12px;
  color:#065f46;background:#a7f3d0;border:1px solid #10b98155}
.rt-total{font-size:20px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.rt-sidehead{padding:7px 8px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:5px}
.rt-sidehead-btn{cursor:pointer;outline:none;padding:6px 6px 5px;border-radius:5px;user-select:none}
.rt-sidehead-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-sidehead-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-scope{display:inline-block;padding:0 4px;border-radius:3px;font-size:10px;font-weight:700;line-height:15px;flex:none}
.rt-scope-internal{color:#0e7490;background:#a5f3fc}
.rt-scope-external{color:#9a3412;background:#fed7aa}
.rt-hits{display:flex;flex-direction:column;gap:6px;margin-top:7px}
.rt-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 9px;background:var(--dsw-alias-bg-layer-2)}
.rt-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-hit-idx{width:16px;height:16px;border-radius:50%;background:#10b981;color:#fff;font-size:10.5px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-hit-target{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12px;word-break:break-all}
.rt-hit-time{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-hit-evi{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:6px 8px;margin-top:5px}
.rt-hit-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.rt-cred{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b;border-radius:6px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:7px}
.rt-cred-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-cred-host{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-secret{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:#fef3c7;color:#78350f;
  border:1px solid #f59e0b66;border-radius:5px;padding:6px 9px;margin-top:6px;white-space:pre-wrap;word-break:break-all;
  user-select:all;cursor:text}
.rt-secret-none{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-state-error-primary);
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 9px;margin-top:6px}
.rt-cred-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:5px;word-break:break-word}
.rt-stage-score{background:#10b981}
.rt-counted{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;border-radius:9px;padding:0 7px}
.rt-scorepts{font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;border:1px solid #10b98155;
  border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-livebar{display:flex;align-items:center;gap:7px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-live-dot{width:8px;height:8px;border-radius:50%;background:#10b981;flex:none;animation:rt-pulse 1.6s ease-in-out infinite}
.rt-live-dot.idle{background:#94a3b8;animation:none}
@keyframes rt-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 #10b98166}50%{opacity:.5;box-shadow:0 0 0 5px #10b98100}}
.rt-live-body{padding:8px 12px 2px;max-height:44vh;overflow:auto}
.rt-atest{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:7px 10px;background:var(--dsw-alias-bg-layer-2);margin-bottom:6px}
.rt-atest.past{border-left-color:#94a3b8;opacity:.85}
.rt-atest-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-atest-ip{font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:12.5px;word-break:break-all}
.rt-atest-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:3px;word-break:break-word}
.rt-atest-notes{font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:4px;padding:5px 7px;margin-top:4px;max-height:76px;overflow:auto}
.rt-concl{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);flex-wrap:wrap}
.rt-concl-i{display:inline-flex;align-items:baseline;gap:4px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid transparent}
.rt-concl-i:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.rt-concl-i b{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700}
.rt-concl-i>span{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.rt-more{color:var(--dsw-alias-brand-primary);font-size:11.5px;cursor:pointer;user-select:none;margin-top:4px;display:inline-block}
.rt-more:hover{text-decoration:underline}
.rt-subtabs{display:flex;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:center}
.rt-subtab{padding:4px 10px;border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rt-subtab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600}
.rt-sevbar{width:3px;border-radius:2px;align-self:stretch;flex:none;margin-right:2px}
/* ── 折叠层次体系 ─────────────────────────────────────────────────────────────
   L1 折叠头 .rt-sec   ：通栏、无圆角无边框、左色条、深底 —— 永远是"扁"的
   L2 内容卡 .rt-atest/.rt-hit/.rt-cred/.rt-evi：内缩、有边框、圆角 —— 立起来
   L3 详情/长文本 .rt-clip-body / .rt-evi-body ：无边框、最浅、等宽
   L4 子项容器 .rt-sec-body：左缩进 + 竖引导线，表明"属于上面那个头"
   ──────────────────────────────────────────────────────────────────────────── */
.rt-sec-wrap{margin:0}
.rt-sec{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-border-l2);
  border-top:1px solid var(--dsw-alias-border-l1);user-select:none;outline:none}
.rt-sec:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-sec:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-sec.flat{cursor:default}
.rt-sec.flat:hover{background:var(--dsw-alias-bg-layer-2)}
.rt-sec-caret{flex:none;width:11px;font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.rt-sec-title{font-weight:600;font-size:13px;white-space:nowrap}
.rt-sec-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-sec-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-sec-right{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.rt-sec.t-stage{border-left-color:#8b5cf6}
.rt-sec.t-target{border-left-color:#0ea5e9}
.rt-sec.t-folder{border-left-color:#64748b}
.rt-sec.t-test{border-left-color:#10b981}
.rt-sec.t-queue{border-left-color:#f59e0b}
.rt-sec.t-past{border-left-color:#94a3b8}
.rt-sec-body{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1);padding:7px 0 3px 10px}
.rt-sec-body>.rt-atest:last-child,.rt-sec-body>.rt-hit:last-child{margin-bottom:2px}
/* 长文本折叠（L3）：默认预览 2 行并渐隐，展开后限高滚动 */
.rt-clip{margin-top:6px}
.rt-clip-head{display:flex;align-items:center;gap:6px}
.rt-clip-label{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600}
.rt-clip-body{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-base);border-radius:5px;padding:6px 8px;margin-top:3px}
.rt-clip:not(.open) .rt-clip-body{max-height:46px;overflow:hidden;
  -webkit-mask-image:linear-gradient(180deg,#000 55%,transparent);mask-image:linear-gradient(180deg,#000 55%,transparent)}
.rt-clip.open .rt-clip-body{max-height:340px;overflow:auto}
.rt-flow{padding:10px 12px 16px}
.rt-flow-start,.rt-flow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 0}
.rt-flow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-flow-link{display:flex;align-items:center;gap:8px;padding:3px 0 3px 10px}
.rt-flow-arrow{color:var(--dsw-alias-border-l2);font-size:11px;flex:none}
.rt-flow-action{font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-action.inferred{opacity:.7;font-style:italic}
.rt-flow-node{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:8px 11px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-flow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-flow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-flow-node.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-flow-idx{width:18px;height:18px;border-radius:50%;background:#10b981;color:#fff;font-size:11px;font-weight:700;
  display:inline-flex;align-items:center;justify-content:center;flex:none}
.rt-flow-node.overflow .rt-flow-idx{background:#94a3b8}
.rt-flow-name{font-weight:600;font-size:13px}
.rt-flow-pts{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;font-weight:700;color:#065f46;
  background:#a7f3d0;border:1px solid #10b98155;border-radius:10px;padding:0 8px;white-space:nowrap}
.rt-flow-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-flow-times{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-flow-target{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;margin-top:4px;word-break:break-all;
  color:var(--dsw-alias-label-secondary)}
.rt-flow-gain{font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-flow-detail{margin-top:7px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-hflow-wrap{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.rt-hflow{display:flex;align-items:center;gap:0;padding:16px 12px;overflow-x:auto;flex-wrap:nowrap}
.rt-hflow-item{display:flex;align-items:center;flex:none}
.rt-hflow-start,.rt-hflow-end{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.rt-hflow-end{font-weight:600;color:var(--dsw-alias-label-primary)}
.rt-hflow-arrow{color:var(--dsw-alias-border-l2);padding:0 5px;font-size:13px;flex:none}
.rt-hflow-node{display:flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);
  border-left:3px solid #10b981;border-radius:7px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);
  cursor:pointer;white-space:nowrap;outline:none}
.rt-hflow-node:hover{border-color:var(--dsw-alias-border-l2)}
.rt-hflow-node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-hflow-node.overflow{border-left-color:#94a3b8;opacity:.72}
.rt-hflow-node.open{border-color:var(--dsw-alias-brand-primary)}
.rt-hflow-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:8px;padding:0 6px}
.rt-hflow-node.overflow .rt-hflow-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.rt-hflow-name{font-size:11.5px}
.rt-hflow-n{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.rt-rep-list{padding:10px 12px 14px}
.rt-rep-tools{display:flex;gap:6px;justify-content:flex-end;margin-bottom:8px}
.rt-rep{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:8px;
  padding:9px 11px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-2)}
.rt-rep-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rt-rep-idx{font-size:15px;color:#10b981;font-weight:700;flex:none}
.rt-rep-name{font-weight:600;font-size:13px}
.rt-rep-meta{font-size:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.rt-rep-meta b{color:var(--dsw-alias-label-primary);font-weight:600;margin-right:2px}
.rt-rep-missing{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin-top:6px;
  border:1px dashed var(--dsw-alias-state-error-primary);border-radius:5px;padding:5px 8px}
.rt-rep-req{margin-top:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.rt-rep-req-head{display:flex;align-items:center;gap:7px;padding:4px 8px;font-size:11.5px;font-weight:600;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.rt-rep-http{margin:0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-base)}
/* ── 报告里的「这一步怎么来的」：动作步骤 / 命令 / 凭据 / 隧道 ───────────── */
.rt-rep-trace{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:8px 10px;
  background:var(--dsw-alias-bg-base)}
.rt-rep-trace-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.rt-rep-trace-title{font-weight:600;font-size:12.5px}
.rt-rep-trace-how{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.rt-rep-step{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 6px 9px;margin-bottom:6px}
.rt-rep-step-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rt-rep-step-no{width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-brand-primary);color:#fff;
  font-size:10.5px;display:flex;align-items:center;justify-content:center;flex:none}
.rt-rep-step-title{font-weight:600;font-size:12.5px}
.rt-rep-step-detail{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.rt-rep-step-cmd{font-size:11.5px;margin-top:4px;display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap}
.rt-rep-step-cmd .rt-mono{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);
  border-radius:5px;padding:2px 6px;word-break:break-all}
.rt-rep-step-result{font-size:11.5px;margin-top:3px;word-break:break-word}
.rt-rep-src{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1)}
.rt-rep-src-title{font-weight:600;font-size:12px;margin-bottom:3px}
/* ── 全链路攻击路径图 ─────────────────────────────────────────────── */
.rt-ap{padding:10px 12px 18px;overflow:auto}
.rt-ap-stage{margin-bottom:2px}
.rt-ap-head{display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-left:4px solid #64748b;border-top:1px solid var(--dsw-alias-border-l1);border-radius:6px 6px 0 0}
.rt-ap-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-ap-name{font-weight:700;font-size:13.5px}
.rt-ap-en{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.3px}
.rt-ap-phase{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-goal{display:flex;align-items:baseline;gap:8px;padding:6px 10px 6px 9px;font-size:12px;
  border-left:4px solid #64748b;background:var(--dsw-alias-bg-layer-1)}
.rt-ap-goal-tag{font-size:10.5px;font-weight:700;border:1px solid;border-radius:4px;padding:0 5px;white-space:nowrap;flex:none}
.rt-ap-result{padding:7px 10px 3px;border-left:4px solid transparent}
.rt-ap-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap}
.rt-ap-pts{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border:1px solid #10b98155;border-radius:10px;padding:0 7px;white-space:nowrap}
.rt-ap-pts.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
/* 按服务封顶/自建而不计分的命中：分值标灰（+0），避免看着像又加了分 */
.rt-ap-pts.uncounted{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.rt-ap-nth{font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-hit{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #10b981;border-radius:6px;
  padding:6px 9px;margin-bottom:5px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;outline:none}
.rt-ap-hit:hover{border-color:var(--dsw-alias-border-l2)}
.rt-ap-hit:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-ap-hit.overflow{border-left-color:#94a3b8;opacity:.75}
.rt-ap-hit-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rt-ap-hit-name{font-weight:600;font-size:12.5px}
.rt-ap-hit-target{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);
  margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.rt-ap-act{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.rt-ap-act.inferred{font-style:italic;opacity:.75}
.rt-ap-none{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2px 0 4px}
.rt-ap-trans{display:flex;align-items:center;gap:7px;padding:2px 0 2px 14px}
.rt-ap-trans-t{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 横向路径图 */
.rt-ap-h{display:flex;align-items:stretch;padding:10px 12px 14px;overflow-x:auto;flex:1;min-height:0}
.rt-ap-col{display:flex;align-items:stretch;flex:none}
.rt-ap-col-arrow{align-self:center;color:var(--dsw-alias-border-l2);padding:0 6px;font-size:12px;flex:none}
.rt-hcol{width:228px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-top:3px solid #64748b;border-radius:7px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.rt-hcol-goal{font-size:11px;color:var(--dsw-alias-label-secondary);padding:5px 8px;line-height:1.45;
  border-bottom:1px solid var(--dsw-alias-border-l1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rt-hcol-body{padding:6px 8px;flex:1;min-height:0;overflow:auto}
.rt-hcol-hit{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:3px}
.rt-hcol-hit.off{opacity:.6}
.rt-hcol-pts{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;font-weight:700;color:#065f46;background:#a7f3d0;
  border-radius:7px;padding:0 5px;flex:none}
.rt-hcol-hit.off .rt-hcol-pts{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.rt-hcol-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-hcol-none{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rt-hcol-secs{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.rt-hcol-sec{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);
  border-radius:4px;padding:0 4px}
.rt-hcol-attck{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary);
  padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-ap-cum{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rt-ap-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:6px 0 3px}
.rt-ap-assets,.rt-ap-tunnels{display:flex;flex-direction:column;gap:3px}
.rt-ap-asset{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 6px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.rt-ap-tunnel{display:flex;align-items:center;gap:6px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid #f59e0b}
.rt-hcol-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;gap:5px;align-items:center}
.rt-hcol-sub.off{opacity:.6}
.rt-hit-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 7px;font-size:11.5px;padding:4px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
/* 资产与内容都自适应换行：长域名/长口令/长结果一律换行显示，不截断成省略号 */
.rt-hit-asset{font-family:ui-monospace,Menlo,monospace;font-weight:600;flex:0 1 auto;max-width:100%;
  overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt{flex:1 1 100%;color:var(--dsw-alias-label-primary);line-height:1.55;
  white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.rt-hit-txt.none{color:var(--dsw-alias-state-error-primary)}
.rt-hit-row .rt-hit-time{flex:none;margin-left:auto}
/* 自己注册/自建的账号：留痕但不计分，整行压暗 */
.rt-hit-row.self-created{opacity:.72;border-left:3px solid #ef444488}
/* 同一资产同一端口的重复账号/库权限：服务已拿满，不计分（只作留痕） */
.rt-hit-row.service-capped{opacity:.72;border-left:3px solid #f59e0b88}
.rt-hit-row.service-capped .rt-hit-idx{background:#f59e0b}
.rt-rep-group{margin-bottom:14px}
.rt-rep-stage{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:7px;
  background:var(--dsw-alias-bg-layer-2);border-left:4px solid #64748b;border-radius:6px;
  cursor:pointer;outline:none;user-select:none}
.rt-rep-stage:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-rep-stage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-rep-no{width:20px;height:20px;border-radius:5px;color:#fff;font-size:11px;font-weight:700;flex:none;
  display:inline-flex;align-items:center;justify-content:center}
.rt-rep-stage-name{font-weight:700;font-size:13px}
.rt-rep-stage-n{font-size:11px;color:var(--dsw-alias-label-secondary)}
/* 折叠后仍要能一眼看到"这一阶段拿了多少分"，所以分数留在头上 */
.rt-rep-pts{font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;border:1px solid transparent;flex:none}
.rt-rep-body{padding-left:6px}
/* ── 知识库（POC/EXP） ──────────────────────────────────────────── */
.rt-kb-filter{display:flex;align-items:center;gap:7px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库归类总览：一行标签，点一下按该类筛选 */
.rt-kb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* 知识库分组标题（按归类分组时每组一条） */
.rt-kb-cat{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1}
.rt-kb-cat-name{font-weight:600;font-size:12.5px}
/* 技能可用性徽章（技能库页签） */
.rt-avail{display:inline-block;padding:0 5px;border-radius:4px;font-size:10.5px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.rt-avail-available{color:#10b981;border-color:#10b98155;background:#10b9811a}
.rt-avail-broken{color:#ef4444;border-color:#ef444455;background:#ef44441a}
.rt-avail-unknown{color:#94a3b8;border-color:#94a3b855;background:#94a3b81a}
/* 版本 / 更新弹窗 */
.rt-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.rt-modal-box{width:min(560px,92vw);max-height:80vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;font-size:12.5px;line-height:1.7;
  box-shadow:0 18px 48px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary)}
.rt-modal-box .rt-kv b{min-width:76px}
.rt-kb-check{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.rt-kb{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;margin:0 0 8px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.rt-kb.open{border-color:var(--dsw-alias-brand-primary)}
.rt-kb-head{display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;outline:none;flex-wrap:wrap}
.rt-kb-head:hover{background:var(--dsw-alias-bg-layer-1)}
.rt-kb-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.rt-kb-title{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}
.rt-kb-kind{font-size:10px;font-weight:700;letter-spacing:.4px;padding:1px 5px;border-radius:4px;
  color:#fff;background:#64748b;flex:none}
.rt-kb-kind.k-exp{background:#ef4444}
.rt-kb-kind.k-poc{background:#f59e0b}
.rt-kb-kind.k-template{background:#8b5cf6}
.rt-kb-kind.k-script{background:#0ea5e9}
.rt-kb-kind.k-payload{background:#10b981}
.rt-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);padding:0 9px 7px;overflow-wrap:anywhere}
.rt-kb-body{padding:0 9px 9px}
.rt-kb-actions{display:flex;gap:6px;margin:7px 0}
.rt-kb-body .rt-kv span{overflow-wrap:anywhere;word-break:break-word}
/* 本机 nuclei 模板命中：路径要能完整看到（复制成命令直接跑） */
.rt-kb-tpl{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.rt-kb-tpl-row{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:3px 7px;border-radius:5px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin-bottom:3px}
.rt-kb-tpl-path{flex:0 1 auto;font-weight:600;overflow-wrap:anywhere}
.rt-kb-tpl-name{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.rt-md{flex:1;overflow:auto;margin:0;padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;
  line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base)}
.rt-weblink{display:block;font-size:11.5px;margin-top:1px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rt-shots{margin:8px 0 4px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1)}
.rt-shots-head{display:flex;align-items:baseline;gap:8px;font-size:11.5px;margin-bottom:6px}
.rt-shots-n{color:var(--dsw-alias-label-secondary)}
.rt-shot-row{display:flex;gap:8px;flex-wrap:wrap}
.rt-shot{display:flex;flex-direction:column;gap:3px;max-width:220px}
.rt-shot-thumb{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:#0b1020;
  object-fit:contain;display:block;width:auto;max-width:216px}
.rt-shot-loading{display:flex;align-items:center;justify-content:center;width:150px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.rt-shot-cap{display:flex;align-items:center;gap:5px;font-size:10.5px;overflow-wrap:anywhere}
.rt-shot-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.rt-shot-zoom{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;cursor:zoom-out;padding:18px}
.rt-shot-zoom img{max-width:96vw;max-height:86vh;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.5)}
.rt-shot-zoom-cap{color:#e5e7eb;font-size:12px;text-align:center;max-width:90vw;overflow-wrap:anywhere}`;
    /**
     * 战术主题叠加层 —— **只叠加、不改写**（注入顺序排在 `CSS` 之后）。
     *
     * ## 设计方向
     *
     * 「贴官方令牌 + 战术仪表盘感」。宿主的主色在两个主题下都是**近中性**的
     * （浅色 `--dsw-alias-brand-primary` 是深灰、深色是近白），没有彩色主色可用
     * —— 所以「作战台」的感觉不能靠大色块，只能靠四件事：
     *
     * 1. **密度**：行高 29px、表头 25px，比宿主默认紧一档，一屏多装约三分之一行。
     * 2. **等宽数字**：端口 / 分值 / 计数 / 时间戳一律 `tabular-nums`，
     *    列与列之间数字对齐，扫读时眼睛不用为「7 比 1 窄」重新找位置。
     * 3. **语义状态色**：五档严重度各三件（fg / bg / border），三件永远同源
     *    —— 换主题只重声明，不会出现「字红了底还是绿的」。
     * 4. **1px 细线分层**：用 `--dsw-alias-border-l1/l2` 切块，不堆阴影。
     *
     * 硬约束：**不硬编码任何主色**。THEME 里没有一处十六进制色值，
     * 全部走 `var(--dsw-*)` 或从它 `color-mix()` 派生（有测试守着）。
     *
     * ## 一个必须遵守的层叠陷阱（实测踩过，别再踩）
     *
     * CSS 自定义属性的 `var()` 在**声明处**就完成替换，值再沿树继承。
     * 宿主把深色主题加在 **`body`** 上，而 `:root` 是 **`html`**，于是：
     *
     *     :root { --dsw-alias-state-error-primary: 浅色值;
     *             --dsu-sev-critical-fg: var(--dsw-alias-state-error-primary); }  // 浅色值被冻结
     *     [data-ds-dark-theme] { --dsw-alias-state-error-primary: 深色值; }       // body 上覆盖了
     *
     * 结果 `body` 上 alias 确实是深色值，但 `--dsu-sev-critical-fg` 仍是浅色值
     * （在 html 上算好并继承下来的），消费它的规则在深色下一律用浅色 —— 静默错色。
     *
     * **因此**：任何 `var(--dsw-alias-*)` 派生的 `--dsu-*`，都必须在深色块里
     * **整组重声明一遍**（只重声明 fg 会得到「深色字压浅色底」，更难读）。
     * 不依赖主题的派生变量（spacing / radius / 字体栈 / 行高梯度）只在 `:root`
     * 声明一次即可 —— 它们不引用 alias，不会被冻结。
     *
     * ## 深色选择器为什么写两遍
     *
     * 宿主两套写法都用过：`<html data-ds-dark-theme>` 与 `<body data-ds-dark-theme>`。
     * 只覆盖一种，另一种主题下就完全不补偿。两个选择器并列在同一条规则里，
     * 值只写一份。
     */
    exports.THEME = String.raw `/* ═══════════════════════════════════════════════════════════════════════
   0. 设计变量阶梯
   ─────────────────────────────────────────────────────────────────────
   先立梯子再写规则：所有间距 / 圆角 / 字号 / 行高 / 字重都从这里取，
   规则里不再出现裸数字。改一档 = 改一行，不会在 400 条规则里做手术。

   这一块**不依赖主题**（不引用 --dsw-alias-*），所以只在 :root 声明一次，
   不需要在深色块里重声明。
   ═══════════════════════════════════════════════════════════════════════ */
:root{
  /* 间距：4 的倍数一档，够密也分得开 */
  --dsu-space-1:4px;--dsu-space-2:6px;--dsu-space-3:8px;
  --dsu-space-4:12px;--dsu-space-5:16px;--dsu-space-6:24px;

  /* 圆角：xs 给徽章，sm 给按钮/输入，md 给卡片，lg 给面板壳。
     sm 及以上直接跟随宿主令牌（带像素回落，宿主换皮时不至于塌掉）；
     xs 宿主没有对应档位，用固定 4px —— 不引用不存在的令牌名。 */
  --dsu-radius-xs:4px;
  --dsu-radius-sm:var(--dsw-radius-sm,6px);
  --dsu-radius-md:var(--dsw-radius-md,8px);
  --dsu-radius-lg:var(--dsw-radius-lg,12px);
  /* 浮层阴影：宿主已按主题算好，直接借用，避免自己拼写死黑色 */
  --dsu-shadow-soft:var(--dsw-elevation-soft);

  /* 字体栈：UI 走系统栈（宿主没暴露字体令牌，不硬拼不存在的名字），数字列走等宽 */
  --dsu-font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --dsu-font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;

  /* 字号梯度：micro 给徽章，tiny 给表格数字，small 给页签，body 给正文 */
  --dsu-fs-micro:10.5px;--dsu-fs-tiny:11px;--dsu-fs-small:11.5px;
  --dsu-fs-body:12.5px;--dsu-fs-lead:13px;--dsu-fs-title:15px;

  /* 行高梯度：徽章=1（垂直居中不飘），表格行=tight，正文=base，长文本=loose */
  --dsu-lh-none:1;--dsu-lh-tight:1.28;--dsu-lh-base:1.5;--dsu-lh-loose:1.7;

  /* 字重梯度：表头 semi、数字 semi、标题 bold、普通 400 */
  --dsu-fw-regular:400;--dsu-fw-medium:500;--dsu-fw-semi:600;--dsu-fw-bold:650;

  /* 垂直节奏：表体 29 / 表头 25，比宿主默认紧一档，一屏多装约三分之一行 */
  --dsu-row-h:29px;--dsu-row-h-head:25px;
  --dsu-cell-py:5px;--dsu-cell-px:10px;

  /* ── 以下派生变量引用了 --dsw-alias-*，**深色块必须重声明**
        （var() 在声明处替换，:root 上算好的值会被浅色冻结，详见文件头注释） */
  --dsu-line:1px solid var(--dsw-alias-border-l1);
  --dsu-hover-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 45%,var(--dsw-alias-bg-layer-2));
  --dsu-selected-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-4,var(--dsw-alias-bg-layer-3)) 55%,var(--dsw-alias-bg-layer-2));

  /* ── 五档严重度（浅色）：fg 取语义色的本体，bg/border 从同一色混出来
        这样三件套永远同源 —— 换主题只需重声明，不会出现「字红了底还是绿的」 */
  --dsu-sev-critical-fg:var(--dsw-alias-state-error-primary);
  --dsu-sev-critical-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent);
  --dsu-sev-critical-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);
  --dsu-sev-high-fg:var(--dsw-alias-state-warn-primary);
  --dsu-sev-high-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent);
  --dsu-sev-high-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 36%,transparent);
  --dsu-sev-medium-fg:var(--dsw-static-amber-600);
  --dsu-sev-medium-bg:color-mix(in srgb,var(--dsw-static-amber-600) 12%,transparent);
  --dsu-sev-medium-border:color-mix(in srgb,var(--dsw-static-amber-600) 30%,transparent);
  --dsu-sev-low-fg:var(--dsw-static-blue-500);
  --dsu-sev-low-bg:color-mix(in srgb,var(--dsw-static-blue-500) 11%,transparent);
  --dsu-sev-low-border:color-mix(in srgb,var(--dsw-static-blue-500) 30%,transparent);
  --dsu-sev-info-fg:var(--dsw-alias-label-tertiary);
  --dsu-sev-info-bg:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);
  --dsu-sev-info-border:var(--dsw-alias-border-l2);

  /* success 的浅色值要压深：宿主 green-500（浅色主题下的 success 值）在白底只有 2.28:1，
     11px 小字不够（WCAG AA 要 4.5:1）。混入 label-primary（浅色下近黑）后约 5.1:1。
     派生自 alias，所以深色块必须重声明（见下方层叠陷阱说明）。 */
  --dsu-success-fg:color-mix(in srgb,var(--dsw-alias-state-success-primary) 62%,var(--dsw-alias-label-primary));
}

/* ═══════════════════════════════════════════════════════════════════════
   1. 等宽数字
   ─────────────────────────────────────────────────────────────────────
   端口 / 分值 / 计数 / 时间戳一律 tabular-nums：数字列等宽，扫读时
   眼睛不用为「7 比 1 窄」重新找位置。.rt-sev 家族也带上（分值徽章里是数字）。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-mono,.rt-row,.rt-vrow,.rt-score-row,.rt-tag,
.rt-sev,.rt-sev-critical,.rt-sev-high,.rt-sev-medium,.rt-sev-low,.rt-sev-info,
.rt-ip,.rt-score-pts,.rt-score-scope,.rt-sg-sub,.rt-step-time,.rt-step-dot,
.rt-foot,.rt-kv b,.rt-sess-fact b,.rt-cred-meta,.rt-hit-time{
  font-variant-numeric:tabular-nums;
}
.rt-mono,.rt-score-pts,.rt-score-scope,.rt-step-time,.rt-step-dot,.rt-foot{
  font-family:var(--dsu-font-mono);
}

/* ═══════════════════════════════════════════════════════════════════════
   2. 表格密度
   ─────────────────────────────────────────────────────────────────────
   三张表（资产 / 漏洞 / 得分）共用一套节奏：行高 29、表头 25、内边距 5/10。
   hover 与选中态**全部从 --dsw-alias-bg-layer-* 混出来**，不写死色值 ——
   浅色下是「更浅一层」，深色下自然变成「更亮一层」，同一套规则两边都成立。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-row,.rt-vrow,.rt-score-row{
  min-height:var(--dsu-row-h);
  align-items:center;
  line-height:var(--dsu-lh-tight);
  padding-block:var(--dsu-cell-py);
  padding-inline:var(--dsu-cell-px);
  transition:background-color .12s ease;
}
.rt-row.head,.rt-vrow.head,.rt-score-row.head{
  min-height:var(--dsu-row-h-head);
  text-transform:uppercase;
  letter-spacing:.045em;
  font-size:var(--dsu-fs-micro);
  font-weight:var(--dsu-fw-semi);
  color:var(--dsw-alias-label-tertiary);
  border-bottom:1px solid var(--dsw-alias-border-l2);
}
/* hover：整行提一层，不换色相（避免和严重度色抢注意力） */
.rt-row:hover,.rt-vrow:hover,.rt-score-row:hover{background:var(--dsu-hover-bg)}
.rt-row.head:hover,.rt-vrow.head:hover,.rt-score-row.head:hover{background:var(--dsw-alias-bg-layer-1)}
/* 选中：细左轨 + 更亮一层，不整行填色 */
.rt-row.on,.rt-vrow.on,.rt-score-row.on{
  background:var(--dsu-selected-bg);
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);
}
.rt-row.on:hover,.rt-vrow.on:hover,.rt-score-row.on:hover{
  background:color-mix(in srgb,var(--dsu-selected-bg) 82%,var(--dsw-alias-bg-layer-3) 18%);
}
/* 得分命中：淡绿底只染行，勾选框与分值另给强调 */
.rt-score-row.hit{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.rt-score-row.hit .rt-score-pts{color:var(--dsw-alias-state-success-primary);font-weight:var(--dsu-fw-semi)}

/* 单元格文本：正文行高，超长换行不截断（域名 / 口令 / 回显都要看全） */
.rt-row,.rt-vrow,.rt-score-row,.rt-hit-row,.rt-cred,.rt-evi{overflow-wrap:anywhere}

/* ═══════════════════════════════════════════════════════════════════════
   3. 五档严重度落到 .rt-sev 家族
   ─────────────────────────────────────────────────────────────────────
   上游给 .rt-sev-* 写死了十六进制色值，深色下过曝。
   这里接管成三件套变量 —— 同一档的 fg/bg/border 永远同源。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-sev{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:34px;height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  border:1px solid transparent;
  font-family:var(--dsu-font-ui);
  font-size:var(--dsu-fs-micro);
  font-weight:var(--dsu-fw-semi);
  line-height:var(--dsu-lh-none);
  white-space:nowrap;
}
.rt-sev-critical{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-sev-high{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-sev-medium{color:var(--dsu-sev-medium-fg);background:var(--dsu-sev-medium-bg);border-color:var(--dsu-sev-medium-border)}
.rt-sev-low{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
.rt-sev-info{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}
/* 严重度色条：与徽章同源，避免两处各写一份色 */
.rt-sevbar{background:var(--dsu-sev-info-fg)}
.rt-hit-row:has(.rt-sev-critical) .rt-sevbar{background:var(--dsu-sev-critical-fg)}
.rt-hit-row:has(.rt-sev-high) .rt-sevbar{background:var(--dsu-sev-high-fg)}

/* ═══════════════════════════════════════════════════════════════════════
   4. 同族语义（易打性 / 可用性 / 来源标签）：复用五档，不新造颜色
   ═══════════════════════════════════════════════════════════════════════ */
.rt-pri{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:30px;height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  font-size:var(--dsu-fs-micro);
  font-weight:var(--dsu-fw-semi);
  line-height:var(--dsu-lh-none);
  border:1px solid transparent;
}
.rt-pri-high{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-pri-medium{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-pri-low{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}

.rt-tag,.rt-avail{
  display:inline-flex;align-items:center;gap:var(--dsu-space-1);
  height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  border:1px solid var(--dsw-alias-border-l2);
  font-size:var(--dsu-fs-micro);
  line-height:var(--dsu-lh-none);
  white-space:nowrap;
}
.rt-tag-passive{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
.rt-tag-active{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-tag-live{color:var(--dsu-success-fg);background:color-mix(in srgb,var(--dsu-success-fg) 11%,transparent);border-color:color-mix(in srgb,var(--dsu-success-fg) 32%,transparent)}
.rt-tag-warn{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-tag-dead{color:var(--dsw-alias-label-secondary)}

.rt-avail-available{color:var(--dsu-success-fg);background:color-mix(in srgb,var(--dsu-success-fg) 11%,transparent);border-color:color-mix(in srgb,var(--dsu-success-fg) 30%,transparent)}
.rt-avail-broken{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border-color:var(--dsu-sev-critical-border)}
.rt-avail-unknown{color:var(--dsu-sev-info-fg);background:var(--dsu-sev-info-bg);border-color:var(--dsu-sev-info-border)}

/* 测试状态：靠前置小圆点区分，不整块填色（一行里同时出现 3 个状态也不吵） */
.rt-test{
  display:inline-flex;align-items:center;gap:var(--dsu-space-1);
  height:17px;padding:0 var(--dsu-space-1);
  border-radius:var(--dsu-radius-xs);
  border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-tertiary);
  font-size:var(--dsu-fs-micro);
  line-height:var(--dsu-lh-none);
  white-space:nowrap;
}
.rt-test::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.rt-test-testing{color:var(--dsu-sev-high-fg);background:var(--dsu-sev-high-bg);border-color:var(--dsu-sev-high-border)}
.rt-test-testing::before{animation:rt-dsu-pulse 1.6s ease-in-out infinite}
.rt-test-tested{color:var(--dsu-success-fg);background:color-mix(in srgb,var(--dsu-success-fg) 11%,transparent);border-color:color-mix(in srgb,var(--dsu-success-fg) 32%,transparent)}
.rt-test-blocked{color:var(--dsw-alias-bg-base);background:var(--dsu-sev-critical-fg);border-color:var(--dsu-sev-critical-fg)}
.rt-test-no_surface{color:var(--dsu-sev-low-fg);background:var(--dsu-sev-low-bg);border-color:var(--dsu-sev-low-border)}
@keyframes rt-dsu-pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ═══════════════════════════════════════════════════════════════════════
   5. 大号数字 / 表头工具条 / 提示条
   ═══════════════════════════════════════════════════════════════════════ */
.rt-score-big{
  font-family:var(--dsu-font-mono);
  font-size:25px;font-weight:var(--dsu-fw-bold);line-height:var(--dsu-lh-none);
  letter-spacing:-.03em;
}
.rt-score-group{
  font-size:var(--dsu-fs-tiny);font-weight:var(--dsu-fw-semi);letter-spacing:.025em;
  line-height:var(--dsu-lh-tight);
  color:var(--dsw-alias-label-secondary);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);
}
.rt-meter{height:5px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}
.rt-meter>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}
.rt-toolbar{padding:var(--dsu-space-1) var(--dsu-space-3);border-bottom:var(--dsu-line)}
.rt-foot{font-size:var(--dsu-fs-micro);color:var(--dsw-alias-label-tertiary);padding:var(--dsu-space-1) var(--dsu-space-4)}
.rt-hint{border:1px dashed var(--dsu-sev-critical-border);background:var(--dsu-sev-critical-bg);border-radius:var(--dsu-radius-sm)}
.rt-hint b{color:var(--dsu-sev-critical-fg);font-weight:var(--dsu-fw-semi)}
.rt-err{color:var(--dsu-sev-critical-fg);background:var(--dsu-sev-critical-bg);border:1px solid var(--dsu-sev-critical-border);border-radius:var(--dsu-radius-sm);padding:var(--dsu-space-2) var(--dsu-space-3)}

/* ═══════════════════════════════════════════════════════════════════════
   6. 焦点可见性
   ─────────────────────────────────────────────────────────────────────
   上游有几处 outline:none，键盘用户会彻底失去位置感。这里补回 :focus-visible
   —— 只在键盘导航时出现，鼠标点击不抢戏。**不要**用 outline:none 再干掉它。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-dock :focus-visible,.rt-full :focus-visible,.rt-embedded :focus-visible,
.rt-pane :focus-visible,.rt-modal-box :focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px;
  border-radius:var(--dsu-radius-xs);
}
.rt-dock:focus-visible,.rt-full:focus-visible{outline-offset:-2px}

/* ═══════════════════════════════════════════════════════════════════════
   7. 深色补偿
   ─────────────────────────────────────────────────────────────────────
   两套选择器都要覆盖：宿主既有 <html data-ds-dark-theme>，也用过
   <body data-ds-dark-theme>。**凡是值里引用了 --dsw-alias-* 的 --dsu-*
   都必须在这里重声明一遍**，否则会在 :root 上被浅色值冻结（只重声明
   fg 而不重声明 bg 会得到「深色字压在浅色底上」，比不补偿更难读）。
   ═══════════════════════════════════════════════════════════════════════ */
[data-ds-dark-theme],
body[data-ds-dark-theme]{
  --dsu-line:1px solid var(--dsw-alias-border-l1);
  --dsu-hover-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 60%,var(--dsw-alias-bg-layer-2));
  --dsu-selected-bg:color-mix(in srgb,var(--dsw-alias-bg-layer-4,var(--dsw-alias-bg-layer-3)) 70%,var(--dsw-alias-bg-layer-2));

  --dsu-sev-critical-fg:var(--dsw-alias-state-error-primary);
  --dsu-sev-critical-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);
  --dsu-sev-critical-border:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);
  --dsu-sev-high-fg:var(--dsw-alias-state-warn-primary);
  --dsu-sev-high-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);
  --dsu-sev-high-border:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 44%,transparent);
  /* amber / blue 在深底上按同一色相提亮一档（600 → 400 / 500 → 300） */
  --dsu-sev-medium-fg:var(--dsw-static-amber-400);
  --dsu-sev-medium-bg:color-mix(in srgb,var(--dsw-static-amber-400) 16%,transparent);
  --dsu-sev-medium-border:color-mix(in srgb,var(--dsw-static-amber-400) 36%,transparent);
  --dsu-sev-low-fg:var(--dsw-static-blue-300);
  --dsu-sev-low-bg:color-mix(in srgb,var(--dsw-static-blue-300) 15%,transparent);
  --dsu-sev-low-border:color-mix(in srgb,var(--dsw-static-blue-300) 34%,transparent);
  --dsu-sev-info-fg:var(--dsw-alias-label-tertiary);
  --dsu-sev-info-bg:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);
  --dsu-sev-info-border:var(--dsw-alias-border-l3);

  /* 深色下同一个表达式自动变成"提亮"（label-primary 在深色是近白），
     约 7.9:1。因为引用 alias，必须在这里重声明，否则被 :root 的浅色值冻结。 */
  --dsu-success-fg:color-mix(in srgb,var(--dsw-alias-state-success-primary) 62%,var(--dsw-alias-label-primary));
}

/* 深色下把「更亮一层」的语义反过来用：阴影没用了，靠底色阶与细线分层 */
[data-ds-dark-theme] .rt-row:hover,
[data-ds-dark-theme] .rt-vrow:hover,
[data-ds-dark-theme] .rt-score-row:hover,
body[data-ds-dark-theme] .rt-row:hover,
body[data-ds-dark-theme] .rt-vrow:hover,
body[data-ds-dark-theme] .rt-score-row:hover{
  background:var(--dsu-hover-bg);
}
[data-ds-dark-theme] .rt-row.head,
[data-ds-dark-theme] .rt-vrow.head,
[data-ds-dark-theme] .rt-score-row.head,
body[data-ds-dark-theme] .rt-row.head,
body[data-ds-dark-theme] .rt-vrow.head,
body[data-ds-dark-theme] .rt-score-row.head{
  border-bottom-color:var(--dsw-alias-border-l2);
}

/* ═══════════════════════════════════════════════════════════════════════
   页签条单行收紧 + 等宽数字
   ═══════════════════════════════════════════════════════════════════════ */
/* 10 个页签在 620px 宽下必须排成一排：默认 padding 会把最后一个挤到第二排，
   既浪费纵向空间，看着也像渲染错位。内边距收到 7px 正好放下；
   保留 wrap 作保险 —— 更窄时换行总比横向滚动把页签藏起来好。 */
.rt-tabs{gap:1px;padding:0 var(--dsu-space-3)}
.rt-tab{flex:none;padding:9px 7px 8px}

/* 数字列一律等宽对齐（端口 / 分值 / 计数 / 时间戳 / IP）。
   拆成逐条类规则：测试能按类名逐个断言覆盖，也便于以后单独调某一类。 */
.rt-mono{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-ip{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-row{font-variant-numeric:tabular-nums}
.rt-vrow{font-variant-numeric:tabular-nums}
.rt-score-row{font-variant-numeric:tabular-nums}
.rt-score-pts{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-score-big{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-tag{font-variant-numeric:tabular-nums}
.rt-sev{font-variant-numeric:tabular-nums}
.rt-sev-critical{font-variant-numeric:tabular-nums}
.rt-sev-high{font-variant-numeric:tabular-nums}
.rt-sev-medium{font-variant-numeric:tabular-nums}
.rt-sev-low{font-variant-numeric:tabular-nums}
.rt-sev-info{font-variant-numeric:tabular-nums}
.rt-avail{font-variant-numeric:tabular-nums}
.rt-step-time{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}
.rt-foot{font-family:var(--dsu-font-mono);font-variant-numeric:tabular-nums}

/* ═══════════════════════════════════════════════════════════════════════
   表格列宽：上游按「全宽窗口」设计的固定像素列，在 620px dock 里会把
   最后一列压成竖排单字（实测：「开放端口 / 指纹」逐字换行，列宽被算成 0）。

   做法分两步：
   ① 给滚动容器声明 container-type，让下面的容器查询真的能命中
      （不声明的话 @container 永不匹配，这是第一次修没生效的原因）；
   ② 窄容器下**少显示一列**而不是硬压五列 —— 401px 内容宽里塞 5 列，
      无论怎么分配都不够读。
   ═══════════════════════════════════════════════════════════════════════ */
.rt-table,.rt-pane,.rt-chain,.rt-list{container-type:inline-size}

/* 宽容器（full 窗口 / 大屏）：五列全显示 */
.rt-row{grid-template-columns:minmax(120px,150px) 50px 84px minmax(120px,1.3fr) minmax(110px,1fr)}
.rt-vrow{grid-template-columns:62px minmax(0,1.8fr) minmax(120px,180px) 110px 74px 54px}
.rt-score-row{grid-template-columns:14px minmax(0,1fr) 76px 64px}

/* 窄容器（dock 常态）：按真实列序精确减列。
   资产表 5 列：①IP ②易打 ③测试状态 ④端口服务 ⑤指纹
   漏洞表 6 列：①等级 ②漏洞 ③目标 ④拿到什么 ⑤状态 ⑥置信
   被砍的列在详情面板里都还能看到，不是信息丢失。 */
@container (max-width: 560px){
  /* 资产：砍第 5 列（指纹） */
  .rt-row{grid-template-columns:minmax(108px,1.1fr) 46px 78px minmax(96px,1.2fr)}
  .rt-row > *:nth-child(5){display:none}
  /* 漏洞：砍第 6 列（置信） */
  .rt-vrow{grid-template-columns:58px minmax(0,1.6fr) minmax(84px,1fr) 96px 56px}
  .rt-vrow > *:nth-child(6){display:none}
  .rt-score-row{grid-template-columns:14px minmax(0,1fr) 70px 56px}
}
/* 极窄（拖到最小宽 320px）：再砍到 3 列 */
@container (max-width: 420px){
  /* 资产：①IP ②易打 ③测试状态 —— 砍 ④⑤ */
  .rt-row{grid-template-columns:minmax(100px,1fr) 44px 76px}
  .rt-row > *:nth-child(4){display:none}
  .rt-row > *:nth-child(5){display:none}
  /* 漏洞：①等级 ②漏洞 ③目标 —— 砍 ④⑤⑥ */
  .rt-vrow{grid-template-columns:54px minmax(0,1fr) minmax(76px,.8fr)}
  .rt-vrow > *:nth-child(4){display:none}
  .rt-vrow > *:nth-child(5){display:none}
  .rt-vrow > *:nth-child(6){display:none}
  /* 得分：①勾选 ②名称 ③分值 —— 砍 ④口径 */
  .rt-score-row{grid-template-columns:14px minmax(0,1fr) 64px}
  .rt-score-row > *:nth-child(4){display:none}
}

/* full 模式（独立窗口）：最宽松 */
.rt-full .rt-row{grid-template-columns:180px 56px 96px minmax(0,1.3fr) minmax(150px,1fr)}
.rt-full .rt-vrow{grid-template-columns:76px minmax(0,1.8fr) minmax(160px,240px) 130px 84px 60px}

/* 单元格一律允许收缩、不竖排：
   word-break: break-all 会把 443/tcp 断成 4 4 3，逐字换行 */
.rt-row > *,.rt-vrow > *,.rt-score-row > *{
  min-width:0;
  overflow-wrap:normal;
  word-break:keep-all;
}

/* 尊重系统「减少动态效果」：不做过渡与脉冲，信息一个不少 */
@media (prefers-reduced-motion:reduce){
  .rt-test-testing::before{animation:none}
  .rt-row,.rt-vrow,.rt-score-row,.rt-btn,.rt-item,.rt-seg,.rt-tab{transition:none}
}
`;
    /** 标记属性名：注入的每个 `<style>` 都带它，便于查重与人工定位。 */
    exports.STYLE_ATTR = "data-dsh-unbound-drill";
    /** `key` 的默认值 —— 与标记属性的名字一致，方便在 DevTools 里直接搜。 */
    exports.DEFAULT_STYLE_KEY = exports.STYLE_ATTR;
    /**
     * 按 `document` 记住「本实例装过哪些 key 的节点」。
     *
     * 两个用途：`querySelector` 缺失时仍能保证幂等；清理函数能拿到自己那个节点
     * （而不是误删别人后插进来的同 key 节点）。用 `WeakMap` 是为了不把文档对象
     * 钉在内存里 —— 文档销毁即整条记录消失。
     */
    const INSTALLED = new WeakMap();
    /** 取（或建）某个文档的 key→node 记忆表。 */
    function slotOf(doc) {
        const existing = INSTALLED.get(doc);
        if (existing !== undefined)
            return existing;
        const created = new Map();
        INSTALLED.set(doc, created);
        return created;
    }
    /**
     * 在文档里查同 key 的既有 `<style>`。
     *
     * 两条路：优先 `doc.querySelector`（真实 DOM 走这条，跨实例都查得到）；
     * 退路是模块级记忆表（假文档 / 精简文档对象走这条）。查不到返回 `undefined`。
     */
    function findInstalled(doc, key) {
        const remembered = INSTALLED.get(doc)?.get(key);
        if (remembered !== undefined)
            return remembered;
        if (typeof doc.querySelector !== "function")
            return undefined;
        const found = doc.querySelector("style[" + exports.STYLE_ATTR + '="' + key + '"]');
        if (found !== null && typeof found === "object")
            return found;
        return undefined;
    }
    /**
     * 把 `CSS` + `THEME` 注入 `<head>`，返回清理函数。
     *
     * ## 为什么合成一个 `<style>` 而不是两个
     *
     * `THEME` 必须**排在** `CSS` 之后才能赢 —— 这是语义上的顺序依赖，不是巧合。
     * 合成一个节点后，顺序由字符串拼接位置保证：它是一份文本内部的先后，
     * 不依赖「两次 append 的时间先后」。后者在浏览器里也成立，但是脆的：
     * 将来任何人在中间插一次别的注入、或宿主把两个节点挪进不同层叠上下文，
     * 顺序就悄悄反了 —— 而「顺序反了」的症状是「主题没生效」，极难归因。
     *
     * 附带好处：查重只查一个节点，清理只移除一个节点。
     *
     * ## 幂等
     *
     * 已有同 `key` 的节点时**复用并刷新内容**，不重复插入。宿主 hot reload 会
     * 反复调注入，每轮插一个 `<style>` 会让样式表无限增长（旧规则还在生效，
     * 改一版留一层，调样式时永远看到最旧的）。复用而不是提前返回，是为了
     * 「改完立刻生效」：刷新 `textContent` 就够，浏览器会重新解析。
     *
     * ## 清理函数
     *
     * 移除节点，并把记忆表里的记录清掉。**可重复调用**（第二次是 no-op）：
     * React 的 effect 清理在热重载下会跑不止一次，清理函数抛错会把整棵面板带崩。
     */
    function installStyles(doc, options = {}) {
        const key = options.key ?? exports.DEFAULT_STYLE_KEY;
        const payload = exports.CSS + "\n\n" + exports.THEME;
        const existing = findInstalled(doc, key);
        const node = existing ?? doc.createElement("style");
        if (existing === undefined) {
            node.setAttribute(exports.STYLE_ATTR, key);
            doc.head.append(node);
        }
        node.textContent = payload;
        slotOf(doc).set(key, node);
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            const table = INSTALLED.get(doc);
            if (table !== undefined && table.get(key) === node)
                table.delete(key);
            node.remove();
        };
    }
});
/**
 * 面板外壳：三种形态 + 页签栏 + 未读红点。
 *
 * ## 三种形态（原实现的 shellProps 三分支）
 *
 * | 形态 | className | 位置 | 拖拽/缩放 |
 * |---|---|---|---|
 * | `full`（全面浏览） | `rt-full` | 铺满窗口 | 无 |
 * | `embedded`（嵌在外层 dock 里） | `rt-dock rt-embedded` | 相对定位 100% | 无 |
 * | 普通 dock | `rt-dock` | fixed + 几何 | **有** |
 *
 * 判定顺序是 `full → embedded → 普通`：全面浏览优先（它也可能同时是
 * embedded，但铺满优先）。
 *
 * ## 页签栏的可访问性
 *
 * 原实现的注释记了动机：用标准 `tablist`/`tab` 角色，读屏软件据此播报
 * 「第几个页签、是否选中」；键盘用户 Tab 进来后可用 Enter/Space 切换。
 * 这里逐条保留：`role="tablist"` 在容器、`role="tab"` + `aria-selected`
 * 在每个页签、`aria-label` 给红点做文字替代。
 *
 * ## 红点的语义
 *
 * 红点是纯视觉信息，读屏软件读不到。所以原实现给了
 * `h('span', { className: 'rt-tab-dot', 'aria-label': '有新内容' })`
 * —— 这里保留，并且**只在真有未读时才渲染**该 span。
 */
define("redteam/client/panel", ["require", "exports", "redteam/client/helpers", "redteam/client/state", "redteam/client/drag", "redteam/client/entry", "redteam/client/styles"], function (require, exports, helpers_js_8, state_js_5, drag_js_1, entry_js_1, styles_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.applyDrag = exports.HANDLE_KINDS = void 0;
    exports.tabNeedsEngagement = tabNeedsEngagement;
    exports.shellKindOf = shellKindOf;
    exports.shellPropsOf = shellPropsOf;
    exports.hasHandles = hasHandles;
    exports.tabPropsOf = tabPropsOf;
    exports.tabHasUnread = tabHasUnread;
    exports.renderPanel = renderPanel;
    exports.bindDrag = bindDrag;
    exports.canStartDrag = canStartDrag;
    exports.viewportOf = viewportOf;
    exports.initialGeometry = initialGeometry;
    exports.reclampGeometry = reclampGeometry;
    Object.defineProperty(exports, "applyDrag", { enumerable: true, get: function () { return drag_js_1.applyDrag; } });
    /** 页签是否要求先选靶标。 */
    function tabNeedsEngagement(tab) {
        return state_js_5.ENGAGEMENT_TABS.has(tab);
    }
    /** 由 props + 当前是否全面浏览窗口判定形态。 */
    function shellKindOf(embedded, full) {
        if (full)
            return "full";
        if (embedded)
            return "embedded";
        return "dock";
    }
    /** 某形态下的根元素属性。 */
    function shellPropsOf(kind, open, geometry) {
        switch (kind) {
            case "full":
                return {
                    className: "rt-full",
                    dataOpen: "1",
                    style: { display: "flex" },
                };
            case "embedded":
                return {
                    className: "rt-dock rt-embedded",
                    dataOpen: "1",
                    style: { width: "100%", display: "flex" },
                };
            case "dock":
                return {
                    className: "rt-dock",
                    dataOpen: open ? "1" : "0",
                    style: {
                        left: geometry.x + "px",
                        top: geometry.y + "px",
                        right: "auto",
                        bottom: "auto",
                        width: geometry.w + "px",
                        height: geometry.h + "px",
                        display: open ? "flex" : "none",
                    },
                };
        }
    }
    /** 该形态是否显示拖拽把手。 */
    function hasHandles(kind) {
        return kind === "dock";
    }
    /**
     * 页签条的每个页签属性。
     *
     * 单独导出便于测试：断言 `aria-selected`、红点、键盘可达性，
     * 不必把整个 Panel 渲染出来。
     */
    function tabPropsOf(runtime, tab, active, unread, onActivate) {
        const props = (0, helpers_js_8.clickable)(() => onActivate(), { label: tab.label });
        return {
            className: "rt-tab" + (active ? " on" : ""),
            role: "tab",
            ariaSelected: active ? "true" : "false",
            title: unread ? tab.label + "：有新内容，点开看过红点就会消失" : tab.label,
            // 处理器签名与 `clickable` 一致：接收事件对象。
            onClick: props.onClick,
            onKeyDown: props.onKeyDown,
            ariaLabel: props["aria-label"],
        };
    }
    /** 页签的未读判定（靶标 + 指针缺失时一律「无未读」）。 */
    function tabHasUnread(unread, seen, tab) {
        if (unread === undefined || seen === undefined)
            return false;
        const current = unread[tab];
        const previous = seen[tab];
        return (0, state_js_5.hasUnread)(previous, current);
    }
    /**
     * 渲染面板外壳。
     *
     * 这个函数是 `Panel` 组件的**可测内核**：它不调用 hook、不读全局，
     * 只按参数拼元素树。`Panel` 组件本身只负责 `useState` / `useEffect`
     * 与事件绑定。
     */
    function renderPanel(runtime, props, options) {
        const { h } = runtime;
        const kind = shellKindOf(props.embedded === true, options.full);
        const shell = shellPropsOf(kind, options.uiOpen, options.geometry);
        const embedded = kind === "embedded";
        const full = kind === "full";
        const showChrome = !embedded && !full;
        const onTabActivate = (tab) => {
            props.onTabChange?.(tab);
        };
        const tabNodes = state_js_5.TABS.map((tab) => {
            const active = options.activeTab === tab.id;
            const unread = tabHasUnread(props.unread, props.seen, tab.id);
            const interactive = (0, helpers_js_8.clickable)(() => onTabActivate(tab.id), { label: tab.label });
            return h("div", {
                key: tab.id,
                className: "rt-tab" + (active ? " on" : ""),
                role: "tab",
                "aria-selected": active ? "true" : "false",
                title: unread ? tab.label + "：有新内容，点开看过红点就会消失" : tab.label,
                onClick: interactive.onClick,
                onKeyDown: interactive.onKeyDown,
                "aria-label": interactive["aria-label"],
            }, tab.label, 
            // 红点是纯视觉信息，给读屏软件一个文字替代。
            unread ? h("span", { className: "rt-tab-dot", "aria-label": "有新内容" }) : null);
        });
        const engagementOptions = (props.engagements ?? []).map((item) => h("option", { key: item.id, value: item.id }, item.name ?? item.id ?? "未命名"));
        const body = props.renderTab !== undefined
            ? props.renderTab(options.activeTab)
            : h("div", { className: "rt-empty" }, "未知页签");
        return h("div", {
            className: shell.className,
            "data-open": shell.dataOpen,
            style: shell.style,
        }, 
        // 样式表作为子节点挂在面板根里（与上游一致）：
        // 用 `<style>` 元素而不是手动 `document.head.append`，好处是生命周期
        // 跟随组件 —— 面板卸载时样式一起消失，不会在宿主里留下孤儿样式
        // （热重载会反复挂载，留孤儿会让样式表无限增长）。
        // 顺序有意义：CSS 在前、THEME 在后，后者覆盖前者。
        h("style", { key: "styles" }, styles_js_1.CSS + "\n\n" + styles_js_1.THEME), 
        // 拖拽把手只在外壳为 dock 时出现（embedded / full 没有）。
        showChrome
            ? h("div", { className: "rt-grip", title: "拖动调整宽度" })
            : null, showChrome
            ? h("div", { className: "rt-resize-r", title: "拖动调整宽度" })
            : null, showChrome
            ? h("div", { className: "rt-resize-b", title: "拖动调整高度" })
            : null, showChrome
            ? h("div", { className: "rt-resize-c", title: "拖动调整大小" })
            : null, h("div", {
            className: "rt-head",
            title: showChrome ? "按住拖动面板" : undefined,
        }, embedded
            ? null
            : h("div", { className: "rt-title" }, h("span", { className: "rt-dot" }), full ? "演练台 · 全面浏览" : "演练台", full ? h("span", { className: "rt-tag", style: { marginLeft: 6 } }, "独立窗口") : null), h("select", {
            className: "rt-input rt-eng-select",
            style: {
                maxWidth: embedded ? "100%" : "170px",
                minWidth: embedded ? "160px" : undefined,
                flex: embedded ? "1 1 200px" : undefined,
            },
            value: props.engagement ?? "",
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onEngagementChange?.(value);
            },
        }, h("option", { value: "", disabled: true }, engagementOptions.length > 0 ? "选择靶标" : "暂无靶标"), engagementOptions), h("div", { className: "rt-spacer" }), full
            ? h("button", { className: "rt-btn", title: "回到带侧栏的普通界面（或按 Esc）", onClick: () => (0, entry_js_1.exitFullWindow)(runtime) }, "退出全面浏览")
            : null, embedded
            ? null
            : h("button", { className: "rt-btn", title: "刷新名册、快照与当前页面数据", onClick: () => props.onRefresh?.() }, "刷新"), showChrome
            ? h("button", { className: "rt-btn", title: "收起面板", onClick: () => runtime.ui.set({ open: false }) }, "收起")
            : null), h("div", { className: "rt-tabs", role: "tablist" }, tabNodes), h("div", { className: "rt-body", key: "body-" + options.activeTab }, body), h("div", { className: "rt-foot" }, h("span", null, "C 段 " + (props.stats?.["segments"] ?? 0)), h("span", null, "资产 " + (props.stats?.["assets"] ?? 0)), h("div", { className: "rt-spacer" }), full ? h("span", null, "按 Esc 或点右上角「退出全面浏览」回到带侧栏的界面") : null));
    }
    /** 拖拽把手 → 操作类型的映射（组件绑定时用）。 */
    exports.HANDLE_KINDS = Object.freeze([
        { className: "rt-grip", kind: "resize-left" },
        { className: "rt-resize-r", kind: "resize-right" },
        { className: "rt-resize-b", kind: "resize-bottom" },
        { className: "rt-resize-c", kind: "resize-corner" },
    ]);
    /**
     * 在组件里绑定拖拽。
     *
     * 抽成函数而不是内联，是为了让「按下 → 建会话 → 解绑」的生命周期只有一个来源。
     */
    function bindDrag(runtime, kind, geometry, clientX, clientY, onUpdate) {
        const host = runtime.window;
        return (0, drag_js_1.beginDrag)(host, kind, (0, drag_js_1.dragOriginOf)(clientX, clientY, geometry), onUpdate);
    }
    /** 该不该开始拖（主键 + 非交互元素）。 */
    function canStartDrag(button, target) {
        return (0, drag_js_1.isPrimaryButton)(button) && !(0, drag_js_1.shouldIgnoreDrag)(target);
    }
    /** 视口尺寸（测试可注入）。 */
    function viewportOf(windowRef) {
        const width = typeof windowRef.innerWidth === "number" && windowRef.innerWidth > 0 ? windowRef.innerWidth : 1280;
        const height = typeof windowRef.innerHeight === "number" && windowRef.innerHeight > 0 ? windowRef.innerHeight : 800;
        return { width, height };
    }
    /** 初始几何（读上次宽度）。 */
    function initialGeometry(windowRef, savedWidth) {
        return (0, state_js_5.defaultDockGeometry)(viewportOf(windowRef), savedWidth);
    }
    /** 视口变化后重新钳制。 */
    function reclampGeometry(geometry, windowRef) {
        return (0, state_js_5.clampDockGeometry)(geometry, viewportOf(windowRef));
    }
});
/**
 * 智能体提示词页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `PromptsTab` 把五件事塞在同一个组件里：
 *
 * ```js
 * const [roles, setRoles] = React.useState([])
 * const [active, setActive] = React.useState(null)
 * const [draft, setDraft] = React.useState('')
 * ...
 * if (r.roles && r.roles.length) setActive((cur) => cur || r.roles[0].role)
 * const cur = roles.find((x) => x.role === active)
 * ```
 *
 * 三个**容易错**的点，抽出来后可以逐条钉死：
 *
 * 1. **`active` 不会因为角色消失而重置**：原实现是 `cur || roles[0].role`
 *    —— `cur` 有值就原样保留。所以「服务端删掉了某个角色、界面还停在它上面」
 *    时，工具栏标题必须回退成「提示词」而不是崩溃或显示上一份正文。
 * 2. **草稿只在 `active`/`roles` 变化时同步**：用户正在编辑的内容不能被
 *    一次后台刷新覆盖。这条在模型层表现为 `draftFor()` 的纯函数语义 ——
 *    组件决定何时调它。
 * 3. **没靶标也能读，但不能保存**：`prompts` 不带 engagement 时服务端回
 *    内置默认（`builtin: true`）；而保存/恢复必须显式拦下并给出可执行提示，
 *    否则用户会对着一个永远失败的按钮反复点。
 */
define("redteam/client/prompts-model", ["require", "exports", "redteam/client/helpers"], function (require, exports, helpers_js_9) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DRAFT_PLACEHOLDER = exports.EMPTY_PROMPTS_MESSAGE = exports.BUILTIN_NOTICE = exports.PROMPT_SAVED_MESSAGE = exports.PROMPTS_ERROR_FALLBACK = void 0;
    exports.promptRoleOf = promptRoleOf;
    exports.promptCatalogOf = promptCatalogOf;
    exports.promptLoadOf = promptLoadOf;
    exports.activeRoleOf = activeRoleOf;
    exports.promptFor = promptFor;
    exports.draftFor = draftFor;
    exports.previewOf = previewOf;
    exports.promptHeading = promptHeading;
    exports.updatedLabel = updatedLabel;
    exports.promptItemLabel = promptItemLabel;
    exports.promptItemClass = promptItemClass;
    exports.saveBlockedMessage = saveBlockedMessage;
    exports.resetBlockedMessage = resetBlockedMessage;
    exports.canSave = canSave;
    exports.canResetCurrent = canResetCurrent;
    exports.canResetAll = canResetAll;
    exports.saveOutcomeOf = saveOutcomeOf;
    exports.resetOutcomeOf = resetOutcomeOf;
    exports.promptFileName = promptFileName;
    exports.promptHint = promptHint;
    exports.withLocalContent = withLocalContent;
    exports.shouldSyncDraft = shouldSyncDraft;
    /** 读取失败时的兜底文案。 */
    exports.PROMPTS_ERROR_FALLBACK = "读取失败";
    /** 保存成功的文案。 */
    exports.PROMPT_SAVED_MESSAGE = "已保存";
    /** 内置默认时的提示（原实现 `setMsg({ ok: ... })`）。 */
    exports.BUILTIN_NOTICE = "当前为内置默认提示词（创建靶标后可按靶标保存修改）";
    /** 列表为空时的空态文案。 */
    exports.EMPTY_PROMPTS_MESSAGE = "还没有角色提示词";
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从失败响应里取错误文案。 */
    function errorTextOf(response, fallback) {
        const error = asRecord(response)["error"];
        return typeof error === "string" && error !== "" ? error : fallback;
    }
    /**
     * 解析一个角色。
     *
     * `role` 为空的行直接丢弃：它是文件主干的来源，也是 React key 与选中判定
     * 的唯一依据 —— 空 role 的行既点不中、也保存不了，留着只会在列表里出空白行。
     */
    function promptRoleOf(raw) {
        const item = asRecord(raw);
        const role = text(item["role"]);
        if (role === "")
            return null;
        return {
            role,
            title: text(item["title"]) || role,
            content: text(item["content"]),
            // 两个写法都收：老 store 给 `updated_at`，早期实现有过 `updatedAt`。
            updatedAt: text(item["updated_at"]) || text(item["updatedAt"]),
        };
    }
    /** 解析 `prompts` 响应。 */
    function promptCatalogOf(response) {
        const body = asRecord(response);
        const roles = (Array.isArray(body["roles"]) ? body["roles"] : [])
            .map(promptRoleOf)
            .filter((item) => item !== null);
        return { roles, builtin: body["builtin"] === true };
    }
    /** 解析一次读取结果（失败 → `ok: false` + 错误文案）。 */
    function promptLoadOf(response) {
        if ((0, helpers_js_9.isFailure)(response)) {
            return { ok: false, roles: [], builtin: false, error: errorTextOf(response, exports.PROMPTS_ERROR_FALLBACK) };
        }
        const catalog = promptCatalogOf(response);
        return { ok: true, roles: catalog.roles, builtin: catalog.builtin, error: null };
    }
    /**
     * 当前应选中的角色。
     *
     * **保留原实现语义**：已有选择就不动（哪怕它在新的角色列表里已不存在）。
     * 自动“纠正”成第一个角色会让用户正在编辑的正文在后台刷新后突然换掉。
     */
    function activeRoleOf(roles, current) {
        if (current !== null && current !== "")
            return current;
        const first = roles[0];
        return first === undefined ? null : first.role;
    }
    /** 找当前角色（找不到 → `null`）。 */
    function promptFor(roles, active) {
        if (active === null)
            return null;
        return roles.find((item) => item.role === active) ?? null;
    }
    /** 当前角色对应的草稿正文（找不到 → 空串）。 */
    function draftFor(roles, active) {
        return promptFor(roles, active)?.content ?? "";
    }
    /**
     * 列表项的一行预览。
     *
     * 原实现：`(r.content || '').replace(/[#*`]/g, '').slice(0, 60) || '（空）'`。
     * 先剥 Markdown 记号再截 60 字符 —— 不剥的话整行都是 `###`，看不出写的是什么。
     */
    function previewOf(role) {
        if (role === null)
            return "（空）";
        const stripped = role.content.replace(/[#*`]/g, "").slice(0, 60);
        return stripped === "" ? "（空）" : stripped;
    }
    /** 工具栏标题（没有当前角色 → 「提示词」）。 */
    function promptHeading(roles, active) {
        return promptFor(roles, active)?.title ?? "提示词";
    }
    /** 工具栏上的更新时间标签。 */
    function updatedLabel(roles, active) {
        return "更新 " + (0, helpers_js_9.formatTimestamp)(promptFor(roles, active)?.updatedAt ?? "");
    }
    /** 列表项的 aria-label（原实现同样拼法）。 */
    function promptItemLabel(role) {
        return "查看「" + role.title + "」提示词";
    }
    /** 列表项的 className（选中加 `on`）。 */
    function promptItemClass(role, active) {
        return "rt-item" + (active === role.role ? " on" : "");
    }
    /**
     * 保存前的靶标校验。
     *
     * `prompts` 支持无靶标读取，但保存必须落在一个靶标上 —— 原实现同样在
     * 发请求前拦下并给出「请先创建靶标」。
     */
    function saveBlockedMessage(engagement) {
        return engagement === null || engagement === "" ? "请先创建靶标，再保存提示词" : null;
    }
    /** 恢复默认前的靶标校验。 */
    function resetBlockedMessage(engagement) {
        return engagement === null || engagement === "" ? "请先创建靶标，再恢复默认提示词" : null;
    }
    /** 保存按钮是否可用（无靶标仍可点 —— 点了会给出提示，原实现同样如此）。 */
    function canSave(busy, active) {
        return !busy && active !== null && active !== "";
    }
    /** 「恢复默认为当前」是否可用。 */
    function canResetCurrent(busy, active) {
        return !busy && active !== null && active !== "";
    }
    /** 「全部恢复默认」是否可用。 */
    function canResetAll(busy) {
        return !busy;
    }
    /** 保存结果 → 消息。 */
    function saveOutcomeOf(response) {
        if ((0, helpers_js_9.isFailure)(response)) {
            return { kind: "err", text: errorTextOf(response, "保存失败") };
        }
        return { kind: "ok", text: exports.PROMPT_SAVED_MESSAGE };
    }
    /**
     * 恢复默认结果 → 消息。
     *
     * 成功时把服务端返回的 `reset` 数组拼进文案 —— 「恢复了哪几个角色」是
     * 用户唯一能验证这次操作范围的信息（全部恢复 vs 只恢复当前）。
     */
    function resetOutcomeOf(response) {
        if ((0, helpers_js_9.isFailure)(response)) {
            return { kind: "err", text: errorTextOf(response, "恢复失败") };
        }
        const raw = asRecord(response)["reset"];
        const names = Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [];
        return { kind: "ok", text: "已恢复内置默认：" + names.join("、") };
    }
    /** 服务端返回的提示词文件名（保存后的落盘位置）。 */
    function promptFileName(active) {
        return "agents/" + (active !== null && active !== "" ? active : "role") + ".md";
    }
    /** 底部说明文案（与提示词文件的加载机制对齐）。 */
    function promptHint(active) {
        return "保存后写入 " + promptFileName(active)
            + "。子会话任务第一行写 redteamRole: recon、assess、vuln-scan、exploit 或 internal 后，对应文件进入系统提示词。";
    }
    /** 对话框占位文案。 */
    exports.DRAFT_PLACEHOLDER = "该角色的系统提示词（Markdown）";
    /**
     * 保存成功后本地刷新一行。
     *
     * 原实现用 `Object.assign({}, x, { content: draft, updated_at: new Date() })`
     * 就地更新，不等服务端回读 —— 少一次往返，但要求这里的行为完全一致。
     */
    function withLocalContent(roles, active, content, now) {
        return roles.map((item) => (item.role === active ? { ...item, content, updatedAt: now } : item));
    }
    /**
     * 服务端刷新后要不要替换草稿。
     *
     * 原实现的草稿同步是 `useEffect([active, roles])` —— `roles` 换了就
     * **无条件**把草稿重置成该角色在服务端的正文。也就是说：保存/恢复默认后
     * 会重读一次角色表，草稿随之回到服务端值。这里给出判定条件，
     * 让组件与测试共用同一条规则。
     */
    function shouldSyncDraft(active, roles, currentDraft) {
        if (active === null)
            return false;
        return draftFor(roles, active) !== currentDraft;
    }
});
/**
 * 智能体提示词页（`prompts` 页签）的渲染。
 *
 * 数据与判定全在 `prompts-model.ts`，这里只排版。
 *
 * ## 布局（原实现是左右分栏）
 *
 * ```
 * ┌─────────────┬────────────────────────────────────┐
 * │ 角色列表    │ 工具栏：标题 / 更新 / 恢复 / 全部恢复 / 保存 │
 * │  信息收集   │ 消息（成功 / 失败）                  │
 * │  资产梳理   │ 正文编辑框                          │
 * │  …          │ 落盘位置说明                        │
 * └─────────────┴────────────────────────────────────┘
 * ```
 *
 * ## 一个原实现的细节，这里保留
 *
 * 「恢复默认为当前」与「保存」在**没有选中角色时禁用**，但「全部恢复默认」
 * 仍然可点 —— 后者不依赖 `active`，把它一起禁用会让用户在角色表还没读回来
 * 时连兜底都做不到。
 */
define("redteam/client/prompts-tab", ["require", "exports", "redteam/client/prompts-model"], function (require, exports, prompts_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderPromptsTab = renderPromptsTab;
    exports.loadPrompts = loadPrompts;
    exports.savePrompt = savePrompt;
    exports.resetPrompts = resetPrompts;
    exports.applySavedDraft = applySavedDraft;
    exports.draftOfLoad = draftOfLoad;
    exports.promptErrorMessage = promptErrorMessage;
    /** 一行角色。 */
    function roleRow(runtime, props, role) {
        return runtime.h("div", {
            key: role.role,
            className: (0, prompts_model_js_1.promptItemClass)(role, props.active),
            role: "button",
            tabIndex: 0,
            "aria-label": (0, prompts_model_js_1.promptItemLabel)(role),
            "aria-expanded": props.active === role.role ? "true" : "false",
            onClick: () => props.onSelect(role.role),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onSelect(role.role);
                }
            },
        }, runtime.h("div", { className: "rt-item-name" }, role.title), runtime.h("div", { className: "rt-item-desc" }, (0, prompts_model_js_1.previewOf)(role)));
    }
    /**
     * 渲染提示词页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderPromptsTab(runtime, props) {
        const { h } = runtime;
        const load = props.catalog;
        const roles = load?.roles ?? [];
        const current = (0, prompts_model_js_1.promptFor)(roles, props.active);
        const list = roles.length > 0
            ? roles.map((role) => roleRow(runtime, props, role))
            : h("div", { className: "rt-empty" }, prompts_model_js_1.EMPTY_PROMPTS_MESSAGE);
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, (0, prompts_model_js_1.promptHeading)(roles, props.active)), h("span", { className: "rt-tag" }, (0, prompts_model_js_1.updatedLabel)(roles, props.active)), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            disabled: !(0, prompts_model_js_1.canResetCurrent)(props.busy, props.active),
            title: "把当前角色恢复成内置最新版提示词",
            onClick: () => props.onReset(false),
        }, "恢复默认为当前"), h("button", {
            className: "rt-btn",
            disabled: !(0, prompts_model_js_1.canResetAll)(props.busy),
            title: "四个角色全部恢复成内置最新版提示词",
            onClick: () => props.onReset(true),
        }, "全部恢复默认"), h("button", {
            className: "rt-btn rt-btn-primary",
            disabled: !(0, prompts_model_js_1.canSave)(props.busy, props.active),
            onClick: () => props.onSave(),
        }, props.busy ? "保存中…" : "保存"));
        // 加载失败与内置默认是**两种不同**的提示：前者是错误（红），
        // 后者是正常状态说明（灰）。合并会让「内置默认」看起来像故障。
        const loadError = load !== null && load.error !== null
            ? h("div", { className: "rt-err" }, load.error)
            : null;
        const builtinNotice = load !== null && load.ok && load.builtin
            ? h("div", { className: "rt-foot" }, prompts_model_js_1.BUILTIN_NOTICE)
            : null;
        const messageNode = props.message !== null
            ? h("div", {
                className: props.message.kind === "err" ? "rt-err" : "rt-foot",
            }, props.message.text)
            : null;
        const editor = h("div", { className: "rt-pane" }, h("textarea", {
            className: "rt-textarea",
            value: props.draft,
            placeholder: prompts_model_js_1.DRAFT_PLACEHOLDER,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onDraftChange(value);
            },
        }), h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", marginTop: 6 } }, (0, prompts_model_js_1.promptHint)(props.active)));
        return h("div", { className: "rt-split" }, h("div", { className: "rt-list" }, 
        // 刷新按钮挂在列表顶上：没有靶标时也能重读内置默认
        // （原实现靠外层 refreshKey 驱动，这里给一个显式入口）。
        h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "角色"), h("span", { className: "rt-tag" }, roles.length + " 个"), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            disabled: props.busy,
            onClick: () => props.onRefresh(),
        }, props.busy ? "读取中…" : "刷新")), loadError, builtinNotice, list), h("div", { className: "rt-main" }, toolbar, messageNode, editor));
    }
    /** 读取角色提示词（`engagement` 为 `null` 时读内置默认）。 */
    async function loadPrompts(api, engagement) {
        return engagement === null || engagement === ""
            ? api.raw({ op: "prompts" })
            : api.raw({ op: "prompts", engagement });
    }
    /**
     * 保存一个角色的正文。
     *
     * 无靶标时**不发请求**直接返回错误消息 —— 原实现同样在发请求前拦下。
     */
    async function savePrompt(api, engagement, role, content) {
        const blocked = (0, prompts_model_js_1.saveBlockedMessage)(engagement);
        if (blocked !== null)
            return { message: { kind: "err", text: blocked }, response: null };
        if (role === null || role === "") {
            return { message: { kind: "err", text: "没有选中角色" }, response: null };
        }
        const response = await api.raw({
            op: "savePrompt",
            engagement: engagement,
            role,
            content,
        });
        return {
            message: (0, prompts_model_js_1.saveOutcomeOf)(response),
            response: response.ok === false ? null : response,
        };
    }
    /** 恢复内置默认（`all=true` 时不带 `role`）。 */
    async function resetPrompts(api, engagement, role, all) {
        const blocked = (0, prompts_model_js_1.resetBlockedMessage)(engagement);
        if (blocked !== null)
            return { message: { kind: "err", text: blocked }, response: null };
        const response = await api.raw({
            op: "resetPrompts",
            engagement: engagement,
            ...(all ? {} : { role }),
        });
        return {
            message: (0, prompts_model_js_1.resetOutcomeOf)(response),
            response: response.ok === false ? null : response,
        };
    }
    /**
     * 保存成功后本地更新列表（不等服务端回读）。
     *
     * 时间戳用 ISO 串（与原实现的 `new Date().toISOString()` 同形），
     * 这样 `formatTimestamp` 的截断结果一致。
     */
    function applySavedDraft(load, active, content, now) {
        if (load === null)
            return null;
        return { ...load, roles: (0, prompts_model_js_1.withLocalContent)(load.roles, active, content, now) };
    }
    /** 从响应解析出的草稿（供保存后回读用）。 */
    function draftOfLoad(load, active) {
        if (load === null)
            return "";
        return (0, prompts_model_js_1.draftFor)(load.roles, active);
    }
    /** 错误文案兜底（供组件在异常路径上用）。 */
    function promptErrorMessage(error) {
        if (typeof error === "string" && error !== "")
            return error;
        if (error instanceof Error && error.message !== "")
            return error.message;
        return prompts_model_js_1.PROMPTS_ERROR_FALLBACK;
    }
});
/**
 * 得分复现报告页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `ReportTab` 的 224 行里，「分组」是唯一有真实分支逻辑的部分，
 * 而它藏在一次**二次请求**里：
 *
 * ```js
 * if ((!r.stages || r.stages.length === 0) && (r.items || []).length > 0) {
 *   api({ op: 'scoreChain' }).then((c) => setData({ ...r, stages: groupByStage(r.items, c) }))
 * }
 * ```
 *
 * 也就是说：**老 host 只给平铺条目时，前端要用 `scoreChain` 的阶段信息
 * 把条目重新分组**，否则报告页会误报「还没有可交付的成果」。
 * 这是真实的兼容场景（host 侧版本较旧 / 阶段行缺失），不是防御性代码。
 *
 * 抽出来后可以钉死三条规则：
 *
 * 1. **按 `score_hit` id 对齐**：两边唯一的共同键是 id，不是顺序、不是标题。
 * 2. **没有阶段信息的条目归「其他得分」**，不能让它们凭空消失。
 * 3. **阶段分组只保留有命中的阶段**：空阶段不占版面。
 *
 * ## 另外三块
 *
 * - **复现材料的完整度判定**（`incomplete`）：没有攻击步骤、没写实际命令、
 *   没有原始请求 —— 三者都是「这份报告复现不了」的硬缺口。
 * - **`markdown` 的下载文件名规整**：`report-<label>.md`，label 里的
 *   非 `[A-Za-z0-9_.-]` 全部换成 `_`。
 * - **报告只收录得分成果**：`items` 为空就是「没有可交付的成果」，
 *   而不是「加载失败」。
 */
define("redteam/client/report-model", ["require", "exports", "redteam/client/helpers", "redteam/client/label"], function (require, exports, helpers_js_10, label_js_5) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.COPY_FAILED_MESSAGE = exports.RESPONSE_PREVIEW_LIMIT = exports.MISSING_TOOL_MESSAGE = exports.MISSING_REQUESTS_MESSAGE = exports.MISSING_STEPS_MESSAGE = exports.REPORT_FOOTER = exports.LOADING_REPORT_MESSAGE = exports.EMPTY_REPORT_HINT = exports.EMPTY_REPORT_TITLE = exports.CIRCLED = exports.OTHER_STAGE_NAME = exports.OTHER_STAGE_COLOR = exports.OTHER_STAGE_CODE = void 0;
    exports.reportRequestOf = reportRequestOf;
    exports.reportStepOf = reportStepOf;
    exports.reportCredentialOf = reportCredentialOf;
    exports.reportTunnelOf = reportTunnelOf;
    exports.reportWebshellOf = reportWebshellOf;
    exports.reportShotOf = reportShotOf;
    exports.reportItemOf = reportItemOf;
    exports.reportSummaryOf = reportSummaryOf;
    exports.reportStageOf = reportStageOf;
    exports.reportDataOf = reportDataOf;
    exports.needsStageGrouping = needsStageGrouping;
    exports.groupByStage = groupByStage;
    exports.stageRefsFromChain = stageRefsFromChain;
    exports.withStages = withStages;
    exports.circledOf = circledOf;
    exports.stageCountLabel = stageCountLabel;
    exports.stagePointsLabel = stagePointsLabel;
    exports.stageCumulativeLabel = stageCumulativeLabel;
    exports.stagePointsStyle = stagePointsStyle;
    exports.stageOrdinalStyle = stageOrdinalStyle;
    exports.stageCollapseKey = stageCollapseKey;
    exports.itemSeqLabel = itemSeqLabel;
    exports.itemPointsLabel = itemPointsLabel;
    exports.itemNthLabel = itemNthLabel;
    exports.itemTarget = itemTarget;
    exports.itemVulnLine = itemVulnLine;
    exports.itemRecordedLine = itemRecordedLine;
    exports.itemEvidenceLine = itemEvidenceLine;
    exports.stepToolLine = stepToolLine;
    exports.stepResultLine = stepResultLine;
    exports.stepAgentLabel = stepAgentLabel;
    exports.stepIndexLabel = stepIndexLabel;
    exports.stepTitleLabel = stepTitleLabel;
    exports.credentialLine = credentialLine;
    exports.tunnelLine = tunnelLine;
    exports.tunnelHeading = tunnelHeading;
    exports.webshellLine = webshellLine;
    exports.webshellHeading = webshellHeading;
    exports.requestTitle = requestTitle;
    exports.requestLabel = requestLabel;
    exports.requestBody = requestBody;
    exports.responsePreview = responsePreview;
    exports.requestsText = requestsText;
    exports.copyRequestsLabel = copyRequestsLabel;
    exports.copyCommandLabel = copyCommandLabel;
    exports.summaryPointsLabel = summaryPointsLabel;
    exports.summaryCountLabel = summaryCountLabel;
    exports.summaryRequestsLabel = summaryRequestsLabel;
    exports.summaryRequestsLive = summaryRequestsLive;
    exports.summaryCompleteLabel = summaryCompleteLabel;
    exports.summaryCompleteWarn = summaryCompleteWarn;
    exports.summaryCappedLabel = summaryCappedLabel;
    exports.summaryCappedTitle = summaryCappedTitle;
    exports.downloadFileName = downloadFileName;
    exports.downloadedMessage = downloadedMessage;
    exports.downloadFailedMessage = downloadFailedMessage;
    exports.copiedMessage = copiedMessage;
    exports.canCopyOrDownload = canCopyOrDownload;
    exports.stageKeys = stageKeys;
    exports.isLoaded = isLoaded;
    exports.hasStages = hasStages;
    /** 报告的「其他得分」阶段的固定 code。 */
    exports.OTHER_STAGE_CODE = "other";
    /** 「其他得分」的固定颜色（与上游一致）。 */
    exports.OTHER_STAGE_COLOR = "#64748b";
    /** 「其他得分」的显示名。 */
    exports.OTHER_STAGE_NAME = "其他得分";
    /** 圈号（20 个 —— 报告阶段可能超过五个）。 */
    exports.CIRCLED = Object.freeze([
        "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
        "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
    ]);
    /** 空态：没有可交付成果。 */
    exports.EMPTY_REPORT_TITLE = "还没有可交付的成果。";
    /** 空态说明。 */
    exports.EMPTY_REPORT_HINT = "本报告只收录\"拿到了分\"的成果；没有得分的漏洞不进报告。"
        + "拿到成果后用 redteam_score_hit 记分（目标资产 + 拿到的东西），并补 redteam_http_evidence_add 以便复现。";
    /** 加载中文案。 */
    exports.LOADING_REPORT_MESSAGE = "加载中…";
    /** 底部口径说明。 */
    exports.REPORT_FOOTER = "口径：只收录得分成果，每条附带可粘进 Yakit Repeater 的原始请求";
    /** 缺少步骤的警示。 */
    exports.MISSING_STEPS_MESSAGE = "⚠️ 没有关联的攻击步骤：说不清这一步是怎么做的。"
        + "请用 redteam_chain_add 补上动作（title / detail / tool / result），记分时也可以带 point_code + evidence 一次完成。";
    /** 缺少原始请求的警示。 */
    exports.MISSING_REQUESTS_MESSAGE = "⚠️ 这一项没有原始请求记录，无法直接复现 —— 请用 redteam_http_evidence_add 补上";
    /** 缺少实际命令的警示。 */
    exports.MISSING_TOOL_MESSAGE = "未记录实际命令（redteam_chain_add 的 tool）";
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组。 */
    function asArray(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 读有限数字（非有限 → 0）。 */
    function numberOf(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    /** 读有限数字（非有限 → `null`）。 */
    function numberOrNull(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 读字符串数组。 */
    function stringsOf(value) {
        return asArray(value).filter((item) => typeof item === "string");
    }
    /** 解析一条原始请求。 */
    function reportRequestOf(raw) {
        const item = asRecord(raw);
        // 请求可能是空串（只有响应），此时 url/method 仍要保留 —— 不按 id 判空
        // （这条记录没有 id 字段，用「有没有任何字段」判空）。
        if (Object.keys(item).length === 0)
            return null;
        return {
            request: text(item["request"]),
            response: text(item["response"]),
            method: text(item["method"]),
            status: numberOrNull(item["status"]),
            url: text(item["url"]),
            source: text(item["source"]),
        };
    }
    /** 解析一条攻击步骤。 */
    function reportStepOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            title: text(item["title"]),
            detail: text(item["detail"]),
            tool: text(item["tool"]),
            result: text(item["result"]),
            agent: text(item["agent"]),
            stageCode: text(item["stage_code"]),
            evidenceRef: text(item["evidence_ref"]),
            recordedAt: text(item["recorded_at"]),
            inferred: item["inferred"] === true,
        };
    }
    /** 解析一条凭据。 */
    function reportCredentialOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            host: text(item["host"]),
            username: text(item["username"]),
            secretType: text(item["secret_type"]),
            privilege: text(item["privilege"]),
            source: text(item["source"]),
            tool: text(item["tool"]),
        };
    }
    /** 解析一条隧道。 */
    function reportTunnelOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        const legit = item["legit"];
        return {
            id,
            kind: text(item["kind"]),
            listen: text(item["listen"]),
            entry: text(item["entry"]),
            entryKind: text(item["entry_kind"]),
            reach: text(item["reach"]),
            status: text(item["status"]),
            command: text(item["command"]),
            legit: typeof legit === "boolean" ? legit : null,
        };
    }
    /** 解析一条 WebShell。 */
    function reportWebshellOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            shellType: text(item["shell_type"]),
            url: text(item["url"]),
            passKey: text(item["pass_key"]),
            privilege: text(item["privilege"]),
            status: text(item["status"]),
        };
    }
    /** 解析一张证据截图。 */
    function reportShotOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        return {
            id,
            kind: text(item["kind"]),
            label: text(item["label"]),
            note: text(item["note"]),
            target: text(item["target"]),
            capturedAt: text(item["captured_at"]),
        };
    }
    /** 解析一条报告条目。 */
    function reportItemOf(raw) {
        const item = asRecord(raw);
        const id = numberOrNull(item["id"]);
        if (id === null)
            return null;
        const vuln = asRecord(item["vuln"]);
        const steps = asArray(item["steps"])
            .map(reportStepOf)
            .filter((entry) => entry !== null);
        const requests = asArray(item["requests"])
            .map(reportRequestOf)
            .filter((entry) => entry !== null);
        return {
            id,
            seq: numberOf(item["seq"]),
            pointName: text(item["point_name"]),
            points: numberOf(item["points"]),
            // 缺省算「计分」（`counted !== false`），与攻击链页一致。
            counted: item["counted"] !== false,
            nthOfPoint: numberOf(item["nth_of_point"]),
            target: text(item["target"]),
            assetIp: text(item["asset_ip"]),
            gained: text(item["gained"]),
            evidence: text(item["evidence"]),
            recordedAt: text(item["recorded_at"]),
            recordedBy: text(item["recorded_by"]),
            note: text(item["note"]),
            vulnCve: text(vuln["cve"]),
            vulnTitle: text(vuln["title"]),
            how: text(item["how"]),
            incomplete: item["incomplete"] === true,
            gaps: stringsOf(item["gaps"]),
            requests,
            steps,
            credentials: asArray(item["credentials"])
                .map(reportCredentialOf)
                .filter((entry) => entry !== null),
            tunnels: asArray(item["tunnels"])
                .map(reportTunnelOf)
                .filter((entry) => entry !== null),
            webshells: asArray(item["webshells"])
                .map(reportWebshellOf)
                .filter((entry) => entry !== null),
            shots: asArray(item["shots"])
                .map(reportShotOf)
                .filter((entry) => entry !== null),
            shotTotal: numberOf(item["shot_total"]),
        };
    }
    /** 解析摘要。 */
    function reportSummaryOf(raw) {
        const item = asRecord(raw);
        if (Object.keys(item).length === 0)
            return null;
        return {
            points: numberOf(item["points"]),
            count: numberOf(item["count"]),
            withRequests: numberOf(item["withRequests"]),
            incomplete: numberOf(item["incomplete"]),
            missingRequests: numberOf(item["missingRequests"]) !== 0,
            serviceCappedExcluded: numberOf(item["serviceCappedExcluded"]),
            serviceCapped: asArray(item["serviceCapped"]).map((entry) => {
                const record = asRecord(entry);
                return { service: text(record["service"]), point_name: text(record["point_name"]) };
            }),
        };
    }
    /** 解析一个阶段。 */
    function reportStageOf(raw) {
        const item = asRecord(raw);
        const code = text(item["code"]);
        if (code === "")
            return null;
        return {
            code,
            name: text(item["name"]) || code,
            color: text(item["color"]) || exports.OTHER_STAGE_COLOR,
            ordinal: numberOf(item["ordinal"]),
            points: numberOf(item["points"]),
            cumulative: numberOf(item["cumulative"]),
            items: asArray(item["items"])
                .map(reportItemOf)
                .filter((entry) => entry !== null),
        };
    }
    /** 解析 `scoreReport` 响应（失败 → `null`）。 */
    function reportDataOf(response) {
        if ((0, helpers_js_10.isFailure)(response))
            return null;
        const body = asRecord(response);
        return {
            target: text(body["target"]),
            markdown: text(body["markdown"]),
            items: asArray(body["items"])
                .map(reportItemOf)
                .filter((entry) => entry !== null),
            stages: asArray(body["stages"])
                .map(reportStageOf)
                .filter((entry) => entry !== null),
            summary: reportSummaryOf(body["summary"]),
        };
    }
    /**
     * 报告是否需要前端补分组。
     *
     * 条件与原实现一致：**服务端没给阶段**（缺失或空）**且有平铺条目**。
     * 两个条件必须同时成立 —— 只有「没阶段也没条目」时补分组是白跑一次请求。
     */
    function needsStageGrouping(data) {
        if (data === null)
            return false;
        return data.stages.length === 0 && data.items.length > 0;
    }
    /**
     * 用攻击链的阶段信息给平铺条目补分组。
     *
     * **对齐键是 `score_hit` 的 id**：`scoreChain` 的每条 item 带 `stage_code`，
     * `scoreReport` 的每条 item 带同样的 id。用顺序或标题对齐都会错位。
     *
     * 三条规则：
     * 1. 空阶段不出现（`items.length === 0` 就跳过）。
     * 2. 阶段顺序沿用 `chain.stages` 的顺序（那是攻击链的定义顺序）。
     * 3. 没被任何阶段认领的条目归入「其他得分」—— **不能丢**，
     *    否则报告会少掉真实拿到的分。
     */
    function groupByStage(items, chainStageRefs) {
        const byId = new Map();
        for (const item of items)
            byId.set(item.id, item);
        const groups = [];
        chainStageRefs.forEach((ref, index) => {
            const claimed = [];
            for (const id of ref.itemIds) {
                const item = byId.get(id);
                if (item !== undefined)
                    claimed.push(item);
            }
            if (claimed.length === 0)
                return;
            groups.push({
                code: ref.code,
                name: ref.name,
                color: ref.color !== "" ? ref.color : exports.OTHER_STAGE_COLOR,
                ordinal: ref.ordinal !== 0 ? ref.ordinal : index + 1,
                points: ref.points,
                cumulative: ref.cumulative,
                items: claimed,
            });
        });
        const grouped = new Set();
        for (const group of groups) {
            for (const item of group.items)
                grouped.add(item.id);
        }
        const rest = items.filter((item) => !grouped.has(item.id));
        if (rest.length > 0) {
            groups.push({
                code: exports.OTHER_STAGE_CODE,
                name: exports.OTHER_STAGE_NAME,
                color: exports.OTHER_STAGE_COLOR,
                ordinal: groups.length + 1,
                points: rest.reduce((sum, item) => sum + (item.counted ? item.points : 0), 0),
                cumulative: 0,
                items: rest,
            });
        }
        return groups;
    }
    /**
     * 从 `scoreChain` 的响应里抽出「阶段 → 条目 id」的引用表。
     *
     * 只保留三个字段（code/name/color）+ 序号 + 分数 + id 列表，
     * 让 `groupByStage` 不依赖攻击链页的完整类型。
     */
    function stageRefsFromChain(response) {
        if ((0, helpers_js_10.isFailure)(response))
            return [];
        const stages = asArray(asRecord(response)["stages"]);
        return stages.map((raw) => {
            const stage = asRecord(raw);
            const items = asArray(stage["items"]);
            return {
                code: text(stage["code"]),
                name: text(stage["name"]),
                color: text(stage["color"]),
                ordinal: numberOf(stage["ordinal"]),
                points: numberOf(stage["points"]),
                cumulative: numberOf(stage["cumulative"]),
                itemIds: items
                    .map((item) => numberOrNull(asRecord(item)["id"]))
                    .filter((id) => id !== null),
            };
        }).filter((ref) => ref.code !== "");
    }
    /** 把补好的分组套回报告数据。 */
    function withStages(data, stages) {
        return { ...data, stages };
    }
    /** 阶段序号标签（超出 20 个 → 原始数字）。 */
    function circledOf(ordinal) {
        if (ordinal < 1)
            return String(ordinal);
        return exports.CIRCLED[ordinal - 1] ?? String(ordinal);
    }
    /** 阶段标题的计项文案。 */
    function stageCountLabel(stage) {
        return stage.items.length + " 项";
    }
    /** 阶段标题的得分文案。 */
    function stagePointsLabel(stage) {
        return "+" + stage.points + " 分";
    }
    /** 阶段标题的累计分文案。 */
    function stageCumulativeLabel(stage) {
        return "累计 " + stage.cumulative + " 分";
    }
    /** 阶段标题的得分徽章 style。 */
    function stagePointsStyle(color) {
        return { background: color + "22", color, borderColor: color + "66" };
    }
    /** 阶段标题的序号块 style。 */
    function stageOrdinalStyle(color) {
        return { background: color };
    }
    /** 阶段的折叠键（`st:<code>`）。 */
    function stageCollapseKey(code) {
        return "st:" + code;
    }
    /** 条目的序号标签（`String(seq)`）。 */
    function itemSeqLabel(item) {
        return String(item.seq);
    }
    /** 条目的得分标签。 */
    function itemPointsLabel(item) {
        return "+" + item.points + " 分";
    }
    /** 「同类第 N 次」标签（第一次 → `null`）。 */
    function itemNthLabel(item) {
        return item.nthOfPoint > 1 ? "同类第 " + item.nthOfPoint + " 次" : null;
    }
    /** 条目的目标（`target` → `asset_ip` → `—`）。 */
    function itemTarget(item) {
        if (item.target !== "")
            return item.target;
        return item.assetIp !== "" ? item.assetIp : "—";
    }
    /** 条目的漏洞行（CVE + 标题；都空 → `null`）。 */
    function itemVulnLine(item) {
        const parts = [item.vulnCve, item.vulnTitle].filter((part) => part !== "");
        return parts.length > 0 ? parts.join(" ") : null;
    }
    /** 条目的取得时间行（含角色中文名）。 */
    function itemRecordedLine(item) {
        const base = (0, helpers_js_10.formatTimestamp)(item.recordedAt);
        return item.recordedBy !== "" ? base + "（" + (0, label_js_5.labelOf)(label_js_5.ROLE_LABEL, item.recordedBy) + "）" : base;
    }
    /** 条目的结果行（换行压成空格，保持单行）。 */
    function itemEvidenceLine(item) {
        return item.evidence.replace(/\n+/g, " ");
    }
    /** 步骤的执行命令行（`null` = 没记录）。 */
    function stepToolLine(step) {
        return step.tool !== "" ? step.tool : null;
    }
    /** 步骤的结果行（换行压成空格）。 */
    function stepResultLine(step) {
        return step.result.replace(/\n+/g, " ");
    }
    /** 步骤的角色标签（`null` = 没标注）。 */
    function stepAgentLabel(step) {
        return step.agent !== "" ? (0, label_js_5.labelOf)(label_js_5.ROLE_LABEL, step.agent) : null;
    }
    /** 步骤的序号（从 1 开始的显示序）。 */
    function stepIndexLabel(index) {
        return String(index + 1);
    }
    /** 步骤的标题（空 → `(未命名动作)`）。 */
    function stepTitleLabel(step) {
        return step.title !== "" ? step.title : "(未命名动作)";
    }
    /** 凭据行的可追溯说明。 */
    function credentialLine(cred) {
        return (cred.username !== "" ? cred.username : "(无用户名)")
            + " / " + (cred.secretType !== "" ? cred.secretType : "password")
            + (cred.privilege !== "" ? " · 权限 " + cred.privilege : "")
            + " · 来源 " + (cred.source !== "" ? cred.source : "未标注")
            + (cred.tool !== "" ? " · 取得方式 " + cred.tool.replace(/\n+/g, " ").slice(0, 160) : "");
    }
    /** 隧道行的说明。 */
    function tunnelLine(tunnel) {
        return "入口 " + (tunnel.entry !== "" ? tunnel.entry : "未登记")
            + (tunnel.reach !== "" ? " · 可达 " + tunnel.reach : "")
            + " · 目标侧 " + (tunnel.entryKind !== "" ? tunnel.entryKind : "未声明")
            + (tunnel.legit === false ? " · ⚠️ 不算跨越靶标边界" : "")
            + (tunnel.status !== "" ? " · " + tunnel.status : "")
            + (tunnel.command !== "" ? " · 命令 " + tunnel.command.replace(/\n+/g, " ").slice(0, 160) : "");
    }
    /** 隧道的标题（`kind listen`）。 */
    function tunnelHeading(tunnel) {
        return (tunnel.kind !== "" ? tunnel.kind : "socks5") + " " + tunnel.listen;
    }
    /** WebShell 行的说明。 */
    function webshellLine(shell) {
        return shell.url
            + (shell.passKey !== "" ? " · 口令/密钥 " + shell.passKey : "")
            + (shell.privilege !== "" ? " · 权限 " + shell.privilege : "")
            + (shell.status !== "" ? " · " + shell.status : "");
    }
    /** WebShell 的标题（空 → `shell`）。 */
    function webshellHeading(shell) {
        return shell.shellType !== "" ? shell.shellType : "shell";
    }
    /** 请求行的标题（`复现请求 N` + 自动匹配说明）。 */
    function requestTitle(index, request) {
        return "复现请求 " + (index + 1)
            + (request.source === "auto" ? "（按目标路径自动匹配，请核对）" : "");
    }
    /** 请求行的标签（`方法 状态码`）。 */
    function requestLabel(request) {
        return (request.method !== "" ? request.method : "GET") + " "
            + (request.status === null ? "" : String(request.status));
    }
    /**
     * 请求正文的显示值。
     *
     * 原实现：`r.request || ((r.method || 'GET') + ' ' + (r.url || '') + ' HTTP/1.1')`。
     * 没有原始请求时退化成一行合成的请求行 —— 至少能看出是发给谁的哪个方法。
     */
    function requestBody(request) {
        if (request.request !== "")
            return request.request;
        return (request.method !== "" ? request.method : "GET") + " " + request.url + " HTTP/1.1";
    }
    /** 响应摘要的截断长度。 */
    exports.RESPONSE_PREVIEW_LIMIT = 1600;
    /** 响应摘要的显示值（截断到 1600 字符）。 */
    function responsePreview(request) {
        if (request.response === "")
            return null;
        return request.response.slice(0, exports.RESPONSE_PREVIEW_LIMIT);
    }
    /** 一条条目所有请求拼起来的可复制文本（空请求行会被过滤）。 */
    function requestsText(item) {
        return item.requests
            .map((request) => request.request)
            .filter((request) => request !== "")
            .join("\n\n");
    }
    /** 「复制请求」按钮对应的 label。 */
    function copyRequestsLabel(item) {
        return "第 " + item.seq + " 项请求";
    }
    /** 「复制命令」按钮对应的 label。 */
    function copyCommandLabel(index) {
        return "第 " + (index + 1) + " 步命令";
    }
    /** 工具栏的「合计 N 分」。 */
    function summaryPointsLabel(summary) {
        return summary === null ? null : "合计 " + summary.points + " 分";
    }
    /** 工具栏的「N 项得分」。 */
    function summaryCountLabel(summary) {
        return summary === null ? null : summary.count + " 项得分";
    }
    /** 工具栏的「N/M 项带原始请求」。 */
    function summaryRequestsLabel(summary) {
        return summary === null ? null : summary.withRequests + "/" + summary.count + " 项带原始请求";
    }
    /** 「带原始请求」标签是否用绿色（全带 → 绿；有缺 → 灰）。 */
    function summaryRequestsLive(summary) {
        return !summary.missingRequests;
    }
    /** 工具栏的「可复现 N/M」。 */
    function summaryCompleteLabel(summary) {
        return summary === null ? null : "可复现 " + (summary.count - summary.incomplete) + "/" + summary.count;
    }
    /** 「可复现」标签是否用警示色（有缺口 → 警示）。 */
    function summaryCompleteWarn(summary) {
        return summary.incomplete > 0;
    }
    /**
     * 工具栏的「同服务已拿满不计分 N」。
     *
     * 只在**有**被排除的条目时显示。tooltip 列出被排除的服务/得分点
     * （原实现用 `join('\n')`，空列表时退化成一句解释）。
     */
    function summaryCappedLabel(summary) {
        if (summary === null || summary.serviceCappedExcluded === 0)
            return null;
        return "同服务已拿满不计分 " + summary.serviceCappedExcluded;
    }
    /** 「同服务已拿满」标签的 tooltip。 */
    function summaryCappedTitle(summary) {
        const lines = summary.serviceCapped
            .map((entry) => (entry.service !== "" ? entry.service : "") + "｜" + entry.point_name)
            .join("\n");
        return lines !== ""
            ? lines
            : "同一资产同一端口的重复账号/数据库权限命中：服务已拿满，不计分、不进报告";
    }
    /**
     * 下载文件名。
     *
     * 原实现：`'report-' + String(label || 'score').replace(/[^\w.\-]/g, '_') + '.md'`。
     * `\w` 在 JS 里是 `[A-Za-z0-9_]`，所以中文 label 会变成一串 `_` ——
     * **保留这个行为**：文件名在各平台上的兼容性比可读性重要。
     */
    function downloadFileName(label) {
        const safe = (label !== "" ? label : "score").replace(/[^\w.-]/g, "_");
        return "report-" + safe + ".md";
    }
    /** 下载成功提示。 */
    function downloadedMessage(label) {
        return "已下载：" + label;
    }
    /** 下载失败提示。 */
    function downloadFailedMessage(error) {
        const message = error instanceof Error ? error.message : String(error);
        return "下载失败：" + message;
    }
    /** 复制成功的提示（与原实现同形）。 */
    function copiedMessage(label) {
        return "已复制：" + label;
    }
    /** 复制失败的提示。 */
    exports.COPY_FAILED_MESSAGE = "复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制";
    /** 工具栏按钮的禁用条件：没正文时不能复制/下载。 */
    function canCopyOrDownload(busy, markdown) {
        return !busy && markdown !== "";
    }
    /** 「全部展开 / 全部折叠」的键列表。 */
    function stageKeys(stages) {
        return stages.map((stage) => stageCollapseKey(stage.code));
    }
    /** 报告数据是否为空（`null` = 没读回来，与「读到但没有成果」区分）。 */
    function isLoaded(data) {
        return data !== null;
    }
    /** 报告是否有可展示的阶段。 */
    function hasStages(data) {
        return data !== null && data.stages.length > 0;
    }
});
/**
 * 得分复现报告页（`report` 页签）的渲染。
 *
 * 数据与分组逻辑全在 `report-model.ts`，这里只排版。
 *
 * ## 版面（一条得分 = 一张卡）
 *
 * ```
 * 工具栏：合计 / 项数 / 带请求数 / 可复现数 / 同服务已拿满 | 复制全文 下载 重新生成
 * 阶段分组（可折叠，默认全开）
 *   └ 条目卡
 *       · 序号 + 得分点 + 得分 + 次数
 *       · 目标 / 拿到 / 利用漏洞 / 结果 / 取得时间
 *       · 证据截图
 *       · 复现步骤（details，缺材料时默认展开）
 *           动作 → 执行命令（可复制）→ 结果 → 证据
 *           凭据（来源可追溯）/ 隧道 / WebShell
 *       · 复现请求（可粘贴进 Yakit）
 * ```
 *
 * ## 两个原实现的细节，这里保留
 *
 * 1. **`<details>` 的 `open` 是「缺材料时默认展开」**：材料齐全时收起来
 *    （报告很长），缺材料时必须摊开让人看见缺口 —— 藏起来的缺口等于没有。
 * 2. **阶段折叠状态默认全开**：`isSectionOpen(state, key, true)`。
 *    默认折叠会让用户以为报告是空的。
 */
define("redteam/client/report-tab", ["require", "exports", "redteam/client/helpers", "redteam/client/state", "redteam/client/report-model"], function (require, exports, helpers_js_11, state_js_6, report_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderReportTab = renderReportTab;
    exports.loadReport = loadReport;
    exports.loadChainForGrouping = loadChainForGrouping;
    exports.reportErrorOf = reportErrorOf;
    exports.loadReportWithGrouping = loadReportWithGrouping;
    exports.copyFeedback = copyFeedback;
    /** 一条攻击步骤。 */
    function stepNode(runtime, props, step, index) {
        const { h } = runtime;
        const tool = (0, report_model_js_1.stepToolLine)(step);
        const agentLabel = (0, report_model_js_1.stepAgentLabel)(step);
        return h("div", { key: "s" + step.id, className: "rt-rep-step" }, h("div", { className: "rt-rep-step-head" }, h("span", { className: "rt-rep-step-no" }, (0, report_model_js_1.stepIndexLabel)(index)), h("span", { className: "rt-rep-step-title" }, (0, report_model_js_1.stepTitleLabel)(step)), agentLabel !== null ? h("span", { className: "rt-tag" }, agentLabel) : null, step.stageCode !== "" ? h("span", { className: "rt-tag" }, step.stageCode) : null, step.inferred ? h("span", { className: "rt-tag" }, "按同资产推断") : null, h("div", { className: "rt-spacer" }), step.recordedAt !== ""
            ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, (0, helpers_js_11.formatTimestamp)(step.recordedAt))
            : null), step.detail !== "" ? h("div", { className: "rt-rep-step-detail" }, step.detail) : null, h("div", { className: "rt-rep-step-cmd" }, h("b", null, "执行 "), tool !== null
            ? h("span", { className: "rt-mono" }, tool)
            : h("span", { style: { color: "var(--dsw-alias-state-warn-primary, #f59e0b)" } }, report_model_js_1.MISSING_TOOL_MESSAGE)), tool !== null
            ? h("div", { style: { marginTop: 3 } }, h("button", {
                className: "rt-btn",
                style: { padding: "0 6px", fontSize: 11 },
                onClick: () => props.onCopy(tool, (0, report_model_js_1.copyCommandLabel)(index)),
            }, "复制命令"))
            : null, step.result !== ""
            ? h("div", { className: "rt-rep-step-result" }, h("b", null, "结果 "), (0, report_model_js_1.stepResultLine)(step))
            : null, step.evidenceRef !== ""
            ? h("div", { className: "rt-rep-step-result" }, h("b", null, "证据 "), h("span", { className: "rt-mono" }, step.evidenceRef))
            : null);
    }
    /** 复现步骤块（`<details>`）。 */
    function traceNode(runtime, props, item) {
        const { h } = runtime;
        // 缺材料时必须默认摊开：藏起来的缺口等于没有。
        const open = item.incomplete || item.steps.length === 0;
        return h("details", { className: "rt-rep-trace", open }, h("summary", { className: "rt-rep-trace-head", style: { cursor: "pointer" } }, h("span", { className: "rt-rep-trace-title" }, "复现步骤（点击展开）"), item.steps.length > 0 ? h("span", { className: "rt-tag" }, item.steps.length + " 个动作") : null, item.credentials.length > 0 ? h("span", { className: "rt-tag" }, item.credentials.length + " 条凭据") : null, item.tunnels.length > 0 ? h("span", { className: "rt-tag" }, item.tunnels.length + " 条隧道") : null, item.incomplete
            ? h("span", { className: "rt-tag rt-tag-warn" }, "复现材料待补")
            : h("span", { className: "rt-tag rt-tag-live" }, "可复现")), h("div", { style: { paddingTop: 6 } }, item.how !== "" ? h("div", { className: "rt-rep-trace-how" }, item.how) : null, item.steps.length === 0
            ? h("div", { className: "rt-rep-missing" }, report_model_js_1.MISSING_STEPS_MESSAGE)
            : item.steps.map((step, index) => stepNode(runtime, props, step, index)), item.credentials.length > 0
            ? h("div", { className: "rt-rep-src" }, h("div", { className: "rt-rep-src-title" }, "拿到的凭据（来源可追溯）"), item.credentials.map((cred) => h("div", { key: "c" + cred.id, className: "rt-kv" }, h("b", { className: "rt-mono", style: { minWidth: 120 } }, cred.host !== "" ? cred.host : "—"), h("span", null, (0, report_model_js_1.credentialLine)(cred)))))
            : null, item.tunnels.length > 0
            ? h("div", { className: "rt-rep-src" }, h("div", { className: "rt-rep-src-title" }, "用到的隧道 / 通道"), item.tunnels.map((tunnel) => h("div", { key: "t" + tunnel.id, className: "rt-kv" }, h("b", { className: "rt-mono", style: { minWidth: 120 } }, (0, report_model_js_1.tunnelHeading)(tunnel)), h("span", null, (0, report_model_js_1.tunnelLine)(tunnel)))))
            : null, item.webshells.length > 0
            ? h("div", { className: "rt-rep-src" }, h("div", { className: "rt-rep-src-title" }, "用到的 WebShell"), item.webshells.map((shell) => h("div", { key: "w" + shell.id, className: "rt-kv" }, h("b", { className: "rt-mono", style: { minWidth: 120 } }, (0, report_model_js_1.webshellHeading)(shell)), h("span", null, (0, report_model_js_1.webshellLine)(shell)))))
            : null, item.gaps.length > 0
            ? h("div", { className: "rt-rep-missing" }, "⚠️ 复现缺口：" + item.gaps.join("；"))
            : null));
    }
    /** 一条复现请求。 */
    function requestNode(runtime, props, request, index) {
        const { h } = runtime;
        const preview = (0, report_model_js_1.responsePreview)(request);
        return h("div", { key: "q" + index, className: "rt-rep-req" }, h("div", { className: "rt-rep-req-head" }, h("span", null, (0, report_model_js_1.requestTitle)(index, request)), h("span", { className: "rt-tag" }, (0, report_model_js_1.requestLabel)(request)), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onCopy(request.request, "请求 " + (index + 1)),
        }, "复制到 Yakit")), h("pre", { className: "rt-rep-http" }, (0, report_model_js_1.requestBody)(request)), preview !== null
            ? h("div", null, h("div", { className: "rt-rep-req-head" }, h("span", null, "响应摘要")), h("pre", { className: "rt-rep-http", style: { maxHeight: 160 } }, preview))
            : null);
    }
    /** 一张条目卡。 */
    function cardNode(runtime, props, item) {
        const { h } = runtime;
        const nth = (0, report_model_js_1.itemNthLabel)(item);
        const vuln = (0, report_model_js_1.itemVulnLine)(item);
        return h("div", { key: "r" + item.id, className: "rt-rep" }, h("div", { className: "rt-rep-head" }, h("span", { className: "rt-rep-idx" }, (0, report_model_js_1.itemSeqLabel)(item)), h("span", { className: "rt-rep-name" }, item.pointName), h("span", { className: "rt-flow-pts" }, (0, report_model_js_1.itemPointsLabel)(item)), nth !== null ? h("span", { className: "rt-tag" }, nth) : null, h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onCopy((0, report_model_js_1.requestsText)(item), (0, report_model_js_1.copyRequestsLabel)(item)),
        }, "复制请求")), h("div", { className: "rt-rep-meta" }, h("span", null, h("b", null, "目标 ")), h("span", { className: "rt-mono" }, (0, report_model_js_1.itemTarget)(item))), item.gained !== ""
            ? h("div", { className: "rt-rep-meta" }, h("b", null, "拿到 "), h("span", null, item.gained))
            : null, vuln !== null
            ? h("div", { className: "rt-rep-meta" }, h("b", null, "利用漏洞 "), h("span", null, vuln))
            : null, item.evidence !== ""
            ? h("div", { className: "rt-rep-meta" }, h("b", null, "结果 "), h("span", null, (0, report_model_js_1.itemEvidenceLine)(item)))
            : null, item.recordedAt !== ""
            ? h("div", { className: "rt-rep-meta" }, h("b", null, "取得时间 "), h("span", null, (0, report_model_js_1.itemRecordedLine)(item)))
            : null, props.renderShots !== undefined ? props.renderShots(item) : null, traceNode(runtime, props, item), item.requests.length === 0
            ? h("div", { className: "rt-rep-missing" }, report_model_js_1.MISSING_REQUESTS_MESSAGE)
            : item.requests.map((request, index) => requestNode(runtime, props, request, index)), item.note !== ""
            ? h("div", { className: "rt-rep-meta" }, h("b", null, "备注 "), h("span", null, item.note))
            : null);
    }
    /** 一个阶段分组。 */
    function stageNode(runtime, props, stage) {
        const { h } = runtime;
        const key = (0, report_model_js_1.stageCollapseKey)(stage.code);
        const open = (0, state_js_6.isSectionOpen)(props.collapse, key, true);
        const toggle = () => {
            props.onCollapseChange((0, state_js_6.toggleSection)(props.collapse, key, true));
        };
        return h("div", { key: "g" + stage.code, className: "rt-rep-group" }, h("div", {
            className: "rt-rep-stage",
            role: "button",
            tabIndex: 0,
            style: { borderLeftColor: stage.color },
            "aria-expanded": open ? "true" : "false",
            onClick: toggle,
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    toggle();
                }
            },
        }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), h("span", { className: "rt-rep-no", style: (0, report_model_js_1.stageOrdinalStyle)(stage.color) }, (0, report_model_js_1.circledOf)(stage.ordinal)), h("span", { className: "rt-rep-stage-name" }, stage.name), h("span", { className: "rt-rep-stage-n" }, (0, report_model_js_1.stageCountLabel)(stage)), h("div", { className: "rt-spacer" }), h("span", { className: "rt-rep-pts", style: (0, report_model_js_1.stagePointsStyle)(stage.color) }, (0, report_model_js_1.stagePointsLabel)(stage)), h("span", { className: "rt-ap-cum" }, (0, report_model_js_1.stageCumulativeLabel)(stage))), open ? h("div", { className: "rt-rep-body" }, stage.items.map((item) => cardNode(runtime, props, item))) : null);
    }
    /**
     * 渲染报告页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderReportTab(runtime, props) {
        const { h } = runtime;
        const data = props.data;
        const stages = data?.stages ?? [];
        const summary = data?.summary ?? null;
        const markdown = data?.markdown ?? "";
        const busy = props.busy;
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "攻击得分链路复现报告"), summary !== null ? h("span", { className: "rt-tag rt-tag-live" }, (0, report_model_js_1.summaryPointsLabel)(summary)) : null, summary !== null ? h("span", { className: "rt-tag" }, (0, report_model_js_1.summaryCountLabel)(summary)) : null, summary !== null
            ? h("span", {
                className: "rt-tag" + ((0, report_model_js_1.summaryRequestsLive)(summary) ? " rt-tag-live" : ""),
            }, (0, report_model_js_1.summaryRequestsLabel)(summary))
            : null, summary !== null
            ? h("span", {
                className: "rt-tag" + ((0, report_model_js_1.summaryCompleteWarn)(summary) ? " rt-tag-warn" : " rt-tag-live"),
                title: "复现链是否完整：有攻击步骤、写了实际命令、关联了漏洞/凭据/隧道",
            }, (0, report_model_js_1.summaryCompleteLabel)(summary))
            : null, summary !== null && (0, report_model_js_1.summaryCappedLabel)(summary) !== null
            ? h("span", {
                className: "rt-tag rt-tag-warn",
                title: (0, report_model_js_1.summaryCappedTitle)(summary),
            }, (0, report_model_js_1.summaryCappedLabel)(summary))
            : null, h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            disabled: !(0, report_model_js_1.canCopyOrDownload)(busy, markdown),
            onClick: () => props.onCopy(markdown, "整份报告"),
        }, "复制全文"), h("button", {
            className: "rt-btn",
            disabled: !(0, report_model_js_1.canCopyOrDownload)(busy, markdown),
            onClick: () => props.onDownload(markdown, data?.target ?? ""),
        }, "下载 .md"), h("button", {
            className: "rt-btn",
            disabled: busy,
            onClick: () => props.onRefresh(),
        }, busy ? "生成中…" : "重新生成"));
        const messageNode = props.message !== null
            ? h("div", { className: props.message.kind === "err" ? "rt-err" : "rt-foot" }, props.message.text)
            : null;
        const errorNode = props.error !== null ? h("div", { className: "rt-err" }, props.error) : null;
        const body = stages.length > 0
            ? h("div", { className: "rt-rep-list" }, h("div", { className: "rt-rep-tools" }, h("button", {
                className: "rt-btn",
                onClick: () => props.onSetAllCollapsed((0, report_model_js_1.stageKeys)(stages), true),
            }, "全部展开"), h("button", {
                className: "rt-btn",
                onClick: () => props.onSetAllCollapsed((0, report_model_js_1.stageKeys)(stages), false),
            }, "全部折叠")), stages.map((stage) => stageNode(runtime, props, stage)))
            : (data === null
                ? h("div", { className: "rt-empty" }, report_model_js_1.LOADING_REPORT_MESSAGE)
                : h("div", { className: "rt-empty" }, h("div", null, report_model_js_1.EMPTY_REPORT_TITLE), h("div", { style: { marginTop: 6, fontSize: 12 } }, report_model_js_1.EMPTY_REPORT_HINT)));
        return h("div", { className: "rt-main" }, toolbar, messageNode, errorNode, h("div", { className: "rt-body", style: { overflow: "auto" } }, body), h("div", { className: "rt-foot" }, h("span", null, report_model_js_1.REPORT_FOOTER)));
    }
    /** 读报告。 */
    async function loadReport(api, engagement) {
        return api.raw({ op: "scoreReport", engagement });
    }
    /** 读攻击链（补分组用）。 */
    async function loadChainForGrouping(api, engagement) {
        return api.raw({ op: "scoreChain", engagement });
    }
    /** 报告的错误文案。 */
    function reportErrorOf(response) {
        if (response.ok === false)
            return response.error ?? "生成失败";
        return null;
    }
    /**
     * 二次请求的结果应用：给平铺条目补阶段分组。
     *
     * 原实现在 `scoreReport` 之后判断 `needsStageGrouping`，成立时再发一次
     * `scoreChain`；**第二次请求失败时退回原始数据**（不报错）——
     * 报告仍然可读，只是没分组。这里把两步收成一个函数，行为一致。
     */
    async function loadReportWithGrouping(api, engagement) {
        const response = await loadReport(api, engagement);
        const error = reportErrorOf(response);
        if (error !== null)
            return { data: null, error };
        const data = (0, report_model_js_1.reportDataOf)(response);
        if (data === null)
            return { data: null, error: "生成失败" };
        if (!(0, report_model_js_1.needsStageGrouping)(data))
            return { data, error: null };
        // 二次请求失败时退回原始数据（不报错）：报告仍可读，只是没分组。
        const chain = await loadChainForGrouping(api, engagement);
        return { data: (0, report_model_js_1.withStages)(data, (0, report_model_js_1.groupByStage)(data.items, (0, report_model_js_1.stageRefsFromChain)(chain))), error: null };
    }
    /** 复制结果的提示文案（成功 / 失败统一一处）。 */
    function copyFeedback(ok, label) {
        return ok
            ? { kind: "ok", text: (0, report_model_js_1.copiedMessage)(label) }
            : { kind: "err", text: report_model_js_1.COPY_FAILED_MESSAGE };
    }
});
/**
 * 得分目标页（`scores` 页签）的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `ScoreTab`（357 行）混了四件互不相干的事：
 *
 * 1. **看板解析**：`items` / `ruleGroups` / `summary` 三条线，且 `ruleGroups`
 *    缺失时（老 host）要**退回平铺** —— 这个兼容分支最容易在迁移里丢掉。
 * 2. **分组渲染**：8 个类别按后端 `order` 排序，组头显示「N 项 · 各项上限合计 X 分」。
 * 3. **表单**：内置点（`builtin`）的 5 个字段全部 `readOnly`，只有「启用/停用」可改，
 *    且删除按钮禁用。这是**真实的产品决策**（分值由《得分规则》锁定，改了就
 *    「一条命中吃掉整组上限」），不是防呆。
 * 4. **保存语义**：`overridden === false` 表示后端**没采纳**分值 —— 这时
 *    必须报「分值未改动」而不是笼统的「已保存」。
 */
define("redteam/client/score-model", ["require", "exports", "shared/result"], function (require, exports, result_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EMPTY_POINTS_TEXT = exports.NO_ENGAGEMENT_TEXT = exports.OVERRIDDEN_MESSAGE = exports.BUILTIN_DELETE_TITLE = exports.BUILTIN_DELETE_LABEL = exports.BUILTIN_NOTICE_BODY = exports.BUILTIN_NOTICE_TITLE = exports.POINTS_HINT = exports.DEFAULT_POINTS = exports.SERVICE_CAPPED_SUMMARY_TITLE = exports.SELF_CREATED_SUMMARY_TITLE = exports.EMPTY_SCORE_SUMMARY = exports.NO_HIT_HINT = exports.SERVICE_CAP_SUFFIX = exports.SHOT_COUNT_TITLE = exports.SELF_CREATED_TITLE = void 0;
    exports.scoreHitOf = scoreHitOf;
    exports.hitAssetLabel = hitAssetLabel;
    exports.hitEvidenceText = hitEvidenceText;
    exports.hitHasEvidence = hitHasEvidence;
    exports.hitCopyText = hitCopyText;
    exports.cappedLabel = cappedLabel;
    exports.cappedTitle = cappedTitle;
    exports.scorePointOf = scorePointOf;
    exports.isAchieved = isAchieved;
    exports.pointsBadgeClass = pointsBadgeClass;
    exports.pointsBadgeStyle = pointsBadgeStyle;
    exports.pointNameText = pointNameText;
    exports.countedText = countedText;
    exports.capText = capText;
    exports.countedTitle = countedTitle;
    exports.earnedText = earnedText;
    exports.statusText = statusText;
    exports.hitsSectionTitle = hitsSectionTitle;
    exports.scoreGroupOf = scoreGroupOf;
    exports.groupKeyOf = groupKeyOf;
    exports.groupSubtitle = groupSubtitle;
    exports.summaryOf = summaryOf;
    exports.scoreBoardOf = scoreBoardOf;
    exports.newScoreForm = newScoreForm;
    exports.editFormOf = editFormOf;
    exports.withFormField = withFormField;
    exports.checkForm = checkForm;
    exports.isFieldLocked = isFieldLocked;
    exports.lockedTitle = lockedTitle;
    exports.builtinRuleText = builtinRuleText;
    exports.saveOutcomeOf = saveOutcomeOf;
    exports.deleteOutcomeOf = deleteOutcomeOf;
    exports.shouldSkipDelete = shouldSkipDelete;
    exports.scoresRequest = scoresRequest;
    exports.saveRequest = saveRequest;
    exports.deleteRequest = deleteRequest;
    exports.loadScores = loadScores;
    exports.saveScorePoint = saveScorePoint;
    exports.removeScorePoint = removeScorePoint;
    exports.groupRowKey = groupRowKey;
    exports.detailRowKey = detailRowKey;
    exports.hitRowKey = hitRowKey;
    /* ══════════════════════════════════════════════════════════════ 窄化原语 */
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读数组。 */
    function arrayOf(value) {
        return Array.isArray(value) ? value : [];
    }
    /** 从不可信值读计数（非有限或负数 → 0）。 */
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 从不可信值读有符号整数（可为负）。 */
    function intOf(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
    }
    /** 从不可信值读可空数字。 */
    function nullableNumber(value) {
        if (value === null || value === undefined)
            return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 解析一条命中。 */
    function scoreHitOf(raw) {
        const entry = recordOf(raw);
        return {
            id: countOrZero(entry["id"]),
            target: text(entry["target"]),
            assetIp: text(entry["asset_ip"]) || text(entry["assetIp"]),
            evidence: text(entry["evidence"]),
            note: text(entry["note"]),
            points: intOf(entry["points"]),
            service: text(entry["service"]),
            // 两个形态都读：Host 返回 snake_case，而模型函数也可能被已解析的对象再喂一次
            // （测试与「看板 → 表单 → 看板」的往返都会这样），只认 snake_case 会静默丢字段。
            selfCreated: entry["self_created"] === true || entry["selfCreated"] === true,
            capped: entry["capped"] === true,
            cappedReason: text(entry["capped_reason"]) || text(entry["cappedReason"]),
            recordedAt: text(entry["recorded_at"]) || text(entry["recordedAt"]),
            shotCount: countOrZero(entry["shot_count"]) || countOrZero(entry["shotCount"]),
        };
    }
    /** 命中的资产标签（`asset_ip` 优先，回退 `target`，都空则「未指定资产」）。 */
    function hitAssetLabel(hit) {
        if (hit.assetIp !== "")
            return hit.assetIp;
        if (hit.target !== "")
            return hit.target;
        return "未指定资产";
    }
    /**
     * 命中的证据文本。
     *
     * 原实现把换行压成空格（`String(evidence).replace(/\n+/g, ' ')`）——
     * 命中行是**一格**，多行证据会把行高撑爆，这是刻意的收敛。
     */
    function hitEvidenceText(hit) {
        return hit.evidence.replace(/\n+/g, " ");
    }
    /** 命中是否填了证据（决定渲染「未填账号密码/结果」还是证据文本）。 */
    function hitHasEvidence(hit) {
        return hit.evidence !== "";
    }
    /** 「复制这一条」要送进剪贴板的文本：`资产  证据`（两个空格分隔）。 */
    function hitCopyText(hit) {
        const asset = hit.assetIp !== "" ? hit.assetIp : hit.target;
        return asset + "  " + hit.evidence;
    }
    /** 命中的服务封顶标签（`服务已拿满 · 不计分（https）`）。 */
    function cappedLabel(hit) {
        return "服务已拿满 · 不计分" + (hit.service !== "" ? "（" + hit.service + "）" : "");
    }
    /** 命中封顶的 tooltip（后端没给理由时用默认口径）。 */
    function cappedTitle(hit) {
        return hit.cappedReason !== ""
            ? hit.cappedReason
            : "同一资产同一端口只算分值最高的一条，这条不计分";
    }
    /** 自建标记的 tooltip。 */
    exports.SELF_CREATED_TITLE = "自己注册/自建的账号不算得分权限，只作过程记录";
    /** 截图标记的 tooltip。 */
    exports.SHOT_COUNT_TITLE = "这条命中有证据截图（展开得分点即可看到代表图）";
    /** 解析一个得分点。 */
    function scorePointOf(raw) {
        const entry = recordOf(raw);
        return {
            id: countOrZero(entry["id"]),
            code: text(entry["code"]),
            name: text(entry["name"]),
            category: text(entry["category"]),
            points: intOf(entry["points"]),
            tier: text(entry["tier"]),
            cap: countOrZero(entry["cap"]),
            capUsed: countOrZero(entry["cap_used"]) || countOrZero(entry["capUsed"]),
            src: nullableNumber(entry["src"]),
            rule: nullableNumber(entry["rule"]),
            builtin: entry["builtin"] === true,
            enabled: entry["enabled"] !== false,
            description: text(entry["description"]),
            counted: countOrZero(entry["counted"]),
            earned: intOf(entry["earned"]),
            selfCreated: countOrZero(entry["self_created"]) || countOrZero(entry["selfCreated"]),
            capped: countOrZero(entry["capped"]),
            scopeLabel: text(entry["scope_label"]) || text(entry["scopeLabel"]),
            serviceSummary: text(entry["service_summary"]) || text(entry["serviceSummary"]),
            hits: arrayOf(entry["hits"]).map(scoreHitOf),
        };
    }
    /** 得分点是否已命中。 */
    function isAchieved(point) {
        return point.hits.length > 0;
    }
    /** 得分点行的分值徽章类名（命中用高亮，未命中用低亮）。 */
    function pointsBadgeClass(point) {
        return isAchieved(point) ? "rt-pri rt-pri-high" : "rt-pri rt-pri-low";
    }
    /**
     * 未命中的分值徽章额外样式。
     *
     * 原实现：`achieved ? {} : { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' }`
     * —— 返回 `null` 表示「不加额外样式」（命中时）。
     */
    function pointsBadgeStyle(point) {
        if (isAchieved(point))
            return null;
        return {
            background: "var(--dsw-alias-bg-layer-2)",
            color: "var(--dsw-alias-label-secondary)",
        };
    }
    /** 得分点行的名称文本（含档位后缀）。 */
    function pointNameText(point) {
        return point.name + (point.tier !== "" ? "　" + point.tier : "");
    }
    /** 命中列的文本：`N 次命中` 或 `未命中`。 */
    function countedText(point) {
        return point.hits.length > 0 ? point.counted + " 次命中" : "未命中";
    }
    /** 上限列的文本（无上限 → `null`，不渲染）。 */
    function capText(point) {
        return point.cap > 0 ? "　上限 " + point.capUsed + "/" + point.cap : null;
    }
    /** 命中列的 tooltip。 */
    function countedTitle(point) {
        if (point.capped > 0) {
            const scope = point.scopeLabel !== "" ? point.scopeLabel : "计分口径";
            return "已计入 " + point.counted + " 次，另有 " + point.capped
                + " 条因「" + scope + "」或已达上限不计分";
        }
        return point.scopeLabel;
    }
    /** 得分列文本：命中 → `+N 分`；未命中 → `—`。 */
    function earnedText(point) {
        return point.earned > 0 ? "+" + point.earned + " 分" : "—";
    }
    /** 详情里「状态」行的文本。 */
    function statusText(point) {
        return (point.enabled ? "启用" : "停用")
            + " · " + point.points + " 分/次"
            + " · 命中 " + point.hits.length + " 次"
            + " = " + point.earned + " 分"
            + (point.selfCreated > 0 ? "（另有 " + point.selfCreated + " 次自建不计分）" : "")
            + (point.capped > 0 ? "（另有 " + point.capped + " 次同服务重复命中不计分）" : "");
    }
    /** 详情里「命中记录」的标题。 */
    function hitsSectionTitle(point) {
        return "命中记录 · " + point.hits.length + "（只记资产与账号密码，详细复现见报告）";
    }
    /** 详情里「服务封顶」行的说明尾部。 */
    exports.SERVICE_CAP_SUFFIX = "；账号权限与数据库权限按「同资产同端口」只算一次，拿到最高权限账号即该服务拿满";
    /** 未命中时的提示（引导用户去记分，而不是干看空表）。 */
    exports.NO_HIT_HINT = "还没有 —— 拿下成果后用 redteam_score_hit 记分：写明目标资产 + 拿到的账号密码/权限";
    /** 解析一个分组。 */
    function scoreGroupOf(raw) {
        const entry = recordOf(raw);
        return {
            key: text(entry["key"]),
            name: text(entry["name"]),
            capSum: countOrZero(entry["capSum"]) || countOrZero(entry["cap_sum"]),
            points: intOf(entry["points"]),
            counted: countOrZero(entry["counted"]),
            capped: countOrZero(entry["capped"]),
            tiers: arrayOf(entry["tiers"]).map(scorePointOf),
        };
    }
    /**
     * 分组键（后端没给 `key` 时用的兜底）。
     *
     * 原实现直接用 `'g-' + g.key` 做 React key；`key` 缺失会撞成同一个 `g-`。
     * 这里补一个稳定兜底：`group-<序号>`。
     */
    function groupKeyOf(group, index) {
        return group.key !== "" ? group.key : "group-" + index;
    }
    /** 组头副标题：`N 项 · 各项上限合计 X 分（各项独立，不跨项累加）`。 */
    function groupSubtitle(group) {
        const head = group.tiers.length + " 项";
        return group.capSum > 0
            ? head + " · 各项上限合计 " + group.capSum + " 分（各项独立，不跨项累加）"
            : head;
    }
    /** 空汇总（未加载时的兜底，与原实现的字面量一致）。 */
    exports.EMPTY_SCORE_SUMMARY = Object.freeze({
        achievedPoints: 0,
        pointCount: 0,
        hitPointCount: 0,
        hitCount: 0,
        countedHits: 0,
        selfCreatedHits: 0,
        serviceCappedHits: 0,
    });
    /** 解析汇总。 */
    function summaryOf(raw) {
        const entry = recordOf(raw);
        return {
            achievedPoints: intOf(entry["achievedPoints"]) || intOf(entry["achieved_points"]),
            pointCount: countOrZero(entry["pointCount"]) || countOrZero(entry["point_count"]),
            hitPointCount: countOrZero(entry["hitPointCount"]) || countOrZero(entry["hit_point_count"]),
            hitCount: countOrZero(entry["hitCount"]) || countOrZero(entry["hit_count"]),
            countedHits: countOrZero(entry["countedHits"]) || countOrZero(entry["counted_hits"]),
            selfCreatedHits: countOrZero(entry["selfCreatedHits"]) || countOrZero(entry["self_created_hits"]),
            serviceCappedHits: countOrZero(entry["serviceCappedHits"]) || countOrZero(entry["service_capped_hits"]),
        };
    }
    /** 自建不计分的 tooltip。 */
    exports.SELF_CREATED_SUMMARY_TITLE = "自己注册/自己创建的账号不算得分权限，只作过程记录（不计分、不占上限、不进报告）";
    /** 服务已拿满的 tooltip。 */
    exports.SERVICE_CAPPED_SUMMARY_TITLE = "账号权限与数据库权限按「同资产同端口」只算一次：该服务已拿满，这些重复命中不计分（只作留痕）";
    /**
     * 解析 `op: scores` 的响应。
     *
     * **兼容分支**：后端没给 `ruleGroups`（老 host）时退回一个匿名总组 ——
     * 原先平铺的 `items` 直接塞进 `tiers`，组头因为 `name === ''` 而不渲染。
     * 这条分支丢了的话，老 host 上得分项会**整片消失**。
     */
    function scoreBoardOf(response) {
        const body = recordOf(response);
        const items = arrayOf(body["items"]).map(scorePointOf);
        const rawGroups = arrayOf(body["ruleGroups"]);
        const grouped = rawGroups.length > 0;
        const groups = grouped
            ? rawGroups.map(scoreGroupOf)
            : [{
                    key: "all",
                    name: "",
                    capSum: 0,
                    points: 0,
                    counted: 0,
                    capped: 0,
                    tiers: items,
                }];
        return {
            items,
            groups,
            summary: summaryOf(body["summary"]),
            grouped,
        };
    }
    /** 从错误响应里取错误文案。 */
    function errorOf(response, fallback) {
        if (response === null || response === undefined)
            return fallback;
        const body = recordOf(response);
        if (body["ok"] !== false)
            return null;
        const message = body["error"];
        return typeof message === "string" && message !== "" ? message : fallback;
    }
    /** 空表单的默认值（与原实现的 `startNew` 一致：分值默认 10、启用）。 */
    exports.DEFAULT_POINTS = 10;
    /** 新增表单。 */
    function newScoreForm() {
        return {
            id: null,
            name: "",
            category: "",
            points: exports.DEFAULT_POINTS,
            description: "",
            enabled: true,
            builtin: false,
            src: null,
            cap: 0,
            rule: null,
        };
    }
    /** 由已有得分点造编辑表单。 */
    function editFormOf(point) {
        return {
            id: point.id,
            name: point.name,
            category: point.category,
            points: point.points,
            description: point.description,
            enabled: point.enabled,
            builtin: point.builtin,
            src: point.src,
            cap: point.cap,
            rule: point.rule,
        };
    }
    /** 改一个字段（返回新表单）。 */
    function withFormField(form, key, value) {
        return { ...form, [key]: value };
    }
    /** 校验表单。 */
    function checkForm(form) {
        if (form.name === "")
            return (0, result_js_2.err)("名称不能为空");
        return (0, result_js_2.ok)(form);
    }
    /** 该字段是否锁定（渲染层据此 `readOnly`）。内置项的名称/分类/分值/说明全部锁定。 */
    function isFieldLocked(form) {
        return form.builtin;
    }
    /** 字段锁定的 tooltip（空串 = 不锁，不渲染 title）。 */
    function lockedTitle(form, field) {
        if (!form.builtin)
            return "";
        switch (field) {
            case "name":
                return "内置得分点的名称由规则锁定";
            case "category":
                return "内置得分点的分类由规则锁定（决定它属于面板哪一组）";
            case "points":
                return "内置得分点的分值由《得分规则》锁定，不能在这里改";
            case "description":
                return "内置得分点的条款正文由规则锁定";
        }
    }
    /** 分值输入框的 tooltip（非内置项）。 */
    exports.POINTS_HINT = "这一类的单次分值；每命中一次就按这个分值累加（受该条规则上限约束）";
    /** 内置项的提示标题。 */
    exports.BUILTIN_NOTICE_TITLE = "内置得分点（来自《突破入侵类得分规则（合并版）》）";
    /** 内置项的提示正文。 */
    exports.BUILTIN_NOTICE_BODY = "分值、上限、计分口径与名称由规则锁定 —— 同一条规则的上限按组内所有得分点累计，"
        + "单独改分值会让一条命中吃掉整组上限。这里可以改「启用 / 停用」；"
        + "要自定义分值时请返回上一屏点「+ 新增得分点」。";
    /** 内置项的「不能删除」按钮文案。 */
    exports.BUILTIN_DELETE_LABEL = "删除（内置项不可删）";
    /** 内置项「不能删除」的 tooltip。 */
    exports.BUILTIN_DELETE_TITLE = "内置得分点不能删除：删掉会让面板缺一条规则、报告少一类成果（下次启动还会自动补回来）。"
        + "要让它不参与计分请改用「停用」。";
    /** 内置项提示里的规则原文行（`null` = 不渲染）。 */
    function builtinRuleText(form) {
        if (form.src === null && form.rule === null && form.cap === 0)
            return null;
        const parts = [];
        if (form.src !== null)
            parts.push("规则原文序号 " + form.src);
        if (form.rule !== null)
            parts.push("上限分组 rule=" + form.rule);
        parts.push(form.cap > 0 ? "上限 " + form.cap + " 分" : "不设上限");
        return parts.join("　·　");
    }
    /**
     * 「已保存」那条特殊消息：内置项分值未被采纳。
     *
     * 原实现逐字如此（含换行拼接的文案）。**不能简化成「已保存」** ——
     * 那会让用户以为分值改成功了，而这正是之前的 bug 报告。
     */
    exports.OVERRIDDEN_MESSAGE = "已保存「启用/停用」。分值未改动：这是随《得分规则》分发的内置得分点，"
        + "分值 / 上限 / 计分口径由规则锁定（同一条规则的上限按组内所有得分点累计，"
        + "单独改分值会让一条命中吃掉整组上限）。要自定义分值时请「+ 新增得分点」。";
    /** 解析保存响应。 */
    function saveOutcomeOf(response) {
        const error = errorOf(response, "保存失败");
        if (error !== null)
            return { message: { err: error }, closeForm: false, reload: false };
        const body = recordOf(response);
        // `overridden === false` 表示后端**没采纳**提交的分值（内置点由规则锁定）。
        if (body["overridden"] === false) {
            return { message: { err: exports.OVERRIDDEN_MESSAGE }, closeForm: true, reload: true };
        }
        const note = text(body["note"]);
        return { message: { ok: note !== "" ? note : "已保存" }, closeForm: true, reload: true };
    }
    /** 解析删除响应。 */
    function deleteOutcomeOf(response) {
        const error = errorOf(response, "删除失败");
        if (error !== null) {
            return { message: { err: error }, closeForm: false, closeDetail: false, reload: false };
        }
        return { message: { ok: "已删除" }, closeForm: true, closeDetail: true, reload: true };
    }
    /** 删除前的判定：新增表单（没有 id）不需要发请求，直接关掉表单。 */
    function shouldSkipDelete(form) {
        return form === null || form.id === null;
    }
    /* ══════════════════════════════════════════════════════════════ 请求 */
    /** 请求 `op: scores`。 */
    function scoresRequest(engagement) {
        return { op: "scores", engagement };
    }
    /** 请求 `op: saveScorePoint`（`point` 就是整个表单）。 */
    function saveRequest(engagement, form) {
        return { op: "saveScorePoint", engagement, point: form };
    }
    /** 请求 `op: deleteScorePoint`。 */
    function deleteRequest(engagement, id) {
        return { op: "deleteScorePoint", engagement, id };
    }
    /** 加载看板。 */
    async function loadScores(api, engagement) {
        const response = await api.raw(scoresRequest(engagement));
        const error = errorOf(response, "读取失败");
        if (error !== null)
            return (0, result_js_2.err)(error);
        return (0, result_js_2.ok)(scoreBoardOf(response));
    }
    /** 保存得分点。 */
    async function saveScorePoint(api, engagement, form) {
        const checked = checkForm(form);
        if (!checked.ok)
            return { message: { err: checked.error }, closeForm: false, reload: false };
        const response = await api.raw(saveRequest(engagement, form));
        return saveOutcomeOf(response);
    }
    /** 删除得分点。 */
    async function removeScorePoint(api, engagement, id) {
        const response = await api.raw(deleteRequest(engagement, id));
        return deleteOutcomeOf(response);
    }
    /* ══════════════════════════════════════════════════════════════ 空态 */
    /** 未选靶标时的提示。 */
    exports.NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看得分目标。";
    /** 无得分点时的空态。 */
    exports.EMPTY_POINTS_TEXT = "暂无得分点，点右上角「新增得分点」";
    /** 平坦分组键（渲染 key 用）。 */
    function groupRowKey(group, index) {
        return "g-" + groupKeyOf(group, index);
    }
    /** 详情行 key。 */
    function detailRowKey(point) {
        return "spd" + point.id;
    }
    /** 命中行 key。 */
    function hitRowKey(hit) {
        return "h" + hit.id;
    }
});
/**
 * 得分目标页（`scores` 页签）的渲染。
 *
 * 数据与保存语义全在 `score-model.ts`，这里只排版。
 *
 * ## 布局
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────┐
 * │ 得分目标  总分 320 分  42 个得分点  命中 9 次  [新增] [刷新]   │
 * ├──────────────────────────────────────────────────────────────┤
 * │ 一、获取权限 · 12 项 · 各项上限合计 300 分（各项独立…）  +120 分│
 * │ ▸ 10分 服务器主机权限        3 次命中  上限 50/50   +50 分    │
 * │ ▾ 10分 域名控制权限          1 次命中              +20 分    │
 * │     得分条件 / 状态 / 命中记录…                               │
 * └──────────────────────────────────────────────────────────────┘
 *
 * ## 一个真实的产品决策，这里保留
 *
 * 内置得分点（`builtin`）的名称/分类/分值/说明**全部 `readOnly`**，
 * 删除按钮**禁用**。原因写在 `BUILTIN_NOTICE_BODY` 里：同一条规则的上限
 * 按组内所有得分点累计，单独改分值会让一条命中吃掉整组上限。
 * 以前界面「能改、提示已保存、刷新后变回去」，用户以为是 bug。
 */
define("redteam/client/score-tab", ["require", "exports", "redteam/client/helpers", "redteam/client/score-model"], function (require, exports, helpers_js_12, score_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderScoreTab = renderScoreTab;
    exports.defaultScoreProps = defaultScoreProps;
    exports.checkedOf = checkedOf;
    /** 从事件里读 input 的值。 */
    function inputValue(event) {
        const target = event.target;
        return typeof target?.value === "string" ? target.value : "";
    }
    /** 从事件里读 checkbox 的勾选态。 */
    function checkedOf(event) {
        const target = event.target;
        return target?.checked === true;
    }
    /** 工具栏。 */
    function toolbar(runtime, props) {
        const { h } = runtime;
        const summary = props.board?.summary ?? score_model_js_1.EMPTY_SCORE_SUMMARY;
        return h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "得分目标"), 
        // 只显示已拿下的总分，不显示目标分数、不显示进度条。
        h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)", marginLeft: 4 } }, "总分"), h("span", { className: "rt-total" }, String(summary.achievedPoints)), h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, "分"), h("span", { className: "rt-tag" }, summary.pointCount + " 个得分点"), h("span", { className: "rt-tag" }, "命中 " + summary.countedHits + " 次"), summary.selfCreatedHits > 0
            ? h("span", { className: "rt-tag rt-tag-warn", title: score_model_js_1.SELF_CREATED_SUMMARY_TITLE }, "自建不计分 " + summary.selfCreatedHits)
            : null, summary.serviceCappedHits > 0
            ? h("span", { className: "rt-tag rt-tag-warn", title: score_model_js_1.SERVICE_CAPPED_SUMMARY_TITLE }, "服务已拿满不计分 " + summary.serviceCappedHits)
            : null, h("div", { className: "rt-spacer" }), h("button", { className: "rt-btn", onClick: () => props.onNew() }, "+ 新增得分点"), h("button", {
            className: "rt-btn",
            disabled: props.busy,
            onClick: () => props.onRefresh(),
        }, props.busy ? "刷新中…" : "刷新"));
    }
    /** 表单面板。 */
    function formPane(runtime, props) {
        const { h } = runtime;
        const form = props.form;
        if (form === null)
            return null;
        const locked = (0, score_model_js_1.isFieldLocked)(form);
        const ruleText = (0, score_model_js_1.builtinRuleText)(form);
        return h("div", {
            className: "rt-pane",
            style: { flex: "none", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
        }, 
        // 内置项的说明：分值 / 上限 / 口径由《得分规则》锁定。
        form.builtin
            ? h("div", { className: "rt-hint", style: { marginBottom: 8 } }, h("b", null, score_model_js_1.BUILTIN_NOTICE_TITLE), h("div", { style: { marginTop: 3 } }, score_model_js_1.BUILTIN_NOTICE_BODY), ruleText !== null
                ? h("div", { style: { marginTop: 3, color: "var(--dsw-alias-label-secondary)" } }, ruleText)
                : null)
            : null, h("div", { className: "rt-score-form" }, h("input", {
            className: "rt-input",
            placeholder: "名称（必填）",
            value: form.name,
            readOnly: locked,
            title: (0, score_model_js_1.lockedTitle)(form, "name"),
            onChange: (event) => props.onFormChange({ ...form, name: inputValue(event) }),
        }), h("input", {
            className: "rt-input",
            placeholder: "分类，如 账号权限",
            value: form.category,
            readOnly: locked,
            title: (0, score_model_js_1.lockedTitle)(form, "category"),
            onChange: (event) => props.onFormChange({ ...form, category: inputValue(event) }),
        }), h("input", {
            className: "rt-input",
            type: "number",
            placeholder: "单次分值",
            readOnly: locked,
            title: locked ? (0, score_model_js_1.lockedTitle)(form, "points") : score_model_js_1.POINTS_HINT,
            value: form.points,
            onChange: (event) => {
                const parsed = Number(inputValue(event));
                props.onFormChange({ ...form, points: Number.isFinite(parsed) ? parsed : 0 });
            },
        }), h("select", {
            className: "rt-input",
            value: form.enabled ? "1" : "0",
            onChange: (event) => props.onFormChange({ ...form, enabled: inputValue(event) === "1" }),
        }, h("option", { value: "1" }, "启用"), h("option", { value: "0" }, "停用"))), h("input", {
            className: "rt-input",
            style: { width: "100%", marginBottom: 6, boxSizing: "border-box" },
            placeholder: "得分条件说明",
            value: form.description,
            readOnly: locked,
            title: locked ? (0, score_model_js_1.lockedTitle)(form, "description") : "",
            onChange: (event) => props.onFormChange({ ...form, description: inputValue(event) }),
        }), h("div", { className: "rt-actions" }, h("button", {
            className: "rt-btn rt-btn-primary",
            disabled: props.busy,
            onClick: () => props.onSave(),
        }, "保存"), form.id !== null
            ? (form.builtin
                ? h("button", {
                    className: "rt-btn",
                    disabled: true,
                    title: score_model_js_1.BUILTIN_DELETE_TITLE,
                }, score_model_js_1.BUILTIN_DELETE_LABEL)
                : h("button", {
                    className: "rt-btn",
                    disabled: props.busy,
                    onClick: () => props.onRemove(),
                }, "删除"))
            : null, h("button", { className: "rt-btn", onClick: () => props.onCancel() }, "取消")));
    }
    /** 一条命中的行。 */
    function hitRow(runtime, props, hit, index) {
        const { h } = runtime;
        return h("div", {
            key: (0, score_model_js_1.hitRowKey)(hit),
            className: "rt-hit-row" + (hit.selfCreated ? " self-created" : "") + (hit.capped ? " service-capped" : ""),
        }, h("span", { className: "rt-hit-idx" }, String(index + 1)), h("span", { className: "rt-hit-asset", title: hit.target !== "" ? hit.target : hit.assetIp }, (0, score_model_js_1.hitAssetLabel)(hit)), hit.selfCreated
            ? h("span", { className: "rt-tag rt-tag-warn", title: score_model_js_1.SELF_CREATED_TITLE }, "自建 · 不计分")
            : null, hit.capped
            ? h("span", { className: "rt-tag rt-tag-warn", title: (0, score_model_js_1.cappedTitle)(hit) }, (0, score_model_js_1.cappedLabel)(hit))
            : null, hit.shotCount > 0
            ? h("span", { className: "rt-tag", title: score_model_js_1.SHOT_COUNT_TITLE }, "图 " + hit.shotCount)
            : null, h("span", { className: "rt-hit-time" }, (0, helpers_js_12.formatTimestamp)(hit.recordedAt)), h("button", {
            className: "rt-btn",
            style: { padding: "0 5px", fontSize: 10.5 },
            title: "复制这一条",
            onClick: (event) => {
                event.stopPropagation?.();
                props.onCopy((0, score_model_js_1.hitCopyText)(hit));
            },
        }, "复制"), (0, score_model_js_1.hitHasEvidence)(hit)
            ? h("span", { className: "rt-hit-txt", title: hit.evidence }, (0, score_model_js_1.hitEvidenceText)(hit))
            : h("span", { className: "rt-hit-txt none" }, "未填账号密码/结果"));
    }
    /** 展开后的得分点详情。 */
    function pointDetail(runtime, props, point) {
        const { h } = runtime;
        return h("div", {
            key: (0, score_model_js_1.detailRowKey)(point),
            className: "rt-score-row",
            style: { cursor: "default", gridTemplateColumns: "1fr" },
        }, h("div", { className: "rt-score-detail" }, point.description !== ""
            ? h("div", { className: "rt-kv" }, h("b", null, "得分条件"), h("span", null, point.description))
            : null, h("div", { className: "rt-kv" }, h("b", null, "状态"), h("span", null, (0, score_model_js_1.statusText)(point))), point.capped > 0
            ? h("div", { className: "rt-kv" }, h("b", null, "服务封顶"), h("span", null, point.serviceSummary + score_model_js_1.SERVICE_CAP_SUFFIX))
            : null, point.hits.length > 0
            ? h("div", null, h("div", { className: "rt-section", style: { padding: "6px 0 0" } }, (0, score_model_js_1.hitsSectionTitle)(point)), h("div", { className: "rt-hits" }, point.hits.map((hit, index) => hitRow(runtime, props, hit, index))))
            : h("div", { className: "rt-kv" }, h("b", null, "命中记录"), h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, score_model_js_1.NO_HIT_HINT)), h("div", { className: "rt-actions" }, h("button", {
            className: "rt-btn",
            onClick: (event) => {
                event.stopPropagation?.();
                props.onEdit(point);
            },
        }, "编辑"))));
    }
    /** 一个得分点行（未展开时的行）。 */
    function pointRow(runtime, props, point) {
        const { h } = runtime;
        const open = props.openId === point.id;
        const achieved = (0, score_model_js_1.isAchieved)(point);
        const badgeStyle = (0, score_model_js_1.pointsBadgeStyle)(point);
        const cap = (0, score_model_js_1.capText)(point);
        return h("div", {
            key: "sp" + point.id,
            className: "rt-score-row",
            ...(0, helpers_js_12.clickable)(() => props.onToggle(point.id), {
                label: "展开得分点 " + point.name,
                expanded: open,
            }),
        }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), h("span", null, h("span", {
            className: (0, score_model_js_1.pointsBadgeClass)(point),
            ...(badgeStyle !== null ? { style: badgeStyle } : {}),
        }, point.points + "分")), h("span", { title: point.description }, (0, score_model_js_1.pointNameText)(point)), h("span", { title: (0, score_model_js_1.countedTitle)(point) }, h("span", { className: "rt-sec-count" }, (0, score_model_js_1.countedText)(point)), cap !== null ? h("span", { className: "rt-scope" }, cap) : null), h("span", { style: { textAlign: "right" } }, achieved || point.earned > 0
            ? h("span", { className: "rt-tag rt-tag-active" }, (0, score_model_js_1.earnedText)(point))
            : h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, "—")));
    }
    /** 一组得分点（含组头）。 */
    function groupBlock(runtime, props, group, index) {
        const { h } = runtime;
        const out = [];
        if (group.name !== "") {
            out.push(h("div", { key: "g-" + (0, score_model_js_1.groupKeyOf)(group, index), className: "rt-score-group" }, h("span", null, group.name), h("span", { className: "rt-sg-sub" }, (0, score_model_js_1.groupSubtitle)(group)), h("div", { className: "rt-spacer" }), group.points > 0
                ? h("span", { className: "rt-tag rt-tag-active" }, "+" + group.points + " 分")
                : null));
        }
        for (const point of group.tiers) {
            out.push(pointRow(runtime, props, point));
            if (props.openId === point.id)
                out.push(pointDetail(runtime, props, point));
        }
        return out;
    }
    /**
     * 渲染得分目标页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderScoreTab(runtime, props) {
        const { h } = runtime;
        if (props.engagement === null || props.engagement === "") {
            return h("div", { className: "rt-main" }, h("div", { className: "rt-empty" }, score_model_js_1.NO_ENGAGEMENT_TEXT));
        }
        const board = props.board;
        const items = board?.items ?? [];
        const groups = board?.groups ?? [];
        const rows = [];
        groups.forEach((group, index) => {
            rows.push(...groupBlock(runtime, props, group, index));
        });
        const message = props.message;
        const head = h("div", { className: "rt-score-row head" }, h("span", null, ""), h("span", null, "分值"), h("span", null, "得分点（按分值从低到高）"), h("span", null, "命中 / 上限"), h("span", { style: { textAlign: "right" } }, "已得分"));
        return h("div", { className: "rt-main" }, toolbar(runtime, props), message !== null
            ? h("div", { className: message.err !== undefined ? "rt-err" : "rt-foot" }, message.err ?? message.ok ?? "")
            : null, props.error !== null ? h("div", { className: "rt-err" }, props.error) : null, formPane(runtime, props), h("div", { className: "rt-table" }, head, rows, items.length === 0 ? h("div", { className: "rt-empty" }, score_model_js_1.EMPTY_POINTS_TEXT) : null));
    }
    /** 默认 props（供测试与未接线场景）。 */
    function defaultScoreProps(engagement) {
        return {
            engagement,
            board: null,
            error: null,
            busy: false,
            openId: null,
            form: null,
            message: null,
            onRefresh: () => undefined,
            onToggle: () => undefined,
            onEdit: () => undefined,
            onNew: () => undefined,
            onFormChange: () => undefined,
            onSave: () => undefined,
            onRemove: () => undefined,
            onCancel: () => undefined,
            onCopy: () => undefined,
        };
    }
});
/**
 * 会话隧道页（`sessions` 页签）的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `SessionTab`（242 行）里真正复杂的是**三条提示的判定**与**卡片文案**，
 * 而不是排版：
 *
 * 1. 有 WebShell 不是冰蝎/哥斯拉 → 提示「用户连不上」。判定是**正则**：
 *    `/behinder|godzilla|冰蝎|哥斯拉/i`，覆盖中英文与大小写（用户可能填
 *    `Behinder`、`冰蝎`、`BEHINDER`）。
 * 2. 有隧道但**一条都不算突破** → 提示「现有 N 条通道都不算跨越靶标边界」。
 *    判定是 `legit === true`；`legit === null`（未声明 `entry_kind`）**不算**。
 * 3. 有 WebShell 但没有可用 suo5 → 提示「还没有可用的 suo5 隧道」。
 *    判定是 `kind` 匹配 `/suo5/i` **且** `status === 'active'`。
 *
 * 三条提示是**独立**的（可以同时出现），且顺序固定为 1 → 3 → 2（原实现的
 * push 顺序是 badShells、legitTunnels、activeSuo5，但渲染顺序就是 push 顺序）。
 * 等等 —— 原实现的实际顺序是 h1、h3、h2，这里逐字保留。
 */
define("redteam/client/session-model", ["require", "exports", "shared/result"], function (require, exports, result_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.COPIED_RESET_MS = exports.EMPTY_TUNNELS_TEXT = exports.EMPTY_SHELLS_TEXT = exports.EMPTY_DETAIL = exports.EMPTY_TITLE = exports.NO_ENGAGEMENT_TEXT = exports.PROBE_TIMEOUT_MS = exports.HINT_SUMMARY = exports.EMPTY_TOTALS = void 0;
    exports.webShellOf = webShellOf;
    exports.isEncryptedShell = isEncryptedShell;
    exports.shellTypeText = shellTypeText;
    exports.shellCopyCommand = shellCopyCommand;
    exports.lastCheckText = lastCheckText;
    exports.tunnelOf = tunnelOf;
    exports.isSuo5 = isSuo5;
    exports.tunnelProxy = tunnelProxy;
    exports.gogoCommand = gogoCommand;
    exports.fscanCommand = fscanCommand;
    exports.legitKindOf = legitKindOf;
    exports.legitLabel = legitLabel;
    exports.legitTitle = legitTitle;
    exports.legitClass = legitClass;
    exports.legitFactText = legitFactText;
    exports.sessionDataOf = sessionDataOf;
    exports.statusDotClass = statusDotClass;
    exports.sessionHints = sessionHints;
    exports.probeSummaryOf = probeSummaryOf;
    exports.sessionsRequest = sessionsRequest;
    exports.probeRequest = probeRequest;
    exports.updateTunnelRequest = updateTunnelRequest;
    exports.updateWebshellRequest = updateWebshellRequest;
    exports.loadSessions = loadSessions;
    exports.probeSessions = probeSessions;
    exports.markTunnel = markTunnel;
    exports.markShell = markShell;
    exports.copyMessage = copyMessage;
    exports.isCopied = isCopied;
    exports.shellCopyKey = shellCopyKey;
    exports.tunnelListenKey = tunnelListenKey;
    exports.tunnelCommandKey = tunnelCommandKey;
    exports.tunnelGogoKey = tunnelGogoKey;
    exports.tunnelFscanKey = tunnelFscanKey;
    /* ══════════════════════════════════════════════════════════════ 窄化原语 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    function arrayOf(value) {
        return Array.isArray(value) ? value : [];
    }
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 可空数字（延迟毫秒）。 */
    function nullableNumber(value) {
        if (value === null || value === undefined)
            return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 解析一个 WebShell。 */
    function webShellOf(raw) {
        const entry = recordOf(raw);
        return {
            id: countOrZero(entry["id"]),
            url: text(entry["url"]),
            shellType: text(entry["shell_type"]) || text(entry["shellType"]),
            passKey: text(entry["pass_key"]) || text(entry["passKey"]),
            secretRef: text(entry["secret_ref"]) || text(entry["secretRef"]),
            privilege: text(entry["privilege"]),
            status: text(entry["status"]),
            lastCheck: text(entry["last_check"]) || text(entry["lastCheck"]),
            checkNote: text(entry["check_note"]) || text(entry["checkNote"]),
            latencyMs: nullableNumber(entry["latency_ms"]) ?? nullableNumber(entry["latencyMs"]),
            note: text(entry["note"]),
            assetIp: text(entry["asset_ip"]) || text(entry["assetIp"]),
        };
    }
    /**
     * 是否是冰蝎/哥斯拉加密马。
     *
     * **交付红线**：只有加密马用户能用客户端直连；一句话马/自研马在界面上
     * 看着像入口，实际交付不出去。判定用正则覆盖中英文写法。
     */
    function isEncryptedShell(shellType) {
        return /behinder|godzilla|冰蝎|哥斯拉/i.test(shellType);
    }
    /** WebShell 卡片的类型说明。 */
    function shellTypeText(shell) {
        return isEncryptedShell(shell.shellType)
            ? "加密马（冰蝎/哥斯拉，用户可直连）"
            : "非加密马 —— 用户连不上，仅可作临时中转";
    }
    /** 「复制 URL」要复制的命令（`curl -s "URL"`）。 */
    function shellCopyCommand(shell) {
        return 'curl -s "' + shell.url + '"';
    }
    /** 「最后检测」的文本（含延迟）。 */
    function lastCheckText(lastCheck, latencyMs, timeText) {
        const when = lastCheck !== "" ? timeText : "未检测";
        return latencyMs !== null ? when + "（" + latencyMs + "ms）" : when;
    }
    /** 解析一条隧道。 */
    function tunnelOf(raw) {
        const entry = recordOf(raw);
        const legitRaw = entry["legit"];
        return {
            id: countOrZero(entry["id"]),
            kind: text(entry["kind"]),
            listen: text(entry["listen"]),
            entry: text(entry["entry"]),
            reach: text(entry["reach"]),
            entryKind: text(entry["entry_kind"]) || text(entry["entryKind"]),
            entryKindLabel: text(entry["entry_kind_label"]) || text(entry["entryKindLabel"]),
            status: text(entry["status"]),
            lastCheck: text(entry["last_check"]) || text(entry["lastCheck"]),
            checkNote: text(entry["check_note"]) || text(entry["checkNote"]),
            latencyMs: nullableNumber(entry["latency_ms"]) ?? nullableNumber(entry["latencyMs"]),
            command: text(entry["command"]),
            note: text(entry["note"]),
            assetIp: text(entry["asset_ip"]) || text(entry["assetIp"]),
            // 三态：true / false / null（未声明）。**不能**用 `=== true` 压成布尔。
            legit: legitRaw === true ? true : legitRaw === false ? false : null,
        };
    }
    /** 是否是 suo5 通道（内网突破的标准通道）。 */
    function isSuo5(kind) {
        return /suo5/i.test(kind);
    }
    /** 隧道的代理地址（`socks5://host:port`，无监听地址 → 空串）。 */
    function tunnelProxy(tunnel) {
        return tunnel.listen !== "" ? "socks5://" + tunnel.listen : "";
    }
    /**
     * 走这条隧道跑 gogo 的命令。
     *
     * 原实现逐字：
     * `./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy socks5://listen`
     */
    function gogoCommand(tunnel) {
        if (tunnel.listen === "")
            return "";
        return "./gogo -i <内网CIDR> -m ss --ping -p top2,win,db --proxy " + tunnelProxy(tunnel);
    }
    /**
     * 走这条隧道跑 fscan 的命令。
     *
     * 原实现逐字：
     * `./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 listen -o intranet.txt`
     */
    function fscanCommand(tunnel) {
        if (tunnel.listen === "")
            return "";
        return "./fscan -h <内网CIDR> -np -nobr -nopoc -socks5 " + tunnel.listen + " -o intranet.txt";
    }
    /** 归一键。 */
    function legitKindOf(tunnel) {
        if (tunnel.legit === true)
            return "legit";
        if (tunnel.legit === false)
            return "self-only";
        return "unknown";
    }
    /** 徽章文案。 */
    function legitLabel(tunnel) {
        switch (legitKindOf(tunnel)) {
            case "legit":
                return "目标侧通道";
            case "self-only":
                return "不算突破";
            case "unknown":
                return "待确认";
        }
    }
    /** 徽章的 tooltip。 */
    function legitTitle(tunnel) {
        switch (legitKindOf(tunnel)) {
            case "legit":
                return tunnel.entryKindLabel;
            case "self-only":
                return "只在自己 VPS/自建服务器上开的通道，没有碰到目标 —— 不算边界突破/内网突破";
            case "unknown":
                return "未声明 entry_kind：请说明目标侧的那一端是什么（target-outbound / target-http / target-agent）";
        }
    }
    /** 徽章的类名。 */
    function legitClass(tunnel) {
        switch (legitKindOf(tunnel)) {
            case "legit":
                return "rt-tag rt-tag-live";
            case "self-only":
                return "rt-tag rt-tag-warn";
            case "unknown":
                return "rt-tag";
        }
    }
    /** 详情里「跨越边界」行的值（纯文本）。 */
    function legitFactText(tunnel) {
        switch (legitKindOf(tunnel)) {
            case "legit":
                return tunnel.entryKindLabel !== "" ? tunnel.entryKindLabel : (tunnel.entryKind !== "" ? tunnel.entryKind : "已确认目标侧");
            case "self-only":
                return "不算突破（只在自己 VPS 上开代理）";
            case "unknown":
                return "未声明 entry_kind，待确认";
        }
    }
    /** 空计数。 */
    exports.EMPTY_TOTALS = Object.freeze({
        webshells: 0,
        webshellsOnline: 0,
        tunnels: 0,
        tunnelsActive: 0,
        credentials: 0,
        access: 0,
    });
    /** 解析 `op: sessions` 的响应。 */
    function sessionDataOf(response) {
        const body = recordOf(response);
        const totals = recordOf(body["totals"]);
        return {
            shells: arrayOf(body["webshells"]).map(webShellOf),
            tunnels: arrayOf(body["tunnels"]).map(tunnelOf),
            totals: {
                webshells: countOrZero(totals["webshells"]),
                webshellsOnline: countOrZero(totals["webshellsOnline"]) || countOrZero(totals["webshells_online"]),
                tunnels: countOrZero(totals["tunnels"]),
                tunnelsActive: countOrZero(totals["tunnelsActive"]) || countOrZero(totals["tunnels_active"]),
                credentials: countOrZero(totals["credentials"]),
                access: countOrZero(totals["access"]),
            },
        };
    }
    /** 状态点类名。
     *
     * 原实现：`s === 'online' || s === 'active' ? 'rt-dot-on' : (s === 'unknown' || !s ? 'rt-dot-unk' : 'rt-dot-off')`
     * —— `null`/`undefined`/空串都算「未知」，不是「离线」。
     */
    function statusDotClass(status) {
        if (status === "online" || status === "active")
            return "rt-dot-on";
        if (status === "unknown" || status === "")
            return "rt-dot-unk";
        return "rt-dot-off";
    }
    /** 折叠条的展开文案。 */
    exports.HINT_SUMMARY = "怎么做（点击展开）";
    /** 判定要显示的提示（顺序与原实现一致：坏马 → 无 suo5 → 全不算突破）。 */
    function sessionHints(data) {
        const hints = [];
        const badShells = data.shells.filter((shell) => !isEncryptedShell(shell.shellType));
        if (badShells.length > 0) {
            hints.push({
                key: "h1",
                title: "有 " + badShells.length + " 个入口不是冰蝎马/哥斯拉马（用户连不上，不算可交付入口）",
                detail: "用技能 webshell-toolkit 重新上传冰蝎马（behinder）或哥斯拉马（godzilla），"
                    + "并把 shell_type + pass_key 写进 redteam_webshell_add。只作临时中转的可在备注里写明。",
            });
        }
        const legitTunnels = data.tunnels.filter((tunnel) => tunnel.legit === true);
        if (data.tunnels.length > 0 && legitTunnels.length === 0) {
            hints.push({
                key: "h3",
                title: "现有 " + data.tunnels.length + ' 条通道都不算"跨越靶标边界"（不算边界/内网突破）',
                detail: "自己的 VPS / 自建服务器上开的 socks5、frp、代理不算隧道。必须是目标侧发起的通道："
                    + "目标反弹 shell 到我方、目标上跑 frp/Stowaway 客户端、或经目标 WebShell 建的 suo5/HTTP 隧道；"
                    + "登记时用 entry_kind 说明。",
            });
        }
        const activeSuo5 = data.tunnels.filter((tunnel) => isSuo5(tunnel.kind) && tunnel.status === "active");
        if (data.shells.length > 0 && activeSuo5.length === 0) {
            hints.push({
                key: "h2",
                title: "还没有可用的 suo5 隧道（打进内网的标准通道）",
                detail: "用技能 suo5-tunnel 通过上面的 WebShell 建 socks5 隧道，再 redteam_tunnel_add"
                    + "（kind=suo5、listen=127.0.0.1:1080、entry=WebShell URL、reach=可达网段）登记，"
                    + "最后点「检测连通性」确认 status=active。",
            });
        }
        return hints;
    }
    /** 从 `op: probeSessions` 的响应算摘要。 */
    function probeSummaryOf(response) {
        const body = recordOf(response);
        const shells = arrayOf(body["webshells"]);
        const tunnels = arrayOf(body["tunnels"]);
        const onlineShells = shells.filter((raw) => text(recordOf(raw)["status"]) === "online").length;
        const activeTunnels = tunnels.filter((raw) => text(recordOf(raw)["status"]) === "active").length;
        return {
            onlineShells,
            totalShells: shells.length,
            activeTunnels,
            totalTunnels: tunnels.length,
            message: "检测完成：WebShell 在线 " + onlineShells + "/" + shells.length
                + "，隧道可用 " + activeTunnels + "/" + tunnels.length,
        };
    }
    /** 检测请求的超时（毫秒，原实现写死 6000）。 */
    exports.PROBE_TIMEOUT_MS = 6000;
    /* ══════════════════════════════════════════════════════════════ 请求 */
    /** 请求 `op: sessions`。 */
    function sessionsRequest(engagement) {
        return { op: "sessions", engagement };
    }
    /** 请求 `op: probeSessions`。 */
    function probeRequest(engagement) {
        return { op: "probeSessions", engagement, timeoutMs: exports.PROBE_TIMEOUT_MS };
    }
    /** 标记隧道的请求。 */
    function updateTunnelRequest(engagement, id, status) {
        return {
            op: "updateTunnel",
            engagement,
            id,
            patch: { status, check_note: "界面手动标记" },
        };
    }
    /** 标记 WebShell 的请求。 */
    function updateWebshellRequest(engagement, id, status) {
        return {
            op: "updateWebshell",
            engagement,
            id,
            patch: { status, check_note: "界面手动标记" },
        };
    }
    /** 从响应里取错误文案。 */
    function errorOf(response, fallback) {
        if (response === null || response === undefined)
            return fallback;
        const body = recordOf(response);
        if (body["ok"] !== false)
            return null;
        const message = body["error"];
        return typeof message === "string" && message !== "" ? message : fallback;
    }
    /** 加载会话数据。 */
    async function loadSessions(api, engagement) {
        const response = await api.raw(sessionsRequest(engagement));
        const error = errorOf(response, "读取失败");
        if (error !== null)
            return (0, result_js_3.err)(error);
        return (0, result_js_3.ok)(sessionDataOf(response));
    }
    /** 实测连通性。 */
    async function probeSessions(api, engagement) {
        const response = await api.raw(probeRequest(engagement));
        const error = errorOf(response, "检测失败");
        if (error !== null)
            return (0, result_js_3.err)(error);
        return (0, result_js_3.ok)(probeSummaryOf(response));
    }
    /** 标记隧道状态（`active` / `down`）。 */
    async function markTunnel(api, engagement, id, status) {
        const response = await api.raw(updateTunnelRequest(engagement, id, status));
        const error = errorOf(response, "标记失败");
        return error !== null ? (0, result_js_3.err)(error) : (0, result_js_3.ok)(null);
    }
    /** 标记 WebShell 状态（`offline` / `online`）。 */
    async function markShell(api, engagement, id, status) {
        const response = await api.raw(updateWebshellRequest(engagement, id, status));
        const error = errorOf(response, "标记失败");
        return error !== null ? (0, result_js_3.err)(error) : (0, result_js_3.ok)(null);
    }
    /* ══════════════════════════════════════════════════════════════ 复制 */
    /**
     * 复制反馈的文案。
     *
     * 原实现：成功 `'已复制：' + label`，失败
     * `'复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制'`。
     * **不能**把失败也说成成功 —— 那正是原实现记录过的 bug。
     */
    function copyMessage(ok, label) {
        return ok ? "已复制：" + label : "复制失败（浏览器未授权剪贴板）—— 请手动选中文本复制";
    }
    /* ══════════════════════════════════════════════════════════════ 空态 */
    /** 未选靶标。 */
    exports.NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看会话与入口。";
    /** 两条都没有时的空态标题。 */
    exports.EMPTY_TITLE = "还没有登记任何 WebShell 或隧道。";
    /** 两条都没有时的空态说明。 */
    exports.EMPTY_DETAIL = "拿到 WebShell 用 redteam_webshell_add；建好隧道用 redteam_tunnel_add（suo5 / socks5 / ssh -R）；"
        + "之后智能体用 redteam_sessions 就能看到。";
    /** WebShell 区块的空态。 */
    exports.EMPTY_SHELLS_TEXT = "暂无（拿到 WebShell 后用 redteam_webshell_add 登记）";
    /** 隧道区块的空态。 */
    exports.EMPTY_TUNNELS_TEXT = "暂无（建好隧道后用 redteam_tunnel_add 登记）";
    /* ══════════════════════════════════════════════════════════════ 复制按钮 */
    /**
     * 复制按钮的状态：`已复制` 还是按钮。
     *
     * 原实现用一个 `copied` 状态存**当前亮起的那一个按钮的键**，1.5 秒后清掉。
     * 这里把「该不该亮」抽成纯函数，1.5 秒的定时器由组件层管。
     */
    function isCopied(copiedKey, key) {
        return copiedKey === key;
    }
    /** 「已复制」提示的自动消失时长（毫秒）。 */
    exports.COPIED_RESET_MS = 1500;
    /** 各复制按钮的键（集中一处，避免组件层拼错）。 */
    function shellCopyKey(shell) {
        return "cmd" + shell.id;
    }
    function tunnelListenKey(tunnel) {
        return "sock" + tunnel.id;
    }
    function tunnelCommandKey(tunnel) {
        return "c" + tunnel.id;
    }
    function tunnelGogoKey(tunnel) {
        return "g" + tunnel.id;
    }
    function tunnelFscanKey(tunnel) {
        return "f" + tunnel.id;
    }
});
/**
 * 会话隧道页（`sessions` 页签）的渲染。
 *
 * 数据与提示判定全在 `session-model.ts`，这里只排版。
 *
 * ## 布局
 *
 * ```
 * ┌────────────────────────────────────────────────────────────────┐
 * │ 会话与入口  WebShell 2/3 在线  隧道 1/2 可用  凭据 4  访问会话 2 │
 * │                                          [检测连通性] [刷新]     │
 * ├────────────────────────────────────────────────────────────────┤
 * │ ⚠ 有 1 个入口不是冰蝎马/哥斯拉马（用户连不上，不算可交付入口）   │
 * │   怎么做（点击展开）▸                                          │
 * ├────────────────────────────────────────────────────────────────┤
 * │ ▾ WebShell 2/3 在线   已上线的可控入口                          │
 * │   ● https://x/shell.jsp  [哥斯拉] [root]   [复制 URL] [标记失效]│
 * ├────────────────────────────────────────────────────────────────┤
 * │ ▾ 内网隧道 1/2 可用   可直接给扫描器当代理用                    │
 * │   ● 127.0.0.1:1080  [suo5] [目标侧通道] [可达 10.0.0.0/8]      │
 * └────────────────────────────────────────────────────────────────┘
 *
 * ## 一个原实现的取舍，这里保留
 *
 * 「建立命令」与「走这条隧道扫描」都**默认折叠**（`<details>` 无 `open`）：
 * 卡片首要信息是「这条通道能不能用、通向哪」，命令按需展开。
 */
define("redteam/client/session-tab", ["require", "exports", "redteam/client/helpers", "redteam/client/session-model"], function (require, exports, helpers_js_13, session_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.COPY_FEEDBACK_MS = void 0;
    exports.renderSessionTab = renderSessionTab;
    exports.defaultSessionProps = defaultSessionProps;
    exports.copyFailureText = copyFailureText;
    exports.keyOf = keyOf;
    /** 两个区块的默认展开态（都默认展开）。 */
    const SECTION_DEFAULT_OPEN = true;
    /** 取区块展开态。 */
    function sectionOpen(collapsed, key) {
        const stored = collapsed[key];
        return stored === undefined ? SECTION_DEFAULT_OPEN : stored === true;
    }
    /** 状态点。 */
    function statusDot(runtime, status) {
        return runtime.h("span", { className: (0, session_model_js_1.statusDotClass)(status) });
    }
    /** 卡片里的一行「标签 + 值」。 */
    function fact(runtime, label, value) {
        return runtime.h("div", { className: "rt-sess-fact" }, runtime.h("b", null, label), runtime.h("span", null, value));
    }
    /** 统一折叠头（原 `Section` 组件的最小面）。 */
    function section(runtime, props, key, tone, title, count, sub, children) {
        const { h } = runtime;
        const open = sectionOpen(props.collapsed, key);
        return h("div", { className: "rt-sec-wrap" }, h("div", {
            className: "rt-sec t-" + tone,
            ...(0, helpers_js_13.clickable)(() => props.onToggleSection(key), { label: title, expanded: open }),
        }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), h("span", { className: "rt-sec-title" }, title), h("span", { className: "rt-sec-count" }, count), h("span", { className: "rt-sec-sub" }, sub)), open ? h("div", { className: "rt-sec-body" }, children) : null);
    }
    /** 提示条（只留一句结论 + 可展开的做法）。 */
    function hintNode(runtime, key, title, detail) {
        const { h } = runtime;
        return h("div", { key, className: "rt-hint" }, h("b", null, title), h("details", { className: "rt-sess-fold", style: { marginTop: 3 } }, h("summary", null, session_model_js_1.HINT_SUMMARY), h("div", { style: { marginTop: 4 } }, detail)));
    }
    /** WebShell 卡片。 */
    function shellCard(runtime, props, shell) {
        const { h } = runtime;
        const key = (0, session_model_js_1.shellCopyKey)(shell);
        return h("div", { key: "w" + shell.id, className: "rt-sess" }, h("div", { className: "rt-sess-head" }, statusDot(runtime, shell.status), h("span", { className: "rt-sess-title" }, shell.url), h("span", { className: "rt-tag rt-tag-active" }, shell.shellType !== "" ? shell.shellType : "webshell"), (0, session_model_js_1.isEncryptedShell)(shell.shellType) ? null : h("span", { className: "rt-tag rt-tag-warn" }, "用户连不上"), shell.privilege !== "" ? h("span", { className: "rt-tag" }, shell.privilege) : null, h("div", { className: "rt-spacer" }), (0, session_model_js_1.isCopied)(props.copied, key)
            ? h("span", { className: "rt-tag", style: { color: "#10b981" } }, "已复制")
            : h("button", {
                className: "rt-btn",
                style: { padding: "0 6px", fontSize: 11 },
                onClick: () => props.onCopy(key, (0, session_model_js_1.shellCopyCommand)(shell), (0, session_model_js_1.shellCopyCommand)(shell)),
            }, "复制 URL"), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onMarkShell(shell, "offline"),
        }, "标记失效")), h("div", { className: "rt-sess-facts" }, fact(runtime, "类型", (0, session_model_js_1.shellTypeText)(shell)), shell.passKey !== "" ? fact(runtime, "连接口令", h("span", { className: "rt-mono" }, shell.passKey)) : null, shell.assetIp !== "" ? fact(runtime, "所在资产", shell.assetIp) : null, shell.privilege !== "" ? fact(runtime, "权限", shell.privilege) : null, shell.secretRef !== "" ? fact(runtime, "凭据引用", h("span", { className: "rt-mono" }, shell.secretRef)) : null, fact(runtime, "最后检测", (0, session_model_js_1.lastCheckText)(shell.lastCheck, shell.latencyMs, (0, helpers_js_13.formatTimestamp)(shell.lastCheck))), shell.checkNote !== "" ? fact(runtime, "检测说明", shell.checkNote) : null, shell.note !== "" ? fact(runtime, "备注", shell.note) : null));
    }
    /** 一条可复制的代码块（点击复制）。 */
    function copyCode(runtime, props, key, text, label, extraStyle) {
        const { h } = runtime;
        return h("div", {
            className: "rt-code",
            title: "点击复制",
            ...(extraStyle !== undefined ? { style: extraStyle } : {}),
            ...(0, helpers_js_13.clickable)(() => props.onCopy(key, text, text), { label }),
        }, (0, session_model_js_1.isCopied)(props.copied, key) ? "已复制" : text);
    }
    /** 隧道卡片。 */
    function tunnelCard(runtime, props, tunnel) {
        const { h } = runtime;
        const listenKey = (0, session_model_js_1.tunnelListenKey)(tunnel);
        return h("div", { key: "t" + tunnel.id, className: "rt-sess" }, h("div", { className: "rt-sess-head" }, statusDot(runtime, tunnel.status), h("span", { className: "rt-sess-title" }, tunnel.listen !== "" ? tunnel.listen : "(未填监听地址)"), h("span", { className: "rt-tag rt-tag-passive" }, tunnel.kind !== "" ? tunnel.kind : "tunnel"), (0, session_model_js_1.isSuo5)(tunnel.kind) ? null : h("span", { className: "rt-tag rt-tag-warn" }, "非 suo5 标准通道"), 
        // 只有跨越靶标边界的通道才算突破凭证（自己 VPS/自建服务器上开的不算）。
        h("span", { className: (0, session_model_js_1.legitClass)(tunnel), title: (0, session_model_js_1.legitTitle)(tunnel) }, (0, session_model_js_1.legitLabel)(tunnel)), tunnel.reach !== "" ? h("span", { className: "rt-tag" }, "可达 " + tunnel.reach) : null, h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: () => props.onCopy(listenKey, tunnel.listen, tunnel.listen),
        }, (0, session_model_js_1.isCopied)(props.copied, listenKey) ? "已复制" : "复制地址"), tunnel.status === "active"
            ? h("button", {
                className: "rt-btn",
                style: { padding: "0 6px", fontSize: 11 },
                onClick: () => props.onMarkTunnel(tunnel, "down"),
            }, "标记失效")
            : h("button", {
                className: "rt-btn",
                style: { padding: "0 6px", fontSize: 11 },
                onClick: () => props.onMarkTunnel(tunnel, "active"),
            }, "标记可用")), h("div", { className: "rt-sess-facts" }, fact(runtime, "目标侧入口", tunnel.entry !== "" ? tunnel.entry : "未登记"), fact(runtime, "跨越边界", (0, session_model_js_1.legitFactText)(tunnel)), tunnel.reach !== "" ? fact(runtime, "可达网段", tunnel.reach) : null, tunnel.assetIp !== "" ? fact(runtime, "所在资产", tunnel.assetIp) : null, fact(runtime, "最后检测", (0, session_model_js_1.lastCheckText)(tunnel.lastCheck, tunnel.latencyMs, (0, helpers_js_13.formatTimestamp)(tunnel.lastCheck))), tunnel.checkNote !== "" ? fact(runtime, "检测说明", tunnel.checkNote) : null, tunnel.note !== "" ? fact(runtime, "备注", tunnel.note) : null), 
        // 命令默认折叠：卡片首要信息是「这条通道能不能用、通向哪」。
        tunnel.command !== ""
            ? h("details", { className: "rt-sess-fold" }, h("summary", null, "建立命令（点击展开 / 复制）"), copyCode(runtime, props, (0, session_model_js_1.tunnelCommandKey)(tunnel), tunnel.command, "复制命令"))
            : null, tunnel.status === "active" && tunnel.listen !== ""
            ? h("details", { className: "rt-sess-fold" }, h("summary", null, "走这条隧道扫描（gogo / fscan 命令）"), h("div", { className: "rt-sess-cmd" }, copyCode(runtime, props, (0, session_model_js_1.tunnelGogoKey)(tunnel), (0, session_model_js_1.gogoCommand)(tunnel), "复制 gogo 命令"), copyCode(runtime, props, (0, session_model_js_1.tunnelFscanKey)(tunnel), (0, session_model_js_1.fscanCommand)(tunnel), "复制 fscan 命令", { display: "block", marginTop: 3 })))
            : null);
    }
    /**
     * 渲染会话隧道页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderSessionTab(runtime, props) {
        const { h } = runtime;
        if (props.engagement === null || props.engagement === "") {
            return h("div", { className: "rt-main" }, h("div", { className: "rt-empty" }, session_model_js_1.NO_ENGAGEMENT_TEXT));
        }
        const data = props.data;
        const totals = data?.totals ?? { webshells: 0, webshellsOnline: 0, tunnels: 0, tunnelsActive: 0, credentials: 0, access: 0 };
        const shells = data?.shells ?? [];
        const tunnels = data?.tunnels ?? [];
        const hints = data !== null ? (0, session_model_js_1.sessionHints)(data) : [];
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "会话与入口"), h("span", { className: "rt-tag" }, "WebShell " + totals.webshellsOnline + "/" + totals.webshells + " 在线"), h("span", { className: "rt-tag" }, "隧道 " + totals.tunnelsActive + "/" + totals.tunnels + " 可用"), h("span", { className: "rt-tag" }, "凭据 " + totals.credentials), h("span", { className: "rt-tag" }, "访问会话 " + totals.access), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn rt-btn-primary",
            disabled: props.busy,
            onClick: () => props.onProbe(),
        }, props.busy ? "检测中…" : "检测连通性"), h("button", { className: "rt-btn", onClick: () => props.onRefresh() }, "刷新"));
        const emptyNode = shells.length === 0 && tunnels.length === 0
            ? h("div", { className: "rt-empty" }, h("div", null, session_model_js_1.EMPTY_TITLE), h("div", { style: { marginTop: 6, fontSize: 12 } }, session_model_js_1.EMPTY_DETAIL))
            : null;
        const shellSection = section(runtime, props, "shells", "queue", "WebShell", totals.webshellsOnline + "/" + totals.webshells + " 在线", "已上线的可控入口", shells.length > 0
            ? h("div", { className: "rt-sess-grid", style: { padding: 0 } }, shells.map((shell) => shellCard(runtime, props, shell)))
            : h("div", { className: "rt-atest-meta" }, session_model_js_1.EMPTY_SHELLS_TEXT));
        const tunnelSection = section(runtime, props, "tunnels", "test", "内网隧道", totals.tunnelsActive + "/" + totals.tunnels + " 可用", "可直接给扫描器当代理用", tunnels.length > 0
            ? h("div", { className: "rt-sess-grid", style: { padding: 0 } }, tunnels.map((tunnel) => tunnelCard(runtime, props, tunnel)))
            : h("div", { className: "rt-atest-meta" }, session_model_js_1.EMPTY_TUNNELS_TEXT));
        const message = props.message;
        return h("div", { className: "rt-main" }, toolbar, message !== null
            ? h("div", { className: message.err !== undefined ? "rt-err" : "rt-foot" }, message.err ?? message.ok ?? "")
            : null, props.error !== null ? h("div", { className: "rt-err" }, props.error) : null, h("div", { className: "rt-body", style: { overflow: "auto" } }, emptyNode, hints.length > 0
            ? h("div", { style: { padding: "8px 10px 0" } }, hints.map((hint) => hintNode(runtime, hint.key, hint.title, hint.detail)))
            : null, shellSection, tunnelSection));
    }
    /** 默认 props（供测试与未接线场景）。 */
    function defaultSessionProps(engagement) {
        return {
            engagement,
            data: null,
            error: null,
            busy: false,
            message: null,
            copied: null,
            collapsed: {},
            onRefresh: () => undefined,
            onProbe: () => undefined,
            onToggleSection: () => undefined,
            onMarkShell: () => undefined,
            onMarkTunnel: () => undefined,
            onCopy: () => undefined,
        };
    }
    /** 供测试断言：复制成功后按钮亮起的自动消失时长（毫秒）。 */
    exports.COPY_FEEDBACK_MS = session_model_js_1.COPIED_RESET_MS;
    /** 供测试断言：复制失败提示。 */
    function copyFailureText(label) {
        return (0, session_model_js_1.copyMessage)(false, label);
    }
    /** 供渲染层之外的调用点复用：从一个按键事件里取按键名。 */
    function keyOf(event) {
        return event.key ?? "";
    }
});
/**
 * 技能库页的数据模型（纯逻辑）。
 *
 * ## 抽取重点
 *
 * 原 `SkillsTab` 的过滤与分组藏在渲染里：
 * ```js
 * let filtered = needle ? items.filter(s => (...).indexOf(needle) >= 0) : items
 * if (srcOnly) filtered = filtered.filter(s => s.library !== 'official' && s.fromPlugin === true)
 * if (brokenOnly) filtered = filtered.filter(s => ...)
 * const redteamRows = filtered.filter(s => s.library !== 'official')
 * const officialRows = filtered.filter(s => s.library === 'official')
 * ```
 * 这里有三个**容易错**的点，抽出来后可以逐条钉死：
 *
 * 1. **过滤器的组合顺序**：`srcOnly` 与 `brokenOnly` 都是「仅红队」语义，
 *    叠加时不能互相覆盖。原实现是顺序串联，等价于 AND。
 * 2. **"未知"算缺口**：`brokenOnly` 把 `unknown` 也算进来 —— 理由在
 *    原注释里：「判不了可用性」本身就是要处理的缺口，不该被藏起来。
 * 3. **搜索是三字段拼接**：`name + ' ' + description + ' ' + whenToUse`
 *    小写后子串匹配。只搜 name 会漏掉「按描述找技能」这个主用例。
 */
define("redteam/client/skills-model", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MAX_DIR_CHIPS = exports.DEFAULT_SKILL_FILTER = void 0;
    exports.skillItemOf = skillItemOf;
    exports.catalogOf = catalogOf;
    exports.matchesQuery = matchesQuery;
    exports.filterSkills = filterSkills;
    exports.groupSkills = groupSkills;
    exports.skillKeyOf = skillKeyOf;
    exports.toggleActive = toggleActive;
    exports.visibleDirs = visibleDirs;
    exports.gapCount = gapCount;
    exports.showsBrokenFilter = showsBrokenFilter;
    exports.needsRestart = needsRestart;
    exports.availabilityLabel = availabilityLabel;
    exports.availabilityTitle = availabilityTitle;
    exports.skillSubtitle = skillSubtitle;
    exports.showsProblemLine = showsProblemLine;
    exports.problemLine = problemLine;
    exports.detailOf = detailOf;
    exports.catalogError = catalogError;
    exports.catalogLoadOf = catalogLoadOf;
    /** 从不可信值读字符串。 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    /** 从不可信值读对象。 */
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读字符串数组（过滤非字符串项）。 */
    function stringsOf(value) {
        return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    }
    /** 归一可用性状态。 */
    function availabilityOf(value) {
        switch (value) {
            case "available":
            case "broken":
            case "unknown":
            case "listed":
                return value;
            default:
                // 未知取值按 unknown 处理：比猜成「可用」安全（不会把坏技能藏起来）。
                return "unknown";
        }
    }
    /** 归一库归属。 */
    function libraryOf(value) {
        return value === "official" ? "official" : "redteam";
    }
    /** 解析一条技能。 */
    function skillItemOf(raw) {
        const item = recordOf(raw);
        return {
            name: text(item["name"]),
            description: text(item["description"]),
            whenToUse: text(item["when_to_use"]) || text(item["whenToUse"]),
            provider: text(item["provider"]),
            source: text(item["source"]),
            dir: typeof item["dir"] === "string" ? item["dir"] : null,
            // 缺省为 true（原实现语义：`invocation.modelInvocable !== false`）。
            modelInvocable: item["modelInvocable"] !== false,
            userInvocable: item["userInvocable"] !== false,
            fromPlugin: item["fromPlugin"] === true,
            library: libraryOf(item["library"]),
            availability: availabilityOf(item["availability"]),
            problems: stringsOf(item["problems"]),
            needsUser: stringsOf(item["needs_user"]) || stringsOf(item["needsUser"]),
        };
    }
    /** 解析目录响应。 */
    function catalogOf(response) {
        const body = recordOf(response);
        const rawItems = Array.isArray(body["items"]) ? body["items"] : [];
        const items = rawItems
            .map(skillItemOf)
            // 无名技能无法渲染、也无法读取，留着只会出空白行。
            .filter((item) => item.name !== "");
        const availability = recordOf(body["availability"]);
        const summary = recordOf(availability["summary"]);
        const hasSummary = Object.keys(summary).length > 0;
        const byDir = (Array.isArray(body["byDir"]) ? body["byDir"] : [])
            .map((entry) => {
            const record = recordOf(entry);
            const n = Number(record["n"]);
            return { key: text(record["key"]), n: Number.isFinite(n) ? n : 0 };
        })
            .filter((entry) => entry.key !== "");
        const bySource = (Array.isArray(body["bySource"]) ? body["bySource"] : [])
            .map((entry) => {
            const record = recordOf(entry);
            const n = Number(record["n"]);
            return { key: text(record["key"]), n: Number.isFinite(n) ? n : 0 };
        })
            .filter((entry) => entry.key !== "");
        const broken = (Array.isArray(availability["broken"]) ? availability["broken"] : [])
            .map((entry) => {
            const record = recordOf(entry);
            return {
                name: text(record["name"]),
                problems: stringsOf(record["problems"]),
                needsUser: stringsOf(record["needs_user"]) || stringsOf(record["needsUser"]),
            };
        })
            .filter((entry) => entry.name !== "");
        const checkedAtRaw = Number(availability["checked_at"]);
        return {
            items,
            meta: {
                total: items.length,
                fromPlugin: items.filter((item) => item.fromPlugin).length,
                availability: hasSummary
                    ? {
                        available: countOrZero(summary["available"]),
                        broken: countOrZero(summary["broken"]),
                        unknown: countOrZero(summary["unknown"]),
                    }
                    : null,
                checkedAt: Number.isFinite(checkedAtRaw) && checkedAtRaw > 0 ? checkedAtRaw : null,
                cached: availability["cached"] === true,
                broken,
                byDir,
                bySource,
                note: text(body["note"]),
            },
        };
    }
    /** 计数字段兜底（非数字 → 0）。 */
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 默认过滤（全显示）。 */
    exports.DEFAULT_SKILL_FILTER = Object.freeze({
        query: "",
        pluginOnly: false,
        brokenOnly: false,
    });
    /**
     * 搜索命中判定。
     *
     * 三字段拼接后子串匹配 —— 只搜 `name` 会漏掉「按描述找技能」这个主用例。
     */
    function matchesQuery(item, needle) {
        if (needle === "")
            return true;
        const haystack = (item.name + " " + item.description + " " + item.whenToUse).toLowerCase();
        return haystack.includes(needle.toLowerCase());
    }
    /**
     * 应用过滤。
     *
     * 三个条件**串联**（AND），与原实现一致。`pluginOnly` 与 `brokenOnly`
     * 都带「仅红队」语义 —— 官方技能不做工具路径检查，把它们算进
     * 「不可用」是错的。
     */
    function filterSkills(items, filter) {
        const needle = filter.query.trim().toLowerCase();
        let result = needle === "" ? items : items.filter((item) => matchesQuery(item, needle));
        if (filter.pluginOnly) {
            result = result.filter((item) => item.library !== "official" && item.fromPlugin);
        }
        if (filter.brokenOnly) {
            result = result.filter((item) => item.library !== "official"
                && (item.availability === "broken" || item.availability === "unknown"));
        }
        return result;
    }
    /** 按库归属分组（顺序保持输入顺序）。 */
    function groupSkills(items) {
        return {
            redteam: items.filter((item) => item.library !== "official"),
            official: items.filter((item) => item.library === "official"),
        };
    }
    /** 技能的唯一键：`library:name`。 */
    function skillKeyOf(item) {
        return item.library + ":" + item.name;
    }
    /**
     * 切换/打开一条技能的详情。
     *
     * 原实现语义：点同一条会折叠（返回 `null`），点别的会展开成新键。
     * 返回 `null` 表示「应关闭详情」。
     */
    function toggleActive(current, item) {
        const key = skillKeyOf(item);
        return current === key ? null : key;
    }
    /** 目录聚合的显示项（前 6 个，过滤掉 0）。 */
    exports.MAX_DIR_CHIPS = 6;
    /** 取要显示的目录聚合。 */
    function visibleDirs(meta) {
        return meta.byDir.filter((entry) => entry.n > 0).slice(0, exports.MAX_DIR_CHIPS);
    }
    /** 缺口总数（不可用 + 未知）。 */
    function gapCount(summary) {
        if (summary === null)
            return 0;
        return summary.broken + summary.unknown;
    }
    /** 是否显示「只看不可用」复选框。 */
    function showsBrokenFilter(summary) {
        return gapCount(summary) > 0;
    }
    /**
     * 是否是「宿主版本不含此 op」的错误。
     *
     * 原实现：`err.indexOf('unknown op') >= 0` 时给一条「需要重启/升级宿主」的提示。
     * 这是真实的兼容场景：插件更新了但宿主还跑着旧版，技能 op 不存在。
     */
    function needsRestart(err) {
        return typeof err === "string" && err.includes("unknown op");
    }
    /** 可用性徽章文案。 */
    function availabilityLabel(availability) {
        switch (availability) {
            case "available":
                return "可用";
            case "broken":
                return "不可用";
            case "listed":
                // 官方技能不做检查，只列出。
                return "已列出";
            case "unknown":
                return "未知";
        }
    }
    /** 可用性徽章的 tooltip。 */
    function availabilityTitle(item) {
        if (item.availability === "available") {
            return "可用：技能正文可以加载。缺的外部工具或密钥记在详情里，不阻止调用。";
        }
        const problems = item.problems.join("\n");
        return problems === "" ? "未知" : problems;
    }
    /** 技能行的副标题（来源 / 归属 / 目录）。 */
    function skillSubtitle(item) {
        return [
            item.source !== "" ? "来源 " + item.source : null,
            item.fromPlugin ? "本插件自带" : null,
            item.provider !== "" ? item.provider : null,
            item.dir,
        ].filter((part) => part !== null).join(" · ");
    }
    /**
     * 是否显示问题提示行。
     *
     * 三个条件同时满足：有问题、不是可用、不是官方 —— 官方技能不做检查，
     * 显示「⚠」会让用户以为官方技能坏了。
     */
    function showsProblemLine(item) {
        return item.problems.length > 0 && item.availability !== "available" && item.library !== "official";
    }
    /** 问题提示行的文本（截断到 60 字符，与原实现一致）。 */
    function problemLine(item) {
        if (item.problems.length === 0)
            return "";
        return "⚠ " + String(item.problems[0]).slice(0, 60);
    }
    /** 从响应解析详情。 */
    function detailOf(response) {
        const body = recordOf(response);
        if (body["ok"] === false)
            return null;
        const name = text(body["name"]);
        if (name === "")
            return null;
        return {
            name,
            description: text(body["description"]),
            whenToUse: text(body["whenToUse"]) || text(body["when_to_use"]),
            provider: text(body["provider"]),
            source: text(body["source"]),
            path: typeof body["path"] === "string" ? body["path"] : null,
            content: text(body["content"]),
        };
    }
    /** 目录响应失败时的错误文案。 */
    function catalogError(response, fallback = "读取失败") {
        if (response === null || response === undefined)
            return fallback;
        const body = recordOf(response);
        if (body["ok"] !== false)
            return null;
        const error = body["error"];
        return typeof error === "string" && error !== "" ? error : fallback;
    }
    /** 从响应造加载结果。 */
    function catalogLoadOf(response) {
        const error = catalogError(response);
        if (error !== null) {
            return {
                ok: false,
                items: [],
                meta: null,
                error,
                restartHint: needsRestart(error),
            };
        }
        const parsed = catalogOf(response);
        return {
            ok: true,
            items: parsed.items,
            meta: parsed.meta,
            error: null,
            restartHint: false,
        };
    }
});
/**
 * 技能库页（`skills` 页签）的渲染。
 *
 * 数据与过滤全在 `skills-model.ts`（83 用例），这里只排版。
 *
 * ## 布局（原实现是左右分栏）
 *
 * ```
 * ┌─────────────┬──────────────────────┐
 * │ 搜索框      │ 详情（展开时才显示）  │
 * │ 只看本插件  │  名称 / 路径          │
 * │ 只看不可用  │  正文                │
 * │ 可用性徽章  │                      │
 * │ 红队技能    │                      │
 * │ 官方技能    │                      │
 * └─────────────┴──────────────────────┘
 * ```
 *
 * ## 一个原实现的细节，这里保留
 *
 * 「只看不可用」复选框**只在真有缺口时才出现**（`showsBrokenFilter`）。
 * 永远显示一个「（0 个）」的复选框是噪声。
 */
define("redteam/client/skills-tab", ["require", "exports", "redteam/client/skills-model"], function (require, exports, skills_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderSkillsTab = renderSkillsTab;
    exports.loadSkillCatalog = loadSkillCatalog;
    exports.loadSkillDetail = loadSkillDetail;
    exports.toggleFilterFlag = toggleFilterFlag;
    exports.resetFilter = resetFilter;
    exports.nextActiveKey = nextActiveKey;
    /** 可用性徽章。 */
    function availabilityBadge(runtime, item) {
        const label = (0, skills_model_js_1.availabilityLabel)(item.availability);
        if (item.library === "official") {
            // 官方技能只标「官方」：它们不按红队工具路径检查，
            // 标「可用性」会让人误以为它们也在被检查。
            return runtime.h("span", {
                className: "rt-tag",
                style: { marginLeft: 6 },
                title: "官方技能目录，不按红队工具路径检查",
            }, "官方");
        }
        return runtime.h("span", {
            className: "rt-avail rt-avail-" + item.availability,
            style: { marginLeft: 6 },
            title: (0, skills_model_js_1.availabilityTitle)(item),
        }, label);
    }
    /** 一行技能。 */
    function skillRow(runtime, props, item) {
        const key = (0, skills_model_js_1.skillKeyOf)(item);
        const active = props.activeKey === key;
        return runtime.h("div", {
            key,
            className: "rt-item" + (active ? " on" : ""),
            role: "button",
            tabIndex: 0,
            "aria-label": "查看技能 " + item.name,
            "aria-expanded": active ? "true" : "false",
            onClick: () => props.onToggle(item),
            onKeyDown: (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault?.();
                    props.onToggle(item);
                }
            },
        }, runtime.h("div", { className: "rt-item-name" }, item.name, item.modelInvocable ? null : runtime.h("span", { className: "rt-tag", style: { marginLeft: 6 } }, "仅人工"), availabilityBadge(runtime, item)), runtime.h("div", { className: "rt-item-desc" }, item.description !== "" ? item.description : "（无描述）"), runtime.h("div", { className: "rt-kb-sub" }, (0, skills_model_js_1.skillSubtitle)(item)), (0, skills_model_js_1.showsProblemLine)(item)
            ? runtime.h("div", {
                className: "rt-kb-sub",
                style: { color: "var(--dsw-alias-state-warn-primary, #f59e0b)" },
            }, (0, skills_model_js_1.problemLine)(item))
            : null);
    }
    /** 详情面板。 */
    function detailPane(runtime, props) {
        if (props.activeKey === null) {
            return runtime.h("div", { className: "rt-empty" }, "点左侧技能查看正文");
        }
        if (props.detailBusy) {
            return runtime.h("div", { className: "rt-empty" }, "载入中…");
        }
        const detail = props.detail;
        if (detail === null) {
            return runtime.h("div", { className: "rt-empty" }, "读取失败或没有正文");
        }
        return runtime.h("div", { className: "rt-pane" }, runtime.h("div", { className: "rt-card" }, runtime.h("div", { style: { fontWeight: 600, marginBottom: 6 } }, detail.name), detail.description !== ""
            ? runtime.h("div", { style: { fontSize: 12, marginBottom: 6 } }, detail.description)
            : null, detail.whenToUse !== ""
            ? runtime.h("div", { className: "rt-kb-sub" }, "适用：" + detail.whenToUse)
            : null, detail.path !== null
            ? runtime.h("div", { className: "rt-kb-sub rt-mono" }, detail.path)
            : null), runtime.h("pre", { className: "rt-md" }, detail.content));
    }
    /**
     * 渲染技能库页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderSkillsTab(runtime, props) {
        const { h } = runtime;
        const catalog = props.catalog;
        const items = catalog?.items ?? [];
        const meta = catalog?.meta ?? null;
        const summary = meta?.availability ?? null;
        const filtered = (0, skills_model_js_1.filterSkills)(items, props.filter);
        const groups = (0, skills_model_js_1.groupSkills)(filtered);
        const dirs = meta === null ? [] : (0, skills_model_js_1.visibleDirs)(meta);
        // 徽章全显示（`共 N` / `本插件 N` / `可用 N` / `不可用 N` / `未知 N`）：
        // 这些是既定的外观契约（测试按语义断言），不要为省宽度把它们藏进 title。
        // 620px 下靠 THEME 收紧 badge 内边距与 gap 排成一行。
        const toolbar = h("div", { className: "rt-toolbar" }, h("span", { style: { fontWeight: 600 } }, "技能库"), h("span", { className: "rt-tag" }, "共 " + items.length + " 个"), meta !== null && meta.fromPlugin > 0
            ? h("span", { className: "rt-tag rt-tag-live" }, "本插件 " + meta.fromPlugin)
            : null, summary !== null
            ? h("span", { className: "rt-avail rt-avail-available" }, "可用 " + summary.available)
            : null, summary !== null && summary.broken > 0
            ? h("span", {
                className: "rt-avail rt-avail-broken",
                title: "这些技能跑不起来：缺工具或正文读不到。勾选下方「只看不可用」查看",
            }, "不可用 " + summary.broken)
            : null, summary !== null && summary.unknown > 0
            ? h("span", {
                className: "rt-avail rt-avail-unknown",
                title: "判不了可用性（正文读不到）。勾选下方「只看不可用/未知」查看",
            }, "未知 " + summary.unknown)
            : null, h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            disabled: props.busy,
            title: "跳过后端 30 秒可用性缓存，重新检查技能正文与环境",
            onClick: () => props.onRefresh(true),
        }, props.busy ? "读取中…" : "刷新"));
        const errorNode = catalog !== null && catalog.error !== null
            ? h("div", { className: "rt-err" }, catalog.error)
            : null;
        // 宿主版本不含 skillCatalog op 时给一条明确的行动建议，
        // 而不是让用户对着「unknown op」发呆。
        const restartNode = catalog !== null && catalog.restartHint
            ? h("div", { className: "rt-foot" }, "宿主版本似乎不含技能库接口：请重启 dsh web（或升级宿主）后刷新本页。")
            : null;
        const dirChips = dirs.length > 0
            ? h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 } }, dirs.map((entry) => h("span", { key: entry.key, className: "rt-tag", title: entry.key }, entry.key + " · " + entry.n)))
            : null;
        const searchBox = h("input", {
            className: "rt-input",
            style: { width: "100%", marginBottom: 8, boxSizing: "border-box" },
            placeholder: "过滤技能",
            value: props.filter.query,
            onChange: (event) => {
                const value = String(event.target?.value ?? "");
                props.onFilterChange({ ...props.filter, query: value });
            },
        });
        const pluginCheckbox = h("label", { className: "rt-kb-check", style: { display: "flex", margin: "0 0 6px" } }, h("input", {
            type: "checkbox",
            checked: props.filter.pluginOnly,
            onChange: (event) => {
                const checked = event.target?.checked === true;
                props.onFilterChange({ ...props.filter, pluginOnly: checked });
            },
        }), "只看本插件自带（" + (meta?.fromPlugin ?? 0) + " 个）");
        const brokenCheckbox = (0, skills_model_js_1.showsBrokenFilter)(summary)
            ? h("label", {
                className: "rt-kb-check",
                style: { display: "flex", margin: "0 0 8px" },
                title: "只看有明确缺口（缺 key / 缺本机路径 / 基础设施还是占位符）或判不了可用性的技能",
            }, h("input", {
                type: "checkbox",
                checked: props.filter.brokenOnly,
                onChange: (event) => {
                    const checked = event.target?.checked === true;
                    props.onFilterChange({ ...props.filter, brokenOnly: checked });
                },
            }), "只看不可用/未知（" + (0, skills_model_js_1.gapCount)(summary) + " 个）")
            : null;
        /** 一组技能（带组标题）。 */
        const groupNode = (title, group, groupKey) => group.length === 0
            ? null
            : h("div", { key: groupKey }, h("div", { className: "rt-kb-sub", style: { margin: "8px 0 4px", fontWeight: 600 } }, title), group.map((item) => skillRow(runtime, props, item)));
        const emptyNode = filtered.length === 0
            ? h("div", { className: "rt-empty" }, items.length === 0 ? "没有技能（本包 skills/redteam 目录为空）" : "没有匹配的技能")
            : null;
        // 工具栏横跨整宽，放在分栏**之上**而不是塞进左侧 210px 列表里：
        // 塞进窄栏会把「技能库 / 共 N 个 / 本插件 N / 可用 N / 不可用 N / 刷新」
        // 折成三行，把列表挤到看不见（真实渲染截图确认过）。
        return h("div", {
            className: "rt-kb-wrap",
            style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
        }, 
        // 工具栏必须进树 —— 它是「共 N 个 / 本插件 N / 可用性徽章 / 刷新」的唯一载体。
        // 原实现漏了这一行，导致 `toolbar` 成了死代码：标题、徽章、刷新按钮全不渲染，
        // 8 个用例（标题/徽章/刷新点击/读取中/title 提示/null 态结构稳定/端到端）因此失败。
        toolbar, h("div", { className: "rt-split" }, h("div", { className: "rt-list" }, searchBox, pluginCheckbox, brokenCheckbox, dirChips, errorNode, restartNode, emptyNode, groupNode("红队技能", groups.redteam, "head-redteam"), groupNode("官方技能", groups.official, "head-official")), h("div", { className: "rt-main" }, detailPane(runtime, props))));
    }
    /** 加载技能目录。 */
    async function loadSkillCatalog(api, force) {
        const response = await api.raw({ op: "skillCatalog", refresh: force });
        return (0, skills_model_js_1.catalogLoadOf)(response);
    }
    /** 读取技能详情。 */
    async function loadSkillDetail(api, item) {
        const response = await api.raw({
            op: "skillRead",
            name: item.name,
            library: item.library,
        });
        if (response.ok === false) {
            return { detail: null, error: response.error ?? "读取失败" };
        }
        return { detail: (0, skills_model_js_1.detailOf)(response), error: null };
    }
    /** 切换过滤条件里的一个布尔项（不修改原对象）。 */
    function toggleFilterFlag(filter, flag) {
        return { ...filter, [flag]: !filter[flag] };
    }
    /** 重置过滤条件。 */
    function resetFilter() {
        return skills_model_js_1.DEFAULT_SKILL_FILTER;
    }
    /** 由点击算出新的 activeKey（复用模型层语义）。 */
    function nextActiveKey(current, item) {
        return (0, skills_model_js_1.toggleActive)(current, item);
    }
});
/**
 * 当前测试页（`testing` 页签，也是资产页的「当前测试」视图）的数据模型。
 *
 * ## 抽取重点
 *
 * 原 `TestingTab`（138 行）里有两处**活的并发逻辑**：
 *
 * 1. **5 秒轮询 + 在途守卫**：
 *    ```js
 *    const inflight = React.useRef(false)
 *    const seq = React.useRef(0)
 *    const load = () => {
 *      if (!eng || inflight.current) return    // ← 在途时直接跳过，不排队
 *      inflight.current = true
 *      const my = ++seq.current
 *      api({...}).then((r) => { if (my !== seq.current) return; ... })
 *        .finally(() => { if (my === seq.current) inflight.current = false })
 *    }
 *    ```
 *    守卫的作用是「网络慢/后端卡住时请求不堆积」+「旧响应不覆盖新状态」。
 *    `finally` 里**又判了一次 seq**：切靶标后旧请求的 finally 不能把新请求的
 *    inflight 清掉（否则并发闸门失效）。
 * 2. **三块折叠的记忆**：`testing:eng` / `recent:eng` / `queue:eng`
 *    三条键都带靶标 id（切靶标时各自独立），其中「正在测」虽然理论上
 *    可折叠，但原注释说「正在测永远常显，不参与折叠」—— 实际代码里
 *    `open: collapse.isOpen('testing:' + eng, true)` 是**可折叠**的，
 *    只是默认展开、且「全部收起」按钮会把它一起收起。这里按**代码**迁，
 *    不按注释（注释与代码不一致时以代码为准，因为用户看到的是代码行为）。
 */
define("redteam/client/testing-model", ["require", "exports", "shared/result", "redteam/client/label"], function (require, exports, result_js_4, label_js_6) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.COLLAPSE_ALL_TITLE = exports.EXPAND_ALL_TITLE = exports.AUTO_TITLE = exports.QUEUE_HINT = exports.EMPTY_QUEUE_TEXT = exports.EMPTY_RECENT_TEXT = exports.EMPTY_TESTING_TEXT = exports.LOADING_TEXT = exports.NO_ENGAGEMENT_TEXT = exports.ACTIVE_TESTS_LIMIT = exports.POLL_INTERVAL_MS = exports.SECTION_DEFAULTS = exports.EMPTY_TEST_STATS = exports.MAX_NOTE_CHARS = exports.MAX_NOTE_LINES = void 0;
    exports.testedAssetOf = testedAssetOf;
    exports.assetChips = assetChips;
    exports.noteLines = noteLines;
    exports.statusLabel = statusLabel;
    exports.statusClass = statusClass;
    exports.surfaceLine = surfaceLine;
    exports.potentialLine = potentialLine;
    exports.updatedText = updatedText;
    exports.testStatsOf = testStatsOf;
    exports.conclusionItems = conclusionItems;
    exports.activeTestsOf = activeTestsOf;
    exports.collapseKey = collapseKey;
    exports.sectionKeys = sectionKeys;
    exports.createPollGuard = createPollGuard;
    exports.activeTestsRequest = activeTestsRequest;
    exports.loadActiveTests = loadActiveTests;
    exports.testingSubtitle = testingSubtitle;
    exports.updatedAtText = updatedAtText;
    exports.autoLabel = autoLabel;
    /* ══════════════════════════════════════════════════════════════ 窄化原语 */
    function text(value) {
        return typeof value === "string" ? value : "";
    }
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    function arrayOf(value) {
        return Array.isArray(value) ? value : [];
    }
    function countOrZero(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    /** 解析一台资产。 */
    function testedAssetOf(raw) {
        const entry = recordOf(raw);
        return {
            id: countOrZero(entry["id"]),
            ip: text(entry["ip"]),
            segmentCidr: text(entry["segment_cidr"]) || text(entry["segmentCidr"]),
            scope: entry["scope"] === "internal" ? "internal" : "external",
            testStatus: text(entry["test_status"]) || text(entry["testStatus"]),
            testNotes: text(entry["test_notes"]) || text(entry["testNotes"]),
            testSurface: text(entry["test_surface"]) || text(entry["testSurface"]),
            testUpdatedAt: text(entry["test_updated_at"]) || text(entry["testUpdatedAt"]),
            testUpdatedBy: text(entry["test_updated_by"]) || text(entry["testUpdatedBy"]),
            blockedCount: countOrZero(entry["blocked_count"]) || countOrZero(entry["blockedCount"]),
            priority: text(entry["priority"]),
            potential: text(entry["potential"]),
            openPorts: countOrZero(entry["open_ports"]) || countOrZero(entry["openPorts"]),
            vulns: countOrZero(entry["vulns"]),
            webshells: countOrZero(entry["webshells"]),
            tunnels: countOrZero(entry["tunnels"]),
        };
    }
    /**
     * 资产卡的 chips。
     *
     * 顺序即界面顺序，逐条对应原实现：归属 → C 段 → 开放端口 → 已确认漏洞 →
     * WebShell → 隧道 → 易打性 → 被封次数。**每一项都在非 0/非空时才出现**。
     */
    function assetChips(asset) {
        const chips = [
            {
                key: "sc",
                className: "rt-scope rt-scope-" + (asset.scope === "internal" ? "internal" : "external"),
                label: asset.scope === "internal" ? "内网" : "外网",
            },
        ];
        if (asset.segmentCidr !== "") {
            chips.push({ key: "seg", className: "rt-tag", label: asset.segmentCidr });
        }
        if (asset.openPorts > 0) {
            chips.push({ key: "p", className: "rt-tag rt-tag-active", label: "开放 " + asset.openPorts + " 端口" });
        }
        if (asset.vulns > 0) {
            chips.push({ key: "v", className: "rt-tag rt-tag-live", label: "已确认漏洞 " + asset.vulns });
        }
        if (asset.webshells > 0) {
            chips.push({ key: "w", className: "rt-tag rt-tag-passive", label: "WebShell " + asset.webshells });
        }
        if (asset.tunnels > 0) {
            chips.push({ key: "t", className: "rt-tag rt-tag-passive", label: "隧道 " + asset.tunnels });
        }
        if (asset.priority !== "") {
            chips.push({ key: "pr", className: "rt-tag", label: "易打 " + asset.priority });
        }
        if (asset.blockedCount > 0) {
            chips.push({
                key: "b",
                className: "rt-tag",
                label: "被封 " + asset.blockedCount + " 次",
            });
        }
        return chips;
    }
    /** 测试记录最多显示的行数（原实现 `slice(-3)`：**取最后 3 行**）。 */
    exports.MAX_NOTE_LINES = 3;
    /** 单行测试记录的最大字符数（超出截断并加 ` …`）。 */
    exports.MAX_NOTE_CHARS = 240;
    /**
     * 资产卡的测试记录（最后 3 行，每行最长 240 字符）。
     *
     * `slice(-3)` 是关键：测试记录是**追加**的，最近的动作在最后几行；
     * 取前 3 行会永远显示最早的「开始测试」而看不到最新进展。
     */
    function noteLines(asset) {
        if (asset.testNotes === "")
            return [];
        return asset.testNotes
            .split("\n")
            .slice(-exports.MAX_NOTE_LINES)
            .map((line) => (line.length > exports.MAX_NOTE_CHARS ? line.slice(0, exports.MAX_NOTE_CHARS) + " …" : line));
    }
    /** 资产卡的标题状态标签。 */
    function statusLabel(asset) {
        const key = asset.testStatus;
        return label_js_6.TEST_STATUS_LABEL[key] ?? asset.testStatus;
    }
    /** 状态标签的类名（测试中才高亮）。 */
    function statusClass(asset) {
        return "rt-tag " + (asset.testStatus === "testing" ? "rt-tag-live" : "");
    }
    /** 「测试面」行（空 → `null`，不渲染）。 */
    function surfaceLine(asset) {
        return asset.testSurface !== "" ? "测试面：" + asset.testSurface : null;
    }
    /** 「预期得分」行（空 → `null`，不渲染）。 */
    function potentialLine(asset) {
        return asset.potential !== "" ? "预期得分：" + asset.potential : null;
    }
    /** 卡的更新时间文本（`时间 · 角色`）。 */
    function updatedText(asset, timeText) {
        return asset.testUpdatedBy !== "" ? timeText + " · " + asset.testUpdatedBy : timeText;
    }
    /** 空计数。 */
    exports.EMPTY_TEST_STATS = Object.freeze({
        testing: 0,
        untested: 0,
        tested: 0,
        abandoned: 0,
        blocked: 0,
        noSurface: 0,
    });
    /** 解析 `stats`。 */
    function testStatsOf(raw) {
        const entry = recordOf(raw);
        return {
            testing: countOrZero(entry["testing"]),
            untested: countOrZero(entry["untested"]),
            tested: countOrZero(entry["tested"]),
            abandoned: countOrZero(entry["abandoned"]),
            blocked: countOrZero(entry["blocked"]),
            noSurface: countOrZero(entry["no_surface"]) || countOrZero(entry["noSurface"]),
        };
    }
    /** 五条结论项（顺序即界面顺序）。 */
    function conclusionItems(stats) {
        return [
            { key: "testing", label: "测试中", value: stats.testing },
            { key: "untested", label: "待测", value: stats.untested },
            { key: "tested", label: "已测", value: stats.tested },
            // 「放弃」是两类之和：已放弃 + 被封禁。
            { key: "giveup", label: "放弃", value: stats.abandoned + stats.blocked },
            { key: "noSurface", label: "无攻击面", value: stats.noSurface },
        ];
    }
    /** 解析 `op: activeTests` 的响应。 */
    function activeTestsOf(response) {
        const body = recordOf(response);
        return {
            testing: arrayOf(body["testing"]).map(testedAssetOf),
            recent: arrayOf(body["recent"]).map(testedAssetOf),
            queue: arrayOf(body["queue"]).map(testedAssetOf),
            stats: testStatsOf(body["stats"]),
            untested: countOrZero(body["untested"]),
        };
    }
    /* ══════════════════════════════════════════════════════════════ 折叠键 */
    /** 三个区块的折叠键都带靶标 id（切靶标各自独立）。 */
    function collapseKey(kind, engagement) {
        return kind + ":" + engagement;
    }
    /** 三个区块的键（「全部展开/收起」一次设三个）。 */
    function sectionKeys(engagement) {
        return [
            collapseKey("testing", engagement),
            collapseKey("recent", engagement),
            collapseKey("queue", engagement),
        ];
    }
    /** 三个区块的默认展开态：「正在测」展开，另两个折叠。 */
    exports.SECTION_DEFAULTS = Object.freeze({
        testing: true,
        recent: false,
        queue: false,
    });
    /* ══════════════════════════════════════════════════════════════ 轮询 */
    /** 轮询间隔（毫秒）。 */
    exports.POLL_INTERVAL_MS = 5000;
    /** 每次拉的条数上限。 */
    exports.ACTIVE_TESTS_LIMIT = 20;
    /** 造一个在途守卫。 */
    function createPollGuard() {
        let seq = 0;
        let running = false;
        return {
            get inflight() {
                return running;
            },
            begin() {
                // 在途时**直接跳过**：不排队、不并发（原实现的语义）。
                if (running)
                    return null;
                running = true;
                seq += 1;
                return seq;
            },
            isCurrent(token) {
                return token === seq;
            },
            finish(token) {
                // 切靶标后旧请求的 finish 不能把新请求的闸门释放掉。
                if (token === seq)
                    running = false;
            },
            invalidate() {
                seq += 1;
                running = false;
            },
        };
    }
    /* ══════════════════════════════════════════════════════════════ 请求 */
    /** 请求 `op: activeTests`。 */
    function activeTestsRequest(engagement) {
        return { op: "activeTests", engagement, limit: exports.ACTIVE_TESTS_LIMIT };
    }
    /** 从响应里取错误文案。 */
    function errorOf(response, fallback) {
        if (response === null || response === undefined)
            return fallback;
        const body = recordOf(response);
        if (body["ok"] !== false)
            return null;
        const message = body["error"];
        return typeof message === "string" && message !== "" ? message : fallback;
    }
    /** 加载当前测试数据。 */
    async function loadActiveTests(api, engagement) {
        const response = await api.raw(activeTestsRequest(engagement));
        const error = errorOf(response, "读取失败");
        if (error !== null)
            return (0, result_js_4.err)(error);
        return (0, result_js_4.ok)(activeTestsOf(response));
    }
    /* ══════════════════════════════════════════════════════════════ 空态 */
    /** 未选靶标。 */
    exports.NO_ENGAGEMENT_TEXT = "请先在顶部选择或创建靶标，再查看当前测试。";
    /** 加载中。 */
    exports.LOADING_TEXT = "加载中…";
    /** 「正在测」为空时的说明。 */
    exports.EMPTY_TESTING_TEXT = "当前没有资产处于「测试中」";
    /** 「最近动过」为空。 */
    exports.EMPTY_RECENT_TEXT = "暂无";
    /** 「待测队列」为空。 */
    exports.EMPTY_QUEUE_TEXT = "没有待测资产";
    /** 待测队列尾部的引导。 */
    exports.QUEUE_HINT = "完整清单（含筛选与排序）见「资产测绘」页";
    /** 「正在测」区块的副标题（空/非空两态）。 */
    function testingSubtitle(count) {
        return count > 0 ? "agent 正在打这些资产" : "agent 开始测某台资产后会实时出现在这里";
    }
    /** 结论行的「更新于 HH:MM:SS」。 */
    function updatedAtText(time) {
        if (time === null)
            return null;
        return "更新于 " + time.toLocaleTimeString("zh-CN", { hour12: false });
    }
    /** 实时开关的文案。 */
    function autoLabel(auto) {
        return auto ? "实时 · 5s" : "已暂停";
    }
    /** 实时开关的 tooltip。 */
    exports.AUTO_TITLE = "每 5 秒自动刷新";
    /** 「全部展开」的 tooltip。 */
    exports.EXPAND_ALL_TITLE = "展开最近动过与待测队列";
    /** 「全部收起」的 tooltip。 */
    exports.COLLAPSE_ALL_TITLE = "只留正在测";
});
/**
 * 当前测试页（`testing` 页签）的渲染。
 *
 * 数据与轮询守卫全在 `testing-model.ts`，这里只排版。
 *
 * ## 三个区块
 *
 * ```
 * ┌────────────────────────────────────────────────────────────┐
 * │ 测试中 2  待测 8  已测 5  放弃 1  无攻击面 0  更新于 12:34:56│
 * │                       [全部展开] [全部收起] [实时·5s] [刷新] │
 * ├────────────────────────────────────────────────────────────┤
 * │ ▾ 正在测 · 2 台    agent 正在打这些资产                      │
 * │   ● 10.0.0.5 [测试中]                    [测试记录] 复制 展开│
 * ├────────────────────────────────────────────────────────────┤
 * │ ▸ 最近动过 · 5 台  已测过的资产                              │
 * │ ▸ 待测队列 · 8 台  按易打性与端口数排出先打哪几台            │
 * └────────────────────────────────────────────────────────────┘
 *
 * ## 一个原实现的现象，这里保留
 *
 * 「正在测」区块的注释写着「永远常显、不参与折叠」，但**代码**是
 * `open: collapse.isOpen('testing:' + eng, true)` —— 它确实可折叠，
 * 「全部收起」也会把它一起收起。这里按代码行为迁（用户看到的是代码）。
 */
define("redteam/client/testing-tab", ["require", "exports", "redteam/client/helpers", "redteam/client/testing-model"], function (require, exports, helpers_js_14, testing_model_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderTestingTab = renderTestingTab;
    exports.defaultTestingProps = defaultTestingProps;
    /** 取区块展开态。 */
    function isOpen(collapsed, key, fallback) {
        const stored = collapsed[key];
        return stored === undefined ? fallback : stored === true;
    }
    /** 测试记录折叠（原 `Clip` 的最小面；展开态由 props 承载）。 */
    function clip(runtime, props, asset, text) {
        const { h } = runtime;
        if (text.trim() === "")
            return null;
        const open = props.openNotes.includes(asset.id);
        return h("div", { className: "rt-clip" + (open ? " open" : "") }, h("div", { className: "rt-clip-head" }, h("span", { className: "rt-clip-label" }, "测试记录"), h("div", { className: "rt-spacer" }), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: (event) => {
                event.stopPropagation?.();
                props.onCopy(text);
            },
        }, "复制"), h("button", {
            className: "rt-btn",
            style: { padding: "0 6px", fontSize: 11 },
            onClick: (event) => {
                event.stopPropagation?.();
                props.onToggleNotes(asset.id);
            },
        }, open ? "收起" : "展开")), h("div", { className: "rt-clip-body" }, text));
    }
    /** 一台资产一张卡：一眼看清「打的是谁、打到哪、拿到什么」。 */
    function assetCard(runtime, props, asset, past) {
        const { h } = runtime;
        const chips = (0, testing_model_js_1.assetChips)(asset);
        const notes = (0, testing_model_js_1.noteLines)(asset);
        const surface = (0, testing_model_js_1.surfaceLine)(asset);
        const potential = (0, testing_model_js_1.potentialLine)(asset);
        return h("div", { key: "at" + asset.id, className: "rt-atest" + (past ? " past" : "") }, h("div", { className: "rt-atest-head" }, 
        // 正在测的卡片带绿色呼吸点；历史卡片不带（不动的资产不该有「活的」指示）。
        past ? null : h("span", { className: "rt-live-dot" }), h("span", { className: "rt-atest-ip" }, asset.ip), h("span", { className: (0, testing_model_js_1.statusClass)(asset) }, (0, testing_model_js_1.statusLabel)(asset)), h("div", { className: "rt-spacer" }), h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, (0, testing_model_js_1.updatedText)(asset, (0, helpers_js_14.formatTimestamp)(asset.testUpdatedAt)))), chips.length > 0
            ? h("div", null, chips.map((chip) => h("span", {
                key: chip.key,
                className: chip.className,
                ...(chip.title !== undefined ? { title: chip.title } : {}),
            }, chip.label)))
            : null, surface !== null ? h("div", { className: "rt-atest-meta" }, surface) : null, potential !== null ? h("div", { className: "rt-atest-meta" }, potential) : null, notes.length > 0 ? clip(runtime, props, asset, notes.join("\n")) : null);
    }
    /** 一个区块（统一折叠头）。 */
    function section(runtime, props, key, tone, title, count, sub, fallbackOpen, children) {
        const { h } = runtime;
        const open = isOpen(props.collapsed, key, fallbackOpen);
        return h("div", { className: "rt-sec-wrap" }, h("div", {
            className: "rt-sec t-" + tone,
            ...(0, helpers_js_14.clickable)(() => props.onToggleSection(key), { label: title, expanded: open }),
        }, h("span", { className: "rt-sec-caret" }, open ? "▾" : "▸"), h("span", { className: "rt-sec-title" }, title), h("span", { className: "rt-sec-count" }, count), h("span", { className: "rt-sec-sub" }, sub)), open ? h("div", { className: "rt-sec-body" }, children) : null);
    }
    /**
     * 渲染当前测试页。
     *
     * 无 hook、不读全局，只按 props 拼元素树。
     */
    function renderTestingTab(runtime, props) {
        const { h } = runtime;
        if (props.engagement === null || props.engagement === "") {
            return h("div", { className: "rt-main" }, h("div", { className: "rt-empty" }, testing_model_js_1.NO_ENGAGEMENT_TEXT));
        }
        const engagement = props.engagement;
        const data = props.data;
        const testing = data?.testing ?? [];
        const recent = data?.recent ?? [];
        const queue = data?.queue ?? [];
        const stats = data?.stats ?? { testing: 0, untested: 0, tested: 0, abandoned: 0, blocked: 0, noSurface: 0 };
        const items = (0, testing_model_js_1.conclusionItems)(stats);
        const at = (0, testing_model_js_1.updatedAtText)(props.updatedAt);
        const conclusion = h("div", { className: "rt-concl" }, items.map((item) => h("span", {
            key: item.key,
            className: "rt-concl-i",
            style: { cursor: "default" },
        }, h("b", null, String(item.value)), h("span", null, item.label))), h("div", { className: "rt-spacer" }), at !== null
            ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, at)
            : null, h("button", {
            className: "rt-btn",
            style: { padding: "0 7px", fontSize: 11 },
            title: testing_model_js_1.EXPAND_ALL_TITLE,
            onClick: () => props.onExpandAll(),
        }, "全部展开"), h("button", {
            className: "rt-btn",
            style: { padding: "0 7px", fontSize: 11 },
            title: testing_model_js_1.COLLAPSE_ALL_TITLE,
            onClick: () => props.onCollapseAll(),
        }, "全部收起"), h("button", {
            className: "rt-btn" + (props.auto ? " rt-btn-primary" : ""),
            style: { padding: "0 7px", fontSize: 11 },
            title: testing_model_js_1.AUTO_TITLE,
            onClick: () => props.onToggleAuto(),
        }, (0, testing_model_js_1.autoLabel)(props.auto)), h("button", {
            className: "rt-btn",
            style: { padding: "0 7px", fontSize: 11 },
            onClick: () => props.onRefresh(),
        }, "刷新"));
        const body = [
            section(runtime, props, (0, testing_model_js_1.collapseKey)("testing", engagement), "test", "正在测", testing.length + " 台", (0, testing_model_js_1.testingSubtitle)(testing.length), testing_model_js_1.SECTION_DEFAULTS.testing, testing.length > 0
                ? testing.map((asset) => assetCard(runtime, props, asset, false))
                : h("div", { className: "rt-atest-meta", style: { paddingBottom: 4 } }, testing_model_js_1.EMPTY_TESTING_TEXT)),
            section(runtime, props, (0, testing_model_js_1.collapseKey)("recent", engagement), "past", "最近动过", recent.length + " 台", "已测过的资产", testing_model_js_1.SECTION_DEFAULTS.recent, recent.length > 0
                ? recent.map((asset) => assetCard(runtime, props, asset, true))
                : h("div", { className: "rt-atest-meta" }, testing_model_js_1.EMPTY_RECENT_TEXT)),
            section(runtime, props, (0, testing_model_js_1.collapseKey)("queue", engagement), "queue", "待测队列", (data !== null ? data.untested : 0) + " 台", "按易打性与端口数排出先打哪几台", testing_model_js_1.SECTION_DEFAULTS.queue, queue.length > 0
                ? [
                    ...queue.map((asset) => assetCard(runtime, props, asset, true)),
                    h("div", { key: "queueHint", className: "rt-atest-meta", style: { paddingTop: 4 } }, testing_model_js_1.QUEUE_HINT),
                ]
                : h("div", { className: "rt-atest-meta" }, testing_model_js_1.EMPTY_QUEUE_TEXT)),
        ];
        return h("div", { className: "rt-main" }, conclusion, props.error !== null ? h("div", { className: "rt-err" }, props.error) : null, data === null && props.error === null ? h("div", { className: "rt-empty" }, testing_model_js_1.LOADING_TEXT) : null, h("div", { className: "rt-body", style: { overflow: "auto" } }, h("div", { style: { padding: "6px 12px 14px" } }, body)));
    }
    /** 默认 props（供测试与未接线场景）。 */
    function defaultTestingProps(engagement) {
        return {
            engagement,
            data: null,
            error: null,
            updatedAt: null,
            auto: true,
            collapsed: {},
            onRefresh: () => undefined,
            onToggleAuto: () => undefined,
            onToggleSection: () => undefined,
            onExpandAll: () => undefined,
            onCollapseAll: () => undefined,
            openNotes: [],
            onToggleNotes: () => undefined,
            onCopy: () => undefined,
        };
    }
});
/**
 * 页签分派表：把 `ConsoleTabId` 映射到具体的渲染函数。
 *
 * ## 为什么需要这一层
 *
 * 12 个页签各自是**纯函数**（`renderXxxTab(runtime, props)`）：props 进、回调出、
 * 无 hook、不读全局。这是刻意的——它让每个页签都能在 `node:test` 里直接渲染
 * 断言，不需要 DOM 或 React 运行时。
 *
 * 但「纯函数」也意味着它们不会自己取数据。取数（`loadAssets` / `loadSessions` …）
 * 与状态（`useState`）必须由**有状态的外层**提供。这一层就是这个外层的最小面：
 * 它只做三件事——按 tab id 分派、把注入槽（`attackFilesNode` / `renderShots`）
 * 接好、在缺少必需数据时给出明确的空态而不是白屏。
 *
 * ## 与上游的关系
 *
 * 上游每个 `XxxTab` 都是一个大组件，内部 `useState` + `api(...)` 混在一起。
 * 这里把「取数」推给宿主容器（`panel.ts` 的调用方），分派表只负责排版与
 * 槽位接线。好处是分派表本身零状态、可测；代价是容器要多传几项 props
 * —— 这是有意的取舍：状态集中在容器，页签保持可测。
 *
 * ## 缺数据时的行为
 *
 * 每个页签在 `data === null` 时都会渲染自己的空态（这是各 tab 的契约，
 * 有专门用例覆盖）。分派表不再额外包一层「加载中」，避免两套空态打架。
 */
define("redteam/client/tab-registry", ["require", "exports", "redteam/client/assets-tab", "redteam/client/chain-tab", "redteam/client/env-tab", "redteam/client/findings-tab", "redteam/client/knowledge-tab", "redteam/client/prompts-tab", "redteam/client/report-tab", "redteam/client/score-tab", "redteam/client/session-tab", "redteam/client/skills-tab", "redteam/client/testing-tab", "redteam/client/attackfiles-tab"], function (require, exports, assets_tab_js_1, chain_tab_js_1, env_tab_js_1, findings_tab_js_1, knowledge_tab_js_1, prompts_tab_js_1, report_tab_js_1, score_tab_js_1, session_tab_js_1, skills_tab_js_1, testing_tab_js_1, attackfiles_tab_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.renderTabContent = renderTabContent;
    exports.makeRenderTab = makeRenderTab;
    /** 某个页签没有数据时的统一空态文案。 */
    const MISSING = Object.freeze({
        assets: "还没有资产数据（先跑信息收集）",
        env: "环境适配数据未加载",
        sessions: "还没有会话或隧道（先拿到入口）",
        findings: "还没有漏洞战果",
        chain: "还没有攻击链步骤",
        scores: "得分目标未加载",
        report: "还没有可生成的报告",
        knowledge: "知识库未加载",
        skills: "技能库未加载",
        testing: "还没有待测资产",
        attackfiles: "还没有保存的攻击文件",
        prompts: "提示词目录未加载",
        agents: "智能体概览未接入",
    });
    /**
     * 按页签 id 渲染。
     *
     * 分派用 `switch` 而不是查表函数：TS 能在这里做**穷尽性检查**
     * （`default` 分支里若 `tab` 不是 `never` 就编译报错），
     * 以后给 `ConsoleTabId` 加新页签时会强制你在这里补一行，不会静默白屏。
     */
    function renderTabContent(runtime, tab, props) {
        const { h } = runtime;
        const empty = (tab) => h("div", { className: "rt-empty" }, MISSING[tab] ?? "该页签暂无内容");
        /**
         * 兜底：**任何一个页签渲染抛错，都不能让整个面板白屏**。
         *
         * 为什么这一层必须有：宿主的 React 错误边界在组件抛错时会把整棵子树
         * 换成白屏 —— 用户看到的是「面板没了」，连切到别的页签都做不到，
         * 也不知道发生了什么。而页签渲染是数据形状最不可控的地方：
         * 容器可能把未经模型层解析的原始对象喂进来（宿主新增/改名字段），
         * 某个页签少一个 `undefined` 守卫就会连带整块面板。
         *
         * 降级原则：**保面板、弃本页**。把错误如实显示出来（含消息），
         * 其它页签照常可用，用户能自己切走或去环境适配页修配置。
         */
        try {
            return dispatch(runtime, tab, props, empty);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return h("div", { className: "rt-pane" }, h("div", { className: "rt-err" }, "「" + tab + "」页签渲染失败：" + message), h("div", { className: "rt-empty" }, h("div", null, "面板与其它页签仍可使用。"), h("div", { style: { marginTop: 6, fontSize: 11.5 } }, "常见原因：宿主返回的数据结构与预期不符（新增/改名字段）。"), h("div", { style: { marginTop: 6, fontSize: 11.5 } }, "可先到「环境适配」页确认宿主版本，或刷新重试。")));
        }
    }
    /**
     * 真正的分派（不含错误兜底）。
     *
     * 单独拆出来是为了让 `renderTabContent` 能在外层套一层保护：
     * 页签渲染是**最后一个可能整页崩掉的地方** —— 它一旦抛错，宿主的 React
     * 错误边界会把整个面板换成白屏，用户连换页签都做不到。
     */
    function dispatch(runtime, tab, props, empty) {
        const { h } = runtime;
        switch (tab) {
            case "assets": {
                const p = props.assets;
                if (p === undefined)
                    return empty(tab);
                // 「资产测绘」与「测试状态」在上游是同一个组件（`AssetsTab({view})`）。
                // 这里保留该结构：`view: "testing"` 时由 `renderTesting` 注入子视图，
                // 避免两个页签各自维护一套资产列表与筛选条件。
                return (0, assets_tab_js_1.renderAssetsTab)(runtime, {
                    ...p,
                    ...(props.testing !== undefined
                        ? { renderTesting: () => (0, testing_tab_js_1.renderTestingTab)(runtime, props.testing) }
                        : {}),
                });
            }
            case "env": {
                const p = props.env;
                return p === undefined ? empty(tab) : (0, env_tab_js_1.renderEnvTab)(runtime, p);
            }
            case "sessions": {
                const p = props.sessions;
                return p === undefined ? empty(tab) : (0, session_tab_js_1.renderSessionTab)(runtime, p);
            }
            case "findings": {
                const p = props.findings;
                if (p === undefined)
                    return empty(tab);
                // 「攻击文件」是 findings 的子页签：上游把它内嵌在 FindingsTab 里，
                // 这里通过注入槽传节点，而不是让 findings-tab 直接 import 另一个页签
                // （那会形成 tab 之间的循环依赖，且让 findings 的单测被迫拉起 attackfiles）。
                return (0, findings_tab_js_1.renderFindingsTab)(runtime, {
                    ...p,
                    ...(props.attackfiles !== undefined
                        ? { attackFilesNode: (0, attackfiles_tab_js_1.renderAttackFilesTab)(runtime, props.attackfiles) }
                        : {}),
                });
            }
            case "chain": {
                const p = props.chain;
                return p === undefined ? empty(tab) : (0, chain_tab_js_1.renderChainTab)(runtime, p);
            }
            case "scores": {
                const p = props.scores;
                return p === undefined ? empty(tab) : (0, score_tab_js_1.renderScoreTab)(runtime, p);
            }
            case "report": {
                const p = props.report;
                return p === undefined ? empty(tab) : (0, report_tab_js_1.renderReportTab)(runtime, p);
            }
            case "knowledge": {
                const p = props.knowledge;
                return p === undefined ? empty(tab) : (0, knowledge_tab_js_1.renderKnowledgeTab)(runtime, p);
            }
            case "skills": {
                const p = props.skills;
                return p === undefined ? empty(tab) : (0, skills_tab_js_1.renderSkillsTab)(runtime, p);
            }
            case "testing": {
                const p = props.testing;
                return p === undefined ? empty(tab) : (0, testing_tab_js_1.renderTestingTab)(runtime, p);
            }
            case "attackfiles": {
                const p = props.attackfiles;
                return p === undefined ? empty(tab) : (0, attackfiles_tab_js_1.renderAttackFilesTab)(runtime, p);
            }
            case "prompts": {
                const p = props.prompts;
                return p === undefined ? empty(tab) : (0, prompts_tab_js_1.renderPromptsTab)(runtime, p);
            }
            case "agents": {
                // 智能体概览属于插件生命周期层（`src/plugin/`），不在客户端渲染。
                return empty(tab);
            }
            default: {
                // 穷尽性检查：若 `ConsoleTabId` 新增了值而这里没补分支，
                // 下面这行会让 `tab` 不是 `never` 而**编译失败**。
                const exhaustive = tab;
                return h("div", { className: "rt-empty" }, "未知页签：" + String(exhaustive));
            }
        }
    }
    /**
     * 造一个可直接传给 `renderPanel` 的 `renderTab` 函数。
     *
     * 用法：
     * ```ts
     * renderPanel(runtime, { ..., renderTab: makeRenderTab(runtime, { skills: {...} }) }, opts)
     * ```
     */
    function makeRenderTab(runtime, props) {
        return (tab) => renderTabContent(runtime, tab, props);
    }
});
/**
 * A 组六个页签的**取数与状态**接线：
 * 资产测绘 / 会话隧道 / 漏洞战果 / 攻击链 / 得分目标 / 环境适配。
 *
 * ## 这一层在整条链上的位置
 *
 * ```
 * 宿主 fetch ──► client/api.ts (makeApiClient, 永不 reject)
 *                     │
 *                     ▼
 *           ┌─────────────────────┐
 *           │  本文件 tabs-a.ts    │  ← 唯一的「有状态」层
 *           │  取数 + 状态 + 回调   │
 *           └─────────────────────┘
 *                     │  props（纯值 + 真回调）
 *                     ▼
 *        client/*-tab.ts  renderXxxTab(runtime, props)   ← 纯函数
 *                     │
 *                     ▼
 *            client/*-model.ts   响应 → props 值的转换（已存在，直接复用）
 * ```
 *
 * **本文件不发明任何数据结构**。`client/*-model.ts`（约 18,275 行测试撑着）
 * 已经写好了「响应 → props 值」的全部转换（`assetListOf` / `sessionDataOf` /
 * `findingsOf` / `chainDataOf` / `scoreBoardOf` / `draftFromResponse` …）与
 * 全部请求构造（`assetsRequest` / `sessionsRequest` / `scoresRequest` …）。
 * 这里只做三件事：
 *
 * 1. 调 `api.raw(...)` 拿响应，喂给上面那些转换函数；
 * 2. 把结果存进一份不可变 state，并在变化时通知订阅者；
 * 3. 把 state 与**真的会生效的回调**拼成每个页签要求的 props。
 *
 * ## 为什么是「工厂 + 显式 state」而不是 React 组件
 *
 * 页签本身是纯函数（无 hook），所以「状态放哪」是自由的。放这里的好处：
 * 取数逻辑可以脱离 React 直接测（喂假 fetch → 断言 state → 断言渲染文本），
 * 而容器只需要 `subscribe()` + 重新渲染。这与 `client/` 里 3,700+ 用例
 * 的组织方式一致。
 *
 * ## 三条实现纪律
 *
 * 1. **不塞空函数**。每个 `onXxx` 都真的改 state 或真的发请求 ——
 *    `() => {}` 能骗过类型检查，但等于没接（本任务的意义就在这）。
 * 2. **拿不到的宿主能力如实降级**。`renderTesting` / `attackFilesNode` /
 *    剪贴板这类需要别的页签或宿主注入的东西，缺了就让它 `undefined` 走
 *    页签自己的空态，**不造假数据**。见文末「未填满的 props」。
 * 3. **零 `any`**。不可信响应一律 `unknown` + 窄化，与 `assets-model.ts` 同风格。
 *
 * ## 模块顶层零副作用
 *
 * `client.js` 的构建产物要求**两次构建字节一致**。所以本模块在顶层
 * 只允许 `const` 字面量与 `function` 声明：没有 `Date.now()` /
 * `Math.random()` / `Object.keys()` 拼串 / 任何 I/O。
 * 时间只在函数体内取（运行时的值不进产物字节）。
 */
define("redteam/ui/tabs-a", ["require", "exports", "redteam/client/state", "redteam/client/api", "redteam/client/assets-model", "redteam/client/assets-model", "redteam/client/session-model", "redteam/client/findings-model", "redteam/client/findings-tab", "redteam/client/chain-model", "redteam/client/chain-tab", "redteam/client/score-model", "redteam/client/env-tab", "redteam/client/env-model"], function (require, exports, state_js_7, api_js_1, assets_model_js_2, assets_model_js_3, session_model_js_2, findings_model_js_2, findings_tab_js_2, chain_model_js_2, chain_tab_js_2, score_model_js_2, env_tab_js_2, env_model_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.UNUSED_OPS = exports.KNOWN_SHAPE_GAPS = exports.UNFILLED_PROPS = exports.discoveryOf = exports.webAssetsOf = exports.domainGroupsOf = exports.assetListOf = exports.assetDetailOf = exports.TABS_A_OWNED = void 0;
    exports.makeWindowCopy = makeWindowCopy;
    exports.initialState = initialState;
    exports.ownsTab = ownsTab;
    exports.flattenPlatform = flattenPlatform;
    exports.makeTabsA = makeTabsA;
    exports.assetDetailRequest = assetDetailRequest;
    exports.domainsRequestOf = domainsRequestOf;
    exports.webRequestOf = webRequestOf;
    exports.discoveryRequestOf = discoveryRequestOf;
    exports.conclusionFilter = conclusionFilter;
    Object.defineProperty(exports, "assetDetailOf", { enumerable: true, get: function () { return assets_model_js_2.assetDetailOf; } });
    Object.defineProperty(exports, "assetListOf", { enumerable: true, get: function () { return assets_model_js_2.assetListOf; } });
    Object.defineProperty(exports, "discoveryOf", { enumerable: true, get: function () { return assets_model_js_2.discoveryOf; } });
    Object.defineProperty(exports, "domainGroupsOf", { enumerable: true, get: function () { return assets_model_js_2.domainGroupsOf; } });
    Object.defineProperty(exports, "webAssetsOf", { enumerable: true, get: function () { return assets_model_js_2.webAssetsOf; } });
    /* ══════════════════════════════════════════════════════════════ 窄化原语 */
    /** 从不可信值读对象（数组 / `null` 都算没有）。 */
    function recordOf(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {};
    }
    /** 从不可信值读字符串。 */
    function textOf(value) {
        return typeof value === "string" ? value : "";
    }
    /** 用注入的 window 造一个真实的复制实现（控制台容器可直接用）。 */
    function makeWindowCopy(windowRef) {
        return (text) => {
            const clipboard = windowRef.navigator?.clipboard;
            if (clipboard !== undefined) {
                return clipboard.writeText(text).then(() => true, () => false);
            }
            // 老浏览器 / 无 navigator：退回 textarea + execCommand('copy')。
            try {
                const control = windowRef.document.createElement("textarea");
                control.value = text;
                control.setAttribute("readonly", "");
                control.style.position = "fixed";
                control.style.left = "-9999px";
                windowRef.document.body.appendChild(control);
                control.select();
                const ok = windowRef.document.execCommand("copy");
                windowRef.document.body.removeChild(control);
                return Promise.resolve(ok);
            }
            catch {
                return Promise.resolve(false);
            }
        };
    }
    /** 初始 state：全部 `null` = 各页签走自己的空态（不是白屏）。 */
    function initialState(engagement = null) {
        return {
            engagement,
            assets: {
                snapshot: null,
                filter: assets_model_js_2.DEFAULT_ASSET_FILTER,
                searchDraft: "",
                view: "list",
                list: null,
                domains: null,
                web: null,
                detail: null,
                openId: null,
                showAllId: null,
                notesOpen: false,
                collapsed: {},
                discovery: null,
                discoveryError: null,
                discoveryDay: "",
                loading: false,
            },
            sessions: {
                data: null,
                error: null,
                busy: false,
                message: null,
                copied: null,
                collapsed: {},
                probe: null,
            },
            findings: {
                findings: null,
                credentials: [],
                accesses: [],
                fileGroups: [],
                filter: findings_tab_js_2.DEFAULT_FINDINGS_FILTER,
                subTab: "vulns",
                grouped: true,
                openId: null,
                collapse: {},
                message: null,
                busy: false,
            },
            chain: {
                data: null,
                error: null,
                loading: false,
                view: "A",
                openId: null,
            },
            scores: {
                board: null,
                error: null,
                busy: false,
                openId: null,
                form: null,
                message: null,
            },
            env: {
                draft: null,
                data: null,
                error: null,
                message: null,
                busy: false,
                folderPath: "",
            },
        };
    }
    /** 本组负责的页签（顺序即首屏取数顺序）。 */
    exports.TABS_A_OWNED = Object.freeze([
        "assets",
        "sessions",
        "findings",
        "chain",
        "scores",
        "env",
    ]);
    /** 是否是本组负责的页签。 */
    function ownsTab(tab) {
        return exports.TABS_A_OWNED.includes(tab);
    }
    /**
     * **已知的服务端形状问题，本层垫平。**
     *
     * `platformConfigGet` / `platformConfigSave` / `platformAssignToolkit` 三个
     * op 的响应把 `platformSummary` 包在 `platform` 下：
     *
     * ```json
     * { "ok": true, "platform": { "config": {...}, "runtime": {...},
     *                            "tools": {...}, "adapt": {...}, "egress": {...},
     *                            "hint": "...", "toolkitDir": "...",
     *                            "nucleiTemplatesDir": "..." } }
     * ```
     *
     * 而 `env-model.ts` 的 `draftFromResponse` / `toolsOf` / `summaryOf` /
     * `egressOf` / `savedMessage` 都按**扁平**形态读（`response.config` …）。
     * 两者差一层，不展开的后果是：草稿全空、工具全「未找到」、保存消息
     * 永远退化成 `$DSH_HOME/...` 默认路径（都是静默错，界面上看不出来）。
     *
     * ## 这是垫层，不是设计
     *
     * 服务端 `dispatch` 返回 `{ok, platform:{...}}`；本层展开成扁平
     * `{ok, config, tools, adapt}`。**若将来 `src/redteam/store/dispatch.ts`
     * 改为直接展开**（`{ok:true, ...platformSummary()}），本函数应退化为
     * 恒等并删除 —— 这两条路只走一条，别两边都做（那会变成两份真相）。
     *
     * 之所以把展开放在**接线层**而不是改 `env-model.ts`：model 的扁平假设
     * 已被 `env-tab.test.ts` 的夹具与 77 个用例钉死，且它描述的其实是
     * **正确**的契约（响应本该扁平），只是服务端没做到。
     *
     * 回归防线：`tabs-a.test.ts` 有专门用例断言「保存消息要带真实路径、
     * 不许退化成 `$DSH_HOME`」，删掉本函数会让那条用例变红。
     *
     * 记录此事的常量：`UNFILLED_PROPS` 同级的 `KNOWN_SHAPE_GAPS`。
     */
    function flattenPlatform(response) {
        if (response.ok === false)
            return response;
        const platform = response["platform"];
        if (typeof platform !== "object" || platform === null || Array.isArray(platform)) {
            return response;
        }
        const body = recordOf(platform);
        // 展开体覆盖外层，但保留 `ok`（外层为真时以它为真）。
        return { ...response, ...body, ok: response.ok };
    }
    /** 造 A 组接线器。 */
    function makeTabsA(deps) {
        const api = deps.api ?? (0, api_js_1.makeApiClient)({ fetch: requireFetch(deps) });
        const copyFn = deps.copyText ?? (() => false);
        let state = initialState(deps.engagement ?? null);
        const listeners = new Set();
        /* ── 状态读写 ─────────────────────────────────────────────────────── */
        const emit = () => {
            deps.onChange?.();
            for (const listener of Array.from(listeners)) {
                try {
                    listener();
                }
                catch {
                    /* 一个坏订阅者不该让整块界面停摆（与 runtime 的 ui store 同策略） */
                }
            }
        };
        const patch = (next) => {
            state = { ...state, ...next };
            emit();
        };
        const patchAssets = (next) => {
            patch({ assets: { ...state.assets, ...next } });
        };
        const patchSessions = (next) => {
            patch({ sessions: { ...state.sessions, ...next } });
        };
        const patchFindings = (next) => {
            patch({ findings: { ...state.findings, ...next } });
        };
        const patchChain = (next) => {
            patch({ chain: { ...state.chain, ...next } });
        };
        const patchScores = (next) => {
            patch({ scores: { ...state.scores, ...next } });
        };
        const patchEnv = (next) => {
            patch({ env: { ...state.env, ...next } });
        };
        /** 当前靶标 id（空串 = 没选）。 */
        const eng = () => state.engagement ?? "";
        /** 复制并回调结果（同步实现与 Promise 实现都支持）。 */
        const runCopy = (text, done) => {
            let result;
            try {
                result = copyFn(text);
            }
            catch {
                done(false);
                return;
            }
            if (typeof result === "boolean") {
                done(result);
                return;
            }
            void Promise.resolve(result).then(done, () => done(false));
        };
        /* ══════════════════════════════════════════════════════════ 资产测绘 */
        /**
         * 读快照（`segments` / `stats` / `tests`）与资产列表。
         *
         * 两个请求并行：快照管侧栏与结论行，列表管主表，互不阻塞。
         * **快照失败不影响列表**；只有列表也失败时错误才二选一显示 ——
         * 页签的 `error` 只从 `props.list.error` 读（没有第二个错误槽）。
         */
        const loadAssetsFn = async () => {
            const engagement = eng();
            if (engagement === "") {
                patchAssets({ list: null, snapshot: null, loading: false });
                return;
            }
            patchAssets({ loading: true });
            const filter = state.assets.filter;
            const [snapshotResponse, listResult] = await Promise.all([
                api.raw({ op: "snapshot", engagement }),
                (0, assets_model_js_2.loadAssets)(api, engagement, filter),
            ]);
            const snapshotOk = snapshotResponse.ok !== false;
            const list = listResult.ok
                ? listResult.value
                : { ...assets_model_js_3.EMPTY_ASSET_LIST, error: listResult.error };
            // 快照失败但列表成功：把快照的错误挂到列表错误槽上，否则它会静默消失
            // （侧栏全是 0，用户看不出是「没有资产」还是「快照没读回来」）。
            const withSnapshotError = snapshotOk || list.error !== null
                ? list
                : { ...list, error: snapshotResponse.error ?? "读取快照失败" };
            patchAssets({
                loading: false,
                snapshot: snapshotOk ? snapshotResponse : null,
                list: withSnapshotError,
            });
        };
        /** 按当前视图懒加载域名 / Web / 发现时间线（切到该视图才拉）。 */
        const loadAssetsView = async (view) => {
            const engagement = eng();
            if (engagement === "")
                return;
            const cidr = state.assets.filter.cidr;
            if (view === "domain") {
                const result = await (0, assets_model_js_2.loadDomains)(api, engagement, cidr);
                patchAssets({ domains: result.ok ? result.value : [] });
                return;
            }
            if (view === "web") {
                const result = await (0, assets_model_js_2.loadWebAssets)(api, engagement, cidr);
                patchAssets({ web: result.ok ? result.value : [] });
                return;
            }
            if (view === "timeline") {
                const result = await (0, assets_model_js_2.loadDiscovery)(api, engagement);
                patchAssets(result.ok
                    ? { discovery: result.value, discoveryError: null }
                    : { discovery: null, discoveryError: result.error });
            }
        };
        const assetsProps = () => {
            const s = state.assets;
            return {
                engagement: state.engagement,
                snapshot: s.snapshot,
                filter: s.filter,
                searchDraft: s.searchDraft,
                view: s.view,
                list: s.list,
                domains: s.domains,
                web: s.web,
                detail: s.detail,
                openId: s.openId,
                showAllId: s.showAllId,
                notesOpen: s.notesOpen,
                collapsed: s.collapsed,
                discovery: s.discovery,
                discoveryError: s.discoveryError,
                discoveryDay: s.discoveryDay,
                // `renderTesting` 需要 TestingTabProps（另一个页签的域）。留空 → 页签渲染
                // 自己的「当前测试页面未接线」空态，不造假内容。见文末「未填满的 props」。
                onFilterChange: (filter) => {
                    // 过滤条件变化 = 重新查询（`onSort` 改排序也走这里，会真的重查）。
                    patchAssets({ filter, openId: null });
                    void loadAssetsFn();
                },
                onSearchDraftChange: (value) => {
                    // 只改草稿，不发请求（回车/点「搜索」才生效，与页签的 q / qApplied 一致）。
                    patchAssets({ searchDraft: value });
                },
                onSearch: () => {
                    patchAssets({ filter: { ...state.assets.filter, query: state.assets.searchDraft } });
                    void loadAssetsFn();
                },
                onViewChange: (view) => {
                    patchAssets({ view });
                    void loadAssetsView(view);
                },
                onToggleRow: (id) => {
                    if (state.assets.openId === id) {
                        patchAssets({ openId: null, detail: null });
                        return;
                    }
                    patchAssets({ openId: id, detail: null });
                    const engagement = eng();
                    if (engagement === "")
                        return;
                    void (0, assets_model_js_2.loadAssetDetail)(api, engagement, id).then((result) => {
                        // 响应慢于切换时不要把上一台的详情贴到下一台下面（模型层已定此语义）。
                        if (state.assets.openId !== id)
                            return;
                        patchAssets({ detail: result.ok ? result.value : null });
                    });
                },
                onToggleShowAll: (id) => patchAssets({ showAllId: id }),
                onToggleNotes: () => patchAssets({ notesOpen: !state.assets.notesOpen }),
                onToggleSideGroup: (scope) => {
                    const key = "scope:" + scope;
                    patchAssets({ collapsed: (0, state_js_7.toggleSection)(state.assets.collapsed, key) });
                },
                onDiscoveryDayChange: (day) => patchAssets({ discoveryDay: day }),
                onDomainAssetClick: (ip) => {
                    // 点域名下的一台资产 → 回列表并搜索该 IP（与原始交互一致）。
                    patchAssets({
                        view: "list",
                        searchDraft: ip,
                        filter: { ...state.assets.filter, query: ip },
                    });
                    void loadAssetsFn();
                },
                onRefresh: () => {
                    void loadAssetsFn();
                    void loadAssetsView(state.assets.view);
                },
                onCopy: (text) => {
                    runCopy(text, () => undefined);
                },
            };
        };
        /* ══════════════════════════════════════════════════════════ 会话隧道 */
        /**
         * `op: sessions` 一次给出 WebShell、隧道与一屏计数
         * （`store.sessionSummary` 已经把三张表并好了），
         * 所以**不再单独调** `webshells` / `tunnels` —— 两个来源会打架。
         */
        const loadSessionsFn = async () => {
            const engagement = eng();
            if (engagement === "") {
                patchSessions({ data: null, error: null, busy: false });
                return;
            }
            patchSessions({ busy: true });
            const result = await (0, session_model_js_2.loadSessions)(api, engagement);
            patchSessions({
                busy: false,
                data: result.ok ? result.value : null,
                error: result.ok ? null : result.error,
            });
        };
        const sessionsProps = () => {
            const s = state.sessions;
            return {
                engagement: state.engagement,
                data: s.data,
                error: s.error,
                busy: s.busy,
                message: s.message,
                copied: s.copied,
                collapsed: s.collapsed,
                onRefresh: () => {
                    patchSessions({ message: null, copied: null });
                    void loadSessionsFn();
                },
                onProbe: () => {
                    const engagement = eng();
                    if (engagement === "")
                        return;
                    patchSessions({ busy: true, message: null });
                    void (0, session_model_js_2.probeSessions)(api, engagement).then((result) => {
                        patchSessions(result.ok
                            ? {
                                probe: result.value,
                                // `ProbeSummary.message` 已经是现成的摘要文案
                                //（"检测完成：WebShell 在线 2/3，隧道可用 1/2"）。
                                message: { ok: result.value.message },
                            }
                            : { message: { err: result.error } });
                        // 探测会回写 status / last_check，所以必须重读一遍。
                        void loadSessionsFn();
                    });
                },
                onToggleSection: (key) => {
                    patchSessions({ collapsed: (0, state_js_7.toggleSection)(state.sessions.collapsed, key) });
                },
                onMarkShell: (shell, status) => {
                    const engagement = eng();
                    if (engagement === "")
                        return;
                    void (0, session_model_js_2.markShell)(api, engagement, shell.id, status).then((result) => {
                        patchSessions({ message: result.ok ? { ok: "已标记该 WebShell" } : { err: result.error } });
                        void loadSessionsFn();
                    });
                },
                onMarkTunnel: (tunnel, status) => {
                    const engagement = eng();
                    if (engagement === "")
                        return;
                    void (0, session_model_js_2.markTunnel)(api, engagement, tunnel.id, status).then((result) => {
                        patchSessions({ message: result.ok ? { ok: "已标记该隧道" } : { err: result.error } });
                        void loadSessionsFn();
                    });
                },
                onCopy: (key, text, label) => {
                    runCopy(text, (ok) => {
                        patchSessions({
                            // 复制失败时**不点亮**按钮（原实现记过的 bug：失败也显示「已复制」）。
                            copied: ok ? key : null,
                            message: { ...(ok ? { ok: (0, session_model_js_2.copyMessage)(true, label) } : { err: (0, session_model_js_2.copyMessage)(false, label) }) },
                        });
                        if (!ok)
                            return;
                        // 自己在 COPIED_RESET_MS 后撤销高亮；不依赖宿主定时器一定可用。
                        schedule(() => {
                            if (state.sessions.copied === key)
                                patchSessions({ copied: null });
                        }, session_model_js_2.COPIED_RESET_MS);
                    });
                },
            };
        };
        /* ══════════════════════════════════════════════════════════ 漏洞战果 */
        /**
         * 漏洞列表与三张附属表并行读。
         *
         * `op: vulns` 的响应里**已经带** `stats`（`dispatch` 里
         * `{ ok:true, stats: store.vulnStats(id), ...store.listVulns(...) }`），
         * 所以不再单独调 `vulnStats` —— 同一份数字取两次没有意义。
         */
        const loadFindingsFn = async () => {
            const engagement = eng();
            if (engagement === "") {
                patchFindings({ findings: null, busy: false });
                return;
            }
            patchFindings({ busy: true });
            const [vulnResponse, side] = await Promise.all([
                (0, findings_tab_js_2.loadFindings)(api, engagement, state.findings.filter),
                (0, findings_tab_js_2.loadSideLists)(api, engagement),
            ]);
            // `findingsOf` 把 `{ok:false}` 收成带 error 的列表（页签据此渲染错误态）。
            patchFindings({
                busy: false,
                findings: (0, findings_model_js_2.findingsOf)(vulnResponse),
                credentials: side.credentials,
                accesses: side.accesses,
                fileGroups: side.fileGroups,
            });
        };
        const findingsProps = () => {
            const s = state.findings;
            return {
                findings: s.findings ?? (s.busy ? { ...findings_model_js_2.EMPTY_FINDINGS, loading: true } : null),
                credentials: s.credentials,
                accesses: s.accesses,
                fileGroups: s.fileGroups,
                filter: s.filter,
                subTab: s.subTab,
                grouped: s.grouped,
                openId: s.openId,
                collapse: s.collapse,
                message: s.message,
                // `attackFilesNode` 由容器注入（攻击文件是另一个页签的 props）。
                // 这里不给 → findings 页签渲染自己的兜底文案。
                onFilterChange: (filter) => {
                    const needsQuery = filter.severity !== s.filter.severity
                        || filter.status !== s.filter.status;
                    patchFindings({ filter });
                    // 严重级/状态走服务端过滤 → 必须重查；搜索词改动还没提交，不查。
                    if (needsQuery)
                        void loadFindingsFn();
                },
                onSubmitQuery: () => {
                    patchFindings({ filter: { ...s.filter, queryApplied: s.filter.query } });
                    void loadFindingsFn();
                },
                onSubTabChange: (subTab) => patchFindings({ subTab }),
                onToggleGrouped: () => patchFindings({ grouped: !s.grouped }),
                onToggleOpen: (id) => patchFindings({ openId: s.openId === id ? null : id }),
                onCollapseChange: (collapse) => patchFindings({ collapse }),
                onSetAllCollapsed: (keys, open) => {
                    patchFindings({ collapse: (0, state_js_7.setSections)(s.collapse, keys, open) });
                },
                onUpdateStatus: (id, status) => {
                    const engagement = eng();
                    if (engagement === "")
                        return;
                    void (0, findings_tab_js_2.updateVulnStatus)(api, engagement, id, status).then((result) => {
                        patchFindings({ message: result.message });
                        if (result.ok)
                            void loadFindingsFn();
                    });
                },
                onCopy: (text, label) => {
                    runCopy(text, (ok) => {
                        patchFindings({
                            message: ok ? { kind: "ok", text: (0, session_model_js_2.copyMessage)(true, label) } : { kind: "err", text: (0, session_model_js_2.copyMessage)(false, label) },
                        });
                    });
                },
            };
        };
        /* ══════════════════════════════════════════════════════════ 攻击链 */
        /**
         * `op: scoreChain` 是攻击链页的**唯一**数据源（`chainDataOf` 读它的
         * `stages` / `summary`）。`op: attackGraph` 返回的是资产拓扑图，
         * `ChainTabProps` 里没有它的槽位，所以本页不发这个请求。
         */
        const loadChainFn = async () => {
            const engagement = eng();
            if (engagement === "") {
                patchChain({ data: null, error: null, loading: false });
                return;
            }
            patchChain({ loading: true });
            const response = await (0, chain_tab_js_2.loadChain)(api, engagement);
            patchChain({
                loading: false,
                error: (0, chain_tab_js_2.chainErrorOf)(response),
                data: (0, chain_model_js_2.chainDataOf)(response),
            });
        };
        const chainProps = () => ({
            data: state.chain.data,
            error: state.chain.error,
            loading: state.chain.loading,
            view: state.chain.view,
            openId: state.chain.openId,
            onViewChange: (view) => patchChain({ view: (0, chain_tab_js_2.nextView)(view) }),
            onToggleHit: (id) => patchChain({ openId: (0, chain_tab_js_2.toggleHitOpen)(state.chain.openId, id) }),
            onRefresh: () => {
                void loadChainFn();
            },
        });
        /* ══════════════════════════════════════════════════════════ 得分目标 */
        const loadScoresFn = async () => {
            const engagement = eng();
            if (engagement === "") {
                patchScores({ board: null, error: null, busy: false });
                return;
            }
            patchScores({ busy: true });
            const result = await (0, score_model_js_2.loadScores)(api, engagement);
            patchScores({
                busy: false,
                board: result.ok ? result.value : null,
                error: result.ok ? null : result.error,
            });
        };
        const scoresProps = () => {
            const s = state.scores;
            return {
                engagement: state.engagement,
                board: s.board,
                error: s.error,
                busy: s.busy,
                openId: s.openId,
                form: s.form,
                message: s.message,
                onRefresh: () => {
                    patchScores({ message: null });
                    void loadScoresFn();
                },
                onToggle: (id) => patchScores({ openId: s.openId === id ? null : id }),
                onEdit: (point) => {
                    patchScores({ form: (0, score_model_js_2.editFormOf)(point), openId: point.id, message: null });
                },
                onNew: () => patchScores({ form: (0, score_model_js_2.newScoreForm)(), openId: null, message: null }),
                onFormChange: (form) => patchScores({ form }),
                onSave: () => {
                    const engagement = eng();
                    const form = s.form;
                    if (engagement === "" || form === null)
                        return;
                    void (0, score_model_js_2.saveScorePoint)(api, engagement, form).then((outcome) => {
                        patchScores({
                            message: outcome.message,
                            ...(outcome.closeForm ? { form: null } : {}),
                        });
                        if (outcome.reload)
                            void loadScoresFn();
                    });
                },
                onRemove: () => {
                    const engagement = eng();
                    const form = s.form;
                    if (engagement === "")
                        return;
                    // 新增表单（没有 id）不需要发请求，直接关掉。
                    if ((0, score_model_js_2.shouldSkipDelete)(form)) {
                        patchScores({ form: null });
                        return;
                    }
                    if (form === null || form.id === null)
                        return;
                    void (0, score_model_js_2.removeScorePoint)(api, engagement, form.id).then((outcome) => {
                        patchScores({
                            message: outcome.message,
                            ...(outcome.closeForm ? { form: null } : {}),
                            ...(outcome.closeDetail ? { openId: null } : {}),
                        });
                        if (outcome.reload)
                            void loadScoresFn();
                    });
                },
                onCancel: () => patchScores({ form: null, message: null }),
                onCopy: (text) => {
                    runCopy(text, () => undefined);
                },
            };
        };
        /* ══════════════════════════════════════════════════════════ 环境适配 */
        /**
         * 环境适配的取数走两个 op：
         *
         * - `platformConfigGet`（store 侧）→ **props.data 的全部来源**：
         *   `config` / `runtime` / `tools` / `adapt` / `egress` / `hint` /
         *   `toolkitDir` / `nucleiTemplatesDir`。响应外面包了一层 `platform`，
         *   用 `flattenPlatform` 展开。
         * - `platformEnvAdaptStatus`（网关侧）→ 只有 `ready` / `reason` / `kali` /
         *   `message` / `found` / `missing`。`EnvTabProps` 没有它的专属槽位，
         *   所以只在 `config` 响应缺 `adapt` 时补进 `data.adapt`（老宿主兜底）。
         */
        const loadEnvFn = async () => {
            patchEnv({ busy: true, error: null });
            const configResponse = await api.raw({ op: "platformConfigGet" });
            if (configResponse.ok === false) {
                patchEnv({ busy: false, error: configResponse.error ?? "读取失败" });
                return;
            }
            const flat = flattenPlatform(configResponse);
            const hasAdapt = typeof flat["adapt"] === "object" && flat["adapt"] !== null;
            if (hasAdapt) {
                patchEnv({ busy: false, data: flat, draft: (0, env_model_js_2.draftFromResponse)(flat), error: null });
                return;
            }
            const statusResponse = await api.raw({ op: "platformEnvAdaptStatus" });
            const adapt = statusResponse.ok === false
                ? undefined
                : {
                    ready: statusResponse["ready"] === true,
                    reason: textOf(statusResponse["reason"]),
                    kali: statusResponse["kali"] === true,
                    message: textOf(statusResponse["message"]),
                };
            const merged = adapt === undefined ? flat : { ...flat, adapt };
            patchEnv({ busy: false, data: merged, draft: (0, env_model_js_2.draftFromResponse)(merged), error: null });
        };
        const envProps = () => {
            const s = state.env;
            return {
                draft: s.draft,
                data: s.data,
                error: s.error,
                message: s.message,
                busy: s.busy,
                folderPath: s.folderPath,
                onRefresh: () => {
                    void loadEnvFn();
                },
                onSave: () => {
                    const draft = s.draft;
                    // 没加载出草稿就不能保存（否则会写入一份空配置覆盖原有配置）。
                    if (draft === null)
                        return;
                    patchEnv({ busy: true, message: null });
                    void (0, env_tab_js_2.saveEnv)(api, draft).then((result) => {
                        if (!result.ok || result.response === null) {
                            patchEnv({ busy: false, message: { kind: "err", text: "保存失败" } });
                            return;
                        }
                        // **先展开再读**：`platformConfigSave` 的响应同样包一层 `platform`，
                        // 直接读 `response.config.path` 永远读不到（路径会退化成默认文案）。
                        const flat = flattenPlatform(result.response);
                        const refreshed = (0, env_tab_js_2.refreshDraftFrom)(flat);
                        patchEnv({
                            busy: false,
                            ...(refreshed !== null ? { draft: refreshed } : {}),
                            data: flat,
                            message: { kind: "ok", text: (0, env_model_js_2.savedMessage)(flat) },
                        });
                    });
                },
                onAssign: () => {
                    const draft = s.draft;
                    patchEnv({ busy: true, message: null });
                    void (0, env_tab_js_2.assignEnv)(api, s.folderPath, draft).then((result) => {
                        if (!result.ok || result.response === null) {
                            patchEnv({ busy: false, message: { kind: "err", text: result.error ?? "自动分配失败" } });
                            return;
                        }
                        const flat = flattenPlatform(result.response);
                        const refreshed = (0, env_tab_js_2.refreshDraftFrom)(flat);
                        patchEnv({
                            busy: false,
                            ...(refreshed !== null ? { draft: refreshed } : {}),
                            data: flat,
                            message: { kind: "ok", text: (0, env_model_js_2.assignedMessage)(flat) },
                        });
                    });
                },
                onFolderPathChange: (value) => patchEnv({ folderPath: value }),
                onDraftChange: (next) => patchEnv({ draft: next }),
            };
        };
        /* ══════════════════════════════════════════════════════════ 分发 */
        const load = async (tab) => {
            switch (tab) {
                case "assets":
                    await loadAssetsFn();
                    return;
                case "sessions":
                    await loadSessionsFn();
                    return;
                case "findings":
                    await loadFindingsFn();
                    return;
                case "chain":
                    await loadChainFn();
                    return;
                case "scores":
                    await loadScoresFn();
                    return;
                case "env":
                    await loadEnvFn();
                    return;
                default:
                    // 不属于本组的页签：不做任何事（由 B 组或容器负责）。
                    return;
            }
        };
        const propsFor = (tab) => {
            switch (tab) {
                case "assets":
                    return { assets: assetsProps() };
                case "sessions":
                    return { sessions: sessionsProps() };
                case "findings":
                    return { findings: findingsProps() };
                case "chain":
                    return { chain: chainProps() };
                case "scores":
                    return { scores: scoresProps() };
                case "env":
                    return { env: envProps() };
                default:
                    return {};
            }
        };
        const allProps = () => ({
            assets: assetsProps(),
            sessions: sessionsProps(),
            findings: findingsProps(),
            chain: chainProps(),
            scores: scoresProps(),
            env: envProps(),
        });
        return {
            state: () => state,
            subscribe: (listener) => {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            setEngagement: (engagement) => {
                // 换靶标必须清掉旧数据：否则上一家的资产会短暂出现在新靶标下。
                const fresh = initialState(engagement);
                state = fresh;
                emit();
            },
            assetsProps,
            sessionsProps,
            findingsProps,
            chainProps,
            scoresProps,
            envProps,
            propsFor,
            allProps,
            load,
            loadAll: async () => {
                await Promise.all([
                    loadAssetsFn(),
                    loadSessionsFn(),
                    loadFindingsFn(),
                    loadChainFn(),
                    loadScoresFn(),
                    loadEnvFn(),
                ]);
            },
            loadAssets: loadAssetsFn,
            loadSessions: loadSessionsFn,
            loadFindings: loadFindingsFn,
            loadChain: loadChainFn,
            loadScores: loadScoresFn,
            loadEnv: loadEnvFn,
        };
    }
    /* ══════════════════════════════════════════════════════════════ 内部工具 */
    /** 取 `fetch`（缺失是**编程错误**，按项目惯例抛而不是静默降级）。 */
    function requireFetch(deps) {
        if (deps.fetch !== undefined)
            return deps.fetch;
        throw new Error("makeTabsA 需要 deps.fetch 或 deps.api 之一");
    }
    /**
     * 尽力调度一个延时回调。
     *
     * ## 为什么不能直接写 `setTimeout(fn, ms)`
     *
     * 浏览器产物由 `scripts/build-client.mjs` 编译，它的 tsconfig 是
     * `lib: ["ES2020"]` + `types: []` —— **既没有 DOM 也没有 Node 全局**。
     * 直接引用 `setTimeout` 标识符会让产物构建报 `TS2304: Cannot find name`，
     * 而 `test/ui/artifact.test.js` 恰恰会真跑一次构建，于是整个「产物可复现」
     * 套件挂掉（这个坑我踩过一次，这是修法）。
     *
     * 所以这里从 `globalThis` 上**按名字取**，取不到就静默跳过 ——
     * 复制高亮不复位，远好过让整块界面抛错。
     */
    function schedule(fn, ms) {
        const candidate = globalThis["setTimeout"];
        if (typeof candidate !== "function")
            return;
        const timer = candidate;
        timer(fn, ms);
    }
    /** 组合：asset 详情请求的 op（供外部诊断/测试断言用）。 */
    function assetDetailRequest(engagement, id) {
        return (0, assets_model_js_2.assetRequest)(engagement, id);
    }
    /** 组合：域名请求（同上）。 */
    function domainsRequestOf(engagement, cidr) {
        return (0, assets_model_js_2.domainsRequest)(engagement, cidr);
    }
    /** 组合：Web 请求（同上）。 */
    function webRequestOf(engagement, cidr) {
        return (0, assets_model_js_2.webRequest)(engagement, cidr);
    }
    /** 组合：发现时间线请求（同上）。 */
    function discoveryRequestOf(engagement) {
        return (0, assets_model_js_2.discoveryRequest)(engagement);
    }
    /** 结论键点击的纯函数（页签内部也用，这里导出便于容器复用）。 */
    function conclusionFilter(filter, key) {
        return (0, assets_model_js_2.applyConclusion)(filter, key);
    }
    /**
     * 六个页签里**需要宿主或其它页签能力**、因而留空的 props。
     *
     * 留空比塞假数据好：页签各自有对应的空态文案，用户能看出「没接线」
     * 而不是「没有数据」。
     */
    exports.UNFILLED_PROPS = Object.freeze([
        {
            tab: "assets",
            prop: "renderTesting",
            reason: "需要 TestingTabProps（测试页签属于另一组）；留空 → 渲染「当前测试页面未接线」",
        },
        {
            tab: "findings",
            prop: "attackFilesNode",
            reason: "由容器注入攻击文件页签的渲染节点（不是 props 值）；无注入 → 页签走自己的兜底文案",
        },
    ]);
    /** 已知形状缺口清单。 */
    exports.KNOWN_SHAPE_GAPS = Object.freeze([
        {
            ops: ["platformConfigGet", "platformConfigSave", "platformAssignToolkit"],
            gap: "返回 {ok, platform:{config,tools,adapt,egress,...}}，比消费方期望的扁平形状多包一层",
            mitigation: "`flattenPlatform()` 在接线层展开（不改 model：model 的扁平假设是正确契约）",
            whenFixed: "dispatch 侧改为 {ok, ...platformSummary()} 后，flattenPlatform 退化为恒等并删除",
        },
    ]);
    /** 供断言用：被页签消费、但本组**有意不发**的 op 及原因。 */
    exports.UNUSED_OPS = Object.freeze([
        { op: "tunnels", reason: "sessions 已并好隧道表（sessionSummary），两个来源会打架" },
        { op: "webshells", reason: "同上：sessions 已并好 WebShell 表" },
        { op: "vulnStats", reason: "vulns 响应里已带 stats（dispatch 合并了 vulnStats）" },
        { op: "attackGraph", reason: "ChainTabProps 没有拓扑图槽位（消费方是 report/graph 视图）" },
        { op: "scoreChain", reason: "ScoreBoard 来自 scores op；scoreChain 是攻击链页的数据源" },
        { op: "access", reason: "findings 的附属表已由 loadSideLists 覆盖（已用）" },
    ]);
});
/**
 * 控制台「B 组页签」的真实取数与 props 构造。
 *
 * 负责 6 个页签：`knowledge` / `skills` / `testing` / `attackfiles` /
 * `prompts` / `report`。
 *
 * `agents` **不在**这里（也不是本文件能补的）：`tab-registry.ts` 的
 * `TabRegistryProps` 没有 `agents` 字段，分派分支无条件返回空态，
 * `client/` 下也没有对应的页签渲染器。详见文件末尾
 * `AGENTS_NOT_WIRED_REASON`。
 *
 * ## 为什么这一层长这样
 *
 * `client/` 里的 6 个页签都是**纯函数**：props 进、元素出、不留状态。它们各自
 * 还导出了模型层解析函数（`knowledgeDataOf` / `catalogLoadOf` / `activeTestsOf` /
 * `fileFoldersOf` / `promptLoadOf` / `reportDataOf`）把不可信响应解析成结构化数据。
 * 也就是说「怎么解析」已经写好了，缺的只是**谁去调 `api.raw`、把结果放哪、
 * 回调怎么接回去**。
 *
 * 这一层就是那个「谁」：
 *
 * ```
 *  api.raw({op}) ──► 模型层解析函数 ──► TabsBState（纯容器，可在 node:test 里跑）
 *                                            │
 *                                   propsForWithEngagement()
 *                                            │
 *                                            ▼
 *                                   TabRegistryProps → renderXxxTab
 * ```
 *
 * 状态刻意**不进 React**：`TabsBState` 是普通闭包容器（`get` / `subscribe` /
 * `refreshXxx`），于是 6 个页签的取数路径可以用假 `ApiClient` 直接跑完，不需要
 * React 运行时，也不需要「渲染一次看它有没有发请求」这种间接断言。React 只出现在
 * `makeTabsBSlot`（约 30 行胶水），它把容器变更转成一次 `setState`。
 *
 * ## 不伪造数据
 *
 * 任何 op 失败只写进该页签自己的 `error`；拿不到的字段就**不传**
 * （`TabRegistryProps` 每项可缺失，缺的那项页签走自己的空态）。这里不存在
 * 「先塞个空对象让类型检查过」的中间态 —— 那会让人以为「读到了但没有数据」，
 * 而实际是「压根没读成功」。
 *
 * ## 构建产物约束
 *
 * 本文件会被打进浏览器产物 `client.js`，所以：
 * - 只 import `../client/*.js`；**不 import `node:*`**，也**不 import
 *   `../store/**`**（服务端代码含 `node:sqlite`，前端只能经 HTTP 走 `api.raw`）。
 * - **模块顶层没有不可复现的东西**：`new Date()` 收在 `nowIso()` / `nowDate()`
 *   函数体内，构建产物因此字节可复现（两次构建 sha256 相同）。
 */
define("redteam/ui/tabs-b", ["require", "exports", "redteam/client/state", "redteam/client/helpers", "redteam/client/knowledge-model", "redteam/client/knowledge-tab", "redteam/client/skills-model", "redteam/client/skills-tab", "redteam/client/testing-model", "redteam/client/attackfiles-model", "redteam/client/attackfiles-tab", "redteam/client/prompts-model", "redteam/client/prompts-tab", "redteam/client/report-model", "redteam/client/report-tab"], function (require, exports, state_js_8, helpers_js_15, knowledge_model_js_3, knowledge_tab_js_2, skills_model_js_2, skills_tab_js_2, testing_model_js_2, attackfiles_model_js_2, attackfiles_tab_js_2, prompts_model_js_2, prompts_tab_js_2, report_model_js_2, report_tab_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.reportDataOf = exports.TABS_B_OPS = exports.TABS_B_WIRED = exports.AGENTS_NOT_WIRED_REASON = exports.REPORT_NEED_ENGAGEMENT = void 0;
    exports.emptySnapshot = emptySnapshot;
    exports.shotImageOf = shotImageOf;
    exports.makeTabsBState = makeTabsBState;
    exports.renderShotStrip = renderShotStrip;
    exports.propsForWithEngagement = propsForWithEngagement;
    exports.propsFor = propsFor;
    exports.loadAll = loadAll;
    exports.makeTabsBSlot = makeTabsBSlot;
    exports.tabBOwnsOp = tabBOwnsOp;
    Object.defineProperty(exports, "reportDataOf", { enumerable: true, get: function () { return report_model_js_2.reportDataOf; } });
    /* ══════════════════════════════════════════════════════════════ 常量 */
    /** 读取失败的兜底文案（各 tab 自己的 `*_FALLBACK` 也是这个串）。 */
    const LOAD_FAILED = "读取失败";
    /** 详情读取失败的兜底文案。 */
    const DETAIL_FAILED = "读取失败";
    /** 无靶标时报告页的提示（与 `testing` 页的 `NO_ENGAGEMENT_TEXT` 同口径）。 */
    exports.REPORT_NEED_ENGAGEMENT = "请先在顶部选择或创建靶标，再生成报告。";
    /** 空三元组。 */
    function idle() {
        return { data: null, error: null, busy: false };
    }
    /** 造一个空快照（测试与初始状态共用）。 */
    function emptySnapshot() {
        return {
            knowledge: {
                ...idle(),
                query: knowledge_model_js_3.EMPTY_QUERY,
                openId: null,
                detail: null,
                detailBusy: false,
                message: null,
                grouped: false,
            },
            skills: { ...idle(), filter: skills_model_js_2.DEFAULT_SKILL_FILTER, activeKey: null, detail: null, detailBusy: false },
            testing: { ...idle(), updatedAt: null, auto: false, collapsed: {}, openNotes: [] },
            attackfiles: { ...idle(), detail: null, collapse: {} },
            prompts: { ...idle(), active: null, draft: "", message: null },
            report: { ...idle(), message: null, collapse: {} },
            shots: new Map(),
        };
    }
    /* ══════════════════════════════════════════════════════════════ 小工具 */
    /** 从失败响应里取错误文案。 */
    function responseError(response, fallback) {
        if (response.ok !== false)
            return null;
        return typeof response.error === "string" && response.error !== "" ? response.error : fallback;
    }
    /** 从异常里取可读文案。 */
    function messageOf(cause) {
        return cause instanceof Error ? cause.message : String(cause);
    }
    /**
     * 从 `shotData` 响应里取图片 data URL。
     *
     * 不可信输入逐项窄化：`base64` 必须是字符串、`mime` 缺失时按 `image/png`
     * （`shotDataUrl` 已经做了这两件事，拿不到就返回空串 → 这里再收成 `null`）。
     */
    function shotImageOf(response) {
        if (response.ok === false)
            return null;
        const url = (0, helpers_js_15.shotDataUrl)(response["base64"], response["mime"]);
        return url === "" ? null : url;
    }
    /* ══════════════════════════════════════════════════════════════ 容器实现 */
    /**
     * 造状态容器。
     *
     * 所有取数方法都**不抛**：失败写进 `error`，由页签自己的错误态呈现。
     * 这与 `api.ts` 的「永不 reject」契约配套 —— 两边都抛会让容器里到处是 try。
     */
    function makeTabsBState(deps) {
        const { api } = deps;
        let snapshot = emptySnapshot();
        const listeners = new Set();
        /** 截图取数在途集合：同一 id 不发第二次。 */
        const shotPending = new Set();
        /** 当前测试页的在途守卫。 */
        const guard = (0, testing_model_js_2.createPollGuard)();
        /** 轮询定时器句柄（`undefined` = 没开）。 */
        let pollHandle = undefined;
        /** 已加载时使用的靶标 id：变了就清旧数据。 */
        let loadedEngagement = null;
        const notify = () => {
            for (const listener of Array.from(listeners)) {
                try {
                    listener();
                }
                catch {
                    /* 一个坏订阅者不该让整个面板停摆（与 runtime.ts 的 store 同策略） */
                }
            }
        };
        const commit = (patch) => {
            snapshot = { ...snapshot, ...patch };
            deps.notify?.();
            notify();
        };
        /** 当前时间（ISO）。 */
        const nowIso = () => deps.nowIso?.() ?? new Date().toISOString();
        /** 当前时刻。 */
        const nowDate = () => deps.nowDate?.() ?? new Date();
        /** 读靶标 id（空串归一成 `null`）。 */
        const engagementOf = () => {
            const id = deps.engagement();
            return id === null || id === "" ? null : id;
        };
        /** 复制一段文本，返回结果消息。 */
        async function copyText(text, label) {
            if (deps.copy === undefined) {
                return { ok: false, text: "宿主未提供剪贴板能力，请手动选中复制" };
            }
            try {
                const ok = await deps.copy(text, label);
                return ok ? { ok: true, text: (0, report_model_js_2.copiedMessage)(label) } : { ok: false, text: report_model_js_2.COPY_FAILED_MESSAGE };
            }
            catch (cause) {
                return { ok: false, text: "复制失败：" + messageOf(cause) };
            }
        }
        /* ────────────────────────────────────────── 知识库（全局，不依赖靶标） */
        async function refreshKnowledge() {
            commit({ knowledge: { ...snapshot.knowledge, busy: true, error: null } });
            let response;
            try {
                response = await (0, knowledge_tab_js_2.searchPoc)(api, snapshot.knowledge.query);
            }
            catch (cause) {
                commit({ knowledge: { ...snapshot.knowledge, busy: false, error: messageOf(cause) } });
                return;
            }
            const error = (0, knowledge_tab_js_2.failureText)(response);
            if (error !== null) {
                // 失败时**保留上一次的数据**：网络抖一下不该把用户正在看的列表清空。
                commit({ knowledge: { ...snapshot.knowledge, busy: false, error } });
                return;
            }
            commit({
                knowledge: { ...snapshot.knowledge, busy: false, error: null, data: (0, knowledge_model_js_3.knowledgeDataOf)(response) },
            });
        }
        async function openPoc(id) {
            const current = snapshot.knowledge;
            // 点同一条 = 收起（与 `detailFor` 的派生语义配套）。
            if (current.openId === id) {
                commit({ knowledge: { ...current, openId: null, detail: null, detailBusy: false } });
                return;
            }
            commit({ knowledge: { ...current, openId: id, detail: null, detailBusy: true } });
            let response;
            try {
                response = await (0, knowledge_tab_js_2.loadPocDetail)(api, id);
            }
            catch (cause) {
                commit({
                    knowledge: {
                        ...snapshot.knowledge,
                        detailBusy: false,
                        message: { kind: "err", text: messageOf(cause) },
                    },
                });
                return;
            }
            const error = (0, knowledge_tab_js_2.detailFailureText)(response);
            if (error !== null) {
                // 详情读失败：给消息，但不把整页变成错误态（列表还是可用的）。
                commit({
                    knowledge: { ...snapshot.knowledge, detailBusy: false, detail: null, message: { kind: "err", text: error } },
                });
                return;
            }
            commit({ knowledge: { ...snapshot.knowledge, detailBusy: false, detail: (0, knowledge_model_js_3.pocDetailOf)(response) } });
        }
        /* ────────────────────────────────────────── 技能库 */
        async function refreshSkills(force) {
            commit({ skills: { ...snapshot.skills, busy: true, error: null } });
            let load;
            try {
                load = await (0, skills_tab_js_2.loadSkillCatalog)(api, force);
            }
            catch (cause) {
                const message = messageOf(cause);
                commit({
                    skills: {
                        ...snapshot.skills,
                        busy: false,
                        error: message,
                        // 仍然给出结构化的失败结果：页签同时显示错误与「读到了但没有技能」两态。
                        data: { ok: false, items: [], meta: null, error: message, restartHint: false },
                    },
                });
                return;
            }
            // `catalogLoadOf` 把失败也收成结构（`ok:false` + `error` + `restartHint`），
            // 页签据此同时显示错误与「宿主版本不含该 op」的行动建议。
            commit({
                skills: { ...snapshot.skills, busy: false, error: load.ok ? null : load.error, data: load },
            });
        }
        async function toggleSkill(item) {
            const nextKey = (0, skills_model_js_2.toggleActive)(snapshot.skills.activeKey, item);
            if (nextKey === null) {
                commit({ skills: { ...snapshot.skills, activeKey: null, detail: null, detailBusy: false } });
                return;
            }
            commit({ skills: { ...snapshot.skills, activeKey: nextKey, detail: null, detailBusy: true } });
            let result;
            try {
                result = await (0, skills_tab_js_2.loadSkillDetail)(api, item);
            }
            catch (cause) {
                result = { detail: null, error: messageOf(cause) };
            }
            if (result.error !== null) {
                commit({ skills: { ...snapshot.skills, detailBusy: false, detail: null, error: result.error } });
                return;
            }
            commit({ skills: { ...snapshot.skills, detailBusy: false, detail: result.detail } });
        }
        /* ────────────────────────────────────────── 当前测试 */
        function stopPolling() {
            if (pollHandle !== undefined && deps.clearInterval !== undefined) {
                deps.clearInterval(pollHandle);
            }
            pollHandle = undefined;
        }
        function startPolling() {
            if (pollHandle !== undefined)
                return;
            // 宿主没给定时器：不轮询（不假装在实时刷新）。
            if (deps.setInterval === undefined)
                return;
            pollHandle = deps.setInterval(() => {
                void refreshTesting();
            }, 5000);
        }
        async function refreshTesting() {
            const engagement = engagementOf();
            if (engagement === null) {
                // 没靶标：不发请求；`data` 留 `null`，页签显示「请先选择靶标」。
                commit({ testing: { ...snapshot.testing, busy: false, error: null, data: null, updatedAt: null } });
                return;
            }
            if (loadedEngagement !== engagement) {
                // 切靶标：旧请求作废、旧数据清掉（否则会短暂显示上一个靶标的资产）。
                guard.invalidate();
                loadedEngagement = engagement;
                commit({ testing: { ...snapshot.testing, data: null, error: null, collapsed: {}, openNotes: [] } });
            }
            const token = guard.begin();
            // 在途：本轮跳过（不排队、不并发 —— `createPollGuard` 的语义）。
            if (token === null)
                return;
            commit({ testing: { ...snapshot.testing, busy: true } });
            let response;
            try {
                response = await api.raw({ op: "activeTests", engagement, limit: testing_model_js_2.ACTIVE_TESTS_LIMIT });
            }
            catch (cause) {
                guard.finish(token);
                commit({ testing: { ...snapshot.testing, busy: false, error: messageOf(cause) } });
                return;
            }
            const stillCurrent = guard.isCurrent(token);
            guard.finish(token);
            // 切靶标后回来的旧响应由 `isCurrent` 拦掉：它属于上一个靶标。
            if (!stillCurrent)
                return;
            const error = responseError(response, LOAD_FAILED);
            if (error !== null) {
                commit({ testing: { ...snapshot.testing, busy: false, error } });
                return;
            }
            commit({
                testing: {
                    ...snapshot.testing,
                    busy: false,
                    error: null,
                    data: (0, testing_model_js_2.activeTestsOf)(response),
                    updatedAt: nowDate(),
                },
            });
        }
        /* ────────────────────────────────────────── 攻击文件 */
        async function refreshAttackFiles() {
            const engagement = engagementOf();
            if (engagement === null) {
                // 没靶标 = 没有攻击文件（不是错误）。空数组让页签显示自己的空态。
                commit({ attackfiles: { ...snapshot.attackfiles, busy: false, error: null, data: [] } });
                return;
            }
            commit({ attackfiles: { ...snapshot.attackfiles, busy: true, error: null } });
            let response;
            try {
                response = await (0, attackfiles_tab_js_2.loadAttackFiles)(api, engagement);
            }
            catch (cause) {
                commit({ attackfiles: { ...snapshot.attackfiles, busy: false, error: messageOf(cause) } });
                return;
            }
            const error = responseError(response, LOAD_FAILED);
            if (error !== null) {
                commit({ attackfiles: { ...snapshot.attackfiles, busy: false, error } });
                return;
            }
            commit({
                attackfiles: {
                    ...snapshot.attackfiles,
                    busy: false,
                    error: null,
                    data: (0, attackfiles_model_js_2.fileFoldersOf)(response),
                    // 刷新后原来展开的文件可能已不在：detail 一并清掉，避免显示幽灵行。
                    detail: null,
                },
            });
        }
        async function openAttackFile(file) {
            const engagement = engagementOf();
            const current = snapshot.attackfiles;
            const nextId = (0, attackfiles_model_js_2.nextDetailId)(current.detail === null ? null : current.detail.id, file.id);
            if (engagement === null || nextId === null) {
                commit({ attackfiles: { ...current, detail: null } });
                return;
            }
            let response;
            try {
                response = await (0, attackfiles_tab_js_2.loadAttackFile)(api, engagement, nextId);
            }
            catch (cause) {
                commit({ attackfiles: { ...snapshot.attackfiles, error: messageOf(cause) } });
                return;
            }
            const error = responseError(response, DETAIL_FAILED);
            if (error !== null) {
                commit({ attackfiles: { ...snapshot.attackfiles, detail: null, error } });
                return;
            }
            commit({ attackfiles: { ...snapshot.attackfiles, detail: (0, attackfiles_model_js_2.fileDetailOf)(response), error: null } });
        }
        /* ────────────────────────────────────────── 提示词 */
        async function refreshPrompts() {
            const engagement = engagementOf();
            commit({ prompts: { ...snapshot.prompts, busy: true } });
            let response;
            try {
                response = await (0, prompts_tab_js_2.loadPrompts)(api, engagement);
            }
            catch (cause) {
                commit({ prompts: { ...snapshot.prompts, busy: false, error: messageOf(cause) } });
                return;
            }
            const load = (0, prompts_model_js_2.promptLoadOf)(response);
            // 保持已选中的角色（`activeRoleOf`：已有选择就不动），草稿跟随服务端值。
            const active = (0, prompts_model_js_2.activeRoleOf)(load.roles, snapshot.prompts.active);
            commit({
                prompts: {
                    ...snapshot.prompts,
                    busy: false,
                    error: load.error,
                    data: load,
                    active,
                    draft: (0, prompts_model_js_2.draftFor)(load.roles, active),
                },
            });
        }
        async function savePromptDraft() {
            const engagement = engagementOf();
            const current = snapshot.prompts;
            commit({ prompts: { ...current, busy: true, message: null } });
            let outcome;
            try {
                outcome = await (0, prompts_tab_js_2.savePrompt)(api, engagement, current.active, current.draft);
            }
            catch (cause) {
                commit({ prompts: { ...snapshot.prompts, busy: false, message: { kind: "err", text: messageOf(cause) } } });
                return;
            }
            if (outcome.response === null) {
                // 被前置条件拦下（无靶标 / 无角色）：不发请求，直接把原因当消息。
                commit({ prompts: { ...snapshot.prompts, busy: false, message: outcome.message } });
                return;
            }
            // 保存成功：本地先改一行（少一次往返），再回读让服务端时间戳生效。
            const patched = (0, prompts_tab_js_2.applySavedDraft)(current.data, current.active, current.draft, nowIso());
            commit({ prompts: { ...snapshot.prompts, busy: false, message: outcome.message, data: patched } });
            await refreshPrompts();
        }
        async function resetPromptRoles(all) {
            const engagement = engagementOf();
            const current = snapshot.prompts;
            commit({ prompts: { ...current, busy: true, message: null } });
            let outcome;
            try {
                outcome = await (0, prompts_tab_js_2.resetPrompts)(api, engagement, current.active, all);
            }
            catch (cause) {
                commit({ prompts: { ...snapshot.prompts, busy: false, message: { kind: "err", text: messageOf(cause) } } });
                return;
            }
            commit({ prompts: { ...snapshot.prompts, busy: false, message: outcome.message } });
            if (outcome.response === null)
                return;
            await refreshPrompts();
        }
        /* ────────────────────────────────────────── 报告 */
        async function refreshReport() {
            const engagement = engagementOf();
            if (engagement === null) {
                commit({ report: { ...snapshot.report, busy: false, error: exports.REPORT_NEED_ENGAGEMENT, data: null } });
                return;
            }
            commit({ report: { ...snapshot.report, busy: true, error: null } });
            let result;
            try {
                result = await (0, report_tab_js_2.loadReportWithGrouping)(api, engagement);
            }
            catch (cause) {
                result = { data: null, error: messageOf(cause) };
            }
            commit({ report: { ...snapshot.report, busy: false, error: result.error, data: result.data } });
        }
        async function downloadText(text, label) {
            if (deps.download === undefined) {
                commit({
                    report: { ...snapshot.report, message: { kind: "err", text: "宿主未提供下载能力 —— 可先复制全文" } },
                });
                return;
            }
            let ok = false;
            let failure = "";
            try {
                ok = await deps.download(text, label);
            }
            catch (cause) {
                failure = (0, report_model_js_2.downloadFailedMessage)(cause);
            }
            commit({
                report: {
                    ...snapshot.report,
                    message: failure !== ""
                        ? { kind: "err", text: failure }
                        : ok
                            ? { kind: "ok", text: (0, report_model_js_2.downloadedMessage)(label) }
                            : { kind: "err", text: "下载失败：浏览器未授权" },
                },
            });
        }
        /* ────────────────────────────────────────── 证据截图 */
        function ensureShot(shotId) {
            if (snapshot.shots.has(shotId) || shotPending.has(shotId))
                return;
            const engagement = engagementOf();
            if (engagement === null)
                return;
            shotPending.add(shotId);
            void api.raw({ op: "shotData", engagement, id: shotId }).then((response) => {
                shotPending.delete(shotId);
                const url = shotImageOf(response);
                // 取不到就不放图（不塞占位图假装有）。
                if (url === null)
                    return;
                const next = new Map(snapshot.shots);
                next.set(shotId, url);
                commit({ shots: next });
            }, () => {
                shotPending.delete(shotId);
            });
        }
        /* ────────────────────────────────────────── 组装 */
        return {
            get: () => snapshot,
            subscribe(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            engagement: engagementOf,
            refreshKnowledge,
            setKnowledgeQuery(query) {
                commit({ knowledge: { ...snapshot.knowledge, query } });
            },
            async submitKnowledge() {
                // **只检索，不动 query**：`onSubmit`（用户点检索）与 `onPage`（翻模板页）
                // 各自先把 query 改好再调这里。在这里顺手把 offset 归零会让翻页永远失效。
                await refreshKnowledge();
            },
            async setKnowledgeCategory(code) {
                commit({ knowledge: { ...snapshot.knowledge, query: (0, knowledge_tab_js_2.queryAfterCategory)(snapshot.knowledge.query, code) } });
                await refreshKnowledge();
            },
            toggleKnowledgeGrouped() {
                commit({ knowledge: { ...snapshot.knowledge, grouped: !snapshot.knowledge.grouped } });
            },
            openPoc,
            async useKnowledgeItem(item) {
                let response;
                try {
                    response = await (0, knowledge_tab_js_2.usePoc)(api, item.id);
                }
                catch (cause) {
                    commit({ knowledge: { ...snapshot.knowledge, message: { kind: "err", text: messageOf(cause) } } });
                    return;
                }
                const error = responseError(response, "标记失败");
                if (error !== null) {
                    commit({ knowledge: { ...snapshot.knowledge, message: { kind: "err", text: error } } });
                    return;
                }
                commit({ knowledge: { ...snapshot.knowledge, message: (0, knowledge_tab_js_2.useSuccessMessage)(item) } });
                // 复用次数会变：重新检索让排序生效。
                await refreshKnowledge();
            },
            async copyKnowledgeText(text, label) {
                const outcome = await copyText(text, label);
                commit({
                    knowledge: { ...snapshot.knowledge, message: { kind: outcome.ok ? "ok" : "err", text: outcome.text } },
                });
            },
            refreshSkills,
            setSkillFilter(filter) {
                commit({ skills: { ...snapshot.skills, filter } });
            },
            toggleSkill,
            refreshTesting,
            setAuto(auto) {
                commit({ testing: { ...snapshot.testing, auto } });
                if (auto) {
                    startPolling();
                    // 打开即先取一次：否则要等 5 秒才有数据，看起来像没生效。
                    void refreshTesting();
                }
                else {
                    stopPolling();
                }
            },
            toggleTestingSection(key) {
                const current = snapshot.testing;
                const fallback = key.startsWith("testing:")
                    ? testing_model_js_2.SECTION_DEFAULTS.testing
                    : key.startsWith("recent:")
                        ? testing_model_js_2.SECTION_DEFAULTS.recent
                        : testing_model_js_2.SECTION_DEFAULTS.queue;
                commit({ testing: { ...current, collapsed: (0, state_js_8.toggleSection)(current.collapsed, key, fallback) } });
            },
            expandTestingSections() {
                const engagement = engagementOf();
                if (engagement === null)
                    return;
                commit({
                    testing: {
                        ...snapshot.testing,
                        collapsed: (0, state_js_8.setSections)(snapshot.testing.collapsed, (0, testing_model_js_2.sectionKeys)(engagement), true),
                    },
                });
            },
            collapseTestingSections() {
                const engagement = engagementOf();
                if (engagement === null)
                    return;
                commit({
                    testing: {
                        ...snapshot.testing,
                        collapsed: (0, state_js_8.setSections)(snapshot.testing.collapsed, (0, testing_model_js_2.sectionKeys)(engagement), false),
                    },
                });
            },
            toggleTestingNotes(assetId) {
                const open = snapshot.testing.openNotes;
                const next = open.includes(assetId) ? open.filter((id) => id !== assetId) : [...open, assetId];
                commit({ testing: { ...snapshot.testing, openNotes: next } });
            },
            async copyTestingText(text) {
                await copyText(text, "测试记录");
            },
            dispose() {
                stopPolling();
                listeners.clear();
            },
            refreshAttackFiles,
            openAttackFile,
            setAttackFileCollapse(state) {
                commit({ attackfiles: { ...snapshot.attackfiles, collapse: state } });
            },
            refreshPrompts,
            selectPromptRole(role) {
                const load = snapshot.prompts.data;
                const roles = load === null ? [] : load.roles;
                // 换角色时草稿切到该角色的服务端正文。
                commit({ prompts: { ...snapshot.prompts, active: role, draft: (0, prompts_model_js_2.draftFor)(roles, role), message: null } });
            },
            setPromptDraft(draft) {
                commit({ prompts: { ...snapshot.prompts, draft } });
            },
            savePromptDraft,
            resetPromptRoles,
            refreshReport,
            async copyReportText(text, label) {
                const outcome = await copyText(text, label);
                commit({ report: { ...snapshot.report, message: (0, report_tab_js_2.copyFeedback)(outcome.ok, label) } });
            },
            downloadReportText: downloadText,
            setReportCollapse(state) {
                commit({ report: { ...snapshot.report, collapse: state } });
            },
            setReportAllCollapsed(keys, open) {
                commit({ report: { ...snapshot.report, collapse: (0, state_js_8.setSections)(snapshot.report.collapse, keys, open) } });
            },
            shotUrl: (shotId) => snapshot.shots.get(shotId),
            ensureShot,
        };
    }
    /* ══════════════════════════════════════════════════════════════ props 构造 */
    /**
     * 报告证据截图条。
     *
     * 结构对齐 `client/styles.ts` 里已有的 `.rt-shots` CSS 契约：
     *
     * ```
     * .rt-shots
     *   .rt-shots-head   → 「证据截图」+ 张数
     *   .rt-shot-row
     *     .rt-shot
     *       .rt-shot-thumb  (img)
     *       .rt-shot-cap    → 说明文字
     * ```
     *
     * 这几个类名与上游一致（`styles.ts` 的注释说该段落复刻自上游），
     * 自己另起一套类名会让截图**完全没有样式**（裸 `<img>` 200px 宽挤成一排）。
     *
     * **只在真能取到字节时才渲染 `<img>`**：`shotData` op 返回 base64，这里用
     * `shotDataUrl` 转成 data URL 内联，避免为图片再开一条带鉴权的路由。
     * 还没取回来的先触发一次取数并跳过（这一帧不渲染图），取回后容器通知重渲染。
     * **不放占位图**：一个灰色方块会让人以为「图坏了」。
     */
    function renderShotStrip(runtime, state, item) {
        if (item.shots.length === 0)
            return null;
        const { h } = runtime;
        const cards = [];
        for (const shot of item.shots) {
            const url = state.shotUrl(shot.id);
            if (url === undefined) {
                state.ensureShot(shot.id);
                continue;
            }
            const label = shot.label !== "" ? shot.label : "证据截图";
            cards.push(h("div", { key: "shot" + shot.id, className: "rt-shot" }, h("img", {
                className: "rt-shot-thumb",
                src: url,
                alt: label,
                title: shot.note !== "" ? shot.note : label,
            }), h("div", { className: "rt-shot-cap" }, h("span", { className: "rt-shot-label", title: label }, label), shot.target !== "" ? h("span", { className: "rt-shots-n" }, shot.target) : null)));
        }
        if (cards.length === 0)
            return null;
        return h("div", { className: "rt-shots" }, h("div", { className: "rt-shots-head" }, h("b", null, "证据截图"), h("span", { className: "rt-shots-n" }, cards.length + " / " + item.shotTotal + " 张（每个得分点最多 3 张）")), h("div", { className: "rt-shot-row" }, cards));
    }
    /**
     * 把容器状态映射成 6 个页签的 props。
     *
     * 每个回调都**接到容器的真实方法**（不是 `() => {}`）：`onRefresh` 真的重拉、
     * `onSubmit` 真的换关键词重查、`onToggleSection` 真的改折叠、`onSave` 真的提交。
     *
     * `engagement` 参数是当前靶标 id：`testing` 页签靠它区分「没选靶标」与
     * 「选了但还没数据」，两者显示完全不同的内容（前者是提示，后者是空列表）。
     */
    function propsForWithEngagement(runtime, state, engagement) {
        const snapshot = state.get();
        const knowledge = snapshot.knowledge;
        const skills = snapshot.skills;
        const testing = snapshot.testing;
        const attackfiles = snapshot.attackfiles;
        const prompts = snapshot.prompts;
        const report = snapshot.report;
        return {
            knowledge: {
                data: knowledge.data,
                query: knowledge.query,
                openId: knowledge.openId,
                // 派生：切到别的条目后 detail 不再被读到（防「显示上一条正文」）。
                detail: (0, knowledge_model_js_3.detailFor)(knowledge.detail, knowledge.openId),
                detailBusy: knowledge.detailBusy,
                busy: knowledge.busy,
                error: knowledge.error,
                message: knowledge.message,
                grouped: knowledge.grouped,
                onQueryChange: (query) => state.setKnowledgeQuery(query),
                onSubmit: () => {
                    // 用户点「检索」：换条件重查，模板分页回到第一页
                    // （否则会停在旧偏移上，看到的是新结果集的第 3 页 —— 多半是空的）。
                    state.setKnowledgeQuery({ ...state.get().knowledge.query, templateOffset: 0 });
                    void state.submitKnowledge();
                },
                onCategoryChange: (code) => {
                    void state.setKnowledgeCategory(code);
                },
                onToggleGrouped: () => state.toggleKnowledgeGrouped(),
                onOpen: (id) => {
                    void state.openPoc(id);
                },
                onCopy: (text, label) => {
                    void state.copyKnowledgeText(text, label);
                },
                onUse: (item) => {
                    void state.useKnowledgeItem(item);
                },
                onPage: (offset) => {
                    // 翻模板页：只改 offset，再检索一次（不动其它条件）。
                    // **必须读 `state.get()` 而不是上面的 `knowledge`**：`knowledge` 是这次渲染
                    // 开始时的快照，隔了几次 setState 之后它已经过期 —— 拿它去覆盖会把用户
                    // 刚改的关键词/归类一起冲掉（实测：翻页后 offset 变成 0）。
                    state.setKnowledgeQuery({ ...state.get().knowledge.query, templateOffset: offset });
                    void state.submitKnowledge();
                },
            },
            skills: {
                catalog: skills.data,
                filter: skills.filter,
                activeKey: skills.activeKey,
                detail: skills.detail,
                busy: skills.busy,
                detailBusy: skills.detailBusy,
                onRefresh: (force) => {
                    void state.refreshSkills(force);
                },
                onFilterChange: (filter) => state.setSkillFilter(filter),
                onToggle: (item) => {
                    void state.toggleSkill(item);
                },
            },
            testing: {
                engagement,
                data: testing.data,
                error: testing.error,
                updatedAt: testing.updatedAt,
                auto: testing.auto,
                collapsed: testing.collapsed,
                onRefresh: () => {
                    void state.refreshTesting();
                },
                // 读 `state.get()` 而不是这次渲染的 `testing` 快照：连点两次时旧快照的
                // `auto` 不会变，会把两次点击都算成「打开」（实测：点两下仍停在「实时」）。
                onToggleAuto: () => state.setAuto(!state.get().testing.auto),
                onToggleSection: (key) => state.toggleTestingSection(key),
                onExpandAll: () => state.expandTestingSections(),
                onCollapseAll: () => state.collapseTestingSections(),
                openNotes: testing.openNotes,
                onToggleNotes: (assetId) => state.toggleTestingNotes(assetId),
                onCopy: (text) => {
                    void state.copyTestingText(text);
                },
            },
            attackfiles: {
                folders: attackfiles.data ?? [],
                detail: attackfiles.detail,
                error: attackfiles.error,
                busy: attackfiles.busy,
                collapse: attackfiles.collapse,
                onRefresh: () => {
                    void state.refreshAttackFiles();
                },
                onOpenFile: (file) => {
                    void state.openAttackFile(file);
                },
                onCollapseChange: (next) => state.setAttackFileCollapse(next),
            },
            prompts: {
                catalog: prompts.data,
                active: prompts.active,
                draft: prompts.draft,
                message: prompts.message,
                busy: prompts.busy,
                onRefresh: () => {
                    void state.refreshPrompts();
                },
                onSelect: (role) => state.selectPromptRole(role),
                onDraftChange: (draft) => state.setPromptDraft(draft),
                onSave: () => {
                    void state.savePromptDraft();
                },
                onReset: (all) => {
                    void state.resetPromptRoles(all);
                },
            },
            report: {
                data: report.data,
                error: report.error,
                message: report.message,
                busy: report.busy,
                collapse: report.collapse,
                // 截图槽：`shotData` 返 base64，真能取到字节 —— 所以真的实现，
                // 而不是传一个返回空 div 的假函数。
                renderShots: (item) => renderShotStrip(runtime, state, item),
                onRefresh: () => {
                    void state.refreshReport();
                },
                onCopy: (text, label) => {
                    void state.copyReportText(text, label);
                },
                onDownload: (text, label) => {
                    void state.downloadReportText(text, label);
                },
                onCollapseChange: (next) => state.setReportCollapse(next),
                onSetAllCollapsed: (keys, open) => state.setReportAllCollapsed(keys, open),
            },
        };
    }
    /** 便捷入口：靶标取容器自己记的那一个。 */
    function propsFor(runtime, state) {
        return propsForWithEngagement(runtime, state, state.engagement());
    }
    /**
     * 首屏取数（6 个页签各一次）。
     *
     * 分开导出而不是塞进 `makeTabsBState`：容器可能想在挂载前就预热，
     * 也可能想在重连后只重取某几个 —— 让调用方决定。
     */
    function loadAll(state) {
        void state.refreshKnowledge();
        void state.refreshSkills(false);
        void state.refreshTesting();
        void state.refreshAttackFiles();
        void state.refreshPrompts();
        void state.refreshReport();
    }
    /**
     * 造一个可直接传给 `ConsoleInit.tabProps` 的槽。
     *
     * 职责只有三件：挂载时首屏取数、靶标变化时重取、把容器变更变成一次 `setState`。
     * **取数逻辑一行都不在这里** —— 全在 `makeTabsBState` 里，所以那部分能在没有
     * React 的测试里跑完。
     *
     * ```ts
     * makeConsoleModule({
     *   ...,
     *   tabProps: makeTabsBSlot(runtime, makeApiClient({ fetch }), () => currentEngagement),
     * })
     * ```
     */
    function makeTabsBSlot(runtime, api, engagement, extra = {}) {
        const React = runtime.React;
        /** 容器只造一次（每次渲染都重建会把状态全丢掉）。 */
        let cached = null;
        /** 上一次取数用的靶标（变化 = 要重取）。 */
        let loadedFor = undefined;
        return function tabsBProps() {
            const [, setVersion] = React.useState(0);
            const current = engagement();
            if (cached === null) {
                cached = makeTabsBState({
                    ...extra,
                    api,
                    engagement,
                    notify: () => setVersion((value) => value + 1),
                });
            }
            const state = cached;
            React.useEffect(() => {
                if (loadedFor === undefined) {
                    // 首屏：6 个页签各取一次。失败各自进 error，互不影响。
                    loadedFor = current;
                    loadAll(state);
                    return;
                }
                if (loadedFor !== current) {
                    // 靶标变了：清掉依赖靶标的页签并重取（知识库是全局的，也一起刷）。
                    loadedFor = current;
                    void state.refreshTesting();
                    void state.refreshAttackFiles();
                    void state.refreshPrompts();
                    void state.refreshReport();
                    void state.refreshKnowledge();
                }
            }, [current, state]);
            return propsForWithEngagement(runtime, state, current);
        };
    }
    /* ══════════════════════════════════════════════════════════════ 未能接线 */
    /**
     * `agents` 页签为什么这里没接（如实记录）。
     *
     * `tab-registry.ts` 的 `TabRegistryProps` 里**没有 `agents` 字段**，
     * 分派分支是：
     *
     * ```ts
     * case "agents": {
     *   // 智能体概览属于插件生命周期层（`src/plugin/`），不在客户端渲染。
     *   return empty(tab);
     * }
     * ```
     *
     * 它**无条件**返回「智能体概览未接入」，不读任何 props；`client/` 下也没有
     * `agents-tab.ts`（没有 `AgentsTabProps` 这个类型）。要接它必须同时改
     * `client/tab-registry.ts` 并新增一个页签渲染器 —— 两者都在本任务的写入域之外
     * （`client/**` 明确不许改）。
     *
     * 数据侧是**齐的**：网关的 `agentsStatus` op（`ui/gateway.ts` 的
     * `handleAgentsStatus`）返回 `{ max, used, free, running, total_children, source }`。
     * 所以这是**纯前端缺口**，不是后端缺口。
     *
     * 本文件因此不提供 `agents` 的 props，也不写「只返回空 div 的假函数」凑数 ——
     * 那会让人以为已经接了，而页面上什么都没变。
     */
    exports.AGENTS_NOT_WIRED_REASON = "agents 页签在 tab-registry.ts 里无 props 槽位，client/ 下也无对应渲染器；"
        + "后端 agentsStatus op 已就绪，缺的是前端槽位（属 client/** 写入域，本任务不改）。";
    /* ══════════════════════════════════════════════════════════════ 诊断 */
    /** 本文件实际接线的页签 id（不含 `agents`，理由见上）。 */
    exports.TABS_B_WIRED = Object.freeze([
        "knowledge",
        "skills",
        "testing",
        "attackfiles",
        "prompts",
        "report",
    ]);
    /**
     * 每个页签实际用到的 op。
     *
     * 报告与诊断据此核对，**不靠记忆**。注意两处与任务书的差异（都是读 `dispatch.ts`
     * 后按实际返回形状定的）：
     * - `report` 用 `scoreReport`（不是 `report`）+ `scoreChain`（补阶段分组时）
     *   —— `report-tab.ts` 的 `loadReport` 就是发 `scoreReport`。
     * - `skills` 用 `skillCatalog` / `skillRead`：它们是**网关 op**
     *   （`ui/gateway.ts`），走的是同一条 `/redteam/api`，所以前端拿得到。
     */
    exports.TABS_B_OPS = Object.freeze({
        knowledge: Object.freeze(["pocSearch", "pocGet", "pocUse"]),
        skills: Object.freeze(["skillCatalog", "skillRead"]),
        testing: Object.freeze(["activeTests"]),
        attackfiles: Object.freeze(["attackFiles", "readAttackFile"]),
        prompts: Object.freeze(["prompts", "savePrompt", "resetPrompts"]),
        report: Object.freeze(["scoreReport", "scoreChain", "shotData"]),
    });
    /** 供容器判断「这个 op 是不是我这组负责」（未知 op 一律 `false`）。 */
    function tabBOwnsOp(op) {
        for (const ops of Object.values(exports.TABS_B_OPS)) {
            if (ops.includes(op))
                return true;
        }
        return false;
    }
});
/**
 * 页签数据的容器接线层。
 *
 * ## 这一层存在的理由
 *
 * `tabs-a.ts` 与 `tabs-b.ts` 各自是**无状态工厂**：它们只负责「按 op 取数、
 * 把响应转成 props、把回调接到取数上」。它们不知道 React 的存在，也不知道
 * 当前渲染的是哪个页签 —— 这是刻意的，它让两组都能在 `node:test` 里直接驱动。
 *
 * 但宿主要的是 `TabPropsSlot = () => TabRegistryProps`：一个**在 React 渲染期
 * 被调用**、返回当前页签 props 的函数。于是需要这一层把三者接起来：
 *
 * ```
 * React 渲染 → 本层 → A 组 propsFor(tab) + B 组 propsFor(tab) 合并
 *                        ↑ 订阅变化后触发重渲染
 * ```
 *
 * ## 为什么两组都造、只取当前页签
 *
 * `propsFor(tab)` 是「只装这一个页签」的入口，两组都实现了它。本层按当前
 * 页签只调其中一组，避免每次渲染把 13 个页签的 props 全算一遍 —— 那些
 * props 里含大量格式化（时间、计数、路径），全算是纯浪费。
 *
 * 两边返回的都是**部分** `TabRegistryProps`（各自只有自己负责的页签键），
 * 合并即可。键不重叠（见 `TABS_A_OWNED` / `tabs-b` 的 `OWNED_CLIENT_TABS`），
 * 所以合并安全，不需要后者覆盖前者的语义。
 *
 * ## 交叉注入
 *
 * 有两个 props 是**别人的渲染节点**，只能由容器给：
 *
 * - `assets.renderTesting` ← `renderTestingTab(runtime, props.testing)`
 * - `findings.attackFilesNode` ← `renderAttackFilesTab(runtime, props.attackfiles)`
 *
 * `tab-registry.ts` 已经写好了「`props.testing` 存在才注入」的判断，本层
 * 只需保证同一轮 props 里 `testing` / `attackfiles` 与当前页签同源。
 * 因为两组各自都会返回自己负责的页签键，所以当渲染 `assets` 时，
 * B 组返回的 `testing` 正好可用于注入 —— 但 `propsFor("assets")` 只会返回
 * assets 一个键，拿不到 testing。
 *
 * 处理方式：本层额外向 B 组要一次 `testing` / `attackfiles` 的 props
 * （仅当当前页签是 `assets` / `findings` 时），避免为这一点把两大组全算。
 */
define("redteam/ui/tab-data", ["require", "exports", "redteam/ui/tabs-a", "redteam/ui/tabs-b"], function (require, exports, tabs_a_js_1, tabs_b_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.makeTabPropsSlot = makeTabPropsSlot;
    /** 交叉注入需要的页签：当前页签 → 需要额外取的那一组 props。 */
    const CROSS_INJECT = Object.freeze({
        // 资产页签要测试子视图
        assets: ["testing"],
        // 漏洞页签要攻击文件子视图
        findings: ["attackfiles"],
    });
    /**
     * 造一个可喂给 `ConsoleInit.tabProps` 的 slot。
     *
     * **必须在 React 渲染期调用返回值**（它内部用 `useState` 订阅变化），
     * 这与 `ConsoleInit.tabProps` 的调用位置一致（`console.ts` 的 `ConsoleApp`
     * 里每次渲染调一次）。
     */
    function makeTabPropsSlot(runtime, api, wiring) {
        const React = runtime.React;
        /* A 组是无状态工厂，造一次即可（它自带 subscribe）。 */
        let tabsA = null;
        /* B 组的状态工厂，同样只造一次。 */
        let tabsB = null;
        /* 上一次取数用的靶标 —— 变了要重取。 */
        let loadedFor = undefined;
        return function tabProps() {
            const [, bump] = React.useState(0);
            const current = wiring.engagement();
            if (tabsA === null) {
                tabsA = (0, tabs_a_js_1.makeTabsA)({
                    api,
                    engagement: current,
                    /* 剪贴板：不传的话 `tabs-a.ts` 的默认值是「一律返回 false」，
                       六个页签的复制按钮会全部显示「复制失败（浏览器未授权剪贴板）」。
                       那不是 bug（它不谎称成功），但体验差一截。
                       `makeWindowCopy` 依次试 clipboard.writeText → textarea+execCommand，
                       都给不出真结果时返回 false —— 行为已由 4 条用例钉住。 */
                    copyText: (0, tabs_a_js_1.makeWindowCopy)(runtime.window),
                    /* 状态变化 → 触发重渲染。`bump` 是 React 的 setState，
                       同值不重渲染，所以这里用一个自增包装。 */
                    onChange: () => bump((value) => value + 1),
                });
            }
            const a = tabsA;
            if (tabsB === null) {
                tabsB = (0, tabs_b_js_1.makeTabsBState)({
                    api,
                    engagement: wiring.engagement,
                    notify: () => bump((value) => value + 1),
                });
            }
            const b = tabsB;
            /* 订阅 A 组状态：它在取数完成后会 notify。B 组用 notify 回调，不必订阅。 */
            React.useEffect(() => {
                return a.subscribe(() => bump((value) => value + 1));
            }, [a]);
            /* 首屏与切靶标取数。
             *
             * **两组都要取。** `makeTabsBState` 只造状态、不取数；漏掉 `loadAllB`
             * 的话 B 组 6 个页签永远停在 `data === null` 的加载态 —— 即使容器
             * 已经把它们接上了。实测对照（假 fetch 喂业务串）：
             *
             *   不调 loadAllB → knowledge/skills/testing/attackfiles/prompts/report 全部 EMPTY
             *   调 loadAllB   → 同样 6 个页签全部渲染出真实内容（节点长度也变大，不是空态换文案）
             *
             * 这条曾经真的漏过，所以注释留在这里当护栏。
             */
            React.useEffect(() => {
                if (loadedFor === undefined) {
                    loadedFor = current;
                    a.setEngagement(current);
                    void a.loadAll();
                    (0, tabs_b_js_1.loadAll)(b);
                    return;
                }
                if (loadedFor !== current) {
                    loadedFor = current;
                    a.setEngagement(current);
                    void a.loadAll();
                    (0, tabs_b_js_1.loadAll)(b);
                }
            }, [current, a, b]);
            /* 当前页签 —— 从 runtime 的 ui 状态读，与 panel 渲染的同源。 */
            const active = runtime.ui.useUi().tab;
            const own = (0, tabs_a_js_1.ownsTab)(active) ? a.propsFor(active) : {};
            const bProps = (0, tabs_b_js_1.propsForWithEngagement)(runtime, b, current);
            /* 只取当前页签那一个键，而不是把 B 组全部键都摊开 —— 避免无谓计算。 */
            const mine = { ...own };
            const bKey = active;
            if (!(0, tabs_a_js_1.ownsTab)(active) && bProps[bKey] !== undefined) {
                mine[bKey] = bProps[bKey];
            }
            /* 交叉注入：assets 要 testing、findings 要 attackfiles。
               这些键平时不在当前页签的 props 里，需要单独取。 */
            const extra = CROSS_INJECT[active];
            if (extra !== undefined) {
                for (const need of extra) {
                    if (bProps[need] !== undefined) {
                        mine[need] = bProps[need];
                    }
                }
            }
            return mine;
        };
    }
});
/**
 * 控制台容器的**运行时入口**：把 `client/` 的纯函数页签接到宿主插件契约上。
 *
 * ## 这一层解决什么
 *
 * `client/` 里 12 个页签是纯函数（`renderXxxTab(runtime, props)`），
 * `panel.ts` 是纯外壳，`tab-registry.ts` 是纯分派 —— 三者都**不接触宿主**。
 * 而这个文件是唯一知道「宿主长什么样」的地方：
 *
 * - 宿主的模块契约是 `factory(require)` 返回 `{ name, inject, apply }`；
 * - 宿主的 UI 契约是 `ctx.slots.register(slot, component)`；
 * - 宿主的 `require("react")` 由它 provide。
 *
 * ## 为什么它不进 `client/`
 *
 * `client/**` 的每一行都必须能在 `node:test` 里直接跑（那是 3,600+ 用例的基础）。
 * 一旦某个模块开始读全局 `window`、调 `ctx.slots`，它就不再是纯函数，
 * 也没法脱离宿主测试。所以「宿主耦合」集中在**这一个文件**里，且它自己
 * 也用注入（`windowOf` / `requireModule`）避免直接摸全局 —— 于是它同样可测。
 *
 * ## 数据加载的现状（如实记录）
 *
 * 本容器做四件事：**挂槽位、拉靶标名册（`bootstrap`）、分派页签、挂样式**。
 * 逐页签的业务数据（资产/漏洞/攻击链…）**尚未接线** —— 每个页签拿到空 props，
 * 会走自己设计好的空态（"还没有资产数据（先跑信息收集）"等）。
 *
 * 这不是省事：`tab-registry.ts` 的 props 设计就是**每项可缺失**，注释里写明
 * 「面板先能显示」与「数据逐项接齐」分两步做。容器只传它真有的东西，
 * 页签自己降级 —— 不存在「半截数据」这种会撒谎的中间态。
 * 接数据的扩展点是 `TabPropsSlot`（见下）。
 */
define("redteam/ui/console", ["require", "exports", "redteam/client/runtime", "redteam/client/api", "redteam/client/panel", "redteam/client/entry", "redteam/client/tab-registry", "redteam/client/styles", "redteam/ui/tab-data"], function (require, exports, runtime_js_1, api_js_2, panel_js_1, entry_js_2, tab_registry_js_1, styles_js_2, tab_data_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.INJECT = exports.SLOT_ORDER = exports.SLOT_ID = exports.SLOT_NAME = exports.MODULE_NAME = void 0;
    exports.savedWidthOf = savedWidthOf;
    exports.engagementsOf = engagementsOf;
    exports.currentOf = currentOf;
    exports.makeConsoleApp = makeConsoleApp;
    exports.makeConsoleModule = makeConsoleModule;
    /** 模块 id：宿主的 `__ModuleLoader__` 用它做注册键，也是 `package.json` 的包名。 */
    exports.MODULE_NAME = "dsh-unbound";
    /** 面板挂的槽位（与上游一致）。 */
    exports.SLOT_NAME = "shell.overlay";
    /** 槽位内唯一标识（同一槽位可能挂多个面板）。 */
    exports.SLOT_ID = "dsh-unbound-console";
    /** 槽位排序（上游用 50；保持同值，避免与其它插件的相对顺序变化）。 */
    exports.SLOT_ORDER = 50;
    /**
     * 向宿主声明的依赖服务。
     *
     * 与上游一致只要 `slots`（挂面板）与 `locale`（宿主会在 apply 前等它们就绪）。
     * **不要**把 `pluginPackages` 之类写进来：Cordis 会对每个声明的 key 空等，
     * 等不到就 pending，最终宿主退出码 1（上游注释记过这个坑）。
     */
    exports.INJECT = Object.freeze(["slots", "locale"]);
    /** 从运行时窗口里取 `fetch`（`MinimalWindow` 没有它，只有 `DshWindow` 有）。 */
    function fetchOf(windowRef) {
        if (windowRef === null || typeof windowRef !== "object")
            return null;
        const candidate = windowRef.fetch;
        return typeof candidate === "function" ? candidate : null;
    }
    /** 读上次拖拽保存的面板宽度（读不到 → `null`，由 `defaultDockGeometry` 兜底）。 */
    function savedWidthOf(windowRef) {
        const raw = (0, runtime_js_1.readStorage)(windowRef, runtime_js_1.STORAGE_KEYS.width);
        if (raw === null || raw === "")
            return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    /** 从 `bootstrap` 响应里读名册（不可信输入，逐项窄化）。 */
    function engagementsOf(response) {
        const raw = response["engagements"];
        if (!Array.isArray(raw))
            return [];
        const out = [];
        for (const entry of raw) {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry))
                continue;
            const record = entry;
            const id = record["id"];
            if (typeof id !== "string" || id === "")
                continue;
            const displayName = record["name"];
            out.push(typeof displayName === "string" ? { id, name: displayName } : { id });
        }
        return out;
    }
    /** 从 `bootstrap` 响应里读当前靶标（不可信输入）。 */
    function currentOf(response) {
        const current = response["current"];
        return typeof current === "string" && current !== "" ? current : null;
    }
    /**
     * 造面板组件（**函数组件**，宿主用 `h(component, props)` 渲染）。
     *
     * 内部只用 `runtime.React` 的 hook —— 于是测试里换成假 react 就能直接调用，
     * 不需要 React 运行时。
     */
    function makeConsoleApp(runtime, api, tabPropsSlot = () => ({})) {
        const React = runtime.React;
        return function ConsoleApp() {
            const ui = runtime.ui.useUi();
            const [engagements, setEngagements] = React.useState([]);
            const [engagement, setEngagement] = React.useState(null);
            /**
             * `bootstrap`：名册 + 当前靶标。
             *
             * 失败**不抛也不清空界面** —— 宿主重启期间面板要能继续显示（用自己的空态），
             * 而不是因为一次失败变成白屏。这与 `api.ts` 的「永不 reject」契约配套。
             */
            React.useEffect(() => {
                let alive = true;
                void api.raw({ op: "bootstrap" }).then((response) => {
                    if (!alive || response.ok === false)
                        return;
                    setEngagements(engagementsOf(response));
                    setEngagement(currentOf(response));
                }, () => undefined);
                return () => {
                    alive = false;
                };
            }, []);
            const renderTab = (0, tab_registry_js_1.makeRenderTab)(runtime, tabPropsSlot());
            const geometry = (0, panel_js_1.initialGeometry)(runtime.window, savedWidthOf(runtime.window));
            return (0, panel_js_1.renderPanel)(runtime, {
                engagement,
                engagements,
                renderTab,
                stats: {},
                onTabChange: (tab) => {
                    runtime.ui.set({ tab });
                },
                onEngagementChange: (id) => {
                    const next = id === "" ? null : id;
                    setEngagement(next);
                    // 服务端持久化「当前靶标」；失败静默（面板已在本地下切换了）。
                    if (next !== null) {
                        void api.raw({ op: "activateEngagement", engagement: next }).then(() => undefined, () => undefined);
                    }
                },
                onRefresh: () => {
                    void api.raw({ op: "bootstrap" }).then((response) => {
                        if (response.ok === false)
                            return;
                        setEngagements(engagementsOf(response));
                        setEngagement(currentOf(response));
                    }, () => undefined);
                },
            }, {
                uiOpen: ui.open,
                activeTab: ui.tab,
                geometry,
                full: (0, entry_js_2.isFullWindow)(runtime),
            });
        };
    }
    /** 全部页签 id（从 `state.ts` 的枚举里数出来的固定清单，用于诊断）。 */
    const ALL_TAB_IDS = Object.freeze([
        "assets", "env", "agents", "sessions", "findings", "chain",
        "scores", "report", "knowledge", "skills", "testing", "attackfiles", "prompts",
    ]);
    /**
     * 造完整的宿主模块对象。
     *
     * `apply(ctx)` 的每一步失败都有**可读日志**而不是静默返回：
     * 「面板没出现」是最难排查的一类问题，宿主日志是唯一线索。
     */
    /**
     * 惰性数据接线槽。
     *
     * ## 为什么必须惰性
     *
     * 自动接线要用 `window.fetch`，而 `window` 只有 `apply(ctx)` 里才拿得到
     * （模块加载时还在宿主的外壳里，没有 window）。所以不能在造模块时就接线。
     *
     * ## 怎么就绪
     *
     * `apply` 成功后调 `ready(window)` 把运行时与 api 存下来；`ConsoleApp` 首次
     * 渲染时 `slot()` 被调用，这才真的去造 A/B 两组。在此之前一律返回 `{}`，
     * 即「所有页签走空态」——与旧行为一致，不会白屏。
     *
     * ## 为什么用 `engagement` 取函数而不是值
     *
     * 靶标是 React state，切换后本层要能读到新值。闭包捕获的是取值函数，
     * 每次渲染都读最新 —— 若捕获值，切靶标后数据不会刷新（踩过）。
     */
    function lazySlot(init) {
        const explicit = init.tabProps;
        if (explicit !== undefined)
            return explicit;
        let slot = null;
        /* 给 `apply` 调：把能用的 window 存下来。 */
        const ready = (windowRef) => {
            if (slot !== null)
                return;
            /* 与 `apply()` 内那处 `createRuntime` 同策略：拿不到 `react`（宿主没
               provide、或 require 自己抛）就**不接线** —— 页签走空态，绝不抛。
               一个插件不该因为宿主缺服务就把整个界面拖崩。
               这里曾有回归：`apply` 自己包了 try/catch，但 `ready` 是它内部
               另外调的一次、独立又建了一个 runtime，那一次没保护。 */
            let runtime;
            try {
                runtime = (0, runtime_js_1.createRuntime)(init.requireModule, windowRef);
            }
            catch {
                return;
            }
            const fetchFn = windowRef.fetch;
            if (typeof fetchFn !== "function")
                return;
            const api = (0, api_js_2.makeApiClient)({ fetch: fetchFn });
            const readEngagement = () => {
                /* 与面板显示同源：`entry.ts` 把它存在 localStorage 的 `engagement` 键下。 */
                const raw = windowRef.localStorage?.getItem("dsh-unbound.engagement");
                return typeof raw === "string" && raw !== "" ? raw : null;
            };
            slot = (0, tab_data_js_1.makeTabPropsSlot)(runtime, api, { engagement: readEngagement });
        };
        const fn = (() => (slot === null ? {} : slot()));
        /* 内部通道：只有本文件用，不对外暴露成 API。 */
        fn.ready = ready;
        return fn;
    }
    /**
     * 造完整的宿主模块对象。
     *
     * `apply(ctx)` 的每一步失败都有**可读日志**而不是静默返回：
     * 「面板没出现」是最难排查的一类问题，宿主日志是唯一线索。
     */
    function makeConsoleModule(init) {
        /**
         * 数据接线槽。
         *
         * 调用方给了 `tabProps` 就用它（测试与定制场景）；没给就**自动接线**，
         * 让 13 个页签真的去 `POST /redteam/api` 取数据。
         *
         * 自动接线必须发生在 **apply 之后**（那时才有 `window.fetch`），
         * 所以这里用惰性求值：先记下 `init`，等 `ConsoleApp` 首次渲染时再造。
         * 在此之前返回空 props —— 与「省略 = 全走空态」的旧行为一致，
         * 差别只在于首帧之后会换成真数据。
         */
        const dataSlot = lazySlot(init);
        const parts = {
            styles: { css: styles_js_2.CSS, theme: styles_js_2.THEME },
            createRuntime: (windowRef) => (0, runtime_js_1.createRuntime)(init.requireModule, windowRef),
            renderTab: (runtime, tab) => (0, tab_registry_js_1.renderTabContent)(runtime, tab, dataSlot()),
            tabCount: ALL_TAB_IDS.filter((tab) => (0, runtime_js_1.isConsoleTabId)(tab)).length,
        };
        return {
            name: exports.MODULE_NAME,
            inject: exports.INJECT,
            parts,
            apply(ctx) {
                const warn = (message) => {
                    try {
                        ctx?.logger?.warn?.(message);
                    }
                    catch {
                        /* logger 本身炸了也不能影响挂载 */
                    }
                };
                const windowRef = init.windowOf();
                if (windowRef === null) {
                    warn("[dsh-unbound] 控制台未挂载：当前环境没有 window");
                    return;
                }
                const fetchFn = fetchOf(windowRef);
                if (fetchFn === null) {
                    warn("[dsh-unbound] 控制台未挂载：当前 window 没有 fetch");
                    return;
                }
                const slots = ctx?.slots;
                if (slots === undefined) {
                    warn("[dsh-unbound] 控制台未挂载：宿主没有 slots 服务");
                    return;
                }
                /* 数据槽就绪：此刻 `window` 与 `fetch` 都验证过了，是接线的最早安全点。
                   放在 `slots` 检查之后 —— 挂不上槽位时连数据层都不必造。 */
                dataSlot.ready?.(windowRef);
                // 造运行时可能抛（宿主 require('react') 失败）—— 捕获后报可读日志，
                // 不让一个插件把宿主整体拖崩。
                let runtime;
                try {
                    runtime = (0, runtime_js_1.createRuntime)(init.requireModule, windowRef);
                }
                catch (error) {
                    warn("[dsh-unbound] 控制台未挂载：require('react') 失败（"
                        + (error instanceof Error ? error.message : String(error)) + "）");
                    return;
                }
                const ConsoleApp = makeConsoleApp(runtime, (0, api_js_2.makeApiClient)({ fetch: fetchFn }), dataSlot);
                const mount = () => runtime.h(ConsoleApp, {});
                const slot = { name: exports.SLOT_NAME, id: exports.SLOT_ID, order: exports.SLOT_ORDER };
                const register = () => {
                    try {
                        slots.register?.(slot, mount);
                    }
                    catch (error) {
                        warn("[dsh-unbound] 控制台挂载失败：" + (error instanceof Error ? error.message : String(error)));
                    }
                };
                // `inject` 是宿主约定：等该槽位可用后再注册（上游同样用法）。
                try {
                    if (typeof slots.inject === "function")
                        slots.inject(exports.SLOT_NAME, register);
                    else
                        register();
                }
                catch (error) {
                    warn("[dsh-unbound] 槽位注册失败：" + (error instanceof Error ? error.message : String(error)));
                }
            },
        };
    }
});

/* ── 入口：把宿主契约交给已编译的 console 模块 ──────────────────────
 *
 * 上游 dsh-qilin 的 client.js 末尾是：
 *     exports.name = name; exports.inject = inject; exports.apply = apply
 * 宿主读这三个。这里逐条对齐，另外多挂 __parts 供诊断（宿主不读）。 */
var __console = __amdLoad("redteam/ui/console")

var __module = __console.makeConsoleModule({
  // 宿主的 require 实参：只认 "react"，我们的 shim 透传。
  requireModule: __amdRequire,
  // 全局 window：SSR / node 里没有，返回 null 让 apply 报可读日志而不是崩。
  windowOf: function () { return typeof window === "undefined" ? null : window },
})

exports.name = __module.name
exports.inject = __module.inject
exports.apply = __module.apply
exports.__parts = __module.parts
/* @dsh-unbound:factory-end */

    return module.exports
  },
})
