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

- `openclaw chat` and `openclaw terminal` are aliases for `openclaw tui --local`.
- `--local` cannot be combined with `--url`, `--token`, or `--password`.
- Local mode uses the embedded agent runtime directly. Most local tools work, but Gateway-only features are unavailable.
- Bare `openclaw` (no subcommand) picks a target automatically: an unconfigured install runs inference onboarding; invalid config opens classic doctor guidance; a reachable configured Gateway opens this TUI shell in gateway mode; otherwise a configured local model opens it in local mode.

## What you see

- Header: connection URL, current agent, current session.
- Chat log: user messages, assistant replies, system notices, tool cards.
- Status line: connection/run state (connecting, running, streaming, idle, error).
- Footer: agent + session + model + goal state + think/fast/verbose/trace/reasoning + token counts + deliver. When `tui.footer.showRemoteHost` is enabled, remote Gateway connections also show the connection host.
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
- To show the Gateway host for non-local URL-backed connections, opt in with:

  ```bash
  openclaw config set tui.footer.showRemoteHost true
  ```

  Default is `false`. Loopback and embedded local connections never show a host label.

- If the session has a [goal](/tools/goal), the footer shows its compact state:
  `Pursuing goal`, `Goal paused (/goal resume)`, `Goal blocked (/goal resume)`, or `Goal achieved`.
- When started without `--session`, gateway-mode TUI resumes the last selected session for the same gateway, agent, and session scope if that session still exists. Passing `--session`, `/session`, `/new`, or `/reset` remains explicit.

## Sending + delivery

- Messages always go to the Gateway (or embedded runtime in local mode); delivering the assistant's reply back out to a chat provider is a separate, off-by-default step.
- The TUI is an internal source surface like WebChat, not a generic outbound channel. Harnesses that require `tools.message` for visible replies can satisfy the active TUI turn with a targetless `message.send`; explicit provider delivery still uses normal configured channels and never falls back to `lastChannel`.
- Delivery is fixed for the whole TUI session at launch: start with `openclaw tui --deliver` to turn it on. There is no `/deliver` slash command or Settings toggle to flip it mid-session; restart the TUI to change it.

## Pickers + overlays

- Model picker: list available models and set the session override.
- Agent picker: choose a different agent.
- Session picker: shows up to 50 sessions for the current agent updated in the last 7 days. Use `/session <key>` to jump to an older known session.
- Settings (`/settings`): toggle tool output expansion and thinking visibility. This panel does not control delivery.

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
- `/status` (Gateway-forwarded; shows session/model summary)
- `/gateway-status` (alias `/gwstatus`; shows Gateway connection status directly)
- `/agent <id>` (or `/agents`)
- `/session <key>` (or `/sessions`)
- `/model <provider/model>` (or `/models`)

Session controls:

- `/think <off|minimal|low|medium|high>` (higher tiers may add levels like `xhigh`/`max` depending on the model)
- `/fast <status|auto|on|off>`
- `/verbose <on|full|off>`
- `/trace <on|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full|reset>` (`reset`/`inherit`/`clear`/`default` clears the session override)
- `/goal [status] | /goal start <objective> | /goal edit <objective> | /goal pause|resume|complete|block|clear`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`

Session lifecycle:

- `/new` (spawn a fresh, isolated session under a new key; does not affect other TUI clients on the old session)
- `/reset` (reset the current session key in place)
- `/abort` (abort the active run)
- `/settings`
- `/exit` (or `/quit`)

Local mode only:

- `/auth [provider]` opens the provider auth/login flow inside the TUI.

Crestodian:

- `/crestodian [request]` returns from the normal agent TUI to the [Crestodian](#crestodian-setup-and-repair-helper) setup/repair chat, optionally forwarding one request.

Other Gateway slash commands (for example, `/context`) are forwarded to the Gateway and shown as system output. See [Slash commands](/tools/slash-commands).

## Local shell commands

- Prefix a line with `!` to run a local shell command on the TUI host.
- The TUI prompts once per session to allow local execution; declining keeps `!` disabled for the session.
- Commands run in a fresh, non-interactive shell in the TUI working directory (no persistent `cd`/env).
- Local shell commands receive `OPENCLAW_SHELL=tui-local` in their environment.
- A lone `!` is sent as a normal message; leading spaces do not trigger local exec.

## Crestodian setup and repair helper

Crestodian is the ring-zero setup/repair assistant, exposed as `openclaw crestodian` after the configured default model passes a live inference check. If inference is unavailable, an interactive invocation returns to inference onboarding and automation fails with repair guidance. It runs inside the same local TUI shell as `openclaw tui --local`, backed by an AI agent restricted to Crestodian's typed, approval-gated operations:

```bash
openclaw crestodian                       # start interactively
openclaw crestodian -m "status"           # run one request and exit
openclaw crestodian -m "set default model openai/gpt-5.2" --yes   # apply a config write
```

- Persistent config writes need approval: either confirm interactively or pass `--yes`.
- `--json` prints the startup overview as JSON instead of starting the chat.
- From inside Crestodian, an `open-tui` request (for example, asking to talk to a normal agent) exits Crestodian and opens the regular agent TUI; use `/crestodian` there to come back.

Use local mode when the current config already validates and you want the embedded agent to inspect it on the same machine, compare it against the docs, and help repair drift without depending on a running Gateway.

If `openclaw config validate` is already failing, start with `openclaw configure` or `openclaw doctor --fix` first; `openclaw chat` still needs a loadable config to start.

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

- The TUI connects with client id `openclaw-tui` under the coarse `ui` client mode (the same mode Control UI and WebChat use for Gateway policy).
- Reconnects show a system message; event gaps are surfaced in the log.

## Options

- `--local`: Run against the local embedded agent runtime
- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` from config, or `ws://127.0.0.1:<port>` on loopback)
- `--token <token>`: Gateway token (if required)
- `--password <password>`: Gateway password (if required)
- `--tls-fingerprint <sha256>`: Expected TLS certificate fingerprint for a pinned `wss://` Gateway
- `--session <key>`: Session key (default: `main`, or `global` when scope is global)
- `--deliver`: Deliver assistant replies to the provider (default off)
- `--thinking <level>`: Override thinking level for sends
- `--message <text>`: Send an initial message after connecting
- `--timeout-ms <ms>`: Agent timeout in ms (defaults to `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`: History entries to load (default `200`)

<Warning>
When you set `--url`, the TUI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly, plus `--tls-fingerprint` when the target uses a pinned certificate. Missing explicit credentials is an error. In local mode, do not pass `--url`, `--token`, `--password`, or `--tls-fingerprint`.
</Warning>

## Troubleshooting

No output after sending a message:

- Run `/status` in the TUI to confirm the Gateway is connected and idle/busy.
- Check the Gateway logs: `openclaw logs --follow`.
- Confirm the agent can run: `openclaw status` and `openclaw models status`.
- If you expect messages in a chat channel, confirm the TUI was started with `--deliver` (this cannot be turned on later without restarting).

## Connection troubleshooting

- `disconnected`: ensure the Gateway is running and your `--url/--token/--password` are correct.
- No agents in picker: check `openclaw agents list` and your routing config.
- Empty session picker: you might be in global scope or have no sessions yet.

## Related

- [Control UI](/web/control-ui) — web-based control interface
- [Config](/cli/config) — inspect, validate, and edit `openclaw.json`
- [Doctor](/cli/doctor) — guided repair and migration checks
- [CLI Reference](/cli) — full CLI command reference
