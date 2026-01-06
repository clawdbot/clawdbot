---
summary: "iMessage support via imsg (JSON-RPC over stdio), setup, and chat_id routing"
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
---
# iMessage (imsg)

Status: external CLI integration. No daemon.

## Model
- Clawdbot spawns `imsg rpc` as a child process.
- JSON-RPC runs over stdin/stdout (one JSON object per line).
- Gateway owns the process; no TCP port needed.

## Requirements
- macOS with Messages signed in.
- Full Disk Access for Clawdbot + the `imsg` binary (Messages DB access).
- Automation permission for Messages when sending.

## Config

```json5
{
  imessage: {
    enabled: true,
    cliPath: "imsg",
    dbPath: "~/Library/Messages/chat.db",
    dmPolicy: "pairing", // pairing | allowlist | open | disabled
    allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
    groupPolicy: "open",
    groupAllowFrom: ["chat_id:123"],
    includeAttachments: false,
    mediaMaxMb: 16,
    service: "auto",
    region: "US"
  }
}
```

Notes:
- `allowFrom` accepts handles (phone/email) or `chat_id:<id>` entries.
- Default: `imessage.dmPolicy="pairing"` — unknown DM senders get a pairing code (approve via `clawdbot pairing approve --provider imessage <code>`). `"open"` requires `allowFrom=["*"]`.
- `groupPolicy` controls group handling (`open|disabled|allowlist`).
- `groupAllowFrom` accepts the same entries as `allowFrom`.
- `service` defaults to `auto` (use `imessage` or `sms` to pin).
- `region` is only used for SMS targeting.

## Addressing / targets

Prefer `chat_id` for stable routing:
- `chat_id:123` (preferred)
- `chat_guid:...` (fallback)
- `chat_identifier:...` (fallback)
- direct handles: `imessage:+1555` / `sms:+1555` / `user@example.com`

List chats:
```
imsg chats --limit 20
```

## Group chat behavior
- Group messages set `ChatType=group`, `GroupSubject`, and `GroupMembers`.
- Group activation respects `imessage.groups."*".requireMention` and `routing.groupChat.mentionPatterns` (patterns are required to detect mentions on iMessage). When `imessage.groups` is set, it also acts as a group allowlist; include `"*"` to allow all groups.
- Replies go back to the same `chat_id` (group or direct).

## Troubleshooting
- `clawdbot gateway call providers.status --params '{"probe":true}'`
- Verify `imsg` is on PATH and has access to Messages DB.
