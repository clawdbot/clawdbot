---
title: "ClawHub - Plugin Lifecycle and Health Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Plugin Lifecycle and Health Maturity Note

## Summary

Plugin source selection, install/update/uninstall flows, and post-install
dependency repair form one operator lifecycle in practice. Users can install
from ClawHub, npm, npm-pack archives, git, local paths, archives, and
marketplace shorthand, while the runtime keeps managed per-plugin npm roots,
peer repair, doctor cleanup, and post-restart verification separate from
Gateway load. Coverage is Beta because both lifecycle and repair behavior are
documented and tested. Quality stays Beta because bare-spec resolution, catalog
fallbacks, dependency repair, and stale install state still create operator
confusion and recent regressions.

## Category Scope

Included in this category:

- Source prefixes: Source prefixes and shorthand resolution for clawhub:, npm:,
- Bare package behavior during the launch: Bare package behavior during the launch cutover
- Explicit pinned versions: Explicit pinned versions, prerelease tags, and stable fallback behavior
- Managed install records that preserve source: Managed install records that preserve source metadata for update/uninstall
- Codex: Codex, Claude, and Cursor-compatible bundle detection
- Local: Local, archive, and marketplace install paths
- Marketplace list: Marketplace list, shortcut, and install flows
- Supported mapped features: Supported mapped features and detected-but-not-executed capabilities
- Remote marketplace path safety: Remote marketplace path safety and archive download guards
- Update by plugin id: Update by plugin id, npm spec, ClawHub spec, beta channel, and marketplace
- Reinstall vs update semantics: Evidence scope for Reinstall vs update semantics.
- Downgrade: Downgrade and pinned selectors
- Uninstall config/index/policy/file cleanup: Evidence scope for Uninstall config/index/policy/file cleanup.
- Gateway restart/reload requirements after: Gateway restart/reload requirements after install/update/uninstall
- Per-plugin managed npm project: Per-plugin managed npm project roots
- npm-pack local release-candidate installs: npm-pack local release-candidate installs through npm semantics
- Dependency ownership between plugin packages: Dependency ownership between plugin packages and OpenClaw
- Peer dependency relinking: Peer dependency relinking for openclaw/plugin-sdk/\*
- Legacy dependency root cleanup: Legacy dependency root cleanup and doctor repair
- plugins list: plugins list, plugins inspect, runtime inspect, plugins doctor, and
- Local plugin index: Local plugin index and persisted cold registry state
- Troubleshooting stale config: Troubleshooting stale config, blocked paths, dependencies, missing plugins,
- Runtime verification after Gateway: Runtime verification after Gateway restart

## Features

- Source prefixes: Source prefixes and shorthand resolution for clawhub:, npm:,
- Bare package behavior during the launch: Bare package behavior during the launch cutover
- Explicit pinned versions: Explicit pinned versions, prerelease tags, and stable fallback behavior
- Managed install records that preserve source: Managed install records that preserve source metadata for update/uninstall
- Codex: Codex, Claude, and Cursor-compatible bundle detection
- Local: Local, archive, and marketplace install paths
- Marketplace list: Marketplace list, shortcut, and install flows
- Supported mapped features: Supported mapped features and detected-but-not-executed capabilities
- Remote marketplace path safety: Remote marketplace path safety and archive download guards
- Update by plugin id: Update by plugin id, npm spec, ClawHub spec, beta channel, and marketplace
- Reinstall vs update semantics: Evidence scope for Reinstall vs update semantics.
- Downgrade: Downgrade and pinned selectors
- Uninstall config/index/policy/file cleanup: Evidence scope for Uninstall config/index/policy/file cleanup.
- Gateway restart/reload requirements after: Gateway restart/reload requirements after install/update/uninstall
- Per-plugin managed npm project: Per-plugin managed npm project roots
- npm-pack local release-candidate installs: npm-pack local release-candidate installs through npm semantics
- Dependency ownership between plugin packages: Dependency ownership between plugin packages and OpenClaw
- Peer dependency relinking: Peer dependency relinking for openclaw/plugin-sdk/\*
- Legacy dependency root cleanup: Legacy dependency root cleanup and doctor repair
- plugins list: plugins list, plugins inspect, runtime inspect, plugins doctor, and
- Local plugin index: Local plugin index and persisted cold registry state
- Troubleshooting stale config: Troubleshooting stale config, blocked paths, dependencies, missing plugins,
- Runtime verification after Gateway: Runtime verification after Gateway restart
- ClawHub skill installs: Install and update ClawHub-tracked workspace or global skills.
- Skill upload install path: Trusted private archive upload and install through skills upload APIs.
- Skill dependency installers: Declared Brew, Node, Go, uv, or download installers for skill packages.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs and CLI cover major source forms, source-specific
  install paths are implemented, managed npm roots and peer repair are explicit,
  and lifecycle tests exercise npm install, update, downgrade, uninstall, and
  dependency-state assertions.
- Negative signals: the audit did not find one settled live release lane that
  covers ClawHub plus npm plus git plus doctor repair after recent managed-root
  churn.
- Integration gaps: bare-spec behavior, official-catalog fallback, dependency
  repair, and corrupt-tree recovery need a user-facing smoke matrix for common
  install and repair paths.

## Quality Score

- Score: `Beta (71%)`
- Good qualities: source selection is explicit when prefixed, local and linked
  installs are separated, npm registry specs are constrained, install records
  preserve source metadata, managed roots keep cleanup bounded, and stale peer
  links are repaired explicitly.
