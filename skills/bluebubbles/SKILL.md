---
name: bluebubbles
description: Build or update the BlueBubbles external channel plugin for Clawdbot (extension package, REST send/probe, webhook inbound).
---

# BlueBubbles plugin

Use this skill when working on the BlueBubbles channel plugin.

## Layout
- Extension package: `extensions/bluebubbles/` (entry: `index.ts`).
- Channel implementation: `extensions/bluebubbles/src/channel.ts`.
- Webhook handling: `extensions/bluebubbles/src/monitor.ts` (register via `api.registerHttpHandler`).
- REST helpers: `extensions/bluebubbles/src/send.ts` + `extensions/bluebubbles/src/probe.ts`.
- Runtime bridge: `extensions/bluebubbles/src/runtime.ts` (set via `api.runtime`).
- Catalog entry for onboarding: `src/channels/plugins/catalog.ts`.

## Internal helpers (use these, not raw API calls)
- `probeBlueBubbles` in `extensions/bluebubbles/src/probe.ts` for health checks.
- `sendMessageBlueBubbles` in `extensions/bluebubbles/src/send.ts` for text delivery.
- `resolveChatGuidForTarget` in `extensions/bluebubbles/src/send.ts` for chat lookup.
- `sendBlueBubblesReaction` in `extensions/bluebubbles/src/reactions.ts` for tapbacks.
- `sendBlueBubblesTyping` + `markBlueBubblesChatRead` in `extensions/bluebubbles/src/chat.ts`.
- `downloadBlueBubblesAttachment` in `extensions/bluebubbles/src/attachments.ts` for inbound media.
- `buildBlueBubblesApiUrl` + `blueBubblesFetchWithTimeout` in `extensions/bluebubbles/src/types.ts` for shared REST plumbing.

## Webhooks
- BlueBubbles posts JSON to the gateway HTTP server.
- Normalize sender/chat IDs defensively (payloads vary by version).
- Skip messages marked as from self.
- Route into core reply pipeline via the plugin runtime (`api.runtime`) and `clawdbot/plugin-sdk` helpers.
- For attachments/stickers, use `<media:...>` placeholders when text is empty and attach media paths via `MediaUrl(s)` in the inbound context.

## Config (core)
- `channels.bluebubbles.serverUrl` (base URL), `channels.bluebubbles.password`, `channels.bluebubbles.webhookPath`.
- Action gating: `channels.bluebubbles.actions.reactions` (default true).

## Message tool notes
- **Reactions:** The `react` action requires a `target` (phone number or chat identifier) in addition to `messageId`. Example: `action=react target=+15551234567 messageId=ABC123 emoji=❤️`
