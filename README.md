# dsh-breeze-tts

把 [Breeze TTS 2](https://breezeblue.ai)（T8star-Aix Voice Studio）接进 DeepSeek Harness：
DSH 进程内提供 HTTP 合成接口，Aurabot 的「通用 TTS」直接调用，无需独立进程。

## 它做什么

- 在 `127.0.0.1:9880` 提供 `GET /tts?text=…` → 返回 24 kHz 单声道 WAV
- 自动发现 Breeze 后端端口（读 `desktop.log`，回退扫 `python.exe` 监听端口）
- 把 Breeze 的 WebSocket 合成流（PCM16）封成 WAV
- 在 DSH 网页端提供「Breeze 语音」面板：列出音色、切换当前音色
- 串行队列 + 超时，避免连发抢显存

## 接口

| 路径 | 说明 |
|---|---|
| `GET /tts?text=…&voice=&instruct=&mode=` | 合成音频（24 kHz WAV） |
| `GET /health` | 桥接 / 后端 / 模型状态 |
| `GET /breeze/api/voices` | 音色列表 |
| `GET/POST /breeze/api/config` | 读写 voiceId / mode / instruction |

## 依赖

- DSH ≥ 0.2（插件需 `webServer` 与 `slots` 服务；缺失时自动降级，不影响启动）
- Breeze TTS 2 已在运行（模型需已下载并通过许可）
- Node ≥ 22.13（用到内置 `WebSocket`）

## 安装

```bash
cd <DSH profile 目录>
pnpm add "git+https://github.com/<you>/dsh-breeze-tts.git"
```

然后在 profile 的 `package.json` 里把 `dsh-breeze-tts` 加进 `dsh.profile.bundles`，重启 DSH。

## 配置

`~/.dsh/plugins-data/breeze-tts/config.json`（首次 POST 或默认值）：

```json
{
  "port": 9880,
  "voiceId": "",
  "mode": "design",
  "instruction": "",
  "prewarm": true,
  "firstCallTimeoutMs": 110000,
  "timeoutMs": 90000
}
```

## 注意

- Breeze 必须由用户手动启动（从后台进程拉起 Electron 会静默退出）
- 8 GB 显存下合成约 4.5 倍实时：10 字 ≈ 6–8 秒
- 插件内部所有初始化都做了异常兜底，任何失败只写日志，不会影响 DSH 启动