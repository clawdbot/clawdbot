---
title: "iOS app - Gateway Pairing, Discovery, and Trust Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Gateway Pairing, Discovery, and Trust Maturity Note

## Summary

The iOS app has a substantial native implementation for gateway discovery, manual/QR setup, TLS fingerprint trust, device authentication, role-scoped node/operator sessions, and user-facing diagnostics. The main maturity limiter is runtime proof: the repository has gateway-level and synthetic client coverage for iOS-shaped node pairing, but I did not find a native iOS first-run/live flow that exercises discovery, QR/manual setup, TLS trust, approval, node+operator auth, and relay-backed registration end to end.

## Category Scope

- Bonjour/local and wide-area gateway discovery.
- Manual host/port and QR/setup-code onboarding.
- Gateway connect configuration persistence.
- TLS fingerprint trust prompt and pinning behavior.
- Pairing approval, device auth/keychain storage, and node+operator session auth.
- Pairing/auth diagnostics for users and operators.

## Features

- Bonjour/local: Bonjour/local and wide-area gateway discovery
- Manual host/port: Manual host/port and QR/setup-code onboarding
- Gateway connect configuration persistence: Gateway connect configuration persistence behavior, status, and operator-visible verification.
- TLS fingerprint trust prompt: TLS fingerprint trust prompt and pinning behavior
- Pairing approval: Pairing approval, device auth/keychain storage, and node+operator session auth
- Pairing/auth diagnostics for users: Pairing/auth diagnostics for users and operators

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (46%)`

The strongest coverage signal is not native iOS app automation; it is gateway-level integration/e2e coverage that connects an iOS-shaped node client through the real gateway pairing path, plus server-side push/role behavior tests. That proves important protocol compatibility, but it does not exercise the native app's first-run UI, QR scanner, Bonjour resolver, TLS trust prompt, Keychain-backed handoff, manual host/port UX, node+operator dual-session startup, or relay registration in a live iOS build, so the score stays below Alpha.

Unit coverage is broad and useful as supporting evidence for parsing, pinning, keychain, auth payload, and reconnect behavior, but by policy it does not make these features covered by itself.

## Quality Score

- Score: `Experimental (48%)`

The implementation quality is stronger than the runtime proof, but still Experimental for this public-support row. Source and docs show a coherent trust model: Bonjour TXT is not trusted for routing, non-loopback plaintext setup is blocked, discovered gateways require stored TLS trust before autoconnect, TLS fingerprints live in Keychain-backed storage, device identity uses signed payloads, issued tokens are role-scoped, and the app separates node and operator sessions. Pairing/auth diagnostics are also structured enough to distinguish pairing required, token/password/bootstrap failures, TLS pin mismatch, metadata upgrade, proxy/rate-limit, and reconnect-pausing states.

Quality remains below Beta because the product/operator record is still rough for real users. Archive discussion shows recurring confusion around public-IP `wss://` setup, valid DNS certificates, Tailscale Serve/WebSocket behavior, iOS local-network pairing regressions, token-rotation recovery, QR bootstrap handoff, relay base URL discoverability, and internal/TestFlight-only access.

## Completeness Score

- Score: `Experimental (46%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bonjour/local, Manual host/port, Gateway connect configuration persistence, TLS fingerprint trust prompt, Pairing approval, Pairing/auth diagnostics for users.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a native iOS first-run pairing smoke or live run that covers discovered LAN gateway, wide-area/Tailnet discovery, manual host/port, QR/setup code, TLS trust prompt, pairing approval, node+operator sessions, and relay-backed push registration.
- Harden operator docs for public `wss://` endpoints, raw IP certificate mismatch, trusted DNS names, Tailscale Serve/WebSocket requirements, and pairing/auth/network failure distinctions.
- Make the official/TestFlight relay URL and access path more discoverable.
- Keep onboarding reset, certificate rotation, and gateway-token rotation flows visible in an iOS runbook.

## Evidence

### Docs

