---
summary: "Use Gradium text-to-speech in OpenClaw"
read_when:
  - You want Gradium for text-to-speech
  - You need Gradium API key, voice, or directive token configuration
title: "Gradium"
---

[Gradium](https://gradium.ai) is a text-to-speech provider for OpenClaw. It renders standard audio replies (WAV), voice-note-compatible Opus output, and 8 kHz u-law audio for telephony surfaces.

| Property      | Value                                |
| ------------- | ------------------------------------ |
| Provider id   | `gradium`                            |
| Auth          | `GRADIUM_API_KEY` or config `apiKey` |
| Base URL      | `https://api.gradium.ai` (default)   |
| Default voice | `Emma` (`YTpq7expH9539ERJ`)          |

## Install plugin

Gradium is an official external plugin. Install it, then restart Gateway:

```bash
openclaw plugins install @openclaw/gradium-speech
openclaw gateway restart
```

## Setup

Create a Gradium API key, then expose it with an env var or the config key. Config takes precedence over the env var.

<Tabs>
  <Tab title="Env var">
    ```bash
    export GRADIUM_API_KEY="gsk_..."
    ```
  </Tab>

  <Tab title="Config key">
    ```json5
    {
      tts: {
        auto: "always",
        provider: "gradium",
        providers: {
          gradium: {
            apiKey: "${GRADIUM_API_KEY}",
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

## Config

```json5
{
  tts: {
    auto: "always",
    provider: "gradium",
    providers: {
      gradium: {
        speakerVoiceId: "YTpq7expH9539ERJ",
        // apiKey: "${GRADIUM_API_KEY}",
        // baseUrl: "https://api.gradium.ai",
      },
    },
  },
}
```

| Key                                    | Type   | Description                                                                                             |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `tts.providers.gradium.apiKey`         | string | Resolved API key. Supports `${ENV}` and secret refs.                                                    |
| `tts.providers.gradium.baseUrl`        | string | HTTPS Gradium API URL on `api.gradium.ai`. Trailing slashes stripped. Default `https://api.gradium.ai`. |
| `tts.providers.gradium.speakerVoiceId` | string | Default voice id used when no directive override is present.                                            |

Output format is chosen automatically by target surface (see [Output](#output)) and is not configurable in `openclaw.json`.

## Voices

| Name               | Voice ID           |
| ------------------ | ------------------ |
| Arthur             | `3jUdJyOi9pgbxBTK` |
| Christina          | `2H4HY2CBNyJHBCrP` |
| Emma **(default)** | `YTpq7expH9539ERJ` |
| John               | `KWJiFWu2O9nMPYcR` |
| Kent               | `LFZvm12tW_z0xfGo` |
| Sydney             | `jtEKaLYNn6iif5PR` |
| Tiffany            | `Eu9iL_CYe8N-Gkx_` |

### Per-message voice override

When the active speech policy allows voice overrides, switch voices inline with a directive token (any of these are equivalent, all take a provider-native voice id):

```text
/voice:LFZvm12tW_z0xfGo
/voice_id:LFZvm12tW_z0xfGo
/voiceid:LFZvm12tW_z0xfGo
/gradium_voice:LFZvm12tW_z0xfGo
/gradiumvoice:LFZvm12tW_z0xfGo
```

If the speech policy disables voice overrides, the directive is consumed but ignored.

## Output

Output format is selected by target surface; the provider does not synthesize other formats.

| Target         | Format      | File ext | Sample rate | Voice-compatible flag |
| -------------- | ----------- | -------- | ----------- | --------------------- |
| Standard audio | `wav`       | `.wav`   | provider    | no                    |
| Voice note     | `opus`      | `.opus`  | provider    | yes                   |
| Telephony      | `ulaw_8000` | n/a      | 8 kHz       | n/a                   |

## Auto-select order

Among configured TTS providers, Gradium's auto-select order is `30`. See [Text-to-Speech](/tools/tts) for how OpenClaw picks the active provider when `tts.provider` is not pinned.

## Related

- [Text-to-Speech](/tools/tts)
- [Media Overview](/tools/media-overview)
