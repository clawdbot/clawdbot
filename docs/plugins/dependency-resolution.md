---
summary: "How OpenClaw installs plugin packages and resolves plugin dependencies"
read_when:
  - You are debugging plugin package installs
  - You are changing plugin startup, doctor, or package-manager install behavior
  - You are maintaining packaged OpenClaw installs or bundled plugin manifests
title: "Plugin dependency resolution"
sidebarTitle: "Dependencies"
---

OpenClaw keeps plugin dependency work at install/update time. Runtime loading
does not run package managers, repair dependency trees, or mutate the OpenClaw
package directory.

## Responsibility split

Plugin packages own their dependency graph:

- runtime dependencies live in the plugin package `dependencies` or
  `optionalDependencies`
- SDK/core imports are peer or supplied OpenClaw imports
- local development plugins bring their own already-installed dependencies
- npm and git plugins are installed into OpenClaw-owned package roots

OpenClaw owns only the plugin lifecycle:

- discover the plugin source
- install or update the package when explicitly requested
- record the install metadata
- load the plugin entrypoint
- fail with an actionable error when dependencies are missing

## Install roots

OpenClaw uses stable per-source roots:

- npm packages install under `~/.openclaw/npm`
- git packages clone under `~/.openclaw/git`
- local/path/archive installs are copied or referenced without dependency repair

npm installs run in the npm root with:

```bash
cd ~/.openclaw/npm
npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund
```

`openclaw plugins install npm-pack:<path.tgz>` uses that same managed npm root
for a local npm-pack tarball. OpenClaw reads the tarball's npm metadata, adds it
to the managed root as a copied `file:` dependency, runs the normal npm install,
and then verifies the installed lockfile metadata before trusting the plugin.
This is intended for package-acceptance and release-candidate proof where a
local pack artifact should behave like the registry artifact it simulates.

npm may hoist transitive dependencies to `~/.openclaw/npm/node_modules` beside
the plugin package. OpenClaw scans the managed npm root before trusting the
install and uses npm to remove npm-managed packages during uninstall, so hoisted
runtime dependencies stay inside the managed cleanup boundary.

Plugins that import `openclaw/plugin-sdk/*` declare `openclaw` as a peer
dependency. OpenClaw does not let npm install a separate registry copy of the
host package into the managed root, because stale host packages can affect npm
peer resolution during later plugin installs. Managed npm installs skip npm peer
resolution/materialization for the shared root and OpenClaw reasserts
plugin-local `node_modules/openclaw` links for installed packages that declare
the host peer after install, update, or uninstall.

git installs clone or refresh the repository, then run:

```bash
npm install --omit=dev --ignore-scripts --no-audit --no-fund
```

The installed plugin then loads from that package directory, so package-local
and parent `node_modules` resolution works the same way it does for a normal
Node package.

## Local plugins

Local plugins are treated as developer-controlled directories. OpenClaw does not
run `npm install`, `pnpm install`, or dependency repair for them. If a local
plugin has dependencies, install them in that plugin before loading it.

Third-party TypeScript local plugins can use the emergency Jiti path. Packaged
JavaScript plugins and bundled internal plugins load through native
import/require instead of Jiti.

## Startup and reload

Gateway startup and config reload never install plugin dependencies. They read
the plugin install records, compute the entrypoint, and load it.

If a dependency is missing at runtime, the plugin fails to load and the error
should point the operator to an explicit fix:

```bash
openclaw plugins update <id>
openclaw plugins install <source>
openclaw doctor --fix
```

`doctor --fix` can clean legacy OpenClaw-generated dependency state and recover
downloadable plugins that are missing from the local install records when config
references them. Doctor does not repair dependencies for an already-installed
local plugin.

## Bundled plugins

Lightweight and core-critical bundled plugins are shipped as part of OpenClaw.
They should either have no heavy runtime dependency tree or be moved out to a
downloadable package on ClawHub/npm.

For the current generated list of plugins that ship in the core package, install
externally, or stay source-only, see [Plugin inventory](/plugins/plugin-inventory).

Bundled plugin manifests must not request dependency staging. Large or optional
plugin functionality should be packaged as a normal plugin and installed through
the same npm/git/ClawHub path as third-party plugins.

In source checkouts, OpenClaw treats the repository as a pnpm monorepo. After
`pnpm install`, bundled plugins load from `extensions/<id>` so package-local
workspace dependencies are available and edits are picked up directly. Source
checkout development is pnpm-only; plain `npm install` at the repository root is
not a supported way to prepare bundled plugin dependencies.

| Install shape                    | Bundled plugin location               | Dependency owner                                                     |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `npm install -g openclaw`        | Built runtime tree inside the package | OpenClaw package and explicit plugin install/update/doctor flows     |
| Git checkout plus `pnpm install` | `extensions/<id>` workspace packages  | The pnpm workspace, including each plugin package's own dependencies |
| `openclaw plugins install ...`   | Managed npm/git/ClawHub plugin root   | The plugin install/update flow                                       |

## Legacy cleanup

Older OpenClaw versions generated bundled-plugin dependency roots at startup or
during doctor repair. Current doctor cleanup removes those stale directories and
symlinks when `--fix` is used, including old `plugin-runtime-deps` roots, global
Node-prefix package symlinks that point at pruned `plugin-runtime-deps` targets,
`.openclaw-runtime-deps*` manifests, generated plugin `node_modules`, install
stage directories, and package-local pnpm stores. Packaged postinstall also
removes those global symlinks before pruning the legacy target roots so upgrades
do not leave dangling ESM package imports.

These paths are legacy debris only. New installs should not create them.
