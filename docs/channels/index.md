---
summary: "Messaging platforms Clawdbot can connect to"
read_when:
  - You want to choose a chat channel for Clawdbot
  - You need a quick overview of supported messaging platforms
---
# Chat Channels

Clawdbot can talk to you on any chat app you already use. Each channel connects via the Gateway.
Text is supported everywhere; media and reactions vary by channel.

## Supported channels

- [WhatsApp](/channels/whatsapp) — Most popular; uses Baileys and requires QR pairing.
- [Telegram](/channels/telegram) — Bot API via grammY; supports groups.
- [Discord](/channels/discord) — Discord Bot API + Gateway; supports servers, channels, and DMs.
- [Slack](/channels/slack) — Bolt SDK; workspace apps.
- [Signal](/channels/signal) — signal-cli; privacy-focused.
- [iMessage](/channels/imessage) — macOS only; native integration.
- [Microsoft Teams](/channels/msteams) — Bot Framework; enterprise support (plugin, installed separately).
- [Matrix](/channels/matrix) — Matrix protocol (plugin, installed separately).
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnam's popular messenger (plugin, installed separately).
- [Zalo Personal](/channels/zalouser) — Zalo personal account via QR login (plugin, installed separately).
- [WebChat](/web/webchat) — Gateway WebChat UI over WebSocket.

## Notes

- Channels can run simultaneously; configure multiple and Clawdbot will route per chat.
- Group behavior varies by channel; see [Groups](/concepts/groups).
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).
- Telegram internals: [grammY notes](/channels/grammy).
- Troubleshooting: [Channel troubleshooting](/channels/troubleshooting).
- Model providers are documented separately; see [Model Providers](/providers/models).
