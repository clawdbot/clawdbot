---
title: "Trusted Proxy Auth"
summary: "Delegate gateway authentication to a trusted reverse proxy (Pomerium, Caddy, nginx + OAuth)"
read_when:
  - Running OpenClaw behind an identity-aware proxy
  - Setting up Pomerium, Caddy, or nginx with OAuth in front of OpenClaw
  - Fixing WebSocket 1008 unauthorized errors with reverse proxy setups
  - Deciding where to set HSTS and other HTTP hardening headers
---

# Trusted Proxy Auth

> ⚠️ **Security-sensitive feature.** This mode delegates authentication entirely to your reverse proxy. Misconfiguration can expose your Gateway to unauthorized access. Read this page carefully before enabling.

## When to Use

Use `trusted-proxy` auth mode when:

- You run OpenClaw behind an **identity-aware proxy** (Pomerium, Caddy + OAuth, nginx + oauth2-proxy, Traefik + forward auth)
- Your proxy handles all authentication and passes user identity via headers
- You're in a Kubernetes or container environment where the proxy is the only path to the Gateway
- You're hitting WebSocket `1008 unauthorized` errors because browsers can't pass tokens in WS payloads

## When NOT to Use

- If your proxy doesn't authenticate users (just a TLS terminator or load balancer)
- If there's any path to the Gateway that bypasses the proxy (firewall holes, internal network access)
- If you're unsure whether your proxy correctly strips/overwrites forwarded headers
- If you only need personal single-user access (consider Tailscale Serve + loopback for simpler setup)

## How It Works

1. Your reverse proxy authenticates users (OAuth, OIDC, SAML, etc.)
2. Proxy adds a header with the authenticated user identity (e.g., `x-forwarded-user: nick@example.com`)
3. OpenClaw checks that the request came from a **trusted proxy IP** (configured in `gateway.trustedProxies`)
4. OpenClaw extracts the user identity from the configured header
5. If everything checks out, the request is authorized

## Control UI Pairing Behavior

When `gateway.auth.mode = "trusted-proxy"` is active and the request passes
trusted-proxy checks, Control UI WebSocket sessions can connect without device
pairing identity.

Implications:

- Pairing is no longer the primary gate for Control UI access in this mode.
- Your reverse proxy auth policy and `allowUsers` become the effective access control.
- Keep gateway ingress locked to trusted proxy IPs only (`gateway.trustedProxies` + firewall).

## Configuration

```json5
{
  gateway: {
    // Trusted-proxy auth expects requests from a non-loopback trusted proxy source
    bind: "lan",

    // CRITICAL: Only add your proxy's IP(s) here
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        // Header containing authenticated user identity (required)
        userHeader: "x-forwarded-user",

        // Optional: headers that MUST be present (proxy verification)
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // Optional: restrict to specific users (empty = allow all)
        allowUsers: ["nick@example.com", "admin@company.org"],
      },
    },
  },
}
```

Important runtime rule:

- Trusted-proxy auth rejects loopback-source requests (`127.0.0.1`, `::1`, loopback CIDRs).
- Same-host loopback reverse proxies do **not** satisfy trusted-proxy auth.
- For same-host loopback proxy setups, use token/password auth instead, or route through a non-loopback trusted proxy address that OpenClaw can verify.
- Non-loopback Control UI deployments still need explicit `gateway.controlUi.allowedOrigins`.
- **Forwarded-header evidence overrides loopback locality.** If a request arrives on loopback but carries `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` headers pointing at a non-local origin, that evidence disqualifies the loopback locality claim. The request is treated as remote for pairing, trusted-proxy auth, and Control UI device-identity gating. This prevents a same-host loopback proxy from laundering forwarded-header identity into trusted-proxy auth.

### Configuration Reference

| Field                                       | Required | Description                                                                 |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `gateway.trustedProxies`                    | Yes      | Array of proxy IP addresses to trust. Requests from other IPs are rejected. |
| `gateway.auth.mode`                         | Yes      | Must be `"trusted-proxy"`                                                   |
| `gateway.auth.trustedProxy.userHeader`      | Yes      | Header name containing the authenticated user identity                      |
| `gateway.auth.trustedProxy.requiredHeaders` | No       | Additional headers that must be present for the request to be trusted       |
| `gateway.auth.trustedProxy.allowUsers`      | No       | Allowlist of user identities. Empty means allow all authenticated users.    |

