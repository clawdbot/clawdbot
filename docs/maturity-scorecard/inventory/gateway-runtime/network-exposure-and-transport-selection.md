---
title: Gateway Runtime and WebSocket Feature Note - Network Access and Discovery
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: Network access and discovery
feature_slug: network-exposure-and-transport-selection
---

# Network Access and Discovery

## Summary

OpenClaw has a substantial implementation for Gateway exposure and transport
selection: documented loopback/LAN/tailnet bind modes, remote direct versus SSH
transport, Bonjour and wide-area DNS-SD discovery, MagicDNS/Tailscale hints, TLS
runtime support, and client-side TLS fingerprint pinning. Coverage evidence is
strongest in docs, config/source contracts, macOS and mobile client tests, and
handler/server slices. Quality is limited by archive-reported regressions and
operator confusion around remote Gateway setup, bind modes, SSH tunnel behavior,
Tailscale Serve, and TLS pinning.

Scores:

- Coverage: 68% - Partial
- Quality: 62% - Medium

## Features

- Loopback and LAN access: Loopback and LAN-facing Gateway exposure.
- Tailnet access: Tailnet-facing Gateway exposure and MagicDNS/Tailscale routing.
- SSH tunnels: SSH tunneling as the fallback remote path.
- Endpoint discovery: Bonjour/DNS-SD discovery, wide-area DNS-SD, and advertised transport hints.
- Saved endpoints: Saved remote Gateway endpoints and route preference order.
- TLS pinning: TLS enablement and optional certificate fingerprint pinning.

## Archive Freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 68%

Label: Partial

### Positive signals

- Real Gateway/server-flow evidence exists for browser-origin and proxy-origin
  network hardening through `withGatewayServer` WebSocket tests:
  `src/gateway/server.auth.browser-hardening.test.ts:109`,
  `src/gateway/server.auth.browser-hardening.test.ts:152`,
  `src/gateway/server.auth.browser-hardening.test.ts:217`.
- Control UI auth tests include a Tailscale-style WebSocket path:
  `src/gateway/server.auth.control-ui.suite.ts:954`.
- Gateway startup has an e2e-style network runtime test that starts a Gateway
  server with loopback bind under a real runtime environment:
  `src/gateway/server-network-runtime.e2e.test.ts:68`,
  `src/gateway/server-network-runtime.e2e.test.ts:104`.
- Unit and client tests cover bind resolution, direct/remote URL selection,
  plaintext remote blocking, private ws exceptions, TLS fingerprint forwarding,
  Bonjour/wide-area discovery context, and Tailscale helper behavior:
  `src/gateway/net.test.ts:668`,
  `src/gateway/call.test.ts:490`,
  `src/gateway/call.test.ts:537`,
  `src/gateway/call.test.ts:750`,
  `src/gateway/server-discovery-runtime.test.ts:85`,
  `src/gateway/server-discovery-runtime.test.ts:215`,
  `src/infra/tls/gateway.test.ts:79`,
  `src/infra/tailscale.test.ts:62`.
- macOS discovery and remote transport selection have focused tests:
  `apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryModelTests.swift:84`,
  `apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryModelTests.swift:130`,
  `apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryHelpersTests.swift:45`,
  `apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryHelpersTests.swift:72`.
- iOS connection security tests cover discovered TLS pin trust, manual
  non-loopback TLS forcing, private LAN plaintext allowance, and stale-pin
  recovery:
  `apps/ios/Tests/GatewayConnectionSecurityTests.swift:39`,
  `apps/ios/Tests/GatewayConnectionSecurityTests.swift:106`,
  `apps/ios/Tests/GatewayConnectionSecurityTests.swift:122`,
  `apps/ios/Tests/GatewayConnectionSecurityTests.swift:159`.

### Negative signals

- No single integration/e2e/live test was found that proves the whole feature
  family as a workflow: discover a Gateway, choose direct/SSH from route
  preference, persist the target, connect over the selected route, and validate
  TLS pinning.
- LAN/tailnet bind and direct remote routing are well covered by source and unit
  tests, but not by a full real network topology test.
