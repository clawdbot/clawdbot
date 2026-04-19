---
title: "Plugin SDK Migration"
sidebarTitle: "Migrate to SDK"
summary: "Migrate from the legacy backwards-compatibility layer to the modern plugin SDK"
read_when:
  - You see the OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED warning
  - You see the OPENCLAW_EXTENSION_API_DEPRECATED warning
  - You are updating a plugin to the modern plugin architecture
  - You maintain an external OpenClaw plugin
---

# Plugin SDK Migration

OpenClaw has moved from a broad backwards-compatibility layer to a modern plugin
architecture with focused, documented imports. If your plugin was built before
the new architecture, this guide helps you migrate.

## What is changing

The old plugin system provided two wide-open surfaces that let plugins import
anything they needed from a single entry point:

- **`openclaw/plugin-sdk/compat`** — a single import that re-exported dozens of
  helpers. It was introduced to keep older hook-based plugins working while the
  new plugin architecture was being built.
- **`openclaw/extension-api`** — a bridge that gave plugins direct access to
  host-side helpers like the embedded agent runner.

Both surfaces are now **deprecated**. They still work at runtime, but new
plugins must not use them, and existing plugins should migrate before the next
major release removes them.

<Warning>
  The backwards-compatibility layer will be removed in a future major release.
  Plugins that still import from these surfaces will break when that happens.
</Warning>

## Why this changed

The old approach caused problems:

- **Slow startup** — importing one helper loaded dozens of unrelated modules
- **Circular dependencies** — broad re-exports made it easy to create import cycles
- **Unclear API surface** — no way to tell which exports were stable vs internal

The modern plugin SDK fixes this: each import path (`openclaw/plugin-sdk/\<subpath\>`)
is a small, self-contained module with a clear purpose and documented contract.

Legacy provider convenience seams for bundled channels are also gone. Imports
such as `openclaw/plugin-sdk/slack`, `openclaw/plugin-sdk/discord`,
`openclaw/plugin-sdk/signal`, `openclaw/plugin-sdk/whatsapp`,
channel-branded helper seams, and
`openclaw/plugin-sdk/telegram-core` were private mono-repo shortcuts, not
stable plugin contracts. Use narrow generic SDK subpaths instead. Inside the
bundled plugin workspace, keep provider-owned helpers in that plugin's own
`api.ts` or `runtime-api.ts`.

Current bundled provider examples:

- Anthropic keeps Claude-specific stream helpers in its own `api.ts` /
  `contract-api.ts` seam
- OpenAI keeps provider builders, default-model helpers, and realtime provider
  builders in its own `api.ts`
- OpenRouter keeps provider builder and onboarding/config helpers in its own
  `api.ts`

## How to migrate

