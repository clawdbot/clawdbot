---
summary: "Generate and edit images using configured providers (OpenAI, OpenAI Codex OAuth, Google Gemini, OpenRouter, fal, MiniMax, ComfyUI, Vydra, xAI)"
read_when:
  - Generating images via the agent
  - Configuring image generation providers and models
  - Understanding the image_generate tool parameters
title: "Image generation"
---

The `image_generate` tool lets the agent create and edit images using your configured providers. Generated images are delivered automatically as media attachments in the agent's reply.

<Note>
The tool only appears when at least one image generation provider is available. If you don't see `image_generate` in your agent's tools, configure `agents.defaults.imageGenerationModel`, set up a provider API key, or sign in with OpenAI Codex OAuth.
</Note>

## Quick start

1. Set an API key for at least one provider (for example `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`) or sign in with OpenAI Codex OAuth.
2. Optionally set your preferred model:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-2",
      },
    },
  },
}
```

Codex OAuth uses the same `openai/gpt-image-2` model ref. When an
`openai-codex` OAuth profile is configured, OpenClaw routes image requests
through that same OAuth profile instead of first trying `OPENAI_API_KEY`.
Explicit custom `models.providers.openai` image config, such as an API key or
custom/Azure base URL, opts back into the direct OpenAI Images API route.
For OpenAI-compatible LAN endpoints such as LocalAI, keep the custom
`models.providers.openai.baseUrl` and explicitly opt in with
`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`; private/internal
image endpoints remain blocked by default.

3. Ask the agent: _"Generate an image of a friendly robot mascot."_

The agent calls `image_generate` automatically. No tool allow-listing needed — it's enabled by default when a provider is available.

## Supported providers

| Provider   | Default model                           | Edit support                       | Auth                                                  |
| ---------- | --------------------------------------- | ---------------------------------- | ----------------------------------------------------- |
| OpenAI     | `gpt-image-2`                           | Yes (up to 4 images)               | `OPENAI_API_KEY` or OpenAI Codex OAuth                |
| OpenRouter | `google/gemini-3.1-flash-image-preview` | Yes (up to 5 input images)         | `OPENROUTER_API_KEY`                                  |
| Google     | `gemini-3.1-flash-image-preview`        | Yes                                | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                  |
| fal        | `fal-ai/flux/dev`                       | Yes                                | `FAL_KEY`                                             |
| MiniMax    | `image-01`                              | Yes (subject reference)            | `MINIMAX_API_KEY` or MiniMax OAuth (`minimax-portal`) |
| ComfyUI    | `workflow`                              | Yes (1 image, workflow-configured) | `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` for cloud    |
| Vydra      | `grok-imagine`                          | No                                 | `VYDRA_API_KEY`                                       |
| xAI        | `grok-imagine-image`                    | Yes (up to 5 images)               | `XAI_API_KEY`                                         |

Use `action: "list"` to inspect available providers and models at runtime:

```
/tool image_generate action=list
```

## Tool parameters

<ParamField path="prompt" type="string" required>
Image generation prompt. Required for `action: "generate"`.
</ParamField>

<ParamField path="action" type="'generate' | 'list'" default="generate">
Use `"list"` to inspect available providers and models at runtime.
</ParamField>

<ParamField path="model" type="string">
Provider/model override, e.g. `openai/gpt-image-2`.
</ParamField>

<ParamField path="image" type="string">
Single reference image path or URL for edit mode.
</ParamField>

<ParamField path="images" type="string[]">
Multiple reference images for edit mode (up to 5).
</ParamField>

<ParamField path="size" type="string">
Size hint: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `3840x2160`.
</ParamField>

<ParamField path="aspectRatio" type="string">
Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`.
</ParamField>

<ParamField path="resolution" type="'1K' | '2K' | '4K'">
Resolution hint.
</ParamField>

<ParamField path="quality" type="'low' | 'medium' | 'high' | 'auto'">
Quality hint when the provider supports it.
</ParamField>

