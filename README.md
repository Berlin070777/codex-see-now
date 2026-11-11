# Codex See Now

**简体中文** · [English](README.en.md)

让 Codex 看着你操作屏幕。选择屏幕、窗口、摄像头或本地视频后，See Now 在本机筛选有变化的帧，拼成带编号和时间的图。桌面版能在画面变化时主动请 Codex 分析，你也可以在悬浮窗里追问或打断。

项目移植自 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)，原项目作者是 [SAOS-3624](https://github.com/SAOS-3624)。See Now 复用了原项目的变化检测、选帧与拼图代码，并为 Codex 接入了独立桌面客户端和 MCP 插件。

![四个合成画面按时间排成一张图，依次标记 1 至 4](docs/images/contact-sheet.png)

*合成示例。四格对应 0、2、4、6 秒。实际使用时，客户端会同时显示帧号、时间和保留原因。*

## 独立桌面客户端

本地运行需要 Node.js 22+ 和可从 `PATH` 找到的 Codex CLI。桌面版通过 Electron 采集；旧版 MCP 插件的 FFmpeg 依赖见下方。

```sh
git clone https://github.com/Berlin070777/codex-see-now.git
cd codex-see-now
npm ci
npm start
```

在 macOS 上使用屏幕、摄像头或麦克风时，按系统提示授权。录屏权限在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」。系统音频采集取决于系统、所选来源和 Electron 的授权状态。macOS 打包配置包含音频用途说明。

1. 在 **账号** 里选择连接方式。要复用当前本机 Codex 登录，可以先在终端运行 `codex login`，再点 **使用本机 Codex**。
2. 在 **采集设置** 里选择屏幕或窗口。加载预览后，拖动鼠标框选区域。也可以选择摄像头（包括系统可见的 OBS 虚拟摄像头）或本地视频。
3. 选择画质和节奏，点击 **开始观察**。勾选自动分析后，画面变化会触发同一个 See Now 会话里的新回复。可以调高攒图张数，减少请求次数。
4. 可以在观察中切换 **Codex 模型**。当前回复会继续，下一轮使用新选的模型。
5. 用悬浮窗追问，或点 **看一眼** 发出一次主动观察。**停止**会结束采集、清空待发内容并尝试中断正在运行的 Codex 回复。

| 连接方式 | 使用方式 |
| --- | --- |
| Continue with ChatGPT | 在系统浏览器授权使用符合条件的 ChatGPT 套餐。See Now 用自己的 OAuth 注册和本机 Codex App Server。 |
| 本机 Codex | 使用 Codex CLI 已保存的认证，适合本机开发和自用。 |
| OpenAI API Key | 填写自己的 Platform API Key，按 API 用量计费。 |

模型列表跟随当前连接方式和账号权限。可以刷新列表，或为自定义模型输入模型 ID。客户端创建自己的观察会话。登录授权、续期和 API Key 在主进程处理，凭据通过操作系统凭据存储加密。ChatGPT 套餐授权详情见 [OpenAI 接入文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## 功能与兼容性

| 功能 | 独立桌面端 |
| --- | --- |
| 采集来源 | 屏幕、窗口、交互式区域框选、摄像头、OBS 虚拟摄像头、Chromium 支持的视频文件。 |
| 筛帧与出图 | 保留参考帧、按变化筛帧、时间拼图、逐场景单张、四档画质、四档节奏、采集统计。 |
| 主动观察 | 照顾正在运行的回复，合并新帧，闲时再提交。可关闭自动分析，仅在手动提问时读图。 |
| 悬浮窗 | 显示流式回复和转写，支持追问、看一眼、隐藏、停止。悬浮窗盖住所选屏幕区域时暂停提交，隐藏后恢复。 |
| 语音与音频 | 可朗读回复。可选系统音频、视频音轨或麦克风，使用用户设置的 OpenAI 兼容转写服务。拼图可附响度条，转写会附时间。 |
| 平台 | 桌面代码使用 Electron 的跨平台媒体接口。macOS 是当前验证平台。Windows 和 Linux 的设备、权限及系统音频仍需真机验证。 |

原版的 DSH `/seenow` 命令由菜单栏、开始/停止和悬浮窗控制替代。DeepSeek 的图像 token 档位、DSH 的历史附件管理和转写服务由对应宿主决定。独立客户端使用自己的 Codex 会话，官方 Codex 桌面聊天里的 MCP 插件仍可独立使用。

## 音频转写

打开 **音频转写**，选择音频来源、服务地址和模型。服务须提供 OpenAI 兼容的 `/audio/transcriptions`，并接受 WebM/Opus 音频。地址可以是 HTTPS 服务，也可以是本机 HTTP，例如 `http://127.0.0.1:8000/v1`。如果服务需要密钥，填入转写专用 API Key。此设置与 Codex 登录分开。所选服务会收到实际音频片段。

## Codex MCP 插件

在官方 Codex 聊天里按需看一小段屏幕时，可以继续使用原有插件。插件支持 macOS，并需要 Node.js 20.3+ 和带 AVFoundation 的 FFmpeg。

```sh
brew install node ffmpeg
codex plugin marketplace add Berlin070777/codex-see-now
codex plugin add codex-see-now@see-now-plugins
```

重启 Codex 并开一个本地新聊天。可以说「用 See Now 看主显示器左上四分之一，接下来 10 秒告诉我发生了什么」。用 `vision_test` 可以验证 Codex 能否读到合成图里的随机数字。

| 工具 | 用途 |
| --- | --- |
| `watch_screen` | 观察 2–30 秒，结束后返回拼图。 |
| `start_watch` / `next_frames` / `stop_watch` | 观察 5–120 秒，按会话 ID 分批取图并停止。 |
| `vision_test` | 返回含随机数字的测试图，无需录屏权限。 |

卸载插件时运行 `codex plugin remove codex-see-now@see-now-plugins`。如需移除来源，再运行 `codex plugin marketplace remove see-now-plugins`。

## 数据和限制

- 采集、裁剪和筛帧在本机完成。发起分析时，选中的关键帧和相关转写会进入所选 Codex 会话；可选转写服务会收到音频。
- 只分析采集源可见的像素。短于采样间隔、被遮挡或变化幅度很小的内容可能漏掉。小字难辨时缩小区域或提高画质。
- 忙时最多保留最近四张待发送拼图。停止后不会继续发送排队的画面。
- ChatGPT 授权和所选模型的可用性受账号、套餐及工作区设置影响。桌面客户端默认使用当前本机 Codex 登录，亦可主动切换。

## 开发、打包与贡献

```sh
npm test
npm run package:mac
```

`npm run package:mac` 生成本机可测试的应用目录，默认不提供正式发布签名或公证。[桌面客户端](desktop/)与 [MCP 插件](plugins/codex-see-now/)共享同一套上游筛帧代码。欢迎向 [GitHub Issues](https://github.com/Berlin070777/codex-see-now/issues) 提交问题或 Pull Request。反馈请附平台、Codex 版本、采集来源和复现步骤。

## 许可证和致谢

新增代码采用 [MIT](LICENSE)。原项目 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 由 [SAOS-3624](https://github.com/SAOS-3624) 开发。复用代码及其修改保留 [Apache 2.0](plugins/codex-see-now/vendor/dsh-see-now/LICENSE) 和[原始 NOTICE](plugins/codex-see-now/vendor/dsh-see-now/NOTICE)。[上游版本与修改记录](plugins/codex-see-now/vendor/dsh-see-now/README.md)。
