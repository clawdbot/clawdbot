---
title: Plugins - Publishing Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Publishing Plugins Maturity Note

## Summary

OpenClaw has a real distribution, release, and compatibility category for
bundled and external plugins. The docs distinguish bundled, official external,
and source-checkout-only plugins; explain deterministic source selection across
ClawHub, npm, git, local paths, archives, and marketplaces; and document
compatibility fallback behavior for incompatible npm releases. Source code backs
that with shared external package metadata contracts, explicit npm and ClawHub
release planners/checks, package and ClawHub install compatibility gates, and
release-pack validation that exercises packed installs, bundled activation, and
public Plugin SDK consumption.

The category is not Lovable because the strongest runtime-flow evidence is still
local Docker and packed-release smoke rather than a current staging or
production publish/install/update/rollback loop for npm and ClawHub. Archive
evidence also shows ongoing ecosystem pressure around owner/registry metadata
alignment and broader external-plugin compatibility trapping.

## Category Scope

This category covers distribution, release, and compatibility behavior for the
Plugins surface:

- Bundled versus official external versus source-checkout-only plugin
  distribution.
- ClawHub, npm, git, local path, archive, and marketplace install/update
  semantics for plugins.
- External plugin compatibility metadata, package contracts, and install-time
  host/plugin API gating.
- Release planning and preflight checks for npm and ClawHub plugin publication.
- Packed-release validation that protects plugin SDK exports, bundled plugin
  activation, and packaged runtime/install artifacts.

Out of scope: individual plugin runtime feature quality after installation,
channel/provider behavior, and non-plugin skill distribution.

## Features

- Install sources: Supported plugin install sources are explicit and validated.
- ClawHub publishing: Plugin metadata and workflows support publishing to ClawHub.
- npm publishing: Plugin metadata and workflows support publishing to npm when applicable.
- Compatibility signaling: Compatibility registry data maps plugins to supported runtime versions or channels.
- Update and rollback expectations: Plugin update semantics define what can be upgraded in place and what requires operator intervention.
- Third-party publication rules: External package acceptance rules gate third-party plugin packaging and publication.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with
  `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`,
  `open_thread_count=11181`,
  `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: `discrawl status --json` succeeded with
  `generated_at=2026-05-30T00:38:20Z`, `state=current`,
  `summary=1487536 messages across 25831 channels`, and
  `last_sync_at=2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Beta (79%)`
- Positive signals:
  - The lifecycle matrix Docker scenario installs a fixture npm plugin,
    inspects runtime registration, disables and re-enables it, upgrades,
    downgrades, and force-uninstalls after deleting plugin code
    (`/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:41`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:45`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:53`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:57`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:68`).
  - The release marketplace scenario covers marketplace listing, install,
    plugin-owned CLI execution, dry-run update, update, re-execution, uninstall,
    and post-uninstall absence
    (`/Users/kevinlin/code/openclaw/scripts/e2e/lib/release-plugin-marketplace/scenario.sh:76`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/release-plugin-marketplace/scenario.sh:79`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/release-plugin-marketplace/scenario.sh:91`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/release-plugin-marketplace/scenario.sh:96`).
  - `release-check` verifies packed installed package integrity, bundled
    postinstall, bundled activation smoke, packed Plugin SDK TypeScript
    consumption, critical SDK exports/imports, bundled channel entry smoke, and
    final packed-surface validation
    (`/Users/kevinlin/code/openclaw/scripts/release-check.ts:499`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:609`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:680`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:781`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1084`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1120`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1211`).
  - The repo wires dedicated plugin release and lifecycle validation entrypoints
    into package scripts, so these flows are first-class release checks rather
    than ad hoc local scripts
    (`/Users/kevinlin/code/openclaw/package.json:1609`,
    `/Users/kevinlin/code/openclaw/package.json:1614`,
    `/Users/kevinlin/code/openclaw/package.json:1616`,
    `/Users/kevinlin/code/openclaw/package.json:1697`,
    `/Users/kevinlin/code/openclaw/package.json:1703`).
