---
title: "Slash commands"
sidebarTitle: "Slash commands"
summary: "All available slash commands, directives, and inline shortcuts — configuration, routing, and per-surface behavior."
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
  - Understanding how skill commands are registered
---

The Gateway handles commands sent as standalone messages starting with `/`.
Host-only bash commands use `! <cmd>` (with `/bash <cmd>` as an alias).

When a conversation is bound to an ACP session, normal text routes to the ACP
harness. Gateway management commands remain local: `/acp ...` always reaches
the OpenClaw command handler, and `/status` plus `/session` stay local whenever
command handling is enabled for the surface.

## Three command types

<CardGroup cols={3}>
  <Card title="Commands" icon="terminal">
    Standalone `/...` messages handled by the Gateway. Must be sent as the
    only content in the message.
  </Card>
  <Card title="Directives" icon="sliders">
    `/think`, `/fast`, `/verbose`, `/trace`, `/reasoning`, `/elevated`,
    `/exec`, `/model`, `/queue` — stripped from the message before the model
    sees it. Most persist session settings when sent alone; `/exec` security
    and approval options apply only to their message.
  </Card>
  <Card title="Inline shortcuts" icon="bolt">
    `/help`, `/commands`, `/status`, `/whoami` — run immediately and are
    stripped before the model sees the remaining text. Authorized senders only.
  </Card>
</CardGroup>

<AccordionGroup>
  <Accordion title="Directive behavior details">
    - Directives are stripped from the message before the model sees it.
      Removal leaves the remaining text's spacing and line endings intact,
      including code indentation. Only the recognized directive, its arguments,
      and an adjacent separator (or its own line ending when alone on a line)
      are removed. Text with no recognized directive is unchanged.
      Added prompt context is not scanned for text commands or stripped as directives.
    - In **directive-only** messages (the message is only directives), they
      persist to the session and reply with an acknowledgement.
      `/exec security=... ask=...` is the exception: these options apply only
      to the current message and never change later turns. Include them with
      the task; use [session permission modes](/gateway/permission-modes) for
      session-wide policy. `/exec host=... node=...` still persists placement.
    - In **normal chat** messages with other text, they act as inline hints and
      do **not** persist session settings.
      Model selection is the exception: an authorized inline `/model` or
      configured `/<alias>` persists the session selection. Owner/admin `-a`
      and `-g` scopes also request an update for the selected default.
    - Directives only apply for **authorized senders**. If `commands.allowFrom`
      is set, it is the only allowlist used; otherwise authorization comes from
      channel allowlists, pairing, and always-on access-group enforcement. Unauthorized
      senders see directives treated as plain text.
  </Accordion>
</AccordionGroup>

