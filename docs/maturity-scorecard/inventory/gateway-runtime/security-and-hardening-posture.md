---
title: Gateway Runtime and WebSocket Feature Note - Security Controls
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: Security controls
feature_slug: security-and-hardening-posture
---

# Security Controls

## Summary

Coverage: 84/100, Yes. Quality: 74/100, Medium.

The Gateway/WebSocket security posture is implemented across docs, runtime auth
policy, WebSocket handshake enforcement, trusted-proxy checks, device and node
pairing, broadcast scope guards, remote node execution approval binding, and
browser-control relay hardening. Coverage is Yes because multiple real
Gateway/server-flow tests exercise browser origin policy, trusted-proxy
exceptions, Tailscale-style auth, auth protocol failures, trusted-CIDR node
auto-approval, node.invoke approval binding, and browser-control HTTP auth.

Quality stays Medium. The current implementation has strong hardening signals,
but archive history shows repeated serious regressions around trusted-proxy
boundaries, auth.mode=none exposure, browser-control auth, node-pairing
approval, rogue gateway trust, and node.invoke approval bypasses. Coverage-only
gaps remain for hardened topology proof, TLS pinning proof, unknown-event
server-flow proof, and remote browser-control relay proof; product and
operational gaps remain around service identity separation, additional exec
hard-deny controls, private-ingress footguns, and remote setup clarity.

## Features

- Non-loopback auth: Auth-required non-loopback exposure.
- Trusted proxy exceptions: Trusted-proxy and control-plane device-auth exceptions.
- Gateway and node trust boundaries: Gateway/node trust-domain definition.
- Trusted CIDR auto-approval: Trusted-CIDR limits for node auto-approval.
- Fail-closed protocol handling: Fail-fast/fail-closed behavior for protocol violations and unknown event families.
- Remote execution safeguards: Security posture around remote node execution and browser-control relay.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 84/100.

Label: Yes.

### Positive signals

- Security docs explicitly define the Gateway/node trust boundary, remote
  execution risk, device-pairing versus auth boundaries, trusted-CIDR limits,
  and browser-control sensitivity (`docs/gateway/security/index.md:166`,
  `docs/gateway/security/index.md:193`, `docs/gateway/security/index.md:214`,
  `docs/gateway/security/index.md:494`,
  `docs/gateway/security/index.md:1208`).
- Network exposure docs cover loopback default, non-loopback risk, reverse
  proxy and trusted proxy rules, Tailscale Serve identity limits, and public
  ingress avoidance (`docs/gateway/security/index.md:429`,
  `docs/gateway/security/index.md:473`,
  `docs/gateway/security/index.md:821`,
  `docs/gateway/security/index.md:927`,
  `docs/gateway/security/index.md:986`,
  `docs/gateway/security/index.md:1025`).
- Protocol docs cover auth modes, device-less exceptions, trusted endpoint
  retry limits, exec-approval binding, and unknown event families failing
  closed at broadcast scope evaluation (`docs/gateway/protocol.md:315`,
  `docs/gateway/protocol.md:621`, `docs/gateway/protocol.md:676`,
  `docs/gateway/protocol.md:704`, `docs/gateway/protocol.md:748`).
- Runtime auth enforces explicit auth configuration, rejects invalid
  token/password combinations, requires trusted-proxy source validation, rejects
  loopback trusted-proxy sources unless opted in, and serializes browser-origin
  auth failures (`src/gateway/startup-auth.ts:125`,
  `src/gateway/auth-mode-policy.ts:21`, `src/gateway/auth.ts:222`,
  `src/gateway/auth.ts:270`, `src/gateway/auth.ts:400`).
- WebSocket handshake code fails closed for malformed pre-auth payloads,
  non-connect first requests, protocol mismatches, browser-origin mismatch,
  missing or invalid device identity, and unauthorized calls
  (`src/gateway/server/ws-connection/message-handler.ts:480`,
  `src/gateway/server/ws-connection/message-handler.ts:523`,
  `src/gateway/server/ws-connection/message-handler.ts:614`,
  `src/gateway/server/ws-connection/message-handler.ts:670`,
  `src/gateway/server/ws-connection/message-handler.ts:805`,
  `src/gateway/server/ws-connection/message-handler.ts:879`,
  `src/gateway/server/ws-connection/message-handler.ts:997`,
  `src/gateway/server/ws-connection/message-handler.ts:1941`).
