---
summary: "How Clawdbot builds prompt context and reports token usage + costs"
read_when:
  - Explaining token usage, costs, or context windows
  - Debugging context growth or compaction behavior
---
# Token use & costs

Clawdbot tracks **tokens**, not characters. Tokens are model-specific, but most
OpenAI-style models average ~4 characters per token for English text.

## How the system prompt is built

Clawdbot assembles its own system prompt on every run. It includes:

- Tool list + short descriptions
- Skills list (only metadata; instructions are loaded on demand with `read`)
- Self-update instructions
- Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` when new). Large files are truncated by `agents.defaults.bootstrapMaxChars` (default: 20000).
- Time (UTC + user timezone)
- Reply tags + heartbeat behavior
- Runtime metadata (host/OS/model/thinking)

See the full breakdown in [System Prompt](/concepts/system-prompt).

## What counts in the context window

Everything the model receives counts toward the context limit:

- System prompt (all sections listed above)
- Conversation history (user + assistant messages)
- Tool calls and tool results
- Attachments/transcripts (images, audio, files)
- Compaction summaries and pruning artifacts
- Provider wrappers or safety headers (not visible, but still counted)

For a practical breakdown (per injected file, tools, skills, and system prompt size), use `/context list` or `/context detail`. See [Context](/concepts/context).

## How to see current token usage

Use these in chat:

- `/status` → **emoji‑rich status card** with the session model, context usage,
  last response input/output tokens, and **estimated cost** (API key only).
- `/usage off|tokens|full` → appends a **per-response usage footer** to every reply.
  - Persists per session (stored as `responseUsage`).
  - OAuth auth **hides cost** (tokens only).

Other surfaces:

- **TUI/Web TUI:** `/status` + `/usage` are supported.
- **CLI:** `clawdbot status --usage` and `clawdbot channels list` show
  provider quota windows (not per-response costs).

## Cost estimation (when shown)

Costs are estimated from your model pricing config:

```
models.providers.<provider>.models[].cost
```

These are **USD per 1M tokens** for `input`, `output`, `cacheRead`, and
`cacheWrite`. If pricing is missing, Clawdbot shows tokens only. OAuth tokens
never show dollar cost.

## Tips for reducing token pressure

- Use `/compact` to summarize long sessions.
- Trim large tool outputs in your workflows.
- Keep skill descriptions short (skill list is injected into the prompt).
- Prefer smaller models for verbose, exploratory work.

See [Skills](/tools/skills) for the exact skill list overhead formula.
