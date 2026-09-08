---
summary: "Plugin and channel contract test commands, categories, and when to run them"
title: "Contract tests"
read_when:
  - You changed a channel, provider, or plugin-sdk surface
---

## Contract tests (plugin and channel shape)

Contract tests verify that every registered plugin and channel conforms to
its interface contract. They iterate over all discovered plugins and run a
suite of shape and behavior assertions. The default `pnpm test` unit lane
intentionally skips these shared seam and smoke files; run the contract
commands explicitly when you touch shared channel or provider surfaces.

### Commands

- All contracts: `pnpm test:contracts`
- Channel contracts only: `pnpm test:contracts:channels`
- Provider contracts only: `pnpm test:contracts:plugins`

### Channel contracts

Located in `src/channels/plugins/contracts/*.contract.test.ts`. Current
top-level categories:

- **channel-catalog** - bundled/registry channel catalog entry metadata
- **plugin** (registry-backed, sharded) - basic plugin registration shape
- **surfaces-only** (registry-backed, sharded) - per-surface shape checks for `actions`, `setup`, `status`, `outbound`, `messaging`, `threading`, `directory`, and `gateway`
- **session-binding** (registry-backed) - session binding behavior
- **outbound-payload** - message payload structure and normalization
- **group-policy** (fallback) - default group policy enforcement per channel
- **threading** (registry-backed, sharded) - thread id handling
- **directory** (registry-backed, sharded) - directory/roster API
- **registry** and **plugins-core.\*** - channel plugin registry, loader, and config-write authorization internals

Inbound dispatch-capture and outbound-payload harness helpers used by these
suites are exposed internally through `src/plugin-sdk/channel-contract-testing.ts`
(npm-excluded, not a public SDK subpath); there is no standalone
`inbound.contract.test.ts` file in this directory.

### Provider contracts

Located in `src/plugins/contracts/*.contract.test.ts`. Current categories
include:

- **shape** - plugin manifest, API, and runtime export shape
- **plugin-registration** (+ parallel) - manifest registration cases
- **package-manifest** - package manifest requirements
- **loader** - plugin loader setup/teardown behavior
- **registry** - plugin contract registry contents and lookup
- **providers** - shared provider behavior across bundled providers, plus web-search providers
- **auth-choice** - auth choice metadata and setup behavior
- **provider-catalog-deprecation** - deprecated provider catalog metadata
- **wizard.choice-resolution**, **wizard.model-picker**, **wizard.setup-options** - provider setup wizard contracts
- **embedding-provider**, **memory-embedding-provider**, **web-fetch-provider**, **tts** - capability-specific provider contracts
- **session-actions**, **session-attachments**, **session-entry-projection** - plugin-owned session state contracts
- **scheduled-turns** - plugin scheduled turn metadata and timestamp bounds
- **host-hooks**, **run-context-lifecycle**, **runtime-import-side-effects**, **runtime-seams** - plugin host/runtime lifecycle and import-boundary contracts
- **extension-runtime-dependencies** - runtime dependency placement for extensions

### When to run

- After changing plugin-sdk exports or subpaths
- After adding or modifying a channel or provider plugin
- After refactoring plugin registration or discovery

Contract tests run in CI and do not require real API keys.