- Real Gateway/server-flow tests cover trusted-proxy browser origins,
  non-Control UI browser scope clearing, browser origin allowlists, remote auth
  failure rate limits, local Control UI auto-pairing, Tailscale-style auth,
  protocol mismatch close behavior, invalid connect params, missing nonce
  rejection, trusted-CIDR node auto-approval, node.invoke approval binding, and
  browser-control auth fail-closed behavior
  (`src/gateway/server.auth.browser-hardening.test.ts:152`,
  `src/gateway/server.auth.browser-hardening.test.ts:177`,
  `src/gateway/server.auth.browser-hardening.test.ts:217`,
  `src/gateway/server.auth.browser-hardening.test.ts:283`,
  `src/gateway/server.auth.browser-hardening.test.ts:427`,
  `src/gateway/server.auth.modes.suite.ts:181`,
  `src/gateway/server.auth.default-token.suite.ts:418`,
  `src/gateway/server.auth.default-token.suite.ts:481`,
  `src/gateway/server.auth.default-token.suite.ts:524`,
  `src/gateway/server.node-pairing-auto-approve.test.ts:122`,
  `src/gateway/server.node-invoke-approval-bypass.test.ts:503`,
  `extensions/browser/src/browser/server.auth-fail-closed.test.ts:94`).

### Negative signals

- The strongest real-flow coverage is local server-flow coverage. I did not find
  one live or e2e hardened topology test that proves reverse proxy, Tailscale
  Serve, tailnet, LAN, public ingress, TLS pinning, and device/node auth
  together.
- `auth.mode=none` remains an explicit private-ingress mode. The product warns
  and documents the risk, but non-loopback exposure is not a universal startup
  hard fail because private deployments are intentionally supported
  (`src/gateway/auth.ts:504`, `docs/gateway/protocol.md:676`).
- Unknown broadcast event families fail closed in a focused unit surface, but I
  did not find a real WebSocket/server integration test that sends an unknown
  event family through the broadcast path (`src/gateway/server-broadcast.ts:62`,
  `src/gateway/gateway-misc.test.ts:461`).
- Trusted-CIDR auto-approval has good direct tests, but the integration happy
  path is conditional on a non-loopback self-connect being available in the
  runtime environment (`src/gateway/server.node-pairing-auto-approve.test.ts:122`).
- Archive results show multiple historical high-severity regressions in this
  area, including auth.mode=none over Tailscale Serve, browser-control auth gaps,
  node pairing before approval, rogue gateway trust, and node.invoke approval
  bypasses.

### Integration gaps

- Add a real hardened topology proof for reverse proxy and Tailscale Serve that
  exercises auth, allowed origins, forwarded-header trust, device identity, and
  WebSocket upgrade behavior against a real Gateway.
- Add a public-ingress or simulated hostile-ingress proof that shows unauth or
  misconfigured auth fails closed without relying only on docs or startup
  warnings.
- Add a remote WSS/TLS fingerprint proof that covers first trust, stale pin, and
  rogue gateway rejection for the same route used by remote nodes or clients.
- Add an integration test for unknown event-family deny behavior through the
  server broadcast path, not only the event scope helper.
- Add a non-conditional trusted-CIDR integration lane or Testbox/Crabbox proof
  for real non-loopback node auto-approval.

## Quality

Score: 74/100.

Label: Medium.

### gitcrawl reports

- `gateway auth non-loopback trusted proxy` returned 16 issue results. Notable
  results: #69066 open "[RFC] Separate internal service identity from user auth
  in OpenClaw gateway"; #50630 closed "Tailscale serve + auth.mode=none exposes
  gateway to full Tailnet without authentication"; #50628 closed "Browser
  control server installs no authentication when gateway auth mode is
  trusted-proxy"; #50644 closed "gateway.auth.mode=none propagates silently to
  browser control server"; #82607 closed trusted-proxy loopback fallback bug.