- `docs/platforms/ios.md` describes the iOS app as internal preview, not publicly distributed yet, and says it connects over LAN or tailnet WebSocket using Bonjour, tailnet unicast DNS-SD, or manual host/port. The quick start requires choosing a discovered gateway or manual host, approving with `openclaw devices approve <requestId>`, then verifying `nodes.status` and `node.list`.
- `docs/platforms/ios.md` documents authenticated node and operator sessions, `gateway.identity.get`, relay-backed `push.apns.register`, App Attest plus StoreKit app transaction JWS, and the gateway signing relay send requests for official/TestFlight builds.
- `apps/ios/README.md` labels the app Super Alpha/internal-use only, says no public distribution exists, and documents local archive plus TestFlight beta flows. Its troubleshooting notes call out foreground-first behavior, pairing/auth errors pausing reconnect loops, rough reconnect churn, discovery logs, manual host/port, and TLS checks.
- `apps/ios/CHANGELOG.md` records QR-code setup support, copied setup-code parsing, non-loopback `ws://` blocking, and reconnect recovery after trusted certificate changes.

### Source

- `apps/ios/Sources/Gateway/GatewayDiscoveryModel.swift` browses configured Bonjour service domains for `_openclaw-gw._tcp` and records discovery/debug details, including display name, LAN host, tailnet DNS, gateway port, TLS mode, and TLS SHA-256 TXT fields.
- `apps/ios/Sources/Gateway/GatewayServiceResolver.swift` resolves Bonjour services through `NetService` SRV/address data and explicitly avoids trusting TXT data for routing.
- `apps/ios/Sources/Gateway/GatewayConnectionController.swift` implements discovered and manual connection paths, TLS requirements, fingerprint probing, trust prompt state, stored-pin autoconnect gating, last manual endpoint persistence, and gateway connect options with `role: node`.
- `apps/ios/Sources/Gateway/GatewayTrustPromptAlert.swift`, `apps/ios/Sources/Onboarding/QRScannerView.swift`, and `apps/ios/Sources/Onboarding/OnboardingWizardView.swift` implement the trust prompt, QR scanner, manual host/port setup, setup-code parsing, bootstrap pairing preparation, and pairing-approval UI.
- `apps/ios/Sources/Gateway/GatewaySettingsStore.swift`, `apps/ios/Sources/Gateway/KeychainStore.swift`, and `apps/shared/OpenClawKit/Sources/OpenClawKit/GenericPasswordKeychainStore.swift` persist instance IDs, gateway credentials, bootstrap tokens, passwords, TLS pins, last connection metadata, and diagnostics using Keychain-backed storage and protected files.
- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayTLSPinning.swift`, `DeepLinks.swift`, `DeviceIdentity.swift`, `DeviceAuthStore.swift`, `DeviceAuthPayload.swift`, and `GatewayChannel.swift` implement TLS pin validation, secure deep-link parsing, Ed25519 device identity, role-scoped token storage, signed auth payloads, challenge nonce handling, bootstrap handoff, and trusted-endpoint token retry rules.
- `apps/ios/Sources/Model/NodeAppModel.swift` runs separate node and operator gateway sessions and uses the operator session to fetch gateway identity before relay-backed APNs registration.
- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayConnectionProblem.swift` and `apps/ios/Sources/Gateway/GatewayConnectionIssue.swift` map pairing, auth, TLS, proxy, rate-limit, role/scope, and metadata failures into structured diagnostics.

### Integration tests

- `test/gateway.multi.e2e.test.ts` and `test/helpers/gateway-e2e-harness.ts` exercise multi-gateway WebSocket/HTTP flows and connect an iOS-shaped node client with a real device identity, token, role `node`, capabilities, commands, and paired node status.
- `src/gateway/server.roles-allowlist-update.test.ts`, `src/gateway/server.node-pairing-auto-approve.test.ts`, `src/gateway/exec-approval-ios-push.test.ts`, `src/gateway/server-node-events.test.ts`, and `src/gateway/server-methods/push.test.ts` cover adjacent gateway-side iOS node, pairing, role, event, and push behavior.
- No native iOS live/e2e scenario was found that installs or launches the iOS app and drives discovery, QR/manual setup, TLS trust, approval, device auth, node+operator session startup, and push relay registration end to end.

