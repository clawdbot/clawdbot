# @clawdbot/lark

Feishu / Lark channel plugin for Clawdbot.

## Configuration

Add the following to your `clawdbot.config.yaml`:

```yaml
channels:
  lark:
    enabled: true
    appId: "cli_..."
    appSecret: "..."
    encryptKey: "..." # Optional
    verificationToken: "..." # Optional
    baseUrl: "https://open.feishu.cn" # Optional, default
    webhook:
      port: 3000
      path: "/lark/webhook"
```

## Setup

1. Create an app on [Feishu Open Platform](https://open.feishu.cn/app).
2. Get App ID and App Secret.
3. Enable "Bot" capabilities.
4. Set up "Event Subscriptions":
   - Request URL: `https://your-gateway.com/lark/webhook` (must match `webhook.path` and external URL).
   - Enable `im.message.receive_v1` event.
5. (Optional) Enable "Encrypt Key".

## Development

Run `pnpm build` to compile.
