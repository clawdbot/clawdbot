// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  createCodexSessionCatalogControlFactory,
  fs,
  os,
  path,
  tempDirs,
  transcriptMirrorMocks,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  listCodexSessionCatalog,
  continueLocalCodexSession,
  config,
  compatibilityOwnerConfig,
  idleThread,
  createControl,
  createEligibleControl,
  adoptedEntry,
  supervisionSessionInputKey,
  supervisionSessionKey,
  seedSupervisionBinding,
  interruptedAdoptionEntry,
  createRuntime,
  archiveTestSession,
  createGatewayApi,
  resolveStorePath,
  sessionBindingIdentity,
  createCodexTestBindingStore,
  type CodexThread,
  type OpenClawConfig,
  type PluginRuntime,
} from "./session-catalog.test-helpers.js";

describe("Codex supervision catalog", () => {
  it("enriches only the local source row with its adopted OpenClaw session", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "source-thread", status: "active", archived: false }],
      })),
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({
        sessions: [{ threadId: "source-thread", status: "idle", archived: false }],
      }),
    }));
    const { runtime, entries } = createRuntime({
      nodes: [
        {
          nodeId: "devbox",
          connected: true,
          commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
        },
      ],
      invoke,
    });
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: adoptedEntry({
        sourceThreadId: "source-thread",
        sessionId,
      }),
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
    });

    const result = await listCodexSessionCatalog({
      bindingStore,
      config,
      runtime,
      control,
    });

    expect(result.hosts[0]?.sessions[0]).toMatchObject({
      threadId: "source-thread",
      sessionKey,
    });
    expect(result.hosts[1]?.sessions[0]).toEqual({
      threadId: "source-thread",
      status: "idle",
      archived: false,
    });
  });

  it("does not expose an adopted marker while generic initialization remains pending", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [{ threadId: "source-thread", status: "idle", archived: false }],
      })),
    });
    const { runtime, entries } = createRuntime();
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-pending";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "source-thread", sessionId }),
        initializationPending: true,
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
      pending: true,
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions[0]).not.toHaveProperty("sessionKey");
  });

  it("ignores a public marker retarget and trusts the private source binding", async () => {
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: [
          { threadId: "source-thread", status: "idle", archived: false },
          { threadId: "forged-thread", status: "idle", archived: false },
        ],
      })),
    });
    const sessionKey = supervisionSessionKey("source-thread");
    const sessionId = "openclaw-session-forged-marker";
    const { runtime, entries } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "forged-thread", sessionId }),
        },
      ],
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "source-thread",
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions).toEqual([
      {
        threadId: "source-thread",
        status: "idle",
        archived: false,
        sessionKey,
      },
      { threadId: "forged-thread", status: "idle", archived: false },
    ]);
    expect(entries[0]?.entry.pluginExtensions).toMatchObject({
      codex: { supervision: { sourceThreadId: "forged-thread" } },
    });
  });

  it("requires both the Codex harness owner and model lock before adopting a session", async () => {
    const sources = [
      {
        threadId: "unlocked-thread",
        sessionId: "openclaw-session-unlocked",
        entryPatch: { modelSelectionLocked: false },
      },
      {
        threadId: "wrong-harness-thread",
        sessionId: "openclaw-session-wrong-harness",
        entryPatch: { agentHarnessId: "other-harness" },
      },
    ];
    const entries = sources.map(({ threadId, sessionId, entryPatch }) => ({
      sessionKey: supervisionSessionKey(threadId),
      entry: { ...adoptedEntry({ sourceThreadId: threadId, sessionId }), ...entryPatch },
    }));
    const { runtime, createSessionEntry } = createRuntime({ entries });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    for (const source of sources) {
      await seedSupervisionBinding({
        bindingStore,
        sessionId: source.sessionId,
        sessionKey: supervisionSessionKey(source.threadId),
        sourceThreadId: source.threadId,
      });
    }
    const control = createControl({
      listPage: vi.fn(async () => ({
        sessions: sources.map(({ threadId }) => ({
          threadId,
          status: "idle",
          source: "cli",
          archived: false as const,
        })),
      })),
      readThread: vi.fn(async (threadId: string) => idleThread({ id: threadId, source: "cli" })),
    });

    const result = await listCodexSessionCatalog({ bindingStore, config, runtime, control });

    expect(result.hosts[0]?.sessions).toHaveLength(sources.length);
    for (const source of sources) {
      const session = result.hosts[0]?.sessions.find(
        (candidate) => candidate.threadId === source.threadId,
      );
      expect(session).toBeDefined();
      expect(session).not.toHaveProperty("sessionKey");
    }
    for (const source of sources) {
      await expect(
        continueLocalCodexSession({
          api,
          bindingStore,
          config,
          control,
          threadId: source.threadId,
        }),
      ).rejects.toThrow("does not match its trusted recovery state");
    }
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
  });
});

