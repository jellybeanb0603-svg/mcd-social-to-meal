# 提交指南：麦麦种草落地

核对日期：**2026-10-15，北京时间**。这份文档指导你准备并提交项目；本地准备文件不表示已完成 GitHub 发布或赛事报名。

## 1. 先明确提交入口和材料

提交顺序：**发布自己的公开 GitHub 仓库 → 在大赛仓库提交报名 Issue → 查看系统回复。** 当前报名截止为 **2026-10-25 23:59（北京时间）**。要求与时间以 [官方说明](https://github.com/M-China/mcd-developer-innovation-challenge) 和 [完整活动规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md) 为准。

将下列材料放在你的仓库根目录，保留准确文件名：

| 文件 | 本项目内容 |
|---|---|
| `README.md` | 项目介绍、目标用户、运行方法和使用示例 |
| `CONTEST_DECLARATION.md` | 官方原文；文件名与内容保持不变 |
| `MCP_INTEGRATION.md` | 真实使用的麦当劳 MCP、Tool、流程和业务价值 |
| `mcp-config.example.json` | 脱敏配置，仅保留环境变量占位符 |
| 源码与可运行内容 | `SKILL.md`、`scripts/`、`web/`、`tests/`、合成案例等 |

`CONTEST_DECLARATION.md` 已于本次准备时与 [官方文件](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/CONTEST_DECLARATION.md) 比对一致。提交前请本人阅读声明和活动规则，确认符合其要求。只有真实使用 WorkBuddy 并申请相应专项奖励时，才提交真实导出的 `workbuddy.md`；本项目不生成或伪造该开发记录。

## 2. 生成可以上传的干净目录

不要直接上传当前整个工作目录。这里包含账号配置、第三方登录组件、真实笔记快照和近期截图。

在含 `SKILL.md` 的项目根目录运行：

```powershell
python scripts/package_submission.py --output-dir ../dist
```

默认输出：

```text
../dist/mcd-social-to-meal-submission-2026-10-15/       干净目录
../dist/mcd-social-to-meal-submission-2026-10-15.zip    传输用压缩包
```

干净目录打开后应直接看到 `README.md`、官方声明和其他必备文件。脚本只复制 `submission-files.txt` 中的公开文件，并打印文件数和 ZIP 的 SHA-256。已存在的同名输出不会被覆盖；重新生成时使用新名字，例如：

```powershell
python scripts/package_submission.py --output-dir ../dist --name mcd-social-to-meal-submission-2026-10-15-r2
```

打包后核对：

- 干净目录中没有 `private/`、`artifacts/`、`.env`、Cookie、DPAPI 数据、登录二维码、原始 MCP 响应或第三方运行依赖。
- `mcp-config.example.json` 中仍是占位符，而非真实 Token 或 Key。
- `demo/` 明确是合成数据；不要把它当作真实菜单或核价证据。
- 原有约10 MB的高清 HTML 和真实长截图没有被打入源码包。展示素材应单独整理、核对隐私与第三方内容后再发布。

`.gitignore` 只帮助 Git 忽略未跟踪文件，不会撤回已上传的内容；浏览器手动上传也不能依赖它自动过滤。因此请始终从生成的干净目录上传。

## 3. 从干净目录验证评委能看到什么

打开新终端，进入生成的干净目录，执行：

```powershell
python scripts/run_demo.py --budget-yuan 35
python -m unittest discover -s tests -p "test_*.py"
node --test tests/live_providers.test.mjs tests/meal_planner.test.mjs tests/meal_composer.test.mjs tests/meal_plan_service.test.mjs
```

先确认 `demo/index.html` 能正常打开，说明公开包有无需凭证的可运行内容。缺少 Node.js 时部分 Python 测试会跳过；一项私有真实笔记回归在公开包中也会按设计跳过。

真实网页目前仍依赖本人的 MCP 凭证、第三方登录服务与本机高德启动组件。README 已如实列出这些前置条件。正式演示真实链路时，请使用已经配置的开发机；如果希望评委在新机器直接复现三方网页，仍需进一步公开不含密钥的通用安装/启动方案，不能分享你自己的 `private/` 替代。

## 4. 发布你自己的 Public 仓库

1. 登录 GitHub，进入 [新建仓库](https://github.com/new)，建议名称 `mcd-social-to-meal`，可见性选择 **Public**。
2. 现有材料已经包含 README、`.gitignore` 和许可证，新仓库无需再自动生成重复文件。
3. 创建后使用 **Add file → Upload files**，上传干净目录里的全部内容，保留子目录结构。让 `README.md` 等必备文件直接位于仓库根目录，避免再套一层项目文件夹。
4. 检查待上传列表，再提交一次描述清楚的提交，例如 `Add McD Social-to-Meal skill`。
5. 退出登录或使用无痕窗口打开仓库地址，确认源码、必备文档和相对链接可读取。

GitHub 的文件上传流程见 [官方文档](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)，建仓库流程见 [官方文档](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)。发布后记录仓库地址，例如 `https://github.com/YOUR_GITHUB_USERNAME/mcd-social-to-meal`。

报名的“项目地址”应填写这个公开源码仓库地址。`127.0.0.1:8787` 只能在运行服务的电脑上使用，不能作为别人可访问的演示地址；ZIP、截图和静态 HTML 也不能替代公开源码仓库。

## 5. 发布报名 Issue

打开 [官方大赛 Issue 列表](https://github.com/M-China/mcd-developer-innovation-challenge/issues)，新建 Issue。标题可以使用：

```text
麦麦种草落地｜从小红书灵感到当前门店的完整一餐
```

正文按官方格式填写。先把下面的 `YOUR_GITHUB_USERNAME` 换成自己的用户名；如果仓库名不同，也同步修改地址，再复制到 Issue 正文：

```text
〖参赛申请〗
项目名称：麦麦种草落地
项目地址：https://github.com/YOUR_GITHUB_USERNAME/mcd-social-to-meal
项目简介：面向麦当劳消费者，联动小红书灵感、麦当劳当前门店菜单与官方核价、高德步行规划，按偏好和预算搭配主食、小食、饮料，最终生成一份可照着点的完整餐单，标明实际优惠、来源与系统补齐内容。
```

保留每个字段与内容在同一行；项目地址直接填写 URL，不套 Markdown 链接。提交后查看该 Issue 中的系统回复：成功通知表示报名受理；失败则依据回复修正并按官方指引重新申请。保存报名 Issue 链接，便于检查后续通知。[格式依据](https://github.com/M-China/mcd-developer-innovation-challenge#通过-issue-报名)

## 6. 可选的演示材料

建议准备一段60至90秒录屏，按以下顺序讲述；时长与录屏本身是本项目的展示建议：

| 画面 | 建议展示 |
|---|---|
| 用户问题 | “刷到想吃的，自己的门店到底能不能买、多少钱？” |
| 偏好与预算 | 顶部预算、城市、门店和个性化词条 |
| 真实核验 | 小红书正文灵感、本店菜单与规格、实际可用优惠 |
| 一份完整配餐 | 主食、小食、饮料和整餐官方试算；明确系统补齐 |
| 取餐 | 采用餐单、重新核价、复制清单与真实步行指引 |

录制前隐藏 Token、Key、登录二维码、Cookie、个人资料和不必要的第三方内容。若外部服务不可用，可演示合成案例并标明“离线演示”；真实演示中保留来源、查询时间和结果边界。

介绍作品时可强调“从外部灵感落到当前门店的完整一餐”。请按已实现能力介绍：当前没有自动下单、OCR、独立 LLM、官方营养核验或已确认的麦金卡身份，也不承诺最低价、整份原帖复刻或全网唯一。

## 7. 提交前最后核对

- [ ] 本人已阅读并确认符合官方活动规则、声明及第三方服务要求。
- [ ] 公开仓库根目录包含必备文件，官方声明未修改，源码可读取。
- [ ] 干净目录的合成演示与测试已实际验证。
- [ ] README 区分合成演示、真实本机联调和新机器复现前置条件。
- [ ] 公开内容与 Git 历史中没有真实凭证、账号数据或未核对的网页快照。
- [ ] 报名正文中的仓库地址已替换为本人实际地址，每个字段保持一行。
- [ ] 已保存报名 Issue 链接并检查系统回复；在截止前完成失败修正。

当前这一步完成的是文档和本地提交包准备。只有你公开仓库并完成报名、取得系统成功回复后，才能标为已报名。
