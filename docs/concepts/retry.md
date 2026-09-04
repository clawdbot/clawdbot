---
summary: "Retry policy for outbound provider calls"
read_when:
  - Updating provider retry behavior or defaults
  - Debugging provider send errors or rate limits
title: "Retry policy"
---

## Goals

- Retry per HTTP request, not per multi-step flow.
- Preserve ordering by retrying only the current step.
- Avoid duplicating non-idempotent operations.

## Defaults

| Setting            | Default   |
| ------------------ | --------- |
| Attempts           | 3         |
| Max delay cap      | 30000 ms  |
| Jitter             | 0.1 (10%) |
| Telegram min delay | 400 ms    |
| Discord min delay  | 500 ms    |

## Behavior

### Model providers

Embedded model runs use the [model failover controller](/concepts/model-failover#model-fallback) for transient HTTP-response retries. It honors provider pacing within one attempt budget and a fixed retry window. ChatGPT SSE errors preserve HTTP status and `Retry-After` together, so a transient HTTP response remains retryable even when its message or provider code is unfamiliar. The ChatGPT transport separately reconnects once for `websocket_connection_limit_reached` before streaming; this is not an SSE HTTP-response retry.

For SDK calls that retain internal retries, Stainless-based SDKs such as Anthropic and OpenAI can receive `retry-after-ms` or `retry-after` on retryable responses (`408`, `409`, `429`, and `5xx`). When that wait is longer than 60 seconds, OpenClaw injects `x-should-retry: false` so the SDK returns control promptly. Override this SDK-only cap with `OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=<seconds>`. Set it to `0`, `false`, `off`, `none`, or `disabled` to let those SDK calls honor long `Retry-After` sleeps internally.

### Discord

- Retries on rate-limit errors (HTTP 429), request timeouts, HTTP 5xx responses, and transient transport failures such as DNS lookup failures, connection resets, socket closes, and fetch failures.
- Uses Discord `retry_after` when available, otherwise exponential backoff.

### Telegram

- Retries on transient errors (429, timeout, connect/reset/closed, temporarily unavailable).
- Uses `retry_after` when available, otherwise exponential backoff.
- HTML/Markdown parse errors are not retried; they fall back to plain text on the first attempt.

## Configuration

Discord and Telegram channel retry timings are built in and are not configurable in `openclaw.json`.

## Notes

- Retries apply per request (message send, media upload, reaction, poll, sticker).
- Composite flows do not retry completed steps.

### Durable outbound delivery

The durable outbound queue has a separate delivery-attempt budget. When a
delivery uses a producer claim, reservation checks the exact owner and its lease
before charging an attempt. An expired or replaced claim does not spend the
remaining budget; recovery can acquire a fresh claim before retrying.

Producer leases last 60 seconds and renew every 20 seconds while the owner is
active. This tolerates brief Gateway stalls; recovery of a vanished producer
waits until its last lease expires.

Lease expiry does not erase evidence that a send already started. Those entries
still require reconciliation before replay, and an unreplaced owner can record a
late result without authorizing another send.

## Related

- [Model failover](/concepts/model-failover)
- [Command queue](/concepts/queue)
