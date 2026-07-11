---
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"
read_when:
  - Designing or refactoring media understanding
  - Tuning inbound audio/video/image preprocessing
title: "Media understanding"
sidebarTitle: "Media understanding"
---

OpenClaw can summarize inbound media (image/audio/video) before the reply pipeline runs, so command parsing and routing work off short text instead of raw bytes. Understanding auto-detects local tools or provider keys, or you can configure explicit models. Original media is always delivered to the model as usual; when understanding fails or is disabled, the reply flow continues unchanged.

Vendor plugins register capability metadata (which provider supports which media type, default model, priority). OpenClaw core owns the shared `tools.media` config, fallback order, and reply-pipeline integration.

## How it works

<Steps>
  <Step title="Collect attachments">
    Collect inbound attachments (`MediaPaths`, `MediaUrls`, `MediaTypes`).
  </Step>
  <Step title="Select per capability">
    For each enabled capability (image/audio/video), select attachments per the `attachments` policy (default: first attachment only).
  </Step>
  <Step title="Choose a model">
    Pick the first eligible model entry (size + capability + auth available).
  </Step>
  <Step title="Fall back on failure">
    If a model errors, times out, or the media exceeds `maxBytes`, try the next entry.
  </Step>
  <Step title="Apply on success">
    `Body` becomes an `[Image]`, `[Audio]`, or `[Video]` block. Audio also sets `{{Transcript}}`; command parsing uses caption text when present, otherwise the transcript. Captions are preserved as `User text:` inside the block.
  </Step>
</Steps>

## Config

`tools.media` holds a shared model list plus per-capability overrides:

```json5
{
  tools: {
    media: {
      concurrency: 2, // max concurrent capability runs (default)
      models: [
        /* shared list, gate with capabilities */
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

Per-capability (`image`/`audio`/`video`) keys:

| Key                                             | Type      | Default                                              | Notes                                                                               |
| ----------------------------------------------- | --------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `enabled`                                       | `boolean` | auto (`false` disables)                              | Set `false` to turn off auto-detect for this capability                             |
| `models`                                        | array     | none                                                 | Preferred before the shared `tools.media.models` list                               |
| `prompt`                                        | `string`  | `"Describe the {media}."` (+ maxChars guidance)      | Image/video only by default                                                         |
| `maxChars`                                      | `number`  | `500` (image/video), unset (audio)                   | Output is trimmed if the model returns more                                         |
| `maxBytes`                                      | `number`  | image `10485760`, audio `20971520`, video `52428800` | Oversized media skips to the next model                                             |
| `timeoutSeconds`                                | `number`  | `60` (image/audio), `120` (video)                    |                                                                                     |
| `language`                                      | `string`  | unset                                                | Audio transcription hint                                                            |
| `baseUrl`/`headers`/`providerOptions`/`request` | -         | -                                                    | Provider request overrides; see [Tools and custom providers](/gateway/config-tools) |
| `attachments`                                   | object    | `{ mode: "first", maxAttachments: 1 }`               | See [Attachment policy](#attachment-policy)                                         |
| `scope`                                         | object    | unset                                                | Gate by channel/chatType/keyPrefix                                                  |
| `echoTranscript`                                | `boolean` | `false`                                              | Audio only: echo the transcript back to the chat before agent processing            |
| `echoFormat`                                    | `string`  | `'📝 "{transcript}"'`                                | Audio only: `{transcript}` placeholder                                              |

Deepgram-specific options go under `providerOptions.deepgram` (the top-level `deepgram: { detectLanguage, punctuate, smartFormat }` field is deprecated but still read).

### Model entries

Each `models[]` entry is a **provider** entry (default) or a **CLI** entry:

<Tabs>
  <Tab title="Provider entry">
    ```json5
    {
      type: "provider", // default if omitted
      provider: "openai",
      model: "gpt-5.5",
      prompt: "Describe the image in <= 500 chars.",
      maxChars: 500,
      maxBytes: 10485760,
      timeoutSeconds: 60,
      capabilities: ["image"], // optional, for multi-modal shared entries
      profile: "vision-profile",
      preferredProfile: "vision-fallback",
    }
    ```
  </Tab>
  <Tab title="CLI entry">
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

    CLI templates can also use `{{MediaDir}}` (directory containing the media file), `{{OutputDir}}` (scratch dir created for this run), and `{{OutputBase}}` (scratch file base path, no extension).

  </Tab>
</Tabs>

### Provider credentials

Provider media understanding uses the same auth resolution as normal model calls: auth profiles, environment variables, then `models.providers.<providerId>.apiKey`. `tools.media.*.models[]` entries do not accept an inline `apiKey` field.

```json5
{
  models: {
    providers: {
      openai: { apiKey: "<OPENAI_API_KEY>" },
      moonshot: { apiKey: "<MOONSHOT_API_KEY>" },
    },
  },
}
```

See [Tools and custom providers](/gateway/config-tools) for profiles, env vars, and custom base URLs.

## Rules and behavior

- Media exceeding `maxBytes` skips that model and tries the next one.
- Audio files under 1024 bytes are treated as empty/corrupt and skipped before transcription; the agent gets a deterministic placeholder transcript instead.
- If the active primary image model already supports vision natively, OpenClaw skips the `[Image]` summary block and passes the original image into the model directly. MiniMax is an exception: `minimax`, `minimax-cn`, `minimax-portal`, and `minimax-portal-cn` always route image understanding through the plugin-owned `MiniMax-VL-01` media provider, even if legacy MiniMax M2.x chat metadata claims image input (only `MiniMax-M3` and later are treated as natively vision-capable).
- If a Gateway/WebChat primary model is text-only, image attachments are preserved as offloaded `media://inbound/*` refs so image/PDF tools or a configured image model can still inspect them instead of losing the attachment.
- Explicit `openclaw infer image describe --file <path> --model <provider/model>` (alias: `openclaw capability image describe`) runs that image-capable provider/model directly, including Ollama refs such as `ollama/qwen2.5vl:7b` when a matching image-capable model is configured under `models.providers.ollama.models[]`.
- If `<capability>.enabled` is not `false` but no models are configured, OpenClaw tries the active reply model when its provider supports the capability.

