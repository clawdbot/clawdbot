# Voice Call Feature

Phone call integration for Clawdbot, allowing the AI to make and receive voice calls.

## Status

✅ **Ready** - Core implementation complete and wired to Gateway.

## Features

- **Multi-provider support**: Telnyx and Twilio with abstraction layer
- **Call modes**: Notify (one-way delivery) or Conversation (back-and-forth)
- **Outbound calls**: Bot can call users when needed
- **Inbound calls**: Accept calls from allowlisted numbers (disabled by default)
- **Multi-turn conversations**: Speak and listen with transcription
- **Call logging**: Persistent transcript and call history
- **Safety limits**: Max duration timer auto-hangup
- **Security**: Webhook signature verification, phone number allowlists

## Configuration

Add to your `clawdbot.json5`:

```json5
{
  "voiceCall": {
    "enabled": true,
    "provider": "telnyx",  // or "twilio"

    // Provider credentials
    "telnyx": {
      "apiKey": "KEY...",           // or TELNYX_API_KEY env
      "connectionId": "...",        // or TELNYX_CONNECTION_ID env
      "publicKey": "..."            // for webhook verification
    },

    // Phone numbers (E.164 format)
    "fromNumber": "+15551234567",
    "toNumber": "+15550001234",     // default recipient

    // Security
    "inboundPolicy": "disabled",    // disabled | allowlist | open
    "allowFrom": ["+15550001234"],

    // Outbound call behavior
    "outbound": {
      "defaultMode": "notify",      // notify | conversation
      "notifyHangupDelaySec": 3     // seconds to wait before hangup in notify mode
    },

    // Webhook server
    "serve": {
      "port": 3334,
      "path": "/voice/webhook"
    },
    "tailscale": {
      "mode": "funnel",             // off | serve | funnel
      "path": "/voice"
    },

    // Timeouts & limits
    "maxDurationSeconds": 300,      // safety cap - auto-hangup after this
    "silenceTimeoutMs": 800,
    "ringTimeoutMs": 30000
  }
}
```

### Call Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `notify` | Deliver message → wait delay → auto-hangup | Reminders, alerts, one-way notifications |
| `conversation` | Keep call open for back-and-forth | Support calls, interactive sessions |

The default mode is `notify`. In conversation mode, calls stay open until:
- Bot explicitly calls `end_call`
- User hangs up
- `maxDurationSeconds` is reached (safety limit)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELNYX_API_KEY` | Telnyx API v2 key |
| `TELNYX_CONNECTION_ID` | Telnyx Call Control app connection ID |
| `TELNYX_PUBLIC_KEY` | Telnyx webhook public key (optional) |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |

## Tool Usage

The `voice_call` tool provides these actions:

### initiate_call

Start a phone call:

```json
{
  "action": "initiate_call",
  "to": "+15550001234",
  "message": "Your appointment is tomorrow at 3pm. See you then!"
}
```

With explicit mode (overrides config default):

```json
{
  "action": "initiate_call",
  "to": "+15550001234",
  "message": "Hi! I have a question about your project.",
  "mode": "conversation"
}
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | No | Phone number (E.164). Uses config default if omitted. |
| `message` | Yes | Message to speak when call is answered. |
| `mode` | No | `notify` or `conversation`. Uses config default if omitted. |

### continue_call

Continue with follow-up (speak then listen):

```json
{
  "action": "continue_call",
  "callId": "uuid-from-initiate",
  "message": "Got it. Should I add rate limiting too?"
}
```

### speak_to_user

Speak without waiting for response (useful before long operations):

```json
{
  "action": "speak_to_user",
  "callId": "uuid",
  "message": "Let me search for that. One moment..."
}
```

### end_call

Hang up:

```json
{
  "action": "end_call",
  "callId": "uuid"
}
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│   Agent Tool    │────►│   CallManager    │
└─────────────────┘     └────────┬─────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │  Telnyx  │ │  Twilio  │ │  Future  │
              │ Provider │ │ Provider │ │ Provider │
              └────┬─────┘ └────┬─────┘ └──────────┘
                   │            │
                   ▼            ▼
              ┌─────────────────────────────────┐
              │        Provider APIs            │
              └─────────────────────────────────┘
                              │
                              ▼
              ┌─────────────────────────────────┐
              │   Webhook Server (Tailscale)    │
              └─────────────────────────────────┘
```

## Files

```
src/voice-call/
├── index.ts           # Module exports
├── types.ts           # Type definitions
├── config.ts          # Configuration schema
├── manager.ts         # Call state machine & coordination
├── runtime.ts         # Singleton runtime initialization
├── webhook.ts         # HTTP server for webhooks
└── providers/
    ├── base.ts        # Provider interface
    ├── telnyx.ts      # Telnyx implementation
    ├── twilio.ts      # Twilio implementation
    └── index.ts       # Provider exports

src/agents/tools/
├── voice-call-tool.ts       # Tool definition
└── voice-call-schema.ts     # TypeBox schemas

src/gateway/server-methods/
└── voicecall.ts             # Gateway RPC handlers
```

## CLI Commands

```bash
# Tail call logs
clawdbot voicecall tail --since 50

# Expose webhook via Tailscale funnel
clawdbot voicecall expose --mode funnel
```

## Future Improvements

- [ ] Setup wizard for credentials
- [ ] Inbound call pairing flow
- [ ] Call recording (optional)
- [ ] Integration tests
