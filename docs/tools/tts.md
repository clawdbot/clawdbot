---
summary: "Text-to-speech for outbound replies — providers, personas, slash commands, and per-channel output"
read_when:
  - Enabling text-to-speech for replies
  - Configuring a TTS provider, fallback chain, or persona
  - Using /tts commands or directives
title: "Text-to-speech"
sidebarTitle: "Text to speech (TTS)"
---

OpenClaw converts outbound replies into audio across **14 speech providers**:
native voice messages on Feishu, Matrix, Telegram, and WhatsApp; audio
attachments everywhere else; and PCM/Ulaw streams for telephony and Talk.

TTS is the speech-output half of Talk's `stt-tts` mode (`talk.speak` calls this
same synthesis path). Provider-native `realtime` Talk sessions synthesize
speech inside the realtime provider instead; `transcription` sessions never
synthesize an assistant voice reply.

## Quick start

<Steps>
  <Step title="Pick a provider">
    OpenAI and ElevenLabs are the most reliable hosted options. Microsoft and
    Local CLI work without an API key. See the [provider matrix](#supported-providers)
    for the full list.
  </Step>
  <Step title="Set the API key">
    Export the env var for your provider (for example `OPENAI_API_KEY`,
    `ELEVENLABS_API_KEY`). Microsoft and Local CLI need no key.
  </Step>
  <Step title="Enable in config">
    Set `tts.auto: "always"` and `tts.provider`:

    ```json5
    {
      tts: {
        auto: "always",
        provider: "elevenlabs",
      },
    }
    ```

  </Step>
  <Step title="Try it in chat">
    `/tts status` shows the current state. `/tts audio Hello from OpenClaw`
    sends a one-off audio reply.
  </Step>
</Steps>

<Note>
Auto-TTS is **off** by default. When `tts.provider` is unset,
OpenClaw picks the first configured provider in registry auto-select order.
The built-in `tts` agent tool is explicit-intent only: ordinary chat stays
text unless the user asks for audio, uses `/tts`, or enables Auto-TTS/directive
speech.
</Note>

## Supported providers

| Provider          | Auth                                                                                                             | Notes                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Azure Speech**  | `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` (also `AZURE_SPEECH_API_KEY`, `SPEECH_KEY`, `SPEECH_REGION`)          | Native Ogg/Opus voice-note output and telephony.                                            |
| **DeepInfra**     | `DEEPINFRA_API_KEY`                                                                                              | OpenAI-compatible TTS. Defaults to `hexgrad/Kokoro-82M`.                                    |
| **ElevenLabs**    | `ELEVENLABS_API_KEY` or `XI_API_KEY`                                                                             | Voice cloning, multilingual, deterministic via `seed`; streamed for Discord voice playback. |
| **Google Gemini** | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                                                                             | Gemini API batch TTS; persona-aware via `promptTemplate: "audio-profile-v1"`.               |
| **Gradium**       | `GRADIUM_API_KEY`                                                                                                | Voice-note and telephony output.                                                            |
| **Inworld**       | `INWORLD_API_KEY`                                                                                                | Streaming TTS API. Native Opus voice-note and PCM telephony.                                |
| **Local CLI**     | none                                                                                                             | Runs a configured local TTS command.                                                        |
| **Microsoft**     | none                                                                                                             | Public Edge neural TTS via `node-edge-tts`. Best-effort, no SLA.                            |
| **MiniMax**       | `MINIMAX_API_KEY` (or Token Plan: `MINIMAX_OAUTH_TOKEN`, `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`)      | T2A v2 API. Defaults to `speech-2.8-hd`.                                                    |
| **OpenAI**        | `OPENAI_API_KEY`                                                                                                 | Also used for auto-summary; supports persona `instructions`.                                |
| **OpenRouter**    | `OPENROUTER_API_KEY` (can reuse `models.providers.openrouter.apiKey`)                                            | Default model `hexgrad/kokoro-82m`.                                                         |
| **Volcengine**    | `VOLCENGINE_TTS_API_KEY` or `BYTEPLUS_SEED_SPEECH_API_KEY` (legacy AppID/token: `VOLCENGINE_TTS_APPID`/`_TOKEN`) | BytePlus Seed Speech HTTP API.                                                              |
| **Vydra**         | `VYDRA_API_KEY`                                                                                                  | Shared image, video, and speech provider.                                                   |
| **xAI**           | `XAI_API_KEY`                                                                                                    | xAI batch TTS. Native Opus voice-note is **not** supported.                                 |
| **Xiaomi MiMo**   | `XIAOMI_API_KEY`                                                                                                 | MiMo TTS through Xiaomi chat completions.                                                   |

If multiple providers are configured, the selected one is used first and the
others are fallback options. Auto-summary uses `summaryModel` (or
`agents.defaults.model.primary`), so that provider must also be authenticated
if you keep summaries enabled.

<Warning>
The bundled **Microsoft** provider uses Microsoft Edge's online neural TTS
service via `node-edge-tts`. It is a public web service without a published
SLA or quota — treat it as best-effort. The legacy provider id `edge` is
normalized to `microsoft` and `openclaw doctor --fix` rewrites persisted
config; new configs should always use `microsoft`.
</Warning>

## Configuration

TTS config lives under `tts` in `~/.openclaw/openclaw.json`. Pick a
preset and adapt the provider block. The `speakerVoice`/`speakerVoiceId`
fields shown below are canonical; each provider's own `voice`/`voiceId`/
`voiceName` field names still work as legacy aliases.

<Tabs>
  <Tab title="Azure Speech">
```json5
{
  tts: {
    auto: "always",
    provider: "azure-speech",
    providers: {
      "azure-speech": {
        apiKey: "${AZURE_SPEECH_KEY}",
        region: "eastus",
        speakerVoice: "en-US-JennyNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        voiceNoteOutputFormat: "ogg-24khz-16bit-mono-opus",
      },
    },
  },
}
```
  </Tab>
  <Tab title="ElevenLabs">
```json5
{
  tts: {
    auto: "always",
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        apiKey: "${ELEVENLABS_API_KEY}",
        model: "eleven_multilingual_v2",
        speakerVoiceId: "EXAVITQu4vr4xnSDxMaL",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Google Gemini">
```json5
{
  tts: {
    auto: "always",
    provider: "google",
    providers: {
      google: {
        apiKey: "${GEMINI_API_KEY}",
        model: "gemini-3.1-flash-tts-preview",
        speakerVoice: "Kore",
        // Optional natural-language style prompts:
        // audioProfile: "Speak in a calm, podcast-host tone.",
        // speakerName: "Alex",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Gradium">
```json5
{
  tts: {
    auto: "always",
    provider: "gradium",
    providers: {
      gradium: {
        apiKey: "${GRADIUM_API_KEY}",
        speakerVoiceId: "YTpq7expH9539ERJ",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Inworld">
```json5
{
  tts: {
    auto: "always",
    provider: "inworld",
    providers: {
      inworld: {
        apiKey: "${INWORLD_API_KEY}",
        modelId: "inworld-tts-1.5-max",
        speakerVoiceId: "Sarah",
        temperature: 0.7,
      },
    },
  },
}
```
  </Tab>
  <Tab title="Local CLI">
```json5
{
  tts: {
    auto: "always",
    provider: "tts-local-cli",
    providers: {
      "tts-local-cli": {
        command: "say",
        args: ["-o", "{{OutputPath}}", "{{Text}}"],
        outputFormat: "wav",
        timeoutMs: 120000,
      },
    },
  },
}
```
  </Tab>
  <Tab title="Microsoft (no key)">
```json5
{
  tts: {
    auto: "always",
    provider: "microsoft",
    providers: {
      microsoft: {
        enabled: true,
        speakerVoice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+0%",
        pitch: "+0%",
      },
    },
  },
}
```
  </Tab>
  <Tab title="MiniMax">
```json5
{
  tts: {
    auto: "always",
    provider: "minimax",
    providers: {
      minimax: {
        apiKey: "${MINIMAX_API_KEY}",
        model: "speech-2.8-hd",
        speakerVoiceId: "English_expressive_narrator",
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
      },
    },
  },
}
```
  </Tab>
  <Tab title="OpenAI + ElevenLabs">
```json5
{
  tts: {
    auto: "always",
    provider: "openai",
    summaryModel: "openai/gpt-4.1-mini",
    modelOverrides: { enabled: true },
    providers: {
      openai: {
        apiKey: "${OPENAI_API_KEY}",
        model: "gpt-4o-mini-tts",
        speakerVoice: "alloy",
      },
      elevenlabs: {
        apiKey: "${ELEVENLABS_API_KEY}",
        model: "eleven_multilingual_v2",
        speakerVoiceId: "EXAVITQu4vr4xnSDxMaL",
        voiceSettings: { stability: 0.5, similarityBoost: 0.75, style: 0.0, useSpeakerBoost: true, speed: 1.0 },
        applyTextNormalization: "auto",
        languageCode: "en",
      },
    },
  },
}
```
  </Tab>
  <Tab title="OpenRouter">
```json5
{
  tts: {
    auto: "always",
    provider: "openrouter",
    providers: {
      openrouter: {
        apiKey: "${OPENROUTER_API_KEY}",
        model: "hexgrad/kokoro-82m",
        speakerVoice: "af_alloy",
        responseFormat: "mp3",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Volcengine">
```json5
{
  tts: {
    auto: "always",
    provider: "volcengine",
    providers: {
      volcengine: {
        apiKey: "${VOLCENGINE_TTS_API_KEY}",
        resourceId: "seed-tts-1.0",
        speakerVoice: "en_female_anna_mars_bigtts",
      },
    },
  },
}
```
  </Tab>
  <Tab title="xAI">
```json5
{
  tts: {
    auto: "always",
    provider: "xai",
    providers: {
      xai: {
        apiKey: "${XAI_API_KEY}",
        speakerVoiceId: "eve",
        language: "en",
        responseFormat: "mp3",
      },
    },
  },
}
```
  </Tab>
  <Tab title="Xiaomi MiMo">
```json5
{
  tts: {
    auto: "always",
    provider: "xiaomi",
    providers: {
      xiaomi: {
        apiKey: "${XIAOMI_API_KEY}",
        model: "mimo-v2.5-tts",
        speakerVoice: "mimo_default",
        format: "mp3",
      },
    },
  },
}
```
  </Tab>
</Tabs>

For Xiaomi `mimo-v2.5-tts-voicedesign`, omit `speakerVoice` and set `style` to
the voice-design prompt. OpenClaw sends that prompt as the TTS `user` message
and does not send `audio.voice` for the voicedesign model.

### Per-agent voice overrides

Use `agents.entries.*.tts` when one agent should speak with a different provider,
voice, model, persona, or auto-TTS mode. The agent block deep-merges over
`tts`, so provider credentials can stay in the global provider config:

```json5
{
  tts: {
    auto: "always",
    provider: "elevenlabs",
    providers: {
      elevenlabs: { apiKey: "${ELEVENLABS_API_KEY}", model: "eleven_multilingual_v2" },
    },
  },
  agents: {
    list: [
      {
        id: "reader",
        tts: {
          providers: {
            elevenlabs: { speakerVoiceId: "EXAVITQu4vr4xnSDxMaL" },
          },
        },
      },
    ],
  },
}
```

To pin a per-agent persona, set `agents.entries.*.tts.persona` alongside provider
config — it overrides the global `tts.persona` for that agent only.

Precedence order for automatic replies, `/tts audio`, `/tts status`, and the
`tts` agent tool:

1. `tts`
2. active `agents.entries.*.tts`
3. channel override, when the channel supports `channels.<channel>.tts`
4. account override, when the channel passes `channels.<channel>.accounts.<id>.tts`
5. local `/tts` preferences for this host
6. inline `[[tts:...]]` directives when [model overrides](#model-driven-directives) are enabled

Channel and account overrides use the same shape as `tts` and
deep-merge over the earlier layers, so shared provider credentials can stay in
`tts` while a channel or bot account changes only speaker voice, model, persona,
or auto mode:

```json5
{
  tts: {
    provider: "openai",
    providers: {
      openai: { apiKey: "${OPENAI_API_KEY}", model: "gpt-4o-mini-tts" },
    },
  },
  channels: {
    feishu: {
      accounts: {
        english: {
          tts: {
            providers: {
              openai: { speakerVoice: "shimmer" },
            },
          },
        },
      },
    },
  },
}
```

## Personas

A **persona** is a stable spoken identity that can be applied deterministically
across providers. It can prefer one provider, define provider-neutral prompt
intent, and carry provider-specific bindings for voices, models, prompt
templates, seeds, and voice settings.

### Minimal persona

```json5
{
  tts: {
    auto: "always",
    persona: "narrator",
    personas: {
      narrator: {
        label: "Narrator",
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            speakerVoiceId: "EXAVITQu4vr4xnSDxMaL",
            modelId: "eleven_multilingual_v2",
          },
        },
      },
    },
  },
}
```

### Full persona (provider-specific shaping)

```json5
{
  tts: {
    auto: "always",
    persona: "alfred",
    personas: {
      alfred: {
        label: "Alfred",
        description: "Dry, warm British butler narrator.",
        provider: "google",
        fallbackPolicy: "preserve-persona",
        providers: {
          google: {
            model: "gemini-3.1-flash-tts-preview",
            speakerVoice: "Algieba",
            promptTemplate: "audio-profile-v1",
          },
          openai: { model: "gpt-4o-mini-tts", speakerVoice: "cedar" },
          elevenlabs: {
            speakerVoiceId: "voice_id",
            modelId: "eleven_multilingual_v2",
            seed: 42,
            voiceSettings: {
              stability: 0.65,
              similarityBoost: 0.8,
              style: 0.25,
              useSpeakerBoost: true,
              speed: 0.95,
            },
          },
        },
      },
    },
  },
}
```

### Persona resolution

The active persona is selected deterministically:

1. `/tts persona <id>` local preference, if set.
2. `tts.persona`, if set.
3. No persona.

Provider selection runs explicit-first:

1. Direct overrides (CLI, gateway, Talk, allowed TTS directives).
2. `/tts provider <id>` local preference.
3. Active persona's `provider`.
4. `tts.provider`.
5. Registry auto-select.

For each provider attempt, OpenClaw merges configs in this order:

1. `tts.providers.<id>`
2. `tts.personas.<persona>.providers.<id>`
3. Trusted request overrides
4. Allowed model-emitted TTS directive overrides

### Custom persona shaping

Provider-neutral `personas.<id>.prompt.*` config is retired. Doctor removes
those fields and points to the speech-provider seam. Put built-in provider
settings under `personas.<id>.providers.<provider>` (for example Google
`personaPrompt` or OpenAI `instructions`). For custom shaping, implement a
speech provider plugin with `prepareSynthesis(ctx)` and return adjusted text,
provider config, or overrides before `synthesize()` runs. This keeps expressive
prompt construction in provider code where request semantics are known.

### Fallback policy

`fallbackPolicy` controls behavior when a persona has **no binding** for the
attempted provider:

| Policy              | Behavior                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preserve-persona`  | **Default.** Provider-neutral prompt fields stay available; the provider may use them or ignore them.                                            |
| `provider-defaults` | Persona is omitted from prompt preparation for that attempt; the provider uses its neutral defaults while fallback to other providers continues. |
| `fail`              | Skip that provider attempt with `reasonCode: "not_configured"` and `personaBinding: "missing"`. Fallback providers are still tried.              |

The whole TTS request only fails when **every** attempted provider is skipped
or fails.

Talk session provider selection is session-scoped. A Talk client should choose
provider ids, model ids, voice ids, and locales from `talk.catalog` and pass
them through the Talk session or handoff request. Opening a voice session should
not mutate `tts` or global Talk provider defaults.

## Model-driven directives

By default, the assistant **can** emit `[[tts:...]]` directives to override
voice, model, or speed for a single reply, plus an optional
`[[tts:text]]...[[/tts:text]]` block for expressive cues that should appear in
audio only:

```text
Here you go.

[[tts:speakerVoiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](laughs) Read the song once more.[[/tts:text]]
```

When `tts.auto` is `"tagged"`, **directives are required** to trigger
audio. Streaming block delivery strips directives from visible text before the
channel sees them, even when split across adjacent blocks.

`provider=...` is ignored unless `modelOverrides.allowProvider: true`. When a
reply declares `provider=...`, the other keys in that directive are parsed
only by that provider; unsupported keys are stripped and reported as TTS
directive warnings.

**Available directive keys:**

- `provider` (registered provider id; requires `allowProvider: true`)
- `speakerVoice` / `speakerVoiceId` (legacy aliases: `voice`, `voiceName`, `voice_name`, `google_voice`, `voiceId`)
- `model` / `google_model`
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `vol` / `volume` (MiniMax volume, `(0, 10]`)
- `pitch` (MiniMax integer pitch, −12 to 12; fractional values are truncated)
- `emotion` (Volcengine emotion tag)
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

**Disable model overrides entirely:**

```json5
{ messages: { tts: { modelOverrides: { enabled: false } } } }
```

**Allow provider switching while keeping other knobs configurable:**

```json5
{ messages: { tts: { modelOverrides: { enabled: true, allowProvider: true, allowSeed: false } } } }
```

## Slash commands

Single command `/tts`. On Discord, OpenClaw also registers `/voice` because
`/tts` is a built-in Discord command — text `/tts ...` still works.

```text
/tts off | on | status
/tts chat on | off | default
/tts latest
/tts provider <id>
/tts persona <id> | off
/tts limit <chars>
/tts summary off
/tts audio <text>
```

<Note>
Commands require an authorized sender (allowlist/owner rules apply) and either
`commands.text` or native command registration must be enabled.
</Note>

Behavior notes:

- `/tts on` writes the local TTS preference to `always`; `/tts off` writes it to `off`.
- `/tts chat on|off|default` writes a session-scoped auto-TTS override for the current chat.
- `/tts persona <id>` writes the local persona preference; `/tts persona off` clears it.
- `/tts latest` reads the latest assistant reply from the current session transcript and sends it as audio once. It stores only a hash of that reply on the session entry to suppress duplicate voice sends.
- `/tts audio` generates a one-off audio reply (does **not** toggle TTS on).
- `/tts limit <chars>` accepts **100–4096** (4096 is the Telegram caption/message max); values outside that range are rejected.
- `limit` and `summary` are stored in **local prefs**, not the main config.
- `/tts status` includes fallback diagnostics for the latest attempt — `Fallback: <primary> -> <used>`, `Attempts: ...`, and per-attempt detail (`provider:outcome(reasonCode) latency`).
- `/status` shows the active TTS mode plus configured provider, model, voice, and sanitized custom endpoint metadata when TTS is enabled.

## Per-user preferences

Slash commands write local overrides to the TTS preferences path. The default is
`~/.openclaw/settings/tts.json`; override it with `OPENCLAW_TTS_PREFS`. Doctor
moves the retired global `tts.prefsPath` value into shared machine state.
Advanced multi-agent setups may still set `agents.entries.<id>.tts.prefsPath`
when agents intentionally use separate preference stores.

| Stored field | Effect                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| `auto`       | Local auto-TTS override (`always`, `off`, …)                                     |
| `provider`   | Local primary provider override                                                  |
| `persona`    | Local persona override                                                           |
| `maxLength`  | Summary/truncation threshold (default `1500` chars, `/tts limit` range 100–4096) |
| `summarize`  | Summary toggle (default `true`)                                                  |

These override the effective config from `tts` plus the active
`agents.entries.*.tts` block for that host.

## Output formats

TTS voice delivery is channel-capability driven. Channel plugins advertise
whether voice-style TTS should ask providers for a native `voice-note` target or
keep normal `audio-file` synthesis, and whether the channel transcodes
non-native output before sending.

| Target                                | Format                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu / Matrix / Telegram / WhatsApp | Voice-note replies prefer **Opus** (`opus_48000_64` from ElevenLabs, `opus` from OpenAI). 48 kHz / 64 kbps balances clarity and size. |
| Other channels                        | **MP3** (`mp3_44100_128` from ElevenLabs, `mp3` from OpenAI). 44.1 kHz / 128 kbps is the default balance for speech.                  |
| Talk / telephony                      | Provider-native **PCM** (Inworld 22050 Hz, Google 24 kHz), or `ulaw_8000` from Gradium for telephony.                                 |

Per-provider notes:

- **Feishu / WhatsApp transcoding:** when a voice-note reply lands as MP3/WebM/WAV/M4A or another likely audio file, the channel plugin transcodes it to 48 kHz Ogg/Opus with `ffmpeg` (`libopus`, 64 kbps) before sending the native voice message. WhatsApp sends the result through the Baileys `audio` payload with `ptt: true` and `audio/ogg; codecs=opus`. On transcode failure: Feishu catches the error and falls back to sending the original file as a plain attachment; WhatsApp has no fallback, so the send itself fails rather than posting an incompatible PTT payload.
- **MiniMax:** MP3 (`speech-2.8-hd` model, 32 kHz sample rate) for normal audio attachments; transcoded to 48 kHz Opus with `ffmpeg` for channel-advertised voice-note targets.
- **Xiaomi MiMo:** MP3 by default, or WAV when configured; transcoded to 48 kHz Opus with `ffmpeg` for channel-advertised voice-note targets.
- **Local CLI:** uses the configured `outputFormat`. Voice-note targets are converted to Ogg/Opus and telephony output is converted to raw 16 kHz mono PCM with `ffmpeg`.
- **Google Gemini:** returns raw 24 kHz PCM. OpenClaw wraps it as WAV for audio attachments, transcodes it to 48 kHz Opus for voice-note targets, and returns PCM directly for Talk/telephony.
- **Gradium:** WAV for audio attachments, Opus for voice-note targets, and `ulaw_8000` at 8 kHz for telephony.
- **Inworld:** MP3 for normal audio attachments, native `OGG_OPUS` for voice-note targets, and raw `PCM` at 22050 Hz for Talk/telephony.
- **xAI:** MP3 by default; audio-file synthesis may use `mp3`, `wav`, `pcm`, `mulaw`, or `alaw` for both buffered and streaming output. Voice-note targets use MP3 for streaming and buffered fallback because xAI's `pcm`, `mulaw`, and `alaw` outputs are headerless raw audio. Buffered synthesis uses xAI's batch REST `/v1/tts` endpoint; `textToSpeechStream` uses native `wss://api.x.ai/v1/tts`. This is not the realtime voice contract. Native Opus voice-note format is not supported.
- **Microsoft:** uses `microsoft.outputFormat` (default `audio-24khz-48kbitrate-mono-mp3`).
  - The bundled transport accepts an `outputFormat`, but not all formats are available from the service.
  - Output format values follow Microsoft Speech output formats (including Ogg/WebM Opus).
  - Telegram `sendVoice` accepts OGG/MP3/M4A; use OpenAI/ElevenLabs if you need guaranteed Opus voice messages.
  - If the configured Microsoft output format fails, OpenClaw retries with MP3.
  - When no explicit voice override is set and the default English voice is used, OpenClaw auto-switches to a Chinese neural voice (`zh-CN-XiaoxiaoNeural`, `zh-CN` locale) if the reply text is CJK-dominant.

OpenAI and ElevenLabs output formats are fixed per channel as listed above.

## Auto-TTS behavior

When `tts.auto` is enabled, OpenClaw:

- Skips TTS if the reply already contains structured media.
- Skips very short replies (under 10 chars).
- Summarizes long replies when summaries are enabled, using
  `summaryModel` (or `agents.defaults.model.primary`).
- Attaches the generated audio to the reply.
- In `mode: "final"`, still sends audio-only TTS for streamed final replies
  after the text stream completes; the generated media goes through the same
  channel media normalization as normal reply attachments.

If the reply exceeds `maxLength`, OpenClaw never skips audio outright:

- **Summary on** (default) and a summary model is available: summarizes the
  text to roughly `maxLength` chars, then synthesizes the summary.
- **Summary off**, summarization fails, or no API key is available for the
  summary model: truncates the text to `maxLength` chars and synthesizes the
  truncated text.

```text
Reply -> TTS enabled?
  no  -> send text
  yes -> has media / short?
          yes -> send text
          no  -> length > limit?
                   no  -> TTS -> attach audio
                   yes -> summary enabled and available?
                            no  -> truncate -> TTS -> attach audio
                            yes -> summarize -> TTS -> attach audio
```

## Field reference

<AccordionGroup>
  <Accordion title="Top-level tts.*">
    <ParamField path="auto" type='"off" | "always" | "inbound" | "tagged"'>
      Auto-TTS mode. `inbound` only sends audio after an inbound voice message; `tagged` only sends audio when the reply includes `[[tts:...]]` directives or a `[[tts:text]]` block.
    </ParamField>
    <ParamField path="enabled" type="boolean" deprecated>
      Legacy toggle. `openclaw doctor --fix` migrates this to `auto`.
    </ParamField>
    <ParamField path="mode" type='"final" | "all"' default="final">
      `"all"` includes tool/block replies in addition to final replies.
    </ParamField>
    <ParamField path="provider" type="string">
      Speech provider id. When unset, OpenClaw uses the first configured provider in registry auto-select order. Legacy `provider: "edge"` is rewritten to `"microsoft"` by `openclaw doctor --fix`.
    </ParamField>
    <ParamField path="persona" type="string">
      Active persona id from `personas`. Normalized to lowercase.
    </ParamField>
    <ParamField path="personas.<id>" type="object">
      Stable spoken identity. Fields: `label`, `description`, `provider`, `fallbackPolicy`, `prompt`, `providers.<provider>`. See [Personas](#personas).
    </ParamField>
    <ParamField path="summaryModel" type="string">
      Cheap model for auto-summary; defaults to `agents.defaults.model.primary`. Accepts `provider/model` or a configured model alias.
    </ParamField>
    <ParamField path="modelOverrides" type="object">
      Allow the model to emit TTS directives. `enabled` defaults to `true`; `allowProvider` defaults to `false`.
    </ParamField>
    <ParamField path="providers.<id>" type="object">
      Provider-owned settings keyed by speech provider id. Legacy direct blocks (`tts.openai`, `.elevenlabs`, `.microsoft`, `.edge`) are rewritten by `openclaw doctor --fix`; commit only `tts.providers.<id>`.
    </ParamField>
    <ParamField path="maxTextLength" type="number" default="4096">
      Hard cap for TTS input characters. `/tts audio`, `tts.convert`, and `tts.speak` fail if exceeded.
    </ParamField>
    <ParamField path="timeoutMs" type="number" default="30000">
      Request timeout in milliseconds. A per-call `timeoutMs` (agent tool, gateway) wins when set; otherwise an explicitly configured `tts.timeoutMs` wins over any plugin-authored provider default.
    </ParamField>
  </Accordion>

Provider `apiKey` fields can be raw strings or SecretRefs. During cold Gateway
startup, an unavailable TTS SecretRef marks the built-in TTS capability
configured-unavailable instead of stopping the Gateway. `tts.speak` then returns
`UNAVAILABLE` with reason `SECRET_SURFACE_UNAVAILABLE`, and no provider request is
sent. Status and doctor list the degraded TTS owner and its config paths. The
explicit refs remain in the runtime snapshot, so environment or profile
credentials cannot silently select a different account. Reloads and config-write
preflight apply the owner-aware degradation policy: an unchanged eligible TTS
owner may keep its last-known-good credentials as stale, while a new or changed
failure becomes cold without blocking healthy owners. Structurally invalid refs
and resolved values still fail startup or reject the update.

  <Accordion title="Azure Speech">
    <ParamField path="apiKey" type="string">Env: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_API_KEY`, or `SPEECH_KEY`.</ParamField>
    <ParamField path="region" type="string">Azure Speech region (e.g. `eastus`). Env: `AZURE_SPEECH_REGION` or `SPEECH_REGION`.</ParamField>
    <ParamField path="endpoint" type="string">Optional Azure Speech endpoint override (alias `baseUrl`).</ParamField>
    <ParamField path="speakerVoice" type="string">Azure voice ShortName. Default `en-US-JennyNeural`. Legacy alias: `voice`.</ParamField>
    <ParamField path="lang" type="string">SSML language code. Default `en-US`.</ParamField>
    <ParamField path="outputFormat" type="string">Azure `X-Microsoft-OutputFormat` for standard audio. Default `audio-24khz-48kbitrate-mono-mp3`.</ParamField>
    <ParamField path="voiceNoteOutputFormat" type="string">Azure `X-Microsoft-OutputFormat` for voice-note output. Default `ogg-24khz-16bit-mono-opus`.</ParamField>
  </Accordion>

  <Accordion title="ElevenLabs">
    <ParamField path="apiKey" type="string">Falls back to `ELEVENLABS_API_KEY` or `XI_API_KEY`.</ParamField>
    <ParamField path="model" type="string">Model id. Default `eleven_multilingual_v2`. Legacy ids `eleven_turbo_v2_5`/`eleven_turbo_v2` are normalized to the matching `flash` model.</ParamField>
    <ParamField path="speakerVoiceId" type="string">ElevenLabs voice id. Default `pMsXgVXv3BLzUgSXRplE`. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="voiceSettings" type="object">
      `stability`, `similarityBoost`, `style` (each `0..1`, defaults `0.5`/`0.75`/`0`), `useSpeakerBoost` (`true|false`, default `true`), `speed` (`0.5..2.0`, default `1.0`).
    </ParamField>
    <ParamField path="applyTextNormalization" type='"auto" | "on" | "off"'>Text normalization mode.</ParamField>
    <ParamField path="languageCode" type="string">2-letter ISO 639-1 (e.g. `en`, `de`).</ParamField>
    <ParamField path="seed" type="number">Integer `0..4294967295` for best-effort determinism.</ParamField>
    <ParamField path="baseUrl" type="string">Override ElevenLabs API base URL.</ParamField>
  </Accordion>

  <Accordion title="Google Gemini">
    <ParamField path="apiKey" type="string">Falls back to `GEMINI_API_KEY` / `GOOGLE_API_KEY`. If omitted, TTS can reuse `models.providers.google.apiKey` before env fallback.</ParamField>
    <ParamField path="model" type="string">Gemini TTS model. Default `gemini-3.1-flash-tts-preview`.</ParamField>
    <ParamField path="speakerVoice" type="string">Gemini prebuilt voice name. Default `Kore`. Legacy aliases: `voiceName`, `voice`.</ParamField>
    <ParamField path="audioProfile" type="string">Natural-language style prompt prepended before spoken text.</ParamField>
    <ParamField path="speakerName" type="string">Optional speaker label prepended before spoken text when your prompt uses a named speaker.</ParamField>
    <ParamField path="promptTemplate" type='"audio-profile-v1"'>Set to `audio-profile-v1` to wrap active persona prompt fields in a deterministic Gemini TTS prompt structure.</ParamField>
    <ParamField path="personaPrompt" type="string">Google-specific extra persona prompt text appended to the template's Director's Notes.</ParamField>
    <ParamField path="baseUrl" type="string">Only `https://generativelanguage.googleapis.com` is accepted.</ParamField>
  </Accordion>

  <Accordion title="Gradium">
    <ParamField path="apiKey" type="string">Env: `GRADIUM_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">HTTPS Gradium API URL on `api.gradium.ai`. Default `https://api.gradium.ai`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default Emma (`YTpq7expH9539ERJ`). Legacy alias: `voiceId`.</ParamField>
  </Accordion>

  <Accordion title="Inworld">
    ### Inworld primary

    <ParamField path="apiKey" type="string">Env: `INWORLD_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.inworld.ai`.</ParamField>
    <ParamField path="modelId" type="string">Default `inworld-tts-1.5-max`. Also: `inworld-tts-1.5-mini`, `inworld-tts-1-max`, `inworld-tts-1`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default `Sarah`. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="temperature" type="number">Sampling temperature `0..2` (exclusive of 0).</ParamField>

  </Accordion>

  <Accordion title="Local CLI (tts-local-cli)">
    <ParamField path="command" type="string">Local executable or command string for CLI TTS.</ParamField>
    <ParamField path="args" type="string[]">Command arguments. Supports `{{Text}}`, `{{OutputPath}}`, `{{OutputDir}}`, `{{OutputBase}}` placeholders.</ParamField>
    <ParamField path="outputFormat" type='"mp3" | "opus" | "wav"'>Expected CLI output format. Default `mp3` for audio attachments.</ParamField>
    <ParamField path="timeoutMs" type="number">Command timeout in milliseconds. Default `120000`.</ParamField>
    <ParamField path="cwd" type="string">Optional command working directory.</ParamField>
    <ParamField path="env" type="Record<string, string>">Optional environment overrides for the command.</ParamField>

    Command stdout and generated or converted audio are limited to 50 MiB. Diagnostic stderr is limited to 1 MiB. OpenClaw terminates the command and fails synthesis when either limit is exceeded.

  </Accordion>

  <Accordion title="Microsoft (no API key)">
    <ParamField path="enabled" type="boolean" default="true">Allow Microsoft speech usage.</ParamField>
    <ParamField path="speakerVoice" type="string">Microsoft neural voice name (e.g. `en-US-MichelleNeural`). Legacy alias: `voice`. If the default English voice is in effect and reply text is CJK-dominant, OpenClaw auto-switches to `zh-CN-XiaoxiaoNeural`.</ParamField>
    <ParamField path="lang" type="string">Language code (e.g. `en-US`).</ParamField>
    <ParamField path="outputFormat" type="string">Microsoft output format. Default `audio-24khz-48kbitrate-mono-mp3`. Not all formats are supported by the bundled Edge-backed transport.</ParamField>
    <ParamField path="rate / pitch / volume" type="string">Percent strings (e.g. `+10%`, `-5%`).</ParamField>
    <ParamField path="saveSubtitles" type="boolean">Write JSON subtitles alongside the audio file.</ParamField>
    <ParamField path="proxy" type="string">Proxy URL for Microsoft speech requests.</ParamField>
    <ParamField path="timeoutMs" type="number">Request timeout override (ms).</ParamField>
    <ParamField path="edge.*" type="object" deprecated>Legacy alias. Run `openclaw doctor --fix` to rewrite persisted config to `providers.microsoft`.</ParamField>
  </Accordion>

  <Accordion title="MiniMax">
    <ParamField path="apiKey" type="string">Falls back to `MINIMAX_API_KEY`. Token Plan auth via `MINIMAX_OAUTH_TOKEN`, `MINIMAX_CODE_PLAN_KEY`, or `MINIMAX_CODING_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.minimax.io`. Env: `MINIMAX_API_HOST`.</ParamField>
    <ParamField path="model" type="string">Default `speech-2.8-hd`. Env: `MINIMAX_TTS_MODEL`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default `English_expressive_narrator`. Env: `MINIMAX_TTS_VOICE_ID`. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="speed" type="number">`0.5..2.0`. Default `1.0`.</ParamField>
    <ParamField path="vol" type="number">`(0, 10]`. Default `1.0`.</ParamField>
    <ParamField path="pitch" type="number">Integer `-12..12`. Default `0`. Fractional values are truncated before the request.</ParamField>
  </Accordion>

  <Accordion title="OpenAI">
    <ParamField path="apiKey" type="string">Falls back to `OPENAI_API_KEY`.</ParamField>
    <ParamField path="model" type="string">OpenAI TTS model id. Default `gpt-4o-mini-tts`.</ParamField>
    <ParamField path="speakerVoice" type="string">Voice name (e.g. `alloy`, `cedar`). Default `coral`. Legacy alias: `voice`.</ParamField>
    <ParamField path="instructions" type="string">Explicit OpenAI `instructions` field. When set, persona prompt fields are **not** auto-mapped.</ParamField>
    <ParamField path="extraBody / extra_body" type="Record<string, unknown>">Extra JSON fields merged into `/audio/speech` request bodies after generated OpenAI TTS fields. Use this for OpenAI-compatible endpoints such as Kokoro that require provider-specific keys like `lang`; unsafe prototype keys are ignored.</ParamField>
    <ParamField path="baseUrl" type="string">
      Override the OpenAI TTS endpoint. Resolution order: config → `OPENAI_TTS_BASE_URL` → `https://api.openai.com/v1`. Non-default values are treated as OpenAI-compatible TTS endpoints, so custom model and voice names are accepted, and `speed` loses its `0.25..4.0` range check.
    </ParamField>
  </Accordion>

  <Accordion title="OpenRouter">
    <ParamField path="apiKey" type="string">Env: `OPENROUTER_API_KEY`. Can reuse `models.providers.openrouter.apiKey`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://openrouter.ai/api/v1`. Legacy `https://openrouter.ai/v1` is normalized.</ParamField>
    <ParamField path="model" type="string">Default `hexgrad/kokoro-82m`. Alias: `modelId`.</ParamField>
    <ParamField path="speakerVoice" type="string">Default `af_alloy`. Legacy aliases: `voice`, `voiceId`.</ParamField>
    <ParamField path="responseFormat" type='"mp3" | "pcm"'>Default `mp3`.</ParamField>
    <ParamField path="speed" type="number">Provider-native speed override.</ParamField>
  </Accordion>

  <Accordion title="Volcengine (BytePlus Seed Speech)">
    <ParamField path="apiKey" type="string">Env: `VOLCENGINE_TTS_API_KEY` or `BYTEPLUS_SEED_SPEECH_API_KEY`.</ParamField>
    <ParamField path="resourceId" type="string">Default `seed-tts-1.0`. Env: `VOLCENGINE_TTS_RESOURCE_ID`. Use `seed-tts-2.0` when your project has TTS 2.0 entitlement.</ParamField>
    <ParamField path="appKey" type="string">App key header. Default `aGjiRDfUWi`. Env: `VOLCENGINE_TTS_APP_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Override the Seed Speech TTS HTTP endpoint. Env: `VOLCENGINE_TTS_BASE_URL`.</ParamField>
    <ParamField path="speakerVoice" type="string">Voice type. Default `en_female_anna_mars_bigtts`. Env: `VOLCENGINE_TTS_VOICE`. Legacy alias: `voice`.</ParamField>
    <ParamField path="speedRatio" type="number">Provider-native speed ratio, `0.2..3`.</ParamField>
    <ParamField path="emotion" type="string">Provider-native emotion tag.</ParamField>
    <ParamField path="appId / token / cluster" type="string" deprecated>Legacy Volcengine Speech Console fields. Env: `VOLCENGINE_TTS_APPID`, `VOLCENGINE_TTS_TOKEN`, `VOLCENGINE_TTS_CLUSTER` (default `volcano_tts`).</ParamField>
  </Accordion>

  <Accordion title="xAI">
    <ParamField path="apiKey" type="string">Env: `XAI_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.x.ai/v1`. Env: `XAI_BASE_URL`.</ParamField>
    <ParamField path="speakerVoiceId" type="string">Default `eve`. With auth, `openclaw infer tts voices --provider xai` fetches the current built-in catalog; without auth it lists offline fallbacks `ara`, `eve`, `leo`, `rex`, and `sal`. Account custom voice IDs are forwarded even when absent from the built-in list. Legacy alias: `voiceId`.</ParamField>
    <ParamField path="language" type="string">BCP-47 language code or `auto`. Default `en`.</ParamField>
    <ParamField path="responseFormat" type='"mp3" | "wav" | "pcm" | "mulaw" | "alaw"'>Default `mp3`.</ParamField>
    <ParamField path="speed" type="number">Provider-native speed override, `0.7..1.5`.</ParamField>
  </Accordion>

  <Accordion title="Xiaomi MiMo">
    <ParamField path="apiKey" type="string">Env: `XIAOMI_API_KEY`.</ParamField>
    <ParamField path="baseUrl" type="string">Default `https://api.xiaomimimo.com/v1`. Env: `XIAOMI_BASE_URL`.</ParamField>
    <ParamField path="model" type="string">Default `mimo-v2.5-tts`. Env: `XIAOMI_TTS_MODEL`. Also supports `mimo-v2.5-tts-voicedesign`.</ParamField>
    <ParamField path="speakerVoice" type="string">Default `mimo_default` for preset-voice models. Env: `XIAOMI_TTS_VOICE`. Legacy alias: `voice`. Not sent for `mimo-v2.5-tts-voicedesign`.</ParamField>
    <ParamField path="format" type='"mp3" | "wav"'>Default `mp3`. Env: `XIAOMI_TTS_FORMAT`.</ParamField>
    <ParamField path="style" type="string">Optional natural-language style instruction sent as the user message; not spoken. For `mimo-v2.5-tts-voicedesign`, this is the voice-design prompt; OpenClaw supplies a default when omitted.</ParamField>
  </Accordion>
</AccordionGroup>

## Agent tool

The `tts` tool converts text to speech and returns an audio attachment for
reply delivery. On Feishu, Matrix, Telegram, and WhatsApp, the audio is
delivered as a voice message rather than a file attachment. Feishu and
WhatsApp can transcode non-Opus TTS output on this path when `ffmpeg` is
available.

WhatsApp sends audio through Baileys as a PTT voice note (`audio` with
`ptt: true`) and sends visible text **separately** from PTT audio because
clients do not consistently render captions on voice notes.

The tool accepts optional `channel` and `timeoutMs` fields; `timeoutMs` is a
per-call provider request timeout in milliseconds. Per-call values override
`tts.timeoutMs`; configured TTS timeouts override any plugin-authored
provider default.

## Gateway RPC

| Method            | Purpose                                      |
| ----------------- | -------------------------------------------- |
| `tts.status`      | Read current TTS state and last attempt.     |
| `tts.enable`      | Set local auto preference to `always`.       |
| `tts.disable`     | Set local auto preference to `off`.          |
| `tts.convert`     | One-off text → audio.                        |
| `tts.setProvider` | Set local provider preference.               |
| `tts.personas`    | List configured personas and the active one. |
| `tts.setPersona`  | Set local persona preference.                |
| `tts.providers`   | List configured providers and status.        |

## Service links

- [OpenAI text-to-speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [OpenAI Audio API reference](https://platform.openai.com/docs/api-reference/audio)
- [Azure Speech REST text-to-speech](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech)
- [Azure Speech provider](/providers/azure-speech)
- [ElevenLabs Text to Speech](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [ElevenLabs Authentication](https://elevenlabs.io/docs/api-reference/authentication)
- [Gradium](/providers/gradium)
- [Inworld TTS API](https://docs.inworld.ai/tts/tts)
- [MiniMax T2A v2 API](https://platform.minimaxi.com/document/T2A%20V2)
- [Volcengine TTS HTTP API](/providers/volcengine#text-to-speech)
- [Xiaomi MiMo speech synthesis](/providers/xiaomi#text-to-speech)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Microsoft Speech output formats](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)
- [xAI text to speech](https://docs.x.ai/developers/rest-api-reference/inference/voice#text-to-speech-rest)

## Related

- [Media overview](/tools/media-overview)
- [Music generation](/tools/music-generation)
- [Video generation](/tools/video-generation)
- [Slash commands](/tools/slash-commands)
- [Voice call plugin](/plugins/voice-call)
