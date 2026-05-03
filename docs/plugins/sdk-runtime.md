---
summary: "api.runtime -- the injected runtime helpers available to plugins"
title: "Plugin runtime helpers"
sidebarTitle: "Runtime helpers"
read_when:
  - You need to call core helpers from a plugin (TTS, STT, image gen, web search, subagent, nodes)
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

## Config Loading And Writes

Prefer config that was already passed into the active call path, for example `api.config` during registration or a `cfg` argument on channel/provider callbacks. This keeps one process snapshot flowing through the work instead of reparsing config on hot paths.

Use `api.runtime.config.current()` only when a long-lived handler needs the current process snapshot and no config was passed to that function. The returned value is readonly; clone or use a mutation helper before editing.

Tool factories receive `ctx.runtimeConfig` plus `ctx.getRuntimeConfig()`. Use the getter inside a long-lived tool's `execute` callback when config can change after the tool definition was created.

Persist changes with `api.runtime.config.mutateConfigFile(...)` or `api.runtime.config.replaceConfigFile(...)`. Each write must choose an explicit `afterWrite` policy:

- `afterWrite: { mode: "auto" }` lets the gateway reload planner decide.
- `afterWrite: { mode: "restart", reason: "..." }` forces a clean restart when the writer knows hot reload is unsafe.
- `afterWrite: { mode: "none", reason: "..." }` suppresses automatic reload/restart only when the caller owns the follow-up.

The mutation helpers return `afterWrite` plus a typed `followUp` summary so callers can log or test whether they requested a restart. The gateway still owns when that restart actually happens.

`api.runtime.config.loadConfig()` and `api.runtime.config.writeConfigFile(...)` are deprecated compatibility helpers under `runtime-config-load-write`. They warn once at runtime, and remain available for old external plugins during the migration window. Bundled plugins must not use them; the config boundary guards fail if plugin code calls them or imports those helpers from plugin SDK subpaths.

For direct SDK imports, use the focused config subpaths instead of the broad
`openclaw/plugin-sdk/config-runtime` compatibility barrel: `config-types` for
types, `plugin-config-runtime` for already-loaded config assertions and plugin
entry lookup, `runtime-config-snapshot` for current process snapshots, and
`config-mutation` for writes. Bundled plugin tests should mock these focused
subpaths directly instead of mocking the broad compatibility barrel.

Internal OpenClaw runtime code has the same direction: load config once at the CLI, gateway, or process boundary, then pass that value through. Successful mutation writes refresh the process runtime snapshot and advance its internal revision; long-lived caches should key off the runtime-owned cache key instead of serializing config locally. Long-lived runtime modules have a zero-tolerance scanner for ambient `loadConfig()` calls; use a passed `cfg`, a request `context.getRuntimeConfig()`, or `getRuntimeConfig()` at an explicit process boundary.

Provider and channel execution paths must use the active runtime config snapshot, not a file snapshot returned for config readback or editing. File snapshots preserve source values such as SecretRef markers for UI and writes; provider callbacks need the resolved runtime view. When a helper may be called with either the active source snapshot or the active runtime snapshot, route through `selectApplicableRuntimeConfig()` before reading credentials.

## Runtime namespaces

