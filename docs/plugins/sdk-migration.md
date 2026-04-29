---
summary: "Migrate from the legacy backwards-compatibility layer to the modern plugin SDK"
title: "Plugin SDK migration"
sidebarTitle: "Migrate to SDK"
read_when:
  - You see the OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED warning
  - You see the OPENCLAW_EXTENSION_API_DEPRECATED warning
  - You used api.registerEmbeddedExtensionFactory before OpenClaw 2026.4.25
  - You are updating a plugin to the modern plugin architecture
  - You maintain an external OpenClaw plugin
---

OpenClaw has moved from a broad backwards-compatibility layer to a modern plugin
architecture with focused, documented imports. If your plugin was built before
the new architecture, this guide helps you migrate.

## What is changing

The old plugin system provided two wide-open surfaces that let plugins import
anything they needed from a single entry point:

- **`openclaw/plugin-sdk/compat`** — a single import that re-exported dozens of
  helpers. It was introduced to keep older hook-based plugins working while the
  new plugin architecture was being built.
- **`openclaw/plugin-sdk/infra-runtime`** — a broad runtime helper barrel that
  mixed system events, heartbeat state, delivery queues, fetch/proxy helpers,
  file helpers, approval types, and unrelated utilities.
- **`openclaw/plugin-sdk/config-runtime`** — a broad config compatibility barrel
  that still carries deprecated direct load/write helpers during the migration
  window.
- **`openclaw/extension-api`** — a bridge that gave plugins direct access to
  host-side helpers like the embedded agent runner.
- **`api.registerEmbeddedExtensionFactory(...)`** — a removed Pi-only bundled
  extension hook that could observe embedded-runner events such as
  `tool_result`.

The broad import surfaces are now **deprecated**. They still work at runtime,
but new plugins must not use them, and existing plugins should migrate before
the next major release removes them. The Pi-only embedded extension factory
registration API has been removed; use tool-result middleware instead.

OpenClaw does not remove or reinterpret documented plugin behavior in the same
change that introduces a replacement. Breaking contract changes must first go
through a compatibility adapter, diagnostics, docs, and a deprecation window.
That applies to SDK imports, manifest fields, setup APIs, hooks, and runtime
registration behavior.

<Warning>
  The backwards-compatibility layer will be removed in a future major release.
  Plugins that still import from these surfaces will break when that happens.
  Pi-only embedded extension factory registrations already no longer load.
</Warning>

## Why this changed

The old approach caused problems:

- **Slow startup** — importing one helper loaded dozens of unrelated modules
- **Circular dependencies** — broad re-exports made it easy to create import cycles
- **Unclear API surface** — no way to tell which exports were stable vs internal

The modern plugin SDK fixes this: each import path (`openclaw/plugin-sdk/\<subpath\>`)
is a small, self-contained module with a clear purpose and documented contract.

Legacy provider convenience seams for bundled channels are also gone.
Channel-branded helper seams were private mono-repo shortcuts, not stable
plugin contracts. Use narrow generic SDK subpaths instead. Inside the bundled
plugin workspace, keep provider-owned helpers in that plugin's own `api.ts` or
`runtime-api.ts`.

Current bundled provider examples:

- Anthropic keeps Claude-specific stream helpers in its own `api.ts` /
  `contract-api.ts` seam
- OpenAI keeps provider builders, default-model helpers, and realtime provider
  builders in its own `api.ts`
- OpenRouter keeps provider builder and onboarding/config helpers in its own
  `api.ts`

## Compatibility policy

For external plugins, compatibility work follows this order:

1. add the new contract
2. keep the old behavior wired through a compatibility adapter
3. emit a diagnostic or warning that names the old path and replacement
4. cover both paths in tests
5. document the deprecation and migration path
6. remove only after the announced migration window, usually in a major release

