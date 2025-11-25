# Command Queue (2025-11-25)

We now serialize all command-based auto-replies (Twilio webhook + poller + WhatsApp Web listener) through a tiny in-process queue to prevent multiple commands from running at once.

## Why
- Some auto-reply commands are expensive (LLM calls) and can collide when multiple inbound messages arrive close together.
- Serializing avoids competing for terminal/stdin, keeps logs readable, and reduces the chance of rate limits from upstream tools.

## How it works
- `src/process/command-queue.ts` holds a single FIFO queue and drains it synchronously; only one task runs at a time.
- `getReplyFromConfig` wraps command execution with `enqueueCommand(...)`, so every config-driven command reply flows through the queue automatically.
- When verbose logging is enabled, queued commands emit a short notice if they waited more than ~2s before starting.
- Typing indicators (`onReplyStart`) still fire immediately on enqueue so user experience is unchanged while we wait our turn.

## Scope and guarantees
- Applies only to config-driven command replies; plain text replies are unaffected.
- Queue is process-wide, so webhook handlers, Twilio polling, and the web inbox listener all respect the same lock.
- No external dependencies or background worker threads; pure TypeScript + promises.

## Troubleshooting
- If commands seem stuck, enable verbose logs and look for “queued for …ms” lines to confirm the queue is draining.
- `enqueueCommand` exposes a lightweight `getQueueSize()` helper if you need to surface queue depth in future diagnostics.
