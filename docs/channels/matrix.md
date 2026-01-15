---
summary: "Matrix support status, capabilities, and configuration"
read_when:
  - Working on Matrix channel features
---
# Matrix (plugin)

Status: supported via plugin (matrix-js-sdk). Direct messages, rooms, threads, media, reactions, and polls.

## Plugin required
Matrix ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):
```bash
clawdbot plugins install @clawdbot/matrix
```

Local checkout (when running from a git repo):
```bash
clawdbot plugins install ./extensions/matrix
```

If you choose Matrix during configure/onboarding and a git checkout is detected,
Clawdbot will offer the local install path automatically.

Details: [Plugins](/plugin)

## Quick setup (beginner)
1) Install the Matrix plugin:
   - From npm: `clawdbot plugins install @clawdbot/matrix`
   - From a local checkout: `clawdbot plugins install ./extensions/matrix`
2) Configure credentials:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN` (or `MATRIX_PASSWORD`)
   - Or config: `channels.matrix.*`
3) Restart the gateway (or finish onboarding).
4) DM access defaults to pairing; approve the pairing code on first contact.

Runtime note: Matrix requires Node.js (Bun is not supported).

Minimal config:
```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@clawdbot:example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" }
    }
  }
}
```

## Encryption (E2EE)
End-to-end encrypted rooms are **not** supported.
- Use unencrypted rooms or disable encryption when creating the room.
- If a room is E2EE, the bot will receive encrypted events and won’t reply.

## What it is
Matrix is an open messaging protocol. Clawdbot connects as a Matrix user and listens to DMs and rooms.
- A Matrix user account owned by the Gateway.
- Deterministic routing: replies go back to Matrix.
- DMs share the agent's main session; rooms map to group sessions.

## Access control (DMs)
- Default: `channels.matrix.dm.policy = "pairing"`. Unknown senders get a pairing code.
- Approve via:
  - `clawdbot pairing list matrix`
  - `clawdbot pairing approve matrix <CODE>`
- Public DMs: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.

## Rooms (groups)
- Default: `channels.matrix.groupPolicy = "allowlist"` (mention-gated).
- Allowlist rooms with `channels.matrix.rooms`:
```json5
{
  channels: {
    matrix: {
      rooms: {
        "!roomId:example.org": { requireMention: true }
      }
    }
  }
}
```
- `requireMention: false` enables auto-reply in that room.

## Threads
- Reply threading is supported.
- `channels.matrix.replyToMode` controls replies when tagged:
  - `off` (default), `first`, `all`

## Capabilities
| Feature | Status |
|---------|--------|
| Direct messages | ✅ Supported |
| Rooms | ✅ Supported |
| Threads | ✅ Supported |
| Media | ✅ Supported |
| Reactions | ✅ Supported |
| Polls | ✅ Supported |
| Native commands | ✅ Supported |

## Configuration reference (Matrix)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `channels.matrix.enabled`: enable/disable channel startup.
- `channels.matrix.homeserver`: homeserver URL.
- `channels.matrix.userId`: Matrix user ID.
- `channels.matrix.accessToken`: access token.
- `channels.matrix.password`: password for login (token stored).
- `channels.matrix.deviceName`: device display name.
- `channels.matrix.initialSyncLimit`: initial sync limit.
- `channels.matrix.threadReplies`: `off | inbound | always` (default: inbound).
- `channels.matrix.textChunkLimit`: outbound text chunk size (chars).
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.matrix.dm.allowFrom`: DM allowlist. `open` requires `"*"`.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (default: allowlist).
- `channels.matrix.allowlistOnly`: force allowlist rules for DMs + rooms.
- `channels.matrix.rooms`: per-room settings and allowlist.
- `channels.matrix.replyToMode`: reply-to mode for threads/tags.
- `channels.matrix.mediaMaxMb`: inbound/outbound media cap (MB).
- `channels.matrix.autoJoin`: invite handling (`always | allowlist | off`, default: always).
- `channels.matrix.autoJoinAllowlist`: allowed room IDs/aliases for auto-join.
- `channels.matrix.actions`: per-action tool gating (reactions/messages/pins/memberInfo/channelInfo).
