---
summary: "Use Z.AI (GLM models) with OpenClaw"
read_when:
  - You want Z.AI / GLM models in OpenClaw
  - You need a simple ZAI_API_KEY setup
title: "Z.AI"
---

Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and
uses API keys for authentication. Create your API key in the Z.AI console.
OpenClaw uses the `zai` provider with a Z.AI API key.

| Property | Value                                        |
| -------- | -------------------------------------------- |
| Provider | `zai`                                        |
| Package  | `@openclaw/zai-provider`                     |
| Auth     | `ZAI_API_KEY` (legacy alias: `Z_AI_API_KEY`) |
| API      | Z.AI Chat Completions (Bearer auth)          |

## GLM models

GLM is a model family, not a separate provider. In OpenClaw, GLM models use
refs such as `zai/glm-5.2`: provider `zai`, model id `glm-5.2`.

## Getting started

Install the provider plugin first:

```bash
openclaw plugins install @openclaw/zai-provider
```

<Tabs>
  <Tab title="Auto-detect endpoint">
    **Best for:** most users. OpenClaw probes supported Z.AI endpoints with your API key and applies the correct base URL automatically.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice zai-api-key
        ```
      </Step>
      <Step title="Verify the model is listed">
        ```bash
        openclaw models list --all --provider zai
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Explicit regional endpoint">
    **Best for:** users who want to force a specific Coding Plan or general API surface.

    <Steps>
      <Step title="Pick the right onboarding choice">
        ```bash
        # Coding Plan Global (recommended for Coding Plan users)
        openclaw onboard --auth-choice zai-coding-global

        # Coding Plan CN (China region)
        openclaw onboard --auth-choice zai-coding-cn

        # General API
        openclaw onboard --auth-choice zai-global

        # General API CN (China region)
        openclaw onboard --auth-choice zai-cn
        ```
      </Step>
      <Step title="Verify the model is listed">
        ```bash
        openclaw models list --all --provider zai
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

### Endpoints

| Onboarding choice   | Base URL                                      | Default model |
| ------------------- | --------------------------------------------- | ------------- |
| `zai-global`        | `https://api.z.ai/api/paas/v4`                | `glm-5.1`     |
| `zai-cn`            | `https://open.bigmodel.cn/api/paas/v4`        | `glm-5.1`     |
| `zai-coding-global` | `https://api.z.ai/api/coding/paas/v4`         | `glm-5.2`     |
| `zai-coding-cn`     | `https://open.bigmodel.cn/api/coding/paas/v4` | `glm-5.2`     |

`zai-api-key` auto-detects one of these four by probing your key against each
endpoint's chat-completions API, checking general endpoints (`zai-global`,
then `zai-cn`) before Coding Plan endpoints (`zai-coding-global`, then
`zai-coding-cn`), and stopping at the first endpoint that accepts a request.
Use an explicit `--auth-choice` to force a Coding Plan endpoint if your key
works on both.

## Rate limits and overloads

Z.AI documents the Coding Plan and general-purpose agent tools as capacity
managed services. In Z.AI's own docs:

