# 搜索索引与启动回归 Case

## 自动化覆盖

`test/e2e/library_e2e_search.spec.ts` 已用真实 Chat、Agent、Skill 和 Library 数据覆盖全局搜索、逐类筛选、键盘导航、空结果、全局/项目资料正文命中、图片视觉描述命中，以及结果到会话/资料/详情页的跳转。该 E2E 会先建立并信任一个不含新消息的 chat 索引，再通过真实 UI 发送消息，防止“首次搜索碰巧全量修复”掩盖增量接线断开；项目正文 case 则从非项目页面搜索一个只存在于正文的标记，防止文件名匹配掩盖向量索引或跨项目接线断开。`test/main/features/group_chat/bus-integration.test.ts` 进一步从真实消息落盘入口验证用户与 Commander 消息无需修复扫描即可搜索；`test/main/features/search/*.test.ts`、`test/main/features/chats.test.ts` 和 `test/renderer/global-search-navigation.test.ts` 覆盖确定性完成边界、崩溃恢复消息、分词、CJK 噪声抑制、正文与文件名去重、项目/账号隔离、缺失向量库只读降级、真实 SQLite 损坏后的局部降级、索引损坏/旧版本自愈、删除清理、机器目录排除、查询 I/O 上限、搜索历史按账号隔离、清空查询后丢弃慢返回结果，以及深历史消息精确定位。`test/main/features/kb_indexer.test.ts` 覆盖 Markdown、PDF、DOCX、XLSX、PPTX 和图片进入可检索 chunk 的格式矩阵。

真实向量质量由 `npm run benchmark:kb-retrieval -- --no-save` 验证：使用随包 `bge-small-zh-v1.5`、sqlite-vec 和合成多语言语料，分别统计语义检索 Recall@3/MRR、交互式关键词命中率，以及无关查询拒绝率。超大真实索引、跨设备同步和不同桌面平台仍按本文人工回归。

## Startup and one-time chat migration

1. With several historical accounts, restart while signed into one: only the active account is scanned. Machine directories must never become pseudo-accounts.
2. A completed SQLite source stamp is reused at startup without parsing the retired JSON snapshot or statting every historical JSONL. Missing indexes are built in the existing idle disk slot, with at most 32 concurrent source-file stats.
3. Start with an old `chats.idx.json` and no database. Interrupt during a large conversation, restart, and verify the committed prefix resumes without duplication. Preserve the old JSON and `.tmp` until history and concurrent changes have been indexed successfully.
4. Append messages while migration is paused. Message persistence, display and cloud sync continue; indexing is deferred to catch-up. Search returns promptly with partial coverage, and new messages become searchable after catch-up. After completion, ordinary appends are indexed incrementally again.
5. An aborted startup slice must resume automatically when the runtime is idle. A failed batch must retain old files and retry; neither cancellation nor failure may publish a completed index.
6. Replace or delete conversations through sync during migration, including replacement after a source read and before its last batch settles. Completion must wait for a stable source; replaced/deleted text must not survive catch-up.

`test/main/features/search/migration.test.ts` owns these migration, interruption, restart, concurrent-append and sync-race scenarios using isolated temporary workspaces and real SQLite. `search/search_e2e_rebuild.test.ts` adds real-worker SQL failure/recovery, concurrent-writer exclusion, and a 9-million-character performance negative control. Rebuild work must run outside main; during that workload the main timer gap stays below 300 ms and existing-hit query P95 below 200 ms. Full execution-record content, including its final term, remains indexed; private reasoning stays excluded.

## Query recovery

