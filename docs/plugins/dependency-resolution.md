---
summary: "How OpenClaw installs plugin packages and resolves plugin dependencies"
read_when:
  - You are debugging plugin package installs
  - You are changing plugin startup, doctor, or package-manager install behavior
  - You are maintaining packaged OpenClaw installs or bundled plugin manifests
title: "Plugin dependency resolution"
sidebarTitle: "Dependencies"
---

OpenClaw handles plugin dependencies at install/update time only. Runtime
loading never runs a package manager, repairs a dependency tree, or mutates
the OpenClaw package directory.

## Responsibility split

Plugin packages own their dependency graph:

- Runtime dependencies live in the plugin package's `dependencies` or
  `optionalDependencies`.
- SDK/core imports are peer or supplied OpenClaw imports.
- Local development plugins bring their own already-installed dependencies.
- npm and git plugins install into OpenClaw-owned package roots.

OpenClaw owns only the plugin lifecycle:

- Discover the plugin source.
- Install or update the package when explicitly requested.
- Record install metadata.
- Load the plugin entrypoint.
- Fail with an actionable error when dependencies are missing.

## Install roots

OpenClaw uses stable per-source roots:

- npm packages install into per-plugin projects under
  `~/.openclaw/npm/projects/<encoded-package>`.
- git packages clone under `~/.openclaw/git`.
- Local/path/archive installs are copied or referenced without dependency
  repair.

npm installs run in that per-plugin project root with:

```bash
cd ~/.openclaw/npm/projects/<encoded-package>
npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund
```

`openclaw plugins install npm-pack:<path.tgz>` uses the same per-plugin npm
project root for a local npm-pack tarball: OpenClaw reads the tarball's npm
metadata, adds it to the managed project as a copied `file:` dependency, runs
the normal npm install above, then verifies the installed lockfile metadata
before trusting the plugin. This path exists for package-acceptance and
release-candidate proof, where a local pack artifact should behave like the
registry artifact it simulates.

Use `npm-pack:` when testing official or external plugin packages before
publish. A raw archive or path install is useful for local debugging, but it
does not prove the same dependency path as an installed npm or ClawHub
package. `npm-pack:` proves the managed package install shape; it is not, by
itself, proof that the plugin is catalog-linked official content.

When behavior depends on bundled-plugin or trusted official plugin status,
pair the local package proof with a catalog-backed official install or a
published package path that records official trust. Privileged helper access
and trusted-official scope handling should be validated on that trusted
install path, not inferred from a local tarball install.

If a plugin fails at runtime with a missing import, fix the package manifest
instead of repairing the managed project by hand. Runtime imports belong in
the plugin package `dependencies` or `optionalDependencies`; `devDependencies`
are not installed for managed runtime projects. A local `npm install` inside
`~/.openclaw/npm/projects/<encoded-package>` can unblock a temporary
diagnostic, but it is not package-acceptance proof because the next install or
update recreates the project from package metadata.

npm may hoist transitive dependencies to the per-plugin project's
`node_modules` beside the plugin package. OpenClaw scans the managed project
root before trusting the install, and removes that project on uninstall, so
hoisted runtime dependencies stay inside that plugin's cleanup boundary.

Published npm plugin packages can ship `npm-shrinkwrap.json`; npm uses that
publishable lockfile during install, and OpenClaw's managed npm project root
supports it through the normal install path. OpenClaw-owned publishable
plugin packages must include a package-local shrinkwrap generated from that
package's published dependency graph:

```bash
pnpm deps:shrinkwrap:generate
pnpm deps:shrinkwrap:check
```

The generator strips plugin `devDependencies`, applies the workspace override
policy, and writes `extensions/<id>/npm-shrinkwrap.json` for each plugin with
`openclaw.release.publishToNpm: true`. Third-party plugin packages may also
ship a shrinkwrap; OpenClaw does not require one for community packages, but
npm respects it when present.

Before treating a local package as release-candidate proof, inspect the
tarball that will be installed:

```bash
npm pack --pack-destination /tmp
tar -xOf /tmp/<plugin-package>.tgz package/package.json
tar -tf /tmp/<plugin-package>.tgz | grep '^package/dist/'
```

For dependency changes, also verify a production install can resolve the
runtime packages without dev dependencies:

```bash
tmpdir=$(mktemp -d)
(
  cd "$tmpdir"
  npm init -y >/dev/null
  npm install --package-lock-only --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts /tmp/<plugin-package>.tgz
)
rm -rf "$tmpdir"
```

