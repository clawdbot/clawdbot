---
version: 3
---

# Device Auth and Pairing

## Summary

Coverage: 88/100, Yes. Quality: 72/100, Medium.

The Gateway/WebSocket device identity, auth, and pairing surface is implemented across protocol docs, runtime auth decisions, device/node pairing stores, bootstrap tokens, client retry behavior, and real Gateway/server tests. The coverage score is Yes because multiple integration tests exercise real WebSocket/Gateway flows for local pairing, Control UI trusted-proxy behavior, setup-code bootstrap, device token reuse, token rotation/revocation, and node pairing.

Quality remains Medium. The current code has many positive hardening signals, but archive history shows repeated regressions around token priority, stale device state, trusted-proxy scope clearing, pairing loops, and bootstrap-token safety. Open reports still request rate limiting, bootstrap race fixes, pairing-management commands, trusted-proxy documentation, multi-user token isolation, and mobile/node lifecycle improvements.

## Features

- Shared-secret login: Shared-secret auth by token or password.
- Trusted proxy auth: Trusted-proxy and identity-bearing auth modes.
- Private ingress mode: Private-ingress `gateway.auth.mode: "none"` behavior and its limits.
- Device challenge signing: Device identity signing against the challenge nonce.
- Device tokens: Device token issuance, persistence, reconnect reuse, rotation, and revocation.
- Setup-code bootstrap: Bootstrap setup-code token flows and bounded operator token handoff.
- Auth mismatch recovery: Recovery semantics for `AUTH_TOKEN_MISMATCH` and `AUTH_SCOPE_MISMATCH`.
- Device auth migration: Device-auth migration errors and required v2/v3 signature behavior.
- Client pairing: Device pairing requirements for new clients.
- Node pairing: Node pairing flows, including pending requests, approvals, expiry, and trusted-CIDR or metadata-upgrade auto-approval boundaries.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 88/100.

Label: Yes.

Positive signals:

- Protocol docs define challenge/response auth, device-token issuance, setup-code bootstrap, pairing-required retry details, token mismatch retry limits, device identity signing, local auto-approval, and device-less exceptions (`docs/gateway/protocol.md:27`, `docs/gateway/protocol.md:118`, `docs/gateway/protocol.md:676`, `docs/gateway/protocol.md:707`, `docs/gateway/protocol.md:721`, `docs/gateway/protocol.md:741`, `docs/gateway/protocol.md:748`, `docs/gateway/protocol.md:775`, `docs/gateway/protocol.md:784`).
- Pairing docs distinguish Gateway device pairing from node pairing and document pending state, token TTL, approval/reject flows, node command gating, trusted-CIDR auto-approval, forwarded-header locality rules, and storage behavior (`docs/gateway/pairing.md:10`, `docs/gateway/pairing.md:25`, `docs/gateway/pairing.md:48`, `docs/gateway/pairing.md:90`, `docs/gateway/pairing.md:125`, `docs/gateway/pairing.md:173`, `docs/gateway/pairing.md:183`).
- Runtime verifies signed device identities against the server challenge, maps invalid device auth to structured errors, resolves shared/device/bootstrap/trusted-proxy auth separately, and emits retryable/nonretryable pairing and token details (`src/gateway/server/ws-connection/handshake-auth-helpers.ts:307`, `src/gateway/server/ws-connection/message-handler.ts:880`, `src/gateway/server/ws-connection/message-handler.ts:944`, `src/gateway/protocol/connect-error-details.ts:4`, `src/gateway/protocol/connect-error-details.ts:97`).
- Real Gateway/server integration tests cover local Control UI auto-pairing, scope-upgrade approval, QR setup-code bootstrap and handoff, bootstrap role upgrades, device token revocation, shared-token rotation with device-token preservation, device-token rotate/revoke authorization, node pairing authz, node trusted-CIDR auto-approval, and probe auth (`src/gateway/server.auth.control-ui.suite.ts:848`, `src/gateway/server.auth.control-ui.suite.ts:1031`, `src/gateway/server.auth.control-ui.suite.ts:1451`, `src/gateway/server.auth.control-ui.suite.ts:1840`, `src/gateway/server.shared-auth-rotation.test.ts:170`, `src/gateway/server.device-token-rotate-authz.test.ts:188`, `src/gateway/server.node-pairing-authz.test.ts:157`, `src/gateway/server.node-pairing-auto-approve.test.ts:88`, `src/gateway/probe.auth.integration.test.ts:71`).
- Cross-process/e2e coverage exists for paired node connection and status using two gateways, HTTP hooks, and WebSocket node pairing (`test/gateway.multi.e2e.test.ts:27`).

