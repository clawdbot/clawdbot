---
summary: "Use MiniMax models in OpenClaw"
read_when:
  - You want MiniMax models in OpenClaw
  - You need MiniMax setup guidance
title: "MiniMax"
---

The bundled `minimax` plugin registers two providers plus five capabilities: chat, image generation, music generation, video generation, image understanding, speech (T2A v2), and web search.

| Provider ID      | Auth    | Capabilities                                                                                        |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `minimax`        | API key | Text, image generation, music generation, video generation, image understanding, speech, web search |
| `minimax-portal` | OAuth   | Text, image generation, music generation, video generation, image understanding, speech             |

<Tip>
Referral link for MiniMax Coding Plan (10% off): [MiniMax Coding Plan](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
</Tip>

## Built-in catalog

| Model                    | Type             | Description                              |
| ------------------------ | ---------------- | ---------------------------------------- |
| `MiniMax-M3`             | Chat (reasoning) | Default hosted reasoning model           |
| `MiniMax-M2.7`           | Chat (reasoning) | Previous hosted reasoning model          |
| `MiniMax-M2.7-highspeed` | Chat (reasoning) | Faster M2.7 reasoning tier               |
| `MiniMax-VL-01`          | Vision           | Image understanding model                |
| `image-01`               | Image generation | Text-to-image and image-to-image editing |
| `music-2.6`              | Music generation | Default music model                      |
| `MiniMax-Hailuo-2.3`     | Video generation | Text-to-video and image-to-video flows   |

Model refs follow the auth path: `minimax/<model>` for API-key setups, `minimax-portal/<model>` for OAuth setups.

## Getting started

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

            Resulting provider base URL: `api.minimax.io`.
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

            Resulting provider base URL: `api.minimaxi.com`.
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
    OAuth setups use the `minimax-portal` provider id. Model refs follow the form `minimax-portal/MiniMax-M3`.
    </Note>

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
      agents: { defaults: { model: { primary: "minimax/MiniMax-M3" } } },
      models: {
        mode: "merge",
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            apiKey: "${MINIMAX_API_KEY}",
            api: "anthropic-messages",
            models: [
              {
                id: "MiniMax-M3",
                name: "MiniMax M3",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
                contextWindow: 1000000,
                maxTokens: 131072,
              },
              {
                id: "MiniMax-M2.7",
                name: "MiniMax M2.7",
                reasoning: true,
                input: ["text"],
                cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
                contextWindow: 204800,
                maxTokens: 131072,
              },
              {
                id: "MiniMax-M2.7-highspeed",
                name: "MiniMax M2.7 Highspeed",
                reasoning: true,
                input: ["text"],
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
    MiniMax-M2.x's Anthropic-compatible streaming endpoint emits `reasoning_content` in OpenAI-style delta chunks instead of native Anthropic thinking blocks, which leaks internal reasoning into visible output if thinking is left enabled implicitly. OpenClaw disables M2.x thinking by default unless you explicitly set `thinking` yourself. MiniMax-M3 (and forward-compatible M3.x) is exempt: M3 emits proper Anthropic thinking blocks and requires thinking active to produce visible content, so OpenClaw keeps M3 on the provider's adaptive thinking path. See the Thinking defaults section under Advanced configuration below.
    </Warning>

    <Note>
    API-key setups use the `minimax` provider id. Model refs follow the form `minimax/MiniMax-M3`.
    </Note>

  </Tab>
</Tabs>

## Configure via `openclaw configure`

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
    | Auth choice            | Description                        |
    | ----------------------- | ----------------------------------- |
    | `minimax-global-oauth` | International OAuth (Coding Plan)  |
    | `minimax-cn-oauth`     | China OAuth (Coding Plan)          |
    | `minimax-global-api`   | International API key              |
    | `minimax-cn-api`       | China API key                      |
  </Step>
  <Step title="Pick your default model">
    Select your default model when prompted.
  </Step>
</Steps>

## Capabilities

### Image generation

The MiniMax plugin registers the `image-01` model for the `image_generate` tool on both `minimax` and `minimax-portal`, reusing the same `MINIMAX_API_KEY` or OAuth auth as the text models.

- Text-to-image generation and image-to-image editing (subject reference), both with aspect ratio control
- Up to 9 output images per request, 1 reference image per edit request
- Supported aspect ratios: `1:1`, `16:9`, `4:3`, `3:2`, `2:3`, `3:4`, `9:16`, `21:9`

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: { primary: "minimax/image-01" },
    },
  },
}
```

Image generation always uses MiniMax's dedicated image endpoint (`/v1/image_generation`) and ignores `models.providers.minimax.baseUrl`, since that field configures the chat/Anthropic-compatible base URL instead. Set `MINIMAX_API_HOST=https://api.minimaxi.com` to route image generation through the CN endpoint; the default global endpoint is `https://api.minimax.io`.

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

### Text-to-speech

The bundled `minimax` plugin registers MiniMax T2A v2 as a speech provider for `tts`.

- Default TTS model: `speech-2.8-hd`
- Default voice: `English_expressive_narrator`
- Bundled model ids: `speech-2.8-hd`, `speech-2.8-turbo`, `speech-2.6-hd`, `speech-2.6-turbo`, `speech-02-hd`, `speech-02-turbo`, `speech-01-hd`, `speech-01-turbo`
- Auth resolution order: `tts.providers.minimax.apiKey`, then `minimax-portal` OAuth/token auth profiles, then Token Plan environment keys (`MINIMAX_OAUTH_TOKEN`, `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`), then `MINIMAX_API_KEY`
- If no TTS host is configured, OpenClaw reuses the configured `minimax-portal` OAuth host and strips Anthropic-compatible path suffixes such as `/anthropic`
- Normal audio attachments stay MP3. Voice-note targets (Feishu, Telegram, and other channels that request a voice-note-compatible attachment) are transcoded from MiniMax MP3 to 48kHz Opus with `ffmpeg`, because e.g. the Feishu/Lark file API only accepts `file_type: "opus"` for native audio messages
- MiniMax T2A accepts fractional `speed` and `vol`, but `pitch` is sent as an integer; OpenClaw truncates fractional `pitch` values before the API request

| Setting                         | Env var                | Default                       | Description                      |
| ------------------------------- | ---------------------- | ----------------------------- | -------------------------------- |
| `tts.providers.minimax.baseUrl` | `MINIMAX_API_HOST`     | `https://api.minimax.io`      | MiniMax T2A API host.            |
| `tts.providers.minimax.model`   | `MINIMAX_TTS_MODEL`    | `speech-2.8-hd`               | TTS model id.                    |
| `tts.providers.minimax.voiceId` | `MINIMAX_TTS_VOICE_ID` | `English_expressive_narrator` | Voice id used for speech output. |
| `tts.providers.minimax.speed`   |                        | `1.0`                         | Playback speed, `0.5..2.0`.      |
| `tts.providers.minimax.vol`     |                        | `1.0`                         | Volume, `(0, 10]`.               |
| `tts.providers.minimax.pitch`   |                        | `0`                           | Integer pitch shift, `-12..12`.  |

### Music generation

The bundled MiniMax plugin registers music generation through the shared `music_generate` tool for both `minimax` and `minimax-portal`.

- Default music model: `minimax/music-2.6` (OAuth: `minimax-portal/music-2.6`)
- Also supports `music-2.6-free`, `music-cover`, and `music-cover-free`
- Prompt controls: `lyrics`, `instrumental`
- Output format: `mp3`
- Session-backed runs detach through the shared task/status flow, including `action: "status"`

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: { primary: "minimax/music-2.6" },
    },
  },
}
```

<Note>
See [Music Generation](/tools/music-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

### Video generation

The bundled MiniMax plugin registers video generation through the shared `video_generate` tool for both `minimax` and `minimax-portal`.

- Default video model: `minimax/MiniMax-Hailuo-2.3` (OAuth: `minimax-portal/MiniMax-Hailuo-2.3`)
- Also supports `MiniMax-Hailuo-2.3-Fast`, `MiniMax-Hailuo-02`, `I2V-01-Director`, `I2V-01-live`, and `I2V-01`
- Modes: text-to-video and single-image reference flows
- Supports `resolution` (`768P` or `1080P` on Hailuo 2.3/02 models); `aspectRatio` is not supported and is ignored

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: { primary: "minimax/MiniMax-Hailuo-2.3" },
    },
  },
}
```

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters, provider selection, and failover behavior.
</Note>

