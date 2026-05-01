---
summary: "How OpenClaw plans, stages, and repairs bundled plugin runtime dependencies"
read_when:
  - You are debugging bundled plugin runtime dependency repair
  - You are changing plugin startup, doctor, or package-manager install behavior
  - You are maintaining packaged OpenClaw installs or bundled plugin manifests
title: "Plugin dependency resolution"
sidebarTitle: "Dependencies"
---

OpenClaw does not install every bundled plugin dependency tree at package install
time. It first derives an effective plugin plan from config and plugin metadata,
then stages runtime dependencies only for bundled OpenClaw-owned plugins that
the plan can actually load.

This page covers packaged runtime dependencies for bundled OpenClaw plugins.
Third-party plugins and custom plugin paths still use explicit plugin
installation commands such as `openclaw plugins install` and
`openclaw plugins update`.

## Responsibility split

OpenClaw owns the plan and policy:

- which plugins are active for this config
- which dependency roots are writable or read-only
- when repair is allowed
- which plugin ids are staged for startup
- final checks before importing plugin runtime modules

The package manager owns dependency convergence:

- package graph resolution
- production, optional, and peer dependency handling
- `node_modules` layout
- package integrity
- lock and install metadata

In practice, OpenClaw should decide what needs to exist. `pnpm` or `npm` should
make the filesystem match that decision.

OpenClaw also owns the per-install-root coordination lock. Package managers
protect their own install transaction, but they do not serialize OpenClaw's
manifest writes, isolated-stage copy/rename, final validation, or plugin import
against another Gateway, doctor, or CLI process touching the same runtime
dependency root.

## Effective plugin plan

The effective plugin plan is derived from config plus discovered plugin
metadata. These inputs can activate bundled plugin runtime dependencies:

- `plugins.entries.<id>.enabled`
- `plugins.allow`, `plugins.deny`, and `plugins.enabled`
- legacy channel config such as `channels.telegram.enabled`
- configured providers, models, or CLI backend references that require a plugin
- bundled manifest defaults such as `enabledByDefault`
- the installed plugin index and bundled manifest metadata

Explicit disablement wins. A disabled plugin, denied plugin id, disabled plugin
system, or disabled channel does not trigger runtime dependency repair. Persisted
auth state alone also does not activate a bundled channel or provider.

The plugin plan is the stable input. The generated dependency materialization is
an output of that plan.

## Startup flow

Gateway startup parses config and builds the startup plugin lookup table before
plugin runtime modules are loaded. Startup then stages runtime dependencies only
for the `startupPluginIds` selected by that plan.

For packaged installs, dependency staging is allowed before plugin import. After
staging, the runtime loader imports startup plugins with install repair disabled;
at that point missing dependency materialization is treated as a load failure,
not another repair loop.

When startup dependency staging is deferred behind the HTTP bind, Gateway
readiness stays blocked on the `plugin-runtime-deps` reason until the selected
startup plugin dependencies are materialized and the startup plugin runtime has
loaded.

## When repair runs

Runtime dependency repair should run when one of these is true:

- the effective plugin plan changed and adds bundled plugins that need runtime
  dependencies
- the generated dependency manifest no longer matches the effective plan
- expected installed package sentinels are missing or incomplete
- `openclaw doctor --fix` or `openclaw plugins deps --repair` was requested

Runtime dependency repair should not run just because OpenClaw started. A normal
startup with an unchanged plan and complete dependency materialization should
skip package-manager work.

Commands that edit config, enable plugins, or repair doctor findings can enter
plugin plan mode once, materialize the newly required bundled dependencies, then
return to the normal command flow. Local `openclaw onboard` and
`openclaw configure` do this automatically after they successfully write config,
so the next Gateway run does not discover missing bundled plugin packages after
startup has already begun. Remote onboarding/configure stays read-only for local
runtime deps.

## Hot reload rule

