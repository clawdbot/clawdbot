---
title: Plugins - Authoring and Packaging Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Authoring and Packaging Plugins Maturity Note

## Summary

Authoring and packaging plugins is the combined public-author capability surface. OpenClaw gives plugin authors a documented path through `building-plugins`, the Plugin SDK overview and entrypoint catalog, focused subpath guidance, generated export maps, and compatibility shims for older author flows. It also defines the package and manifest contract through `openclaw.plugin.json`, `package.json#openclaw`, compatibility metadata, and release/install validation.

The category remains Beta on both Coverage and Quality. Packaging evidence is stronger than the public SDK import evidence, but the merged category should stay authoring-limited: the strongest authoring proof is still representative packed-package import and type-smoke coverage rather than exhaustive author-journey validation across the whole public SDK surface, taxonomy-owned validation commands were blocked locally by registry-auth failures, and archive evidence still shows active compatibility repairs plus broader pressure to simplify the author-facing surface.

## Category Scope

- The documented author journey for building plugins with the public Plugin SDK.
- Supported root and focused Plugin SDK imports that plugin authors can rely on in source and packaged installs.
- Native plugin manifest requirements in `openclaw.plugin.json`, including identity, config schema, declared contracts, and channel configuration metadata.
- External plugin package metadata under `package.json#openclaw`, including compatibility, runtime, build, and install metadata.
- Entrypoint discovery, support-status guidance, and migration shims that help authors move between old and current authoring patterns.
- The generated export-map and aliasing rules that make those author-facing imports resolve in source, dist, and installed-package contexts.
- Install-time and release-time enforcement for malformed manifests, malformed package compatibility metadata, missing manifest files, and packaged artifact completeness.
- Governance hooks that keep the author-facing SDK surface aligned with the checked-in inventory.
- Out of scope: runtime lifecycle after a plugin contract is accepted, the behavior quality of individual channel, provider, memory, or media capabilities, and channel/provider-specific runtime behavior beyond what the manifest or package contract declares up front.

## Features

