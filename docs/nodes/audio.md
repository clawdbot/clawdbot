---
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"
read_when:
  - Changing audio transcription or media handling
title: "Audio and voice notes"
---

This page covers inbound transcription and voice-note handling. For inline
audio and video players in OpenClaw chat clients, see
[Media playback](/nodes/media-playback).

## What it does

When audio understanding is enabled (or auto-detected), OpenClaw:

1. Locates the first audio attachment (local path or URL) and downloads it if needed.
2. Enforces `maxBytes` before sending to each model entry.
3. Runs the first eligible model entry in order (provider or CLI); if an entry fails or skips (size/timeout), the next entry is tried.
4. On success, replaces `Body` with an `[Audio]` block and sets `{{Transcript}}`.

When transcription succeeds, `CommandBody`/`RawBody` are also set to the transcript so slash commands still work. With `--verbose`, logs show when transcription runs and when it replaces the body.

## Auto-detection (default)

If you have not configured models and `tools.media.audio.enabled` is not `false`, OpenClaw auto-detects in this order and stops at the first working option:

1. **Active reply model**, when its provider supports audio understanding.
2. **Configured provider auth** — any `models.providers.*` entry with auth available for a provider that supports audio transcription. This is checked before local CLIs, so a configured API key always wins over a local binary on `PATH`.
   Provider priority when multiple are configured: Groq, OpenAI, xAI, Deepgram, Google, SenseAudio, ElevenLabs, Mistral.
3. **Local CLIs** (only if no provider auth resolved). OpenClaw builds an ordered fallback list:
   - `whisper-cli`, before CPU defaults only when an earlier model invocation in the current process observed Metal or CUDA
   - `sherpa-onnx-offline` on its default CPU provider (requires `SHERPA_ONNX_MODEL_DIR` with `tokens.txt`, `encoder.onnx`, `decoder.onnx`, and `joiner.onnx`)
   - `whisper-cli` when Metal/CUDA is only build-capable or the selected backend is otherwise unobserved
   - `parakeet-mlx` on Apple Silicon (MLX-capable; device use remains unobserved)
   - `whisper` (Python CLI; downloads models automatically)

Install/link provenance is capability evidence, not execution evidence. It never moves a candidate ahead of CPU sherpa by itself. OpenClaw does not load a model during setup or status checks just to probe a backend.
Auto-detected whisper.cpp keeps its normal model-run logs enabled so OpenClaw can record the upstream `using … backend` line. Explicit CLI entries keep their configured output flags.

Gemini CLI and Antigravity are not auto-detected for media understanding. Audio
does not use a CLI fallback beyond the local binaries above.

To disable auto-detection, set `tools.media.audio.enabled: false`. To customize, add capability-tagged entries to `tools.media.models`.

<Note>
Binary detection is best-effort across macOS/Linux/Windows. Make sure the CLI is on `PATH` (`~` is expanded), or set an explicit CLI model with a full command path.
</Note>

Inspect the local selection without transcribing audio:

```bash
openclaw capability audio providers
openclaw doctor --lint --only core/doctor/local-audio-acceleration --severity-min info
```

The provider inventory reports the local fallback winner separately from global provider selection, plus capable, requested, and observed backend fields. After transcription runs, `/status` reports the requested or observed backend in the media line. Explicit audio-capable `tools.media.models` CLI entries still bypass auto-selection; use their backend-specific flags such as sherpa `--provider=cuda` or whisper.cpp `--no-gpu`/`--device`.

## OpenAI transcription alongside ChatGPT/Codex OAuth

OpenAI audio uses the standard `/v1/audio/transcriptions` endpoint with the
selected API-key or ChatGPT/Codex OAuth profile. An OAuth login can transcribe
when the account permits it; access, quota, and billing remain account-specific.
The default model is `gpt-4o-transcribe`; configured models, prompts, and language
hints are sent through the same multipart request for either credential class.
Custom endpoints and request overrides require an API-key profile.

Automatic selection can try another provider or local backend when the OpenAI
plugin rejects authentication or configuration before uploading audio. The
rejection remains visible in the attempt results; missing credentials simply
leave that candidate unavailable. Once a provider attempts transcription,
upload or HTTP failures are reported without automatically sending the recording
to another provider or switching credential classes. Explicit model lists retain
their configured fallback order.

Unless a profile or OAuth auth mode is explicitly selected, an authored OpenAI
provider key takes precedence over ambient OAuth for audio.
To keep audio billing explicitly separate while keeping OAuth first for normal
text and reasoning, create a dedicated API-key profile and select it only on the
audio model entry. This is optional; an API key is not required merely to choose
a transcription model.

Repeat these steps for every agent that can receive audio. For a single-agent
installation, run them once for that agent.

