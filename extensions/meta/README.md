# Meta provider

Bundled OpenClaw provider plugin for the **Meta API** — an OpenAI-compatible
**Responses API** endpoint (`POST /v1/responses`).

- **Base URL:** `https://api.meta.ai/v1`
- **Auth:** `Authorization: Bearer $MODEL_API_KEY`
- **Model:** `muse-spark-1.1` (reasoning model)
  - Context window: 1,048,576 tokens (input + output share the budget)
  - Maximum output: 131,072 tokens
  - Reasoning effort: `minimal | low | medium | high | xhigh` (default: `high`)
  - Vision: image input in `user` messages
  - Tool calling + streaming
  - Stateless encrypted reasoning replay (`store: false`)

## Usage

Set the API key and select the model:

```bash
export MODEL_API_KEY=<key>
```

```json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      model: { primary: "meta/muse-spark-1.1" },
    },
  },
}
```

Or run onboarding and choose **Meta**.

## Thinking / reasoning

`--thinking <level>` and `/think <level>` map to Responses API `reasoning.effort`.
Default thinking level is `high`. `off` maps to `minimal` because Muse Spark does
not accept `none`.

## Docs

See `docs/providers/meta.md` for setup, onboarding, and smoke tests.

## Live test

```bash
export MODEL_API_KEY=<key>
pnpm test:live -- extensions/meta/meta.live.test.ts
```

Live tests call `muse-spark-1.1` on `/v1/responses`.
