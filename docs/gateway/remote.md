---
summary: "Remote access using Gateway WS, SSH tunnels, and tailnets"
read_when:
  - Running or troubleshooting remote gateway setups
title: "Remote access"
---

OpenClaw runs one Gateway (the master) on a host and connects every client to it. The Gateway owns sessions, auth profiles, channels, and state; everything else is a client.

- **Operators** (you, or the macOS app): direct LAN/Tailnet WebSocket is simplest when the Gateway is reachable; SSH tunneling is the universal fallback.
- **Nodes** (iOS/Android and other devices): connect to the Gateway **WebSocket** (LAN/tailnet or SSH tunnel).

## The core idea

The Gateway WebSocket binds to **loopback** by default, on port `18789` (`gateway.port`). For remote use, either expose it through Tailscale Serve / a trusted LAN-Tailnet bind, or forward the loopback port over SSH.

## Topology options

| Setup                             | Where the Gateway runs                                                                                    | Best for                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always-on Gateway in your tailnet | Persistent host (VPS or home server), reached via Tailscale or SSH                                        | Laptops that sleep often but need the agent always-on. See [exe.dev](/install/exe-dev) (easy VM) or [Hetzner](/install/hetzner) (production VPS). |
| Home desktop                      | Desktop; laptop connects remotely via the macOS app's remote mode (Settings → Connection → OpenClaw runs) | Keeping the agent on hardware that stays powered on. Runbook: [macOS remote access](/platforms/mac/remote).                                       |
| Laptop                            | Laptop, exposed safely via SSH tunnel or Tailscale Serve (keep `gateway.bind: "loopback"`)                | Single-machine setups. See [Tailscale](/gateway/tailscale) and [Web](/web).                                                                       |

For the always-on and laptop setups, prefer keeping `gateway.bind: "loopback"` and using **Tailscale Serve** for the Control UI, or a trusted LAN/Tailnet bind with `gateway.remote.transport: "direct"`. SSH tunnel is the fallback that works from any machine.

## Command flow (what runs where)

One Gateway owns state and channels; nodes are peripherals. Example (Telegram message routed to a node tool):

1. Telegram message arrives at the **Gateway**.
2. Gateway runs the **agent**, which decides whether to call a node tool.
3. Gateway calls the **node** over the Gateway WebSocket (`node.invoke` RPC).
4. Node returns the result; Gateway replies to Telegram.

Nodes do not run the Gateway service. Only one Gateway should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). macOS app "node mode" is just a node client over the Gateway WebSocket.

## SSH tunnel (CLI + tools)

```bash
ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
```

With the tunnel up, `openclaw health` and `openclaw status --deep` reach the remote Gateway via `ws://127.0.0.1:18789`. `openclaw gateway status`, `openclaw gateway health`, `openclaw gateway probe`, and `openclaw gateway call` can also target a forwarded URL via `--url`.

<Note>
Replace `18789` with your configured `gateway.port` (or `--port` / `OPENCLAW_GATEWAY_PORT`).
</Note>

<Warning>
`--url` never falls back to config or environment credentials. Pass `--token` or `--password` explicitly; without them the client sends no credentials and the connection fails if the target Gateway requires auth.
</Warning>

## CLI remote defaults

Persist a remote target so CLI commands use it by default:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

When the Gateway is loopback-only, keep the URL at `ws://127.0.0.1:18789` and open the SSH tunnel first. In the macOS app's SSH-tunnel transport, the discovered Gateway hostname goes in `gateway.remote.sshTarget` (`user@host` or `user@host:port`); `gateway.remote.url` stays the local tunnel URL. If the remote port differs from the local one, set `gateway.remote.remotePort`.

Host-key verification is strict by default (`gateway.remote.sshHostKeyPolicy: "strict"`). Set it to `"openssh"` to delegate to your effective OpenSSH config instead; review your user and system SSH settings before enabling it.

For a Gateway already reachable on a trusted LAN or Tailnet, use direct mode:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "ws://192.168.0.202:18789",
      token: "your-token",
    },
  },
}
```

## Credential precedence

Gateway credential resolution follows one shared contract across call/probe/status paths and Discord exec-approval monitoring. Node-host uses the same contract with one local-mode exception (it ignores `gateway.remote.*`).

- Explicit credentials (`--token`, `--password`, or a tool's `gatewayToken`) always win on call paths that accept explicit auth.
- URL override safety:
  - CLI `--url` never reuses implicit config/env credentials.
  - Env `OPENCLAW_GATEWAY_URL` may use env credentials only (`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).