Hot reload paths that can change active plugins must go back through plugin plan
mode before loading plugin runtime. The reload should compare the new effective
plugin plan with the previous one, stage missing dependencies for newly active
bundled plugins, then load or restart the affected runtime.

If a config reload does not change the effective plugin plan, it should not
repair bundled runtime dependencies.

## Package manager execution

OpenClaw writes a generated install manifest for the selected bundled runtime
dependencies and runs the package manager in the runtime dependency install
root. It prefers `pnpm` when available and falls back to the Node-bundled `npm`
runner.

The `pnpm` path uses production dependencies, disables lifecycle scripts, ignores
the workspace, and keeps the store inside the install root:

```bash
pnpm install \
  --prod \
  --ignore-scripts \
  --ignore-workspace \
  --config.frozen-lockfile=false \
  --config.minimum-release-age=0 \
  --config.store-dir=<install-root>/.openclaw-pnpm-store \
  --config.node-linker=hoisted \
  --config.virtual-store-dir=.pnpm
```

The `npm` fallback uses the safe npm install wrapper with production
dependencies, lifecycle scripts disabled, workspace mode disabled, audit
disabled, fund output disabled, legacy peer dependency behavior, and package-lock
output enabled for the generated install root.

After install, OpenClaw validates the staged dependency tree before making it
visible to the runtime dependency root. Isolated staging is copied into the
runtime dependency root and validated again.

The whole repair/materialization section is guarded by an install-root lock.
Current lock owners record PID, process start-time when available, and creation
time. Legacy locks without process start-time or creation-time evidence are only
reclaimed by filesystem age, so recycled Docker PID 1 locks recover without
expiring normal long-running current installs by age alone.

## Install roots

Packaged installs must not mutate read-only package directories. OpenClaw can
read dependency roots from packaged layers, but writes generated runtime
dependencies to a writable stage such as:

- `OPENCLAW_PLUGIN_STAGE_DIR`
- `$STATE_DIRECTORY`
- `~/.openclaw/plugin-runtime-deps`
- `/var/lib/openclaw/plugin-runtime-deps` in container-style installs

The writable root is the final materialization target. Older read-only roots are
kept as compatibility layers only when needed.

When a packaged OpenClaw update changes the versioned writable root but the
selected bundled-plugin dependency plan is still satisfied by a previous staged
root, repair reuses that previous `node_modules` tree instead of running the
package manager again. The new versioned root still gets its own current package
runtime mirror, so plugin code comes from the current OpenClaw package while
unchanged dependency trees are shared across updates. Reuse skips previous roots
with an active OpenClaw runtime-dependency lock, so a new root does not link to a
dependency tree that another Gateway, doctor, or CLI process is currently
repairing.

## Doctor and CLI commands

Use `plugins deps` to inspect or repair bundled plugin runtime dependency
materialization:

```bash
openclaw plugins deps
openclaw plugins deps --json
openclaw plugins deps --repair
openclaw plugins deps --prune
```

Use doctor when the dependency state is part of broader install health:

```bash
openclaw doctor
openclaw doctor --fix
```

`plugins deps` and doctor operate on OpenClaw-owned bundled plugin runtime
dependencies selected by the effective plugin plan. They are not third-party
plugin install or update commands.

## Troubleshooting

If a packaged install reports missing bundled runtime dependencies:

1. Run `openclaw plugins deps --json` to inspect the selected plan and missing
   packages.
2. Run `openclaw plugins deps --repair` or `openclaw doctor --fix` to repair the
   writable dependency stage.
3. If the install root is read-only, set `OPENCLAW_PLUGIN_STAGE_DIR` to a
   writable path and rerun repair.
4. Restart Gateway after repair if the missing dependency blocked startup plugin
   loading.

In source checkouts, the workspace install usually provides bundled plugin
dependencies. Run `pnpm install` for source dependency repair instead of using
packaged runtime dependency repair as the first step.
