---
version: 3
---

# Gateway Runtime WebSocket Feature Matrix - Health, diagnostics, and repair

## Summary

Observability, health, and repair is broad and mostly implemented: Gateway exposes health/status snapshots, HTTP liveness/readiness probes, WebSocket read probes, channel readiness probing, `logs.tail`, `openclaw logs --follow`, stability diagnostics, diagnostics export, chat-triggered diagnostics, and a large `doctor` repair/check surface. Coverage is **Partial** because real Gateway/server flow evidence exists for health/readiness and WebSocket probe behavior, but diagnostics export, stability recorder persistence, log-follow recovery, and most doctor repair loops are covered mainly by unit/command-level tests rather than live Gateway or supervised repair scenarios.

Quality is **Medium** because privacy/redaction and bounded diagnostic design are strong, but archive searches show recurring health/status mismatches, doctor false negatives/false warnings, diagnostics regressions, log-follow reliability bugs, and operator expectation gaps around doctor repair depth.

## Features

- Health snapshots: `health` and `status` snapshots.
- Channel readiness: Channel readiness probing through the running Gateway.
- Stability diagnostics: Stability recorder output.
- Payload diagnostics: `payload.large` diagnostics.
- Diagnostics exports: Diagnostics export contents, privacy model, and CLI/chat triggers.
- Doctor checks: Doctor checks for UI protocol freshness, service drift, auth/pairing drift, port collisions, sandbox/runtime best practices, and source-install issues.
- Log tailing: Log tailing and operational signal visibility.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: **68**

Label: **Partial**

Positive signals:

- Gateway docs expose an operator health baseline with `openclaw gateway status`, `openclaw status`, and `openclaw logs --follow`, plus `gateway status --require-rpc` for read-scope RPC proof in `docs/gateway/index.md:40`.
- Channel readiness probing is documented as live per-account probing when Gateway is reachable, with config-only fallback when it is not, in `docs/gateway/index.md:52`.
- Operational liveness/readiness/gap recovery expectations are documented around WebSocket connect/`hello-ok`, `gateway status`, `channels status --probe`, `health`, and `system-presence` in `docs/gateway/index.md:331`.
- Diagnostics export docs describe sanitized status, health, logs, config shape, and payload-free stability events, plus explicit chat approval and private group-chat routing, in `docs/gateway/diagnostics.md:10` and `docs/gateway/diagnostics.md:36`.
- Doctor docs enumerate UI protocol freshness, health restart prompts, sandbox repair, service drift, channel status warnings, auth/pairing drift, runtime best-practice checks, port diagnostics, and source-install checks in `docs/gateway/doctor.md:131` and `docs/gateway/doctor.md:525`.
- Core Gateway RPC handlers expose `health`, `status`, `channels.status`, `logs.tail`, and `diagnostics.stability` through the WebSocket method table in `src/gateway/server-methods.ts:248`.
- Real Gateway/server flow evidence exists for HTTP probe endpoints and pre-stage liveness/readiness in `src/gateway/server-http.probe.test.ts:36`, `src/gateway/server-http.probe.test.ts:246`, and `src/gateway/server-http.probe.test.ts:289`.
- Real Gateway/server flow evidence exists for authenticated WebSocket probe behavior, non-mutating first-time probes, and cached-device detail probes returning health/status/config snapshots in `src/gateway/probe.auth.integration.test.ts:71`.

Negative signals:

- Diagnostics export has strong unit coverage and docs, but no live chat-to-approval-to-export E2E proof was found for a real Gateway/channel conversation.
- Stability recorder coverage is synthetic in `src/gateway/gateway-stability.test.ts:31`; no live Gateway load/fatal-exit/persisted bundle scenario was found.
- Doctor has broad docs and many focused tests, but the repair loops for UI protocol freshness, service drift, auth/pairing drift, port collision recovery, source-install issues, and sandbox/runtime best practices are not covered as one real Gateway or supervised repair workflow.
- `openclaw logs --follow` has command-level tests and historical fixes, but no live transient Gateway disconnect/reconnect proof was found in the current evidence.

Integration gaps:

