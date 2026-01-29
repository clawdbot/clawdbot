# Feishu Extension for Clawdbot

This extension allows Clawdbot to integrate with Feishu (Lark), enabling it to send and receive messages within your Feishu organization.

## Configuration

To use this extension, you need to configure it with credentials from the Feishu Open Platform.

### Prerequisites

1.  A Feishu (Lark) account and an organization.
2.  Access to the [Feishu Open Platform](https://open.feishu.cn/app?lang=en-US).

### Quick Start

You can interactively configure this extension using the CLI:

```bash
pnpm clawdbot channels add feishu
```

This wizard will guide you through entering the required credentials.

### Features

*   **Send & Receive Messages**: Supports sending and receiving **Text** messages in direct chats and group chats.
    *   *Note: Other message types (images, files, etc.) may be displayed as generic placeholders.*
*   **Multi-Account Support**: Configure multiple Feishu bots/accounts.

### Step-by-Step Configuration Guide

1.  **Create a Feishu Application:**
    *   Log in to the [Feishu Open Platform](https://open.feishu.cn/app?lang=en-US).
    *   Create a specific "Enterprise Self-Built App" for your bot.

2.  **Get App Credentials:**
    *   Navigate to **Credentials & Basic Info**.
    *   Copy the **App ID** and **App Secret**. These correspond to `appId` and `appSecret` in the configuration.

3.  **Configure Event Subscriptions:**
    *   Navigate to **Event Subscriptions**.
    *   Set the **Encrypt Key** (Optional, but recommended).
    *   Set the **Verification Token** (Optional).
    *   Set the Request URL to your bot's endpoint (e.g., `https://your-bot-domain.com/api/feishu`).
    *   **Add Events**: Search for and add the following event:
        *   `im.message.receive_v1` (Receive messages)

4.  **Add Permissions:**
    *   Navigate to **Permissions & Scopes**.
    *   Add the necessary permissions:
        *   `im:message` (Access messages)
        *   `im:message:send_as_bot` (Send messages as bot)
        *   `im:chat` (Access group chats)
    *   **Important**: Create and publish a version of your app to apply these permissions.

5.  **Enable Bot Capability:**
    *   Navigate to **App Capabilities** -> **Bot**.
    *   Enable the bot capability.

### Configuration Example

Add the following to your `clawdbot` configuration (e.g., in `clawdbot.config.json` or via environment variables):

```json
{
  "extensions": {
    "feishu": {
      "appId": "cli_...",
      "appSecret": "...",
      "encryptKey": "...",        // Optional: Required if encryption is enabled
      "verificationToken": "..."  // Optional: Required for event verification
    }
  }
}
```

> [!NOTE]
> `encryptKey` and `verificationToken` are **optional** for basic bot functionality (sending messages). However, they are **required** if you want to:
> *   Receive events securely (verify the source).
> *   Have enabled **Encrypt Key** in the Feishu Event Subscriptions settings.

### Multi-Account Configuration

If you need to configure multiple Feishu bots, you can use the accounts structure:

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "appId": "cli_xxx",
          "appSecret": "xxx",
          "encryptKey": "xxx",
          "verificationToken": "xxx"
        },
        "team-bot": {
          "enabled": true,
          "name": "Team Bot",
          "appId": "cli_yyy",
          "appSecret": "yyy",
          "encryptKey": "yyy",
          "verificationToken": "yyy"
        }
      }
    }
  }
}
```

## Troubleshooting

### Bot not receiving messages

1.  **Check Event Subscription URL**: Ensure the Request URL is correctly configured and accessible from Feishu servers.
2.  **Verify Event Subscription**: Make sure `im.message.receive_v1` event is added and the app version is published.
3.  **Check Permissions**: Ensure all required permissions are granted and the app version is published.
4.  **Review Logs**: Check Clawdbot logs for connection errors or event processing issues.

### Authentication errors

1.  **Verify Credentials**: Double-check that `appId` and `appSecret` are correct.
2.  **Check App Status**: Ensure the app is enabled and not suspended in Feishu Open Platform.

### Encryption/Verification errors

1.  **Match Configuration**: Ensure `encryptKey` and `verificationToken` in your config match exactly what's set in Feishu Event Subscriptions.
2.  **Optional Fields**: If you haven't enabled encryption in Feishu, you can leave these fields empty.

## Current Limitations

*   **Message Types**: Currently only **text messages** are fully supported. Other types (images, files, cards) will be displayed as generic placeholders.
*   **Reactions**: Message reactions are not yet supported.
*   **Threads**: Message threads are not yet supported.
*   **Media Upload**: Sending images/files is not yet implemented.

## Resources

*   [Feishu Open Platform Documentation](https://open.feishu.cn/document/home/index)
*   [Feishu Bot Development Guide](https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/create-an-app)