### Auto-detect (default)

When `tools.media.<capability>.enabled` is not `false` and no models are configured, OpenClaw tries these in order and stops at the first working option:

<Steps>
  <Step title="Configured image model (image only)">
    `agents.defaults.imageModel` primary/fallback refs, unless the active reply model already supports vision natively. Prefer `provider/model` refs; bare refs are qualified from configured image-capable provider model entries only when the match is unique.
  </Step>
  <Step title="Active reply model">
    The active reply model, when its provider supports the capability.
  </Step>
  <Step title="Provider auth (audio only, before local CLIs)">
    Configured `models.providers.*` entries that support audio are tried before local CLIs. Bundled provider priority order (ties break alphabetically by provider id): Groq/OpenAI &rarr; xAI &rarr; Deepgram &rarr; OpenRouter &rarr; Google/SenseAudio &rarr; Deepinfra/ElevenLabs &rarr; Mistral.
  </Step>
  <Step title="Local CLIs (audio only)">
    Ready local binaries become an ordered fallback list:
    - `whisper-cli` first only after an earlier model invocation in the current process observed Metal or CUDA
    - CPU-default `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with `tokens.txt`/`encoder.onnx`/`decoder.onnx`/`joiner.onnx`)
    - `whisper-cli` when acceleration is merely build-capable or unobserved
    - `parakeet-mlx` on Apple Silicon (MLX-capable, device use unobserved)
    - `whisper` (Python CLI; defaults to the `turbo` model, downloads automatically)

    Backend capability inspection is cached and does not load a model. Build capability, requested backend flags, and backend observed from a real invocation remain separate. Auto-detected whisper.cpp leaves model-run logs enabled so the upstream selected-backend line can be recorded. Explicit CLI entries keep their configured order, backend flags, and output flags.

  </Step>
  <Step title="Provider auth (image/video)">
    Configured `models.providers.*` entries that support the capability are tried before the bundled fallback order. Image-only config providers with an image-capable model auto-register for media understanding even when they are not a bundled vendor plugin.

    Bundled provider priority order (ties break alphabetically by provider id):
    - Image: Anthropic/OpenAI &rarr; Google &rarr; MiniMax &rarr; Deepinfra &rarr; MiniMax Portal &rarr; Z.AI
    - Video: Google &rarr; Qwen &rarr; Moonshot

  </Step>
  <Step title="Antigravity CLI (image/video only)">
    First installed `agy` or `antigravity` binary (override with `OPENCLAW_ANTIGRAVITY_CLI`), sandboxed against the media's directory.
  </Step>
</Steps>

To disable auto-detection for a capability:

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

<Note>
Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (`~` is expanded), or set an explicit CLI model entry with a full command path.
</Note>

### Proxy support (audio/video provider calls)

Provider-based **audio** and **video** understanding honors standard outbound proxy environment variables, including `NO_PROXY`/`no_proxy` bypass rules: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `https_proxy`, `http_proxy`, `all_proxy`. Lowercase vars take precedence over uppercase. If none are set, media understanding uses direct egress; if the proxy value is malformed, OpenClaw logs a warning and falls back to direct fetch. Image understanding does not go through this proxy path.

## Capabilities

Set `capabilities` on a `models[]` entry to restrict it to specific media types. For shared lists, OpenClaw infers defaults per bundled provider:

| Provider                                                                 | Capabilities          |
| ------------------------------------------------------------------------ | --------------------- |
| `openai`, `anthropic`, `minimax`                                         | image                 |
| `minimax-portal`                                                         | image                 |
| `moonshot`                                                               | image + video         |
| `openrouter`                                                             | image + audio         |
| `google` (Gemini API)                                                    | image + audio + video |
| `qwen`                                                                   | image + video         |
| `deepinfra`                                                              | image + audio         |
| `mistral`                                                                | audio                 |
| `zai`                                                                    | image                 |
| `groq`, `xai`, `deepgram`, `senseaudio`                                  | audio                 |
| Any `models.providers.<id>.models[]` catalog with an image-capable model | image                 |

For CLI entries, set `capabilities` explicitly to avoid surprising matches; if omitted, the entry is eligible for every capability list it appears in.

## Provider support matrix

| Capability | Providers                                                                                                                                               | Notes                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image      | Anthropic, Codex app-server, Deepinfra, Google, MiniMax, MiniMax Portal, Moonshot, OpenAI, OpenAI Codex OAuth, OpenRouter, Qwen, Z.AI, config providers | Vendor plugins register image support; `openai/*` can use API-key or Codex OAuth routing; `codex/*` uses a bounded Codex app-server turn; image-capable config providers auto-register. |
| Audio      | Deepgram, Deepinfra, ElevenLabs, Google, Groq, Mistral, OpenAI, OpenRouter, SenseAudio, xAI                                                             | Provider transcription (Whisper/Groq/xAI/Deepgram/OpenRouter STT/Gemini/SenseAudio/Scribe/Voxtral).                                                                                     |
| Video      | Google, Moonshot, Qwen                                                                                                                                  | Provider video understanding via vendor plugins; Qwen video understanding uses the standard DashScope endpoints.                                                                        |

<Note>
**MiniMax note**: `minimax`, `minimax-cn`, `minimax-portal`, and `minimax-portal-cn` image understanding always comes from the plugin-owned `MiniMax-VL-01` media provider, even if legacy MiniMax M2.x chat metadata claims image input.
</Note>

## Model selection guidance

- Prefer the strongest current-generation model for each media capability when quality and safety matter.
- For tool-enabled agents handling untrusted inputs, avoid older/weaker media models.
- Keep at least one fallback per capability for availability (quality model + faster/cheaper model).
- CLI fallbacks (`whisper-cli`, `whisper`, `gemini`) help when provider APIs are unavailable.
- Known file-output modes are authoritative: an empty or missing inferred transcript file produces no transcript instead of falling back to CLI progress output.
- `parakeet-mlx`: use `--output-format txt` (or `all`) with `--output-dir` and the default `{filename}` output template. The upstream `PARAKEET_OUTPUT_FORMAT` and `PARAKEET_OUTPUT_TEMPLATE` environment variables are also honored. OpenClaw reads `<output-dir>/<media-basename>.txt`; the default `srt` format, other formats, and custom output templates continue to use stdout.

## Attachment policy

Per-capability `attachments` controls which attachments are processed:

<ParamField path="mode" type='"first" | "all"' default="first">
  Process only the first selected attachment, or all of them.
</ParamField>
<ParamField path="maxAttachments" type="number" default="1">
  Cap the number processed.
</ParamField>
<ParamField path="prefer" type='"first" | "last" | "path" | "url"'>
  Selection preference among candidate attachments.
</ParamField>

When `mode: "all"`, outputs are labeled `[Image 1/2]`, `[Audio 2/2]`, etc.

### File-attachment extraction

- Extracted file text is wrapped as untrusted external content before it's appended to the media prompt, using boundary markers like `<<<EXTERNAL_UNTRUSTED_CONTENT id="...">>>` / `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="...">>>` plus a `Source: External` metadata line.
- This path intentionally omits the long `SECURITY NOTICE:` banner to keep the media prompt short; the boundary markers and metadata still apply.
- A file with no extractable text gets `[No extractable text]`.
- If a PDF falls back to rendered page images, OpenClaw forwards those images to vision-capable reply models and keeps the placeholder `[PDF content rendered to images]` in the file block.

## Config examples

<Tabs>
  <Tab title="Shared models + overrides">
    ```json5
    {
      tools: {
        media: {
          models: [
            { provider: "openai", model: "gpt-5.5", capabilities: ["image"] },
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
  </Tab>
  <Tab title="Audio + video only">
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
  </Tab>
  <Tab title="Image only">
    ```json5
    {
      tools: {
        media: {
          image: {
            enabled: true,
            maxBytes: 10485760,
            maxChars: 500,
            models: [
              { provider: "openai", model: "gpt-5.5" },
              { provider: "anthropic", model: "claude-opus-4-8" },
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
  </Tab>
  <Tab title="Multi-modal single entry">
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
  </Tab>
</Tabs>

## Status output

When media understanding runs, `/status` includes a per-capability summary line:

```
📎 Media: image ok (openai/gpt-5.5) · audio ok (whisper-cli observed=metal)
```

For preflight inventory, run `openclaw capability audio providers`. Local rows show the local fallback winner separately from global provider selection, readiness, and separate capable/requested/observed backend fields. The same local selection is available as an informational doctor finding:

```bash
openclaw doctor --lint --only core/doctor/local-audio-acceleration --severity-min info
```

## Notes

- Understanding is best-effort. Errors do not block replies.
- Attachments are still passed to models even when understanding is disabled.
- Use `scope` to limit where understanding runs (for example, only DMs).

## Related

- [Configuration](/gateway/configuration)
- [Image & media support](/nodes/images)
