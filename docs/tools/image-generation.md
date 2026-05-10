---
summary: "Generate and edit images via image_generate across OpenAI, Google, fal, MiniMax, ComfyUI, DeepInfra, OpenRouter, LiteLLM, xAI, Vydra"
read_when:
  - Generating or editing images via the agent
  - Configuring image-generation providers and models
  - Understanding the image_generate tool parameters
title: "Image generation"
sidebarTitle: "Image generation"
---

The `image_generate` tool lets the agent create and edit images using your
configured providers. Generated images are delivered automatically as media
attachments in the agent's reply.

<Note>
The tool only appears when at least one image-generation provider is
available. If you do not see `image_generate` in your agent's tools,
configure `agents.defaults.imageGenerationModel`, set up a provider API key,
or sign in with OpenAI Codex OAuth.
</Note>

## Quick start

<Steps>
  <Step title="Configure auth">
    Set an API key for at least one provider (for example `OPENAI_API_KEY`,
    `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) or sign in with OpenAI Codex OAuth.
  </Step>
  <Step title="Pick a default model (optional)">
    ```json5
    {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "openai/gpt-image-2",
            timeoutMs: 180_000,
          },
        },
      },
    }
    ```

    Codex OAuth uses the same `openai/gpt-image-2` model ref. When an
    `openai-codex` OAuth profile is configured, OpenClaw routes image
    requests through that OAuth profile instead of first trying
    `OPENAI_API_KEY`. Explicit `models.providers.openai` config (API key,
    custom/Azure base URL) opts back into the direct OpenAI Images API
    route.

  </Step>
  <Step title="Ask the agent">
    _"Generate an image of a friendly robot mascot."_

    The agent calls `image_generate` automatically. No tool allow-listing
    needed - it is enabled by default when a provider is available.

  </Step>
</Steps>

<Warning>
For OpenAI-compatible LAN endpoints such as LocalAI, keep the custom
`models.providers.openai.baseUrl` and explicitly opt in with
`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`. Private and
internal image endpoints remain blocked by default.
</Warning>

## Common routes

| Goal                                                 | Model ref                                          | Auth                                   |
| ---------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| OpenAI image generation with API billing             | `openai/gpt-image-2`                               | `OPENAI_API_KEY`                       |
| OpenAI image generation with Codex subscription auth | `openai/gpt-image-2`                               | OpenAI Codex OAuth                     |
| OpenAI transparent-background PNG/WebP               | `openai/gpt-image-1.5`                             | `OPENAI_API_KEY` or OpenAI Codex OAuth |
| DeepInfra image generation                           | `deepinfra/black-forest-labs/FLUX-1-schnell`       | `DEEPINFRA_API_KEY`                    |
| OpenRouter image generation                          | `openrouter/google/gemini-3.1-flash-image-preview` | `OPENROUTER_API_KEY`                   |
| LiteLLM image generation                             | `litellm/gpt-image-2`                              | `LITELLM_API_KEY`                      |
| Google Gemini image generation                       | `google/gemini-3.1-flash-image-preview`            | `GEMINI_API_KEY` or `GOOGLE_API_KEY`   |

The same `image_generate` tool handles text-to-image and reference-image
editing. Use `image` for one reference or `images` for multiple references.
Provider-supported output hints such as `quality`, `outputFormat`, and
`background` are forwarded when available and reported as ignored when a
provider does not support them. Bundled transparent-background support is
OpenAI-specific; other providers may still preserve PNG alpha if their
backend emits it.

## Supported providers

| Provider   | Default model                           | Edit support                       | Auth                                                  |
| ---------- | --------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| ComfyUI    | `workflow`                              | Yes (1 image, workflow-configured) | `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for cloud    |
| DeepInfra  | `black-forest-labs/FLUX-1-schnell`      | Yes (1 image)                      | `DEEPINFRA_API_KEY`                                   |
| fal        | `fal-ai/flux/dev`                       | Yes                                | `FAL_KEY`                                             |
| Google     | `gemini-3.1-flash-image-preview`        | Yes                                | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                  |
| LiteLLM    | `gpt-image-2`                           | Yes (up to 5 input images)         | `LITELLM_API_KEY`                                     |
| MiniMax    | `image-01`                              | Yes (subject reference)            | `MINIMAX_API_KEY` or MiniMax OAuth (`minimax-portal`) |
| OpenAI     | `gpt-image-2`                           | Yes (up to 4 images)               | `OPENAI_API_KEY` or OpenAI Codex OAuth                |
| OpenRouter | `google/gemini-3.1-flash-image-preview` | Yes (up to 5 input images)         | `OPENROUTER_API_KEY`                                  |
| Vydra      | `grok-imagine`                          | No                                 | `VYDRA_API_KEY`                                       |
| xAI        | `grok-imagine-image`                    | Yes (up to 5 images)               | `XAI_API_KEY`                                         |

