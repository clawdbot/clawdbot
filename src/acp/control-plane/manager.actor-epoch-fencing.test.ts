/** Tests that reset actor rotation fences every ACP metadata-writing operation. */
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createDeferred,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const sessionKey = "agent:codex:acp:actor-epoch-fencing";

describe("AcpSessionManager actor epoch fencing", () => {
  installAcpSessionManagerTestLifecycle();

  it.each([
    { operation: "runtime mode", freshOptions: { runtimeMode: "fresh" } },
    { operation: "config option", freshOptions: { model: "fresh-model" } },
    { operation: "option update", freshOptions: { cwd: "/workspace/fresh" } },
    { operation: "option reset", freshOptions: { runtimeMode: "fresh" } },
  ])(
    "does not let a stale $operation write or clear the fresh actor lane",
    async ({ operation, freshOptions }) => {
      const runtimeState = createRuntime();
      const releaseStaleOperation = createDeferred();
      const staleOperationEntered = createDeferred();
      let ensureCount = 0;
      let persistedMeta: SessionAcpMeta | undefined;
      let pauseNextUpsert = false;
      let closeCalls = 0;

      runtimeState.ensureSession.mockImplementation(async (input) => {
        const callNumber = ++ensureCount;
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: `runtime-${callNumber}`,
          backendSessionId: `backend-${callNumber}`,
        };
      });
      if (operation === "runtime mode" || operation === "config option") {
        runtimeState.getCapabilities.mockImplementation(async () => {
          staleOperationEntered.resolve();
          await releaseStaleOperation.promise;
          return {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          };
        });
      }
      if (operation === "option reset") {
        runtimeState.close.mockImplementation(async () => {
          closeCalls += 1;
          if (closeCalls === 1) {
            staleOperationEntered.resolve();
            await releaseStaleOperation.promise;
          }
        });
      }

      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
        const key = (inputUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
        return {
          sessionKey: key,
          storeSessionKey: key,
          ...(persistedMeta ? { entry: { sessionId: "session-1", updatedAt: Date.now() } } : {}),
          ...(persistedMeta ? { acp: persistedMeta } : {}),
        };
      });
      hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
        const input = inputUnknown as {
          sessionKey: string;
          assertCommitAllowed?: () => void;
          mutate: (
            current: SessionAcpMeta | undefined,
            entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta } | undefined,
          ) => SessionAcpMeta | null | undefined;
        };
        const current = persistedMeta;
        const entry = current
          ? { sessionId: "session-1", updatedAt: Date.now(), acp: current }
          : undefined;
        const next = input.mutate(current, entry);
        if (pauseNextUpsert) {
          pauseNextUpsert = false;
          staleOperationEntered.resolve();
          await releaseStaleOperation.promise;
        }
        input.assertCommitAllowed?.();
        if (next === null) {
          persistedMeta = undefined;
        } else if (next !== undefined) {
          persistedMeta = next;
        }
        return persistedMeta
          ? {
              sessionKey: input.sessionKey,
              storeSessionKey: input.sessionKey,
              entry: { sessionId: "session-1", updatedAt: Date.now(), acp: persistedMeta },
              acp: persistedMeta,
            }
          : null;
      });

      const manager = new AcpSessionManager();
      await manager.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent: "codex",
        mode: "persistent",
      });

      if (operation === "option update") {
        pauseNextUpsert = true;
      }
      const staleOperation =
        operation === "runtime mode"
          ? manager.setSessionRuntimeMode({
              cfg: baseCfg,
              sessionKey,
              runtimeMode: "stale",
            })
          : operation === "config option"
            ? manager.setSessionConfigOption({
                cfg: baseCfg,
                sessionKey,
                key: "model",
                value: "stale-model",
              })
            : operation === "option update"
              ? manager.updateSessionRuntimeOptions({
                  cfg: baseCfg,
                  sessionKey,
                  patch: { cwd: "/workspace/stale" },
                })
              : manager.resetSessionRuntimeOptions({
                  cfg: baseCfg,
                  sessionKey,
                });
      await staleOperationEntered.promise;

      await manager.forceDiscardSessionRuntime({
        cfg: baseCfg,
        sessionKey,
        reason: "session-reset",
      });
      await manager.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent: "codex",
        mode: "persistent",
        runtimeOptions: freshOptions,
      });

      releaseStaleOperation.resolve();
      await expect(staleOperation).rejects.toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        detailCode: "SESSION_ACTOR_SUPERSEDED",
      });
      expect(persistedMeta?.runtimeSessionName).toBe("runtime-2");
      expect(persistedMeta?.runtimeOptions).toEqual(freshOptions);

      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "fresh follow-up",
        mode: "prompt",
        requestId: "fresh-follow-up",
      });
      expect(ensureCount).toBe(2);
      expect(mockCallArg(runtimeState.runTurn).handle).toMatchObject({
        runtimeSessionName: "runtime-2",
      });
      if (operation === "runtime mode") {
        expect(runtimeState.setMode).not.toHaveBeenCalledWith(
          expect.objectContaining({ mode: "stale" }),
        );
      }
      if (operation === "config option") {
        expect(runtimeState.setConfigOption).not.toHaveBeenCalledWith(
          expect.objectContaining({ value: "stale-model" }),
        );
      }
    },
  );

  it("does not let stale status reconciliation overwrite the fresh actor metadata", async () => {
    const runtimeState = createRuntime();
    const releaseStaleStatus = createDeferred();
    const staleStatusEntered = createDeferred();
    let statusCalls = 0;
    let ensureCount = 0;
    let persistedMeta: SessionAcpMeta | undefined;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const callNumber = ++ensureCount;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `runtime-${callNumber}`,
        backendSessionId: `backend-${callNumber}`,
      };
    });
    runtimeState.getStatus.mockImplementation(async () => {
      statusCalls += 1;
      if (statusCalls === 2) {
        staleStatusEntered.resolve();
        await releaseStaleStatus.promise;
      }
      return {
        summary: "status=alive",
        backendSessionId: statusCalls === 2 ? "stale-status" : `backend-${statusCalls}`,
        details: { status: "alive" },
      };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
      const key = (inputUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        ...(persistedMeta ? { entry: { sessionId: "session-1", updatedAt: Date.now() } } : {}),
        ...(persistedMeta ? { acp: persistedMeta } : {}),
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { sessionId: string; updatedAt: number; acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const current = persistedMeta;
      const entry = current
        ? { sessionId: "session-1", updatedAt: Date.now(), acp: current }
        : undefined;
      const next = input.mutate(current, entry);
      if (next) {
        persistedMeta = next;
      }
      return persistedMeta
        ? {
            sessionKey: input.sessionKey,
            storeSessionKey: input.sessionKey,
            entry: { sessionId: "session-1", updatedAt: Date.now(), acp: persistedMeta },
            acp: persistedMeta,
          }
        : null;
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });
    const staleStatus = manager.getSessionStatus({
      cfg: baseCfg,
      sessionKey,
    });
    await staleStatusEntered.promise;

    await manager.forceDiscardSessionRuntime({
      cfg: baseCfg,
      sessionKey,
      reason: "session-reset",
    });
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
      runtimeOptions: { model: "fresh-model" },
    });

    releaseStaleStatus.resolve();
    await expect(staleStatus).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_ACTOR_SUPERSEDED",
    });
    expect(persistedMeta?.runtimeSessionName).toBe("runtime-2");
    expect(persistedMeta?.identity?.acpxSessionId).toBe("backend-2");
  });
});