1. A cold, corrupt, old-schema or stale chat index schedules background repair. Search must not synchronously rebuild history; return available results with `chat_index_complete: false`, then complete results on a later query after repair.
2. Once trusted, real user, Commander and Agent appends must be immediately searchable without a full repair, including crash-recovery records. Unchanged queries must not stat every historical JSONL.
3. Sync invalidation schedules local repair even without a subsequent search. Search remains incomplete until repair completes. The cloud protocol and dependencies are unchanged; derived search data remains local-only.
4. Deleting a conversation removes its results immediately. Project results retain their title, project name and snippet. Explicit-user queries must never fall back to another account's Library index.
5. Opening global search queues the repair of an unverified index; no typed query is needed. The preparation notice appears only while the account's chat index has never completed a build (first build, migration, or rebuild after a reset), as soon as the lightweight coverage response reports `chat_index_building`, without waiting for all-scope search. The Chinese copy is “正在准备中，结果暂不完整，请稍后重试。”. An index built once and only waiting for catch-up (after a restart, crash or sync) shows no notice, while `chat_index_complete` still reports verified coverage to history tools. Partial hits remain usable; completed searches remove the notice and non-chat tabs omit it. Closed/superseded requests and late status responses cannot overwrite newer results. No automatic polling is added.

`test/e2e/search_e2e_rebuild.spec.ts` verifies the real renderer/shim/IPC notice and partial results, then relaunches Electron and waits for startup to resume the committed prefix without a manual repair call, and finally checks that a built index waiting for catch-up behind busy agent work stays unannounced. Its ASAR case exercises the shipped worker/dependency layout and native SQLite loader. Run it on each release platform; a macOS pass is not a Windows execution claim.

## 资料正文与项目范围

1. 文件名不含查询词、但已完成向量处理的全局资料应通过正文片段命中；点击后打开原文件。
2. 从首页搜索时，应覆盖所有已有向量索引的项目资料；结果显示所属项目，点击后进入该项目并打开原文件。
3. 从项目页或项目会话搜索时，只查询全局资料和当前项目资料，不得混入其他项目。
4. 同一文件同时命中文件名和正文时只显示一条；文件名精确命中保持优先，正文命中按相关度排序并过滤低相关“最近结果”。
5. 尚未建立向量库的账号或项目只返回文件名结果，查询本身不得创建空 `vector.db`、触发全项目 hash/reconcile 或显示错误。
6. 单类请求的 `limit` 大于 30 时应按请求返回；“全部”范围需为任务、智能体、技能、资料预留结果窗口，单一大类不得挤掉其他类别。
7. 同一规范化查询在全局和多个项目索引间只生成一次 embedding；重复查询复用有界缓存。
8. 全局索引或单个项目索引损坏/不可用时，其他健康范围和文件名结果仍应返回；embedding 不可用时只降级正文搜索。
9. 相同相对路径出现在不同项目时必须保留为不同结果；同一文件多个 chunk 仅保留分数最高的一条。
10. 中等向量分数必须同时具备有意义的正文/标题/路径词面锚点，高置信语义结果可无字面重合；真实模型负样本不得显示“仅仅最近”的资料。
11. 至少 120 个项目、240 个候选命中时仍只生成一次 embedding，并严格截断到请求的 200 条结果。
12. 已删除项目文件留下的陈旧命中无法解析绝对路径时不得打开错误的查看器或抛出未处理异常。

## 全局搜索弹窗

1. 打开 Cmd/Ctrl+K 全局搜索后点击遮罩空白处，弹窗不应关闭；右上角关闭、Esc 和再次按 Cmd/Ctrl+K 仍应关闭。
2. 输入查询后立即清空，即使旧请求随后才返回，也应保持空状态；方向键和 Enter 不得继续操作上一次的隐藏结果。
3. 搜索历史按本地账号隔离。账号 A 的查询不得出现在账号 B；旧版共享历史最多迁移给首次打开搜索的账号一次。
4. 每次通过快捷键打开后，搜索框必须取得焦点再接收输入；E2E 必须显式验证焦点接管，避免自动化输入与弹窗的延迟聚焦竞态后误写入聊天框。
5. 刚进入会话就按 Cmd/Ctrl+K：会话输入框的默认聚焦（进入会话与刷新发送区各有一次）延迟到达时不得把焦点抢回聊天框。E2E 必须等过该延迟窗口后复查焦点，否则键入会落进聊天框。
6. 未输入关键词时，有搜索历史和无搜索历史两种状态的弹窗高度必须一致；历史记录超过可用空间时只滚动内容区，不得撑高弹窗。
7. 资料正文结果按相关度排序；快速连续输入或清空时，旧 embedding 查询返回不得覆盖更新后的结果或空状态。
