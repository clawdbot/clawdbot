---
summary: "api.runtime -- the injected runtime helpers available to plugins"
title: "Plugin runtime helpers"
sidebarTitle: "Runtime helpers"
read_when:
  - You need to call core helpers from a plugin (TTS, STT, image gen, web search, Gateway, subagent, nodes)
  - You want to understand what api.runtime exposes
  - You are accessing config, agent, or media helpers from plugin code
  - You are implementing model-picker persistence in a channel plugin
---

Reference for the live `api.runtime` object available during `"full"`, `"discovery"`, `"tool-discovery"`, and `"setup-runtime"` registration. During `"cli-metadata"` and `"setup-only"` registration, runtime capabilities are intentionally unavailable: accessing one throws an error naming the plugin and mode. Defer runtime access out of `register()` or, for root CLI commands, declare `cliCommands` in the plugin manifest. Use runtime helpers instead of importing host internals directly.

<CardGroup cols={2}>
  <Card title="Channel plugins" href="/plugins/sdk-channel-plugins">
    Step-by-step guide that uses these helpers in context for channel plugins.
  </Card>
  <Card title="Provider plugins" href="/plugins/sdk-provider-plugins">
    Step-by-step guide that uses these helpers in context for provider plugins.
  </Card>
</CardGroup>

```typescript
register(api) {
  const runtime = api.runtime;
}
```

`api.runtime.version` is the current OpenClaw product version, sourced from the shared version resolver so plugins see the same value the CLI reports.

## Config loading and writes

Prefer config that was already passed into the active call path, for example `api.config` during registration or a `cfg` argument on channel/provider callbacks. This keeps one process snapshot flowing through the work instead of reparsing config on hot paths.

Use `api.runtime.config.current()` only when a long-lived handler needs the current process snapshot and no config was passed to that function. The returned value is readonly; clone or use a mutation helper before editing.

Tool factories receive `ctx.runtimeConfig` plus `ctx.getRuntimeConfig()`. Use the getter inside a long-lived tool's `execute` callback when config can change after the tool definition was created.

Persist changes with `api.runtime.config.mutateConfigFile(...)` or `api.runtime.config.replaceConfigFile(...)`. Each write must choose an explicit `afterWrite` policy:

- `afterWrite: { mode: "auto" }` lets the gateway reload planner decide.
- `afterWrite: { mode: "restart", reason: "..." }` forces a clean restart when the writer knows hot reload is unsafe.
- `afterWrite: { mode: "none", reason: "..." }` suppresses automatic reload/restart only when the caller owns the follow-up.

The mutation helpers return `afterWrite` plus a typed `followUp` summary so callers can log or test whether they requested a restart. The gateway still owns when that restart actually happens.

Use `current()`, a passed-in `cfg`, `mutateConfigFile(...)`, or
`replaceConfigFile(...)` for runtime config access and writes.

For direct SDK imports, prefer the focused config subpaths over the broad `openclaw/plugin-sdk/config-runtime` compatibility barrel: `config-contracts` for types, `runtime-config-snapshot` for current process snapshots, and `config-mutation` for writes. Read entry-scoped values from `api.pluginConfig`; use a supplied tool context only for its runtime-wide config snapshot, and keep plugin-specific merging at that boundary. Bundled plugin tests should mock these focused subpaths directly instead of mocking the broad compatibility barrel.

Internal OpenClaw runtime code follows the same direction: load config once at the CLI, gateway, or process boundary, then pass that value through. Successful mutation writes refresh the process runtime snapshot and advance its internal revision; long-lived caches should key off the runtime-owned cache key instead of serializing config locally. Long-lived runtime modules have a zero-tolerance scanner for ambient `loadConfig()` calls; use a passed `cfg`, a request `context.getRuntimeConfig()`, or `getRuntimeConfig()` at an explicit process boundary.

Provider and channel execution paths must use the active runtime config snapshot, not a file snapshot returned for config readback or editing. File snapshots preserve source values such as SecretRef markers for UI and writes; provider callbacks need the resolved runtime view. When a helper may be called with either the active source snapshot or the active runtime snapshot, route through `selectApplicableRuntimeConfig()` before reading credentials.

Retained channel monitors can bind `createRuntimeConfigReader(cfg)` from
`openclaw/plugin-sdk/runtime-config-snapshot` once at startup. The reader follows
runtime updates when the supplied config belongs to the active runtime, and
preserves an explicitly scoped config otherwise, including when no runtime has
been published yet. Read once per turn and carry that snapshot through admission
and replies. Process-wide controls such as diagnostics should read at the point
of emission.

`createChannelInboundDebouncer` keeps its returned numeric `debounceMs` and default
queue timing as startup snapshots. For live timing, pass its existing
`resolveDebounceMs(entry)` callback and resolve with the bound config reader.
If pending-key or shutdown bookkeeping also depends on the delay, capture one
value on the entry and use it for both bookkeeping and the callback.

A channel's `reload.noopPrefixes` opts only that channel out of shared-policy
refresh. Declare a prefix only after every retained consumer reads it live or
does not consume it. Undeclared channels still refresh; one channel's declaration
cannot suppress a sibling's reload. A narrower `reload.configPrefixes` entry can
retain restart behavior under a broader no-op prefix.

## Reusable runtime utilities

Native command probes should use `runCommandWithTimeout` from
`openclaw/plugin-sdk/process-runtime` with `timeoutMs`, the caller's `signal`, and
`killProcessTree: true`. Await its result so timeout or cancellation cleanup finishes
before returning. For commands whose output is always UTF-8, such as JSON status
probes, use `runUtf8CommandWithTimeout` from the same subpath.

Use `splitCommandArgs(raw)` from the same subpath to group quoted process
arguments. Backslashes and `#` stay literal; there is no shell expansion.
Unfinished quotes return `null` unless the caller passes
`{ allowUnclosedQuotes: true }` to preserve an existing permissive input contract.
Empty quoted arguments are omitted.

Existing process owners can use `signalProcessTree`. Its `onComplete` callback runs after Unix
signaling or the bounded Windows `taskkill` attempt, not proof that every process
exited. Keep the probe pending through cleanup, use `detached: true` only for a
process group you created, and start Windows tree termination while its root is
still alive.

Channel plugins that deliver agent replies directly can call
`renderPresentationForDelivery(handler, payload)` from
`openclaw/plugin-sdk/interactive-runtime` at delivery, after modifying hooks. Supply
the channel's `presentationCapabilities` and `renderPresentation` callback; the
callback receives a payload with a normalized, adapted `presentation` and the
normalized original presentation as its second argument. Use the original for
whole-card text fallbacks that must retain labels clipped by native limits. This
shares core outbound rendering's fallback-text policy and removes the portable
presentation fields after rendering. The callback may be synchronous or async.

Use `attachErrorDiagnostic(error, text)` from `openclaw/plugin-sdk/error-runtime`
to attach supplemental operator diagnostics to a thrown error without changing
its identity, message, or failure classification. Mask opaque credentials first;
the helper also redacts recognized secrets and retains at most 2,048 characters.
`formatErrorMessageForDisplay(error)` includes the nearest attached diagnostic
through nested causes and aggregates. Use it only at terminal display boundaries,
never for retry or authentication decisions. Agent lifecycle errors and terminal
CLI logs render these diagnostics automatically; successful runs remain quiet.
Native RPC error messages retain their original text; `agent.wait` renders the
supplemental diagnostic at its terminal result boundary.

Channel plugins must admit authenticated agent turns through their injected
`api.runtime.agent.runCommandFromIngress(options, runtime)` capability. The host
accepts owner authority only from the exact active, trusted plugin registered for
`options.messageChannel`; guest turns retain their non-owner identity. The public
`agentCommandFromIngress` SDK helper never accepts a caller-supplied owner claim.

Model-picker integrations use two focused runtime subpaths. Import the typed
`ModelPickerAction` and `ModelPickerCapabilityProfile` contracts from
`openclaw/plugin-sdk/interactive-runtime`. Import
`applySessionModelSelection(...)` and its result types from
`openclaw/plugin-sdk/model-session-runtime`; this is the live-session mutation
seam, including its authoritative conflict check and post-commit effects. The
lower-level `applyModelOverrideToSessionEntry(...)` helper is not a picker
persistence API.

Use `applyModelOverrideWithAuthProfileCompatibility(...)` only as the direct
persistence fallback when a channel callback cannot enter the full live-session
transaction and already owns an atomic canonical session-entry patch. Pass the
active config, resolved agent directory, entry, effective provider before the
change, and validated selection. The helper mutates that entry only: it keeps a
pinned auth profile when its recorded credential provider or configured alias is
compatible, clears an incompatible pin, and enforces the model-selection lock.
The caller still owns model allowlist validation, atomic persistence,
`markLiveSwitchPending`, and any post-commit effects. Prefer
`applySessionModelSelection(...)` whenever the full transaction is available.

Model-picker actions carry only bounded snapshot and catalog tokens. Channel
actor identity, source-message binding, and serialized callback data stay in
the channel's private authenticated envelope. Channel codecs opt into resolving
these actions with `{ modelPicker: true }`; channels without a picker
capability continue to fail closed instead of treating the action as an opaque
callback.

Use inbound `botLoopProtection` facts for bot-authored inbound messages. Core applies the shared in-memory sliding-window guard before session record and dispatch, without tying the policy to one channel. The guard tracks `(scopeId, conversationId, participant pair)` keys, counts both directions of a pair together, applies a cooldown once the window budget is exceeded, and prunes inactive entries opportunistically. Retryable transports should also supply a stable `eventId`; replaying an accepted event while it remains in the active window does not consume another budget slot. Suppressed events add no retained event-identity state.

Channel plugins that expose this behavior to operators should prefer the shared `channels.defaults.botLoopProtection` shape for baseline budgets, then layer channel/provider-specific overrides on top. The shared config uses seconds because it is user-facing:

```typescript
type ChannelBotLoopProtectionConfig = {
  enabled?: boolean;
  maxEventsPerWindow?: number;
  windowSeconds?: number;
  cooldownSeconds?: number;
};
```

