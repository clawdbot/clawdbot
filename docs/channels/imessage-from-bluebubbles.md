---
summary: "Migrate old BlueBubbles configs to the bundled iMessage plugin without losing pairing, allowlists, or group bindings."
read_when:
  - Planning a move from BlueBubbles to the bundled iMessage plugin
  - Translating BlueBubbles config keys to iMessage equivalents
  - Verifying imsg before enabling the iMessage plugin
title: "Coming from BlueBubbles"
---

The bundled `imessage` plugin now reaches the same private API surface as BlueBubbles (`react`, `edit`, `unsend`, `reply`, `sendWithEffect`, group management, attachments) by driving [`steipete/imsg`](https://github.com/steipete/imsg) over JSON-RPC. If you already run a Mac with `imsg` installed, you can drop the BlueBubbles server and let the plugin talk to Messages.app directly.

BlueBubbles support was removed. OpenClaw supports iMessage through `imsg` only. This guide is for migrating old `channels.bluebubbles` configs to `channels.imessage`; there is no other supported migration path.

## When this migration makes sense

- You already run `imsg` on the same Mac (or one reachable over SSH) where Messages.app is signed in.
- You want one fewer moving part — no separate BlueBubbles server, no REST endpoint to authenticate, no webhook plumbing. Single CLI binary instead of a server + client app + helper.
- You are on a [supported macOS / `imsg` build](/channels/imessage#requirements-and-permissions-macos) where the private API probe reports `available: true`.

## What imsg does

`imsg` is a local macOS CLI for Messages. OpenClaw starts `imsg rpc` as a child process and talks JSON-RPC over stdin/stdout. There is no HTTP server, webhook URL, background daemon, launch agent, or port to expose.

- Reads come from `~/Library/Messages/chat.db` using a read-only SQLite handle.
- Live inbound messages come from `imsg watch` / `watch.subscribe`, which follows `chat.db` filesystem events with a polling fallback.
- Sends use Messages.app automation for normal text and file sends.
- Advanced actions use `imsg launch` to inject the `imsg` helper into Messages.app. That is what unlocks read receipts, typing indicators, rich sends, edit, unsend, threaded reply, tapbacks, and group management.
- Linux builds can inspect a copied `chat.db`, but cannot send, watch the live Mac database, or drive Messages.app. For OpenClaw iMessage, run `imsg` on the signed-in Mac or through an SSH wrapper to that Mac.

## Before you start

1. Install `imsg` on the Mac that runs Messages.app:

   ```bash
   brew install steipete/tap/imsg
   imsg --version
   imsg chats --limit 3
   ```

   If `imsg chats` fails with `unable to open database file`, empty output, or `authorization denied`, grant Full Disk Access to the terminal, editor, Node process, Gateway service, or SSH parent process that launches `imsg`, then reopen that parent process.

2. Verify the read, watch, send, and RPC surfaces before changing OpenClaw config:

   ```bash
   imsg chats --limit 10 --json | jq -s
   imsg history --chat-id 42 --limit 10 --attachments --json | jq -s
   imsg watch --chat-id 42 --reactions --json
   imsg send --chat-id 42 --text "OpenClaw imsg test"
   imsg rpc --help
   ```

   Replace `42` with a real chat id from `imsg chats`. Sending requires Automation permission for Messages.app. If OpenClaw will run through SSH, run these commands through the same SSH wrapper or user context that OpenClaw will use.

3. Enable the private API bridge when you need advanced actions:

   ```bash
   imsg launch
   imsg status --json
   ```

   `imsg launch` requires SIP to be disabled. Basic send, history, and watch work without `imsg launch`; advanced actions do not.

4. Verify the bridge through OpenClaw:

   ```bash
   openclaw channels status --probe
   ```

   You want `imessage.privateApi.available: true`. If it reports `false`, fix that first — see [Capability detection](/channels/imessage#private-api-actions).

5. Snapshot your config:

   ```bash
   cp ~/.openclaw/openclaw.json5 ~/.openclaw/openclaw.json5.bak
   ```

## Config translation

iMessage and BlueBubbles share a lot of channel-level config. The keys that change are mostly transport (REST server vs local CLI). Behavior keys (`dmPolicy`, `groupPolicy`, `allowFrom`, etc.) keep the same meaning.

| BlueBubbles                                                | bundled iMessage                          | Notes                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.bluebubbles.enabled`                             | `channels.imessage.enabled`               | Same semantics.                                                                                                                                                                                                                                                                                                                              |
| `channels.bluebubbles.serverUrl`                           | _(removed)_                               | No REST server — the plugin spawns `imsg rpc` over stdio.                                                                                                                                                                                                                                                                                    |
| `channels.bluebubbles.password`                            | _(removed)_                               | No webhook authentication needed.                                                                                                                                                                                                                                                                                                            |
| _(implicit)_                                               | `channels.imessage.cliPath`               | Path to `imsg` (default `imsg`); use a wrapper script for SSH.                                                                                                                                                                                                                                                                               |
| _(implicit)_                                               | `channels.imessage.dbPath`                | Optional Messages.app `chat.db` override; auto-detected when omitted.                                                                                                                                                                                                                                                                        |
| _(implicit)_                                               | `channels.imessage.remoteHost`            | `host` or `user@host` — only needed when `cliPath` is an SSH wrapper and you want SCP attachment fetches.                                                                                                                                                                                                                                    |
| `channels.bluebubbles.dmPolicy`                            | `channels.imessage.dmPolicy`              | Same values (`pairing` / `allowlist` / `open` / `disabled`).                                                                                                                                                                                                                                                                                 |
| `channels.bluebubbles.allowFrom`                           | `channels.imessage.allowFrom`             | Pairing approvals carry over by handle, not by token.                                                                                                                                                                                                                                                                                        |
| `channels.bluebubbles.groupPolicy`                         | `channels.imessage.groupPolicy`           | Same values (`allowlist` / `open` / `disabled`).                                                                                                                                                                                                                                                                                             |
| `channels.bluebubbles.groupAllowFrom`                      | `channels.imessage.groupAllowFrom`        | Same.                                                                                                                                                                                                                                                                                                                                        |
| `channels.bluebubbles.groups`                              | `channels.imessage.groups`                | **Copy this verbatim, including any `groups: { "*": { ... } }` wildcard entry.** Per-group `requireMention`, `tools`, `toolsBySender` carry over. With `groupPolicy: "allowlist"`, an empty or missing `groups` block silently drops every group message — see "Group registry footgun" below.                                               |
| `channels.bluebubbles.sendReadReceipts`                    | `channels.imessage.sendReadReceipts`      | Default `true`. With the bundled plugin this only fires when the private API probe is up.                                                                                                                                                                                                                                                    |
| `channels.bluebubbles.includeAttachments`                  | `channels.imessage.includeAttachments`    | Same.                                                                                                                                                                                                                                                                                                                                        |
| `channels.bluebubbles.attachmentRoots`                     | `channels.imessage.attachmentRoots`       | Local roots; same wildcard rules.                                                                                                                                                                                                                                                                                                            |
| _(N/A)_                                                    | `channels.imessage.remoteAttachmentRoots` | Only used when `remoteHost` is set for SCP fetches.                                                                                                                                                                                                                                                                                          |
| `channels.bluebubbles.mediaMaxMb`                          | `channels.imessage.mediaMaxMb`            | Default 16 MB on iMessage (BlueBubbles default was 8 MB). Set explicitly if you want to keep the lower cap.                                                                                                                                                                                                                                  |
| `channels.bluebubbles.textChunkLimit`                      | `channels.imessage.textChunkLimit`        | Default 4000 on both.                                                                                                                                                                                                                                                                                                                        |
| `channels.bluebubbles.coalesceSameSenderDms`               | `channels.imessage.coalesceSameSenderDms` | Same opt-in. DM-only — group chats keep instant per-message dispatch on both channels. Widens the default inbound debounce to 2500 ms when enabled without an explicit `messages.inbound.byChannel.imessage`. See [iMessage docs § Coalescing split-send DMs](/channels/imessage#coalescing-split-send-dms-command--url-in-one-composition). |
| `channels.bluebubbles.enrichGroupParticipantsFromContacts` | _(N/A)_                                   | iMessage already reads sender display names from `chat.db`.                                                                                                                                                                                                                                                                                  |
| `channels.bluebubbles.actions.*`                           | `channels.imessage.actions.*`             | Per-action toggles: `reactions`, `edit`, `unsend`, `reply`, `sendWithEffect`, `renameGroup`, `setGroupIcon`, `addParticipant`, `removeParticipant`, `leaveGroup`, `sendAttachment`.                                                                                                                                                          |

Multi-account configs (`channels.bluebubbles.accounts.*`) translate one-to-one to `channels.imessage.accounts.*`.

## Group registry footgun

The bundled iMessage plugin runs **two** separate group allowlist gates back-to-back. Both must pass for a group message to reach the agent:

1. **Sender / chat-target allowlist** (`channels.imessage.groupAllowFrom`) — checked by `isAllowedIMessageSender`. Matches inbound messages by sender handle, `chat_guid`, `chat_identifier`, or `chat_id`. Same shape as BlueBubbles.
2. **Group registry** (`channels.imessage.groups`) — checked by `resolveChannelGroupPolicy` from `inbound-processing.ts:199`. With `groupPolicy: "allowlist"`, this gate requires either:
   - a `groups: { "*": { ... } }` wildcard entry (sets `allowAll = true`), or
   - an explicit per-`chat_id` entry under `groups`.

If gate 1 passes but gate 2 fails, the message is dropped. The plugin emits two `warn`-level signals so this is no longer silent at default log level:

- A one-time startup `warn` per account when `groupPolicy: "allowlist"` is set but `channels.imessage.groups` is empty (no `"*"` wildcard, no per-`chat_id` entries) — fired before any messages land.
- A one-time per-`chat_id` `warn` the first time a specific group is dropped at runtime, naming the chat_id and the exact key to add to `groups` to allow it.

DMs continue to work because they take a different code path.

This is the most common BlueBubbles → bundled-iMessage migration failure mode: operators copy `groupAllowFrom` and `groupPolicy` but skip the `groups` block, because BlueBubbles' `groups: { "*": { "requireMention": true } }` looks like an unrelated mention setting. It's actually load-bearing for the registry gate.

The minimum config to keep group messages flowing after `groupPolicy: "allowlist"`:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123", "chat_guid:any;-;..."],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
}
```

`requireMention: true` under `*` is harmless when no mention patterns are configured: the runtime sets `canDetectMention = false` and short-circuits the mention drop at `inbound-processing.ts:512`. With mention patterns configured (`agents.list[].groupChat.mentionPatterns`), it works as expected.

If the gateway logs `imessage: dropping group message from chat_id=<id>` or the startup line `imessage: groupPolicy="allowlist" but channels.imessage.groups is empty`, gate 2 is dropping — add the `groups` block.

## Step-by-step

1. Add an iMessage block alongside the existing BlueBubbles block. Keep the old block only as a copy source until the new path is verified:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         // ... existing config ...
       },
       imessage: {
         enabled: false, // turn on after the dry run below
         cliPath: "/opt/homebrew/bin/imsg",
         dmPolicy: "pairing",
         allowFrom: ["+15555550123"], // copy from bluebubbles.allowFrom
         groupPolicy: "allowlist",
         groupAllowFrom: [], // copy from bluebubbles.groupAllowFrom
         groups: { "*": { requireMention: true } }, // copy from bluebubbles.groups — silently drops groups if missing, see "Group registry footgun" above
         actions: {
           reactions: true,
           edit: true,
           unsend: true,
           reply: true,
           sendWithEffect: true,
           sendAttachment: true,
         },
       },
     },
   }
   ```

2. **Dry-run probe** — start the gateway and confirm iMessage reports healthy:

   ```bash
   openclaw gateway
   openclaw channels status
   openclaw channels status --probe   # expect imessage.privateApi.available: true
   ```

   Because `imessage.enabled` is still `false`, no inbound iMessage traffic is routed yet — but `--probe` exercises the bridge so you catch permission/install issues before the cutover.

3. **Cut over.** Remove the BlueBubbles config and enable iMessage in one config edit:

   ```json5
   {
     channels: {
       imessage: { enabled: true /* ... */ },
     },
   }
   ```

   Restart the gateway. Inbound iMessage traffic now flows through the bundled plugin.

4. **Verify DMs.** Send the agent a direct message; confirm the reply lands.

5. **Verify groups separately.** DMs and groups take different code paths — DM success does not prove groups are routing. Send the agent a message in a paired group chat and confirm the reply lands. If the group goes silent (no agent reply, no error), check the gateway log for `imessage: dropping group message from chat_id=<id>` or the startup `imessage: groupPolicy="allowlist" but channels.imessage.groups is empty` line — both fire at the default log level. If either appears, your `groups` block is missing or empty — see "Group registry footgun" above.

6. **Verify the action surface** — from a paired DM, ask the agent to react, edit, unsend, reply, send a photo, and (in a group) rename the group / add or remove a participant. Each action should land natively in Messages.app. If any throws "iMessage `<action>` requires the imsg private API bridge", run `imsg launch` again and refresh `channels status --probe`.

7. **Remove the BlueBubbles server and config** once iMessage DMs, groups, and actions are verified. OpenClaw will not use `channels.bluebubbles`.

## Action parity at a glance

| Action                                                     | legacy BlueBubbles                  | bundled iMessage                                                                     |
| ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| Send text / SMS fallback                                   | ✅                                  | ✅                                                                                   |
| Send media (photo, video, file, voice)                     | ✅                                  | ✅                                                                                   |
| Threaded reply (`reply_to_guid`)                           | ✅                                  | ✅ (closes [#51892](https://github.com/openclaw/openclaw/issues/51892))              |
| Tapback (`react`)                                          | ✅                                  | ✅                                                                                   |
| Edit / unsend (macOS 13+ recipients)                       | ✅                                  | ✅                                                                                   |
| Send with screen effect                                    | ✅                                  | ✅ (closes part of [#9394](https://github.com/openclaw/openclaw/issues/9394))        |
| Rich text bold / italic / underline / strikethrough        | ✅                                  | ✅ (typed-run formatting via attributedBody)                                         |
| Rename group / set group icon                              | ✅                                  | ✅                                                                                   |
| Add / remove participant, leave group                      | ✅                                  | ✅                                                                                   |
| Read receipts and typing indicator                         | ✅                                  | ✅ (gated on private API probe)                                                      |
| Same-sender DM coalescing                                  | ✅                                  | ✅ (DM-only; opt-in via `channels.imessage.coalesceSameSenderDms`)                   |
| Catchup of inbound messages received while gateway is down | ✅ (webhook replay + history fetch) | _(not yet — tracked at [#78649](https://github.com/openclaw/openclaw/issues/78649))_ |

The catchup gap is the most operationally significant one for production deployments: planned restarts, mac sleep, or an unexpected gateway crash that takes more than a few seconds will silently drop any inbound iMessage traffic that arrives during the gap when running on bundled iMessage. BlueBubbles' webhook + history-fetch flow recovered those messages on reconnect, but BlueBubbles is no longer supported. There is no supported migration path that preserves catchup today; wait for [#78649](https://github.com/openclaw/openclaw/issues/78649).

## Pairing, sessions, and ACP bindings

- **Pairing approvals** carry over by handle. You do not need to re-approve known senders — `channels.imessage.allowFrom` recognizes the same `+15555550123` / `user@example.com` strings BlueBubbles used.
- **Sessions** stay scoped per agent + chat. DMs collapse into the agent main session under default `session.dmScope=main`; group sessions stay isolated per `chat_id`. The session keys differ (`agent:<id>:imessage:group:<chat_id>` vs the BlueBubbles equivalent) — old conversation history under BlueBubbles session keys does not carry into iMessage sessions.
- **ACP bindings** referencing `match.channel: "bluebubbles"` need to be updated to `"imessage"`. The `match.peer.id` shapes (`chat_id:`, `chat_guid:`, `chat_identifier:`, bare handle) are identical.

## No rollback channel

There is no supported BlueBubbles runtime to switch back to. If iMessage verification fails, set `channels.imessage.enabled: false`, restart the Gateway, fix the `imsg` blocker, and retry the cutover.

The reply cache lives at `~/.openclaw/state/imessage/reply-cache.jsonl` (mode `0600`, parent dir `0700`). It is safe to delete if you want a clean slate.

## Related

- [iMessage](/channels/imessage) — full iMessage channel reference, including `imsg launch` setup and capability detection.
- `/channels/bluebubbles` — legacy URL that redirects to this migration guide.
- [Pairing](/channels/pairing) — DM authentication and pairing flow.
- [Channel Routing](/channels/channel-routing) — how the gateway picks a channel for outbound replies.
