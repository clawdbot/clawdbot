---
summary: "Voice Call plugin: outbound + inbound calls via Twilio/Telnyx/Plivo (plugin install + config + CLI)"
read_when:
  - You want to place an outbound voice call from OpenClaw
  - You are configuring or developing the voice-call plugin
title: "Voice call plugin"
---

Voice calls for OpenClaw via a plugin. Supports outbound notifications and
multi-turn conversations with inbound policies.

Current providers:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/no network)

Quick mental model:

- Install plugin
- Restart Gateway
- Configure under `plugins.entries.voice-call.config`
- Use `openclaw voicecall ...` or the `voice_call` tool

## Where it runs (local vs remote)

The Voice Call plugin runs **inside the Gateway process**.

If you use a remote Gateway, install/configure the plugin on the **machine running the Gateway**, then restart the Gateway to load it.

## Install

### Option A: install from npm (recommended)

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

### Option B: install from a local folder (dev, no copying)

```bash
PLUGIN_SRC=./path/to/local/voice-call-plugin
openclaw plugins install "$PLUGIN_SRC"
cd "$PLUGIN_SRC" && pnpm install
```

Restart the Gateway afterwards.

## Config

Set config under `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234", // or TWILIO_FROM_NUMBER for Twilio
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx webhook public key from the Telnyx Mission Control Portal
            // (Base64 string; can also be set via TELNYX_PUBLIC_KEY).
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            provider: "openai", // optional; first registered realtime transcription provider when unset
            streamPath: "/voice/stream",
            providers: {
              openai: {
                apiKey: "sk-...", // optional if OPENAI_API_KEY is set
                model: "gpt-4o-transcribe",
                silenceDurationMs: 800,
                vadThreshold: 0.5,
              },
            },
            preStartTimeoutMs: 5000,
            maxPendingConnections: 32,
            maxPendingConnectionsPerIp: 4,
            maxConnections: 128,
          },

          realtime: {
            enabled: false,
            provider: "google", // optional; first registered realtime voice provider when unset
            toolPolicy: "safe-read-only",
            providers: {
              google: {
                model: "gemini-2.5-flash-native-audio-preview-12-2025",
                voice: "Kore",
              },
            },
          },
        },
      },
    },
  },
}
```

Check setup before testing with a real provider:

```bash
openclaw voicecall setup
```

The default output is readable in chat logs and terminal sessions. It checks
whether the plugin is enabled, the provider and credentials are present, webhook
exposure is configured, and only one audio mode is active. Use
`openclaw voicecall setup --json` for scripts.

For Twilio, Telnyx, and Plivo, setup must resolve to a public webhook URL. If the
configured `publicUrl`, tunnel URL, Tailscale URL, or serve fallback resolves to
loopback or private network space, setup fails instead of starting a provider
that cannot receive real carrier webhooks.

For a no-surprises smoke test, run:

```bash
openclaw voicecall smoke
openclaw voicecall smoke --to "+15555550123"
```

The second command is still a dry run. Add `--yes` to place a short outbound
notify call:

```bash
openclaw voicecall smoke --to "+15555550123" --yes
```

Notes:

- Twilio/Telnyx require a **publicly reachable** webhook URL.
- Plivo requires a **publicly reachable** webhook URL.
- `mock` is a local dev provider (no network calls).
- If older configs still use `provider: "log"`, `twilio.from`, or legacy `streaming.*` OpenAI keys, run `openclaw doctor --fix` to rewrite them.
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- `skipSignatureVerification` is for local testing only.
- If you use ngrok free tier, set `publicUrl` to the exact ngrok URL; signature verification is always enforced.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Use for local dev only.
- Ngrok free tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures will fail. For production, prefer a stable domain or Tailscale funnel.
- `realtime.enabled` starts full voice-to-voice conversations; do not enable it together with `streaming.enabled`.
- Streaming security defaults:
  - `streaming.preStartTimeoutMs` closes sockets that never send a valid `start` frame.
- `streaming.maxPendingConnections` caps total unauthenticated pre-start sockets.
- `streaming.maxPendingConnectionsPerIp` caps unauthenticated pre-start sockets per source IP.
- `streaming.maxConnections` caps total open media stream sockets (pending + active).
- Runtime fallback still accepts those old voice-call keys for now, but the rewrite path is `openclaw doctor --fix` and the compat shim is temporary.

## Realtime voice conversations

`realtime` selects a full duplex realtime voice provider for live call audio.
It is separate from `streaming`, which only forwards audio to realtime
transcription providers.

Current runtime behavior:

- `realtime.enabled` is supported for Twilio Media Streams.
- `realtime.enabled` cannot be combined with `streaming.enabled`.
- `realtime.provider` is optional. If unset, Voice Call uses the first
  registered realtime voice provider.
- Bundled realtime voice providers include Google Gemini Live (`google`) and
  OpenAI (`openai`), registered by their provider plugins.
- Provider-owned raw config lives under `realtime.providers.<providerId>`.
- Voice Call exposes the shared `openclaw_agent_consult` realtime tool by
  default. The realtime model can call it when the caller asks for deeper
  reasoning, current information, or normal OpenClaw tools.
