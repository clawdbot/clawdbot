---
title: "Security, auth, pairing, and secrets - Device and Node Pairing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Device and Node Pairing Maturity Note

## Summary

Device identity and operator pairing are implemented as a real Gateway control-plane surface, not just documentation. The current code signs nonce-bound device identities, issues setup-code bootstrap tokens, creates pending device pairing requests, mints per-role device tokens, reuses stored tokens on reconnect, rotates and revokes tokens inside approved role/scope boundaries, and special-cases local Control UI/WebChat and backend flows.

Coverage is Stable because real Gateway/server tests exercise the most important runtime flows: local Control UI auto-pairing, QR/setup-code bootstrap handoff, device-token reuse and revocation, shared-auth rotation, device token rotate/revoke authorization, node pairing auto-approval, and multi-gateway node pairing. Quality is Beta because the source is security-conscious and well documented, but refreshed archives still show open pairing failures, setup-code race reports, scope deadlocks, mobile/node confusion, missing rate limits, and operator-facing recovery pain.

## Category Scope

Included in this category:

- Setup codes: Setup codes and QR pairing UX for mobile/node onboarding through the device-pair plugin
- Device identity creation: Device identity creation, storage, public-key-derived device IDs, challenge signing, and server verification
- Device-token issuance: Device-token issuance, reconnect reuse, token mismatch recovery, token rotation, token revocation, and stale-token cleanup
- Device pairing approvals for operator: Device pairing approvals for operator and node roles, including pending requests, role/scope upgrades, and repair requests
- Operator scopes that gate pairing: Operator scopes that gate pairing, device token management, node pairing, and higher-risk role/scope approvals
- Local Control UI: Local Control UI, WebChat, trusted-proxy, and backend auto-pairing or device-less exception behavior where it affects operator pairing
- Auth migration: Auth migration and recovery errors for pre-challenge device signing, token drift, scope mismatch, and mixed gateway auth configuration
- Operator-facing docs: Operator-facing docs for devices, pairing, WebChat, Control UI, protocol auth, and troubleshooting
- Node Pairing: Covers Node Pairing across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Capability Trust: Covers Capability Trust across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Remote Exec Approvals: Covers Remote Exec Approvals across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.

## Features

- Setup codes: Setup codes and QR pairing UX for mobile/node onboarding through the device-pair plugin
- Device identity creation: Device identity creation, storage, public-key-derived device IDs, challenge signing, and server verification
- Device-token issuance: Device-token issuance, reconnect reuse, token mismatch recovery, token rotation, token revocation, and stale-token cleanup
- Device pairing approvals for operator: Device pairing approvals for operator and node roles, including pending requests, role/scope upgrades, and repair requests
- Operator scopes that gate pairing: Operator scopes that gate pairing, device token management, node pairing, and higher-risk role/scope approvals
- Local Control UI: Local Control UI, WebChat, trusted-proxy, and backend auto-pairing or device-less exception behavior where it affects operator pairing
- Auth migration: Auth migration and recovery errors for pre-challenge device signing, token drift, scope mismatch, and mixed gateway auth configuration
- Operator-facing docs: Operator-facing docs for devices, pairing, WebChat, Control UI, protocol auth, and troubleshooting
- Node Pairing: Covers Node Pairing across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Capability Trust: Covers Capability Trust across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.
- Remote Exec Approvals: Covers Remote Exec Approvals across node/device pairing for capability hosts, pending and approved node state, trusted-CIDR auto-approval, node-declared command/capability trust boundaries, and related node pairing, capability trust, and remote exec approvals behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - Real Gateway tests cover local Control UI operator auto-pairing and scope-upgrade behavior (`src/gateway/server.auth.control-ui.suite.ts:848`, `src/gateway/server.auth.control-ui.suite.ts:1588`).
  - Real Gateway tests cover QR/setup-code bootstrap, bounded node/operator token handoff, bootstrap role-upgrade approval, non-baseline bootstrap rejection, and revoked device-token rejection (`src/gateway/server.auth.control-ui.suite.ts:1031`, `src/gateway/server.auth.control-ui.suite.ts:1451`, `src/gateway/server.auth.control-ui.suite.ts:1543`, `src/gateway/server.auth.control-ui.suite.ts:1840`).
  - Runtime tests cover shared auth rotation preserving valid device-token sessions and disconnecting issuer-tagged sessions after shared-token rotation (`src/gateway/server.shared-auth-rotation.test.ts:187`, `src/gateway/server.shared-auth-rotation.test.ts:203`, `src/gateway/server.shared-auth-rotation.test.ts:217`, `src/gateway/server.shared-auth-rotation.test.ts:246`).
  - Runtime authorization tests cover device-token rotate/revoke cross-device denial, admin cross-device rotation/revocation, node-role token protections, and device approval scope guards (`src/gateway/server.device-token-rotate-authz.test.ts:188`, `src/gateway/server.device-token-rotate-authz.test.ts:237`, `src/gateway/server.device-token-rotate-authz.test.ts:279`, `src/gateway/server.device-pair-approve-authz.test.ts:169`).
  - Runtime tests cover trusted-CIDR node pairing behavior and node pairing approval scopes (`src/gateway/server.node-pairing-auto-approve.test.ts:88`, `src/gateway/server.node-pairing-auto-approve.test.ts:122`, `src/gateway/server.node-pairing-authz.test.ts:157`).
  - E2E coverage starts two gateways and exercises WS, HTTP hooks, and node pairing (`test/gateway.multi.e2e.test.ts:27`).
