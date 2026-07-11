---
summary: "OpenClaw CLI index: command list, global flags, and links to per-command pages"
read_when:
  - Finding the right `openclaw` subcommand
  - Looking up global flags or output styling rules
title: "CLI reference"
---

`openclaw` is the main CLI entry point. Each core command has a dedicated
reference page or is documented with the command it aliases; this index lists
the commands, global flags, and output styling rules that apply across the CLI.

Setup commands by intent:

- `openclaw setup` and `openclaw onboard` verify inference first, then start Crestodian for Gateway, workspace, channels, skills, and health setup.
- `openclaw setup --baseline` creates the baseline config and workspace without walking the guided onboarding flow.
- `openclaw configure` changes targeted parts of an existing setup: model auth, gateway, channels, plugins, or skills.
- `openclaw channels add` configures channel accounts after the baseline exists; run without flags for guided setup, or with channel-specific flags for scripts.

## Command pages

| Area                         | Commands                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and onboarding         | [`crestodian`](/cli/crestodian) · [`setup`](/cli/setup) · [`onboard`](/cli/onboard) · [`configure`](/cli/configure) · [`config`](/cli/config) · [`completion`](/cli/completion) · [`doctor`](/cli/doctor) · [`dashboard`](/cli/dashboard) |
| Reset, backup, and migration | [`backup`](/cli/backup) · [`migrate`](/cli/migrate) · [`reset`](/cli/reset) · [`uninstall`](/cli/uninstall) · [`update`](/cli/update)                                                                                                     |
| Messaging and agents         | [`message`](/cli/message) · [`agent`](/cli/agent) · [`agents`](/cli/agents) · [`attach`](/cli/attach) · [`acp`](/cli/acp) · [`mcp`](/cli/mcp)                                                                                             |
| Health and sessions          | [`status`](/cli/status) · [`health`](/cli/health) · [`sessions`](/cli/sessions) · [`audit`](/cli/audit)                                                                                                                                   |
| Gateway and logs             | [`gateway`](/cli/gateway) · [`logs`](/cli/logs) · [`system`](/cli/system)                                                                                                                                                                 |
| Models and inference         | [`models`](/cli/models) · [`promos`](/cli/promos) · [`infer`](/cli/infer) · `capability` (alias for [`infer`](/cli/infer)) · [`memory`](/cli/memory) · [`commitments`](/cli/commitments) · [`wiki`](/cli/wiki)                            |
| Network and nodes            | [`directory`](/cli/directory) · [`nodes`](/cli/nodes) · [`devices`](/cli/devices) · [`node`](/cli/node)                                                                                                                                   |
| Runtime and sandbox          | [`approvals`](/cli/approvals) · `exec-policy` (see [`approvals`](/cli/approvals)) · [`sandbox`](/cli/sandbox) · [`tui`](/cli/tui) · `chat`/`terminal` (aliases for [`tui --local`](/cli/tui)) · [`browser`](/cli/browser)                 |
| Automation                   | [`cron`](/cli/cron) · [`tasks`](/cli/tasks) · [`hooks`](/cli/hooks) · [`webhooks`](/cli/webhooks) · [`transcripts`](/cli/transcripts)                                                                                                     |
| Discovery and docs           | [`dns`](/cli/dns) · [`docs`](/cli/docs)                                                                                                                                                                                                   |
| Pairing and channels         | [`pairing`](/cli/pairing) · [`qr`](/cli/qr) · [`channels`](/cli/channels)                                                                                                                                                                 |
| Security and plugins         | [`security`](/cli/security) · [`secrets`](/cli/secrets) · [`skills`](/cli/skills) · [`plugins`](/cli/plugins) · [`proxy`](/cli/proxy)                                                                                                     |
| Legacy aliases               | [`daemon`](/cli/daemon) (gateway service) · [`clawbot`](/cli/clawbot) (namespace)                                                                                                                                                         |
| Plugins (optional)           | [`path`](/cli/path) · [`policy`](/cli/policy) · [`voicecall`](/cli/voicecall) · [`workboard`](/cli/workboard) (if installed)                                                                                                              |

## Global flags

