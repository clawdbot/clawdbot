---
summary: "Voice Call plugin: outbound and inbound calls via Twilio/Telnyx, with CLI, tools, and streaming"
read_when:
  - You want to place an outbound voice call from Clawdbot
  - You are configuring or developing the voice-call plugin
---

# Voice Call (plugin)

Voice calls for Clawdbot. Use it to place outbound notifications, run multi-turn
phone conversations, and accept inbound calls with an explicit policy.

Current providers:
- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `mock` (dev/no network)

What you get:
- Outbound calls in notify or conversation mode
- Inbound calls with allowlist or open policies
- Provider webhooks with signature verification
- Optional streaming (Twilio Media Streams + OpenAI Realtime STT)
- CLI commands, a tool surface, and JSONL call logs

Quick mental model:
1. Install plugin
2. Restart Gateway
3. Configure `plugins.entries.voice-call.config`
4. Expose a public webhook URL
5. Call via `clawdbot voicecall ...` or the `voice_call` tool

## Where it runs (local vs remote)

The Voice Call plugin runs inside the Gateway process.

If you use a remote Gateway, install and configure the plugin on the machine
running the Gateway, then restart the Gateway to load it.

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

Note: use `pnpm` for repo work. Bun is not recommended and can cause issues in
other Clawdbot channels (especially WhatsApp and Telegram).

## Config overview

All config lives under `plugins.entries.voice-call.config`. Phone numbers must
be in E.164 format (`+15550001234`).

Minimal example (Twilio outbound only):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          fromNumber: "+15550001234",
          toNumber: "+15550005678",
          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "..."
          },
          serve: { port: 3334, bind: "127.0.0.1", path: "/voice/webhook" },
          publicUrl: "https://example.ngrok.app/voice/webhook",
          outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 }
        }
      }
    }
  }
}
```

Notes:
- Twilio/Telnyx require a publicly reachable webhook URL.
- `mock` is a local dev provider (no network calls).
- `skipSignatureVerification` is for local testing only.

## Public URL and webhook exposure

Providers send webhooks from the public internet. Your `serve.path` must be
reachable from them.

You have three options:
- `publicUrl`: you already have a public HTTPS URL pointing at the Gateway host.
- `tunnel`: use ngrok or Tailscale (recommended for quick setup).
- `tailscale`: legacy Tailscale serve/funnel config (still supported, but
  `tunnel` is preferred).

Example using ngrok:

```json5
{
  tunnel: {
    provider: "ngrok",
    ngrokAuthToken: "..."
  }
}
```

Example using Tailscale Funnel:

```json5
{
  tunnel: { provider: "tailscale-funnel" }
}
```

CLI helper (Tailscale only):

```bash
clawdbot voicecall expose --mode funnel
```

If you use Tailscale Serve without Funnel, the URL is private to your tailnet,
so Twilio/Telnyx will not be able to reach it.

## Providers

### Twilio

Twilio uses Programmable Voice with optional Media Streams for real-time audio.

Required config:
- `twilio.accountSid` and `twilio.authToken`
- (or `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`)
- A Twilio phone number that can reach your webhook

Inbound setup:
- In the Twilio Console for your phone number, set the Voice webhook to your
  public `serve.path` URL (HTTP POST).

Outbound setup:
- Outbound calls are created via Twilio API; the plugin supplies the webhook URL
  per call.

Streaming (optional, Twilio only):
- Enable `streaming.enabled` and set `streaming.streamPath`
- Provide `OPENAI_API_KEY` or `streaming.openaiApiKey`
- The stream WebSocket URL is derived from your `publicUrl` host + `streamPath`
  (https -> wss)

Signature verification:
- Webhooks are verified by default.
- If you are using ngrok free tier, leave `tunnel.allowNgrokFreeTier` as `true`
  so URL rewriting does not break verification.
- Use `skipSignatureVerification` only for local dev.

### Telnyx

Telnyx uses Call Control v2.

Required config:
- `telnyx.apiKey` and `telnyx.connectionId`
- (or `TELNYX_API_KEY` / `TELNYX_CONNECTION_ID`)

Inbound setup:
- In your Telnyx Call Control App, set the webhook URL to your public
  `serve.path`.

Signature verification:
- Set `telnyx.publicKey` to enable Ed25519 signature verification.
- If you do not set a public key, webhooks are accepted without verification
  (not recommended for production).

Transcription:
- Telnyx uses its own transcription events for `continue` responses.

### Mock (dev)

`mock` is for local testing and does not make network calls.

## Call modes

Outbound calls support two modes:
- `notify`: speak a message and auto-hangup after `notifyHangupDelaySec`.
- `conversation`: keep the call open and allow back-and-forth.

Examples:

```bash
clawdbot voicecall call --to "+15555550123" --message "Hello" --mode notify
clawdbot voicecall call --to "+15555550123" --message "Ready to talk?" --mode conversation
```

## Inbound calls and policy

Inbound calls are blocked by default.

Policies:
- `disabled`: block all inbound calls
- `allowlist`: allow only numbers in `allowFrom`
- `pairing`: currently behaves like `allowlist`
- `open`: accept all inbound calls

Inbound greeting:
- `inboundGreeting` controls the first message spoken when a call is accepted.

## Auto-responses and models

When a caller speaks, the plugin can auto-respond using the embedded Clawdbot
agent.

Key settings:
- `responseModel`: model reference for voice responses (default `openai/gpt-4o-mini`)
- `responseSystemPrompt`: optional override for the voice system prompt
- `responseTimeoutMs`: response generation timeout

Responses use the same agent system as messaging, including tool access.
The default system prompt keeps replies short and conversational (about 1-2 sentences).

## Streaming (Twilio only)

When `streaming.enabled` is on:
- The webhook server also accepts WebSocket upgrades at `streaming.streamPath`.
- Audio is forwarded to OpenAI Realtime STT.
- Final transcripts are fed into the call manager and used by `continue` and
  auto-responses.

Required:
- A public HTTPS URL for the Gateway (used to derive `wss://...`).
- `OPENAI_API_KEY` or `streaming.openaiApiKey`.

If no OpenAI key is available, streaming does not start and real-time transcripts
will not arrive.

## Limits and timeouts

These settings are enforced by the call manager:
- `maxDurationSeconds`: auto-hangup after this many seconds (starts when answered).
- `maxConcurrentCalls`: max simultaneous active calls.
- `transcriptTimeoutMs`: how long `continue` waits for a final transcript.

## Logs and debugging

Calls are appended as JSONL to:
- `${store}/calls.jsonl`, or
- `~/clawd/voice-calls/calls.jsonl` by default

Set `store` if you want a different base directory for call logs.

Use:

```bash
clawdbot voicecall tail
```

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

If you want a ready-made skill entry, grab it from [ClawdHub.com](https://ClawdHub.com).

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
