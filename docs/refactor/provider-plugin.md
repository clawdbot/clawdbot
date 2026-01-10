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
- `heartbeat`: optional readiness checks (e.g., WhatsApp linked + running).
- `reload`: `configPrefixes` that map to hot restarts.

## Key Integration Notes
- `listProviderPlugins()` is the runtime source of truth for provider UX and wiring.
- Gateway protocol schema + system prompt use `PROVIDER_IDS` (static list) to avoid plugin init cycles; keep it in sync with the plugin registry.
- `DEFAULT_CHAT_PROVIDER` lives in `src/providers/registry.ts` and is used anywhere we need a fallback delivery surface.
- Provider reload rules are computed lazily to avoid static init cycles in tests.
- Signal/iMessage media size limits are now resolved inside their plugins.
- `normalizeProviderId()` handles aliases (ex: `imsg`, `teams`) so CLI and API inputs stay stable.
- Gateway runtime defaults (`status.defaultRuntime`) replace the old per-provider runtime map.
- `providers.status` summary objects now come from `status.buildProviderSummary` (no per-provider branching in the handler).
- `providers.status` warnings now flow through `status.collectStatusIssues` per plugin.
- CLI list uses `meta.showConfigured` to decide whether to show configured state.
- CLI provider options and prompt provider lists are generated from `listProviderPlugins()` (avoid hardcoded arrays).
- Pairing flows (CLI + store) now use `plugin.pairing` (`idLabel`, `normalizeAllowEntry`, `notifyApproval`) via `src/providers/plugins/pairing.ts`.
- CLI provider remove/disable delegates to `config.setAccountEnabled` + `config.deleteAccount` per plugin.
- Onboarding quickstart allowlist uses `meta.quickstartAllowFrom` to avoid hardcoded provider lists.
- `routeReply` now uses plugin outbound senders; `ProviderOutboundContext` includes `replyToId` + `threadId` for threading support.
- Provider logout now routes through `providers.logout` using `gateway.logoutAccount` on each plugin (clients should call the generic method).
- WhatsApp web login aliases are handled by the plugin (`meta.aliases: ["web"]`) so gateway API inputs can stay stable.
- Gateway message-provider normalization uses registry aliases (including `web`) so CLI/API inputs stay stable without plugin init cycles.

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
