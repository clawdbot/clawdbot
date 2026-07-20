---
summary: "api.runtime -- the injected runtime helpers available to plugins"
title: "Plugin runtime helpers"
sidebarTitle: "Runtime helpers"
read_when:
  - You need to call core helpers from a plugin (TTS, STT, image gen, web search, Gateway, subagent, nodes)
  - You want to understand what api.runtime exposes
  - You are accessing config, agent, or media helpers from plugin code
---

Reference for the `api.runtime` object injected into every plugin during registration. Use these helpers instead of importing host internals directly.

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

## Reusable runtime utilities

Use inbound `botLoopProtection` facts for bot-authored inbound messages. Core applies the shared in-memory sliding-window guard before session record and dispatch, without tying the policy to one channel. The guard tracks `(scopeId, conversationId, participant pair)` keys, counts both directions of a pair together, applies a cooldown once the window budget is exceeded, and prunes inactive entries opportunistically.

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
    config: channelConfig.botLoopProtection,
    defaultsConfig: runtimeConfig.channels?.defaults?.botLoopProtection,
    defaultEnabled: allowBotsMode !== "off",
  },
};
```

Use `openclaw/plugin-sdk/pair-loop-guard-runtime` directly only for custom
two-party event loops that do not go through the shared inbound reply runner.

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

    `runEmbeddedPiAgent(...)` remains as a deprecated compatibility alias for existing plugins. New code should use `runEmbeddedAgent(...)`.

    `resolveCliBackendDispatchEligibility({ provider, model, agentId, authProfileId, config, agentDir, workspaceDir })` shares the embedded runner's CLI-backend dispatch decision (route, the backend's declared `subscriptionAuthDispatch` capability, stored credential mode — honoring an explicitly pinned `authProfileId`) with callers that opt embedded runs into `cliBackendDispatch: "subscription-auth"`. It returns `{ provider }` when the run would execute through the CLI backend and `undefined` when it stays on the direct passthrough, so callers can budget timeouts for the run that will actually execute.

    `resolveThinkingPolicy(...)` returns the provider/model's supported thinking levels and optional default. Provider plugins own the model-specific profile through their thinking hooks, so tool plugins should call this runtime helper instead of importing or duplicating provider lists.

    `normalizeThinkingLevel(...)` converts user text such as `on`, `x-high`, or `extra high` to the canonical stored level before checking it against the resolved policy.

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

    `createSessionEntry(...)` creates a new canonical session row and transcript. Its trusted `initialEntry` surface is deliberately narrow: a non-empty `agentHarnessId`, optional `modelSelectionLocked: true`, and optional `pluginExtensions`. The injected runtime accepts only harness ids owned by the calling plugin through `registerAgentHarness(...)`; this is an ownership invariant, not a sandbox between in-process plugins. It rejects an existing row; `label` and `spawnedCwd` are separate creation fields rather than trusted-entry patches.

    Creation holds the session lifecycle mutation fence through `afterCreate`, so new work waits for plugin-owned initialization to finish and pre-existing admitted work makes creation fail. The callback receives a clone of the created state. If it returns a patch, that patch may contain only `pluginExtensions`, and its value is the complete final `pluginExtensions` field. A callback or final-persistence failure rolls back the unchanged new row and transcript; guarded rollback preserves a row changed or claimed concurrently. `recoverMatchingInitialEntry: true` is only for retrying interrupted initialization when the persisted trusted fields match exactly, and recovery requires `afterCreate` to return a final patch.

    Use `runWithWorkAdmission(...)` when a plugin starts work on a persisted session. The callback rejects archived or concurrently replaced sessions, keeps archive/reset/delete mutations coordinated through completion, and receives an `AbortSignal` that must be forwarded to the agent run. A harness may explicitly name trusted execution delegates through its experimental `delegatedExecutionPluginIds` registration field. Delegates can admit and run only an exact existing model-locked session; all session mutations remain restricted to the harness owner. See [Agent harness plugins](/plugins/sdk-agent-harness#delegated-execution).

    Maintenance and repair plugins may use `deleteSessionEntry(...)` for one scoped session entry, `cleanupSessionLifecycleArtifacts(...)` for lifecycle-owned scratch sessions, and `resolveSessionStoreBackupPaths(...)` before mutating a store. Pass `expectedSessionId` and `expectedUpdatedAt` when deletion must not race a concurrent session update; use `expectedSessionId: null` when the earlier snapshot had no session id. These helpers are narrow repair/lifecycle surfaces, not a general store deletion API.

    `resolveStorePath(...)` and `updateSessionStoreEntry(...)` round out the session helpers: `resolveStorePath` resolves the session store path for a given scope, and `updateSessionStoreEntry({ storePath, sessionKey, update })` patches one entry directly by store path when the caller already knows it.

    `loadTranscriptEventsSync(...)` is available for synchronous doctor and repair paths that cannot use the async transcript runtime. It returns raw `SessionStoreTranscriptEvent` records. Normal plugin runtime code should prefer `openclaw/plugin-sdk/session-transcript-runtime`.

    `formatSqliteSessionFileMarker(...)`, `parseSqliteSessionFileMarker(...)`, and `sqliteSessionFileMarkerMatchesSession(...)` are transitional helpers for code that still receives a legacy field named `sessionFile`. A parsed SQLite marker identifies a live SQLite transcript target; it is not a filesystem path. New APIs should carry typed session identity instead of marker strings.

    For transcript reads and writes, import `openclaw/plugin-sdk/session-transcript-runtime` and use `resolveSessionTranscriptIdentity(...)`, `resolveSessionTranscriptTarget(...)`, `readSessionTranscriptEvents(...)`, `readSessionTranscriptRawDelta(...)`, `readSessionTranscriptVisibleMessageDelta(...)`, `readVisibleSessionTranscriptMessageEntries(...)`, `appendSessionTranscriptMessageByIdentity(...)`, `publishSessionTranscriptUpdateByIdentity(...)`, or `withSessionTranscriptWriteLock(...)` with `{ agentId, sessionKey, sessionId }`. These APIs let plugins identify a transcript, read raw events or visible branch-safe message entries, append messages, publish updates, and run related operations under the same transcript write lock without depending on active transcript file paths. `readVisibleSessionTranscriptMessageEntries(...)` returns ordered read metadata; its `seq` field is not a resumable cursor.

    `readSessionTranscriptRawDelta(...)` returns a bounded `page`, `reset`, or `missing` result. Pass the opaque `page.cursor` into the next call. Pure appends preserve the cursor, while transcript replacement returns `reset` with a new bootstrap cursor. Pages default to 1,000 events and 1,000,000 serialized bytes; callers may request up to 10,000 events and 64 MiB. When the next event alone exceeds `maxBytes`, the page is empty and reports `requiredBytes`; retry with at least that byte limit when it is no greater than 64 MiB. Larger individual events require the complete-read API. A cursor identifies position only and never grants access to another session.

    `readSessionTranscriptVisibleMessageDelta(...)` provides the same bounded bootstrap-and-resume shape over the host-owned active message projection. It returns messages from oldest to newest, so context engines can drain initial history and persist the opaque cursor as their watermark. Store and return the cursor unchanged; it is a continuation hint, not an authorization credential. Linear appends resume after the last returned message. Transcript replacement, a cursor whose anchor left or moved within the active branch, malformed cursors, and cross-session cursors return `reset` with a fresh bootstrap cursor. The count and byte defaults and caps match the raw delta API. While the active projection is rebuilding after a branch change, the result is `unavailable` with reason `projection_rebuilding`; retry later rather than falling back to an active transcript file.

    The legacy whole-store and active transcript file helpers are no longer exported from the plugin SDK. Use the scoped entry helpers for session metadata and the transcript identity helpers for active transcript operations. Archive/support workflows that need file artifacts should use their dedicated archive surfaces instead of active session runtime APIs.

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
    Model overrides require operator opt-in via `plugins.entries.<id>.llm.allowModelOverride: true` in config. Use `plugins.entries.<id>.llm.allowedModels` to restrict trusted plugins to specific canonical `provider/model` targets. Cross-agent completions require `plugins.entries.<id>.llm.allowAgentIdOverride: true`.
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
  <Accordion title="api.runtime.subagent">
    Launch and manage background subagent runs.

    ```typescript
    // Start a subagent run
    const { runId } = await api.runtime.subagent.run({
      sessionKey: "agent:main:subagent:search-helper",
      message: "Expand this query into focused follow-up searches.",
      toolsAlsoAllow: ["my_plugin_progress"],
      provider: "openai", // optional override
      model: "gpt-5.6-sol", // optional override
      deliver: false,
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

    <Warning>
    Model overrides (`provider`/`model`) require operator opt-in via `plugins.entries.<id>.subagent.allowModelOverride: true` in config. Untrusted plugins can still run subagents, but override requests are rejected.
    </Warning>

    `toolsAlsoAllow` adds exact, uniquely owned tools registered by the calling plugin to the worker's normal tool surface. The runtime rejects core tools and names shared with another plugin. Profiles and operator tool policies still apply, including explicit allowlists and denies.

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
    const { nodes } = await api.runtime.nodes.list({ connected: true });

    const result = await api.runtime.nodes.invoke({
      nodeId: "mac-studio",
      command: "my-plugin.command",
      params: { action: "start" },
      timeoutMs: 30000,
    });
    ```

    `nodes.list(...)` includes each connected node's advertised
    `nodePluginTools` descriptors when that node exposes plugin or MCP-backed
    tools to the agent. Those descriptors are live connection state: the Gateway
    drops them when the node disconnects, and a node can replace them with
    `node.pluginTools.update` after local plugin/MCP inventory changes.

    Inside the Gateway this runtime is in-process. In plugin CLI commands it calls the configured Gateway over RPC, so commands such as `openclaw googlemeet recover-tab` can inspect paired nodes from the terminal. Node commands still go through normal Gateway node pairing, command allowlists, plugin node-invoke policies, and node-local command handling.

    Plugins that expose node-hosted agent tools can set `agentTool.defaultPlatforms` for non-dangerous commands that should be allowlisted by default. Omit it when operators must opt in with `gateway.nodes.allowCommands`. Dangerous node-host commands should register a node-invoke policy with `api.registerNodeInvokePolicy(...)`; the policy runs in the Gateway after command allowlist checks and before the command is forwarded to the node, so direct `node.invoke` calls, node-hosted plugin tools, and higher-level plugin tools share the same enforcement path.

    <Warning>
    The optional `scopes` field requests Gateway operator scopes for the invocation. OpenClaw honors it only for bundled plugins and trusted official plugin installations; requests from other plugins do not elevate the call. Use it only when a trusted plugin must invoke a node command with a stricter Gateway scope, such as `operator.admin`.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.tasks">
    Bind Task Flow and Task Run state to an existing OpenClaw session key or trusted tool context.

    - `api.runtime.tasks.managedFlows` is mutation-capable: create, advance, and cancel Task Flows.
    - `api.runtime.tasks.flows` and `api.runtime.tasks.runs` are read-only DTO views for listing and status lookups; both expose `bindSession(...)` / `fromToolContext(...)` plus `get`, `list`, `findLatest`, and `resolve`.

    Task Flow tracks durable multi-step workflow state. It is not a scheduler:
    use Cron or `api.session.workflow.scheduleSessionTurn(...)` for future
    wakeups, then use `managedFlows` from the scheduled turn when that work
    needs flow state, child tasks, waits, or cancellation.

    ```typescript
    const taskFlow = api.runtime.tasks.managedFlows.fromToolContext(ctx);

    const created = taskFlow.createManaged({
      controllerId: "my-plugin/review-batch",
      goal: "Review new pull requests",
    });

    const child = taskFlow.runTask({
      flowId: created.flowId,
      runtime: "acp",
      childSessionKey: "agent:main:subagent:reviewer",
      task: "Review PR #123",
      status: "running",
      startedAt: Date.now(),
    });

    const waiting = taskFlow.setWaiting({
      flowId: created.flowId,
      expectedRevision: created.revision,
      currentStep: "await-human-reply",
      waitJson: { kind: "reply", channel: "telegram" },
    });
    ```

    Use `bindSession({ sessionKey, requesterOrigin })` when you already have a trusted OpenClaw session key from your own binding layer. Do not bind from raw user input.

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

    Uses core `messages.tts` configuration and provider selection. Returns PCM audio buffer + sample rate. `textToSpeechStream` is also available for streaming synthesis.

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
    await api.runtime.system.enqueueSystemEvent(event);
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

    `runHeartbeatOnce(...)` runs a single heartbeat cycle immediately, bypassing the normal coalesce timer. Pass `{ heartbeat: { target: "last" } }` to force delivery to the last active channel instead of the default `target: "none"` suppression.

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

    await api.runtime.state.withLease(
      {
        namespace: "my-feature",
        key: "writer",
        database: { scope: "agent", agentId },
        leaseMs: 5 * 60_000,
        waitMs: 30_000,
      },
      async ({ signal, assertOwned }) => {
        await runExternalWriter({ signal });
        assertOwned();
      },
    );
    ```

    Keyed stores survive restarts and are isolated by the runtime-bound plugin id. Use `registerIfAbsent(...)` for atomic dedupe claims: it returns `true` when the key was missing or expired and registered, or `false` when a live value already exists without overwriting its value, creation time, or TTL. Use `deleteIf(...)` when cleanup must remove only the value previously observed; its synchronous predicate and deletion run in one SQLite transaction. Limits: `maxEntries` per namespace, 50,000 live rows per plugin, JSON values under 64KB, and optional TTL expiry. By default, a write at either row limit sheds the oldest live rows from the namespace being written; sibling namespaces are not evicted for that write, and the write still fails if the namespace cannot free enough rows. Set `overflowPolicy: "reject-new"` for durable ownership records that must never be evicted: new keys fail at either limit, while existing keys remain updateable.

    `openSyncKeyedStore<T>(...)` returns the same store shape with synchronous methods (`register`, `registerIfAbsent`, `deleteIf`, `lookup`, `consume`, `clear` all return values directly instead of promises) for callers that cannot await.

    `openBlobStore<TMetadata>(...)` stores bounded binary payloads in shared SQLite without base64 or file sidecars. It requires per-entry, per-namespace byte, and row limits; copies byte arrays at the API boundary; and lists metadata without loading every BLOB. `register(...)` is an explicit upsert, including for expired keys. `registerIfAbsent(...)` provides collision-safe creation: an expired key remains occupied until its owner claims it with `deleteExpiredKey(key)` or `deleteExpired()`, preserving metadata needed to remove related named artifacts after the SQLite commit. Any row with a TTL is transient and excluded from backup/restore even before it expires; omit TTL for durable, restorable state. Host fuses cap each BLOB at 100 MiB, each plugin at 512 MiB of physically stored BLOBs, and each plugin at 50,000 physically stored rows, including expired rows awaiting owner cleanup. Use `registerIfAbsent(...)` with `overflowPolicy: "reject-new"` when external materializations must not be silently orphaned by replacement or eviction.

    `openChannelIngressQueue<TPayload>(...)` opens a persisted ingress queue scoped to the calling plugin, for buffering inbound events that need at-least-once processing across restarts. When stale-claim recovery uses `shouldRecover`, also provide `shouldRecoverCorrupt` if corrupt claimed payloads should be quarantined: its payload-independent claim identity lets the plugin preserve live owner and lane policy before the queue tombstones the row.

    `withLease(...)` serializes cooperative plugin work across OpenClaw processes. Choose `database: { scope: "shared" }` for one global owner or `{ scope: "agent", agentId }` for independent per-agent ownership. Forward the callback's `AbortSignal` into every fallible operation. `assertOwned()` is a point-in-time checkpoint before starting another important step; the host also verifies ownership after the callback. Lease loss or caller cancellation aborts the signal. Acquisition waits and heartbeats happen outside short synchronous SQLite transactions; plugins never receive database paths or handles. This is cooperative cancellation, not a fencing token or authorization for unfenced external writes.

    `openChannelIngressDrain(...)` opens the core channel-agnostic worker over that queue (or creates a queue when none is supplied). The drain owns stale-claim recovery, per-lane claim serialization, complete-at-adoption or complete-on-dispatch-return, retry/dead-letter disposition, optional pre-adoption supersede, and claim→adoption stall timeout. Wire claim ownership into reply generation with `turnAdoptionLifecycle` (via `bindIngressLifecycleToReplyOptions` from `plugin-sdk/channel-outbound`). Channel plugins keep accept-side enqueue, lane derivation, non-retryable classification, and any supersede authorization policy.

    <Warning>
    `openBlobStore`, `openKeyedStore`, `openSyncKeyedStore`, `withLease`, `openChannelIngressQueue`, and `openChannelIngressDrain` are available only to bundled plugins and trusted official plugin installations in this release.
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
