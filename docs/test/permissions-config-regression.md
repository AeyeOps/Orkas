# 权限、配置与窗口状态模块人工回归 Case

## 评测设计要求

本模块的 case 必须同时覆盖三类目标，不能只验证当前实现：

1. **回归保护**：从代码分支、状态存储和 IPC 边界出发，防止已有安全逻辑被后续改动破坏。
2. **用户结果**：从用户看到的提示、授权范围和任务结束后的状态出发，验证产品行为符合文案承诺；任务级授权只能覆盖弹窗明确展示且允许任务授权的风险类别，不能跨用户、任务、Agent 或更高风险类别扩大范围。
3. **问题挖掘**：主动组合并发、乱序、损坏配置、进程/任务终止和账号切换等状态，寻找单条正常链路覆盖不到的问题。新增 case 应说明它试图推翻什么假设；没有发现问题时，也要复查输入组合和观察点是否足够敏感。

可有可无、与用户结果无关、只重复内部实现细节且不能提供独立故障定位价值的 case 应删除或合并。

## 自动化评测分层

- **单元/集成测试**：覆盖权限配置的默认值、迁移和损坏回退，危险操作分类，审批结果校验，逐命令与任务级授权，以及 pending 请求在并发、停止任务、任务完成和账号切换时的收敛。
- **E2E**: Exercise the three permission modes, single-use and task grants, renewed strict-category prompts, account-switch cancellation, and narrow-window key-fact display. Observe actual file effects and visible dialogs; IPC invocation alone is insufficient. Queued grant scope is additionally pinned at the Main and renderer boundaries.
- **Benchmark**：当前审批结果和授权生命周期由客户端确定性执行，不依赖模型判断，因此不为该逻辑设置模型 benchmark。若未来由模型决定风险分类、提示内容或自动授权建议，则必须增加 benchmark，评估危险操作召回、误报、越权建议和多轮作用域保持，不能用静态单测代替。
- **人工回归**：补充多语言、窄窗口、多显示器和系统权限等自动化环境难以稳定复现的体验检查。

### 工作区清理与审批可观测性场景矩阵

