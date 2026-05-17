---
summary: "CLI reference for `openclaw path` (inspect and edit workspace files via the `oc://` addressing scheme)"
read_when:
  - You want to read or write a leaf inside a workspace file from the terminal
  - You're scripting against workspace state and want a stable, kind-agnostic addressing scheme
  - You're debugging a `oc://` path (validate the syntax, see what it resolves to)
title: "Path"
---

# `openclaw path`

Plugin-provided shell access to the `oc://` addressing substrate: one
kind-dispatched path scheme for inspecting and editing addressable workspace
files (markdown, jsonc, jsonl, yaml/yml/lobster). Self-hosters, plugin
authors, and editor extensions use it to read, find, or update a narrow
location without hand-rolling per-file parsers.

The CLI mirrors the substrate's public verbs:

- `resolve` is concrete and single-match.
- `find` is the multi-match verb for wildcards, unions, predicates, and
  positional expansion.
- `set` only accepts concrete paths or insertion markers; wildcard patterns are
  rejected before writing.

`path` is provided by the bundled optional `oc-path` plugin. Enable it before
first use:

```bash
openclaw plugins enable oc-path
```

## Why use it

OpenClaw state is spread across human-edited markdown, commented JSONC config,
append-only JSONL logs, and YAML workflow/spec files. Shell scripts, hooks,
and agents often need one small value from those files: a frontmatter key, a
plugin setting, a log record field, a YAML step, or a bullet item under a named
section.

`openclaw path` gives those callers a stable address instead of a one-off grep,
regex, or parser for each file kind. The same `oc://` path can be validated,
resolved, searched, dry-run, and written from the terminal, which makes narrow
automation easier to review and safer to replay. It is especially useful when
you want to update one leaf while preserving the rest of the file's comments,
line endings, and surrounding formatting.

Use it when the thing you want has a logical address, but the physical file
shape varies:

- A hook wants to read one setting from commented JSONC without losing comments
  when it writes the value back.
- A maintenance script wants to find every matching event field in a JSONL log
  without loading the whole log into a custom parser.
- An editor extension wants to jump to a markdown section or bullet item by
  slug, then render the exact line it resolved to.
- An agent wants to dry-run a tiny workspace edit before applying it, with the
  changed bytes visible in review.

You probably do not need `openclaw path` for ordinary whole-file edits, rich
config migrations, or memory-specific writes. Those should use the owner
command or plugin. `path` is for small, addressable file operations where a
repeatable terminal command is clearer than another bespoke parser.

## How it is used

Read one value from a human-edited config file:

```bash
openclaw path resolve 'oc://config.jsonc/plugins/github/enabled'
```

Preview a write without touching disk:

```bash
openclaw path set 'oc://config.jsonc/plugins/github/enabled' 'true' --dry-run
```

Find matching records in an append-only JSONL log:

```bash
openclaw path find 'oc://session.jsonl/[event=tool_call]/name'
```

Address an instruction in markdown by section and item instead of by line
number:

```bash
openclaw path resolve 'oc://AGENTS.md/runtime-safety/openclaw-gateway'
```

Validate a path in CI or a preflight script before the script reads or writes:

```bash
openclaw path validate 'oc://AGENTS.md/tools/$last/risk'
```

Those commands are meant to be copyable into shell scripts. Use `--json` when a
caller needs structured output and `--human` when a person is inspecting the
result.

## How it works

`openclaw path` does four things:

1. Parses the `oc://` address into slots: file, section, item, field, and
   optional session.
2. Chooses the file-kind adapter from the target extension (`.md`, `.jsonc`,
   `.jsonl`, `.yaml`, `.yml`, `.lobster`, and related aliases).
3. Resolves the slots against that file kind's AST: markdown headings/items,
   JSONC object keys/array indexes, JSONL line records, or YAML map/sequence
   nodes.
4. For `set`, emits edited bytes through the same adapter so the untouched
   parts of the file keep their comments, line endings, and nearby formatting
   where the kind supports it.

`resolve` and `set` require one concrete target. `find` is the exploratory
verb: it expands wildcards, unions, predicates, and ordinals into the concrete
matches you can inspect before choosing one to write.

## Subcommands

| Subcommand              | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `resolve <oc-path>`     | Print the concrete match at the path (or "not found").                       |
| `find <pattern>`        | Enumerate matches for a wildcard / union / predicate path.                   |
| `set <oc-path> <value>` | Write a leaf or insertion target at a concrete path. Supports `--dry-run`.   |
| `validate <oc-path>`    | Parse-only; print structural breakdown (file / section / item / field).      |
| `emit <file>`           | Round-trip a file through `parseXxx` + `emitXxx` (byte-fidelity diagnostic). |

