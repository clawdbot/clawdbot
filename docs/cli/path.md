---
summary: "CLI reference for `openclaw path` (inspect and edit workspace files via the `oc://` addressing scheme)"
read_when:
  - You want to read or write a leaf inside a workspace file from the terminal
  - You're scripting against workspace state and want a stable, kind-agnostic addressing scheme
  - You're debugging a `oc://` path (validate the syntax, see what it resolves to)
title: "Path"
---

# `openclaw path`

Shell-level access to the `oc://` addressing substrate — one universal,
kind-dispatched path scheme for inspecting and surgically editing workspace
files (markdown, jsonc, jsonl, yaml). Self-hosters and editor extensions use
it to read or write a single leaf inside a workspace file without scripting
against the SDK directly.

## Subcommands

| Subcommand              | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `resolve <oc-path>`     | Print the match at the path (or "not found").                                |
| `find <pattern>`        | Enumerate matches for a wildcard / predicate path.                           |
| `set <oc-path> <value>` | Write a leaf at the path. Supports `--dry-run`.                              |
| `validate <oc-path>`    | Parse-only — print structural breakdown (file / section / item / field).     |
| `emit <file>`           | Round-trip a file through `parseXxx` + `emitXxx` (byte-fidelity diagnostic). |

## Global flags

| Flag            | Purpose                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `--cwd <dir>`   | Resolve the file slot against this directory (default: `process.cwd()`). |
| `--file <path>` | Override the file slot's resolved path (absolute access).                |
| `--json`        | Force JSON output (default when stdout is not a TTY).                    |
| `--human`       | Force human output (default when stdout is a TTY).                       |
| `--dry-run`     | (only on `set`) print the bytes that would be written without writing.   |

## `oc://` syntax

```
oc://FILE/SECTION/ITEM/FIELD?session=SCOPE
```

Slot rules — `field` requires `item`, `item` requires `section`. Across all
four slots:

- **Quoted segments** — `"a/b.c"` survives `/` and `.` separators.
  `"\\"` and `"\""` are the only escapes inside quotes.
  The file slot is also quote-aware: `oc://"skills/email-drafter"/Tools/-1`
  treats `skills/email-drafter` as a single file path.
- **Predicates** — `[k=v]`, `[k!=v]`, `[k*=v]`, `[k^=v]`, `[k$=v]`,
  `[k<v]`, `[k<=v]`, `[k>v]`, `[k>=v]`.
- **Unions** — `{a,b,c}` matches any of the alternatives.
- **Wildcards** — `*` (single sub-segment) and `**` (zero-or-more,
  recursive). `find` accepts these; `resolve` and `set` reject them as
  ambiguous.
- **Positional** — `$first`, `$last`, `-N` (Nth from end).
- **Ordinal** — `#N` for Nth match.
- **Insertion markers** — `+`, `+key`, `+nnn` for keyed / indexed
  insertion (use with `set`).
- **Session scope** — `?session=cron:daily` etc. Orthogonal to slot
  nesting.

Reserved characters (`?`, `&`, `%`) outside quoted, predicate, or union
segments are rejected. Control characters (U+0000–U+001F, U+007F) are
rejected anywhere.

## Examples

```bash
# Validate a path (no filesystem access)
openclaw path validate 'oc://AGENTS.md/Tools/-1/risk'

# Read a leaf
openclaw path resolve 'oc://gateway.jsonc/version'

# Wildcard search
openclaw path find 'oc://session.jsonl/*/event' --file ./logs/session.jsonl

# Dry-run a write
openclaw path set 'oc://gateway.jsonc/version' '2.0' --dry-run

# Apply the write
openclaw path set 'oc://gateway.jsonc/version' '2.0'

# Byte-fidelity round-trip (diagnostic)
openclaw path emit ./AGENTS.md
```

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Success. (`resolve` / `find`: at least one match. `set`: write succeeded.) |
| `1`  | No match, or `set` rejected by the substrate (no system-level error).      |
| `2`  | Argument or parse error.                                                   |

## Output mode

`openclaw path` is TTY-aware: human-readable output on a terminal, JSON when
stdout is piped or redirected. `--json` and `--human` override the
auto-detection.

## Notes

- `set` writes raw bytes through the substrate's emit path, which applies the
  redaction-sentinel guard automatically. A leaf carrying
  `__OPENCLAW_REDACTED__` (verbatim or as a substring) is refused at write
  time.
- `set` on a JSONC file currently re-renders the file (drops comments and
  trailing-comma formatting) when it mutates a leaf. Read-path round-trip is
  byte-identical. A byte-splice editor that preserves comments through
  writes is planned as a follow-up.
- `path` does not know about LKG. If the file is LKG-tracked, the next
  observe call decides whether to promote / recover. `set --batch` for
  atomic multi-set through the LKG promote/recover lifecycle is planned
  alongside the LKG-recovery substrate.

## Related

- [CLI reference](/cli)
