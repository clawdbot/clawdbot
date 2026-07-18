---
summary: "Place outbound and accept inbound voice calls via Twilio, Telnyx, or Plivo, with optional realtime voice and streaming transcription"
read_when:
  - You want to place an outbound voice call from OpenClaw
  - You are configuring or developing the voice-call plugin
  - You need realtime voice or streaming transcription on telephony
title: "Voice call plugin"
sidebarTitle: "Voice call"
---

Voice calls for OpenClaw via a plugin: outbound notifications, multi-turn
conversations, full-duplex realtime voice, streaming transcription, and
inbound calls with allowlist policies.

**Providers:** `mock` (dev, no network), `plivo` (Voice API + XML transfer +
GetInput speech), `telnyx` (Call Control v2), `twilio` (Programmable Voice +
Media Streams).

<Note>
The Voice Call plugin runs **inside the Gateway process**. If you use a
remote Gateway, install and configure the plugin on the machine running the
Gateway, then restart the Gateway to load it.
</Note>

## Quick start

<Steps>
  <Step title="Install the plugin">
    <Tabs>
      <Tab title="From npm">
        ```bash
        openclaw plugins install @openclaw/voice-call
        ```
      </Tab>
      <Tab title="From a local folder (dev)">
        ```bash
        PLUGIN_SRC=./path/to/local/voice-call-plugin
        openclaw plugins install "$PLUGIN_SRC"
        cd "$PLUGIN_SRC" && pnpm install
        ```
      </Tab>
    </Tabs>

    Use the bare package to follow the current release tag. Pin an exact
    version only when you need a reproducible install. Restart the Gateway
    afterwards so the plugin loads.

  </Step>
  <Step title="Configure provider and webhook">
    Set config under `plugins.entries.voice-call.config` (see
    [Configuration](#configuration) below). At minimum: `provider`, provider
    credentials, `fromNumber`, and a publicly reachable webhook URL.
  </Step>
  <Step title="Verify setup">
    ```bash
    openclaw voicecall setup
    openclaw voicecall setup --json
    ```

    Checks plugin enablement, provider credentials, webhook exposure, and
    that only one audio mode (`streaming` or `realtime`) is active.

  </Step>
  <Step title="Smoke test">
    ```bash
    openclaw voicecall smoke
    openclaw voicecall smoke --to "+15555550123"
    ```

    Both are dry runs by default. Add `--yes` to place a short outbound
    notify call:

    ```bash
    openclaw voicecall smoke --to "+15555550123" --yes
    ```

  </Step>
</Steps>

<Warning>
For Twilio, Telnyx, and Plivo, setup must resolve to a **public webhook URL**.
If `publicUrl`, the tunnel URL, the Tailscale URL, or the serve fallback
resolves to loopback or private network space, setup fails instead of
starting a provider that cannot receive carrier webhooks.
</Warning>

## Configuration

If `enabled: true` but the selected provider is missing credentials, Gateway
startup logs a setup-incomplete warning with the missing keys and skips
starting the runtime. Commands, RPC calls, and agent tools still return the
exact missing configuration when used.

<Note>
Voice-call credentials accept SecretRefs. `plugins.entries.voice-call.config.twilio.authToken`, `plugins.entries.voice-call.config.realtime.providers.*.apiKey`, `plugins.entries.voice-call.config.streaming.providers.*.apiKey`, and `plugins.entries.voice-call.config.tts.providers.*.apiKey` resolve through the standard SecretRef surface; see [SecretRef credential surface](/reference/secretref-credential-surface).
</Note>

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
          sessionScope: "per-phone", // per-phone | per-call
          numbers: {
            "+15550009999": {
              inboundGreeting: "Silver Fox Cards, how can I help?",
              responseSystemPrompt: "You are a concise baseball card specialist.",
              tts: {
                providers: {
                  openai: { speakerVoice: "alloy" },
                },
              },
            },
          },

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
            // region: "ie1", // optional: us1 | ie1 | au1; defaults to us1
          },
          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Telnyx webhook public key from the Mission Control Portal
            // (Base64; can also be set via TELNYX_PUBLIC_KEY).
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
          // tailscale: { mode: "funnel", path: "/voice/webhook" },

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: { enabled: true /* Twilio only; see Streaming transcription */ },
          realtime: { enabled: false /* see Realtime voice conversations */ },
        },
      },
    },
  },
}
```

### Config reference

Top-level keys under `plugins.entries.voice-call.config` not shown above:

| Key                             | Default      | Notes                                                                                              |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `enabled`                       | `false`      | Master on/off switch.                                                                              |
| `inboundPolicy`                 | `"disabled"` | `disabled` \| `allowlist` \| `pairing` \| `open`. See [Inbound calls](#inbound-calls).             |
| `allowFrom`                     | `[]`         | E.164 allowlist for `inboundPolicy: "allowlist"`.                                                  |
| `maxDurationSeconds`            | `300`        | Hard per-call duration cap, enforced regardless of answered state.                                 |
| `staleCallReaperSeconds`        | `120`        | See [Stale call reaper](#stale-call-reaper). `0` disables it.                                      |
| `silenceTimeoutMs`              | `800`        | End-of-speech silence detection for the classic (non-realtime) flow.                               |
| `transcriptTimeoutMs`           | `180000`     | Max wait for a caller transcript before giving up on a turn.                                       |
| `ringTimeoutMs`                 | `30000`      | Ring timeout for outbound calls.                                                                   |
| `maxConcurrentCalls`            | `1`          | Outbound calls beyond this limit are rejected.                                                     |
| `outbound.notifyHangupDelaySec` | `3`          | Seconds to wait after TTS before auto-hangup in notify mode.                                       |
| `skipSignatureVerification`     | `false`      | Local testing only; never enable in production.                                                    |
| `store`                         | unset        | Overrides the default `$OPENCLAW_STATE_DIR/voice-calls` path (normally `~/.openclaw/voice-calls`). |
| `agentId`                       | `"main"`     | Agent used for response generation and session storage.                                            |
| `responseModel`                 | unset        | Overrides the default model for classic (non-realtime) responses.                                  |
| `responseSystemPrompt`          | generated    | Custom system prompt for classic responses.                                                        |
| `responseTimeoutMs`             | `30000`      | Timeout for classic response generation (ms).                                                      |

Twilio defaults to its US1 REST endpoint. To process calls in a supported
non-US Region, set `twilio.region` to `ie1` or `au1` and use credentials from
that Region. See
[Twilio's non-US REST API guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region).

<AccordionGroup>
  <Accordion title="Provider exposure and security notes">
    - Twilio, Telnyx, and Plivo all require a **publicly reachable** webhook URL.
    - `mock` is a local dev provider (no network calls).
    - Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
    - `skipSignatureVerification` is for local testing only.
    - On ngrok free tier, set `publicUrl` to the exact ngrok URL; signature verification is always enforced.
    - `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Local dev only.
    - Ngrok free-tier URLs can change or add interstitial behavior; if `publicUrl` drifts, Twilio signatures fail. Production: prefer a stable domain or a Tailscale funnel.

  </Accordion>
  <Accordion title="Streaming connection caps">
    - `streaming.preStartTimeoutMs` (default `5000`) closes sockets that never send a valid `start` frame.
    - `streaming.maxPendingConnections` (default `32`) caps total unauthenticated pre-start sockets.
    - `streaming.maxPendingConnectionsPerIp` (default `4`) caps unauthenticated pre-start sockets per source IP.
    - `streaming.maxConnections` (default `128`) caps all open media stream sockets (pending + active).

  </Accordion>
  <Accordion title="Legacy config migrations">
    Config parsing normalizes these legacy keys automatically and logs a
    warning naming the replacement path; the shim is removed in a future
    release (`2026.6.0`), so run `openclaw doctor --fix` to rewrite committed
    config to the canonical shape:

    - `provider: "log"` → `provider: "mock"`
    - `twilio.from` → `fromNumber`
    - `streaming.sttProvider` → `streaming.provider`
    - `streaming.openaiApiKey` → `streaming.providers.openai.apiKey`
    - `streaming.sttModel` → `streaming.providers.openai.model`
    - `streaming.silenceDurationMs` → `streaming.providers.openai.silenceDurationMs`
    - `streaming.vadThreshold` → `streaming.providers.openai.vadThreshold`
    - `realtime.agentContext.includeSystemPrompt` is removed (realtime context now uses the generated agent prompt)

  </Accordion>
