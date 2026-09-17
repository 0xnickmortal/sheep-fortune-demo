# 手机版视觉与素材

本轮根据用户最新要求调整为喜庆红金游戏界面，以亚洲地区较年长的手机用户为主要阅读对象。

- 主色：喜庆红 #B51B28、深红 #821420、暖金 #FFDC8C、米白 #FFF8E9。
- 使用手机系统中文字体；正文约 18px，主要标题 26–28px，开始按钮 26px。按钮触控高度至少 48px，主按钮至少 70px。
- 页面宽度最多 520px，320px 起适配；处理刘海和底部安全区，允许浏览器缩放，支持减少动态效果。
- 主导航只有“玩游戏 / 我的奖励 / 我的账户”。玩法说明、充值和提现各用独立弹窗。
- 福羊素材：`public/assets/fortune-sheep.png`，内置 imagegen 生成，1254×1254 真透明 RGBA。模式：generate。没有外部原图。

生成提示词：Create one premium mobile game mascot as an isolated transparent PNG for a Chinese good-fortune sheep game aimed at older adult Asian users. A joyful, dignified cream-white sheep with softly curled gold horns, a red festive scarf and simple red vest, holding one small golden ingot. Large expressive kind eyes, welcoming smile, plump rounded silhouette, luxurious soft high-end 3D toy rendering, tactile wool, restrained warm gold highlights, excellent readability at small size. Full body, centered, square composition, genuine transparent background. No text, letters, numbers, UI, logos, watermark, coins raining, casino props or promises of profit. Target square 1024 image.

验证范围：本次检查响应式源码与资源打包、后端接口和账本自动化测试。尚未进行真机或浏览器视觉验收。


## 转盘呈现更新

保留红金色与中心福羊，主体改为24 格密集转盘，固定指针在顶部。奖格分别显示“谢谢参与 / 0.8× / 再来一次 / 1.2× / 1.5× / 2× / 3× / 5× / 10×”，数字倍率为扣费前返还，按钮仍为单一“转一下”。指针只在已收到结算后停到对应格中心，不使用假中奖、假近失或客户端改写结果。概率说明放入“查看概率”，主画面显示本次倍率、可领取奖励、净变化和已扣费用。新局一次抽一个倍率，彻底取消 20 份拆分展示和拆分结算。


“谢谢参与”采用较柔和的米色，开奖后明确显示“本次未获得奖励”、0 币及净损失；“再来一次”显示已全额退回本金和手续费为 0；大奖格采用暖金色并标出“万分之一”。主画面保留 5% 费用说明，详细概率在弹窗中公开。不会暗示下次必中奖或用近失动画诱导追损。

文案参考：腾讯云 CloudBase 官方抽奖组件示例使用“谢谢参与”（https://docs.cloudbase.net/lowcode/components/wedaUI/src/docs/compsdocs/show/Lottery）。参考的是常用标签，具体结算含义由本游戏单独说明。


## 密集盘面与中间奖励

采用 24 个窄扇区和外圈分隔钉，数值沿半径排列；普通倍率重复出现，中奖后固定顶部指针停在同名扇区中心。中心继续使用原有福羊素材。手机不再因屏幕较矮把轮盘缩到 275px，而是按可用宽度铺开（最大 360px），主按钮仍固定在底部。

数值在扇区省略 ×，两个文字奖项使用“参与”“再来”短标签；下方 3 列完整奖项列表使用 16px 正文显示全部 9 种结果。结果大字显示完整名称和实际净奖励。页面显著说明格数不是概率、大奖万分之一；不把 1 个大奖图案误写成 1/24 的中奖率。

未增加押图案步骤，仍然只需选金额并点击“转一下”。测试包含所有 10,000 个抽签位置与 24 个停位的映射、旧局恢复、新增中间奖励的到账/领取/重复请求；未做浏览器或真机视觉测试。


根据手机体验反馈，将 36 格减少为 24 格：只减少 0.8× 的重复图案（24 → 12 格），全部 9 种奖项、中奖权重、手续费与结算逻辑保持一致。普通数字字号从 SVG 22 增至 24，文字短标签从 20 增至 22，每格角度从 10° 增至 15°。
