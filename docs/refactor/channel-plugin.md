---
summary: "Channel plugin refactor implementation notes (registry, status, gateway/runtime)"
read_when:
  - Adding or refactoring channel plugin wiring
  - Moving channel-specific behavior into plugin hooks
---

# Channel Plugins — Implementation Notes

Goal: make chat channels (iMessage, Discord, etc.) pluggable with minimal wiring and shared UX/state paths.

## Architecture Overview
- Registry: `src/channels/plugins/index.ts` owns the plugin list.
- Channel dock: `src/channels/dock.ts` owns lightweight channel metadata used by shared flows (reply, command auth, block streaming) without importing full plugins.
- IDs/aliases: `src/channels/registry.ts` owns stable channel ids + input aliases.
- Shape: `src/channels/plugins/types.ts` defines the plugin contract.
- Gateway: `src/gateway/server-channels.ts` drives start/stop + runtime snapshots via plugins.
- Outbound: `src/infra/outbound/deliver.ts` routes through plugin outbound when present.
- Outbound delivery loads **outbound adapters** on-demand via `src/channels/plugins/outbound/load.ts` (avoid importing heavy channel plugins on hot paths).
- Reload: `src/gateway/config-reload.ts` uses plugin `reload.configPrefixes` lazily (avoid init cycles).
- CLI: `src/commands/channels/*` uses plugin list for add/remove/status/list.
- Protocol: `src/gateway/protocol/schema.ts` keeps `channels.status` schema-light (maps keyed by channel id).

## Plugin Contract (high-level)
Each `ChannelPlugin` bundles:
- `meta`: id/labels/docs/sort order.
- `capabilities`: chatTypes + optional features (polls, media, nativeCommands, etc.).
- `config`: list/resolve/default/isConfigured/describeAccount + isEnabled + (un)configured reasons + `resolveAllowFrom` + `formatAllowFrom`.
- `outbound`: deliveryMode + chunker + resolveTarget (mode-aware) + sendText/sendMedia/sendPoll + pollMaxOptions.
- `status`: defaultRuntime + probe/audit/buildAccountSnapshot + buildChannelSummary + logSelfId + collectStatusIssues.
- `gateway`: startAccount/stopAccount with runtime context (`getStatus`/`setStatus`), plus optional `loginWithQrStart/loginWithQrWait` for gateway-owned QR login flows.
- `security`: dmPolicy + allowFrom hints used by `doctor security`.
- `heartbeat`: optional readiness checks + heartbeat recipient resolution when channels own targeting.
- `auth`: optional login hook used by `clawdbot channels login`.
- `reload`: `configPrefixes` that map to hot restarts.
- `onboarding`: optional CLI onboarding adapter (wizard UI hooks per channel).
- `agentTools`: optional channel-owned agent tools (ex: QR login).

## Key Integration Notes
- `listChannelPlugins()` is the runtime source of truth for channel UX and wiring.
- Avoid importing `src/channels/plugins/index.ts` from shared modules (reply flow, command auth, sandbox explain). It’s intentionally “heavy” (channels may pull web login / monitor code). Use `getChannelDock()` + `normalizeChannelId()` (from `src/channels/registry.ts`) for cheap metadata, and only `getChannelPlugin()` at execution boundaries (ex: `src/auto-reply/reply/route-reply.ts`).
- WhatsApp plugin keeps Baileys-heavy login bits behind lazy imports; cheap auth file checks live in `src/web/auth-store.ts` (so outbound routing doesn’t pay Baileys import cost).
- `routeReply` delegates sending to plugin `outbound` adapters via a lazy import of `src/infra/outbound/deliver.ts` (so adding a channel is “just implement outbound adapter”, no router switches).
- Avoid static imports of channel monitors inside plugin modules. Monitors typically import the reply pipeline, which can create ESM cycles (and break Vite/Vitest SSR with TDZ errors). Prefer lazy imports inside `gateway.startAccount`.
- Debug cycle leaks quickly with: `npx -y madge --circular src/channels/plugins/index.ts`.
- Protocol v3: `channels.status` is map-based and schema-light so new channels can ship without protocol updates.
- `DEFAULT_CHAT_CHANNEL` lives in `src/channels/registry.ts` and is used anywhere we need a fallback delivery surface.
- Channel reload rules are computed lazily to avoid static init cycles in tests.
- Signal/iMessage media size limits are resolved inside their plugins.
- `normalizeChannelId()` handles aliases (ex: `imsg`, `teams`) so CLI and API inputs stay stable.
- Gateway runtime snapshot (`getRuntimeSnapshot`) is map-based: `{ channels, channelAccounts }` (no `${id}Accounts` keys).
- `channels.status` response keys (v3):
  - `channelOrder: string[]`
  - `channelLabels: Record<string, string>`
  - `channels: Record<string, unknown>` (channel summary objects, plugin-defined)
  - `channelAccounts: Record<string, ChannelAccountSnapshot[]>`
  - `channelDefaultAccountId: Record<string, string>`