Use `action: "list"` to inspect available providers and models at runtime:

```text
/tool image_generate action=list
```

## Provider capabilities

| Capability            | ComfyUI            | DeepInfra | fal               | Google         | MiniMax               | OpenAI         | Vydra | xAI            |
| --------------------- | ------------------ | --------- | ----------------- | -------------- | --------------------- | -------------- | ----- | -------------- |
| Generate (max count)  | Workflow-defined   | 4         | 4                 | 4              | 9                     | 4              | 1     | 4              |
| Edit / reference      | 1 image (workflow) | 1 image   | 1 image           | Up to 5 images | 1 image (subject ref) | Up to 5 images | -     | Up to 5 images |
| Size control          | -                  | ✓         | ✓                 | ✓              | -                     | Up to 4K       | -     | -              |
| Aspect ratio          | -                  | -         | ✓ (generate only) | ✓              | ✓                     | -              | -     | ✓              |
| Resolution (1K/2K/4K) | -                  | -         | ✓                 | ✓              | -                     | -              | -     | 1K, 2K         |

## Tool parameters

<ParamField path="prompt" type="string" required>
  Image generation prompt. Required for `action: "generate"`.
</ParamField>
<ParamField path="action" type='"generate" | "list"' default="generate">
  Use `"list"` to inspect available providers and models at runtime.
</ParamField>
<ParamField path="model" type="string">
  Provider/model override (e.g. `openai/gpt-image-2`). Use
  `openai/gpt-image-1.5` for transparent OpenAI backgrounds.
</ParamField>
<ParamField path="image" type="string">
  Single reference image path or URL for edit mode.
</ParamField>
<ParamField path="images" type="string[]">
  Multiple reference images for edit mode (up to 5 on supporting providers).
</ParamField>
<ParamField path="size" type="string">
  Size hint: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `3840x2160`.
</ParamField>
<ParamField path="aspectRatio" type="string">
  Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`.
</ParamField>
<ParamField path="resolution" type='"1K" | "2K" | "4K"'>Resolution hint.</ParamField>
<ParamField path="quality" type='"low" | "medium" | "high" | "auto"'>
  Quality hint when the provider supports it.
</ParamField>
<ParamField path="outputFormat" type='"png" | "jpeg" | "webp"'>
  Output format hint when the provider supports it.
</ParamField>
<ParamField path="background" type='"transparent" | "opaque" | "auto"'>
  Background hint when the provider supports it. Use `transparent` with
  `outputFormat: "png"` or `"webp"` for transparency-capable providers.
</ParamField>
<ParamField path="count" type="number">Number of images to generate (1-4).</ParamField>
<ParamField path="timeoutMs" type="number">
  Optional provider request timeout in milliseconds. When Codex calls
  `image_generate` through dynamic tools, this per-call value still overrides
  the configured default and is capped at 600000 ms.
</ParamField>
<ParamField path="filename" type="string">Output filename hint.</ParamField>
<ParamField path="openai" type="object">
  OpenAI-only hints: `background`, `moderation`, `outputCompression`, and `user`.
</ParamField>

<Note>
Not all providers support all parameters. When a fallback provider supports a
nearby geometry option instead of the exact requested one, OpenClaw remaps to
the closest supported size, aspect ratio, or resolution before submission.
Unsupported output hints are dropped for providers that do not declare
support and reported in the tool result. Tool results report the applied
settings; `details.normalization` captures any requested-to-applied
translation.
</Note>

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-2",
        timeoutMs: 180_000,
        fallbacks: [
          "openrouter/google/gemini-3.1-flash-image-preview",
          "google/gemini-3.1-flash-image-preview",
          "fal/fal-ai/flux/dev",
        ],
      },
    },
  },
}
```

### Provider selection order

OpenClaw tries providers in this order:

