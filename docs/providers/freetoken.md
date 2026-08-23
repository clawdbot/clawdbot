---
summary: "Run OpenClaw with FreeToken (OpenAI-compatible local MoE server)"
read_when:
  - You want to run OpenClaw against a local FreeToken server
  - You want an OpenAI-compatible edge-native MoE runtime
title: "FreeToken"
---

FreeToken serves open-weight MoE models through an OpenAI-compatible HTTP API.
OpenClaw connects through the bundled `freetoken` provider and discovers models
from the server's `/v1/models` endpoint.

| Property                  | Value                                                           |
| ------------------------- | --------------------------------------------------------------- |
| Provider id               | `freetoken`                                                     |
| Plugin                    | bundled, `enabledByDefault: true`                               |
| Auth env var              | `FREETOKEN_API_KEY` (any non-empty value if no auth is enabled) |
| Onboarding flag           | `--auth-choice freetoken`                                       |
| API                       | OpenAI-compatible (`openai-completions`)                        |
| Default base URL          | `http://127.0.0.1:1919/v1`                                      |
| Default model placeholder | `freetoken/Qwen/Qwen3.6-35B-A3B`                                |
| Pricing                   | Marked external-free (`modelPricing.external: false`)           |

## Getting started

1. Start FreeToken with a supported model:

   ```bash
   ft serve --model Qwen/Qwen3.6-35B-A3B
   ```

2. Opt in to provider discovery. Any non-empty value works when the local server
   is not configured with authentication:

   ```bash
   export FREETOKEN_API_KEY="freetoken-local"
   ```

3. Run onboarding or configure a model directly:

   ```bash
   openclaw onboard --auth-choice freetoken
   ```

   ```json5
   {
     agents: {
       defaults: {
         model: { primary: "freetoken/Qwen/Qwen3.6-35B-A3B" },
       },
     },
   }
   ```

## Model discovery

When `FREETOKEN_API_KEY` is set (or an auth profile exists) and
`models.providers.freetoken` is not defined, OpenClaw queries
`http://127.0.0.1:1919/v1/models` and converts the returned ids into model
entries.

Define `models.providers.freetoken` explicitly when the server uses a different
host or port, requires a real API key, or needs fixed context/output limits:

```json5
{
  models: {
    providers: {
      freetoken: {
        baseUrl: "http://127.0.0.1:1919/v1",
        apiKey: "${FREETOKEN_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "Qwen/Qwen3.6-35B-A3B",
            name: "Local FreeToken Qwen3.6",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Operational notes

- Keep an unauthenticated server bound to loopback. Add authentication and
  network controls before exposing it beyond the host.
- OpenAI API compatibility proves request compatibility, not that a model fits
  the machine. Host RAM, memory bandwidth, PCIe bandwidth, VRAM, context length,
  and concurrency all affect local MoE performance.
- Validate a local model in a shadow route before making it the primary model,
  and keep a known-good fallback provider configured.

See the [FreeToken repository](https://github.com/FlashML-org/FreeToken) for
runtime installation, supported models, and hardware requirements.
