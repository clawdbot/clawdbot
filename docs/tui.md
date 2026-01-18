---
summary: "Terminal UI (TUI): connect to the Gateway from any machine"
read_when:
  - You want a beginner-friendly walkthrough of the TUI
  - You need the complete list of TUI features, commands, and shortcuts
---
# TUI (Terminal UI)

## Quick start
1) Start the Gateway.
```bash
clawdbot gateway
```
2) Open the TUI.
```bash
clawdbot tui
```
3) Type a message and press Enter.

Remote Gateway:
```bash
clawdbot tui --url ws://<host>:<port> --token <gateway-token>
```
Use `--password` if your Gateway uses password auth.

## What you see
- Header: connection URL, current agent, current session.
- Chat log: user messages, assistant replies, system notices, tool cards.
- Status line: connection/run state (connecting, running, streaming, idle, error).
- Footer: connection state + agent + session + model + think/verbose/reasoning + token counts + deliver.
- Input: text editor with autocomplete.

## Mental model: agents + sessions
- Agents are unique slugs (e.g. `main`, `research`). The Gateway exposes the list.
- Sessions belong to the current agent.
- Session keys are stored as `agent:<agentId>:<sessionKey>`.
  - If you type `/session main`, the TUI expands it to `agent:<currentAgent>:main`.
  - If you type `/session agent:other:main`, you switch to that agent session explicitly.
- Session scope:
  - `per-sender` (default): each agent has many sessions.
  - `global`: the TUI always uses the `global` session (the picker may be empty).
- The current agent + session are always visible in the footer.

## Sending + delivery
- Messages are sent to the Gateway; delivery to providers is off by default.
- Turn delivery on:
  - `/deliver on`
  - or the Settings panel
  - or start with `clawdbot tui --deliver`

## Pickers + overlays
- Model picker: list available models and set the session override.
- Agent picker: choose a different agent.
- Session picker: shows only sessions for the current agent.
- Settings: toggle deliver, tool output expansion, and thinking visibility.

## Keyboard shortcuts
- Enter: send message
- Esc: abort active run
- Ctrl+C: clear input (press twice to exit)
- Ctrl+D: exit
- Ctrl+L: model picker
- Ctrl+G: agent picker
- Ctrl+P: session picker
- Ctrl+O: toggle tool output expansion
- Ctrl+T: toggle thinking visibility (reloads history)

## Slash commands
Core:
- `/help`
- `/status`
- `/agent <id>` (or `/agents`)
- `/session <key>` (or `/sessions`)
- `/model <provider/model>` (or `/models`)

Session controls:
- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Session lifecycle:
- `/new` or `/reset` (reset the session)
- `/abort` (abort the active run)
- `/settings`
- `/exit`

## Tool output
- Tool calls show as cards with args + results.
- Ctrl+O toggles between collapsed/expanded views.
- While tools run, partial updates stream into the same card.

## History + streaming
- On connect, the TUI loads the latest history (default 200 messages).
- Streaming responses update in place until finalized.
- The TUI also listens to agent tool events for richer tool cards.

## Connection details
- The TUI registers with the Gateway as `mode: "tui"`.
- Reconnects show a system message; event gaps are surfaced in the log.

## Options
- `--url <url>`: Gateway WebSocket URL (defaults to config or `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway token (if required)
- `--password <password>`: Gateway password (if required)
- `--session <key>`: Session key (default: `main`, or `global` when scope is global)
- `--deliver`: Deliver assistant replies to the provider (default off)
- `--thinking <level>`: Override thinking level for sends
- `--timeout-ms <ms>`: Agent timeout in ms (defaults to `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`: History entries to load (default 200)

## Troubleshooting
- `disconnected`: ensure the Gateway is running and your `--url/--token/--password` are correct.
- No agents in picker: check `clawdbot agents list` and your routing config.
- Empty session picker: you might be in global scope or have no sessions yet.
