---
summary: "macOS app flow for controlling a remote OpenClaw gateway"
read_when:
  - Setting up or debugging remote mac control
title: "Remote control"
---

This flow lets the macOS app act as a full remote control for an OpenClaw gateway running on another host (desktop/server). The app connects directly to trusted LAN/Tailnet gateway URLs, or manages an SSH tunnel when the remote gateway is loopback-only. Health checks, Voice Wake forwarding, and Web Chat reuse the same remote configuration from _Settings -> General_.

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

Browser automation in remote mode is owned by the CLI node host, not the native macOS app node. The app starts the installed node host service when possible; to enable browser control from that Mac, install/start it with `openclaw node install ...` and `openclaw node start` (or run `openclaw node run ...` in the foreground), then target that browser-capable node.

## Prereqs on the remote host

1. Install Node + pnpm and build/install the OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
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

1. Open _Settings -> General_.
2. Under **OpenClaw runs**, pick **Remote** and set:
   - **Transport**: **SSH tunnel** or **Direct (ws/wss)**.
   - **SSH target**: `user@host` (optional `:port`). If the gateway is on the same LAN and advertises Bonjour, pick it from the discovered list to auto-fill this field.
   - **Gateway URL** (Direct only): `wss://gateway.example.ts.net` (or `ws://...` for local/LAN).
   - **Identity file** (advanced): path to your key.
   - **Project root** (advanced): remote checkout path used for commands.
   - **CLI path** (advanced): optional path to a runnable `openclaw` entrypoint/binary (auto-filled when advertised).
3. Hit **Test remote**. Success means the remote `openclaw status --json` ran correctly. Failures usually mean PATH/CLI issues; exit 127 means the CLI was not found remotely.
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
- See [Security](/gateway/security) and [Tailscale](/gateway/tailscale).

## WhatsApp login flow (remote)

- Run `openclaw channels login --channel whatsapp --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Re-run login on that host if auth expires. The health check surfaces link problems.

## Troubleshooting

| Symptom                                          | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit 127` / not found                           | `openclaw` is not on PATH for non-login shells. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Health probe failed                              | Check SSH reachability, PATH, and that Baileys (WhatsApp) is logged in (`openclaw status --json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Web Chat stuck                                   | Confirm the gateway is running on the remote host and the forwarded port matches the gateway WS port; the UI requires a healthy WS connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Node IP shows `127.0.0.1`                        | Expected with the SSH tunnel. Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Dashboard works but Mac capabilities are offline | The operator/control connection is healthy, but the companion node connection is not connected or is missing its command surface. Open the menu bar device section and check whether the Mac is `paired · disconnected`. For `wss://*.ts.net` Tailscale Serve endpoints, the app detects stale legacy TLS leaf pins after certificate rotation, clears the stale pin once macOS trusts the new certificate, and retries automatically. If the certificate is not system-trusted or the host is not a Tailscale Serve name, set `gateway.remote.tlsFingerprint` to the expected certificate fingerprint, review the certificate, or switch to **Remote over SSH**. |
| Voice Wake                                       | Trigger phrases forward automatically in remote mode; no separate forwarder is needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Notification sounds

Pick sounds per notification from scripts with `openclaw nodes notify`, for example:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

There is no global default-sound toggle in the app; callers choose a sound (or none) per request.

## Related

- [macOS app](/platforms/macos)
- [Remote access](/gateway/remote)
