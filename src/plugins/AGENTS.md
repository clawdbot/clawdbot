# Plugins Boundary

This directory owns plugin discovery, manifest validation, loading, registry
assembly, and contract enforcement.

## Public Contracts

- Docs:
  - `docs/plugins/architecture.md`
  - `docs/plugins/manifest.md`
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
- Definition files:
  - `src/plugins/types.ts`
  - `src/plugins/runtime/types.ts`
  - `src/plugins/contracts/registry.ts`
  - `src/plugins/public-surface-loader.ts`
  - `src/plugins/public-surface-runtime.ts`
  - `src/plugins/provider-public-artifacts.ts`
  - `src/plugins/web-provider-public-artifacts.ts`

## Boundary Rules

- Keep control-plane and runtime-plane concerns separate:
  discovery, manifest parsing, config validation, setup/onboarding hints, and
  activation planning belong to the control plane; actual plugin execution
  belongs to runtime resolution.
- Preserve manifest-first behavior: discovery, config validation, and setup
  should work from metadata before plugin runtime executes.
- Cache concept: metadata stays fresh unless a caller owns an explicit
  `PluginMetadataSnapshot`, `PluginLookUpTable`, or manifest registry for the
  current flow. Do not add persistent metadata caches for discovery, manifest
  registries, installed-index reconstruction, owner lookup, model suppression,
  provider policy, public-artifact metadata, or similar control-plane answers.
  Runtime loader, jiti/module, and dependency-artifact caches are the allowed
  cache layer once code or installed artifacts are actually loaded.
- Keep loader behavior aligned with the documented Plugin SDK and manifest
  contracts. Do not create private backdoors that bundled plugins can use but
  external plugins cannot.
- Preserve laziness in discovery and activation flows. Loader, registry, and
  public-artifact changes must not eagerly import bundled plugin runtime barrels
  when metadata, light exports, or typed contracts are sufficient.
- If a plugin exposes separate light and heavy runtime surfaces, keep discovery,
  inventory, and setup-state checks on the light path until actual execution
  needs the heavy module.
- If a loader or registry change affects plugin authors, update the public SDK,
  docs, and contract tests instead of relying on incidental internals.
- Prefer explicit activation planning from manifest/descriptor ownership over
  “load everything in this scope” behavior. Broad registry materialization
  should be the exception, not the design center.
- Do not normalize "plugin-owned" into "core-owned" by scattering direct reads
  of `plugins.entries.<id>.config` through unrelated core paths. Prefer generic
  helpers, plugin runtime hooks, manifest metadata, and explicit auto-enable
  wiring.
- When plugin-owned tools or provider fallbacks need core participation, keep
  the contract generic and honor plugin disablement plus SecretRef semantics.
- Keep contract loading and contract tests on the dedicated bundled registry
  path. Do not make contract validation depend on activating providers through
  unrelated production resolution flows.
- Prefer shared provider-family helpers over ad hoc policy in plugin registry
  hooks. If multiple providers need the same replay policy, tool compat, stream
  wrapper composition, or payload patch behavior, centralize that helper before
  adding another plugin-local lambda.
- Keep provider policy layers separated:
  auth/catalog/onboarding stay plugin-owned,
  transport/replay/tool compat families belong in shared helpers,
  registry/runtime code should compose those layers rather than re-encoding
  policy inline.
- When a provider hook grows a nested chain of wrapper composition or repeated
  compat flags, treat that as a regression signal. Extract the shared helper or
  composer instead of letting one more plugin carry a near-copy.
- Treat mutable global runtime registry state as compatibility scaffolding, not
  the desired source of truth for request-time execution. Prefer immutable or
  request-scoped handles when adding new runtime flows.
- If setup, discovery, or doctor flows need plugin runtime, make that need
  explicit and narrow. Do not let cold control-plane paths quietly import broad
  runtime surfaces.
- Resolver and public-surface loader tests must use generated tiny plugin
  fixtures for broad `api.js` / `runtime-api.js` fallback behavior. Do not point
  those tests at real bundled plugin source APIs just to prove path resolution.

## Verification

- If you touch loader, registry, activation, or public-artifact code that can
  change bundled plugin import fanout, run `pnpm build`.
- If the change can alter bundled plugin startup cost, re-profile the affected
  plugin entrypoint with:
  `OPENCLAW_LOCAL_CHECK=0 node scripts/profile-extension-memory.mjs --extension <id> --skip-combined --concurrency 1`