- `realtime.toolPolicy` controls the consult run:
  - `safe-read-only`: expose the consult tool and limit the regular agent to
    `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, and
    `memory_get`.
  - `owner`: expose the consult tool and let the regular agent use the normal
    agent tool policy.
  - `none`: do not expose the consult tool. Custom `realtime.tools` are still
    passed through to the realtime provider.
- Consult session keys reuse the existing voice session when available, then
  fall back to the caller/callee phone number so follow-up consult calls keep
  context during the call.
- If `realtime.provider` points at an unregistered provider, or no realtime
  voice provider is registered at all, Voice Call logs a warning and skips
  realtime media instead of failing the whole plugin.

Google Gemini Live realtime defaults:

- API key: `realtime.providers.google.apiKey`, `GEMINI_API_KEY`, or
  `GOOGLE_GENERATIVE_AI_API_KEY`
- model: `gemini-2.5-flash-native-audio-preview-12-2025`
- voice: `Kore`

Example:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          provider: "twilio",
          inboundPolicy: "allowlist",
          allowFrom: ["+15550005678"],
          realtime: {
            enabled: true,
            provider: "google",
            instructions: "Speak briefly. Call openclaw_agent_consult before using deeper tools.",
            toolPolicy: "safe-read-only",
            providers: {
              google: {
                apiKey: "${GEMINI_API_KEY}",
                model: "gemini-2.5-flash-native-audio-preview-12-2025",
                voice: "Kore",
              },
            },
          },
        },
      },
    },
  },
}
```

Use OpenAI instead:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          realtime: {
            enabled: true,
            provider: "openai",
            providers: {
              openai: {
                apiKey: "${OPENAI_API_KEY}",
              },
            },
          },
        },
      },
    },
  },
}
```

See [Google provider](/providers/google) and [OpenAI provider](/providers/openai)
for provider-specific realtime voice options.

## Streaming transcription

`streaming` selects a realtime transcription provider for live call audio.

Current runtime behavior:

- `streaming.provider` is optional. If unset, Voice Call uses the first
  registered realtime transcription provider.
- Bundled realtime transcription providers include Deepgram (`deepgram`),
  ElevenLabs (`elevenlabs`), Mistral (`mistral`), OpenAI (`openai`), and xAI
  (`xai`), registered by their provider plugins.
- Provider-owned raw config lives under `streaming.providers.<providerId>`.
- If `streaming.provider` points at an unregistered provider, or no realtime
  transcription provider is registered at all, Voice Call logs a warning and
  skips media streaming instead of failing the whole plugin.

OpenAI streaming transcription defaults:

- API key: `streaming.providers.openai.apiKey` or `OPENAI_API_KEY`
- model: `gpt-4o-transcribe`
- `silenceDurationMs`: `800`
- `vadThreshold`: `0.5`

xAI streaming transcription defaults:

- API key: `streaming.providers.xai.apiKey` or `XAI_API_KEY`
- endpoint: `wss://api.x.ai/v1/stt`
- `encoding`: `mulaw`
- `sampleRate`: `8000`
- `endpointingMs`: `800`
- `interimResults`: `true`

Example:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "openai",
            streamPath: "/voice/stream",
            providers: {
              openai: {
                apiKey: "sk-...", // optional if OPENAI_API_KEY is set
                model: "gpt-4o-transcribe",
                silenceDurationMs: 800,
                vadThreshold: 0.5,
              },
            },
          },
        },
      },
    },
  },
}
```

Use xAI instead:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "xai",
            streamPath: "/voice/stream",
            providers: {
              xai: {
                apiKey: "${XAI_API_KEY}", // optional if XAI_API_KEY is set
                endpointingMs: 800,
                language: "en",
              },
            },
          },
        },
      },
    },
  },
}
```

Legacy keys are still auto-migrated by `openclaw doctor --fix`:

- `streaming.sttProvider` → `streaming.provider`
- `streaming.openaiApiKey` → `streaming.providers.openai.apiKey`
- `streaming.sttModel` → `streaming.providers.openai.model`
- `streaming.silenceDurationMs` → `streaming.providers.openai.silenceDurationMs`
- `streaming.vadThreshold` → `streaming.providers.openai.vadThreshold`

## Stale call reaper

Use `staleCallReaperSeconds` to end calls that never receive a terminal webhook
(for example, notify-mode calls that never complete). The default is `0`
(disabled).

Recommended ranges:

- **Production:** `120`–`300` seconds for notify-style flows.
- Keep this value **higher than `maxDurationSeconds`** so normal calls can
  finish. A good starting point is `maxDurationSeconds + 30–60` seconds.

