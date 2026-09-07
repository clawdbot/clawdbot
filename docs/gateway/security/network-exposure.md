---
summary: "Bind, firewall, discovery, Gateway auth, Tailscale, reverse proxy, and Control UI exposure settings"
read_when:
  - Binding the Gateway beyond loopback
  - Putting the Gateway behind a reverse proxy or Tailscale Serve
  - Auditing which dangerous flags are enabled
title: "Network exposure"
---

## Network exposure

### Bind, port, firewall

The Gateway multiplexes WebSocket + HTTP on one port (default `18789`; config/flags/env: `gateway.port`, `--port`, `OPENCLAW_GATEWAY_PORT`). That HTTP surface includes the Control UI (SPA assets, default base path `/`), hosted widget documents (`/__openclaw__/canvas`), and A2UI renderer assets (`/__openclaw__/a2ui`). Widget documents contain agent-authored HTML/JS; treat them as untrusted content when loaded in a normal browser, do not expose them to untrusted networks or users, and do not share their origin with privileged web surfaces.

`gateway.bind` controls where the Gateway listens:

- `"loopback"` (default): only local clients can connect.
- `"lan"`, `"tailnet"`, `"custom"`: expand the attack surface. Only use with gateway auth (shared token/password, or a correctly configured trusted proxy) and a real firewall.

Rules of thumb: prefer Tailscale Serve over LAN binds (Serve keeps the Gateway on loopback and Tailscale handles access); if you must bind to LAN, firewall the port to a tight source-IP allowlist rather than port-forwarding broadly; never expose the Gateway unauthenticated on `0.0.0.0`.

### Docker port publishing with UFW

Published container ports (`-p HOST:CONTAINER` or Compose `ports:`) route through Docker's forwarding chains, not only host `INPUT` rules. Enforce rules in `DOCKER-USER` (evaluated before Docker's own accept rules); most modern distros use the `iptables-nft` frontend, which still applies these rules to the nftables backend.

```bash
# /etc/ufw/after.rules (append as its own *filter section)
*filter
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -s 127.0.0.0/8 -j RETURN
-A DOCKER-USER -s 10.0.0.0/8 -j RETURN
-A DOCKER-USER -s 172.16.0.0/12 -j RETURN
-A DOCKER-USER -s 192.168.0.0/16 -j RETURN
-A DOCKER-USER -s 100.64.0.0/10 -j RETURN
-A DOCKER-USER -p tcp --dport 80 -j RETURN
-A DOCKER-USER -p tcp --dport 443 -j RETURN
-A DOCKER-USER -m conntrack --ctstate NEW -j DROP
-A DOCKER-USER -j RETURN
COMMIT
```

IPv6 has separate tables - add a matching policy in `/etc/ufw/after6.rules` if Docker IPv6 is enabled. Avoid hardcoding interface names (`eth0`) since they vary across VPS images (`ens3`, `enp*`, etc.) and a mismatch can silently skip your deny rule.

```bash
ufw reload
iptables -S DOCKER-USER
ip6tables -S DOCKER-USER
nmap -sT -p 1-65535 <public-ip> --open
```

Expected external ports should be only what you intentionally expose (for most setups: SSH + reverse proxy ports).

### mDNS/Bonjour discovery

When the bundled `bonjour` plugin is enabled, the Gateway broadcasts presence via mDNS (`_openclaw-gw._tcp`, port 5353) for local device discovery. Full mode includes TXT records that expose operational details: `cliPath` (filesystem path revealing username and install location), `sshPort` (advertises SSH availability), `displayName`/`lanHost` (hostname info). Broadcasting infrastructure details makes LAN reconnaissance easier.

- Keep Bonjour disabled unless LAN discovery is needed - it auto-starts on macOS hosts and is opt-in elsewhere; direct Gateway URLs, Tailnet, SSH, or wide-area DNS-SD avoid local multicast.
- **Minimal mode** (default when Bonjour is enabled, recommended for exposed gateways) omits sensitive fields:

  ```json5
  { discovery: { mdns: { mode: "minimal" } } }
  ```

- **Off** suppresses local discovery while keeping the plugin enabled:

  ```json5
  { discovery: { mdns: { mode: "off" } } }
  ```

