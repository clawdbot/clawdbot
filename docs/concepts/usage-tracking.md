---
summary: "Usage tracking surfaces and credential requirements"
read_when:
  - You are wiring provider usage/quota surfaces
  - You need to explain usage tracking behavior or auth requirements
title: "Usage tracking"
---

## What it is

- Pulls provider usage/quota directly from each provider's usage endpoint. No estimated provider billing; only provider-reported plan names, quota windows, balances, spend, budgets, daily cost history, token/model attribution, or account-state summaries.
- Human-readable quota-window output is normalized to `X% left`, even when a provider reports consumed quota, remaining quota, or only raw counts. Providers without resettable quota windows show provider summary text instead (for example a balance).
- Session-level `/status` and the `session_status` tool fall back to the session's transcript log when the live session snapshot is missing token/model data. That fallback fills missing token/cache counters, can recover the active runtime model label, and prefers the larger prompt-oriented total when session metadata is missing or smaller (`totalTokensFresh !== true`, zero, or below the transcript-derived value). Nonzero live values always win over the fallback.

## Where it shows up

- `/status` in chats: status card with session tokens and estimated cost (API key models only). Provider usage shows for the **current model provider** when available, as a normalized `X% left` window or provider summary text.
- `/usage off|tokens|full` in chats: per-response usage footer.
- `/usage cost` in chats: local cost summary aggregated from OpenClaw session logs.
- CLI: `openclaw status --usage` prints a full per-provider usage/quota breakdown.
- CLI: `openclaw models status` lists OAuth/token auth profiles and shows a usage-window summary next to each provider that has one.
- Control UI: **Usage** shows provider plan and billing cards above OpenClaw's session-derived token and estimated-cost analysis. Anthropic and OpenAI Admin API credentials add provider-reported today, 7-day, and 30-day spend, daily trends, token totals, top models, and cost categories.
- Control UI: the chat composer's context ring popover shows **plan usage** for subscription providers — per-window bars (5-hour, weekly, model-scoped) with reset times, the provider plan when known (for example `Max (20x)`), and extra-usage credits. Sessions billed through a plan hide per-token dollar estimates; API-billed sessions keep `Est. cost` and the cost-by-type breakdown. Claude Code CLI (`claude-cli`) setups reuse the same Anthropic subscription usage.
- macOS menu bar: a root "Usage" section appears below Context when provider usage snapshots are available. See [Menu bar](/platforms/mac/menu-bar).

`openclaw channels list` no longer prints provider usage; it points users to `openclaw status` or `openclaw models list` instead.

## Anthropic and OpenAI cost history

Subscription quota and API billing are different provider surfaces:

- Anthropic subscription/setup credentials continue to show Claude quota windows and optional extra-usage budgets. Set `ANTHROPIC_ADMIN_KEY` or `ANTHROPIC_ADMIN_API_KEY` to show organization Usage and Cost API history instead. An Anthropic provider credential beginning with `sk-ant-admin` is detected automatically.
- OpenAI ChatGPT/Codex OAuth continues to show plan, quota windows, and credit balance. Set `OPENAI_ADMIN_KEY` to show organization cost and completions-usage history instead; optionally set `OPENAI_PROJECT_ID` to scope it to one project. OpenClaw never sends inference credentials from `OPENAI_API_KEY`, provider config, or auth profiles to organization APIs because those keys may belong to custom endpoints.

Admin credentials take precedence because they provide actual organization billing. OpenClaw does not combine these provider-reported totals with its local session estimates; the two sections intentionally answer different questions.

## Default usage footer mode

`/usage off|tokens|full` sets the footer for a session and is remembered for that
session. `messages.responseUsage` seeds that mode for sessions that have not
chosen one, so the footer can be on by default without typing `/usage` each time.

Set one mode for every channel, or a per-channel map with a `default` fallback:

```jsonc
{
  "messages": {
    "responseUsage": "tokens",
    // or: { "default": "off", "discord": "full" }
  },
}
```

Accepted values: `"off"`, `"tokens"`, `"full"`, and the legacy alias `"on"` (treated as `"tokens"`).

### Three distinct session states

A session's `responseUsage` field has three representable states, each with
different semantics:

| State               | Stored value                    | Effective mode                                                        |
| ------------------- | ------------------------------- | --------------------------------------------------------------------- |
| **Unset / inherit** | `undefined` (absent)            | Falls through to `messages.responseUsage` config default, then `off`. |
| **Explicit off**    | `"off"` (stored)                | Always off, a non-off config default cannot re-enable the footer.     |
| **Explicit on**     | `"tokens"` or `"full"` (stored) | That mode, regardless of config default.                              |

### Precedence

Effective mode = session override → channel config entry → `default` → `off`.

