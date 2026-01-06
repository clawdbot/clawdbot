---
summary: "Plan for models CLI: scan, list, aliases, fallbacks, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
---
# Models CLI plan

Goal: give clear model visibility + control (configured vs available), plus scan tooling
that prefers tool-call + image-capable models and maintains ordered fallbacks.

## Command tree (draft)

- `clawdbot models list`
  - default: configured models only
  - flags: `--all` (full catalog), `--local`, `--provider <name>`, `--json`, `--plain`
- `clawdbot models status`
  - show default model + aliases + fallbacks + configured models
- `clawdbot models set <modelOrAlias>`
  - writes `agent.model.primary` and ensures `agent.models` entry
- `clawdbot models set-image <modelOrAlias>`
  - writes `agent.imageModel.primary` and ensures `agent.models` entry
- `clawdbot models aliases list|add|remove`
  - writes `agent.models.*.alias`
- `clawdbot models fallbacks list|add|remove|clear`
  - writes `agent.model.fallbacks`
- `clawdbot models image-fallbacks list|add|remove|clear`
  - writes `agent.imageModel.fallbacks`
- `clawdbot models scan`
  - OpenRouter :free scan; probe tool-call + image; interactive selection

## Config changes

- `agent.models` (configured model catalog + aliases).
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
- See `docs/model-failover.md` for auth profile rotation, cooldowns, and timeout handling.

## Tests

- Unit: scan selection ordering + probe classification.
- CLI: list/aliases/fallbacks add/remove + scan writes config.
- Status: shows last used model + fallbacks.

## Docs

- Update `docs/configuration.md` with `agent.models` + `agent.model` + `agent.imageModel`.
- Keep this doc current when CLI surface or scan logic changes.
