---
summary: "Matrix support status, capabilities, and configuration"
read_when:
  - Working on Matrix channel features
---
# Matrix (plugin)

Matrix is an open, decentralized messaging protocol. Clawdbot connects as a Matrix **user**
on any homeserver, so you need a Matrix account for the bot. Once it is logged in, you can DM
the bot directly or invite it to rooms (Matrix "groups"). Beeper is a valid client option too,
but it requires E2EE to be enabled.

Status: supported via plugin (matrix-bot-sdk). Direct messages, rooms, threads, media, reactions,
polls (send + poll-start as text), location, and E2EE (with crypto support).

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

## Setup

1) Install the Matrix plugin:
   - From npm: `clawdbot plugins install @clawdbot/matrix`
   - From a local checkout: `clawdbot plugins install ./extensions/matrix`
2) Create a Matrix account on a homeserver:
   - Browse hosting options at [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Or host it yourself.
3) Get an access token for the bot account:
   - Use the Matrix login API with `curl` at your home server:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Replace `matrix.example.org` with your homeserver URL.
   - Or set `channels.matrix.userId` + `channels.matrix.password`: Clawdbot calls the same
     login endpoint, stores the access token in `~/.clawdbot/credentials/matrix/credentials.json`,
     and reuses it on next start.
4) Configure credentials:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (or `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Or config: `channels.matrix.*`
   - If both are set, config takes precedence.
   - With access token: user ID is fetched automatically via `/whoami`.
   - When set, `channels.matrix.userId` should be the full Matrix ID (example: `@bot:example.org`).
5) Restart the gateway (or finish onboarding).
6) Start a DM with the bot or invite it to a room from any Matrix client
   (Element, Beeper, etc.; see https://matrix.org/ecosystem/clients/). Beeper requires E2EE,
   so set `channels.matrix.encryption: true` and verify the device.

Minimal config (access token, user ID auto-fetched):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" }
    }
  }
}
```

E2EE config (end to end encryption enabled):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" }
    }
  }
}
```

## Encryption (E2EE)

End-to-end encryption is **supported** via the Rust crypto SDK.

Enable with `channels.matrix.encryption: true`:

- If the crypto module loads, encrypted rooms are decrypted automatically.
- Outbound media is encrypted when sending to encrypted rooms.
- On first connection, Clawdbot requests device verification from your other sessions.
- Verify the device in another Matrix client (Element, etc.) to enable key sharing.
- If the crypto module cannot be loaded, E2EE is disabled and encrypted rooms will not decrypt;
  Clawdbot logs a warning.
- If you see missing crypto module errors (for example, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  allow build scripts for `@matrix-org/matrix-sdk-crypto-nodejs` and run
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` or fetch the binary with
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Crypto state is stored per account + access token in
`~/.clawdbot/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite database). Sync state lives alongside it in `bot-storage.json`.
If the access token (device) changes, a new store is created and the bot must be
re-verified for encrypted rooms.

**Device verification:**
When E2EE is enabled, the bot will request verification from your other sessions on startup.
Open Element (or another client) and approve the verification request to establish trust.
Once verified, the bot can decrypt messages in encrypted rooms.

## Routing model

- Replies always go back to Matrix.
- DMs share the agent's main session; rooms map to group sessions.

## Access control (DMs)

- Default: `channels.matrix.dm.policy = "pairing"`. Unknown senders get a pairing code.
- Approve via:
  - `clawdbot pairing list matrix`
  - `clawdbot pairing approve matrix <CODE>`
- Public DMs: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepts user IDs or display names. The wizard resolves display names to user IDs when directory search is available.

## Rooms (groups)

- Default: `channels.matrix.groupPolicy = "allowlist"` (mention-gated). Use `channels.defaults.groupPolicy` to override the default when unset.
- Allowlist rooms with `channels.matrix.groups` (room IDs, aliases, or names):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true }
      },
      groupAllowFrom: ["@owner:example.org"]
    }
  }
}
```

- `requireMention: false` enables auto-reply in that room.
- `groups."*"` can set defaults for mention gating across rooms.
- `groupAllowFrom` restricts which senders can trigger the bot in rooms (optional).
- Per-room `users` allowlists can further restrict senders inside a specific room.
- The configure wizard prompts for room allowlists (room IDs, aliases, or names) and resolves names when possible.
- On startup, Clawdbot resolves room/user names in allowlists to IDs and logs the mapping; unresolved entries are kept as typed.
- Invites are auto-joined by default; control with `channels.matrix.autoJoin` and `channels.matrix.autoJoinAllowlist`.
- To allow **no rooms**, set `channels.matrix.groupPolicy: "disabled"` (or keep an empty allowlist).
- Legacy key: `channels.matrix.rooms` (same shape as `groups`).

## Threads

- Reply threading is supported.
- `channels.matrix.threadReplies` controls whether replies stay in threads:
  - `off`, `inbound` (default), `always`
- `channels.matrix.replyToMode` controls reply-to metadata when not replying in a thread:
  - `off` (default), `first`, `all`

## Capabilities

| Feature | Status |
|---------|--------|
| Direct messages | ✅ Supported |
| Rooms | ✅ Supported |
| Threads | ✅ Supported |
| Media | ✅ Supported |
| E2EE | ✅ Supported (crypto module required) |
| Reactions | ✅ Supported (send/read via tools) |
| Polls | ✅ Send supported; inbound poll starts are converted to text (responses/ends ignored) |
| Location | ✅ Supported (geo URI; altitude ignored) |
| Native commands | ✅ Supported |

## Configuration reference (Matrix)

Full configuration: [Configuration](/gateway/configuration)

Provider options:

- `channels.matrix.enabled`: enable/disable channel startup.
- `channels.matrix.homeserver`: homeserver URL.
- `channels.matrix.userId`: Matrix user ID (optional with access token).
- `channels.matrix.accessToken`: access token.
- `channels.matrix.password`: password for login (token stored).
- `channels.matrix.deviceName`: device display name.
- `channels.matrix.encryption`: enable E2EE (default: false).
- `channels.matrix.initialSyncLimit`: initial sync limit.
- `channels.matrix.threadReplies`: `off | inbound | always` (default: inbound).
- `channels.matrix.textChunkLimit`: outbound text chunk size (chars).
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.matrix.dm.allowFrom`: DM allowlist (user IDs or display names). `open` requires `"*"`. The wizard resolves names to IDs when possible.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (default: allowlist).
- `channels.matrix.groupAllowFrom`: allowlisted senders for group messages.
- `channels.matrix.allowlistOnly`: force allowlist rules for DMs + rooms.
- `channels.matrix.groups`: group allowlist + per-room settings map.
- `channels.matrix.rooms`: legacy group allowlist/config.
- `channels.matrix.replyToMode`: reply-to mode for threads/tags.
- `channels.matrix.mediaMaxMb`: inbound/outbound media cap (MB).
- `channels.matrix.autoJoin`: invite handling (`always | allowlist | off`, default: always).
- `channels.matrix.autoJoinAllowlist`: allowed room IDs/aliases for auto-join.
- `channels.matrix.actions`: per-action tool gating (reactions/messages/pins/memberInfo/channelInfo).