Pass normalized bot-pair facts with the resolved turn. Core resolves defaults, unit conversion, and `enabled` semantics:

```typescript
return {
  channel: "example",
  routeSessionKey,
  storePath,
  ctxPayload,
  recordInboundSession,
  runDispatch,
  botLoopProtection: {
    scopeId: "account-1",
    conversationId: "channel-1",
    senderId: "bot-a",
    receiverId: "bot-b",
    eventId: providerEvent.id,
    config: channelConfig.botLoopProtection,
    defaultsConfig: runtimeConfig.channels?.defaults?.botLoopProtection,
    defaultEnabled: allowBotsMode !== "off",
  },
};
```

Use `openclaw/plugin-sdk/pair-loop-guard-runtime` directly only for custom
two-party event loops that do not go through the shared inbound reply runner.

## Plugin command runtime helpers

Plugin command handlers receive request-bound capabilities through
`ctx.runtimeContext`. When the command is bound to a current session,
`ctx.runtimeContext.compactCurrent()` runs the same manual compaction
pipeline as `/compact`, including native agent-harness completion and session
token accounting:

```typescript
const compactCurrent = ctx.runtimeContext?.compactCurrent;
if (!compactCurrent) {
  return { text: "This command needs a bound session." };
}

const result = await compactCurrent();
return {
  text: result.compacted
    ? `Compacted to ${result.tokensAfter ?? "an unknown number of"} tokens.`
    : `Compaction did not complete: ${result.reason ?? "unknown reason"}.`,
};
```

This general capability is available to every plugin command, not only Codex.
The host gates it to the current invocation and exact bound session generation.
The capability is absent when no current session is bound; a retained callback
fails closed after the handler settles. Do not retain it or reconstruct
compaction with session-store patches and harness calls. The result contains
`compacted`, optional `reason`, and optional `tokensBefore` and `tokensAfter`
snapshots; OpenClaw owns all persistence and lifecycle coordination.

## Runtime namespaces

