# Zalo Channel Setup for Clawdbot on Kubernetes

## ✅ Zalo Được Hỗ Trợ!

Zalo integration available as a plugin. Status: **Experimental** (DMs only, groups coming soon)

## 📋 Setup Steps

### 1. Get Zalo Bot Token

1. Truy cập: **https://bot.zaloplatforms.com**
2. Đăng nhập với Zalo account
3. Tạo bot mới và configure
4. Copy bot token (format: `12345689:abc-xyz`)

### 2. Update Secret File

File `k8s/secret.yaml` đã được cập nhật với field:

```yaml
ZALO_BOT_TOKEN: ""  # Paste your token here
```

**Action**: Edit và thêm token của bạn:

```bash
vim k8s/secret.yaml
# Thay "" bằng token thực của bạn
# ZALO_BOT_TOKEN: "12345689:abc-xyz"
```

### 3. ConfigMap đã được cấu hình

File `k8s/configmap.yaml` đã có config:

```json
"channels": {
  "zalo": {
    "enabled": true,
    "botToken": "${ZALO_BOT_TOKEN}",
    "dmPolicy": "pairing",
    "allowFrom": [],
    "mediaMaxMb": 5
  }
}
```

### 4. Install Zalo Plugin (Post-Deployment)

Sau khi deploy lên K8s:

```bash
# Step 1: Exec vào pod
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- /bin/bash

# Step 2: Install Zalo plugin
node dist/index.js plugins install @clawdbot/zalo
# Hoặc từ source local:
# node dist/index.js plugins install ./extensions/zalo

# Step 3: Restart gateway để load plugin
exit
kubectl rollout restart deployment/clawdbot-gateway -n clawdbot
```

### 5. Approve Pairing Codes

Khi ai đó nhắn tin cho bot lần đầu:

```bash
# List pending pairing codes
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js pairing list zalo

# Approve a pairing code
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js pairing approve zalo <CODE>
```

## 🔧 Configuration Options

### DM Policy Options

```json
{
  "dmPolicy": "pairing"  // Default - require pairing approval
  // OR "allowlist"      // Only users in allowFrom
  // OR "open"           // Anyone can message (set allowFrom: ["*"])
  // OR "disabled"       // No DMs allowed
}
```

### Allow Specific Users

```json
{
  "allowFrom": ["123456789", "987654321"]  // Zalo user IDs
}
```

### Webhook Mode (Advanced)

```json
{
  "webhookUrl": "https://clawdbot.x.vnshop.cloud/zalo/webhook",
  "webhookSecret": "your-secret-8-to-256-chars",
  "webhookPath": "/zalo/webhook"
}
```

**Note**: Webhook and long-polling are mutually exclusive.

## ✨ Features

| Feature | Status |
|---------|--------|
| Direct messages | ✅ Supported |
| Groups | ❌ Coming soon |
| Images | ✅ Supported (5MB limit) |
| Text | ✅ 2000 char chunks |
| Stickers | ⚠️ Logged only |
| Streaming | ❌ Disabled (char limit) |

## 🚀 Complete Deployment Workflow

```bash
# 1. Update secret with Zalo token
vim k8s/secret.yaml

# 2. Deploy (hoặc update nếu đã deploy)
./deploy.sh

# 3. Install Zalo plugin
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js plugins install @clawdbot/zalo

# 4. Restart to load plugin
kubectl rollout restart deployment/clawdbot-gateway -n clawdbot

# 5. Check logs
kubectl logs -f deployment/clawdbot-gateway -n clawdbot

# 6. Test by messaging your bot on Zalo
# Then approve the pairing code
```

## 🐛 Troubleshooting

### Bot không phản hồi

```bash
# Check channel status
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js channels status --probe

# Check logs
kubectl logs -f deployment/clawdbot-gateway -n clawdbot | grep zalo

# Verify token
kubectl get secret clawdbot-secrets -n clawdbot \
  -o jsonpath='{.data.ZALO_BOT_TOKEN}' | base64 -d
```

### Plugin chưa cài

```bash
# List installed plugins
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js plugins list

# Reinstall if needed
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js plugins install @clawdbot/zalo --force
```

## 📝 Notes

- Zalo plugin = experimental, chủ yếu cho Vietnam market
- Groups sẽ được support sau (theo Zalo roadmap)
- Pairing mode = secure, recommended cho production
- Token format validation: `12345689:abc-xyz`

## 🎯 Quick Reference

```bash
# Send message
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js message send \
  --channel zalo \
  --to 123456789 \
  --message "Hello from Clawdbot!"

# List pairing codes
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js pairing list zalo

# Approve pairing
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js pairing approve zalo ABC123

# Check channel status
kubectl exec -it deployment/clawdbot-gateway -n clawdbot -- \
  node dist/index.js channels status
```

---

**Ready!** Just add your Zalo bot token to `secret.yaml` and follow the deployment steps above! 🚀
