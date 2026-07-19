---
summary: "One rolling conversation across all your channels: the personal-agent default"
read_when:
  - You want to understand where your agent "lives"
  - You expect the same context whether you write on Telegram, WhatsApp, or the web
  - You want your agent to know what happens in groups and side threads
title: "The main session"
---

OpenClaw is a personal agent first. Out of the box, every direct message you
send it — from Telegram, WhatsApp, iMessage, Slack DMs, the web app, anywhere —
lands in **one rolling conversation**: the main session. Ask something on your
phone, follow up from your laptop, and the agent has the same context in both
places. There is one brain, and this is where it thinks.

Under the hood the main session is an ordinary session with the key
`agent:<agentId>:main` (for example `agent:main:main`). What makes it special
is that the default DM scope collapses all direct messages into it, and that
the rest of the system treats it as the agent's root: heartbeats wake it,
background work reports back to it, and activity elsewhere flows up to it.

## Home

In the web app, the main session is the **Home** page — the first entry in the
sidebar. The identity row at the top is your agent (click it for the agent
menu); Home is where you talk to it. Sessions that fork off the main
conversation appear under **Threads**, group chats under **Groups**, and
coding/CLI sessions under **Coding**.

## What flows into the main session

The main session is not just a chat log; it is the place where your agent's
world converges:

- **Group activity.** Group and room sessions stay isolated (see below), but
  under the default DM scope the main session automatically watches them.
  Activity queues up as compact notices — coalesced per conversation, never
  one wake-up per message — and the agent sees them the next time it runs: on
  your next message or on a scheduled heartbeat. The agent can also read the
  sessions it watches, so "what did I miss in the family group?" works.
- **Background work.** Sub-agents and spawned sessions announce their results
  back to the session that started them, so work the agent kicked off from
  Home reports back to Home.
- **Heartbeats.** Scheduled heartbeats target the main session, which is what
  turns queued notices into awareness even when you have not written anything.

## Memory across resets and conversations

The rolling conversation is bounded by the model's context window, so
continuity comes from layers around it:

- `MEMORY.md`, the agent's curated long-term memory, is loaded into every
  fresh session. Daily notes (`memory/YYYY-MM-DD.md`) are searchable on demand
  and recent ones are re-primed after a `/new` or `/reset`. Before compaction,
  the agent flushes durable facts into the daily notes so long conversations
  do not silently lose them.
- **Memory recall across conversations** lets the agent recall content from
  its other private sessions. On personal setups — global
  `session.dmScope` resolving to `main` with no per-binding DM overrides — it
  is enabled by default; any configured DM isolation turns it off unless you
  opt in explicitly. See [Memory configuration](/reference/memory-config).

## A rolling session with durable history

The main session rolls forward through resets and compaction rather than
making the model carry its entire history at once:

- By default there is no automatic reset; compaction keeps the active context
  bounded while preserving the rolling session. Daily and idle resets are
  opt-in (see [Session management](/concepts/session)). On `/new` and `/reset`,
  the tail of the ending conversation is saved to daily memory notes, and the
  next session re-primes recent notes. Reset assigns a new live session id but
  keeps the previous SQLite transcript searchable under the same main-session
  key.
- When the conversation approaches the context window, compaction summarizes
  and continues in place — the transcript history stays in the session store.
- Session lists show the current live conversation, not every historical
  session id behind it.
- When the per-agent store's physical database, WAL, and session artifacts
  exceed the disk budget (default 10 GB), OpenClaw extracts the oldest
  unreferenced history to a verified compressed archive before removing its
  database rows. Live, routed, and in-flight sessions are never budget victims.

## When you want isolation instead

The shared main session is the right default for an agent that only you talk
to. If several people can message your agent, isolate DMs:

```json5
{
  session: {
    dmScope: "per-channel-peer",
  },
}
```

With an isolating scope, each sender gets their own session, group watching
from the main session is disabled, and cross-conversation memory recall
defaults off. `openclaw security audit` recommends isolation when it detects
multiple DM senders. The full scope matrix, identity linking, and per-route
overrides are covered in [Session management](/concepts/session) and
[Channel routing](/channels/channel-routing).

## Related

- [Session management](/concepts/session) — routing, scopes, resets
- [Channel routing](/channels/channel-routing) — how agents and sessions are selected
- [Memory](/concepts/memory) — durable memory layers
- [Multi-agent](/concepts/multi-agent) — running several isolated agents
