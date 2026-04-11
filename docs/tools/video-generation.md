---
summary: "Generate videos from text, images, or existing videos using 12 provider backends"
read_when:
  - Generating videos via the agent
  - Configuring video generation providers and models
  - Understanding the video_generate tool parameters
title: "Video Generation"
---

# Video Generation

OpenClaw agents can generate videos from text prompts, reference images, or existing videos. Twelve provider backends are supported, each with different model options, input modes, and feature sets. The agent picks the right provider automatically based on your configuration and available API keys.

<Note>
The `video_generate` tool only appears when at least one video-generation provider is available. If you do not see it in your agent tools, set a provider API key or configure `agents.defaults.videoGenerationModel`.
</Note>

OpenClaw treats video generation as three runtime modes:

- `generate` for text-to-video requests with no reference media
- `imageToVideo` when the request includes one or more reference images
- `videoToVideo` when the request includes one or more reference videos

Providers can support any subset of those modes. The tool validates the active
mode before submission and reports supported modes in `action=list`.

## Quick start

1. Set an API key for any supported provider:

```bash
export GEMINI_API_KEY="your-key"
```

2. Optionally pin a default model:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
```

3. Ask the agent:

> Generate a 5-second cinematic video of a friendly lobster surfing at sunset.

The agent calls `video_generate` automatically. No tool allowlisting is needed.

## What happens when you generate a video

Video generation is asynchronous. When the agent calls `video_generate` in a session:

1. OpenClaw submits the request to the provider and immediately returns a task ID.
2. The provider processes the job in the background (typically 30 seconds to 5 minutes depending on the provider and resolution).
3. When the video is ready, OpenClaw wakes the same session with an internal completion event.
4. The agent posts the finished video back into the original conversation.

While a job is in flight, duplicate `video_generate` calls in the same session return the current task status instead of starting another generation. Use `openclaw tasks list` or `openclaw tasks show <taskId>` to check progress from the CLI.

Outside of session-backed agent runs (for example, direct tool invocations), the tool falls back to inline generation and returns the final media path in the same turn.

### Task lifecycle

Each `video_generate` request moves through four states:

1. **queued** -- task created, waiting for the provider to accept it.
2. **running** -- provider is processing (typically 30 seconds to 5 minutes depending on provider and resolution).
3. **succeeded** -- video ready; the agent wakes and posts it to the conversation.
4. **failed** -- provider error or timeout; the agent wakes with error details.

Check status from the CLI:

```bash
openclaw tasks list
openclaw tasks show <taskId>
openclaw tasks cancel <taskId>
```

Duplicate prevention: if a video task is already `queued` or `running` for the current session, `video_generate` returns the existing task status instead of starting a new one. Use `action: "status"` to check explicitly without triggering a new generation.

## Supported providers

| Provider | Default model                   | Text | Image ref         | Video ref        | API key                                  |
| -------- | ------------------------------- | ---- | ----------------- | ---------------- | ---------------------------------------- |
| Alibaba  | `wan2.6-t2v`                    | Yes  | Yes (remote URL)  | Yes (remote URL) | `MODELSTUDIO_API_KEY`                    |
| BytePlus | `seedance-1-0-lite-t2v-250428`  | Yes  | 1 image           | No               | `BYTEPLUS_API_KEY`                       |
| ComfyUI  | `workflow`                      | Yes  | 1 image           | No               | `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` |
| fal      | `fal-ai/minimax/video-01-live`  | Yes  | 1 image           | No               | `FAL_KEY`                                |
| Google   | `veo-3.1-fast-generate-preview` | Yes  | 1 image           | 1 video          | `GEMINI_API_KEY`                         |
| MiniMax  | `MiniMax-Hailuo-2.3`            | Yes  | 1 image           | No               | `MINIMAX_API_KEY`                        |
| OpenAI   | `sora-2`                        | Yes  | 1 image           | 1 video          | `OPENAI_API_KEY`                         |
| Qwen     | `wan2.6-t2v`                    | Yes  | Yes (remote URL)  | Yes (remote URL) | `QWEN_API_KEY`                           |
| Runway   | `gen4.5`                        | Yes  | 1 image           | 1 video          | `RUNWAYML_API_SECRET`                    |
| Together | `Wan-AI/Wan2.2-T2V-A14B`        | Yes  | 1 image           | No               | `TOGETHER_API_KEY`                       |
| Vydra    | `veo3`                          | Yes  | 1 image (`kling`) | No               | `VYDRA_API_KEY`                          |
| xAI      | `grok-imagine-video`            | Yes  | 1 image           | 1 video          | `XAI_API_KEY`                            |

Some providers accept additional or alternate API key env vars. See individual [provider pages](#related) for details.

Run `video_generate action=list` to inspect available providers, models, and
runtime modes at runtime.

### Declared capability matrix

This is the explicit mode contract used by `video_generate`, contract tests,
and the shared live sweep.

| Provider | `generate` | `imageToVideo` | `videoToVideo` | Shared live lanes today                                                                                                                  |
| -------- | ---------- | -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Alibaba  | Yes        | Yes            | Yes            | `generate`, `imageToVideo`; `videoToVideo` skipped because this provider needs remote `http(s)` video URLs                               |
| BytePlus | Yes        | Yes            | No             | `generate`, `imageToVideo`                                                                                                               |
| ComfyUI  | Yes        | Yes            | No             | Not in the shared sweep; workflow-specific coverage lives with Comfy tests                                                               |
| fal      | Yes        | Yes            | No             | `generate`, `imageToVideo`                                                                                                               |
| Google   | Yes        | Yes            | Yes            | `generate`, `imageToVideo`; shared `videoToVideo` skipped because the current buffer-backed Gemini/Veo sweep does not accept that input  |
| MiniMax  | Yes        | Yes            | No             | `generate`, `imageToVideo`                                                                                                               |
| OpenAI   | Yes        | Yes            | Yes            | `generate`, `imageToVideo`; shared `videoToVideo` skipped because this org/input path currently needs provider-side inpaint/remix access |
| Qwen     | Yes        | Yes            | Yes            | `generate`, `imageToVideo`; `videoToVideo` skipped because this provider needs remote `http(s)` video URLs                               |
| Runway   | Yes        | Yes            | Yes            | `generate`, `imageToVideo`; `videoToVideo` runs only when the selected model is `runway/gen4_aleph`                                      |
| Together | Yes        | Yes            | No             | `generate`, `imageToVideo`                                                                                                               |
| Vydra    | Yes        | Yes            | No             | `generate`; shared `imageToVideo` skipped because bundled `veo3` is text-only and bundled `kling` requires a remote image URL            |
| xAI      | Yes        | Yes            | Yes            | `generate`, `imageToVideo`; `videoToVideo` skipped because this provider currently needs a remote MP4 URL                                |

## Tool parameters

### Required

| Parameter | Type   | Description                                                                   |
| --------- | ------ | ----------------------------------------------------------------------------- |
| `prompt`  | string | Text description of the video to generate (required for `action: "generate"`) |

### Content inputs

| Parameter | Type     | Description                          |
| --------- | -------- | ------------------------------------ |
| `image`   | string   | Single reference image (path or URL) |
| `images`  | string[] | Multiple reference images (up to 5)  |
| `video`   | string   | Single reference video (path or URL) |
| `videos`  | string[] | Multiple reference videos (up to 4)  |

### Style controls

| Parameter         | Type    | Description                                                              |
| ----------------- | ------- | ------------------------------------------------------------------------ |
| `aspectRatio`     | string  | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`  |
| `resolution`      | string  | `480P`, `720P`, `768P`, or `1080P`                                       |
| `durationSeconds` | number  | Target duration in seconds (rounded to nearest provider-supported value) |
| `size`            | string  | Size hint when the provider supports it                                  |
| `audio`           | boolean | Enable generated audio when supported                                    |
| `watermark`       | boolean | Toggle provider watermarking when supported                              |

