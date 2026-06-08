---
title: "Nix install path - Service Runtime and Guards Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Service Runtime and Guards Maturity Note

## Summary

OpenClaw has source support for injecting Nix profile binaries into gateway service PATHs and documentation explaining `NIX_PROFILES` precedence. This is important for Nix-installed tools used by plugins and gateway subprocesses. The component remains experimental because evidence is focused on path-construction functions and archive context shows service PATH issues continue to appear in operator workflows.

## Category Scope

Included in this category:

- Nix profile PATH discovery: Covers Nix profile PATH discovery across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Profile precedence: Covers Profile precedence across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Service PATH fallback: Covers Service PATH fallback across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Trusted binary boundaries: Covers Trusted binary boundaries across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Setup write refusal: Covers Setup write refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Doctor repair refusal: Covers Doctor repair refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Update handoff: Covers Update handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Service lifecycle handoff: Covers Service lifecycle handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.

## Features

- Nix profile PATH discovery: Covers Nix profile PATH discovery across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Profile precedence: Covers Profile precedence across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Service PATH fallback: Covers Service PATH fallback across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Trusted binary boundaries: Covers Trusted binary boundaries across `NIX_PROFILES` handling, `~/.nix-profile/bin` fallback, launchd/systemd service PATH generation, and adjacent safe binary resolution rules.
- Setup write refusal: Covers Setup write refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Doctor repair refusal: Covers Doctor repair refusal across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Update handoff: Covers Update handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.
- Service lifecycle handoff: Covers Service lifecycle handoff across `openclaw setup`, `openclaw doctor` repair/token modes, `openclaw update`/startup auto-update behavior, and daemon service install/uninstall behavior under Nix mode.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (38%)`
- Positive signals: Unit tests cover Linux fallback, `NIX_PROFILES` ordering, macOS default omission, explicit macOS inclusion, and multi-profile precedence.
- Negative signals: No test starts a real launchd/systemd service produced by a Nix module and verifies command execution through the resulting PATH.
- Integration gaps: No live gateway/plugin shell-out proof was found for Nix-managed binaries in service environments.

## Quality Score

- Score: `Experimental (45%)`
- Gitcrawl reports: `nix profile` returned PR `#85238` about including pnpm 11 bins in gateway PATH, showing the service PATH surface remains an active support area.
- Discrawl reports: Discord archive includes GitHub bot comments around PR `#59935`, including review discussion about modern Nix profile fallback behavior and later supersession.
- Good qualities: PATH construction preserves Nix right-to-left precedence and avoids trusting arbitrary `NIX_PROFILES` in the separate safe binary resolver.
- Bad qualities: The fallback still documents and implements legacy `~/.nix-profile/bin`, while archive review raised newer profile path concerns.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (38%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Nix profile PATH discovery, Profile precedence, Service PATH fallback, Trusted binary boundaries, Setup write refusal, Doctor repair refusal, Update handoff, Service lifecycle handoff.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No installed-service proof validates the documented launchd/systemd behavior.
- Modern Nix profile locations beyond `~/.nix-profile/bin` require careful support interpretation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/nix.md:87` through `:95` documents service PATH discovery, `NIX_PROFILES` right-to-left precedence, fallback to `~/.nix-profile/bin`, and applicability to macOS launchd and Linux systemd.

### Source

- `/Users/kevinlin/code/openclaw/src/daemon/service-env.ts:198` through `:214` implements Nix profile PATH logic and right-to-left `NIX_PROFILES` precedence.
- `/Users/kevinlin/code/openclaw/src/daemon/service-env.ts:277` through `:320` wires Nix Home Manager profile bins into macOS and Linux service PATH construction.
- `/Users/kevinlin/code/openclaw/src/infra/resolve-system-bin.ts:113` through `:116` intentionally does not derive trusted system binary search dirs from env-controlled `NIX_PROFILES`.

### Integration tests

- No launchd/systemd/Home Manager service integration proof was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/daemon/service-env.test.ts:357` through `:469` covers fallback, omission, `NIX_PROFILES`, and precedence behavior.
- `/Users/kevinlin/code/openclaw/src/infra/resolve-system-bin.test.ts:244` through `:264` verifies env-controlled `NIX_PROFILES` entries and direct store paths are not trusted by the safe system binary resolver.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "NIX_PROFILES" --json`

Results:

- Returned `hits: []`.

Query:

`gitcrawl search openclaw/openclaw --query "nix profile" --json`

Results:

- Returned PR `#85238` (`fix: include pnpm 11 bins in gateway PATH`) with a snippet containing `~/.nix-profile/bin`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "NIX_PROFILES"`

Results:

- GitHub bot message on 2026-04-25 said PR `#44433` was superseded by `#59935`, which landed Nix Home Manager service PATH support with `NIX_PROFILES` precedence coverage.
- Review comment on PR `#59935` raised a concern that `~/.nix-profile/bin` fallback can miss newer Nix active profile locations.
- Another review comment argued `NIX_PROFILES=""` is not a standard Nix operation and should follow existing env var truthy/falsy patterns.
