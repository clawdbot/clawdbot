---
summary: "Matrix support status, setup, and configuration examples"
read_when:
  - Setting up Matrix in OpenClaw
  - Configuring Matrix E2EE and verification
title: "Matrix"
---

# Matrix

Matrix is a bundled channel plugin for OpenClaw.
It uses the official `matrix-js-sdk` and supports DMs, rooms, threads, media, reactions, polls, location, and E2EE.

## Bundled plugin

Matrix ships as a bundled plugin in current OpenClaw releases, so normal
packaged builds do not need a separate install.

If you are on an older build or a custom install that excludes Matrix, install
it manually:

Install from npm:

```bash
openclaw plugins install @openclaw/matrix
```

Install from a local checkout:

```bash
openclaw plugins install ./path/to/local/matrix-plugin
```

See [Plugins](/tools/plugin) for plugin behavior and install rules.

## Setup

1. Ensure the Matrix plugin is available.
   - Current packaged OpenClaw releases already bundle it.
   - Older/custom installs can add it manually with the commands above.
2. Create a Matrix account on your homeserver.
3. Configure `channels.matrix` with either:
   - `homeserver` + `accessToken`, or
   - `homeserver` + `userId` + `password`.
4. Restart the gateway.
5. Start a DM with the bot or invite it to a room.
   - Fresh Matrix invites only work when `channels.matrix.autoJoin` allows them.

Interactive setup paths:

```bash
openclaw channels add
openclaw configure --section channels
```

The Matrix wizard asks for:

- homeserver URL
- auth method: access token or password
- user ID (password auth only)
- optional device name
- whether to enable E2EE
- whether to configure room access and invite auto-join

Key wizard behaviors:

- If Matrix auth env vars already exist and that account does not already have auth saved in config, the wizard offers an env shortcut to keep auth in env vars.
- Account names are normalized to the account ID. For example, `Ops Bot` becomes `ops-bot`.
- DM allowlist entries accept `@user:server` directly; display names only work when live directory lookup finds one exact match.
- Room allowlist entries accept room IDs and aliases directly. Prefer `!room:server` or `#alias:server`; unresolved names are ignored at runtime by allowlist resolution.
- In invite auto-join allowlist mode, use only stable invite targets: `!roomId:server`, `#alias:server`, or `*`. Plain room names are rejected.
- To resolve room names before saving, use `openclaw channels resolve --channel matrix "Project Room"`.

<Warning>
`channels.matrix.autoJoin` defaults to `off`.

If you leave it unset, the bot will not join invited rooms or fresh DM-style invites, so it will not appear in new groups or invited DMs unless you join manually first.

Set `autoJoin: "allowlist"` together with `autoJoinAllowlist` to restrict which invites it accepts, or set `autoJoin: "always"` if you want it to join every invite.

In `allowlist` mode, `autoJoinAllowlist` only accepts `!roomId:server`, `#alias:server`, or `*`.
</Warning>

Allowlist example:

```json5
{
  channels: {
    matrix: {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:example.org", "#support:example.org"],
      groups: {
        "!ops:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

Join every invite:

```json5
{
  channels: {
    matrix: {
      autoJoin: "always",
    },
  },
}
```

Minimal token-based setup:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      dm: { policy: "pairing" },
    },
  },
}
```

Password-based setup (token is cached after login):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "replace-me", // pragma: allowlist secret
      deviceName: "OpenClaw Gateway",
    },
  },
}
```

Matrix stores cached credentials in `~/.openclaw/credentials/matrix/`.
The default account uses `credentials.json`; named accounts use `credentials-<account>.json`.
When cached credentials exist there, OpenClaw treats Matrix as configured for setup, doctor, and channel-status discovery even if current auth is not set directly in config.

Environment variable equivalents (used when the config key is not set):

- `MATRIX_HOMESERVER`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_PASSWORD`
- `MATRIX_DEVICE_ID`
- `MATRIX_DEVICE_NAME`

For non-default accounts, use account-scoped env vars:

- `MATRIX_<ACCOUNT_ID>_HOMESERVER`
- `MATRIX_<ACCOUNT_ID>_ACCESS_TOKEN`
- `MATRIX_<ACCOUNT_ID>_USER_ID`
- `MATRIX_<ACCOUNT_ID>_PASSWORD`
- `MATRIX_<ACCOUNT_ID>_DEVICE_ID`
- `MATRIX_<ACCOUNT_ID>_DEVICE_NAME`

Example for account `ops`:

- `MATRIX_OPS_HOMESERVER`
- `MATRIX_OPS_ACCESS_TOKEN`

For normalized account ID `ops-bot`, use:

- `MATRIX_OPS_X2D_BOT_HOMESERVER`
- `MATRIX_OPS_X2D_BOT_ACCESS_TOKEN`

Matrix escapes punctuation in account IDs to keep scoped env vars collision-free.
For example, `-` becomes `_X2D_`, so `ops-prod` maps to `MATRIX_OPS_X2D_PROD_*`.

The interactive wizard only offers the env-var shortcut when those auth env vars are already present and the selected account does not already have Matrix auth saved in config.

`MATRIX_HOMESERVER` cannot be set from a workspace `.env`; see [Workspace `.env` files](/gateway/security).

