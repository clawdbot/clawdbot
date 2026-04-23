---
summary: "CLI reference for `openclaw plugins` (list, install, marketplace, uninstall, enable/disable, doctor)"
read_when:
  - You want to install or manage Gateway plugins or compatible bundles
  - You want to debug plugin load failures
title: "Plugins"
---

# `openclaw plugins`

Manage Gateway plugins, hook packs, and compatible bundles.

Related:

- Plugin system: [Plugins](/tools/plugin)
- Bundle compatibility: [Plugin bundles](/plugins/bundles)
- Plugin manifest + schema: [Plugin manifest](/plugins/manifest)
- Security hardening: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
openclaw plugins install <path-or-spec>
openclaw plugins inspect <id>
openclaw plugins inspect <id> --json
openclaw plugins inspect --all
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins marketplace list <marketplace>
openclaw plugins marketplace list <marketplace> --json
```

Bundled plugins ship with OpenClaw. Some are enabled by default (for example
bundled model providers, bundled speech providers, and the bundled browser
plugin); others require `plugins enable`.

Native OpenClaw plugins must ship `openclaw.plugin.json` with an inline JSON
Schema (`configSchema`, even if empty). Compatible bundles use their own bundle
manifests instead.

`plugins list` shows `Format: openclaw` or `Format: bundle`. Verbose list/info
output also shows the bundle subtype (`codex`, `claude`, or `cursor`) plus detected bundle
capabilities.

### Install

```bash
openclaw plugins install <package>                      # ClawHub first, then npm
openclaw plugins install clawhub:<package>              # ClawHub only
openclaw plugins install <package> --force              # overwrite existing install
openclaw plugins install <package> --pin                # pin version
openclaw plugins install <package> --dangerously-force-unsafe-install
openclaw plugins install <path>                         # local path
openclaw plugins install <plugin>@<marketplace>         # marketplace
openclaw plugins install <plugin> --marketplace <name>  # marketplace (explicit)
openclaw plugins install <plugin> --marketplace https://github.com/<owner>/<repo>
```

Bare package names are checked against ClawHub first, then npm. Security note:
treat plugin installs like running code. Prefer pinned versions.

If your `plugins` section is backed by a single-file `$include`, `plugins install/update/enable/disable/uninstall` write through to that included file and leave `openclaw.json` untouched. Root includes, include arrays, and includes with sibling overrides fail closed instead of flattening. See [Config includes](/gateway/configuration) for the supported shapes.

If config is invalid, `plugins install` normally fails closed and tells you to
run `openclaw doctor --fix` first. The only documented exception is a narrow
bundled-plugin recovery path for plugins that explicitly opt into
`openclaw.install.allowInvalidConfigRecovery`.

`--force` reuses the existing install target and overwrites an already-installed
plugin or hook pack in place. Use it when you are intentionally reinstalling
the same id from a new local path, archive, ClawHub package, or npm artifact.
For routine upgrades of an already tracked npm plugin, prefer
`openclaw plugins update <id-or-npm-spec>`.

If you run `plugins install` for a plugin id that is already installed, OpenClaw
stops and points you at `plugins update <id-or-npm-spec>` for a normal upgrade,
or at `plugins install <package> --force` when you genuinely want to overwrite
the current install from a different source.

`--pin` applies to npm installs only. It is not supported with `--marketplace`,
because marketplace installs persist marketplace source metadata instead of an
npm spec.

`--dangerously-force-unsafe-install` is a break-glass option for false positives
in the built-in dangerous-code scanner. It allows the install to continue even
when the built-in scanner reports `critical` findings, but it does **not**
bypass plugin `before_install` hook policy blocks and does **not** bypass scan
failures.

This CLI flag applies to plugin install/update flows. Gateway-backed skill
dependency installs use the matching `dangerouslyForceUnsafeInstall` request
override, while `openclaw skills install` remains a separate ClawHub skill
download/install flow.

`plugins install` is also the install surface for hook packs that expose
`openclaw.hooks` in `package.json`. Use `openclaw hooks` for filtered hook
visibility and per-hook enablement, not package installation.

Npm specs are **registry-only** (package name + optional **exact version** or
**dist-tag**). Git/URL/file specs and semver ranges are rejected. Dependency
installs run with `--ignore-scripts` for safety.

Bare specs and `@latest` stay on the stable track. If npm resolves either of
those to a prerelease, OpenClaw stops and asks you to opt in explicitly with a
prerelease tag such as `@beta`/`@rc` or an exact prerelease version such as
`@1.2.3-beta.4`.

If a bare install spec matches a bundled plugin id (for example `diffs`), OpenClaw
installs the bundled plugin directly. To install an npm package with the same
name, use an explicit scoped spec (for example `@scope/diffs`).

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Claude marketplace installs are also supported.

ClawHub installs use an explicit `clawhub:<package>` locator:

```bash
openclaw plugins install clawhub:openclaw-codex-app-server
openclaw plugins install clawhub:openclaw-codex-app-server@1.2.3
```

OpenClaw now also prefers ClawHub for bare npm-safe plugin specs. It only falls
back to npm if ClawHub does not have that package or version:

```bash
openclaw plugins install openclaw-codex-app-server
```

OpenClaw downloads the package archive from ClawHub, checks the advertised
plugin API / minimum gateway compatibility, then installs it through the normal
archive path. Recorded installs keep their ClawHub source metadata for later
updates.

Use `plugin@marketplace` shorthand when the marketplace name exists in Claude's
local registry cache at `~/.claude/plugins/known_marketplaces.json`:

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

Use `--marketplace` when you want to pass the marketplace source explicitly:

```bash
openclaw plugins install <plugin-name> --marketplace <marketplace-name>
openclaw plugins install <plugin-name> --marketplace <owner/repo>
openclaw plugins install <plugin-name> --marketplace https://github.com/<owner>/<repo>
openclaw plugins install <plugin-name> --marketplace ./my-marketplace
```

Marketplace sources can be:

- a Claude known-marketplace name from `~/.claude/plugins/known_marketplaces.json`
- a local marketplace root or `marketplace.json` path
- a GitHub repo shorthand such as `owner/repo`
- a GitHub repo URL such as `https://github.com/owner/repo`
- a git URL

