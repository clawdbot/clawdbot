---
summary: "Models CLI: list, set, aliases, fallbacks, scan, status"
read_when:
  - Adding or modifying models CLI (models list/set/scan/aliases/fallbacks)
  - Changing model fallback behavior or selection UX
  - Updating model scan probes (tools/images)
title: "Models CLI"
sidebarTitle: "Models CLI"
---

<CardGroup cols={2}>
  <Card title="Model failover" href="/concepts/model-failover">
    Auth profile rotation, cooldowns, and how that interacts with fallbacks.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers">
    Quick provider overview and examples.
  </Card>
  <Card title="Agent runtimes" href="/concepts/agent-runtimes">
    PI, Codex, and other agent loop runtimes.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults">
    Model config keys.
  </Card>
</CardGroup>

Model refs choose a provider and model. They do not usually choose the low-level agent runtime. OpenAI agent refs are the main exception: `openai/gpt-5.5` runs through the Codex app-server runtime by default on the official OpenAI provider. Explicit runtime overrides belong on provider/model policy, not on the whole agent or session. In Codex runtime mode, the `openai/gpt-*` ref does not imply API-key billing; auth can come from a Codex account or `openai-codex` auth profile. See [Agent runtimes](/concepts/agent-runtimes).

## How model selection works

OpenClaw selects models in this order:

