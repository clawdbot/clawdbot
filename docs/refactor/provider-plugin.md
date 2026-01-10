---
summary: "Provider plugin refactor implementation notes (registry, status, gateway/runtime)"
read_when:
  - Adding or refactoring provider plugin wiring
  - Moving provider-specific behavior into plugin hooks
---

# Provider Plugin Refactor — Implementation Notes

Goal: make providers (iMessage, Discord, etc.) pluggable with minimal wiring and shared UX/state paths.

## Architecture Overview
- Registry: `src/providers/plugins/index.ts` owns the plugin list + aliases.
- Shape: `src/providers/plugins/types.ts` defines the plugin contract.
- Gateway: `src/gateway/server-providers.ts` drives start/stop + runtime snapshots via plugins.
- Outbound: `src/infra/outbound/deliver.ts` routes through plugin outbound when present.
- Reload: `src/gateway/config-reload.ts` uses plugin `reload.configPrefixes` lazily (avoid init cycles).
- CLI: `src/commands/providers/*` uses plugin list for add/remove/status/list.

## Plugin Contract (high-level)
Each `ProviderPlugin` bundles:
- `meta`: id/labels/docs/aliases/sort order.
- `capabilities`: chatTypes + optional features (polls, media, nativeCommands, etc.).
- `config`: list/resolve/default/isConfigured/describeAccount + isEnabled + (un)configured reasons + `resolveAllowFrom` + `formatAllowFrom`.
- `outbound`: deliveryMode + chunker + resolveTarget (mode-aware) + sendText/sendMedia/sendPoll + pollMaxOptions.
- `status`: defaultRuntime + probe/audit/buildAccountSnapshot + buildProviderSummary + logSelfId + collectStatusIssues.
- `gateway`: startAccount/stopAccount with runtime context (`getStatus`/`setStatus`).
- `security`: dmPolicy + allowFrom hints used by `doctor security`.
- `heartbeat`: optional readiness checks + heartbeat recipient resolution when providers own targeting.
- `auth`: optional login hook used by `clawdbot providers login`.
- `reload`: `configPrefixes` that map to hot restarts.
- `onboarding`: optional CLI onboarding adapter (wizard UI hooks per provider).
- `agentTools`: optional provider-owned agent tools (ex: QR login).

## Key Integration Notes
- `listProviderPlugins()` is the runtime source of truth for provider UX and wiring.
- Gateway protocol schema keeps provider selection as an open-ended string (no provider enum / static list) to avoid init cycles and so new plugins don’t require protocol changes.
- `DEFAULT_CHAT_PROVIDER` lives in `src/providers/registry.ts` and is used anywhere we need a fallback delivery surface.
- Provider reload rules are computed lazily to avoid static init cycles in tests.
- Signal/iMessage media size limits are now resolved inside their plugins.
- `normalizeProviderId()` handles aliases (ex: `imsg`, `teams`) so CLI and API inputs stay stable.
- `ProviderId` is `ChatProviderId` (no extra special-cased provider IDs in shared code).
- Gateway runtime defaults (`status.defaultRuntime`) replace the old per-provider runtime map.
- Gateway health snapshots now iterate plugins (`status.probeAccount` + `status.buildProviderSummary`) and emit `providers` + `providerOrder` instead of provider-specific fields.
- `providers.status` summary objects now come from `status.buildProviderSummary` (no per-provider branching in the handler).
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
- `routeReply` now uses plugin outbound senders; `ProviderOutboundContext` includes `replyToId` + `threadId` for threading support.
- Outbound target resolution (`resolveOutboundTarget`) now delegates to `plugin.outbound.resolveTarget` (mode-aware, uses config allowlists when present).
- Outbound delivery results accept `meta` for provider-specific fields to avoid core type churn in new plugins.
- Agent gateway routing sets `deliveryTargetMode` and uses `resolveOutboundTarget` for implicit fallback targets when `to` is missing.
- Elevated tool allowlists can fall back to `plugin.elevated.allowFromFallback` (ex: Discord DM allowFrom).
- Block streaming defaults live on the plugin (`capabilities.blockStreaming`, `streaming.blockStreamingCoalesceDefaults`) instead of hardcoded provider checks.
- Provider logout now routes through `providers.logout` using `gateway.logoutAccount` on each plugin (clients should call the generic method).
- WhatsApp web login aliases are handled by the plugin (`meta.aliases: ["web"]`) so gateway API inputs can stay stable.
- Gateway message-provider normalization uses registry aliases (including `web`) so CLI/API inputs stay stable without plugin init cycles.
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

## CLI Commands (inline references)
- Add/remove providers: `clawdbot providers add <provider>` / `clawdbot providers remove <provider>`.
- Inspect provider state: `clawdbot providers list`, `clawdbot providers status`.
- Link/unlink providers: `clawdbot providers login --provider <provider>` / `clawdbot providers logout --provider <provider>`.
- Pairing approvals: `clawdbot pairing list <provider>`, `clawdbot pairing approve <provider> <code>`.

## Adding a Provider (checklist)
1) Create `src/providers/plugins/<id>.ts` exporting `ProviderPlugin`.
2) Register in `src/providers/plugins/index.ts` + aliases if needed.
3) Add `reload.configPrefixes` for hot reload when config changes.
4) Delegate to existing provider modules (send/probe/monitor) or create them.
5) Update docs/tests for any behavior changes.

## Cleanup Expectations
- Keep plugin files small; move heavy logic into provider modules.
- Prefer shared helpers over V2 copies.
- Update docs when behavior/inputs change.
