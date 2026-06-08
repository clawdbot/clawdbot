---
title: "Nix install path - Doctor Setup Update and Daemon Service Mutation Guards Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Doctor Setup Update and Daemon Service Mutation Guards Maturity Note

## Summary

OpenClaw has explicit guardrails for several high-risk self-mutating commands in Nix mode: setup docs warn users away, doctor repair/token generation is blocked, daemon service install/uninstall is disabled, and gateway update checks are skipped. The main maturity gap is that the evidence is scattered across command tests and source branches rather than exercised as one real Nix install flow.

## Category Scope

This category covers `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.

## Features

- Setup write refusal: Covers Setup write refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Doctor repair refusal: Covers Doctor repair refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Update handoff: Covers Update handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Service lifecycle handoff: Covers Service lifecycle handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (40%)`
- Positive signals: Doctor repair/token generation has focused regression coverage, daemon service install has Nix-mode abort behavior, and startup update checks return early in Nix mode.
- Negative signals: The guard coverage is distributed by command and does not prove a full operator workflow under Nix.
- Integration gaps: No local launchd/systemd service e2e proved that Nix-managed service lifecycle is delegated to Nix rather than OpenClaw mutators.

## Quality Score

- Score: `Experimental (49%)`
- Gitcrawl reports: `doctor Nix mode` returned open PR `#79734` about doctor dry-run in Nix mode and PR `#82032` about configuration internals, showing the area is still active.
- Discrawl reports: A May 2026 maintainer message explicitly said the doctor bug sounded narrower than the general policy-boundary fix and should be tracked separately.
- Good qualities: Command messages are direct, and high-risk service install/uninstall paths fail closed in Nix mode.
- Bad qualities: Doctor remains broad, and archive context shows maintainers still worry about repair paths that might mutate when they should only report.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (40%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Setup write refusal, Doctor repair refusal, Update handoff, Service lifecycle handoff.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No single scenario starts a Nix gateway and validates setup, doctor, update, and service lifecycle semantics together.
- Dry-run doctor behavior is still discussed in open GitHub context.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/cli/setup.md:15` documents that setup refuses writes in Nix mode.
- `/Users/kevinlin/code/openclaw/docs/cli/doctor.md:190` says read-only doctor checks work but `doctor --fix`, `--repair`, `--yes`, and `--generate-gateway-token` are disabled in Nix mode.
- `/Users/kevinlin/code/openclaw/docs/install/nix.md:70` lists mutating update, doctor repair/token generation, and setup/onboarding/config writers as disabled against immutable config.

### Source

- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/shared.ts:37` fails service install with `Nix mode detected; service install is disabled.`
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/lifecycle-core.ts:194` fails service uninstall with `Nix mode detected; service uninstall is disabled.`
- `/Users/kevinlin/code/openclaw/src/commands/uninstall.ts:57` through `:59` disables service uninstall and tells users to manage the service through their Nix profile.
- `/Users/kevinlin/code/openclaw/src/infra/update-startup.ts:305` through `:318` returns early from gateway update checks when `isNixMode` is true.
- `/Users/kevinlin/code/openclaw/src/flows/doctor-health.ts:13` calls `assertConfigWriteAllowedInCurrentMode`.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor.runs-legacy-state-migrations-yes-mode-without.e2e.test.ts:67` through `:79` verifies doctor repair mode refuses in Nix mode before repair side effects.
- `/Users/kevinlin/code/openclaw/src/commands/doctor.runs-legacy-state-migrations-yes-mode-without.e2e.test.ts:86` through `:98` verifies gateway token generation refuses in Nix mode.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/install.test.ts:154` through `:158` verifies daemon install Nix-mode failure messaging.
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/lifecycle-core.config-guard.test.ts:19` covers daemon lifecycle guard context.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "doctor Nix mode" --json`

Results:

- Returned PR `#79734` about doctor `--dry-run` and Nix-mode compatibility.
- Returned PR `#82032` about configuration internals and validation diagnostics.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "doctor Nix mode"`

Results:

- `maintainers` on 2026-05-06 said PR `#78047` fixed automatic/runtime config-write policy, but a doctor issue should still be tracked separately.
- A January user report mentioned `moltbot doctor --non-interactive` on a Nix install, showing doctor is part of real Nix operator troubleshooting.
