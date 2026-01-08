---
summary: "Plan for models CLI: scan, list, aliases, fallbacks, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
---
# Models CLI plan

See [`docs/model-failover.md`](/concepts/model-failover) for how auth profiles rotate (OAuth vs API keys), cooldowns, and how that interacts with model fallbacks.

Goal: give clear model visibility + control (configured vs available), plus scan tooling
that prefers tool-call + image-capable models and maintains ordered fallbacks.

## How Clawdbot models work (quick explainer)

Clawdbot selects models in this order:
1) The configured **primary** model (`agent.model.primary`).
2) If it fails, fallbacks in `agent.model.fallbacks` (in order).
3) Auth failover happens **inside** the provider first (see [/concepts/model-failover](/concepts/model-failover)).

Key pieces:
- `provider/model` is the canonical model id (e.g. `anthropic/claude-opus-4-5`).
- `agent.models` is the **allowlist/catalog** of models Clawdbot can use, with optional aliases and provider params.
- `agent.imageModel` is only used when the primary model **can’t** accept images.
- `models.providers` lets you add custom providers + models (written to `models.json`).
- `/model <id>` switches the active model for the current session; `/model list` shows what’s allowed.

Related:
- Context limits are model-specific; long sessions may trigger compaction. See [/concepts/compaction](/concepts/compaction).

## Model recommendations

