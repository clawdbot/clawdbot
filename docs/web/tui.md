---
summary: "Terminal UI (TUI): connect to the Gateway or run locally in embedded mode"
read_when:
  - You want a beginner-friendly walkthrough of the TUI
  - You need the complete list of TUI features, commands, and shortcuts
title: "TUI"
---

## Quick start

### Gateway mode

1. Start the Gateway.

```bash
openclaw gateway
```

2. Open the TUI.

```bash
openclaw tui
```

3. Type a message and press Enter.

Remote Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Use `--password` if your Gateway uses password auth.

### Local mode

Run the TUI without a Gateway:

```bash
openclaw chat
# or
openclaw tui --local
```

Notes:

- `openclaw chat` and `openclaw terminal` are aliases for `openclaw tui --local`.
- `--local` cannot be combined with `--url`, `--token`, or `--password`.
- Local mode uses the embedded agent runtime directly. Most local tools work, but Gateway-only features are unavailable.
- `openclaw` and `openclaw crestodian` also use this TUI shell, with Crestodian as the local setup and repair chat backend.

## What you see

- Header: connection URL, current agent, current session.
- Chat log: user messages, assistant replies, system notices, tool cards.
- Status line: connection/run state (connecting, running, streaming, idle, error).
- Footer: connection state + agent + session + model + think/fast/verbose/trace/reasoning + token counts + deliver.
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
  - or start with `openclaw tui --deliver`

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
- `/fast <status|on|off>`
- `/verbose <on|full|off>`
- `/trace <on|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Session lifecycle:

- `/new` or `/reset` (reset the session)
- `/abort` (abort the active run)
- `/settings`
- `/exit`

Local mode only:

- `/auth [provider]` opens the provider auth/login flow inside the TUI.

Other Gateway slash commands (for example, `/context`) are forwarded to the Gateway and shown as system output. See [Slash commands](/tools/slash-commands).

## Local shell commands

- Prefix a line with `!` to run a local shell command on the TUI host.
- The TUI prompts once per session to allow local execution; declining keeps `!` disabled for the session.
- Commands run in a fresh, non-interactive shell in the TUI working directory (no persistent `cd`/env).
- Local shell commands receive `OPENCLAW_SHELL=tui-local` in their environment.
- A lone `!` is sent as a normal message; leading spaces do not trigger local exec.

## Repair configs from the local TUI

Use local mode when the current config already validates and you want the
embedded agent to inspect it on the same machine, compare it against the docs,
and help repair drift without depending on a running Gateway.

If `openclaw config validate` is already failing, start with `openclaw configure`
or `openclaw doctor --fix` first. `openclaw chat` does not bypass the invalid-
config guard.

Typical loop:

1. Start local mode:

```bash
openclaw chat
```

2. Ask the agent what you want checked, for example:

```text
Compare my gateway auth config with the docs and suggest the smallest fix.
```

3. Use local shell commands for exact evidence and validation:

```text
!openclaw config file
!openclaw docs gateway auth token secretref
!openclaw config validate
!openclaw doctor
```

4. Apply narrow changes with `openclaw config set` or `openclaw configure`, then rerun `!openclaw config validate`.
5. If Doctor recommends an automatic migration or repair, review it and run `!openclaw doctor --fix`.

Tips:

- Prefer `openclaw config set` or `openclaw configure` over hand-editing `openclaw.json`.
- `openclaw docs "<query>"` searches the live docs index from the same machine.
- `openclaw config validate --json` is useful when you want structured schema and SecretRef/resolvability errors.

## Tool output

- Tool calls show as cards with args + results.
- Ctrl+O toggles between collapsed/expanded views.
- While tools run, partial updates stream into the same card.

## Terminal colors

- The TUI keeps assistant body text in your terminal's default foreground so dark and light terminals both stay readable.
- If your terminal uses a light background and auto-detection is wrong, set `OPENCLAW_THEME=light` before launching `openclaw tui`.
- To force the original dark palette instead, set `OPENCLAW_THEME=dark`.

## History + streaming

- On connect, the TUI loads the latest history (default 200 messages).
- Streaming responses update in place until finalized.
- The TUI also listens to agent tool events for richer tool cards.

## Connection details

- The TUI registers with the Gateway as `mode: "tui"`.
- Reconnects show a system message; event gaps are surfaced in the log.

## Options

- `--local`: Run against the local embedded agent runtime
- `--url <url>`: Gateway WebSocket URL (defaults to config or `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway token (if required)
- `--password <password>`: Gateway password (if required)
- `--session <key>`: Session key (default: `main`, or `global` when scope is global)
- `--deliver`: Deliver assistant replies to the provider (default off)
- `--thinking <level>`: Override thinking level for sends
- `--message <text>`: Send an initial message after connecting
- `--timeout-ms <ms>`: Agent timeout in ms (defaults to `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`: History entries to load (default `200`)

<Warning>
When you set `--url`, the TUI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly. Missing explicit credentials is an error. In local mode, do not pass `--url`, `--token`, or `--password`.
</Warning>

## Troubleshooting

No output after sending a message:

- Run `/status` in the TUI to confirm the Gateway is connected and idle/busy.
- Check the Gateway logs: `openclaw logs --follow`.
- Confirm the agent can run: `openclaw status` and `openclaw models status`.
- If you expect messages in a chat channel, enable delivery (`/deliver on` or `--deliver`).

## Connection troubleshooting

- `disconnected`: ensure the Gateway is running and your `--url/--token/--password` are correct.
- No agents in picker: check `openclaw agents list` and your routing config.
- Empty session picker: you might be in global scope or have no sessions yet.

## Related

- [Control UI](/web/control-ui) — web-based control interface
- [Config](/cli/config) — inspect, validate, and edit `openclaw.json`
- [Doctor](/cli/doctor) — guided repair and migration checks
- [CLI Reference](/cli) — full CLI command reference
