---
summary: "Terminal UI (TUI) for Clawdbot via the Gateway"
read_when:
  - You want a terminal UI that connects to the Gateway from any machine
  - You are debugging the TUI client or Gateway chat stream
---
# TUI (Gateway chat client)

Updated: 2026-01-03

## What it is
- A terminal UI that connects to the Gateway WebSocket and speaks the same chat APIs as WebChat.
- Uses Gateway agent events for tool cards while streaming responses.
- Works locally (loopback) or remotely (Tailscale/SSH tunnel) without running a separate agent process.

## Run
```bash
clawdbot tui
```

### Remote
```bash
clawdbot tui --url ws://127.0.0.1:18789 --token <gateway-token>
```
Use SSH tunneling or Tailscale to reach the Gateway WS.

## Options
- `--url <url>`: Gateway WebSocket URL (defaults to config `gateway.remote.url` or `ws://127.0.0.1:18789`).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (if required).
- `--session <key>`: Session key (default: `main`, or `global` when scope is global).
- `--deliver`: Deliver assistant replies to the provider (default off).
- `--thinking <level>`: Override thinking level for sends.
- `--timeout-ms <ms>`: Agent timeout in ms (default 30000).
- `--history-limit <n>`: History entries to load (default 200).

## Controls
- Enter: send message
- Esc: abort active run
- Ctrl+C: clear input (press twice to exit)
- Ctrl+D: exit
- Ctrl+L: model picker
- Ctrl+P: session picker
- Ctrl+O: toggle tool output expansion
- Ctrl+T: toggle thinking visibility

## Slash commands
- `/help`
- `/status`
- `/session <key>` (or `/sessions`)
- `/model <provider/model>` (or `/model list`, `/models`)
- `/think <off|minimal|low|medium|high>`
- `/verbose <on|off>`
- `/elevated <on|off>`
- `/elev <on|off>`
- `/activation <mention|always>`
- `/deliver <on|off>`
- `/new` or `/reset`
- `/compact [instructions]`
- `/abort`
- `/settings`
- `/exit`

## Notes
- The TUI shows Gateway chat deltas (`event: chat`) and agent tool events.
- It registers as a Gateway client with `mode: "tui"` for presence and debugging.

## Files
- CLI: `src/cli/tui-cli.ts`
- Runner: `src/tui/tui.ts`
- Gateway client: `src/tui/gateway-chat.ts`
