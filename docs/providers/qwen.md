---
summary: "Use Qwen Cloud through its OpenClaw plugin"
read_when:
  - You want to use Qwen with OpenClaw
  - You have an Alibaba Cloud Token Plan subscription
  - You previously used Qwen OAuth
title: "Qwen"
---

Qwen Cloud is an official external OpenClaw provider plugin with canonical id `qwen`. It targets Qwen Cloud / Alibaba DashScope Standard and Coding Plan endpoints, exposes Token Plan as `qwen-token-plan`, keeps `modelstudio` as a compatibility alias, independently owns Alibaba's documented `bailian-token-plan` custom-provider id, and exposes the Qwen Portal token flow as [`qwen-oauth`](/providers/qwen-oauth).

| Property               | Value                                      |
| ---------------------- | ------------------------------------------ |
| Provider               | `qwen`                                     |
| Token Plan provider    | `qwen-token-plan`                          |
| Portal provider        | [`qwen-oauth`](/providers/qwen-oauth)      |
| Preferred env var      | `QWEN_API_KEY`                             |
| Token Plan env var     | `QWEN_TOKEN_PLAN_API_KEY`                  |
| Also accepted (compat) | `MODELSTUDIO_API_KEY`, `DASHSCOPE_API_KEY` |
| API style              | OpenAI-compatible                          |

<Tip>
`qwen3.7-plus` and `qwen3.6-plus` work with Coding Plan and Standard endpoints.
For `qwen3.7-max` or `qwen3.6-flash`, use a **Standard (pay-as-you-go)** endpoint.
</Tip>

## Install plugin

`qwen` ships as an official external plugin, not bundled with core. Install it and restart Gateway:

```bash
openclaw plugins install @openclaw/qwen-provider
openclaw gateway restart
```

## Getting started

Choose your plan type and follow the setup steps.

