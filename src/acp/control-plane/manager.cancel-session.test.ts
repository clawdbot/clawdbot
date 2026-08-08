/** Tests ACP manager cancellation of active turns and idle sessions. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import {
  AcpSessionManager,
  baseCfg,
  createDeferred,
  createRuntime,
  expectRecordFields,
  extractStatesFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager cancelSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("preempts an active turn on cancel and returns to idle state", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: "agent:codex:acp:child-1",
        parentSessionKey: "agent:main:main",
      });

      let enteredRun = false;
      runtimeState.runTurn.mockImplementation(async function* (input: { signal?: AbortSignal }) {
        enteredRun = true;
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done" as const, stopReason: "cancel" };
      });

      const manager = new AcpSessionManager();
      const events: AcpRuntimeEvent[] = [];
      const runPromise = manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        text: "long task",
        mode: "prompt",
        requestId: "run-1",
        onEvent: (event) => {
          events.push(event);
        },
      });
      await vi.waitFor(
        () => {
          expect(enteredRun).toBe(true);
        },
        { interval: 1 },
      );

      await manager.cancelSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:child-1",
        reason: "manual-cancel",
      });
      await runPromise;

      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(runtimeState.cancel), {
        reason: "manual-cancel",
      });
      expectRecordFields(requireTaskByRunId("run-1"), {
        ownerKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:child-1",
        status: "cancelled",
      });
      expect(events.at(-1)).toEqual({
        type: "done",
        status: "cancelled",
        stopReason: "cancel",
      });
      const states = extractStatesFromUpserts();
      expect(states).toContain("running");
      expect(states).toContain("idle");
      expect(states).not.toContain("error");
    });
  });

  it("force-discards stuck cancel and close operations without stale state writes", async () => {
    const runtimeState = createRuntime();
    const stuckCancel = createDeferred();
    let ensureCount = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      ensureCount += 1;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${ensureCount}`,
        backendSessionId: `backend-${ensureCount}`,
      };
    });
    runtimeState.cancel.mockImplementation(async () => await stuckCancel.promise);
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
          current: typeof persistedMeta,
          entry: { sessionId: string; updatedAt: number; acp?: typeof persistedMeta },
        ) => typeof persistedMeta | null | undefined;
      };
      const entry = {
        sessionId: "child-1",
        updatedAt: Date.now(),
        ...(persistedMeta ? { acp: persistedMeta } : {}),
      };
      persistedMeta = params.mutate(persistedMeta, entry) ?? undefined;
      return {
        sessionKey: params.sessionKey,
        storeSessionKey: params.sessionKey,
        entry: { ...entry, ...(persistedMeta ? { acp: persistedMeta } : {}) },
        acp: persistedMeta,
      };
    });

    const manager = new AcpSessionManager();
    const sessionKey = "agent:codex:acp:child-1";
    const initialize = async () =>
      await manager.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent: "codex",
        mode: "persistent",
      });
    const first = await initialize();
    const cancelPromise = manager.cancelSession({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    await vi.waitFor(() => {
      expect(runtimeState.cancel).toHaveBeenCalledTimes(1);
    });

    const stuckDiscardClose = createDeferred();
    runtimeState.close.mockImplementationOnce(async () => await stuckDiscardClose.promise);
    const forceDiscardResult = vi.fn();
    void manager
      .forceDiscardSessionRuntime({
        cfg: baseCfg,
        sessionKey,
        reason: "session-reset",
      })
      .then(
        () => forceDiscardResult("resolved"),
        () => forceDiscardResult("rejected"),
      );
    await vi.waitFor(() => expect(forceDiscardResult).toHaveBeenCalledWith("resolved"));
    expect(runtimeState.close).toHaveBeenCalledWith({
      handle: first.handle,
      reason: "session-reset",
      discardPersistentState: true,
    });

    const second = await initialize();
    expect(second.handle.runtimeSessionName).toBe("runtime-2");
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    stuckDiscardClose.resolve();
    await Promise.resolve();

    const upsertsBeforeStaleCancelSettles = hoisted.upsertAcpSessionMetaMock.mock.calls.length;

    stuckCancel.resolve();
    await cancelPromise;
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(upsertsBeforeStaleCancelSettles);

    const stuckClose = createDeferred();
    runtimeState.close.mockImplementationOnce(async () => await stuckClose.promise);
    const closePromise = manager.closeSession({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
      discardPersistentState: true,
    });
    await vi.waitFor(() => {
      expect(runtimeState.close).toHaveBeenCalledTimes(2);
    });

    await manager.forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    const third = await initialize();
    expect(third.handle.runtimeSessionName).toBe("runtime-3");
    const upsertsBeforeStaleCloseSettles = hoisted.upsertAcpSessionMetaMock.mock.calls.length;

    stuckClose.resolve();
    await closePromise;
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(upsertsBeforeStaleCloseSettles);
  });

  it("does not let a superseded runtime initializer overwrite a fresh handle", async () => {
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

    let persistedMeta: SessionAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "persisted-runtime",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((input: unknown) => {
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
          entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta },
        ) => SessionAcpMeta | null | undefined;
      };
      const entry = {
        sessionId: "child-1",
        updatedAt: Date.now(),
        acp: persistedMeta,
      };
      const next = params.mutate(persistedMeta, entry);
      if (next) {
        persistedMeta = next;
      }
      return {
        sessionKey: params.sessionKey,
        storeSessionKey: params.sessionKey,
        entry: { ...entry, ...(next ? { acp: next } : {}) },
        acp: next ?? persistedMeta,
      };
    });

    const manager = new AcpSessionManager();
    const sessionKey = "agent:codex:acp:child-1";
    const staleTurn = manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "old turn",
      mode: "prompt",
      requestId: "old-turn",
    });
    await vi.waitFor(() => {
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    });

    await manager.forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "fresh turn",
      mode: "prompt",
      requestId: "fresh-turn",
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.runTurn), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
    });

    const upsertsBeforeOldInitSettles = hoisted.upsertAcpSessionMetaMock.mock.calls.length;
    releaseOldInit.resolve();
    await expect(staleTurn).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(upsertsBeforeOldInitSettles);
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
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.runTurn, 1), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
    });
  });

  it("does not retry runtime initialization after reset supersedes a turn", async () => {
    const runtimeState = createRuntime();
    const releaseTurnFailure = createDeferred();
    let ensureCount = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const callNumber = ++ensureCount;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    runtimeState.runTurn.mockImplementationOnce(async function* () {
      await releaseTurnFailure.promise;
      yield { type: "error" as const, message: "acpx exited with code 1" };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:child-1";
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      entry: { sessionId: "child-1", updatedAt: Date.now() },
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    const staleTurn = manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "old turn",
      mode: "prompt",
      requestId: "old-turn",
    });
    await vi.waitFor(() => {
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
    });

    await manager.forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    releaseTurnFailure.resolve();

    await expect(staleTurn).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(runtimeState.close), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-1" }),
      reason: "session-reset",
      discardPersistentState: true,
    });
  });

  it("does not register a turn after reset supersedes runtime controls", async () => {
    const runtimeState = createRuntime();
    const releaseControls = createDeferred();
    let ensureCount = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const callNumber = ++ensureCount;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    runtimeState.getCapabilities.mockImplementationOnce(async () => {
      await releaseControls.promise;
      return {
        controls: ["session/set_mode", "session/set_config_option", "session/status"],
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:child-1";
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      entry: { sessionId: "child-1", updatedAt: Date.now() },
      acp: readySessionMeta({ runtimeOptions: { runtimeMode: "plan" } }),
    });

    const manager = new AcpSessionManager();
    const staleTurn = manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "old turn",
      mode: "prompt",
      requestId: "old-turn",
    });
    await vi.waitFor(() => {
      expect(runtimeState.getCapabilities).toHaveBeenCalledTimes(1);
    });

    await manager.forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "fresh turn",
      mode: "prompt",
      requestId: "fresh-turn",
    });
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.runTurn), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-2" }),
    });
    const upsertsAfterFreshTurn = hoisted.upsertAcpSessionMetaMock.mock.calls.length;

    releaseControls.resolve();
    await expect(staleTurn).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(upsertsAfterFreshTurn);
    expectRecordFields(mockCallArg(runtimeState.close), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-1" }),
      reason: "session-reset",
      discardPersistentState: true,
    });
  });
});