- `channels.status` summary objects come from `status.buildChannelSummary` (no per-channel branching in the handler).
- `channels.status` warnings flow through `status.collectStatusIssues` per plugin.
- CLI list uses `meta.showConfigured` to decide whether to show configured state.
- CLI channel options and prompt channel lists are generated from `listChannelPlugins()` (avoid hardcoded arrays).
- Channel selection (`resolveMessageChannelSelection`) inspects `config.isEnabled` + `config.isConfigured` per plugin instead of hardcoded checks.
- Pairing flows (CLI + store) use `plugin.pairing` (`idLabel`, `normalizeAllowEntry`, `notifyApproval`) via `src/channels/plugins/pairing.ts`.
- CLI channel remove/disable delegates to `config.setAccountEnabled` + `config.deleteAccount` per plugin.
- CLI channel add delegates to `plugin.setup` for account validation, naming, and config writes (no hardcoded checks).
- Agent channel status entries are built from plugin config/status (`status.resolveAccountState` for custom state labels).
- Agent binding defaults use `meta.forceAccountBinding` to avoid hardcoded checks.
- Onboarding quickstart allowlist uses `meta.quickstartAllowFrom` to avoid hardcoded channel lists.
- `resolveChannelDefaultAccountId()` is the shared helper for picking default accounts from `accountIds` + plugin config.
- `routeReply` uses plugin outbound senders; `ChannelOutboundContext` supports `replyToId` + `threadId` and outbound delivery supports `abortSignal` for cooperative cancellation.
- Outbound target resolution (`resolveOutboundTarget`) delegates to `plugin.outbound.resolveTarget` (mode-aware, uses config allowlists when present).
- Outbound delivery results accept `meta` for channel-specific fields to avoid core type churn in new plugins.
- Agent gateway routing sets `deliveryTargetMode` and uses `resolveOutboundTarget` for implicit fallback targets when `to` is missing.
- Elevated tool allowlists (`tools.elevated.allowFrom`) are a record keyed by channel id (no schema update needed when adding channels).
- Block streaming defaults live on the plugin (`capabilities.blockStreaming`, `streaming.blockStreamingCoalesceDefaults`) instead of hardcoded channel checks.
- Channel logout routes through `channels.logout` using `gateway.logoutAccount` on each plugin (clients should call the generic method).
- Gateway message-channel normalization uses `src/channels/registry.ts` for cheap validation/normalization without plugin init cycles.
- Group mention gating now flows through `plugin.groups.resolveRequireMention` (Discord/Slack/Telegram/WhatsApp/iMessage) instead of branching in reply handlers.
- Command authorization uses `config.resolveAllowFrom` + `config.formatAllowFrom`, with `commands.enforceOwnerForCommands` and `commands.skipWhenConfigEmpty` driving channel-specific behavior.
- Security warnings (`doctor security`) use `plugin.security.resolveDmPolicy` + `plugin.security.collectWarnings`; supply `policyPath` + `allowFromPath` for accurate config hints.
- Reply threading uses `plugin.threading.resolveReplyToMode` and `plugin.threading.allowTagsWhenOff` rather than channel switches in reply helpers.
- Tool auto-threading context flows through `plugin.threading.buildToolContext` (e.g., Slack threadTs injection).
- Messaging tool dedupe now relies on `plugin.messaging.normalizeTarget` for channel-specific target normalization.
- Message tool + CLI action dispatch now use `plugin.actions.listActions` + `plugin.actions.handleAction`; use `plugin.actions.supportsAction` for dispatch-only gating when you still want fallback send/poll.
- Session announce targets can opt into `meta.preferSessionLookupForAnnounceTarget` when session keys are insufficient (e.g., WhatsApp).
- Onboarding channel setup is delegated to adapter modules under `src/channels/plugins/onboarding/*`, keeping `setupChannels` channel-agnostic.
- Onboarding registry now reads `plugin.onboarding` from each channel (no standalone onboarding map).
- Channel login flows (`clawdbot channels login`) route through `plugin.auth.login` when available.
- `clawdbot status` reports `linkChannel` (derived from `status.buildChannelSummary().linked`) instead of a hardcoded `web` field.
- Gateway `web.login.*` methods use `plugin.gatewayMethods` ownership to pick the channel (no hardcoded `normalizeChannelId("web")` in the handler).

## CLI Commands (inline references)
- Add/remove channels: `clawdbot channels add <channel>` / `clawdbot channels remove <channel>`.
- Inspect channel state: `clawdbot channels list`, `clawdbot channels status`.
- Link/unlink channels: `clawdbot channels login --channel <channel>` / `clawdbot channels logout --channel <channel>`.
- Pairing approvals: `clawdbot pairing list <channel>`, `clawdbot pairing approve <channel> <code>`.

## Adding a Channel (checklist)
1) Create `src/channels/plugins/<id>.ts` exporting `ChannelPlugin`.
2) Register in `src/channels/plugins/index.ts` and update `src/channels/registry.ts` (ids/aliases/meta) if needed.
3) Add a dock entry in `src/channels/dock.ts` for any shared behavior (capabilities, allowFrom format/resolve, mention stripping, threading, streaming chunk defaults).
4) Add `reload.configPrefixes` for hot reload when config changes.
5) Delegate to existing channel modules (send/probe/monitor) or create them.
6) If you changed the gateway protocol: run `pnpm protocol:check` (updates `dist/protocol.schema.json` + `apps/macos/Sources/ClawdbotProtocol/GatewayModels.swift`).
7) Update docs/tests for any behavior changes.

## Cleanup Expectations
- Keep plugin files small; move heavy logic into channel modules.
- Prefer shared helpers over V2 copies.
- Update docs when behavior/inputs change.
