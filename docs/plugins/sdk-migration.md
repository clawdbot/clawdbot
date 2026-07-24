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

Several wide-open import surfaces used to let plugins reach almost anything
from a single entry point:

- **`openclaw/plugin-sdk`** and **`openclaw/plugin-sdk/compat`** - re-exported
  dozens of helpers while the focused SDK was being built. Both roots are now
  removed; import a documented subpath instead.
- **`openclaw/plugin-sdk/infra-runtime`** - a broad barrel mixing system
  events, heartbeat state, delivery queues, fetch/proxy helpers, file helpers,
  approval types, and unrelated utilities.
- **`openclaw/plugin-sdk/config-runtime`** - a broad config barrel retained
  only for its later compatibility window; direct runtime load/write helpers
  have been removed.
- **`openclaw/extension-api`** - a removed bridge that gave plugins direct
  access to host-side helpers like the embedded agent runner.
- **`api.registerEmbeddedExtensionFactory(...)`** - a removed embedded-runner-only
  hook that observed embedded-runner events such as `tool_result`. Use agent
  tool-result middleware instead (see [Migrate embedded tool-result extensions
  to middleware](#how-to-migrate)).

The root SDK, compat barrel, extension bridge, and embedded extension factory
have been removed. `infra-runtime` and `config-runtime` remain only for their
separately recorded later windows; new plugins should use focused subpaths.

<Warning>
  Plugins importing the removed root, compat, or extension surfaces no longer
  load. Follow the mappings below before upgrading.
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

### Published channel setup compatibility

Slack, Discord, Signal, and Microsoft Teams packages published through
`2026.7.1` import channel-specific config schemas from
`openclaw/plugin-sdk/bundled-channel-config-schema`. The published Slack and
Discord packages also import `createLegacyCompatChannelDmPolicy` and
`promptLegacyChannelAllowFromForAccount` from
`openclaw/plugin-sdk/setup-runtime`.

Those exports remain available as deprecated runtime compatibility adapters.
New and republished plugins should own their config schemas and setup policy
locally, using generic primitives from `channel-config-schema` and
`setup-runtime`. The compatibility exports can be removed only after the
minimum supported published package versions no longer import them.

### Channel setup input field compatibility

`ChannelSetupInput` now keeps only the cross-channel setup envelope typed
permanently. Channel-specific fields remain typed in a deprecated compatibility
tier so existing external plugins still compile while plugin authors move those
fields into plugin-local setup input types.

OpenClaw does not ship major releases. A registry sweep on 2026-07-22 inspected
426 published out-of-tree channel plugins and removed 21 fields with no readers.
The 22 retained fields each have a known published reader. Each further field is
deleted as soon as no published plugin reads it; the retained set shrinks as
plugin authors migrate to plugin-local setup input types.

The same sweep removed 23 legacy undeclared-adapter promotion keys with no
published dependents. Six common keys and the setup-only `rooms` key remain.
That set also shrinks as published plugins declare `singleAccountKeysToMove`.

The shared type has no index signature. Plugin-owned keys can still be present
on runtime input objects; declare them in a plugin-local intersection or narrow
them through the owning plugin's setup schema.

| `code`                                  | `owner`   | `replacement`                                                                                    | Removal condition                                                     |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `plugin-sdk-channel-setup-input-fields` | `channel` | Intersect `ChannelSetupInput` with a plugin-local type that declares the owning channel's fields | Delete a field when the published-plugin registry sweep has no reader |

The legacy undeclared-adapter promotion tier follows the same reader-driven
policy. Declare `singleAccountKeysToMove`, including an empty array when the
plugin needs no extra promotion keys, so the shared fallback can be retired one
key at a time.

#### Verifying readers

1. Page through `https://clawhub.ai/api/v1/packages?family=code-plugin&limit=100` with each `nextCursor`, and keep packages whose `categories` include `channels`.
2. Add npm candidates from `npm search --json --searchlimit=1000 "openclaw channel plugin"`. Add source-only candidates from GitHub code searches for `openclaw/plugin-sdk/channel-setup`, `openclaw/plugin-sdk/setup`, and `openclaw/plugin-sdk/core`.
3. Resolve each candidate's latest published version. Run `npm pack <package>@<version> --json --pack-destination <temp-dir>`, unpack it, and inspect shipped `dist` JavaScript and declarations for direct or destructured field reads. Download the ClawHub artifact when a package has no npm release.
4. Record package, version, field or promotion key, and matching file. A field or key is deletable only when no published plugin artifact reads it. Keep the reader names in the code comments beside the retained field and key lists synchronized with the sweep.

This is a source/type compatibility record only. It has no runtime adapter or
compatibility-registry entry because runtime setup input objects and setup
behavior are unchanged.

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

    `loadConfig` and `writeConfigFile` have been removed from the plugin
    runtime. Bundled plugins and repo runtime code are guarded by
    `pnpm check:deprecated-api-usage` and
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
    | Plugin-entry config lookup | `api.pluginConfig` |
    | Config merging | Plugin-local logic at the config boundary |
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

The public package export map is the source of truth for importable SDK
subpaths. Use the topical SDK guides linked from [SDK overview](/plugins/sdk-overview)
and prefer the narrowest documented public subpath. The compiler inventory in
`scripts/lib/plugin-sdk-entrypoints.json` also contains private-local entries used
to build bundled plugins; their presence there does not make them public package exports.

This table is the common migration subset, not the full SDK surface. The
compiler entrypoint inventory lives in `scripts/lib/plugin-sdk-entrypoints.json`;
package exports are generated from the public subset.

Reserved bundled-plugin helper seams have been retired from the public SDK
export map except for explicitly documented compatibility facades such as the
deprecated `plugin-sdk/discord` shim retained for external plugins that still
import the published `@openclaw/discord` package directly. Owner-specific
helpers live inside the owning plugin package; shared host behavior moves
through generic SDK contracts such as `plugin-sdk/gateway-runtime`,
`plugin-sdk/security-runtime`, and the injected plugin API.

Use the narrowest import that matches the job. If you cannot find an export,
check the source at `src/plugin-sdk/` or ask maintainers which generic
contract should own it.

## Removed compatibility surfaces

The July 2026 sweep removed the root SDK and compat barrels, the extension API
bridge, the expired SDK subpath aliases, unused SDK subpaths, and the public
exports for bundled-only SDK modules. Bundled-only modules remain available to
their repository owners through private-local build mappings; they are not
importable from the published package.

### Process-global API-provider publication

`registerApiProvider(...)` and `unregisterApiProviders(...)` were removed from
`openclaw/plugin-sdk/llm`. They published API transports into process-global
state, which lifecycle-owned model runtimes then had to copy into each prepared
registry.

Provider plugins should register text-inference providers through
`api.registerProvider(...)`. Host-owned code and tests that construct an
`ApiRegistry` should register directly on that registry so provider ownership
and teardown stay scoped to the prepared runtime.

### Private testing barrel

`openclaw/plugin-sdk/testing` was repo-local and excluded from shipped package
artifacts, so it was removed before its 2026-07-28 `removeAfter` date. Repository
tests use focused subpaths such as `plugin-sdk/plugin-test-runtime`,
`plugin-sdk/channel-test-helpers`, `plugin-sdk/channel-target-testing`,
`plugin-sdk/test-env`, and `plugin-sdk/test-fixtures`.

## Migration reference

These mappings cover both removed July 2026 surfaces and later-window active
deprecations. A mapping is migration guidance, not evidence that the old
surface remains available; consult the compatibility registry and removal
timeline for current status.

<AccordionGroup>
  <Accordion title="command-auth help builders -> command-status">
    **Old (`openclaw/plugin-sdk/command-auth`)**: `buildCommandsMessage`,
    `buildCommandsMessagePaginated`, `buildHelpMessage`.

    **New (`openclaw/plugin-sdk/command-status`)**: same signatures, imported
    from the narrower subpath. The `command-auth` compatibility re-exports
    have been removed.

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
    `openclaw/plugin-sdk/channel-runtime` has been removed. Use
    `openclaw/plugin-sdk/channel-runtime-context` for registering runtime
    objects.

    The native message schema helpers in `openclaw/plugin-sdk/channel-actions`
    were removed alongside raw "actions" channel exports. Expose capabilities
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

    The aliases and legacy `ProviderCapabilities` static bag have been
    removed. Provider plugins
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

    Implement one hook instead of three. The legacy hooks have been removed.

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

    `providerAuthEnvVars` is no longer accepted.

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

    The legacy aliases were removed in July 2026.

  </Accordion>

  <Accordion title="Embedded extension factories -> agent tool-result middleware">
    Covered in [How to migrate](#how-to-migrate) above. Included here for
    completeness: the removed embedded-runner-only
    `api.registerEmbeddedExtensionFactory(...)` path is replaced by
    `api.registerAgentToolResultMiddleware(...)` with an explicit runtime list
    in `contracts.agentToolResultMiddleware`.
  </Accordion>

  <Accordion title="OpenClawSchemaType alias -> OpenClawConfig">
    The `OpenClawSchemaType` root-SDK alias was removed. Use the canonical
    `OpenClawConfig` name.

    ```typescript
    // Before
    import type { OpenClawSchemaType } from "openclaw/plugin-sdk";
    // After
    import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
the plugin. Browser permission plans receive the requested meeting URL so each
platform can grant only its exact supported origins. Session runtimes must also
normalize platform-specific live health after confirmed browser departure;
historical transcript fields may remain, but caption and audio readiness must
not stay active after leave.

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

The remaining public SDK subpaths below have registry-backed removal windows.
The July 30 rows were removed after their early maintainer-authorized sweep:
unused subpaths were deleted, earlier compatibility aliases were deleted, and
bundled-only modules were demoted to private-local build mappings.

| `removeAfter` | Tier                               | SDK subpaths                                                                                                                                                           |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-08-15`  | Earlier compatibility deprecations | `agent-config-primitives`, `channel-logging`, `channel-secret-runtime`, `channel-streaming`, `group-access`, `inbound-reply-dispatch`, `matrix`, `text-runtime`, `zod` |
| `2026-09-01`  | Earlier compatibility deprecations | `channel-lifecycle`, `channel-message`, `channel-reply-pipeline`, `config-runtime`, `infra-runtime`                                                                    |

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
