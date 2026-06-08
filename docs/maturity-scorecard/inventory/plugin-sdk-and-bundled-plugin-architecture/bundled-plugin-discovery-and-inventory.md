---
title: Plugins - Bundled Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Bundled Plugins Maturity Note

## Summary

This category remains `Stable` on both Coverage and Quality. OpenClaw has a
clear discovery model for packaged bundled plugins, bind-mounted source
overlays, workspace/source-checkout-only entries, and generated plugin
inventory/reference docs. The strongest coverage evidence is still the Docker
bundled-plugin install/uninstall sweep plus targeted Gateway and CLI integration
tests that exercise real bundled loading paths.

The main reasons this category stays below `Lovable` are unchanged: the docs
inventory path is generator- and drift-check-backed rather than publish-path
E2E-backed, and the official external rows in the inventory are well modeled
but not all proven through recurring live install/runtime flows inside this
category.

## Category Scope

- This category covers runtime discovery of bundled plugins, inventorying
  `extensions/*` into core/external/source-only buckets, copying bundled plugin
  metadata into built artifacts, and exposing bundled plugin identity and
  manifest metadata to downstream runtime callers.
- This category also covers bundled source overlays, packaged bundled roots,
  source-checkout-only entries that remain visible in local dev, and generated
  plugin inventory/reference docs that describe what ships in core versus what
  installs separately.
- Out of scope: the feature maturity of any individual bundled plugin, ClawHub
  or npm distribution behavior after a user chooses a plugin, and the broader
  public Plugin SDK API surface.

## Features

- Bundled plugin listing: Operators and maintainers can inspect the bundled plugin set and its published metadata.
- Bundled source overlays: Source overlays work for local development and repo-driven testing.
- Packaged bundled plugins: Built distributions discover bundled plugins from packaged roots.
- Generated plugin inventory: Generated plugin inventory and reference docs describe what ships in core versus what installs separately.
- Bundled channel IDs: Bundled channel ids are discovered and normalized from plugin metadata.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `last_sync_at`
  `2026-05-28T19:09:52.784704Z`, `thread_count` `29810`,
  `open_thread_count` `11181`, `db_path`
  `/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: `discrawl status --json` succeeded with `generated_at`
  `2026-05-30T00:38:20Z`, `state` `current`, summary
  `1487536 messages across 25831 channels`, and `last_sync_at`
  `2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals:
  - The Docker bundled-plugin sweep selects installable packaged bundled
    plugins from `openclaw plugins list --json`, installs them by bundled ID,
    asserts the persisted install/config state, optionally runs runtime smoke,
    then uninstalls and verifies cleanup
    (`/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:54`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:98`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:164`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:21`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:40`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:56`).
  - Runtime smoke proves the installed bundled plugin can survive real Gateway
    startup and answer baseline runtime probes such as `/healthz`, `/readyz`,
    `health`, `channels.status`, and `commands.list`
    (`/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:376`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:423`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:612`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:672`,
    `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:678`).
  - Gateway startup and CLI loading both have bundled-browser integration tests
    that exercise `OPENCLAW_BUNDLED_PLUGINS_DIR` with a real fixture and verify
    bundled registration at runtime
    (`/Users/kevinlin/code/openclaw/src/gateway/server-plugin-bootstrap.browser-plugin.integration.test.ts:22`,
    `/Users/kevinlin/code/openclaw/src/gateway/server-plugin-bootstrap.browser-plugin.integration.test.ts:38`,
    `/Users/kevinlin/code/openclaw/src/plugins/cli.browser-plugin.integration.test.ts:13`,
    `/Users/kevinlin/code/openclaw/src/plugins/cli.browser-plugin.integration.test.ts:29`,
    `/Users/kevinlin/code/openclaw/src/plugins/cli.browser-plugin.integration.test.ts:48`).
  - Inventory generation has a recurring release/drift-check path through
    `plugins:inventory:check`, `plugins:inventory:gen`, and
    `release-preflight`
    (`/Users/kevinlin/code/openclaw/package.json:1573`,
    `/Users/kevinlin/code/openclaw/package.json:1574`,
    `/Users/kevinlin/code/openclaw/scripts/release-preflight.mjs:22`,
    `/Users/kevinlin/code/openclaw/scripts/release-preflight.mjs:25`,
    `/Users/kevinlin/code/openclaw/scripts/release-preflight.mjs:42`).
