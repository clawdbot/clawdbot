---
summary: "Talk mode: continuous speech conversations across local STT/TTS and realtime voice"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
title: "Talk mode"
---

Talk mode has two runtime shapes:

- Native macOS/iOS/Android Talk uses local speech recognition, Gateway chat, and `talk.speak` TTS. Nodes advertise the `talk` capability and declare the `talk.*` commands they support.
- Browser Talk uses `talk.client.create` for client-owned `webrtc` and `provider-websocket` sessions, or `talk.session.create` for Gateway-owned `gateway-relay` sessions. `managed-room` is reserved for Gateway handoff and walkie-talkie rooms.
- Transcription-only clients use `talk.session.create({ mode: "transcription", transport: "gateway-relay", brain: "none" })`, then `talk.session.appendAudio`, `talk.session.cancelTurn`, and `talk.session.close` when they need captions or dictation without an assistant voice response.

Native Talk is a continuous voice conversation loop:

1. Listen for speech
2. Send transcript to the model through the active session
3. Wait for the response
4. Speak it via the configured Talk provider (`talk.speak`)

Browser realtime Talk forwards provider tool calls through `talk.client.toolCall`; browser clients do not call `chat.send` directly for realtime consults.

Transcription-only Talk emits the same common Talk event envelope as realtime and STT/TTS sessions, but uses `mode: "transcription"` and `brain: "none"`. It is for captions, dictation, and observe-only speech capture; one-shot uploaded voice notes still use the media/audio path.

## Behavior (macOS)

- **Always-on overlay** while Talk mode is enabled.
- **Listening → Thinking → Speaking** phase transitions.
- On a **short pause** (silence window), the current transcript is sent.
- Replies are **written to WebChat** (same as typing).
- **Interrupt on speech** (default on): if the user starts talking while the assistant is speaking, we stop playback and note the interruption timestamp for the next prompt.

## Voice directives in replies

The assistant may prefix its reply with a **single JSON line** to control voice:

```json
{ "voice": "<voice-id>", "once": true }
```

Rules:

- First non-empty line only.
- Unknown keys are ignored.
- `once: true` applies to the current reply only.
- Without `once`, the voice becomes the new default for Talk mode.
- The JSON line is stripped before TTS playback.

Supported keys:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

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
          model: "gpt-realtime-2",
          voice: "cedar",
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

Defaults:

- `interruptOnSpeech`: true
- `silenceTimeoutMs`: when unset, Talk keeps the platform default pause window before sending the transcript (`700 ms on macOS and Android, 900 ms on iOS`)
- `provider`: selects the active Talk provider. Use `elevenlabs`, `mlx`, or `system` for the macOS-local playback paths.
- `providers.<provider>.voiceId`: falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` for ElevenLabs (or first ElevenLabs voice when API key is available).
- `providers.elevenlabs.modelId`: defaults to `eleven_v3` when unset.
- `providers.mlx.modelId`: defaults to `mlx-community/Soprano-80M-bf16` when unset.
- `providers.elevenlabs.apiKey`: falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available).
- `consultThinkingLevel`: optional thinking level override for the full OpenClaw agent run behind realtime `openclaw_agent_consult` calls.
- `consultFastMode`: optional fast-mode override for realtime `openclaw_agent_consult` calls.
- `realtime.provider`: selects the active browser/server realtime voice provider. Use `openai` for WebRTC, `google` for provider WebSocket, or a bridge-only provider through Gateway relay.
- `realtime.providers.<provider>` stores provider-owned realtime config. The browser receives only ephemeral or constrained session credentials, never a standard API key.
- `realtime.providers.openai.voice`: built-in OpenAI Realtime voice id. Current `gpt-realtime-2` voices are `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, and `cedar`; `marin` and `cedar` are recommended for best quality.
- `realtime.brain`: `agent-consult` routes realtime tool calls through Gateway policy; `direct-tools` is owner-only compatibility behavior; `none` is for transcription or external orchestration.
- `realtime.instructions`: appends provider-facing system instructions to OpenClaw's built-in realtime prompt. Use it for voice style and tone; OpenClaw keeps the default `openclaw_agent_consult` guidance.
- `talk.catalog` exposes each provider's valid modes, transports, brain strategies, realtime audio formats, and capability flags so first-party Talk clients can avoid unsupported combinations.
- Streaming transcription providers are discovered through `talk.catalog.transcription`. The current Gateway relay uses the Voice Call streaming provider config until the dedicated Talk transcription config surface is added.
- `speechLocale`: optional BCP 47 locale id for on-device Talk speech recognition on iOS/macOS. Leave unset to use the device default.
- `outputFormat`: defaults to `pcm_44100` on macOS/iOS and `pcm_24000` on Android (set `mp3_*` to force MP3 streaming)

## macOS UI

- Menu bar toggle: **Talk**
- Config tab: **Talk Mode** group (voice id + interrupt toggle)
- Overlay:
  - **Listening**: cloud pulses with mic level
  - **Thinking**: sinking animation
  - **Speaking**: radiating rings
  - Click cloud: stop speaking
  - Click X: exit Talk mode

## Android UI

- Voice tab toggle: **Talk**
- Manual **Mic** and **Talk** are mutually exclusive runtime capture modes.
- Manual Mic stops when the app leaves the foreground or the user leaves the Voice tab.
- Talk Mode keeps running until toggled off or the Android node disconnects, and uses Android's microphone foreground-service type while active.

## Notes

- Requires Speech + Microphone permissions.
- Native Talk uses the active Gateway session and only falls back to history polling when response events are unavailable.
- Browser realtime Talk uses `talk.client.toolCall` for `openclaw_agent_consult` instead of exposing `chat.send` to provider-owned browser sessions.
- Transcription-only Talk uses `talk.session.create`, `talk.session.appendAudio`, `talk.session.cancelTurn`, and `talk.session.close`; clients subscribe to `talk.event` for partial/final transcript updates.
- The gateway resolves Talk playback through `talk.speak` using the active Talk provider. Android falls back to local system TTS only when that RPC is unavailable.
- macOS local MLX playback uses the bundled `openclaw-mlx-tts` helper when present, or an executable on `PATH`. Set `OPENCLAW_MLX_TTS_BIN` to point at a custom helper binary during development.
- `stability` for `eleven_v3` is validated to `0.0`, `0.5`, or `1.0`; other models accept `0..1`.
- `latency_tier` is validated to `0..4` when set.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency AudioTrack streaming.

## Related

- [Voice wake](/nodes/voicewake)
- [Audio and voice notes](/nodes/audio)
- [Media understanding](/nodes/media-understanding)
