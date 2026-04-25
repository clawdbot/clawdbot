---
summary: "Text-to-speech (TTS) for outbound replies"
read_when:
  - Enabling text-to-speech for replies
  - Configuring TTS providers or limits
  - Using /tts commands
title: "Text-to-speech"
---

OpenClaw can convert outbound replies into audio using ElevenLabs, Google Gemini, Gradium, Microsoft, MiniMax, OpenAI, Vydra, or xAI.
It works anywhere OpenClaw can send audio.

## Supported services

- **ElevenLabs** (primary or fallback provider)
- **Google Gemini** (primary or fallback provider; uses Gemini API TTS)
- **Gradium** (primary or fallback provider; supports voice-note and telephony output)
- **Microsoft** (primary or fallback provider; current bundled implementation uses `node-edge-tts`)
- **MiniMax** (primary or fallback provider; uses the T2A v2 API)
- **OpenAI** (primary or fallback provider; also used for summaries)
- **Vydra** (primary or fallback provider; shared image, video, and speech provider)
- **xAI** (primary or fallback provider; uses the xAI TTS API)

### Microsoft speech notes

The bundled Microsoft speech provider currently uses Microsoft Edge's online
neural TTS service via the `node-edge-tts` library. It's a hosted service (not
local), uses Microsoft endpoints, and does not require an API key.
`node-edge-tts` exposes speech configuration options and output formats, but
not all options are supported by the service. Legacy config and directive input
using `edge` still works and is normalized to `microsoft`.

Because this path is a public web service without a published SLA or quota,
treat it as best-effort. If you need guaranteed limits and support, use OpenAI
or ElevenLabs.

## Optional keys

If you want OpenAI, ElevenLabs, Google Gemini, Gradium, MiniMax, Vydra, or xAI:

- `ELEVENLABS_API_KEY` (or `XI_API_KEY`)
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)
- `GRADIUM_API_KEY`
- `MINIMAX_API_KEY`
- `OPENAI_API_KEY`
- `VYDRA_API_KEY`
- `XAI_API_KEY`

Microsoft speech does **not** require an API key.

If multiple providers are configured, the selected provider is used first and the others are fallback options.
Auto-summary uses the configured `summaryModel` (or `agents.defaults.model.primary`),
so that provider must also be authenticated if you enable summaries.

## Service links

- [OpenAI Text-to-Speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [Gradium](/providers/gradium)
- [MiniMax T2A v2 API](https://platform.minimaxi.com/document/T2A%20V2)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)
- [xAI Text to Speech](https://docs.x.ai/developers/rest-api-reference/inference/voice#text-to-speech-rest)

## Is it enabled by default?

No. Auto‑TTS is **off** by default. Enable it in config with
`messages.tts.auto` or locally with `/tts on`.

When `messages.tts.provider` is unset, OpenClaw picks the first configured
speech provider in registry auto-select order.

## Config

TTS config lives under `messages.tts` in `openclaw.json`.
Full schema is in [Gateway configuration](/gateway/configuration).

### Minimal config (enable + provider)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI primary with ElevenLabs fallback

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      providers: {
        openai: {
          apiKey: "openai_api_key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
        elevenlabs: {
          apiKey: "elevenlabs_api_key",
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "voice_id",
          modelId: "eleven_multilingual_v2",
          seed: 42,
          applyTextNormalization: "auto",
          languageCode: "en",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0.0,
            useSpeakerBoost: true,
            speed: 1.0,
          },
        },
      },
    },
  },
}
```

### Microsoft primary (no API key)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "microsoft",
      providers: {
        microsoft: {
          enabled: true,
          voice: "en-US-MichelleNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          rate: "+10%",
          pitch: "-5%",
        },
      },
    },
  },
}
```

