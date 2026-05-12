---
summary: "Generate videos via video_generate from text, image, or video references across 16 provider backends"
read_when:
  - Generating videos via the agent
  - Configuring video-generation providers and models
  - Understanding the video_generate tool parameters
title: "Video generation"
sidebarTitle: "Video generation"
---

OpenClaw agents can generate videos from text prompts, reference images, or
existing videos. Sixteen provider backends are supported, each with
different model options, input modes, and feature sets. The agent picks the
right provider automatically based on your configuration and available API
keys.

<Note>
The `video_generate` tool only appears when at least one video-generation
provider is available. If you do not see it in your agent tools, set a
provider API key or configure `agents.defaults.videoGenerationModel`.
</Note>

OpenClaw treats video generation as three runtime modes:

- `generate` - text-to-video requests with no reference media.
- `imageToVideo` - request includes one or more reference images.
- `videoToVideo` - request includes one or more reference videos.

Providers can support any subset of those modes. The tool validates the
active mode before submission and reports supported modes in `action=list`.

## Quick start

<Steps>
  <Step title="Configure auth">
    Set an API key for any supported provider:

    ```bash
    export GEMINI_API_KEY="your-key"
    ```

  </Step>
  <Step title="Pick a default model (optional)">
    ```bash
    openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
    ```
  </Step>
  <Step title="Ask the agent">
    > Generate a 5-second cinematic video of a friendly lobster surfing at sunset.

    The agent calls `video_generate` automatically. No tool allowlisting
    is needed.

  </Step>
</Steps>

## How async generation works

Video generation is asynchronous. When the agent calls `video_generate` in a
session:

1. OpenClaw submits the request to the provider and immediately returns a task id.
2. The provider processes the job in the background (typically 30 seconds to several minutes depending on the provider and resolution; slow queue-backed providers can run up to the configured timeout).
3. When the video is ready, OpenClaw wakes the same session with an internal completion event.
4. The agent tells the user and attaches the finished video. In group/channel
   chats that use message-tool-only visible delivery, the agent relays the
   result through the message tool instead of OpenClaw posting it directly.

While a job is in flight, duplicate `video_generate` calls in the same
session return the current task status instead of starting another
generation. Use `openclaw tasks list` or `openclaw tasks show <taskId>` to
check progress from the CLI.

Outside of session-backed agent runs (for example, direct tool invocations),
the tool falls back to inline generation and returns the final media path
in the same turn.

Generated video files are saved under OpenClaw-managed media storage when
the provider returns bytes. The default generated-video save cap follows
the video media limit, and `agents.defaults.mediaMaxMb` raises it for
larger renders. When a provider also returns a hosted output URL, OpenClaw
can deliver that URL instead of failing the task if local persistence
rejects an oversized file.

### Task lifecycle

| State       | Meaning                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `queued`    | Task created, waiting for the provider to accept it.                                                   |
| `running`   | Provider is processing (typically 30 seconds to several minutes depending on provider and resolution). |
| `succeeded` | Video ready; the agent wakes and posts it to the conversation.                                         |
| `failed`    | Provider error or timeout; the agent wakes with error details.                                         |

Check status from the CLI:

```bash
openclaw tasks list
openclaw tasks show <taskId>
openclaw tasks cancel <taskId>
```

If a video task is already `queued` or `running` for the current session,
`video_generate` returns the existing task status instead of starting a new
one. Use `action: "status"` to check explicitly without triggering a new
generation.

## Supported providers

