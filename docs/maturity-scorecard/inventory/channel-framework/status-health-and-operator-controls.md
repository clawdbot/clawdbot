---
title: "Channel framework - Status Health and Operator Controls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Status Health and Operator Controls Maturity Note

## Summary

Status, health, and operator controls are strong. The Gateway exposes status snapshots, probes, account rows, warnings, health monitor restarts, stale-socket detection, restart caps, start/stop/logout RPCs, and CLI/operator docs. The implementation includes time budgets, partial snapshots, event-loop health, and per-channel health monitor overrides.

The maturity limit is explainability rather than basic capability. Archive evidence shows operators can still be confused by healthy-looking channel status when group policy, self-group behavior, stale listeners, or content-intent restrictions block replies.

## Category Scope

Included in this category:

- channels.status: channels.status, probes, account snapshots, and warnings
- Channel health policy: Channel health policy, health monitor restarts, stale socket detection, cooldowns, and restart caps
- Operator CLI controls: Operator CLI controls for start, stop, logout, status, restart, and troubleshoot
- Status read-model: Status read-model and plugin status snapshots

## Features

- channels.status: channels.status, probes, account snapshots, and warnings
- Channel health policy: Channel health policy, health monitor restarts, stale socket detection, cooldowns, and restart caps
- Operator CLI controls: Operator CLI controls for start, stop, logout, status, restart, and troubleshoot
- Status read-model: Status read-model and plugin status snapshots

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - Docs document local/gateway status, deep health probes, per-channel status probe troubleshooting, health monitor config, stale event thresholds, restart caps, and per-channel opt-outs (`docs/gateway/health.md:13`, `docs/gateway/health.md:38`, `docs/gateway/configuration-reference.md:556`, `docs/channels/troubleshooting.md:16`, `docs/channels/troubleshooting.md:58`).
  - Source has dedicated health policy, health monitor, channels.status handler, status read-model, and plugin status snapshot helpers.
  - Unit coverage is broad for health policy, health monitor edge cases, stale socket detection, status probe timeouts, partial snapshots, unhealthy annotations, start/stop/logout controls, and channel manager restart behavior.
  - Operator docs include per-channel troubleshooting signatures.
- Negative signals:
  - Status can report transport/config health while message-level policy still blocks replies, which users perceive as a status mismatch.
  - Status fields are spread across CLI, Gateway RPC, docs, plugin snapshots, and troubleshooting tables.
  - Some archive evidence points to healthy status snapshots that still required policy/routing explanation.
- Integration gaps:
  - No all-channel live health-probe matrix was found.
  - No E2E was found that intentionally creates each unhealthy/stale/busy/manual-stop/reconnect state and validates operator-facing output.

## Quality Score

- Score: `Beta (78%)`
- Quality rationale:
  - The health monitor is carefully bounded: startup grace, busy/stale behavior, cooldown, hourly caps, manual-stop skips, disabled/unconfigured skips, and single-flight checks are modeled.
  - Status handlers degrade gracefully with partial snapshots and warnings when probes throw or exceed budgets.
  - The docs expose useful operator commands and config knobs.
- Main quality risks:
  - Status does not always bridge from transport health to "why did my message not get a reply".
  - Multiple status surfaces use overlapping terms, so operators can misread configured/running/connected/works/audit ok.
  - Provider-specific probes and permissions make uniform health semantics hard.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for channels.status, Channel health policy, Operator CLI controls, Status read-model.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a status explanation layer that distinguishes transport health, auth health, policy admission, routing, and delivery.
- Add an E2E state matrix for health monitor restart reasons and channels.status output.
- Consolidate operator status terms into one docs table tied to Gateway RPC JSON fields.

## Evidence

### Docs

- `docs/gateway/health.md:13` through `docs/gateway/health.md:19` list `openclaw status`, `openclaw status --all`, `openclaw status --deep`, `openclaw health`, and channel `/status`.
- `docs/gateway/health.md:38` through `docs/gateway/health.md:42` document channel health monitor interval, stale-event threshold, restart caps, and per-channel/account opt-outs.
- `docs/gateway/health.md:47` and `docs/gateway/health.md:67` document relink guidance and health snapshot contents.
- `docs/gateway/configuration-reference.md:556` through `docs/gateway/configuration-reference.md:560` document health monitor configuration keys.
- `docs/channels/troubleshooting.md:16` through `docs/channels/troubleshooting.md:28` document healthy baseline checks.
- `docs/channels/troubleshooting.md:58` through `docs/channels/troubleshooting.md:60` document reconnect loops, timeout loops, late replies, and doctor/restart actions.
- `docs/channels/discord.md:1535` through `docs/channels/discord.md:1546` use `channels status --probe` to debug group policy, allowlists, and mention gating.

