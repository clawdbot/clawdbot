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
- `capabilities`: chatTypes + optional features (polls, media, etc.).
- `config`: list/resolve/default/isConfigured/describeAccount + isEnabled + (un)configured reasons.
- `outbound`: deliveryMode + chunker + resolveTarget + sendText/sendMedia/sendPoll + pollMaxOptions.
- `status`: defaultRuntime + probe/audit/buildAccountSnapshot + buildProviderSummary.
- `gateway`: startAccount/stopAccount with runtime context (`getStatus`/`setStatus`).
- `reload`: `configPrefixes` that map to hot restarts.

## Key Integration Notes
- `listProviderPlugins()` is now the single source of truth for provider UX and wiring.
- Provider reload rules are computed lazily to avoid static init cycles in tests.
- Outbound path still preserves Signal/iMessage media maxBytes (wrapped deps), even when using plugin outbound.
- `normalizeProviderId()` handles aliases (ex: `imsg`, `teams`) so CLI and API inputs stay stable.
- Gateway runtime defaults (`status.defaultRuntime`) replace the old per-provider runtime map.
- `providers.status` summary objects now come from `status.buildProviderSummary` (no per-provider branching in the handler).
- CLI list uses `meta.showConfigured` to decide whether to show configured state.

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
