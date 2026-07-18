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

OpenClaw replaced a broad backwards-compatibility layer with a modern plugin
architecture built from small, focused imports. If your plugin predates that
change, this guide gets it onto the current contracts.

## What changed

Two wide-open import surfaces used to let plugins reach almost anything from a
single entry point:

- **`openclaw/plugin-sdk/compat`** - re-exported dozens of helpers to keep
  older hook-based plugins working while the new architecture was built.
- **`openclaw/plugin-sdk/infra-runtime`** - a broad barrel mixing system
  events, heartbeat state, delivery queues, fetch/proxy helpers, file helpers,
  approval types, and unrelated utilities.
- **`openclaw/plugin-sdk/config-runtime`** - a broad config barrel still
  carrying deprecated direct load/write helpers during the migration window.
- **`openclaw/extension-api`** - a bridge giving plugins direct access to
  host-side helpers like the embedded agent runner.
- **`api.registerEmbeddedExtensionFactory(...)`** - a removed embedded-runner-only
  hook that observed embedded-runner events such as `tool_result`. Use agent
  tool-result middleware instead (see [Migrate embedded tool-result extensions
  to middleware](#how-to-migrate)).

These surfaces are **deprecated**: they still work, but new plugins must not
use them, and existing plugins should migrate before the next major release
removes them. `registerEmbeddedExtensionFactory` has already been removed;
legacy registrations no longer load.

<Warning>
  The backwards-compatibility layer will be removed in a future major release.
  Plugins still importing from these surfaces will break when that happens.
</Warning>

OpenClaw does not remove or reinterpret documented plugin behavior in the same
change that introduces a replacement. Breaking contract changes go through a
compatibility adapter, diagnostics, docs, and a deprecation window first. That
applies to SDK imports, manifest fields, setup APIs, hooks, and runtime
registration behavior.

### Why

- **Slow startup** - importing one helper loaded dozens of unrelated modules.
- **Circular dependencies** - broad re-exports made import cycles easy to
  create.
- **Unclear API surface** - no way to tell stable exports from internal ones.

Each `openclaw/plugin-sdk/<subpath>` is now a small, self-contained module with
a documented contract.

Legacy provider convenience seams for bundled channels are gone too -
channel-branded helper shortcuts were private mono-repo conveniences, not
stable plugin contracts. Use narrow generic SDK subpaths instead. Inside the
bundled plugin workspace, keep provider-owned helpers in that plugin's own
`api.ts` or `runtime-api.ts`:

- Anthropic keeps Claude-specific stream helpers in its own `api.ts` /
  `contract-api.ts` seam.
- OpenAI keeps provider builders, default-model helpers, and realtime provider
  builders in its own `api.ts`.
- OpenRouter keeps provider builder and onboarding/config helpers in its own
  `api.ts`.

## Compatibility policy

External-plugin compatibility work follows this order:

1. Add the new contract.
2. Keep the old behavior wired through a compatibility adapter.
3. Emit a diagnostic or warning naming the old path and replacement.
4. Cover both paths in tests.
5. Document the deprecation and migration path.
6. Remove only after the announced migration window, usually in a major
   release.

If a manifest field is still accepted, keep using it until docs and
diagnostics say otherwise. New code should prefer the documented replacement;
existing plugins should not break during ordinary minor releases.

Audit the current migration queue with `pnpm plugins:boundary-report`:

| Flag                                                    | Effect                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `--summary` (or `pnpm plugins:boundary-report:summary`) | Compact counts instead of full detail.                                         |
| `--json`                                                | Machine-readable report.                                                       |
| `--owner <id>`                                          | Filter to one plugin or compatibility owner.                                   |
| `--fail-on-cross-owner`                                 | Exit non-zero on cross-owner reserved SDK imports.                             |
| `--fail-on-eligible-compat`                             | Exit non-zero when a deprecated compat record's `removeAfter` date has passed. |
| `--fail-on-unclassified-unused-reserved`                | Exit non-zero on unused reserved SDK shims.                                    |

`pnpm plugins:boundary-report:ci` runs with all three fail flags. Each
compatibility record has an explicit `removeAfter` date (not a vague "next
major release") - the report groups deprecated records by that date, counts
local code/doc references, surfaces cross-owner reserved SDK imports, and
summarizes the private memory-host SDK bridge. Reserved SDK subpaths must have
tracked owner usage; unused reserved exports should be removed from the public
SDK.

## How to migrate

<Steps>
  <Step title="Migrate runtime config load/write helpers">
    Bundled plugins should stop calling `api.runtime.config.loadConfig()` and
    `api.runtime.config.writeConfigFile(...)` directly. Prefer config already
    passed into the active call path. Long-lived handlers that need the
    current process snapshot can use `api.runtime.config.current()`. Long-lived
    agent tools should read `ctx.getRuntimeConfig()` inside `execute` so a tool
    created before a config write still sees the refreshed config.

    Config writes go through the transactional helper with an explicit
    after-write policy:

    ```typescript
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    Use `afterWrite: { mode: "restart", reason: "..." }` when the change needs
    a clean gateway restart, and `afterWrite: { mode: "none", reason: "..." }`
    only when the caller owns the follow-up and deliberately suppresses the
    reload planner. Mutation results include a typed `followUp` summary for
    tests and logging; the gateway remains responsible for applying or
    scheduling the restart.

    `loadConfig` and `writeConfigFile` remain as deprecated compatibility
    helpers for external plugins and warn once with the
    `runtime-config-load-write` compatibility code. Bundled plugins and repo
    runtime code are guarded by `pnpm check:deprecated-api-usage` and
    `pnpm check:no-runtime-action-load-config`: new production plugin usage
    fails outright, direct config writes fail, gateway server methods must use
    the request runtime snapshot, runtime channel send/action/client helpers
    must receive config from their boundary, and long-lived runtime modules
    allow zero ambient `loadConfig()` calls.

    New plugin code should avoid the broad `openclaw/plugin-sdk/config-runtime`
    barrel. Use the narrow subpath for the job:

    | Need | Import |
    | --- | --- |
    | Config types such as `OpenClawConfig` | `openclaw/plugin-sdk/config-contracts` |
    | Already-loaded config assertions, plugin-entry config lookup, and config merging | `openclaw/plugin-sdk/plugin-config-runtime` |
    | Current runtime snapshot reads | `openclaw/plugin-sdk/runtime-config-snapshot` |
    | Config writes | `openclaw/plugin-sdk/config-mutation` |
    | Session store helpers | `openclaw/plugin-sdk/session-store-runtime` |
    | Markdown table config | `openclaw/plugin-sdk/markdown-table-runtime` |
    | Group policy runtime helpers | `openclaw/plugin-sdk/runtime-group-policy` |
    | Secret input resolution | `openclaw/plugin-sdk/secret-input-runtime` |
    | Model/session overrides | `openclaw/plugin-sdk/model-session-runtime` |

    Bundled plugins and their tests are scanner-guarded against the broad
    barrel so imports and mocks stay local to the behavior they need. The
    barrel still exists for external compatibility, but new code should not
    depend on it.

  </Step>

  <Step title="Migrate embedded tool-result extensions to middleware">
    Bundled plugins must replace embedded-runner-only
    `api.registerEmbeddedExtensionFactory(...)` tool-result handlers with
    runtime-neutral middleware:

    ```typescript
    // OpenClaw runtime tools and Codex runtime dynamic tools (result may be
    // transformed). Codex-native tool results are also relayed for observation,
    // but their transformed output never reaches the model: the Codex
    // PostToolUse hook contract cannot replace a native tool response.
    api.registerAgentToolResultMiddleware(async (event) => {
      return compactToolResult(event);
    }, {
      runtimes: ["openclaw", "codex"],
    });
    ```

    Update the plugin manifest at the same time:

    ```json
    {
      "contracts": {
        "agentToolResultMiddleware": ["openclaw", "codex"]
      }
    }
    ```

    Installed plugins can also register tool-result middleware when explicitly
    enabled and every targeted runtime is declared in
    `contracts.agentToolResultMiddleware`. Undeclared installed middleware
    registrations are rejected.

  </Step>

  <Step title="Migrate approval-native handlers to capability facts">
    Approval-capable channel plugins expose native approval behavior through
    `approvalCapability.nativeRuntime` plus the shared runtime-context
    registry:

    - Replace `approvalCapability.handler.loadRuntime(...)` with
      `approvalCapability.nativeRuntime`.
    - Move approval-specific auth/delivery off legacy `plugin.auth` /
      `plugin.approvals` wiring and onto `approvalCapability`.
    - `ChannelPlugin.approvals` has been removed from the public
      channel-plugin contract; move delivery/native/render fields onto
      `approvalCapability`.
    - `plugin.auth` remains for channel login/logout flows only; core no
      longer reads approval auth hooks there.
    - Register channel-owned runtime objects (clients, tokens, Bolt apps)
      through `openclaw/plugin-sdk/channel-runtime-context`.
    - Do not send plugin-owned reroute notices from native approval handlers;
      core owns routed-elsewhere notices from actual delivery results.
    - When passing `channelRuntime` into `createChannelManager(...)`, provide a
      real `createPluginRuntime().channel` surface - partial stubs are
      rejected.

    See [Channel Plugins](/plugins/sdk-channel-plugins) for the current
    approval capability layout.

  </Step>

  <Step title="Audit Windows wrapper fallback behavior">
    If your plugin uses `openclaw/plugin-sdk/windows-spawn`, unresolved Windows
    `.cmd`/`.bat` wrappers now fail closed unless you explicitly pass
    `allowShellFallback: true`:

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

    For host-side helpers, use the injected plugin runtime instead of
    importing directly:

    ```typescript
    // Before (deprecated extension-api bridge)
    import { runEmbeddedAgent } from "openclaw/extension-api";
    const result = await runEmbeddedAgent({ sessionId, prompt });

    // After (injected runtime)
    const result = await api.runtime.agent.runEmbeddedAgent({ sessionId, prompt });
    ```

    Same pattern for other legacy bridge helpers:

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
    compatibility, but new code should import the focused surface it actually
    needs:

    | Need | Import |
    | --- | --- |
    | System event queue helpers | `openclaw/plugin-sdk/system-event-runtime` |
    | Heartbeat wake, event, and visibility helpers | `openclaw/plugin-sdk/heartbeat-runtime` |
    | Pending delivery queue drain | `openclaw/plugin-sdk/delivery-queue-runtime` |
    | Channel activity telemetry | `openclaw/plugin-sdk/channel-activity-runtime` |
    | In-memory and persistent-backed dedupe caches | `openclaw/plugin-sdk/dedupe-runtime` |
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
    | Required-value assertions for provable invariants | `openclaw/plugin-sdk/expect-runtime` |
    | Numeric coercion | `openclaw/plugin-sdk/number-runtime` |
    | Process-local async lock | `openclaw/plugin-sdk/async-lock-runtime` |
    | File locks | `openclaw/plugin-sdk/file-lock` |

    Bundled plugins are scanner-guarded against `infra-runtime`, so repo code
    cannot regress to the broad barrel.

  </Step>

  <Step title="Migrate channel route helpers">
    New channel route code uses `openclaw/plugin-sdk/channel-route`. The older
    route-key names remain as compatibility aliases:

    | Old helper | Modern helper |
    | --- | --- |
    | `channelRouteIdentityKey(...)` | `channelRouteDedupeKey(...)` |
    | `channelRouteKey(...)` | `channelRouteCompactKey(...)` |

    The modern route helpers normalize `{ channel, to, accountId, threadId }`
    consistently across native approvals, reply suppression, inbound dedupe,
    cron delivery, and session routing.

    Do not add new uses of `ChannelMessagingAdapter.parseExplicitTarget` or
    `resolveChannelRouteTargetWithParser(...)` from
    `plugin-sdk/channel-route` - those are deprecated and remain only for older
    plugins. New channel plugins should use
    `messaging.targetResolver.resolveTarget(...)` for target-id normalization
    and directory-miss fallback,
    `messaging.inferTargetChatType(...)` when core needs an early peer kind,
    and `messaging.resolveOutboundSessionRoute(...)` for provider-native
    session and thread identity.

  </Step>

  <Step title="Build and test">
    ```bash
    pnpm build
    pnpm test my-plugin/
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
  | `plugin-sdk/channel-core` | Focused channel entry definitions and builders | `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `createChannelConfigUiHints` |
  | `plugin-sdk/setup` | Shared setup wizard helpers | Setup translator, allowlist prompts, setup status builders |
  | `plugin-sdk/setup-runtime` | Setup-time runtime helpers | `createSetupTranslator`, import-safe setup patch adapters, lookup-note helpers, `promptResolvedAllowFrom`, `splitSetupEntries`, delegated setup proxies |
  | `plugin-sdk/setup-adapter-runtime` | Deprecated setup adapter alias | Use `plugin-sdk/setup-runtime` |
  | `plugin-sdk/setup-tools` | Setup tooling helpers | `formatCliCommand`, `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`, `CONFIG_DIR` |
  | `plugin-sdk/account-core` | Multi-account helpers | Account list/config/action-gate helpers |
  | `plugin-sdk/account-id` | Account-id helpers | `DEFAULT_ACCOUNT_ID`, account-id normalization |
  | `plugin-sdk/account-resolution` | Account lookup helpers | Account lookup + default-fallback helpers |
  | `plugin-sdk/account-helpers` | Narrow account helpers | Account list/account-action helpers |
  | `plugin-sdk/channel-setup` | Setup wizard adapters | `createOptionalChannelSetupSurface`, `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`, plus `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`, `setSetupChannelEnabled`, `splitSetupEntries` |
  | `plugin-sdk/channel-pairing` | DM pairing primitives | `createChannelPairingController` |
  | `plugin-sdk/channel-reply-pipeline` | Reply prefix, typing, and source-delivery wiring | `createChannelReplyPipeline`, `resolveChannelSourceReplyDeliveryMode` |
  | `plugin-sdk/channel-config-helpers` | Config adapter factories and DM access helpers | `createHybridChannelConfigAdapter`, `resolveChannelDmAccess`, `resolveChannelDmAllowFrom`, `resolveChannelDmPolicy`, `normalizeChannelDmPolicy`, `normalizeLegacyDmAliases` |
  | `plugin-sdk/channel-config-schema` | Config schema builders | Shared channel config schema primitives and the generic builder only |
  | `plugin-sdk/bundled-channel-config-schema` | Bundled config schemas | OpenClaw-maintained bundled plugins only; new plugins must define plugin-local schemas |
  | `plugin-sdk/channel-config-schema-legacy` | Deprecated bundled config schemas | Compatibility alias only; use `plugin-sdk/bundled-channel-config-schema` for maintained bundled plugins |
  | `plugin-sdk/telegram-command-config` | Telegram command config helpers | Command-name normalization, description trimming, duplicate/conflict validation |
  | `plugin-sdk/channel-policy` | Group/DM policy resolution | `resolveChannelGroupRequireMention` |
  | `plugin-sdk/channel-lifecycle` | Deprecated compatibility facade | Use `plugin-sdk/channel-outbound` |
  | `plugin-sdk/inbound-envelope` | Inbound envelope helpers | Shared route + envelope builder helpers |
  | `plugin-sdk/channel-inbound` | Inbound receive helpers | Context building, formatting, roots, runners, prepared reply dispatch, and dispatch predicates |
  | `plugin-sdk/messaging-targets` | Deprecated target parsing import path | Use `plugin-sdk/channel-targets` for generic target parsing helpers, `plugin-sdk/channel-route` for route comparison, and plugin-owned `messaging.targetResolver` / `messaging.resolveOutboundSessionRoute` for provider-specific target resolution |
  | `plugin-sdk/outbound-media` | Outbound media helpers | Shared outbound media loading |
  | `plugin-sdk/outbound-send-deps` | Deprecated compatibility facade | Use `plugin-sdk/channel-outbound` |
  | `plugin-sdk/channel-outbound` | Outbound message lifecycle helpers | Message adapters, receipts, durable send helpers, live preview/streaming helpers, reply options, lifecycle helpers, outbound identity, and payload planning |
  | `plugin-sdk/channel-streaming` | Deprecated compatibility facade | Use `plugin-sdk/channel-outbound` |
  | `plugin-sdk/outbound-runtime` | Deprecated compatibility facade | Use `plugin-sdk/channel-outbound` |
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
  | `plugin-sdk/gateway-runtime` | Gateway helpers | Gateway client, event-loop-ready start helper, advertised LAN host resolution, and channel-status patch helpers |
  | `plugin-sdk/config-runtime` | Deprecated config compatibility shim | Prefer `config-contracts`, `plugin-config-runtime`, `runtime-config-snapshot`, and `config-mutation` |
  | `plugin-sdk/telegram-command-config` | Telegram command helpers | Fallback-stable Telegram command validation helpers when the bundled Telegram contract surface is unavailable |
  | `plugin-sdk/approval-runtime` | Approval prompt helpers | Exec/plugin approval payload, approval capability/profile helpers, native approval routing/runtime helpers, and structured approval display path formatting |
  | `plugin-sdk/approval-auth-runtime` | Approval auth helpers | Approver resolution, same-chat action auth |
  | `plugin-sdk/approval-client-runtime` | Approval client helpers | Native exec approval profile/filter helpers |
  | `plugin-sdk/approval-delivery-runtime` | Approval delivery helpers | Native approval capability/delivery adapters |
  | `plugin-sdk/approval-gateway-runtime` | Approval gateway helpers | Shared approval gateway resolver |
  | `plugin-sdk/approval-reference-runtime` | Approval transport references | Deterministic durable-locator helper for transport-limited callbacks |
  | `plugin-sdk/approval-handler-adapter-runtime` | Approval adapter helpers | Lightweight native approval adapter loading helpers for hot channel entrypoints |
  | `plugin-sdk/approval-handler-runtime` | Approval handler helpers | Broader approval handler runtime helpers; prefer the narrower adapter/gateway seams when they are enough |
  | `plugin-sdk/approval-native-runtime` | Approval target helpers | Native approval target/account binding helpers |
  | `plugin-sdk/approval-reply-runtime` | Approval reply helpers | Exec/plugin approval reply payload helpers |
  | `plugin-sdk/channel-runtime-context` | Channel runtime-context helpers | Generic channel runtime-context register/get/watch helpers |
  | `plugin-sdk/security-runtime` | Security helpers | Shared trust, DM gating, root-bounded file/path helpers, external-content, and secret-collection helpers |
  | `plugin-sdk/ssrf-policy` | SSRF policy helpers | Host allowlist and private-network policy helpers |
  | `plugin-sdk/ssrf-runtime` | SSRF runtime helpers | Pinned-dispatcher, guarded fetch, SSRF policy helpers |
  | `plugin-sdk/system-event-runtime` | System event helpers | `enqueueSystemEvent` (including keyed replacement), `peekSystemEventEntries` |
  | `plugin-sdk/heartbeat-runtime` | Heartbeat helpers | Heartbeat wake, event, and visibility helpers |
  | `plugin-sdk/delivery-queue-runtime` | Delivery queue helpers | `drainPendingDeliveries` |
  | `plugin-sdk/channel-activity-runtime` | Channel activity helpers | `recordChannelActivity` |
  | `plugin-sdk/dedupe-runtime` | Dedupe helpers | In-memory and persistent-backed dedupe caches |
  | `plugin-sdk/file-access-runtime` | File access helpers | Safe local-file/media path helpers |
  | `plugin-sdk/transport-ready-runtime` | Transport readiness helpers | `waitForTransportReady` |
  | `plugin-sdk/exec-approvals-runtime` | Exec approval policy helpers | `loadExecApprovals`, `resolveExecApprovalsFromFile`, `ExecApprovalsFile` |
  | `plugin-sdk/collection-runtime` | Bounded cache helpers | `pruneMapToMaxSize` |
  | `plugin-sdk/diagnostic-runtime` | Diagnostic gating helpers | `isDiagnosticFlagEnabled`, `isDiagnosticsEnabled` |
  | `plugin-sdk/error-runtime` | Error helpers | `formatUncaughtError`, `isApprovalNotFoundError`, error graph helpers, `PlatformMessageNotDispatchedError` |
  | `plugin-sdk/fetch-runtime` | Wrapped fetch/proxy helpers | `resolveFetch`, proxy helpers, EnvHttpProxyAgent option helpers |
  | `plugin-sdk/host-runtime` | Host normalization helpers | `normalizeHostname`, `normalizeScpRemoteHost` |
  | `plugin-sdk/retry-runtime` | Retry helpers | `RetryConfig`, `retryAsync`, policy runners |
  | `plugin-sdk/allow-from` | Allowlist formatting and input mapping | `formatAllowFromLowercase`, `mapAllowlistResolutionInputs` |
  | `plugin-sdk/command-auth` | Command gating and command-surface helpers | `resolveControlCommandGate`, sender-authorization helpers, command registry helpers including dynamic argument menu formatting |
  | `plugin-sdk/command-status` | Command status/help renderers | `buildCommandsMessage`, `buildCommandsMessagePaginated`, `buildHelpMessage` |
  | `plugin-sdk/secret-input` | Secret input parsing | Secret input helpers |
  | `plugin-sdk/webhook-ingress` | Webhook request helpers | Webhook target utilities |
  | `plugin-sdk/webhook-request-guards` | Webhook body guard helpers | Request body read/limit helpers |
  | `plugin-sdk/reply-runtime` | Shared reply runtime | Inbound dispatch, heartbeat, reply planner, chunking |
  | `plugin-sdk/reply-dispatch-runtime` | Narrow reply dispatch helpers | Finalize, provider dispatch, and conversation-label helpers |
  | `plugin-sdk/reply-history` | Reply-history helpers | `createChannelHistoryWindow`; deprecated map-helper compatibility exports such as `buildPendingHistoryContextFromMap`, `recordPendingHistoryEntry`, and `clearHistoryEntriesIfEnabled` |
  | `plugin-sdk/reply-reference` | Reply reference planning | `createReplyReferencePlanner` |
  | `plugin-sdk/reply-chunking` | Reply chunk helpers | Text/markdown chunking helpers |
  | `plugin-sdk/session-store-runtime` | Session store helpers | Scoped session row helpers, store path helpers, and updated-at reads |
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
  | `plugin-sdk/provider-tools` | Provider tool/schema compat helpers | `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks`, and DeepSeek/Gemini/OpenAI schema cleanup + diagnostics |
  | `plugin-sdk/provider-usage` | Provider usage helpers | `fetchClaudeUsage`, `fetchGeminiUsage`, `fetchGithubCopilotUsage`, and other provider usage helpers |
  | `plugin-sdk/provider-stream` | Provider stream wrapper helpers | `ProviderStreamFamily`, `buildProviderStreamFamilyHooks`, `composeProviderStreamWrappers`, stream wrapper types, and shared Anthropic/Bedrock/DeepSeek V4/Google/Kilocode/Moonshot/OpenAI/OpenRouter/Z.A.I/MiniMax/Copilot wrapper helpers |
  | `plugin-sdk/provider-transport-runtime` | Provider transport helpers | Native provider transport helpers such as guarded fetch, tool-result text extraction, transport message transforms, and writable transport event streams |
  | `plugin-sdk/keyed-async-queue` | Ordered async queue | `KeyedAsyncQueue` |
  | `plugin-sdk/media-runtime` | Shared media helpers | Media fetch/transform/store helpers, ffprobe-backed video dimension probing, and media payload builders |
  | `plugin-sdk/media-generation-runtime` | Shared media-generation helpers | Shared failover helpers, candidate selection, and missing-model messaging for image/video/music generation |
  | `plugin-sdk/media-understanding` | Media-understanding helpers | Media understanding provider types plus provider-facing image/audio helper exports |
  | `plugin-sdk/text-runtime` | Deprecated broad text compatibility export | Use `string-coerce-runtime`, `text-chunking`, `text-utility-runtime`, and `logging-core` |
  | `plugin-sdk/text-chunking` | Text chunking helpers | Outbound text and offset-preserving range chunking helpers |
  | `plugin-sdk/speech` | Speech helpers | Speech provider types plus provider-facing directive, registry, validation helpers, and OpenAI-compatible TTS builder |
  | `plugin-sdk/speech-core` | Shared speech core | Speech provider types, registry, directives, normalization |
  | `plugin-sdk/speech-settings` | Speech settings | Lightweight TTS config resolution and normalization primitives without provider registries or synthesis runtime |
  | `plugin-sdk/realtime-transcription` | Realtime transcription helpers | Provider types, registry helpers, and shared WebSocket session helper |
  | `plugin-sdk/realtime-voice` | Realtime voice helpers | Provider types, registry/resolution helpers, bridge session helpers, the transport-independent session harness, audio-energy/speech-onset gates, shared agent talk-back queues, active-run voice control, transcript/event health, echo suppression, consult question matching, forced-consult coordination, turn-context tracking, output activity tracking, and fast context consult helpers |
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
  | `plugin-sdk/direct-dm`, `plugin-sdk/direct-dm-access` | Deprecated compatibility facades | Use `plugin-sdk/channel-inbound` |
  | `plugin-sdk/direct-dm-guard-policy` | Direct-DM guard helpers | Narrow pre-crypto guard policy helpers |
  | `plugin-sdk/extension-shared` | Shared extension helpers | Passive-channel/status and ambient proxy helper primitives |
  | `plugin-sdk/webhook-targets` | Webhook target helpers | Webhook target registry and route-install helpers |
  | `plugin-sdk/webhook-path` | Deprecated webhook path alias | Use `plugin-sdk/webhook-ingress` |
  | `plugin-sdk/web-media` | Shared web media helpers | Remote/local media loading helpers |
  | `plugin-sdk/zod` | Deprecated Zod compatibility re-export | Import `zod` from `zod` directly |
  | `plugin-sdk/memory-core` | Bundled memory-core helpers | Memory manager/config/file/CLI helper surface |
  | `plugin-sdk/memory-core-engine-runtime` | Memory engine runtime facade | Memory index/search runtime facade |
  | `plugin-sdk/memory-core-host-embedding-registry` | Memory embedding registry | Lightweight memory embedding provider registry helpers |
  | `plugin-sdk/memory-core-host-engine-foundation` | Memory host foundation engine | Memory host foundation engine exports |
  | `plugin-sdk/memory-core-host-engine-embeddings` | Memory host embedding engine | Memory embedding contracts, registry access, local provider, and generic batch/remote helpers; concrete remote providers live in their owning plugins |
  | `plugin-sdk/memory-core-host-engine-qmd` | Memory host QMD engine | Memory host QMD engine exports |
  | `plugin-sdk/memory-core-host-engine-storage` | Memory host storage engine | Memory host storage engine exports |
  | `plugin-sdk/memory-core-host-multimodal` | Memory host multimodal helpers | Memory host multimodal helpers |
  | `plugin-sdk/memory-core-host-query` | Memory host query helpers | Memory host query helpers |
  | `plugin-sdk/memory-core-host-secret` | Memory host secret helpers | Memory host secret helpers |
  | `plugin-sdk/memory-core-host-events` | Deprecated memory event alias | Use `plugin-sdk/memory-host-events` |
  | `plugin-sdk/memory-core-host-status` | Memory host status helpers | Memory host status helpers |
  | `plugin-sdk/memory-core-host-runtime-cli` | Memory host CLI runtime | Memory host CLI runtime helpers |
  | `plugin-sdk/memory-core-host-runtime-core` | Memory host core runtime | Memory host core runtime helpers |
  | `plugin-sdk/memory-core-host-runtime-files` | Memory host file/runtime helpers | Memory host file/runtime helpers |
  | `plugin-sdk/memory-host-core` | Memory host core runtime alias | Vendor-neutral alias for memory host core runtime helpers |
  | `plugin-sdk/memory-host-events` | Memory host event journal alias | Vendor-neutral alias for memory host event journal helpers |
  | `plugin-sdk/memory-host-files` | Deprecated memory file/runtime alias | Use `plugin-sdk/memory-core-host-runtime-files` |
  | `plugin-sdk/memory-host-markdown` | Managed markdown helpers | Shared managed-markdown helpers for memory-adjacent plugins |
  | `plugin-sdk/memory-host-search` | Active memory search facade | Lazy active-memory search-manager runtime facade |
  | `plugin-sdk/memory-host-status` | Deprecated memory host status alias | Use `plugin-sdk/memory-core-host-status` |
</Accordion>

This table is the common migration subset, not the full SDK surface. The
compiler entrypoint inventory lives in `scripts/lib/plugin-sdk-entrypoints.json`;
package exports are generated from the public subset.

Reserved bundled-plugin helper seams have been retired from the public SDK
export map except for explicitly documented compatibility facades such as the
deprecated `plugin-sdk/discord` shim retained for external plugins that still
import the published `@openclaw/discord` package directly. Owner-specific
helpers live inside the owning plugin package; shared host behavior moves
through generic SDK contracts such as `plugin-sdk/gateway-runtime`,
`plugin-sdk/security-runtime`, and `plugin-sdk/plugin-config-runtime`.

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask maintainers which generic
contract should own it.

## Removed compatibility surfaces

### Private testing barrel

`openclaw/plugin-sdk/testing` was repo-local and excluded from shipped package
artifacts, so it was removed before its 2026-07-28 `removeAfter` date. Repository
tests use focused subpaths such as `plugin-sdk/plugin-test-runtime`,
`plugin-sdk/channel-test-helpers`, `plugin-sdk/channel-target-testing`,
`plugin-sdk/test-env`, and `plugin-sdk/test-fixtures`.

## Active deprecations

Narrower deprecations across the plugin SDK, provider contract, runtime
surface, and manifest. Each still works today but will be removed in a future
major release. Every entry maps the old API to its canonical replacement.

<AccordionGroup>
  <Accordion title="command-auth help builders -> command-status">
    **Old (`openclaw/plugin-sdk/command-auth`)**: `buildCommandsMessage`,
    `buildCommandsMessagePaginated`, `buildHelpMessage`.

    **New (`openclaw/plugin-sdk/command-status`)**: same signatures, same
    exports - just imported from the narrower subpath. `command-auth`
    re-exports them as compat stubs.

    ```typescript
    // Before
    import { buildHelpMessage } from "openclaw/plugin-sdk/command-auth";

    // After
    import { buildHelpMessage } from "openclaw/plugin-sdk/command-status";
    ```

  </Accordion>

  <Accordion title="Mention gating helpers -> resolveInboundMentionDecision">
    **Old**: `resolveMentionGating(params)` and
    `resolveMentionGatingWithBypass(params)` from
    `openclaw/plugin-sdk/channel-inbound` or
    `openclaw/plugin-sdk/channel-mention-gating`.

    **New**: `resolveInboundMentionDecision({ facts, policy })` - one decision
    object instead of two split call shapes.

    Adopted across Discord, iMessage, Matrix, MS Teams, QQBot, Signal,
    Telegram, WhatsApp, and Zalo. Slack's own `app_mention` event model does
    not use this helper.

  </Accordion>

  <Accordion title="Channel runtime shim and channel actions helpers">
    `openclaw/plugin-sdk/channel-runtime` is a compatibility shim for older
    channel plugins. Do not import it from new code; use
    `openclaw/plugin-sdk/channel-runtime-context` for registering runtime
    objects.

    `channelActions*` helpers in `openclaw/plugin-sdk/channel-actions` are
    deprecated alongside raw "actions" channel exports. Expose capabilities
    through the semantic `presentation` surface instead - channel plugins
    declare what they render (cards, buttons, selects) rather than which raw
    action names they accept.

  </Accordion>

  <Accordion title="Web search provider tool() helper -> createTool() on the plugin">
    **Old**: `tool()` factory from `openclaw/plugin-sdk/provider-web-search`.

    **New**: implement `createTool(...)` directly on the provider plugin.
    OpenClaw no longer needs the SDK helper to register the tool wrapper.

  </Accordion>

  <Accordion title="Plaintext channel envelopes -> BodyForAgent">
    **Old**: `api.runtime.channel.reply.formatInboundEnvelope(...)` (and the
    `channelEnvelope` field on inbound message objects) to build a flat
    plaintext prompt envelope from inbound channel messages.

    **New**: `BodyForAgent` plus structured user-context blocks. Channel
    plugins attach routing metadata (thread, topic, reply-to, reactions) as
    typed fields instead of concatenating them into a prompt string. The
    `formatAgentEnvelope(...)` helper is still supported for synthesized
    assistant-facing envelopes, but inbound plaintext envelopes are on the way
    out.

    Affected areas: `inbound_claim`, `message_received`, and any custom
    channel plugin that post-processed the old envelope text.

  </Accordion>

  <Accordion title="deactivate hook -> gateway_stop">
    **Old**: `api.on("deactivate", handler)`.

    **New**: `api.on("gateway_stop", handler)`. Same shutdown cleanup
    contract; only the hook name changes.

    ```typescript
    // Before
    api.on("deactivate", async (event, ctx) => {
      await stopPluginService(ctx);
    });

    // After
    api.on("gateway_stop", async (event, ctx) => {
      await stopPluginService(ctx);
    });
    ```

    `deactivate` remains wired as a deprecated compatibility alias until it is
    removed after 2026-08-16.

  </Accordion>

  <Accordion title="subagent_spawning hook -> core thread binding">
    **Old**: `api.on("subagent_spawning", handler)` returning
    `threadBindingReady` or `deliveryOrigin`.

    **New**: let core prepare `thread: true` subagent bindings through the
    channel session-binding adapter. Use `api.on("subagent_spawned", handler)`
    only for post-launch observation.

    ```typescript
    // Before
    api.on("subagent_spawning", async () => ({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: { channel: "discord", to: "channel:123", threadId: "456" },
    }));

    // After
    api.on("subagent_spawned", async (event) => {
      await observeSubagentLaunch(event);
    });
    ```

    `subagent_spawning`, `PluginHookSubagentSpawningEvent`,
    `PluginHookSubagentSpawningResult`, and
    `SubagentLifecycleHookRunner.runSubagentSpawning(...)` remain only as
    deprecated compatibility surfaces while external plugins migrate, removed
    after 2026-08-30.

  </Accordion>

  <Accordion title="Provider discovery types -> provider catalog types">
    Four discovery type aliases are now thin wrappers over the catalog-era
    types:

    | Old alias                 | New type                  |
    | ------------------------- | ------------------------- |
    | `ProviderDiscoveryOrder`  | `ProviderCatalogOrder`    |
    | `ProviderDiscoveryContext`| `ProviderCatalogContext`  |
    | `ProviderDiscoveryResult` | `ProviderCatalogResult`   |
    | `ProviderPluginDiscovery` | `ProviderPluginCatalog`   |

    Plus the legacy `ProviderCapabilities` static bag - provider plugins
    should use explicit provider hooks such as `buildReplayPolicy`,
    `normalizeToolSchemas`, and `wrapStreamFn` rather than a static object.

  </Accordion>

  <Accordion title="Thinking policy hooks -> resolveThinkingProfile">
    **Old** (three separate hooks on `ProviderThinkingPolicy`):
    `isBinaryThinking(ctx)`, `supportsXHighThinking(ctx)`, and
    `resolveDefaultThinkingLevel(ctx)`.

    **New**: a single `resolveThinkingProfile(ctx)` that returns a
    `ProviderThinkingProfile` with the canonical `id`, optional `label`, and a
    ranked level list. OpenClaw downgrades stale stored values by profile rank
    automatically.

    The context includes `provider`, `modelId`, optional merged `reasoning`,
    and optional merged model `compat` facts. Provider plugins can use those
    catalog facts to expose a model-specific profile only when the configured
    request contract supports it.

    Implement one hook instead of three. The legacy hooks keep working during
    the deprecation window but are not composed with the profile result.

  </Accordion>

  <Accordion title="External auth providers -> contracts.externalAuthProviders">
    **Old**: implementing external auth hooks without declaring the provider
    in the plugin manifest.

    **New**: declare `contracts.externalAuthProviders` in the plugin manifest
    **and** implement `resolveExternalAuthProfiles(...)`.

    ```json
    {
      "contracts": {
        "externalAuthProviders": ["anthropic", "openai"]
      }
    }
    ```

  </Accordion>

  <Accordion title="Provider env-var lookup -> setup.providers[].envVars">
    **Old** manifest field: `providerAuthEnvVars: { anthropic: ["ANTHROPIC_API_KEY"] }`.

    **New**: mirror the same env-var lookup into `setup.providers[].envVars`
    on the manifest. This consolidates setup/status env metadata in one place
    and avoids booting the plugin runtime just to answer env-var lookups.

    `providerAuthEnvVars` remains supported through a compatibility adapter
    until the deprecation window closes.

  </Accordion>

  <Accordion title="Memory plugin registration -> registerMemoryCapability">
    **Old**: three separate calls - `api.registerMemoryPromptSection(...)`,
    `api.registerMemoryFlushPlan(...)`, `api.registerMemoryRuntime(...)`.

    **New**: one call on the memory-state API -
    `registerMemoryCapability(pluginId, { promptBuilder, flushPlanResolver, runtime })`.

    Same slots, single registration call. Additive prompt and corpus helpers
    (`registerMemoryPromptSupplement`, `registerMemoryCorpusSupplement`) are
    not affected.

  </Accordion>

  <Accordion title="Memory embedding provider API">
    **Old**: `api.registerMemoryEmbeddingProvider(...)` plus
    `contracts.memoryEmbeddingProviders`.

    **New**: `api.registerEmbeddingProvider(...)` plus
    `contracts.embeddingProviders`.

    The generic embedding provider contract is reusable outside memory and is
    the supported path for new providers. The memory-specific registration API
    remains wired as deprecated compatibility while existing providers
    migrate. Plugin inspection reports non-bundled usage as compatibility
    debt.

  </Accordion>

  <Accordion title="Raw channel send results -> OutboundDeliveryResult">
    **Old**: return `{ ok, messageId, error }` through
    `ChannelSendRawResult` and normalize it with
    `createRawChannelSendResultAdapter(...)`.

    **New**: return `OutboundDeliveryResult` fields and attach the channel with
    `createAttachedChannelResultAdapter(...)`. Failed sends should throw instead
    of returning an error string. The raw result type remains available until
    the next plugin-SDK major release.

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

  <Accordion title="Removed session and transcript file APIs">
    The SQLite session/transcript flip removes or deprecates plugin-facing APIs
    that exposed active `sessions.json` stores, JSONL transcript paths, or lists
    of session files. Runtime plugins should use session identity and SDK runtime
    helpers instead of resolving or mutating active files.

    | Migrating surface | Replacement |
    | ----------------- | ----------- |
    | Deprecated `loadSessionStore(...)`, `updateSessionStore(...)`, and `resolveSessionStoreEntry(...)` | `getSessionEntry(...)`, `listSessionEntries(...)`, and row-level session mutations. |
    | Deprecated `resolveSessionFilePath(...)` | Session identity (`sessionKey`, `sessionId`, and SDK runtime target helpers) plus Gateway methods that operate on the current session. |
    | Removed `saveSessionStore(...)` | Gateway-owned session runtime APIs; plugin code should request or mutate session state through documented runtime/context helpers instead of writing the active store file. |
    | Removed `resolveSessionTranscriptPathInDir(...)` and `resolveAndPersistSessionFile(...)` | Session identity and Gateway methods that operate on the current session. |
    | `readLatestAssistantTextFromSessionTranscript(...)` | Identity-backed transcript readers exposed by the current runtime context, or Gateway history/session methods when the plugin is outside the transcript owner path. |
    | `SessionTranscriptUpdate.sessionFile` | `SessionTranscriptUpdate.target` with `agentId`, `sessionKey`, and `sessionId`. |
    | Memory sync inputs such as `sessionFiles` | Identity-backed transcript/session sources provided by the host; do not crawl active JSONL files for live sessions. |
    | Runtime options named `transcriptPath` or `sessionFile` for active sessions | `sessionTarget`/runtime target objects that carry storage-neutral session identity. |

    Legacy JSONL transcript files remain valid as import, archive, export, and
    support artifacts. They are no longer the steady-state runtime contract for
    active sessions.

    Official plugins released with `v2026.7.1-beta.5` imported the four
    deprecated helpers above. `openclaw/plugin-sdk/session-store-runtime` keeps
    that exact bridge through 2026-10-12; new plugins must use the replacements.
    `resolveStorePath(...)` remains a supported SDK helper and is not part of
    this deprecation.

    `openclaw plugins inspect --all --runtime` reports non-bundled plugins whose
    load errors or diagnostics still reference these removed file APIs. The
    `@openclaw/plugin-inspector` advisory sweep must use version `0.3.17` or
    newer so external package scans also flag whole-store session helpers,
    session file-path helpers, legacy transcript file targets, and low-level
    transcript helpers before release.

  </Accordion>

  <Accordion title="runtime.tasks.flow -> runtime.tasks.managedFlows">
    **Old**: `runtime.tasks.flow` (singular) returned a live task-flow
    accessor.

    **New**: `runtime.tasks.managedFlows` keeps the managed TaskFlow mutation
    runtime for plugins that create, update, cancel, or run child tasks from a
    flow. Use `runtime.tasks.flows` when the plugin only needs DTO-based
    reads.

    ```typescript
    // Before
    const flow = api.runtime.tasks.flow.fromToolContext(ctx);
    // After
    const flow = api.runtime.tasks.managedFlows.fromToolContext(ctx);
    ```

    Removed after 2026-07-26.

  </Accordion>

  <Accordion title="Embedded extension factories -> agent tool-result middleware">
    Covered in [How to migrate](#how-to-migrate) above. Included here for
    completeness: the removed embedded-runner-only
    `api.registerEmbeddedExtensionFactory(...)` path is replaced by
    `api.registerAgentToolResultMiddleware(...)` with an explicit runtime list
    in `contracts.agentToolResultMiddleware`.
  </Accordion>

  <Accordion title="OpenClawSchemaType alias -> OpenClawConfig">
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

## Talk and realtime voice migration

Realtime voice, telephony, meeting, and browser Talk code shares one Talk
session controller exported by `openclaw/plugin-sdk/realtime-voice`. The
controller owns the common Talk event envelope, active turn state, capture
state, output-audio state, recent event history, and stale-turn rejection.
Provider plugins own vendor-specific realtime sessions. Browser-meeting plugins
use `openclaw/plugin-sdk/meeting-runtime` for session, browser, audio, node-host,
agent-consult, and voice-call mechanics, then implement `MeetingPlatformAdapter`
for URL rules, DOM scripts, manual-action mapping, captions, creation, and dial-in
plans. Platform REST APIs, OAuth, artifacts, selectors, and wire names remain in
the plugin.

All bundled surfaces run on the shared controller: browser relay,
managed-room handoff, voice-call realtime, voice-call streaming STT, Google
Meet realtime, and native push-to-talk. Gateway advertises one live Talk event
channel in `hello-ok.features.events`: `talk.event`.

New code should not call `createTalkEventSequencer(...)` directly unless
implementing a low-level adapter or test fixture. Use the shared controller so
turn-scoped events cannot be emitted without a turn id, stale `turnEnd` /
`turnCancel` calls cannot clear a newer active turn, and output-audio
lifecycle events stay consistent across telephony, meetings, browser relay,
managed-room handoff, and native Talk clients.

The public API shape:

```typescript
// Gateway-owned Talk session API.
await gateway.request("talk.session.create", {
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  sessionKey: "main",
});
await gateway.request("talk.session.appendAudio", { sessionId, audioBase64 });
await gateway.request("talk.session.cancelOutput", { sessionId, reason: "barge-in" });
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  result: { status: "working" },
  options: { willContinue: true },
});
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  result: { status: "already_delivered" },
  options: { suppressResponse: true },
});
await gateway.request("talk.session.submitToolResult", { sessionId, callId, result });
await gateway.request("talk.session.close", { sessionId });

