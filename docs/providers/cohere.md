---
summary: "Cohere setup (auth + model selection)"
title: "Cohere"
read_when:
  - You want to use Cohere with OpenClaw
  - You need the Cohere API key env var or CLI auth choice
---

[Cohere](https://cohere.com) provides OpenAI-compatible inference through its Compatibility API. OpenClaw bundles the Cohere provider during its externalization transition and also publishes it as an official external plugin.

| Property        | Value                                                |
| --------------- | ---------------------------------------------------- |
| Provider id     | `cohere`                                             |
| Plugin          | bundled during transition; official external package |
| Auth env var    | `COHERE_API_KEY`                                     |
| Onboarding flag | `--auth-choice cohere-api-key`                       |
| Direct CLI flag | `--cohere-api-key <key>`                             |
| API             | OpenAI-compatible (`openai-completions`)             |
| Base URL        | `https://api.cohere.ai/compatibility/v1`             |
| Default model   | `cohere/command-a-plus-05-2026`                      |
| Context window  | 128,000 tokens                                       |

## Built-in catalog

| Model ref                            | Input       | Context | Max output | Notes                                         |
| ------------------------------------ | ----------- | ------- | ---------- | --------------------------------------------- |
| `cohere/command-a-plus-05-2026`      | text, image | 128,000 | 64,000     | Default; flagship agentic and reasoning model |
| `cohere/command-a-03-2025`           | text        | 256,000 | 8,000      | Previous Command A model                      |
| `cohere/command-a-reasoning-08-2025` | text        | 256,000 | 32,000     | Agentic reasoning and tool use                |
| `cohere/command-a-vision-07-2025`    | text, image | 128,000 | 8,000      | Vision and document analysis; no tool use     |
| `cohere/north-mini-code-1-0`         | text, image | 256,000 | 64,000     | Agentic coding; reasoning; free limits        |

Reasoning-capable Cohere models support two Compatibility API reasoning modes. OpenClaw maps **off** to `none` and every enabled thinking level to `high`. Command A Vision does not support tool use, so OpenClaw keeps agent tools disabled for that model.

## Get started

1. Cohere ships with current OpenClaw packages. If it is missing, install the external package and restart the Gateway:

```bash
openclaw plugins install @openclaw/cohere-provider
openclaw gateway restart
```

2. Create a Cohere API key.
3. Run onboarding:

```bash
openclaw onboard --non-interactive \
  --auth-choice cohere-api-key \
  --cohere-api-key "$COHERE_API_KEY"
```

4. Confirm the catalog is available:

```bash
openclaw models list --provider cohere
```

Onboarding only sets Cohere as the primary model when no primary model is already configured.

## Environment-only setup

Make `COHERE_API_KEY` available to the Gateway process, then select the Cohere model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "cohere/command-a-plus-05-2026" },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon or in Docker, set `COHERE_API_KEY` for that service. Exporting it only in an interactive shell does not make it available to an already-running Gateway.
</Note>

## Related

- [Model providers](/concepts/model-providers)
- [Models CLI](/cli/models)
- [Provider directory](/providers/index)
