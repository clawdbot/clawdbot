---
summary: "Socket Mode, HTTP Request URLs, and relay mode compared"
read_when:
  - Choosing between Socket Mode, HTTP Request URLs, and relay mode
  - Running several Gateway replicas behind a load balancer
  - Tuning Socket Mode reconnect behavior
title: "Slack transports"
sidebarTitle: "Transports"
---

Which Slack transport fits your deployment shape, and how Socket Mode behaves at runtime.

## Choosing a transport

Socket Mode and HTTP Request URLs reach feature parity for messaging, slash commands, App Home, and interactivity. Pick by deployment shape, not features.

| Concern                      | Socket Mode (default)                                                                                                                                  | HTTP Request URLs                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Public Gateway URL           | Not required                                                                                                                                           | Required (DNS, TLS, reverse proxy or tunnel)                                                                   |
| Outbound network             | Outbound WSS to `wss-primary.slack.com` must be reachable                                                                                              | No outbound WS; inbound HTTPS only                                                                             |
| Tokens needed                | Bot identity: bot token + App-Level Token with `connections:write`; user identity: user token + App-Level Token                                        | Bot identity: bot token + Signing Secret; user identity: user token + Signing Secret                           |
| Dev laptop / behind firewall | Works as-is                                                                                                                                            | Needs a public tunnel (ngrok, Cloudflare Tunnel, Tailscale Funnel) or staging Gateway                          |
| Horizontal scaling           | One Socket Mode session per app per host; multiple Gateways need separate Slack apps                                                                   | Stateless POST handler; multiple Gateway replicas can share one app behind a load balancer                     |
| Multi-account on one Gateway | Supported; each account opens its own WS                                                                                                               | Supported; each account needs a unique `webhookPath` (default `/slack/events`) so registrations do not collide |
| Slash command transport      | Delivered over the WS connection; `slash_commands[].url` is ignored                                                                                    | Slack POSTs to `slash_commands[].url`; field is required for the command to dispatch                           |
| Request signing              | Not used (auth is the App-Level Token)                                                                                                                 | Slack signs every request; OpenClaw verifies with `signingSecret`                                              |
| Recovery on connection drop  | Slack SDK auto-reconnect is enabled; OpenClaw also restarts failed Socket Mode sessions with bounded backoff. A fixed 15s client pong timeout applies. | No persistent connection to drop; retries are per-request from Slack                                           |

<Note>
  **Pick Socket Mode** for single-Gateway hosts, dev laptops, and on-prem networks that can reach `*.slack.com` outbound but cannot accept inbound HTTPS.

**Pick HTTP Request URLs** when running multiple Gateway replicas behind a load balancer, when outbound WSS is blocked but inbound HTTPS is allowed, or when you already terminate Slack webhooks at a reverse proxy.
</Note>

<Warning>
  Slack can maintain multiple Socket Mode connections for one app and may deliver each payload to any connection. Separate OpenClaw gateways that share a Slack app therefore need equivalent routing and authorization configuration. Otherwise, use a separate Slack app per gateway, a single relay ingress, or HTTP Request URLs behind a load balancer. See [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode#using-multiple-connections).
</Warning>

### Relay mode

Relay mode separates Slack ingress from the OpenClaw gateway. A trusted router owns the single Slack Socket Mode connection, chooses a destination gateway, and forwards a typed event over an authenticated websocket. The gateway still uses its own bot token for outbound Slack Web API calls.

```json5
{
  channels: {
    slack: {
      mode: "relay",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      relay: {
        url: "wss://router.example.com/gateway/ws",
        authToken: { source: "env", provider: "default", id: "SLACK_RELAY_AUTH_TOKEN" },
        gatewayId: "team-gateway",
      },
    },
  },
}
```

The relay URL must use `wss://` unless it targets localhost. Treat the bearer token and router route table as part of the Slack authorization boundary: routed events enter the normal Slack message handler as authorized activations. A router-provided `slack_identity` in the websocket `hello` frame can set the default outbound username and icon; an explicit identity supplied by the caller still wins. The relay connection reconnects with the same bounded backoff timing as Socket Mode and clears the router-provided identity whenever it disconnects.

## Socket Mode transport tuning

OpenClaw sets the Slack SDK client pong timeout to 15 seconds for Socket Mode. This is a fixed internal default and is not operator-configurable.

Notes:

- The `channels.slack.socketMode` object, including `clientPingTimeout`, `serverPingTimeout`, and `pingPongLoggingEnabled`, is retired and is no longer read at runtime. `openclaw doctor` flags retired layout tuning knobs with a general notice rather than a per-key path. `openclaw doctor --fix` removes those three fields wherever they appear, at the channel root and under `accounts.<accountId>`, and drops the `socketMode` object once it is empty. Any other key you added inside it is left alone, so delete it by hand.
- App messages and events remain application state, not transport liveness signals.
- Socket Mode restart backoff starts around 2 seconds and caps around 30 seconds. Recoverable start, start-wait, and disconnect failures retry until the channel stops. Permanent account and credential errors such as invalid auth, revoked tokens, or missing scopes fail fast instead of retrying forever.
