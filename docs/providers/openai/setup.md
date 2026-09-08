---
summary: "Connect OpenAI with an API key or a ChatGPT/Codex subscription"
read_when:
  - You are connecting OpenAI to OpenClaw for the first time
  - You want Codex subscription auth instead of API keys
  - You are recovering a broken Codex OAuth route or a long-context budget
title: "OpenAI setup"
sidebarTitle: "Setup"
---

## Getting started

<Tabs>
  <Tab title="API key (OpenAI Platform)">
    **Best for:** direct API access and usage-based billing.

    <Steps>
      <Step title="Get your API key">
        Create or copy an API key from the [OpenAI Platform dashboard](https://platform.openai.com/api-keys).
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice openai-api-key
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --openai-api-key "$OPENAI_API_KEY"
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider openai
        ```
      </Step>
    </Steps>

    ### Route summary

    | Model ref        | Runtime policy or route facts                                 | Route                     | Auth                              |
    | ---------------- | ------------------------------------------------------------- | ------------------------- | --------------------------------- |
    | `openai/gpt-5.6` | unset/`auto`, exact official HTTPS native route, no request override | Codex may be selected     | Ordered API-key auth profile      |
    | `openai/gpt-5.6` | provider/model `agentRuntime.id: "openclaw"`                  | OpenClaw embedded runtime | Selected `openai` API-key profile |
    | `openai/gpt-5.5` | explicit provider/model `agentRuntime.id`                     | Selected agent runtime    | Selected OpenAI API-key profile   |
    | `openai/*`       | authored Completions, custom, or request override | OpenClaw embedded runtime | Credential type remains unchanged |
    | `openai/*`       | plaintext official HTTP endpoint                  | Rejected                 | Credential is not sent             |

    <Note>
    With runtime unset or `auto`, only an eligible exact official HTTPS native
    route may select the Codex app-server harness implicitly. For API-key auth
    on an agent model, create an `openai` API-key auth profile and order it with
    `auth.order.openai`; `OPENAI_API_KEY` remains the direct fallback for
    non-agent OpenAI API surfaces. Run `openclaw doctor --fix` to migrate older
    legacy Codex auth-order entries.
    </Note>

    ### Config example

    ```json5
    {
      env: { vars: { OPENAI_API_KEY: "example-openai-key-not-real" } },
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    }
    ```

    The bare direct-API `gpt-5.6` alias is also accepted and resolves to the
    Sol tier. If this API organization does not expose GPT-5.6, set the primary
    to `openai/gpt-5.5` explicitly.

    To try ChatGPT's current Instant model from the OpenAI API, set the model
    to `openai/chat-latest`:

    ```json5
    {
      env: { vars: { OPENAI_API_KEY: "example-openai-key-not-real" } },
      agents: { defaults: { model: { primary: "openai/chat-latest" } } },
    }
    ```

    `chat-latest` is a moving alias. Fresh OpenAI API-key setup instead uses
    `openai/gpt-5.6-sol`. The bare direct-API `openai/gpt-5.6` alias remains
    supported and resolves to Sol. Existing
    explicit primaries, including `openai/gpt-5.5`, remain unchanged. The
    `chat-latest` alias only accepts `medium` text verbosity; OpenClaw forces
    any other requested verbosity to `medium` for this model.

    <Warning>
    OpenClaw does **not** expose `gpt-5.3-codex-spark` on the direct OpenAI
    API-key route. It is available only through Codex subscription catalog
    entries when your signed-in account exposes it.
    </Warning>

  </Tab>

  <Tab title="Codex subscription">
    **Best for:** using your ChatGPT/Codex subscription with native Codex
    app-server execution instead of a separate API key. Codex cloud requires
    ChatGPT sign-in.

    <Steps>
      <Step title="Run Codex OAuth">
        ```bash
        openclaw onboard --auth-choice openai
        ```

        Or run OAuth directly:

        ```bash
        openclaw models auth login --provider openai
        ```

        For headless or callback-hostile setups, add `--device-code` to sign
        in with a ChatGPT device-code flow instead of the localhost browser
        callback:

        ```bash
        openclaw models auth login --provider openai --device-code
        ```
      </Step>
      <Step title="Use the canonical OpenAI model route">
        ```bash
        openclaw config set agents.defaults.model.primary openai/gpt-5.6-sol
        ```

        No runtime config is required for this exact official HTTPS native
        route. It may select the Codex app-server runtime automatically, and
        OpenClaw installs or repairs the bundled Codex plugin when that runtime
        is chosen.
      </Step>
      <Step title="Verify Codex auth is available">
        ```bash
        openclaw models list --provider openai
        ```

        After the gateway is running, send `/codex status` or `/codex models`
        in chat to verify the native app-server runtime.
      </Step>
    </Steps>

    ### Route summary

    | Model ref                | Runtime policy or route facts                                 | Route                                                    | Auth                                               |
    | ------------------------ | ------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
    | `openai/gpt-5.6-sol`     | unset/`auto`, exact official HTTPS native route, no request override | Codex may be selected                                    | Codex sign-in, or an ordered `openai` auth profile |
    | `openai/gpt-5.6-terra`   | unset/`auto`, exact official HTTPS native route, no request override | Codex may be selected                                    | Codex sign-in when the catalog exposes Terra       |
    | `openai/gpt-5.6-luna`    | unset/`auto`, exact official HTTPS native route, no request override | Codex may be selected                                    | Codex sign-in when the catalog exposes Luna        |
    | `openai/gpt-5.6-sol`     | provider/model `agentRuntime.id: "openclaw"`                  | OpenClaw embedded runtime, internal Codex-auth transport | Selected `openai` OAuth profile                    |
    | `openai/gpt-5.5`         | explicit provider/model `agentRuntime.id`                     | Selected agent runtime                                   | Selected OpenAI auth profile                       |
    | `openai/*`               | authored Completions, custom, or request override | OpenClaw embedded runtime                                | Credential requirement remains route-specific      |
    | `openai/*`               | plaintext official HTTP endpoint                  | Rejected                                                 | Credential is not sent                              |
    | Legacy Codex GPT-5.5 ref | repaired by doctor                                            | Rewritten to `openai/gpt-5.5`                            | Migrated OpenAI OAuth profile                      |
    | `codex-cli/gpt-5.5`      | repaired by doctor                                            | Rewritten to `openai/gpt-5.5`                            | Codex app-server auth                              |

    <Warning>
    Fresh subscription-backed setup uses exact `openai/gpt-5.6-sol`; the
    native Codex catalog may also expose exact Terra or Luna refs. If the
    account does not expose GPT-5.6, select `openai/gpt-5.5` explicitly. Older
    Codex GPT refs are legacy OpenClaw routes, not the native Codex runtime
    path; run `openclaw doctor --fix` to migrate them without upgrading an
    existing explicit GPT-5.5 selection. `gpt-5.3-codex-spark` stays limited
    to accounts whose Codex subscription catalog advertises it; direct OpenAI
    API-key and Azure refs for it stay suppressed.
    </Warning>

    <Note>
    New config should put OpenAI agent auth order under `auth.order.openai`;
    doctor migrates older legacy Codex auth-order entries.
    </Note>

    ### Config example

    ```json5
    {
      plugins: { entries: { codex: { enabled: true } } },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
        },
      },
    }
    ```

    With an API-key backup, keep the selected model under `openai/*` and put
    the auth order under `openai`. OpenClaw tries the subscription first, then
    the API key, while staying on the Codex harness:

    ```json5
    {
      plugins: { entries: { codex: { enabled: true } } },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
        },
      },
      auth: {
        order: {
          openai: [
            "openai:user@example.com",
            "openai:api-key-backup",
          ],
        },
      },
    }
    ```

    <Note>
    Onboarding no longer imports OAuth material from `~/.codex`. Sign in with
    browser OAuth (default) or the device-code flow above; OpenClaw manages the
    resulting credentials in its own agent auth store.
    </Note>

    ### Check and recover Codex OAuth routing

    ```bash
    openclaw models status
    openclaw models auth list --provider openai
    openclaw config get agents.defaults.model --json
    openclaw config get models.providers.openai.agentRuntime --json
    ```

    For a specific agent, add `--agent <id>`:

    ```bash
    openclaw models status --agent <id>
    openclaw models auth list --agent <id> --provider openai
    ```

    If an older config still has legacy Codex GPT refs, or a stale OpenAI
    runtime session pin without explicit runtime config, repair it:

    ```bash
    openclaw doctor --fix
    openclaw config validate
    ```

    If `models auth list --provider openai` shows no usable profile, sign in
    again:

    ```bash
    openclaw models auth login --provider openai
    openclaw models status --probe --probe-provider openai
    ```

    Use `--profile-id` for multiple Codex OAuth logins in the same agent, then
    control them via auth ordering or `/model ...@<profileId> -s`:

    ```bash
    openclaw models auth login --provider openai --profile-id openai:ritsuko
    openclaw models auth login --provider openai --profile-id openai:lain
    ```

    Run `openclaw doctor --fix` to migrate older legacy OpenAI Codex prefix
    profile ids and order entries before relying on profile ordering.

    ### Status indicator

    Chat `/status` shows which model runtime is active for the current
    session. The bundled Codex app-server harness appears as
    `Runtime: OpenAI Codex` when an eligible implicit route or explicit
    provider/model runtime policy selects it.

    ### Doctor warning

    If legacy Codex model refs or stale OpenAI runtime pins remain in config
    or session state, `openclaw doctor --fix` rewrites them to `openai/*` with
    the Codex runtime unless OpenClaw is explicitly configured.

    ### Context window defaults and long-context opt-in

    OpenClaw treats native model capacity and the active runtime budget as
    separate values:

    - `contextWindow` declares the model's native window.
    - `contextTokens` caps how much of that window OpenClaw uses for active input.

    ChatGPT/Codex OAuth follows the live Codex account catalog. The current
    catalog commonly advertises a `272000` token active window for GPT-5.6.
    Direct API-key GPT-5.5 and GPT-5.6 models also default to `272000`
    `contextTokens`, even though the Platform API exposes a larger native
    window. This keeps the normal latency, quality, and cost profile consistent
    across auth modes. Override a direct model's active-input budget with
    `models.providers.openai.models[].contextTokens` on that exact model entry.

    For direct API-key GPT-5.5 and GPT-5.6, OpenAI documents a `1050000`
    token provider window and `128000` maximum output tokens. Reserving the
    full output allowance gives the shared safe input budget used by both
    runtime recipes below:

    ```text
    1050000 total - 128000 maximum output = 922000 safe active input
    automatic compaction threshold = 700000 active tokens
    ```

    `922000` is a derived operating budget, not a separate provider-published
    input limit. The two runtimes translate that budget differently: embedded
    OpenClaw sends Responses compaction controls, while native Codex owns its
    catalog window and automatic compaction. See the official
    [model comparison](https://developers.openai.com/api/docs/models/compare)
    and [GPT-5.5 model page](https://developers.openai.com/api/docs/models/gpt-5.5).

    #### Embedded OpenClaw translation

    This example pins the exact Sol model to the embedded OpenClaw runtime,
    enables OpenAI API Fast mode through the shared runtime control, and asks OpenAI Responses
    to compact at `700000` active tokens:

    ```json5
    {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                contextWindow: 1050000,
                contextTokens: 922000,
                maxTokens: 128000,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: "openclaw" },
              params: {
                fastMode: true,
                responsesServerCompaction: true,
                responsesCompactThreshold: 700000,
              },
            },
          },
        },
      },
    }
    ```

    OpenAI Responses automatic compaction emits an encrypted `compaction`
    output item. A stateless client carries the newest item into the next
    request and may drop every earlier input item. OpenClaw persists that item
    opaquely, fences reuse by route, session, and auth, replays it, prunes the
    replaced prefix, carries it through worker transcript commits, and removes
    it from display and diagnostics. Never print, log, or expose the encrypted
    content.

    A process-owned isolated-Gateway run verified this exact
    `openai/gpt-5.6-sol` configuration. Dense turns reached `295098`, `586562`,
    and `863664` prompt tokens. Turn three emitted and persisted a first-class
    server compaction item; the next request replayed that exact opaque item,
    pruned its prefix, and used `9602` prompt tokens. A deterministic long
    response produced `5480` output tokens, durable markers survived compaction
    and Gateway restart, restart latency was `12081` ms, every call reported
    `serviceTier: priority`, and the full suite took `220.03` seconds. These
    timings are observations, not service-level guarantees.

    #### Native Codex translation

    Keep the same OpenClaw model selection, but make Codex the explicit runtime
    and do not add Responses compaction params to this model entry:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: "codex" },
              params: { fastMode: true },
            },
          },
        },
      },
    }
    ```

    Codex must receive `922000` for both `context_window` and
    `max_context_window`, `700000` for `auto_compact_token_limit`, and matching
    app-server overrides with `model_auto_compact_token_limit_scope=total`.
    Codex then applies its 95% effective-window reserve, yielding `875900`
    active tokens. Configure an ordered OpenAI API-key profile and keep the
    default isolated agent-scoped Codex home. The complete catalog, app-server,
    auth, and restart recipe is in
    [Codex harness long context](/plugins/codex-harness/configuration#direct-api-long-context).

    These examples are two explicit runtime choices, not one auto-selecting
    configuration. The model-scoped `agentRuntime` and runtime-owned compaction
    settings must change together. OpenClaw can retain both choices only when
    their model refs or agent configurations are distinguishable; otherwise,
    switch the model runtime and its matching config as one atomic change. Then
    restart the Gateway and native Codex app-server, run `/model default -s`,
    and start a fresh chat. Existing native Codex threads retain the provider
    and model recorded when they were created.

    <Warning>
    OpenAI applies higher long-context pricing once a GPT-5.5 or GPT-5.6
    request exceeds `272000` input tokens: the whole qualifying request is
    billed at 2× input and cache rates and 1.5× output rates. Fast-mode pricing
    is model-specific; GPT-5.6 Sol API Fast mode is currently another 2× over
    Standard. For that model, combined long-context Fast traffic is therefore
    4× short-context Standard input-side pricing and 3× short-context Standard
    output pricing. Large prompts are resent or compacted across turns, so an
    opt-in session can cost substantially more than the default even when the
    visible reply is short. See [Fast mode](https://openai.com/api-priority-processing/)
    and [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).
    The API remains authoritative for account access, actual limits, and billing.
    </Warning>

    ### Catalog recovery

    OpenClaw uses upstream Codex catalog metadata for `gpt-5.5` when it is
    present. If live Codex discovery omits the `gpt-5.5` row while the account
    is authenticated, OpenClaw synthesizes that OAuth model row so cron,
    sub-agent, and configured default-model runs do not fail with
    `Unknown model`.

  </Tab>
</Tabs>