For remote marketplaces loaded from GitHub or git, plugin entries must stay
inside the cloned marketplace repo. OpenClaw accepts relative path sources from
that repo and rejects HTTP(S), absolute-path, git, GitHub, and other non-path
plugin sources from remote manifests.

For local paths and archives, OpenClaw auto-detects:

- native OpenClaw plugins (`openclaw.plugin.json`)
- Codex-compatible bundles (`.codex-plugin/plugin.json`)
- Claude-compatible bundles (`.claude-plugin/plugin.json` or the default Claude
  component layout)
- Cursor-compatible bundles (`.cursor-plugin/plugin.json`)

Compatible bundles install into the normal plugin root and participate in
the same list/info/enable/disable flow. Today, bundle skills, Claude
command-skills, Claude `settings.json` defaults, Claude `.lsp.json` /
manifest-declared `lspServers` defaults, Cursor command-skills, and compatible
Codex hook directories are supported; other detected bundle capabilities are
shown in diagnostics/info but are not yet wired into runtime execution.

### List

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
```

Use `--enabled` to show only loaded plugins. Use `--verbose` to switch from the
table view to per-plugin detail lines with source/origin/version/activation
metadata. Use `--json` for machine-readable inventory plus registry
diagnostics.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

`--force` is not supported with `--link` because linked installs reuse the
source path instead of copying over a managed install target.

Use `--pin` on npm installs to save the resolved exact spec (`name@version`) in
`plugins.installs` while keeping the default behavior unpinned.

### Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall` removes plugin records from `plugins.entries`, `plugins.installs`,
the plugin allowlist, and linked `plugins.load.paths` entries when applicable.
For active memory plugins, the memory slot resets to `memory-core`.

