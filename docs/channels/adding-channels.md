# New Channel Checklist

Follow this guide when adding a new messaging channel or provider to Clawdbot.

## 1. Extension Setup
- [ ] Create a new directory in `extensions/<channel-name>`.
- [ ] Initialize `package.json` and `clawdbot.plugin.json`.
- [ ] Export a `ChannelPlugin` definition from the main entrypoint.

## 2. Plugin SDK Implementation
- [ ] Implement `capabilities` (polls, reactions, media).
- [ ] Define `configSchema` for account settings.
- [ ] Implement `gateway.startAccount` for lifecycle management.
- [ ] Implement `outbound.sendText` and `outbound.sendMedia`.

## 3. Docking & Routing
- [ ] Register the channel in `src/channels/registry.ts` (if core) or via the plugin loader.
- [ ] Add the channel to `CHAT_CHANNEL_ORDER` for UI ranking.
- [ ] Verify message normalization in `src/auto-reply/dispatch.ts`.

## 4. UI & Docs
- [ ] Add UI metadata to the catalog in `src/channels/plugins/catalog.ts`.
- [ ] Create a documentation page in `docs/channels/<channel-name>.md`.
- [ ] Add the channel to the "Supported Channels" list in the main README.

## 5. Verification
- [ ] Run `pnpm lint` and `pnpm build`.
- [ ] Test incoming message routing and agent reply delivery.
- [ ] Verify account linking/login flow (e.g., QR code or API key).
