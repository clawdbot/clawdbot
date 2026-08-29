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

OpenClaw-owned npm plugin packages never ship npm lockfiles. The repository
uses `pnpm-lock.yaml` as its committed product dependency review boundary, then
generates npm package locks only in temporary directories to validate the
publishable dependency graph:

```bash
pnpm deps:npm-lock:check
pnpm deps:npm-lock:check:changed
```

The checker strips plugin `devDependencies`, applies the workspace override
policy, and rejects generated versions absent from `pnpm-lock.yaml`. Nothing
is written into the checkout. Third-party plugin packages may still contain
lockfiles according to their own packaging policy; OpenClaw's installer leaves
that npm behavior to the installed npm version.

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
memory-lancedb, Microsoft Teams, Tlon) opt out with
`openclaw.release.bundleRuntimeDependencies: false`; they still ship a
precisely pinned manifest, but npm resolves runtime dependencies during install
instead of embedding every platform binary in the plugin tarball. The root
`openclaw` package also resolves dependencies at install time and does not
bundle its full dependency tree. See
[dependency locking](/gateway/security/dependency-locking).

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

Internal bundled plugins retain their dependency declarations in their own
manifests. Runtime dependencies that are not compiled into `dist` must also
be declared in the root OpenClaw package's `dependencies` or
`optionalDependencies`, because the root package ships their runtime.
External plugins keep their runtime dependencies plugin-local.

In source checkouts, use `pnpm install` followed by `pnpm build`. OpenClaw
prefers `dist/extensions`, then `dist-runtime/extensions`, and falls back to
`extensions` when neither built tree is available. Postinstall and build
preparation remove plugin-local `node_modules`, so bundled runtime resolution
must not depend on those directories. Rebuild to pick up source edits when
using a built tree. Source checkout development is pnpm-only; plain
`npm install` at the repository root does not prepare the pnpm workspace.

| Install shape                                   | Bundled plugin location                              | Dependency owner                                       |
| ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Global npm install                              | Built runtime tree inside the package                | Root OpenClaw package for internal bundled runtime     |
| Git checkout plus `pnpm install` + `pnpm build` | `dist/extensions`, then `dist-runtime/extensions`    | Root runtime declarations plus plugin manifests        |
| Unbuilt source checkout                         | `extensions/<id>` fallback when no built tree exists | pnpm workspace with explicit root runtime dependencies |
| `openclaw plugins install ...`                  | Managed npm project/git/ClawHub root                 | The plugin install/update flow                         |

For the global npm row, use
`npm install -g openclaw --allow-scripts=openclaw` on npm 12 or npm 11.16+.
On npm 11.15 and earlier, omit `--allow-scripts=openclaw`. Plugin dependency
convergence remains intentionally script-disabled and continues to use the
`--ignore-scripts` commands above.

### Native imports from a standalone source build

To import an already-built `extensions/<package>/dist` directly with Node,
explicitly prepare its host link from the source checkout root:

```bash
node scripts/lib/plugin-npm-runtime-build.mjs --prepare-native-import extensions/<package>
```

This requires existing root SDK output in `dist/plugin-sdk` and the selected
package's standalone runtime output. If the package output is missing, build
it first with `node scripts/lib/plugin-npm-runtime-build.mjs extensions/<package>`.
The preparation command does not rebuild either output or execute plugin code.
It only links the checkout as `node_modules/openclaw` for a real immediate
source package that declares `openclaw` in `peerDependencies` or `dependencies`.
It does not install third-party dependencies; those must already be available
through the pnpm workspace.

Preparation refuses symlinked package paths, unsafe manifests, and conflicting
dependency paths instead of reporting success. Ordinary package builds remain
artifact-only. Postinstall and root build preparation still remove source
plugin-local `node_modules`, including this link; rerun the explicit preparation
command afterward when needed. Runtime loading never performs this setup or
runs a package manager.

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
