---
summary: "Delegate gateway authentication to a trusted reverse proxy (Pomerium, Caddy, nginx + OAuth)"
title: "Trusted proxy auth"
sidebarTitle: "Trusted proxy auth"
read_when:
  - Running OpenClaw behind an identity-aware proxy
  - Setting up Pomerium, Caddy, or nginx with OAuth in front of OpenClaw
  - Fixing WebSocket 1008 unauthorized errors with reverse proxy setups
  - Deciding where to set HSTS and other HTTP hardening headers
---

<Warning>
**Security-sensitive feature.** This mode delegates authentication entirely to your reverse proxy. Misconfiguration can expose your Gateway to unauthorized access. Read this page carefully before enabling.
</Warning>

## When to use

- You run OpenClaw behind an **identity-aware proxy** (Pomerium, Caddy + OAuth, nginx + oauth2-proxy, Traefik + forward auth).
- Your proxy handles all authentication and passes user identity via headers.
- You're in a Kubernetes or container environment where the proxy is the only path to the Gateway.
- You're hitting WebSocket `1008 unauthorized` errors because browsers can't pass tokens in WS payloads.

## When NOT to use

- Your proxy doesn't authenticate users (just a TLS terminator or load balancer).
- There's any path to the Gateway that bypasses the proxy (firewall holes, internal network access).
- You're unsure whether your proxy correctly strips/overwrites forwarded headers.
- You only need personal single-user access (consider Tailscale Serve + loopback instead).

## How it works

<Steps>
  <Step title="Proxy authenticates the user">
    Your reverse proxy authenticates users (OAuth, OIDC, SAML, etc.).
  </Step>
  <Step title="Proxy adds an identity header">
    Proxy adds a header with the authenticated user identity (e.g., `x-forwarded-user: nick@example.com`).
  </Step>
  <Step title="Gateway verifies trusted source">
    OpenClaw checks that the request came from a **trusted proxy IP** (`gateway.trustedProxies`). Loopback sources require explicit `allowLoopback` consent; other Gateway-local interface addresses are rejected.
  </Step>
  <Step title="Gateway extracts identity">
    OpenClaw reads the required headers, then the user identity from the configured header.
  </Step>
  <Step title="Authorize">
    If everything checks out, and the user passes `allowUsers` (when set), the request is authorized.
  </Step>
</Steps>

## Configuration

<Note>
The `deviceAutoApprove` examples below target beta/current-main builds. Stable `v2026.7.1` does not support this option.
</Note>

```json5
{
  gateway: {
    // Trusted-proxy auth expects the proxy's source IP to be non-loopback by default
    bind: "lan",

    // CRITICAL: Only add your proxy's IP(s) here
    trustedProxies: ["10.0.0.1", "172.17.0.1"],

    auth: {
      mode: "trusted-proxy",
      identityScopes: {
        "admin@company.org": ["operator.admin"],
      },
      trustedProxy: {
        // Header containing authenticated user identity (required)
        userHeader: "x-forwarded-user",

        // Optional: headers that MUST be present (proxy verification)
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],

        // Optional: restrict to specific users (empty = allow all)
        allowUsers: ["nick@example.com", "admin@company.org"],

        // Optional: allow a same-host loopback proxy after explicit opt-in
        allowLoopback: false,

        // Optional: let authenticated proxy users enroll UI devices and upgrade scopes
        deviceAutoApprove: {
          enabled: false,
          scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
        },
      },
    },
  },
}
```

<Warning>
**Runtime rules, in order of evaluation**

1. Proxy-shaped traffic is attributed before Gateway auth. The request's source IP must match `gateway.trustedProxies` (CIDR-aware), and its client-address headers must resolve to a non-loopback client. Otherwise Gateway-authenticated routes reject it with `proxy_attribution_required` before identity headers are accepted. Plugin-authenticated webhook routes may still handle the request, but they ignore the untrusted forwarded address and use the socket source for their own limits.
2. The proxy must overwrite `X-Forwarded-For` with a safe chain. If `gateway.allowRealIpFallback = true`, an overwritten `X-Real-IP` is also accepted when `X-Forwarded-For` is absent. Do not enable that fallback unless the proxy removes client-supplied `X-Real-IP`.
3. Loopback-source requests (`127.0.0.1`, `::1`) are rejected unless `gateway.auth.trustedProxy.allowLoopback = true` and the loopback address is also in `trustedProxies` (`trusted_proxy_loopback_source`). This check runs before header checks, so a loopback source fails this way even if required headers are also missing.
4. Non-loopback sources that match one of the Gateway host's own local network interface addresses are rejected as a spoofing guard (`trusted_proxy_local_interface_source`). If interface discovery itself fails, the request is rejected too (`trusted_proxy_local_interface_check_failed`).
5. `requiredHeaders` and `userHeader` must be present and non-blank.
6. `allowUsers`, if non-empty, must include the extracted user.