- Root SDK entrypoint: Plugin authors use the supported root Plugin SDK entrypoint when the top-level contract is sufficient.
- Focused SDK imports: Plugin authors use focused Plugin SDK subpaths instead of relying on one broad catch-all entrypoint.
- Entrypoint discovery: Plugin authors discover the supported public entrypoints and their support status from the SDK docs and entrypoint catalog.
- Migration shims: Deprecated or compatibility subpaths continue to resolve during author migrations.
- Plugin manifest: `openclaw.plugin.json` declares plugin identity, capabilities, and config schema.
- Package metadata: `package.json` carries the required `openclaw` metadata for discovery and release flows.
- Runtime compatibility: Plugin packages declare supported runtime and plugin API compatibility.
- Validation feedback: Manifest and package contract validation fails fast on malformed or inconsistent metadata.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `last_sync_at` `2026-05-28T19:09:52.784704Z`, `thread_count` `29810`, `open_thread_count` `11181`, and db path `/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: `discrawl status --json` succeeded with `generated_at` `2026-05-30T00:38:20Z`, state `current`, summary `1487536 messages across 25831 channels`, and `last_sync_at` `2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Beta (77%)`
- Positive signals:
  - The release-check flow creates a packed external TypeScript consumer and verifies representative public SDK imports from the packed package: `openclaw/plugin-sdk`, `channel-entry-contract`, `config-contracts`, `provider-entry`, and `runtime-env` (`/Users/kevinlin/code/openclaw/scripts/release-check.ts:563`, `/Users/kevinlin/code/openclaw/scripts/release-check.ts:609`, `/Users/kevinlin/code/openclaw/scripts/fixtures/packed-plugin-sdk-type-smoke.ts:1`).
  - Release checks validate built `dist/plugin-sdk` exports, enforce size checks on critical entrypoints, and execute a real import smoke for `openclaw/plugin-sdk/core` from the built package (`/Users/kevinlin/code/openclaw/scripts/release-check.ts:1045`, `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1096`, `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1120`).
  - The Windows cross-OS release-check lane runs an installed-package runtime probe that imports `openclaw/plugin-sdk/plugin-runtime` and exercises start/stop behavior against the installed artifact (`/Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts:2778`, `/Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts:2847`, `/Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts:2860`).
  - Packaging proof is stronger than the authoring import surface: release checks perform a real `npm pack`, install the packed tarball into an isolated prefix, verify the packed package surface, run packaged CLI smoke, run bundled-plugin postinstall, run `openclaw plugins doctor`, and run packed bundled-plugin activation smoke before release (`/Users/kevinlin/code/openclaw/scripts/release-check.ts:680`, `/Users/kevinlin/code/openclaw/scripts/release-check.ts:700`, `/Users/kevinlin/code/openclaw/scripts/release-check.ts:781`).
  - Package-contract tests prove compatible npm fallback behavior, staged manifest and package metadata overlays, ClawHub package-contract rejection for missing `openclaw.compat.pluginApi`, and packed release artifact integrity (`/Users/kevinlin/code/openclaw/src/plugins/install.npm-spec.e2e.test.ts:305`, `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts:177`, `/Users/kevinlin/code/openclaw/test/plugin-clawhub-release.test.ts:58`, `/Users/kevinlin/code/openclaw/test/release-check.test.ts:635`).
- Negative signals:
  - The installed-package import smoke is still narrow. `CRITICAL_PLUGIN_SDK_IMPORT_SMOKE_SPECIFIERS` currently contains only `openclaw/plugin-sdk/core`, so the release path does not import the full public subpath set from a packed install (`/Users/kevinlin/code/openclaw/scripts/release-check.ts:148`, `/Users/kevinlin/code/openclaw/scripts/release-check.ts:153`).
  - I did not find a recurring packed-install sweep that imports every generated public SDK subpath and validates its paired `types` and runtime entry against the published export map.
  - The strongest package-contract proof is still local npm install and packed release validation; I did not find equivalent recurring proof for a full ClawHub publish-install-upgrade roundtrip across multiple host/plugin compatibility floors.
  - Post-upgrade compatibility diagnostics for manifest drift and skipped or incompatible installs are still tracked in open work rather than already settled into the mainline operator workflow.
  - Taxonomy-owned surface validation commands were attempted for this surface but blocked locally before real validation because dependency installation failed with 403 registry auth errors for `@microsoft/teams.cards` and `@microsoft/teams.api` with `No authorization header was set for the request`. Per the scoring policy, that is a local validation blocker rather than product evidence.
  - Archive evidence still shows user-visible regressions and active fixes around stale or missing subpath exports, which indicates the current integration net does not yet fully cover upgrade and compatibility paths.
- Integration gaps:
  - Add a packed-install sweep that imports every generated public SDK subpath and validates both runtime and `types` targets before publish.
  - Add recurring external-plugin upgrade smokes for deprecated, compatibility, and owner-gated subpaths, especially Codex-related compatibility paths.
  - Add recurring ClawHub publish/install compatibility coverage that proves package metadata through publish, discovery, selection, and install.
  - Land post-upgrade contract diagnostics so manifest drift, skipped plugins, and incompatible API floors have settled runtime/operator evidence outside open PRs.
  - Add broader cross-OS installed-package coverage for scoped alias resolution instead of relying on a small representative set.

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

- Score: `Beta (74%)`
- Gitcrawl reports:
  - `gitcrawl threads openclaw/openclaw --numbers 80219 --include-closed --json` shows an open whole-surface architecture issue documenting publication-by-list drift, export sprawl, and the lack of one authoritative support model for the public SDK surface.
  - `gitcrawl threads openclaw/openclaw --numbers 86087,81213 --include-closed --json` shows open beta regressions where `openclaw/plugin-sdk/codex-native-task-runtime` handling still creates user-visible failures or confusing export behavior during Codex-backed runs.
  - `gitcrawl threads openclaw/openclaw --numbers 86130,87119 --include-closed --json` shows open fixes to restore compatibility exports and to stop scoped subpath resolution from falling through to `root-alias.cjs`, which means this category is still actively hardening against correctness and upgrade bugs.
- Discrawl reports:
  - `discrawl --json search "plugin sdk subpath" --limit 10` returned maintainer-channel and mirrored GitHub archive hits that reinforce recurring SDK subpath issues: deprecated public helper usage called out on PR `#80967`, a test-only loader hook leaking into the public SDK on PR `#77205`, and external-plugin expectations around missing root-SDK helpers on issue `#68279`.
  - The discrawl results are mixed rather than catastrophic: they show active maintainer review and correction, but they also show the same category generating repeated support and compatibility conversations.
