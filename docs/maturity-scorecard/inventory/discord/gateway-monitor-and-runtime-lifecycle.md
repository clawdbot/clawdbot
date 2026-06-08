---
title: "Discord - Gateway Monitor and Runtime Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Gateway Monitor and Runtime Lifecycle Maturity Note

## Summary

Discord gateway monitor and runtime lifecycle are implemented with substantial runtime supervision: account-aware startup, token and application ID resolution, startup staggering, gateway metadata fallback, READY wait/reconnect loops, heartbeat/reconnect state, outbound gateway send limiting, health-monitor restarts, manual stop semantics, and live status probes. The component is not Stable because current issue and Discord archive evidence still show active operator-visible failures around READY stalls, event-loop starvation, heartbeat timeouts, duplicate replies, multi-account startup priority, and rate-limit/fallback behavior.

## Category Scope

This note covers the Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, account monitor startup, token/application ID startup lookup, gateway metadata lookup, gateway rate limits, channel manager lifecycle handoff, channel health-monitor supervision, status/probe surfaces, and stop/restart behavior. It excludes Discord message routing policy, thread/forum behavior, bot setup UX, command rendering, voice media details, and application-level message delivery except where those paths expose gateway lifecycle behavior.

## Features

- Account monitor startup: Covers Account monitor startup across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Gateway WebSocket lifecycle: Covers Gateway WebSocket lifecycle across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Reconnect and heartbeat handling: Covers Reconnect and heartbeat handling across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Rate limits and gateway metadata: Covers Rate limits and gateway metadata across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Status, probe, and health-monitor recovery: Covers Status, probe, and health-monitor recovery across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: A Discord live QA runtime starts a real gateway child, injects a named Discord account, waits until `channels.status` reports the Discord account as `running`, `connected`, and not `restartPending`, then exercises live Discord channel messages and native command registration. A separate gated live smoke verifies real Discord bot identity and `/gateway/bot` metadata. Runtime-flow tests exercise READY timeout reconnect, stale startup socket drain, repeated reconnect until READY, runtime reconnect status transitions, health-monitor restart policy, startup probe behavior, multi-account startup staggering, gateway outbound send limiting, heartbeat bypass, reconnect exhaustion, fatal close handling, heartbeat timer cleanup, and identify concurrency.
- Negative signals: The live lane proves startup-to-connected and message flow, but not a real Discord reconnect after socket drop, real heartbeat timeout recovery, live health-monitor restart of a Discord account, real `/gateway/bot` rate-limit fallback, or multi-account startup priority under Discord session-start limits. The live smoke covers REST identity and metadata only, not a WebSocket READY lifecycle. Runtime-flow evidence is strong, but much of it is synthetic rather than end-to-end against Discord's live gateway.
- Integration gaps: Add one canonical live Discord gateway lifecycle scenario that starts two accounts, asserts startup stagger/order, reaches READY, induces or simulates a socket close through the live harness, verifies reconnect/RESUMED or fresh READY, checks status timestamps and `lastDisconnect`, and verifies health-monitor restart behavior without relying on broad pnpm runs. Add a live metadata/rate-limit fallback proof for `/gateway/bot` and a live stuck-startup proof that `gatewayReadyTimeoutMs` produces an operator-visible status.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: Current open results for `Discord gateway` include #81107 for a Discord skill-command dedup loop causing CPU saturation and blocking gateway readiness, #83212 for Discord staying disabled without a plugin-entry warning, #87656 for named-account env SecretRef sends failing while provider startup succeeds, #77429 for multi-account startup needing default/main priority, #80344 for voice/gateway heartbeat timeout under event-loop starvation, #83366 for gateway event-loop starvation causing Discord/session timeouts, and #79794 for a Discord gateway READY regression. Broader rate-limit results include #87467 for an auto rate-limit fallback staying pinned after primary recovery. Closed `Discord gateway` results show recent fixed churn around READY never firing, cold-start readiness races, and reconnect max-attempt crashes.
- Discrawl reports: Discord archive results show live operator traces with Discord startup fetch timeouts, websocket close code 1000, liveness warnings during `channels.discord.start-account`, and `Gateway heartbeat ACK timeout`. Other threads repeat gateway request timeouts, handshake timeouts, status/probe timing out, duplicate replies tied to listener timeouts, 4014/disallowed-intents READY failures, and health-monitor restarts followed by startup application ID lookup and command deploy logs. Release chatter says channel/gateway startup and metadata reuse improved in recent betas, but the same archive still contains late-May requests to validate gateway/perf paths and user reports of intermittent timeout blockers.
- Good qualities: Source separates account resolution, provider startup, monitor client creation, gateway plugin construction, gateway lifecycle supervision, WebSocket transport, outbound send limiting, shared identify limiting, status observation, health policy, and channel manager lifecycle. It avoids duplicate same-token account monitors, fails fast on unavailable SecretRefs before provider startup, parses application IDs from tokens before REST fallback, falls back from transient gateway metadata failures, records startup phases, throttles transport activity status, treats disallowed intents as a stopping condition, buffers early gateway errors until lifecycle attaches, suppresses late teardown errors, deduplicates concurrent account starts, distinguishes manual stop from recovery restart, and caps health-monitor restarts.
- Bad qualities: The lifecycle is layered and subtle: Discord's own gateway reconnect loop, monitor-level READY supervision, channel manager auto-restart, and global health-monitor restart can all act on the same account. Several current reports show that event-loop starvation or startup work can still wedge readiness despite the lifecycle code. Startup depends on application ID and `/gateway/bot` metadata lookups unless config/token parsing succeeds, so rate limits and network stalls remain operator-visible. Multi-account startup order and named-account SecretRef parity still leak through into lifecycle behavior. Duplicate-reply troubleshooting also shows that the gateway listener timeout is easy to confuse with agent runtime lifetime.
- Excluded from quality: Unit tests, integration tests, live tests, runtime-flow test depth, test coverage, and absent tests were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Account monitor startup, Gateway WebSocket lifecycle, Reconnect and heartbeat handling, Rate limits and gateway metadata, Status, probe, and health-monitor recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a first-class live reconnect proof for Discord gateway READY, reconnect, RESUMED or fresh READY, status timestamps, and health-monitor restart.
- Prioritize or clearly surface `channels.discord.defaultAccount` during multi-account startup so the main account is not delayed behind secondary accounts.
- Make named-account token resolution identical for provider startup, message-tool sends, lookup/admin actions, probes, and status output.
- Convert event-loop starvation and long startup phases into clearer operator-facing status rather than a generic disconnected or READY timeout loop.
- Expose gateway metadata fallback and rate-limit state in status/doctor so operators can distinguish Discord API throttling from bot token, intent, or WebSocket readiness failures.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:96` documents secure token setup, `openclaw gateway`, service restart/env propagation, and the `applicationId` setting to skip rate-limited startup application lookup.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1550` documents long-running Discord turns or duplicate replies, names `channels.discord.eventQueue.listenerTimeout` and account-scoped overrides, and clarifies that this controls Discord gateway listener work, not agent turn lifetime.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1583` documents `/gateway/bot` metadata timeout warnings, fallback to Discord's default gateway URL, config/env timeout knobs, and the 30s default with 120s max.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1595` documents startup and runtime READY timeout knobs, env fallbacks, defaults, max values, and multi-account startup-stagger caveats.
- `/Users/kevinlin/code/openclaw/docs/gateway/health.md:36` documents channel health monitor interval, stale threshold, max restarts/hour, per-provider and per-account opt-outs, and states that Discord is covered.
- `/Users/kevinlin/code/openclaw/docs/cli/channels.md:40` documents `channels status --probe` as the live per-account probe/status path and warns that session rows are not socket-health signals.
- `/Users/kevinlin/code/openclaw/docs/cli/channels.md:64` documents that runtime-backed `channels remove` asks the running Gateway to stop the selected account before config updates.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:334` documents Discord token/default account behavior, voice reconnect knobs, streaming mode, and auto-presence mapping from runtime availability.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/accounts.ts:108` resolves enabled accounts from the selected runtime config, token source/status, and merged account config.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/accounts.ts:144` selects one owner for duplicate bot tokens, preferring configured tokens over env fallback, and disables duplicate-token runtime monitors.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.ts:222` computes startup stagger by enabled token-backed account order, and `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.ts:660` fails fast on unavailable SecretRefs, applies startup delay, starts the async probe, and calls `monitorDiscordProvider` with account-scoped runtime/status hooks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.ts:309` logs application ID startup phases and uses configured ID, token parsing, or REST fallback; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.ts:422` creates the monitor client/gateway supervisor; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.ts:598` hands control to `runDiscordGatewayLifecycle`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/probe.ts:177` parses application IDs from bot tokens and `/Users/kevinlin/code/openclaw/extensions/discord/src/probe.ts:205` falls back to `/oauth2/applications/@me`, preserving 429 rate-limit errors.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/gateway-plugin.ts:129` publishes the gateway client before metadata fetch, fetches `/gateway/bot` with timeout/fallback, avoids duplicate sockets, creates `ws` sockets with handshake timeout/proxy support, captures WebSocket activity, and emits transport activity.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.ts:22` defines READY timeout defaults/env vars; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.ts:324` waits for READY and reconnects with backoff on timeout; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.ts:406` registers the gateway, status observer, transport activity listener, and lifecycle error handling.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/gateway-supervisor.ts:72` classifies disallowed intents, reconnect exhaustion, fatal gateway errors, and non-fatal events; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/gateway-supervisor.ts:116` buffers early events and suppresses late teardown/dispose errors.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.ts:75` owns gateway WebSocket/session/resume/reconnect/heartbeat state; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.ts:177` handles socket message/close/error behavior; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.ts:296` restarts on missed heartbeat ACK; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.ts:379` marks READY/RESUMED connected; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.ts:408` reconnects with capped exponential backoff and max attempts.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway-rate-limit.ts:1` implements the 120 sends/60s outbound gateway window, queues noncritical sends, exposes remaining/reset/queued status, and flushes after reset.
- `/Users/kevinlin/code/openclaw/src/gateway/server-channels.ts:388` starts channel accounts through plugin hooks, deduplicates concurrent starts, reserves abort controllers before awaits, sets runtime status, hands off to `startAccount`, tracks exit/errors, and auto-restarts with backoff up to the channel restart cap.
- `/Users/kevinlin/code/openclaw/src/gateway/server-channels.ts:697` stops accounts through abort, plugin stop hooks, graceful wait, manual-stop tracking, and recovery-timeout handling.
- `/Users/kevinlin/code/openclaw/src/gateway/channel-health-monitor.ts:76` runs periodic single-flight health checks, skips disabled/manual accounts, applies cooldown and hourly caps, and restarts unhealthy accounts through stop/reset/start.
- `/Users/kevinlin/code/openclaw/src/gateway/server-runtime-startup-services.ts:25` starts the channel health monitor from gateway config unless disabled, and `/Users/kevinlin/code/openclaw/src/gateway/server.impl.ts:1548` starts channel/runtime services during gateway post-attach startup.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:289` defines live Discord scenarios for canary echo, mention gating, native command registration, voice auto-join, status reactions, and thread attachment reply.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:500` injects a live Discord config with enabled Discord channel, named account token, default account, guild/channel allowlists, and optional voice/status settings.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:1319` polls live gateway `channels.status` until the Discord account is running, connected, and not restart-pending, failing with last runtime status if it never connects.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:1630` starts the live lane gateway and `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:1664` gates all Discord live scenarios on the connected account.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/live-smoke.live.test.ts:11` uses a real `DISCORD_BOT_TOKEN` when `DISCORD_LIVE_TEST` is enabled to verify bot identity and `/gateway/bot` metadata.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/acp-bind-here.integration.test.ts:133` provides adjacent Discord runtime-flow evidence by binding a Discord DM conversation to an ACP session and asserting the next Discord turn routes to that bound session.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.test.ts:532` verifies the async startup probe does not block monitor startup and stale probe metadata is cleared on degraded/thrown probes.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.test.ts:646` verifies later multi-bot accounts are staggered by 10 seconds.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.test.ts:361` verifies startup READY timeout reconnects with backoff and then recovers; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.test.ts:396` verifies stale startup socket drain before reconnect; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.test.ts:431` verifies repeated READY retries.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.test.ts:478` verifies queued non-fatal and fatal startup gateway errors; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.test.ts:669` verifies runtime reconnect status when READY returns; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.lifecycle.test.ts:698` verifies force-stop when runtime reconnect opens but never reaches READY.
- `/Users/kevinlin/code/openclaw/src/gateway/channel-health-monitor.test.ts:308` verifies disconnected channel restart, busy active-run skip, stale busy restart, startup grace, stopped/gave-up restart, cooldown, and max restarts/hour behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.test.ts:296` verifies outbound gateway event queueing when the 120-send window is exhausted and critical heartbeat bypass; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.test.ts:484` verifies reconnect exhaustion/fatal close behavior; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.test.ts:525` verifies heartbeat timer cleanup; `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/gateway.test.ts:593` verifies identify concurrency spacing.

### Gitcrawl queries

Query:

```text
gitcrawl doctor --json
```

Results:

- Succeeded; recorded freshness: version=0.2.1, last_sync_at=2026-05-28T19:09:52.784704Z, thread_count=29810, open_thread_count=11181, cluster_count=18594, repository_count=2.

Query:

```text
gitcrawl search issues "Discord gateway" -R openclaw/openclaw --state open --json number,title,url,state --limit 10
```

Results:

- Returned open gateway/lifecycle-relevant issues #81107, #83212, #87656, #77429, #80344, #83366, #79794, and #29725. The strongest direct signals were readiness blocking, gateway heartbeat timeout, event-loop starvation, READY never firing, multi-account startup priority, and provider startup succeeding while named-account sends fail.

Query:

```text
gitcrawl search issues "Discord gateway" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10
```

Results:

- Returned closed churn around READY never firing, cold-start readiness races, maxReconnectAttempts crashes, WebSocket close 1005 race conditions, and single-account startup hangs: #74617, #55569, #56472, #56732, #57195, #59927, #57075, #56492, and #61703.

Query:

```text
gitcrawl search issues "Discord rate limit" -R openclaw/openclaw --state open --json number,title,url,state --limit 10
```

Results:

- Returned #87467, an open report that auto rate-limit fallback remains pinned after primary recovery, plus adjacent rate-limit and message-drop observability reports.

Query:

```text
gitcrawl search issues "Discord applicationId" -R openclaw/openclaw --state all --json number,title,url,state --limit 10
```

Results:

- Returned #77359 and #79445, showing that application ID and account identity issues still appear in multi-account command registration and send/read divergence reports.

Query:

```text
gitcrawl search issues "Discord gateway READY timeout reconnect application id startup" -R openclaw/openclaw --state open --json number,title,url,state --limit 10
gitcrawl search issues "Discord gateway monitor reconnect rate limit /gateway/bot" -R openclaw/openclaw --state open --json number,title,url,state --limit 10
gitcrawl search issues "Discord duplicate bot token multiple accounts gateway monitor" -R openclaw/openclaw --state open --json number,title,url,state --limit 10
gitcrawl search issues "Discord eventQueue listenerTimeout duplicate replies" -R openclaw/openclaw --state all --json number,title,url,state --limit 10
```

Results:

- The first three specific open queries returned no direct hits, which is useful negative evidence after the broader `Discord gateway` query returned relevant issues. The duplicate-reply query also returned no direct gitcrawl hits, so duplicate-reply evidence came from docs and Discrawl instead.

### Discrawl queries

Query:

```text
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord gateway READY timeout"
```

Results:

- Returned a 2026-05-16 live operator trace with Discord startup fetch timeout, gateway WebSocket close 1000, liveness warning during `channels.discord.start-account`, and `Gateway heartbeat ACK timeout`. Also returned release/test chatter that Discord reconnect identify fixes and gateway/perf paths were active beta focus areas.

Query:

```text
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord gateway metadata"
```

Results:

- Returned late-May release/maintainer messages about a Discord metadata leak closure and Gateway metadata cache/hot-path reuse. Also returned release guidance asking beta testers to exercise gateway/perf paths including status, auth/env snapshots, plugin metadata, session reads, and stable metadata caches.

Query:

```text
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord rate limited application lookup"
```

Results:

- Returned no direct hits. Given successful freshness checks, this is treated as neutral for the component; docs/source still show explicit application lookup and metadata rate-limit mitigations.

Query:

```text
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord duplicate replies listenerTimeout"
```

Results:

- Returned support guidance tying duplicate replies and stalled Discord handlers to `channels.discord.eventQueue.listenerTimeout` and `channels.discord.inboundWorker.runTimeoutMs`, including repeated multi-account account-scoped config examples and docs links. These results support a quality gap around operator confusion, not a Coverage score input.

Query:

```text
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord disallowed intents Message Content Intent"
```

Results:

- Returned multiple support threads explaining that 4014/disallowed intents and missing Message Content Intent can make the gateway connect at the TCP/WebSocket layer but never reach READY or process inbound messages, plus checklists to enable intents and restart the gateway.

Query:

```text
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord multiple bots same token"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord applicationId"
```

Results:

- Multi-bot results showed repeated operator discussion about separate Discord bot accounts, account IDs, bindings, shared channels, and avoiding both bots responding. Application ID results included PR review/commentary around disconnecting the gateway before missing-ID startup throws and live logs where startup resolved `applicationId`, deployed commands, fetched bot identity, and then later hit gateway/handshake timing issues.
