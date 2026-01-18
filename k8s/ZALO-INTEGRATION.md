# Zalo Channel Setup for Clawdbot on Kubernetes

## ✅ Zalo Được Hỗ Trợ!

Zalo integration available as a plugin. Status: **Experimental** (DMs only, groups coming soon)

## � Lấy CLAUDE_AI_SESSION_KEY (OAuth Mode)

### Bước 1: Đăng nhập Claude.ai
1. Truy cập: **https://claude.ai**
2. Đăng nhập với Google/Email account

### Bước 2: Lấy Session Key từ Browser
1. Mở Developer Tools (F12)
2. Chọn tab **Application** → **Cookies** → **https://claude.ai**
3. Tìm cookie có tên: `__Secure-next-auth.session-token`
4. Copy giá trị của cookie này

### Bước 3: Cập nhật Secret
```bash
# Edit secret file
vim k8s/secret.yaml

# Thêm key (KHÔNG có prefix "sk-ant-")
CLAUDE_AI_SESSION_KEY: "eyJhbGciOiJkaXIi..."
```

> **Lưu ý**: Session key sẽ expire sau 30 ngày, cần refresh định kỳ.

---

## �📋 Setup Zalo Steps

### 1. Get Zalo Bot Token

1. Truy cập: **https://bot.zaloplatforms.com**
2. Đăng nhập với Zalo account
3. Tạo bot mới và configure
4. Copy bot token (format: `12345689:abc-xyz`)

### 2. Update Secret File

```bash
vim k8s/secret.yaml

# Thêm Zalo token
ZALO_BOT_TOKEN: "12345689:abc-xyz"
```

### 3. ConfigMap Configuration

File `k8s/configmap.yaml` đã có config:

```json
"zalo": {
  "enabled": true,
  "dmPolicy": "open",
  "allowFrom": ["*"],
  "mediaMaxMb": 5
}
```

**DM Policy Options:**
- `"open"` - Cho phép tất cả mọi người (recommended cho testing)
- `"pairing"` - Yêu cầu pairing code approval (production)
- `"allowlist"` - Chỉ users trong allowFrom list

### 4. Deploy và Enable Zalo Plugin

```bash
# Deploy lên K8s
./k8s/deploy.sh

# Enable Zalo plugin
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo

# Restart gateway
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1

# Verify (sau 30s)
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status
```

Expected output:
```
- Zalo default: enabled, configured, mode:polling, token:env
```

---

## 🔧 Configuration Options

### DM Policy Options

```json
{
  "dmPolicy": "open"       // Anyone can message (set allowFrom: ["*"])
  // OR "pairing"          // Default - require pairing approval  
  // OR "allowlist"        // Only users in allowFrom
  // OR "disabled"         // No DMs allowed
}
```

### Allow Specific Users

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["0fc808c0d7893ed76798", "0b59340e0d46e418bd57"]  // Zalo user IDs
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

---

## ✨ Features

| Feature | Status |
|---------|--------|
| Direct messages | ✅ Supported |
| Groups | ❌ Coming soon |
| Images | ✅ Supported (5MB limit) |
| Text | ✅ 2000 char chunks |
| Stickers | ⚠️ Logged only |
| Streaming | ❌ Disabled (char limit) |

---

## 🚀 Quick Deployment Workflow

Sử dụng workflow tự động:
```
/deploy-k8s-vnpay
```

Hoặc manual:
```bash
# 1. Build và push image
./k8s/build-push-script.sh

# 2. Deploy
./k8s/deploy.sh

# 3. Enable Zalo plugin
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo

# 4. Restart gateway
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1

# 5. Verify
sleep 30
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status
```

---

## 🐛 Troubleshooting

### Zalo không xuất hiện trong channels

```bash
# Check if plugin is enabled
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins list

# Re-enable plugin
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1
```

### Bot không phản hồi

```bash
# Check channel status
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status

# Check logs
kubectl logs -n clawdbot -l app=clawdbot --tail=50 | grep -i zalo

# Verify token
kubectl get secret clawdbot-secrets -n clawdbot -o jsonpath='{.data.ZALO_BOT_TOKEN}' | base64 -d
```

### Yêu cầu pairing code nhưng không có CLI support

Zalo plugin không hỗ trợ `pairing approve` qua CLI. Thay vào đó:
1. Đổi `dmPolicy` thành `"open"` hoặc `"allowlist"`
2. Thêm user ID vào `allowFrom` nếu dùng allowlist

```bash
# Edit configmap
vim k8s/configmap.yaml
# Đổi dmPolicy thành "open" và allowFrom: ["*"]

# Apply và restart
kubectl apply -f k8s/configmap.yaml
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1
```

---

## 📝 Quick Reference Commands

```bash
# Check channel status
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts channels status

# List plugins
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins list

# Enable Zalo plugin
kubectl exec deployment/clawdbot-gateway -n clawdbot -- tsx src/entry.ts plugins enable zalo

# View logs
kubectl logs -n clawdbot -l app=clawdbot --tail=50

# Restart gateway (without running init containers)
kubectl exec deployment/clawdbot-gateway -n clawdbot -- kill 1

# Force full restart (runs init containers, loses plugin state)
kubectl delete pod -n clawdbot -l app=clawdbot
```

---

## ⚠️ Lưu Ý Quan Trọng

1. **Plugin không persist qua pod deletion**: Khi pod bị delete (không phải restart), bạn cần chạy lại `plugins enable zalo`

2. **Session key expiry**: `CLAUDE_AI_SESSION_KEY` expire sau ~30 ngày, cần refresh

3. **Zalo pairing**: CLI không hỗ trợ `pairing approve` cho Zalo, dùng `dmPolicy: "open"` hoặc `"allowlist"`

4. **Webhook vs Polling**: Default là polling mode, webhook cần configure thêm

---

**Ready!** Just add your tokens to `secret.yaml` and run `/deploy-k8s-vnpay`! 🚀
