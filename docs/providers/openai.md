---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
  - You need stricter GPT-5 agent execution behavior
title: "OpenAI"
---

OpenClaw uses one provider id, `openai`, for both direct API-key auth and
ChatGPT/Codex subscription auth. `openai/*` is the canonical model route.
For embedded agent turns with runtime policy unset or `auto`, OpenAI's route
facts decide whether OpenClaw may select the bundled Codex app-server runtime
implicitly. The `openai/*` prefix alone does not select a runtime.

- **Agent models** - `openai/*` through the runtime selected by explicit
  `agentRuntime` config or OpenAI's implicit route policy. Sign in with Codex
  auth for ChatGPT/Codex subscription use, or configure an API-key auth
  profile when you want key-based billing.
- **Non-agent OpenAI APIs** - direct OpenAI Platform access, billed per use,
  through `OPENAI_API_KEY` or an `openai` API-key auth profile.
- **Legacy config** - `codex/*` and `openai-codex/*` refs are repaired to
  `openai/*` plus model-scoped `agentRuntime.id: "codex"` by
  `openclaw doctor --fix`.

OpenAI explicitly supports subscription OAuth usage in external tools and
workflows like OpenClaw.

## Usage and cost tracking

OpenClaw keeps subscription quota and Platform API billing distinct:

- ChatGPT/Codex OAuth shows the subscription plan, quota windows, and credit balance.
- `OPENAI_ADMIN_KEY` shows 30 days of provider-reported organization cost and completions usage in Control UI **Usage**, including daily spend, request/token totals, top models, and cost categories.
- `OPENAI_PROJECT_ID` optionally scopes Admin API history to one project.
- OpenClaw never sends `OPENAI_API_KEY` or an `openai` inference profile to organization APIs; those credentials may belong to custom, Azure, or agent-local endpoints.

An explicit Admin key takes precedence over OAuth. Provider-reported history is not merged with OpenClaw's session-derived estimated cost; it can include API activity from other clients and provider-side billing adjustments.

OpenAI's [API Usage Dashboard](https://help.openai.com/en/articles/10478918) documentation describes the organization-owner and explicit Usage Dashboard permission requirements for usage data.

Provider, model, runtime, and channel are separate layers. If those labels are
getting mixed together, read [Agent runtimes](/concepts/agent-runtimes) before
changing config.

## Quick choice

| Goal                                              | Use                                                                | Notes                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| ChatGPT/Codex subscription, native Codex runtime  | `openai/gpt-5.6-sol`                                               | Fresh subscription setup; sign in with Codex auth.                  |
| Direct API-key billing for agent turns            | `openai/gpt-5.6` plus an ordered API-key auth profile              | Fresh API-key setup; the bare direct-API id resolves to Sol.        |
| Choose an exact GPT-5.6 tier                      | `openai/gpt-5.6-sol`, `-terra`, or `-luna`                         | Check `models list` for the tiers available to this account.        |
| Account without GPT-5.6 access                    | `openai/gpt-5.5`                                                   | Explicit recovery choice; OpenClaw does not silently downgrade.     |
| Direct API-key billing, explicit OpenClaw runtime | `openai/gpt-5.6` plus provider/model `agentRuntime.id: "openclaw"` | Select a normal `openai` API-key profile.                           |
| Latest ChatGPT Instant model alias                | `openai/chat-latest`                                               | Direct API-key only; moving alias, not the stable default.          |
| Image generation or editing                       | `openai/gpt-image-2`                                               | Works with `OPENAI_API_KEY` or Codex OAuth.                         |
| Transparent-background images                     | `openai/gpt-image-1.5`                                             | Set `outputFormat` to `png` or `webp` and `background=transparent`. |

## Naming map

| Name you see                            | Layer             | Meaning                                                                                  |
| --------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `openai`                                | Provider prefix   | Canonical OpenAI model route; route facts determine the implicit runtime.                |
| `codex` plugin                          | Plugin            | Bundled plugin providing the native Codex app-server runtime and `/codex` chat controls. |
| provider/model `agentRuntime.id: codex` | Agent runtime     | Force the native Codex app-server harness for matching embedded turns.                   |
| `/codex ...`                            | Chat command set  | Bind/control Codex app-server threads from a conversation.                               |
| `runtime: "acp", agentId: "codex"`      | ACP session route | Explicit fallback path that runs Codex through ACP/acpx.                                 |

## Implicit agent runtime

When provider/model `agentRuntime` policy is unset or `auto`, OpenAI's
provider-owned route policy chooses the implicit runtime from the effective
endpoint and adapter:

| Effective route facts                                                                                                                                                  | Implicit runtime      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Exact official Platform HTTPS endpoint with `openai-responses`, or exact official ChatGPT HTTPS endpoint with `openai-chatgpt-responses`; no authored request override | Codex may be selected |
| Authored `openai-completions` adapter                                                                                                                                  | OpenClaw              |
| Custom endpoint                                                                                                                                                        | OpenClaw              |
| Explicit exact official endpoint using HTTP                                                                                                                            | Rejected              |
| Route with an authored provider/model request override                                                                                                                 | OpenClaw              |

