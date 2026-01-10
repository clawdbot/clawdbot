---
summary: "Signal support via signal-cli (JSON-RPC + SSE), setup, and number model"
read_when:
  - Setting up Signal support
  - Debugging Signal send/receive
---
# Signal (signal-cli)


Status: external CLI integration. Gateway talks to `signal-cli` over HTTP JSON-RPC + SSE.

## What it is
- Signal provider via `signal-cli` (not embedded libsignal).
- Deterministic routing: replies always go back to Signal.
- DMs share the agent's main session; groups are isolated (`signal:group:<groupId>`).

## The number model (important)
- The gateway connects to a **Signal device** (the `signal-cli` account).
- If you run the bot on **your personal Signal account**, it will ignore your own messages (loop protection).
- For "I text the bot and it replies," use a **separate bot number**.

## Setup (fast path)
1) Install `signal-cli` (Java required).
2) Link a bot account:
   - `signal-cli link -n "Clawdbot"` then scan the QR in Signal.
3) Configure Signal and start the gateway.

Example:
```json5
{
  signal: {
    enabled: true,
    account: "+15551234567",
    cliPath: "signal-cli",
    dmPolicy: "pairing",
    allowFrom: ["+15557654321"]
  }
}
```

Multi-account support: use `signal.accounts` with per-account config and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

## Access control (DMs + groups)
DMs:
- Default: `signal.dmPolicy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `clawdbot pairing list signal`
  - `clawdbot pairing approve signal <CODE>`
- Pairing is the default token exchange for Signal DMs. Details: [Pairing](/start/pairing)
- UUID-only senders (from `sourceUuid`) are stored as `uuid:<id>` in `signal.allowFrom`.

Groups:
- `signal.groupPolicy = open | allowlist | disabled`.
- `signal.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.

## How it works (behavior)
- `signal-cli` runs as a daemon; the gateway reads events via SSE.
- Inbound messages are normalized into the shared provider envelope.
- Replies always route back to the same number or group.

## Media + limits
- Outbound text is chunked to `signal.textChunkLimit` (default 4000).
- Attachments supported (base64 fetched from `signal-cli`).
- Default media cap: `signal.mediaMaxMb` (default 8).
- Use `signal.ignoreAttachments` to skip downloading media.
- Group history context uses `signal.historyLimit` (or `signal.accounts.*.historyLimit`), falling back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).

## Delivery targets (CLI/cron)
- DMs: `signal:+15551234567` (or plain E.164).
- Groups: `signal:group:<groupId>`.
- Usernames: `username:<name>` (if supported by your Signal account).

## Configuration reference (Signal)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `signal.enabled`: enable/disable provider startup.
- `signal.account`: E.164 for the bot account.
- `signal.cliPath`: path to `signal-cli`.
- `signal.httpUrl`: full daemon URL (overrides host/port).
- `signal.httpHost`, `signal.httpPort`: daemon bind (default 127.0.0.1:8080).
- `signal.autoStart`: auto-spawn daemon (default true if `httpUrl` unset).
- `signal.receiveMode`: `on-start | manual`.
- `signal.ignoreAttachments`: skip attachment downloads.
- `signal.ignoreStories`: ignore stories from the daemon.
- `signal.sendReadReceipts`: forward read receipts.
- `signal.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `signal.allowFrom`: DM allowlist (E.164 or `uuid:<id>`). `open` requires `"*"`.
- `signal.groupPolicy`: `open | allowlist | disabled` (default: open).
- `signal.groupAllowFrom`: group sender allowlist.
- `signal.historyLimit`: max group messages to include as context (0 disables).
- `signal.textChunkLimit`: outbound chunk size (chars).
- `signal.mediaMaxMb`: inbound/outbound media cap (MB).

Related global options:
- `agents.list[].groupChat.mentionPatterns` (Signal does not support native mentions).
- `messages.groupChat.mentionPatterns` (global fallback).
- `messages.responsePrefix`.