- Negative signals:
  - The generated inventory and reference docs are guarded by generator and
    stale-file checks, but I did not find a docs-publish or docs-navigation E2E
    that proves those generated pages are reachable after release.
  - The official external package rows are present in the inventory and channel
    catalog evidence, but the strongest runtime-flow proof in this category
    still comes from packaged bundled-plugin lifecycle tests rather than
    recurring external install/runtime scenarios for every official external
    inventory row.
  - The taxonomy-owned surface validation commands were all blocked locally by a
    dependency-install auth failure before real validation, so they do not add
    new coverage evidence for this rescore.
- Integration gaps:
  - Add a release-path E2E that checks generated inventory/reference pages in a
    built docs artifact rather than only file-generation drift.
  - Add a recurring scenario that selects an official external inventory row,
    installs it via the advertised source, and verifies the runtime/inventory
    metadata line up with the claimed distribution bucket.
  - Persist a machine-readable artifact from the bundled-plugin sweep so release
    reviewers can see which bundled IDs were selected, skipped for required
    config, runtime-smoked, and cleaned up.

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
  - Query `bundled plugin discovery inventory` returned 4 keyword hits: open PR
    #84997 adding NEAR AI Cloud inventory entries, open issue #72991 about
    adjacent hook discovery tiers, open PR #83292 adding a bundled provider
    plugin, and open PR #87141 hardening plugin schema and metadata fuzz
    boundaries.
  - Query `plugin inventory bundled ids` returned 1 keyword hit: open PR
    #87141, which is direct evidence that metadata and inventory boundary
    hardening is still active work on this category.
- Discrawl reports:
  - Query `discrawl --json search "bundled plugin inventory" --limit 5` was
    blocked locally with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
  - I treated that as a local query blocker, not product evidence. Quality was
    scored from current source/docs alignment plus gitcrawl evidence, while the
    provided `discrawl status --json` freshness snapshot confirms the archive is
    current.
- Good qualities:
  - The discovery implementation carries explicit bundled metadata on each
    candidate, including origin, package metadata, manifest identity, manifest
    path, and required bundled-plugin dependencies instead of relying on loose
    path inference
    (`/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:66`,
    `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:82`).
  - Discovery safety gates reject or repair dangerous filesystem states, and
    bundled overlays are surfaced as diagnostics instead of silent shadowing
    (`/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:149`,
    `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:176`,
    `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:197`,
    `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:1504`,
    `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:1520`).
  - Bundled metadata generation rewrites source entries to built paths, carries
    setup/runtime/public-surface artifacts, and keeps resolution inside bundled
    plugin roots
    (`/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.ts:95`,
    `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.ts:112`,
    `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.ts:120`,
    `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.ts:136`).
  - Build scripts copy bundled manifests and package metadata into dist, merge
    generated channel configs, and relocate/copy declared skill assets so the
    shipped metadata matches the runtime layout
    (`/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:125`,
    `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:179`,
    `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:246`,
    `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:290`,
    `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:326`).
  - Inventory generation is deterministic from checked-in manifests and root
    package exclusions, and it fails hard on missing, extra, or duplicate
    plugin IDs before updating the generated docs
    (`/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:445`,
    `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:452`,
    `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:469`,
    `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:515`,
    `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:603`).
  - User-facing docs clearly distinguish bundled/core, official external, and
    source-checkout-only inventory states, and channel docs consistently tell
    operators when a channel ships as a bundled plugin
    (`/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:12`,
    `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:21`,
    `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:35`,
    `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:145`,
    `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:178`,
    `/Users/kevinlin/code/openclaw/docs/channels/index.md:31`,
    `/Users/kevinlin/code/openclaw/docs/channels/msteams.md:10`,
    `/Users/kevinlin/code/openclaw/docs/channels/nostr.md:13`).
- Bad qualities:
  - This category still depends on several synchronized truth surfaces:
    `extensions/*`, generated inventory/reference docs, dist metadata copies,
    runtime metadata snapshots, and persisted install records all need to stay
    aligned.
  - Open PR #87141 shows that schema and metadata fuzz boundaries are still
    actively being tightened, which is a real quality drag even though the
    direction is corrective.
  - The category documents official external inventory rows well, but it still
    relies on adjacent distribution/release surfaces for full end-to-end trust
    in those rows.
- Excluded from quality:
  - Unit, integration, Docker E2E, and runtime-smoke breadth were not used to
    raise or lower Quality.
  - The blocked local validation commands were treated as an environment
    prerequisite failure, not a product-quality signal.

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

