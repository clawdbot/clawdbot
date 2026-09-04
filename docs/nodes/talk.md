---
summary: "Talk mode: continuous speech conversations across local STT/TTS and realtime voice"
read_when:
  - Implementing Talk mode on macOS/iOS/Android
  - Changing voice/TTS/interrupt behavior
title: "Talk mode"
---

Talk mode covers five runtime shapes:

- **Native macOS/iOS/Android Talk**: native speech recognition, Gateway chat, and `talk.speak` TTS. Apple Speech recognition on macOS/iOS may use network services; Android behavior depends on the installed speech service. Nodes advertise the `talk` capability and declare which `talk.*` commands they support.
- **iOS Talk (realtime)**: client-owned WebRTC for OpenAI realtime configs that select `webrtc` transport or omit transport, including framed and frameless transcript/audio events. Explicit `gateway-relay`, `provider-websocket`, and non-OpenAI realtime configs stay on the Gateway-owned relay; non-realtime configs use the native speech loop.
- **Browser Talk**: `talk.client.create` for client-owned `webrtc`/`provider-websocket` sessions, or `talk.session.create` for Gateway-owned `gateway-relay` sessions. `managed-room` is reserved for Gateway handoff and walkie-talkie rooms.
- **Android Talk (realtime)**: Android uses Gateway-owned relay realtime when `talk.catalog` reports the realtime group ready and the configured model passes the Android client gate; it never opens a client-owned WebRTC session. The Gateway now supports `gpt-live-*` relay sessions, but Android intentionally keeps those models on native speech recognition, Gateway chat, and `talk.speak` until the relay path is proven live from an Android device.
- **Transcription-only clients**: `talk.session.create({ mode: "transcription", transport: "gateway-relay", brain: "none" })`, then `talk.session.appendAudio` and `talk.session.close` for captions/dictation without an assistant voice response. One-shot uploaded voice notes still use the [media understanding](/nodes/media-understanding) audio path.

Native Talk is a continuous loop: listen for speech, send the transcript to the model through the active session, wait for the response, then speak it via the configured Talk provider (`talk.speak`).

