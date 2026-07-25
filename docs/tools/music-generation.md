---
summary: "Generate music via music_generate across ComfyUI, fal, Google Lyria, MiniMax, and OpenRouter workflows"
read_when:
  - Generating music or audio via the agent
  - Configuring music-generation providers and models
  - Understanding the music_generate tool parameters
title: "Music generation"
sidebarTitle: "Music generation"
---

The `music_generate` tool creates music or audio through the shared
music-generation capability, backed by ComfyUI, fal, Google, MiniMax, and
OpenRouter.

<Note>
`music_generate` only appears when at least one music-generation provider is
available: an explicit `agents.defaults.mediaModels.music` config, or an
auth-configured provider (a set API key, for example).
</Note>

For session-backed agent runs, `music_generate` starts as a background task,
tracks progress in the task ledger, then wakes the agent when the track is
ready so it can tell the user and attach the finished audio. The completion
agent follows the session's visible-reply contract: automatic final reply
when configured, or `message(action="send")` when the session requires the
message tool. If the requester session is inactive or its wake fails and
generated audio is still missing from the reply, OpenClaw sends an
idempotent direct fallback with just the missing audio.

## Quick start

<Tabs>
  <Tab title="Shared provider-backed">
    <Steps>
      <Step title="Configure auth">
        Set an API key for at least one provider — for example
        `GEMINI_API_KEY` or `MINIMAX_API_KEY`.
      </Step>
      <Step title="Pick a default model (optional)">
        ```json5
        {
          agents: {
            defaults: {
              musicGenerationModel: {
                primary: "google/lyria-3-clip-preview",
              },
            },
          },
        }
        ```
      </Step>
      <Step title="Ask the agent">
        _"Generate an upbeat synthpop track about a night drive through a
        neon city."_

        The agent calls `music_generate` automatically. No tool
        allow-listing needed.
      </Step>
    </Steps>

    Without a session-backed agent run (direct/local contexts), the tool
    runs inline and returns the final media path in the same tool result.

  </Tab>
  <Tab title="ComfyUI workflow">
    <Steps>
      <Step title="Configure the workflow">
        Configure `plugins.entries.comfy.config.music` with a workflow
        JSON and prompt/output nodes.
      </Step>
      <Step title="Cloud auth (optional)">
        For Comfy Cloud, set `COMFY_API_KEY` or `COMFY_CLOUD_API_KEY`.
      </Step>
      <Step title="Call the tool">
        ```text
        /tool music_generate prompt="Warm ambient synth loop with soft tape texture"
        ```
      </Step>
    </Steps>
  </Tab>
</Tabs>

Example prompts:

```text
Generate a cinematic piano track with soft strings and no vocals.
```

```text
Generate an energetic chiptune loop about launching a rocket at sunrise.
```

Use `action: "list"` to inspect available providers/models, and
`action: "status"` to inspect the active session-backed music task:

```text
/tool music_generate action=list
/tool music_generate action=status
```

Direct generation example:

```text
/tool music_generate prompt="Dreamy lo-fi hip hop with vinyl texture and gentle rain" instrumental=true
```

## Supported providers

| Provider   | Default model                | Reference inputs | Supported controls                                    | Auth                                   |
| ---------- | ---------------------------- | ---------------- | ----------------------------------------------------- | -------------------------------------- |
| ComfyUI    | `workflow`                   | Up to 1 image    | Workflow-defined music or audio                       | `COMFY_API_KEY`, `COMFY_CLOUD_API_KEY` |
| fal        | `fal-ai/minimax-music/v2.6`  | None             | `lyrics`, `instrumental`, `durationSeconds`, `format` | `FAL_KEY` or `FAL_API_KEY`             |
| Google     | `lyria-3-clip-preview`       | Up to 10 images  | `lyrics`, `instrumental`, `format`                    | `GEMINI_API_KEY`, `GOOGLE_API_KEY`     |
| MiniMax    | `music-2.6`                  | None             | `lyrics`, `instrumental`, `format` (mp3 only)         | `MINIMAX_API_KEY` or MiniMax OAuth     |
| OpenRouter | `google/lyria-3-pro-preview` | Up to 1 image    | `lyrics`, `instrumental`, `durationSeconds`, `format` | `OPENROUTER_API_KEY`                   |

