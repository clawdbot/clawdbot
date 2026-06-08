---
title: "Android app - Connection Setup Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Connection Setup Maturity Note

## Summary

Android pairing and Gateway security have substantial implementation depth: setup-code/manual flows, mDNS and wide-area DNS-SD discovery, secure endpoint validation, device-token persistence, TLS fingerprint handling, node and operator roles, and reconnect policy. Coverage is Alpha near Beta because source and unit tests are strong but live Android pairing proof is preconditioned rather than turnkey. Quality remains Alpha because archive evidence shows repeated operator confusion around auth, LAN addressing, protocol/version skew, and manual `ws://` parsing.

## Category Scope

Included in this category:

- Gateway discovery: Gateway discovery, setup-code and manual endpoint parsing, WS/WSS connection setup, TLS trust decisions, device identity, stored device tokens, node/operator auth, and connection error handling

## Features

- Gateway discovery: Gateway discovery, setup-code and manual endpoint parsing, WS/WSS connection setup, TLS trust decisions, device identity, stored device tokens, node/operator auth, and connection error handling

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: Docs describe mDNS, setup-code/manual connection, secure remote endpoint rules, Tailscale Serve guidance, pairing approval commands, auto-reconnect, and node status checks. Unit tests cover endpoint parsing, auth payloads, token storage, TLS probe cleanup, reconnect, and setup flow logic.
- Negative signals: The main live Android capability suite assumes the app is already installed, reachable, paired, approved, and foregrounded. No clean first-run Android connect-to-approval live scenario was found.
- Integration gaps: Need a single live scenario that starts a fresh Gateway, connects Android by setup code and manual URL, exercises TLS trust/cleartext policy, approves pairing, verifies node/operator sessions, and records reconnection after auth failure.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: `Android pairing websocket TLS manual LAN setup protocol mismatch` found issue #87216 for manual LAN setup parsing `ws://` as host `ws`. Broader `Android app` search also surfaced #85966 for silent WebSocket close after node pairing and #78807 for private LAN pairing auth.
- Discrawl reports: Search found a March 7 GitHub mirror comment on #16638 where Android pairing with `gateway.auth.token` still hit `device signature invalid`, plus a February support thread walking a user through LAN IP, reachability, and auth/pairing diagnosis.
- Good qualities: The endpoint parser blocks insecure remote `ws://` while permitting loopback, emulator bridge, and private LAN hosts; stored device tokens are scoped by device and role; discovery TXT hints are not treated as authoritative TLS pins; node and operator roles are separated.
- Bad qualities: The user-facing failure surface is still easy to hit: wrong LAN host, token auth, stale protocol, TLS trust, and pairing retry states can all look like generic connection failure.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway discovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a scripted first-run pairing smoke for setup code, manual LAN, and remote WSS.
- Improve operator copy around pairing/auth versus wrong address versus TLS trust.
- Keep Play Store version skew visible in pairing errors so old clients fail with an actionable upgrade message.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` documents the Android to Gateway WebSocket path, device pairing role, secure endpoint rules, setup-code/manual modes, pairing approval, auto-reconnect, and status verification.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` documents USB-only gateway testing with `adb reverse` and Connect/Pair steps.
- `/Users/kevinlin/code/openclaw/docs/gateway/bonjour.md` is linked from the Android runbook for discovery debugging.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayDiscovery.kt` implements local NSD/mDNS plus optional wide-area DNS-SD discovery.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/GatewayConfigResolver.kt` decodes setup codes, parses manual endpoints, and enforces secure remote URL rules.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt` manages WebSocket connect, node/operator auth sources, RPCs, reconnect, and invoke handling.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/gateway/DeviceAuthStore.kt` persists device tokens and scopes by normalized device and role.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/ConnectionManager.kt` builds node/operator connect options and resolves TLS parameters.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.live.test.ts` connects a Gateway client, selects an Android node, verifies paired/connected state, and uses remote config for remote runs, but requires manual setup first.
- No clean Android first-run pairing e2e was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/gateway/GatewaySessionReconnectTest.kt` covers reconnect and pairing-required pause/retry behavior.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/gateway/GatewaySessionInvokeTest.kt`, `GatewaySessionInvokeTimeoutTest.kt`, `DeviceAuthPayloadTest.kt`, `DeviceAuthStoreTest.kt`, `GatewayBootstrapAuthTest.kt`, `GatewayConfigResolverTest.kt`, and `OnboardingFlowLogicTest.kt` cover core auth, invoke, parsing, and onboarding logic.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Android pairing websocket TLS manual LAN setup protocol mismatch" --json`

Results:

- Issue #87216 `Android manual LAN setup parses ws:// as host ws and resolves http://ws:<port>`.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "Android app" --json` found #85966 `Android UI/operator WebSocket closes silently ... after successful node pair` and #78807 `fix(mobile): allow private LAN pairing auth`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android manual LAN ws host pairing"`

Results:

- 2026-03-07 GitHub mirror comment on #16638 reports Android node cannot pair when `gateway.auth.token` is configured and still hits `device signature invalid`.
- 2026-02-06 support thread explains LAN IP, reachability, firewall/client isolation, and auth/pairing as likely Android connection blockers.
