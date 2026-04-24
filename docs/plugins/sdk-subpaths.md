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
detail unless a doc page explicitly promotes them.

For the plugin authoring guide, see [Plugin SDK overview](/plugins/sdk-overview).

## Plugin entry

| Subpath                     | Key exports                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-sdk/plugin-entry`   | `definePluginEntry`                                                                                                                    |
| `plugin-sdk/core`           | `defineChannelPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `defineSetupPluginEntry`, `buildChannelConfigSchema` |
| `plugin-sdk/config-schema`  | `OpenClawSchema`                                                                                                                       |
| `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry`                                                                                                      |

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
    | `plugin-sdk/channel-reply-pipeline` | `createChannelReplyPipeline` |
    | `plugin-sdk/channel-config-helpers` | `createHybridChannelConfigAdapter` |
    | `plugin-sdk/channel-config-schema` | Channel config schema types |
    | `plugin-sdk/telegram-command-config` | Telegram custom-command normalization/validation helpers with bundled-contract fallback |
    | `plugin-sdk/command-gating` | Narrow command authorization gate helpers |
    | `plugin-sdk/channel-policy` | `resolveChannelGroupRequireMention` |
    | `plugin-sdk/channel-lifecycle` | `createAccountStatusSink`, draft stream lifecycle/finalization helpers |
    | `plugin-sdk/inbound-envelope` | Shared inbound route + envelope builder helpers |
    | `plugin-sdk/inbound-reply-dispatch` | Shared inbound record-and-dispatch helpers |
    | `plugin-sdk/messaging-targets` | Target parsing/matching helpers |
    | `plugin-sdk/outbound-media` | Shared outbound media loading helpers |
    | `plugin-sdk/outbound-runtime` | Outbound identity, send delegate, and payload planning helpers |
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
    | `plugin-sdk/interactive-runtime` | Semantic message presentation, delivery, and legacy interactive reply helpers. See [Message Presentation](/plugins/message-presentation) |
    | `plugin-sdk/channel-inbound` | Compatibility barrel for inbound debounce, mention matching, mention-policy helpers, and envelope helpers |
    | `plugin-sdk/channel-inbound-debounce` | Narrow inbound debounce helpers |
    | `plugin-sdk/channel-mention-gating` | Narrow mention-policy and mention text helpers without the broader inbound runtime surface |
    | `plugin-sdk/channel-envelope` | Narrow inbound envelope formatting helpers |
    | `plugin-sdk/channel-location` | Channel location context and formatting helpers |
    | `plugin-sdk/channel-logging` | Channel logging helpers for inbound drops and typing/ack failures |
    | `plugin-sdk/channel-send-result` | Reply result types |
    | `plugin-sdk/channel-actions` | Channel message-action helpers, plus deprecated native schema helpers kept for plugin compatibility |
    | `plugin-sdk/channel-targets` | Target parsing/matching helpers |
    | `plugin-sdk/channel-contract` | Channel contract types |
    | `plugin-sdk/channel-feedback` | Feedback/reaction wiring |
    | `plugin-sdk/channel-secret-runtime` | Narrow secret-contract helpers such as `collectSimpleChannelFieldAssignments`, `getChannelSurface`, `pushAssignment`, and secret target types |
  </Accordion>

  <Accordion title="Provider subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/provider-entry` | `defineSingleProviderPluginEntry` |
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
    | `plugin-sdk/provider-catalog-shared` | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
    | `plugin-sdk/provider-http` | Generic provider HTTP/endpoint capability helpers, including audio transcription multipart form helpers |
    | `plugin-sdk/provider-web-fetch-contract` | Narrow web-fetch config/selection contract helpers such as `enablePluginInConfig` and `WebFetchProviderPlugin` |
    | `plugin-sdk/provider-web-fetch` | Web-fetch provider registration/cache helpers |
    | `plugin-sdk/provider-web-search-config-contract` | Narrow web-search config/credential helpers for providers that do not need plugin-enable wiring |
    | `plugin-sdk/provider-web-search-contract` | Narrow web-search config/credential contract helpers such as `createWebSearchProviderContractFields`, `enablePluginInConfig`, `resolveProviderWebSearchPluginConfig`, and scoped credential setters/getters |
    | `plugin-sdk/provider-web-search` | Web-search provider registration/cache/runtime helpers |
    | `plugin-sdk/provider-tools` | `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, Gemini schema cleanup + diagnostics, and xAI compat helpers such as `resolveXaiModelCompatPatch` / `applyXaiModelCompat` |
    | `plugin-sdk/provider-usage` | `fetchClaudeUsage` and similar |
    | `plugin-sdk/provider-stream` | `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, and shared Anthropic/Bedrock/Google/Kilocode/Moonshot/OpenAI/OpenRouter/Z.A.I/MiniMax/Copilot wrapper helpers |
    | `plugin-sdk/provider-transport-runtime` | Native provider transport helpers such as guarded fetch, transport message transforms, and writable transport event streams |
    | `plugin-sdk/provider-onboard` | Onboarding config patch helpers |
    | `plugin-sdk/global-singleton` | Process-local singleton/map/cache helpers |
    | `plugin-sdk/group-activation` | Narrow group activation mode and command parsing helpers |
  </Accordion>

  <Accordion title="Auth and security subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/command-auth` | `resolveControlCommandGate`, command registry helpers, sender-authorization helpers |
    | `plugin-sdk/command-status` | Command/help message builders such as `buildCommandsMessagePaginated` and `buildHelpMessage` |
    | `plugin-sdk/approval-auth-runtime` | Approver resolution and same-chat action-auth helpers |
    | `plugin-sdk/approval-client-runtime` | Native exec approval profile/filter helpers |
    | `plugin-sdk/approval-delivery-runtime` | Native approval capability/delivery adapters |
    | `plugin-sdk/approval-gateway-runtime` | Shared approval gateway-resolution helper |
    | `plugin-sdk/approval-handler-adapter-runtime` | Lightweight native approval adapter loading helpers for hot channel entrypoints |
    | `plugin-sdk/approval-handler-runtime` | Broader approval handler runtime helpers; prefer the narrower adapter/gateway seams when they are enough |
    | `plugin-sdk/approval-native-runtime` | Native approval target + account-binding helpers |
    | `plugin-sdk/approval-reply-runtime` | Exec/plugin approval reply payload helpers |
    | `plugin-sdk/reply-dedupe` | Narrow inbound reply dedupe reset helpers |
    | `plugin-sdk/channel-contract-testing` | Narrow channel contract test helpers without the broad testing barrel |
    | `plugin-sdk/command-auth-native` | Native command auth + native session-target helpers |
    | `plugin-sdk/command-detection` | Shared command detection helpers |
    | `plugin-sdk/command-primitives-runtime` | Lightweight command text predicates for hot channel paths |
    | `plugin-sdk/command-surface` | Command-body normalization and command-surface helpers |
    | `plugin-sdk/allow-from` | `formatAllowFromLowercase` |
    | `plugin-sdk/channel-secret-runtime` | Narrow secret-contract collection helpers for channel/plugin secret surfaces |
    | `plugin-sdk/secret-ref-runtime` | Narrow `coerceSecretRef` and SecretRef typing helpers for secret-contract/config parsing |
    | `plugin-sdk/security-runtime` | Shared trust, DM gating, external-content, and secret-collection helpers |
    | `plugin-sdk/ssrf-policy` | Host allowlist and private-network SSRF policy helpers |
    | `plugin-sdk/ssrf-dispatcher` | Narrow pinned-dispatcher helpers without the broad infra runtime surface |
    | `plugin-sdk/ssrf-runtime` | Pinned-dispatcher, SSRF-guarded fetch, and SSRF policy helpers |
    | `plugin-sdk/secret-input` | Secret input parsing helpers |
    | `plugin-sdk/webhook-ingress` | Webhook request/target helpers |
    | `plugin-sdk/webhook-request-guards` | Request body size/timeout helpers |
  </Accordion>

  <Accordion title="Runtime and storage subpaths">
    | Subpath | Key exports |
    | --- | --- |
    | `plugin-sdk/runtime` | Broad runtime/logging/backup/plugin-install helpers |
    | `plugin-sdk/runtime-env` | Narrow runtime env, logger, timeout, retry, and backoff helpers |
    | `plugin-sdk/channel-runtime-context` | Generic channel runtime-context registration and lookup helpers |
    | `plugin-sdk/runtime-store` | `createPluginRuntimeStore` |
    | `plugin-sdk/plugin-runtime` | Shared plugin command/hook/http/interactive helpers |
    | `plugin-sdk/hook-runtime` | Shared webhook/internal hook pipeline helpers |
    | `plugin-sdk/lazy-runtime` | Lazy runtime import/binding helpers such as `createLazyRuntimeModule`, `createLazyRuntimeMethod`, and `createLazyRuntimeSurface` |
    | `plugin-sdk/process-runtime` | Process exec helpers |
    | `plugin-sdk/cli-runtime` | CLI formatting, wait, and version helpers |
    | `plugin-sdk/gateway-runtime` | Gateway client and channel-status patch helpers |
    | `plugin-sdk/config-runtime` | Config load/write helpers and plugin-config lookup helpers |
    | `plugin-sdk/telegram-command-config` | Telegram command-name/description normalization and duplicate/conflict checks, even when the bundled Telegram contract surface is unavailable |
    | `plugin-sdk/text-autolink-runtime` | File-reference autolink detection without the broad text-runtime barrel |
    | `plugin-sdk/approval-runtime` | Exec/plugin approval helpers, approval-capability builders, auth/profile helpers, native routing/runtime helpers |
    | `plugin-sdk/reply-runtime` | Shared inbound/reply runtime helpers, chunking, dispatch, heartbeat, reply planner |
    | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch/finalize and conversation-label helpers |
    | `plugin-sdk/reply-history` | Shared short-window reply-history helpers such as `buildHistoryContext`, `recordPendingHistoryEntry`, and `clearHistoryEntriesIfEnabled` |
    | `plugin-sdk/reply-reference` | `createReplyReferencePlanner` |
    | `plugin-sdk/reply-chunking` | Narrow text/markdown chunking helpers |
    | `plugin-sdk/session-store-runtime` | Session store path + updated-at helpers |
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
    | `plugin-sdk/json-store` | Small JSON state read/write helpers |
    | `plugin-sdk/file-lock` | Re-entrant file-lock helpers |
    | `plugin-sdk/persistent-dedupe` | Disk-backed dedupe cache helpers |
    | `plugin-sdk/acp-runtime` | ACP runtime/session and reply-dispatch helpers |
    | `plugin-sdk/acp-binding-resolve-runtime` | Read-only ACP binding resolution without lifecycle startup imports |
    | `plugin-sdk/agent-config-primitives` | Narrow agent runtime config-schema primitives |
    | `plugin-sdk/boolean-param` | Loose boolean param reader |
    | `plugin-sdk/dangerous-name-runtime` | Dangerous-name matching resolution helpers |
    | `plugin-sdk/device-bootstrap` | Device bootstrap and pairing token helpers |
    | `plugin-sdk/extension-shared` | Shared passive-channel, status, and ambient proxy helper primitives |
    | `plugin-sdk/models-provider-runtime` | `/models` command/provider reply helpers |
    | `plugin-sdk/skill-commands-runtime` | Skill command listing helpers |
    | `plugin-sdk/native-command-registry` | Native command registry/build/serialize helpers |
    | `plugin-sdk/agent-harness` | Experimental trusted-plugin surface for low-level agent harnesses: harness types, active-run steer/abort helpers, OpenClaw tool bridge helpers, tool progress formatting/detail helpers, and attempt result utilities |
    | `plugin-sdk/provider-zai-endpoint` | Z.AI endpoint detection helpers |
    | `plugin-sdk/infra-runtime` | System event/heartbeat helpers |
    | `plugin-sdk/collection-runtime` | Small bounded cache helpers |
    | `plugin-sdk/diagnostic-runtime` | Diagnostic flag and event helpers |
    | `plugin-sdk/error-runtime` | Error graph, formatting, shared error classification helpers, `isApprovalNotFoundError` |
    | `plugin-sdk/fetch-runtime` | Wrapped fetch, proxy, and pinned lookup helpers |
    | `plugin-sdk/runtime-fetch` | Dispatcher-aware runtime fetch without proxy/guarded-fetch imports |
    | `plugin-sdk/response-limit-runtime` | Bounded response-body reader without the broad media runtime surface |
    | `plugin-sdk/session-binding-runtime` | Current conversation binding state without configured binding routing or pairing stores |
    | `plugin-sdk/session-store-runtime` | Session-store read helpers without broad config writes/maintenance imports |
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
    | `plugin-sdk/media-runtime` | Shared media fetch/transform/store helpers plus media payload builders |
    | `plugin-sdk/media-store` | Narrow media store helpers such as `saveMediaBuffer` |
    | `plugin-sdk/media-generation-runtime` | Shared media-generation failover helpers, candidate selection, and missing-model messaging |
    | `plugin-sdk/media-understanding` | Media understanding provider types plus provider-facing image/audio helper exports |
    | `plugin-sdk/text-runtime` | Shared text/markdown/logging helpers such as assistant-visible-text stripping, markdown render/chunking/table helpers, redaction helpers, directive-tag helpers, and safe-text utilities |
    | `plugin-sdk/text-chunking` | Outbound text chunking helper |
    | `plugin-sdk/speech` | Speech provider types plus provider-facing directive, registry, and validation helpers |
    | `plugin-sdk/speech-core` | Shared speech provider types, registry, directive, and normalization helpers |
    | `plugin-sdk/realtime-transcription` | Realtime transcription provider types, registry helpers, and shared WebSocket session helper |
    | `plugin-sdk/realtime-voice` | Realtime voice provider types and registry helpers |
    | `plugin-sdk/image-generation` | Image generation provider types |
    | `plugin-sdk/image-generation-core` | Shared image-generation types, failover, auth, and registry helpers |
    | `plugin-sdk/music-generation` | Music generation provider/request/result types |
    | `plugin-sdk/music-generation-core` | Shared music-generation types, failover helpers, provider lookup, and model-ref parsing |
    | `plugin-sdk/video-generation` | Video generation provider/request/result types |
    | `plugin-sdk/video-generation-core` | Shared video-generation types, failover helpers, provider lookup, and model-ref parsing |
    | `plugin-sdk/webhook-targets` | Webhook target registry and route-install helpers |
    | `plugin-sdk/webhook-path` | Webhook path normalization helpers |
    | `plugin-sdk/web-media` | Shared remote/local media loading helpers |
    | `plugin-sdk/zod` | Re-exported `zod` for plugin SDK consumers |
    | `plugin-sdk/testing` | `installCommonResolveTargetErrorCases`, `shouldAckReaction` |
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
    | `plugin-sdk/memory-lancedb` | Bundled memory-lancedb helper surface |
  </Accordion>

  <Accordion title="Reserved bundled-helper subpaths">
    | Family | Current subpaths | Intended use |
    | --- | --- | --- |
    | Browser | `plugin-sdk/browser-cdp`, `plugin-sdk/browser-config-runtime`, `plugin-sdk/browser-config-support`, `plugin-sdk/browser-control-auth`, `plugin-sdk/browser-node-runtime`, `plugin-sdk/browser-profiles`, `plugin-sdk/browser-security-runtime`, `plugin-sdk/browser-setup-tools`, `plugin-sdk/browser-support` | Bundled browser plugin support helpers (`browser-support` remains the compatibility barrel) |
    | Matrix | `plugin-sdk/matrix`, `plugin-sdk/matrix-helper`, `plugin-sdk/matrix-runtime-heavy`, `plugin-sdk/matrix-runtime-shared`, `plugin-sdk/matrix-runtime-surface`, `plugin-sdk/matrix-surface`, `plugin-sdk/matrix-thread-bindings` | Bundled Matrix helper/runtime surface |
    | Line | `plugin-sdk/line`, `plugin-sdk/line-core`, `plugin-sdk/line-runtime`, `plugin-sdk/line-surface` | Bundled LINE helper/runtime surface |
    | IRC | `plugin-sdk/irc`, `plugin-sdk/irc-surface` | Bundled IRC helper surface |
    | Channel-specific helpers | `plugin-sdk/googlechat`, `plugin-sdk/zalouser`, `plugin-sdk/bluebubbles`, `plugin-sdk/bluebubbles-policy`, `plugin-sdk/mattermost`, `plugin-sdk/mattermost-policy`, `plugin-sdk/feishu-conversation`, `plugin-sdk/msteams`, `plugin-sdk/nextcloud-talk`, `plugin-sdk/nostr`, `plugin-sdk/tlon`, `plugin-sdk/twitch` | Bundled channel compatibility/helper seams |
    | Auth/plugin-specific helpers | `plugin-sdk/github-copilot-login`, `plugin-sdk/github-copilot-token`, `plugin-sdk/diagnostics-otel`, `plugin-sdk/diffs`, `plugin-sdk/llm-task`, `plugin-sdk/thread-ownership`, `plugin-sdk/voice-call` | Bundled feature/plugin helper seams; `plugin-sdk/github-copilot-token` currently exports `DEFAULT_COPILOT_API_BASE_URL`, `deriveCopilotApiBaseUrlFromToken`, and `resolveCopilotApiToken` |
  </Accordion>
</AccordionGroup>

## Related

- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
