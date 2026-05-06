---
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"
read_when:
  - Changing audio transcription or media handling
title: "Audio and voice notes"
---

# Audio / Voice Notes (2026-01-17)

## What works

- **Media understanding (audio)**: If audio understanding is enabled (or auto-detected), OpenClaw:
  1. Locates the first audio attachment (local path or URL) and downloads it if needed.
  2. Enforces `maxBytes` before sending to each model entry.
  3. Runs the first eligible model entry in order (provider or CLI).
  4. If it fails or skips (size/timeout), it tries the next entry.
  5. On success, it replaces `Body` with an `[Audio]` block and sets `{{Transcript}}`.
- **Command parsing**: When transcription succeeds, `CommandBody`/`RawBody` are set to the transcript so slash commands still work.
- **Verbose logging**: In `--verbose`, we log when transcription runs and when it replaces the body.

## Auto-detection (default)

If you **don't configure models** and `tools.media.audio.enabled` is **not** set to `false`,
OpenClaw auto-detects in this order and stops at the first working option:

1. **Active reply model** when its provider supports audio understanding.
2. **Local CLIs** (if installed)
   - `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with encoder/decoder/joiner/tokens)
   - `whisper-cli` (from `whisper-cpp`; uses `WHISPER_CPP_MODEL` or the bundled tiny model)
   - `whisper` (Python CLI; downloads models automatically)
3. **Gemini CLI** (`gemini`) using `read_many_files`
4. **Provider auth**
   - Configured `models.providers.*` entries that support audio are tried first
   - Bundled fallback order: OpenAI → Groq → xAI → Deepgram → Google → SenseAudio → ElevenLabs → Mistral

To disable auto-detection, set `tools.media.audio.enabled: false`.
To customize, set `tools.media.audio.models`.
Note: Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (we expand `~`), or set an explicit CLI model with a full command path.

## Config examples

### Provider + CLI fallback (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Provider-only with scope gating

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Provider-only (Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

### Provider-only (Mistral Voxtral)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

### Provider-only (SenseAudio)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "senseaudio", model: "senseaudio-asr-pro-1.5-260319" }],
      },
    },
  },
}
```

### Echo transcript to chat (opt-in)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        echoTranscript: true, // default is false
        echoFormat: '📝 "{transcript}"', // optional, supports {transcript}
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

## Notes and limits

- Provider auth follows the standard model auth order (auth profiles, env vars, `models.providers.*.apiKey`).
- Groq setup details: [Groq](/providers/groq).
- Deepgram picks up `DEEPGRAM_API_KEY` when `provider: "deepgram"` is used.
- Deepgram setup details: [Deepgram (audio transcription)](/providers/deepgram).
- Mistral setup details: [Mistral](/providers/mistral).
- SenseAudio picks up `SENSEAUDIO_API_KEY` when `provider: "senseaudio"` is used.
- SenseAudio setup details: [SenseAudio](/providers/senseaudio).
- Audio providers can override `baseUrl`, `headers`, and `providerOptions` via `tools.media.audio`.
- Default size cap is 20MB (`tools.media.audio.maxBytes`). Oversize audio is skipped for that model and the next entry is tried.
- Tiny/empty audio files below 1024 bytes are skipped before provider/CLI transcription.
- Default `maxChars` for audio is **unset** (full transcript). Set `tools.media.audio.maxChars` or per-entry `maxChars` to trim output.
- OpenAI auto default is `gpt-4o-mini-transcribe`; set `model: "gpt-4o-transcribe"` for higher accuracy.
- Use `tools.media.audio.attachments` to process multiple voice notes (`mode: "all"` + `maxAttachments`).
- Transcript is available to templates as `{{Transcript}}`.
- `tools.media.audio.echoTranscript` is off by default; enable it to send transcript confirmation back to the originating chat before agent processing.
- `tools.media.audio.echoFormat` customizes the echo text (placeholder: `{transcript}`).
- CLI stdout is capped (5MB); keep CLI output concise.
- CLI `args` should use `{{MediaPath}}` for the local audio file path. Run `openclaw doctor --fix` to migrate deprecated `{input}` placeholders from older `audio.transcription.command` configs.

### Proxy environment support

Provider-based audio transcription honors standard outbound proxy env vars:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `ALL_PROXY`
- `https_proxy`
- `http_proxy`
- `all_proxy`

If no proxy env vars are set, direct egress is used. If proxy config is malformed, OpenClaw logs a warning and falls back to direct fetch.

## Mention detection in groups

When `requireMention: true` is set for a group chat, OpenClaw now transcribes audio **before** checking for mentions. This allows voice notes to be processed even when they contain mentions.

**How it works:**

1. If a voice message has no text body and the group requires mentions, OpenClaw performs a "preflight" transcription.
2. The transcript is checked for mention patterns (e.g., `@BotName`, emoji triggers).
3. If a mention is found, the message proceeds through the full reply pipeline.
4. The transcript is used for mention detection so voice notes can pass the mention gate.

**Fallback behavior:**

- If transcription fails during preflight (timeout, API error, etc.), the message is processed based on text-only mention detection.
- This ensures that mixed messages (text + audio) are never incorrectly dropped.

**Opt-out per Telegram group/topic:**

- Set `channels.telegram.groups.<chatId>.disableAudioPreflight: true` to skip preflight transcript mention checks for that group.
- Set `channels.telegram.groups.<chatId>.topics.<threadId>.disableAudioPreflight` to override per-topic (`true` to skip, `false` to force-enable).
- Default is `false` (preflight enabled when mention-gated conditions match).

**Example:** A user sends a voice note saying "Hey @Claude, what's the weather?" in a Telegram group with `requireMention: true`. The voice note is transcribed, the mention is detected, and the agent replies.

## Gotchas

- Scope rules use first-match wins. `chatType` is normalized to `direct`, `group`, or `room`.
- Ensure your CLI exits 0 and prints plain text; JSON needs to be massaged via `jq -r .text`.
- For `parakeet-mlx`, if you pass `--output-dir`, OpenClaw reads `<output-dir>/<media-basename>.txt` when `--output-format` is `txt` (or omitted); non-`txt` output formats fall back to stdout parsing.
- Keep timeouts reasonable (`timeoutSeconds`, default 60s) to avoid blocking the reply queue.
- Preflight transcription only processes the **first** audio attachment for mention detection. Additional audio is processed during the main media understanding phase.

## Related

- [Media understanding](/nodes/media-understanding)
- [Talk mode](/nodes/talk)
- [Voice wake](/nodes/voicewake)
