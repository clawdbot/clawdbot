---
summary: "Plugin SDK subpath catalog: which imports live where, grouped by area"
read_when:
  - Choosing the right plugin-sdk subpath for a plugin import
  - Auditing bundled-plugin subpaths and helper surfaces
title: "Plugin SDK subpaths"
---

The plugin SDK is exposed as a set of narrow public subpaths under
`openclaw/plugin-sdk/`. This page catalogs the commonly used subpaths grouped by
purpose. Three files define the surface:

- `scripts/lib/plugin-sdk-entrypoints.json`: the maintained entrypoint inventory
  the build compiles.
- `scripts/lib/plugin-sdk-private-local-only-subpaths.json`: repo-local
  test/internal subpaths. Package exports are the inventory minus this list.
- `src/plugin-sdk/entrypoints.ts`: classification metadata for deprecated
  subpaths, reserved bundled helpers, supported bundled facades, and
  plugin-owned public surfaces.

Maintainers audit the public export count with `pnpm plugin-sdk:surface` and
active reserved helper subpaths with `pnpm plugins:boundary-report:summary`;
unused reserved helper exports fail the CI report instead of staying in the
public SDK as dormant compatibility debt.

For the plugin authoring guide, see [Plugin SDK overview](/plugins/sdk-overview).

## Plugin entry

| Subpath                        | Key exports                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry`      | `definePluginEntry`                                                                                                                                                    |
| `plugin-sdk/core`              | `defineChannelPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `defineSetupPluginEntry`, `buildChannelConfigSchema`, `buildJsonChannelConfigSchema` |
| `plugin-sdk/provider-entry`    | `defineSingleProviderPluginEntry`                                                                                                                                      |
| `plugin-sdk/migration`         | Migration provider item helpers such as `createMigrationItem`, reason constants, item status markers, redaction helpers, and `summarizeMigrationItems`                 |
| `plugin-sdk/migration-runtime` | Runtime migration helpers such as `copyMigrationFileItem`, `resolvePlannedMigrationTargets`, `withCachedMigrationConfigRuntime`, and `writeMigrationReport`            |
| `plugin-sdk/health`            | Doctor health-check registration, detection, repair, selection, severity, and finding types for bundled health consumers                                               |
| `plugin-sdk/config-schema`     | Deprecated. Root `openclaw.json` Zod schema (`OpenClawSchema`); define plugin-local schemas instead and validate with `plugin-sdk/json-schema-runtime`                 |

### Deprecated compatibility and test helpers

Deprecated subpaths stay exported for older plugins, but new code should use the
focused SDK subpaths below. The maintained list is
`scripts/lib/plugin-sdk-deprecated-public-subpaths.json`; CI rejects bundled
production imports from it. Broad barrels such as `plugin-sdk/compat`,
`plugin-sdk/config-types`, `plugin-sdk/infra-runtime`, and
`plugin-sdk/text-runtime` are compatibility only, and `plugin-sdk/zod` is a
compatibility re-export: import `zod` directly from `zod`. The broad domain
barrels `plugin-sdk/agent-runtime`, `plugin-sdk/channel-lifecycle`,
`plugin-sdk/channel-runtime`, `plugin-sdk/cli-runtime`,
`plugin-sdk/conversation-runtime`, `plugin-sdk/hook-runtime`,
`plugin-sdk/media-runtime`, `plugin-sdk/plugin-runtime`, and
`plugin-sdk/security-runtime` are likewise deprecated in favor of focused
subpaths.

OpenClaw's Vitest-backed test-helper subpaths are repo-local only and are no
longer package exports: `agent-runtime-test-contracts`,
`channel-contract-testing`, `channel-target-testing`, `channel-test-helpers`,
`plugin-state-test-runtime`, `plugin-test-api`, `plugin-test-contracts`,
`plugin-test-runtime`, `provider-http-test-mocks`, `provider-test-contracts`,
`reply-payload-testing`, `sqlite-runtime-testing`, `test-env`, `test-fixtures`,
`test-node-mocks`, and `testing`. The private bundled helper surfaces
`ssrf-runtime-internal` and `codex-native-task-runtime` are also repo-local
only.

### Reserved bundled plugin helper subpaths

`plugin-sdk/codex-mcp-projection` is the only reserved subpath: a plugin-owned
compatibility surface for the bundled Codex plugin, not a general SDK API.
Cross-owner plugin imports are blocked by package contract guardrails, and
CI fails when a reserved subpath stops being imported.
`plugin-sdk/codex-native-task-runtime` is repo-local only and is not a package
export.

`src/plugin-sdk/entrypoints.ts` also tracks supported bundled facades, SDK
entrypoints backed by their bundled plugin until generic contracts replace
them: `plugin-sdk/discord`, `plugin-sdk/lmstudio`, `plugin-sdk/lmstudio-runtime`,
`plugin-sdk/matrix`, `plugin-sdk/mattermost`,
`plugin-sdk/memory-core-engine-runtime`, `plugin-sdk/provider-zai-endpoint`,
`plugin-sdk/qa-runner-runtime`, `plugin-sdk/telegram-account`,
`plugin-sdk/tts-runtime`, and `plugin-sdk/zalouser`. Several of these are also
deprecated for new code; see the per-row notes below.

