---
summary: "Windows (WSL2) support + companion app status"
read_when:
  - Installing Clawdbot on Windows
  - Looking for Windows companion app status
---
# Windows (WSL2)

Clawdbot on Windows is recommended **via WSL2** (Ubuntu recommended). The
CLI + Gateway run inside Linux, which keeps the runtime consistent. Native
Windows installs are untested and more problematic.

Native Windows companion apps are planned.

## Install (WSL2)
- [Getting Started](/start/getting-started) (use inside WSL)
- [Install & updates](/install/updating)
- Official WSL2 guide (Microsoft): https://learn.microsoft.com/windows/wsl/install

## Gateway
- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Inside WSL2:

```
clawdbot onboard --install-daemon
```

Or:

```
clawdbot daemon install
```

Or:

```
clawdbot configure
```

Select **Gateway daemon** when prompted.

Repair/migrate:

```
clawdbot doctor
```

## SSH into WSL from another machine

When you connect to WSL over the LAN (for example, from a Mac), you usually
connect to the Windows host IP and forward a port to the WSL sshd. The WSL
IP changes after restarts, so the Windows portproxy needs to be refreshed.

### 1) Enable SSH in WSL

Inside WSL:

```bash
sudo apt update
sudo apt install -y openssh-server
sudo service ssh start
```

### 2) Add a portproxy on Windows

Open PowerShell **as Administrator**:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=2222 `
  connectaddress=<current-wsl-ip> connectport=22
```

Allow inbound TCP 2222 through Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "WSL SSH 2222" -Direction Inbound `
  -Protocol TCP -LocalPort 2222 -Action Allow
```

Then connect from another machine:

```bash
ssh user@gateway-host -p 2222
```

### 3) Refresh the portproxy after WSL restarts

Because the WSL IP changes, refresh the portproxy whenever WSL restarts.
This PowerShell script re-points the forwarding rule:

```powershell
param(
  [string]$Distro = "Ubuntu-20.04",
  [int]$ListenPort = 2222,
  [int]$WslPort = 22
)

$ip = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $ip) { throw "WSL IP not found." }

netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectport=$WslPort connectaddress=$ip | Out-Null

Write-Host "Portproxy $ListenPort -> $ip:$WslPort"
```

You can save this as `update-wsl-portproxy.ps1` and run it from an elevated
PowerShell whenever WSL restarts. If you want this to be automatic, register a
Scheduled Task to run at login.

If you use the Clawdbot repo, `scripts/wsl-portproxy.ps1` refreshes both SSH
(`2222->22`) and XTTS (`5002->5002`) mappings.

### Expose local services (example: TTS)

If you run a local service inside WSL (for example, a TTS server on port 5002),
add a matching portproxy and firewall rule so the gateway host can reach it:

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5002 `
  connectaddress=<current-wsl-ip> connectport=5002

New-NetFirewallRule -DisplayName "WSL TTS 5002" -Direction Inbound `
  -Protocol TCP -LocalPort 5002 -Action Allow
```

### Run XTTS as a managed service (WSL)

If you want the XTTS server to survive reboots and restarts, use a systemd user
service inside WSL. This requires enabling systemd for the distro.

Enable systemd:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

After reopening WSL, enable the service:

```bash
systemctl --user enable --now xtts.service
systemctl --user status xtts.service
```

If you prefer tmux instead of systemd, launch the server in a detached session:

```bash
~/dev/xtts-tmux-start.sh
```

### Operational checklist (WSL node + remote gateway)

- Ensure the Windows portproxy points at the current WSL IP.
- Confirm `sshd` is running inside WSL and the firewall allows the listen port.
- Verify the Gateway URL in the Clawdbot config points at a reachable gateway host.
- Run `clawdbot status --all` and confirm the Gateway line is reachable.

### Troubleshooting

- `ssh` hangs: check the portproxy target and the WSL IP are in sync.
- `Permission denied`: confirm your public key is in `~/.ssh/authorized_keys`.
- `Connection refused`: check `sshd` is running inside WSL.

See [Gateway troubleshooting](/gateway/troubleshooting) and [Doctor](/cli/doctor)
for deeper checks.

## Step-by-step WSL2 install

### 1) Install WSL2 + Ubuntu

Open PowerShell (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Reboot if Windows asks.

### 2) Enable systemd (required for daemon install)

In your WSL terminal:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then from PowerShell:

```powershell
wsl --shutdown
```

Re-open Ubuntu, then verify:

```bash
systemctl --user status
```

### 3) Install Clawdbot (inside WSL)

Follow the Linux Getting Started flow inside WSL:

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
clawdbot onboard
```

Full guide: [Getting Started](/start/getting-started)

## Windows companion app

We do not have a Windows companion app yet. Contributions are welcome if you want
contributions to make it happen.
