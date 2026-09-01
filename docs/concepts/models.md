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

- `agents.defaults.models` stores aliases and per-model settings. After legacy-policy migration, adding an entry does not restrict model overrides.
- `agents.defaults.modelSelectionScope` optionally chooses the scope of chat commands and Gateway session model updates without an explicit scope. Omit it to preserve existing behavior; see [Model selection scope](/gateway/config-agents#agentsdefaultsmodelselectionscope).
- `agents.defaults.modelPolicy.allow` is the optional override allowlist. Use exact refs or trailing prefix wildcards such as `provider/*` and `provider/namespace/*`; omit it or set `[]` to allow any model. Per-agent `agents.entries.*.modelPolicy.allow` replaces the default policy for that agent.
- `agents.defaults.utilityModel` is an optional lower-cost model for short internal tasks such as generated dashboard session titles, supported channel thread/topic titles, and progress narration. Per-agent `agents.entries.*.utilityModel` overrides it. When unset, OpenClaw uses the primary provider's declared small-model default when one exists (OpenAI → `gpt-5.6-luna`, Anthropic → `claude-haiku-4-5`), otherwise the agent's primary model; set it to an empty string to disable utility routing. Generated titles retry once with the primary model when a distinct utility model fails. For dashboard titles, automatic utility derivation and the regular fallback follow the effective session provider and auth profile; an explicit utility model keeps its configured provider/auth. An empty utility model skips only the alternate small-model route, not dashboard title generation. Utility tasks are separate model calls and may send bounded task content to the selected model provider.
- `agents.defaults.imageModel` is used only when the primary model cannot accept images.
- `agents.defaults.pdfModel` is used by the `pdf` tool. If unset, the tool falls back to `imageModel`, then the resolved session/default model.
- `agents.defaults.mediaModels.{image,music,video}` backs the shared media-generation tools. If unset, each tool infers an auth-backed provider default: current default provider first, then the remaining registered providers for that capability in provider-id order. Cross-provider fallback is the fixed default behavior.
- Per-agent `agents.entries.*.model` (plus bindings) overrides `agents.defaults.model` — see [Multi-agent routing](/concepts/multi-agent).

Full key reference, defaults, and JSON5 examples: [Configuration reference](/gateway/config-agents#agent-defaults).

For directly authored legacy model maps, `openclaw doctor --fix` copies the complete restriction into `modelPolicy.allow` when every ref is valid. If any ref needs provider qualification, Doctor preserves the entire legacy restriction and reports how to set an explicit policy. Until then, model-map edits still change the legacy restriction; no keys are silently dropped and no empty policy is substituted. Include-owned migrations retain the existing edit-owning-file requirement.

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
- The Control UI starts from the Gateway's prepared configured model view, so opening chat does not start provider discovery. Opening or refreshing a model picker may discover models required by a trailing `provider/*` policy entry. Default and configured picker views hide catalog rows marked `deprecated` or `disabled` unless that exact model is configured as a primary, fallback, utility/tool model, alias/settings key, or exact policy entry. Hidden rows remain selectable by exact `provider/model` ref. The full built-in catalog, including hidden rows, is reserved for explicit browse views (`models.list` with `view: "all"`, or `openclaw models list --all`).
- Provider inventory UIs use `models.list` with `view: "provider-config"` to show source-authored `models.providers.*.models` rows without applying picker allowlists.

Once the Gateway has discovered a provider inventory, model-selection hot reloads
retain it without running discovery again. Aliases, policy, and runtime capabilities
use the new configuration. Explicit catalog refresh replaces that inventory;
changes to its provider, plugin, auth, environment, or workspace scope invalidate it.

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

With no primary model configured, fresh OpenAI API-key and ChatGPT/Codex OAuth
setup select the exact `openai/gpt-5.6-sol` catalog ref. The bare direct-API
`openai/gpt-5.6` alias remains supported and resolves to the Sol tier.
Reauthentication preserves an existing explicit primary model, including
`openai/gpt-5.5`. If GPT-5.6 is unavailable to the account, select
`openai/gpt-5.5` explicitly; OpenClaw does not silently downgrade it.

## "Model is not allowed" (and why replies stop)

When `modelPolicy.allow` is omitted or empty, you can select an explicit
`provider/model` even when it is absent from the finite `/model` picker catalog.
The catalog supplies browse choices and model metadata; it is not an implicit
allowlist. Provider availability, runtime compatibility, and authentication are
validated independently. An unrestricted policy does not make an unknown
provider or an unsupported runtime usable. If the policy is omitted, unmigrated
legacy model-map restrictions described above still apply.

The same policy applies to explicit `provider/model` and configured-alias hints
after `/new` or `/reset`. Unrecognized leading text stays in the prompt.

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

## Choose a model for a session

Gateway `sessions.create` and `sessions.patch` resolve model aliases and
`modelPolicy.allow` in the target session's agent scope. An explicit per-agent
allowlist replaces the shared default, including `[]` to allow any model.
Policy permission does not supply provider credentials or guarantee that the
selected model is available to its runtime.

Before saving a model selection, these Gateway methods check that any required
embedded harness has an installed, activatable plugin. A missing or disabled
plugin rejects the change and preserves the previous session selection and
configured default. Install and enable the named harness plugin, restart the
Gateway, then select the model again. This check does not start the runtime or
verify provider credentials.

If an existing session's harness becomes unavailable, the failed turn reports
the owner plugin when known and its activation or loading blocker. Follow the error's
`openclaw doctor --fix` or `openclaw plugins inspect <id> --runtime --json`
guidance, repair the plugin, and restart the Gateway before retrying. Gateway
health probes remain independent of model execution; use [Models status](/cli/models)
and [Doctor](/gateway/doctor) to diagnose the configured route.

Choose the model when you create a session whenever possible. The Control UI's
**New Chat** composer includes the model picker for this reason: a fresh session
gives the selected model a clean conversation boundary.

Changing the model for an established session is an advanced operation. The
session transcript remains available, but the next model may have a different
context window, prompt and tool behavior, or prompt-cache implementation. A
mid-session switch can therefore reduce continuity, require earlier compaction,
or lose prompt-cache reuse and increase latency or cost. For a planned model
change, prefer a new session; use `/model` or the active-session model picker
when you intentionally want the existing transcript to continue with another
model.

Keep the thinking or reasoning level stable for the session when cache reuse
matters. On OpenAI, changing the reasoning effort changes the reusable request
state and can force the next turn to process the full conversation again. Other
providers may also include thinking configuration in their cache identity, so
changing only the thinking level can increase latency and input-token cost even
when the model itself stays the same.

<a id="model-in-chat" />

## `/model` in chat

`/model <model>` changes the current session. Use `-s` for only this session, `-a` to also update the agent's default, or `-g` to also update the shared global default. The long forms are `--session`, `--agent`, and `--global`. Configured-default writes require owner or admin authority.

Without a scope flag, `agents.defaults.modelSelectionScope` can opt into `"session"`, `"agent"`, or `"global"` scope. Leaving this setting unset preserves existing behavior: direct owner/admin commands request a best-effort update to the agent's explicit primary when one exists, otherwise to the shared `agents.defaults.model` fallback. Without owner/admin authority, bare commands remain session-only and explicit `-a` or `-g` requests are rejected.

```text
/model
/model list
/model Opus
/model openai/gpt-5.4
/model openai/gpt-5.4 -s
/model openai/gpt-5.4 -a
/model openai/gpt-5.4 -g
/model default -s
/model default
/model status
```

- In text chat, `/model` shows the current selection. `/model list` (or `/models`) browses providers; `/models <provider>` lists model refs.
- Select with `/model <provider/model>` or `/model <alias>` (for example, `/model Opus` with the alias configured above). Numeric selections such as `/model 3` are not supported.
- On Discord, native `/model` and `/models` without arguments open an interactive picker. Choose a provider and model, then press **Submit**. Discord pickers follow the direct command behavior, including `modelSelectionScope`.
- On Telegram, `/model` offers a **Browse providers** button; `/model list` and `/models` open the provider menu directly. Tap a provider, then a model. Telegram callback selections always stay session-only.
- `/models add` is deprecated and returns a message instead of registering models from chat.
- **Current session:** `/model <model> -s` (or `--session`) changes only this session, regardless of `modelSelectionScope`. Neither configured default changes.
- **Agent default:** Owner/admin `/model <model> -a` (or `--agent`) selects the model for this session and requests an update for `agents.entries.<agent>.model`. It creates an explicit primary for that configured agent when needed and never falls through to the shared global default.
- **Global default:** Owner/admin `/model <model> -g` (or `--global`) changes this session and requests an update for the shared `agents.defaults.model` fallback. It does not overwrite other agents' explicit primaries or other sessions' model pins. New and existing unpinned sessions, and cron jobs that inherit this default, can use the changed model on their next run.
- Immutable configuration stays unchanged. Asynchronous write errors are logged without reverting the session selection. Explicit model and auth-profile pins survive `/new`, `/reset`, session rollover, compaction, and cooldown windows while valid.
- **Use the configured default:** `/model default -s` clears the current session model selection without writing configured defaults. A compatible auth-profile pin remains. An incompatible pin is cleared. Selecting the effective configured default by name also clears the session model pin, but agent/global scope still requests a write to that configured target. This does not restore an older configured default changed by a previous selection.
- If the agent is idle, a model change applies to the next run immediately. If a run is already active, the switch is queued for the next clean retry point (or a later one, if tool activity or reply output already started).
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

### Hosted catalog updates

OpenClaw can refresh the model metadata shipped by installed provider plugins
without waiting for a new OpenClaw release. The Gateway makes one background
JSON `GET` at startup and then checks at most every six hours. The request sends
no prompts, credentials, model usage, or configuration payload beyond the
normal HTTP user agent and conditional cache headers.

The downloaded bundle is stored in the shared SQLite state database and becomes
visible after the next Gateway restart. Remote data can update or add models
only for providers declared by installed plugin manifests. It cannot supply API
base URLs or request headers, and a catalog older than the installed release's
build stamp is ignored.

The hosted file is published from the public
[`openclaw/catalog`](https://github.com/openclaw/catalog) GitHub repository.
Its scheduled workflow checks OpenClaw's default-branch plugin manifests and
public pricing sources every four hours; every catalog content change is
preserved as a public commit. Provider-owned policies select complete price
schedules, including context tiers, without mixing rates from different sources.
Declared native sources read the public Cerebras, Chutes, DeepInfra, OpenCode, and Venice
catalogs, so connected installations can receive advertised price changes without
a new OpenClaw release. When a valid native feed no longer supplies a model's
price, publication preserves the model metadata without an estimate; it does not
infer retirement or substitute another source's rate. Explicit user costs still
win. DeepInfra uses its agent projection for model metadata and its native
`/models/list` feed for prices, including numeric discounts. Qualified schedules
that cannot be represented as unconditional token costs stay unknown; models
remain available. See [DeepInfra price estimates](/providers/deepinfra#price-estimates).

Run `openclaw models refresh` for an immediate metadata and pricing check, or
disable every hosted catalog request with `models.catalogRefresh.enabled:
false`. When disabled, pricing stays at bundled and explicitly configured
values. A self-hosted mirror can be selected with an HTTPS
`models.catalogRefresh.url` (or localhost HTTP for testing); see
[configuration reference](/gateway/configuration-reference#models).

Custom providers configured under `models.providers` are written into `models.json` under the agent directory (default `~/.openclaw/agents/<agentId>/agent/models.json`). Provider-plugin catalogs are stored separately as generated plugin-owned catalog shards and load automatically. This file is merged with config by default; set `models.mode: "replace"` to use only your configured providers.

<AccordionGroup>
  <Accordion title="Merge mode precedence">
    For matching provider IDs:

    - A non-empty `baseUrl` already present in the agent `models.json` wins.
    - A non-empty `apiKey` in `models.json` wins only when that provider is not SecretRef-managed in the current config/auth-profile context.
    - SecretRef-managed `apiKey` values refresh from source markers instead of persisting resolved secrets: the env variable name for env refs, `secretref-managed` for file/exec/store refs.
    - SecretRef-managed header values refresh the same way, using `secretref-env:ENV_VAR_NAME` for env refs.
    - Empty or missing `apiKey`/`baseUrl` in `models.json` fall back to config `models.providers`.
    - Explicit model lists control membership. For matching rows, an explicit `input` wins; when the source row omits `input`, plugin discovery can fill that capability metadata.
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
