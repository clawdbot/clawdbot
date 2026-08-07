# Meta provider

Official OpenClaw provider plugin for the **Meta API** — an OpenAI-compatible
**Responses API** endpoint (`POST /v1/responses`).

- **Base URL:** `https://api.meta.ai/v1`
- **Auth:** `Authorization: Bearer $MODEL_API_KEY`
- **Models:** `muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor` (reasoning models)
  - Context window: 1M tokens (input + output share the budget)
  - Reasoning effort: `minimal | low | medium | high | xhigh` (OpenClaw default: `high`)
  - Vision: image input in `user` messages
  - Tool calling + streaming
  - Stateless encrypted reasoning replay (`store: false`)

> [!WARNING]
> Official Meta language:
>
> - Contributor tier: “Heavily discounted token pricing in exchange for permission to
>   use your prompts and completions to train future Meta models.”
> - Standard: “Not used to improve our products.”
> - Contributor: “Used to improve our products.”
> - Availability: “Available in select countries.”
>
> Sources: [pricing documentation](https://dev.meta.ai/docs/pricing-rate-limits/),
> [Muse Spark 1.2](https://developer.meta.com/ai/models/muse-spark/), and
> [Muse Code announcement](https://developer.meta.com/ai/resources/blog/build-with-muse-code/).

The plugin currently sends text and image input. Meta's public
[Muse Spark 1.2 page](https://developer.meta.com/ai/models/muse-spark/) does not
currently enumerate input modalities or a separate maximum-output value, so these are
OpenClaw transport capabilities rather than an exhaustive upstream capability list.

## Usage

Install the plugin and restart Gateway:

```bash
openclaw plugins install @openclaw/meta-provider
openclaw gateway restart
```

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
OpenClaw defaults to `high`. Meta's
[reasoning documentation](https://dev.meta.ai/docs/features/reasoning/) says that an
omitted effort uses a model-determined level, so `high` is an OpenClaw policy rather
than Meta's omitted-parameter default. `off` maps to `minimal` because Muse Spark does
not accept `none`.

## Docs

See `docs/providers/meta.md` for setup, onboarding, and smoke tests.

## Live test

```bash
export MODEL_API_KEY=<key>
pnpm test:live -- extensions/meta/meta.live.test.ts
```

Standard live tests call `muse-spark-1.1` and `muse-spark-1.2` on `/v1/responses`.
Contributor tests require an explicit data-use opt-in:

```bash
export OPENCLAW_LIVE_META_CONTRIBUTOR=1
pnpm test:live -- extensions/meta/meta.live.test.ts
```
