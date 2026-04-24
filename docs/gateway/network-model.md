---
summary: "How the Gateway, nodes, and canvas host connect."
read_when:
  - You want a concise view of the Gateway networking model
title: "Network model"
---

> This content has been merged into [Network](/network#core-model). See that page for the current guide.

Most operations flow through the Gateway (`openclaw gateway`), a single long-running
process that owns channel connections and the WebSocket control plane.

## Core rules

- One Gateway per host is recommended. It is the only process allowed to own the WhatsApp Web session. For rescue bots or strict isolation, run multiple gateways with isolated profiles and ports. See [Multiple gateways](/gateway/multiple-gateways).
- Loopback first: the Gateway WS defaults to `ws://127.0.0.1:18789`. The wizard creates shared-secret auth by default and usually generates a token, even for loopback. For non-loopback access, use a valid gateway auth path: shared-secret token/password auth, or a correctly configured non-loopback `trusted-proxy` deployment. Tailnet/mobile setups usually work best through Tailscale Serve or another `wss://` endpoint instead of raw tailnet `ws://`.
- Nodes connect to the Gateway WS over LAN, tailnet, or SSH as needed. The
  legacy TCP bridge has been removed.
- Canvas host is served by the Gateway HTTP server on the **same port** as the Gateway (default `18789`):
  - `/__openclaw__/canvas/`
  - `/__openclaw__/a2ui/`
    When `gateway.auth` is configured and the Gateway binds beyond loopback, these routes are protected by Gateway auth. Node clients use node-scoped capability URLs tied to their active WS session. See [Gateway configuration](/gateway/configuration) (`canvasHost`, `gateway`).
- Remote use is typically SSH tunnel or tailnet VPN. See [Remote access](/gateway/remote) and [Discovery](/gateway/discovery).

## Related

- [Remote access](/gateway/remote)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
- [Gateway protocol](/gateway/protocol)
