---
title: Plugins - Installing and Running Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Installing and Running Plugins Maturity Note

## Summary

Runtime loading and lifecycle remains a Stable category. OpenClaw has a clear manifest-first loading model, pre-execution safety gates, explicit runtime-versus-metadata cache boundaries, durable install records, active registry switching, bundled runtime staging, and strong end-to-end proof for managed npm plugin lifecycle, bundled install/uninstall runtime smoke, and corrupt-plugin update tolerance. The main remaining risks are uneven runtime proof across every install source, the intentionally in-process trust model for native plugins, and real packaged-install drift around mixed Homebrew Node/runtime/plugin cache state.

## Category Scope

This category covers manifest-first plugin loading, candidate safety gates, enablement and scoped load decisions, `setupEntry` and full-runtime activation modes, active registry replacement and reuse, bundled runtime staging, install-record handoff into runtime loading, dependency-repair boundaries, and install/update/uninstall effects on runtime state.

Out of scope: per-plugin feature behavior after registration, plugin authoring ergonomics, marketplace ranking/trust UX, and the broader public SDK subpath/API surface.

## Features

- Plugin setup: Operators can run plugin setup flows without fully activating runtime behavior.
- Runtime activation: Enabled plugins activate and register runtime behavior after manifest validation succeeds.
- Enable and disable: Operators can enable or disable installed plugins without losing install state.
- Safe load failures: Unsafe or unsupported plugin loads are blocked with diagnosable failures before runtime execution.
- Dependency repair: Runtime can detect and repair missing or stale plugin dependencies.
- Install update and uninstall: Install, update, and uninstall lifecycle behavior is defined and tested.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, and `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: `discrawl status --json` succeeded with `generated_at=2026-05-30T00:38:20Z`, `state=current`, summary `1487536 messages across 25831 channels`, and `last_sync_at=2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals:
  - Docs and source agree on a manifest-first split where metadata validation and startup planning happen before full `register(api)` runtime activation.
  - `test:docker:plugin-lifecycle-matrix` exercises real managed npm lifecycle flow: install, runtime inspect, disable, enable, upgrade, downgrade, and missing-code uninstall.
  - `test:docker:bundled-plugin-install-uninstall` launches a real Gateway, waits for `/readyz`, performs runtime RPC calls, and rejects post-ready dependency work for bundled plugin runtime smoke.
  - `test:docker:update-corrupt-plugin` proves update-time tolerance when a managed plugin loses `package.json`, including warning or disabled-after-failure outcomes instead of aborting the core update.
- Negative signals:
  - The strongest runtime-flow proof is for managed npm installs and bundled packaged plugins, not a single category-owned lane covering git, ClawHub, marketplace, local path, and linked-source installs with the same lifecycle assertions.
  - Bundled runtime smoke intentionally skips plugins that require config, so configured startup and `setupEntry` branches are not uniformly exercised by live category-specific evidence.
  - The evidence proves runtime registration and CLI lifecycle effects, but not every managed host auto-restart path across service managers.
- Integration gaps:
  - Add one lifecycle matrix that repeats runtime inspect/smoke assertions across npm, ClawHub, git, local path, linked source, marketplace, and bundled sources.
  - Add configured-plugin and `setupEntry` runtime smoke coverage with safe fixture channels/providers.
  - Add explicit managed-Gateway restart verification around install, update, and uninstall instead of relying on docs and release-path expectations.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the category. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Stable (84%)`
- Gitcrawl reports:
  - `gitcrawl search openclaw/openclaw --query "plugin runtime lifecycle install uninstall update corrupt" --json` returned no direct issue or PR hits for repeated lifecycle regressions.
  - `gitcrawl search openclaw/openclaw --query "plugin dependency runtime deps repair" --json` returned open issue `#75250`, "Bug: OpenClaw breaks after Homebrew updates due to mixed Homebrew Node/runtime/plugin cache drift", which is directly relevant to runtime-loading durability for packaged installs.
- Discrawl reports:
  - `discrawl --json search "plugin runtime lifecycle" --limit 5` returned maintainer and community discussion about plugin-registry reload/reuse performance and runtime containment boundaries, but not a wave of operator reports that install/uninstall/update lifecycle is broadly broken.
  - `discrawl --json search "plugin install restart runtime" --limit 5` returned release/help chatter that emphasizes restart verification and plugin install/update/doctor repair, which reinforces that operator restart and repair guidance is still an important part of the lifecycle story.
- Good qualities:
  - Docs and source align on the control-plane versus data-plane split: manifest/schema metadata stays cold-path readable, while runtime behavior only comes from `register(api)` or `setupEntry` paths.
  - Safety gates happen before runtime execution, and blocked candidates stay diagnosable by plugin id instead of silently disappearing from config validation.
  - Runtime state management is explicit: empty scoped loads stay empty, active registry replacement synchronizes tracked surfaces, and load errors can be raised as structured `PluginLoadFailureError` failures.
  - Bundled runtime staging keeps the `openclaw/plugin-sdk` alias constrained to generated public exports and deliberately excludes plugin `node_modules` from the runtime overlay.
