# AI 开发任务拆解（可直接喂给 Codex）

## 目标
用可验收的增量方式开发：每完成一个任务就可加载扩展并验证。

## Task A：初始化可加载扩展
- 产物：manifest、popup、content、background 空壳
- 验收：扩展能加载，点击图标弹出 popup

## Task B：Start/Stop 消息链路
- popup Start→content，Stop→content
- content 发送 STATUS 回 popup
- 验收：点击 Start/Stop popup 状态变化，无报错

## Task C：单次截图下载
- content 触发 CAPTURE_REQUEST
- background captureVisibleTab + downloads.download 保存
- 验收：Downloads 出现 1 张图片

## Task D：自动滚动截图（MVP）
- 循环：截图→等待→scroll→等待
- maxShots、delay 可配置
- Stop 1 秒内生效
- 验收：长页面保存多张截图

## Task E：导出 DOM 文本
- content 提取 title/url/innerText
- background 保存 page.md
- 验收：目录下出现 page.md

## Task F：自动翻页
- 模式 nextPage：到底后找 next 元素并点击，等待 URL 变化
- maxPages 限制
- 验收：分页站点至少翻 2 页继续截图

## Task G：会话元数据与错误
- 会话元数据在运行期内存中维护（不导出 session.json 文件）
- popup 展示最后状态与错误
- 验收：异常不会崩溃，状态区可看到错误与结束状态

## 二期增强（可选）
- 长图拼接
- OCR（建议 offscreen document + tesseract）
- 懒加载稳定等待、滚动容器识别、重复去重
