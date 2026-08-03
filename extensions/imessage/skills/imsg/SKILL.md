---
name: imsg
description: "Use the imsg CLI from OpenClaw agents for iMessage/SMS DMs, groups, replies, reactions, polls, watching, and private-API actions."
homepage: https://imsg.to
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "os": ["darwin"],
        "requires": { "bins": ["imsg"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/imsg",
              "bins": ["imsg"],
              "label": "Install imsg (brew)",
            },
          ],
      },
  }
---

# imsg

Use `imsg` when an OpenClaw agent must act through the user's local macOS Messages.app account: inspect iMessage/SMS history, choose the correct DM or group, send messages/files, reply, react, vote in polls, or use private-API iMessage features.

Do not use this skill for Telegram, Signal, WhatsApp, Discord, Slack, or for replying inside the current OpenClaw conversation when the configured channel already routes the reply.

## Agent Flow

1. Resolve the conversation first.
2. Choose DM, existing group, or new group.
3. Pick the lowest-capability command that can do the requested action.
4. Show the exact resolved destination, service, content, attachments, and action.
   Wait for explicit approval of that preview before any send or visible state change;
   the original request is not approval of the eventual command.
5. Execute with stable identifiers: prefer `--chat-id` for normal sends/watch/history and `--chat` chat GUID for bridge actions.

Never infer a recipient from a casual name alone when several chats or handles could match. Show the matched display name, handle(s), group participants, and message text/action before sending.

## Host Requirements

- macOS 14+ with Messages.app signed in for send/react/bridge actions.
- Private API mode is strongly encouraged for OpenClaw iMessage. It unlocks replies, precise tapbacks, effects, polls, attachment replies, read/typing actions, and group management. Basic mode is a fallback for reads plus plain text/file send.
- Full Disk Access for the process context that runs `imsg` or OpenClaw; reads fail without Messages DB access.
- Automation permission for Messages.app when using public `send`.
- Accessibility permission for the process context that runs public `imsg react`; it uses System Events UI automation. Bridge `tapback` uses private API instead.
- Optional Contacts permission for contact-name resolution.
- SMS sends require Text Message Forwarding from the user's iPhone to this Mac.
- Linux reads a copied `chat.db` only; it cannot send, react, launch Messages.app, mark read, or type.

## Resolve Targets

Use `--json` reads. Output is newline-delimited JSON; use `jq -s` when `jq` is available, or consume one object per line directly.

```bash
imsg chats --limit 25 --json | jq -s
imsg search --query "dinner" --match contains --json | jq -s
imsg history --chat-id 42 --limit 20 --attachments --json | jq -s
imsg group --chat-id 42 --json
```

Target rules:

- DM to a phone/email: use `imsg send --to` when the user gave an exact handle, or after a single unambiguous chat match.
- Existing DM thread: `imsg send --chat-id <id>` is safer than re-resolving a name.
- Existing group: inspect with `imsg group --chat-id <id> --json`; send with `--chat-id`, bridge with the chat GUID from `group`.
- New group: use `chat-create` only when the user explicitly asked to create a group or no existing group matches.
- Ambiguous group names: confirm participants, not just display name.
- SMS: use `--service sms` only when requested or when iMessage fallback is not desired. SMS relay requires Text Message Forwarding.

Do not make `jq` a hard prerequisite for the skill; it is only a convenient formatter for examples.

## Capability Choice

Use standard commands for reads, target resolution, and plain sends:

- Read/list/search/watch: `chats`, `group`, `history`, `search`, `watch`
- Basic text/file send: `send`
- Standard tapback to most recent incoming message in a chat: `react`

Use the private API bridge for the native iMessage actions OpenClaw users normally expect:

- Rich replies, text formatting, effects, subjects, multipart sends
- Native Apple Messages polls and poll votes
- Tapback by message GUID or tapback removal
- Edit, unsend, delete, notify anyways
- Read receipts, typing indicators, bridge event watch
- Group create/name/photo/member/leave/delete/mark actions
- Account, whois, nickname checks

For OpenClaw channel setup, check bridge availability early:

```bash
imsg status --json
```

If the host supports bridge actions but Messages is not injected yet, ask before running `imsg launch`. It kills and relaunches Messages.app to inject the bridge, so treat it as a visible state change:

```bash
imsg launch
imsg status --json
```

If SIP, library validation, private entitlement checks, or missing selectors still block the capability, explain that the requested private-API action is unavailable on this host and offer the closest non-bridge action, if one exists. Do not silently downgrade a threaded reply, effect, subject, poll, or GUID-targeted tapback into a plain send/react.

## DM Scenarios

Exact handle, basic send:

```bash
imsg send --to "+14155551212" --text "On my way" --service auto
```

Known DM thread:

```bash
imsg send --chat-id 42 --text "On my way"
imsg send --chat-id 42 --file /path/to/photo.jpg
```

Force channel only when the user asks:

```bash
imsg send --to "+14155551212" --text "green bubble" --service sms
imsg send --to "+14155551212" --text "iMessage only" --service imessage --no-sms-fallback
```

Threaded reply, formatting, effects, or attachment reply:

