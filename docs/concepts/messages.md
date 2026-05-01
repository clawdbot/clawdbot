---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - Explaining how inbound messages become replies
  - Clarifying sessions, queueing modes, or streaming behavior
  - Documenting reasoning visibility and usage implications
title: "Messages"
---

OpenClaw handles inbound messages through a pipeline of session resolution, queueing, streaming, tool execution, and reasoning visibility. This page maps the path from inbound message to reply.

## Message flow (high level)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Key knobs live in configuration:

- `messages.*` for prefixes, queueing, and group behavior.
- `agents.defaults.*` for block streaming and chunking defaults.
- Channel overrides (`channels.whatsapp.*`, `channels.telegram.*`, etc.) for caps and streaming toggles.

See [Configuration](/gateway/configuration) for full schema.

## Inbound dedupe

Channels can redeliver the same message after reconnects. OpenClaw keeps a
short-lived cache keyed by channel/account/peer/session/message id so duplicate
deliveries do not trigger another agent run.

## Inbound debouncing

Rapid consecutive messages from the **same sender** can be batched into a single
agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

Config (global default + per-channel overrides):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notes:

- Debounce applies to **text-only** messages; media/attachments flush immediately.
- Control commands bypass debouncing so they remain standalone — **except** when a channel explicitly opts in to same-sender DM coalescing (e.g. [BlueBubbles `coalesceSameSenderDms`](/channels/bluebubbles#coalescing-split-send-dms-command--url-in-one-composition)), where DM commands wait inside the debounce window so a split-send payload can join the same agent turn.

## Sessions and devices

Sessions are owned by the gateway, not by clients.

- Direct chats collapse into the agent main session key.
- Groups/channels get their own session keys.
- The session store and transcripts live on the gateway host.

Multiple devices/channels can map to the same session, but history is not fully
synced back to every client. Recommendation: use one primary device for long
conversations to avoid divergent context. The Control UI and TUI always show the
gateway-backed session transcript, so they are the source of truth.

Details: [Session management](/concepts/session).

## Tool result metadata

Tool result `content` is the model-visible result. Tool result `details` is
runtime metadata for UI rendering, diagnostics, media delivery, and plugins.

OpenClaw keeps that boundary explicit:

- `toolResult.details` is stripped before provider replay and compaction input.
- Persisted session transcripts keep only bounded `details`; oversized metadata
  is replaced with a compact summary marked `persistedDetailsTruncated: true`.
- Plugins and tools should put text the model must read in `content`, not only
  in `details`.

## Inbound bodies and history context

OpenClaw separates the **prompt body** from the **command body**:

- `BodyForAgent`: primary model-facing text for the current message. Channel
  plugins should keep this focused on the sender's current prompt-bearing text.
- `Body`: legacy prompt fallback. This may include channel envelopes and
  optional history wrappers, but current channels should not rely on it as the
  primary model input when `BodyForAgent` is available.
- `CommandBody`: raw user text for directive/command parsing.
- `RawBody`: legacy alias for `CommandBody` (kept for compatibility).

When a channel supplies history, it uses a shared wrapper:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the
sender label (same style used for history entries). This keeps real-time and queued/history
messages consistent in the agent prompt.

History buffers are **pending-only**: they include group messages that did _not_
trigger a run (for example, mention-gated messages) and **exclude** messages
already in the session transcript.

Directive stripping only applies to the **current message** section so history
remains intact. Channels that wrap history should set `CommandBody` (or
`RawBody`) to the original message text and keep `Body` as the combined prompt.
Structured history, reply, forwarded, and channel metadata are rendered as
user-role untrusted context blocks during prompt assembly.
History buffers are configurable via `messages.groupChat.historyLimit` (global
default) and per-channel overrides like `channels.slack.historyLimit` or
`channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).

## Queueing and followups

If a run is already active, inbound messages can be queued, steered into the
current run, or collected for a followup turn.

- Configure via `messages.queue` (and `messages.queue.byChannel`).
- Default mode is `steer`, with a 500ms followup debounce when steering falls
  back to queued followup delivery.
- Modes: `steer`, `followup`, `collect`, `steer-backlog`, `interrupt`, and the
  legacy one-at-a-time `queue` mode.

Details: [Command queue](/concepts/queue) and [Steering queue](/concepts/queue-steering).

## Channel run ownership

Channel plugins may preserve ordering, debounce input, and apply transport
backpressure before a message enters the session queue. They should not impose a
separate timeout around the agent turn itself. Once a message is routed to a
session, long-running work is governed by the session, tool, and runtime
lifecycle so all channels report and recover from slow turns consistently.

## Streaming, chunking, and batching

Block streaming sends partial replies as the model produces text blocks.
Chunking respects channel text limits and avoids splitting fenced code.

Key settings:

- `agents.defaults.blockStreamingDefault` (`on|off`, default off)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle-based batching)
- `agents.defaults.humanDelay` (human-like pause between block replies)
- Channel overrides: `*.blockStreaming` and `*.blockStreamingCoalesce` (non-Telegram channels require explicit `*.blockStreaming: true`)

Details: [Streaming + chunking](/concepts/streaming).

## Reasoning visibility and tokens

OpenClaw can expose or hide model reasoning:

- `/reasoning on|off|stream` controls visibility.
- Reasoning content still counts toward token usage when produced by the model.
- Telegram supports reasoning stream into the draft bubble.

Details: [Thinking + reasoning directives](/tools/thinking) and [Token use](/reference/token-use).

## Prefixes, threading, and replies

Outbound message formatting is centralized in `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix`, and `channels.<channel>.accounts.<id>.responsePrefix` (outbound prefix cascade), plus `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)
- Reply threading via `replyToMode` and per-channel defaults

Details: [Configuration](/gateway/config-agents#messages) and channel docs.

## Silent replies

The exact silent token `NO_REPLY` / `no_reply` means “do not deliver a user-visible reply”.
When a turn also has pending tool media, such as generated TTS audio, OpenClaw
strips the silent text but still delivers the media attachment.
OpenClaw resolves that behavior by conversation type:

- Direct conversations disallow silence by default and rewrite a bare silent
  reply to a short visible fallback.
- Groups/channels allow silence by default.
- Internal orchestration allows silence by default.

OpenClaw also uses silent replies for internal runner failures that happen
before any assistant reply in non-direct chats, so groups/channels do not see
gateway error boilerplate. Direct chats show compact failure copy by default;
raw runner details are shown only when `/verbose` is `on` or `full`.

Defaults live under `agents.defaults.silentReply` and
`agents.defaults.silentReplyRewrite`; `surfaces.<id>.silentReply` and
`surfaces.<id>.silentReplyRewrite` can override them per surface.

When the parent session has one or more pending spawned subagent runs, bare
silent replies are dropped on all surfaces instead of being rewritten, so the
parent stays quiet until the child completion event delivers the real reply.

## Related

- [Streaming](/concepts/streaming) — real-time message delivery
- [Retry](/concepts/retry) — message delivery retry behavior
- [Queue](/concepts/queue) — message processing queue
- [Channels](/channels) — messaging platform integrations