describe("Codex supervision actions", () => {
  it("imports an exact local source when broad native listing times out", async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-exact-import-")));
    tempDirs.push(home);
    const sessionsRoot = path.join(home, "sessions");
    await fs.mkdir(sessionsRoot);
    const rollout = path.join(sessionsRoot, "source.jsonl");
    await fs.writeFile(
      rollout,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "thread-source",
          source: "cli",
          originator: "codex_cli_rs",
        },
      })}\n`,
    );
    const sourceThread = idleThread({
      id: "thread-source",
      source: "cli",
      path: rollout,
      turns: [],
    });
    let indexed = false;
    pinnedConnectionMocks.request.mockImplementation(async ({ method, requestParams }) => {
      if (method === "thread/read") {
        indexed = true;
        return { thread: sourceThread };
      }
      if (method === "thread/list" && requestParams.useStateDbOnly === true) {
        return { data: indexed ? [sourceThread] : [] };
      }
      throw new Error("thread/list timed out");
    });
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({}),
      getRuntimeConfig: () => config,
      env: { CODEX_HOME: home },
    });
    const source = factory.homesForAgent("main")[0]!;
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    await expect(
      continueLocalCodexSession({
        api,
        bindingStore: createCodexTestBindingStore(),
        config,
        control: factory.forRequest("main", source),
        threadId: sourceThread.id,
        sourceHomeId: source.sourceHomeId,
      }),
    ).resolves.toMatchObject({ disposition: "forked" });
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ thread: sourceThread }),
    );
    expect(pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method)).toEqual([
      "thread/read",
      "thread/list",
      "thread/read",
    ]);
  });

  it("lists and adopts a local session under the retained compatibility owner", async () => {
    const runtimeConfig = compatibilityOwnerConfig();
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const continued = await continueLocalCodexSession({
      api,
      bindingStore,
      config: runtimeConfig,
      control,
      threadId: "thread-1",
    });
    const listed = await listCodexSessionCatalog({
      bindingStore,
      config: runtimeConfig,
      runtime,
      control,
    });

    expect(continued.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "alpha", cfg: runtimeConfig }),
    );
    expect(listed.hosts[0]?.sessions[0]).toMatchObject({
      threadId: "thread-1",
      sessionKey: continued.sessionKey,
    });
  });

  it("creates one pending locked branch and reuses its source mapping", async () => {
    const sourceThread = idleThread({
      modelProvider: "openai",
      turns: [
        { id: "turn-completed", status: "completed", items: [] },
        { id: "turn-failed", status: "failed", items: [] },
        { id: "turn-active", status: "inProgress", items: [] },
      ],
    });
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({ readThread: vi.fn(async () => sourceThread) });
    const baselines: Array<{
      connectionFingerprint: string;
      turnId: string | null;
      userMessageCount: number;
    }> = [];

    const first = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
      onContinued: (baseline) => baselines.push(baseline),
    });
    const second = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
      onContinued: (baseline) => baselines.push(baseline),
    });

    expect(first).toEqual({
      sessionKey: expect.stringMatching(/^agent:main:harness:codex:supervision:[0-9a-f]{64}$/),
      disposition: "forked",
    });
    expect(second).toEqual({ sessionKey: first.sessionKey, disposition: "existing" });
    expect(baselines).toEqual([
      {
        connectionFingerprint: "catalog-connection",
        // Marker baseline includes the active turn; history import below still
        // stops at the last terminal turn.
        turnId: "turn-active",
        userMessageCount: 0,
      },
      {
        connectionFingerprint: "catalog-connection",
        turnId: "turn-active",
        userMessageCount: 0,
      },
    ]);
    expect(control.withPinnedConnection).toHaveBeenCalledTimes(2);
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: config,
        key: supervisionSessionInputKey("thread-1"),
        displayName: "Continue native task",
        spawnedCwd: "/workspace/project",
        afterCreate: expect.any(Function),
        initialEntry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              supervision: {
                sourceThreadId: "thread-1",
                initializing: true,
                modelLocked: true,
              },
            },
          },
        },
      }),
    );
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith({
      thread: sourceThread,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
      sessionId: "openclaw-session-1",
      sessionKey: first.sessionKey,
      agentId: "main",
      cwd: "/workspace/project",
      throughTurnId: "turn-failed",
      modelProvider: "openai",
      config,
    });
    await expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: "openclaw-session-1",
          sessionKey: first.sessionKey,
          config,
        }),
      ),
    ).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      cwd: "/workspace/project",
      historyCoveredThrough: expect.any(String),
      conversationSourceTransferComplete: true,
      preserveNativeModel: true,
      pendingSupervisionBranch: {
        sourceThreadId: "thread-1",
        connectionFingerprint: "catalog-connection",
        lastTurnId: "turn-failed",
      },
    });
    expect(control.readThread).toHaveBeenCalledTimes(2);
    expect(control.readThread).toHaveBeenNthCalledWith(1, "thread-1", true);
    expect(control.readThread).toHaveBeenNthCalledWith(2, "thread-1", true);
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
  });

  it("does not join concurrent local continues across explicit agent owners", async () => {
    const runtimeConfig = {
      agents: { ownership: "explicit", list: [{ id: "alpha" }, { id: "beta" }] },
    } as OpenClawConfig;
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime, runtimeConfig);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const [alpha, beta] = await Promise.all(
      ["alpha", "beta"].map((agentId) =>
        continueLocalCodexSession({
          agentId,
          api,
          bindingStore,
          config: runtimeConfig,
          control,
          threadId: "thread-1",
        }),
      ),
    );

    if (!alpha || !beta) {
      throw new Error("expected both explicit owners to continue independently");
    }

    expect(alpha.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
    expect(beta.sessionKey).toMatch(/^agent:beta:harness:codex:supervision:/);
    expect(alpha.sessionKey).not.toBe(beta.sessionKey);
    expect(createSessionEntry).toHaveBeenCalledTimes(2);
  });

  it("baselines a re-continued adoption from its bound canonical thread", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-existing";
    const canonicalTurn = {
      id: "turn-canonical",
      status: "completed",
      startedAt: 200,
      items: [
        { id: "user-1", type: "userMessage", text: "first" },
        { id: "user-2", type: "userMessage", text: "second" },
      ],
    } as NonNullable<CodexThread["turns"]>[number];
    const canonicalThread = idleThread({
      id: "thread-1-branch",
      turns: [canonicalTurn],
    });
    const { runtime } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        },
      ],
    });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });
    const control = createEligibleControl({
      readThread: vi.fn(async (threadId: string) =>
        threadId === canonicalThread.id ? canonicalThread : idleThread({ id: threadId }),
      ),
    });
    const baselines: Array<{
      connectionFingerprint: string;
      turnId: string | null;
      userMessageCount: number;
    }> = [];

    await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
      onContinued: (baseline) => baselines.push(baseline),
    });

    expect(control.readThread).toHaveBeenCalledWith("thread-1-branch", true);
    expect(baselines).toEqual([
      {
        connectionFingerprint: "catalog-connection",
        turnId: "turn-canonical",
        userMessageCount: 2,
      },
    ]);
  });

  it("keeps adopted sessions discoverable when the configured default agent changes", async () => {
    const originalConfig = {
      agents: { list: [{ id: "alpha", default: true }, { id: "beta" }] },
    } as OpenClawConfig;
    const changedConfig = {
      agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
    } as OpenClawConfig;
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const created = await continueLocalCodexSession({
      api,
      bindingStore,
      config: originalConfig,
      control,
      threadId: "thread-1",
    });
    const reopened = await continueLocalCodexSession({
      api,
      bindingStore,
      config: changedConfig,
      control,
      threadId: "thread-1",
    });
    const catalog = await listCodexSessionCatalog({
      bindingStore,
      config: changedConfig,
      runtime,
      control,
    });

    expect(created.sessionKey).toMatch(/^agent:alpha:harness:codex:supervision:/);
    expect(reopened).toEqual({ sessionKey: created.sessionKey, disposition: "existing" });
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ agentId: "alpha" }));
    expect(catalog.hosts[0]?.sessions[0]).toMatchObject({
      threadId: "thread-1",
      sessionKey: created.sessionKey,
    });
  });

  it("does not expose or reuse an initializing session while history import is paused", async () => {
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockImplementationOnce(async () => {
      await importGate;
      return { importedMessages: 0, omittedMessages: 0 };
    });
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();

    const firstContinue = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    await vi.waitFor(() => {
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    });

    const duringImport = await listCodexSessionCatalog({ bindingStore, config, runtime, control });
    expect(duringImport.hosts[0]?.sessions[0]).not.toHaveProperty("sessionKey");
    expect(entries[0]?.entry.initializationPending).toBe(true);
    let secondSettled = false;
    const secondContinue = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    }).then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(createSessionEntry).toHaveBeenCalledOnce();

    releaseImport?.();
    const [first, second] = await Promise.all([firstContinue, secondContinue]);
    expect(second).toEqual(first);
    expect(entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
  });

  it("does not archive a source with an interrupted initializing branch", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const { runtime } = createRuntime({
      entries: [
        {
          sessionKey,
          entry: interruptedAdoptionEntry({
            sourceThreadId: "thread-1",
            sessionId: "openclaw-session-initializing",
          }),
        },
      ],
    });
    const control = createEligibleControl();

    await expect(archiveTestSession({ control, runtime })).rejects.toThrow(
      "cannot be archived while its OpenClaw branch is initializing",
    );
    expect(control.readThread).not.toHaveBeenCalled();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });

  it("does not archive a source until its supervised branch materializes", async () => {
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();
    const continued = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    await expect(archiveTestSession({ control, bindingStore, runtime })).rejects.toThrow(
      "cannot be archived until its OpenClaw branch starts",
    );
    expect(control.archiveThread).not.toHaveBeenCalled();

    const identity = sessionBindingIdentity({
      sessionId: "openclaw-session-1",
      sessionKey: continued.sessionKey,
      config,
    });
    const pending = (await bindingStore.read(identity))?.pendingSupervisionBranch;
    if (!pending) {
      throw new Error("expected a pending supervision branch");
    }
    await expect(
      bindingStore.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: pending,
        threadId: "thread-1-branch",
        patch: { model: "gpt-5.4", modelProvider: "openai" },
      }),
    ).resolves.toBe(true);

    await expect(archiveTestSession({ control, bindingStore, runtime })).resolves.toEqual({
      archived: true,
    });
    expect(control.archiveThread).toHaveBeenCalledOnce();
    expect(control.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("serializes archive behind an in-flight Continue and rejects the pending branch", async () => {
    let releaseImport: (() => void) | undefined;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    transcriptMirrorMocks.importCodexThreadHistoryToTranscript.mockImplementationOnce(async () => {
      await importGate;
      return { importedMessages: 0, omittedMessages: 0 };
    });
    const { runtime } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl();
    const continuing = continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });
    await vi.waitFor(() => {
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    });

    let archiveSettled = false;
    const archiving = archiveTestSession({ control, bindingStore, runtime }).then(
      (value) => {
        archiveSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        archiveSettled = true;
        return { ok: false as const, error };
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(archiveSettled).toBe(false);
    expect(control.archiveThread).not.toHaveBeenCalled();

    releaseImport?.();
    await expect(continuing).resolves.toMatchObject({ disposition: "forked" });
    const archiveResult = await archiving;
    expect(archiveResult.ok).toBe(false);
    if (archiveResult.ok) {
      throw new Error("archive unexpectedly succeeded");
    }
    expect(archiveResult.error).toBeInstanceOf(Error);
    expect((archiveResult.error as Error).message).toContain(
      "cannot be archived until its OpenClaw branch starts",
    );
    expect(control.archiveThread).not.toHaveBeenCalled();
  });
});