</AccordionGroup>

## Session scope

By default, Voice Call uses `sessionScope: "per-phone"` so repeat calls from
the same caller keep conversation memory. Set `sessionScope: "per-call"` when
each carrier call should start with fresh context, for example reception,
booking, IVR, or Google Meet bridge flows where the same phone number may
represent different meetings.

Voice Call stores generated session keys under the configured agent namespace
(`agent:<agentId>:voice:*`). Raw explicit integration keys resolve into the
same namespace: a canonical `agent:<configuredAgentId>:*` key keeps that
owner and honors core `session.mainKey`/global-scope aliasing; foreign or
malformed `agent:*` input is scoped as an opaque key under the configured
agent; `global` and `unknown` remain global sentinels.

## Realtime voice conversations

`realtime` selects a full-duplex realtime voice provider for live call audio.
It is separate from `streaming`, which only forwards audio to realtime
transcription providers.

<Warning>
`realtime.enabled` cannot be combined with `streaming.enabled`. Pick one
audio mode per call.
</Warning>

Current runtime behavior:

- `realtime.enabled` is supported for Twilio and Telnyx.
- `realtime.provider` is optional. If unset, Voice Call uses the first registered realtime voice provider.
- Bundled realtime voice providers: Google Gemini Live (`google`) and OpenAI (`openai`), registered by their provider plugins.
- Provider-owned raw config lives under `realtime.providers.<providerId>`.
- Voice Call exposes the shared `openclaw_agent_consult` realtime tool by default. The realtime model can call it when the caller asks for deeper reasoning, current information, or normal OpenClaw tools.
- `realtime.consultPolicy` optionally adds guidance for when the realtime model should call `openclaw_agent_consult`.
- `realtime.agentContext.enabled` is default-off. When enabled, Voice Call injects a bounded agent identity and selected workspace-file capsule into the realtime provider instructions at session setup.
- `realtime.fastContext.enabled` is default-off. When enabled, Voice Call first searches indexed memory/session context for the consult question and returns those snippets to the realtime model within `realtime.fastContext.timeoutMs` before falling back to the full consult agent only if `realtime.fastContext.fallbackToConsult` is true.
- If `realtime.provider` points at an unregistered provider, or no realtime voice provider is registered at all, Voice Call logs a warning and skips realtime media instead of failing the whole plugin.
- `inboundPolicy` must not be `"disabled"` when `realtime.enabled` is true; `validateProviderConfig` rejects that combination.
- Consult session keys reuse the stored call session when available, then fall back to the configured `sessionScope` (`per-phone` by default, or `per-call` for isolated calls).