## Configuration example

This is a practical baseline config with DM pairing, room allowlist, and E2EE enabled:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,

      dm: {
        policy: "pairing",
        sessionScope: "per-room",
        threadReplies: "off",
      },

      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },

      autoJoin: "allowlist",
      autoJoinAllowlist: ["!roomid:example.org"],
      threadReplies: "inbound",
      replyToMode: "off",
      streaming: "partial",
    },
  },
}
```

`autoJoin` applies to all Matrix invites, including DM-style invites. OpenClaw cannot reliably
classify an invited room as a DM or group at invite time, so all invites go through `autoJoin`
first. `dm.policy` applies after the bot has joined and the room is classified as a DM.

## Streaming previews

Matrix reply streaming is opt-in.

Set `channels.matrix.streaming` to `"partial"` when you want OpenClaw to send a single live preview
reply, edit that preview in place while the model is generating text, and then finalize it when the
reply is done:

```json5
{
  channels: {
    matrix: {
      streaming: "partial",
    },
  },
}
```

- `streaming: "off"` is the default. OpenClaw waits for the final reply and sends it once.
- `streaming: "partial"` creates one editable preview message for the current assistant block using normal Matrix text messages. This preserves Matrix's legacy preview-first notification behavior, so stock clients may notify on the first streamed preview text instead of the finished block.
- `streaming: "quiet"` creates one editable quiet preview notice for the current assistant block. Use this only when you also configure recipient push rules for finalized preview edits.
- `blockStreaming: true` enables separate Matrix progress messages. With preview streaming enabled, Matrix keeps the live draft for the current block and preserves completed blocks as separate messages.
- When preview streaming is on and `blockStreaming` is off, Matrix edits the live draft in place and finalizes that same event when the block or turn finishes.
- If the preview no longer fits in one Matrix event, OpenClaw stops preview streaming and falls back to normal final delivery.
- Media replies still send attachments normally. If a stale preview can no longer be reused safely, OpenClaw redacts it before sending the final media reply.
- Preview edits cost extra Matrix API calls. Leave streaming off if you want the most conservative rate-limit behavior.

`blockStreaming` does not enable draft previews by itself.
Use `streaming: "partial"` or `streaming: "quiet"` for preview edits; then add `blockStreaming: true` only if you also want completed assistant blocks to remain visible as separate progress messages.

If you need stock Matrix notifications without custom push rules, use `streaming: "partial"` for preview-first behavior or leave `streaming` off for final-only delivery. With `streaming: "off"`:

- `blockStreaming: true` sends each finished block as a normal notifying Matrix message.
- `blockStreaming: false` sends only the final completed reply as a normal notifying Matrix message.

### Self-hosted push rules for quiet finalized previews

If you run your own Matrix infrastructure and want quiet previews to notify only when a block or
final reply is done, set `streaming: "quiet"` and add a per-user push rule for finalized preview edits.

This is usually a recipient-user setup, not a homeserver-global config change:

Quick map before you start:

- recipient user = the person who should receive the notification
- bot user = the OpenClaw Matrix account that sends the reply
- use the recipient user's access token for the API calls below
- match `sender` in the push rule against the bot user's full MXID

1. Configure OpenClaw to use quiet previews:

```json5
{
  channels: {
    matrix: {
      streaming: "quiet",
    },
  },
}
```

2. Make sure the recipient account already receives normal Matrix push notifications. Quiet preview
   rules only work if that user already has working pushers/devices.

3. Get the recipient user's access token.
   - Use the receiving user's token, not the bot's token.
   - Reusing an existing client session token is usually easiest.
   - If you need to mint a fresh token, you can log in through the standard Matrix Client-Server API:

```bash
curl -sS -X POST \
  "https://matrix.example.org/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "m.login.password",
    "identifier": {
      "type": "m.id.user",
      "user": "@alice:example.org"
    },
    "password": "REDACTED"
  }'
```

4. Verify the recipient account already has pushers:

```bash
curl -sS \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushers"
```

If this returns no active pushers/devices, fix normal Matrix notifications first before adding the
OpenClaw rule below.

OpenClaw marks finalized text-only preview edits with:

```json
{
  "com.openclaw.finalized_preview": true
}
```

5. Create an override push rule for each recipient account which should receive these notifications:

```bash
curl -sS -X PUT \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "conditions": [
      { "kind": "event_match", "key": "type", "pattern": "m.room.message" },
      {
        "kind": "event_property_is",
        "key": "content.m\\.relates_to.rel_type",
        "value": "m.replace"
      },
      {
        "kind": "event_property_is",
        "key": "content.com\\.openclaw\\.finalized_preview",
        "value": true
      },
      { "kind": "event_match", "key": "sender", "pattern": "@bot:example.org" }
    ],
    "actions": [
      "notify",
      { "set_tweak": "sound", "value": "default" },
      { "set_tweak": "highlight", "value": false }
    ]
  }'
```

Replace these values before you run the command:

- `https://matrix.example.org`: your homeserver base URL
- `$USER_ACCESS_TOKEN`: the receiving user's access token
- `openclaw-finalized-preview-botname`: a rule ID unique to this bot for this receiving user
- `@bot:example.org`: your OpenClaw Matrix bot MXID, not the receiving user's MXID

