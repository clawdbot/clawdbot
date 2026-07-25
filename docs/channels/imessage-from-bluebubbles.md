---
summary: "Translate old BlueBubbles configs to the bundled iMessage plugin: key mapping, group allowlist gates, and cutover verification."
read_when:
  - Planning a move from BlueBubbles to the bundled iMessage plugin
  - Translating BlueBubbles config keys to iMessage equivalents
  - Verifying imsg before enabling the iMessage plugin
title: "Coming from BlueBubbles"
---

BlueBubbles support was removed. OpenClaw supports iMessage only through the bundled `imessage` plugin, which drives [`steipete/imsg`](https://github.com/steipete/imsg) over JSON-RPC and reaches the same private API surface BlueBubbles had (`react`, `edit`, `unsend`, `reply`, `sendWithEffect`, native polls, group management, attachments). One CLI binary replaces the BlueBubbles server + client app + webhook plumbing: no REST endpoint, no webhook auth.

This guide migrates old `channels.bluebubbles` configs to `channels.imessage`. There is no other supported migration path. On current OpenClaw a leftover `channels.bluebubbles` block is inert — no runtime reads it.

<Note>
For the short announcement and operator summary, see [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage).
</Note>

## Migration checklist

The shortest safe path when you already know your old BlueBubbles config:

1. Verify `imsg` directly on the Mac that runs Messages.app (`imsg chats`, `imsg history`, `imsg send`, `imsg rpc --help`).
2. Copy behavior keys from `channels.bluebubbles` to `channels.imessage`: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `includeAttachments`, `attachmentRoots`, `mediaMaxMb`, `textChunkLimit`, and `actions`.
3. Drop transport keys that no longer exist: `serverUrl`, `password`, webhook URLs, and BlueBubbles server setup.
4. If the Gateway is not running on the Messages Mac, set `channels.imessage.cliPath` to an SSH wrapper and set `remoteHost` for remote attachment fetches.
5. Enable `channels.imessage`, restart the Gateway, then run `openclaw channels status --probe --channel imessage`.
6. Test one DM, one allowed group, attachments if enabled, and every private API action you expect the agent to use.
7. Delete the BlueBubbles server and the old `channels.bluebubbles` config after the iMessage path is verified.

## What imsg does

`imsg` is a local macOS CLI for Messages. OpenClaw starts `imsg rpc` as a child process and talks JSON-RPC over stdin/stdout. There is no HTTP server, webhook URL, background daemon, launch agent, or port to expose.

- Reads come from `~/Library/Messages/chat.db` using a read-only SQLite handle.
- Live inbound messages come from `imsg watch` / `watch.subscribe`, which follows `chat.db` filesystem events with a polling fallback.
- Sends use Messages.app automation for normal text and file sends.
- Advanced actions use `imsg launch` to inject the `imsg` helper into Messages.app. That is what unlocks read receipts, typing indicators, rich sends, edit, unsend, threaded reply, tapbacks, polls, and group management.
- Linux builds can inspect a copied `chat.db`, but cannot send, watch the live Mac database, or drive Messages.app. For OpenClaw iMessage, run `imsg` on the signed-in Mac or through an SSH wrapper to that Mac.

## Before you start

1. Install `imsg` on the Mac that runs Messages.app:

   ```bash
   brew install steipete/tap/imsg
   brew update && brew upgrade imsg
   imsg --version
   imsg chats --limit 3
   ```

   For the usual local setup, OpenClaw setup can offer a user-confirmed Homebrew install or update for `imsg` on the signed-in Messages Mac. Manual setup and SSH-wrapper topologies remain operator-managed: repeat the Homebrew update in the same local or remote user context that will run `imsg`. If `imsg chats` fails with `unable to open database file`, empty output, or `authorization denied`, grant Full Disk Access to the terminal, editor, Node process, Gateway service, or SSH parent process that launches `imsg`, then reopen that parent process.

2. Verify the read, watch, send, and RPC surfaces before changing OpenClaw config:

   ```bash
   imsg chats --limit 10 --json | jq -s
   imsg history --chat-id 42 --limit 10 --attachments --json | jq -s
   imsg watch --chat-id 42 --reactions --json
   imsg send --chat-id 42 --text "OpenClaw imsg test"
   imsg rpc --help
   ```

   Replace `42` with a real chat id from `imsg chats`. Sending requires Automation permission for Messages.app. If OpenClaw will run through SSH, run these commands through the same SSH wrapper or user context that OpenClaw will use. If reads work but sends fail with AppleEvents `-1743`, check whether Automation landed on `/usr/libexec/sshd-keygen-wrapper`; see [SSH wrapper sends fail with AppleEvents -1743](/channels/imessage#requirements-and-permissions-macos).

3. Enable the private API bridge. It is strongly encouraged for OpenClaw iMessage because replies, tapbacks, effects, polls, attachment replies, and group actions depend on it:

   ```bash
   imsg launch
   imsg status --json
   ```

   `imsg launch` requires SIP to be disabled (and on modern macOS, library validation relaxed — see [Enabling the imsg private API](/channels/imessage#enabling-the-imsg-private-api)). Basic send, history, and watch work without `imsg launch`; the full OpenClaw iMessage action surface does not.

4. After you enable `channels.imessage` and start the Gateway, verify the bridge through OpenClaw:

   ```bash
   openclaw channels status --probe
   ```

   The iMessage account should report `works`; with `--json`, the probe payload includes `privateApi.available: true`. If it reports `false`, fix that first — see [Capability detection](/channels/imessage#private-api-actions). Probing needs a reachable Gateway (the CLI falls back to config-only output otherwise) and only probes configured, enabled accounts.

5. Snapshot your config:

   ```bash
   cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak
   ```

## Config translation

iMessage and BlueBubbles share most channel-level behavior keys. What changes is transport (REST server vs local CLI) and the group registry key format.

| BlueBubbles                                                | bundled iMessage                          | Notes                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.bluebubbles.enabled`                             | `channels.imessage.enabled`               | Same semantics (default `true` once the block exists).                                                                                                                                                                                                                           |
| `channels.bluebubbles.serverUrl`                           | _(removed)_                               | No REST server — the plugin spawns `imsg rpc` over stdio.                                                                                                                                                                                                                        |
| `channels.bluebubbles.password`                            | _(removed)_                               | No webhook authentication needed.                                                                                                                                                                                                                                                |
| _(implicit)_                                               | `channels.imessage.cliPath`               | Path to `imsg` (default `imsg`); use a wrapper script for SSH.                                                                                                                                                                                                                   |
| _(implicit)_                                               | `channels.imessage.dbPath`                | Optional Messages.app `chat.db` override; auto-detected when omitted.                                                                                                                                                                                                            |
| _(implicit)_                                               | `channels.imessage.remoteHost`            | `host` or `user@host` — only needed when `cliPath` is an SSH wrapper and you want SCP attachment fetches.                                                                                                                                                                        |
| `channels.bluebubbles.dmPolicy`                            | `channels.imessage.dmPolicy`              | Same values (`pairing` / `allowlist` / `open` / `disabled`); default `pairing`.                                                                                                                                                                                                  |
| `channels.bluebubbles.allowFrom`                           | `channels.imessage.allowFrom`             | Same handle formats (`+15555550123`, `user@example.com`). Pairing-store approvals do not transfer — see below.                                                                                                                                                                   |
| `channels.bluebubbles.groupPolicy`                         | `channels.imessage.groupPolicy`           | Same values (`allowlist` / `open` / `disabled`); default `allowlist`.                                                                                                                                                                                                            |
| `channels.bluebubbles.groupAllowFrom`                      | `channels.imessage.groupAllowFrom`        | Same. When unset, iMessage falls back to `allowFrom`; an explicitly empty `groupAllowFrom: []` blocks all groups under `groupPolicy: "allowlist"`.                                                                                                                               |
| `channels.bluebubbles.groups`                              | `channels.imessage.groups`                | Copy the `"*"` wildcard entry verbatim; re-key per-group entries by numeric iMessage `chat_id` — see "Group registry footgun". `requireMention`, `tools`, `toolsBySender`, `systemPrompt` carry over.                                                                            |
| `channels.bluebubbles.sendReadReceipts`                    | `channels.imessage.sendReadReceipts`      | Default `true`. With the bundled plugin this only fires when the private API probe is up.                                                                                                                                                                                        |
| `channels.bluebubbles.includeAttachments`                  | `channels.imessage.includeAttachments`    | Same shape, same off-by-default. If attachments flowed on BlueBubbles, set this explicitly — inbound photos/media are silently dropped (no `Inbound message` log line) until you do.                                                                                             |
| `channels.bluebubbles.attachmentRoots`                     | `channels.imessage.attachmentRoots`       | Local roots; same wildcard rules.                                                                                                                                                                                                                                                |
| _(N/A)_                                                    | `channels.imessage.remoteAttachmentRoots` | Only used when `remoteHost` is set for SCP fetches.                                                                                                                                                                                                                              |
| `channels.bluebubbles.mediaMaxMb`                          | `channels.imessage.mediaMaxMb`            | Default 16 MB on iMessage (BlueBubbles default was 8 MB). Set explicitly to keep the lower cap.                                                                                                                                                                                  |
| `channels.bluebubbles.textChunkLimit`                      | `channels.imessage.textChunkLimit`        | Default 4000 on both.                                                                                                                                                                                                                                                            |
| `channels.bluebubbles.coalesceSameSenderDms`               | _(removed)_                               | Do not migrate this key. `imsg` 0.13.1 and newer coalesces Apple URL-preview split-sends before OpenClaw receives them; `openclaw doctor --fix` removes a stale iMessage key.                                                                                                    |
| `channels.bluebubbles.enrichGroupParticipantsFromContacts` | _(N/A)_                                   | `imsg` already surfaces sender display names from `chat.db`.                                                                                                                                                                                                                     |
| `channels.bluebubbles.actions.*`                           | `channels.imessage.actions.*`             | Same per-action toggles (`reactions`, `edit`, `unsend`, `reply`, `sendWithEffect`, `renameGroup`, `setGroupIcon`, `addParticipant`, `removeParticipant`, `leaveGroup`, `sendAttachment`) plus new `polls`. All default to enabled; private API actions still require the bridge. |

Multi-account configs (`channels.bluebubbles.accounts.*`) translate one-to-one to `channels.imessage.accounts.*`.

## Group registry footgun

The bundled iMessage plugin runs two group gates back to back. A group message must pass both to reach the agent:

1. **Sender / chat-target allowlist** (`channels.imessage.groupAllowFrom`) — matches the sender handle or the chat target (`chat_id:`, `chat_guid:`, `chat_identifier:` entries). When `groupAllowFrom` is unset, this gate falls back to `allowFrom`; an explicit `groupAllowFrom: []` disables that fallback and drops every group message under `groupPolicy: "allowlist"`.
2. **Group registry** (`channels.imessage.groups`) — keyed by numeric iMessage `chat_id`:
   - No `groups` block (or an empty one): groups pass this gate as long as gate 1 has a non-empty effective sender allowlist; sender filtering governs access and no drop-all startup warning fires.
   - `groups` with entries but no `"*"`: only the listed `chat_id` keys pass. Listing any group turns the registry into an allowlist even under `groupPolicy: "open"`.
   - `groups: { "*": { ... } }`: every group passes this gate.

The migration trap: BlueBubbles keyed `groups` entries by chat GUID / chat identifier, while the iMessage registry keys by numeric `chat_id`. Per-group entries copied verbatim create a non-empty registry whose keys never match, so every group message drops at gate 2. Copy the `"*"` wildcard verbatim; re-key specific group entries with `chat_id` values from `imsg chats`.

Both drop paths are visible at the default log level via `warn` lines:

- Once per account at startup, when `groupPolicy: "allowlist"` is set and the effective group sender allowlist is empty: `imessage: groupPolicy="allowlist" for account "<id>" but no group sender allowlist is configured ...`. Set `groupAllowFrom` (or `allowFrom`) to admit senders; adding `groups` alone does not satisfy the sender gate.
- Once per `chat_id` at runtime, when the registry drops a group: `imessage: dropping group message from chat_id=<id> ... not in channels.imessage.groups allowlist`, naming the exact key to add.

DMs keep working either way — they take a different code path, so DM success does not prove group routing.

The minimum sender-scoped config with `groupPolicy: "allowlist"`:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123", "chat_guid:any;-;..."],
    },
  },
}
```

This admits the configured senders in any group. Add `groups` entries to scope allowed chats or set per-chat options such as `requireMention`; copy the BlueBubbles `"*"` entry verbatim, but re-key specific entries with numeric iMessage `chat_id` values.

## Step-by-step

1. Translate the config. Keep the new block disabled while you edit; the old `channels.bluebubbles` block is ignored by current OpenClaw and can sit alongside as reference:

   ```json5
   {
     channels: {
       imessage: {
         enabled: false, // flip to true when ready to cut over
         cliPath: "/opt/homebrew/bin/imsg",
         dmPolicy: "pairing",
         allowFrom: ["+15555550123"], // copy from bluebubbles.allowFrom
         groupPolicy: "allowlist",
         groupAllowFrom: [], // copy from bluebubbles.groupAllowFrom
         groups: { "*": { requireMention: true } }, // wildcard copies verbatim; re-key per-chat entries by chat_id
         // actions default to enabled; set individual toggles false to disable
       },
     },
   }
   ```

2. **Cut over and probe.** Set `channels.imessage.enabled: true`, restart the Gateway, and confirm the channel reports healthy:

   ```bash
   openclaw gateway restart
   openclaw channels status --probe --channel imessage   # expect "works"; --json shows privateApi.available: true
   ```

   The probe requires a reachable Gateway and only probes configured, enabled accounts. Use the direct `imsg` commands in [Before you start](#before-you-start) to validate the Mac itself.

3. **Verify DMs.** Send the agent a direct message; confirm the reply lands.

4. **Verify groups separately.** DMs and groups take different code paths — DM success does not prove groups are routing. Send a message in an allowed group chat and confirm the reply lands. If the group goes silent (no agent reply, no error), check the gateway log for the two `warn` lines from "Group registry footgun" above. The startup warning means the effective sender allowlist is empty; a per-`chat_id` warning means a populated `groups` registry does not contain that chat.

5. **Verify the action surface.** From a paired DM, ask the agent to react, edit, unsend, reply, send a photo, and (in a group) rename the group or add/remove a participant. Each action should land natively in Messages.app. If any action throws `iMessage <action> requires the imsg private API bridge`, run `imsg launch` again and refresh with `openclaw channels status --probe`.

6. **Remove the BlueBubbles server and the `channels.bluebubbles` block** once iMessage DMs, groups, and actions are verified. OpenClaw does not read `channels.bluebubbles`.

## Action parity at a glance

| Action                                              | legacy BlueBubbles | bundled iMessage                                                              |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| Send text / SMS fallback                            | ✅                 | ✅                                                                            |
| Send media (photo, video, file, voice)              | ✅                 | ✅                                                                            |
| Threaded reply (`reply_to_guid`)                    | ✅                 | ✅ (closes [#51892](https://github.com/openclaw/openclaw/issues/51892))       |
| Tapback (`react`)                                   | ✅                 | ✅                                                                            |
| Edit / unsend (macOS 13+ recipients)                | ✅                 | ✅                                                                            |
| Send with screen effect                             | ✅                 | ✅ (closes part of [#9394](https://github.com/openclaw/openclaw/issues/9394)) |
| Rich text bold / italic / underline / strikethrough | ✅                 | ✅ (typed-run formatting via attributedBody)                                  |
| Native Messages polls (create and vote)             | ❌                 | ✅ (`actions.polls`; recipients need iOS/macOS 26+ for native rendering)      |
| Rename group / set group icon                       | ✅                 | ✅                                                                            |
| Add / remove participant, leave group               | ✅                 | ✅                                                                            |
| Read receipts and typing indicator                  | ✅                 | ✅ (gated on private API probe)                                               |
| Apple URL-preview split-send coalescing             | ✅                 | ✅ (handled upstream by `imsg` 0.13.1 and newer; no OpenClaw setting)         |
| Inbound recovery after a restart                    | ✅                 | ✅ (automatic: `since_rowid` replay + GUID dedupe; wider window on local)     |

iMessage recovers messages missed while the gateway was down: on startup it replays from the last dispatched rowid via `imsg watch.subscribe` `since_rowid`, dedupes by GUID, and a stale-backlog age fence suppresses the Push-flush "backlog bomb". This runs over the `imsg` RPC connection, so it works for remote SSH `cliPath` setups too; local setups get a wider recovery window because they can read `chat.db`. See [Inbound recovery after a bridge or gateway restart](/channels/imessage#inbound-recovery-after-a-bridge-or-gateway-restart).

## Pairing, sessions, and ACP bindings

- **Allowlists carry over by handle.** `channels.imessage.allowFrom` recognizes the same `+15555550123` / `user@example.com` strings BlueBubbles used — copy them verbatim.
- **Pairing-store approvals do not transfer.** The pairing store is per channel and nothing migrates the old BlueBubbles store. Senders who were approved only through pairing must pair once more under iMessage, or you add their handles to `allowFrom`.
- **Sessions** stay scoped per agent + chat. DMs collapse into the agent main session under default `session.dmScope=main`; group sessions stay isolated per `chat_id` (`agent:<agentId>:imessage:group:<chat_id>`). Old conversation history under BlueBubbles session keys does not carry into iMessage sessions.
- **ACP bindings** referencing `match.channel: "bluebubbles"` must change to `"imessage"`. The `match.peer.id` shapes (`chat_id:`, `chat_guid:`, `chat_identifier:`, bare handle) are identical.

## No rollback channel

There is no supported BlueBubbles runtime to switch back to. If iMessage verification fails, set `channels.imessage.enabled: false`, restart the Gateway, fix the `imsg` blocker, and retry the cutover.

The reply cache lives in SQLite plugin state. `openclaw doctor --fix` imports and archives the old `imessage/reply-cache.jsonl` sidecar when present.

## Related

- [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) — short announcement and operator summary.
- [iMessage](/channels/imessage) — full iMessage channel reference, including `imsg launch` setup and capability detection.
- `/channels/bluebubbles` — legacy URL that redirects to this migration guide.
- [Pairing](/channels/pairing) — DM authentication and pairing flow.
- [Channel Routing](/channels/channel-routing) — how the gateway picks a channel for outbound replies.