### Tool policy

`realtime.toolPolicy` controls the consult run:

| Policy           | Behavior                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `safe-read-only` | Expose the consult tool and limit the regular agent to `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, and `memory_get`. |
| `owner`          | Expose the consult tool and let the regular agent use the normal agent tool policy.                                                      |
| `none`           | Do not expose the consult tool. Custom `realtime.tools` are still passed through to the realtime provider.                               |

`realtime.consultPolicy` controls only the realtime model instructions:

| Policy        | Guidance                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `auto`        | Keep the default prompt and let the provider decide when to call the consult tool.              |
| `substantive` | Answer simple conversational glue directly and consult before facts, memory, tools, or context. |
| `always`      | Consult before every substantive answer.                                                        |

### Agent voice context

Enable `realtime.agentContext` when the voice bridge should sound like the
configured OpenClaw agent without paying a full agent-consult round trip on
ordinary turns. The context capsule is added once when the realtime session
is created, so it does not add per-turn latency. Calls to
`openclaw_agent_consult` still run the full OpenClaw agent and should be used
for tool work, current information, memory lookups, or workspace state.

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          agentId: "main",
          realtime: {
            enabled: true,
            provider: "google",
            toolPolicy: "safe-read-only",
            consultPolicy: "substantive",
            agentContext: {
              enabled: true,
              maxChars: 6000,
              includeIdentity: true,
              includeWorkspaceFiles: true,
              files: ["SOUL.md", "IDENTITY.md", "USER.md"],
            },
          },
        },
      },
    },
  },
}
```

### Realtime provider examples

