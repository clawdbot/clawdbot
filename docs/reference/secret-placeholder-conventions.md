---
summary: "Secret-scanner-safe placeholder conventions for docs and examples"
read_when:
  - Writing docs that include tokens, API keys, or credential snippets
  - Updating examples that may be scanned by secret-detection tooling
title: "Secret Placeholder Conventions"
---

# Secret placeholder conventions

Use placeholders that are human-readable but do not resemble real secrets.

## Recommended style

- Prefer descriptive values like `example-openai-key-not-real` or `example-discord-bot-token`.
- For shell snippets, prefer `${OPENAI_API_KEY}` over inline token-like strings.
- Keep examples obviously fake and scoped to purpose (provider, channel, auth type).

## Avoid these patterns in docs

- Literal PEM private-key header or footer text.
- Prefixes that resemble live credentials, e.g. `sk-...`, `xoxb-...`, `AKIA...`.
- Realistic-looking bearer tokens copied from runtime logs.

## Example

```bash
# Good
export OPENAI_API_KEY="example-openai-key-not-real"

# Better (when the doc is about env wiring)
export OPENAI_API_KEY="${OPENAI_API_KEY}"
```