- [Claude Opus 4.5](https://www.anthropic.com/claude/opus): default primary for assistant + general work. It’s pricey and cap-prone, so consider the [Claude Max $200 subscription](https://www.anthropic.com/pricing/) if you live here.
- [Claude Sonnet 4.5](https://www.anthropic.com/claude/sonnet): default fallback when Opus caps out. Similar behavior with fewer limit headaches.
- [GPT-5.2-Codex](https://developers.openai.com/codex/models): recommended for coding and sub-agents. Prefer the [Codex CLI](https://developers.openai.com/codex/cli) if you want the strongest feel.

Suggested stacks:
- Assistant-first: Opus 4.5 primary → Sonnet 4.5 fallback.
- Agentic coding: Opus 4.5 primary → GPT-5.2-Codex for sub-agents → Sonnet 4.5 fallback.

## Model discussions (community notes)

Anecdotal notes from the Discord thread on January 4–5, 2026. Treat as “reported by users,” not a benchmark.

**Reported working well**
- [Claude Opus 4.5](https://www.anthropic.com/claude/opus): best overall quality in Clawdbot, especially for “assistant” work. Tradeoff is cost and hitting usage limits quickly.
- [Claude Sonnet 4.5](https://www.anthropic.com/claude/sonnet): common fallback when Opus caps out. Similar behavior with fewer limit headaches.
- [Gemini 3 Pro](https://deepmind.google/en/models/gemini/pro/): some users felt it maps well to Clawdbot’s structure. Vibe was “fits the framework” more than “best at everything.”
- [GLM](https://www.zhipuai.cn/en/): used successfully as a worker model under orchestration. Seen as strong for delegated/secondary tasks, not the primary brain.
- [MiniMax M2.1](https://platform.minimax.io/docs/guides/models-intro): “good enough” for grunt work or a cheap fallback. Community nickname was “Temu-Sonnet,” i.e. usable but not Sonnet-level polish.

**Mixed / unclear**
- [Antigravity](https://blog.google/technology/ai/google-ai-updates-november-2025/) (Claude Opus access): some reported extra Opus quota. Pricing/limits were unclear, so the value is hard to predict.

**Reported weak in Clawdbot**
- [GPT-5.2-Codex](https://developers.openai.com/codex/models) inside Clawdbot: reported as rough for conversation/assistant tasks when embedded. Same notes said Codex felt stronger via the [Codex CLI](https://developers.openai.com/codex/cli) than embedded use.
- [Grok](https://docs.x.ai/docs/models/grok-4): people tried it and then abandoned it. No strong upside showed up in the notes.

**Theme**
- Token burn feels higher than expected in long sessions; people suspect context buildup + tool outputs. Pruning/compaction helps. Check session logs before blaming providers. See [/concepts/session](/concepts/session) and [/concepts/model-failover](/concepts/model-failover).

Want a tailored stack? Share whether you’re using Clawdbot or Clawdis and your main workload (agentic coding vs “assistant” work), and we can suggest a primary + fallback set based on these reports.

## Models CLI

See [/cli](/cli) for the full command tree and CLI flags.

### CLI output (list + status)

`clawdbot models list` (default) prints a table with these columns:
- `Model`: `provider/model` key (truncated in TTY).
- `Input`: `text` or `text+image`.
- `Ctx`: context window in K tokens (from the model registry).
- `Local`: `yes/no` when the provider base URL is local.
- `Auth`: `yes/no` when the provider has usable auth.
- `Tags`: origin + role hints.

Common tags:
- `default` — resolved default model.
- `fallback#N` — `agent.model.fallbacks` order.
- `image` — `agent.imageModel.primary`.
- `img-fallback#N` — `agent.imageModel.fallbacks` order.
- `configured` — present in `agent.models`.
- `alias:<name>` — alias from `agent.models.*.alias`.
- `missing` — referenced in config but not found in the registry.

Output formats:
- `--plain`: prints only `provider/model` keys (one per line).
- `--json`: `{ count, models: [{ key, name, input, contextWindow, local, available, tags, missing }] }`.

`clawdbot models status` prints the resolved defaults, fallbacks, image model, aliases,
and an **Auth overview** section showing which providers have profiles/env/models.json keys.
`--plain` prints the resolved default model only; `--json` returns a structured object for tooling.

## Config changes

- `agent.models` (configured model catalog + aliases).
- `agent.models.*.params` (provider-specific API params passed through to requests).
- `agent.model.primary` + `agent.model.fallbacks`.
- `agent.imageModel.primary` + `agent.imageModel.fallbacks` (optional).
- `auth.profiles` + `auth.order` for per-provider auth failover.

## Scan behavior (models scan)

Input
- OpenRouter `/models` list (filter `:free`)
- Requires OpenRouter API key from auth profiles or `OPENROUTER_API_KEY`
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe controls: `--timeout`, `--concurrency`

Probes (direct pi-ai complete)
- Tool-call probe (required):
  - Provide a dummy tool, verify tool call emitted.
- Image probe (preferred):
  - Prompt includes 1x1 PNG; success if no "unsupported image" error.

Scoring/selection
- Prefer models passing tool + image for text/tool fallbacks.
- Prefer image-only models for image tool fallback (even if tool probe fails).
- Rank by: image ok, then lower tool latency, then larger context, then params.

Interactive selection (TTY)
- Multiselect list with per-model stats:
  - model id, tool ok, image ok, median latency, context, inferred params.
- Pre-select top N (default 6).
- Non-TTY: auto-select; require `--yes`/`--no-input` to apply.

Output
- Writes `agent.model.fallbacks` ordered.
- Writes `agent.imageModel.fallbacks` ordered (image-capable models).
- Ensures `agent.models` entries exist for selected models.
- Optional `--set-default` to set `agent.model.primary`.
- Optional `--set-image` to set `agent.imageModel.primary`.

## Runtime fallback

- On model failure: try `agent.model.fallbacks` in order.
- Per-provider auth failover uses `auth.order` (or stored profile order) **before**
  moving to the next model.
- Image routing uses `agent.imageModel` **only when configured** and the primary
  model lacks image input.
- Persist last successful provider/model to session entry; auth profile success is global.
- See [`docs/model-failover.md`](/concepts/model-failover) for auth profile rotation, cooldowns, and timeout handling.

## Tests

- Unit: scan selection ordering + probe classification.
- CLI: list/aliases/fallbacks add/remove + scan writes config.
- Status: shows last used model + fallbacks.

## Docs

- Update [`docs/configuration.md`](/gateway/configuration) with `agent.models` + `agent.model` + `agent.imageModel`.
- Keep this doc current when CLI surface or scan logic changes.
- Note provider aliases like `z.ai/*` -> `zai/*` when relevant.
- Provider ids in model refs are normalized to lowercase.
