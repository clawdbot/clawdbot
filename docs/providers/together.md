---
summary: "Together AI setup (auth + model selection)"
title: "Together AI"
read_when:
  - You want to use Together AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

[Together AI](https://together.ai) provides access to leading open-source
models including Llama, DeepSeek, Kimi, and more through a unified API.
OpenClaw bundles it as the `together` provider.

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
Onboarding sets `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` as the
default model.
</Note>

## Built-in catalog

Cost is USD per million tokens.

| Model ref                                          | Name                         | Input       | Context | Max output | Cost (in/out) | Notes               |
| -------------------------------------------------- | ---------------------------- | ----------- | ------- | ---------- | ------------- | ------------------- |
| `together/meta-llama/Llama-3.3-70B-Instruct-Turbo` | Llama 3.3 70B Instruct Turbo | text        | 131,072 | 8,192      | 0.88 / 0.88   | Default model       |
| `together/moonshotai/Kimi-K2.6`                    | Kimi K2.6 FP4                | text, image | 262,144 | 32,768     | 1.20 / 4.50   | Reasoning model     |
| `together/deepseek-ai/DeepSeek-V4-Pro`             | DeepSeek V4 Pro              | text        | 512,000 | 8,192      | 2.10 / 4.40   | Reasoning model     |
| `together/Qwen/Qwen2.5-7B-Instruct-Turbo`          | Qwen2.5 7B Instruct Turbo    | text        | 32,768  | 8,192      | 0.30 / 0.30   | Fast, non-reasoning |
| `together/zai-org/GLM-5.1`                         | GLM 5.1 FP4                  | text        | 202,752 | 8,192      | 1.40 / 4.40   | Reasoning model     |

## Video generation

The bundled `together` plugin also registers video generation through the
shared `video_generate` tool.

| Property             | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Default video model  | `Wan-AI/Wan2.2-T2V-A14B`                                                                  |
| Other models         | `Wan-AI/Wan2.2-I2V-A14B`, `minimax/hailuo-02`, `kwaivgI/kling-2.1-master`                 |
| Modes                | text-to-video; image-to-video only with `Wan-AI/Wan2.2-I2V-A14B` (single reference image) |
| Duration             | 1-10 seconds                                                                              |
| Supported parameters | `size` (parsed as `<width>x<height>`); `aspectRatio`/`resolution` are not read            |

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
See [Video generation](/tools/video-generation) for the shared tool parameters,
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
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
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
