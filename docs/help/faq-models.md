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
    OpenClaw's default model is whatever you set as:

    ```
    agents.defaults.model.primary
    ```

    Models are referenced as `provider/model` (example: `openai/gpt-5.4` or `openai-codex/gpt-5.5`). If you omit the provider, OpenClaw first tries an alias, then a unique configured-provider match for that exact model id, and only then falls back to the configured default provider as a deprecated compatibility path. If that provider no longer exposes the configured default model, OpenClaw falls back to the first configured provider/model instead of surfacing a stale removed-provider default. You should still **explicitly** set `provider/model`.

  </Accordion>

  <Accordion title="What model do you recommend?">
    **Recommended default:** use the strongest latest-generation model available in your provider stack.
    **For tool-enabled or untrusted-input agents:** prioritize model strength over cost.
    **For routine/low-stakes chat:** use cheaper fallback models and route by agent role.

    MiniMax has its own docs: [MiniMax](/providers/minimax) and
    [Local models](/gateway/local-models).

    Rule of thumb: use the **best model you can afford** for high-stakes work, and a cheaper
    model for routine chat or summaries. You can route models per agent and use sub-agents to
    parallelize long tasks (each sub-agent consumes tokens). See [Models](/concepts/models) and
    [Sub-agents](/tools/subagents).

    Strong warning: weaker/over-quantized models are more vulnerable to prompt
    injection and unsafe behavior. See [Security](/gateway/security).

    More context: [Models](/concepts/models).

  </Accordion>

  <Accordion title="How do I switch models without wiping my config?">
    Use **model commands** or edit only the **model** fields. Avoid full config replaces.

    Safe options:

    - `/model` in chat (quick, per-session)
    - `openclaw models set ...` (updates just model config)
    - `openclaw configure --section model` (interactive)
    - edit `agents.defaults.model` in `~/.openclaw/openclaw.json`

    Avoid `config.apply` with a partial object unless you intend to replace the whole config.
    For RPC edits, inspect with `config.schema.lookup` first and prefer `config.patch`. The lookup payload gives you the normalized path, shallow schema docs/constraints, and immediate child summaries.
    for partial updates.
    If you did overwrite config, restore from backup or re-run `openclaw doctor` to repair.

    Docs: [Models](/concepts/models), [Configure](/cli/configure), [Config](/cli/config), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="Can I use self-hosted models (llama.cpp, vLLM, Ollama)?">
    Yes. Ollama is the easiest path for local models.

    Quickest setup:

    1. Install Ollama from `https://ollama.com/download`
    2. Pull a local model such as `ollama pull gemma4`
    3. If you want cloud models too, run `ollama signin`
    4. Run `openclaw onboard` and choose `Ollama`
    5. Pick `Local` or `Cloud + Local`

    Notes:

    - `Cloud + Local` gives you cloud models plus your local Ollama models
    - cloud models such as `kimi-k2.5:cloud` do not need a local pull
    - for manual switching, use `openclaw models list` and `openclaw models set ollama/<model>`

    Security note: smaller or heavily quantized models are more vulnerable to prompt
    injection. We strongly recommend **large models** for any bot that can use tools.
    If you still want small models, enable sandboxing and strict tool allowlists.

    Docs: [Ollama](/providers/ollama), [Local models](/gateway/local-models),
    [Model providers](/concepts/model-providers), [Security](/gateway/security),
    [Sandboxing](/gateway/sandboxing).

  </Accordion>

  <Accordion title="What do OpenClaw, Flawd, and Krill use for models?">
    - These deployments can differ and may change over time; there is no fixed provider recommendation.
    - Check the current runtime setting on each gateway with `openclaw models status`.
    - For security-sensitive/tool-enabled agents, use the strongest latest-generation model available.
  </Accordion>

  <Accordion title="How do I switch models on the fly (without restarting)?">
    Use the `/model` command as a standalone message:

    ```
    /model sonnet
    /model opus
    /model gpt
    /model gpt-mini
    /model gemini
    /model gemini-flash
    /model gemini-flash-lite
    ```

    These are the built-in aliases. Custom aliases can be added via `agents.defaults.models`.

    You can list available models with `/model`, `/model list`, or `/model status`.

    `/model` (and `/model list`) shows a compact, numbered picker. Select by number:

    ```
    /model 3
    ```

    You can also force a specific auth profile for the provider (per session):

    ```
    /model opus@anthropic:default
    /model opus@anthropic:work
    ```

    Tip: `/model status` shows which agent is active, which `auth-profiles.json` file is being used, and which auth profile will be tried next.
    It also shows the configured provider endpoint (`baseUrl`) and API mode (`api`) when available.

    **How do I unpin a profile I set with @profile?**

    Re-run `/model` **without** the `@profile` suffix:

    ```
    /model anthropic/claude-opus-4-6
    ```

    If you want to return to the default, pick it from `/model` (or send `/model <default provider/model>`).
    Use `/model status` to confirm which auth profile is active.

  </Accordion>

  <Accordion title="Can I use GPT 5.5 for daily tasks and Codex 5.5 for coding?">
    Yes. Set one as default and switch as needed:

    - **Quick switch (per session):** `/model openai/gpt-5.4` for current direct OpenAI API-key tasks or `/model openai-codex/gpt-5.5` for GPT-5.5 Codex OAuth tasks.
    - **Default:** set `agents.defaults.model.primary` to `openai/gpt-5.4` for API-key usage or `openai-codex/gpt-5.5` for GPT-5.5 Codex OAuth usage.
    - **Sub-agents:** route coding tasks to sub-agents with a different default model.

    Direct API-key access for `openai/gpt-5.5` is supported once OpenAI enables
    GPT-5.5 on the public API. Until then GPT-5.5 is subscription/OAuth-only.

    See [Models](/concepts/models) and [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="How do I configure fast mode for GPT 5.5?">
    Use either a session toggle or a config default:

    - **Per session:** send `/fast on` while the session is using `openai/gpt-5.4` or `openai-codex/gpt-5.5`.
    - **Per model default:** set `agents.defaults.models["openai/gpt-5.4"].params.fastMode` or `agents.defaults.models["openai-codex/gpt-5.5"].params.fastMode` to `true`.

    Example:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              params: {
                fastMode: true,
              },
            },
          },
        },
      },
    }
    ```

    For OpenAI, fast mode maps to `service_tier = "priority"` on supported native Responses requests. Session `/fast` overrides beat config defaults.

    See [Thinking and fast mode](/tools/thinking) and [OpenAI fast mode](/providers/openai#fast-mode).

  </Accordion>

  <Accordion title='Why do I see "Model ... is not allowed" and then no reply?'>
    If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and any
    session overrides. Choosing a model that isn't in that list returns:

    ```
    Model "provider/model" is not allowed. Use /model to list available models.
    ```

    That error is returned **instead of** a normal reply. Fix: add the model to
    `agents.defaults.models`, remove the allowlist, or pick a model from `/model list`.

  </Accordion>

  <Accordion title='Why do I see "Unknown model: minimax/MiniMax-M2.7"?'>
    This means the **provider isn't configured** (no MiniMax provider config or auth
    profile was found), so the model can't be resolved.

    Fix checklist:

    1. Upgrade to a current OpenClaw release (or run from source `main`), then restart the gateway.
    2. Make sure MiniMax is configured (wizard or JSON), or that MiniMax auth
       exists in env/auth profiles so the matching provider can be injected
       (`MINIMAX_API_KEY` for `minimax`, `MINIMAX_OAUTH_TOKEN` or stored MiniMax
       OAuth for `minimax-portal`).
    3. Use the exact model id (case-sensitive) for your auth path:
       `minimax/MiniMax-M2.7` or `minimax/MiniMax-M2.7-highspeed` for API-key
       setup, or `minimax-portal/MiniMax-M2.7` /
       `minimax-portal/MiniMax-M2.7-highspeed` for OAuth setup.
    4. Run:

       ```bash
       openclaw models list
       ```

       and pick from the list (or `/model list` in chat).

    See [MiniMax](/providers/minimax) and [Models](/concepts/models).

  </Accordion>

  <Accordion title="Can I use MiniMax as my default and OpenAI for complex tasks?">
    Yes. Use **MiniMax as the default** and switch models **per session** when needed.
    Fallbacks are for **errors**, not "hard tasks," so use `/model` or a separate agent.

    **Option A: switch per session**

    ```json5
    {
      env: { MINIMAX_API_KEY: "sk-...", OPENAI_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M2.7" },
          models: {
            "minimax/MiniMax-M2.7": { alias: "minimax" },
            "openai/gpt-5.4": { alias: "gpt" },
          },
        },
      },
    }
    ```

    Then:

    ```
    /model gpt
    ```

    **Option B: separate agents**

    - Agent A default: MiniMax
    - Agent B default: OpenAI
    - Route by agent or use `/agent` to switch

    Docs: [Models](/concepts/models), [Multi-Agent Routing](/concepts/multi-agent), [MiniMax](/providers/minimax), [OpenAI](/providers/openai).

  </Accordion>

  <Accordion title="Are opus / sonnet / gpt built-in shortcuts?">
    Yes. OpenClaw ships a few default shorthands (only applied when the model exists in `agents.defaults.models`):

    - `opus` → `anthropic/claude-opus-4-6`
    - `sonnet` → `anthropic/claude-sonnet-4-6`
    - `gpt` → `openai/gpt-5.4` for API-key setups, or `openai-codex/gpt-5.5` when configured for Codex OAuth
    - `gpt-mini` → `openai/gpt-5.4-mini`
    - `gpt-nano` → `openai/gpt-5.4-nano`
    - `gemini` → `google/gemini-3.1-pro-preview`
    - `gemini-flash` → `google/gemini-3-flash-preview`
    - `gemini-flash-lite` → `google/gemini-3.1-flash-lite-preview`

    If you set your own alias with the same name, your value wins.

  </Accordion>

  <Accordion title="How do I define/override model shortcuts (aliases)?">
    Aliases come from `agents.defaults.models.<modelId>.alias`. Example:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            "anthropic/claude-haiku-4-5": { alias: "haiku" },
          },
        },
      },
    }
    ```

    Then `/model sonnet` (or `/<alias>` when supported) resolves to that model ID.

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
      env: { OPENROUTER_API_KEY: "sk-or-..." },
    }
    ```

    Z.AI (GLM models):

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "zai/glm-5" },
          models: { "zai/glm-5": {} },
        },
      },
      env: { ZAI_API_KEY: "..." },
    }
    ```

    If you reference a provider/model but the required provider key is missing, you'll get a runtime auth error (e.g. `No API key found for provider "zai"`).

    **No API key found for provider after adding a new agent**

    This usually means the **new agent** has an empty auth store. Auth is per-agent and
    stored in:

    ```
    ~/.openclaw/agents/<agentId>/agent/auth-profiles.json
    ```

    Fix options:

    - Run `openclaw agents add <id>` and configure auth during the wizard.
    - Or copy `auth-profiles.json` from the main agent's `agentDir` into the new agent's `agentDir`.

    Do **not** reuse `agentDir` across agents; it causes auth/session collisions.

  </Accordion>
