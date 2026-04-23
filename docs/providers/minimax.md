---
summary: "Use MiniMax models in OpenClaw"
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: "MiniMax"
---

OpenClaw's MiniMax provider defaults to **MiniMax M2.7**.

MiniMax also provides:

- Bundled speech synthesis via T2A v2
- Bundled image understanding via `MiniMax-VL-01`
- Bundled music generation via `music-2.5+`
- Bundled `web_search` through the MiniMax Coding Plan search API

Provider split:

| Provider ID      | Auth    | Capabilities                                                    |
| ---------------- | ------- | --------------------------------------------------------------- |
| `minimax`        | API key | Text, image generation, image understanding, speech, web search |
| `minimax-portal` | OAuth   | Text, image generation, image understanding                     |

## Model lineup

| Model                    | Type             | Description                              |
| ------------------------ | ---------------- | ---------------------------------------- |
| `MiniMax-M2.7`           | Chat (reasoning) | Default hosted reasoning model           |
| `MiniMax-M2.7-highspeed` | Chat (reasoning) | Faster M2.7 reasoning tier               |
| `MiniMax-VL-01`          | Vision           | Image understanding model                |
| `image-01`               | Image generation | Text-to-image and image-to-image editing |
| `music-2.5+`             | Music generation | Default music model                      |
| `music-2.5`              | Music generation | Previous music generation tier           |
| `music-2.0`              | Music generation | Legacy music generation tier             |
| `MiniMax-Hailuo-2.3`     | Video generation | Text-to-video and image reference flows  |

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="OAuth (Coding Plan)">
    **Best for:** quick setup with MiniMax Coding Plan via OAuth, no API key required.

    <Tabs>
      <Tab title="International">
        <Steps>
          <Step title="Run onboarding">
            ```bash
            openclaw onboard --auth-choice minimax-global-oauth
            ```

            This authenticates against `api.minimax.io`.
          </Step>
          <Step title="Verify the model is available">
            ```bash
            openclaw models list --provider minimax-portal
            ```
          </Step>
        </Steps>
      </Tab>
      <Tab title="China">
        <Steps>
          <Step title="Run onboarding">
            ```bash
            openclaw onboard --auth-choice minimax-cn-oauth
            ```

            This authenticates against `api.minimaxi.com`.
          </Step>
          <Step title="Verify the model is available">
            ```bash
            openclaw models list --provider minimax-portal
            ```
          </Step>
        </Steps>
      </Tab>
    </Tabs>

    <Note>
    OAuth setups use the `minimax-portal` provider id. Model refs follow the form `minimax-portal/MiniMax-M2.7`.
    </Note>

    <Tip>
    Referral link for MiniMax Coding Plan (10% off): [MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
    </Tip>

  </Tab>

  <Tab title="API key">
    **Best for:** hosted MiniMax with Anthropic-compatible API.

    <Tabs>
      <Tab title="International">
        <Steps>
          <Step title="Run onboarding">
            ```bash
            openclaw onboard --auth-choice minimax-global-api
            ```

            This configures `api.minimax.io` as the base URL.
          </Step>
          <Step title="Verify the model is available">
            ```bash
            openclaw models list --provider minimax
            ```
          </Step>
        </Steps>
      </Tab>
      <Tab title="China">
        <Steps>
          <Step title="Run onboarding">
            ```bash
            openclaw onboard --auth-choice minimax-cn-api
            ```

            This configures `api.minimaxi.com` as the base URL.
          </Step>
          <Step title="Verify the model is available">
            ```bash
            openclaw models list --provider minimax
            ```
          </Step>
        </Steps>
      </Tab>
    </Tabs>

    ### Config example

    ```json5
    {
      env: { MINIMAX_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
      models: {
        mode: "merge",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            apiKey: "${MINIMAX_API_KEY}",
            api: "anthropic-messages",
            models: [
              {
                id: "MiniMax-M2.7",
                name: "MiniMax M2.7",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
                contextWindow: 204800,
                maxTokens: 131072,
              },
              {
                id: "MiniMax-M2.7-highspeed",
                name: "MiniMax M2.7 Highspeed",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
                contextWindow: 204800,
                maxTokens: 131072,
              },
            ],
          },
        },
      },
    }
    ```

    <Warning>
    On the Anthropic-compatible streaming path, OpenClaw disables MiniMax thinking by default unless you explicitly set `thinking` yourself. MiniMax's streaming endpoint emits `reasoning_content` in OpenAI-style delta chunks instead of native Anthropic thinking blocks, which can leak internal reasoning into visible output if left enabled implicitly.
    </Warning>

    <Note>
    API-key setups use the `minimax` provider id. Model refs follow the form `minimax/MiniMax-M2.7`.
    </Note>

  </Tab>
</Tabs>

## Configure via `openclaw configure`

Use the interactive config wizard to set MiniMax without editing JSON:

<Steps>
  <Step title="Launch the wizard">
    ```bash
    openclaw configure
    ```
  </Step>
  <Step title="Select Model/auth">
    Choose **Model/auth** from the menu.
  </Step>
  <Step title="Choose a MiniMax auth option">
    Pick one of the available MiniMax options:

    | Auth choice | Description |
    | --- | --- |
    | `minimax-global-oauth` | International OAuth (Coding Plan) |
    | `minimax-cn-oauth` | China OAuth (Coding Plan) |
    | `minimax-global-api` | International API key |
    | `minimax-cn-api` | China API key |

  </Step>
  <Step title="Pick your default model">
    Select your default model when prompted.
  </Step>
</Steps>

## Capabilities

### Image generation

The MiniMax plugin registers the `image-01` model for the `image_generate` tool. It supports:

- **Text-to-image generation** with aspect ratio control
- **Image-to-image editing** (subject reference) with aspect ratio control
- Up to **9 output images** per request
- Up to **1 reference image** per edit request
- Supported aspect ratios: `1:1`, `16:9`, `4:3`, `3:2`, `2:3`, `3:4`, `9:16`, `21:9`

To use MiniMax for image generation, set it as the image generation provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "minimax/image-01" },
    },
  },
}
```

The plugin uses the same `MINIMAX_API_KEY` or OAuth auth as the text models. No additional configuration is needed if MiniMax is already set up.

Both `minimax` and `minimax-portal` register `image_generate` with the same
`image-01` model. API-key setups use `MINIMAX_API_KEY`; OAuth setups can use
the bundled `minimax-portal` auth path instead.

When onboarding or API-key setup writes explicit `models.providers.minimax`
entries, OpenClaw materializes `MiniMax-M2.7` and
`MiniMax-M2.7-highspeed` with `input: ["text", "image"]`.

The built-in bundled MiniMax text catalog itself stays text-only metadata until
that explicit provider config exists. Image understanding is exposed separately
through the plugin-owned `MiniMax-VL-01` media provider.

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

### Music generation

The bundled `minimax` plugin also registers music generation through the shared
`music_generate` tool.

- Default music model: `minimax/music-2.5+`
- Also supports `minimax/music-2.5` and `minimax/music-2.0`
- Prompt controls: `lyrics`, `instrumental`, `durationSeconds`
- Output format: `mp3`
- Session-backed runs detach through the shared task/status flow, including `action: "status"`

To use MiniMax as the default music provider:

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "minimax/music-2.5+",
      },
    },
  },
}
```