**Forwarded-header evidence overrides loopback locality for local-direct fallback.** If a request arrives on loopback but carries a `Forwarded`, any `X-Forwarded-*`, or `X-Real-IP` header, that evidence disqualifies it from local-direct password fallback and device-identity gating, even though it still fails trusted-proxy auth as loopback.

`allowLoopback` trusts local processes on the Gateway host to the same degree as the reverse proxy. Enable it only when the Gateway is still firewalled from direct remote access and the local proxy strips or overwrites client-supplied identity headers.

Internal Gateway clients that do not travel through the reverse proxy should use `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`, not trusted-proxy identity headers. `openclaw gateway status` selects this local password automatically when no `--url` override is supplied, including with `--json`. Non-loopback Control UI deployments still need explicit `gateway.controlUi.allowedOrigins`.
</Warning>

### Configuration reference

<ParamField path="gateway.trustedProxies" type="string[]" required>
  Array of proxy IP addresses (or CIDRs) to trust. Requests from other IPs are rejected.
  IPv4 ranges may be written plainly (`10.0.0.0/8`) or in IPv4-mapped IPv6 form (`::ffff:10.0.0.0/104`); the two are equivalent, and both match a peer connecting as `10.1.2.3` or as `::ffff:10.1.2.3`. A mapped prefix counts the 96 leading mapped bits, so `::ffff:0:0/96` denotes all of IPv4 — including loopback, which still requires `gateway.auth.trustedProxy.allowLoopback`. Native IPv6 peers never match a mapped range.
</ParamField>
<ParamField path="gateway.auth.mode" type="string" required>
  Must be `"trusted-proxy"`.
</ParamField>
<ParamField path="gateway.auth.identityScopes" type="record<string, string[]>">
  Connection-only operator scopes granted to verified trusted-proxy or Tailscale identities. Email keys match case-insensitively; unknown scope names fail config validation.
</ParamField>
<ParamField path="gateway.auth.trustedProxy.userHeader" type="string" required>
  Header name containing the authenticated user identity.
</ParamField>
<ParamField path="gateway.auth.trustedProxy.requiredHeaders" type="string[]">
  Additional headers that must be present for the request to be trusted.
</ParamField>
<ParamField path="gateway.auth.trustedProxy.allowUsers" type="string[]">
  Allowlist of user identities. Empty means allow all authenticated users.
</ParamField>
<ParamField path="gateway.auth.trustedProxy.allowLoopback" type="boolean" default="false">
  Opt-in support for same-host loopback reverse proxies.
</ParamField>
<ParamField path="gateway.auth.trustedProxy.deviceAutoApprove.enabled" type="boolean" default="false">
  Automatically approve new browser and native UI operator devices and same-key scope upgrades after trusted-proxy authentication.
</ParamField>
<ParamField path="gateway.auth.trustedProxy.deviceAutoApprove.scopes" type="string[]" default='["operator.read", "operator.write", "operator.approvals", "operator.questions"]'>
  Maximum scopes granted to an auto-approved operator device. Explicitly listing `operator.admin` lets every proxy-authenticated user request an automatic full-admin device grant, makes scope-less requests receive full admin automatically, and triggers the CRITICAL `gateway.trusted_proxy_device_auto_approve_admin` security audit finding plus a Gateway startup warning.
</ParamField>

<Warning>
Any local process that can connect to the Gateway can impersonate a loopback reverse proxy by sending identity headers. Only enable `allowLoopback` when the reverse proxy is the sole local listener for incoming user traffic, direct Gateway access is locked down, and you trust local processes. The proxy must authenticate users and strip or overwrite client-supplied identity headers; required headers alone do not distinguish the proxy from another local process.
</Warning>