- No end-to-end `/diagnostics` chat flow proof through Telegram/Discord/other channel, exec approval, CLI export, private group route, and final report.
- No live diagnostics export proof against a real unhealthy Gateway where status/health fail but local logs/config/stability are still collected.
- No live stability-recorder proof for actual Gateway session churn, `payload.large`, fatal-exit bundle persistence, and `gateway stability --bundle latest`.
- No live doctor repair proof that starts from stale service/config/auth/pairing/port/UI/source-install state and verifies repaired Gateway behavior afterward.
- No real `logs --follow` reconnect proof against a running Gateway that is briefly stopped/restarted.

## Quality

Score: **62**

Label: **Medium**

### gitcrawl reports

- Query `gitcrawl search openclaw/openclaw --query "gateway diagnostics" --mode keyword --limit 10 --json` returned 10 hits, including closed PR #70324 "Improve gateway diagnostics export for support reports", open issue #72883 "gateway config.patch blocks diagnostics.cacheTrace.\* even with content capture disabled", closed diagnostics OpenTelemetry/Prometheus regressions #18794, #3201, #4317, #77206, #77390, PR #75928 for diagnostics cron/run support, and PRs #74560/#74561 around diagnostics flag contract regressions.
- Query `gitcrawl search openclaw/openclaw --query "gateway doctor" --mode keyword --limit 10 --json` returned 10 hits: open PR #84340 "Doctor: expose extra gateway service findings"; closed PRs #69947, #69896, #53197; open PR #84224 "fix(doctor): handle gateway SecretRefs in auth checks"; closed PR #80055 "Doctor: add health-check contract and --lint validation"; open PRs #62338, #83715, #86627; closed docs PR #77613.
- Query `gitcrawl search openclaw/openclaw --query "gateway health status" --mode keyword --limit 10 --json` returned 10 hits: closed issue #13602, closed PRs #36422, #80277, #57374, closed issues #71974, #49758, #27619, #59287, #59511, and open issue #42538 "Bug: health endpoint returns incorrect running=false for WhatsApp".
- Query `gitcrawl search openclaw/openclaw --query "payload.large stability diagnostics" --mode keyword --limit 10 --json` returned 6 hits: closed PRs #70324, #82674, #82937, open PRs #86160 and #81402, and closed issue #83795.
- Query `gitcrawl search openclaw/openclaw --query "gateway port collision doctor service drift" --mode keyword --limit 10 --json` returned 1 hit: closed PR #84475 "fix(gateway): include openclaw bin in service PATH".
- Query `gitcrawl search openclaw/openclaw --query "openclaw logs follow gateway" --mode keyword --limit 10 --json` returned 10 hits: closed PRs #45140, #75059, #56475, #75372 and closed issues #74782, #66841, #74583, #83656, #32986, #45080.

### discrawl reports

- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway diagnostics"` returned 10 hits, led by the 2026-05-27 maintainer report saying quality/diagnostics work covered doctor restart follow-ups, stale session lock retry reporting, transcript persistence, temp directory cleanup guidance, and Telegram preview coverage, plus a 2026-05-25 clawtributor report that Gateway health refreshes/heartbeat/cron work could interfere with active reply runs and an opt-in profiler can be enabled with `OPENCLAW_DIAGNOSTICS=profiler openclaw gateway run`.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway doctor"` returned 10 hits, including a 2026-05-27 bug report that an unsupported dynamic tool schema crashed an assistant turn while `openclaw doctor` did not catch the fatal schema issue, a 2026-05-26 report that a slow Gateway was not helped by doctor, and a PR #84224 report about false SecretRef warnings in doctor/lint.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway health status"` returned 10 hits, including 2026-05-25 maintainer notes on Gateway health/lifecycle probes, 2026-05-21 user commands for `gateway stop`, `gateway restart`, and `gateway status --deep`, a 2026-05-16 real health check `200 {"ok":true,"status":"live"}`, 2026-05-12 slow CLI command complaints, and 2026-05-11 upgrade/restart/probe weirdness.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "payload.large stability diagnostics"` returned 0 hits.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "logs --follow gateway"` returned 10 hits, including a 2026-05-25 Slack Socket Mode report where `openclaw logs --follow` showed no inbound message events despite apparent connectivity, and beta release notes asking testers to provide log snippets for Gateway/channel regressions.

### Good qualities