Maintainers can audit the current migration queue with
`pnpm plugins:boundary-report`. Use `pnpm plugins:boundary-report:summary` for
compact counts, `--owner <id>` for one plugin or compatibility owner, and
`pnpm plugins:boundary-report:ci` when a CI gate should fail on due
compatibility records, cross-owner reserved SDK imports, or unused reserved SDK
subpaths. The report groups deprecated
compatibility records by removal date, counts local code/docs references,
surfaces cross-owner reserved SDK imports, and summarizes the private
memory-host SDK bridge so compatibility cleanup stays explicit instead of
relying on ad hoc searches. Reserved SDK subpaths must have tracked owner usage;
unused reserved helper exports should be removed from the public SDK.

If a manifest field is still accepted, plugin authors can keep using it until
the docs and diagnostics say otherwise. New code should prefer the documented
replacement, but existing plugins should not break during ordinary minor
releases.

## How to migrate

<Steps>
  <Step title="Migrate runtime config load/write helpers">
    Bundled plugins should stop calling
    `api.runtime.config.loadConfig()` and
    `api.runtime.config.writeConfigFile(...)` directly. Prefer config that was
    already passed into the active call path. Long-lived handlers that need the
    current process snapshot can use `api.runtime.config.current()`. Long-lived
    agent tools should use the tool context's `ctx.getRuntimeConfig()` inside
    `execute` so a tool created before a config write still sees the refreshed
    runtime config.

    Config writes must go through the transactional helpers and choose an
    after-write policy:

    ```typescript
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    Use `afterWrite: { mode: "restart", reason: "..." }` when the caller knows
    the change requires a clean gateway restart, and
    `afterWrite: { mode: "none", reason: "..." }` only when the caller owns the
    follow-up and deliberately wants to suppress the reload planner.
    Mutation results include a typed `followUp` summary for tests and logging;
    the gateway remains responsible for applying or scheduling the restart.
    `loadConfig` and `writeConfigFile` remain as deprecated compatibility
    helpers for external plugins during the migration window and warn once with
    the `runtime-config-load-write` compatibility code. Bundled plugins and repo
    runtime code are protected by scanner guardrails in
    `pnpm check:deprecated-internal-config-api` and
    `pnpm check:no-runtime-action-load-config`: new production plugin usage
    fails outright, direct config writes fail, gateway server methods must use
    the request runtime snapshot, runtime channel send/action/client helpers
    must receive config from their boundary, and long-lived runtime modules have
    zero allowed ambient `loadConfig()` calls.

    New plugin code should also avoid importing the broad
    `openclaw/plugin-sdk/config-runtime` compatibility barrel. Use the narrow
    SDK subpath that matches the job:

    | Need | Import |
    | --- | --- |
    | Config types such as `OpenClawConfig` | `openclaw/plugin-sdk/config-types` |
    | Already-loaded config assertions and plugin-entry config lookup | `openclaw/plugin-sdk/plugin-config-runtime` |
    | Current runtime snapshot reads | `openclaw/plugin-sdk/runtime-config-snapshot` |
    | Config writes | `openclaw/plugin-sdk/config-mutation` |
    | Session store helpers | `openclaw/plugin-sdk/session-store-runtime` |
    | Markdown table config | `openclaw/plugin-sdk/markdown-table-runtime` |
    | Group policy runtime helpers | `openclaw/plugin-sdk/runtime-group-policy` |
    | Secret input resolution | `openclaw/plugin-sdk/secret-input-runtime` |
    | Model/session overrides | `openclaw/plugin-sdk/model-session-runtime` |

    Bundled plugins and their tests are scanner-guarded against the broad
    barrel so imports and mocks stay local to the behavior they need. The broad
    barrel still exists for external compatibility, but new code should not
    depend on it.

  </Step>

  <Step title="Migrate Pi tool-result extensions to middleware">
    Bundled plugins must replace Pi-only
    `api.registerEmbeddedExtensionFactory(...)` tool-result handlers with
    runtime-neutral middleware.

    ```typescript
    // Pi and Codex runtime dynamic tools
    api.registerAgentToolResultMiddleware(async (event) => {
      return compactToolResult(event);
    }, {
      runtimes: ["pi", "codex"],
    });
    ```

    Update the plugin manifest at the same time:

    ```json
    {
      "contracts": {
        "agentToolResultMiddleware": ["pi", "codex"]
      }
    }
    ```

    External plugins cannot register tool-result middleware because it can
    rewrite high-trust tool output before the model sees it.

  </Step>

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
    grep -r "plugin-sdk/infra-runtime" my-plugin/
    grep -r "plugin-sdk/config-runtime" my-plugin/
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

  <Step title="Replace broad infra-runtime imports">
    `openclaw/plugin-sdk/infra-runtime` still exists for external
    compatibility, but new code should import the focused helper surface it
    actually needs:

    | Need | Import |
    | --- | --- |
    | System event queue helpers | `openclaw/plugin-sdk/system-event-runtime` |
    | Heartbeat event and visibility helpers | `openclaw/plugin-sdk/heartbeat-runtime` |
    | Pending delivery queue drain | `openclaw/plugin-sdk/delivery-queue-runtime` |
    | Channel activity telemetry | `openclaw/plugin-sdk/channel-activity-runtime` |
    | In-memory dedupe caches | `openclaw/plugin-sdk/dedupe-runtime` |
    | Safe local-file/media path helpers | `openclaw/plugin-sdk/file-access-runtime` |
    | Dispatcher-aware fetch | `openclaw/plugin-sdk/runtime-fetch` |
    | Proxy and guarded fetch helpers | `openclaw/plugin-sdk/fetch-runtime` |
    | SSRF dispatcher policy types | `openclaw/plugin-sdk/ssrf-dispatcher` |
    | Approval request/resolution types | `openclaw/plugin-sdk/approval-runtime` |
    | Approval reply payload and command helpers | `openclaw/plugin-sdk/approval-reply-runtime` |
    | Error formatting helpers | `openclaw/plugin-sdk/error-runtime` |
    | Transport readiness waits | `openclaw/plugin-sdk/transport-ready-runtime` |
    | Secure token helpers | `openclaw/plugin-sdk/secure-random-runtime` |
    | Bounded async task concurrency | `openclaw/plugin-sdk/concurrency-runtime` |
    | Numeric coercion | `openclaw/plugin-sdk/number-runtime` |
    | Process-local async lock | `openclaw/plugin-sdk/async-lock-runtime` |
    | File locks | `openclaw/plugin-sdk/file-lock` |

    Bundled plugins are scanner-guarded against `infra-runtime`, so repo code
    cannot regress to the broad barrel.

  </Step>

  <Step title="Migrate channel route helpers">
    New channel route code should use `openclaw/plugin-sdk/channel-route`.
    The older route-key and comparable-target names remain as compatibility
    aliases during the migration window, but new plugins should use the route
    names that describe the behavior directly:

    | Old helper | Modern helper |
    | --- | --- |
    | `channelRouteIdentityKey(...)` | `channelRouteDedupeKey(...)` |
    | `channelRouteKey(...)` | `channelRouteCompactKey(...)` |
    | `ComparableChannelTarget` | `ChannelRouteParsedTarget` |
    | `resolveComparableTargetForChannel(...)` | `resolveRouteTargetForChannel(...)` |
    | `resolveComparableTargetForLoadedChannel(...)` | `resolveRouteTargetForLoadedChannel(...)` |
    | `comparableChannelTargetsMatch(...)` | `channelRouteTargetsMatchExact(...)` |
    | `comparableChannelTargetsShareRoute(...)` | `channelRouteTargetsShareConversation(...)` |

    The modern route helpers normalize `{ channel, to, accountId, threadId }`
    consistently across native approvals, reply suppression, inbound dedupe,
    cron delivery, and session routing. If your plugin owns custom target
    grammar, use `resolveChannelRouteTargetWithParser(...)` to adapt that
    parser into the same route target contract.

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
  | `plugin-sdk/channel-reply-pipeline` | Reply prefix, typing, and source-delivery wiring | `createChannelReplyPipeline`, `resolveChannelSourceReplyDeliveryMode` |
  | `plugin-sdk/channel-config-helpers` | Config adapter factories | `createHybridChannelConfigAdapter` |
  | `plugin-sdk/channel-config-schema` | Config schema builders | Shared channel config schema primitives and the generic builder only |
  | `plugin-sdk/bundled-channel-config-schema` | Bundled config schemas | OpenClaw-maintained bundled plugins only; new plugins must define plugin-local schemas |
  | `plugin-sdk/channel-config-schema-legacy` | Deprecated bundled config schemas | Compatibility alias only; use `plugin-sdk/bundled-channel-config-schema` for maintained bundled plugins |
  | `plugin-sdk/telegram-command-config` | Telegram command config helpers | Command-name normalization, description trimming, duplicate/conflict validation |
  | `plugin-sdk/channel-policy` | Group/DM policy resolution | `resolveChannelGroupRequireMention` |
  | `plugin-sdk/channel-lifecycle` | Account status and draft stream lifecycle helpers | `createAccountStatusSink`, draft preview finalization helpers |
  | `plugin-sdk/inbound-envelope` | Inbound envelope helpers | Shared route + envelope builder helpers |
  | `plugin-sdk/inbound-reply-dispatch` | Inbound reply helpers | Shared record-and-dispatch helpers |
  | `plugin-sdk/messaging-targets` | Messaging target parsing | Target parsing/matching helpers |
  | `plugin-sdk/outbound-media` | Outbound media helpers | Shared outbound media loading |
  | `plugin-sdk/outbound-send-deps` | Outbound send dependency helpers | Lightweight `resolveOutboundSendDep` lookup without importing the full outbound runtime |
  | `plugin-sdk/outbound-runtime` | Outbound runtime helpers | Outbound delivery, identity/send delegate, session, formatting, and payload planning helpers |
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
  | `plugin-sdk/config-runtime` | Deprecated config compatibility shim | Prefer `config-types`, `plugin-config-runtime`, `runtime-config-snapshot`, and `config-mutation` |
  | `plugin-sdk/telegram-command-config` | Telegram command helpers | Fallback-stable Telegram command validation helpers when the bundled Telegram contract surface is unavailable |
  | `plugin-sdk/approval-runtime` | Approval prompt helpers | Exec/plugin approval payload, approval capability/profile helpers, native approval routing/runtime helpers, and structured approval display path formatting |
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
  | `plugin-sdk/system-event-runtime` | System event helpers | `enqueueSystemEvent`, `peekSystemEventEntries` |
  | `plugin-sdk/heartbeat-runtime` | Heartbeat helpers | Heartbeat event and visibility helpers |
  | `plugin-sdk/delivery-queue-runtime` | Delivery queue helpers | `drainPendingDeliveries` |
  | `plugin-sdk/channel-activity-runtime` | Channel activity helpers | `recordChannelActivity` |
  | `plugin-sdk/dedupe-runtime` | Dedupe helpers | In-memory dedupe caches |
  | `plugin-sdk/file-access-runtime` | File access helpers | Safe local-file/media path helpers |
  | `plugin-sdk/transport-ready-runtime` | Transport readiness helpers | `waitForTransportReady` |
  | `plugin-sdk/collection-runtime` | Bounded cache helpers | `pruneMapToMaxSize` |
  | `plugin-sdk/diagnostic-runtime` | Diagnostic gating helpers | `isDiagnosticFlagEnabled`, `isDiagnosticsEnabled` |
  | `plugin-sdk/error-runtime` | Error formatting helpers | `formatUncaughtError`, `isApprovalNotFoundError`, error graph helpers |
  | `plugin-sdk/fetch-runtime` | Wrapped fetch/proxy helpers | `resolveFetch`, proxy helpers |
  | `plugin-sdk/host-runtime` | Host normalization helpers | `normalizeHostname`, `normalizeScpRemoteHost` |
  | `plugin-sdk/retry-runtime` | Retry helpers | `RetryConfig`, `retryAsync`, policy runners |
  | `plugin-sdk/allow-from` | Allowlist formatting | `formatAllowFromLowercase` |
  | `plugin-sdk/allowlist-resolution` | Allowlist input mapping | `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | Command gating and command-surface helpers | `resolveControlCommandGate`, sender-authorization helpers, command registry helpers including dynamic argument menu formatting |
  | `plugin-sdk/command-status` | Command status/help renderers | `buildCommandsMessage`, `buildCommandsMessagePaginated`, `buildHelpMessage` |
  | `plugin-sdk/secret-input` | Secret input parsing | Secret input helpers |
  | `plugin-sdk/webhook-ingress` | Webhook request helpers | Webhook target utilities |
  | `plugin-sdk/webhook-request-guards` | Webhook body guard helpers | Request body read/limit helpers |
  | `plugin-sdk/reply-runtime` | Shared reply runtime | Inbound dispatch, heartbeat, reply planner, chunking |
  | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch helpers | Finalize, provider dispatch, and conversation-label helpers |
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
  | `plugin-sdk/provider-selection-runtime` | Provider selection helpers | Configured-or-auto provider selection and raw provider config merging |
  | `plugin-sdk/provider-env-vars` | Provider env-var helpers | Provider auth env-var lookup helpers |
  | `plugin-sdk/provider-model-shared` | Shared provider model/replay helpers | `ProviderReplayFamily`, `buildProviderReplayFamilyHooks`, `normalizeModelCompat`, shared replay-policy builders, provider-endpoint helpers, and model-id normalization helpers |
  | `plugin-sdk/provider-catalog-shared` | Shared provider catalog helpers | `findCatalogTemplate`, `buildSingleProviderApiKeyCatalog`, `buildManifestModelProviderConfig`, `supportsNativeStreamingUsageCompat`, `applyProviderNativeStreamingUsageCompat` |
  | `plugin-sdk/provider-onboard` | Provider onboarding patches | Onboarding config helpers |
  | `plugin-sdk/provider-http` | Provider HTTP helpers | Generic provider HTTP/endpoint capability helpers, including audio transcription multipart form helpers |
  | `plugin-sdk/provider-web-fetch` | Provider web-fetch helpers | Web-fetch provider registration/cache helpers |
  | `plugin-sdk/provider-web-search-config-contract` | Provider web-search config helpers | Narrow web-search config/credential helpers for providers that do not need plugin-enable wiring |
  | `plugin-sdk/provider-web-search-contract` | Provider web-search contract helpers | Narrow web-search config/credential contract helpers such as `createWebSearchProviderContractFields`, `enablePluginInConfig`, `resolveProviderWebSearchPluginConfig`, and scoped credential setters/getters |
  | `plugin-sdk/provider-web-search` | Provider web-search helpers | Web-search provider registration/cache/runtime helpers |
  | `plugin-sdk/provider-tools` | Provider tool/schema compat helpers | `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, Gemini schema cleanup + diagnostics, and xAI compat helpers such as `resolveXaiModelCompatPatch` / `applyXaiModelCompat` |
  | `plugin-sdk/provider-usage` | Provider usage helpers | `fetchClaudeUsage`, `fetchGeminiUsage`, `fetchGithubCopilotUsage`, and other provider usage helpers |
  | `plugin-sdk/provider-stream` | Provider stream wrapper helpers | `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, and shared Anthropic/Bedrock/DeepSeek V4/Google/Kilocode/Moonshot/OpenAI/OpenRouter/Z.A.I/MiniMax/Copilot wrapper helpers |
  | `plugin-sdk/provider-transport-runtime` | Provider transport helpers | Native provider transport helpers such as guarded fetch, transport message transforms, and writable transport event streams |
  | `plugin-sdk/keyed-async-queue` | Ordered async queue | `KeyedAsyncQueue` |
  | `plugin-sdk/media-runtime` | Shared media helpers | Media fetch/transform/store helpers, ffprobe-backed video dimension probing, and media payload builders |
  | `plugin-sdk/media-generation-runtime` | Shared media-generation helpers | Shared failover helpers, candidate selection, and missing-model messaging for image/video/music generation |
  | `plugin-sdk/media-understanding` | Media-understanding helpers | Media understanding provider types plus provider-facing image/audio helper exports |
  | `plugin-sdk/text-runtime` | Shared text helpers | Assistant-visible-text stripping, markdown render/chunking/table helpers, redaction helpers, directive-tag helpers, safe-text utilities, and related text/logging helpers |
  | `plugin-sdk/text-chunking` | Text chunking helpers | Outbound text chunking helper |
  | `plugin-sdk/speech` | Speech helpers | Speech provider types plus provider-facing directive, registry, validation helpers, and OpenAI-compatible TTS builder |
  | `plugin-sdk/speech-core` | Shared speech core | Speech provider types, registry, directives, normalization |
  | `plugin-sdk/realtime-transcription` | Realtime transcription helpers | Provider types, registry helpers, and shared WebSocket session helper |
  | `plugin-sdk/realtime-voice` | Realtime voice helpers | Provider types, registry/resolution helpers, and bridge session helpers |
  | `plugin-sdk/image-generation` | Image-generation helpers | Image generation provider types plus image asset/data URL helpers and the OpenAI-compatible image provider builder |
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
  | `plugin-sdk/testing` | Test utilities | Legacy broad compatibility barrel; prefer focused test subpaths such as `plugin-sdk/plugin-test-runtime`, `plugin-sdk/channel-test-helpers`, `plugin-sdk/channel-target-testing`, `plugin-sdk/test-env`, and `plugin-sdk/test-fixtures` |