An explicit `/usage off` is **persisted** as the literal value `"off"` in the
session, not the same as "unset." A non-off `messages.responseUsage`
default cannot turn the footer back on once the user has explicitly disabled it.

### Resetting vs. turning off

- `/usage off` forces the footer off and persists that choice. A configured
  non-off default cannot override this.
- `/usage reset` (aliases: `default`, `inherit`, `inherited`, `clear`, `unpin`) clears the session
  override. The session then **inherits** the effective config default
  (`messages.responseUsage`). If no default is configured, the footer stays off.
- A full session reset (`/reset` or `/new`) or a session rollover **preserves**
  the explicit usage-mode preference so the user's display choice survives
  session rollovers. Only `/usage reset` (and its aliases) clears the override.

### Toggle behavior

`/usage` with no arguments cycles: off → tokens → full → off. The starting point
for the cycle is the **effective** current mode (session override falling through
to the config default when unset), so the cycle always matches what
the user currently sees in the footer.

### Config

With no config the prior behavior holds (footer off until `/usage`). Use
`/usage reset` to clear a session override and re-inherit the configured default.

## Custom `/usage full` footer

`/usage tokens` always renders a plain `Usage: X in / Y out` line (plus cache and
estimated-cost suffixes when available). Only `/usage full` renders the richer
footer described below.

`/usage full` shows a built-in compact footer with model, reasoning, fast/slow,
context window, and cost when those fields are available. No template file is
required for the built-in footer.

`messages.usageTemplate` is only for advanced custom layouts. The value is a
JSON file path (supports `~`) or an inline object, and it replaces the built-in
footer when valid. A file path is watched and reloaded live on change.

```json
{
  "messages": {
    "usageTemplate": "~/.openclaw/usage-footer.json"
  }
}
```

Missing or empty templates fall back to the built-in footer quietly. Unreadable
or invalid configured templates (bad JSON, or a shape with no renderable output
pieces) also fall back to the built-in footer and emit an operator warning.

Start custom templates from the built-in shape, then edit the parts you want to
change:

```jsonc
{
  "schema": "openclaw.usageBar.v1",
  "scales": {
    "braille": "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
    "block": "░▏▎▍▌▋▊▉█",
    "shade": "░▒▓█",
    "moon": "🌑🌘🌗🌖🌕",
    "level": "▁▂▃▄▅▆▇█",
    "weather": ["🥶", "☁️", "🌥", "⛅️", "🌤", "☀️"],
    "plants": ["🪾", "🍂", "🌱", "☘️", "🍀", "🌿"],
    "moons6": ["🌑", "🌚", "🌘", "🌗", "🌖", "🌝"],
  },
  "aliases": {
    "models": {
      "claude-opus-4-6": "opus46",
      "claude-opus-4-8": "opus48",
      "claude-sonnet-4-6": "sonnet46",
      "claude-haiku-4-5": "haiku45",
      "gpt-5.5": "gpt5.5",
    },
    "reasoning": {
      "off": "🌑",
      "minimal": "🌚",
      "low": "🌘",
      "medium": "🌗",
      "high": "🌕",
      "xhigh": "🌝",
    },
  },
  "output": {
    "sep": "",
    "default": [
      { "text": "{model.provider}{identity.emoji|🤖}{model.display_name|alias:models}" },
      { "map": "model.is_fallback", "cases": { "true": "🔄" } },
      { "map": "model.is_override", "cases": { "true": "📌" } },
      { "when": "model.reasoning", "text": "{model.reasoning|alias:reasoning}" },
      { "map": "state.fast_mode", "cases": { "true": "⚡️", "false": "🐌" } },
      {
        "when": "context.max_tokens",
        "text": " | 📚[{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
      },
      { "when": "cost.turn_usd", "text": " 💰{cost.turn_usd|fixed:4}" },
    ],
    "surfaces": {
      "discord": [
        { "text": "-# -\n" },
        { "text": "-# {model.provider}{identity.emoji|🤖}{model.display_name|alias:models}" },
        { "map": "model.is_fallback", "cases": { "true": "🔄" } },
        { "map": "model.is_override", "cases": { "true": "📌" } },
        { "when": "model.reasoning", "text": "{model.reasoning|alias:reasoning}" },
        { "map": "state.fast_mode", "cases": { "true": "⚡️", "false": "🐌" } },
        {
          "when": "context.max_tokens",
          "text": " | 📚[{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
        },
        { "when": "cost.turn_usd", "text": " 💰{cost.turn_usd|fixed:4}" },
      ],
    },
  },
}
```

### Shape

