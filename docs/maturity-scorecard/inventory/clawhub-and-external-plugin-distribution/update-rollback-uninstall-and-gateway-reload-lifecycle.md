---
title: "ClawHub - Update, Rollback, Uninstall, and Gateway Reload Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Update, Rollback, Uninstall, and Gateway Reload Lifecycle Maturity Note

## Summary

The lifecycle command surface is broad: install, enable, disable, inspect,
update, downgrade, uninstall, registry refresh, and Gateway restart/reload
expectations are all documented and implemented. Coverage is Beta because real
fixture e2e coverage exists, including update/downgrade/uninstall, but the audit
did not find live ClawHub and npm release-line proof. Quality is Beta because
the model is understandable but still split between cold registry state and
live Gateway runtime state.

## Category Scope

- Update by plugin id, npm spec, ClawHub spec, beta channel, and marketplace.
- Reinstall vs update semantics.
- Downgrade and pinned selectors.
- Uninstall config/index/policy/file cleanup.
- Gateway restart/reload requirements after install/update/uninstall.

## Features

- Update by plugin id: Update by plugin id, npm spec, ClawHub spec, beta channel, and marketplace
- Reinstall vs update semantics: Evidence scope for Reinstall vs update semantics.
- Downgrade: Downgrade and pinned selectors
- Uninstall config/index/policy/file cleanup: Evidence scope for Uninstall config/index/policy/file cleanup.
- Gateway restart/reload requirements after: Gateway restart/reload requirements after install/update/uninstall

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs and e2e cover update, downgrade, uninstall, inspect,
  enable/disable, and marketplace update/uninstall.
- Negative signals: no live ClawHub update, npm dist-tag update, or rollback
  across a real external package registry was found in the audit.
- Integration gaps: rollback is mostly modeled as reinstall/downgrade and
  uninstall cleanup, not as a first-class operator workflow.

## Quality Score

- Score: `Beta (74%)`
- Good qualities: update reuses tracked specs, exact selectors remain pinned,
  integrity drift can fail closed, uninstall removes config/policy/index state,
  and docs clearly state when a Gateway restart is required.
- Bad qualities: cold `list`/`inspect` versus live Gateway state remains an
  operator confusion point, and reload automation depends on managed Gateway
  state.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Update by plugin id, Reinstall vs update semantics, Downgrade, Uninstall config/index/policy/file cleanup, Gateway restart/reload requirements after.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a first-class rollback section that explains when to use pinned update,
  downgrade, reinstall with force, or uninstall/reinstall.
- Add live ClawHub and npm package update gates for stable, beta, exact, and
  integrity-drift cases.

## Evidence

### Docs

- `docs/tools/plugin.md:87`: installing, updating, or uninstalling plugin code requires a Gateway restart.
- `docs/cli/plugins.md:150`: `--force` is for reinstall, while routine upgrades should use `plugins update`.
- `docs/cli/plugins.md:341`: uninstall removes config entries, install index records, policy entries, and managed install directories.
- `docs/cli/plugins.md:355`: update command surface covers id/spec, all, dry-run, and unsafe override.
- `docs/cli/plugins.md:376`: beta-channel updates try beta first and fall back to default/latest when appropriate.

### Source

- `src/cli/plugins-cli.ts:167`: registers `openclaw plugins update`.
- `src/plugins/update.ts`: implements npm, ClawHub, git, marketplace, beta fallback, integrity drift, and externalized bundled plugin updates.
- `src/plugins/uninstall.ts:538`: computes uninstall actions and safe directory cleanup.
- `src/plugins/uninstall.ts:614`: applies directory removal after uninstall planning.

### Integration tests

- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:45`: runtime inspect after install.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:47`: disable flow.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:50`: enable flow.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:53`: upgrade flow.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:57`: downgrade flow.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:68`: uninstall with missing plugin code.

### Unit tests

- `src/plugins/update.test.ts:2148`: updates ClawHub-installed plugins via recorded package metadata.
- `src/plugins/update.test.ts:2213`: tries ClawHub beta for default ClawHub specs without persisting the beta tag.
- `src/plugins/update.test.ts:2296`: falls back to npm for trusted official ClawHub artifact blocks.
- `src/plugins/update.test.ts:2767`: checks marketplace installs during dry-run updates.
- `src/plugins/uninstall.test.ts:1572`: deletes managed ClawHub install directories.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "plugin lifecycle matrix update uninstall" --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "plugin lifecycle install update downgrade uninstall corrupt plugin repair" --limit 5 --json`

Results:

- Both queries returned no hits, so GitHub archive evidence did not add live lifecycle incidents beyond code/test evidence.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "plugin update rollback uninstall ClawHub npm"`

Results:

- Returned no hits, so Discord archive evidence did not add lifecycle proof for rollback/update/uninstall.
