---
name: imsg
description: "iMessage/SMS CLI for listing chats, history, and sending messages via Messages.app."
homepage: https://imsg.to
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "os": ["darwin"],
        "requires": { "bins": ["imsg"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/imsg",
              "bins": ["imsg"],
              "label": "Install imsg (brew)",
            },
          ],
      },
  }
---

# imsg

Use `imsg` to read and send iMessage/SMS via macOS Messages.app.

## When to Use

Use when:

- User explicitly asks to send iMessage or SMS
- Reading iMessage conversation history
- Checking recent Messages.app chats
- Sending to phone numbers or Apple IDs

## When NOT to Use

Do not use when:

- Telegram messages -> use `message` tool with `channel:telegram`
- Signal messages -> use Signal channel if configured
- WhatsApp messages -> use WhatsApp channel if configured
- Discord messages -> use `message` tool with `channel:discord`
- Slack messages -> use `slack` skill
- Group chat management (adding/removing members) -> not supported
- Bulk/mass messaging -> always confirm with user first
- Replying in current conversation -> just reply normally (OpenClaw routes automatically)

## Requirements

- macOS with Messages.app signed in
- Full Disk Access for terminal
- Automation permission for Messages.app (for sending)

## Common Commands

### List Chats

```bash
imsg chats --limit 10 --json
```

### View History

```bash
# By chat ID
imsg history --chat-id 1 --limit 20 --json

# With attachments info
imsg history --chat-id 1 --limit 20 --attachments --json
```

### Watch for New Messages

```bash
imsg watch --chat-id 1 --attachments
```

### Send Messages

```bash
# Text only
imsg send --to "+14155551212" --text "Hello!"

# With attachment
imsg send --to "+14155551212" --text "Check this out" --file /path/to/image.jpg

# Specify service
imsg send --to "+14155551212" --text "Hi" --service imessage
imsg send --to "+14155551212" --text "Hi" --service sms
```

## Service Options

- `--service imessage` - Force iMessage (requires recipient has iMessage)
- `--service sms` - Force SMS (green bubble)
- `--service auto` - Let Messages.app decide (default)

## Safety Rules

1. **Always confirm recipient and message content** before sending
2. **Never send to unknown numbers** without explicit user approval
3. **Be careful with attachments** - confirm file path exists
4. **Rate limit yourself** - don't spam

## Example Workflow

User: "Text mom that I'll be late"

```bash
# 1. Find mom's chat
imsg chats --limit 20 --json | jq '.[] | select(.displayName | contains("Mom"))'

# 2. Confirm with user
# "Found Mom at +1555123456. Send 'I'll be late' via iMessage?"

# 3. Send after confirmation
imsg send --to "+1555123456" --text "I'll be late"
```
