---
summary: "Route OpenClaw through Neon AI Gateway with one branch-scoped Neon credential"
title: "Neon AI Gateway"
read_when:
  - You already use Neon and want one credential for LLM access
  - You want per-branch isolation for model requests
  - You want to reach OpenAI, Anthropic, Google, Meta, Databricks and Alibaba models without separate provider accounts
---

[Neon AI Gateway](https://neon.com/docs/ai-gateway/overview) is an OpenAI-compatible inference
gateway provided by Neon. One Neon credential reaches models from OpenAI, Anthropic, Google, Meta,
Databricks and Alibaba, so OpenClaw talks to it over the same `openai-completions` transport used
for other proxy providers.

Each Neon branch has its own gateway host, so requests are scoped to the branch you point at, the
same isolation your Neon database already has.

| Property    | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Provider id | `neon` (custom; configure under `models.providers.neon`)                                          |
| Plugin      | none; not a bundled OpenClaw provider plugin                                                      |
| Auth        | Neon credential with the `ai_gateway:invoke` scope, sent as a bearer token                        |
| API         | `openai-completions`, plus `openai-responses` and `anthropic-messages` for specific models        |
| Base URL    | `$NEON_AI_GATEWAY_BASE_URL/v1`, `/openai/v1` for Responses or `/anthropic` for Anthropic Messages |

<Note>
  Neon AI Gateway is a custom OpenAI-compatible provider, not a bundled OpenClaw provider plugin.
  `openclaw onboard` offers no Neon auth choice, so you write the `models.providers.neon` entry
  yourself.
</Note>

<Note>
  Neon AI Gateway is in beta. It requires a paid Neon plan and is only available in the AWS US East
  (Ohio) region (`aws-us-east-2`), so the Neon project has to be created there.
</Note>

## Quick start

<Steps>
  <Step title="Create a credential">
    In the [Neon Console](https://console.neon.tech/), select your branch and click **Credentials**
    under **APP BACKEND**. Click **Create credential** and check `ai_gateway:invoke`. The token
    starts with `nt_live_`, and Neon shows it only once.

    With the `neon` CLI, `neon env pull --file .env` writes the credential and the branch host for
    the current branch instead.

  </Step>
  <Step title="Find the branch host">
    The Neon Console shows it on the AI Gateway page as `NEON_AI_GATEWAY_BASE_URL`:

    ```bash
    export NEON_AI_GATEWAY_BASE_URL="https://<your-neon-branch-host>"
    export NEON_AI_GATEWAY_TOKEN=nt_live_...
    ```

    This is not the database connection string. `<your-neon-branch-host>` is a placeholder: paste the
    bare host from the Console in its place, with no path after it.

  </Step>
  <Step title="Add the provider to your config">
    Copy the [Configuration](#configuration) block below and swap `<your-neon-branch-host>` for the
    bare host from `NEON_AI_GATEWAY_BASE_URL`, keeping the `/v1` suffix. The placeholder is not a real
    endpoint, so the config fails until you replace it. Do this before selecting a model.
  </Step>
  <Step title="Select a model">
    ```bash
    openclaw models set neon/gpt-5-mini
    openclaw models list --provider neon
    ```

    Because you added the `models.providers.neon` entry in the previous step, `openclaw models set`
    recognizes the provider and saves the selection. If you run it before adding that entry or you
    misspell the provider, it fails with `Unknown model provider "neon"` and leaves your config
    unchanged. A model ID the local catalog does not know still saves under a configured provider,
    with a warning to check the ID, so confirm the result with `openclaw models list --provider neon`.

  </Step>
</Steps>

## Configuration

```json5
{
  models: {
    providers: {
      neon: {
        baseUrl: "https://<your-neon-branch-host>/v1",
        apiKey: "${NEON_AI_GATEWAY_TOKEN}",
        api: "openai-completions",
        models: [
          {
            id: "gpt-5-mini",
            name: "GPT-5 Mini",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400000,
          },
          {
            id: "gemini-3-flash",
            name: "Gemini 3 Flash",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000000,
          },
          {
            id: "qwen3-next-80b-a3b-instruct",
            name: "Qwen3-Next 80B Instruct",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131000,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "neon/gpt-5-mini" },
    },
  },
}
```

`baseUrl` is the bare host from `NEON_AI_GATEWAY_BASE_URL` with `/v1` on the end, so replace
`<your-neon-branch-host>` before loading the config. The `/v1` suffix is required because OpenClaw
hands the URL to the OpenAI client, which appends `chat/completions`. Neon serves the same endpoint
at the longer `/ai-gateway/mlflow/v1` path, and Neon documents that both forms behave identically and
neither is deprecated, with the longer `/ai-gateway/...` paths guaranteed to keep working
indefinitely (see [Shorter paths](https://neon.com/docs/ai-gateway/models#shorter-paths)).

Because a Neon branch host is a public HTTPS endpoint, you do not need a private-network override.

### Cost and output limits

The zero `cost` values are the real rate during the beta: Neon does not bill inference yet, and an
omitted `cost` would resolve to the same zeros anyway. Neon says it will charge the model provider's
published per-token rate with no markup once billing begins, so replace the zeros then. The catalog
rates for the three models above are $0.25 and $2.00 per million tokens for `gpt-5-mini`, $0.50 and
$3.00 for `gemini-3-flash` and $0.15 and $1.20 for `qwen3-next-80b-a3b-instruct`. OpenClaw reads
`cost` in USD per million tokens, so those numbers drop in as written.

None of the model entries set `maxTokens`, which means OpenClaw applies its own default of 8192
output tokens, capped at the model's `contextWindow`. Neon's catalog publishes context windows but
no per-model output ceiling, so there is no upstream number to copy here. Set `maxTokens` yourself if
you want longer completions. The 20,000 output tokens per minute that Neon documents is a rate limit,
not a per-request cap.

The `input` array accepts `text`, `image`, `video` and `audio`. Neon's catalog lists more input
types than that for some models, including PDF for `gpt-5-3-codex` and video and audio for Gemini,
but only the four values above are valid in an OpenClaw model entry.

### OpenClaw does not ask Neon for streamed token usage

OpenClaw resolves `supportsUsageInStreaming` to `false` for this Neon route, so it does not send
`stream_options` to Neon. A Neon branch host is a custom `baseUrl` that OpenClaw does not recognize
as one of its built-in endpoints, and for an unregistered endpoint like that the derived default is
`false`. That applies to every model above, and no `compat` block is needed to get it.

This is the default for the Neon route specifically, not a rule about every provider that sets a
`baseUrl`: endpoints OpenClaw does classify can derive the opposite value, and an explicit
`compat.supportsUsageInStreaming` on a model always overrides the derived default.

This is a statement about the outgoing request, not about what you will see. OpenClaw still records
a `usage` object on any chunk that carries one, so a provider that reports usage without being asked
is accounted for normally. In practice, not asking usually means no final usage arrives, and a
streamed turn is then reported at zero tokens.

If you set `compat: { supportsUsageInStreaming: true }` to recover token counts, be aware that the
`gemini-` models may reject the field. Neon serves that family by translating the request into a
Gemini `generation_config`, which has no `stream_options`, and an unknown field there is rejected
rather than ignored. Sending it against a `gemini-` model on a Neon branch returned:

```text
Invalid JSON payload received. Unknown name "stream_options" at 'generation_config'
```

That is an observation from one branch rather than a documented Neon contract, and the same request
succeeded against the non-Gemini chat models on that branch. Treat it as a reason to enable the flag
per model rather than across the whole provider.

## Models

Neon uses short model IDs with no vendor prefix, such as `gpt-5-mini`, `gemini-3-flash`,
`llama-4-maverick`, `gpt-oss-120b` and `qwen3-next-80b-a3b-instruct`. The `databricks-` prefixed
form is accepted too. To list what a branch can actually reach:

```bash
curl "$NEON_AI_GATEWAY_BASE_URL/v1/models" \
  -H "Authorization: Bearer $NEON_AI_GATEWAY_TOKEN"
```

Neon returns that list in an OpenRouter-shaped response, but `pricing`, `context_length` and
`per_request_limits` are currently always `null`, so take `contextWindow` values from the
[Neon model catalog](https://neon.com/docs/ai-gateway/models). The same catalog is browsable on
[models.dev](https://models.dev/providers/neon/).

Open-weight models are available to every project immediately. Frontier models from OpenAI and
Google roll out gradually, so a catalog model may not be enabled for your project yet.

## Advanced

<AccordionGroup>
  <Accordion title="Branch-scoped credentials">
    A credential is valid on the branch it was created on and on every branch descended from it, so
    one credential created on `main` covers preview and feature branches forked from `main`. It is
    not valid on a branch outside that lineage, where the gateway returns
    `credential not authorized for this branch` with a `403`.

    To rotate, create the new credential first, update the environment, then revoke the old one.

  </Accordion>

  <Accordion title="Models that require the Responses API">
    Neon exposes the [OpenAI Responses API](https://neon.com/docs/ai-gateway/openai-responses) under
    `/openai/v1` rather than `/v1`. Most OpenAI models answer on both endpoints, but a few are served
    only through Responses and are rejected by chat completions. The Endpoints column in Neon's
    [model catalog](https://neon.com/docs/ai-gateway/models) is what marks them: a model listed only
    as `openai/responses` needs the configuration below. That set changes as Neon adds and retires
    models, so read the column rather than trusting a list copied into a page; at the time of writing
    it is `gpt-5-3-codex` and `gpt-5-5-pro`.

    Reach them with a second provider entry using the `openai-responses` API and that base URL, which
    is the same branch host you substituted above with `/openai/v1` on the end:

    ```json5
    {
      models: {
        providers: {
          "neon-responses": {
            baseUrl: "https://<your-neon-branch-host>/openai/v1",
            apiKey: "${NEON_AI_GATEWAY_TOKEN}",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5-3-codex",
                name: "GPT-5.3 Codex",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 400000,
              },
            ],
          },
        },
      },
    }
    ```

    This endpoint takes OpenAI model IDs only. Sending a Gemini, Llama or Qwen ID returns
    `400 model "<model-id>" is not available on the openai_responses endpoint`.

  </Accordion>

  <Accordion title="Claude models through the Anthropic Messages endpoint">
    Neon also exposes the [Anthropic Messages API](https://neon.com/docs/ai-gateway/anthropic-messages)
    under `/anthropic`, where the Anthropic SDK appends `/v1/messages`. This dialect is Claude only, and
    it supports native Anthropic features such as prompt caching and extended thinking that the
    OpenAI-compatible `/v1` path cannot express. Reach it with a second provider entry using the
    `anthropic-messages` API and the `/anthropic` base URL, the same shape as the bundled
    Anthropic-compatible provider examples:

    ```json5
    {
      models: {
        providers: {
          "neon-anthropic": {
            baseUrl: "https://<your-neon-branch-host>/anthropic",
            apiKey: "${NEON_AI_GATEWAY_TOKEN}",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "neon-anthropic/claude-sonnet-4-6" },
          models: {
            "neon-anthropic/claude-sonnet-4-6": {
              params: { cacheRetention: "short" },
            },
          },
        },
      },
    }
    ```

    The same `cost`, `maxTokens` and `contextWindow` caveats from the OpenAI entry apply here: the
    zeros are the beta rate, and you take `contextWindow` from the
    [Neon model catalog](https://neon.com/docs/ai-gateway/models).

    Prompt caching stays off until you ask for it. OpenClaw seeds a default `cacheRetention` only for
    direct Anthropic routes, so on a custom `anthropic-messages` endpoint like Neon you set
    `params.cacheRetention` yourself under `agents.defaults.models`, as the example above does. Use
    `"short"` for the 5-minute cache or `"long"` for the 1-hour TTL; `"none"` disables it. See
    [Prompt caching](/reference/prompt-caching).

    Two behaviors matter here:

    - This endpoint takes Claude model IDs only. Sending a non-Anthropic ID returns
      `400 model "<model-id>" is not available on the anthropic_messages endpoint`, so keep this entry
      separate from the `/v1` entry, which reaches every model.
    - On a non-`api.anthropic.com` host, OpenClaw suppresses implicit `anthropic-beta` headers, such as
      interleaved thinking, so a proxy does not reject them. Set `headers` with an `anthropic-beta` value
      on the provider if you need a specific beta.

  </Accordion>

  <Accordion title="Rate limits and quota">
    During the beta Neon allows 200,000 tokens per minute per account, counting input and output
    together. Going over returns `429 Too Many Requests` with a message naming the model. Upstream
    output-token limits apply independently at 20,000 per minute for most models, so a `429` can
    happen on output tokens alone.

    Neon also enforces an account-level daily spend cap that returns `429` with error code
    `REQUEST_LIMIT_EXCEEDED`, even though inference is free during the beta. Neon has not published a
    fixed value for that cap.

  </Accordion>

  <Accordion title="Response shape">
    For most models `message.content` is a plain string. Neon documents Gemini 3.x, `gpt-oss-120b`,
    and `qwen35-122b-a10b` as returning an array of typed content blocks instead. OpenClaw's
    `openai-completions` transport flattens those blocks on the way in, treating `text` blocks as
    assistant output and `reasoning` blocks as thinking, so nothing in your config has to handle the
    array form.

    A low output-token limit can still cut a response off before the text block appears. The turn
    then carries only a reasoning block, which reads as an empty reply unless reasoning output is
    turned on. Raising `maxTokens` is the fix.

  </Accordion>

  <Accordion title="Proxy behavior notes">
    - Native-OpenAI-only request shaping does not apply through a Neon base URL: no `service_tier`,
      no Responses `store`, no prompt-cache hints, no OpenAI reasoning-effort payload shaping.
    - Hidden OpenClaw attribution headers (`originator`, `version`, `User-Agent`) are only sent to
      verified native OpenAI endpoints, so they are not injected on a Neon base URL.
    - Inference is free during the beta. Neon states it will pass through provider per-token rates
      with no markup once billing begins.
  </Accordion>

  <Accordion title="Common errors and troubleshooting">
    Neon's [troubleshooting guide](https://neon.com/docs/ai-gateway/troubleshooting) covers the errors
    you are most likely to hit:

    - `403 model requires a verified account` is a per-model gate. It mirrors `enabled: false` for that
      model in `GET /v1/models`, so a model your project cannot use yet fails here rather than in your
      OpenClaw config.
    - `400 model "<model-id>" is not available on the <endpoint> endpoint` means the model ID does not
      belong to the dialect you called, such as an OpenAI ID sent to `/anthropic` or a Claude ID sent to
      `/openai/v1`. Use the provider entry that matches the model.
    - AI Gateway is in beta, paid-plan only and currently limited to AWS US East (Ohio)
      (`aws-us-east-2`), so a project created elsewhere or on a free plan cannot reach it.

  </Accordion>
</AccordionGroup>

<Note>
For general provider configuration and failover behavior, see [Model Providers](/concepts/model-providers).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Neon AI Gateway docs" href="https://neon.com/docs/ai-gateway/overview" icon="book">
    Official Neon documentation for the gateway, authentication and models.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
  <Card title="Models" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="Anthropic Messages API" href="https://neon.com/docs/ai-gateway/anthropic-messages" icon="robot">
    Native Claude dialect with prompt caching and extended thinking.
  </Card>
  <Card title="Troubleshooting" href="https://neon.com/docs/ai-gateway/troubleshooting" icon="wrench">
    Common Neon AI Gateway errors and how to resolve them.
  </Card>
</CardGroup>