- [General-purpose agent tools](https://docs.z.ai/devpack/tool/others),
  including OpenClaw, are served on a best-effort basis. During high inference
  load, typically around 2-6 PM Singapore time, some requests may face temporary
  rate limits.
- [Coding Plan rate and concurrency limits](https://docs.z.ai/devpack/usage-policy)
  are tied to the plan tier and can be adjusted dynamically based on resource
  availability. Off-peak hours may have higher concurrency.
- [API error code `1302`](https://docs.z.ai/api-reference/api-code) means "Rate
  limit reached for requests". API error code `1305` means "The service may be
  temporarily overloaded, please try again later".

If you see a temporary `429` or `1305` response during a busy period, wait and
retry the request. If failures are repeatable outside peak periods, or only
occur for one endpoint, model, or request shape, check the configured endpoint
and model first:

```bash
openclaw models list --all --provider zai
openclaw config get models.providers.zai.baseUrl
```

Coding Plan keys should use a Coding Plan endpoint such as
`https://api.z.ai/api/coding/paas/v4`; general API keys should use a general API
endpoint such as `https://api.z.ai/api/paas/v4`. Persistent failures with the
same key and endpoint can indicate a provider-side rejection or plan limitation,
not ordinary peak-load throttling.

## Config example

<Tip>
`zai-api-key` lets OpenClaw detect the matching Z.AI endpoint from the key and
apply the correct base URL automatically. Use the explicit regional choices when
you want to force a specific Coding Plan or general API surface.
</Tip>

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  models: {
    providers: {
      zai: {
        // GLM-5.2 uses the Coding Plan endpoint.
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      },
    },
  },
  agents: { defaults: { model: { primary: "zai/glm-5.2" } } },
}
```

## Built-in catalog

The `zai` provider plugin ships its catalog in the plugin manifest, so read-only
listing can show known GLM rows without loading provider runtime:

```bash
openclaw models list --all --provider zai
```

The manifest-backed catalog currently includes:

| Model ref            | Notes                           |
| -------------------- | ------------------------------- |
| `zai/glm-5.2`        | Coding Plan default; 1M context |
| `zai/glm-5.1`        | General API default             |
| `zai/glm-5`          |                                 |
| `zai/glm-5-turbo`    |                                 |
| `zai/glm-5v-turbo`   |                                 |
| `zai/glm-4.7`        |                                 |
| `zai/glm-4.7-flash`  |                                 |
| `zai/glm-4.7-flashx` |                                 |
| `zai/glm-4.6`        |                                 |
| `zai/glm-4.6v`       |                                 |
| `zai/glm-4.5`        |                                 |
| `zai/glm-4.5-air`    |                                 |
| `zai/glm-4.5-flash`  |                                 |
| `zai/glm-4.5v`       |                                 |

<Tip>
GLM models are available as `zai/<model>` (example: `zai/glm-5`).
</Tip>

<Note>
Coding Plan setup defaults to `zai/glm-5.2`; general API setup keeps
`zai/glm-5.1`. On the Coding Plan endpoints, auto-detection falls back to
`glm-5.1` and then `glm-4.7` when the key/plan does not expose GLM-5.2. GLM
versions and availability can change; run `openclaw models list --all --provider zai`
to see the catalog known to your installed version.
</Note>

## Thinking levels

<Tabs>
  <Tab title="GLM-5.2">
    Full range: `off`, `low`, `high`, `max` (default `off`). OpenClaw maps
    `low` and `high` to Z.AI's `high` reasoning effort, and `max` to Z.AI's
    `max` effort, via `reasoning_effort` on the request payload.
  </Tab>
  <Tab title="Other GLM models">
    Binary toggle only: `off` and `low` (shown as `on` in pickers), default
    `off`. Setting thinking to `off` sends `thinking: { type: "disabled" }`;
    any other level leaves the request payload untouched (Z.AI's own default
    reasoning behavior applies).
  </Tab>
</Tabs>

Setting thinking to `off` avoids responses that spend the output budget on
`reasoning_content` before visible text.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Forward-resolving unknown GLM-5 models">
    Unknown `glm-5*` ids still forward-resolve on the provider path by
    synthesizing provider-owned metadata from the `glm-4.7` template when the id
    matches the current GLM-5 family shape.
  </Accordion>

  <Accordion title="Tool-call streaming">
    `tool_stream` is enabled by default for Z.AI tool-call streaming. To disable it:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "zai/<model>": {
              params: { tool_stream: false },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Preserved thinking">
    Preserved thinking is opt-in because Z.AI requires the full historical
    `reasoning_content` to be replayed, which increases prompt tokens. Enable it
    per model:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "zai/glm-5.2": {
              params: { preserveThinking: true },
            },
          },
        },
      },
    }
    ```

    When enabled and thinking is on, OpenClaw sends
    `thinking: { type: "enabled", clear_thinking: false }` and replays prior
    `reasoning_content` for the same OpenAI-compatible transcript. The snake_case
    `preserve_thinking` param key works as an alias.

    Advanced users can still override the exact provider payload with
    `params.extra_body.thinking`.

  </Accordion>

  <Accordion title="Image understanding">
    The Z.AI plugin registers image understanding.

    | Property      | Value       |
    | ------------- | ----------- |
    | Model         | `glm-4.6v`  |

    Image understanding is auto-resolved from the configured Z.AI auth — no
    additional config is needed.

  </Accordion>

  <Accordion title="Auth details">
    - Z.AI uses Bearer auth with your API key.
    - The `zai-api-key` onboarding choice auto-detects the matching Z.AI endpoint by probing supported endpoints with your key.
    - Use the explicit regional choices (`zai-coding-global`, `zai-coding-cn`, `zai-global`, `zai-cn`) when you want to force a specific API surface.
    - The legacy env var `Z_AI_API_KEY` is still accepted; OpenClaw copies it to `ZAI_API_KEY` at startup if `ZAI_API_KEY` is unset.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw config schema, including provider and model settings.
  </Card>
</CardGroup>
