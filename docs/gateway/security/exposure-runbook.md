---
summary: "Pre-flight and rollback checklist before exposing an OpenClaw Gateway beyond loopback"
title: "Gateway exposure runbook"
sidebarTitle: "Exposure runbook"
read_when:
  - Exposing the Gateway over LAN, tailnet, Tailscale Serve, Funnel, or a reverse proxy
  - Reviewing a deployment before allowing real messaging users
  - Rolling back a risky remote access or DM configuration
---

<Warning>
Expose the Gateway only after you can explain who can reach it, how they are
authenticated, which agents they can trigger, and which tools those agents can
use. When in doubt, return to loopback-only access and re-run the audit.
</Warning>

This runbook turns the broader [Security](/gateway/security) guidance into an
operator checklist for remote access and messaging exposure.

## Choose the exposure pattern

Prefer the narrowest pattern that satisfies the workflow.

| Pattern                    | Recommended when                                | Required controls                                                                                                               |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Loopback + SSH tunnel      | Personal use, admin access, debugging           | Keep `gateway.bind: "loopback"` and tunnel `127.0.0.1:18789`                                                                    |
| Loopback + Tailscale Serve | Personal tailnet access to Control UI/WebSocket | Keep Gateway loopback-only; Tailscale identity headers only authenticate the Control UI WebSocket surface, not other auth paths |
| Tailnet/LAN bind           | Dedicated private network with known devices    | Gateway auth, firewall allowlist, no public port-forward                                                                        |
| Trusted reverse proxy      | Organization SSO/OIDC in front of Gateway       | `trusted-proxy` auth, strict `trustedProxies`, header overwrite/strip rules, explicit allowed users                             |
| Public internet            | Rare, high-risk deployments                     | Identity-aware proxy, TLS, rate limits, strict allowlists, sandboxed non-main sessions                                          |

Avoid direct public port-forwarding to the Gateway. If public access is
required, put an identity-aware proxy in front of it and make the proxy the
only network path to the Gateway.

## Pre-flight inventory

Record these before changing bind, proxy, Tailscale, or channel policy:

- Gateway host, OS user, and state directory (default `~/.openclaw`).
- Gateway URL and bind mode (`gateway.bind`; default port `18789`).
- Auth mode, token/password source, or trusted proxy identity source.
- Every enabled channel and whether it accepts DMs, groups, or webhooks.
- Agents reachable from non-local senders.
- Tool profile, sandbox mode, and elevated tool policy for each reachable agent.
- External credentials available to those agents.
- Backup location for `~/.openclaw/openclaw.json` and credentials.

If more than one person can message the bot, treat this as shared delegated
tool authority, not per-user host isolation.

## Baseline checks

Run before opening access:

```bash
openclaw doctor
openclaw security audit
openclaw security audit --deep
openclaw health
```

Resolve critical findings first. Accept warnings only when intentional and
documented for the deployment. See [Security audit checks](/gateway/security/audit-checks)
for what each `checkId` means and its fix key.

For remote CLI validation, pass credentials explicitly:

```bash
openclaw gateway probe --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

Do not assume local config credentials apply to an explicit remote URL.

## Minimum safe baseline

Use this shape as the starting point for exposed deployments:

```json5
{
  gateway: {
    bind: "loopback",
    auth: {
      mode: "token",
      token: "replace-with-a-long-random-token",
    },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  agents: {
    defaults: {
      sandbox: { mode: "non-main" },
    },
  },
  tools: {
    profile: "messaging",
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
}
```

Widen one control at a time: add a specific channel allowlist before enabling
write-capable tools, or enable a reverse proxy before accepting remote Control
UI traffic.

`tools.exec.security: "deny"` blocks all exec calls, including benign
diagnostics. If diagnostics or low-risk commands are required, relax this only
after choosing the specific senders, agents, commands, and approval mode that
match your threat model.

## DM and group exposure

Messaging channels are untrusted input surfaces. Before allowing DMs or
groups:

- Prefer `dmPolicy: "pairing"` or a strict `allowFrom` list over `dmPolicy: "open"`.
- Do not combine `"*"` allowlists with broad tool access.
- Require mentions in groups unless the room is tightly controlled.
- Set `session.dmScope: "per-channel-peer"` (or `"per-account-channel-peer"` for
  multi-account channels) when multiple people can DM the bot, so DM sessions
  don't share context.
- Route shared channels to agents with minimal tools and no personal
  credentials.

Pairing approves the sender to trigger the bot. It does not make that sender a
separate host security boundary.

## Reverse proxy checks

For identity-aware proxies:

- The proxy must authenticate users before forwarding to the Gateway.
- Firewall or network policy must block direct access to the Gateway port.
- `gateway.trustedProxies` must list only the proxy source IPs.
- The proxy must strip or overwrite client-supplied identity and forwarding
  headers.
- Set `gateway.auth.trustedProxy.allowUsers` when the proxy serves more than
  one audience.
- Use `gateway.auth.trustedProxy.allowLoopback` only for a same-host proxy
  where local processes are trusted and the proxy owns the identity headers.

Run `openclaw security audit --deep` after proxy changes. Trusted-proxy
findings are high-signal because the proxy becomes the authentication
boundary.

## Tool and sandbox review

Before exposing an agent to remote senders:

- Confirm which sessions run on host versus sandbox.
- Deny or require approval for host exec.
- Keep elevated tools disabled unless a specific, trusted sender needs them.
- Avoid browser, canvas, node, cron, gateway, and session-spawn tools for open
  or semi-open messaging surfaces.
- Keep bind mounts narrow; avoid credential, home, Docker socket, and system
  paths.
- Use separate gateways, OS users, or hosts for materially different trust
  boundaries.

If remote users are not fully trusted, isolation must come from separate
deployments, not only from prompts or session labels.

## Post-change validation

After each exposure change:

1. Re-run `openclaw security audit --deep`.
2. Confirm a successful authorized connection succeeds.
3. Confirm an unauthorized sender or browser session is denied.
4. Confirm logs redact secrets.
5. Confirm DM/group routing reaches only the intended agent.
6. Confirm high-impact tools ask for approval or are denied.
7. Document the accepted residual warnings.

Do not proceed to the next exposure change until the current one is
understood.

## Rollback plan

If the Gateway may be overexposed:

```json5
{
  gateway: {
    bind: "loopback",
  },
  channels: {
    whatsapp: { dmPolicy: "disabled" },
    telegram: { dmPolicy: "disabled" },
    discord: { dmPolicy: "disabled" },
    slack: { dmPolicy: "disabled" },
  },
  tools: {
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
}
```

Then:

1. Stop public forwarding, Tailscale Funnel, or reverse proxy routes.
2. Rotate Gateway tokens/passwords and affected integration credentials.
3. Remove `"*"` and unexpected senders from allowlists.
4. Review recent audit logs, run history, tool calls, and config changes.
5. Re-run `openclaw security audit --deep`.
6. Re-enable access with the narrowest pattern that satisfies the workflow.

## Review checklist

- Gateway remains loopback-only unless there is a documented reason.
- Non-loopback access has auth, firewalling, and no public direct route.
- Trusted-proxy deployments have strict proxy IPs and header controls.
- DMs use pairing or allowlists, not open access by default.
- Groups require mentions or explicit allowlists.
- Shared channels do not reach personal credentials.
- Non-main sessions run in sandbox mode.
- Host exec and elevated tools are denied or approval-gated.
- Logs redact secrets.
- Critical audit findings are resolved.
- Rollback steps are tested and documented.
