---
summary: "Models CLI: list, set, aliases, fallbacks, scan, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
title: "Models CLI"
---

See [/concepts/model-failover](/concepts/model-failover) for auth profile
rotation, cooldowns, and how that interacts with fallbacks.
Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

## How model selection works

OpenClaw selects models in this order:

1. **Primary** model (`agents.defaults.model.primary` or `agents.defaults.model`).
2. **Fallbacks** in `agents.defaults.model.fallbacks` (in order).
3. **Provider auth failover** happens inside a provider before moving to the
   next model.

Related:

- `agents.defaults.models` is the allowlist/catalog of models OpenClaw can use (plus aliases).
- `agents.defaults.imageModel` is used **only when** the primary model can’t accept images.
- `agents.defaults.pdfModel` is used by the `pdf` tool. If omitted, the tool
  falls back to `agents.defaults.imageModel`, then the resolved session/default
  model.
- `agents.defaults.imageGenerationModel` is used by the shared image-generation capability. If omitted, `image_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered image-generation providers in provider-id order. If you set a specific provider/model, also configure that provider's auth/API key.
- `agents.defaults.musicGenerationModel` is used by the shared music-generation capability. If omitted, `music_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered music-generation providers in provider-id order. If you set a specific provider/model, also configure that provider's auth/API key.
- `agents.defaults.videoGenerationModel` is used by the shared video-generation capability. If omitted, `video_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered video-generation providers in provider-id order. If you set a specific provider/model, also configure that provider's auth/API key.
- Per-agent defaults can override `agents.defaults.model` via `agents.list[].model` plus bindings (see [/concepts/multi-agent](/concepts/multi-agent)).

## Quick model policy

- Set your primary to the strongest latest-generation model available to you.
- Use fallbacks for cost/latency-sensitive tasks and lower-stakes chat.
- For tool-enabled agents or untrusted inputs, avoid older/weaker model tiers.

## Onboarding (recommended)

If you don’t want to hand-edit config, run onboarding:

```bash
openclaw onboard
```

It can set up model + auth for common providers, including **OpenAI Code (Codex)
subscription** (OAuth) and **Anthropic** (API key or Claude CLI).

## Config keys (overview)

- `agents.defaults.model.primary` and `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` and `agents.defaults.imageModel.fallbacks`
- `agents.defaults.pdfModel.primary` and `agents.defaults.pdfModel.fallbacks`
- `agents.defaults.imageGenerationModel.primary` and `agents.defaults.imageGenerationModel.fallbacks`
- `agents.defaults.videoGenerationModel.primary` and `agents.defaults.videoGenerationModel.fallbacks`
- `agents.defaults.models` (allowlist + aliases + provider params)
- `models.providers` (custom providers written into `models.json`)

Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize
to `zai/*`.

Provider configuration examples (including OpenCode) live in
[/providers/opencode](/providers/opencode).

### Safe allowlist edits

Use additive writes when updating `agents.defaults.models` by hand:

```bash
openclaw config set agents.defaults.models '{"openai/gpt-5.4":{}}' --strict-json --merge
```

`openclaw config set` protects model/provider maps from accidental clobbers. A
plain object assignment to `agents.defaults.models`, `models.providers`, or
`models.providers.<id>.models` is rejected when it would remove existing
entries. Use `--merge` for additive changes; use `--replace` only when the
provided value should become the complete target value.

Interactive provider setup and `openclaw configure --section model` also merge
provider-scoped selections into the existing allowlist, so adding Codex,
Ollama, or another provider does not drop unrelated model entries.

## "Model is not allowed" (and why replies stop)

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for
session overrides. When a user selects a model that isn’t in that allowlist,
OpenClaw returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

This happens **before** a normal reply is generated, so the message can feel
like it “didn’t respond.” The fix is to either:

- Add the model to `agents.defaults.models`, or
- Clear the allowlist (remove `agents.defaults.models`), or
- Pick a model from `/model list`.

Example allowlist config:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-6" },
    models: {
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Switching models in chat (`/model`)

You can switch models for the current session without restarting:

```
/model
/model list
/model 3
/model openai/gpt-5.4
/model status
```

Notes:

- `/model` (and `/model list`) is a compact, numbered picker (model family + available providers).
- On Discord, `/model` and `/models` open an interactive picker with provider and model dropdowns plus a Submit step.
- `/models add` is available by default and can be disabled with `commands.modelsWrite=false`.
- When enabled, `/models add <provider> <modelId>` is the fastest path; bare `/models add` starts a provider-first guided flow where supported.
- After `/models add`, the new model becomes available in `/models` and `/model` without restarting the gateway.
- `/model <#>` selects from that picker.
- `/model` persists the new session selection immediately.
- If the agent is idle, the next run uses the new model right away.
- If a run is already active, OpenClaw marks a live switch as pending and only restarts into the new model at a clean retry point.
- If tool activity or reply output has already started, the pending switch can stay queued until a later retry opportunity or the next user turn.
- `/model status` is the detailed view (auth candidates and, when configured, provider endpoint `baseUrl` + `api` mode).
- Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.
- If the model ID itself contains `/` (OpenRouter-style), you must include the provider prefix (example: `/model openrouter/moonshotai/kimi-k2`).
- If you omit the provider, OpenClaw resolves the input in this order:
  1. alias match
  2. unique configured-provider match for that exact unprefixed model id
  3. deprecated fallback to the configured default provider
     If that provider no longer exposes the configured default model, OpenClaw
     instead falls back to the first configured provider/model to avoid
     surfacing a stale removed-provider default.

Full command behavior/config: [Slash commands](/tools/slash-commands).

Examples:

```text
/models add
/models add ollama glm-5.1:cloud
/models add lmstudio qwen/qwen3.5-9b
```

## CLI commands

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (no subcommand) is a shortcut for `models status`.

### `models list`

Shows configured models by default. Useful flags:

- `--all`: full catalog
- `--local`: local providers only
- `--provider <id>`: filter by provider id, for example `moonshot`; display
  labels from interactive pickers are not accepted
- `--plain`: one model per line
- `--json`: machine‑readable output

`--all` includes bundled provider-owned static catalog rows before auth is
configured, so discovery-only views can show models that are unavailable until
you add matching provider credentials.

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview
of configured providers. It also surfaces OAuth expiry status for profiles found
in the auth store (warns within 24h by default). `--plain` prints only the
resolved primary model.
OAuth status is always shown (and included in `--json` output). If a configured
provider has no credentials, `models status` prints a **Missing auth** section.
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`
(effective auth per provider, including env-backed credentials). `auth.oauth`
is auth-store profile health only; env-only providers do not appear there.
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).
Use `--probe` for live auth checks; probe rows can come from auth profiles, env
credentials, or `models.json`.
If explicit `auth.order.<provider>` omits a stored profile, probe reports
`excluded_by_auth_order` instead of trying it. If auth exists but no probeable
model can be resolved for that provider, probe reports `status: no_model`.

Auth choice is provider/account dependent. For always-on gateway hosts, API
keys are usually the most predictable; Claude CLI reuse and existing Anthropic
OAuth/token profiles are also supported.

Example (Claude CLI):

```bash
claude auth login
openclaw models status
```

## Scanning (OpenRouter free models)

`openclaw models scan` inspects OpenRouter’s **free model catalog** and can
optionally probe models for tool and image support.

Key flags:

- `--no-probe`: skip live probes (metadata only)
- `--min-params <b>`: minimum parameter size (billions)
- `--max-age-days <days>`: skip older models
- `--provider <name>`: provider prefix filter
- `--max-candidates <n>`: fallback list size
- `--set-default`: set `agents.defaults.model.primary` to the first selection
- `--set-image`: set `agents.defaults.imageModel.primary` to the first image selection

Probing requires an OpenRouter API key (from auth profiles or
`OPENROUTER_API_KEY`). Without a key, use `--no-probe` to list candidates only.

Scan results are ranked by:

1. Image support
2. Tool latency
3. Context size
4. Parameter count

Input

- OpenRouter `/models` list (filter `:free`)
- Requires OpenRouter API key from auth profiles or `OPENROUTER_API_KEY` (see [/environment](/help/environment))
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe controls: `--timeout`, `--concurrency`

When run in a TTY, you can select fallbacks interactively. In non‑interactive
mode, pass `--yes` to accept defaults.

## Models registry (`models.json`)

Custom providers in `models.providers` are written into `models.json` under the
agent directory (default `~/.openclaw/agents/<agentId>/agent/models.json`). This file
is merged by default unless `models.mode` is set to `replace`.

Merge mode precedence for matching provider IDs:

- Non-empty `baseUrl` already present in the agent `models.json` wins.
- Non-empty `apiKey` in the agent `models.json` wins only when that provider is not SecretRef-managed in current config/auth-profile context.
- SecretRef-managed provider `apiKey` values are refreshed from source markers (`ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs) instead of persisting resolved secrets.
- SecretRef-managed provider header values are refreshed from source markers (`secretref-env:ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs).
- Empty or missing agent `apiKey`/`baseUrl` fall back to config `models.providers`.
- Other provider fields are refreshed from config and normalized catalog data.

Marker persistence is source-authoritative: OpenClaw writes markers from the active source config snapshot (pre-resolution), not from resolved runtime secret values.
This applies whenever OpenClaw regenerates `models.json`, including command-driven paths like `openclaw agent`.

## Related

- [Model Providers](/concepts/model-providers) — provider routing and auth
- [Model Failover](/concepts/model-failover) — fallback chains
- [Image Generation](/tools/image-generation) — image model configuration
- [Music Generation](/tools/music-generation) — music model configuration
- [Video Generation](/tools/video-generation) — video model configuration
- [Configuration Reference](/gateway/config-agents#agent-defaults) — model config keys
