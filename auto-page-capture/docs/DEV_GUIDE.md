# 开发与运行指南（DEV_GUIDE）

## 1. 环境要求
- Chrome / Edge（Chromium 内核）
- 开发者模式启用

## 2. 运行步骤（加载扩展）
1) 打开 chrome://extensions/
2) 打开右上角“开发者模式”
3) 点击“加载已解压的扩展程序”
4) 选择本项目根目录（包含 manifest.json 的目录）

## 3. 使用方法
1) 打开任意网页
2) 点击工具栏扩展图标
3) 选择：
   - Mode：Scroll Only 或 Scroll + Next Page
   - Delay(ms)：建议 800~1500（懒加载可调大）
   - Max Shots：每页最多截图数
   - Max Pages：翻页最多页数
4) 点击 Start
5) 如需中止，点击 Stop

## 4. 产物路径
默认保存到 Downloads：
Downloads/page_capture/<host>/<sessionId>/
- shots/shot_000.png ...
- page.md
- session.json

## 5. 常见问题
- 截图为空：确认页面不是 chrome:// 之类的受限页面
- 懒加载截图不完整：增大 Delay(ms)
- 翻页失败：站点点击后 URL 不变化，V1 会结束（后续可增强 DOM 变化判定）
