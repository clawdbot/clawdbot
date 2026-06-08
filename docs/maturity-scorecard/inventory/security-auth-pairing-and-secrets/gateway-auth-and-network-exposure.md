---
title: "Security, auth, pairing, and secrets - Gateway Auth and Remote Access Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Gateway Auth and Remote Access Maturity Note

## Summary

Gateway auth and network exposure are implemented as a real security boundary across startup config, CLI launch, HTTP auth wrappers, WebSocket handshake auth, browser origin checks, trusted-proxy identity, Tailscale identity, and operator runbooks. The default posture stays loopback-first; non-loopback exposure requires token/password or trusted-proxy auth; public or proxy browser access requires explicit origins; and Tailscale identity is deliberately narrower than general HTTP API auth.

Coverage is Stable because real Gateway/server tests exercise token/password auth, explicit `auth.mode: "none"`, Tailscale-authenticated Control UI WebSocket behavior, trusted-proxy Control UI behavior, pre-auth socket hardening, browser-origin rejection, non-loopback startup guardrails, and SecretRef fail-closed auth loading. Quality is Beta because the source and docs are security-conscious and mostly aligned, but refreshed archives still show operator confusion and open hardening threads around trusted proxy, Tailscale Serve/Funnel, `allowedOrigins`, service identity, and reverse-proxy/browser failure modes.

## Category Scope

Included in this category:

- Shared Gateway token/password auth: Token and password auth for Gateway HTTP and WebSocket clients, including runtime auth resolution, startup validation, shared-secret comparison, and operator guidance.
- Gateway auth mode: Gateway auth mode selection, including private ingress behavior and operator warnings for unsafe exposure.
- Trusted-proxy identity: Trusted-proxy identity, gateway.trustedProxies, trustedProxy.userHeader, requiredHeaders, allowUsers, allowLoopback, reverse-proxy source validation, and scope behavior
- Tailscale Serve/Funnel: Tailscale Serve/Funnel and reverse-proxy exposure rules, including Tailscale identity headers, tailscale whois, Funnel password requirements, and separation between Control UI/WS identity and HTTP API auth
- Bind and origin restrictions: loopback/LAN/tailnet/custom bind modes, non-loopback exposure checks, browser Origin checks, controlUi.allowedOrigins, Host-header fallback risk, and forwarded-header handling
- WebSocket handshake auth: WebSocket handshake auth, including challenge/connect ordering, nonce-bound device auth, shared auth, browser origin checks, pre-auth limits, unauthenticated socket timeout, and stale shared-auth rotation
- Operator-facing docs: Operator-facing docs and runbooks for security audit, remote access, exposure rollback, Tailscale, trusted proxy, credential rotation, and explicit credential probing
- Browser Control UI: Covers Browser Control UI across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.
- Remote Client Trust: Covers Remote Client Trust across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.

## Features

