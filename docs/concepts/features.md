---
summary: "OpenClaw capabilities across channels, routing, media, and UX."
read_when:
  - You want a full list of what OpenClaw supports
title: "Features"
---

## Highlights

<Columns>
  <Card title="Channels" icon="message-square" href="/channels">
    Discord, iMessage, Signal, Slack, Telegram, WhatsApp, WebChat, and more with a single Gateway.
  </Card>
  <Card title="Plugins" icon="plug" href="/tools/plugin">
    Official plugins add Matrix, Nextcloud Talk, Nostr, Twitch, Zalo, and dozens more with one install command.
  </Card>
  <Card title="Routing" icon="route" href="/concepts/multi-agent">
    Multi-agent routing with isolated sessions.
  </Card>
  <Card title="Media" icon="image" href="/nodes/images">
    Images, audio, video, documents, and image/video generation.
  </Card>
  <Card title="Apps and UI" icon="monitor" href="/platforms">
    Windows Hub, browser Control UI, macOS menu bar app, and mobile nodes.
  </Card>
  <Card title="Mobile nodes" icon="smartphone" href="/nodes">
    iOS and Android nodes with pairing, voice/chat, and rich device commands.
  </Card>
</Columns>

## Full list

**Channels:**

- iMessage, Telegram, and WebChat ship with the core install; every other channel is an
  official plugin installed with `openclaw plugins install @openclaw/<id>` (or on demand
  during `openclaw onboard` / `openclaw channels add`)
- Official plugin channels: Discord, Feishu, Google Chat, IRC, LINE, Matrix, Mattermost,
  Microsoft Teams, Nextcloud Talk, Nostr, QQ Bot, Raft, Signal, Slack, SMS, Synology Chat,
  Tlon, Twitch, Voice Call, WhatsApp, Zalo, and Zalo Personal
- External plugin channels maintained outside the OpenClaw repo: WeChat, Yuanbao, and Zalo ClawBot
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
- Custom and self-hosted provider support (vLLM, SGLang, Ollama, llama.cpp, LM Studio, and
  any OpenAI-compatible or Anthropic-compatible endpoint)

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

## Related

<CardGroup cols={2}>
  <Card title="Experimental features" href="/concepts/experimental-features" icon="flask">
    Opt-in features that have not yet shipped to the default surface.
  </Card>
  <Card title="Agent runtime" href="/concepts/agent" icon="robot">
    Agent runtime model and how runs are dispatched.
  </Card>
  <Card title="Channels" href="/channels" icon="message-square">
    Connect Telegram, WhatsApp, Discord, Slack, and more from one Gateway.
  </Card>
  <Card title="Plugins" href="/tools/plugin" icon="plug">
    Official and external plugins that extend OpenClaw.
  </Card>
</CardGroup>