<AccordionGroup>
  <Accordion title="api.runtime.agent">
    Agent identity, directories, and session management.

    ```typescript
    // Resolve the agent's working directory (agentId is required)
    const agentDir = api.runtime.agent.resolveAgentDir(cfg, agentId);

    // Resolve agent workspace
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);

    // Get agent identity
    const identity = api.runtime.agent.resolveAgentIdentity(cfg);

    // Get default thinking level
    const thinking = api.runtime.agent.resolveThinkingDefault({
      cfg,
      provider,
      model,
    });

    // Validate a user-provided thinking level against the active provider profile
    const policy = api.runtime.agent.resolveThinkingPolicy({ provider, model });
    const level = api.runtime.agent.normalizeThinkingLevel("extra high");
    if (level && policy.levels.some((entry) => entry.id === level)) {
      // pass level to an embedded run
    }

    // Resolve a synchronous create target for a session catalog
    const target = api.runtime.agent.resolveSessionCatalogCreateTarget({
      config: api.runtime.config.current(),
      requestedAgentId: agentId,
      provider: "example",
      modelIds: ["example-model"],
      agentRuntime: "example-cli",
    });

    // Get agent timeout
    const timeoutMs = api.runtime.agent.resolveAgentTimeoutMs(cfg);

    // Ensure workspace exists
    await api.runtime.agent.ensureAgentWorkspace(cfg);

    // Run an embedded agent turn
    const result = await api.runtime.agent.runEmbeddedAgent({
      sessionId: "my-plugin:task-1",
      runId: crypto.randomUUID(),
      workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId),
      prompt: "Summarize the latest changes",
      timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(cfg),
    });
    ```

    `runEmbeddedAgent(...)` is the neutral helper for starting a normal OpenClaw agent turn from plugin code. It uses the same provider/model resolution and agent-harness selection as channel-triggered replies.

    `resolveCliBackendDispatchEligibility({ provider, model, agentId, authProfileId, config, agentDir, workspaceDir })` shares the embedded runner's CLI-backend dispatch decision (route, the backend's declared `subscriptionAuthDispatch` capability, stored credential mode — honoring an explicitly pinned `authProfileId`) with callers that opt embedded runs into `cliBackendDispatch: "subscription-auth"`. It returns `{ provider }` when the run would execute through the CLI backend and `undefined` when it stays on the direct passthrough, so callers can budget timeouts for the run that will actually execute.

    `resolveThinkingPolicy(...)` returns the provider/model's supported thinking levels and optional default. Provider plugins own the model-specific profile through their thinking hooks, so tool plugins should call this runtime helper instead of importing or duplicating provider lists.

    `normalizeThinkingLevel(...)` converts user text such as `on`, `x-high`, or `extra high` to the canonical stored level before checking it against the resolved policy.

    `resolveSessionCatalogCreateTarget(...)` is the supported synchronous policy seam for trusted native plugins that implement `SessionCatalogProvider.resolveCreateSession`. It selects the first candidate model routed to the requested runtime and allowed for the requested or default agent. It returns `undefined` when no candidate satisfies both policies. Use this helper instead of importing or duplicating core model-selection policy in a plugin.

    **Session store helpers** are under `api.runtime.agent.session`:

    ```typescript
    const entry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey });
    for (const { sessionKey, entry } of api.runtime.agent.session.listSessionEntries({ agentId })) {
      // Iterate session rows without depending on the legacy sessions.json shape.
    }
    await api.runtime.agent.session.patchSessionEntry({
      agentId,
      sessionKey,
      update: (entry) => ({ thinkingLevel: "high" }),
    });

    const created = await api.runtime.agent.session.createSessionEntry({
      cfg,
      key: "agent:main:my-plugin:task-1",
      initialEntry: {
        agentHarnessId: "my-harness",
        modelSelectionLocked: true,
        pluginExtensions: { "my-plugin": { phase: "initializing" } },
      },
      afterCreate: async () => ({
        pluginExtensions: { "my-plugin": { phase: "ready" } },
      }),
    });

    const storePath = api.runtime.agent.session.resolveStorePath(cfg.session?.store, { agentId });
    await api.runtime.agent.session.runWithWorkAdmission(
      { storePath, sessionKey },
      async (signal) => {
        // Create or update the session, then pass signal to the admitted agent run.
      },
    );
    ```

    Prefer `getSessionEntry(...)`, `listSessionEntries(...)`, `patchSessionEntry(...)`, or `upsertSessionEntry(...)` for session workflows. These helpers address sessions by agent/session identity so plugins do not depend on the legacy `sessions.json` storage shape. Use `preserveActivity: true` for metadata-only patches that should not refresh session activity, and `replaceEntry: true` only when the callback returns a complete entry and deleted fields must stay deleted. Doctor and migration paths can combine `fallbackEntry`, `skipMaintenance`, and `requireWriteSuccess` for one atomic canonical-store repair.

    When patch authority can change while `update` awaits, pass `assertCommitAllowed: () => void`. The storage owner calls this synchronous guard inside the commit transaction; throw to reject the entire patch. Keep network requests and other asynchronous work in `update`.

    For native conversation controls, `getConversationSession(...)` from `openclaw/plugin-sdk/session-store-runtime` reads the current recorded binding for one transport address. Supply `agentId`, `channel`, `accountId`, `kind` (`direct`, `group`, or `channel`), and the ingress `peerId`; optional `threadId` selects an exact thread. Optional `storePath` and `env` select the same agent store as other session helpers. It returns `{ sessionKey, sessionId }`, or `undefined` when no current binding exists, and follows session resets without creating a session. It does not list active runs or infer a parent address. Targeted Stop dispatch can provide `replyOptions.isCommandTargetCurrent`, a synchronous in-process owner check carried to the cancellation boundary. A false result rejects a stale target; cancelled owners cannot mark a replacement session aborted.

    `createSessionEntry(...)` creates a new canonical session row and transcript. Its trusted `initialEntry` surface is deliberately narrow. A plugin may select an owned `agentHarnessId`; seed an owned CLI backend with `cliBackendId`, `model`, and `cliSessionBinding`; or seed a persistent ACP session with `acpBackendId` and `acpSessionBinding: { acpAgentId, agentSessionId }`. The ACP variant persists the supplied native agent session id through the canonical SQLite ACP metadata owner so the first turn resumes that external session. The injected runtime restricts plugin-owned CLI and ACP sessions to the calling plugin's `plugin:<id>:` namespace; harness ids must be owned through `registerAgentHarness(...)`. These are ownership invariants, not a sandbox between in-process plugins. Creation rejects an existing row; `label`, `displayName`, and `spawnedCwd` are separate creation fields rather than trusted-entry patches.

    Optional `displayName` seeds the existing presentation field atomically with the new row. The host trims it and truncates it to at most 500 UTF-16 code units without splitting a surrogate pair; empty or whitespace-only input leaves it unset. Duplicate display titles are allowed and do not claim an addressable label. Explicit `label` values retain normal uniqueness validation and display priority. Reuse and interrupted-initializer recovery preserve all stored labels and title snapshots, including absent titles and older automatically assigned labels. This create-only input does not permit title changes through `initialEntry` or the `afterCreate` final patch, and is not a public `sessions.create` Gateway parameter.

    Before advertising an ACP-backed action, use `resolveAcpSessionAvailability(...)` from `openclaw/plugin-sdk/acp-runtime`. It applies the canonical enablement, dispatch, allowed-agent, registered-backend, and backend-health checks; recheck it immediately before creating the session.

    ACP manager inputs accept an optional `agentId` identifying the OpenClaw session owner; `agent` selects the external harness. Carry the resolved owner from `resolveSession(...)` through subsequent calls, including controls and cleanup. `expectedOwnerKey` retains its parent-session meaning.

    Backends can advertise `ownerAwareSessions: 1` on `AcpRuntime`, including their lazy facade. This promises owner isolation for both `ensureSession(...)` and `prepareFreshSession(...)`. Their optional `agentId` and the handle's optional `agentId` preserve existing backend source compatibility. Qualified keys continue to work with older backends; bare sessions requiring isolation reject backends without the capability before effects. The logical `sessionKey` remains the SDK/tool identity. An optional `persistedHandle` is a projection for detecting old backend locators, not execution authority. Migration-required errors must propagate through reset and recovery without clearing metadata.

    ACP backends can return `AcpRuntimeConfigOptionResult` from `setConfigOption(...)`: a complete `configOptions` array of `{ id, category?, currentValue, options? }`, where `currentValue` is a string or boolean. Select `options` contain `{ value }` entries or groups of `{ options: [{ value }] }`. OpenClaw reconciles an already-selected thinking override from the accepted `thought_level` category or a recognized thinking key. Automatic model replay preserves a pending thinking value only when it is still current or selectable; explicit controls always use the accepted value. An empty array removes that override; omitted or null `category` is allowed, and backend defaults are not pinned. Existing third-party backends returning `void` retain requested-value persistence. Return the snapshot after backend persistence succeeds; reject failed writes.

    Creation holds the session lifecycle mutation fence through `afterCreate`, so new work waits for plugin-owned initialization to finish and pre-existing admitted work makes creation fail. The callback receives a clone of the created state. If it returns a patch, that patch may contain only `pluginExtensions`, and its value is the complete final `pluginExtensions` field. A callback or final-persistence failure rolls back the unchanged new row and transcript; guarded rollback preserves a row changed or claimed concurrently. `recoverMatchingInitialEntry: true` is only for retrying interrupted initialization when the persisted trusted fields match exactly, and recovery requires `afterCreate` to return a final patch.

    The callback's optional `initialization` handle belongs to this exact pending child, source incarnation, registry and creation lifetime. Use `assertCurrent()` across awaited preparation and writes; retained handles reject after readiness or closure. Only the host's registered rollback path can use `assertRollbackCurrent()`. Older hosts may omit the handle, so features requiring creation authority must refuse that path rather than fabricate a run.

    `initialization.prepareNativeToolPolicy(model)` checks the host-fixed child's native execution environment and harness policy, then returns its persistent web-search policy. The bounded native model selection is data, not authority to change the child or registry. This handle does not construct tools, invoke prompt hooks, provision requester resources or expose executors, approvals or credentials. Actual admitted runs own their available tools and live hooks; inherited native declarations remain metadata.

    Use `runWithWorkAdmission(...)` when a plugin starts work on a persisted session. The callback rejects archived or concurrently replaced sessions, keeps archive/reset/delete mutations coordinated through completion, and receives an `AbortSignal` that must be forwarded to the agent run. A harness may explicitly name trusted execution delegates through its experimental `delegatedExecutionPluginIds` registration field. Delegates can admit and run only an exact existing model-locked session; all session mutations remain restricted to the harness owner. See [Agent harness plugins](/plugins/sdk-agent-harness#delegated-execution).

    Maintenance and repair plugins may use `deleteSessionEntry(...)` for one scoped session entry, `cleanupSessionLifecycleArtifacts(...)` for lifecycle-owned scratch sessions, and `resolveSessionStoreBackupPaths(...)` before mutating a store. Pass `expectedSessionId` and `expectedUpdatedAt` when deletion must not race a concurrent session update; use `expectedSessionId: null` when the earlier snapshot had no session id. These helpers are narrow repair/lifecycle surfaces, not a general store deletion API.

    `resolveStorePath(...)` and `updateSessionStoreEntry(...)` round out the session helpers: `resolveStorePath` resolves the session store path for a given scope, and `updateSessionStoreEntry({ storePath, sessionKey, update })` patches one entry directly by store path when the caller already knows it.

    `loadTranscriptEventsSync(...)` is available for synchronous doctor and repair paths that cannot use the async transcript runtime. It returns raw `SessionStoreTranscriptEvent` records and does not consult runtime `session.store`; pass `storePath` for a non-default store. Normal plugin runtime code should prefer `openclaw/plugin-sdk/session-transcript-runtime`.

    `formatSqliteSessionFileMarker(...)`, `parseSqliteSessionFileMarker(...)`, and `sqliteSessionFileMarkerMatchesSession(...)` are transitional helpers for code that still receives a legacy field named `sessionFile`. A parsed SQLite marker identifies a live SQLite transcript target; it is not a filesystem path. New APIs should carry typed session identity instead of marker strings.

    For transcript reads and writes, import `openclaw/plugin-sdk/session-transcript-runtime` and use `resolveSessionTranscriptIdentity(...)`, `resolveSessionTranscriptTarget(...)`, `readSessionTranscriptEvents(...)`, `readSessionTranscriptRawDelta(...)`, `readSessionTranscriptVisibleMessageDelta(...)`, `readVisibleSessionTranscriptMessageEntries(...)`, `appendSessionTranscriptMessageByIdentity(...)`, `publishSessionTranscriptUpdateByIdentity(...)`, or `withSessionTranscriptWriteLock(...)` with `{ agentId, sessionKey, sessionId }`. These APIs let plugins identify a transcript, read raw events or visible branch-safe message entries, append messages, publish updates, and run related operations under the same transcript write lock without depending on active transcript file paths. `readVisibleSessionTranscriptMessageEntries(...)` returns ordered read metadata; its `seq` field is not a resumable cursor.

    For the identity-based operations listed above, an omitted `storePath` selects `session.store` from the supplied `config` when the operation accepts one, otherwise from the current runtime config snapshot. An explicit concrete `storePath` takes precedence; incognito session keys always select isolated in-memory storage. The write lock pins its selected store for callback reads, appends, and queued publication, even if runtime config changes while the callback awaits. Public identities and targets remain pathless. `readLatestAssistantTextByIdentity(...)` and `appendAssistantMirrorMessageByIdentity(...)` use the same store-selection rules.

    `appendSessionTranscriptMessageByIdentity(...)` is a low-level append of an already canonical message. Plugins must not synthesize media-bearing user rows with top-level `MediaPath`, `MediaPaths`, `MediaUrl`, `MediaUrls`, `MediaType`, or `MediaTypes`. Channel ingress should pass ordered facts through `MsgContext.media` and let the host own user-turn persistence. A host-prepared persisted user message carries canonical ordered facts under `message.__openclaw.media`; the generic append API does not infer or repair legacy parallel arrays.

    A harness that supports `sessions_yield` uses `appendSessionYieldContext(...)` after successful yield settlement to retain private resume context in the canonical session transcript. Pass the session target, `message`, and an `assertCurrent` callback that checks the current run and settlement authority. The writer checks that callback again before appending the hidden context entry. Failed or revoked settlement must not append context; public tool results and display projections must omit the private message.

    A harness host may provide `hostCapabilities.prepareContextMedia({ message, maxChars })` to reconstruct retained document text and images from canonical user media. The host captures the current run's config, workspace, channel, account, and authority; preparation rechecks that authority across asynchronous work. `maxChars` must be finite and limits extraction for each file. Fit all returned text, attachment notes, and images into the native context budget, and deliver image bytes through the native input path. Preparation reuses ordinary local-root, URL, MIME, byte, page, and image limits without rewriting transcript rows or echoing channel media. An older host without this optional capability may still project ordinary text history, but attachment restoration must fail explicitly rather than silently omit the saved input.

    For an exact existing session, use `appendSessionTranscriptMessageByIdentityStrict(...)` for one message or `appendSessionTranscriptMessagesByIdentity(...)` for an atomic ordered batch. Both accept optional `storePath`: when omitted, the shared turn owner resolves it from the supplied `config` (or current runtime snapshot), session agent, and `env`; an explicit concrete path overrides `session.store`, while incognito keys retain their in-memory routing. Strict single append returns `kind: "result"`, `kind: "suppressed"` when message preparation declines the append, or `{ kind: "rejected", reason: "session-rebound" }` when the expected session no longer matches. A batch rejects if its session changed and inserts or idempotently replays the whole group, never a partial group.

    A harness host may provide `hostCapabilities.annotateCurrentUserTurn(...)` for its already-admitted current prompt. The operation accepts only `mirrorIdentity`, `upstreamUserText`, `mirrorOrigin`, and `mirrorSourceFingerprint`; the host fixes diagnostic run correlation. Call it only after native prompt acceptance and outside transcript write locks. It cannot select an anchor, replace content, or annotate history. It revalidates the live host, exact recorder, active admission, session/writer ownership, unchanged message and source fingerprint at commit, then refreshes the recorder's generation and publishes the same event ID. Identical provenance does not rewrite or publish again. Missing capability, conflicts and stale owners must remain refusals; do not substitute a generic append or infer provenance. This optional capability adds no required host-version field and does not change transcript cursor invalidation.

    `readSessionTranscriptRawDelta(...)` returns a bounded `page`, `reset`, or `missing` result. Pass the opaque `page.cursor` into the next call. Pure appends preserve the cursor, while transcript replacement returns `reset` with a new bootstrap cursor. Pages default to 1,000 events and 1,000,000 serialized bytes; callers may request up to 10,000 events and 64 MiB. When the next event alone exceeds `maxBytes`, the page is empty and reports `requiredBytes`; retry with at least that byte limit when it is no greater than 64 MiB. Larger individual events require the complete-read API. A cursor identifies position only and never grants access to another session.

    `readSessionTranscriptVisibleMessageDelta(...)` provides the same bounded bootstrap-and-resume shape over the host-owned active message projection. It returns messages from oldest to newest, so context engines can drain initial history and persist the opaque cursor as their watermark. Store and return the cursor unchanged; it is a continuation hint, not an authorization credential. Linear appends resume after the last returned message. Transcript replacement, a cursor whose anchor left or moved within the active branch, malformed cursors, and cross-session cursors return `reset` with a fresh bootstrap cursor. The count and byte defaults and caps match the raw delta API. While the active projection is rebuilding after a branch change, the result is `unavailable` with reason `projection_rebuilding`; retry later rather than falling back to an active transcript file.

    `openclaw/plugin-sdk/session-store-runtime` still exports deprecated `loadSessionStore(...)`, `updateSessionStore(...)`, `resolveSessionFilePath(...)`, and `resolveSessionStoreEntry(...)` for official plugins released with v2026.7.1-beta.5. These compatibility exports are separate from `api.runtime.agent.session`. The existing [beta.5 compatibility window](/plugins/compatibility#current-compatibility-areas) runs through 2026-10-12; removal also requires the minimum supported plugin version to exclude that release. The whole-store helpers use SQLite-backed projections, and the legacy transcript-path bridge supports older file-based doctor inspection; SQLite remains canonical.

    For new plugin code, use the scoped entry helpers for session metadata and the transcript identity helpers for active transcript operations. Archive/support workflows that need file artifacts should use their dedicated archive surfaces instead of active session runtime APIs.

  </Accordion>
  <Accordion title="api.runtime.agent.defaults">
    Default model and provider constants:

    ```typescript
    const model = api.runtime.agent.defaults.model; // e.g. "gpt-5.6-sol"
    const provider = api.runtime.agent.defaults.provider; // e.g. "openai"
    ```

  </Accordion>

  <Accordion title="api.runtime.llm">
    Run a host-owned text completion without importing provider internals or
    duplicating OpenClaw model/auth/base URL preparation.

    ```typescript
    const result = await api.runtime.llm.complete({
      messages: [{ role: "user", content: "Summarize this transcript." }],
      purpose: "my-plugin.summary",
      maxTokens: 512,
      temperature: 0.2,
      reasoning: "high",
    });
    ```

    `maxTokens` and `temperature` are advisory sampling hints. The selected
    provider, CLI, or harness applies them when its transport exposes an
    equivalent control and otherwise may ignore them. They do not weaken the
    execution mode's isolation guarantees.

    To require the configured agent runtime and a literal zero-tool model
    surface, select isolated execution explicitly:

    ```typescript
    const result = await api.runtime.llm.complete({
      messages: [{ role: "user", content: "Return one JSON value." }],
      systemPrompt: "You are a JSON-only function.",
      model: "openai/gpt-5.6-sol",
      execution: {
        mode: "isolated-agent-runtime",
        authProfileId: "openai:work",
        timeoutMs: 30_000,
      },
    });
    ```

    This mode accepts exactly one user message. Core derives the configured CLI
    or harness owner, starts a fresh context, exposes no model-callable tools,
    and never falls back to direct provider transport. Unsupported runtimes fail
    before inference. `result.execution.owner` reports the selected owner;
    token usage remains absent when a CLI cannot report it.

    Completion failures expose a stable `code` on the thrown error. Isolated
    callers can distinguish authorization, invalid isolated input, unsupported
    or unavailable runtimes, aborts, timeouts, rejected output, and other
    completion failures without matching message text.

    Provider orchestration can also acquire the configured local-service
    lifecycle before issuing an HTTP request:

    ```typescript
    const lease = await api.runtime.llm.acquireLocalService(
      {
        providerId,
        baseUrl,
        headers,
      },
      signal,
    );
    try {
      // Send and fully consume the provider request.
    } finally {
      await lease?.release();
    }
    ```

    `acquireLocalService(...)` is a stable, generic provider-service SDK
    contract. The host resolves process configuration from
    `models.providers.<providerId>.localService`; callers cannot supply a
    command, arguments, environment, or lifecycle policy. Process spawning,
    readiness, diagnostics, and idle-stop policy remain internal to the host.

    Pass the exact configured provider id and resolved request base URL. Do not
    replace aliases with an adapter id: separate aliases can point at separate
    local GPU hosts. The host rejects endpoints that do not match the configured
    provider base URL, apart from the `/v1` normalization used by Ollama and LM
    Studio adapters. The host owns startup serialization, readiness probes,
    request leases, abort handling, and idle shutdown.

    The helper uses the same simple-completion preparation path as OpenClaw's
    built-in runtime and the host-owned runtime config snapshot. Context engines
    receive a session-bound `llm.complete` capability, so model calls use the
    active session's agent and do not silently fall back to the default agent. The
    result includes provider/model/agent attribution plus normalized token,
    cache, and estimated cost usage when available.

    Set `reasoning` to request a reasoning effort for the selected model. The
    host normalizes the canonical thinking levels (`off`, `minimal`, `low`,
    `medium`, `high`, `xhigh`, `adaptive`, `max`, and `ultra`) for the selected
    provider and model before dispatching the completion. `adaptive` becomes
    `medium`; `max` and `ultra` become `max` when supported, otherwise `xhigh`.

    <Warning>
    Model overrides require operator opt-in via `plugins.entries.<id>.llm.allowModelOverride: true` in config. `plugins.entries.<id>.llm.allowedModels` restricts those overrides; `plugins.entries.<id>.llm.allowedCompletionModels` separately restricts every completion, including host-resolved defaults. For direct completions, a `model@profile` override remains part of the authorized model override. Isolated `model@profile` overrides and `execution.authProfileId` require `plugins.entries.<id>.llm.allowAuthProfileOverride: true`. Cross-agent completions require `plugins.entries.<id>.llm.allowAgentIdOverride: true`.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.gateway">
    Call another Gateway method in process while preserving the current plugin's trusted runtime
    identity. This is intended for bundled or trusted official plugins that compose plugin-owned
    Gateway capabilities without opening a loopback WebSocket connection.

    ```typescript
    if (await api.runtime.gateway.isAvailable()) {
      const result = await api.runtime.gateway.request<{ callId: string }>(
        "voicecall.start",
        { to: "+15550001234", mode: "conversation" },
        { timeoutMs: 60_000 },
      );
    }
    ```

    Requests use `operator.write` scope and do not grant admin scope. Calls from arbitrary external
    plugins are rejected. Failed methods throw a `GatewayClientRequestError`, preserving structured
    `details`, retry metadata, and the Gateway error code for recovery flows. Use `isAvailable()`
    before choosing this path from tools that can also run in standalone agent processes.

  </Accordion>
  <Accordion title="api.runtime.hooks">
    Dispatch isolated agent turns for untrusted external-content triggers, such
    as an email watcher. Unlike `api.runtime.subagent.run(...)`, hook dispatch
    wraps external content, serializes runs for the same session, and reports
    completion through the Gateway. Plugin turns share the cron execution
    budget without requiring the HTTP hooks endpoint. When HTTP hooks are
    enabled, one slot in that shared budget remains reserved for HTTP work.

    ```typescript
    const result = await api.runtime.hooks.dispatchHookAgentTurn({
      name: "IMAP inbox",
      agentId: "mail",
      sessionKey: "hook:imap:account:123:456",
      message: "Summarize the new email and identify any requested actions.",
      externalContentSource: "email",
      deliver: true,
      thinking: "low", // optional
      timeoutSeconds: 60, // optional
      idempotencyKey: "account:123:456", // optional
    });

    if (!result.ok) {
      api.logger.warn(`Hook agent turn was rejected: ${result.reason}`);
    }
    ```

    `agentId` is required, and `sessionKey` must begin with `hook:` and contain
    no whitespace or control characters. `externalContentSource` currently
    accepts only `"email"`; external-content wrapping cannot be disabled. Set
    `deliver` to `false` to record completion without announcing it. Successful
    admission returns `{ ok: true, runId }`; rejected admission returns
    `{ ok: false, reason }`.

    This capability is available only to bundled plugins and trusted official
    plugin installations. It does not require enabling or configuring the HTTP
    hooks endpoint.

  </Accordion>
  <Accordion title="api.runtime.subagent">
    Launch and manage background subagent runs.

    For a tool-free completion that needs no retained session or reply delivery,
    use `complete(...)`:

    ```typescript
    const { text } = await api.runtime.subagent.complete({
      agentId: "research", // required configured agent that owns this work
      message: "Summarize these notes.",
      extraSystemPrompt: "Return a concise summary.", // optional
      timeoutMs: 30_000, // optional; defaults to 30 seconds
      // model: "openai/gpt-5.6-luna", // optional authorized override
      // signal: abortController.signal, // optional cancellation
    });
    ```

    `agentId` and `message` are required. `extraSystemPrompt`, `model`,
    `timeoutMs`, and `signal` are optional. The selected agent supplies its
    configured default model and credential owner when `model` is omitted.
    The result is `{ text: string }`; no session creation, message polling,
    deletion, or completion delivery is needed. The configured runtime must
    support fresh, tool-free isolated inference; unsupported runtimes fail
    before inference.

    Completions use the [shared background queue](/concepts/queue#background-work),
    with up to three runs per plugin within the three-run total budget.
    Cancellation removes queued work immediately. Running work keeps its slot
    until underlying runtime cleanup finishes, then rejects; late output is not
    returned after cancellation, timeout, or runtime retirement. Calls require
    a live Gateway binding and plugin identity. Request-scoped calls retain the
    caller's operator scopes and agent access; completions started inside an
    operator tool invocation are cancelled when that invocation ends.
    Model overrides retain the
    existing subagent authorization and `allowedModels` policy below.

    Use `run(...)` when you need a session or an agent tool surface:

    ```typescript
    // Start a subagent run
    const { runId, sessionKey } = await api.runtime.subagent.run({
      sessionKey: "agent:main:subagent:search-helper",
      message: "Expand this query into focused follow-up searches.",
      toolsAlsoAllow: ["my_plugin_progress"],
      promptMode: "minimal", // optional bounded subagent prompt
      provider: "openai", // optional override
      model: "gpt-5.6-sol", // optional override
      deliver: false,
      completionDelivery: "current-requester", // optional, before_dispatch hooks only
    });

    // Wait for completion
    const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });

    // Read session messages
    const { messages } = await api.runtime.subagent.getSessionMessages({
      sessionKey: "agent:main:subagent:search-helper",
      limit: 10,
    });

    // Delete a session
    await api.runtime.subagent.deleteSession({
      sessionKey: "agent:main:subagent:search-helper",
    });
    ```

    Gateway-backed runs return the canonical accepted `sessionKey` alongside `runId`. The field is optional in the TypeScript result only so explicit custom runtimes remain compatible.

    `waitForRun(...)` returns the canonical Gateway wait result. `status` is `"ok"`, `"error"`, `"timeout"`, or `"pending"`; pending is a normal nonterminal observation, not an exception. Optional `error`, `startedAt`, `endedAt`, `stopReason`, `livenessState`, `yielded`, `pendingError`, `timeoutPhase`, `providerStarted`, and `terminalReply` metadata is preserved so callers can distinguish observation timeouts from terminal outcomes. `timeoutMs` bounds the wait call; it does not cancel the run.

    <Warning>
    Outside an authorized Gateway request, model overrides require operator opt-in via `plugins.entries.<id>.subagent.allowModelOverride: true` in config. Plugins without that opt-in can use the configured model, but override requests are rejected.
    </Warning>

    `plugins.entries.<id>.subagent.allowedModels` can restrict overrides to
    canonical `provider/model` targets. The same policy applies to `complete`;
    request-scoped calls retain their authenticated client's override authority.
    The check uses the destination agent's model configuration, including exact
    configured model IDs, and applies to the plugin's initial override. Configured
    defaults, operator-installed model routing hooks, and automatic model fallbacks
    retain their own selection policies.

    `toolsAlsoAllow` adds exact, uniquely owned tools registered by the calling plugin to the worker's normal tool surface. The runtime rejects core tools and names shared with another plugin. Profiles and operator tool policies still apply, including explicit allowlists and denies.

    `promptMode: "minimal"` selects the bounded subagent prompt instead of the full conversation prompt. The plugin runtime exposes only this mode; omission keeps the full prompt. Use `disableTools: true` as well when the run must have an exact empty tool surface.

    `completionDelivery: "current-requester"` is default-off and is only available while a `before_dispatch` hook is handling an authenticated inbound request. OpenClaw captures the canonical requester session and delivery route before invoking the plugin, then delivers the subagent completion through the normal announce path. Plugins cannot provide or override requester lineage or destination fields. Calls outside that requester-bound hook context are rejected.

    `deleteSession(...)` can delete sessions created by the same plugin through `api.runtime.subagent.run(...)`. Deleting arbitrary user or operator sessions still requires an admin-scoped Gateway request.

  </Accordion>
  <Accordion title="api.runtime.sandbox">
    Inspect the effective sandbox workspace authority for an agent session.

    ```typescript
    const authority = api.runtime.sandbox.resolveWorkspaceAuthority({
      config: cfg,
      agentId,
      sessionKey,
    });

    const liveAuthority = await api.runtime.sandbox.prepareWorkspaceAuthority({
      config: cfg,
      agentId,
      sessionKey,
      workspaceDir,
      confinedToolNames: ["my_plugin_safe_tool"],
    });
    ```

    The result reports whether this session is sandboxed, whether its workspace
    is unavailable, read-only, or writable, and an optional `confinementError`
    when the effective Docker, tool, session, browser, or elevated policy can
    escape that workspace. Use this for host-owned delegation decisions that
    must not grant a worker more authority than its caller. It is an attestation
    helper, not a replacement for checking the caller's own authorization.

    `prepareWorkspaceAuthority(...)` performs the same policy check and also
    prepares the Docker sandbox for `workspaceDir`. It rejects a hot container
    whose live config hash does not match the requested mounts or policy. Pass
    only exact tool names whose registered implementations the calling plugin
    confines; wildcard prefixes do not prove tool ownership.

  </Accordion>
  <Accordion title="api.runtime.nodes">
    List connected nodes and invoke a node-host command from Gateway-loaded plugin code or from plugin CLI commands. Use this when a plugin owns local work on a paired device, for example a browser or audio bridge on another Mac.

    ```typescript
    const controller = new AbortController();
    const { nodes } = await api.runtime.nodes.list({ connected: true });

    const result = await api.runtime.nodes.invoke({
      nodeId: "mac-studio",
      command: "my-plugin.command",
      params: { action: "start" },
      timeoutMs: 30000,
      signal: controller.signal,
    });
    ```

    Pass the agent tool or request `AbortSignal` as `signal` when the caller can
    be canceled. Gateway-loaded calls forward cancellation to the paired node;
    node-host command handlers receive it as `context.signal` so they can stop
    in-flight requests and release local resources. Existing calls that omit the
    signal retain their previous behavior.

    Gateway-loaded plugins can open a connection-scoped binary channel to a
    registered node-host command with `nodes.openDuplex(...)`:

    ```typescript
    const controller = new AbortController();
    const channel = await api.runtime.nodes.openDuplex({
      nodeId: "paired-node",
      command: "my-plugin.image-bridge",
      params: { format: "png" },
      timeoutMs: 30000,
      maxMessageBytes: 4 * 1024 * 1024,
      signal: controller.signal,
    });

    const unsubscribe = channel.onMessage((message: Uint8Array) => {
      console.log("Received one complete binary message:", message.byteLength);
    });

    try {
      await channel.send(Uint8Array.of(1, 2, 3));
      const result = await channel.closed;
    } finally {
      unsubscribe();
      channel.close();
    }
    ```

    `openDuplex` accepts the same node, command, parameters, timeout,
    idempotency key, session key, caller signal, and requested scopes as
    `nodes.invoke`, plus optional `maxMessageBytes` and
    `maxOutstandingDeliveryBytes` limits. The per-message limit defaults to
    100 MiB and can be reduced, but never increased beyond 100 MiB.
    `maxOutstandingDeliveryBytes` bounds the combined size of complete messages
    whose asynchronous listener callbacks have not settled; it defaults to
    `maxMessageBytes`, cannot be smaller than that limit, and cannot exceed
    100 MiB. A protocol that can follow a maximum-sized response with a bounded
    asynchronous notification may request a larger outstanding-delivery budget
    without raising its per-message ceiling. OpenClaw splits each binary message
    into ordered 8 KiB payload fragments that fit the existing 16 KiB
    transport-frame limit; callers always send and receive complete
    `Uint8Array` messages. Concurrent sends preserve message boundaries.

    Register the channel's single message listener immediately after
    `openDuplex` resolves. Before a listener is registered, OpenClaw buffers at
    most eight complete messages and 1 MiB total; exceeding either limit closes
    the invocation. The unsubscribe callback removes that listener. Listeners
    may return `Promise<void>`; a thrown error or rejected promise, caller
    abort, `close()`, node disconnect, pairing change, plugin reload or
    retirement, or Gateway shutdown closes the channel and cancels outstanding
    node work. Successful node command completion and `channel.closed` wait
    for asynchronous message listeners already in progress. `close()` is
    idempotent, and retained channel methods reject after closure.
    `channel.closed` resolves with the successful command result or rejects
    with the node, authorization, transport, or cancellation error. Channels
    cannot reconnect or survive a node disconnection.

    The node plugin declares `duplex: true` and registers a message listener
    through the optional framed command I/O capability:

    ```typescript
    api.registerNodeHostCommand({
      command: "my-plugin.image-bridge",
      duplex: true,
      async handle(_paramsJSON, io) {
        if (!io?.frames) {
          throw new Error("Framed node command I/O is unavailable.");
        }

        const frames = io.frames;
        return await new Promise<string>((resolve, reject) => {
          frames.onMessage((message) => {
            void frames.send(message).then(() => resolve('{"ok":true}'), reject);
          });
          io.signal.addEventListener(
            "abort",
            () => reject(new Error("Node command was canceled.")),
            { once: true },
          );
        });
      },
    });
    ```

    Register `frames.onMessage(...)` before sending: the node announces framed
    readiness only after the listener exists, and `openDuplex` resolves only
    after both command dispatch and framed readiness. This prevents input from
    arriving before the plugin can consume it. The existing raw `emitChunk`
    and `onInput` helpers remain available to terminal-style commands.

    `openDuplex` is available only to a current, trusted in-process Gateway
    plugin runtime. Plugin CLI runtimes reject it with an actionable error;
    there is no remote polling or local fallback. Every invocation uses the
    same pairing, declared-command allowlist, plugin policy, approval,
    authorization, and connection-ownership checks as `nodes.invoke`.

    `nodes.list(...)` includes each connected node's advertised
    `nodePluginTools` descriptors when that node exposes plugin or MCP-backed
    tools to the agent. Those descriptors are live connection state: the Gateway
    drops them when the node disconnects, and a node can replace them with
    `node.pluginTools.update` after local plugin/MCP inventory changes.

    Inside the Gateway this runtime is in-process. In plugin CLI commands it calls the configured Gateway over RPC, so commands such as `openclaw googlemeet recover-tab` can inspect paired nodes from the terminal. Node commands still go through normal Gateway node pairing, command allowlists, plugin node-invoke policies, and node-local command handling.

    When execution identity auditing is enabled for an admitted run, those
    Gateway gates appear as enforced decision receipts. A successful node
    result is attribution-only. A policy that returns without calling its
    supplied `invokeNode` callback leaves the action unknown; returning a
    successful plugin result does not prove that the node action occurred.

    Plugins that expose node-hosted agent tools can set `agentTool.defaultPlatforms` for non-dangerous commands that should be allowlisted by default. Omit it when operators must opt in with `gateway.nodes.commands.allow`. Dangerous node-host commands should register a node-invoke policy with `api.registerNodeInvokePolicy(...)`; the policy runs in the Gateway after command allowlist checks and before the command is forwarded to the node, so direct `node.invoke` calls, node-hosted plugin tools, and higher-level plugin tools share the same enforcement path.

    `allow-always` remains one policy decision unless the node-invoke policy explicitly declares `standingApproval: { kind: "placement", scope: "<capability>" }`. That opt-in permits later launches only for a high-risk command on the same current managed placement, node pairing, environment owner, workspace, and semantic capability scope, for at most 30 days and never across Gateway restart. Use a stable, content-free scope for a capability whose approval deliberately covers later argument changes. Do not opt in when the approved target or other request arguments must remain exact.

    A node command may declare `prepare(context)` for asynchronous native startup.
    Node-host initialization awaits it before publishing the initial manifest or
    connecting to the Gateway; plugin registration itself stays synchronous.
    Shared preparation callbacks run once per node registry initialization, not
    per invocation or reconnect. Optional providers should retain a known
    unavailable state on expected preparation failure and let `isAvailable`
    withhold their commands; throwing aborts node startup. Use `watchAvailability`
    for later availability changes and `onDisconnect` for execution cleanup.

    <Warning>
    The optional `scopes` field requests Gateway operator scopes for the invocation. OpenClaw honors it only for bundled plugins and trusted official plugin installations; requests from other plugins do not elevate the call. When `openDuplex` runs inside an authenticated Gateway request, its effective scopes never exceed that authenticated caller's actual scopes, even if a trusted plugin requests stronger scopes. Without an authenticated incoming client, existing trusted-plugin scope behavior applies. Use requested scopes only when a trusted plugin must invoke a node command with a stricter Gateway scope, such as `operator.admin`.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.tasks">
    Bind Task Flow and Task Run state to a trusted, existing OpenClaw owner session.

    - `managedFlows` creates and mutates managed flow records. Bind with `fromToolContext(ctx)` or `bindSession({ sessionKey, requesterOrigin })` using host-resolved context, never raw user input.
    - `flows` and `runs` provide owner-scoped DTO lookups (`get`, `list`, `findLatest`, `resolve`). `flows` also exposes `getTaskSummary`; `runs.cancel` cancels an existing task.
    - `managedFlows.get(flowId)` returns the record with its revision. The read-only `flows` DTO is not the revision-bearing mutation record.

    A skill file does not provide `api` or register a plugin. For operator/agent
    workflows, use [managed Lobster execution](/automation/taskflow#run-a-managed-lobster-workflow).
    The following contract is for actual plugin/controller code.

    **Launching and linking a child**

    `runTask` records a link to existing work; it never launches ACP/subagent
    execution. The backing task must already exist with the same owner,
    canonical run/session identities and task runtime. Arbitrary IDs or a
    `status: "running"` declaration cannot establish that authority.

    1. Create a managed flow bound to the real requester session. Handle creation failure before launching work. Binding state access does not grant subagent requester authority.
    2. Inside an active requester-bound `before_dispatch` hook for an authenticated inbound request, call `api.runtime.subagent.run` with a unique agent-qualified child session key, the task message and `completionDelivery: "current-requester"`. The Gateway captures the requester and delivery route; retain the returned canonical `runId` and `sessionKey`. Missing identities or a rejected launch are failures, not permission to fabricate a task. Ordinary runs without `current-requester` have `not_applicable` completion delivery and lack the mirrored backing needed for this link.
    3. Immediately before linking, resolve the canonical task with the owner-bound `runs.resolve(runId)`. Verify its owner, run id, child session key and task runtime. Use its actual `sourceId`, queued/running status and available timing facts in `managedFlows.runTask`, alongside the managed flow id and task description. Do not confuse the launch result's harness/provider metadata with the task DTO's `runtime`. Keep this final read/check and `runTask` synchronous, with no intervening `await`, and check `created` before proceeding.
    4. Observe completion through `subagent.waitForRun` and the canonical task. A bounded wait returning `pending` or an observation timeout is not a terminal child failure and does not cancel the run. Interpret results only after actual completion. On failure, record a failed/blocked flow outcome and report it; never insert a replacement child declaration to hide launch/link refusal.
    5. Reload the managed record after awaited work. Stop for terminal state or cancellation intent; use the latest revision for the next state transition. Check every `applied` result, including `finish`/`fail`, and check `cancelled` for cancellation. On revision conflict, reread and reconcile rather than blindly retrying side effects.

    <Warning>
    A child can finish before step 3. `runTask` does not replay terminal events
    that preceded linkage, so never label a completed backing task as queued or
    running. Handle its completed result directly in the controller instead of
    creating a stale active projection. The launch/link sequence is not atomic.
    </Warning>

    `completionDelivery: "current-requester"` is available only within the
    genuine hook invocation. Do not retain that authority after the hook ends
    or call private requester-context/registry helpers. See `api.runtime.subagent`
    above for the public launch and wait contract. ACP linkage likewise requires
    an existing owner-backed ACP launch, not a standalone `runTask` declaration.

    **State without a child**

    For inline work, use `createManaged`, then checked `setWaiting`, `resume`,
    `finish` or `fail` transitions as appropriate; no `runTask` is needed.
    Keep `stateJson` and `waitJson` bounded. Waiting metadata records the reason
    and correlation, but the controller must register the real event listener.

    Records persist in SQLite; arbitrary JavaScript is not replayed after
    restart. Reload with the same trusted owner binding and explicitly resume
    from current state. Task Flow is not a scheduler: use Automations or
    `api.session.workflow.scheduleSessionTurn(...)` for future wakeups. See
    [Task Flow](/automation/taskflow) for durability and cancellation.

  </Accordion>
  <Accordion title="api.runtime.tts">
    Text-to-speech synthesis.

    ```typescript
    // Standard TTS
    const clip = await api.runtime.tts.textToSpeech({
      text: "Hello from OpenClaw",
      cfg: api.config,
    });

    // Telephony-optimized TTS
    const telephonyClip = await api.runtime.tts.textToSpeechTelephony({
      text: "Hello from OpenClaw",
      cfg: api.config,
    });

    // List available voices
    const voices = await api.runtime.tts.listVoices({
      provider: "elevenlabs",
      cfg: api.config,
    });
    ```

    Uses core `tts` configuration and provider selection. Returns PCM audio buffer + sample rate. `textToSpeechStream` is also available for streaming synthesis.

  </Accordion>
  <Accordion title="api.runtime.mediaUnderstanding">
    Image, audio, and video analysis.

    ```typescript
    // Describe an image
    const image = await api.runtime.mediaUnderstanding.describeImageFile({
      filePath: "/tmp/inbound-photo.jpg",
      cfg: api.config,
      agentDir: "/tmp/agent",
    });

    // Prepare a capture limit before installing audio receive listeners.
    const budget = await api.runtime.mediaUnderstanding.resolveAudioInputBudget({
      cfg: api.config,
    });
    // budget.enabled is false when audio understanding is disabled. Otherwise,
    // budget.maxBytes includes the container header and covers the largest fallback.

    // Transcribe audio
    const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
      filePath: "/tmp/inbound-audio.ogg",
      cfg: api.config,
      mime: "audio/ogg", // optional, for when MIME cannot be inferred
    });

    // Describe a video
    const video = await api.runtime.mediaUnderstanding.describeVideoFile({
      filePath: "/tmp/inbound-video.mp4",
      cfg: api.config,
    });

    // Generic file analysis
    const result = await api.runtime.mediaUnderstanding.runFile({
      filePath: "/tmp/inbound-file.pdf",
      cfg: api.config,
    });

    // Structured image extraction through a specific provider/model.
    // Include at least one image; text inputs are supplemental context.
    const evidence = await api.runtime.mediaUnderstanding.extractStructuredWithModel({
      provider: "codex",
      model: "gpt-5.6-sol",
      input: [
        {
          type: "image",
          buffer: receiptImageBuffer,
          fileName: "receipt.png",
          mime: "image/png",
        },
        { type: "text", text: "Prefer the printed total over handwritten notes." },
      ],
      instructions: "Extract vendor, total, and searchable tags.",
      schemaName: "receipt.evidence",
      jsonSchema: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          total: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["vendor", "total"],
      },
      cfg: api.config,
    });
    ```

    Returns `{ text: undefined }` when no output is produced (e.g. skipped input).

    `describeImageFileWithModel(...)` describes an already-known image through a specific provider/model, bypassing the default active-model resolution that `describeImageFile(...)` uses.

  </Accordion>
  <Accordion title="api.runtime.imageGeneration">
    Image generation.

    ```typescript
    const result = await api.runtime.imageGeneration.generate({
      prompt: "A robot painting a sunset",
      cfg: api.config,
    });

    const providers = api.runtime.imageGeneration.listProviders({ cfg: api.config });
    ```

  </Accordion>
  <Accordion title="api.runtime.videoGeneration">
    Video generation, mirroring the image generation shape.

    ```typescript
    const result = await api.runtime.videoGeneration.generate({
      prompt: "A drone shot flying over a coastline at sunrise",
      cfg: api.config,
    });

    const providers = api.runtime.videoGeneration.listProviders({ cfg: api.config });
    ```

  </Accordion>
  <Accordion title="api.runtime.musicGeneration">
    Music generation, mirroring the image generation shape.

    ```typescript
    const result = await api.runtime.musicGeneration.generate({
      prompt: "An upbeat lo-fi track for a coding session",
      cfg: api.config,
    });

    const providers = api.runtime.musicGeneration.listProviders({ cfg: api.config });
    ```

  </Accordion>
  <Accordion title="api.runtime.webSearch">
    Web search.

    ```typescript
    const providers = api.runtime.webSearch.listProviders({ config: api.config });

    const result = await api.runtime.webSearch.search({
      config: api.config,
      args: { query: "OpenClaw plugin SDK", count: 5 },
    });
    ```

  </Accordion>
  <Accordion title="api.runtime.media">
    Low-level media utilities.

    ```typescript
    const webMedia = await api.runtime.media.loadWebMedia(url);
    const mime = await api.runtime.media.detectMime(buffer);
    const kind = api.runtime.media.mediaKindFromMime("image/jpeg"); // "image"
    const isVoice = api.runtime.media.isVoiceCompatibleAudio(filePath);
    const metadata = await api.runtime.media.getImageMetadata(filePath);
    const resized = await api.runtime.media.resizeToJpeg(buffer, { maxWidth: 800 });
    const terminalQr = await api.runtime.media.renderQrTerminal("https://openclaw.ai");
    const pngQr = await api.runtime.media.renderQrPngBase64("https://openclaw.ai", {
      scale: 6, // 1-12
      marginModules: 4, // 0-16
    });
    const pngQrDataUrl = await api.runtime.media.renderQrPngDataUrl("https://openclaw.ai");
    const tmpRoot = resolvePreferredOpenClawTmpDir();
    const pngQrFile = await api.runtime.media.writeQrPngTempFile("https://openclaw.ai", {
      tmpRoot,
      dirPrefix: "my-plugin-qr-",
      fileName: "qr.png",
    });
    ```

  </Accordion>
  <Accordion title="api.runtime.config">
    Current runtime config snapshot and transactional config writes. Prefer
    config that was already passed into the active call path; use
    `current()` only when the handler needs the process snapshot directly.

    ```typescript
    const cfg = api.runtime.config.current();
    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate(draft) {
        draft.plugins ??= {};
      },
    });
    ```

    `mutateConfigFile(...)` and `replaceConfigFile(...)` return a `followUp`
    value, for example `{ mode: "restart", requiresRestart: true, reason }`,
    which records the writer intent without taking restart control away from the
    gateway.

  </Accordion>
  <Accordion title="api.runtime.system">
    System-level utilities.

    ```typescript
    const accepted = api.runtime.system.enqueueSystemEvent(text, options);
    api.runtime.system.requestHeartbeat({
      source: "other",
      intent: "event",
      reason: "plugin-event",
    });
    api.runtime.system.requestHeartbeatNow({ reason: "plugin-event" }); // Deprecated compatibility alias.
    const heartbeatResult = await api.runtime.system.runHeartbeatOnce({
      reason: "plugin-triggered-check",
    });
    const output = await api.runtime.system.runCommandWithTimeout(cmd, args, opts);
    const hint = api.runtime.system.formatNativeDependencyHint(pkg);
    ```

    `runHeartbeatOnce(...)` runs a single heartbeat cycle immediately, bypassing the normal coalesce timer. Delivery defaults to the configured operator DM (`commands.ownerAllowFrom`, then channel `allowFrom`); pass `{ heartbeat: { target: "none" } }` for an internal-only run.

    `runCommandWithTimeout(...)` returns captured `stdout` and `stderr`, optional
    truncation counts, `code`, `signal`, `killed`, `termination`, and
    `noOutputTimedOut`. Timeout and no-output-timeout results report `code: 124`
    when the child process does not provide a non-zero exit code. Non-timeout
    signal exits can still return `code: null`, so use `termination` and
    `noOutputTimedOut` to distinguish timeout reasons.

  </Accordion>
  <Accordion title="api.runtime.events">
    Event subscriptions.

    ```typescript
    api.runtime.events.onAgentEvent((event) => {
      /* ... */
    });
    api.runtime.events.onSessionTranscriptUpdate((update) => {
      /* ... */
    });
    ```

  </Accordion>
  <Accordion title="api.runtime.logging">
    Logging.

    ```typescript
    const verbose = api.runtime.logging.shouldLogVerbose();
    const childLogger = api.runtime.logging.getChildLogger({ plugin: "my-plugin" }, { level: "debug" });
    ```

  </Accordion>
  <Accordion title="api.runtime.modelAuth">
    Model and provider auth resolution.

    ```typescript
    const auth = await api.runtime.modelAuth.getApiKeyForModel({ model, cfg });

    // Request-ready auth, including provider runtime exchanges (e.g. OAuth refresh)
    const runtimeAuth = await api.runtime.modelAuth.getRuntimeAuthForModel({ model, cfg });

    const providerAuth = await api.runtime.modelAuth.resolveApiKeyForProvider({
      provider: "openai",
      cfg,
    });
    ```

  </Accordion>
  <Accordion title="api.runtime.state">
    State directory resolution and SQLite-backed keyed storage.

    ```typescript
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const store = api.runtime.state.openKeyedStore<MyRecord>({
      namespace: "my-feature",
      maxEntries: 200,
      defaultTtlMs: 15 * 60_000,
    });

    await store.register("key-1", { value: "hello" });
    const claimed = await store.registerIfAbsent("dedupe-key", { value: "first" });
    const value = await store.lookup("key-1");
    await store.deleteIf?.("key-1", (current) => current.value === "hello");
    await store.consume("key-1");
    await store.clear();

    const blobs = api.runtime.state.openBlobStore<MyBlobMetadata>({
      namespace: "rendered-artifacts",
      maxEntries: 100,
      maxBytesPerEntry: 4 * 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      defaultTtlMs: 15 * 60_000,
    });
    await blobs.register(
      "artifact-1",
      new TextEncoder().encode("binary or text payload"),
      { contentType: "text/plain" },
    );
    const blob = await blobs.lookup("artifact-1");
    ```

    Keyed stores survive restarts and are isolated by the runtime-bound plugin id. Use `registerIfAbsent(...)` for atomic dedupe claims: it returns `true` when the key was missing or expired and registered, or `false` when a live value already exists without overwriting its value, creation time, or TTL. Use `deleteIf(...)` when cleanup must remove only the value previously observed; its synchronous predicate and deletion run in one SQLite transaction. Limits: `maxEntries` per namespace, 50,000 live rows per plugin, JSON values up to 1 MiB of UTF-8 encoded JSON, and optional TTL expiry. By default, a write at either row limit sheds the oldest live rows from the namespace being written; sibling namespaces are not evicted for that write, and the write still fails if the namespace cannot free enough rows. Set `overflowPolicy: "reject-new"` for durable ownership records that must never be evicted: new keys fail at either limit, while existing keys remain updateable.

    `lookupMany(keys)` is an optional keyed-store capability for at most 10,000 exact keys per call. Results have the same length and order as the input, including duplicates. Each position is a `Result<T | undefined, PluginStateStoreError>`: `{ ok: true, value }` on success, including `value: undefined` for missing or expired keys, or `{ ok: false, error }` for corrupt stored JSON. An empty request returns `[]`. Keys use the same trimming and 512-byte UTF-8 limit as `lookup`; invalid keys or an oversized request fail with `PLUGIN_STATE_INVALID_INPUT` and operation `lookup` before reading. Database acquisition and query errors fail the whole call. Corrupt-JSON errors retain the `lookup` error code and operation in their per-key result. Inspect each result only when the reader reaches that position, and throw `result.error` if it is not `ok`; this lets a reader stop at an earlier missing or invalid chunk without raising a later corruption error. Each call uses one expiry cutoff and one SQLite selection in the same plugin and namespace, without creating a missing database. Separate calls, including metadata reads, do not share a snapshot; chunked formats must retain their generation, digest, and reader-lifetime checks.

    Current host factories provide `lookupMany`, but the public store types keep it optional for existing third-party adapters and declared older host versions. A plugin supporting those hosts must check the method and use its existing sequential `lookup` path when absent; never retry a failed bulk read through that path. Matrix, Microsoft Teams, and Voice Call retain this compatibility until their declared minimum host supplies the capability. Do not import a new helper export from an older host just to detect this method.

    `openSyncKeyedStore<T>(...)` returns the same store shape with synchronous methods (`register`, `registerIfAbsent`, `deleteIf`, `lookup`, `lookupMany`, `consume`, `clear` all return values directly instead of promises) for callers that cannot await.

    `openBlobStore<TMetadata>(...)` stores bounded binary payloads in shared SQLite without base64 or file sidecars. It requires per-entry, per-namespace byte, and row limits; copies byte arrays at the API boundary; and lists metadata without loading every BLOB. `register(...)` is an explicit upsert, including for expired keys. `registerIfAbsent(...)` provides collision-safe creation: an expired key remains occupied until its owner claims it with `deleteExpiredKey(key)` or `deleteExpired()`, preserving metadata needed to remove related named artifacts after the SQLite commit. Any row with a TTL is transient and excluded from backup/restore even before it expires; omit TTL for durable, restorable state. Host fuses cap each BLOB at 100 MiB, each plugin at 512 MiB of physically stored BLOBs, and each plugin at 50,000 physically stored rows, including expired rows awaiting owner cleanup. Use `registerIfAbsent(...)` with `overflowPolicy: "reject-new"` when external materializations must not be silently orphaned by replacement or eviction.

    `openChannelIngressQueue<TPayload>(...)` opens a persisted ingress queue scoped to the calling plugin, for buffering inbound events that need at-least-once processing across restarts. When stale-claim recovery uses `shouldRecover`, also provide `shouldRecoverCorrupt` if corrupt claimed payloads should be quarantined: its payload-independent claim identity lets the plugin preserve live owner and lane policy before the queue tombstones the row.

    Plugin-state leases were removed. Use short SQLite transactions for atomic database work and plugin-scoped keyed stores (`openKeyedStore` or `openSyncKeyedStore`) for bounded durable state.

    `openChannelIngressDrain(...)` opens the core channel-agnostic worker over that queue (or creates a queue when none is supplied). The drain owns stale-claim recovery, per-lane claim serialization, complete-at-adoption or complete-on-dispatch-return, retry/dead-letter disposition, optional pre-adoption supersede, and claim→adoption stall timeout. Wire claim ownership into reply generation with `turnAdoptionLifecycle` (via `bindIngressLifecycleToReplyOptions` from `plugin-sdk/channel-outbound`). Channel plugins keep accept-side enqueue, lane derivation, non-retryable classification, and any supersede authorization policy.

    <Warning>
    `openBlobStore`, `openKeyedStore`, `openSyncKeyedStore`, `openChannelIngressQueue`, and `openChannelIngressDrain` are available only to bundled plugins and trusted official plugin installations in this release. Refusals include the recorded reason, registry database path, origin, and install source/spec; `plugins inspect` reports the same trust facts. A load path selecting the recorded official installation preserves trust; an untracked local copy does not. See [Trusted plugin state refused](/tools/plugin#trusted-plugin-state-refused) for doctor migrations and cause-specific remedies. An untrusted channel's ingress monitor fails channel start instead of running without a durable queue.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.channel">
    Channel-specific runtime helpers (available when a channel plugin is loaded). Grouped by concern:

    | Group | Purpose |
    | --- | --- |
    | `text` | Chunking (`chunkText`, `chunkMarkdownText`, `resolveChunkMode`), control-command detection, Markdown table conversion. |
    | `reply` | Buffered-block reply dispatch, envelope formatting, effective messages/human-delay config resolution. |
    | `routing` | `buildAgentSessionKey`, `resolveAgentRoute`. |
    | `pairing` | `buildPairingReply`, allowlist reads/removals, pairing-request upserts, and request-derived approval entries. |
    | `media` | Remote media download/save (see below). |
    | `activity` | Record/read last channel activity. |
    | `session` | Session metadata from inbound events, last-route updates. |
    | `mentions` | Mention-policy helpers (see below). |
    | `reactions` | Ack-reaction handles for in-flight processing indicators. |
    | `groups` | Group policy and require-mention resolution. |
    | `debounce` | Inbound message debouncing. |
    | `commands` | Command authorization and text-command gating. |
    | `outbound` | Load a channel's outbound adapter. |
    | `inbound` | Build inbound event context and run the shared inbound-event/reply kernel. |
    | `threadBindings` | Adjust idle-timeout/max-age for bound session threads. |
    | `runtimeContexts` | Register, read, and watch process-local per-channel/account/capability context. |

    `api.runtime.channel.media` is the preferred surface for channel media downloads and storage:

    ```typescript
    const saved = await api.runtime.channel.media.saveRemoteMedia({
      url,
      subdir: "inbound",
      maxBytes,
      filePathHint: fileName,
    });
    ```

    Use `saveRemoteMedia(...)` when a remote URL should become OpenClaw media. Use `saveResponseMedia(...)` when the plugin already fetched a `Response` with plugin-owned auth, redirect, or allowlist handling. Use `readRemoteMediaBuffer(...)` only when the plugin needs raw bytes for inspection, transforms, decryption, or reupload. `fetchRemoteMedia(...)` remains a deprecated compatibility alias for `readRemoteMediaBuffer(...)`.

    Remote media options and `fetchWithSsrFGuard(...)` from `openclaw/plugin-sdk/ssrf-runtime` accept a synchronous `beforeRequest` callback for final-dispatch authorization checks. It runs after proxy, DNS, and dispatcher preparation and immediately before every physical request. Redirects invoke it once per hop; media retries invoke it again for every attempt and hop. If it throws, that request is not sent and the same error propagates. Promise or thenable results are rejected before transport dispatch.

    Guarded fetch also accepts a synchronous `resolveDispatcherPolicy(url)` override, reevaluated for each redirect. An undefined result uses `dispatcherPolicy`, or direct routing when no default policy is supplied. Providers preserving operator-configured proxy routing can use `resolveEnvHttpProxyAgentOptions` and `matchesNoProxy` from `openclaw/plugin-sdk/fetch-runtime` to select each hop. The `trusted_explicit_proxy` mode permits HTTP, HTTPS, `socks:` and `socks5:` proxy URLs and delegates target DNS to the explicitly trusted proxy; proxy-host validation and target-host policy still apply. Direct hops keep DNS pinning. Strict mode rejects SOCKS proxies, and the separate trusted-env-proxy gate remains HTTP(S)-only.

    `api.runtime.channel.mentions` is the shared inbound mention-policy surface for bundled channel plugins that use runtime injection:

    ```typescript
    const mentionMatch = api.runtime.channel.mentions.matchesMentionWithExplicit(text, {
      mentionRegexes,
      mentionPatterns,
    });

    const decision = api.runtime.channel.mentions.resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: mentionMatch.matched,
        implicitMentionKinds: api.runtime.channel.mentions.implicitMentionKindWhen(
          "reply_to_bot",
          isReplyToBot,
        ),
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands,
        hasControlCommand,
        commandAuthorized,
      },
    });
    ```

    Available mention helpers:

    - `buildMentionRegexes`
    - `matchesMentionPatterns`
    - `matchesMentionWithExplicit`
    - `implicitMentionKindWhen`
    - `resolveInboundMentionDecision`

    Use the normalized `{ facts, policy }` path for mention decisions.

    Several fields under `reply`, `session`, and `inbound` carry per-field `@deprecated` notes pointing at the current channel-turn kernel or channel-outbound adapters; check the inline JSDoc on the specific helper before building new code on it.

  </Accordion>
</AccordionGroup>

## Gateway service events

Gateway-hosted services also receive `ctx.getCron?.()` for the scheduler operations
already available to Gateway hooks: `list`, `add`, `update`, `remove`, and
`removeStaleJobFamily`. Non-Gateway service hosts omit this getter.

Use the service's `start()` and `stop()` methods to own recurring reconciliation.
They run for service or plugin replacement as well as Gateway startup and shutdown;
`gateway_start` and `gateway_stop` do not replay on plugin-only reload.
Each returned scheduler handle belongs to one service lifetime and one scheduler
instance. Calls, including queued writes, reject once service shutdown begins or
that scheduler is replaced. Call `ctx.getCron()` again to obtain the replacement
scheduler while the service remains active.

A service can declare `reload: { configPrefixes: ["myConfig.service"] }` alongside
its `id`, `start`, and `stop`. After a matching config change commits, the Gateway
stops that service and calls `start(ctx)` again with the new `ctx.config`. Only
loaded services declaring the matching prefix are replaced; overlapping owners
all refresh. Existing equal or narrower restart or no-op policies still take precedence.
Each start receives a new capability lease and health reporter. Stop must release
resources before resolving; failed replacement cleanup or startup triggers
Gateway recovery. A full plugin replacement subsumes these service restarts.

Trusted official diagnostics exporter services can also receive
`ctx.internalDiagnostics.getRuntimeIdentity?.()`. It returns the hosting
process's canonical `processInstanceId` and optional loaded `buildId`, with no
filesystem lookup or RPC. Capture it during service startup; a retained getter
throws after the service lease is revoked. Hosts that do not provide this
optional capability leave runtime identity unavailable. This diagnostic fact
does not grant authority or identify a service-reload epoch.

Long-lived services registered with `api.registerService(...)` receive a process-local
`ctx.gatewayEvents` facade when the process runs a Gateway broadcaster; in runtimes without one the
field is absent, so feature-detect it and keep a fallback (for example a coarse poll). Use
`onSessionsChanged(...)` to react after the Gateway broadcasts a `sessions.changed` notice:

```typescript
let unsubscribeSessionsChanged: (() => void) | undefined;

api.registerService({
  id: "session-index",
  start(ctx) {
    unsubscribeSessionsChanged = ctx.gatewayEvents?.onSessionsChanged((event) => {
      // event: { sessionKey, agentId?, label?, displayName?, reason?, phase? }
      refreshSession(event.sessionKey);
    });
  },
  stop() {
    unsubscribeSessionsChanged?.();
    unsubscribeSessionsChanged = undefined;
  },
});
```

The handler runs in the Gateway process and does not add a Gateway protocol subscription. Keep the
returned unsubscribe function and call it during service cleanup. The payload is a lightweight
change notice; use `api.runtime.agent.session.getSessionEntry(...)` when the plugin needs the full
current session entry.

OpenClaw calls a service's `stop()` at most once per startup attempt, including when a replacement
times out before startup fails. Failed-start rollback and shutdown share the same cleanup result;
a cleanup failure is recorded rather than retried within that attempt.

Service startup failures from a returned or awaited promise are recorded automatically. A service
that intentionally starts required work in the background must report later failure and recovery
through its generation-bound health reporter:

```typescript
api.registerService({
  id: "index-worker",
  start(ctx) {
    void startIndexWorker().then(
      () => ctx.serviceHealth?.clearFailure(),
      (error) => ctx.serviceHealth?.reportFailure(error),
    );
  },
  stop() {
    stopIndexWorker();
  },
});
```

The reporter is revoked when the service stops or its plugin registry generation is replaced, so a
late callback from an old generation cannot overwrite current health. Prefer returning the startup
promise when the service is not usable until that promise settles; use the reporter only for
deliberately nonblocking work that owns its own stop path.

## Storing runtime references

Use `createPluginRuntimeStore` to store the runtime reference for use outside the `register` callback:

<Steps>
  <Step title="Create the store">
    ```typescript
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

    const store = createPluginRuntimeStore<PluginRuntime>({
      pluginId: "my-plugin",
      errorMessage: "my-plugin runtime not initialized",
    });
    ```

  </Step>
  <Step title="Wire into the entry point">
    ```typescript
    export default defineChannelPluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Example",
      plugin: myPlugin,
      setRuntime: store.setRuntime,
    });
    ```
  </Step>
  <Step title="Access from other files">
    ```typescript
    export function getRuntime() {
      return store.getRuntime(); // throws if not initialized
    }

    export function tryGetRuntime() {
      return store.tryGetRuntime(); // returns null if not initialized
    }
    ```

  </Step>
</Steps>

<Note>
Prefer `pluginId` for the runtime-store identity. The lower-level `key` form is for uncommon cases where one plugin intentionally needs more than one runtime slot.
</Note>

## Other top-level `api` fields

Beyond `api.runtime`, the API object also provides:

<ParamField path="api.id" type="string">
  Plugin id.
</ParamField>
<ParamField path="api.name" type="string">
  Plugin display name.
</ParamField>
<ParamField path="api.config" type="OpenClawConfig">
  Current config snapshot (active in-memory runtime snapshot when available).
</ParamField>
<ParamField path="api.pluginConfig" type="Record<string, unknown>">
  Plugin-specific config from `plugins.entries.<id>.config`.
</ParamField>
<ParamField path="api.logger" type="PluginLogger">
  Scoped logger (`debug`, `info`, `warn`, `error`).
</ParamField>
<ParamField path="api.registrationMode" type="PluginRegistrationMode">
  Current load mode: `"full"` (live activation), `"discovery"` / `"tool-discovery"` (read-only capability discovery), `"setup-only"` (lightweight setup entry), `"setup-runtime"` (setup flow that also needs the runtime channel entry), or `"cli-metadata"` (CLI command metadata collection).
</ParamField>
<ParamField path="api.resolvePath(input)" type="(string) => string">
  Resolve a path relative to the plugin root.
</ParamField>

## Related

- [Plugin internals](/plugins/architecture) — capability model and registry
- [SDK entry points](/plugins/sdk-entrypoints) — `definePluginEntry` options
- [SDK overview](/plugins/sdk-overview) — subpath reference