<ParamField path="outputFormat" type="'png' | 'jpeg' | 'webp'">
Output format hint when the provider supports it.
</ParamField>

<ParamField path="count" type="number">
Number of images to generate (1–4).
</ParamField>

<ParamField path="timeoutMs" type="number">
Optional provider request timeout in milliseconds.
</ParamField>

<ParamField path="filename" type="string">
Output filename hint.
</ParamField>

<ParamField path="openai" type="object">
OpenAI-only hints: `background`, `moderation`, `outputCompression`, and `user`.
</ParamField>

Not all providers support all parameters. When a fallback provider supports a nearby geometry option instead of the exact requested one, OpenClaw remaps to the closest supported size, aspect ratio, or resolution before submission. Unsupported output hints such as `quality` or `outputFormat` are dropped for providers that do not declare support and are reported in the tool result.

Tool results report the applied settings. When OpenClaw remaps geometry during provider fallback, the returned `size`, `aspectRatio`, and `resolution` values reflect what was actually sent, and `details.normalization` captures the requested-to-applied translation.

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-2",
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

When generating an image, OpenClaw tries providers in this order:

1. **`model` parameter** from the tool call (if the agent specifies one)
2. **`imageGenerationModel.primary`** from config
3. **`imageGenerationModel.fallbacks`** in order
4. **Auto-detection** — uses auth-backed provider defaults only:
   - current default provider first
   - remaining registered image-generation providers in provider-id order

If a provider fails (auth error, rate limit, etc.), the next candidate is tried automatically. If all fail, the error includes details from each attempt.

Notes:

- Auto-detection is auth-aware. A provider default only enters the candidate list
  when OpenClaw can actually authenticate that provider.
- Auto-detection is enabled by default. Set
  `agents.defaults.mediaGenerationAutoProviderFallback: false` if you want image
  generation to use only the explicit `model`, `primary`, and `fallbacks`
  entries.
- Use `action: "list"` to inspect the currently registered providers, their
  default models, and auth env-var hints.

### Image editing

OpenAI, OpenRouter, Google, fal, MiniMax, ComfyUI, and xAI support editing reference images. Pass a reference image path or URL:

```
"Generate a watercolor version of this photo" + image: "/path/to/photo.jpg"
```

OpenAI, OpenRouter, Google, and xAI support up to 5 reference images via the `images` parameter. fal, MiniMax, and ComfyUI support 1.

### OpenRouter image models

OpenRouter image generation uses the same `OPENROUTER_API_KEY` and routes through OpenRouter's chat completions image API. Select OpenRouter image models with the `openrouter/` prefix:

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

OpenClaw forwards `prompt`, `count`, reference images, and Gemini-compatible `aspectRatio` / `resolution` hints to OpenRouter. Current built-in OpenRouter image model shortcuts include `google/gemini-3.1-flash-image-preview`, `google/gemini-3-pro-image-preview`, and `openai/gpt-5.4-image-2`; use `action: "list"` to see what your configured plugin exposes.

### OpenAI `gpt-image-2`

OpenAI image generation defaults to `openai/gpt-image-2`. If an
`openai-codex` OAuth profile is configured, OpenClaw reuses the same OAuth
profile used by Codex subscription chat models and sends the image request
through the Codex Responses backend; it does not silently fall back to
`OPENAI_API_KEY` for that request. To force direct OpenAI Images API routing,
configure `models.providers.openai` explicitly with an API key, custom base URL,
or Azure endpoint. The older
`openai/gpt-image-1` model can still be selected explicitly, but new OpenAI
image-generation and image-editing requests should use `gpt-image-2`.

`gpt-image-2` supports both text-to-image generation and reference-image
editing through the same `image_generate` tool. OpenClaw forwards `prompt`,
`count`, `size`, `quality`, `outputFormat`, and reference images to OpenAI.
OpenAI does not receive `aspectRatio` or `resolution` directly; when possible
OpenClaw maps those into a supported `size`, otherwise the tool reports them as
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

