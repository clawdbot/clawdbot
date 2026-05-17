---
summary: "CLI reference for `openclaw proxy`, including operator-managed proxy validation and the local debug proxy capture inspector"
read_when:
  - You need to validate operator-managed proxy routing before deployment
  - You need to capture OpenClaw transport traffic locally for debugging
  - You want to inspect debug proxy sessions, blobs, or built-in query presets
title: "Proxy"
---

# `openclaw proxy`

Validate operator-managed proxy routing, or run the local explicit debug proxy
and inspect captured traffic.

Use `validate` to preflight an operator-managed forward proxy before enabling
OpenClaw proxy routing. The other commands are debugging tools for
transport-level investigation: they can start a local proxy, run a child command
with capture enabled, list capture sessions, query common traffic patterns, read
captured blobs, and purge local capture data.

## Commands

```bash
openclaw proxy start [--host <host>] [--port <port>]
openclaw proxy run [--host <host>] [--port <port>] -- <cmd...>
openclaw proxy validate [--json] [--proxy-url <url>] [--proxy-ca-file <path>] [--allowed-url <url>] [--denied-url <url>] [--apns-reachable] [--apns-authority <url>] [--timeout-ms <ms>]
openclaw proxy coverage
openclaw proxy sessions [--limit <count>]
openclaw proxy query --preset <name> [--session <id>]
openclaw proxy blob --id <blobId>
openclaw proxy purge
```

## Validate

`openclaw proxy validate` checks the effective operator-managed proxy URL from
`--proxy-url`, config, or `OPENCLAW_PROXY_URL`. Managed proxy URLs can use
`http://` for a plain forward-proxy listener or `https://` when OpenClaw must
open TLS to the proxy endpoint before sending proxy requests. It reports a
config problem when no proxy is enabled and configured; use `--proxy-url` for a
one-off preflight before changing config. Add `--proxy-ca-file` to trust a
private CA for the TLS connection to an HTTPS proxy endpoint. By default it
verifies that a public destination succeeds through the proxy and that the proxy
cannot reach a temporary loopback canary. Custom denied destinations are
fail-closed: HTTP responses and ambiguous transport failures both fail unless
you can verify a deployment-specific denial signal separately. Add
`--apns-reachable` to also open an APNs HTTP/2 CONNECT tunnel through the proxy
and confirm sandbox APNs responds; the probe uses an intentionally invalid
provider token, so an APNs `403 InvalidProviderToken` response is a successful
reachability signal.

Options:

- `--json`: print machine-readable JSON.
- `--proxy-url <url>`: validate this `http://` or `https://` proxy URL instead of config or env.
- `--proxy-ca-file <path>`: trust this PEM CA file for TLS verification of an HTTPS proxy endpoint.
- `--allowed-url <url>`: add a destination expected to succeed through the proxy. Repeat to check multiple destinations.
- `--denied-url <url>`: add a destination expected to be blocked by the proxy. Repeat to check multiple destinations.
- `--apns-reachable`: also verify sandbox APNs HTTP/2 is reachable through the proxy.
- `--apns-authority <url>`: APNs authority to probe with `--apns-reachable` (`https://api.sandbox.push.apple.com` by default; production is `https://api.push.apple.com`).
- `--timeout-ms <ms>`: per-request timeout in milliseconds.

See [Network Proxy](/security/network-proxy) for deployment guidance and denial
semantics.

## Query presets

`openclaw proxy query --preset <name>` accepts:

- `double-sends`
- `retry-storms`
- `cache-busting`
- `ws-duplicate-frames`
- `missing-ack`
- `error-bursts`

## Notes

- `start` defaults to `127.0.0.1` unless `--host` is set.
- `run` starts a local debug proxy and then runs the command after `--`.
- The debug proxy's direct upstream forwarding opens upstream sockets for diagnostics. When OpenClaw managed proxy mode is active, direct forwarding for proxy requests and CONNECT tunnels is disabled by default; set `OPENCLAW_DEBUG_PROXY_ALLOW_DIRECT_CONNECT_WITH_MANAGED_PROXY=1` only for approved local diagnostics.
- `validate` exits with code 1 when proxy config or destination checks fail.
- Captures are local debugging data; use `openclaw proxy purge` when finished.

## Related

- [CLI reference](/cli)
- [Network Proxy](/security/network-proxy)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