| 用户结果 | 关键起始状态/变体 | 独立失败信号 | 自动化层 |
| --- | --- | --- | --- |
| 显式、非递归的工作区文件可直接清理 | 审批模式；自产文件与预先存在文件；bash/PowerShell/interactive/process 三入口 | 路径可静态证明位于当前工作区时文件消失且不弹窗；不要求 conversation provenance | Main 集成 + Electron E2E |
| 删除选项不能吞掉真实目标路径 | `workspace_approval`；工作区外目标位于 `rm -f` / `Remove-Item -Force` 之后 | 在审批前返回范围错误；不弹窗；目标正文不变 | Main 集成 |
| 多个显式工作区文件按同一边界处理 | 一个自产文件与一个预先存在文件在同一非递归删除命令 | 两个文件都删除且不弹窗；不能因 provenance 不同产生部分执行 | Main 集成 |
| Unproven recursive or out-of-scope cleanup stays gated | Foreign content, changed files, missing/truncated ownership, symlinks, wildcard/dynamic input and sensitive targets | Denial preserves all bytes; only a bounded tree wholly recorded as new by the current runner can proceed | Main integration + deterministic native E2E |
| 可区分请求到达、弹窗呈现和最终结果 | renderer 分别处于前台、后台、隐藏；以及 mode 查询中取消、排队取消、已呈现取消 | 生命周期严格为 `requested → presented → result`；未呈现取消没有 `presented`；每个请求只有一个终态 | Renderer contract + Electron E2E |
| 埋点不能泄露确认内容 | 请求含命令、路径、request/cid/agent 标识、重复及未知 category | 三段事件只保留闭集 category、模式、可见性与耗时；序列化 payload 不含任何私有字段 | Renderer contract |
| 敏感确认可就地切换工具执行权限 | 默认审批模式；六类敏感操作；选择三档之一后允许、拒绝、持久化失败 | 弹窗始终显示三档快速切换；允许时先成功持久化再执行，拒绝不改档，持久化失败则不执行 | Renderer contract + Electron E2E + IPC persistence |
| 主机/全局包变更首次确认并可限定到本任务 | 三档权限模式；系统包管理器、用户/全局工具安装与项目内 npm/pnpm/yarn/bun/pip/uv/poetry/pipenv/cargo/go/bundler/composer/dotnet/swift 依赖对照；三个终端入口 | 只有跨出工作区、修改系统或用户工具链的命令出现 `system_package_change`；项目内依赖和 runner 不提示；选择“本任务内允许”后仅同一用户/任务/Agent 的该类别可继续 | Classifier accepted/rejected pair + Main integration + permission contract |
| 浏览任务不能静默终止用户进程 | 默认审批模式；Windows `taskkill`、PowerShell `Stop-Process`、POSIX `kill`/`pkill`/`killall`；同时保留 signal-zero、帮助、列表与 `-WhatIf` 反例 | 终止命令先出现 `destructive` 确认；拒绝后命令的后续 shell 段也未执行；只读探测不弹确认 | Classifier accepted/rejected pair + Main integration sentinel |
| 项目依赖和只读查询不能被误拦 | 项目内 install/add/remove/sync/lock/runner；原生包管理器 `search/show/list/info`；命令参数或输出文本含 `install` | 不出现系统/全局依赖变更确认；命令按其他既有权限规则执行 | Classifier accepted/rejected pair |
| Network approval follows action and payload | Literal npm metadata, Git HTTPS ls-remote, reviewed gh queries and curl GET/HEAD with no implicit config; contrast uploads, custom headers/config, dynamic values and shell pipelines | Proven ordinary queries execute once without a dialog; sensitive/unknown variants retain approval and denial prevents execution | Host admission + classifier pairs |
| Git cleanup preserves unmerged work | Non-forced local branch -d versus -D/force, tags, reset/clean and worktree/history rollback | Only the exact non-forced branch operation gains ordinary treatment; stronger operations remain gated | Host admission + classifier pairs |
| 安全边界弱化需确认且收紧权限不误报 | 默认审批模式；宽松 chmod、chown/chgrp/setfacl、关闭 TLS/主机校验、防火墙/Gatekeeper/SIP、PowerShell 执行策略/Defender 例外；同时覆盖 chmod +x、getfacl、防火墙状态/列表 | 弱化操作命中 `priv_esc`；拒绝后权限和安全设置不变；查询或不扩权操作不提示 | Classifier accepted/rejected pair + Main integration sentinel |
| 外部系统写入必须逐操作确认 | 直接 SQL 写入、SSH 远端服务/文件变更、上传、部署/发布命令，以及 `python deploy_apply.py` 等包装脚本；三档权限模式、三个终端入口 | 每条命中 `external_mutation`，弹窗列出识别出的操作类型/动作/目标和三档快速切换，操作授权只提供单次允许/拒绝；拒绝后本地 sentinel 不出现，远端操作未启动；之前的网络授权不能覆盖本次写入 | Classifier + script inspection + Main integration + permission contract |
| 启动外部应用必须确认 | macOS `open`、Linux `xdg-open`/`gio open`、PowerShell `Start-Process`；三档权限模式 | 命中 `external_mutation/external_launch` 并逐条确认；拒绝后应用、浏览器或文件关联程序未启动；帮助命令不提示 | Classifier accepted/rejected pair + Main integration |
| 外部只读操作不能被写入规则误拦 | `SELECT/SHOW/EXPLAIN`、SSH `status/tail/cat`、远端下载、`kubectl get`、`helm list`、`terraform plan`、`git push --dry-run`；注释/打印文本含写操作关键字 | 不命中 `external_mutation`；若命中其他既有类别，仅按该类别处理 | Classifier accepted/rejected pair |
| 解释器 heredoc 不能按 shell 正文误报 | Python/Node heredoc 中的 `open(...)`、箭头、比较及普通文本；同时保留 `requests.post`、DB execute 等真实外部写入反例 | 普通源码不因 macOS `open` 等 shell 规则弹窗；明确外部写 sink 仍命中 `external_mutation` | Main integration + script inspection |
| macOS 隐私目录可由用户显式选作工作区且不会被动触发权限弹窗 | 原生 picker 返回 Home、Documents/Desktop/Downloads/Pictures/Movies/Music/Library 的 exact/descendant 路径；符号链接别名；旧配置；模块重载模拟重启 | 选择持久化且恢复后仍为当前工作区；设置、chip 读取、启动清理和重启恢复对敏感根零 `stat/realpath/readdir/open/read`；递归文件扫描继续跳过；其它 picker 默认仍在 Orkas 自有目录 | Workspace unit negative probe + macOS platform-native + signed-package TCC canary |
| 切换目录后的工作区内命令不再误报 | 审批模式；Windows `cd "<项目>"; ...`、`Set-Location -LiteralPath`；随后删除自产文件、列目录；cd 失败时的原目录 | 两种可能的当前目录都在工作区内时不弹窗；相对路径不再一律记为“执行前无法确定” | Main 集成 |
| 每种切换目录的写法都纳入路径检查 | `Set-Location/sl/pushd/Push-Location/cd` 切到工作区外后删除相对路径；块内或括号内切换（PowerShell `(Set-Location x)`、POSIX `(cd x && rm y)`）、调用会切目录的脚本（`& x.ps1`、`source x.sh`，含同一命令先写出的脚本）、重定义 cd、provider 路径（`HKCU:`）、popd；POSIX `pushd` | 删除前均确认；拒绝后工作区外与工作区内同名文件内容都不变；不切目录的构建脚本和 venv `activate` 之后的相对路径不弹窗 | Main 集成 + 真实 PowerShell 7 语义核对 |
| 个人目录读取按文件夹授权 | Desktop/Documents/Downloads 内同一文件夹多次读取；子目录、兄弟目录、前缀相似目录、`.env`/密钥、指向密钥的链接、其他 Agent/会话、任务取消 | 首次读取的主按钮为“允许读取此文件夹”；授权后同文件夹（含子目录）读取不再询问；其余情形仍询问；“允许一次”不授予文件夹 | Main 单元/集成 + Renderer contract |
| 文件读取权限拒绝不能伪报为文件不存在 | `read_files` 的首次 `stat` 分别注入 `EACCES`、`EPERM`，并以真实 `ENOENT` 作反例 | 前两者返回 `E_PERMISSION_DENIED` 且保留 `os_code`，不扫描父目录、不输出缺失文件恢复指引；`ENOENT/ENOTDIR` 才返回 `E_NOT_FOUND` | File-tools unit fault injection + signed-package denial canary |

