---
title: "ClawHub - Compatibility and Trust Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Compatibility and Trust Maturity Note

## Summary

Compatibility is real but still maturing. ClawHub, npm, and external package
metadata all carry plugin API and host-version gates, and official external
plugins can be preferred over bundled copies during migration. The surface is
Beta because compatibility checks are implemented across several paths, but
archive evidence shows active work to align direct package installs with the
same ClawHub compatibility semantics and to keep official catalog fallbacks
predictable.

## Category Scope

Included in this category:

- openclaw.compat.pluginApi: openclaw.compat.pluginApi, build metadata, and host/gateway minimums
- ClawHub package compatibility validation: Evidence scope for ClawHub package compatibility validation.
- npm compatibility fallback to the newest: npm compatibility fallback to the newest compatible stable version
- Official external plugin catalog behavior: Official external plugin catalog behavior and bundled-to-external migration
- Compatibility docs: Compatibility docs and deprecation registry
- Operator trust model for installing: Operator trust model for installing and enabling external code
- ClawHub archive: ClawHub archive and ClawPack digest verification
- npm integrity drift: npm integrity drift and managed install checks
- Built-in dangerous-code scanner: Built-in dangerous-code scanner and break-glass override semantics
- ClawHub publishing review/hidden-release behavior as upstream: ClawHub publishing review/hidden-release behavior as upstream trust signal

## Features

- openclaw.compat.pluginApi: openclaw.compat.pluginApi, build metadata, and host/gateway minimums
- ClawHub package compatibility validation: Evidence scope for ClawHub package compatibility validation.
- npm compatibility fallback to the newest: npm compatibility fallback to the newest compatible stable version
- Official external plugin catalog behavior: Official external plugin catalog behavior and bundled-to-external migration
- Compatibility docs: Compatibility docs and deprecation registry
- Operator trust model for installing: Operator trust model for installing and enabling external code
- ClawHub archive: ClawHub archive and ClawPack digest verification
- npm integrity drift: npm integrity drift and managed install checks
- Built-in dangerous-code scanner: Built-in dangerous-code scanner and break-glass override semantics
- ClawHub publishing review/hidden-release behavior as upstream: ClawHub publishing review/hidden-release behavior as upstream trust signal
- Skill archive safety: Uploaded skill archives are gated and reuse extraction protections.
- Skill audit signals: ClawHub audit status, risk, findings, and trust metadata apply to skill packages.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs and source cover plugin API ranges, minimum gateway
  versions, package contract validation, npm compatible-version fallback, and
  official external plugin migration.
- Negative signals: GitHub archive evidence shows a recent compatibility gap in
  direct package installs, and there is no single live matrix for ClawHub, npm,
  and bundled fallback compatibility.
- Integration gaps: official catalog source, fallback, and compatibility checks
  need a package-installed gate across stable, beta, exact, and incompatible
  package lines.

## Quality Score

- Score: `Beta (74%)`
- Good qualities: compatibility failures are explicit and actionable, external
  package contract fields are normalized, and npm fallback searches older stable
  versions instead of blindly installing an incompatible latest release.
- Bad qualities: compatibility policy is split between ClawHub metadata,
  package.json metadata, npm metadata, and official catalog ownership, creating
  drift risk.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw.compat.pluginApi, ClawHub package compatibility validation, npm compatibility fallback to the newest, Official external plugin catalog behavior, Compatibility docs, Operator trust model for installing, ClawHub archive, npm integrity drift, Built-in dangerous-code scanner, ClawHub publishing review/hidden-release behavior as upstream, Skill archive safety, Skill audit signals.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Consolidate direct npm/package install compatibility behavior with ClawHub
  compatibility behavior.
- Publish a small compatibility fixture set for older, same-floor beta, newer
  plugin API, newer host minimum, and missing metadata cases.

## Evidence

### Docs

- `docs/tools/plugin.md:139`: npm installs fallback to the newest compatible stable package when latest requires a newer host.
- `docs/cli/plugins.md:180`: npm install compatibility fallback and strict exact/tag behavior.
- `docs/plugins/compatibility.md:15`: compatibility registry tracks stable code, status, owner, dates, replacement, docs, and tests.
- `docs/plugins/plugin-inventory.md:141`: official external package inventory lists npm/ClawHub-distributed plugins.

### Source

- `packages/plugin-package-contract/src/index.ts:20`: external code plugin packages require `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`.
- `packages/plugin-package-contract/src/index.ts:46`: normalizes plugin API, gateway minimum, build, and SDK compatibility metadata.
- `src/plugins/install.ts:145`: validates package plugin API compatibility.
- `src/plugins/install.ts:170`: validates package host minimum compatibility.
- `src/plugins/clawhub.ts:963`: rejects incompatible ClawHub package family, channel, plugin API, and gateway minimums.

### Integration tests

- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:41`: package-installed install path exercises compatible npm fixture packages.
- No live ClawHub/npm official catalog compatibility matrix was found.

### Unit tests

- `src/plugins/clawhub.test.ts:807`: installs when ClawHub advertises a wildcard plugin API range.
- `src/plugins/clawhub.test.ts:832`: accepts a CalVer correction runtime that satisfies the base plugin API range.
- `src/plugins/clawhub.test.ts:858`: accepts a beta runtime on the same plugin API floor.
- `src/plugins/clawhub.test.ts:884`: rejects invalid runtime compatibility hidden by a wildcard plugin API range.
- `test/plugin-npm-release.test.ts:207`: requires the external plugin package compatibility contract for npm publish.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "plugin compatibility ClawHub npm release" --limit 5 --json`

Results:

- Returned #87477, which aligns direct package installs with ClawHub plugin API compatibility checks.
- Returned #81957, which notes no live npm publish, npm dist-tag mutation, ClawHub publish, release publish, or production gateway run in that supply-chain hardening context.
- Returned #75186, which notes live npm/ClawHub install/update/uninstall was not verified for plugin management RPCs.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "plugin compatibility ClawHub npm release"`

Results:

- Returned a 2026-05-07 maintainer discussion about ClawHub/plugin ownership mismatch and registry manifest ownership, plus 2026-05-05 beta notes mentioning npm/ClawHub source switches and externalized official plugin repair.
