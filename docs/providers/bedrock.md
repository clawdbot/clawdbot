---
summary: "Use Amazon Bedrock (Converse API) models with OpenClaw"
read_when:
  - You want to use Amazon Bedrock models with OpenClaw
  - You need AWS credential/region setup for model calls
title: "Amazon Bedrock"
---

OpenClaw can use **Amazon Bedrock** models via pi-ai's **Bedrock Converse**
streaming provider. Bedrock auth uses the **AWS SDK default credential chain**,
not an API key.

| Property | Value                                                       |
| -------- | ----------------------------------------------------------- |
| Provider | `amazon-bedrock`                                            |
| API      | `bedrock-converse-stream`                                   |
| Auth     | AWS credentials (env vars, shared config, or instance role) |
| Region   | `AWS_REGION` or `AWS_DEFAULT_REGION` (default: `us-east-1`) |

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="Access keys / env vars">
    **Best for:** developer machines, CI, or hosts where you manage AWS credentials directly.

    <Steps>
      <Step title="Set AWS credentials on the gateway host">
        ```bash
        export AWS_ACCESS_KEY_ID="AKIA..."
        export AWS_SECRET_ACCESS_KEY="..."
        export AWS_REGION="us-east-1"
        # Optional:
        export AWS_SESSION_TOKEN="..."
        export AWS_PROFILE="your-profile"
        # Optional (Bedrock API key/bearer token):
        export AWS_BEARER_TOKEN_BEDROCK="..."
        ```
      </Step>
      <Step title="Add a Bedrock provider and model to your config">
        No `apiKey` is required. Configure the provider with `auth: "aws-sdk"`:

        ```json5
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                api: "bedrock-converse-stream",
                auth: "aws-sdk",
                models: [
                  {
                    id: "us.anthropic.claude-opus-4-6-v1:0",
                    name: "Claude Opus 4.6 (Bedrock)",
                    reasoning: true,
                    input: ["text", "image"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list
        ```
      </Step>
    </Steps>

    <Tip>
    With env-marker auth (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, or `AWS_BEARER_TOKEN_BEDROCK`), OpenClaw auto-enables the implicit Bedrock provider for model discovery without extra config.
    </Tip>

  </Tab>

  <Tab title="EC2 instance roles (IMDS)">
    **Best for:** EC2 instances with an IAM role attached, using the instance metadata service for authentication.

    <Steps>
      <Step title="Enable discovery explicitly">
        When using IMDS, OpenClaw cannot detect AWS auth from env markers alone, so you must opt in:

        ```bash
        openclaw config set plugins.entries.amazon-bedrock.config.discovery.enabled true
        openclaw config set plugins.entries.amazon-bedrock.config.discovery.region us-east-1
        ```
      </Step>
      <Step title="Optionally add an env marker for auto mode">
        If you also want the env-marker auto-detection path to work (for example, for `openclaw status` surfaces):

        ```bash
        export AWS_PROFILE=default
        export AWS_REGION=us-east-1
        ```

        You do **not** need a fake API key.
      </Step>
      <Step title="Verify models are discovered">
        ```bash
        openclaw models list
        ```
      </Step>
    </Steps>

    <Warning>
    The IAM role attached to your EC2 instance must have the following permissions:

    - `bedrock:InvokeModel`
    - `bedrock:InvokeModelWithResponseStream`
    - `bedrock:ListFoundationModels` (for automatic discovery)
    - `bedrock:ListInferenceProfiles` (for inference profile discovery)

    Or attach the managed policy `AmazonBedrockFullAccess`.
    </Warning>

    <Note>
    You only need `AWS_PROFILE=default` if you specifically want an env marker for auto mode or status surfaces. The actual Bedrock runtime auth path uses the AWS SDK default chain, so IMDS instance-role auth works even without env markers.
    </Note>

  </Tab>
</Tabs>

## Automatic model discovery

OpenClaw can automatically discover Bedrock models that support **streaming**
and **text output**. Discovery uses `bedrock:ListFoundationModels` and
`bedrock:ListInferenceProfiles`, and results are cached (default: 1 hour).

How the implicit provider is enabled:

- If `plugins.entries.amazon-bedrock.config.discovery.enabled` is `true`,
  OpenClaw will try discovery even when no AWS env marker is present.
- If `plugins.entries.amazon-bedrock.config.discovery.enabled` is unset,
  OpenClaw only auto-adds the
  implicit Bedrock provider when it sees one of these AWS auth markers:
  `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID` +
  `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`.
- The actual Bedrock runtime auth path still uses the AWS SDK default chain, so
  shared config, SSO, and IMDS instance-role auth can work even when discovery
  needed `enabled: true` to opt in.

<Note>
For explicit `models.providers["amazon-bedrock"]` entries, OpenClaw can still resolve Bedrock env-marker auth early from AWS env markers such as `AWS_BEARER_TOKEN_BEDROCK` without forcing full runtime auth loading. The actual model-call auth path still uses the AWS SDK default chain.
</Note>

<AccordionGroup>
  <Accordion title="Discovery config options">
    Config options live under `plugins.entries.amazon-bedrock.config.discovery`:

    ```json5
    {
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                region: "us-east-1",
                providerFilter: ["anthropic", "amazon"],
                refreshInterval: 3600,
                defaultContextWindow: 32000,
                defaultMaxTokens: 4096,
              },
            },
          },
        },
      },
    }
    ```

    | Option | Default | Description |
    | ------ | ------- | ----------- |
    | `enabled` | auto | In auto mode, OpenClaw only enables the implicit Bedrock provider when it sees a supported AWS env marker. Set `true` to force discovery. |
    | `region` | `AWS_REGION` / `AWS_DEFAULT_REGION` / `us-east-1` | AWS region used for discovery API calls. |
    | `providerFilter` | (all) | Matches Bedrock provider names (for example `anthropic`, `amazon`). |
    | `refreshInterval` | `3600` | Cache duration in seconds. Set to `0` to disable caching. |
    | `defaultContextWindow` | `32000` | Context window used for discovered models (override if you know your model limits). |
    | `defaultMaxTokens` | `4096` | Max output tokens used for discovered models (override if you know your model limits). |

  </Accordion>