Windows 的 PowerShell 原生命令形态由同一 E2E 使用平台分支执行；发布前仍需在 Windows runner 跑该 case。多显示器遮挡、系统级置顶窗口覆盖等感知问题保留为人工回归，因为 DOM 呈现与窗口 focus 不能证明用户视线实际到达。

本轮问题挖掘曾发现：

- 2026-10-07（需求方确认修复 10-03 尝鲜用户审批问题）：路径检查只把 `cd` 当作切换目录，Windows 上 `Set-Location`/`sl`/`pushd`/`Push-Location` 和 POSIX `pushd` 之后的相对路径仍按原目录解析，`Set-Location <工作区外>; Remove-Item x` 会被当成删除工作区文件而不确认。现在这些写法与 `cd` 一样保留成功和失败两种目录，`popd`、块内切换、被重定义的 cd 和 provider 路径记为未知目录。同时 PowerShell 的 `cd` 不再让后续相对路径一律“无法确定”：VideoStudio 每条命令都以 `cd "<项目>";` 开头，此前每条都只能单次允许（09-22 抖音用户等待 26 分钟和 7 分钟）。`-ErrorAction SilentlyContinue` 等大小写不同的公共参数值也不再被当成删除目标。
- 2026-10-07 真实场景复核（PowerShell 7.6 实际执行 + macOS 真实执行，29 个场景）又发现两处同类绕过：POSIX 子 shell `(cd <外部> && rm -f x)` 与 PowerShell 分组 `(Set-Location <外部>)` 中的切换没被识别（路径检查不拆括号，删除目标还被读成 `x)`）；PowerShell 用 `&` 调用的脚本与调用方共用位置，脚本里的 `Set-Location` 会让后续 `Remove-Item x` 删到外部。改前这些场景都不弹窗并真实删除了外部文件。
- 2026-10-07：仅因位于 Desktop/Documents/Downloads 等个人目录而敏感的读取，主按钮改为“允许读取此文件夹”，授权限于同一用户/任务/Agent、只读，并按真实路径判断，链接不能把授权带出文件夹；`.env`、密钥等内在敏感文件仍逐次确认。09-21 有用户为两个桌面文件夹里的图片逐张允许了 58 次。
- Requester-approved on 2026-09-24: an explicit task grant settles already queued requests only for the same user/task/Agent and covered categories. Unknown targets, `priv_esc`, `external_mutation`, new categories and other actors stay pending. Cancellation, account switching, task completion and restart revoke grants.
- 单元测试一直用非空 `agentId`，但真实顶层 Commander 在线路上使用空 `agent_id`；主进程因此把真实请求判为不支持任务授权，按钮在 E2E 中消失。现在仅把已知 Commander 名称映射到内部稳定 actor key，未知匿名 actor 仍不支持任务授权。VideoStudio 的相似截图不是同一原因：其真实群聊链路会传入稳定 ID `79df9cc89f5f`，按钮缺失来自 Python heredoc 的 `open(p)` 被误判成 macOS `open`，从而落入只允许一次的 `external_mutation`。真实 Electron E2E 分别覆盖 Commander 与 VideoStudio 的任务授权，Main 集成测试用截图命令锁定 heredoc 不误报，并保留源码真实外部写入的反例。
- 主进程没有可用窗口时，广播函数不会把审批请求送达，但权限层曾把它当作发送成功；bash 会一直等待，connector 调用会等待到十分钟超时。现在广播必须返回真实送达状态，bash 和 connector 权限请求在无人可确认时立即拒绝并清除 pending 状态。
- The UI produced-path set includes modified old files and cannot prove recursive-cleanup ownership. Explicit non-recursive workspace deletions retain their existing ordinary boundary. Recursive cleanup instead uses bounded per-runner creation and current-file evidence, with foreign/changed/link/oversized entries restoring confirmation.
- 通用 mutation 参数解析把 `rm -f <path>` 的 `-f` 错当成带值选项，从而吞掉真实目标，令工作区和敏感路径门禁无法检查该路径。删除命令现在使用命令级参数规则；回归 case 同时验证审批前拒绝与磁盘内容保持不变，避免只检查错误码而漏掉真实副作用。
- 旧埋点只记录用户选择送达 main 的结果，无法区分 renderer 收到请求与弹窗真正挂载。现在 `requested → presented → result` 三段漏斗分别记录请求到达、DOM 呈现和最终响应/取消；只包含有界风险类别、模式、可见性及耗时，不包含命令、路径、请求/会话/Agent 标识。
- 把项目内 npm/pnpm/yarn/bun、Python/uv/poetry、Rust/Go、Ruby/PHP/.NET/Swift 的 install/add/remove/sync/lock/runner 全部归为 `system_package_change`，会让常规构建与视频制作反复进入敏感确认，且类别名称与实际边界不一致。现在该类只覆盖原生系统包管理器，以及明确写入用户/全局工具链的 npm `-g`、pip `--user`、pipx、uv tool/python、cargo/go/gem、composer global、dotnet tool global、corepack 等操作；项目内依赖变更用成对反例保证不命中。
- 工作区选择只按字符串判断受保护根目录时，工作区外的符号链接可以把 Desktop/Downloads 等目录伪装成普通工程目录。现在显式选择会解析真实路径并持久化正向 TCC 分类，旧配置只做一次兼容分类；路径仍保留用户原始写法用于显示。被分类的工作区可以执行用户任务，但设置、启动恢复和 UI 展示不再探测该目录，递归搜索/文件面板扫描继续跳过；macOS `/var` 与 `/private/var` 等价路径也归一比较，防止修复引入路径漂移和后台权限弹窗。
- Shell network, Git rollback, security weakening and external launch classification remains the conservative baseline. The Host can subtract a shipped reason only with the literal operation, scope and ownership/content evidence specified in the ordinary-operation matrix below; explicit custom policies still apply.
- 海外生产样本中，浏览任务为恢复卡住的会话调用 `taskkill /F /IM chrome.exe`，随后用户报告两天预热的浏览器配置被重建。原分类器只覆盖文件/磁盘删除，不识别进程终止；现在 Windows `taskkill`、PowerShell `Stop-Process` 与 POSIX `kill`/`pkill`/`killall` 统一归为 `destructive`，默认审批模式会在执行前确认。Signal-zero 探测、帮助/信号列表、进程列表和 PowerShell `-WhatIf` 保持只读。
- 海外生产样本中，用户先允许 SSH 网络操作，Agent 随后通过 `python deploy_apply.py` 内部的 Paramiko/数据库命令直接修改生产数据；旧权限层只看见 Python 入口，且任务级 `network_egress` 授权会覆盖后续 SSH。现在明确的数据库写入、远端文件/服务变更、部署、外部 API 写请求和远端发布统一归为 `external_mutation`，即使“完全信任”模式也逐命令确认；直接命令按结构识别，512 KiB 以内的 Python/Node/Shell/PowerShell 等入口脚本会检查具体写入 sink。只读 SQL、远端状态/日志查询、下载、plan/list/get、dry-run 与注释/打印文本保持反例。

