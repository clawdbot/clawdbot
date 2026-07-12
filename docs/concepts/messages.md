---
summary: "Message flow, sessions, queueing, and reasoning visibility"
read_when:
  - Explaining how inbound messages become replies
  - Clarifying sessions, queueing modes, or streaming behavior
  - Documenting reasoning visibility and usage implications
title: "Messages"
---

Inbound messages move through routing, dedupe/debounce, an agent run, and outbound delivery:

```text
Inbound message
  -> routing/bindings -> session key
  -> dedupe + debounce
  -> queue (if a run is already active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Key config surfaces:

- `messages.*` for prefixes, queueing, inbound debounce, and group behavior.
- `agents.defaults.*` for block streaming, chunking, and silent-reply defaults.
- Channel overrides (`channels.telegram.*`, `channels.whatsapp.*`, etc.) for per-channel caps and streaming toggles.

See [Configuration](/gateway/configuration) for the full schema.

## Inbound dedupe

Channels can redeliver the same message after a reconnect. OpenClaw keeps an in-memory cache keyed by agent scope, channel route (channel + peer + account + thread), and message id, so a redelivered message does not trigger a second agent run. The cache entry expires after 20 minutes or once 5000 entries are tracked, whichever comes first.

## Inbound debouncing

Rapid consecutive text messages from the same sender can be batched into one agent turn via `messages.inbound`. Debouncing is scoped per channel + conversation and uses the most recent message for reply threading/IDs.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        discord: 1500,
        slack: 1500,
        whatsapp: 5000,
      },
    },
  },
}
```

- Debounce applies to text-only messages; media/attachments flush immediately.
- Control commands (stop/abort/status, etc.) bypass debouncing so they dispatch immediately.
- Disabled by default: `messages.inbound.debounceMs` has no built-in default, so debouncing only activates once you set it (globally or per channel).
- iMessage's `coalesceSameSenderDms` opt-in is the one exception: it holds all same-sender DM text (commands included) long enough for Apple's command+URL split-send to arrive as one turn. Group chats always dispatch instantly regardless of this setting.

## Sessions and devices

Sessions are owned by the gateway, not by clients.

- Direct chats collapse into the agent's main session key.
- Groups/channels get their own session keys.
- The session store and transcripts live on the gateway host.

Multiple devices/channels can map to the same session, but history is not fully synced back to every client. Use one primary device for long conversations to avoid divergent context. The Control UI and TUI always show the gateway-backed session transcript, so they are the source of truth.

Details: [Session management](/concepts/session).

## Prompt bodies and history context

Channel plugins populate several text fields on the inbound context, from most to least preferred:

| Field             | Purpose                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `BodyForAgent`    | Model-facing text for the current turn. Falls back to `CommandBody` / `RawBody` / `Body` when unset.        |
| `BodyForCommands` | Clean text used for directive/command parsing. Falls back to `CommandBody` / `RawBody` / `Body` when unset. |
| `CommandBody`     | Legacy intermediate body; prefer `BodyForCommands`.                                                         |
| `RawBody`         | Deprecated alias for `CommandBody`.                                                                         |
| `Body`            | Legacy prompt body; may include channel envelopes and history wrappers.                                     |

When a channel supplies history, it wraps it with:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For non-direct chats (groups/channels/rooms), the current message body is prefixed with the sender label, matching the style used for history entries. Directive stripping only applies to the current-message section, so history stays intact. Channels that wrap history should set `BodyForCommands` (or the legacy `CommandBody` / `RawBody`) to the original message text and keep `Body` as the combined prompt.

History buffers are pending-only: they include group messages that did not trigger a run (for example, mention-gated messages) and exclude messages already in the session transcript. Structured history, reply, forwarded, and channel metadata render as untrusted user-role context blocks during prompt assembly.

Configure history size with `messages.groupChat.historyLimit` (global default) or per-channel overrides such as `channels.slack.historyLimit` and `channels.telegram.accounts.<id>.historyLimit` (set `0` to disable).

## Tool result metadata

Tool result `content` is the model-visible result; `details` is runtime metadata for UI rendering, diagnostics, media delivery, and plugins.

- `toolResult.details` is stripped before provider replay and before compaction input.
- Persisted session transcripts keep only bounded `details`; oversized metadata is replaced with a compact summary marked `persistedDetailsTruncated: true`.
- Plugins and tools should put text the model must read in `content`, not only in `details`.

