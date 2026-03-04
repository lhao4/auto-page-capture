# 测试计划（TEST_PLAN）

## 1. 测试范围
- Scroll Only：长页面自动滚动截图与停止
- Next Page：分页站点翻页截图
- 导出文本：page.md
- 元数据：session.json

## 2. 测试用例
### TC-01 Scroll Only 基础
步骤：
1) 打开一篇长文章（Wikipedia/博客）
2) Mode=Scroll Only, Delay=800, MaxShots=30
3) Start
期望：
- 保存多张 shot_*.png
- 生成 page.md、session.json

### TC-02 Stop 立即生效
步骤：
1) 开始滚动截图
2) 过程中点击 Stop
期望：
- 1 秒内停止继续保存新截图
- popup 显示 Stopping/Finished

### TC-03 Next Page 翻页
步骤：
1) 打开一个有明确“下一页”的分页列表/文章页
2) Mode=Scroll + Next Page, MaxPages=3
3) Start
期望：
- 至少翻 2 页继续保存截图
- session.json 记录 shots 列表

### TC-04 异常容错
步骤：
1) 在加载受限页面（如 chrome://extensions/）尝试 Start
期望：
- 提示 ERROR
- 扩展不崩溃，可继续在普通网页使用

### TC-05 动态 scrollHeight 到底判定
步骤：
1) 打开会在向下滚动时持续加载新内容的页面（如无限列表）
2) Mode=Scroll Only, Delay=800, MaxShots=20
3) Start，观察接近底部时的行为
期望：
- 当页面继续增长时不会过早判定到底
- 真实到底后状态显示 `Reached bottom`

### TC-06 懒加载稳定等待
步骤：
1) 打开图片懒加载明显的长页面
2) Mode=Scroll Only, Delay=500, MaxShots=15
3) Start，观察截图内容
期望：
- 每次滚动后会等待内容趋于稳定再继续
- 截图中明显减少“半加载”图片比例

### TC-07 防死循环（滚动不动 3 次退出）
步骤：
1) 打开一个滚动被脚本锁住或高度很小的页面
2) Mode=Scroll Only, Delay=500, MaxShots=50
3) Start
期望：
- 出现 `Scroll unchanged (1/3...3/3)` 状态
- 第 3 次后显示 dead-loop protection 并退出
- 退出后不再出现新的截图保存状态

### TC-08 maxShots 上限保护
步骤：
1) 打开正常长页面
2) Mode=Scroll Only, Delay=500, MaxShots=3
3) Start
期望：
- 最多触发 3 次截图请求（shot_000~shot_002）
- 状态显示 `Reached maxShots=3`