MiniMax registers two provider ids sharing the same models: `minimax` for
API-key auth and `minimax-portal` for OAuth. Model refs follow the auth path
(`minimax/music-2.6` vs `minimax-portal/music-2.6`); see
[MiniMax](/providers/minimax#music-generation).

fal also exposes `fal-ai/ace-step/prompt-to-audio` (wav, no lyrics, no
instrumental toggle) and `fal-ai/stable-audio-25/text-to-audio` (wav,
prompt-only) alongside its default MiniMax-backed model. Google's default
`lyria-3-clip-preview` outputs mp3 only; `lyria-3-pro-preview` also supports
wav. MiniMax also exposes `music-2.6-free`, `music-cover`, and
`music-cover-free`. OpenRouter also exposes `google/lyria-3-clip-preview`.

### Capability matrix

The explicit mode contract used by `music_generate`, contract tests, and the
shared live sweep:

| Provider   | `generate` | `edit` | Edit limit | Shared live lanes                                                         |
| ---------- | :--------: | :----: | ---------- | ------------------------------------------------------------------------- |
| ComfyUI    |     ✓      |   ✓    | 1 image    | Not in the shared sweep; covered by `extensions/comfy/comfy.live.test.ts` |
| fal        |     ✓      |   —    | None       | `generate`                                                                |
| Google     |     ✓      |   ✓    | 10 images  | `generate`, `edit`                                                        |
| MiniMax    |     ✓      |   —    | None       | `generate`                                                                |
| OpenRouter |     ✓      |   ✓    | 1 image    | `generate`, `edit`                                                        |

## Tool parameters

<ParamField path="prompt" type="string" required>
  Music generation prompt. Required for `action: "generate"`.
</ParamField>
<ParamField path="action" type='"generate" | "status" | "list"' default="generate">
  `"status"` returns the current session task; `"list"` inspects providers.
</ParamField>
<ParamField path="model" type="string">
  Provider/model override (e.g. `google/lyria-3-pro-preview`,
  `comfy/workflow`).
</ParamField>
<ParamField path="lyrics" type="string">
  Optional lyrics when the provider supports explicit lyric input.
</ParamField>
<ParamField path="instrumental" type="boolean">
  Request instrumental-only output when the provider supports it.
</ParamField>
<ParamField path="image" type="string">
  Single reference image path or URL.
</ParamField>
<ParamField path="images" type="string[]">
  Multiple reference images (up to 10 on supporting providers).
</ParamField>
<ParamField path="durationSeconds" type="number">
  Target duration in seconds when the provider supports duration hints.
</ParamField>
<ParamField path="format" type='"mp3" | "wav"'>
  Output format hint when the provider supports it.
</ParamField>
<ParamField path="filename" type="string">Output filename hint.</ParamField>

<Note>
Not all providers support all parameters. OpenClaw still validates hard
limits such as input counts before submission. When a provider supports
duration but uses a shorter maximum than the requested value, OpenClaw
clamps to the closest supported duration. Truly unsupported optional hints
are ignored with a warning when the selected provider or model cannot honor
them. Tool results report applied settings; `details.normalization`
captures any requested-to-applied mapping.
</Note>

Provider request timeouts are operator configuration only. OpenClaw uses
`agents.defaults.mediaModels.music.timeoutMs` when configured, raises
values below 120000ms to 120000ms, and otherwise defaults provider requests
to 300000ms.

## Async behavior

Session-backed music generation runs as a background task:

- **Background task:** `music_generate` creates a background task, returns a
  started/task response immediately, and posts the finished track later in
  a follow-up agent message.
- **Duplicate prevention:** while a task is `queued` or `running`, later
  `music_generate` calls in the same session return task status instead of
  starting another generation. Use `action: "status"` to check explicitly.
  A recently completed matching request is also deduplicated for 2 minutes.
- **Status lookup:** `openclaw tasks list` or `openclaw tasks show <taskId>`
  inspects queued, running, and terminal status.
- **Completion wake:** OpenClaw injects an internal completion event back
  into the same session so the model can write the user-facing follow-up
  itself.
- **Prompt hint:** later user/manual turns in the same session get a small
  runtime hint when a music task is already in flight, so the model does
  not blindly call `music_generate` again.
- **No-session fallback:** direct/local contexts without a real agent
  session run inline and return the final audio result in the same turn.

### Task lifecycle

The music task surfaces the same states as the general task registry (see
[Background tasks](/automation/tasks#task-lifecycle) for the full state
machine, including `timed_out`, `cancelled`, and `lost`). Most music runs
move through:

| State       | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `queued`    | Task created, waiting for the provider to accept it.                                           |
| `running`   | Provider is processing (typically 30 seconds to 3 minutes depending on provider and duration). |
| `succeeded` | Track ready; the agent wakes and posts it to the conversation.                                 |
| `failed`    | Provider error or timeout; the agent wakes with error details.                                 |

Check status from the CLI:

```bash
openclaw tasks list
openclaw tasks show <taskId>
openclaw tasks cancel <taskId>
```

## Configuration

### Model selection

```json5
{
  agents: {
    defaults: {
      musicGenerationModel: {
        primary: "google/lyria-3-clip-preview",
        fallbacks: ["fal/fal-ai/minimax-music/v2.6", "minimax/music-2.6"],
      },
    },
  },
}
```

### Provider selection order

OpenClaw tries providers in this order:

1. `model` parameter from the tool call (if the agent specifies one).
2. `musicGenerationModel.primary` from config.
3. `musicGenerationModel.fallbacks` in order.
4. Auto-detection using auth-backed provider defaults only:
   - current default text-model provider first, if it also offers music
     generation;
   - remaining registered music-generation providers, alphabetically by
     provider id.

If a provider fails, the next candidate is tried automatically. If all
fail, the error includes details from each attempt.

Automatic fallback across authenticated providers is always enabled. A per-call
`model` remains authoritative.

## Provider notes

<AccordionGroup>
  <Accordion title="ComfyUI">
    Workflow-driven and depends on the configured graph plus node mapping
    for prompt/output fields. The bundled `comfy` plugin plugs into the
    shared `music_generate` tool through the music-generation provider
    registry.
  </Accordion>
  <Accordion title="fal">
    Uses fal model endpoints through the shared provider auth path. The
    bundled provider defaults to `fal-ai/minimax-music/v2.6` and also exposes
    `fal-ai/ace-step/prompt-to-audio` and
    `fal-ai/stable-audio-25/text-to-audio` for prompt-to-audio requests.
    Lyrics and instrumental mode are MiniMax-model-only; the other two
    models are prompt-only.
  </Accordion>
  <Accordion title="Google (Lyria 3)">
    Uses Lyria 3 batch generation. The current bundled flow supports
    prompt, optional lyrics text, and optional reference images. The
    default `lyria-3-clip-preview` model outputs mp3 only; the
    `lyria-3-pro-preview` model also supports wav.
  </Accordion>
  <Accordion title="MiniMax">
    Uses the batch `music_generation` endpoint. Supports prompt, optional
    lyrics, instrumental mode, and mp3 output through either `minimax`
    API-key auth or `minimax-portal` OAuth. Also exposes `music-2.6-free`,
    `music-cover`, and `music-cover-free` models.
  </Accordion>
  <Accordion title="OpenRouter">
    Uses OpenRouter chat completions audio output with streaming enabled. The
    bundled provider defaults to `google/lyria-3-pro-preview` and also exposes
    `openrouter/google/lyria-3-clip-preview`.
  </Accordion>
</AccordionGroup>

## Choosing the right path

- **Shared provider-backed** when you want model selection, provider
  failover, and the built-in async task/status flow.
- **Plugin path (ComfyUI)** when you need a custom workflow graph or a
  provider that is not part of the shared bundled music capability.

If you are debugging ComfyUI-specific behavior, see
[ComfyUI](/providers/comfy). If you are debugging shared provider
behavior, start with [fal](/providers/fal), [Google (Gemini)](/providers/google),
[MiniMax](/providers/minimax), or [OpenRouter](/providers/openrouter).

## Provider capability modes

The shared music-generation contract supports explicit mode declarations:

- `generate` for prompt-only generation.
- `edit` when the request includes one or more reference images.

New provider implementations should prefer explicit mode blocks:

```typescript
capabilities: {
  generate: {
    maxTracks: 1,
    supportsLyrics: true,
    supportsFormat: true,
  },
  edit: {
    enabled: true,
    maxTracks: 1,
    maxInputImages: 1,
    supportsFormat: true,
  },
}
```

Legacy flat fields such as `maxInputImages`, `supportsLyrics`, and
`supportsFormat` are **not** enough to advertise edit support. Providers
should declare `generate` and `edit` explicitly so live tests, contract
tests, and the shared `music_generate` tool can validate mode support
deterministically.

## Live tests

Opt-in live coverage for the shared bundled providers (fal, Google, MiniMax,
OpenRouter):

```bash
OPENCLAW_LIVE_TEST=1 pnpm test:live -- extensions/music-generation-providers.live.test.ts
```

Equivalent repo wrapper, which drives the same test file:

```bash
pnpm test:live:media:music
```

This live file uses already-exported provider env vars ahead of stored auth
profiles by default, and runs both `generate` and declared `edit` coverage when
the provider enables edit mode. Coverage today:

- `google`: `generate` plus `edit`
- `fal`: `generate` only
- `minimax`: `generate` only
- `openrouter`: `generate` plus `edit`
- `comfy`: separate Comfy live coverage, not the shared provider sweep

Opt-in live coverage for the bundled ComfyUI music path:

```bash
OPENCLAW_LIVE_TEST=1 COMFY_LIVE_TEST=1 pnpm test:live -- extensions/comfy/comfy.live.test.ts
```

The Comfy live file also covers comfy image and video workflows when those
sections are configured.

## Related

- [Background tasks](/automation/tasks) — task tracking for detached `music_generate` runs
- [ComfyUI](/providers/comfy)
- [Configuration reference](/gateway/config-agents#agent-defaults) — `musicGenerationModel` config
- [Google (Gemini)](/providers/google)
- [MiniMax](/providers/minimax)
- [Models](/concepts/models) — model configuration and failover
- [Tools overview](/tools)
