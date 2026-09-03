---
summary: "Routing rules per channel (WhatsApp, Telegram, Discord, Slack) and shared context"
read_when:
  - Changing channel routing or inbox behavior
title: "Channel routing"
---

# Channels & routing

OpenClaw routes replies **back to the channel where a message came from**. The
model does not choose a channel; routing is deterministic and controlled by the
host configuration. Under the default DM scope, direct messages from every
channel converge on the agent's [main session](/concepts/main-session).

## Key terms

- **Channel**: a channel plugin such as `discord`, `googlechat`, `imessage`, `irc`, `line`, `signal`, `slack`, `telegram`, or `whatsapp`. `webchat` is the internal WebChat UI channel and is not a configurable outbound channel.
- **AccountId**: per-channel account instance (when supported).
- Optional channel default account: `channels.<channel>.defaultAccount` chooses
  which account is used when an outbound path does not specify `accountId`.
  - In multi-account setups, set an explicit default (`defaultAccount` or an account named `default`) when two or more accounts are configured. Without it, fallback routing may pick the first normalized account ID.
- **AgentId**: an isolated workspace + session store ("brain").
- **SessionKey**: the bucket key used to store context and control concurrency.

## Outbound target prefixes

Explicit outbound targets may include a provider prefix, such as `telegram:123` or `tg:123`. Core treats that prefix as a channel-selection hint only when the selected channel is `last` or otherwise unresolved, and only when the loaded plugin advertises that prefix. If the caller already selected an explicit channel, the provider prefix must match that channel; cross-channel combinations such as WhatsApp delivery to `telegram:123` fail before plugin-specific target normalization.

Target-kind and service prefixes such as `channel:<id>`, `user:<id>`, `room:<id>`, `thread:<id>`, `imessage:<handle>`, and `sms:<number>` stay inside the selected channel's grammar. They do not select the provider by themselves.

## Session key shapes (examples)

Direct messages collapse to the agent's **main** session by default:

- `agent:<agentId>:main` (for example: `agent:main:main`)

`session.dmScope` controls DM collapsing: `main` (default) shares one main
session, while `per-peer`, `per-channel-peer`, and `per-account-channel-peer`
keep DMs in separate sessions. A route binding can override the scope for its
matched peers via `bindings[].session.dmScope`.

Even when direct-message conversation history is shared with main, sandbox and
tool policy use a derived per-account direct-chat runtime key for external DMs
so channel-originated messages are not treated like local main-session runs.

With the default `session.groupScope: "per-group"`, groups and channels remain
isolated per channel:

- Groups: `agent:<agentId>:<channel>:group:<id>`
- Channels/rooms: `agent:<agentId>:<channel>:channel:<id>`

Set `session.groupScope: "main"` to route all non-direct peers into the agent's
main session, or use `bindings[].session.groupScope` for selected rooms. The
binding override wins over the global value. This changes shared context only;
mention gating and replies still use the originating group or channel.

Threads:

- Slack/Discord threads append `:thread:<threadId>` to the base key.
- Telegram forum topics embed `:topic:<topicId>` in the group key.

Examples:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Main DM route pinning

When `session.dmScope` is `main`, direct messages may share one main session.
To prevent the session's `lastRoute` from being overwritten by non-owner DMs,
OpenClaw infers a pinned owner from `allowFrom` when all of these are true:

- `allowFrom` has exactly one non-wildcard entry.
- The entry can be normalized to a concrete sender ID for that channel.
- The inbound DM sender does not match that pinned owner.

In that mismatch case, OpenClaw still records inbound session metadata, but it
skips updating the main session `lastRoute`.

## Guarded inbound recording

Channel plugins can mark an inbound session record as `createIfMissing: false`
when a guarded path must not create a new OpenClaw session. In that mode,
OpenClaw may update metadata and `lastRoute` for an existing session, but it
does not create a route-only session entry just because a message was observed.

## Routing rules (how an agent is chosen)

Routing picks **one agent** for each inbound message:

1. **Exact peer match** (`bindings` with `peer.kind` + `peer.id`).
2. **Parent peer match** (thread inheritance).
3. **Peer wildcard match** (`peer.id: "*"` for a peer kind).
4. **Guild + roles match** (Discord) via `guildId` + `roles`.
5. **Guild match** (Discord) via `guildId`.
6. **Team match** (Slack) via `teamId`.
7. **Account match** (`accountId` on the channel).
8. **Channel match** (any account on that channel, `accountId: "*"`).
9. **Default agent** (`agents.entries.*.default`, else first list entry, fallback to `main`).

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

- `agents.entries`: named agent definitions (workspace, model, etc.).
- `bindings`: map inbound channels/accounts/peers to agents.

Example:

```json5
{
  agents: {
    entries: {
      support: {
        default: true,
        name: "Support",
        workspace: "~/.openclaw/workspace-support",
      },
    },
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    {
      match: { channel: "slack", peer: { kind: "channel", id: "C0123TEAM" } },
      agentId: "support",
      session: { groupScope: "main" },
    },
  ],
}
```

## Session storage

Runtime session rows and transcripts live in each agent's SQLite database under
the state directory (default `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`

Older installs may have legacy transcript JSONL files and a `sessions.json` row
store under `~/.openclaw/agents/<agentId>/sessions/`. To import that history into
SQLite, stop the Gateway, back up its state, and run `openclaw doctor --fix`
before restarting it. Gateway startup does not import legacy session files: if
it finds a legacy store, it refuses readiness and prints the Doctor command for
the active profile. Use `openclaw doctor --session-sqlite inspect
--session-sqlite-all-agents` and the
[Doctor](/cli/doctor#session-sqlite-migration) migration sequence for inspection
and validation.

`session.store` supports `{agentId}` templating. At runtime, a legacy store path
selects its corresponding SQLite database; the JSON file itself is only a
migration input or an explicit offline-maintenance target.

Gateway session discovery can include on-disk stores under the default `agents/`
root and templated `session.store` roots that use the
`agents/<agentId>/sessions/sessions.json` layout. It recognizes the corresponding
`agent/openclaw-agent.sqlite` database without requiring a legacy `sessions.json`
file. Discovered store files must be regular files within the resolved agent
root; symlinked store files and out-of-root paths are ignored.

ACP session discovery reads SQLite ACP metadata and joins it to the corresponding
session entries.

## WebChat behavior

WebChat attaches to the **selected agent** and defaults to the agent's main
session. Because of this, WebChat lets you see cross-channel context for that
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