现有 Electron E2E 验证窗口存在时从真实弹窗、三段埋点到文件结果的完整链路，并验证同一真实对话先创建产物再直接清理时不会出现弹窗；“没有可用窗口”的进程边界由 IPC 集成测试覆盖，因为关闭最后一个 Electron 窗口后测试页本身无法继续观察结果。

## Connector operation permissions

Connector actions use the same account-level mode, independently of the external
CLI's native permission level. Connector authorization, visibility, and supported
action limits remain prerequisites; Trusted does not expose prohibited actions.

| User journey | Expected result |
| --- | --- |
| Read Gmail messages or save a draft in Cautious or Standard | Execute once without a permission dialog. |
| Send mail, publish, pay, change permissions, or delete in Cautious or Standard | Show one exact-action confirmation. Denial or cancellation prevents execution. |
| Run the same available actions in Trusted | Execute without confirmation, including from an external CLI. |
| Use an unclassified or custom-server action | Confirm in Cautious and Standard; no confirmation in Trusted. |
| Set the CLI to Full access while operation permissions are Standard | Sensitive connector actions still use the connector confirmation; native CLI settings do not grant connector approval. |
| Approve a connector action and then run a native CLI operation | The connector approval does not grant native CLI permission or approve subsequent connector actions. |
| Cancel the task or switch accounts while waiting; request approval with no available window | Withdraw or reject the action; a late click cannot execute it. |
| Let an approval expire, then retry | Stop waiting progress, reject the expired response, and require a fresh decision for the retry. |
| Cancel one of two tasks waiting for approval | Cancel only that task; the other request remains independently answerable. |
| Change operation permissions while the CLI process stays open | The next call uses the current setting without restarting the CLI. |
| Load a stale cached prohibited tool or invoke it directly in Trusted | Keep it out of the visible tools and reject before connecting to or calling the provider. |

Verify with an isolated account and stubbed connector transport. The CLI bridge
stdio journey must preserve cancellation and waiting progress. The local-shell
exceptions described below do not apply to connector action confirmation.

## 准备

1. 准备干净数据目录和已有配置的数据目录各一份。
2. 准备中文、英文、日文三种语言环境。
3. 准备需要写文件、改文件、删除文件、运行 shell、生成 PDF/图片/交互应用的真实任务。
4. 准备只读任务，例如读取附件、搜索工作区文件、查看资料库内容。

## 权限范围

当前权限模块是设置页里的“工具执行权限”（`localExec`）持久模式，默认模式是 `all_files_approval`（常规）。该模式存储在 `<uid>/cloud/config/permissions.json`，随账号云端同步；旧版 `<uid>/local/config/permissions.json` 会在首次读取时迁移到云端配置。

`localExec` 有三档：

- `workspace_approval`：仅访问工作区和本对话附件内的文件；敏感操作需要用户确认。
- `all_files_approval`：可以访问工作区外文件；敏感操作需要用户确认。
- `all_files_auto`：可以访问工作区外文件；一般敏感操作无需确认，但系统包和用户/全局工具链变更仍需首次确认（可在本任务内允许），明确的外部系统写入及外部应用启动仍逐条确认。

