---
summary: "How to route OpenClaw runtime HTTP and WebSocket traffic through an operator-managed filtering proxy"
title: "Network proxy"
read_when:
  - You want defense-in-depth against SSRF and DNS rebinding attacks
  - Configuring an external forward proxy for OpenClaw runtime traffic
---

OpenClaw can route runtime HTTP and WebSocket traffic through an operator-managed forward proxy. This is optional defense in depth: central egress control, stronger SSRF protection, and destination auditability at the network boundary. Because the proxy evaluates the destination at connect time, after DNS resolution and immediately before it opens the upstream connection, it also narrows the gap a DNS-rebinding attack relies on between an earlier application-level DNS check and the actual outbound connection. A single proxy policy also gives operators one place to enforce destination rules, network segmentation, rate limits, or outbound allowlists without rebuilding OpenClaw.

OpenClaw does not ship, download, start, configure, or certify a proxy. You run the proxy technology that fits your environment; OpenClaw routes its own HTTP and WebSocket clients through it.

## Configuration

```yaml
proxy:
  proxyUrl: http://127.0.0.1:3128
```

You can also set the URL through the environment:

```bash
OPENCLAW_PROXY_URL=http://127.0.0.1:3128 openclaw gateway run
```

`proxy.proxyUrl` takes precedence over `OPENCLAW_PROXY_URL`. A configured URL activates managed proxy routing; removing both URLs disables it.

| Key                  | Type                                 | Default        | Notes                                                                                                                                 |
| -------------------- | ------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy.proxyUrl`     | string                               | unset          | `http://` or `https://` forward proxy URL. Credentials embedded in the URL are treated as sensitive and redacted from snapshots/logs. |
| `proxy.tls.caFile`   | string                               | unset          | CA bundle for verifying an `https://` proxy endpoint signed by a private CA.                                                          |
| `proxy.loopbackMode` | `gateway-only` \| `proxy` \| `block` | `gateway-only` | Controls loopback bypass behavior; see below.                                                                                         |

For managed gateway services, store the URL in config so it survives reinstall, rather than relying on foreground env:

```bash
openclaw config set proxy.proxyUrl http://127.0.0.1:3128
openclaw gateway install --force
openclaw gateway start
```

The `OPENCLAW_PROXY_URL` env fallback is best for foreground runs. To use it with an installed service, put it in the service's durable environment (`$OPENCLAW_STATE_DIR/.env`, default `~/.openclaw/.env`), then reinstall so launchd/systemd/Scheduled Tasks picks it up.

### HTTPS proxy endpoint with a private CA

```yaml
proxy:
  proxyUrl: https://proxy.corp.example:8443
  tls:
    caFile: /etc/openclaw/proxy-ca.pem
```

`proxy.tls.caFile` verifies the proxy endpoint's own TLS certificate. It is not a destination MITM trust setting, a client certificate, or a substitute for the proxy's destination policy. Use `NODE_EXTRA_CA_CERTS` instead only when the entire Node process must trust an additional CA from startup (for example, an enterprise TLS-inspection system re-signing every HTTPS destination certificate) — that variable is process-global and must be set before Node starts, so OpenClaw cannot apply it mid-run the way it applies `proxy.tls.caFile`. Prefer `proxy.tls.caFile` for HTTPS proxy endpoint trust: it is scoped to managed proxy routing instead of the whole process.

```bash
openclaw config set proxy.proxyUrl https://proxy.corp.example:8443
openclaw config set proxy.tls.caFile /etc/openclaw/proxy-ca.pem
openclaw gateway run
```

## How routing works

With a valid proxy URL, protected runtime processes (`openclaw gateway run`, `openclaw node run`, `openclaw agent --local`) route normal HTTP and WebSocket egress through the proxy:

```text
OpenClaw process
  fetch, node:http, node:https, WebSocket clients  -> operator proxy -> destination
```

