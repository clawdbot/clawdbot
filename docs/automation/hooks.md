---
summary: "Internal hooks: install, write, and verify automation for commands and lifecycle events"
read_when:
  - You want event-driven automation for /new, /reset, /stop, or session and Gateway events
  - You want to write, install, enable, or debug an internal hook
  - You need to understand hook discovery, event data, or reply delivery
title: "Hooks"
doc-schema-version: 1
---

# Hooks

Internal hooks are small JavaScript or TypeScript handlers that run in the
Gateway process when OpenClaw emits an event. Use them to save session context,
log reset commands, or perform short side effects during message and session
lifecycle events. OpenClaw includes [bundled hooks](/automation/hooks#bundled-hooks)
for common tasks; you do not need to write a plugin to use them.

## Choose the right surface

| You want to…                                                                                                   | Use                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Save context on `/new`, log commands, or react to session and message events                                   | **Internal hooks** (`HOOK.md` plus a handler), described here   |
| Modify prompts, intercept tools, control replies, or use lifecycle contracts with priorities and return values | **[Plugin hooks](/plugins/hooks)** through `api.on(...)`        |
| Let another service start work through an HTTP request                                                         | **[Webhooks](/automation/cron-jobs#webhooks)**                  |
| Export telemetry rather than change behavior                                                                   | **[Diagnostic events](/logging#diagnostics-and-opentelemetry)** |

These are separate systems. `hooks.internal` configures this page's event
handlers; `hooks.enabled` configures HTTP ingress. Internal event names such as
`message:received` are not typed plugin names such as `message_received`.

<Warning>
Internal hooks are trusted code, not sandboxed scripts. They run with the
Gateway process's filesystem, network, and environment access. Review hook code
before enabling it, especially code from a workspace or downloaded package.
</Warning>

## Quick start

Start with `command-logger`: it needs no extra binaries or model calls and gives
you a concrete file to inspect. Run these commands on the **Gateway host**, with
the same profile and config as that Gateway:

```bash
openclaw hooks list
openclaw hooks info command-logger
openclaw hooks enable command-logger
openclaw gateway restart
```

`gateway restart` applies to an installed Gateway service. If you run the Gateway
in the foreground, stop and start that process instead. Add `--agent <id>` to
hook commands when your configuration has multiple agents and no implicit owner.

In a conversation you can safely reset, send `/new` or `/reset` as an authorized
user. Then inspect the log on the Gateway host:

```bash
tail -n 5 ~/.openclaw/logs/commands.log
```

Look for a new JSON line with `"action":"new"` or `"action":"reset"`, a recent
`timestamp`, and that conversation's `sessionKey`. With a custom state directory,
read `<stateDir>/logs/commands.log` instead. This proves that a handler ran;
`openclaw hooks check` alone does not.

The log contains session and sender identifiers. Disable the hook after trying
it if you do not want to retain those records:

```bash
openclaw hooks disable command-logger
openclaw gateway restart
```

### Eligible, enabled, and loaded

Keep these three checks separate:

- **Requirements satisfied**: the hook's OS, binaries, environment, and config
  requirements pass on the host doing the check.
- **Enabled by config**: the per-hook/source policy allows it. Workspace hooks
  require explicit opt-in; bundled and managed hooks do not require that
  per-hook flag when broad discovery is enabled.
- **Loaded**: the running Gateway selected the hook, imported its handler, and
  registered its events. This also requires the master switch and configured
  name selection to allow it.

The CLI's `ready`, `eligible`, and `loadable` fields describe the first two checks
plus a nonempty event list. They do **not** prove that the Gateway imported the
handler, that the global selection includes it, or that its event has fired.
After changes, restart and verify the actual side effect or hook-specific log.

### Local, remote, and agent scope

`hooks list`, `info`, and `check` request the selected Gateway's inventory. An
implicit local Gateway can fall back to local discovery when unavailable or
when it lacks the report method. A configured remote Gateway or explicit
`OPENCLAW_GATEWAY_URL` does not fall back to your laptop's hooks on failure.

`hooks enable` and `hooks disable` always inspect and modify **local config**.
They do not update a remote Gateway over RPC. Run them on the Gateway host to
change that host's hooks.

`--agent <id>` selects the workspace to inspect, not an isolated hook registry.
The saved `hooks.internal.entries.<hookKey>` entry is global. Gateway startup
loads directory hooks from its startup workspace into a process-wide registry;
it does not load every agent's `hooks/` directory merely because you inspected
it. A loaded handler must filter the event's agent or session when it should
only act for a particular agent. See [Hook discovery](/automation/hooks#hook-discovery).

## Writing hooks

This example replies to a reset command and writes a fixed log marker. It does
not read message content, call a model, or contact an external service.

### Hook structure

On the Gateway host, use a new managed hook directory. The following commands
assume the default state directory and that `reset-greeting` does not already
exist; choose another name rather than overwrite an existing hook.

```bash
mkdir -p ~/.openclaw/hooks/reset-greeting

cat > ~/.openclaw/hooks/reset-greeting/HOOK.md <<'HOOK'
---
name: reset-greeting
description: "Confirm that a reset hook ran"
metadata:
  { "openclaw": { "events": ["command:new", "command:reset"] } }
---

# Reset greeting

Send a short confirmation after an authorized reset command.
HOOK

cat > ~/.openclaw/hooks/reset-greeting/handler.js <<'HANDLER'
export default function handler(event) {
  if (event.type !== "command" || !["new", "reset"].includes(event.action)) {
    return;
  }

  console.log("[reset-greeting] reset hook ran");
  event.messages.push("Reset hook ran.");
}
HANDLER
```

A hook needs `HOOK.md` and a handler file. Discovery checks, in order,
`handler.ts`, `handler.js`, `index.ts`, then `index.js`, using the first file it
finds. The example uses JavaScript so no TypeScript types or SDK imports are
needed.

Enable and load it:

```bash
openclaw hooks info reset-greeting
openclaw hooks enable reset-greeting
openclaw gateway restart
```

Send `/new` in a disposable conversation on a configured chat channel that can
route replies, such as a direct message to the bot. Expect **Reset hook ran.**
in that conversation and `[reset-greeting] reset hook ran` in Gateway logs.
`/reset` triggers the same example. Normal command authorization still applies.

Use an ordinary OpenClaw conversation, not an ACP-bound thread; bound sessions
delegate reset handling to their owning runtime. Do not use Control UI/webchat
or a `sessions.reset` RPC as the chat-reply check:
those paths do not deliver this hook's `event.messages` to the UI. The log marker
can still show that a reset event ran. See
[Reply delivery](/automation/hooks#reply-delivery) for the exact boundary.

Disable the example when finished:

```bash
openclaw hooks disable reset-greeting
openclaw gateway restart
```

Disabling leaves the files in place. To use a workspace directory instead, put
the two files in `<workspace>/hooks/reset-greeting/`, then explicitly enable the
hook. Workspace placement is not an agent sandbox or a guarantee that the
Gateway will load that workspace's hooks.

### Handler implementation

A handler exports a function returning `void` or `Promise<void>`. The loader uses
the default export unless `metadata.openclaw.export` names another export.
Returned values do not block, cancel, or rewrite the operation.

Every event has these fields:

| Field        | Meaning                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `type`       | Family: `command`, `session`, `agent`, `gateway`, or `message`                                             |
| `action`     | Action within the family, such as `new` or `compact:before`                                                |
| `sessionKey` | Session correlation key; Gateway events use a Gateway key instead                                          |
| `timestamp`  | JavaScript `Date` when the event object was created                                                        |
| `context`    | Event-specific data described under [Event context highlights](/automation/hooks#event-context-highlights) |
| `messages`   | Initially empty string array; only certain producers consume it as replies                                 |

Treat context as an observation, not a live state-editing API. Fields vary by
producer, and `cfg` is not present on every event. In particular, patch events
carry cloned snapshots. The explicit mutable exception is
`agent:bootstrap`'s `context.bootstrapFiles`.

### Reply delivery

Pushing to `event.messages` is not a general send-message API:

| Producer                                                                     | What happens to `event.messages`                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat command handling for `/new` and `/reset`                                | Awaits handlers, joins strings with blank lines, and attempts a reply to the originating channel/recipient, preserving account and thread context |
| Gateway session reset/create RPCs that emit `command:new` or `command:reset` | Handlers run, but messages are not routed as chat replies                                                                                         |
| `session:compact:before` and `session:compact:after`                         | Forwarded to the caller's compaction-notice callback when present; that callback owns delivery                                                    |
| All other core events                                                        | Ignored as replies, including `/stop`, automatic reset, message events, bootstrap, patch, and Gateway lifecycle events                            |

A missing recipient, unsupported route, send policy, or delivery failure can
prevent a reply. Append messages before the handler's promise settles; detached
work that pushes later can miss the producer's delivery step. To control normal
agent replies or send cancellation, use the appropriate
[typed plugin hook](/plugins/hooks).

### HOOK.md format

`HOOK.md` uses YAML frontmatter followed by human-readable Markdown:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://example.com/my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Explain the side effects, configuration, and verification steps here.
```

`name` defaults to the directory name; use a unique, stable name.
`description` is shown in reports. The following fields belong under
`metadata.openclaw`:

| Field              | Contract                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `events`           | Event-key array. At least one is needed to register a handler.                                                                                                                                                           |
| `export`           | Function export name; defaults to `default`.                                                                                                                                                                             |
| `hookKey`          | Config-entry key; defaults to the hook name. Discovery collisions still use the hook name.                                                                                                                               |
| `emoji`            | Display emoji.                                                                                                                                                                                                           |
| `homepage`         | Documentation URL; overrides top-level `homepage`, `website`, or `url`.                                                                                                                                                  |
| `os`               | Allowed Node platform names, for example `darwin`, `linux`, or `win32`.                                                                                                                                                  |
| `requires.bins`    | Every named executable must be on `PATH`.                                                                                                                                                                                |
| `requires.anyBins` | At least one named executable must be on `PATH`.                                                                                                                                                                         |
| `requires.env`     | Every named variable needs a nonblank process value or per-hook `env` value.                                                                                                                                             |
| `requires.config`  | Every dotted config path must be truthy.                                                                                                                                                                                 |
| `always`           | Bypass binary, environment, and config requirements; does not bypass OS or enablement policy.                                                                                                                            |
| `install`          | Informational install descriptors: `kind` is `bundled`, `npm`, or `git`; optional `id`, `label`, `package`, `repository`, and `bins`. This metadata does not install dependencies or make Git specs accepted by the CLI. |

Use `hooks.internal.entries.<hookKey>.enabled` to control activation, not a
top-level `enabled` flag in `HOOK.md`. For historical requirement metadata,
`workspace.dir`, `browser.enabled`, and `browser.evaluateEnabled` default to true
when absent. `workspace.dir` is not a new setting you need to add to your config.

## Configuration

For a predictable selection, enable named hooks rather than turning on broad
discovery:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": false }
      }
    }
  }
}
```

The master switch and selection rules for directory-loaded hooks are:

| Configuration                                                                 | Selection                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.internal.enabled: false`                                               | Internal hooks are off.                                                                                                                     |
| No master flag and no enabled entries, extra directories, or tracked installs | Gateway skips directory-hook loading.                                                                                                       |
| Named entries, with master flag omitted or true                               | Enabled names form an allowlist; `enabled: true` on the master does not broaden it. An entry without `enabled: false` contributes its name. |
| Master flag true with no named entries or named installs                      | Open-ended discovery of eligible hooks.                                                                                                     |
| Tracked hook packs declaring hook names                                       | Those names join the selection; an explicit per-hook `enabled: false` still disables a non-plugin hook.                                     |
| Nonempty `load.extraDirs`, or a tracked install without a hook-name list      | Open-ended discovery, not a selection restricted to that directory or pack.                                                                 |

Workspace hooks always need `entries.<hookKey>.enabled: true`, even with
open-ended discovery. For other file hooks, an entry can be selected by its
name or `hookKey`, but settings are read under `hookKey`. The CLI resolves the
name and writes the correct key for you. Adding the first named entry can narrow
a previously broad selection; inspect existing hooks before changing it.

Per-hook entries accept arbitrary handler-defined fields. The core types
`enabled` as a boolean and `env` as a string-to-string map; it does not validate
custom handler options. For example:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": { "MY_HOOK_LABEL": "example" }
        }
      }
    }
  }
}
```

Per-hook `env` satisfies eligibility checks but **does not mutate `process.env`**.
On events carrying config, a handler can read it from
`event.context.cfg?.hooks?.internal?.entries?.["my-hook"]?.env`. Other events do
not promise a `cfg` field. Do not log entire config objects or put secrets in
examples.

<Warning>
`hooks.internal.handlers` is retired and fails normal config validation. Before
running `openclaw doctor --fix`, migrate each registered module into a managed or
workspace hook directory with `HOOK.md` and a handler. Doctor removes the old
registrations; it does not create executable files. For a legacy-only config
with `hooks.internal.enabled: true`, it also removes that flag to avoid broad
discovery. Named entries, nonempty extra directories, and explicit
`enabled: false` are preserved.
</Warning>

## Hook discovery

Directory discovery merges hooks by **name** using these rules:

| Source            | Location and collision behavior                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled           | Shipped with OpenClaw.                                                                                                                                                  |
| Plugin            | Hook directories declared by active plugins; can replace bundled names.                                                                                                 |
| Managed           | `<stateDir>/hooks/`, normally `~/.openclaw/hooks/`; can replace bundled and plugin names.                                                                               |
| Extra directories | `hooks.internal.load.extraDirs`; same source policy as managed hooks. Later extra directories win over earlier ones; the managed directory wins over extra directories. |
| Workspace         | `<workspace>/hooks/`; can add names but cannot replace bundled, plugin, or managed names. Explicit opt-in required.                                                     |

Bundled, managed, workspace, and plugin hook locations are collection
directories: discovery inspects their immediate children for hooks or packages
whose `package.json` declares `openclaw.hooks`.

Each explicit `hooks.internal.load.extraDirs` path can instead be a pack root,
a single-hook root, or a collection directory. A pack root loads only its
declared hook paths, including nested paths such as `./hooks/my-hook`. Each
path must point directly to a hook; discovery does not recurse into another
pack or collection. A recognized pack with no valid hooks stays empty rather
than scanning unlisted children. A single-hook root loads its own `HOOK.md`
and handler. Only an ordinary collection root gets the immediate-child scan.

For example, to select `/opt/openclaw-hook-library/my-hook/HOOK.md` directly,
add that hook's directory:

```json
{
  "hooks": {
    "internal": {
      "load": {
        "extraDirs": ["/opt/openclaw-hook-library/my-hook"]
      }
    }
  }
}
```

To scan the library's immediate children instead, add
`/opt/openclaw-hook-library`. Only add trusted directories: any extra path
opens hook-name selection across discovery sources beyond named entries,
even when that path selects a single hook or pack.
Handler files must stay within their hook directory; package and plugin hook
paths must stay within their package root. Symlinks escaping those boundaries
are rejected. Restart after changing hook files, metadata, or configuration,
then verify the handler's actual side effect; inventory alone does not prove execution.

### Hook packs

A hook pack is a package whose `package.json` declares hook directories in
`openclaw.hooks`. Install a reviewed package or local directory through the
unified installer:

```bash
openclaw plugins install <path-or-spec>
```

Installation and update flags, npm restrictions, linked-root behavior and trust, and
the deprecated `hooks install` / `hooks update` aliases are documented in
[Install and update hook packs](/cli/hooks#install-and-update-hook-packs).

## Bundled hooks

| Hook                    | Events                                               | Purpose                                                    |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `boot-md`               | `gateway:startup`                                    | Run workspace `BOOT.md` instructions at startup.           |
| `bootstrap-extra-files` | `agent:bootstrap`                                    | Add matching workspace bootstrap files to context.         |
| `command-logger`        | `command`                                            | Append emitted command events to a JSONL log.              |
| `compaction-notifier`   | `session:compact:before`, `session:compact:after`    | Add compaction status notices on supported delivery paths. |
| `session-memory`        | `command:new`, `command:reset`, `session:auto-reset` | Save recent conversation excerpts to workspace memory.     |

Enable one with `openclaw hooks enable <hook-name>`, then restart and verify its
side effect. The following sections describe what to expect.

<a id="boot-md"></a>

### boot-md details

Runs a nonempty `BOOT.md` from each configured agent's resolved workspace.
Workspaces shared by multiple agents run only once, under the first agent
selected for that workspace. Startup tasks run sequentially; a failed task is
logged and does not prevent later tasks.

This executes instructions through an agent run, not as a shell script and not
as a bootstrap file injection. Each run uses a fresh temporary
`agent:<id>:boot:<run-id>` session, cleaned up after success or failure. Existing
sessions and their history are preserved. Normal final-response delivery is disabled;
if the instructions need to notify someone, they must specify a channel and
target for the message tool. Missing or empty files are skipped.

Keep boot instructions short and safe to repeat on every restart. They can use
model and tool capabilities, so enabling this hook can cause model calls and
outbound side effects.

<a id="bootstrap-extra-files"></a>

### bootstrap-extra-files config

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md"]
        }
      }
    }
  }
}
```

`paths` is preferred. If it is empty, the handler tries `patterns`, then `files`;
these are alternatives, not merged lists. Without patterns, the hook does nothing.

Paths resolve relative to the event's workspace and must remain inside it,
including after symlink resolution. Only these basenames load: `AGENTS.md`,
`SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, and `MEMORY.md`.

Extra files go through normal bootstrap filtering and injection limits. Reads
are capped at 2 MiB per file. Injection defaults to 20,000 characters per file
and 60,000 total, controlled by `bootstrapMaxChars` and
`bootstrapTotalMaxChars` in agent defaults or overrides; `USER.md` has a separate
4,000-character cap. Duplicate paths are removed. Subagents retain only
`AGENTS.md`; cron and non-private conversations have additional context/privacy
filters. Inspect the actual injected result with `/context detail`; see
[Context](/concepts/context).

`TOOLS.md` is not a recognized runtime bootstrap basename.
`openclaw doctor --fix` archives workspace-root `TOOLS.md` and merges customized
content into the `## Tools` section of `AGENTS.md`. Other `TOOLS.md` files named
by patterns are not migrated;
point those patterns at `AGENTS.md` instead.

<a id="command-logger"></a>

### command-logger details

Appends one JSON line per emitted command event to
`<stateDir>/logs/commands.log`. Fields are `timestamp`, `action`, `sessionKey`,
`senderId`, and `source`; absent sender/source values become `unknown`.
Core emits `/new`, `/reset`, and `/stop`, not every slash command.

The handler awaits the append, logs write errors, and sends no chat confirmation.
It does not rotate the log. Set appropriate access and retention for the session
and sender identifiers it records. See [Log inspection](/cli/hooks#command-logger-log-file).

<a id="compaction-notifier"></a>

### compaction-notifier details

Adds a short notice before compaction and a completion notice after successful
compaction. Notices can include message counts and before/after token counts
when available. They travel through the compaction caller's notice callback;
without a callback that delivers them, enabling the hook does not guarantee a
visible message. A before notice without an after notice can indicate a
skipped, failed, or interrupted compaction, not a stuck hook. Manual `/compact`
does not supply this hook-message delivery callback, so it is not a reliable
way to test the notices.

<a id="session-memory"></a>

### session-memory details

Saves the ended session's recent user/assistant text on `/new`, `/reset`
(including soft reset), or automatic daily/idle rollover. Automatic rollover
emits `session:auto-reset`, not a synthetic command event. Expiry is checked when
a subsequent turn is admitted; this is not a timer that writes memory at the
daily boundary while the session is idle.

The artifact is `<workspace>/memory/YYYY-MM-DD-HHMM.md` by default, with a
numeric suffix if that filename already exists. Dates use
`agents.defaults.userTimezone`, then process `TZ` when no user timezone is set,
and the host timezone as fallback. The file records session identity and the
command source or automatic reset reason.

| Entry option | Default       | Behavior                                                                                                        |
| ------------ | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `messages`   | `15`          | Recent user/assistant messages to include; use a positive integer.                                              |
| `llmSlug`    | `false`       | Ask a model for a descriptive filename slug.                                                                    |
| `model`      | Agent default | Optional configured alias, bare model ID on the default provider, or `provider/model` used for slug generation. |

The hook captures the departing conversation before a reset closes its active
window, then writes the snapshot in the background. Capture is bounded to
4,096 scanned messages and 8 MiB.
Manual resets do not await the file write or optional slug-model call; automatic
reset dispatch also runs independently of the successor turn. Wait for
`Session context saved to ...` in logs before expecting the file.

This is a filtered excerpt, not a complete transcript or a model-written
summary. It omits slash-command text, tool messages, inter-session user input,
silent reply markers, and duplicate delivery-mirror text. If transcript reading
fails, the artifact can record that content was unavailable. The workspace is
resolved from event/agent config; you do not need to add a `workspace.dir` key.

With `llmSlug: true`, conversation text is sent to the configured model to name
the file. Failure falls back to a timestamp slug. Leave it off if you want no
extra model call for naming.

<Note>
Saved excerpts are workspace memory artifacts. If
[session transcript indexing](/reference/memory-config#session-memory-search)
is also enabled, one conversation can be represented by both `memory` and
`sessions`, adding overlapping results and embedding work. For hook-only recall,
set `memory.search.sources: ["memory"]` and
`memory.search.rememberAcrossConversations: false`; `sources` alone does not stop
cross-conversation recall from adding `sessions`. For full-transcript recall
instead, disable `session-memory`. These search settings do not disable the
hook's file writes or ordinary transcript persistence.
</Note>

## Event types

Subscribe to an exact key below or a bare family (`command`, `session`, `agent`,
`gateway`, `message`). Family subscriptions receive all actions in that family.
Do not subscribe the same handler to both `command` and `command:new` unless you
want it called twice for a new command. `session:compact` is not a family or a
wildcard; subscribe to the two exact compaction keys.

| Event                    | Trigger and wait behavior                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `command:new`            | Authorized new-session command handling, or a Gateway session operation that emits new-command hooks; awaited.            |
| `command:reset`          | Authorized reset-command handling or Gateway session reset; awaited.                                                      |
| `command:stop`           | Stop-command handling after the abort request; awaited, with no hook reply delivery.                                      |
| `session:auto-reset`     | Existing session replaced due to daily/idle policy; dispatched independently of the successor turn.                       |
| `session:compact:before` | Before compaction work; awaited.                                                                                          |
| `session:compact:after`  | After successful compaction; awaited.                                                                                     |
| `session:patch`          | An authorized Gateway patch is applied, or a supported model-selection path persists a change; asynchronous notification. |
| `agent:bootstrap`        | Workspace bootstrap resolution before context injection; awaited.                                                         |
| `gateway:startup`        | Scheduled after hook loading and sidecar/channel startup work; does not delay initial Gateway bind.                       |
| `gateway:shutdown`       | Shutdown begins, before channel/plugin teardown; bounded wait.                                                            |
| `gateway:pre-restart`    | Shutdown has a finite expected-restart delay; bounded wait.                                                               |
| `message:received`       | Accepted inbound dispatch with a session key; asynchronous observation.                                                   |
| `message:transcribed`    | Pre-agent preprocessing has nonempty audio transcript text and a session key; asynchronous observation.                   |
| `message:preprocessed`   | Media/link preprocessing completed or was skipped, with a session key; asynchronous observation.                          |
| `message:sent`           | A delivery owner reports a send outcome with a session key; asynchronous observation. Inspect `context.success`.          |

Not every incoming transport update or attempted low-level send produces an
internal message event. Suppressed/duplicate inbound dispatches and paths with
no session key can omit them. These are observation points, not a complete
transport audit or a way to block message processing. Fast native-command paths
can skip preprocessing events. `preprocessed` means that phase was passed, not
that every attachment or link was successfully understood. Likewise, compaction
can skip or fail after its before event, and retries can emit before again.

Unknown subscriptions such as `command:nwe` are still registered, but the loader
warns and `hooks info` reports them. Core does not emit them. A custom key only
fires if custom code explicitly emits it; declaring it in metadata does not
create a trigger.

`command:stop` observes cancellation command handling. It is not a natural
agent-finalization gate. For that contract, see `before_agent_finalize` in
[Plugin hooks](/plugins/hooks).

### Event context highlights

Fields below describe the producer payloads. Values marked optional may be
absent; do not assume fields from one event exist on another.

**`command:new` and `command:reset`:** `agentId`, `sessionEntry`,
`previousSessionEntry`, `commandSource`, `senderId`, `workspaceDir`, `storePath`,
and `cfg` on the chat command path. Entries and routing metadata depend on the
caller. Gateway reset uses `commandSource: "gateway:sessions.reset"`; Gateway
agent reset uses `gateway:agent`, and session creation can use `webchat`.
Gateway callers omit `senderId`. Session creation emits new-command hooks only
when requested with `emitCommandHooks` for an existing parent. Prefer
`previousSessionEntry` for the session being replaced: chat and Gateway paths
emit at different points in reset, so this is not a universal pre-reset or
successful-reset receipt.
A `sessionFile` value can be a transcript identifier rather than a readable file
path; do not assume it is JSONL on disk.

**`command:stop`:** optional `sessionEntry`, `sessionId`, `commandSource`, and
`senderId`. It does not carry the full new/reset context.

**`session:auto-reset`:** `cfg`, `agentId`, `workspaceDir`, `storePath`,
`sessionEntry` identifying the ended `sessionId` and optional `sessionFile`,
`reason` (`daily` or `idle`), and optional `transcriptArchived`, `nextSessionId`,
and `nextSessionKey`.

**`agent:bootstrap`:** `workspaceDir`, mutable `bootstrapFiles`, and optional
`cfg`, `sessionKey`, `sessionId`, `agentId`. Each bootstrap record has `name`,
`path`, `missing`, and optional `content`. A handler can replace or extend the
array, but final path deduplication, session/privacy filtering, and context
budgets still apply.

**`session:patch`:** cloned post-operation `sessionEntry`, request-shaped `patch`,
and `cfg`. The patch contains target/expectation fields and submitted settings,
not a computed changed-fields diff. Successful Gateway patches can emit even
when a submitted value was already present. Supported model-selection paths
also emit, including `/model`, the model picker, and model changes through
`session_status`; a read-only status query does not. This is not a notification
for every session-store write.

**Compaction:** both phases include `sessionId`, `missingSessionKey`,
`messageCount`, and optional `tokenCount`. Before also includes
`messageCountOriginal` and optional `tokenCountOriginal`. After includes
`compactedCount` and optional `summaryLength`, `tokensBefore`, `tokensAfter`, and
`firstKeptEntryId`. Do not infer unavailable token counts as zero.

**`gateway:startup`:** `cfg`, `deps`, and `workspaceDir`. **Shutdown and
pre-restart:** `reason` and `restartExpectedMs` (null when no restart is expected
on shutdown). The shutdown wait defaults to 5 seconds; pre-restart adds a
separate 10-second budget. These bound the caller's wait, not the handler's work:
timeout does not cancel promises. Channels have not yet been torn down, but
neither queued agent work nor message delivery is guaranteed to finish before
shutdown. Typed `session_end` drain behavior belongs to [Plugin hooks](/plugins/hooks).

#### Message context

`message:received` contains `from`, `content`, `channelId`, and optional
`timestamp`, `accountId`, `conversationId`, `messageId`, `media`, `originalMedia`,
`mediaStagingPending`, and `metadata`. Content prefers a nonblank command body,
then raw body, then generic body. It does not select `BodyForAgent`; the fallback
body is surface-defined rather than stripped of all enrichment by the mapper.

Received `metadata` can contain `to`, `provider`, `surface`, `threadId`,
`senderId`, `senderName`, `senderUsername`, `senderE164`, `guildId`, `channelName`,
and `topicName`. Legacy attachment aliases are `mediaPath`, `mediaUrl`,
`mediaType`, `mediaPaths`, `mediaUrls`, and `mediaTypes`; remote-staging metadata
can also include `mediaRemoteHost`, `mediaStagingPending`, and corresponding
`originalMediaPath`, `originalMediaUrl`, `originalMediaType`, `originalMediaPaths`,
`originalMediaUrls`, and `originalMediaTypes`. Prefer the structured media arrays.

`message:transcribed` and `message:preprocessed` contain `channelId`, `cfg`, and
optional `from`, `to`, `body`, `bodyForAgent`, `timestamp`, `conversationId`,
`messageId`, `senderId`, `senderName`, `senderUsername`, `provider`, `surface`,
and the structured media fields. Transcribed adds required `transcript` text;
preprocessed adds optional `transcript`, `isGroup`, and `groupId`.
`bodyForAgent` is the enriched body prepared for the agent. `mediaPath` and
`mediaType` remain deprecated first-attachment aliases. These contexts do not
promise `accountId` or the received event's `metadata` object.

Each structured media fact can contain `path`, `url`, `contentType`, `kind`,
`transcribed`, `messageId`, and `workspaceDir`. Facts preserve source order.
When `mediaStagingPending` is true, `media` is withheld and `originalMedia`
describes the original attachments; do not treat remote paths as local files.

`message:sent` contains `to`, `content`, `success`, `channelId`, and optional
`error`, `accountId`, `conversationId`, `messageId`, `isGroup`, and `groupId`.
`success: false` reports failure on a path that emitted an outcome; absence of
an event is not proof of either success or failure. Outbound delivery can report
one outcome per logical payload rather than per text chunk, and a partial
failure can include a message ID for a part already sent. Durable outbound
queue settlement can defer the observation; it does not make the hook durable.
Do not blindly resend on failure: you can duplicate a delivered part. A send
result is not proof that the recipient read the message.

## Plugin hooks

Plugin-managed internal hooks appear as `plugin:<id>` in `hooks list`. They
participate in this event system, but you enable or disable the owning plugin
rather than toggling them with `hooks enable` or `hooks disable`. The directory
loader's configured-name selection is not a policy gate for typed `api.on`
hooks or a substitute for plugin activation.

The legacy `api.registerHook` API registers internal events. It does not invoke
typed lifecycle names such as `before_tool_call`, `message_received`, or
`session_start`; registering those names emits a warning directing authors to
`api.on(...)`. For new integrations needing typed lifecycle control, use the
[Plugin hooks](/plugins/hooks) reference.

## Best practices

Handlers for one event run sequentially: family listeners first, then exact
listeners, in registration order within each group. The dispatcher awaits each
handler, catches and logs thrown errors, and continues to later handlers.
There is no priority option for file hooks.

This sequencing does not serialize different events. Message notifications,
patch notifications, and automatic reset work can overlap with other events and
agent processing. There is no general handler timeout, cancellation signal,
durable event queue, automatic retry, or exactly-once guarantee. Restart or
process exit can lose in-flight work.

Keep side effects short and bounded. Await the work that belongs to the handler,
set timeouts on network calls, limit data sizes, and make repeatable operations
idempotent. Do not use `void doHeavyWork(event)` as a general solution: that work
escapes the handler's wait/error boundary and can outlive its session or process.
If work needs a durable job lifecycle, use an automation or service that owns it.

Filter unrelated events early and avoid logging message bodies, whole config
objects, or credentials. Message and session data can be private. Keep only the
minimum needed for the side effect, protect output files, and set retention.
Long-lived timers, watchers, sockets, and clients belong to a plugin service
with an explicit shutdown lifecycle, not a request/event handler.

## CLI reference

See [`openclaw hooks`](/cli/hooks) for every public report and toggle option,
JSON output fields, exit behavior, and install/update aliases.

## Troubleshooting

### Hook not discovered

Check the report's `workspaceDir` and `managedHooksDir` with
`openclaw hooks list --json`. Confirm you are inspecting the intended host,
profile, and agent. Each hook needs `HOOK.md` and one supported handler file;
a metadata file alone is insufficient. Collection locations inspect immediate
children. An explicit extra path or linked root can itself be a hook or pack.
For a pack, verify that `openclaw.hooks` lists the intended hook directories
directly: nested packs and collections are not followed, and rejected entries
do not cause unlisted children to be scanned.

Check duplicate names and containment warnings in Gateway logs. A workspace
hook cannot override a bundled or managed hook. For extra directories and
linked packs, verify the root layout described under
[Hook discovery](/automation/hooks#hook-discovery).

### Hook not eligible

```bash
openclaw hooks info my-hook
openclaw hooks list --verbose
```

Check `blockedReason`, missing binaries on the Gateway's `PATH`, environment,
config paths, and OS. A workspace hook is disabled until explicitly enabled.
A hook with no declared events is not loadable. Reports can pass requirements
without proving that its module imports successfully.

### Hook not executing

Check `hooks.internal.enabled`, the configured-name selection, and the hook's
`hookKey` entry. Restart after changes. A `ready` report does not override the
master switch or name selection and does not mean a non-startup agent's workspace
was loaded.

```bash
openclaw logs --follow
```

Look for import/export errors, boundary failures, unknown-event warnings, or
`Hook error [<type>:<action>]`. Trigger the exact event again and verify a
hook-specific marker or artifact. Ordinary chat text does not trigger
`command:new`; `/stop` does not send hook replies; a metadata subscription does
not invent a custom trigger.

If the marker appears but the chat reply does not, check the producer and route
under [Reply delivery](/automation/hooks#reply-delivery), not just enablement.
For `session-memory`, allow background writing to finish and inspect the
resolved agent workspace rather than assuming the default workspace.

## Related

- [CLI Reference: hooks](/cli/hooks)
- [Plugin hooks](/plugins/hooks)
- [Webhooks](/automation/cron-jobs#webhooks)
- [Configuration](/gateway/configuration-reference#hooks)
- [Agent workspace](/concepts/agent-workspace)
