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

OpenClaw still keeps application-level SSRF guards such as `fetchWithSsrFGuard`. Proxy routing is an additional process-level guardrail for normal HTTP and WebSocket egress, not a replacement for guarded fetches or an OS-level network sandbox.

## How OpenClaw Routes Traffic

When `proxy.enabled=true` and a proxy URL is configured, protected runtime processes such as `openclaw gateway run`, `openclaw node run`, and `openclaw agent --local` route normal HTTP and WebSocket egress through the configured proxy:

```text
OpenClaw process
  fetch                  -> operator-managed filtering proxy -> public internet
  node:http and https    -> operator-managed filtering proxy -> public internet
  WebSocket clients      -> operator-managed filtering proxy -> public internet
```

The public contract is the routing behavior, not the internal Node hooks used to implement it. OpenClaw Gateway control-plane WebSocket clients use a narrow direct path for local loopback Gateway RPC traffic when the Gateway URL uses a literal loopback IP such as `127.0.0.1` or `[::1]`. That control-plane path must be able to reach loopback Gateways even when the operator proxy blocks loopback destinations. Normal runtime HTTP and WebSocket requests still use the configured proxy.

The proxy URL itself must use `http://`. HTTPS destinations are still supported through the proxy with HTTP `CONNECT`; this only means OpenClaw expects a plain HTTP forward-proxy listener such as `http://127.0.0.1:3128`.

While the proxy is active, OpenClaw clears `no_proxy`, `NO_PROXY`, and `GLOBAL_AGENT_NO_PROXY`. Those bypass lists are destination-based, so leaving `localhost` or `127.0.0.1` there would let high-risk SSRF targets skip the filtering proxy.

On shutdown, OpenClaw restores the previous proxy environment and resets cached process routing state.

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
curl -x http://127.0.0.1:3128 https://example.com/
curl -x http://127.0.0.1:3128 http://127.0.0.1/
curl -x http://127.0.0.1:3128 http://169.254.169.254/
```

The public request should succeed. The loopback and metadata requests should fail at the proxy.

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

- The proxy improves coverage for process-local JavaScript HTTP and WebSocket clients, but it does not replace application-level `fetchWithSsrFGuard`.
- Raw `net`, `tls`, and `http2` sockets, native addons, and child processes may bypass Node-level proxy routing unless they inherit and respect proxy environment variables.
- User local WebUIs and local model servers should be allowlisted in the operator proxy policy when needed; OpenClaw does not expose a general local-network bypass for them.
- Gateway control-plane proxy bypass is intentionally limited to literal loopback IP URLs. Use `ws://127.0.0.1:18789` or `ws://[::1]:18789` for local direct Gateway control-plane connections; `localhost` hostnames route like ordinary hostname-based traffic.
- OpenClaw does not inspect, test, or certify your proxy policy.
- Treat proxy policy changes as security-sensitive operational changes.