## Global flags

| Flag            | Purpose                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `--cwd <dir>`   | Resolve the file slot against this directory (default: `process.cwd()`). |
| `--file <path>` | Override the file slot's resolved path (absolute access).                |
| `--json`        | Force JSON output (default when stdout is not a TTY).                    |
| `--human`       | Force human output (default when stdout is a TTY).                       |
| `--dry-run`     | (only on `set`) print the bytes that would be written without writing.   |
| `--diff`        | (with `set --dry-run`) print a unified diff instead of the full bytes.   |

## `oc://` syntax

```
oc://FILE/SECTION/ITEM/FIELD?session=SCOPE
```

Slot rules: `field` requires `item`, and `item` requires `section`. Across all
four slots:

- **Quoted segments** — `"a/b.c"` survives `/` and `.` separators.
  Content is byte-literal; `"` and `\` are not allowed inside quotes.
  The file slot is also quote-aware: `oc://"skills/email-drafter"/Tools/$last`
  treats `skills/email-drafter` as a single file path.
- **Predicates** — `[k=v]`, `[k!=v]`, `[k<v]`, `[k<=v]`, `[k>v]`,
  `[k>=v]`. Numeric ops require both sides to coerce to finite numbers.
- **Unions** — `{a,b,c}` matches any of the alternatives.
- **Wildcards** — `*` (single sub-segment) and `**` (zero-or-more,
  recursive). `find` accepts these; `resolve` and `set` reject them as
  ambiguous.
- **Positional** — `$first` / `$last` resolve to the first / last index or
  declared key.
- **Ordinal** — `#N` for Nth match by document order.
- **Insertion markers** — `+`, `+key`, `+nnn` for keyed / indexed
  insertion (use with `set`).
- **Session scope** — `?session=cron-daily` etc. Orthogonal to slot
  nesting. Session values are raw, not percent-decoded; they may not contain
  control characters or reserved query delimiters (`?`, `&`, `%`).

Reserved characters (`?`, `&`, `%`) outside quoted, predicate, or union
segments are rejected. Control characters (U+0000-U+001F, U+007F) are rejected
anywhere, including the `session` query value.

`formatOcPath(parseOcPath(path)) === path` is guaranteed for canonical paths.
Non-canonical query parameters are ignored except for the first non-empty
`session=` value.

## Addressing by file kind

| Kind              | Addressing model                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Markdown          | H2 sections by slug, bullet items by slug or `#N`, frontmatter via `[frontmatter]`.                 |
| JSONC/JSON        | Object keys and array indexes; dots split nested sub-segments unless quoted.                        |
| JSONL             | Top-level line addresses (`L1`, `L2`, `$first`, `$last`), then JSONC-style descent inside the line. |
| YAML/YML/.lobster | Map keys and sequence indexes; comments and flow style are handled by the YAML document API.        |

`resolve` returns a structured match: `root`, `node`, `leaf`, or
`insertion-point`, with a 1-based line number. Leaf values are surfaced as text
plus a `leafType` so plugin authors can render previews without depending on
the per-kind AST shape.

## Mutation contract

`set` writes one concrete target:

- Markdown frontmatter values and `- key: value` item fields are string leaves.
  Markdown insertions append sections, frontmatter keys, or section items and
  render a canonical markdown shape for the changed file.
- JSONC leaf writes coerce the string value to the existing leaf type
  (`string`, finite `number`, `true`/`false`, or `null`). JSONC object and array
  insertions parse `<value>` as JSON and use the `jsonc-parser` edit path for
  ordinary leaf writes, preserving comments and nearby formatting.
- JSONL leaf writes coerce like JSONC inside a line. Whole-line replacement and
  append parse `<value>` as JSON. Rendered JSONL preserves the file's dominant
  LF/CRLF line-ending convention.
- YAML leaf writes coerce to the existing scalar type (`string`, finite
  `number`, `true`/`false`, or `null`). YAML insertions use the bundled
  `yaml` package's document API for map/sequence updates. Malformed YAML
  documents with parser errors are refused before mutation with `parse-error`.

Use `--dry-run` before user-visible writes when the exact bytes matter. The
substrate preserves byte-identical output for parse/emit round-trips, but a
mutation can canonicalize the edited region or file depending on kind.
Add `--diff` when you want the preview as a focused before/after patch instead
of the full rendered file.

## Examples

