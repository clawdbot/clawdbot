---
summary: "Use Xiaomi MiMo pay-as-you-go and Token Plan models with OpenClaw"
read_when:
  - You want Xiaomi MiMo models in OpenClaw
  - You need Xiaomi MiMo auth or Token Plan setup
title: "Xiaomi MiMo"
---

Xiaomi MiMo is the API platform for **MiMo** models. The bundled `xiaomi`
plugin (`enabledByDefault: true`, no install step) registers two text
providers plus a speech (TTS) provider:

- `xiaomi` - pay-as-you-go keys (`sk-...`)
- `xiaomi-token-plan` - Token Plan keys (`tp-...`) with regional endpoint presets

| Property         | Value                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider ids     | `xiaomi` (pay-as-you-go), `xiaomi-token-plan` (Token Plan)                                                                                         |
| Auth env vars    | `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_API_KEY`                                                                                                      |
| Onboarding flags | `--auth-choice xiaomi-api-key`, `--auth-choice xiaomi-token-plan-cn`, `--auth-choice xiaomi-token-plan-sgp`, `--auth-choice xiaomi-token-plan-ams` |
| Direct CLI flags | `--xiaomi-api-key <key>`, `--xiaomi-token-plan-api-key <key>`                                                                                      |
| API              | OpenAI-compatible chat completions (`openai-completions`)                                                                                          |
| Speech contract  | `speechProviders: ["xiaomi"]`                                                                                                                      |
| Base URLs        | Pay-as-you-go: `https://api.xiaomimimo.com/v1`; Token Plan: `token-plan-{cn,sgp,ams}.xiaomimimo.com/v1`                                            |
| Default models   | `xiaomi/mimo-v2.5`, `xiaomi-token-plan/mimo-v2.5-pro`                                                                                              |
| TTS default      | `mimo-v2.5-tts`, voice `mimo_default`; voicedesign model `mimo-v2.5-tts-voicedesign`                                                               |

## Getting started

<Steps>
  <Step title="Get the right key">
    Create a pay-as-you-go key in the [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys), or open your Token Plan subscription page and copy the regional OpenAI-compatible base URL plus the matching `tp-...` key.
  </Step>

  <Step title="Run onboarding">
    Pay-as-you-go:

    ```bash
    openclaw onboard --auth-choice xiaomi-api-key
    ```

    Token Plan:

    ```bash
    openclaw onboard --auth-choice xiaomi-token-plan-sgp
    ```

    Or pass the keys directly:

    ```bash
    openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
    openclaw onboard --auth-choice xiaomi-token-plan-sgp --xiaomi-token-plan-api-key "$XIAOMI_TOKEN_PLAN_API_KEY"
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider xiaomi
    openclaw models list --provider xiaomi-token-plan
    ```
  </Step>
</Steps>

<Tip>
Onboarding validates the key shape and warns when a `tp-...` key is entered into the pay-as-you-go path, or an `sk-...` key is entered into the Token Plan path.
</Tip>

## Pay-as-you-go catalog

| Model ref              | Input       | Context   | Max output | Reasoning | Notes         |
| ---------------------- | ----------- | --------- | ---------- | --------- | ------------- |
| `xiaomi/mimo-v2.5`     | text, image | 1,048,576 | 131,072    | Yes       | Default model |
| `xiaomi/mimo-v2.5-pro` | text        | 1,048,576 | 131,072    | Yes       | Flagship      |

## Token Plan catalog

Choose the Token Plan auth choice that matches the regional base URL shown in Xiaomi's subscription UI:

| Auth choice             | Base URL                                   |
| ----------------------- | ------------------------------------------ |
| `xiaomi-token-plan-cn`  | `https://token-plan-cn.xiaomimimo.com/v1`  |
| `xiaomi-token-plan-sgp` | `https://token-plan-sgp.xiaomimimo.com/v1` |
| `xiaomi-token-plan-ams` | `https://token-plan-ams.xiaomimimo.com/v1` |

| Model ref                         | Input       | Context   | Max output | Reasoning | Notes         |
| --------------------------------- | ----------- | --------- | ---------- | --------- | ------------- |
| `xiaomi-token-plan/mimo-v2.5-pro` | text        | 1,048,576 | 131,072    | Yes       | Default model |
| `xiaomi-token-plan/mimo-v2.5`     | text, image | 1,048,576 | 131,072    | Yes       | Multimodal    |

`xiaomi-token-plan` needs a regional base URL to resolve. The supported path
is a bundled Token Plan onboarding choice or an explicit
`models.providers.xiaomi-token-plan` config block with `baseUrl` set; the
provider is not offered without one of those.

## Reasoning models

`mimo-v2.5` and `mimo-v2.5-pro` support
OpenClaw's [`/think` directive](/tools/thinking) with levels `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max` (default `high`).