<Tabs>
  <Tab title="Coding Plan (subscription)">
    **Best for:** subscription-based access through the Qwen Coding Plan.

    <Steps>
      <Step title="Get your API key">
        Create or copy an API key from [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys).
      </Step>
      <Step title="Run onboarding">
        For the **Global** endpoint:

        ```bash
        openclaw onboard --auth-choice qwen-api-key
        ```

        For the **China** endpoint:

        ```bash
        openclaw onboard --auth-choice qwen-api-key-cn
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider qwen
        ```
      </Step>
    </Steps>

    <Note>
    Legacy `modelstudio-*` auth-choice ids and `modelstudio/...` model refs still
    work as compatibility aliases, but new setup flows should prefer the canonical
    `qwen-*` auth-choice ids and `qwen/...` model refs. If you define an exact
    custom `models.providers.modelstudio` entry with another `api` value, that
    custom provider owns `modelstudio/...` refs instead of the Qwen compatibility
    alias.
    </Note>

  </Tab>

  <Tab title="Standard (pay-as-you-go)">
    **Best for:** pay-as-you-go access through the Standard Model Studio endpoint, including `qwen3.7-max` and `qwen3.6-flash`, which are not available on the Coding Plan.

    <Steps>
      <Step title="Get your API key">
        Create or copy an API key from [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys).
      </Step>
      <Step title="Run onboarding">
        For the **Global** endpoint:

        ```bash
        openclaw onboard --auth-choice qwen-standard-api-key
        ```

        For the **China** endpoint:

        ```bash
        openclaw onboard --auth-choice qwen-standard-api-key-cn
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider qwen
        ```
      </Step>
    </Steps>

    <Note>
    Legacy `modelstudio-*` auth-choice ids and `modelstudio/...` model refs still
    work as compatibility aliases, but new setup flows should prefer the canonical
    `qwen-*` auth-choice ids and `qwen/...` model refs. If you define an exact
    custom `models.providers.modelstudio` entry with another `api` value, that
    custom provider owns `modelstudio/...` refs instead of the Qwen compatibility
    alias.
    </Note>

  </Tab>

  <Tab title="Token Plan (Team Edition)">
    **Best for:** credit-based team subscription access to Qwen and supported third-party models through Alibaba Cloud Model Studio.

    <Steps>
      <Step title="Get your dedicated key">
        Assign a Token Plan seat and create its dedicated `sk-sp-...` key. Token Plan, Coding Plan, and pay-as-you-go keys are not interchangeable. See the [Global Token Plan overview](https://www.alibabacloud.com/help/en/model-studio/token-plan-overview) or [China Token Plan overview](https://help.aliyun.com/zh/model-studio/token-plan-overview).
      </Step>
      <Step title="Run onboarding">
        For the **Global / International** endpoint in Singapore:

        ```bash
        openclaw onboard --auth-choice qwen-token-plan
        ```

        For the **China** endpoint in Beijing:

        ```bash
        openclaw onboard --auth-choice qwen-token-plan-cn
        ```
      </Step>
      <Step title="Verify the provider">
        ```bash
        openclaw models list --provider qwen-token-plan
        openclaw agent --model qwen-token-plan/qwen3.7-plus --message "Reply with: token plan ready"
        ```
      </Step>
    </Steps>

    <Note>
    Alibaba's OpenClaw guide uses `bailian-token-plan` for a manual custom
    provider. The plugin registers that id as a compatibility owner, but new
    configs should use `qwen-token-plan`. An exact custom
    `models.providers.bailian-token-plan` entry keeps ownership of its configured
    transport and catalog; it is never merged into the canonical OpenAI catalog.
    </Note>

    <Warning>
    Use Token Plan only for interactive OpenClaw sessions. Do not select it for
    cron jobs, unattended scripts, or application backends. Alibaba states that
    non-interactive use can suspend the subscription or revoke its API key.
    </Warning>

  </Tab>

  <Tab title="Qwen OAuth / Portal">
    **Best for:** a Qwen Portal token against `https://portal.qwen.ai/v1`.

    See [Qwen OAuth / Portal](/providers/qwen-oauth) for the dedicated provider
    page and migration notes.

    <Steps>
      <Step title="Provide your portal token">
        ```bash
        openclaw onboard --auth-choice qwen-oauth
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "qwen-oauth/qwen3.5-plus" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider qwen-oauth
        ```
      </Step>
    </Steps>

    <Note>
    `qwen-oauth` uses the same `QWEN_API_KEY` env var name as the Qwen Cloud
    provider, but stores auth under the `qwen-oauth` provider id when configured
    through OpenClaw onboarding.
    </Note>

  </Tab>
</Tabs>

## Plan types and endpoints

| Plan                       | Region | Auth choice                | Endpoint                                                         |
| -------------------------- | ------ | -------------------------- | ---------------------------------------------------------------- |
| Coding Plan (subscription) | China  | `qwen-api-key-cn`          | `coding.dashscope.aliyuncs.com/v1`                               |
| Coding Plan (subscription) | Global | `qwen-api-key`             | `coding-intl.dashscope.aliyuncs.com/v1`                          |
| Qwen Portal                | Global | `qwen-oauth`               | `portal.qwen.ai/v1`                                              |
| Standard (pay-as-you-go)   | China  | `qwen-standard-api-key-cn` | `dashscope.aliyuncs.com/compatible-mode/v1`                      |
| Standard (pay-as-you-go)   | Global | `qwen-standard-api-key`    | `dashscope-intl.aliyuncs.com/compatible-mode/v1`                 |
| Token Plan (Team Edition)  | China  | `qwen-token-plan-cn`       | `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`     |
| Token Plan (Team Edition)  | Global | `qwen-token-plan`          | `token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |

The provider auto-selects the endpoint based on your auth choice. Canonical
choices use the `qwen-*` family; `modelstudio-*` remains compatibility-only.
Override with a custom `baseUrl` in config.

<Tip>
**Manage keys:** [home.qwencloud.com/api-keys](https://home.qwencloud.com/api-keys) |
**Docs:** [docs.qwencloud.com](https://docs.qwencloud.com/developer-guides/getting-started/introduction)
</Tip>

## Built-in catalog

OpenClaw ships this Qwen static catalog. The catalog is endpoint-aware: Coding
Plan configs omit models that only work on the Standard endpoint.

| Model ref                   | Input       | Context   | Notes                   |
| --------------------------- | ----------- | --------- | ----------------------- |
| `qwen/qwen3.5-plus`         | text, image | 1,000,000 | Default model           |
| `qwen/qwen3.6-flash`        | text, image | 1,000,000 | Standard endpoints only |
| `qwen/qwen3.6-plus`         | text, image | 1,000,000 | Coding Plan + Standard  |
| `qwen/qwen3.7-max`          | text        | 1,000,000 | Standard endpoints only |
| `qwen/qwen3.7-plus`         | text, image | 1,000,000 | Coding Plan + Standard  |
| `qwen/qwen3-max-2026-01-23` | text        | 262,144   | Qwen Max line           |
| `qwen/qwen3-coder-next`     | text        | 262,144   | Coding                  |
| `qwen/qwen3-coder-plus`     | text        | 1,000,000 | Coding                  |
| `qwen/MiniMax-M2.5`         | text        | 1,000,000 | Reasoning enabled       |
| `qwen/glm-5`                | text        | 202,752   | GLM                     |
| `qwen/glm-4.7`              | text        | 202,752   | GLM                     |
| `qwen/kimi-k2.5`            | text, image | 262,144   | Moonshot AI via Alibaba |
| `qwen-oauth/qwen3.5-plus`   | text, image | 1,000,000 | Qwen Portal default     |

<Note>
Availability can still vary by endpoint and billing plan even when a model is
present in the static catalog.
</Note>

### Token Plan catalog

Token Plan uses a separate exact-string allowlist. Image-generation-only plan
models are not included here because they use different APIs.

| Model ref                           | Input       | Context   |
| ----------------------------------- | ----------- | --------- |
| `qwen-token-plan/qwen3.7-max`       | text        | 1,000,000 |
| `qwen-token-plan/qwen3.7-plus`      | text, image | 1,000,000 |
| `qwen-token-plan/qwen3.6-plus`      | text, image | 1,000,000 |
| `qwen-token-plan/qwen3.6-flash`     | text, image | 1,000,000 |
| `qwen-token-plan/deepseek-v4-pro`   | text        | 1,000,000 |
| `qwen-token-plan/deepseek-v4-flash` | text        | 1,000,000 |
| `qwen-token-plan/deepseek-v3.2`     | text        | 131,072   |
| `qwen-token-plan/kimi-k2.7-code`    | text, image | 262,144   |
| `qwen-token-plan/kimi-k2.6`         | text, image | 262,144   |
| `qwen-token-plan/kimi-k2.5`         | text, image | 262,144   |
| `qwen-token-plan/glm-5.2`           | text        | 1,000,000 |
| `qwen-token-plan/glm-5.1`           | text        | 202,752   |
| `qwen-token-plan/glm-5`             | text        | 202,752   |
| `qwen-token-plan/MiniMax-M2.5`      | text        | 196,608   |

## Thinking controls

`qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, and `qwen3.6-plus` are
reasoning-enabled in the built-in catalog. For reasoning models on the `qwen`
family, the provider maps OpenClaw thinking levels to DashScope's top-level
`enable_thinking` request flag: disabled thinking sends `enable_thinking: false`,
any other level sends `enable_thinking: true`. Custom models can opt into an
alternate chat-template thinking payload by setting
`compat.thinkingFormat: "qwen-chat-template"` on the model entry.

Token Plan models are also marked reasoning-capable. `kimi-k2.7-code` and
`MiniMax-M2.5` are thinking-only, so OpenClaw keeps thinking enabled even when
the session requests `/think off`. DeepSeek V4 maps `minimal` through `high` to
the service's `high` effort and maps `xhigh` or `max` to `max`. GLM 5.2 accepts
the full `minimal` through `max` range; GLM 5.1 and GLM 5 accept through
`xhigh`, and all three default to `high`. Other hybrid models follow the
requested on/off state.

## Multimodal add-ons

The `qwen` plugin exposes multimodal capabilities on the **Standard** DashScope
endpoints only, not the Coding Plan endpoints:

- **Image and video understanding** via `qwen-vl-max-latest`
- **Wan video generation** via `wan2.6-t2v` (default), `wan2.6-i2v`, `wan2.6-r2v`, `wan2.6-r2v-flash`, `wan2.7-r2v`

Media understanding is auto-resolved from the configured Qwen auth; no extra
config is needed. Make sure you are on a Standard (pay-as-you-go) endpoint for
media understanding to work.

To make Qwen the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "qwen/wan2.6-t2v" },
    },
  },
}
```

Video-generation limits: 1 output video per request, up to 1 input image
(image-to-video), up to 4 input videos (video-to-video), max 10 seconds
duration. Supports `size`, `aspectRatio`, `resolution`, `audio`, and
`watermark`. Reference image/video inputs require remote http(s) URLs; local
file paths are rejected up front because the DashScope video endpoint does not
accept uploaded local buffers for those references.

<Note>
See [Video generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Qwen 3.6 and 3.7 availability">
    `qwen3.7-plus` and `qwen3.6-plus` are available on Coding Plan and Standard endpoints. `qwen3.7-max` and `qwen3.6-flash` are Standard-only. The Standard (pay-as-you-go) endpoints are:

    - China: `dashscope.aliyuncs.com/compatible-mode/v1`
    - Global: `dashscope-intl.aliyuncs.com/compatible-mode/v1`

    OpenClaw omits `qwen3.7-max` and `qwen3.6-flash` from Coding Plan catalogs.
    If a Coding Plan endpoint returns an "unsupported model" error for either,
    switch to the matching Standard endpoint and key.

  </Accordion>

  <Accordion title="Video generation region routing">
    OpenClaw maps the configured Qwen region to the matching DashScope AIGC host
    before submitting a video job:

    - Global/Intl: `https://dashscope-intl.aliyuncs.com`
    - China: `https://dashscope.aliyuncs.com`

    A normal `models.providers.qwen.baseUrl` pointing at either the Coding Plan
    or Standard Qwen hosts still routes video generation to the matching
    regional DashScope video endpoint.

  </Accordion>

  <Accordion title="Streaming usage compatibility">
    Native Qwen endpoints advertise streaming usage compatibility on the shared
    `openai-completions` transport, so DashScope-compatible custom provider ids
    targeting the same native hosts inherit the same behavior without requiring
    the built-in `qwen` provider id specifically. This applies to Coding Plan,
    Standard, and Token Plan endpoints:

    - `https://coding.dashscope.aliyuncs.com/v1`
    - `https://coding-intl.dashscope.aliyuncs.com/v1`
    - `https://dashscope.aliyuncs.com/compatible-mode/v1`
    - `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
    - `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
    - `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`

  </Accordion>

  <Accordion title="Capability plan">
    The `qwen` plugin is being positioned as the vendor home for the full Qwen
    Cloud surface, not just coding/text models.

    - **Text/chat models:** available through the plugin
    - **Tool calling, structured output, thinking:** inherited from the OpenAI-compatible transport
    - **Image generation:** planned at the provider-plugin layer
    - **Image/video understanding:** available through the plugin on the Standard endpoint
    - **Speech/audio:** planned at the provider-plugin layer
    - **Memory embeddings/reranking:** planned through the embedding adapter surface
    - **Video generation:** available through the plugin through the shared video-generation capability

  </Accordion>

  <Accordion title="Environment and daemon setup">
    If the Gateway runs as a daemon (launchd/systemd), make sure `QWEN_API_KEY`
    or `QWEN_TOKEN_PLAN_API_KEY` is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="Alibaba Model Studio" href="/providers/alibaba" icon="cloud">
    Bundled Wan video generation provider on the same DashScope platform.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