- SSH tunnel behavior is implemented and tested in focused macOS/CLI units, but
  the evidence does not show a real SSH tunnel connected to a real Gateway in an
  integration lane.
- TLS and pinning have runtime/unit/client tests, plus app tests, but no broad
  server-plus-client WSS fingerprint integration that exercises remote direct
  selection end to end.

### Integration gaps

- Add a real Gateway scenario that uses `gateway.bind=tailnet` or an equivalent
  private interface and proves a remote client reaches it without falling back
  to loopback.
- Add an SSH transport scenario that starts a real local port forward and proves
  `gateway.remote.transport="ssh"` reaches the remote Gateway.
- Add a discovery-to-connect scenario for Bonjour or wide-area DNS-SD that
  verifies resolved service endpoint preference over unauthenticated TXT hints.
- Add a WSS/fingerprint scenario that proves configured and stored pins are
  honored across the same connection path used by remote clients.

## Quality

Score: 62%

Label: Medium

### gitcrawl reports

Feature-specific issue searches found multiple current or historical bugs around
the same surface:

- `gitcrawl search issues "gateway remote" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 results. Notable results: #65355 open
  "gateway probe false-negatives on remote configRemote because non-loopback
  targets are hard-capped to 1500ms"; #40527 open "Remote skill bin probe times
  out when node is co-located with gateway"; #67336 closed "macOS Remote over
  SSH rewrites browser path to discovered ws:// host URL"; #16674 closed "macOS
  remote onboarding ... token/pairing/SSH path flow is too fragile"; #53128
  closed "`onboard --install-daemon` does not set `gateway.remote.token`".
- `gitcrawl search issues "gateway bind tailnet lan loopback" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 results. Notable results: #9275 closed "Improve gateway.bind
  validation error messages and auth enforcement"; #8823 closed "CLI RPC probe
  hardcodes ws://127.0.0.1 when gateway.bind is lan"; #50607 closed "CLI
  management commands fail when gateway.bind=tailnet"; #24011 closed
  "sessions_spawn broken with bind=tailnet"; #49253 closed "Feature request:
  grant operator scopes to token-authenticated non-loopback connections"; #50630
  closed "Tailscale serve + auth.mode=none exposes gateway".
- `gitcrawl search issues "gateway discovery Bonjour DNS-SD MagicDNS" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 0 results.
- `gitcrawl search issues "gateway ssh tunnel remote" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 results. Notable results: #26250 open "SSH transport security
  check rejects connection before tunnel is established"; #47342 open "Node
  host: no SSH transport support + challenge auth fails behind reverse proxy";
  #69135 open "`gateway probe`: false positive multiple reachable gateways when
  SSH tunnel + remote.url hit the same gateway"; #3296 closed "Node frequently
  disconnects when connected via SSH tunnel over Tailscale"; #21227 closed
  "nodes tool: SECURITY ERROR blocks ws:// LAN gateway".
- `gitcrawl search issues "Tailscale Serve gateway remote" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 results. Notable results: #84959 closed "Node pairing fails over
  Tailscale Serve"; #54008 closed "WebSocket upgrade fails via Tailscale Serve
  HTTPS proxy"; #14561 closed "Device pairing: pending requests not created for
  Control UI via Tailscale Serve"; #55218 closed "Control UI throws missing
  scope ... over Tailscale Serve"; #42931 closed "Remote Control UI over
  Tailscale stays stuck on pairing required".
- `gitcrawl search issues "tlsFingerprint" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 6 results: #66279 open "TUI fails against local TLS gateway unless
  Node TLS verification is disabled"; #41740 open "discord exec approvals fails
  against local self-signed TLS gateway"; #68438 closed "Android node: TLS
  fingerprint mismatch after certificate renewal"; #50642 closed "macOS node
  auto-trusts first TLS certificate"; #15906 closed "Remote Code Execution via
  Rogue Gateway Impersonation".
