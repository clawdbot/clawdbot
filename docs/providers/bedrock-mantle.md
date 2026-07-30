---
summary: "Use Amazon Bedrock Mantle OpenAI-compatible and Claude Messages models with OpenClaw"
read_when:
  - You want to use Bedrock Mantle hosted OSS models with OpenClaw
  - You need the Mantle OpenAI-compatible endpoint for GPT-OSS, Qwen, Kimi, or GLM
  - You want to use Claude Opus 5, Sonnet 5, or Mythos 5 through Amazon Bedrock Mantle
title: "Amazon Bedrock Mantle"
---

OpenClaw includes a bundled **Amazon Bedrock Mantle** provider that connects to
the Mantle OpenAI-compatible endpoint. Mantle hosts open-source and
third-party models (GPT-OSS, Qwen, Kimi, GLM, and similar) through a standard
`/v1/chat/completions` surface backed by Bedrock infrastructure. Mantle also
exposes Anthropic Claude models through an Anthropic Messages route.

| Property       | Value                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| Provider ID    | `amazon-bedrock-mantle`                                                                |
| API            | `openai-completions` for discovered OSS models, `anthropic-messages` for Claude models |
| Auth           | Explicit `AWS_BEARER_TOKEN_BEDROCK` or IAM credential-chain bearer-token generation    |
| Default region | `us-east-1` (override with `AWS_REGION` or `AWS_DEFAULT_REGION`)                       |

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="Explicit bearer token">
    **Best for:** environments where you already have a Mantle bearer token.

    <Steps>
      <Step title="Set the bearer token on the gateway host">
        ```bash
        export AWS_BEARER_TOKEN_BEDROCK="..."
        ```

        Optionally set a region (defaults to `us-east-1`):

        ```bash
        export AWS_REGION="us-west-2"
        ```
      </Step>
      <Step title="Verify models are discovered">
        ```bash
        openclaw models list
        ```

        Discovered models appear under the `amazon-bedrock-mantle` provider. No
        additional config is required unless you want to override defaults.
      </Step>
    </Steps>

  </Tab>

  <Tab title="IAM credentials">
    **Best for:** using AWS SDK-compatible credentials (shared config, SSO, web identity, instance or task roles).

    <Steps>
      <Step title="Configure AWS credentials on the gateway host">
        Any AWS SDK-compatible auth source works:

        ```bash
        export AWS_PROFILE="default"
        export AWS_REGION="us-west-2"
        ```
      </Step>
      <Step title="Verify models are discovered">
        ```bash
        openclaw models list
        ```

        OpenClaw generates a Mantle bearer token from the credential chain automatically.
      </Step>
    </Steps>

    <Tip>
    When `AWS_BEARER_TOKEN_BEDROCK` is not set, OpenClaw mints the bearer token for you from the AWS default credential chain, including shared credentials/config profiles, SSO, web identity, and instance or task roles.
    </Tip>

  </Tab>
</Tabs>

## Automatic model discovery

When `AWS_BEARER_TOKEN_BEDROCK` is set, OpenClaw uses it directly. Otherwise,
OpenClaw attempts to generate a Mantle bearer token from the AWS default
credential chain. It then discovers available Mantle models by querying the
region's `/v1/models` endpoint.

| Behavior          | Detail                                                                               |
| ----------------- | ------------------------------------------------------------------------------------ |
| Discovery cache   | Results cached for 1 hour per region; a fetch failure returns the last cached result |
| IAM token refresh | Every 2 hours, cached per region                                                     |

To keep the Mantle plugin enabled but suppress automatic discovery and IAM
bearer-token generation, disable the plugin-owned discovery toggle:

```bash
openclaw config set plugins.entries.amazon-bedrock-mantle.config.discovery.enabled false
```

<Note>
The bearer token is the same `AWS_BEARER_TOKEN_BEDROCK` used by the standard [Amazon Bedrock](/providers/bedrock) provider.
</Note>

### Supported regions

`us-east-1`, `us-east-2`, `us-west-2`, `ap-northeast-1`,
`ap-south-1`, `ap-southeast-3`, `eu-central-1`, `eu-west-1`, `eu-west-2`,
`eu-south-1`, `eu-north-1`, `sa-east-1`.