- No publish-path docs validation was found that proves the generated inventory
  page and generated plugin reference pages are reachable in released docs.
- Official external inventory rows are represented in docs and catalog tests,
  but this category still lacks recurring live install/runtime proof across that
  whole bucket.
- The surface validation commands for this rescore were blocked locally by
  registry auth failures before they could validate anything category-specific.
- Discrawl search for this category was blocked locally by a sync-lock
  permission issue, so there is no fresh Discord query result beyond the
  provided archive freshness snapshot.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:12` through
  `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:47` define the
  generated inventory source-of-truth and install semantics for bundled versus
  external plugins.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:145` through
  `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:176` show the
  official external package bucket, including bundled-channel plugins like
  `msteams`, `nextcloud-talk`, `nostr`, `qqbot`, `twitch`, `zalo`, and
  `zalouser`.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:178` through
  `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md:184` show the
  source-checkout-only bucket.
- `/Users/kevinlin/code/openclaw/docs/plugins/reference.md:11` through
  `/Users/kevinlin/code/openclaw/docs/plugins/reference.md:20` show the
  generated reference index contract.
- `/Users/kevinlin/code/openclaw/docs/channels/index.md:31` through
  `/Users/kevinlin/code/openclaw/docs/channels/index.md:54` present bundled
  plugin status directly in the channel catalog.
- `/Users/kevinlin/code/openclaw/docs/channels/msteams.md:10` through
  `/Users/kevinlin/code/openclaw/docs/channels/msteams.md:20`,
  `/Users/kevinlin/code/openclaw/docs/channels/nostr.md:13` through
  `/Users/kevinlin/code/openclaw/docs/channels/nostr.md:22`, and
  `/Users/kevinlin/code/openclaw/docs/channels/nextcloud-talk.md:10` through
  `/Users/kevinlin/code/openclaw/docs/channels/nextcloud-talk.md:22` show the
  bundled-plugin install guidance pattern in current channel docs.

### Source

- `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:66` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:88` define the
  metadata carried on discovered plugin candidates.
- `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:149` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:223` enforce
  path-safety and permission checks for discovery candidates.
- `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:1500` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.ts:1545` load bundled
  source overlays, emit explicit diagnostics, and then scan packaged bundled
  roots.
- `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.ts:95`
  through `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.ts:168`
  derive bundled metadata entries from manifests, built entry rewrites,
  generated public-surface artifacts, and channel configs.
- `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:125`
  through `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:143`
  and `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:179`
  through `/Users/kevinlin/code/openclaw/scripts/copy-bundled-plugin-metadata.mjs:326`
  copy bundled manifests/package metadata into dist and rewrite copied skill
  paths.
- `/Users/kevinlin/code/openclaw/scripts/bundled-plugin-assets.mjs:39` through
  `/Users/kevinlin/code/openclaw/scripts/bundled-plugin-assets.mjs:130` resolve
  manifest/package aliases and run plugin-owned asset hooks.
- `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:430`
  through `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:490`
  collect source entries and reject missing/extra/duplicate IDs, while
  `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:515`
  through `/Users/kevinlin/code/openclaw/scripts/generate-plugin-inventory-doc.mjs:616`
  render and drift-check the generated inventory/reference docs.
- `/Users/kevinlin/code/openclaw/package.json:1571` through
  `/Users/kevinlin/code/openclaw/package.json:1574`,
  `/Users/kevinlin/code/openclaw/package.json:1611` through
  `/Users/kevinlin/code/openclaw/package.json:1619`, and
  `/Users/kevinlin/code/openclaw/package.json:1642` wire the category’s asset,
  inventory, release-preflight, and Docker lifecycle commands.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-plugin-bootstrap.browser-plugin.integration.test.ts:22`
  through `/Users/kevinlin/code/openclaw/src/gateway/server-plugin-bootstrap.browser-plugin.integration.test.ts:59`
  load a bundled browser fixture into Gateway startup and verify method/service
  registration.
- `/Users/kevinlin/code/openclaw/src/plugins/cli.browser-plugin.integration.test.ts:13`
  through `/Users/kevinlin/code/openclaw/src/plugins/cli.browser-plugin.integration.test.ts:70`
  verify CLI registration and disabled-plugin omission for a bundled fixture.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:54`
  through `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:118`
  select packaged bundled plugins from `plugins list --json`.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:164`
  through `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs:239`
  assert installed and uninstalled state for bundled-plugin records, config, and
  managed directories.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:376`
  through `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:446`
  start the Gateway and wait for readiness, while
  `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:612`
  through `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:705`
  probe runtime channel and command visibility.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:21`
  through `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:67`
  run the bundled install/runtime/uninstall sweep.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:741` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:805` cover
  packaged-bundled and legacy load-path shadowing behavior.
- `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:808` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:898` cover
  bundled source overlays versus packaged dist bundles.
