---
summary: "Plugin SDK subpath catalog: which imports live where, grouped by area"
read_when:
  - Choosing the right plugin-sdk subpath for a plugin import
  - Auditing bundled-plugin subpaths and helper surfaces
title: "Plugin SDK subpaths"
---

The plugin SDK contains narrow public subpaths and repository-only bundled
helpers under `openclaw/plugin-sdk/`. This page catalogs both and labels
private-local entries explicitly. Three files define the boundary:

- `scripts/lib/plugin-sdk-entrypoints.json`: the maintained entrypoint inventory
  the build compiles.
- `scripts/lib/plugin-sdk-private-local-only-subpaths.json`: internal subpaths
  excluded from the typed, documented SDK. Production entries remain available
  as JavaScript-only host runtime exports for separately published official
  plugins; test-only entries stay unexported.
- `src/plugin-sdk/entrypoints.ts`: classification metadata for deprecated
  subpaths, reserved bundled helpers, supported bundled facades, and
  plugin-owned public surfaces.

Maintainers audit the public export count with `pnpm plugin-sdk:surface` and
active reserved helper subpaths with `pnpm plugins:boundary-report:summary`;
unused reserved helper exports fail the CI report instead of staying in the
public SDK as dormant compatibility debt.

For the plugin authoring guide, see [Plugin SDK overview](/plugins/sdk-overview).

## Plugin entry

| Subpath                        | Key exports                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry`      | `definePluginEntry`                                                                                                                                                                                     |
| `plugin-sdk/core`              | `defineChannelPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `defineSetupPluginEntry`, `buildChannelConfigSchema`, `buildJsonChannelConfigSchema`, `resolveTailscalePublishedHost` |
| `plugin-sdk/provider-entry`    | Private-local after July 2026; `defineSingleProviderPluginEntry`                                                                                                                                        |
| `plugin-sdk/migration`         | Private-local after July 2026; Migration provider item helpers such as `createMigrationItem`, reason constants, item status markers, redaction helpers, and `summarizeMigrationItems`                   |
| `plugin-sdk/migration-runtime` | Private-local after July 2026; Runtime migration helpers such as `copyMigrationFileItem`, `resolvePlannedMigrationTargets`, `withCachedMigrationConfigRuntime`, and `writeMigrationReport`              |
| `plugin-sdk/health`            | Doctor health-check registration, detection, repair, selection, severity, and finding types for bundled health consumers                                                                                |

### Compatibility and private-local helpers

Only the later-window deprecated subpaths remain exported. July 2026 aliases and
unused subpaths were deleted, while bundled-only helpers were removed from the
public package and are labeled private-local below. The maintained list is
`scripts/lib/plugin-sdk-deprecated-public-subpaths.json`; CI rejects bundled
`plugin-sdk/text-runtime` are compatibility only, and `plugin-sdk/zod` is a
compatibility re-export: import `zod` directly from `zod`. The broad domain
barrels `plugin-sdk/agent-runtime`, `plugin-sdk/channel-lifecycle`,
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
`test-live`, `test-live-auth`, `test-media-generation`,
`test-media-understanding`, `test-node-mocks`, and `testing`. The private bundled helper surfaces
`ssrf-runtime-internal` and `codex-native-task-runtime` are also repo-local
only.

### Bundled plugin helper subpaths

Bundled-only helper modules are private-local after the July 2026 sweep. Cross-owner imports are blocked by package contract guardrails. `src/plugin-sdk/entrypoints.ts` separately tracks the supported bundled facades that remain public, SDK
entrypoints backed by their bundled plugin until generic contracts replace
`plugin-sdk/qa-runner-runtime`, `plugin-sdk/telegram-account`,
deprecated for new code; see the per-row notes below.