- Negative signals:
  - The located runtime-flow evidence is still fixture/local: a fake npm
    registry, a local Claude marketplace fixture, and a packed tarball install.
    That is good release coverage, but it is not current proof of live npm
    publish, dist-tag mutation, ClawHub publish, or production registry
    install/update/rollback.
  - None of the located runtime flows directly exercises a real ClawHub install
    followed by update/downgrade/rollback against the remote registry.
  - Gitcrawl PR evidence still includes explicit notes that live npm/ClawHub
    install/update/uninstall and publish flows were not verified in adjacent
    plugin-management and supply-chain work.
  - Taxonomy-owned validation commands were attempted from
    `/Users/kevinlin/code/openclaw` but blocked before real validation by local
    dependency installation failures (`403` auth errors for
    `@microsoft/teams.cards` / `@microsoft/teams.api` and `No authorization
header was set for the request`). That is a local validation blocker, not a
    product-quality signal, but it also means those commands did not add fresh
    runtime proof for this rescore.
- Integration gaps:
  - Add a staging or disposable publish lane that actually publishes candidate
    plugin packages to npm and ClawHub, then installs, updates, downgrades, and
    uninstalls them from those real registries.
  - Add an explicit ClawHub runtime-flow lane that exercises plugin API and
    minimum-host compatibility acceptance/rejection through the remote install
    path, not only source/package-local validation.
  - Publish CI/build identifiers or release artifacts that connect `release:check`
    and plugin release plans to actual publish runs operators can audit.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports:
  - `gitcrawl search openclaw/openclaw --query "plugin compatibility ClawHub npm release" --json`
    returned three relevant open pull requests: `#87477` on rejecting
    incompatible package plugin API installs, `#81957` on supply-chain release
    hardening, and `#75186` on plugin management RPCs. `#81957` and `#75186`
    explicitly note that live npm/ClawHub publish or install lifecycle proof was
    not performed. `#87477` shows this compatibility path has been under active
    hardening pressure very recently.
  - `gitcrawl search openclaw/openclaw --query "plugin lifecycle install update rollback compatibility" --json`
    returned open PR `#73767`, whose snippet references compatibility aliases,
    bundled lifecycle support, and ownership checks. That is more churn than
    failure, but it is still evidence that this compatibility surface is active
    and not yet boring.
- Discrawl reports:
  - `discrawl --json search "ClawHub plugin compatibility" --limit 5` returned
    maintainer discussion from `#maintainers` on 2026-05-27 arguing that the
    current compatibility trap (`crabpot`) should expand beyond API seam checks
    into category-based real-plugin evals. That indicates the current
    compatibility signal is useful but incomplete for ecosystem regression
    catching.
  - The same query returned 2026-05-06 and 2026-05-07 discussion describing
    widespread scoped-plugin owner mismatches on ClawHub and proposing a
    registry-truth migration instead of trusting npm scope alone. That is a real
    distribution correctness and metadata-migration quality concern.
- Good qualities:
  - The docs explain source selection and fallback behavior clearly: ClawHub as
    primary discovery, deterministic explicit source prefixes, bundled-plugin
    precedence, and compatibility fallback to older stable npm versions when the
    latest release requires a newer plugin API or minimum host version
    (`/Users/kevinlin/code/openclaw/docs/tools/plugin.md:42`,
    `/Users/kevinlin/code/openclaw/docs/tools/plugin.md:120`,
    `/Users/kevinlin/code/openclaw/docs/tools/plugin.md:139`,
    `/Users/kevinlin/code/openclaw/docs/cli/plugins.md:125`,
    `/Users/kevinlin/code/openclaw/docs/cli/plugins.md:228`).
  - The inventory and publishing docs make distribution categories and owner
    boundaries explicit, which reduces ambiguity between bundled, official
    external, and source-only plugins and between package scope and publisher
    ownership
    (`/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:21`,
    `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:31`,
    `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:141`,
    `/Users/kevinlin/code/openclaw/docs/clawhub/publishing.md:11`,
    `/Users/kevinlin/code/openclaw/docs/clawhub/publishing.md:42`,
    `/Users/kevinlin/code/openclaw/docs/clawhub/publishing.md:56`).
  - The shared package contract requires `openclaw.compat.pluginApi` and
    `openclaw.build.openclawVersion`, normalizes compatibility metadata, and is
    reused by both npm and ClawHub release tooling
    (`/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:20`,
    `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:46`,
    `/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-release.ts:225`,
    `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:101`).
  - Direct package installs and source/package-dir installs now run shared
    minimum-host and plugin API compatibility validation, while ClawHub installs
    enforce the same compatibility dimensions before download. That narrows an
    older quality gap between direct and ClawHub-managed installs
    (`/Users/kevinlin/code/openclaw/src/plugins/install.ts:145`,
    `/Users/kevinlin/code/openclaw/src/plugins/install.ts:170`,
    `/Users/kevinlin/code/openclaw/src/plugins/install.ts:1422`,
    `/Users/kevinlin/code/openclaw/src/plugins/install.ts:1600`,
    `/Users/kevinlin/code/openclaw/src/plugins/clawhub.ts:963`).
  - Release tooling enforces publishable metadata, package selection, version
    bump gates, ClawHub owner checks, and official fallback behavior during
    updates; `release-check` also protects packed SDK exports, pack contents, and
    bundled activation
    (`/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-release.ts:239`,
    `/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-release.ts:492`,
    `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:282`,
    `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:353`,
    `/Users/kevinlin/code/openclaw/src/plugins/update.ts:1368`,
    `/Users/kevinlin/code/openclaw/src/plugins/update.ts:1641`,
    `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1162`).
