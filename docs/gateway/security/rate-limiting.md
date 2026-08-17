---
summary: "Reference for every Gateway rate limit: pre-auth lockouts, browser and webhook throttles, the control-plane write backstop, ACP session caps, and restart cooldown"
read_when:
  - A client sees `rate limit exceeded for <method>`, `AUTH_RATE_LIMITED`, or lockout errors
  - You want to tune `gateway.auth.rateLimit`
  - You are reasoning about brute-force protection on an exposed Gateway
  - You need to know which Gateway surfaces are throttled, at what limits
title: "Rate limiting"
---

The Gateway enforces several independent rate limits. They protect different
boundaries, key on different identities, and fail with different error shapes.
This page is the reference for all of them.

At a glance:

| Surface                             | Limit (default)                  | Keyed by                         | Configurable             |
| ----------------------------------- | -------------------------------- | -------------------------------- | ------------------------ |
| Failed auth (token/password/device) | 10 failures / 60s, 5 min lockout | IP + credential scope            | `gateway.auth.rateLimit` |
| Browser-origin WS auth failures     | same, loopback **not** exempt    | IP, or page origin from loopback | `gateway.auth.rateLimit` |
| Webhook (`/hooks`) auth failures    | 20 failures / 60s, 60s lockout   | IP                               | no                       |
| Control-plane write RPCs            | 30 requests / 60s per method     | method + device + IP             | no                       |
| ACP session creation                | 120 sessions / 10s               | translator instance              | internal                 |
| Gateway restart cycles              | 30s cooldown between restarts    | process                          | no                       |

## Authentication attempts (pre-auth)

Failed authentication attempts are throttled per client IP, before any
request handling. This is the brute-force guard for exposed Gateways.

- Only _wrong_ credentials count. Missing credentials (a client that never
  sent a token) and successful authentications do not consume budget. A
  successful auth normally resets the matching credential-class counter for
  that client IP; success with a device token does not erase shared-secret
  failures, or vice versa.
- Defaults: 10 failures per 60 seconds, then a 5 minute lockout for that IP.
- Loopback (`127.0.0.1` / `::1`) is exempt by default so local CLI sessions
  cannot be locked out.
- Counters are scoped per credential class, so a flood against one surface
  does not displace another. Scopes include the shared gateway
  token/password, device tokens, node pairing, paired-node reapproval,
  device bootstrap tokens, and watchOS challenge issuance.

While locked out, connection attempts fail with:

```json
{
  "code": "INVALID_REQUEST",
  "message": "unauthorized: too many failed authentication attempts (retry later)",
  "retryable": true,
  "retryAfterMs": 297000,
  "details": {
    "code": "AUTH_RATE_LIMITED",
    "authReason": "rate_limited",
    "recommendedNextStep": "wait_then_retry"
  }
}
```

Attempts from other resolved IPs (including direct loopback) are unaffected
during a lockout.

Tune it under `gateway.auth.rateLimit` in `openclaw.json`:

```json
{
  "gateway": {
    "auth": {
      "rateLimit": {
        "maxAttempts": 10,
        "windowMs": 60000,
        "lockoutMs": 300000,
        "exemptLoopback": true
      }
    }
  }
}
```

Repeated `AUTH_RATE_LIMITED` entries in the Gateway log mean someone is
guessing credentials; see the [exposure runbook](/gateway/security/exposure-runbook).

### Browser-origin connections

WebSocket connections that carry a browser `Origin` header use the same
limits but with the loopback exemption **always off** — a malicious page in
a local browser is still an untrusted client, so localhost gets no free pass
on that path. When such a connection arrives _from_ a loopback address, its
failures are keyed by the normalized page origin (for example
`browser-origin:https://evil.example`) rather than the shared loopback IP,
so each origin gets its own bucket; from non-loopback addresses the key
stays the client IP. This is not configurable.

### Unconfigured same-host reverse proxies

When a request arrives from a loopback socket with forwarding headers but the
proxy is not configured in `gateway.trustedProxies`, OpenClaw cannot safely
attribute the request to the claimed forwarded IP. Gateway-authenticated routes
reject the request before credentials or fallback auth are checked. HTTP
requests receive `403` with error type `proxy_attribution_required`; WebSocket
auth returns the same reason with configuration guidance. Registered
plugin-authenticated webhook routes may handle the request through their own
signature or credential policy, but they ignore forwarded client claims and use
the non-exempt socket source for pre-auth limits.