<Tabs>
  <Tab title="Google Gemini Live">
    Defaults: API key from `realtime.providers.google.apiKey`, `GEMINI_API_KEY`,
    or `GOOGLE_API_KEY`; model `gemini-3.1-flash-live-preview`;
    voice `Kore`. `sessionResumption` and `contextWindowCompression` default on
    for longer, reconnectable calls. Use `silenceDurationMs`,
    `startSensitivity`, and `endSensitivity` to tune faster turn-taking on
    telephony audio.

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
                consultPolicy: "substantive",
                consultThinkingLevel: "low",
                consultFastMode: true,
                agentContext: { enabled: true },
                providers: {
                  google: {
                    apiKey: "${GEMINI_API_KEY}",
                    model: "gemini-3.1-flash-live-preview",
                    speakerVoice: "Kore",
                    silenceDurationMs: 500,
                    startSensitivity: "high",
                  },
                },
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="OpenAI">
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
                  openai: { apiKey: "${OPENAI_API_KEY}" },
                },
              },
            },
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

See [Google provider](/providers/google) and
[OpenAI provider](/providers/openai) for provider-specific realtime voice
options.

## Streaming transcription

`streaming` connects Twilio Media Streams to a realtime transcription provider.
The classic streaming path requires `provider: "twilio"`; configuration with
Telnyx, Plivo, or mock is rejected. Telnyx live audio uses the separately
authenticated `realtime.enabled` path instead.

Current runtime behavior:

- `streaming.provider` is optional. If unset, Voice Call uses the first registered realtime transcription provider.
- Bundled realtime transcription providers: Deepgram (`deepgram`), ElevenLabs (`elevenlabs`), Mistral (`mistral`), OpenAI (`openai`), and xAI (`xai`), registered by their provider plugins.
- Provider-owned raw config lives under `streaming.providers.<providerId>`.
- After Twilio sends an accepted stream `start` message, Voice Call registers the stream immediately, queues inbound media through the transcription provider while the provider connects, and starts the initial greeting only after realtime transcription is ready.
- If `streaming.provider` points at an unregistered provider, or none is registered, Voice Call logs a warning and skips media streaming instead of failing the whole plugin.

### Streaming provider examples

<Tabs>
  <Tab title="OpenAI">
    Defaults: API key `streaming.providers.openai.apiKey` or
    `OPENAI_API_KEY`; model `gpt-4o-transcribe`; `silenceDurationMs: 800`;
    `vadThreshold: 0.5`.

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

  </Tab>
  <Tab title="xAI">
    Defaults: API key `streaming.providers.xai.apiKey` or `XAI_API_KEY` (falls
    back to an xAI OAuth auth profile if neither is set); endpoint
    `wss://api.x.ai/v1/stt`; encoding `mulaw`; sample rate `8000`;
    `endpointingMs: 800`; `interimResults: true`.

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

  </Tab>
</Tabs>

## TTS for calls

Voice Call uses the core `messages.tts` configuration for streaming speech on
calls. You can override it under the plugin config with the **same shape** —
it deep-merges with `messages.tts`.

```json5
{
  tts: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        speakerVoiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
    },
  },
}
```

<Warning>
**Microsoft speech is ignored for voice calls.** Telephony synthesis requires
a provider that implements telephony-target output; the Microsoft speech
provider does not, so it is skipped for calls and other providers in the
fallback chain are tried instead.
</Warning>

Behavior notes:

- Legacy `tts.<provider>` keys inside plugin config (`openai`, `elevenlabs`, `microsoft`, `edge`) are repaired by `openclaw doctor --fix`; committed config should use `tts.providers.<provider>`.
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider-native voices.
- If a Twilio media stream is already active, Voice Call does not fall back to TwiML `<Say>`. If telephony TTS is unavailable in that state, the playback request fails instead of mixing two playback paths.
- When telephony TTS falls back to a secondary provider, Voice Call logs a warning with the provider chain (`from`, `to`, `attempts`) for debugging.
- When Twilio barge-in or stream teardown clears the pending TTS queue, queued playback requests settle instead of hanging callers awaiting playback completion.

### TTS examples

<Tabs>
  <Tab title="Core TTS only">
