---
summary: "Talk mode: continuous speech conversations across local STT/TTS and realtime voice"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
title: "Talk mode"
---

Talk mode covers five runtime shapes:

- **Native macOS/iOS/Android Talk**: native speech recognition, Gateway chat, and `talk.speak` TTS. Apple Speech recognition on macOS/iOS may use network services; Android behavior depends on the installed speech service. Nodes advertise the `talk` capability and declare which `talk.*` commands they support.
- **iOS Talk (realtime)**: client-owned WebRTC for OpenAI realtime configs that select `webrtc` transport or omit transport. Explicit `gateway-relay`, `provider-websocket`, and non-OpenAI realtime configs stay on the Gateway-owned relay; non-realtime configs use the native speech loop.
- **Browser Talk**: `talk.client.create` for client-owned `webrtc`/`provider-websocket` sessions, or `talk.session.create` for Gateway-owned `gateway-relay` sessions. `managed-room` is reserved for Gateway handoff and walkie-talkie rooms.
- **Android Talk (realtime)**: opt in with `talk.realtime.mode: "realtime"` and `talk.realtime.transport: "gateway-relay"`. Otherwise Android stays on native speech recognition, Gateway chat, and `talk.speak`.
- **Transcription-only clients**: `talk.session.create({ mode: "transcription", transport: "gateway-relay", brain: "none" })`, then `talk.session.appendAudio`, `talk.session.cancelTurn`, and `talk.session.close` for captions/dictation without an assistant voice response. One-shot uploaded voice notes still use the [media understanding](/nodes/media-understanding) audio path.

Native Talk is a continuous loop: listen for speech, send the transcript to the model through the active session, wait for the response, then speak it via the configured Talk provider (`talk.speak`).

Client-owned realtime Talk forwards provider tool calls through `talk.client.toolCall` instead of calling `chat.send` directly. While a realtime consult is active, clients can call `talk.client.steer` or `talk.session.steer` to classify spoken input as `status`, `steer`, `cancel`, or `followup`. Accepted steering queues into the active embedded run; rejected steering returns a reason such as `no_active_run`, `not_streaming`, or `compacting`.

Finalized realtime user and assistant utterances are always appended live to the active agent session, so later chat and voice turns share one history. Client-owned transports report their finalized transcripts with stable entry ids; Gateway relay sessions append the same events server-side. Provider sessions also receive the bounded realtime profile context used by Discord voice.

Voice-originated consult runs require a new, exact spoken confirmation before high-impact actions such as sending messages, controlling nodes, browser/computer actions, service changes, destructive shell commands, or publication. The confirmation applies only to the exact blocked tool arguments and is consumed once; unrelated concurrent runs remain unaffected. When a call closes, OpenClaw can send a compact **Voice call changes** digest for mutating tools to the session's last non-WebChat delivery target.

Transcription-only Talk emits the same Talk event envelope as realtime and STT/TTS sessions, but uses `mode: "transcription"` and `brain: "none"`. All Talk sessions broadcast events on the `talk.event` channel; clients subscribe to it for partial/final transcript updates (`transcript.delta`/`transcript.done`) and other session telemetry.

Browser Video Talk is available for OpenAI Realtime WebRTC and Google Live
provider-WebSocket sessions. OpenAI gets a single bounded JPEG when
`describe_view` asks for visual context; it does not receive a continuous
camera track. Google Live receives bounded JPEG frames directly from the
browser at up to one frame per second, while `describe_view` reports the
camera-stream state. In both cases, camera frames bypass the Gateway, and
stopping Talk releases the camera and microphone tracks.

## Behavior (macOS)

- Always-on overlay while Talk mode is enabled.
- **Listening &rarr; Thinking &rarr; Speaking** phase transitions.
- On a short pause (silence window), the current transcript is sent.
- Replies are written to WebChat (same as typing).
- **Interrupt on speech** (default on): if the user talks while the assistant is speaking, playback stops and the interruption timestamp is noted for the next prompt.

## Voice directives in replies

The assistant can prefix a reply with a single JSON line to control voice:

```json
{ "voice": "<voice-id>", "once": true }
```

Rules:

- First non-empty line only; the JSON line is stripped before TTS playback.
- Unknown keys are ignored.
- `once: true` applies to the current reply only; without it, the voice becomes the new Talk mode default.

Supported keys: `voice` / `voice_id` / `voiceId`, `model` / `model_id` / `modelId`, `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`, `seed`, `normalize`, `lang`, `output_format`, `latency_tier`, `once`.