OpenClaw-owned npm plugin packages can also publish with explicit
`bundledDependencies`. The npm publish path overlays the runtime dependency
name list, strips dev-only workspace metadata from the published manifest,
runs a script-free npm install for the package-local runtime dependencies,
then packs or publishes the plugin tarball with those dependency files
included. Native-heavy packages (Codex, ACPX, Copilot, llama.cpp,
memory-lancedb, Tlon) opt out with
`openclaw.release.bundleRuntimeDependencies: false`; they still ship a
shrinkwrap, but npm resolves runtime dependencies during install instead of
embedding every platform binary in the plugin tarball. The root `openclaw`
package does not bundle its full dependency tree.

Plugins that import `openclaw/plugin-sdk/*` declare `openclaw` as a peer
dependency. OpenClaw does not let npm install a separate registry copy of the
host package into a managed project, because a stale host package can affect
npm's peer resolution inside that plugin. Managed npm installs skip npm peer
resolution/materialization, and OpenClaw reasserts plugin-local
`node_modules/openclaw` links for installed packages that declare the host
peer, after install or update.

git installs clone or refresh the repository, then run:

```bash
npm install --omit=dev --ignore-scripts --no-audit --no-fund
```

The installed plugin then loads from that package directory, so
package-local and parent `node_modules` resolution work the same way they do
for a normal Node package.

## Local plugins

Local plugins are developer-controlled directories. OpenClaw never runs
`npm install`, `pnpm install`, or dependency repair for them; if a local
plugin has dependencies, install them in that plugin before loading it.

Third-party TypeScript local plugins load through Jiti as an emergency path.
Packaged JavaScript plugins and bundled internal plugins load through native
import/require instead.

## Startup and reload

Gateway startup and config reload never install plugin dependencies. They
read the plugin install records, compute the entrypoint, and load it.

A missing dependency at runtime fails plugin load with an error that points
the operator to an explicit fix:

```bash
openclaw plugins update <id>
openclaw plugins install <source>
openclaw doctor --fix
```

`doctor --fix` cleans legacy OpenClaw-generated dependency state and can
recover downloadable plugins that are missing from local install records when
config still references them. Doctor does not repair dependencies for an
already-installed local plugin.

## Bundled plugins

Lightweight and core-critical bundled plugins ship as part of OpenClaw. They
should either carry no heavy runtime dependency tree, or move out to a
downloadable package on ClawHub/npm.

For the current generated list of plugins that ship in the core package,
install externally, or stay source-only, see
[Plugin inventory](/plugins/plugin-inventory).

Bundled plugin manifests must not request dependency staging. Large or
optional plugin functionality should be packaged as a normal plugin and
installed through the same npm/git/ClawHub path as third-party plugins.

In source checkouts, OpenClaw treats the repository as a pnpm monorepo.
After `pnpm install`, bundled plugins load from `extensions/<id>` so
package-local workspace dependencies are available and edits are picked up
directly. Source checkout development is pnpm-only; plain `npm install` at
the repository root does not prepare bundled plugin dependencies.

| Install shape                    | Bundled plugin location               | Dependency owner                                                     |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `npm install -g openclaw`        | Built runtime tree inside the package | OpenClaw package and explicit plugin install/update/doctor flows     |
| Git checkout plus `pnpm install` | `extensions/<id>` workspace packages  | The pnpm workspace, including each plugin package's own dependencies |
| `openclaw plugins install ...`   | Managed npm project/git/ClawHub root  | The plugin install/update flow                                       |

## Legacy cleanup

Older OpenClaw versions generated bundled-plugin dependency roots at startup
or during doctor repair. Current doctor cleanup removes those stale
directories and symlinks with `--fix`, including old `plugin-runtime-deps`
roots, global Node-prefix package symlinks pointing at pruned
`plugin-runtime-deps` targets, `.openclaw-runtime-deps*` manifests, generated
plugin `node_modules`, install stage directories, and package-local pnpm
stores. Packaged postinstall also removes those global symlinks before
pruning the legacy target roots, so upgrades do not leave dangling ESM
package imports.

Older npm installs also used a shared `~/.openclaw/npm/node_modules` root.
Current install, update, uninstall, and doctor flows still recognize that
legacy flat root for recovery and cleanup only. New npm installs create
per-plugin project roots instead.
