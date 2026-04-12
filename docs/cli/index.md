---
summary: "OpenClaw CLI reference for `openclaw` commands, subcommands, and options"
read_when:
  - Adding or modifying CLI commands or options
  - Documenting new command surfaces
title: "CLI Reference"
---

# CLI reference

This page describes the current CLI behavior. If commands change, update this doc.

## Command pages

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`completion`](/cli/completion)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`backup`](/cli/backup)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`mcp`](/cli/mcp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`infer`](/cli/infer)
- [`memory`](/cli/memory)
- [`wiki`](/cli/wiki)
- [`directory`](/cli/directory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`tasks`](/cli/index#tasks)
- [`flows`](/cli/flows)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`qr`](/cli/qr)
- [`plugins`](/cli/plugins) (plugin commands)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`secrets`](/cli/secrets)
- [`skills`](/cli/skills)
- [`daemon`](/cli/daemon) (legacy alias for gateway service commands)
- [`clawbot`](/cli/clawbot) (legacy alias namespace)
- [`voicecall`](/cli/voicecall) (plugin; if installed)

## Global flags

- `--dev`: isolate state under `~/.openclaw-dev` and shift default ports.
- `--profile <name>`: isolate state under `~/.openclaw-<name>`.
- `--container <name>`: target a named container for execution.
- `--no-color`: disable ANSI colors.
- `--update`: shorthand for `openclaw update` (source installs only).
- `-V`, `--version`, `-v`: print version and exit.

## Output styling

- ANSI colors and progress indicators only render in TTY sessions.
- OSC-8 hyperlinks render as clickable links in supported terminals; otherwise we fall back to plain URLs.
- `--json` (and `--plain` where supported) disables styling for clean output.
- `--no-color` disables ANSI styling; `NO_COLOR=1` is also respected.
- Long-running commands show a progress indicator (OSC 9;4 when supported).

## Color palette

OpenClaw uses a lobster palette for CLI output.

