---
title: Plugins Feature Matrix
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins Feature Matrix

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (82%)`
- Quality: `Stable (80%)`
- Completeness: `Stable (81%)`
- LTS Features: `7/9`

## Summary

This report expands the scorecard surface named "Plugins"
from the maturity scorecard into the major author-facing,
operator-facing, and maintainer-facing categories behind that row.

The detailed audit supports a Stable rollup on both Coverage and Quality, but
the surface should still be interpreted as beta-to-stable rather than promoted
unconditionally. The strongest areas are bundled plugin discovery, runtime
loading, provider/tool architecture, and approval/security boundaries. The main
promotion blocker is the public SDK API and subpath surface: its category note
still records the lowest scores in the surface at `Beta (77%)` Coverage and
`Beta (74%)` Quality, with active archive evidence of subpath compatibility
repairs and whole-surface governance pressure. Distribution/release proof also
remains thinner than the stronger internal manifest, discovery, runtime, and
approval paths.

## Matrix

| Category                                                           | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                           |
| ------------------------------------------------------------------ | --- | -------------- | -------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Authoring and Packaging plugins](public-sdk-api-and-subpaths.md)  | ✅  | `Beta (77%)`   | `Beta (74%)`   | `Beta (72%)`   | Root SDK entrypoint, Focused SDK imports, Entrypoint discovery, Migration shims, Plugin manifest, Package metadata, Runtime compatibility, Validation feedback |
| [Bundled plugins](bundled-plugin-discovery-and-inventory.md)       | ✅  | `Stable (86%)` | `Stable (84%)` | `Stable (88%)` | Bundled plugin listing, Bundled source overlays, Packaged bundled plugins, Generated plugin inventory, Bundled channel IDs                                     |
| [Canvas plugin](canvas-plugin.md)                                  | ❌  | `Beta (76%)`   | `Alpha (66%)`  | `Beta (74%)`   | Hosted Canvas and A2UI surfaces, Agent canvas tool, Node Canvas commands, Control UI embeds, Canvas documents, A2UI transport and snapshots                    |
| [Installing and running plugins](runtime-loading-and-lifecycle.md) | ✅  | `Stable (86%)` | `Stable (84%)` | `Stable (88%)` | Plugin setup, Runtime activation, Enable and disable, Safe load failures, Dependency repair, Install update and uninstall                                      |
| [Channel plugins](channel-plugin-architecture.md)                  | ✅  | `Stable (82%)` | `Beta (78%)`   | `Stable (80%)` | Inbound event handling, Outbound delivery, Ingress authorization, Destination resolution, Native approval prompts                                              |
| [Provider and tool plugins](provider-tool-plugin-architecture.md)  | ✅  | `Stable (84%)` | `Stable (82%)` | `Stable (84%)` | Provider plugins, Tool plugins, Model catalogs, Provider auth, Web search and fetch, Mixed plugins                                                             |
| [Plugin approvals](approval-and-security-boundaries.md)            | ✅  | `Stable (84%)` | `Stable (86%)` | `Stable (86%)` | Approval requests, Native approval delivery, Same-chat fallbacks, Exec and plugin separation, Approval replay protection, Security helpers                     |
| [Publishing plugins](distribution-release-and-compatibility.md)    | ✅  | `Beta (79%)`   | `Stable (82%)` | `Beta (74%)`   | Install sources, ClawHub publishing, npm publishing, Compatibility signaling, Update and rollback expectations, Third-party publication rules                  |
| [Testing plugins](developer-testing-and-fixtures.md)               | ❌  | `Stable (84%)` | `Stable (81%)` | `Stable (82%)` | Test fixtures, Local test environment, Plugin runtime harness, Unit and integration scaffolds, Docker lifecycle suites, Smoke tests                            |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Authoring and Packaging plugins

Search anchors: plugin sdk entrypoints, plugin sdk subpaths, plugin manifest, package metadata, authoring plugins, packaging plugins.

Category note: [Authoring and Packaging plugins](public-sdk-api-and-subpaths.md)

Score decisions:

- Coverage: `Beta (77%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (72%)`
- LTS: ✅

Features:

- Root SDK entrypoint: Plugin authors use the supported root Plugin SDK entrypoint when the top-level contract is sufficient.
- Focused SDK imports: Plugin authors use focused Plugin SDK subpaths instead of relying on one broad catch-all entrypoint.
- Entrypoint discovery: Plugin authors discover the supported public entrypoints and their support status from the SDK docs and entrypoint catalog.
- Migration shims: Deprecated or compatibility subpaths continue to resolve during author migrations.
- Plugin manifest: `openclaw.plugin.json` declares plugin identity, capabilities, and config schema.
- Package metadata: `package.json` carries the required `openclaw` metadata for discovery and release flows.
- Runtime compatibility: Plugin packages declare supported runtime and plugin API compatibility.
- Validation feedback: Manifest and package contract validation fails fast on malformed or inconsistent metadata.

Primary docs:

- `docs/plugins/building-plugins.md`
- `docs/plugins/sdk-overview.md`
- `docs/plugins/sdk-entrypoints.md`
- `docs/plugins/sdk-subpaths.md`
- `docs/plugins/manifest.md`
- `docs/plugins/reference.md`

Major quality/completeness gaps:

- This category still carries the broadest author-facing contract in the
  surface, and archive evidence continues to show subpath compatibility fixes,
  whole-surface consolidation pressure, and requests to reduce author-facing
  sprawl.
- The strongest validation commands for this category were blocked locally by
  dependency registry-auth failures during this rescore, so there is still no
  fresh surface-budget or packaged API-baseline result to offset the archive
  pressure.

### 2. Bundled plugins

Search anchors: bundled plugins, plugin inventory, bundled plugin metadata.

Category note: [Bundled plugins](bundled-plugin-discovery-and-inventory.md)

Score decisions:

- Coverage: `Stable (86%)`
- Quality: `Stable (84%)`
- Completeness: `Stable (88%)`
- LTS: ✅

Features:

- Bundled plugin listing: Operators and maintainers can inspect the bundled plugin set and its published metadata.
- Bundled source overlays: Source overlays work for local development and repo-driven testing.
- Packaged bundled plugins: Built distributions discover bundled plugins from packaged roots.
- Generated plugin inventory: Generated plugin inventory and reference docs describe what ships in core versus what installs separately.
- Bundled channel IDs: Bundled channel ids are discovered and normalized from plugin metadata.

Primary docs:

- `docs/plugins/plugin-inventory.md`
- `docs/cli/plugins.md`
- `docs/plugins/architecture-internals.md`

Major quality/completeness gaps:

- Discovery and inventory are strong internally, but the audit did not find a
  live docs-publish or live ClawHub/npm scenario that ties the generated
  inventory back to external install behavior.

### 3. Canvas plugin

Search anchors: Canvas plugin, hosted canvas documents, A2UI, canvas tool, canvas node commands.

Category note: [Canvas plugin](canvas-plugin.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Hosted Canvas and A2UI surfaces: Canvas plugin registers authenticated Gateway HTTP and WebSocket routes for hosted Canvas documents and A2UI runtime surfaces.
- Agent canvas tool: Canvas plugin registers the agent-facing `canvas` tool for present, hide, navigate, eval, snapshot, and A2UI control.
- Node Canvas commands: Canvas plugin owns node invoke policy for `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, and `canvas.a2ui.*` commands.
- Control UI embeds: Assistant output can embed hosted Canvas document URLs in Control UI and WebChat sessions.
- Canvas documents: Canvas plugin materializes hosted document files and `/__openclaw__/canvas/documents/...` URLs.
- A2UI transport and snapshots: Canvas plugin groups A2UI push, reset, and JSONL transport with snapshot capture and node-rendered Canvas state.

Primary docs:

- `docs/plugins/reference/canvas.md`
- `docs/refactor/canvas.md`
- `docs/gateway/configuration-reference.md`

Major quality/completeness gaps:

- Canvas has source/docs coverage for the feature family, but no recurring
  whole-family release smoke that proves hosted documents, Control UI embeds,
  node commands, snapshots, and A2UI transport together.
- The feature remains experimental and depends on Gateway host config, node
  availability, and embed/document URL reachability staying aligned.

### 4. Installing and running plugins

Search anchors: installing and running plugins, plugin setup, runtime activation, plugins doctor.

Category note: [Installing and running plugins](runtime-loading-and-lifecycle.md)

Score decisions:

- Coverage: `Stable (86%)`
- Quality: `Stable (84%)`
- Completeness: `Stable (88%)`
- LTS: ✅

Features:

- Plugin setup: Operators can run plugin setup flows without fully activating runtime behavior.
- Runtime activation: Enabled plugins activate and register runtime behavior after manifest validation succeeds.
- Enable and disable: Operators can enable or disable installed plugins without losing install state.
- Safe load failures: Unsafe or unsupported plugin loads are blocked with diagnosable failures before runtime execution.
- Dependency repair: Runtime can detect and repair missing or stale plugin dependencies.
- Install update and uninstall: Install, update, and uninstall lifecycle behavior is defined and tested.

Primary docs:

- `docs/plugins/architecture.md`
- `docs/plugins/architecture-internals.md`
- `docs/cli/plugins.md`

Major quality/completeness gaps:

- Runtime behavior is well structured, but operators still need to understand
  cold metadata reads, live runtime inspection, Gateway restarts, and dependency
  repair as separate workflows.

### 5. Channel plugins

Search anchors: channel plugins, sdk channel plugins, channel inbound, channel outbound.

Category note: [Channel plugins](channel-plugin-architecture.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Inbound event handling: Channel plugins register inbound hooks and normalize incoming events.
- Outbound delivery: Outbound adapters translate model output into channel-specific payloads.
- Ingress authorization: Channel ingress runtime enforces the shared inbound authorization boundary.
- Destination resolution: Target resolution maps users, threads, and conversations into channel destinations.
- Native approval prompts: Native channel actions can route approval prompts and responses through the approval system.

Primary docs:

- `docs/plugins/sdk-channel-plugins.md`
- `docs/plugins/sdk-channel-inbound.md`
- `docs/plugins/sdk-channel-outbound.md`

Major quality/completeness gaps:

- The channel plugin architecture is broad and actively migrated; docs warn
  authors away from deprecated compatibility paths while retaining many of them
  for existing bundled and external channels.
- External API/account variance means channel behavior still needs repeated live
  scenario proof per important channel.

### 6. Provider and tool plugins

Search anchors: provider and tool plugins, provider plugins, tool plugins, adding capabilities.

Category note: [Provider and tool plugins](provider-tool-plugin-architecture.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Stable (82%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Provider plugins: Provider plugins register models and capabilities with the runtime.
- Tool plugins: Tool plugins register discoverable tools and static metadata without ambiguous runtime ownership.
- Model catalogs: Provider model catalogs are discoverable and merge cleanly into global listings.
- Provider auth: Provider auth configuration and secret handling are supported.
- Web search and fetch: Provider or tool plugins can expose web search and fetch capabilities.
- Mixed plugins: Mixed provider and tool plugins are supported without ambiguous ownership.

Primary docs:

- `docs/plugins/sdk-provider-plugins.md`
- `docs/plugins/tool-plugins.md`
- `docs/plugins/adding-capabilities.md`

Major quality/completeness gaps:

- Gitcrawl evidence shows active fixes and migrations around web-search routing,
  model catalog/auth propagation, provider cooldowns, and SDK author surface
  sprawl.
- Mixed provider+tool plugins still require lower-level authoring knowledge than
  simple tool plugins.

### 7. Plugin approvals

Search anchors: plugin approvals, plugin permission requests, exec approvals.

Category note: [Plugin approvals](approval-and-security-boundaries.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Stable (86%)`
- Completeness: `Stable (86%)`
- LTS: ✅

Features:

- Approval requests: Plugin-initiated actions can request and resolve approvals through the standard flow.
- Native approval delivery: Privileged plugin actions can route approvals through channel-native prompts and responses.
- Same-chat fallbacks: Approval delivery can fall back to same-chat authorization notices when native routing is unavailable.
- Exec and plugin separation: Exec approvals remain distinct from plugin approval paths and native permission relays.
- Approval replay protection: Approval decisions remain scoped to the originating request, target, and device or node binding.
- Security helpers: Security helper exports provide approved primitives without widening trust boundaries.

Primary docs:

- `docs/plugins/plugin-permission-requests.md`
- `docs/tools/exec-approvals.md`
- `docs/plugins/sdk-channel-plugins.md`

Major quality/completeness gaps:

- The boundary model spans several docs pages and runtime packages.
- The audit found strong local/runtime proof, but no live external-channel
  transcript proof for native approval paths in the empty Discrawl archive.

### 8. Publishing plugins

Search anchors: publishing plugins, clawhub publishing, npm publishing, plugin compatibility.

Category note: [Publishing plugins](distribution-release-and-compatibility.md)

Score decisions:

- Coverage: `Beta (79%)`
- Quality: `Stable (82%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Install sources: Supported plugin install sources are explicit and validated.
- ClawHub publishing: Plugin metadata and workflows support publishing to ClawHub.
- npm publishing: Plugin metadata and workflows support publishing to npm when applicable.
- Compatibility signaling: Compatibility registry data maps plugins to supported runtime versions or channels.
- Update and rollback expectations: Plugin update semantics define what can be upgraded in place and what requires operator intervention.
- Third-party publication rules: External package acceptance rules gate third-party plugin packaging and publication.

Primary docs:

- `docs/cli/plugins.md`
- `docs/plugins/compatibility.md`
- `docs/clawhub/publishing.md`

Major quality/completeness gaps:

- Coverage remains Beta because the strongest evidence is local and Docker-based;
  external lifecycle scorecards for install, trust, update, rollback, and
  compatibility are still weaker than the internal release checks.

### 9. Testing plugins

Search anchors: testing plugins, sdk testing, plugin test fixtures, codex harness.

Category note: [Testing plugins](developer-testing-and-fixtures.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Stable (81%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Test fixtures: Fixtures provide reusable plugin metadata and runtime test inputs.
- Local test environment: Plugin authors can set up the local test environment and scoped helper configuration for plugin testing.
- Plugin runtime harness: Plugin test harnesses cover authoring and runtime integration paths.
- Unit and integration scaffolds: Scoped test helpers and configuration support unit and integration testing for plugin surfaces.
- Docker lifecycle suites: Docker-based end-to-end scripts validate packaged plugin lifecycle flows.
- Smoke tests: Local and packaged smoke tests catch broken installs before release.

Primary docs:

- `docs/plugins/sdk-testing.md`
- `docs/plugins/sdk-setup.md`
- `docs/plugins/codex-harness.md`

Major quality/completeness gaps:

- Test harness guidance is useful but dense, and authors still need to map the
  right local, package, Docker, and live proof path to their plugin type.

## Recommended scorecard interpretation

Keep the public scorecard row at `M3 Beta` until the public SDK API/subpath
surface is repaired and external plugin lifecycle proof is more regular. The
category rollups are high enough to justify "beta-to-stable" language, but a
surface whose public API boundary still scores `Beta (74%)` on Quality should
not be presented as fully Stable for normal external authors.

The next promotion criteria should be concrete:

- make the SDK surface/API baseline checks pass from current `main`;
- publish a small compatibility scorecard for external plugin install, update,
  rollback, and inspector behavior;
- add recurring live or release-smoke proof for at least one channel plugin, one
  provider plugin, and one mixed provider+tool plugin;
- keep Gitcrawl and Discrawl archive queries in the category notes fresh before
  any future rollup change.

## Out of scope for this surface

- Individual maturity scores for every bundled channel, provider, or tool
  plugin.
- The separate `ClawHub` scorecard row, except
  where install/release compatibility directly affects Plugin SDK architecture.
- General Gateway auth, session, memory, provider execution, and channel
  framework maturity outside plugin-owned contracts.

## Audit provenance

- Scorecard source:
  `docs/kevinslin/maturity-scorecard/maturity-scorecard.md`, row `Plugin SDK
and bundled plugin architecture`.
- Feature score source:
  `docs/kevinslin/maturity-scorecard/inventory/plugin-sdk-and-bundled-plugin-architecture/scores.yaml`.
- Output root:
  `docs/kevinslin/maturity-scorecard/inventory/plugin-sdk-and-bundled-plugin-architecture/`.
- OpenClaw source checkout:
  `/Users/kevinlin/code/openclaw` at `b877fc58a5c5 refactor: centralize numeric
coercion helpers`.
- Maintainers checkout:
  `/Users/kevinlin/code/claw/maintainers` at `2ac4ebe4d3be Enhance
claw-score documentation and validation commands for maturity scoring`.
- Gitcrawl freshness:
  `gitcrawl doctor --json` succeeded after sync; `last_sync_at`
  `2026-05-28T19:09:52.784704Z`; `thread_count` `29810`;
  `open_thread_count` `11181`; `db_path`
  `/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`;
  `version` `0.2.1`.
- Discrawl freshness:
  `discrawl status --json` generated at `2026-05-30T00:38:20Z`, reported
  `state` `current`, summary `1487536 messages across 25831 channels`, and
  `last_sync_at` `2026-05-29T19:27:40Z`.
- Archive interpretation:
  Gitcrawl searches are treated as current archive-backed GitHub evidence.
  Discrawl searches are feature-specific Discord evidence when local search
  succeeds; when a query is blocked locally, that is recorded as an environment
  gap rather than treated as a product signal.