<Note>
See [Music Generation](/tools/music-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

### Video generation

The bundled `minimax` plugin also registers video generation through the shared
`video_generate` tool.

- Default video model: `minimax/MiniMax-Hailuo-2.3`
- Modes: text-to-video and single-image reference flows
- Supports `aspectRatio` and `resolution`

To use MiniMax as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "minimax/MiniMax-Hailuo-2.3",
      },
    },
  },
}
```

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

### Image understanding

The MiniMax plugin registers image understanding separately from the text
catalog:

| Provider ID      | Default image model |
| ---------------- | ------------------- |
| `minimax`        | `MiniMax-VL-01`     |
| `minimax-portal` | `MiniMax-VL-01`     |

That is why automatic media routing can use MiniMax image understanding even
when the bundled text-provider catalog still shows text-only M2.7 chat refs.

### Web search

The MiniMax plugin also registers `web_search` through the MiniMax Coding Plan
search API.

- Provider id: `minimax`
- Structured results: titles, URLs, snippets, related queries
- Preferred env var: `MINIMAX_CODE_PLAN_KEY`
- Accepted env alias: `MINIMAX_CODING_API_KEY`
- Compatibility fallback: `MINIMAX_API_KEY` when it already points at a coding-plan token
- Region reuse: `plugins.entries.minimax.config.webSearch.region`, then `MINIMAX_API_HOST`, then MiniMax provider base URLs
- Search stays on provider id `minimax`; OAuth CN/global setup can still steer region indirectly through `models.providers.minimax-portal.baseUrl`

Config lives under `plugins.entries.minimax.config.webSearch.*`.

<Note>
See [MiniMax Search](/tools/minimax-search) for full web search configuration and usage.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Configuration options">
    | Option | Description |
    | --- | --- |
    | `models.providers.minimax.baseUrl` | Prefer `https://api.minimax.io/anthropic` (Anthropic-compatible); `https://api.minimax.io/v1` is optional for OpenAI-compatible payloads |
    | `models.providers.minimax.api` | Prefer `anthropic-messages`; `openai-completions` is optional for OpenAI-compatible payloads |
    | `models.providers.minimax.apiKey` | MiniMax API key (`MINIMAX_API_KEY`) |
    | `models.providers.minimax.models` | Define `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost` |
    | `agents.defaults.models` | Alias models you want in the allowlist |
    | `models.mode` | Keep `merge` if you want to add MiniMax alongside built-ins |
  </Accordion>

  <Accordion title="Thinking defaults">
    On `api: "anthropic-messages"`, OpenClaw injects `thinking: { type: "disabled" }` unless thinking is already explicitly set in params/config.

    This prevents MiniMax's streaming endpoint from emitting `reasoning_content` in OpenAI-style delta chunks, which would leak internal reasoning into visible output.

  </Accordion>

  <Accordion title="Fast mode">
    `/fast on` or `params.fastMode: true` rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed` on the Anthropic-compatible stream path.
  </Accordion>

  <Accordion title="Fallback example">
    **Best for:** keep your strongest latest-generation model as primary, fail over to MiniMax M2.7. Example below uses Opus as a concrete primary; swap to your preferred latest-gen primary model.

    ```json5
    {
      env: { MINIMAX_API_KEY: "sk-..." },
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { alias: "primary" },
            "minimax/MiniMax-M2.7": { alias: "minimax" },
          },
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["minimax/MiniMax-M2.7"],
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Coding Plan usage details">
    - Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requires a coding plan key).
    - OpenClaw normalizes MiniMax coding-plan usage to the same `% left` display used by other providers. MiniMax's raw `usage_percent` / `usagePercent` fields are remaining quota, not consumed quota, so OpenClaw inverts them. Count-based fields win when present.
    - When the API returns `model_remains`, OpenClaw prefers the chat-model entry, derives the window label from `start_time` / `end_time` when needed, and includes the selected model name in the plan label so coding-plan windows are easier to distinguish.
    - Usage snapshots treat `minimax`, `minimax-cn`, and `minimax-portal` as the same MiniMax quota surface, and prefer stored MiniMax OAuth before falling back to Coding Plan key env vars.
  </Accordion>
