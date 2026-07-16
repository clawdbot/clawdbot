---
summary: "Install, configure, and manage OpenClaw plugins"
read_when:
  - Installing or configuring plugins
  - Understanding plugin discovery and load rules
  - Working with Codex/Claude-compatible plugin bundles
title: "Plugins"
sidebarTitle: "Getting Started"
doc-schema-version: 1
---

Plugins extend OpenClaw with channels, model providers, agent harnesses, tools,
skills, speech, realtime transcription, voice, media understanding, generation,
web fetch, web search, and other runtime capabilities.

Use this page to install a plugin, restart the Gateway, verify the runtime
loaded it, and route common setup failures. For command-only examples, see
[Manage plugins](/plugins/manage-plugins). For the generated inventory of
bundled, official external, and source-only plugins, see
[Plugin inventory](/plugins/plugin-inventory).

## Requirements

- an OpenClaw checkout or installation with the `openclaw` CLI available
- network access to the selected source (ClawHub, npm, or a git host)
- any plugin-specific credentials, config keys, or OS tools named by that
  plugin's setup docs
- permission for the Gateway that serves your channels to reload or restart

## Quick start

<Steps>
  <Step title="Find the plugin">
    Search [ClawHub](/clawhub) for public plugin packages:

    ```bash
    openclaw plugins search "calendar"
    ```

    ClawHub is the primary discovery surface for community plugins. During the
    launch cutover, ordinary bare package specs still install from npm unless
    they match an official plugin id. Raw `@openclaw/*` specs that match a
    bundled plugin resolve to that bundled copy. Use an explicit source prefix
    when you need one source specifically.

  </Step>

  <Step title="Install the plugin">
    ```bash
    # From ClawHub.
    openclaw plugins install clawhub:<package>

    # From npm.
    openclaw plugins install npm:<package>

    # From git.
    openclaw plugins install git:github.com/<owner>/<repo>@<ref>

    # From a local development checkout.
    openclaw plugins install ./my-plugin
    openclaw plugins install --link ./my-plugin
    ```

    Treat plugin installs like running code. Prefer pinned versions for
    reproducible production installs. ClawHub packages and OpenClaw's
    bundled/official catalog are trusted sources. New arbitrary npm, git,
    local path/archive, `npm-pack:`, or marketplace sources require
    `--force` in noninteractive installs after you
    review and trust the source.

  </Step>

  <Step title="Configure and enable it">
    Configure plugin-specific settings under `plugins.entries.<id>.config`.
    Enable the plugin if it is not already enabled:

    ```bash
    openclaw plugins enable <plugin-id>
    ```

    If `plugins.allow` is set, the installed plugin id must be in that list
    before the plugin can load. `openclaw plugins install` adds the installed
    id to an existing `plugins.allow` list and removes the same id from
    `plugins.deny` so the explicit install can load after restart.

  </Step>

  <Step title="Let the Gateway reload">
    Installing, updating, or uninstalling plugin code requires a Gateway
    restart. A managed Gateway with config reload enabled detects the changed
    plugin install record and restarts automatically. Otherwise, restart it
    yourself:

    ```bash
    openclaw gateway restart
    ```

    Enable/disable update config and the cold registry. A runtime inspect is
    still the clearest proof of live runtime surfaces.

  </Step>

  <Step title="Verify runtime registration">
    ```bash
    openclaw plugins inspect <plugin-id> --runtime --json
    ```

    Use `--runtime` to prove registered tools, hooks, services, Gateway
    methods, or plugin-owned CLI commands. Plain `inspect` is a cold manifest
    and registry check only.

  </Step>
</Steps>

## Configuration

### Choose an install source

| Source      | Use when                                                                       | Example                                                        |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| ClawHub     | You want OpenClaw-native discovery, scans, version metadata, and install hints | `openclaw plugins install clawhub:<package>`                   |
| npm         | You need direct npm registry or dist-tag workflows                             | `openclaw plugins install npm:<package>`                       |
| git         | You need a branch, tag, or commit from a repository                            | `openclaw plugins install git:github.com/<owner>/<repo>@<ref>` |
| local path  | You are developing or testing a plugin on the same machine                     | `openclaw plugins install --link ./my-plugin`                  |
| marketplace | You are installing a Claude-compatible marketplace plugin                      | `openclaw plugins install <plugin> --marketplace <source>`     |

