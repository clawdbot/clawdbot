---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
title: "Slash commands"
---

Commands are handled by the Gateway. Most commands must be sent as a **standalone** message that starts with `/`.
The host-only bash chat command uses `! <cmd>` (with `/bash <cmd>` as an alias).

There are two related systems:

- **Commands**: standalone `/...` messages.
- **Directives**: `/think`, `/fast`, `/verbose`, `/trace`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Directives are stripped from the message before the model sees it.
  - In normal chat messages (not directive-only), they are treated as “inline hints” and do **not** persist session settings.
  - In directive-only messages (the message contains only directives), they persist to the session and reply with an acknowledgement.
  - Directives are only applied for **authorized senders**. If `commands.allowFrom` is set, it is the only
    allowlist used; otherwise authorization comes from channel allowlists/pairing plus `commands.useAccessGroups`.
    Unauthorized senders see directives treated as plain text.

There are also a few **inline shortcuts** (allowlisted/authorized senders only): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.

## Config

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    mcp: false,
    plugins: false,
    debug: false,
    restart: true,
    ownerAllowFrom: ["discord:123456789012345678"],
    ownerDisplay: "raw",
    ownerDisplaySecret: "${OWNER_ID_HASH_SECRET}",
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text` (default `true`) enables parsing `/...` in chat messages.
  - On surfaces without native commands (WhatsApp/WebChat/Signal/iMessage/Google Chat/Microsoft Teams), text commands still work even if you set this to `false`.
- `commands.native` (default `"auto"`) registers native commands.
  - Auto: on for Discord/Telegram; off for Slack (until you add slash commands); ignored for providers without native support.
  - Set `channels.discord.commands.native`, `channels.telegram.commands.native`, or `channels.slack.commands.native` to override per provider (bool or `"auto"`).
  - `false` clears previously registered commands on Discord/Telegram at startup. Slack commands are managed in the Slack app and are not removed automatically.
- `commands.nativeSkills` (default `"auto"`) registers **skill** commands natively when supported.
  - Auto: on for Discord/Telegram; off for Slack (Slack requires creating a slash command per skill).
  - Set `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, or `channels.slack.commands.nativeSkills` to override per provider (bool or `"auto"`).
- `commands.bash` (default `false`) enables `! <cmd>` to run host shell commands (`/bash <cmd>` is an alias; requires `tools.elevated` allowlists).
- `commands.bashForegroundMs` (default `2000`) controls how long bash waits before switching to background mode (`0` backgrounds immediately).
- `commands.config` (default `false`) enables `/config` (reads/writes `openclaw.json`).
- `commands.mcp` (default `false`) enables `/mcp` (reads/writes OpenClaw-managed MCP config under `mcp.servers`).
- `commands.plugins` (default `false`) enables `/plugins` (plugin discovery/status plus install + enable/disable controls).
- `commands.debug` (default `false`) enables `/debug` (runtime-only overrides).
- `commands.restart` (default `true`) enables `/restart` plus gateway restart tool actions.
- `commands.ownerAllowFrom` (optional) sets the explicit owner allowlist for owner-only command/tool surfaces. This is separate from `commands.allowFrom`.
- Per-channel `channels.<channel>.commands.enforceOwnerForCommands` (optional, default `false`) makes owner-only commands require **owner identity** to run on that surface. When `true`, the sender must either match a resolved owner candidate (for example an entry in `commands.ownerAllowFrom` or provider-native owner metadata) or hold internal `operator.admin` scope on an internal message channel. A wildcard entry in channel `allowFrom`, or an empty/unresolved owner-candidate list, is **not** sufficient — owner-only commands fail closed on that channel. Leave this off if you want owner-only commands gated only by `ownerAllowFrom` and the standard command allowlists.
- `commands.ownerDisplay` controls how owner ids appear in the system prompt: `raw` or `hash`.
- `commands.ownerDisplaySecret` optionally sets the HMAC secret used when `commands.ownerDisplay="hash"`.
- `commands.allowFrom` (optional) sets a per-provider allowlist for command authorization. When configured, it is the
  only authorization source for commands and directives (channel allowlists/pairing and `commands.useAccessGroups`
  are ignored). Use `"*"` for a global default; provider-specific keys override it.
