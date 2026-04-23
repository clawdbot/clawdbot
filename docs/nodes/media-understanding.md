---
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"
read_when:
  - Designing or refactoring media understanding
  - Tuning inbound audio/video/image preprocessing
title: "Media Understanding"
---

# Media Understanding - Inbound (2026-01-17)

OpenClaw can **summarize inbound media** (image/audio/video) before the reply pipeline runs. It auto‑detects when local tools or provider keys are available, and can be disabled or customized. If understanding is off, models still receive the original files/URLs as usual.

Vendor-specific media behavior is registered by vendor plugins, while OpenClaw
core owns the shared `tools.media` config, fallback order, and reply-pipeline
integration.

## Goals

- Optional: pre‑digest inbound media into short text for faster routing + better command parsing.
- Preserve original media delivery to the model (always).
- Support **provider APIs** and **CLI fallbacks**.
- Allow multiple models with ordered fallback (error/size/timeout).

## High-level behavior

1. Collect inbound attachments (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. For each enabled capability (image/audio/video), select attachments per policy (default: **first**).
3. Choose the first eligible model entry (size + capability + auth).
4. If a model fails or the media is too large, **fall back to the next entry**.
5. On success:
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
  - audio transcript echo controls (`echoTranscript`, default `false`; `echoFormat`)
  - optional **per‑capability `models` list** (preferred before shared models)
  - `attachments` policy (`mode`, `maxAttachments`, `prefer`)
  - `scope` (optional gating by channel/chatType/session key)
- `tools.media.concurrency`: max concurrent capability runs (default **2**).

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
        echoTranscript: true,
        echoFormat: '📝 "{transcript}"',
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### Model entries

Each `models[]` entry can be **provider** or **CLI**:

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.4-mini",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
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
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
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
- Audio files smaller than **1024 bytes** are treated as empty/corrupt and skipped before provider/CLI transcription.
- If the model returns more than `maxChars`, output is trimmed.
- `prompt` defaults to simple “Describe the {media}.” plus the `maxChars` guidance (image/video only).
- If the active primary image model already supports vision natively, OpenClaw
  skips the `[Image]` summary block and passes the original image into the
  model instead.
- Explicit `openclaw infer image describe --model <provider/model>` requests
  are different: they run that image-capable provider/model directly, including
  Ollama refs such as `ollama/qwen2.5vl:7b`.
- If `<capability>.enabled: true` but no models are configured, OpenClaw tries the
  **active reply model** when its provider supports the capability.

### Auto-detect media understanding (default)

If `tools.media.<capability>.enabled` is **not** set to `false` and you haven’t
configured models, OpenClaw auto-detects in this order and **stops at the first
working option**:

1. **Active reply model** when its provider supports the capability.
2. **`agents.defaults.imageModel`** primary/fallback refs (image only).
3. **Local CLIs** (audio only; if installed)
   - `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; uses `WHISPER_CPP_MODEL` or the bundled tiny model)
   - `whisper` (Python CLI; downloads models automatically)
4. **Gemini CLI** (`gemini`) using `read_many_files`
5. **Provider auth**
   - Configured `models.providers.*` entries that support the capability are
     tried before the bundled fallback order.
   - Image-only config providers with an image-capable model auto-register for
     media understanding even when they are not a bundled vendor plugin.
   - Ollama image understanding is available when selected explicitly, for
     example through `agents.defaults.imageModel` or
     `openclaw infer image describe --model ollama/<vision-model>`.
   - Bundled fallback order:
     - Audio: OpenAI → Groq → xAI → Deepgram → Google → Mistral
     - Image: OpenAI → Anthropic → Google → MiniMax → MiniMax Portal → Z.AI
     - Video: Google → Qwen → Moonshot

To disable auto-detection, set:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

Note: Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (we expand `~`), or set an explicit CLI model with a full command path.

### Proxy environment support (provider models)

When provider-based **audio** and **video** media understanding is enabled, OpenClaw
honors standard outbound proxy environment variables for provider HTTP calls:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `https_proxy`
- `http_proxy`

If no proxy env vars are set, media understanding uses direct egress.
If the proxy value is malformed, OpenClaw logs a warning and falls back to direct
fetch.

## Capabilities (optional)

If you set `capabilities`, the entry only runs for those media types. For shared
lists, OpenClaw can infer defaults:

- `openai`, `anthropic`, `minimax`: **image**
- `minimax-portal`: **image**
- `moonshot`: **image + video**
- `openrouter`: **image**
- `google` (Gemini API): **image + audio + video**
- `qwen`: **image + video**
- `mistral`: **audio**
- `zai`: **image**
- `groq`: **audio**
- `xai`: **audio**
- `deepgram`: **audio**
- Any `models.providers.<id>.models[]` catalog with an image-capable model:
  **image**

For CLI entries, **set `capabilities` explicitly** to avoid surprising matches.
If you omit `capabilities`, the entry is eligible for the list it appears in.

## Provider support matrix (OpenClaw integrations)

| Capability | Provider integration                                                                   | Notes                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Image      | OpenAI, OpenRouter, Anthropic, Google, MiniMax, Moonshot, Qwen, Z.AI, config providers | Vendor plugins register image support; MiniMax and MiniMax OAuth both use `MiniMax-VL-01`; image-capable config providers auto-register. |
| Audio      | OpenAI, Groq, Deepgram, Google, Mistral                                                | Provider transcription (Whisper/Deepgram/Gemini/Voxtral).                                                                                |
| Video      | Google, Qwen, Moonshot                                                                 | Provider video understanding via vendor plugins; Qwen video understanding uses the Standard DashScope endpoints.                         |

MiniMax note:

- `minimax` and `minimax-portal` image understanding comes from the plugin-owned
  `MiniMax-VL-01` media provider.
- The bundled MiniMax text catalog still starts text-only; explicit
  `models.providers.minimax` entries materialize image-capable M2.7 chat refs.

## Model selection guidance

- Prefer the strongest latest-generation model available for each media capability when quality and safety matter.
- For tool-enabled agents handling untrusted inputs, avoid older/weaker media models.
- Keep at least one fallback per capability for availability (quality model + faster/cheaper model).
- CLI fallbacks (`whisper-cli`, `whisper`, `gemini`) are useful when provider APIs are unavailable.
- `parakeet-mlx` note: with `--output-dir`, OpenClaw reads `<output-dir>/<media-basename>.txt` when output format is `txt` (or unspecified); non-`txt` formats fall back to stdout.

## Attachment policy

Per‑capability `attachments` controls which attachments are processed:

- `mode`: `first` (default) or `all`
- `maxAttachments`: cap the number processed (default **1**)
- `prefer`: `first`, `last`, `path`, `url`

When `mode: "all"`, outputs are labeled `[Image 1/2]`, `[Audio 2/2]`, etc.

File-attachment extraction behavior:

- Extracted file text is wrapped as **untrusted external content** before it is
  appended to the media prompt.
- The injected block uses explicit boundary markers like
  `<<<EXTERNAL_UNTRUSTED_CONTENT id="...">>>` /
  `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="...">>>` and includes a
  `Source: External` metadata line.
- This attachment-extraction path intentionally omits the long
  `SECURITY NOTICE:` banner to avoid bloating the media prompt; the boundary
  markers and metadata still remain.
- If a file has no extractable text, OpenClaw injects `[No extractable text]`.
- If a PDF falls back to rendered page images in this path, the media prompt keeps
  the placeholder `[PDF content rendered to images; images not forwarded to model]`
  because this attachment-extraction step forwards text blocks, not the rendered PDF images.

## Config examples

### 1) Shared models list + overrides

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.4-mini", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
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
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
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
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
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
          { provider: "openai", model: "gpt-5.4-mini" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4) Multi-modal single entry (explicit capabilities)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## Status output

When media understanding runs, `/status` includes a short summary line:

```
📎 Media: image ok (openai/gpt-5.4-mini) · audio skipped (maxBytes)
```

This shows per‑capability outcomes and the chosen provider/model when applicable.

## Notes

- Understanding is **best‑effort**. Errors do not block replies.
- Attachments are still passed to models even when understanding is disabled.
- Use `scope` to limit where understanding runs (e.g. only DMs).

## Related docs

- [Configuration](/gateway/configuration)
- [Image & Media Support](/nodes/images)
