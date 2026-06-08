---
title: "Windows via WSL2 - Diagnostics and Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Diagnostics and Repair Maturity Note

## Summary

Diagnostics and repair are broadly implemented through the Linux/systemd Gateway stack: status surfaces service and Gateway runtime state, logs can fall back to active systemd journals, and doctor owns service repair, SecretRef diagnostics, and systemd linger checks. WSL2-specific Quality remains Beta because current archive evidence shows service-probe false negatives, user-bus confusion, and an open WSL environment diagnostics PR.

## Category Scope

Included in this category:

- openclaw doctor: openclaw doctor and repair/migration for WSL2 Gateway
- openclaw status: openclaw status, status --all, and Gateway service/runtime summary
- openclaw logs: openclaw logs and Linux systemd journal fallback
- SecretRef: SecretRef and auth diagnostics visible from status/doctor
- WSL/systemd unavailable hints: WSL/systemd unavailable hints and linger checks
- Operator repair guidance after WSL2 service: Operator repair guidance after WSL2 service, config, or Gateway failures

## Features

- openclaw doctor: openclaw doctor and repair/migration for WSL2 Gateway
- openclaw status: openclaw status, status --all, and Gateway service/runtime summary
- openclaw logs: openclaw logs and Linux systemd journal fallback
- SecretRef: SecretRef and auth diagnostics visible from status/doctor
- WSL/systemd unavailable hints: WSL/systemd unavailable hints and linger checks
- Operator repair guidance after WSL2 service: Operator repair guidance after WSL2 service, config, or Gateway failures

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: docs point WSL2 repair at `openclaw doctor`; status docs include Gateway and node host service runtime; logs docs include systemd journal fallback; source/tests cover systemd unavailable hints, status, logs fallback, and service repair behavior.
- Negative signals: WSL2-specific diagnostics are still emerging and currently rely on general Linux/service checks plus operator interpretation.
- Integration gaps: no WSL2-specific diagnostic e2e was found for systemd user-bus failure, stale portproxy, Windows-host Control UI reachability, and Gateway service repair in one scenario.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `Windows WSL2 gateway systemd` returned PR #58853 for WSL diagnostics, PR #68400 for WSL user D-Bus socket detection, issue #55563 for doctor-induced gateway cycling, and issue #84610 for WSL2 Gateway loop/diagnostic gaps. `WSL2 doctor logs update Gateway` returned 0 hits.
- Discrawl reports: WSL2 systemd/diagnostics search returned the `No medium found` service-probe report, status outputs where systemd service is running but Gateway is unreachable, and support guidance to run `openclaw status --deep`, inspect processes, and separate native Windows installs from WSL2 installs.
- Good qualities: the diagnostics surface is broad and source-backed; logs redact secrets when reading the systemd journal; status reports update, service, Gateway, security, and secret diagnostics.
- Bad qualities: WSL2-specific root causes can still be presented as generic systemd, port, or gateway failures, so users need support help to choose the next check.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw doctor, openclaw status, openclaw logs, SecretRef, WSL/systemd unavailable hints, Operator repair guidance after WSL2 service.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need WSL environment diagnostics to land and be reflected in docs/status.
- Need stale portproxy, WSL boot, Windows firewall, and Windows-host localhost checks in a WSL2-focused repair path.
- Need WSL2-specific examples for interpreting `status --all` when service is running but Gateway WebSocket is unreachable.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:88`: WSL2 repair/migration points to `openclaw doctor`.
- `/Users/kevinlin/code/openclaw/docs/cli/status.md:32`: status overview includes Gateway and node host service install/runtime status when available.
- `/Users/kevinlin/code/openclaw/docs/cli/status.md:37`: status resolves supported SecretRefs and reports degraded output for unavailable ones.
- `/Users/kevinlin/code/openclaw/docs/cli/logs.md:61`: logs fallback to configured Gateway file log when local Gateway RPC is unavailable.
- `/Users/kevinlin/code/openclaw/docs/cli/logs.md:62`: on Linux, `logs --follow` can use the active user-systemd Gateway journal by PID.
- `/Users/kevinlin/code/openclaw/docs/cli/doctor.md:196`: non-interactive doctor reports missing/stale service definitions but does not install them outside update repair mode.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:464`: doctor checks systemd linger on Linux.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:529`: doctor audits and repairs supervisor config drift.

### Source

- `/Users/kevinlin/code/openclaw/src/daemon/systemd-hints.ts:24`: WSL-specific systemd unavailable hints are rendered when WSL is detected.
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/lifecycle-core.ts:68`: lifecycle actions augment service hints with WSL-aware systemd guidance.
- `/Users/kevinlin/code/openclaw/src/flows/doctor-health-contributions.ts:623`: doctor systemd-linger health integrates with Linux service state.
- `/Users/kevinlin/code/openclaw/src/commands/status.format.ts`: status formatting includes service runtime and systemd cgroup hygiene summaries.
- `/Users/kevinlin/code/openclaw/src/cli/logs-cli.ts`: logs CLI reads active systemd service runtime and journal fallback.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:122`: e2e verifies doctor can switch service entrypoints across install variants.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:174`: e2e verifies service environment cleanup.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/logs-cli.test.ts:415`: logs tests use active systemd journal for implicit local follow failures.
- `/Users/kevinlin/code/openclaw/src/commands/status.daemon.test.ts:46`: status tests include suspicious systemd cgroup hygiene in service runtime summary.
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/response.test.ts:34`: response tests classify WSL systemd hints.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd.test.ts:165`: systemd tests repair missing user-bus environment.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 doctor logs update Gateway" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 gateway systemd" --mode keyword --limit 10 --json`

Results:

- WSL2 doctor/logs/update query returned 0 hits.
- Windows WSL2 gateway systemd returned 10 hits, including WSL diagnostics PR #58853, doctor/gateway cycling issue #55563, WSL user-bus PR #68400, WSL2 event-loop freeze issue #56733, RestartSec/lock issue #80696, and WSL2 Gateway SIGTERM loop issue #84610.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 doctor logs update Gateway"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "Windows WSL2 gateway systemd"`

Results:

- WSL2 doctor/logs/update returned 8 hits, including WSL2 Telegram/channel failures, custom plugin parse errors, `doctor --fix` recovery attempts, and Gateway logs showing WSL2-specific network policy output.
- Windows WSL2 gateway systemd returned 8 hits, including `No medium found` service probe reports, status excerpts where systemd service is running but Gateway is unreachable, and support guidance for distinguishing service state from Gateway reachability.
