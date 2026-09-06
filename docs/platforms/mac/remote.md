---
summary: "macOS app flow for controlling a remote OpenClaw gateway"
read_when:
  - Setting up or debugging remote mac control
  - Signing in to a Gateway from the Mac app or opening it from a website
title: "Remote control"
---

This flow lets the macOS app act as a full remote control for an OpenClaw gateway running on another host (desktop/server). The app connects directly to trusted LAN/Tailnet gateway URLs, or manages an SSH tunnel when the remote gateway is loopback-only. Health checks, Voice Wake forwarding, and Web Chat reuse the same remote configuration from the native **Connection** window.

## Connect with your browser

Add a saved Gateway to use its dashboard and native chat with your personal
account. This connection stays separate from the primary Gateway that owns
Mac node capabilities and Talk Mode.

1. On first launch, choose **Connect to an existing Gateway**. In an already
   configured app, open **Connection… → Gateways → Add Gateway**.
2. Enter the Gateway's address, such as `gateway.example.com` or
   `https://gateway.example.com/operator/`. A hostname defaults to HTTPS;
   include the full base path when the Gateway is hosted beneath one. **Name**
   is optional.
3. Click **Connect**. For a Gateway protected by Cloudflare Access, the app
   opens your default browser. Continue with the account you use for that
   Gateway and complete any sign-in prompts there.
4. Return to OpenClaw. The saved Gateway's dashboard opens; check the account
   name in its sidebar footer. You can open more windows from
   **File → New Gateway Window…**. The app reopens your selected Gateway after
   restart, including when a separate primary Gateway supplies Mac capabilities.

Cloudflare Access issues the personal application session through its
[browser-to-client sign-in flow](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/).
The Mac app stores that session in Keychain and uses it for the saved Gateway's
native connection and embedded dashboard. Its validity follows the session
duration configured by the Access administrator. No shared Gateway token needs
to be copied from the website.

Browser sign-in currently supports Cloudflare Access. For Gateways that use a
shared token or password, expand **Token or password** and provide the
credential supplied by the administrator. Other browser sign-in providers are
not supported by this flow. Existing private-network `ws://` and secure
`wss://` connections remain available through this editor.

A signed-in native operator device may still need a one-time approval on the
Gateway. The Gateway's existing [automatic device approval policy](/gateway/trusted-proxy-auth#automatic-device-approval)
determines whether verified proxy identities can enroll automatically.

When the browser session expires, choose **Reconnect** for that saved Gateway,
then **Connect** to sign in again. Renewing the same account keeps its native
chat cache and queued messages. Signing in with a different account closes the
previous account's native chat windows and uses that account's own cache and
queue. Previously queued messages remain with their original account; sign
back into that account to access them.

To sign out of that Gateway in the Mac app,
remove it from **Connection… → Gateways** and confirm **Remove**. This removes its
saved credentials and dashboard browser data. Use your identity provider's
session controls to revoke account access more broadly.

### Open the Mac app from a website

In the browser dashboard, open **Get the apps** from the account menu, then
choose **Open in Mac app** on the macOS card. The link uses the connected
Gateway's HTTPS address. OpenClaw shows **Add Gateway** with that address filled
in; review it and click **Connect** to complete the same sign-in flow.

Websites can launch this editor with the registered `openclaw` URL scheme:

```text
openclaw://gateway/add?url=https%3A%2F%2Fgateway.example.com%2Foperator%2F&name=Research
```

`url` is required and contains the percent-encoded full HTTPS Gateway base URL,
including its port and base path when needed. `name` is an optional display
label. The link carries connection intent only: it accepts no token, password,
URL user information, query, or fragment in the Gateway address, and it does
not authorize access. Credentials are obtained separately during sign-in.

The existing `openclaw://gateway?host=…` setup route retains its primary-Gateway
setup behavior. Use `openclaw://gateway/add` to add a saved Gateway without replacing
the primary connection.

## Modes

