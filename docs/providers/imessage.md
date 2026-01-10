---
summary: "iMessage support via imsg (JSON-RPC over stdio), setup, and chat_id routing"
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
---
# iMessage (imsg)


Status: external CLI integration. Gateway spawns `imsg rpc` (JSON-RPC over stdio).

## What it is
- iMessage provider backed by `imsg` on macOS.
- Deterministic routing: replies always go back to iMessage.
- DMs share the agent's main session; groups are isolated (`imessage:group:<chat_id>`).
- If a multi-participant thread arrives with `is_group=false`, you can still isolate it by `chat_id` using `imessage.groups` (see “Group-ish threads” below).

## Requirements
- macOS with Messages signed in.
- Full Disk Access for Clawdbot + `imsg` (Messages DB access).
- Automation permission when sending.
- `imessage.cliPath` can point to any command that proxies stdin/stdout (for example, a wrapper script that SSHes to another Mac and runs `imsg rpc`).

## Setup (fast path)
1) Ensure Messages is signed in on this Mac.
2) Configure iMessage and start the gateway.

### Dedicated bot macOS user (for isolated identity)
If you want the bot to send from a **separate iMessage identity** (and keep your personal Messages clean), use a dedicated Apple ID + a dedicated macOS user.

1) Create a dedicated Apple ID (example: `my-cool-bot@icloud.com`).
   - Apple may require a phone number for verification / 2FA.
2) Create a macOS user (example: `clawdshome`) and sign into it.
3) Open Messages in that macOS user and sign into iMessage using the bot Apple ID.
4) Enable Remote Login (System Settings → General → Sharing → Remote Login).
5) Install `imsg`:
   - `brew install steipete/tap/imsg`
6) Set up SSH so `ssh <bot-macos-user>@localhost true` works without a password.
7) Point `imessage.accounts.bot.cliPath` at an SSH wrapper that runs `imsg` as the bot user.

First-run note: sending/receiving may require GUI approvals (Automation + Full Disk Access) in the *bot macOS user*. If `imsg rpc` looks stuck or exits, log into that user (Screen Sharing helps), run a one-time `imsg chats --limit 1` / `imsg send ...`, approve prompts, then retry.

Example wrapper (`chmod +x`). Replace `<bot-macos-user>` with your actual macOS username:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Example config:
```json5
{
  imessage: {
    enabled: true,
    accounts: {
      bot: {
        name: "Bot",
        enabled: true,
        cliPath: "/path/to/imsg-bot",
        dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db"
      }
    }
  }
}
```

For single-account setups, use flat options (`imessage.cliPath`, `imessage.dbPath`) instead of the `accounts` map.

### Remote/SSH variant (optional)
If you want iMessage on another Mac, set `imessage.cliPath` to a wrapper that runs `imsg` on the remote macOS host over SSH. Clawdbot only needs stdio.

Example wrapper:
```bash
#!/usr/bin/env bash
exec ssh -T mac-mini imsg "$@"
```

Multi-account support: use `imessage.accounts` with per-account config and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern. Don’t commit `~/.clawdbot/clawdbot.json` (it often contains tokens).

## Access control (DMs + groups)
DMs:
- Default: `imessage.dmPolicy = "pairing"`.
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via:
  - `clawdbot pairing list imessage`
  - `clawdbot pairing approve imessage <CODE>`
- Pairing is the default token exchange for iMessage DMs. Details: [Pairing](/start/pairing)

Groups:
- `imessage.groupPolicy = open | allowlist | disabled`.
- `imessage.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.
- Mention gating uses `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) because iMessage has no native mention metadata.
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.

## How it works (behavior)
- `imsg` streams message events; the gateway normalizes them into the shared provider envelope.
- Replies always route back to the same chat id or handle.

## Group-ish threads (`is_group=false`)
Some iMessage threads can have multiple participants but still arrive with `is_group=false` depending on how Messages stores the chat identifier.

If you explicitly configure a `chat_id` under `imessage.groups`, Clawdbot treats that thread as a “group” for:
- session isolation (separate `imessage:group:<chat_id>` session key)
- group allowlisting / mention gating behavior

Example:
```json5
{
  imessage: {
    groupPolicy: "allowlist",
    groupAllowFrom: ["+15555550123"],
    groups: {
      "42": { "requireMention": false }
    }
  }
}
```
This is useful when you want an isolated personality/model for a specific thread (see [Multi-agent routing](/concepts/multi-agent)). For filesystem isolation, see [Sandboxing](/gateway/sandboxing).

## Media + limits
- Optional attachment ingestion via `imessage.includeAttachments`.
- Media cap via `imessage.mediaMaxMb`.

## Limits
- Outbound text is chunked to `imessage.textChunkLimit` (default 4000).
- Media uploads are capped by `imessage.mediaMaxMb` (default 16).

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
- `imessage.historyLimit` / `imessage.accounts.*.historyLimit`: max group messages to include as context (0 disables).
- `imessage.groups`: per-group defaults + allowlist (use `"*"` for global defaults).
- `imessage.includeAttachments`: ingest attachments into context.
- `imessage.mediaMaxMb`: inbound/outbound media cap (MB).
- `imessage.textChunkLimit`: outbound chunk size (chars).

Related global options:
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
