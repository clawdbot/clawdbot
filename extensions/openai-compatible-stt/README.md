# OpenAI-compatible realtime STT (universal)

Universal realtime transcription provider for OpenClaw. Lets any user point the
chat-composer microphone at **whisper.cpp server mode**, **faster-whisper-server**,
**vLLM**, or any custom WebSocket transcription endpoint that follows the
minimal protocol documented below.

This plugin is opt-in and ships enabled by default so the provider shows up in
the existing transcription catalog. Disable it via `enabledByDefault: false`
or via the OpenClaw setup UI if you do not use it.

## Wire protocol

Designed for universal compatibility. The plugin streams raw PCM audio
(16-bit little-endian, mono) as binary WebSocket frames and receives JSON
events on the same connection.

### Client ÔåÆ server

- Binary frames: PCM `pcm_s16le` audio. The Gateway negotiates sample rate;
  16 kHz is the default and what every mainstream STT engine supports.

### Server ÔåÆ client

JSON text frames, one event per message. Unknown event types are ignored.

| `type`         | Required?   | Payload                     | Meaning                                                  |
| -------------- | ----------- | --------------------------- | -------------------------------------------------------- |
| `ready`        | optional    | ÔÇö                         | Server finished loading its model; emit once after open. |
| `speech_start` | optional    | ÔÇö                         | User started speaking; useful for UI hints.              |
| `partial`      | recommended | `{ "text": "hello wor" }`   | Interim transcript.                                      |
| `final`        | recommended | `{ "text": "hello world" }` | Final transcript for the current utterance.              |
| `error`        | optional    | `{ "message": "..." }`      | Server-side failure; emitted to `onError`.               |

Servers that only emit `final` events work fine ÔÇö the OpenClaw composer
collects each `final` and inserts it as text.

### Out-of-band configuration

The provider appends standard query parameters to the endpoint URL so the
server can route the session without a separate hello handshake:

| Parameter         | Source                                           | Notes                                                       |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `model`           | `providerConfig.model` (default `whisper-1`)     | Forwarded unchanged; ignored by servers that do not use it. |
| `sample_rate`     | `providerConfig.sampleRate` (default `16000`)    | Always sent.                                                |
| `encoding`        | always `pcm_s16le`                               | Always sent.                                                |
| `interim_results` | `providerConfig.interimResults` (default `true`) | Always sent; remove on the server side if unsupported.      |
| `language`        | `providerConfig.language` (optional)             | BCP-47, e.g. `en`.                                          |

`http://` and `https://` endpoints are automatically translated to `ws://`
and `wss://` for convenience. Direct WebSocket URLs are preserved.

## Configuration

```json5
{
  plugins: {
    entries: {
      "openai-compatible-stt": {
        config: {
          providers: {
            "openai-compatible-stt": {
              // Required. http(s) is auto-translated to ws(s).
              endpoint: "http://127.0.0.1:8765/ws/transcribe",

              // Optional bearer token sent as `Authorization: Bearer <apiKey>`.
              apiKey: "...",

              // Optional model/language/sample rate overrides.
              model: "whisper-1",
              language: "en",
              sampleRate: 16000,
              interimResults: true,
            },
          },
        },
      },
    },
  },
}
```

Equivalent environment variables when you prefer not to write the secret into
config: `OPENAI_COMPATIBLE_STT_ENDPOINT` and `OPENAI_COMPATIBLE_STT_API_KEY`.

## Selecting the provider

The provider appears in the Talk/transcription catalog under the label
`OpenAI-compatible STT (universal)` and the aliases `local-stt`,
`whisper-local`, and `openai-compat-stt`. Pick it from the Talk settings
page in the Control UI, or set:

```json5
{
  talk: {
    transcription: {
      provider: "openai-compatible-stt",
      providers: {
        "openai-compatible-stt": {
          endpoint: "http://127.0.0.1:8765/ws/transcribe",
        },
      },
    },
  },
}
```

## Server examples

- **whis.cpp** ÔÇö expose the [whisper.cpp server example][whisper-server]
  via a thin WebSocket shim that converts raw PCM frames into the protocol
  above. whisper.cpp does not natively speak this protocol, so a small
  bridge (`~80 lines`) is required.
- **faster-whisper-server** ÔÇö wrap its HTTP `/v1/audio/transcriptions`
  endpoint with a WebSocket gateway that buffers until commit.
- **vLLM** ÔÇö use the OpenAI-compatible `/v1/audio/transcriptions` route
  through a small WebSocket shim.
- **Custom worker** ÔÇö speak the protocol directly; see the event table
  above.

[whisper-server]: https://github.com/ggml-org/whisper.cpp/tree/master/examples/server

## Why a separate plugin?

The bundled OpenAI realtime transcription provider speaks OpenAI's Realtime
WebSocket protocol. That protocol is not what self-hosted STT servers expose
out of the box. This plugin decouples OpenClaw's dictation flow from any
specific cloud vendor by speaking a minimal universal protocol ÔÇö the same
shape that whisper.cpp + a thin shim, faster-whisper-server, and custom
workers can all implement.