```jsonc
{
  "schema": "openclaw.usageBar.v1",
  "scales": { "<name>": "low-to-high glyphs" }, // string (1 glyph/char) or array
  "aliases": { "<table>": { "<value>": "<label>" } },
  "output": {
    "sep": "", // joins surviving pieces
    "default": [/* pieces */], // fallback for any surface
    "surfaces": {
      "discord": [/* pieces */],
      "telegram": [/* pieces */],
    },
  },
}
```

Each surface is an ordered list of **pieces**; the engine renders each, drops
empties, and joins survivors with `sep`. A surface with no entry uses
`output.default`.

### Contract Paths

A piece reads values from the per-turn contract by dot-path. Absent values are
empty (so a `when` guard or a `|fallback` keeps the piece clean).

| Path                                                                                | Meaning                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `surface`                                                                           | channel id (`discord`/`telegram`/etc.)                                                               |
| `agentId` / `chat_type`                                                             | owning agent id / chat surface kind                                                                  |
| `model.id` / `model.display_name` / `model.provider`                                | model id / display name / provider id                                                                |
| `model.actual`, `model.resolved_ref`                                                | provider/model ref actually used for the turn                                                        |
| `model.requested`                                                                   | provider/model ref requested (before fallback)                                                       |
| `model.reasoning`                                                                   | effort (`off` through `xhigh`)                                                                       |
| `model.is_fallback` / `model.is_override`                                           | bool: fallback used / model pinned                                                                   |
| `model.override_source` / `model.auth_mode`                                         | override source label / credential mode (`oauth`, `api-key`, `token`, `mixed`, `aws-sdk`, `unknown`) |
| `state.fast_mode`                                                                   | bool: fast vs slow                                                                                   |
| `state.compactions`                                                                 | compaction count for the session                                                                     |
| `context.max_tokens` / `context.used_tokens` / `context.pct_used`                   | window budget / occupied tokens / 0-100 used                                                         |
| `usage.input_tokens` / `usage.output_tokens` / `usage.total_tokens`                 | turn aggregate                                                                                       |
| `usage.cache_read_tokens` / `usage.cache_write_tokens`                              | cache-read and cache-write tokens for the turn                                                       |
| `usage.has_tokens` / `usage.has_split_tokens` / `usage.has_total_only_tokens`       | token display guards                                                                                 |
| `usage.cache_hit_pct`                                                               | cache-read share of total prompt tokens                                                              |
| `usage.last.input_tokens` / `usage.last.output_tokens` / `usage.last.cache_hit_pct` | final model call only (also has `cache_read_tokens`, `cache_write_tokens`, `total_tokens`)           |
| `cost.turn_usd` / `cost.available`                                                  | estimated turn cost / whether a cost table resolved                                                  |
| `timing.duration_ms`                                                                | wall-clock turn duration                                                                             |
| `identity.name` / `identity.emoji` / `identity.avatar`                              | agent identity name / emoji / avatar                                                                 |
| `session.id`                                                                        | session id                                                                                           |

(Provider rate-limit windows are **not** in this contract; there is no array-valued path today, so an `each` piece has nothing to iterate.)

### Verbs

Pipe a value through verbs left to right; a non-verb segment is the fallback.

| Verb            | Effect                                | Example                           |
| --------------- | ------------------------------------- | --------------------------------- |
| `num`           | compact count                         | `272000 -> 272k`                  |
| `fixed:N`       | N decimals (`0..100`, default 2)      | `0.0377`                          |
| `dur`           | seconds to duration                   | `14820 -> 4h07m`                  |
| `pct`           | append `%`                            | `96 -> 96%`                       |
| `inv`           | `100 - x`                             | for used to remaining             |
| `alias:TABLE`   | lookup in `aliases`, echo if unlisted | `medium -> 🌗`                    |
| `meter:W:SCALE` | W-cell glyph bar over a 0-100 value   | `[⣿⣿⠐⠐⠐]` (`meter:1` = one glyph) |

`fixed:N` accepts only a complete decimal integer from 0 through 100. Invalid
precision arguments make that interpolation empty.

### Piece forms

- `{ "text": "📚 {context.max_tokens|num}" }`: literal + interpolation.
- `{ "when": "<path>", "text": "..." }`: render only if the path is truthy.
- `{ "map": "<path>", "cases": { "true": "⚡", "false": "🐌" } }`: value to glyph (a `_default` case covers unmatched values).
- `{ "each": "<array-path>", "item": "{label}" }`: iterate an array-valued path (no current contract path is an array).

### Example

