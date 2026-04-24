---
summary: "Use OpenRouter's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via OpenRouter in OpenClaw
  - You want to use OpenRouter for image generation
title: "OpenRouter"
---

OpenRouter provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice openrouter-api-key
    ```
  </Step>
  <Step title="(Optional) Switch to a specific model">
    Onboarding defaults to `openrouter/auto`. Pick a concrete model later:

    ```bash
    openclaw models set openrouter/<provider>/<model>
    ```

  </Step>
</Steps>

## Config example

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/auto" },
    },
  },
}
```

## Model references

<Note>
Model refs follow the pattern `openrouter/<provider>/<model>`. For the full list of
available providers and models, see [/concepts/model-providers](/concepts/model-providers).
</Note>

Bundled fallback examples:

| Model ref                            | Notes                         |
| ------------------------------------ | ----------------------------- |
| `openrouter/auto`                    | OpenRouter automatic routing  |
| `openrouter/moonshotai/kimi-k2.6`    | Kimi K2.6 via MoonshotAI      |
| `openrouter/openrouter/healer-alpha` | OpenRouter Healer Alpha route |
| `openrouter/openrouter/hunter-alpha` | OpenRouter Hunter Alpha route |

## Image generation

OpenRouter can also back the `image_generate` tool. Use an OpenRouter image model under `agents.defaults.imageGenerationModel`:

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openrouter/google/gemini-3.1-flash-image-preview",
      },
    },
  },
}
```

OpenClaw sends image requests to OpenRouter's chat completions image API with `modalities: ["image", "text"]`. Gemini image models receive supported `aspectRatio` and `resolution` hints through OpenRouter's `image_config`.

## Authentication and headers

OpenRouter uses a Bearer token with your API key under the hood.

On real OpenRouter requests (`https://openrouter.ai/api/v1`), OpenClaw also adds
OpenRouter's documented app-attribution headers:

| Header                    | Value                 |
| ------------------------- | --------------------- |
| `HTTP-Referer`            | `https://openclaw.ai` |
| `X-OpenRouter-Title`      | `OpenClaw`            |
| `X-OpenRouter-Categories` | `cli-agent`           |

<Warning>
If you repoint the OpenRouter provider at some other proxy or base URL, OpenClaw
does **not** inject those OpenRouter-specific headers or Anthropic cache markers.
</Warning>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Anthropic cache markers">
    On verified OpenRouter routes, Anthropic model refs keep the
    OpenRouter-specific Anthropic `cache_control` markers that OpenClaw uses for
    better prompt-cache reuse on system/developer prompt blocks.
  </Accordion>

  <Accordion title="Thinking / reasoning injection">
    On supported non-`auto` routes, OpenClaw maps the selected thinking level to
    OpenRouter proxy reasoning payloads. Unsupported model hints and
    `openrouter/auto` skip that reasoning injection.
  </Accordion>

  <Accordion title="OpenAI-only request shaping">
    OpenRouter still runs through the proxy-style OpenAI-compatible path, so
    native OpenAI-only request shaping such as `serviceTier`, Responses `store`,
    OpenAI reasoning-compat payloads, and prompt-cache hints is not forwarded.
  </Accordion>

  <Accordion title="Gemini-backed routes">
    Gemini-backed OpenRouter refs stay on the proxy-Gemini path: OpenClaw keeps
    Gemini thought-signature sanitation there, but does not enable native Gemini
    replay validation or bootstrap rewrites.
  </Accordion>

  <Accordion title="Provider routing metadata">
    If you pass OpenRouter provider routing under model params, OpenClaw forwards
    it as OpenRouter routing metadata before the shared stream wrappers run.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