```bash
# Validate a path (no filesystem access)
openclaw path validate 'oc://AGENTS.md/Tools/$last/risk'

# Read a leaf
openclaw path resolve 'oc://gateway.jsonc/version'

# Wildcard search
openclaw path find 'oc://session.jsonl/*/event' --file ./logs/session.jsonl

# Dry-run a write
openclaw path set 'oc://gateway.jsonc/version' '2.0' --dry-run

# Dry-run a write as a unified diff
openclaw path set 'oc://gateway.jsonc/version' '2.0' --dry-run --diff

# Apply the write
openclaw path set 'oc://gateway.jsonc/version' '2.0'

# Byte-fidelity round-trip (diagnostic)
openclaw path emit ./AGENTS.md
```

More grammar examples:

```bash
# Quote keys containing / or .
openclaw path resolve 'oc://config.jsonc/agents.defaults.models/"anthropic/claude-opus-4-7"/alias'

# Predicate search over JSONC children
openclaw path find 'oc://config.jsonc/plugins/[enabled=true]/id'

# Insert into a JSONC array
openclaw path set 'oc://config.jsonc/items/+1' '{"id":"new","enabled":true}' --dry-run

# Insert a JSONC object key
openclaw path set 'oc://config.jsonc/plugins/+github' '{"enabled":true}' --dry-run

# Append a JSONL event
openclaw path set 'oc://session.jsonl/+' '{"event":"checkpoint","ok":true}' --file ./logs/session.jsonl

# Resolve the last JSONL value line
openclaw path resolve 'oc://session.jsonl/$last/event' --file ./logs/session.jsonl

# Resolve a YAML workflow step
openclaw path resolve 'oc://workflow.yaml/steps/0/id'

# Update a YAML scalar
openclaw path set 'oc://workflow.yaml/steps/$last/id' 'classify-renamed' --dry-run

# Address markdown frontmatter
openclaw path resolve 'oc://AGENTS.md/[frontmatter]/name'

# Insert markdown frontmatter
openclaw path set 'oc://AGENTS.md/[frontmatter]/+description' 'Agent instructions' --dry-run

# Find markdown item fields
openclaw path find 'oc://SKILL.md/Tools/*/send_email'

# Validate a session-scoped path
openclaw path validate 'oc://AGENTS.md/Tools/$last/risk?session=cron-daily'
```

## Recipes by file kind

The same five verbs work across kinds; the addressing scheme dispatches on the
file extension. The examples below use the fixtures from the PR description.

### Markdown

```text
<!-- frontmatter.md -->
---
name: drafter
description: email drafting agent
tier: core
---
## Tools
- gh: GitHub CLI
- curl: HTTP client
- send_email: enabled
```

```bash
$ openclaw path resolve 'oc://x.md/[frontmatter]/tier' --file frontmatter.md --human
leaf @ L4: "core" (string)

$ openclaw path resolve 'oc://x.md/tools/gh/gh' --file frontmatter.md --human
leaf @ L9: "GitHub CLI" (string)

$ openclaw path find 'oc://x.md/tools/*' --file frontmatter.md --human
3 matches for oc://x.md/tools/*:
  oc://x.md/tools/gh           →  node @ L9 [md-item]
  oc://x.md/tools/curl         →  node @ L10 [md-item]
  oc://x.md/tools/send-email   →  node @ L11 [md-item]
```

The `[frontmatter]` predicate addresses the YAML frontmatter block; `tools`
matches the `## Tools` heading via slug, and item leaves keep their slug form
even when the source uses underscores (`send_email` → `send-email`).

### JSONC

```text
// config.jsonc
{
  "plugins": {
    "github": {"enabled": true, "role": "vcs"},
    "slack":  {"enabled": false, "role": "chat"}
  }
}
```

```bash
$ openclaw path resolve 'oc://config.jsonc/plugins/github/enabled' --file config.jsonc --human
leaf @ L4: "true" (boolean)

$ openclaw path set 'oc://config.jsonc/plugins/slack/enabled' 'true' --file config.jsonc --dry-run
--dry-run: would write 142 bytes to /…/config.jsonc
{
  "plugins": {
    "github": {"enabled": true, "role": "vcs"},
    "slack":  {"enabled": true, "role": "chat"}
  }
}
```

JSONC edits go through `jsonc-parser`, so comments and whitespace survive a
`set`. Run with `--dry-run` first to inspect the bytes before committing.

### JSONL

```text
{"event":"start","userId":"u1","ts":1}
{"event":"action","userId":"u1","ts":2}
{"event":"end","userId":"u1","ts":3}
```

