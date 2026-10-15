# 真实接入

项目不附任何账号凭证，不代替本人扫码登录第三方服务。可使用宿主已连接的MCP完成完整条件比较，或在当前Windows电脑运行真实手机网页；没有连接时可以先处理用户提供的内容，但不得称已完成实时核验。

## 当前Windows本机网页

在技能目录运行以下任一命令，需要Node.js 22+：

```powershell
node scripts/live_server.mjs
```

```powershell
.\scripts\start_live.ps1 -Port 8787
```

打开 `http://127.0.0.1:8787`。网页静态资源来自 `web/`，真实服务端适配器为 `scripts/live_providers.mjs`。不要直接打开 `web/index.html` 的 `file:` 地址；原有 `demo/index.html` 仍是独立合成演示，不会自动连接账号。

网页适配器优先使用 `MCD_MCP_TOKEN` 和 `XHS_MCP_AUTH_TOKEN` 环境变量中的本人凭证；未设置时才调用本机私有鉴权助手。当前开发机同时保留以下私有组件：

- 麦当劳：环境变量未设置时，`private/Read-McdHeaders.ps1` 读取当前Windows用户加密的凭证。
- 小红书：环境变量未设置时使用 `private/Read-XhsMcpHeaders.ps1`；网页固定连接 `http://127.0.0.1:18060/mcp`，要求可取得 Bearer 鉴权值并与服务配置匹配。账号需由本人扫码完成，服务会话失效时重新运行本机登录脚本。
- 高德：`private/Start-AmapMcp.cjs` 启动已安装的地图MCP，SDK及依赖位于 `private/amap-runtime/`。

这些私有组件并未打包进公开Skill。DPAPI加密数据绑定Windows用户；移到另一台电脑时，应重新配置本人凭证、小红书服务与高德启动组件。PowerShell运行时可通过 `POWERSHELL_BIN` 指定；适配器还会尝试开发工具自带运行时及系统运行时。不能把 `private/` 当成可分享的安装包。公开包可直接运行合成离线演示，尚不提供三方真实网页的一键通用安装方案。Python桥接器与网页适配器是不同接入路径，配置变量的适用范围需分别核对。

网页没有项目根级 `package.json`，不能通过在项目根执行 `npm install` 自动补齐上述私有组件。第三方小红书服务无鉴权的默认安装也不代表网页鉴权加载器已经配置完成。

服务默认只监听 `127.0.0.1`，也仅允许本机回环Host/Origin；当前没有LAN或公网模式。手机布局可在电脑浏览器的手机视口体验，手机不能通过电脑局域网IP访问。这样也避免把已登录账号服务暴露给同一网络的其他设备。

### 网页业务接口

浏览器先 `GET /api/status` 获得当前连接状态和本进程CSRF令牌。以下POST均需 `Content-Type: application/json` 与 `X-CSRF-Token`；请求体上限64KiB。服务只接受这些业务参数，不接受任意工具名、URL、HTTP头或命令。

| 接口 | 输入要点 | 实际数据 |
|---|---|---|
| `/api/location` | `city`、`location` | 高德地点坐标、解析地址与候选 |
| `/api/stores` | `city`、`location` | 麦当劳门店编号、地址、营业信息 |
| `/api/search` | `keyword` | 小红书搜索结果、原帖公开链接 |
| `/api/note` | 当前搜索返回的 `id` | 对应笔记正文；读取凭证留在服务端 |
| `/api/menu` | 已查询门店的 `storeCode` | 当前门店菜单与展示价 |
| `/api/item` | `storeCode`、`productCode`，用券餐品保留受控 `offerRef` | 当前餐品详情与套餐选项；权益与本店绑定 |
| `/api/quote` | `storeCode`、明确的 `items`，用券条目保留 `offerRef` | 官方应付、实际优惠、所用权益、实际选择和报价时间 |
| `/api/route` | `storeCode`、经纬度 `origin` | 官方地址经高德解析后的到店步行距离、用时和指引 |
| `/api/meal-plans` | `storeCode`、`intent`、`keyword`，可选 `budgetCents`、最多3个 `noteIds`，每次最多读取2篇 | 创建有时限的灵感解析、完整配餐与官方核价任务，返回随机 `jobId`；指定笔记必须仍在本次重新搜索结果中 |
| `GET /api/meal-plans/<jobId>` | 当前进程 `X-CSRF-Token` | 查询任务阶段、三类组成、灵感/补齐依据、可用权益与唯一完整配餐报价；未知或过期任务返回404 |