| Provider              | Default model                   | Text | Image ref                                            | Video ref                                       | Auth                                     |
| --------------------- | ------------------------------- | :--: | ---------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Alibaba               | `wan2.6-t2v`                    |  ✓   | Yes (remote URL)                                     | Yes (remote URL)                                | `MODELSTUDIO_API_KEY`                    |
| BytePlus (1.0)        | `seedance-1-0-pro-250528`       |  ✓   | Up to 2 images (I2V models only; first + last frame) | -                                               | `BYTEPLUS_API_KEY`                       |
| BytePlus Seedance 1.5 | `seedance-1-5-pro-251215`       |  ✓   | Up to 2 images (first + last frame via role)         | -                                               | `BYTEPLUS_API_KEY`                       |
| BytePlus Seedance 2.0 | `dreamina-seedance-2-0-260128`  |  ✓   | Up to 9 reference images                             | Up to 3 videos                                  | `BYTEPLUS_API_KEY`                       |
| ComfyUI               | `workflow`                      |  ✓   | 1 image                                              | -                                               | `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY` |
| DeepInfra             | `Pixverse/Pixverse-T2V`         |  ✓   | -                                                    | -                                               | `DEEPINFRA_API_KEY`                      |
| fal                   | `fal-ai/minimax/video-01-live`  |  ✓   | 1 image; up to 9 with Seedance reference-to-video    | Up to 3 videos with Seedance reference-to-video | `FAL_KEY`                                |
| Google                | `veo-3.1-fast-generate-preview` |  ✓   | 1 image                                              | 1 video                                         | `GEMINI_API_KEY`                         |
| MiniMax               | `MiniMax-Hailuo-2.3`            |  ✓   | 1 image                                              | -                                               | `MINIMAX_API_KEY` or MiniMax OAuth       |
| OpenAI                | `sora-2`                        |  ✓   | 1 image                                              | 1 video                                         | `OPENAI_API_KEY`                         |
| OpenRouter            | `google/veo-3.1-fast`           |  ✓   | Up to 4 images (first/last frame or references)      | -                                               | `OPENROUTER_API_KEY`                     |
| Qwen                  | `wan2.6-t2v`                    |  ✓   | Yes (remote URL)                                     | Yes (remote URL)                                | `QWEN_API_KEY`                           |
| Runway                | `gen4.5`                        |  ✓   | 1 image                                              | 1 video                                         | `RUNWAYML_API_SECRET`                    |
| Together              | `Wan-AI/Wan2.2-T2V-A14B`        |  ✓   | 1 image                                              | -                                               | `TOGETHER_API_KEY`                       |
| Vydra                 | `veo3`                          |  ✓   | 1 image (`kling`)                                    | -                                               | `VYDRA_API_KEY`                          |
| xAI                   | `grok-imagine-video`            |  ✓   | 1 first-frame image or up to 7 `reference_image`s    | 1 video                                         | `XAI_API_KEY`                            |

