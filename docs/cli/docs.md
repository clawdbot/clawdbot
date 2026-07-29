---
summary: "CLI reference for `openclaw docs` (search the live docs index)"
read_when:
  - You want to search the live OpenClaw docs from the terminal
  - You need to know which hosted search API the docs CLI calls
title: "Docs"
---

# `openclaw docs`

Search the live OpenClaw docs index from the terminal.

## Usage

```bash
openclaw docs                       # print docs entrypoint and example search
openclaw docs <query...>            # search the live docs index
```

| Argument     | Description                                                                        |
| ------------ | ---------------------------------------------------------------------------------- |
| `[query...]` | Free-form search query. Multi-word queries are joined with spaces and sent as one. |

With no query, `openclaw docs` prints the docs entrypoint URL and a sample search command instead of running a search.

## Examples

```bash
openclaw docs browser existing-session
openclaw docs sandbox allowHostControl
openclaw docs gateway token secretref
```

## How it works

`openclaw docs` calls `https://docs.openclaw.ai/api/search` and renders the JSON results. The search request uses a fixed 30 second timeout.

## Output

In a rich (TTY) terminal, results render as a heading followed by a bullet list: page title, linked docs URL, and a short snippet on the next line. Empty results print "No results.".

In non-rich output (piped, `--no-color`, scripts), the same data renders as Markdown:

```markdown
# Docs search: <query>

- [Title](https://docs.openclaw.ai/...) - snippet
- [Title](https://docs.openclaw.ai/...) - snippet
```

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Search succeeded, including zero-result responses.                       |
| `1`  | The hosted docs search API call failed; stderr prints the error message. |

## Related

- [CLI reference](/cli)
- [Live docs](https://docs.openclaw.ai)