- `gateway trusted cidr node pairing auto approve` returned 0 issue results.
  The more specific `autoApproveCidrs` query returned #72857 closed "PR #22280
  Regression: scope upgrade still requires pairing on 2026.4.25 (VPS/lan bind)".
- `trusted CIDR node pairing` returned #84447 open "[Feature]: Per-sender
  inbound DM rate limit for channel pairing/allowlist policies", which is
  adjacent policy/rate-limit work rather than a direct trusted-CIDR bug.
- `gateway protocol unknown event fail closed` returned #74632 open "Add
  per-session envelope to sessions.create / sessions.patch", which is adjacent
  protocol-shape work, not a direct unknown-event security report.
- `browser control gateway auth trusted proxy node proxy security` returned 7
  issue results. Notable results: #50644 closed browser-control unauthenticated
  API exposure; #30092 closed Control UI device-required behavior behind a local
  HTTPS reverse proxy; #41047 closed Dashboard Control UI token delivery issue;
  #66983 open web canvas node support.
- `node.invoke system.run approval bypass` returned 3 closed issue results:
  #65542 "Device pairing alone exposes exec-capable nodes before admin node
  approval"; #65168 "node.invoke stays reachable before node pairing approval
  exists"; #50642 "macOS node auto-trusts first TLS certificate and accepts
  rogue gateway control".
- `gateway auth non-loopback trusted proxy browser control security` PR search
  returned 13 PRs, including closed hardening PRs #20686, #61004, #63379,
  #64122, #65639, #79643, and #58812.