敏感操作规则由客户端默认列表和服务端 `local_access.sensitive_policy` 共同决定，保留网络访问、危险删除/回滚、提权或安全边界弱化、敏感目录/文件、系统/全局工具链变更、外部系统变更/应用启动六个分类标签；标签数量不是限制强度，实际匹配范围已收窄，项目内依赖与 runner 不再属于 `system_package_change`，显式非递归的工作区文件清理也不再进入 `destructive` 确认。进入确认链路后，`network_egress`、`destructive`、`sensitive_path`、`system_package_change` 可由用户选择“本任务内允许”；授权只存在内存中，并限定到同一用户、任务、Agent 与已确认类别。`priv_esc` 和 `external_mutation` 始终只允许当前命令；混合命中这些更严格类别时也不能任务级授权。`system_package_change` 和 `external_mutation` 还是不可被旧服务端配置关闭、在 `all_files_auto` 下仍生效的客户端安全底线：前者只覆盖系统包和用户/全局工具链，后者覆盖数据库/远端/部署/API/发布写入及外部应用启动。只读查询、项目依赖、dry-run、帮助/版本命令以及不扩权的权限操作作为反例保持不命中对应变更规则。文件夹授权机制已移除，工作区外访问只由上述三档控制；macOS TCC 隐私根目录只有在用户通过原生 picker 显式选择后才作为工作区使用，被动 UI/启动路径不会探测它，递归扫描仍跳过。结构化 `delete_file` 和可静态证明的显式、非递归 bash/PowerShell 删除可直接清理工作区文件；工作区外、递归、动态或内在敏感目标仍按更强边界处理。

受此开关控制的能力：

- 运行终端命令：`bash`
- 创建、修改、删除工作区文件：`write_file`、`edit_file`、`delete_file`
- 生成本地产物：`create_artifact`、`create_pdf`、`generate_image`

只读检索类能力仍按当前可见范围执行：

- 只读工具：`read_file`、`stat_file`、`search_files`、`grep_files`
- 资料库读取和检索
- 网络请求、模型调用、搜索服务
- 连接器 OAuth scope 和服务端授权
- 麦克风、剪贴板等系统级权限

## 工具执行权限

