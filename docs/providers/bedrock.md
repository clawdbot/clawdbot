---
summary: "Use Amazon Bedrock (Converse API) models with OpenClaw"
read_when:
  - You want to use Amazon Bedrock models with OpenClaw
  - You need AWS credential/region setup for model calls
title: "Amazon Bedrock"
---

OpenClaw can use **Amazon Bedrock** models via its **Bedrock Converse**
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
        export AWS_ACCESS_KEY_ID="EXAMPLE_AWS_ACCESS_KEY_ID"
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
                    id: "us.anthropic.claude-opus-4-6-v1",
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
              model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1" },
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
    | `defaultContextWindow` | `32000` | Context window used for discovered models with no known token limits (override if you know your model limits). |
    | `defaultMaxTokens` | `4096` | Max output tokens used for discovered models with no known token limits (override if you know your model limits). |

  </Accordion>

  <Accordion title="Context window and max-token limits">
    The Bedrock `ListFoundationModels` and `GetFoundationModel` APIs return no
    token-limit metadata, only model ID, name, modalities, and lifecycle
    status. OpenClaw ships a lookup table of known context windows and output
    limits for popular Bedrock models (Claude, Nova, Llama, Mistral, DeepSeek,
    and others) so session management, compaction thresholds, and
    context-overflow detection work correctly for those models.

    Discovered models not in the table fall back to `defaultContextWindow`
    and `defaultMaxTokens`. If a model you use is missing accurate limits,
    override it with an explicit
    `models.providers["amazon-bedrock"].models` entry.

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
    provider overrides. Global cross-region profiles (`global.*`) are listed
    first in `openclaw models list` since they generally offer better capacity
    and automatic failover.

    Inference profile IDs look like `us.anthropic.claude-opus-4-6-v1` (regional)
    or `anthropic.claude-opus-4-6-v1` (global). If the backing model is already
    in the discovery results, the profile inherits its full capability set;
    otherwise safe defaults apply.

    No extra configuration is needed. As long as discovery is enabled and the IAM
    principal has `bedrock:ListInferenceProfiles`, profiles appear alongside
    foundation models in `openclaw models list`.

  </Accordion>

  <Accordion title="Service tier">
    Some Bedrock models support a `service_tier` parameter to optimize for cost
    or latency. The following tiers are available:

    | Tier | Description |
    |------|-------------|
    | `default` | Standard Bedrock tier |
    | `flex` | Discounted processing for workloads that can tolerate longer latency |
    | `priority` | Prioritized processing for latency-sensitive workloads |
    | `reserved` | Reserved capacity for steady-state workloads |

    Set `serviceTier` (or `service_tier`) via `agents.defaults.params` for
    Bedrock model requests, or per-model in
    `agents.defaults.models["<model-key>"].params`:

    ```json5
    {
      agents: {
        defaults: {
          params: {
            serviceTier: "flex", // applies to all models
          },
          models: {
            "amazon-bedrock/mistral.mistral-large-3-675b-instruct": {
              params: {
                serviceTier: "priority", // per-model override
              },
            },
          },
        },
      },
    }
    ```

    Valid values are `default`, `flex`, `priority`, and `reserved`. Claude
    Fable 5 and Sonnet 5 only support the `default` tier; OpenClaw warns and
    ignores `flex`, `priority`, or `reserved` requested for those models. For
    other models, not every model supports every tier -- an unsupported tier
    returns a Bedrock validation error, and the error message can be
    misleading (for example "The provided model identifier is invalid"
    rather than naming the tier as the problem). If you see this error, check
    whether the model supports the requested tier.

  </Accordion>

  <Accordion title="Claude Opus 4.7 and 4.8 temperature">
    Bedrock rejects the `temperature` parameter for Claude Opus 4.7 and Opus
    4.8. OpenClaw omits `temperature` automatically for any matching Bedrock
    ref, including foundation model ids, named inference profiles, application
    inference profiles whose underlying model resolves to Opus 4.7/4.8 via
    `bedrock:GetInferenceProfile`, and dotted `opus-4.7`/`opus-4.8` variants
    with optional region prefixes (`us.`, `eu.`, `ap.`, `apac.`, `au.`, `jp.`,
    `global.`). No config knob is required, and the omission applies to both
    the request options object and the `inferenceConfig` payload field.
  </Accordion>

  <Accordion title="Claude Fable 5">
    Use `amazon-bedrock/anthropic.claude-fable-5` in `us-east-1`, or the
    regional inference ids such as `us.anthropic.claude-fable-5`.
    OpenClaw applies Fable's 1M context window, 128K output limit, always-on
    adaptive thinking, and supported effort mapping. `/think off` and
    `/think minimal` map to `low`; temperature and forced tool choice controls
    are omitted, matching the Opus 4.7/4.8 route. Streaming output is held
    until Bedrock returns a terminal status so mid-stream refusals do not
    expose partial text.

    AWS requires an explicit `provider_data_share` data-retention opt-in before
    Fable is available. Prompts and completions are shared with Anthropic and
    retained for up to 30 days for trust and safety. Review and configure
    [Bedrock data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)
    before enabling the model.

  </Accordion>

  <Accordion title="Claude Mythos 5">
    Claude Mythos 5 is available through Bedrock only for accounts with the
    required limited-access approval. OpenClaw recognizes the foundation model
    `anthropic.claude-mythos-5` and regional or global inference profiles such
    as `us.anthropic.claude-mythos-5`.

    OpenClaw applies the 1,000,000-token context window, 128,000-token output
    limit, image input, prompt caching, refusal-safe streaming, and native
    effort levels. Adaptive thinking is always enabled: `/think off` and
    `/think minimal` map to `low`, while `xhigh` and `max` remain available.
    Custom sampling and forced tool choice values are omitted.

  </Accordion>

  <Accordion title="Claude Sonnet 5">
    AWS documents Sonnet 5 for both the
    [`bedrock-runtime` and `bedrock-mantle` endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html).
    OpenClaw recognizes the Bedrock foundation model
    `anthropic.claude-sonnet-5` and regional or global inference profiles such
    as `us.anthropic.claude-sonnet-5`. It applies the 1,000,000-token context
    window, 128,000-token output limit, image input, native effort levels,
    prompt caching, and refusal-safe streaming.

    Bedrock keeps adaptive thinking enabled for Sonnet 5. OpenClaw defaults to
    `high`; `/think off` and `/think minimal` map to `low` because this route
    cannot disable thinking. Custom temperature and forced tool choice values
    are omitted while adaptive thinking is active.

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

    `guardrailIdentifier` and `guardrailVersion` are required.

    | Option | Description |
    | ------ | ----------- |
    | `guardrailIdentifier` | Guardrail ID (e.g. `abc123`) or full ARN (e.g. `arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123`). |
    | `guardrailVersion` | Published version number, or `"DRAFT"` for the working draft. |
    | `streamProcessingMode` | `"sync"` or `"async"` for guardrail evaluation during streaming. If omitted, Bedrock uses its default. |
    | `trace` | `"enabled"` or `"enabled_full"` for debugging; omit or set `"disabled"` for production. |

    <Warning>
    The IAM principal used by the gateway must have the `bedrock:ApplyGuardrail` permission in addition to the standard invoke permissions.
    </Warning>

  </Accordion>

  <Accordion title="Embeddings for memory search">
    Bedrock can also serve as the embedding provider for
    [memory search](/concepts/memory-search). This is configured separately from the
    inference provider -- set `memory.search.provider` to `"bedrock"`:

    ```json5
    {
      memory: {
        search: {
          provider: "bedrock",
          model: "amazon.titan-embed-text-v2:0", // default
        },
      },
    }
    ```

    Bedrock embeddings use the same AWS SDK credential chain as inference (instance
    roles, SSO, access keys, shared config, and web identity). No API key is
    needed.

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
