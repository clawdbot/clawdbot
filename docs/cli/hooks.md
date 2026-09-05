---
summary: "CLI reference for internal hook discovery, eligibility, enablement, and hook packs"
read_when:
  - You want to inspect internal hooks on a local or remote Gateway
  - You want to enable or disable a hook in local config
  - You need hook command flags or JSON report fields
title: "Hooks"
doc-schema-version: 1
---

# `openclaw hooks`

Inspect and configure [internal hooks](/automation/hooks): handlers for command,
message, session, and Gateway events. Bare `openclaw hooks` runs the same report
as `openclaw hooks list`. These commands do not manage HTTP
[Webhooks](/automation/cron-jobs#webhooks) or the typed `api.on(...)` hook catalog in
[Plugin hooks](/plugins/hooks).

## Target and scope

Read-only reports (`hooks`, `list`, `info`, `check`) first call `hooks.status` on
the selected Gateway. Configured remote Gateways and explicit
`OPENCLAW_GATEWAY_URL` targets are authoritative: missing remote URLs,
connection/authentication failures, and unsupported methods fail instead of
showing client-local hooks. An implicitly selected local Gateway can fall back
to local discovery when unavailable or when its hook-report method/agent
parameter is unsupported. Other errors are not silently replaced with local
inventory.

**Enable, disable, install, and update mutate local files/config/state.** They do
not change a remote Gateway over RPC. To change the server, run the command on
that host using its profile/config. Enable, disable, and config written by a new
install or link can activate immediately in the default `hybrid`
[reload mode](/gateway/configuration#reload-modes). `off` requires a manual
restart. Hook files and metadata are not watched; restart after editing them or
updating existing hook code.

`--agent <id>` selects the agent workspace used for inspection. It is required
when configured agents do not have an implicit owner; blank or unknown IDs
fail. The option works before or after `list`, `info`, `check`, `enable`, and
`disable`. It does not scope the persisted hook entry to that agent and is not
supported on install/update. See
[Local, remote, and agent scope](/automation/hooks#local-remote-and-agent-scope)
for the distinction between workspace inventory and Gateway loading.

## List hooks

```bash
openclaw hooks [--agent <id>] [--json]
openclaw hooks list [--agent <id>] [--eligible] [--json] [-v|--verbose]
```

Discovery includes bundled hooks, active plugin hooks, managed hooks, extra
directories, and the selected workspace. Hook-name collisions follow the
[source policy](/automation/hooks#hook-discovery).

| Option          | Meaning                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`  | Select the workspace to inspect.                                                                                        |
| `--eligible`    | Show only `loadable` hooks: enabled by per-hook/source policy, requirements satisfied, and at least one declared event. |
| `--json`        | Write structured JSON directly to stdout. Also accepted on the parent `hooks` command.                                  |
| `-v, --verbose` | Add the Missing column to the human-readable table.                                                                     |

Human output is a table with Status, Hook, Description, and Source columns,
preceded by `Hooks (<ready>/<total> ready)`. Plugin-managed sources appear as
`plugin:<id>`.

<Note>
`ready`, `eligible`, and `loadable` are inventory results, not a live handler
registration check. The report does not apply the Gateway's master switch or
configured-name selection, import the handler to prove it works, or verify that
the event has run. A bundled hook can appear ready while the internal hook
system is off. Enable the intended hook and
[verify its real side effect](/automation/hooks#quick-start).
</Note>

### List JSON

The root object contains `workspaceDir`, `managedHooksDir`, and `hooks`.
Each hook includes:

- Identity/display: `name`, `description`, `source`, optional `pluginId`,
  `emoji`, `homepage`, and `managedByPlugin`.
- Status: `enabledByConfig`, `requirementsSatisfied`, `loadable`, optional
  `blockedReason`, plus compatibility aliases `eligible` (`loadable`) and
  `disabled` (`!enabledByConfig`).
- Events/requirements: `events`, `unknownEvents`, and `missing`, whose arrays
  are `bins`, `anyBins`, `env`, `config`, and `os`.

`blockedReason` can be `disabled in config`, `workspace hook (disabled by default)`,
`missing requirements`, or `no events defined`. Unknown events are
advisory: they do not by themselves make a hook unloadable.

## Get hook info

```bash
openclaw hooks info <name> [--agent <id>] [--json]
```

Accepts a hook name or its metadata `hookKey`. Exact hook names take precedence
over matching keys; a key must identify a single hook. Shows source, descriptor
and handler paths, homepage, events, unknown-event warnings, blocked reason, and
per-requirement status. A missing or ambiguous hook exits with code 1; an
ambiguous selector lists candidates so you can choose a unique name or key.

JSON includes the list fields plus `filePath`, `baseDir`, `handlerPath`,
`hookKey`, `always`, `requirements`, `configChecks`, and normalized `install`
options. Each config check has `path` and `satisfied`; each install option has
`id`, `kind`, `label`, and `bins`. Install options are descriptive metadata, not
a command to install dependencies automatically.

## Check eligibility

```bash
openclaw hooks check [--agent <id>] [--json]
```

Prints totals for ready/not-ready hooks and lists blocking reasons. JSON has
`total`, `eligible`, `notEligible`, and `hooks` containing an `eligible` name
array and a `notEligible` array of `{ name, blockedReason?, missing }` objects.

A successful report exits with code 0 even when hooks are not ready. For an
automated eligibility gate, inspect the JSON counts rather than treating the
exit code as an all-hooks-ready result. This still does not test actual loading.

## Enable a hook

```bash
openclaw hooks enable <name> [--agent <id>]
```

Discovers the hook locally, then writes
`hooks.internal.entries.<hookKey>.enabled = true` and
`hooks.internal.enabled = true` in local config. Other fields in that entry are
preserved. Exact hook names take precedence over matching keys; ambiguous key
matches fail without writing.

Enable fails for a missing hook, a plugin-managed hook, or unmet runtime
requirements. It can enable a currently disabled workspace hook. This does not
prove a valid module export or event subscription; inspect `info` and the
Gateway logs too.

The entry is **global**, even with `--agent`: it applies wherever that key is
discovered. Adding named entries can narrow a previously open-ended directory
selection. See [Configuration](/automation/hooks#configuration).

The running Gateway reloads the selection in `hybrid` mode. If a selected hook
cannot load, it keeps the previous handlers; inspect Gateway logs. Reload does
not replay `gateway:startup`, so `boot-md` runs on the next Gateway start.

## Disable a hook

```bash
openclaw hooks disable <name> [--agent <id>]
```

Writes `hooks.internal.entries.<hookKey>.enabled = false`. It does not remove the
hook files or change the master switch. Missing/ambiguous and plugin-managed
hooks are rejected; missing runtime requirements do not prevent disabling.
In `hybrid` mode, subsequent events use the updated selection. An event already
running finishes with its original handlers.

Plugin-managed hooks cannot be toggled by these commands. Enable or disable the
owning plugin through [`openclaw plugins`](/cli/plugins).

## Install and update hook packs

Use the unified plugin installer for reviewed hook packs:

```bash
openclaw plugins install npm:<package>
openclaw plugins install npm:<package>@<version> --pin
openclaw plugins install ./my-hook-pack
openclaw plugins install ./my-hook-pack.tgz

openclaw plugins update <id> --dry-run
openclaw plugins update <id>
```

A pack declares hook directories in `package.json` under `openclaw.hooks`.
A local directory without `package.json` can contain a single `HOOK.md` and
handler. Copied hook packs are installed into `<stateDir>/hooks/<id>`; their
hooks are enabled in config and install provenance is recorded in shared SQLite
state. That config can activate the hooks immediately in `hybrid` mode. Do not author
`hooks.internal.installs` in `openclaw.json`.

For the npm hook-pack path, specs are registry-only: package name with an
optional exact version or dist-tag. Git/URL/file specs, npm aliases, and semver
ranges are not npm registry specs. Bare specs and `@latest` stay on the stable
track; a prerelease resolution requires an explicit prerelease version or a
non-latest tag such as `@beta` or `@rc`. Use `npm:` to select npm explicitly; the
unified installer supports other plugin sources described in
[`openclaw plugins`](/cli/plugins).

Supported local archives are `.zip`, `.tgz`, `.tar.gz`, and `.tar`. Copied hook
packs resolve runtime packages from `dependencies` and `optionalDependencies`,
including packs with only optional dependencies. Packages listed only in
`devDependencies` are omitted. npm pack and dependency installation use
`--ignore-scripts`; this does not sandbox the installed handler.
The download always creates an archive in OpenClaw's temporary workspace,
regardless of npm's `dry-run` or `pack-destination` settings.

### Install options and trust

| Option                                 | Effect for hook packs                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `-l, --link`                           | Add the exact local hook or pack root to `hooks.internal.load.extraDirs` instead of copying it. Single hooks and nested pack layouts work.  |
| `--pin`                                | Record the resolved exact npm `name@version` in install state when available; does not apply to local paths.                                |
| `--force`                              | Acknowledge a non-ClawHub source and allow replacement of an existing copied install. For links it acknowledges the source without copying. |
| `--acknowledge-install-policy-warning` | Acknowledge an operator `security.installPolicy` warning without its prompt. Blocks and policy failures still stop the install.             |

Interactive non-ClawHub installs ask you to confirm trust. Noninteractive
installs require `--force`; neither `plugins install` nor the `hooks install`
alias accepts a `--yes` flag. `--force` is also not a substitute for
acknowledging an install-policy warning. Review the source before supplying
either acknowledgement.

<Warning>
A linked hook runs directly from the supplied path; linking does not copy it
or create a symlink. A single-hook root loads its own `HOOK.md` and handler.
A pack loads only the hook directories listed in `openclaw.hooks`, including
nested paths such as `./hooks/my-hook`. Declared paths must stay inside the
pack and point directly to hooks; discovery does not recurse into nested packs
or collections, or scan unlisted children, even when all declared paths are rejected.

Only link trusted code. Extra directories still make directory-hook name
selection open-ended across discovery sources, not just within the linked
pack. Linking can activate the hooks immediately in `hybrid` mode. Restart after
editing existing hook code or metadata, check `hooks list`, and
[verify the handler's actual side effect](/automation/hooks#quick-start).
</Warning>

### Update behavior

Updates use tracked npm install records. A tracked hook-pack ID uses its stored
spec; a matching npm package spec can select a new version/tag. Local path and
archive records are not refreshed by the npm hook updater.

`--dry-run` reports what would change without installing or rewriting config.
`--all` selects **both plugins and hook packs** in the unified updater, including
when reached through the deprecated alias; it is not a hooks-only bulk command.

When an applicable stored integrity hash differs from the downloaded artifact,
the updater warns and asks for confirmation in the terminal. No CLI flag answers
that prompt: neither `plugins update` nor the `hooks update` alias accepts
`--yes`, and `--acknowledge-install-policy-warning` covers only install-policy
warnings. `--dry-run` reports the drift without prompting.

### Deprecated aliases

These commands print a deprecation warning and forward to the unified owners:

```bash
openclaw hooks install <path-or-spec> [-l|--link] [--pin] [--force] [--acknowledge-install-policy-warning]
openclaw hooks update [id] [--all] [--dry-run] [--acknowledge-install-policy-warning]
```

For update, provide `id` or `--all`. The aliases do not accept `--agent` and are
not the preferred interface for new automation.

## Bundled hooks

The maintained catalog, event subscriptions, options, and verification notes
are in [Bundled hooks](/automation/hooks#bundled-hooks). This includes
`boot-md`, `bootstrap-extra-files`, `command-logger`, `compaction-notifier`, and
`session-memory` (manual **and automatic** reset capture).

### command-logger log file

On the Gateway host, with the default state directory:

```bash
tail -n 20 ~/.openclaw/logs/commands.log
jq . ~/.openclaw/logs/commands.log
jq 'select(.action == "new")' ~/.openclaw/logs/commands.log
```

Use `<stateDir>/logs/commands.log` for a custom state directory. These records
contain session and sender identifiers; protect access and arrange retention or
rotation. The hook does not rotate them.

## Notes

Report commands support `--json`; success JSON goes directly to stdout. Failures
use the standard [CLI JSON failure envelope](/cli#json-failures), and missing
hook info also includes the requested `hook` name. Reports do not execute a hook
as a test.

The hidden `hooks relay` command is reserved for generated native harness
integration. It is not an internal-hook testing or manual event-trigger command.

## Related

- [CLI reference](/cli)
- [Automation hooks](/automation/hooks)
- [Plugin hooks](/plugins/hooks)
- [Plugins CLI](/cli/plugins)