- Health/status are unified behind Gateway RPC and reuse cached health with runtime-drift checks, probe mode, admin-sensitive fields, and event-loop health in `src/gateway/server-methods/health.ts:99`.
- Gateway probes are non-mutating until a cached operator device token exists, use read-scope CLI identity, and fetch health/status/presence/config snapshots after `hello-ok` in `src/gateway/probe.ts:223` and `src/gateway/probe.ts:356`.
- Channel readiness probing runs plugin `probeAccount` and `auditAccount` hooks only when requested and configured, with timeout/warning plumbing in `src/gateway/server-methods/channels.ts:285`.
- Stability records are intentionally payload-free operational facts with bounded capacity, summaries for memory and `payload.large`, and redacted session identifiers in `src/logging/diagnostic-stability.ts:14`, `src/logging/diagnostic-stability.ts:509`, and `src/logging/diagnostic-stability.ts:569`.
- Diagnostics export builds a manifest with `payloadFree: true` and `rawLogsIncluded: false`, includes sanitized config/log/status/health/stability files, and records privacy notes in `src/logging/diagnostic-support-export.ts:58` and `src/logging/diagnostic-support-export.ts:548`.
- Redaction is explicit for secrets, payload fields, identifiers, private config fields, path prefixes, unsafe log messages, and unsafe log fields in `src/logging/diagnostic-support-redaction.ts:8` and `src/logging/diagnostic-support-log-redaction.ts:8`.
- `openclaw logs --follow` retries transient transport errors, avoids looping on auth/policy/pairing failures, emits reconnect notices, and supports JSON notice parity in `src/cli/logs-cli.ts:323` and `src/cli/logs-cli.ts:526`.
- Doctor is intentionally broad and has guardrails for service drift, live systemd units, external supervisor ownership, UI protocol freshness, sandbox Docker images, port diagnostics, and runtime path best practices (`src/commands/doctor-gateway-services.ts:528`, `src/commands/doctor-ui.ts:13`, `src/commands/doctor-sandbox.ts:279`, `src/daemon/service-audit.ts:47`).

### Bad qualities

