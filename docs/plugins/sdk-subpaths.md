---
summary: "Plugin SDK subpath catalog: which imports live where, grouped by area"
read_when:
  - Choosing the right plugin-sdk subpath for a plugin import
  - Auditing bundled-plugin subpaths and helper surfaces
title: "Plugin SDK subpaths"
---

The plugin SDK is exposed as a set of narrow subpaths under `openclaw/plugin-sdk/`.
This page catalogs the commonly used subpaths grouped by purpose. The generated
full list of 200+ subpaths lives in `scripts/lib/plugin-sdk-entrypoints.json`;
reserved bundled-plugin helper subpaths appear there but are implementation
detail unless a doc page explicitly promotes them. Maintainers can audit active
reserved helper subpaths with `pnpm plugins:boundary-report:summary`; unused
reserved helper exports fail the CI report instead of staying in the public SDK
as dormant compatibility debt.

For the plugin authoring guide, see [Plugin SDK overview](/plugins/sdk-overview).

## Plugin entry

| Subpath                                   | Key exports                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry`                 | `definePluginEntry`                                                                                                                                                          |
| `plugin-sdk/core`                         | `defineChannelPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `defineSetupPluginEntry`, `buildChannelConfigSchema`, `buildJsonChannelConfigSchema`       |
| `plugin-sdk/config-schema`                | `OpenClawSchema`                                                                                                                                                             |
| `plugin-sdk/provider-entry`               | `defineSingleProviderPluginEntry`                                                                                                                                            |
| `plugin-sdk/testing`                      | Broad compatibility barrel for legacy plugin tests; prefer focused test subpaths for new extension tests                                                                     |
| `plugin-sdk/plugin-test-api`              | Minimal `OpenClawPluginApi` mock builder for direct plugin registration unit tests                                                                                           |
| `plugin-sdk/agent-runtime-test-contracts` | Native agent-runtime adapter contract fixtures for auth profiles, delivery suppression, fallback classification, tool hooks, prompt overlays, schemas, and transcript repair |
| `plugin-sdk/channel-test-helpers`         | Channel account lifecycle, directory, send-config, runtime mock, hook, bundled channel entry, envelope timestamp, pairing reply, and generic channel contract test helpers   |
| `plugin-sdk/channel-target-testing`       | Shared channel target-resolution error-case test suite                                                                                                                       |
| `plugin-sdk/plugin-test-contracts`        | Plugin registration, package manifest, public artifact, runtime API, import side-effect, and direct import contract helpers                                                  |
| `plugin-sdk/plugin-test-runtime`          | Plugin runtime, registry, provider-registration, setup-wizard, and runtime task-flow fixtures for tests                                                                      |
| `plugin-sdk/provider-test-contracts`      | Provider runtime, auth, discovery, onboard, catalog, media capability, replay policy, realtime STT live-audio, web-search/fetch, and wizard contract helpers                 |
| `plugin-sdk/provider-http-test-mocks`     | Opt-in Vitest HTTP/auth mocks for provider tests that exercise `plugin-sdk/provider-http`                                                                                    |
| `plugin-sdk/test-env`                     | Test environment, fetch/network, disposable HTTP server, incoming request, live-test, temporary filesystem, and time-control fixtures                                        |
| `plugin-sdk/test-fixtures`                | Generic CLI, sandbox, skill, agent-message, system-event, module reload, bundled plugin path, terminal, chunking, auth-token, and typed-case test fixtures                   |
| `plugin-sdk/test-node-mocks`              | Focused Node builtin mock helpers for use inside Vitest `vi.mock("node:*")` factories                                                                                        |
| `plugin-sdk/migration`                    | Migration provider item helpers such as `createMigrationItem`, reason constants, item status markers, redaction helpers, and `summarizeMigrationItems`                       |
| `plugin-sdk/migration-runtime`            | Runtime migration helpers such as `copyMigrationFileItem`, `withCachedMigrationConfigRuntime`, and `writeMigrationReport`                                                    |