- `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:1175` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:1225` verify a
  valid bundled plugin beats a source-only managed package.
- `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:1713` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:1768` verify
  source-checkout-only bundled plugins remain discoverable alongside built ones.
- `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:2277` through
  `/Users/kevinlin/code/openclaw/src/plugins/discovery.test.ts:2301` verify
  world-writable bundled directories are repaired before loading.
- `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.test.ts:326`
  through `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.test.ts:345`
  verify repo metadata matches the runtime snapshot, while
  `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.test.ts:526`
  through `/Users/kevinlin/code/openclaw/src/plugins/bundled-plugin-metadata.test.ts:550`
  require config schemas and explicit startup activation on bundled manifests.
- `/Users/kevinlin/code/openclaw/test/official-channel-catalog.test.ts:71`
  through `/Users/kevinlin/code/openclaw/test/official-channel-catalog.test.ts:205`
  verify publishable official channel plugins and external entries, and
  `/Users/kevinlin/code/openclaw/test/official-channel-catalog.test.ts:277`
  through `/Users/kevinlin/code/openclaw/test/official-channel-catalog.test.ts:341`
  verify the generated catalog under dist stays unique and includes expected
  install metadata.
- `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-assets.test.ts:40`
  through `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-assets.test.ts:76`
  verify asset-hook discovery and argument parsing by manifest/package aliases.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - attempted from
  `/Users/kevinlin/code/openclaw`, but local dependency installation failed with
  403 registry auth errors for `@microsoft/teams.cards` / `@microsoft/teams.api`
  and `No authorization header was set for the request`; for this category it
  would validate that generated SDK exports still align with the checked-in
  entrypoint inventory used by bundled/runtime surfaces.
- `pnpm plugin-sdk:api:check`: `blocked` - same local dependency/auth blocker;
  for this category it would validate that packaged SDK API drift has not broken
  discovery/inventory-adjacent exported helpers.
- `pnpm plugin-sdk:surface:check`: `blocked` - same local dependency/auth
  blocker; for this category it would validate surface-budget drift on public
  helpers that bundled discovery and inventory code depend on.
- `pnpm plugins:boundary-report:ci`: `blocked` - same local dependency/auth
  blocker; for this category it would validate reserved import boundaries and
  cross-owner compatibility debt affecting bundled plugin packaging/layout.
- `pnpm release:plugins:npm:check`: `blocked` - same local dependency/auth
  blocker; for this category it would validate npm release metadata for official
  external inventory rows.
- `pnpm release:plugins:clawhub:check`: `blocked` - same local dependency/auth
  blocker; for this category it would validate ClawHub release metadata for
  official external inventory rows.

### Gitcrawl queries

Query:

```bash
gitcrawl search openclaw/openclaw --query "bundled plugin discovery inventory" --json
```

Results:

- 4 hits, mode `keyword`.
- Open PR #84997, `[AI-assisted] Add NEAR AI Cloud provider`, mentions generated
  plugin inventory entries.
- Open issue #72991, `[Feature]: Expose machine-wide hook policies`, discusses
  adjacent bundled/plugin discovery tiers.
- Open PR #83292, `feat(gigachat): add provider integration`, adds a bundled
  provider plugin.
- Open PR #87141, `fix(plugin): harden schema and metadata fuzz boundaries`, is
  current hardening work directly touching plugin metadata/inventory safety.

Query:

```bash
gitcrawl search openclaw/openclaw --query "plugin inventory bundled ids" --json
```

Results:

- 1 hit, mode `keyword`.
- Open PR #87141, `fix(plugin): harden schema and metadata fuzz boundaries`.

### Discrawl queries

Query:

```bash
discrawl --json search "bundled plugin inventory" --limit 5
```

Results:

- Blocked locally with `open sync lock: open /Users/kevinlin/Library/Application Support/discrawl/.discrawl-sync.lock: operation not permitted`.
- Treated as a local query blocker, not as positive or negative product
  evidence.
- Archive freshness for Discord evidence still comes from the provided
  successful `discrawl status --json` snapshot recorded above.