1. 干净数据目录首次启动时，“工具执行权限”应默认 `all_files_approval`。
2. `permissions.json` 缺失、字段缺失、字段类型异常或 JSON 损坏时，应 fallback 为 `all_files_approval`，不应白屏或阻断启动，也不应静默退到 `all_files_auto`。
3. 旧版本地 `local/config/permissions.json` 存在且云端文件缺失时，应迁移到 `cloud/config/permissions.json`，并触发同步 dirty 标记。
4. 旧版 `allow_all` 应迁移为 `all_files_auto`；旧版 `risk_prompt` / `granted:true` 应迁移为 `all_files_approval`；旧版 `off` / `granted:false` 应迁移为 `workspace_approval`。
5. 修改执行模式后，应写入云端配置并在多设备同步后生效。
6. `workspace_approval` 下，工作区外显式读写路径应被拒绝，结果不应泄露文件内容。
7. `all_files_approval` 下，工作区外普通路径应允许；敏感路径和敏感 bash 命令应弹确认。
8. `all_files_auto` 下，工作区外路径和一般敏感操作不应弹确认；系统包及用户/全局工具链安装、升级、卸载仍需首次确认并可显示“本次任务内允许”；项目内依赖变更不因 `system_package_change` 提示；明确的数据库/远端/部署/API/发布写操作及外部应用启动必须逐条确认。敏感弹窗可以快速切换并持久化权限档位，但档位变化不能替代这些类别按既有授权粒度要求的操作确认。
9. `delete_file` 删除工作区内文件，以及 bash/PowerShell 以显式、非递归命令删除可静态证明位于当前工作区的文件时，应直接执行，不以 conversation provenance 区分自产/预存文件。工作区外、递归、通配符、变量、管道输入和内在敏感目标仍按范围与敏感规则处理；取消确认时不得删除任何目标。
10. 设置页三档权限在窄窗口和多语言下不应遮挡关键按钮，文案不应溢出。
11. `all_files_approval` / `all_files_auto` 下，`cat`、`grep`、`rg`、无 mutation action 的 `find` 可读取只读保护目录；重定向写入、`find -delete/-exec`、解释器脚本等不能被证明只读的命令仍应返回 `E_PROTECTED_PATH_READ_ONLY`。`workspace_approval` 仍按可见范围拒绝工作区外读取，不应把读取误报成写入。
12. 没有存活 renderer 窗口或广播通道已损坏时，敏感 bash 和 connector 操作必须立即 fail closed；不能把“零接收者”当成已送达，也不能留下无法回答的 pending 请求直到超时。
13. bash 审批每个真实请求应至多产生一条 `event_bash_risk_prompt_requested` 和一条实际挂载后的 `event_bash_risk_prompt_presented`，最终用户选择、IPC 失败、stale 或任务取消应各自收敛为一条 `event_bash_risk_prompt_result`。排队中取消不得虚报 presented；任何事件均不得包含命令、路径、subject、request id、conversation id 或 Agent 身份。
14. Windows `winget/choco/scoop`，macOS `brew`，Linux/BSD 的 apt/dnf/yum/apk/pacman/zypper/pkg/snap/flatpak，以及明确用户/全局工具链变更应命中 `system_package_change`；PowerShell/cmd 包装不能绕过。项目内 npm/pnpm/yarn/bun/pip/uv/poetry/pipenv/cargo/go/bundler/composer/dotnet/swift install/add/remove/sync/lock/runner，以及 `search/show/list/info/why/check/metadata` 必须作为成对反例保持不命中。
15. All sensitive dialogs offer the existing three permission modes. Allowing after a mode change persists it first; denial does not change it, and persistence failure prevents execution. Task grants cover only the same user/task/Agent and confirmed grantable categories, including eligible queued requests. Unknown targets and requests containing `priv_esc` or `external_mutation` have no task option; legacy `allow_run` responses downgrade to `allow_once`. Denial prevents execution at all three terminal entry points.
16. 默认审批模式下，`taskkill`、`Stop-Process`、`kill`、`pkill` 和 `killall` 等真实进程终止命令必须命中 `destructive`；用户拒绝后整条 shell 命令均不执行。Signal-zero 探测、帮助/版本/信号列表、`tasklist`/`Get-Process` 和 `Stop-Process -WhatIf` 不应误报。
17. `mysql/psql/sqlcmd` 明确写 SQL，SSH 中的远端文件/服务变更，`scp/rsync` 远端目标，HTTP 写方法，`kubectl/helm/terraform` 变更，`git/npm/docker` 发布等必须命中 `external_mutation`。直接执行的 512 KiB 以内脚本若通过明确的 DB execute、Paramiko exec/upload 或 HTTP 写 sink 修改外部系统，也必须在脚本启动前确认；拒绝后不得执行脚本。该类别在三档模式和 bash/interactive_cli/process_session 三个入口均只允许当前命令，旧客户端回传 `allow_run` 必须降级。`SELECT/SHOW/EXPLAIN`、SSH 状态/日志读取、远端下载、get/list/plan/dry-run、注释和打印文本必须作为反例保持不命中。
18. 默认审批模式下，curl/wget/IWR/IRM、Git/gh 的远端访问、Docker pull/login、npm 元数据和 pip download 等实际网络请求必须命中 `network_egress`；`--help/--version` 不应误报。网络写入、发布或远端变更可同时命中 `external_mutation`，确认展示必须保留最严格的逐命令粒度。
19. 默认审批模式下，`git reset --hard`、非 dry-run `git clean`、覆盖工作区的 checkout/restore、branch/tag 删除、stash clear/drop、reflog expire/delete 与 prune 应命中 `destructive`。`git diff/status/branch --list`、`git clean --dry-run`、仅 `git restore --staged` 不应误报。
20. 默认审批模式下，扩大组/其他用户写权限或设置特殊位的 chmod、chown/chgrp/setfacl、关闭 TLS/SSH 主机校验、防火墙、Gatekeeper/SIP/执行策略/Defender 边界应命中 `priv_esc`。`chmod +x`、`getfacl`、防火墙 status/list 与安全收紧操作不应误报。
21. macOS `open`、Linux `xdg-open`/`gio open`、PowerShell `Start-Process` 的真实目标启动应命中 `external_mutation` 并提供 `external_launch` 结构化详情；帮助命令不命中。该类在 `all_files_auto` 下仍逐条确认，拒绝后不得启动目标应用。
22. Python/Node 等非 shell heredoc 正文必须按源码处理；普通文件读取中的 `open(...)` 不能被解释成 macOS 外部应用启动，源码中的 shell 关键字文本也不能触发对应 shell 规则。源码包含明确 DB/HTTP/远端写 sink 时仍须在解释器启动前命中 `external_mutation`。
23. macOS 的 Home、Documents/Desktop/Downloads/Pictures/Movies/Music/Library 及其后代可由用户通过原生 picker 显式选作工作区。`workspace.set` 必须持久化正向 TCC 分类；设置后的 `getWorkspacePath/getWorkspaceInfo/consumePickerFirstOpenDefault/sweepEmptyConvDirs` 以及模块重载后的首次读取都不得对整个敏感根调用 `stat/realpath/readdir/open/read`。自动化 case 必须用真实同步 `stat`、原生 `realpath` 和异步 `stat` 作为负对照，证明探针能捕获回归。符号链接、路径大小写和 `/var`/`/private/var` 别名必须得到同一分类；旧配置迁移后只分类一次。`search_files/grep_files` 和会话文件面板继续跳过递归扫描；其它原生 picker 的默认位置不得进入 TCC 根目录。
24. `read_files` 对 `ENOENT/ENOTDIR`、`EACCES/EPERM` 和其它 OS 错误必须分类。只有缺失文件才扫描同目录的 uniquified sibling 并返回 `E_NOT_FOUND`；权限拒绝必须返回 `E_PERMISSION_DENIED` 和原始 `os_code`，不得声称已确认为 TCC，也不得通过 sibling 扫描发起第二次目录访问。