- Bad qualities:
  - `docs/plugins/compatibility.md` still frames the external plugin inspector as
    a future separate package rather than a shipped tool, so one of the intended
    compatibility guardrails is still aspirational
    (`/Users/kevinlin/code/openclaw/docs/plugins/compatibility.md:46`).
  - The docs still describe a launch-cutover state where ClawHub is the primary
    discovery surface but ordinary bare package specs frequently resolve through
    npm. That is workable, but it increases operator ambiguity about source of
    truth and provenance
    (`/Users/kevinlin/code/openclaw/docs/tools/plugin.md:42`,
    `/Users/kevinlin/code/openclaw/docs/cli/plugins.md:125`).
  - There is still no single published operator-facing compatibility scorecard
    or support matrix that ties host versions, plugin API ranges, npm packages,
    and ClawHub availability together at the same revision.
  - Archive evidence shows ongoing pressure around registry owner truth and the
    need for broader real-plugin compatibility trapping, which means this
    category still depends on active maintainer vigilance rather than settled
    boring process.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test coverage.
  - Lack of test coverage.

## Known Gaps

- Add real publish/install/update/rollback evidence for npm and ClawHub, not
  only fixture and packed-release proof.
- Ship or clearly replace the planned external plugin inspector workflow so
  compatibility guidance is not partly aspirational.
- Reduce operator ambiguity between ClawHub-primary discovery and npm-default
  bare package installs during the current cutover behavior.
- Publish a canonical compatibility/support matrix for external plugin authors
  and operators that ties host versions, plugin API ranges, and registry
  availability together.
- Resolve the registry owner mismatch migration story so scoped package names do
  not remain a recurring distribution correctness hazard.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/plugin.md:42` documents ClawHub as
  primary discovery while explaining bundled and npm fallback behavior during the
  current cutover.
- `/Users/kevinlin/code/openclaw/docs/tools/plugin.md:120` through `:145`
  defines source-selection rules and older-stable compatibility fallback for npm
  installs.
- `/Users/kevinlin/code/openclaw/docs/cli/plugins.md:104` through `:118`
  enumerates install entrypoints for ClawHub, npm, `npm-pack`, git, local path,
  and marketplace sources.
- `/Users/kevinlin/code/openclaw/docs/cli/plugins.md:125` through `:140`
  describes npm-default bare installs during the cutover and ClawHub as primary
  distribution/discovery.
- `/Users/kevinlin/code/openclaw/docs/cli/plugins.md:228` through `:229`
  documents plugin API/minimum-host checks, ClawPack verification, and recorded
  install metadata for ClawHub installs.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:21` through
  `:23` defines bundled, official external, and source-checkout-only plugin
  categories.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:31` through
  `:47` explains how operators choose install paths from the distribution
  inventory.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:141` through
  `:176` lists official external packages distributed through npm and/or ClawHub.
- `/Users/kevinlin/code/openclaw/docs/plugins/compatibility.md:17` through `:32`
  defines the compatibility registry contract and maintenance expectations.
- `/Users/kevinlin/code/openclaw/docs/plugins/compatibility.md:46` through `:86`
  documents the planned external plugin inspector and acceptance lane.
- `/Users/kevinlin/code/openclaw/docs/plugins/compatibility.md:90` through `:105`
  defines the deprecation policy and migration sequence.
- `/Users/kevinlin/code/openclaw/docs/clawhub/publishing.md:11` through `:18`
  defines owner-scoped publishing.
