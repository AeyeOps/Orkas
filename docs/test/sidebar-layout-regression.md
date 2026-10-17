# Orkas 侧栏布局测试与评测规范

## 用户结果与风险

侧栏宽度属于高频导航状态。Case 必须同时保护当前拖拽与本地持久化行为，并从用户预期主动探测可访问性、窄窗口、中断和损坏存储：

| 场景 | 用户预期 | 单测 | Electron E2E | Benchmark |
|---|---|---|---|---|
| 鼠标拖拽/中断 | 宽度实时变化；释放或窗口失焦后不残留全局 resize 状态 | `test/renderer/sidebar-resize.test.ts` | 确定性 DOM 行为由单测负责 | 不涉及模型 |
| 键盘与辅助技术 | separator 可聚焦，方向键/Home/End 可调，并持续公布 min/max/current | 同上 | `test/e2e/sidebar_e2e_resize.spec.ts` | 不涉及模型 |
| 持久化与损坏输入 | 合法宽度重启保留；部分数字、非有限值和存储异常不污染布局 | 同上 | 完整 Electron relaunch 复验 | 不涉及模型 |
| 窄窗口 | 侧栏主动让出至少 320px 主内容空间；重新变宽后恢复用户偏好 | 同上 | 真实 viewport 缩放与恢复 | 不涉及模型 |
| 当天任务/项目/任务整体折叠 | 点击标题栏的完整可用区域即可折叠；三个分区独立恢复，升级前没有“当天任务”记录的本地状态默认展开，且新建项目入口始终可用 | `test/renderer/sidebar-sections.test.ts` | 确定性 DOM 行为由单测负责 | 不涉及模型 |
| Navigation groups | Daily operations and Capability resources start collapsed; original tab names and routes remain available in their approved order. Each group restores its own preference after relaunch, including explicit expanded choices; legacy task-section preferences survive. Keyboard activation, localized ARIA labels, and corrupt/unavailable storage remain usable. | `test/renderer/sidebar-sections.test.ts`, `test/renderer/i18n.test.ts` | `test/e2e/sidebar_groups_e2e_navigation.spec.ts`, `test/e2e/localization_e2e_language_switch.spec.ts` | No model involved; host-only sidebar preferences add no Web application SDK capability. |
| 当天任务聚合镜像 | “当天任务”只列出当天（本地零点起）有活动的任务，跨项目和未归项目聚合，折叠项目下的任务也要出现；行样式、点击、菜单、运行中状态点与未读红点与原列表完全一致，从任一处打开都同时清除两处红点；重命名聚焦在用户操作的那一列；非当天不展示 | `today-tasks-section.test.ts`、`conversation-bucket.test.ts`、`task-unread-indicators.test.ts`、`conversation-sidebar.test.ts` 的多副本徽标/重命名聚焦、`test/main/features/chats.test.ts` 的启动切片补齐当天行 | `test/e2e/sidebar_today_e2e_aggregate.spec.ts`：真实 IPC 下折叠项目的当天任务进入聚合区、上周任务不进入、未读红点两处同清、打开后两副本同时高亮 | 不涉及模型 |

## 运行

```bash
cd PC
node scripts/run-tests.mjs run test/renderer/sidebar-resize.test.ts
node scripts/run-tests.mjs run test/renderer/sidebar-sections.test.ts
node scripts/run-tests.mjs run test/renderer/today-tasks-section.test.ts test/renderer/conversation-bucket.test.ts test/renderer/task-unread-indicators.test.ts
npm run test:e2e -- test/e2e/sidebar_e2e_resize.spec.ts
npm run test:e2e -- test/e2e/sidebar_today_e2e_aggregate.spec.ts
```
