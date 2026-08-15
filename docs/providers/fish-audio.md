---
summary: "Use Fish Audio S2.1 hosted TTS or local S2 Pro on Apple silicon"
read_when:
  - You want Fish Audio text-to-speech in OpenClaw
  - You want expressive or cloned voices with Fish Audio
  - You want local Fish S2 Pro speech in macOS Talk mode
title: "Fish Audio"
---

OpenClaw supports Fish Audio in two distinct ways:

- **Hosted S2.1** runs through the `fish-audio` speech provider on the Gateway and works across channels, voice notes, Talk, and telephony.
- **Local S2 Pro** runs inside the native macOS app through the existing `mlx` Talk provider. It stays on the Mac and does not require a Fish API key.

<Warning>
The downloadable S2 Pro weights use the Fish Audio Research License. Personal,
research, and non-commercial evaluation are allowed; commercial use requires a
separate Fish Audio license. Hosted API use follows Fish Audio's service terms.
</Warning>

## Hosted S2.1

Install the `fish-audio-speech` plugin:

```bash
openclaw plugins install @openclaw/fish-audio-speech
```

The plugin id is `fish-audio-speech`. The provider and TTS configuration id
remain `fish-audio`.

Set an API key from the [Fish Audio API Keys](https://fish.audio/app/api-keys) page:

```bash
export FISH_API_KEY="..."
```

Then configure the provider:

```json5
{
  tts: {
    auto: "tagged",
    provider: "fish-audio",
    providers: {
      "fish-audio": {
        apiKey: "${FISH_API_KEY}",
        model: "s2.1-pro",
        // Optional saved or public Fish Audio voice model id:
        speakerVoiceId: "802e3bc2b27e49c2995d23ef70e6ac89",
        latency: "balanced",
      },
    },
  },
}
```

`speakerVoiceId` is optional. Without it, Fish Audio uses its default voice.
`FISH_AUDIO_API_KEY` is also accepted for compatibility with existing community
plugins, but `FISH_API_KEY` is the canonical Fish SDK environment variable.

### Hosted models

| Model           | Use                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `s2.1-pro`      | Default. Production S2.1 service with the hosted service guarantees attached to your plan.                     |
| `s2.1-pro-free` | Promotional S2.1 access through August 31, 2026; no TTFA or DPA guarantees. Select it explicitly while active. |
| `s2-pro`        | Previous S2 generation.                                                                                        |
| `s1`            | Previous generation with parenthesized emotion controls.                                                       |

The provider requests MP3 for ordinary audio, Opus at 48 kHz for native voice
notes, and raw PCM at 8 kHz for telephony. For Discord voice, OpenClaw consumes
Fish Audio's chunked HTTP response as it arrives instead of waiting for the
entire clip.

### Expressive speech

S2 and S2.1 accept inline natural-language tags. Put them in the spoken text:

```text
[whisper] Keep this between us. [pause] [excited] We shipped it!
```

Common tags include `[whisper]`, `[laughing]`, `[excited]`, `[sad]`, `[pause]`,
and free-form instructions such as `[professional broadcast tone]`.

### Voice selection and cloning

Use `/tts status` to inspect the active provider and `/tts audio <text>` for a
one-off clip. Fish voice ids can come from your own trained voices or the public
Fish voice library. OpenClaw lists your voices first, then a bounded page of
popular public voices.

The speech provider consumes existing voice ids; it does not upload recordings
or create voice models. Voice creation is a separate consent-sensitive action
in the Fish Audio app or API.

## Local S2 Pro on macOS

The native macOS app bundles an isolated MLX TTS helper. On Apple silicon, point
the existing `mlx` Talk provider at the 8-bit Fish conversion:

```json5
{
  talk: {
    provider: "mlx",
    providers: {
      mlx: {
        modelId: "mlx-community/fish-audio-s2-pro-8bit",
      },
    },
  },
}
```

The first utterance downloads about 6.8 GB of model and codec data. OpenClaw
keeps one selected MLX model resident for repeated utterances, then unloads it
after five idle minutes, app shutdown, or memory pressure.

### Local reference voice

When the Gateway and macOS app share the same filesystem, configure a clean
10–30 second reference recording and its exact transcript:

```json5
{
  talk: {
    provider: "mlx",
    providers: {
      mlx: {
        modelId: "mlx-community/fish-audio-s2-pro-8bit",
        referenceAudioPath: "/Users/example/Voices/reference.wav",
        referenceText: "The exact words spoken in the reference recording.",
      },
    },
  },
}
```

`referenceAudioPath` is resolved on the Mac running the native app, not on a
remote Gateway. The file stays local: the app passes it only to its isolated MLX
helper. Local Fish output is streamed as PCM into Talk playback so speech can
start before a long generation finishes.

<Note>
Local MLX currently applies only to native macOS Talk. Other channels and
clients use the Gateway-selected hosted speech provider. iOS and Android retain
their existing native/system and Gateway Talk paths.
</Note>

## Troubleshooting

- **`Fish Audio API key missing`**: set `FISH_API_KEY` or `tts.providers.fish-audio.apiKey`.
- **HTTP 401**: verify the API key at Fish Audio.
- **HTTP 402**: the selected hosted model requires available credits or plan access.
- **Local model falls back to the system voice**: confirm Apple silicon, free disk space, and the exact Hugging Face model id.
- **Local clone does not match**: use clean single-speaker audio and make `referenceText` match it exactly.

See the [Fish Audio TTS API](https://docs.fish.audio/features/text-to-speech)
and [Fish Audio Research License](https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md).