门店、菜单与笔记读取都有当前会话范围；不能从浏览器提交任意帖子读取凭证或未查询的门店。修改餐篮后重新核价。所有金额用整数分处理，菜单展示价不当作最终应付，失败不生成估算核价。

本餐预算在手机页面顶部填写，生成前作为可选 `budgetCents` 传入，表示主食、小食和饮料整餐的官方应付总预算。输入为整数分，0是有效预算，空值表示不按预算筛选。官方核价成功后，最终只推荐一份预算内完整配餐；没有预算内结果时，最多保留一份最接近预算的完整超预算参考，两者互斥。未完成核价、规格待确认、缺任一类组成或报价失效的方案不能作为预算内完整配餐采用。修改预算会使当前自动结果失效，需要重新生成，不通过重算标签沿用旧推荐。没有预算内结果时只说明本次有限候选中的结果，不删除一类组成、擅自减份或将原帖券后价作为官方金额。

菜单与详情最多缓存5分钟，核价按该窗口内读取的详情校验套餐选项并使用其默认特调；这段时间内的依据仍是详情快照。刷新菜单会清除详情缓存。遇到 `selection_stale` 表示所选配餐或选配轮次已经不在当前读取的详情中，应重新打开餐品、确认配餐与份数后再核价。菜单缓存过期或商品消失时，也需要先刷新当前门店菜单。

v0.5.0自动餐单任务读取最多2篇相关真实正文作为灵感，查询最多15份实际餐品详情，生成最多8份后台候选并发起最多6次官方核价，最终只展示一份完整一餐。解析器按当前菜单名称与明确别名读取灵感，配餐器从本店菜单及本人已有可用券对应商品中搭齐主食、小食和饮料。套餐的覆盖按实际选中规格核验，不能仅凭套餐名称或“薯条星人”词条把一份薯条作为整餐。笔记证据与系统补齐分别展示，不能冒充整份原帖复刻；门店默认值也不能称为原帖指定。歧义或未实现特调不能静默替换。小红书搜索或正文失败时，可继续从真实门店菜单补全并明确灵感缺失，不用合成笔记回退。

本人已有可用券在服务端查询并映射为不透明 `offerRef`。浏览器不持有原始券编码，仅在采用、修改规格和后续核价时保留该受控引用；引用必须仍属于本店当前查询上下文。返回的实际优惠以官方 `discount` 为准，不把查到券直接当作已生效，也不把优惠擅自归因于麦金卡。当前会员状态为 `unverified`，不假定有卡、不自动购卡。会员或随单购条件标价会标为条件价；例如菜单显示28元而当前官方核价57元时，以57元作为应付和预算依据。

120秒后任务停止新增工作，只从已完成的核价结果中选择一份完整配餐；没有符合条件的完整结果时明确说明暂无，不能把部分餐品当作一餐。未完成的接口可能仍在等待退出，此时不会叠加新的任务。相同输入的在途请求复用当前任务。结果只在当前进程内存最多保留15分钟，查询不会重新触发三方请求，也不会延长各份报价的最多300秒复核期限；重启服务后任务消失。

当前正文解析采用菜单约束的文字规则，不要求另配LLM密钥；没有OCR或任意自然语言理解能力。词条和正文只是灵感，笔记里的热量、优惠价、会员/日期/券条件不会因此成为官方已验证事实。跨笔记完整条件比较仍遵循下文的宿主规范化流程。手机端保持顶部预算、单份配餐卡、三类组成、官方应付与优惠、固定底部餐篮和大触控区。

高德返回真实步行数据，网页提供导航入口；当前没有嵌入地图底图。门店经纬度不可用时，服务把官方门店地址交给高德解析，并返回解析地址供用户核对，不以示例曲线冒充实际路径。

每个服务区独立显示来源和查询时间。页面连接检查通过不保证某家店有货或某篇笔记可读；查询超时、鉴权失效、必选套餐不完整和空结果需分别处理，不回退成演示数据。公开页面与复制清单不包含Cookie、账号鉴权头、帖子读取凭证或原始接口对象。

## 服务能力