Important for multi-bot setups:

- Push rules are keyed by `ruleId`. Re-running `PUT` against the same rule ID updates that one rule.
- If one receiving user should notify for multiple OpenClaw Matrix bot accounts, create one rule per bot with a unique rule ID for each sender match.
- A simple pattern is `openclaw-finalized-preview-<botname>`, such as `openclaw-finalized-preview-ops` or `openclaw-finalized-preview-support`.

The rule is evaluated against the event sender:

- authenticate with the receiving user's token
- match `sender` against the OpenClaw bot MXID

6. Verify the rule exists:

```bash
curl -sS \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname"
```

7. Test a streamed reply. In quiet mode, the room should show a quiet draft preview and the final
   in-place edit should notify once the block or turn finishes.

If you need to remove the rule later, delete that same rule ID with the receiving user's token:

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  "https://matrix.example.org/_matrix/client/v3/pushrules/global/override/openclaw-finalized-preview-botname"
```

Notes:

- Create the rule with the receiving user's access token, not the bot's.
- New user-defined `override` rules are inserted ahead of default suppress rules, so no extra ordering parameter is needed.
- This only affects text-only preview edits that OpenClaw can safely finalize in place. Media fallbacks and stale-preview fallbacks still use normal Matrix delivery.
- If `GET /_matrix/client/v3/pushers` shows no pushers, the user does not yet have working Matrix push delivery for this account/device.

#### Synapse

For Synapse, the setup above is usually enough by itself:

- No special `homeserver.yaml` change is required for finalized OpenClaw preview notifications.
- If your Synapse deployment already sends normal Matrix push notifications, the user token + `pushrules` call above is the main setup step.
- If you run Synapse behind a reverse proxy or workers, make sure `/_matrix/client/.../pushrules/` reaches Synapse correctly.
- If you run Synapse workers, make sure pushers are healthy. Push delivery is handled by the main process or `synapse.app.pusher` / configured pusher workers.

#### Tuwunel

For Tuwunel, use the same setup flow and push-rule API call shown above:

- No Tuwunel-specific config is required for the finalized preview marker itself.
- If normal Matrix notifications already work for that user, the user token + `pushrules` call above is the main setup step.
- If notifications seem to disappear while the user is active on another device, check whether `suppress_push_when_active` is enabled. Tuwunel added this option in Tuwunel 1.4.2 on September 12, 2025, and it can intentionally suppress pushes to other devices while one device is active.

## Bot-to-bot rooms

By default, Matrix messages from other configured OpenClaw Matrix accounts are ignored.

Use `allowBots` when you intentionally want inter-agent Matrix traffic:

```json5
{
  channels: {
    matrix: {
      allowBots: "mentions", // true | "mentions"
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

- `allowBots: true` accepts messages from other configured Matrix bot accounts in allowed rooms and DMs.
- `allowBots: "mentions"` accepts those messages only when they visibly mention this bot in rooms. DMs are still allowed.
- `groups.<room>.allowBots` overrides the account-level setting for one room.
- OpenClaw still ignores messages from the same Matrix user ID to avoid self-reply loops.
- Matrix does not expose a native bot flag here; OpenClaw treats "bot-authored" as "sent by another configured Matrix account on this OpenClaw gateway".

Use strict room allowlists and mention requirements when enabling bot-to-bot traffic in shared rooms.

## Encryption and verification

In encrypted (E2EE) rooms, outbound image events use `thumbnail_file` so image previews are encrypted alongside the full attachment. Unencrypted rooms still use plain `thumbnail_url`. No configuration is needed — the plugin detects E2EE state automatically.

Enable encryption:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

Check verification status:

```bash
openclaw matrix verify status
```

Verbose status (full diagnostics):

```bash
openclaw matrix verify status --verbose
```

Include the stored recovery key in machine-readable output:

```bash
openclaw matrix verify status --include-recovery-key --json
```

Bootstrap cross-signing and verification state:

```bash
openclaw matrix verify bootstrap
```

Verbose bootstrap diagnostics:

```bash
openclaw matrix verify bootstrap --verbose
```

Force a fresh cross-signing identity reset before bootstrapping:

```bash
openclaw matrix verify bootstrap --force-reset-cross-signing
```

Verify this device with a recovery key:

```bash
openclaw matrix verify device "<your-recovery-key>"
```

Verbose device verification details:

```bash
openclaw matrix verify device "<your-recovery-key>" --verbose
```

Check room-key backup health:

```bash
openclaw matrix verify backup status
```

Verbose backup health diagnostics:

```bash
openclaw matrix verify backup status --verbose
```

Restore room keys from server backup:

```bash
openclaw matrix verify backup restore
```

Verbose restore diagnostics:

```bash
openclaw matrix verify backup restore --verbose
```

Delete the current server backup and create a fresh backup baseline. If the stored
backup key cannot be loaded cleanly, this reset can also recreate secret storage so
future cold starts can load the new backup key:

```bash
openclaw matrix verify backup reset --yes
```

All `verify` commands are concise by default (including quiet internal SDK logging) and show detailed diagnostics only with `--verbose`.
Use `--json` for full machine-readable output when scripting.

In multi-account setups, Matrix CLI commands use the implicit Matrix default account unless you pass `--account <id>`.
If you configure multiple named accounts, set `channels.matrix.defaultAccount` first or those implicit CLI operations will stop and ask you to choose an account explicitly.
Use `--account` whenever you want verification or device operations to target a named account explicitly:

```bash
openclaw matrix verify status --account assistant
openclaw matrix verify backup restore --account assistant
openclaw matrix devices list --account assistant
```

When encryption is disabled or unavailable for a named account, Matrix warnings and verification errors point at that account's config key, for example `channels.matrix.accounts.assistant.encryption`.

### What "verified" means

OpenClaw treats this Matrix device as verified only when it is verified by your own cross-signing identity.
In practice, `openclaw matrix verify status --verbose` exposes three trust signals:

- `Locally trusted`: this device is trusted by the current client only
- `Cross-signing verified`: the SDK reports the device as verified through cross-signing
- `Signed by owner`: the device is signed by your own self-signing key

`Verified by owner` becomes `yes` only when cross-signing verification or owner-signing is present.
Local trust by itself is not enough for OpenClaw to treat the device as fully verified.

### What bootstrap does

`openclaw matrix verify bootstrap` is the repair and setup command for encrypted Matrix accounts.
It does all of the following in order:

- bootstraps secret storage, reusing an existing recovery key when possible
- bootstraps cross-signing and uploads missing public cross-signing keys
- attempts to mark and cross-sign the current device
- creates a new server-side room-key backup if one does not already exist

If the homeserver requires interactive auth to upload cross-signing keys, OpenClaw tries the upload without auth first, then with `m.login.dummy`, then with `m.login.password` when `channels.matrix.password` is configured.

Use `--force-reset-cross-signing` only when you intentionally want to discard the current cross-signing identity and create a new one.

If you intentionally want to discard the current room-key backup and start a new
backup baseline for future messages, use `openclaw matrix verify backup reset --yes`.
Do this only when you accept that unrecoverable old encrypted history will stay
unavailable and that OpenClaw may recreate secret storage if the current backup
secret cannot be loaded safely.

### Fresh backup baseline

If you want to keep future encrypted messages working and accept losing unrecoverable old history, run these commands in order:

```bash
openclaw matrix verify backup reset --yes
openclaw matrix verify backup status --verbose
openclaw matrix verify status
```

Add `--account <id>` to each command when you want to target a named Matrix account explicitly.

### Startup behavior

When `encryption: true`, Matrix defaults `startupVerification` to `"if-unverified"`.
On startup, if this device is still unverified, Matrix will request self-verification in another Matrix client,
skip duplicate requests while one is already pending, and apply a local cooldown before retrying after restarts.
Failed request attempts retry sooner than successful request creation by default.
Set `startupVerification: "off"` to disable automatic startup requests, or tune `startupVerificationCooldownHours`
if you want a shorter or longer retry window.

Startup also performs a conservative crypto bootstrap pass automatically.
That pass tries to reuse the current secret storage and cross-signing identity first, and avoids resetting cross-signing unless you run an explicit bootstrap repair flow.

If startup still finds broken bootstrap state, OpenClaw can attempt a guarded repair path even when `channels.matrix.password` is not configured.
If the homeserver requires password-based UIA for that repair, OpenClaw logs a warning and keeps startup non-fatal instead of aborting the bot.
If the current device is already owner-signed, OpenClaw preserves that identity instead of resetting it automatically.

See [Matrix migration](/install/migrating-matrix) for the full upgrade flow, limits, recovery commands, and common migration messages.

### Verification notices

Matrix posts verification lifecycle notices directly into the strict DM verification room as `m.notice` messages.
That includes:

- verification request notices
- verification ready notices (with explicit "Verify by emoji" guidance)
- verification start and completion notices
- SAS details (emoji and decimal) when available

Incoming verification requests from another Matrix client are tracked and auto-accepted by OpenClaw.
For self-verification flows, OpenClaw also starts the SAS flow automatically when emoji verification becomes available and confirms its own side.
For verification requests from another Matrix user/device, OpenClaw auto-accepts the request and then waits for the SAS flow to proceed normally.
You still need to compare the emoji or decimal SAS in your Matrix client and confirm "They match" there to complete the verification.

OpenClaw does not auto-accept self-initiated duplicate flows blindly. Startup skips creating a new request when a self-verification request is already pending.

Verification protocol/system notices are not forwarded to the agent chat pipeline, so they do not produce `NO_REPLY`.

### Device hygiene

Old OpenClaw-managed Matrix devices can accumulate on the account and make encrypted-room trust harder to reason about.
List them with:

```bash
openclaw matrix devices list
```

Remove stale OpenClaw-managed devices with:

```bash
openclaw matrix devices prune-stale
```

### Crypto store

Matrix E2EE uses the official `matrix-js-sdk` Rust crypto path in Node, with `fake-indexeddb` as the IndexedDB shim. Crypto state is persisted to a snapshot file (`crypto-idb-snapshot.json`) and restored on startup. The snapshot file is sensitive runtime state stored with restrictive file permissions.

Encrypted runtime state lives under per-account, per-user token-hash roots in
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/`.
That directory contains the sync store (`bot-storage.json`), crypto store (`crypto/`),
recovery key file (`recovery-key.json`), IndexedDB snapshot (`crypto-idb-snapshot.json`),
thread bindings (`thread-bindings.json`), and startup verification state (`startup-verification.json`).
When the token changes but the account identity stays the same, OpenClaw reuses the best existing
root for that account/homeserver/user tuple so prior sync state, crypto state, thread bindings,
and startup verification state remain visible.

## Profile management

Update the Matrix self-profile for the selected account with:

```bash
openclaw matrix profile set --name "OpenClaw Assistant"
openclaw matrix profile set --avatar-url https://cdn.example.org/avatar.png
```

Add `--account <id>` when you want to target a named Matrix account explicitly.

Matrix accepts `mxc://` avatar URLs directly. When you pass an `http://` or `https://` avatar URL, OpenClaw uploads it to Matrix first and stores the resolved `mxc://` URL back into `channels.matrix.avatarUrl` (or the selected account override).

## Threads

Matrix supports native Matrix threads for both automatic replies and message-tool sends.

- `dm.sessionScope: "per-user"` (default) keeps Matrix DM routing sender-scoped, so multiple DM rooms can share one session when they resolve to the same peer.
- `dm.sessionScope: "per-room"` isolates each Matrix DM room into its own session key while still using normal DM auth and allowlist checks.
- Explicit Matrix conversation bindings still win over `dm.sessionScope`, so bound rooms and threads keep their chosen target session.
- `threadReplies: "off"` keeps replies top-level and keeps inbound threaded messages on the parent session.
- `threadReplies: "inbound"` replies inside a thread only when the inbound message was already in that thread.
- `threadReplies: "always"` keeps room replies in a thread rooted at the triggering message and routes that conversation through the matching thread-scoped session from the first triggering message.
- `dm.threadReplies` overrides the top-level setting for DMs only. For example, you can keep room threads isolated while keeping DMs flat.
- Inbound threaded messages include the thread root message as extra agent context.
- Message-tool sends auto-inherit the current Matrix thread when the target is the same room, or the same DM user target, unless an explicit `threadId` is provided.
- Same-session DM user-target reuse only kicks in when the current session metadata proves the same DM peer on the same Matrix account; otherwise OpenClaw falls back to normal user-scoped routing.
- When OpenClaw sees a Matrix DM room collide with another DM room on the same shared Matrix DM session, it posts a one-time `m.notice` in that room with the `/focus` escape hatch when thread bindings are enabled and the `dm.sessionScope` hint.
- Runtime thread bindings are supported for Matrix. `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`, and thread-bound `/acp spawn` work in Matrix rooms and DMs.
- Top-level Matrix room/DM `/focus` creates a new Matrix thread and binds it to the target session when `threadBindings.spawnSubagentSessions=true`.
- Running `/focus` or `/acp spawn --thread here` inside an existing Matrix thread binds that current thread instead.

## ACP conversation bindings

Matrix rooms, DMs, and existing Matrix threads can be turned into durable ACP workspaces without changing the chat surface.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the Matrix DM, room, or existing thread you want to keep using.
- In a top-level Matrix DM or room, the current DM/room stays the chat surface and future messages route to the spawned ACP session.
- Inside an existing Matrix thread, `--bind here` binds that current thread in place.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

Notes:

- `--bind here` does not create a child Matrix thread.
- `threadBindings.spawnAcpSessions` is only required for `/acp spawn --thread auto|here`, where OpenClaw needs to create or bind a child Matrix thread.

### Thread binding config

Matrix inherits global defaults from `session.threadBindings`, and also supports per-channel overrides:

- `threadBindings.enabled`
- `threadBindings.idleHours`
- `threadBindings.maxAgeHours`
- `threadBindings.spawnSubagentSessions`
- `threadBindings.spawnAcpSessions`

Matrix thread-bound spawn flags are opt-in:

- Set `threadBindings.spawnSubagentSessions: true` to allow top-level `/focus` to create and bind new Matrix threads.
- Set `threadBindings.spawnAcpSessions: true` to allow `/acp spawn --thread auto|here` to bind ACP sessions to Matrix threads.

## Reactions

Matrix supports outbound reaction actions, inbound reaction notifications, and inbound ack reactions.

- Outbound reaction tooling is gated by `channels["matrix"].actions.reactions`.
- `react` adds a reaction to a specific Matrix event.
- `reactions` lists the current reaction summary for a specific Matrix event.
- `emoji=""` removes the bot account's own reactions on that event.
- `remove: true` removes only the specified emoji reaction from the bot account.

Ack reactions use the standard OpenClaw resolution order:

- `channels["matrix"].accounts.<accountId>.ackReaction`
- `channels["matrix"].ackReaction`
- `messages.ackReaction`
- agent identity emoji fallback

Ack reaction scope resolves in this order:

- `channels["matrix"].accounts.<accountId>.ackReactionScope`
- `channels["matrix"].ackReactionScope`
- `messages.ackReactionScope`

Reaction notification mode resolves in this order:

- `channels["matrix"].accounts.<accountId>.reactionNotifications`
- `channels["matrix"].reactionNotifications`
- default: `own`

Behavior:

- `reactionNotifications: "own"` forwards added `m.reaction` events when they target bot-authored Matrix messages.
- `reactionNotifications: "off"` disables reaction system events.
- Reaction removals are not synthesized into system events because Matrix surfaces those as redactions, not as standalone `m.reaction` removals.

## History context

- `channels.matrix.historyLimit` controls how many recent room messages are included as `InboundHistory` when a Matrix room message triggers the agent. Falls back to `messages.groupChat.historyLimit`; if both are unset, the effective default is `0`. Set `0` to disable.
- Matrix room history is room-only. DMs keep using normal session history.
- Matrix room history is pending-only: OpenClaw buffers room messages that did not trigger a reply yet, then snapshots that window when a mention or other trigger arrives.
- The current trigger message is not included in `InboundHistory`; it stays in the main inbound body for that turn.
- Retries of the same Matrix event reuse the original history snapshot instead of drifting forward to newer room messages.

## Context visibility

Matrix supports the shared `contextVisibility` control for supplemental room context such as fetched reply text, thread roots, and pending history.

- `contextVisibility: "all"` is the default. Supplemental context is kept as received.
- `contextVisibility: "allowlist"` filters supplemental context to senders allowed by the active room/user allowlist checks.
- `contextVisibility: "allowlist_quote"` behaves like `allowlist`, but still keeps one explicit quoted reply.

This setting affects supplemental context visibility, not whether the inbound message itself can trigger a reply.
Trigger authorization still comes from `groupPolicy`, `groups`, `groupAllowFrom`, and DM policy settings.

## DM and room policy

```json5
{
  channels: {
    matrix: {
      dm: {
        policy: "allowlist",
        allowFrom: ["@admin:example.org"],
        threadReplies: "off",
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

See [Groups](/channels/groups) for mention-gating and allowlist behavior.

Pairing example for Matrix DMs:

```bash
openclaw pairing list matrix
openclaw pairing approve matrix <CODE>
```

If an unapproved Matrix user keeps messaging you before approval, OpenClaw reuses the same pending pairing code and may send a reminder reply again after a short cooldown instead of minting a new code.

See [Pairing](/channels/pairing) for the shared DM pairing flow and storage layout.

## Direct room repair

If direct-message state gets out of sync, OpenClaw can end up with stale `m.direct` mappings that point at old solo rooms instead of the live DM. Inspect the current mapping for a peer with:

```bash
openclaw matrix direct inspect --user-id @alice:example.org
```

Repair it with:

```bash
openclaw matrix direct repair --user-id @alice:example.org
```

The repair flow:

- prefers a strict 1:1 DM that is already mapped in `m.direct`
- falls back to any currently joined strict 1:1 DM with that user
- creates a fresh direct room and rewrites `m.direct` if no healthy DM exists

The repair flow does not delete old rooms automatically. It only picks the healthy DM and updates the mapping so new Matrix sends, verification notices, and other direct-message flows target the right room again.

## Exec approvals

Matrix can act as a native approval client for a Matrix account. The native
DM/channel routing knobs still live under exec approval config:

- `channels.matrix.execApprovals.enabled`
- `channels.matrix.execApprovals.approvers` (optional; falls back to `channels.matrix.dm.allowFrom`)
- `channels.matrix.execApprovals.target` (`dm` | `channel` | `both`, default: `dm`)
- `channels.matrix.execApprovals.agentFilter`
- `channels.matrix.execApprovals.sessionFilter`

Approvers must be Matrix user IDs such as `@owner:example.org`. Matrix auto-enables native approvals when `enabled` is unset or `"auto"` and at least one approver can be resolved. Exec approvals use `execApprovals.approvers` first and can fall back to `channels.matrix.dm.allowFrom`. Plugin approvals authorize through `channels.matrix.dm.allowFrom`. Set `enabled: false` to disable Matrix as a native approval client explicitly. Approval requests otherwise fall back to other configured approval routes or the approval fallback policy.

Matrix native routing supports both approval kinds:

- `channels.matrix.execApprovals.*` controls the native DM/channel fanout mode for Matrix approval prompts.
- Exec approvals use the exec approver set from `execApprovals.approvers` or `channels.matrix.dm.allowFrom`.
- Plugin approvals use the Matrix DM allowlist from `channels.matrix.dm.allowFrom`.
- Matrix reaction shortcuts and message updates apply to both exec and plugin approvals.

Delivery rules:

- `target: "dm"` sends approval prompts to approver DMs
- `target: "channel"` sends the prompt back to the originating Matrix room or DM
- `target: "both"` sends to approver DMs and the originating Matrix room or DM

Matrix approval prompts seed reaction shortcuts on the primary approval message:

- `✅` = allow once
- `❌` = deny
- `♾️` = allow always when that decision is allowed by the effective exec policy

Approvers can react on that message or use the fallback slash commands: `/approve <id> allow-once`, `/approve <id> allow-always`, or `/approve <id> deny`.

Only resolved approvers can approve or deny. For exec approvals, channel delivery includes the command text, so only enable `channel` or `both` in trusted rooms.

Per-account override:

- `channels.matrix.accounts.<account>.execApprovals`

Related docs: [Exec approvals](/tools/exec-approvals)

## Slash commands

Matrix slash commands (for example `/new`, `/reset`, `/model`) work directly in DMs. In rooms, OpenClaw also recognizes slash commands that are prefixed with the bot's own Matrix mention, so `@bot:server /new` triggers the command path without needing a custom mention regex. This keeps the bot responsive to room-style `@mention /command` posts that Element and similar clients emit when a user tab-completes the bot before typing the command.

Authorization rules still apply: command senders must satisfy DM or room allowlist/owner policies just like plain messages.

## Multi-account

```json5
{
  channels: {
    matrix: {
      enabled: true,
      defaultAccount: "assistant",
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_xxx",
          encryption: true,
        },
        alerts: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_xxx",
          dm: {
            policy: "allowlist",
            allowFrom: ["@ops:example.org"],
            threadReplies: "off",
          },
        },
      },
    },
  },
}
```

Top-level `channels.matrix` values act as defaults for named accounts unless an account overrides them.
You can scope inherited room entries to one Matrix account with `groups.<room>.account`.
Entries without `account` stay shared across all Matrix accounts, and entries with `account: "default"` still work when the default account is configured directly on top-level `channels.matrix.*`.
Partial shared auth defaults do not create a separate implicit default account by themselves. OpenClaw only synthesizes the top-level `default` account when that default has fresh auth (`homeserver` plus `accessToken`, or `homeserver` plus `userId` and `password`); named accounts can still stay discoverable from `homeserver` plus `userId` when cached credentials satisfy auth later.
If Matrix already has exactly one named account, or `defaultAccount` points at an existing named account key, single-account-to-multi-account repair/setup promotion preserves that account instead of creating a fresh `accounts.default` entry. Only Matrix auth/bootstrap keys move into that promoted account; shared delivery-policy keys stay at the top level.
Set `defaultAccount` when you want OpenClaw to prefer one named Matrix account for implicit routing, probing, and CLI operations.
If multiple Matrix accounts are configured and one account id is `default`, OpenClaw uses that account implicitly even when `defaultAccount` is unset.
If you configure multiple named accounts, set `defaultAccount` or pass `--account <id>` for CLI commands that rely on implicit account selection.
Pass `--account <id>` to `openclaw matrix verify ...` and `openclaw matrix devices ...` when you want to override that implicit selection for one command.

See [Configuration reference](/gateway/configuration-reference#multi-account-all-channels) for the shared multi-account pattern.

## Private/LAN homeservers

By default, OpenClaw blocks private/internal Matrix homeservers for SSRF protection unless you
explicitly opt in per account.

If your homeserver runs on localhost, a LAN/Tailscale IP, or an internal hostname, enable
`network.dangerouslyAllowPrivateNetwork` for that Matrix account:

```json5
{
  channels: {
    matrix: {
      homeserver: "http://matrix-synapse:8008",
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
      accessToken: "syt_internal_xxx",
    },
  },
}
```

CLI setup example:

```bash
openclaw matrix account add \
  --account ops \
  --homeserver http://matrix-synapse:8008 \
  --allow-private-network \
  --access-token syt_ops_xxx