- Shared Gateway token/password auth: Token and password auth for Gateway HTTP and WebSocket clients, including runtime auth resolution, startup validation, shared-secret comparison, and operator guidance.
- Gateway auth mode: Gateway auth mode selection, including private ingress behavior and operator warnings for unsafe exposure.
- Trusted-proxy identity: Trusted-proxy identity, gateway.trustedProxies, trustedProxy.userHeader, requiredHeaders, allowUsers, allowLoopback, reverse-proxy source validation, and scope behavior
- Tailscale Serve/Funnel: Tailscale Serve/Funnel and reverse-proxy exposure rules, including Tailscale identity headers, tailscale whois, Funnel password requirements, and separation between Control UI/WS identity and HTTP API auth
- Bind and origin restrictions: loopback/LAN/tailnet/custom bind modes, non-loopback exposure checks, browser Origin checks, controlUi.allowedOrigins, Host-header fallback risk, and forwarded-header handling
- WebSocket handshake auth: WebSocket handshake auth, including challenge/connect ordering, nonce-bound device auth, shared auth, browser origin checks, pre-auth limits, unauthenticated socket timeout, and stale shared-auth rotation
- Operator-facing docs: Operator-facing docs and runbooks for security audit, remote access, exposure rollback, Tailscale, trusted proxy, credential rotation, and explicit credential probing
- Browser Control UI: Covers Browser Control UI across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.
- Remote Client Trust: Covers Remote Client Trust across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - Real Gateway tests cover password auth accept/reject, token auth reject paths, explicit loopback `auth.mode: "none"`, Tailscale-authenticated Control UI WebSocket behavior, and shared-auth/device-auth interactions (`src/gateway/server.auth.modes.suite.ts:18`, `src/gateway/server.auth.modes.suite.ts:52`, `src/gateway/server.auth.modes.suite.ts:114`, `src/gateway/server.auth.modes.suite.ts:145`).
  - Browser hardening tests cover attacker-origin rejection, trusted-proxy origin rejection outside `allowedOrigins`, forged loopback origins through proxy headers, and browser-origin auth rate limiting (`src/gateway/server.auth.browser-hardening.test.ts:153`, `src/gateway/server.auth.browser-hardening.test.ts:241`, `src/gateway/server.auth.browser-hardening.test.ts:316`, `src/gateway/server.auth.browser-hardening.test.ts:461`).
  - Trusted-proxy Control UI runtime tests cover missing device identity rejection, device-less scope clearing, and proxy-declared scope bounding (`src/gateway/server.auth.control-ui.suite.ts:291`, `src/gateway/server.auth.control-ui.suite.ts:381`, `src/gateway/server.auth.control-ui.suite.ts:434`).
  - Pre-auth hardening tests cover handler-unavailable upgrade rejection, idle unauthenticated socket close, oversized pre-auth connect-frame rejection, and unauthenticated socket budgets (`src/gateway/server.preauth-hardening.test.ts:89`, `src/gateway/server.preauth-hardening.test.ts:132`, `src/gateway/server.preauth-hardening.test.ts:197`, `src/gateway/server.preauth-hardening.test.ts:243`).
  - Runtime config tests cover trusted-proxy configuration requirements, LAN/token allowance, LAN/no-auth rejection, custom bind validation, and non-loopback Control UI `allowedOrigins` requirements (`src/gateway/server-runtime-config.test.ts:18`, `src/gateway/server-runtime-config.test.ts:75`, `src/gateway/server-runtime-config.test.ts:132`, `src/gateway/server-runtime-config.test.ts:203`).
  - Runtime SecretRef tests prove active Gateway auth refs fail closed at startup and hot reload rather than silently dropping to plaintext fallback (`src/secrets/runtime.gateway-auth.integration.test.ts:36`, `src/secrets/runtime.gateway-auth.integration.test.ts:67`).
  - CLI/probe integration tests exercise explicit token probing against a running Gateway and cached device auth after first local authenticated probe (`src/gateway/probe.auth.integration.test.ts:82`).
- Negative signals:
  - The strongest proof is local real-server/runtime testing; this audit did not find a live nginx/Caddy/Pomerium/Cloudflare/Authentik reverse-proxy end-to-end that proves identity headers, blocked direct access, `allowUsers`, and origin restrictions together.
  - Tailscale behavior is simulated and source-backed, but this audit did not find a recurring live Tailscale daemon proof for Serve identity headers, Funnel password enforcement, stale identity, or tag-owned devices.
  - Non-loopback exposure is well guarded in source and runtime config tests, but there is no full operator scenario that exercises firewall reachability, unauthorized remote client attempts, allowed browser origins, and rollback from the exposure runbook.
  - Security audit and docs/runbooks are strong, but the runbooks are not themselves automated as upgrade/security scenario checks.
