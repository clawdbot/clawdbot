---
summary: "Together AI setup (auth + model selection)"
title: "Together AI"
read_when:
  - You want to use Together AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

[Together AI](https://together.ai) provides access to leading open-source
models including Llama, DeepSeek, Kimi, and more through a unified API.

| Property | Value                         |
| -------- | ----------------------------- |
| Provider | `together`                    |
| Auth     | `TOGETHER_API_KEY`            |
| API      | OpenAI-compatible             |
| Base URL | `https://api.together.xyz/v1` |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key at
    [api.together.ai/settings/api-keys](https://api.together.ai/settings/api-keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice together-api-key
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
          },
        },
      },
    }
    ```
  </Step>
</Steps>

### Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

<Note>
The onboarding preset sets
`together/meta-llama/Llama-3.3-70B-Instruct-Turbo` as the default model.
</Note>

## Built-in catalog

OpenClaw ships this bundled Together catalog:

| Model ref                                          | Name                         | Input       | Context | Notes                |
| -------------------------------------------------- | ---------------------------- | ----------- | ------- | -------------------- |
| `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` | Llama 3.3 70B Instruct Turbo | text        | 131,072 | Default model        |
| `together/moonshotai/Kimi-K2.6`                    | Kimi K2.6 FP4                | text, image | 262,144 | Kimi reasoning model |
| `together/deepseek-ai/DeepSeek-V4-Pro`             | DeepSeek V4 Pro              | text        | 512,000 | Reasoning text model |
| `together/Qwen/Qwen2.5-7B-Instruct-Turbo`          | Qwen2.5 7B Instruct Turbo    | text        | 32,768  | Fast text model      |
| `together/zai-org/GLM-5.1`                         | GLM 5.1 FP4                  | text        | 202,752 | Reasoning text model |

## Video generation

The bundled `together` plugin also registers video generation through the
shared `video_generate` tool.

| Property             | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| Default video model  | `together/Wan-AI/Wan2.2-T2V-A14B`                                        |
| Modes                | text-to-video; single-image reference only with `Wan-AI/Wan2.2-I2V-A14B` |
| Supported parameters | `aspectRatio`, `resolution`                                              |

To use Together as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "together/Wan-AI/Wan2.2-T2V-A14B",
      },
    },
  },
}
```

<Tip>
See [Video Generation](/tools/video-generation) for the shared tool parameters,
provider selection, and failover behavior.
</Tip>

<AccordionGroup>
  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure
    `TOGETHER_API_KEY` is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed
    gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for
    persistent availability.
    </Warning>

  </Accordion>

  <Accordion title="Troubleshooting">
    - Verify your key works: `openclaw models list --provider together`
    - If models are not appearing, confirm the API key is set in the correct
      environment for your Gateway process.
    - Model refs use the form `together/<model-id>`.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="Video generation" href="/tools/video-generation" icon="video">
    Shared video generation tool parameters and provider selection.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="Together AI" href="https://together.ai" icon="arrow-up-right-from-square">
    Together AI dashboard, API docs, and pricing.
  </Card>
</CardGroup>
