/** Tests ACP manager session initialization limits and persisted runtime options. */
import { describe, expect, it, vi } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createDeferred,
  createRuntime,
  expectRecordFields,
  extractRuntimeOptionsFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager initializeSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("persists runtime options provided during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta({
        runtimeOptions: {
          model: "openai/gpt-5.4",
          thinking: "high",
        },
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "openai/gpt-5.4",
        thinking: "high",
      },
    });

    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        model: "openai/gpt-5.4",
        thinking: "high",
      },
    ]);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-a",
      model: "openai/gpt-5.4",
      thinking: "high",
    });
  });

  it("preserves runtimeOptions cwd when initializeSession cwd is omitted", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      storeSessionKey: "agent:codex:acp:session-cwd-runtime-options",
      acp: readySessionMeta({
        runtimeOptions: {
          cwd: "/workspace/from-runtime-options",
        },
        cwd: "/workspace/from-runtime-options",
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        cwd: "/workspace/from-runtime-options",
      },
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      cwd: "/workspace/from-runtime-options",
    });
    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        cwd: "/workspace/from-runtime-options",
      },
    ]);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("disk full");
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "init-meta-failed",
    });
    expectRecordFields(closeInput.handle, {
      sessionKey: "agent:codex:acp:session-1",
    });
  });

  it("does not let reset-superseded initialization republish a stale runtime handle", async () => {
    const runtimeState = createRuntime();
    const releaseOldInit = createDeferred();
    let ensureCount = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const callNumber = ++ensureCount;
      if (callNumber === 1) {
        await releaseOldInit.promise;
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    let persistedMeta: SessionAcpMeta | undefined;
    hoisted.readAcpSessionEntryMock.mockImplementation((input: unknown) => {
      if (!persistedMeta) {
        return null;
      }
      const sessionKey = (input as { sessionKey: string }).sessionKey;
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "child-1", updatedAt: Date.now(), acp: persistedMeta },
        acp: persistedMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (input: unknown) => {
      const params = input as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = persistedMeta;
      const entry = current
        ? { sessionId: "child-1", updatedAt: Date.now(), acp: current }
        : undefined;
      const next = params.mutate(current, entry);
      persistedMeta = next ?? undefined;
      if (!next) {
        return null;
      }
      return {
        sessionKey: params.sessionKey,
        storeSessionKey: params.sessionKey,
        entry: { sessionId: "child-1", updatedAt: Date.now(), acp: next },
        acp: next,
      };
    });

    const manager = new AcpSessionManager();
    const sessionKey = "agent:codex:acp:child-1";
    const staleInitialization = manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    await vi.waitFor(() => {
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    });

    await manager.forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    const fresh = await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    expect(fresh.handle.runtimeSessionName).toBe("runtime-2");

    releaseOldInit.resolve();
    await expect(staleInitialization).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(persistedMeta?.runtimeSessionName).toBe("runtime-2");
    expectRecordFields(mockCallArg(runtimeState.close), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-1" }),
      reason: "session-actor-superseded",
      discardPersistentState: true,
    });

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "follow-up turn",
      mode: "prompt",
      requestId: "follow-up-turn",
    });
    expect(ensureCount).toBe(2);
    expectRecordFields(mockCallArg(runtimeState.runTurn), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
    });
  });
});
