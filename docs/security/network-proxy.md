---
summary: "How to route OpenClaw runtime HTTP and WebSocket traffic through an operator-managed filtering proxy"
title: "Network proxy"
read_when:
  - You want defense-in-depth against SSRF and DNS rebinding attacks
  - Configuring an external forward proxy for OpenClaw runtime traffic
---

# Network Proxy

OpenClaw can route runtime HTTP and WebSocket traffic through an operator-managed forward proxy. This is optional defense in depth for deployments that want central egress control, stronger SSRF protection, and better network auditability.

OpenClaw does not ship, download, start, configure, or certify a proxy. You run the proxy technology that fits your environment, and OpenClaw routes normal process-local HTTP and WebSocket clients through it.

## Why Use a Proxy?

A proxy gives operators one network control point for outbound HTTP and WebSocket traffic. That can be useful even outside SSRF hardening:

- Central policy: maintain one egress policy instead of relying on every application HTTP call site to get network rules right.
- Connect-time checks: evaluate the destination after DNS resolution and immediately before the proxy opens the upstream connection.
- DNS rebinding defense: reduce the gap between an application-level DNS check and the actual outbound connection.
- Broader JavaScript coverage: route ordinary `fetch`, `node:http`, `node:https`, WebSocket, axios, got, node-fetch, and similar clients through the same path.
- Auditability: log allowed and denied destinations at the egress boundary.
- Operational control: enforce destination rules, network segmentation, rate limits, or outbound allowlists without rebuilding OpenClaw.

Proxy routing is a process-level guardrail for normal HTTP and WebSocket egress. It gives operators a fail-closed path for routing supported JavaScript HTTP clients through their own filtering proxy, but it is not an OS-level network sandbox and does not make OpenClaw certify the proxy's destination policy.

## How OpenClaw Routes Traffic

When `proxy.enabled=true` and a proxy URL is configured, protected runtime processes such as `openclaw gateway run`, `openclaw node run`, and `openclaw agent --local` route normal HTTP and WebSocket egress through the configured proxy:

```text
OpenClaw process
  fetch                  -> operator-managed filtering proxy -> public internet
  node:http and https    -> operator-managed filtering proxy -> public internet
  WebSocket clients      -> operator-managed filtering proxy -> public internet
```

The public contract is the routing behavior, not the internal Node hooks used to implement it. OpenClaw Gateway control-plane WebSocket clients use a narrow direct path for local loopback Gateway RPC traffic when the Gateway URL uses `localhost` or a literal loopback IP such as `127.0.0.1` or `[::1]`. That control-plane path must be able to reach loopback Gateways even when the operator proxy blocks loopback destinations. Normal runtime HTTP and WebSocket requests still use the configured proxy.

Internally, OpenClaw uses two process-level routing hooks for this feature:

- Undici dispatcher routing covers `fetch`, undici-backed clients, and transports that provide their own undici dispatcher.
- `global-agent` routing covers Node core `node:http` and `node:https` callers, including many libraries layered on `http.request`, `https.request`, `http.get`, and `https.get`. Managed proxy mode forces that global agent so explicit Node HTTP agents do not accidentally bypass the operator proxy.

Some plugins own custom transports that need explicit proxy wiring even when process-level routing exists. For example, Telegram's Bot API transport uses its own HTTP/1 undici dispatcher and therefore honors process proxy env plus the managed `OPENCLAW_PROXY_URL` fallback in that owner-specific transport path.

The proxy URL itself must use `http://`. HTTPS destinations are still supported through the proxy with HTTP `CONNECT`; this only means OpenClaw expects a plain HTTP forward-proxy listener such as `http://127.0.0.1:3128`.

While the proxy is active, OpenClaw clears `no_proxy`, `NO_PROXY`, and `GLOBAL_AGENT_NO_PROXY`. Those bypass lists are destination-based, so leaving `localhost` or `127.0.0.1` there would let high-risk SSRF targets skip the filtering proxy.

On shutdown, OpenClaw restores the previous proxy environment and resets cached process routing state.

## Related Proxy Terms

