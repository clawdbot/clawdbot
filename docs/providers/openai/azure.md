---
summary: "Point the bundled openai provider at an Azure OpenAI resource"
read_when:
  - You are routing image generation through Azure OpenAI
  - You need the Azure API version, deployment naming, or region rules
title: "Azure OpenAI endpoints"
sidebarTitle: "Azure endpoints"
---

## Azure OpenAI endpoints

The bundled `openai` provider can target an Azure OpenAI resource for image
generation by overriding the base URL. On the image-generation path, OpenClaw
detects Azure hostnames on `models.providers.openai.baseUrl` and switches to
Azure's request shape automatically.

<Note>
Realtime voice uses a separate configuration path
(`plugins.entries.voice-call.config.realtime.providers.openai.azureEndpoint`)
and is not affected by `models.providers.openai.baseUrl`. See the **Realtime
voice** accordion under [Voice and speech](/providers/openai/voice-and-speech) for its Azure
settings.
</Note>

Use Azure OpenAI when:

- You already have an Azure OpenAI subscription, quota, or enterprise
  agreement
- You need regional data residency or compliance controls Azure provides
- You want to keep traffic inside an existing Azure tenancy

### Configuration

For Azure image generation through the bundled `openai` provider, point
`models.providers.openai.baseUrl` at your Azure resource and set `apiKey` to
the Azure OpenAI key (not an OpenAI Platform key):

```json5
{
  models: {
    providers: {
      openai: {
        baseUrl: "https://<your-resource>.openai.azure.com",
        apiKey: "<azure-openai-api-key>",
      },
    },
  },
}
```

OpenClaw recognizes these Azure host suffixes for the Azure image-generation
route:

- `*.openai.azure.com`
- `*.services.ai.azure.com`
- `*.cognitiveservices.azure.com`

For image-generation requests on a recognized Azure host, OpenClaw:

- Sends the `api-key` header instead of `Authorization: Bearer`
- Uses deployment-scoped paths (`/openai/deployments/{deployment}/...`)
- Appends `?api-version=...` to each request
- Uses a 600s default request timeout for Azure image-generation calls.
  Per-call `timeoutMs` values still override this default.

Other base URLs (public OpenAI, OpenAI-compatible proxies) keep the standard
OpenAI image request shape.

<Note>
Azure routing for the `openai` provider's image-generation path requires
OpenClaw 2026.4.22 or later. Earlier versions treat any custom
`openai.baseUrl` like the public OpenAI endpoint and fail against Azure image
deployments.
</Note>

### API version

Set `AZURE_OPENAI_API_VERSION` to pin a specific Azure preview or GA version
for the Azure image-generation path:

```bash
export AZURE_OPENAI_API_VERSION="2024-12-01-preview"
```

The default is `2024-12-01-preview` when the variable is unset.

### Model names are deployment names

Azure OpenAI binds models to deployments. For Azure image-generation requests
routed through the bundled `openai` provider, the `model` field in OpenClaw
must be the **Azure deployment name** you configured in the Azure portal, not
the public OpenAI model id.

If you create a deployment called `gpt-image-2-prod` that serves `gpt-image-2`:

```
/tool image_generate model=openai/gpt-image-2-prod prompt="A clean poster" size=1024x1024 count=1
```

The same deployment-name rule applies to any image-generation call routed
through the bundled `openai` provider.

### Regional availability

Azure image generation is currently available only in a subset of regions
(for example `eastus2`, `swedencentral`, `polandcentral`, `westus3`,
`uaenorth`). Check Microsoft's current region list before creating a
deployment, and confirm the specific model is offered in your region.

### Parameter differences

Azure OpenAI and public OpenAI do not always accept the same image parameters.
Azure may reject options public OpenAI allows (for example certain
`background` values on `gpt-image-2`) or expose them only on specific model
versions. These differences come from Azure and the underlying model, not
OpenClaw. If an Azure request fails with a validation error, check the
parameter set supported by your specific deployment and API version in the
Azure portal.

<Note>
Azure OpenAI uses native transport and compat behavior but does not receive
OpenClaw's hidden attribution headers - see the **Native vs OpenAI-compatible
routes** accordion under [Advanced configuration](/providers/openai/advanced#advanced-configuration).

For chat or Responses traffic on Azure (beyond image generation), use the
onboarding flow or a dedicated Azure provider config; `openai.baseUrl` alone
does not pick up the Azure API/auth shape. A separate
`azure-openai-responses/*` provider exists; see the [Server-side compaction
accordion](/providers/openai/advanced#server-side-compaction-responses-api).
</Note>