- `gitcrawl search issues "gateway.remote.tlsFingerprint" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 2 results: #50642 closed and #15906 closed.
- `gitcrawl search prs "gateway remote tls fingerprint" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 12 PRs, including #80204 open "propagate gateway TLS fingerprints to
  bootstrap clients", #58378 open "macOS: confirm discovered gateway trust",
  #75228 open "auto-repair stale gateway TLS pins", and multiple closed hardening
  or repair PRs.
- `gitcrawl search prs "gateway discovery tailscale serve" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 6 PRs, including #40167 closed "improve tailscale gateway discovery"
  and #32860 closed "add tailscale serve discovery fallback for remote gateways".
- `gitcrawl search prs "gateway bind remote" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 PRs, including #81981 closed "Policy: add gateway exposure
  checks", #2035 closed "add gateway network exposure security check", #19057
  closed "use loopback for local CLI connections when bind=lan", and #6715
  closed "add SSH tunnel example for loopback-bound gateway".

### discrawl reports

Feature-specific Discord archive searches found current operator guidance and
recent maintainer discussion:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway remote"`
  returned 10 results. Relevant hits included a 2026-05-21 maintainers/onboarding
  discussion describing local versus remote Gateway setup, direct WS, and SSH
  tunnel; a 2026-05-21 maintainer note to double-check a PR with remote Gateway
  setup; and user-help reports about remote browser/node capability failures
  after upgrade.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway bind tailnet lan loopback"`
  returned 10 results. Relevant hits included 2026-04-22 guidance explaining
  loopback versus non-loopback exposure, 2026-04-16 user confusion over invalid
  `gateway.bind`, and 2026-04-14 guidance steering users toward loopback unless
  they explicitly need tailnet/LAN exposure.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway discovery bonjour dns-sd magicdns"`
  returned 1 result, a 2026-02-17 Android guidance message stating that
  discovery does not work across networks unless unicast DNS-SD/wide-area
  Bonjour is configured.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway ssh tunnel remote"`
  returned 10 results. Relevant hits included 2026-04-20 discussion of #69135
  where `gateway probe` sees both SSH tunnel and direct URL as reachable, plus
  user-support guidance recommending SSH tunnels or Tailscale instead of public
  port exposure.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway tls fingerprint pin"`
  returned 10 results. Relevant hits included a 2026-05-01 maintainer checklist
  calling out TLS fingerprint rotation, stale pins, and challenge/startup races;
  PR review comments on remote TLS pin fallback and newly saved TLS pins; and
  user guidance to use WSS plus optional fingerprint pinning.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Tailscale Serve gateway remote"`
  returned 10 results. Relevant hits included repeated user-support guidance
  that loopback plus Tailscale Serve or SSH is the safe default, Tailscale Serve
  status/troubleshooting requests, and warnings about plain HTTP over tailnet.

### Good qualities

- Source code has narrow, explicit config types for bind modes, remote transport
  fields, and TLS fingerprints: `src/config/types.gateway.ts:3`,
  `src/config/types.gateway.ts:224`.
- Gateway bind resolution is centralized instead of scattered through callers:
  `src/gateway/net.ts:262`, `src/gateway/net.ts:333`.
- Local CLI calls deliberately prefer loopback even when the Gateway itself is
  bound to LAN/tailnet, reducing accidental self-exposure:
  `src/gateway/connection-details.ts:41`, `src/gateway/connection-details.ts:54`.
- Plaintext remote `ws://` is blocked for non-private hosts with actionable
  operator guidance: `src/gateway/connection-details.ts:70`,
  `src/gateway/client.ts:318`.
- TLS pin validation is enforced in the WebSocket client and checked again after
  socket open: `src/gateway/client.ts:313`, `src/gateway/client.ts:348`,
  `src/gateway/client.ts:1179`.
- Discovery publishing carries TLS, direct-reachability, SSH, and tailnet hints
  while keeping local discovery optional: `src/gateway/server-discovery-runtime.ts:25`,
  `src/gateway/server-discovery-runtime.ts:40`,
  `src/gateway/server-discovery-runtime.ts:68`,
  `src/gateway/server-discovery-runtime.ts:146`.
