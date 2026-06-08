---
title: "macOS Gateway host - Profiles and Isolation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Profiles and Isolation Maturity Note

## Summary

Profiles and multi-Gateway isolation are documented and implemented for macOS
operators who run a rescue bot or intentionally isolated Gateway instances.
Docs cover profile-specific state/config/workspace roots, derived ports,
service labels, and quick checks. Source and tests cover profile-specific
LaunchAgent labels and service environment behavior.

Coverage is Beta because there is less live macOS profile-isolation proof than
single-Gateway local-mode proof. Quality is Stable because the model is
explicit and conservative: one Gateway is recommended by default, with profiles
reserved for intentional isolation.

## Category Scope

Included in this category:

- Profile-specific LaunchAgent labels: Profile-specific LaunchAgent labels and plist paths
- Profile-specific state/config/workspace roots: Profile-specific state, config, and workspace roots for isolated local Gateways.
- Derived ports: Derived ports and multi-Gateway conflict avoidance
- Rescue bot setup: Rescue bot setup and operator checks
- Extra Gateway process detection: Deep status detection for extra Gateway-like services and duplicate local processes.

## Features

- Profile-specific LaunchAgent labels: Profile-specific LaunchAgent labels and plist paths
- Profile-specific state/config/workspace roots: Profile-specific state, config, and workspace roots for isolated local Gateways.
- Derived ports: Derived ports and multi-Gateway conflict avoidance
- Rescue bot setup: Rescue bot setup and operator checks
- Extra Gateway process detection: Deep status detection for extra Gateway-like services and duplicate local processes.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: docs, launchd label source, service env tests, restart-log tests, and multi-Gateway e2e coverage support the intended profile model.
- Negative signals: profile proof is mostly CLI/runtime oriented, not a packaged macOS app workflow with multiple app-managed LaunchAgents.
- Integration gaps: need live proof for two macOS profile LaunchAgents, isolated ports/state/config, separate logs, and clean app/operator targeting.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: `multiple gateways macOS profile launchd port isolation rescue bot` returned no open hits.
- Discrawl reports: `multiple gateways profile rescue bot` returned user guidance that one Gateway is usually enough, extra gateways should be intentional rescue/isolation setups, and docs front-loaded a rescue-bot quickstart.
- Good qualities: docs discourage casual multi-Gateway use, source creates profile-specific labels, tests assert profile-specific labels/logs, and the multiple-Gateways page gives a practical isolation checklist.
- Bad qualities: multi-Gateway operation increases operator burden around ports, browser/CDP ranges, profile names, service labels, and targeting.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Profile-specific LaunchAgent labels, Profile-specific state/config/workspace roots, Derived ports, Rescue bot setup, Extra Gateway process detection.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a macOS live profile-isolation scenario with two LaunchAgents and two port ranges.
- Add app-facing profile selection or clearer limits if the app is intended to manage only one local Gateway at a time.
- Make deep status warnings for extra services easier to map back to profile labels.

## Evidence

### Docs

- `docs/gateway/multiple-gateways.md:9`: says most setups need one Gateway and introduces rescue bot/profile use.
- `docs/gateway/multiple-gateways.md:24`: provides rescue quickstart.
- `docs/gateway/multiple-gateways.md:47`: documents per-profile state/config/workspace/service roots.
- `docs/gateway/multiple-gateways.md:78`: documents general multi-Gateway setup.
- `docs/gateway/multiple-gateways.md:117`: documents isolation checklist and derived ports.
- `docs/gateway/multiple-gateways.md:158`: documents quick checks.
- `docs/gateway/index.md:152`: documents multiple Gateway checklist from the main Gateway docs.
- `docs/cli/gateway.md:323`: documents probe warnings and multiple Gateway detection.

### Source

- `src/daemon/launchd.ts:111`: derives LaunchAgent labels and plist paths, including profile-specific variants.
- `src/daemon/launchd.ts:127`: derives env dir/file/wrapper paths.
- `src/daemon/service.ts:173`: reads service state for the selected profile/service.
- `src/config/paths.ts:56`: resolves state roots used by profile-specific Gateway instances.
- `src/config/paths.ts:151`: resolves config paths used by profile-specific Gateway instances.
- `src/config/paths.ts:331`: resolves Gateway port defaults and overrides.

### Integration tests

- `test/gateway.multi.e2e.test.ts:27`: spins two Gateway instances and validates HTTP hooks and WebSocket node pairing.
- `scripts/e2e/parallels/macos-smoke.ts:923`: runs deep status on macOS, relevant to detecting service/port drift though not a multi-profile lane.

### Unit tests

- `src/daemon/service-env.test.ts:676`: verifies profile-specific service unit/LaunchAgent label behavior.
- `src/daemon/service-env.test.ts:715`: verifies profile-specific launchd label behavior.
- `src/daemon/restart-logs.test.ts:39`: verifies macOS LaunchAgent logs under `~/Library/Logs/openclaw`.
- `src/daemon/restart-logs.test.ts:54`: verifies profile-aware restart log paths.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "multiple gateways macOS profile launchd port isolation rescue bot" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "multiple gateways profile rescue bot"
```

Results:

- Returned 2026-04-21 PR mirror #69803 for docs front-loading the rescue-bot quickstart.
- Returned support guidance that one Gateway is usually enough and multiple Gateways are for intentional isolation or rescue-bot setups.
- Returned a March 2026 support explanation of isolation benefits and port-conflict costs.