- Good qualities:
  - Docs are clear about narrow subpath imports, avoiding provider- or channel-branded convenience seams for new code, and treating reserved bundled-helper seams as non-general APIs (`/Users/kevinlin/code/openclaw/docs/plugins/sdk-overview.md:26`, `/Users/kevinlin/code/openclaw/docs/plugins/sdk-overview.md:49`, `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md:9`, `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md:50`).
  - Source has a deterministic inventory-to-export pipeline, with shared classification constants for reserved bundled seams, supported bundled facades, and public plugin-owned entrypoints (`/Users/kevinlin/code/openclaw/scripts/lib/plugin-sdk-entries.mjs:20`, `/Users/kevinlin/code/openclaw/src/plugin-sdk/entrypoints.ts:36`, `/Users/kevinlin/code/openclaw/src/plugin-sdk/entrypoints.ts:42`, `/Users/kevinlin/code/openclaw/src/plugin-sdk/entrypoints.ts:56`).
  - Loader aliasing is cautious: it validates trusted package roots, restricts subpath syntax, and gates private owner-only seams before publishing scoped alias maps (`/Users/kevinlin/code/openclaw/src/plugins/sdk-alias.ts:58`, `/Users/kevinlin/code/openclaw/src/plugins/sdk-alias.ts:70`, `/Users/kevinlin/code/openclaw/src/plugins/sdk-alias.ts:387`, `/Users/kevinlin/code/openclaw/src/plugins/sdk-alias.ts:752`).
  - The root SDK surface is intentionally tiny rather than a catch-all barrel, which reduces accidental root-surface drift (`/Users/kevinlin/code/openclaw/src/plugin-sdk/index.ts:1`).
  - Governance tools exist for export sync, API baseline drift detection, surface budgeting, and boundary reporting (`/Users/kevinlin/code/openclaw/package.json:1560`, `/Users/kevinlin/code/openclaw/package.json:1562`, `/Users/kevinlin/code/openclaw/package.json:1564`, `/Users/kevinlin/code/openclaw/package.json:1568`, `/Users/kevinlin/code/openclaw/scripts/generate-plugin-sdk-api-baseline.ts:16`, `/Users/kevinlin/code/openclaw/scripts/check-plugin-sdk-subpath-exports.mjs:17`, `/Users/kevinlin/code/openclaw/scripts/plugin-sdk-surface-report.mjs:23`).
  - Manifest docs cleanly separate native `openclaw.plugin.json` metadata from package metadata, and package-contract code normalizes compatibility fields in a small isolated package (`/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:9`, `/Users/kevinlin/code/openclaw/docs/plugins/building-plugins.md:61`, `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:20`, `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:46`).
  - Install-time code fails closed for malformed `openclaw.compat.pluginApi`, invalid `openclaw.install.minHostVersion`, incompatible plugin API ranges, and missing `openclaw.plugin.json` (`/Users/kevinlin/code/openclaw/src/plugins/package-compat.ts:7`, `/Users/kevinlin/code/openclaw/src/plugins/install.ts:145`, `/Users/kevinlin/code/openclaw/src/plugins/install.ts:170`, `/Users/kevinlin/code/openclaw/src/plugins/install.ts:1560`).
- Bad qualities:
  - Whole-surface governance is still fragmented across the entrypoint inventory, package exports, docs catalog, API baseline, and boundary reports instead of one authoritative support-status manifest, which is the core open concern in `#80219`.
  - Compatibility handling is still brittle enough to generate open beta regressions and active fix PRs around removed or stale subpaths, especially in Codex-related flows.
  - The public category is still large and classification-heavy, with reserved helper seams, plugin-owned surfaces, deprecated public subpaths, and wildcard re-export barrels all requiring continued curation (`/Users/kevinlin/code/openclaw/scripts/plugin-sdk-surface-report.mjs:23`, `/Users/kevinlin/code/openclaw/scripts/plugin-sdk-surface-report.mjs:177`, `/Users/kevinlin/code/openclaw/scripts/plugin-sdk-surface-report.mjs:207`).
  - Legacy or invalid contract usage can still degrade into confusing operator debugging rather than crisp remediation, and post-upgrade contract drift is still being formalized in open plugin-compat work.
  - Fresh local execution of the taxonomy-owned validation commands was blocked in this run, so I do not have current command output proving that export sync, baseline drift, surface budgets, or boundary-report gates are all green today.
- Excluded from quality:
  - I did not raise or lower Quality because of unit, integration, e2e, live, or runtime test coverage.
  - I did not treat the local dependency/auth failure on validation command setup as product-quality evidence.

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

