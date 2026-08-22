---
summary: "Configure OpenClaw against MindsHub's OpenAI- and Anthropic-compatible inference gateway"
read_when:
  - You want a single API key and bill for Claude, GPT, Kimi, DeepSeek, and other models
  - You want to configure OpenClaw against MindsHub's OpenAI-compatible or Anthropic-compatible endpoint
title: "MindsHub"
---

[MindsHub](https://mindshub.ai) is an LLM inference gateway: one API key and one bill reach
Claude, GPT, Kimi, DeepSeek, Gemini, and the rest of its
[model catalog](https://docs.mindshub.ai/inference/models) through either an OpenAI-compatible
or an Anthropic-compatible wire format. MindsHub does not ship as a bundled OpenClaw provider
plugin; configure it like any other custom OpenAI/Anthropic-compatible endpoint via
`models.providers` (see [Model providers](/concepts/model-providers)).

| Property             | Value                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Provider id          | Your choice (this page uses `mindshub`)                                                           |
| Auth                 | `MINDSHUB_API_KEY`                                                                                |
| API                  | OpenAI-compatible (`openai-completions`) or Anthropic-compatible (`anthropic-messages`)           |
| Base URL (OpenAI)    | `https://api.mindshub.ai/v1`                                                                      |
| Base URL (Anthropic) | `https://api.mindshub.ai` (host only — OpenClaw's Anthropic client appends `/v1/messages` itself) |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create a key at [console.mindshub.ai](https://console.mindshub.ai).
  </Step>
  <Step title="Onboard a single model">
    ```bash
    openclaw onboard --auth-choice custom-api-key \
      --custom-provider-id mindshub \
      --custom-base-url https://api.mindshub.ai/v1 \
      --custom-model-id sonnet \
      --custom-compatibility openai \
      --custom-api-key "$MINDSHUB_API_KEY"
    ```

    This wires up one model ref, `mindshub/sonnet`. To expose more of the
    [catalog](https://docs.mindshub.ai/inference/models) at once, use the manual config below
    instead.

  </Step>
  <Step title="Set the default model">
    ```json5
    {
      agents: { defaults: { model: { primary: "mindshub/sonnet" } } },
    }
    ```
  </Step>
</Steps>

## Config example (OpenAI-compatible)

This is the more thoroughly exercised custom-provider path in OpenClaw and the one to reach for
first:

```json5 validate=false
{
  env: { MINDSHUB_API_KEY: "mdb_..." },
  agents: {
    defaults: { model: { primary: "mindshub/sonnet" } },
  },
  models: {
    mode: "merge",
    providers: {
      mindshub: {
        baseUrl: "https://api.mindshub.ai/v1",
        apiKey: "${MINDSHUB_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "sonnet",
            name: "Claude Sonnet 5",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "opus",
            name: "Claude Opus 5",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          { id: "gpt", name: "GPT 5.6 Sol", input: ["text", "image"] },
          { id: "gpt-codex", name: "GPT 5.3 Codex", input: ["text"] },
          { id: "kimi", name: "Kimi K3", reasoning: true, input: ["text"] },
          { id: "deepseek", name: "DeepSeek V4-Pro-0813", input: ["text"] },
          { id: "gemini-flash", name: "Gemini 3.7 Flash", input: ["text", "image"] },
          { id: "mindshub_air", name: "MindsHub Air", input: ["text"] },
        ],
      },
    },
  },
}
```

Add or remove rows to match the aliases you actually use. Send the bare alias as `id`
(`sonnet`, not `claude-sonnet-5`); raw provider model IDs return `404 model_not_found` on this
endpoint. `GET /v1/models` is the authoritative live catalog; see
[Models](https://docs.mindshub.ai/inference/models).

## Config example (Anthropic-compatible)

MindsHub also speaks the Anthropic Messages API, so Claude-specific request/response shapes
(`cache_control` prompt-cache breakpoints, `tool_use`/`tool_result` blocks) round-trip natively:

```json5 validate=false
{
  env: { MINDSHUB_API_KEY: "mdb_..." },
  agents: {
    defaults: { model: { primary: "mindshub-anthropic/sonnet" } },
  },
  models: {
    mode: "merge",
    providers: {
      "mindshub-anthropic": {
        baseUrl: "https://api.mindshub.ai",
        apiKey: "${MINDSHUB_API_KEY}",
        api: "anthropic-messages",
        authHeader: true,
        models: [
          { id: "sonnet", name: "Claude Sonnet 5", reasoning: true, input: ["text", "image"] },
          { id: "opus", name: "Claude Opus 5", reasoning: true, input: ["text", "image"] },
        ],
      },
    },
  },
}
```

<Warning>
Set `authHeader: true` on the provider entry. Without it, OpenClaw's Anthropic transport
authenticates custom endpoints with an `x-api-key` header, and MindsHub's Anthropic-compatible
endpoint accepts only `Authorization: Bearer` (see
[Anthropic compatibility](https://docs.mindshub.ai/inference/anthropic-compatibility)).
`authHeader: true` makes OpenClaw add an explicit `Authorization: Bearer` header for this
provider. If you still see `401`s on this path, use the OpenAI-compatible config above instead.
</Warning>

<Warning>
The Anthropic base URL is the **host only**, no `/v1`. OpenClaw's Anthropic client appends
`/v1/messages` itself, so `https://api.mindshub.ai/v1` here would resolve to
`/v1/v1/messages`.
</Warning>

## Model catalog

MindsHub's alias catalog changes over time; the table below is a snapshot (August 2026) of
commonly used aliases. Confirm the current list with:

```bash
curl https://api.mindshub.ai/v1/models -H "Authorization: Bearer $MINDSHUB_API_KEY"
```

| Alias          | Model                  | Notes                              |
| -------------- | ---------------------- | ---------------------------------- |
| `mindshub_air` | MindsHub Air           | Covered by monthly included tokens |
| `sonnet`       | Claude Sonnet 5        |                                    |
| `opus`         | Claude Opus 5          |                                    |
| `haiku`        | Claude Haiku 4.5       |                                    |
| `gpt`          | GPT 5.6 Sol            |                                    |
| `gpt-codex`    | GPT 5.3 Codex          | Tuned for code                     |
| `kimi`         | Kimi K3                | Agentic coding at lower cost       |
| `deepseek`     | DeepSeek V4-Pro-0813   |                                    |
| `qwen`         | Qwen3.8-2.4T-A95B      |                                    |
| `glm`          | GLM 5.2                |                                    |
| `grok`         | Grok 4.6               |                                    |
| `gemini`       | Gemini 3.1 Pro Preview |                                    |

See [Models](https://docs.mindshub.ai/inference/models) for the full, current catalog and
frozen-version aliases.

<AccordionGroup>
  <Accordion title="Model refs">
    Model refs use the form `<provider-id>/<alias>` (`mindshub/sonnet` for the config above).
    The provider id is whatever you name the key under `models.providers` — it does not have to
    be `mindshub`.
  </Accordion>
  <Accordion title="Model allowlist">
    If you enable a model allowlist (`agents.defaults.models`), add every MindsHub alias you
    plan to use; anything left out is hidden from the agent.
  </Accordion>
  <Accordion title="Daemon-managed gateways">
    If the OpenClaw Gateway runs as a daemon (launchd/systemd), make sure `MINDSHUB_API_KEY` is
    visible to that process — for example via `~/.openclaw/.env` or `env.shellEnv` — not just
    your interactive shell.
  </Accordion>
  <Accordion title="Cost and usage reporting">
    OpenClaw does not know MindsHub's per-model pricing unless you set `cost` on each model
    entry, and any dollar figure OpenClaw or an underlying CLI harness displays is its own
    estimate. MindsHub's
    [usage summary endpoint](https://docs.mindshub.ai/inference/billing#checking-usage-and-balance-from-code)
    is the authoritative source for spend, grouped by model, across every key on the account.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, custom-provider config, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="MindsHub inference docs" href="https://docs.mindshub.ai/inference/" icon="arrow-up-right-from-square">
    Chat Completions, Responses, Anthropic Messages, and model catalog reference.
  </Card>
  <Card title="MindsHub console" href="https://console.mindshub.ai" icon="key">
    Create and manage API keys.
  </Card>
</CardGroup>