### Advanced

| Parameter  | Type   | Description                                     |
| ---------- | ------ | ----------------------------------------------- |
| `action`   | string | `"generate"` (default), `"status"`, or `"list"` |
| `model`    | string | Provider/model override (e.g. `runway/gen4.5`)  |
| `filename` | string | Output filename hint                            |

Not all providers support all parameters. OpenClaw already normalizes duration to the closest provider-supported value, and it also remaps translated geometry hints such as size-to-aspect-ratio when a fallback provider exposes a different control surface. Truly unsupported overrides are ignored on a best-effort basis and reported as warnings in the tool result. Hard capability limits (such as too many reference inputs) fail before submission.

Tool results report the applied settings. When OpenClaw remaps duration or geometry during provider fallback, the returned `durationSeconds`, `size`, `aspectRatio`, and `resolution` values reflect what was submitted, and `details.normalization` captures the requested-to-applied translation.

Reference inputs also select the runtime mode:

- No reference media: `generate`
- Any image reference: `imageToVideo`
- Any video reference: `videoToVideo`

Mixed image and video references are not a stable shared capability surface.
Prefer one reference type per request.

## Actions

- **generate** (default) -- create a video from the given prompt and optional reference inputs.
- **status** -- check the state of the in-flight video task for the current session without starting another generation.
- **list** -- show available providers, models, and their capabilities.

## Model selection

When generating a video, OpenClaw resolves the model in this order:

