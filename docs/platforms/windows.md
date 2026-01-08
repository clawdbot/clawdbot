---
summary: "Windows (WSL2) support + companion app status"
read_when:
  - Installing Clawdbot on Windows
  - Looking for Windows companion app status
  - Planning platform coverage or contributions
---
# Windows (WSL2)

Clawdbot core is supported on Windows **via WSL2** (Ubuntu recommended). The
CLI + Gateway run inside Linux, which keeps the runtime consistent. Native
Windows installs are untested and more problematic.

## Install
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

## How to install this correctly

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
pnpm ui:install
pnpm ui:build
pnpm build
pnpm clawdbot onboard
```

Full guide: [Getting Started](/start/getting-started)

## Windows companion app

We do not have a Windows companion app yet. It is planned, and we would love
contributions to make it happen.
