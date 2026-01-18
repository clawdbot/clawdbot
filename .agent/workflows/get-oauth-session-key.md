---
description: Get Claude AI Session Key via OAuth for Clawdbot authentication
---

# Get Claude AI Session Key (OAuth Mode)

This workflow helps you obtain the CLAUDE_AI_SESSION_KEY needed for Clawdbot authentication.

## Why OAuth Mode?

- **No API costs**: Uses your Claude Pro/Team subscription
- **No credit limits**: No "credit balance too low" errors
- **Full features**: Access to Claude's latest models

---

## Quick Method (Recommended)

Sử dụng Claude Code CLI để lấy OAuth token tự động.

### Step 1: Login via Claude Code

```bash
claude login
```

Hoặc trong Claude Code session, chạy `/login`.

### Step 2: Sync Credentials to K8s

```bash
bash .agent/sync-claude-credentials/scripts/sync.sh
```

Script sẽ tự động:
- Đọc credentials từ `~/.claude/.credentials.json`
- Cập nhật `CLAUDE_AI_SESSION_KEY` trong `k8s/secret.yaml`

> **Note**: Token format là `sk-ant-oat01-...` (OAuth access token), khác với browser cookie `eyJ...`

### Step 3: Apply và Restart

```bash
kubectl apply -f k8s/secret.yaml && kubectl delete pod -n clawdbot -l app=clawdbot
```

Done! Skip to **Step 7** để verify.

---

## Manual Method (Browser)

Sử dụng nếu `claude login` không hoạt động.

> **Note**: Browser cookie có format `eyJ...` (JWT), khác với OAuth token `sk-ant-oat01-...`

## Step 1: Login to Claude.ai

1. Open browser and go to: **https://claude.ai**
2. Login with your Google/Email account
3. Ensure you have an active Claude Pro or Team subscription

## Step 2: Open Developer Tools

1. Press **F12** or right-click → "Inspect"
2. Select the **Application** tab (Chrome/Edge) or **Storage** tab (Firefox)
3. In the left sidebar, expand **Cookies**
4. Click on **https://claude.ai**

## Step 3: Find Session Token

1. Look for cookie named: `__Secure-next-auth.session-token`
2. Click on it to see the full value
3. **Copy the entire value** (it starts with `eyJ...`)

> **Tip**: The value is very long (1000+ characters). Make sure to copy the entire string.

## Step 4: Update Secret

```bash
vim /home/duhd/clawdbot/k8s/secret.yaml
```

Find and update:
```yaml
CLAUDE_AI_SESSION_KEY: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..."
```

> **Important**: 
> - Do NOT include quotes inside the value
> - Do NOT add "sk-ant-" prefix
> - The key should start with "eyJ"

// turbo
## Step 5: Apply Secret

```bash
kubectl apply -f /home/duhd/clawdbot/k8s/secret.yaml
```

// turbo
## Step 6: Restart Gateway

```bash
kubectl delete pod -n clawdbot -l app=clawdbot
```

// turbo
## Step 7: Verify Authentication

```bash
sleep 45 && kubectl logs -n clawdbot -l app=clawdbot --tail=20 | grep -i "auth\|oauth\|session"
```

## Troubleshooting

### "OAuth session expired" Error

Session keys expire after ~30 days. Repeat steps 1-6 to get a new key.

### "Authentication failed" Error

1. Verify you copied the complete cookie value
2. Check cookie is from `__Secure-next-auth.session-token`, not other cookies
3. Ensure you're logged into Claude.ai with an active subscription

### Check Current Auth Profile

```bash
kubectl exec deployment/clawdbot-gateway -n clawdbot -- cat /home/node/.clawdbot/agents/main/agent/auth-profiles.json
```

Should show:
```json
{
  "profiles": {
    "anthropic:oauth-session": {
      "provider": "anthropic",
      "mode": "oauth"
    }
  }
}
```

## Session Key Refresh Schedule

Create a reminder to refresh your session key:
- **Recommended**: Every 2-3 weeks
- **Maximum**: 30 days before expiry

## Alternative: Use Anthropic API Key

If you prefer using API key instead of OAuth:

1. Get API key from: https://console.anthropic.com
2. Update `k8s/secret.yaml`:
   ```yaml
   ANTHROPIC_API_KEY: "sk-ant-api03-..."
   ```
3. Remove or comment out `CLAUDE_AI_SESSION_KEY`
4. Redeploy

> **Note**: API key requires billing credits on Anthropic account.