- `accent` (#FF5A2D): headings, labels, primary highlights.
- `accentBright` (#FF7A3D): command names, emphasis.
- `accentDim` (#D14A22): secondary highlight text.
- `info` (#FF8A5B): informational values.
- `success` (#2FBF71): success states.
- `warn` (#FFB020): warnings, fallbacks, attention.
- `error` (#E23D2D): errors, failures.
- `muted` (#8B7F77): de-emphasis, metadata.

Palette source of truth: `src/terminal/palette.ts` (the “lobster palette”).

## Command tree

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
    file
    schema
    validate
  completion
  doctor
  dashboard
  backup
    create
    verify
  security
    audit
  secrets
    reload
    audit
    configure
    apply
  reset
  uninstall
  update
    wizard
    status
  channels
    list
    status
    capabilities
    resolve
    logs
    add
    remove
    login
    logout
  directory
    self
    peers list
    groups list|members
  skills
    search
    install
    update
    list
    info
    check
  plugins
    list
    inspect
    install
    uninstall
    update
    enable
    disable
    doctor
    marketplace list
  memory
    status
    index
    search
  wiki
    status
    doctor
    init
    ingest
    compile
    lint
    search
    get
    apply
    bridge import
    unsafe-local import
    obsidian status|search|open|command|daily
  message
    send
    broadcast
    poll
    react
    reactions
    read
    edit
    delete
    pin
    unpin
    pins
    permissions
    search
    thread create|list|reply
    emoji list|upload
    sticker send|upload
    role info|add|remove
    channel info|list
    member info
    voice status
    event list|create
    timeout
    kick
    ban
  agent
  agents
    list
    add
    delete
    bindings
    bind
    unbind
    set-identity
  acp
  mcp
    serve
    list
    show
    set
    unset
  status
  health
  sessions
    cleanup
  tasks
    list
    audit
    maintenance
    show
    notify
    cancel
    flow list|show|cancel
  gateway
    call
    usage-cost
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  daemon
    status
    install
    uninstall
    start
    stop
    restart
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
  infer (alias: capability)
    list
    inspect
    model run|list|inspect|providers|auth login|logout|status
    image generate|edit|describe|describe-many|providers
    audio transcribe|providers
    tts convert|voices|providers|status|enable|disable|set-provider
    video generate|describe|providers
    web search|fetch|providers
    embedding create|providers
    auth add|login|login-github-copilot|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
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
    notify
    push
    canvas snapshot|present|hide|navigate|eval
    canvas a2ui push|reset
    camera list|snap|clip
    screen record
    location get
  devices
    list
    remove
    clear
    approve
    reject
    rotate
    revoke
  node
    run
    status
    install
    uninstall
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
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
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  qr
  clawbot
    qr
  docs
  dns
    setup
  tui
```

Note: plugins can add additional top-level commands (for example `openclaw voicecall`).

## Security

- `openclaw security audit` — audit config + local state for common security foot-guns.
- `openclaw security audit --deep` — best-effort live Gateway probe.
- `openclaw security audit --fix` — tighten safe defaults and state/config permissions.

## Secrets

### `secrets`

Manage SecretRefs and related runtime/config hygiene.

Subcommands:

- `secrets reload`
- `secrets audit`
- `secrets configure`
- `secrets apply --from <path>`

`secrets reload` options:

- `--url`, `--token`, `--timeout`, `--expect-final`, `--json`

`secrets audit` options:

- `--check`
- `--allow-exec`
- `--json`

`secrets configure` options:

- `--apply`
- `--yes`
- `--providers-only`
- `--skip-provider-setup`
- `--agent <id>`
- `--allow-exec`
- `--plan-out <path>`
- `--json`

`secrets apply --from <path>` options:

- `--dry-run`
- `--allow-exec`
- `--json`

Notes:

- `reload` is a Gateway RPC and keeps the last-known-good runtime snapshot when resolution fails.
- `audit --check` returns non-zero on findings; unresolved refs use a higher-priority non-zero exit code.
- Dry-run exec checks are skipped by default; use `--allow-exec` to opt in.

## Plugins

Manage extensions and their config:

- `openclaw plugins list` — discover plugins (use `--json` for machine output).
- `openclaw plugins inspect <id>` — show details for a plugin (`info` is an alias).
- `openclaw plugins install <path|.tgz|npm-spec|plugin@marketplace>` — install a plugin (or add a plugin path to `plugins.load.paths`; use `--force` to overwrite an existing install target).
- `openclaw plugins marketplace list <marketplace>` — list marketplace entries before install.
- `openclaw plugins enable <id>` / `disable <id>` — toggle `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — report plugin load errors.

Most plugin changes require a gateway restart. See [/plugin](/tools/plugin).

## Memory

Vector search over `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — show index stats; use `--deep` for vector + embedding readiness checks or `--fix` to repair stale recall/promotion artifacts.
- `openclaw memory index` — reindex memory files.
- `openclaw memory search "<query>"` (or `--query "<query>"`) — semantic search over memory.
- `openclaw memory promote` — rank short-term recalls and optionally append top entries into `MEMORY.md`.

## Sandbox

Manage sandbox runtimes for isolated agent execution. See [/cli/sandbox](/cli/sandbox).

Subcommands:

- `sandbox list [--browser] [--json]`
- `sandbox recreate [--all] [--session <key>] [--agent <id>] [--browser] [--force]`
- `sandbox explain [--session <key>] [--agent <id>] [--json]`

Notes:

- `sandbox recreate` removes existing runtimes so the next use seeds them again with current config.
- For `ssh` and OpenShell `remote` backends, recreate deletes the canonical remote workspace for the selected scope.

## Chat slash commands

Chat messages support `/...` commands (text and native). See [/tools/slash-commands](/tools/slash-commands).

Highlights:

- `/status` for quick diagnostics.
- `/trace` for session-scoped plugin trace/debug lines.
- `/config` for persisted config changes.
- `/debug` for runtime-only config overrides (memory, not disk; requires `commands.debug: true`).

## Setup + onboarding

### `completion`

Generate shell-completion scripts and optionally install them into your shell profile.

Options:

- `-s, --shell <zsh|bash|powershell|fish>`
- `-i, --install`
- `--write-state`
- `-y, --yes`

Notes:

- Without `--install` or `--write-state`, `completion` prints the script to stdout.
- `--install` writes an `OpenClaw Completion` block into your shell profile and points it at the cached script under the OpenClaw state directory.

### `setup`

Initialize config + workspace.

Options:

- `--workspace <dir>`: agent workspace path (default `~/.openclaw/workspace`).
- `--wizard`: run onboarding.
- `--non-interactive`: run onboarding without prompts.
- `--mode <local|remote>`: onboard mode.
- `--remote-url <url>`: remote Gateway URL.
- `--remote-token <token>`: remote Gateway token.

Onboarding auto-runs when any onboarding flags are present (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Interactive onboarding for gateway, workspace, and skills.

Options:

- `--workspace <dir>`
- `--reset` (reset config + credentials + sessions before onboarding)
- `--reset-scope <config|config+creds+sessions|full>` (default `config+creds+sessions`; use `full` to also remove workspace)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual is an alias for advanced)
- `--auth-choice <choice>` where `<choice>` is one of:
  `chutes`, `deepseek-api-key`, `openai-codex`, `openai-api-key`,
  `openrouter-api-key`, `kilocode-api-key`, `litellm-api-key`, `ai-gateway-api-key`,
  `cloudflare-ai-gateway-api-key`, `moonshot-api-key`, `moonshot-api-key-cn`,
  `kimi-code-api-key`, `synthetic-api-key`, `venice-api-key`, `together-api-key`,
  `huggingface-api-key`, `apiKey`, `gemini-api-key`, `google-gemini-cli`, `zai-api-key`,
  `zai-coding-global`, `zai-coding-cn`, `zai-global`, `zai-cn`, `xiaomi-api-key`,
  `minimax-global-oauth`, `minimax-global-api`, `minimax-cn-oauth`, `minimax-cn-api`,
  `opencode-zen`, `opencode-go`, `github-copilot`, `copilot-proxy`, `xai-api-key`,
  `mistral-api-key`, `volcengine-api-key`, `byteplus-api-key`, `qianfan-api-key`,
  `qwen-standard-api-key-cn`, `qwen-standard-api-key`, `qwen-api-key-cn`, `qwen-api-key`,
  `modelstudio-standard-api-key-cn`, `modelstudio-standard-api-key`,
  `modelstudio-api-key-cn`, `modelstudio-api-key`, `custom-api-key`, `skip`
- Qwen note: `qwen-*` is the canonical auth-choice family. `modelstudio-*`
  ids remain accepted as legacy compatibility aliases only.
- `--secret-input-mode <plaintext|ref>` (default `plaintext`; use `ref` to store provider default env refs instead of plaintext keys)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--mistral-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--opencode-go-api-key <key>`
- `--custom-base-url <url>` (non-interactive; used with `--auth-choice custom-api-key`)
- `--custom-model-id <id>` (non-interactive; used with `--auth-choice custom-api-key`)
- `--custom-api-key <key>` (non-interactive; optional; used with `--auth-choice custom-api-key`; falls back to `CUSTOM_API_KEY` when omitted)
- `--custom-provider-id <id>` (non-interactive; optional custom provider id)
- `--custom-compatibility <openai|anthropic>` (non-interactive; optional; default `openai`)
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-token-ref-env <name>` (non-interactive; store `gateway.auth.token` as an env SecretRef; requires that env var to be set; cannot be combined with `--gateway-token`)
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (alias: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-search`
- `--skip-health`
- `--skip-ui`
- `--cloudflare-ai-gateway-account-id <id>`
- `--cloudflare-ai-gateway-gateway-id <id>`
- `--node-manager <npm|pnpm|bun>` (setup/onboarding node manager for skills; pnpm recommended, bun also supported)
- `--json`

### `configure`

Interactive configuration wizard (models, channels, skills, gateway).

Options:

- `--section <section>` (repeatable; limit the wizard to specific sections)

### `config`

Non-interactive config helpers (get/set/unset/file/schema/validate). Running `openclaw config` with no
subcommand launches the wizard.

Subcommands:

- `config get <path>`: print a config value (dot/bracket path).
- `config set`: supports four assignment modes:
  - value mode: `config set <path> <value>` (JSON5-or-string parsing)
  - SecretRef builder mode: `config set <path> --ref-provider <provider> --ref-source <source> --ref-id <id>`
  - provider builder mode: `config set secrets.providers.<alias> --provider-source <env|file|exec> ...`
  - batch mode: `config set --batch-json '<json>'` or `config set --batch-file <path>`
- `config set --dry-run`: validate assignments without writing `openclaw.json` (exec SecretRef checks are skipped by default).
- `config set --allow-exec --dry-run`: opt in to exec SecretRef dry-run checks (may execute provider commands).
- `config set --dry-run --json`: emit machine-readable dry-run output (checks + completeness signal, operations, refs checked/skipped, errors).
- `config set --strict-json`: require JSON5 parsing for path/value input. `--json` remains a legacy alias for strict parsing outside dry-run output mode.
- `config unset <path>`: remove a value.
- `config file`: print the active config file path.
- `config schema`: print the generated JSON schema for `openclaw.json`, including propagated field `title` / `description` docs metadata across nested object, wildcard, array-item, and composition branches, plus best-effort live plugin/channel schema metadata.
- `config validate`: validate the current config against the schema without starting the gateway.
- `config validate --json`: emit machine-readable JSON output.

### `doctor`

Health checks + quick fixes (config + gateway + legacy services).

Options:

- `--no-workspace-suggestions`: disable workspace memory hints.
- `--yes`: accept defaults without prompting (headless).
- `--non-interactive`: skip prompts; apply safe migrations only.
- `--deep`: scan system services for extra gateway installs.
- `--repair` (alias: `--fix`): attempt automatic repairs for detected issues.
- `--force`: force repairs even when not strictly needed.
- `--generate-gateway-token`: generate a new gateway auth token.

### `dashboard`

Open the Control UI with your current token.

Options:

- `--no-open`: print the URL but do not launch a browser

Notes:

- For SecretRef-managed gateway tokens, `dashboard` prints or opens a non-tokenized URL instead of exposing the secret in terminal output or browser launch arguments.

### `update`

Update the installed CLI.

Root options:

- `--json`
- `--no-restart`
- `--dry-run`
- `--channel <stable|beta|dev>`
- `--tag <dist-tag|version|spec>`
- `--timeout <seconds>`
- `--yes`

Subcommands:

- `update status`
- `update wizard`

`update status` options:

- `--json`
- `--timeout <seconds>`

`update wizard` options:

- `--timeout <seconds>`

Notes:

- `openclaw --update` rewrites to `openclaw update`.

### `backup`

Create and verify local backup archives for OpenClaw state.

Subcommands:

- `backup create`
- `backup verify <archive>`

`backup create` options:

- `--output <path>`
- `--json`
- `--dry-run`
- `--verify`
- `--only-config`
- `--no-include-workspace`

`backup verify <archive>` options:

- `--json`

## Channel helpers

### `channels`

Manage chat channel accounts (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/Microsoft Teams).

Subcommands:

- `channels list`: show configured channels and auth profiles.
- `channels status`: check gateway reachability and channel health (`--probe` runs live per-account probe/audit checks when the gateway is reachable; if not, it falls back to config-only channel summaries. Use `openclaw health` or `openclaw status --deep` for broader gateway health probes).
- Tip: `channels status` prints warnings with suggested fixes when it can detect common misconfigurations (then points you to `openclaw doctor`).
- `channels logs`: show recent channel logs from the gateway log file.
- `channels add`: wizard-style setup when no flags are passed; flags switch to non-interactive mode.
  - When adding a non-default account to a channel still using single-account top-level config, OpenClaw promotes account-scoped values into the channel account map before writing the new account. Most channels use `accounts.default`; Matrix can preserve an existing matching named/default target instead.
  - Non-interactive `channels add` does not auto-create/upgrade bindings; channel-only bindings continue to match the default account.
- `channels remove`: disable by default; pass `--delete` to remove config entries without prompts.
- `channels login`: interactive channel login (WhatsApp Web only).
- `channels logout`: log out of a channel session (if supported).

Common options:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: channel account id (default `default`)
- `--name <label>`: display name for the account

`channels login` options:

- `--channel <channel>` (default `whatsapp`; supports `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

`channels logout` options:

- `--channel <channel>` (default `whatsapp`)
- `--account <id>`

`channels list` options:

- `--no-usage`: skip model provider usage/quota snapshots (OAuth/API-backed only).
- `--json`: output JSON (includes usage unless `--no-usage` is set).

`channels status` options:

- `--probe`
- `--timeout <ms>`
- `--json`

`channels capabilities` options:

- `--channel <name>`
- `--account <id>` (only with `--channel`)
- `--target <dest>`
- `--timeout <ms>`
- `--json`

`channels resolve` options:

- `<entries...>`
- `--channel <name>`
- `--account <id>`
- `--kind <auto|user|group>`
- `--json`

`channels logs` options:

- `--channel <name|all>` (default `all`)
- `--lines <n>` (default `200`)
- `--json`

Notes:

- `channels login` supports `--verbose`.
- `channels capabilities --account` only applies when `--channel` is set.
- `channels status --probe` can show transport state plus probe/audit results such as `works`, `probe failed`, `audit ok`, or `audit failed`, depending on channel support.

More detail: [/concepts/oauth](/concepts/oauth)

Examples:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `directory`

Look up self, peer, and group IDs for channels that expose a directory surface. See [`openclaw directory`](/cli/directory).

Common options:

- `--channel <name>`
- `--account <id>`
- `--json`

Subcommands:

- `directory self`
- `directory peers list [--query <text>] [--limit <n>]`
- `directory groups list [--query <text>] [--limit <n>]`
- `directory groups members --group-id <id> [--limit <n>]`

### `skills`

List and inspect available skills plus readiness info.

Subcommands:

- `skills search [query...]`: search ClawHub skills.
- `skills search --limit <n> --json`: cap search results or emit machine-readable output.
- `skills install <slug>`: install a skill from ClawHub into the active workspace.
- `skills install <slug> --version <version>`: install a specific ClawHub version.
- `skills install <slug> --force`: overwrite an existing workspace skill folder.
- `skills update <slug|--all>`: update tracked ClawHub skills.
- `skills list`: list skills (default when no subcommand).
- `skills list --json`: emit machine-readable skill inventory on stdout.
- `skills list --verbose`: include missing requirements in the table.
- `skills info <name>`: show details for one skill.
- `skills info <name> --json`: emit machine-readable details on stdout.
- `skills check`: summary of ready vs missing requirements.
- `skills check --json`: emit machine-readable readiness output on stdout.

Options:

- `--eligible`: show only ready skills.
- `--json`: output JSON (no styling).
- `-v`, `--verbose`: include missing requirements detail.

Tip: use `openclaw skills search`, `openclaw skills install`, and `openclaw skills update` for ClawHub-backed skills.

### `pairing`

Approve DM pairing requests across channels.

Subcommands:

- `pairing list [channel] [--channel <channel>] [--account <id>] [--json]`
- `pairing approve <channel> <code> [--account <id>] [--notify]`
- `pairing approve --channel <channel> [--account <id>] <code> [--notify]`

Notes:

- If exactly one pairing-capable channel is configured, `pairing approve <code>` is also allowed.
- `list` and `approve` both support `--account <id>` for multi-account channels.

### `devices`

Manage gateway device pairing entries and per-role device tokens.

Subcommands:

- `devices list [--json]`
- `devices approve [requestId] [--latest]`
- `devices reject <requestId>`
- `devices remove <deviceId>`
- `devices clear --yes [--pending]`
- `devices rotate --device <id> --role <role> [--scope <scope...>]`
- `devices revoke --device <id> --role <role>`

Notes:

- `devices list` and `devices approve` can fall back to local pairing files on local loopback when direct pairing scope is unavailable.
- `devices approve` requires an explicit request ID before minting tokens; omitting `requestId` or passing `--latest` only previews the newest pending request.
- Stored-token reconnects reuse the token's cached approved scopes; explicit
  `devices rotate --scope ...` updates that stored scope set for future
  cached-token reconnects.
- `devices rotate` and `devices revoke` return JSON payloads.

### `qr`

Generate a mobile pairing QR and setup code from the current Gateway config. See [`openclaw qr`](/cli/qr).

Options:

- `--remote`
- `--url <url>`
- `--public-url <url>`
- `--token <token>`
- `--password <password>`
- `--setup-code-only`
- `--no-ascii`
- `--json`

Notes:

- `--token` and `--password` are mutually exclusive.
- The setup code carries a short-lived bootstrap token, not the shared gateway token/password.
- Built-in bootstrap handoff keeps the primary node token at `scopes: []`.
- Any handed-off operator bootstrap token stays bounded to `operator.approvals`, `operator.read`, `operator.talk.secrets`, and `operator.write`.
- Bootstrap scope checks are role-prefixed, so that operator allowlist only satisfies operator requests; non-operator roles still need scopes under their own role prefix.
- `--remote` can use `gateway.remote.url` or the active Tailscale Serve/Funnel URL.
- After scanning, approve the request with `openclaw devices list` / `openclaw devices approve <requestId>`.

### `clawbot`

Legacy alias namespace. Currently supports `openclaw clawbot qr`, which maps to [`openclaw qr`](/cli/qr).

### `hooks`

Manage internal agent hooks.

Subcommands:

- `hooks list`
- `hooks info <name>`
- `hooks check`
- `hooks enable <name>`
- `hooks disable <name>`
- `hooks install <path-or-spec>` (deprecated alias for `openclaw plugins install`)
- `hooks update [id]` (deprecated alias for `openclaw plugins update`)

Common options:

- `--json`
- `--eligible`
- `-v`, `--verbose`

Notes:

- Plugin-managed hooks cannot be enabled or disabled through `openclaw hooks`; enable or disable the owning plugin instead.
- `hooks install` and `hooks update` still work as compatibility aliases, but they print deprecation warnings and forward to the plugin commands.

### `webhooks`

Webhook helpers. Current built-in surface is Gmail Pub/Sub setup + runner:

- `webhooks gmail setup`
- `webhooks gmail run`

### `webhooks gmail`

Gmail Pub/Sub hook setup + runner. See [Gmail Pub/Sub](/automation/cron-jobs#gmail-pubsub-integration).

Subcommands:

- `webhooks gmail setup` (requires `--account <email>`; supports `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (runtime overrides for the same flags)

Notes:

- `setup` configures the Gmail watch plus the OpenClaw-facing push path.
- `run` starts the local Gmail watcher/renew loop with optional runtime overrides.

### `dns`

Wide-area discovery DNS helpers (CoreDNS + Tailscale). Current built-in surface:

- `dns setup [--domain <domain>] [--apply]`

### `dns setup`

Wide-area discovery DNS helper (CoreDNS + Tailscale). See [/gateway/discovery](/gateway/discovery).

Options:

- `--domain <domain>`
- `--apply`: install/update CoreDNS config (requires sudo; macOS only).

Notes:

- Without `--apply`, this is a planning helper that prints the recommended OpenClaw + Tailscale DNS config.
- `--apply` currently supports macOS with Homebrew CoreDNS only.

## Messaging + agent

### `message`

Unified outbound messaging + channel actions.

See: [/cli/message](/cli/message)

Subcommands:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Examples:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Run one agent turn via the Gateway (or `--local` embedded).

Pass at least one session selector: `--to`, `--session-id`, or `--agent`.

Required:

- `-m, --message <text>`

Options:

- `-t, --to <dest>` (for session key and optional delivery)
- `--session-id <id>`
- `--agent <id>` (agent id; overrides routing bindings)
- `--thinking <off|minimal|low|medium|high|xhigh>` (provider support varies; not model-gated at CLI level)
- `--verbose <on|off>`
- `--channel <channel>` (delivery channel; omit to use the main session channel)
- `--reply-to <target>` (delivery target override, separate from session routing)
- `--reply-channel <channel>` (delivery channel override)
- `--reply-account <id>` (delivery account id override)
- `--local` (embedded run; plugin registry still preloads first)
- `--deliver`
- `--json`
- `--timeout <seconds>`

Notes:

- Gateway mode falls back to the embedded agent when the Gateway request fails.
- `--local` still preloads the plugin registry, so plugin-provided providers, tools, and channels remain available during embedded runs.
- `--channel`, `--reply-channel`, and `--reply-account` affect reply delivery, not routing.

### `agents`

Manage isolated agents (workspaces + auth + routing).

Running `openclaw agents` with no subcommand is equivalent to `openclaw agents list`.

#### `agents list`

List configured agents.

Options:

- `--json`
- `--bindings`

#### `agents add [name]`

Add a new isolated agent. Runs the guided wizard unless flags (or `--non-interactive`) are passed; `--workspace` is required in non-interactive mode.

Options:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repeatable)
- `--non-interactive`
- `--json`

Binding specs use `channel[:accountId]`. When `accountId` is omitted, OpenClaw may resolve account scope via channel defaults/plugin hooks; otherwise it is a channel binding without explicit account scope.
Passing any explicit add flags switches the command into the non-interactive path. `main` is reserved and cannot be used as the new agent id.

#### `agents bindings`

List routing bindings.

Options:

- `--agent <id>`
- `--json`

#### `agents bind`

Add routing bindings for an agent.

Options:

- `--agent <id>` (defaults to the current default agent)
- `--bind <channel[:accountId]>` (repeatable)
- `--json`

#### `agents unbind`

Remove routing bindings for an agent.

Options:

- `--agent <id>` (defaults to the current default agent)
- `--bind <channel[:accountId]>` (repeatable)
- `--all`
- `--json`

Use either `--all` or `--bind`, not both.

#### `agents delete <id>`

Delete an agent and prune its workspace + state.

Options:

- `--force`
- `--json`

Notes:

- `main` cannot be deleted.
- Without `--force`, interactive confirmation is required.

#### `agents set-identity`

Update an agent identity (name/theme/emoji/avatar).

Options:

- `--agent <id>`
- `--workspace <dir>`
- `--identity-file <path>`
- `--from-identity`
- `--name <name>`
- `--theme <theme>`
- `--emoji <emoji>`
- `--avatar <value>`
- `--json`

Notes:

- `--agent` or `--workspace` can be used to select the target agent.
- When no explicit identity fields are provided, the command reads `IDENTITY.md`.

### `acp`

Run the ACP bridge that connects IDEs to the Gateway.

Root options:

- `--url <url>`
- `--token <token>`
- `--token-file <path>`
- `--password <password>`
- `--password-file <path>`
- `--session <key>`
- `--session-label <label>`
- `--require-existing`
- `--reset-session`
- `--no-prefix-cwd`
- `--provenance <off|meta|meta+receipt>`
- `--verbose`

#### `acp client`

Interactive ACP client for bridge debugging.

Options:

- `--cwd <dir>`
- `--server <command>`
- `--server-args <args...>`
- `--server-verbose`
- `--verbose`

See [`acp`](/cli/acp) for full behavior, security notes, and examples.

### `mcp`

Manage saved MCP server definitions and expose OpenClaw channels over MCP stdio.

#### `mcp serve`

Expose routed OpenClaw channel conversations over MCP stdio.

Options:

- `--url <url>`
- `--token <token>`
- `--token-file <path>`
- `--password <password>`
- `--password-file <path>`
- `--claude-channel-mode <auto|on|off>`
- `--verbose`

#### `mcp list`

List saved MCP server definitions.

Options:

- `--json`

#### `mcp show [name]`

Show one saved MCP server definition or the full saved MCP server object.

Options:

- `--json`

#### `mcp set <name> <value>`

Save one MCP server definition from a JSON object.

#### `mcp unset <name>`

Remove one saved MCP server definition.

### `approvals`

Manage exec approvals. Alias: `exec-approvals`.

#### `approvals get`

Fetch the exec approvals snapshot and effective policy.

Options:

- `--node <node>`
- `--gateway`
- `--json`
- node RPC options from `openclaw nodes`

#### `approvals set`

Replace exec approvals with JSON from a file or stdin.

Options:

- `--node <node>`
- `--gateway`
- `--file <path>`
- `--stdin`
- `--json`
- node RPC options from `openclaw nodes`

#### `approvals allowlist add|remove`

Edit the per-agent exec allowlist.

Options:

- `--node <node>`
- `--gateway`
- `--agent <id>` (defaults to `*`)
- `--json`
- node RPC options from `openclaw nodes`

### `status`

Show linked session health and recent recipients.

Options:

- `--json`
- `--all` (full diagnosis; read-only, pasteable)
- `--deep` (ask the gateway for a live health probe, including channel probes when supported)
- `--usage` (show model provider usage/quota)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias for `--verbose`)

Notes:

- Overview includes Gateway + node host service status when available.
- `--usage` prints normalized provider usage windows as `X% left`.

### Usage tracking

OpenClaw can surface provider usage/quota when OAuth/API creds are available.

Surfaces:

- `/status` (adds a short provider usage line when available)
- `openclaw status --usage` (prints full provider breakdown)
- macOS menu bar (Usage section under Context)

Notes:

- Data comes directly from provider usage endpoints (no estimates).
- Human-readable output is normalized to `X% left` across providers.
- Providers with current usage windows: Anthropic, GitHub Copilot, Gemini CLI, OpenAI Codex, MiniMax, Xiaomi, and z.ai.
- MiniMax note: raw `usage_percent` / `usagePercent` means remaining quota, so OpenClaw inverts it before display; count-based fields still win when present. `model_remains` responses prefer the chat-model entry, derive the window label from timestamps when needed, and include the model name in the plan label.
- Usage auth comes from provider-specific hooks when available; otherwise OpenClaw falls back to matching OAuth/API-key credentials from auth profiles, env, or config. If none resolve, usage is hidden.
- Details: see [Usage tracking](/concepts/usage-tracking).

### `health`

Fetch health from the running Gateway.

Options:

- `--json`
- `--timeout <ms>`
- `--verbose` (force a live probe and print gateway connection details)
- `--debug` (alias for `--verbose`)

Notes:

- Default `health` can return a fresh cached gateway snapshot.
- `health --verbose` forces a live probe and expands human-readable output across all configured accounts and agents.

### `sessions`

List stored conversation sessions.

Options:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`
- `--agent <id>` (filter sessions by agent)
- `--all-agents` (show sessions across all agents)

Subcommands:

- `sessions cleanup` — remove expired or orphaned sessions

Notes:

- `sessions cleanup` also supports `--fix-missing` to prune entries whose transcript files are gone.

## Reset / Uninstall

### `reset`

Reset local config/state (keeps the CLI installed).

Options:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notes:

- `--non-interactive` requires `--scope` and `--yes`.

### `uninstall`

Uninstall the gateway service + local data (CLI remains).

Options:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notes:

- `--non-interactive` requires `--yes` and explicit scopes (or `--all`).
- `--all` removes service, state, workspace, and app together.

### `tasks`

List and manage [background task](/automation/tasks) runs across agents.

- `tasks list` — show active and recent task runs
- `tasks show <id>` — show details for a specific task run
- `tasks notify <id>` — change notification policy for a task run
- `tasks cancel <id>` — cancel a running task
- `tasks audit` — surface operational issues (stale, lost, delivery failures)
- `tasks maintenance [--apply] [--json]` — preview or apply tasks and TaskFlow cleanup/reconciliation (ACP/subagent child sessions, active cron jobs, live CLI runs)
- `tasks flow list` — list active and recent Task Flow flows
- `tasks flow show <lookup>` — inspect a flow by id or lookup key
- `tasks flow cancel <lookup>` — cancel a running flow and its active tasks

### `flows`

Legacy docs shortcut. Flow commands live under `openclaw tasks flow`:

- `tasks flow list [--json]`
- `tasks flow show <lookup>`
- `tasks flow cancel <lookup>`

## Gateway

### `gateway`

Run the WebSocket Gateway.

Options:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--password-file <path>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (reset dev config + credentials + sessions + workspace)
- `--force` (kill existing listener on port)
- `--verbose`
- `--cli-backend-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias for `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Manage the Gateway service (launchd/systemd/schtasks).

Subcommands:

- `gateway status` (probes the Gateway RPC by default)
- `gateway install` (service install)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notes:

- `gateway status` probes the Gateway RPC by default using the service’s resolved port/config (override with `--url/--token/--password`).
- `gateway status` supports `--no-probe`, `--deep`, `--require-rpc`, and `--json` for scripting.
- `gateway status` also surfaces legacy or extra gateway services when it can detect them (`--deep` adds system-level scans). Profile-named OpenClaw services are treated as first-class and aren't flagged as "extra".
- `gateway status` stays available for diagnostics even when the local CLI config is missing or invalid.
- `gateway status` prints the resolved file log path, the CLI-vs-service config paths/validity snapshot, and the resolved probe target URL.
- If gateway auth SecretRefs are unresolved in the current command path, `gateway status --json` reports `rpc.authWarning` only when probe connectivity/auth fails (warnings are suppressed when probe succeeds).
- On Linux systemd installs, status token-drift checks include both `Environment=` and `EnvironmentFile=` unit sources.
- `gateway install|uninstall|start|stop|restart` support `--json` for scripting (default output stays human-friendly).
- `gateway install` defaults to Node runtime; bun is **not recommended** (WhatsApp/Telegram bugs).
- `gateway install` options: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `daemon`

Legacy alias for the Gateway service-management commands. See [/cli/daemon](/cli/daemon).

Subcommands:

- `daemon status`
- `daemon install`
- `daemon uninstall`
- `daemon start`
- `daemon stop`
- `daemon restart`

Common options:

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- `uninstall|start|stop|restart`: `--json`

### `logs`

Tail Gateway file logs via RPC.

Options:

- `--limit <n>`: maximum number of log lines to return
- `--max-bytes <n>`: maximum bytes to read from the log file
- `--follow`: follow the log file (tail -f style)
- `--interval <ms>`: polling interval in ms when following
- `--local-time`: display timestamps in local time
- `--json`: emit line-delimited JSON
- `--plain`: disable structured formatting
- `--no-color`: disable ANSI colors
- `--url <url>`: explicit Gateway WebSocket URL
- `--token <token>`: Gateway token
- `--timeout <ms>`: Gateway RPC timeout
- `--expect-final`: wait for a final response when needed

Examples:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

Notes:

- If you pass `--url`, the CLI does not auto-apply config or environment credentials.
- Local loopback pairing failures fall back to the configured local log file; explicit `--url` targets do not.

### `gateway <subcommand>`

Gateway CLI helpers (use `--url`, `--token`, `--password`, `--timeout`, `--expect-final` for RPC subcommands).
When you pass `--url`, the CLI does not auto-apply config or environment credentials.
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.

Subcommands:

- `gateway call <method> [--params <json>] [--url <url>] [--token <token>] [--password <password>] [--timeout <ms>] [--expect-final] [--json]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

Notes:

- `gateway status --deep` adds a system-level service scan. Use `gateway probe`,
  `health --verbose`, or top-level `status --deep` for deeper runtime probe detail.

Common RPCs:

- `config.schema.lookup` (inspect one config subtree with a shallow schema node, matched hint metadata, and immediate child summaries)
- `config.get` (read current config snapshot + hash)
- `config.set` (validate + write full config; use `baseHash` for optimistic concurrency)
- `config.apply` (validate + write config + restart + wake)
- `config.patch` (merge a partial update + restart + wake)
- `update.run` (run update + restart + wake)

Tip: when calling `config.set`/`config.apply`/`config.patch` directly, pass `baseHash` from
`config.get` if a config already exists.
Tip: for partial edits, inspect with `config.schema.lookup` first and prefer `config.patch`.
Tip: these config write RPCs preflight active SecretRef resolution for refs in the submitted config payload and reject writes when an effectively active submitted ref is unresolved.
Tip: the owner-only `gateway` runtime tool still refuses to rewrite `tools.exec.ask` or `tools.exec.security`; legacy `tools.bash.*` aliases normalize to the same protected exec paths.

## Models

See [/concepts/models](/concepts/models) for fallback behavior and scanning strategy.

Anthropic note: Anthropic staff told us OpenClaw-style Claude CLI usage is
allowed again, so OpenClaw treats Claude CLI reuse and `claude -p` usage as
sanctioned for this integration unless Anthropic publishes a new policy. For
production, prefer an Anthropic API key or another supported
subscription-style provider such as OpenAI Codex, Alibaba Cloud Model Studio
Coding Plan, MiniMax Coding Plan, or Z.AI / GLM Coding Plan.

Anthropic setup-token remains available as a supported token-auth path, but OpenClaw now prefers Claude CLI reuse and `claude -p` when available.

### `models` (root)

`openclaw models` is an alias for `models status`.

Root options:

- `--status-json` (alias for `models status --json`)
- `--status-plain` (alias for `models status --plain`)

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
- `--check` (exit 1=expired/missing, 2=expiring)
- `--probe` (live probe of configured auth profiles)
- `--probe-provider <name>`
- `--probe-profile <id>` (repeat or comma-separated)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>`

Always includes the auth overview and OAuth expiry status for profiles in the auth store.
`--probe` runs live requests (may consume tokens and trigger rate limits).
Probe rows can come from auth profiles, env credentials, or `models.json`.
Expect probe statuses like `ok`, `auth`, `rate_limit`, `billing`, `timeout`,
`format`, `unknown`, and `no_model`.
When an explicit `auth.order.<provider>` omits a stored profile, probe reports
`excluded_by_auth_order` instead of silently trying that profile.

### `models set <model>`

Set `agents.defaults.model.primary`.

### `models set-image <model>`

Set `agents.defaults.imageModel.primary`.

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
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|login|login-github-copilot|setup-token|paste-token`

Options:

- `add`: interactive auth helper (provider auth flow or token paste)
- `login`: `--provider <name>`, `--method <method>`, `--set-default`
- `login-github-copilot`: GitHub Copilot OAuth login flow (`--yes`)
- `setup-token`: `--provider <name>`, `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

Notes:

- `setup-token` and `paste-token` are generic token commands for providers that expose token auth methods.
- `setup-token` requires an interactive TTY and runs the provider's token-auth method.
- `paste-token` prompts for the token value and defaults to auth profile id `<provider>:manual` when `--profile-id` is omitted.
- Anthropic `setup-token` / `paste-token` remain available as a supported OpenClaw token path, but OpenClaw now prefers Claude CLI reuse and `claude -p` when available.

### `models auth order get|set|clear`

Options:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## System

### `system event`

Enqueue a system event and optionally trigger a heartbeat (Gateway RPC).

Required:

- `--text <text>`

Options:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Heartbeat controls (Gateway RPC).

Options:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

List system presence entries (Gateway RPC).

Options:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

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
- `cron run <id> [--due]`

All `cron` commands accept `--url`, `--token`, `--timeout`, `--expect-final`.

`cron add|edit --model ...` uses that selected allowed model for the job. If
the model is not allowed, cron warns and falls back to the job's agent/default
model selection instead. Configured fallback chains still apply, but a plain
model override with no explicit per-job fallback list no longer appends the
agent primary as a hidden extra retry target.

## Node host

### `node`

`node` runs a **headless node host** or manages it as a background service. See
[`openclaw node`](/cli/node).

Subcommands:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

Auth notes:

- `node` resolves gateway auth from env/config (no `--token`/`--password` flags): `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`, then `gateway.auth.*`. In local mode, node host intentionally ignores `gateway.remote.*`; in `gateway.mode=remote`, `gateway.remote.*` participates per remote precedence rules.
- Node-host auth resolution only honors `OPENCLAW_GATEWAY_*` env vars.

## Nodes

`nodes` talks to the Gateway and targets paired nodes. See [/nodes](/nodes).

Common options:

- `--url`, `--token`, `--timeout`, `--json`

Subcommands:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac only)

Camera:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Canvas + screen:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Location:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Browser

Browser control CLI (dedicated Chrome/Brave/Edge/Chromium). See [`openclaw browser`](/cli/browser) and the [Browser tool](/tools/browser).

Common options:

- `--url`, `--token`, `--timeout`, `--expect-final`, `--json`
- `--browser-profile <name>`

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
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>] [--driver existing-session] [--user-data-dir <path>]`
- `browser delete-profile --name <name>`

Inspect:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

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

## Voice call

### `voicecall`

Plugin-provided voice-call utilities. Only appears when the voice-call plugin is installed and enabled. See [`openclaw voicecall`](/cli/voicecall).

Common commands:

- `voicecall call --to <phone> --message <text> [--mode notify|conversation]`
- `voicecall start --to <phone> [--message <text>] [--mode notify|conversation]`
- `voicecall continue --call-id <id> --message <text>`
- `voicecall speak --call-id <id> --message <text>`
- `voicecall end --call-id <id>`
- `voicecall status --call-id <id>`
- `voicecall tail [--file <path>] [--since <n>] [--poll <ms>]`
- `voicecall latency [--file <path>] [--last <n>]`
- `voicecall expose [--mode off|serve|funnel] [--path <path>] [--port <port>] [--serve-path <path>]`

## Docs search

### `docs`

Search the live OpenClaw docs index.

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
- `--message <text>`
- `--timeout-ms <ms>` (defaults to `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
