---
summary: "CLI reference for `openclaw plugins` (init, build, validate, list, install, marketplace, uninstall, enable/disable, doctor)"
read_when:
  - You want to install or manage Gateway plugins or compatible bundles
  - You want to scaffold or validate a simple tool plugin
  - You want to debug plugin load failures
title: "Plugins"
sidebarTitle: "Plugins"
---

Manage Gateway plugins, hook packs, and compatible bundles.

<CardGroup cols={2}>
  <Card title="Plugin system" href="/tools/plugin">
    End-user guide for installing, enabling, and troubleshooting plugins.
  </Card>
  <Card title="Manage plugins" href="/plugins/manage-plugins">
    Quick examples for install, list, update, uninstall, and publishing.
  </Card>
  <Card title="Plugin bundles" href="/plugins/bundles">
    Bundle compatibility model.
  </Card>
  <Card title="Plugin manifest" href="/plugins/manifest">
    Manifest fields and config schema.
  </Card>
  <Card title="Security" href="/gateway/security">
    Security hardening for plugin installs.
  </Card>
</CardGroup>

## Commands

```bash
openclaw plugins list [--enabled] [--verbose] [--json]
openclaw plugins search <query> [--limit <n>] [--json]
openclaw plugins install <path-or-spec> [--link] [--force] [--pin] [--marketplace <source>]
openclaw plugins inspect <id> [--runtime] [--json]
openclaw plugins inspect --all [--runtime] [--json]
openclaw plugins info <id>                    # alias for inspect
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id> [--dry-run] [--keep-files] [--force]
openclaw plugins update <id-or-npm-spec> | --all [--dry-run]
openclaw plugins registry [--refresh] [--json]
openclaw plugins doctor
openclaw plugins init <id> [--name <name>] [--type tool|provider] [--directory <path>]
openclaw plugins build [--entry <path>] [--check]
openclaw plugins validate [--entry <path>]
openclaw plugins marketplace entries [--offline] [--feed-profile <name>] [--json]
openclaw plugins marketplace list <source> [--json]
openclaw plugins marketplace refresh [--feed-profile <name>] [--expected-sha256 <sha256>] [--json]
```

For slow install, inspect, uninstall, or registry-refresh investigation, run the
command with `OPENCLAW_PLUGIN_LIFECYCLE_TRACE=1`. The trace writes phase timings
to stderr and keeps JSON output parseable. See [Debugging](/help/debugging#plugin-lifecycle-trace).

<Note>
In Nix mode (`OPENCLAW_NIX_MODE=1`), `openclaw.json` is immutable. `install`, `update`, `uninstall`, `enable`, and `disable` all refuse to run. Edit the Nix source for this install instead (`programs.openclaw.config` or `instances.<name>.config` for nix-openclaw), then rebuild. See the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).
</Note>

<Note>
Bundled plugins ship with OpenClaw. Some are enabled by default (for example bundled model providers, bundled speech providers, and the bundled browser plugin); others require `plugins enable`.

Native OpenClaw plugins ship `openclaw.plugin.json` with an inline JSON Schema (`configSchema`, even if empty). Compatible bundles use their own bundle manifests instead.

`plugins list` shows `Format: openclaw` or `Format: bundle`. Verbose list/info output also shows the bundle subtype (`codex`, `claude`, or `cursor`) plus detected bundle capabilities.
</Note>

## Author

```bash
openclaw plugins init stock-quotes --name "Stock Quotes"
cd stock-quotes
npm run plugin:build
npm run plugin:validate
```

`plugins init` creates a minimal TypeScript tool plugin by default. The first
argument is the plugin id; `--name` sets the display name. OpenClaw uses the
id for the default output directory and package naming. Tool scaffolds use
`defineToolPlugin` and generate `package.json` scripts `plugin:build` and
`plugin:validate` that build then call `openclaw plugins build`/`validate`.

`plugins build` imports the built entry, reads its static tool metadata, writes
`openclaw.plugin.json`, and keeps `package.json`'s `openclaw.extensions` aligned.
`plugins validate` checks that the generated manifest, package metadata, and
current entry export still agree. See [Tool Plugins](/plugins/tool-plugins) for
the full authoring workflow.

The scaffold writes TypeScript source but generates metadata from the built
`./dist/index.js` entry, so the workflow also works with the published CLI. Use
`--entry <path>` when the entry is not the default package entry. Use
`plugins build --check` in CI to fail when generated metadata is stale without
rewriting files.

