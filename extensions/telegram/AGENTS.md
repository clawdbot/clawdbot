# Telegram Plugin Guide

Read this before any change under `extensions/telegram/`. These are intentional
maintainer decisions and review-binding invariants, not incidental
implementation details. Also read `extensions/AGENTS.md` for the plugin
boundary rules.

Verified against Telegram Bot API 10.2, July 14 2026.

## Reliability Invariants

### Core drain contracts (do not re-implement in Telegram)

Owned by `src/channels/message/ingress-drain.ts` (+ claim-owner, retry-policy).
Proof: `src/channels/message/ingress-drain.test.ts`,
`ingress-claim-owner.test.ts`, `ingress-retry-policy.test.ts`.

- Completed rows tombstone via `complete()`, never `delete`.
- Complete at turn adoption, not settle. Deferred holds the claim; watchdog
  stays armed through deferral; dead-letter reason `handler-timeout`.
- One retry policy: attempt floor **and** age gate (defaults 8 / 24h).
- Claim refresh heartbeat while dispatching/deferred (`claimLeaseMs / 3`).
- Never silently complete on transient failure — release/fail via disposition.
- Pre-adoption supersede tombstones; post-adoption interruption is core-owned
  (reply-run registry / queue interrupt).

### Telegram-owned (transport + channel policy)

- Durable-before-ack on both transports. Polling: ingress worker advances its
  offset only after the parent's committed spool enqueue
  (`writeTelegramSpooledUpdate`). Webhook: respond 200 only after the spool
  write; non-200 on write failure is the redelivery contract.
- `update_id`↔event-id encoding and per-chat/topic lane derivation stay in
  `telegram-ingress-spool.ts` / sequential-key.
- Polling and webhook both: enqueue then pump
  `createTelegramTransportIngressDrain(...).drainOnce()` — no private claim
  loops.
- Stall timeout: `OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS` →
  `adoptionStallTimeoutMs` (default 5 min) via
  `resolveTelegramAdoptionStallTimeoutMs`.
- Non-retryable classifier: `telegram-ingress-non-retryable.ts`
  (missing harness, dispatch-dedupe rollback).
- Supersede predicate: `telegram-ingress-supersede.ts` — only abort text /
  authorized-looking explicit commands (and ambient room_event pending) may
  supersede pre-adoption work. Normal messages never supersede.
- room_event ambient work shares the sequential lane so a later user turn can
  supersede it pre-adoption; adopted user turns are never touched (core drain
  supersede is pre-adoption only).
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