<AccordionGroup>
  <Accordion title="Channel subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/channel-core` | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase` |
    | `plugin-sdk/json-schema-runtime` | Cached JSON Schema validation helper for plugin-owned schemas |
    | `plugin-sdk/channel-setup` | `createOptionalChannelSetupSurface`, `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`, plus `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`, `setSetupChannelEnabled`, `splitSetupEntries` |
    | `plugin-sdk/setup` | Shared setup wizard helpers, setup translator, allowlist prompts, setup status builders |
    | `plugin-sdk/setup-runtime` | `createSetupTranslator`, `createPatchedAccountSetupAdapter`, `createEnvPatchedAccountSetupAdapter`, `createSetupInputPresenceValidator`, `noteChannelLookupFailure`, `noteChannelLookupSummary`, `promptResolvedAllowFrom`, `splitSetupEntries`, `createAllowlistSetupWizardProxy`, `createDelegatedSetupWizardProxy` |
    | `plugin-sdk/setup-adapter-runtime` | Deprecated compatibility alias; use `plugin-sdk/setup-runtime` |
    | `plugin-sdk/setup-tools` | `formatCliCommand`, `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`, `CONFIG_DIR` |
    | `plugin-sdk/account-core` | Multi-account config/action-gate helpers, default-account fallback helpers |
    | `plugin-sdk/account-id` | `DEFAULT_ACCOUNT_ID`, account-id normalization helpers |
    | `plugin-sdk/account-resolution` | Account lookup + default-fallback helpers |
    | `plugin-sdk/account-helpers` | Narrow account-list/account-action helpers |
    | `plugin-sdk/access-groups` | Access-group allowlist parsing and redacted group diagnostics helpers |
    | `plugin-sdk/channel-pairing` | `createChannelPairingController` |
    | `plugin-sdk/channel-reply-pipeline` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter`, `resolveChannelDmAccess`, `resolveChannelDmAllowFrom`, `resolveChannelDmPolicy`, `normalizeChannelDmPolicy`, `normalizeLegacyDmAliases` |
    | `plugin-sdk/channel-config-schema` | Shared channel config schema primitives plus Zod and direct JSON/TypeBox builders |
    | `plugin-sdk/bundled-channel-config-schema` | Bundled OpenClaw channel config schemas for maintained bundled plugins only |
    | `plugin-sdk/chat-channel-ids` | `BUNDLED_CHAT_CHANNEL_IDS`, `BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES`, `ChatChannelId`. Canonical bundled/official chat channel ids plus formatter labels/aliases for plugins that need to recognize envelope-prefixed text without hardcoding their own table. |
    | `plugin-sdk/channel-config-schema-legacy` | Deprecated compatibility alias for bundled-channel config schemas |
    | `plugin-sdk/telegram-command-config` | Deprecated Telegram command-name/description normalization and duplicate/conflict checks; use plugin-local command config handling in new plugin code |
    | `plugin-sdk/command-gating` | Narrow command authorization gate helpers |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-ingress` | Low-level channel ingress compatibility surface. New receive paths should use `plugin-sdk/channel-ingress-runtime`. |
    | `plugin-sdk/channel-ingress-runtime` | Experimental high-level channel ingress runtime resolver and route fact builders for migrated channel receive paths. Prefer this over assembling effective allowlists, command allowlists, and legacy projections in each plugin. See [Channel ingress API](/plugins/sdk-channel-ingress). |
    | `plugin-sdk/channel-lifecycle` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-outbound` | Message lifecycle contracts plus reply pipeline options, receipts, live preview/streaming, lifecycle helpers, outbound identity, payload planning, durable sends, and message-send context helpers. See [Channel outbound API](/plugins/sdk-channel-outbound). |
    | `plugin-sdk/channel-message` | Deprecated compatibility alias for `plugin-sdk/channel-outbound` plus legacy reply-dispatch facades. |
    | `plugin-sdk/channel-message-runtime` | Deprecated compatibility alias for `plugin-sdk/channel-outbound` plus legacy reply-dispatch facades. |
    | `plugin-sdk/inbound-envelope` | Shared inbound route + envelope builder helpers |
    | `plugin-sdk/inbound-reply-dispatch` | Deprecated compatibility facade. Use `plugin-sdk/channel-inbound` for inbound runners and dispatch predicates, and `plugin-sdk/channel-outbound` for message delivery helpers. |
    | `plugin-sdk/messaging-targets` | Deprecated target parsing alias; use `plugin-sdk/channel-targets` |
    | `plugin-sdk/outbound-media` | Shared outbound media loading and hosted-media state helpers |
    | `plugin-sdk/outbound-send-deps` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/outbound-runtime` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/poll-runtime` | Narrow poll normalization helpers |
    | `plugin-sdk/thread-bindings-runtime` | Thread-binding lifecycle and adapter helpers |
    | `plugin-sdk/agent-media-payload` | Agent media payload roots and loaders |
    | `plugin-sdk/conversation-runtime` | Deprecated broad barrel for conversation/thread binding, pairing, and configured-binding helpers; prefer focused binding subpaths such as `plugin-sdk/thread-bindings-runtime` and `plugin-sdk/session-binding-runtime` |
    | `plugin-sdk/runtime-group-policy` | Runtime group-policy resolution helpers |
    | `plugin-sdk/channel-status` | Shared channel status snapshot/summary helpers |
    | `plugin-sdk/channel-config-primitives` | Narrow channel config-schema primitives |
    | `plugin-sdk/channel-config-writes` | Channel config-write authorization helpers |
    | `plugin-sdk/channel-plugin-common` | Shared channel plugin prelude exports |
    | `plugin-sdk/allowlist-config-edit` | Allowlist config edit/read helpers |
    | `plugin-sdk/group-access` | Deprecated group-access decision helpers; use `resolveChannelMessageIngress` from `plugin-sdk/channel-ingress-runtime` |
    | `plugin-sdk/direct-dm`, `plugin-sdk/direct-dm-access` | Deprecated compatibility facades. Use `plugin-sdk/channel-inbound`. |
    | `plugin-sdk/direct-dm-guard-policy` | Narrow direct-DM pre-crypto guard policy helpers |
    | `plugin-sdk/discord` | Deprecated Discord compatibility facade for published `@openclaw/discord@2026.3.13` and tracked owner compatibility; new plugins should use generic channel SDK subpaths |
    | `plugin-sdk/telegram-account` | Deprecated Telegram account-resolution compatibility facade for tracked owner compatibility; new plugins should use injected runtime helpers or generic channel SDK subpaths |
    | `plugin-sdk/zalouser` | Deprecated Zalo Personal compatibility facade for published Lark/Zalo packages that still import sender command authorization; new plugins should use generic channel SDK subpaths |
    | `plugin-sdk/interactive-runtime` | Semantic message presentation, delivery, and legacy interactive reply helpers. See [Message Presentation](/plugins/message-presentation) |
    | `plugin-sdk/channel-inbound` | Shared inbound helpers for event classification, context building, formatting, roots, debounce, mention matching, mention-policy, and inbound logging |
    | `plugin-sdk/channel-inbound-debounce` | Narrow inbound debounce helpers |
    | `plugin-sdk/channel-mention-gating` | Narrow mention-policy, mention marker, and mention text helpers without the broader inbound runtime surface |
    | `plugin-sdk/channel-envelope`, `plugin-sdk/channel-inbound-roots`, `plugin-sdk/channel-location`, `plugin-sdk/channel-logging` | Deprecated compatibility facades. Use `plugin-sdk/channel-inbound` or `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-pairing-paths` | Deprecated compatibility facade. Use `plugin-sdk/channel-pairing`. |
    | `plugin-sdk/channel-reply-options-runtime` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-streaming` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-send-result` | Reply result types |
    | `plugin-sdk/channel-actions` | Channel message-action helpers, plus deprecated native schema helpers kept for plugin compatibility |
    | `plugin-sdk/channel-route` | Shared route normalization, parser-driven target resolution, thread-id stringification, dedupe/compact route keys, parsed-target types, and route/target comparison helpers |
    | `plugin-sdk/channel-targets` | Target parsing helpers; route comparison callers should use `plugin-sdk/channel-route` |
    | `plugin-sdk/channel-contract` | Channel contract types |
    | `plugin-sdk/channel-feedback` | Feedback/reaction wiring |
  </Accordion>

Deprecated channel helper families stay available only for published-plugin
compatibility. The removal plan is: keep them through the external plugin
migration window, keep repo/bundled plugins on `channel-inbound` and
`channel-outbound`, then remove the compatibility subpaths in the next major
SDK cleanup. This applies to the old channel message/runtime, channel
streaming, direct-DM access, inbound helper splinter, reply-options,
and pairing-path families.

  <Accordion title="Provider subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry` |
    | `plugin-sdk/lmstudio` | Supported LM Studio provider facade for setup, catalog discovery, and runtime model preparation |
    | `plugin-sdk/lmstudio-runtime` | Supported LM Studio runtime facade for local server defaults, model discovery, request headers, and loaded-model helpers |
    | `plugin-sdk/provider-setup` | Curated local/self-hosted provider setup helpers |
    | `plugin-sdk/self-hosted-provider-setup` | Deprecated OpenAI-compatible self-hosted setup helpers; use `plugin-sdk/provider-setup` or plugin-owned setup helpers |
    | `plugin-sdk/cli-backend` | CLI backend defaults + watchdog constants |
    | `plugin-sdk/provider-auth-runtime` | Provider auth runtime helpers: OAuth loopback flow, token exchange, auth persistence, and API-key resolution |
    | `plugin-sdk/provider-oauth-runtime` | Generic provider OAuth callback types, callback-page rendering, PKCE/state helpers, authorization-input parsing, token-expiry helpers, and abort helpers |
    | `plugin-sdk/provider-auth-api-key` | API-key onboarding/profile-write helpers such as `upsertApiKeyProfile` |
    | `plugin-sdk/provider-auth-result` | Standard OAuth auth-result builder |
    | `plugin-sdk/provider-env-vars` | Provider auth env-var lookup helpers |
    | `plugin-sdk/provider-auth` | `createProviderApiKeyAuthMethod`, `ensureApiKeyFromOptionEnvOrPrompt`, `upsertAuthProfile`, `upsertApiKeyProfile`, `writeOAuthCredentials`, OpenAI Codex auth-import helpers, deprecated `resolveOpenClawAgentDir` compatibility export |
    | `plugin-sdk/provider-model-shared` | `ProviderReplayFamily`, `buildProviderReplayFamilyHooks`, `normalizeModelCompat`, shared replay-policy builders, provider-endpoint helpers, and shared model-id normalization helpers |
    | `plugin-sdk/provider-catalog-live-runtime` | Live provider model catalog helpers for guarded `/models`-style discovery: `buildLiveModelProviderConfig`, `fetchLiveProviderModelRows`, `getCachedLiveProviderModelRows`, `fetchLiveProviderModelIds`, `LiveModelCatalogHttpError`, `clearLiveCatalogCacheForTests`, model-id filtering, TTL cache, and static fallback |
    | `plugin-sdk/provider-catalog-runtime` | Provider catalog augmentation runtime hook and plugin-provider registry seams for contract tests |
    | `plugin-sdk/provider-catalog-shared` | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `buildManifestModelProviderConfig`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
    | `plugin-sdk/provider-http` | Generic provider HTTP/endpoint capability helpers, provider HTTP errors, and audio transcription multipart form helpers |
    | `plugin-sdk/provider-web-fetch-contract` | Narrow web-fetch config/selection contract helpers such as `enablePluginInConfig` and `WebFetchProviderPlugin` |
    | `plugin-sdk/provider-web-fetch` | Web-fetch provider registration/cache helpers |
    | `plugin-sdk/provider-web-search-config-contract` | Narrow web-search config/credential helpers for providers that do not need plugin-enable wiring |
    | `plugin-sdk/provider-web-search-contract` | Narrow web-search config/credential contract helpers such as `createWebSearchProviderContractFields`, `enablePluginInConfig`, `resolveProviderWebSearchPluginConfig`, and scoped credential setters/getters |
    | `plugin-sdk/provider-web-search` | Web-search provider registration/cache/runtime helpers |
    | `plugin-sdk/embedding-providers` | General embedding provider types and read helpers, including `EmbeddingProviderAdapter`, `getEmbeddingProvider(...)`, and `listEmbeddingProviders(...)`; plugins register providers through `api.registerEmbeddingProvider(...)` so manifest ownership is enforced |
    | `plugin-sdk/provider-tools` | `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, and DeepSeek/Gemini/OpenAI schema cleanup + diagnostics |
    | `plugin-sdk/provider-usage` | Provider usage snapshot types, shared usage fetch helpers, and provider fetchers such as `fetchClaudeUsage` |
    | `plugin-sdk/provider-stream` | `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, plain-text tool-call compat, and shared Anthropic/Google/Kilocode/MiniMax/Moonshot/OpenAI/OpenRouter/Z.AI wrapper helpers |
    | `plugin-sdk/provider-stream-shared` | Public shared provider stream wrapper helpers including `composeProviderStreamWrappers`, `createOpenAICompatibleCompletionsThinkingOffWrapper`, `createPlainTextToolCallCompatWrapper`, `createPayloadPatchStreamWrapper`, `createToolStreamWrapper`, `normalizeOpenAICompatibleReasoningPayload`, `setQwenChatTemplateThinking`, and Anthropic/DeepSeek/OpenAI-compatible stream utilities |
    | `plugin-sdk/provider-transport-runtime` | Native provider transport helpers such as guarded fetch, tool-result text extraction, transport message transforms, and writable transport event streams |
    | `plugin-sdk/provider-onboard` | Onboarding config patch helpers |
    | `plugin-sdk/global-singleton` | Process-local singleton/map/cache helpers |
    | `plugin-sdk/group-activation` | Narrow group activation mode and command parsing helpers |
  </Accordion>