```json5
{
  messages: {
    tts: {
      provider: "openai",
      providers: {
        openai: { speakerVoice: "alloy" },
      },
    },
  },
}
```
  </Tab>
  <Tab title="Override to ElevenLabs (calls only)">
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
                speakerVoiceId: "pMsXgVXv3BLzUgSXRplE",
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
  </Tab>
  <Tab title="OpenAI model override (deep-merge)">
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
                speakerVoice: "marin",
              },
            },
          },
        },
      },
    },
  },
}
```
  </Tab>
</Tabs>

## Inbound calls

Inbound policy defaults to `disabled`. To enable inbound calls, set:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

<Warning>
`inboundPolicy: "allowlist"` is a low-assurance caller-ID screen. The plugin
normalizes the provider-supplied `From` value and compares it to `allowFrom`.
Webhook verification authenticates provider delivery and payload integrity,
but it does **not** prove PSTN/VoIP caller-number ownership. Treat
`allowFrom` as caller-ID filtering, not strong caller identity.
</Warning>

Auto-responses use the agent system. Tune with `responseModel`,
`responseSystemPrompt`, and `responseTimeoutMs`.

### Per-number routing

Use `numbers` when one Voice Call plugin receives calls for multiple phone
numbers and each number should behave like a different line. For example,
one number can use a casual personal assistant while another uses a business
persona, a different response agent, and a different TTS voice.

Routes are selected from the provider-supplied dialed `To` number. Keys must
be E.164 numbers. When a call arrives, Voice Call resolves the matching
route once, stores the matched route on the call record, and reuses that
effective config for the greeting, classic auto-response path, realtime
consult path, and TTS playback. If no route matches, the global Voice Call
config is used. Outbound calls do not use `numbers`; pass the outbound
target, message, and session explicitly when initiating the call.

Route overrides currently support:

- `inboundGreeting`
- `tts`
- `agentId`
- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

The `tts` route value deep-merges over the global Voice Call `tts` config, so
you can usually override only the provider voice:

```json5
{
  inboundGreeting: "Hello from the main line.",
  responseSystemPrompt: "You are the default voice assistant.",
  tts: {
    provider: "openai",
    providers: {
      openai: { speakerVoice: "coral" },
    },
  },
  numbers: {
    "+15550001111": {
      inboundGreeting: "Silver Fox Cards, how can I help?",
      responseSystemPrompt: "You are a concise baseball card specialist.",
      tts: {
        providers: {
          openai: { speakerVoice: "alloy" },
        },
      },
    },
  },
}
```

### Spoken output contract

For auto-responses, Voice Call appends a strict spoken-output contract to
the system prompt requiring a `{"spoken":"..."}` JSON reply. Voice Call
extracts speech text defensively:

- Ignores payloads marked as reasoning/error content.
- Parses direct JSON, fenced JSON, or inline `"spoken"` keys.
- Falls back to plain text and removes likely planning/meta lead-in paragraphs.

This keeps spoken playback focused on caller-facing text and avoids leaking
planning text into audio.

### Conversation startup behavior

For outbound `conversation` calls, first-message handling is tied to live
playback state:

- Barge-in queue clear and auto-response are suppressed only while the initial greeting is actively speaking.
- If initial playback fails, the call returns to `listening` and the initial message remains queued for retry.
- Initial playback for Twilio streaming starts on stream connect without extra delay.
- Barge-in aborts active playback and clears queued-but-not-yet-playing Twilio TTS entries. Cleared entries resolve as skipped, so follow-up response logic can continue without waiting on audio that will never play.
- Realtime voice conversations use the realtime stream's own opening turn. Voice Call does **not** post a legacy `<Say>` TwiML update for that initial message, so outbound `<Connect><Stream>` sessions stay attached.

### Twilio stream disconnect grace

When a Twilio media stream disconnects, Voice Call waits **2000 ms** before
auto-ending the call:

- If the stream reconnects during that window, auto-end is canceled.
- If no stream re-registers after the grace period, the call is ended to prevent stuck active calls.

## Stale call reaper

Use `staleCallReaperSeconds` (default **120**) to end calls that are never
answered and never reach a live conversation state, for example notify-mode
calls where the provider never delivers a terminal webhook. Set it to `0` to
disable.

The reaper runs every 30 seconds and only ends calls that have no
`answeredAt` timestamp and are not already in a terminal or live
(`speaking`/`listening`) state, so answered conversations are never reaped
by this timer; `maxDurationSeconds` (default 300) is the separate cap that
ends answered calls that run too long.

For notify-style flows where carriers can be slow to deliver ring/answer
webhooks, raise `staleCallReaperSeconds` past the default so slow-but-normal
calls are not reaped early; `120`-`300` seconds is a reasonable production
range.

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          maxDurationSeconds: 300,
          staleCallReaperSeconds: 120,
        },
      },
    },
  },
}
```

## Webhook security

When a proxy or tunnel sits in front of the Gateway, the plugin reconstructs
the public URL for signature verification. These options control which
forwarded headers are trusted:

<ParamField path="webhookSecurity.allowedHosts" type="string[]">
  Allowlist hosts from forwarding headers.
