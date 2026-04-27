---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new iOS/Android node
  - Reviewing OpenClaw security posture
title: "Pairing"
---

“Pairing” is OpenClaw’s explicit **owner approval** step.
It is used in two places:

1. **DM pairing** (who is allowed to talk to the bot)
2. **Node pairing** (which devices/nodes are allowed to join the gateway network)

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
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Supported channels: `bluebubbles`, `discord`, `feishu`, `googlechat`, `imessage`, `irc`, `line`, `matrix`, `mattermost`, `msteams`, `nextcloud-talk`, `nostr`, `openclaw-weixin`, `signal`, `slack`, `synology-chat`, `telegram`, `twitch`, `whatsapp`, `zalo`, `zalouser`.

### Where the state lives

Stored under `~/.openclaw/credentials/`:

- Pending requests: `<channel>-pairing.json`
- Approved allowlist store:
  - Default account: `<channel>-allowFrom.json`
  - Non-default account: `<channel>-<accountId>-allowFrom.json`

Account scoping behavior:

- Non-default accounts read/write only their scoped allowlist file.
- Default account uses the channel-scoped unscoped allowlist file.

Treat these as sensitive (they gate access to your assistant).

<Note>
This store is for DM access. Group authorization is separate. Approving a DM pairing code does not automatically allow that sender to run group commands or control the bot in groups. For group access, configure the channel's explicit group allowlists (for example `groupAllowFrom`, `groups`, or per-group or per-topic overrides depending on the channel).
</Note>

## 2) Node device pairing (iOS/Android/macOS/headless nodes)

Nodes connect to the Gateway as **devices** with `role: node`. The Gateway
creates a device pairing request that must be approved.

### Pair via Telegram (recommended for iOS)

If you use the `device-pair` plugin, you can do first-time device pairing entirely from Telegram:

1. In Telegram, message your bot: `/pair`
2. The bot replies with two messages: an instruction message and a separate **setup code** message (easy to copy/paste in Telegram).
3. On your phone, open the OpenClaw iOS app → Settings → Gateway.
4. Paste the setup code and connect.
5. Back in Telegram: `/pair pending` (review request IDs, role, and scopes), then approve.

The setup code is a base64-encoded JSON payload that contains:

- `url`: the Gateway WebSocket URL (`ws://...` or `wss://...`)
- `bootstrapToken`: a short-lived single-device bootstrap token used for the initial pairing handshake

That bootstrap token carries the built-in pairing bootstrap profile:

- primary handed-off `node` token stays `scopes: []`
- any handed-off `operator` token stays bounded to the bootstrap allowlist:
  `operator.approvals`, `operator.read`, `operator.talk.secrets`, `operator.write`
- bootstrap scope checks are role-prefixed, not one flat scope pool:
  operator scope entries only satisfy operator requests, and non-operator roles
  must still request scopes under their own role prefix
- later token rotation/revocation remains bounded by both the device's approved
  role contract and the caller session's operator scopes

Treat the setup code like a password while it is valid.

### Approve a node device

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

If the same device retries with different auth details (for example different
role/scopes/public key), the previous pending request is superseded and a new
`requestId` is created.

<Note>
An already paired device does not get broader access silently. If it reconnects asking for more scopes or a broader role, OpenClaw keeps the existing approval as-is and creates a fresh pending upgrade request. Use `openclaw devices list` to compare the currently approved access with the newly requested access before you approve.
</Note>

### Optional trusted-CIDR node auto-approve

Device pairing remains manual by default. For tightly controlled node networks,
you can opt in to first-time node auto-approval with explicit CIDRs or exact IPs:

```json5
{
  gateway: {
    nodes: {
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
      },
    },
  },
}
```

This only applies to fresh `role: node` pairing requests with no requested
scopes. Operator, browser, Control UI, and WebChat clients still require manual
approval. Role, scope, metadata, and public-key changes still require manual
approval.

### Node pairing state storage

Stored under `~/.openclaw/devices/`:

- `pending.json` (short-lived; pending requests expire)
- `paired.json` (paired devices + tokens)

### Notes

- The legacy `node.pair.*` API (CLI: `openclaw nodes pending|approve|reject|rename`) is a
  separate gateway-owned pairing store. WS nodes still require device pairing.
- The pairing record is the durable source of truth for approved roles. Active
  device tokens stay bounded to that approved role set; a stray token entry
  outside the approved roles does not create new access.

## Related docs

- Security model + prompt injection: [Security](/gateway/security)
- Updating safely (run doctor): [Updating](/install/updating)
- Channel configs:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
