---
summary: "Loopback WebChat static host and Gateway WS usage for chat UI"
read_when:
  - Debugging or configuring WebChat access
title: "WebChat"
---

Status: the macOS/iOS SwiftUI chat UI talks directly to the Gateway WebSocket.

## What it is

- A native chat UI for the gateway (no embedded browser and no local static server).
- Uses the same sessions and routing rules as other channels.
- Deterministic routing: replies always go back to WebChat.

## Quick start

1. Start the gateway.
2. Open the WebChat UI (macOS/iOS app) or the Control UI chat tab.
3. Ensure a valid gateway auth path is configured (shared-secret by default,
   even on loopback).

## How it works (behavior)

- The UI connects to the Gateway WebSocket and uses `chat.history`, `chat.send`, and `chat.inject`.
- `chat.history` is bounded for stability: Gateway may truncate long text fields, omit heavy metadata, and replace oversized entries with `[chat.history omitted: message too large]`.
- `chat.history` follows the active transcript branch for modern append-only session files, so abandoned rewrite branches and superseded prompt copies are not rendered in WebChat.
- Compaction entries render as an explicit compacted-history divider. The divider explains that earlier turns are preserved in a checkpoint and links to the Sessions checkpoint controls, where operators can branch or restore the pre-compaction view when their permissions allow it.
- Control UI remembers the backing Gateway `sessionId` returned by `chat.history` and includes it on follow-up `chat.send` calls, so reconnects and page refreshes continue the same stored conversation unless the user starts or resets a session.
- Control UI coalesces duplicate in-flight submits for the same session, message, and attachments before generating a new `chat.send` run id; the Gateway still dedupes repeated requests that reuse the same idempotency key.
- Workspace startup files and pending `BOOTSTRAP.md` instructions are supplied through the agent system prompt's Project Context, not copied into the WebChat user message. Bootstrap truncation only adds a concise system-prompt recovery notice; detailed counts and config knobs stay on diagnostic surfaces.
- `chat.history` is also display-normalized: runtime-only OpenClaw context,
  inbound envelope wrappers, inline delivery directive tags
  such as `[[reply_to_*]]` and `[[audio_as_voice]]`, plain-text tool-call XML
  payloads (including `<tool_call>...</tool_call>`,
  `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`,
  `<function_calls>...</function_calls>`, and truncated tool-call blocks), and
  leaked ASCII/full-width model control tokens are stripped from visible text,
  and assistant entries whose whole visible text is only the exact silent
  token `NO_REPLY` / `no_reply` are omitted.
- Reasoning-flagged reply payloads (`isReasoning: true`) are excluded from WebChat assistant content, transcript replay text, and audio content blocks, so thinking-only payloads do not surface as visible assistant messages or playable audio.
- `chat.inject` appends an assistant note directly to the transcript and broadcasts it to the UI (no agent run).
- Aborted runs can keep partial assistant output visible in the UI.
- Gateway persists aborted partial assistant text into transcript history when buffered output exists, and marks those entries with abort metadata.
- History is always fetched from the gateway (no local file watching).
- If the gateway is unreachable, WebChat is read-only.

### Transcript and delivery model

WebChat has two separate data paths:

- The session JSONL file is the durable model/runtime transcript. For normal agent runs, Pi persists model-visible `user`, `assistant`, and `toolResult` messages through its session manager. WebChat does not write arbitrary delivery, status, or helper text into that transcript.
- Gateway `ReplyPayload` events are the live delivery projection. They can be normalized for WebChat/channel display, block streaming, directive tags, media embedding, TTS/audio flags, and UI fallback behavior. They are not themselves the canonical session log.
- Harnesses that require visible replies through `tools.message` still use WebChat as a current-run internal source reply sink. A targetless `message.send` from that active WebChat run is projected into the same chat and mirrored to the session transcript; WebChat does not become a reusable outbound channel and never inherits `lastChannel`.
- WebChat injects assistant transcript entries only when the Gateway owns a displayed message outside a normal Pi assistant turn: `chat.inject`, non-agent command replies, aborted partial output, and WebChat-managed media transcript supplements.
- `chat.history` reads the stored session transcript and applies WebChat display projection. If live assistant text appears during a run but disappears after history reload, first check whether the raw JSONL contains the assistant text, then whether `chat.history` projection stripped it, then whether the Control UI optimistic-tail merge replaced local delivery state with the persisted snapshot.

Normal agent-run final answers should be durable because Pi writes the assistant `message_end`. Any fallback that mirrors a delivered final payload into the transcript must first avoid duplicating an assistant turn that Pi already wrote.

## Control UI agents tools panel

- The Control UI `/agents` Tools panel has two separate views:
  - **Available Right Now** uses `tools.effective(sessionKey=...)` and shows what the current
    session can actually use at runtime, including core, plugin, and channel-owned tools.
  - **Tool Configuration** uses `tools.catalog` and stays focused on profiles, overrides, and
    catalog semantics.
- Runtime availability is session-scoped. Switching sessions on the same agent can change the
  **Available Right Now** list.
- The config editor does not imply runtime availability; effective access still follows policy
  precedence (`allow`/`deny`, per-agent and provider/channel overrides).

## Remote use

- Remote mode tunnels the gateway WebSocket over SSH/Tailscale.
- You do not need to run a separate WebChat server.

## Configuration reference (WebChat)

Full configuration: [Configuration](/gateway/configuration)

WebChat options:

- `gateway.webchat.chatHistoryMaxChars`: maximum character count for text fields in `chat.history` responses. When a transcript entry exceeds this limit, Gateway truncates long text fields and may replace oversized messages with a placeholder. Per-request `maxChars` can also be sent by the client to override this default for a single `chat.history` call.

Related global options:

- `gateway.port`, `gateway.bind`: WebSocket host/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`:
  shared-secret WebSocket auth.
- `gateway.auth.allowTailscale`: browser Control UI chat tab can use Tailscale
  Serve identity headers when enabled.
- `gateway.auth.mode: "trusted-proxy"`: reverse-proxy auth for browser clients behind an identity-aware **non-loopback** proxy source (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote gateway target.
- `session.*`: session storage and main key defaults.

## Related

- [Control UI](/web/control-ui)
- [Dashboard](/web/dashboard)
