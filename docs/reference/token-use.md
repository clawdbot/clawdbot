---
summary: "How OpenClaw builds prompt context and reports token usage + costs"
read_when:
  - Explaining token usage, costs, or context windows
  - Debugging context growth or compaction behavior
title: "Token Use and Costs"
---

# Token use & costs

OpenClaw tracks **tokens**, not characters. Tokens are model-specific, but most
OpenAI-style models average ~4 characters per token for English text.

## How the system prompt is built

OpenClaw assembles its own system prompt on every run. It includes:

- Tool list + short descriptions
- Skills list (only metadata; instructions are loaded on demand with `read`)
- Self-update instructions
- Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` when new, plus `MEMORY.md` when present or `memory.md` as a lowercase fallback). Large files are truncated by `agents.defaults.bootstrapMaxChars` (default: 20000), and total bootstrap injection is capped by `agents.defaults.bootstrapTotalMaxChars` (default: 150000). `memory/*.md` daily files are not part of the normal bootstrap prompt; they remain on-demand via memory tools on ordinary turns, but bare `/new` and `/reset` can prepend a one-shot startup-context block with recent daily memory for that first turn. That startup prelude is controlled by `agents.defaults.startupContext`.
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

For images, OpenClaw downscales transcript/tool image payloads before provider calls.
Use `agents.defaults.imageMaxDimensionPx` (default: `1200`) to tune this:

- Lower values usually reduce vision-token usage and payload size.
- Higher values preserve more visual detail for OCR/UI-heavy screenshots.

For a practical breakdown (per injected file, tools, skills, and system prompt size), use `/context list` or `/context detail`. See [Context](/concepts/context).

## How to see current token usage

Use these in chat:

- `/status` → **emoji‑rich status card** with the session model, context usage,
  last response input/output tokens, and **estimated cost** (API key only).
- `/usage off|tokens|full` → appends a **per-response usage footer** to every reply.
  - Persists per session (stored as `responseUsage`).
  - OAuth auth **hides cost** (tokens only).
- `/usage cost` → shows a local cost summary from OpenClaw session logs.

Other surfaces:

- **TUI/Web TUI:** `/status` + `/usage` are supported.
- **CLI:** `openclaw status --usage` and `openclaw channels list` show
  normalized provider quota windows (`X% left`, not per-response costs).
  Current usage-window providers: Anthropic, GitHub Copilot, Gemini CLI,
  OpenAI Codex, MiniMax, Xiaomi, and z.ai.

Usage surfaces normalize common provider-native field aliases before display.
For OpenAI-family Responses traffic, that includes both `input_tokens` /
`output_tokens` and `prompt_tokens` / `completion_tokens`, so transport-specific
field names do not change `/status`, `/usage`, or session summaries.
Gemini CLI JSON usage is normalized too: reply text comes from `response`, and
`stats.cached` maps to `cacheRead` with `stats.input_tokens - stats.cached`
used when the CLI omits an explicit `stats.input` field.
For native OpenAI-family Responses traffic, WebSocket/SSE usage aliases are
normalized the same way, and totals fall back to normalized input + output when
`total_tokens` is missing or `0`.
When the current session snapshot is sparse, `/status` and `session_status` can
also recover token/cache counters and the active runtime model label from the
most recent transcript usage log. Existing nonzero live values still take
precedence over transcript fallback values, and larger prompt-oriented
transcript totals can win when stored totals are missing or smaller.
Usage auth for provider quota windows comes from provider-specific hooks when
available; otherwise OpenClaw falls back to matching OAuth/API-key credentials
from auth profiles, env, or config.

## Cost estimation (when shown)

Costs are estimated from your model pricing config:

```
models.providers.<provider>.models[].cost
```

These are **USD per 1M tokens** for `input`, `output`, `cacheRead`, and
`cacheWrite`. If pricing is missing, OpenClaw shows tokens only. OAuth tokens
never show dollar cost.

## Cache TTL and pruning impact

Provider prompt caching only applies within the cache TTL window. OpenClaw can
optionally run **cache-ttl pruning**: it prunes the session once the cache TTL
has expired, then resets the cache window so subsequent requests can re-use the
freshly cached context instead of re-caching the full history. This keeps cache
write costs lower when a session goes idle past the TTL.

Configure it in [Gateway configuration](/gateway/configuration) and see the
behavior details in [Session pruning](/concepts/session-pruning).

Heartbeat can keep the cache **warm** across idle gaps. If your model cache TTL
is `1h`, setting the heartbeat interval just under that (e.g., `55m`) can avoid
re-caching the full prompt, reducing cache write costs.

In multi-agent setups, you can keep one shared model config and tune cache behavior
per agent with `agents.list[].params.cacheRetention`.

For a full knob-by-knob guide, see [Prompt Caching](/reference/prompt-caching).

For Anthropic API pricing, cache reads are significantly cheaper than input
tokens, while cache writes are billed at a higher multiplier. See Anthropic’s
prompt caching pricing for the latest rates and TTL multipliers:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Example: keep 1h cache warm with heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

### Example: mixed traffic with per-agent cache strategy

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long" # default baseline for most agents
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m" # keep long cache warm for deep sessions
    - id: "alerts"
      params:
        cacheRetention: "none" # avoid cache writes for bursty notifications
```

`agents.list[].params` merges on top of the selected model's `params`, so you can
override only `cacheRetention` and inherit other model defaults unchanged.

### Example: enable Anthropic 1M context beta header

Anthropic's 1M context window is currently beta-gated. OpenClaw can inject the
required `anthropic-beta` value when you enable `context1m` on supported Opus
or Sonnet models.

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          context1m: true
```

This maps to Anthropic's `context-1m-2025-08-07` beta header.

This only applies when `context1m: true` is set on that model entry.

Requirement: the credential must be eligible for long-context usage. If not,
Anthropic responds with a provider-side rate limit error for that request.

If you authenticate Anthropic with OAuth/subscription tokens (`sk-ant-oat-*`),
OpenClaw skips the `context-1m-*` beta header because Anthropic currently
rejects that combination with HTTP 401.

## Tips for reducing token pressure

- Use `/compact` to summarize long sessions.
- Trim large tool outputs in your workflows.
- Lower `agents.defaults.imageMaxDimensionPx` for screenshot-heavy sessions.
- Keep skill descriptions short (skill list is injected into the prompt).
- Prefer smaller models for verbose, exploratory work.

See [Skills](/tools/skills) for the exact skill list overhead formula.