- **Local (this Mac)**: everything runs on the laptop; no SSH involved.
- **Remote over SSH (default)**: OpenClaw commands run on the remote host. The app opens an SSH connection with `-o BatchMode`, your chosen identity/key, and a local port-forward.
- **Remote direct (ws/wss)**: no SSH tunnel; the app connects to the gateway URL directly (LAN, Tailscale, Tailscale Serve, or a public HTTPS reverse proxy).

## Remote transports

- **SSH tunnel** (default): uses `ssh -N -L ...` to forward the gateway port to localhost. The gateway sees the node's IP as `127.0.0.1` because the tunnel is loopback.
- **Direct (ws/wss)**: connects straight to the gateway URL. The gateway sees the real client IP.

The app disables SSH connection multiplexing and post-authentication backgrounding for its own SSH processes so it can monitor and restart the exact process, even if the selected alias enables `ControlMaster` or `ForkAfterAuthentication`.

SSH host-key verification is strict by default because gateway credentials travel through this tunnel. To opt into a managed SSH alias's own trust behavior, set `--ssh-host-key-policy openssh` via `openclaw-mac configure-remote`, or set `gateway.remote.sshHostKeyPolicy` to `"openssh"` directly. Review the alias and any matching `Host *` or system configuration before opting in. Changing the SSH target (in the app or via `configure-remote`) resets the policy back to `strict` unless you explicitly opt in again for the new target.

In SSH tunnel mode, discovered LAN/tailnet hostnames save as `gateway.remote.sshTarget`. The app keeps `gateway.remote.url` on the local tunnel endpoint (for example `ws://127.0.0.1:18789`) so CLI, Web Chat, and the local node-host service all use the same loopback transport. When discovery returns both raw Tailnet IPs and stable hostnames, the app prefers Tailscale MagicDNS or LAN names so connections survive address changes better. If the local tunnel port differs from the remote gateway port, set `gateway.remote.remotePort` to the port on the remote host.

The Mac app's node combines native capabilities with system, browser, plugin, skill, and MCP commands from its bundled private worker. Connecting the app to a remote Gateway needs no external CLI or separate node-service installation on this Mac. An already-installed headless node service remains separate: the app preserves its start/stop and managed update/recovery behavior. Optional [cookie sync](/platforms/macos#sync-cookies-to-a-remote-computer) still uses an external CLI and reports a feature-specific error when it is missing.

## Prereqs on the remote host

1. Install Node + pnpm, then build/install the OpenClaw CLI from its checkout (`pnpm install && pnpm build && pnpm add --global "openclaw@link:$PWD"`).
2. Ensure `openclaw` is on PATH for non-interactive shells (symlink into `/usr/local/bin` or `/opt/homebrew/bin` if needed).
3. For SSH transport: set up key-based SSH auth. Tailscale IPs are recommended for stable reachability off-LAN.

## macOS app setup

To preconfigure the app without the welcome flow, over SSH:

```bash
openclaw-mac configure-remote \
  --ssh-target user@gateway-host \
  --local-port 18789 \
  --remote-port 18789 \
  --token "$OPENCLAW_GATEWAY_TOKEN"
```

Or for a gateway already reachable on a trusted LAN or Tailnet, skip SSH entirely:

```bash
openclaw-mac configure-remote \
  --direct-url ws://192.168.0.202:18789 \
  --token "$OPENCLAW_GATEWAY_TOKEN"
```

`openclaw-mac connect`, `wizard`, and `configure-remote` resolve the active config in this order: `OPENCLAW_CONFIG_PATH`, then `$OPENCLAW_STATE_DIR/openclaw.json`, then `~/.openclaw/openclaw.json`. Both configuration forms write that active file, mark onboarding complete, and let the app own the selected transport on next start. `--local-port`/`--remote-port` default to `18789`. Other flags: `--password`, `--identity <path>`, `--ssh-host-key-policy <strict|openssh>`, `--project-root <path>`, `--cli-path <path>`, `--json`. Run `openclaw-mac configure-remote --help` for the full reference.

To configure from the UI instead:

