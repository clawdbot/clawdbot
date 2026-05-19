---
name: channel-message-flows
description: "Use when previewing local channel message flow fixtures."
---

# Channel Message Flows

Use this from the OpenClaw repo root to send canned channel preview flows while iterating on message UX. These are real sends/edits/deletes against the configured channel target.

## Telegram

Native Telegram `sendMessageDraft` tool progress, then a final answer:

```bash
node --import tsx scripts/dev/channel-message-flows.ts \
  --channel telegram \
  --target <telegram-chat-id> \
  --flow working-final \
  --duration-ms 20000
```

Thinking preview, then a final answer:

```bash
node --import tsx scripts/dev/channel-message-flows.ts \
  --channel telegram \
  --target <telegram-chat-id> \
  --flow thinking-final
```

## Options

- `--account <accountId>`: Telegram account id when not using the default.
- `--thread-id <id>`: Telegram forum topic/message thread id.
- `--delay-ms <ms>`: Override preview update cadence.
- `--duration-ms <ms>`: Simulated working duration for `working-final`.
- `--final-text <text>`: Override the durable final message.

## Notes

- `--target` is the numeric Telegram chat id.
- `working-final` exercises native Telegram `sendMessageDraft` with static `Working` status and sample tool progress.
- `thinking-final` exercises formatted `Thinking` reasoning preview clearing before the final answer.
- Only `--channel telegram` is implemented for now.
