---
name: qqbot-media
description: QQBot rich media send and receive support. Use <qqmedia> tags to send image, voice, video, or file attachments, with the media type inferred from the file extension.
metadata: { "openclaw": { "emoji": "📸", "requires": { "config": ["channels.qqbot"] } } }
---

# QQBot 富媒体收发

## 用法

```
<qqmedia>路径或URL</qqmedia>
```

系统根据文件扩展名自动识别类型并路由：

- `.jpg/.png/.gif/.webp/.bmp` → 图片
- `.silk/.wav/.mp3/.ogg/.aac/.flac` 等 → 语音
- `.mp4/.mov/.avi/.mkv/.webm` 等 → 视频
- 其他扩展名 → 文件
- 无扩展名的 URL → 默认按图片处理

## 接收媒体

- 用户发来的**图片**自动下载到本地，路径在上下文【附件】中，可直接用 `<qqmedia>路径</qqmedia>` 回发
- 用户发来的**语音**路径在上下文中；若有 STT 能力则优先转写

## 规则

1. **路径必须是绝对路径**（以 `/` 或 `http` 开头）
2. **标签必须用开闭标签包裹路径**：`<qqmedia>路径</qqmedia>`
3. **待发送的本地文件须落在 OpenClaw 媒体目录下**：生成、下载或复制出的文件应写入 **`~/.openclaw/media/qqbot/`**（或其子目录），再写进 `<qqmedia>`。不要只放在 `~/.openclaw/workspace/` 等工作区根目录——平台安全策略只允许从 `~/.openclaw/media/`（含 `media/qqbot`）等受信根路径上传，否则会拦截、发不出去。
4. **文件大小上限**：图片 30MB / 视频 100MB / 文件 100MB / 语音 20MB
5. **你有能力发送本地图片/文件**，直接用标签包裹路径即可，**不要说"无法发送"**
6. 发送语音时不要重复语音中已朗读的文字
7. 多个媒体用多个标签
8. 以会话上下文中的能力说明为准（如未启用语音则不要发语音）