### MiniMax primary

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "minimax",
      providers: {
        minimax: {
          apiKey: "minimax_api_key",
          baseUrl: "https://api.minimax.io",
          model: "speech-2.8-hd",
          voiceId: "English_expressive_narrator",
          speed: 1.0,
          vol: 1.0,
          pitch: 0,
        },
      },
    },
  },
}
```

### Google Gemini primary

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "google",
      providers: {
        google: {
          apiKey: "gemini_api_key",
          model: "gemini-3.1-flash-tts-preview",
          voiceName: "Kore",
        },
      },
    },
  },
}
```

Google Gemini TTS uses the Gemini API key path. A Google Cloud Console API key
restricted to the Gemini API is valid here, and it is the same style of key used
by the bundled Google image-generation provider. Resolution order is
`messages.tts.providers.google.apiKey` -> `models.providers.google.apiKey` ->
`GEMINI_API_KEY` -> `GOOGLE_API_KEY`.

### xAI primary

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "xai",
      providers: {
        xai: {
          apiKey: "xai_api_key",
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          speed: 1.0,
        },
      },
    },
  },
}
```

xAI TTS uses the same `XAI_API_KEY` path as the bundled Grok model provider.
Resolution order is `messages.tts.providers.xai.apiKey` -> `XAI_API_KEY`.
Current live voices are `ara`, `eve`, `leo`, `rex`, `sal`, and `una`; `eve` is
the default. `language` accepts a BCP-47 tag or `auto`.

### OpenRouter primary

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openrouter",
      providers: {
        openrouter: {
          apiKey: "openrouter_api_key",
          model: "hexgrad/kokoro-82m",
          voice: "af_alloy",
          responseFormat: "mp3",
        },
      },
    },
  },
}
```

OpenRouter TTS uses the same `OPENROUTER_API_KEY` path as the bundled
OpenRouter model provider. Resolution order is
`messages.tts.providers.openrouter.apiKey` ->
`models.providers.openrouter.apiKey` -> `OPENROUTER_API_KEY`.

### Gradium primary

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "gradium",
      providers: {
        gradium: {
          apiKey: "gradium_api_key",
          baseUrl: "https://api.gradium.ai",
          voiceId: "YTpq7expH9539ERJ",
        },
      },
    },
  },
}
```

### Disable Microsoft speech

```json5
{
  messages: {
    tts: {
      providers: {
        microsoft: {
          enabled: false,
        },
      },
    },
  },
}
```

### Custom limits + prefs path

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Only reply with audio after an inbound voice message

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Disable auto-summary for long replies

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Then run:

```
/tts summary off
```

### Notes on fields

- `auto`: auto‑TTS mode (`off`, `always`, `inbound`, `tagged`).
  - `inbound` only sends audio after an inbound voice message.
  - `tagged` only sends audio when the reply includes `[[tts:key=value]]` directives or a `[[tts:text]]...[[/tts:text]]` block.
- `enabled`: legacy toggle (doctor migrates this to `auto`).
- `mode`: `"final"` (default) or `"all"` (includes tool/block replies).
- `provider`: speech provider id such as `"elevenlabs"`, `"google"`, `"gradium"`, `"microsoft"`, `"minimax"`, `"openai"`, `"vydra"`, or `"xai"` (fallback is automatic).
- If `provider` is **unset**, OpenClaw uses the first configured speech provider in registry auto-select order.
- Legacy `provider: "edge"` config is repaired by `openclaw doctor --fix` and
  rewritten to `provider: "microsoft"`.
- `summaryModel`: optional cheap model for auto-summary; defaults to `agents.defaults.model.primary`.
  - Accepts `provider/model` or a configured model alias.
- `modelOverrides`: allow the model to emit TTS directives (on by default).
  - `allowProvider` defaults to `false` (provider switching is opt-in).
- `providers.<id>`: provider-owned settings keyed by speech provider id.
- Legacy direct provider blocks (`messages.tts.openai`, `messages.tts.elevenlabs`, `messages.tts.microsoft`, `messages.tts.edge`) are repaired by `openclaw doctor --fix`; committed config should use `messages.tts.providers.<id>`.
- Legacy `messages.tts.providers.edge` is also repaired by `openclaw doctor --fix`; committed config should use `messages.tts.providers.microsoft`.
- `maxTextLength`: hard cap for TTS input (chars). `/tts audio` fails if exceeded.
- `timeoutMs`: request timeout (ms).
- `prefsPath`: override the local prefs JSON path (provider/limit/summary).
- `apiKey` values fall back to env vars (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `GRADIUM_API_KEY`, `MINIMAX_API_KEY`, `OPENAI_API_KEY`, `VYDRA_API_KEY`, `XAI_API_KEY`).
- `providers.elevenlabs.baseUrl`: override ElevenLabs API base URL.
- `providers.openai.baseUrl`: override the OpenAI TTS endpoint.
  - Resolution order: `messages.tts.providers.openai.baseUrl` -> `OPENAI_TTS_BASE_URL` -> `https://api.openai.com/v1`
  - Non-default values are treated as OpenAI-compatible TTS endpoints, so custom model and voice names are accepted.