- `/Users/kevinlin/code/openclaw/docs/clawhub/publishing.md:42` through `:65`
  defines package-scope/owner matching and ClawHub release validation flow.

### Source

- `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:20`
  through `:23` defines required external plugin compatibility fields.
- `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:46`
  through `:74` normalizes plugin API, minimum gateway, and build-version
  compatibility metadata.
- `/Users/kevinlin/code/openclaw/packages/plugin-package-contract/src/index.ts:77`
  through `:99` validates missing required external plugin fields.
- `/Users/kevinlin/code/openclaw/src/plugins/install.ts:145` through `:206`
  implements shared minimum-host and plugin API compatibility checks for package
  installs.
- `/Users/kevinlin/code/openclaw/src/plugins/install.ts:1422` through `:1429`
  applies that validation to bundle/source installs with package metadata.
- `/Users/kevinlin/code/openclaw/src/plugins/install.ts:1600` through `:1607`
  applies that validation to package-dir installs.
- `/Users/kevinlin/code/openclaw/src/plugins/clawhub.ts:963` through `:1015`
  rejects incompatible ClawHub package families, privacy modes, plugin API
  ranges, and minimum gateway versions.
- `/Users/kevinlin/code/openclaw/src/plugins/clawhub.ts:1115` through `:1253`
  verifies ClawPack/archive integrity and records artifact metadata for later
  updates.
- `/Users/kevinlin/code/openclaw/src/plugins/update.ts:1368` through `:1423`
  supports beta-channel and official npm fallback during dry-run updates.
