/**
 * 全部 56 个工具的 description 原文。
 *
 * ## 全自动生成，没有一个字是手抄的
 *
 * 生成流程（脚本见 `scripts/extract-descriptions.mjs`）：
 *
 * ```
 * 1. 在原 tools.js 里定位 `name: 'redteam_xxx'`
 * 2. 抓 `description:` 到 `parameters:` 之间的**表达式原文**
 *    （它们常是 '第一段' + '第二段' + '第三段' 的拼接）
 * 3. eval 那个表达式，得到最终字符串
 * 4. 生成本文件的字面量常量
 * ```
 *
 * 为什么必须这样：这批 description 累计约 20,000 字，最长的是
 * `redteam_score_hit`（1124 字，含三条红线）。手抄必错，而改一个字就可能改变模型行为
 * （例如把"不算突破"写成"算突破"）。
 *
 * `test/tools/tool-inventory.test.ts` 会比对每个工具的 `description` 与本文件是否
 * 逐字符相同 —— 所以"实现里写的就是原文"这件事有测试兜底，不靠自觉。
 *
 * ## 原样保留的格式
 *
 * `\n\n` 是原文的段落分隔（`tunnel_add` 的红线段落、`score_hit` 的三条红线等），
 * 分段的语义是有意的，不压缩、不重排。
 */

