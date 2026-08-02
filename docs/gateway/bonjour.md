---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
title: "Bonjour discovery"
---

OpenClaw can use Bonjour (mDNS/DNS-SD) to discover an active gateway (WebSocket endpoint). Multicast `local.` browsing is a **LAN-only convenience**: the bundled `bonjour` plugin owns LAN advertising, auto-starting on macOS hosts and opt-in on Linux, Windows, and containerized gateway deployments. The same beacon can also publish through a configured wide-area DNS-SD domain for cross-network discovery. Discovery is best-effort and does **not** replace SSH or Tailnet-based connectivity.

## Wide-area Bonjour (Unicast DNS-SD) over Tailscale

If the node and gateway are on different networks, multicast mDNS can't cross the boundary. Keep the same discovery UX by switching to **unicast DNS-SD** ("Wide-Area Bonjour") over Tailscale:

1. Run a DNS server on the gateway host, reachable over the Tailnet.
2. Publish DNS-SD records for `_openclaw-gw._tcp` under a dedicated zone (example: `openclaw.internal.`).
3. Configure Tailscale **split DNS** so your chosen domain resolves via that DNS server for clients, including iOS.

`openclaw.internal.` above is just an example — OpenClaw supports any discovery domain. iOS/Android nodes browse both `local.` and your configured wide-area domain.

### Gateway config

```json5
{
  gateway: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true, domain: "openclaw.internal" } },
}
```

`discovery.wideArea.domain` also accepts the `OPENCLAW_WIDE_AREA_DOMAIN` env var as a fallback when unset.

### One-time DNS server setup (gateway host, macOS only)

```bash
openclaw dns setup --apply
```

This command is macOS-only and requires Homebrew and a running Tailscale connection. It installs CoreDNS (`brew install coredns`) and configures it to:

- listen on port 53 only on the gateway's Tailscale interfaces
- serve your chosen domain (example: `openclaw.internal.`) from `~/.openclaw/dns/<domain>.db`

Run without `--apply` first to preview the plan (domain, zone file path, detected Tailnet IP, recommended config) without installing anything.

Validate from a Tailnet-connected machine:

```bash
dns-sd -B _openclaw-gw._tcp openclaw.internal.
dig @<TAILNET_IPV4> -p 53 _openclaw-gw._tcp.openclaw.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway's Tailnet IP (UDP/TCP 53).
- Add split DNS so your discovery domain uses that nameserver.

Once clients accept Tailnet DNS, iOS nodes and CLI discovery can browse `_openclaw-gw._tcp` in your discovery domain without multicast.

### Gateway listener security

The gateway WS port (default `18789`) binds to loopback by default. For LAN/Tailnet access, bind explicitly and keep auth enabled. For Tailnet-only setups, set `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` and restart the gateway (or the macOS menubar app).

## What advertises

Only the gateway advertises `_openclaw-gw._tcp`. LAN multicast advertising comes from the bundled `bonjour` plugin when enabled; wide-area DNS-SD publishing stays gateway-owned.

## Service types

- `_openclaw-gw._tcp` - gateway transport beacon, used by macOS/iOS/Android nodes.

## TXT keys (non-secret hints)

| Key                           | When present                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `role=gateway`                | Always.                                                                        |
| `displayName=<friendly name>` | Always.                                                                        |
| `lanHost=<hostname>.local`    | Always.                                                                        |
| `gatewayPort=<port>`          | Always (gateway WS + HTTP).                                                    |
| `transport=gateway`           | Always.                                                                        |
| `gatewayTls=1`                | Only when TLS is enabled.                                                      |
| `gatewayTlsSha256=<sha256>`   | Only when TLS is enabled and a fingerprint is available.                       |
| `gatewayDirectReachable=1`    | Only when the gateway is directly reachable (not only via a relay/proxy path). |
| `canvasPort=<port>`           | Only when the canvas host is enabled; currently the same as `gatewayPort`.     |
| `tailnetDns=<magicdns>`       | mDNS full mode only; optional hint when Tailnet is available.                  |
| `sshPort=<port>`              | Full mode only; omitted in minimal and off modes.                              |
| `cliPath=<path>`              | Full mode only; omitted in minimal and off modes.                              |

Security notes:

- Bonjour/mDNS TXT records are **unauthenticated**. Clients must not treat TXT as authoritative routing.
- Clients should route using the resolved service endpoint (SRV + A/AAAA). Treat `lanHost`, `tailnetDns`, `gatewayPort`, and `gatewayTlsSha256` as hints only.
- SSH auto-targeting should likewise use the resolved service host, not TXT-only hints.
- TLS pinning must never let an advertised `gatewayTlsSha256` override a previously stored pin.
- iOS/Android nodes should treat discovery-based direct connects as **TLS-only** and require explicit user confirmation before trusting a first-time fingerprint.

## Debugging on macOS

Built-in tools:

```bash
# Browse instances
dns-sd -B _openclaw-gw._tcp local.

