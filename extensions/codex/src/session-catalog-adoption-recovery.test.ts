// Codex supervision tests cover passive listing and safe local session takeover.
/* oxlint-disable typescript/unbound-method -- assertions inspect vi.fn-backed object methods, not unbound class methods. */
import { describe, expect, it, vi } from "vitest";
import {
  transcriptMirrorMocks,
  continueLocalCodexSession,
  config,
  idleThread,
  createEligibleControl,
  adoptedEntry,
  supervisionSessionInputKey,
  supervisionSessionKey,
  seedSupervisionBinding,
  interruptedAdoptionEntry,
  createRuntime,
  createGatewayApi,
  resolveStorePath,
  sessionBindingIdentity,
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-catalog.test-helpers.js";

describe("Codex supervision actions", () => {
  it("recovers the same pending session after a restart before binding commit", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-before-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries, createSessionEntry } = createRuntime({
      entries: crashedRuntime.entries,
    });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "forked" });

    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        key: supervisionSessionInputKey("thread-1"),
        recoverMatchingInitialEntry: true,
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry).toMatchObject({
      sessionId,
      pluginExtensions: {
        codex: {
          supervision: { sourceThreadId: "thread-1", modelLocked: true },
        },
      },
    });
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: resolveStorePath(undefined, { agentId: "main" }),
        sessionId,
        sessionKey,
      }),
    );
    expect(
      bindingStore.read(sessionBindingIdentity({ sessionId, sessionKey, config })),
    ).toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
  });

  it("recovers the same pending session after a restart following binding commit", async () => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-after-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries, createSessionEntry } = createRuntime({
      entries: crashedRuntime.entries,
    });
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
    await inner.mutate(identity, {
      kind: "set",
      if: { kind: "absent" },
      binding: {
        threadId: "thread-1",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-1",
        cwd: "/workspace/project",
        historyCoveredThrough: new Date().toISOString(),
        conversationSourceTransferComplete: true,
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-1",
          connectionFingerprint: "catalog-connection",
        },
      },
    });
    const mutate = vi.fn(inner.mutate);
    const bindingStore: CodexAppServerBindingStore = { ...inner, mutate };

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "forked" });

    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry.sessionId).toBe(sessionId);
    expect(entries[0]?.entry.initializationPending).toBeUndefined();
    expect(entries[0]?.entry.pluginExtensions).toEqual({
      codex: {
        supervision: { sourceThreadId: "thread-1", modelLocked: true },
      },
    });
    expect(mutate).not.toHaveBeenCalled();
    expect(bindingStore.read(identity)).toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
  });

  it.each([
    "a different working directory",
    "a different terminal turn",
    "pending cleanup artifacts",
  ] as const)("rejects recovery against %s in a same-thread binding", async (invalidState) => {
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-interrupted-invalid-binding";
    const crashedRuntime = createRuntime();
    crashedRuntime.entries.push({
      sessionKey,
      entry: interruptedAdoptionEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const { runtime, entries } = createRuntime({ entries: crashedRuntime.entries });
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({ sessionId, sessionKey, config });
    const binding: CodexAppServerThreadBinding = {
      threadId: "thread-1",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      cwd: "/workspace/project",
      historyCoveredThrough: new Date().toISOString(),
      conversationSourceTransferComplete: true,
      preserveNativeModel: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    };
    if (invalidState === "a different working directory") {
      binding.cwd = "/workspace/other";
    } else if (invalidState === "a different terminal turn") {
      binding.pendingSupervisionBranch = {
        sourceThreadId: "thread-1",
        lastTurnId: "turn-other",
      };
    } else {
      binding.pendingSupervisionBranch = {
        sourceThreadId: "thread-1",
        cleanupThreadIds: ["thread-orphan"],
      };
    }
    await bindingStore.mutate(identity, {
      kind: "set",
      if: { kind: "absent" },
      binding,
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).rejects.toThrow("guarded rollback did not complete");
    expect(entries[0]?.entry.initializationPending).toBe(true);
  });

  it("does not infer a terminal boundary from completedAt without a terminal status", async () => {
    const { runtime, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const bindingStore = createCodexTestBindingStore();
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({
          status: { type: "notLoaded" },
          turns: [{ id: "turn-unknown", completedAt: 123, items: [] }],
        }),
      ),
    });

    const result = await continueLocalCodexSession({
      api,
      bindingStore,
      config,
      control,
      threadId: "thread-1",
    });

    expect(result.disposition).toBe("forked");
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ throughTurnId: null, modelProvider: undefined }),
    );
    expect(
      bindingStore.read(
        sessionBindingIdentity({
          sessionId: runtime.agent.session.getSessionEntry({ sessionKey: result.sessionKey })!
            .sessionId,
          sessionKey: result.sessionKey,
          config,
        }),
      ),
    ).toMatchObject({
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-1",
      pendingSupervisionBranch: { sourceThreadId: "thread-1" },
    });
    const binding = bindingStore.read(
      sessionBindingIdentity({
        sessionId: runtime.agent.session.getSessionEntry({ sessionKey: result.sessionKey })!
          .sessionId,
        sessionKey: result.sessionKey,
        config,
      }),
    );
    expect(binding?.pendingSupervisionBranch).not.toHaveProperty("lastTurnId");
  });

  it("restores an archived mapped session without changing its locked generation metadata", async () => {
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-archived";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        archivedAt: 123,
        archivedBy: { type: "human", id: "operator-1" },
        archiveReason: "manual",
        updatedAt: 99,
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control: createEligibleControl(),
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ sessionKey, disposition: "existing" });

    expect(patchSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        readConsistency: "latest",
        preserveActivity: true,
        update: expect.any(Function),
      }),
    );
    expect(entries[0]?.entry).toMatchObject({
      sessionId,
      updatedAt: 99,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      model: "gpt-5.4",
      modelProvider: "openai",
      pluginExtensions: {
        codex: { supervision: { sourceThreadId: "thread-1", modelLocked: true } },
      },
    });
    expect(entries[0]?.entry.archivedAt).toBeUndefined();
    expect(entries[0]?.entry.archivedBy).toBeUndefined();
    expect(entries[0]?.entry.archiveReason).toBeUndefined();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("opens a mapped active bound thread without applying the unadopted idle gate", async () => {
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const control = createEligibleControl({
      readThread: vi.fn(async () =>
        idleThread({
          id: "thread-1-branch",
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
        }),
      ),
    });
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-existing";
    entries.push({
      sessionKey,
      entry: adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      sessionKey,
      disposition: "existing",
    });
    expect(control.readThread).toHaveBeenCalledWith("thread-1-branch", true);
    expect(patchSessionEntry).toHaveBeenCalledOnce();
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it.each([
    { name: "mapped", mapped: true, includeTurns: true },
    { name: "unmapped", mapped: false, includeTurns: true },
  ])(
    "rejects a $name Continue when the fresh read returns a different thread",
    async ({ mapped, includeTurns }) => {
      const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
      const { api } = createGatewayApi(runtime);
      const bindingStore = createCodexTestBindingStore();
      if (mapped) {
        const sessionKey = supervisionSessionKey("thread-1");
        const sessionId = "openclaw-session-existing";
        entries.push({
          sessionKey,
          entry: adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        });
        await seedSupervisionBinding({
          bindingStore,
          sessionId,
          sessionKey,
          sourceThreadId: "thread-1",
        });
      }
      const control = createEligibleControl({
        readThread: vi.fn(async () => idleThread({ id: "different-thread", source: "cli" })),
      });

      await expect(
        continueLocalCodexSession({
          api,
          bindingStore,
          config,
          control,
          threadId: "thread-1",
        }),
      ).rejects.toThrow("returned a different thread than requested");

      expect(control.readThread).toHaveBeenCalledWith(
        mapped ? "thread-1-branch" : "thread-1",
        includeTurns,
      );
      expect(createSessionEntry).not.toHaveBeenCalled();
      expect(patchSessionEntry).not.toHaveBeenCalled();
      expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a mapped session generation changes before restore", async () => {
    const { runtime, entries, createSessionEntry, patchSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const sessionKey = supervisionSessionKey("thread-1");
    const sessionId = "openclaw-session-stale";
    entries.push({
      sessionKey,
      entry: {
        ...adoptedEntry({ sourceThreadId: "thread-1", sessionId }),
        archivedAt: 123,
      },
    });
    const bindingStore = createCodexTestBindingStore();
    await seedSupervisionBinding({
      bindingStore,
      sessionId,
      sessionKey,
      sourceThreadId: "thread-1",
    });
    const control = createEligibleControl({
      readThread: vi.fn(async () => {
        const entry = entries[0]?.entry;
        if (!entry) {
          throw new Error("missing mapped session");
        }
        entry.sessionId = "openclaw-session-replacement";
        return idleThread({ id: "thread-1-branch" });
      }),
    });

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("changed before it could be opened");
    expect(patchSessionEntry).toHaveBeenCalledOnce();
    expect(entries[0]?.entry.archivedAt).toBe(123);
    expect(entries[0]?.entry.modelSelectionLocked).toBe(true);
    expect(createSessionEntry).not.toHaveBeenCalled();
  });

  it("rolls back the session when its pending binding cannot be committed", async () => {
    const { runtime, entries, createSessionEntry } = createRuntime();
    const { api } = createGatewayApi(runtime);
    const inner = createCodexTestBindingStore();
    let rejectBinding = true;
    const mutate = vi.fn(async (...args: Parameters<CodexAppServerBindingStore["mutate"]>) => {
      if (rejectBinding && args[1].kind === "set") {
        rejectBinding = false;
        return false;
      }
      return await inner.mutate(...args);
    });
    const bindingStore: CodexAppServerBindingStore = { ...inner, mutate };
    const control = createEligibleControl();

    await expect(
      continueLocalCodexSession({
        api,
        bindingStore,
        config,
        control,
        threadId: "thread-1",
      }),
    ).rejects.toThrow("Codex session binding changed during initialization");
    expect(entries).toEqual([]);
    expect(createSessionEntry).toHaveBeenCalledOnce();
    expect(transcriptMirrorMocks.importCodexThreadHistoryToTranscript).toHaveBeenCalledOnce();
    expect(control.archiveThread).not.toHaveBeenCalled();
  });
});
