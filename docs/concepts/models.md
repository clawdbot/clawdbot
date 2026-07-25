---
summary: "How OpenClaw resolves provider/model refs, config keys, and the `/model` chat command"
read_when:
  - Changing model fallback behavior or selection UX
  - Debugging "model is not allowed" or a stale default provider fallback
  - Working on models.json merge/secret behavior
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
  <Card title="Models CLI reference" href="/cli/models">
    Full `openclaw models` command and flag reference.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults">
    Model config keys, defaults, and examples.
  </Card>
</CardGroup>

A model ref (`provider/model`) chooses a provider and model, not the low-level
agent runtime. With runtime policy unset or `auto`, OpenAI's provider-owned
route policy may select Codex only for an exact official HTTPS Platform
Responses or ChatGPT Responses route with no authored request override; the
`openai/*` prefix alone never selects Codex. Completions adapters, custom
endpoints, and authored request behavior stay on OpenClaw. Plaintext official
HTTP endpoints are rejected. See [OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).

Subscription Copilot refs (`github-copilot/*`) can be opted into the external
GitHub Copilot agent runtime plugin, but that path is always explicit (never
selected by `auto`). Runtime overrides belong on provider/model policy, not on
the whole agent or session. Runtime selection does not determine billing:
OpenAI API-key and ChatGPT/Codex subscription credentials remain distinct. See
[Agent runtimes](/concepts/agent-runtimes) and
[GitHub Copilot agent runtime](/plugins/copilot).

## Selection order

<Steps>
  <Step title="Primary model">
    `agents.defaults.model.primary` (or `agents.defaults.model` as a plain string).
  </Step>
  <Step title="Fallbacks">
    `agents.defaults.model.fallbacks`, tried in order.
  </Step>
  <Step title="Auth failover">
    Auth-profile rotation happens inside a provider before OpenClaw moves to the next fallback model.
  </Step>
</Steps>

Related model-config surfaces:

- `agents.defaults.models` stores aliases and per-model settings. Adding an entry does not restrict model overrides.
- `agents.defaults.modelPolicy.allow` is the optional override allowlist. Use exact refs or trailing prefix wildcards such as `provider/*` and `provider/namespace/*`; omit it or set `[]` to allow any model. Per-agent `agents.entries.*.modelPolicy.allow` replaces the default policy for that agent.
- `agents.defaults.utilityModel` is an optional lower-cost model for short internal tasks such as generated dashboard session titles, supported channel thread/topic titles, and progress narration. Per-agent `agents.entries.*.utilityModel` overrides it. When unset, OpenClaw uses the primary provider's declared small-model default when one exists (OpenAI → `gpt-5.6-luna`, Anthropic → `claude-haiku-4-5`), otherwise the agent's primary model; set it to an empty string to disable utility routing. Generated titles retry once with the primary model when a distinct utility model fails. For dashboard titles, automatic utility derivation and the regular fallback follow the effective session provider and auth profile; an explicit utility model keeps its configured provider/auth. An empty utility model skips only the alternate small-model route, not dashboard title generation. Utility tasks are separate model calls and may send bounded task content to the selected model provider.
- `agents.defaults.imageModel` is used only when the primary model cannot accept images.
- `agents.defaults.pdfModel` is used by the `pdf` tool. If unset, the tool falls back to `imageModel`, then the resolved session/default model.
- `agents.defaults.mediaModels.{image,music,video}` backs the shared media-generation tools. If unset, each tool infers an auth-backed provider default: current default provider first, then the remaining registered providers for that capability in provider-id order. Cross-provider fallback is the fixed default behavior.
- Per-agent `agents.entries.*.model` (plus bindings) overrides `agents.defaults.model` — see [Multi-agent routing](/concepts/multi-agent).

