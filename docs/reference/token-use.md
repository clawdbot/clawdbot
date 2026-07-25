---
summary: "How OpenClaw builds prompt context and reports token usage + costs"
read_when:
  - Explaining token usage, costs, or context windows
  - Debugging context growth or compaction behavior
title: "Token use and costs"
---

OpenClaw tracks **tokens**, not characters. Tokens are model-specific, but most
OpenAI-style models average ~4 characters per token for English text.

## How the system prompt is built

OpenClaw assembles its own system prompt on every run. It includes:

- Tool list + short descriptions
- Skills list (metadata only; instructions load on demand with `read`). Native
  Codex turns get the compact skills block as turn-scoped collaboration
  developer instructions; other harnesses get it in the normal prompt surface.
  Bounded by `skills.limits.maxSkillsPromptChars`, with optional per-agent
  override at `agents.entries.*.skillsLimits.maxSkillsPromptChars`.
- Self-update instructions
- Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`,
  `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` when new, plus
  `MEMORY.md` when present). Large injected files are truncated by
  `agents.defaults.bootstrapMaxChars` (default: `20000`); total bootstrap
  injection is capped by `agents.defaults.bootstrapTotalMaxChars` (default:
  `60000`).
  - Native Codex turns do not paste raw `MEMORY.md` when memory tools are
    available for that workspace; they get a small memory pointer in
    turn-scoped collaboration developer instructions instead and use memory
    tools on demand. If tools are disabled, memory search is unavailable, or
    the active workspace differs from the agent memory workspace, `MEMORY.md`
    falls back to the normal bounded turn-context path.
  - Lowercase root `memory.md` is never injected. It is legacy repair input
    for `openclaw doctor --fix`, which migrates it into `MEMORY.md`.
  - `memory/*.md` daily files are not part of the normal bootstrap prompt;
    they stay on-demand via memory tools on ordinary turns. Reset/startup
    model runs can prepend a one-shot startup-context block with recent
    daily memory for that first turn, controlled by
    `agents.defaults.startupContext`. Bare chat `/new` and `/reset` are
    acknowledged without invoking the model.
  - Post-compaction `AGENTS.md` excerpts require explicit
    `agents.defaults.compaction.postCompactionSections` opt-in; plugins can add
    other context through `before_prompt_build`.
- Time (UTC + user timezone)
- Reply tags + heartbeat behavior
- Runtime metadata (host/OS/model/thinking)

See the full breakdown in [System Prompt](/concepts/system-prompt).

When documenting credentials or auth snippets, use the
[Secret Placeholder Conventions](/reference/secret-placeholder-conventions) to
avoid secret-scanner false positives in docs-only changes.

## What counts in the context window

Everything the model receives counts toward the context limit:

- System prompt (all sections above)
- Conversation history (user + assistant messages)
- Tool calls and tool results
- Attachments/transcripts (images, audio, files)
- Compaction summaries and pruning artifacts
- Provider wrappers or safety headers (not visible, but still counted)

Runtime-heavy surfaces have their own explicit caps under
`agents.defaults.contextLimits` (per-agent overrides under
`agents.entries.*.contextLimits`):

| Key                      | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `memoryGetMaxChars`      | Max characters `memory_get` returns before truncation.                   |
| `postCompactionMaxChars` | Max characters retained from `AGENTS.md` during post-compaction refresh. |

These are bounded runtime excerpts and injected runtime-owned blocks,
separate from bootstrap limits, startup-context limits, and skills prompt
limits.

OpenClaw derives the live tool-result cap from the effective model context
window: `16000` chars below
100K tokens, `32000` chars at 100K+ tokens, `64000` chars at 200K+ tokens.
The runtime context-share guard also caps a single tool result at 30% of the
context window.

Large provider windows are not enabled automatically when they materially
change cost or latency. For example, direct OpenAI GPT-5.5 and GPT-5.6 models
publish a `1050000` token total window, but OpenClaw defaults their active
runtime budget to `272000` tokens. The opt-in `922000` input budget reserves the
full `128000` output allowance, and OpenAI applies higher long-context pricing
to the entire request once input exceeds `272000` tokens. See
[OpenAI context window defaults](/providers/openai#context-window-defaults-and-long-context-opt-in).

For images, OpenClaw downscales transcript/tool image payloads before
provider calls. Tune with `agents.defaults.imageMaxDimensionPx` (default:
`1200`):

- Lower values reduce vision-token usage and payload size.
- Higher values preserve more visual detail for OCR/UI-heavy screenshots.

For a practical breakdown (per injected file, tools, skills, and system
prompt size), use `/context list` or `/context detail`. See
[Context](/concepts/context).

## How to see current token usage

In chat:

- `/status` -> emoji-rich status card with the session model, context usage,
  last response input/output tokens, and estimated cost when local pricing is
  configured for the active model.
- `/usage off|tokens|full` -> appends a per-response usage footer to every
  reply. Persists per session (stored as `responseUsage`).
  - `/usage reset` (aliases: `inherit`, `clear`, `default`) clears the
    session override so it re-inherits the configured default.
  - `/usage tokens` shows turn token/cache details.
  - `/usage full` shows compact model/context/cost details; estimated cost
    appears only when OpenClaw has usage metadata and local pricing for the
    active model. Custom `messages.usageTemplate` layouts can include
    token/cache fields.
- `/usage cost` -> local cost summary from OpenClaw session logs.

Other surfaces:

- **TUI/Web TUI:** `/status` and `/usage` are supported.
- **CLI:** `openclaw status --usage` and `openclaw channels list` show
  normalized provider quota windows (`X% left`, not per-response costs).
  Current usage-window providers: Claude (Anthropic), ClawRouter, Copilot
  (GitHub), DeepSeek, Gemini (Google Gemini CLI), MiniMax, OpenAI, Xiaomi,
  Xiaomi Token Plan, and z.ai.

Usage surfaces normalize common provider-native field aliases before
display. For OpenAI-family Responses traffic, that includes both
`input_tokens`/`output_tokens` and `prompt_tokens`/`completion_tokens`, so
transport-specific field names do not change `/status`, `/usage`, or session
summaries. Gemini CLI usage is normalized too: the default `stream-json`
parser reads assistant `message` events, and `stats.cached` maps to
`cacheRead`, with `stats.input_tokens - stats.cached` used when the CLI omits
an explicit `stats.input` field. Legacy JSON overrides still read reply text
from `response`.

For native OpenAI-family Responses traffic, WebSocket/SSE usage aliases
normalize the same way, and totals fall back to normalized input + output
when `total_tokens` is missing or `0`.

When the current session snapshot is sparse, `/status` and `session_status`
can recover token/cache counters and the active runtime model label from the
most recent transcript usage log. Existing nonzero live values still take
precedence over transcript fallback values, and larger prompt-oriented
transcript totals can win when stored totals are missing or smaller.

Usage auth for provider quota windows comes from provider-specific hooks
first; if a provider has no hook (or the hook does not resolve a token),
OpenClaw falls back to matching OAuth/API-key credentials from auth
profiles, env, or config.

Assistant transcript entries persist the same normalized usage shape,
including `usage.cost` when the active model has pricing configured and the
provider returns usage metadata. This gives `/usage cost` and
transcript-backed session status a stable source even after the live
runtime state is gone.

OpenClaw keeps provider usage accounting separate from the current context
snapshot. Provider `usage.total` can include cached input, output, and
multiple tool-loop model calls, so it is useful for cost and telemetry but
can overstate the live context window. Context displays and diagnostics use
the latest prompt snapshot (`promptTokens`, or the last model call when no
prompt snapshot is available) for `context.used`.

## Cost estimation (when shown)

Costs are estimated from your model pricing config:

```text
models.providers.<provider>.models[].cost
```

These are **USD per 1M tokens** for `input`, `output`, `cacheRead`, and
`cacheWrite`. If pricing is missing, `/usage full` omits cost; use
`/usage tokens` or a custom `messages.usageTemplate` when you need
token/cache details in every reply. Cost display is not limited to API-key
auth: non-API-key providers such as `aws-sdk` can show estimated cost when
their configured model entry includes local pricing and the provider
returns usage metadata.

After sidecars and channels reach the Gateway ready path, OpenClaw starts an
optional background pricing bootstrap for configured model refs that do not
already have local pricing. That bootstrap fetches remote OpenRouter and
LiteLLM pricing catalogs. Set `models.pricing.enabled: false` to skip those
catalog fetches on offline or restricted networks; explicit
`models.providers.*.models[].cost` entries still drive local cost estimates.

## Cache TTL and pruning impact

Provider prompt caching only applies within the cache TTL window. OpenClaw
can optionally run **cache-ttl pruning**: it prunes the session once the
cache TTL has expired, then resets the cache window so subsequent requests
re-use the freshly cached context instead of re-caching the full history.
This keeps cache write costs lower when a session goes idle past the TTL.

Configure it in [Gateway configuration](/gateway/configuration) and see the
behavior details in [Session pruning](/concepts/session-pruning).

Heartbeat can keep the cache **warm** across idle gaps. If your model cache
TTL is `1h`, setting the heartbeat interval just under that (e.g., `55m`) can
avoid re-caching the full prompt, reducing cache write costs.

In multi-agent setups, you can keep one shared model config and tune cache
behavior per agent with `agents.entries.*.params.cacheRetention`.

For a full knob-by-knob guide, see [Prompt Caching](/reference/prompt-caching).

For Anthropic API pricing, cache reads are significantly cheaper than input
tokens, while cache writes are billed at a higher multiplier. See Anthropic's
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

`agents.entries.*.params` merges on top of the selected model's `params`, so you
can override only `cacheRetention` and inherit other model defaults
unchanged.

### Anthropic 1M context

OpenClaw sizes GA-capable Claude 4.x models such as Opus 4.8, Opus 4.7, Opus
4.6, and Sonnet 4.6 with Anthropic's 1M context window. You do not need
`params.context1m: true` for those models.

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        alias: opus
```

Older configs can keep `context1m: true`, but OpenClaw no longer sends
Anthropic's retired `context-1m-2025-08-07` beta header for this setting and
does not expand unsupported older Claude models to 1M.

Requirement: the credential must be eligible for long-context usage. If not,
Anthropic responds with a provider-side rate limit error for that request.

If you authenticate Anthropic with OAuth/subscription tokens
(`sk-ant-oat-*`), OpenClaw preserves the OAuth-required Anthropic beta
headers while stripping the retired `context-1m-*` beta if it remains in
older config.

## Tips for reducing token pressure

- Use `/compact` to summarize long sessions.
- Trim large tool outputs in your workflows.
- Lower `agents.defaults.imageMaxDimensionPx` for screenshot-heavy sessions.
- Keep skill descriptions short (skill list is injected into the prompt).
- Prefer smaller models for verbose, exploratory work.

See [Skills](/tools/skills) for the exact skill list overhead formula.

## Related

- [API usage and costs](/reference/api-usage-costs)
- [Prompt caching](/reference/prompt-caching)
- [Usage tracking](/concepts/usage-tracking)