## TLS termination and HSTS

Use one TLS termination point and apply HSTS there.

### Recommended pattern: proxy TLS termination

When your reverse proxy handles HTTPS for `https://control.example.com`, set
`Strict-Transport-Security` at the proxy for that domain.

- Good fit for internet-facing deployments.
- Keeps certificate + HTTP hardening policy in one place.
- OpenClaw can stay on loopback HTTP behind the proxy.

Example header value:

```text
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Gateway TLS termination

If OpenClaw itself serves HTTPS directly (no TLS-terminating proxy), set:

```json5
{
  gateway: {
    tls: { enabled: true },
    http: {
      securityHeaders: {
        strictTransportSecurity: "max-age=31536000; includeSubDomains",
      },
    },
  },
}
```

`strictTransportSecurity` accepts a string header value, or `false` to disable explicitly.

### Rollout guidance

- Start with a short max age first (for example `max-age=300`) while validating traffic.
- Increase to long-lived values (for example `max-age=31536000`) only after confidence is high.
- Add `includeSubDomains` only if every subdomain is HTTPS-ready.
- Use preload only if you intentionally meet preload requirements for your full domain set.
- Loopback-only local development does not benefit from HSTS.

## Proxy Setup Examples

### Pomerium

Pomerium passes identity in `x-pomerium-claim-email` (or other claim headers) and a JWT in `x-pomerium-jwt-assertion`.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // Pomerium's IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-pomerium-claim-email",
        requiredHeaders: ["x-pomerium-jwt-assertion"],
      },
    },
  },
}
```

Pomerium config snippet:

```yaml
routes:
  - from: https://openclaw.example.com
    to: http://openclaw-gateway:18789
    policy:
      - allow:
          or:
            - email:
                is: nick@example.com
    pass_identity_headers: true
```

### Caddy with OAuth

Caddy with the `caddy-security` plugin can authenticate users and pass identity headers.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // Caddy/sidecar proxy IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

Caddyfile snippet:

```
openclaw.example.com {
    authenticate with oauth2_provider
    authorize with policy1

    reverse_proxy openclaw:18789 {
        header_up X-Forwarded-User {http.auth.user.email}
    }
}
```

### nginx + oauth2-proxy

