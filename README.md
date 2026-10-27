# Dia Peek

在 Dia（以及任意 Chromium 浏览器）里还原 Arc 的 **Peek**：按住 Shift 点击链接，
目标页面会以悬浮窗形式出现在当前页面上方，看完按 Esc 就回到原页面。

> Arc-style **Peek** for Dia and other Chromium browsers: Shift+click a link to preview it
> in a floating panel over the current page; Esc to dismiss, ⌘↩ to open it as a tab.

## 安装

1. 下载本仓库：点页面上方绿色的 **Code → Download ZIP** 并解压，或者
   `git clone` 到本地（放在一个不会被误删的位置，扩展会一直从这个文件夹加载）；
2. 在 Dia 地址栏打开 `chrome://extensions`，打开右上角的 **开发者模式**；
3. 点 **加载已解压的扩展程序**，选择解压出来的文件夹（里面有 `manifest.json`）。

装好后已打开的网页也能直接使用，不需要刷新。之后更新：下载新版覆盖原文件夹，
再在 `chrome://extensions` 里点一下扩展卡片上的刷新按钮。

## 用法

| 操作 | 效果 |
| --- | --- |
| Shift + 点击链接 | 在悬浮窗中预览 |
| 右键链接 →「在 Peek 中预览」 | 同上（适合会吞掉 Shift+点击的网站） |
| 鼠标悬停在链接上按 ⌥⇧P | 同上（可在 `chrome://extensions/shortcuts` 改键） |
| Esc / 点击悬浮窗外的空白处 | 关闭预览 |
| ⌘↩ 或标题栏 ↗ 按钮 | 把预览页面转为正式标签页 |
| ⌘[ / ⌘] | 在预览内后退 / 前进；退到第一页时再后退即关闭 |
| ⌘⇧C 或标题栏 🔗 按钮 | 复制当前链接 |

点击工具栏里的扩展图标，可以临时关闭功能，或把触发键改成 Option + 点击。

## 原理

- 内容脚本在捕获阶段拦截 Shift+点击，阻止浏览器默认的“新窗口打开”，改为在页面上叠加一个
  Shadow DOM 隔离的浮层，里面用 iframe 加载目标页面。
- 很多网站（GitHub、知乎等）用 `X-Frame-Options` / `CSP frame-ancestors` 禁止被嵌入。
  预览打开期间，扩展通过 `declarativeNetRequest` 会话规则，**只对当前标签页的子框架**
  去掉这两个响应头；预览关闭后规则立即撤销。
- 页面内 iframe 中的链接同样可以 Shift+点击，会转交给顶层页面弹出预览。
- 很多 Web 应用（如飞书多维表格的链接单元格）不是真正的 `<a>` 链接，而是用脚本
  `window.open()` 打开。`main-world.js` 在 Shift+点击后的 1.5 秒内接管这类调用，改为
  弹出预览；带尺寸参数的弹窗（登录授权、支付等）不受影响。只有真实的用户点击才能
  触发，网页自身无法伪造。
- 预览 iframe 带 `sandbox`，不允许它跳转顶层页面，防止“反嵌入”脚本把整个标签页带走。
- 预览里的跳转都改成“替换”而不写入标签页历史，关闭预览后浏览器的后退按钮不受影响；
  预览自己的前进后退记录由扩展维护。
- 预览页只有在收到由后台确认过的随机令牌后才会回报自己的地址，普通网页无法借此
  探测自己内嵌 iframe 的地址。
- 扩展安装或更新时，会自动把新版脚本注入所有已打开的网页，无需逐个刷新。
- 在 YouTube 上预览 YouTube 视频时改用弹出窗口：Dia 在 YouTube 页面中嵌入 YouTube
  视频页会导致标签页崩溃（与本扩展无关）。弹出窗口外点击或按 Esc 关闭，⌘↩ 转为
  标签页并保留播放进度。

部分做法参考了开源项目 [lukabirac/peek](https://github.com/lukabirac/peek)（MIT 许可）。

## 已知限制

- 少数站点用脚本检测自己是否被嵌入（例如 Google 登录页），或依赖第三方 Cookie 维持登录，
  在预览中可能显示异常或未登录。此时预览底部会出现“在新标签页打开”的提示，点一下即可。
- `chrome://`、`dia://` 页面和扩展商店页面里，扩展无法运行。
- 预览期间去掉的 CSP 头也会对当前标签页里其他新加载的 iframe 生效，关闭预览即恢复。

## 许可

[MIT](LICENSE)
