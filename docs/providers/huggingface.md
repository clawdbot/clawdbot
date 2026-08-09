---
summary: "Hugging Face Inference setup (auth + model selection)"
read_when:
  - You want to use Hugging Face Inference with OpenClaw
  - You need the HF token env var or CLI auth choice
title: "Hugging Face (inference)"
---

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) exposes an OpenAI-compatible chat completions router in front of many hosted models (DeepSeek, Llama, and more) under one token. OpenClaw talks to the **chat completions endpoint only**; for text-to-image, embeddings, or speech use the [HF inference clients](https://huggingface.co/docs/api-inference/quicktour) directly.

| Property     | Value                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Provider id  | `huggingface`                                                                                                               |
| Plugin       | bundled (enabled by default, no install step)                                                                               |
| Auth env var | `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN` (fine-grained token)                                                                  |
| API          | OpenAI-compatible (`https://router.huggingface.co/v1`)                                                                      |
| Billing      | Single HF token; [pricing](https://huggingface.co/docs/inference-providers/pricing) follows provider rates with a free tier |

## Getting started

<Steps>
  <Step title="Create a fine-grained token">
    Go to [Hugging Face Settings Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) and create a new fine-grained token.

    <Warning>
    The token must have the **Make calls to Inference Providers** permission enabled or API requests will be rejected.
    </Warning>

  </Step>
  <Step title="Run onboarding">
    Choose **Hugging Face** in the provider dropdown, then enter your API key when prompted:

    ```bash
    openclaw onboard --auth-choice huggingface-api-key
    ```

  </Step>
  <Step title="Select a default model">
    In the **Default Hugging Face model** dropdown, pick a model. The list loads from the Inference API when your token is valid; otherwise OpenClaw shows the built-in catalog below. Your choice is saved as `agents.defaults.model.primary`:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider huggingface
    ```
  </Step>
</Steps>

### Non-interactive setup

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

Sets `huggingface/deepseek-ai/DeepSeek-R1` as the default model.

## Model IDs

Model refs use the form `huggingface/<org>/<model>` (Hub-style IDs). OpenClaw's built-in catalog:

| Model         | Ref (prefix with `huggingface/`) |
| ------------- | -------------------------------- |
| DeepSeek R1   | `deepseek-ai/DeepSeek-R1`        |
| DeepSeek V3.1 | `deepseek-ai/DeepSeek-V3.1`      |
| GPT-OSS 120B  | `openai/gpt-oss-120b`            |

<Tip>
When your token is valid, OpenClaw also discovers any other model from **GET** `https://router.huggingface.co/v1/models` at onboarding time and Gateway startup, so your catalog can include far more than the three models above. You can append `:fastest` or `:cheapest` to any model id; HF's router routes to the matching inference provider. Set your default provider order in [Inference Provider settings](https://hf.co/settings/inference-providers).
</Tip>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Model discovery and onboarding dropdown">
    OpenClaw discovers models with:

    ```bash
    GET https://router.huggingface.co/v1/models
    Authorization: Bearer $HUGGINGFACE_HUB_TOKEN   # or $HF_TOKEN
    ```

    The response is OpenAI-style: `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`.

    With a configured key (onboarding, `HUGGINGFACE_HUB_TOKEN`, or `HF_TOKEN`), the **Default Hugging Face model** dropdown during interactive setup is populated from this endpoint. Gateway startup repeats the same call to refresh the catalog. Discovered models are merged with the built-in catalog above (used for metadata like context window and cost when an id matches). If the request fails, returns no data, or no key is set, OpenClaw falls back to the built-in catalog only.

    Disable discovery without removing the provider:

    ```bash
    openclaw config set plugins.entries.huggingface.config.discovery.enabled false
    ```

  </Accordion>

  <Accordion title="Model names, aliases, and policy suffixes">
    - **Name from API:** discovered models use the API's `name`, `title`, or `display_name` when present; otherwise OpenClaw derives a name from the model id (e.g. `deepseek-ai/DeepSeek-R1` becomes "DeepSeek R1").
    - **Override display name:** set a custom label per model in config:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (fast)" },
            "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (cheap)" },
          },
        },
      },
    }
    ```

    - **Policy suffixes:** `:fastest` and `:cheapest` are HF router conventions, not something OpenClaw rewrites: the suffix is sent verbatim as part of the model id and HF's router picks the matching inference provider. Add each variant as its own entry under `models.providers.huggingface.models` (or in `model.primary`) if you want a distinct alias per suffix.
    - **Config merge:** existing entries in `models.providers.huggingface.models` (e.g. in `models.json`) are kept on config merge, so any custom `name`, `alias`, or model options you set there persist across restarts.

  </Accordion>

  <Accordion title="Environment and daemon setup">
    If the Gateway runs as a daemon (launchd/systemd), make sure `HUGGINGFACE_HUB_TOKEN` or `HF_TOKEN` is available to that process (for example, in `~/.openclaw/.env` or via `env.shellEnv`).

    <Note>
    OpenClaw accepts both `HUGGINGFACE_HUB_TOKEN` and `HF_TOKEN`. If both are set, `HUGGINGFACE_HUB_TOKEN` takes precedence.
    </Note>

  </Accordion>

  <Accordion title="Config: DeepSeek R1 with fallback">
    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "huggingface/deepseek-ai/DeepSeek-R1",
            fallbacks: ["huggingface/openai/gpt-oss-120b"],
          },
          models: {
            "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
            "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Config: DeepSeek with cheapest and fastest variants">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
          models: {
            "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
            "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (cheapest)" },
            "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (fastest)" },
          },
        },
      },
    }
    ```
  </Accordion>

  <Accordion title="Config: DeepSeek + GPT-OSS with aliases">
    ```json5
    {
      agents: {
        defaults: {
          model: {
            primary: "huggingface/deepseek-ai/DeepSeek-V3.1",
            fallbacks: ["huggingface/openai/gpt-oss-120b"],
          },
          models: {
            "huggingface/deepseek-ai/DeepSeek-V3.1": { alias: "DeepSeek V3.1" },
            "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
          },
        },
      },
    }
    ```
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Model selection" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="Inference Providers docs" href="https://huggingface.co/docs/inference-providers" icon="book">
    Official Hugging Face Inference Providers documentation.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>
