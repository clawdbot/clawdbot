---
summary: "Voice Call plugin: outbound + inbound calls via Twilio/Telnyx/Plivo (plugin install + config + CLI)"
read_when:
  - You want to place an outbound voice call from Clawdbot
  - You are configuring or developing the voice-call plugin
---

# Voice Call (plugin)

Voice calls for Clawdbot via a plugin. Supports outbound notifications and
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
- Use `clawdbot voicecall ...` or the `voice_call` tool

## Where it runs (local vs remote)

The Voice Call plugin runs **inside the Gateway process**.

If you use a remote Gateway, install/configure the plugin on the **machine running the Gateway**, then restart the Gateway to load it.

## Install

### Option A: install from npm (recommended)

```bash
clawdbot plugins install @clawdbot/voice-call
```

Restart the Gateway afterwards.

### Option B: install from a local folder (dev, no copying)

```bash
clawdbot plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
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
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "..."
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "..."
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook"
          },

          // Public exposure (pick one)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify" // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream"
          }
        }
      }
    }
  }
}
```

Notes:
- Twilio/Telnyx require a **publicly reachable** webhook URL.
- Plivo requires a **publicly reachable** webhook URL.
- `mock` is a local dev provider (no network calls).
- `skipSignatureVerification` is for local testing only.

## Inbound calls

Inbound policy defaults to `disabled`. To enable inbound calls, set:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?"
}
```

Auto-responses use the agent system. Tune with:
- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
clawdbot voicecall call --to "+15555550123" --message "Hello from Clawdbot"
clawdbot voicecall continue --call-id <id> --message "Any questions?"
clawdbot voicecall speak --call-id <id> --message "One moment"
clawdbot voicecall end --call-id <id>
clawdbot voicecall status --call-id <id>
clawdbot voicecall tail
clawdbot voicecall expose --mode funnel
```

## Agent tool

Tool name: `voice_call`

Actions:
- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

This repo ships a matching skill doc at `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
