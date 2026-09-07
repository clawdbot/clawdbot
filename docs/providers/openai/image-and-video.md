---
summary: "Generate and edit images with gpt-image, and generate video with Sora"
read_when:
  - You are generating or editing images through the openai provider
  - You need transparent-background image output
  - You are generating video with the video_generate tool
title: "OpenAI image and video generation"
sidebarTitle: "Image and video"
---

## Image generation

The bundled `openai` plugin registers image generation through the
`image_generate` tool. It supports both OpenAI API-key and Codex OAuth image
generation through the same `openai/gpt-image-2` model ref.

| Capability                | OpenAI API key                     | Codex OAuth                          |
| ------------------------- | ---------------------------------- | ------------------------------------ |
| Model ref                 | `openai/gpt-image-2`               | `openai/gpt-image-2`                 |
| Auth                      | `OPENAI_API_KEY`                   | OpenAI Codex OAuth sign-in           |
| Transport                 | OpenAI Images API                  | Codex Responses backend              |
| Max images per request    | 4                                  | 4                                    |
| Edit mode                 | Enabled (up to 5 reference images) | Enabled (up to 5 reference images)   |
| Moderation                | `low` or `auto`; generate and edit | `low` or `auto`; generate and edit   |
| Size overrides            | Supported, including 2K/4K sizes   | Supported, including 2K/4K sizes     |
| Aspect ratio / resolution | Not forwarded to OpenAI Images API | Mapped to a supported size when safe |

```json5
{
  agents: {
    defaults: {
      mediaModels: { image: { primary: "openai/gpt-image-2" } },
    },
  },
}
```

<Note>
See [Image Generation](/tools/image-generation) for shared tool parameters,
provider selection, and failover behavior.
</Note>

`gpt-image-2` is the default for OpenAI text-to-image generation and image
editing. `gpt-image-1.5`, `gpt-image-1`, and `gpt-image-1-mini` remain usable
as explicit model overrides. Use `openai/gpt-image-1.5` for
transparent-background PNG/WebP output; the current `gpt-image-2` API rejects
`background: "transparent"`.

For a transparent-background request, call `image_generate` with
`model: "openai/gpt-image-1.5"`, `outputFormat: "png"` or `"webp"`, and
`background: "transparent"`; the older `openai.background` provider option is
still accepted. OpenClaw also protects the public OpenAI and OpenAI Codex OAuth
routes by rewriting default `openai/gpt-image-2` transparent requests to
`gpt-image-1.5`; Azure and custom OpenAI-compatible endpoints keep their
configured deployment/model names.

The same setting is exposed for headless CLI runs:

```bash
openclaw infer image generate \
  --model openai/gpt-image-1.5 \
  --output-format png \
  --background transparent \
  --prompt "A simple red circle sticker on a transparent background" \
  --json
```

Use the same `--output-format` and `--background` flags with
`openclaw infer image edit` when starting from an input file.
`--openai-background` remains available as an OpenAI-specific alias. Use
`--quality low|medium|high|auto` to control OpenAI Images quality and cost.
Use `--openai-moderation low|auto` with both `image generate` and `image edit`
to pass OpenAI's moderation hint. The direct OpenAI Images API and the
ChatGPT/Codex OAuth Responses backend both support moderation for text-to-image
generation and reference-image edits.

For ChatGPT/Codex OAuth installs, keep the same `openai/gpt-image-2` ref. When
an `openai` OAuth profile is configured, OpenClaw resolves that stored OAuth
access token and sends image requests through the Codex Responses backend; it
does not first try `OPENAI_API_KEY` or silently fall back to an API key.
Configure `models.providers.openai` explicitly with an API key, custom base
URL, or Azure endpoint when you want the direct OpenAI Images API route
instead. If that custom image endpoint is on a trusted LAN/private address,
also set `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true`; OpenClaw
keeps private/internal OpenAI-compatible image endpoints blocked unless this
opt-in is present.

Generate:

```
/tool image_generate model=openai/gpt-image-2 prompt="A polished launch poster for OpenClaw on macOS" size=3840x2160 count=1
```

Generate a transparent PNG:

```
/tool image_generate model=openai/gpt-image-1.5 prompt="A simple red circle sticker on a transparent background" outputFormat=png background=transparent
```

Edit:

```
/tool image_generate model=openai/gpt-image-2 prompt="Preserve the object shape, change the material to translucent glass" image=/path/to/reference.png size=1024x1536
```

## Video generation

The bundled `openai` plugin registers video generation through the
`video_generate` tool.

| Capability       | Value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| Default model    | `openai/sora-2`                                                                    |
| Modes            | Text-to-video, image-to-video, single-video edit                                   |
| Reference inputs | 1 image or 1 video                                                                 |
| Size overrides   | Supported for text-to-video and image-to-video                                     |
| Aspect ratio     | Converted to the closest supported size, not forwarded raw                         |
| Other overrides  | `resolution`, `audio`, `watermark` are unsupported and dropped with a tool warning |

OpenAI image-to-video requests use `POST /v1/videos` with an image
`input_reference`. Single-video edits use `POST /v1/videos/edits` with the
uploaded video in the `video` field.

```json5
{
  agents: {
    defaults: {
      mediaModels: { video: { primary: "openai/sora-2" } },
    },
  },
}
```

<Note>
See [Video Generation](/tools/video-generation) for shared tool parameters,
provider selection, and failover behavior.

The OpenAI provider declares `supportsSize` but not `supportsAspectRatio` or
`supportsResolution`. OpenClaw's shared normalization layer converts a
requested `aspectRatio` into the closest matching OpenAI `size` before the
request reaches the provider, so aspect-ratio requests generally still work.
`resolution` has no size fallback and is dropped, surfaced to the caller as
`Ignored unsupported overrides for openai/<model>: resolution=<value>`.
</Note>
