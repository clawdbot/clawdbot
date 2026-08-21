---
name: himalaya
description: "Himalaya CLI for IMAP/SMTP mail: list, read, search, compose, reply, forward, copy, move, delete."
homepage: https://github.com/pimalaya/himalaya
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires": { "bins": ["himalaya"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "himalaya",
              "bins": ["himalaya"],
              "label": "Install Himalaya (brew)",
            },
          ],
      },
  }
---

# Himalaya

Use `himalaya` for IMAP/SMTP email from shell.

## References

- `references/configuration.md`: account config, auth, backend setup.
- `references/message-composition.md`: MML compose syntax.

## Setup

```bash
himalaya --version
himalaya configure
```

Config path: `~/.config/himalaya/config.toml`.

Prefer password managers/keyrings for credentials; do not paste secrets into chat/logs.

## Read/search

```bash
himalaya mailbox list
himalaya envelope list
himalaya message read <id>
himalaya envelope search "from alice and subject invoice"
```

`envelope list` takes no query; all filtering goes through `envelope search`
(pass the whole query as one argument). `--json` is the global flag for
machine-readable output.

## Write

```bash
himalaya message write
himalaya message send < /tmp/message.eml
himalaya message reply <id>
himalaya message forward <id>
```

Use MML for attachments and rich messages; read `references/message-composition.md` first.

## Organize

```bash
himalaya message copy --to <folder> <id>
himalaya message move --to <folder> <id>
himalaya message delete <id>
himalaya flag add <id> --flag seen
himalaya flag remove <id> --flag seen
```

`--to` is mandatory on copy/move; `--from` is optional and defaults to the
inbox alias. To dump a message's raw RFC 5322 bytes (full headers), use
`himalaya message read --raw <id>`.

## Safety

- Confirm before sending, deleting, or moving many messages.
- Use `--account` when multiple accounts exist.
- Quote exact message IDs in summaries.