25. 切换目录的所有形态（POSIX `cd/pushd`，PowerShell `cd/chdir/sl/Set-Location/pushd/Push-Location`）都必须改变后续相对路径的检查目录，并保留切换失败时的原目录；`popd`/`Pop-Location`、块、括号或关键字之后的切换、被函数/别名重定义的切换、provider 路径，以及在当前 shell 里运行且可能切目录的脚本（PowerShell `& x.ps1`/`. x.ps1`/`iex`，POSIX `source`/`.`/`eval`；脚本不可读、过大或被同一命令另行引用时同样处理）必须视为未知目录；不存在的脚本无法运行，不改变目录。工作区内的 `cd "<项目>"; Remove-Item <自产文件>`、列目录不应弹窗；切到工作区外再删除必须确认，拒绝后两处同名文件均不变。
26. 仅因个人目录位置而敏感的读取可授予“允许读取此文件夹”：同一用户/任务/Agent 内该文件夹（含子目录）的后续读取与排队读取不再询问；兄弟目录、前缀相似目录、`.env`/密钥等内在敏感文件、解析后离开该文件夹的链接、写入和删除仍按原规则确认；“允许一次”不授予文件夹；取消任务和切换账号撤销授权。

### macOS 签名包 TCC 弹窗 Canary

发布结论只由专用 macOS QA 账号和正式签名的 DMG/ZIP 安装包给出，不进入通用 CI。开发 Electron 进程的身份不是 `com.orkas.desktop`，无法证明正式 App 的 TCC 行为；系统弹窗也不属于 renderer DOM。普通开发机若要预检弹窗链路，必须复制当前签名构建并改成独立 QA Bundle ID 后重新签名，只改 `CFBundleIdentifier/CFBundleDisplayName`，保留 `CFBundleName=Orkas`，再安装到 `~/Applications`。不要 reset 正式 `com.orkas.desktop` 的 `SystemPolicyAllFiles`；已有“完全磁盘访问”会覆盖单独的 Documents reset，此时应使用隔离 Bundle ID，不能据“读取成功且无弹窗”判定 Canary 通过。

执行前退出目标 App，并只重置该 Bundle ID 的目录权限决策：

```bash
tccutil reset SystemPolicyDocumentsFolder com.orkas.desktop
tccutil reset SystemPolicyDownloadsFolder com.orkas.desktop
tccutil reset SystemPolicyDesktopFolder com.orkas.desktop
```

若当前 macOS 不接受某个 service 名称，停止该轮并在“系统设置 → 隐私与安全性 → 文件与文件夹”确认测试机状态；不要改用影响其它 App 的全局 reset。随后录屏并记录每个阶段的系统权限弹窗数量：

App 必须通过 Finder/LaunchServices 启动；不能由 Codex、终端或 Playwright 直接作为子进程启动，否则 TCC 日志中的 `responsible` 可能归到父进程并继承其授权。触发真实读取时同时观察 `tccd` 日志：`AUTHREQ_ATTRIBUTION` 的 `responsible/accessing` 必须是目标 Bundle ID；出现系统弹窗时还必须看到 `AUTHREQ_PROMPTING` 且 service 为 `kTCCServiceSystemPolicyDocumentsFolder`。读取 Promise 在用户选择前应保持 pending。仅看到 `EACCES/EPERM` 不能反推一定发生过 TCC 弹窗；只有用户明确选择“不允许”后，才继续断言业务错误映射。

1. 启动签名包，通过工作区原生 picker 选择预先创建的 `~/Documents/Orkas-TCC-Canary`。选择成功且 chip 显示该目录；从打开 picker 到设置完成弹窗数必须为 0。
2. 保持应用空闲 30 秒，依次进入新对话、已有对话、项目页和设置页，再退出并重启一次。该阶段弹窗数必须为 0；工作区仍为所选目录。
3. 点击“打开工作区”，Finder 必须直接打开所选目录，该阶段弹窗数必须为 0。自动化单元 case 同时保证 Orkas 在 `shell.openPath` 前不对目标发起 `stat/realpath/readdir/open/read`。
4. 使用内置 `list_files/read_files` 列出目录，再执行一个明确写入当前工作区的任务，例如创建 `tcc-canary-1.txt`。原生 picker 已表达用户意图，该阶段新增弹窗数必须为 0；目录列表正确且文件存在。
5. 连续执行读取该文件、创建 `tcc-canary-2.txt`、再次退出重启并读取两个文件。该阶段新增弹窗数必须为 0，两个文件结果正确。
6. 强制拒绝/恢复变体：退出 Orkas，保留工作区配置，仅 reset `SystemPolicyDocumentsFolder` 对应的 Bundle ID 决策。必须记录 `tccutil` 成功、重新启动后的目标进程归属，以及首次真实访问对应的 `AUTHREQ_PROMPTING`；三者缺一不能声称已验证强制 reset。重启后先空闲和切换 UI，弹窗数必须为 0；再首次用内置 `read_files` 读取已存在的 `tcc-canary-1.txt`。若 macOS 弹窗，记录它仅出现在这次真实访问，并选择“不允许”；工具必须返回 `E_PERMISSION_DENIED` 及 `EACCES` 或 `EPERM` 的 `os_code`，不得返回 `E_NOT_FOUND` 或进行 sibling 恢复扫描，后续空闲和 UI 切换不能循环弹窗。随后在系统设置中重新允许，或通过原生 picker 重选该目录，重试必须成功，之后新增弹窗数为 0。