</ParamField>
<ParamField path="webhookSecurity.trustForwardingHeaders" type="boolean">
  Trust forwarded headers without an allowlist.
</ParamField>
<ParamField path="webhookSecurity.trustedProxyIPs" type="string[]">
  Only trust forwarded headers when the request remote IP matches the list.
</ParamField>

Additional protections:

- Webhook **replay protection** is enabled for Twilio, Telnyx, and Plivo. Replayed valid webhook requests are acknowledged but skipped for side effects.
- Twilio conversation turns include a per-turn token in `<Gather>` callbacks, so stale/replayed speech callbacks cannot satisfy a newer pending transcript turn.
- Unauthenticated webhook requests are rejected before body reads when the provider's required signature headers are missing.
- The voice-call webhook uses the shared pre-auth body-read profile (64 KB max body, 5-second read timeout) plus a per-key in-flight cap (8 concurrent requests per key by default) before signature verification.

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
openclaw voicecall latency                      # summarize turn latency from logs
openclaw voicecall expose --mode funnel
```

When the Gateway is already running, operational `voicecall` commands
delegate to the Gateway-owned voice-call runtime so the CLI does not bind a
second webhook server. If no Gateway is reachable, the commands fall back to
a standalone CLI runtime.

`latency` reads `calls.jsonl` from the default voice-call storage path. Use
`--file <path>` to point at a different log and `--last <n>` to limit
analysis to the last N records (default 200). Output includes min/max/avg,
p50, and p95 for turn latency and listen-wait times.

## Agent tool

Tool name: `voice_call`.

| Action          | Args                                       |
| --------------- | ------------------------------------------ |
| `initiate_call` | `message`, `to?`, `mode?`, `dtmfSequence?` |
| `continue_call` | `callId`, `message`                        |
| `speak_to_user` | `callId`, `message`                        |
| `send_dtmf`     | `callId`, `digits`                         |
| `end_call`      | `callId`                                   |
| `get_status`    | `callId`                                   |

The voice-call plugin ships a matching agent skill.

## Gateway RPC

| Method                      | Args                                                             | Notes                                                                     |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `voicecall.initiate`        | `to?`, `message`, `mode?`, `sessionKey?`, `requesterSessionKey?` | Falls back to `toNumber` config when `to` is omitted.                     |
| `voicecall.start`           | `to`, `message?`, `mode?`, `dtmfSequence?`, `sessionKey?`        | Same as `initiate` but also accepts pre-connect `dtmfSequence`.           |
| `voicecall.continue`        | `callId`, `message`                                              | Blocks until the turn resolves; returns the transcript.                   |
| `voicecall.continue.start`  | `callId`, `message`                                              | Async variant: returns an `operationId` immediately.                      |
| `voicecall.continue.result` | `operationId`                                                    | Polls a pending `voicecall.continue.start` operation for its result.      |
| `voicecall.speak`           | `callId`, `message`                                              | Speaks without waiting; uses the realtime bridge when `realtime.enabled`. |
| `voicecall.dtmf`            | `callId`, `digits`                                               |                                                                           |
| `voicecall.end`             | `callId`                                                         |                                                                           |
| `voicecall.status`          | `callId?`                                                        | Omit `callId` to list all active calls.                                   |

`dtmfSequence` is only valid with `mode: "conversation"`; notify-mode calls
should use `voicecall.dtmf` after the call exists if they need post-connect
digits.

## Troubleshooting

### Setup fails webhook exposure

Run setup from the same environment that runs the Gateway:

```bash
openclaw voicecall setup
openclaw voicecall setup --json
```

For `twilio`, `telnyx`, and `plivo`, `webhook-exposure` must be green. A
configured `publicUrl` still fails when it points at local or private
network space, because the carrier cannot call back into those addresses.
Do not use `localhost`, `127.0.0.1`, `0.0.0.0`, `10.x`, `172.16.x`-`172.31.x`,
`192.168.x`, `169.254.x`, `fc00::/7`, `fd00::/8`, or other carrier-grade-NAT
ranges as `publicUrl`.

Twilio notify-mode outbound calls send their initial `<Say>` TwiML directly
in the create-call request, so the first spoken message does not depend on
Twilio fetching webhook TwiML. A public webhook is still required for status
callbacks, conversation calls, pre-connect DTMF, realtime streams, and
post-connect call control.

Use one public exposure path:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          // or
          tunnel: { provider: "ngrok" },
          // or
          tailscale: { mode: "funnel", path: "/voice/webhook" },
        },
      },
    },
  },
}
```

