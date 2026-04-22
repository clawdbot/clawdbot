---
summary: "OpenClaw capabilities across channels, routing, media, and UX."
read_when:
  - You want a full list of what OpenClaw supports
title: "Features"
---

# Features

## Highlights

<Columns>
  <Card title="Channels" icon="message-square" href="/channels">
    Discord, iMessage, Signal, Slack, Telegram, WhatsApp, WebChat, and more with a single Gateway.
  </Card>
  <Card title="Plugins" icon="plug" href="/tools/plugin">
    Bundled plugins add Matrix, Nextcloud Talk, Nostr, Twitch, Zalo, and more without separate installs in normal current releases.
  </Card>
  <Card title="Routing" icon="route" href="/concepts/multi-agent">
    Multi-agent routing with isolated sessions.
  </Card>
  <Card title="Media" icon="image" href="/nodes/images">
    Images, audio, video, documents, and image/video generation.
  </Card>
  <Card title="Apps and UI" icon="monitor" href="/web/control-ui">
    Web Control UI and macOS companion app.
  </Card>
  <Card title="Mobile nodes" icon="smartphone" href="/nodes">
    iOS and Android nodes with pairing, voice/chat, and rich device commands.
  </Card>
</Columns>

## Full list

**Channels:**

- Built-in channels include Discord, Google Chat, iMessage (legacy), IRC, Signal, Slack, Telegram, WebChat, and WhatsApp
- Bundled plugin channels include BlueBubbles for iMessage, Feishu, LINE, Matrix, Mattermost, Microsoft Teams, Nextcloud Talk, Nostr, QQ Bot, Synology Chat, Tlon, Twitch, Zalo, and Zalo Personal
- Optional separately installed channel plugins include Voice Call and third-party packages such as WeChat
- Third-party channel plugins can extend the Gateway further, such as WeChat
- Group chat support with mention-based activation
- DM safety with allowlists and pairing

**Agent:**

- Embedded agent runtime with tool streaming
- Multi-agent routing with isolated sessions per workspace or sender
- Sessions: direct chats collapse into shared `main`; groups are isolated
- Streaming and chunking for long responses

**Auth and providers:**

- 35+ model providers (Anthropic, OpenAI, Google, and more)
- Subscription auth via OAuth (e.g. OpenAI Codex)
- Custom and self-hosted provider support (vLLM, SGLang, Ollama, and any OpenAI-compatible or Anthropic-compatible endpoint)

**Media:**

- Images, audio, video, and documents in and out
- Shared image generation and video generation capability surfaces
- Voice note transcription
- Text-to-speech with multiple providers

**Apps and interfaces:**

- WebChat and browser Control UI
- macOS menu bar companion app
- iOS node with pairing, Canvas, camera, screen recording, location, and voice
- Android node with pairing, chat, voice, Canvas, camera, and device commands

**Tools and automation:**

- Browser automation, exec, sandboxing
- Web search (Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Ollama Web Search, Perplexity, SearXNG, Tavily)
- Cron jobs and heartbeat scheduling
- Skills, plugins, and workflow pipelines (Lobster)
