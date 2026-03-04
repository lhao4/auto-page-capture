# 变更记录（CHANGELOG）

## v1.1.0-dev Task1（2026-03-04）
- 文本抽取升级：由 `document.body.innerText` 改为“主内容候选评分”策略（DOM 优先）
- 增加兜底流程：当 DOM 文本过短时，启用图像可访问文本兜底（`alt/aria-label/figcaption/svg text`）
- 导出增强：`page.md` 新增抽取来源与原因字段（`ExtractSource` / `ExtractReason` / `TextLength`）
- 状态提示增强：运行中可看到当前命中的文本抽取策略

## v1.1.0-dev Task2（2026-03-04）
- 新增 OCR 引擎兜底链路：content 在 DOM 文本不足时可请求 background 执行 OCR
- 新增消息类型：`OCR_REQUEST`
- OCR provider 初版：接入 OCR.Space（实验），失败自动回退到可访问文本兜底
- UI 增加配置：popup 新增“启用 OCR 引擎兜底（实验）”开关
- 导出增强：`page.md` 追加 `OCRProvider`、`OCRError` 字段，便于诊断

## v1.1.0-dev Task3（2026-03-04）
- OCR 配置闭环：popup 增加 OCR 语言与 API Key 输入，并持久化到 `chrome.storage.local`
- 启动参数透传：`START_CAPTURE` -> `content` -> `OCR_REQUEST` 全链路透传 `ocrLanguage/ocrApiKey`
- 默认行为优化：未填写 API Key 时继续使用 OCR.Space 演示 key，避免功能中断
- 会话元数据补充：`session.json` 追加 `ocrLanguage`（不记录 API Key）
- 文档更新：README 增加 OCR 配置与限制说明

## v1.1.0-dev Task4（2026-03-04）
- Popup 界面重构：参数区、OCR 区、操作区、状态区分区展示，信息层次更清晰
- 状态显示结构化：改为独立字段展示 `会话ID / 状态 / 错误`，错误时高亮
- 视觉升级：新增渐变背景、卡片化面板、按钮风格与轻量动效，提升可读性
- 交互细节：表单控件与状态面板样式统一，保留原有功能与消息协议

## v1.1.0-dev Task5（2026-03-04）
- OCR 准确率增强：background 引入多路识别策略（`original` / `gray_contrast` / `binary_boost`）
- 图像预处理：支持灰度、对比度、亮度、阈值二值化与尺寸归一化，提升小字识别稳定性
- OCR 结果择优：按文本质量分数自动选择最佳候选，达到高分阈值后提前收敛降低延迟
- 质量门槛防误判：content 侧增加文本质量评分，避免噪声 OCR 文本覆盖 DOM 主文本
- 导出诊断字段增强：`page.md` 追加 `OCRVariant/OCRScore/DOMQuality/FinalQuality`

## v1.1.0-dev Task6（2026-03-04）
- 新增长截图 PDF 导出：会话结束时自动生成 `long_capture.pdf`
- UI 增加开关：popup 新增“导出长截图 PDF”选项（默认开启）
- Background 增加 PDF 组装链路：将截图序列转为 JPEG 页面并合成为单个 PDF 文件
- 会话元数据补充：`session.json` 新增 `exportPdf` 与 `pdf` 导出结果信息

## v1.1.0-dev Task7（2026-03-04）
- PDF 导出策略升级：新增“优先单页长 PDF，超限自动回退多页”能力
- UI 增加开关：popup 新增“优先单页长 PDF（过长自动分多页）”
- Background 新增单页拼接：按截图顺序纵向合并后导出 1 页 PDF
- 自动回退机制：当单页高度/面积超限时，自动回退多页 PDF 并上报状态
- 会话元数据补充：`session.json.pdf.layout` 标记 `single` 或 `multi`

## v1.1.0-dev Task8（2026-03-04）
- 中间衔接优化：滚动改为“重叠步进”策略，降低拼接断层与漏内容风险
- 截图元数据增强：`CAPTURE_REQUEST` 追加 `y/viewport/scrollHeight`，用于 PDF 拼接裁剪
- 单页拼接优化：按相邻截图滚动位移自动裁剪重叠区域，减轻重复头部与接缝突兀
- 精简产物：停止导出 `session.json` 文件，仅保留运行时会话数据

## v1.1.0-dev Task9（2026-03-04）
- 清晰度优化：PDF 默认宽度提升到 `2200px`，JPEG 质量提升到 `0.94`
- 去除单页拼接中间重编码：改为直接使用原始截图位图拼接，减少文字发糊
- 渲染质量优化：画布缩放使用 `imageSmoothingQuality=high`，改善缩放后的边缘细节

## v1.1.0-dev Task10（2026-03-04）
- OCR 输入分辨率上限提升：`OCR_MAX_DIM` 提升到 `3600`，保留更多小字细节
- OCR 预处理策略调整：由“二值化优先”改为“彩色放大 + 灰度增强”组合，减少文字边缘损伤
- OCR 超时窗口加大：默认 OCR 超时提升到 `18s`，降低慢响应页面的截断失败
- OCR 文本清洗增强：新增零宽字符/异常空白清理，降低输出噪声

## v1.1.0-dev Task11（2026-03-04）
- PDF 质量增强：优先使用无损图像嵌入（`FlateDecode`），不支持时自动回退 JPEG
- 减少模糊：单页拼接与分页导出共用“优先无损”策略，改善文字边缘发糊问题
- 清晰度/体积平衡：超大页面时自动使用高质量 JPEG 回退，避免无损内存过高

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