- The category still lacks one authoritative support-status manifest that drives exports, docs, baselines, compatibility policy, and owner classification from a single source of truth.
- There is no fresh packed-install proof in this run that every public SDK subpath resolves correctly from the shipped package surface.
- Open archive evidence still shows upgrade-sensitive compatibility bugs around stale or removed SDK subpaths.
- Legacy plugin contract migrations and post-upgrade manifest drift can still produce confusing operator diagnostics.
- ClawHub and npm share the same package metadata contract, but recurring end-to-end proof is stronger on the npm and packed-release paths than on a full ClawHub publish/install/upgrade path.
- Taxonomy-owned validation commands for this surface were locally blocked by dependency registry auth failures, so a maintainer-run validation pass is still needed for current command-level confirmation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-overview.md:26` documents the narrow subpath import convention and discourages broad root-SDK usage for ordinary new code.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-overview.md:75` ties the public category directly to `plugin-sdk-entrypoints.json`, the local-only filter list, and `pnpm plugin-sdk:surface`.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md:9` explains that the public category is the generated public subset of the entrypoint inventory and calls out reserved bundled-helper seams plus local-only test helpers.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:28` requires every native plugin to ship `openclaw.plugin.json`, and `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:39` states that OpenClaw reads the manifest before loading plugin code.
- `/Users/kevinlin/code/openclaw/docs/plugins/building-plugins.md:61` shows external package metadata with `openclaw.compat.pluginApi`, gateway compatibility, and `openclaw.build.*` fields.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference.md:11` states that the generated plugin reference is derived from extension `package.json` and `openclaw.plugin.json` metadata.

### Source

- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-sdk-entries.mjs:20` builds the public entrypoint and package-export set by subtracting local-only subpaths from the entrypoint inventory.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/entrypoints.ts:36` classifies reserved bundled seams, supported bundled facades, and public plugin-owned surfaces in one TypeScript mirror of the inventory.
- `/Users/kevinlin/code/openclaw/package.json:146` declares the shipped `./plugin-sdk` and `./plugin-sdk/<subpath>` exports, while `/Users/kevinlin/code/openclaw/package.json:1560` exposes the governance scripts for API, export, surface, and boundary checks.
- `/Users/kevinlin/code/openclaw/src/plugins/sdk-alias.ts:62` and `/Users/kevinlin/code/openclaw/src/plugins/sdk-alias.ts:752` show how the loader derives exported subpaths from trusted package roots and owner-gated private paths.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/index.ts:1` keeps the root surface intentionally narrow instead of acting as a broad public barrel.
- `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:20` defines required external package field paths, while `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:46` normalizes compatibility metadata.
- `/Users/kevinlin/code/openclaw/src/plugins/install.ts:145` validates package plugin API compatibility, `/Users/kevinlin/code/openclaw/src/plugins/install.ts:170` validates `openclaw.install.minHostVersion`, and `/Users/kevinlin/code/openclaw/src/plugins/install.ts:1560` rejects packages missing a valid `openclaw.plugin.json`.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-package-manifest.mjs:408` augments packaged plugin `package.json` with runtime metadata, and `/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-package-manifest.mjs:564` augments packaged manifests with generated channel config metadata.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:563` creates the packed TypeScript consumer project for representative public SDK imports.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1045` validates built `dist/plugin-sdk` exports and `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1120` runs the critical installed-package import smoke.
- `/Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts:2778` adds a Windows installed-package runtime probe for `openclaw/plugin-sdk/plugin-runtime`.
- `/Users/kevinlin/code/openclaw/src/plugins/install.npm-spec.e2e.test.ts:305` installs the newest compatible stable package when registry `latest` requires a newer plugin API.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts:177` overlays generated channel config metadata into `openclaw.plugin.json` during packaging, and `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts:523` refuses to pack publishable plugins before package-local runtime files exist.
- `/Users/kevinlin/code/openclaw/test/release-check.test.ts:635` requires bundled manifests, bundled package metadata, generated catalogs, and Plugin SDK artifacts in the packed package.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-subpaths.test.ts:17` imports public SDK subpaths from the package surface and `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-subpaths.test.ts:844` checks that deprecated shims stay isolated behind compatibility seams.
- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts:24` anchors docs and contract reference files, and `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts:849` ensures referenced public subpaths exist in both the entrypoint inventory and `package.json` exports.
- `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.test.ts:10` verifies compatibility normalization, and `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.test.ts:53` verifies stable required field-path diagnostics.
- `/Users/kevinlin/code/openclaw/src/plugins/install.test.ts:744` rejects native plugin zip archives without `openclaw.plugin.json`, while `/Users/kevinlin/code/openclaw/src/plugins/install.test.ts:3621` and `/Users/kevinlin/code/openclaw/src/plugins/install.test.ts:3644` reject incompatible or malformed package compatibility metadata.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - would verify that generated public SDK exports still match the checked-in entrypoint inventory; attempted from `/Users/kevinlin/code/openclaw`, but dependency installation failed first with 403 registry auth errors for `@microsoft/teams.cards` and `@microsoft/teams.api` plus `No authorization header was set for the request`.
- `pnpm plugin-sdk:api:check`: `blocked` - would detect public API drift in the packaged SDK surface; blocked by the same local dependency/auth failure before real validation ran.
- `pnpm plugin-sdk:surface:check`: `blocked` - would enforce public surface-size and deprecated-export budgets for this category; blocked by the same local dependency/auth failure before real validation ran.
- `pnpm plugins:boundary-report:ci`: `blocked` - would fail on cross-owner reserved imports, unused reserved subpaths, and due compatibility debt for this category; blocked by the same local dependency/auth failure before real validation ran.
- `pnpm release:plugins:npm:check`: `blocked` - would validate publishable plugin npm metadata and release readiness around this category; blocked by the same local dependency/auth failure before real validation ran.
- `pnpm release:plugins:clawhub:check`: `blocked` - would validate publishable plugin ClawHub metadata and release readiness around this category; blocked by the same local dependency/auth failure before real validation ran.

