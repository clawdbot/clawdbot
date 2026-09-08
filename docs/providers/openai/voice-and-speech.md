---
summary: "OpenAI text-to-speech, transcription, and realtime voice settings and auth"
read_when:
  - You are configuring OpenAI text-to-speech or transcription
  - You are setting up realtime voice for Talk, Voice Call, or Discord
  - You need the auth order for a specific realtime route
title: "OpenAI voice and speech"
sidebarTitle: "Voice and speech"
---

## Voice and speech

<AccordionGroup>
  <Accordion title="Speech synthesis (TTS)">
    The bundled `openai` plugin registers speech synthesis for the
    `tts` surface.

    | Setting      | Config path                                            | Default                          |
    | ------------- | --------------------------------------------------------- | ----------------------------------- |
    | Model        | `tts.providers.openai.model`                  | `gpt-4o-mini-tts`                |
    | Voice        | `tts.providers.openai.speakerVoice`           | `coral`                          |
    | Speed        | `tts.providers.openai.speed`                  | (unset)                          |
    | Instructions | `tts.providers.openai.instructions`           | (unset, `gpt-4o-mini-tts` family only)  |
    | Format       | `tts.providers.openai.responseFormat`         | `opus` for voice notes, `mp3` for files |
    | API key      | `tts.providers.openai.apiKey`                 | Falls back to `OPENAI_API_KEY`   |
    | Base URL     | `tts.providers.openai.baseUrl`                | `https://api.openai.com/v1`      |
    | Extra body   | `tts.providers.openai.extraBody` / `extra_body` | (unset)                        |

    Available models: `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`, `tts-1`,
    `tts-1-hd`. Available voices: `alloy`, `ash`, `ballad`, `cedar`, `coral`,
    `echo`, `fable`, `juniper`, `marin`, `onyx`, `nova`, `sage`, `shimmer`,
    `verse`.

    `extraBody` is merged into `/audio/speech` request JSON after OpenClaw's
    generated fields, so use it for OpenAI-compatible endpoints that require
    additional keys such as `lang`. Prototype keys are ignored.

    ```json5
    {
      tts: {
        providers: {
          openai: { model: "gpt-4o-mini-tts", speakerVoice: "coral" },
        },
      },
    }
    ```

    <Note>
    Set `OPENAI_TTS_BASE_URL` to override the TTS base URL without affecting
    the chat API endpoint. OpenAI TTS requires an OpenAI Platform API key.
    OAuth-only installs can use Codex-backed chat models and GA Realtime browser
    Talk over a ChatGPT subscription when the account has access (see the
    Realtime accordion).
    OpenAI TTS, Voice Call, GA Gateway relay, and Discord realtime voice still
    require a Platform API key.
    </Note>

  </Accordion>

  <Accordion title="Speech-to-text">
    The bundled `openai` plugin registers batch speech-to-text through
    OpenClaw's media-understanding transcription surface.

    Batch transcription can use the selected OpenAI API-key or ChatGPT OAuth
    profile on the standard transcription endpoint when the account permits it.
    Configured models, prompts, and language hints work through the same request
    path. Access and quota errors are reported without switching credential
    classes; OAuth support does not imply included or unlimited transcription.
    Custom endpoints and request overrides require an API-key profile.
    See [Audio and voice notes](/nodes/audio#openai-transcription-alongside-chatgpt%2Fcodex-oauth)
    for selecting a separate audio API-key profile when desired.

    - Default model: `gpt-4o-transcribe`
    - Endpoint: OpenAI REST `/v1/audio/transcriptions`
    - Input path: multipart audio file upload
    - Used wherever inbound audio transcription reads `tools.media.audio`,
      including Discord voice-channel segments and channel audio attachments

    To force OpenAI for inbound audio transcription:

    ```json5
    {
      tools: {
        media: {
          models: [
            {
              type: "provider",
              provider: "openai",
              model: "gpt-4o-transcribe",
              capabilities: ["audio"],
            },
          ],
          audio: {
            enabled: true,
          },
        },
      },
    }
    ```

    Language and prompt hints are forwarded to OpenAI when supplied by the
    shared audio media config or per-call transcription request.

  </Accordion>

  <Accordion title="Realtime transcription">
    The bundled `openai` plugin registers realtime transcription for the
    Voice Call plugin.

    | Setting          | Config path                                                          | Default |
    | ----------------- | ----------------------------------------------------------------------- | --------- |
    | Model            | `plugins.entries.voice-call.config.streaming.providers.openai.model` | `gpt-4o-transcribe` |
    | Language         | `...openai.language`                                                 | (unset) |
    | Prompt           | `...openai.prompt`                                                   | (unset) |
    | Silence duration | `...openai.silenceDurationMs`                                        | `800`   |
    | VAD threshold    | `...openai.vadThreshold`                                             | `0.5`   |
    | Auth             | `...openai.apiKey`, `OPENAI_API_KEY`, or `openai` API-key profile    | Platform API key required |

    <Note>
    Uses a WebSocket connection to `wss://api.openai.com/v1/realtime` with
    G.711 u-law (`g711_ulaw` / `audio/pcmu`) audio. For an `openai` API-key
    profile, the Gateway mints an ephemeral Realtime transcription client
    secret before opening the WebSocket. This streaming provider is for Voice
    Call's realtime transcription path; Discord voice currently records short
    segments and uses the batch `tools.media.audio` transcription path
    instead.
    </Note>

  </Accordion>

  <Accordion title="Realtime voice">
    The bundled `openai` plugin registers realtime voice for the Voice Call
    plugin.

    | Setting                               | Config path                                                              | Default             |
    | --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
    | Model                                  | `plugins.entries.voice-call.config.realtime.providers.openai.model`     | `gpt-realtime-2.1`  |
    | Voice                                  | `...openai.voice`                                                       | `alloy`             |
    | Temperature (Azure deployment bridge)  | `...openai.temperature`                                                 | `0.8`               |
    | VAD threshold                          | `...openai.vadThreshold`                                                | `0.5`                |
    | Silence duration                       | `...openai.silenceDurationMs`                                           | `500`                |
    | Prefix padding                         | `...openai.prefixPaddingMs`                                             | `300`                |
    | Reasoning effort                       | `...openai.reasoningEffort`                                             | (unset)              |
    | Auth                                   | `openai` auth profile, `...openai.apiKey`, or `OPENAI_API_KEY` | Released GPT-Live: OAuth first; ordinary GA browser: Platform first; Platform required for other routes |

    Available built-in Realtime voices for `gpt-realtime-2.1`: `alloy`, `ash`,
    `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.
    OpenAI recommends `marin` and `cedar` for the best Realtime quality. This
    is a separate set from the Text-to-speech voices above; a TTS-only voice
    such as `fable`, `nova`, or `onyx` is not valid for Realtime sessions.
    Set the model explicitly to `gpt-realtime-2.1-mini` when you prefer the
    smaller, lower-cost Realtime 2.1 variant.

    #### Gateway-controlled Realtime call cleanup

    Closing a Gateway-controlled GA Realtime WebRTC session retires its Gateway
    authority and closes the local sideband before asking OpenAI to hang up the
    provider call. These are separate events; control closure does not establish
    provider acknowledgment or recall already queued media.

    If hangup fails, explicit cancellation or cleanup reports the failure. The
    broker retries automatically after 1 second, then 5 seconds, with the existing
    30-second timeout for each attempt. After all three attempts fail, the log
    reports `cleanup INCOMPLETE`. The exact cleanup obligation and its capacity
    remain reserved, including across plugin replacement: eight sessions globally
    and two per Gateway client. Restore provider connectivity; a later OpenAI
    broker/plugin runtime cleanup can retry these retained calls. Repeating End
    or `talk.client.close` is not that retry boundary because the Gateway session
    may already be retired.

    Cleanup obligations are in memory only. Gateway exit, crash, or restart can
    lose them; restarting is not proof that the provider call ended. The
    adapter's 30-minute active-session lease is not a remote-lifetime guarantee
    or a fallback after failed hangup.

    #### GA Realtime browser authentication

    Ordinary GA browser Talk tries Platform auth first in this order: the
    configured realtime key, an `openai` API-key profile, then `OPENAI_API_KEY`.
    When a Platform credential is available, the Gateway mints an ephemeral
    client secret and the browser performs the SDP exchange directly.

    When no Platform credential source is configured, ordinary GA browser Talk
    falls back to the OpenClaw ChatGPT OAuth subscription profile. The
    single-use Gateway offer broker keeps OAuth server-side, exchanges the
    browser's SDP, and returns only the answer SDP. An explicitly configured but
    unavailable Platform credential fails instead of falling back to OAuth.

    Gateway-controlled GA relay, iOS client-owned WebRTC, Voice Call, direct
    backend sockets, and Discord realtime voice require Platform auth.

    #### Released GPT-Live browser and Gateway relay authentication

    Released GPT-Live browser and Gateway-relay WebRTC try the OpenClaw ChatGPT
    OAuth subscription profile first. When OAuth is unavailable, the Gateway
    falls back to Platform auth in this order: the configured realtime key, an
    `openai` API-key profile, then `OPENAI_API_KEY`. Create the OAuth profile
    with `openclaw models auth login --provider openai`.

    Both credential types stay in the Gateway. The single-use offer broker
    exchanges the browser's SDP and returns only the answer SDP; it does not
    send an OAuth token, Platform key, or ephemeral client secret to the browser.

    Gateway-relay WebRTC calls conceal malformed incoming audio packets and
    continue playing later audio. One rejected audio packet send does not end
    an otherwise connected call. Unusable codec state, unexpected stream changes,
    and terminal connection states still end the call. Packet-drop diagnostics
    omit raw error details.

    The enabled OpenAI plugin starts the broker automatically, including when
    you sign in after the Gateway has started. The broker opens a provider
    session only when you start Talk; signing in does not open the microphone or
    start a voice session. Returning to the browser after sign-in refreshes the
    chat microphone's readiness.

    #### Unlisted and private realtime transport paths

    Unlisted or private browser Talk uses Platform-key client WebRTC with
    Gateway-owned control. Gateway relay and other direct backend consumers use
    the Platform-key bidirectional transport. Credentials and provider control
    remain on the Gateway.

    Use the account-issued realtime model value. Unlisted model values are
    accepted as free-form Talk config but are not published through catalogs
    or diagnostics. Opt in explicitly with `talk.realtime.model`; the released
    model remains the default.

    Current Platform-key sessions accept `marin` and `cedar`. OpenClaw defaults
    to `marin` and maps unsupported configured voices back to it.

    Unlisted or private browser WebRTC prerequisites, in order:

    1. A Platform API key configured through `talk.realtime.providers.openai.apiKey`,
       an `openai` API-key profile, or `OPENAI_API_KEY`.
    2. `talk.realtime.model` set to the account-issued value — via **Settings →
       Talk** in the Control UI or the config below.
    3. The bundled `openai` plugin registered in full mode. A restrictive
       `plugins.allow` list fails with "OpenAI realtime browser session broker
       is unavailable".

    ```json5
    {
      talk: {
        realtime: {
          provider: "openai",
          model: "<account-issued-realtime-model>",
          transport: "webrtc",
        },
      },
    }
    ```

    Gateway relay uses the direct bidirectional transport:

    ```json5
    {
      talk: {
        realtime: {
          provider: "openai",
          model: "<account-issued-realtime-model>",
          transport: "gateway-relay",
        },
      },
    }
    ```

    Browser Talk uses `transport: "webrtc"`.

    | Consumer | Unlisted/private route status |
    | --- | --- |
    | Browser Talk | Supported with Platform-key client WebRTC and Gateway-owned sideband |
    | Gateway-relay Talk | Supported with direct Platform-key transport |
    | Discord bidirectional voice | Supported with the Platform-key backend WebSocket |
    | Voice Call and telephony | Supported with the Platform-key backend WebSocket |
    | iOS client-owned Talk | Implemented; device live verification pending |
    | Android realtime Talk | Pending an Android device live-proof flip; Android stays on native Talk |

    These rows describe implemented transports, not account entitlement or
    complete model capability parity. See the [Discord voice policy limits](/channels/discord#voice-channels)
    and [Voice Call tool limits](/plugins/voice-call#realtime-voice-conversations) before
    selecting an unlisted or private route for those consumers.

    <Warning>
    Unlisted or private routes require a Platform API key with access to the
    configured account-issued model. OAuth is not a fallback for them. If
    session creation is rejected, verify that the key and configured model
    belong to the same Platform project.
    </Warning>

    A `403 Voice session access denied` response is overloaded and does not by
    itself prove an account entitlement problem: an invalid voice produces the
    same response. First verify the model and voice against the accepted lists
    above, then verify the Platform key and configured model against the same
    project.

    The released Gateway-owned WebRTC route uses OAuth first with Platform
    fallback, routes sideband delegations through the configured OpenClaw
    agent, and keeps credentials away from relay clients. Unlisted or private
    browser WebRTC and the direct backend socket remain Platform-only. The
    direct socket enables Discord voice and Voice Call/telephony; OpenClaw
    converts G.711 u-law telephony audio to and from the provider's 24 kHz PCM
    stream. Android's client-side gate stays closed until the Gateway relay
    path has live proof from an Android device.

    The WebRTC path creates a provider call and joins its sideband. The direct
    backend path opens one bidirectional session, sends a Frameless
    `session.update`, then carries PCM audio, transcripts, delegations, and
    delegation results over that socket.

    Maintainers can exercise the Platform direct path and the separate GA
    browser OAuth path with the opt-in live tests. The account-issued realtime
    model is read from `talk.realtime.model`; missing credentials or model config
    produce sanitized skips, and the tests never print either value:

    ```bash
    OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_GPT_LIVE=1 node --import tsx scripts/test-live.mts -- extensions/openai/realtime-quicksilver.live.test.ts
    OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_GPT_LIVE=1 node --import tsx scripts/test-live.mts -- extensions/openai/realtime-quicksilver-gateway-bridge.live.test.ts
    ```

    <Note>
    GA backend OpenAI realtime bridges use the Realtime WebSocket session
    shape, which does not accept `session.temperature`; GPT-Live uses the
    separate Frameless Bidi shape. Azure OpenAI
    deployments remain available via `azureEndpoint` and `azureDeployment` and
    keep the deployment-compatible session shape (including `temperature`).
    Supports bidirectional tool calling and G.711 u-law audio.
    </Note>

    <Note>
    Realtime voice is selected when the session is created. OpenAI allows most
    session fields to change later, but the voice cannot be changed after the
    model has emitted audio in that session. OpenClaw currently exposes the
    built-in Realtime voice ids as strings.
    </Note>

    <Note>
    Control UI Talk uses browser WebRTC sessions. The released
    browser/Gateway-owned route tries ChatGPT OAuth first through the Gateway
    offer broker, keeping OAuth server-side. When OAuth is unavailable, it
    falls back to Platform credentials in this order: configured realtime key,
    API-key profile, then `OPENAI_API_KEY`. Direct backend sockets and unlisted
    or private realtime routes require Platform credentials.
    Maintainer live verification is available with
    `OPENAI_API_KEY=... GEMINI_API_KEY=... node --import tsx scripts/dev/realtime-talk-live-smoke.ts`;
    the OpenAI legs verify the backend WebSocket bridge, a synthesized PCM24
    speech-to-response audio roundtrip, and the browser WebRTC SDP exchange
    without logging secrets. Pass `--openai-only` to run those legs without
    Google credentials. Use `--openai-audio-cycles 3` for a short repeated
    connect, talkback, and close soak.
    </Note>

  </Accordion>
</AccordionGroup>
