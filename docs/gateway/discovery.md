---
summary: "Node discovery and transports (Bonjour, Tailscale, SSH) for finding the gateway"
read_when:
  - Implementing or changing Bonjour discovery/advertising
  - Adjusting remote connection modes (direct vs SSH)
  - Designing node discovery + pairing for remote nodes
title: "Discovery and transports"
---

# Discovery & transports

OpenClaw has two distinct problems that look similar on the surface:

1. **Operator remote control**: the macOS menu bar app controlling a gateway running elsewhere.
2. **Node pairing**: iOS/Android (and future nodes) finding a gateway and pairing securely.

The design goal is to keep all network discovery/advertising in the **Node Gateway** (`openclaw gateway`) and keep clients (mac app, iOS) as consumers.

## Terms

- **Gateway**: a single long-running gateway process that owns state (sessions, pairing, node registry) and runs channels. Most setups use one per host; isolated multi-gateway setups are possible.
- **Gateway WS (control plane)**: the WebSocket endpoint on `127.0.0.1:18789` by default; can be bound to LAN/tailnet via `gateway.bind`.
- **Direct WS transport**: a LAN/tailnet-facing Gateway WS endpoint (no SSH).
- **SSH transport (fallback)**: remote control by forwarding `127.0.0.1:18789` over SSH.
- **Legacy TCP bridge (removed)**: older node transport (see
  [Bridge protocol](/gateway/bridge-protocol)); no longer advertised for
  discovery and no longer part of current builds.

Protocol details:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (legacy)](/gateway/bridge-protocol)

## Why we keep both "direct" and SSH

- **Direct WS** is the best UX on the same network and within a tailnet:
  - auto-discovery on LAN via Bonjour
  - pairing tokens + ACLs owned by the gateway
  - no shell access required; protocol surface can stay tight and auditable
- **SSH** remains the universal fallback:
  - works anywhere you have SSH access (even across unrelated networks)
  - survives multicast/mDNS issues
  - requires no new inbound ports besides SSH

## Discovery inputs (how clients learn where the gateway is)

### 1) Bonjour / DNS-SD discovery

Multicast Bonjour is best-effort and does not cross networks. OpenClaw can also browse the
same gateway beacon via a configured wide-area DNS-SD domain, so discovery can cover:

- `local.` on the same LAN
- a configured unicast DNS-SD domain for cross-network discovery

Target direction:

- The **gateway** advertises its WS endpoint via Bonjour.
- Clients browse and show a “pick a gateway” list, then store the chosen endpoint.

Troubleshooting and beacon details: [Bonjour](/gateway/bonjour).

#### Service beacon details

- Service types:
  - `_openclaw-gw._tcp` (gateway transport beacon)
- TXT keys (non-secret):
  - `role=gateway`
  - `transport=gateway`
  - `displayName=<friendly name>` (operator-configured display name)
  - `lanHost=<hostname>.local`
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (only when TLS is enabled)
  - `gatewayTlsSha256=<sha256>` (only when TLS is enabled and fingerprint is available)
  - `canvasPort=<port>` (canvas host port; currently the same as `gatewayPort` when the canvas host is enabled)
  - `tailnetDns=<magicdns>` (optional hint; auto-detected when Tailscale is available)
  - `sshPort=<port>` (mDNS full mode only; wide-area DNS-SD may omit it, in which case SSH defaults stay at `22`)
  - `cliPath=<path>` (mDNS full mode only; wide-area DNS-SD still writes it as a remote-install hint)

Security notes:

- Bonjour/mDNS TXT records are **unauthenticated**. Clients must treat TXT values as UX hints only.
- Routing (host/port) should prefer the **resolved service endpoint** (SRV + A/AAAA) over TXT-provided `lanHost`, `tailnetDns`, or `gatewayPort`.
- TLS pinning must never allow an advertised `gatewayTlsSha256` to override a previously stored pin.
- iOS/Android nodes should require an explicit “trust this fingerprint” confirmation before storing a first-time pin (out-of-band verification) whenever the chosen route is secure/TLS-based.

Disable/override:

- `OPENCLAW_DISABLE_BONJOUR=1` disables advertising.
- `gateway.bind` in `~/.openclaw/openclaw.json` controls the Gateway bind mode.
- `OPENCLAW_SSH_PORT` overrides the SSH port advertised when `sshPort` is emitted.
- `OPENCLAW_TAILNET_DNS` publishes a `tailnetDns` hint (MagicDNS).
- `OPENCLAW_CLI_PATH` overrides the advertised CLI path.

### 2) Tailnet (cross-network)

For London/Vienna style setups, Bonjour won’t help. The recommended “direct” target is:

- Tailscale MagicDNS name (preferred) or a stable tailnet IP.

If the gateway can detect it is running under Tailscale, it publishes `tailnetDns` as an optional hint for clients (including wide-area beacons).

The macOS app now prefers MagicDNS names over raw Tailscale IPs for gateway discovery. This improves reliability when tailnet IPs change (for example after node restarts or CGNAT reassignment), because MagicDNS names resolve to the current IP automatically.

For mobile node pairing, discovery hints do not relax transport security on tailnet/public routes:

- iOS/Android still require a secure first-time tailnet/public connect path (`wss://` or Tailscale Serve/Funnel).
- A discovered raw tailnet IP is a routing hint, not permission to use plaintext remote `ws://`.
- Private LAN direct-connect `ws://` remains supported.
- If you want the simplest Tailscale path for mobile nodes, use Tailscale Serve so discovery and the setup code both resolve to the same secure MagicDNS endpoint.

### 3) Manual / SSH target

When there is no direct route (or direct is disabled), clients can always connect via SSH by forwarding the loopback gateway port.

See [Remote access](/gateway/remote).

## Transport selection (client policy)

Recommended client behavior:

1. If a paired direct endpoint is configured and reachable, use it.
2. Else, if discovery finds a gateway on `local.` or the configured wide-area domain, offer a one-tap “Use this gateway” choice and save it as the direct endpoint.
3. Else, if a tailnet DNS/IP is configured, try direct.
   For mobile nodes on tailnet/public routes, direct means a secure endpoint, not plaintext remote `ws://`.
4. Else, fall back to SSH.

## Pairing + auth (direct transport)

The gateway is the source of truth for node/client admission.

- Pairing requests are created/approved/rejected in the gateway (see [Gateway pairing](/gateway/pairing)).
- The gateway enforces:
  - auth (token / keypair)
  - scopes/ACLs (the gateway is not a raw proxy to every method)
  - rate limits

## Responsibilities by component

- **Gateway**: advertises discovery beacons, owns pairing decisions, and hosts the WS endpoint.
- **macOS app**: helps you pick a gateway, shows pairing prompts, and uses SSH only as a fallback.
- **iOS/Android nodes**: browse Bonjour as a convenience and connect to the paired Gateway WS.

## Related

- [Remote access](/gateway/remote)
- [Tailscale](/gateway/tailscale)
- [Bonjour discovery](/gateway/bonjour)
