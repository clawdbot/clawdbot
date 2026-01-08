---
summary: "CLI reference for clawdbot commands, subcommands, and options"
read_when:
  - Adding or modifying CLI commands or options
  - Documenting new command surfaces
---

# CLI reference

This page mirrors `src/cli/*` and is the source of truth for CLI behavior.
If you change the CLI code, update this doc.

## Global flags

- `--dev`: isolate state under `~/.clawdbot-dev` and shift default ports.
- `--profile <name>`: isolate state under `~/.clawdbot-<name>`.
- `-V`, `--version`, `-v`: print version and exit.

## Command tree

```
clawdbot [--dev] [--profile <name>] <command>
  setup
  onboard
  configure (alias: config)
  update
  doctor
  login
  logout
  providers
    list
    status
    add
    remove
  send
  poll
  agent
  agents
    list
    add
    delete
  status
  health
  sessions
  gateway
    call
    health
    status
    wake
    send
    agent
    stop
    restart
  gateway-daemon
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
  wake
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
    status
    describe
    list
    pending
    approve
    reject
    rename
    invoke
    run
    notify
    camera list|snap|clip
    canvas snapshot
    screen record
    location get
  canvas
    snapshot
    present
    hide
    navigate
    eval
    a2ui push|reset
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    gmail setup|run
  pairing
    list
    approve
  telegram
    pairing list|approve
  docs
  dns
    setup
  tui
```

## Setup + onboarding

### `setup`
Initialize config + workspace.

Options:
- `--workspace <dir>`: agent workspace path (default `~/clawd`).
- `--wizard`: run the onboarding wizard.
- `--non-interactive`: run wizard without prompts.
- `--mode <local|remote>`: wizard mode.
- `--remote-url <url>`: remote Gateway URL.
- `--remote-token <token>`: remote Gateway token.

### `onboard`
Interactive wizard to set up gateway, workspace, and skills.

Options:
- `--workspace <dir>`
- `--non-interactive`
- `--mode <local|remote>`
- `--auth-choice <oauth|openai-codex|antigravity|apiKey|minimax|skip>`
- `--anthropic-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto>`
- `--gateway-auth <off|token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--daemon-runtime <node|bun>`
- `--skip-skills`
- `--skip-health`
- `--node-manager <npm|pnpm|bun>`
- `--json`

### `configure` / `config`
Interactive configuration wizard (models, providers, skills, gateway).

### `update`
Audit and modernize the local configuration.

### `doctor`
Health checks + quick fixes (config + gateway + legacy services).

Options:
- `--no-workspace-suggestions`: disable workspace memory hints.
- `--yes`: accept defaults without prompting (headless).
- `--non-interactive`: skip prompts; apply safe migrations only.
- `--deep`: scan system services for extra gateway installs.

## Auth + provider helpers

### `login`
Link a WhatsApp Web account via QR.

Options:
- `--verbose`
- `--provider <provider>` (default `whatsapp`)
- `--account <id>`

### `logout`
Clear cached WhatsApp Web credentials.

Options:
- `--provider <provider>`
- `--account <id>`

### `providers`
Manage chat provider accounts (WhatsApp/Telegram/Discord/Slack/Signal/iMessage).

Subcommands:
- `providers list`: show configured chat providers and auth profiles (Claude CLI + Codex CLI sync included).
- `providers status`: check gateway reachability and provider health (`--probe` to verify credentials).
- `providers add`: wizard-style setup when no flags are passed; flags switch to non-interactive mode.
- `providers remove`: disable by default; pass `--delete` to remove config entries without prompts.

Common options:
- `--provider <name>`: `whatsapp|telegram|discord|slack|signal|imessage`
- `--account <id>`: provider account id (default `default`)
- `--name <label>`: display name for the account

### `pairing`
Approve DM pairing requests across providers.

Subcommands:
- `pairing list --provider <telegram|signal|imessage|discord|slack|whatsapp> [--json]`
- `pairing approve --provider <...> <code> [--notify]`