1. Choose **Connection…** from the menu bar and select the **Connection** tab.
2. Under **OpenClaw runs**, pick **Remote** and set:
   - **Transport**: **SSH tunnel** or **Direct (ws/wss)**.
   - **SSH target**: `user@host` (optional `:port`). If the gateway is on the same LAN and advertises Bonjour, pick it from the discovered list to auto-fill this field.
   - **Gateway URL** (Direct only): `wss://gateway.example.ts.net` (or `ws://...` for local/LAN).
   - **Identity file** (advanced): path to your key.
   - **Project root** (advanced): remote checkout path used for commands.
   - **CLI path** (advanced): optional path to a runnable `openclaw` entrypoint/binary (auto-filled when advertised).
3. Hit **Test remote**. The app checks SSH reachability when applicable, then authenticates and calls the Gateway health RPC. Connection, authentication, and pairing errors appear here; this check does not require a CLI on this Mac.
4. Health checks and Web Chat now run through the selected transport automatically.

## Web Chat

- **SSH tunnel**: connects to the gateway over the forwarded WebSocket control port (default 18789).
- **Direct (ws/wss)**: connects straight to the configured gateway URL.
- There is no separate Web Chat HTTP server.

## Permissions

- The remote host needs the same TCC approvals as local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Run onboarding on that machine once to grant them.
- Nodes advertise their permission state via `node.list` / `node.describe` so agents know what is available.

## Security notes

- Prefer loopback binds on the remote host and connect via SSH, Tailscale Serve, or a trusted Tailnet/LAN direct URL.
- SSH tunneling requires an already-trusted host key by default. Trust the host key first (add it to the configured known-hosts file), or explicitly set `gateway.remote.sshHostKeyPolicy: "openssh"` for a managed alias whose OpenSSH trust policy you accept.
- If you bind the Gateway to a non-loopback interface, require valid Gateway auth: token, password, or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`.
- Direct `wss://` connections apply one certificate policy to both operator/control traffic and the Mac companion node. Set `gateway.remote.tlsFingerprint` for an explicit pin. Without one, the app records a first-use pin only after normal macOS trust succeeds.
- See [Security](/gateway/security) and [Tailscale](/gateway/tailscale).

## WhatsApp login flow (remote)

- Run `openclaw channels login --channel whatsapp --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Re-run login on that host if auth expires. The health check surfaces link problems.

## Troubleshooting

The Dashboard error page shows the attempted address without embedded credentials. Check the host, port, and path when troubleshooting an unavailable Gateway. Choose **Connection Settings…** there, or **Connection…** from the menu bar, to repair the connection without loading the Dashboard.

| Symptom                                          | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit 127` / not found                           | `openclaw` is not on PATH for non-login shells. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Health probe failed                              | Check SSH reachability, PATH, and that Baileys (WhatsApp) is logged in (`openclaw status --json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Web Chat stuck                                   | Confirm the gateway is running on the remote host and the forwarded port matches the gateway WS port; the UI requires a healthy WS connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Node IP shows `127.0.0.1`                        | Expected with the SSH tunnel. Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Dashboard works but Mac capabilities are offline | The operator/control connection is healthy, but the companion node connection is not connected or is missing its command surface. Open the menu bar device section and check whether the Mac is `paired · disconnected`. Direct `wss://` operator and node connections use the same configured or stored certificate policy. For trusted `wss://*.ts.net` Tailscale Serve endpoints, stale stored leaf pins are replaced after certificate rotation and retried automatically. Configured pins never rotate automatically; update `gateway.remote.tlsFingerprint` after reviewing the new certificate, or switch to **Remote over SSH**. |
| Voice Wake                                       | Trigger phrases forward automatically in remote mode; no separate forwarder is needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Notification sounds

Pick sounds per notification from scripts with `openclaw nodes notify`, for example:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

There is no global default-sound toggle in the app; callers choose a sound (or none) per request.

## Related

- [macOS app](/platforms/macos)
- [Remote access](/gateway/remote)