Some providers accept additional or alternate API key env vars. See
individual [provider pages](#related) for details.

Run `video_generate action=list` to inspect available providers, models, and
runtime modes at runtime.

### Capability matrix

The explicit mode contract used by `video_generate`, contract tests, and
the shared live sweep:

| Provider   | `generate` | `imageToVideo` | `videoToVideo` | Shared live lanes today                                                                                                                  |
| ---------- | :--------: | :------------: | :------------: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Alibaba    |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; `videoToVideo` skipped because this provider needs remote `http(s)` video URLs                               |
| BytePlus   |     ✓      |       ✓        |       -        | `generate`, `imageToVideo`                                                                                                               |
| ComfyUI    |     ✓      |       ✓        |       -        | Not in the shared sweep; workflow-specific coverage lives with Comfy tests                                                               |
| DeepInfra  |     ✓      |       -        |       -        | `generate`; native DeepInfra video schemas are text-to-video in the bundled contract                                                     |
| fal        |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; `videoToVideo` only when using Seedance reference-to-video                                                   |
| Google     |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; shared `videoToVideo` skipped because the current buffer-backed Gemini/Veo sweep does not accept that input  |
| MiniMax    |     ✓      |       ✓        |       -        | `generate`, `imageToVideo`                                                                                                               |
| OpenAI     |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; shared `videoToVideo` skipped because this org/input path currently needs provider-side inpaint/remix access |
| OpenRouter |     ✓      |       ✓        |       -        | `generate`, `imageToVideo`                                                                                                               |
| Qwen       |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; `videoToVideo` skipped because this provider needs remote `http(s)` video URLs                               |
| Runway     |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; `videoToVideo` runs only when the selected model is `runway/gen4_aleph`                                      |
| Together   |     ✓      |       ✓        |       -        | `generate`, `imageToVideo`                                                                                                               |
| Vydra      |     ✓      |       ✓        |       -        | `generate`; shared `imageToVideo` skipped because bundled `veo3` is text-only and bundled `kling` requires a remote image URL            |
| xAI        |     ✓      |       ✓        |       ✓        | `generate`, `imageToVideo`; `videoToVideo` skipped because this provider currently needs a remote MP4 URL                                |

## Tool parameters

### Required

<ParamField path="prompt" type="string" required>
  Text description of the video to generate. Required for `action: "generate"`.
</ParamField>

### Content inputs

<ParamField path="image" type="string">Single reference image (path or URL).</ParamField>
<ParamField path="images" type="string[]">Multiple reference images (up to 9).</ParamField>
<ParamField path="imageRoles" type="string[]">
Optional per-position role hints parallel to the combined image list.
Canonical values: `first_frame`, `last_frame`, `reference_image`.
</ParamField>
<ParamField path="video" type="string">Single reference video (path or URL).</ParamField>
<ParamField path="videos" type="string[]">Multiple reference videos (up to 4).</ParamField>
<ParamField path="videoRoles" type="string[]">
Optional per-position role hints parallel to the combined video list.
Canonical value: `reference_video`.
</ParamField>
<ParamField path="audioRef" type="string">
Single reference audio (path or URL). Used for background music or voice
reference when the provider supports audio inputs.
</ParamField>
<ParamField path="audioRefs" type="string[]">Multiple reference audios (up to 3).</ParamField>
<ParamField path="audioRoles" type="string[]">
Optional per-position role hints parallel to the combined audio list.
Canonical value: `reference_audio`.
</ParamField>

<Note>
Role hints are forwarded to the provider as-is. Canonical values come from
the `VideoGenerationAssetRole` union but providers may accept additional
role strings. `*Roles` arrays must not have more entries than the
corresponding reference list; off-by-one mistakes fail with a clear error.
Use an empty string to leave a slot unset. For xAI, set every image role to
`reference_image` to use its `reference_images` generation mode; omit the
role or use `first_frame` for single-image image-to-video.
</Note>

### Style controls

<ParamField path="aspectRatio" type="string">
  Aspect-ratio hint such as `1:1`, `16:9`, `9:16`, `adaptive`, or a provider-specific value. OpenClaw normalizes or ignores unsupported values per provider.
</ParamField>
<ParamField path="resolution" type="string">Resolution hint such as `480P`, `720P`, `768P`, `1080P`, `4K`, or a provider-specific value. OpenClaw normalizes or ignores unsupported values per provider.</ParamField>
<ParamField path="durationSeconds" type="number">
  Target duration in seconds (rounded to nearest provider-supported value).
</ParamField>
<ParamField path="size" type="string">Size hint when the provider supports it.</ParamField>
<ParamField path="audio" type="boolean">
  Enable generated audio in the output when supported. Distinct from `audioRef*` (inputs).
</ParamField>
<ParamField path="watermark" type="boolean">Toggle provider watermarking when supported.</ParamField>

`adaptive` is a provider-specific sentinel: it is forwarded as-is to
providers that declare `adaptive` in their capabilities (e.g. BytePlus
Seedance uses it to auto-detect the ratio from the input image
dimensions). Providers that do not declare it surface the value via
`details.ignoredOverrides` in the tool result so the drop is visible.

### Advanced

<ParamField path="action" type='"generate" | "status" | "list"' default="generate">
  `"status"` returns the current session task; `"list"` inspects providers.
</ParamField>
<ParamField path="model" type="string">Provider/model override (e.g. `runway/gen4.5`).</ParamField>
<ParamField path="filename" type="string">Output filename hint.</ParamField>
<ParamField path="timeoutMs" type="number">Optional provider operation timeout in milliseconds. When omitted, OpenClaw uses `agents.defaults.videoGenerationModel.timeoutMs` if configured.</ParamField>
<ParamField path="providerOptions" type="object">
  Provider-specific options as a JSON object (e.g. `{"seed": 42, "draft": true}`).
  Providers that declare a typed schema validate the keys and types; unknown
  keys or mismatches skip the candidate during fallback. Providers without a
  declared schema receive the options as-is. Run `video_generate action=list`
  to see what each provider accepts.
</ParamField>

<Note>
Not all providers support all parameters. OpenClaw normalizes duration to
the closest provider-supported value, and remaps translated geometry hints
such as size-to-aspect-ratio when a fallback provider exposes a different
control surface. Truly unsupported overrides are ignored on a best-effort
basis and reported as warnings in the tool result. Hard capability limits
(such as too many reference inputs) fail before submission. Tool results
report applied settings; `details.normalization` captures any
requested-to-applied translation.
</Note>

Reference inputs select the runtime mode:

- No reference media → `generate`
- Any image reference → `imageToVideo`
- Any video reference → `videoToVideo`
- Reference audio inputs **do not** change the resolved mode; they apply on
  top of whatever mode the image/video references select, and only work
  with providers that declare `maxInputAudios`.

Mixed image and video references are not a stable shared capability surface.
Prefer one reference type per request.

#### Fallback and typed options

Some capability checks are applied at the fallback layer rather than the
tool boundary, so a request that exceeds the primary provider's limits can
still run on a capable fallback:

- Active candidate declaring no `maxInputAudios` (or `0`) is skipped when
  the request contains audio references; next candidate is tried.
- Active candidate's `maxDurationSeconds` below the requested `durationSeconds`
  with no declared `supportedDurationSeconds` list → skipped.
- Request contains `providerOptions` and the active candidate explicitly
  declares a typed `providerOptions` schema → skipped if supplied keys are
  not in the schema or value types do not match. Providers without a
  declared schema receive options as-is (backward-compatible
  pass-through). A provider can opt out of all provider options by
  declaring an empty schema (`capabilities.providerOptions: {}`), which
  causes the same skip as a type mismatch.

The first skip reason in a request logs at `warn` so operators see when
their primary provider was passed over; subsequent skips log at `debug` to
keep long fallback chains quiet. If every candidate is skipped, the
aggregated error includes the skip reason for each.

## Actions

| Action     | What it does                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `generate` | Default. Create a video from the given prompt and optional reference inputs.                             |
| `status`   | Check the state of the in-flight video task for the current session without starting another generation. |
| `list`     | Show available providers, models, and their capabilities.                                                |

## Model selection

OpenClaw resolves the model in this order:

1. **`model` tool parameter** - if the agent specifies one in the call.
2. **`videoGenerationModel.primary`** from config.
3. **`videoGenerationModel.fallbacks`** in order.
4. **Auto-detection** - providers that have valid auth, starting with the
   current default provider, then remaining providers in alphabetical
   order.

If a provider fails, the next candidate is tried automatically. If all
candidates fail, the error includes details from each attempt.

Set `agents.defaults.mediaGenerationAutoProviderFallback: false` to use
only the explicit `model`, `primary`, and `fallbacks` entries.

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

<AccordionGroup>
  <Accordion title="Alibaba">
    Uses DashScope / Model Studio async endpoint. Reference images and
    videos must be remote `http(s)` URLs.
  </Accordion>
  <Accordion title="BytePlus (1.0)">
    Provider id: `byteplus`.

    Models: `seedance-1-0-pro-250528` (default),
    `seedance-1-0-pro-t2v-250528`, `seedance-1-0-pro-fast-251015`,
    `seedance-1-0-lite-t2v-250428`, `seedance-1-0-lite-i2v-250428`.

    T2V models (`*-t2v-*`) do not accept image inputs; I2V models and
    general `*-pro-*` models support a single reference image (first
    frame). Pass the image positionally or set `role: "first_frame"`.
    T2V model IDs are automatically switched to the corresponding I2V
    variant when an image is provided.

    Supported `providerOptions` keys: `seed` (number), `draft` (boolean -
    forces 480p), `camera_fixed` (boolean).

  </Accordion>
  <Accordion title="BytePlus Seedance 1.5">
    Requires the [`@openclaw/byteplus-modelark`](https://www.npmjs.com/package/@openclaw/byteplus-modelark)
    plugin. Provider id: `byteplus-seedance15`. Model:
    `seedance-1-5-pro-251215`.

    Uses the unified `content[]` API. Supports at most 2 input images
    (`first_frame` + `last_frame`). All inputs must be remote `https://`
    URLs. Set `role: "first_frame"` / `"last_frame"` on each image, or
    pass images positionally.

    `aspectRatio: "adaptive"` auto-detects ratio from the input image.
    `audio: true` maps to `generate_audio`. `providerOptions.seed`
    (number) is forwarded.

  </Accordion>
  <Accordion title="BytePlus Seedance 2.0">
    Requires the [`@openclaw/byteplus-modelark`](https://www.npmjs.com/package/@openclaw/byteplus-modelark)
    plugin. Provider id: `byteplus-seedance2`. Models:
    `dreamina-seedance-2-0-260128`,
    `dreamina-seedance-2-0-fast-260128`.

    Uses the unified `content[]` API. Supports up to 9 reference images,
    3 reference videos, and 3 reference audios. All inputs must be remote
    `https://` URLs. Set `role` on each asset - supported values:
    `"first_frame"`, `"last_frame"`, `"reference_image"`,
    `"reference_video"`, `"reference_audio"`.

    `aspectRatio: "adaptive"` auto-detects ratio from the input image.
    `audio: true` maps to `generate_audio`. `providerOptions.seed`
    (number) is forwarded.

  </Accordion>
  <Accordion title="ComfyUI">
    Workflow-driven local or cloud execution. Supports text-to-video and
    image-to-video through the configured graph.
  </Accordion>
  <Accordion title="fal">
    Uses a queue-backed flow for long-running jobs. OpenClaw waits up to 20
    minutes by default before treating an in-progress fal queue job as timed
    out. Most fal video models
    accept a single image reference. Seedance 2.0 reference-to-video
    models accept up to 9 images, 3 videos, and 3 audio references, with
    at most 12 total reference files.
  </Accordion>
  <Accordion title="Google (Gemini / Veo)">
    Supports one image or one video reference. Generated-audio requests are
    ignored with a warning on the Gemini API path because that API rejects
    the `generateAudio` parameter for current Veo video generation.
  </Accordion>
  <Accordion title="MiniMax">
    Single image reference only. MiniMax accepts `768P` and `1080P`
    resolutions; requests such as `720P` are normalized to the closest
    supported value before submission.
  </Accordion>
  <Accordion title="OpenAI">
    Only `size` override is forwarded. Other style overrides
    (`aspectRatio`, `resolution`, `audio`, `watermark`) are ignored with
    a warning.
  </Accordion>
  <Accordion title="OpenRouter">
    Uses OpenRouter's asynchronous `/videos` API. OpenClaw submits the
    job, polls `polling_url`, and downloads either `unsigned_urls` or the
    documented job content endpoint. The bundled `google/veo-3.1-fast` default
    advertises 4/6/8 second durations, `720P`/`1080P` resolutions, and
    `16:9`/`9:16` aspect ratios.
  </Accordion>
  <Accordion title="Qwen">
    Same DashScope backend as Alibaba. Reference inputs must be remote
    `http(s)` URLs; local files are rejected upfront.
  </Accordion>
  <Accordion title="Runway">
    Supports local files via data URIs. Video-to-video requires
    `runway/gen4_aleph`. Text-only runs expose `16:9` and `9:16` aspect
    ratios.
  </Accordion>
  <Accordion title="Together">
    Single image reference only.
  </Accordion>
  <Accordion title="Vydra">
    Uses `https://www.vydra.ai/api/v1` directly to avoid auth-dropping
    redirects. `veo3` is bundled as text-to-video only; `kling` requires
    a remote image URL.
  </Accordion>
  <Accordion title="xAI">
    Supports text-to-video, single first-frame image-to-video, up to 7
    `reference_image` inputs through xAI `reference_images`, and remote
    video edit/extend flows.
  </Accordion>
</AccordionGroup>

## Provider capability modes

The shared video-generation contract supports mode-specific capabilities
instead of only flat aggregate limits. New provider implementations
should prefer explicit mode blocks:

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
    maxInputImagesByModel: { "provider/reference-to-video": 9 },
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

Flat aggregate fields such as `maxInputImages` and `maxInputVideos` are
**not** enough to advertise transform-mode support. Providers should
declare `generate`, `imageToVideo`, and `videoToVideo` explicitly so live
tests, contract tests, and the shared `video_generate` tool can validate
mode support deterministically.

When one model in a provider has wider reference-input support than the
rest, use `maxInputImagesByModel`, `maxInputVideosByModel`, or
`maxInputAudiosByModel` instead of raising the mode-wide limit.

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

- `generate` for every non-FAL provider in the sweep.
- One-second lobster prompt.
- Per-provider operation cap from
  `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS` (`180000` by default).

FAL is opt-in because provider-side queue latency can dominate release
time:

```bash
pnpm test:live:media video --video-providers fal
```

Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` to also run declared
transform modes the shared sweep can exercise safely with local media:

- `imageToVideo` when `capabilities.imageToVideo.enabled`.
- `videoToVideo` when `capabilities.videoToVideo.enabled` and the
  provider/model accepts buffer-backed local video input in the shared
  sweep.

Today the shared `videoToVideo` live lane covers `runway` only when you
select `runway/gen4_aleph`.

## Configuration

Set the default video-generation model in your OpenClaw config:

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

- [Alibaba Model Studio](/providers/alibaba)
- [Background tasks](/automation/tasks) - task tracking for async video generation
- [BytePlus](/concepts/model-providers#byteplus-international)
- [ComfyUI](/providers/comfy)
- [Configuration reference](/gateway/config-agents#agent-defaults)
- [fal](/providers/fal)
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [Models](/concepts/models)
- [OpenAI](/providers/openai)
- [Qwen](/providers/qwen)
- [Runway](/providers/runway)
- [Together AI](/providers/together)
- [Tools overview](/tools)
- [Vydra](/providers/vydra)
- [xAI](/providers/xai)
