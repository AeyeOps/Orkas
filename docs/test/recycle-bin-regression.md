# 回收站人工回归 Case

## 自动化覆盖

`test/e2e/projects_e2e_smoke.spec.ts` 已通过真实 Electron 覆盖项目删除二次确认的取消与确认、删除后项目立即消失、回收站恢复、恢复后项目跨重启持久化，以及恢复成功后回收站快照继续保留。`test/e2e/recycle_bin_e2e_recovery.spec.ts` 通过真实 Preload/IPC 验证归档文件全部损坏时会报告失败，且不会只恢复关系元数据并制造空项目。`test/main/ipc/conversation-delete-recycle.test.ts` 覆盖单任务删除与恢复主链路；`test/main/ipc/project-delete-recovery.test.ts` 注入项目、批量任务和自动化的中途删除故障，验证自动恢复及关系/附件核对；`test/main/features/recycle_bin.test.ts` 还验证所有通用应用内删除在快照读取失败时先失败、源文件不动，并覆盖任务停止写状态与删除快照并发时：原子写入的未发布临时文件不会进入严格快照，普通用户 `.tmp` 文件仍会完整归档和恢复。`test/renderer/recycle-bin-errors.test.ts` 验证恢复与永久删除失败不会把后端错误或本地文件路径暴露给用户，同时保留批次已不存在的可判断提示。其他对象类型和批次删除仍按本文人工回归。

## 删除快照场景矩阵

| 用户场景 | 起始状态或故障 | 可观察成功与恢复结果 | 自动化证据 |
| --- | --- | --- | --- |
| 停止中的任务被删除 | 稳定消息、状态和用户 `.tmp` 附件同时存在；未发布的原子状态临时文件不可读取 | 严格快照成功；稳定内容可恢复；内部临时文件不进入批次也不被恢复 | `test/main/features/recycle_bin.test.ts` |
| 从任务列表删除并恢复单个任务 | 删除入口经真实 IPC 调用，任务目录中同时存在未发布状态文件和普通 `.tmp` 附件 | 删除返回成功且源数据消失；回收站恢复消息、状态、附件和索引；内部临时文件不出现 | `test/main/ipc/conversation-delete-recycle.test.ts` |
| 用户明确删除一个名称恰好符合原子临时格式的文件 | 该文件是删除入口的直接目标，不是任务级联扫描发现的内部文件 | 文件仍被完整归档并可恢复，避免扩大过滤范围造成用户数据丢失 | `test/main/features/recycle_bin.test.ts` |
| 真正的业务文件无法归档 | 文件被权限或独占锁阻止读取 | 删除前返回 `recycle_archive_failed`；不生成残缺批次；源数据保持不动，解除故障后可重试 | `test/main/features/recycle_bin.test.ts` |

## 回归准备

1. 准备两个独立数据目录或两台设备，用同一账号验证云端同步删除。
2. 准备普通任务、项目、自动任务、项目资料库文件、技能、智能体、应用等代表性数据。
3. 删除类 case 执行前记录被删对象标题、所属项目、附件数量和同步状态，便于恢复后核对。
4. 打开日志窗口，确保回收站批次 id、来源、类型、恢复/删除结果和错误 code 可观察。

## 入口与展示

1. 打开设置的数据 tab，回收站位于本地模块下，以一个本地列表展示记录。
2. 回收站为空时，应分别显示云端同步删除、本设备删除为空，不应展示旧的同步回收站入口。
3. 本设备删除产生的记录应显示在“本设备删除”分组；云端同步导致的删除应显示在“云端同步删除”分组。
4. Single-object rows show the business title. A batch containing multiple automations shows a localized task count (for example, “自动化 · 7 个任务”), counting distinct tasks rather than configuration files or distinct names. Other categories keep their business titles; headers never show archive paths or a deleted-file count.
5. 项目资料库条目应显示为“项目资料库：文件标题”，不应显示“项目文件”。
6. Mixed batches summarize objects by category. Expanded automation rows show task names and, when available, their project names; IDs and configuration paths appear in hover hints. Legacy entries recover names from their archived configurations, preserve saved names when those configurations are missing or unreadable, and leave recovery files and metadata unchanged. In narrow windows, all tasks remain reachable by scrolling.
7. 条目第二行只显示删除时间，不显示路径、文件大小或归档目录。
8. 切换系统语言后，回收站标题、来源分组、按钮和错误文案应跟随语言切换。

## 本设备删除

1. 删除单个普通任务后，任务从任务列表移除，回收站本设备删除分组出现该任务标题。
2. 删除项目后，项目列表、任务列表、项目内自动任务和项目资料库都应移除；回收站只显示项目标题，不展开内部任务。
3. 分别删除自动任务、智能体、技能、应用、资料库文件，回收站应显示可识别业务标题，不暴露配置文件名或 raw path。
4. 删除失败时，原业务数据应仍在原位置可见，页面应展示明确错误。

## 恢复

1. 点击恢复应先弹二次确认；取消后不恢复任何文件，回收站记录仍保留。
2. 恢复单个任务后，任务列表立即出现原任务，标题、内容、智能体/技能关联和会话索引应保持原状态。
3. 恢复项目后，项目、项目内任务、自动任务、附件和项目资料库应回到原项目下。
4. 恢复自动任务后，标题、调度、启用状态、项目归属和附件都应恢复。
5. 恢复技能、智能体、应用或项目资料库文件后，对应列表、详情页和入口应立即刷新，不应出现空目录卡片。
6. 如果目标文件已经存在或一批中部分文件恢复失败，应展示可理解的部分结果；回收站记录仍保留以便重试。
7. 恢复成功后回收站记录也应保留，只有用户点击删除回收站数据时才移除。

## 删除回收站批次

1. 点击删除应先弹二次确认；取消后回收站记录仍保留。
2. 确认删除后，只删除本地回收站快照和记录，不删除当前已恢复或仍存在的业务数据。
3. 删除成功后，该批次从当前来源分组立即消失。
4. 删除不存在的批次或删除失败时，应展示可理解提示，不应让页面卡死。
5. 删除云端同步删除批次不应影响其他设备或云端数据。

## 异常与安全

1. 回收站列表中存在损坏批次元数据时，其他正常批次仍应展示，损坏批次不应导致整个页面空白。
2. 恢复过程中应用退出，重启后回收站记录仍在；已恢复文件保持，未恢复文件可重试。
3. 磁盘空间不足或权限不足导致删除快照或恢复失败时，应保留原数据或回收站记录，并展示失败提示。
4. 回收站日志中不能出现完整文件路径、项目名、任务标题、附件名、用户邮箱、token、模型密钥或文件内容。

## 清理

- 每个恢复 case 都要同时检查 UI 列表、文件系统、索引文件和回收站记录是否一致。
- 回归结束后删除测试用回收站批次和测试数据，避免污染后续同步基线。

## 清空本地列表

清空先确认当前列表的记录数量；取消不删除。确认后逐个删除冻结的记录集合，期间禁用并发恢复、删除与重复清空；后来到达的记录保留。部分失败只显示可恢复的本地化提示，重试只删除剩余记录。不能读取/删除的快照不得误报成功，日志不得暴露原始路径或异常文本。