</AccordionGroup>

## Model failover and "All models failed"

<AccordionGroup>
  <Accordion title="How does failover work?">
    Failover happens in two stages:

    1. **Auth profile rotation** within the same provider.
    2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

    Cooldowns apply to failing profiles (exponential backoff), so OpenClaw can keep responding even when a provider is rate-limited or temporarily failing.

    The rate-limit bucket includes more than plain `429` responses. OpenClaw
    also treats messages like `Too many concurrent requests`,
    `ThrottlingException`, `concurrency limit reached`,
    `workers_ai ... quota limit exceeded`, `resource exhausted`, and periodic
    usage-window limits (`weekly/monthly limit reached`) as failover-worthy
    rate limits.

    Some billing-looking responses are not `402`, and some HTTP `402`
    responses also stay in that transient bucket. If a provider returns
    explicit billing text on `401` or `403`, OpenClaw can still keep that in
    the billing lane, but provider-specific text matchers stay scoped to the
    provider that owns them (for example OpenRouter `Key limit exceeded`). If a `402`
    message instead looks like a retryable usage-window or
    organization/workspace spend limit (`daily limit reached, resets tomorrow`,
    `organization spending limit exceeded`), OpenClaw treats it as
    `rate_limit`, not a long billing disable.

    Context-overflow errors are different: signatures such as
    `request_too_large`, `input exceeds the maximum number of tokens`,
    `input token count exceeds the maximum number of input tokens`,
    `input is too long for the model`, or `ollama error: context length
    exceeded` stay on the compaction/retry path instead of advancing model
    fallback.

    Generic server-error text is intentionally narrower than "anything with
    unknown/error in it". OpenClaw does treat provider-scoped transient shapes
    such as Anthropic bare `An unknown error occurred`, OpenRouter bare
    `Provider returned error`, stop-reason errors like `Unhandled stop reason:
    error`, JSON `api_error` payloads with transient server text
    (`internal server error`, `unknown error, 520`, `upstream error`, `backend
    error`), and provider-busy errors such as `ModelNotReadyException` as
    failover-worthy timeout/overloaded signals when the provider context
    matches.
    Generic internal fallback text like `LLM request failed with an unknown
    error.` stays conservative and does not trigger model fallback by itself.

  </Accordion>

  <Accordion title='What does "No credentials found for profile anthropic:default" mean?'>
    It means the system attempted to use the auth profile ID `anthropic:default`, but could not find credentials for it in the expected auth store.

    **Fix checklist:**

    - **Confirm where auth profiles live** (new vs legacy paths)
      - Current: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
      - Legacy: `~/.openclaw/agent/*` (migrated by `openclaw doctor`)
    - **Confirm your env var is loaded by the Gateway**
      - If you set `ANTHROPIC_API_KEY` in your shell but run the Gateway via systemd/launchd, it may not inherit it. Put it in `~/.openclaw/.env` or enable `env.shellEnv`.
    - **Make sure you're editing the correct agent**
      - Multi-agent setups mean there can be multiple `auth-profiles.json` files.
    - **Sanity-check model/auth status**
      - Use `openclaw models status` to see configured models and whether providers are authenticated.

    **Fix checklist for "No credentials found for profile anthropic"**

    This means the run is pinned to an Anthropic auth profile, but the Gateway
    can't find it in its auth store.

    - **Use Claude CLI**
      - Run `openclaw models auth login --provider anthropic --method cli --set-default` on the gateway host.
    - **If you want to use an API key instead**
      - Put `ANTHROPIC_API_KEY` in `~/.openclaw/.env` on the **gateway host**.
      - Clear any pinned order that forces a missing profile:

        ```bash
        openclaw models auth order clear --provider anthropic
        ```

    - **Confirm you're running commands on the gateway host**
      - In remote mode, auth profiles live on the gateway machine, not your laptop.

  </Accordion>

  <Accordion title="Why did it also try Google Gemini and fail?">
    If your model config includes Google Gemini as a fallback (or you switched to a Gemini shorthand), OpenClaw will try it during model fallback. If you haven't configured Google credentials, you'll see `No API key found for provider "google"`.

    Fix: either provide Google auth, or remove/avoid Google models in `agents.defaults.model.fallbacks` / aliases so fallback doesn't route there.

    **LLM request rejected: thinking signature required (Google Antigravity)**

    Cause: the session history contains **thinking blocks without signatures** (often from
    an aborted/partial stream). Google Antigravity requires signatures for thinking blocks.

    Fix: OpenClaw now strips unsigned thinking blocks for Google Antigravity Claude. If it still appears, start a **new session** or set `/thinking off` for that agent.

  </Accordion>