Example:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          maxDurationSeconds: 300,
          staleCallReaperSeconds: 360,
        },
      },
    },
  },
}
```

## Webhook Security

When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs the
public URL for signature verification. These options control which forwarded
headers are trusted.

`webhookSecurity.allowedHosts` allowlists hosts from forwarding headers.

`webhookSecurity.trustForwardingHeaders` trusts forwarded headers without an allowlist.

`webhookSecurity.trustedProxyIPs` only trusts forwarded headers when the request
remote IP matches the list.

Webhook replay protection is enabled for Twilio and Plivo. Replayed valid webhook
requests are acknowledged but skipped for side effects.

Twilio conversation turns include a per-turn token in `<Gather>` callbacks, so
stale/replayed speech callbacks cannot satisfy a newer pending transcript turn.

Unauthenticated webhook requests are rejected before body reads when the
provider's required signature headers are missing.

The voice-call webhook uses the shared pre-auth body profile (64 KB / 5 seconds)
plus a per-IP in-flight cap before signature verification.

Example with a stable public host:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## TTS for calls

Voice Call uses the core `messages.tts` configuration for
streaming speech on calls. You can override it under the plugin config with the
**same shape** — it deep‑merges with `messages.tts`.

```json5
{
  tts: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
    },
  },
}
```

Notes:

- Legacy `tts.<provider>` keys inside plugin config (`openai`, `elevenlabs`, `microsoft`, `edge`) are repaired by `openclaw doctor --fix`; committed config should use `tts.providers.<provider>`.
- **Microsoft speech is ignored for voice calls** (telephony audio needs PCM; the current Microsoft transport does not expose telephony PCM output).
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider native voices.
- If a Twilio media stream is already active, Voice Call does not fall back to TwiML `<Say>`. If telephony TTS is unavailable in that state, the playback request fails instead of mixing two playback paths.
- When telephony TTS falls back to a secondary provider, Voice Call logs a warning with the provider chain (`from`, `to`, `attempts`) for debugging.
- When Twilio barge-in or stream teardown clears the pending TTS queue, queued
  playback requests settle instead of hanging callers that are awaiting playback
  completion.

### More examples

Use core TTS only (no override):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      providers: {
        openai: { voice: "alloy" },
      },
    },
  },
}
```

Override to ElevenLabs just for calls (keep core default elsewhere):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                apiKey: "elevenlabs_key",
                voiceId: "pMsXgVXv3BLzUgSXRplE",
                modelId: "eleven_multilingual_v2",
              },
            },
          },
        },
      },
    },
  },
}
```

Override only the OpenAI model for calls (deep‑merge example):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            providers: {
              openai: {
                model: "gpt-4o-mini-tts",
                voice: "marin",
              },
            },
          },
        },
      },
    },
  },
}
```

## Inbound calls

Inbound policy defaults to `disabled`. To enable inbound calls, set:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

`inboundPolicy: "allowlist"` is a low-assurance caller-ID screen. The plugin
normalizes the provider-supplied `From` value and compares it to `allowFrom`.
Webhook verification authenticates provider delivery and payload integrity, but
it does not prove PSTN/VoIP caller-number ownership. Treat `allowFrom` as
caller-ID filtering, not strong caller identity.

Auto-responses use the agent system. Tune with:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

### Spoken output contract

For auto-responses, Voice Call appends a strict spoken-output contract to the system prompt:

- `{"spoken":"..."}`

Voice Call then extracts speech text defensively:

- Ignores payloads marked as reasoning/error content.
- Parses direct JSON, fenced JSON, or inline `"spoken"` keys.
- Falls back to plain text and removes likely planning/meta lead-in paragraphs.

This keeps spoken playback focused on caller-facing text and avoids leaking planning text into audio.

### Conversation startup behavior

For outbound `conversation` calls, first-message handling is tied to live playback state:

- Barge-in queue clear and auto-response are suppressed only while the initial greeting is actively speaking.
- If initial playback fails, the call returns to `listening` and the initial message remains queued for retry.
- Initial playback for Twilio streaming starts on stream connect without extra delay.
- Barge-in aborts active playback and clears queued-but-not-yet-playing Twilio
  TTS entries. Cleared entries resolve as skipped, so follow-up response logic
  can continue without waiting on audio that will never play.
- Realtime voice conversations use the realtime stream's own opening turn. Voice Call does not post a legacy `<Say>` TwiML update for that initial message, so outbound `<Connect><Stream>` sessions stay attached.

### Twilio stream disconnect grace

When a Twilio media stream disconnects, Voice Call waits `2000ms` before auto-ending the call:

- If the stream reconnects during that window, auto-end is canceled.
- If no stream is re-registered after the grace period, the call is ended to prevent stuck active calls.

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall start --to "+15555550123"   # alias for call
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall dtmf --call-id <id> --digits "ww123456#"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall latency                     # summarize turn latency from logs
openclaw voicecall expose --mode funnel
```

`latency` reads `calls.jsonl` from the default voice-call storage path. Use
`--file <path>` to point at a different log and `--last <n>` to limit analysis
to the last N records (default 200). Output includes p50/p90/p99 for turn
latency and listen-wait times.

## Agent tool

Tool name: `voice_call`

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `send_dtmf` (callId, digits)
- `end_call` (callId)
- `get_status` (callId)

This repo ships a matching skill doc at `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.dtmf` (`callId`, `digits`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)

## Related

- [Text-to-speech](/tools/tts)
- [Talk mode](/nodes/talk)
- [Voice wake](/nodes/voicewake)
