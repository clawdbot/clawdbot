# Linux Systemd Deployment

For production deployments on Linux (VPS, Raspberry Pi, Home Lab), it is recommended to run Clawdbot as a systemd service. This ensures the gateway restarts automatically on crash or reboot.

If you also use Cloudflare Tunnels for remote access, you can configure a dependent service to ensure the tunnel stays connected to the gateway.

## Prerequisites

1.  Node.js (v22+)
2.  `cloudflared` (if using remote access)
3.  Clawdbot repository cloned and built (`pnpm install && pnpm build`)

## 1. Setup Gateway Service

1.  Copy the example template:
    ```bash
    sudo cp deploy/systemd/clawdbot-gateway.service.example /etc/systemd/system/clawdbot-gateway.service
    ```

2.  Edit the file to match your user and paths:
    ```bash
    sudo nano /etc/systemd/system/clawdbot-gateway.service
    ```
    - Change `User=<YOUR_USER>` to your username.
    - Change `WorkingDirectory` to your Clawdbot folder.
    - Update `ExecStart` with your preferred flags (e.g. secure token).

3.  Reload and start:
    ```bash
    sudo systemctl daemon-reload
    sudo systemctl enable --now clawdbot-gateway
    ```

## 2. Setup Cloudflare Tunnel (Optional)

This service is configured to depend on `clawdbot-gateway`, ensuring robust connectivity.

1.  Copy the example template:
    ```bash
    sudo cp deploy/systemd/clawdbot-tunnel.service.example /etc/systemd/system/clawdbot-tunnel.service
    ```

2.  Edit the file:
    ```bash
    sudo nano /etc/systemd/system/clawdbot-tunnel.service
    ```
    - Update `User` and `ExecStart` paths.
    - Ensure your tunnel is already created (`cloudflared tunnel create <name>`).

3.  Enable:
    ```bash
    sudo systemctl enable --now clawdbot-tunnel
    ```

## Operations

Check status:
```bash
systemctl status clawdbot-gateway clawdbot-tunnel
```

View logs:
```bash
journalctl -u clawdbot-gateway -f
```
