---
summary: "Route OpenClaw through Neon AI Gateway with one branch-scoped Neon credential"
title: "Neon AI Gateway"
read_when:
  - You already use Neon and want one credential for LLM access
  - You want per-branch isolation for model requests
  - You want to reach OpenAI, Google, Meta, Databricks, and Alibaba models without separate provider accounts
---

[Neon AI Gateway](https://neon.com/docs/ai-gateway/overview) is an OpenAI-compatible inference
gateway provided by Neon. One Neon credential reaches models from OpenAI, Google, Meta, Databricks,
and Alibaba, so OpenClaw talks to it over the same `openai-completions` transport used for other
proxy providers.

Each Neon branch has its own gateway host, so requests are scoped to the branch you point at, the
same isolation your Neon database already has.

| Property     | Value                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| Provider id  | `neon` (custom; configure under `models.providers.neon`)                              |
| Plugin       | none; not a bundled OpenClaw provider plugin                                          |
| Auth         | Neon credential with the `ai_gateway:invoke` scope, sent as a bearer token            |
| API          | `openai-completions`, plus `openai-responses` for the Codex models                    |
| Base URL     | `$NEON_AI_GATEWAY_BASE_URL/v1`, or `/openai/v1` for the Responses API                 |

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
    starts with `nt_live_` and is shown only once.

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

    `openclaw models set` writes the reference into your config without checking that the provider
    exists, so a typo or a missing provider entry surfaces later as an unresolved model rather than
    as an error here. `openclaw models list --provider neon` confirms the entry loaded.

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
at the longer `/ai-gateway/mlflow/v1` path, and both forms behave identically.

Because a Neon branch host is a public HTTPS endpoint, no private-network override is needed.

### Cost and output limits

The zero `cost` values are the real rate during the beta: Neon does not bill inference yet, and an
omitted `cost` would resolve to the same zeros anyway. Neon says it will charge the model provider's
published per-token rate with no markup once billing begins, so replace the zeros then. The catalog
rates for the three models above are $0.25 and $2.00 per million tokens for `gpt-5-mini`, $0.50 and
$3.00 for `gemini-3-flash`, and $0.15 and $1.20 for `qwen3-next-80b-a3b-instruct`. OpenClaw reads
`cost` in USD per million tokens, so those numbers drop in as written.

None of the model entries set `maxTokens`, which means OpenClaw applies its own default of 8192
output tokens, capped at the model's `contextWindow`. Neon's catalog publishes context windows but
no per-model output ceiling, so there is no upstream number to copy here. Set `maxTokens` yourself if
you want longer completions. The 20,000 output tokens per minute that Neon documents is a rate limit,
not a per-request cap.

The `input` array accepts `text`, `image`, `video`, and `audio`. Neon's catalog lists more input
types than that for some models, including PDF for the Codex models and video and audio for Gemini,
but only the four values above are valid in an OpenClaw model entry.

## Models

Neon uses short model IDs with no vendor prefix, such as `gpt-5-mini`, `gemini-3-flash`,
`llama-4-maverick`, `gpt-oss-120b`, and `qwen3-next-80b-a3b-instruct`. The `databricks-` prefixed
form is accepted too. To list what a branch can actually reach:

```bash
curl "$NEON_AI_GATEWAY_BASE_URL/v1/models" \
  -H "Authorization: Bearer $NEON_AI_GATEWAY_TOKEN"
```

Neon returns that list in an OpenRouter-shaped response, but `pricing`, `context_length`, and
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

  <Accordion title="Codex models and the Responses API">
    `gpt-5-3-codex`, `gpt-5-2-codex`, `gpt-5-1-codex-max`, and `gpt-5-1-codex-mini` are served only
    through the OpenAI Responses API, which Neon exposes under `/openai/v1` rather than `/v1`. Reach
    them with a second provider entry using the `openai-responses` API and that base URL, which is the
    same branch host you substituted above with `/openai/v1` on the end:

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
                id: "gpt-5-2-codex",
                name: "GPT-5.2 Codex",
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

    Keep the two entries separate. The chat-completions models do not answer on `/openai/v1`, and the
    Codex models do not answer on `/v1`.

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
</AccordionGroup>

<Note>
For general provider configuration and failover behavior, see [Model Providers](/concepts/model-providers).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Neon AI Gateway docs" href="https://neon.com/docs/ai-gateway/overview" icon="book">
    Official Neon documentation for the gateway, authentication, and models.
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