</AccordionGroup>

## Notes

- Model refs follow the auth path:
  - API-key setup: `minimax/<model>`
  - OAuth setup: `minimax-portal/<model>`
- Default chat model: `MiniMax-M2.7`
- Alternate chat model: `MiniMax-M2.7-highspeed`
- Onboarding and direct API-key setup write explicit model definitions with `input: ["text", "image"]` for both M2.7 variants
- The bundled provider catalog currently exposes the chat refs as text-only metadata until explicit MiniMax provider config exists
- Update pricing values in `models.json` if you need exact cost tracking
- Use `openclaw models list` to confirm the current provider id, then switch with `openclaw models set minimax/MiniMax-M2.7` or `openclaw models set minimax-portal/MiniMax-M2.7`

<Tip>
Referral link for MiniMax Coding Plan (10% off): [MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
</Tip>

<Note>
See [Model providers](/concepts/model-providers) for provider rules.
</Note>

## Troubleshooting

<AccordionGroup>
  <Accordion title='"Unknown model: minimax/MiniMax-M2.7"'>
    This usually means the **MiniMax provider is not configured** (no matching provider entry and no MiniMax auth profile/env key found). A fix for this detection is in **2026.1.12**. Fix by:

    - Upgrading to **2026.1.12** (or run from source `main`), then restarting the gateway.
    - Running `openclaw configure` and selecting a **MiniMax** auth option, or
    - Adding the matching `models.providers.minimax` or `models.providers.minimax-portal` block manually, or
    - Setting `MINIMAX_API_KEY`, `MINIMAX_OAUTH_TOKEN`, or a MiniMax auth profile so the matching provider can be injected.

    Make sure the model id is **case-sensitive**:

    - API-key path: `minimax/MiniMax-M2.7` or `minimax/MiniMax-M2.7-highspeed`
    - OAuth path: `minimax-portal/MiniMax-M2.7` or `minimax-portal/MiniMax-M2.7-highspeed`

    Then recheck with:

    ```bash
    openclaw models list
    ```

  </Accordion>
</AccordionGroup>

<Note>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Image generation" href="/tools/image-generation" icon="image">
    Shared image tool parameters and provider selection.
  </Card>
  <Card title="Music generation" href="/tools/music-generation" icon="music">
    Shared music tool parameters and provider selection.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video tool parameters and provider selection.
  </Card>
  <Card title="MiniMax Search" href="/tools/minimax-search" icon="magnifying-glass">
    Web search configuration via MiniMax Coding Plan.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