### `telegram pairing`
Telegram-only pairing helper.

Subcommands:
- `telegram pairing list [--json]`
- `telegram pairing approve <code> [--no-notify]`

### `hooks gmail`
Gmail Pub/Sub hook setup + runner. See [/automation/gmail-pubsub](/automation/gmail-pubsub).

Subcommands:
- `hooks gmail setup` (requires `--account <email>`; supports `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--push-endpoint`, `--json`)
- `hooks gmail run` (runtime overrides for the same flags)

### `dns setup`
Wide-area discovery DNS helper (CoreDNS + Tailscale). See [/gateway/discovery](/gateway/discovery).

Options:
- `--apply`: install/update CoreDNS config (requires sudo; macOS only).

## Messaging + agent

### `send`
Send a message through a provider.

Required:
- `--to <dest>`
- `--message <text>`

Options:
- `--media <path-or-url>`
- `--gif-playback`
- `--provider <whatsapp|telegram|discord|slack|signal|imessage>`
- `--account <id>` (WhatsApp)
- `--dry-run`
- `--json`
- `--verbose`

### `poll`
Create a poll (WhatsApp or Discord).

Required:
- `--to <id>`
- `--question <text>`
- `--option <choice>` (repeat 2-12 times)

Options:
- `--max-selections <n>`
- `--duration-hours <n>` (Discord)
- `--provider <whatsapp|discord>`
- `--dry-run`
- `--json`
- `--verbose`

### `agent`
Run one agent turn via the Gateway (or `--local` embedded).

Required:
- `--message <text>`

Options:
- `--to <dest>` (for session key and optional delivery)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high>`
- `--verbose <on|off>`
- `--provider <whatsapp|telegram|discord|slack|signal|imessage>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`
Manage isolated agents (workspaces + auth + routing).

#### `agents list`
List configured agents.

Options:
- `--json`

#### `agents add [name]`
Add a new isolated agent. If `--workspace` is omitted, runs the guided wizard.

Options:
- `--workspace <dir>`
- `--json`

#### `agents delete <id>`
Delete an agent and prune its workspace + state.

Options:
- `--force`
- `--json`

### `status`
Show linked session health and recent recipients.

Options:
- `--json`
- `--deep` (probe providers)
- `--usage` (show provider usage/quota)
- `--timeout <ms>`
- `--verbose`

### Usage tracking
Clawdbot can surface provider usage/quota when OAuth/API creds are available.

Surfaces:
- `/status` (adds a short usage line when available)
- `clawdbot status --usage` (prints full provider breakdown)
- macOS menu bar (Usage section under Context)

Notes:
- Data comes directly from provider usage endpoints (no estimates).
- Providers: Anthropic, GitHub Copilot, Gemini CLI, Antigravity, OpenAI Codex OAuth, plus z.ai when an API key is configured.
- If no matching credentials exist, usage is hidden.
- Details: see [Usage tracking](/concepts/usage-tracking).

### `health`
Fetch health from the running Gateway.

Options:
- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`
List stored conversation sessions.

Options:
- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Gateway

### `gateway`
Run the WebSocket Gateway.

Options:
- `--port <port>`
- `--bind <loopback|tailnet|lan|auto>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--force` (kill existing listener on port)
- `--verbose`
- `--ws-log <auto|full|compact>`
- `--compact` (alias for `--ws-log compact`)

### `gateway-daemon`
Run the Gateway as a long-lived daemon (same options as `gateway`, minus `--allow-unconfigured` and `--force`).

### `daemon`
Manage the Gateway service (launchd/systemd/schtasks).

Subcommands:
- `daemon status` (probes the Gateway RPC by default)
- `daemon install` (service install)
- `daemon uninstall`
- `daemon start`
- `daemon stop`
- `daemon restart`