- `commands.useAccessGroups` (default `true`) enforces allowlists/policies for commands when `commands.allowFrom` is not set.

## Command list

Current source-of-truth:

- core built-ins come from `src/auto-reply/commands-registry.shared.ts`
- generated dock commands come from `src/auto-reply/commands-registry.data.ts`
- plugin commands come from plugin `registerCommand()` calls
- actual availability on your gateway still depends on config flags, channel surface, and installed/enabled plugins

### Core built-in commands

Built-in commands available today:

- `/new [model]` starts a new session; `/reset` is the reset alias.
- `/reset soft [message]` keeps the current transcript, drops reused CLI backend session ids, and reruns startup/system-prompt loading in-place.
- `/compact [instructions]` compacts the session context. See [/concepts/compaction](/concepts/compaction).
- `/stop` aborts the current run.
- `/session idle <duration|off>` and `/session max-age <duration|off>` manage thread-binding expiry.
- `/think <level>` sets the thinking level. Options come from the active model's provider profile; common levels are `off`, `minimal`, `low`, `medium`, and `high`, with custom levels such as `xhigh`, `adaptive`, `max`, or binary `on` only where supported. Aliases: `/thinking`, `/t`.
- `/verbose on|off|full` toggles verbose output. Alias: `/v`.
- `/trace on|off` toggles plugin trace output for the current session.
- `/fast [status|on|off]` shows or sets fast mode.
- `/reasoning [on|off|stream]` toggles reasoning visibility. Alias: `/reason`.
- `/elevated [on|off|ask|full]` toggles elevated mode. Alias: `/elev`.
- `/exec host=<auto|sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` shows or sets exec defaults.
- `/model [name|#|status]` shows or sets the model.
- `/models [provider] [page] [limit=<n>|size=<n>|all]` lists providers or models for a provider.
- `/queue <mode>` manages queue behavior (`steer`, `interrupt`, `followup`, `collect`, `steer-backlog`) plus options like `debounce:2s cap:25 drop:summarize`.
- `/help` shows the short help summary.
- `/commands` shows the generated command catalog.
- `/tools [compact|verbose]` shows what the current agent can use right now.
- `/status` shows runtime status, including `Runtime`/`Runner` labels and provider usage/quota when available.
- `/tasks` lists active/recent background tasks for the current session.
- `/context [list|detail|json]` explains how context is assembled.
- `/export-session [path]` exports the current session to HTML. Alias: `/export`.
- `/export-trajectory [path]` exports a JSONL [trajectory bundle](/tools/trajectory) for the current session. Alias: `/trajectory`.
- `/whoami` shows your sender id. Alias: `/id`.
- `/skill <name> [input]` runs a skill by name.
- `/allowlist [list|add|remove] ...` manages allowlist entries. Text-only.
- `/approve <id> <decision>` resolves exec approval prompts.
- `/btw <question>` asks a side question without changing future session context. See [/tools/btw](/tools/btw).
- `/subagents list|kill|log|info|send|steer|spawn` manages sub-agent runs for the current session.
- `/acp spawn|cancel|steer|close|sessions|status|set-mode|set|cwd|permissions|timeout|model|reset-options|doctor|install|help` manages ACP sessions and runtime options.
- `/focus <target>` binds the current Discord thread or Telegram topic/conversation to a session target.
- `/unfocus` removes the current binding.
- `/agents` lists thread-bound agents for the current session.
- `/kill <id|#|all>` aborts one or all running sub-agents.
- `/steer <id|#> <message>` sends steering to a running sub-agent. Alias: `/tell`.
- `/config show|get|set|unset` reads or writes `openclaw.json`. Owner-only. Requires `commands.config: true`.
- `/mcp show|get|set|unset` reads or writes OpenClaw-managed MCP server config under `mcp.servers`. Owner-only. Requires `commands.mcp: true`.
- `/plugins list|inspect|show|get|install|enable|disable` inspects or mutates plugin state. `/plugin` is an alias. Owner-only for writes. Requires `commands.plugins: true`.
- `/debug show|set|unset|reset` manages runtime-only config overrides. Owner-only. Requires `commands.debug: true`.
- `/usage off|tokens|full|cost` controls the per-response usage footer or prints a local cost summary.
- `/tts on|off|status|provider|limit|summary|audio|help` controls TTS. See [/tools/tts](/tools/tts).
- `/restart` restarts OpenClaw when enabled. Default: enabled; set `commands.restart: false` to disable it.
- `/activation mention|always` sets group activation mode.
- `/send on|off|inherit` sets send policy. Owner-only.
- `/bash <command>` runs a host shell command. Text-only. Alias: `! <command>`. Requires `commands.bash: true` plus `tools.elevated` allowlists.
- `!poll [sessionId]` checks a background bash job.
- `!stop [sessionId]` stops a background bash job.

