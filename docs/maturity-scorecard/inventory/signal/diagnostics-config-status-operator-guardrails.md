---
title: "Signal - Diagnostics, Config Status, and Operator Guardrails Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Diagnostics, Config Status, and Operator Guardrails Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Diagnostics, Config Status, and Operator Guardrails` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Signal capability area represented by these taxonomy features:

- Diagnostics, Config Status, and Operator Guardrails: Evidence scope for Diagnostics, Config Status, and Operator Guardrails.

## Features

- Status probes: Defines Status probes setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Setup diagnostics: Defines Setup diagnostics setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Account safety guardrails: Defines Account safety guardrails setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (55%)`

Coverage is Alpha because docs and source cover configuration, status, and troubleshooting, but live status, doctor, account-state, and failure-mode transcripts are thin.

## Quality Score

- Score: `Alpha (60%)`

Quality is Alpha because status and setup checks exist, but operator history shows probes can pass while the receive path is broken, and account-state protections remain too dependent on external `signal-cli` state. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (55%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Status probes, Setup diagnostics, Account safety guardrails.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 103-160 cover multi-account setup, SMS registration, install commands, captcha, doctor/status probes, and pairing warnings.
- `docs/channels/signal.md` lines 346-363 list troubleshooting checks for binary path, account list, status probe, and extra checks.
- `docs/channels/signal.md` lines 367-372 document security and account-isolation notes.

### Source

- `src/config/types.signal.ts` defines typed config fields for accounts, API mode, receive behavior, startup timeout, group controls, limits, and reactions.
- `extensions/signal/src/setup-surface.ts` reports binary and account status in the setup surface.
- `extensions/signal/src/setup-core.ts` emits setup completion guidance that tells operators to run channel status.
- `extensions/signal/src/probe.ts` wraps `signalCheck` and `version` for status.
- `extensions/signal/src/monitor/tool-result.ts` bounds startup readiness and handles daemon-exit failures.
- `extensions/signal/src/daemon.ts` classifies common daemon logs and exposes stop/exited state.

### Integration tests

- `extensions/signal/src/probe.contract.test.ts` covers the probe contract.
- No live `channels.status`, `channel doctor`, account recovery, or failure-mode transcript was found in `qa/`, `test/`, or `tests`.

### Unit tests

- `extensions/signal/src/core.test.ts` covers probe fallback/version/failure and setup status with configured accounts.
- `extensions/signal/src/monitor.tool-result.autostart.test.ts` covers readiness timeouts, startup-timeout overrides, daemon exit during startup, and shutdown after abort.
- `extensions/signal/src/daemon.test.ts` covers log classification.
- `extensions/signal/src/install-signal-cli.test.ts` covers guarded installer behavior that affects operator setup safety.

### Gitcrawl queries

- Query: `Signal inbound SSE listener wedged channels status`
  - Results: open issue `#75426` reports a state where outbound and probe worked while inbound was wedged and `channels status` timed out.
- Query: `Signal account registered false deletion`
  - Results: open issue `#66119` reports account-file mutation leading to account deletion.
- Query: `Signal support Note-to-Self linked-device`
  - Results: open PR `#75890` tracks Note-to-Self linked-device mode, showing ongoing operator-mode expansion.

### Discrawl queries

- Query: `Signal account registered false deletion`
  - Results: Discord GitHub mirror content repeated issue `#66119` and the account deletion summary.
- Query: `Signal inbound SSE listener wedged channels status`
  - Results: Discord mirror content matched issue `#75426`, reinforcing that status/probe behavior is not enough to prove receive health.
- Query: `Signal support Note-to-Self linked-device`
  - Results: no displayed operator transcript proved that linked-device mode had landed and been exercised.
