---
name: session-logs
description: "Search and analyze your own session logs (older/parent conversations) using jq."
metadata:
  {
    "openclaw":
      {
        "emoji": "📜",
        "requires": { "bins": ["jq", "rg"] },
        "install":
          [
            {
              "id": "brew-jq",
              "kind": "brew",
              "formula": "jq",
              "bins": ["jq"],
              "label": "Install jq (brew)",
            },
            {
              "id": "brew-rg",
              "kind": "brew",
              "formula": "ripgrep",
              "bins": ["rg"],
              "label": "Install ripgrep (brew)",
            },
          ],
      },
  }
---

# session-logs

Search your complete conversation history stored in session JSONL files. Use this when a user references older/parent conversations or asks what was said before.

## Trigger

Use this skill when the user asks about prior chats, parent conversations, or historical context that isn't in memory files.

## Location

Session logs live under the active state directory:
`$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/` (default: `~/.openclaw/agents/<agentId>/sessions/`).
Use the `agent=<id>` value from the system prompt Runtime line.

- **`sessions.json`** - Index mapping session keys to session IDs
- **`<session-id>.jsonl`** - Full conversation transcript per session
- **`<session-id>.jsonl.reset.<timestamp>Z`** - Transcript archived by `/new` or `/reset`
- **`<session-id>.jsonl.deleted.<timestamp>Z`** - Transcript archived when a session was deleted

When searching history, include the archived (`.reset.*`, `.deleted.*`) variants too — they
still contain real conversation content. The plain-glob examples below only catch the
active `*.jsonl` files; use the "Include archived transcripts" snippet when you need
full recall.

## Structure

Each `.jsonl` file contains messages with:

- `type`: "session" (metadata) or "message"
- `timestamp`: ISO timestamp
- `message.role`: "user", "assistant", or "toolResult"
- `message.content[]`: Text, thinking, or tool calls (filter `type=="text"` for human-readable content)
- `message.usage.cost.total`: Cost per response

## Common Queries

### Include archived transcripts (`.reset.*`, `.deleted.*`)

```bash
# Bash helper that emits every searchable transcript path — active and archived.
# Saves and restores `nullglob` locally so callers' shell options aren't disturbed.
AGENT_ID="<agentId>"
SESSION_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/sessions"
list_session_transcripts() {
  local _nullglob_state
  _nullglob_state=$(shopt -p nullglob 2>/dev/null)
  shopt -s nullglob
  for f in "$SESSION_DIR"/*.jsonl \
           "$SESSION_DIR"/*.jsonl.reset.*Z \
           "$SESSION_DIR"/*.jsonl.deleted.*Z; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done
  eval "$_nullglob_state"
}
```

Use `list_session_transcripts` (or an equivalent `find` invocation) wherever the
plain `*.jsonl` glob is shown below if you need to include archived sessions:

```bash
find "$SESSION_DIR" -maxdepth 1 -type f \
  \( -name '*.jsonl' -o -name '*.jsonl.reset.*Z' -o -name '*.jsonl.deleted.*Z' \) -print
```

### List all sessions by date and size

```bash
AGENT_ID="<agentId>"
SESSION_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/sessions"
for f in "$SESSION_DIR"/*.jsonl; do
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)
  size=$(ls -lh "$f" | awk '{print $5}')
  echo "$date $size $(basename $f)"
done | sort -r
```

_Tip:_ swap the `for f in ...` line for a `while`-read over
`list_session_transcripts` (see snippet above) when you also want archived
`.reset` / `.deleted` files in the listing. The `while`-read pattern is safe
for paths with spaces or other IFS characters:

```bash
while IFS= read -r f; do
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)
  size=$(ls -lh "$f" | awk '{print $5}')
  echo "$date $size $(basename "$f")"
done < <(list_session_transcripts) | sort -r
```

### Find sessions from a specific day

```bash
AGENT_ID="<agentId>"
SESSION_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/sessions"
for f in "$SESSION_DIR"/*.jsonl; do
  head -1 "$f" | jq -r '.timestamp' | grep -q "2026-01-06" && echo "$f"
done
```

### Extract user messages from a session

```bash
jq -r 'select(.message.role == "user") | .message.content[]? | select(.type == "text") | .text' <session>.jsonl
```

### Search for keyword in assistant responses

```bash
jq -r 'select(.message.role == "assistant") | .message.content[]? | select(.type == "text") | .text' <session>.jsonl | rg -i "keyword"
```

### Get total cost for a session

```bash
jq -s '[.[] | .message.usage.cost.total // 0] | add' <session>.jsonl
```

### Daily cost summary

```bash
AGENT_ID="<agentId>"
SESSION_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/sessions"
for f in "$SESSION_DIR"/*.jsonl; do
  date=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)
  cost=$(jq -s '[.[] | .message.usage.cost.total // 0] | add' "$f")
  echo "$date $cost"
done | awk '{a[$1]+=$2} END {for(d in a) print d, "$"a[d]}' | sort -r
```

### Count messages and tokens in a session

```bash
jq -s '{
  messages: length,
  user: [.[] | select(.message.role == "user")] | length,
  assistant: [.[] | select(.message.role == "assistant")] | length,
  first: .[0].timestamp,
  last: .[-1].timestamp
}' <session>.jsonl
```

### Tool usage breakdown

```bash
jq -r '.message.content[]? | select(.type == "toolCall") | .name' <session>.jsonl | sort | uniq -c | sort -rn
```

### Search across ALL sessions for a phrase

```bash
AGENT_ID="<agentId>"
SESSION_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/sessions"

# Active sessions only:
rg -l "phrase" "$SESSION_DIR"/*.jsonl

# Active + archived (`.reset.*`, `.deleted.*`) — use this when checking for
# content that may have been compacted/reset/deleted:
rg -l "phrase" "$SESSION_DIR"/*.jsonl \
               "$SESSION_DIR"/*.jsonl.reset.*Z \
               "$SESSION_DIR"/*.jsonl.deleted.*Z 2>/dev/null
```

## Tips

- Sessions are append-only JSONL (one JSON object per line)
- Large sessions can be several MB - use `head`/`tail` for sampling
- The `sessions.json` index maps chat providers (discord, whatsapp, etc.) to session IDs
- **Reset/compacted sessions** have `.jsonl.reset.<timestamp>Z` suffix — still contain
  full transcripts and are searchable.
- **Deleted sessions** have `.jsonl.deleted.<timestamp>Z` suffix — also still searchable.
- A plain `*.jsonl` glob will _miss_ both archived forms. Include them explicitly
  (see the "Include archived transcripts" snippet above) when you need full history.

## Fast text-only hint (low noise)

```bash
AGENT_ID="<agentId>"
SESSION_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents/$AGENT_ID/sessions"
jq -r 'select(.type=="message") | .message.content[]? | select(.type=="text") | .text' "$SESSION_DIR"/<id>.jsonl | rg 'keyword'
```