An explicit non-default provider/model `agentRuntime.id` remains authoritative.
For example, `agentRuntime.id: "openclaw"` keeps an otherwise Codex-eligible
route on OpenClaw, while `agentRuntime.id: "codex"` requires Codex and fails
closed when the effective route is not declared Codex-compatible.
Runtime selection does not change credential type or billing: Platform API-key
auth and ChatGPT/Codex subscription auth remain distinct.

`openclaw doctor --fix` migrates legacy `codex/*` and `openai-codex/*` model
refs, legacy Codex auth profile ids, and legacy Codex auth-order entries to the
canonical `openai` route. Migrated model refs receive model-scoped
`agentRuntime.id: "codex"`; use `auth.order.openai` for new auth-order config.

<Note>
Fresh OpenAI setup applies a GPT-5.6 primary only when no primary model is
configured. Adding or refreshing OpenAI auth preserves an existing explicit
selection, including `openai/gpt-5.5`, unless you explicitly use
`models auth login --set-default` or `models set`. Use an API-key auth profile
only when you want API-key auth for an agent model.
</Note>

## GPT-5.6 limited preview

OpenClaw recognizes the exact `openai/gpt-5.6-sol`,
`openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` model ids. All three expose
`xhigh` and `max` reasoning in the current catalog. OpenAI describes Sol as
the flagship tier, Terra as the balanced tier, and Luna as the fast,
lower-cost tier. See the
[GPT-5.6 launch announcement](https://openai.com/index/previewing-gpt-5-6-sol/)
and [access guide](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-5-6-sol-terra-and-luna).

With direct OpenAI API-key auth, the bare `openai/gpt-5.6` id is an alias for
Sol and is the fresh setup default. The native Codex catalog does not apply
that direct-API alias client-side; depending on workspace access, it can show
the exact Sol, Terra, and Luna ids. Fresh ChatGPT/Codex OAuth setup therefore
uses `openai/gpt-5.6-sol`. Check the current account with:

```bash
openclaw models list --provider openai
```

API organization and Codex workspace access can differ. If GPT-5.6 is not
available, select GPT-5.5 explicitly:

```bash
openclaw models set openai/gpt-5.5
```

OpenClaw surfaces the upstream access error and does not silently replace a
GPT-5.6 selection with GPT-5.5.

<Note>
Eligible exact official HTTPS routes may select the bundled Codex app-server
plugin when runtime policy is unset or `auto`; authored Completions routes,
custom endpoints, and request-transport overrides remain on OpenClaw. Plaintext
official HTTP endpoints are rejected. Explicit provider/model runtime config remains
authoritative. Run `openclaw doctor --fix` to repair stale legacy Codex model
refs, `codex-cli/*` refs, or old runtime session pins that were not set by
explicit runtime config.
</Note>

## OpenClaw feature coverage

| OpenAI capability         | OpenClaw surface                                                                              | Status                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Chat / Responses          | `openai/<model>` model provider                                                               | Yes                                                             |
| Codex subscription models | `openai/<model>` with OpenAI OAuth                                                            | Yes                                                             |
| Legacy Codex model refs   | old Codex model refs, `codex-cli/<model>`                                                     | Repaired by doctor to `openai/<model>`                          |
| Codex app-server harness  | Codex-compatible HTTPS route with runtime unset/`auto`, or explicit `agentRuntime.id: codex`  | Yes                                                             |
| Server-side web search    | Native OpenAI Responses tool                                                                  | Yes, when web search is enabled and no other provider is pinned |
| Images                    | `image_generate`                                                                              | Yes                                                             |
| Videos                    | `video_generate`                                                                              | Yes                                                             |
| Text-to-speech            | `messages.tts.provider: "openai"` / `tts`                                                     | Yes                                                             |
| Batch speech-to-text      | `tools.media.audio` / media understanding                                                     | Yes                                                             |
| Streaming speech-to-text  | Voice Call `streaming.provider: "openai"`                                                     | Yes                                                             |
| Realtime voice            | Voice Call `realtime.provider: "openai"` / Control UI Talk `talk.realtime.provider: "openai"` | Yes (OpenAI Platform API key)                                   |
| Embeddings                | memory embedding provider                                                                     | Yes                                                             |

<Note>
OpenAI Realtime voice goes through the public **OpenAI Platform Realtime
API** and requires a Platform API key. Codex OAuth tokens authenticate the
ChatGPT Codex backend instead; they are not interchangeable with Platform API
keys for the public Realtime endpoints.

If API-key auth reports missing billing, top up Platform credits at
[platform.openai.com/account/billing](https://platform.openai.com/account/billing)
for the organization backing your realtime credentials when using API-key
auth. Realtime voice accepts the `openai` API-key auth profile created by
`openclaw onboard --auth-choice openai-api-key`, a Platform API key set via
`talk.realtime.providers.openai.apiKey` for Control UI Talk, or
`plugins.entries.voice-call.config.realtime.providers.openai.apiKey` for Voice
Call, or the `OPENAI_API_KEY` environment variable.

In Control UI Video Talk, OpenAI WebRTC receives camera context on demand:
when the model calls `describe_view`, the browser sends one bounded JPEG over
the realtime data channel. OpenClaw does not attach a continuous camera track
to the OpenAI session.
</Note>

## Memory embeddings

OpenClaw can use OpenAI, or an OpenAI-compatible embedding endpoint, for
`memory_search` indexing and query embeddings:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
    },
  },
}
```

For OpenAI-compatible endpoints that require asymmetric embedding labels, set
`queryInputType` and `documentInputType` under `memorySearch`. OpenClaw
forwards these as provider-specific `input_type` request fields: query
embeddings use `queryInputType`; indexed memory chunks and batch indexing use
`documentInputType`. See the
[Memory configuration reference](/reference/memory-config#provider-specific-config)
for the full example.

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
      env: { OPENAI_API_KEY: "example-openai-key-not-real" },
      agents: { defaults: { model: { primary: "openai/gpt-5.6" } } },
    }
    ```

    The bare direct-API `gpt-5.6` id resolves to the Sol tier. If this API
    organization does not expose GPT-5.6, set the primary to
    `openai/gpt-5.5` explicitly.

    To try ChatGPT's current Instant model from the OpenAI API, set the model
    to `openai/chat-latest`:

    ```json5
    {
      env: { OPENAI_API_KEY: "example-openai-key-not-real" },
      agents: { defaults: { model: { primary: "openai/chat-latest" } } },
    }
    ```

    `chat-latest` is a moving alias. Fresh OpenAI API-key setup instead uses
    `openai/gpt-5.6`, whose bare direct-API id resolves to Sol. Existing
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
    control them via auth ordering or `/model ...@<profileId>`:

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

    ### Context window cap

    OpenClaw treats model metadata and the runtime context cap as separate
    values. For `openai/gpt-5.5` through the Codex OAuth catalog:

    - Native `contextWindow`: `400000`
    - Default runtime `contextTokens` cap: `272000`

    The smaller default cap has better latency and quality characteristics in
    practice. Override it with `contextTokens`:

    ```json5
    {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", contextTokens: 160000 }],
          },
        },
      },
    }
    ```

    <Note>
    Use `contextWindow` to declare native model metadata. Use `contextTokens`
    to limit the runtime context budget. The direct OpenAI API-key route
    reports a larger native `contextWindow` (`1000000`) for `gpt-5.5`; the two
    routes are tracked separately because upstream catalogs differ.
    </Note>

    ### Catalog recovery

    OpenClaw uses upstream Codex catalog metadata for `gpt-5.5` when it is
    present. If live Codex discovery omits the `gpt-5.5` row while the account
    is authenticated, OpenClaw synthesizes that OAuth model row so cron,
    sub-agent, and configured default-model runs do not fail with
    `Unknown model`.

  </Tab>