## Configuration

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
    restart: true, // enables /restart and /update
    ownerAllowFrom: ["discord:123456789012345678"],
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
  },
}
```

<ParamField path="commands.text" type="boolean" default="true">
  Enables parsing `/...` in chat messages. On surfaces without native commands
  (WhatsApp, WebChat, Signal, iMessage, Google Chat, Microsoft Teams), text
  commands work even when set to `false`.
</ParamField>

<ParamField path="commands.native" type='boolean | "auto"' default='"auto"'>
  Registers native commands. Auto: on for Discord/Telegram; off for Slack;
  ignored for providers without native support. Override per-channel with
  `channels.<provider>.commands.native`. On Discord, `false` skips slash-command
  registration; previously registered commands may stay visible until removed.
</ParamField>

<ParamField path="commands.nativeSkills" type='boolean | "auto"' default='"auto"'>
  Registers skill commands natively when supported. Auto: on for
  Discord/Telegram; off for Slack. Override with
  `channels.<provider>.commands.nativeSkills`.
</ParamField>

<ParamField path="commands.bash" type="boolean" default="false">
  Enables `! <cmd>` to run host shell commands (`/bash <cmd>` alias). Requires
  `tools.elevated` allowlists.
</ParamField>

<ParamField path="commands.bashForegroundMs" type="number" default="2000">
  How long bash waits before switching to background mode (`0` backgrounds
  immediately).
</ParamField>

<ParamField path="commands.config" type="boolean" default="false">
  Enables `/config` (reads/writes `openclaw.json`). Owner-only.
</ParamField>

<ParamField path="commands.mcp" type="boolean" default="false">
  Enables `/mcp` (reads/writes OpenClaw-managed MCP config under `mcp.servers`). Owner-only.
</ParamField>

<ParamField path="commands.plugins" type="boolean" default="false">
  Enables `/plugins` (plugin discovery/status plus install + enable/disable). Owner-only for writes.
</ParamField>

<ParamField path="commands.debug" type="boolean" default="false">
  Enables `/debug` (runtime-only config overrides). Owner-only.
</ParamField>

<ParamField path="commands.restart" type="boolean" default="true">
  Enables `/restart`, `/update`, and external `SIGUSR1` restart requests.
</ParamField>

<ParamField path="commands.ownerAllowFrom" type="string[]">
  Explicit owner allowlist for owner-only command surfaces. Separate from
  `commands.allowFrom` and DM pairing access. CLI pairing approval records the
  first owner; Control UI pairing has an explicit owner checkbox. Authorized
  non-owners receive a refusal with the exact configuration command for their
  sender ID when using an owner-only command such as `/restart` or `/update`.
  Use `channel:id` (for example, `discord:123456789012345678`). If an upgrade
  leaves a legacy `channel:user:id` owner entry, run `openclaw doctor --fix`;
  Doctor rewrites recognized channel entries and reports their list positions.
</ParamField>

Channel plugins can enforce owner-only command access through their
`enforceOwnerForCommands` policy. This is plugin behavior, not an
`openclaw.json` setting. A wildcard command allowlist does not bypass it.

<ParamField path="commands.allowFrom" type="object">
  Per-provider allowlist for command authorization. When configured, it is the
  **only** authorization source for commands and directives. Use `"*"` for a
  global default; provider-specific keys override it.
</ParamField>

When `commands.allowFrom` is not configured, command authorization follows
the channel's allowlists and pairing state. Access-group entries referenced by
channel allowlists are resolved automatically; there is no command-level
access-group toggle.

Session commands `/new` and `/reset` (including `/reset soft`) remain available
to channel-authorized senders on channels that do not enforce owner-only
commands, even when those senders are not in `commands.ownerAllowFrom`.
An applicable `commands.allowFrom` policy remains authoritative: a denied
sender or an explicitly empty list cannot fall back to channel admission.
Reset access does not grant other command or owner-only authority. Internal
Gateway callers with explicit scopes still need `operator.admin` to reset.
When both the request and reply stay in WebChat, rejected `/new` and `/reset`
commands show a permission denial. A denied command does not perform the
requested reset or run its follow-up text; normal idle/daily rollover still
applies. Ask your Gateway administrator to reset the session, or send your
message without the command.

## Command list

Commands come from three sources:

- **Core built-ins:** `src/auto-reply/commands-registry.shared.ts`
- **Plugin commands:** plugin `registerCommand()` calls

Availability depends on config flags, channel surface, and installed/enabled
plugins.

### Core commands

<AccordionGroup>
  <Accordion title="Sessions and runs">
    | Command | Description |
    | --- | --- |
    | `/new [model]` | Archive the current session and start a fresh one |
    | `/reset [soft [message]]` | Reset the current session in place. `soft` keeps the transcript, drops reused CLI backend session ids, and reruns startup |
    | `/name <title>` | Name or rename the current session. Omit the title to see the current name and a suggestion |
    | `/compact [instructions]` | Compact the session context. See [Compaction](/concepts/compaction) |
    | `/stop` | Abort the current run |
    | `/session idle <duration\|off>` | Manage thread-binding idle expiry |
    | `/session max-age <duration\|off>` | Manage thread-binding max-age expiry |
    | `/export-session [path]` | Owner-only. Export the current session to HTML inside the workspace. Alias: `/export` |
    | `/export-trajectory [path]` | Export a JSONL trajectory bundle for the current session. Alias: `/trajectory` |

    Explicit `/export-session` paths replace existing files inside the
    workspace. Omit the path to generate a collision-safe filename.

    HTML conversation cards omit messages marked hidden. The sidebar's **All**
    filter includes these records with a **[hidden]** label for debugging.
    Message counts describe the raw archive. The HTML file and its JSONL download
    still contain hidden records; hiding a message does not redact the export.

    <Note>
      Control UI intercepts typed `/new` to create and switch to a fresh
      dashboard session, except when `session.dmScope: "main"` is configured
      and the current parent is the agent's main session — in that case `/new`
      resets the main session in place. Typed `/reset` still runs the Gateway's
      in-place reset. Use `/model default` when you want to clear a pinned
      session model selection.
    </Note>

  </Accordion>

  <Accordion title="Model and run controls">
    | Command | Description |
    | --- | --- |
    | `/think <level\|default>` | Set the thinking level or clear the session override. Aliases: `/thinking`, `/t` |
    | `/verbose on\|off\|full` | Toggle verbose output. Alias: `/v` |
    | `/trace on\|off` | Toggle plugin trace output for the current session |
    | `/fast [status\|auto\|on\|off\|default]` | Show, set, or clear fast mode |
    | `/reasoning [on\|off\|stream]` | Toggle reasoning visibility. Alias: `/reason` |
    | `/elevated [on\|off\|ask\|full]` | Toggle elevated mode. Alias: `/elev` |
    | `/exec host=<auto\|sandbox\|gateway\|node> security=<deny\|allowlist\|full> ask=<off\|on-miss\|always> node=<id>` | Show resolved exec defaults; persist host/node placement, apply security/ask to this message only. See [Session permission modes](/gateway/permission-modes) |
    | `/login [codex\|openai]` | Pair a Codex or OpenAI login from a private chat or Web UI session. Owner/admin only |
    | `/model [name\|default\|list\|status] [-s\|--session\|-a\|--agent\|-g\|--global]` | Show or select a model. `-s` changes only this session; owner/admin `-a` and `-g` also update configured defaults |
    | `/models [provider] [page] [limit=<n>\|all]` | List configured/auth-available providers or models |
    | `/queue <mode>` | Manage active-run queue behavior. See [Queue](/concepts/queue) and [Queue steering](/concepts/queue-steering) |
    | `/steer <message>` | Inject guidance into the active run. Alias: `/tell`. See [Steer](/tools/steer) |

    <AccordionGroup>
      <Accordion title="verbose / trace / fast / reasoning safety">
        - `/verbose` is for debugging — keep it **off** in normal use.
        - `/trace` reveals only plugin-owned trace/debug lines; normal verbose chatter stays off.
        - `/fast auto|on|off` persists a session override; use the Sessions UI `inherit` option to clear it.
        - `/fast` is provider-specific: OpenAI/Codex map it to `service_tier=priority`; direct Anthropic requests map it to `service_tier=auto` or `standard_only`.
        - `/reasoning`, `/verbose`, and `/trace` are risky in group settings — they may reveal internal reasoning or plugin diagnostics. Keep them off in group chats.

      </Accordion>
      <Accordion title="Model switching details">
        - Prefer choosing the model when creating a session. Changing it in an established session is an advanced operation because model context limits, prompt/tool behavior, and prompt-cache behavior can differ. See [Choose a model for a session](/concepts/models#choose-a-model-for-a-session).

        **Scope in one line:** `-s` changes only this session, `-a` also updates the agent default, and `-g` also updates the shared global default. Without a flag, `agents.defaults.modelSelectionScope` applies when set; omission changes only this session.

        Configured `/<alias>` shorthands accept the same trailing scope and `--runtime` options as `/model <alias>`.

        | Goal | Command | Effect |
        | --- | --- | --- |
        | Change only this session | `/model <model> -s` (or `--session`) | Changes this session. Configured defaults remain unchanged |
        | Update the agent default | `/model <model> -a` (or `--agent`) | Changes this session and requests an update for the selected agent |
        | Update the global default | `/model <model> -g` (or `--global`) | Changes this session and requests an update for `agents.defaults.model` |
        | Use the configured default again | `/model default -s` | Clears this session's model selection without writing defaults; compatible auth pins remain and incompatible pins clear |

        With `modelSelectionScope` unset, `/model <model>` changes only the current session, including for owners/admins. Without owner/admin authority, bare commands remain session-only and explicit `-a` and `-g` requests are rejected. Selecting the effective configured default clears the session model pin, but agent/global scope still requests the configured-default write. Immutable configuration stays unchanged. Asynchronous write errors do not revert the session selection.

        - If the agent is idle, the next run uses it right away.
        - If a run is active, the switch is marked pending and applied at the next clean retry point.

      </Accordion>
    </AccordionGroup>

  </Accordion>

  <Accordion title="Discovery and status">
    | Command | Description |
    | --- | --- |
    | `/help` | Show the short help summary |
    | `/commands` | Show the generated command catalog |
    | `/tools [compact\|verbose]` | Show what the current agent can use right now |
    | `/status` | Show execution/runtime status, Gateway and system uptime, plugin health, plus provider usage/quota |
    | `/status plugins` | Show detailed plugin health: load errors, quarantines, channel plugin failures, dependency issues, compatibility notices. Requires `commands.plugins: true` |
    | `/goal [status\|start\|edit\|pause\|resume\|complete\|block\|clear] ...` | Manage the current session's durable [goal](/tools/goal) |
    | `/dashboard [request]` | Create or update the current session's dashboard using the Control UI dashboard workflow |
    | `/diagnostics [note]` | Owner-only support-report flow. Asks for exec approval every time |
    | `/openclaw <request>` | Run the OpenClaw setup and repair helper from an owner DM |
    | `/tasks` | List active/recent background tasks for the current session |
    | `/context [list\|detail\|map\|json]` | Explain how context is assembled |
    | `/whoami` | Show your sender id. Alias: `/id` |
    | `/usage off\|tokens\|full\|reset\|cost` | Control the per-response usage footer (`reset`/`inherit`/`clear`/`default` clears the session override to re-inherit the configured default) or print a local cost summary |
  </Accordion>

`/dashboard` is reserved as a built-in command. If an existing user skill is
named `dashboard`, skill discovery exposes its generated slash alias as
`/dashboard_2`; `$dashboard` and `/skill dashboard` continue to select that
user skill directly.

  <Accordion title="Skills, allowlists, approvals">
    | Command | Description |
    | --- | --- |
    | `/skill <name> [input]` | Run a skill by name |
    | `/learn [request]` | Draft one reviewable skill from the current conversation or named sources through [Skill Workshop](/tools/skill-workshop) |
    | `/loop [interval] <prompt>` | Owner-only. Repeat a prompt in this conversation; omit the interval for self-paced checks |
    | `/loop status` | Owner-only. List loops bound to this conversation |
    | `/loop stop [name]` | Owner-only. Stop matching loops bound to this conversation |
    | `/allowlist [list\|add\|remove] ...` | Manage allowlist entries. Text-only |
    | `/approve <id> <decision>` | Resolve exec or plugin approval prompts |
    | `/btw <question>` | Ask a side question without changing session context. Alias: `/side`. See [BTW](/tools/btw) |
  </Accordion>

  <Accordion title="Subagents and ACP">
    | Command | Description |
    | --- | --- |
    | `/subagents list\|log\|info` | Inspect sub-agent runs for the current session |
    | `/acp spawn\|cancel\|steer\|close\|sessions\|status\|set-mode\|set\|cwd\|permissions\|timeout\|model\|reset-options\|doctor\|install\|help` | Manage ACP sessions and runtime options. Runtime controls require external owner or internal Gateway admin identity |
    | `/session unbind` | Detach the current conversation without closing its agent session |
    | `/agents` | List thread-bound agents for the current session |
  </Accordion>

  <Accordion title="Owner-only writes and admin">
    | Command | Requires | Description |
    | --- | --- | --- |
    | `/config show\|get\|set\|unset` | `commands.config: true` | Read or write `openclaw.json`. Owner-only |
    | `/mcp show\|get\|set\|unset` | `commands.mcp: true` | Read or write OpenClaw-managed MCP server config. Owner-only |
    | `/plugins list\|inspect\|show\|get\|install\|enable\|disable` | `commands.plugins: true` | Inspect or mutate plugin state. Owner-only for writes. Alias: `/plugin` |
    | `/debug show\|set\|unset\|reset` | `commands.debug: true` | Runtime-only config overrides. Owner-only |
    | `/restart` | `commands.restart: true` (default) | Restart OpenClaw |
    | `/update` | `commands.restart: true` (default), owner | Update OpenClaw and restart; receive a completion or failure notice in the same chat |
    | `/send on\|off\|inherit` | owner | Set send policy |
  </Accordion>

  <Accordion title="Voice, TTS, channel control">
    | Command | Description |
    | --- | --- |
    | `/tts on\|off\|status\|chat\|latest\|provider\|limit\|summary\|audio\|help` | Control TTS. See [TTS](/tools/tts) |
    | `/activation mention\|always` | Set group activation mode |
    | `/bash <command>` | Run a host shell command. Alias: `! <command>`. Requires `commands.bash: true` |
    | `!poll [sessionId]` | Check a background bash job; acknowledge its pending completion notice only after the terminal reply is delivered. Failed or suppressed replies retain the notice |
    | `!stop [sessionId]` | Stop a background bash job |
  </Accordion>
</AccordionGroup>

### Bundled plugin commands

| Command                                                                             | Description                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dreaming [on\|off\|status\|help]`                                                 | Toggle memory dreaming (owner or Gateway admin). See [Dreaming](/concepts/dreaming)                                                                                                            |
| `/pair [qr\|status\|pending\|approve\|cleanup\|notify]`                             | Manage device pairing. See [Pairing](/channels/pairing)                                                                                                                                        |
| [`/voice`](/nodes/talk#choose-a-talk-voice-from-chat) `status\|list\|set <voiceId>` | Manage Talk voice config. Discord native name: `/talkvoice`                                                                                                                                    |
| `/codex <action> ...`                                                               | Bind, steer, and inspect the Codex app-server harness (status, threads, resume, model, fast, permissions, compact, review, mcp, skills, and more). See [Codex harness](/plugins/codex-harness) |

LINE-only: `/card ...` (rich card presets; see [LINE](/channels/line))

QQBot-only: `/bot-ping`, `/bot-version`, `/bot-help`, `/bot-upgrade`, `/bot-logs`

### Skill commands

User-invocable skills are exposed as slash commands:

- `/skill <name> [input]` always works as the generic entrypoint.
- Skills may register as direct commands using their declared skill name.
- Native skill-command registration is controlled by `commands.nativeSkills` and
  `channels.<provider>.commands.nativeSkills`.
- Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes.

<AccordionGroup>
  <Accordion title="Skill command dispatch">
    By default, skill commands route to the model as a normal request.

    Skills can declare `command-dispatch: tool` to route directly to a tool
    (deterministic, no model involvement).

  </Accordion>
  <Accordion title="Native command arguments">
    Discord uses autocomplete for dynamic options and button menus when required
    args are omitted. Telegram and Slack show a button menu for commands with
    choices. Dynamic choices resolve against the target session model, so model-
    specific options like `/think` levels follow the session's `/model` override.
  </Accordion>
</AccordionGroup>

## `/tools`: what the agent can use now

`/tools` answers a runtime question: **what this agent can use right now in this
conversation** — not a static config catalog.

```text
/tools         # compact view
/tools verbose # with short descriptions
```

Results are session-scoped. Changing agent, channel, thread, sender
authorization, or model can change the output. For profile and override editing,
use the Control UI Tools panel or config surfaces.

## `/loop`: recurring conversation work

`/loop` is owner-only because it uses the cron control-plane tool. `/loop 5m check deploy status` asks the agent to create a fixed-cadence cron job in the current conversation. Without an interval, `/loop watch for new issues` creates a self-paced loop that checks more often while active and backs off toward 1 hour while quiet. `/loop status` lists the conversation's loop jobs; `/loop stop [name]` removes them.

## `/model`: model selection

Use `-s` to change only the current session, `-a` to also update the agent default, or `-g` to also update the shared global default. The long forms are `--session`, `--agent`, and `--global`; an explicit scope overrides `agents.defaults.modelSelectionScope`.

Without a flag or that optional setting, `/model <model>` changes only the current session, including for owners/admins. Set `agents.defaults.modelSelectionScope` to `"agent"` or `"global"` only when you want unqualified selections to update that default. The setting does not grant permission to write configured defaults. See [Model selection scope](/gateway/config-agents#agentsdefaultsmodelselectionscope).

In text commands, select a model by `provider/model` or a configured alias.
Numeric selections such as `/model 3` are not supported.

```text
/model             # show current model and usage guidance
/model list        # browse providers (same as /models)
/models openai     # list models from a provider
/model openai/gpt-5.4    # configured scope, or session-only when unset
/model openai/gpt-5.4 -s # explicit session scope
/model openai/gpt-5.4 -a # session + agent default update request
/model openai/gpt-5.4 -g # session + global default update request
/model default -s        # clear this session's model selection; use configured default
/model opus@anthropic:default -s # pin this profile for the current session
/model default     # use configured default, following the selected scope
/model status      # detailed view with endpoint and API mode
```

On Discord, the bare native `/model` and `/models` commands open an interactive
picker. Choose a provider and model from the dropdowns, then select **Submit**.
Discord follows the direct command behavior, including `modelSelectionScope`.
Telegram model browsing uses callback buttons; selections always remain session-only.
The picker respects `agents.defaults.modelPolicy.allow`,
including `provider/*` entries. Without an explicit allowlist, model entries and
aliases do not restrict selection.

`-a` updates only the current agent's configured primary, even when it previously
inherited the global default. `-g` updates the shared fallback, not every agent's
explicit primary. Other session pins remain unchanged, but unpinned sessions
and cron jobs that inherit the changed default can use it on their next run.
Selecting the effective configured default clears the session model pin, but
agent/global scope still requests the configured-default write. Use
`/model default -s` to inherit the configured default without writing it.
Without owner/admin authority, bare commands remain session-only and explicit
`-a` or `-g` requests are rejected.

## `/config`: on-disk config writes

<Note>
  Owner-only. Disabled by default — enable with `commands.config: true`.
</Note>

```text
/config show
/config show channels.whatsapp.responsePrefix
/config get channels.whatsapp.responsePrefix
/config set channels.whatsapp.responsePrefix="[openclaw]"
/config unset channels.whatsapp.responsePrefix
```

Config is validated before write. Invalid changes are rejected. `/config`
updates persist across restarts.

## `/mcp`: MCP server config

<Note>
  Owner-only. Disabled by default — enable with `commands.mcp: true`.
</Note>

```text
/mcp show
/mcp show context7
/mcp set context7={"command":"uvx","args":["context7-mcp"]}
/mcp unset context7
```

`/mcp` stores config in OpenClaw config, not embedded-agent project settings.
`/mcp show` redacts credential-bearing fields, recognized credential flag
values, and known secret-shaped arguments. When run from a group, the
configuration is sent to the owner privately; if no private owner route is
available, the command fails closed and asks the owner to retry from a direct
chat.

## `/debug`: runtime-only overrides

<Note>
  Owner-only. Disabled by default — enable with `commands.debug: true`.
  Overrides apply immediately to new config reads but do **not** write to disk.
</Note>

```text
/debug show
/debug set channels.whatsapp.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset channels.whatsapp.responsePrefix
/debug reset
```

## `/plugins`: plugin management

<Note>
  Owner-only for writes. Disabled by default — enable with `commands.plugins: true`.
</Note>

```text
/plugins
/plugins list
/plugin show context7
/plugins enable context7
/plugins disable context7
/plugins install clawhub:<package>
/plugins install npm:@openclaw/<official-package>
/plugins install npm:<package> --force
/plugins install git:<repository>@<ref> --force
```

`/plugins enable|disable` updates plugin config and hot-reloads the Gateway
plugin runtime for new agent turns. `/plugins install` restarts managed
Gateways automatically because plugin source modules changed. Trusted ClawHub
and official-catalog installs do not need a provenance acknowledgement. Arbitrary npm,
git, archive, `npm-pack:`, and local path sources show a provenance warning and
require a trailing `--force` after you review the source. This flag acknowledges
the source and permits replacement of an existing install; it does not bypass
`security.installPolicy` or installer security checks. ClawHub Review outcomes
are printed informationally; blocked releases remain non-installable.
Marketplace, linked, and pinned installs remain shell-only.

`/plugins inspect <child>` (also `show` or `get`) and `/plugins inspect all` include the shared package install metadata for multi-entry plugins. Inspection returns `install: null` when package ownership is missing or ambiguous, and preserves its runtime capability report.

When `/plugins install` or `/plugins enable` requires capability consent, it
returns the plugin's declared capabilities and an exact retry command. Review
that reply, then rerun with `--accept-capabilities`:

```text
/plugins install clawhub:<package> --accept-capabilities
/plugins enable <plugin-id> --accept-capabilities
```

Capability consent also applies to official external plugins and is separate
from the source acknowledgement provided by `--force`.

## `/trace`: plugin trace output

```text
/trace          # show current trace state
/trace on
/trace off
```

`/trace` reveals session-scoped plugin trace/debug lines without full verbose
mode. It does not replace `/debug` (runtime overrides) or `/verbose` (normal
tool output).

## `/btw`: side questions

`/btw` is a quick side question about the current session context. Alias: `/side`.

```text
/btw what are we doing right now?
/side what changed while the main run continued?
```

Unlike a normal message:

- Uses the current session as background context.
- In Codex harness sessions, runs as an ephemeral Codex side thread.
- Does **not** change future session context.
- Is not written to transcript history.

In the Control UI, `/btw` and `/side` open Side chat instead of starting the
detached BTW path. The TUI and
external-channel behavior above is unchanged.

See [BTW side questions](/tools/btw) for the full behavior.

## Surface notes

<AccordionGroup>
  <Accordion title="Session scoping per surface">
    - **Text commands:** run in the normal chat session (DMs share `main`, groups have their own session).
    - **Native Discord commands:** `agent:<agentId>:discord:slash:<userId>`
    - **Native Slack commands:** `agent:<agentId>:slack:slash:<userId>` (prefix configurable via `channels.slack.slashCommand.sessionPrefix`)
    - **Native Telegram commands:** `telegram:slash:<userId>` (targets the chat session via `CommandTargetSessionKey`)
    - **`/login codex`** sends device pairing codes only through private chat or Web UI response paths. Telegram group/topic invocations ask the owner to DM the bot instead.
    - **`/stop`** targets the active chat session to abort the current run.

  </Accordion>
  <Accordion title="Slack specifics">
    `channels.slack.slashCommand` supports a single `/openclaw`-style command.
    With `commands.native: true`, create one Slack slash command per built-in
    command. Register `/agentstatus` (not `/status`) because Slack reserves
    `/status`. Text `/status` still works in Slack messages.
  </Accordion>
  <Accordion title="Fast path and inline shortcuts">
    - Command-only messages from allowlisted senders are handled immediately (bypass queue + model).
    - Inline shortcuts (`/help`, `/commands`, `/status`, `/whoami`) also work embedded in normal messages and are stripped before the model sees the remaining text.
    - In Control UI, every non-skill slash command can be selected in the middle of a draft. The command runs separately, only the command invocation is removed, and the surrounding draft remains unsent.
    - In Control UI (WebChat), selecting a skill from slash completion inserts the existing `$skill-name` reference into the message (for example, `Please use $weather to check Sydney`).
    - Inline command dispatch follows the same connection, permission, and confirmation checks as sending that command by itself. Typing slash-like prose without selecting or submitting the completion does not execute it.
    - On external channels, unauthorized text command-only messages are silently ignored; inline `/...` tokens are treated as plain text. Native `/compact` returns an authorization refusal when a channel-admitted sender cannot use the command. Reset denials show a permission reply only when the request and reply stay in WebChat.

  </Accordion>
  <Accordion title="Argument notes">
    - Commands accept an optional `:` between the command and args (`/think: high`, `/send: on`).
    - `/new <model>` accepts a model alias, `provider/model`, or a provider name (fuzzy match); if no match, the text is treated as the message body.
    - `/allowlist add|remove` requires `commands.config: true` and honors channel `configWrites`.

  </Accordion>
</AccordionGroup>

## Provider usage and status

- **Provider usage/quota** (e.g., "Claude 80% left") shows in `/status` for the current model provider when usage tracking is enabled.
- **Token/cache lines** in `/status` can fall back to the latest transcript usage entry when the live session snapshot is sparse.
- **Execution vs runtime:** `/status` reports `Execution` for the effective sandbox path and `Runtime` for who is running the session: `OpenClaw Default`, `OpenAI Codex`, a CLI backend, or an ACP backend.
- **Per-response tokens/cost:** controlled by `/usage off|tokens|full`.
- `/model status` is about models/auth/endpoints, not usage.

## Related

<CardGroup cols={2}>
  <Card title="Skills" href="/tools/skills" icon="puzzle-piece">
    How skill slash commands are registered and gated.
  </Card>
  <Card title="Creating skills" href="/tools/creating-skills" icon="hammer">
    Build a skill that registers its own slash command.
  </Card>
  <Card title="BTW" href="/tools/btw" icon="comments">
    Side questions without changing session context.
  </Card>
  <Card title="Steer" href="/tools/steer" icon="compass">
    Guide the agent mid-run with `/steer`.
  </Card>
</CardGroup>
