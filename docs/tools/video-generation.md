---
summary: "Generate videos from text, images, or existing videos using 14 provider backends"
read_when:
  - Generating videos via the agent
  - Configuring video generation providers and models
  - Understanding the video_generate tool parameters
title: "Video Generation"
---

# Video Generation

OpenClaw agents can generate videos from text prompts, reference images, or existing videos. Fourteen provider backends are supported, each with different model options, input modes, and feature sets. The agent picks the right provider automatically based on your configuration and available API keys.

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

| Provider              | Default model                   | Text | Image ref                                            | Video ref        | API key                                  |
| --------------------- | ------------------------------- | ---- | ---------------------------------------------------- | ---------------- | ---------------------------------------- |
| Alibaba               | `wan2.6-t2v`                    | Yes  | Yes (remote URL)                                     | Yes (remote URL) | `MODELSTUDIO_API_KEY`                    |
| BytePlus (1.0)        | `seedance-1-0-pro-250528`       | Yes  | Up to 2 images (I2V models only; first + last frame) | No               | `BYTEPLUS_API_KEY`                       |
| BytePlus Seedance 1.5 | `seedance-1-5-pro-251215`       | Yes  | Up to 2 images (first + last frame via role)         | No               | `BYTEPLUS_API_KEY`                       |
| BytePlus Seedance 2.0 | `dreamina-seedance-2-0-260128`  | Yes  | Up to 9 reference images                             | Up to 3 videos   | `BYTEPLUS_API_KEY`                       |
| ComfyUI               | `workflow`                      | Yes  | 1 image                                              | No               | `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` |
| fal                   | `fal-ai/minimax/video-01-live`  | Yes  | 1 image                                              | No               | `FAL_KEY`                                |
| Google                | `veo-3.1-fast-generate-preview` | Yes  | 1 image                                              | 1 video          | `GEMINI_API_KEY`                         |
| MiniMax               | `MiniMax-Hailuo-2.3`            | Yes  | 1 image                                              | No               | `MINIMAX_API_KEY`                        |
| OpenAI                | `sora-2`                        | Yes  | 1 image                                              | 1 video          | `OPENAI_API_KEY`                         |
| Qwen                  | `wan2.6-t2v`                    | Yes  | Yes (remote URL)                                     | Yes (remote URL) | `QWEN_API_KEY`                           |
| Runway                | `gen4.5`                        | Yes  | 1 image                                              | 1 video          | `RUNWAYML_API_SECRET`                    |
| Together              | `Wan-AI/Wan2.2-T2V-A14B`        | Yes  | 1 image                                              | No               | `TOGETHER_API_KEY`                       |
| Vydra                 | `veo3`                          | Yes  | 1 image (`kling`)                                    | No               | `VYDRA_API_KEY`                          |
| xAI                   | `grok-imagine-video`            | Yes  | 1 image                                              | 1 video          | `XAI_API_KEY`                            |

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

| Parameter    | Type     | Description                                                                                                                            |
| ------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `image`      | string   | Single reference image (path or URL)                                                                                                   |
| `images`     | string[] | Multiple reference images (up to 9)                                                                                                    |
| `imageRoles` | string[] | Optional per-position role hints parallel to the combined image list. Canonical values: `first_frame`, `last_frame`, `reference_image` |
| `video`      | string   | Single reference video (path or URL)                                                                                                   |
| `videos`     | string[] | Multiple reference videos (up to 4)                                                                                                    |
| `videoRoles` | string[] | Optional per-position role hints parallel to the combined video list. Canonical value: `reference_video`                               |
| `audioRef`   | string   | Single reference audio (path or URL). Used for e.g. background music or voice reference when the provider supports audio inputs        |
| `audioRefs`  | string[] | Multiple reference audios (up to 3)                                                                                                    |
| `audioRoles` | string[] | Optional per-position role hints parallel to the combined audio list. Canonical value: `reference_audio`                               |