- macOS discovery helpers avoid routing from unauthenticated TXT hints and prefer
  resolved service endpoints: `apps/macos/Sources/OpenClaw/GatewayDiscoveryHelpers.swift:41`,
  `apps/macos/Sources/OpenClaw/GatewayDiscoveryHelpers.swift:53`.

### Bad qualities

- The archive history is dense with regressions around hardcoded loopback,
  bind=tailnet, remote probe behavior, Tailscale Serve, SSH tunnel detection,
  and TLS pin propagation. That lowers quality even though many issues have
  repair PRs.
- Several active GitHub items remain open on the same surface: #65355, #40527,
  #26250, #47342, #69135, #66279, #41740, #80204, #58378, #75228.
- Open issues describe operational gaps in remote probe behavior, SSH transport
  support, duplicate tunnel/direct detection, local TLS compatibility, and TLS
  fingerprint propagation.
- Transport selection logic is split across TypeScript Gateway/CLI code,
  macOS Swift app code, iOS/Android client code, and docs. Important pieces are
  present, but cross-client consistency is easy to regress.

## Known gaps

- Node-host SSH transport support is explicitly reported as missing in open
  issue #47342, even though SSH fallback exists for macOS/operator flows.
- `gateway probe` can still confuse one logical Gateway reached through both
  tunnel and direct URL according to open issue #69135.