Internally, OpenClaw installs [Proxyline](https://github.com/openclaw/proxyline) as the process-level routing runtime. It covers `fetch`, undici-backed clients, `node:http`/`node:https`, common WebSocket clients, and helper-created `CONNECT` tunnels, and it replaces caller-provided Node HTTP agents so explicit agents (including `axios`, `got`, `node-fetch`, and similar Node-agent-based clients) cannot silently bypass the proxy.

The proxy URL scheme describes the hop from OpenClaw to the proxy, not to the final destination:

- `http://proxy.example:3128` — plain TCP to the proxy; OpenClaw sends HTTP proxy requests, including `CONNECT` for HTTPS destinations.
- `https://proxy.example:8443` — OpenClaw opens TLS to the proxy itself (verifying the proxy's certificate), then sends HTTP proxy requests inside that session.

Destination TLS is independent of proxy-endpoint TLS: for an HTTPS destination, OpenClaw always asks the proxy for a `CONNECT` tunnel and starts destination TLS through that tunnel.

While the proxy is active, OpenClaw clears `no_proxy`/`NO_PROXY`. Those bypass lists are destination-based; leaving `localhost` or `127.0.0.1` there would let SSRF targets skip the proxy entirely. On shutdown, OpenClaw restores the prior proxy environment and resets cached routing state.

Some plugins own a custom transport that needs its own proxy wiring even with process-level routing active. Telegram's Bot API client uses its own HTTP/1 undici dispatcher and separately honors process proxy env plus the `OPENCLAW_PROXY_URL` fallback.

### Gateway loopback mode

Local Gateway control-plane clients normally connect to a loopback WebSocket such as `ws://127.0.0.1:18789`. `proxy.loopbackMode` controls whether that traffic bypasses the managed proxy:

```yaml
proxy:
  proxyUrl: http://127.0.0.1:3128
  loopbackMode: gateway-only # gateway-only, proxy, or block
```

A configured `proxyUrl` or `OPENCLAW_PROXY_URL` enables managed routing. Set
`proxy.enabled: false` only as an advanced opt-out that keeps the URL stored
without activating it.

| Mode                     | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway-only` (default) | OpenClaw registers the active Gateway loopback authority as a direct-connect exception, so local Gateway WebSocket traffic connects without the proxy. Custom loopback ports work because the exception targets the exact configured host/port. The bundled browser plugin registers the same kind of exception for the exact local CDP readiness and DevTools WebSocket URLs of OpenClaw-launched managed browsers; the bundled Ollama memory embedding provider has a narrower guarded direct path for its exact configured host-local loopback embedding origin. |
| `proxy`                  | No loopback exceptions are registered; Gateway and Ollama loopback traffic goes through the proxy. A remote proxy must be able to route back to the OpenClaw host's loopback service (for example via a reachable hostname, IP, or tunnel) — a standard remote proxy resolves `127.0.0.1`/`localhost` against itself, not against the OpenClaw host.                                                                                                                                                                                                                |
| `block`                  | OpenClaw denies Gateway loopback control-plane connections and guarded Ollama loopback embedding connections before opening a socket.                                                                                                                                                                                                                                                                                                                                                                                                                               |

Gateway control-plane bypass is limited to `localhost` and literal loopback IP URLs — use `ws://127.0.0.1:18789`, `ws://[::1]:18789`, or `ws://localhost:18789`. Other hostnames route like ordinary traffic.

### Containers

For `openclaw --container ...` commands, OpenClaw forwards `OPENCLAW_PROXY_URL` into the container-targeted child CLI when it is set. The URL must be reachable from inside the container — `127.0.0.1` there refers to the container itself, not the host. OpenClaw rejects loopback proxy URLs for container-targeted commands unless you set `OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL=1` to explicitly override that check.

## Related proxy terms

- `proxy.enabled` / `proxy.proxyUrl` — outbound forward-proxy routing for runtime egress. This page.
- `gateway.auth.mode: "trusted-proxy"` — inbound identity-aware reverse-proxy authentication for Gateway access. See [Trusted proxy auth](/gateway/trusted-proxy-auth).
- `openclaw proxy` — local debug proxy and capture inspector for development and support. See [openclaw proxy](/cli/proxy).
- `tools.web.fetch.useTrustedEnvProxy` — opt-in for `web_fetch` to let an operator-controlled HTTP(S) env proxy resolve DNS while keeping strict DNS pinning and hostname policy by default. See [Web fetch](/tools/web-fetch#trusted-env-proxy).
- Channel- or provider-specific proxy settings — owner-specific overrides for one transport. Prefer the managed network proxy for central egress control across the runtime.

## Validating the proxy

The proxy's destination policy is the actual security boundary; OpenClaw cannot verify that your proxy blocks the right targets. Configure it to:

- Bind only to loopback or a private trusted interface, reachable only by the OpenClaw process/host/container/service account.
- Resolve destinations itself and block by IP after DNS resolution, at connect time, for both plain HTTP and HTTPS `CONNECT` tunnels.
- Reject destination-based bypasses for loopback, private, link-local, metadata, multicast, reserved, and documentation ranges.
- Avoid hostname allowlists unless you fully trust the DNS resolution path.
- Log destination, decision, status, and reason — never request bodies, authorization headers, cookies, or other secrets.
- Keep the policy under version control and review changes as security-sensitive.

Validate from the same host/container/service account that runs OpenClaw:

```bash
openclaw proxy validate --proxy-url http://127.0.0.1:3128
```

With a private-CA HTTPS proxy endpoint:

```bash
openclaw proxy validate --proxy-url https://proxy.corp.example:8443 --proxy-ca-file /etc/openclaw/proxy-ca.pem
```

| Flag                     | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `--proxy-url <url>`      | Validate this URL instead of resolving config/env.                   |
| `--proxy-ca-file <path>` | CA bundle for an HTTPS proxy endpoint.                               |
| `--allowed-url <url>`    | Destination expected to succeed (repeatable).                        |
| `--denied-url <url>`     | Destination expected to be blocked (repeatable).                     |
| `--apns-reachable`       | Also verify the proxy can tunnel a direct sandbox APNs HTTP/2 probe. |
| `--apns-authority <url>` | Override the APNs authority probed with `--apns-reachable`.          |
| `--timeout-ms <ms>`      | Per-request timeout.                                                 |
| `--json`                 | Machine-readable output.                                             |

If no config, environment, or `--proxy-url` value is available, the command reports a config problem; pass `--proxy-url` for a one-off preflight before changing config.

With no `--allowed-url`/`--denied-url`, the default checks are: `https://example.com/` must succeed, and a temporary loopback canary server the proxy must not reach must be blocked. The loopback check passes on a transport failure, or on a non-2xx response that lacks the canary's per-run token; it fails on a 2xx response missing the token (an unexpected success from something other than the canary) and, especially, on any response carrying the matching token, since that proves the proxy actually forwarded a loopback destination it should have denied. Custom `--denied-url` targets have no such canary token, so they are fail-closed: any HTTP response counts as reachable (fail), and a transport error is reported as inconclusive rather than proven-blocked, because OpenClaw cannot confirm your proxy denied a reachable origin versus something else going wrong. `--apns-reachable` sends an intentionally invalid provider token, so a `403 InvalidProviderToken` response counts as proof the tunnel reached Apple. The command exits `1` on any validation failure; proxy URL credentials are redacted from both text and JSON output.

```json
{
  "ok": true,
  "config": {
    "enabled": true,
    "proxyUrl": "http://127.0.0.1:3128/",
    "source": "override",
    "errors": []
  },
  "checks": [
    { "kind": "allowed", "url": "https://example.com/", "ok": true, "status": 200 },
    { "kind": "apns", "url": "https://api.sandbox.push.apple.com", "ok": true, "status": 403 }
  ]
}
```

Manual `curl` check (the public request should succeed; the loopback and metadata requests should be blocked by the proxy itself — `curl` alone cannot distinguish a proxy denial from an unreachable origin the way `openclaw proxy validate`'s built-in canary can):

```bash
curl -x http://127.0.0.1:3128 https://example.com/
curl -x http://127.0.0.1:3128 http://127.0.0.1/
curl -x http://127.0.0.1:3128 http://169.254.169.254/
```

## Recommended blocked destinations

Starting denylist for any forward proxy, firewall, or egress policy. OpenClaw's own SSRF classifier lives in `src/infra/net/ssrf.ts` and `packages/net-policy/src/ip.ts` (`BLOCKED_HOSTNAMES`, `BLOCKED_IPV4_SPECIAL_USE_RANGES`, `BLOCKED_IPV6_SPECIAL_USE_RANGES`, the RFC 2544 benchmark prefix, and embedded-IPv4 handling for NAT64/6to4/Teredo/ISATAP/IPv4-mapped forms) — useful references, but OpenClaw does not export or enforce these rules in your external proxy.

| Range or host                                                                        | Why to block                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `127.0.0.0/8`, `localhost`, `localhost.localdomain`                                  | IPv4 loopback                                     |
| `::1/128`                                                                            | IPv6 loopback                                     |
| `0.0.0.0/8`, `::/128`                                                                | Unspecified / this-network addresses              |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`                                      | RFC 1918 private networks                         |
| `169.254.0.0/16`, `fe80::/10`                                                        | Link-local, including common cloud metadata paths |
| `169.254.169.254`, `metadata.google.internal`                                        | Cloud metadata services                           |
| `100.64.0.0/10`                                                                      | Carrier-grade NAT shared address space            |
| `198.18.0.0/15`, `2001:2::/48`                                                       | Benchmarking ranges                               |
| `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32` | Special-use and documentation ranges              |
| `224.0.0.0/4`, `ff00::/8`                                                            | Multicast                                         |
| `240.0.0.0/4`                                                                        | Reserved IPv4                                     |
| `fc00::/7`, `fec0::/10`                                                              | IPv6 local/private ranges                         |
| `100::/64`, `2001:20::/28`                                                           | IPv6 discard and ORCHIDv2 ranges                  |
| `64:ff9b::/96`, `64:ff9b:1::/48`                                                     | NAT64 prefixes with embedded IPv4                 |
| `2002::/16`, `2001::/32`                                                             | 6to4 and Teredo with embedded IPv4                |
| `::/96`, `::ffff:0:0/96`                                                             | IPv4-compatible and IPv4-mapped IPv6              |

Add any additional metadata hosts or reserved ranges your cloud provider or network platform documents.

## Limits

| Surface                                                      | Managed proxy status                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`, `node:http`, `node:https`, common WebSocket clients | Routed through managed proxy hooks when configured.                                                                                                      |
| APNs direct HTTP/2                                           | Routed through the APNs managed `CONNECT` helper.                                                                                                        |
| Gateway control-plane loopback                               | Direct only for the exact configured local loopback Gateway URL.                                                                                         |
| Debug proxy upstream forwarding                              | Disabled while managed proxy mode is active unless explicitly enabled for local diagnostics.                                                             |
| IRC                                                          | Raw TCP/TLS; not proxied by managed HTTP proxy mode. Set `channels.irc.enabled: false` if your deployment requires all egress through the forward proxy. |
| Other raw `net`, `tls`, or `http2` client calls              | Must be classified by the raw socket guard before landing.                                                                                               |

- This is process-level coverage for JavaScript HTTP/WebSocket clients, not an OS-level network sandbox.
- Raw `net`, `tls`, `http2` sockets, native addons, and non-OpenClaw child processes may bypass Node-level routing unless they inherit and respect proxy environment variables. Forked OpenClaw child CLIs inherit the managed proxy URL and `proxy.loopbackMode` state.
- User local WebUIs and local model servers are not covered by a general local-network bypass — allowlist them in the operator proxy policy if needed. The exception is the bundled Ollama memory embedding provider's guarded direct path, scoped to the exact host-local loopback origin from its configured `baseUrl`; LAN, tailnet, private-network, and public Ollama hosts still use the managed proxy.
- The local debug proxy's direct upstream forwarding (for proxy requests and `CONNECT` tunnels) is disabled by default while managed proxy mode is active; enable it only for approved local diagnostics.
- OpenClaw does not inspect, test, or certify your proxy policy. Treat proxy policy changes as security-sensitive operational changes.
