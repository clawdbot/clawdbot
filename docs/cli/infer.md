---
summary: "Infer-first CLI for provider-backed model, image, audio, TTS, video, web, and embedding workflows"
read_when:
  - Adding or modifying `openclaw infer` commands
  - Designing stable headless capability automation
title: "Inference CLI"
---

`openclaw infer` is the canonical headless surface for provider-backed inference workflows.

It intentionally exposes capability families, not raw gateway RPC names and not raw agent tool ids.

## Turn infer into a skill

Copy and paste this to an agent:

```text
Read https://docs.openclaw.ai/cli/infer, then create a skill that routes my common workflows to `openclaw infer`.
Focus on model runs, image generation, video generation, audio transcription, TTS, web search, and embeddings.
```

A good infer-based skill should:

- map common user intents to the correct infer subcommand
- include a few canonical infer examples for the workflows it covers
- prefer `openclaw infer ...` in examples and suggestions
- avoid re-documenting the entire infer surface inside the skill body

Typical infer-focused skill coverage:

- `openclaw infer model run`
- `openclaw infer image generate`
- `openclaw infer audio transcribe`
- `openclaw infer tts convert`
- `openclaw infer web search`
- `openclaw infer embedding create`

## Why use infer

`openclaw infer` provides one consistent CLI for provider-backed inference tasks inside OpenClaw.

Benefits:

- Use the providers and models already configured in OpenClaw instead of wiring up one-off wrappers for each backend.
- Keep model, image, audio transcription, TTS, video, web, and embedding workflows under one command tree.
- Use a stable `--json` output shape for scripts, automation, and agent-driven workflows.
- Prefer a first-party OpenClaw surface when the task is fundamentally "run inference."
- Use the normal local path without requiring the gateway for most infer commands.

For end-to-end provider checks, prefer `openclaw infer ...` once lower-level
provider tests are green. It exercises the shipped CLI, config loading,
default-agent resolution, bundled plugin activation, runtime-dependency repair,
and the shared capability runtime before the provider request is made.

## Command tree

```text
 openclaw infer
  list
  inspect

  model
    run
    list
    inspect
    providers
    auth login
    auth logout
    auth status

  image
    generate
    edit
    describe
    describe-many
    providers

  audio
    transcribe
    providers

  tts
    convert
    voices
    providers
    status
    enable
    disable
    set-provider

  video
    generate
    describe
    providers

  web
    search
    fetch
    providers

  embedding
    create
    providers
```

## Common tasks

This table maps common inference tasks to the corresponding infer command.

| Task                    | Command                                                                | Notes                                                 |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Run a text/model prompt | `openclaw infer model run --prompt "..." --json`                       | Uses the normal local path by default                 |
| Generate an image       | `openclaw infer image generate --prompt "..." --json`                  | Use `image edit` when starting from an existing file  |
| Describe an image file  | `openclaw infer image describe --file ./image.png --json`              | `--model` must be an image-capable `<provider/model>` |
| Transcribe audio        | `openclaw infer audio transcribe --file ./memo.m4a --json`             | `--model` must be `<provider/model>`                  |
| Synthesize speech       | `openclaw infer tts convert --text "..." --output ./speech.mp3 --json` | `tts status` is gateway-oriented                      |
| Generate a video        | `openclaw infer video generate --prompt "..." --json`                  | Supports provider hints such as `--resolution`        |
| Describe a video file   | `openclaw infer video describe --file ./clip.mp4 --json`               | `--model` must be `<provider/model>`                  |
| Search the web          | `openclaw infer web search --query "..." --json`                       |                                                       |
| Fetch a web page        | `openclaw infer web fetch --url https://example.com --json`            |                                                       |
| Create embeddings       | `openclaw infer embedding create --text "..." --json`                  |                                                       |

## Behavior

- `openclaw infer ...` is the primary CLI surface for these workflows.
- Use `--json` when the output will be consumed by another command or script.
- Use `--provider` or `--model provider/model` when a specific backend is required.
- For `image describe`, `audio transcribe`, and `video describe`, `--model` must use the form `<provider/model>`.
- For `image describe`, an explicit `--model` runs that provider/model directly. The model must be image-capable in the model catalog or provider config. `codex/<model>` runs a bounded Codex app-server image-understanding turn; `openai-codex/<model>` uses the OpenAI Codex OAuth provider path.
- Stateless execution commands default to local.
- Gateway-managed state commands default to gateway.
- The normal local path does not require the gateway to be running.
- `model run` is one-shot. MCP servers opened through the agent runtime for that command are retired after the reply for both local and `--gateway` execution, so repeated scripted invocations do not keep stdio MCP child processes alive.

## Model

Use `model` for provider-backed text inference and model/provider inspection.

```bash
openclaw infer model run --prompt "Reply with exactly: smoke-ok" --json
openclaw infer model run --prompt "Summarize this changelog entry" --provider openai --json
openclaw infer model providers --json
openclaw infer model inspect --name gpt-5.5 --json
```

Notes:

- `model run` reuses the agent runtime so provider/model overrides behave like normal agent execution.
- Because `model run` is intended for headless automation, it does not retain per-session bundled MCP runtimes after the command finishes.
- `model auth login`, `model auth logout`, and `model auth status` manage saved provider auth state.

## Image

Use `image` for generation, edit, and description.

