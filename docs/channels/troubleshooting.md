---
summary: "Channel-specific troubleshooting shortcuts (Discord/Telegram/WhatsApp)"
read_when:
  - A channel connects but messages don’t flow
  - Investigating channel misconfiguration (intents, permissions, privacy mode)
---
# Channel troubleshooting

Start with:

```bash
clawdbot doctor
clawdbot channels status --probe
```

`channels status --probe` prints warnings when it can detect common channel misconfigurations, and includes small live checks (credentials, some permissions/membership).

## Channels
- Discord: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)
- Telegram: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)
- WhatsApp: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram quick fixes
- Logs show `HttpError: Network request for 'sendMessage' failed` or `sendChatAction` → check IPv6 DNS. If `api.telegram.org` resolves to IPv6 first and the host lacks IPv6 egress, force IPv4 or enable IPv6. See [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting).
- Logs show `setMyCommands failed` → check outbound HTTPS and DNS reachability to `api.telegram.org` (common on locked-down VPS or proxies).
