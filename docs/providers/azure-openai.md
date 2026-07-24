---
summary: "Use an Azure OpenAI resource with OpenClaw for chat, Responses, and images"
read_when:
  - You have an Azure OpenAI resource and want to use it in OpenClaw
  - You searched for "Azure OpenAI" and could not find setup steps
title: "Azure OpenAI"
---

OpenClaw can run agents on your own Azure OpenAI resource. This page is the
starting point if you have an Azure OpenAI deployment and want to use it for
chat and Responses traffic.

<Note>
This is not [Azure Speech](/providers/azure-speech), which uses a separate
Speech resource key for text-to-speech. If you have an Azure OpenAI key and
want chat, Responses, or image models, you are in the right place.
</Note>

## Which route to use

Azure OpenAI reaches OpenClaw through three routes depending on what you need:

| Goal | Route | Auth |
| --- | --- | --- |
| Chat / Responses on a direct Azure OpenAI resource | `azure-openai-responses` custom provider (this page) | Azure OpenAI API key |
| Chat / images through Microsoft or Azure AI Foundry | [Microsoft Foundry plugin](/plugins/reference/microsoft-foundry) | API key or Entra ID (`az login`) |
| Image generation on the bundled `openai` provider | [OpenAI provider, Azure endpoints](/providers/openai#azure-openai-endpoints) | Azure OpenAI API key |

If you want Entra ID (`az login`) auth or Foundry deployment discovery, use the
Microsoft Foundry plugin instead. The rest of this page covers the direct
API-key path.

## Requirements

- An Azure OpenAI resource with at least one model deployment.
- An Azure OpenAI API key (not an OpenAI Platform key).
- A deployment in a region that supports the Responses API. Older regions or
  clients can return 404 for Responses.

## Endpoint styles

Azure exposes two endpoint shapes and OpenClaw handles both:

- **v1 (recommended).** Point `baseUrl` at `.../openai/v1/`. OpenClaw talks to
  it directly and no `api-version` is required.
- **Classic.** Point `baseUrl` at the bare resource
  (`https://<resource>.openai.azure.com`). OpenClaw adds the Azure
  `api-version` automatically. The default is `preview`; override it with the
  `AZURE_OPENAI_API_VERSION` environment variable.

## Setup with onboarding

`openclaw onboard` can configure this for you. Choose the custom-provider path
and paste your Azure OpenAI endpoint. Onboarding recognizes
`*.openai.azure.com` and `*.services.ai.azure.com` hosts, applies the Azure
deployment path, and sets Azure-appropriate context and token defaults.

## Setup with manual config

Define a custom provider under `models.providers` with the
`azure-openai-responses` adapter, then set it as your default model. The
provider id you choose (here, `azure`) becomes the model ref prefix.

```json5
{
  models: {
    providers: {
      azure: {
        api: "azure-openai-responses",
        baseUrl: "https://<your-resource>.openai.azure.com/openai/v1/",
        apiKey: "<azure-openai-api-key>",
        models: [{ id: "<your-deployment-name>" }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "azure/<your-deployment-name>" },
    },
  },
}
```

Prefer environment substitution for the key rather than inlining it.

### Model names are deployment names

Azure binds models to deployments, so the model `id` in OpenClaw must be your
**Azure deployment name**, not the public OpenAI model id. If your deployment
name differs from the model id you want to reference, remap it with the
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` environment variable.

### API version

The classic endpoint uses `AZURE_OPENAI_API_VERSION`, which defaults to
`preview`. The v1 endpoint does not require it. Pin a specific dated version
when you need a particular GA or preview feature set:

```bash
export AZURE_OPENAI_API_VERSION="preview"
```

## Verify

```bash
openclaw models list --provider azure
openclaw models status --probe --probe-provider azure
```

## Reported issues

These are open, user-reported issues on the Azure Responses path that
maintainers have not yet reproduced or confirmed. Treat them as things to watch
for rather than confirmed platform behavior, and check the linked threads for
current status before you rely on Responses in production:

- Some resources are reported to return a synthetic zero-token refusal on every
  Responses turn; the `openai-completions` adapter is the suggested workaround
  ([#79570](https://github.com/openclaw/openclaw/issues/79570)).
- Responses are reported to stall before the first event when memory tools are
  exposed ([#80926](https://github.com/openclaw/openclaw/issues/80926)).
- Some endpoints are reported to reject `prompt_cache_key` with a 400
  ([#102907](https://github.com/openclaw/openclaw/issues/102907)).

If chat fails on the Responses adapter, try the same deployment with an
`openai-completions` custom provider as a fallback.

## Related

- [OpenAI provider](/providers/openai) — Azure image endpoints and shared config
- [Microsoft Foundry plugin](/plugins/reference/microsoft-foundry) — Entra ID and Foundry deployments
- [Model providers](/concepts/model-providers) — provider config reference
