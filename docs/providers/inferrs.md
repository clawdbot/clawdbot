---
summary: "Run OpenClaw through inferrs (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local inferrs server
  - You are serving Gemma or another model through inferrs
  - You need the exact OpenClaw compat flags for inferrs
title: "Inferrs"
---

[inferrs](https://github.com/ericcurtin/inferrs) can serve local models behind an OpenAI-compatible `/v1` API. OpenClaw works with `inferrs` through the generic `openai-completions` path.

| Property           | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Provider id        | `inferrs` (custom; configure under `models.providers.inferrs`)     |
| Plugin             | none — `inferrs` is not a bundled OpenClaw provider plugin         |
| Auth env var       | Optional. Any value works if your inferrs server has no auth       |
| API                | OpenAI-compatible (`openai-completions`)                           |
| Suggested base URL | `http://127.0.0.1:8080/v1` (or wherever your inferrs server lives) |

<Note>
  `inferrs` is currently best treated as a custom self-hosted OpenAI-compatible backend, not a dedicated OpenClaw provider plugin. You configure it through `models.providers.inferrs` rather than an onboarding choice flag. If you need a true bundled plugin with auto-discovery, see [SGLang](/providers/sglang) or [vLLM](/providers/vllm).
</Note>

## Getting started

<Steps>
  <Step title="Start inferrs with a model">
    ```bash
    inferrs serve google/gemma-4-E2B-it \
      --host 127.0.0.1 \
      --port 8080 \
      --device metal
    ```
  </Step>
  <Step title="Verify the server is reachable">
    ```bash
    curl http://127.0.0.1:8080/health
    curl http://127.0.0.1:8080/v1/models
    ```
  </Step>
  <Step title="Add an OpenClaw provider entry">
    Add an explicit provider entry and point your default model at it. See the full config example below.
  </Step>
</Steps>

## Full config example

This example uses Gemma 4 on a local `inferrs` server.

```json5
{
  agents: {
    defaults: {
      model: { primary: "inferrs/google/gemma-4-E2B-it" },
      models: {
        "inferrs/google/gemma-4-E2B-it": {
          alias: "Gemma 4 (inferrs)",
        },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      inferrs: {
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "inferrs-local",
        api: "openai-completions",
        models: [
          {
            id: "google/gemma-4-E2B-it",
            name: "Gemma 4 E2B (inferrs)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
            compat: {
              requiresStringContent: true,
            },
          },
        ],
      },
    },
  },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Why requiresStringContent matters">
    Some `inferrs` Chat Completions routes accept only string
    `messages[].content`, not structured content-part arrays.

    <Warning>
    If OpenClaw runs fail with an error like:

    ```text
    messages[1].content: invalid type: sequence, expected a string
    ```

    set `compat.requiresStringContent: true` in your model entry.
    </Warning>

    ```json5
    compat: {
      requiresStringContent: true
    }
    ```

    OpenClaw will flatten pure text content parts into plain strings before sending
    the request.

  </Accordion>

  <Accordion title="Gemma and tool-schema caveat">
    Some current `inferrs` + Gemma combinations accept small direct
    `/v1/chat/completions` requests but still fail on full OpenClaw agent-runtime
    turns.

    If that happens, try this first:

    ```json5
    compat: {
      requiresStringContent: true,
      supportsTools: false
    }
    ```

    That disables OpenClaw's tool schema surface for the model and can reduce prompt
    pressure on stricter local backends.

    If tiny direct requests still work but normal OpenClaw agent turns continue to
    crash inside `inferrs`, the remaining issue is usually upstream model/server
    behavior rather than OpenClaw's transport layer.

  </Accordion>

  <Accordion title="Manual smoke test">
    Once configured, test both layers:

    ```bash
    curl http://127.0.0.1:8080/v1/chat/completions \
      -H 'content-type: application/json' \
      -d '{"model":"google/gemma-4-E2B-it","messages":[{"role":"user","content":"What is 2 + 2?"}],"stream":false}'
    ```

    ```bash
    openclaw infer model run \
      --model inferrs/google/gemma-4-E2B-it \
      --prompt "What is 2 + 2? Reply with one short sentence." \
      --json
    ```

    If the first command works but the second fails, check the troubleshooting section below.

  </Accordion>

  <Accordion title="Proxy-style behavior">
    `inferrs` is treated as a proxy-style OpenAI-compatible `/v1` backend, not a
    native OpenAI endpoint.

    - Native OpenAI-only request shaping does not apply here
    - No `service_tier`, no Responses `store`, no prompt-cache hints, and no
      OpenAI reasoning-compat payload shaping
    - Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`)
      are not injected on custom `inferrs` base URLs

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="curl /v1/models fails">
    `inferrs` is not running, not reachable, or not bound to the expected
    host/port. Make sure the server is started and listening on the address you
    configured.
  </Accordion>

  <Accordion title="messages[].content expected a string">
    Set `compat.requiresStringContent: true` in the model entry. See the
    `requiresStringContent` section above for details.
  </Accordion>

  <Accordion title="Direct /v1/chat/completions calls pass but openclaw infer model run fails">
    Try setting `compat.supportsTools: false` to disable the tool schema surface.
    See the Gemma tool-schema caveat above.
  </Accordion>

  <Accordion title="inferrs still crashes on larger agent turns">
    If OpenClaw no longer gets schema errors but `inferrs` still crashes on larger
    agent turns, treat it as an upstream `inferrs` or model limitation. Reduce
    prompt pressure or switch to a different local backend or model.
  </Accordion>
</AccordionGroup>

<Tip>
For general help, see [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Running OpenClaw against local model servers.
  </Card>
  <Card title="Gateway troubleshooting" href="/gateway/troubleshooting#local-openai-compatible-backend-passes-direct-probes-but-agent-runs-fail" icon="wrench">
    Debugging local OpenAI-compatible backends that pass probes but fail agent runs.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
</CardGroup>
