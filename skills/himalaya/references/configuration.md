# Himalaya Configuration Reference

Configuration file location: `~/.config/himalaya/config.toml`

> **Compatibility:** This guide follows the Himalaya v2.1+ config schema. Check
> `himalaya --version` before applying examples from older guides.

## Minimal IMAP + SMTP Setup

```toml
[accounts.default]
email = "user@example.com"
display-name = "Your Name"
default = true

# IMAP backend for reading emails
imap.server = "imaps://imap.example.com:993"
imap.sasl.plain.username = "user@example.com"
imap.sasl.plain.password.raw = "your-password"

# SMTP backend for sending emails
smtp.server = "smtp://smtp.example.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "user@example.com"
smtp.sasl.plain.password.raw = "your-password"
```

**Schema notes (v2.1+):** `imap.server` and `smtp.server` use protocol URLs;
`imaps://` and `smtps://` enable implicit TLS, while `imap://` and `smtp://`
can use STARTTLS. Authentication is configured under the protocol-specific
SASL tables.

## Password Options

### Raw password (testing only, not recommended)

```toml
imap.sasl.plain.password.raw = "your-password"
smtp.sasl.plain.password.raw = "your-password"
```

### Password from command (recommended)

```toml
imap.sasl.plain.password.command = "pass show email/imap"
smtp.sasl.plain.password.command = "pass show email/smtp"
# imap.sasl.plain.password.command = "security find-generic-password -a user@example.com -s imap -w"
```

Himalaya v2 reads command output for credentials; use a password manager or
keyring CLI rather than putting secrets in the TOML file.

## Gmail Configuration

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.plain.username = "you@gmail.com"
imap.sasl.plain.password.command = "pass show google/app-password"

smtp.server = "smtp://smtp.gmail.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "you@gmail.com"
smtp.sasl.plain.password.command = "pass show google/app-password"
```

**Note:** Gmail requires an App Password if 2FA is enabled.

## iCloud Configuration

```toml
[accounts.icloud]
email = "you@icloud.com"
display-name = "Your Name"

imap.server = "imaps://imap.mail.me.com:993"
imap.sasl.plain.username = "you@icloud.com"
imap.sasl.plain.password.command = "pass show icloud/app-password"

smtp.server = "smtp://smtp.mail.me.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "you@icloud.com"
smtp.sasl.plain.password.command = "pass show icloud/app-password"
```

**Note:** Generate an app-specific password at appleid.apple.com

## Folder Aliases

Map custom folder names:

```toml
[accounts.default]
mailbox.alias.inbox = "INBOX"
mailbox.alias.sent = "Sent"
mailbox.alias.drafts = "Drafts"
mailbox.alias.trash = "Trash"
```

## Multiple Accounts

```toml
[accounts.personal]
email = "personal@example.com"
default = true
# ... backend config ...

[accounts.work]
email = "work@company.com"
# ... backend config ...
```

Switch accounts with `--account`:

```bash
himalaya --account work envelope list
```

## OAuth2 / token authentication

```toml
[accounts.gmail-oauth]
email = "you@gmail.com"

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.xoauth2.username = "you@gmail.com"
imap.sasl.xoauth2.token.command = ["pass", "show", "gmail/xoauth2-token"]

smtp.server = "smtp://smtp.gmail.com:587"
smtp.starttls = true
smtp.sasl.xoauth2.username = "you@gmail.com"
smtp.sasl.xoauth2.token.command = ["pass", "show", "gmail/xoauth2-token"]
```

Himalaya v2 does not manage OAuth flows or refresh tokens. Use a token broker
or password manager command and provide the resulting token through the
protocol-specific SASL table.

## Additional Options

### Signature

```toml
[accounts.default]
signature = "Best regards,\nYour Name"
signature-delim = "-- \n"
```

### Downloads directory

```toml
[accounts.default]
downloads-dir = "~/Downloads/himalaya"
```

### Editor for composing

Set via environment variable:

```bash
export EDITOR="vim"
```

## Troubleshooting

If `himalaya account check` reports `No backend matching \`auto\` is
configured`, first check the version and schema. Himalaya v2.1+ expects
protocol-specific `imap.server`, `smtp.server`, and SASL keys; the older
nested backend and message.send.backend keys can parse as TOML without
configuring a usable backend.