1. **`model` parameter** from the tool call (if the agent specifies one).
2. **`imageGenerationModel.primary`** from config.
3. **`imageGenerationModel.fallbacks`** in order.
4. **Auto-detection** - auth-backed provider defaults only:
   - current default provider first;
   - remaining registered image-generation providers in provider-id order.

If a provider fails (auth error, rate limit, etc.), the next configured
candidate is tried automatically. If all fail, the error includes details
from each attempt.

<AccordionGroup>
  <Accordion title="Per-call model overrides are exact">
    A per-call `model` override tries only that provider/model and does
    not continue to configured primary/fallback or auto-detected providers.
  </Accordion>
  <Accordion title="Auto-detection is auth-aware">
    A provider default only enters the candidate list when OpenClaw can
    actually authenticate that provider. Set
    `agents.defaults.mediaGenerationAutoProviderFallback: false` to use only
    explicit `model`, `primary`, and `fallbacks` entries.
  </Accordion>
  <Accordion title="Timeouts">
    Set `agents.defaults.imageGenerationModel.timeoutMs` for slow image
    backends. A per-call `timeoutMs` tool parameter overrides the configured
    default. Codex dynamic-tool calls honor the same timeout budget, bounded
    by OpenClaw's 600000 ms dynamic-tool bridge maximum.
  </Accordion>
  <Accordion title="Inspect at runtime">
    Use `action: "list"` to inspect the currently registered providers,
    their default models, and auth env-var hints.
  </Accordion>
</AccordionGroup>

### Image editing

OpenAI, OpenRouter, Google, DeepInfra, fal, MiniMax, ComfyUI, and xAI support editing
reference images. Pass a reference image path or URL:

```text
"Generate a watercolor version of this photo" + image: "/path/to/photo.jpg"
```

OpenAI, OpenRouter, Google, and xAI support up to 5 reference images via the
`images` parameter. fal, MiniMax, and ComfyUI support 1.

## Provider deep dives

