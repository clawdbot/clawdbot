---
summary: "Deepgram transcription for inbound voice notes"
read_when:
  - You want Deepgram speech-to-text for audio attachments
  - You need a quick Deepgram config example
---
# Deepgram (Audio Transcription)

Deepgram is a speech-to-text API. In Moltbot it is used for **inbound audio/voice note
transcription** via `tools.media.audio`.

When enabled, Moltbot uploads the audio file to Deepgram and injects the transcript
into the reply pipeline (`{{Transcript}}` + `[Audio]` block). This is **not streaming**;
it uses the pre-recorded transcription endpoint.

Website: https://deepgram.com  
Docs: https://developers.deepgram.com

## Quick start

1) Set your API key:
```
DEEPGRAM_API_KEY=dg_...
```

2) Enable the provider:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }]
      }
    }
  }
}
```

## Options

- `model`: Deepgram model id (default: `nova-3`)
- `language`: language hint (optional)
- `tools.media.audio.providerOptions.deepgram.detect_language`: enable language detection (optional)
- `tools.media.audio.providerOptions.deepgram.punctuate`: enable punctuation (optional)
- `tools.media.audio.providerOptions.deepgram.smart_format`: enable smart formatting (optional)

Example with language:
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "deepgram", model: "nova-3", language: "en" }
        ]
      }
    }
  }
}
```

Example with Deepgram options:
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
            smart_format: true
          }
        },
        models: [{ provider: "deepgram", model: "nova-3" }]
      }
    }
  }
}
```

## Notes

- Authentication follows the standard provider auth order; `DEEPGRAM_API_KEY` is the simplest path.
- Override endpoints or headers with `tools.media.audio.baseUrl` and `tools.media.audio.headers` when using a proxy.
- Output follows the same audio rules as other providers (size caps, timeouts, transcript injection).