### Image understanding

The MiniMax plugin registers image understanding separately from the text catalog:

| Provider ID      | Default image model | PDF text extraction |
| ---------------- | ------------------- | ------------------- |
| `minimax`        | `MiniMax-VL-01`     | `MiniMax-M2.7`      |
| `minimax-portal` | `MiniMax-VL-01`     | `MiniMax-M2.7`      |

That is why automatic media routing can use MiniMax image understanding even when the bundled text-provider catalog also includes M3 image-capable chat refs. PDF understanding uses `MiniMax-M2.7` for text extraction only; MiniMax does not register a PDF-to-image conversion path.

### Web search

The MiniMax plugin also registers `web_search` through the MiniMax Token Plan search API (`/v1/coding_plan/search`).

- Provider id: `minimax`
- Structured results: titles, URLs, snippets, related queries
- Preferred env var: `MINIMAX_CODE_PLAN_KEY`
- Accepted env aliases: `MINIMAX_CODING_API_KEY`, `MINIMAX_OAUTH_TOKEN`
- Compatibility fallback: `MINIMAX_API_KEY` when it already points at a token-plan credential
- Region reuse: `plugins.entries.minimax.config.webSearch.region`, then `MINIMAX_API_HOST`, then MiniMax provider base URLs
- Search stays on provider id `minimax`; OAuth CN/global setup can steer region indirectly through `models.providers.minimax-portal.baseUrl` and can provide bearer auth through `MINIMAX_OAUTH_TOKEN`

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
    | `agents.defaults.models` | Per-model aliases, parameters, and metadata |
    | `agents.defaults.modelPolicy.allow` | Optional explicit model allowlist |
    | `models.mode` | Keep `merge` if you want to add MiniMax alongside built-ins |
  </Accordion>

  <Accordion title="Thinking defaults">
    On `api: "anthropic-messages"`, OpenClaw injects `thinking: { type: "disabled" }` for MiniMax M2.x models unless an earlier wrapper already set the `thinking` field in the payload. This prevents M2.x's streaming endpoint from emitting `reasoning_content` in OpenAI-style delta chunks, which would leak internal reasoning into visible output.

    MiniMax-M3 (and M3.x) is exempt: M3 returns an empty `content` array with `stop_reason: "end_turn"` when thinking is disabled, so OpenClaw removes the implicit disabled default for M3 and, when a thinking level is set, forces `thinking: { type: "adaptive" }` instead.

    Available thinking levels per model family:

    | Model family   | Levels                                   | Default    |
    | -------------- | ----------------------------------------- | ---------- |
    | `MiniMax-M3`   | `off`, `adaptive`                        | `adaptive` |
    | `MiniMax-M2.x` | `off`, `minimal`, `low`, `medium`, `high` | `off`      |

  </Accordion>

  <Accordion title="Fast mode">
    `/fast on` or `params.fastMode: true` rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed` on the Anthropic-compatible stream path (`api: "anthropic-messages"`, provider `minimax` or `minimax-portal`).
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
    - Coding Plan usage API: `https://api.minimaxi.com/v1/token_plan/remains` or `https://api.minimax.io/v1/token_plan/remains` (requires a coding plan key).
    - Usage polling derives the host from `models.providers.minimax-portal.baseUrl` or `models.providers.minimax.baseUrl` when configured, so global setups using `https://api.minimax.io/anthropic` poll `api.minimax.io`. Missing or malformed base URLs keep the CN fallback for compatibility.
    - OpenClaw normalizes MiniMax coding-plan usage to the same `% left` display used by other providers. MiniMax's raw `usage_percent` / `usagePercent` fields are remaining quota, not consumed quota, so OpenClaw inverts them. Count-based fields win when present.
    - When the API returns `model_remains`, OpenClaw prefers the chat-model entry, derives the window label from `start_time` / `end_time` when needed, and includes the selected model name in the plan label so coding-plan windows are easier to distinguish.
    - Usage snapshots treat `minimax`, `minimax-cn`, `minimax-portal`, and `minimax-portal-cn` as the same MiniMax quota surface, and prefer stored MiniMax OAuth before falling back to Coding Plan key env vars.

  </Accordion>