`openai.background` accepts `transparent`, `opaque`, or `auto`; transparent
outputs require `outputFormat` `png` or `webp`. `openai.outputCompression`
applies to JPEG/WebP outputs.

Generate one 4K landscape image:

```
/tool image_generate action=generate model=openai/gpt-image-2 prompt="A clean editorial poster for OpenClaw image generation" size=3840x2160 count=1
```

Generate two square images:

```
/tool image_generate action=generate model=openai/gpt-image-2 prompt="Two visual directions for a calm productivity app icon" size=1024x1024 count=2
```

Edit one local reference image:

```
/tool image_generate action=generate model=openai/gpt-image-2 prompt="Keep the subject, replace the background with a bright studio setup" image=/path/to/reference.png size=1024x1536
```

Edit with multiple references:

```
/tool image_generate action=generate model=openai/gpt-image-2 prompt="Combine the character identity from the first image with the color palette from the second" images='["/path/to/character.png","/path/to/palette.jpg"]' size=1536x1024
```

To route OpenAI image generation through an Azure OpenAI deployment instead
of `api.openai.com`, see [Azure OpenAI endpoints](/providers/openai#azure-openai-endpoints)
in the OpenAI provider docs.

MiniMax image generation is available through both bundled MiniMax auth paths:

- `minimax/image-01` for API-key setups
- `minimax-portal/image-01` for OAuth setups

## Provider capabilities

| Capability            | OpenAI               | Google               | fal                 | MiniMax                    | ComfyUI                            | Vydra   | xAI                  |
| --------------------- | -------------------- | -------------------- | ------------------- | -------------------------- | ---------------------------------- | ------- | -------------------- |
| Generate              | Yes (up to 4)        | Yes (up to 4)        | Yes (up to 4)       | Yes (up to 9)              | Yes (workflow-defined outputs)     | Yes (1) | Yes (up to 4)        |
| Edit/reference        | Yes (up to 5 images) | Yes (up to 5 images) | Yes (1 image)       | Yes (1 image, subject ref) | Yes (1 image, workflow-configured) | No      | Yes (up to 5 images) |
| Size control          | Yes (up to 4K)       | Yes                  | Yes                 | No                         | No                                 | No      | No                   |
| Aspect ratio          | No                   | Yes                  | Yes (generate only) | Yes                        | No                                 | No      | Yes                  |
| Resolution (1K/2K/4K) | No                   | Yes                  | Yes                 | No                         | No                                 | No      | Yes (1K/2K)          |

### xAI `grok-imagine-image`

The bundled xAI provider uses `/v1/images/generations` for prompt-only requests
and `/v1/images/edits` when `image` or `images` is present.

- Models: `xai/grok-imagine-image`, `xai/grok-imagine-image-pro`
- Count: up to 4
- References: one `image` or up to five `images`
- Aspect ratios: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `2:3`, `3:2`
- Resolutions: `1K`, `2K`
- Outputs: returned as OpenClaw-managed image attachments

OpenClaw intentionally does not expose xAI-native `quality`, `mask`, `user`, or
extra native-only aspect ratios until those controls exist in the shared
cross-provider `image_generate` contract.

## Related

- [Tools Overview](/tools) — all available agent tools
- [fal](/providers/fal) — fal image and video provider setup
- [ComfyUI](/providers/comfy) — local ComfyUI and Comfy Cloud workflow setup
- [Google (Gemini)](/providers/google) — Gemini image provider setup
- [MiniMax](/providers/minimax) — MiniMax image provider setup
- [OpenAI](/providers/openai) — OpenAI Images provider setup
- [Vydra](/providers/vydra) — Vydra image, video, and speech setup
- [xAI](/providers/xai) — Grok image, video, search, code execution, and TTS setup
- [Configuration Reference](/gateway/config-agents#agent-defaults) — `imageGenerationModel` config
- [Models](/concepts/models) — model configuration and failover