```bash
imsg send-rich --chat 'iMessage;-;+15551234567' \
  --reply-to <message-guid> --text "reply text"
imsg send-rich --chat 'iMessage;-;+15551234567' --text 'hello world' \
  --format '[{"start":0,"length":5,"styles":["bold"]}]'
imsg send-rich --chat 'iMessage;-;+15551234567' --text "boom" --effect impact
imsg send-attachment --chat 'iMessage;-;+15551234567' \
  --reply-to <message-guid> --file /path/to/file.jpg
```

Formatting ranges are UTF-16 positions. Supported styles include `bold`, `italic`, `underline`, and `strikethrough`; use `--format-file` for generated JSON.

## Group Scenarios

Inspect before acting:

```bash
imsg group --chat-id 42 --json
imsg history --chat-id 42 --limit 20 --json | jq -s
```

Send to an existing group:

```bash
imsg send --chat-id 42 --text "Works for me"
```

Bridge reply or poll in an existing group:

```bash
imsg send-rich --chat 'iMessage;+;chat0000' \
  --reply-to <message-guid> --text "replying in thread"
imsg poll send --chat 'iMessage;+;chat0000' \
  --question "Dinner?" --option "Pizza" --option "Sushi"
```

Create or mutate groups only on explicit request:

```bash
imsg chat-create --addresses '+15551111111,+15552222222' --name 'Crew' --text 'gm'
imsg chat-name --chat 'iMessage;+;chat0000' --name 'Renamed'
imsg chat-photo --chat 'iMessage;+;chat0000' --file /path/to/group.jpg
imsg chat-add-member --chat 'iMessage;+;chat0000' --address +15553333333
imsg chat-remove-member --chat 'iMessage;+;chat0000' --address +15553333333
imsg chat-leave --chat 'iMessage;+;chat0000'
imsg chat-delete --chat 'iMessage;+;chat0000'
imsg chat-mark --chat 'iMessage;+;chat0000' --read
```

Group mutations are highly visible. Confirm the exact group and participant list before changing membership, name, photo, read state, leaving, or deleting.

## Reactions and Replies

Public `react` is limited: it reacts to the most recent incoming message in the chat.

```bash
imsg react --chat-id 42 --reaction like
imsg react --chat-id 42 --reaction love
imsg react --chat-id 42 --reaction dislike
imsg react --chat-id 42 --reaction laugh
imsg react --chat-id 42 --reaction emphasis
imsg react --chat-id 42 --reaction question
```

For a specific message GUID or removal, use bridge `tapback`:

```bash
imsg tapback --chat 'iMessage;-;+15551234567' --message <message-guid> --kind love
imsg tapback --chat 'iMessage;-;+15551234567' --message <message-guid> --kind love --remove
```

Use `send-rich --reply-to <message-guid>` for threaded replies. Confirm the referenced message if the user says "that" or "the previous one".

## Polls

Native Apple Messages polls require the bridge. Creation needs at least two `--option` values. Voting requires one of `--option-id`, `--option-index`, or `--option`.

Messages renders only the options on a poll balloon, so current `imsg poll send` echoes `--question` as a best-effort plain caption after the poll. Use `--comment` to override that caption. Do not retry automatically when only the caption fails: the poll may already be delivered.

```bash
imsg poll send --chat 'iMessage;-;+15551234567' \
  --question "Dinner?" --option "Pizza" --option "Sushi" --comment "Vote by 5pm"
imsg poll send --chat 'iMessage;+;chat0000' --reply-to <message-guid> \
  --question "Approve?" --option "Yes" --option "No"
imsg poll vote --chat 'iMessage;+;chat0000' \
  --poll <poll-message-guid> --option-id <option-id>
```

Find poll IDs and options with:

```bash
imsg history --chat-id 42 --limit 20 --json | jq -s '.[] | select(.poll != null) | {guid, poll}'
```

`history` and `watch` backfill a title-less inbound native poll's `poll.question` from its clean caption row. Poll vote rows are `poll` events, not tapbacks; `watch --reactions` is not required to see them.

## Watch and Long-Running Agents

For a short one-off wait, use `watch`:

```bash
imsg watch --chat-id 42 --since-rowid 9000 --json
imsg watch --chat-id 42 --attachments --convert-attachments --json
imsg watch --chat-id 42 --reactions --json
imsg watch --chat-id 42 --bb-events --json
```

`--since-rowid` is exclusive. Without it, `watch` starts at the newest row. `watch` uses filesystem events plus a low-frequency polling fallback, so it can catch up after missed SQLite sidecar events. Poll objects appear without `--reactions`.

For a daemon or multi-chat integration, use `imsg rpc`. It speaks JSON-RPC 2.0 over stdin/stdout. Inspect `imsg status --json` for `rpc_methods` before using newer bridge or poll methods.

## Safety Rules

- Confirm recipient, chat, and content before every send unless the user's request already contains exact values.
- Confirm visible state changes: read receipts, typing indicators, edits, unsends, deletes, poll votes, tapbacks, group membership, group name/photo, leaving/deleting chats.
- Never send to unknown numbers or ambiguous contact-name matches without approval.
- Confirm attachments exist and are the intended files.
- Prefer E.164 phone numbers; use `--region US` or another region only when needed for local formats.
- Use bridge actions for bridge-only semantics, but confirm visible state changes and destructive actions first.
