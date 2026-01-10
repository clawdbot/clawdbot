---
summary: "Provider plugin refactor implementation notes (registry, status, gateway/runtime)"
read_when:
  - Adding or refactoring provider plugin wiring
  - Moving provider-specific behavior into plugin hooks
---

# Provider Plugin Refactor — Implementation Notes

Goal: make providers (iMessage, Discord, etc.) pluggable with minimal wiring and shared UX/state paths.

## Architecture Overview
- Registry: `src/providers/plugins/index.ts` owns the plugin list.
- Provider dock: `src/providers/dock.ts` owns lightweight provider metadata used by shared flows (reply, command auth, block streaming) without importing full plugins.
- IDs/aliases: `src/providers/registry.ts` owns stable provider ids + input aliases.
- Shape: `src/providers/plugins/types.ts` defines the plugin contract.
- Gateway: `src/gateway/server-providers.ts` drives start/stop + runtime snapshots via plugins.
- Outbound: `src/infra/outbound/deliver.ts` routes through plugin outbound when present.
- Reload: `src/gateway/config-reload.ts` uses plugin `reload.configPrefixes` lazily (avoid init cycles).
- CLI: `src/commands/providers/*` uses plugin list for add/remove/status/list.
- Protocol: `src/gateway/protocol/schema.ts` (v3) makes provider-shaped responses container-generic (maps keyed by provider id).

## Plugin Contract (high-level)
Each `ProviderPlugin` bundles:
- `meta`: id/labels/docs/sort order.
- `capabilities`: chatTypes + optional features (polls, media, nativeCommands, etc.).
- `config`: list/resolve/default/isConfigured/describeAccount + isEnabled + (un)configured reasons + `resolveAllowFrom` + `formatAllowFrom`.
- `outbound`: deliveryMode + chunker + resolveTarget (mode-aware) + sendText/sendMedia/sendPoll + pollMaxOptions.
- `status`: defaultRuntime + probe/audit/buildAccountSnapshot + buildProviderSummary + logSelfId + collectStatusIssues.
- `gateway`: startAccount/stopAccount with runtime context (`getStatus`/`setStatus`), plus optional `loginWithQrStart/loginWithQrWait` for gateway-owned QR login flows.
- `security`: dmPolicy + allowFrom hints used by `doctor security`.
- `heartbeat`: optional readiness checks + heartbeat recipient resolution when providers own targeting.
- `auth`: optional login hook used by `clawdbot providers login`.
- `reload`: `configPrefixes` that map to hot restarts.
- `onboarding`: optional CLI onboarding adapter (wizard UI hooks per provider).
- `agentTools`: optional provider-owned agent tools (ex: QR login).

## Key Integration Notes
- `listProviderPlugins()` is the runtime source of truth for provider UX and wiring.
- Avoid importing `src/providers/plugins/index.ts` from shared modules (reply flow, command auth, sandbox explain). It’s intentionally “heavy” (providers may pull web login / monitor code). Use `getProviderDock()` + `normalizeProviderId()` for cheap metadata, and only `getProviderPlugin()` at execution boundaries (ex: `src/auto-reply/reply/route-reply.ts`).
- Avoid static imports of provider monitors inside plugin modules. Monitors typically import the reply pipeline, which can create ESM cycles (and break Vite/Vitest SSR with TDZ errors). Prefer lazy imports inside `gateway.startAccount`.
- Debug cycle leaks quickly with: `npx -y madge --circular src/providers/plugins/index.ts`.
- Gateway protocol schema keeps provider selection as an open-ended string (no provider enum / static list) to avoid init cycles and so new plugins don’t require protocol changes.
- Protocol v3: no more per-provider fields in `providers.status`; consumers must read map entries by provider id.
- `DEFAULT_CHAT_PROVIDER` lives in `src/providers/registry.ts` and is used anywhere we need a fallback delivery surface.
- Provider reload rules are computed lazily to avoid static init cycles in tests.
- Signal/iMessage media size limits are now resolved inside their plugins.
- `normalizeProviderId()` handles aliases (ex: `imsg`, `teams`) so CLI and API inputs stay stable.
- `ProviderId` is `ChatProviderId` (no extra special-cased provider IDs in shared code).
- Gateway runtime defaults (`status.defaultRuntime`) replace the old per-provider runtime map.
- Gateway runtime snapshot (`getRuntimeSnapshot`) is map-based: `{ providers, providerAccounts }` (no `${id}Accounts` keys).
- `providers.status` response keys (v3):
  - `providerOrder: string[]`
  - `providerLabels: Record<string, string>`
  - `providers: Record<string, unknown>` (provider summary objects, plugin-defined)
  - `providerAccounts: Record<string, ProviderAccountSnapshot[]>`
  - `providerDefaultAccountId: Record<string, string>`
