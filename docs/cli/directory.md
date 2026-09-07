---
summary: "CLI reference for `openclaw directory` (self, peers, groups)"
read_when:
  - You want to look up contacts/groups/self ids for a channel
  - You are developing a channel directory adapter
title: "Directory"
---

# `openclaw directory`

Directory lookups for channels that support them: contacts/peers, groups, and "me" (self).

Results are meant to be pasted into other commands, especially `openclaw message send --target ...`.

## Common flags

- `--channel <name>`: channel id/alias (required when multiple channels are configured; auto-selected when only one is configured)
- `--account <id>`: account id (default: channel default)
- `--json`: output JSON

Default output renders IDs and names in a table. Empty list results name the channel and account
that were queried; JSON list output uses an empty array (`[]`). Failures exit nonzero and use the
canonical `{ "ok": false, "error": { "type": "cli_error", "message": "..." } }` envelope in
JSON mode.

## Notes

- For many channels, results are config-backed (allowlists / configured groups) rather than a live provider directory.
- Before a live lookup, OpenClaw resolves configured SecretRefs only for the selected channel and account. Resolved credentials remain runtime-only; plugin installation and auto-enable writes preserve the authored references without persisting runtime defaults.
- WhatsApp group listing is live. Gateway lookups reuse its owned connection; a standalone command opens the linked session only when no other process owns that account and otherwise reports that live groups are unavailable.
- An already-installed channel plugin can lack directory support. In that case the command reports the unsupported operation; it does not try to reinstall or upgrade the plugin to add support.

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats by channel

| Channel                             | Target id format                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp                            | `+15551234567` (DM), `1234567890-1234567890@g.us` (group), `120363123456789@newsletter` (Channel/Newsletter, outbound only) |
| Signal                              | Configured aliases resolve to E.164/UUID DM targets or `group:<id>` group targets                                           |
| Telegram                            | `@username` or numeric chat id; groups use numeric ids                                                                      |
| Slack                               | `user:U…` and `channel:C…`                                                                                                  |
| Discord                             | `user:<id>` and `channel:<id>`                                                                                              |
| Matrix (plugin)                     | `user:@user:server`, `room:!roomId:server`, or `#alias:server`                                                              |
| Microsoft Teams (plugin)            | `user:<id>` and `conversation:<id>`                                                                                         |
| Zalo (plugin)                       | User id (Bot API)                                                                                                           |
| Zalo Personal / `zalouser` (plugin) | Thread id (DM/group), from `zca` (`me`, `friend list`, `group list`)                                                        |

## Self ("me")

```bash
openclaw directory self --channel zalouser
```

A channel may legitimately return no self identity. This is a successful empty result (exit code
`0`), not a failed lookup. Channels without a self resolver report that the channel does not expose
a self identity, without suggesting account troubleshooting:

```json
{
  "status": "unavailable",
  "channel": "telegram",
  "accountId": "default",
  "reason": "self-identity-unsupported"
}
```

When a channel implements self lookup but returns no identity, the text output names the channel and
account and suggests checking its configuration and authentication. JSON callers can distinguish
that case by its reason:

```json
{
  "status": "unavailable",
  "channel": "msteams",
  "accountId": "default",
  "reason": "plugin-returned-no-self-identity"
}
```

## Peers (contacts/users)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```

## Related

- [CLI reference](/cli)