## Queueing and followups

When a run is already active, inbound messages steer into it by default. `messages.queue` controls the mode:

| Mode              | Behavior                                            |
| ----------------- | --------------------------------------------------- |
| `steer` (default) | Inject the new prompt into the active run.          |
| `followup`        | Run the message after the active run finishes.      |
| `collect`         | Batch compatible messages into one later turn.      |
| `interrupt`       | Abort the active run, then start the newest prompt. |

Defaults: `messages.queue.debounceMs` is 500ms (applies to steer, followup, and collect batching alike), `messages.queue.cap` is 20 queued messages, and `messages.queue.drop` is `summarize` (`old` and `new` are also available). Configure per-channel overrides via `messages.queue.byChannel` and `messages.queue.debounceMsByChannel`.

Details: [Command queue](/concepts/queue) and [Steering queue](/concepts/queue-steering).

## Channel run ownership

Channel plugins may preserve ordering, debounce input, and apply transport backpressure before a message enters the session queue. They should not impose a separate timeout around the agent turn itself. Once a message is routed to a session, the session, tool, and runtime lifecycle govern long-running work so all channels report and recover from slow turns consistently.

## Streaming, chunking, and batching

Block streaming sends partial replies as the model produces text blocks; chunking respects channel text limits and avoids splitting fenced code.

- `agents.defaults.blockStreamingDefault` (`on|off`, default `off`)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (idle-based batching)
- `agents.defaults.humanDelay` (human-like pause between block replies)
- Channel overrides: `*.streaming.block.enabled` and `*.streaming.block.coalesce` on nested-streaming channels (Telegram, Discord, Slack, iMessage, Microsoft Teams); flat `*.blockStreaming` / `*.blockStreamingCoalesce` on channels without a nested streaming config. Block streaming is off unless explicitly enabled, on every channel including Telegram.

Details: [Streaming + chunking](/concepts/streaming).

## Reasoning visibility and tokens

- `/reasoning on|off|stream` controls visibility.
- Reasoning content still counts toward token usage when the model produces it.
- Telegram supports streaming reasoning into a transient draft bubble that is deleted after final delivery; use `/reasoning on` for persistent reasoning output.

Details: [Thinking + reasoning directives](/tools/thinking) and [Token use](/reference/token-use).

## Prefixes, threading, and replies

- Outbound prefix cascade: `messages.responsePrefix`, `channels.<channel>.responsePrefix`, `channels.<channel>.accounts.<id>.responsePrefix`. WhatsApp also has `channels.whatsapp.messagePrefix` for an inbound prefix.
- Reply threading via `replyToMode` and per-channel defaults.

Details: [Configuration](/gateway/config-agents#messages) and channel docs.

## Silent replies

The silent token `NO_REPLY` (case-insensitive, so `no_reply` also matches) means "do not deliver a user-visible reply." When a turn also has pending tool media, such as generated TTS audio, OpenClaw strips the silent text but still delivers the media attachment.

Silence policy resolves by conversation type:

- Direct conversations never receive `NO_REPLY` prompt guidance. If a direct run accidentally returns a bare silent token, OpenClaw suppresses it instead of rewriting or delivering it.
- Groups/channels allow silence by default. In `message_tool` visible-reply mode, silence means the model does not call `message(action=send)`.
- Internal orchestration allows silence by default.

Defaults live under `agents.defaults.silentReply`; `surfaces.<id>.silentReply` can override group/internal policy per surface.

OpenClaw also uses silent replies for generic internal runner failures in non-direct chats, so groups/channels do not see gateway error boilerplate. Classified failures with user-facing recovery copy, such as missing auth, rate-limit, or overload notices, can still be delivered. Direct chats show compact failure copy by default; raw runner details show only when `/verbose full` is enabled.

Bare silent replies are dropped on all surfaces, so parent sessions stay quiet instead of rewriting sentinel text into fallback chatter.

## Related

- [Message lifecycle refactor](/concepts/message-lifecycle-refactor) - target durable send and receive design
- [Streaming](/concepts/streaming) - real-time message delivery
- [Retry](/concepts/retry) - message delivery retry behavior
- [Queue](/concepts/queue) - message processing queue
- [Channels](/channels) - messaging platform integrations
