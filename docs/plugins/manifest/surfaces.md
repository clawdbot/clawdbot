---
summary: "Manifest fields for icons, CLI, MCP, Control UI, dashboard, QA, channel, and backup surfaces"
read_when:
  - Your plugin contributes a CLI command, MCP server, or dashboard widget
  - You are shipping native Control UI or a QA runner
  - You need backups or transcripts to know about plugin-owned data
title: "Manifest host surface fields"
sidebarTitle: "Host surface fields"
---

Manifest fields that contribute a concrete host surface: an icon, a command, a server, a panel, a widget, a runner, a channel, or a backup resource. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## Plugin icon

Place the portable plugin icon at `assets/icon.png`, relative to the plugin root. No manifest
field is required. Use a square PNG that remains recognizable at 16 px; 512×512 is recommended.
Missing, unreadable, or invalid icons are ignored and do not invalidate the plugin.

OpenClaw adopts this fixed package path as its icon convention, matching the path proposed in
[Agent Plugins 1.1](https://github.com/agentplugins/agent-plugins-spec/pull/66). Other Agent Plugins
consumers may not discover it unless that proposal is adopted. The fixed path keeps packages
portable and inspectable, avoids manifest path indirection and precedence rules, and lets OpenClaw
render the icon without a runtime network request. Top-level plugin-branding icon URLs are not
loaded; provider-auth artwork remains server-owned catalog metadata.

Prefer top-level `sessionRouteStateOwners` for static doctor ownership. The
older `doctorContract.sessionRouteStateOwners: true` declaration plus a
`sessionRouteStateOwners` export from `doctor-contract-api` remains supported
for external plugins, but is deprecated. When the manifest field is present,
OpenClaw uses it without loading the doctor-contract module. Removal plan:
remove the module fallback in OpenClaw 2027.1 after the external-plugin
migration window.

Set `doctorContract.configRepair: true` when the doctor-contract module exports
non-empty `legacyConfigRules`, a `normalizeCompatibilityConfig` function, or
both. One declaration covers the complete config-repair artifact.

Bundled plugins declare each state migration in execution order so Doctor can
plan its owner and receipt without loading plugin code:

```json
{
  "doctorContract": {
    "stateMigrations": [
      { "id": "legacy-cache-to-state" },
      { "id": "session-owner-repair", "doctorOnly": true, "phase": "after-session-repair" }
    ]
  }
}
```

The array must match the migration IDs, order, `doctorOnly` flags, and phases
exported by the doctor-contract module. The older value `true` still declares
the dynamic module. Installed external plugin manifests remain outside the
copied-state and candidate content identity, including when they use the
descriptor array. Candidate validation must bind those artifacts separately.
Until then, Doctor records an explicit planning refusal instead of treating an
installed manifest as write authority.

The Codex plugin sets `doctorHealthChecks: true` when its public API exports
health-check registration. Doctor checks the selected plugin's trust before
loading this surface. Older installed versions without the declaration skip
Codex health registration without preventing other checks; a declared but
missing or broken API remains an error. This does not grant plugin capabilities
or replace upgrade consent.

Channel plugins maintained in the OpenClaw source tree also expose these config
exports through a pure `config-doctor-api.ts` entrypoint. The core package retains
that entrypoint alongside its channel schemas when the plugin runtime is
distributed separately. This lets `doctor --fix` migrate older configuration
before plugin installation or capability consent. An installed plugin's doctor
contract remains authoritative; retained entrypoints do not expose state
migrations, install plugins, or grant capabilities.

## Transcript sources reference

`transcriptSources` maps provider IDs to static setup descriptors. Each key must
also appear in this plugin's `contracts.transcriptSourceProviders`; descriptors
for undeclared IDs are ignored. Names and setup controls are available from the
prepared manifest snapshot without importing provider runtime.

```json
{
  "contracts": { "transcriptSourceProviders": ["captions"] },
  "transcriptSources": {
    "captions": {
      "name": "Captions",
      "autoStart": { "accountId": "optional", "meetingUrl": "required" }
    }
  }
}
```

`name` is an optional display name. `autoStart` advertises setup controls to
Gateway clients through `transcripts.status`. Its only keys are `accountId`,
`guildId`, `channelId`, and `meetingUrl`; each value must be `"required"` or
`"optional"`. An explicit empty object supports setup without locator controls.
Omit `autoStart` for sources that only attach to an already-active meeting bot.
Malformed objects, unknown locator keys, or invalid modes do not advertise
partial setup. Title and custom session ID remain existing configuration fields, not locator
descriptor keys.

Setup requires an enabled plugin. Runtime capabilities remain observed facts:
an absent `canStart` does not hide the manifest descriptor, while an observed
`canStart: false` prevents new setup. The descriptor does not change acceptance
of existing `transcripts.autoStart` config or provider start semantics. Existing
source edits preserve configured fields when metadata is unavailable.

## backupResources reference

Use `backupResources` to declare plugin-owned durable data that backups must
include, or generated data that OpenClaw can safely omit and regenerate after
restore. The backup planner reads this metadata without loading plugin runtime
or modifying plugin files. Only effectively activated, loadable plugins
contribute resources; disabled or unloadable plugins cannot exclude data.

```json
{
  "backupResources": [
    {
      "disposition": "include",
      "scope": "state",
      "relativePath": "example-plugin/durable-state"
    },
    {
      "disposition": "regenerable",
      "scope": "agent",
      "relativePath": "example-plugin/generated-cache"
    }
  ]
}
```

Each entry is a closed object with exactly these fields:

| Field          | Required | Type                         | What it means                                                                          |
| -------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `disposition`  | Yes      | `"include" \| "regenerable"` | Protect durable data from exclusion, or identify data that can be omitted and rebuilt. |
| `scope`        | Yes      | `"state" \| "agent"`         | Resolve the resource under the state directory or each configured agent directory.     |
| `relativePath` | Yes      | `string`                     | Strict relative POSIX path contained by the selected scope's authoritative root.       |

Plugin identity and its trusted root come from manifest discovery; resource
entries cannot declare or override an owner. `relativePath` must not be empty
or absolute and must not contain backslashes, NULs, empty path segments, `.`,
`..`, Windows drive or UNC prefixes, URI-like values, or any path that escapes
its selected anchor. Invalid entries are rejected rather than normalized.

The planner deduplicates resources deterministically. A narrower `regenerable`
declaration wins over a broad configured state or agent root. Among plugin
resource declarations, only an explicit nested `include` protects a descendant
and keeps its excluded ancestors traversable. Explicit config, credentials,
workspace, and nested agent paths also remain protected. Omit only data the
plugin can recreate.
`openclaw backup create --only-config` does not inspect plugin backup metadata.

## MCP server reference

`mcpServers` lets a native plugin ship an MCP server, including an MCP App, without requiring operators to duplicate its static process definition in `openclaw.json`:

```json
{
  "mcpServers": {
    "example": {
      "transport": "stdio",
      "command": "node",
      "args": ["./mcp-server.js"]
    }
  }
}
```

OpenClaw includes these servers only while the owning plugin is enabled. Relative `command`, `args`, `cwd`, and `workingDirectory` paths resolve from the plugin root. User configuration remains authoritative: `mcp.servers.<name>` can replace a plugin default or set `enabled: false` to omit it. MCP App rendering and server-tool calls still require the normal MCP Apps setting and effective tool policy; declaring a server does not bypass either boundary.

## controlUi reference

`controlUi` declares a trusted native browser entry and optional stylesheets for
the Control UI. Paths are relative to the plugin root and must name compiled
JavaScript and CSS. Assets follow the Gateway's authentication policy, are
captured as immutable revisions, and refresh only through the explicit UI reload
flow.

User-installed native UI requires **Settings → Labs → Custom plugin UI**
(`gateway.controlUi.experimental.customPlugins`, default `false`). Native UI
from enabled bundled plugins remains available. See
[Enable custom plugin UI](/plugins/feature-plugins#enable-custom-plugin-ui) for
restart and browser reload requirements. This gate does not disable the
plugin's backend APIs or the sandboxed dashboard bindings below.

```json
{
  "controlUi": {
    "entry": "dist/control-ui/<content-hash>/index.js",
    "styles": ["dist/control-ui/<content-hash>/index.css"]
  }
}
```

Use `package.json.openclaw.controlUi` for the source entry and let
`openclaw plugins build` generate this declaration. Native UI executes with the
browser application's trust; it is distinct from the scoped dashboard widget
bindings below. See [Feature plugins](/plugins/feature-plugins) for authoring,
replacements, reload, and activation receipts.

## dashboard reference

`dashboard` lets an enabled plugin expose existing Gateway RPCs to granted dashboard widgets without adding plugin policy to core. Data bindings must name a method the same plugin registers with `operator.read`; action verbs must name a method it registers with `operator.write`. A mismatch rejects the plugin during registration.

```json
{
  "dashboard": {
    "dataBindings": [
      {
        "id": "items.list",
        "method": "example.items.list",
        "description": "List example items."
      }
    ],
    "actionVerbs": [
      {
        "id": "refresh",
        "method": "example.items.refresh",
        "description": "Refresh example items.",
        "paramShape": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "force": { "type": "boolean" }
          }
        }
      }
    ]
  }
}
```

The manifest ids are plugin-local. Widget grants use `<plugin-id>.<id>`, such as `example.items.list` and `example.refresh`. To keep the persisted grant namespace unambiguous, OpenClaw escapes `%` and `.` in the plugin-id segment as `%25` and `%2E`; ordinary plugin ids keep the natural form. `paramShape` is an optional JSON Schema applied to the action params object before OpenClaw invokes the plugin RPC.

## catalog reference

`catalog` provides optional display hints to plugin browsers. Hosts may ignore these hints. They never install or enable the plugin, and they do not change its runtime behavior or trust level.

```json
{
  "catalog": {
    "featured": true,
    "order": 10
  }
}
```

| Field      | Type      | What it means                                                              |
| ---------- | --------- | -------------------------------------------------------------------------- |
| `featured` | `boolean` | Whether catalog surfaces should feature this plugin.                       |
| `order`    | `number`  | Ascending display hint among curated plugins; lower values appear earlier. |

## cliCommands reference

Declare every plugin-owned root command in `cliCommands` so root help and command-owner routing stay metadata-only:

```json
{
  "cliCommands": [
    {
      "name": "example",
      "description": "Manage the example integration",
      "hasSubcommands": true
    }
  ]
}
```

The manifest row is the canonical help text. Register the same command at runtime with `api.registerCli(..., { descriptors: [...] })`; runtime descriptors may additionally provide `machineOutput`. Nested commands such as `openclaw nodes <feature>` are not root commands and do not belong in `cliCommands`.

## commandAliases reference

Use `commandAliases` when a plugin owns a runtime command name that users may mistakenly put in `plugins.allow` or try to run as a root CLI command. OpenClaw uses this metadata for diagnostics without importing plugin runtime code.

If a plugin fails to load, invoking its declared `runtime-slash` command in chat returns the plugin name, a short failure reason, and recovery guidance (`openclaw doctor` and gateway logs). Unknown commands and commands belonging to intentionally disabled plugins keep their normal handling; manifest ownership alone does not make a command executable.

```json
{
  "commandAliases": [
    {
      "name": "dreaming",
      "kind": "runtime-slash",
      "cliCommand": "memory"
    }
  ]
}
```

| Field        | Required | Type              | What it means                                                           |
| ------------ | -------- | ----------------- | ----------------------------------------------------------------------- |
| `name`       | Yes      | `string`          | Command name that belongs to this plugin.                               |
| `kind`       | No       | `"runtime-slash"` | Marks the alias as a chat slash command rather than a root CLI command. |
| `cliCommand` | No       | `string`          | Related root CLI command to suggest for CLI operations, if one exists.  |

## qaRunners reference

Use `qaRunners` when a plugin contributes one or more transport runners beneath
the shared `openclaw qa` root. Keep this metadata cheap and static; the plugin
runtime still owns actual CLI registration through a lightweight
`qa-runner-api.ts` surface that exports matching `qaRunnerCliRegistrations`. For
plugins using the shipped `runtime-api.ts` contract, that legacy surface remains
accepted through 2026-10-01 while authors migrate. An
optional `adapterFactory` exposes the transport to shared QA scenarios without
changing the registered command's runner.

Module-backed flow scenarios are an adapter-owned execution form. Set
`adapterFactory.supportsModuleFlows` to `true` only when every adapter created
by that factory implements `prepareFlow`; QA planning excludes module flows
from implementations that do not declare support.

```json
{
  "qaRunners": [
    {
      "commandName": "matrix",
      "description": "Run the Docker-backed Matrix live QA lane against a disposable homeserver"
    }
  ]
}
```

| Field         | Required | Type     | What it means                                                      |
| ------------- | -------- | -------- | ------------------------------------------------------------------ |
| `commandName` | Yes      | `string` | Subcommand mounted beneath `openclaw qa`, for example `matrix`.    |
| `description` | No       | `string` | Fallback help text used when the shared host needs a stub command. |

The `adapterFactory` id must match `commandName`. Do not export registrations
for commands absent from the manifest.

## channelConfigs reference

Use `channelConfigs` when a channel plugin needs cheap config metadata before runtime loads. Read-only channel setup/status discovery can use this metadata directly for configured external channels when no setup entry is available, or when `setup.requiresRuntime: false` declares setup runtime unnecessary.

`channelConfigs` is plugin manifest metadata, not a new top-level user config section. Users still configure channel instances under `channels.<channel-id>`. OpenClaw reads manifest metadata to decide which plugin owns that configured channel before plugin runtime code executes.

For a channel plugin, `configSchema` and `channelConfigs` describe different paths:

- `configSchema` validates `plugins.entries.<plugin-id>.config`
- `channelConfigs.<channel-id>.schema` validates `channels.<channel-id>`

Non-bundled plugins that declare `channels[]` should also declare matching `channelConfigs` entries. Without them, OpenClaw can still load the plugin, but cold-path config schema, setup, and Control UI surfaces cannot know the channel-owned option shape or display-only UI hints until plugin runtime executes.

`channelConfigs.<channel-id>.commands.nativeCommandsAutoEnabled` and `nativeSkillsAutoEnabled` can declare static `auto` defaults for command config checks that run before channel runtime loads. Bundled channels can also publish the same defaults through `package.json#openclaw.channel.commands` alongside their other package-owned channel catalog metadata.

```json
{
  "channelConfigs": {
    "matrix": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "homeserverUrl": { "type": "string" }
        }
      },
      "uiHints": {
        "homeserverUrl": {
          "label": "Homeserver URL",
          "placeholder": "https://matrix.example.com"
        }
      },
      "label": "Matrix",
      "description": "Matrix homeserver connection",
      "commands": {
        "nativeCommandsAutoEnabled": true,
        "nativeSkillsAutoEnabled": true
      },
      "preferOver": ["matrix-legacy"]
    }
  }
}
```

Each channel entry can include:

| Field         | Type                     | What it means                                                                                                    |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `schema`      | `object`                 | JSON Schema for `channels.<id>`. Required for each declared channel config entry.                                |
| `uiHints`     | `Record<string, object>` | Optional labels, placeholders, sensitivity, and display-only presentation hints for that channel config section. |
| `label`       | `string`                 | Channel label merged into picker and inspect surfaces when runtime metadata is not ready.                        |
| `description` | `string`                 | Short channel description for inspect and catalog surfaces.                                                      |
| `commands`    | `object`                 | Static native command and native skill auto-defaults for pre-runtime config checks.                              |
| `preferOver`  | `string[]`               | Legacy or lower-priority plugin ids this channel should outrank in selection surfaces.                           |

### Replacing another channel plugin

Use `preferOver` when your plugin is the preferred owner for a channel id that another plugin can also provide. Common cases are a renamed plugin id, a standalone plugin that supersedes a bundled plugin, or a maintained fork that keeps the same channel id for config compatibility.

```json
{
  "id": "acme-chat",
  "channels": ["chat"],
  "channelConfigs": {
    "chat": {
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "webhookUrl": { "type": "string" }
        }
      },
      "preferOver": ["chat"]
    }
  }
}
```

When `channels.chat` is configured, OpenClaw considers both the channel id and the preferred plugin id. If the lower-priority plugin was only selected because it is bundled or enabled by default, OpenClaw disables it in the effective runtime config so one plugin owns the channel and its tools. Explicit user selection still wins: if the user explicitly enables both plugins (via `plugins.allow` or a material `plugins.entries` config), OpenClaw preserves that choice and reports duplicate channel/tool diagnostics instead of silently changing the requested plugin set.

Keep `preferOver` scoped to plugin ids that can really provide the same channel. It is not a general priority field and it does not rename user config keys.
