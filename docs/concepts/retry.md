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

- Attempts: 3
- Max delay cap: 30000 ms
- Jitter: 0.1 (10 percent)
- Provider defaults:
  - Telegram min delay: 400 ms
  - Discord min delay: 500 ms

## Behavior

### Model providers

- OpenClaw lets provider SDKs handle normal short retries.
- For Stainless-based SDKs such as Anthropic and OpenAI, retryable responses
  (`408`, `409`, `429`, and `5xx`) can include `retry-after-ms` or
  `retry-after`. When that wait is longer than 60 seconds, OpenClaw injects
  `x-should-retry: false` so the SDK surfaces the error immediately and model
  failover can rotate to another auth profile or fallback model.
- Override the cap with `OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS=<seconds>`.
  Set it to `0`, `false`, `off`, `none`, or `disabled` to let SDKs honor long
  `Retry-After` sleeps internally.

### Discord

- Retries on rate-limit errors (HTTP 429), request timeouts, HTTP 5xx responses,
  and transient transport failures such as DNS lookup failures, connection
  resets, socket closes, and fetch failures.
- Uses Discord `retry_after` when available, otherwise exponential backoff.

### Telegram

- Retries on transient errors (429, timeout, connect/reset/closed, temporarily unavailable).
- Uses `retry_after` when available, otherwise exponential backoff.
- Markdown parse errors are not retried; they fall back to plain text.

## Configuration

Set retry policy per provider in `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Notes

- Retries apply per request (message send, media upload, reaction, poll, sticker).
- Composite flows do not retry completed steps.

## Related

- [Model failover](/concepts/model-failover)
- [Command queue](/concepts/queue)