// Client-owned provider session API.
await gateway.request("talk.client.create", {
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult",
  sessionKey: "main",
});
await gateway.request("talk.client.toolCall", { sessionKey, callId, name, args });
await gateway.request("talk.client.steer", { sessionKey, text, mode: "steer" });
```

Browser-owned WebRTC/provider-websocket sessions use `talk.client.create`,
because the browser owns provider negotiation and media transport while the
Gateway owns credentials, instructions, and tool policy. `talk.session.*` is
the common Gateway-managed surface for gateway-relay realtime, gateway-relay
transcription, and managed-room native STT/TTS sessions.

Legacy configs that place realtime selectors beside `talk.provider` /
`talk.providers` should be repaired with `openclaw doctor --fix`; runtime Talk
does not reinterpret speech/TTS provider config as realtime provider config.

The supported `talk.session.create` combinations are intentionally small:

| Mode            | Transport       | Brain           | Owner              | Notes                                                                                                              |
| --------------- | --------------- | --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `realtime`      | `gateway-relay` | `agent-consult` | Gateway            | Full-duplex provider audio bridged through the Gateway; tool calls route through the agent-consult tool.           |
| `transcription` | `gateway-relay` | `none`          | Gateway            | Streaming STT only; callers send input audio and receive transcript events.                                        |
| `stt-tts`       | `managed-room`  | `agent-consult` | Native/client room | Push-to-talk and walkie-talkie style rooms where the client owns capture/playback and the Gateway owns turn state. |
| `stt-tts`       | `managed-room`  | `direct-tools`  | Native/client room | Admin-only room mode for trusted first-party surfaces that execute Gateway tool actions directly.                  |

Method map for readers migrating from the older `talk.realtime.*` /
`talk.transcription.*` / `talk.handoff.*` families (all removed):

| Old                              | New                                                      |
| -------------------------------- | -------------------------------------------------------- |
| `talk.realtime.session`          | `talk.client.create`                                     |
| `talk.realtime.toolCall`         | `talk.client.toolCall`                                   |
| `talk.realtime.relayAudio`       | `talk.session.appendAudio`                               |
| `talk.realtime.relayCancel`      | `talk.session.cancelOutput` or `talk.session.cancelTurn` |
| `talk.realtime.relayToolResult`  | `talk.session.submitToolResult`                          |
| `talk.realtime.relayStop`        | `talk.session.close`                                     |
| `talk.transcription.session`     | `talk.session.create({ mode: "transcription" })`         |
| `talk.transcription.relayAudio`  | `talk.session.appendAudio`                               |
| `talk.transcription.relayCancel` | `talk.session.cancelTurn`                                |
| `talk.transcription.relayStop`   | `talk.session.close`                                     |
| `talk.handoff.create`            | `talk.session.create({ transport: "managed-room" })`     |
| `talk.handoff.join`              | `talk.session.join`                                      |
| `talk.handoff.revoke`            | `talk.session.close`                                     |

The unified control vocabulary is also deliberately narrow:

| Method                          | Applies to                                              | Contract                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talk.session.appendAudio`      | `realtime/gateway-relay`, `transcription/gateway-relay` | Append a base64 PCM audio chunk to the provider session owned by the same Gateway connection.                                                                                                                             |
| `talk.session.startTurn`        | `stt-tts/managed-room`                                  | Start a managed-room user turn.                                                                                                                                                                                           |
| `talk.session.endTurn`          | `stt-tts/managed-room`                                  | End the active turn after stale-turn validation.                                                                                                                                                                          |
| `talk.session.cancelTurn`       | all Gateway-owned sessions                              | Cancel active capture/provider/agent/TTS work for a turn.                                                                                                                                                                 |
| `talk.session.cancelOutput`     | `realtime/gateway-relay`                                | Stop assistant audio output without necessarily ending the user turn.                                                                                                                                                     |
| `talk.session.submitToolResult` | `realtime/gateway-relay`                                | Complete a provider tool call after any asynchronous completion exposed by its bridge; pass `options.willContinue` for interim output or, when supported, `options.suppressResponse` to avoid another assistant response. |
| `talk.session.steer`            | agent-backed Talk sessions                              | Send spoken `status`, `steer`, `cancel`, or `followup` control to the active embedded run resolved from the Talk session.                                                                                                 |
| `talk.session.close`            | all unified sessions                                    | Stop relay sessions or revoke managed-room state, then forget the unified session id.                                                                                                                                     |