export const TOOL_DESCRIPTIONS = {
  redteam_access_add: "记录一次成功获得的访问会话（横向移动起点）。method 例如 vnc/rdp/ssh/web-shell/webshell/db；privilege 例如 admin/user/system。",
  redteam_access_list: "列出已获得的访问会话。",
  redteam_agent_slot: "【主会话派活前后用】执行智能体的并发闸门：同一靶标**最多同时 3 个**在跑（可用 REDTEAM_MAX_AGENTS 配置）。action=status 看还剩几个名额与谁在跑；action=acquire 占一个名额（满了会直接拒绝，**不要重试硬塞**）；action=release 释放（子智能体结束时服务端也会自动释放）。",
  redteam_asset_add: "把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。",
  redteam_asset_assess: "给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。",
  redteam_asset_get: "取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。",
  redteam_asset_graph: "导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。",
  redteam_asset_link: "在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。",
  redteam_asset_query: "检索资产库。支持按 C 段、端口、服务、指纹、来源、内外网维度（scope）、排序（sort）、关键词（全文，覆盖 IP/域名/banner/服务/指纹）过滤。返回紧凑结果，含每个资产的开放端口与指纹及内外网归属。",
  redteam_asset_stats: "资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。",
  redteam_asset_test: "记录对某个资产的测试情况：本次做了什么测试（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、当前测试状态、是否被 WAF 封禁。**每个资产开始测之前先调一次（status=testing），测完/放弃再调一次**——资产测绘页面据此显示「未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面」。排除结论、登录失败原因、重测理由都写在 `test` 里。",
  redteam_asset_timeline: "资产「发现时间」视图：按天聚合\"哪天收了多少资产\"（区分内网/外网），并列出最近发现的资产。用于回答\"这个资产是什么时候发现的\"、检查信息收集有没有断层，也用于本轮收集的收口核对。",
  redteam_attack_chain: "攻击链：按攻击面位置串起来的五个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ③ 边界突破（搭隧道）→ ④ 内网资产权限 → ⑤ 靶标权限。返回每阶段的阶段目标、**实际拿到多少分与累计分**、涉及资产、以及边界突破阶段的真实隧道。开工时看它明确\"现在在第几阶段、下一步该打哪一阶段\"，汇报时按阶段给结论。",
  redteam_attack_file_add: "保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如\"回显 uid=0\"、\"未授权返回 200 并含数据\"）——**没打通的、只是尝试过的脚本不要放进来**。",
  redteam_attack_file_list: "列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。",
  redteam_attack_path: "导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。",
  redteam_chain: "读取完整攻击链（按步骤顺序），用于汇报与检查链路是否闭合（入口 → 权限 → 内网突破）。",
  redteam_chain_add: "记录一个攻击链步骤。**报告里「这一步怎么来的」完全靠这条记录**：账号密码怎么来的、冰蝎马怎么上的、隧道怎么搭的，都要在这里用 `tool`（实际命令原文）+ `detail`（为什么这么做、线索从哪来）+ `result`（实际回显/结果）写清楚。攻击链页面与报告按 seq 排序展示。",
  redteam_credential_add: "记录一条凭据（漏洞利用/内网渗透角色）。**必须把口令/密钥明文写进 secret_value**——面板要直接显示明文供随时复用；同时用 secret_ref 指向 runs/ 下的证据文件。注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。",
  redteam_credential_list: "列出已收集的凭据（含明文 secret_value），用于凭据复用与横向移动。",
  redteam_domain_index: "按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。",
  redteam_engagement_open: "打开或创建一次攻防演练靶标（按单位名称），并把**当前会话**绑定到该靶标（子智能体会自动继承）。后续所有资产工具默认作用于它。若靶标已存在则复用其资产库。写入的是本会话的绑定，不会改动其它会话正在用的靶标。",
  redteam_http_evidence_add: "保存一条 HTTP 证据：原始请求与响应。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文，因此 request 必须是完整可重放的原始请求（含请求行、Host 等头部、必要时 body）。",
  redteam_poc_add: "把**通用可复用**的 POC/EXP 落进知识库（跨靶标共享）。从互联网拿到的、自己手搓的、或已经调通验证过的都往这里放——只收录真正有效的，并写清来源与验证证据。判断标准：**换个目标还能用**的进知识库；只对本次靶标有效的脚本走 redteam_attack_file_add（攻击文件页）。同名（同一 code）会合并刷新，可用于更新版本。\n\n**回填三件套（缺了面板里就没有归类、追溯不到来源）**：① `category` 归类；② `engagement` + `asset_target` —— 这条知识是在哪个靶标、哪台资产上发现并验证的；③ `verified` + `verified_note` 验证证据。",
  redteam_poc_get: "取一条知识库 POC/EXP 的**完整内容**（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改造成目标专用脚本。不传 id 时可用 code（redteam_poc_search 返回里的 code 字段）。",
  redteam_poc_list: "列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤，不带条件就是全部）。用于盘点\"我们手上已经有哪些现成武器\"，避免重复搜集。",
  redteam_poc_search: "【打 Nday/1day 前的第一步】先查\"现成的\"两层：① **知识库**（本机沉淀的通用 POC/EXP，跨靶标共享，按\"已验证 → 复用次数\"排序）② **本机 nuclei 模板库**（上万条模板，CVE/组件名直接命中）。命中就取用：知识库用 redteam_poc_get 拿全文，模板直接 `nuclei -t <相对路径>`。**不要重复去互联网找或重新手搓**。两层都没有，再去互联网搜索或自己手搓，验证有效后用 redteam_poc_add 回填知识库。",
  redteam_poc_update: "更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改标签。**在真实目标上验证通过后，一定要回来把 verified 置 true 并写清证据**——后续智能体会优先用已验证的。",
  redteam_poc_use: "记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面，方便后来者优先选经过实战的武器。",
  redteam_preflight: "【开工前必须跑一次】平台技能与资源自检：逐个检查红队技能的必需环境变量（如 FOFA 测绘的 FOFA_KEY）、本机工具与二进制（suo5 / fscan / gogo / frp / 冰蝎 / 哥斯拉 / nmap / nuclei…）、外部基础设施（反弹 Shell 用的 VPS）。返回 available/broken 清单与每个坏掉的技能\"缺什么、怎么补\"。**缺 key / 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。**",
  redteam_report: "【已弃用，改用 redteam_score_report】生成成果报告（Markdown）：只收录**已验证/已利用且中危以上**的成果漏洞（每条附可粘贴进 Burp/Yakit 的原始请求）、攻击链、已获权限与凭据、修复建议。信息收集的资产清单、待验证/误报、低危与信息级水洞都不会出现在报告里。想让发现进报告：先 redteam_vuln_update 置为 confirmed（验证通过）或 exploited（利用成功），再 redteam_http_evidence_add 补原始请求。",
  redteam_report_targets: "【已弃用，改用 redteam_score_report】按目标查看成果报告（每个 IP / URL / C 段一份）：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、已获权限、凭据、攻击文件、攻击链。用于按目标汇报或检查某个目标还缺什么。",
  redteam_role_prompt: "取出某个红队角色当前生效的系统提示词，只供查看。派活时不要把全文抄进任务；在 subagent 的 prompt 第一行写 redteamRole: <code>，角色稿会进入子会话系统提示词。",
  redteam_role_prompt_reset: "把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则四个角色全部重置。",
  redteam_roles: "列出红队角色及其职责标题（信息收集 / 漏洞检测 / 漏洞利用 / 内网渗透）。",
  redteam_score_hit: "记录一次得分。得分规则已按《突破入侵类得分规则（合并版）》重构为 **25 项**（一、获取权限 21 项 + 二、突破网络边界 4 项，共 8 个类别），另有 8 条通用规则 G1–G8 横切全部条目。**记分前先用 `redteam_score_list` 读实际 code 与该条的上限/口径**，不要凭记忆写。\n\n**证据只写结果**：目标资产 + 拿到了什么（账号/密码/权限/数据量），不要写取得过程与路径——过程由攻击得分链路的步骤负责。能指向\"用哪个漏洞拿到的\"时带上 vuln_id，报告会自动附上该漏洞的原始请求。\n\n**多档条目用 `points` 指定本档分值**：《合并版》把同一项的多个档位并成一条（如「服务器主机权限」普通 10 / 管理员 50、「域名控制权限」一级 50 / 二级 20、「网络设备权限」普通 100 / 管理员 200）。记分时把 `points` 填成本次实际档位的分值；不填就用该条的主档默认值。**同一系统只按最高权限计一次**（G1）——先记了普通档、后来提权到管理员档，再记一条管理员档（points 填高档值），系统会自动顶掉普通档那条。\n\n**红线一：账号类得分必须先实测能登录。** 拿到账号/口令后要用浏览器（browser-automation / kimi-webbridge）或等价会话实测登录成功、能交互访问页面，才记账号权限分——**只有凭据不算拿到账号**；登不进去的写进 redteam_asset_test 的 `test` 参数。\n\n**红线二：自己注册的账号不算得分权限。** 自助注册、自己新建的用户/角色/后台账号、自己给自己开的权限都不算——演练得分针对**拿到别人已有的**账号与权限。这类用 self_created=true 记录（留过程），不计分、不计数、不进报告。\n\n**红线三：注意该条的计分口径（G1/G3）。** 每条得分点自带口径：`同一系统只算最高权限一次`／`同一服务只算最高一条`／`整个目标只算一次`（突破网络边界）／`按台·卡·个累加`（终端、云节点、算力卡）。且每条有自己的**上限**（如服务器主机 600 分、Web 应用 2000 分、集权系统 4000 分），到上限后同条不再累计（G3）——返回里会用 warning 告诉你\"已达上限/已被顶掉\"，把它当**停止信号**，换别的条目或别的资产推进，不要在同一条上刷。\n\n**数据成果单独计分（G2）**：邮件数据、业务数据、数据资产等按重要程度另行记录，不与权限分混算；evidence 必须写出**实际数据量**（如「导出 1,320,000 条用户数据」）。",
  redteam_score_list: "查看得分目标面板：所有得分点（名称/分类/分值/是否已拿下/命中证据）与总分进度。**每次规划下一步之前先看这里**，按分值高低决定先打什么。",
  redteam_score_point_save: "新增或修改得分点（分值/名称/分类/说明/启用）。用户也会在界面上编辑；智能体只在必要时用（例如发现规则里还有未被记录的得分项）。带 id 为修改，不带 id 为新增。",
  redteam_score_report: "攻击得分链路复现报告：只收录\"拿到了分\"的成果（没得分的漏洞不进报告），每一项都尽量附上可直接粘贴进 Yakit Repeater 复现的原始请求。需要交付报告时用这个，而不是 redteam_report。",
  redteam_session_bind: "把一个**已经存在**的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。可用靶标 id 或单位名称，省略则列出可绑定的靶标。",
  redteam_session_check: "实测所有 WebShell 与隧道的连通性（由 host 侧真实发起 HTTP / TCP 连接），并把在线/离线状态回写数据库。开工前和长时间任务后各跑一次。",
  redteam_session_info: "查看**当前会话绑定的是哪个靶标**（会话 id、父会话、根会话、绑定链）。多会话同时开工时，先跑它确认自己没串到别人的靶标上。",
  redteam_sessions: "【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道（含监听地址与可达网段）、凭据、访问会话，并给出在线/离线统计。打内网前先看这里，不要重复造轮子，也不要忘记已有的隧道。",
  redteam_shot_add: "登记一张证据截图：把图片拷进靶标目录并关联到得分点/命中（面板展开得分点即可看图，报告里也会嵌入）。批量得分点（如终端权限）每个得分点最多展示 3 张代表图，不必逐台截图。",
  redteam_shot_delete: "删除一张证据截图（连同磁盘文件）。",
  redteam_shot_list: "列出已登记的证据截图（含所属得分点、目标、类型、落盘文件）。",
  redteam_tunnel_add: "登记一条内网隧道。**打进内网必须先用技能 suo5-tunnel 通过 WebShell/HTTP 建 socks5（kind=suo5）**；没有隧道就不要手搓内网探测脚本。listen 写本机可用地址（如 127.0.0.1:1080），reach 写它能到达的网段。登记后扫描器可直接 -socks5 <listen>。\n\n**红线：自己的 VPS / 自己配置的服务器不算隧道。** 只在你自己服务器上开的 socks5、frp 服务端、代理，没有碰到目标，**不算跨越靶标边界、不算边界突破或内网突破**（这类填 entry_kind=self-only，会被标成\"不算突破\"）。**必须说清目标侧的那一端**：\n· target-outbound — 目标主动连出到我方（**自己服务器收目标反弹 shell**、目标上跑 frp/Stowaway 客户端）；\n· target-http — 经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg）；\n· target-agent — 经目标已控进程/会话转发（SSH -R 由目标发起等）。",
  redteam_tunnel_list: "列出已登记的内网隧道（含状态、监听地址、可达网段、entry_kind 与 legit 判定）。**legit=false 表示只在自己 VPS/自建服务器上开的通道，不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind。",
  redteam_tunnel_update: "更新隧道状态（关闭/失效/更换监听地址）或补 entry_kind 判定。用完隧道务必标为 down 并说明，避免后续误用。**老记录没声明入口归属的（legit=null，界面显示\"待确认\"），用 entry_kind 补上目标侧那一端**，补完才算突破凭证。",
  redteam_vuln_add: "记录一条漏洞发现（漏洞检测角色）。带 cve 时按 (asset_id, cve, target) 幂等更新。severity：critical|high|medium|low|info；status：candidate（待验证）|confirmed（已验证）|false-positive|exploited|fixed。必须附证据（请求/响应片段、复现命令、证据文件路径）。",
  redteam_vuln_query: "检索漏洞库：按严重级、状态、CVE、资产、C 段或关键词过滤。用于挑选待利用目标或核对误报。",
  redteam_vuln_update: "更新漏洞状态/严重级/证据（例如验证后置为 confirmed、利用成功后置为 exploited、误报置为 false-positive）。",
  redteam_web_list: "列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。",
  redteam_webshell_add: "登记一个已上线的 WebShell。**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**——用户在控制台要用对应客户端直连，一句话马/自研马/MemShell 用户连不上，不算可交付的入口。shell_type 只能填 godzilla | behinder；确实只能用其它形式时填 other 并在 note 里写清为什么。同一 url+pass_key 重复登记会合并刷新。登记后所有角色智能体都能复用它，不要重复打点。",
  redteam_webshell_list: "列出已登记的 WebShell（含在线状态与最后检查时间）。",
  redteam_webshell_update: "更新 WebShell 状态（被删/掉线/权限变化）或补充说明。",
} as const;

/** description 的键集合。 */
export type DescribedToolName = keyof typeof TOOL_DESCRIPTIONS;