## Config (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "elevenlabs_voice_id",
        modelId: "eleven_v3",
        outputFormat: "mp3_44100_128",
        apiKey: "elevenlabs_api_key",
      },
      mlx: {
        modelId: "mlx-community/Soprano-80M-bf16",
      },
      system: {},
    },
    speechLocale: "ru-RU",
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
    realtime: {
      provider: "openai",
      providers: {
        openai: {
          apiKey: "openai_api_key",
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
        },
      },
      instructions: "Speak warmly and keep answers brief.",
      mode: "realtime",
      transport: "webrtc",
      brain: "agent-consult",
    },
  },
}
```

| Key                                      | Default                                    | Notes                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                               | -                                          | Active Talk TTS provider. Use `elevenlabs`, `mlx`, or `system` for macOS-local playback paths.                                                                                                                                                                             |
| `providers.<id>.voiceId`                 | -                                          | ElevenLabs falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`, or the first available voice with an API key.                                                                                                                                                             |
| `speechLocale`                           | device default                             | BCP 47 locale for Android, iOS, and macOS native speech recognition. Apple Speech may use network services; Android also forwards the language component to realtime input transcription.                                                                                  |
| `providers.elevenlabs.modelId`           | `eleven_v3`                                |                                                                                                                                                                                                                                                                            |
| `providers.mlx.modelId`                  | `mlx-community/Soprano-80M-bf16`           |                                                                                                                                                                                                                                                                            |
| `providers.elevenlabs.apiKey`            | -                                          | Falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available).                                                                                                                                                                                                |
| `silenceTimeoutMs`                       | `700` ms macOS/Android, `900` ms iOS       | Pause window before Talk sends the transcript.                                                                                                                                                                                                                             |
| `interruptOnSpeech`                      | `true`                                     |                                                                                                                                                                                                                                                                            |
| `outputFormat`                           | `pcm_44100` macOS/iOS, `pcm_24000` Android | Set `mp3_*` to force MP3 streaming.                                                                                                                                                                                                                                        |
| `consultThinkingLevel`                   | unset                                      | Thinking level override for the agent run behind realtime `openclaw_agent_consult` calls.                                                                                                                                                                                  |
| `consultFastMode`                        | unset                                      | Fast-mode override for realtime `openclaw_agent_consult` calls.                                                                                                                                                                                                            |
| `realtime.provider`                      | -                                          | `openai` for WebRTC, `google` for provider WebSocket, or a bridge-only provider through Gateway relay.                                                                                                                                                                     |
| `realtime.providers.<id>`                | -                                          | Provider-owned realtime config. Browsers receive only ephemeral/constrained session credentials, never a standard API key.                                                                                                                                                 |
| `realtime.providers.openai.speakerVoice` | `alloy`                                    | Built-in OpenAI Realtime voice id (the older `voice` key still works but is deprecated). Current `gpt-realtime-2.1` voices: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`; `marin` and `cedar` are recommended for best quality. |
| `realtime.transport`                     | -                                          | `webrtc`: client-owned OpenAI WebRTC on iOS and in the browser. `provider-websocket`: browser-owned, stays on Gateway relay on iOS. `gateway-relay`: keeps provider audio on the Gateway; Android uses realtime only with this transport.                                  |
| `realtime.brain`                         | -                                          | `agent-consult` routes realtime tool calls through Gateway policy; `direct-tools` is legacy direct-tool compatibility; `none` is for transcription/external orchestration.                                                                                                 |
| `realtime.consultRouting`                | -                                          | `provider-direct` preserves the provider's direct reply when it skips `openclaw_agent_consult`; `force-agent-consult` routes finalized user transcripts through OpenClaw instead.                                                                                          |
| `realtime.instructions`                  | -                                          | Appends provider-facing system instructions to OpenClaw's built-in realtime prompt (voice style/tone); the default `openclaw_agent_consult` guidance stays.                                                                                                                |

`talk.catalog` exposes canonical provider ids and registry aliases, each provider's valid modes/transports/brain strategies/realtime audio formats/capability flags, and the runtime-selected readiness result. First-party Talk clients should read that catalog instead of maintaining provider aliases locally; treat an older Gateway that omits group readiness as unverified rather than definitively unconfigured. Streaming transcription providers are discovered through `talk.catalog.transcription`; the current Gateway relay uses the Voice Call streaming provider config until a dedicated Talk transcription config surface ships.

## macOS UI

- Menu bar toggle: **Talk**
- Config tab: **Talk Mode** group (voice id + interrupt toggle)
- Overlay: the orb renders the universal talk waveform (shared with iOS, watchOS, and Android). Listening follows the live mic level, Speaking follows the actual TTS playback envelope, Thinking breathes softly. Click the orb to pause/resume, double-click to stop speaking, click X to exit Talk mode.

## Android UI

- Android's main navigation is **Home**, **Chat**, and **Settings**. Voice input
  lives in the Chat composer rather than a separate Voice tab.
- Tap the composer microphone for on-device dictation. Long-press it to record
  a voice-note attachment. Start continuous Talk from the Talk waveform.
- Dictation, voice-note recording, and Talk are mutually exclusive microphone
  paths; starting one stops or blocks the others.
- Realtime Talk prefers a connected Bluetooth Classic or BLE headset
  microphone; if it disconnects, the app requests another headset input or
  falls back to the default microphone, restoring the default preference once
  capture stops.
- Dictation and voice-note recording stop when the app leaves the foreground or
  the user leaves Chat.
- Talk Mode keeps running until toggled off or the node disconnects, using Android's microphone foreground-service type while active.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency `AudioTrack` streaming.

## Notes

- Requires Speech + Microphone permissions.
- Native Talk uses the active Gateway session and only falls back to history polling when response events are unavailable.
- The gateway resolves Talk playback through `talk.speak` using the active Talk provider. Android falls back to local system TTS only when that RPC is unavailable.
- macOS local MLX playback uses the bundled `openclaw-mlx-tts` helper when present, or an executable on `PATH`. Set `OPENCLAW_MLX_TTS_BIN` to point at a custom helper binary during development.
- Voice directive value ranges (ElevenLabs): `stability`, `similarity`, and `style` accept `0..1`; `speed` accepts `0.5..2`; `latency_tier` accepts `0..4`.

## Related

- [Voice wake](/nodes/voicewake)
- [Audio and voice notes](/nodes/audio)
- [Media understanding](/nodes/media-understanding)
