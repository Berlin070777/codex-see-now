# Codex See Now

给 macOS 上的 Codex 看你接下来几秒的屏幕操作。插件复用
[dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 的采集、变化检测和拼图代码。
FFmpeg 在本机采集，插件选出有变化的画面，按时间拼成带编号的 PNG，再通过本地 MCP 返回给 Codex。
静止画面只保留一张参考帧。模型读取的是关键帧，短于采样间隔的变化可能漏掉。

## 安装

需要 macOS、Node.js 20.3+、支持 AVFoundation 的 FFmpeg，以及支持本地插件的 Codex。
使用 Homebrew 的 Mac 可以运行 `brew install node ffmpeg`。

```sh
codex plugin marketplace add Berlin070777/codex-see-now
codex plugin add codex-see-now@see-now-plugins
```

也可以先克隆仓库，在仓库根目录执行 `codex plugin marketplace add "$PWD"`，
然后执行同一个 `codex plugin add`。桌面端若已打开，重新启动后开一个本地新聊天。
也可在桌面端插件目录中从 **See Now Plugins** 来源安装 **See Now**。

首次真实采集时，按 macOS 提示在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」
给启动采集的应用授权，从桌面端运行就检查 ChatGPT，从终端运行就检查终端。
授权后如果系统要求，重新启动相应应用。

## 使用

- **看一小段**：「用 See Now 看主显示器左上四分之一，接下来 10 秒我会切三个页面。按顺序告诉我看到了什么。」
- **分批看**：「用 See Now 看主显示器右半边 30 秒，有变化就分批读图，我说停就停。」
- **确认 Codex 能读图**：「调用 See Now 的 `vision_test`，只读出图里的六位数字。」这张图是随机生成的。

区域坐标用屏幕宽高的百分比，从左上角起算。左上四分之一是
`{ "x": 0, "y": 0, "width": 50, "height": 50 }`。显示器从 0 开始编号。
如需观察整块显示器，在请求里明确说明。短时观察支持 2–30 秒，分批观察支持 5–120 秒。
分批模式由 Codex 调用 `next_frames` 取图，队列最多保留最新四张，满时会丢最旧的图。
你可以说「停止 See Now」，也可以取消正在执行的工具或结束客户端会话。

采集裁剪由 FFmpeg 在本机完成，插件在内存中处理裁剪后的帧，返回的拼图会进入 Codex 的会话。
插件没有遥测或独立上传服务。这个版本聚焦屏幕画面，音频、语音、悬浮窗和 DSH 的主动唤醒未移植。

## 开发和卸载

在仓库根目录运行 `node --test`，无需安装 npm 依赖。
卸载插件并移除来源：

```sh
codex plugin remove codex-see-now@see-now-plugins
codex plugin marketplace remove see-now-plugins
```

## 许可

新增代码采用 [MIT](LICENSE)。复用的 dsh-see-now 源码及修改保留
[Apache 2.0](plugins/codex-see-now/vendor/dsh-see-now/LICENSE) 和
[上游 NOTICE](plugins/codex-see-now/vendor/dsh-see-now/NOTICE)。
