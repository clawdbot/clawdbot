---
name: bitwarden
description: Manage passwords and credentials via Bitwarden CLI (bw). Use for storing, retrieving, creating, or updating logins, credit cards, secure notes, and identities. Trigger when automating authentication, filling payment forms, or managing secrets programmatically.
---

# Bitwarden CLI

Full read/write vault access via `bw` command.

## Prerequisites

```bash
brew install bitwarden-cli
bw login <email>  # one-time, prompts for master password
```

## Session Management

Bitwarden requires an unlocked session. Use the helper script:

```bash
source scripts/bw-session.sh <master_password>
# Sets BW_SESSION env var
```

Or manually:
```bash
export BW_SESSION=$(echo '<password>' | bw unlock --raw)
bw sync  # always sync after unlock
```

## Common Operations

### Retrieve credentials
```bash
bw get password "Site Name"
bw get username "Site Name"
bw get item "Site Name" --pretty | jq '.login'
```

### Create login
```bash
bw get template item | jq '
  .type = 1 |
  .name = "Site Name" |
  .login.username = "user@email.com" |
  .login.password = "secret123" |
  .login.uris = [{uri: "https://example.com"}]
' | bw encode | bw create item
```

### Create credit card
```bash
bw get template item | jq '
  .type = 3 |
  .name = "Card Name" |
  .card.cardholderName = "John Doe" |
  .card.brand = "Visa" |
  .card.number = "4111111111111111" |
  .card.expMonth = "12" |
  .card.expYear = "2030" |
  .card.code = "123"
' | bw encode | bw create item
```

### Get card for payment automation
```bash
bw get item "Card Name" | jq -r '.card | "\(.number) \(.expMonth)/\(.expYear) \(.code)"'
```

### List items
```bash
bw list items | jq -r '.[] | "\(.type)|\(.name)"'
# Types: 1=login, 2=note, 3=card, 4=identity
```

### Search
```bash
bw list items --search "vilaviniteca" | jq '.[0]'
```

## Item Types

| Type | Value | Use |
|------|-------|-----|
| Login | 1 | Website credentials |
| Secure Note | 2 | Freeform text |
| Card | 3 | Credit/debit cards |
| Identity | 4 | Personal info |

## References

- [templates.md](references/templates.md) — Full jq templates for all item types
- [Bitwarden CLI docs](https://bitwarden.com/help/cli/)

## Tips

1. **Always sync** after creating/editing items: `bw sync`
2. **Session expires** — re-unlock if you get auth errors
3. **Delete sensitive messages** after receiving credentials
4. **Card numbers** may not import from other managers (security restriction)
