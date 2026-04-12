---
summary: "Run OpenClaw with SGLang (OpenAI-compatible self-hosted server)"
read_when:
  - You want to run OpenClaw against a local SGLang server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "SGLang"
---

# SGLang

SGLang can serve open-source models via an **OpenAI-compatible** HTTP API.
OpenClaw can connect to SGLang using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from SGLang when you opt
in with `SGLANG_API_KEY` (any value works if your server does not enforce auth)
and you do not define an explicit `models.providers.sglang` entry.

## Getting started

<Steps>
  <Step title="Start SGLang">
    Launch SGLang with an OpenAI-compatible server. Your base URL should expose
    `/v1` endpoints (for example `/v1/models`, `/v1/chat/completions`). SGLang
    commonly runs on:

    - `http://127.0.0.1:30000/v1`

  </Step>
  <Step title="Set an API key">
    Any value works if no auth is configured on your server:

    ```bash
    export SGLANG_API_KEY="sglang-local"
    ```

  </Step>
  <Step title="Run onboarding or set a model directly">
    ```bash
    openclaw onboard
    ```

    Or configure the model manually:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "sglang/your-model-id" },
        },
      },
    }
    ```

  </Step>
</Steps>

## Model discovery (implicit provider)

When `SGLANG_API_KEY` is set (or an auth profile exists) and you **do not**
define `models.providers.sglang`, OpenClaw will query:

- `GET http://127.0.0.1:30000/v1/models`

and convert the returned IDs into model entries.

<Note>
If you set `models.providers.sglang` explicitly, auto-discovery is skipped and
you must define models manually.
</Note>

## Explicit configuration (manual models)

Use explicit config when:

- SGLang runs on a different host/port.
- You want to pin `contextWindow`/`maxTokens` values.
- Your server requires a real API key (or you want to control headers).

```json5
{
  models: {
    providers: {
      sglang: {
        baseUrl: "http://127.0.0.1:30000/v1",
        apiKey: "${SGLANG_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local SGLang Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Proxy-style behavior">
    SGLang is treated as a proxy-style OpenAI-compatible `/v1` backend, not a
    native OpenAI endpoint.

    | Behavior | SGLang |
    |----------|--------|
    | OpenAI-only request shaping | Not applied |
    | `service_tier`, Responses `store`, prompt-cache hints | Not sent |
    | Reasoning-compat payload shaping | Not applied |
    | Hidden attribution headers (`originator`, `version`, `User-Agent`) | Not injected on custom SGLang base URLs |

  </Accordion>

  <Accordion title="Troubleshooting">
    **Server not reachable**

    Verify the server is running and responding:

    ```bash
    curl http://127.0.0.1:30000/v1/models
    ```

    **Auth errors**

    If requests fail with auth errors, set a real `SGLANG_API_KEY` that matches
    your server configuration, or configure the provider explicitly under
    `models.providers.sglang`.

    <Tip>
    If you run SGLang without authentication, any non-empty value for
    `SGLANG_API_KEY` is sufficient to opt in to model discovery.
    </Tip>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider entries.
  </Card>
</CardGroup>