Canary 结果必须记录签名包版本、macOS 版本、处理器架构、每阶段弹窗数、内置工具名、拒绝时的业务错误码/OS 错误码和系统设置中的最终 Files & Folders 状态。通过标准是“原生选择/空闲/打开 Finder/正常读写/重启零弹窗；强制 reset 后只有首次真实访问允许至多一次；拒绝不误报为文件不存在；恢复授权后零重复弹窗”。只报告最终文件存在而不记录弹窗阶段与次数不算通过。

## 配置与组件开关

1. 修改模型、语言、同步、连接器、组件开关后，相关 UI 应立即刷新，并在重启后保持。
2. 配置文件损坏、字段缺失或版本升级时，应有合理 fallback，不应白屏。
3. 会员或服务端配置变化后，受控入口应正确启用/禁用并显示引导。
4. 手动刷新客户端配置、切换自动更新、切换反思和打开数据目录时，每次操作只上报一条对应的 `*_result`；失败时再配对一条低基数 `error_*`，不得把原始异常或完整本地路径放入埋点。

## 窗口与启动状态

1. 调整窗口大小、侧边栏宽度、打开设置/项目/对话后重启，窗口状态和关键 UI 应恢复合理。
2. 多显示器、最小化、后台恢复后，主窗口不应丢失或超出屏幕。
3. 首次启动、升级启动和异常退出后重启，应能进入可用状态。

## 日志与安全

1. 日志应能定位配置 key、组件名、权限类型、窗口状态变化和错误摘要。
2. 日志不能输出模型 key、token、Cookie、完整本地路径、用户邮箱或手机号。

## 加载与权限边界

1. Commander 的 `tool_load` 只改变 Schema 激活面，不授予 local-exec；相同分组在 Cautious、Standard、Trusted 下仍走原确认和拒绝规则。Agent、Worker 与编辑器不提供该工具。
2. Owner、只读根、工作区范围、敏感命令和系统包确认必须在加载后继续 fail closed；未激活错误与权限拒绝错误不得混为一类。
3. 切换 `legacy|scoped` 只影响工具暴露策略，不修改用户权限配置，也不应同步成权限档位变化。

### 2026-09-24 approval precision and decision facts

- Paired cases distinguish printed command words, local copies, owner-only chmod,
  Git help/log arguments and PowerShell WhatIf from actual sensitive counterparts.
  Custom server regexes retain their explicit policy semantics.
- `New-Item` and pure literal `Join-Path` run through real Host gates in both
  `bash` and `process_session.start`: workspace targets proceed, known outside
  writes fail, and computed/provider/drive-relative targets ask once. Executors
  are stubbed for cross-platform syntax cases; native Windows remains a separate
  smoke requirement.
- Unknown targets display their operation, expression, working directory and
  uncertainty. Important tail operations survive long command prefixes; the raw
  preview stays at 800 characters. Facts are escaped, bounded, localized, and
  excluded from telemetry. Electron checks the collapsed preview and reachable
  controls at 760 × 600; Main/renderer cases cover scoped queued approvals.
- Browser labels pair Facebook/Bookmarks/Payroll/Post history navigation with
  Book now/Post comment/Delete post history actions. The same classifier serves
  observation and execution, and real sensitive actions remain guarded.

### Ordinary-operation evidence matrix (2026-09-24)

| User outcome | Accepted evidence | Negative control / recovery | Owner |
| --- | --- | --- | --- |
| Query metadata without repeated confirmation | Exact read command and supported literal flags; curl has no default config or starts with --disable | Upload/body/auth/config, compound shell and query interpolation still ask | ordinary-shell-operations + local-tools |
| Install project tooling | Explicit writable in-scope Conda prefix / Cargo root | Global/base/named or escaped targets retain approval | Host local-tools |
| Preview a produced document | Produced-file record plus PDF/PNG/JPEG signature, regular non-executable file, default viewer and allowed scope | URL/app flags, unknown file or disguised executable still ask | Host local-tools |
| Clean generated directories | New-by-complete-parent-listing snapshot; every current descendant has matching ownership/version; <=512 entries/depth 32 | Modified old files, foreign children, links, replacement and incomplete scans retain approval; refusal preserves inputs | Host integration + bash-permission-model_e2e native deterministic journeys |
| Read public material | Parsed public PEM/OpenSSH record or entirely empty/placeholder dotenv template | Private/mixed content, populated template, writes and custom secret policy stay sensitive | local_access_policy + ordinary-operation pairs |
| Clean a task-created email draft | Successful native create result in the same user/task/connector/account | Old draft, cancellation, account/task change, custom or unknown response shape stays sensitive; no replay | connector-meta-tools + CLI bridge + draft ledger |
| Keep ambiguous calendar/process/file access reviewable | Existing owner-checked process_session.stop and authorized file scopes remain available | No attendees does not prove calendar privacy; an arbitrary PID or personal-folder path does not grant ownership | Existing permissions and process owners |

Native Windows smoke remains required for PowerShell execution and desktop viewer
launch; cross-platform parsed cases do not claim that coverage. No real provider
write, paid model call or user's filesystem is used by these deterministic cases.
