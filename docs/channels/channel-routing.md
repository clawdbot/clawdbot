---
summary: "Routing rules per channel (WhatsApp, Telegram, Discord, Slack) and shared context"
read_when:
  - Changing channel routing or inbox behavior
title: "Channel routing"
---

# Channels & routing

OpenClaw routes replies **back to the channel where a message came from**. The
model does not choose a channel; routing is deterministic and controlled by the
host configuration.

## Key terms

- **Channel**: `telegram`, `whatsapp`, `discord`, `irc`, `googlechat`, `slack`, `signal`, `imessage`, `line`, plus plugin channels. `webchat` is the internal WebChat UI channel and is not a configurable outbound channel.
- **AccountId**: per‑channel account instance (when supported).
- Optional channel default account: `channels.<channel>.defaultAccount` chooses
  which account is used when an outbound path does not specify `accountId`.
  - In multi-account setups, set an explicit default (`defaultAccount` or `accounts.default`) when two or more accounts are configured. Without it, fallback routing may pick the first normalized account ID.
- **AgentId**: an isolated workspace + session store (“brain”).
- **SessionKey**: the bucket key used to store context and control concurrency.

## Session key shapes (examples)

Direct messages collapse to the agent’s **main** session by default:

- `agent:<agentId>:<mainKey>` (default: `agent:main:main`)

Even when direct-message conversation history is shared with main, sandbox and
tool policy use a derived per-account direct-chat runtime key for external DMs
so channel-originated messages are not treated like local main-session runs.

Groups and channels remain isolated per channel:

- Groups: `agent:<agentId>:<channel>:group:<id>`
- Channels/rooms: `agent:<agentId>:<channel>:channel:<id>`

Threads:

- Slack/Discord threads append `:thread:<threadId>` to the base key.
- Telegram forum topics embed `:topic:<topicId>` in the group key.

Examples:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Main DM route pinning

When `session.dmScope` is `main`, direct messages may share one main session.
To prevent the session’s `lastRoute` from being overwritten by non-owner DMs,
OpenClaw infers a pinned owner from `allowFrom` when all of these are true:

- `allowFrom` has exactly one non-wildcard entry.
- The entry can be normalized to a concrete sender ID for that channel.
- The inbound DM sender does not match that pinned owner.

In that mismatch case, OpenClaw still records inbound session metadata, but it
skips updating the main session `lastRoute`.

## Routing rules (how an agent is chosen)

Routing picks **one agent** for each inbound message:

1. **Exact peer match** (`bindings` with `peer.kind` + `peer.id`).
2. **Parent peer match** (thread inheritance).
3. **Guild + roles match** (Discord) via `guildId` + `roles`.
4. **Guild match** (Discord) via `guildId`.
5. **Team match** (Slack) via `teamId`.
6. **Account match** (`accountId` on the channel).
7. **Channel match** (any account on that channel, `accountId: "*"`).
8. **Default agent** (`agents.list[].default`, else first list entry, fallback to `main`).

When a binding includes multiple match fields (`peer`, `guildId`, `teamId`, `roles`), **all provided fields must match** for that binding to apply.

The matched agent determines which workspace and session store are used.

## Broadcast groups (run multiple agents)

Broadcast groups let you run **multiple agents** for the same peer **when OpenClaw would normally reply** (for example: in WhatsApp groups, after mention/activation gating).

Config:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

See: [Broadcast Groups](/channels/broadcast-groups).

## Config overview

- `agents.list`: named agent definitions (workspace, model, etc.).
- `bindings`: map inbound channels/accounts/peers to agents.

Example:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Session storage

Session stores live under the state directory (default `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL transcripts live alongside the store

You can override the store path via `session.store` and `{agentId}` templating.

Gateway and ACP session discovery also scans disk-backed agent stores under the
default `agents/` root and under templated `session.store` roots. Discovered
stores must stay inside that resolved agent root and use a regular
`sessions.json` file. Symlinks and out-of-root paths are ignored.

## WebChat behavior

WebChat attaches to the **selected agent** and defaults to the agent’s main
session. Because of this, WebChat lets you see cross‑channel context for that
agent in one place.

## Reply context

Inbound replies include:

- `ReplyToId`, `ReplyToBody`, and `ReplyToSender` when available.
- Quoted context is appended to `Body` as a `[Replying to ...]` block.

This is consistent across channels.

## Related

- [Groups](/channels/groups)
- [Broadcast groups](/channels/broadcast-groups)
- [Pairing](/channels/pairing)