</AccordionGroup>

## Notes

- Default chat model: `MiniMax-M3`. Alternate chat models: `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`
- Onboarding and direct API-key setup write model definitions for M3 and both M2.7 variants
- Image understanding uses the plugin-owned `MiniMax-VL-01` media provider
- Update pricing values in `models.json` if you need exact cost tracking
- Use `openclaw models list` to confirm the current provider id, then switch with `openclaw models set minimax/MiniMax-M3` or `openclaw models set minimax-portal/MiniMax-M3`

<Note>
See [Model providers](/concepts/model-providers) for provider rules.
</Note>

## Troubleshooting

<AccordionGroup>
  <Accordion title='"Unknown model: minimax/MiniMax-M3"'>
    This usually means the **MiniMax provider is not configured** (no matching provider entry and no MiniMax auth profile/env key found). Fix by:

    - Running `openclaw configure` and selecting a **MiniMax** auth option, or
    - Adding the matching `models.providers.minimax` or `models.providers.minimax-portal` block manually, or
    - Setting `MINIMAX_API_KEY`, `MINIMAX_OAUTH_TOKEN`, or a MiniMax auth profile so the matching provider can be injected.

    Make sure the model id is **case-sensitive**:

    - API-key path: `minimax/MiniMax-M3`, `minimax/MiniMax-M2.7`, or `minimax/MiniMax-M2.7-highspeed`
    - OAuth path: `minimax-portal/MiniMax-M3`, `minimax-portal/MiniMax-M2.7`, or `minimax-portal/MiniMax-M2.7-highspeed`

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
    Web search configuration via MiniMax Token Plan.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
