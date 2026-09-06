---
summary: "Use Poolside Laguna models with OpenClaw"
read_when:
  - You want to use Poolside Laguna models with OpenClaw
  - You need to install or configure the Poolside provider plugin
  - You are troubleshooting hosted or self-managed Poolside endpoints
title: "Poolside (Laguna)"
---

[Poolside](https://poolside.ai) provides the Laguna family of coding models.
OpenClaw connects through the official `@poolside/openclaw-provider` plugin and
the OpenAI-compatible chat-completions API.

| Property        | Value                              |
| --------------- | ---------------------------------- |
| Provider id     | `poolside`                         |
| Package         | `@poolside/openclaw-provider`      |
| Auth env var    | `POOLSIDE_API_KEY`                 |
| Onboarding flag | `--poolside-api-key <key>`         |
| API             | `openai-completions`               |
| Hosted base URL | `https://inference.poolside.ai/v1` |
| Default model   | `poolside/laguna-s-2.1`            |

## Hosted Poolside

Install the provider plugin and restart the Gateway:

```bash
openclaw plugins install clawhub:@poolside/openclaw-provider
openclaw gateway restart
```

Give the Gateway a Poolside API key, then verify the provider:

```bash
export POOLSIDE_API_KEY="<your-poolside-api-key>" # pragma: allowlist secret
openclaw models list --provider poolside
```

You can also configure the key during onboarding:

```bash
openclaw onboard --poolside-api-key "<your-poolside-api-key>"
```

Set a Laguna model as the default:

```json5
{
  agents: {
    defaults: {
      model: { primary: "poolside/laguna-s-2.1" },
    },
  },
}
```

The plugin currently advertises these models. Availability and limits can
change as Poolside updates its catalog:

| Model                | Context window | Max output |
| -------------------- | -------------- | ---------- |
| `laguna-s-2.1`       | 262,144        | 32,768     |
| `laguna-s-2.1:fast`  | 1,048,576      | 32,768     |
| `laguna-xs-2.1`      | 262,144        | 32,768     |
| `laguna-xs-2.1:fast` | 262,144        | 32,768     |
| `laguna-m.1`         | 262,144        | 32,768     |
| `laguna-m.1:fast`    | 262,144        | 32,768     |

Use the exact model id after the `poolside/` prefix. For example,
`poolside/laguna-s-2.1:fast` selects the fast variant.

## Self-managed Laguna

Poolside's self-managed deployments can expose an OpenAI-compatible endpoint.
Declare that endpoint explicitly when it is not the hosted URL. Keep the `/v1`
path and use the model id advertised by your deployment:

```json5
{
  models: {
    mode: "merge",
    providers: {
      poolside: {
        baseUrl: "http://127.0.0.1:8000/v1",
        api: "openai-completions",
        // Omit apiKey when the local server does not require authentication.
        apiKey: "${POOLSIDE_API_KEY}",
        models: [
          {
            id: "laguna-s-2.1",
            name: "Laguna S 2.1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32768,
          },
        ],
      },
    },
  },
}
```

Then check that the endpoint advertises the same id:

```bash
curl http://127.0.0.1:8000/v1/models
openclaw models list --provider poolside
```

For a remote self-managed server, replace the loopback URL with the reachable
HTTPS URL and keep authentication in the Gateway environment rather than in
source-controlled config.

## Request compatibility

Poolside's endpoint accepts text input, tool calls, and reasoning. The provider
plugin uses a default temperature of `0.7` and removes sampling fields that
Poolside does not support (`top_p`, `top_k`, `min_p`, frequency/presence
penalties, and `n`). If a request fails with an unsupported-parameter error,
check the provider's compatibility behavior before adding custom overrides.

## Troubleshooting

<AccordionGroup>
  <Accordion title="401 or 403 responses">
    Confirm that `POOLSIDE_API_KEY` is set for the Gateway process (not only for
    an interactive shell), then restart the Gateway. Re-run onboarding if the
    key was rotated.
  </Accordion>
  <Accordion title="Model not found">
    Run `openclaw models list --provider poolside` and use the exact
    case-sensitive model id after `poolside/`. Self-managed servers must expose
    the same id from `GET /v1/models`.
  </Accordion>
  <Accordion title="Connection or 404 errors">
    Verify that the configured base URL includes `/v1`, is reachable from the
    Gateway host, and serves both `/v1/models` and `/v1/chat/completions`.
  </Accordion>
</AccordionGroup>

## Related

- [Poolside API overview](https://docs.poolside.ai/api/overview)
- [Poolside model catalog](https://poolside.ai/models)
- [Poolside OpenClaw plugin](https://hub.openclaw.ai/poolside/plugins/openclaw-provider)
- [Model providers](/concepts/model-providers)
- [ACP agents](/tools/acp-agents) (including the `pool` ACPX alias)