- **Full mode** (opt-in) includes `cliPath` + `sshPort`:

  ```json5
  { discovery: { mdns: { mode: "full" } } }
  ```

- Or set `OPENCLAW_DISABLE_BONJOUR=1` to disable mDNS without config changes.

In minimal mode the Gateway broadcasts `role`, `gatewayPort`, `transport` but omits `cliPath`/`sshPort`; apps that need the CLI path can fetch it over the authenticated WebSocket connection instead.

### Gateway WebSocket auth

Gateway auth is required by default - with no valid auth path configured, the Gateway refuses WebSocket connections (fail-closed). Onboarding generates a token by default (even for loopback) so local clients must authenticate.

```json5
{ gateway: { auth: { mode: "token", token: "your-token" } } }
```

`openclaw doctor --generate-gateway-token` can generate one for you.

<Note>
`gateway.remote.token` and `gateway.remote.password` are client credential sources - they do not protect local WS access by themselves. Local call paths use `gateway.remote.*` only as fallback when `gateway.auth.*` is unset. If `gateway.auth.token` or `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote-fallback masking).
</Note>

Pin remote TLS with `gateway.remote.tlsFingerprint` when using `wss://`. Plaintext `ws://` is accepted for loopback, private IP literals, `.local`, and Tailnet `*.ts.net` gateway URLs; for other trusted private-DNS names, set `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` on the client process as break-glass (process environment only, not an `openclaw.json` key). Mobile pairing and Android manual/scanned gateway routes are stricter: cleartext only for loopback, while private-LAN, link-local, `.local`, and dotless hostnames must use TLS unless you explicitly opt into the trusted private-network cleartext path.

Device pairing is auto-approved for direct local loopback connects (plus a narrow backend/container-local self-connect path for trusted shared-secret helper flows); Tailnet and LAN connects, including same-host connections to a tailnet address, are treated as remote and still need approval. A resolved `tailnet` address or `custom` address other than `127.0.0.1` or `0.0.0.0` adds a separate `127.0.0.1` listener; only connections to that local listener receive loopback semantics. Forwarded-header evidence on a loopback request disqualifies loopback locality; metadata-upgrade auto-approval is scoped narrowly. See [Gateway pairing](/gateway/pairing).

Auth modes:

- `"token"`: shared bearer token (recommended for most setups).
- `"password"`: prefer setting via `OPENCLAW_GATEWAY_PASSWORD`.
- `"trusted-proxy"`: trust an identity-aware reverse proxy to authenticate users and pass identity via headers. See [Trusted Proxy Auth](/gateway/trusted-proxy-auth).

Rotation checklist (token/password): generate/set a new secret (`gateway.auth.token` or `OPENCLAW_GATEWAY_PASSWORD`); restart the Gateway (or the macOS app if it supervises the Gateway); update remote clients (`gateway.remote.token`/`.password`); verify the old credentials no longer work.

### Tailscale Serve identity headers

When `gateway.auth.allowTailscale` is `true` (default for Serve), OpenClaw accepts the Tailscale Serve identity header `tailscale-user-login` for Control UI/WebSocket authentication. It verifies identity by resolving the `x-forwarded-for` address through the local Tailscale daemon (`tailscale whois`) and matching it to the header. This only triggers on OpenClaw's dedicated managed-Tailscale listener and requires `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`; headers on the ordinary Gateway listener do not establish Serve provenance or tokenless auth. For this async check, failed attempts for the same `{scope, ip}` are serialized before the limiter records the failure, so concurrent bad retries from one Serve client can lock out the second attempt immediately.

HTTP API endpoints (`/v1/*`, `/tools/invoke`, `/api/channels/*`) do not use Tailscale identity-header auth - they follow the gateway's configured HTTP auth mode.