Bare package specs have special compatibility behavior: a bare name that
matches a bundled plugin id uses that bundled source; a bare name that matches
an official external plugin id uses the official package catalog; any other
bare spec installs through npm during the launch cutover. Raw `@openclaw/*`
specs that match bundled plugins also resolve to the bundled copy before npm
fallback. Use `npm:@openclaw/<plugin>@<version>` to deliberately install the
external npm package instead of the bundled copy. Use `clawhub:`, `npm:`,
`git:`, or `npm-pack:` for deterministic source selection. See
[`openclaw plugins`](/cli/plugins#install) for the full command contract.

For npm installs, unpinned specs and `@latest` choose the newest stable
package that advertises compatibility with this OpenClaw build. If npm's
current latest release declares a newer `openclaw.compat.pluginApi` or
`openclaw.install.minHostVersion` than this build supports, OpenClaw scans
older stable versions and installs the newest one that fits. Exact versions
and explicit channel tags such as `@beta` stay pinned to the selected package
and fail when incompatible.

### Operator install policy

Configure `security.installPolicy` to run a trusted local policy command
before a plugin install or update proceeds. The policy receives metadata plus
the staged source path and can allow or block the install. It covers both CLI
and Gateway-backed install/update paths. Plugin `before_install` hooks run
later, and only in OpenClaw processes where plugin hooks are loaded, so use
`security.installPolicy` for operator-owned install decisions instead. The
deprecated `--dangerously-force-unsafe-install` flag is accepted for
compatibility but is a no-op: it does not bypass install policy or OpenClaw's
built-in plugin dependency denylist.

See [Skills config](/tools/skills-config#operator-install-policy-securityinstallpolicy)
for the shared `security.installPolicy` exec schema used by both skills and
plugins.

### Configure plugin policy

The common plugin config shape is:

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-plugin"] },
    slots: { memory: "memory-core" },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Key policy rules:

- `plugins.enabled: false` disables all plugins and skips discovery/load
  work. Stale plugin references stay inert while this is active; re-enable
  plugins before running doctor cleanup if you want stale ids removed.
- `plugins.deny` wins over allow and per-plugin enablement.
- `plugins.allow` is an exclusive allowlist. Plugin-owned tools outside the
  allowlist stay unavailable even when `tools.allow` includes `"*"`.
- `plugins.entries.<id>.enabled: false` disables one plugin while keeping its
  config.
- `plugins.load.paths` adds explicit local plugin files or directories.
  Managed `plugins install` local paths must be plugin directories or
  archives; use `plugins.load.paths` for standalone plugin files.
- Workspace-origin plugins are disabled by default; explicitly enable or
  allowlist them before using local workspace code.
- Bundled plugins follow their built-in default-on/default-off metadata
  unless config explicitly overrides it.
- `plugins.slots.<slot>` (`memory` or `contextEngine`) picks one plugin for an
  exclusive category. Slot selection counts as explicit activation and
  force-enables the selected plugin for that slot, even if it would otherwise
  be opt-in. `plugins.deny` and `plugins.entries.<id>.enabled: false` still
  block it.
- Bundled opt-in plugins can auto-activate when config names one of their
  owned surfaces, such as a provider/model ref, channel config, CLI backend,
  or agent harness runtime.
- OpenAI-family Codex routing keeps provider and runtime plugin boundaries
  separate: legacy Codex model refs are legacy config that doctor repairs,
  while the bundled `codex` plugin owns Codex app-server runtime for
  canonical `openai/*` agent refs, explicit `agentRuntime.id: "codex"`, and
  legacy `codex/*` refs.

When `plugins.allow` is unset and non-bundled plugins are auto-discovered from
the workspace or global plugin roots, startup logs
`plugins.allow is empty; discovered non-bundled plugins may auto-load: ...`
with the discovered plugin ids and, for short lists, a minimal `plugins.allow`
snippet. Run [`openclaw plugins list --enabled --verbose`](/cli/plugins#list)
or [`openclaw plugins inspect <id>`](/cli/plugins#inspect) on the listed
plugin id before copying trusted plugins into `openclaw.json`. The same
trust-pinning applies when diagnostics say a plugin loaded
`without install/load-path provenance`: inspect that plugin id, then pin it in
`plugins.allow` or reinstall from a trusted source so OpenClaw records install
provenance.

Run `openclaw doctor` or `openclaw doctor --fix` when config validation
reports stale plugin ids, allowlist/tool mismatches, or legacy bundled plugin
paths.

## Understand plugin formats

OpenClaw recognizes two plugin formats:

| Format                 | How it loads                                                                 | Use when                                                               |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Native OpenClaw plugin | `openclaw.plugin.json` plus a runtime module loaded in process               | You are installing or building OpenClaw-specific runtime capabilities  |
| Compatible bundle      | Codex, Claude, or Cursor plugin layout mapped into OpenClaw plugin inventory | You are reusing compatible skills, commands, hooks, or bundle metadata |

Both formats appear in `openclaw plugins list`, `openclaw plugins inspect`,
`openclaw plugins enable`, and `openclaw plugins disable`. See
[Plugin bundles](/plugins/bundles) for the bundle compatibility boundary and
[Building plugins](/plugins/building-plugins) for native plugin authoring.

## Plugin hooks

Plugins can register hooks at runtime through two different APIs:

- `api.on(...)` typed hooks for runtime lifecycle events. This is the
  preferred surface for middleware, policy, message rewriting, prompt
  shaping, and tool control.
- `api.registerHook(...)` for the internal hook system described in
  [Hooks](/automation/hooks). This is mainly for coarse command/lifecycle side
  effects and compatibility with existing HOOK-style automation.

Quick rule: if the handler needs priority, merge semantics, or
block/cancel behavior, use typed hooks. If it just reacts to `command:new`,
`command:reset`, `message:sent`, or similar coarse events, `api.registerHook`
is fine.

Plugin-managed internal hooks show up in `openclaw hooks list` with
`plugin:<id>`. You cannot enable or disable them through `openclaw hooks`;
enable or disable the plugin instead.

## Verify the active Gateway

`openclaw plugins list` and plain `openclaw plugins inspect` read cold config,
manifest, and registry state. They do not prove that an already-running
Gateway has imported the same plugin code.

When a plugin appears installed but live chat traffic does not use it:

```bash
openclaw gateway status --deep --require-rpc
openclaw plugins inspect <plugin-id> --runtime --json
openclaw gateway restart
```

Managed Gateways restart automatically after plugin install, update, and
uninstall changes that alter plugin source. On VPS or container installs, make
sure any manual restart targets the actual `openclaw gateway run` child that
serves your channels, not only a wrapper or supervisor.

## Troubleshooting

| Symptom                                                        | Check                                                                                                                                      | Fix                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Plugin appears in `plugins list` but runtime hooks do not run  | Use `openclaw plugins inspect <id> --runtime --json` and confirm the active Gateway with `gateway status --deep --require-rpc`             | Restart the live Gateway after install, update, config, or source changes                               |
| Duplicate channel or tool ownership diagnostics appear         | Run `openclaw plugins list --enabled --verbose`, inspect each suspected plugin with `--runtime --json`, and compare channel/tool ownership | Disable one owner, remove stale installs, or use manifest `preferOver` for intentional replacement      |
| Config says a plugin is missing                                | Check [Plugin inventory](/plugins/plugin-inventory) for whether it is bundled, official external, or source-only                           | Install the external package, enable the bundled plugin, or remove stale config                         |
| Config is invalid during install                               | Read the validation message and run `openclaw doctor --fix` if it points to stale plugin state                                             | Doctor can quarantine invalid plugin config by disabling the entry and removing the invalid payload     |
| Plugin path is blocked for suspicious ownership or permissions | Inspect the diagnostic before the config error                                                                                             | Fix filesystem ownership/permissions, then run `openclaw plugins registry --refresh`                    |
| `OPENCLAW_NIX_MODE=1` blocks lifecycle commands                | Confirm the install is managed by Nix                                                                                                      | Change plugin selection in the Nix source instead of using plugin mutator commands                      |
| Dependency import fails at runtime                             | Check whether the plugin was installed through npm/git/ClawHub or loaded from a local path                                                 | Run `openclaw plugins update <id>`, reinstall the source, or install local plugin dependencies yourself |

When stale plugin config still names a no-longer-discoverable channel plugin,
config validation downgrades that channel key to a warning instead of a hard
failure, so Gateway startup can still serve every other channel. Run
`openclaw doctor --fix` to remove stale plugin and channel entries. Unknown
channel keys without stale-plugin evidence still fail validation so typos
stay visible.

For intentional channel replacement, the preferred plugin should declare
`channelConfigs.<channel-id>.preferOver` with the legacy or lower-priority
plugin id. If both plugins are explicitly enabled, OpenClaw keeps that request
and reports duplicate channel/tool diagnostics instead of silently choosing
one owner.

If an installed package reports that it `requires compiled runtime output for
TypeScript entry ...`, the package was published without the JavaScript files
OpenClaw needs at runtime. Update or reinstall after the publisher ships
compiled JavaScript, or disable/uninstall the plugin until then.

### Blocked plugin path ownership

If diagnostics say
`blocked plugin candidate: suspicious ownership (... uid=1000, expected uid=0 or root)`
and validation follows with `plugin present but blocked`, OpenClaw found
plugin files owned by a different Unix user than the process loading them.
Keep the plugin config in place; fix the filesystem ownership or run OpenClaw
as the same user that owns the state directory.

For Docker installs, the official image runs as `node` (uid `1000`), so the
host bind-mounted OpenClaw config and workspace directories should normally be
owned by uid `1000`:

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

If you intentionally run OpenClaw as root, repair the managed plugin root to
root ownership instead:

```bash
sudo chown -R root:root /path/to/openclaw-config/npm
```

After fixing ownership, rerun `openclaw doctor --fix` or
`openclaw plugins registry --refresh` so the persisted plugin registry
matches the repaired files.

### Slow plugin tool setup

If agent turns appear to stall while preparing tools, enable trace logging
and check for plugin tool factory timing lines:

```bash
openclaw config set logging.level trace
openclaw logs --follow
```

Look for:

```text
[trace:plugin-tools] factory timings ...
```

The summary lists total factory time and the slowest plugin tool factories,
including plugin id, declared tool names, result shape, and whether the tool
is optional. Slow lines are promoted to warnings when a single factory takes
at least 1s or total plugin tool factory prep takes at least 5s.

OpenClaw caches successful plugin tool factory results for repeated
resolutions with the same effective request context. The cache key includes
the effective runtime config, workspace and agent id, sandbox policy, browser
settings, delivery context, requester identity, and ownership state, so
factories that depend on those trusted fields re-run when the context
changes. If timings stay high, the plugin may be doing expensive work before
returning its tool definitions.

If one plugin dominates the timing, inspect its runtime registrations:

```bash
openclaw plugins inspect <plugin-id> --runtime --json
```

Then update, reinstall, or disable that plugin. Plugin authors should move
expensive dependency loading behind the tool execution path instead of doing
it inside the tool factory.

For dependency roots, package metadata validation, registry records, startup
reload behavior, and legacy cleanup, see
[Plugin dependency resolution](/plugins/dependency-resolution).

## Related

- [Manage plugins](/plugins/manage-plugins) - command examples for list, install, update, uninstall, and publish
- [`openclaw plugins`](/cli/plugins) - full CLI reference
- [Plugin inventory](/plugins/plugin-inventory) - generated bundled and external plugin list
- [Plugin reference](/plugins/reference) - generated per-plugin reference pages
- [Community plugins](/plugins/community) - ClawHub discovery and docs PR policy
- [Plugin dependency resolution](/plugins/dependency-resolution) - install roots, registry records, and runtime boundaries
- [Building plugins](/plugins/building-plugins) - native plugin authoring guide
- [Plugin SDK overview](/plugins/sdk-overview) - runtime registration, hooks, and API fields
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
