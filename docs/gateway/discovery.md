---
summary: "Node discovery and transports (Bonjour, Tailscale, SSH) for finding the gateway"
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing bridge + pairing for remote nodes
---
# Discovery & transports

Clawdbot has two distinct problems that look similar on the surface:

1) **Operator remote control**: the macOS menu bar app controlling a gateway running elsewhere.
2) **Node pairing**: iOS/Android (and future nodes) finding a gateway and pairing securely.

The design goal is to keep all network discovery/advertising in the **Node Gateway** (`clawd` / `clawdbot gateway`) and keep clients (mac app, iOS) as consumers.

## Terms

- **Gateway**: the single, long-running gateway process that owns state (sessions, pairing, node registry) and runs channels.
- **Gateway WS (loopback)**: the existing gateway WebSocket control endpoint on `127.0.0.1:18789`.
- **Bridge (direct transport)**: a LAN/tailnet-facing endpoint owned by the gateway that allows authenticated clients/nodes to call a scoped subset of gateway methods. The bridge exists so the gateway can remain loopback-only.
- **SSH transport (fallback)**: remote control by forwarding `127.0.0.1:18789` over SSH.

Protocol details:
- [Gateway protocol](/gateway/protocol)
- [Bridge protocol](/gateway/bridge-protocol)

## Why we keep both “direct” and SSH

- **Direct bridge** is the best UX on the same network and within a tailnet:
  - auto-discovery on LAN via Bonjour
  - pairing tokens + ACLs owned by the gateway
  - no shell access required; protocol surface can stay tight and auditable
- **SSH** remains the universal fallback:
  - works anywhere you have SSH access (even across unrelated networks)
  - survives multicast/mDNS issues
  - requires no new inbound ports besides SSH

## Discovery inputs (how clients learn where the gateway is)

### 1) Bonjour / mDNS (LAN only)

Bonjour is best-effort and does not cross networks. It is only used for “same LAN” convenience.

Target direction:
- The **gateway** advertises its bridge via Bonjour.
- Clients browse and show a “pick a gateway” list, then store the chosen endpoint.

Troubleshooting and beacon details: [Bonjour](/gateway/bonjour).

#### Service beacon details

- Service types:
  - `_clawdbot-bridge._tcp` (bridge transport beacon)
- TXT keys (non-secret):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (or whatever is advertised)
  - `gatewayPort=18789` (loopback WS port; informational)
  - `bridgePort=18790` (when bridge is enabled)
  - `canvasPort=18793` (default canvas host port; serves `/__clawdbot__/canvas/`)
  - `cliPath=<path>` (optional; absolute path to a runnable `clawdbot` entrypoint or binary)
  - `tailnetDns=<magicdns>` (optional hint; auto-detected when Tailscale is available)

Disable/override:
- `CLAWDBOT_DISABLE_BONJOUR=1` disables advertising.
- `CLAWDBOT_BRIDGE_ENABLED=0` disables the bridge listener.
- `bridge.bind` / `bridge.port` in `~/.clawdbot/clawdbot.json` control bridge bind/port (preferred).
- `CLAWDBOT_BRIDGE_HOST` / `CLAWDBOT_BRIDGE_PORT` still work as a back-compat override when `bridge.bind` / `bridge.port` are not set.
- `CLAWDBOT_SSH_PORT` overrides the SSH port advertised in the bridge beacon (defaults to 22).
- `CLAWDBOT_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS) in the bridge beacon (auto-detected if unset).

### 2) Tailnet (cross-network)

For London/Vienna style setups, Bonjour won’t help. The recommended “direct” target is:
- Tailscale MagicDNS name (preferred) or a stable tailnet IP.

If the gateway can detect it is running under Tailscale, it publishes `tailnetDns` as an optional hint for clients (including wide-area beacons).

### 3) Manual / SSH target

When there is no direct route (or direct is disabled), clients can always connect via SSH by forwarding the loopback gateway port.

See [Remote access](/gateway/remote).

## Transport selection (client policy)

Recommended client behavior:

1) If a paired direct endpoint is configured and reachable, use it.
2) Else, if Bonjour finds a gateway on LAN, offer a one-tap “Use this gateway” choice and save it as the direct endpoint.
3) Else, if a tailnet DNS/IP is configured, try direct.
4) Else, fall back to SSH.

## Pairing + auth (direct transport)

The gateway is the source of truth for node/client admission.

- Pairing requests are created/approved/rejected in the gateway (see [Gateway pairing](/gateway/pairing)).
- The bridge enforces:
  - auth (token / keypair)
  - scopes/ACLs (bridge is not a raw proxy to every gateway method)
  - rate limits

## Responsibilities by component

- **Gateway**: advertises discovery beacons, owns pairing decisions, runs the bridge listener.
- **macOS app**: helps you pick a gateway, shows pairing prompts, and uses SSH only as a fallback.
- **iOS/Android nodes**: browse Bonjour as a convenience and connect via the paired bridge.
