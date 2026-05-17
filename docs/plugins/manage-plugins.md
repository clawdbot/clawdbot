---
summary: "Quick examples for listing, installing, updating, inspecting, and uninstalling OpenClaw plugins"
read_when:
  - You want quick plugin list, install, update, inspect, or uninstall examples
  - You want to choose a plugin install source
  - You want the right reference for publishing plugin packages
title: "Manage plugins"
sidebarTitle: "Manage plugins"
doc-schema-version: 1
---

Use this page for common plugin management commands. For the exhaustive command
contract, flags, source-selection rules, and edge cases, see
[`openclaw plugins`](/cli/plugins).

Most install workflows are:

1. find a package
2. install it from ClawHub, npm, git, or a local path
3. let the managed Gateway auto-restart, or restart it manually when unmanaged
4. verify the plugin's runtime registrations

## List and search plugins

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
openclaw plugins search "calendar"
```

Use `--json` for scripts:

```bash
openclaw plugins list --json \
  | jq '.plugins[] | {id, enabled, format, source, dependencyStatus}'
```

`plugins list` is a cold inventory check. It shows what OpenClaw can discover
from config, manifests, and the plugin registry; it does not prove that an
already-running Gateway imported the plugin runtime. The JSON output includes
registry diagnostics and each plugin's static `dependencyStatus` when the
plugin package declares `dependencies` or `optionalDependencies`.

`plugins search` queries ClawHub for installable plugin packages and prints
install hints such as `openclaw plugins install clawhub:<package>`.

## Install plugins

```bash
# Search ClawHub for plugin packages.
openclaw plugins search "calendar"

# Install from ClawHub.
openclaw plugins install clawhub:<package>
openclaw plugins install clawhub:<package>@1.2.3
openclaw plugins install clawhub:<package>@beta

# Install from npm.
openclaw plugins install npm:<package>
openclaw plugins install npm:@scope/openclaw-plugin@1.2.3
openclaw plugins install npm:@openclaw/codex

# Install from a local npm pack artifact.
openclaw plugins install npm-pack:<path.tgz>

# Install from git or a local development checkout.
openclaw plugins install git:github.com/acme/openclaw-plugin@v1.0.0
openclaw plugins install ./my-plugin
openclaw plugins install --link ./my-plugin
```

Bare package specs install from npm during the launch cutover. Use `clawhub:`,
`npm:`, `git:`, or `npm-pack:` when you need deterministic source selection.
If the bare name matches an official plugin id, OpenClaw can install the
catalog entry directly.

Use `--force` only when you intentionally want to overwrite an existing install
target. For routine upgrades of tracked npm, ClawHub, or hook-pack installs, use
`openclaw plugins update`.

## Restart and inspect

After installing, updating, or uninstalling plugin code, a running managed
Gateway with config reload enabled restarts automatically. If the Gateway is not
managed or reload is disabled, restart it yourself before checking live runtime
surfaces:

```bash
openclaw gateway restart
openclaw plugins inspect <plugin-id> --runtime --json
```

Use `inspect --runtime` when you need proof that the plugin registered runtime
surfaces such as tools, hooks, services, Gateway methods, HTTP routes, or
plugin-owned CLI commands. Plain `inspect` and `list` are cold manifest,
config, and registry checks.

## Update plugins

```bash
openclaw plugins update <plugin-id>
openclaw plugins update <npm-package-or-spec>
openclaw plugins update --all
openclaw plugins update <plugin-id> --dry-run
```

When you pass a plugin id, OpenClaw reuses the tracked install spec. Stored
dist-tags such as `@beta` and exact pinned versions continue to be used on
later `update <plugin-id>` runs.

For npm installs, you can pass an explicit package spec to switch the tracked
record:

```bash
openclaw plugins update @scope/openclaw-plugin@beta
openclaw plugins update @scope/openclaw-plugin
```

The second command moves a plugin back to the registry's default release line
when it was previously pinned to an exact version or tag.

When `openclaw update` runs on the beta channel, plugin records can prefer
matching `@beta` releases. For the exact fallback and pinning rules, see
[`openclaw plugins`](/cli/plugins#update).

## Uninstall plugins

```bash
openclaw plugins uninstall <plugin-id> --dry-run
openclaw plugins uninstall <plugin-id>
openclaw plugins uninstall <plugin-id> --keep-files
```

Uninstall removes the plugin's config entry, persisted plugin index record,
allow/deny list entries, and linked load paths when applicable. Managed install
directories are removed unless you pass `--keep-files`. A running managed
Gateway restarts automatically when the uninstall changes plugin source.

In Nix mode (`OPENCLAW_NIX_MODE=1`), plugin install, update, uninstall, enable,
and disable commands are disabled. Manage those choices in the Nix source for
the install instead.

## Choose a source

| Source      | Use when                                                                    | Example                                                        |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| ClawHub     | You want OpenClaw-native discovery, scan summaries, versions, and hints     | `openclaw plugins install clawhub:<package>`                   |
| npmjs.com   | You already ship JavaScript packages or need npm dist-tags/private registry | `openclaw plugins install npm:@acme/openclaw-plugin`           |
| git         | You want a branch, tag, or commit from a repository                         | `openclaw plugins install git:github.com/<owner>/<repo>@<ref>` |
| local path  | You are developing or testing a plugin on the same machine                  | `openclaw plugins install --link ./my-plugin`                  |
| npm pack    | You are proving a local package artifact through npm install semantics      | `openclaw plugins install npm-pack:<path.tgz>`                 |
| marketplace | You are installing a Claude-compatible marketplace plugin                   | `openclaw plugins install <plugin> --marketplace <source>`     |

## Publish plugins

ClawHub is the primary public discovery surface for OpenClaw plugins. Publish
there when you want users to find plugin metadata, version history, registry
scan results, and install hints before they install.

```bash
npm i -g clawhub
clawhub login
clawhub package publish your-org/your-plugin --dry-run
clawhub package publish your-org/your-plugin
clawhub package publish your-org/your-plugin@v1.0.0
```

Native npm plugins must include a plugin manifest and package metadata before
publishing:

```json package.json
{
  "name": "@acme/openclaw-plugin",
  "version": "1.0.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

```bash
npm publish --access public
openclaw plugins install npm:@acme/openclaw-plugin
openclaw plugins install npm:@acme/openclaw-plugin@beta
openclaw plugins install npm:@acme/openclaw-plugin@1.0.0
```

Use these pages for the full publishing contract instead of treating this page
as the publishing reference:

- [ClawHub publishing](/clawhub/publishing) explains owners, scopes, releases,
  review, package validation, and package transfer.
- [Building plugins](/plugins/building-plugins) shows the plugin package shape
  and first publish workflow.
- [Plugin manifest](/plugins/manifest) defines native plugin manifest fields.

If the same package is available on both ClawHub and npm, use the explicit
`clawhub:` or `npm:` prefix when you need to force one source.

## Related

- [Plugins](/tools/plugin) - install, configure, restart, and troubleshoot
- [`openclaw plugins`](/cli/plugins) - full CLI reference
- [Community plugins](/plugins/community) - public discovery and ClawHub publishing
- [ClawHub](/clawhub/cli) - registry CLI operations
- [Building plugins](/plugins/building-plugins) - create a plugin package
- [Plugin manifest](/plugins/manifest) - manifest and package metadata
