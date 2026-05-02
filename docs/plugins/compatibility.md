---
summary: "Plugin compatibility contracts, deprecation metadata, and migration expectations"
title: "Plugin compatibility"
read_when:
  - You maintain an OpenClaw plugin
  - You see a plugin compatibility warning
  - You are planning a plugin SDK or manifest migration
---

OpenClaw keeps older plugin contracts wired through named compatibility
adapters before removing them. This protects existing bundled and external
plugins while the SDK, manifest, setup, config, and agent runtime contracts
evolve.

## Compatibility registry

Plugin compatibility contracts are tracked in the core registry at
`src/plugins/compat/registry.ts`.

Each record has:

- a stable compatibility code
- status: `active`, `deprecated`, `removal-pending`, or `removed`
- owner: SDK, config, setup, channel, provider, plugin execution, agent runtime,
  or core
- introduction and deprecation dates when applicable
- replacement guidance
- docs, diagnostics, and tests that cover the old and new behavior

The registry is the source for maintainer planning and future plugin inspector
checks. If a plugin-facing behavior changes, add or update the compatibility
record in the same change that adds the adapter.

Doctor repair and migration compatibility is tracked separately at
`src/commands/doctor/shared/deprecation-compat.ts`. Those records cover old
config shapes, install-ledger layouts, and repair shims that may need to stay
available after the runtime compatibility path is removed.

Release sweeps should check both registries. Do not delete a doctor migration
just because the matching runtime or config compatibility record expired; first
verify there is no supported upgrade path that still needs the repair. Also
revalidate each replacement annotation during release planning because plugin
ownership and config footprint can change as providers and channels move out of
core.

## Plugin inspector package

The plugin inspector should live outside the core OpenClaw repo as a separate
package/repository backed by the versioned compatibility and manifest
contracts.

The day-one CLI should be:

```sh
openclaw-plugin-inspector ./my-plugin
```

It should emit:

- manifest/schema validation
- the contract compatibility version being checked
- install/source metadata checks
- cold-path import checks
- deprecation and compatibility warnings

Use `--json` for stable machine-readable output in CI annotations. OpenClaw
core should expose contracts and fixtures the inspector can consume, but should
not publish the inspector binary from the main `openclaw` package.

### Maintainer acceptance lane

Use Blacksmith Testbox for the installable-package acceptance lane when validating
the external inspector against OpenClaw plugin packages. Run it from a clean
OpenClaw checkout after the package is built:

```sh
blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90
blacksmith testbox run --id <tbx_id> "pnpm install && pnpm build && npm exec --yes @openclaw/plugin-inspector@0.1.0 -- ./extensions/telegram --json"
blacksmith testbox run --id <tbx_id> "npm exec --yes @openclaw/plugin-inspector@0.1.0 -- ./extensions/discord --json"
blacksmith testbox run --id <tbx_id> "npm exec --yes @openclaw/plugin-inspector@0.1.0 -- <clawhub-plugin-dir> --json"
blacksmith testbox stop <tbx_id>
```

Keep this lane opt-in for maintainers because it installs an external npm
package and may inspect plugin packages cloned outside the repo. The local repo
guards cover the SDK export map, compatibility registry metadata, deprecated
SDK-import burn-down, and bundled extension import boundaries; Testbox inspector
proof covers the package as external plugin authors consume it.

## Deprecation policy

OpenClaw should not remove a documented plugin contract in the same release
that introduces its replacement.

The migration sequence is:

1. Add the new contract.
2. Keep the old behavior wired through a named compatibility adapter.
3. Emit diagnostics or warnings when plugin authors can act.
4. Document the replacement and timeline.
5. Test both old and new paths.
6. Wait through the announced migration window.
7. Remove only with explicit breaking-release approval.

Deprecated records must include a warning start date, replacement, docs link,
and final removal date no more than three months after the warning starts. Do
not add a deprecated compatibility path with an open-ended removal window unless
maintainers explicitly decide it is permanent compatibility and mark it `active`
instead.

## Current compatibility areas

Current compatibility records include:

- legacy broad SDK imports such as `openclaw/plugin-sdk/compat`
- legacy hook-only plugin shapes and `before_agent_start`
- legacy `activate(api)` plugin entrypoints while plugins migrate to
  `register(api)`
- legacy SDK aliases such as `openclaw/extension-api`,
  `openclaw/plugin-sdk/channel-runtime`, `openclaw/plugin-sdk/command-auth`
  status builders, `openclaw/plugin-sdk/test-utils` (replaced by focused
  `openclaw/plugin-sdk/*` test subpaths), and the `ClawdbotConfig` /
  `OpenClawSchemaType` type aliases
- bundled plugin allowlist and enablement behavior
- legacy provider/channel env-var manifest metadata
- legacy provider plugin hooks and type aliases while providers move to
  explicit catalog, auth, thinking, replay, and transport hooks
- legacy runtime aliases such as `api.runtime.taskFlow`,
  `api.runtime.subagent.getSession`, `api.runtime.stt`, and deprecated
  `api.runtime.config.loadConfig()` / `api.runtime.config.writeConfigFile(...)`
- legacy memory-plugin split registration while memory plugins move to
  `registerMemoryCapability`
- legacy channel SDK helpers for native message schemas, mention gating,
  inbound envelope formatting, and approval capability nesting
- legacy channel route key and comparable-target helper aliases while plugins
  move to `openclaw/plugin-sdk/channel-route`
- activation hints that are being replaced by manifest contribution ownership
- `setup-api` runtime fallback while setup descriptors move to cold
  `setup.requiresRuntime: false` metadata
- provider `discovery` hooks while provider catalog hooks move to
  `catalog.run(...)`
- channel `showConfigured` / `showInSetup` metadata while channel packages move
  to `openclaw.channel.exposure`
- legacy runtime-policy config keys while doctor migrates operators to
  `agentRuntime`
- generated bundled channel config metadata fallback while registry-first
  `channelConfigs` metadata lands
- persisted plugin registry disable and install-migration env flags while
  repair flows migrate operators to `openclaw plugins registry --refresh` and
  `openclaw doctor --fix`
- legacy plugin-owned web search, web fetch, and x_search config paths while
  doctor migrates them to `plugins.entries.<plugin>.config`
- legacy `plugins.installs` authored config and bundled plugin load-path
  aliases while install metadata moves into the state-managed plugin ledger

New plugin code should prefer the replacement listed in the registry and in the
specific migration guide. Existing plugins can keep using a compatibility path
until the docs, diagnostics, and release notes announce a removal window.

## Release notes

Release notes should include upcoming plugin deprecations with target dates and
links to migration docs. That warning needs to happen before a compatibility
path moves to `removal-pending` or `removed`.