Negative signals:

- The feature is spread across device identity, WebSocket auth, bootstrap-token, device-pairing, node-pairing, trusted-proxy, client retry, and method authorization code. That breadth makes regressions plausible and is reflected in archive history.
- Several behaviors are safety-sensitive and have had repeated regressions: token priority, stale paired state, role/scope upgrades, token mismatch retry loops, trusted-proxy scope clearing, and pairing persistence.
- The highest-fidelity tests are still mostly local real-server tests. They do not replace live mobile, remote proxy, Tailscale Serve, Docker, or OS-update lifecycle proof.

Integration gaps:

- No current live iOS/Android/Tailscale Serve/Docker proof was found for this audit slice, even though archive reports mention mobile app, Docker loopback, trusted-proxy, and Windows-node parity scenarios.
- Bootstrap-token race and pre-auth rate-limit issues remain open in gitcrawl results, so the bootstrap path has known unclosed integration risk.
- Trusted-proxy behavior is covered by docs and tests, but open archive reports still request clarification and multi-user isolation.

## Quality

Score: 72/100.

Label: Medium.

Gitcrawl reports:

- Repeated closed bugs show real hardening work: device pairing bootstrap deadlocks, token mismatch loops, Control UI broadcast failures, device pairing persistence, metadata pinning, stale state self-unpairing, token priority, scope mismatch classification, rotate/revoke IDOR, node/device pairing store disconnects, and loopback restart re-pairing.
- Open issues/PRs show remaining quality risk: pairing list/revoke commands (#56621), bootstrap rate limiting/lockout/alerting (#77980, #77978, #77527), setup-code token races (#78276, #78277), device/token management RPC rate limiting (#84617), trusted-proxy scope-clearing docs (#80063), paired-device last-seen refresh (#81189), multi-user token isolation (#43903), secondary Tailscale auth (#57110), and Android/node-pairing close behavior (#85966).

Discrawl reports:

- Recent user and maintainer discussions repeatedly mention pairing-required loops, device-token mismatch recovery, Control UI/local proxy edge cases, mobile/node pairing confusion, and stale scope baselines.
- Maintainer discussion confirms some fixes are release-relevant and nontrivial, including one-shot trusted retry behavior, cached paired device tokens, bootstrap handoff persistence, and fail-closed approval contracts.
- User discussions still show operator confusion around devices paired as node but not operator, missing scope re-approval, and commands blocked by pairing-required responses.

Good qualities:

- Device identity uses Ed25519 keys, derives stable device IDs from public keys, migrates persisted identity safely, and signs nonce-bound payloads (`src/infra/device-identity.ts:97`, `src/infra/device-identity.ts:219`, `src/infra/device-identity.ts:278`).
- Device auth prefers the v3 payload while accepting v2 for compatibility at the verification boundary (`src/gateway/device-auth.ts:20`, `src/gateway/server/ws-connection/handshake-auth-helpers.ts:307`).
- Device-token, bootstrap-token, and shared-token decisions are separated, rate-limited in auth context, and mapped to specific unauthorized reasons (`src/gateway/server/ws-connection/auth-context.ts:83`, `src/gateway/server/ws-connection/auth-context.ts:160`).
- Pairing approval checks caller role/scope, self-scope, and admin boundaries for approve/remove/rotate/revoke methods (`src/gateway/server-methods/devices.ts:174`, `src/gateway/server-methods/devices.ts:341`, `src/gateway/server-methods/devices.ts:400`).
- Bootstrap profile issuance is bounded to explicit role/scope allowlists and verifies device/public-key binding before use (`src/shared/device-bootstrap-profile.ts:13`, `src/infra/device-bootstrap.ts:407`).
- Client reconnect logic uses explicit retry details and only retries token mismatch automatically for trusted endpoints (`src/gateway/client.ts:605`, `src/gateway/client.ts:877`, `src/gateway/client.ts:929`).

Bad qualities:

- Auth and pairing policy remains complex enough that correctness depends on preserving cross-file invariants across server auth helpers, message handling, device-pairing persistence, node-pairing persistence, bootstrap profiles, and client retry state.
- Device-less exceptions, local auto-approval, trusted proxy identity, shared-token semantics, and bootstrap handoff all alter the same effective role/scope surface.
- Archive reports show the user-facing failure modes are often confusing: pairing-required loops, device-token mismatch loops, and node/operator role confusion.
- Bootstrap-token hardening is incomplete while open rate-limit/race reports remain.

## Known gaps

- Implemented capability baseline: challenge nonce auth, signed device identity, shared-token/trusted-proxy auth, device pair approve/remove/list plus token rotate/revoke, setup-code bootstrap, node pairing, stored token reuse, token-mismatch retry, and pairing-required reconnect classification.
- Bootstrap-token pre-auth rate limiting, lockout/alerting, and setup-code race closure remain open quality risks in archive results (#77980, #77978, #78276, #78277).
- Device pairing and token-management RPC rate limiting remains open (#84617).
- Pairing-management UX is still incomplete for list-approved/revoke-style maintainer workflows (#56621).
- Trusted-proxy scope-clearing documentation and the multi-user token isolation story remain unclear enough to create operator expectation gaps (#80063, #43903, #57110).
- Paired-device last-seen refresh is still requested (#81189).
- Node/mobile role upgrade flows remain confusing to users and maintainers, including the Android operator WebSocket close report after node pairing (#85966).
- Remote/mobile/proxy lifecycle proof gaps are recorded under Coverage, not Quality.

## Evidence

### Docs

- `docs/gateway/protocol.md:27` documents `connect.challenge`.
- `docs/gateway/protocol.md:75` documents the authenticated `connect` flow.
- `docs/gateway/protocol.md:118` documents `auth.deviceTokens`.
- `docs/gateway/protocol.md:676` documents Gateway auth modes.
- `docs/gateway/protocol.md:707` documents setup-code bootstrap token output.
- `docs/gateway/protocol.md:721` documents `PAIRING_REQUIRED` retry detail behavior.
- `docs/gateway/protocol.md:741` documents rotate/revoke behavior and self-scope/admin requirements.
- `docs/gateway/protocol.md:748` documents device identity and pairing.
- `docs/gateway/protocol.md:775` documents local auto-approval.
- `docs/gateway/pairing.md:10` documents Gateway-owned pairing state.
- `docs/gateway/pairing.md:25` documents pending device pairing and 5-minute expiry.
- `docs/gateway/pairing.md:48` documents node pairing events/methods.
- `docs/gateway/pairing.md:90` documents node command gating.
- `docs/gateway/pairing.md:125` documents trusted CIDR node auto-approval.
- `docs/gateway/pairing.md:173` documents forwarded-header locality limits.
- `docs/gateway/security/index.md:166` documents Gateway/node trust.
- `docs/gateway/security/index.md:187` documents trust boundaries.
- `docs/gateway/security/index.md:222` documents disabled-by-default trusted CIDRs.
- `docs/gateway/configuration-reference.md:450` shows Gateway auth, Control UI, and node pairing config.
- `docs/gateway/configuration-reference.md:527` documents auth requirements and local-only none mode.
- `docs/gateway/configuration-reference.md:544` documents browser origin, TLS, trusted proxy, and CIDR pairing settings.
- `docs/gateway/trusted-proxy-auth.md:52` documents Control UI pairing in trusted-proxy mode.
- `docs/gateway/trusted-proxy-auth.md:75` documents trusted-proxy config and local-direct fallback behavior.

### Source

- `src/gateway/device-auth.ts:20` builds device auth payloads.
- `src/infra/device-identity.ts:97` defines the persisted device identity shape.
- `src/infra/device-identity.ts:219` loads or creates device identity.
- `src/infra/device-identity.ts:278` signs device auth payloads.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:76` defines silent local pairing eligibility.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:197` resolves pairing locality.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:253` skips pairing for local backend/self cases.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:307` verifies signed device auth.
- `src/gateway/server/ws-connection/auth-context.ts:83` extracts device-token candidates.
- `src/gateway/server/ws-connection/auth-context.ts:98` resolves WebSocket auth state.
- `src/gateway/server/ws-connection/auth-context.ts:160` verifies bootstrap and device tokens.
- `src/gateway/server/ws-connection/message-handler.ts:880` validates device auth errors.
- `src/gateway/server/ws-connection/message-handler.ts:944` resolves connect auth and pairing locality.
- `src/gateway/server/ws-connection/message-handler.ts:1100` handles pairing required and auto-approval flows.
- `src/gateway/server/ws-connection/message-handler.ts:1350` handles metadata pinning and scope upgrades.
- `src/gateway/server/ws-connection/message-handler.ts:1480` issues device and handoff tokens.
- `src/gateway/server/ws-connection/message-handler.ts:1788` emits `hello-ok.auth`.
- `src/infra/device-pairing.ts:143` defines pending request expiry.
- `src/infra/device-pairing.ts:252` fails closed for tokenless legacy pairing records.
- `src/infra/device-pairing.ts:347` preserves pending timestamps across refreshed requests.
- `src/infra/device-pairing.ts:559` requests/reconciles device pairing.
- `src/infra/device-pairing.ts:617` approves device pairing.
- `src/infra/device-pairing.ts:734` approves bootstrap device pairing.
- `src/infra/device-bootstrap.ts:228` issues bootstrap tokens.
- `src/infra/device-bootstrap.ts:407` verifies bootstrap token bindings.
- `src/shared/device-bootstrap-profile.ts:13` defines bounded bootstrap roles/scopes.
- `src/gateway/server-methods/devices.ts:174` implements `device.pair.list` and `device.pair.approve`.
- `src/gateway/server-methods/devices.ts:341` implements device removal and invalidation.
- `src/gateway/server-methods/devices.ts:400` implements token rotate/revoke authorization.
- `src/gateway/node-pairing-auto-approve.ts:30` checks trusted-CIDR node auto-approval.
- `src/infra/node-pairing.ts:279` requests node pairing.
- `src/infra/node-pairing.ts:316` approves node pairing.
- `src/infra/node-pairing.ts:401` verifies node tokens.
- `src/gateway/client.ts:571` stores device tokens from `hello-ok`.
- `src/gateway/client.ts:605` retries with stored device token after mismatch.
- `src/gateway/client.ts:877` gates automatic auth retry.
- `src/gateway/client.ts:929` restricts retry trust to loopback or pinned TLS.
- `src/gateway/client.ts:948` selects auth tokens.

### Integration tests

- `src/gateway/server.auth.control-ui.suite.ts:848` covers local-direct Control UI auto-pairing and scope-upgrade approval.
- `src/gateway/server.auth.control-ui.suite.ts:1031` covers QR setup-code bootstrap token handoff and bounded operator token behavior.
- `src/gateway/server.auth.control-ui.suite.ts:1451` covers bootstrap-auth role upgrades requiring approval.
- `src/gateway/server.auth.control-ui.suite.ts:1543` covers bootstrap-auth operator pairing outside QR baseline.
- `src/gateway/server.auth.control-ui.suite.ts:1588` covers local-direct node pairing auto-approval followed by operator-scope approval.
- `src/gateway/server.auth.control-ui.suite.ts:1840` covers revoked device token rejection.
- `src/gateway/server.auth.control-ui.suite.ts:1863` covers local backend loopback shared-auth without device pairing.
- `src/gateway/probe.auth.integration.test.ts:71` covers real Gateway probe auth and cached device auth.
- `src/gateway/server.shared-auth-rotation.test.ts:170` covers shared-token rotation preserving device-token sessions.
- `src/gateway/server.shared-auth-rotation.test.ts:246` covers issuer-tagged shared-token rotation behavior.
- `src/gateway/server.device-token-rotate-authz.test.ts:188` covers cross-device rotate denial and admin approval.
- `src/gateway/server.device-token-rotate-authz.test.ts:279` covers revoke authorization boundaries.
- `src/gateway/server.device-pair-approve-authz.test.ts:163` covers device approval authorization boundaries.
- `src/gateway/server.node-pairing-authz.test.ts:157` covers node-pair approval scope.
- `src/gateway/server.node-pairing-auto-approve.test.ts:88` covers default direct non-loopback node pairing requirement.
- `src/gateway/server.node-pairing-auto-approve.test.ts:122` covers first-time node trusted-CIDR auto-approval.
- `test/gateway.multi.e2e.test.ts:27` covers paired node connection in a multi-gateway e2e flow.

### Unit tests

- `src/gateway/device-auth.test.ts:8` covers device auth payload vectors.
- `src/gateway/auth.test.ts:245` covers token/password/none Gateway auth behavior.
- `src/gateway/auth.test.ts:563` covers trusted-proxy auth behavior.
- `src/gateway/auth.test.ts:1028` covers local-direct trusted-proxy behavior.
- `src/gateway/protocol/connect-error-details.test.ts:56` covers connect error detail classification.
- `src/gateway/client.test.ts:1429` covers explicit device-token priority.
- `src/gateway/client.test.ts:1453` covers stored auth scopes fallback.
- `src/gateway/client.test.ts:1476` covers retry with stored token after trusted token mismatch.
- `src/gateway/client.test.ts:1597` covers `PAIRING_REQUIRED` reconnect behavior.
- `src/gateway/server.auth.compat-baseline.test.ts:115` covers shared-token/device/auth compatibility baselines.
- `src/gateway/server.auth.browser-hardening.test.ts:389` covers browser loopback pairing hardening.
- `src/gateway/node-pairing-auto-approve.test.ts:1` covers node auto-approval helper cases.

### Gitcrawl queries

All gitcrawl queries used the refreshed archive from `last_sync_at=2026-05-28T05:29:12.208862Z`.

Query: `gitcrawl search issues "device pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #76349 closed `[Bug]: openclaw devices approve fails with missing operator.admin / device-ownership-mismatch`
- #19352 closed `[Bug]: Device pairing bootstrap impossible - chicken-and-egg problem when CLI also requires pairing`
- #21688 closed `Pairing scope-upgrade loop: repeated 'pairing required' reconnects for same device`
- #24189 closed `sessions_spawn fails with 'pairing required' despite device being paired and approved`
- #20447 closed `Control UI does not receive device.pair.requested broadcast (pairing approval UI broken)`
- #29908 closed `Enhancement: token-authenticated clients should bypass device pairing`
- #23498 closed `Device pairing recovery can self-unpair on token mismatch and legacy paired.json arrays break approve persistence`
- #44574 closed `[Bug]: WS node pairing auto-approved at runtime but never persists (device-auth.json never created)`
- #7715 closed `Feature: hot-reload device pairing approvals without gateway restart`
- #22400 closed `[Bug]: Device pairing not persisted after Gateway restart - requires manual re-approval`
- #56377 closed `[Bug]: Device pairing gets stuck after macOS minor update because paired device metadata pins old OS version`
- #50079 closed `Control UI Chat view freezes after successful auth/pairing (reproduces in incognito)`
- #14561 closed `Device pairing: pending requests not created for Control UI via Tailscale Serve`
- #44672 closed `[Bug]: macOS app can stay stuck on generic 'pairing required' after node->operator upgrade approval`
- #21470 closed `CLI device paired with operator.read scope only - cron list, gateway status fail with 'pairing required'`
- #55995 closed `[Bug]: /pair approve bypasses the admin scope guard for device pairing`
- #21647 closed `Loopback connections require device pairing on every gateway restart (2026.2.19)`
- #6836 closed `Node pairing: device-pairing and node-pairing stores are disconnected - nodes pending/approve tools don't work`
- #3795 closed `[Feature]: Auto-approve device pairing for Tailscale Serve requests`
- #69214 closed `[Bug]: Gateway client gets stuck in scope-upgrade repair loop for Telegram Native Approvals`

Query: `gitcrawl search issues "device token" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #21572 closed `CLI device auth persists stale device token after identity reset and breaks shared-token reconnect`
- #19681 closed `Internal callGateway retries AUTH_TOKEN_MISMATCH when both device identity and static token are present`
- #18562 closed `gateway status RPC probe fails with device_token_mismatch after first paired call`
- #39417 closed `Control UI signs device auth with a different token than it sends`
- #35944 closed `dangerouslyDisableDeviceAuth still rejects with device token mismatch`
- #71609 closed `Control UI device token mismatch loop after scope upgrade causes rate-limit lockout`
- #20679 closed `Device token mismatch persists after rotate/fresh pairing`
- #17270 closed `Device token auth regression: shared token wins over paired token on reconnect`
- #83358 closed `Explicit --url/--token device management path appears to leak paired-device state`
- #39861 closed `Token-authenticated webchat cannot obtain device token`
- #79292 closed `operator scope mismatch silently rejected as device token mismatch`
- #50626 closed `device.token.rotate lets paired operators mint tokens for other devices`
- #19244 closed `Gateway device keypair auth fails after upgrade`
- #18175 closed `Device token mismatch after re-pairing; cron list fails`
- #23891 closed `persistent device_token_mismatch after identity wipe/restart`
- #52085 closed `Device token accepted but scopes missing despite full paired token`
- #18936 closed `Gateway tools/CLI commands fail after first successful paired connection`
- #71990 closed `device.token.revoke skips containment check for other-device tokens`
- #18643 closed `Device token mismatch after config patch`
- #21191 closed `device-auth.json tokens never persist on macOS managed app`

Query: `gitcrawl search issues "gateway pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #22908 closed `Web UI Pairing Broken`
- #21796 closed `Discord pairing policy blocks DM/subagent replies until manual gateway action`
- #57688 closed `cron add fails with pairing required and no approval path`
- #21604 closed `dmPolicy=everyone still loses Discord pairing state on restart`
- #362 closed `WhatsApp pairing flow spams reconnection attempts`
- #56621 open `Feature: pairing list-approved and pairing revoke commands`
- #24189 closed `sessions_spawn fails with 'pairing required' despite device being paired and approved`
- #6836 closed `Node pairing: device-pairing and node-pairing stores are disconnected - nodes pending/approve tools don't work`
- #28299 closed `Gateway pairing prompt never appears in browser after token auth`
- #2501 closed `Gateway pairing status command should show pending device`
- #21146 closed `pair approve should require operator.admin`
- #69284 closed `Gateway pairing loop after Telegram Native Approvals startup`
- #23187 closed `Node pairing request disappears after restart`
- #21688 closed `Pairing scope-upgrade loop: repeated 'pairing required' reconnects for same device`
- #20447 closed `Control UI does not receive device.pair.requested broadcast (pairing approval UI broken)`
- #29908 closed `Enhancement: token-authenticated clients should bypass device pairing`
- #85577 closed `Gateway pairing policy allows stale browser metadata after approval`
- #19352 closed `Device pairing bootstrap impossible - chicken-and-egg problem when CLI also requires pairing`
- #13596 closed `Gateway pairing request lacks role/scope detail`
- #21470 closed `CLI device paired with operator.read scope only - cron list, gateway status fail with 'pairing required'`

Query: `gitcrawl search issues "bootstrap token" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #66100 closed `Android bootstrap token is not cleared after successful spend on plain LAN ws://, causing auth loop`
- #77980 open `bootstrap token path lacks rate limiting/lockout/alerting`
- #78276 open `setup-code races can revive consumed bootstrap tokens`
- #77978 open `pre-auth bootstrap-token verify allows mutex-stall DoS without rate limit`
- #47887 closed `iOS LAN onboarding forces wss and bootstrap-only setup codes fail`
- #79292 closed `operator scope mismatch silently rejected as device token mismatch`
- #12441 open `Control UI should accept gateway token from Authorization header`
- #48471 open `one-line local bootstrap daemon/dashboard auth/Telegram owner setup`
- #59231 closed `bootstrap token loses priority behind tailscale/trusted proxy auth`
- #76291 closed `bootstrap token verify holds auth mutex too long`
- #80895 closed `bootstrap token can bind without device-key proof`
- #81291 closed `setup-code device pairing skips approval`
- #85689 closed `setup-code bootstrap grants talk secrets to operator handoff`
- #78013 closed `bootstrap token auth has no rate limit`
- #77526 closed `bootstrap token pre-auth verification can be abused`
- #58381 closed `QR bootstrap operator handoff lost after approval`
- #64423 closed `stale paired token beats fresh setup-code token`
- #80975 closed `bootstrap pairing allows role/scope changes after token issue`
- #26897 closed `bootstrap pairing tokens bypass WS auth safeguards`
- #83683 closed `QR setup-code operator handoff regression`

Query: `gitcrawl search prs "device pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #22071 closed `clear pairing state on device token mismatch`
- #23503 closed `preserve pairing state on mismatch and migrate legacy paired.json`
- #20703 closed `Device Token Scope Escalation via Rotate Endpoint`
- #69375 closed `limit paired-device pairing actions to caller device`
- #10621 closed `Plugin add device-pair`
- #55996 closed `pair approve admin guard`
- #31988 closed `add device pairing HTTP endpoints`
- #14863 closed `pre-pair CLI operator device during onboarding`
- #81189 open `refresh paired device last-seen metadata`
- #77688 closed `avoid impossible rotation advice`
- #70239 closed `clear stale pairing requests on removal`
- #6846 closed `bridge node.pair tools to device pairing store`
- #52059 closed `gateway.auth.scopes for device-less token/password connections`
- #60462 closed `reject unapproved device token roles`
- #21830 closed `ios onboarding operator scopes regression`
- #81292 closed `Require approval for setup-code device pairing`
- #36427 closed `restore loopback-bound pairing bypass for Docker deployments`
- #21659 closed `Fix/ios pairing flow`
- #63086 closed `coerce array state files`
- #85690 closed `gate talk secret bootstrap handoff`

Query: `gitcrawl search prs "device token" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #17296 closed `restore device token priority`
- #17379 closed `restore device token priority in client auth selection`
- #79314 closed `classify scope mismatch separately from device token mismatch`
- #79296 closed `surface auth scope mismatch reason`
- #79295 closed `fix scope mismatch error detail`
- #37382 closed `separate device token from shared auth token`
- #1314 closed `allow token auth to bypass device identity`
- #18188 closed `clear stale device-auth token on token mismatch`
- #50627 closed `device.token.rotate IDOR`
- #84617 open `rate-limit device pairing and token management RPCs`
- #81189 open `refresh paired device last-seen metadata`
- #71991 closed `containment check for device.token.revoke`
- #41511 closed `Control UI token signing fix`
- #39420 closed `Control UI uses matching token for signing and auth`
- #81067 closed `admin scope for node token management`
- #23503 closed `preserve pairing state on mismatch and migrate legacy paired.json`
- #78732 closed `separate trusted-proxy device token ownership`
- #22071 closed `clear pairing state on device token mismatch`
- #78015 closed `rate-limit bootstrap and device signature auth`
- #64165 closed `persist device token after setup-code bootstrap`

Query: `gitcrawl search issues "trusted proxy device identity" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #80063 open `docs clarify trusted-proxy WebSocket scope clearing`
- #45217 closed `trusted-proxy auth blocks internal exec tool without device identity`
- #43903 open `multiple gateway tokens for multi-user isolation`
- #80589 closed `WebChat missing operator.read behind Nginx trusted proxy`
- #50022 closed `trusted-proxy strips operator scopes with missing Origin header`
- #69066 open `RFC: separate internal service identity from user auth`
- #60225 closed `shared-auth API clients lose scopes after device-less auth regression`
- #57087 closed `trusted-proxy lacks guardrails`
- #78731 closed `trusted-proxy HTTP auth bypasses per-session ownership`
- #30092 closed `Control UI still device-required behind local HTTPS reverse proxy`
- #78508 closed `trusted-proxy missing operator.read for chat history`
- #82607 closed `trusted-proxy + allowLoopback rejects internal loopback callers`
- #57110 open `Tailscale Serve optional secondary auth`
- #47402 closed `WebSocket device auth regression behind trusted proxy`
- #17270 closed `Device token auth regression: shared token wins over paired token`
- #17608 closed `trusted proxy docs mismatch for device-less scopes`
- #50626 closed `device.token.rotate lets paired operators mint tokens for other devices`
- #73636 closed `trusted-proxy clears scopes for local direct fallback`
- #29416 closed `Control UI pairing behind trusted-proxy loops`

Query: `gitcrawl search issues "node pairing auto approve" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #6836 closed `Node pairing: device-pairing and node-pairing stores are disconnected - nodes pending/approve tools don't work`
- #37749 closed `onboard should auto-approve local node host pairing`
- #70600 closed `docs say approve --latest but CLI only previews pending pairing`
- #22400 closed `Device pairing not persisted after Gateway restart`
- #29908 closed `token-authenticated clients should bypass device pairing`
- #22062 closed `node pairing approval should carry scopes`
- #62176 closed `trusted-CIDR node auto-approve should reject browser/control clients`
- #21812 closed `node pairing fails after gateway restart`
- #19352 closed `Device pairing bootstrap impossible`
- #17443 closed `node pairing status missing approval details`
- #25779 closed `local node pairing requires manual approval in Docker`
- #21647 closed `Loopback connections require device pairing on every gateway restart`
- #36973 closed `node pairing command missing docs`
- #62765 open `msteams dmPolicy pairing drops unpaired node state`
- #23661 closed `node pair approve requires wrong scope`
- #29622 closed `node reconnect loses pairing metadata`
- #85966 open `Android UI/operator WS closes silently after node pair`
- #21470 closed `CLI device paired with operator.read scope only`
- #25808 closed `node pairing auto-approve ignores CIDR boundary`
- #22655 closed `node pair request not visible in Control UI`

Query: `gitcrawl search prs "bootstrap token" -R openclaw/openclaw --state all --json number,title,state,url --limit 20`

Results:

- #59232 closed `prefer bootstrap auth over tailscale`
- #76322 open `bootstrap token mutex-stall DoS no rate limit`
- #78015 closed `rate-limit bootstrap and device signature auth`
- #58382 closed `restore qr bootstrap onboarding handoff`
- #77527 open `rate-limit pre-auth bootstrap-token verify`
- #83684 closed `restore QR bootstrap operator handoff`
- #80896 open `require device key proof for bootstrap token binding`
- #78277 open `setup-code races revive consumed tokens`
- #26898 closed `secure bootstrap pairing tokens and restore WS auth safeguards`
- #64424 closed `prioritize fresh bootstrap setup codes over cached device tokens`
- #81292 closed `require setup-code pairing approval`
- #80976 closed `prevent bootstrap pairing scope changes`
- #85690 closed `gate talk secret bootstrap handoff`
- #66101 closed `clear Android bootstrap token after successful spend`
- #47888 closed `support LAN ws:// setup-code bootstrap`
- #79296 closed `surface auth scope mismatch reason`
- #12442 open `Control UI Authorization-header gateway token bootstrap`
- #48472 open `local bootstrap daemon/dashboard auth flow`
- #76292 closed `avoid holding auth mutex during bootstrap verify`
- #78016 closed `device signature rate-limit follow-up`

### Discrawl queries

All discrawl queries used `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "<query>"` against `state=current`, `last_sync_at=2026-05-28T00:14:43Z`.

Query: `"device pairing"`

Results:

- Returned 10 results.
- High-signal results included 2026-05-26 user-support guidance that mobile node setup means pairing a phone/device to Gateway and exposing node capabilities.
- High-signal results included 2026-05-23 user logs showing `device pairing auto-approved` with role `operator`.
- High-signal results included 2026-05-22 general discussion where CLI/device commands were blocked because the device needed scope re-approval.
- High-signal results included 2026-05-22 general discussion where a device was paired as `node` but not yet operator.
- High-signal results included 2026-05-22 maintainer discussion of a fail-closed replacement approval contract and an auth-boundary behavior-change caveat.
- High-signal results included 2026-05-19 Android discussion asking whether a Gateway connection failure should create a pending pairing request.

Query: `"device token mismatch"`

Results:

- Returned 10 results.
- High-signal results included 2026-05-01 maintainer release discussion of stale shared-token recovery, retry budget/cancelled loop behavior, aggressive device-token clearing, and bootstrap handoff persistence mismatch.
- High-signal results included 2026-04-25 issue discussion stating current main bounds Control UI `AUTH_TOKEN_MISMATCH` reconnect with cached paired device token and one trusted retry.
- High-signal results included 2026-04-25 issue discussion for Control UI device-token mismatch loops after scope upgrade.
- High-signal results included 2026-04-25 maintainer discussion where Twilio routing was blocked by `unauthorized: device token mismatch`.
- High-signal results included 2026-04-24 issue comments that current main attaches device identity and reads challenge nonce for command/probe flows.
- High-signal results included 2026-04-24 issue comments that Control UI token storage/signing and bounded retry were implemented with regression tests.

Query: `"pairing required gateway"`

Results:

- Returned 10 results.
- High-signal results included 2026-05-03 general logs showing a `scope-upgrade` pairing-required loop from a password-auth CLI device requesting admin/pairing/talk/write scopes from a read baseline.
- High-signal results included 2026-05-02 user discussion where `cron add` was blocked by pairing required.
- High-signal results included 2026-05-01 Docker discussion describing an identity-wipe/local fallback path and stale operator.pairing-scoped identity failure.
- High-signal results included 2026-04-29 maintainer discussion that native approval startup can use persisted identity and hit stale paired baselines.
- High-signal results included 2026-04-26 user discussion where a pairing-required loop was resolved by quieting a retrying channel and approving the pending request.
- High-signal results included 2026-04-26 issue comments for actionable pairing-required detail fixes.

Query: `"bootstrap token"`

Results:

- Returned 10 results.
- Most results were broader bootstrap/context discussions rather than direct Gateway WebSocket pairing evidence.
- One 2026-05-20 maintainer discussion connected setup pain to primary channels and local onboarding, but did not close the current bootstrap-token race/rate-limit issues.

Query: `"trusted proxy device identity"`

Results:

- Returned 10 results.
- High-signal results included 2026-04-26 issue discussion that device-less token/password/trusted-proxy operator connects clear scopes, with a backend gateway-client exception.
- High-signal results included 2026-04-25 issue discussion that trusted-proxy mode supports operator-managed deployments without per-device identity.
- High-signal results included 2026-04-24 PR review discussion about `dangerouslyDisableDeviceAuth` wording and exceptions to scope clearing.
- High-signal results included 2026-04-22 and 2026-04-20 user audit logs warning that `allowInsecureAuth` does not bypass secure context/device identity and that reverse proxy headers are not trusted by default.

Query: `"node pairing"`

Results:

- Returned 10 results.
- High-signal results included 2026-05-26 mobile automation answers that phone/device integrations connect and pair as nodes.
- High-signal results included 2026-05-22 general discussion where a mobile app was only paired as node and needed operator roles/scopes for UI behavior.
- High-signal results included 2026-05-13 general discussion proposing pairing grants that carry role intent.
- High-signal results included 2026-05-11 user report where setup DMs used pairing but no code/pending request was visible.
- High-signal results included 2026-05-06 maintainer discussion that Windows node parity and pairing were not yet as robust as desired.
- High-signal results included 2026-05-01 Docker discussion where CLI pairing only granted operator.pairing but needed operator.admin.

### Verification

- Note-only audit; no product code or matrix report edits.
- Validation run: `git diff --check -- .mem/main/specs/25-lts-release-placeholder`.
