---
summary: "Windows support: Windows Hub, native CLI and Gateway, WSL2 gateway setup, node mode, and troubleshooting"
read_when:
  - Installing OpenClaw on Windows
  - Choosing between Windows Hub, native Windows, and WSL2
  - Setting up the Windows companion app or Windows node mode
title: "Windows"
---

OpenClaw ships a native **Windows Hub** companion app plus Windows CLI support.
Use Windows Hub for a desktop app with setup, tray status, chat, Command
Center diagnostics, and Windows node capabilities. Use the PowerShell
installer for the CLI/Gateway directly. Use WSL2 for the most
Linux-compatible Gateway runtime.

## Recommended: Windows Hub

Windows Hub is the native WinUI companion app for Windows 10 20H2+ and
Windows 11. It installs without administrator privileges and ships signed x64
and ARM64 installers from its own release page.

Windows Hub publishes independently from the OpenClaw CLI and Gateway. Download
the latest stable Hub installer from the
[Windows Hub releases page](https://github.com/openclaw/openclaw-windows-node/releases/latest)
or directly via `releases/latest/download`:

- [OpenClawCompanion-Setup-x64.exe](https://github.com/openclaw/openclaw-windows-node/releases/latest/download/OpenClawCompanion-Setup-x64.exe)
- [OpenClawCompanion-Setup-arm64.exe](https://github.com/openclaw/openclaw-windows-node/releases/latest/download/OpenClawCompanion-Setup-arm64.exe)

If a link above 404s, visit the [Windows Hub releases page](https://github.com/openclaw/openclaw-windows-node/releases)
and open the newest stable Windows Hub release. Regular OpenClaw stable releases
also mirror a pinned, release-validated Windows Hub build; that mirror can lag a
newer standalone Hub release.

After install, launch **OpenClaw Companion** from the Start menu or system
tray. The installer also adds shortcuts for Gateway Setup, Chat, Settings,
Check for Updates, and uninstall.

### What Windows Hub includes

- System tray status and launch-at-login.
- First-run setup for a local app-owned WSL Gateway.
- Connection settings for local, remote, and SSH-tunneled Gateways.
- Native chat window plus access to the browser Control UI.
- Command Center diagnostics for sessions, usage, channels, nodes, pairing,
  and repair commands.
- Windows node mode for agent-controlled canvas, screen, camera,
  notifications, device status, talk, and controlled `system.run`.
- Local MCP server mode for MCP clients such as Claude Desktop, Claude Code,
  and Cursor.

### First launch

On first launch, Windows Hub opens setup when there is no usable saved
Gateway. The fastest path is **Set up locally**, which provisions an
app-owned `OpenClawGateway` WSL distro, installs the Gateway inside it, and
pairs the app. This does not export or mutate your existing Ubuntu distro.

Choose **Advanced setup** or open the Connections tab when you already have a
Gateway. You can connect to:

- a local Gateway on this PC
- a WSL Gateway on this PC
- a remote Gateway by URL and token or setup code
- a Gateway reached through an SSH tunnel

When setup finishes, the tray icon turns green. Open **Command Center** from
the tray to confirm connection, pairing, node status, and channel health.

## Windows node mode

Windows Hub can register as an OpenClaw node so the agent can use declared
Windows-native capabilities through the Gateway. Node commands must be
declared by the node and allowed by Gateway policy before they run; see
[Nodes](/nodes#command-policy) for the full allow/deny model.

Common commands:

| Family | Commands                                                                             |
| ------ | ------------------------------------------------------------------------------------ |
| Canvas | `canvas.present`, `canvas.hide`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot` |
| Screen | `screen.snapshot`; `screen.record` requires explicit opt-in                          |
| Camera | `camera.list`; `camera.snap`, `camera.clip` require explicit opt-in                  |
| System | `system.notify`, `system.run`, `system.run.prepare`, `system.which`                  |
| Device | `location.get`, `device.info`, `device.status`                                       |
| Talk   | `talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, `talk.ptt.once`, `talk.speak`  |

Node mode requires Gateway pairing. If the app shows a pairing request,
approve it from the Gateway host:

```powershell
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

The Gateway only forwards commands the node declares and server policy
allows. Privacy-sensitive commands such as `screen.record`, `camera.snap`,
and `camera.clip` need explicit `gateway.nodes.commands.allow` opt-in.

## Local MCP mode

Windows Hub can expose the same Windows-native capability registry as a local
MCP server on loopback, so local MCP clients can drive Windows capabilities
without a running OpenClaw Gateway.

Enable it in Windows Hub Settings under the developer/advanced section. The
app shows the loopback endpoint and bearer token once the server is enabled.

Mode matrix:

| Node mode | MCP server | Behavior                           |
| --------- | ---------- | ---------------------------------- |
| off       | off        | Operator-only desktop app          |
| on        | off        | Gateway-connected Windows node     |
| off       | on         | Local MCP server only              |
| on        | on         | Gateway node plus local MCP server |

## Native Windows CLI and Gateway

For terminal-first use, install OpenClaw from PowerShell:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Verify:

```powershell
openclaw --version
openclaw doctor
openclaw gateway status --json
```

Managed startup uses Windows Scheduled Tasks when available. The task keeps
the readable `gateway.cmd` script in the OpenClaw state dir but launches it
through a generated `gateway.vbs` WScript wrapper, so the background Gateway
does not open a visible console window. If task creation is denied, OpenClaw
falls back to a per-user Startup-folder login item.

Install the Gateway service:

```powershell
openclaw gateway install
openclaw gateway status --json
```

For CLI-only use without a managed Gateway service:

```powershell
openclaw onboard --non-interactive --skip-health
openclaw gateway run
```

## WSL2 Gateway

WSL2 remains the most Linux-compatible Gateway runtime on Windows. Windows
Hub can set up an app-owned WSL Gateway for you, or install manually inside
your own distro.

Manual setup:

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Enable systemd inside WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Restart WSL from PowerShell:

```powershell
wsl --shutdown
```

Then install OpenClaw inside WSL with the Linux quickstart:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw gateway status
```

## Gateway auto-start before Windows login

For headless WSL setups, make sure the full boot chain runs even when no one
logs into Windows.

Inside WSL:

```bash
sudo apt-get install -y dbus-x11
sudo loginctl enable-linger "$(whoami)"
openclaw gateway install
```

In PowerShell as Administrator:

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu --exec dbus-launch true" /sc onstart /ru "$env:USERNAME"
```

Replace `Ubuntu` with your distro name from:

```powershell
wsl --list --verbose
```

<Note>
Two changes from older recipes:

- **`dbus-launch true` instead of `/bin/true`**: on WSL >= 2.6.1.0 a
  regression ([microsoft/WSL #13416](https://github.com/microsoft/WSL/issues/13416))
  idle-terminates the distro 15-20 seconds after the last client exits, even
  with linger enabled. `dbus-launch true` keeps a child-of-init process alive
  as a workaround (community discussion, [microsoft/WSL #9245](https://github.com/microsoft/WSL/discussions/9245)).
- **`/ru "$env:USERNAME"` instead of `/ru SYSTEM`**: per-user WSL distros (the
  default setup) are not visible to the SYSTEM account, so the task appears
  to run but the distro never starts. Running as your own account avoids
  this; Windows prompts for your password when the task is created.

</Note>

After reboot, verify from WSL:

```bash
systemctl --user is-enabled openclaw-gateway.service
systemctl --user status openclaw-gateway.service --no-pager
```

## Expose WSL services over LAN

WSL has its own virtual network. If another machine must reach a service
inside WSL, forward a Windows port to the current WSL IP. The WSL IP can
change after restarts, so refresh the forwarding rule when needed.

Example in PowerShell as Administrator:

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort

New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

Notes:

- SSH from another machine targets the Windows host IP, e.g. `ssh user@windows-host -p 2222`.
- Remote nodes must point at a reachable Gateway URL, not `127.0.0.1`.
- Use `listenaddress=0.0.0.0` for LAN access, `127.0.0.1` for local-only access.

## Troubleshooting

### The tray icon does not appear

Check Task Manager for `OpenClaw.Tray.WinUI.exe`. If it is running, open the
hidden tray-icons area and pin it. If not, launch **OpenClaw Companion** from
the Start menu.

### Local setup fails

Open the setup log from Windows Hub or inspect:

```powershell
notepad "$env:LOCALAPPDATA\OpenClawTray\Logs\Setup\easy-setup-latest.txt"
```

Common causes: disabled WSL, blocked virtualization, stale app-owned WSL
state, or a network failure while installing the Gateway package.

### The app says pairing is required

Approve the operator or node request from the Gateway:

```powershell
openclaw devices list
openclaw devices approve <requestId>
```

If the device already had a token, reconnect from the Connections tab after
approval.

### Web chat cannot reach a remote Gateway

Remote web chat needs HTTPS or localhost. For self-signed certificates, trust
the certificate in Windows, or use an SSH tunnel to a localhost URL.

### `screen.snapshot`, camera, or audio commands fail

Confirm Windows permissions for camera, microphone, screen capture, and
notifications. Packaged installs declare the protected capabilities, but
Windows may still prompt the first time a command uses them.

### Git or GitHub connectivity fails

Some networks block or throttle HTTPS to GitHub. If `git clone` or
`gh auth login` fails, try another network, a VPN, or an HTTP/HTTPS proxy.

For token-based `gh` auth in the current session:

```powershell
$env:GH_TOKEN="<your-token>"
gh auth status
gh auth setup-git
```

Never commit tokens or paste them into issues or pull requests.

## Related

- [Install overview](/install)
- [Node.js setup](/install/node)
- [Nodes](/nodes)
- [Control UI](/web/control-ui)
- [Gateway configuration](/gateway/configuration)