<AccordionGroup>
  <Accordion title="Channel subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/channel-core` | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `createChannelConfigUiHints` |
    | `plugin-sdk/json-schema-runtime` | Private-local after July 2026; Cached JSON Schema validation helper for plugin-owned schemas |
    | `plugin-sdk/channel-setup` | `defineChannelSetupContract`, channel-owned setup field/input types, `createOptionalChannelSetupSurface`, `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`, plus `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`, `setSetupChannelEnabled`, `splitSetupEntries` |
    | `plugin-sdk/setup` | Shared setup wizard helpers, setup translator, allowlist prompts, setup status builders |
    | `plugin-sdk/setup-runtime` | `defineChannelSetupContract`, `createSetupTranslator`, `createPatchedAccountSetupAdapter`, `createEnvPatchedAccountSetupAdapter`, `createSetupInputPresenceValidator`, `noteChannelLookupFailure`, `noteChannelLookupSummary`, `promptResolvedAllowFrom`, `splitSetupEntries`, `createAllowlistSetupWizardProxy`, `createDelegatedSetupWizardProxy` |
    | `plugin-sdk/setup-tools` | `formatCliCommand`, `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`, `CONFIG_DIR` |
    | `plugin-sdk/account-core` | Multi-account config/action-gate helpers, default-account fallback helpers |
    | `plugin-sdk/account-id` | `DEFAULT_ACCOUNT_ID`, account-id normalization helpers |
    | `plugin-sdk/account-resolution` | Account lookup + default-fallback helpers |
    | `plugin-sdk/account-helpers` | Narrow account-list/account-action helpers |
    | `plugin-sdk/access-groups` | Private-local after July 2026; Access-group allowlist parsing and redacted group diagnostics helpers |
    | `plugin-sdk/channel-pairing` | `createChannelPairingController` |
    | `plugin-sdk/channel-reply-pipeline` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter`, `resolveChannelDmAccess`, `resolveChannelDmAllowFrom`, `resolveChannelDmPolicy`, `normalizeChannelDmPolicy`, `normalizeLegacyDmAliases` |
    | `plugin-sdk/channel-config-schema` | Shared channel config schema primitives plus Zod and direct JSON/TypeBox builders |
    | `plugin-sdk/bundled-channel-config-schema` | Private-local after July 2026; Bundled OpenClaw channel config schemas for maintained bundled plugins only |
    | `plugin-sdk/chat-channel-ids` | Private-local after July 2026; `BUNDLED_CHAT_CHANNEL_IDS`, `BUNDLED_CHAT_CHANNEL_ENVELOPE_PREFIXES`, `ChatChannelId`. Canonical bundled/official chat channel ids plus formatter labels/aliases for plugins that need to recognize envelope-prefixed text without hardcoding their own table. |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-ingress-runtime` | Experimental high-level channel ingress runtime resolver, implicit-mention policy resolver, and route fact builders for migrated channel receive paths. Prefer this over assembling effective allowlists, command allowlists, and legacy projections in each plugin. See [Channel ingress API](/plugins/sdk-channel-ingress). |
    | `plugin-sdk/channel-lifecycle` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-outbound` | Message lifecycle contracts plus reply pipeline options, receipts, live preview/streaming, lifecycle helpers, outbound identity, payload planning, durable sends, and message-send context helpers. See [Channel outbound API](/plugins/sdk-channel-outbound). |
    | `plugin-sdk/channel-message` | Deprecated compatibility alias for `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/inbound-envelope` | Shared inbound route + envelope builder helpers |
    | `plugin-sdk/inbound-reply-dispatch` | Deprecated compatibility facade. Use `plugin-sdk/channel-inbound` for inbound runners and dispatch predicates, and `plugin-sdk/channel-outbound` for message delivery helpers. |
    | `plugin-sdk/messaging-targets` | Deprecated target parsing alias; use `plugin-sdk/channel-targets` |
    | `plugin-sdk/outbound-media` | Private-local after July 2026; Shared outbound media loading and hosted-media state helpers |
    | `plugin-sdk/poll-runtime` | Private-local after July 2026; Narrow poll normalization helpers |
    | `plugin-sdk/thread-bindings-runtime` | Private-local after July 2026; Thread-binding lifecycle and adapter helpers |
    | `plugin-sdk/agent-media-payload` | Deprecated compatibility facade for agent media payload roots and loaders. New channel plugins use typed outbound payload planning from `plugin-sdk/channel-outbound`; operator-supplied local-media loading still uses the retained facade until a focused public local-roots seam exists. |
    | `plugin-sdk/conversation-runtime` | Deprecated broad barrel for conversation/thread binding, pairing, and configured-binding helpers; prefer focused binding subpaths such as `plugin-sdk/thread-bindings-runtime` and `plugin-sdk/session-binding-runtime` |
    | `plugin-sdk/runtime-group-policy` | Runtime group-policy resolution helpers |
    | `plugin-sdk/channel-status` | Shared channel status snapshot/summary helpers |
    | `plugin-sdk/channel-config-primitives` | Narrow channel config-schema primitives |
    | `plugin-sdk/channel-config-writes` | Private-local after July 2026; Channel config-write authorization helpers |
    | `plugin-sdk/channel-plugin-common` | Shared channel plugin prelude exports |
    | `plugin-sdk/allowlist-config-edit` | Allowlist config edit/read helpers |
    | `plugin-sdk/group-access` | Deprecated group-access decision helpers; use `resolveChannelMessageIngress` from `plugin-sdk/channel-ingress-runtime` |
    | `plugin-sdk/direct-dm-guard-policy` | Private-local after July 2026; Narrow direct-DM pre-crypto guard policy helpers |
    | `plugin-sdk/discord` | Deprecated Discord compatibility facade for published `@openclaw/discord@2026.3.13` and tracked owner compatibility; new plugins should use generic channel SDK subpaths |
    | `plugin-sdk/telegram-account` | Deprecated Telegram account-resolution compatibility facade for tracked owner compatibility; new plugins should use injected runtime helpers or generic channel SDK subpaths |
    | `plugin-sdk/interactive-runtime` | Semantic message presentation, delivery, and legacy interactive reply helpers. See [Message Presentation](/plugins/message-presentation) |
    | `plugin-sdk/question-gateway-runtime` | Resolve runtime-authored `ask_user` choices through the Gateway from channel interaction handlers |
    | `plugin-sdk/channel-inbound` | Shared inbound helpers for event classification, context building, formatting, roots, debounce, mention matching, mention-policy, and inbound logging |
    | `plugin-sdk/channel-inbound-debounce` | Narrow inbound debounce helpers |
    | `plugin-sdk/channel-mention-gating` | Private-local after July 2026; Narrow mention-policy, mention marker, and mention text helpers without the broader inbound runtime surface |
    | `plugin-sdk/channel-streaming` | Deprecated compatibility facade. Use `plugin-sdk/channel-outbound`. |
    | `plugin-sdk/channel-send-result` | Reply result types |
    | `plugin-sdk/channel-actions` | Channel message-action helpers, plus deprecated native schema helpers kept for plugin compatibility |
    | `plugin-sdk/channel-route` | Private-local after July 2026; Shared route normalization, parser-driven target resolution, thread-id stringification, dedupe/compact route keys, parsed-target types, and route/target comparison helpers |
    | `plugin-sdk/channel-targets` | Private-local after July 2026; Target parsing helpers; route comparison callers should use `plugin-sdk/channel-route` |
    | `plugin-sdk/channel-contract` | Channel contract types |
    | `plugin-sdk/channel-feedback` | Feedback/reaction wiring |
  </Accordion>

Later-window channel compatibility subpaths remain public only through their
registry dates. July aliases such as direct-DM access, reply-options, pairing
paths, and channel runtime splinters have been removed; bundled-only helpers
are private-local.

  <Accordion title="Provider subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/provider-entry` | Private-local after July 2026; `defineSingleProviderPluginEntry` |
    | `plugin-sdk/provider-setup` | Private-local after July 2026; Curated local/self-hosted provider setup helpers |
    | `plugin-sdk/cli-backend` | Private-local after July 2026; CLI backend defaults + watchdog constants |
    | `plugin-sdk/provider-auth-runtime` | Private-local after July 2026; Provider auth runtime helpers: OAuth loopback flow, token exchange, auth persistence, and API-key resolution |
    | `plugin-sdk/provider-oauth-runtime` | Private-local after July 2026; Generic provider OAuth callback types, callback-page rendering, PKCE/state helpers, authorization-input parsing, token-expiry helpers, and abort helpers |
    | `plugin-sdk/provider-auth-api-key` | Private-local after July 2026; API-key onboarding/profile-write helpers such as `upsertApiKeyProfile` |
    | `plugin-sdk/provider-auth-result` | Private-local after July 2026; Standard OAuth auth-result builder |
    | `plugin-sdk/provider-env-vars` | Private-local after July 2026; Provider auth env-var lookup helpers |
    | `plugin-sdk/provider-auth` | `createProviderApiKeyAuthMethod`, `ensureApiKeyFromOptionEnvOrPrompt`, `upsertAuthProfile`, `upsertApiKeyProfile`, `writeOAuthCredentials`, OpenAI Codex auth-import helpers, deprecated `resolveOpenClawAgentDir` compatibility export |
    | `plugin-sdk/provider-model-shared` | Private-local after July 2026; `ProviderReplayFamily`, `buildProviderReplayFamilyHooks`, `selectPreferredLocalModelId`, `normalizeModelCompat`, shared replay-policy builders, provider-endpoint helpers, and shared model-id normalization helpers |
    | `plugin-sdk/provider-catalog-live-runtime` | Private-local after July 2026; Live provider model catalog helpers for guarded `/models`-style discovery: `buildLiveModelProviderConfig`, `fetchLiveProviderModelRows`, `getCachedLiveProviderModelRows`, `fetchLiveProviderModelIds`, `LiveModelCatalogHttpError`, `clearLiveCatalogCacheForTests`, model-id filtering, TTL cache, and static fallback |
    | `plugin-sdk/provider-catalog-runtime` | Provider catalog augmentation runtime hook and plugin-provider registry seams for contract tests |
    | `plugin-sdk/provider-catalog-shared` | Private-local after July 2026; `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `buildManifestModelProviderConfig`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
    | `plugin-sdk/provider-http` | Private-local after July 2026; Generic provider HTTP/endpoint capability helpers, provider HTTP errors, and audio transcription multipart form helpers |
    | `plugin-sdk/provider-web-fetch-contract` | Private-local after July 2026; Narrow web-fetch config/selection contract helpers such as `enablePluginInConfig` and `WebFetchProviderPlugin` |
    | `plugin-sdk/provider-web-fetch` | Private-local after July 2026; Web-fetch provider registration/cache helpers |
    | `plugin-sdk/provider-web-search-config-contract` | Private-local after July 2026; Narrow web-search config/credential helpers for providers that do not need plugin-enable wiring |
    | `plugin-sdk/provider-web-search-contract` | Private-local after July 2026; Narrow web-search config/credential contract helpers such as `createWebSearchProviderContractFields`, `enablePluginInConfig`, `resolveProviderWebSearchPluginConfig`, and scoped credential setters/getters |
    | `plugin-sdk/provider-web-search` | Private-local after July 2026; Web-search provider registration/cache/runtime helpers |
    | `plugin-sdk/embedding-providers` | Private-local after July 2026; General embedding provider types and read helpers, including `EmbeddingProviderAdapter`, `getEmbeddingProvider(...)`, and `listEmbeddingProviders(...)`; plugins register providers through `api.registerEmbeddingProvider(...)` so manifest ownership is enforced |
    | `plugin-sdk/provider-tools` | Private-local after July 2026; `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, and DeepSeek/Gemini/OpenAI schema cleanup + diagnostics |
    | `plugin-sdk/provider-usage` | Private-local after July 2026; Provider usage snapshot types, shared usage fetch helpers, and provider fetchers such as `fetchClaudeUsage` |
    | `plugin-sdk/provider-stream` | Private-local after July 2026; `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, plain-text tool-call compat, and shared Anthropic/Google/Kilocode/MiniMax/Moonshot/OpenAI/OpenRouter/Z.AI wrapper helpers |
    | `plugin-sdk/provider-stream-shared` | Private-local after July 2026; Public shared provider stream wrapper helpers including `composeProviderStreamWrappers`, `createOpenAICompatibleCompletionsThinkingOffWrapper`, `createPlainTextToolCallCompatWrapper`, `createPayloadPatchStreamWrapper`, `createToolStreamWrapper`, `normalizeOpenAICompatibleReasoningPayload`, `setQwenChatTemplateThinking`, and Anthropic/DeepSeek/OpenAI-compatible stream utilities |
    | `plugin-sdk/provider-transport-runtime` | Private-local after July 2026; Native provider transport helpers such as guarded fetch, tool-result text extraction, transport message transforms, and writable transport event streams |
    | `plugin-sdk/provider-onboard` | Private-local after July 2026; Onboarding config patch helpers |
    | `plugin-sdk/global-singleton` | Private-local after July 2026; Process-local singleton/map/cache helpers |
    | `plugin-sdk/group-activation` | Private-local after July 2026; Narrow group activation mode and command parsing helpers |
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
    | `plugin-sdk/approval-gateway-runtime` | Shared approval gateway resolver |
    | `plugin-sdk/approval-reference-runtime` | Private-local after July 2026; Deterministic durable-locator helper for transport-limited approval callbacks |
    | `plugin-sdk/approval-handler-adapter-runtime` | Lightweight native approval adapter loading helpers for hot channel entrypoints |
    | `plugin-sdk/approval-handler-runtime` | Broader approval handler runtime helpers; prefer the narrower adapter/gateway seams when they are enough |
    | `plugin-sdk/approval-native-runtime` | Native approval target, account-binding, route-gate, forwarding fallback, and local native exec prompt suppression helpers |
    | `plugin-sdk/approval-reaction-runtime` | Private-local after July 2026; Hardcoded approval reaction bindings, reaction prompt payloads, reaction target stores, reaction hint text helpers, and compatibility export for local native exec prompt suppression |
    | `plugin-sdk/approval-reply-runtime` | Exec/plugin approval reply payload helpers |
    | `plugin-sdk/approval-runtime` | Exec/plugin approval payload helpers, approval-capability builders, approval auth/profile helpers, native approval routing/runtime helpers, and structured approval display helpers such as `formatApprovalDisplayPath` |
    | `plugin-sdk/command-auth-native` | Native command auth, dynamic argument menu formatting, and native session-target helpers |
    | `plugin-sdk/command-detection` | Shared command detection helpers |
    | `plugin-sdk/command-primitives-runtime` | Lightweight command text predicates for hot channel paths |
    | `plugin-sdk/command-surface` | Private-local after July 2026; Command-body normalization and command-surface helpers |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/provider-auth-login-flow-runtime` | Private-local after July 2026; Lazy provider auth login flow helpers for private channel and Web UI device-code pairing |
    | `plugin-sdk/channel-secret-runtime` | Deprecated broad secret-contract surface (`collectSimpleChannelFieldAssignments`, `getChannelSurface`, `pushAssignment`, secret target types); prefer the focused subpaths below |
    | `plugin-sdk/channel-secret-basic-runtime` | Narrow secret-contract exports and target-registry builders for non-TTS channel/plugin secret surfaces |
    | `plugin-sdk/channel-secret-tts-runtime` | Private-local after July 2026; Narrow nested channel TTS secret assignment helpers |
    | `plugin-sdk/secret-ref-runtime` | Narrow SecretRef typing, resolution, and plan-target path lookup for secret-contract/config parsing |
    | `plugin-sdk/security-runtime` | Deprecated broad barrel for trust, DM gating, root-bounded file/path helpers including create-only writes, sync/async atomic file replacement, sibling temp writes, cross-device move fallback, private file-store helpers, symlink-parent guards, external-content, sensitive text redaction, constant-time secret comparison, and secret-collection helpers; prefer focused security/SSRF/secret subpaths |
    | `plugin-sdk/ssrf-policy` | Host allowlist and private-network SSRF policy helpers |
    | `plugin-sdk/ssrf-dispatcher` | Private-local after July 2026; Narrow pinned-dispatcher helpers without the broad infra runtime surface |
    | `plugin-sdk/ssrf-runtime` | Pinned-dispatcher, SSRF-guarded fetch, SSRF error, and SSRF policy helpers |
    | `plugin-sdk/secret-input` | Secret input parsing helpers |
    | `plugin-sdk/webhook-ingress` | Webhook request/target helpers and raw websocket/body coercion |
    | `plugin-sdk/webhook-request-guards` | Request body size/timeout helpers and `runDetachedWebhookWork` for tracked post-ack processing |
  </Accordion>

  <Accordion title="Runtime and storage subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/runtime` | Runtime/logging/backup helpers, plugin install-path warnings, and process helpers |
    | `plugin-sdk/runtime-env` | Narrow runtime env, logger, timeout, retry, and backoff helpers |
    | `plugin-sdk/browser-config` | Private-local after July 2026; Supported browser config facade for normalized profile/defaults, CDP URL parsing, and browser-control auth helpers |
    | `plugin-sdk/agent-harness-task-runtime` | Private-local after July 2026; Generic task lifecycle and completion delivery helpers for harness-backed agents using a host-issued task scope |
    | `plugin-sdk/codex-mcp-projection` | Private-local after July 2026; Reserved bundled Codex helper for projecting user MCP server config into Codex thread config; not for third-party plugins |
    | `plugin-sdk/codex-native-task-runtime` | Repo-local bundled Codex helper for native task mirror/runtime wiring; not a package export |
    | `plugin-sdk/channel-runtime-context` | Generic channel runtime-context registration and lookup helpers |
    | `plugin-sdk/matrix` | Deprecated Matrix compatibility facade for older third-party channel packages; new plugins should import `plugin-sdk/run-command` directly |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/plugin-runtime` | Deprecated broad barrel for plugin command/hook/http/interactive helpers; prefer focused plugin runtime subpaths |
    | `plugin-sdk/hook-runtime` | Deprecated broad barrel for webhook/internal hook pipeline helpers; prefer focused hook/plugin runtime subpaths |
    | `plugin-sdk/lazy-runtime` | Lazy runtime import/binding helpers such as `createLazyRuntimeModule`, `createLazyRuntimeMethod`, and `createLazyRuntimeSurface` |
    | `plugin-sdk/process-runtime` | Private-local after July 2026; Process exec helpers |
    | `plugin-sdk/node-host` | Private-local after July 2026; Node-host executable resolution and PTY resume helpers |
    | `plugin-sdk/cli-runtime` | Private-local after July 2026; Deprecated broad barrel for CLI formatting, wait, version, argument-invocation, and lazy command-group helpers; prefer focused CLI/runtime subpaths |
    | `plugin-sdk/qa-runner-runtime` | Private-local after July 2026; Supported facade exposing plugin QA scenarios through the CLI command surface |
    | `plugin-sdk/tts-runtime` | Private-local after July 2026; Supported facade for text-to-speech config schemas and runtime helpers |
    | `plugin-sdk/gateway-method-runtime` | Reserved Gateway method dispatch helper for plugin HTTP routes that declare `contracts.gatewayMethodDispatch: ["authenticated-request"]` |
    | `plugin-sdk/gateway-runtime` | Gateway client, event-loop-ready client start helper, gateway CLI RPC, gateway protocol errors, advertised LAN host resolution, and channel-status patch helpers |
    | `plugin-sdk/config-contracts` | Focused type-only config surface for plugin config shapes such as `OpenClawConfig` and channel/provider config types |
    | `plugin-sdk/plugin-config-runtime` | Deprecated compatibility facade for runtime plugin-config helpers; new plugins use `api.pluginConfig` plus focused config contracts, snapshots, and mutation helpers |
    | `plugin-sdk/config-mutation` | Transactional config mutation helpers such as `mutateConfigFile`, `replaceConfigFile`, and `logConfigUpdated` |
    | `plugin-sdk/message-tool-delivery-hints` | Private-local after July 2026; Shared message-tool delivery metadata hint strings |
    | `plugin-sdk/runtime-config-snapshot` | Current process config snapshot helpers such as `getRuntimeConfig`, `getRuntimeConfigSnapshot`, and test snapshot setters |
    | `plugin-sdk/text-autolink-runtime` | Private-local after July 2026; File-reference autolink detection without the broad text barrel |
    | `plugin-sdk/reply-runtime` | Shared inbound/reply runtime helpers, chunking, dispatch, heartbeat, reply planner |
    | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch/finalize and conversation-label helpers |
    | `plugin-sdk/reply-history` | Shared short-window reply-history helpers. New message-turn code should use `createChannelHistoryWindow`; lower-level map helpers remain deprecated compatibility exports only |
    | `plugin-sdk/reply-reference` | Private-local after July 2026; `createReplyReferencePlanner` |
    | `plugin-sdk/reply-chunking` | Narrow text/markdown chunking helpers |
    | `plugin-sdk/session-store-runtime` | Session workflow helpers (`getSessionEntry`, `listSessionEntries`, `patchSessionEntry`, `upsertSessionEntry`), repair/lifecycle helpers (`deleteSessionEntry`, `cleanupSessionLifecycleArtifacts`, `resolveSessionStoreBackupPaths`), marker helpers for transitional `sessionFile` values, bounded recent user/assistant transcript text reads by session identity, session store path/session-key helpers, and updated-at reads, without broad config writes/maintenance imports |
    | `plugin-sdk/session-transcript-runtime` | Private-local after July 2026; Transcript identity, bounded raw and visible cursors, scoped target/read/write helpers, visible message-entry projection, update publishing, write locks, and transcript memory hit keys |
    | `plugin-sdk/sqlite-runtime` | Private-local after July 2026; Focused SQLite agent-schema, path, and transaction helpers for first-party runtime, without database lifecycle controls |
    | `plugin-sdk/cron-store-runtime` | Private-local after July 2026; Cron store path/load/save helpers |
    | `plugin-sdk/state-paths` | State/OAuth dir path helpers |
    | `plugin-sdk/plugin-state-runtime` | Private-local after July 2026; Plugin-scoped keyed-state, BLOB, and cooperative SQLite lease contracts plus connection pragma, verified WAL maintenance, and atomic STRICT-schema migration helpers. Lease callbacks receive an abort signal and typed errors distinguish timeout, cancellation, lost ownership, invalid input, and storage failure |
    | `plugin-sdk/routing` | Route/session-key/account binding helpers such as `resolveAgentRoute`, `buildAgentSessionKey`, and `resolveDefaultAgentBoundAccountId` |
    | `plugin-sdk/status-helpers` | Shared channel/account status summary helpers, runtime-state defaults, and issue metadata helpers |
    | `plugin-sdk/target-resolver-runtime` | Private-local after July 2026; Shared target resolver helpers |
    | `plugin-sdk/string-normalization-runtime` | Private-local after July 2026; Slug/string normalization helpers |
    | `plugin-sdk/request-url` | Private-local after July 2026; Extract string URLs from fetch/request-like inputs |
    | `plugin-sdk/run-command` | Timed command runner with normalized stdout/stderr results |
    | `plugin-sdk/param-readers` | Common tool/CLI param readers |
    | `plugin-sdk/tool-plugin` | Define a simple typed agent-tool plugin and expose static metadata for manifest generation |
    | `plugin-sdk/tool-payload` | Private-local after July 2026; Extract normalized payloads from tool result objects |
    | `plugin-sdk/tool-send` | Extract canonical send target fields from tool args |
    | `plugin-sdk/sandbox` | Private-local after July 2026; Sandbox backend types and SSH/OpenShell command helpers, including fail-fast exec command preflight |
    | `plugin-sdk/temp-path` | Shared temp-download path helpers and private secure temp workspaces |
    | `plugin-sdk/logging-core` | Subsystem logger and redaction helpers |
    | `plugin-sdk/markdown-table-runtime` | Private-local after July 2026; Markdown table mode and conversion helpers |
    | `plugin-sdk/model-session-runtime` | Model/session override helpers such as `applyModelOverrideToSessionEntry` and `resolveAgentMaxConcurrent` |
    | `plugin-sdk/talk-config-runtime` | Private-local after July 2026; Talk provider config resolution helpers |
    | `plugin-sdk/json-store` | Small JSON state read/write helpers |
    | `plugin-sdk/json-unsafe-integers` | Private-local after July 2026; JSON parsing helpers that preserve unsafe integer literals as strings |
    | `plugin-sdk/file-lock` | Private-local after July 2026; Re-entrant file-lock helpers plus Doctor-safe reclaim of definitely stale, unchanged retired lock sidecars |
    | `plugin-sdk/persistent-dedupe` | Disk-backed dedupe cache helpers |
    | `plugin-sdk/ingress-effect-once` | Durable claim/commit guard for non-idempotent ingress side effects |
    | `plugin-sdk/acp-runtime` | Private-local after July 2026; ACP runtime/session and reply-dispatch helpers |
    | `plugin-sdk/acp-runtime-backend` | Private-local after July 2026; Lightweight ACP backend registration and reply-dispatch helpers for startup-loaded plugins |
    | `plugin-sdk/acp-binding-resolve-runtime` | Private-local after July 2026; Read-only ACP binding resolution without lifecycle startup imports |
    | `plugin-sdk/agent-config-primitives` | Deprecated agent runtime config-schema primitives; import schema primitives from a maintained plugin-owned surface |
    | `plugin-sdk/boolean-param` | Loose boolean param reader |
    | `plugin-sdk/dangerous-name-runtime` | Private-local after July 2026; Dangerous-name matching resolution helpers |
    | `plugin-sdk/device-bootstrap` | Device bootstrap and pairing token helpers, including `BOOTSTRAP_HANDOFF_OPERATOR_SCOPES` |
    | `plugin-sdk/extension-shared` | Shared passive-channel, status, and ambient proxy helper primitives |
    | `plugin-sdk/models-provider-runtime` | `/models` command/provider reply helpers |
    | `plugin-sdk/skill-commands-runtime` | Skill command listing helpers |
    | `plugin-sdk/native-command-registry` | Native command registry/build/serialize helpers |
    | `plugin-sdk/agent-harness` | Experimental trusted-plugin surface for low-level agent harnesses: harness types, active-run steer/abort helpers, OpenClaw tool bridge helpers, runtime-plan tool policy helpers, terminal outcome classification, tool progress formatting/detail helpers, and attempt result utilities |
    | `plugin-sdk/async-lock-runtime` | Private-local after July 2026; Process-local async lock helper for small runtime state files |
    | `plugin-sdk/channel-activity-runtime` | Private-local after July 2026; Channel activity telemetry helper |
    | `plugin-sdk/concurrency-runtime` | Private-local after July 2026; Bounded async task concurrency helper |
    | `plugin-sdk/dedupe-runtime` | In-memory and persistent-backed dedupe cache helpers |
    | `plugin-sdk/delivery-queue-runtime` | Private-local after July 2026; Outbound pending-delivery drain helper |
    | `plugin-sdk/file-access-runtime` | Private-local after July 2026; Safe local-file and media-source path helpers |
    | `plugin-sdk/heartbeat-runtime` | Private-local after July 2026; Heartbeat wake, event, and visibility helpers |
    | `plugin-sdk/expect-runtime` | Private-local after July 2026; Required-value assertion helper for provable runtime invariants |
    | `plugin-sdk/number-runtime` | Private-local after July 2026; Numeric coercion helper |
    | `plugin-sdk/secure-random-runtime` | Private-local after July 2026; Secure token/UUID helpers |
    | `plugin-sdk/system-event-runtime` | Private-local after July 2026; System event queue helpers |
    | `plugin-sdk/transport-ready-runtime` | Private-local after July 2026; Transport readiness wait helper |
    | `plugin-sdk/exec-approvals-runtime` | Private-local after July 2026; Exec approval policy file helpers without the broad infra-runtime barrel |
    | `plugin-sdk/infra-runtime` | Deprecated compatibility shim; use the focused runtime subpaths above |
    | `plugin-sdk/collection-runtime` | Small bounded cache helpers |
    | `plugin-sdk/diagnostic-runtime` | Diagnostic flag, event, and trace-context helpers |
    | `plugin-sdk/error-runtime` | Error graph, formatting, unknown-value coercion, shared error classification helpers, `PlatformMessageNotDispatchedError`, `isApprovalNotFoundError` |
    | `plugin-sdk/fetch-runtime` | Private-local after July 2026; Wrapped fetch, proxy, EnvHttpProxyAgent option, and pinned lookup helpers |
    | `plugin-sdk/runtime-fetch` | Private-local after July 2026; Dispatcher-aware runtime fetch without proxy/guarded-fetch imports |
    | `plugin-sdk/inline-image-data-url-runtime` | Private-local after July 2026; Inline image data URL sanitizer and signature sniffing helpers without the broad media runtime surface |
    | `plugin-sdk/response-limit-runtime` | Private-local after July 2026; Byte-, idle-, and deadline-bounded response-body readers without the broad media runtime surface |
    | `plugin-sdk/session-binding-runtime` | Private-local after July 2026; Current conversation binding state without configured binding routing or pairing stores |
    | `plugin-sdk/context-visibility-runtime` | Private-local after July 2026; Context visibility resolution and supplemental context filtering without broad config/security imports |
    | `plugin-sdk/string-coerce-runtime` | Narrow primitive record/string coercion and normalization helpers without markdown/logging imports |
    | `plugin-sdk/html-entity-runtime` | Private-local after July 2026; Single-pass semicolon-terminated HTML5 entity decoding without broad text utilities |
    | `plugin-sdk/text-utility-runtime` | Private-local after July 2026; Low-level text and path helpers, including five-entity HTML escaping |
    | `plugin-sdk/widget-html` | Complete-document detection, size validation, and tool input errors for self-contained HTML widgets |
    | `plugin-sdk/host-runtime` | Private-local after July 2026; Hostname and SCP host normalization helpers |
    | `plugin-sdk/retry-runtime` | Private-local after July 2026; Retry config and retry runner helpers |
    | `plugin-sdk/agent-runtime` | Deprecated broad barrel for agent dir/identity/workspace helpers, including `resolveAgentDir`, `resolveDefaultAgentDir`, and the deprecated `resolveOpenClawAgentDir` compatibility export; prefer focused agent/runtime subpaths |
    | `plugin-sdk/directory-runtime` | Config-backed directory query/dedup |
    | `plugin-sdk/keyed-async-queue` | Private-local after July 2026; `KeyedAsyncQueue` |
  </Accordion>

  <Accordion title="Capability and testing subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/media-runtime` | Deprecated broad media barrel including `saveRemoteMedia`, `saveResponseMedia`, `readRemoteMediaBuffer`, and deprecated `fetchRemoteMedia`; prefer `plugin-sdk/media-store`, `plugin-sdk/media-mime`, `plugin-sdk/outbound-media`, and capability runtime subpaths, and prefer store helpers before buffer reads when a URL should become OpenClaw media |
    | `plugin-sdk/media-mime` | Narrow MIME normalization, file-extension mapping, MIME detection, and media-kind helpers |
    | `plugin-sdk/media-store` | Narrow media store helpers such as `saveMediaBuffer` and `saveMediaStream` |
    | `plugin-sdk/media-generation-runtime` | Private-local after July 2026; Shared media-generation failover helpers, candidate selection, and missing-model messaging |
    | `plugin-sdk/media-understanding` | Deprecated compatibility facade for media-understanding provider types and helpers; new providers register through the injected plugin API and keep request helpers plugin-owned |
    | `plugin-sdk/text-chunking` | Outbound text and offset-preserving range chunking, markdown chunking/render helpers, quote-aware HTML tag tokenization, markdown table conversion, directive-tag stripping, and safe-text utilities |
    | `plugin-sdk/speech` | Private-local after July 2026; Speech provider types plus provider-facing directive, registry, validation, OpenAI-compatible TTS builder, and speech helper exports |
    | `plugin-sdk/speech-core` | Private-local after July 2026; Shared speech provider types, registry, directive, normalization, and speech helper exports |
    | `plugin-sdk/speech-settings` | Lightweight TTS config resolution and normalization primitives without provider registries or synthesis runtime |
    | `plugin-sdk/realtime-transcription` | Private-local after July 2026; Realtime transcription provider types, registry helpers, and shared WebSocket session helper |
    | `plugin-sdk/realtime-bootstrap-context` | Private-local after July 2026; Realtime profile bootstrap helper for bounded `IDENTITY.md`, `USER.md`, and `SOUL.md` context injection |
    | `plugin-sdk/realtime-voice` | Private-local after July 2026; Realtime voice provider types, registry helpers, shared audio-energy/speech-onset gates, and realtime voice behavior helpers, including the transport-independent session harness and output activity tracking |
    | `plugin-sdk/meeting-runtime` | Browser-meeting session runtime, realtime audio engines/transports, `MeetingPlatformAdapter`, browser/node control, agent-consult, voice-call delegation, setup checks, and SoX command helpers |
    | `plugin-sdk/image-generation` | Private-local after July 2026; Image generation provider types plus image asset/data URL helpers and the OpenAI-compatible image provider builder |
    | `plugin-sdk/image-generation-core` | Private-local after July 2026; Shared image-generation types, failover, auth, and registry helpers |
    | `plugin-sdk/music-generation` | Private-local after July 2026; Music generation provider/request/result types |
    | `plugin-sdk/video-generation` | Private-local after July 2026; Video generation provider/request/result types |
    | `plugin-sdk/video-generation-core` | Private-local after July 2026; Shared video-generation types, failover helpers, provider lookup, and model-ref parsing |
    | `plugin-sdk/transcripts` | Private-local after July 2026; Shared transcript source provider types, registry helpers, meeting-provider bridge factory, session descriptors, and utterance metadata |
    | `plugin-sdk/webhook-targets` | Private-local after July 2026; Webhook target registry and route-install helpers |
    | `plugin-sdk/web-media` | Shared remote/local media loading helpers |
    | `plugin-sdk/zod` | Deprecated compatibility re-export; import `zod` from `zod` directly |
    | `plugin-sdk/plugin-test-api` | Repo-local minimal `createTestPluginApi` helper for direct plugin registration unit tests without importing repo test helper bridges |
    | `plugin-sdk/agent-runtime-test-contracts` | Repo-local native agent-runtime adapter contract fixtures for auth, delivery, fallback, tool-hook, prompt-overlay, schema, and transcript projection tests |
    | `plugin-sdk/channel-test-helpers` | Repo-local channel-oriented test helpers for generic actions/setup/status contracts, directory assertions, account startup lifecycle, send-config threading, runtime mocks, status issues, outbound delivery, and hook registration |
    | `plugin-sdk/channel-target-testing` | Repo-local shared target-resolution error-case suite for channel tests |
    | `plugin-sdk/channel-contract-testing` | Repo-local narrow channel contract test helpers without the broad testing barrel |
    | `plugin-sdk/plugin-test-contracts` | Repo-local plugin package, registration, public artifact, direct import, runtime API, and import side-effect contract helpers |
    | `plugin-sdk/plugin-state-test-runtime` | Repo-local plugin state store, ingress queue, and state DB test helpers |
    | `plugin-sdk/provider-test-contracts` | Repo-local provider runtime, auth, discovery, onboard, catalog, wizard, media capability, replay policy, realtime STT live-audio, web-search/fetch, and stream contract helpers |
    | `plugin-sdk/provider-http-test-mocks` | Private-local after July 2026; Repo-local opt-in Vitest HTTP/auth mocks for provider tests that exercise `plugin-sdk/provider-http` |
    | `plugin-sdk/reply-payload-testing` | Repo-local helpers for attaching metadata to reply payload fixtures |
    | `plugin-sdk/sqlite-runtime-testing` | Repo-local SQLite lifecycle helpers for first-party tests |
    | `plugin-sdk/test-fixtures` | Repo-local generic CLI runtime capture, sandbox context, skill writer, agent-message, system-event, module reload, bundled plugin path, terminal-text, chunking, auth-token, and typed-case fixtures |
    | `plugin-sdk/test-node-mocks` | Repo-local focused Node builtin mock helpers for use inside Vitest `vi.mock("node:*")` factories |
  </Accordion>

  <Accordion title="Memory subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/memory-core-host-embedding-registry` | Private-local after July 2026; Lightweight memory embedding provider registry helpers |
    | `plugin-sdk/memory-core-host-engine-foundation` | Memory host foundation engine exports |
    | `plugin-sdk/memory-core-host-engine-embeddings` | Private-local after July 2026; Memory host embedding contracts, registry access, local provider, and generic batch/remote helpers. `registerMemoryEmbeddingProvider` on this surface is deprecated; use the generic embedding provider API for new providers. |
    | `plugin-sdk/memory-core-host-engine-qmd` | Private-local after July 2026; Memory host QMD engine exports |
    | `plugin-sdk/memory-core-host-engine-storage` | Private-local after July 2026; Memory host storage engine exports |
    | `plugin-sdk/memory-core-host-secret` | Private-local after July 2026; Memory host secret helpers |
    | `plugin-sdk/memory-core-host-status` | Private-local after July 2026; Memory host status helpers |
    | `plugin-sdk/memory-core-host-runtime-cli` | Private-local after July 2026; Memory host CLI runtime helpers |
    | `plugin-sdk/memory-core-host-runtime-core` | Private-local after July 2026; Memory host core runtime helpers |
    | `plugin-sdk/memory-core-host-runtime-files` | Private-local after July 2026; Memory host file/runtime helpers |
    | `plugin-sdk/memory-host-core` | Deprecated compatibility facade for vendor-neutral memory host helpers. New memory plugins use injected memory capabilities and host-prepared prompts; companion plugins still use the retained facade for public-artifact discovery until a focused read seam exists. |
    | `plugin-sdk/memory-host-events` | Private-local after July 2026; Vendor-neutral alias for memory host event journal helpers |
    | `plugin-sdk/memory-host-markdown` | Private-local after July 2026; Shared managed-markdown helpers for memory-adjacent plugins |
    | `plugin-sdk/memory-host-search` | Private-local after July 2026; Active memory runtime facade for search-manager access |
  </Accordion>

  <Accordion title="Reserved bundled-helper subpaths">
    Reserved bundled-helper SDK subpaths are narrow owner-specific surfaces for
    bundled plugin code. They are tracked in the SDK inventory so package
    builds and aliasing stay deterministic, but they are not general plugin
    authoring APIs. New reusable host contracts should use generic SDK subpaths
    such as `plugin-sdk/gateway-runtime` and `plugin-sdk/ssrf-runtime`.

    | Subpath | Owner and purpose |
    | --- | --- |
    | `plugin-sdk/codex-mcp-projection` | Private-local after July 2026; Bundled Codex plugin helper for projecting user MCP server config into Codex app-server thread config (reserved package export) |
    | `plugin-sdk/codex-native-task-runtime` | Bundled Codex plugin helper for mirroring Codex app-server native subagents into OpenClaw task state (repo-local only, not a package export) |

  </Accordion>
</AccordionGroup>

## Related

- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