- Bad qualities:
  - Native plugins still run in-process and unsandboxed, so lifecycle correctness does not reduce the blast radius of a buggy or malicious plugin.
  - Operators still need to distinguish cold inventory (`plugins list`) from live runtime import state and understand when a Gateway restart is required.
  - Issue `#75250` shows packaged-install drift remains a real operational risk when Node, runtime files, and cached plugin dependencies diverge.
- Excluded from quality:
  - Unit, integration, and Docker e2e depth are not used as Quality inputs for this category.
  - The blocked surface validation commands below are treated as local validation blockers, not product-quality evidence.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Known Gaps

- Category-owned runtime-flow evidence is still strongest for managed npm and bundled packaged plugins rather than all advertised install sources.
- Config-required plugins and `setupEntry`-heavy startup paths still need more direct live validation in category-specific lanes.
- Operator clarity still depends on restart and repair guidance because cold metadata discovery and live runtime activation are intentionally separate.
- The in-process trust model and the open packaged-install drift issue keep this category below Lovable.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/architecture.md:142`-`170`: defines the manifest-first boundary, metadata snapshot contents, snapshot replacement rules, and the runtime-versus-metadata cache split.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture.md:446`-`459`: states that native plugins run in-process, are unsandboxed, and that bundled-plugin trust comes from source snapshot rather than install metadata.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture-internals.md:20`-`41`: documents load order, pre-execution safety gates, and `register`/`activate` lifecycle behavior.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture-internals.md:45`-`59`: documents manifest-first control-plane behavior and keeps `activation` / `setup` metadata separate from runtime registration.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture-internals.md:99`-`130`: defines the plugin cache boundary and limits persistent caching to runtime-loaded artifacts.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture-internals.md:869`-`888`: documents install-time dependency policy and `setupEntry` / deferred configured-channel startup behavior.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture-internals.md:1017`-`1020`: makes `plugins/installs.json` the durable install source of truth even when manifests are missing or invalid.
- `/Users/kevinlin/code/openclaw/docs/plugins/dependency-resolution.md:11`-`31`: states that runtime loading never runs package managers and limits OpenClaw ownership to explicit plugin lifecycle operations.
- `/Users/kevinlin/code/openclaw/docs/plugins/dependency-resolution.md:120`-`124`: states that startup and config reload read install records and fail with actionable repair errors instead of repairing in-place.
- `/Users/kevinlin/code/openclaw/docs/plugins/manage-plugins.md:16`-`21`: defines install workflow as install, restart if needed, then verify runtime registrations.
- `/Users/kevinlin/code/openclaw/docs/plugins/manage-plugins.md:40`-`44`: states that `plugins list` is a cold inventory check and does not prove a running Gateway imported plugin runtime.

### Source

- `/Users/kevinlin/code/openclaw/src/plugins/loader.ts:1536`-`1545`: raises `PluginLoadFailureError` when plugin load errors are present and callers request throwing.
- `/Users/kevinlin/code/openclaw/src/plugins/loader.ts:1548`-`1560`: activates the registry and preserves or reinitializes the global hook runner depending on runtime mode.
- `/Users/kevinlin/code/openclaw/src/plugins/loader.ts:1564`-`1576`: preserves empty explicit plugin scopes instead of widening to all discovered plugins.
- `/Users/kevinlin/code/openclaw/src/plugins/loader.ts:2494`-`2505`: emits explicit diagnostics for missing `register`/`activate` exports before runtime API creation.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime.ts:182`-`198`: replaces the active registry, syncs tracked HTTP/channel surfaces, and advances runtime state versioning.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-plugin-boundary.ts:132`-`145`: requires bundled runtime modules to load natively as built JavaScript rather than through source fallback.
- `/Users/kevinlin/code/openclaw/scripts/stage-bundled-plugin-runtime.mjs:191`-`205`: generates the `openclaw/plugin-sdk` runtime alias from public dist exports only.
- `/Users/kevinlin/code/openclaw/scripts/stage-bundled-plugin-runtime.mjs:278`-`318`: stages runtime overlays while skipping plugin `node_modules`, wrapping runtime JS files, and copying only selected runtime files.
- `/Users/kevinlin/code/openclaw/scripts/stage-bundled-plugin-runtime.mjs:322`-`345`: rebuilds `dist-runtime/extensions` from `dist/extensions` and removes stale runtime roots before staging.

### Integration tests

- `/Users/kevinlin/code/openclaw/package.json:1642`: wires `test:docker:bundled-plugin-install-uninstall`.
- `/Users/kevinlin/code/openclaw/package.json:1703`: wires `test:docker:plugin-lifecycle-matrix`.
- `/Users/kevinlin/code/openclaw/package.json:1714`: wires `test:docker:update-corrupt-plugin`.
- `/Users/kevinlin/code/openclaw/docs/help/testing.md:791`-`793`: documents the runtime lifecycle and plugin install/update Docker lanes that back this category.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:41`-`66`: covers managed npm install, runtime inspect, disable/enable, upgrade/downgrade, and missing-code uninstall.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/probe.mjs:38`-`71`: asserts installed version and npm project-root layout for managed plugin installs.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:40`-`57`: installs bundled plugins, runs runtime smoke, then force-uninstalls them.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:376`-`430`: starts a real Gateway process and waits for readiness.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:500`-`538`: checks `/readyz` and performs Gateway RPC calls over WebSocket with token auth.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:817`-`819`: fails runtime smoke if post-ready dependency installation work appears in logs.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh:37`-`69`: installs a managed external plugin, removes `package.json`, and updates OpenClaw with corrupt plugin state present.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-update/probe.mjs:115`-`188`: requires warning-or-tolerated outcomes and validates disabled-after-failure behavior for corrupt plugins.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/runtime/load-context.test.ts:145`: verifies derived metadata becomes a reusable runtime snapshot.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/load-context.test.ts:188`: verifies install records thread from metadata snapshot into runtime load options.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-registry-loader.test.ts:173`: verifies configured-channel loads reuse the shared runtime load context.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-registry-loader.test.ts:378`: verifies empty all-scope loads are preserved instead of widening.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-registry-loader.test.ts:389`: verifies active empty registries can be reused safely.
- `/Users/kevinlin/code/openclaw/src/plugins/runtime/runtime-registry-loader.test.ts:429`: verifies non-empty active registries are not incorrectly reused for empty scope loads.
- `/Users/kevinlin/code/openclaw/src/plugins/stage-bundled-plugin-runtime.test.ts:97`: verifies runtime wrappers are staged without linking plugin `node_modules`.
- `/Users/kevinlin/code/openclaw/src/plugins/stage-bundled-plugin-runtime.test.ts:546`: verifies stale runtime plugin directories are removed when no longer present in `dist`.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - would verify that the generated public SDK export inventory still matches the checked-in runtime alias/staging surface, but local validation never reached command semantics because dependency installation failed with 403 registry auth errors for `@microsoft/teams.cards` / `@microsoft/teams.api` and `No authorization header was set for the request`.
- `pnpm plugin-sdk:api:check`: `blocked` - would detect public Plugin SDK API drift that can affect runtime loading/staging compatibility, but the same local dependency-auth failure blocked real validation.
- `pnpm plugin-sdk:surface:check`: `blocked` - would enforce public SDK surface-size and deprecated-export limits that feed bundled runtime staging, but the same local dependency-auth failure blocked real validation.
- `pnpm plugins:boundary-report:ci`: `blocked` - would validate reserved-import and cross-owner plugin boundary contracts relevant to runtime loading seams, but the same local dependency-auth failure blocked real validation.
- `pnpm release:plugins:npm:check`: `blocked` - would validate npm release metadata/readiness for packaged plugin lifecycle flows, but the same local dependency-auth failure blocked real validation.
- `pnpm release:plugins:clawhub:check`: `blocked` - would validate ClawHub release metadata/readiness for plugin distribution paths adjacent to this category, but the same local dependency-auth failure blocked real validation.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "plugin runtime lifecycle install uninstall update corrupt" --json`

Results:

- `{"hits":[],"mode":"keyword","query":"plugin runtime lifecycle install uninstall update corrupt","repository":"openclaw/openclaw"}`

Query:

`gitcrawl search openclaw/openclaw --query "plugin dependency runtime deps repair" --json`

Results:

- One open issue: `#75250` "Bug: OpenClaw breaks after Homebrew updates due to mixed Homebrew Node/runtime/plugin cache drift" (`https://github.com/openclaw/openclaw/issues/75250`). The snippet mentions gateway host version drift and cached plugin runtime dependencies referencing missing SDK files.

### Discrawl queries

Query:

`discrawl --json search "plugin runtime lifecycle" --limit 5`

Results:

- Returned maintainer/community discussion rather than repeated breakage reports, including a maintainer update on plugin-registry reload/reuse work and a design discussion about runtime containment for skill-driven automation.

Query:

`discrawl --json search "plugin install restart runtime" --limit 5`

Results:

- Returned release/help messages that emphasize plugin install/update/doctor repair and Gateway restart verification, including May 2026 beta notes and user-help guidance to reinstall a plugin and restart the Gateway.
