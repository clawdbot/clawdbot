---
summary: "iMessage via BlueBubbles macOS server (REST send/receive, typing, reactions, pairing)."
read_when:
  - Setting up BlueBubbles channel
  - Troubleshooting webhook pairing
---
# BlueBubbles (macOS REST)

Status: bundled plugin (disabled by default) that talks to the BlueBubbles macOS server over HTTP.

## Overview
- Runs on macOS via the BlueBubbles helper app (`https://bluebubbles.app`).
- Clawdbot talks to it through its REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Incoming messages arrive via webhooks; outgoing replies, typing indicators, read receipts, and tapbacks are REST calls.
- Attachments and stickers are ingested as inbound media (and surfaced to the agent when possible).
- Pairing/allowlist works the same way as other channels (`/start/pairing` etc) with `channels.bluebubbles.allowFrom` + pairing codes.
- Reactions are surfaced as system events just like Slack/Telegram so agents can “mention” them before replying.

## Quick start
1. Install the BlueBubbles server on your Mac (follows the app store instructions at `https://bluebubbles.app/install`).
2. In the BlueBubbles config, enable the web API and set a password for `guid`/`password`.
3. Configure Clawdbot:
   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://bluebubbles-host:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
         actions: { reactions: true }
       }
     }
   }
   ```
4. Point BlueBubbles webhooks to your gateway (example: `http://your-gateway-host/bluebubbles-webhook?password=<password>`).
5. Start the gateway; it will register the webhook handler and start pairing.

## Configuration notes
- `channels.bluebubbles.serverUrl`: base URL of the BlueBubbles REST API.
- `channels.bluebubbles.password`: password that BlueBubbles expects on every request (`?password=...` or header).
- `channels.bluebubbles.webhookPath`: HTTP path the gateway exposes for BlueBubbles webhooks.
- `channels.bluebubbles.dmPolicy` / `groupPolicy` + `allowFrom`/`groupAllowFrom` behave like other channels; pairing/allowlist info is stored in `/pairing`.
- `channels.bluebubbles.actions.reactions` toggles whether the gateway enqueues system events for reactions/tapbacks.
- `channels.bluebubbles.textChunkLimit` overrides the default 4k limit.
- `channels.bluebubbles.mediaMaxMb` controls the max size of inbound attachments saved for analysis (default 8MB).

## How it works
- Outbound replies: `sendMessageBlueBubbles` resolves a chat GUID via `/api/v1/chat/query` and posts to `/api/v1/message/text`. Typing (`/api/v1/chat/<guid>/typing`) and read receipts (`/api/v1/chat/<guid>/read`) are sent before/after responses.
- Webhooks: BlueBubbles POSTs JSON payloads with `type` and `data`. The plugin ignores non-message events (typing indicator, read status) and extracts `chatGuid` from `data.chats[0].guid`.
- Reactions/tapbacks generate `BlueBubbles reaction added/removed` system events so agents can mention them. Agents can also trigger tapbacks via the `react` action with `messageId`, `emoji`, and a `to`/`chatGuid`.
- Attachments are downloaded via the REST API and stored in the inbound media cache; text-less messages are converted into `<media:...>` placeholders so the agent knows something was sent.

## Security
- Webhook requests are authenticated by comparing `guid`/`password` query params or headers against `channels.bluebubbles.password`. Requests from `localhost` are also accepted.
- Keep the API password and webhook endpoint secret (treat them like credentials).
- Enable HTTPS + firewall rules on the BlueBubbles server if exposing it outside your LAN.

## Troubleshooting
- If Voice/typing events stop working, check the BlueBubbles webhook logs and verify the gateway path matches `channels.bluebubbles.webhookPath`.
- Pairing codes expire after one hour; use `clawdbot pairing list bluebubbles` and `clawdbot pairing approve bluebubbles <code>`.
- Reactions require the BlueBubbles private API (`POST /api/v1/message/react`); ensure the server version exposes it.

For general channel workflow reference, see [/channels/index] and the [[plugins|/plugin]] guide.