## Manual configuration

If you prefer explicit config instead of auto-discovery:

```json5
{
  models: {
    providers: {
      "amazon-bedrock-mantle": {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
        models: [
          {
            id: "gpt-oss-120b",
            name: "GPT-OSS 120B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

An explicit non-empty `models` list is authoritative and replaces every
discovered row, including the Claude rows below. Omit `models` to retain the
automatic Mantle catalog, or include the complete Claude model entries you
want to use.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Reasoning support">
    Reasoning support is inferred from model IDs containing patterns like
    `thinking`, `reasoner`, `reasoning`, `deepseek.r`, `gpt-oss-120b`, or
    `gpt-oss-safeguard-120b`. OpenClaw sets `reasoning: true` automatically for
    matching models during discovery.
  </Accordion>

  <Accordion title="Endpoint unavailability">
    If the Mantle endpoint is unavailable, returns no models, or bearer-token
    resolution fails, discovery returns an empty result and the implicit
    provider is skipped. OpenClaw does not error; other configured providers
    continue to work normally.
  </Accordion>

  <Accordion title="Claude via the Anthropic Messages route">
    When automatic discovery owns the model list, OpenClaw appends five Claude
    models after a successful lookup, regardless of what `/v1/models` returns:
    `amazon-bedrock-mantle/anthropic.claude-opus-5` (Claude Opus 5),
    `amazon-bedrock-mantle/anthropic.claude-sonnet-5` (Claude Sonnet 5),
    `amazon-bedrock-mantle/anthropic.claude-opus-4-7` (Claude Opus 4.7), and
    `amazon-bedrock-mantle/anthropic.claude-mythos-5` (Claude Mythos 5), plus
    `amazon-bedrock-mantle/anthropic.claude-mythos-preview` (Claude Mythos
    Preview). They use the `anthropic-messages` API surface and stream through
    the same bearer-authenticated Anthropic-compatible endpoint
    (`<mantle-base>/anthropic`), so the AWS bearer token is not treated like an
    Anthropic API key.

    Claude Opus 5 publishes a 1,000,000-token context window, 128,000-token
    output limit, image input, and `$5/$25` input/output pricing. Adaptive
    thinking defaults to `high`; `/think off` disables thinking, and
    `/think xhigh|max` uses the model's native effort levels. OpenClaw omits
    caller-selected sampling parameters.

    Claude Sonnet 5 always uses adaptive thinking and defaults to `high`
    effort. `/think off` and `/think minimal` map to `low` because the Mantle
    route cannot disable thinking. OpenClaw also omits custom temperature for
    Sonnet 5 requests.

    Claude Mythos 5 is limited access. It publishes a 1,000,000-token context
    window and 128,000-token output limit, always uses adaptive thinking, maps
    `/think off` and `/think minimal` to `low`, and omits caller-selected
    sampling parameters.

    Claude Mythos Preview always requests reasoning, defaulting to `high`
    effort when no `/think` level is set (mapped from `xhigh`/`max` down to
    `high`, and `minimal` up to `low`). Opus 4.7 on Mantle streams without
    model-provided reasoning, and OpenClaw omits its `temperature` parameter
    since Opus 4.7 does not accept sampling overrides on this route; Mythos
    Preview accepts a `temperature` override normally.

    A non-empty explicit `models.providers["amazon-bedrock-mantle"].models`
    list replaces the complete discovered catalog. Omit that list when you
    want these built-in Claude rows.

  </Accordion>

  <Accordion title="Relationship to Amazon Bedrock provider">
    Bedrock Mantle is a separate provider from the standard
    [Amazon Bedrock](/providers/bedrock) provider. Mantle uses an
    OpenAI-compatible `/v1` surface for its OSS catalog, while the standard
    Bedrock provider uses the native Bedrock Converse API.

    Both providers share the same `AWS_BEARER_TOKEN_BEDROCK` credential when
    present.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Amazon Bedrock" href="/providers/bedrock" icon="cloud">
    Native Bedrock provider for Anthropic Claude, Titan, and other models.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and how to resolve them.
  </Card>
</CardGroup>