### Gitcrawl queries

Query:

- `gitcrawl threads openclaw/openclaw --numbers 80219 --include-closed --json`

Results:

- Open issue `#80219` is a whole-surface architecture audit that explicitly calls out publication-by-list drift, export sprawl, and the absence of one authoritative public support model for the SDK category.

Query:

- `gitcrawl threads openclaw/openclaw --numbers 86087,81213 --include-closed --json`

Results:

- Open issue `#86087` documents a user-visible Windows beta regression where `@openclaw/codex` still imports `openclaw/plugin-sdk/codex-native-task-runtime` and hits `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Open issue `#81213` shows the same compatibility seam remains confusing even when the loader path improves: real execution no longer crashes immediately, but plain package-export probing still does not expose the subpath.

Query:

- `gitcrawl threads openclaw/openclaw --numbers 86130,87119 --include-closed --json`

Results:

- Open PR `#86130` proposes restoring the Codex task-runtime subpath as a compatibility-only export for stale installs.
- Open PR `#87119` proposes fixing scoped subpath alias resolution so stale export maps do not fall through to `root-alias.cjs/<subpath>`.

Query:

- `gitcrawl search openclaw/openclaw --query "openclaw.compat.pluginApi openclaw.install.minHostVersion" --json`

Results:

- Returned open PR `#87477`, `fix(plugins): reject incompatible package plugin API installs`.
- The snippet ties the current work directly to `openclaw.compat.pluginApi` as the install compatibility contract and to `openclaw.install.minHostVersion` as a separate host-floor check.

Query:

- `gitcrawl search openclaw/openclaw --query "silent failures legacy invalid plugin contracts" --json`

Results:

- Returned open issue `#78301`, `Plugin loader: silent failures on legacy/invalid plugin contracts cost hours of debugging`.

Query:

- `gitcrawl search openclaw/openclaw --query "post-upgrade plugin compat manifest drift" --json`

Results:

- Returned open PR `#79260`, `feat(doctor): add --post-upgrade --json mode for plugin-compat findings`.

Query:

- `gitcrawl search openclaw/openclaw --query "plugin sdk export sprawl lifecycle semantics" --json`

Results:

- Returned open issue `#80219`, `[plugin sdk] Consolidate author surface, lifecycle semantics, and export sprawl`.

### Discrawl queries

Query:

- `discrawl --json search "plugin sdk subpath" --limit 10`

Results:

- The query returned maintainer-channel and mirrored GitHub archive hits showing recurring category pressure: PR `#80967` was called out for deprecated public helper usage, PR `#77205` for a test-only loader hook leaking into the public SDK, and issue `#68279` for missing helpers on the bare root SDK import expected by external plugins.

Query:

- `discrawl --json search "ClawHub publish openclaw.compat.pluginApi" --limit 5`

Results:

- Returned project-linked Discord archive messages about issue `#56903`, ClawHub issue `#1796`, and ClawHub PR `#1802`.
- The archive record shows a real docs gap around required package metadata, then a later closure message saying current `main` now makes the external code plugin contract explicit. I treated that as positive evidence that the docs/source mismatch was repaired.

Query:

- `discrawl --json search "contracts.tools openclaw.plugin.json" --limit 5`

Results:

- Returned operator discussion showing an installed plugin still registering tools without declaring `contracts.tools`, producing the runtime warning `plugin must declare contracts.tools before registering agent tools`.
- I treated that as real evidence of lingering contract-migration/operator confusion, not as a coverage signal.