```jsonc
{
  "schema": "openclaw.usageBar.v1",
  "scales": { "braille": "⠐⡀⡄⡆⡇⣇⣧⣷⣿" },
  "aliases": { "reasoning": { "medium": "🌗", "high": "🌕" } },
  "output": {
    "surfaces": {
      "discord": [
        { "text": "{model.display_name}" },
        { "when": "model.reasoning", "text": " {model.reasoning|alias:reasoning}" },
        { "map": "state.fast_mode", "cases": { "true": " ⚡", "false": " 🐌" } },
        {
          "when": "context.max_tokens",
          "text": " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
        },
      ],
    },
  },
}
```

renders e.g. `claude-sonnet-4-6 🌗 🐌 | 📚 [⣿⣿⣿⣿⣧]272k`.

## Providers + credentials

Usage is hidden when no usable provider usage auth can be resolved. OpenClaw
automatically discovers enabled provider plugins that declare
`contracts.usageProviders` and implement both `resolveUsageAuth` and
`fetchUsageSnapshot`; there is no separate core provider allowlist. The static
contract keeps discovery scoped without importing every provider plugin. Each
plugin owns its upstream endpoint and response mapping. The
shared snapshot keeps plan names, quota windows, balances, spend, and budgets
provider-neutral for CLI, app, and Control UI consumers.

- **Anthropic (Claude)**: OAuth tokens in auth profiles. If the OAuth token lacks
  `user:profile` scope, falls back to a `claude.ai` web session (`CLAUDE_AI_SESSION_KEY`,
  `CLAUDE_WEB_SESSION_KEY`, or a `sessionKey=` cookie in `CLAUDE_WEB_COOKIE`) when set.
  Model-scoped limits and enabled extra-usage monthly spend/budgets are included
  when Anthropic reports them. An explicit Anthropic Admin API key, or an
  auto-detected `sk-ant-admin...` provider profile, instead shows 30-day
  organization cost and Messages API history.
- **ClawRouter**: API key (`CLAWROUTER_API_KEY`). Shows a monthly budget window
  and typed USD budget when configured; otherwise shows aggregate spend and a
  request/token/cost summary.
- **DeepSeek**: API key via env/config/auth store (`DEEPSEEK_API_KEY`).
  Shows each provider-reported currency balance.
- **GitHub Copilot**: OAuth tokens in auth profiles.
- **Gemini CLI**: OAuth tokens in auth profiles.
- **MiniMax**: API key or MiniMax OAuth auth profile. OpenClaw treats
  `minimax`, `minimax-cn`, and `minimax-portal` as the same MiniMax quota
  surface, prefers stored MiniMax OAuth when present, and otherwise falls back
  to `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, or `MINIMAX_API_KEY`.
  Usage polling derives the Coding Plan host from `models.providers.minimax-portal.baseUrl`
  or `models.providers.minimax.baseUrl` when configured, and otherwise uses the
  MiniMax CN host.
  MiniMax's raw `usage_percent` / `usagePercent` fields mean **remaining**
  quota, so OpenClaw inverts them before display; count-based fields win when
  present.
  - Window labels come from provider hours/minutes fields when present, then
    fall back to the `start_time` / `end_time` span.
  - If the coding-plan endpoint returns `model_remains`, OpenClaw prefers the
    chat-model entry, derives the window label from timestamps when explicit
    `window_hours` / `window_minutes` fields are absent, and includes the model
    name in the plan label.
- **OpenAI (Codex/ChatGPT plan)**: OAuth tokens in auth profiles (`ChatGPT-Account-Id`
  header sent when an account id is present). Shows the ChatGPT plan, resettable
  Codex windows, and a credit balance when reported. Credits remain provider
  credits; OpenClaw does not label them as dollars. `OPENAI_ADMIN_KEY` adds
  30-day organization cost and completions-usage history when the key has Usage
  Dashboard access. Inference credentials are never forwarded to organization APIs.
- **OpenRouter**: API key or OAuth-backed API key (`OPENROUTER_API_KEY` or an auth
  profile). Combines the account credits endpoint with the key quota endpoint,
  so account balance/spend, key budget, and daily/weekly/monthly usage appear
  when the credential can access them. Either endpoint can enrich the snapshot
  independently.
- **Venice**: API key via env/config/auth store (`VENICE_API_KEY`). Shows USD and
  DIEM balances plus DIEM epoch allocation usage when reported.
- **Xiaomi MiMo**: two separate usage surfaces. Pay-as-you-go uses an API key
  (`XIAOMI_API_KEY`); the Token Plan uses a separate key (`XIAOMI_TOKEN_PLAN_API_KEY`).
  Neither currently reports quota windows.
- **z.ai**: API key via env/config/auth store (`ZAI_API_KEY` or `Z_AI_API_KEY`).

## Related

- [Token use and costs](/reference/token-use)
- [API usage and costs](/reference/api-usage-costs)
- [Prompt caching](/reference/prompt-caching)
- [Menu bar](/platforms/mac/menu-bar)
