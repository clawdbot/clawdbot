---
summary: "Use OVHcloud AI Endpoints in Clawdbot"
read_when:
  - You want OVHcloud AI Endpoints models in Clawdbot
  - You need OVHcloud setup guidance
---
# OVHcloud AI Endpoints

OVHcloud is the leading cloud provider in Europe and provides AI Endpoints: inference APIs for a selection of open-source models, such as Llama, Qwen, GPT OSS, and more. All inferences run in Europe, offering GDPR compliance, sovereignty, and data privacy. Your prompt and the LLM response are neither used nor saved.

Source: [OVHcloud AI Endpoints](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/)

## Model overview

OVHcloud AI Endpoints offers access to multiple open-weight models through a
serverless inference API. The recommended model is **gpt-oss-120b**, a powerful 120 billion parameter model made by OpenAI.

You can also explore our [catalog](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog) to browse all our available models.

## Setup

### Quick start

Configure via CLI:

```bash
clawdbot onboard --auth-choice ovhcloud-api-key
```

Or set the API key manually:

```bash
export OVHCLOUD_API_KEY="your-api-key-here"
```

### Config snippet

```json5
{
  agents: {
    defaults: {
      model: { primary: "ovhcloud/gpt-oss-120b" }
    }
  }
}
```

## Notes

- Model refs use `ovhcloud/<model>` format.
- Your data is not reused or kept by OVHcloud; data privacy is guaranteed.
- Update pricing values in `models.json` if you need exact cost tracking.
- See [Model providers](/concepts/model-providers) for provider rules.
- Use `clawdbot models list` and `clawdbot models set ovhcloud/gpt-oss-120b` to switch models.

## Troubleshooting

### "Unknown model: ovhcloud/model-name"

This usually means the **OVHcloud provider isn't configured** (no provider entry and no OVHcloud auth profile/env key found). Fix by:

- Running `clawdbot configure` and selecting **OVHcloud**, or
- Adding the `models.providers.ovhcloud` block manually, or
- Setting `OVHCLOUD_API_KEY` (or an OVHcloud auth profile) so the provider can be injected.

Make sure the model id is **case-sensitive**: `ovhcloud/gpt-oss-120b`.

Then recheck with:
```bash
clawdbot models list
```