# Resolve one instance (replace <instance>)
dns-sd -L "<instance>" _openclaw-gw._tcp local.
```

If browsing works but resolving fails, you're usually hitting a LAN policy or mDNS resolver issue.

## Debugging in Gateway logs

The gateway writes a rolling log file (printed on startup as `gateway log file: ...`). Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...`
- `bonjour: suppressing ciao netmask assertion ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`

OpenClaw starts each Bonjour service once and leaves probing, retry, name-conflict resolution, and interface-change republishing to the mDNS responder. This avoids overlapping publish attempts during normal network churn. Repeated internal self-probe messages are suppressed so they cannot flood the gateway log.

When multiple OpenClaw gateways advertise from the same host, Bonjour may append suffixes such as `(2)` or `(3)` to keep service instance names unique. Those suffixes are normal conflict resolution and do not indicate duplicate OCM supervision.

Bonjour uses the system hostname for the advertised `.local` host when it's a valid DNS label. If the system hostname contains spaces, underscores, or another invalid DNS-label character, OpenClaw falls back to `openclaw.local`. Set `OPENCLAW_MDNS_HOSTNAME=<name>` before starting the gateway when you need an explicit host label.

## Debugging on iOS node

The iOS node uses `NWBrowser` to discover `_openclaw-gw._tcp`.

To capture logs: Settings -> Gateway -> Advanced -> **Discovery Debug Logs**, then Settings -> Gateway -> Advanced -> **Discovery Logs** -> reproduce -> **Copy**. The log includes browser state transitions and result-set changes.

## When to enable Bonjour

Bonjour auto-starts for empty-config gateway startup on macOS hosts, since the local app and nearby iOS/Android nodes commonly rely on same-LAN discovery.

Enable it explicitly when same-LAN auto-discovery is useful on Linux, Windows, or another non-macOS host:

```bash
openclaw plugins enable bonjour
```

When enabled, Bonjour uses `discovery.mdns.mode` to decide how much TXT metadata to publish; the same mode controls optional TXT hints in wide-area DNS-SD records. Modes:

| Mode                | Behavior                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal` (default) | Core TXT keys only; omits `sshPort`, `cliPath`, `tailnetDns`.                                                                            |
| `full`              | Adds `sshPort`, `cliPath`, `tailnetDns` — use when clients need those hints.                                                             |
| `off`               | Suppresses LAN multicast without changing plugin enablement; wide-area DNS-SD can still publish when `discovery.wideArea.domain` is set. |

## When to disable Bonjour

Leave Bonjour disabled when LAN multicast advertising is unnecessary, unavailable, or harmful — common cases are non-macOS servers, Docker bridge networking, WSL, or a network policy that drops mDNS multicast. The gateway stays reachable through its published URL, SSH, Tailnet, or wide-area DNS-SD; only LAN auto-discovery is unreliable.

Use the env override for deployment-scoped problems (safe for Docker images, service files, launch scripts, one-off debugging — it disappears when the environment does):

```bash
OPENCLAW_DISABLE_BONJOUR=1
```

Use plugin configuration when you intentionally want to turn off the bundled LAN discovery plugin for that OpenClaw config:

```bash
openclaw plugins disable bonjour
```

## Docker gotchas

The bundled Bonjour plugin auto-disables LAN multicast advertising in detected containers when `OPENCLAW_DISABLE_BONJOUR` is unset. Docker bridge networks usually don't forward mDNS multicast (`224.0.0.251:5353`) between the container and the LAN, so advertising from the container rarely makes discovery work.

Gotchas:

- Bonjour auto-starts on macOS hosts and is opt-in elsewhere. Leaving it disabled doesn't stop the gateway — it only skips LAN multicast advertising.
- Disabling Bonjour doesn't change `gateway.bind`; Docker still defaults to `OPENCLAW_GATEWAY_BIND=lan` so the published host port works.
- Disabling Bonjour doesn't disable wide-area DNS-SD. Use wide-area discovery or Tailnet when the gateway and node aren't on the same LAN.
- Reusing the same `OPENCLAW_CONFIG_DIR` outside Docker doesn't persist the container auto-disable policy.
- Set `OPENCLAW_DISABLE_BONJOUR=0` only for host networking, macvlan, or another network where mDNS multicast is known to pass; set it to `1` to force-disable.

## Troubleshooting disabled Bonjour

If a node no longer auto-discovers the gateway after Docker setup:

1. Confirm whether the gateway is running in auto, forced-on, or forced-off mode:

   ```bash
   docker compose config | grep OPENCLAW_DISABLE_BONJOUR
   ```

2. Confirm the gateway itself is reachable through the published port:

   ```bash
   curl -fsS http://127.0.0.1:18789/healthz
   ```

3. Use a direct target when Bonjour is disabled:
   - Control UI or local tools: `http://127.0.0.1:18789`
   - LAN clients: `http://<gateway-host>:18789`
   - Cross-network clients: Tailnet MagicDNS, Tailnet IP, SSH tunnel, or wide-area DNS-SD