1. List the agent's OpenAI profiles so you can copy the exact OAuth profile ID:

   ```bash
   openclaw models auth list --agent AGENT_NAME_HERE --provider openai
   ```

2. Create a dedicated API-key profile. This command prompts for the key; paste it
   into the prompt rather than putting it in the command line:

   ```bash
   openclaw models auth paste-api-key --agent AGENT_NAME_HERE --provider openai --profile-id openai:CUSTOM_PROFILE_NAME_HERE
   ```

   Example:

   ```bash
   openclaw models auth paste-api-key --agent smith --provider openai --profile-id openai:audio
   ```

3. Put the OAuth profile first and the audio API-key profile second in the agent's
   OpenAI auth order. Replace the first profile ID with the exact OAuth profile ID
   reported by the list command:

   ```bash
   openclaw models auth order set --agent AGENT_NAME_HERE --provider openai openai:YOUR_OPENAI_ACCOUNT_EMAIL_ADDRESS openai:CUSTOM_PROFILE_NAME_HERE
   ```

   Example:

   ```bash
   openclaw models auth order set --agent smith --provider openai openai:youremailaddress@email.com openai:audio
   ```

4. Configure the OpenAI transcription model and explicitly select the API-key
   profile:

   ```json5
   {
     tools: {
       media: {
         models: [
           {
             provider: "openai",
             model: "gpt-transcribe",
             profile: "openai:audio",
             baseUrl: "https://api.openai.com/v1",
             capabilities: ["audio"],
           },
         ],
         audio: { enabled: true },
       },
     },
   }
   ```

   If you chose a different custom profile name, use that exact profile ID in
   `profile`. You can also substitute `gpt-4o-mini-transcribe` for the model.

The `profile` field is not required when OpenClaw can unambiguously select a
compatible API-key profile, but it is strongly recommended. Explicit selection
keeps audio routing deterministic if another OpenAI API-key profile exists now or
is added later. The auth order still keeps the OAuth profile first for ordinary
provider resolution.

<Warning>
Do not set `models.providers.openai.apiKey` merely to enable transcription on an
installation that uses ChatGPT/Codex OAuth for normal inference. That setting is
provider-wide rather than scoped to the audio model entry.
</Warning>

## Config examples

