# reMarkable Tablet Integration

Connect your reMarkable tablet to Clawdbot via Tailscale for direct SSH access from anywhere.

## Overview

This guide sets up:
- Tailscale VPN on your reMarkable (userspace networking mode)
- Direct SSH access via Tailscale IP
- Ability to upload/manage documents remotely

**Tested on:** reMarkable 2, OS 3.24.0.149

## Prerequisites

- reMarkable with SSH access enabled
- Another computer on the same network (for initial setup)
- Tailscale account

## Step 1: Get Tailscale Binaries

The reMarkable's root partition is small (~21MB free), so we install to `/home`.

```bash
# On a computer that can reach your reMarkable
# Download the ARM static binary
curl -fsSL https://pkgs.tailscale.com/stable/tailscale_1.94.1_arm.tgz -o /tmp/tailscale_arm.tgz

# Copy to reMarkable (replace IP with yours)
scp /tmp/tailscale_arm.tgz root@<REMARKABLE_IP>:/home/
```

## Step 2: Install on reMarkable

SSH into your reMarkable and run:

```bash
cd /home
tar xzf tailscale_arm.tgz
mkdir -p /home/bin /home/tailscale-state
cp tailscale_*/tailscale tailscale_*/tailscaled /home/bin/
chmod +x /home/bin/tailscale /home/bin/tailscaled
```

## Step 3: Start Tailscale

The reMarkable kernel doesn't have TUN support, so we use userspace networking with `--statedir` for SSH keys:

```bash
# Start the daemon
nohup /home/bin/tailscaled \
  --statedir=/home/tailscale-state \
  --socket=/tmp/tailscaled.sock \
  --tun=userspace-networking > /tmp/tailscaled.log 2>&1 &

# Wait a few seconds, then authenticate
sleep 5
/home/bin/tailscale --socket=/tmp/tailscaled.sock up --ssh
```

This will print an authentication URL. Visit it to add the reMarkable to your Tailnet.

## Step 4: Create Systemd Service

For auto-start on boot:

```bash
cat > /etc/systemd/system/tailscaled.service << 'EOF'
[Unit]
Description=Tailscale VPN
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/bin/tailscaled --statedir=/home/tailscale-state --socket=/tmp/tailscaled.sock --tun=userspace-networking
ExecStartPost=/bin/sh -c 'sleep 3 && /home/bin/tailscale --socket=/tmp/tailscaled.sock up --ssh'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tailscaled
systemctl start tailscaled
```

## Step 5: Configure SSH Client

On your local machine, add to `~/.ssh/config`:

```
Host rem
  HostName <TAILSCALE_IP>  # e.g., 100.91.182.5
  User root
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
```

Now you can simply run:
```bash
ssh rem
```

## Document Management

Once SSH is configured, you can manage documents remotely.

### Upload PDFs/EPUBs

```bash
# Copy file to reMarkable
scp document.pdf rem:/home/root/

# Create metadata and add to library
ssh rem 'cd /home/root/.local/share/remarkable/xochitl && \
  UUID=$(cat /proc/sys/kernel/random/uuid) && \
  cat > ${UUID}.metadata << EOF
{
    "createdTime": "'$(date +%s)'000",
    "lastModified": "'$(date +%s)'000",
    "lastOpened": "0",
    "lastOpenedPage": 0,
    "parent": "",
    "pinned": false,
    "type": "DocumentType",
    "visibleName": "My Document"
}
EOF
cp /home/root/document.pdf ${UUID}.pdf && \
echo "{}" > ${UUID}.content && \
systemctl restart xochitl'
```

### List Documents

```bash
ssh rem 'grep -h visibleName /home/root/.local/share/remarkable/xochitl/*.metadata'
```

### Delete Documents

```bash
# Find UUID by name
ssh rem 'grep -l "Document Name" /home/root/.local/share/remarkable/xochitl/*.metadata'
# Delete all files with that UUID
ssh rem 'rm /home/root/.local/share/remarkable/xochitl/<UUID>.* && systemctl restart xochitl'
```

## Troubleshooting

### "no var root for ssh keys"
Use `--statedir=/home/tailscale-state` instead of `--state=`

### Connection timeouts
The reMarkable goes to sleep aggressively. Wake it by tapping the screen.

### Tailscale not starting on boot
Check logs: `journalctl -u tailscaled`

### No TUN support
This is normal — the reMarkable kernel doesn't include the TUN module. Userspace networking mode works around this.

## Limitations

- **Userspace networking**: Outbound connections from reMarkable require proxy configuration
- **Sleep mode**: The tablet sleeps frequently; connections may timeout
- **Kernel TUN**: Not available without custom kernel (risky)

## References

- [remarkable.guide/tech/tailscale](https://remarkable.guide/tech/tailscale.html)
- [Tailscale userspace networking](https://tailscale.com/kb/1112/userspace-networking)
