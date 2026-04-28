---
summary: "Use Kilo Gateway's unified API to access many models in OpenClaw"
title: "Kilocode"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Kilo Gateway in OpenClaw
---

# Kilo Gateway

Kilo Gateway provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

| Property | Value                              |
| -------- | ---------------------------------- |
| Provider | `kilocode`                         |
| Auth     | `KILOCODE_API_KEY`                 |
| API      | OpenAI-compatible                  |
| Base URL | `https://api.kilo.ai/api/gateway/` |

## Getting started

<Steps>
  <Step title="Create an account">
    Go to [app.kilo.ai](https://app.kilo.ai), sign in or create an account, then navigate to API Keys and generate a new key.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice kilocode-api-key
    ```

    Or set the environment variable directly:

    ```bash
    export KILOCODE_API_KEY="<your-kilocode-api-key>" # pragma: allowlist secret
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider kilocode
    ```
  </Step>
</Steps>

## Default model

The default model is `kilocode/kilo/auto`, a provider-owned smart-routing
model managed by Kilo Gateway.

<Note>
OpenClaw treats `kilocode/kilo/auto` as the stable default ref, but does not
publish a source-backed task-to-upstream-model mapping for that route. Exact
upstream routing behind `kilocode/kilo/auto` is owned by Kilo Gateway, not
hard-coded in OpenClaw.
</Note>

## Built-in catalog

OpenClaw dynamically discovers available models from the Kilo Gateway at startup. Use
`/models kilocode` to see the full list of models available with your account.

Any model available on the gateway can be used with the `kilocode/` prefix:

| Model ref                              | Notes                              |
| -------------------------------------- | ---------------------------------- |
| `kilocode/kilo/auto`                   | Default — smart routing            |
| `kilocode/anthropic/claude-sonnet-4`   | Anthropic via Kilo                 |
| `kilocode/openai/gpt-5.5`              | OpenAI via Kilo                    |
| `kilocode/google/gemini-3-pro-preview` | Google via Kilo                    |
| ...and many more                       | Use `/models kilocode` to list all |

<Tip>
At startup, OpenClaw queries `GET https://api.kilo.ai/api/gateway/models` and merges
discovered models ahead of the static fallback catalog. The bundled fallback always
includes `kilocode/kilo/auto` (`Kilo Auto`) with `input: ["text", "image"]`,
`reasoning: true`, `contextWindow: 1000000`, and `maxTokens: 128000`.
</Tip>

## Config example

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo/auto" },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Transport and compatibility">
    Kilo Gateway is documented in source as OpenRouter-compatible, so it stays on
    the proxy-style OpenAI-compatible path rather than native OpenAI request shaping.

    - Gemini-backed Kilo refs stay on the proxy-Gemini path, so OpenClaw keeps
      Gemini thought-signature sanitation there without enabling native Gemini
      replay validation or bootstrap rewrites.
    - Kilo Gateway uses a Bearer token with your API key under the hood.

  </Accordion>

  <Accordion title="Stream wrapper and reasoning">
    Kilo's shared stream wrapper adds the provider app header and normalizes
    proxy reasoning payloads for supported concrete model refs.

    <Warning>
    `kilocode/kilo/auto` and other proxy-reasoning-unsupported hints skip reasoning
    injection. If you need reasoning support, use a concrete model ref such as
    `kilocode/anthropic/claude-sonnet-4`.
    </Warning>

  </Accordion>

  <Accordion title="Troubleshooting">
    - If model discovery fails at startup, OpenClaw falls back to the bundled static catalog containing `kilocode/kilo/auto`.
    - Confirm your API key is valid and that your Kilo account has the desired models enabled.
    - When the Gateway runs as a daemon, ensure `KILOCODE_API_KEY` is available to that process (for example in `~/.openclaw/.env` or via `env.shellEnv`).

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="Kilo Gateway" href="https://app.kilo.ai" icon="arrow-up-right-from-square">
    Kilo Gateway dashboard, API keys, and account management.
  </Card>
</CardGroup>
