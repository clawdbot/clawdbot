---
name: qqbot-media
description: QQBot rich media send and receive support. Use <qqmedia> tags only for explicit media send/view requests, treating inbound attachment paths as private current-conversation context.
metadata: { "openclaw": { "emoji": "📸", "requires": { "config": ["channels.qqbot"] } } }
---

# QQBot 富媒体收发

## 用法

```
<qqmedia>{实际路径或URL}</qqmedia>
```

系统根据文件扩展名自动识别类型并路由：

- `.jpg/.png/.gif/.webp/.bmp` → 图片
- `.silk/.wav/.mp3/.ogg/.aac/.flac` 等 → 语音
- `.mp4/.mov/.avi/.mkv/.webm` 等 → 视频
- 其他扩展名 → 文件
- 无扩展名的当前会话本地/host-read 媒体 → 按加载出的实际媒体类型路由
- 无扩展名的远程 URL → 可能按文件发送；如需图片/语音/视频，请提供能识别类型的 URL/路径或使用明确媒体标签

## 接收媒体

- 用户发来的**图片**会由 QQBot 运行时下载到 OpenClaw 管理的 QQBot media 目录，路径只作为当前会话的附件上下文使用。
- 用户发来的**语音**路径在上下文中；若有 STT 能力则优先转写。
- 附件路径和远程 URL 可能包含用户私有内容。不要无关输出本地绝对路径，不要把附件转发到其他会话；只有用户明确要求回发、分析或转存该媒体时才使用。
- 不承诺长期保留附件。若用户需要长期保存，说明应由用户自行保存或重新发送。

## 规则

1. **标签必须用开闭标签包裹实际路径或 URL**：`<qqmedia>{实际路径或URL}</qqmedia>`
2. **使用你实际看到的文件路径**：刚创建文件时，用创建结果显示的路径；只有当沙箱 workspace-write 创建结果实际显示 `/workspace/...` 时，才按原样使用该路径，例如 `<qqmedia>/workspace/report.pdf</qqmedia>`。
3. **附件路径直接使用上下文给出的路径**：如果路径来自会话【附件】上下文，不要改写成 `/workspace/...`。
4. **URL 可以直接发送**：例如 `<qqmedia>https://example.com/image.png</qqmedia>`。
5. **本地路径仍受安全根限制**：只能发送当前会话授权的 agent workspace、scoped media roots、OpenClaw 媒体目录或 QQBot 媒体目录内的文件；不要使用 `..` 逃出工作区。
6. **不要扫描或主动发送上下文之外的本地文件**：只使用用户提供、工具刚生成，或当前会话上下文明确给出的路径。
7. **文件大小上限**：图片 30MB / 视频 100MB / 文件 100MB / 语音 20MB
8. **你有能力发送本地图片/文件**，直接用标签包裹路径即可，**不要说"无法发送"**
9. 发送语音时不要重复语音中已朗读的文字
10. 多个媒体用多个标签
11. 以会话上下文中的能力说明为准（如未启用语音则不要发语音）