### Source

- `src/gateway/channel-health-policy.ts:48` through `src/gateway/channel-health-policy.ts:143` models health thresholds, evaluation, and restart reasons.
- `src/gateway/channel-health-monitor.ts:76` through `src/gateway/channel-health-monitor.ts:184` implements startup grace, skipped states, health evaluation, cooldowns, restart caps, and stop/start restart work.
- `src/gateway/server-methods/channels.ts:57` through `src/gateway/server-methods/channels.ts:127` define status timeout/concurrency and hook timeout/error handling.
- `src/gateway/server-methods/channels.ts:285` through `src/gateway/server-methods/channels.ts:541` implements channels.status, probe/audit/snapshot building, warnings, event-loop health, and partial results.
- `src/channels/status/read-model.ts:26` through `src/channels/status/read-model.ts:135` builds runtime accounts, normalized snapshots, account lookup, credential availability, and account rows.
- `src/channels/plugins/status.ts:8` through `src/channels/plugins/status.ts:92` builds channel account status snapshots from config/inspection.
- `src/gateway/protocol/schema/channels.ts:633` through `src/gateway/protocol/schema/channels.ts:753` defines channels.status params/results and start/stop schemas.

### Integration tests

- `scripts/e2e/npm-onboard-channel-agent-docker.sh:164` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:171` checks `channels status` and `status` surfaces after channel add.
- `scripts/e2e/lib/release-user-journey/assertions.mjs` is used by the release user journey to assert channel status after restart.
- No all-channel live health monitor/probe state matrix was found.

### Unit tests

- `src/gateway/channel-health-policy.test.ts:17` through `src/gateway/channel-health-policy.test.ts:311` covers disabled accounts, connect grace, busy/stale behavior, stale socket detection, transport timestamps, webhook/polling cases, inherited timestamps, and restart reason mapping.
- `src/gateway/channel-health-monitor.test.ts:152` through `src/gateway/channel-health-monitor.test.ts:616` covers startup grace, snapshot failures, healthy/disabled/unconfigured/manual-stop skips, stuck/disconnected/reconnect restarts, busy/stale behavior, cooldowns, hourly caps, single-flight checks, abort/stop, and stale socket detection.
- `src/gateway/server-methods/channels.status.test.ts:97` through `src/gateway/server-methods/channels.status.test.ts:369` covers config snapshots, probe timeout caps, filtering, probe throws, status budget timeouts, fallback summaries, unhealthy annotations, and event-loop health.
- `src/gateway/server-methods/channels.start.test.ts:67` through `src/gateway/server-methods/channels.start.test.ts:253` covers operator start, stop, and logout handlers.
- `src/gateway/server-channels.test.ts:935` through `src/gateway/server-channels.test.ts:1050` covers health monitor override resolution and fail-closed behavior during account resolution.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel status health readiness disconnected stale socket" --json --limit 8`

Results:

- Returned no hits, which is neutral after freshness checks for that exact phrase.

Query: `gitcrawl search openclaw/openclaw --query "channels status configured connected running channelAccounts" --json --limit 8`

Results:

- Returned no hits, which is neutral after freshness checks.

Query: `gitcrawl search openclaw/openclaw --query "channel readiness stale socket disconnected gateway" --json --limit 8`

Results:

- Returned no hits, which is neutral after freshness checks.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channels status configured connected running channelAccounts" --limit 8`

Results:

- Found WhatsApp and Discord support discussions where status looked healthy or partially healthy but replies were blocked by group/self behavior, missing active listener state, content intent limitations, unresolved channel IDs, or status/probe pipeline errors.
- This supports the assessment that status capability is strong but explainability across transport, policy, and delivery needs more work.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel status health readiness disconnected stale socket" --limit 8`

Results:

- Returned null, which is neutral after freshness checks.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel readiness stale socket disconnected gateway" --limit 8`

Results:

- Returned null, which is neutral after freshness checks.
