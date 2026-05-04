---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new iOS/Android node
  - Reviewing OpenClaw security posture
title: "Pairing"
---

“Pairing” is OpenClaw’s explicit access approval step.
It is used in two places:

1. **DM pairing** (who is allowed to talk to the bot)
2. **Node pairing** (which devices/nodes are allowed to join the gateway network)

Security context: [Security](/gateway/security)

## 1) DM pairing (inbound chat access)

When a channel is configured with DM policy `pairing`, unknown senders get a short code and their message is **not processed** until you approve.

Default DM policies are documented in: [Security](/gateway/security)

`dmPolicy: "open"` is public only when the effective DM allowlist includes `"*"`.
Setup and validation require that wildcard for public-open configs. If existing
state contains `open` with concrete `allowFrom` entries, runtime still admits
only those senders, and pairing-store approvals do not widen `open` access.

Pairing codes:

- 8 characters, uppercase, no ambiguous chars (`0O1I`).
- **Expire after 1 hour**. The bot only sends the pairing message when a new request is created (roughly once per hour per sender).
- Pending DM pairing requests are capped at **3 per channel** by default; additional requests are ignored until one expires or is approved.

### Approve a sender

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

If no command owner is configured yet, approving a DM pairing code also bootstraps
`commands.ownerAllowFrom` to the approved sender, such as `telegram:123456789`.
That gives first-time setups an explicit owner for privileged commands and exec
approval prompts. After an owner exists, later pairing approvals only grant DM
access; they do not add more owners.

Supported channels: `bluebubbles`, `discord`, `feishu`, `googlechat`, `imessage`, `irc`, `line`, `matrix`, `mattermost`, `msteams`, `nextcloud-talk`, `nostr`, `openclaw-weixin`, `signal`, `slack`, `synology-chat`, `telegram`, `twitch`, `whatsapp`, `zalo`, `zalouser`.

### Reusable sender groups

Use top-level `accessGroups` when the same trusted sender set should apply to
multiple message channels or to both DM and group allowlists.

Static groups use `type: "message.senders"` and are referenced with
`accessGroup:<name>` from channel allowlists:

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
        whatsapp: ["+15551234567"],
      },
    },
  },
  channels: {
    telegram: { dmPolicy: "allowlist", allowFrom: ["accessGroup:operators"] },
    whatsapp: { groupPolicy: "allowlist", groupAllowFrom: ["accessGroup:operators"] },
  },
}
```

Access groups are documented in detail here: [Access groups](/channels/access-groups)

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
The pairing allowlist store is for DM access. Group authorization is separate.
Approving a DM pairing code does not automatically allow that sender to run group
commands or control the bot in groups. First-owner bootstrap is separate config
state in `commands.ownerAllowFrom`, and group chat delivery still follows the
channel's group allowlists (for example `groupAllowFrom`, `groups`, or per-group
or per-topic overrides depending on the channel).
</Note>

## 2) Node device pairing (iOS/Android/macOS/headless nodes)

Nodes connect to the Gateway as **devices** with `role: node`. The Gateway
creates a device pairing request that must be approved.

### Pair via Telegram (recommended for iOS)

If you use the `device-pair` plugin, you can do first-time device pairing entirely from Telegram:

1. In Telegram, message your bot: `/pair`
2. The bot replies with two messages: an instruction message and a separate **setup code** message (easy to copy/paste in Telegram).
3. On your phone, open the OpenClaw iOS app → Settings → Gateway.
4. Scan the QR code or paste the setup code and connect.
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

For Tailscale, public, or other non-loopback mobile pairing, use Tailscale
Serve/Funnel or another `wss://` Gateway URL. Direct non-loopback `ws://` setup
URLs are rejected before QR/setup-code issuance. Plaintext `ws://` setup codes
are limited to loopback URLs; private-network `ws://` clients still require the explicit
`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` break-glass described in the remote
Gateway guide.

### Approve a node device

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

When an explicit approval is denied because the approving paired-device session
was opened with pairing-only scope, the CLI retries the same request with
`operator.admin`. This lets an existing admin-capable paired device recover a new
Control UI/browser pairing without editing `devices/paired.json` by hand. The
Gateway still validates the retried connection; tokens that cannot authenticate
with `operator.admin` remain blocked.

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

- The legacy `node.pair.*` API (CLI: `openclaw nodes pending|approve|reject|remove|rename`) is a
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
