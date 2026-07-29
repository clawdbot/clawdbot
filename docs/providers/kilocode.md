---
summary: "Use Kilo Gateway's unified API to access many models in OpenClaw"
title: "Kilo Gateway"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Kilo Gateway in OpenClaw
---

Kilo Gateway routes requests to many models behind a single OpenAI-compatible endpoint and API key.

| Property | Value                              |
| -------- | ---------------------------------- |
| Provider | `kilocode`                         |
| Auth     | `KILOCODE_API_KEY`                 |
| API      | OpenAI-compatible                  |
| Base URL | `https://api.kilo.ai/api/gateway/` |

## Install plugin

```bash
openclaw plugins install @openclaw/kilocode-provider
openclaw gateway restart
```

## Setup

<Steps>
  <Step title="Create an account">
    Go to [app.kilo.ai](https://app.kilo.ai), sign in or create an account, then generate an API key.
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

## Default model and catalog

The default model is `kilocode/kilo-auto/balanced`, Kilo Gateway's balanced smart-routing tier.
OpenClaw does not publish a task-to-upstream-model mapping for it; routing behind
`kilo-auto/balanced` is owned by Kilo Gateway.

At startup OpenClaw queries `GET https://api.kilo.ai/api/gateway/models` and merges discovered models
ahead of a static fallback catalog. The static fallback contains only
`kilocode/kilo-auto/balanced` (`Auto Balanced`, `input: ["text", "image"]`, `reasoning: true`,
`contextWindow: 1000000`, `maxTokens: 65536`).

Any model on the gateway is addressable as `kilocode/<upstream-id>` (for example
`kilocode/anthropic/claude-sonnet-4`, `kilocode/openai/gpt-5.5`). Run `/models kilocode` or
`openclaw models list --provider kilocode` to see the full discovered list.

## Config example

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo-auto/balanced" },
    },
  },
}
```

## Behavior notes

<AccordionGroup>
  <Accordion title="Transport and compatibility">
    Kilo Gateway is OpenRouter-compatible, so it uses the proxy-style OpenAI-compatible request
    path rather than native OpenAI request shaping (no `store`, no OpenAI reasoning-effort payload).

    - Gemini-backed Kilo refs stay on the proxy-Gemini path: OpenClaw sanitizes Gemini thought
      signatures there but does not enable native Gemini replay validation or bootstrap rewrites.
    - Requests use a Bearer token built from your API key.

  </Accordion>

  <Accordion title="Stream wrapper and reasoning">
    The Kilo stream wrapper adds an `X-KILOCODE-FEATURE` request header (default `openclaw`,
    override with the `KILOCODE_FEATURE` env var) and normalizes reasoning-effort payloads for
    models that support it.

    <Warning>
    `kilocode/kilo-auto/balanced` and `x-ai/*` refs skip reasoning-effort injection. Use a concrete
    model ref such as `kilocode/anthropic/claude-sonnet-4` if you need reasoning support.
    </Warning>

  </Accordion>

  <Accordion title="Troubleshooting">
    - If model discovery fails at startup, OpenClaw falls back to the static catalog containing `kilocode/kilo-auto/balanced`.
    - Confirm your API key is valid and that your Kilo account has the desired models enabled.
    - When Gateway runs as a daemon, ensure `KILOCODE_API_KEY` is available to that process (for example in `~/.openclaw/.env` or via `env.shellEnv`).

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