</Tabs>

## Native Codex app-server auth

The native Codex app-server harness uses `openai/*` model refs when an eligible
exact official HTTPS route selects it implicitly, or when provider/model
`agentRuntime.id: "codex"` selects it explicitly. Its auth is still
account-based. OpenClaw selects auth in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Run `openclaw doctor --fix` to migrate older legacy
   Codex auth profile ids and auth order.
2. The app-server's existing account, such as a local Codex CLI ChatGPT
   sign-in. For the default isolated agent home, OpenClaw bridges that native
   CLI account into the app-server through its login RPC; it does not share the
   CLI's config, plugins, or thread store.
3. For local stdio app-server launches only, and only when the app-server
   reports no account: `CODEX_API_KEY`, then `OPENAI_API_KEY`.

A local ChatGPT/Codex subscription sign-in is not replaced just because the
gateway process also has `OPENAI_API_KEY` for direct OpenAI models or
embeddings. The env API-key fallback applies only to the local stdio no-account
path; it is never sent over WebSocket app-server connections. When a
subscription-style Codex profile is selected, OpenClaw also keeps
`CODEX_API_KEY` and `OPENAI_API_KEY` out of the spawned stdio app-server child
and sends the selected credentials through the app-server login RPC instead.

When that subscription profile is blocked by a Codex usage limit, OpenClaw
marks the profile blocked until Codex's advertised reset time and lets auth
ordering rotate to the next `openai:*` profile, without changing the selected
model or dropping out of the Codex harness. Once the reset time passes, the
subscription profile is eligible again.

## Image generation

The bundled `openai` plugin registers image generation through the
`image_generate` tool. It supports both OpenAI API-key and Codex OAuth image
generation through the same `openai/gpt-image-2` model ref.

