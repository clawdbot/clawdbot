---
summary: "Matrix client setup, E2EE requirements, and configuration"
read_when:
  - Setting up the Matrix provider
  - Debugging Matrix E2EE or threading
---
# Matrix (Client-Server API)

Updated: 2026-01-06

Status: Node-only with E2EE enabled by default (Rust crypto).

## Goals
- Talk to Clawdbot via Matrix DMs or rooms.
- Direct chats collapse into the agent's main session (default `agent:main:main`).
- Rooms are isolated as `agent:<agentId>:matrix:channel:<roomId>`.
- Keep routing deterministic: replies always go back to the provider they arrived on.

## Runtime + E2EE
Matrix uses the official `matrix-js-sdk` with Rust crypto. That means:
- **Node-only** runtime (Bun is unsupported for Matrix).
- E2EE is **on by default** (`matrix.encryption=true`).
- If you join encrypted rooms, verify the Clawdbot device in your Matrix client so it can decrypt messages.
- Crypto state is in-memory on Node today (no persistent IndexedDB store), so restarts require re-verification and may not decrypt history until keys are shared again.

## Access tokens (recommended)
Matrix does not have a "bot token." Use a user account access token.

### Get a token via password login
Use a login request to retrieve `access_token`, `user_id`, and `device_id`:

```bash
curl -sS "https://matrix.example/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "@clawdbot:example" },
    "password": "YOUR_PASSWORD"
  }'
```

Then set `matrix.homeserver`, `matrix.userId`, `matrix.accessToken`, and optionally `matrix.deviceId`.

### Password login (optional)
If you set `matrix.password`, Clawdbot will log in at startup to obtain a token.
For long-running gateways, prefer a pre-generated `accessToken`.

## DMs + rooms
- **DM detection uses `m.direct` only.** If `m.direct` isn't set for a user, their chat will be treated as a room.
- DM policy is controlled via `matrix.dm.policy` (pairing/allowlist/open/disabled).
- Room allowlists + mention defaults live under `matrix.rooms` and `matrix.groupPolicy`.
- Set `matrix.allowlistOnly=true` to require explicit allowlists for both rooms and DMs.

## Threads + replies
- When an inbound message is a **thread reply**, Clawdbot replies in the thread by default.
- `matrix.threadReplies` controls thread behavior:
  - `inbound` (default): reply in a thread only if the sender opened one.
  - `always`: always reply in threads.
  - `off`: never reply in threads.
- `matrix.replyToMode` controls non-thread reply tags (`off` | `first` | `all`).

## Auto-join
- `matrix.autoJoin` defaults to `"always"`.
- To restrict invites, set `matrix.autoJoin="allowlist"` and fill `matrix.autoJoinAllowlist` with room ids or aliases.

## Config

```json5
{
  matrix: {
    enabled: true,
    homeserver: "https://matrix.example",
    userId: "@clawdbot:example",
    accessToken: "syt_...",
    deviceId: "CLAWDBOT",
    deviceName: "Clawdbot Gateway",
    storePath: "~/.clawdbot/credentials/matrix/store",
    cryptoStorePath: "~/.clawdbot/credentials/matrix/crypto",
    encryption: true,
    autoJoin: "always", // always | allowlist | off
    autoJoinAllowlist: ["!roomid:example", "#ops:example"],
    groupPolicy: "open", // open | allowlist | disabled
    allowlistOnly: false,
    dm: {
      enabled: true,
      policy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["@owner:example", "@ops:example", "*"]
    },
    rooms: {
      "*": { requireMention: true },
      "!roomid:example": {
        allow: true,
        autoReply: false,
        skills: ["docs"],
        systemPrompt: "Keep answers short."
      }
    },
    replyToMode: "off", // off | first | all
    threadReplies: "inbound", // inbound | always | off
    textChunkLimit: 4000,
    mediaMaxMb: 20
  }
}
```

Env vars (optional):
- `MATRIX_HOMESERVER`
- `MATRIX_USER_ID`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_PASSWORD`
- `MATRIX_DEVICE_ID`
- `MATRIX_DEVICE_NAME`
- `MATRIX_STORE_PATH`
- `MATRIX_CRYPTO_STORE_PATH`

## Sending (CLI/cron)
- Deliver to rooms with `room:<roomId>` (DMs are rooms too).
- Replies always go back to the originating room.

Example:

```bash
clawdbot send --provider matrix --to "room:!roomid:example" --message "hello"
```

## Capabilities & limits
- Encrypted + unencrypted rooms (E2EE on by default).
- Threads and replies, typing indicators, reactions (where supported by the room).
- Media uploads via Matrix content repository; size capped by `matrix.mediaMaxMb`.
- Media uploads are disabled in encrypted rooms (E2EE) for now.