Provider usage snapshots normally report one or more quota `windows`, each with
a label, percent used, and optional reset time. Providers that expose balance or
account-state text instead of resettable quota windows should return
`summary` with an empty `windows` array rather than fabricating percentages.
OpenClaw displays that summary text in status output; use `error` only when the
usage endpoint failed or returned no usable usage data.

  <Accordion title="Auth and security subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/command-auth` | Deprecated broad command authorization surface (`resolveControlCommandGate`, command registry helpers including dynamic argument menu formatting, sender-authorization helpers); use channel ingress/runtime authorization or command-status helpers |
    | `plugin-sdk/command-status` | Command/help message builders such as `buildCommandsMessagePaginated` and `buildHelpMessage` |
    | `plugin-sdk/approval-auth-runtime` | Approver resolution and same-chat action-auth helpers |
    | `plugin-sdk/approval-client-runtime` | Native exec approval profile/filter helpers |
    | `plugin-sdk/approval-delivery-runtime` | Native approval capability/delivery adapters |
    | `plugin-sdk/approval-gateway-runtime` | Shared approval gateway-resolution helper |
    | `plugin-sdk/approval-handler-adapter-runtime` | Lightweight native approval adapter loading helpers for hot channel entrypoints |
    | `plugin-sdk/approval-handler-runtime` | Broader approval handler runtime helpers; prefer the narrower adapter/gateway seams when they are enough |
    | `plugin-sdk/approval-native-runtime` | Native approval target, account-binding, route-gate, forwarding fallback, and local native exec prompt suppression helpers |
    | `plugin-sdk/approval-reaction-runtime` | Hardcoded approval reaction bindings, reaction prompt payloads, reaction target stores, reaction hint text helpers, and compatibility export for local native exec prompt suppression |
    | `plugin-sdk/approval-reply-runtime` | Exec/plugin approval reply payload helpers |
    | `plugin-sdk/approval-runtime` | Exec/plugin approval payload helpers, approval-capability builders, approval auth/profile helpers, native approval routing/runtime helpers, and structured approval display helpers such as `formatApprovalDisplayPath` |
    | `plugin-sdk/reply-dedupe` | Deprecated narrow inbound reply dedupe reset helpers |
    | `plugin-sdk/command-auth-native` | Native command auth, dynamic argument menu formatting, and native session-target helpers |
    | `plugin-sdk/command-detection` | Shared command detection helpers |
    | `plugin-sdk/command-primitives-runtime` | Lightweight command text predicates for hot channel paths |
    | `plugin-sdk/command-surface` | Command-body normalization and command-surface helpers |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/provider-auth-login-flow-runtime` | Lazy provider auth login flow helpers for private channel and Web UI device-code pairing |
    | `plugin-sdk/channel-secret-runtime` | Deprecated broad secret-contract surface (`collectSimpleChannelFieldAssignments`, `getChannelSurface`, `pushAssignment`, secret target types); prefer the focused subpaths below |
    | `plugin-sdk/channel-secret-basic-runtime` | Narrow secret-contract exports for non-TTS channel/plugin secret surfaces |
    | `plugin-sdk/channel-secret-tts-runtime` | Narrow nested channel TTS secret assignment helpers |
    | `plugin-sdk/secret-ref-runtime` | Narrow SecretRef typing, resolution, and plan-target path lookup for secret-contract/config parsing |
    | `plugin-sdk/secret-provider-integration` | Type-only SecretRef provider integration manifest and preset contracts for plugins that publish external secret provider presets |
    | `plugin-sdk/security-runtime` | Deprecated broad barrel for trust, DM gating, root-bounded file/path helpers including create-only writes, sync/async atomic file replacement, sibling temp writes, cross-device move fallback, private file-store helpers, symlink-parent guards, external-content, sensitive text redaction, constant-time secret comparison, and secret-collection helpers; prefer focused security/SSRF/secret subpaths |
    | `plugin-sdk/ssrf-policy` | Host allowlist and private-network SSRF policy helpers |
    | `plugin-sdk/ssrf-dispatcher` | Narrow pinned-dispatcher helpers without the broad infra runtime surface |
    | `plugin-sdk/ssrf-runtime` | Pinned-dispatcher, SSRF-guarded fetch, SSRF error, and SSRF policy helpers |
    | `plugin-sdk/secret-input` | Secret input parsing helpers |
    | `plugin-sdk/webhook-ingress` | Webhook request/target helpers and raw websocket/body coercion |
    | `plugin-sdk/webhook-request-guards` | Request body size/timeout helpers |
  </Accordion>

  <Accordion title="Runtime and storage subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/runtime` | Runtime/logging/backup helpers, plugin install-path warnings, and process helpers |
    | `plugin-sdk/runtime-env` | Narrow runtime env, logger, timeout, retry, and backoff helpers |
    | `plugin-sdk/browser-config` | Supported browser config facade for normalized profile/defaults, CDP URL parsing, and browser-control auth helpers |
    | `plugin-sdk/agent-harness-task-runtime` | Generic task lifecycle and completion delivery helpers for harness-backed agents using a host-issued task scope |
    | `plugin-sdk/codex-mcp-projection` | Reserved bundled Codex helper for projecting user MCP server config into Codex thread config; not for third-party plugins |
    | `plugin-sdk/codex-native-task-runtime` | Repo-local bundled Codex helper for native task mirror/runtime wiring; not a package export |
    | `plugin-sdk/channel-runtime-context` | Generic channel runtime-context registration and lookup helpers |
    | `plugin-sdk/matrix` | Deprecated Matrix compatibility facade for older third-party channel packages; new plugins should import `plugin-sdk/run-command` directly |
    | `plugin-sdk/mattermost` | Deprecated Mattermost compatibility facade for older third-party channel packages; new plugins should import generic SDK subpaths directly |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/plugin-runtime` | Deprecated broad barrel for plugin command/hook/http/interactive helpers; prefer focused plugin runtime subpaths |
    | `plugin-sdk/hook-runtime` | Deprecated broad barrel for webhook/internal hook pipeline helpers; prefer focused hook/plugin runtime subpaths |
    | `plugin-sdk/lazy-runtime` | Lazy runtime import/binding helpers such as `createLazyRuntimeModule`, `createLazyRuntimeMethod`, and `createLazyRuntimeSurface` |
    | `plugin-sdk/process-runtime` | Process exec helpers |
    | `plugin-sdk/cli-runtime` | Deprecated broad barrel for CLI formatting, wait, version, argument-invocation, and lazy command-group helpers; prefer focused CLI/runtime subpaths |
    | `plugin-sdk/qa-live-transport-scenarios` | Shared live transport QA scenario ids, baseline coverage helpers, and scenario-selection helper |
    | `plugin-sdk/qa-runner-runtime` | Supported facade exposing plugin QA scenarios through the CLI command surface |
    | `plugin-sdk/tts-runtime` | Supported facade for text-to-speech config schemas and runtime helpers |
    | `plugin-sdk/gateway-method-runtime` | Reserved Gateway method dispatch helper for plugin HTTP routes that declare `contracts.gatewayMethodDispatch: ["authenticated-request"]` |
    | `plugin-sdk/gateway-runtime` | Gateway client, event-loop-ready client start helper, gateway CLI RPC, gateway protocol errors, advertised LAN host resolution, and channel-status patch helpers |
    | `plugin-sdk/config-contracts` | Focused type-only config surface for plugin config shapes such as `OpenClawConfig` and channel/provider config types |
    | `plugin-sdk/plugin-config-runtime` | Runtime plugin-config lookup helpers such as `requireRuntimeConfig`, `resolvePluginConfigObject`, and `resolveLivePluginConfigObject` |
    | `plugin-sdk/config-mutation` | Transactional config mutation helpers such as `mutateConfigFile`, `replaceConfigFile`, and `logConfigUpdated` |
    | `plugin-sdk/message-tool-delivery-hints` | Shared message-tool delivery metadata hint strings |
    | `plugin-sdk/runtime-config-snapshot` | Current process config snapshot helpers such as `getRuntimeConfig`, `getRuntimeConfigSnapshot`, and test snapshot setters |
    | `plugin-sdk/text-autolink-runtime` | File-reference autolink detection without the broad text barrel |
    | `plugin-sdk/reply-runtime` | Shared inbound/reply runtime helpers, chunking, dispatch, heartbeat, reply planner |
    | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch/finalize and conversation-label helpers |
    | `plugin-sdk/reply-history` | Shared short-window reply-history helpers. New message-turn code should use `createChannelHistoryWindow`; lower-level map helpers remain deprecated compatibility exports only |
    | `plugin-sdk/reply-reference` | `createReplyReferencePlanner` |
    | `plugin-sdk/reply-chunking` | Narrow text/markdown chunking helpers |
    | `plugin-sdk/session-store-runtime` | Session workflow helpers (`getSessionEntry`, `listSessionEntries`, `patchSessionEntry`, `upsertSessionEntry`), bounded recent user/assistant transcript text reads by session identity, legacy session store path/session-key helpers, updated-at reads, and transition-only whole-store/file-path compatibility helpers, without broad config writes/maintenance imports |
    | `plugin-sdk/session-transcript-runtime` | Transcript identity, scoped target/read/write helpers, update publishing, write locks, and transcript memory hit keys |
    | `plugin-sdk/sqlite-runtime` | Focused SQLite agent-schema, path, and transaction helpers for first-party runtime, without database lifecycle controls |
    | `plugin-sdk/cron-store-runtime` | Cron store path/load/save helpers |
    | `plugin-sdk/state-paths` | State/OAuth dir path helpers |
    | `plugin-sdk/plugin-state-runtime` | Plugin sidecar SQLite keyed-state types plus centralized connection pragma and WAL maintenance setup for plugin-owned databases |
    | `plugin-sdk/routing` | Route/session-key/account binding helpers such as `resolveAgentRoute`, `buildAgentSessionKey`, and `resolveDefaultAgentBoundAccountId` |
    | `plugin-sdk/status-helpers` | Shared channel/account status summary helpers, runtime-state defaults, and issue metadata helpers |
    | `plugin-sdk/target-resolver-runtime` | Shared target resolver helpers |
    | `plugin-sdk/string-normalization-runtime` | Slug/string normalization helpers |
    | `plugin-sdk/request-url` | Extract string URLs from fetch/request-like inputs |
    | `plugin-sdk/run-command` | Timed command runner with normalized stdout/stderr results |
    | `plugin-sdk/param-readers` | Common tool/CLI param readers |
    | `plugin-sdk/tool-plugin` | Define a simple typed agent-tool plugin and expose static metadata for manifest generation |
    | `plugin-sdk/tool-payload` | Extract normalized payloads from tool result objects |
    | `plugin-sdk/tool-send` | Extract canonical send target fields from tool args |
    | `plugin-sdk/sandbox` | Sandbox backend types and SSH/OpenShell command helpers, including fail-fast exec command preflight |
    | `plugin-sdk/temp-path` | Shared temp-download path helpers and private secure temp workspaces |
    | `plugin-sdk/logging-core` | Subsystem logger and redaction helpers |
    | `plugin-sdk/markdown-table-runtime` | Markdown table mode and conversion helpers |
    | `plugin-sdk/model-session-runtime` | Model/session override helpers such as `applyModelOverrideToSessionEntry` and `resolveAgentMaxConcurrent` |
    | `plugin-sdk/talk-config-runtime` | Talk provider config resolution helpers |
    | `plugin-sdk/json-store` | Small JSON state read/write helpers |
    | `plugin-sdk/json-unsafe-integers` | JSON parsing helpers that preserve unsafe integer literals as strings |
    | `plugin-sdk/file-lock` | Re-entrant file-lock helpers |
    | `plugin-sdk/persistent-dedupe` | Disk-backed dedupe cache helpers |
    | `plugin-sdk/acp-runtime` | ACP runtime/session and reply-dispatch helpers |
    | `plugin-sdk/acp-runtime-backend` | Lightweight ACP backend registration and reply-dispatch helpers for startup-loaded plugins |
    | `plugin-sdk/acp-binding-resolve-runtime` | Read-only ACP binding resolution without lifecycle startup imports |
    | `plugin-sdk/agent-config-primitives` | Deprecated agent runtime config-schema primitives; import schema primitives from a maintained plugin-owned surface |
    | `plugin-sdk/boolean-param` | Loose boolean param reader |
    | `plugin-sdk/dangerous-name-runtime` | Dangerous-name matching resolution helpers |
    | `plugin-sdk/device-bootstrap` | Device bootstrap and pairing token helpers |
    | `plugin-sdk/extension-shared` | Shared passive-channel, status, and ambient proxy helper primitives |
    | `plugin-sdk/models-provider-runtime` | `/models` command/provider reply helpers |
    | `plugin-sdk/skill-commands-runtime` | Skill command listing helpers |
    | `plugin-sdk/native-command-registry` | Native command registry/build/serialize helpers |
    | `plugin-sdk/agent-harness` | Experimental trusted-plugin surface for low-level agent harnesses: harness types, active-run steer/abort helpers, OpenClaw tool bridge helpers, runtime-plan tool policy helpers, terminal outcome classification, tool progress formatting/detail helpers, and attempt result utilities |
    | `plugin-sdk/provider-zai-endpoint` | Deprecated Z.AI provider-owned endpoint detection facade; use the Z.AI plugin public API |
    | `plugin-sdk/async-lock-runtime` | Process-local async lock helper for small runtime state files |
    | `plugin-sdk/channel-activity-runtime` | Channel activity telemetry helper |
    | `plugin-sdk/concurrency-runtime` | Bounded async task concurrency helper |
    | `plugin-sdk/dedupe-runtime` | In-memory and persistent-backed dedupe cache helpers |
    | `plugin-sdk/delivery-queue-runtime` | Outbound pending-delivery drain helper |
    | `plugin-sdk/file-access-runtime` | Safe local-file and media-source path helpers |
    | `plugin-sdk/heartbeat-runtime` | Heartbeat wake, event, and visibility helpers |
    | `plugin-sdk/number-runtime` | Numeric coercion helper |
    | `plugin-sdk/secure-random-runtime` | Secure token/UUID helpers |
    | `plugin-sdk/system-event-runtime` | System event queue helpers |
    | `plugin-sdk/transport-ready-runtime` | Transport readiness wait helper |
    | `plugin-sdk/exec-approvals-runtime` | Exec approval policy file helpers without the broad infra-runtime barrel |
    | `plugin-sdk/infra-runtime` | Deprecated compatibility shim; use the focused runtime subpaths above |
    | `plugin-sdk/collection-runtime` | Small bounded cache helpers |
    | `plugin-sdk/diagnostic-runtime` | Diagnostic flag, event, and trace-context helpers |
    | `plugin-sdk/error-runtime` | Error graph, formatting, shared error classification helpers, `isApprovalNotFoundError` |
    | `plugin-sdk/fetch-runtime` | Wrapped fetch, proxy, EnvHttpProxyAgent option, and pinned lookup helpers |
    | `plugin-sdk/runtime-fetch` | Dispatcher-aware runtime fetch without proxy/guarded-fetch imports |
    | `plugin-sdk/inline-image-data-url-runtime` | Inline image data URL sanitizer and signature sniffing helpers without the broad media runtime surface |
    | `plugin-sdk/response-limit-runtime` | Bounded response-body reader without the broad media runtime surface |
    | `plugin-sdk/session-binding-runtime` | Current conversation binding state without configured binding routing or pairing stores |
    | `plugin-sdk/context-visibility-runtime` | Context visibility resolution and supplemental context filtering without broad config/security imports |
    | `plugin-sdk/string-coerce-runtime` | Narrow primitive record/string coercion and normalization helpers without markdown/logging imports |
    | `plugin-sdk/host-runtime` | Hostname and SCP host normalization helpers |
    | `plugin-sdk/retry-runtime` | Retry config and retry runner helpers |
    | `plugin-sdk/agent-runtime` | Deprecated broad barrel for agent dir/identity/workspace helpers, including `resolveAgentDir`, `resolveDefaultAgentDir`, and the deprecated `resolveOpenClawAgentDir` compatibility export; prefer focused agent/runtime subpaths |
    | `plugin-sdk/directory-runtime` | Config-backed directory query/dedup |
    | `plugin-sdk/keyed-async-queue` | `KeyedAsyncQueue` |
  </Accordion>

  <Accordion title="Capability and testing subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/media-runtime` | Deprecated broad media barrel including `saveRemoteMedia`, `saveResponseMedia`, `readRemoteMediaBuffer`, and deprecated `fetchRemoteMedia`; prefer `plugin-sdk/media-store`, `plugin-sdk/media-mime`, `plugin-sdk/outbound-media`, and capability runtime subpaths, and prefer store helpers before buffer reads when a URL should become OpenClaw media |
    | `plugin-sdk/media-mime` | Narrow MIME normalization, file-extension mapping, MIME detection, and media-kind helpers |
    | `plugin-sdk/media-store` | Narrow media store helpers such as `saveMediaBuffer` and `saveMediaStream` |
    | `plugin-sdk/media-generation-runtime` | Shared media-generation failover helpers, candidate selection, and missing-model messaging |
    | `plugin-sdk/media-understanding` | Media understanding provider types plus provider-facing image/audio/structured-extraction helper exports |
    | `plugin-sdk/text-chunking` | Outbound text and markdown chunking/render helpers, markdown table conversion, directive-tag stripping, and safe-text utilities |
    | `plugin-sdk/speech` | Speech provider types plus provider-facing directive, registry, validation, OpenAI-compatible TTS builder, and speech helper exports |
    | `plugin-sdk/speech-core` | Shared speech provider types, registry, directive, normalization, and speech helper exports |
    | `plugin-sdk/realtime-transcription` | Realtime transcription provider types, registry helpers, and shared WebSocket session helper |
    | `plugin-sdk/realtime-bootstrap-context` | Realtime profile bootstrap helper for bounded `IDENTITY.md`, `USER.md`, and `SOUL.md` context injection |
    | `plugin-sdk/realtime-voice` | Realtime voice provider types, registry helpers, and shared realtime voice behavior helpers, including output activity tracking |
    | `plugin-sdk/image-generation` | Image generation provider types plus image asset/data URL helpers and the OpenAI-compatible image provider builder |
    | `plugin-sdk/image-generation-core` | Shared image-generation types, failover, auth, and registry helpers |
    | `plugin-sdk/music-generation` | Music generation provider/request/result types |
    | `plugin-sdk/music-generation-core` | Deprecated shared music-generation types, failover helpers, provider lookup, and model-ref parsing; prefer plugin-owned music provider surfaces |
    | `plugin-sdk/video-generation` | Video generation provider/request/result types |
    | `plugin-sdk/video-generation-core` | Shared video-generation types, failover helpers, provider lookup, and model-ref parsing |
    | `plugin-sdk/transcripts` | Shared transcripts source provider types, registry helpers, session descriptors, and utterance metadata |
    | `plugin-sdk/webhook-targets` | Webhook target registry and route-install helpers |
    | `plugin-sdk/webhook-path` | Deprecated compatibility alias; use `plugin-sdk/webhook-ingress` |
    | `plugin-sdk/web-media` | Shared remote/local media loading helpers |
    | `plugin-sdk/zod` | Deprecated compatibility re-export; import `zod` from `zod` directly |
    | `plugin-sdk/testing` | Repo-local deprecated compatibility barrel for legacy OpenClaw tests. New repo tests should import focused local test subpaths such as `plugin-sdk/agent-runtime-test-contracts`, `plugin-sdk/plugin-test-runtime`, `plugin-sdk/channel-test-helpers`, `plugin-sdk/test-env`, or `plugin-sdk/test-fixtures` instead |
    | `plugin-sdk/plugin-test-api` | Repo-local minimal `createTestPluginApi` helper for direct plugin registration unit tests without importing repo test helper bridges |
    | `plugin-sdk/agent-runtime-test-contracts` | Repo-local native agent-runtime adapter contract fixtures for auth, delivery, fallback, tool-hook, prompt-overlay, schema, and transcript projection tests |
    | `plugin-sdk/channel-test-helpers` | Repo-local channel-oriented test helpers for generic actions/setup/status contracts, directory assertions, account startup lifecycle, send-config threading, runtime mocks, status issues, outbound delivery, and hook registration |
    | `plugin-sdk/channel-target-testing` | Repo-local shared target-resolution error-case suite for channel tests |
    | `plugin-sdk/channel-contract-testing` | Repo-local narrow channel contract test helpers without the broad testing barrel |
    | `plugin-sdk/plugin-test-contracts` | Repo-local plugin package, registration, public artifact, direct import, runtime API, and import side-effect contract helpers |
    | `plugin-sdk/plugin-state-test-runtime` | Repo-local plugin state store, ingress queue, and state DB test helpers |
    | `plugin-sdk/provider-test-contracts` | Repo-local provider runtime, auth, discovery, onboard, catalog, wizard, media capability, replay policy, realtime STT live-audio, web-search/fetch, and stream contract helpers |
    | `plugin-sdk/provider-http-test-mocks` | Repo-local opt-in Vitest HTTP/auth mocks for provider tests that exercise `plugin-sdk/provider-http` |
    | `plugin-sdk/reply-payload-testing` | Repo-local helpers for attaching metadata to reply payload fixtures |
    | `plugin-sdk/sqlite-runtime-testing` | Repo-local SQLite lifecycle helpers for first-party tests |
    | `plugin-sdk/test-fixtures` | Repo-local generic CLI runtime capture, sandbox context, skill writer, agent-message, system-event, module reload, bundled plugin path, terminal-text, chunking, auth-token, and typed-case fixtures |
    | `plugin-sdk/test-node-mocks` | Repo-local focused Node builtin mock helpers for use inside Vitest `vi.mock("node:*")` factories |
  </Accordion>

  <Accordion title="Memory subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/memory-core` | Deprecated compatibility alias; use `plugin-sdk/memory-host-core` |
    | `plugin-sdk/memory-core-engine-runtime` | Deprecated memory index/search runtime facade; prefer vendor-neutral memory-host subpaths |
    | `plugin-sdk/memory-core-host-embedding-registry` | Lightweight memory embedding provider registry helpers |
    | `plugin-sdk/memory-core-host-engine-foundation` | Memory host foundation engine exports |
    | `plugin-sdk/memory-core-host-engine-embeddings` | Memory host embedding contracts, registry access, local provider, and generic batch/remote helpers. `registerMemoryEmbeddingProvider` on this surface is deprecated; use the generic embedding provider API for new providers. |
    | `plugin-sdk/memory-core-host-engine-qmd` | Memory host QMD engine exports |
    | `plugin-sdk/memory-core-host-engine-storage` | Memory host storage engine exports |
    | `plugin-sdk/memory-core-host-multimodal` | Deprecated memory host multimodal helpers; prefer vendor-neutral memory-host subpaths |
    | `plugin-sdk/memory-core-host-query` | Deprecated memory host query helpers; prefer vendor-neutral memory-host subpaths |
    | `plugin-sdk/memory-core-host-secret` | Memory host secret helpers |
    | `plugin-sdk/memory-core-host-events` | Deprecated compatibility alias; use `plugin-sdk/memory-host-events` |
    | `plugin-sdk/memory-core-host-status` | Memory host status helpers |
    | `plugin-sdk/memory-core-host-runtime-cli` | Memory host CLI runtime helpers |
    | `plugin-sdk/memory-core-host-runtime-core` | Memory host core runtime helpers |
    | `plugin-sdk/memory-core-host-runtime-files` | Memory host file/runtime helpers |
    | `plugin-sdk/memory-host-core` | Vendor-neutral alias for memory host core runtime helpers |
    | `plugin-sdk/memory-host-events` | Vendor-neutral alias for memory host event journal helpers |
    | `plugin-sdk/memory-host-files` | Deprecated compatibility alias; use `plugin-sdk/memory-core-host-runtime-files` |
    | `plugin-sdk/memory-host-markdown` | Shared managed-markdown helpers for memory-adjacent plugins |
    | `plugin-sdk/memory-host-search` | Active memory runtime facade for search-manager access |
    | `plugin-sdk/memory-host-status` | Deprecated compatibility alias; use `plugin-sdk/memory-core-host-status` |
  </Accordion>

  <Accordion title="Reserved bundled-helper subpaths">
    Reserved bundled-helper SDK subpaths are narrow owner-specific surfaces for
    bundled plugin code. They are tracked in the SDK inventory so package
    builds and aliasing stay deterministic, but they are not general plugin
    authoring APIs. New reusable host contracts should use generic SDK subpaths
    such as `plugin-sdk/gateway-runtime`, `plugin-sdk/ssrf-runtime`, and
    `plugin-sdk/plugin-config-runtime`.

    | Subpath | Owner and purpose |
    | --- | --- |
    | `plugin-sdk/codex-mcp-projection` | Bundled Codex plugin helper for projecting user MCP server config into Codex app-server thread config (reserved package export) |
    | `plugin-sdk/codex-native-task-runtime` | Bundled Codex plugin helper for mirroring Codex app-server native subagents into OpenClaw task state (repo-local only, not a package export) |

  </Accordion>
</AccordionGroup>

## Related

- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