| Capability                | OpenAI API key                     | Codex OAuth                          |
| ------------------------- | ---------------------------------- | ------------------------------------ |
| Model ref                 | `openai/gpt-image-2`               | `openai/gpt-image-2`                 |
| Auth                      | `OPENAI_API_KEY`                   | OpenAI Codex OAuth sign-in           |
| Transport                 | OpenAI Images API                  | Codex Responses backend              |
| Max images per request    | 4                                  | 4                                    |
| Edit mode                 | Enabled (up to 5 reference images) | Enabled (up to 5 reference images)   |
| Size overrides            | Supported, including 2K/4K sizes   | Supported, including 2K/4K sizes     |
| Aspect ratio / resolution | Not forwarded to OpenAI Images API | Mapped to a supported size when safe |

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "openai/gpt-image-2" },
    },
  },
}
```

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters,
provider selection, and failover behavior.
</Note>

`gpt-image-2` is the default for OpenAI text-to-image generation and image
editing. `gpt-image-1.5`, `gpt-image-1`, and `gpt-image-1-mini` remain usable
as explicit model overrides. Use `openai/gpt-image-1.5` for
transparent-background PNG/WebP output; the current `gpt-image-2` API rejects
`background: "transparent"`.

For a transparent-background request, call `image_generate` with
`model: "openai/gpt-image-1.5"`, `outputFormat: "png"` or `"webp"`, and
`background: "transparent"`; the older `openai.background` provider option is
still accepted. OpenClaw also protects the public OpenAI and OpenAI Codex OAuth
routes by rewriting default `openai/gpt-image-2` transparent requests to
`gpt-image-1.5`; Azure and custom OpenAI-compatible endpoints keep their
configured deployment/model names.

The same setting is exposed for headless CLI runs:

```bash
openclaw infer image generate \
  --model openai/gpt-image-1.5 \
  --output-format png \
  --background transparent \
  --prompt "A simple red circle sticker on a transparent background" \
  --json
```

Use the same `--output-format` and `--background` flags with
`openclaw infer image edit` when starting from an input file.
`--openai-background` remains available as an OpenAI-specific alias. Use
`--quality low|medium|high|auto` to control OpenAI Images quality and cost.
Use `--openai-moderation low|auto` to pass OpenAI's moderation hint from either
`image generate` or `image edit`.

For ChatGPT/Codex OAuth installs, keep the same `openai/gpt-image-2` ref. When
an `openai` OAuth profile is configured, OpenClaw resolves that stored OAuth
access token and sends image requests through the Codex Responses backend; it
does not first try `OPENAI_API_KEY` or silently fall back to an API key.
Configure `models.providers.openai` explicitly with an API key, custom base
URL, or Azure endpoint when you want the direct OpenAI Images API route
instead. If that custom image endpoint is on a trusted LAN/private address,
also set `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`; OpenClaw
keeps private/internal OpenAI-compatible image endpoints blocked unless this
opt-in is present.

Generate:

```
/tool image_generate model=openai/gpt-image-2 prompt="A polished launch poster for OpenClaw on macOS" size=3840x2160 count=1
```

Generate a transparent PNG:

```
/tool image_generate model=openai/gpt-image-1.5 prompt="A simple red circle sticker on a transparent background" outputFormat=png background=transparent
```

Edit:

```
/tool image_generate model=openai/gpt-image-2 prompt="Preserve the object shape, change the material to translucent glass" image=/path/to/reference.png size=1024x1536
```

## Video generation

The bundled `openai` plugin registers video generation through the
`video_generate` tool.

| Capability       | Value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| Default model    | `openai/sora-2`                                                                    |
| Modes            | Text-to-video, image-to-video, single-video edit                                   |
| Reference inputs | 1 image or 1 video                                                                 |
| Size overrides   | Supported for text-to-video and image-to-video                                     |
| Aspect ratio     | Converted to the closest supported size, not forwarded raw                         |
| Other overrides  | `resolution`, `audio`, `watermark` are unsupported and dropped with a tool warning |

OpenAI image-to-video requests use `POST /v1/videos` with an image
`input_reference`. Single-video edits use `POST /v1/videos/edits` with the
uploaded video in the `video` field.

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "openai/sora-2" },
    },
  },
}
```

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters,
provider selection, and failover behavior.

The OpenAI provider declares `supportsSize` but not `supportsAspectRatio` or
`supportsResolution`. OpenClaw's shared normalization layer converts a
requested `aspectRatio` into the closest matching OpenAI `size` before the
request reaches the provider, so aspect-ratio requests generally still work.
`resolution` has no size fallback and is dropped, surfaced to the caller as
`Ignored unsupported overrides for openai/<model>: resolution=<value>`.
</Note>

## GPT-5 prompt contribution

OpenClaw adds a shared GPT-5 prompt contribution for GPT-5-family models on
the `openai` provider (including legacy pre-repair Codex refs that normalize
to `openai/*`). Other providers that also serve GPT-5-family model ids, such
as OpenRouter or opencode routes, do not receive this overlay; it is gated on
provider id `openai`, not on model id alone. Older GPT-4.x models never
receive it.

The native Codex app-server harness does not receive the persona/tool-
discipline behavior contract or the friendly interaction-style overlay through
developer instructions; native Codex keeps Codex-owned base, model, and
project-doc behavior, and OpenClaw disables Codex's built-in personality for
native threads so agent workspace personality files stay authoritative.
OpenClaw contributes only runtime context to native Codex threads: channel
delivery, OpenClaw dynamic tools, ACP delegation, workspace context, and
OpenClaw skills. The heartbeat-guidance text from this same contribution is the
one exception: native Codex heartbeat turns do get it, injected as dedicated
collaboration instructions rather than through the shared prompt-contribution
hook.