Apple Watch uses a separate [one-turn voice and chat flow](/platforms/ios#apple-watch-voice-and-chat): native dictation, text relayed through the paired iPhone, and system-voice readback on the Watch. It is not a continuous or realtime Talk client.

## Choose a Talk voice from chat

After setting `talk.provider` and the matching `talk.providers.<provider>` configuration, use `/voice status` to inspect the active provider and voice, `/voice list [limit]` to list its available voices, and `/voice set <voiceId|name>` to save a provider-scoped selection. Discord exposes the same command natively as `/talkvoice`.

Status and list are read-only. Setting a voice requires the message-channel owner or a Gateway client with `operator.admin`. Configuration, provider lookup, unknown-voice, and permission failures are returned visibly in chat. A masked API-key value in `/voice status` describes config only; it does not verify credential availability.

Client-owned realtime Talk normally forwards provider tool calls through `talk.client.toolCall` instead of calling `chat.send` directly. GPT-Live WebRTC sessions delegate on a Gateway-owned sideband, and the Gateway binds each delegation to the browser or Gateway-relay Talk session that owns it. Backend WebSocket bridges use the normal relay consult path. While a realtime consult is active, clients can call `talk.client.steer` or `talk.session.steer` to classify spoken input as `status`, `steer`, `cancel`, or `followup`; this includes GPT-Live delegations. Accepted steering queues into the active embedded run; rejected steering returns a reason such as `no_active_run`, `not_streaming`, or `compacting`. A newer GPT-Live spoken task also supersedes the running delegation.

Thin audio clients can request `gateway-control-v1` in
`talk.client.create.capabilities`. OpenAI GA Realtime requires a Platform API
key for this mode. Native GPT-Live uses its existing ChatGPT OAuth or Platform
authentication; requesting Gateway control does not switch the selected model
or authentication route.

Success returns `clientControl: { owner: "gateway" }`, a 60-second single-use
`clientSecret`, and the relative offer URL `/plugins/openai/realtime/calls`.
The client posts an audio-only SDP offer and opens no provider data channel.
The Gateway attaches the provider's server sideband and owns tools or native
agent delegation, transcripts, steering, cancellation, and call cleanup while
media continues directly between the client and OpenAI. Negotiated sessions
share a two-session limit per client connection, including pending offers.
Unsupported combinations, including GA with OAuth only, fail visibly instead
of falling back to client-owned control. Existing browser clients omit this
capability and keep their data channel and client transcript reporting.

In Gateway-controlled native calls and native Gateway relays, the provider's
delegation starts each host action. Final speech transcripts are saved to history;
they neither trigger actions nor repeat a delegation's action. Status keeps the
current task running, cancellation stops it, and redirects or follow-ups target
that call's active work. When the call has no active task, status and cancellation
return a spoken no-active-run response, even if another call on the same connection
and agent session has work in progress. Ordinary requests such as “Check the
weather” still start tasks while idle. Genuine new tasks retain the native
delegation replacement behavior.

These calls disable provider-generated delegation acknowledgments at creation.
OpenClaw sends one neutral receipt when it launches a real task; status and
cancellation requests wait for the host result instead, without waiting for final
speech transcription. A full control queue produces a spoken refusal; retry after
the pending controls finish. A task receipt is not confirmation that a model or
tool has started, and submitting a spoken result is not proof of audible delivery.

Closing a native transport fences new delegations and late provider delivery;
already accepted agent work retains its own cancellation lifetime. Spoken run
cancellation is separate from ending the audio connection. Gateway-controlled
native sessions acknowledge cancellation without speaking the canceled task's
partial answer, empty-result fallback, or failed-task retry prompt. Timeouts
remain failures rather than being silently treated as cancellations.

Finalized realtime user and assistant utterances are always appended live to the active agent session, so later chat and voice turns share one history. Client-owned transports report their finalized transcripts with stable entry ids; Gateway relay and Gateway-controlled WebRTC sessions append the same events server-side. Provider sessions also receive the bounded realtime profile context used by Discord voice.

Gateway-controlled native WebRTC calls receive shared-session history as quoted
historical background in their instructions, not as the new call's own user or
assistant messages. This background can include prior calls and backing-agent
answers; it does not establish the current call's live task state. It retains
the newest history within 16 entries, 800 characters per entry, and 8,000 UTF-8
bytes including labels and quoting. This changes neither saved transcripts nor
chat display. Native calls without negotiated host input control and direct
WebSocket conversation seeds keep their existing representation.

Generated agent-consult prompts are internal input, not spoken user turns. New
consult records are hidden from chat and excluded from later model context, while
the active consult still receives the full question, context, and response style.
Raw archives and [session exports](/tools/slash-commands) remain lossless. Existing
consult records without the exclusion flag are not rewritten and remain eligible
for model context.

Chat-backed Talk stores the spoken answer without a second copy of the
successful consult answer in visible history; the internal answer remains in the
raw transcript and model context. Tool activity, progress, errors, and interrupted
replies retain their existing visibility.

Direct provider-owned consultations keep their own final answer visible in Chat.
Accepted work can outlive a closed or replaced audio connection, so a spoken
replacement is not guaranteed. If speech also arrives, both records may be visible;
OpenClaw preserves the answer rather than guessing that the spoken text replaces it.

OpenAI GA browser Talk keeps provider conversation order even when an assistant
reply finishes before the user's transcription or item announcements arrive out
of order. Text streams immediately in the call view; late predecessor metadata
places it beside the correct reply. Stopping a call drains finalized speech,
skips unfinished transcriptions, and records a browser console warning for
missing transcriptions or unresolved conversation links.

Google Live saves complete utterances during the call, including Gemini 3.1
transcriptions that omit an explicit transcription-finished flag. Partial text
stays provisional until the provider's completion boundary.

Voice-originated consult runs require a new, exact spoken confirmation before high-impact actions such as sending messages, controlling nodes, browser/computer actions, service changes, destructive shell commands, or publication. The gate applies to runs started through `talk.client.toolCall`, the Gateway relay, and GPT-Live sideband delegations. The confirmation applies only to the canonical final execution arguments and is consumed once; if a policy or hook rewrites the approved action, OpenClaw blocks it until the rewritten action is confirmed. Unrelated concurrent runs remain unaffected. When a call closes, OpenClaw can send a compact **Voice call changes** digest for mutating tools to the session's last non-WebChat delivery target.

Transcription-only Talk emits the same Talk event envelope as realtime and STT/TTS sessions, but uses `mode: "transcription"` and `brain: "none"`. All Talk sessions broadcast events on the `talk.event` channel; clients subscribe to it for partial/final transcript updates (`transcript.delta`/`transcript.done`) and other session telemetry.

Transcription providers can advertise their model choices in `talk.catalog.transcription.providers[].models`. Pass `model` to `talk.session.create` to override the configured transcription model for that session. Omitting it keeps the provider configuration, then the matching `agents.defaults.voiceModel`, then the provider's own default.

Browser Video Talk is available for OpenAI Realtime WebRTC and Google Live
provider-WebSocket sessions. OpenAI gets a single bounded JPEG when
`describe_view` asks for visual context; it does not receive a continuous
camera track. Google Live receives bounded JPEG frames directly from the
browser at up to one frame per second, while `describe_view` reports the
camera-stream state. In both cases, camera frames bypass the Gateway, and
stopping Talk releases the camera and microphone tracks.

Browser Talk shows startup progress while preparing the session, waiting for
microphone access, and connecting. Talk and dictation show microphone guidance
while the browser's capture request is pending: bring the tab to the foreground
and allow access if prompted. The browser can keep an unanswered permission
request pending. In Talk, **Stop voice input** cancels startup and releases any
microphone stream granted after cancellation.

Browser Talk acquires the microphone before creating the provider session, so
time spent granting permission does not consume a short-lived connection token.
If session creation fails, Talk releases the microphone before reporting the error.

If OpenAI cannot transcribe an utterance, browser Talk shows the provider's error
without ending the call or inventing a transcript. You can speak again; audio
responses continue independently of input transcription.

If the microphone disconnects or its permission is revoked, browser Talk ends
the call and shows an error. Choose an available **Microphone input**, restore
permission if needed, and start Talk again. An unexpected GPT-Live connection
loss also ends the call with an error; automatic reconnection is not supported.

## Session ownership

`talk.client.create` and realtime `talk.session.create` resolve their session before
loading profile context or starting a provider. An agent-prefixed `sessionKey`
selects that agent. Otherwise, Talk uses `talk.agentId`, then the configured system
agent or an unambiguous default agent. Without an owner in a multi-agent Gateway,
set `talk.agentId` or send an agent-prefixed key.

`talk.catalog` also requires an unambiguous Talk owner and checks it before
discovering providers, so missing ownership returns its setup error promptly.

Omitting `sessionKey` selects the same owned main session as a bare `main` key;
both enforce sharing, incognito, and operator-role restrictions. Main aliases
honor `session.scope` and the configured [main session](/concepts/main-session) key. A shared fixed store retains
its recorded owner for unqualified keys, and conflicting explicit ownership is rejected
even when a main alias becomes `global`. If routing or access changes during
startup, creation fails rather than switching sessions; retry the request.

Client tool calls, Gateway-owned provider consultations, and steering retain the prepared agent,
canonical session key, and store. Agent replies stay in the same session as voice
transcripts, including under global scope, while the original key continues to
identify the voice call. Provider-attached controls and `talk.session.steer` select
only work bound to that logical voice call. Reusing `voiceSessionId` to replace a
browser transport preserves control of its accepted work. The legacy
`talk.client.steer` RPC remains session-scoped: it selects owned work by
`sessionKey`, not by a voice call ID.

Native steering uses the current caller's tool policy and session permissions. The
host captures the actual backend attempt's authority after policy preparation and
checks that exact owner again before delivering a control. Changed caller authority, tool
allowlists, permission modes, or closed/replaced attempts can produce
`tool_authority_mismatch`; a run ID or copied fingerprint does not authorize steering.
Direct voice input does not acquire trace or client-tool capabilities. Chat-backed
Talk keeps the authenticated caller's normal chat authority, including its reviewer
and client capabilities, but disables task suggestions because Talk cannot accept
them. Status and cancellation do not require a tool-policy projection. Controls
capture their target before queue or transcript waits; they never move to a task
that starts later. A control received before backend registration returns a visible
no-active-run response rather than waiting for an unrelated future task.

When a source-bound native control is routed to a pending question, its answer
or image-triggered cancellation is checked again immediately before Gateway
dispatch, after registration, input persistence, and connection preparation.
Closing or reassigning the source before that check rejects the stale input
without cancelling the independent backing question or run; a later valid
answer can still use the same question. An answer already consumed by the
question remains accepted if the source closes while its response returns.
Delayed confirmation uses the question's existing deadline. If confirmation is
lost entirely, Talk reports that it could not confirm the input and does not send
it again as steering; check the conversation before retrying.
This applies to controls routed through pending-question input, not universal
interception of spoken answers by every voice provider.

Managed-room handoffs do not yet supply current-speaker tool authority. Room
attachment alone cannot authorize steering; status and cancellation remain available.

Keep the original `sessionKey` for client transcript, tool-call, and close requests.
`talk.client.close` requires both that exact key and the returned `voiceSessionId`;
an equivalent storage alias is not a replacement. A `talk.client.toolCall` acknowledgement
returns `agentId`, `agentSessionKey`, and `runId`; use that exact target for chat
cancellation, history, and completion events, including when the canonical key is `global`. Transcription-only sessions
without a key remain sessionless and do not select a default chat.

## Behavior (macOS)

- Always-on overlay while Talk mode is enabled.
- **Listening &rarr; Thinking &rarr; Speaking** phase transitions.
- Phase notifications are best-effort: a failed update does not start the local Gateway or restart its tunnel. Starting Talk retains normal connection recovery.
- On a short pause (silence window), the current transcript is sent.
- Replies are written to WebChat (same as typing).
- **Interrupt on speech** (default on): if the user talks while the assistant is speaking, playback stops and the interruption timestamp is noted for the next prompt.

## Realtime Talk over the Gateway relay (macOS)

macOS defaults to the native path above: Apple Speech recognition, Gateway chat, and `talk.speak`
playback. It switches to a streamed realtime session only when `talk.realtime` selects all three
of these together:

| Key         | Required value  |
| ----------- | --------------- |
| `mode`      | `realtime`      |
| `transport` | `gateway-relay` |
| `brain`     | `agent-consult` |

Any other combination — including a partially set one — keeps the native path.

```json5
{
  talk: {
    realtime: {
      provider: "openai",
      providers: {
        openai: {
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
        },
      },
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    },
  },
}
```

The Mac must also opt in locally with **Settings > Voice & Talk > Use realtime Gateway relay**.
This preference defaults off and stays on that Mac; Gateway config alone never activates the
streamed path. Keep `transport: "webrtc"` for browser or iOS client-owned sessions; macOS uses
the relay only when the config explicitly selects `gateway-relay`.

The Gateway must also advertise `gateway-relay` and `agent-consult` for the selected provider in
`talk.catalog`. Realtime requires macOS 26 or newer, matching Voice Wake; on older versions the
Talk and Voice Wake controls are unavailable.

On Apple clients, relay playback stays active until the device finishes the queued audio, not
until an estimated duration expires. Playback acknowledgments and microphone echo suppression
follow that completion; pause, barge-in, and cancellation can still stop playback earlier.

### When realtime cannot start

Talk never silently sits idle. If the relay fails to start — no Gateway route, rejected
credentials, or an unsupported model — the failure is logged, the overlay shows the reason, and
Talk falls back to the native speech path for that session.

Once a session is running, a dropped relay reconnects on a bounded retry schedule (roughly 0.5 s
then 2 s). If those attempts are exhausted, the overlay reports
`Realtime disconnected repeatedly — using native speech` and the next start bypasses realtime.
Losing the microphone mid-session closes the relay and takes the same route.

Relay output cancellation is turn-scoped. Clients copy the current `turnId` from the
`talk.event` audio envelope. Matching ids return `applied`, stale ids return `stale`, and
sessions without an active turn return `idle`. Older clients that omit `turnId` still cancel
the current turn:

```json
{
  "method": "talk.session.cancelOutput",
  "params": {
    "sessionId": "relay-session-id",
    "turnId": "turn-7",
    "reason": "barge-in"
  }
}
```

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
        // Fish S2 Pro can also use a local reference voice:
        // referenceAudioPath: "/Users/example/Voices/reference.wav",
        // referenceText: "Exact transcript of the reference clip.",
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

OpenAI browser WebRTC and Gateway-relay Talk support native GPT-Live. Select a
supported native model in **Settings → Talk**; the provider catalog supplies
the available model IDs. Browser and Gateway-relay WebRTC prefer a ChatGPT
OAuth subscription profile and fall back to Platform
API-key auth. OAuth creates the WebRTC call through the Codex backend using
JSON `sdp` and `session`; Platform keys use multipart call creation at
`https://api.openai.com/v1/live`. Both use a Gateway-owned public API sideband.
Other backend bridges connect directly over the Frameless Bidi
WebSocket and require Platform API-key auth, whose `/v1/live` access is currently
[waitlist-gated](https://openai.com/form/gpt-live-1-in-the-api/).

The quickest setup is the Control UI: **Settings → Talk**, pick **OpenAI** and
a `gpt-live-*` model. The OAuth prerequisite is an OpenClaw auth profile
created with `openclaw models auth login --provider openai` — an existing
Codex CLI sign-in is not read. GPT-Live also requires the bundled `openai`
plugin registered in full mode; a restrictive `plugins.allow` list fails
session creation with "OpenAI GPT-Live browser session broker is unavailable".
Runtime bounds: 8 concurrent sessions per Gateway and a 30-minute session TTL.
Browser sessions also use 60-second single-use offer tokens.

GPT-Live follows the Codex V3 voice contract: `arbor`, `breeze`, `cove`,
`ember`, `juniper`, `maple`, `sol`, `spruce`, and `vale`, with `cove` as the
default. GA Realtime has a separate voice set. A `403 Voice session access
denied` response does not identify the cause by itself; check the selected
account, model, and voice. ChatGPT OAuth with `spruce` has current speech
roundtrip verification; Platform GPT-Live verification requires API access.

| Consumer                    | GPT-Live status                                                         |
| --------------------------- | ----------------------------------------------------------------------- |
| Browser Talk                | Supported with client WebRTC and Gateway-owned sideband                 |
| Gateway-relay Talk          | Supported with Gateway-owned WebRTC and sideband                        |
| Discord bidirectional voice | Supported with the Platform-key backend WebSocket                       |
| Voice Call and telephony    | Supported with the Platform-key backend WebSocket                       |
| iOS client-owned Talk       | Implemented; GPT-Live device live verification pending                  |
| Android realtime Talk       | Pending an Android device live-proof flip; Android stays on native Talk |

These rows describe implemented transport paths, not account entitlement or a
successful live call on every device. iOS implements frameless transcripts and
the Gateway offer exchange; Android retains an explicit GPT-Live model gate.
For model capability limits, see [Discord voice policies](/channels/discord#voice-channels)
and [Voice Call tools](/plugins/voice-call#realtime-voice-conversations).

The Gateway-owned WebRTC route keeps OAuth and Platform credentials away from
relay clients. Backend WebSocket paths keep the Platform key on the Gateway;
OpenClaw converts telephony G.711 u-law audio to and from GPT-Live's 24 kHz PCM
contract.

For GA `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, and `gpt-realtime-2`
browser sessions, Platform credentials remain preferred in this order: the
configured realtime API key, an `openai` API-key profile, then
`OPENAI_API_KEY`. With none configured, browser Talk falls back to an OpenClaw
ChatGPT OAuth profile and exchanges SDP through the Gateway's single-use offer
broker, so the OAuth token never reaches the browser. A configured Platform
credential that cannot be resolved fails closed instead of silently falling
through to OAuth.

iOS client-owned WebRTC, Voice Call, GA Gateway relay, provider WebSocket
transports, Discord realtime voice, and Android realtime remain
Platform-key-only. GA browser Talk keeps the existing client-owned data channel
and `talk.client.toolCall` loop; only the credential owner and SDP exchange path
change under OAuth. GPT-Live Gateway relay prefers ChatGPT OAuth and falls back
to waitlist-enabled Platform access.

| Key                                      | Default                                    | Notes                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`                                | configured default agent                   | Owns Talk sessions created without an explicit agent-scoped session key.                                                                                                                                                                              |
| `provider`                               | -                                          | Active Talk TTS provider. Use `elevenlabs`, `mlx`, or `system` for macOS-local playback paths.                                                                                                                                                        |
| `providers.<id>.voiceId`                 | -                                          | ElevenLabs falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID`, or the first available voice with an API key.                                                                                                                                        |
| `speechLocale`                           | device default                             | BCP 47 locale for Android, iOS, and macOS native speech recognition, plus the iOS system-voice fallback. Apple Speech may use network services; Android also forwards the language component to realtime input transcription.                         |
| `providers.elevenlabs.modelId`           | `eleven_multilingual_v2`                   |                                                                                                                                                                                                                                                       |
| `providers.mlx.modelId`                  | `mlx-community/Soprano-80M-bf16`           |                                                                                                                                                                                                                                                       |
| `providers.mlx.referenceAudioPath`       | -                                          | Optional client-local reference recording for MLX models that support voice cloning. The path is resolved on the native macOS app host.                                                                                                               |
| `providers.mlx.referenceText`            | -                                          | Exact transcript of `referenceAudioPath`; Fish S2 Pro uses both values for local voice cloning.                                                                                                                                                       |
| `providers.elevenlabs.apiKey`            | -                                          | Falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available).                                                                                                                                                                           |
| `silenceTimeoutMs`                       | `700` ms macOS/Android, `900` ms iOS       | Pause window before Talk sends the transcript.                                                                                                                                                                                                        |
| `interruptOnSpeech`                      | `true`                                     |                                                                                                                                                                                                                                                       |
| `providers.<id>.outputFormat`            | `pcm_44100` macOS/iOS, `pcm_24000` Android | Set `mp3_*` to force MP3 streaming.                                                                                                                                                                                                                   |
| `consultThinkingLevel`                   | unset                                      | Thinking level override for the agent run behind realtime `openclaw_agent_consult` calls.                                                                                                                                                             |
| `consultFastMode`                        | unset                                      | Fast-mode override for realtime `openclaw_agent_consult` calls.                                                                                                                                                                                       |
| `realtime.provider`                      | -                                          | `openai` for WebRTC, `google` for provider WebSocket, or a bridge-only provider through Gateway relay.                                                                                                                                                |
| `realtime.providers.<id>`                | -                                          | Provider-owned realtime config. Browsers receive only ephemeral/constrained session credentials, never a standard API key.                                                                                                                            |
| `realtime.providers.openai.speakerVoice` | `alloy` for GA; `cove` for GPT-Live        | Built-in OpenAI realtime voice id (the older `voice` key still works but is deprecated). GA voices: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `marin`, `sage`, `shimmer`, `verse`. GPT-Live uses the separate Codex V3 voices listed above. |
| `realtime.model`                         | provider default                           | Realtime voice model. Overrides `realtime.providers.<id>.model` when both are set — the same precedence `talk.client.create` applies at session time.                                                                                                 |
| `realtime.transport`                     | -                                          | `webrtc`: client-owned OpenAI WebRTC on iOS and in the browser. `provider-websocket`: browser-owned, stays on Gateway relay on iOS. `gateway-relay`: keeps provider audio on the Gateway; Android uses realtime only with this transport.             |
| `realtime.brain`                         | -                                          | `agent-consult` routes realtime tool calls through Gateway policy; `direct-tools` is legacy direct-tool compatibility; `none` is for transcription/external orchestration.                                                                            |
| `realtime.consultRouting`                | -                                          | `provider-direct` preserves the provider's direct reply when it skips `openclaw_agent_consult`; `force-agent-consult` routes finalized user transcripts through OpenClaw instead.                                                                     |
| `realtime.instructions`                  | -                                          | Appends provider-facing system instructions to OpenClaw's built-in realtime prompt.                                                                                                                                                                   |

`talk.catalog` exposes canonical provider ids and registry aliases, each provider's valid modes/transports/brain strategies/realtime audio formats/capability flags, and the runtime-selected readiness result. First-party Talk clients should read that catalog instead of maintaining provider aliases locally; treat an older Gateway that omits group readiness as unverified rather than definitively unconfigured. Streaming transcription providers are discovered through `talk.catalog.transcription`; the current Gateway relay uses the Voice Call streaming provider config until a dedicated Talk transcription config surface ships.

## macOS UI

- Menu bar: **Voice & Talk Settings…** opens the native **Voice & Talk** settings page.
- Native settings: **Use realtime Gateway relay** is a local, default-off opt-in for this Mac.
- **Open in Dashboard** hands provider, model, voice, and transport setup to Control UI **Settings → Talk** under **Connections**.
- Menu bar: **Talk Mode** starts or stops the current Talk session.
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
- Realtime Talk requests Android communication mode and audio focus, using a
  connected external output or the built-in speaker. Microphone audio is sent
  during playback only while acoustic echo cancellation is enabled and the
  communication mode and focus remain active. Without echo cancellation,
  microphone audio is not sent during playback. Android presentation timestamps
  estimate playback completion when available. Routes without usable timestamps use
  approximate playback position plus the nominal PCM duration; this cannot
  guarantee that all acoustic output has drained on every device.
- Losing audio focus or encountering a playback-device failure ends realtime
  Talk with an error. Interruption clears queued output before capture resumes;
  stopped sessions cannot acknowledge playback through a replacement Gateway.
- Realtime **Thinking** follows provider response generation or an accepted
  OpenClaw consult, not input transcription, which may finish after the answer.
  Direct replies without a provider or Gateway response-start signal stay
  **Listening** until output arrives. Empty completed responses return to **Listening**;
  buffered audio stays **Speaking** until playback drains.
- Dictation and voice-note recording stop when the app leaves the foreground or
  the user leaves Chat.
- Talk Mode keeps running until toggled off or the node disconnects, using Android's microphone foreground-service type while active.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency `AudioTrack` streaming.

## Notes

- Requires Speech + Microphone permissions.
- Native Talk uses the active Gateway session and only falls back to history polling when response events are unavailable.
- The gateway resolves Talk playback through `talk.speak` using the active Talk provider. Android falls back to local system TTS only when that RPC is unavailable.
- macOS local MLX playback uses the bundled `openclaw-mlx-tts` helper when present, or an executable on `PATH`. Set `OPENCLAW_MLX_TTS_BIN` to point at a custom helper binary during development. The helper streams PCM, keeps one selected model resident, and supports Fish S2 Pro reference audio through `providers.mlx.referenceAudioPath` plus `referenceText`.
- Voice directive value ranges (ElevenLabs): `stability`, `similarity`, and `style` accept `0..1`; `speed` accepts `0.5..2`; `latency_tier` accepts `0..4`.

## Related

- [Voice wake](/nodes/voicewake)
- [Audio and voice notes](/nodes/audio)
- [Media understanding](/nodes/media-understanding)
