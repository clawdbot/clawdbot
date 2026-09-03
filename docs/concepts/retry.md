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

- OpenClaw lets provider SDKs handle normal short retries.
- For Stainless-based SDKs such as Anthropic and OpenAI, retryable responses (`408`, `409`, `429`, and `5xx`) can include `retry-after-ms` or `retry-after`. When that wait is longer than 60 seconds, OpenClaw injects `x-should-retry: false` so the SDK surfaces the error immediately and model failover can rotate to another auth profile or fallback model.
- Override the cap with `OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=<seconds>`. Set it to `0`, `false`, `off`, `none`, or `disabled` to let SDKs honor long `Retry-After` sleeps internally.

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