The GPT-5 contribution adds a tagged behavior contract for persona
persistence, execution safety, tool discipline, output shape, completion
checks, and verification on matching OpenClaw-assembled prompts. Channel-
specific reply and silent-message behavior stays in the shared OpenClaw system
prompt and outbound delivery policy. The friendly interaction-style layer is
separate and configurable.

| Value                  | Effect                                      |
| ---------------------- | ------------------------------------------- |
| `"friendly"` (default) | Enable the friendly interaction-style layer |
| `"on"`                 | Alias for `"friendly"`                      |
| `"off"`                | Disable only the friendly style layer       |

<Tabs>
  <Tab title="Config">
    ```json5
    {
      agents: {
        defaults: {
          promptOverlays: {
            gpt5: { personality: "friendly" },
          },
        },
      },
    }
    ```
  </Tab>
  <Tab title="CLI">
    ```bash
    openclaw config set agents.defaults.promptOverlays.gpt5.personality off
    ```
  </Tab>
</Tabs>

<Tip>
Values are case-insensitive at runtime, so `"Off"` and `"off"` both disable the
friendly style layer.
</Tip>

<Note>
Legacy `plugins.entries.openai.config.personality` is still read as a
compatibility fallback when the shared
`agents.defaults.promptOverlays.gpt5.personality` setting is unset.
</Note>

## Voice and speech