```

This opt-in only allows trusted private/internal targets. Public cleartext homeservers such as
`http://matrix.example.org:8008` remain blocked. Prefer `https://` whenever possible.

## Proxying Matrix traffic

If your Matrix deployment needs an explicit outbound HTTP(S) proxy, set `channels.matrix.proxy`:

```json5
{
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      accessToken: "syt_bot_xxx",
      proxy: "http://127.0.0.1:7890",
    },
  },
}
```

Named accounts can override the top-level default with `channels.matrix.accounts.<id>.proxy`.
OpenClaw uses the same proxy setting for runtime Matrix traffic and account status probes.

## Target resolution

Matrix accepts these target forms anywhere OpenClaw asks you for a room or user target:

- Users: `@user:server`, `user:@user:server`, or `matrix:user:@user:server`
- Rooms: `!room:server`, `room:!room:server`, or `matrix:room:!room:server`
- Aliases: `#alias:server`, `channel:#alias:server`, or `matrix:channel:#alias:server`

Live directory lookup uses the logged-in Matrix account:

- User lookups query the Matrix user directory on that homeserver.
- Room lookups accept explicit room IDs and aliases directly, then fall back to searching joined room names for that account.
- Joined-room name lookup is best-effort. If a room name cannot be resolved to an ID or alias, it is ignored by runtime allowlist resolution.

