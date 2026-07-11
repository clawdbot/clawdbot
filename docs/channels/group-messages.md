---
summary: "WhatsApp group message handling — activation, allowlists, sessions, and context injection"
read_when:
  - Configuring WhatsApp groups specifically
  - Changing WhatsApp activation modes (`mention` vs `always`)
  - Tuning WhatsApp group session keys or pending-message context
title: "WhatsApp group messages"
sidebarTitle: "WhatsApp groups"
---

For the cross-channel groups model (Discord, iMessage, Matrix, Microsoft Teams, QQBot, Signal, Slack, Telegram, WhatsApp, Zalo), see [Groups](/channels/groups). This page covers the WhatsApp-specific behavior on top of that model: activation, group allowlists, per-group session keys, and pending-message context injection.

Goal: let OpenClaw sit in WhatsApp groups, wake up only when pinged, and keep that thread separate from the personal DM session.

<Note>
`agents.list[].groupChat.mentionPatterns` is shared with the other channels' mention gating. For multi-agent setups, set it per agent, or use `messages.groupChat.mentionPatterns` as a global fallback. With neither set, patterns are derived from the agent identity name/emoji.
</Note>

## Behavior

- Activation modes: `mention` (default) or `always`. `mention` requires a ping: a real WhatsApp @-mention (`mentionedJids`), a configured regex pattern, the bot's E.164 digits anywhere in the text, or a quoted reply to one of the bot's messages (except shared-number self-chat setups). `always` wakes the agent on every message, but the injected group prompt tells it to reply only when it adds value and to return the exact silent token `NO_REPLY` (case-insensitive) otherwise. Defaults come from config (`channels.whatsapp.groups` `requireMention`) and can be overridden per group via `/activation`.
- Group allowlist: when `channels.whatsapp.groups` is set, only listed group JIDs are admitted (include `"*"` to allow all); messages from unlisted groups are dropped with a log hint.
- Group policy: `channels.whatsapp.groupPolicy` controls whether group messages are accepted (`open|disabled|allowlist`). `allowlist` uses `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Default is `allowlist` (blocked until you add senders).
- Per-group sessions: session keys look like `agent:<agentId>:whatsapp:group:<jid>` (non-default accounts append `:thread:whatsapp-account-<accountId>`), so directives such as `/verbose on`, `/trace on`, or `/think high` (sent as standalone messages) are scoped to that group; personal DM state is untouched.
- Context injection: **pending-only** group messages (default 50) that _did not_ trigger a run are prefixed under `[Chat messages since your last reply - for context]`, with the triggering line under `[Current message - respond to this]`. The pending window is cleared after the run; messages already in the session are not re-injected.
- Sender attribution: each group line carries the sender label inside the message envelope, e.g. `[WhatsApp <groupJid> <timestamp>] Alice (+447700900123): text`, and sender identity plus group subject/members ride along in the untrusted conversation-metadata block.
- Ephemeral/view-once: wrappers are unwrapped before extracting text/mentions, so pings inside them still trigger.
- Group system prompt: the first turn of a group session (and any turn after `/activation` changes the mode) injects activation guidance into the system prompt (`Activation: trigger-only ...` or `Activation: always-on ...`, plus "address the specific sender"). Persistent group-chat delivery guidance ("You are in a WhatsApp group chat...") is always included.

## Config example (WhatsApp)

Make display-name pings work even when WhatsApp strips the visual `@` from the text body:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
      historyLimit: 50, // pending group context window (default 50)
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Notes:

- The regexes are case-insensitive and use the same safe-regex guardrails as other config regex surfaces; invalid patterns and unsafe nested repetition are ignored.
- WhatsApp still sends canonical mentions via `mentionedJids` when someone taps the contact, so the number fallback is rarely needed but is a useful safety net.
- The pending-context window resolves as `channels.whatsapp.accounts.<id>.historyLimit` → `channels.whatsapp.historyLimit` → `messages.groupChat.historyLimit` → 50.

### Activation command (owner-only)

Use the group chat command:

- `/activation mention`
- `/activation always`

Only owner numbers (from `channels.whatsapp.allowFrom`, or the bot's own E.164 when unset) can change this; `/activation` from anyone else is ignored and stored as context only. Send `/status` as a standalone message in the group to see the current activation mode.

## How to use

1. Add your WhatsApp account (the one running OpenClaw) to the group.
2. Say `@openclaw ...` (or include the number). Only allowlisted senders can trigger it unless you set `groupPolicy: "open"`.
3. The agent prompt includes the pending group context plus sender-labeled lines so it can address the right person.
4. Session directives (`/verbose on`, `/trace on`, `/think high`, `/new` or `/reset`, `/compact`) apply only to that group's session; send them as standalone messages so they register. Your personal DM session stays independent.

## Testing / verification

- Manual smoke:
  - Send an `@openclaw` ping in the group and confirm a reply that references the sender name.
  - Send a second ping and verify the history block is included, then cleared on the next turn.
- Check gateway logs (run with `--verbose`) for `inbound web message` entries showing `from: <groupJid>` and the sender-labeled body.

## Known considerations

- Heartbeats run in the agent's main session; group sessions never get heartbeat runs.
- Echo suppression remembers the combined prompt (history + current message) per session so the bot's own delivered messages do not retrigger it; an identical repeated batch can be skipped as an echo.
- Session store entries appear as `agent:<agentId>:whatsapp:group:<jid>` in the per-agent SQLite session store; a missing entry just means the group has not triggered a run yet.
- Typing indicators follow `session.typingMode` / `agents.defaults.typingMode`. When visible replies are opted into message-tool-only mode, typing starts immediately by default so group members can see the agent working even if no automatic final reply is posted. Explicit typing-mode config still wins.

## Related

- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Broadcast groups](/channels/broadcast-groups)
