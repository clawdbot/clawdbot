---
summary: "Native and Control UI WebChat usage over the Gateway WebSocket"
read_when:
  - Debugging or configuring WebChat access
  - Understanding human mention delivery and retry behavior
title: "WebChat"
---

Status: the macOS/iOS SwiftUI chat UI talks directly to the Gateway WebSocket. No embedded browser, no local static server.

## What it is

- A native chat UI for the gateway.
- Uses the same sessions and routing rules as other channels.
- Deterministic routing: replies always go back to WebChat.
- History is always fetched from the gateway (no local file watching). If the gateway is unreachable, WebChat is read-only.

## Quick start

1. Start the gateway.
2. Open the WebChat UI (macOS/iOS app) or the Control UI chat tab.
3. Ensure a valid gateway auth path is configured (shared-secret by default, even on loopback).

## How it works

- The UI connects to the Gateway WebSocket and uses the `chat.history`, `chat.send`, `chat.inject`, and `chat.message.get` RPC methods.
- Control UI opens a chat with a small recent-history page through `chat.startup`; short chat links resolve their session in that same request. Short-reference startup also subscribes the connection to authorized session events before reading history, so updates arriving before the chat pane mounts are not missed. Scroll upward to load older messages. A restored Home pane waits for the selected chat to finish loading, while explicitly opening Home loads it immediately.
- `chat.history` is bounded for stability: Gateway may truncate long text fields, omit heavy metadata, and replace oversized entries with `[chat.history omitted: message too large]`. History pages skip hidden and tool-only transcript entries while filling the requested visible-message window from the existing indexed transcript. API clients can send a per-request `maxChars` to override the default limit for one call.
- Paginated `chat.history` and `chat.startup` requests also accept a `maxBytes` page target, capped by the Gateway's response limit. One readable message can exceed the target so a small page does not hide its content. Complete imported snapshots retain their existing budget because they do not support back-scroll pagination.
- When a visible assistant message was truncated in `chat.history`, the Control UI automatically fetches the full display-normalized entry through `chat.message.get`, without increasing the default history payload. The preview remains visible while it loads; recovered content replaces it inline. `chat.message.get` uses the same transcript branch and display rules as `chat.history`, but targets one entry by `messageId` and returns an honest unavailable reason when the full content can no longer be returned.
- `chat.history` follows the active transcript branch for append-only session files, so abandoned rewrite branches and superseded prompt copies are not rendered in WebChat.
- Compaction entries render as a "Compacted history" divider explaining that the compacted transcript is preserved as a checkpoint, with an action to open session checkpoints (branch or restore, when permissions allow).
- Control UI remembers the backing Gateway `sessionId` returned by `chat.history` and includes it on follow-up `chat.send` calls, so reconnects and page refreshes continue the same stored conversation unless the user starts or resets a session.
- Foreground sends also include the displayed branch's leaf from the rendered history as `expectedLeafEntryId`; if another client switched branches first, Control UI parks the message for review and refreshes the transcript instead of posting it to the new branch. Reconnect and restored-outbox replays intentionally omit this precondition after reconciling current history.
- When you change a chat setting and immediately send, Control UI shows **Applying chat settings** until that change and its session refresh finish. Later background session refreshes do not extend this wait. Opening a pane without changing a setting does not create a settings wait.
- `chat.send` takes an idempotency key (Control UI uses the run id); the Gateway dedupes repeated requests that reuse the same key, so retried or duplicate in-flight submits for the same session, message, attachments, and mention selections do not create a second run. Reusing that key with different mention selections is rejected.
- Queued messages keep their original send identity even when execution starts under a different run id. Clients reconcile the local pending message with its saved transcript entry by that send identity, so completion and history reload show one copy.
- Replying to a specific message (right-click → Reply) sends the target's transcript id as `replyToId` on `chat.send`. For sources with visible text, the Gateway resolves that message from session history and hydrates the same channel-agnostic reply context metadata Discord replies use: agents see `has_reply_context` plus the untrusted "Reply target of current user message" block with sender label and body. (Webchat prompts keep volatile conversation ids such as `reply_to_id` suppressed, per the existing byte-stable prompt policy for direct webchat sessions.) Reply targets without a persisted transcript id (for example pending sends) fall back to an inline quote in the message body.
- Attachment-only messages keep their Reply action. The preview uses filenames or image labels, and `replyToId` still points to the original entry. Replying does not attach the source files to the new message.
- Workspace startup files and pending `BOOTSTRAP.md` instructions are supplied through the agent system prompt's `# Project Context` section, not copied into the WebChat user message. If bootstrap content is truncated, the system prompt gets a short "Bootstrap Context Notice" instead; detailed counts and config knobs stay on diagnostic surfaces.
- Display normalization on `chat.history` strips: runtime-only OpenClaw context, inbound envelope wrappers, inline delivery directive tags such as `[[reply_to_current]]`, `[[reply_to:<id>]]`, and `[[audio_as_voice]]`, plain-text tool-call XML payloads (`<tool_call>`, `<function_call>`, `<tool_calls>`, `<function_calls>`, including truncated blocks), and leaked ASCII/full-width model control tokens. Removing model control tokens preserves punctuation and Markdown formatting, keeps adjacent words separated, and leaves code examples intact. Assistant entries whose whole visible text is only the silent token `NO_REPLY` (case-insensitive) are omitted.
- When a reply attachment cannot be read or prepared, WebChat preserves any deliverable attachments and shows one short failure warning without exposing local filesystem paths.
- Attachment directives owned by the current WebChat reply stay hidden in live transcript events while files are prepared. User prompts, fenced examples, and references outside that reply's attachment pipeline remain unchanged.
- Reasoning-flagged reply payloads (`isReasoning: true`) are excluded from WebChat assistant content, transcript replay text, and audio content blocks, so thinking-only payloads do not surface as visible assistant messages or playable audio.
- `chat.inject` appends an assistant note directly to the transcript and broadcasts it to the UI (no agent run).
- Aborted runs can keep partial assistant output visible in the UI. Gateway persists that partial text into transcript history when buffered output exists, and marks the entry with abort metadata.