<Steps>
  <Step title="Migrate approval-native handlers to capability facts">
    Approval-capable channel plugins now expose native approval behavior through
    `approvalCapability.nativeRuntime` plus the shared runtime-context registry.

    Key changes:

    - Replace `approvalCapability.handler.loadRuntime(...)` with
      `approvalCapability.nativeRuntime`
    - Move approval-specific auth/delivery off legacy `plugin.auth` /
      `plugin.approvals` wiring and onto `approvalCapability`
    - `ChannelPlugin.approvals` has been removed from the public channel-plugin
      contract; move delivery/native/render fields onto `approvalCapability`
    - `plugin.auth` remains for channel login/logout flows only; approval auth
      hooks there are no longer read by core
    - Register channel-owned runtime objects such as clients, tokens, or Bolt
      apps through `openclaw/plugin-sdk/channel-runtime-context`
    - Do not send plugin-owned reroute notices from native approval handlers;
      core now owns routed-elsewhere notices from actual delivery results
    - When passing `channelRuntime` into `createChannelManager(...)`, provide a
      real `createPluginRuntime().channel` surface. Partial stubs are rejected.

    See `/plugins/sdk-channel-plugins` for the current approval capability
    layout.

  </Step>

  <Step title="Audit Windows wrapper fallback behavior">
    If your plugin uses `openclaw/plugin-sdk/windows-spawn`, unresolved Windows
    `.cmd`/`.bat` wrappers now fail closed unless you explicitly pass
    `allowShellFallback: true`.

    ```typescript
    // Before
    const program = applyWindowsSpawnProgramPolicy({ candidate });

    // After
    const program = applyWindowsSpawnProgramPolicy({
      candidate,
      // Only set this for trusted compatibility callers that intentionally
      // accept shell-mediated fallback.
      allowShellFallback: true,
    });
    ```

    If your caller does not intentionally rely on shell fallback, do not set
    `allowShellFallback` and handle the thrown error instead.

  </Step>

  <Step title="Find deprecated imports">
    Search your plugin for imports from either deprecated surface:

    ```bash
    grep -r "plugin-sdk/compat" my-plugin/
    grep -r "openclaw/extension-api" my-plugin/
    ```

  </Step>

  <Step title="Replace with focused imports">
    Each export from the old surface maps to a specific modern import path:

    ```typescript
    // Before (deprecated backwards-compatibility layer)
    import {
      createChannelReplyPipeline,
      createPluginRuntimeStore,
      resolveControlCommandGate,
    } from "openclaw/plugin-sdk/compat";

    // After (modern focused imports)
    import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
    ```

    For host-side helpers, use the injected plugin runtime instead of importing
    directly:

    ```typescript
    // Before (deprecated extension-api bridge)
    import { runEmbeddedPiAgent } from "openclaw/extension-api";
    const result = await runEmbeddedPiAgent({ sessionId, prompt });

    // After (injected runtime)
    const result = await api.runtime.agent.runEmbeddedPiAgent({ sessionId, prompt });
    ```

    The same pattern applies to other legacy bridge helpers:

    | Old import | Modern equivalent |
    | --- | --- |
    | `resolveAgentDir` | `api.runtime.agent.resolveAgentDir` |
    | `resolveAgentWorkspaceDir` | `api.runtime.agent.resolveAgentWorkspaceDir` |
    | `resolveAgentIdentity` | `api.runtime.agent.resolveAgentIdentity` |
    | `resolveThinkingDefault` | `api.runtime.agent.resolveThinkingDefault` |
    | `resolveAgentTimeoutMs` | `api.runtime.agent.resolveAgentTimeoutMs` |
    | `ensureAgentWorkspace` | `api.runtime.agent.ensureAgentWorkspace` |
    | session store helpers | `api.runtime.agent.session.*` |

  </Step>

  <Step title="Build and test">
    ```bash
    pnpm build
    pnpm test -- my-plugin/
    ```
  </Step>
</Steps>

## Import path reference

