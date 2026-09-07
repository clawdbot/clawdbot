---
summary: "Agent identity, directories, session store, transcripts, and sandbox authority"
read_when:
  - You are resolving agent directories, identity, or thinking defaults
  - You are reading or writing session entries and transcripts from a plugin
  - You need the effective sandbox workspace authority for a session
title: "Plugin runtime agent helpers"
sidebarTitle: "Agent and sessions"
---

The agent, session, transcript, and sandbox surfaces of `api.runtime`, plus the request-bound capabilities a plugin command handler receives. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference.

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

## Agent and session namespaces

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
</AccordionGroup>