</AccordionGroup>

## Auth profiles: what they are and how to manage them

Related: [/concepts/oauth](/concepts/oauth) (OAuth flows, token storage, multi-account patterns)

<AccordionGroup>
  <Accordion title="What is an auth profile?">
    An auth profile is a named credential record (OAuth or API key) tied to a provider. Profiles live in:

    ```
    ~/.openclaw/agents/<agentId>/agent/auth-profiles.json
    ```

  </Accordion>

  <Accordion title="What are typical profile IDs?">
    OpenClaw uses provider-prefixed IDs like:

    - `anthropic:default` (common when no email identity exists)
    - `anthropic:<email>` for OAuth identities
    - custom IDs you choose (e.g. `anthropic:work`)

  </Accordion>

  <Accordion title="Can I control which auth profile is tried first?">
    Yes. Config supports optional metadata for profiles and an ordering per provider (`auth.order.<provider>`). This does **not** store secrets; it maps IDs to provider/mode and sets rotation order.

    OpenClaw may temporarily skip a profile if it's in a short **cooldown** (rate limits/timeouts/auth failures) or a longer **disabled** state (billing/insufficient credits). To inspect this, run `openclaw models status --json` and check `auth.unusableProfiles`. Tuning: `auth.cooldowns.billingBackoffHours*`.

    Rate-limit cooldowns can be model-scoped. A profile that is cooling down
    for one model can still be usable for a sibling model on the same provider,
    while billing/disabled windows still block the whole profile.

    You can also set a **per-agent** order override (stored in that agent's `auth-state.json`) via the CLI:

    ```bash
    # Defaults to the configured default agent (omit --agent)
    openclaw models auth order get --provider anthropic

    # Lock rotation to a single profile (only try this one)
    openclaw models auth order set --provider anthropic anthropic:default

    # Or set an explicit order (fallback within provider)
    openclaw models auth order set --provider anthropic anthropic:work anthropic:default

    # Clear override (fall back to config auth.order / round-robin)
    openclaw models auth order clear --provider anthropic
    ```

    To target a specific agent:

    ```bash
    openclaw models auth order set --provider anthropic --agent main anthropic:default
    ```

    To verify what will actually be tried, use:

    ```bash
    openclaw models status --probe
    ```

    If a stored profile is omitted from the explicit order, probe reports
    `excluded_by_auth_order` for that profile instead of trying it silently.

  </Accordion>

  <Accordion title="OAuth vs API key - what is the difference?">
    OpenClaw supports both:

    - **OAuth** often leverages subscription access (where applicable).
    - **API keys** use pay-per-token billing.

    The wizard explicitly supports Anthropic Claude CLI, OpenAI Codex OAuth, and API keys.

  </Accordion>
</AccordionGroup>

## Related

- [FAQ](/help/faq) — the main FAQ
- [FAQ — quick start and first-run setup](/help/faq-first-run)
- [Model selection](/concepts/model-providers)
- [Model failover](/concepts/model-failover)