| Flag                    | Purpose                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `--dev`                 | Isolate state under `~/.openclaw-dev`, default gateway port 19001, and shift derived ports              |
| `--profile <name>`      | Isolate state under `~/.openclaw-<name>` (`OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH`)                  |
| `--container <name>`    | Run the CLI inside a running Podman/Docker container named `<name>` (default: env `OPENCLAW_CONTAINER`) |
| `--log-level <level>`   | Override the global log level for file + console output                                                 |
| `--no-color`            | Disable ANSI colors (`NO_COLOR=1` is also respected)                                                    |
| `--update`              | Shorthand for [`openclaw update`](/cli/update); works for both source checkouts and package installs    |
| `-V`, `--version`, `-v` | Print version and exit                                                                                  |

## Output modes

- ANSI colors and progress indicators render only in TTY sessions.
- OSC-8 hyperlinks render as clickable links where supported; otherwise the
  CLI falls back to plain URLs.
- `--json` (and `--plain` where supported) disables styling for clean output.
- Long-running commands show a progress indicator (OSC 9;4 when supported).

## Color palette

OpenClaw uses a lobster palette for CLI output:

| Token          | Hex       | Used for                             |
| -------------- | --------- | ------------------------------------ |
| `accent`       | `#FF5A2D` | Headings, labels, primary highlights |
| `accentBright` | `#FF7A3D` | Command names, emphasis              |
| `accentDim`    | `#D14A22` | Secondary highlight text             |
| `info`         | `#FF8A5B` | Informational values                 |
| `success`      | `#2FBF71` | Success states                       |
| `warn`         | `#FFB020` | Warnings, option flags, fallbacks    |
| `error`        | `#E23D2D` | Errors, failures                     |
| `muted`        | `#8B7F77` | De-emphasis, metadata                |

Palette source of truth: `packages/terminal-core/src/palette.ts`.

## Command tree

<Accordion title="Full command tree">

This map covers core commands and their primary subcommands. Plugin-added
subcommands (for example under `skills`, `plugins`, and `wiki`) evolve
independently; run `<command> --help` for the authoritative, current list.

```
openclaw [--dev] [--profile <name>] <command>
  crestodian
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
  migrate
    list
    plan <provider>
    apply <provider>
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
    repair
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
    verify
    workshop list|inspect|propose-create|propose-update|revise|apply|reject|quarantine
    list
    info
    check
  plugins
    list
    search
    inspect
    install
    uninstall
    update
    enable
    disable
    doctor
    build
    validate
    init
    registry
    marketplace list|entries|refresh
  workboard
    list
    create
    show
    dispatch
  memory
    status
    index
    search
  transcripts
    list
    show
    path
  path
    resolve
    find
    set
    validate
    emit
  commitments
    list
    dismiss
  wiki
    status
    doctor
    init
    compile
    lint
    ingest
    okf import
    search
    get
    apply synthesis|metadata
    bridge import
    unsafe-local import
    chatgpt import|rollback
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
  attach
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
  audit
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
    stability
    diagnostics export
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
    auth list|add|login|setup-token|paste-token|paste-api-key|login-github-copilot
    auth order get|set|clear
  promos
    list
    claim <slug>
  infer (alias: capability)
    list
    inspect
    model run|list|inspect|providers|auth login|logout|status
    image generate|edit|describe|describe-many|providers
    audio transcribe|providers
    tts convert|voices|personas|providers|status|enable|disable|set-provider|set-persona
    video generate|describe|providers
    web search|fetch|providers
    embedding create|providers
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    get
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
  exec-policy
    show
    preset
    set
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
  proxy
    start
    run
    coverage
    sessions
    query
    blob
    purge
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
  chat (alias: tui --local)
  terminal (alias: tui --local)
```

Plugins can add additional top-level commands, such as
[`openclaw workboard`](/cli/workboard) or `openclaw voicecall`.

</Accordion>

## Chat slash commands

Chat messages support `/...` commands. See [slash commands](/tools/slash-commands).

Highlights:

- `/status` - quick diagnostics.
- `/trace` - session-scoped plugin trace/debug lines.
- `/config` - persisted config changes.
- `/debug` - runtime-only config overrides (memory, not disk; requires `commands.debug: true`).

## Usage tracking

`openclaw status --usage` and the Control UI surface provider usage/quota when
OAuth/API credentials are available. Data comes directly from provider usage
endpoints and is normalized to `X% left`. Providers with current usage
windows: Anthropic, Gemini CLI, GitHub Copilot, MiniMax, OpenAI Codex,
Xiaomi, and z.ai.

See [Usage tracking](/concepts/usage-tracking) for details.

## Related

- [Slash commands](/tools/slash-commands)
- [Configuration](/gateway/configuration)
- [Environment](/help/environment)