- `node invoke approval bypass system.run` PR search returned 18 PRs, including
  closed hardening PRs #8683, #10129, #24682, #24826, #25733, #25749, #65169,
  #65543, #79781, and open #81827 "add tools.exec.denyPathPatterns hard-deny
  gate (#74379)".

### discrawl reports

- `gateway auth non-loopback trusted proxy` returned recent support and review
  discussion around loopback versus LAN/tailnet/custom binds, token/password
  versus trusted-proxy mode, Tailscale Serve guidance, same-host reverse proxy
  behavior, `NODE_EXTRA_CA_CERTS`, and PR #59190 trusted-proxy loopback
  hardening.
- `auth.mode=none exposes gateway` returned the #50630/#50631 incident cluster:
  Tailscale Serve plus `auth.mode=none` was described as a full Tailnet exposure
  risk and review asked setup/install paths to reject the unsafe combination.
- `trusted CIDR node pairing auto approve` returned the #61004 implementation
  thread plus review evidence that the change had narrow scope and a P1 review
  caught re-pair auto-approval risk for existing device IDs.
- `browser control auth gateway trusted proxy` returned the #63280/#65639
  hardening cluster: browser-control auth token generation for none/trusted-proxy
  modes, fail-closed startup when auth bootstrap is missing, origin checks, and
  discussion that 45+ browser-control routes had been reachable to loopback/SSRF
  callers.
- `node invoke system run approval bypass` returned support discussions showing
  the node command layer intentionally routes through `system.run.prepare` and
  approval binding, including user-visible friction around inline interpreter
  commands and allowlisted commands.
- `node.invoke system.run approval bypass` returned no visible Discrawl results;
  the adjacent no-dot query above was needed to capture relevant discussion.
- `unknown event fail closed gateway protocol` returned no visible Discrawl
  results. Adjacent queries found protocol mismatch and 1008 policy-violation
  support discussions but not a direct unknown-event fail-closed report.
- `unknown gateway event protocol` returned a beta-upgrade discussion where a
  restart probe used WebSocket protocol 3 against a protocol 4 Gateway, plus a
  separate user report about missing tool event fields and raw call-token
  leakage.
- `gateway protocol invalid message close 1008` returned support guidance that
  1008 means intentional policy violation close for auth, origin, protocol,
  rate-limit, or invalid-message failures.

### Good qualities

- Auth configuration is fail-closed for missing token/password and invalid
  mixed-mode setup, while token mode can generate a startup token instead of
  silently accepting unauthenticated access (`src/gateway/startup-auth.ts:125`,
  `src/gateway/auth-mode-policy.ts:21`, `src/gateway/auth.ts:222`).
- Trusted-proxy auth distinguishes trusted source IPs, loopback-source
  exceptions, local interface sources, required identity headers, and allowed
  users (`src/gateway/auth.ts:270`, `src/gateway/auth.ts:454`).
- Forwarded headers from untrusted addresses do not create local trust, which
  protects loopback-only shortcuts behind proxies
  (`src/gateway/server/ws-connection/message-handler.ts:411`).
- Node auto-approval is narrow: disabled unless explicit CIDRs are configured,
  only fresh unpaired role=node requests with no requested scopes are eligible,
  and browser, Control UI, WebChat, loopback trusted-proxy, missing-IP, and
  upgrade cases are rejected (`src/gateway/node-pairing-auto-approve.ts:30`).
- Event fanout uses allow-by-scope guards and denies unknown event families by
  default (`src/gateway/server-broadcast.ts:18`,
  `src/gateway/server-broadcast.ts:62`).
- `node.invoke` strips or blocks caller-supplied approval and browser.proxy
  mutations before forwarding, and system.run approval validation binds exact
  run, node, command, cwd, agent, and session context
  (`src/gateway/server-methods/nodes.ts:1046`,
  `src/gateway/node-invoke-system-run-approval.ts:214`,
  `src/gateway/node-invoke-system-run-approval.ts:257`,
  `src/gateway/node-invoke-system-run-approval.ts:340`).
- Browser control has shared-secret auth helpers, fail-closed bridge startup,
  persistent-profile mutation blocks, SSRF protections, and security audit
  findings for unauthenticated browser-control routes
  (`extensions/browser/src/browser/http-auth.ts:40`,
  `extensions/browser/src/browser/bridge-server.ts:78`,
  `extensions/browser/src/gateway/browser-request.ts:147`,
  `extensions/browser/src/node-host/invoke-browser.ts:223`,
  `extensions/browser/src/security-audit.ts:68`).

### Bad qualities

- The security policy is intentionally broad and cross-cutting. Correctness
  depends on auth config, WebSocket connect policy, device auth, trusted-proxy
  header trust, browser-origin checks, node pairing, broadcast scoping, node
  invoke forwarding, and browser-control plugin code staying aligned.
- Archive history contains several severe closed regressions, so the feature
  family has a demonstrated tendency to regress at boundaries between trusted
  proxy, private ingress, browser control, node pairing, and remote exec.
- `auth.mode=none` is still a powerful operator footgun for non-loopback private
  deployments. Docs warn against public exposure, but the runtime supports it as
  a private-ingress contract.
- Browser-control hardening is split between core Gateway forwarding and the
  browser plugin host. That split is reasonable for ownership, but it raises the
  operator and maintainer cost of keeping auth, SSRF, profile-mutation, and node
  command policy aligned across the two surfaces.
- Service identity and user auth are still coupled enough that #69066 remains
  open, and #81827 shows additional expected exec hard-deny controls have not
  landed yet.
- Discrawl support threads show recurring operator friction around remote
  Gateway setup, trusted-proxy mode selection, Tailscale Serve guidance, and
  node command approval behavior.

## Known gaps

### Implemented capabilities in scope

- Auth-required non-loopback exposure is documented and largely enforced through
  startup auth generation, explicit auth modes, client-side insecure remote WS
  blocking, browser allowed-origin checks, and non-loopback warnings
  (`docs/gateway/security/index.md:821`, `docs/gateway/security/index.md:927`,
  `src/gateway/startup-auth.ts:125`, `src/gateway/client.ts:312`,
  `src/gateway/net.ts:474`, `src/gateway/server-runtime-state.ts:210`).
- Trusted-proxy and Control UI device-auth exceptions are documented and
  implemented with narrow source/header checks and explicit break-glass
  conditions (`docs/gateway/trusted-proxy-auth.md:52`,
  `docs/gateway/trusted-proxy-auth.md:77`,
  `src/gateway/server/ws-connection/connect-policy.ts:37`,
  `src/gateway/server/ws-connection/connect-policy.ts:102`).
- Gateway/node trust-domain definitions, remote execution warnings, topology
  guidance, trusted-CIDR limits, protocol fail-fast behavior, remote node
  execution hardening, and browser-control relay hardening are documented or
  implemented in the cited docs/source surfaces.

### Product and operational gaps

- Runtime supports `auth.mode=none` for private ingress; this is documented, but
  it remains a powerful operator footgun for non-loopback deployments.
- #69066 remains open for separating internal service identity from user auth in
  OpenClaw Gateway.
- #81827 remains open for adding `tools.exec.denyPathPatterns` hard-deny gate.
- #84447 is adjacent pairing/rate-limit policy work, and #66983 would add
  another browser/node trust surface if accepted.
- Discrawl support threads show ongoing operator requests for clearer remote
  Gateway setup, trusted-proxy mode selection, Tailscale Serve guidance, and
  node command approval behavior.

### Coverage-only gaps

- No complete live/e2e hardened remote topology proof was found for reverse
  proxy, Tailscale Serve, tailnet/LAN, public ingress simulation, TLS pinning,
  and device/node auth together.
- Unknown event-family deny behavior lacks real Gateway/server-flow coverage.
- Browser-control remote topology guidance is strong, but the audit did not find
  a full remote node/browser-control relay proof that combines auth, node
  pairing, browser route auth, SSRF policy, and profile mutation controls.

## Evidence

### Docs

- `docs/gateway/security/index.md:166` defines Gateway and node trust domains.
- `docs/gateway/security/index.md:193` summarizes Gateway auth, node pairing,
  node command, and trusted-CIDR security boundaries.
- `docs/gateway/security/index.md:214` documents trusted-CIDR auto-approval as
  disabled by default with narrow eligibility.
- `docs/gateway/security/index.md:429` documents reverse-proxy header trust and
  trusted-proxy loopback fail-closed behavior.
- `docs/gateway/security/index.md:473` documents non-loopback Control UI origin
  and DNS rebinding/proxy-host hardening.
- `docs/gateway/security/index.md:494` documents paired macOS node system.run
  as remote code execution and explains approval binding.
- `docs/gateway/security/index.md:821` documents loopback default and
  non-loopback attack-surface expansion.
- `docs/gateway/security/index.md:927` documents Gateway auth defaults,
  fail-closed unresolved auth, and optional TLS pin.
- `docs/gateway/security/index.md:963` documents local device pairing and
  forwarded-header locality limits.
- `docs/gateway/security/index.md:986` documents Tailscale Serve identity
  headers and tokenless Serve tradeoffs.
- `docs/gateway/security/index.md:1025` documents trusted reverse-proxy setup.
- `docs/gateway/security/index.md:1033` documents remote browser-control
  topology guidance.
- `docs/gateway/security/index.md:1208` documents browser profile sensitivity
  and browser-control auth boundaries.
- `docs/gateway/security/index.md:1225` documents browser SSRF policy.
- `docs/gateway/protocol.md:315` documents broadcast scope gating and unknown
  event families failing closed.
- `docs/gateway/protocol.md:621` documents `systemRunPlan` approval binding.
- `docs/gateway/protocol.md:676` documents auth modes and private-ingress
  `none` cautions.
- `docs/gateway/protocol.md:704` documents trusted endpoint limits for cached
  device-token retry.
- `docs/gateway/protocol.md:748` documents device identity, pairing, and
  device-less exceptions.
- `docs/gateway/discovery.md:79` documents unauthenticated discovery hints and
  TLS-pin precedence.
- `docs/gateway/discovery.md:111` documents that discovery hints do not relax
  transport security.
- `docs/gateway/trusted-proxy-auth.md:52` documents Control UI trusted-proxy
  pairing behavior.
- `docs/gateway/trusted-proxy-auth.md:77` documents trusted-proxy config and
  `allowLoopback=false` defaults.
- `docs/gateway/pairing.md:125` documents trusted-CIDR node auto-approval.
- `docs/gateway/pairing.md:173` documents forwarded-header locality limits.
- `docs/tools/browser-control.md:37` documents browser-control shared-secret
  auth and loopback boundaries.
- `docs/tools/browser-control.md:360` documents browser profile sensitivity and
  remote CDP risk.

### Source

- `src/gateway/startup-auth.ts:125` resolves startup auth and generates or
  rejects credentials.
- `src/gateway/auth-mode-policy.ts:21` rejects token/password config without an
  explicit auth mode.
- `src/gateway/auth.ts:222` asserts auth is configured.
- `src/gateway/auth.ts:270` authorizes trusted-proxy requests.
- `src/gateway/auth.ts:400` rate-limits browser-origin auth failures.
- `src/gateway/auth.ts:454` resolves Gateway connect auth across shared,
  trusted-proxy, and local-direct paths.
- `src/gateway/auth.ts:504` implements `auth.mode=none`.
- `src/gateway/server-runtime-state.ts:210` warns on non-loopback bind.
- `src/gateway/client.ts:312` blocks insecure remote WebSocket URLs.
- `src/gateway/net.ts:474` classifies secure WebSocket URLs.
- `src/gateway/server/ws-connection/message-handler.ts:411` rejects untrusted
  forwarded-header locality.
- `src/gateway/server/ws-connection/message-handler.ts:480` closes on oversized
  pre-auth payloads.
- `src/gateway/server/ws-connection/message-handler.ts:523` requires the first
  frame to be `connect`.
- `src/gateway/server/ws-connection/message-handler.ts:614` closes protocol
  mismatches.
- `src/gateway/server/ws-connection/message-handler.ts:670` enforces browser
  origin policy.
- `src/gateway/server/ws-connection/message-handler.ts:805` applies missing
  device identity policy.
- `src/gateway/server/ws-connection/message-handler.ts:879` validates signed
  device auth.
- `src/gateway/server/ws-connection/message-handler.ts:997` requires successful
  auth before connect.
- `src/gateway/server/ws-connection/message-handler.ts:1888` rejects
  post-handshake non-request frames.
- `src/gateway/server/ws-connection/message-handler.ts:1919` closes stale
  shared-auth generations.
- `src/gateway/server/ws-connection/message-handler.ts:1941` closes repeated
  unauthorized calls.
- `src/gateway/server/ws-connection/connect-policy.ts:37` limits Control UI
  pairing bypasses.
- `src/gateway/server/ws-connection/connect-policy.ts:102` handles missing
  device identity exceptions and rejections.
- `src/gateway/node-pairing-auto-approve.ts:30` implements trusted-CIDR node
  auto-approval eligibility.
- `src/gateway/server-broadcast.ts:18` defines event scope guards.
- `src/gateway/server-broadcast.ts:62` denies unknown event families.
- `src/gateway/server-broadcast.ts:144` filters event delivery by client scope.
- `src/gateway/node-invoke-system-run-approval.ts:214` gates caller-supplied
  approval flags behind a real exec approval record.
- `src/gateway/node-invoke-system-run-approval.ts:257` validates approval
  existence, expiry, and node binding.
- `src/gateway/node-invoke-system-run-approval.ts:340` binds approvals to the
  canonical `systemRunPlan` context.
- `src/gateway/server-methods/nodes.ts:1046` rejects malformed and forbidden
  node.invoke payloads.
- `src/gateway/server-methods/nodes.ts:1180` applies node command allowlists and
  forwarding sanitization.
- `src/node-host/invoke-system-run.ts:547` rejects mutable script/file operand
  drift.
- `extensions/browser/src/browser/http-auth.ts:40` authorizes browser-control
  HTTP requests with bearer token or password auth.
- `extensions/browser/src/browser/bridge-server.ts:78` requires bridge-server
  auth and installs browser auth middleware.
- `extensions/browser/src/gateway/browser-request.ts:147` blocks invalid browser
  relay methods and persistent profile mutation.
- `extensions/browser/src/gateway/browser-request.ts:187` requires
  `browser.proxy` node command permission.
- `extensions/browser/src/node-host/invoke-browser.ts:223` blocks persistent
  profile mutation on the node-host browser path.
- `extensions/browser/src/security-audit.ts:68` flags browser control without
  auth.

### Integration tests

- `src/gateway/server.auth.browser-hardening.test.ts:152` covers
  trusted-proxy browser-origin policy.
- `src/gateway/server.auth.browser-hardening.test.ts:177` covers non-Control UI
  browser sessions with trusted-proxy auth clearing scopes.
- `src/gateway/server.auth.browser-hardening.test.ts:217` covers browser origin
  allowlists.
- `src/gateway/server.auth.browser-hardening.test.ts:241` rejects non-local
  browser origins and browser-origin TUI claims.
- `src/gateway/server.auth.browser-hardening.test.ts:283` rate-limits remote
  auth failures.
- `src/gateway/server.auth.browser-hardening.test.ts:427` auto-pairs local
  Control UI browser clients with valid token.
- `src/gateway/server.auth.modes.suite.ts:137` covers loopback connect in auth
  none mode.
- `src/gateway/server.auth.modes.suite.ts:181` covers Tailscale auth still
  requiring device identity.
- `src/gateway/server.auth.default-token.suite.ts:418` rejects protocol
  mismatches.
- `src/gateway/server.auth.default-token.suite.ts:470` rejects non-connect
  first requests.
- `src/gateway/server.auth.default-token.suite.ts:481` requires nonce for device
  auth.
- `src/gateway/server.auth.default-token.suite.ts:524` rejects invalid connect
  params and closes 1008.
- `src/gateway/server.node-pairing-auto-approve.test.ts:88` keeps
  non-loopback direct nodes manual by default.
- `src/gateway/server.node-pairing-auto-approve.test.ts:122` covers first-time
  node trusted-CIDR auto-approval when a non-loopback self-connect is available.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:409` rejects malformed
  and forbidden node.invoke payloads before forwarding.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:470` rejects
  browser.proxy persistent profile mutations before forwarding.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:503` binds system.run
  approvals to decision and device and strips injected fields.
- `src/gateway/server.node-invoke-approval-bypass.test.ts:581` blocks backend
  reconnect replay mismatches.
- `extensions/browser/src/browser/server.auth-token-gates-http.test.ts:47`
  requires browser-control route bearer auth.
- `extensions/browser/src/browser/server.auth-token-gates-http.test.ts:70`
  rejects wrong auth mode credentials.
- `extensions/browser/src/browser/server.auth-fail-closed.test.ts:94` fails
  closed when browser-control auth bootstrap fails.

### Unit tests

- `src/gateway/client.test.ts:318` blocks non-loopback plaintext WebSocket URLs.
- `src/gateway/call.test.ts:890` reports insecure remote Gateway URL errors.
- `src/gateway/node-pairing-auto-approve.test.ts:68` proves auto-approval is
  disabled by default.
- `src/gateway/node-pairing-auto-approve.test.ts:78` covers matching CIDR/IP
  acceptance.
- `src/gateway/node-pairing-auto-approve.test.ts:102` covers trusted-CIDR
  rejection cases.
- `src/gateway/node-pairing-auto-approve.test.ts:147` rejects role/scope and
  metadata upgrade attempts.
- `src/gateway/gateway-misc.test.ts:357` filters approval and pairing events by
  scope.
- `src/gateway/gateway-misc.test.ts:405` requires operator.read for chat-class
  events.
- `src/gateway/gateway-misc.test.ts:437` requires write/admin for plugin events.
- `src/gateway/gateway-misc.test.ts:461` denies unknown events by default.
- `src/gateway/gateway-misc.test.ts:534` preserves per-receiving-client sequence
  numbers when scoped events are filtered.
- `extensions/browser/src/node-host/invoke-browser.test.ts:390` covers
  persistent profile mutation rejection.
- `extensions/browser/src/security-audit.test.ts:28` flags browser-control routes
  without auth.

### gitcrawl queries

- Query:
  `gitcrawl search issues 'gateway auth non-loopback trusted proxy' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 16 issues. Notable direct or adjacent results: #26007 closed
  trustedProxy.loopbackUser feature request; #82607 closed trusted-proxy
  loopback fallback bug; #50580 closed trusted-proxy cron/tool auth failure;
  #69066 open internal service identity RFC; #50630 closed Tailscale Serve plus
  auth none exposure; #71103 closed trustedProxies loopback WS pairing bug;
  #50628 closed browser-control no-auth under trusted-proxy; #50022 closed
  missing-origin scope stripping bypass; #82406 closed Slack trusted-proxy
  ingress; #68403 closed weak-secret guard bypass; #50644 closed browser-control
  auth none propagation.
- Query:
  `gitcrawl search issues 'gateway trusted cidr node pairing auto approve' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 0 issues.
- Query:
  `gitcrawl search issues 'gateway protocol unknown event fail closed' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 1 issue, #74632 open "Add per-session envelope to sessions.create /
  sessions.patch"; adjacent protocol work, not a direct unknown-event report.
- Query:
  `gitcrawl search issues 'browser control gateway auth trusted proxy node proxy security' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 7 issues. Notable results: #30092 closed Control UI local HTTPS
  reverse-proxy device-required behavior; #50644 closed browser-control no-auth
  propagation; #66983 open web canvas node support; #41047 closed Dashboard
  token delivery issue.
- Query:
  `gitcrawl search issues 'node.invoke system.run approval bypass remote execution' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 3 closed issues: #65542, #65168, #50642.
- Query:
  `gitcrawl search issues 'autoApproveCidrs' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 1 closed issue, #72857.
- Query:
  `gitcrawl search issues 'trusted CIDR node pairing' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 1 open issue, #84447, adjacent pairing/rate-limit policy work.
- Query:
  `gitcrawl search prs 'gateway auth non-loopback trusted proxy browser control security' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 13 PRs. Notable closed hardening PRs: #20686, #61004, #63379,
  #64122, #65639, #79643, #58812.
- Query:
  `gitcrawl search prs 'node.invoke system.run approval bypass browser.proxy' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 0 PRs.
- Query:
  `gitcrawl search prs 'node invoke approval bypass system.run' -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`
  Result: 18 PRs. Notable results: #79781, #25733, #8683, #25749, #24826,
  #10129, #65169, #65543, #59182, #62439, #81827 open, #24682, #81197, #65713,
  #62078, #78518.

### discrawl queries

- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "gateway auth non-loopback trusted proxy"`
  Result: returned support and review hits about loopback/local-only versus
  LAN/tailnet/custom binds, token/password versus trusted-proxy mode, Tailscale
  Serve, Cloudflared, same-host reverse proxies, trusted-proxy loopback-source
  behavior, `NODE_EXTRA_CA_CERTS`, and PR #59190/#63379/#43820 discussions.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "auth.mode=none exposes gateway"`
  Result: returned the #50630/#50631 incident cluster and review notes calling
  Tailscale Serve plus `auth.mode=none` a full Tailnet exposure risk.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "trusted CIDR node pairing auto approve"`
  Result: returned #61004 implementation and review discussion, including a
  helper-level coverage note and a P1 concern about re-pair auto-approval.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "browser control auth gateway trusted proxy"`
  Result: returned #63280/#65639 browser-control hardening discussion, including
  auth token generation for none/trusted-proxy modes, fail-closed startup, origin
  checks, and browser-control route exposure concerns.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "unknown event fail closed gateway protocol"`
  Result: no visible results.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "node.invoke system.run approval bypass"`
  Result: no visible results.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "node invoke system run approval bypass"`
  Result: returned support threads explaining `nodes run` routes through
  `system.run.prepare`, `exec.approval.request`, and approval binding; also
  captured user-visible friction around inline interpreter commands and
  allowlisted commands still prompting.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "unknown gateway event protocol"`
  Result: returned protocol mismatch and event-shape discussions, including a
  beta upgrade where CLI probe protocol 3 hit a protocol 4 Gateway and a user
  report about missing toolName in after_tool_call plus raw call-token leakage.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "gateway protocol invalid message close 1008"`
  Result: returned support guidance that 1008 is an intentional policy-violation
  close for auth, origin, protocol, rate-limit, or invalid-message failures.
