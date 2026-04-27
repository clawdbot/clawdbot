---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
title: "Bonjour discovery"
---

# Bonjour / mDNS discovery

OpenClaw uses Bonjour (mDNS / DNS‑SD) to discover an active Gateway (WebSocket endpoint).
Multicast `local.` browsing is a **LAN-only convenience**. The bundled `bonjour`
plugin owns LAN advertising and is enabled by default. For cross-network discovery,
the same beacon can also be published through a configured wide-area DNS-SD domain.
Discovery is still best-effort and does **not** replace SSH or Tailnet-based connectivity.

## Wide-area Bonjour (Unicast DNS-SD) over Tailscale

If the node and gateway are on different networks, multicast mDNS won’t cross the
boundary. You can keep the same discovery UX by switching to **unicast DNS‑SD**
("Wide‑Area Bonjour") over Tailscale.

High‑level steps:

1. Run a DNS server on the gateway host (reachable over Tailnet).
2. Publish DNS‑SD records for `_openclaw-gw._tcp` under a dedicated zone
   (example: `openclaw.internal.`).
3. Configure Tailscale **split DNS** so your chosen domain resolves via that
   DNS server for clients (including iOS).

OpenClaw supports any discovery domain; `openclaw.internal.` is just an example.
iOS/Android nodes browse both `local.` and your configured wide‑area domain.

### Gateway config (recommended)

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } }, // enables wide-area DNS-SD publishing
}
```

### One-time DNS server setup (gateway host)

```bash
openclaw dns setup --apply
```

This installs CoreDNS and configures it to:

- listen on port 53 only on the gateway’s Tailscale interfaces
- serve your chosen domain (example: `openclaw.internal.`) from `~/.openclaw/dns/<domain>.db`

Validate from a tailnet‑connected machine:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway’s tailnet IP (UDP/TCP 53).
- Add split DNS so your discovery domain uses that nameserver.

Once clients accept tailnet DNS, iOS nodes and CLI discovery can browse
`_openclaw-gw._tcp` in your discovery domain without multicast.

### Gateway listener security (recommended)

The Gateway WS port (default `18789`) binds to loopback by default. For LAN/tailnet
access, bind explicitly and keep auth enabled.

For tailnet‑only setups:

- Set `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json`.
- Restart the Gateway (or restart the macOS menubar app).

## What advertises

Only the Gateway advertises `_openclaw-gw._tcp`. LAN multicast advertising is
provided by the bundled `bonjour` plugin; wide-area DNS-SD publishing remains
Gateway-owned.

## Service types

- `_openclaw-gw._tcp` — gateway transport beacon (used by macOS/iOS/Android nodes).

## TXT keys (non-secret hints)

The Gateway advertises small non‑secret hints to make UI flows convenient:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (Gateway WS + HTTP)
- `gatewayTls=1` (only when TLS is enabled)
- `gatewayTlsSha256=<sha256>` (only when TLS is enabled and fingerprint is available)
- `canvasPort=<port>` (only when the canvas host is enabled; currently the same as `gatewayPort`)
- `transport=gateway`
- `tailnetDns=<magicdns>` (mDNS full mode only, optional hint when Tailnet is available)
- `sshPort=<port>` (mDNS full mode only; wide-area DNS-SD may omit it)
- `cliPath=<path>` (mDNS full mode only; wide-area DNS-SD still writes it as a remote-install hint)

Security notes:

- Bonjour/mDNS TXT records are **unauthenticated**. Clients must not treat TXT as authoritative routing.
- Clients should route using the resolved service endpoint (SRV + A/AAAA). Treat `lanHost`, `tailnetDns`, `gatewayPort`, and `gatewayTlsSha256` as hints only.
- SSH auto-targeting should likewise use the resolved service host, not TXT-only hints.
- TLS pinning must never allow an advertised `gatewayTlsSha256` to override a previously stored pin.
- iOS/Android nodes should treat discovery-based direct connects as **TLS-only** and require explicit user confirmation before trusting a first-time fingerprint.

## Debugging on macOS

Useful built‑in tools:

- Browse instances:

  ```bash
  dns-sd -B _openclaw-gw._tcp local.
  ```

- Resolve one instance (replace `<instance>`):

  ```bash
  dns-sd -L "<instance>" _openclaw-gw._tcp local.
  ```

If browsing works but resolving fails, you’re usually hitting a LAN policy or
mDNS resolver issue.

## Debugging in Gateway logs

The Gateway writes a rolling log file (printed on startup as
`gateway log file: ...`). Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`
- `bonjour: disabling advertiser after ... failed restarts ...`

## Debugging on iOS node

The iOS node uses `NWBrowser` to discover `_openclaw-gw._tcp`.

To capture logs:

- Settings → Gateway → Advanced → **Discovery Debug Logs**
- Settings → Gateway → Advanced → **Discovery Logs** → reproduce → **Copy**

The log includes browser state transitions and result‑set changes.

## When to disable Bonjour

Disable Bonjour only when LAN multicast advertising is unavailable or harmful.
The common case is a Gateway running behind Docker bridge networking, WSL, or a
network policy that drops mDNS multicast. In those environments the Gateway is
still reachable through its published URL, SSH, Tailnet, or wide-area DNS-SD,
but LAN auto-discovery is not reliable.