- `/Users/kevinlin/code/openclaw/src/plugins/update.ts:1611` through `:1655`
  supports the same fallback behavior during real updates.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-release.ts:225` through
  `:337` validates publishable npm plugin metadata and collects candidates.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-npm-release.ts:492` through
  `:536` resolves npm release plans and skips already-published versions.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:101`
  through `:179` validates publishable ClawHub plugin metadata.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:282`
  through `:318` enforces version-bump gates for changed publishable plugins.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:353`
  through `:404` checks that `@openclaw/*` packages already belong to the
  OpenClaw owner on ClawHub.
- `/Users/kevinlin/code/openclaw/scripts/lib/plugin-clawhub-release.ts:406`
  through `:455` builds ClawHub release plans and filters already-published
  versions.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:499` through `:560`
  verifies packed installed package contents and binary version.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:609` through `:635`
  runs a packed Plugin SDK TypeScript consumer smoke.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:680` through `:707`
  runs bundled plugin activation smoke on a packed install.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:781` through `:821`
  executes the packed bundled channel entry smoke flow.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1084` through `:1155`
  checks critical public Plugin SDK exports and importability.
- `/Users/kevinlin/code/openclaw/scripts/release-check.ts:1162` through `:1213`
  validates pack contents and final packed-surface invariants.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/plugin-lifecycle-matrix-docker.sh:1`
  defines the Docker lifecycle matrix entrypoint.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:41`
  through `:69` covers npm install, runtime inspect, disable/enable, upgrade,
  downgrade, and missing-code uninstall.
- `/Users/kevinlin/code/openclaw/scripts/e2e/release-plugin-marketplace-docker.sh:1`
  defines the marketplace release scenario entrypoint.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/release-plugin-marketplace/scenario.sh:76`
  through `:103` covers marketplace list/install/update/uninstall behavior and
  CLI verification.
- `/Users/kevinlin/code/openclaw/package.json:1697` wires
  `test:docker:release-plugin-marketplace`.
- `/Users/kevinlin/code/openclaw/package.json:1703` wires
  `test:docker:plugin-lifecycle-matrix`.

### Unit tests

- `/Users/kevinlin/code/openclaw/test/plugin-clawhub-release.test.ts:58`
  through `:65` requires the external plugin compatibility contract for ClawHub
  release candidates.
- `/Users/kevinlin/code/openclaw/test/plugin-clawhub-release.test.ts:120`
  through `:159` keeps dual-published diagnostics plugins selectable through
  both npm and ClawHub release paths.
- `/Users/kevinlin/code/openclaw/test/plugin-clawhub-release.test.ts:164`
  through `:193` enforces version bumps for changed publishable ClawHub plugins.
- `/Users/kevinlin/code/openclaw/test/plugin-clawhub-release.test.ts:373`
  through `:398` enforces ClawHub owner correctness for `@openclaw/*` packages.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-release.test.ts:158` through
  `:233` enforces npm provenance URL, install metadata, and compatibility
  contract requirements.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-release.test.ts:238` through
  `:257` keeps publishable plugin dist trees excluded from the core npm package.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-release.test.ts:372` through
  `:404` maps prerelease versions to the correct npm publish tags.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts:231`
  through `:309` stages runtime metadata correctly while packing publishable
  plugins.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts:311`
  through `:380` bundles and cleans package-local runtime dependencies.
- `/Users/kevinlin/code/openclaw/test/plugin-npm-package-manifest.test.ts:523`
  through `:560` fails closed when advertised runtime files are missing or
  excluded from packs.
- `/Users/kevinlin/code/openclaw/test/release-check.test.ts:287` through `:316`
  validates bundled install metadata and minimum-host version formatting.
- `/Users/kevinlin/code/openclaw/test/release-check.test.ts:701` through `:750`
  verifies post-pack package integrity and root-alias safety checks.
- `/Users/kevinlin/code/openclaw/test/release-check.test.ts:792` through `:826`
  verifies the packed Plugin SDK TypeScript smoke fixture.
- `/Users/kevinlin/code/openclaw/test/release-check.test.ts:859` through `:876`
  enforces critical public Plugin SDK entrypoint size budgets.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - would verify generated public SDK
  export inventory sync; attempted from `/Users/kevinlin/code/openclaw`, but the
  local environment failed before real validation because dependency
  installation hit `403` auth errors for `@microsoft/teams.cards` /
  `@microsoft/teams.api` and `No authorization header was set for the request`.
- `pnpm plugin-sdk:api:check`: `blocked` - would detect packaged public Plugin
  SDK API drift; blocked by the same local dependency-auth failure, so neutral
  for this category score.
- `pnpm plugin-sdk:surface:check`: `blocked` - would enforce SDK surface-size
  budgets and deprecated-export limits; blocked by the same local
  dependency-auth failure, so neutral for this category score.
- `pnpm plugins:boundary-report:ci`: `blocked` - would validate reserved import
  boundaries, unclassified reserved subpaths, and compatibility debt; blocked by
  the same local dependency-auth failure, so neutral for this category score.
- `pnpm release:plugins:npm:check`: `blocked` - would validate publishable npm
  plugin metadata and release readiness from the repo root; blocked by the same
  local dependency-auth failure, so neutral for this category score.
- `pnpm release:plugins:clawhub:check`: `blocked` - would validate publishable
  ClawHub plugin metadata and release readiness; blocked by the same local
  dependency-auth failure, so neutral for this category score.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "plugin compatibility ClawHub npm release" --json`

Results:

- Open PR `#87477` (`fix(plugins): reject incompatible package plugin API installs`) says
  direct package install compatibility was being aligned with ClawHub plugin API
  checks.
- Open PR `#81957` (`ci: harden GitHub Actions supply-chain boundaries`) says no
  live npm publish, dist-tag mutation, ClawHub publish, release publish, or
  production gateway run was performed in that hardening work.
- Open PR `#75186` (`[Feat] Add plugin management RPCs`) says live
  npm/ClawHub install/update/uninstall was not verified.

Query:

`gitcrawl search openclaw/openclaw --query "plugin lifecycle install update rollback compatibility" --json`

Results:

- Open PR `#73767` (`[codex] Finalize RuntimePlan embedded-runner cleanup stack`)
  mentions compatibility aliases, native bundled lifecycle support, and
  ownership-checked plugin surfaces.

Query:

`gitcrawl search openclaw/openclaw --query "reject incompatible package plugin API installs" --json`

Results:

- Open PR `#87477` reinforces that package-install compatibility rejection has
  been active recent hardening work on this surface.

### Discrawl queries

Query:

`discrawl --json search "ClawHub plugin compatibility" --limit 5`

Results:

- A 2026-05-27 `#maintainers` message proposes expanding the `crabpot`
  compatibility trap beyond API seam checks into category-based real-plugin
  evals, implying current external-plugin regression catching is still narrow.
- A 2026-05-06 `#maintainers` message describes roughly `61.8%` scoped-plugin
  owner mismatch and argues for resolving install org from ClawHub registry
  metadata rather than npm scope.
- A 2026-05-07 discussion also calls out ClawHub/plugin ownership mismatch as a
  major migration problem and links it to distribution correctness.