### Generated dock commands

Dock commands are generated from channel plugins with native-command support. Current bundled set:

- `/dock-discord` (alias: `/dock_discord`)
- `/dock-mattermost` (alias: `/dock_mattermost`)
- `/dock-slack` (alias: `/dock_slack`)
- `/dock-telegram` (alias: `/dock_telegram`)

### Bundled plugin commands

Bundled plugins can add more slash commands. Current bundled commands in this repo:

- `/dreaming [on|off|status|help]` toggles memory dreaming. See [Dreaming](/concepts/dreaming).
- `/pair [qr|status|pending|approve|cleanup|notify]` manages device pairing/setup flow. See [Pairing](/channels/pairing).
- `/phone status|arm <camera|screen|writes|all> [duration]|disarm` temporarily arms high-risk phone node commands.
- `/voice status|list [limit]|set <voiceId|name>` manages Talk voice config. On Discord, the native command name is `/talkvoice`.
- `/card ...` sends LINE rich card presets. See [LINE](/channels/line).
- `/codex status|models|threads|resume|compact|review|account|mcp|skills` inspects and controls the bundled Codex app-server harness. See [Codex Harness](/plugins/codex-harness).
- QQBot-only commands:
  - `/bot-ping`
  - `/bot-version`
  - `/bot-help`
  - `/bot-upgrade`
  - `/bot-logs`

### Dynamic skill commands

User-invocable skills are also exposed as slash commands:

- `/skill <name> [input]` always works as the generic entrypoint.
- skills may also appear as direct commands like `/prose` when the skill/plugin registers them.
- native skill-command registration is controlled by `commands.nativeSkills` and `channels.<provider>.commands.nativeSkills`.

Notes:

- Commands accept an optional `:` between the command and args (e.g. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` accepts a model alias, `provider/model`, or a provider name (fuzzy match); if no match, the text is treated as the message body.
- For full provider usage breakdown, use `openclaw status --usage`.
- `/allowlist add|remove` requires `commands.config=true` and honors channel `configWrites`.
- In multi-account channels, config-targeted `/allowlist --account <id>` and `/config set channels.<provider>.accounts.<id>...` also honor the target account's `configWrites`.
- `/usage` controls the per-response usage footer; `/usage cost` prints a local cost summary from OpenClaw session logs.
- `/restart` is enabled by default; set `commands.restart: false` to disable it.
- `/plugins install <spec>` accepts the same plugin specs as `openclaw plugins install`: local path/archive, npm package, or `clawhub:<pkg>`.
- `/plugins enable|disable` updates plugin config and may prompt for a restart.
- Discord-only native command: `/vc join|leave|status` controls voice channels (requires `channels.discord.voice` and native commands; not available as text).
- Discord thread-binding commands (`/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`) require effective thread bindings to be enabled (`session.threadBindings.enabled` and/or `channels.discord.threadBindings.enabled`).
- ACP command reference and runtime behavior: [ACP Agents](/tools/acp-agents).
- `/verbose` is meant for debugging and extra visibility; keep it **off** in normal use.
- `/trace` is narrower than `/verbose`: it only reveals plugin-owned trace/debug lines and keeps normal verbose tool chatter off.
- `/fast on|off` persists a session override. Use the Sessions UI `inherit` option to clear it and fall back to config defaults.
- `/fast` is provider-specific: OpenAI/OpenAI Codex map it to `service_tier=priority` on native Responses endpoints, while direct public Anthropic requests, including OAuth-authenticated traffic sent to `api.anthropic.com`, map it to `service_tier=auto` or `standard_only`. See [OpenAI](/providers/openai) and [Anthropic](/providers/anthropic).
- Tool failure summaries are still shown when relevant, but detailed failure text is only included when `/verbose` is `on` or `full`.
- `/reasoning`, `/verbose`, and `/trace` are risky in group settings: they may reveal internal reasoning, tool output, or plugin diagnostics you did not intend to expose. Prefer leaving them off, especially in group chats.
- `/model` persists the new session model immediately.
- If the agent is idle, the next run uses it right away.
- If a run is already active, OpenClaw marks a live switch as pending and only restarts into the new model at a clean retry point.
- If tool activity or reply output has already started, the pending switch can stay queued until a later retry opportunity or the next user turn.
- **Fast path:** command-only messages from allowlisted senders are handled immediately (bypass queue + model).
- **Group mention gating:** command-only messages from allowlisted senders bypass mention requirements.
- **Inline shortcuts (allowlisted senders only):** certain commands also work when embedded in a normal message and are stripped before the model sees the remaining text.
  - Example: `hey /status` triggers a status reply, and the remaining text continues through the normal flow.
- Currently: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Unauthorized command-only messages are silently ignored, and inline `/...` tokens are treated as plain text.
- **Skill commands:** `user-invocable` skills are exposed as slash commands. Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes (e.g. `_2`).
  - `/skill <name> [input]` runs a skill by name (useful when native command limits prevent per-skill commands).
  - By default, skill commands are forwarded to the model as a normal request.
  - Skills may optionally declare `command-dispatch: tool` to route the command directly to a tool (deterministic, no model).
  - Example: `/prose` (OpenProse plugin) — see [OpenProse](/prose).
- **Native command arguments:** Discord uses autocomplete for dynamic options (and button menus when you omit required args). Telegram and Slack show a button menu when a command supports choices and you omit the arg.

## `/tools`

`/tools` answers a runtime question, not a config question: **what this agent can use right now in
this conversation**.

- Default `/tools` is compact and optimized for quick scanning.
- `/tools verbose` adds short descriptions.
- Native-command surfaces that support arguments expose the same mode switch as `compact|verbose`.
- Results are session-scoped, so changing agent, channel, thread, sender authorization, or model can
  change the output.
- `/tools` includes tools that are actually reachable at runtime, including core tools, connected
  plugin tools, and channel-owned tools.

For profile and override editing, use the Control UI Tools panel or config/catalog surfaces instead
of treating `/tools` as a static catalog.

## Usage surfaces (what shows where)

- **Provider usage/quota** (example: “Claude 80% left”) shows up in `/status` for the current model provider when usage tracking is enabled. OpenClaw normalizes provider windows to `% left`; for MiniMax, remaining-only percent fields are inverted before display, and `model_remains` responses prefer the chat-model entry plus a model-tagged plan label.
- **Token/cache lines** in `/status` can fall back to the latest transcript usage entry when the live session snapshot is sparse. Existing nonzero live values still win, and transcript fallback can also recover the active runtime model label plus a larger prompt-oriented total when stored totals are missing or smaller.
- **Runtime vs runner:** `/status` reports `Runtime` for the effective execution path and sandbox state, and `Runner` for who is actually running the session: embedded Pi, a CLI-backed provider, or an ACP harness/backend.
- **Per-response tokens/cost** is controlled by `/usage off|tokens|full` (appended to normal replies).
- `/model status` is about **models/auth/endpoints**, not usage.

## Model selection (`/model`)

`/model` is implemented as a directive.

Examples:

```
/model
/model list
/model 3
/model openai/gpt-5.4
/model opus@anthropic:default
/model status
```

Notes:

- `/model` and `/model list` show a compact, numbered picker (model family + available providers).
- On Discord, `/model` and `/models` open an interactive picker with provider and model dropdowns plus a Submit step.
- `/model <#>` selects from that picker (and prefers the current provider when possible).
- `/model status` shows the detailed view, including configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

## Debug overrides

`/debug` lets you set **runtime-only** config overrides (memory, not disk). Owner-only. Disabled by default; enable with `commands.debug: true`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:

- Overrides apply immediately to new config reads, but do **not** write to `openclaw.json`.
- Use `/debug reset` to clear all overrides and return to the on-disk config.

## Plugin trace output

`/trace` lets you toggle **session-scoped plugin trace/debug lines** without turning on full verbose mode.

Examples:

```text
/trace
/trace on
/trace off
```

Notes:

- `/trace` with no argument shows the current session trace state.
- `/trace on` enables plugin trace lines for the current session.
- `/trace off` disables them again.
- Plugin trace lines can appear in `/status` and as a follow-up diagnostic message after the normal assistant reply.
- `/trace` does not replace `/debug`; `/debug` still manages runtime-only config overrides.
- `/trace` does not replace `/verbose`; normal verbose tool/status output still belongs to `/verbose`.

## Config updates

`/config` writes to your on-disk config (`openclaw.json`). Owner-only. Disabled by default; enable with `commands.config: true`.

Examples:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notes:

- Config is validated before write; invalid changes are rejected.
- `/config` updates persist across restarts.

## MCP updates

`/mcp` writes OpenClaw-managed MCP server definitions under `mcp.servers`. Owner-only. Disabled by default; enable with `commands.mcp: true`.

Examples:

```text
/mcp show
/mcp show context7
/mcp set context7={"command":"uvx","args":["context7-mcp"]}
/mcp unset context7
```

Notes:

- `/mcp` stores config in OpenClaw config, not Pi-owned project settings.
- Runtime adapters decide which transports are actually executable.

## Plugin updates

`/plugins` lets operators inspect discovered plugins and toggle enablement in config. Read-only flows can use `/plugin` as an alias. Disabled by default; enable with `commands.plugins: true`.

Examples:

```text
/plugins
/plugins list
/plugin show context7
/plugins enable context7
/plugins disable context7
```

Notes:

- `/plugins list` and `/plugins show` use real plugin discovery against the current workspace plus on-disk config.
- `/plugins enable|disable` updates plugin config only; it does not install or uninstall plugins.
- After enable/disable changes, restart the gateway to apply them.

## Surface notes

- **Text commands** run in the normal chat session (DMs share `main`, groups have their own session).
- **Native commands** use isolated sessions:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefix configurable via `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (targets the chat session via `CommandTargetSessionKey`)
- **`/stop`** targets the active chat session so it can abort the current run.
- **Slack:** `channels.slack.slashCommand` is still supported for a single `/openclaw`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`). Command argument menus for Slack are delivered as ephemeral Block Kit buttons.
  - Slack native exception: register `/agentstatus` (not `/status`) because Slack reserves `/status`. Text `/status` still works in Slack messages.

## BTW side questions

`/btw` is a quick **side question** about the current session.

Unlike normal chat:

- it uses the current session as background context,
- it runs as a separate **tool-less** one-shot call,
- it does not change future session context,
- it is not written to transcript history,
- it is delivered as a live side result instead of a normal assistant message.

That makes `/btw` useful when you want a temporary clarification while the main
task keeps going.

Example:

```text
/btw what are we doing right now?
```

See [BTW Side Questions](/tools/btw) for the full behavior and client UX
details.

## Related

- [Skills](/tools/skills)
- [Skills config](/tools/skills-config)
- [Creating skills](/tools/creating-skills)
