# Telegram Plugin Guide

Read this before any change under `extensions/telegram/`. These are intentional
maintainer decisions and review-binding invariants, not incidental
implementation details. Also read `extensions/AGENTS.md` for the plugin
boundary rules.

Verified against Telegram Bot API 10.1, July 1 2026.

## Reliability Invariants

- Durable-before-ack on both transports. Polling: the ingress worker advances
  its offset only after the parent's committed spool enqueue. Webhook: respond
  200 only after the spool write; a spool-write failure returning non-200 is
  the redelivery contract, not an error to fix.
- Completed spool rows tombstone via `complete()`, never `delete`. Telegram can
  refetch an update after dispatch, and callback side effects would rerun on a
  plain delete.
- One retry policy. `spooled-update-retry-policy.ts` is the sole owner of spool
  backoff and dead-letter decisions; the polling and webhook drains both
  consume it. The dead-letter age gate is a product decision: over-limit
  updates keep retrying at the capped delay and only tombstone once older than
  the minimum age. Do not dead-letter on raw attempt counts, and do not
  "unstick" a lane by removing the gate.
- Never swallow inbound processing errors. A transient store error on a
  spooled replay must record a `failed-retryable` processing result; a
  swallowed throw acks the update as completed and deletes the message.
- Spool completes at turn adoption, not settle. Once the recovery-relevant
  session/run state is durably persisted (`restartRecoveryDeliveryContext` +
  run id), the spooled row tombstones via `complete()` and the per-chat lane
  frees. Run health after that is owned by run lifecycle / main-session
  restart recovery — not by the ingress spool. Pre-adoption timeout
  (`ISOLATED_INGRESS_ADOPTION_STALL_MS`, default 5 minutes, overridable via
  `OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS`) is the only ingress
  guillotine; it dead-letters with `handler-timeout` when claim→adoption
  stalls. Healthy long turns must not be killed by the spool watchdog.
- Reply fence abort authority is pre-adoption only. At turn adoption the fence
  releases its abort controller; core owns all further interruption (queue
  interrupt mode, reply-run registry aborts). Normal messages never supersede
  in any chat type; only authorized abort text and authorized explicit
  commands do.
- No per-message full-store writes. Hot-path SQLite writes are per-entry.
  Rewriting a cache on every send or read stalls the event loop, and that
  stall masquerades as a polling stall (the sent-message-cache regression).
- Transport error classification. The getUpdates worker retries Bot API 5xx
  and 429 locally, honoring `parameters.retry_after`; 401/404 stay fatal; 409
  must propagate to the parent session, which owns webhook-conflict recovery.
  Bot API errors carry `error_code`, not `.code`; parse non-2xx bodies
  defensively (a 502 HTML page is not JSON).
- Send funnel parity. The durable funnel (`send.ts`) and the streaming funnel
  (`bot/delivery.*`) must degrade identically: rich-entity 400 falls back to
  plain text, caption parse 400 falls back to a plain caption, quote-not-found
  400 falls back to a legacy reply. New recoveries go into the shared
  predicates (`send-error-predicates.ts`, `reply-parameters.ts`), never into
  one funnel only.
- Outbound flood waits honor `retry_after` up to
  `TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS`; do not re-clamp Telegram sends to the
  generic channel retry ceiling.
- Webhook security ordering. The secret header is validated first
  (constant-time compare, single-header enforcement, connection close on 401);
  the request rate limit budgets only failed-auth attempts so Telegram's own
  delivery is never throttled.
- Every owned undici transport gets closed on all exit paths: polling session,
  webhook shutdown and startup failure, probe-cache eviction.

## Streaming

- Do not reintroduce `sendMessageDraft` for answer streaming. Telegram drafts
  are ephemeral 30-second previews in private chats; final delivery still
  requires a separate `sendMessage`. OpenClaw uses `sendMessage` plus
  `editMessageText`, then finalizes in place so the user sees one persistent
  answer.
- Streaming owns one visible preview message. Edit it forward. Do not send an
  extra final bubble unless the final edit genuinely failed.
- Keep the first-preview debounce. If a provider sends token-sized deltas,
  coalesce them into cumulative preview text instead of removing the debounce.
- Respect Telegram limits in the Telegram layer. Text over 4096 chars chains
  into continuation messages. Polls keep the current Bot API 12-option cap.

## Telegram API Ownership

- Prefer grammY primitives and Telegram-native helpers when they model the
  behavior directly. Avoid custom Bot API wrappers for behavior grammY already
  owns.
- Throttling is bot-token scoped. All Telegram API clients for the same token
  share one grammY `apiThrottler()` instance.
- Do not silently retry failed topic sends without topic metadata. A
  wrong-surface success is worse than a loud Telegram error.
- DM topics and forum topics are distinct. `direct_messages_topic_id` and
  `message_thread_id` are not interchangeable.

## Context And Authorization

- Reply context comes from OpenClaw-observed messages. Bot API updates expose
  `reply_to_message`, but there is no arbitrary `getMessage(chat, id)`
  hydration path later.
- Current local chat context must outrank stale reply ancestry in the prompt.
  Old replied-to messages should not look like the active conversation.
- The group history window is always on for groups and bounded by
  `historyLimit`. Do not reintroduce prompt-history gating modes; that
  regression blinded ambient rooms.
- The group history window is rolling. Use self-entry watermark selection for
  "since your last reply" views; do not reintroduce destructive clears because
  room events are not persisted to the session and cleared context is
  unrecoverable.
- Pairing is DM-only. Group and topic authorization need explicit config
  allowlists.
- Telegram allowlists use numeric sender IDs. Usernames are optional, mutable,
  and not a reliable arbitrary-user lookup key in the Bot API.
- Group and channel visible replies are policy-controlled. Normal room replies
  stay private unless `messages.groupChat.visibleReplies: "automatic"` is set
  or the agent explicitly calls `message.send`.

## Interactive Surfaces

- Native callbacks stay structured. Approval, native command, plugin, select,
  and multiselect callbacks must not fall through as raw callback text.
- Preserve callback values exactly, including delimiters such as `env|prod`.
- Native slash commands should remain fast-pathable before full workspace and
  agent-turn setup.

## Review Standard

- Telegram behavior PRs need real Telegram proof when they touch transport,
  streaming, topics, callbacks, authorization, or reply context. Prefer the
  bot-to-bot QA lane or an equivalent live Telegram probe over synthetic-only
  validation.
- Reliability PRs (spool, drain, retry, ack, offset paths) need crash-window
  or restart-replay test proof, not just happy-path tests.