Role hints are forwarded to the provider as-is. Canonical values come from
the `VideoGenerationAssetRole` union but providers may accept additional
role strings. `*Roles` arrays must not have more entries than the
corresponding reference list; off-by-one mistakes fail with a clear error.
Use an empty string to leave a slot unset.

### Style controls

| Parameter         | Type    | Description                                                                             |
| ----------------- | ------- | --------------------------------------------------------------------------------------- |
| `aspectRatio`     | string  | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, or `adaptive`  |
| `resolution`      | string  | `480P`, `720P`, `768P`, or `1080P`                                                      |
| `durationSeconds` | number  | Target duration in seconds (rounded to nearest provider-supported value)                |
| `size`            | string  | Size hint when the provider supports it                                                 |
| `audio`           | boolean | Enable generated audio in the output when supported. Distinct from `audioRef*` (inputs) |
| `watermark`       | boolean | Toggle provider watermarking when supported                                             |

`adaptive` is a provider-specific sentinel: it is forwarded as-is to
providers that declare `adaptive` in their capabilities (e.g. BytePlus
Seedance uses it to auto-detect the ratio from the input image
dimensions). Providers that do not declare it surface the value via
`details.ignoredOverrides` in the tool result so the drop is visible.

### Advanced

| Parameter         | Type   | Description                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`          | string | `"generate"` (default), `"status"`, or `"list"`                                                                                                                                                                                                                                                                                                      |
| `model`           | string | Provider/model override (e.g. `runway/gen4.5`)                                                                                                                                                                                                                                                                                                       |
| `filename`        | string | Output filename hint                                                                                                                                                                                                                                                                                                                                 |
| `providerOptions` | object | Provider-specific options as a JSON object (e.g. `{"seed": 42, "draft": true}`). Providers that declare a typed schema validate the keys and types; unknown keys or mismatches skip the candidate during fallback. Providers without a declared schema receive the options as-is. Run `video_generate action=list` to see what each provider accepts |

Not all providers support all parameters. OpenClaw already normalizes duration to the closest provider-supported value, and it also remaps translated geometry hints such as size-to-aspect-ratio when a fallback provider exposes a different control surface. Truly unsupported overrides are ignored on a best-effort basis and reported as warnings in the tool result. Hard capability limits (such as too many reference inputs) fail before submission.

Tool results report the applied settings. When OpenClaw remaps duration or geometry during provider fallback, the returned `durationSeconds`, `size`, `aspectRatio`, and `resolution` values reflect what was submitted, and `details.normalization` captures the requested-to-applied translation.

Reference inputs also select the runtime mode:

- No reference media: `generate`
- Any image reference: `imageToVideo`
- Any video reference: `videoToVideo`
- Reference audio inputs do not change the resolved mode; they apply on top of whatever mode the image/video references select, and only work with providers that declare `maxInputAudios`

Mixed image and video references are not a stable shared capability surface.
Prefer one reference type per request.

#### Fallback and typed options

Some capability checks are applied at the fallback layer rather than the
tool boundary so that a request that exceeds the primary provider's limits
can still run on a capable fallback:

- If the active candidate declares no `maxInputAudios` (or declares it as
  `0`), it is skipped when the request contains audio references, and the
  next candidate is tried.
- If the active candidate's `maxDurationSeconds` is below the requested
  `durationSeconds` and the candidate does not declare a
  `supportedDurationSeconds` list, it is skipped.
- If the request contains `providerOptions` and the active candidate
  explicitly declares a typed `providerOptions` schema, the candidate is
  skipped when the supplied keys are not in the schema or the value types do
  not match. Providers that have not yet declared a schema receive the
  options as-is (backward-compatible pass-through). A provider can
  explicitly opt out of all provider options by declaring an empty schema
  (`capabilities.providerOptions: {}`), which causes the same skip as a
  type mismatch.

The first skip reason in a request is logged at `warn` so operators see
when their primary provider was passed over; subsequent skips log at
`debug` to keep long fallback chains quiet. If every candidate is skipped,
the aggregated error includes the skip reason for each.

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

## Provider notes

| Provider              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alibaba               | Uses DashScope/Model Studio async endpoint. Reference images and videos must be remote `http(s)` URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| BytePlus (1.0)        | Provider id `byteplus`. Models: `seedance-1-0-pro-250528` (default), `seedance-1-0-pro-t2v-250528`, `seedance-1-0-pro-fast-251015`, `seedance-1-0-lite-t2v-250428`, `seedance-1-0-lite-i2v-250428`. T2V models (`*-t2v-*`) do not accept image inputs; I2V models and general `*-pro-*` models support a single reference image (first frame). Pass the image positionally or set `role: "first_frame"`. T2V model IDs are automatically switched to the corresponding I2V variant when an image is provided. Supported `providerOptions` keys: `seed` (number), `draft` (boolean, forces 480p), `camera_fixed` (boolean).                                                                       |
| BytePlus Seedance 1.5 | Requires the [`@openclaw/byteplus-modelark`](https://www.npmjs.com/package/@openclaw/byteplus-modelark) plugin. Provider id `byteplus-seedance15`. Model: `seedance-1-5-pro-251215`. Uses the unified `content[]` API. Supports at most 2 input images (first_frame + last_frame). All inputs must be remote `https://` URLs. Set `role: "first_frame"` / `"last_frame"` on each image, or pass images positionally. `aspectRatio: "adaptive"` auto-detects ratio from the input image. `audio: true` maps to `generate_audio`. `providerOptions.seed` (number) is forwarded.                                                                                                                    |
| BytePlus Seedance 2.0 | Requires the [`@openclaw/byteplus-modelark`](https://www.npmjs.com/package/@openclaw/byteplus-modelark) plugin. Provider id `byteplus-seedance2`. Models: `dreamina-seedance-2-0-260128`, `dreamina-seedance-2-0-fast-260128`. Uses the unified `content[]` API. Supports up to 9 reference images, 3 reference videos, and 3 reference audios. All inputs must be remote `https://` URLs. Set `role` on each asset — supported values: `"first_frame"`, `"last_frame"`, `"reference_image"`, `"reference_video"`, `"reference_audio"`. `aspectRatio: "adaptive"` auto-detects ratio from the input image. `audio: true` maps to `generate_audio`. `providerOptions.seed` (number) is forwarded. |
| ComfyUI               | Workflow-driven local or cloud execution. Supports text-to-video and image-to-video through the configured graph.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| fal                   | Uses queue-backed flow for long-running jobs. Single image reference only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Google                | Uses Gemini/Veo. Supports one image or one video reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| MiniMax               | Single image reference only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OpenAI                | Only `size` override is forwarded. Other style overrides (`aspectRatio`, `resolution`, `audio`, `watermark`) are ignored with a warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Qwen                  | Same DashScope backend as Alibaba. Reference inputs must be remote `http(s)` URLs; local files are rejected upfront.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runway                | Supports local files via data URIs. Video-to-video requires `runway/gen4_aleph`. Text-only runs expose `16:9` and `9:16` aspect ratios.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Together              | Single image reference only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Vydra                 | Uses `https://www.vydra.ai/api/v1` directly to avoid auth-dropping redirects. `veo3` is bundled as text-to-video only; `kling` requires a remote image URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| xAI                   | Supports text-to-video, image-to-video, and remote video edit/extend flows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
live/env API keys ahead of stored auth profiles by default, and runs a
release-safe smoke by default:

- `generate` for every non-FAL provider in the sweep
- one-second lobster prompt
- per-provider operation cap from `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS`
  (`180000` by default)

FAL is opt-in because provider-side queue latency can dominate release time:

```bash
pnpm test:live:media video --video-providers fal
```

Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` to also run declared transform
modes the shared sweep can exercise safely with local media:

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
