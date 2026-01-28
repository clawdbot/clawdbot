# Bitwarden Item Templates

jq patterns for creating vault items via CLI.

## Login (type=1)

```bash
bw get template item | jq '
  .type = 1 |
  .name = "Example Site" |
  .notes = "Optional notes" |
  .favorite = false |
  .login.username = "user@example.com" |
  .login.password = "secretPassword123" |
  .login.totp = "otpauth://totp/..." |
  .login.uris = [
    {uri: "https://example.com", match: null},
    {uri: "https://app.example.com", match: null}
  ]
' | bw encode | bw create item
```

## Credit Card (type=3)

```bash
bw get template item | jq '
  .type = 3 |
  .name = "Visa ending 1234" |
  .notes = "Primary card" |
  .card.cardholderName = "JOHN DOE" |
  .card.brand = "Visa" |
  .card.number = "4111111111111111" |
  .card.expMonth = "12" |
  .card.expYear = "2030" |
  .card.code = "123"
' | bw encode | bw create item
```

**Brands:** Visa, Mastercard, Amex, Discover, Diners Club, JCB, Maestro, UnionPay, Other

## Secure Note (type=2)

```bash
bw get template item | jq '
  .type = 2 |
  .name = "API Keys" |
  .notes = "OPENAI_KEY=sk-xxx\nANTHROPIC_KEY=sk-ant-xxx" |
  .secureNote.type = 0
' | bw encode | bw create item
```

## Identity (type=4)

```bash
bw get template item | jq '
  .type = 4 |
  .name = "Personal Info" |
  .identity.title = "Mr" |
  .identity.firstName = "John" |
  .identity.lastName = "Doe" |
  .identity.email = "john@example.com" |
  .identity.phone = "+34612345678" |
  .identity.address1 = "123 Main St" |
  .identity.city = "Barcelona" |
  .identity.state = "Catalunya" |
  .identity.postalCode = "08001" |
  .identity.country = "ES"
' | bw encode | bw create item
```

## Edit Existing Item

```bash
# Get item, modify, update
bw get item <id> | jq '.login.password = "newPassword"' | bw encode | bw edit item <id>
```

## Custom Fields

```bash
bw get template item | jq '
  .type = 1 |
  .name = "With Custom Fields" |
  .fields = [
    {name: "Security Question", value: "Pet name", type: 0},
    {name: "PIN", value: "1234", type: 1}
  ]
' | bw encode | bw create item
```

**Field types:** 0=text, 1=hidden, 2=boolean

## Retrieve Patterns

```bash
# Password only
bw get password "Site Name"

# Username only  
bw get username "Site Name"

# Full login object
bw get item "Site Name" | jq '.login'

# Card number
bw get item "Card Name" | jq -r '.card.number'

# All card fields for form filling
bw get item "Card Name" | jq -r '.card | [.number, .expMonth, .expYear, .code] | @tsv'

# Search by URL
bw list items --url "example.com" | jq '.[0].login'

# List all cards
bw list items | jq '.[] | select(.type == 3) | .name'
```