### Unit tests

- `apps/ios/Tests/GatewayConnectionSecurityTests.swift` covers TLS pin trust, advertised fingerprint distrust, autoconnect pin requirements, non-loopback TLS enforcement, Tailscale defaults, and trusted certificate rotation behavior.
- `apps/ios/Tests/GatewayConnectionControllerTests.swift` covers gateway connect config, capability/command filtering, operator scopes, saved manual endpoint fallback, reconnect decisions, and keychain-loaded last connection metadata.
- `apps/ios/Tests/KeychainStoreTests.swift`, `apps/shared/OpenClawKit/Tests/OpenClawKitTests/GatewayTLSPinningTests.swift`, and `DeviceIdentityStoreTests.swift` cover keychain, TLS pinning, and device identity storage behavior.
- `apps/shared/OpenClawKit/Tests/OpenClawKitTests/DeepLinksSecurityTests.swift` covers secure setup-code parsing, copied setup-code messages, insecure non-loopback rejection, loopback/private LAN allowance, and tailnet plaintext rejection.
- `apps/shared/OpenClawKit/Tests/OpenClawKitTests/GatewayNodeSessionTests.swift`, `DeviceAuthPayloadTests.swift`, and `apps/ios/Tests/GatewayConnectionIssueTests.swift` cover bootstrap/device-token precedence, signed auth payloads, token persistence, trusted endpoint retry gates, and structured pairing/auth issue detection.

### Gitcrawl queries

- `gitcrawl search openclaw/openclaw --query "iOS app gateway pairing discovery TLS fingerprint keychain operator session" --json` returned no hits.
- `gitcrawl search openclaw/openclaw --query "iOS QR setup code TLS fingerprint pairing manual host port" --json` returned no hits.
- `gitcrawl search openclaw/openclaw --query "iOS device signature invalid pairing required gateway token" --json` returned PR `#80656` open, `fix(swift): keep device auth compatible with v2 gateways`, with a snippet saying the live gateway moved from `device-signature-invalid` before pairing to `pairing required`.
- `gitcrawl search openclaw/openclaw --query "iOS pairing" --json` returned open PRs/issues including `#80656` device auth compatibility, `#78807` private LAN pairing auth, `#55914` shareable invite codes for mobile pairing, `#63123` background alive beacon support, `#11887` cloud relay for remote mobile access, and `#81402` runtime state to SQLite.
- `gitcrawl search openclaw/openclaw --query "iOS TestFlight relay push gateway identity" --json` returned no hits.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "iOS gateway pairing TLS fingerprint setup code"` returned no results.
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "iOS TestFlight push relay gateway identity pairing"` returned no results.
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "iOS pairing"` returned iOS Alpha/support discussion from 2026-05-29 through 2026-03-30 about QR pairing over VPS/public networks requiring HTTPS/WSS with a trusted certificate, raw-IP certificate mismatch risk, `/pair qr` and `/pair approve` flow, local-network WebSocket regression smoke needs, internal preview/no public link, QR bootstrap handoff restoration, onboarding TLS trust reset, and Tailscale Serve WebSocket upgrade issues.
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "iPhone pairing gateway"` returned discussion about remote iPhone pairing after gateway token rotation, internal/dev pairing with `openclaw devices list` and `openclaw devices approve <requestId>`, Tailscale Serve pairing issues, and the same `/pair` token supporting both operator and node sessions.
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "device signature invalid iOS"` returned a 2026-02-12 iOS build/debug thread about invalid connect params, role `operator` versus `node`, and device signatures.
- `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "TestFlight relay"` returned 2026-04 and 2026-03 discussion that TestFlight can receive push through ClawPushRelay with App Attest/App Store validation, official/TestFlight builds require real TestFlight/App Store installs, and operators were still asking what `gateway.push.apns.relay.baseUrl` should be.
