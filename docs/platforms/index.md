---
summary: "Platform support overview (Gateway + companion apps)"
read_when:
  - Looking for OS support or install paths
  - Deciding where to run the Gateway
---
# Platforms

Moltbot core is written in TypeScript. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

**Companion apps:**
- **macOS menu bar app:** Available for development builds (build from source)
- **iOS/Android apps:** Currently in internal preview; not publicly distributed
- **Windows/Linux companion apps:** Planned

The Gateway itself is fully supported on macOS, Linux, and Windows (via WSL2) today. You can use Clawdbot's full feature set via the CLI and web interface without needing the companion apps.

## Choose your OS

- macOS: [macOS](/platforms/macos)
- iOS: [iOS](/platforms/ios)
- Android: [Android](/platforms/android)
- Windows: [Windows](/platforms/windows)
- Linux: [Linux](/platforms/linux)

## VPS & hosting

- VPS hub: [VPS hosting](/vps)
- Fly.io: [Fly.io](/platforms/fly)
- Hetzner (Docker): [Hetzner](/platforms/hetzner)
- GCP (Compute Engine): [GCP](/platforms/gcp)
- exe.dev (VM + HTTPS proxy): [exe.dev](/platforms/exe-dev)

## Common links

- Install guide: [Getting Started](/start/getting-started)
- Gateway runbook: [Gateway](/gateway)
- Gateway configuration: [Configuration](/gateway/configuration)
- Service status: `moltbot gateway status`

## Gateway service install (CLI)

Use one of these (all supported):

- Wizard (recommended): `moltbot onboard --install-daemon`
- Direct: `moltbot gateway install`
- Configure flow: `moltbot configure` → select **Gateway service**
- Repair/migrate: `moltbot doctor` (offers to install or fix the service)

The service target depends on OS:
- macOS: LaunchAgent (`bot.molt.gateway` or `bot.molt.<profile>`; legacy `com.clawdbot.*`)
- Linux/WSL2: systemd user service (`moltbot-gateway[-<profile>].service`)