4. If you deliberately enabled the Bonjour plugin in Docker and forced advertising with `OPENCLAW_DISABLE_BONJOUR=0`, test multicast from the host:

   ```bash
   dns-sd -B _openclaw-gw._tcp local.
   ```

   If browsing is empty, or Gateway logs show repeated ciao probe failures, restore `OPENCLAW_DISABLE_BONJOUR=1` and use a direct or Tailnet route.

## Common failure modes

- **Bonjour doesn't cross networks**: use Tailnet or SSH.
- **Multicast blocked**: some Wi-Fi networks disable mDNS.
- **Advertiser stuck in probing/announcing**: hosts with blocked multicast, container bridges, WSL, or interface churn can leave the responder in a non-announced state. The gateway remains available through direct, SSH, Tailnet, or wide-area DNS-SD routes; disable LAN Bonjour with `discovery.mdns.mode: "off"` or `OPENCLAW_DISABLE_BONJOUR=1` when multicast is unavailable.
- **Docker bridge networking**: Bonjour auto-disables in detected containers. Set `OPENCLAW_DISABLE_BONJOUR=0` only for host, macvlan, or another mDNS-capable network.
- **Sleep/interface churn**: macOS may temporarily drop mDNS results; retry.
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or punctuation), then restart the gateway. The service instance name derives from the host name, so overly complex names can confuse some resolvers.

## Escaped instance names (`\032`)

Bonjour/DNS-SD often escapes bytes in service instance names as decimal `\DDD` sequences (spaces become `\032`). This is normal at the protocol level; UIs should decode for display (iOS uses `BonjourEscapes.decode`).

## Enabling / disabling / configuration

| Setting                                              | Effect                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `openclaw plugins enable bonjour`                    | Enables the bundled LAN discovery plugin on hosts where it isn't default-enabled. |
| `openclaw plugins disable bonjour`                   | Disables LAN multicast advertising by disabling the bundled plugin.               |
| `OPENCLAW_DISABLE_BONJOUR=1` (or `true`/`yes`/`on`)  | Disables LAN multicast advertising without changing plugin config.                |
| `OPENCLAW_DISABLE_BONJOUR=0` (or `false`/`no`/`off`) | Forces LAN multicast advertising on, including inside detected containers.        |
| `discovery.mdns.mode`                                | `off` \| `minimal` (default) \| `full` — see modes above.                         |
| `gateway.bind`                                       | Controls the gateway bind mode in `~/.openclaw/openclaw.json`.                    |
| `OPENCLAW_SSH_PORT`                                  | Overrides the SSH port when `sshPort` is advertised (full mode).                  |
| `OPENCLAW_TAILNET_DNS`                               | Publishes a MagicDNS hint in TXT when mDNS full mode is enabled.                  |
| `OPENCLAW_CLI_PATH`                                  | Overrides the advertised CLI path (full mode).                                    |

macOS hosts auto-start the bundled LAN discovery plugin by default. When the Bonjour plugin is enabled and `OPENCLAW_DISABLE_BONJOUR` is unset, Bonjour advertises on normal hosts and auto-disables inside detected containers (Docker, Fly.io machines, and common container runtimes).

## Related docs

- Discovery policy and transport selection: [Discovery](/gateway/discovery)
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)