<AccordionGroup>
  <Accordion title="OpenAI gpt-image-2 (and gpt-image-1.5)">
    OpenAI image generation defaults to `openai/gpt-image-2`. If an
    `openai-codex` OAuth profile is configured, OpenClaw reuses the same
    OAuth profile used by Codex subscription chat models and sends the
    image request through the Codex Responses backend. Legacy Codex base
    URLs such as `https://chatgpt.com/backend-api` are canonicalized to
    `https://chatgpt.com/backend-api/codex` for image requests. OpenClaw
    does **not** silently fall back to `OPENAI_API_KEY` for that request -
    to force direct OpenAI Images API routing, configure
    `models.providers.openai` explicitly with an API key, custom base URL,
    or Azure endpoint.

    The `openai/gpt-image-1.5`, `openai/gpt-image-1`, and
    `openai/gpt-image-1-mini` models can still be selected explicitly. Use
    `gpt-image-1.5` for transparent-background PNG/WebP output; the current
    `gpt-image-2` API rejects `background: "transparent"`.

    `gpt-image-2` supports both text-to-image generation and
    reference-image editing through the same `image_generate` tool.
    OpenClaw forwards `prompt`, `count`, `size`, `quality`, `outputFormat`,
    and reference images to OpenAI. OpenAI does **not** receive
    `aspectRatio` or `resolution` directly; when possible OpenClaw maps
    those into a supported `size`, otherwise the tool reports them as
    ignored overrides.

    OpenAI-specific options live under the `openai` object:

    ```json
    {
      "quality": "low",
      "outputFormat": "jpeg",
      "openai": {
        "background": "opaque",
        "moderation": "low",
        "outputCompression": 60,
        "user": "end-user-42"
      }
    }
    ```

    `openai.background` accepts `transparent`, `opaque`, or `auto`;
    transparent outputs require `outputFormat` `png` or `webp` and a
    transparency-capable OpenAI image model. OpenClaw routes default
    `gpt-image-2` transparent-background requests to `gpt-image-1.5`.
    `openai.outputCompression` applies to JPEG/WebP outputs.

    The top-level `background` hint is provider-neutral and currently maps
    to the same OpenAI `background` request field when the OpenAI provider
    is selected. Providers that do not declare background support return
    it in `ignoredOverrides` instead of receiving the unsupported parameter.

    To route OpenAI image generation through an Azure OpenAI deployment
    instead of `api.openai.com`, see
    [Azure OpenAI endpoints](/providers/openai#azure-openai-endpoints).

  </Accordion>
  <Accordion title="OpenRouter image models">
    OpenRouter image generation uses the same `OPENROUTER_API_KEY` and
    routes through OpenRouter's chat completions image API. Select
    OpenRouter image models with the `openrouter/` prefix:

    ```json5
    {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "openrouter/google/gemini-3.1-flash-image-preview",
          },
        },
      },
    }
    ```

    OpenClaw forwards `prompt`, `count`, reference images, and
    Gemini-compatible `aspectRatio` / `resolution` hints to OpenRouter.
    Current built-in OpenRouter image model shortcuts include
    `google/gemini-3.1-flash-image-preview`,
    `google/gemini-3-pro-image-preview`, and `openai/gpt-5.4-image-2`. Use
    `action: "list"` to see what your configured plugin exposes.

  </Accordion>
  <Accordion title="MiniMax dual-auth">
    MiniMax image generation is available through both bundled MiniMax
    auth paths:

    - `minimax/image-01` for API-key setups
    - `minimax-portal/image-01` for OAuth setups

  </Accordion>
  <Accordion title="xAI grok-imagine-image">
    The bundled xAI provider uses `/v1/images/generations` for prompt-only
    requests and `/v1/images/edits` when `image` or `images` is present.

    - Models: `xai/grok-imagine-image`, `xai/grok-imagine-image-pro`
    - Count: up to 4
    - References: one `image` or up to five `images`
    - Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `2:3`, `3:2`
    - Resolutions: `1K`, `2K`
    - Outputs: returned as OpenClaw-managed image attachments

    OpenClaw intentionally does not expose xAI-native `quality`, `mask`,
    `user`, or extra native-only aspect ratios until those controls exist
    in the shared cross-provider `image_generate` contract.

  </Accordion>
</AccordionGroup>

## Examples

<Tabs>
  <Tab title="Generate (4K landscape)">
```text
/tool image_generate action=generate model=openai/gpt-image-2 prompt="A clean editorial poster for OpenClaw image generation" size=3840x2160 count=1
```
  </Tab>
  <Tab title="Generate (transparent PNG)">
```text
/tool image_generate action=generate model=openai/gpt-image-1.5 prompt="A simple red circle sticker on a transparent background" outputFormat=png background=transparent
```

Equivalent CLI:

```bash
openclaw infer image generate \
  --model openai/gpt-image-1.5 \
  --output-format png \
  --background transparent \
  --prompt "A simple red circle sticker on a transparent background" \
  --json
```

  </Tab>
  <Tab title="Generate (two square)">
```text
/tool image_generate action=generate model=openai/gpt-image-2 prompt="Two visual directions for a calm productivity app icon" size=1024x1024 count=2
```
  </Tab>
  <Tab title="Edit (one reference)">
```text
/tool image_generate action=generate model=openai/gpt-image-2 prompt="Keep the subject, replace the background with a bright studio setup" image=/path/to/reference.png size=1024x1536
```
  </Tab>
  <Tab title="Edit (multiple references)">
```text
/tool image_generate action=generate model=openai/gpt-image-2 prompt="Combine the character identity from the first image with the color palette from the second" images='["/path/to/character.png","/path/to/palette.jpg"]' size=1536x1024
```
  </Tab>
</Tabs>

The same `--output-format` and `--background` flags are available on
`openclaw infer image edit`; `--openai-background` remains as an
OpenAI-specific alias. Bundled providers other than OpenAI do not declare
explicit background control today, so `background: "transparent"` is reported
as ignored for them.

## Related

- [Tools overview](/tools) - all available agent tools
- [ComfyUI](/providers/comfy) - local ComfyUI and Comfy Cloud workflow setup
- [fal](/providers/fal) - fal image and video provider setup
- [Google (Gemini)](/providers/google) - Gemini image provider setup
- [MiniMax](/providers/minimax) - MiniMax image provider setup
- [OpenAI](/providers/openai) - OpenAI Images provider setup
- [Vydra](/providers/vydra) - Vydra image, video, and speech setup
- [xAI](/providers/xai) - Grok image, video, search, code execution, and TTS setup
- [Configuration reference](/gateway/config-agents#agent-defaults) - `imageGenerationModel` config
- [Models](/concepts/models) - model configuration and failover