- The archive shows repeated regressions in health/status correctness for channel runtime state, especially WhatsApp and Telegram (`gitcrawl` #71974, #42538, #59287).
- Doctor is still not a complete runtime-readiness oracle: Discord reports show it missed fatal active tool-schema projection failures and did not help a slow/unresponsive Gateway case.
- Several doctor improvements are still open or recently active: extra gateway service findings (#84340), SecretRef-aware gateway auth checks (#84224), newer-config repair guardrails (#83715), FTS5 health surfacing (#62338), and doctor finding ordering (#86627).
- Diagnostics and log-follow have historically produced multiple regressions around config flags, bundled diagnostics plugins, OpenTelemetry/Prometheus, transient disconnects, stale file logs, and unintended paired-device mutation.

## Known gaps

- Implemented capabilities in scope include health/status Gateway RPC snapshots, shallow HTTP liveness/readiness probes, WebSocket read probes, channel readiness probing, `diagnostics.stability`, payload-free stability recording, diagnostics export, chat-triggered diagnostics, `doctor` checks/repairs, `logs.tail`, and `openclaw logs --follow`.
- Coverage gaps remain for live diagnostics export, real chat `/diagnostics` approval/export/private-route flow, live stability-recorder load and fatal-exit bundle persistence, supervised doctor repair workflows, and live `logs --follow` reconnect behavior.
- Documented-but-missing and operational gaps include active tool-schema validation in doctor, SecretRef-aware gateway auth checks, extra gateway service findings, and better debugging paths when Gateway is slow or unresponsive.
- Source/docs mismatch evidence is limited to archive-backed runtime correctness reports, especially health/status disagreement for channel state such as the open WhatsApp health issue #42538.
- User and maintainer expectation gaps are represented by GitHub #84340, GitHub #84224, Discord reports about tool-schema doctor misses and slow Gateway diagnosis, and historical `logs --follow` reliability requests.

## Evidence

### Docs

- `docs/gateway/index.md:40`: health verification command set and healthy baseline.
- `docs/gateway/index.md:52`: live channel readiness probing through reachable Gateway.
- `docs/gateway/index.md:111`: port/bind precedence and `doctor --fix` or `gateway install --force` after port changes.
- `docs/gateway/index.md:135`: operator commands include status, deep status, logs, and doctor.
- `docs/gateway/index.md:152`: multiple-gateway detection via status/deep and probe.
- `docs/gateway/index.md:331`: liveness/readiness/gap recovery expectations.
- `docs/gateway/index.md:350`: common failure signatures include port conflict and auth mismatch.
- `docs/gateway/diagnostics.md:10`: export combines sanitized status, health, logs, config shape, and payload-free stability events.
- `docs/gateway/diagnostics.md:36`: `/diagnostics` chat command, explicit exec approval, private group route, and fail-closed behavior.
- `docs/gateway/diagnostics.md:75`: export contents and unhealthy-Gateway fallback collection.
- `docs/gateway/diagnostics.md:92`: privacy model for included operational data and omitted/redacted content.
- `docs/gateway/diagnostics.md:112`: stability recorder, liveness warnings, `payload.large`, bundle inspection, and export.
- `docs/gateway/diagnostics.md:176`: diagnostics enabled by default, memory pressure snapshots opt-in.
- `docs/gateway/doctor.md:10`: doctor fixes stale config/state, checks health, and provides repair steps.
- `docs/gateway/doctor.md:18`: headless/automation modes for `--yes`, `--fix`, `--lint`, `--fix --force`, `--non-interactive`, and `--deep`.
- `docs/gateway/doctor.md:131`: summary of health/UI/update, gateway/services/supervisors, auth/security/pairing, and workspace/source checks.
- `docs/gateway/doctor.md:438`: device pairing and auth drift reporting.
- `docs/gateway/doctor.md:493`: local gateway token auth and SecretRef behavior.
- `docs/gateway/doctor.md:509`: Gateway health check and restart prompt.
- `docs/gateway/doctor.md:525`: channel status warnings and supervisor config repair.
- `docs/gateway/doctor.md:549`: runtime/port diagnostics and runtime best practices.
- `docs/cli/gateway.md:225`: CLI diagnostics export command surface.

### Source

- `src/gateway/server-methods.ts:223`: `health` bypasses method-scope authorization after connection auth.
- `src/gateway/server-methods.ts:248`: core handlers register `logs.tail`, `health`, `status`, `channels.status`, and `diagnostics.stability`.
- `src/gateway/server-methods/health.ts:99`: health/status handler implementation.
- `src/gateway/server-methods/channels.ts:285`: `channels.status` validates probe params, resolves runtime/config, and runs probe/audit hooks.
- `src/gateway/probe.ts:43`: `GatewayProbeResult` includes auth, health, status, presence, and config snapshot.
- `src/gateway/probe.ts:223`: `probeGateway` entrypoint and non-mutating device identity policy.
- `src/gateway/probe.ts:356`: probe client uses read scope and fetches health/status/presence/config details after connect.
- `src/gateway/server-methods/logs.ts:10`: `logs.tail` RPC validates params and reads configured log tail.
- `src/logging/log-tail.ts:26`: rolling log resolution and fallback to newest rolling log.
- `src/logging/log-tail.ts:150`: configured log tail clamps limits and redacts sensitive lines.
- `src/cli/logs-cli.ts:96`: `openclaw logs` fetches logs through Gateway RPC, systemd journal fallback, or local file fallback.
- `src/cli/logs-cli.ts:323`: transient follow retry classification.
- `src/cli/logs-cli.ts:477`: `openclaw logs --follow --json` CLI registration.
- `src/cli/logs-cli.ts:526`: reconnect notices and JSON output for follow mode.
- `src/logging/diagnostic.ts:1158`: diagnostic heartbeat starts stability recorder and liveness sampler.
- `src/logging/diagnostic-stability.ts:14`: payload-free stability event shape.
- `src/logging/diagnostic-stability.ts:196`: diagnostic events are sanitized before recording.
- `src/logging/diagnostic-stability.ts:509`: `payload.large` records surface/action/bytes/limit/count/channel/plugin/reason.
- `src/logging/diagnostic-stability.ts:544`: bounded ring buffer drop behavior.
- `src/logging/diagnostic-stability.ts:569`: memory and `payload.large` summaries.
- `src/logging/diagnostic-stability.ts:702`: recorder subscription and snapshot API.
- `src/logging/diagnostic-support-export.ts:58`: manifest privacy fields.
- `src/logging/diagnostic-support-export.ts:315`: sanitized status/health snapshot collection.
- `src/logging/diagnostic-support-export.ts:367`: sanitized log tail.
- `src/logging/diagnostic-support-export.ts:446`: summary privacy and contents.
- `src/logging/diagnostic-support-export.ts:548`: diagnostics export artifact assembly.
- `src/logging/diagnostic-support-redaction.ts:8`: redaction regexes for secret, payload, identifier, and private config fields.
- `src/logging/diagnostic-support-redaction.ts:195`: state dir and home path redaction prefixes.
- `src/logging/diagnostic-support-log-redaction.ts:8`: safe and omitted log field policy.
- `src/logging/diagnostic-support-log-redaction.ts:130`: unsafe log message omission metadata.
- `src/cli/gateway-cli/register.ts:563`: `openclaw gateway stability` and `--export` wiring.
- `src/cli/gateway-cli/register.ts:645`: `openclaw gateway diagnostics export` wiring.
- `src/auto-reply/reply/commands-diagnostics.ts:23`: `/diagnostics` command constants, docs URL, and private-route messages.
- `src/auto-reply/reply/commands-diagnostics.ts:73`: authorization, group-private routing, and diagnostics command dispatch.
- `src/auto-reply/reply/commands-diagnostics.ts:550`: diagnostics exec result formatting.
- `src/commands/doctor-ui.ts:13`: Control UI protocol freshness repair.
- `src/commands/doctor-gateway-daemon-flow.ts:222`: port diagnostics and recent gateway error reporting.
- `src/commands/doctor-gateway-services.ts:528`: service drift repair guardrails.
- `src/commands/doctor-sandbox.ts:279`: sandbox Docker/backend/image checks.
- `src/daemon/service-audit.ts:47`: service audit issue codes include path, token, port, proxy env, runtime, and supervisor drift.

### Integration tests

- `src/gateway/server-http.probe.test.ts:36`: `/ready` returns detailed readiness for local requests.
- `src/gateway/server-http.probe.test.ts:59`: unauthenticated remote readiness returns only readiness state.
- `src/gateway/server-http.probe.test.ts:246`: `/healthz` stays shallow even when readiness reports failing channels.
- `src/gateway/server-http.probe.test.ts:268`: `/healthz` works before Gateway config loading.
- `src/gateway/server-http.probe.test.ts:289`: probes are served before stalled request stages.
- `src/gateway/probe.auth.integration.test.ts:71`: direct local authenticated status RPC remains device-bound.
- `src/gateway/probe.auth.integration.test.ts:87`: first-time local authenticated probes are non-mutating and do not create pairing/device-auth files.
- `src/gateway/probe.auth.integration.test.ts:108`: cached device auth enables detailed probe RPCs for health/status/config.
- `src/agents/bash-tools.exec-host-gateway.test.ts:627`: diagnostics approval follow-up uses `openclaw gateway diagnostics export --json` with direct follow-up delivery.
- `test/openclaw-launcher.e2e.test.ts:539`: source-install recovery message for unbuilt source trees.

### Unit tests

- `src/gateway/gateway-stability.test.ts:31`: synthetic Gateway stability load emits message/session/memory/`payload.large` events.
- `src/gateway/gateway-stability.test.ts:110`: recorder capacity, drops, memory summary, `payload.large` summary, and absence of session identifiers.
- `src/logging/diagnostic-support-export.test.ts:54`: diagnostics export fixture includes fake secrets, private chat, webhook body, and `payload.large`.
- `src/logging/diagnostic-support-export.test.ts:238`: expected export entries include config, diagnostics, health, logs, manifest, stability, status, and summary.
- `src/logging/diagnostic-support-export.test.ts:251`: export omits tokens, private chat, webhook bodies, account/message identifiers, hostnames, cookies, AWS keys, JWTs, and session identifiers while preserving `payload.large`.
- `src/logging/diagnostic-support-export.test.ts:278`: sanitized logs omit session ids/keys and unsafe payload text while keeping safe operational fields.
- `src/logging/diagnostic-support-export.test.ts:315`: status, health, and config snapshots are redacted.
- `src/cli/logs-cli.test.ts:173`: implicit loopback log reads use passive Gateway client/backend identity.
- `src/cli/logs-cli.test.ts:207`: explicit Gateway URLs use the normal CLI client identity.
- `src/auto-reply/reply/commands-diagnostics.test.ts:285`: `/diagnostics` queues Gateway diagnostics approval with allowlist security, always-ask approval, direct follow-up, warning text, and docs link.
- `src/auto-reply/reply/commands-diagnostics.test.ts:315`: native Telegram route is preserved for diagnostics follow-ups.
- `src/auto-reply/reply/commands-diagnostics.test.ts:353`: approval-unavailable diagnostics falls back to visible sensitive-warning reply.
- `src/auto-reply/reply/commands-diagnostics.test.ts:543`: group diagnostics fails closed when no private owner route exists.
- `src/auto-reply/reply/commands-diagnostics.test.ts:567`: group diagnostics confirmations route privately.
- `src/auto-reply/reply/commands-diagnostics.test.ts:604`: diagnostics requires an owner.
- `src/commands/doctor-gateway-daemon-flow.test.ts:327`: normal doctor skips port connection inspection; deep doctor reports established Gateway clients.
- `src/commands/doctor-gateway-daemon-flow.test.ts:401`: expected Gateway listeners suppress busy-port notes, unexpected listeners keep them.
- `src/commands/doctor-gateway-daemon-flow.test.ts:555`: recent restart handoff skips restart prompt only when health succeeds and prompts when health probe fails.

### gitcrawl queries

- `gitcrawl search openclaw/openclaw --query "gateway diagnostics" --mode keyword --limit 10 --json`
  - Result: 10 hits; notable exact hits included #70324 closed PR "Improve gateway diagnostics export for support reports", #72883 open issue "gateway config.patch blocks diagnostics.cacheTrace.\* even with content capture disabled", #76628 closed issue, #77206 closed issue, #18794 closed issue, #3201 closed issue, #4317 closed issue, #75928 closed PR, #77390 closed issue, #74560/#74561 closed PRs.
- `gitcrawl search openclaw/openclaw --query "gateway doctor" --mode keyword --limit 10 --json`
  - Result: #84340 open PR "Doctor: expose extra gateway service findings"; #69947 closed PR "fix: quiet noninteractive doctor checks"; #69896 closed PR "Fix doctor bundled runtime dependency ordering"; #53197 closed PR "fix(doctor): honor --fix in non-interactive mode"; #84224 open PR "fix(doctor): handle gateway SecretRefs in auth checks"; #80055 closed PR "Doctor: add health-check contract and --lint validation"; #62338 open PR "doctor(memory): surface FTS5 unavailable state in doctor checks"; #83715 open PR "[codex] Guard doctor repairs for newer configs"; #86627 open PR "Keep core doctor health in contribution order"; #77613 closed PR "docs(doctor): clarify configured plugin repair".
- `gitcrawl search openclaw/openclaw --query "gateway health status" --mode keyword --limit 10 --json`
  - Result: #13602 closed issue "Add /health endpoint for AWS ALB and Kubernetes probes"; #36422 closed PR "gateway: keep health channel runtime state consistent with channels.status"; #80277 closed PR "fix(status): surface model-pricing health degradation"; #71974 closed issue "Bug: WhatsApp channel health JSON reports running=false/connected=false while status --deep shows OK/LINKED"; #49758 closed issue "Bug: `status` / `gateway probe` / `health --json` misreport local gateway + Telegram state on 2026.3.13"; #57374 closed PR "fix(gateway): use configured probe auth during restart health checks"; #27619 closed issue "Dashboard API: System health endpoint returns hardcoded mock data"; #42538 open issue "Bug: health endpoint returns incorrect running=false for WhatsApp"; #59287 closed issue "[Bug]: openclaw health --json reports telegram.running=false while probe succeeds and status --deep shows Telegram OK"; #59511 closed issue "[Bug]: node openclaw.mjs gateway run can not use `http://127.0.0.1:18789/health` link to get openclaw status".
- `gitcrawl search openclaw/openclaw --query "payload.large stability diagnostics" --mode keyword --limit 10 --json`
  - Result: #70324 closed PR "Improve gateway diagnostics export for support reports"; #82674 closed PR "fix(gateway): capture opt-in memory pressure snapshots"; #82937 closed PR "fix: yield diagnostic event drains"; #86160 open PR "fix(codex): preserve semantic native threads across compaction"; #83795 closed issue "[Feature]: OpenClaw trace emission should include captureContent"; #81402 open PR "refactor: move runtime state to SQLite".
- `gitcrawl search openclaw/openclaw --query "gateway port collision doctor service drift" --mode keyword --limit 10 --json`
  - Result: #84475 closed PR "fix(gateway): include openclaw bin in service PATH".
- `gitcrawl search openclaw/openclaw --query "openclaw logs follow gateway" --mode keyword --limit 10 --json`
  - Result: #45140 closed PR "fix(cli): retry logs --follow on transient gateway connect (#45080)"; #75059 closed PR "fix(cli): auto-reconnect logs --follow on transient gateway disconnect #74782"; #74782 closed issue "Feature: `openclaw logs --follow` should auto-reconnect instead of exiting on transient gateway disconnect"; #66841 closed issue "openclaw logs --follow can show stale/misleading old-version file logs after side-by-side cutover"; #74583 closed issue "[Bug]: openclaw logs --follow keeps disconnecting, making live log monitoring unusable"; #83656 closed issue "openclaw logs --follow registers as paired device, rewrites paired.json"; #56475 closed PR "fix(cli): reuse websocket for `logs --follow`"; #75372 closed PR "feat(cli/logs): announce --follow gateway reconnect and add JSON notice parity"; #32986 closed issue "Bug: `openclaw logs --follow` triggers Feishu /open-apis/bot/v3/info probe every second via post-connect health refresh"; #45080 closed issue "openclaw logs --follow偶发连接失败：handshake timeout".

### discrawl queries

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway diagnostics"`
  - Result: 10 hits. Notable hits: `[maintainers] 2026-05-27T18:46:50Z` maintainer report citing quality/diagnostics work around doctor restart follow-ups, stale session lock retry reporting, transcript persistence, temp directory cleanup guidance, and Telegram preview coverage; `[clawtributors] 2026-05-25T09:21:53Z` live Telegram/OpenClaw performance PR report saying Gateway health refreshes and heartbeat/cron work could interfere with active reply runs and opt-in profiler uses `OPENCLAW_DIAGNOSTICS=profiler openclaw gateway run`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway doctor"`
  - Result: 10 hits. Notable hits: `[clawtributors] 2026-05-27T00:54:44Z` bug report that unsupported dynamic tool schema crashed assistant turn before content and doctor did not catch it; `[clawtributors] 2026-05-26T07:31:00Z` PR #84224 report about false `openclaw doctor` / `doctor --lint` warning for resolved gateway token SecretRefs; `[general] 2026-05-26T06:55:31Z` user report that after updating to 2026.5.22 the Gateway loaded extremely slowly and doctor did not help.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway health status"`
  - Result: 10 hits. Notable hits: `[maintainers] 2026-05-25T18:16:12Z` maintainer report citing Gateway health, lifecycle probes, RSS sampling, startup/restart behavior; `[general] 2026-05-21T17:29:38Z` commands `openclaw gateway stop`, `openclaw gateway restart`, `openclaw gateway status --deep`; `[Vincent <> Molty - The Crustacean Kabal] 2026-05-16T08:48:24Z` launchd PID state running and health check `200 {"ok":true,"status":"live"}`; `[clawtributors] 2026-05-12T15:56:50Z` slow `gateway status` / `plugins list` command complaint; `[clawtributors] 2026-05-11T13:58:08Z` upgrade/restart/probe weirdness.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "payload.large stability diagnostics"`
  - Result: 0 hits.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "logs --follow gateway"`
  - Result: 10 hits. Notable hits: `[users-helping-users] 2026-05-25T14:12:20Z` Slack Socket Mode report where Gateway connects and outbound works but no inbound events appear and `openclaw logs --follow` shows no incoming message events; `[maintainers/general/clawtributors] 2026-05-25T06:34Z` beta release note asks testers to provide OS, install method, version, command/action, and relevant log snippet for regressions.