### Transcript and delivery model

Admission and transcript persistence are separate. A `chat.send`, `sessions.send`,
or initial `sessions.create` acknowledgment can arrive while approved input
waits in durable pending-input custody, including during workspace preparation.
An optional `messageSeq` comes only from a committed transcript receipt; clients
must not predict it from history length or treat `status: "started"` as persistence.
The Control UI replaces its provisional source with accepted custody, then with
the canonical row. Its renderer keeps a loaded local preview in the same image
element during this handoff while canonical media metadata and image bytes load.
Authoritative text, media replacements, and removals still win; unavailable or
access-denied media shows a visible reason.
Once custody, a consumption record, or a committed user-message receipt retires
a local source, replayed terminal events cannot bring it back, even when its row
is absent from a later history page. Submission identity stays separate from the
execution run, so two intentionally identical sends remain two inputs.

WebChat has two separate data paths:

- The SQLite transcript rows are the durable model/runtime transcript. For normal agent runs, the embedded OpenClaw runtime persists model-visible `user`, `assistant`, and `toolResult` messages through the session accessor. WebChat does not write arbitrary delivery, status, or helper text into that transcript.
- Gateway `ReplyPayload` events are the live delivery projection: normalized for WebChat/channel display, block streaming, directive tags, media embedding, TTS/audio flags, and UI fallback behavior. They are not themselves the canonical session log.
- Harnesses that require visible replies through `tools.message` still use WebChat as a current-run internal source reply sink. A targetless `message.send` from that active WebChat run is projected into the same chat and mirrored to the session transcript; WebChat does not become a reusable outbound channel and never inherits `lastChannel`.
- WebChat injects assistant transcript entries only when the Gateway owns a displayed message outside a normal embedded agent turn: `chat.inject`, non-agent command replies, aborted partial output, and WebChat-managed media transcript supplements.
- If live assistant text appears during a run but disappears after history reload, check in order: whether the SQLite transcript contains the assistant text, whether `chat.history` display projection stripped it, then whether the Control UI optimistic-tail merge replaced local delivery state with the persisted snapshot.

Normal agent-run final answers should be durable because the embedded runtime writes the assistant `message_end`. Any fallback that mirrors a delivered final payload into the transcript must first avoid duplicating an assistant turn that the embedded runtime already wrote.

