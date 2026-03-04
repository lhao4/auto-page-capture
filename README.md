# Auto Page Capture（中文界面版）

这是一个 Chrome 扩展，用于自动滚动截图、可选自动翻页，并导出页面文本与长截图 PDF。

## 功能
- 自动滚动截图（保存为 `shots/shot_*.png`）
- 自动翻页（支持 URL 变化与 DOM 变化判定）
- 导出页面文本为 `page.md`（DOM 主提取 + OCR 兜底链路）
- 导出长截图 PDF（`long_capture.pdf`，优先单页，过长自动分多页）
- Popup 界面与状态提示为中文
- OCR 可配置（开关、语言、API Key，本地持久化）
- OCR 准确率增强（多路预处理 + 质量评分筛选）

## 安装方式（开发者模式）
1. 打开 `chrome://extensions/`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：`e:\auto-page-capture\auto-page-capture`（含 `manifest.json`）

## 使用方式
1. 打开目标网页
2. 点击扩展图标，设置：
   - 模式：仅滚动 / 滚动 + 自动翻页
   - 延迟(ms)、最大截图数、最大页数
   - 是否导出页面文本
   - 是否导出长截图 PDF（默认开启）
   - 是否优先单页长 PDF（默认开启，超限自动回退多页）
   - OCR 兜底（可选）：启用开关、选择语言、填写 OCR.Space API Key
3. 点击“开始”
4. 需要中止时点击“停止”

## OCR 配置说明
- 若不填写 API Key，将使用 OCR.Space 演示 key（`helloworld`），有频率和稳定性限制。
- 建议在 OCR.Space 申请个人 API Key 后填入扩展配置，识别效果更稳定。
- API Key 存储在扩展 `chrome.storage.local`，仅用于 OCR 请求，不会写入导出文件。

## OCR 准确率策略
- 多路尝试：同一截图会按原图、灰度对比增强、二值增强进行 OCR 并择优。
- 质量门槛：content 会对 OCR 文本做质量评分，避免“噪声长文本”覆盖 DOM 文本。
- 结果诊断：`page.md` 包含 `OCRVariant/OCRScore/DOMQuality/FinalQuality` 字段，便于定位识别问题。

## 输出目录
默认输出到浏览器下载目录：

`Downloads/page_capture/<host>/<sessionId>/`

包含：
- `shots/shot_000.png ...`
- `long_capture.pdf`（勾选导出 PDF 时）
- `page.md`（勾选导出文本时）
