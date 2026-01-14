---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new iOS/Android node
  - Reviewing Clawdbot security posture
---

# Pairing

“Pairing” is Clawdbot’s explicit **owner approval** step.
It is used in two places:

1) **DM pairing** (who is allowed to talk to the bot)
2) **Node pairing** (which devices/nodes are allowed to join the gateway network)

Security context: [Security](/gateway/security)

## 1) DM pairing (inbound chat access)

When a channel is configured with DM policy `pairing`, unknown senders get a short code and their message is **not processed** until you approve.

Default DM policies are documented in: [Security](/gateway/security)

Pairing codes:
- 8 characters, uppercase, no ambiguous chars (`0O1I`).
- **Expire after 1 hour**. The bot only sends the pairing message when a new request is created (roughly once per hour per sender).
- Pending DM pairing requests are capped at **3 per channel** by default; additional requests are ignored until one expires or is approved.

### Approve a sender

```bash
clawdbot pairing list telegram
clawdbot pairing approve telegram <CODE>
```

Supported channels: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Where the state lives

Stored under `~/.clawdbot/credentials/`:
- Pending requests: `<channel>-pairing.json`
- Approved allowlist store: `<channel>-allowFrom.json`

Treat these as sensitive (they gate access to your assistant).


## 2) Node pairing (iOS/Android nodes joining the gateway)

Nodes (iOS/Android, future hardware, etc.) connect to the Gateway and request to join.
The Gateway keeps an authoritative allowlist; new nodes require explicit approve/reject.

### Approve a node

```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

### Where the state lives

Stored under `~/.clawdbot/nodes/`:
- `pending.json` (short-lived; pending requests expire)
- `paired.json` (paired nodes + tokens)

### Details

Full protocol + design notes: [Gateway pairing](/gateway/pairing)


## Related docs

- Security model + prompt injection: [Security](/gateway/security)
- Updating safely (run doctor): [Updating](/install/updating)
- Channel configs:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - iMessage: [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
