---
title: "Signal - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Channel Setup and Operations Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Setup, Install, and Account Provisioning` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Account Health`, `Transport`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- QR link setup: Defines QR link setup setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- SMS registration: Defines SMS registration setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Installer and binary setup: Defines Installer and binary setup setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Container account provisioning: Defines Container account provisioning setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Status probes: Defines Status probes setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Setup diagnostics: Defines Setup diagnostics setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Account safety guardrails: Defines Account safety guardrails setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.

## Features

- QR link setup: Defines QR link setup setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- SMS registration: Defines SMS registration setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Installer and binary setup: Defines Installer and binary setup setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Container account provisioning: Defines Container account provisioning setup, credential, configuration, and operator verification behavior for Setup, Install, and Account Provisioning.
- Status probes: Defines Status probes setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Setup diagnostics: Defines Setup diagnostics setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.
- Account safety guardrails: Defines Account safety guardrails setup, credential, configuration, and operator verification behavior for Diagnostics, Config Status, and Operator Guardrails.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`

Coverage is Alpha because docs and unit tests cover most setup branches, but there is no live registration, QR-linking, captcha, or account-provisioning transcript tied to the current source.

## Quality Score

- Score: `Alpha (62%)`

Quality is Alpha because the source has a coherent setup wizard and guarded installer, but operator history still shows account-state hazards and the docs ask users to manage fragile external Signal account state by hand. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for QR link setup, SMS registration, Installer and binary setup, Container account provisioning, Status probes, Setup diagnostics, Account safety guardrails.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 1-9 describe Signal as an external `signal-cli` integration with native daemon and container options.
- `docs/channels/signal.md` lines 11-28 list prerequisites, separate-number guidance, QR/SMS setup, and pairing approval.
- `docs/channels/signal.md` lines 30-54 document the minimal config: `account`, `cliPath`, `configPath`, `dmPolicy`, and `allowFrom`.
- `docs/channels/signal.md` lines 80-160 cover QR linking, SMS registration, install commands, captcha, status probing, and deauth risk.
- `docs/channels/signal.md` lines 185-240 cover container mode setup and required `MODE=json-rpc`.
- `docs/plugins/reference/signal.md` identifies the package as `@openclaw/signal` and the channel surface as `signal`.

### Source

- `extensions/signal/openclaw.plugin.json` declares the `signal` channel plugin and startup behavior.
- `extensions/signal/package.json` exposes CLI setup fields such as `--signal-number`, HTTP host/port options, labels, and the Signal docs path.
- `src/config/types.signal.ts` defines per-account fields including `account`, `cliPath`, `configPath`, `httpUrl`, `autoStart`, `startupTimeoutMs`, receive mode, groups, chunk limits, and reaction gates.
- `extensions/signal/src/setup-core.ts` implements the setup prompts, `allowFrom` parsing, `dmPolicy` defaults, per-account keying, CLI path input, Signal-number validation, and status-probe completion note.
- `extensions/signal/src/setup-surface.ts` checks the local binary and configured accounts, and exposes the optional auto-install flow.
- `extensions/signal/src/install-signal-cli.ts` downloads official native builds, falls back to Homebrew on macOS, and rejects unsafe archive entries.
- `extensions/signal/src/probe.ts` runs `signalCheck` and `version` for setup/status probing.

### Integration tests

- No live registration, QR-linking, captcha, or container provisioning run was found in `qa/`, `test/`, or the Signal extension tree.
- `extensions/signal/src/probe.contract.test.ts` gives contract-level status coverage but does not exercise a real Signal account.

### Unit tests

- `extensions/signal/src/install-signal-cli.test.ts` covers release asset selection for Linux, macOS, and Windows; malformed release metadata; fetch timeout; archive extraction; and zip-slip rejection.
- `extensions/signal/src/core.test.ts` covers probe fallback/version/failure, setup status for per-account CLI paths/default account, local approval suppression, durable adapter construction, daemon log classification, and setup parsing for UUID/wildcard allowlists.

### Gitcrawl queries

- Query: `Signal signal-cli install registration captcha`
  - Results: no focused install-proof thread was returned.
- Query: `Signal account registered false deletion`
  - Results: open issue `#66119` reports that an update set `registered=false` in a `signal-cli` account file and caused account deletion.
- Query: `Signal signal-cli`
  - Results: broader results include setup, daemon, and account lifecycle issues, but not a current successful provisioning transcript.

### Discrawl queries

- Query: `Signal signal-cli install registration captcha`
  - Results: no displayed operator transcript showed a current successful install and registration run.
- Query: `Signal account registered false deletion`
  - Results: Discord GitHub mirror content repeated issue `#66119`, including the account deletion summary.
- Query: `Signal dmPolicy pairing allowFrom uuid`
  - Results: support discussion from 2026-02-25 and 2026-02-26 showed operators needed help configuring `allowFrom` and pairing after setup.
