---
summary: "Matrix support status, setup, and configuration examples"
read_when:
  - Setting up Matrix in OpenClaw
  - Configuring Matrix E2EE and verification
title: "Matrix"
---

Matrix is a downloadable channel plugin (`@openclaw/matrix`) built on the official `matrix-js-sdk`. It supports DMs, rooms, threads, media, reactions, polls, location, and E2EE.

## Install

```bash
openclaw plugins install @openclaw/matrix
```

Bare plugin specs try ClawHub first, then npm fallback. Force a source with `openclaw plugins install clawhub:@openclaw/matrix` or `npm:@openclaw/matrix`. From a local checkout: `openclaw plugins install ./path/to/local/matrix-plugin`.

`plugins install` registers and enables the plugin; no separate `enable` step is needed. The channel still does nothing until configured below. See [Plugins](/tools/plugin) for general install rules.

## Setup

1. Create a Matrix account on your homeserver.
2. Configure `channels.matrix` with `homeserver` + `accessToken`, or `homeserver` + `userId` + `password`.
3. Restart the gateway.
4. Start a DM with the bot, or invite it to a room. Fresh invites only land when [`autoJoin`](#auto-join) allows them.

### Interactive setup

```bash
openclaw channels add
openclaw configure --section channels
```

The wizard asks for homeserver URL, auth method (token or password), user ID (password auth only), optional device name, whether to enable E2EE, and room access/auto-join. If matching `MATRIX_*` env vars already exist and the account has no saved auth, the wizard offers an env-var shortcut. Resolve room names before saving an allowlist with `openclaw channels resolve --channel matrix "Project Room"`. Enabling E2EE in the wizard runs the same bootstrap as [`openclaw matrix encryption setup`](#encryption-and-verification).

### Minimal config

Token-based:

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

Password-based (token is cached after first login):

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

### Auto-join

`channels.matrix.autoJoin` defaults to `"off"`: the bot will not appear in new rooms or DMs from fresh invites until you join manually. OpenClaw cannot tell at invite time whether an invite is a DM or a group, so every invite goes through `autoJoin` first; `dm.policy` only applies later, after the bot has joined and the room is classified.

<Warning>
Set `autoJoin: "allowlist"` plus `autoJoinAllowlist` to restrict accepted invites, or `autoJoin: "always"` to accept every invite.

`autoJoinAllowlist` accepts only `!roomId:server`, `#alias:server`, or `*`. Plain room names are rejected; aliases resolve against the homeserver, not against state the invited room claims.
</Warning>

```json5
{
  channels: {
    matrix: {
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:example.org", "#support:example.org"],
      groups: {
        "!ops:example.org": { requireMention: true },
      },
    },
  },
}
```

### Allowlist target formats

- DMs (`dm.allowFrom`, `groupAllowFrom`, `groups.<room>.users`): use `@user:server`. Display names are ignored by default (mutable); set `dangerouslyAllowNameMatching: true` only for explicit display-name compatibility.
- Room allowlist keys (`groups`, legacy alias `rooms`): use `!room:server` or `#alias:server`. Plain names are ignored unless `dangerouslyAllowNameMatching: true`.
- Invite allowlists (`autoJoinAllowlist`): use `!room:server`, `#alias:server`, or `*`. Plain names are always rejected.

### Account ID normalization

The wizard converts a friendly name into a normalized account ID (`Ops Bot` -> `ops-bot`). Punctuation is hex-escaped in scoped env-var names so accounts cannot collide: `-` (0x2D) becomes `_X2D_`, so `ops-prod` maps to env prefix `MATRIX_OPS_X2D_PROD_`.

### Cached credentials

Matrix caches credentials under `~/.openclaw/credentials/matrix/`: `credentials.json` for the default account, `credentials-<account>.json` for named accounts. When cached credentials exist, OpenClaw treats Matrix as configured even without an `accessToken` in the config file - this covers setup, `openclaw doctor`, and channel-status probes.

### Environment variables

Config-key-backed env vars, used when the equivalent config key is unset. The default account uses unprefixed names; named accounts insert the account token before the suffix (see [normalization](#account-id-normalization)).

| Default account       | Named account (`<ID>` = account token) |
| --------------------- | -------------------------------------- |
| `MATRIX_HOMESERVER`   | `MATRIX_<ID>_HOMESERVER`               |
| `MATRIX_ACCESS_TOKEN` | `MATRIX_<ID>_ACCESS_TOKEN`             |
| `MATRIX_USER_ID`      | `MATRIX_<ID>_USER_ID`                  |
| `MATRIX_PASSWORD`     | `MATRIX_<ID>_PASSWORD`                 |
| `MATRIX_DEVICE_ID`    | `MATRIX_<ID>_DEVICE_ID`                |
| `MATRIX_DEVICE_NAME`  | `MATRIX_<ID>_DEVICE_NAME`              |

For account `ops`, names become `MATRIX_OPS_HOMESERVER`, `MATRIX_OPS_ACCESS_TOKEN`, and so on. `MATRIX_HOMESERVER` (and any `*_HOMESERVER` scoped variant) cannot be set from a workspace `.env`; see [Workspace `.env` files](/gateway/security).

<Note>
The recovery key is not a config-backed env var: OpenClaw never reads it from the environment itself. CLI guidance text suggests piping it through a shell variable named `MATRIX_RECOVERY_KEY` for the default account, or `MATRIX_RECOVERY_KEY_<ID>` (plain uppercased account ID, no hex-escaping) for a named account - see [Verify this device with a recovery key](#verify-this-device-with-a-recovery-key).
</Note>

## Configuration example

A practical baseline with DM pairing, room allowlist, and E2EE:

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
        "!roomid:example.org": { requireMention: true },
      },

      autoJoin: "allowlist",
      autoJoinAllowlist: ["!roomid:example.org"],
      threadReplies: "inbound",
      replyToMode: "off",
      streaming: { mode: "partial" },
    },
  },
}
```

## Streaming previews

Matrix reply streaming is opt-in. `streaming.mode` controls how OpenClaw delivers the in-flight assistant reply; `streaming.block.enabled` controls whether each completed block is kept as its own Matrix message.

```json5
{
  channels: {
    matrix: {
      streaming: { mode: "partial" },
    },
  },
}
```

To keep live answer previews but hide interim tool/progress lines:

```json5
{
  channels: {
    matrix: {
      streaming: {
        mode: "partial",
        preview: {
          toolProgress: false,
        },
      },
    },
  },
}
```

The full config accepts `{ mode, chunkMode, block, preview, progress }`:

```json5
{
  channels: {
    matrix: {
      streaming: {
        mode: "progress",
        progress: {
          label: "auto", // pick from configured or built-in labels (false to hide)
          labels: ["Thinking", "Writing", "Searching"], // candidates for label: "auto"
          maxLines: 8, // max rolling progress lines (default: 8)
          maxLineChars: 120, // max chars per line before truncation (default: 120)
          toolProgress: true, // show tool/progress activity (default: true)
        },
      },
    },
  },
}
```

- `progress.label`: custom label, `"auto"`/unset to pick a configured or built-in label, or `false` to hide it.
- `progress.labels`: candidates used only when `label` is `"auto"` or unset.
- `progress.maxLines`: max rolling progress lines kept in the draft; older lines are trimmed past this.
- `progress.maxLineChars`: max characters per compact progress line before truncation.
- `progress.toolProgress`: when `true` (default), live tool/progress activity appears in the draft.

| `streaming.mode`  | Behavior                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"off"` (default) | Wait for the full reply, send once.                                                                                                                      |
| `"partial"`       | Edit one normal text message in place as the model writes the current block. Stock clients may notify on the first preview, not the final edit.          |
| `"quiet"`         | Same as `"partial"` but the message is a non-notifying notice. Recipients are notified once a per-user push rule matches the finalized edit (see below). |
| `"progress"`      | Sends individual compact progress lines using a progress draft.                                                                                          |

`streaming.block.enabled` (default `false`) is independent of `streaming.mode`:

| `streaming.mode`        | `block.enabled: true`                                               | `block.enabled: false` (default)                     |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `"partial"` / `"quiet"` | Live draft for the current block, completed blocks kept as messages | Live draft for the current block, finalized in place |
| `"off"`                 | One notifying Matrix message per finished block                     | One notifying Matrix message for the full reply      |

Notes:

- If a preview grows past Matrix's per-event size limit, OpenClaw stops preview streaming and falls back to final-only delivery.
- Media replies always send attachments normally; if a stale preview cannot be reused safely, OpenClaw redacts it before sending the final media reply.
- Tool-progress preview updates are on by default when preview streaming is active. Set `streaming.preview.toolProgress: false` to keep preview edits for answer text but leave tool progress on the normal delivery path.
- Preview edits cost extra Matrix API calls. Leave `streaming.mode: "off"` for the most conservative rate-limit profile.
- Legacy scalar/boolean `streaming` values and the flat `blockStreaming` / `chunkMode` keys are rewritten to this nested shape by `openclaw doctor --fix`.

## Voice messages

Inbound Matrix voice notes are transcribed before the room mention gate, so a voice note saying the bot name can trigger the agent in a `requireMention: true` room, and the agent gets the transcript instead of only an audio attachment placeholder.

Matrix uses the shared audio media provider under `tools.media.audio`, such as OpenAI `gpt-4o-mini-transcribe`. See [Media tools overview](/tools/media-overview) for provider setup and limits.

- `m.audio` events and `m.file` events with an `audio/*` MIME type are eligible.
- In encrypted rooms, OpenClaw decrypts the attachment through the existing Matrix media path before transcription.
- The transcript is marked machine-generated and untrusted in the agent prompt.
- The attachment is marked as already transcribed so downstream media tools do not transcribe it again.
- Set `tools.media.audio.enabled: false` to disable audio transcription globally.

## Approval metadata

Matrix native approval prompts are normal `m.room.message` events with OpenClaw-specific content under the `com.openclaw.approval` key. Stock clients still render the text body; OpenClaw-aware clients can read the structured approval id, kind, state, decisions, and exec/plugin details.

When a prompt is too long for one Matrix event, OpenClaw chunks the visible text and attaches `com.openclaw.approval` to the first chunk only. Allow/deny reactions bind to that first event, so long prompts keep the same approval target as single-event prompts.

### Self-hosted push rules for quiet finalized previews

`streaming.mode: "quiet"` only notifies recipients once a block or turn is finalized - a per-user push rule must match the finalized preview marker. See [Matrix push rules for quiet previews](/channels/matrix-push-rules) for the full recipe.

## Bot-to-bot rooms

By default, Matrix messages from other configured OpenClaw Matrix accounts are ignored. Use `allowBots` to intentionally allow inter-agent traffic:

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
- `allowBots: "mentions"` accepts those messages only when they visibly mention this bot in rooms; DMs are still allowed regardless.
- `groups.<room>.allowBots` overrides the account-level setting for one room.
- Accepted configured-bot messages use shared [bot loop protection](/channels/bot-loop-protection). Configure `channels.defaults.botLoopProtection`, then override per-account with `channels.matrix.botLoopProtection` or per-room with `channels.matrix.groups.<room>.botLoopProtection`.
- OpenClaw still ignores messages from the same Matrix user ID to avoid self-reply loops.
- Matrix has no native bot flag; OpenClaw treats "bot-authored" as "sent by another configured Matrix account on this OpenClaw gateway".

Use strict room allowlists and mention requirements when enabling bot-to-bot traffic in shared rooms.

## Encryption and verification

In encrypted (E2EE) rooms, outbound image events use `thumbnail_file` so image previews are encrypted alongside the full attachment; unencrypted rooms use plain `thumbnail_url`. No configuration is needed - the plugin detects E2EE state automatically.

All `openclaw matrix` commands accept `--verbose` (full diagnostics), `--json` (machine-readable output), and `--account <id>` (multi-account setups). Output is concise by default.

### Enable encryption

```bash
openclaw matrix encryption setup
```

Bootstraps secret storage and cross-signing, creates a room-key backup if needed, then prints status and next steps. Useful flags:

- `--recovery-key <key>` apply a recovery key before bootstrapping (prefer the stdin form below)
- `--force-reset-cross-signing` discard the current cross-signing identity and create a new one (intentional use only)

For a new account, enable E2EE at creation time:

```bash
openclaw matrix account add \
  --homeserver https://matrix.example.org \
  --access-token syt_xxx \
  --enable-e2ee
```

`--encryption` is an alias for `--enable-e2ee`. Manual config equivalent:

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

### Status and trust signals

```bash
openclaw matrix verify status
openclaw matrix verify status --include-recovery-key --json
```

`verify status` reports three independent trust signals (`--verbose` shows all of them):

- `Locally trusted`: trusted by this client only
- `Cross-signing verified`: the SDK reports verification via cross-signing
- `Signed by owner`: signed by your own self-signing key (diagnostic only)

`Verified by owner` is `yes` only when `Cross-signing verified` is `yes`; local trust or an owner signature alone is not enough.

`--allow-degraded-local-state` returns best-effort diagnostics without preparing the Matrix account first; useful for offline or partially-configured probes.

### Verify this device with a recovery key

Pipe the recovery key via stdin instead of passing it on the command line:

```bash
printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify device --recovery-key-stdin
```

The command reports three states:

- `Recovery key accepted`: Matrix accepted the key for secret storage or device trust.
- `Backup usable`: room-key backup can be loaded with the trusted recovery material.
- `Device verified by owner`: this device has full Matrix cross-signing identity trust.

It exits non-zero when full identity trust is incomplete, even if the recovery key unlocked backup material. In that case, finish self-verification from another Matrix client:

```bash
openclaw matrix verify self
```

`verify self` waits for `Cross-signing verified: yes` before exiting successfully. Use `--timeout-ms <ms>` to tune the wait.

The literal-key form `openclaw matrix verify device "<recovery-key>"` also works, but the key ends up in shell history.

### Bootstrap or repair cross-signing

```bash
openclaw matrix verify bootstrap
```

The repair/setup command for encrypted accounts. In order, it:

- bootstraps secret storage, reusing an existing recovery key when possible
- bootstraps cross-signing and uploads missing public keys
- marks and cross-signs the current device
- creates a server-side room-key backup if one does not already exist

If the homeserver requires UIA to upload cross-signing keys, OpenClaw tries no-auth first, then `m.login.dummy`, then `m.login.password` (requires `channels.matrix.password`).

Useful flags:

- `--recovery-key-stdin` (pair with `printf '%s\n' "$MATRIX_RECOVERY_KEY" | ...`) or `--recovery-key <key>`
- `--force-reset-cross-signing` to discard the current cross-signing identity (intentional only; requires the active recovery key stored or supplied with `--recovery-key-stdin`)

### Room-key backup

```bash
openclaw matrix verify backup status
printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin
```

`backup status` shows whether a server-side backup exists and whether this device can decrypt it. `backup restore` imports backed-up room keys into the local crypto store; omit `--recovery-key-stdin` if the recovery key is already on disk.

To replace a broken backup with a fresh baseline (accepts losing unrecoverable old history; can also recreate secret storage if the current backup secret is unloadable):

```bash
openclaw matrix verify backup reset --yes
```

Add `--rotate-recovery-key` only when the previous recovery key should intentionally stop unlocking the fresh backup baseline.

### Listing, requesting, and responding to verifications

```bash
openclaw matrix verify list
```

Lists pending verification requests for the selected account.

```bash
openclaw matrix verify request --own-user
openclaw matrix verify request --user-id @ops:example.org --device-id ABCDEF
```

Sends a verification request from this account. `--own-user` requests self-verification (accept the prompt in another Matrix client of the same user); `--user-id`/`--device-id`/`--room-id` target someone else. `--own-user` cannot combine with the other targeting flags.

For lower-level lifecycle handling - typically while shadowing inbound requests from another client - these commands act on a specific request `<id>` (printed by `verify list` and `verify request`):

| Command                                    | Purpose                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `openclaw matrix verify accept <id>`       | Accept an inbound request                                           |
| `openclaw matrix verify start <id>`        | Start the SAS flow                                                  |
| `openclaw matrix verify sas <id>`          | Print the SAS emoji or decimals                                     |
| `openclaw matrix verify confirm-sas <id>`  | Confirm that the SAS matches what the other client shows            |
| `openclaw matrix verify mismatch-sas <id>` | Reject the SAS when the emoji or decimals do not match              |
| `openclaw matrix verify cancel <id>`       | Cancel; takes optional `--reason <text>` and `--code <matrix-code>` |

`accept`, `start`, `sas`, `confirm-sas`, `mismatch-sas`, and `cancel` all accept `--user-id` and `--room-id` as DM follow-up hints when the verification is anchored to a specific direct-message room.

### Multi-account notes

Without `--account <id>`, Matrix CLI commands use the implicit default account. With multiple named accounts and no `channels.matrix.defaultAccount`, commands refuse to guess and ask you to choose. When E2EE is disabled or unavailable for a named account, errors point at that account's config key, for example `channels.matrix.accounts.assistant.encryption`.

<AccordionGroup>
  <Accordion title="Startup behavior">
    With `encryption: true`, `startupVerification` defaults to `"if-unverified"`. On startup an unverified device requests self-verification in another Matrix client, skipping duplicates and applying a cooldown (24 hours by default). Tune with `startupVerificationCooldownHours` or disable with `startupVerification: "off"`.

    Startup also runs a conservative crypto bootstrap pass reusing the current secret storage and cross-signing identity. If bootstrap state is broken, OpenClaw attempts a guarded repair even without `channels.matrix.password`; if the homeserver requires password UIA, startup logs a warning and stays non-fatal. Already-owner-signed devices are preserved.

    See [Matrix migration](/channels/matrix-migration) for the full upgrade flow.

  </Accordion>

  <Accordion title="Verification notices">
    Matrix posts verification lifecycle notices into the strict DM verification room as `m.notice` messages: request, ready (with "Verify by emoji" guidance), start/completion, and SAS (emoji/decimal) details when available.

    Incoming requests from another Matrix client are tracked and auto-accepted. For self-verification, OpenClaw starts the SAS flow automatically and confirms its own side once emoji verification is available - you still need to compare and confirm "They match" in your Matrix client.

    Verification system notices are not forwarded to the agent chat pipeline.

  </Accordion>

  <Accordion title="Deleted or invalid Matrix device">
    If `verify status` says the current device is no longer listed on the homeserver, create a new OpenClaw Matrix device. For password login:

```bash
openclaw matrix account add \
  --account assistant \
  --homeserver https://matrix.example.org \
  --user-id '@assistant:example.org' \
  --password '<password>' \
  --device-name OpenClaw-Gateway
```

    For token auth, create a fresh access token in your Matrix client or admin UI, then update OpenClaw:

```bash
openclaw matrix account add \
  --account assistant \
  --homeserver https://matrix.example.org \
  --access-token '<token>'
```

    Replace `assistant` with the account ID from the failed command, or omit `--account` for the default account.

  </Accordion>

  <Accordion title="Device hygiene">
    Old OpenClaw-managed devices can accumulate. List and prune:

```bash
openclaw matrix devices list
openclaw matrix devices prune-stale
```

  </Accordion>

  <Accordion title="Crypto store">
    Matrix E2EE uses the official `matrix-js-sdk` Rust crypto path with `fake-indexeddb` as the IndexedDB shim. Crypto state persists to `crypto-idb-snapshot.json` (restrictive file permissions).

    Encrypted runtime state lives under `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/` and includes the sync store, crypto store, recovery key, IDB snapshot, thread bindings, and startup verification state. When the token changes but the account identity stays the same, OpenClaw reuses the best existing root so prior state remains visible.

    A single older token-hash root can be a normal token-rotation continuity path. If OpenClaw logs `matrix: multiple populated token-hash storage roots detected`, inspect the account directory and archive stale sibling roots only after confirming the selected active root is healthy. Prefer moving stale roots into an `_archive/` directory over deleting them immediately.

  </Accordion>
</AccordionGroup>

## Profile management

```bash
openclaw matrix profile set --name "OpenClaw Assistant"
openclaw matrix profile set --avatar-url https://cdn.example.org/avatar.png
```

Pass both options in one call. Matrix accepts `mxc://` avatar URLs directly; passing `http://`/`https://` uploads the file first and stores the resolved `mxc://` URL into `channels.matrix.avatarUrl` (or the per-account override).

## Threads

Matrix supports native threads for both automatic replies and message-tool sends. Two independent knobs control behavior:

### Session routing (`sessionScope`)

`dm.sessionScope` decides how Matrix DM rooms map to OpenClaw sessions:

- `"per-user"` (default): all DM rooms with the same routed peer share one session.
- `"per-room"`: each Matrix DM room gets its own session key, even for the same peer.

Explicit conversation bindings always win over `sessionScope`; bound rooms and threads keep their chosen target session.

### Reply threading (`threadReplies`)

`threadReplies` decides where the bot posts its reply:

- `"off"`: replies are top-level. Inbound threaded messages stay on the parent session.
- `"inbound"`: reply inside a thread only when the inbound message was already in that thread.
- `"always"`: reply inside a thread rooted at the triggering message; that conversation routes through a matching thread-scoped session from the first trigger onward.

`dm.threadReplies` overrides this for DMs only - for example, keep room threads isolated while keeping DMs flat.

### Thread inheritance and slash commands

- Inbound threaded messages include the thread root message as extra agent context.
- Message-tool sends auto-inherit the current Matrix thread when targeting the same room (or the same DM user target), unless an explicit `threadId` is provided.
- DM user-target reuse only kicks in when current session metadata proves the same DM peer on the same Matrix account; otherwise OpenClaw falls back to normal user-scoped routing.
- `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`, and thread-bound `/acp spawn` all work in Matrix rooms and DMs.
- Top-level `/focus` creates a new Matrix thread and binds it to the target session when `threadBindings.spawnSessions` is enabled.
- Running `/focus` or `/acp spawn --thread here` inside an existing Matrix thread binds that thread in place.

When OpenClaw detects a Matrix DM room colliding with another DM room on the same shared session, it posts a one-time `m.notice` pointing to the `/focus` escape hatch and suggesting a `dm.sessionScope` change. The notice only appears when thread bindings are enabled.

## ACP conversation bindings

Matrix rooms, DMs, and existing Matrix threads can become durable ACP workspaces without changing the chat surface.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the Matrix DM, room, or existing thread to keep using.
- In a top-level DM or room, the current DM/room stays the chat surface and future messages route to the spawned ACP session.
- Inside an existing thread, `--bind here` binds that current thread in place.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

`--bind here` does not create a child Matrix thread. `threadBindings.spawnSessions` gates `/acp spawn --thread auto|here`, where OpenClaw needs to create or bind a child thread.

### Thread binding config

Matrix inherits global defaults from `session.threadBindings` and supports per-channel overrides:

- `threadBindings.enabled`
- `threadBindings.idleHours`
- `threadBindings.maxAgeHours`
- `threadBindings.spawnSessions`: gates both subagent and ACP thread spawns.
- `threadBindings.spawnSubagentSessions` / `threadBindings.spawnAcpSessions`: narrower overrides for subagent-only or ACP-only spawns.
- `threadBindings.defaultSpawnContext`

Matrix thread-bound session spawns default on. Set `threadBindings.spawnSessions: false` to block top-level `/focus` and `/acp spawn --thread auto|here` from creating/binding Matrix threads. Set `threadBindings.defaultSpawnContext: "isolated"` when native subagent thread spawns should not fork the parent transcript.

## Reactions

Matrix supports outbound reactions, inbound reaction notifications, and ack reactions.

Outbound reaction tooling is gated by `channels.matrix.actions.reactions`:

- `react` adds a reaction to a Matrix event.
- `reactions` lists the current reaction summary for a Matrix event.
- `emoji=""` removes the bot's own reactions on that event.
- `remove: true` removes only the specified emoji reaction from the bot.

**Resolution order** (first defined value wins):

| Setting                 | Order                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `ackReaction`           | per-account -> channel -> `messages.ackReaction` -> agent identity emoji fallback   |
| `ackReactionScope`      | per-account -> channel -> `messages.ackReactionScope` -> default `"group-mentions"` |
| `reactionNotifications` | per-account -> channel -> default `"own"`                                           |

`reactionNotifications: "own"` forwards added `m.reaction` events when they target bot-authored Matrix messages; `"off"` disables reaction system events. Reaction removals are not synthesized into system events - Matrix surfaces those as redactions, not as standalone `m.reaction` removals.

## History context

- `channels.matrix.historyLimit` controls how many recent room messages are included as `InboundHistory` when a room message triggers the agent. Falls back to `messages.groupChat.historyLimit`; effective default `0` if both are unset (disabled).
- Matrix room history is room-only; DMs keep using normal session history.
- Room history is pending-only: OpenClaw buffers room messages that did not trigger a reply yet, then snapshots that window when a mention or other trigger arrives.
- The current trigger message is not included in `InboundHistory`; it stays in the main inbound body for that turn.
- Retries of the same Matrix event reuse the original history snapshot instead of drifting forward to newer room messages.

## Context visibility

Matrix supports the shared `contextVisibility` control for supplemental room context such as fetched reply text, thread roots, and pending history.

- `contextVisibility: "all"` is the default. Supplemental context is kept as received.
- `contextVisibility: "allowlist"` filters supplemental context to senders allowed by the active room/user allowlist checks.
- `contextVisibility: "allowlist_quote"` behaves like `allowlist`, but still keeps one explicit quoted reply.

This affects supplemental context visibility only, not whether the inbound message itself can trigger a reply. Trigger authorization still comes from `groupPolicy`, `groups`, `groupAllowFrom`, and DM policy settings.

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
        "!roomid:example.org": { requireMention: true },
      },
    },
  },
}
```

To silence DMs entirely while keeping rooms working, set `dm.enabled: false`:

```json5
{
  channels: {
    matrix: {
      dm: { enabled: false },
      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
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

If an unapproved Matrix user keeps messaging before approval, OpenClaw reuses the same pending pairing code and may send a reminder reply after a short cooldown instead of minting a new code.

See [Pairing](/channels/pairing) for the shared DM pairing flow and storage layout.

## Direct room repair

If direct-message state drifts, OpenClaw can end up with stale `m.direct` mappings pointing at old solo rooms instead of the live DM. Inspect the current mapping for a peer:

```bash
openclaw matrix direct inspect --user-id @alice:example.org
```

Repair it:

```bash
openclaw matrix direct repair --user-id @alice:example.org
```

Both commands accept `--account <id>` for multi-account setups. The repair flow:

- prefers a strict 1:1 DM already mapped in `m.direct`
- falls back to any currently joined strict 1:1 DM with that user
- creates a fresh direct room and rewrites `m.direct` if no healthy DM exists

It does not delete old rooms automatically. It picks the healthy DM and updates the mapping so future Matrix sends, verification notices, and other direct-message flows target the right room.

## Exec approvals

Matrix can act as a native approval client. Configure under `channels.matrix.execApprovals` (or `channels.matrix.accounts.<account>.execApprovals` for a per-account override):

- `enabled`: deliver approvals through Matrix-native prompts. Unset or `"auto"` auto-enables once at least one approver can be resolved; set `false` to disable explicitly.
- `approvers`: Matrix user IDs (`@owner:example.org`) allowed to approve exec requests. Falls back to `channels.matrix.dm.allowFrom`.
- `target`: where prompts go. `"dm"` (default) sends to approver DMs; `"channel"` sends to the originating room or DM; `"both"` sends to both.
- `agentFilter` / `sessionFilter`: optional allowlists for which agents/sessions trigger Matrix delivery.

Authorization differs slightly between approval kinds:

- **Exec approvals** use `execApprovals.approvers`, falling back to `dm.allowFrom`.
- **Plugin approvals** authorize through `dm.allowFrom` only.

Both kinds share Matrix reaction shortcuts and message updates. Approvers see reaction shortcuts on the primary approval message:

- ✅ allow once
- ❌ deny
- ♾️ allow always (when the effective exec policy allows it)

Fallback slash commands: `/approve <id> allow-once`, `/approve <id> allow-always`, `/approve <id> deny`.

Only resolved approvers can approve or deny. Channel delivery for exec approvals includes the command text - only enable `channel` or `both` in trusted rooms.

Related: [Exec approvals](/tools/exec-approvals).

## Slash commands

Slash commands (`/new`, `/reset`, `/model`, `/focus`, `/unfocus`, `/agents`, `/session`, `/acp`, `/approve`, etc.) work directly in DMs. In rooms, OpenClaw also recognizes commands prefixed with the bot's own Matrix mention, so `@bot:server /new` triggers the command path without a custom mention regex - this keeps the bot responsive to the room-style `@mention /command` posts that Element and similar clients emit when a user tab-completes the bot before typing the command.

Authorization rules still apply: command senders must satisfy the same DM or room allowlist/owner policies as plain messages.

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

**Inheritance:**

- Top-level `channels.matrix` values act as defaults for named accounts unless an account overrides them.
- Scope an inherited room entry to a specific account with `groups.<room>.account`. Entries without `account` are shared across accounts; `account: "default"` still works when the default account is configured at the top level.

**Default account selection:**

- Set `defaultAccount` to pick the named account that implicit routing, probing, and CLI commands prefer.
- If you have multiple accounts and one is literally named `default`, OpenClaw uses it implicitly even when `defaultAccount` is unset.
- With multiple named accounts and no default selected, CLI commands refuse to guess - set `defaultAccount` or pass `--account <id>`.
- The top-level `channels.matrix.*` block is only treated as the implicit `default` account when its auth is complete (`homeserver` + `accessToken`, or `homeserver` + `userId` + `password`). Named accounts remain discoverable from `homeserver` + `userId` once cached credentials cover auth.

**Promotion:**

- When OpenClaw promotes a single-account config to multi-account during repair or setup, it preserves the existing named account if one exists or `defaultAccount` already points at one. Only Matrix auth/bootstrap keys move into the promoted account; shared delivery-policy keys stay at the top level.

See [Configuration reference](/gateway/config-channels#multi-account-all-channels) for the shared multi-account pattern.

## Private/LAN homeservers

By default, OpenClaw blocks private/internal Matrix homeservers for SSRF protection unless you opt in per account.

If your homeserver runs on localhost, a LAN/Tailscale IP, or an internal hostname, enable `network.dangerouslyAllowPrivateNetwork` for that account:

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

This opt-in only allows trusted private/internal targets. Public cleartext homeservers such as `http://matrix.example.org:8008` remain blocked. Prefer `https://` whenever possible.

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

Named accounts can override the top-level default with `channels.matrix.accounts.<id>.proxy`. OpenClaw uses the same proxy setting for runtime Matrix traffic and account status probes.

## Target resolution

Matrix accepts these target forms anywhere OpenClaw asks for a room or user target:

- Users: `@user:server`, `user:@user:server`, or `matrix:user:@user:server`
- Rooms: `!room:server`, `room:!room:server`, or `matrix:room:!room:server`
- Aliases: `#alias:server`, `channel:#alias:server`, or `matrix:channel:#alias:server`

Matrix room IDs are case-sensitive. Use the exact room ID casing from Matrix when configuring explicit delivery targets, cron jobs, bindings, or allowlists. OpenClaw keeps internal session keys canonical for storage, so those lowercase keys are not a reliable source for Matrix delivery IDs.

Live directory lookup uses the logged-in Matrix account:

- User lookups query the Matrix user directory on that homeserver.
- Room lookups accept explicit room IDs and aliases directly. Joined-room name lookup is best-effort and only applies to runtime room allowlists when `dangerouslyAllowNameMatching: true` is set.
- If a room name cannot be resolved to an ID or alias, it is ignored by runtime allowlist resolution.

## Configuration reference

Allowlist-style user fields (`groupAllowFrom`, `dm.allowFrom`, `groups.<room>.users`) accept full Matrix user IDs (safest). Non-ID entries are ignored by default. If `dangerouslyAllowNameMatching: true` is set, exact Matrix directory display-name matches are resolved at startup and whenever the allowlist changes while the monitor is running; unresolvable entries are ignored at runtime.

Room allowlist keys (`groups`, legacy `rooms`) should be room IDs or aliases. Plain room-name keys are ignored by default; `dangerouslyAllowNameMatching: true` restores best-effort lookup against joined room names.

### Account and connection

- `enabled`: enable or disable the channel.
- `name`: optional display label for the account.
- `defaultAccount`: preferred account ID when multiple Matrix accounts are configured.
- `accounts`: named per-account overrides. Top-level `channels.matrix` values are inherited as defaults.
- `homeserver`: homeserver URL, for example `https://matrix.example.org`.
- `network.dangerouslyAllowPrivateNetwork`: allow this account to connect to `localhost`, LAN/Tailscale IPs, or internal hostnames.
- `proxy`: optional HTTP(S) proxy URL for Matrix traffic. Per-account override supported.
- `userId`: full Matrix user ID (`@bot:example.org`).
- `accessToken`: access token for token-based auth. Plaintext and SecretRef values supported across env/file/exec providers ([Secrets Management](/gateway/secrets)).
- `password`: password for password-based login. Plaintext and SecretRef values supported.
- `deviceId`: explicit Matrix device ID.
- `deviceName`: device display name used at password-login time.
- `avatarUrl`: stored self-avatar URL for profile sync and `profile set` updates.
- `initialSyncLimit`: maximum number of events fetched during startup sync.

### Encryption

- `encryption`: enable E2EE. Default: `false`.
- `startupVerification`: `"if-unverified"` (default when E2EE is on) or `"off"`. Auto-requests self-verification on startup when this device is unverified.
- `startupVerificationCooldownHours`: cooldown before the next automatic startup request. Default: `24`.

### Access and policy

- `groupPolicy`: `"open"`, `"allowlist"`, or `"disabled"`. Default: `"allowlist"`.
- `groupAllowFrom`: allowlist of user IDs for room traffic.
- `mentionPatterns`: scoped regex patterns for room mentions. Object with `{ mode: "allow"|"deny", allowIn: [roomId, ...], denyIn: [roomId, ...] }`. Controls whether configured `agents.list[].groupChat.mentionPatterns` apply per-room.
- `dm.enabled`: when `false`, ignore all DMs. Default: `true`.
- `dm.policy`: `"pairing"` (default), `"allowlist"`, `"open"`, or `"disabled"`. Applies after the bot has joined and classified the room as a DM; it does not affect invite handling.
- `dm.allowFrom`: allowlist of user IDs for DM traffic.
- `dm.sessionScope`: `"per-user"` (default) or `"per-room"`.
- `dm.threadReplies`: DM-only override for reply threading (`"off"`, `"inbound"`, `"always"`).
- `allowBots`: accept messages from other configured Matrix bot accounts (`true` or `"mentions"`).
- `allowlistOnly`: when `true`, forces all active DM policies (except `"disabled"`) and `"open"` group policies to `"allowlist"`. Does not change `"disabled"` policies.
- `dangerouslyAllowNameMatching`: when `true`, allows Matrix display-name directory lookup for user allowlist entries and joined-room name lookup for room allowlist keys. Prefer full `@user:server` IDs and room IDs or aliases.
- `autoJoin`: `"always"`, `"allowlist"`, or `"off"`. Default: `"off"`. Applies to every Matrix invite, including DM-style invites.
- `autoJoinAllowlist`: rooms/aliases allowed when `autoJoin` is `"allowlist"`. Alias entries resolve against the homeserver, not against state claimed by the invited room.
- `contextVisibility`: supplemental context visibility (`"all"` default, `"allowlist"`, `"allowlist_quote"`).

### Reply behavior

- `replyToMode`: `"off"` (default), `"first"`, `"all"`, or `"batched"`.
- `threadReplies`: `"off"` (top-level default resolves to `"inbound"` unless explicitly set), `"inbound"`, or `"always"`.
- `threadBindings`: per-channel overrides for thread-bound session routing and lifecycle.
- `streaming`: nested object `{ mode, chunkMode, block: { enabled, coalesce }, preview: { toolProgress }, progress: { label, labels, maxLines, maxLineChars, toolProgress } }`. `mode` is `"off"` (default), `"partial"`, `"quiet"`, or `"progress"`. Legacy scalar/boolean spellings migrate via `openclaw doctor --fix`.
- `streaming.block.enabled`: when `true`, completed assistant blocks are kept as separate progress messages. Default: `false`.
- `markdown`: optional Markdown rendering config for outbound text.
- `responsePrefix`: optional string prepended to outbound replies.
- `textChunkLimit`: outbound chunk size in characters when `streaming.chunkMode: "length"`. Default: `4000`.
- `streaming.chunkMode`: `"length"` (default, splits by character count) or `"newline"` (splits at line boundaries).
- `historyLimit`: number of recent room messages included as `InboundHistory` when a room message triggers the agent. Falls back to `messages.groupChat.historyLimit`; effective default `0` (disabled).
- `mediaMaxMb`: media size cap in MB for outbound sends and inbound processing. Default: `20`.

### Reaction settings

- `ackReaction`: ack reaction override for this channel/account.
- `ackReactionScope`: scope override (`"group-mentions"` default, `"group-all"`, `"direct"`, `"all"`, `"none"`, `"off"`).
- `reactionNotifications`: inbound reaction notification mode (`"own"` default, `"off"`).

### Tooling and per-room overrides

- `actions`: per-action tool gating (`messages`, `reactions`, `pins`, `profile`, `memberInfo`, `channelInfo`, `verification`).
- `groups`: per-room policy map. Session identity uses the stable room ID after resolution. (`rooms` is a legacy alias.)
  - `groups.<room>.account`: restrict one inherited room entry to a specific account.
  - `groups.<room>.enabled`: per-room toggle. When `false`, the room is ignored as if it were not in the map.
  - `groups.<room>.requireMention`: per-room override of the channel-level mention requirement.
  - `groups.<room>.allowBots`: per-room override of the channel-level setting (`true` or `"mentions"`).
  - `groups.<room>.botLoopProtection`: per-room override for bot-to-bot loop protection budget.
  - `groups.<room>.users`: per-room sender allowlist.
  - `groups.<room>.tools`: per-room tool allow/deny overrides.
  - `groups.<room>.autoReply`: per-room mention-gating override. `true` disables mention requirements for that room; `false` forces them back on.
  - `groups.<room>.skills`: per-room skill filter.
  - `groups.<room>.systemPrompt`: per-room system prompt snippet.

### Exec approval settings

- `execApprovals.enabled`: deliver exec approvals through Matrix-native prompts.
- `execApprovals.approvers`: Matrix user IDs allowed to approve. Falls back to `dm.allowFrom`.
- `execApprovals.target`: `"dm"` (default), `"channel"`, or `"both"`.
- `execApprovals.agentFilter` / `execApprovals.sessionFilter`: optional agent/session allowlists for delivery.

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