<Accordion title="Common import path table">
  | Import path | Purpose | Key exports |
  | --- | --- | --- |
  | `plugin-sdk/plugin-entry` | Canonical plugin entry helper | `definePluginEntry` |
  | `plugin-sdk/core` | Legacy umbrella re-export for channel entry definitions/builders | `defineChannelPluginEntry`, `createChatChannelPlugin` |
  | `plugin-sdk/config-schema` | Root config schema export | `OpenClawSchema` |
  | `plugin-sdk/provider-entry` | Single-provider entry helper | `defineSingleProviderPluginEntry` |
  | `plugin-sdk/channel-core` | Focused channel entry definitions and builders | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase` |
  | `plugin-sdk/setup` | Shared setup wizard helpers | Allowlist prompts, setup status builders |
  | `plugin-sdk/setup-runtime` | Setup-time runtime helpers | Import-safe setup patch adapters, lookup-note helpers, `promptResolvedAllowFrom`, `splitSetupEntries`, delegated setup proxies |
  | `plugin-sdk/setup-adapter-runtime` | Setup adapter helpers | `createEnvPatchedAccountSetupAdapter` |
  | `plugin-sdk/setup-tools` | Setup tooling helpers | `formatCliCommand`, `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`, `CONFIG_DIR` |
  | `plugin-sdk/account-core` | Multi-account helpers | Account list/config/action-gate helpers |
  | `plugin-sdk/account-id` | Account-id helpers | `DEFAULT_ACCOUNT_ID`, account-id normalization |
  | `plugin-sdk/account-resolution` | Account lookup helpers | Account lookup + default-fallback helpers |
  | `plugin-sdk/account-helpers` | Narrow account helpers | Account list/account-action helpers |
  | `plugin-sdk/channel-setup` | Setup wizard adapters | `createOptionalChannelSetupSurface`, `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`, plus `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`, `setSetupChannelEnabled`, `splitSetupEntries` |
  | `plugin-sdk/channel-pairing` | DM pairing primitives | `createChannelPairingController` |
  | `plugin-sdk/channel-reply-pipeline` | Reply prefix + typing wiring | `createChannelReplyPipeline` |
  | `plugin-sdk/channel-config-helpers` | Config adapter factories | `createHybridChannelConfigAdapter` |
  | `plugin-sdk/channel-config-schema` | Config schema builders | Channel config schema types |
  | `plugin-sdk/telegram-command-config` | Telegram command config helpers | Command-name normalization, description trimming, duplicate/conflict validation |
  | `plugin-sdk/channel-policy` | Group/DM policy resolution | `resolveChannelGroupRequireMention` |
  | `plugin-sdk/channel-lifecycle` | Account status tracking | `createAccountStatusSink` |
  | `plugin-sdk/inbound-envelope` | Inbound envelope helpers | Shared route + envelope builder helpers |
  | `plugin-sdk/inbound-reply-dispatch` | Inbound reply helpers | Shared record-and-dispatch helpers |
  | `plugin-sdk/messaging-targets` | Messaging target parsing | Target parsing/matching helpers |
  | `plugin-sdk/outbound-media` | Outbound media helpers | Shared outbound media loading |
  | `plugin-sdk/outbound-runtime` | Outbound runtime helpers | Outbound identity/send delegate helpers |
  | `plugin-sdk/thread-bindings-runtime` | Thread-binding helpers | Thread-binding lifecycle and adapter helpers |
  | `plugin-sdk/agent-media-payload` | Legacy media payload helpers | Agent media payload builder for legacy field layouts |
  | `plugin-sdk/channel-runtime` | Deprecated compatibility shim | Legacy channel runtime utilities only |
  | `plugin-sdk/channel-send-result` | Send result types | Reply result types |
  | `plugin-sdk/runtime-store` | Persistent plugin storage | `createPluginRuntimeStore` |
  | `plugin-sdk/runtime` | Broad runtime helpers | Runtime/logging/backup/plugin-install helpers |
  | `plugin-sdk/runtime-env` | Narrow runtime env helpers | Logger/runtime env, timeout, retry, and backoff helpers |
  | `plugin-sdk/plugin-runtime` | Shared plugin runtime helpers | Plugin commands/hooks/http/interactive helpers |
  | `plugin-sdk/hook-runtime` | Hook pipeline helpers | Shared webhook/internal hook pipeline helpers |
  | `plugin-sdk/lazy-runtime` | Lazy runtime helpers | `createLazyRuntimeModule`, `createLazyRuntimeMethod`, `createLazyRuntimeMethodBinder`, `createLazyRuntimeNamedExport`, `createLazyRuntimeSurface` |
  | `plugin-sdk/process-runtime` | Process helpers | Shared exec helpers |
  | `plugin-sdk/cli-runtime` | CLI runtime helpers | Command formatting, waits, version helpers |
  | `plugin-sdk/gateway-runtime` | Gateway helpers | Gateway client and channel-status patch helpers |
  | `plugin-sdk/config-runtime` | Config helpers | Config load/write helpers |
  | `plugin-sdk/telegram-command-config` | Telegram command helpers | Fallback-stable Telegram command validation helpers when the bundled Telegram contract surface is unavailable |
  | `plugin-sdk/approval-runtime` | Approval prompt helpers | Exec/plugin approval payload, approval capability/profile helpers, native approval routing/runtime helpers |
  | `plugin-sdk/approval-auth-runtime` | Approval auth helpers | Approver resolution, same-chat action auth |
  | `plugin-sdk/approval-client-runtime` | Approval client helpers | Native exec approval profile/filter helpers |
  | `plugin-sdk/approval-delivery-runtime` | Approval delivery helpers | Native approval capability/delivery adapters |
  | `plugin-sdk/approval-gateway-runtime` | Approval gateway helpers | Shared approval gateway-resolution helper |
  | `plugin-sdk/approval-handler-adapter-runtime` | Approval adapter helpers | Lightweight native approval adapter loading helpers for hot channel entrypoints |
  | `plugin-sdk/approval-handler-runtime` | Approval handler helpers | Broader approval handler runtime helpers; prefer the narrower adapter/gateway seams when they are enough |
  | `plugin-sdk/approval-native-runtime` | Approval target helpers | Native approval target/account binding helpers |
  | `plugin-sdk/approval-reply-runtime` | Approval reply helpers | Exec/plugin approval reply payload helpers |
  | `plugin-sdk/channel-runtime-context` | Channel runtime-context helpers | Generic channel runtime-context register/get/watch helpers |
  | `plugin-sdk/security-runtime` | Security helpers | Shared trust, DM gating, external-content, and secret-collection helpers |
  | `plugin-sdk/ssrf-policy` | SSRF policy helpers | Host allowlist and private-network policy helpers |
  | `plugin-sdk/ssrf-runtime` | SSRF runtime helpers | Pinned-dispatcher, guarded fetch, SSRF policy helpers |
  | `plugin-sdk/collection-runtime` | Bounded cache helpers | `pruneMapToMaxSize` |
  | `plugin-sdk/diagnostic-runtime` | Diagnostic gating helpers | `isDiagnosticFlagEnabled`, `isDiagnosticsEnabled` |
  | `plugin-sdk/error-runtime` | Error formatting helpers | `formatUncaughtError`, `isApprovalNotFoundError`, error graph helpers |
  | `plugin-sdk/fetch-runtime` | Wrapped fetch/proxy helpers | `resolveFetch`, proxy helpers |
  | `plugin-sdk/host-runtime` | Host normalization helpers | `normalizeHostname`, `normalizeScpRemoteHost` |
  | `plugin-sdk/retry-runtime` | Retry helpers | `RetryConfig`, `retryAsync`, policy runners |
  | `plugin-sdk/allow-from` | Allowlist formatting | `formatAllowFromLowercase` |
  | `plugin-sdk/allowlist-resolution` | Allowlist input mapping | `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | Command gating and command-surface helpers | `resolveControlCommandGate`, sender-authorization helpers, command registry helpers |
  | `plugin-sdk/command-status` | Command status/help renderers | `buildCommandsMessage`, `buildCommandsMessagePaginated`, `buildHelpMessage` |
  | `plugin-sdk/secret-input` | Secret input parsing | Secret input helpers |
  | `plugin-sdk/webhook-ingress` | Webhook request helpers | Webhook target utilities |
  | `plugin-sdk/webhook-request-guards` | Webhook body guard helpers | Request body read/limit helpers |
  | `plugin-sdk/reply-runtime` | Shared reply runtime | Inbound dispatch, heartbeat, reply planner, chunking |
  | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch helpers | Finalize + provider dispatch helpers |
  | `plugin-sdk/reply-history` | Reply-history helpers | `buildHistoryContext`, `buildPendingHistoryContextFromMap`, `recordPendingHistoryEntry`, `clearHistoryEntriesIfEnabled` |
  | `plugin-sdk/reply-reference` | Reply reference planning | `createReplyReferencePlanner` |
  | `plugin-sdk/reply-chunking` | Reply chunk helpers | Text/markdown chunking helpers |
  | `plugin-sdk/session-store-runtime` | Session store helpers | Store path + updated-at helpers |
  | `plugin-sdk/state-paths` | State path helpers | State and OAuth dir helpers |
  | `plugin-sdk/routing` | Routing/session-key helpers | `resolveAgentRoute`, `buildAgentSessionKey`, `resolveDefaultAgentBoundAccountId`, session-key normalization helpers |
  | `plugin-sdk/status-helpers` | Channel status helpers | Channel/account status summary builders, runtime-state defaults, issue metadata helpers |
  | `plugin-sdk/target-resolver-runtime` | Target resolver helpers | Shared target resolver helpers |
  | `plugin-sdk/string-normalization-runtime` | String normalization helpers | Slug/string normalization helpers |
  | `plugin-sdk/request-url` | Request URL helpers | Extract string URLs from request-like inputs |
  | `plugin-sdk/run-command` | Timed command helpers | Timed command runner with normalized stdout/stderr |
  | `plugin-sdk/param-readers` | Param readers | Common tool/CLI param readers |
  | `plugin-sdk/tool-payload` | Tool payload extraction | Extract normalized payloads from tool result objects |
  | `plugin-sdk/tool-send` | Tool send extraction | Extract canonical send target fields from tool args |
  | `plugin-sdk/temp-path` | Temp path helpers | Shared temp-download path helpers |
  | `plugin-sdk/logging-core` | Logging helpers | Subsystem logger and redaction helpers |
  | `plugin-sdk/markdown-table-runtime` | Markdown-table helpers | Markdown table mode helpers |
  | `plugin-sdk/reply-payload` | Message reply types | Reply payload types |
  | `plugin-sdk/provider-setup` | Curated local/self-hosted provider setup helpers | Self-hosted provider discovery/config helpers |
  | `plugin-sdk/self-hosted-provider-setup` | Focused OpenAI-compatible self-hosted provider setup helpers | Same self-hosted provider discovery/config helpers |
  | `plugin-sdk/provider-auth-runtime` | Provider runtime auth helpers | Runtime API-key resolution helpers |
  | `plugin-sdk/provider-auth-api-key` | Provider API-key setup helpers | API-key onboarding/profile-write helpers |
  | `plugin-sdk/provider-auth-result` | Provider auth-result helpers | Standard OAuth auth-result builder |
  | `plugin-sdk/provider-auth-login` | Provider interactive login helpers | Shared interactive login helpers |
  | `plugin-sdk/provider-env-vars` | Provider env-var helpers | Provider auth env-var lookup helpers |
  | `plugin-sdk/provider-model-shared` | Shared provider model/replay helpers | `ProviderReplayFamily`, `buildProviderReplayFamilyHooks`, `normalizeModelCompat`, shared replay-policy builders, provider-endpoint helpers, and model-id normalization helpers |
  | `plugin-sdk/provider-catalog-shared` | Shared provider catalog helpers | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
  | `plugin-sdk/provider-onboard` | Provider onboarding patches | Onboarding config helpers |
  | `plugin-sdk/provider-http` | Provider HTTP helpers | Generic provider HTTP/endpoint capability helpers |
  | `plugin-sdk/provider-web-fetch` | Provider web-fetch helpers | Web-fetch provider registration/cache helpers |
  | `plugin-sdk/provider-web-search-config-contract` | Provider web-search config helpers | Narrow web-search config/credential helpers for providers that do not need plugin-enable wiring |
  | `plugin-sdk/provider-web-search-contract` | Provider web-search contract helpers | Narrow web-search config/credential contract helpers such as `createWebSearchProviderContractFields`, `enablePluginInConfig`, `resolveProviderWebSearchPluginConfig`, and scoped credential setters/getters |
  | `plugin-sdk/provider-web-search` | Provider web-search helpers | Web-search provider registration/cache/runtime helpers |
  | `plugin-sdk/provider-tools` | Provider tool/schema compat helpers | `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, Gemini schema cleanup + diagnostics, and xAI compat helpers such as `resolveXaiModelCompatPatch` / `applyXaiModelCompat` |
  | `plugin-sdk/provider-usage` | Provider usage helpers | `fetchClaudeUsage`, `fetchGeminiUsage`, `fetchGithubCopilotUsage`, and other provider usage helpers |
  | `plugin-sdk/provider-stream` | Provider stream wrapper helpers | `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, and shared Anthropic/Bedrock/Google/Kilocode/Moonshot/OpenAI/OpenRouter/Z.A.I/MiniMax/Copilot wrapper helpers |
  | `plugin-sdk/provider-transport-runtime` | Provider transport helpers | Native provider transport helpers such as guarded fetch, transport message transforms, and writable transport event streams |
  | `plugin-sdk/keyed-async-queue` | Ordered async queue | `KeyedAsyncQueue` |
  | `plugin-sdk/media-runtime` | Shared media helpers | Media fetch/transform/store helpers plus media payload builders |
  | `plugin-sdk/media-generation-runtime` | Shared media-generation helpers | Shared failover helpers, candidate selection, and missing-model messaging for image/video/music generation |
  | `plugin-sdk/media-understanding` | Media-understanding helpers | Media understanding provider types plus provider-facing image/audio helper exports |
  | `plugin-sdk/text-runtime` | Shared text helpers | Assistant-visible-text stripping, markdown render/chunking/table helpers, redaction helpers, directive-tag helpers, safe-text utilities, and related text/logging helpers |
  | `plugin-sdk/text-chunking` | Text chunking helpers | Outbound text chunking helper |
  | `plugin-sdk/speech` | Speech helpers | Speech provider types plus provider-facing directive, registry, and validation helpers |
  | `plugin-sdk/speech-core` | Shared speech core | Speech provider types, registry, directives, normalization |
  | `plugin-sdk/realtime-transcription` | Realtime transcription helpers | Provider types and registry helpers |
  | `plugin-sdk/realtime-voice` | Realtime voice helpers | Provider types and registry helpers |
  | `plugin-sdk/image-generation-core` | Shared image-generation core | Image-generation types, failover, auth, and registry helpers |
  | `plugin-sdk/music-generation` | Music-generation helpers | Music-generation provider/request/result types |
  | `plugin-sdk/music-generation-core` | Shared music-generation core | Music-generation types, failover helpers, provider lookup, and model-ref parsing |
  | `plugin-sdk/video-generation` | Video-generation helpers | Video-generation provider/request/result types |
  | `plugin-sdk/video-generation-core` | Shared video-generation core | Video-generation types, failover helpers, provider lookup, and model-ref parsing |
  | `plugin-sdk/interactive-runtime` | Interactive reply helpers | Interactive reply payload normalization/reduction |
  | `plugin-sdk/channel-config-primitives` | Channel config primitives | Narrow channel config-schema primitives |
  | `plugin-sdk/channel-config-writes` | Channel config-write helpers | Channel config-write authorization helpers |
  | `plugin-sdk/channel-plugin-common` | Shared channel prelude | Shared channel plugin prelude exports |
  | `plugin-sdk/channel-status` | Channel status helpers | Shared channel status snapshot/summary helpers |
  | `plugin-sdk/allowlist-config-edit` | Allowlist config helpers | Allowlist config edit/read helpers |
  | `plugin-sdk/group-access` | Group access helpers | Shared group-access decision helpers |
  | `plugin-sdk/direct-dm` | Direct-DM helpers | Shared direct-DM auth/guard helpers |
  | `plugin-sdk/extension-shared` | Shared extension helpers | Passive-channel/status and ambient proxy helper primitives |
  | `plugin-sdk/webhook-targets` | Webhook target helpers | Webhook target registry and route-install helpers |
  | `plugin-sdk/webhook-path` | Webhook path helpers | Webhook path normalization helpers |
  | `plugin-sdk/web-media` | Shared web media helpers | Remote/local media loading helpers |
  | `plugin-sdk/zod` | Zod re-export | Re-exported `zod` for plugin SDK consumers |
  | `plugin-sdk/memory-core` | Bundled memory-core helpers | Memory manager/config/file/CLI helper surface |
  | `plugin-sdk/memory-core-engine-runtime` | Memory engine runtime facade | Memory index/search runtime facade |
  | `plugin-sdk/memory-core-host-engine-foundation` | Memory host foundation engine | Memory host foundation engine exports |
  | `plugin-sdk/memory-core-host-engine-embeddings` | Memory host embedding engine | Memory embedding contracts, registry access, local provider, and generic batch/remote helpers; concrete remote providers live in their owning plugins |
  | `plugin-sdk/memory-core-host-engine-qmd` | Memory host QMD engine | Memory host QMD engine exports |
  | `plugin-sdk/memory-core-host-engine-storage` | Memory host storage engine | Memory host storage engine exports |
  | `plugin-sdk/memory-core-host-multimodal` | Memory host multimodal helpers | Memory host multimodal helpers |
  | `plugin-sdk/memory-core-host-query` | Memory host query helpers | Memory host query helpers |
  | `plugin-sdk/memory-core-host-secret` | Memory host secret helpers | Memory host secret helpers |
  | `plugin-sdk/memory-core-host-events` | Memory host event journal helpers | Memory host event journal helpers |
  | `plugin-sdk/memory-core-host-status` | Memory host status helpers | Memory host status helpers |
  | `plugin-sdk/memory-core-host-runtime-cli` | Memory host CLI runtime | Memory host CLI runtime helpers |
  | `plugin-sdk/memory-core-host-runtime-core` | Memory host core runtime | Memory host core runtime helpers |
  | `plugin-sdk/memory-core-host-runtime-files` | Memory host file/runtime helpers | Memory host file/runtime helpers |
  | `plugin-sdk/memory-host-core` | Memory host core runtime alias | Vendor-neutral alias for memory host core runtime helpers |
  | `plugin-sdk/memory-host-events` | Memory host event journal alias | Vendor-neutral alias for memory host event journal helpers |
  | `plugin-sdk/memory-host-files` | Memory host file/runtime alias | Vendor-neutral alias for memory host file/runtime helpers |
  | `plugin-sdk/memory-host-markdown` | Managed markdown helpers | Shared managed-markdown helpers for memory-adjacent plugins |
  | `plugin-sdk/memory-host-search` | Active memory search facade | Lazy active-memory search-manager runtime facade |
  | `plugin-sdk/memory-host-status` | Memory host status alias | Vendor-neutral alias for memory host status helpers |
  | `plugin-sdk/memory-lancedb` | Bundled memory-lancedb helpers | Memory-lancedb helper surface |
  | `plugin-sdk/testing` | Test utilities | Test helpers and mocks |
