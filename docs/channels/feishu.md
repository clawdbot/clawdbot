---
summary: "Feishu (Lark) bot support status, capabilities, and configuration"
read_when:
  - Working on Feishu channel features
---
# Feishu (Lark)

Status: beta; inbound via WebSocket using `@larksuiteoapi/node-sdk`.

## Quick setup
1) Create a Feishu/Lark app and enable the IM message receive event.
2) Subscribe to `im.message.receive_v1` in your app settings.
3) Configure `channels.feishu.appId` and `channels.feishu.appSecret`.
4) Start the gateway.

Minimal config:
```json5
{
  channels: {
    feishu: {
      enabled: true,
      appId: "YOUR_APP_ID",
      appSecret: "YOUR_APP_SECRET"
    }
  }
}
```

Multi-account example:
```json5
{
  channels: {
    feishu: {
      accounts: {
        work: { appId: "APP_ID", appSecret: "APP_SECRET" },
        personal: { appId: "APP_ID", appSecret: "APP_SECRET" }
      }
    }
  }
}
```

## How it works
- Messages are received over the Feishu WebSocket event stream.
- Replies are sent back to the same `chat_id`.
- DMs use pairing by default (`channels.feishu.dm.policy`).
- Group chats can be restricted with `channels.feishu.groupPolicy` and `channels.feishu.groups`.

## Target formats
- `chat:<chat_id>` for group chats.
- `user:<open_id>` for direct messages.

## Configuration reference (Feishu)
- `channels.feishu.appId`: Feishu App ID.
- `channels.feishu.appSecret`: Feishu App Secret.
- `channels.feishu.dm.policy`: DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- `channels.feishu.dm.allowFrom`: allowlist for DMs when policy is `allowlist` or `open`.
- `channels.feishu.groupPolicy`: `open`, `allowlist`, or `disabled`.
- `channels.feishu.groups`: per-chat overrides keyed by `chat_id` (supports `requireMention`, `tools`, `users`).