Do not introduce provider or platform special cases in core to make this work.
Core owns Talk session semantics. Provider plugins own vendor session setup.
Voice-call and Google Meet own telephony/meeting adapters. Browser and native
apps own device capture/playback UX.

## Removal timeline

| When                                        | What happens                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Now**                                     | Warning-capable deprecated surfaces emit runtime warnings; repository guards reject deprecated SDK imports from core and bundled plugins. |
| **Each compat record's `removeAfter` date** | That specific surface is eligible for removal; `pnpm plugins:boundary-report --fail-on-eligible-compat` fails CI once the date passes.    |
| **Next major release**                      | Any surfaces still not migrated are removed; plugins still using them will fail.                                                          |

The public SDK subpaths below have registry-backed removal or demotion windows.
They do not currently emit a runtime warning when an external plugin imports
them. The repository deprecated-usage guard applies only to the fully unused
θ1 tier and the earlier compatibility tier; θ2 remains available to bundled
plugins during the window.

For the window introduced on 2026-07-15, θ1 has no known external or bundled
consumers and will be deleted after the window. θ2 has bundled consumers but no
known external consumers; only its public package export will be retired. Its
module will remain available to bundled plugins as a private-local-only
subpath.

| `removeAfter` | Tier                                   | SDK subpaths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-07-30`  | Earlier compatibility deprecations     | `agent-dir-compat`, `channel-envelope`, `channel-inbound-roots`, `channel-location`, `channel-message-runtime`, `channel-pairing-paths`, `channel-reply-options-runtime`, `config-schema`, `config-types`, `direct-dm`, `direct-dm-access`, `mattermost`, `media-generation-runtime-shared`, `memory-core`, `memory-core-engine-runtime`, `memory-core-host-events`, `memory-core-host-multimodal`, `memory-core-host-query`, `memory-host-files`, `memory-host-status`, `music-generation-core`, `outbound-runtime`, `outbound-send-deps`, `provider-auth-login`, `provider-zai-endpoint`, `reply-dedupe`, `runtime-logger`, `runtime-secret-resolution`, `self-hosted-provider-setup`, `setup-adapter-runtime`, `telegram-command-config`, `webhook-path`, `zalouser`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `2026-07-30`  | θ1: fully unused; remove subpath       | `command-gating`, `lmstudio`, `lmstudio-runtime`, `secret-provider-integration`, `skills-runtime`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `2026-07-30`  | θ2: bundled-only; retire public export | `access-groups`, `account-resolution-runtime`, `acp-binding-resolve-runtime`, `acp-binding-runtime`, `acp-runtime`, `acp-runtime-backend`, `agent-core`, `agent-harness-exec-review-runtime`, `agent-harness-task-runtime`, `agent-harness-tool-runtime`, `agent-media-payload`, `agent-sessions`, `approval-reaction-runtime`, `approval-reference-runtime`, `async-lock-runtime`, `browser-config`, `bundled-channel-config-schema`, `channel-activity-runtime`, `channel-config-writes`, `channel-mention-gating`, `channel-route`, `channel-secret-tts-runtime`, `channel-targets`, `chat-channel-ids`, `cli-backend`, `cli-runtime`, `codex-mcp-projection`, `command-status-runtime`, `command-surface`, `concurrency-runtime`, `context-visibility-runtime`, `conversation-binding-runtime`, `cron-store-runtime`, `dangerous-name-runtime`, `delivery-queue-runtime`, `direct-dm-guard-policy`, `directory-config-runtime`, `document-extractor`, `embedding-providers`, `exec-approvals-runtime`, `expect-runtime`, `fetch-runtime`, `file-access-runtime`, `file-lock`, `global-singleton`, `group-activation`, `heartbeat-runtime`, `host-runtime`, `html-entity-runtime`, `image-generation`, `image-generation-core`, `image-generation-runtime`, `inline-image-data-url-runtime`, `json-schema-runtime`, `json-unsafe-integers`, `keyed-async-queue`, `llm`, `markdown-table-runtime`, `media-generation-runtime`, `media-understanding`, `memory-core-host-embedding-registry`, `memory-core-host-engine-embeddings`, `memory-core-host-engine-qmd`, `memory-core-host-engine-storage`, `memory-core-host-runtime-cli`, `memory-core-host-runtime-core`, `memory-core-host-runtime-files`, `memory-core-host-secret`, `memory-core-host-status`, `memory-host-core`, `memory-host-events`, `memory-host-markdown`, `memory-host-search`, `message-tool-delivery-hints`, `migration`, `migration-runtime`, `music-generation`, `node-host`, `number-runtime`, `outbound-media`, `pair-loop-guard-runtime`, `plugin-config-runtime`, `plugin-state-runtime`, `poll-runtime`, `process-runtime`, `provider-auth-api-key`, `provider-auth-login-flow-runtime`, `provider-auth-result`, `provider-auth-runtime`, `provider-catalog-live-runtime`, `provider-catalog-shared`, `provider-entry`, `provider-env-vars`, `provider-http`, `provider-model-shared`, `provider-model-types`, `provider-oauth-runtime`, `provider-onboard`, `provider-selection-runtime`, `provider-setup`, `provider-stream`, `provider-stream-family`, `provider-stream-shared`, `provider-tools`, `provider-transport-runtime`, `provider-usage`, `provider-web-fetch`, `provider-web-fetch-contract`, `provider-web-search`, `provider-web-search-config-contract`, `provider-web-search-contract`, `qa-runner-runtime`, `realtime-bootstrap-context`, `realtime-transcription`, `realtime-voice`, `reply-reference`, `request-url`, `response-limit-runtime`, `retry-runtime`, `runtime-doctor`, `runtime-fetch`, `sandbox`, `secret-file-runtime`, `secure-random-runtime`, `session-binding-runtime`, `session-catalog`, `session-key-runtime`, `session-transcript-hit`, `session-transcript-runtime`, `session-visibility`, `simple-completion-runtime`, `speech`, `speech-core`, `sqlite-runtime`, `ssrf-dispatcher`, `string-normalization-runtime`, `system-event-runtime`, `talk-config-runtime`, `target-resolver-runtime`, `text-autolink-runtime`, `text-utility-runtime`, `thread-bindings-runtime`, `thread-bindings-session-runtime`, `time-runtime`, `tool-payload`, `tool-plugin`, `tool-results`, `transcripts`, `transport-ready-runtime`, `tts-runtime`, `types`, `video-generation`, `video-generation-core`, `video-generation-runtime`, `web-content-extractor`, `webhook-targets`, `windows-spawn` |
| `2026-08-15`  | Earlier compatibility deprecations     | `agent-config-primitives`, `channel-logging`, `channel-secret-runtime`, `channel-streaming`, `group-access`, `inbound-reply-dispatch`, `matrix`, `text-runtime`, `zod`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `2026-09-01`  | Earlier compatibility deprecations     | `channel-lifecycle`, `channel-message`, `channel-reply-pipeline`, `config-runtime`, `infra-runtime`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

All core plugins have already migrated. External plugins should migrate
before the next major release. Run `pnpm plugins:boundary-report` to see which
compat records are due soonest for the surfaces your plugin uses.

## Suppressing the warnings temporarily

```bash
OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING=1 openclaw gateway run
OPENCLAW_SUPPRESS_EXTENSION_API_WARNING=1 openclaw gateway run
```

This is a temporary escape hatch, not a permanent solution.

## Related

- [Getting Started](/plugins/building-plugins) - build your first plugin
- [SDK Overview](/plugins/sdk-overview) - full subpath import reference
- [Channel Plugins](/plugins/sdk-channel-plugins) - building channel plugins
- [Provider Plugins](/plugins/sdk-provider-plugins) - building provider plugins
- [Plugin Internals](/plugins/architecture) - architecture deep dive
- [Plugin Manifest](/plugins/manifest) - manifest schema reference