- Negative signals:
  - The coverage is strongest in local real-server/runtime tests; this audit did not find fresh live proof for iOS, Android, Tailscale Serve, Docker, NAS, or public reverse-proxy pairing lifecycle.
  - WebChat-specific auto-pairing and device-token persistence are mostly covered through shared Control UI/Gateway code paths and helper/unit tests rather than a dedicated end-to-end WebChat pairing flow.
  - Setup-code and bootstrap paths have strong runtime tests, but archive results still include open setup-code race reports, so integration supporting signal is not Lovable.
- Integration gaps:
  - Add live mobile setup-code proof for iOS and Android over `wss://`, private LAN `ws://`, and Tailscale Serve.
  - Add a dedicated WebChat pairing/reconnect e2e that proves device identity, stored device-token reuse, and scope-upgrade recovery from the browser-visible flow.
  - Add a Docker/NAS/non-macOS gateway pairing smoke for the current proof-response and connect-nonce paths.
  - Close setup-code race proof around consumed bootstrap-token revival before treating QR/setup-code coverage as Lovable.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports:
  - Open issues show current operator-impacting risk: Trim OS/TerraMaster proof-response pairing failure (#86778), scope deadlock for CLI approve/reject repair requests (#74484), Android UI/operator close after node pairing (#85966), setup-code race reopening consumed bootstrap tokens (#78276), backend self-pairing bypass concern (#72418), Android zero-command/connect-nonce race (#87058), and missing pairing-error guidance (#67618).
  - Open PRs show active hardening work rather than settled behavior: paired-device last-seen refresh (#81189), rate limiting for device pairing/token management RPCs (#84617), bootstrap token binding (#80896), setup-code binding to node approvals (#46794), setup-code race fix (#78277), and private LAN mobile pairing auth (#78807).
  - Archive history also shows product gaps around multi-user gateway token isolation (#43903), invite-style mobile pairing (#55914), service/user identity separation (#69066), and configurable gateway token scopes (#80836).
- Discrawl reports:
  - Recent Discord support results include users and maintainers diagnosing `pairing required`, scope-upgrade loops, stale device identities, Docker host/guest approval context, mobile QR/TLS setup failures, WebChat/Control UI pairing confusion, and stale bootstrap token loops.
  - Maintainer discussion calls out stale internal `gateway-client` identities causing scope-upgrade failures for native approvals, while several user-help threads still route people through `openclaw devices list`, `approve`, `rotate`, or identity reset workflows.
  - The community repeatedly confuses node pairing, operator pairing, DM/channel pairing, and WebChat/Control UI pairing, which shows the operator mental model remains hard even though the docs now cover the flows.
- Good qualities:
  - Device identity uses public-key-derived IDs and nonce-bound signatures on both CLI/native and browser Control UI paths (`src/infra/device-identity.ts:219`, `src/infra/device-identity.ts:278`, `src/infra/device-identity.ts:317`, `ui/src/ui/device-identity.ts:61`, `ui/src/ui/device-identity.ts:109`).
  - Server auth separates shared auth, bootstrap tokens, and device tokens, and prefers explicit bootstrap auth when QR/setup-code handoff needs that classification (`src/gateway/server/ws-connection/auth-context.ts:98`, `src/gateway/server/ws-connection/auth-context.ts:188`).
  - Pairing approval, bootstrap approval, token issuance, rotation, and revocation stay bounded to approved roles and caller scopes (`src/infra/device-pairing.ts:617`, `src/infra/device-pairing.ts:734`, `src/infra/device-pairing.ts:924`, `src/infra/device-pairing.ts:988`, `src/infra/device-pairing.ts:1077`, `src/infra/device-pairing.ts:1138`).
  - Setup-code bootstrap scopes are allowlisted and intentionally exclude `operator.admin` and `operator.pairing` (`src/shared/device-bootstrap-profile.ts:13`, `src/shared/device-bootstrap-profile.ts:22`, `src/shared/device-bootstrap-profile.ts:46`).
  - Client reconnect logic stores device tokens, reuses cached scopes only when reusing cached tokens, clears stale stored tokens on device-token mismatch, and limits shared-token mismatch retries to trusted endpoints (`src/gateway/client.ts:581`, `src/gateway/client.ts:605`, `src/gateway/client.ts:802`, `src/gateway/client.ts:877`, `src/gateway/client.ts:929`, `src/gateway/client.ts:948`).
  - Operator docs are unusually explicit about pairing scopes, setup-code security, token drift recovery, local Control UI auto-approval, and auth migration diagnostics (`docs/gateway/protocol.md:150`, `docs/gateway/protocol.md:692`, `docs/gateway/protocol.md:754`, `docs/cli/devices.md:123`, `docs/gateway/troubleshooting.md:384`, `docs/web/control-ui.md:61`).
- Bad qualities:
  - The security contract is complex and depends on preserving invariants across device identity, bootstrap state, shared auth generation, WebSocket handshake, device pairing state, node pairing state, Control UI local storage, and CLI fallback behavior.
  - There are still open quality issues in safety-sensitive areas: setup-code races, device-pairing/token-management rate limits, pairing scope deadlocks, proof-response failure on a NAS OS, and possible backend self-pairing bypass.
  - Operator UX remains hard: archives show repeated confusion between node and operator roles, device-token mismatch versus scope mismatch, local Docker fallback, Control UI/WebChat pairing, and DM/channel pairing.
  - Auth migration and recovery behavior is documented, but older clients and stale identities still produce high-friction `pairing required` and scope-upgrade failures in real support threads.
- Excluded from quality:
  - Unit, integration, e2e, live, and real runtime test breadth were not used to raise or lower Quality. Test evidence is used only in Coverage.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Setup codes, Device identity creation, Device-token issuance, Device pairing approvals for operator, Operator scopes that gate pairing, Local Control UI, Auth migration, Operator-facing docs, Node Pairing, Capability Trust, Remote Exec Approvals.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Close setup-code race handling for consumed bootstrap tokens (#78276/#78277) and prove the result against QR/setup-code retry and reconnect flows.
- Finish rate limiting or equivalent abuse controls for device pairing and token-management RPCs (#84617).
- Resolve or explicitly downgrade the current proof-response failure on Trim OS/TerraMaster NAS (#86778).
- Clarify or fix pairing scope deadlocks for CLI repair/approve flows (#74484) and stale internal gateway-client identity failures discussed in discrawl.
- Add operator-facing affordances for list-approved/revoke/invite-style pairing workflows (#56621/#55914) if they remain product goals.
- Improve role/scope copy where users confuse node pairing with operator pairing, especially for Android/iOS and Control UI/WebChat.
- Strengthen multi-user token isolation and service identity separation, or document the single-operator trust boundary more prominently (#43903/#69066).
- Add live mobile, Tailscale Serve, Docker/NAS, and remote browser pairing proof before raising Coverage into Lovable.

## Evidence

### Docs

- `docs/gateway/protocol.md:27` documents the challenge/response connect handshake with `connect.challenge`.
- `docs/gateway/protocol.md:118` documents `hello-ok.auth` with and without device tokens.
- `docs/gateway/protocol.md:150` documents QR/setup-code bootstrap returning a primary node token plus bounded operator token.
- `docs/gateway/protocol.md:692` documents device-token issuance, persistence, reconnect scope reuse, and auth precedence.
- `docs/gateway/protocol.md:718` documents retryable `PAIRING_REQUIRED` behavior while non-baseline setup-code bootstrap waits for approval.
- `docs/gateway/protocol.md:727` documents device token rotate/revoke scope requirements and bounded token mutation.
- `docs/gateway/protocol.md:754` documents device identity, local auto-approval boundaries, device-less exceptions, and signed nonce requirements.
- `docs/gateway/protocol.md:783` documents device auth migration diagnostics for legacy clients.
- `docs/cli/devices.md:51` documents exact request-ID approval, upgrade previews, and scope/role review.
- `docs/cli/devices.md:123` documents device token rotation.
- `docs/cli/devices.md:145` documents device token revocation.
- `docs/cli/devices.md:194` documents token drift recovery.
- `docs/channels/pairing.md:111` documents Telegram `/pair`, setup code, QR scanning, and approval.
- `docs/channels/pairing.md:119` documents setup-code payload contents and bootstrap token purpose.
- `docs/channels/pairing.md:126` documents bounded QR/setup-code handoff scopes.
- `docs/channels/pairing.md:167` documents trusted-CIDR node auto-approval and excludes operator/browser/Control UI/WebChat auto-approval.
- `docs/gateway/pairing.md:10` documents Gateway-owned pairing and the device-pairing versus node-pairing distinction.
- `docs/gateway/pairing.md:125` documents trusted-CIDR device auto-approval.
- `docs/gateway/pairing.md:153` documents metadata-upgrade auto-approval.
- `docs/gateway/operator-scopes.md:31` documents operator scope levels.
- `docs/gateway/operator-scopes.md:63` documents device pairing approval-time checks.
- `docs/web/control-ui.md:61` documents local loopback Control UI auto-approval and remote/Tailnet pairing requirements.
- `docs/web/control-ui.md:480` documents token fragment handling, password memory-only behavior, and explicit remote UI credential requirements.
- `docs/web/webchat.md:73` documents WebChat/Gateway auth options including token, password, Tailscale, trusted-proxy, and remote credentials.

### Source

- `src/infra/device-identity.ts:219` loads or creates persisted CLI/native device identity.
- `src/infra/device-identity.ts:278` signs device auth payloads.
- `src/infra/device-identity.ts:299` derives device IDs from public keys.
- `src/infra/device-identity.ts:317` verifies device signatures.
- `ui/src/ui/device-identity.ts:61` loads or creates browser Control UI device identity in local storage.
- `ui/src/ui/device-identity.ts:109` signs browser Control UI device payloads.
- `ui/src/ui/device-auth.ts:42` loads stored browser device tokens.
- `ui/src/ui/device-auth.ts:53` stores browser device tokens.
- `ui/src/ui/control-ui-auth.ts:23` prefers `hello.auth.deviceToken` over configured token/password for Control UI HTTP auth.
- `src/gateway/device-auth.ts:36` builds v3 device auth payloads with platform and device-family fields.
- `src/gateway/server/ws-connection/auth-context.ts:98` resolves shared, bootstrap, and device token candidates.
- `src/gateway/server/ws-connection/auth-context.ts:188` verifies bootstrap tokens before device-token fallback.
- `src/gateway/server/ws-connection/auth-context.ts:210` verifies device-token candidates and maps failures.
- `src/gateway/server/ws-connection/message-handler.ts:668` detects Control UI, browser UI, WebChat, and native app clients.
- `src/gateway/server/ws-connection/message-handler.ts:970` resolves final connect auth and device-token generation state.
- `src/gateway/server/ws-connection/message-handler.ts:1150` decides local silent pairing and trusted-CIDR node auto-approval.
- `src/gateway/server/ws-connection/message-handler.ts:1191` limits silent QR/setup-code bootstrap pairing to the exact setup profile.
- `src/gateway/server/ws-connection/message-handler.ts:1210` creates pending device pairing requests.
- `src/gateway/server/ws-connection/message-handler.ts:1245` silently approves eligible local/bootstrap pairing requests.
- `src/gateway/server/ws-connection/message-handler.ts:1516` issues device tokens after approved pairing.
- `src/gateway/server/ws-connection/message-handler.ts:1545` emits bounded extra bootstrap handoff tokens.
- `src/gateway/server/ws-connection/message-handler.ts:1858` redeems/revokes bootstrap tokens after connect.
- `src/infra/device-bootstrap.ts:228` issues setup-code bootstrap tokens.
- `src/infra/device-bootstrap.ts:407` verifies bootstrap tokens, device/public-key binding, and role/scope allowlists.
- `src/shared/device-bootstrap-profile.ts:13` defines QR/setup-code operator handoff scopes.
- `src/shared/device-bootstrap-profile.ts:22` defines the built-in setup bootstrap profile.
- `src/infra/device-pairing.ts:559` creates or refreshes pending device pairing requests.
- `src/infra/device-pairing.ts:617` approves device pairing and mints role tokens.
- `src/infra/device-pairing.ts:734` approves bootstrap device pairing within bootstrap profile limits.
- `src/infra/device-pairing.ts:924` verifies paired device tokens.
- `src/infra/device-pairing.ts:988` ensures/reuses device tokens inside approved baselines.
- `src/infra/device-pairing.ts:1077` rotates device tokens.
- `src/infra/device-pairing.ts:1138` revokes device tokens.
- `src/gateway/server-methods/devices.ts:175` implements `device.pair.list`.
- `src/gateway/server-methods/devices.ts:209` implements `device.pair.approve` authorization.
- `src/gateway/server-methods/devices.ts:341` implements `device.pair.remove`.
- `src/gateway/server-methods/devices.ts:400` implements `device.token.rotate`.
- `src/gateway/server-methods/devices.ts:496` implements `device.token.revoke`.
- `src/gateway/node-pairing-auto-approve.ts:36` excludes Control UI/WebChat/browser and upgrade flows from trusted-CIDR node auto-approval.
- `src/gateway/client.ts:581` stores device tokens from `hello-ok`.
- `src/gateway/client.ts:605` handles stored device-token retry after mismatch.
- `src/gateway/client.ts:802` reuses cached scopes only when reusing cached device tokens.
- `src/gateway/client.ts:877` gates stored-token retry.
- `src/gateway/client.ts:929` restricts automatic device-token retry to loopback or pinned TLS.
- `src/gateway/client.ts:948` selects shared token, device token, stored token, bootstrap token, and signature token precedence.
- `extensions/device-pair/index.ts:505` formats pasteable setup-code responses.
- `extensions/device-pair/index.ts:537` formats QR pairing guidance and security copy.
- `extensions/device-pair/index.ts:599` issues setup payloads with the pairing bootstrap profile.
- `extensions/device-pair/index.ts:663` registers `/pair` with `operator.pairing`.
- `extensions/device-pair/index.ts:800` sends QR media when supported.
- `extensions/device-pair/index.ts:835` renders WebChat QR fallback.
- `extensions/device-pair/pair-command-auth.ts:31` resolves `/pair` command authorization for WebChat/internal callers and channel owners.

### Integration tests

- `src/gateway/server.auth.control-ui.suite.ts:848` covers local-direct Control UI operator pairing auto-approval.
- `src/gateway/server.auth.control-ui.suite.ts:1031` covers QR setup-code returning a node token plus bounded operator handoff.
- `src/gateway/server.auth.control-ui.suite.ts:1451` covers bootstrap-auth role upgrades requiring approval.
- `src/gateway/server.auth.control-ui.suite.ts:1543` covers non-baseline bootstrap operator pairing being held for explicit approval.
- `src/gateway/server.auth.control-ui.suite.ts:1588` covers local-direct node pairing auto-approval followed by operator-scope approval.
- `src/gateway/server.auth.control-ui.suite.ts:1840` covers revoked device-token rejection.
- `src/gateway/server.auth.control-ui.suite.ts:1863` covers backend loopback shared-auth connections without device pairing.
- `src/gateway/server.shared-auth-rotation.test.ts:187` covers shared-token WebSocket sessions closing after auth rotation.
- `src/gateway/server.shared-auth-rotation.test.ts:203` covers existing device-token sessions staying connected after shared-token rotation.
- `src/gateway/server.shared-auth-rotation.test.ts:217` covers issuer-tagged device-token sessions closing after shared-token rotation.
- `src/gateway/server.shared-auth-rotation.test.ts:246` covers issuer-tagged browser device tokens on reconnect.
- `src/gateway/server.device-token-rotate-authz.test.ts:188` covers cross-device rotate/revoke denial for device-token callers.
- `src/gateway/server.device-token-rotate-authz.test.ts:237` covers admin cross-device rotate/revoke.
- `src/gateway/server.device-token-rotate-authz.test.ts:279` covers pairing-scoped operator denial for revoked node token rotation.
- `src/gateway/server.device-pair-approve-authz.test.ts:169` covers caller-scope limits on device approval.
- `src/gateway/server.node-pairing-auto-approve.test.ts:88` covers default denial for direct non-loopback node pairing.
- `src/gateway/server.node-pairing-auto-approve.test.ts:122` covers trusted-CIDR node auto-approval.
- `src/gateway/server.node-pairing-authz.test.ts:157` covers node pairing approval scope requirements.
- `test/gateway.multi.e2e.test.ts:27` covers two live gateway instances with WS, HTTP, and node pairing.

### Unit tests

- `src/gateway/device-auth.test.ts:18` covers v2 device auth payload vectors.
- `src/gateway/device-auth.test.ts:34` covers v3 device auth payload vectors.
- `src/gateway/client.test.ts:668` covers clearing stale tokens on device token mismatch close.
- `src/gateway/client.test.ts:1329` covers stored device token scopes.
- `src/gateway/client.test.ts:1409` covers bootstrap token use when no shared or device token is available.
- `src/gateway/client.test.ts:1429` covers explicit device token priority.
- `src/gateway/client.test.ts:1476` covers retry with stored device token after shared-token mismatch on trusted endpoints.
- `src/gateway/client.test.ts:1597` covers reconnect behavior for retryable `PAIRING_REQUIRED`.
- `src/gateway/method-scopes.test.ts:283` covers `operator.pairing` scope for node pairing approvals.
- `src/gateway/node-pairing-auto-approve.test.ts:124` covers Control UI/WebChat exclusion from node auto-approval.
- `src/gateway/server/ws-connection/handshake-auth-helpers.test.ts:141` covers WebChat/local pairing helper behavior.
- `extensions/device-pair/index.test.ts:1` covers setup-code/QR command behavior through mocked plugin APIs.
- `extensions/device-pair/pair-command-auth.test.ts:4` covers pairing command scope handling for gateway and channel callers.

### Gitcrawl queries

Query: `gitcrawl search issues "device pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 12`

Results:

- Open feature-specific results included #86778, #74484, #77807, #55914, #85966, #78276, #43903, #87058, #72418, #80828, #85868, and #67618.
- These results show current risk around proof-response failures, scope deadlocks, Android node/operator close behavior, setup-code races, multi-user token isolation, backend self-pairing bypass concerns, and missing pairing-error guidance.

Query: `gitcrawl search issues "setup code bootstrap token pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 12`

Results:

- Open results included #78276 for setup-code races reviving consumed bootstrap tokens and #48471 for one-line local bootstrap across daemon, dashboard auth, and Telegram owner setup.
- The setup-code path is implemented, but archive evidence keeps bootstrap race handling and first-run operator setup as active quality risks.

Query: `gitcrawl search issues "device token rotate revoke" -R openclaw/openclaw --state all --json number,title,state,url --limit 12`

Results:

- Results were broader credential-governance issues (#59165, #71116) rather than direct rotate/revoke bugs.
- Direct rotate/revoke risk was better represented by PR results and source/tests than this issue query.

Query: `gitcrawl search issues "Control UI pairing WebChat device token" -R openclaw/openclaw --state all --json number,title,state,url --limit 12`

Results:

- Open results included #43903 for multiple gateway tokens/multi-user isolation, #46656 for WebChat/Control UI inline button support, and #28847 for provider key cooldowns.
- The relevant signal is that Control UI/WebChat pairing overlaps with unresolved multi-user token isolation expectations.

Query: `gitcrawl search issues "auth migration device pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 12`

Results:

- Open results included #87058 for Android connect-nonce retry race and #69066 for separating internal service identity from user auth.
- Migration/auth-boundary reports continue to intersect with pairing when stale identities or internal service callers hit device pairing policy.

Query: `gitcrawl search issues "operator scope pairing" -R openclaw/openclaw --state all --json number,title,state,url --limit 12`

Results:

- Open results included #74484, #77807, #85966, #72418, #81876, #80836, #73864, #78276, #28847, #84989, #69066, and #78225.
- The strongest component-specific signals are scope deadlock, Android role confusion, possible local self-pairing bypass, configurable token scopes, service identity split, and setup-code races.

Query: `gitcrawl search prs "device pairing token" -R openclaw/openclaw --state all --json number,title,state,url --limit 10`

Results:

- Open PR results included #81189, #84617, #66257, #80896, #46794, #80656, #80779, #73163, #77538, and #81333.
- These show active work on last-seen refresh, pairing/token-management rate limits, local fallback, bootstrap token binding, setup-code binding, v2 compatibility, stale-approve routing, insecure Control UI warnings, and connect-frame bounds.

Query: `gitcrawl search prs "setup code bootstrap" -R openclaw/openclaw --state all --json number,title,state,url --limit 10`

Results:

- Open PR results included #78277, #46794, #63113, #84657, #78807, #84424, #79756, #83235, #82955, and #81300.
- Component-specific results show setup-code race fix work, setup-code/node approval binding, and private LAN mobile pairing auth still in flight.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 10 "device pairing"`

Results:

- Results included recent support guidance for mobile/node pairing, live gateway logs showing local `device pairing auto-approved`, users blocked by CLI scope re-approval, node-vs-operator pairing confusion, and Android gateway connection diagnostics.
- The strongest quality signal is that users still need guided triage for whether a device is paired as a node, as an operator, or only pending.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 10 "setup code bootstrap token"`

Results:

- Results included iOS Alpha `/pair qr` output with `wss://` IP certificate issues, maintainer notes that current main uses short-lived bootstrap tokens and device-token storage, a HarmonyOS review that missed the bootstrap-token auth field, and Android/Samsung reports of stale bootstrap-token reuse loops.
- The setup-code UX is real and documented, but TLS, client compatibility, and stale bootstrap-token recovery remain recurring support topics.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 10 "device token mismatch pairing required"`

Results:

- Results included user support threads diagnosing `pairing required`, `scope-upgrade`, Control UI not displaying agent output, token drift, loopback pairing, `openclaw devices rotate`, stale environment overrides, and macOS update reconnect loops.
- This lowers quality because the operational recovery path is still too easy to misdiagnose as a generic model, cron, dashboard, or gateway problem.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI pairing WebChat"`

Results:

- Results included release notes and support feedback that Control UI/WebChat worked after onboarding while skipped channel setup failed, plus issue comments about browser WebChat/Control UI device auth regression and Control UI pairing migration.
- Control UI/WebChat are usable, but the archives show they are still part of auth migration and pairing expectation management.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 10 "operator scope pairing required"`

Results:

- Results included raw `scope-upgrade` logs, Docker host/guest pairing fallback diagnosis, maintainer analysis of stale internal `gateway-client` identities, issue closures for local loopback `pairing required`, and Android review comments warning that adding `operator.admin` by default forces scope upgrades.
- The quality risk is not absent functionality; it is that stale identities and requested scopes can still create hard-to-unwind operator deadlocks.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 10 "auth migration pairing"`

Results:

- Results included channel ingress refactor notes, WebSocket device auth migration comments, setup-code handoff review notes, freshbits mentioning setup-code shared auth, and release guidance about breaking auth changes when both `gateway.auth.token` and `gateway.auth.password` are configured without explicit mode.
- Auth migration remains tied to pairing because legacy clients, stale state, and mixed auth config can surface as pairing failures.