1. **`model` tool parameter** -- if the agent specifies one in the call.
2. **`videoGenerationModel.primary`** -- from config.
3. **`videoGenerationModel.fallbacks`** -- tried in order.
4. **Auto-detection** -- uses providers that have valid auth, starting with the current default provider, then remaining providers in alphabetical order.

If a provider fails, the next candidate is tried automatically. If all candidates fail, the error includes details from each attempt.

Set `agents.defaults.mediaGenerationAutoProviderFallback: false` if you want
video generation to use only the explicit `model`, `primary`, and `fallbacks`
entries.

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
        fallbacks: ["runway/gen4.5", "qwen/wan2.6-t2v"],
      },
    },
  },
}
```

HeyGen video-agent on fal can be pinned with:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "fal/fal-ai/heygen/v2/video-agent",
      },
    },
  },
}
```

Seedance 2.0 on fal can be pinned with:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "fal/bytedance/seedance-2.0/fast/text-to-video",
      },
    },
  },
}
```

## Provider notes

| Provider | Notes                                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alibaba  | Uses DashScope/Model Studio async endpoint. Reference images and videos must be remote `http(s)` URLs.                                                               |
| BytePlus | Single image reference only.                                                                                                                                         |
| ComfyUI  | Workflow-driven local or cloud execution. Supports text-to-video and image-to-video through the configured graph.                                                    |
| fal      | Uses queue-backed flow for long-running jobs. Single image reference only. Includes HeyGen video-agent and Seedance 2.0 text-to-video and image-to-video model refs. |
| Google   | Uses Gemini/Veo. Supports one image or one video reference.                                                                                                          |
| MiniMax  | Single image reference only.                                                                                                                                         |
| OpenAI   | Only `size` override is forwarded. Other style overrides (`aspectRatio`, `resolution`, `audio`, `watermark`) are ignored with a warning.                             |
| Qwen     | Same DashScope backend as Alibaba. Reference inputs must be remote `http(s)` URLs; local files are rejected upfront.                                                 |
| Runway   | Supports local files via data URIs. Video-to-video requires `runway/gen4_aleph`. Text-only runs expose `16:9` and `9:16` aspect ratios.                              |
| Together | Single image reference only.                                                                                                                                         |
| Vydra    | Uses `https://www.vydra.ai/api/v1` directly to avoid auth-dropping redirects. `veo3` is bundled as text-to-video only; `kling` requires a remote image URL.          |
| xAI      | Supports text-to-video, image-to-video, and remote video edit/extend flows.                                                                                          |

## Provider capability modes

The shared video-generation contract now lets providers declare mode-specific
capabilities instead of only flat aggregate limits. New provider
implementations should prefer explicit mode blocks:

```typescript
capabilities: {
  generate: {
    maxVideos: 1,
    maxDurationSeconds: 10,
    supportsResolution: true,
  },
  imageToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 1,
    maxDurationSeconds: 5,
  },
  videoToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputVideos: 1,
    maxDurationSeconds: 5,
  },
}
```

Flat aggregate fields such as `maxInputImages` and `maxInputVideos` are not
enough to advertise transform-mode support. Providers should declare
`generate`, `imageToVideo`, and `videoToVideo` explicitly so live tests,
contract tests, and the shared `video_generate` tool can validate mode support
deterministically.

## Live tests

Opt-in live coverage for the shared bundled providers:

```bash
OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/video-generation-providers.live.test.ts
```

Repo wrapper:

```bash
pnpm test:live:media video
```

This live file loads missing provider env vars from `~/.profile`, prefers
live/env API keys ahead of stored auth profiles by default, and runs the
declared modes it can exercise safely with local media:

- `generate` for every provider in the sweep
- `imageToVideo` when `capabilities.imageToVideo.enabled`
- `videoToVideo` when `capabilities.videoToVideo.enabled` and the provider/model
  accepts buffer-backed local video input in the shared sweep

Today the shared `videoToVideo` live lane covers:

- `runway` only when you select `runway/gen4_aleph`

## Configuration

Set the default video generation model in your OpenClaw config:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-r2v-flash"],
      },
    },
  },
}
```

Or via the CLI:

```bash
openclaw config set agents.defaults.videoGenerationModel.primary "qwen/wan2.6-t2v"
```

## Related

- [Tools Overview](/tools)
- [Background Tasks](/automation/tasks) -- task tracking for async video generation
- [Alibaba Model Studio](/providers/alibaba)
- [BytePlus](/concepts/model-providers#byteplus-international)
- [ComfyUI](/providers/comfy)
- [fal](/providers/fal)
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [OpenAI](/providers/openai)
- [Qwen](/providers/qwen)
- [Runway](/providers/runway)
- [Together AI](/providers/together)
- [Vydra](/providers/vydra)
- [xAI](/providers/xai)
- [Configuration Reference](/gateway/configuration-reference#agent-defaults)
- [Models](/concepts/models)
