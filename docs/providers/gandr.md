---
summary: "Gandr OpenAI compatible text-to-speech for OpenClaw replies"
read_when:
  - You want Gandr speech synthesis for outbound replies
  - You need an OpenAI compatible TTS provider with WAV or PCM telephony output
title: "Gandr"
---

Gandr is a hosted text-to-speech (TTS) provider with an OpenAI compatible API. In OpenClaw it synthesizes outbound reply audio (MP3 by default, WAV on request) and raw PCM audio for telephony channels such as Voice Call.

OpenClaw posts to Gandr's speech endpoint and hands the returned audio bytes to the standard reply-audio pipeline.

First audio byte in 146 ms over the open internet, 116 ms p50 first audio, server side warm.

| Property      | Value                                                |
| ------------- | ---------------------------------------------------- |
| Provider id   | `gandr`                                              |
| Plugin        | official external package (`@openclaw/gandr-speech`) |
| Contract      | `speechProviders` (TTS only)                         |
| Auth env var  | `GANDR_API_KEY` (Bearer token)                       |
| Base URL      | `https://tts.gandr.ai/v1`                            |
| Default voice | `gandr-mia`                                          |
| Default model | `tts-1`                                              |
| Output        | MP3 (default), WAV, PCM 24000 Hz (telephony)         |
| Website       | [gandr.ai](https://gandr.ai)                         |

## Install plugin

```bash
openclaw plugins install @openclaw/gandr-speech
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Set your API key">
    Create a key at [gandr.ai](https://gandr.ai) and set it as an env var. The free tier is 50,000 tokens. The value is sent as a Bearer token.

    ```bash
    GANDR_API_KEY=<key-from-gandr.ai>
    ```

  </Step>
  <Step title="Select Gandr in tts">
    ```json5
    {
      tts: {
        auto: "always",
        provider: "gandr",
        maxTextLength: 2000,
        providers: {
          gandr: {
            speakerVoiceId: "gandr-mia",
            modelId: "tts-1",
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Send a message">
    Send a reply through any connected channel. OpenClaw synthesizes the audio with Gandr and delivers it as MP3 (or transcodes it for channels that expect a native voice note).
  </Step>
</Steps>

## Configuration options

| Option           | Path                                 | Description                                                      |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `apiKey`         | `tts.providers.gandr.apiKey`         | Gandr API key. Falls back to `GANDR_API_KEY`.                    |
| `baseUrl`        | `tts.providers.gandr.baseUrl`        | Override Gandr API base URL (default `https://tts.gandr.ai/v1`). |
| `speakerVoiceId` | `tts.providers.gandr.speakerVoiceId` | Voice identifier (default `gandr-mia`). Legacy alias: `voiceId`. |
| `modelId`        | `tts.providers.gandr.modelId`        | TTS model id (default `tts-1`).                                  |
| `responseFormat` | `tts.providers.gandr.responseFormat` | Audio attachment format, `mp3` (default) or `wav`.               |

## Notes

<AccordionGroup>
  <Accordion title="Authentication">
    Gandr uses a Bearer token. The provider sends it as `Authorization: Bearer <apiKey>`. Keys are issued at [gandr.ai](https://gandr.ai).
  </Accordion>
  <Accordion title="Voices and languages">
    Stock voices: `gandr-mia`, `gandr-ava`, `gandr-jenny`, `gandr-dane`, `gandr-leo`, `gandr-lewis`. Gandr supports 23 languages. There is no voices listing endpoint; `openclaw infer tts voices --provider gandr` returns this stock catalog.
  </Accordion>
  <Accordion title="Audio outputs">
    Replies use MP3 by default, or WAV when `responseFormat` is `wav`. Telephony synthesis uses raw `pcm`, which is headerless signed 16-bit little-endian mono at 24000 Hz, to feed the telephony bridge. Voice-note targets receive the attachment format; channels that require Opus transcode it with `ffmpeg`.
  </Accordion>
  <Accordion title="Input limit">
    Gandr caps each request at 2000 characters. The provider raises a clear error above that. Set `tts.maxTextLength: 2000` so long replies are summarized or truncated before synthesis instead of erroring.
  </Accordion>
  <Accordion title="Watermarking">
    Every render is watermarked.
  </Accordion>
  <Accordion title="Custom endpoints">
    Override the API host with `tts.providers.gandr.baseUrl`. Trailing slashes are stripped before requests are sent.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Text-to-speech" href="/tools/tts" icon="waveform-lines">
    TTS overview, providers, and `tts` config.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference including `tts` settings.
  </Card>
  <Card title="Providers" href="/providers" icon="grid">
    All supported OpenClaw providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
</CardGroup>
