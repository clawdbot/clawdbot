---
summary: "Adds Microsoft Foundry model provider support to OpenClaw."
read_when:
  - You are installing, configuring, or auditing the microsoft-foundry plugin
title: "Microsoft Foundry plugin"
---

# Microsoft Foundry plugin

Adds Microsoft Foundry model provider support to OpenClaw.

## Distribution

- Package: `@openclaw/microsoft-foundry`
- Install route: included in OpenClaw

## Surface

providers: `microsoft-foundry`; contracts: `imageGenerationProviders`

<!-- openclaw-plugin-reference:manual-start -->

- Image-generation provider: `microsoft-foundry`

## Requirements

- A Microsoft Foundry or Azure AI Foundry resource with deployments.
- API-key auth through `AZURE_OPENAI_API_KEY` or a configured provider API key.
- For Entra ID auth, install the Azure CLI and run `az login` before
  onboarding. OpenClaw refreshes Microsoft Foundry runtime tokens through
  `az account get-access-token`.

## Chat models

Microsoft Foundry chat deployments use the provider model ref
`microsoft-foundry/<deployment-name>`. Onboarding discovers Foundry resources
and deployments with the Azure CLI, then writes the selected deployment name to
the model config.

OpenClaw uses the Foundry `/openai/v1` endpoint for supported OpenAI-compatible
chat APIs:

- GPT, `o*`, `computer-use-preview`, and DeepSeek-V4 model families default to
  `openai-responses`.
- MAI-DS-R1 and other chat-completion deployments use `openai-completions`
  unless an explicit supported API is configured.
- MAI-DS-R1 is recorded as reasoning-capable through reasoning content, not
  through `reasoning_effort`. Its context and output token metadata are
  163,840 tokens.

Anthropic Claude deployments in Microsoft Foundry use the Anthropic Messages
API shape, not the OpenAI-compatible `/openai/v1` shape. Configure those as a
custom `anthropic-messages` provider until the Microsoft Foundry plugin grows a
native Anthropic runtime. When the Foundry deployment name differs from the
Claude model ID, set `params.canonicalModelId` on the model entry so OpenClaw
can apply model-specific wire contracts, map `/think off` correctly, and
preserve signed thinking safely.

## MAI image generation

The plugin registers `microsoft-foundry` for `image_generate` with the current
Microsoft AI image models:

- `MAI-Image-2.5-Flash`
- `MAI-Image-2.5`
- `MAI-Image-2e`
- `MAI-Image-2`

Use a deployed MAI image deployment name as the model ref. The provider does
not declare a default image model because the MAI API requires your deployment
name in the request `model` field:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "microsoft-foundry/<deployment-name>",
        timeoutMs: 600000,
      },
    },
  },
}
```

Prompt-only generation calls Microsoft Foundry's MAI generations endpoint:
`/mai/v1/images/generations`. Reference-image edits call
`/mai/v1/images/edits` and are limited to `MAI-Image-2.5-Flash` and
`MAI-Image-2.5` deployments.

Prompt-only generation can use a custom deployment name with just the Foundry
endpoint configured. For image edits with a custom deployment name, select the
deployment through onboarding or include model metadata so OpenClaw can verify
that the deployment is backed by `MAI-Image-2.5-Flash` or `MAI-Image-2.5`.

MAI image constraints:

- Output: one PNG image per request.
- Size: default `1024x1024`; both width and height must be at least 768 px.
- Total pixels: width × height must be at most 1,048,576.
- Edits: one PNG or JPEG input image.
- Unsupported shared hints such as `aspectRatio`, `resolution`, `quality`,
  `background`, and non-PNG `outputFormat` are not sent to Microsoft Foundry.

## Troubleshooting

- `az: command not found`: install the Azure CLI or use API-key auth.
- `Microsoft Foundry endpoint missing for MAI image generation`: select a
  Foundry deployment through onboarding or add `models.providers.microsoft-foundry.baseUrl`.
- `supports MAI image deployments only`: the selected image model points at a
  non-MAI deployment. Use a deployed MAI image model for `image_generate`.

<!-- openclaw-plugin-reference:manual-end -->