Prefer the existing environment override when the problem is deployment-scoped:

```bash
OPENCLAW_DISABLE_BONJOUR=1
```

That disables LAN multicast advertising without changing plugin configuration.
It is safe for Docker images, service files, launch scripts, and one-off
debugging because the setting disappears when the environment does.

Use plugin configuration only when you intentionally want to turn off the
bundled LAN discovery plugin for that OpenClaw config:

```bash
openclaw plugins disable bonjour
```

## Docker gotchas

The bundled Bonjour plugin auto-disables LAN multicast advertising in detected
containers when `OPENCLAW_DISABLE_BONJOUR` is unset. Docker bridge networks
usually do not forward mDNS multicast (`224.0.0.251:5353`) between the container
and the LAN, so advertising from the container rarely makes discovery work.

Important gotchas:

- Disabling Bonjour does not stop the Gateway. It only stops LAN multicast
  advertising.
- Disabling Bonjour does not change `gateway.bind`; Docker still defaults to
  `OPENCLAW_GATEWAY_BIND=lan` so the published host port can work.
- Disabling Bonjour does not disable wide-area DNS-SD. Use wide-area discovery
  or Tailnet when the Gateway and node are not on the same LAN.
- Reusing the same `OPENCLAW_CONFIG_DIR` outside Docker does not persist the
  container auto-disable policy.
- Set `OPENCLAW_DISABLE_BONJOUR=0` only for host networking, macvlan, or another
  network where mDNS multicast is known to pass; set it to `1` to force-disable.

## Troubleshooting disabled Bonjour

If a node no longer auto-discovers the Gateway after Docker setup:

1. Confirm whether the Gateway is running in auto, forced-on, or forced-off mode:

   ```bash
   docker compose config | grep OPENCLAW_DISABLE_BONJOUR
   ```

2. Confirm the Gateway itself is reachable through the published port:

   ```bash
   curl -fsS http://127.0.0.1:18789/healthz
   ```

3. Use a direct target when Bonjour is disabled:
   - Control UI or local tools: `http://127.0.0.1:18789`
   - LAN clients: `http://<gateway-host>:18789`
   - Cross-network clients: Tailnet MagicDNS, Tailnet IP, SSH tunnel, or
     wide-area DNS-SD

4. If you deliberately enabled Bonjour in Docker with
   `OPENCLAW_DISABLE_BONJOUR=0`, test multicast from the host:

   ```bash
   dns-sd -B _openclaw-gw._tcp local.
   ```

   If browsing is empty or the Gateway logs show repeated ciao watchdog
   cancellations, restore `OPENCLAW_DISABLE_BONJOUR=1` and use a direct or
   Tailnet route.

## Common failure modes

- **Bonjour doesn’t cross networks**: use Tailnet or SSH.
- **Multicast blocked**: some Wi‑Fi networks disable mDNS.
- **Advertiser stuck in probing/announcing**: hosts with blocked multicast,
  container bridges, WSL, or interface churn can leave the ciao advertiser in a
  non-announced state. OpenClaw retries a few times and then disables Bonjour
  for the current Gateway process instead of restarting the advertiser forever.
- **Docker bridge networking**: Bonjour auto-disables in detected containers.
  Set `OPENCLAW_DISABLE_BONJOUR=0` only for host, macvlan, or another
  mDNS-capable network.
- **Sleep / interface churn**: macOS may temporarily drop mDNS results; retry.
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or
  punctuation), then restart the Gateway. The service instance name derives from
  the host name, so overly complex names can confuse some resolvers.

## Escaped instance names (`\032`)

Bonjour/DNS‑SD often escapes bytes in service instance names as decimal `\DDD`
sequences (e.g. spaces become `\032`).

- This is normal at the protocol level.
- UIs should decode for display (iOS uses `BonjourEscapes.decode`).

## Disabling / configuration

- `openclaw plugins disable bonjour` disables LAN multicast advertising by disabling the bundled plugin.
- `openclaw plugins enable bonjour` restores the default LAN discovery plugin.
- `OPENCLAW_DISABLE_BONJOUR=1` disables LAN multicast advertising without changing plugin config; accepted truthy values are `1`, `true`, `yes`, and `on` (legacy: `OPENCLAW_DISABLE_BONJOUR`).
- `OPENCLAW_DISABLE_BONJOUR=0` forces LAN multicast advertising on, including inside detected containers; accepted falsy values are `0`, `false`, `no`, and `off`.
- When `OPENCLAW_DISABLE_BONJOUR` is unset, Bonjour advertises on normal hosts and auto-disables inside detected containers.
- `gateway.bind` in `~/.openclaw/openclaw.json` controls the Gateway bind mode.
- `OPENCLAW_SSH_PORT` overrides the SSH port when `sshPort` is advertised (legacy: `OPENCLAW_SSH_PORT`).
- `OPENCLAW_TAILNET_DNS` publishes a MagicDNS hint in TXT when mDNS full mode is enabled (legacy: `OPENCLAW_TAILNET_DNS`).
- `OPENCLAW_CLI_PATH` overrides the advertised CLI path (legacy: `OPENCLAW_CLI_PATH`).

## Related docs

- Discovery policy and transport selection: [Discovery](/gateway/discovery)
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)
