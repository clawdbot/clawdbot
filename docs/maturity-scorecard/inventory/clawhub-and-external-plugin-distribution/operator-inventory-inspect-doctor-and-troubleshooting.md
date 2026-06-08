---
title: "ClawHub - Operator Inventory, Inspect, Doctor, and Troubleshooting Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - Operator Inventory, Inspect, Doctor, and Troubleshooting Maturity Note

## Summary

Operator diagnostics are broad and useful: list, inspect, runtime inspect,
doctor, registry refresh, troubleshooting tables, blocked path guidance, and
dependency-state repair are all documented. Coverage is Beta because command and
unit evidence is broad but live Gateway-vs-cold-state proof is uneven. Quality
is Beta because archive evidence shows `inspect` and `doctor` can still miss the
state that actually matters to a running Gateway.

## Category Scope

- `plugins list`, `plugins inspect`, runtime inspect, `plugins doctor`, and
  `plugins registry`.
- Local plugin index and persisted cold registry state.
- Troubleshooting stale config, blocked paths, dependencies, missing plugins,
  duplicate ownership, and invalid config.
- Runtime verification after Gateway restart.

## Features

- plugins list: plugins list, plugins inspect, runtime inspect, plugins doctor, and
- Local plugin index: Local plugin index and persisted cold registry state
- Troubleshooting stale config: Troubleshooting stale config, blocked paths, dependencies, missing plugins,
- Runtime verification after Gateway: Runtime verification after Gateway restart

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs explain cold versus runtime state, source exposes
  inspect/doctor/registry commands, and tests cover stale config, dependency
  cleanup, install records, and uninstall cleanup.
- Negative signals: GitHub archive evidence includes user-facing cases where
  CLI inspect/doctor looked healthy while the long-running daemon or provider
  state was not.
- Integration gaps: a live package-installed gate should compare cold registry,
  runtime inspect, Gateway status, and real plugin-owned command/tool behavior.

## Quality Score

- Score: `Beta (74%)`
- Good qualities: docs explicitly tell users when to restart, when to use
  runtime inspect, and when `doctor --fix` is the right repair path.
- Bad qualities: the tool surface has multiple overlapping views of plugin
  state, and the most important failure mode is often in the running Gateway,
  not the cold registry.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for plugins list, Local plugin index, Troubleshooting stale config, Runtime verification after Gateway.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a one-command diagnostic bundle that ties plugin index, cold registry,
  runtime inspect, Gateway RPC health, and plugin-owned command execution.
- Make `plugins doctor` more explicit when it has not checked the running
  Gateway process.

## Evidence

### Docs

- `docs/tools/plugin.md:104`: runtime inspect verifies registered tools, hooks, services, Gateway methods, and CLI commands.
- `docs/tools/plugin.md:193`: doctor repairs stale plugin ids, allowlist/tool mismatches, and legacy bundled plugin paths.
- `docs/tools/plugin.md:253`: troubleshooting covers list-vs-runtime, duplicate ownership, missing plugins, invalid config, blocked paths, Nix mode, dependency failure, and package shape.
- `docs/cli/plugins.md:296`: `plugins list` is a cold read model and not a live runtime probe.
- `docs/cli/plugins.md:416`: `plugins doctor` reports load errors, manifest diagnostics, compatibility notices, and stale config references.
- `docs/cli/plugins.md:428`: `plugins registry` inspects or rebuilds the persisted cold registry.

### Source

- `src/cli/plugins-cli.ts:64`: registers `plugins list`.
- `src/cli/plugins-cli.ts:87`: registers `plugins inspect`.
- `src/cli/plugins-cli.ts:183`: registers `plugins registry`.
- `src/cli/plugins-cli.ts:193`: registers `plugins doctor`.
- `src/plugins/uninstall.ts:538`: uninstall planning removes config and install-record references that diagnostics later read.

### Integration tests

- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:45`: records runtime inspect after install.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:76`: records marketplace list JSON before install.
- `scripts/e2e/lib/release-plugin-marketplace/scenario.sh:101`: verifies plugin uninstalled state after uninstall.

### Unit tests

- `src/commands/doctor/shared/stale-plugin-config.test.ts:53`: finds stale plugin policy and entry references.
- `src/commands/doctor/shared/stale-plugin-config.test.ts:84`: removes stale policy refs without changing valid refs.
- `src/commands/doctor/shared/stale-plugin-config.test.ts:317`: uses missing persisted install records as stale channel evidence.
- `src/plugins/uninstall.test.ts:745`: cleans stale policy references when plugin code and install records are gone.
- `src/plugins/uninstall.test.ts:1512`: never deletes arbitrary configured install paths.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "plugins list inspect doctor plugin registry install state" --limit 5 --json`

Results:

- Returned #75186 for plugin management RPCs covering list, inspect, doctor, registry status/refresh, and install.
- Returned #87347, where `plugins inspect` and `plugins doctor` showed Brave loaded or healthy while `web_search` still had no provider.
- Returned #78105, which asked for an actionable empty allowlist path using `plugins list/inspect`.
- Returned #78196, where extension plugins were skipped by the Gateway loader but appeared in CLI inspect/doctor.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "plugins inspect doctor registry status plugin issues"`

Results:

- Returned no hits, so Discord archive evidence did not add more diagnostic-specific proof.
