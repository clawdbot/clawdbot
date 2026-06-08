---
title: "Native Windows companion app - Gateway Connection Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Gateway Connection Maturity Note

## Summary

OpenClaw has real Windows Gateway service and node-pairing infrastructure, but
not a supported native Windows companion app that owns local/remote connection
mode, device pairing, or app-mediated Gateway attach/start. Archive evidence
says pairing is a known weak point in the Windows companion effort.

## Category Scope

Included in this category:

- App-managed local Gateway attach/start: App-managed local Gateway attach/start and status
- Remote Gateway connection modes: Remote Gateway connection modes, token/TLS handling, and reconnect
- Device/node pairing: Device/node pairing, pending approval UX, and pairing recovery

## Features

- App-managed local Gateway attach/start: App-managed local Gateway attach/start and status
- Remote Gateway connection modes: Remote Gateway connection modes, token/TLS handling, and reconnect
- Device/node pairing: Device/node pairing, pending approval UX, and pairing recovery

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (8%)`
- Positive signals: current main has Gateway connection, Windows service, and node-pairing primitives that a future app can reuse.
- Negative signals: no Windows app local/remote mode coordinator, pairing UI, app device identity store, remote tunnel manager, or reconnect UX exists in supported source.
- Integration gaps: no end-to-end app pairing, local attach/start, remote Gateway connect, TLS/token repair, or reconnect scenario is available.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (35%)`
- Gitcrawl reports: `#73315` proposes a cross-platform desktop companion; feature-specific query for pairing/install returned no Gitcrawl hits.
- Discrawl reports: maintainer message on `2026-05-06` says pairing is not as robust as desired for the Windows native code companion app.
- Good qualities: core Gateway and node-pairing boundaries are established in the repo, and Windows docs steer users to supported CLI/Gateway/WSL2 paths.
- Bad qualities: the app-level connection contract is absent and known prototype discussion calls out pairing fragility.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (8%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for App-managed local Gateway attach/start, Remote Gateway connection modes, Device/node pairing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No Windows app pairing UI or app device identity lifecycle exists in current main.
- No native app local/remote mode settings or tunnel manager exists.
- The docs do not explain how an external/prototype Windows app should pair with current Gateway versions.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:10-15` separates native CLI/Gateway support from planned companion app support.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:52-59` documents native Windows Gateway managed startup, not companion app-managed startup.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md` documents Gateway operation and Windows Scheduled Task service behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/daemon/service.ts:288-300` maps `win32` Gateway service management to Scheduled Tasks.
- `/Users/kevinlin/code/openclaw/src/infra/node-pairing.ts` and `/Users/kevinlin/code/openclaw/src/infra/node-pairing-authz.ts` provide adjacent pairing primitives.
- No Windows app connection-mode, pairing prompt, or remote tunnel source was found.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/windows-smoke.ts` validates native Windows CLI/Gateway flows, including Gateway startup and agent turns.
- No Windows app pairing or local/remote mode integration tests were found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/node-pairing.test.ts`
- `/Users/kevinlin/code/openclaw/src/infra/node-pairing-authz.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server.node-pairing-authz.test.ts`
- No Windows app pairing unit tests were found.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows companion pairing install x64 arm WSL" --json`
- `gitcrawl search openclaw/openclaw --query "Tauri desktop companion Windows Linux" --json`

Results:

- Pairing/install query returned no hits.
- `#73315` open PR proposes a Tauri desktop companion MVP for Linux/Windows.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows companion pairing install x64 arm WSL"`

Results:

- `2026-05-06` maintainer message says the Windows native companion effort aims for Mac companion parity, but pairing and install are not as robust as desired and x64/ARM/Windows/WSL combinatorics remain.