</Accordion>

This table is intentionally the common migration subset, not the full SDK
surface. The full list of 200+ entrypoints lives in
`scripts/lib/plugin-sdk-entrypoints.json`.

That list still includes some bundled-plugin helper seams such as
`plugin-sdk/feishu`, `plugin-sdk/feishu-setup`, `plugin-sdk/zalo`,
`plugin-sdk/zalo-setup`, and `plugin-sdk/matrix*`. Those remain exported for
bundled-plugin maintenance and compatibility, but they are intentionally
omitted from the common migration table and are not the recommended target for
new plugin code.

The same rule applies to other bundled-helper families such as:

- browser support helpers: `plugin-sdk/browser-cdp`, `plugin-sdk/browser-config-runtime`, `plugin-sdk/browser-config-support`, `plugin-sdk/browser-control-auth`, `plugin-sdk/browser-node-runtime`, `plugin-sdk/browser-profiles`, `plugin-sdk/browser-security-runtime`, `plugin-sdk/browser-setup-tools`, `plugin-sdk/browser-support`
- Matrix: `plugin-sdk/matrix*`
- LINE: `plugin-sdk/line*`
- IRC: `plugin-sdk/irc*`
- bundled helper/plugin surfaces like `plugin-sdk/googlechat`,
  `plugin-sdk/zalouser`, `plugin-sdk/bluebubbles*`,
  `plugin-sdk/mattermost*`, `plugin-sdk/msteams`,
  `plugin-sdk/nextcloud-talk`, `plugin-sdk/nostr`, `plugin-sdk/tlon`,
  `plugin-sdk/twitch`,
  `plugin-sdk/github-copilot-login`, `plugin-sdk/github-copilot-token`,
  `plugin-sdk/diagnostics-otel`, `plugin-sdk/diffs`, `plugin-sdk/llm-task`,
  `plugin-sdk/thread-ownership`, and `plugin-sdk/voice-call`

`plugin-sdk/github-copilot-token` currently exposes the narrow token-helper
surface `DEFAULT_COPILOT_API_BASE_URL`,
`deriveCopilotApiBaseUrlFromToken`, and `resolveCopilotApiToken`.

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask in Discord.

## Removal timeline

| When                   | What happens                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| **Now**                | Deprecated surfaces emit runtime warnings                               |
| **Next major release** | Deprecated surfaces will be removed; plugins still using them will fail |

All core plugins have already been migrated. External plugins should migrate
before the next major release.

## Suppressing the warnings temporarily

Set these environment variables while you work on migrating:

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
OPENCLAW_SUPPRESS_EXTENSION_API_WARNING=1 openclaw gateway run
```

This is a temporary escape hatch, not a permanent solution.

## Related

- [Getting Started](/plugins/building-plugins) — build your first plugin
- [SDK Overview](/plugins/sdk-overview) — full subpath import reference
- [Channel Plugins](/plugins/sdk-channel-plugins) — building channel plugins
- [Provider Plugins](/plugins/sdk-provider-plugins) — building provider plugins
- [Plugin Internals](/plugins/architecture) — architecture deep dive
- [Plugin Manifest](/plugins/manifest) — manifest schema reference
