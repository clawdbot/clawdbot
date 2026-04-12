---
summary: "Use Amazon Bedrock Mantle (OpenAI-compatible) models with OpenClaw"
read_when:
  - You want to use Bedrock Mantle hosted OSS models with OpenClaw
  - You need the Mantle OpenAI-compatible endpoint for GPT-OSS, Qwen, Kimi, or GLM
title: "Amazon Bedrock Mantle"
---

# Amazon Bedrock Mantle

OpenClaw includes a bundled **Amazon Bedrock Mantle** provider that connects to
the Mantle OpenAI-compatible endpoint. Mantle hosts open-source and
third-party models (GPT-OSS, Qwen, Kimi, GLM, and similar) through a standard
`/v1/chat/completions` surface backed by Bedrock infrastructure.

| Property       | Value                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| Provider ID    | `amazon-bedrock-mantle`                                                             |
| API            | `openai-completions` (OpenAI-compatible)                                            |
| Auth           | Explicit `AWS_BEARER_TOKEN_BEDROCK` or IAM credential-chain bearer-token generation |
| Default region | `us-east-1` (override with `AWS_REGION` or `AWS_DEFAULT_REGION`)                    |

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

| Behavior          | Detail                    |
| ----------------- | ------------------------- |
| Discovery cache   | Results cached for 1 hour |
| IAM token refresh | Hourly                    |

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

## Advanced notes

<AccordionGroup>
  <Accordion title="Reasoning support">
    Reasoning support is inferred from model IDs containing patterns like
    `thinking`, `reasoner`, or `gpt-oss-120b`. OpenClaw sets `reasoning: true`
    automatically for matching models during discovery.
  </Accordion>

  <Accordion title="Endpoint unavailability">
    If the Mantle endpoint is unavailable or returns no models, the provider is
    silently skipped. OpenClaw does not error; other configured providers
    continue to work normally.
  </Accordion>

  <Accordion title="Relationship to Amazon Bedrock provider">
    Bedrock Mantle is a separate provider from the standard
    [Amazon Bedrock](/providers/bedrock) provider. Mantle uses an
    OpenAI-compatible `/v1` surface, while the standard Bedrock provider uses
    the native Bedrock API.

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