After changing config, restart or reload the Gateway, then run:

```bash
openclaw voicecall setup
openclaw voicecall smoke
```

`voicecall smoke` is a dry run unless you pass `--yes`.

### Provider credentials fail

Check the selected provider and the required credential fields:

- Twilio: `twilio.accountSid`, `twilio.authToken`, and `fromNumber`, or
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.
- Telnyx: `telnyx.apiKey`, `telnyx.connectionId`, `telnyx.publicKey`, and
  `fromNumber`, or `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, and
  `TELNYX_PUBLIC_KEY`.
- Plivo: `plivo.authId`, `plivo.authToken`, and `fromNumber`, or
  `PLIVO_AUTH_ID` and `PLIVO_AUTH_TOKEN`.

Credentials must exist on the Gateway host. Editing a local shell profile
does not affect an already running Gateway until it restarts or reloads its
environment.

### Calls start but provider webhooks do not arrive

Confirm the provider console points at the exact public webhook URL:

```text
https://voice.example.com/voice/webhook
```

Then inspect runtime state:

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw logs --follow
```

Common causes:

- `publicUrl` points at a different path than `serve.path`.
- The tunnel URL changed after the Gateway started.
- A proxy forwards the request but strips or rewrites host/proto headers.
- Firewall or DNS routes the public hostname somewhere other than the Gateway.
- The Gateway was restarted without the Voice Call plugin enabled.

When a reverse proxy or tunnel is in front of the Gateway, set
`webhookSecurity.allowedHosts` to the public hostname, or use
`webhookSecurity.trustedProxyIPs` for a known proxy address. Use
`webhookSecurity.trustForwardingHeaders` only when the proxy boundary is
under your control.

### Signature verification fails

Provider signatures are checked against the public URL OpenClaw reconstructs
from the incoming request. If signatures fail:

- Confirm the provider webhook URL exactly matches `publicUrl`, including scheme, host, and path.
- For ngrok free-tier URLs, update `publicUrl` when the tunnel hostname changes.
- Ensure the proxy preserves the original host and proto headers, or configure `webhookSecurity.allowedHosts`.
- Do not enable `skipSignatureVerification` outside local testing.

### Google Meet Twilio joins fail

Google Meet uses this plugin for Twilio dial-in joins. First verify Voice
Call:

```bash
openclaw voicecall setup
openclaw voicecall smoke --to "+15555550123"
```

Then verify the Google Meet transport explicitly:

```bash
openclaw googlemeet setup --transport twilio
```

If Voice Call is green but the Meet participant never joins, check the Meet
dial-in number, PIN, and `--dtmf-sequence`. The phone call can be healthy
while the meeting rejects or ignores an incorrect DTMF sequence.

Google Meet starts the Twilio phone leg through `voicecall.start` with a
pre-connect DTMF sequence. PIN-derived sequences include the Google Meet
plugin's `voiceCall.dtmfDelayMs` (default **12000 ms**) as leading Twilio
wait digits, because Meet dial-in prompts can arrive late. Voice Call then
redirects back to realtime handling before the intro greeting is requested.

Use `openclaw logs --follow` for the live phase trace. A healthy Twilio Meet
join logs this order:

- Google Meet delegates the Twilio join to Voice Call.
- Voice Call stores pre-connect DTMF TwiML.
- Twilio initial TwiML is consumed and served before realtime handling.
- Voice Call serves realtime TwiML for the Twilio call.
- Google Meet requests intro speech with `voicecall.speak` after the post-DTMF delay.

`openclaw voicecall tail` still shows persisted call records; useful for
call state and transcripts, but not every webhook/realtime transition
appears there.

### Realtime call has no speech

Confirm only one audio mode is enabled: `realtime.enabled` and
`streaming.enabled` cannot both be true.

For realtime Twilio/Telnyx calls, also verify:

- A realtime provider plugin is loaded and registered.
- `realtime.provider` is unset or names a registered provider.
- The provider API key is available to the Gateway process.
- `openclaw logs --follow` shows realtime TwiML served, the realtime bridge started, and the initial greeting queued.

## Related

- [Talk mode](/nodes/talk)
- [Text-to-speech](/tools/tts)
- [Voice wake](/nodes/voicewake)