</Accordion>

This table is intentionally the common migration subset, not the full SDK
surface. The full list of 200+ entrypoints lives in
`scripts/lib/plugin-sdk-entrypoints.json`.

Reserved bundled-plugin helper seams have been retired from the public SDK
export map except for explicitly documented compatibility facades such as the
deprecated `plugin-sdk/discord` shim retained for the published
`@openclaw/discord@2026.3.13` package. Owner-specific helpers live inside the
owning plugin package; shared host behavior should move through generic SDK
contracts such as `plugin-sdk/gateway-runtime`, `plugin-sdk/security-runtime`,
and `plugin-sdk/plugin-config-runtime`.

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask maintainers which generic contract
should own it.

## Active deprecations

Narrower deprecations that apply across the plugin SDK, provider contract,
runtime surface, and manifest. Each one still works today but will be removed
in a future major release. The entry below every item maps the old API to its
canonical replacement.

<AccordionGroup>
  <Accordion title="command-auth help builders → command-status">
    **Old (`openclaw/plugin-sdk/command-auth`)**: `buildCommandsMessage`,
    `buildCommandsMessagePaginated`, `buildHelpMessage`.

    **New (`openclaw/plugin-sdk/command-status`)**: same signatures, same
    exports — just imported from the narrower subpath. `command-auth`
    re-exports them as compat stubs.

    ```typescript
    // Before
    import { buildHelpMessage } from "openclaw/plugin-sdk/command-auth";

    // After
    import { buildHelpMessage } from "openclaw/plugin-sdk/command-status";
    ```

  </Accordion>

  <Accordion title="Mention gating helpers → resolveInboundMentionDecision">
    **Old**: `resolveInboundMentionRequirement({ facts, policy })` and
    `shouldDropInboundForMention(...)` from
    `openclaw/plugin-sdk/channel-inbound` or
    `openclaw/plugin-sdk/channel-mention-gating`.

    **New**: `resolveInboundMentionDecision({ facts, policy })` — returns a
    single decision object instead of two split calls.

    Downstream channel plugins (Slack, Discord, Matrix, MS Teams) have already
    switched.

  </Accordion>

  <Accordion title="Channel runtime shim and channel actions helpers">
    `openclaw/plugin-sdk/channel-runtime` is a compatibility shim for older
    channel plugins. Do not import it from new code; use
    `openclaw/plugin-sdk/channel-runtime-context` for registering runtime
    objects.

    `channelActions*` helpers in `openclaw/plugin-sdk/channel-actions` are
    deprecated alongside raw "actions" channel exports. Expose capabilities
    through the semantic `presentation` surface instead — channel plugins
    declare what they render (cards, buttons, selects) rather than which raw
    action names they accept.

  </Accordion>

  <Accordion title="Web search provider tool() helper → createTool() on the plugin">
    **Old**: `tool()` factory from `openclaw/plugin-sdk/provider-web-search`.

    **New**: implement `createTool(...)` directly on the provider plugin.
    OpenClaw no longer needs the SDK helper to register the tool wrapper.

  </Accordion>

  <Accordion title="Plaintext channel envelopes → BodyForAgent">
    **Old**: `formatInboundEnvelope(...)` (and
    `ChannelMessageForAgent.channelEnvelope`) to build a flat plaintext prompt
    envelope from inbound channel messages.

    **New**: `BodyForAgent` plus structured user-context blocks. Channel
    plugins attach routing metadata (thread, topic, reply-to, reactions) as
    typed fields instead of concatenating them into a prompt string. The
    `formatAgentEnvelope(...)` helper is still supported for synthesized
    assistant-facing envelopes, but inbound plaintext envelopes are on the
    way out.

    Affected areas: `inbound_claim`, `message_received`, and any custom
    channel plugin that post-processed `channelEnvelope` text.

  </Accordion>

  <Accordion title="Provider discovery types → provider catalog types">
    Four discovery type aliases are now thin wrappers over the
    catalog-era types:

    | Old alias                 | New type                  |
    | ------------------------- | ------------------------- |
    | `ProviderDiscoveryOrder`  | `ProviderCatalogOrder`    |
    | `ProviderDiscoveryContext`| `ProviderCatalogContext`  |
    | `ProviderDiscoveryResult` | `ProviderCatalogResult`   |
    | `ProviderPluginDiscovery` | `ProviderPluginCatalog`   |

    Plus the legacy `ProviderCapabilities` static bag — provider plugins
    should use explicit provider hooks such as `buildReplayPolicy`,
    `normalizeToolSchemas`, and `wrapStreamFn` rather than a static object.

  </Accordion>

  <Accordion title="Thinking policy hooks → resolveThinkingProfile">
    **Old** (three separate hooks on `ProviderThinkingPolicy`):
    `isBinaryThinking(ctx)`, `supportsXHighThinking(ctx)`, and
    `resolveDefaultThinkingLevel(ctx)`.

    **New**: a single `resolveThinkingProfile(ctx)` that returns a
    `ProviderThinkingProfile` with the canonical `id`, optional `label`, and
    ranked level list. OpenClaw downgrades stale stored values by profile
    rank automatically.

    Implement one hook instead of three. The legacy hooks keep working during
    the deprecation window but are not composed with the profile result.

  </Accordion>

  <Accordion title="External OAuth provider fallback → contracts.externalAuthProviders">
    **Old**: implementing `resolveExternalOAuthProfiles(...)` without
    declaring the provider in the plugin manifest.

    **New**: declare `contracts.externalAuthProviders` in the plugin manifest
    **and** implement `resolveExternalAuthProfiles(...)`. The old "auth
    fallback" path emits a warning at runtime and will be removed.

    ```json
    {
      "contracts": {
        "externalAuthProviders": ["anthropic", "openai"]
      }
    }
    ```

  </Accordion>

  <Accordion title="Provider env-var lookup → setup.providers[].envVars">
    **Old** manifest field: `providerAuthEnvVars: { anthropic: ["ANTHROPIC_API_KEY"] }`.

    **New**: mirror the same env-var lookup into `setup.providers[].envVars`
    on the manifest. This consolidates setup/status env metadata in one
    place and avoids booting the plugin runtime just to answer env-var
    lookups.

    `providerAuthEnvVars` remains supported through a compatibility adapter
    until the deprecation window closes.

  </Accordion>

  <Accordion title="Memory plugin registration → registerMemoryCapability">
    **Old**: three separate calls —
    `api.registerMemoryPromptSection(...)`,
    `api.registerMemoryFlushPlan(...)`,
    `api.registerMemoryRuntime(...)`.

    **New**: one call on the memory-state API —
    `registerMemoryCapability(pluginId, { promptBuilder, flushPlanResolver, runtime })`.

    Same slots, single registration call. Additive memory helpers
    (`registerMemoryPromptSupplement`, `registerMemoryCorpusSupplement`,
    `registerMemoryEmbeddingProvider`) are not affected.

  </Accordion>

  <Accordion title="Subagent session messages types renamed">
    Two legacy type aliases still exported from `src/plugins/runtime/types.ts`:

    | Old                           | New                             |
    | ----------------------------- | ------------------------------- |
    | `SubagentReadSessionParams`   | `SubagentGetSessionMessagesParams` |
    | `SubagentReadSessionResult`   | `SubagentGetSessionMessagesResult` |

    The runtime method `readSession` is deprecated in favor of
    `getSessionMessages`. Same signature; the old method calls through to the
    new one.

  </Accordion>

  <Accordion title="runtime.tasks.flow → runtime.tasks.managedFlows">
    **Old**: `runtime.tasks.flow` (singular) returned a live task-flow accessor.

    **New**: `runtime.tasks.managedFlows` keeps the managed TaskFlow mutation
    runtime for plugins that create, update, cancel, or run child tasks from a
    flow. Use `runtime.tasks.flows` when the plugin only needs DTO-based reads.

    ```typescript
    // Before
    const flow = api.runtime.tasks.flow.fromToolContext(ctx);
    // After
    const flow = api.runtime.tasks.managedFlows.fromToolContext(ctx);
    ```

  </Accordion>

  <Accordion title="Embedded extension factories → agent tool-result middleware">
    Covered in "How to migrate → Migrate Pi tool-result extensions to
    middleware" above. Included here for completeness: the removed Pi-only
    `api.registerEmbeddedExtensionFactory(...)` path is replaced by
    `api.registerAgentToolResultMiddleware(...)` with an explicit runtime
    list in `contracts.agentToolResultMiddleware`.
  </Accordion>

  <Accordion title="OpenClawSchemaType alias → OpenClawConfig">
    `OpenClawSchemaType` re-exported from `openclaw/plugin-sdk` is now a
    one-line alias for `OpenClawConfig`. Prefer the canonical name.

    ```typescript
    // Before
    import type { OpenClawSchemaType } from "openclaw/plugin-sdk";
    // After
    import type { OpenClawConfig } from "openclaw/plugin-sdk/config-schema";
    ```

  </Accordion>
</AccordionGroup>

<Note>
Extension-level deprecations (inside bundled channel/provider plugins under
`extensions/`) are tracked inside their own `api.ts` and `runtime-api.ts`
barrels. They do not affect third-party plugin contracts and are not listed
here. If you consume a bundled plugin's local barrel directly, read the
deprecation comments in that barrel before upgrading.
</Note>

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