Gateway HTTP bearer auth is effectively all-or-nothing operator access. Credentials that can call `/v1/chat/completions`, `/v1/responses`, plugin routes such as `/api/v1/admin/rpc`, or `/api/channels/*` are full-access operator secrets for that gateway: shared-secret bearer auth restores the full default operator scopes (`operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.talk.secrets`, `operator.write`) and owner semantics for agent turns, and narrower `x-openclaw-scopes` values do not reduce that shared-secret path. Per-request scope semantics only apply when the request comes from an identity-bearing mode (trusted proxy auth) or an explicitly no-auth private ingress; in those modes, omitting `x-openclaw-scopes` falls back to the normal operator default scope set, and owner-level headers like `x-openclaw-model` require `operator.admin` when scopes are narrowed. `/tools/invoke` and HTTP session history endpoints follow the same shared-secret rule. Do not share these credentials with untrusted callers; prefer separate gateways per trust boundary.

Tokenless Serve auth assumes the gateway host itself is trusted - it is not protection against hostile same-host processes. If untrusted local code may run on the gateway host, disable `allowTailscale` and require explicit shared-secret auth (`token` or `password`).

An externally managed Tailscale Serve or Funnel route may forward these headers to the ordinary listener only through an explicitly configured `gateway.trustedProxies` source with a valid non-loopback forwarded client address. OpenClaw treats that request as generic proxy ingress: the configured gateway auth applies, `allowTailscale` grants nothing, and no WhoIs lookup runs. Gateway-protected routes reject external Funnel ingress when auth mode is `none`; aggregate health, readiness, and startup probes keep their bounded unauthenticated responses. See [Tailscale](/gateway/tailscale#externally-managed-serve-and-funnel), [Health and readiness](/gateway/health), and [Trusted Proxy Auth](/gateway/trusted-proxy-auth).

See [Tailscale](/gateway/tailscale) and [Web overview](/web).

### Reverse proxy configuration

Set `gateway.trustedProxies` for proper forwarded-client IP handling behind nginx/Caddy/Traefik/etc. When the Gateway detects proxy headers from an address **not** in `trustedProxies`, it will not treat the connection as local; if gateway auth is disabled, that connection is rejected. This prevents proxied connections from appearing to come from localhost and receiving automatic trust.

With token or password auth, an unconfigured same-host loopback proxy is
rejected on Gateway-authenticated routes because OpenClaw cannot attribute its
forwarded client headers. HTTP requests receive `403` with
`proxy_attribution_required`; WebSocket auth fails with guidance to configure
`gateway.trustedProxies`. Plugin-authenticated webhook routes retain their own
signature or credential checks and ignore untrusted forwarded claims.
Configure `trustedProxies` narrowly and make the proxy overwrite or safely
rebuild forwarded headers; see [Rate
limiting](/gateway/security/rate-limiting#unconfigured-same-host-reverse-proxies).

`trustedProxies` also feeds `gateway.auth.mode: "trusted-proxy"`, which is stricter: it fails closed on loopback-source proxies by default. Same-host loopback reverse proxies can use `trustedProxies` for local-client detection and forwarded-IP handling, but can only satisfy `trusted-proxy` auth mode when `gateway.auth.trustedProxy.allowLoopback = true`; otherwise use token/password auth.

```yaml
gateway:
  trustedProxies:
    - "10.0.0.1" # reverse proxy IP
  allowRealIpFallback: false # default false; only enable if your proxy cannot provide X-Forwarded-For
  auth:
    mode: password
    password: ${OPENCLAW_GATEWAY_PASSWORD}
```

When `trustedProxies` is set, the Gateway uses `X-Forwarded-For` to determine client IP; `X-Real-IP` is ignored unless `gateway.allowRealIpFallback: true` is explicitly set. Ensure your proxy **overwrites** `X-Forwarded-For`/`X-Real-IP` rather than appending to them:

```nginx
# good
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;

# bad: preserves/appends untrusted client-supplied values
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Trusted proxy headers do not make node device pairing automatically trusted - `gateway.nodes.pairing.autoApproveCidrs` is a separate, disabled-by-default operator policy, and loopback-source trusted-proxy header paths stay excluded from node auto-approval even when loopback trusted-proxy auth is enabled (because local callers can forge those headers).

### HSTS and origin notes

- OpenClaw's gateway is local/loopback first. If you terminate TLS at a reverse proxy, set HSTS there.
- If the gateway itself terminates HTTPS, `gateway.http.securityHeaders.strictTransportSecurity` emits the HSTS header from OpenClaw responses.
- Non-loopback Control UI deployments require `gateway.controlUi.allowedOrigins` by default; `allowedOrigins: ["*"]` is an explicit allow-all policy, not a hardened default - avoid it outside tightly controlled local testing.
- Failed authentication from loopback is never locked out, so a local CLI cannot be denied before its credentials are checked. Wrong credentials are still tracked and progressively delayed (bounded delay, one shared timer per key); successful authentication resets only the matching credential-class history. This raises the cost of repeated guessing from one loopback source; it is not a defense against an attacker who can already open many parallel loopback connections, because credentials are compared before the failure response is delayed. Loopback reachability is a trust boundary in its own right - see [Node pairing](/gateway/pairing#silent-local-pairing).
- Browser-origin auth failures on loopback are still rate-limited even with the general loopback exemption enabled, but the lockout key is scoped per normalized `Origin` value instead of one shared localhost bucket.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables Host-header origin fallback mode; treat it as a dangerous operator-selected policy.
- Treat DNS rebinding and proxy-host header behavior as deployment hardening concerns; keep `trustedProxies` tight and avoid exposing the gateway directly to the public internet.
- Detailed deployment guidance: [Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts).

### Control UI over HTTP

The Control UI generates device identity with pure-JS Ed25519, so pairing works on any origin, including plain HTTP.

- Token/password auth does not replace browser device identity: HTTP browsers still pair with a signed device key, which never crosses the wire. Prefer HTTPS (for example, Tailscale Serve) — plaintext transport still exposes the page and the shared secret to on-path attackers.
- `gateway.controlUi.dangerouslyDisableDeviceAuth`: retired break-glass input, now fully inert. Control UI browsers pair through the normal device flow; `openclaw doctor --fix` removes the legacy key.
- Separately, successful `gateway.auth.mode: "trusted-proxy"` authentication can admit **operator** Control UI sessions without device identity when the browser cannot supply one. Browsers that can mint an identity (any origin, including plain HTTP) follow the normal pairing flow instead — automatic with `deviceAutoApprove`, otherwise a one-time approval. This does not extend to node-role Control UI sessions.

### Insecure/dangerous flags

`openclaw security audit` raises `config.insecure_or_dangerous_flags` for each enabled known insecure/dangerous debug switch (one finding per flag). Keep these unset in production. If audit suppressions are configured, `security.audit.suppressions.active` stays in the active output even when matching findings move to `suppressedFindings`.

<AccordionGroup>
  <Accordion title="Flags tracked by the audit today">
    - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`
    - `security.audit.suppressions configured (<count>)`
    - `hooks.gmail.allowUnsafeExternalContent=true`
    - `hooks.mappings[<index>].allowUnsafeExternalContent=true`
    - `tools.exec.applyPatch.workspaceOnly=false`
    - `plugins.entries.acpx.config.permissionMode=approve-all`

  </Accordion>

  <Accordion title="All dangerous*/dangerously* keys in the config schema">
    Control UI and browser:
    - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`
    - `gateway.controlUi.dangerouslyDisableDeviceAuth` (retired, inert)
    - `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`

    Channel name-matching (bundled and plugin channels; also per `accounts.<accountId>` where applicable):
    - `channels.discord.dangerouslyAllowNameMatching`
    - `channels.googlechat.dangerouslyAllowNameMatching`
    - `channels.msteams.dangerouslyAllowNameMatching`
    - `channels.slack.dangerouslyAllowNameMatching`
    - `channels.irc.dangerouslyAllowNameMatching` (plugin channel)
    - `channels.mattermost.dangerouslyAllowNameMatching` (plugin channel)
    - `channels.synology-chat.dangerouslyAllowNameMatching` (plugin channel)
    - `channels.synology-chat.dangerouslyAllowInheritedWebhookPath` (plugin channel)
    - `channels.zalouser.dangerouslyAllowNameMatching` (plugin channel)

    Network exposure:
    - `channels.telegram.network.dangerouslyAllowPrivateNetwork` (also per account)

    Sandbox Docker (defaults + per-agent):
    - `agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets`
    - `agents.defaults.sandbox.docker.dangerouslyAllowExternalBindSources`
    - `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin`

  </Accordion>
</AccordionGroup>