## Text-to-speech

The bundled `xiaomi` plugin also registers Xiaomi MiMo as a speech provider
for `tts`. It calls Xiaomi's chat-completions TTS contract with the
text as an `assistant` message and optional style guidance as a `user`
message.

| Property | Value                                    |
| -------- | ---------------------------------------- |
| TTS id   | `xiaomi` (`mimo` alias)                  |
| Auth     | `XIAOMI_API_KEY`                         |
| API      | `POST /v1/chat/completions` with `audio` |
| Default  | `mimo-v2.5-tts`, voice `mimo_default`    |
| Output   | MP3 by default; WAV when configured      |

```json5
{
  tts: {
    auto: "always",
    provider: "xiaomi",
    providers: {
      xiaomi: {
        apiKey: "xiaomi_api_key",
        model: "mimo-v2.5-tts",
        speakerVoice: "mimo_default",
        format: "mp3",
        style: "Bright, natural, conversational tone.",
      },
    },
  },
}
```

Built-in voices: `mimo_default`, `default_zh`, `default_en`, `Mia`, `Chloe`,
`Milo`, `Dean`. The preset-voice model `mimo-v2.5-tts` uses `audio.voice`, so
OpenClaw sends `speakerVoice` for that model.

The voicedesign model `mimo-v2.5-tts-voicedesign` generates the voice from a
natural-language style prompt instead of a preset voice id. Set `style` to
the desired voice description; OpenClaw sends it as the `user` message, sends
the spoken text as the `assistant` message, and omits `audio.voice` for this
model.

```json5
{
  tts: {
    provider: "xiaomi",
    providers: {
      xiaomi: {
        model: "mimo-v2.5-tts-voicedesign",
        format: "wav",
        style: "Warm, natural female voice with clear pronunciation.",
      },
    },
  },
}
```

For channels that request a voice-note synthesis target (Discord, Feishu,
Matrix, Telegram, and WhatsApp), OpenClaw transcodes Xiaomi output to 48kHz
mono Opus with `ffmpeg` before delivery.

## Config example

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2.5" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2.5",
            name: "Xiaomi MiMo V2.5",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1048576,
            maxTokens: 131072,
          },
          {
            id: "mimo-v2.5-pro",
            name: "Xiaomi MiMo V2.5 Pro",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}
```

Pricing and compat flags come from the bundled plugin manifest, so the config example omits `cost` and `compat` to avoid diverging from runtime behavior.

Token Plan:

```json5
{
  env: { XIAOMI_TOKEN_PLAN_API_KEY: "tp-your-key" },
  agents: { defaults: { model: { primary: "xiaomi-token-plan/mimo-v2.5-pro" } } },
  models: {
    mode: "merge",
    providers: {
      "xiaomi-token-plan": {
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "XIAOMI_TOKEN_PLAN_API_KEY",
        models: [
          {
            id: "mimo-v2.5-pro",
            name: "Xiaomi MiMo V2.5 Pro",
            reasoning: true,
            input: ["text"],
            contextWindow: 1048576,
            maxTokens: 131072,
          },
          {
            id: "mimo-v2.5",
            name: "Xiaomi MiMo V2.5",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1048576,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}
```

Pricing comes from the bundled manifest (Token Plan models include tiered cache-read pricing), so the config example omits `cost`.

<AccordionGroup>
  <Accordion title="Auto-injection behavior">
    The `xiaomi` provider is auto-enabled when `XIAOMI_API_KEY` is set in your environment or an auth profile exists. `xiaomi-token-plan` needs a regional base URL, so the supported path is the bundled Token Plan onboarding choice or an explicit `models.providers.xiaomi-token-plan` config block.
  </Accordion>

  <Accordion title="Model details">
    - **mimo-v2.5** - pay-as-you-go default and Token Plan multimodal V2.5 route.
    - **mimo-v2.5-pro** - flagship reasoning model and Token Plan default.

    <Note>
    Pay-as-you-go models use the `xiaomi/` prefix. Token Plan models use the `xiaomi-token-plan/` prefix.
    </Note>

  </Accordion>

  <Accordion title="Troubleshooting">
    - If models do not appear, confirm the relevant key env var or auth profile is present and valid.
    - For Token Plan, confirm the chosen onboarding region matches the subscription page base URL and that the key starts with `tp-`.
    - When the Gateway runs as a daemon, ensure the key is available to that process (for example in `~/.openclaw/.env` or via `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for persistent availability.
    </Warning>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking levels" href="/tools/thinking" icon="brain">
    `/think` directive syntax and level mapping.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="Xiaomi MiMo console" href="https://platform.xiaomimimo.com" icon="arrow-up-right-from-square">
    Xiaomi MiMo dashboard and API key management.
  </Card>
</CardGroup>
