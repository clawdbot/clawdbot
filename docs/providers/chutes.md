---
summary: "Chutes setup (OAuth or API key, model discovery, aliases)"
title: "Chutes"
read_when:
  - You want to use Chutes with OpenClaw
  - You need the OAuth or API key setup path
  - You want the default model, aliases, or discovery behavior
---

[Chutes](https://chutes.ai) exposes open-source model catalogs through an
OpenAI-compatible API. OpenClaw supports both browser OAuth and API-key auth.

| Property         | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| Provider         | `chutes`                                                |
| Plugin           | official external package (`@openclaw/chutes-provider`) |
| API              | OpenAI-compatible                                       |
| Base URL         | `https://llm.chutes.ai/v1`                              |
| Auth             | OAuth or API key (see below)                            |
| Runtime env vars | `CHUTES_API_KEY`, `CHUTES_OAUTH_TOKEN`                  |

`CHUTES_OAUTH_TOKEN` supplies an already-obtained OAuth access token directly
(for example in CI), bypassing the interactive browser flow below.

## Install plugin

```bash
openclaw plugins install @openclaw/chutes-provider
openclaw gateway restart
```

## Getting started

Both paths set the default model to `chutes/zai-org/GLM-5.2-TEE` and register
the Chutes catalog.

<Tabs>
  <Tab title="OAuth">
    <Steps>
      <Step title="Run the OAuth onboarding flow">
        ```bash
        openclaw onboard --auth-choice chutes
        ```
        OpenClaw launches the browser flow locally, or shows a URL + redirect-paste
        flow on remote/headless hosts. OAuth tokens auto-refresh through OpenClaw auth
        profiles.
      </Step>
    </Steps>
  </Tab>
  <Tab title="API key">
    <Steps>
      <Step title="Get an API key">
        Create a key at
        [chutes.ai/app/settings/api-keys](https://chutes.ai/app/settings/api-keys).
      </Step>
      <Step title="Run the API key onboarding flow">
        ```bash
        openclaw onboard --auth-choice chutes-api-key
        ```
      </Step>
    </Steps>
  </Tab>
</Tabs>

## Discovery behavior

When Chutes auth is available, OpenClaw queries `GET /v1/models` with that
credential and uses the discovered models, cached for 5 minutes per
credential. On an expired/unauthorized key (HTTP 401), OpenClaw retries once
without credentials. If discovery still returns no rows, fails, or returns any
other non-2xx status, it falls back to the bundled static catalog (both API-key
and OAuth discovery use this same path). If discovery fails at startup, the
static catalog is used automatically.

Token prices come from the native [Chutes model catalog](https://llm.chutes.ai/v1/models).
Its numeric prompt, completion, and cached-input rates are already in USD per
million tokens; they are not per-token OpenRouter rates. Unavailable or invalid
price metadata does not establish that a model is free.

In the default `models.mode: "merge"`, fresh onboarding records the provider and
aliases without copying generated model rows or prices into your config. Live
prices can then refresh without overwriting explicitly authored model costs.
`models.mode: "replace"` disables discovery, so onboarding retains the bundled
catalog as an explicit offline seed in that mode. Existing configured model rows
and their prices are preserved when applying provider setup again.

## Default aliases

OpenClaw registers two convenience aliases for the Chutes catalog:

| Alias           | Target model                           |
| --------------- | -------------------------------------- |
| `chutes-pro`    | `chutes/deepseek-ai/DeepSeek-V3.2-TEE` |
| `chutes-vision` | `chutes/moonshotai/Kimi-K2.6-TEE`      |

## Built-in starter catalog

The bundled fallback catalog contains these current starter models plus two
compatible prior-generation refs that remain selectable but are hidden from
pickers:

| Model ref                              | Picker status |
| -------------------------------------- | ------------- |
| `chutes/zai-org/GLM-5.2-TEE`           | Visible       |
| `chutes/deepseek-ai/DeepSeek-V3.2-TEE` | Visible       |
| `chutes/moonshotai/Kimi-K2.6-TEE`      | Visible       |
| `chutes/MiniMaxAI/MiniMax-M2.5-TEE`    | Visible       |
| `chutes/Qwen/Qwen3.6-27B-TEE`          | Visible       |
| `chutes/moonshotai/Kimi-K2.5-TEE`      | Hidden        |
| `chutes/Qwen/Qwen3.5-397B-A17B-TEE`    | Hidden        |

Run `openclaw models list --all --provider chutes` for the full list.

Fallback prices for starter models still listed by the native endpoint were
refreshed from its August 31, 2026 response. An absent model keeps its previous
seed snapshot: feed absence alone does not retire a shipped reference or change
its picker status. Listing metadata is not proof that your account can invoke a
model.

## Config example

```json5
{
  agents: {
    defaults: {
      model: { primary: "chutes/zai-org/GLM-5.2-TEE" },
      models: {
        "chutes/zai-org/GLM-5.2-TEE": { alias: "Chutes GLM 5.2" },
        "chutes/deepseek-ai/DeepSeek-V3.2-TEE": { alias: "Chutes DeepSeek V3.2" },
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="OAuth overrides">
    Customize the OAuth flow with optional environment variables:

    | Variable | Purpose |
    | -------- | ------- |
    | `CHUTES_CLIENT_ID` | OAuth client id (prompted if unset) |
    | `CHUTES_CLIENT_SECRET` | OAuth client secret |
    | `CHUTES_OAUTH_REDIRECT_URI` | Redirect URI (default `http://127.0.0.1:1456/oauth-callback`) |
    | `CHUTES_OAUTH_SCOPES` | Space-separated scopes (default `openid profile chutes:invoke`) |

    See the [Chutes OAuth docs](https://chutes.ai/docs/sign-in-with-chutes/overview)
    for redirect-app requirements and help.

  </Accordion>

  <Accordion title="Notes">
    - Chutes models are registered as `chutes/<model-id>`.
    - Chutes does not report token usage while streaming (`supportsUsageInStreaming: false`); usage totals still show once the stream completes.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="Chutes" href="https://chutes.ai" icon="arrow-up-right-from-square">
    Chutes dashboard and API docs.
  </Card>
  <Card title="Chutes API keys" href="https://chutes.ai/app/settings/api-keys" icon="key">
    Create and manage Chutes API keys.
  </Card>
</CardGroup>