- Bad qualities: bare spec behavior changes by official catalog state and
  bundled plugin ownership, while archive evidence still shows dependency-root
  churn, stale repair paths, and install-time scanner regressions.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Source prefixes, Bare package behavior during the launch, Explicit pinned versions, Managed install records that preserve source, Codex, Local, Marketplace list, Supported mapped features, Remote marketplace path safety, Update by plugin id, Reinstall vs update semantics, Downgrade, Uninstall config/index/policy/file cleanup, Gateway restart/reload requirements after, Per-plugin managed npm project, npm-pack local release-candidate installs, Dependency ownership between plugin packages, Peer dependency relinking, Legacy dependency root cleanup, plugins list, Local plugin index, Troubleshooting stale config, Runtime verification after Gateway, ClawHub skill installs, Skill upload install path, Skill dependency installers.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a small release checklist table for `clawhub:`, `npm:`, bare official id,
  raw `@openclaw/*`, git, archive, npm-pack, local link, marketplace, and
  doctor-repair recovery.
- Improve user-facing diagnostic language when a plugin dependency tree is
  corrupt but the fix is update vs reinstall vs doctor.
- Consider making source-resolution output more explicit before download/install
  for every non-prefixed package.

## Evidence

### Docs

- `docs/tools/plugin.md:50`: quick start includes ClawHub, npm, git, and local installs.
- `docs/tools/plugin.md:120`: source table explains ClawHub, npm, git, local path, and marketplace.
- `docs/tools/plugin.md:128`: bare package specs prefer bundled/official catalog behavior before npm fallback.
- `docs/cli/plugins.md:102`: command reference lists search and install forms for all supported source types.
- `docs/cli/plugins.md:207`: ClawHub installs use explicit `clawhub:<package>` locators.
- `docs/plugins/dependency-resolution.md:11`: dependency work is kept at install/update time, not runtime.
- `docs/plugins/dependency-resolution.md:35`: npm packages install into per-plugin projects.
- `docs/plugins/dependency-resolution.md:49`: npm-pack uses the same per-plugin project root and verifies lockfile metadata.
- `docs/plugins/dependency-resolution.md:90`: host `openclaw` peer links are reasserted after install/update.
- `docs/plugins/dependency-resolution.md:132`: doctor can clean legacy dependency state and recover missing downloadable plugins.

### Source

- `src/cli/plugins-cli.ts:130`: install command accepts path, archive, npm, git, ClawHub, or marketplace entries.
- `src/infra/clawhub-spec.ts:3`: parses `clawhub:<name>[@version]` specs.
- `src/plugins/install.ts:2012`: validates npm registry specs, resolves metadata, handles compatibility fallback, and delegates to the managed npm root installer.
- `src/plugins/install.ts:770`: installs into a managed npm project root.
- `src/plugins/install.ts:823`: logs the managed npm install target and repairs stale host peer dependencies.
- `src/plugins/install.ts:839`: rolls back failed managed npm installs.
- `src/plugins/install.ts:1855`: archive install requires a plugin manifest before writing install records.
- `src/plugins/install.ts:1899`: local directory install path.
- `src/plugins/install-security-scan.ts:82`: scans installed dependency trees.
- `src/plugins/uninstall.ts:538`: plans uninstall cleanup for npm-managed installs and safe directory removal.

### Integration tests

- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:41`: installs a fixture plugin from npm.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:53`: updates the npm-installed plugin to a later version.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:57`: downgrades the plugin through the update path.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:43`: asserts the installed plugin has an npm project root.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:55`: asserts the npm project root after upgrade.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:59`: asserts the npm project root after downgrade.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:79`: installs a marketplace plugin from a package-installed OpenClaw CLI.

### Unit tests

- `src/plugins/clawhub.test.ts:312`: installs a ClawHub code plugin through the archive installer.
- `src/plugins/marketplace.test.ts:403`: resolves Claude-style `plugin@marketplace` shortcuts.
- `src/plugins/update.test.ts:788`: repairs missing `openclaw` peer links before skipping unchanged npm plugins.
- `src/plugins/update.test.ts:2148`: updates ClawHub-installed plugins via recorded package metadata.
- `src/plugins/uninstall.test.ts:967`: uninstalls npm-managed packages through npm before deleting package directories.
- `src/plugins/uninstall.test.ts:1028`: uninstalls per-plugin npm project packages through their project root.
- `src/plugins/uninstall.test.ts:1093`: repairs remaining npm plugin peer links after npm uninstall prunes them.
- `src/commands/doctor/shared/plugin-dependency-cleanup.test.ts:32`: removes legacy plugin dependency state roots.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "plugins install clawhub npm git local archive marketplace npm-pack source resolver" --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "plugin management install update uninstall ClawHub npm" --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "plugin dependency cleanup managed npm root" --limit 5 --json`

Results:

- The first query returned no hits.
- The second query returned #75186, noting plugin management RPCs and explicitly calling out that live npm/ClawHub install, update, and uninstall still needed verification.
- The dependency-cleanup query returned #87647, `fix: isolate npm plugin installs per package`, explaining why shared managed roots were removed after one plugin evicted another's dependencies.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "plugins install ClawHub npm git local marketplace"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "plugin dependency install managed npm root"`

Results:

- The install-source query returned no hits, so the Discord archive did not add source-resolution proof beyond code/docs/tests.
- The dependency query returned 2026-05-13 maintainer notes that plugin install tests could not run locally, the install-time dependency scanner had fresh blast radius, managed npm peer links needed repair, and beta 5 should be treated as stale/broken for plugin install until a newer beta.