- `proxy.enabled` / `proxy.proxyUrl`: outbound forward-proxy routing for OpenClaw runtime egress. This page documents that feature.
- `gateway.auth.mode: "trusted-proxy"`: inbound identity-aware reverse-proxy authentication for Gateway access. See [Trusted proxy auth](/gateway/trusted-proxy-auth).
- `openclaw proxy`: local debug proxy and capture inspector for development and support. See [openclaw proxy](/cli/proxy).
- Channel or provider-specific proxy settings: owner-specific overrides for a particular transport. Prefer the managed network proxy when the goal is central egress control across the runtime.

## Configuration

```yaml
proxy:
  enabled: true
  proxyUrl: http://127.0.0.1:3128
```

You can also provide the URL through the environment, while keeping `proxy.enabled=true` in config:

```bash
OPENCLAW_PROXY_URL=http://127.0.0.1:3128 openclaw gateway run
```

`proxy.proxyUrl` takes precedence over `OPENCLAW_PROXY_URL`.

If `enabled=true` but no valid proxy URL is configured, protected commands fail startup instead of falling back to direct network access.

For managed gateway services started with `openclaw gateway start`, prefer storing the URL in config:

```bash
openclaw config set proxy.enabled true
openclaw config set proxy.proxyUrl http://127.0.0.1:3128
openclaw gateway install --force
openclaw gateway start
```

The environment fallback is best for foreground runs. If you use it with an installed service, put `OPENCLAW_PROXY_URL` in the service durable environment, such as `$OPENCLAW_STATE_DIR/.env` or `~/.openclaw/.env`, then reinstall the service so launchd, systemd, or Scheduled Tasks starts the gateway with that value.

For `openclaw --container ...` commands, OpenClaw forwards `OPENCLAW_PROXY_URL` into the container-targeted child CLI when it is set. The URL must be reachable from inside the container; `127.0.0.1` refers to the container itself, not the host. OpenClaw rejects loopback proxy URLs for container-targeted commands unless you explicitly override that safety check.

## Proxy Requirements

The proxy policy is the security boundary. OpenClaw cannot verify that the proxy blocks the right targets.

Configure the proxy to:

- Bind only to loopback or a private trusted interface.
- Restrict access so only the OpenClaw process, host, container, or service account can use it.
- Resolve destinations itself and block destination IPs after DNS resolution.
- Apply policy at connect time for both plain HTTP requests and HTTPS `CONNECT` tunnels.
- Reject destination-based bypasses for loopback, private, link-local, metadata, multicast, reserved, or documentation ranges.
- Avoid hostname allowlists unless you fully trust the DNS resolution path.
- Log destination, decision, status, and reason without logging request bodies, authorization headers, cookies, or other secrets.
- Keep proxy policy under version control and review changes like security-sensitive configuration.

## Recommended Blocked Destinations

Use this denylist as the starting point for any forward proxy, firewall, or egress policy.

OpenClaw application-level classifier logic lives in `src/infra/net/ssrf.ts` and `src/shared/net/ip.ts`. The relevant parity hooks are `BLOCKED_HOSTNAMES`, `BLOCKED_IPV4_SPECIAL_USE_RANGES`, `BLOCKED_IPV6_SPECIAL_USE_RANGES`, `RFC2544_BENCHMARK_PREFIX`, and the embedded IPv4 sentinel handling for NAT64, 6to4, Teredo, ISATAP, and IPv4-mapped forms. Those files are useful references when maintaining an external proxy policy, but OpenClaw does not automatically export or enforce those rules in your proxy.