### Provider scaffold

```bash
openclaw plugins init acme-models --name "Acme Models" --type provider
cd acme-models
npm install
npm run build
npm test
npm run validate
```

Provider scaffolds create a generic OpenAI-compatible model provider plugin
with API-key auth plumbing, a `npm run validate` script that runs
`clawhub package validate`, ClawHub package metadata, and a manually
dispatched GitHub Actions workflow for future trusted publishing via GitHub
OIDC. Provider scaffolds do not generate skills and do not use
`openclaw plugins build`/`validate`; those commands are for the tool
scaffold's generated-metadata path.

Before publishing, replace the placeholder API base URL, model catalog, docs
route, credential text, and README copy with real provider details. Use the
generated README for first-time ClawHub publishing and trusted-publisher setup.

## Install

```bash
openclaw plugins search "calendar"                      # search ClawHub plugins
openclaw plugins install @openclaw/<package>            # trusted official catalog
openclaw plugins install <package>                       # arbitrary npm package
openclaw plugins install clawhub:<package>                # ClawHub only
openclaw plugins install npm:<package>                    # npm only
openclaw plugins install npm-pack:<path.tgz>               # local npm-pack tarball
openclaw plugins install git:github.com/<owner>/<repo>     # git repo
openclaw plugins install git:github.com/<owner>/<repo>@<ref>
openclaw plugins install <path>                            # local path or archive
openclaw plugins install -l <path>                         # link instead of copy
openclaw plugins install <plugin>@<marketplace>             # marketplace shorthand
openclaw plugins install <plugin> --marketplace <name>      # marketplace (explicit)
openclaw plugins install <package> --force                  # confirm source / overwrite existing
openclaw plugins install <package> --pin                    # pin resolved npm version
openclaw plugins install clawhub:<package> --acknowledge-clawhub-risk
openclaw plugins install <package> --dangerously-force-unsafe-install
```

Maintainers testing setup-time installs can override automatic plugin install
sources with guarded environment variables. See
[Plugin install overrides](/plugins/install-overrides).

<Warning>
Bare package names install from npm by default during the launch cutover, unless they match a bundled or official plugin id, in which case OpenClaw uses that local/official copy instead of hitting the npm registry. Use `npm:<package>` when you deliberately want an external npm package instead. Use `clawhub:<package>` for ClawHub. Treat plugin installs like running code; prefer pinned versions.
</Warning>

<Warning>
ClawHub packages and OpenClaw's bundled/official catalog are trusted install
sources. A new arbitrary npm, `npm-pack:`, git, local path/archive, or
marketplace source warns and asks before continuing. Noninteractive arbitrary
installs must pass `--force` after you review and trust the source. The same
flag overwrites an existing install target when needed. Normal updates of an
already tracked install do not require it. This confirmation is separate from
`--acknowledge-clawhub-risk`, which only applies to risky ClawHub release trust
warnings. `--force` does not bypass `security.installPolicy` or remaining
install safety checks.
</Warning>

`plugins search` queries ClawHub for installable `code-plugin` and
`bundle-plugin` packages (not skills; use `openclaw skills search` for those).
Default `--limit` is 20, capped at 100. It only reads the remote catalog: no
local state inspection, config mutation, package install, or plugin runtime
load. Results include the ClawHub package name, family, channel, version,
summary, and an install hint such as `openclaw plugins install clawhub:<package>`.