```bash
$ openclaw path find 'oc://session.jsonl/[event=action]/userId' --file session.jsonl --human
1 match for oc://session.jsonl/[event=action]/userId:
  oc://session.jsonl/L2/userId  →  leaf @ L2: "u1" (string)

$ openclaw path resolve 'oc://session.jsonl/L2/ts' --file session.jsonl --human
leaf @ L2: "2" (number)
```

Each line is a record. Address by predicate (`[event=action]`) when you do not
know the line number, or by the canonical `LN` segment when you do.

### YAML

```text
# workflow.yaml
name: inbox-triage
steps:
  - id: fetch
    command: gmail.search
  - id: classify
    command: openclaw.invoke
```

```bash
$ openclaw path resolve 'oc://workflow.yaml/steps/0/id' --file workflow.yaml --human
leaf @ L3: "fetch" (string)

$ openclaw path set 'oc://workflow.yaml/steps/$last/id' 'classify-renamed' --file workflow.yaml --dry-run
--dry-run: would write 99 bytes to /…/workflow.yaml
name: inbox-triage
steps:
  - id: fetch
    command: gmail.search
  - id: classify-renamed
    command: openclaw.invoke
```

YAML uses the `yaml` package's `Document` API rather than a hand-rolled parser,
so ordinary parse/emit round-trips preserve comments and authoring shape while
resolved paths use the same map-key / sequence-index model as JSONC. The same
adapter handles `.yaml`, `.yml`, and `.lobster` files.

## Subcommand reference

### `resolve <oc-path>`

Read a single leaf or node. Wildcards are rejected — use `find` for those.
Exits `0` on a match, `1` on a clean miss, `2` on a parse error or refused
pattern.

```bash
openclaw path resolve 'oc://AGENTS.md/tools/gh/risk' --human
openclaw path resolve 'oc://gateway.jsonc/server/port' --json
```

### `find <pattern>`

Enumerate every match for a wildcard / predicate / union pattern. Exits `0`
on at least one match, `1` on zero. File-slot wildcards are rejected with
`OC_PATH_FILE_WILDCARD_UNSUPPORTED` — pass a concrete file (multi-file
globbing is a follow-up feature).

```bash
openclaw path find 'oc://AGENTS.md/tools/**/risk'
openclaw path find 'oc://session.jsonl/[event=action]/userId'
openclaw path find 'oc://config.jsonc/plugins/{github,slack}/enabled'
```

### `set <oc-path> <value>`

Write a leaf. Pair with `--dry-run` to preview the bytes that would be
written without touching the file. Add `--diff` for a unified diff preview.
Exits `0` on a successful write, `1` if the substrate refuses (for example, a
sentinel guard hit), `2` on parse errors.

```bash
openclaw path set 'oc://gateway.jsonc/version' '2.0' --dry-run
openclaw path set 'oc://gateway.jsonc/version' '2.0' --dry-run --diff
openclaw path set 'oc://gateway.jsonc/version' '2.0'
openclaw path set 'oc://AGENTS.md/Tools/+gh/risk' 'low'
```

The `+key` insertion marker creates the named child if it does not already
exist; `+nnn` and bare `+` work for indexed and append insertion respectively.

### `validate <oc-path>`

Parse-only check. No filesystem access. Useful when you want to confirm a
template path is well-formed before substituting variables, or when you want
the structural breakdown for debugging:

```bash
$ openclaw path validate 'oc://AGENTS.md/tools/gh' --human
valid: oc://AGENTS.md/tools/gh
  file:    AGENTS.md
  section: tools
  item:    gh
```

Exits `0` when valid, `1` when invalid (with a structured `code` and
`message`), `2` on argument errors.

### `emit <file>`

Round-trip a file through the per-kind parser and emitter. The output should
be byte-identical to the input on a sound file — divergence indicates a
parser bug or a sentinel hit. Useful for debugging substrate behavior on
real-world inputs.

```bash
openclaw path emit ./AGENTS.md
openclaw path emit ./gateway.jsonc --json
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

- `set` writes bytes through the substrate's emit path, which applies the
  redaction-sentinel guard automatically. A leaf carrying
  `__OPENCLAW_REDACTED__` (verbatim or as a substring) is refused at write
  time.
- JSONC parsing and leaf edits use the plugin-local `jsonc-parser`
  dependency, so comments and formatting are preserved on ordinary leaf
  writes instead of going through a hand-rolled parser/re-render path.
- `path` does not know about LKG. If the file is LKG-tracked, the next
  observe call decides whether to promote / recover. `set --batch` for
  atomic multi-set through the LKG promote/recover lifecycle is planned
  alongside the LKG-recovery substrate.

## Related

- [CLI reference](/cli)
