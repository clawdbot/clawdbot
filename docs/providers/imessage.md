---
summary: "iMessage support via imsg (JSON-RPC over stdio), setup, and chat_id routing"
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
---
# iMessage (imsg)

Updated: 2026-01-08

Status: external CLI integration. Gateway spawns `imsg rpc` (JSON-RPC over stdio).

## What it is
- iMessage provider backed by `imsg` on macOS.
- Deterministic routing: replies always go back to iMessage.
- DMs share the agent's main session; groups are isolated (`imessage:group:<chat_id>`).

## Requirements
- macOS with Messages signed in.
- Full Disk Access for Clawdbot + `imsg` (Messages DB access).
- Automation permission when sending.
- `imessage.cliPath` can point to a wrapper script (for example, an SSH hop to another Mac that runs `imsg rpc`).

## Setup (fast path)
1) Ensure Messages is signed in on this Mac.
2) Configure iMessage and start the gateway.

### Remote/SSH variant (optional)
If you want iMessage on another Mac, set `imessage.cliPath` to a wrapper that
execs `ssh` and runs `imsg rpc` on the remote host. Clawdbot only needs a
stdio stream; `imsg` still runs on the remote macOS host.

Example wrapper (save somewhere in your PATH and `chmod +x`):
```bash
#!/usr/bin/env bash
exec ssh -T mac-mini imsg "$@"
```

Notes:
- Remote Mac must have Messages signed in and `imsg` installed.
- Full Disk Access + Automation prompts happen on the remote Mac.
- Use SSH keys (no password prompt) so the gateway can launch `imsg rpc` unattended.

Example:
```json5
{
  imessage: {
    enabled: true,
    cliPath: "imsg",
    dmPolicy: "pairing",
    allowFrom: ["+15555550123"]
  }
}
```

Multi-account support: use `imessage.accounts` with per-account config and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

## Access control (DMs + groups)
DMs:
- Default: `imessage.dmPolicy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `clawdbot pairing list --provider imessage`
  - `clawdbot pairing approve --provider imessage <CODE>`
- Pairing is the default token exchange for iMessage DMs. Details: [Pairing](/start/pairing)

Groups:
- `imessage.groupPolicy = open | allowlist | disabled`.
- `imessage.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.
- Mention gating uses `routing.groupChat.mentionPatterns` (iMessage has no native mention metadata).

## How it works (behavior)
- `imsg` streams message events; the gateway normalizes them into the shared provider envelope.
- Replies always route back to the same chat id or handle.

## Media + limits
- Optional attachment ingestion via `imessage.includeAttachments`.
- Media cap via `imessage.mediaMaxMb`.

## Addressing / delivery targets
Prefer `chat_id` for stable routing:
- `chat_id:123` (preferred)
- `chat_guid:...`
- `chat_identifier:...`
- direct handles: `imessage:+1555` / `sms:+1555` / `user@example.com`

List chats:
```
imsg chats --limit 20
```

## Configuration reference (iMessage)
Full configuration: [Configuration](/gateway/configuration)

Provider options:
- `imessage.enabled`: enable/disable provider startup.
- `imessage.cliPath`: path to `imsg`.
- `imessage.dbPath`: Messages DB path.
- `imessage.service`: `imessage | sms | auto`.
- `imessage.region`: SMS region.
- `imessage.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `imessage.allowFrom`: DM allowlist (handles or `chat_id:*`). `open` requires `"*"`.
- `imessage.groupPolicy`: `open | allowlist | disabled` (default: open).
- `imessage.groupAllowFrom`: group sender allowlist.
- `imessage.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
- `imessage.includeAttachments`: ingest attachments into context.
- `imessage.mediaMaxMb`: inbound/outbound media cap (MB).
- `imessage.textChunkLimit`: outbound chunk size (chars).

Related global options:
- `routing.groupChat.mentionPatterns`.
- `messages.responsePrefix`.
