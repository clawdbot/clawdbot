---
title: "Nix install path - Config and State Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Nix install path - Config and State Maturity Note

## Summary

OpenClaw cleanly separates mutable state from config path overrides and documents that Nix users should set `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` explicitly. Source and tests cover path resolution, including `/nix/store` config paths. Operator archive evidence still shows misconfiguration and read-only filesystem confusion, so this component is not ready for promotion beyond experimental coverage.

## Category Scope

Included in this category:

- Immutable config guard: Covers Immutable config guard across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Config writer refusal: Covers Config writer refusal across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Agent-first Nix edits: Covers Agent-first Nix edits across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Explicit config path: Covers Explicit config path across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- Writable state directory: Covers Writable state directory across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- Immutable-store config support: Covers Immutable-store config support across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- State integrity checks: Covers State integrity checks across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.

## Features

- Immutable config guard: Covers Immutable config guard across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Config writer refusal: Covers Config writer refusal across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Agent-first Nix edits: Covers Agent-first Nix edits across `OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE` guard, source-edit guidance, config writer integration, and the agent-first Nix source instruction.
- Explicit config path: Covers Explicit config path across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- Writable state directory: Covers Writable state directory across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- Immutable-store config support: Covers Immutable-store config support across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.
- State integrity checks: Covers State integrity checks across config/state path environment variables, immutable store expectations, path resolution, state integrity checks around `/nix/store`, and runtime guidance that state should stay writable.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (45%)`
- Positive signals: Config path and state dir overrides have dedicated tests, including a `/nix/store` config path.
- Negative signals: The tests do not prove a full Nix-managed config plus writable state dir across gateway startup, sessions, plugins, backups, and doctor flows.
- Integration gaps: No real Nix install scenario validates that immutable config and writable state are correctly provisioned together.

## Quality Score

- Score: `Alpha (50%)`
- Gitcrawl reports: `OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR` returns many open PRs/issues using isolated config/state envs, plus issue `#57408` about project-local `.env` being ignored and falling back to `~/.openclaw/openclaw.json`.
- Discrawl reports: A current maintainer message calls out declarative/Nix packaging risk around writable runtime state and migrations tolerating read-only config/plugin dirs.
- Good qualities: Path resolution is explicit and docs tell Nix users to keep runtime state and config out of the immutable store.
- Bad qualities: Archive reports show config/state path behavior remains a recurring operator and maintainer concern, especially when config is read-only or state is accidentally shared.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow evidence were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Experimental (45%)`
- Surface instructions: evaluated against `references/completeness/nix-install-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Immutable config guard, Config writer refusal, Agent-first Nix edits, Explicit config path, Writable state directory, Immutable-store config support, State integrity checks.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No local installed-flow proof demonstrates a Nix store config path with a separate writable state dir.
- The docs table gives defaults but does not include a complete first-party local sample of the intended Nix paths.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/nix.md:75` through `:83` says OpenClaw reads JSON5 config from `OPENCLAW_CONFIG_PATH`, stores mutable data in `OPENCLAW_STATE_DIR`, and Nix users should set these explicitly to keep runtime state and config out of the immutable store.
- `/Users/kevinlin/code/openclaw/docs/start/getting-started.md:142` through `:143` lists `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` overrides.

### Source

- `/Users/kevinlin/code/openclaw/src/config/paths.ts:58` through `:68` resolves `OPENCLAW_STATE_DIR`.
- `/Users/kevinlin/code/openclaw/src/config/paths.ts:152` through `:161` resolves `OPENCLAW_CONFIG_PATH`.
- `/Users/kevinlin/code/openclaw/src/config/paths.ts:199` through `:206` uses `OPENCLAW_STATE_DIR` for config path candidates when config override is absent.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-state-integrity.ts:708` through `:738` treats `/nix/store` as an immutable store context for state/config integrity checks.

### Integration tests

- No full Nix install integration proof was found for config/state separation.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/config/config.nix-integration-u3-u5-u9.test.ts:42` through `:106` tests state dir and config path overrides, including `OPENCLAW_CONFIG_PATH: "/nix/store/abc/openclaw.json"`.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ConfigStoreTests.swift:73` through `:135` exercises macOS config store behavior with `OPENCLAW_CONFIG_PATH`.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR" --json`

Results:

- Returned many open PRs/issues using temp config/state envs as runtime proof harnesses.
- Notable open issue `#57408` says project-local `.env` was ignored and `OPENCLAW_CONFIG_PATH` fell back to `~/.openclaw/openclaw.json`.
- Open issue `#84313` references different `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` boundaries in a credential backup isolation bug.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR"`

Results:

- GitHub bot messages include examples of isolated temp `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` proof runs.
- A 2026-02-05 `nix-openclaw Gateway start blocked` thread showed service env with both variables and an empty `openclaw.json`.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "openclaw config read-only Nix"`

Results:

- `maintainers` on 2026-05-08 said declarative/Nix workflows are mostly fine if config stays file-backed, but runtime state path must be writable and migrations must tolerate read-only config/plugin dirs.
- A 2026-03-01 user report emphasized Nix store source is read-only and owned by another user.