## Human mention delivery

The Control UI binds each [selected person](/concepts/multi-user#mentioning-people) to the submitted message text. `chat.send`, the initial message on `sessions.create`, and `sessions.send` accept an optional `mentions` array of `{ profileId, start, end }` annotations. There are at most ten annotations; `start` is inclusive and `end` is exclusive, measured in UTF-16 code units. The Gateway validates their text ranges and recipients before accepting the input. Plain `@name` text and agent output do not create human mentions; copying or quoting text does not copy its recipient selections.

The mention becomes eligible for an Inbox entry and optional browser push only after the original human message is newly committed to the transcript. An early `status: "started"` acknowledgment, a staged initial message, or durable pending-input custody is not that commit. A queued or remotely placed first message therefore does not notify while it is still waiting to be recorded. A later agent failure does not undo a mention whose human message was already committed.

Transport retries preserve the exact submitted text, mention annotations, and original send identity, even when execution gets a different run id. Replaying that committed input does not create another mention or restore a dismissed entry. An intentional new send has a new identity and may notify again, even when its text is identical. Transcript loading, hidden continuations, and attachment enrichment are not new human sends.

The supporting RPCs require `operator.read` and use the authenticated profile, never a caller-selected Inbox owner:

| Method or event     | Contract                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users.mentionable` | Search with `{ sessionKey, agentId?, query? }`, or use `{ agentId, visibility?, query? }` before creating a session. Returns bounded `{ users, truncated }` results with profile id, display name, optional avatar URL, and online status. |
| `mentions.list`     | Call with `{}` to fetch your current `{ gatewayInstanceId, revision, items }` snapshot.                                                                                                                                                    |
| `mentions.dismiss`  | Pass `{ ids }` containing up to 100 distinct visible entry ids. Returns the same snapshot shape after dismissal.                                                                                                                           |
| `mentions.changed`  | Targeted `{ gatewayInstanceId, revision }` invalidation; fetch `mentions.list` again. Revisions describe that connection's authorized view, not global Gateway activity.                                                                   |

Delivery is best-effort. The Inbox and replay bookkeeping are bounded and process-local; a restart clears them, and capacity limits can skip alerts. Notification failures do not retry or undo the posted chat message. Browser push does not provide exactly-once delivery. See [temporary Inbox retention](/concepts/multi-user#temporary-mentions-inbox) and [notification preferences](/web/notifications#receive-human-mention-alerts).

## Control UI agents tools panel

- The Control UI `/agents` Tools panel has an "Available Right Now" view backed by `tools.effective(sessionKey=...)`: a server-derived, read-only projection of the current session's tool inventory, including core, plugin, channel-owned, and already-discovered MCP server tools.
- A separate config-editing view (backed by `tools.catalog`) covers profiles, per-agent overrides, and catalog semantics.
- Runtime availability is session-scoped. Switching sessions on the same agent can change the "Available Right Now" list. If configured MCP servers have not been connected or changed since the last discovery, the panel shows a notice instead of silently starting MCP transports from the read path.
- The config editor does not imply runtime availability; effective access still follows policy precedence (`allow`/`deny`, per-agent and provider/channel overrides).

## Remote use

- Remote mode tunnels the gateway WebSocket over SSH/Tailscale.
- You do not need to run a separate WebChat server.

## Configuration reference (WebChat)

Full configuration: [Configuration](/gateway/configuration)

WebChat has no persisted config section. Gateway uses the built-in `chat.history` display limit; API clients can send per-request `maxChars` to override it for a single call. Legacy `channels.webchat` and `gateway.webchat` config is retired; run `openclaw doctor --fix` to remove it.

Related global options:

- `gateway.port`, `gateway.bind`: WebSocket host/port.
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`:
  shared-secret WebSocket auth.
- `gateway.auth.allowTailscale`: browser Control UI chat tab can use Tailscale
  Serve identity headers when enabled.
- `gateway.auth.mode: "trusted-proxy"`: reverse-proxy auth for browser clients behind an identity-aware **non-loopback** proxy source (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)).
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: remote gateway target.
- `session.*`: session routing and storage.

## Related

- [Control UI](/web/control-ui)
- [Dashboard](/web/dashboard)