### Configure with the wizard

Run `openclaw configure --section gateway` and select **Trusted Proxy**. Entering an address or CIDR that matches a loopback source under the Gateway's runtime rules shows the security warning above and asks whether to allow loopback authentication. This includes ranges containing loopback, even when their base address is not loopback. The default is **No** for a new configuration. **Yes** saves `gateway.auth.trustedProxy.allowLoopback: true`; **No** leaves it unset and warns that loopback proxy requests will fail with `trusted_proxy_loopback_source`, with a link back to this page.

When reconfiguring an existing trusted-proxy setup, the prompt defaults to the existing `allowLoopback` opt-in. Choosing **No** revokes it. If no entered address or range matches a loopback source, the wizard leaves the existing value unchanged. Same-mode reconfiguration also preserves `deviceAutoApprove` verbatim; device enrollment policy is not changed by this prompt. Switching from another auth mode does not restore dormant trusted-proxy opt-ins.

## Per-identity scope grants

Use `gateway.auth.identityScopes` to give selected verified users additional
operator scopes without widening their persistent device grant:

```json5
{
  gateway: {
    auth: {
      mode: "trusted-proxy",
      identityScopes: {
        "admin@example.com": ["operator.admin"],
        "operator@example.com": ["operator.read", "operator.write"],
      },
      trustedProxy: {
        userHeader: "x-forwarded-user",
      },
    },
  },
}
```

The map key is the verified trusted-proxy identity or Tailscale WhoIs login.
Email matching is case-insensitive; non-email identities match exactly. On each
connection, OpenClaw adds the matching identity scopes to the device-authorized
scopes, then applies an explicit `x-openclaw-scopes` connection cap.

These grants are session-only. They do not create or update device pairing
records and do not trigger device scope-upgrade requests. Token, password, and
no-auth connections do not carry a verified identity and never receive a grant.

## Automatic device approval

Trusted-proxy auth can optionally use the proxy identity as the approval boundary for new browser and native UI operator devices and same-key scope upgrades:

```json5
{
  gateway: {
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        allowUsers: ["operator@example.com"],
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
        },
      },
    },
  },
}
```

The default is `enabled: false`. When enabled, all of these rules apply:

