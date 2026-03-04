# Auto Page Capture（中文界面版）

这是一个 Chrome 扩展，用于自动滚动截图、可选自动翻页，并导出页面文本与会话元数据。

## 功能
- 自动滚动截图（保存为 `shots/shot_*.png`）
- 自动翻页（支持 URL 变化与 DOM 变化判定）
- 导出页面文本为 `page.md`
- 记录会话元数据为 `session.json`
- Popup 界面与状态提示为中文

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
3. 点击“开始”
4. 需要中止时点击“停止”

## 输出目录
默认输出到浏览器下载目录：

`Downloads/page_capture/<host>/<sessionId>/`

包含：
- `shots/shot_000.png ...`
- `page.md`（勾选导出文本时）
- `session.json`