oauth2-proxy authenticates users and passes identity in `x-auth-request-email`.

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["10.0.0.1"], // nginx/oauth2-proxy IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-auth-request-email",
      },
    },
  },
}
```

nginx config snippet:

```nginx
location / {
    auth_request /oauth2/auth;
    auth_request_set $user $upstream_http_x_auth_request_email;

    proxy_pass http://openclaw:18789;
    proxy_set_header X-Auth-Request-Email $user;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

### Traefik with Forward Auth

```json5
{
  gateway: {
    bind: "lan",
    trustedProxies: ["172.17.0.1"], // Traefik container IP
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

## Mixed token configuration

OpenClaw rejects ambiguous configurations where both a `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`) and `trusted-proxy` mode are active at the same time. Mixed token configs can cause loopback requests to silently authenticate on the wrong auth path.

If you see a `mixed_trusted_proxy_token` error on startup:

- Remove the shared token when using trusted-proxy mode, or
- Switch `gateway.auth.mode` to `"token"` if you intend token-based auth.

Loopback trusted-proxy auth also fails closed: same-host callers must supply the configured identity headers through a trusted proxy instead of being silently authenticated.

## Operator scopes header

Trusted-proxy auth is an **identity-bearing** HTTP mode, so callers may
optionally declare operator scopes with `x-openclaw-scopes`.

Examples:

- `x-openclaw-scopes: operator.read`
- `x-openclaw-scopes: operator.read,operator.write`
- `x-openclaw-scopes: operator.admin,operator.write`

Behavior:

- When the header is present, OpenClaw honors the declared scope set.
- When the header is present but empty, the request declares **no** operator scopes.
- When the header is absent, normal identity-bearing HTTP APIs fall back to the standard operator default scope set.
- Gateway-auth **plugin HTTP routes** are narrower by default: when `x-openclaw-scopes` is absent, their runtime scope falls back to `operator.write`.
- Browser-origin HTTP requests still have to pass `gateway.controlUi.allowedOrigins` (or deliberate Host-header fallback mode) even after trusted-proxy auth succeeds.

Practical rule:

- Send `x-openclaw-scopes` explicitly when you want a trusted-proxy request to
  be narrower than the defaults, or when a gateway-auth plugin route needs
  something stronger than write scope.

## Security Checklist

Before enabling trusted-proxy auth, verify:

- [ ] **Proxy is the only path**: The Gateway port is firewalled from everything except your proxy
- [ ] **trustedProxies is minimal**: Only your actual proxy IPs, not entire subnets
- [ ] **No loopback proxy source**: trusted-proxy auth fails closed for loopback-source requests
- [ ] **Proxy strips headers**: Your proxy overwrites (not appends) `x-forwarded-*` headers from clients
- [ ] **TLS termination**: Your proxy handles TLS; users connect via HTTPS
- [ ] **allowedOrigins is explicit**: Non-loopback Control UI uses explicit `gateway.controlUi.allowedOrigins`
- [ ] **allowUsers is set** (recommended): Restrict to known users rather than allowing anyone authenticated
- [ ] **No mixed token config**: Do not set both `gateway.auth.token` and `gateway.auth.mode: "trusted-proxy"`

## Security Audit

`openclaw security audit` will flag trusted-proxy auth with a **critical** severity finding. This is intentional — it's a reminder that you're delegating security to your proxy setup.

The audit checks for:

- Base `gateway.trusted_proxy_auth` warning/critical reminder
- Missing `trustedProxies` configuration
- Missing `userHeader` configuration
- Empty `allowUsers` (allows any authenticated user)
- Wildcard or missing browser-origin policy on exposed Control UI surfaces

## Troubleshooting

### "trusted_proxy_untrusted_source"

The request didn't come from an IP in `gateway.trustedProxies`. Check:

- Is the proxy IP correct? (Docker container IPs can change)
- Is there a load balancer in front of your proxy?
- Use `docker inspect` or `kubectl get pods -o wide` to find actual IPs

### "trusted_proxy_loopback_source"

OpenClaw rejected a loopback-source trusted-proxy request.

Check:

- Is the proxy connecting from `127.0.0.1` / `::1`?
- Are you trying to use trusted-proxy auth with a same-host loopback reverse proxy?

Fix:

- Use token/password auth for same-host loopback proxy setups, or
- Route through a non-loopback trusted proxy address and keep that IP in `gateway.trustedProxies`.

### "trusted_proxy_user_missing"

The user header was empty or missing. Check:

- Is your proxy configured to pass identity headers?
- Is the header name correct? (case-insensitive, but spelling matters)
- Is the user actually authenticated at the proxy?

### "trusted*proxy_missing_header*\*"

A required header wasn't present. Check:

- Your proxy configuration for those specific headers
- Whether headers are being stripped somewhere in the chain

### "trusted_proxy_user_not_allowed"

The user is authenticated but not in `allowUsers`. Either add them or remove the allowlist.

### "trusted_proxy_origin_not_allowed"

Trusted-proxy auth succeeded, but the browser `Origin` header did not pass Control UI origin checks.

Check:

- `gateway.controlUi.allowedOrigins` includes the exact browser origin
- You are not relying on wildcard origins unless you intentionally want allow-all behavior
- If you intentionally use Host-header fallback mode, `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` is set deliberately

### WebSocket Still Failing

Make sure your proxy:

- Supports WebSocket upgrades (`Upgrade: websocket`, `Connection: upgrade`)
- Passes the identity headers on WebSocket upgrade requests (not just HTTP)
- Doesn't have a separate auth path for WebSocket connections

## Migration from Token Auth

If you're moving from token auth to trusted-proxy:

1. Configure your proxy to authenticate users and pass headers
2. Test the proxy setup independently (curl with headers)
3. Update OpenClaw config with trusted-proxy auth
4. Restart the Gateway
5. Test WebSocket connections from the Control UI
6. Run `openclaw security audit` and review findings

## Related

- [Security](/gateway/security) — full security guide
- [Configuration](/gateway/configuration) — config reference
- [Remote Access](/gateway/remote) — other remote access patterns
- [Tailscale](/gateway/tailscale) — simpler alternative for tailnet-only access
