---
summary: "CLI reference for `openclaw proxy`, including operator-managed proxy validation and the local debug proxy capture inspector"
read_when:
  - You need to validate operator-managed proxy routing before deployment
  - You need to capture OpenClaw transport traffic locally for debugging
  - You want to inspect debug proxy sessions, blobs, or built-in query presets
title: "Proxy"
---

# `openclaw proxy`

Validate operator-managed proxy routing, or run the local explicit debug proxy and inspect captured traffic.

```bash
openclaw proxy validate [--json] [--proxy-url <url>] [--proxy-ca-file <path>] [--allowed-url <url>] [--denied-url <url>] [--apns-reachable] [--apns-authority <url>] [--timeout-ms <ms>]
openclaw proxy start [--host <host>] [--port <port>]
openclaw proxy run [--host <host>] [--port <port>] -- <cmd...>
openclaw proxy coverage
openclaw proxy sessions [--limit <count>]
openclaw proxy query --preset <name> [--session <id>]
openclaw proxy blob --id <blobId>
openclaw proxy purge
```

`validate` preflights an operator-managed forward proxy. The rest are debugging tools for transport-level investigation: start a local capturing proxy, run a child command through it, list capture sessions, query traffic patterns, read captured blobs, and purge local capture data.

## Validate

Checks the effective operator-managed proxy URL from `--proxy-url`, config (`proxy.proxyUrl`), or `OPENCLAW_PROXY_URL`, in that precedence order. Reports a config problem if no proxy is enabled and configured; pass `--proxy-url` for a one-off preflight without touching config.

Managed proxy URLs use `http://` for a plain forward-proxy listener, or `https://` when OpenClaw must open TLS to the proxy endpoint itself before sending proxy requests. Use `--proxy-ca-file` to trust a private CA for that TLS connection.

By default it runs:

- one **allowed** check against `https://example.com/` (override/add with `--allowed-url`, repeatable)
- one **denied** check against a temporary loopback canary (override with `--denied-url`, repeatable)

Custom `--denied-url` targets are fail-closed: both HTTP responses and ambiguous transport failures count as failures unless you can independently verify a deployment-specific denial signal. The built-in loopback canary is the only target where a transport error is treated as proof of blocking.

Add `--apns-reachable` to also open an APNs HTTP/2 CONNECT tunnel through the proxy and confirm sandbox APNs responds. The probe sends an intentionally invalid provider token, so an APNs `403 InvalidProviderToken` response counts as a successful reachability signal (not a failure).

### Options

| Flag                     | Effect                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `--json`                 | print machine-readable JSON                                                                                        |
| `--proxy-url <url>`      | validate this `http://`/`https://` proxy URL instead of config or env                                              |
| `--proxy-ca-file <path>` | trust this PEM CA file for TLS verification of an HTTPS proxy endpoint                                             |
| `--allowed-url <url>`    | destination expected to succeed through the proxy (repeatable)                                                     |
| `--denied-url <url>`     | destination expected to be blocked by the proxy (repeatable)                                                       |
| `--apns-reachable`       | also verify sandbox APNs HTTP/2 is reachable through the proxy                                                     |
| `--apns-authority <url>` | APNs authority to probe (default `https://api.sandbox.push.apple.com`; production is `https://api.push.apple.com`) |
| `--timeout-ms <ms>`      | per-request timeout                                                                                                |

Exits with code 1 when proxy config or destination checks fail.

See [Network Proxy](/security/network-proxy) for deployment guidance and denial semantics.

## Debug proxy

`start` launches a local capturing proxy and prints its URL, CA cert path, and capture DB path; stop with Ctrl+C. Defaults to binding `127.0.0.1` unless `--host` is set.

`run` starts a local debug proxy, then runs `<cmd...>` (after `--`) with the proxy env applied, under its own capture session.

The debug proxy's direct upstream forwarding opens upstream sockets for diagnostics. When OpenClaw managed proxy mode is active, direct forwarding for proxy requests and CONNECT tunnels is disabled by default; set `OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY=1` only for approved local diagnostics.

`coverage` prints a JSON report (`summary` + per-transport `entries`) of which transports are captured, proxy-only, or uncovered.

`sessions` lists recent capture sessions (`--limit`, default 20).

`query --preset <name>` runs a built-in query against captured traffic, optionally scoped to `--session <id>`. Presets:

- `double-sends`
- `retry-storms`
- `cache-busting`
- `ws-duplicate-frames`
- `missing-ack`
- `error-bursts`

`blob --id <blobId>` prints a captured payload blob's raw content.

`purge` deletes all captured traffic metadata and blobs. Captures are local debugging data; purge when finished.

## Related

- [CLI reference](/cli)
- [Network Proxy](/security/network-proxy)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