### Provider + CLI fallback (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] },
        {
          type: "cli",
          command: "whisper",
          args: ["--model", "base", "{{AttachmentPath}}"],
          timeoutSeconds: 45,
          capabilities: ["audio"],
        },
      ],
      audio: { enabled: true, preferredModel: "openai/gpt-4o-transcribe" },
    },
  },
}
```

### Provider-only (Deepgram)

```json5
{
  tools: {
    media: {
      models: [{ provider: "deepgram", model: "nova-3", capabilities: ["audio"] }],
      audio: { enabled: true },
    },
  },
}
```

### Provider-only (Mistral Voxtral)

```json5
{
  tools: {
    media: {
      models: [{ provider: "mistral", model: "voxtral-mini-latest", capabilities: ["audio"] }],
      audio: { enabled: true },
    },
  },
}
```

### Provider-only (SenseAudio)

```json5
{
  tools: {
    media: {
      models: [
        {
          provider: "senseaudio",
          model: "senseaudio-asr-pro-1.5-260319",
          capabilities: ["audio"],
        },
      ],
      audio: { enabled: true },
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
        echoTranscript: true,
        echoFormat: '📝 "{transcript}"',
      },
    },
  },
}
```

## Notes and limits

- Provider auth follows the standard model auth order (auth profiles, env vars, `models.providers.*.apiKey`).
- Groq setup details: [Groq](/providers/groq).
- Deepgram picks up `DEEPGRAM_API_KEY` when `provider: "deepgram"` is used. Setup details: [Deepgram](/providers/deepgram).
- Mistral setup details: [Mistral](/providers/mistral).
- SenseAudio picks up `SENSEAUDIO_API_KEY` when `provider: "senseaudio"` is used. Setup details: [SenseAudio](/providers/senseaudio).
- Audio providers can use defaults under `tools.media.audio` or override `baseUrl`, `headers`, `providerOptions`, and limits on their `tools.media.models[]` entry.
- Leave `tools.media.audio.language` unset for language autodetection. OpenAI-compatible transcription requests then omit the implicit English prompt; explicit custom prompts and language hints are preserved. Use transcription prompts for context or spelling in the audio's language, not instructions to the downstream agent.
- The built-in audio size cap is 20MB. An entry-level `maxBytes` override can change it; oversize audio is skipped for that model and the next entry is tried.
- Audio files below 1024 bytes are skipped before provider/CLI transcription.
- Default `maxChars` for audio is **unset** (full transcript). Set `tools.media.audio.maxChars` or per-entry `maxChars` to trim output.
- OpenAI auto-detect default is `gpt-4o-transcribe`; set `model: "gpt-4o-mini-transcribe"` for a cheaper/faster option.
- Transcript is available to templates as `{{Transcript}}`.
- `tools.media.audio.echoTranscript` is off by default; `echoFormat` accepts a `{transcript}` placeholder.
- CLI stdout is capped at 5MB; keep CLI output concise.
- CLI `args` should use `{{AttachmentPath}}` for the local audio file path. Run `openclaw doctor --fix` to migrate deprecated `{input}` placeholders from older `audio.transcription.command` configs (retired key: `audio.transcription`, replaced by `tools.media.models`). `{{MediaPath}}` remains a deprecated compatibility alias.
- `tools.media.concurrency` bounds media tasks; it is not a GPU scheduler.

### Resident local STT

Auto-detected local STT remains process-per-request. OpenClaw does not currently manage a resident whisper.cpp server because the standard Homebrew `whisper-cpp` package disables that server, while the upstream example has no configured bounded admission queue. A plugin-owned resident lifecycle needs a maintained packaged worker with health/startup, model residency, bounded queueing, cancellation/timeout, loopback-only no-auth operation, and no cloud fallback before it can be enabled safely.

### Proxy environment support

Provider-based audio transcription honors standard outbound proxy env vars, matching undici's `EnvHttpProxyAgent` semantics:

- `HTTPS_PROXY` / `https_proxy`
- `HTTP_PROXY` / `http_proxy`
- `ALL_PROXY` / `all_proxy`

Lowercase variables take precedence over uppercase; `NO_PROXY`/`no_proxy` entries (hostnames, `*.suffix`, or `host:port`) bypass the proxy. If no proxy env vars are set, direct egress is used. If proxy setup fails (malformed URL), OpenClaw logs a warning and falls back to direct fetch.

## Mention detection in groups

On channels that support audio preflight, OpenClaw transcribes audio **before** checking for mentions when `requireMention: true` is set for a group chat. This lets a captionless voice note pass the mention gate when its transcript contains a configured mention pattern. Channel-specific docs describe transports that require a typed mention instead.

**How it works:**

1. If a voice message has no text body and the group requires mentions, OpenClaw performs a preflight transcription of the first audio attachment.
2. The transcript is checked for mention patterns (for example `@BotName`, emoji triggers).
3. If a mention is found, the message proceeds through the full reply pipeline.

**Fallback behavior:** if preflight transcription fails (timeout, API error, etc.), the message falls back to text-only mention detection so mixed messages (text + audio) are never dropped.

**Opt-out per Telegram group/topic:**

- Set `channels.telegram.groups.<chatId>.disableAudioPreflight: true` to skip preflight transcript mention checks for that group.
- Set `channels.telegram.groups.<chatId>.topics.<threadId>.disableAudioPreflight` to override per-topic (`true` to skip, `false` to force-enable).
- Default is `false` (preflight enabled when mention-gated conditions match).

**Example:** a user sends a voice note saying "Hey @Claude, what's the weather?" in a Telegram group with `requireMention: true`. The voice note is transcribed, the mention is detected, and the agent replies.

## Gotchas

- Scope rules use first-match-wins; `chatType` is normalized to `direct`, `group`, or `channel`.
- Ensure your CLI exits 0 and prints plain text; JSON output needs to be massaged via `jq -r .text`.
- Known file-output modes are authoritative: an empty or missing inferred transcript file produces no transcript instead of falling back to CLI progress output.
- For `parakeet-mlx`, use `--output-format txt` (or `all`) with `--output-dir` and the default `{filename}` output template. The upstream `PARAKEET_OUTPUT_FORMAT` and `PARAKEET_OUTPUT_TEMPLATE` environment variables are also honored. OpenClaw reads `<output-dir>/<media-basename>.txt`; the default `srt` format, other formats, and custom output templates continue to use stdout.
- Keep timeouts reasonable (`timeoutSeconds`, default 60s) to avoid blocking the reply queue.
- Preflight transcription only processes the **first** untranscribed audio attachment for mention detection, even when the main phase prefers the last attachment or processes all attachments. Additional audio attachments follow the configured policy during the main media-understanding phase; an empty preflight result does not mark an attachment as transcribed.
- The preflight transcript stays in the model-facing message when later media or link processing adds context. A separate channel envelope does not replace that prepared text.

## Related

- [Media playback](/nodes/media-playback)
- [Media understanding](/nodes/media-understanding)
- [Talk mode](/nodes/talk)
- [Voice wake](/nodes/voicewake)
