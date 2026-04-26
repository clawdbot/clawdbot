---
summary: "Inworld streaming text-to-speech for OpenClaw replies"
read_when:
  - You want Inworld speech synthesis for outbound replies
  - You need PCM telephony or OGG_OPUS voice-note output from Inworld
title: "Inworld"
---

Inworld is a streaming text-to-speech (TTS) provider. In OpenClaw it
synthesizes outbound reply audio (MP3 by default, OGG_OPUS for voice notes)
and PCM audio for telephony channels such as Voice Call.

OpenClaw posts to Inworld's streaming TTS endpoint, concatenates the
returned base64 audio chunks into a single buffer, and hands the result to
the standard reply-audio pipeline.

| Detail        | Value                                                       |
| ------------- | ----------------------------------------------------------- |
| Website       | [inworld.ai](https://inworld.ai)                            |
| Docs          | [docs.inworld.ai/tts/tts](https://docs.inworld.ai/tts/tts)  |
| Auth          | `INWORLD_API_KEY` (HTTP Basic, Base64 dashboard credential) |
| Default voice | `Sarah`                                                     |
| Default model | `inworld-tts-1.5-max`                                       |

## Getting started

<Steps>
  <Step title="Set your API key">
    Copy the credential from your Inworld dashboard (Workspace > API Keys)
    and set it as an env var. The value is sent verbatim as the HTTP Basic
    credential, so do not Base64-encode it again or convert it to a bearer
    token.

    ```
    INWORLD_API_KEY=<base64-credential-from-dashboard>
    ```

  </Step>
  <Step title="Select Inworld in messages.tts">
    ```json5
    {
      messages: {
        tts: {
          auto: "always",
          provider: "inworld",
          providers: {
            inworld: {
              voiceId: "Sarah",
              modelId: "inworld-tts-1.5-max",
            },
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Send a message">
    Send a reply through any connected channel. OpenClaw synthesizes the
    audio with Inworld and delivers it as MP3 (or OGG_OPUS when the channel
    expects a voice note).
  </Step>
</Steps>

## Configuration options

| Option        | Path                                         | Description                                                       |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `apiKey`      | `messages.tts.providers.inworld.apiKey`      | Base64 dashboard credential. Falls back to `INWORLD_API_KEY`.     |
| `baseUrl`     | `messages.tts.providers.inworld.baseUrl`     | Override Inworld API base URL (default `https://api.inworld.ai`). |
| `voiceId`     | `messages.tts.providers.inworld.voiceId`     | Voice identifier (default `Sarah`).                               |
| `modelId`     | `messages.tts.providers.inworld.modelId`     | TTS model id (default `inworld-tts-1.5-max`).                     |
| `temperature` | `messages.tts.providers.inworld.temperature` | Sampling temperature `0..2` (optional).                           |

## Notes

<AccordionGroup>
  <Accordion title="Authentication">
    Inworld uses HTTP Basic auth with a single Base64-encoded credential
    string. Copy it verbatim from the Inworld dashboard. The provider sends
    it as `Authorization: Basic <apiKey>` without any further encoding, so
    do not Base64-encode it yourself and do not pass a bearer-style token.
    See [TTS auth notes](/tools/tts#inworld-primary) for the same callout.
  </Accordion>
  <Accordion title="Models">
    Supported model ids: `inworld-tts-1.5-max` (default),
    `inworld-tts-1.5-mini`, `inworld-tts-1-max`, `inworld-tts-1`.
  </Accordion>
  <Accordion title="Audio outputs">
    Replies use MP3 by default. When the channel target is `voice-note`
    OpenClaw asks Inworld for `OGG_OPUS` so the audio plays as a native
    voice bubble. Telephony synthesis uses raw `PCM` at 22050 Hz to feed
    the telephony bridge.
  </Accordion>
  <Accordion title="Custom endpoints">
    Override the API host with `messages.tts.providers.inworld.baseUrl`.
    Trailing slashes are stripped before requests are sent.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Text-to-speech" href="/tools/tts" icon="waveform-lines">
    TTS overview, providers, and `messages.tts` config.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference including `messages.tts` settings.
  </Card>
  <Card title="Providers" href="/providers" icon="grid">
    All bundled OpenClaw providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
</CardGroup>
