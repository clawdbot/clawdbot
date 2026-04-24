---
summary: "CLI reference for `openclaw docs` (search the live docs index)"
read_when:
  - You want to search the live OpenClaw docs from the terminal
title: "Docs"
---

# `openclaw docs`

Search the live docs index.

Arguments:

- `[query...]`: search terms to send to the live docs index

Examples:

```bash
openclaw docs
openclaw docs browser existing-session
openclaw docs sandbox allowHostControl
openclaw docs gateway token secretref
```

Notes:

- With no query, `openclaw docs` opens the live docs search entrypoint.
- Multi-word queries are passed through as one search request.

## Related

- [CLI reference](/cli)