By default, uninstall also removes the plugin install directory under the active
state-dir plugin root. Use
`--keep-files` to keep files on disk.

`--keep-config` is supported as a deprecated alias for `--keep-files`.

### Update

```bash
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins update <id-or-npm-spec> --dry-run
openclaw plugins update @openclaw/voice-call@beta
openclaw plugins update openclaw-codex-app-server --dangerously-force-unsafe-install
```

Updates apply to tracked installs in `plugins.installs` and tracked hook-pack
installs in `hooks.internal.installs`.

When you pass a plugin id, OpenClaw reuses the recorded install spec for that
plugin. That means previously stored dist-tags such as `@beta` and exact pinned
versions continue to be used on later `update <id>` runs.

For npm installs, you can also pass an explicit npm package spec with a dist-tag
or exact version. OpenClaw resolves that package name back to the tracked plugin
record, updates that installed plugin, and records the new npm spec for future
id-based updates.

Passing the npm package name without a version or tag also resolves back to the
tracked plugin record. Use this when a plugin was pinned to an exact version and
you want to move it back to the registry's default release line.

Before a live npm update, OpenClaw checks the installed package version against
the npm registry metadata. If the installed version and recorded artifact
identity already match the resolved target, the update is skipped without
downloading, reinstalling, or rewriting `openclaw.json`.

When a stored integrity hash exists and the fetched artifact hash changes,
OpenClaw treats that as npm artifact drift. The interactive
`openclaw plugins update` command prints the expected and actual hashes and asks
for confirmation before proceeding. Non-interactive update helpers fail closed
unless the caller supplies an explicit continuation policy.

`--dangerously-force-unsafe-install` is also available on `plugins update` as a
break-glass override for built-in dangerous-code scan false positives during
plugin updates. It still does not bypass plugin `before_install` policy blocks
or scan-failure blocking, and it only applies to plugin updates, not hook-pack
updates.

### Inspect

```bash
openclaw plugins inspect <id>
openclaw plugins inspect <id> --json
```

Deep introspection for a single plugin. Shows identity, load status, source,
registered capabilities, hooks, tools, commands, services, gateway methods,
HTTP routes, policy flags, diagnostics, install metadata, bundle capabilities,
and any detected MCP or LSP server support.

Each plugin is classified by what it actually registers at runtime:

- **plain-capability** — one capability type (e.g. a provider-only plugin)
- **hybrid-capability** — multiple capability types (e.g. text + speech + images)
- **hook-only** — only hooks, no capabilities or surfaces
- **non-capability** — tools/commands/services but no capabilities

See [Plugin shapes](/plugins/architecture#plugin-shapes) for more on the capability model.

The `--json` flag outputs a machine-readable report suitable for scripting and
auditing.

`inspect --all` renders a fleet-wide table with shape, capability kinds,
compatibility notices, bundle capabilities, and hook summary columns.

`info` is an alias for `inspect`.

### Doctor

```bash
openclaw plugins doctor
```

`doctor` reports plugin load errors, manifest/discovery diagnostics, and
compatibility notices. When everything is clean it prints `No plugin issues
detected.`

For module-shape failures such as missing `register`/`activate` exports, rerun
with `OPENCLAW_PLUGIN_LOAD_DEBUG=1` to include a compact export-shape summary in
the diagnostic output.

### Marketplace

```bash
openclaw plugins marketplace list <source>
openclaw plugins marketplace list <source> --json
```

Marketplace list accepts a local marketplace path, a `marketplace.json` path, a
GitHub shorthand like `owner/repo`, a GitHub repo URL, or a git URL. `--json`
prints the resolved source label plus the parsed marketplace manifest and
plugin entries.