- Integration gaps:
  - Add a real reverse-proxy e2e with authenticated identity headers, direct-backend denial, `trustedProxies`, `requiredHeaders`, `allowUsers`, `allowLoopback: false`, browser origin enforcement, and negative unauthenticated probes.
  - Add a live Tailscale Serve/Funnel scenario that proves Serve identity header verification, HTTP API shared-auth requirements, Funnel password requirements, and tag-owned/no-identity failure behavior.
  - Add non-loopback exposure smoke coverage that binds LAN/tailnet/custom, verifies token/password/trusted-proxy requirements, checks unauthorized remote clients, and validates rollback to loopback.
  - Add recurring security-audit/runbook scenario proof before treating this component as Lovable.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - Open trusted-proxy and identity threads show unfinished operational gaps: trusted-proxy onboarding flags (#73638/#73639), service identity versus user auth (#69066), trusted-proxy fallback/default user behavior (#23585), trusted-proxy scope documentation (#80063/#85950), and voice/webhook trusted proxy matching (#86525/#86527).
  - Open Tailscale and remote-access issues show product ambiguity: optional secondary auth for Tailscale Serve (#57110), Android/Control UI WebSocket closes after Tailscale setup (#85966), token URL and Tailscale Serve auth confusion (#46919), and Android manual LAN URL parsing (#87216).
  - Open origin and proxy records show browser-exposure friction: Cloudflare tunnel Control UI client identity issue (#78674), custom origin/CORS/allowed-origin work (#38290/#68647/#73511), and reverse-proxy auth/401 behavior (#87268).
  - Open auth hardening threads show remaining security sharp edges: hooks token reuse as Gateway password (#87376/#87379), plaintext `--password` exposure (#83880), multiple Gateway tokens (#43903), and trusted-operator shared-secret escalation concerns (#78712).
- Discrawl reports:
  - Recent Discord results repeatedly show operators debugging `gateway.bind`, `gateway.auth.mode`, LAN exposure, Docker bind behavior, and why `auth.mode: "none"` is unsafe or blocked outside trusted loopback/private ingress.
  - Tailscale support threads show recurring confusion that Tailscale Serve identity can authorize Control UI/WS but not normal HTTP APIs, that Funnel lacks identity headers, and that exact `gateway.controlUi.allowedOrigins` entries are still required.
  - Reverse-proxy/trusted-proxy threads show users struggling with same-host proxy source IPs, Apache/AuthentiK/Cloudflared header injection, CLI/TUI direct WebSocket calls that do not carry proxy identity headers, and device identity still being required for some browser flows.
- Good qualities:
  - The source defaults to explicit auth semantics, rejects ambiguous token/password mode, validates configured token/password material, and keeps trusted-proxy mode mutually exclusive with shared token auth (`src/gateway/auth-mode-policy.ts:4`, `src/gateway/auth.ts:222`, `src/gateway/startup-auth.ts:125`).
  - Non-loopback exposure is blocked without shared auth or trusted-proxy auth at CLI/runtime boundaries, while Tailscale serve/funnel modes are forced to loopback and `auth.mode: "none"` is rejected for unsafe Tailscale modes (`src/cli/gateway-cli/run.ts:772`, `src/gateway/server-runtime-config.ts:57`, `src/config/validation.ts:833`, `src/config/validation.ts:860`).
  - Trusted-proxy handling validates configured proxy source addresses, rejects loopback unless explicitly allowed, rejects local interface spoofing, enforces required headers and `allowUsers`, and fails closed when forwarded headers cannot be trusted (`src/gateway/auth.ts:270`, `src/gateway/net.ts:178`, `src/gateway/net.ts:193`).
  - Browser exposure is guarded by explicit `Origin` policy, private/local same-origin checks, non-loopback `allowedOrigins`, and warnings for dangerous Host-header fallback (`src/gateway/origin-check.ts:35`, `src/gateway/origin-check.ts:80`, `src/security/audit-gateway-config.ts:165`).
  - WebSocket handshake code enforces challenge/connect sequencing, browser origin checks, shared/device/trusted-proxy auth decisions, pre-auth limits, and stale shared-auth generation disconnects (`src/gateway/server/ws-connection.ts:244`, `src/gateway/server/ws-connection/message-handler.ts:529`, `src/gateway/server/ws-connection/message-handler.ts:676`, `src/gateway/server/ws-connection/message-handler.ts:970`).
  - Operator docs align closely with the source: security audit, exposure runbook, trusted-proxy auth, Tailscale, remote access, credential rotation, explicit credential probing, and rollback all describe the same high-level constraints.
- Bad qualities:
  - The safe configuration model remains hard to reason about because bind mode, auth mode, Control UI origin, proxy source IP, forwarded headers, device pairing, Tailscale mode, and HTTP-versus-WS behavior all interact.
  - Trusted-proxy operation still requires precise external proxy configuration that OpenClaw cannot fully verify: TLS termination, direct-backend blocking, header overwrite/strip rules, authenticated identity, and source-IP preservation.
  - Tailscale Serve identity is intentionally narrow but easy to misunderstand; users continue to expect it to cover HTTP APIs, Funnel, tagged devices, or browser origins without extra configuration.
  - Several high-impact operator states still produce support traffic rather than self-explanatory recovery: origin allowlist misses, wrong profile token/password, same-host proxy source IPs, Cloudflare tunnel behavior, and local-vs-remote WebSocket classification.
- Excluded from quality:
  - Unit, integration, e2e, live, and real runtime evidence breadth were not used to raise or lower Quality. Runtime evidence is used only in Coverage.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Shared Gateway token/password auth, Gateway auth mode, Trusted-proxy identity, Tailscale Serve/Funnel, Bind and origin restrictions, WebSocket handshake auth, Operator-facing docs, Browser Control UI, Remote Client Trust.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a real reverse-proxy integration that proves trusted-proxy identity end-to-end through a concrete proxy, including blocked direct access, header stripping/overwriting, `allowUsers`, denied missing headers, and origin enforcement.
- Add a recurring live Tailscale Serve/Funnel scenario with actual Tailscale identity headers, Funnel password checks, tag-owned/no-identity behavior, and HTTP API shared-auth expectations.
- Automate the exposure runbook as a scenario: loopback baseline, deliberate LAN/tailnet/custom exposure, unauthorized remote probe, authorized credential probe, Control UI origin validation, security audit output, rollback, and token/password rotation.
- Improve operator diagnostics for `allowedOrigins`, same-host reverse proxies, Cloudflare tunnel behavior, wrong profile credentials, and Tailscale Serve identity boundaries.
- Resolve or explicitly scope open archive threads around Tailscale secondary auth, service identity separation, multiple Gateway tokens, plaintext password CLI exposure, and trusted-proxy onboarding flags.
- Make the public/private-ingress trust model more visible in first-run and remote-access docs so `auth.mode: "none"` is not discovered through failed LAN or Tailscale attempts.

## Evidence

### Docs

- `docs/gateway/security/index.md:8` states the personal-assistant trust model and warns that OpenClaw is not a hostile multi-tenant system.
- `docs/gateway/security/index.md:28` tells operators to use the exposure runbook before remote access, reverse proxy, or public exposure.
- `docs/gateway/security/index.md:36` documents `openclaw security audit` as the main hardening check, including Gateway auth exposure.
- `docs/gateway/security/index.md:177` shows the hardened baseline with `gateway.bind: "loopback"` and token auth.
- `docs/gateway/security/index.md:373` documents reverse proxy and `trustedProxies`, including the rule that proxy headers are not trusted unless configured.
- `docs/gateway/security/index.md:419` documents HSTS and `allowedOrigins`, including explicit wildcard behavior.
- `docs/gateway/security/index.md:746` documents network exposure guidance: loopback default, non-loopback bind requires auth and firewall review, and Tailscale Serve is preferred.
- `docs/gateway/security/index.md:876` documents generated Gateway token onboarding and notes that `gateway.remote.*` does not protect the local WS server by itself.
- `docs/gateway/security/index.md:895` documents plaintext `ws://` acceptance only for private/loopback use and remote classification for tailnet/LAN/proxy contexts.
- `docs/gateway/security/index.md:919` documents token, password, trusted-proxy modes and credential rotation.
- `docs/gateway/security/index.md:930` documents Tailscale Serve identity headers, `tailscale whois`, the Control UI/WS-only boundary, and the shared-secret fallback recommendation.
- `docs/gateway/security/exposure-runbook.md:11` warns operators to expose the Gateway only after they know who can reach it, who authenticates, and which agents/tools are reachable.
- `docs/gateway/security/exposure-runbook.md:24` compares loopback+SSH, Tailscale Serve, tailnet/LAN bind, trusted reverse proxy, and public internet exposure patterns.
- `docs/gateway/security/exposure-runbook.md:54` documents baseline checks, explicit credential probes, and the rule that explicit remote URLs do not automatically inherit config credentials.
- `docs/gateway/security/exposure-runbook.md:126` documents the reverse-proxy checklist: proxy-authenticated identity, blocked direct backend access, `trustedProxies`, stripped/overwritten headers, `allowUsers`, and `allowLoopback`.
- `docs/gateway/security/exposure-runbook.md:155` documents authorized and unauthorized post-change validation.
- `docs/gateway/security/exposure-runbook.md:169` documents rollback to loopback and token/password rotation.
- `docs/gateway/trusted-proxy-auth.md:12` warns that trusted-proxy mode delegates authentication to the external proxy.
- `docs/gateway/trusted-proxy-auth.md:34` documents trusted-proxy request flow: proxy authenticates, injects identity headers, and Gateway verifies trusted proxy IP before extracting identity.
- `docs/gateway/trusted-proxy-auth.md:52` documents Control UI pairing behavior and scope clearing in trusted-proxy mode.
- `docs/gateway/trusted-proxy-auth.md:75` shows trusted-proxy config with LAN bind, `gateway.trustedProxies`, `auth.mode: "trusted-proxy"`, `userHeader`, `requiredHeaders`, `allowUsers`, and `allowLoopback: false`.
- `docs/gateway/trusted-proxy-auth.md:106` documents runtime rules: loopback source rejection by default, same-host `allowLoopback`, internal password fallback, non-loopback `allowedOrigins`, and forwarded-header direct-fallback restrictions.
- `docs/gateway/tailscale.md:9` documents Tailscale Serve/Funnel keeping the Gateway loopback while Tailscale provides routing and identity headers.
- `docs/gateway/tailscale.md:23` documents Serve identity auth boundaries, `tailscale whois`, WS-only identity use, and HTTP API shared-auth requirements.
- `docs/gateway/tailscale.md:92` documents Funnel plus shared password and recommends environment-backed password handling.
- `docs/gateway/tailscale.md:115` documents that Funnel refuses to run without password auth and that Serve/Funnel only expose Gateway Control UI and WS.
- `docs/gateway/remote.md:15` documents remote Gateway access through Tailscale Serve, trusted LAN/Tailnet bind, or SSH tunnel.
- `docs/gateway/remote.md:125` documents credential precedence and URL override safety.
- `docs/gateway/remote.md:157` documents the remote security rules: keep loopback-only, public plaintext remote must use `wss://`, non-loopback binds need token/password/trusted-proxy, remote creds do not configure server auth, Tailscale Serve identity is limited, and trusted-proxy loopback requires explicit opt-in.
- `docs/gateway/configuration-reference.md:524` documents bind values, auth requirements, explicit no-auth mode, trusted-proxy semantics, `allowTailscale`, `allowedOrigins`, public `wss://` URL expectations, SecretRef fallback, and `trustedProxies`.
- `docs/cli/gateway.md:58` documents binding beyond loopback without auth as blocked and gives explicit token/password/proxy alternatives.
- `docs/cli/doctor.md:46` documents doctor support for generating a Gateway token and reporting SecretRef-managed auth without plaintext fallback.

### Source

- `src/config/types.gateway.ts:3` defines Gateway bind modes.
- `src/config/types.gateway.ts:129` defines Control UI origin and dangerous fallback flags.
- `src/config/types.gateway.ts:146` defines `none`, `token`, `password`, and `trusted-proxy` Gateway auth modes plus trusted-proxy fields and `allowTailscale`.
- `src/gateway/auth-resolve.ts:31` resolves auth mode, token/password, and Tailscale defaults from config, env, and overrides.
- `src/gateway/auth-mode-policy.ts:4` rejects ambiguous token-plus-password config without explicit auth mode.
- `src/gateway/startup-auth.ts:125` resolves active Gateway auth SecretRefs, rejects weak placeholder secrets, generates runtime-only tokens where allowed, and fails closed for unresolved active refs.
- `src/gateway/auth.ts:222` validates configured token/password/trusted-proxy auth options.
- `src/gateway/auth.ts:270` authorizes trusted-proxy requests using trusted source addresses, `allowLoopback`, local-interface rejection, required headers, user header, and `allowUsers`.
- `src/gateway/auth.ts:354` authorizes token/password requests with safe secret comparison and rate-limit behavior.
- `src/gateway/auth.ts:400` centralizes Gateway connect authorization, including Tailscale and trusted-proxy branches.
- `src/gateway/auth.ts:504` allows explicit `auth.mode: "none"` and limits Tailscale identity auth to allowed contexts without explicit shared creds.
- `src/gateway/net.ts:178` checks trusted proxy addresses with IP/CIDR matching.
- `src/gateway/net.ts:193` resolves client IP from forwarded headers only for trusted proxies and fails closed on invalid or untrusted chains.
- `src/gateway/net.ts:250` resolves loopback, LAN, tailnet, auto, and custom bind modes.
- `src/gateway/origin-check.ts:35` parses and checks browser origins against explicit allowlists, same-origin private hosts, local loopback, and dangerous fallback settings.
- `src/gateway/origin-check.ts:80` restricts same-origin trust to private hosts, `.local`, `.ts.net`, and local loopback client contexts.
- `src/cli/gateway-cli/run.ts:223` blocks non-loopback helper startup without shared secret unless trusted-proxy mode is configured.
- `src/cli/gateway-cli/run.ts:754` rejects password mode without a configured password and logs explicit warning for `auth.mode: "none"`.
- `src/cli/gateway-cli/run.ts:772` refuses non-loopback bind without token/password/trusted-proxy auth.
- `src/config/validation.ts:833` enforces Tailscale serve/funnel loopback bind.
- `src/config/validation.ts:860` rejects unsafe `auth.mode: "none"` for Tailscale serve/funnel.
- `src/shared/gateway-tailscale-auth-policy.ts:3` encodes the Tailscale no-auth and Funnel password policies.
- `src/security/audit-gateway-config.ts:119` raises critical findings for non-loopback Gateway bind without auth.
- `src/security/audit-gateway-config.ts:165` raises non-loopback Control UI origin findings, wildcard warnings, and Host-header fallback warnings.
- `src/security/audit-gateway-config.ts:209` reports risky `X-Real-IP` fallback.
- `src/security/audit-gateway-config.ts:242` reports Tailscale Funnel and Serve exposure posture.
- `src/gateway/server/ws-connection.ts:244` records host, origin, and forwarded headers and sends `connect.challenge`.
- `src/gateway/server/ws-connection.ts:472` closes idle unauthenticated sockets after the handshake timeout.
- `src/gateway/server/ws-connection/message-handler.ts:529` requires the first frame to be a valid `connect` request.
- `src/gateway/server/ws-connection/message-handler.ts:676` enforces browser origin policy during the WebSocket handshake.
- `src/gateway/server/ws-connection/message-handler.ts:716` resolves token/password/auth state for the connect request.
- `src/gateway/server/ws-connection/message-handler.ts:747` returns auth failure messages and closes unauthorized handshakes.
- `src/gateway/server/ws-connection/message-handler.ts:970` verifies bootstrap/device/shared auth and closes stale shared-auth sessions after rotation.
- `src/gateway/server/ws-connection/message-handler.ts:1055` resolves trusted-proxy scopes and Control UI pairing skip behavior.
- `src/gateway/server/ws-connection/auth-context.ts:98` resolves shared auth, bootstrap token candidates, device token candidates, and trusted-proxy classification.
- `src/gateway/server/ws-connection/connect-policy.ts:37` limits Tailscale and `auth.mode: "none"` pairing skips to operator Control UI paths.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:53` rate-limits browser-origin auth failures and does not exempt loopback browser origins.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:197` classifies pairing locality for local and remote contexts.
- `src/gateway/server/ws-connection/handshake-auth-helpers.ts:307` verifies nonce-bound device signatures.

### Integration tests

- `src/gateway/server.auth.modes.suite.ts:18` covers real-server password auth accept/reject.
- `src/gateway/server.auth.modes.suite.ts:52` covers real-server token auth rejection and Control UI missing-device rejection by default.
- `src/gateway/server.auth.modes.suite.ts:114` covers explicit loopback `auth.mode: "none"` connect without shared secret.
- `src/gateway/server.auth.modes.suite.ts:145` covers Tailscale-authenticated Control UI WebSocket behavior, device requirements, and shared-token interactions.
- `src/gateway/server.auth.browser-hardening.test.ts:153` covers attacker browser origin rejection.
- `src/gateway/server.auth.browser-hardening.test.ts:241` covers trusted-proxy origin rejection when not explicitly allowed.
- `src/gateway/server.auth.browser-hardening.test.ts:316` covers forged loopback origin rejection through forwarded headers.
- `src/gateway/server.auth.browser-hardening.test.ts:461` covers browser-origin auth failure rate limiting.
- `src/gateway/server.auth.control-ui.suite.ts:291` covers trusted-proxy Control UI device identity rejection behavior.
- `src/gateway/server.auth.control-ui.suite.ts:381` covers trusted-proxy device-less scope clearing.
- `src/gateway/server.auth.control-ui.suite.ts:434` covers proxy-declared scope bounding.
- `src/gateway/server.preauth-hardening.test.ts:89` covers WebSocket upgrade rejection when handlers are unavailable.
- `src/gateway/server.preauth-hardening.test.ts:132` covers unauthenticated idle socket close after handshake timeout.
- `src/gateway/server.preauth-hardening.test.ts:197` covers oversized pre-auth connect-frame rejection.
- `src/gateway/server.preauth-hardening.test.ts:243` covers simultaneous unauthenticated socket budget enforcement.
- `src/gateway/probe.auth.integration.test.ts:82` covers token-authenticated probe/call behavior against a running Gateway harness.
- `src/secrets/runtime.gateway-auth.integration.test.ts:36` covers startup failure for unresolved active Gateway auth SecretRefs.
- `src/secrets/runtime.gateway-auth.integration.test.ts:67` covers hot-reload rejection of unresolved active Gateway auth refs before persisting bad config.

### Unit tests

- `src/gateway/auth.test.ts:220` covers explicit auth mode resolution from config.
- `src/gateway/auth.test.ts:280` covers explicit `auth.mode: "none"` authorization behavior.
- `src/gateway/auth.test.ts:331` covers Tailscale identity disabled by default and enabled explicitly.
- `src/gateway/auth.test.ts:415` covers Tailscale header auth disabled on HTTP wrappers and enabled on WS Control UI wrappers.
- `src/gateway/auth.test.ts:588` covers trusted-proxy auth requirements and allowlist behavior.
- `src/gateway/auth.test.ts:1025` covers loopback trusted-proxy rejection unless `allowLoopback` is set.
- `src/gateway/auth.test.ts:1153` covers required header and `allowUsers` checks for loopback-allowed proxy sources.
- `src/gateway/auth.test.ts:1206` covers forwarded-header loopback direct-rejection behavior.
- `src/gateway/server/ws-connection/connect-policy.test.ts:243` covers dangerous device-auth disable and `auth.mode: "none"` pairing-skip limits.
- `src/gateway/server/ws-connection/connect-policy.test.ts:284` covers Tailscale pairing skip only for operator Control UI with device identity.
- `src/gateway/server/ws-connection/handshake-auth-helpers.test.ts:27` covers browser-origin loopback rate-limit key behavior.
- `src/gateway/server/ws-connection/handshake-auth-helpers.test.ts:327` covers local versus remote shared-secret pairing classification.
- `src/gateway/origin-check.test.ts:24` covers same-origin private LAN/tailnet acceptance, public rejection, and loopback-local limits.
- `src/config/config.gateway-tailscale-bind.test.ts:23` covers no-auth rejection for Tailscale serve/funnel and Funnel password requirements.
- `src/config/config.gateway-tailscale-bind.test.ts:97` covers non-loopback bind rejection for Tailscale serve/funnel.
- `src/security/audit-gateway.test.ts:42` covers audit findings for non-loopback bind without auth.
- `src/security/audit-gateway-exposure.test.ts:114` covers non-loopback Control UI missing-origin findings.
- `src/security/audit-gateway-exposure.test.ts:163` covers Host-header fallback findings.
- `src/security/audit-gateway-exposure.test.ts:221` covers trusted-proxy exposure findings.
- `src/commands/configure.gateway.test.ts:141` covers trusted-proxy Gateway config generation.
- `src/commands/configure.gateway.test.ts:175` covers Tailscale and non-loopback origin seeding.
- `src/gateway/server-runtime-config.test.ts:18` covers runtime trusted-proxy config requirements.
- `src/gateway/server-runtime-config.test.ts:75` covers LAN/token allowance and LAN/no-auth rejection.
- `src/gateway/server-runtime-config.test.ts:132` covers loopback fallback rejection and custom bind validation.
- `src/gateway/server-runtime-config.test.ts:203` covers non-loopback `allowedOrigins` requirements.

### Gitcrawl queries

- `gitcrawl search issues "gateway auth mode none trusted proxy non-loopback bind" -R openclaw/openclaw --state all --json number,title,url,state` returned no direct matches.
- `gitcrawl search issues "trusted proxy allowUsers allowLoopback gateway.auth.mode" -R openclaw/openclaw --state all --json number,title,url,state` returned no direct matches.
- `gitcrawl search issues "Control UI allowedOrigins origin websocket gateway auth" -R openclaw/openclaw --state all --json number,title,url,state` returned open #78674, `[Bug]: Control UI sends null client.id/client.mode through Cloudflare tunnel`.
- `gitcrawl search prs "origin allowedOrigins" -R openclaw/openclaw --state all --json number,title,url,state` returned open origin hardening/compatibility PRs including #38290, #68647, #73511, and #85663.
- `gitcrawl search issues "origin not allowed" -R openclaw/openclaw --state all --json number,title,url,state` returned open origin and tunnel issues including #46520 and #78674.
- `gitcrawl search issues "trusted proxy" -R openclaw/openclaw --state all --json number,title,url,state` returned open trusted-proxy and identity threads including #73638, #73639, #70729, #23585, #86525, #80063, #43786, #69066, #43903, #87268, #57110, and #87376.
- `gitcrawl search prs "trusted proxy" -R openclaw/openclaw --state all --json number,title,url,state` returned open hardening/docs/config PRs including #86527, #85950, #49107, #57889, #73163, #87379, and #85261.
- `gitcrawl search issues "Tailscale gateway auth" -R openclaw/openclaw --state all --json number,title,url,state` returned open Tailscale/auth threads including #57110, #85750, #55915, #46919, #70729, #85966, #53274, #87216, and #65619.
- `gitcrawl search issues "gateway token password auth" -R openclaw/openclaw --state all --json number,title,url,state` returned open auth/security threads including #87376, #57110, #83880, #73638/#73639, #78712, and #72418.

### Discrawl queries

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "gateway auth mode none trusted proxy non-loopback bind"` returned a recent support answer explaining that `127.0.0.1` is not public, exposure depends on `gateway.bind` and `gateway.auth.mode`, loopback+token/password is reasonably secured, LAN/tailnet/custom with token/password is remotely reachable but protected, and `none` is risky outside local/private ingress.
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI allowedOrigins websocket auth Tailscale Serve"` returned six support threads about exact `https://<magicdns>.ts.net` `allowedOrigins`, Tailscale reachability versus browser origin rejection, security-audit warnings for Host-header fallback/device-auth-disabled/rate-limit gaps, and non-secure HTTP browser/device-auth limitations from other machines.
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "gateway auth Tailscale Funnel password Serve identity headers"` returned support threads clarifying that tokenless Tailscale auth is only for Serve plus `allowTailscale`, only covers Control UI/WS, normal HTTP APIs still require token/password, Funnel lacks identity headers and requires password, and wrong profile tokens cause HTTP 401.
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "OpenClaw reverse proxy trustedProxies x-forwarded-user"` returned a trusted-proxy support thread explaining that the mode is for reverse proxies that terminate TLS/authenticate/inject identity headers and that direct loopback sandbox calls do not automatically authorize.