<Note>
ClawHub is the primary distribution and discovery surface for most plugins. Npm
remains a supported fallback and direct-install path. OpenClaw-owned
`@openclaw/*` plugin packages are published on npm again; see the current list
on [npmjs.com/org/openclaw](https://www.npmjs.com/org/openclaw) or the
[plugin inventory](/plugins/plugin-inventory). Stable installs use `latest`.
Beta-channel installs and updates prefer the npm `beta` dist-tag when available,
falling back to `latest`. On the extended-stable channel, official npm plugins
with bare/default or `latest` intent resolve to the exact installed core
version. Exact pins and explicit non-`latest` tags, third-party packages, and
non-npm sources are not rewritten.
</Note>

<AccordionGroup>
  <Accordion title="Config includes and invalid-config repair">
    If your `plugins` section is backed by a single-file `$include`, `plugins install/update/enable/disable/uninstall` write through to that included file and leave `openclaw.json` untouched. Root includes, include arrays, and includes with sibling overrides fail closed instead of flattening. See [Config includes](/gateway/configuration) for the supported shapes.

    If config is invalid during install, `plugins install` normally fails closed and tells you to run `openclaw doctor --fix` first. During Gateway startup and hot reload, invalid plugin config fails closed like any other invalid config; `openclaw doctor --fix` can quarantine the invalid plugin entry. The only documented install-time exception is a narrow bundled-plugin recovery path for plugins that explicitly opt into `openclaw.install.allowInvalidConfigRecovery`.

  </Accordion>
  <Accordion title="--force confirmation and reinstall vs update">
    `--force` confirms a non-ClawHub source without prompting. It does not bypass `security.installPolicy` or remaining install safety checks. When the plugin or hook pack is already installed, it also reuses the existing target and overwrites it in place. Use it after reviewing an arbitrary npm, local, archive, git, or marketplace source, or when intentionally reinstalling the same id. For routine upgrades of an already tracked npm plugin, prefer `openclaw plugins update <id-or-npm-spec>`.

    If you run `plugins install` for a plugin id that is already installed, OpenClaw stops and points you at `plugins update <id-or-npm-spec>` for a normal upgrade, or at `plugins install <package> --force` when you genuinely want to overwrite the current install from a different source. Arbitrary sources still show the interactive provenance warning; noninteractive installs must pass `--force` after review. Trusted ClawHub and OpenClaw-catalog sources do not need it. With `--link`, `--force` confirms the source but does not change the linked-path install mode.

  </Accordion>
  <Accordion title="--pin scope">
    `--pin` applies to npm installs only and records the resolved exact `<name>@<version>`. It is not supported with `git:` installs (pin the ref in the spec instead, e.g. `git:github.com/acme/plugin@v1.2.3`) or with `--marketplace` (marketplace installs persist marketplace source metadata instead of an npm spec).
  </Accordion>
  <Accordion title="--dangerously-force-unsafe-install">
    `--dangerously-force-unsafe-install` is deprecated and is now a no-op. OpenClaw no longer runs built-in install-time dangerous-code blocking for plugin installs.

    Use the operator-owned `security.installPolicy` surface when host-specific install policy is required. Plugin `before_install` hooks are plugin-runtime lifecycle hooks, not the primary policy boundary for CLI installs.

    If a plugin you published on ClawHub is hidden or blocked by a registry scan, use the publisher steps in [ClawHub publishing](/clawhub/publishing). `--dangerously-force-unsafe-install` does not ask ClawHub to rescan the plugin or make a blocked release public.

  </Accordion>
  <Accordion title="--acknowledge-clawhub-risk">
    Community ClawHub installs check the selected release's trust record before downloading. If ClawHub disables download for the release, reports malicious scan findings, or puts the release in a blocking moderation state (quarantined, revoked), OpenClaw refuses it outright regardless of this flag. For non-blocking risky scan statuses or moderation states, OpenClaw shows the trust details and asks for confirmation before continuing.

    Use `--acknowledge-clawhub-risk` only after reviewing the ClawHub warning and deciding to continue without an interactive prompt. Pending or stale (not-yet-clean) scan results warn but do not require acknowledgement. Official ClawHub packages and bundled OpenClaw plugin sources bypass this release-trust check entirely.

  </Accordion>
  <Accordion title="Hook packs and npm specs">
    `plugins install` is also the install surface for hook packs that expose `openclaw.hooks` in `package.json`. Use `openclaw hooks` for filtered hook visibility and per-hook enablement, not package installation.

    Npm specs are **registry-only** (package name plus optional **exact version** or **dist-tag**). Git/URL/file specs and semver ranges are rejected. Dependency installs run in one managed npm project per plugin with `--ignore-scripts` for safety, even when your shell has global npm install settings. Managed plugin npm projects inherit OpenClaw's package-level npm `overrides`, so host security pins apply to hoisted plugin dependencies too.

    Use `npm:<package>` to make npm resolution explicit. Bare package specs also install directly from npm during the launch cutover unless they match an official plugin id.

    Raw `@openclaw/*` specs that match bundled plugins resolve to the image-owned bundled copy before npm fallback. For example, `openclaw plugins install @openclaw/discord@2026.5.20 --pin` uses the bundled Discord plugin from the current OpenClaw build instead of creating a managed npm override. To force the external npm package, use `openclaw plugins install npm:@openclaw/discord@2026.5.20 --pin`.

    Bare specs and `@latest` stay on the stable track. OpenClaw date-stamped correction versions such as `2026.5.3-1` count as stable for this check. If npm resolves either form to a prerelease, OpenClaw stops and asks you to opt in explicitly with a prerelease tag (`@beta`/`@rc`) or an exact prerelease version (`@1.2.3-beta.4`).

    For npm installs without an exact version (`npm:<package>` or `npm:<package>@latest`), OpenClaw checks the resolved package metadata before install. If the latest stable package requires a newer OpenClaw plugin API or minimum host version, OpenClaw inspects older stable versions and installs the newest compatible release instead. Exact versions and explicit dist-tags stay strict: an incompatible selection fails and asks you to upgrade OpenClaw or choose a compatible version.

    If a bare install spec matches an official plugin id (for example `diffs`), OpenClaw installs the catalog entry directly. To install an npm package with the same name, use an explicit scoped spec (for example `@scope/diffs`).

  </Accordion>
  <Accordion title="Git repositories">
    Use `git:<repo>` to install directly from a git repository. Supported forms: `git:github.com/owner/repo`, `git:owner/repo`, full `https://`, `ssh://`, `git://`, `file://`, and `git@host:owner/repo.git` clone URLs. Add `@<ref>` or `#<ref>` to check out a branch, tag, or commit before install.

    Git installs clone into a temporary directory, check out the requested ref when present, then use the normal plugin directory installer, so manifest validation, operator install policy, package-manager install work, and install records behave like npm installs. Recorded git installs include the source URL/ref plus the resolved commit so `openclaw plugins update` can re-resolve the source later.

    After installing from git, use `openclaw plugins inspect <id> --runtime --json` to verify runtime registrations such as gateway methods and CLI commands. If the plugin registered a CLI root with `api.registerCli`, run that command directly through the OpenClaw root CLI, for example `openclaw demo-plugin ping`.

  </Accordion>
  <Accordion title="Archives">
    Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`. Native OpenClaw plugin archives must contain a valid `openclaw.plugin.json` at the extracted plugin root; archives that only contain `package.json` are rejected before OpenClaw writes install records.

    Use `npm-pack:<path.tgz>` when the file is an npm-pack tarball and you want
    the same per-plugin managed npm project path used by registry installs,
    including `package-lock.json` verification, hoisted dependency scanning,
    and npm install records. Plain archive paths still install as local
    archives under the plugin extensions root.

    Claude marketplace installs are also supported.

  </Accordion>
</AccordionGroup>

ClawHub installs use an explicit `clawhub:<package>` locator:

```bash
openclaw plugins install clawhub:openclaw-codex-app-server
openclaw plugins install clawhub:openclaw-codex-app-server@1.2.3
```

Bare npm-safe plugin specs install from npm by default during the launch cutover unless they match an official plugin id:

```bash
openclaw plugins install openclaw-codex-app-server
```

Use `npm:` to make npm-only resolution explicit:

```bash
openclaw plugins install npm:openclaw-codex-app-server
openclaw plugins install npm:@openclaw/discord@2026.5.20
openclaw plugins install npm:@scope/plugin-name@1.0.1
```

OpenClaw checks the advertised plugin API / minimum gateway compatibility before install. When the selected ClawHub version publishes a ClawPack artifact, OpenClaw downloads the versioned npm-pack `.tgz`, verifies the ClawHub digest header and the artifact digest, then installs it through the normal archive path. Older ClawHub versions without ClawPack metadata still install through the legacy package archive verification path. Recorded installs keep their ClawHub source metadata, artifact kind, npm integrity, npm shasum, tarball name, and ClawPack digest facts for later updates.
Unversioned ClawHub installs keep an unversioned recorded spec so `openclaw plugins update` can follow newer ClawHub releases; explicit version or tag selectors such as `clawhub:pkg@1.2.3` and `clawhub:pkg@beta` remain pinned to that selector.

### Marketplace shorthand

Use `plugin@marketplace` shorthand when the marketplace name exists in Claude's local registry cache at `~/.claude/plugins/known_marketplaces.json`:

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

Use `--marketplace` to pass the marketplace source explicitly:

```bash
openclaw plugins install <plugin-name> --marketplace <marketplace-name>
openclaw plugins install <plugin-name> --marketplace <owner/repo>
openclaw plugins install <plugin-name> --marketplace https://github.com/<owner>/<repo>
openclaw plugins install <plugin-name> --marketplace ./my-marketplace
```

<Tabs>
  <Tab title="Marketplace sources">
    - a Claude known-marketplace name from `~/.claude/plugins/known_marketplaces.json`
    - a local marketplace root or `marketplace.json` path
    - a GitHub repo shorthand such as `owner/repo`
    - a GitHub repo URL such as `https://github.com/owner/repo`
    - a git URL

  </Tab>
  <Tab title="Remote marketplace rules">
    For remote marketplaces loaded from GitHub or git, plugin entries must stay inside the cloned marketplace repo. OpenClaw accepts relative path sources from that repo and rejects HTTP(S), absolute-path, git, GitHub, and other non-path plugin sources from remote manifests.
  </Tab>
</Tabs>

For local paths and archives, OpenClaw auto-detects:

- native OpenClaw plugins (`openclaw.plugin.json`)
- Codex-compatible bundles (`.codex-plugin/plugin.json`)
- Claude-compatible bundles (`.claude-plugin/plugin.json`, or the default Claude component layout when that manifest file is absent)
- Cursor-compatible bundles (`.cursor-plugin/plugin.json`)

Managed local installs must be plugin directories or archives. Standalone `.js`,
`.mjs`, `.cjs`, and `.ts` plugin files are not copied into the managed plugin
root by `plugins install`, nor loaded by placing them directly in
`~/.openclaw/extensions` or `<workspace>/.openclaw/extensions`; those
auto-discovered roots load plugin package or bundle directories, and skip
top-level script files as local helpers. List standalone files explicitly in
`plugins.load.paths` instead.

<Note>
Compatible bundles install into the normal plugin root and participate in the same list/info/enable/disable flow. Today, bundle skills, Claude command-skills, Claude `settings.json` defaults, Claude `.lsp.json` / manifest-declared `lspServers` defaults, Cursor command-skills, and compatible Codex hook directories are supported; other detected bundle capabilities are shown in diagnostics/info but are not yet wired into runtime execution.
</Note>

Use `-l`/`--link` to point at a local plugin directory without copying it (adds
to `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

`--link` is not supported with `--marketplace` or `git:` installs, and it
requires a local path that already exists. For a noninteractive local link,
pass `--force` after reviewing the source; it confirms provenance but does not
copy or overwrite the linked directory.

<Note>
Workspace-origin plugins discovered from a workspace extensions root are not
imported or executed until they are explicitly enabled. For local development,
run `openclaw plugins enable <plugin-id>` or set
`plugins.entries.<plugin-id>.enabled: true`; if your config uses
`plugins.allow`, include the same plugin id there too. This fail-closed rule
also applies when channel setup explicitly targets a workspace-origin plugin for
setup-only loading, so local channel plugin setup code will not run while that
workspace plugin remains disabled or excluded from the allowlist. Linked installs
and explicit `plugins.load.paths` entries follow the normal policy for their
resolved plugin origin. See
[Configure plugin policy](/tools/plugin#configure-plugin-policy)
and [Configuration reference](/gateway/configuration-reference#plugins).

Use `--pin` on npm installs to save the resolved exact spec (`name@version`) in the managed plugin index while keeping the default behavior unpinned.
</Note>

## List

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
```

<ParamField path="--enabled" type="boolean">
  Show only enabled plugins.
</ParamField>
<ParamField path="--verbose" type="boolean">
  Switch from the table view to per-plugin detail lines with format/source/origin/version/activation metadata.
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable inventory plus registry diagnostics and package dependency install state.
</ParamField>

<Note>
`plugins list` reads the persisted local plugin registry first, with a manifest-only derived fallback when the registry is missing or invalid. It is useful for checking whether a plugin is installed, enabled, and visible to cold startup planning, but it is not a live runtime probe of an already-running Gateway process. After changing plugin code, enablement, hook policy, or `plugins.load.paths`, restart the Gateway that serves the channel before expecting new `register(api)` code or hooks to run. For remote/container deployments, verify you are restarting the actual `openclaw gateway run` child, not only a wrapper process.

`plugins list --json` includes each plugin's `dependencyStatus` from `package.json`
`dependencies` and `optionalDependencies`. OpenClaw checks whether those package
names are present along the plugin's normal Node `node_modules` lookup path; it
does not import plugin runtime code, run a package manager, or repair missing
dependencies.
</Note>

If startup logs `plugins.allow is empty; discovered non-bundled plugins may auto-load: ...`,
run `openclaw plugins list --enabled --verbose` or
`openclaw plugins inspect <id>` with a listed plugin id to confirm the plugin
ids and copy trusted ids into `plugins.allow` in `openclaw.json`. When the
warning can list every discovered plugin, it prints a ready-to-paste
`plugins.allow` snippet that already includes those ids. If a plugin loads
without install/load-path provenance, inspect that plugin id, then either pin
the trusted id in `plugins.allow` or reinstall the plugin from a trusted source
so OpenClaw records install provenance.

For bundled plugin work inside a packaged Docker image, bind-mount the plugin
source directory over the matching packaged source path, such as
`/app/extensions/synology-chat`. OpenClaw discovers that mounted source overlay
before `/app/dist/extensions/synology-chat`; a plain copied source directory
remains inert, so normal packaged installs still use compiled dist.

For runtime hook debugging:

- `openclaw plugins inspect <id> --runtime --json` shows registered hooks and diagnostics from a module-loaded inspection pass. Runtime inspection never installs dependencies; use `openclaw doctor --fix` to clean legacy dependency state or recover missing downloadable plugins that are referenced by config.
- `openclaw gateway status --deep --require-rpc` confirms the reachable Gateway URL/profile, service/process hints, config path, and RPC health.
- Non-bundled conversation hooks (`llm_input`, `llm_output`, `before_model_resolve`, `before_agent_reply`, `before_agent_run`, `before_agent_finalize`, `agent_end`) require `plugins.entries.<id>.hooks.allowConversationAccess=true`.

### Plugin index

Plugin install metadata is machine-managed state, not user config. Installs and updates write it to the shared SQLite state database under the active OpenClaw state directory. The `installed_plugin_index` row stores durable `installRecords` metadata, including records for broken or missing plugin manifests, plus a manifest-derived cold registry cache used by `openclaw plugins update`, uninstall, diagnostics, and the cold plugin registry.

`plugins.installs` is a retired authored-config surface. Runtime and update commands read only the SQLite installed-plugin index. Run `openclaw doctor --fix` to import legacy config records into the index and remove the retired key before normal runtime use.

## Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
openclaw plugins uninstall <id> --force
```

`uninstall` removes plugin records from `plugins.entries`, the persisted plugin index, plugin allow/deny list entries, and linked `plugins.load.paths` entries when applicable. Unless `--keep-files` is set, uninstall also removes the tracked managed install directory, but only when it resolves inside OpenClaw's plugin extensions root. If the plugin currently owns the `memory` or `contextEngine` slot, that slot resets to its default (`memory-core` for memory, `legacy` for context engine).

`uninstall` prints a preview of what will be removed, then prompts `Uninstall plugin "<id>"?` before making changes. Pass `--force` to skip the confirmation prompt (useful for scripts and non-interactive runs); without it, uninstall requires an interactive TTY. `--dry-run` prints the same preview and exits without prompting or changing anything.

<Note>
`--keep-config` is supported as a deprecated alias for `--keep-files`.
</Note>

## Update

```bash
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins update <id-or-npm-spec> --dry-run
openclaw plugins update @openclaw/voice-call
openclaw plugins update @acme/demo
openclaw plugins update openclaw-codex-app-server --acknowledge-clawhub-risk
openclaw plugins update openclaw-codex-app-server --dangerously-force-unsafe-install
```

Updates apply to tracked plugin installs in the managed plugin index and tracked hook-pack installs in `hooks.internal.installs`. They reuse the source that the user already chose when installing the plugin, so they do not require a second source acknowledgement.

<AccordionGroup>
  <Accordion title="Resolving plugin id vs npm spec">
    When you pass a plugin id, OpenClaw reuses the recorded install spec for that plugin. That means previously stored dist-tags such as `@beta` and exact pinned versions continue to be used on later `update <id>` runs.

    During `update <id> --dry-run`, exact pinned npm installs stay pinned. If OpenClaw can also resolve the package's registry default line and that default line is newer than the installed pinned version, the dry run reports the pin and prints the explicit `@latest` package update command to follow the registry default line.

    That targeted-update rule differs from the bulk `openclaw plugins update --all` maintenance path. Bulk updates still respect ordinary tracked install specs, but trusted official OpenClaw plugin records can sync to the current official catalog target instead of staying on a stale exact official package. Use targeted `update <id>` when you intentionally want to keep an exact or tagged official spec untouched.

    For npm installs, you can also pass an explicit npm package spec with a dist-tag or exact version. OpenClaw resolves that package name back to the tracked plugin record, updates that installed plugin, and records the new npm spec for future id-based updates.

    Passing the npm package name without a version or tag also resolves back to the tracked plugin record. Use this when a plugin was pinned to an exact version and you want to move it back to the registry's default release line.

  </Accordion>
  <Accordion title="Beta channel updates">
    Targeted `openclaw plugins update <id-or-npm-spec>` reuses the tracked plugin spec unless you pass a new spec. Bulk `openclaw plugins update --all` uses the configured `update.channel` when it syncs trusted official plugin records to the official catalog target, so beta-channel installs can stay on the beta release line instead of being silently normalized to stable/latest.

    `openclaw update` also knows the active OpenClaw update channel: on the beta channel, default-line npm and ClawHub plugin records try `@beta` first. They fall back to the recorded default/latest spec if no plugin beta release exists; npm plugins also fall back when the beta package exists but fails install validation. That fallback is reported as a warning and does not fail the core update. Exact versions and explicit tags stay pinned to that selector for targeted updates.

  </Accordion>
  <Accordion title="Version checks and integrity drift">
    Before a live npm update, OpenClaw checks the installed package version against the npm registry metadata. If the installed version and recorded artifact identity already match the resolved target, the update is skipped without downloading, reinstalling, or rewriting `openclaw.json`.

    When a stored integrity hash exists and the fetched artifact hash changes, OpenClaw treats that as npm artifact drift. The interactive `openclaw plugins update` command prints the expected and actual hashes and asks for confirmation before proceeding. Non-interactive update helpers fail closed unless the caller supplies an explicit continuation policy.

  </Accordion>
  <Accordion title="--dangerously-force-unsafe-install on update">
    `--dangerously-force-unsafe-install` is also accepted on `plugins update` for compatibility, but it is deprecated and no longer changes plugin update behavior. Operator `security.installPolicy` can still block updates; plugin `before_install` hooks only apply in processes where plugin hooks are loaded.
  </Accordion>
  <Accordion title="--acknowledge-clawhub-risk on update">
    Community ClawHub-backed plugin updates run the same exact-release trust check as installs before downloading the replacement package. Use `--acknowledge-clawhub-risk` for reviewed automation that should continue when the selected ClawHub release has a risky trust warning. Official ClawHub packages and bundled OpenClaw plugin sources bypass this release-trust prompt.
  </Accordion>
</AccordionGroup>

## Inspect

```bash
openclaw plugins inspect <id>
openclaw plugins inspect <id> --runtime
openclaw plugins inspect <id> --json
openclaw plugins inspect --all
```

Inspect shows identity, load status, source, manifest capabilities, policy flags, diagnostics, install metadata, bundle capabilities, and any detected MCP or LSP server support without importing plugin runtime by default. JSON output includes the plugin manifest contracts, such as `contracts.agentToolResultMiddleware` and `contracts.trustedToolPolicies`, so operators can audit trusted-surface declarations before enabling or restarting a plugin. Add `--runtime` to load the plugin module and include registered hooks, tools, commands, services, gateway methods, and HTTP routes. Runtime inspection reports missing plugin dependencies directly; installs and repairs stay in `openclaw plugins install`, `openclaw plugins update`, and `openclaw doctor --fix`.

Plugin-owned CLI commands are usually installed as root `openclaw` command groups, but plugins may also register nested commands under a core parent such as `openclaw nodes`. After `inspect --runtime` shows a command under `cliCommands`, run it at the listed path; for example a plugin that registers `demo-git` can be verified with `openclaw demo-git ping`.

Each plugin is classified by what it actually registers at runtime:

| Shape               | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `plain-capability`  | exactly one capability type (e.g. a provider-only plugin)         |
| `hybrid-capability` | more than one capability type (e.g. text + speech + images)       |
| `hook-only`         | only hooks, no capabilities, tools, commands, services, or routes |
| `non-capability`    | tools/commands/services but no capabilities                       |

See [Plugin shapes](/plugins/architecture#plugin-shapes) for more on the capability model.

<Note>
The `--json` flag outputs a machine-readable report suitable for scripting and auditing. `inspect --all` renders a fleet-wide table with shape, capability kinds, compatibility notices, bundle capabilities, and hook summary columns. `info` is an alias for `inspect`.
</Note>

## Doctor

```bash
openclaw plugins doctor
```

`doctor` reports plugin load errors, manifest/discovery diagnostics, compatibility notices, and stale plugin config references such as missing plugin slots. When the install tree and plugin config are clean it prints `No plugin issues detected.` If stale config remains but the install tree is otherwise healthy, the summary says so instead of implying full plugin health.

If a configured plugin is present on disk but blocked by the loader's path-safety checks, config validation keeps the plugin entry and reports it as `present but blocked`. Fix the preceding blocked-plugin diagnostic, such as path ownership or world-writable permissions, instead of removing the `plugins.entries.<id>` or `plugins.allow` config.

For module-shape failures such as missing `register`/`activate` exports, rerun with `OPENCLAW_PLUGIN_LOAD_DEBUG=1` to include a compact export-shape summary in the diagnostic output.

## Registry

```bash
openclaw plugins registry
openclaw plugins registry --refresh
openclaw plugins registry --json
```

The local plugin registry is OpenClaw's persisted cold read model for installed plugin identity, enablement, source metadata, and contribution ownership. Normal startup, provider owner lookup, channel setup classification, and plugin inventory can read it without importing plugin runtime modules.

Use `plugins registry` to inspect whether the persisted registry is present, current, or stale. Use `--refresh` to rebuild it from the persisted plugin index, config policy, and manifest/package metadata. This is a repair path, not a runtime activation path.

`openclaw doctor --fix` also repairs registry-adjacent managed npm drift. If an orphaned or recovered `@openclaw/*` package under a managed plugin npm project or the legacy flat managed npm root shadows a bundled plugin, doctor removes that stale package and rebuilds the registry so startup validates against the bundled manifest. When an authoritative install record selects one managed generation but older flat or generation directories remain, doctor retires those stale trees for pruning after the gateway restarts. Doctor also relinks the host `openclaw` package into managed npm plugins that declare `peerDependencies.openclaw`, so package-local runtime imports such as `openclaw/plugin-sdk/*` resolve after updates or npm repairs.

## Marketplace

```bash
openclaw plugins marketplace entries
openclaw plugins marketplace entries --offline
openclaw plugins marketplace entries --json
openclaw plugins marketplace entries --feed-profile <name>
openclaw plugins marketplace entries --feed-url <url>
openclaw plugins marketplace list <source>
openclaw plugins marketplace list <source> --json
openclaw plugins marketplace refresh
openclaw plugins marketplace refresh --feed-profile <name>
openclaw plugins marketplace refresh --feed-url <url>
openclaw plugins marketplace refresh --expected-sha256 <sha256> --json
```

`plugins marketplace entries` lists entries from the configured OpenClaw marketplace feed. By default it attempts the hosted feed and falls back to the latest accepted snapshot or bundled data. Use `--feed-profile <name>` to read a specific configured profile, `--feed-url <url>` to read an explicit hosted feed URL, and `--offline` to read the latest accepted snapshot without fetching the feed.

`plugins marketplace refresh` refreshes the configured hosted feed snapshot and reports whether OpenClaw accepted hosted data, a hosted snapshot, or bundled fallback data. Use `--expected-sha256` when a caller needs the command to fail unless a fresh hosted payload matches a pinned checksum.

Marketplace `list` accepts a local marketplace path, a `marketplace.json` path, a GitHub shorthand like `owner/repo`, a GitHub repo URL, or a git URL. `--json` prints the resolved source label plus the parsed marketplace manifest and plugin entries.

Marketplace refresh loads a hosted OpenClaw marketplace feed and persists the
validated response as the local hosted-feed snapshot. Without options, it uses
the configured default feed profile. Use `--feed-profile <name>` to refresh a
specific configured profile, `--feed-url <url>` to refresh an explicit hosted
feed URL, `--expected-sha256 <sha256>` to require a matching payload checksum
(`sha256:<hex>` or a bare 64-character hex digest), and `--json` for
machine-readable output. Explicit hosted feed URLs must not include
credentials, query strings, or fragments. Unpinned refreshes can report a
hosted snapshot or bundled fallback result without failing the command. Pinned
refreshes fail unless they accept a fresh hosted payload, and successful hosted
refreshes fail if OpenClaw cannot persist the validated snapshot.

## Related

- [Building plugins](/plugins/building-plugins)
- [CLI reference](/cli)
- [ClawHub](/clawhub)