| Range or host                                                                        | Why to block                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `127.0.0.0/8`, `localhost`, `localhost.localdomain`                                  | IPv4 loopback                                        |
| `::1/128`                                                                            | IPv6 loopback                                        |
| `0.0.0.0/8`, `::/128`                                                                | Unspecified and this-network addresses               |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`                                      | RFC1918 private networks                             |
| `169.254.0.0/16`, `fe80::/10`                                                        | Link-local addresses and common cloud metadata paths |
| `169.254.169.254`, `metadata.google.internal`                                        | Cloud metadata services                              |
| `100.64.0.0/10`                                                                      | Carrier-grade NAT shared address space               |
| `198.18.0.0/15`, `2001:2::/48`                                                       | Benchmarking ranges                                  |
| `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32` | Special-use and documentation ranges                 |
| `224.0.0.0/4`, `ff00::/8`                                                            | Multicast                                            |
| `240.0.0.0/4`                                                                        | Reserved IPv4                                        |
| `fc00::/7`, `fec0::/10`                                                              | IPv6 local/private ranges                            |
| `100::/64`, `2001:20::/28`                                                           | IPv6 discard and ORCHIDv2 ranges                     |
| `64:ff9b::/96`, `64:ff9b:1::/48`                                                     | NAT64 prefixes with embedded IPv4                    |
| `2002::/16`, `2001::/32`                                                             | 6to4 and Teredo with embedded IPv4                   |
| `::/96`, `::ffff:0:0/96`                                                             | IPv4-compatible and IPv4-mapped IPv6                 |

If your cloud provider or network platform documents additional metadata hosts or reserved ranges, add those too.

## Validation

Validate the proxy from the same host, container, or service account that runs OpenClaw:

```bash
openclaw proxy validate --proxy-url http://127.0.0.1:3128
```

By default, when no custom destinations are provided, the command checks that `https://example.com/` succeeds and starts a temporary loopback canary that the proxy must not reach. The default denied check passes when the proxy returns a non-2xx denial response or blocks the canary with a transport failure; it fails if a successful response reaches the canary. If no proxy is enabled and configured, validation reports a config problem; use `--proxy-url` for a one-off preflight before changing config. Use `--allowed-url` and `--denied-url` to test deployment-specific expectations. Add `--apns-reachable` to also verify direct APNs HTTP/2 delivery can open a CONNECT tunnel through the proxy and receive a sandbox APNs response; the probe uses an intentionally invalid provider token, so `403 InvalidProviderToken` is expected and counts as reachable. Custom denied destinations are fail-closed: any HTTP response means the destination was reachable through the proxy, and any transport error is reported as inconclusive because OpenClaw cannot prove the proxy blocked a reachable origin. On validation failure, the command exits with code 1.

Use `--json` for automation. The JSON output contains the overall result, the effective proxy config source, any config errors, and each destination check. Proxy URL credentials are redacted in text and JSON output:

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
    {
      "kind": "allowed",
      "url": "https://example.com/",
      "ok": true,
      "status": 200
    },
    {
      "kind": "apns",
      "url": "https://api.sandbox.push.apple.com",
      "ok": true,
      "status": 403
    }
  ]
}
```

You can also validate manually with `curl`:

```bash
curl -x http://127.0.0.1:3128 https://example.com/
curl -x http://127.0.0.1:3128 http://127.0.0.1/
curl -x http://127.0.0.1:3128 http://169.254.169.254/
```

The public request should succeed. The loopback and metadata requests should be blocked by the proxy. For `openclaw proxy validate`, the built-in loopback canary can distinguish a proxy denial from a reachable origin. Custom `--denied-url` checks do not have that canary, so treat both HTTP responses and ambiguous transport failures as validation failures unless your proxy exposes a deployment-specific denial signal you can verify separately.

Then enable OpenClaw proxy routing:

```bash
openclaw config set proxy.enabled true
openclaw config set proxy.proxyUrl http://127.0.0.1:3128
openclaw gateway run
```

or set:

```yaml
proxy:
  enabled: true
  proxyUrl: http://127.0.0.1:3128
```

## Limits

- The proxy improves coverage for process-local JavaScript HTTP and WebSocket clients, but it is not an OS-level network sandbox.
- Raw `net`, `tls`, and `http2` sockets, native addons, and child processes may bypass Node-level proxy routing unless they inherit and respect proxy environment variables.
- IRC is a raw TCP/TLS channel outside operator-managed forward proxy routing. In deployments that require all egress through that forward proxy, set `channels.irc.enabled=false` unless direct IRC egress is explicitly approved.
- The local debug proxy is diagnostic tooling and its direct upstream forwarding for proxy requests and CONNECT tunnels is disabled by default while managed proxy mode is active; enable direct forwarding only for approved local diagnostics.
- User local WebUIs and local model servers should be allowlisted in the operator proxy policy when needed; OpenClaw does not expose a general local-network bypass for them.
- Gateway control-plane proxy bypass is intentionally limited to `localhost` and literal loopback IP URLs. Use `ws://127.0.0.1:18789`, `ws://[::1]:18789`, or `ws://localhost:18789` for local direct Gateway control-plane connections; other hostnames route like ordinary hostname-based traffic.
- OpenClaw does not inspect, test, or certify your proxy policy.
- Treat proxy policy changes as security-sensitive operational changes.