## Configuration reference

- `enabled`: enable or disable the channel.
- `name`: optional label for the account.
- `defaultAccount`: preferred account ID when multiple Matrix accounts are configured.
- `homeserver`: homeserver URL, for example `https://matrix.example.org`.
- `network.dangerouslyAllowPrivateNetwork`: allow this Matrix account to connect to private/internal homeservers. Enable this when the homeserver resolves to `localhost`, a LAN/Tailscale IP, or an internal host such as `matrix-synapse`.
- `proxy`: optional HTTP(S) proxy URL for Matrix traffic. Named accounts can override the top-level default with their own `proxy`.
- `userId`: full Matrix user ID, for example `@bot:example.org`.
- `accessToken`: access token for token-based auth. Plaintext values and SecretRef values are supported for `channels.matrix.accessToken` and `channels.matrix.accounts.<id>.accessToken` across env/file/exec providers. See [Secrets Management](/gateway/secrets).
- `password`: password for password-based login. Plaintext values and SecretRef values are supported.
- `deviceId`: explicit Matrix device ID.
- `deviceName`: device display name for password login.
- `avatarUrl`: stored self-avatar URL for profile sync and `profile set` updates.
- `initialSyncLimit`: maximum number of events fetched during startup sync.
- `encryption`: enable E2EE.
- `allowlistOnly`: when `true`, upgrades `open` room policy to `allowlist`, and forces all active DM policies except `disabled` (including `pairing` and `open`) to `allowlist`. Does not affect `disabled` policies.
- `allowBots`: allow messages from other configured OpenClaw Matrix accounts (`true` or `"mentions"`).
- `groupPolicy`: `open`, `allowlist`, or `disabled`.
- `contextVisibility`: supplemental room-context visibility mode (`all`, `allowlist`, `allowlist_quote`).
- `groupAllowFrom`: allowlist of user IDs for room traffic. Full Matrix user IDs are safest; exact directory matches are resolved at startup and when the allowlist changes while the monitor is running. Unresolved names are ignored.
- `historyLimit`: max room messages to include as group history context. Falls back to `messages.groupChat.historyLimit`; if both are unset, the effective default is `0`. Set `0` to disable.
- `replyToMode`: `off`, `first`, `all`, or `batched`.
- `markdown`: optional Markdown rendering configuration for outbound Matrix text.
- `streaming`: `off` (default), `"partial"`, `"quiet"`, `true`, or `false`. `"partial"` and `true` enable preview-first draft updates with normal Matrix text messages. `"quiet"` uses non-notifying preview notices for self-hosted push-rule setups. `false` is equivalent to `"off"`.
- `blockStreaming`: `true` enables separate progress messages for completed assistant blocks while draft preview streaming is active.
- `threadReplies`: `off`, `inbound`, or `always`.
- `threadBindings`: per-channel overrides for thread-bound session routing and lifecycle.
- `startupVerification`: automatic self-verification request mode on startup (`if-unverified`, `off`).
- `startupVerificationCooldownHours`: cooldown before retrying automatic startup verification requests.
- `textChunkLimit`: outbound message chunk size in characters (applies when `chunkMode` is `length`).
- `chunkMode`: `length` splits messages by character count; `newline` splits at line boundaries.
- `responsePrefix`: optional string prepended to all outbound replies for this channel.
- `ackReaction`: optional ack reaction override for this channel/account.
- `ackReactionScope`: optional ack reaction scope override (`group-mentions`, `group-all`, `direct`, `all`, `none`, `off`).
- `reactionNotifications`: inbound reaction notification mode (`own`, `off`).
- `mediaMaxMb`: media size cap in MB for outbound sends and inbound media processing.
- `autoJoin`: invite auto-join policy (`always`, `allowlist`, `off`). Default: `off`. Applies to all Matrix invites, including DM-style invites.
- `autoJoinAllowlist`: rooms/aliases allowed when `autoJoin` is `allowlist`. Alias entries are resolved to room IDs during invite handling; OpenClaw does not trust alias state claimed by the invited room.
- `dm`: DM policy block (`enabled`, `policy`, `allowFrom`, `sessionScope`, `threadReplies`).
- `dm.policy`: controls DM access after OpenClaw has joined the room and classified it as a DM. It does not change whether an invite is auto-joined.
- `dm.allowFrom`: allowlist of user IDs for DM traffic. Full Matrix user IDs are safest; exact directory matches are resolved at startup and when the allowlist changes while the monitor is running. Unresolved names are ignored.
- `dm.sessionScope`: `per-user` (default) or `per-room`. Use `per-room` when you want each Matrix DM room to keep separate context even if the peer is the same.
- `dm.threadReplies`: DM-only thread policy override (`off`, `inbound`, `always`). It overrides the top-level `threadReplies` setting for both reply placement and session isolation in DMs.
- `execApprovals`: Matrix-native exec approval delivery (`enabled`, `approvers`, `target`, `agentFilter`, `sessionFilter`).
- `execApprovals.approvers`: Matrix user IDs allowed to approve exec requests. Optional when `dm.allowFrom` already identifies the approvers.
- `execApprovals.target`: `dm | channel | both` (default: `dm`).
- `accounts`: named per-account overrides. Top-level `channels.matrix` values act as defaults for these entries.
- `groups`: per-room policy map. Prefer room IDs or aliases; unresolved room names are ignored at runtime. Session/group identity uses the stable room ID after resolution.
- `groups.<room>.account`: restrict one inherited room entry to a specific Matrix account in multi-account setups.
- `groups.<room>.allowBots`: room-level override for configured-bot senders (`true` or `"mentions"`).
- `groups.<room>.users`: per-room sender allowlist.
- `groups.<room>.tools`: per-room tool allow/deny overrides.
- `groups.<room>.autoReply`: room-level mention-gating override. `true` disables mention requirements for that room; `false` forces them back on.
- `groups.<room>.skills`: optional room-level skill filter.
- `groups.<room>.systemPrompt`: optional room-level system prompt snippet.
- `rooms`: legacy alias for `groups`.
- `actions`: per-action tool gating (`messages`, `reactions`, `pins`, `profile`, `memberInfo`, `channelInfo`, `verification`).

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