<Steps>
  <Step title="Primary model">
    `agents.defaults.model.primary` (or `agents.defaults.model`).
  </Step>
  <Step title="Fallbacks">
    `agents.defaults.model.fallbacks` (in order).
  </Step>
  <Step title="Provider auth failover">
    Auth failover happens inside a provider before moving to the next model.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Related model surfaces">
    - `agents.defaults.models` is the allowlist/catalog of models OpenClaw can use (plus aliases). Use `provider/*` entries to limit visible providers while keeping provider discovery dynamic.
    - `agents.defaults.imageModel` is used **only when** the primary model can't accept images.
    - `agents.defaults.pdfModel` is used by the `pdf` tool. If omitted, the tool falls back to `agents.defaults.imageModel`, then the resolved session/default model.
    - `agents.defaults.imageGenerationModel` is used by the shared image-generation capability. If omitted, `image_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered image-generation providers in provider-id order. If you set a specific provider/model, also configure that provider's auth/API key.
    - `agents.defaults.musicGenerationModel` is used by the shared music-generation capability. If omitted, `music_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered music-generation providers in provider-id order. If you set a specific provider/model, also configure that provider's auth/API key.
    - `agents.defaults.videoGenerationModel` is used by the shared video-generation capability. If omitted, `video_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered video-generation providers in provider-id order. If you set a specific provider/model, also configure that provider's auth/API key.
    - Per-agent defaults can override `agents.defaults.model` via `agents.list[].model` plus bindings (see [Multi-agent routing](/concepts/multi-agent)).

  </Accordion>
</AccordionGroup>

## Selection source and fallback behavior

The same `provider/model` can mean different things depending on where it came from:

- Configured defaults (`agents.defaults.model.primary` and agent-specific primaries) are the normal starting point and use `agents.defaults.model.fallbacks`.
- Auto fallback selections are temporary recovery state. They are stored with `modelOverrideSource: "auto"` so later turns can keep using the fallback chain without probing a known-bad primary first.
- User session selections are exact. `/model`, the model picker, `session_status(model=...)`, and `sessions.patch` store `modelOverrideSource: "user"`; if that selected provider/model is unreachable, OpenClaw fails visibly instead of falling through to another configured model.
- Cron `--model` / payload `model` is a per-job primary. It still uses configured fallbacks unless the job supplies explicit payload `fallbacks` (use `fallbacks: []` for a strict cron run).
- CLI default-model and allowlist pickers respect `models.mode: "replace"` by listing explicit `models.providers.*.models` instead of loading the full built-in catalog.
- The Control UI model picker asks the Gateway for its configured model view: `agents.defaults.models` when present, including provider-wide `provider/*` entries, otherwise explicit `models.providers.*.models` plus providers with usable auth. The full built-in catalog is reserved for explicit browse views such as `models.list` with `view: "all"` or `openclaw models list --all`.

## Quick model policy

- Set your primary to the strongest latest-generation model available to you.
- Use fallbacks for cost/latency-sensitive tasks and lower-stakes chat.
- For tool-enabled agents or untrusted inputs, avoid older/weaker model tiers.

## Onboarding (recommended)

If you don't want to hand-edit config, run onboarding:

```bash
openclaw onboard
```

It can set up model + auth for common providers, including **OpenAI Code (Codex) subscription** (OAuth) and **Anthropic** (API key or Claude CLI).

## Config keys (overview)

- `agents.defaults.model.primary` and `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` and `agents.defaults.imageModel.fallbacks`
- `agents.defaults.pdfModel.primary` and `agents.defaults.pdfModel.fallbacks`
- `agents.defaults.imageGenerationModel.primary` and `agents.defaults.imageGenerationModel.fallbacks`
- `agents.defaults.videoGenerationModel.primary` and `agents.defaults.videoGenerationModel.fallbacks`
- `agents.defaults.models` (allowlist + aliases + provider params + `provider/*` dynamic provider entries)
- `models.providers` (custom providers written into `models.json`)

<Note>
Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize to `zai/*`.

Provider configuration examples (including OpenCode) live in [OpenCode](/providers/opencode).
</Note>

### Safe allowlist edits

Use additive writes when updating `agents.defaults.models` by hand:

```bash
openclaw config set agents.defaults.models '{"openai/gpt-5.4":{}}' --strict-json --merge
```

<AccordionGroup>
  <Accordion title="Clobber protection rules">
    `openclaw config set` protects model/provider maps from accidental clobbers. A plain object assignment to `agents.defaults.models`, `models.providers`, or `models.providers.<id>.models` is rejected when it would remove existing entries. Use `--merge` for additive changes; use `--replace` only when the provided value should become the complete target value.

    Interactive provider setup and `openclaw configure --section model` also merge provider-scoped selections into the existing allowlist, so adding Codex, Ollama, or another provider does not drop unrelated model entries. Configure preserves an existing `agents.defaults.model.primary` when provider auth is re-applied. Explicit default-setting commands such as `openclaw models auth login --provider <id> --set-default` and `openclaw models set <model>` still replace `agents.defaults.model.primary`.

  </Accordion>
</AccordionGroup>

## "Model is not allowed" (and why replies stop)

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for session overrides. When a user selects a model that isn't in that allowlist, OpenClaw returns:

```
Model "provider/model" is not allowed. Use /models to list providers, or /models <provider> to list models.
Add it with: openclaw config set agents.defaults.models '{"provider/model":{}}' --strict-json --merge
```

<Warning>
This happens **before** a normal reply is generated, so the message can feel like it "didn't respond." The fix is to either:

- Add the model to `agents.defaults.models`, or
- Clear the allowlist (remove `agents.defaults.models`), or
- Pick a model from `/model list`.

</Warning>

When the rejected command included a runtime override such as `/model openai/gpt-5.5 --runtime codex`, fix the allowlist first, then retry the same `/model ... --runtime ...` command. For native Codex execution, the selected model is still `openai/gpt-5.5`; the `codex` runtime selects the harness and uses Codex auth separately.

For local/GGUF models, store the full provider-prefixed ref in the allowlist,
for example `ollama/gemma4:26b`, `lmstudio/Gemma4-26b-a4-it-gguf`, or the
exact provider/model shown by `openclaw models list --provider <provider>`.
Bare local filenames or display names are not enough when the allowlist is
active.

If you want to limit providers without manually listing every model, add
`provider/*` entries to `agents.defaults.models`:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai-codex/*": {},
        "vllm/*": {},
      },
    },
  },
}
```

With that policy, `/model`, `/models`, and model pickers show the discovered
catalog for those providers only. New models from the selected providers can
appear without editing the allowlist. Exact `provider/model` entries can be mixed
with `provider/*` entries when you need one specific model from another provider.

Example allowlist config:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
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

<AccordionGroup>
  <Accordion title="Picker behavior">
    - `/model` (and `/model list`) is a compact, numbered picker (model family + available providers).
    - On Discord, `/model` and `/models` open an interactive picker with provider and model dropdowns plus a Submit step.
    - On Telegram, `/models` picker selections are session-scoped; they do not change the agent's persistent default in `openclaw.json`.
    - `/models add` is deprecated and now returns a deprecation message instead of registering models from chat.
    - `/model <#>` selects from that picker.

  </Accordion>
  <Accordion title="Persistence and live switching">
    - `/model` persists the new session selection immediately.
    - If the agent is idle, the next run uses the new model right away.
    - If a run is already active, OpenClaw marks a live switch as pending and only restarts into the new model at a clean retry point.
    - If tool activity or reply output has already started, the pending switch can stay queued until a later retry opportunity or the next user turn.
    - A user-selected `/model` ref is strict for that session: if the selected provider/model is unreachable, the reply fails visibly instead of silently answering from `agents.defaults.model.fallbacks`. This is different from configured defaults and cron job primaries, which can still use fallback chains.
    - `/model status` is the detailed view (auth candidates and, when configured, provider endpoint `baseUrl` + `api` mode).

  </Accordion>
  <Accordion title="Ref parsing">
    - Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.
    - If the model ID itself contains `/` (OpenRouter-style), you must include the provider prefix (example: `/model openrouter/moonshotai/kimi-k2`).
    - If you omit the provider, OpenClaw resolves the input in this order:
      1. alias match
      2. unique configured-provider match for that exact unprefixed model id
      3. deprecated fallback to the configured default provider — if that provider no longer exposes the configured default model, OpenClaw instead falls back to the first configured provider/model to avoid surfacing a stale removed-provider default.
  </Accordion>
</AccordionGroup>

Full command behavior/config: [Slash commands](/tools/slash-commands).

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

Shows configured/auth-available models by default. Useful flags:

<ParamField path="--all" type="boolean">
  Full catalog. Includes bundled provider-owned static catalog rows before auth is configured, so discovery-only views can show models that are unavailable until you add matching provider credentials.
</ParamField>
<ParamField path="--local" type="boolean">
  Local providers only.
</ParamField>
<ParamField path="--provider <id>" type="string">
  Filter by provider id, for example `moonshot`. Display labels from interactive pickers are not accepted.
</ParamField>
<ParamField path="--plain" type="boolean">
  One model per line.
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable output.
</ParamField>

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview of configured providers. It also surfaces OAuth expiry status for profiles found in the auth store (warns within 24h by default). `--plain` prints only the resolved primary model.

<AccordionGroup>
  <Accordion title="Auth and probe behavior">
    - OAuth status is always shown (and included in `--json` output). If a configured provider has no credentials, `models status` prints a **Missing auth** section.
    - JSON includes `auth.oauth` (warn window + profiles) and `auth.providers` (effective auth per provider, including env-backed credentials). `auth.oauth` is auth-store profile health only; env-only providers do not appear there.
    - Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).
    - Use `--probe` for live auth checks; probe rows can come from auth profiles, env credentials, or `models.json`.
    - If explicit `auth.order.<provider>` omits a stored profile, probe reports `excluded_by_auth_order` instead of trying it. If auth exists but no probeable model can be resolved for that provider, probe reports `status: no_model`.

  </Accordion>
</AccordionGroup>

<Note>
Auth choice is provider/account dependent. For always-on gateway hosts, API keys are usually the most predictable; Claude CLI reuse and existing Anthropic OAuth/token profiles are also supported.
</Note>

Example (Claude CLI):

```bash
claude auth login
openclaw models status
```

## Scanning (OpenRouter free models)

`openclaw models scan` inspects OpenRouter's **free model catalog** and can optionally probe models for tool and image support.

<ParamField path="--no-probe" type="boolean">
  Skip live probes (metadata only).
</ParamField>
<ParamField path="--min-params <b>" type="number">
  Minimum parameter size (billions).
</ParamField>
<ParamField path="--max-age-days <days>" type="number">
  Skip older models.
</ParamField>
<ParamField path="--provider <name>" type="string">
  Provider prefix filter.
</ParamField>
<ParamField path="--max-candidates <n>" type="number">
  Fallback list size.
</ParamField>
<ParamField path="--set-default" type="boolean">
  Set `agents.defaults.model.primary` to the first selection.
</ParamField>
<ParamField path="--set-image" type="boolean">
  Set `agents.defaults.imageModel.primary` to the first image selection.
</ParamField>

<Note>
The OpenRouter `/models` catalog is public, so metadata-only scans can list free candidates without a key. Probing and inference still require an OpenRouter API key (from auth profiles or `OPENROUTER_API_KEY`). If no key is available, `openclaw models scan` falls back to metadata-only output and leaves config unchanged. Use `--no-probe` to request metadata-only mode explicitly.
</Note>

Scan results are ranked by:

1. Image support
2. Tool latency
3. Context size
4. Parameter count

Input:

- OpenRouter `/models` list (filter `:free`)
- Live probes require OpenRouter API key from auth profiles or `OPENROUTER_API_KEY` (see [Environment variables](/help/environment))
- Optional filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Request/probe controls: `--timeout`, `--concurrency`

When live probes run in a TTY, you can select fallbacks interactively. In non-interactive mode, pass `--yes` to accept defaults. Metadata-only results are informational; `--set-default` and `--set-image` require live probes so OpenClaw does not configure an unusable keyless OpenRouter model.

## Models registry (`models.json`)

Custom providers in `models.providers` are written into `models.json` under the agent directory (default `~/.openclaw/agents/<agentId>/agent/models.json`). This file is merged by default unless `models.mode` is set to `replace`.

<AccordionGroup>
  <Accordion title="Merge mode precedence">
    Merge mode precedence for matching provider IDs:

    - Non-empty `baseUrl` already present in the agent `models.json` wins.
    - Non-empty `apiKey` in the agent `models.json` wins only when that provider is not SecretRef-managed in current config/auth-profile context.
    - SecretRef-managed provider `apiKey` values are refreshed from source markers (`ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs) instead of persisting resolved secrets.
    - SecretRef-managed provider header values are refreshed from source markers (`secretref-env:ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs).
    - Empty or missing agent `apiKey`/`baseUrl` fall back to config `models.providers`.
    - Other provider fields are refreshed from config and normalized catalog data.

  </Accordion>
</AccordionGroup>

<Note>
Marker persistence is source-authoritative: OpenClaw writes markers from the active source config snapshot (pre-resolution), not from resolved runtime secret values. This applies whenever OpenClaw regenerates `models.json`, including command-driven paths like `openclaw agent`.
</Note>

## Related

- [Agent runtimes](/concepts/agent-runtimes) — PI, Codex, and other agent loop runtimes
- [Configuration reference](/gateway/config-agents#agent-defaults) — model config keys
- [Image generation](/tools/image-generation) — image model configuration
- [Model failover](/concepts/model-failover) — fallback chains
- [Model providers](/concepts/model-providers) — provider routing and auth
- [Music generation](/tools/music-generation) — music model configuration
- [Video generation](/tools/video-generation) — video model configuration
