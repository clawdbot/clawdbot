---
summary: "Deepgram transcription for inbound voice notes"
read_when:
  - You want Deepgram speech-to-text for audio attachments
  - You want Deepgram streaming transcription for Voice Call
  - You need a quick Deepgram config example
title: "Deepgram"
---

Deepgram is a speech-to-text API. OpenClaw uses it for inbound audio/voice-note
transcription through `tools.media.audio` and for Voice Call streaming STT
through `plugins.entries.voice-call.config.streaming`.

Batch transcription uploads the complete audio file to Deepgram and injects
the transcript into the reply pipeline (`{{Transcript}}` + `[Audio]` block).
Voice Call streaming forwards live G.711 u-law frames over Deepgram's
WebSocket `listen` endpoint and emits partial/final transcripts as Deepgram
returns them.

| Detail        | Value                                                      |
| ------------- | ---------------------------------------------------------- |
| Website       | [deepgram.com](https://deepgram.com)                       |
| Docs          | [developers.deepgram.com](https://developers.deepgram.com) |
| Auth          | `DEEPGRAM_API_KEY`                                         |
| Default model | `nova-3`                                                   |

## Getting started

<Steps>
  <Step title="Set your API key">
    ```bash
    DEEPGRAM_API_KEY=dg_...
    ```
  </Step>
  <Step title="Enable the audio provider">
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
  </Step>
  <Step title="Send a voice note">
    Send an audio message through any connected channel. OpenClaw transcribes it
    via Deepgram and injects the transcript into the reply pipeline.
  </Step>
</Steps>

## Configuration options

| Option     | Path                                  | Description                           |
| ---------- | ------------------------------------- | ------------------------------------- |
| `model`    | `tools.media.audio.models[].model`    | Deepgram model id (default: `nova-3`) |
| `language` | `tools.media.audio.models[].language` | Language hint (optional)              |

`providerOptions.deepgram` merges extra query params directly into the
Deepgram `/listen` request, so any Deepgram-supported param name works
(for example `detect_language`, `punctuate`, `smart_format`):

<Tabs>
  <Tab title="With language hint">
    ```json5
    {
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
          },
        },
      },
    }
    ```
  </Tab>
  <Tab title="With Deepgram options">
    ```json5
    {
      tools: {
        media: {
          audio: {
            enabled: true,
            providerOptions: {
              deepgram: {
                detect_language: true,
                punctuate: true,
                smart_format: true,
              },
            },
            models: [{ provider: "deepgram", model: "nova-3" }],
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

## Voice Call streaming STT

The bundled `deepgram` plugin also registers a realtime transcription provider
for the Voice Call plugin.

| Setting         | Config path                                                             | Default                                      |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| API key         | `plugins.entries.voice-call.config.streaming.providers.deepgram.apiKey` | Falls back to `DEEPGRAM_API_KEY`             |
| Base URL        | `...deepgram.baseUrl`                                                   | `DEEPGRAM_BASE_URL` or Deepgram's public API |
| Model           | `...deepgram.model`                                                     | `nova-3`                                     |
| Language        | `...deepgram.language`                                                  | (unset)                                      |
| Encoding        | `...deepgram.encoding`                                                  | `mulaw`                                      |
| Sample rate     | `...deepgram.sampleRate`                                                | `8000`                                       |
| Endpointing     | `...deepgram.endpointingMs`                                             | `800`                                        |
| Interim results | `...deepgram.interimResults`                                            | `true`                                       |

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "deepgram",
            providers: {
              deepgram: {
                apiKey: "${DEEPGRAM_API_KEY}",
                model: "nova-3",
                endpointingMs: 800,
                language: "en-US",
              },
            },
          },
        },
      },
    },
  },
}
```

For a [Deepgram custom endpoint](https://developers.deepgram.com/reference/custom-endpoints),
set `baseUrl` to the endpoint root, including any base path but not `/listen`.
Realtime endpoints accept `http://`, `https://`, `ws://`, and `wss://`. HTTP
maps to WS, HTTPS maps to WSS, and explicit WebSocket schemes stay unchanged.
Malformed URLs and other schemes fail during session setup.

<Note>
Voice Call receives telephony audio as 8 kHz G.711 u-law. The Deepgram
streaming provider defaults to `encoding: "mulaw"` and `sampleRate: 8000`, so
Twilio media frames can be forwarded directly.
</Note>

## Notes

<AccordionGroup>
  <Accordion title="Authentication">
    Authentication follows the standard provider auth order. `DEEPGRAM_API_KEY` is
    the simplest path.
  </Accordion>
  <Accordion title="Proxy and custom endpoints">
    Override endpoints or headers with `tools.media.audio.baseUrl` and
    `tools.media.audio.headers` when using a proxy.
  </Accordion>
  <Accordion title="Output behavior">
    Output follows the same audio rules as other providers (size caps, timeouts,
    transcript injection).
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Media tools" href="/tools/media-overview" icon="photo-film">
    Audio, image, and video processing pipeline overview.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference including media tool settings.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
  <Card title="FAQ" href="/help/faq" icon="circle-question">
    Frequently asked questions about OpenClaw setup.
  </Card>
</CardGroup>