- Remote/non-loopback probe budgets have an open false-negative report (#65355).
- Local TLS and self-signed TLS client propagation still have open reports/PRs
  (#66279, #41740, #80204).
- #49253 requested operator scopes for token-authenticated non-loopback
  connections.
- #12506 requests a unified security profile system with preset scenarios.
- Discord maintainers on 2026-05-01 called for challenge/nonce timing, token
  rotation, TLS fingerprint rotation, and startup auth-race hardening across
  remote Gateway scenarios.

## Evidence

### Docs

- `docs/gateway/remote.md:8` explains remote Gateway access as one Gateway on a
  dedicated host with clients connecting to it.
- `docs/gateway/remote.md:15` documents loopback default and remote exposure via
  Tailscale Serve, trusted LAN/tailnet bind, or SSH.
- `docs/gateway/remote.md:67` documents the SSH tunnel command and how health
  and status reach the remote Gateway through loopback forwarding.
- `docs/gateway/remote.md:88` documents persisted `gateway.mode="remote"` and
  `gateway.remote.url`.
- `docs/gateway/remote.md:104` distinguishes SSH tunnel local URL from
  discovered `gateway.remote.sshTarget`.
- `docs/gateway/remote.md:157` documents security rules for loopback,
  LAN/tailnet/custom binds, public `wss://`, and remote TLS pinning.
- `docs/gateway/discovery.md:43` documents Bonjour/DNS-SD discovery inputs.
- `docs/gateway/discovery.md:62` lists beacon TXT keys including
  `gatewayTlsSha256`, `tailnetDns`, and `sshPort`.
- `docs/gateway/discovery.md:79` says TXT values are unauthenticated and must not
  override stored TLS pins.
- `docs/gateway/discovery.md:124` documents preferred client transport
  selection order.
- `docs/gateway/configuration-reference.md:522` documents Gateway `mode`,
  `port`, `bind`, non-loopback auth requirements, Tailscale mode, remote
  transport, and TLS.
- `docs/gateway/protocol.md:680` documents Tailscale Serve/trusted-proxy auth.
- `docs/gateway/protocol.md:803` documents TLS and optional pinning.

### Source

- `src/config/types.gateway.ts:3` defines bind modes.
- `src/config/types.gateway.ts:224` defines `gateway.remote` URL, transport,
  remotePort, auth, TLS fingerprint, and SSH fields.
- `src/gateway/net.ts:262` resolves bind host for loopback, tailnet, LAN,
  custom, and auto.
- `src/gateway/net.ts:333` forces default loopback when Tailscale
  Serve/Funnel is active.
- `src/gateway/connection-details.ts:21` builds connection details and source
  labels.
- `src/gateway/connection-details.ts:70` rejects insecure remote plaintext WS
  unless the private-network escape hatch is enabled.
- `src/gateway/call.ts:464` resolves Gateway call context from CLI/env/config
  URL inputs.
- `src/gateway/call.ts:547` resolves TLS fingerprint precedence.
- `src/gateway/client.ts:313` rejects TLS fingerprints with non-WSS URLs.
- `src/gateway/client.ts:348` installs certificate fingerprint checking.
- `src/gateway/server-discovery-runtime.ts:25` starts local and wide-area
  discovery with TLS/direct/SSH/tailnet context.
- `apps/macos/Sources/OpenClaw/GatewayRemoteConfig.swift:46` resolves direct
  versus SSH transport.
- `apps/macos/Sources/OpenClaw/RemotePortTunnel.swift:68` creates an SSH local
  port forward.
- `apps/macos/Sources/OpenClawDiscovery/GatewayDiscoveryModel.swift:99` starts
  Bonjour/wide-area/Tailscale Serve discovery.
- `apps/macos/Sources/OpenClaw/GatewayDiscoveryHelpers.swift:53` avoids routing
  from unauthenticated TXT hints.

### Integration tests

- `src/gateway/server.auth.browser-hardening.test.ts:109` uses real Gateway
  WebSocket server helpers to test browser-origin trusted-proxy connections.
- `src/gateway/server.auth.browser-hardening.test.ts:217` tests allowed and
  disallowed browser origins against a running Gateway server.
- `src/gateway/server.auth.control-ui.suite.ts:954` opens a Tailscale-style WS
  connection in a Control UI auth flow.
- `src/gateway/server-network-runtime.e2e.test.ts:68` starts a Gateway server in
  a network runtime test.

### Unit tests

- `src/gateway/net.test.ts:668` covers bind host resolution.
- `src/gateway/call.test.ts:490` covers env remote URL override behavior.
- `src/gateway/call.test.ts:537` covers remote TLS fingerprint forwarding.
- `src/gateway/call.test.ts:750` covers connection detail source labels,
  fallback notes, remote URL selection, and private/plaintext WS behavior.
- `src/gateway/server-discovery-runtime.test.ts:85` covers discovery
  advertisement context.
- `src/gateway/server-discovery-runtime.test.ts:215` covers wide-area DNS-SD
  when local discovery is off.
- `src/infra/tls/gateway.test.ts:79` covers TLS cert/key/fingerprint loading.
- `src/infra/tailscale.test.ts:62` covers MagicDNS parsing.
- `apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryHelpersTests.swift:72`
  covers direct URL construction and public plaintext rejection.
- `apps/ios/Tests/GatewayConnectionSecurityTests.swift:39` covers discovered TLS
  pin trust behavior.

### gitcrawl queries

The following exact commands were run:

```bash
gitcrawl doctor --json
gitcrawl search issues "gateway remote" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search issues "gateway bind tailnet lan loopback" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search issues "gateway discovery Bonjour DNS-SD MagicDNS" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search issues "gateway ssh tunnel remote" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search issues "Tailscale Serve gateway remote" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search issues "tlsFingerprint" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search issues "gateway.remote.tlsFingerprint" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search prs "gateway remote tls fingerprint" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search prs "gateway discovery tailscale serve" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
gitcrawl search prs "gateway bind remote" -R openclaw/openclaw --state all --json number,title,state,url | jq -c '{count:length, results:.}'
```

Results are summarized under "Quality / gitcrawl reports" above. A broader
`gitcrawl search issues "gateway tls fingerprint" ...` query was terminated
after it produced no output for more than 20 seconds; the narrower
`tlsFingerprint` and `gateway.remote.tlsFingerprint` searches returned promptly
and are the TLS query evidence for this note.

### discrawl queries

The following exact commands were run:

```bash
discrawl status --json
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway remote"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway bind tailnet lan loopback"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway discovery bonjour dns-sd magicdns"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway ssh tunnel remote"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway tls fingerprint pin"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Tailscale Serve gateway remote"
```

Results are summarized under "Quality / discrawl reports" above. The search
result counts were 10, 10, 1, 10, 10, and 10 respectively.