1. The WebSocket must have authenticated through the `trusted-proxy` method with a non-empty user identity that passed `allowUsers` when an allowlist is configured. Token, password, Tailscale, and unauthenticated connections never use this policy.
2. New browser operator devices (including Control UI and WebChat), native macOS, Linux, iOS, and Android clients in UI mode, and scope upgrades from an existing device with the same paired public key resolve automatically. Native clients must supply a signed device identity and authenticate through the proxy on each connection. Node-role connections, role upgrades, and changes to pinned platform or device-family metadata are not eligible for this auto-approval policy. If the existing grant already covers the automatically approvable scopes, the session narrows to that grant without a pairing request or audit entry; otherwise, `deviceAutoApprove.scopes` can automatically approve the widened intersection. A connection claiming an existing device ID with a different public key is rejected before a pairing request is created.
3. The device is approved with role `operator`. With an explicit `deviceAutoApprove.scopes` list, requested scopes are intersected with that list; a request that omits scopes receives the list. When the list is unset, it defaults to `operator.read`, `operator.write`, `operator.approvals`, and `operator.questions`. During auto-approval with this default list, OpenClaw also adds `operator.questions` even if an older UI client does not request it. An explicit scope list is never widened. The resulting grant is then additionally capped by the connection's [`x-openclaw-scopes`](#control-ui-pairing-behavior) proxy header when present, so a proxy that narrows a user's scopes also limits the **persistent** device grant, not just the session — a present-but-empty header yields no scopes. This cap applies even when the client omits its own scope list.
4. `operator.admin` is allowed only through explicit listing in `deviceAutoApprove.scopes`. When listed, every proxy-authenticated user can request and automatically receive full admin on a new operator device; requests without scopes receive full admin automatically. `openclaw security audit` reports the CRITICAL `gateway.trusted_proxy_device_auto_approve_admin` finding, and the Gateway logs a warning once at startup. Prefer a targeted [`identityScopes`](#per-identity-scope-grants) admin grant when selected verified users need session admin without a persistent admin device grant.

<Warning>
Enabling this option delegates new browser and native UI operator device enrollment entirely to the reverse-proxy identity. A compromised proxy account can enroll a persistent device with every configured scope. Listing `operator.admin` makes that device a full administrator without manual approval. Keep the Gateway reachable only through the proxy, require strong proxy authentication, overwrite identity headers, and use a narrow `allowUsers` list.
</Warning>

## Control UI pairing behavior

Browsers attach a device identity on every origin, including plain HTTP, so first connects follow the standard pairing flow: automatic approval when [`deviceAutoApprove`](#automatic-device-approval) is enabled, otherwise a one-time approval on the Gateway host. When `gateway.auth.mode = "trusted-proxy"` is active and the request passes trusted-proxy checks, only Control UI sessions from browsers that cannot supply a device identity at all are admitted device-less.

Scope implications:

- Device-less Control UI WebSocket sessions cannot self-declare permissions. OpenClaw clears their requested scope list to `[]`, then applies any matching server-side `identityScopes` grant after proxy identity verification.
- If methods fail with `missing scope` after a successful WebSocket connect, reload so the browser pairs its device identity, or approve the pending device request. See [Control UI insecure HTTP](/web/control-ui/connect-and-pair#insecure-http).

Reverse-proxy scope capping: if your proxy sends `x-openclaw-scopes` on the Control UI WebSocket upgrade request, OpenClaw caps device enrollment or upgrade requests and the final union of device-authorized and identity-granted session scopes. This header does not grant scopes; it only narrows authority. When `deviceAutoApprove.enabled` is true, the cap also limits the persistent device grant written by [automatic device approval](#automatic-device-approval).

Implications:

- Pairing is no longer the primary gate for device-less Control UI access. A matching `identityScopes` entry can authorize that session without creating a pairing record. When `deviceAutoApprove.enabled` is true, the proxy identity also becomes the approval gate for new browser and native UI operator device enrollment.
- Your reverse proxy auth policy and `allowUsers` become the effective access control.
- Keep gateway ingress locked to trusted proxy IPs only (`gateway.trustedProxies` + firewall).

Custom WebSocket clients are not Control UI sessions. The retired Control UI
upgrade input does not grant temporary access to arbitrary
`client.mode: "backend"` or CLI-shaped clients. Custom automation should use
device identity/pairing, the reserved direct-local `client.id: "gateway-client"`
backend helper path, or the [admin HTTP RPC plugin](/plugins/admin-http-rpc)
when an HTTP request/response surface is a better fit.

## Operator scopes header

Trusted-proxy auth is an **identity-bearing** HTTP mode, so callers may optionally declare operator scopes with `x-openclaw-scopes` on HTTP API requests.

Note: WebSocket scopes are determined by the Gateway protocol handshake and device identity binding. On Control UI WebSocket upgrade requests, `x-openclaw-scopes` is only a cap on the negotiated session scopes, not a grant. See [Control UI pairing behavior](#control-ui-pairing-behavior).

Examples:

- `x-openclaw-scopes: operator.read`
- `x-openclaw-scopes: operator.read,operator.write`
- `x-openclaw-scopes: operator.admin,operator.write`

Behavior:

- When the header is present, OpenClaw honors the declared scope set.
- When the header is present but empty, the request declares **no** operator scopes.
- When the header is absent, normal identity-bearing HTTP APIs fall back to the standard operator default scope set (`operator.admin`, `operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`, `operator.talk.secrets`).
- Gateway-auth **plugin HTTP routes** are narrower by default: when `x-openclaw-scopes` is absent, their runtime scope falls back to `operator.write` only.
- Browser-origin HTTP requests still have to pass `gateway.controlUi.allowedOrigins` (or deliberate Host-header fallback mode) even after trusted-proxy auth succeeds.

Practical rule: send `x-openclaw-scopes` explicitly when you want a trusted-proxy request to be narrower than the defaults, or when a gateway-auth plugin route needs something stronger than write scope.

## TLS termination and HSTS

Use one TLS termination point and apply HSTS there.

<Tabs>
  <Tab title="Proxy TLS termination (recommended)">
    When your reverse proxy handles HTTPS for `https://control.example.com`, set `Strict-Transport-Security` at the proxy for that domain.

    - Good fit for internet-facing deployments.
    - Keeps certificate + HTTP hardening policy in one place.
    - OpenClaw can stay on loopback HTTP behind the proxy.

    Example header value:

    ```text
    Strict-Transport-Security: max-age=31536000; includeSubDomains
    ```

  </Tab>
  <Tab title="Gateway TLS termination">
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

  </Tab>
</Tabs>

### Rollout guidance

- Start with a short max age first (for example `max-age=300`) while validating traffic.
- Increase to long-lived values (for example `max-age=31536000`) only after confidence is high.
- Add `includeSubDomains` only if every subdomain is HTTPS-ready.
- Use preload only if you intentionally meet preload requirements for your full domain set.
- Loopback-only local development does not benefit from HSTS.

## Proxy setup examples

Cloudflare Access is covered end to end, including the tunnel and node routes, in
[Cloudflare Tunnel and Access](/gateway/cloudflare-access).

<AccordionGroup>
  <Accordion title="Pomerium">
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

  </Accordion>
  <Accordion title="Caddy with OAuth">
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

    ```caddy
    openclaw.example.com {
        authenticate with oauth2_provider
        authorize with policy1

        reverse_proxy openclaw:18789 {
            header_up X-Forwarded-User {http.auth.user.email}
        }
    }
    ```

  </Accordion>
  <Accordion title="nginx + oauth2-proxy">
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

  </Accordion>
  <Accordion title="Traefik with forward auth">
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
  </Accordion>
</AccordionGroup>

## Mixed token configuration

Gateway startup rejects trusted-proxy auth if a shared token is also configured (`gateway.auth.token` or `OPENCLAW_GATEWAY_TOKEN`). The two are mutually exclusive because a shared token would let same-host callers authenticate on a completely different path than the proxy-verified identity this mode is meant to enforce.

If startup fails with an error like `gateway auth mode is trusted-proxy, but a shared token is also configured`:

- Remove the shared token when using trusted-proxy mode, or
- Switch `gateway.auth.mode` to `"token"` if you intend token-based auth.

Loopback trusted-proxy identity headers still fail closed: same-host callers are not silently authenticated as proxy users. Internal OpenClaw callers that bypass the proxy may authenticate with `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD` instead. Token fallback remains intentionally unsupported in trusted-proxy mode.

## Restrict a separate Gateway to one owner

Use a [separate Gateway cell](/gateway/multi-tenant-hosting) when one owner needs a
different trust boundary. A separate workspace, model picker filter, or Gateway
process under the same OS user does not isolate its credentials and state from
other agents running as that user.

Fleet-managed cells currently use token authentication. This trusted-proxy
procedure requires an independently provisioned cell; do not overwrite Fleet's
managed auth configuration.

The identity-aware proxy must reject every other user **before forwarding any HTTP
request or WebSocket upgrade**. Bind that policy to a verified immutable identity,
such as an issuer-qualified OIDC subject, and overwrite `userHeader` with that
identity. Set `allowUsers` to the same single value as a second check. Gateway
`allowUsers` compares the trimmed header value exactly; it does not verify a JWT,
resolve an account ID, or make an email address immutable. `requiredHeaders` only
checks that headers are present and non-blank.

Keep the Gateway reachable only from that proxy. Do not rely on `allowUsers` alone
to revoke access: valid paired-device or bootstrap credentials have their own
WebSocket authentication paths. Existing connections also require explicit
revocation or disconnection. Enforce the owner restriction at the proxy for all
routes, including plugin routes, and do not create an unprotected node route.

For a proxy-only cell, omit both Gateway token and password configuration and
their environment variables. Keep `allowLoopback: false` when the proxy has a
separate network identity. The provider credential inside the cell authenticates
the workload to its provider; it does not authenticate the human using the
Gateway. The host administrator remains trusted.

## Security checklist

Before enabling trusted-proxy auth, verify:

- [ ] **Proxy is the only path**: The Gateway port is firewalled from everything except your proxy.
- [ ] **trustedProxies is minimal**: Only your actual proxy IPs, not entire subnets.
- [ ] **Loopback proxy source is deliberate**: trusted-proxy auth fails closed for loopback-source requests unless `gateway.auth.trustedProxy.allowLoopback` is explicitly enabled for a same-host proxy.
- [ ] **Proxy strips headers**: Your proxy overwrites (not appends) `x-forwarded-*` headers from clients.
- [ ] **Client IP is attributable**: The proxy always rebuilds `X-Forwarded-For` with the original non-loopback client address.
- [ ] **TLS termination**: Your proxy handles TLS; users connect via HTTPS.
- [ ] **allowedOrigins is explicit**: Non-loopback Control UI uses explicit `gateway.controlUi.allowedOrigins`.
- [ ] **allowUsers is set** (recommended): Restrict to known users rather than allowing anyone authenticated.
- [ ] **No mixed token config**: Do not set both `gateway.auth.token` and `gateway.auth.mode: "trusted-proxy"`.
- [ ] **Local password fallback is private**: If you configure `gateway.auth.password` for internal direct callers, keep the Gateway port firewalled so non-proxy remote clients cannot reach it directly.
- [ ] **Device auto-approval is deliberate**: If `deviceAutoApprove.enabled` is true, treat reverse-proxy account security as the device-enrollment boundary and keep the granted scope list non-admin and minimal.

## Security audit

`openclaw security audit` flags trusted-proxy auth with a **critical** severity finding. This is intentional; it's a reminder that you're delegating security to your proxy setup.

The audit checks for:

- Base `gateway.trusted_proxy_auth` warning/critical reminder.
- Missing `trustedProxies` configuration.
- Missing `userHeader` configuration.
- Empty `allowUsers` (allows any authenticated user).
- Enabled `allowLoopback` for same-host proxy sources.
- Enabled operator device auto-approval (delegates new browser and native UI device pairing to the proxy identity).

Separate, non-trusted-proxy-specific findings also apply whenever Control UI is exposed: wildcard or missing `gateway.controlUi.allowedOrigins`, and Host-header origin fallback.

## Troubleshooting

### Control UI says Proxy authentication required

The Gateway is reachable, but it rejected proxy authentication or forwarded identity. For `AUTH_IDENTITY_HEADER_REQUIRED`, a required proxy header was missing or blank; this is not a network outage.

Open the configured authenticated proxy or SSO dashboard URL and sign in there instead of visiting the Gateway's loopback URL directly. If the error persists, ask the Gateway administrator to verify identity and required-header forwarding on **WebSocket upgrade requests**, and confirm that the signed-in account is permitted.

A Gateway token cannot replace proxy authentication. Do not send identity headers from the browser, broaden `trustedProxies`, or remove `allowUsers` to work around the rejection.

<AccordionGroup>
  <Accordion title="trusted_proxy_untrusted_source">
    The request didn't come from an IP in `gateway.trustedProxies`. Check:

    - Is the proxy IP correct? (Docker container IPs can change.)
    - Is there a load balancer in front of your proxy?
    - Use `docker inspect` or `kubectl get pods -o wide` to find actual IPs.

  </Accordion>
  <Accordion title="trusted_proxy_loopback_source">
    OpenClaw rejected a loopback-source trusted-proxy request.

    Check:

    - Is the proxy connecting from `127.0.0.1` / `::1`?
    - Are you trying to use trusted-proxy auth with a same-host loopback reverse proxy?

    Fix:

    - Use an explicitly configured local password for internal same-host clients that do not go through the proxy; token fallback is not supported in trusted-proxy mode, or
    - Route through a non-loopback trusted proxy address and keep that IP in `gateway.trustedProxies`, or
    - For a deliberate same-host reverse proxy, set `gateway.auth.trustedProxy.allowLoopback = true`, keep the loopback address in `gateway.trustedProxies`, and make sure the proxy strips or overwrites identity headers.

  </Accordion>
  <Accordion title="trusted_proxy_local_interface_source / trusted_proxy_local_interface_check_failed">
    The request's source IP matched one of the Gateway host's own non-loopback network interface addresses (not the proxy), a guard against spoofed same-host traffic on tailnets or Docker bridge networks. `..._check_failed` means interface discovery itself errored, so OpenClaw fails closed.

    Check:

    - Is a process on the Gateway host itself sending identity headers directly, bypassing the proxy?
    - Does the proxy run in the same network namespace as the Gateway, with an IP that also shows up as a local interface?

    Fix: route proxy traffic through an address that is not also bound locally by the Gateway host, or use `allowLoopback` only for a genuine same-host proxy setup.

  </Accordion>
  <Accordion title="trusted_proxy_user_missing">
    The user header was empty or missing. Check:

    - Is your proxy configured to pass identity headers?
    - Is the header name correct? (case-insensitive, but spelling matters)
    - Is the user actually authenticated at the proxy?

  </Accordion>
  <Accordion title="trusted_proxy_missing_header_*">
    A required header wasn't present. Check:

    - Your proxy configuration for those specific headers.
    - Whether headers are being stripped somewhere in the chain.

  </Accordion>
  <Accordion title="trusted_proxy_user_not_allowed">
    The user is authenticated but not in `allowUsers`. Sign in with a permitted account or ask the Gateway administrator to review the intended access policy. Do not remove the allowlist as a connectivity workaround.
  </Accordion>
  <Accordion title="trusted_proxy_no_proxies_configured / trusted_proxy_config_missing">
    `gateway.auth.mode` is `"trusted-proxy"` but `gateway.trustedProxies` is empty, or `gateway.auth.trustedProxy` itself is missing. Every request is rejected until both are set.
  </Accordion>
  <Accordion title="trusted_proxy_origin_not_allowed">
    Trusted-proxy auth succeeded, but the browser `Origin` header did not pass Control UI origin checks.

    Check:

    - `gateway.controlUi.allowedOrigins` includes the exact browser origin.
    - You are not relying on wildcard origins unless you intentionally want allow-all behavior.
    - If you intentionally use Host-header fallback mode, `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` is set deliberately.

  </Accordion>
  <Accordion title="Connection succeeds but methods report missing scope">
    The WebSocket connects, but `chat.history`, `sessions.list`, or
    `models.list` fails with `missing scope: operator.read`.

    Common causes:

    - Device-less Control UI session: OpenClaw clears self-declared scopes by design, and no matching `gateway.auth.identityScopes` grant was configured.
    - Custom backend client: the retired Control UI upgrade input never grants access to arbitrary backend or CLI-shaped WebSocket clients.
    - Overly narrow `x-openclaw-scopes`: if your proxy injects this header on the Control UI WebSocket upgrade request, the session scopes are capped to that set. An empty header value yields no scopes.

    Fix:

    - For Control UI, reload the dashboard so the browser generates device identity and completes pairing (works over HTTP too).
    - For custom automation, use device identity/pairing, the reserved direct-local `gateway-client` backend helper path, or [admin HTTP RPC](/plugins/admin-http-rpc).
    - Do not add the retired `gateway.controlUi.dangerouslyDisableDeviceAuth` key to current config; it is ignored and `openclaw doctor --fix` removes it.

  </Accordion>
  <Accordion title="WebSocket still failing">
    Make sure your proxy:

    - Supports WebSocket upgrades (`Upgrade: websocket`, `Connection: upgrade`).
    - Passes the identity headers on WebSocket upgrade requests (not just HTTP).
    - Doesn't have a separate auth path for WebSocket connections.

  </Accordion>
</AccordionGroup>

## Migration from token auth

<Steps>
  <Step title="Configure the proxy">
    Configure your proxy to authenticate users and pass headers.
  </Step>
  <Step title="Test the proxy independently">
    Test the proxy setup independently (curl with headers).
  </Step>
  <Step title="Update OpenClaw config">
    Update OpenClaw config with trusted-proxy auth.
  </Step>
  <Step title="Restart the Gateway">
    Restart the Gateway.
  </Step>
  <Step title="Test WebSocket">
    Test WebSocket connections from the Control UI.
  </Step>
  <Step title="Audit">
    Run `openclaw security audit` and review findings.
  </Step>
</Steps>

## Related

- [Configuration](/gateway/configuration) — config reference
- [Operator scopes](/gateway/operator-scopes) — roles, scopes, and approval checks
- [Remote access](/gateway/remote) — other remote access patterns
- [Security](/gateway/security) — full security guide
- [Tailscale](/gateway/tailscale) — simpler alternative for tailnet-only access