<AccordionGroup>
  <Accordion title="api.runtime.agent">
    Agent identity, directories, and session management.

    ```typescript
    // Resolve the agent's working directory
    const agentDir = api.runtime.agent.resolveAgentDir(cfg);

    // Resolve agent workspace
    const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg);

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
    const agentDir = api.runtime.agent.resolveAgentDir(cfg);
    const result = await api.runtime.agent.runEmbeddedAgent({
      sessionId: "my-plugin:task-1",
      runId: crypto.randomUUID(),
      sessionFile: path.join(agentDir, "sessions", "my-plugin-task-1.jsonl"),
      workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg),
      prompt: "Summarize the latest changes",
      timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(cfg),
    });
    ```

    `runEmbeddedAgent(...)` is the neutral helper for starting a normal OpenClaw agent turn from plugin code. It uses the same provider/model resolution and agent-harness selection as channel-triggered replies.

    `runEmbeddedPiAgent(...)` remains as a compatibility alias.

    `resolveThinkingPolicy(...)` returns the provider/model's supported thinking levels and optional default. Provider plugins own the model-specific profile through their thinking hooks, so tool plugins should call this runtime helper instead of importing or duplicating provider lists.

    `normalizeThinkingLevel(...)` converts user text such as `on`, `x-high`, or `extra high` to the canonical stored level before checking it against the resolved policy.

    **Session store helpers** are under `api.runtime.agent.session`:

    ```typescript
    const storePath = api.runtime.agent.session.resolveStorePath(cfg);
    const store = api.runtime.agent.session.loadSessionStore(storePath);
    await api.runtime.agent.session.updateSessionStore(storePath, (nextStore) => {
      // Patch one entry without replacing the whole file from stale state.
      nextStore[sessionKey] = { ...nextStore[sessionKey], thinkingLevel: "high" };
    });
    const filePath = api.runtime.agent.session.resolveSessionFilePath(cfg, sessionId);
    ```

    Prefer `updateSessionStore(...)` or `updateSessionStoreEntry(...)` for runtime writes. They route through the Gateway-owned session-store writer, preserve concurrent updates, and reuse the hot cache. `saveSessionStore(...)` remains available for compatibility and offline maintenance-style rewrites.

  </Accordion>
  <Accordion title="api.runtime.agent.defaults">
    Default model and provider constants:

    ```typescript
    const model = api.runtime.agent.defaults.model; // e.g. "anthropic/claude-sonnet-4-6"
    const provider = api.runtime.agent.defaults.provider; // e.g. "anthropic"
    ```

  </Accordion>
  <Accordion title="api.runtime.subagent">
    Launch and manage background subagent runs.

    ```typescript
    // Start a subagent run
    const { runId } = await api.runtime.subagent.run({
      sessionKey: "agent:main:subagent:search-helper",
      message: "Expand this query into focused follow-up searches.",
      provider: "openai", // optional override
      model: "gpt-4.1-mini", // optional override
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

    `deleteSession(...)` can delete sessions created by the same plugin through `api.runtime.subagent.run(...)`. Deleting arbitrary user or operator sessions still requires an admin-scoped Gateway request.

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

    Inside the Gateway this runtime is in-process. In plugin CLI commands it calls the configured Gateway over RPC, so commands such as `openclaw googlemeet recover-tab` can inspect paired nodes from the terminal. Node commands still go through normal Gateway node pairing, command allowlists, plugin node-invoke policies, and node-local command handling.

    Plugins that expose dangerous node-host commands should register a node-invoke policy with `api.registerNodeInvokePolicy(...)`. The policy runs in the Gateway after command allowlist checks and before the command is forwarded to the node, so direct `node.invoke` calls and higher-level plugin tools share the same enforcement path.

  </Accordion>
  <Accordion title="api.runtime.tasks.managedFlows">
    Bind a Task Flow runtime to an existing OpenClaw session key or trusted tool context, then create and manage Task Flows without passing an owner on every call.

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

    Uses core `messages.tts` configuration and provider selection. Returns PCM audio buffer + sample rate.

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
    ```

    Returns `{ text: undefined }` when no output is produced (e.g. skipped input).

    <Info>
    `api.runtime.stt.transcribeAudioFile(...)` remains as a compatibility alias for `api.runtime.mediaUnderstanding.transcribeAudioFile(...)`.
    </Info>

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
    const output = await api.runtime.system.runCommandWithTimeout(cmd, args, opts);
    const hint = api.runtime.system.formatNativeDependencyHint(pkg);
    ```

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
    const value = await store.lookup("key-1");
    await store.consume("key-1");
    await store.clear();
    ```

    Keyed stores survive restarts and are isolated by the runtime-bound plugin id. Limits: `maxEntries` per namespace, 1,000 live rows per plugin, JSON values under 64KB, and optional TTL expiry.

    <Warning>
    Bundled plugins only in this release.
    </Warning>

  </Accordion>
  <Accordion title="api.runtime.tools">
    Memory tool factories and CLI.

    ```typescript
    const getTool = api.runtime.tools.createMemoryGetTool(/* ... */);
    const searchTool = api.runtime.tools.createMemorySearchTool(/* ... */);
    api.runtime.tools.registerMemoryCli(/* ... */);
    ```

  </Accordion>
  <Accordion title="api.runtime.channel">
    Channel-specific runtime helpers (available when a channel plugin is loaded).

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

    `api.runtime.channel.mentions` intentionally does not expose the older `resolveMentionGating*` compatibility helpers. Prefer the normalized `{ facts, policy }` path.

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
  Current load mode; `"setup-runtime"` is the lightweight pre-full-entry startup/setup window.
</ParamField>
<ParamField path="api.resolvePath(input)" type="(string) => string">
  Resolve a path relative to the plugin root.
</ParamField>

## Related

- [Plugin internals](/plugins/architecture) — capability model and registry
- [SDK entry points](/plugins/sdk-entrypoints) — `definePluginEntry` options
- [SDK overview](/plugins/sdk-overview) — subpath reference