```bash
openclaw infer image generate --prompt "friendly lobster illustration" --json
openclaw infer image generate --prompt "cinematic product photo of headphones" --json
openclaw infer image generate --model openai/gpt-image-1.5 --output-format png --background transparent --prompt "simple red circle sticker on a transparent background" --json
openclaw infer image generate --prompt "slow image backend" --timeout-ms 180000 --json
openclaw infer image edit --file ./logo.png --model openai/gpt-image-1.5 --output-format png --background transparent --prompt "keep the logo, remove the background" --json
openclaw infer image edit --file ./poster.png --prompt "make this a vertical story ad" --size 2160x3840 --aspect-ratio 9:16 --resolution 4K --json
openclaw infer image describe --file ./photo.jpg --json
openclaw infer image describe --file ./ui-screenshot.png --model openai/gpt-4.1-mini --json
openclaw infer image describe --file ./photo.jpg --model ollama/qwen2.5vl:7b --json
```

Notes:

- Use `image edit` when starting from existing input files.
- Use `--size`, `--aspect-ratio`, or `--resolution` with `image edit` for
  providers/models that support geometry hints on reference-image edits.
- Use `--output-format png --background transparent` with
  `--model openai/gpt-image-1.5` for transparent-background OpenAI PNG output;
  `--openai-background` remains available as an OpenAI-specific alias. Providers
  that do not declare background support report the hint as an ignored override.
- Use `image providers --json` to verify which bundled image providers are
  discoverable, configured, selected, and which generation/edit capabilities
  each provider exposes.
- Use `image generate --model <provider/model> --json` as the narrowest live
  CLI smoke for image generation changes. Example:

  ```bash
  openclaw infer image providers --json
  openclaw infer image generate \
    --model google/gemini-3.1-flash-image-preview \
    --prompt "Minimal flat test image: one blue square on a white background, no text." \
    --output ./openclaw-infer-image-smoke.png \
    --json
  ```

  The JSON response reports `ok`, `provider`, `model`, `attempts`, and written
  output paths. When `--output` is set, the final extension may follow the
  provider's returned MIME type.

- For `image describe`, `--model` must be an image-capable `<provider/model>`.
- For local Ollama vision models, pull the model first and set `OLLAMA_API_KEY` to any placeholder value, for example `ollama-local`. See [Ollama](/providers/ollama#vision-and-image-description).

## Audio

Use `audio` for file transcription.

```bash
openclaw infer audio transcribe --file ./memo.m4a --json
openclaw infer audio transcribe --file ./team-sync.m4a --language en --prompt "Focus on names and action items" --json
openclaw infer audio transcribe --file ./memo.m4a --model openai/whisper-1 --json
```

Notes:

- `audio transcribe` is for file transcription, not realtime session management.
- `--model` must be `<provider/model>`.

## TTS

Use `tts` for speech synthesis and TTS provider state.

```bash
openclaw infer tts convert --text "hello from openclaw" --output ./hello.mp3 --json
openclaw infer tts convert --text "Your build is complete" --output ./build-complete.mp3 --json
openclaw infer tts providers --json
openclaw infer tts status --json
```

Notes:

- `tts status` defaults to gateway because it reflects gateway-managed TTS state.
- Use `tts providers`, `tts voices`, and `tts set-provider` to inspect and configure TTS behavior.

## Video

Use `video` for generation and description.

```bash
openclaw infer video generate --prompt "cinematic sunset over the ocean" --json
openclaw infer video generate --prompt "slow drone shot over a forest lake" --resolution 768P --duration 6 --json
openclaw infer video describe --file ./clip.mp4 --json
openclaw infer video describe --file ./clip.mp4 --model openai/gpt-4.1-mini --json
```

Notes:

- `video generate` accepts `--size`, `--aspect-ratio`, `--resolution`, `--duration`, `--audio`, `--watermark`, and `--timeout-ms` and forwards them to the video-generation runtime.
- `--model` must be `<provider/model>` for `video describe`.

## Web

Use `web` for search and fetch workflows.

```bash
openclaw infer web search --query "OpenClaw docs" --json
openclaw infer web search --query "OpenClaw infer web providers" --json
openclaw infer web fetch --url https://docs.openclaw.ai/cli/infer --json
openclaw infer web providers --json
```

Notes:

- Use `web providers` to inspect available, configured, and selected providers.

## Embedding

Use `embedding` for vector creation and embedding provider inspection.

```bash
openclaw infer embedding create --text "friendly lobster" --json
openclaw infer embedding create --text "customer support ticket: delayed shipment" --model openai/text-embedding-3-large --json
openclaw infer embedding providers --json
```

## JSON output

Infer commands normalize JSON output under a shared envelope:

```json
{
  "ok": true,
  "capability": "image.generate",
  "transport": "local",
  "provider": "openai",
  "model": "gpt-image-2",
  "attempts": [],
  "outputs": []
}
```

Top-level fields are stable:

- `ok`
- `capability`
- `transport`
- `provider`
- `model`
- `attempts`
- `outputs`
- `error`

For generated media commands, `outputs` contains files written by OpenClaw. Use
the `path`, `mimeType`, `size`, and any media-specific dimensions in that array
for automation instead of parsing human-readable stdout.

## Common pitfalls

```bash
# Bad
openclaw infer media image generate --prompt "friendly lobster"

# Good
openclaw infer image generate --prompt "friendly lobster"
```

```bash
# Bad
openclaw infer audio transcribe --file ./memo.m4a --model whisper-1 --json

# Good
openclaw infer audio transcribe --file ./memo.m4a --model openai/whisper-1 --json
```

## Notes

- `openclaw capability ...` is an alias for `openclaw infer ...`.

## Related

- [CLI reference](/cli)
- [Models](/concepts/models)
