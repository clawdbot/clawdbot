---
title: "Nix install path - Immutable Config and Agent-first Source Edits Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Immutable Config and Agent-first Source Edits Maturity Note

## Summary

The strongest local Nix signal is the immutable-config write guard. OpenClaw centralizes the error message, blocks broad config mutation paths, and points users and agents back to the Nix source. The component still lacks a full runtime proof that every user-facing writer goes through the guard under a real Nix deployment.

## Category Scope

This category covers the `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.

## Features

- Immutable config guard: Covers Immutable config guard across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Config writer refusal: Covers Config writer refusal across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Agent-first Nix edits: Covers Agent-first Nix edits across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (45%)`
- Positive signals: Multiple source paths call the centralized guard, and docs name the exact mutators that should refuse to edit `openclaw.json`.
- Negative signals: The proof is mainly command/source-path coverage; no real immutable Nix store run was found across all mutators.
- Integration gaps: No e2e proved a real Nix-managed config refusing setup, onboarding, config set, plugin commands, update, and doctor repair in one installed flow.

## Quality Score

- Score: `Alpha (55%)`
- Gitcrawl reports: `config immutable Nix` returned PR `#79734`, which says `--dry-run` should work in Nix mode where config is immutable.
- Discrawl reports: A May 2026 maintainer thread said PR `#78047` fixed the policy boundary for automatic/runtime config writes, while also calling out a narrower doctor issue to track separately.
- Good qualities: The error text is explicit, central, actionable, and links both the agent-first quick start and the Nix overview.
- Bad qualities: Archive context shows this boundary was a real source of confusion and needed retrofit work; the current implementation still relies on every writer using the shared guard.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (45%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Immutable config guard, Config writer refusal, Agent-first Nix edits.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The source guard is broad but not automatically exhaustive for future direct file writes.
- The local repo cannot validate whether external Nix source edits are correct because the module lives outside this repo.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/nix.md:67` through `:73` lists Nix-mode changes and says agents should edit `programs.openclaw.config` or `instances.<name>.config` in the Nix source.
- `/Users/kevinlin/code/openclaw/docs/cli/setup.md:15` says `openclaw setup` is for mutable installs and refuses writes in Nix mode.

### Source

- `/Users/kevinlin/code/openclaw/src/config/nix-mode-write-guard.ts:3` through `:7` defines the Nix URLs and `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` error code.
- `/Users/kevinlin/code/openclaw/src/config/nix-mode-write-guard.ts:15` through `:23` formats the user-facing immutable-config message and tells users not to run setup, onboarding, update, plugin mutators, doctor repair/token generation, or config set against the file.
- `/Users/kevinlin/code/openclaw/src/config/nix-mode-write-guard.ts:27` through `:36` throws when `resolveIsNixMode` is true.
- `rg -n "assertConfigWriteAllowedInCurrentMode(" /Users/kevinlin/code/openclaw/src` found guard calls in config IO/mutation, onboarding plugin install, update command, plugin install/update/uninstall/runtime, doctor health, and auto-reply plugin commands.

### Integration tests

- No single installed-flow integration test covering all immutable-config mutators was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/onboarding-plugin-install.test.ts:262` through `:283` verifies non-skipped onboarding plugin installs refuse in Nix mode.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-cli.policy.test.ts:96` through `:105` verifies plugin enablement refuses before config mutation.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/commands-plugins.test.ts:308` through `:319` verifies auto-reply plugin enablement refuses in Nix mode.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "config immutable Nix" --json`

Results:

- Returned PR `#79734` (`feat(doctor): add --dry-run flag to preview config changes without applying`) with snippet noting dry-run compatibility in Nix mode where config is immutable.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "doctor Nix mode"`

Results:

- `maintainers` on 2026-05-06 said PR `#78047` fixed the policy boundary for automatic/runtime config writes and Nix/immutable mode.
- The same message said a narrower doctor issue should still be tracked separately, lowering supporting evidence that every repair path is settled.
