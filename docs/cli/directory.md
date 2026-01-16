---
summary: "CLI reference for `clawdbot directory` (self, peers, groups)"
read_when:
  - You want to look up contacts/groups/self ids for a channel
  - You are developing a channel directory adapter
---

# `clawdbot directory`

Directory lookups for channels that support it (contacts/peers, groups, and “me”).

## Common flags
- `--channel <name>`: channel id/alias (default: `whatsapp`)
- `--account <id>`: account id (default: channel default)
- `--json`: output JSON

## Self (“me”)

```bash
clawdbot directory self --channel zalouser
```

## Peers (contacts/users)

```bash
clawdbot directory peers list --channel zalouser
clawdbot directory peers list --channel zalouser --query "name"
clawdbot directory peers list --channel zalouser --limit 50
```

## Groups

```bash
clawdbot directory groups list --channel zalouser
clawdbot directory groups list --channel zalouser --query "work"
clawdbot directory groups members --channel zalouser --group-id <id>
```