<AccordionGroup>
  <Accordion title="Channel subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/channel-core` | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase` |
    | `plugin-sdk/config-schema` | Root `openclaw.json` Zod schema export (`OpenClawSchema`) |
    | `plugin-sdk/channel-setup` | `createOptionalChannelSetupSurface`, `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`, plus `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`, `setSetupChannelEnabled`, `splitSetupEntries` |
    | `plugin-sdk/setup` | Shared setup wizard helpers, allowlist prompts, setup status builders |
    | `plugin-sdk/setup-runtime` | `createPatchedAccountSetupAdapter`, `createEnvPatchedAccountSetupAdapter`, `createSetupInputPresenceValidator`, `noteChannelLookupFailure`, `noteChannelLookupSummary`, `promptResolvedAllowFrom`, `splitSetupEntries`, `createAllowlistSetupWizardProxy`, `createDelegatedSetupWizardProxy` |
    | `plugin-sdk/setup-adapter-runtime` | `createEnvPatchedAccountSetupAdapter` |
    | `plugin-sdk/setup-tools` | `formatCliCommand`, `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`, `CONFIG_DIR` |
    | `plugin-sdk/account-core` | Multi-account config/action-gate helpers, default-account fallback helpers |
    | `plugin-sdk/account-id` | `DEFAULT_ACCOUNT_ID`, account-id normalization helpers |
    | `plugin-sdk/account-resolution` | Account lookup + default-fallback helpers |
    | `plugin-sdk/account-helpers` | Narrow account-list/account-action helpers |
    | `plugin-sdk/channel-pairing` | `createChannelPairingController` |
    | `plugin-sdk/channel-reply-pipeline` | `createChannelReplyPipeline`, `resolveChannelSourceReplyDeliveryMode` |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter`, `resolveChannelDmAccess`, `resolveChannelDmAllowFrom`, `resolveChannelDmPolicy`, `normalizeChannelDmPolicy`, `normalizeLegacyDmAliases` |
    | `plugin-sdk/channel-config-schema` | Shared channel config schema primitives plus Zod and direct JSON/TypeBox builders |
    | `plugin-sdk/bundled-channel-config-schema` | Bundled OpenClaw channel config schemas for maintained bundled plugins only |
    | `plugin-sdk/channel-config-schema-legacy` | Deprecated compatibility alias for bundled-channel config schemas |
    | `plugin-sdk/telegram-command-config` | Telegram custom-command normalization/validation helpers with bundled-contract fallback |
    | `plugin-sdk/command-gating` | Narrow command authorization gate helpers |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-lifecycle` | `createAccountStatusSink`, `createChannelRunQueue`, draft stream lifecycle/finalization helpers |
    | `plugin-sdk/inbound-envelope` | Shared inbound route + envelope builder helpers |
    | `plugin-sdk/inbound-reply-dispatch` | Shared inbound record-and-dispatch helpers |
    | `plugin-sdk/messaging-targets` | Target parsing/matching helpers |
    | `plugin-sdk/outbound-media` | Shared outbound media loading helpers |
    | `plugin-sdk/outbound-send-deps` | Lightweight outbound send dependency lookup for channel adapters |
    | `plugin-sdk/outbound-runtime` | Outbound delivery, identity, send delegate, session, formatting, and payload planning helpers |
    | `plugin-sdk/poll-runtime` | Narrow poll normalization helpers |
    | `plugin-sdk/thread-bindings-runtime` | Thread-binding lifecycle and adapter helpers |
    | `plugin-sdk/agent-media-payload` | Legacy agent media payload builder |
    | `plugin-sdk/conversation-runtime` | Conversation/thread binding, pairing, and configured-binding helpers |
    | `plugin-sdk/runtime-config-snapshot` | Runtime config snapshot helper |
    | `plugin-sdk/runtime-group-policy` | Runtime group-policy resolution helpers |
    | `plugin-sdk/channel-status` | Shared channel status snapshot/summary helpers |
    | `plugin-sdk/channel-config-primitives` | Narrow channel config-schema primitives |
    | `plugin-sdk/channel-config-writes` | Channel config-write authorization helpers |
    | `plugin-sdk/channel-plugin-common` | Shared channel plugin prelude exports |
    | `plugin-sdk/allowlist-config-edit` | Allowlist config edit/read helpers |
    | `plugin-sdk/group-access` | Shared group-access decision helpers |
    | `plugin-sdk/direct-dm` | Shared direct-DM auth/guard helpers |
    | `plugin-sdk/discord` | Deprecated Discord compatibility facade for published `@openclaw/discord@2026.3.13` and tracked owner compatibility; new plugins should use generic channel SDK subpaths |
    | `plugin-sdk/telegram-account` | Deprecated Telegram account-resolution compatibility facade for tracked owner compatibility; new plugins should use injected runtime helpers or generic channel SDK subpaths |
    | `plugin-sdk/zalouser` | Deprecated Zalo Personal compatibility facade for published Lark/Zalo packages that still import sender command authorization; new plugins should use `plugin-sdk/command-auth` |
    | `plugin-sdk/interactive-runtime` | Semantic message presentation, delivery, and legacy interactive reply helpers. See [Message Presentation](/plugins/message-presentation) |
    | `plugin-sdk/channel-inbound` | Compatibility barrel for inbound debounce, mention matching, mention-policy helpers, and envelope helpers |
    | `plugin-sdk/channel-inbound-debounce` | Narrow inbound debounce helpers |
    | `plugin-sdk/channel-mention-gating` | Narrow mention-policy, mention marker, and mention text helpers without the broader inbound runtime surface |
    | `plugin-sdk/channel-envelope` | Narrow inbound envelope formatting helpers |
    | `plugin-sdk/channel-location` | Channel location context and formatting helpers |
    | `plugin-sdk/channel-logging` | Channel logging helpers for inbound drops and typing/ack failures |
    | `plugin-sdk/channel-send-result` | Reply result types |
    | `plugin-sdk/channel-actions` | Channel message-action helpers, plus deprecated native schema helpers kept for plugin compatibility |
    | `plugin-sdk/channel-route` | Shared route normalization, parser-driven target resolution, thread-id stringification, dedupe/compact route keys, parsed-target types, and route/target comparison helpers |
    | `plugin-sdk/channel-targets` | Target parsing helpers; route comparison callers should use `plugin-sdk/channel-route` |
    | `plugin-sdk/channel-contract` | Channel contract types |
    | `plugin-sdk/channel-feedback` | Feedback/reaction wiring |
    | `plugin-sdk/channel-secret-runtime` | Narrow secret-contract helpers such as `collectSimpleChannelFieldAssignments`, `getChannelSurface`, `pushAssignment`, and secret target types |
  </Accordion>

  <Accordion title="Provider subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry` |
    | `plugin-sdk/lmstudio` | Supported LM Studio provider facade for setup, catalog discovery, and runtime model preparation |
    | `plugin-sdk/lmstudio-runtime` | Supported LM Studio runtime facade for local server defaults, model discovery, request headers, and loaded-model helpers |
    | `plugin-sdk/provider-setup` | Curated local/self-hosted provider setup helpers |
    | `plugin-sdk/self-hosted-provider-setup` | Focused OpenAI-compatible self-hosted provider setup helpers |
    | `plugin-sdk/cli-backend` | CLI backend defaults + watchdog constants |
    | `plugin-sdk/provider-auth-runtime` | Runtime API-key resolution helpers for provider plugins |
    | `plugin-sdk/provider-auth-api-key` | API-key onboarding/profile-write helpers such as `upsertApiKeyProfile` |
    | `plugin-sdk/provider-auth-result` | Standard OAuth auth-result builder |
    | `plugin-sdk/provider-auth-login` | Shared interactive login helpers for provider plugins |
    | `plugin-sdk/provider-env-vars` | Provider auth env-var lookup helpers |
    | `plugin-sdk/provider-auth` | `createProviderApiKeyAuthMethod`, `ensureApiKeyFromOptionEnvOrPrompt`, `upsertAuthProfile`, `upsertApiKeyProfile`, `writeOAuthCredentials` |
    | `plugin-sdk/provider-model-shared` | `ProviderReplayFamily`, `buildProviderReplayFamilyHooks`, `normalizeModelCompat`, shared replay-policy builders, provider-endpoint helpers, and model-id normalization helpers such as `normalizeNativeXaiModelId` |
    | `plugin-sdk/provider-catalog-runtime` | Provider catalog augmentation runtime hook and plugin-provider registry seams for contract tests |
    | `plugin-sdk/provider-catalog-shared` | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `buildManifestModelProviderConfig`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
    | `plugin-sdk/provider-http` | Generic provider HTTP/endpoint capability helpers, provider HTTP errors, and audio transcription multipart form helpers |
    | `plugin-sdk/provider-web-fetch-contract` | Narrow web-fetch config/selection contract helpers such as `enablePluginInConfig` and `WebFetchProviderPlugin` |
    | `plugin-sdk/provider-web-fetch` | Web-fetch provider registration/cache helpers |
    | `plugin-sdk/provider-web-search-config-contract` | Narrow web-search config/credential helpers for providers that do not need plugin-enable wiring |
    | `plugin-sdk/provider-web-search-contract` | Narrow web-search config/credential contract helpers such as `createWebSearchProviderContractFields`, `enablePluginInConfig`, `resolveProviderWebSearchPluginConfig`, and scoped credential setters/getters |
    | `plugin-sdk/provider-web-search` | Web-search provider registration/cache/runtime helpers |
    | `plugin-sdk/provider-tools` | `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, Gemini schema cleanup + diagnostics, and xAI compat helpers such as `resolveXaiModelCompatPatch` / `applyXaiModelCompat` |
    | `plugin-sdk/provider-usage` | `fetchClaudeUsage` and similar |
    | `plugin-sdk/provider-stream` | `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, and shared Anthropic/Bedrock/DeepSeek V4/Google/Kilocode/Moonshot/OpenAI/OpenRouter/Z.A.I/MiniMax/Copilot wrapper helpers |
    | `plugin-sdk/provider-transport-runtime` | Native provider transport helpers such as guarded fetch, transport message transforms, and writable transport event streams |
    | `plugin-sdk/provider-onboard` | Onboarding config patch helpers |
    | `plugin-sdk/global-singleton` | Process-local singleton/map/cache helpers |
    | `plugin-sdk/group-activation` | Narrow group activation mode and command parsing helpers |
  </Accordion>

  <Accordion title="Auth and security subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/command-auth` | `resolveControlCommandGate`, command registry helpers including dynamic argument menu formatting, sender-authorization helpers |
    | `plugin-sdk/command-status` | Command/help message builders such as `buildCommandsMessagePaginated` and `buildHelpMessage` |
    | `plugin-sdk/approval-auth-runtime` | Approver resolution and same-chat action-auth helpers |
    | `plugin-sdk/approval-client-runtime` | Native exec approval profile/filter helpers |
    | `plugin-sdk/approval-delivery-runtime` | Native approval capability/delivery adapters |
    | `plugin-sdk/approval-gateway-runtime` | Shared approval gateway-resolution helper |
    | `plugin-sdk/approval-handler-adapter-runtime` | Lightweight native approval adapter loading helpers for hot channel entrypoints |
    | `plugin-sdk/approval-handler-runtime` | Broader approval handler runtime helpers; prefer the narrower adapter/gateway seams when they are enough |
    | `plugin-sdk/approval-native-runtime` | Native approval target + account-binding helpers |
    | `plugin-sdk/approval-reply-runtime` | Exec/plugin approval reply payload helpers |
    | `plugin-sdk/approval-runtime` | Exec/plugin approval payload helpers, native approval routing/runtime helpers, and structured approval display helpers such as `formatApprovalDisplayPath` |
    | `plugin-sdk/reply-dedupe` | Narrow inbound reply dedupe reset helpers |
    | `plugin-sdk/channel-contract-testing` | Narrow channel contract test helpers without the broad testing barrel |
    | `plugin-sdk/command-auth-native` | Native command auth, dynamic argument menu formatting, and native session-target helpers |
    | `plugin-sdk/command-detection` | Shared command detection helpers |
    | `plugin-sdk/command-primitives-runtime` | Lightweight command text predicates for hot channel paths |
    | `plugin-sdk/command-surface` | Command-body normalization and command-surface helpers |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/channel-secret-runtime` | Narrow secret-contract collection helpers for channel/plugin secret surfaces |
    | `plugin-sdk/secret-ref-runtime` | Narrow `coerceSecretRef` and SecretRef typing helpers for secret-contract/config parsing |
    | `plugin-sdk/security-runtime` | Shared trust, DM gating, external-content, sensitive text redaction, constant-time secret comparison, and secret-collection helpers |
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
    | `plugin-sdk/runtime` | Broad runtime/logging/backup/plugin-install helpers |
    | `plugin-sdk/runtime-env` | Narrow runtime env, logger, timeout, retry, and backoff helpers |
    | `plugin-sdk/browser-config` | Supported browser config facade for normalized profile/defaults, CDP URL parsing, and browser-control auth helpers |
    | `plugin-sdk/channel-runtime-context` | Generic channel runtime-context registration and lookup helpers |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/plugin-runtime` | Shared plugin command/hook/http/interactive helpers |
    | `plugin-sdk/hook-runtime` | Shared webhook/internal hook pipeline helpers |
    | `plugin-sdk/lazy-runtime` | Lazy runtime import/binding helpers such as `createLazyRuntimeModule`, `createLazyRuntimeMethod`, and `createLazyRuntimeSurface` |
    | `plugin-sdk/process-runtime` | Process exec helpers |
    | `plugin-sdk/cli-runtime` | CLI formatting, wait, version, argument-invocation, and lazy command-group helpers |
    | `plugin-sdk/gateway-runtime` | Gateway client, event-loop-ready client start helper, gateway CLI RPC, gateway protocol errors, and channel-status patch helpers |
    | `plugin-sdk/config-types` | Type-only config surface for plugin config shapes such as `OpenClawConfig` and channel/provider config types |
    | `plugin-sdk/plugin-config-runtime` | Runtime plugin-config lookup helpers such as `requireRuntimeConfig`, `resolvePluginConfigObject`, and `resolveLivePluginConfigObject` |
    | `plugin-sdk/config-mutation` | Transactional config mutation helpers such as `mutateConfigFile`, `replaceConfigFile`, and `logConfigUpdated` |
    | `plugin-sdk/runtime-config-snapshot` | Current process config snapshot helpers such as `getRuntimeConfig`, `getRuntimeConfigSnapshot`, and test snapshot setters |
    | `plugin-sdk/telegram-command-config` | Telegram command-name/description normalization and duplicate/conflict checks, even when the bundled Telegram contract surface is unavailable |
    | `plugin-sdk/text-autolink-runtime` | File-reference autolink detection without the broad text-runtime barrel |
    | `plugin-sdk/approval-runtime` | Exec/plugin approval helpers, approval-capability builders, auth/profile helpers, native routing/runtime helpers, and structured approval display path formatting |
    | `plugin-sdk/reply-runtime` | Shared inbound/reply runtime helpers, chunking, dispatch, heartbeat, reply planner |
    | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch/finalize and conversation-label helpers |
    | `plugin-sdk/reply-history` | Shared short-window reply-history helpers and markers such as `buildHistoryContext`, `HISTORY_CONTEXT_MARKER`, `recordPendingHistoryEntry`, and `clearHistoryEntriesIfEnabled` |
    | `plugin-sdk/reply-reference` | `createReplyReferencePlanner` |
    | `plugin-sdk/reply-chunking` | Narrow text/markdown chunking helpers |
    | `plugin-sdk/session-store-runtime` | Session store path, session-key, updated-at, and store mutation helpers |
    | `plugin-sdk/cron-store-runtime` | Cron store path/load/save helpers |
    | `plugin-sdk/state-paths` | State/OAuth dir path helpers |
    | `plugin-sdk/routing` | Route/session-key/account binding helpers such as `resolveAgentRoute`, `buildAgentSessionKey`, and `resolveDefaultAgentBoundAccountId` |
    | `plugin-sdk/status-helpers` | Shared channel/account status summary helpers, runtime-state defaults, and issue metadata helpers |
    | `plugin-sdk/target-resolver-runtime` | Shared target resolver helpers |
    | `plugin-sdk/string-normalization-runtime` | Slug/string normalization helpers |
    | `plugin-sdk/request-url` | Extract string URLs from fetch/request-like inputs |
    | `plugin-sdk/run-command` | Timed command runner with normalized stdout/stderr results |
    | `plugin-sdk/param-readers` | Common tool/CLI param readers |
    | `plugin-sdk/tool-payload` | Extract normalized payloads from tool result objects |
    | `plugin-sdk/tool-send` | Extract canonical send target fields from tool args |
    | `plugin-sdk/temp-path` | Shared temp-download path helpers |
    | `plugin-sdk/logging-core` | Subsystem logger and redaction helpers |
    | `plugin-sdk/markdown-table-runtime` | Markdown table mode and conversion helpers |
    | `plugin-sdk/model-session-runtime` | Model/session override helpers such as `applyModelOverrideToSessionEntry` and `resolveAgentMaxConcurrent` |
    | `plugin-sdk/talk-config-runtime` | Talk provider config resolution helpers |
    | `plugin-sdk/json-store` | Small JSON state read/write helpers |
    | `plugin-sdk/file-lock` | Re-entrant file-lock helpers |
    | `plugin-sdk/persistent-dedupe` | Disk-backed dedupe cache helpers |
    | `plugin-sdk/acp-runtime` | ACP runtime/session and reply-dispatch helpers |
    | `plugin-sdk/acp-runtime-backend` | Lightweight ACP backend registration and reply-dispatch helpers for startup-loaded plugins |
    | `plugin-sdk/acp-binding-resolve-runtime` | Read-only ACP binding resolution without lifecycle startup imports |
    | `plugin-sdk/agent-config-primitives` | Narrow agent runtime config-schema primitives |
    | `plugin-sdk/boolean-param` | Loose boolean param reader |
    | `plugin-sdk/dangerous-name-runtime` | Dangerous-name matching resolution helpers |
    | `plugin-sdk/device-bootstrap` | Device bootstrap and pairing token helpers |
    | `plugin-sdk/extension-shared` | Shared passive-channel, status, and ambient proxy helper primitives |
    | `plugin-sdk/models-provider-runtime` | `/models` command/provider reply helpers |
    | `plugin-sdk/skill-commands-runtime` | Skill command listing helpers |
    | `plugin-sdk/native-command-registry` | Native command registry/build/serialize helpers |
    | `plugin-sdk/agent-harness` | Experimental trusted-plugin surface for low-level agent harnesses: harness types, active-run steer/abort helpers, OpenClaw tool bridge helpers, runtime-plan tool policy helpers, terminal outcome classification, tool progress formatting/detail helpers, and attempt result utilities |
    | `plugin-sdk/provider-zai-endpoint` | Z.AI endpoint detection helpers |
    | `plugin-sdk/async-lock-runtime` | Process-local async lock helper for small runtime state files |
    | `plugin-sdk/channel-activity-runtime` | Channel activity telemetry helper |
    | `plugin-sdk/concurrency-runtime` | Bounded async task concurrency helper |
    | `plugin-sdk/dedupe-runtime` | In-memory dedupe cache helpers |
    | `plugin-sdk/delivery-queue-runtime` | Outbound pending-delivery drain helper |
    | `plugin-sdk/file-access-runtime` | Safe local-file and media-source path helpers |
    | `plugin-sdk/heartbeat-runtime` | Heartbeat event and visibility helpers |
    | `plugin-sdk/number-runtime` | Numeric coercion helper |
    | `plugin-sdk/secure-random-runtime` | Secure token/UUID helpers |
    | `plugin-sdk/system-event-runtime` | System event queue helpers |
    | `plugin-sdk/transport-ready-runtime` | Transport readiness wait helper |
    | `plugin-sdk/infra-runtime` | Deprecated compatibility shim; use the focused runtime subpaths above |
    | `plugin-sdk/collection-runtime` | Small bounded cache helpers |
    | `plugin-sdk/diagnostic-runtime` | Diagnostic flag, event, and trace-context helpers |
    | `plugin-sdk/error-runtime` | Error graph, formatting, shared error classification helpers, `isApprovalNotFoundError` |
    | `plugin-sdk/fetch-runtime` | Wrapped fetch, proxy, EnvHttpProxyAgent option, and pinned lookup helpers |
    | `plugin-sdk/runtime-fetch` | Dispatcher-aware runtime fetch without proxy/guarded-fetch imports |
    | `plugin-sdk/response-limit-runtime` | Bounded response-body reader without the broad media runtime surface |
    | `plugin-sdk/session-binding-runtime` | Current conversation binding state without configured binding routing or pairing stores |
    | `plugin-sdk/session-store-runtime` | Session-store helpers without broad config writes/maintenance imports |
    | `plugin-sdk/context-visibility-runtime` | Context visibility resolution and supplemental context filtering without broad config/security imports |
    | `plugin-sdk/string-coerce-runtime` | Narrow primitive record/string coercion and normalization helpers without markdown/logging imports |
    | `plugin-sdk/host-runtime` | Hostname and SCP host normalization helpers |
    | `plugin-sdk/retry-runtime` | Retry config and retry runner helpers |
    | `plugin-sdk/agent-runtime` | Agent dir/identity/workspace helpers |
    | `plugin-sdk/directory-runtime` | Config-backed directory query/dedup |
    | `plugin-sdk/keyed-async-queue` | `KeyedAsyncQueue` |
  </Accordion>

  <Accordion title="Capability and testing subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/media-runtime` | Shared media fetch/transform/store helpers, ffprobe-backed video dimension probing, and media payload builders |
    | `plugin-sdk/media-store` | Narrow media store helpers such as `saveMediaBuffer` |
    | `plugin-sdk/media-generation-runtime` | Shared media-generation failover helpers, candidate selection, and missing-model messaging |
    | `plugin-sdk/media-understanding` | Media understanding provider types plus provider-facing image/audio helper exports |
    | `plugin-sdk/text-runtime` | Shared text/markdown/logging helpers such as assistant-visible-text stripping, markdown render/chunking/table helpers, redaction helpers, directive-tag helpers, and safe-text utilities |
    | `plugin-sdk/text-chunking` | Outbound text chunking helper |
    | `plugin-sdk/speech` | Speech provider types plus provider-facing directive, registry, validation, OpenAI-compatible TTS builder, and speech helper exports |
    | `plugin-sdk/speech-core` | Shared speech provider types, registry, directive, normalization, and speech helper exports |
    | `plugin-sdk/realtime-transcription` | Realtime transcription provider types, registry helpers, and shared WebSocket session helper |
    | `plugin-sdk/realtime-voice` | Realtime voice provider types and registry helpers |
    | `plugin-sdk/image-generation` | Image generation provider types plus image asset/data URL helpers and the OpenAI-compatible image provider builder |
    | `plugin-sdk/image-generation-core` | Shared image-generation types, failover, auth, and registry helpers |
    | `plugin-sdk/music-generation` | Music generation provider/request/result types |
    | `plugin-sdk/music-generation-core` | Shared music-generation types, failover helpers, provider lookup, and model-ref parsing |
    | `plugin-sdk/video-generation` | Video generation provider/request/result types |
    | `plugin-sdk/video-generation-core` | Shared video-generation types, failover helpers, provider lookup, and model-ref parsing |
    | `plugin-sdk/webhook-targets` | Webhook target registry and route-install helpers |
    | `plugin-sdk/webhook-path` | Webhook path normalization helpers |
    | `plugin-sdk/web-media` | Shared remote/local media loading helpers |
    | `plugin-sdk/zod` | Re-exported `zod` for plugin SDK consumers |
    | `plugin-sdk/testing` | Broad compatibility barrel for legacy plugin tests. New extension tests should import focused SDK subpaths such as `plugin-sdk/agent-runtime-test-contracts`, `plugin-sdk/plugin-test-runtime`, `plugin-sdk/channel-test-helpers`, `plugin-sdk/test-env`, or `plugin-sdk/test-fixtures` instead |
    | `plugin-sdk/plugin-test-api` | Minimal `createTestPluginApi` helper for direct plugin registration unit tests without importing repo test helper bridges |
    | `plugin-sdk/agent-runtime-test-contracts` | Native agent-runtime adapter contract fixtures for auth, delivery, fallback, tool-hook, prompt-overlay, schema, and transcript projection tests |
    | `plugin-sdk/channel-test-helpers` | Channel-oriented test helpers for generic actions/setup/status contracts, directory assertions, account startup lifecycle, send-config threading, runtime mocks, status issues, outbound delivery, and hook registration |
    | `plugin-sdk/channel-target-testing` | Shared target-resolution error-case suite for channel tests |
    | `plugin-sdk/plugin-test-contracts` | Plugin package, registration, public artifact, direct import, runtime API, and import side-effect contract helpers |
    | `plugin-sdk/provider-test-contracts` | Provider runtime, auth, discovery, onboard, catalog, wizard, media capability, replay policy, realtime STT live-audio, web-search/fetch, and stream contract helpers |
    | `plugin-sdk/provider-http-test-mocks` | Opt-in Vitest HTTP/auth mocks for provider tests that exercise `plugin-sdk/provider-http` |
    | `plugin-sdk/test-fixtures` | Generic CLI runtime capture, sandbox context, skill writer, agent-message, system-event, module reload, bundled plugin path, terminal-text, chunking, auth-token, and typed-case fixtures |
    | `plugin-sdk/test-node-mocks` | Focused Node builtin mock helpers for use inside Vitest `vi.mock("node:*")` factories |
  </Accordion>

  <Accordion title="Memory subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/memory-core` | Bundled memory-core helper surface for manager/config/file/CLI helpers |
    | `plugin-sdk/memory-core-engine-runtime` | Memory index/search runtime facade |
    | `plugin-sdk/memory-core-host-engine-foundation` | Memory host foundation engine exports |
    | `plugin-sdk/memory-core-host-engine-embeddings` | Memory host embedding contracts, registry access, local provider, and generic batch/remote helpers |
    | `plugin-sdk/memory-core-host-engine-qmd` | Memory host QMD engine exports |
    | `plugin-sdk/memory-core-host-engine-storage` | Memory host storage engine exports |
    | `plugin-sdk/memory-core-host-multimodal` | Memory host multimodal helpers |
    | `plugin-sdk/memory-core-host-query` | Memory host query helpers |
    | `plugin-sdk/memory-core-host-secret` | Memory host secret helpers |
    | `plugin-sdk/memory-core-host-events` | Memory host event journal helpers |
    | `plugin-sdk/memory-core-host-status` | Memory host status helpers |
    | `plugin-sdk/memory-core-host-runtime-cli` | Memory host CLI runtime helpers |
    | `plugin-sdk/memory-core-host-runtime-core` | Memory host core runtime helpers |
    | `plugin-sdk/memory-core-host-runtime-files` | Memory host file/runtime helpers |
    | `plugin-sdk/memory-host-core` | Vendor-neutral alias for memory host core runtime helpers |
    | `plugin-sdk/memory-host-events` | Vendor-neutral alias for memory host event journal helpers |
    | `plugin-sdk/memory-host-files` | Vendor-neutral alias for memory host file/runtime helpers |
    | `plugin-sdk/memory-host-markdown` | Shared managed-markdown helpers for memory-adjacent plugins |
    | `plugin-sdk/memory-host-search` | Active memory runtime facade for search-manager access |
    | `plugin-sdk/memory-host-status` | Vendor-neutral alias for memory host status helpers |
  </Accordion>

  <Accordion title="Reserved bundled-helper subpaths">
    There are currently no reserved bundled-helper SDK subpaths. Owner-specific
    helpers live inside the owning plugin package, while reusable host contracts
    use generic SDK subpaths such as `plugin-sdk/gateway-runtime`,
    `plugin-sdk/security-runtime`, and `plugin-sdk/plugin-config-runtime`.
  </Accordion>
</AccordionGroup>

## Related

- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
