---
summary: "Moltbot on Tencent Cloud Lighthouse"
read_when:
  - Setting up Moltbot on Tencent Cloud
  - Looking for VPS hosting for Moltbot
  - Want 24/7 Moltbot on Tencent Cloud Lighthouse
---

# Moltbot on Tencent Cloud Lighthouse

## Goal

Run a persistent Moltbot Gateway on Tencent Cloud Lighthouse.

Tencent Cloud Lighthouse is a lightweight VPS product, ideal for small applications and personal projects:

- Simple pricing with bundled bandwidth
- Quick deployment with pre-configured images
- Good global connectivity

## Prerequisites

- Tencent Cloud account ([signup](https://www.tencentcloud.com/account/register))
- ~10 minutes

## 1) Create a Lighthouse Instance

Go to the [Lighthouse purchase page](https://buy.tencentcloud.com/lighthouse), select the following configuration, or click [**Quick Link**](https://buy.tencentcloud.com/lighthouse?blueprintType=APP_OS&blueprintOfficialId=lhbp-8hq35xoy&regionId=15&zone=na-siliconvalley-1&bundleId=bundle_rs_nmc_lin_med2_01&loginSet=AUTO&rule=true&from=Moltbot) to get started directly.

Configuration:
- **App creation method**: App Template > AI Agent > Moltbot
- **Region**: Prefer overseas regions such as Silicon Valley, Virginia, Singapore, etc.
- **Plan**:
  - **Plan type**: Razor Speed Type (recommended), Starter Type, or General Type
  - **Plan specs**: 2 vCPUs, 2GB RAM or above
- **Server name, login method**: Configure as needed

Click **Buy Now**. Once created, note the public IP address.

## 2) Connect to the Server

Go to the [Lighthouse Console](https://console.tencentcloud.com/lighthouse) to view your newly purchased Moltbot instance. Click the **Login** button to open the Web login tool (OrcaTerm). Select **ubuntu** as the login user, choose **Passwordless Login**, and click **Login**.

## 3) Initialize Moltbot

Moltbot is pre-installed in the app image. After logging in, run the following command to initialize:

```bash
moltbot onboard
```

Follow the prompts to complete the initialization.

## 4) Verify

```bash
# Check version
moltbot --version

# Check daemon status
systemctl --user status moltbot-gateway

# Test local response
curl http://localhost:18789
```

## 5) Configure Firewall (Security Group)

1. Go to **Lighthouse Console** → Select your instance → **Firewall**
2. Configure rules:
   - **Allow**: TCP 22 (SSH)
   - **Allow**: TCP 18789 (Gateway) - if external access is needed

---

## Access the Control UI

Access via public IP:

```
http://YOUR_PUBLIC_IP:18789/
```

If the Gateway is bound to LAN or public, you can access it directly via browser.

---

## Security Recommendations

### Recommended Measures

- **Credential permissions**: `chmod 700 ~/.moltbot`
- **Security audit**: `moltbot security audit`
- **System updates**: Regularly run `sudo apt update && sudo apt upgrade`
- **Use token auth**: `moltbot config set gateway.auth.mode token`

### Verify Security Status

```bash
# View listening ports
sudo ss -tlnp

# Check gateway status
moltbot gateway status
```

---

## Troubleshooting

### Cannot connect via SSH
Check security group rules:
- Ensure port 22 is open for your IP
- Verify the public IP address is correct
- Check if the instance is running

### Gateway won't start
```bash
moltbot gateway status
moltbot doctor --non-interactive
journalctl --user -u moltbot-gateway -n 50
```

### Can't reach Control UI
```bash
# Check if gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart moltbot-gateway
```

### Bandwidth limits
Tencent Cloud Lighthouse has bundled bandwidth. If you hit limits:
- Upgrade to a higher tier
- Monitor bandwidth usage in the console

---

## Persistence

All state lives in:
- `~/.moltbot/` — config, credentials, session data
- `~/clawd/` — workspace (SOUL.md, memory, artifacts)

Back up periodically:
```bash
tar -czvf moltbot-backup.tar.gz ~/.moltbot ~/clawd
```

---

## See Also

- [Gateway remote access](/gateway/remote) — other remote access patterns
- [Gateway configuration](/gateway/configuration) — all config options
- [Hetzner guide](/platforms/hetzner) — Docker-based alternative