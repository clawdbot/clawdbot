---
summary: "FAQ: model defaults, selection, aliases, switching, failover, and auth profiles"
read_when:
  - Choosing or switching models, configuring aliases
  - Debugging model failover / "All models failed"
  - Understanding auth profiles and how to manage them
title: "FAQ: models and auth"
sidebarTitle: "Models FAQ"
---

Model- and auth-profile Q&A. For setup, sessions, gateway, channels, and
troubleshooting, see the main [FAQ](/help/faq).

## Models: defaults, selection, aliases, switching

<AccordionGroup>
  <Accordion title='What is the "default model"?'>
    Set with:

    ```text
    agents.defaults.model.primary
    ```

    Models are `provider/model` refs (example: `openai/gpt-5.5`,
    `anthropic/claude-sonnet-4-6`). Always set `provider/model` explicitly. If
    you omit the provider, OpenClaw tries an alias match first, then a unique
    configured-provider match for that model id, then falls back to the
    configured default provider (deprecated compatibility path). If that
    provider no longer has the configured default model, OpenClaw falls back
    to the first configured provider/model instead of a stale default.

  </Accordion>

  <Accordion title="What model do you recommend?">
    Use the strongest latest-generation model your provider stack offers,
    especially for tool-enabled or untrusted-input agents — weaker or
    over-quantized models are more vulnerable to prompt injection and unsafe
    behavior (see [Security](/gateway/security)). Route cheaper models to
    routine/low-stakes chat by agent role.

    Route models per agent and use sub-agents to parallelize long tasks (each
    sub-agent consumes its own tokens). See [Models](/concepts/models),
    [Sub-agents](/tools/subagents), [MiniMax](/providers/minimax), and
    [Local models](/gateway/local-models).

  </Accordion>

  <Accordion title="How do I switch models without wiping my config?">
    Change only the model fields — avoid full config replaces.

    - `/model <model> -s` in chat (current session only)
    - owner/admin `/model <model> -a` (current session and agent default)
    - owner/admin `/model <model> -g` (current session and global default)
    - `openclaw models set ...` (updates just model config)
    - `openclaw configure --section model` (interactive)
    - edit `agents.defaults.model` in `~/.openclaw/openclaw.json` directly

    Bare `/model <model>` changes only the current session, including for owners/admins,
    unless you explicitly choose a broader [model selection scope](/gateway/config-agents#agentsdefaultsmodelselectionscope).

    For RPC edits, inspect with `config.schema.lookup` first (normalized
    path, shallow schema docs, child summaries), then prefer `config.patch`
    over `config.apply` with a partial object. If you did overwrite config,
    restore from backup or run `openclaw doctor` to repair.

    Docs: [Models](/concepts/models), [Configure](/cli/configure),
    [Config](/cli/config), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="Can I use self-hosted models (llama.cpp, vLLM, Ollama)?">
    Yes — Ollama is the easiest path. Quick setup:

    1. Install Ollama from `https://ollama.com/download`
    2. Pull a local model, e.g. `ollama pull gemma4`
    3. For cloud models too, run `ollama signin`
    4. Run `openclaw onboard`, choose `Ollama`, then `Local` or `Cloud + Local`

    `Cloud + Local` gives you cloud models plus your local Ollama models;
    cloud models such as `kimi-k2.5:cloud` need no local pull. To switch
    manually: `openclaw models list`, then `openclaw models set ollama/<model>`.

    Smaller/heavily quantized models are more vulnerable to prompt injection.
    Use large models for any bot with tool access; if you use small models
    anyway, enable sandboxing and strict tool allowlists.

    Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
    [Model providers](/concepts/model-providers), [Security](/gateway/security),
    [Sandboxing](/gateway/sandboxing).

  </Accordion>

  <Accordion title="How do I switch models on the fly (without restarting)?">
    Send `/model <name> -s` as a standalone message to switch only this session.
    Without a scope flag, the optional [model selection scope](/gateway/config-agents#agentsdefaultsmodelselectionscope)
    applies; leaving it unset keeps the change in the current session, including for owners/admins. See
    [Slash commands](/tools/slash-commands) for the
    full command list, including model browsing (`/model`, `/models`, `/model
    list`), `/model default -s` to clear only a session model override, and
    `/model status` for endpoint/API-mode detail.

    Force a specific auth profile per session with `@profile`:

    ```text
    /model opus@anthropic:default -s
    /model opus@anthropic:work -s
    ```

    A model selection without `@profile` preserves an existing compatible
    profile pin. Choose another explicit `@profile` suffix to replace it. Use
    `/model status` to inspect the active auth profile. `/model default` keeps
    a compatible auth pin and clears one that does not match the configured
    default provider.

  </Accordion>

  <Accordion title="If two providers expose the same model id, which one does /model use?">
    `/model provider/model` selects that exact provider route. For example,
    `qianfan/deepseek-v4-flash` and `deepseek/deepseek-v4-flash` are different
    refs even though the model id matches — OpenClaw does not silently switch
    providers on a bare id match.

    A user-selected `/model` ref is strict for fallback: if that
    provider/model becomes unavailable, the reply fails visibly instead of
    falling back to `agents.defaults.model.fallbacks`. Configured fallback
    chains still apply to configured defaults, cron job primaries, and
    auto-selected fallback state. When a non-session-override run is allowed
    to use fallback, OpenClaw tries the requested provider/model first, then
    configured fallbacks, then the configured primary — so duplicate bare
    model ids never jump straight back to the default provider.

    See [Models](/concepts/models) and [Model failover](/concepts/model-failover).

  </Accordion>

  <Accordion title="Can I use GPT 5.5 for daily tasks and Codex 5.5 for coding?">
    Yes — model choice and runtime choice are separate:

    - **Native Codex coding agent:** set `agents.defaults.model.primary` to
      `openai/gpt-5.5`. Sign in with `openclaw models auth login --provider
      openai` for ChatGPT/Codex subscription auth.
    - **Direct OpenAI API tasks outside the agent loop:** configure
      `OPENAI_API_KEY` for images, embeddings, speech, realtime, and other
      non-agent OpenAI API surfaces.
    - **OpenAI agent API-key auth:** `/model openai/gpt-5.5` with an ordered
      `openai` API-key profile.
    - **Sub-agents:** route coding tasks to a Codex-focused agent with its
      own `openai/gpt-5.5` model.

    See [Models](/concepts/models) and [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="How do I configure fast mode for GPT 5.5?">
    - **Per session:** send `/fast on` while using `openai/gpt-5.5`.
    - **Per model default:** set
      `agents.defaults.models["openai/gpt-5.5"].params.fastMode` to `true`.
    - **Automatic cutoff:** `/fast auto` or `params.fastMode: "auto"` runs new
      model calls fast until the cutoff, then runs later retry, fallback,
      tool-result, or continuation calls without fast mode. Cutoff defaults to
      60 seconds; override with `params.fastAutoOnSeconds` on the model.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              params: {
                fastMode: "auto",
                fastAutoOnSeconds: 30,
              },
            },
          },
        },
      },
    }
    ```

    Fast mode maps to `service_tier = "priority"` on native OpenAI Responses
    requests; existing `service_tier` values are preserved and fast mode does
    not rewrite `reasoning` or `text.verbosity`. Session `/fast` overrides beat
    config defaults.

    See [Thinking and fast mode](/tools/thinking) and the Fast mode section
    under Advanced configuration on the [OpenAI](/providers/openai) provider
    page.

  </Accordion>

  <Accordion title='Why do I see "Model ... is not allowed" and then no reply?'>
    If `agents.defaults.modelPolicy.allow` is non-empty, it becomes the
    **allowlist** for `/model`, session overrides, and `--model`. Picking a model outside that list returns
    this instead of a normal reply:

    ```text
    Model override "provider/model" is not allowed by agents.defaults.modelPolicy.allow.
    ```

    Fix: add the exact model or a provider wildcard such as `"provider/*"` to
    the named `modelPolicy.allow` list, remove/empty that list, or pick a model
    from `/model list`. If the command also
    included `--runtime codex`, update the allowlist first, then retry the
    same `/model provider/model --runtime codex` command.

  </Accordion>

  <Accordion title='Why do I see "Unknown model: minimax/MiniMax-M3"?'>
    If you're on an older OpenClaw release, upgrade first (or run from source
    `main`) and restart the gateway — `MiniMax-M3` may not be in your
    installed release's catalog yet. Otherwise the MiniMax provider is not
    configured (no provider entry or auth profile found), so the model can't
    resolve. See the Troubleshooting section on the
    [MiniMax](/providers/minimax) provider page for the full fix checklist,
    provider/model id table, and config-block example.

  </Accordion>

  <Accordion title="Can I use MiniMax as my default and OpenAI for complex tasks?">
    Yes. Use MiniMax as the default and switch models per session — fallbacks
    are for errors, not "hard tasks", so use `/model` or a separate agent.

    **Option A: switch per session**

    ```json5
    {
      env: { vars: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." } },
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M3" },
          models: {
            "minimax/MiniMax-M3": { alias: "minimax" },
            "openai/gpt-5.5": { alias: "gpt" },
          },
        },
      },
    }
    ```

    Then `/model gpt -s`.

    **Option B: separate agents** — Agent A defaults to MiniMax, Agent B
    defaults to OpenAI; route by agent or use `/agent` to switch.

    Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent),
    [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

  </Accordion>

  <Accordion title="Are opus / sonnet / gpt built-in shortcuts?">
    Yes — built-in shorthands, applied only when the target model exists in
    `agents.defaults.models`:

    | Alias | Resolves to |
    | --- | --- |
    | `opus` | `anthropic/claude-opus-5` |
    | `sonnet` | `anthropic/claude-sonnet-5` |
    | `gpt` | `openai/gpt-5.4` |
    | `gpt-mini` | `openai/gpt-5.4-mini` |
    | `gpt-nano` | `openai/gpt-5.4-nano` |
    | `gemini` | `google/gemini-3.1-pro-preview` |
    | `gemini-flash` | `google/gemini-3-flash-preview` |
    | `gemini-flash-lite` | `google/gemini-3.1-flash-lite` |

    Your own alias with the same name overrides the built-in one.

  </Accordion>

  <Accordion title="How do I define/override model shortcuts (aliases)?">
    Aliases live at `agents.defaults.models.<modelId>.alias`:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          },
        },
      },
    }
    ```

    Then `/model sonnet -s` selects that model ID for the current session only.
    Owners/admins can use `-a` to also update the agent default or `-g` for the
    shared global default. Bare selections follow the [model selection scope](/gateway/config-agents#agentsdefaultsmodelselectionscope).

  </Accordion>

  <Accordion title="How do I add models from other providers like OpenRouter or Z.AI?">
    OpenRouter (pay-per-token; many models):

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
          models: { "openrouter/anthropic/claude-sonnet-4-6": {} },
        },
      },
      env: { vars: { OPENROUTER_API_KEY: "sk-or-..." } },
    }
    ```

    Z.AI (GLM models):

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "zai/glm-5.1" },
          models: { "zai/glm-5.1": {} },
        },
      },
      env: { vars: { ZAI_API_KEY: "..." } },
    }
    ```

    Missing provider key for a referenced provider/model raises a runtime
    auth error (e.g. `No API key found for provider "zai"`).

    **No API key found for provider after adding a new agent**

    A new agent can read shared auth profiles without copying them. Its
    own profiles live in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
    and override the shared read-through base. See
    [Auth credential semantics](/auth-credential-semantics#agent-copy-portability).

    Fix: run `openclaw models auth login --provider <providerId> --agent <agentId>`
    on the Gateway host when the agent needs its own credentials. You can also
    configure auth when creating an agent with `openclaw agents add <id>`.
    For OAuth, sign in separately when the agent needs its own account.
    See [Multi-Agent Routing](/concepts/multi-agent) for the
    full `agentDir` reuse and credential-sharing rules — never reuse
    `agentDir` across agents.

  </Accordion>
</AccordionGroup>

## Model failover and "All models failed"

<AccordionGroup>
  <Accordion title="How does failover work?">
    Two stages:

    1. **Auth profile rotation** within the same provider.
    2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

    Cooldowns apply to failing profiles (exponential backoff), so OpenClaw
    keeps responding when a provider is rate-limited or temporarily failing.

    The rate-limit bucket covers more than plain `429`: `Too many concurrent
    requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai
    ... quota limit exceeded`, `resource exhausted`, and periodic
    usage-window limits (`weekly/monthly limit reached`) all count as
    failover-worthy rate limits.

    Billing responses aren't always `402`, and some `402`s stay in the
    transient/rate-limit bucket rather than the billing lane. Explicit
    billing text on `401`/`403` can still route to billing; provider-specific
    text matchers (e.g. OpenRouter `Key limit exceeded`) stay scoped to their
    own provider. A `402` that reads like a retryable usage-window or
    org/workspace spend limit (`daily limit reached, resets tomorrow`,
    `organization spending limit exceeded`) is treated as `rate_limit`, not a
    long billing disable.

    Context-overflow errors stay off the fallback path entirely — signatures
    like `request_too_large`, `input exceeds the maximum number of tokens`,
    `input token count exceeds the maximum number of input tokens`, `input is
    too long for the model`, or `ollama error: context length exceeded` go to
    compaction/retry instead of advancing model fallback.

    Generic server-error text is narrower than "anything with unknown/error
    in it". Provider-scoped transient shapes that do count as failover
    signals: Anthropic bare `An unknown error occurred`, OpenRouter bare
    `Provider returned error`, stop-reason errors like `Unhandled stop reason:
    error`, JSON `api_error` payloads with transient server text (`internal
    server error`, `unknown error, 520`, `upstream error`, `backend error`),
    and provider-busy errors like `ModelNotReadyException` when the provider
    context matches. Generic internal fallback text like `LLM request failed
    with an unknown error.` stays conservative and does not trigger fallback
    by itself.

  </Accordion>

  <Accordion title='What does "No credentials found for profile anthropic:default" mean?'>
    The auth profile id `anthropic:default` has no credentials in the
    expected auth store.

    **Fix checklist:**

    - Confirm where profiles live: shared and agent-local SQLite auth stores.
      Run `openclaw doctor --fix` if an older install still has
      `auth-profiles.json`; it is a migration source, not the runtime store.
    - Confirm the Gateway loads your env var. `ANTHROPIC_API_KEY` set only in
      your shell won't reach a Gateway run via systemd/launchd — put it in
      `~/.openclaw/.env` or enable `env.shellEnv`.
    - Confirm you're configuring the right agent — use `--agent <agentId>`
      with `openclaw models auth login` to select its local store.
    - Run `openclaw models status` to see configured models and provider
      auth state.

    **For "No credentials found for profile anthropic" (no email suffix):**

    The run is pinned to an Anthropic profile the Gateway can't find.

    - Use Claude CLI: run `openclaw models auth login --provider anthropic
      --method cli --set-default` on the gateway host.
    - Prefer an API key instead: put `ANTHROPIC_API_KEY` in
      `~/.openclaw/.env` on the gateway host, then clear any pinned order
      that forces the missing profile:

      ```bash
      openclaw models auth order clear --provider anthropic
      ```

    - Remote mode: auth profiles live on the gateway machine, not your
      laptop — confirm you're running commands there.

  </Accordion>

  <Accordion title="Why did it also try Google Gemini and fail?">
    If your model config includes Google Gemini as a fallback (or you
    switched to a Gemini shorthand), OpenClaw tries it during fallback. No
    Google credentials configured gives `No API key found for provider
    "google"`. Fix: add Google auth, or remove Google models from
    `agents.defaults.model.fallbacks`/aliases.

    **LLM request rejected: thinking signature required (Google Antigravity)**

    Cause: session history has thinking blocks without signatures (often
    from an aborted/partial stream); Google Antigravity requires signatures
    on thinking blocks. OpenClaw strips unsigned thinking blocks for Google
    Antigravity Claude; if it still appears, start a new session or set
    `/thinking off` for that agent.

  </Accordion>
</AccordionGroup>

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

<AccordionGroup>
  <Accordion title="What is an auth profile?">
    A named credential record (API key, token, or OAuth) tied to a provider,
    stored in SQLite. Agent-local profiles in
    `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` override the
    shared read-through base in `~/.openclaw/state/openclaw.sqlite`.
    Older installs keep the shared store in the main agent's database until
    `openclaw doctor --fix` relocates it.

    Inspect saved profiles without dumping secrets: `openclaw models auth
    list` (optionally `--provider <id>` or `--json`). See
    [Models CLI](/cli/models#auth-profiles).

  </Accordion>

  <Accordion title="What are typical profile IDs?">
    Provider-prefixed: `anthropic:default` (common when no email identity
    exists), `anthropic:<email>` for OAuth identities, or a custom id you
    choose (e.g. `anthropic:work`).

  </Accordion>

  <Accordion title="Can I control which auth profile is tried first?">
    Yes. `auth.order.<provider>` config sets rotation order per provider
    (metadata only — no secrets stored).

    OpenClaw may skip a profile in a short **cooldown** (rate limits,
    timeouts, auth failures) or a longer **disabled** state
    (billing/insufficient credits). Inspect with `openclaw models status
    --json` and check `auth.unusableProfiles`. Rate-limit cooldowns can be
    model-scoped — a profile cooling down for one model can still serve a
    sibling model on the same provider; billing/disabled windows block the
    whole profile.

    Set a per-agent order override (stored in that agent's
    `openclaw-agent.sqlite` database):

    ```bash
    # Defaults to the configured default agent (omit --agent)
    openclaw models auth order get --provider anthropic

    # Lock rotation to a single profile
    openclaw models auth order set --provider anthropic anthropic:default

    # Or set an explicit order (fallback within provider)
    openclaw models auth order set --provider anthropic anthropic:work anthropic:default

    # Clear override (fall back to config auth.order / round-robin)
    openclaw models auth order clear --provider anthropic

    # Target a specific agent
    openclaw models auth order set --provider anthropic --agent main anthropic:default
    ```

    Verify what will actually be tried: `openclaw models status --probe`. A
    stored profile omitted from an explicit order reports
    `excluded_by_auth_order` instead of being tried silently.

  </Accordion>

  <Accordion title="OAuth vs API key - what is the difference?">
    - **OAuth / CLI login** often uses subscription access where the
      provider supports it. For Anthropic, OpenClaw's Claude CLI backend
      uses Claude Code `claude -p`, which Anthropic currently treats as
      Agent SDK/programmatic usage drawing from subscription usage limits —
      see [Anthropic](/providers/anthropic) for the current billing-pause
      status and source links.
    - **API keys** use pay-per-token billing.

    The wizard supports Anthropic Claude CLI, OpenAI Codex OAuth, and API
    keys.

  </Accordion>
</AccordionGroup>

## Related

- [FAQ](/help/faq) — the main FAQ
- [FAQ — quick start and first-run setup](/help/faq-first-run)
- [Model selection](/concepts/model-providers)
- [Model failover](/concepts/model-failover)
