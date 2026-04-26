---
summary: "Volcano Engine setup (Doubao models, coding endpoints, and Seed Speech TTS)"
title: "Volcengine (Doubao)"
read_when:
  - You want to use Volcano Engine or Doubao models with OpenClaw
  - You need the Volcengine API key setup
  - You want to use Volcengine Speech text-to-speech
---

The Volcengine provider gives access to Doubao models and third-party models
hosted on Volcano Engine, with separate endpoints for general and coding
workloads. The same bundled plugin can also register Volcengine Speech as a TTS
provider.

| Detail     | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Providers  | `volcengine` (general + TTS) + `volcengine-plan` (coding)  |
| Model auth | `VOLCANO_ENGINE_API_KEY`                                   |
| TTS auth   | `VOLCENGINE_TTS_API_KEY` or `BYTEPLUS_SEED_SPEECH_API_KEY` |
| API        | OpenAI-compatible models, BytePlus Seed Speech TTS         |

## Getting started

<Steps>
  <Step title="Set the API key">
    Run interactive onboarding:

    ```bash
    openclaw onboard --auth-choice volcengine-api-key
    ```

    This registers both the general (`volcengine`) and coding (`volcengine-plan`) providers from a single API key.

  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "volcengine-plan/ark-code-latest" },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider volcengine
    openclaw models list --provider volcengine-plan
    ```
  </Step>
</Steps>

<Tip>
For non-interactive setup (CI, scripting), pass the key directly:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

</Tip>

## Providers and endpoints

| Provider          | Endpoint                                  | Use case       |
| ----------------- | ----------------------------------------- | -------------- |
| `volcengine`      | `ark.cn-beijing.volces.com/api/v3`        | General models |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | Coding models  |

<Note>
Both providers are configured from a single API key. Setup registers both automatically.
</Note>

## Built-in catalog

<Tabs>
  <Tab title="General (volcengine)">
    | Model ref                                    | Name                            | Input       | Context |
    | -------------------------------------------- | ------------------------------- | ----------- | ------- |
    | `volcengine/doubao-seed-1-8-251228`          | Doubao Seed 1.8                 | text, image | 256,000 |
    | `volcengine/doubao-seed-code-preview-251028` | doubao-seed-code-preview-251028 | text, image | 256,000 |
    | `volcengine/kimi-k2-5-260127`                | Kimi K2.5                       | text, image | 256,000 |
    | `volcengine/glm-4-7-251222`                  | GLM 4.7                         | text, image | 200,000 |
    | `volcengine/deepseek-v3-2-251201`            | DeepSeek V3.2                   | text, image | 128,000 |
  </Tab>
  <Tab title="Coding (volcengine-plan)">
    | Model ref                                         | Name                     | Input | Context |
    | ------------------------------------------------- | ------------------------ | ----- | ------- |
    | `volcengine-plan/ark-code-latest`                 | Ark Coding Plan          | text  | 256,000 |
    | `volcengine-plan/doubao-seed-code`                | Doubao Seed Code         | text  | 256,000 |
    | `volcengine-plan/glm-4.7`                         | GLM 4.7 Coding           | text  | 200,000 |
    | `volcengine-plan/kimi-k2-thinking`                | Kimi K2 Thinking         | text  | 256,000 |
    | `volcengine-plan/kimi-k2.5`                       | Kimi K2.5 Coding         | text  | 256,000 |
    | `volcengine-plan/doubao-seed-code-preview-251028` | Doubao Seed Code Preview | text  | 256,000 |
  </Tab>
</Tabs>

## Text-to-speech

Volcengine TTS uses the BytePlus Seed Speech HTTP API and is configured
separately from the OpenAI-compatible Doubao model API key. In the BytePlus
console, open Seed Speech > Settings > API Keys and copy the API key, then set:

```bash
export VOLCENGINE_TTS_API_KEY="byteplus_seed_speech_api_key"
export VOLCENGINE_TTS_RESOURCE_ID="seed-tts-1.0"
```

Then enable it in `openclaw.json`:

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "volcengine",
      providers: {
        volcengine: {
          apiKey: "byteplus_seed_speech_api_key",
          voice: "en_female_anna_mars_bigtts",
          speedRatio: 1.0,
        },
      },
    },
  },
}
```

For voice-note targets, OpenClaw asks Volcengine for provider-native
`ogg_opus`. For normal audio attachments, it asks for `mp3`. Provider aliases
`bytedance` and `doubao` also resolve to the same speech provider.

The default resource id is `seed-tts-1.0` because that is what BytePlus grants
to newly created Seed Speech API keys in the default project. If your project
has TTS 2.0 entitlement, set `VOLCENGINE_TTS_RESOURCE_ID=seed-tts-2.0`.

<Warning>
`VOLCANO_ENGINE_API_KEY` is for the ModelArk/Doubao model endpoints and is not a
Seed Speech API key. TTS needs a Seed Speech API key from the BytePlus Speech
Console, or a legacy Speech Console AppID/token pair.
</Warning>

Legacy AppID/token auth remains supported for older Speech Console applications:

```bash
export VOLCENGINE_TTS_APPID="speech_app_id"
export VOLCENGINE_TTS_TOKEN="speech_access_token"
export VOLCENGINE_TTS_CLUSTER="volcano_tts"
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Default model after onboarding">
    `openclaw onboard --auth-choice volcengine-api-key` currently sets
    `volcengine-plan/ark-code-latest` as the default model while also registering
    the general `volcengine` catalog.
  </Accordion>

  <Accordion title="Model picker fallback behavior">
    During onboarding/configure model selection, the Volcengine auth choice prefers
    both `volcengine/*` and `volcengine-plan/*` rows. If those models are not
    loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an
    empty provider-scoped picker.
  </Accordion>

  <Accordion title="Environment variables for daemon processes">
    If the Gateway runs as a daemon (launchd/systemd), make sure model and TTS
    env vars such as `VOLCANO_ENGINE_API_KEY`, `VOLCENGINE_TTS_API_KEY`,
    `BYTEPLUS_SEED_SPEECH_API_KEY`, `VOLCENGINE_TTS_APPID`, and
    `VOLCENGINE_TTS_TOKEN` are available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).
  </Accordion>
</AccordionGroup>

<Warning>
When running OpenClaw as a background service, environment variables set in your
interactive shell are not automatically inherited. See the daemon note above.
</Warning>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
  <Card title="FAQ" href="/help/faq" icon="circle-question">
    Frequently asked questions about OpenClaw setup.
  </Card>
</CardGroup>