- [麦当劳官方指南](https://github.com/M-China/mcd-mcp-server)：Streamable HTTP，端点 `https://mcp.mcd.cn`，凭证来自本地 `MCD_MCP_TOKEN`。
- [第三方小红书项目](https://github.com/xpzouying/xiaohongshu-mcp)：需要本人登录，默认本机端点 `http://127.0.0.1:18060/mcp`。搜索得到 feed_id 与 xsec_token 后读取对应详情，不假设能导出全部收藏夹。
- `mcp-config.example.json` 中的变量替换方式由客户端决定；它是脱敏示例，不是承诺所有客户端直接复制即可使用。如果小红书服务启用了鉴权，按服务配置添加环境变量引用；脚本读取 `XHS_MCP_AUTH_TOKEN`。

`XHS_MCP_URL` 可调整 Python 桥接器的小红书回环端点，不会改变当前网页适配器固定的18060端口。配置示例当前只列出麦当劳与小红书，未包含网页使用的高德私有 stdio 启动配置。

脚本只允许列出的查询/计价工具，不开放下单、取消、领券、兑换、抽奖、发布或评论。原始结果只能输出到技能目录的 `private/`。网页展示必要的餐品、来源与路线字段，不提供原始响应下载。

## 宿主桥接器检查

在项目目录运行：

```powershell
python scripts/mcp_bridge.py probe --server mcd --output private/mcd-tools.json
python scripts/mcp_bridge.py probe --server xiaohongshu --output private/xhs-tools.json
```

工具定义来自本次发现结果。没有 Token 会明确返回 not_configured；小红书服务未启动或账号未登录不能解释成“没有相关笔记”。`probe` 只发现工具，之后可调用 `check_login_status` 判断登录状态。

根据发现的 inputSchema 写入 `private/search-args.json`，通过 `search_feeds` 搜索。获取详情需要帖子ID和搜索结果对应的读取凭证。默认少量读取，不加载全部评论；信息不完整则标注来源范围。

```powershell
python scripts/mcp_bridge.py call --server xiaohongshu --tool search_feeds --arguments private/search-args.json --output private/search-result.json
```

获取所需菜单、套餐详情、可用券后，宿主按数据约定整理 `private/notes.json` 与 `private/catalog.json`。脚本不猜实际商品字段、套餐传参结构或金额路径。首先生成无报价报告：

```powershell
python scripts/compare_engine.py --notes private/notes.json --catalog private/catalog.json --budget-yuan 35 --output private/unquoted-report.json
```

## 报价关联

宿主把某篇已完整映射的餐篮转换成当前官方 schema 对应的参数，保存 `private/price-args.json`。必须核对商品编码、份数、每轮选件和上下文。然后关联该篇建议发起一次读取：

```powershell
python scripts/mcp_bridge.py call --server mcd --tool calculate-price --arguments private/price-args.json --binding-report private/unquoted-report.json --binding-catalog private/catalog.json --note-id source-1 --output private/price-capture.json
```

关联证明本地拟核价的餐篮和实际请求hash；它不能替代宿主核对实际参数与返回餐品。不要把不同餐篮的总价填给同一建议。

根据实际响应建立 `private/price-field-map.json`：

- `payload` 明确为 structured 或 text-json，后者必须指定 `text_index`。
- `success_checks` 非空，每项为实际业务字段的 JSON Pointer 与明确成功值 `equals`。
- `total_pointer` 为最终应付字段的 JSON Pointer；`total_unit` 为经核实的 yuan 或 cent，`currency` 为 CNY。
- 如果响应给出报价时间或到期时间，用 `quoted_at_pointer` / `expires_at_pointer` 明确映射带时区的ISO8601字段。不得丢掉提供方到期时间；没有报价时间字段时只使用本次捕获时间，不延长提供方期限。

没有核实业务成功值、最终金额或单位时停止，不将促销展示价、原价或模型估算值填为实付。

```powershell
python scripts/normalize_quote.py --capture private/price-capture.json --arguments private/price-args.json --field-map private/price-field-map.json --output private/quote-1.json
```

将独立报价合并成同一门店/上下文的报价文件，再运行比较与渲染。实时图文内容只存本地，不把账号资料或读取凭证加入公共分享。

## 客户端边界

受限桥接器处理标准初始化、版本协商、JSON/SSE结果、可选会话、工具分页及常用入参约束。它不是完整MCP SDK：不支持旧HTTP+SSE、stdio、异步任务、服务端向客户端请求和SSE断流恢复。断流或会话失效返回明确错误，不静默重放调用；可重新连接发现工具，确认当前输入后再发起新的只读调用。

普通JSON Schema初检不覆盖所有组合约束，最终以服务响应和实际业务状态为准。下单仍由宿主已连接的官方工具执行，必须经过当前具体内容及金额确认。
