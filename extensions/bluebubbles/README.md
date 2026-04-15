# BlueBubbles extension (developer reference)

This package contains the **BlueBubbles external channel plugin** for OpenClaw.

If you’re looking for **how to use BlueBubbles as an agent/tool user**, see:

- `skills/bluebubbles/SKILL.md`

## Layout

- Package entry: `index.ts`.
- Channel implementation: `src/channel.ts`.
- Webhook handling: `src/monitor.ts` (register per-account route via `registerPluginHttpRoute`).
- REST helpers: `src/send.ts` + `src/probe.ts`.
- Runtime bridge: `src/runtime.ts` (set via `api.runtime`).
- Catalog entry for setup selection: `src/channels/plugins/catalog.ts`.

## Internal helpers (use these, not raw API calls)

- `probeBlueBubbles` in `src/probe.ts` for health checks.
- `sendMessageBlueBubbles` in `src/send.ts` for text delivery.
- `resolveChatGuidForTarget` in `src/send.ts` for chat lookup.
- `sendBlueBubblesReaction` in `src/reactions.ts` for tapbacks.
- `sendBlueBubblesTyping` + `markBlueBubblesChatRead` in `src/chat.ts`.
- `downloadBlueBubblesAttachment` in `src/attachments.ts` for inbound media.
- `buildBlueBubblesApiUrl` + `blueBubblesFetchWithTimeout` in `src/types.ts` for shared REST plumbing.

## Webhooks

- BlueBubbles posts JSON to the gateway HTTP server.
- Normalize sender/chat IDs defensively (payloads vary by version).
- Skip messages marked as from self.
- Route into core reply pipeline via the plugin runtime (`api.runtime`) and `openclaw/plugin-sdk` helpers.
- For attachments/stickers, use `<media:...>` placeholders when text is empty and attach media paths via `MediaUrl(s)` in the inbound context.

## Config (core)

- `channels.bluebubbles.serverUrl` (base URL), `channels.bluebubbles.password`, `channels.bluebubbles.webhookPath`.
- Action gating: `channels.bluebubbles.actions.reactions` (default true).

## Message tool notes

- **Reactions:** the `react` action requires a `target` (phone number or chat identifier) in addition to `messageId`.
  Example:
  `action=react target=+15551234567 messageId=ABC123 emoji=❤️`
