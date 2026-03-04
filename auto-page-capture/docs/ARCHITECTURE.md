# Auto Page Capture - 技术架构设计

## 1. 技术栈
- Chrome Extension Manifest V3
- JavaScript（ES2020+）
- Chrome APIs：
  - tabs.captureVisibleTab：截图
  - downloads.download：保存文件
  - storage：保存配置（预留）

## 2. 模块划分
### 2.1 Popup（UI）
- 展示配置项：模式、delay、maxShots、maxPages、导出文本开关
- 控制 Start/Stop
- 展示状态与错误

### 2.2 Content Script（页面控制）
- 自动滚动策略：滚动→等待→请求截图
- 自动翻页策略：到底后识别 Next 元素→点击→等待 URL 变化
- 导出 DOM 文本：document.body.innerText
- 响应 Stop：尽快终止循环

### 2.3 Background Service Worker（能力层）
- 创建会话：生成输出目录（Downloads/page_capture/<host>/<sessionId>/）
- 截图并下载保存
- 保存 page.md、session.json
- 统一状态/错误消息回传

## 3. 消息协议
统一 Envelope（强制）：
- 所有消息必须包含：`{ type, sessionId, payload }`
- `type`：字符串枚举
- `sessionId`：会话标识（同一会话全链路一致）
- `payload`：对象；无参数时也传空对象 `{}`

会话约定：
- `sessionId` 由 popup 在点击 Start 时生成
- content script 必须复用该 `sessionId`，不得重新生成
- background 产生的所有回传（包括 `STATUS` / `ERROR`）必须带原始 `sessionId`

关键消息（V1）：
- `START_CAPTURE` / `STOP_CAPTURE`（popup→content）
- `SESSION_INIT` / `SESSION_FINISH`（content→background）
- `CAPTURE_REQUEST`（content→background）
- `EXPORT_TEXT`（content→background）
- `STATUS` / `ERROR`（content、background→popup）

## 4. 输出结构
Downloads/page_capture/<host>/<sessionId>/
- shots/shot_000.png ...
- page.md
- session.json

`session.json` Schema（V1）：
- `startedAt`: number（epoch ms）
- `endedAt`: number|null（epoch ms）
- `mode`: string
- `delayMs`: number
- `maxShots`: number
- `maxPages`: number
- `exportText`: boolean
- `shots`: array
  - item: `{ index, filename, ts }`
- `errors`: array
  - item: `{ ts, message }`

说明：
- `SESSION_FINISH` 时始终写出 `session.json`（即使 `shots` 为空）
- 运行中出现 `ERROR` 且 session 存在时，错误会追加到 `errors`

## 5. 自动滚动策略（V1）
- 以 window 为滚动容器
- step = viewportHeight
- 到底判定：nextY + 2 >= scrollHeight
- maxShots 防止死循环

## 6. 自动翻页策略（V2）
next 元素识别优先级：
1) `a[rel="next"]`
2) `aria-label` 包含 Next/下一页
3) 文本匹配：Next/下一页/›/»
4) 兜底选择器：`.next`, `#next`, `.pagination-next`

点击后导航判定（轮询 100ms，超时 8s）：
- 优先判定 URL 变化
- 若 URL 不变，使用 DOM 变化判定（`title` 或主内容容器指纹变化）
- 两者都未变化则判定超时，状态码：`NAV_TIMEOUT`

翻页失败状态码：
- `NEXT_PAGE_NOT_FOUND`：未找到下一页控件
- `NAV_TIMEOUT`：点击后 URL/DOM 均未在超时时间内变化

页数约束：
- `maxPages` 表示总抓取页数上限
- 最多执行 `maxPages - 1` 次翻页

## 7. 可靠性与已知限制
- 固定 header 可能导致截图重复
- 懒加载页面可能需要调大 delay
- 少数站点存在局部 DOM 异步刷新较慢，可能触发 `NAV_TIMEOUT`，可适当提高 delay
