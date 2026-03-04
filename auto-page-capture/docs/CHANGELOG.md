# 变更记录（CHANGELOG）

## 阶段5（2026-03-04）
- 完善 `session.json` 元数据：补齐 `startedAt/endedAt/mode/delayMs/maxShots/maxPages/exportText/shots/errors`
- Background 错误落盘增强：收到/产生 `ERROR` 时，若 session 存在则追加到 `session.errors`
- `SESSION_FINISH` 流程收敛：统一通过 finalize 逻辑写 `session.json`，即使 `shots=0` 也会输出

## 阶段4（2026-03-04）
- 翻页增强：点击后先判定 URL 变化，URL 不变时改用 DOM 变化（title/主容器指纹）判定导航成功
- `findNextPageElement` 策略增强：优先 `a[rel=next]`，再 `aria-label`，再文本匹配，最后选择器兜底
- 新增翻页失败状态码：`NEXT_PAGE_NOT_FOUND`、`NAV_TIMEOUT`
- `maxPages` 语义明确：总页数上限为 `maxPages`，最多翻页 `maxPages-1` 次

## 阶段3（2026-03-04）
- 滚动截图稳定性增强：到底判定基于滚动后实时 `scrollHeight`，降低动态页面误判
- 懒加载处理：滚动后增加内容稳定等待（轮询 `scrollHeight` 与图片完成状态）
- 防死循环保护：滚动位置连续 3 次不变自动退出并上报状态
- `maxShots` 上限保护增强：达到上限后立即停止后续滚动流程

## 阶段2（2026-03-04）
- Stop 可靠性增强：`content` 引入明确状态机 `IDLE/RUNNING/STOPPING/FINISHED`
- Stop 响应增强：长等待改为可中断等待（50ms 轮询），确保 Stop 后快速退出滚动/翻页流程
- 防竞态：引入运行令牌（runId），旧的 pending 循环不会继续执行后续步骤
- Stop 后不再触发新的 `CAPTURE_REQUEST`

## 阶段1（2026-03-04）
- 基线检查：manifest 关键入口文件路径校验通过（可加载）
- 统一消息协议：全链路统一为 `{type, sessionId, payload}`
- STATUS / ERROR 消息统一携带 `sessionId`
- popup 状态展示结构化：第一行 sessionId、第二行状态、错误单独一段

## 1.0.0
- 初始化：自动滚动截图（按屏保存 PNG）
- 支持 Stop
- 支持导出 DOM 文本为 page.md
- 支持基础自动翻页（rel=next / 下一页 / Next 等）
- 生成 session.json 元数据