- `providers.elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `providers.elevenlabs.applyTextNormalization`: `auto|on|off`
- `providers.elevenlabs.languageCode`: 2-letter ISO 639-1 (e.g. `en`, `de`)
- `providers.elevenlabs.seed`: integer `0..4294967295` (best-effort determinism)
- `providers.minimax.baseUrl`: override MiniMax API base URL (default `https://api.minimax.io`, env: `MINIMAX_API_HOST`).
- `providers.minimax.model`: TTS model (default `speech-2.8-hd`, env: `MINIMAX_TTS_MODEL`).
- `providers.minimax.voiceId`: voice identifier (default `English_expressive_narrator`, env: `MINIMAX_TTS_VOICE_ID`).
- `providers.minimax.speed`: playback speed `0.5..2.0` (default 1.0).
- `providers.minimax.vol`: volume `(0, 10]` (default 1.0; must be greater than 0).
- `providers.minimax.pitch`: integer pitch shift `-12..12` (default 0). Fractional values are truncated before calling MiniMax T2A because the API rejects non-integer pitch values.
- `providers.google.model`: Gemini TTS model (default `gemini-3.1-flash-tts-preview`).
- `providers.google.voiceName`: Gemini prebuilt voice name (default `Kore`; `voice` is also accepted).
- `providers.google.audioProfile`: natural-language style prompt prepended before the spoken text.
- `providers.google.speakerName`: optional speaker label prepended before the spoken text when your TTS prompt uses a named speaker.
- `providers.google.baseUrl`: override the Gemini API base URL. Only `https://generativelanguage.googleapis.com` is accepted.
  - If `messages.tts.providers.google.apiKey` is omitted, TTS can reuse `models.providers.google.apiKey` before env fallback.
- `providers.gradium.baseUrl`: override Gradium API base URL (default `https://api.gradium.ai`).
- `providers.gradium.voiceId`: Gradium voice identifier (default Emma, `YTpq7expH9539ERJ`).
- `providers.xai.apiKey`: xAI TTS API key (env: `XAI_API_KEY`).
- `providers.xai.baseUrl`: override the xAI TTS base URL (default `https://api.x.ai/v1`, env: `XAI_BASE_URL`).
- `providers.xai.voiceId`: xAI voice id (default `eve`; current live voices: `ara`, `eve`, `leo`, `rex`, `sal`, `una`).
- `providers.xai.language`: BCP-47 language code or `auto` (default `en`).
- `providers.xai.responseFormat`: `mp3`, `wav`, `pcm`, `mulaw`, or `alaw` (default `mp3`).
- `providers.xai.speed`: provider-native speed override.
- `providers.openrouter.apiKey`: OpenRouter API key (env: `OPENROUTER_API_KEY`; can reuse `models.providers.openrouter.apiKey`).
- `providers.openrouter.baseUrl`: override the OpenRouter TTS base URL (default `https://openrouter.ai/api/v1`; legacy `https://openrouter.ai/v1` is normalized).
- `providers.openrouter.model`: OpenRouter TTS model id (default `hexgrad/kokoro-82m`; `modelId` is also accepted).
- `providers.openrouter.voice`: provider-specific voice id (default `af_alloy`; `voiceId` is also accepted).
- `providers.openrouter.responseFormat`: `mp3` or `pcm` (default `mp3`).
- `providers.openrouter.speed`: provider-native speed override.
- `providers.microsoft.enabled`: allow Microsoft speech usage (default `true`; no API key).
- `providers.microsoft.voice`: Microsoft neural voice name (e.g. `en-US-MichelleNeural`).
- `providers.microsoft.lang`: language code (e.g. `en-US`).
- `providers.microsoft.outputFormat`: Microsoft output format (e.g. `audio-24khz-48kbitrate-mono-mp3`).
  - See Microsoft Speech output formats for valid values; not all formats are supported by the bundled Edge-backed transport.
