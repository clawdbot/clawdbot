---
summary: "Run OpenClaw through LiteLLM Proxy for unified model access and cost tracking"
title: "LiteLLM"
read_when:
  - You want to route OpenClaw through a LiteLLM proxy
  - You need cost tracking, logging, or model routing through LiteLLM
---

[LiteLLM](https://litellm.ai) is an open-source LLM gateway with a unified API to 100+ model
providers. Route OpenClaw through LiteLLM for centralized cost tracking, logging, virtual keys with
spend limits, and backend failover without changing OpenClaw config.

## Quick start

<Tabs>
  <Tab title="Onboarding (recommended)">
    ```bash
    openclaw onboard --auth-choice litellm-api-key
    ```

    For non-interactive setup against a remote proxy, pass the proxy URL explicitly:

    ```bash
    openclaw onboard --non-interactive --accept-risk --auth-choice litellm-api-key \
      --litellm-api-key "$LITELLM_API_KEY" --custom-base-url "https://litellm.example/v1"
    ```

  </Tab>

  <Tab title="Manual setup">
    <Steps>
      <Step title="Start LiteLLM Proxy">
        ```bash
        pip install 'litellm[proxy]'
        litellm --model claude-opus-4-6
        ```
      </Step>
      <Step title="Point OpenClaw to LiteLLM">
        ```bash
        export LITELLM_API_KEY="your-litellm-key"
        openclaw
        ```
      </Step>
    </Steps>
  </Tab>
</Tabs>

## Configuration

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "gpt-4o",
            name: "GPT-4o",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "litellm/claude-opus-4-6" },
    },
  },
}
```

The default model onboarding writes is `litellm/claude-opus-4-6`.

## Image generation

LiteLLM can back the `image_generate` tool through OpenAI-compatible `/images/generations` and
`/images/edits` routes. Default image model is `gpt-image-2`; configure a different one under
`agents.defaults.mediaModels.image`:

```json5
{
  models: {
    providers: {
      litellm: {
        baseUrl: "http://localhost:4000",
        apiKey: "${LITELLM_API_KEY}",
      },
    },
  },
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "litellm/gpt-image-2",
        timeoutMs: 180_000,
      },
    },
  },
}
```

Loopback LiteLLM URLs (`http://localhost:4000`, `127.0.0.1`, `::1`, `host.docker.internal`) work
without a global private-network override. For a LAN-hosted proxy, set
`models.providers.litellm.request.allowPrivateNetwork: true` because the API key is sent to that host.

## Advanced

<AccordionGroup>
  <Accordion title="Virtual keys">
    Create a dedicated key for OpenClaw with spend limits:

    ```bash
    curl -X POST "http://localhost:4000/key/generate" \
      -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "key_alias": "openclaw",
        "max_budget": 50.00,
        "budget_duration": "monthly"
      }'
    ```

    Use the generated key as `LITELLM_API_KEY`.

  </Accordion>

  <Accordion title="Model routing">
    LiteLLM can route model requests to different backends. Configure in your LiteLLM `config.yaml`:

    ```yaml
    model_list:
      - model_name: claude-opus-4-6
        litellm_params:
          model: claude-opus-4-6
          api_key: os.environ/ANTHROPIC_API_KEY

      - model_name: gpt-4o
        litellm_params:
          model: gpt-4o
          api_key: os.environ/OPENAI_API_KEY
    ```

    OpenClaw keeps requesting `claude-opus-4-6`; LiteLLM handles the routing.

  </Accordion>

  <Accordion title="Viewing usage">
    ```bash
    # Key info
    curl "http://localhost:4000/key/info" \
      -H "Authorization: Bearer sk-litellm-key"

    # Spend logs
    curl "http://localhost:4000/spend/logs" \
      -H "Authorization: Bearer $LITELLM_MASTER_KEY"
    ```

  </Accordion>

  <Accordion title="Proxy behavior notes">
    - LiteLLM runs on `http://localhost:4000` by default.
    - OpenClaw connects through LiteLLM's proxy-style OpenAI-compatible `/v1` endpoint.
    - Native-OpenAI-only request shaping does not apply through a configured LiteLLM base URL:
      no `service_tier`, no Responses `store`, no prompt-cache hints, no OpenAI reasoning-effort
      payload shaping.
    - Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) are only sent to
      verified native OpenAI endpoints, so they are not injected on a custom LiteLLM base URL.
  </Accordion>
</AccordionGroup>

<Note>
For general provider configuration and failover behavior, see [Model Providers](/concepts/model-providers).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="LiteLLM Docs" href="https://docs.litellm.ai" icon="book">
    Official LiteLLM documentation and API reference.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
  <Card title="Models" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
</CardGroup>
