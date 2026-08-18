---
summary: "Publish a loopback Gateway through a Cloudflare Tunnel and authenticate every client with Cloudflare Access"
read_when:
  - You want a public HTTPS Gateway URL without opening a port
  - You want Cloudflare Access (SSO) to authenticate the Control UI
  - Your CLI, TUI, or nodes get HTTP 302 from a Cloudflare-fronted Gateway
title: "Cloudflare Tunnel and Access"
---

Run the Gateway on loopback, publish it through a Cloudflare Tunnel, and let Cloudflare
Access authenticate every request before it reaches OpenClaw. The Gateway keeps
`gateway.bind: "loopback"`, so no port is exposed and no inbound firewall rule is
needed; `cloudflared` dials out from the host.

This is one supported remote-access topology alongside [Tailscale](/gateway/tailscale)
and an [SSH tunnel](/gateway/remote#ssh-tunnel-cli--tools). Choose it when you want a
stable public HTTPS URL and identity-provider SSO in front of the Control UI.

## Before you begin

- A Cloudflare account with the zone for your hostname, and Cloudflare Zero Trust enabled.
- `cloudflared` installed on the Gateway host, and on any machine that will use the CLI.
- A running Gateway on `127.0.0.1:18789` with `gateway.bind: "loopback"`.
- Familiarity with [trusted-proxy auth](/gateway/trusted-proxy-auth), which this topology uses.

## How the pieces fit

```text
browser / CLI / node  ->  Cloudflare Access (identity)  ->  Tunnel  ->  127.0.0.1:18789
```

Access authenticates the request and injects identity headers. The Gateway does not
re-authenticate the person or verify the Access JWT signature; it checks the trusted
proxy source and configured header presence, then trusts the user header. Because
`allowLoopback` also lets other local processes present those headers, keep the Gateway
port private to the host and run only trusted workloads there.

## Step 1: Route the tunnel to loopback

Add an ingress rule mapping your hostname to the Gateway port, then run `cloudflared`
as a service on the Gateway host:

```yaml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: gateway.example
    service: http://localhost:18789
  - service: http_status:404
```

See Cloudflare's own documentation for creating the tunnel and DNS record.

## Step 2: Protect the hostname with Access

Create an Access application for `gateway.example` with a policy that allows your
users. Note the two headers Access adds to authenticated requests, because the Gateway
consumes them in the next step:

- `cf-access-authenticated-user-email` — the authenticated identity.
- `cf-access-jwt-assertion` — Access's signed assertion. OpenClaw checks only that this
  header is present and non-blank; it does not verify the JWT signature.

## Step 3: Trust those headers in the Gateway

Set `gateway.auth.mode` to `trusted-proxy` and name the Access headers. `allowLoopback`
is required here: `cloudflared` connects from `127.0.0.1`, and trusted-proxy auth
otherwise expects a non-loopback proxy.

```json5
{
  gateway: {
    bind: "loopback",
    trustedProxies: ["127.0.0.1", "::1"],
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
        allowLoopback: true,
      },
    },
  },
}
```

Requiring `cf-access-jwt-assertion` adds a second presence check, not cryptographic
verification. A local process that can connect to the Gateway can submit both headers,
so do not treat this setting as a defense against untrusted local code. The security
boundary is the locked-down loopback port plus Cloudflare Access and the tunnel being
the only path for external traffic.

## Step 4: Decide how nodes and workers get in

Access protects every route on the hostname, including the ones nodes use. Pick one:

- **Exempt the self-authenticating routes.** Allow `/j/*` and `/__openclaw__/worker`
  without Access identity, and keep WebSocket upgrade enabled on the worker route. Both
  enforce their own short-lived credentials, so they do not depend on Access. See
  [Nodes](/nodes#edge-routing).
- **Use an Access service token.** Add a Service Auth policy and give the node
  `gateway.cloudflareAccess.clientId` / `clientSecret`. See [Node CLI](/cli/node).

If you do neither, `openclaw connect` fails against the tunnel even though the browser
works, because the join request is redirected to the Access login page.

## Step 5: Connect each client

**Control UI.** Open `https://gateway.example` and sign in through Access. With
trusted-proxy auth the Gateway maps your Access identity to an operator session.

**CLI and TUI.** These do not carry browser cookies, so they present an Access token on
the WebSocket upgrade. Configure `gateway.remote.edgeAuth` as described in
[Remote access](/gateway/remote#gateway-behind-an-identity-aware-proxy), then run
`cloudflared access login https://gateway.example` once to cache a token.

**Nodes.** Follow the choice made in step 4.

## Verify

```bash
openclaw tui
```

Expect the TUI to reach `wss://gateway.example` and show `connected`. A first
connection may report `device pairing required`; approve it in the Control UI under
Settings → Devices, or run `openclaw devices approve --latest` on the Gateway host.

Reaching the Gateway's own pairing prompt is itself the proof that Access was
satisfied — an unauthenticated request never gets that far.

## Production readiness

- Keep `gateway.bind: "loopback"`. Binding wider re-exposes the Gateway beside the
  tunnel and bypasses Access entirely.
- Keep `trustedProxies` limited to loopback. It is the list of addresses whose identity
  headers the Gateway will believe.
- `trustedProxy.deviceAutoApprove` can pair devices automatically for
  Access-authenticated identities. It removes a manual approval step; enable it only
  when you accept that anyone who passes Access gets a paired device with the scopes you
  list.
- Access tokens expire on the application's session duration. Expect CLI users to re-run
  `cloudflared access login` when their token lapses.

## Troubleshooting

| Symptom                                                             | Cause and fix                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway rejected websocket upgrade (HTTP 302)` from the CLI or TUI | Access intercepted the upgrade. Configure `gateway.remote.edgeAuth`; see [Remote access](/gateway/remote#gateway-behind-an-identity-aware-proxy). |
| Browser works, `openclaw connect` fails                             | Node routes are still behind Access. Apply one of the options in step 4.                                                                          |
| `Exec provider ... exited with code 1`                              | The exec secret provider runs with a scrubbed environment; `cloudflared` needs `passEnv: ["HOME"]` to read its cached token.                      |
| `secrets.providers.*.command must not be a symlink`                 | Point `command` at the resolved binary, not a package-manager symlink.                                                                            |
| Gateway starts but every request is anonymous                       | `allowLoopback` is unset, so headers from the local `cloudflared` are ignored.                                                                    |

## Related

- [Remote access](/gateway/remote)
- [Trusted-proxy auth](/gateway/trusted-proxy-auth)
- [Nodes](/nodes)
- [Tailscale](/gateway/tailscale)
- [Authentication](/gateway/authentication)