- `providers.microsoft.rate` / `providers.microsoft.pitch` / `providers.microsoft.volume`: percent strings (e.g. `+10%`, `-5%`).
- `providers.microsoft.saveSubtitles`: write JSON subtitles alongside the audio file.
- `providers.microsoft.proxy`: proxy URL for Microsoft speech requests.
- `providers.microsoft.timeoutMs`: request timeout override (ms).
- `edge.*`: legacy alias for the same Microsoft settings. Run
  `openclaw doctor --fix` to rewrite persisted config to `providers.microsoft`.

## Model-driven overrides (default on)

By default, the model **can** emit TTS directives for a single reply.
When `messages.tts.auto` is `tagged`, these directives are required to trigger audio.

When enabled, the model can emit `[[tts:...]]` directives to override the voice
for a single reply, plus an optional `[[tts:text]]...[[/tts:text]]` block to
provide expressive tags (laughter, singing cues, etc) that should only appear in
the audio.

`provider=...` directives are ignored unless `modelOverrides.allowProvider: true`.

Example reply payload:

```
Here you go.

[[tts:voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

Available directive keys (when enabled):

- `provider` (registered speech provider id, for example `openai`, `elevenlabs`, `google`, `gradium`, `minimax`, `microsoft`, `vydra`, or `xai`; requires `allowProvider: true`)
- `voice` (OpenAI or Gradium voice), `voiceName` / `voice_name` / `google_voice` (Google voice), or `voiceId` (ElevenLabs / Gradium / MiniMax / xAI)
- `model` (OpenAI TTS model, ElevenLabs model id, or MiniMax model) or `google_model` (Google TTS model)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `vol` / `volume` (MiniMax volume, 0-10)
- `pitch` (MiniMax integer pitch, -12 to 12; fractional values are truncated before the MiniMax request)
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Disable all model overrides:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Optional allowlist (enable provider switching while keeping other knobs configurable):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: true,
        allowSeed: false,
      },
    },
  },
}
```

## Per-user preferences

Slash commands write local overrides to `prefsPath` (default:
`~/.openclaw/settings/tts.json`, override with `OPENCLAW_TTS_PREFS` or
`messages.tts.prefsPath`).

Stored fields:

- `enabled`
- `provider`
- `maxLength` (summary threshold; default 1500 chars)
- `summarize` (default `true`)

These override `messages.tts.*` for that host.

## Output formats (fixed)

- **Feishu / Matrix / Telegram / WhatsApp**: voice-note replies prefer Opus (`opus_48000_64` from ElevenLabs, `opus` from OpenAI).
  - 48kHz / 64kbps is a good voice message tradeoff.
- **Feishu**: when a voice-note reply is produced as MP3/WAV/M4A or another
  likely audio file, the Feishu plugin transcodes it to 48kHz Ogg/Opus with
  `ffmpeg` before sending the native `audio` bubble. If conversion fails, Feishu
  receives the original file as an attachment.