</AccordionGroup>

## Quick setup (AWS path)

This walkthrough creates an IAM role, attaches Bedrock permissions, associates
the instance profile, and enables OpenClaw discovery on the EC2 host.

```bash
# 1. Create IAM role and instance profile
aws iam create-role --role-name EC2-Bedrock-Access \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name EC2-Bedrock-Access \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws iam create-instance-profile --instance-profile-name EC2-Bedrock-Access
aws iam add-role-to-instance-profile \
  --instance-profile-name EC2-Bedrock-Access \
  --role-name EC2-Bedrock-Access

# 2. Attach to your EC2 instance
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. On the EC2 instance, enable discovery explicitly
openclaw config set plugins.entries.amazon-bedrock.config.discovery.enabled true
openclaw config set plugins.entries.amazon-bedrock.config.discovery.region us-east-1

# 4. Optional: add an env marker if you want auto mode without explicit enable
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. Verify models are discovered
openclaw models list
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Inference profiles">
    OpenClaw discovers **regional and global inference profiles** alongside
    foundation models. When a profile maps to a known foundation model, the
    profile inherits that model's capabilities (context window, max tokens,
    reasoning, vision) and the correct Bedrock request region is injected
    automatically. This means cross-region Claude profiles work without manual
    provider overrides.

    Inference profile IDs look like `us.anthropic.claude-opus-4-6-v1:0` (regional)
    or `anthropic.claude-opus-4-6-v1:0` (global). If the backing model is already
    in the discovery results, the profile inherits its full capability set;
    otherwise safe defaults apply.

    No extra configuration is needed. As long as discovery is enabled and the IAM
    principal has `bedrock:ListInferenceProfiles`, profiles appear alongside
    foundation models in `openclaw models list`.

  </Accordion>

  <Accordion title="Guardrails">
    You can apply [Amazon Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
    to all Bedrock model invocations by adding a `guardrail` object to the
    `amazon-bedrock` plugin config. Guardrails let you enforce content filtering,
    topic denial, word filters, sensitive information filters, and contextual
    grounding checks.

    ```json5
    {
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              guardrail: {
                guardrailIdentifier: "abc123", // guardrail ID or full ARN
                guardrailVersion: "1", // version number or "DRAFT"
                streamProcessingMode: "sync", // optional: "sync" or "async"
                trace: "enabled", // optional: "enabled", "disabled", or "enabled_full"
              },
            },
          },
        },
      },
    }
    ```

    | Option | Required | Description |
    | ------ | -------- | ----------- |
    | `guardrailIdentifier` | Yes | Guardrail ID (e.g. `abc123`) or full ARN (e.g. `arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123`). |
    | `guardrailVersion` | Yes | Published version number, or `"DRAFT"` for the working draft. |
    | `streamProcessingMode` | No | `"sync"` or `"async"` for guardrail evaluation during streaming. If omitted, Bedrock uses its default. |
    | `trace` | No | `"enabled"` or `"enabled_full"` for debugging; omit or set `"disabled"` for production. |

    <Warning>
    The IAM principal used by the gateway must have the `bedrock:ApplyGuardrail` permission in addition to the standard invoke permissions.
    </Warning>

  </Accordion>

  <Accordion title="Embeddings for memory search">
    Bedrock can also serve as the embedding provider for
    [memory search](/concepts/memory-search). This is configured separately from the
    inference provider -- set `agents.defaults.memorySearch.provider` to `"bedrock"`:

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            provider: "bedrock",
            model: "amazon.titan-embed-text-v2:0", // default
          },
        },
      },
    }
    ```

    Bedrock embeddings use the same AWS SDK credential chain as inference (instance
    roles, SSO, access keys, shared config, and web identity). No API key is
    needed. When `provider` is `"auto"`, Bedrock is auto-detected if that
    credential chain resolves successfully.

    Supported embedding models include Amazon Titan Embed (v1, v2), Amazon Nova
    Embed, Cohere Embed (v3, v4), and TwelveLabs Marengo. See
    [Memory configuration reference -- Bedrock](/reference/memory-config#bedrock-embedding-config)
    for the full model list and dimension options.

  </Accordion>

  <Accordion title="Notes and caveats">
    - Bedrock requires **model access** enabled in your AWS account/region.
    - Automatic discovery needs the `bedrock:ListFoundationModels` and
      `bedrock:ListInferenceProfiles` permissions.
    - If you rely on auto mode, set one of the supported AWS auth env markers on the
      gateway host. If you prefer IMDS/shared-config auth without env markers, set
      `plugins.entries.amazon-bedrock.config.discovery.enabled: true`.
    - OpenClaw surfaces the credential source in this order: `AWS_BEARER_TOKEN_BEDROCK`,
      then `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, then `AWS_PROFILE`, then the
      default AWS SDK chain.
    - Reasoning support depends on the model; check the Bedrock model card for
      current capabilities.
    - If you prefer a managed key flow, you can also place an OpenAI-compatible
      proxy in front of Bedrock and configure it as an OpenAI provider instead.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Memory search" href="/concepts/memory-search" icon="magnifying-glass">
    Bedrock embeddings for memory search configuration.
  </Card>
  <Card title="Memory config reference" href="/reference/memory-config#bedrock-embedding-config" icon="database">
    Full Bedrock embedding model list and dimension options.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