Full key reference, defaults, and JSON5 examples: [Configuration reference](/gateway/config-agents#agent-defaults).

## Selection source and fallback strictness

The same `provider/model` behaves differently depending on where it came from:

| Source                                                                  | Behavior                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured default (`agents.defaults.model.primary`, per-agent primary) | Normal starting point; uses `agents.defaults.model.fallbacks`.                                                                                                                                                                                                 |
| Auto fallback                                                           | Temporary recovery state, stored as `modelOverrideSource: "auto"`. OpenClaw periodically reprobes the original primary, clears the auto selection on recovery, and announces fallback/recovery transitions once per state change.                              |
| User session selection                                                  | Exact and strict. `/model`, the model picker, `session_status(model=...)`, and `sessions.patch` store `modelOverrideSource: "user"`. If that provider/model becomes unreachable, the run fails visibly instead of falling through to another configured model. |
| Cron `--model` / payload `model`                                        | Per-job primary. Still uses configured fallbacks unless the job supplies its own payload `fallbacks` (`fallbacks: []` forces a strict run).                                                                                                                    |

Other selection rules:

- Changing `agents.defaults.model.primary` does not rewrite existing session pins. If status reports `This session is pinned to X; config primary Y will apply to new/unpinned sessions.`, run `/model default` to clear the pin.
- CLI default-model and allowlist pickers respect `models.mode: "replace"` by listing only `models.providers.*.models` instead of the full built-in catalog.
- The Control UI model picker asks the Gateway for its configured model view. An explicit `modelPolicy.allow` filters it, including trailing prefix wildcard entries; otherwise it shows configured models plus providers with usable auth. The full built-in catalog is reserved for explicit browse views (`models.list` with `view: "all"`, or `openclaw models list --all`).
- Provider inventory UIs use `models.list` with `view: "provider-config"` to show source-authored `models.providers.*.models` rows without applying picker allowlists.

Full mechanics: [Model failover](/concepts/model-failover).

## Quick model policy

- Set your primary to the strongest latest-generation model available to you.
- Use fallbacks for cost/latency-sensitive tasks and lower-stakes chat.
- For tool-enabled agents or untrusted inputs, avoid older/weaker model tiers.

## Onboarding

```bash
openclaw onboard
```

Sets up model and auth for common providers without hand-editing config, including OpenAI Codex subscription OAuth and Anthropic (API key or Claude CLI reuse).

With no primary model configured, fresh OpenAI API-key setup selects
`openai/gpt-5.6`; the bare direct-API id resolves to the Sol tier. Fresh
ChatGPT/Codex OAuth setup selects the exact `openai/gpt-5.6-sol` catalog ref.
Reauthentication preserves an existing explicit primary model, including
`openai/gpt-5.5`. If GPT-5.6 is unavailable to the account, select
`openai/gpt-5.5` explicitly; OpenClaw does not silently downgrade it.

## "Model is not allowed" (and why replies stop)

If `agents.defaults.modelPolicy.allow` is non-empty, it becomes the allowlist for `/model`, session overrides, and `--model`. Selecting a model outside that allowlist returns before any normal reply is generated. A per-agent `agents.entries.*.modelPolicy.allow` replaces the default policy for that agent.

```text
Model override "provider/model" is not allowed by agents.defaults.modelPolicy.allow.
Add "provider/model", "provider/*", or a narrower "provider/namespace/*" prefix to agents.defaults.modelPolicy.allow, or remove/empty the list to allow any model.
```

Fix it by adding the model or a provider wildcard to the named `modelPolicy.allow` key, removing/emptying that list, or picking a model from `/model list`. If the rejected command included a runtime override such as `/model openai/gpt-5.5 --runtime codex`, fix the allowlist first, then retry the same command.

For local/GGUF models, the allowlist needs the full provider-prefixed ref, for example `ollama/gemma4:26b` or `lmstudio/Gemma4-26b-a4-it-gguf` — check `openclaw models list --provider <provider>` for the exact string. Bare filenames or display names are not enough once the allowlist is active.

To limit providers without listing every model, use trailing prefix wildcard entries. A provider-wide `provider/*` matches every model under that provider; a narrower prefix such as `clawrouter/anthropic/*` matches only that namespace:

```json5
{
  agents: {
    defaults: {
      modelPolicy: {
        allow: ["openai/*", "vllm/*"],
      },
    },
  },
}
```

`/model`, `/models`, and model pickers then show the discovered catalog for those providers only, and new models can appear without editing the allowlist. Mix exact `provider/model` entries with `provider/*` entries to pull in one specific model from another provider.

Example allowlist with aliases and per-model settings:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      modelPolicy: {
        allow: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
}
```

<Accordion title="Edit the allowlist explicitly">
Set the complete list directly:

```bash
openclaw config set agents.defaults.modelPolicy.allow '["openai/gpt-5.4","anthropic/*"]' --strict-json
```

`openclaw models set`, provider setup, and `openclaw models aliases add` can add entries under `agents.defaults.models`, but they never change `modelPolicy.allow`. This keeps model metadata and aliases independent from override policy.
</Accordion>

## `/model` in chat

```text
/model
/model list
/model 3
/model openai/gpt-5.4
/model default
/model status
```

- `/model` and `/model list` show a compact numbered picker (model family + available providers); `/model <#>` selects from it. On Discord this opens provider/model dropdowns with a Submit step; on Telegram, picker selections are session-scoped and never rewrite the agent's persistent default in `openclaw.json`. `/models add` is deprecated and returns a message instead of registering models from chat.
- `/model` persists the new session selection immediately. If the agent is idle, the next run uses it right away; if a run is already active, the switch is queued for the next clean retry point (or a later one, if tool activity or reply output already started).
- `/model default` clears the session selection so it inherits the configured primary again.
- A user-selected `/model` ref is strict for that session: if it becomes unreachable, the reply fails visibly instead of silently falling back through `agents.defaults.model.fallbacks`. Configured defaults and cron job primaries still use fallback chains.
- `/model status` is the detailed view: auth candidates per provider, and (when configured) the provider endpoint `baseUrl` plus `api` mode.
- Model refs are parsed by splitting on the first `/`; type `provider/model`. If the model ID itself contains `/` (OpenRouter-style), include the provider prefix, e.g. `/model openrouter/moonshotai/kimi-k2`. If you omit the provider, OpenClaw tries: (1) alias match, (2) unique configured-provider match for that exact unprefixed model id, (3) the configured default provider (deprecated fallback) — and if that provider no longer exposes the configured default model, the first configured provider/model instead, to avoid surfacing a stale removed-provider default.
- Model refs are normalized to lowercase; provider IDs are otherwise exact, so use the ID advertised by the plugin.

Full command behavior and config: [Slash commands](/tools/slash-commands).

## CLI

```bash
openclaw models status
openclaw models list
openclaw models set <provider/model>
openclaw models set-image <provider/model>
openclaw models scan
openclaw models aliases list|add|remove
openclaw models fallbacks list|add|remove|clear
openclaw models image-fallbacks list|add|remove|clear
openclaw models auth list|add|login|paste-api-key|paste-token|setup-token|order
```

`openclaw models` with no subcommand is a shortcut for `models status`, which also surfaces OAuth expiry for auth-store profiles (warns within 24h by default). Full flags, JSON shapes, and auth-profile subcommands: [Models CLI reference](/cli/models).

<AccordionGroup>
  <Accordion title="Scanning (OpenRouter free models)">
    `openclaw models scan` inspects OpenRouter's public free-model catalog and can probe candidates for tool and image support live. The catalog itself is public, so metadata-only scans (`--no-probe`) need no key; live probing and `--set-default`/`--set-image` require an OpenRouter API key (auth profile or `OPENROUTER_API_KEY`) and fail closed to metadata-only output without one.

    Results rank by: image support, then tool latency, then context size, then parameter count. In a TTY, probed results prompt an interactive fallback selection; non-interactive mode needs `--yes` to accept defaults.

  </Accordion>
</AccordionGroup>

## Models registry (`models.json`)

Custom providers configured under `models.providers` are written into `models.json` under the agent directory (default `~/.openclaw/agents/<agentId>/agent/models.json`). Provider-plugin catalogs are stored separately as generated plugin-owned catalog shards and load automatically. This file is merged with config by default; set `models.mode: "replace"` to use only your configured providers.

<AccordionGroup>
  <Accordion title="Merge mode precedence">
    For matching provider IDs:

    - A non-empty `baseUrl` already present in the agent `models.json` wins.
    - A non-empty `apiKey` in `models.json` wins only when that provider is not SecretRef-managed in the current config/auth-profile context.
    - SecretRef-managed `apiKey` values refresh from source markers instead of persisting resolved secrets: the env variable name for env refs, `secretref-managed` for file/exec refs.
    - SecretRef-managed header values refresh the same way, using `secretref-env:ENV_VAR_NAME` for env refs.
    - Empty or missing `apiKey`/`baseUrl` in `models.json` fall back to config `models.providers`.
    - Other provider fields refresh from config and normalized catalog data.

  </Accordion>
</AccordionGroup>

Marker persistence is source-authoritative: OpenClaw writes markers from the active source config snapshot (pre-resolution), not from resolved runtime secret values, whenever it regenerates `models.json` — including command-driven paths like `openclaw agent`.

## Related

- [Agent runtimes](/concepts/agent-runtimes) — OpenClaw, Codex, and other agent loop runtimes
- [Configuration reference](/gateway/config-agents#agent-defaults) — model config keys
- [Image generation](/tools/image-generation) — image model configuration
- [Model failover](/concepts/model-failover) — fallback chains
- [Model providers](/concepts/model-providers) — provider routing and auth
- [Models CLI reference](/cli/models) — full command and flag reference
- [Music generation](/tools/music-generation) — music model configuration
- [Video generation](/tools/video-generation) — video model configuration
