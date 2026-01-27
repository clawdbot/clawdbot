---
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"
read_when:
  - Designing or refactoring media understanding
  - Tuning inbound audio/video/image preprocessing
---
# Media Understanding (Inbound) — 2026-01-17

Moltbot can **summarize inbound media** (image/audio/video) before the reply pipeline runs. It auto‑detects when local tools or provider keys are available, and can be disabled or customized. If understanding is off, models still receive the original files/URLs as usual.

## Goals
- Optional: pre‑digest inbound media into short text for faster routing + better command parsing.
- Preserve original media delivery to the model (always).
- Support **provider APIs** and **CLI fallbacks**.
- Allow multiple models with ordered fallback (error/size/timeout).

## High‑level behavior
1) Collect inbound attachments (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2) For each enabled capability (image/audio/video), select attachments per policy (default: **first**).
3) Choose the first eligible model entry (size + capability + auth).  
4) If a model fails or the media is too large, **fall back to the next entry**.
5) On success:
   - `Body` becomes `[Image]`, `[Audio]`, or `[Video]` block.
   - Audio sets `{{Transcript}}`; command parsing uses caption text when present,
     otherwise the transcript.
   - Captions are preserved as `User text:` inside the block.

If understanding fails or is disabled, **the reply flow continues** with the original body + attachments.

## Config overview
`tools.media` supports **shared models** plus per‑capability overrides:
- `tools.media.models`: shared model list (use `capabilities` to gate).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - defaults (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - provider overrides (`baseUrl`, `headers`, `providerOptions`)
  - Deepgram audio options via `tools.media.audio.providerOptions.deepgram`
  - optional **per‑capability `models` list** (preferred before shared models)
  - `attachments` policy (`mode`, `maxAttachments`, `prefer`)
  - `scope` (optional gating by channel/chatType/session key)
- `tools.media.concurrency`: max concurrent capability runs (default **2**).

```json5
{
  tools: {
    media: {
      models: [ /* shared list */ ],
      image: { /* optional overrides */ },
      audio: { /* optional overrides */ },
      video: { /* optional overrides */ }
    }
  }
}
```

### Model entries
Each `models[]` entry can be **provider** or **CLI**:

```json5
{
  type: "provider",        // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback"
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"]
}
```

CLI templates can also use:
- `{{MediaDir}}` (directory containing the media file)
- `{{OutputDir}}` (scratch dir created for this run)
- `{{OutputBase}}` (scratch file base path, no extension)

## Defaults and limits
Recommended defaults:
- `maxChars`: **500** for image/video (short, command‑friendly)
- `maxChars`: **unset** for audio (full transcript unless you set a limit)
- `maxBytes`:
  - image: **10MB**
  - audio: **20MB**
  - video: **50MB**

Rules:
- If media exceeds `maxBytes`, that model is skipped and the **next model is tried**.
- If the model returns more than `maxChars`, output is trimmed.
- `prompt` defaults to simple “Describe the {media}.” plus the `maxChars` guidance (image/video only).
- If `<capability>.enabled: true` but no models are configured, Moltbot tries the
  **active reply model** when its provider supports the capability.

### Auto-detect media understanding (default)
If `tools.media.<capability>.enabled` is **not** set to `false` and you haven’t
configured models, Moltbot auto-detects in this order and **stops at the first
working option**:

1) **Local CLIs** (audio only; if installed)
   - `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; uses `WHISPER_CPP_MODEL` or the bundled tiny model)
   - `whisper` (Python CLI; downloads models automatically)
2) **Gemini CLI** (`gemini`) using `read_many_files`
3) **Provider keys**
   - Audio: OpenAI → Groq → Deepgram → Google
   - Image: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

To disable auto-detection, set:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: false
      }
    }
  }
}
```
Note: Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (we expand `~`), or set an explicit CLI model with a full command path.

## Capabilities (optional)
If you set `capabilities`, the entry only runs for those media types. For shared
lists, Moltbot can infer defaults:
- `openai`, `anthropic`, `minimax`: **image**
- `google` (Gemini API): **image + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

For CLI entries, **set `capabilities` explicitly** to avoid surprising matches.
If you omit `capabilities`, the entry is eligible for the list it appears in.

## Provider support matrix (Moltbot integrations)
| Capability | Provider integration | Notes |
|------------|----------------------|-------|
| Image | OpenAI / Anthropic / Google / others via `pi-ai` | Any image-capable model in the registry works. |
| Audio | OpenAI, Groq, Deepgram, Google | Provider transcription (Whisper/Deepgram/Gemini). |
| Video | Google (Gemini API) | Provider video understanding. |

## Recommended providers
**Image**
- Prefer your active model if it supports images.
- Good defaults: `openai/gpt-5.2`, `anthropic/claude-opus-4-5`, `google/gemini-3-pro-preview`.

**Audio**
- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, or `deepgram/nova-3`.
- CLI fallback: `whisper-cli` (whisper-cpp) or `whisper`.
- Deepgram setup: [Deepgram (audio transcription)](/providers/deepgram).

**Video**
- `google/gemini-3-flash-preview` (fast), `google/gemini-3-pro-preview` (richer).
- CLI fallback: `gemini` CLI (supports `read_file` on video/audio).

## Attachment policy
Per‑capability `attachments` controls which attachments are processed:
- `mode`: `first` (default) or `all`
- `maxAttachments`: cap the number processed (default **1**)
- `prefer`: `first`, `last`, `path`, `url`

When `mode: "all"`, outputs are labeled `[Image 1/2]`, `[Audio 2/2]`, etc.

## Config examples

### 1) Shared models list + overrides
```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        { provider: "google", model: "gemini-3-flash-preview", capabilities: ["image", "audio", "video"] },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
          ],
          capabilities: ["image", "video"]
        }
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 }
      },
      video: {
        maxChars: 500
      }
    }
  }
}
```

### 2) Audio + Video only (image off)
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"]
          }
        ]
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
            ]
          }
        ]
      }
    }
  }
}
```

### 3) Optional image understanding
```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-5" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters."
            ]
          }
        ]
      }
    }
  }
}
```

### 4) Multi‑modal single entry (explicit capabilities)
```json5
{
  tools: {
    media: {
      image: { models: [{ provider: "google", model: "gemini-3-pro-preview", capabilities: ["image", "video", "audio"] }] },
      audio: { models: [{ provider: "google", model: "gemini-3-pro-preview", capabilities: ["image", "video", "audio"] }] },
      video: { models: [{ provider: "google", model: "gemini-3-pro-preview", capabilities: ["image", "video", "audio"] }] }
    }
  }
}
```

## Status output
When media understanding runs, `/status` includes a short summary line:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

This shows per‑capability outcomes and the chosen provider/model when applicable.

## Notes
- Understanding is **best‑effort**. Errors do not block replies.
- Attachments are still passed to models even when understanding is disabled.
- Use `scope` to limit where understanding runs (e.g. only DMs).

## Related docs
- [Configuration](/gateway/configuration)
- [Image & Media Support](/nodes/images)
