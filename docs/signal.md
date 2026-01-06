---
summary: "Signal support via signal-cli (JSON-RPC + SSE), setup, and number model"
read_when:
  - Setting up Signal support
  - Debugging Signal send/receive
---
# Signal (signal-cli)

Status: external CLI integration only. No libsignal embedding.

## Why
- Signal OSS stack is GPL/AGPL; not compatible with Clawdbot MIT if bundled.
- signal-cli is unofficial; must stay up to date (Signal server churn).

## The “number model” (important)
- Clawdbot is a **device** connected via `signal-cli`.
- If you run `signal-cli` on **your personal Signal account**, Clawdbot will **not** respond to messages sent from that same account (loop protection: ignore sender==account).
  - Result: you **cannot** “text yourself” to chat with the AI.
- For “I text her, she texts me back” you want a **separate Signal account/number for the bot**:
  - Bot number runs `signal-cli` (linked device)
  - Your personal number is in `signal.allowFrom`
  - You DM the bot number; Clawdbot replies back to you

You can still run Clawdbot on your own Signal account if your goal is “respond to other people as me”, but not for self-chat.

## Model
- Run `signal-cli` as separate process (user-installed).
- Prefer `daemon --http=127.0.0.1:PORT` for JSON-RPC + SSE.
- Alternative: `jsonRpc` mode over stdin/stdout.

## Quickstart (bot number)
1) Install `signal-cli` (keep Java installed).
   - If you use the CLI wizard, it can auto-install to `~/.clawdbot/tools/signal-cli/...`.
   - If you want a pinned version (example: `v0.13.22`), install manually:
     - Download the release asset for your platform from GitHub (tag `v0.13.22`).
     - Extract it somewhere stable (example: `~/.clawdbot/tools/signal-cli/0.13.22/`).
     - Set `signal.cliPath` to the extracted `signal-cli` binary path.
2) Link the bot account as a device:
   - Run: `signal-cli link -n "Clawdbot"`
   - Scan QR in Signal: Settings → Linked Devices → Link New Device
   - Verify: `signal-cli listAccounts` includes the bot E.164
3) Configure `~/.clawdbot/clawdbot.json`:
```json5
{
  signal: {
    enabled: true,
    account: "+15551234567", // bot number (recommended)
    cliPath: "signal-cli",
    autoStart: true,
    httpHost: "127.0.0.1",
    httpPort: 8080,

    // Who is allowed to talk to the bot (DMs)
    dmPolicy: "pairing", // pairing | allowlist | open | disabled
    allowFrom: ["+15557654321"], // your personal number ("open" requires ["*"])

    // Group policy + allowlist
    groupPolicy: "open",
    groupAllowFrom: ["+15557654321"]
  }
}
```
4) Run gateway; sanity probe:
   - `clawdbot gateway call providers.status --params '{"probe":true}'`
   - Expect `signal.probe.ok=true` and `signal.probe.version`.
5) DM the bot number from your phone; Clawdbot replies.

## DM pairing
- Default: `signal.dmPolicy="pairing"` — unknown DM senders get a pairing code.
- Approve via: `clawdbot pairing approve --provider signal <code>`.

## “Do I need a separate number?”
- If you want “I text her and she texts me back”, yes: **use a separate Signal account/number for the bot**.
- Your personal account can run `signal-cli`, but you can’t self-chat (Signal loop protection; Clawdbot ignores sender==account).

If you have a second phone:
- Create/activate the bot number on that phone.
- Run `signal-cli link -n "Clawdbot"` on your Mac, scan the QR on the bot phone.
- Put your personal number in `signal.allowFrom`, then DM the bot number from your personal phone.

## Endpoints (daemon --http)
- `POST /api/v1/rpc` JSON-RPC request (single or batch).
- `GET /api/v1/events` SSE stream of `receive` notifications.
- `GET /api/v1/check` health probe (200 = up).

## Multi-account
- Start daemon without `-a`.
- Include `params.account` (E164) on JSON-RPC calls.
- SSE `?account=+E164` filters events; no param = all accounts.

## Troubleshooting
- Gateway log coloring: `signal-cli: ...` lines are classified by severity; red means “treat this as an error”.
- `Failed to initialize HTTP Server` typically means the daemon can’t bind the HTTP port (already in use). Stop the other daemon or change `signal.httpPort`.

## Minimal RPC surface
- `send` (recipient/groupId/username, message, attachments).
- `listGroups` (map group IDs).
- `subscribeReceive` / `unsubscribeReceive` (if manual receive).
- `startLink` / `finishLink` (optional device link flow).

## Addressing (send targets)
- Direct: `signal:+15551234567` (or plain `+15551234567`)
- Groups: `signal:group:<groupId>`
- Usernames: `username:<name>` / `u:<name>`

## Process plan (Clawdbot adapter)
1) Detect `signal-cli` binary; refuse if missing.
2) Launch daemon (HTTP preferred), store PID.
3) Poll `/api/v1/check` until ready.
4) Open SSE stream; parse `event: receive`.
5) Translate receive payload into Clawdbot surface model.
6) On SSE disconnect, backoff + reconnect.

## Storage
- signal-cli data lives in `$XDG_DATA_HOME/signal-cli/data` or
  `$HOME/.local/share/signal-cli/data`.

## References (local)
- `~/Projects/oss/signal-cli/README.md`
- `~/Projects/oss/signal-cli/man/signal-cli-jsonrpc.5.adoc`
- `~/Projects/oss/signal-cli/src/main/java/org/asamk/signal/http/HttpServerHandler.java`
- `~/Projects/oss/signal-cli/src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcDispatcherHandler.java`
