---
summary: "Bonjour/mDNS discovery + debugging (Gateway beacons, clients, and common failure modes)"
read_when:
  - Debugging Bonjour discovery issues on macOS/iOS
  - Changing mDNS service types, TXT records, or discovery UX
---
# Bonjour / mDNS discovery

Clawdbot uses Bonjour (mDNS / DNS‑SD) as a **LAN‑only convenience** to discover
an active Gateway bridge. It is best‑effort and does **not** replace SSH or
Tailnet-based connectivity.

## Wide‑area Bonjour (Unicast DNS‑SD) over Tailscale

If the node and gateway are on different networks, multicast mDNS won’t cross the
boundary. You can keep the same discovery UX by switching to **unicast DNS‑SD**
("Wide‑Area Bonjour") over Tailscale.

High‑level steps:

1) Run a DNS server on the gateway host (reachable over Tailnet).
2) Publish DNS‑SD records for `_clawdbot-bridge._tcp` under a dedicated zone
   (example: `clawdbot.internal.`).
3) Configure Tailscale **split DNS** so `clawdbot.internal` resolves via that
   DNS server for clients (including iOS).

Clawdbot standardizes on `clawdbot.internal.` for this mode. iOS/Android nodes
browse both `local.` and `clawdbot.internal.` automatically.

### Gateway config (recommended)

```json5
{
  bridge: { bind: "tailnet" }, // tailnet-only (recommended)
  discovery: { wideArea: { enabled: true } } // enables clawdbot.internal DNS-SD publishing
}
```

### One‑time DNS server setup (gateway host)

```bash
clawdbot dns setup --apply
```

This installs CoreDNS and configures it to:
- listen on port 53 only on the gateway’s Tailscale interfaces
- serve `clawdbot.internal.` from `~/.clawdbot/dns/clawdbot.internal.db`

Validate from a tailnet‑connected machine:

```bash
dns-sd -B _clawdbot-bridge._tcp clawdbot.internal.
dig @<TAILNET_IPV4> -p 53 _clawdbot-bridge._tcp.clawdbot.internal PTR +short
```

### Tailscale DNS settings

In the Tailscale admin console:

- Add a nameserver pointing at the gateway’s tailnet IP (UDP/TCP 53).
- Add split DNS so the domain `clawdbot.internal` uses that nameserver.

Once clients accept tailnet DNS, iOS nodes can browse
`_clawdbot-bridge._tcp` in `clawdbot.internal.` without multicast.

### Bridge listener security (recommended)

The bridge port (default `18790`) is a plain TCP service. By default it binds to
`0.0.0.0`, which makes it reachable from any interface on the gateway host.

For tailnet‑only setups:
- Set `bridge.bind: "tailnet"` in `~/.clawdbot/clawdbot.json`.
- Restart the Gateway (or restart the macOS menubar app).

## What advertises

Only the Gateway (when the **bridge is enabled**) advertises `_clawdbot-bridge._tcp`.

## Service types

- `_clawdbot-bridge._tcp` — bridge transport beacon (used by macOS/iOS/Android nodes).

## TXT keys (non‑secret hints)

The Gateway advertises small non‑secret hints to make UI flows convenient:

- `role=gateway`
- `displayName=<friendly name>`
- `lanHost=<hostname>.local`
- `gatewayPort=<port>` (informational; Gateway WS is usually loopback‑only)
- `bridgePort=<port>` (only when bridge is enabled)
- `canvasPort=<port>` (only when the canvas host is enabled; default `18793`)
- `sshPort=<port>` (defaults to 22 when not overridden)
- `transport=bridge`
- `cliPath=<path>` (optional; absolute path to a runnable `clawdbot` entrypoint)
- `tailnetDns=<magicdns>` (optional hint when Tailnet is available)

## Debugging on macOS

Useful built‑in tools:

- Browse instances:
  ```bash
  dns-sd -B _clawdbot-bridge._tcp local.
  ```
- Resolve one instance (replace `<instance>`):
  ```bash
  dns-sd -L "<instance>" _clawdbot-bridge._tcp local.
  ```

If browsing works but resolving fails, you’re usually hitting a LAN policy or
mDNS resolver issue.

## Debugging in Gateway logs

The Gateway writes a rolling log file (printed on startup as
`gateway log file: ...`). Look for `bonjour:` lines, especially:

- `bonjour: advertise failed ...`
- `bonjour: ... name conflict resolved` / `hostname conflict resolved`
- `bonjour: watchdog detected non-announced service ...`

## Debugging on iOS node

The iOS node uses `NWBrowser` to discover `_clawdbot-bridge._tcp`.

To capture logs:
- Settings → Bridge → Advanced → **Discovery Debug Logs**
- Settings → Bridge → Advanced → **Discovery Logs** → reproduce → **Copy**

The log includes browser state transitions and result‑set changes.

## Common failure modes

- **Bonjour doesn’t cross networks**: use Tailnet or SSH.
- **Multicast blocked**: some Wi‑Fi networks disable mDNS.
- **Sleep / interface churn**: macOS may temporarily drop mDNS results; retry.
- **Browse works but resolve fails**: keep machine names simple (avoid emojis or
  punctuation), then restart the Gateway. The bridge instance name derives from
  the host name, so overly complex names can confuse some resolvers.

## Escaped instance names (`\032`)

Bonjour/DNS‑SD often escapes bytes in service instance names as decimal `\DDD`
sequences (e.g. spaces become `\032`).

- This is normal at the protocol level.
- UIs should decode for display (iOS uses `BonjourEscapes.decode`).

## Disabling / configuration

- `CLAWDBOT_DISABLE_BONJOUR=1` disables advertising.
- `CLAWDBOT_BRIDGE_ENABLED=0` disables the bridge listener (and the bridge beacon).
- `bridge.bind` / `bridge.port` in `~/.clawdbot/clawdbot.json` control bridge bind/port.
- `CLAWDBOT_BRIDGE_HOST` / `CLAWDBOT_BRIDGE_PORT` still work as back‑compat overrides.
- `CLAWDBOT_SSH_PORT` overrides the SSH port advertised in TXT.
- `CLAWDBOT_TAILNET_DNS` publishes a MagicDNS hint in TXT.
- `CLAWDBOT_CLI_PATH` overrides the advertised CLI path.

## Related docs

- Discovery policy and transport selection: [Discovery](/gateway/discovery)
- Node pairing + approvals: [Gateway pairing](/gateway/pairing)