Notes:
- `daemon status` uses the same URL/token defaults as `gateway status` unless you pass `--url/--token/--password`.
- `daemon status` supports `--no-probe`, `--deep`, and `--json` for scripting.
- `daemon status` also surfaces legacy or extra gateway services when it can detect them (`--deep` adds system-level scans).
- `daemon install` defaults to Node runtime; use `--runtime bun` only when WhatsApp is disabled.
- `daemon install` options: `--port`, `--runtime`, `--token`.
- `gateway install|uninstall|start|stop|restart` remain as service aliases; `daemon` is the dedicated manager.

### `gateway <subcommand>`
Gateway RPC helpers (use `--url`, `--token`, `--password`, `--timeout`, `--expect-final` for each).

Subcommands:
- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway wake --text <text> [--mode now|next-heartbeat]`
- `gateway send --to <jidOrPhone> --message <text> [--media-url <url>] [--gif-playback] [--idempotency-key <key>]`
- `gateway agent --message <text> [--to <jidOrPhone>] [--session-id <id>] [--thinking <level>] [--deliver] [--timeout-seconds <n>] [--idempotency-key <key>]`
- `gateway install`
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`
- `gateway daemon status` (alias for `clawdbot daemon status`)

Common RPCs:
- `config.apply` (validate + write config + restart + wake)
- `update.run` (run update + restart + wake)

## Models

See [/concepts/models](/concepts/models) for fallback behavior and scanning strategy.

### `models` (root)
`clawdbot models` is an alias for `models status`.

### `models list`
Options:
- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`
Options:
- `--json`
- `--plain`

### `models set <model>`
Set `agent.model.primary`.

### `models set-image <model>`
Set `agent.imageModel.primary`.

### `models aliases list|add|remove`
Options:
- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`
Options:
- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`
Options:
- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`
Options:
- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

## Cron + wake

### `wake`
Enqueue a system event and optionally trigger a heartbeat (Gateway RPC).

Required:
- `--text <text>`

Options:
- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `cron`
Manage scheduled jobs (Gateway RPC). See [/automation/cron-jobs](/automation/cron-jobs).

Subcommands:
- `cron status [--json]`
- `cron list [--all] [--json]` (table output by default; use `--json` for raw)
- `cron add` (alias: `create`; requires `--name` and exactly one of `--at` | `--every` | `--cron`, and exactly one payload of `--system-event` | `--message`)
- `cron edit <id>` (patch fields)
- `cron rm <id>` (aliases: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

All `cron` commands accept `--url`, `--token`, `--timeout`, `--expect-final`.

## Nodes

`nodes` talks to the Gateway and targets paired nodes. See [/nodes](/nodes).

Common options:
- `--url`, `--token`, `--timeout`, `--json`

Subcommands:
- `nodes status`
- `nodes describe --node <id|name|ip>`
- `nodes list`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac only)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac only)

Camera:
- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + screen:
- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Location:
- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Canvas

Canvas RPC helper (top-level wrapper for `node.invoke`). See [/platforms/mac/canvas](/platforms/mac/canvas).

Common options:
- `--url`, `--token`, `--timeout`, `--json`

Subcommands:
- `canvas snapshot [--node <id|name|ip>] [--format png|jpg] [--max-width <px>] [--quality <0-1>]`
- `canvas present [--node <id|name|ip>] [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>]`
- `canvas hide [--node <id|name|ip>]`
- `canvas navigate <url> [--node <id|name|ip>]`
- `canvas eval [<js>] [--js <code>] [--node <id|name|ip>]`
- `canvas a2ui push (--jsonl <path> | --text <text>) [--node <id|name|ip>]`
- `canvas a2ui reset [--node <id|name|ip>]`

## Browser

Browser control CLI (dedicated Chrome/Chromium). See [/tools/browser](/tools/browser).

Common options:
- `--url <controlUrl>`
- `--browser-profile <name>`
- `--json`

Manage:
- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

Inspect:
- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--out <path>]`

Actions:
- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Docs search

### `docs [query...]`
Search the live docs index.

## TUI

### `tui`
Open the terminal UI connected to the Gateway.

Options:
- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--timeout-ms <ms>`
- `--history-limit <n>`