- `providers.status` summary objects come from `status.buildProviderSummary` (no per-provider branching in the handler).
- `providers.status` warnings now flow through `status.collectStatusIssues` per plugin.
- CLI list uses `meta.showConfigured` to decide whether to show configured state.
- CLI provider options and prompt provider lists are generated from `listProviderPlugins()` (avoid hardcoded arrays).
- Provider selection (`resolveMessageProviderSelection`) now inspects `config.isEnabled` + `config.isConfigured` per plugin instead of hardcoded provider checks.
- Pairing flows (CLI + store) now use `plugin.pairing` (`idLabel`, `normalizeAllowEntry`, `notifyApproval`) via `src/providers/plugins/pairing.ts`.
- CLI provider remove/disable delegates to `config.setAccountEnabled` + `config.deleteAccount` per plugin.
- CLI provider add now delegates to `plugin.setup` for account validation, naming, and config writes (no hardcoded provider checks).
- Agent provider status entries are now built from plugin config/status (`status.resolveAccountState` for custom state labels).
- Agent binding defaults use `meta.forceAccountBinding` to avoid hardcoded provider checks.
- Onboarding quickstart allowlist uses `meta.quickstartAllowFrom` to avoid hardcoded provider lists.
- `resolveProviderDefaultAccountId()` is the shared helper for picking default accounts from `accountIds` + plugin config.
- `routeReply` now uses plugin outbound senders; `ProviderOutboundContext` includes `replyToId` + `threadId` for threading support.
- Outbound target resolution (`resolveOutboundTarget`) now delegates to `plugin.outbound.resolveTarget` (mode-aware, uses config allowlists when present).
- Outbound delivery results accept `meta` for provider-specific fields to avoid core type churn in new plugins.
- Agent gateway routing sets `deliveryTargetMode` and uses `resolveOutboundTarget` for implicit fallback targets when `to` is missing.
- Elevated tool allowlists (`tools.elevated.allowFrom`) are a record keyed by provider id (no schema update needed when adding providers).
- Block streaming defaults live on the plugin (`capabilities.blockStreaming`, `streaming.blockStreamingCoalesceDefaults`) instead of hardcoded provider checks.
- Provider logout now routes through `providers.logout` using `gateway.logoutAccount` on each plugin (clients should call the generic method).
- Gateway message-provider normalization uses `src/providers/registry.ts` for cheap validation/normalization without plugin init cycles.
- Group mention gating now flows through `plugin.groups.resolveRequireMention` (Discord/Slack/Telegram/WhatsApp/iMessage) instead of branching in reply handlers.
- Command authorization uses `config.resolveAllowFrom` + `config.formatAllowFrom`, with `commands.enforceOwnerForCommands` and `commands.skipWhenConfigEmpty` driving provider-specific behavior.
- Security warnings (`doctor security`) use `plugin.security.resolveDmPolicy` + `plugin.security.collectWarnings`; supply `policyPath` + `allowFromPath` for accurate config hints.
- Reply threading uses `plugin.threading.resolveReplyToMode` and `plugin.threading.allowTagsWhenOff` rather than provider switches in reply helpers.
- Tool auto-threading context flows through `plugin.threading.buildToolContext` (e.g., Slack threadTs injection).
- Messaging tool dedupe now relies on `plugin.messaging.normalizeTarget` for provider-specific target normalization.
- Message tool + CLI action dispatch now use `plugin.actions.listActions` + `plugin.actions.handleAction`; use `plugin.actions.supportsAction` for dispatch-only gating when you still want fallback send/poll.
- Session announce targets can opt into `meta.preferSessionLookupForAnnounceTarget` when session keys are insufficient (e.g., WhatsApp).
- Onboarding provider setup is delegated to adapter modules under `src/providers/plugins/onboarding/*`, keeping `setupProviders` provider-agnostic.
- Onboarding registry now reads `plugin.onboarding` from each provider (no standalone onboarding map).
- Provider login flows (`clawdbot providers login`) route through `plugin.auth.login` when available.
- `clawdbot status` reports `linkProvider` (derived from `status.buildProviderSummary().linked`) instead of a hardcoded `web` provider field.
- Gateway `web.login.*` methods use `plugin.gatewayMethods` ownership to pick the provider (no hardcoded `normalizeProviderId("web")` in the handler).

## CLI Commands (inline references)
- Add/remove providers: `clawdbot providers add <provider>` / `clawdbot providers remove <provider>`.
- Inspect provider state: `clawdbot providers list`, `clawdbot providers status`.
- Link/unlink providers: `clawdbot providers login --provider <provider>` / `clawdbot providers logout --provider <provider>`.
- Pairing approvals: `clawdbot pairing list <provider>`, `clawdbot pairing approve <provider> <code>`.

## Adding a Provider (checklist)
1) Create `src/providers/plugins/<id>.ts` exporting `ProviderPlugin`.
2) Register in `src/providers/plugins/index.ts` and update `src/providers/registry.ts` (ids/aliases/meta) if needed.
3) Add a dock entry in `src/providers/dock.ts` for any shared behavior (capabilities, allowFrom format/resolve, mention stripping, threading, streaming chunk defaults).
4) Add `reload.configPrefixes` for hot reload when config changes.
5) Delegate to existing provider modules (send/probe/monitor) or create them.
6) If you changed the gateway protocol: run `pnpm protocol:check` (updates `dist/protocol.schema.json` + `apps/macos/Sources/ClawdbotProtocol/GatewayModels.swift`).
7) Update docs/tests for any behavior changes.

## Cleanup Expectations
- Keep plugin files small; move heavy logic into provider modules.
- Prefer shared helpers over V2 copies.
- Update docs when behavior/inputs change.