<AccordionGroup>
  <Accordion title="Speech synthesis (TTS)">
    The bundled `openai` plugin registers speech synthesis for the
    `messages.tts` surface.

    | Setting      | Config path                                            | Default                          |
    | ------------- | --------------------------------------------------------- | ----------------------------------- |
    | Model        | `messages.tts.providers.openai.model`                  | `gpt-4o-mini-tts`                |
    | Voice        | `messages.tts.providers.openai.speakerVoice`           | `coral`                          |
    | Speed        | `messages.tts.providers.openai.speed`                  | (unset)                          |
    | Instructions | `messages.tts.providers.openai.instructions`           | (unset, `gpt-4o-mini-tts` only)  |
    | Format       | `messages.tts.providers.openai.responseFormat`         | `opus` for voice notes, `mp3` for files |
    | API key      | `messages.tts.providers.openai.apiKey`                 | Falls back to `OPENAI_API_KEY`   |
    | Base URL     | `messages.tts.providers.openai.baseUrl`                | `https://api.openai.com/v1`      |
    | Extra body   | `messages.tts.providers.openai.extraBody` / `extra_body` | (unset)                        |

    Available models: `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`. Available voices:
    `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `juniper`,
    `marin`, `onyx`, `nova`, `sage`, `shimmer`, `verse`.

    `extraBody` is merged into `/audio/speech` request JSON after OpenClaw's
    generated fields, so use it for OpenAI-compatible endpoints that require
    additional keys such as `lang`. Prototype keys are ignored.

    ```json5
    {
      messages: {
        tts: {
          providers: {
            openai: { model: "gpt-4o-mini-tts", speakerVoice: "coral" },
          },
        },
      },
    }
    ```

    <Note>
    Set `OPENAI_TTS_BASE_URL` to override the TTS base URL without affecting
    the chat API endpoint. OpenAI TTS and Realtime voice are both configured
    through an OpenAI Platform API key; OAuth-only installs can still use
    Codex-backed chat models, but not OpenAI live talk-back.
    </Note>

  </Accordion>

  <Accordion title="Speech-to-text">
    The bundled `openai` plugin registers batch speech-to-text through
    OpenClaw's media-understanding transcription surface.

    - Default model: `gpt-4o-transcribe`
    - Endpoint: OpenAI REST `/v1/audio/transcriptions`
    - Input path: multipart audio file upload
    - Used wherever inbound audio transcription reads `tools.media.audio`,
      including Discord voice-channel segments and channel audio attachments

    To force OpenAI for inbound audio transcription:

    ```json5
    {
      tools: {
        media: {
          audio: {
            models: [
              {
                type: "provider",
                provider: "openai",
                model: "gpt-4o-transcribe",
              },
            ],
          },
        },
      },
    }
    ```

    Language and prompt hints are forwarded to OpenAI when supplied by the
    shared audio media config or per-call transcription request.

  </Accordion>

  <Accordion title="Realtime transcription">
    The bundled `openai` plugin registers realtime transcription for the
    Voice Call plugin.

    | Setting          | Config path                                                          | Default |
    | ----------------- | ----------------------------------------------------------------------- | --------- |
    | Model            | `plugins.entries.voice-call.config.streaming.providers.openai.model` | `gpt-4o-transcribe` |
    | Language         | `...openai.language`                                                 | (unset) |
    | Prompt           | `...openai.prompt`                                                   | (unset) |
    | Silence duration | `...openai.silenceDurationMs`                                        | `800`   |
    | VAD threshold    | `...openai.vadThreshold`                                             | `0.5`   |
    | Auth             | `...openai.apiKey`, `OPENAI_API_KEY`, or `openai` API-key profile    | Platform API key required |

    <Note>
    Uses a WebSocket connection to `wss://api.openai.com/v1/realtime` with
    G.711 u-law (`g711_ulaw` / `audio/pcmu`) audio. For an `openai` API-key
    profile, the Gateway mints an ephemeral Realtime transcription client
    secret before opening the WebSocket. This streaming provider is for Voice
    Call's realtime transcription path; Discord voice currently records short
    segments and uses the batch `tools.media.audio` transcription path
    instead.
    </Note>

  </Accordion>

  <Accordion title="Realtime voice">
    The bundled `openai` plugin registers realtime voice for the Voice Call
    plugin.

    | Setting                               | Config path                                                              | Default             |
    | --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
    | Model                                  | `plugins.entries.voice-call.config.realtime.providers.openai.model`     | `gpt-realtime-2.1`  |
    | Voice                                  | `...openai.voice`                                                       | `alloy`             |
    | Temperature (Azure deployment bridge)  | `...openai.temperature`                                                 | `0.8`               |
    | VAD threshold                          | `...openai.vadThreshold`                                                | `0.5`                |
    | Silence duration                       | `...openai.silenceDurationMs`                                           | `500`                |
    | Prefix padding                         | `...openai.prefixPaddingMs`                                             | `300`                |
    | Reasoning effort                       | `...openai.reasoningEffort`                                             | (unset)              |
    | Auth                                   | `openai` API-key profile, `...openai.apiKey`, or `OPENAI_API_KEY` | OpenAI Platform API key required |

    Available built-in Realtime voices for `gpt-realtime-2.1`: `alloy`, `ash`,
    `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.
    OpenAI recommends `marin` and `cedar` for the best Realtime quality. This
    is a separate set from the Text-to-speech voices above; a TTS-only voice
    such as `fable`, `nova`, or `onyx` is not valid for Realtime sessions.
    Set the model explicitly to `gpt-realtime-2.1-mini` when you prefer the
    smaller, lower-cost Realtime 2.1 variant.

    <Note>
    **GPT-Live (upcoming).** OpenAI's full-duplex `gpt-live-1` and
    `gpt-live-1-mini` models replaced ChatGPT voice mode in July 2026; the
    developer API is rolling out to early-access organizations. OpenClaw
    recognizes the model family but does not run it yet: GPT-Live sessions are
    WebRTC-only, own their turn-taking (no VAD), and delegate agent work
    through a handoff event protocol that OpenClaw's realtime transports do
    not implement yet. Configuring a `gpt-live-*` model fails closed with
    guidance on both the WebSocket bridge and Talk browser sessions instead of
    silently connecting audio without agent access. API access is also gated
    per OpenAI organization during early access. Keep `gpt-realtime-2.1` (the
    default) until GPT-Live support lands.
    </Note>

    <Note>
    Backend OpenAI realtime bridges use the GA Realtime WebSocket session
    shape, which does not accept `session.temperature`. Azure OpenAI
    deployments remain available via `azureEndpoint` and `azureDeployment` and
    keep the deployment-compatible session shape (including `temperature`).
    Supports bidirectional tool calling and G.711 u-law audio.
    </Note>

    <Note>
    Realtime voice is selected when the session is created. OpenAI allows most
    session fields to change later, but the voice cannot be changed after the
    model has emitted audio in that session. OpenClaw currently exposes the
    built-in Realtime voice ids as strings.
    </Note>

    <Note>
    Control UI Talk uses OpenAI browser realtime sessions with a Gateway-
    minted ephemeral client secret and a direct browser WebRTC SDP exchange
    against the OpenAI Realtime API. The Gateway mints that client secret with
    the selected `openai` credential. Configured keys, API-key profiles, and
    `OPENAI_API_KEY` take precedence; an `openai` OAuth profile or external
    Codex login is the fallback. Gateway relay and Voice Call backend realtime
    WebSocket bridges use the same credential order for native OpenAI endpoints.
    Maintainer live verification is available with
    `OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts`;
    the OpenAI legs verify both the backend WebSocket bridge and the browser
    WebRTC SDP exchange without logging secrets.
    Pass `--openai-only` to run those two legs without Google credentials.
    </Note>

  </Accordion>
</AccordionGroup>

## Azure OpenAI endpoints

The bundled `openai` provider can target an Azure OpenAI resource for image
generation by overriding the base URL. On the image-generation path, OpenClaw
detects Azure hostnames on `models.providers.openai.baseUrl` and switches to
Azure's request shape automatically.

<Note>
Realtime voice uses a separate configuration path
(`plugins.entries.voice-call.config.realtime.providers.openai.azureEndpoint`)
and is not affected by `models.providers.openai.baseUrl`. See the **Realtime
voice** accordion under [Voice and speech](#voice-and-speech) for its Azure
settings.
</Note>

Use Azure OpenAI when:

- You already have an Azure OpenAI subscription, quota, or enterprise
  agreement
- You need regional data residency or compliance controls Azure provides
- You want to keep traffic inside an existing Azure tenancy

### Configuration

For Azure image generation through the bundled `openai` provider, point
`models.providers.openai.baseUrl` at your Azure resource and set `apiKey` to
the Azure OpenAI key (not an OpenAI Platform key):

```json5
{
  models: {
    providers: {
      openai: {
        baseUrl: "https://<your-resource>.openai.azure.com",
        apiKey: "<azure-openai-api-key>",
      },
    },
  },
}
```

OpenClaw recognizes these Azure host suffixes for the Azure image-generation
route:

- `*.openai.azure.com`
- `*.services.ai.azure.com`
- `*.cognitiveservices.azure.com`

For image-generation requests on a recognized Azure host, OpenClaw:

- Sends the `api-key` header instead of `Authorization: Bearer`
- Uses deployment-scoped paths (`/openai/deployments/{deployment}/...`)
- Appends `?api-version=...` to each request
- Uses a 600s default request timeout for Azure image-generation calls.
  Per-call `timeoutMs` values still override this default.

Other base URLs (public OpenAI, OpenAI-compatible proxies) keep the standard
OpenAI image request shape.

<Note>
Azure routing for the `openai` provider's image-generation path requires
OpenClaw 2026.4.22 or later. Earlier versions treat any custom
`openai.baseUrl` like the public OpenAI endpoint and fail against Azure image
deployments.
</Note>

### API version

Set `AZURE_OPENAI_API_VERSION` to pin a specific Azure preview or GA version
for the Azure image-generation path:

```bash
export AZURE_OPENAI_API_VERSION="2024-12-01-preview"
```

The default is `2024-12-01-preview` when the variable is unset.

### Model names are deployment names

Azure OpenAI binds models to deployments. For Azure image-generation requests
routed through the bundled `openai` provider, the `model` field in OpenClaw
must be the **Azure deployment name** you configured in the Azure portal, not
the public OpenAI model id.

If you create a deployment called `gpt-image-2-prod` that serves `gpt-image-2`:

```
/tool image_generate model=openai/gpt-image-2-prod prompt="A clean poster" size=1024x1024 count=1
```

The same deployment-name rule applies to any image-generation call routed
through the bundled `openai` provider.

### Regional availability

Azure image generation is currently available only in a subset of regions
(for example `eastus2`, `swedencentral`, `polandcentral`, `westus3`,
`uaenorth`). Check Microsoft's current region list before creating a
deployment, and confirm the specific model is offered in your region.

### Parameter differences

Azure OpenAI and public OpenAI do not always accept the same image parameters.
Azure may reject options public OpenAI allows (for example certain
`background` values on `gpt-image-2`) or expose them only on specific model
versions. These differences come from Azure and the underlying model, not
OpenClaw. If an Azure request fails with a validation error, check the
parameter set supported by your specific deployment and API version in the
Azure portal.

<Note>
Azure OpenAI uses native transport and compat behavior but does not receive
OpenClaw's hidden attribution headers - see the **Native vs OpenAI-compatible
routes** accordion under [Advanced configuration](#advanced-configuration).

For chat or Responses traffic on Azure (beyond image generation), use the
onboarding flow or a dedicated Azure provider config; `openai.baseUrl` alone
does not pick up the Azure API/auth shape. A separate
`azure-openai-responses/*` provider exists; see the Server-side compaction
accordion below.
</Note>

## Advanced configuration

The per-model `params` examples below shape OpenClaw's embedded provider
request. Configuring them is authored request behavior, so an otherwise eligible
`auto` route stays on OpenClaw instead of selecting Codex implicitly. The native
Codex app-server harness owns its own transport and request settings; explicit
`agentRuntime.id: "codex"` fails closed when the effective route is not declared
Codex-compatible.

<AccordionGroup>
  <Accordion title="Transport (WebSocket vs SSE)">
    OpenClaw uses WebSocket-first with SSE fallback (`"auto"`) for `openai/*`.

    In `"auto"` mode, OpenClaw:
    - Retries one early WebSocket failure before falling back to SSE
    - After a failure, marks WebSocket as degraded for 60 seconds and uses SSE
      during cool-down
    - Attaches stable session and turn identity headers for retries and
      reconnects
    - Normalizes usage counters (`input_tokens` / `prompt_tokens`) across
      transport variants

    | Value                | Behavior                          |
    | ---------------------- | ------------------------------------ |
    | `"auto"` (default)   | WebSocket first, SSE fallback     |
    | `"sse"`              | Force SSE only                    |
    | `"websocket"`        | Force WebSocket only              |

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              params: { transport: "auto" },
            },
          },
        },
      },
    }
    ```

    Related OpenAI docs:
    - [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
    - [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

  </Accordion>

  <Accordion title="Fast mode">
    OpenClaw exposes a shared fast-mode toggle for `openai/*`:

    - **Chat/UI:** `/fast status|auto|on|off`
    - **Config:** `agents.defaults.models["<provider>/<model>"].params.fastMode`

    When enabled, OpenClaw maps fast mode to OpenAI priority processing
    (`service_tier = "priority"`). Existing `service_tier` values are
    preserved, and fast mode does not rewrite `reasoning` or
    `text.verbosity`. `fastMode: "auto"` starts new model calls fast until the
    auto cutoff, then starts later retry, fallback, tool-result, or
    continuation calls without fast mode. The cutoff defaults to 60 seconds;
    set `params.fastAutoOnSeconds` on the active model to change it.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { fastMode: "auto", fastAutoOnSeconds: 30 } },
          },
        },
      },
    }
    ```

    <Note>
    Session overrides win over config. Clearing the session override in the
    Sessions UI returns the session to the configured default.
    </Note>

  </Accordion>

  <Accordion title="Priority processing (service_tier)">
    OpenAI's API exposes priority processing via `service_tier`. Set it per
    model in OpenClaw:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { params: { serviceTier: "priority" } },
          },
        },
      },
    }
    ```

    Supported values: `auto`, `default`, `flex`, `priority`.

    <Warning>
    `serviceTier` is forwarded only to native OpenAI endpoints
    (`api.openai.com`) and native Codex endpoints (`chatgpt.com/backend-api`).
    If you route either provider through a proxy, OpenClaw leaves
    `service_tier` untouched.
    </Warning>

  </Accordion>

  <Accordion title="Server-side compaction (Responses API)">
    For direct OpenAI Responses models (`openai/*` on `api.openai.com`), the
    OpenAI plugin's OpenClaw stream wrapper auto-enables server-side
    compaction:

    - Forces `store: true` (unless model compat sets `supportsStore: false`)
    - Injects `context_management: [{ type: "compaction", compact_threshold: ... }]`
    - Default `compact_threshold`: 70% of `contextWindow` (or `80000` when
      unavailable)

    This applies to the built-in OpenClaw runtime path and to OpenAI provider
    hooks used by embedded runs. The native Codex app-server harness manages
    its own context through Codex and is not affected by this setting.

    <Tabs>
      <Tab title="Enable explicitly">
        Useful for compatible endpoints like Azure OpenAI Responses:

        ```json5
        {
          agents: {
            defaults: {
              models: {
                "azure-openai-responses/gpt-5.5": {
                  params: { responsesServerCompaction: true },
                },
              },
            },
          },
        }
        ```
      </Tab>
      <Tab title="Custom threshold">
        ```json5
        {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  params: {
                    responsesServerCompaction: true,
                    responsesCompactThreshold: 120000,
                  },
                },
              },
            },
          },
        }
        ```
      </Tab>
      <Tab title="Disable">
        ```json5
        {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": {
                  params: { responsesServerCompaction: false },
                },
              },
            },
          },
        }
        ```
      </Tab>
    </Tabs>

    <Note>
    `responsesServerCompaction` only controls `context_management` injection.
    Direct OpenAI Responses models still force `store: true` unless compat
    sets `supportsStore: false`.
    </Note>

  </Accordion>

  <Accordion title="Strict-agentic GPT mode">
    For `openai` provider GPT-5-family models run through OpenClaw's embedded
    runtime, OpenClaw already defaults to a stricter execution contract called
    `strict-agentic`. It auto-activates whenever the resolved provider is
    `openai` and the model id matches the GPT-5 family, unless config
    explicitly opts back out:

    ```json5
    {
      agents: {
        defaults: {
          embeddedAgent: { executionContract: "default" },
        },
      },
    }
    ```

    Setting `"strict-agentic"` explicitly is a no-op on a supported lane (it
    is already the default) and inert on unsupported provider/model pairs.

    With `strict-agentic` active, OpenClaw:
    - Auto-enables `update_plan` for substantial work
    - Retries structurally empty or reasoning-only turns with a visible-answer
      continuation
    - Uses explicit harness plan events when the selected harness provides
      them

    OpenClaw does not classify assistant prose to decide whether a turn is a
    plan, progress update, or final answer.

    <Note>
    This contract lives entirely in OpenClaw's embedded agent runner. It does
    not apply to the native Codex app-server harness, which manages its own
    turn and plan behavior; the harness selection matters more than the
    execution-contract setting for native Codex runs.
    </Note>

  </Accordion>

  <Accordion title="Native vs OpenAI-compatible routes">
    OpenClaw treats direct OpenAI, Codex, and Azure OpenAI endpoints
    differently from generic OpenAI-compatible `/v1` proxies:

    **Native routes** (`openai/*`, Azure OpenAI):
    - Keep `reasoning: { effort: "none" }` only for models that support the
      OpenAI `none` effort
    - Omit disabled reasoning for models or proxies that reject
      `reasoning.effort: "none"`
    - Default tool schemas to strict mode
    - Attach hidden attribution headers on verified native hosts only (Azure
      OpenAI does not get these headers, even though it is a native route)
    - Keep OpenAI-only request shaping (`service_tier`, `store`,
      reasoning-compat, prompt-cache hints)

    **Proxy/compatible routes:**
    - Use looser compat behavior
    - Strip Completions `store` from non-native `openai-completions` payloads
    - Accept advanced `params.extra_body`/`params.extraBody` pass-through JSON
      for OpenAI-compatible Completions proxies
    - Accept `params.chat_template_kwargs` for OpenAI-compatible Completions
      proxies such as vLLM
    - Do not force strict tool schemas or native-only headers

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
</CardGroup>
