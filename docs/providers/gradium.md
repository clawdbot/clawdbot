---
summary: "Use Gradium text-to-speech in OpenClaw"
read_when:
  - You want Gradium for text-to-speech
  - You need Gradium API key, voice, or directive token configuration
title: "Gradium"
---

[Gradium](https://gradium.ai) is a bundled text-to-speech provider for OpenClaw. The plugin can render normal audio replies (WAV), voice-note-compatible Opus output, and 8 kHz u-law audio for telephony surfaces.

| Property      | Value                                |
| ------------- | ------------------------------------ |
| Provider id   | `gradium`                            |
| Auth          | `GRADIUM_API_KEY` or config `apiKey` |
| Base URL      | `https://api.gradium.ai` (default)   |
| Default voice | `Emma` (`YTpq7expH9539ERJ`)          |

## Setup

Create a Gradium API key, then expose it to OpenClaw with either an env var or the config key.

<Tabs>
  <Tab title="Env var">
    ```bash
    export GRADIUM_API_KEY="gsk_..."
    ```
  </Tab>

  <Tab title="Config key">
    ```json5
    {
      messages: {
        tts: {
          auto: "always",
          provider: "gradium",
          providers: {
            gradium: {
              apiKey: "${GRADIUM_API_KEY}",
            },
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

The plugin checks the resolved `apiKey` first and falls back to the `GRADIUM_API_KEY` environment variable.

## Config

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "gradium",
      providers: {
        gradium: {
          voiceId: "YTpq7expH9539ERJ",
          // apiKey: "${GRADIUM_API_KEY}",
          // baseUrl: "https://api.gradium.ai",
        },
      },
    },
  },
}
```

| Key                                      | Type   | Description                                                                                   |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `messages.tts.providers.gradium.apiKey`  | string | Resolved API key. Supports `${ENV}` and secret refs.                                          |
| `messages.tts.providers.gradium.baseUrl` | string | Override the API origin. Trailing slashes are stripped. Defaults to `https://api.gradium.ai`. |
| `messages.tts.providers.gradium.voiceId` | string | Default voice id used when no directive override is present.                                  |

The output audio format is selected automatically by the runtime based on the target surface and is not configurable from `openclaw.json`. See [Output](#output) below.

## Voices

| Name      | Voice ID           |
| --------- | ------------------ |
| Emma      | `YTpq7expH9539ERJ` |
| Kent      | `LFZvm12tW_z0xfGo` |
| Tiffany   | `Eu9iL_CYe8N-Gkx_` |
| Christina | `2H4HY2CBNyJHBCrP` |
| Sydney    | `jtEKaLYNn6iif5PR` |
| John      | `KWJiFWu2O9nMPYcR` |
| Arthur    | `3jUdJyOi9pgbxBTK` |

Default voice: Emma.

### Per-message voice override

When the active speech policy allows voice overrides, you can switch voices inline using a directive token. All of these resolve to the same `voiceId` override:

```text
/voice:LFZvm12tW_z0xfGo
/voice_id:LFZvm12tW_z0xfGo
/voiceid:LFZvm12tW_z0xfGo
/gradium_voice:LFZvm12tW_z0xfGo
/gradiumvoice:LFZvm12tW_z0xfGo
```

If the speech policy disables voice overrides, the directive is consumed but ignored.

## Output

The runtime picks the output format from the target surface. The provider does not synthesize other formats today.

| Target         | Format      | File ext | Sample rate | Voice-compatible flag |
| -------------- | ----------- | -------- | ----------- | --------------------- |
| Standard audio | `wav`       | `.wav`   | provider    | no                    |
| Voice note     | `opus`      | `.opus`  | provider    | yes                   |
| Telephony      | `ulaw_8000` | n/a      | 8 kHz       | n/a                   |

## Auto-select order

Among configured TTS providers, Gradium's auto-select order is `30`. See [Text-to-Speech](/tools/tts) for how OpenClaw picks the active provider when `messages.tts.provider` is not pinned.

## Related

- [Text-to-Speech](/tools/tts)
- [Media Overview](/tools/media-overview)