- **Other channels**: MP3 (`mp3_44100_128` from ElevenLabs, `mp3` from OpenAI).
  - 44.1kHz / 128kbps is the default balance for speech clarity.
- **MiniMax**: MP3 (`speech-2.8-hd` model, 32kHz sample rate) for normal audio attachments. For voice-note targets such as Feishu and Telegram, OpenClaw transcodes the MiniMax MP3 to 48kHz Opus with `ffmpeg` before delivery.
- **Google Gemini**: Gemini API TTS returns raw 24kHz PCM. OpenClaw wraps it as WAV for audio attachments and returns PCM directly for Talk/telephony. Native Opus voice-note format is not supported by this path.
- **Gradium**: WAV for audio attachments, Opus for voice-note targets, and `ulaw_8000` at 8 kHz for telephony.
- **xAI**: MP3 by default; `responseFormat` may be `mp3`, `wav`, `pcm`, `mulaw`, or `alaw`. OpenClaw uses xAI's batch REST TTS endpoint and returns a complete audio attachment; xAI's streaming TTS WebSocket is not used by this provider path. Native Opus voice-note format is not supported by this path.
- **Microsoft**: uses `microsoft.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).
  - The bundled transport accepts an `outputFormat`, but not all formats are available from the service.
  - Output format values follow Microsoft Speech output formats (including Ogg/WebM Opus).
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need
    guaranteed Opus voice messages.
  - If the configured Microsoft output format fails, OpenClaw retries with MP3.

OpenAI/ElevenLabs output formats are fixed per channel (see above).

## Auto-TTS behavior

When enabled, OpenClaw:

- skips TTS if the reply already contains media or a `MEDIA:` directive.
- skips very short replies (< 10 chars).
- summarizes long replies when enabled using `agents.defaults.model.primary` (or `summaryModel`).
- attaches the generated audio to the reply.

If the reply exceeds `maxLength` and summary is off (or no API key for the
summary model), audio
is skipped and the normal text reply is sent.

## Flow diagram

```
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / MEDIA: / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled?
                            no  -> send text
                            yes -> summarize (summaryModel or agents.defaults.model.primary)
                                      -> TTS -> attach audio
```

## Slash command usage

There is a single command: `/tts`.
See [Slash commands](/tools/slash-commands) for enablement details.

Discord note: `/tts` is a built-in Discord command, so OpenClaw registers
`/voice` as the native command there. Text `/tts ...` still works.

```
/tts off
/tts on
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hello from OpenClaw
```

Notes:

- Commands require an authorized sender (allowlist/owner rules still apply).
- `commands.text` or native command registration must be enabled.
- Config `messages.tts.auto` accepts `off|always|inbound|tagged`.
- `/tts on` writes the local TTS preference to `always`; `/tts off` writes it to `off`.
- Use config when you want `inbound` or `tagged` defaults.
- `limit` and `summary` are stored in local prefs, not the main config.
- `/tts audio` generates a one-off audio reply (does not toggle TTS on).
- `/tts status` includes fallback visibility for the latest attempt:
  - success fallback: `Fallback: <primary> -> <used>` plus `Attempts: ...`
  - failure: `Error: ...` plus `Attempts: ...`
  - detailed diagnostics: `Attempt details: provider:outcome(reasonCode) latency`
- OpenAI and ElevenLabs API failures now include parsed provider error detail and request id (when returned by the provider), which is surfaced in TTS errors/logs.

## Agent tool

The `tts` tool converts text to speech and returns an audio attachment for
reply delivery. When the channel is Feishu, Matrix, Telegram, or WhatsApp,
the audio is delivered as a voice message rather than a file attachment.
Feishu can transcode non-Opus TTS output on this path when `ffmpeg` is
available.
It accepts optional `channel` and `timeoutMs` fields; `timeoutMs` is a
per-call provider request timeout in milliseconds.

## Gateway RPC

Gateway methods:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`

## Related

- [Media overview](/tools/media-overview)
- [Music generation](/tools/music-generation)
- [Video generation](/tools/video-generation)