- Local mode defaults:
  - token: `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token` -> `gateway.remote.token` (remote fallback only when the local token is unset)
  - password: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.auth.password` -> `gateway.remote.password` (remote fallback only when the local password is unset)
- Remote mode defaults:
  - token: `gateway.remote.token` -> `OPENCLAW_GATEWAY_TOKEN` -> `gateway.auth.token`
  - password: `OPENCLAW_GATEWAY_PASSWORD` -> `gateway.remote.password` -> `gateway.auth.password`
- Node-host local-mode exception: `gateway.remote.token` / `gateway.remote.password` are ignored.
- Remote probe/status token checks are strict by default: they use `gateway.remote.token` only (no local token fallback) when targeting remote mode.
- Gateway env overrides use `OPENCLAW_GATEWAY_*` only.

## Chat UI remote access

WebChat has no separate HTTP port; the SwiftUI chat UI connects directly to the Gateway WebSocket.

- Forward `18789` over SSH (see above), then connect clients to `ws://127.0.0.1:18789`.
- For LAN/Tailnet direct mode, connect clients to the configured private `ws://` or secure `wss://` URL.
- On macOS, the app's remote mode manages the selected transport automatically.

## macOS app remote mode

The macOS menu bar app drives the same setup end-to-end: remote status checks, WebChat, and Voice Wake forwarding. Runbook: [macOS remote access](/platforms/mac/remote).

## Security rules (remote/VPN)

Keep the Gateway **loopback-only** unless you are sure you need a bind.

- **Loopback + SSH/Tailscale Serve** is the safest default (no public exposure).
- Plaintext `ws://` is accepted for loopback, private/LAN (RFC 1918), link-local, CGNAT, `.local`, and `.ts.net` hosts. Public remote hosts must use `wss://`.
- **Non-loopback binds** (`lan`/`tailnet`/`custom`, or `auto` when loopback is unavailable) must use Gateway auth: token, password, or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`.
- `gateway.remote.token` / `.password` are client credential sources; they do not configure server auth by themselves.
- Local call paths can use `gateway.remote.*` as a fallback only when `gateway.auth.*` is unset.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
- `gateway.remote.tlsFingerprint` pins the remote TLS cert for `wss://`, including both operator/control traffic and the companion node in macOS direct mode. Without a stored pin, macOS pins on first use only after normal system trust passes; self-signed or private-CA Gateways need an explicit fingerprint or Remote over SSH.
- **Tailscale Serve** can authenticate Control UI/WebSocket traffic via identity headers when `gateway.auth.allowTailscale: true`. HTTP API endpoints do not use that header auth and instead follow the Gateway's normal HTTP auth mode. This tokenless flow assumes the Gateway host is trusted; set it to `false` for shared-secret auth everywhere.
- **Trusted-proxy** auth expects a non-loopback identity-aware proxy by default. Same-host loopback reverse proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true`.
- Treat browser control like operator access: tailnet-only plus deliberate node pairing.

Deep dive: [Security](/gateway/security).

### macOS: persistent SSH tunnel via LaunchAgent

For macOS clients, the easiest persistent setup uses an SSH `LocalForward` config entry plus a LaunchAgent that keeps the tunnel alive across reboots and crashes.

#### Step 1: add SSH config

Edit `~/.ssh/config`:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>
    User <REMOTE_USER>
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Replace `<REMOTE_IP>` and `<REMOTE_USER>` with your values.

#### Step 2: copy SSH key (one-time)

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

#### Step 3: configure the gateway token

```bash
openclaw config set gateway.remote.token "<your-token>"
```

Use `gateway.remote.password` instead if the remote Gateway uses password auth. `OPENCLAW_GATEWAY_TOKEN` is still valid as a shell-level override, but the durable remote-client setup is `gateway.remote.token` / `gateway.remote.password`.

#### Step 4: create the LaunchAgent

Save as `~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

#### Step 5: load the LaunchAgent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist
```

The tunnel starts automatically at login, restarts on crash, and keeps the forwarded port live.

<Note>
If you have a leftover `com.openclaw.ssh-tunnel` LaunchAgent from an older setup, unload and delete it.
</Note>

#### Troubleshooting

```bash
# Check if the tunnel is running
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789

# Restart the tunnel
launchctl kickstart -k gui/$UID/ai.openclaw.ssh-tunnel

# Stop the tunnel
launchctl bootout gui/$UID/ai.openclaw.ssh-tunnel
```

| Config entry                         | What it does                                                 |
| ------------------------------------ | ------------------------------------------------------------ |
| `LocalForward 18789 127.0.0.1:18789` | Forwards local port 18789 to remote port 18789               |
| `ssh -N`                             | SSH without executing remote commands (port forwarding only) |
| `KeepAlive`                          | Restarts the tunnel automatically if it crashes              |
| `RunAtLoad`                          | Starts the tunnel when the LaunchAgent loads at login        |

## Related

- [Tailscale](/gateway/tailscale)
- [Authentication](/gateway/authentication)
- [Remote gateway setup](/gateway/remote-gateway-readme)