Configure the proxy address narrowly in `gateway.trustedProxies` and have the
proxy overwrite or safely rebuild forwarding headers. OpenClaw then restores
validated per-client attribution and rate-limit buckets. See [Trusted Proxy
Auth](/gateway/trusted-proxy-auth) and the [Gateway security
guide](/gateway/security#reverse-proxy-configuration).

A headerless TCP forwarder provides no request-level provenance and is
indistinguishable from a process connecting directly over loopback. This
hardening does not classify that transport as a proxy. Do not use a same-host
TCP forwarder as a remote-access security boundary; use managed Tailscale, SSH,
or an HTTP reverse proxy configured as described above.

OpenClaw-managed Tailscale Serve and Funnel use a separate private loopback
listener. Reaching that listener establishes the managed ingress path, and
Tailscale's rewritten source address selects a normal non-exempt, resettable
per-client bucket. Serve tokenless identity auth additionally requires a
matching WhoIs result; Funnel requires its marker and password authentication.

An externally preserved Funnel route that still targets the ordinary Gateway
listener cannot establish this request provenance. OpenClaw leaves that route
unchanged and logs migration guidance. Plugin-authenticated webhook routes
remain available under the rule above; Gateway-authenticated routes reject the
unattributable ingress. Use `gateway.tailscale.mode: "funnel"` so OpenClaw can
point the full Gateway route at its dedicated ingress.

### Webhooks

The HTTP `/hooks` ingress has its own failure limiter: 20 failed
authentications per 60 seconds per client IP, then a 60 second lockout.
Loopback is not exempt. Successful hook auth resets the counter. Throttled
requests receive plain HTTP `429 Too Many Requests` with a `Retry-After`
header (seconds). Limits are fixed; if a legitimate integration trips this,
fix its credentials rather than retrying harder.

## Control-plane writes (post-auth backstop)

Write-side admin RPCs (`config.apply`, `config.patch`, `plugins.install`,
`plugins.setEnabled`, `plugins.uninstall`, `update.run`, `worktrees.*`,
`gateway.restart.request`, ...) are additionally rate-limited **after**
authorization: 30 requests per 60 seconds, per method, per
`deviceId+clientIp`.

This is not a security boundary — callers already hold `operator.admin` — it
is a backstop that bounds runaway client or agent loops hammering expensive
operations. Interactive use never hits it; each method has its own bucket, so
toggling a plugin does not consume the budget of config writes.

When exceeded, the request fails with a retryable error:

```json
{
  "code": "UNAVAILABLE",
  "message": "rate limit exceeded for config.patch; retry after 35s",
  "retryable": true,
  "retryAfterMs": 34539,
  "details": { "method": "config.patch", "limit": "30 per 60s" }
}
```

Clients should honor `retryAfterMs`. The limit is fixed (not configurable);
buckets expire on their own and are pruned by Gateway maintenance.

## ACP session creation

The ACP translator caps session creation at 120 new sessions per 10 second
window per translator instance. Exceeding it fails the request with an error
whose message carries the wait time (there is no structured `retryAfterMs`
field on this path):

```
ACP session creation rate limit exceeded for <method>; retry after <n>s.
```

This bounds runaway clients that create sessions in a loop; normal IDE and
agent use stays far below it.

## Restart cooldown

Gateway restart requests coalesce, then enforce a 30 second cooldown between
restart cycles. A restart requested during the cooldown is scheduled after it
expires rather than rejected. This is separate from the control-plane limiter
above: `gateway.restart.request` consumes a control-plane budget slot _and_
the resulting restart obeys the cooldown.

## Operational notes

- All limiters are in-memory and per-process, and multiple Gateways do not
  share state. Replacing the Gateway process clears the Gateway-owned
  counters (auth lockouts, webhook throttle, control-plane buckets). The
  restart cooldown deliberately survives in-process restart cycles — that is
  what it throttles — and resets only with the process. The ACP session cap
  belongs to its translator instance and resets when that instance is
  recreated, not on Gateway restart.
- Bucket maps are bounded (hard entry caps plus periodic pruning), so
  unique-key floods cannot grow memory without bound.
- When a client is behind a reverse proxy, the effective IP is the resolved
  client IP. An unconfigured loopback proxy is rejected until its address and
  header-rebuilding behavior are trusted explicitly. See [trusted proxy
  auth](/gateway/trusted-proxy-auth) for how proxy headers are validated before
  they can influence attribution.
- Retry signaling varies by surface: Gateway RPC limiters return
  `retryable: true` plus `retryAfterMs`, the webhook ingress uses HTTP 429
  with a `Retry-After` header, and ACP embeds the wait in the error message.
  In every case, back off for the indicated duration instead of retrying
  immediately.
