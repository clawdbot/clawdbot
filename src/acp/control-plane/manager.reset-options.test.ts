import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectMockCallFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager resetSessionRuntimeOptions", () => {
  installAcpSessionManagerTestLifecycle();

  function setupReset() {
    const runtimeState = createRuntime();
    const sessionKey = "agent:codex:acp:reset-options";
    let meta = readySessionMeta({
      cwd: "/workspace/removed",
      runtimeOptions: { cwd: "/workspace/removed", thinking: "high" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: meta,
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(
      async (params: {
        mutate: (
          current: SessionAcpMeta,
          entry: { acp: SessionAcpMeta },
        ) => SessionAcpMeta | null | undefined;
      }) => {
        meta = params.mutate(meta, { acp: meta }) ?? meta;
        return { sessionId: "reset-options", updatedAt: Date.now(), acp: meta };
      },
    );
    return {
      runtimeState,
      manager: new AcpSessionManager(),
      target: { cfg: baseCfg, sessionKey },
      get meta() {
        return meta;
      },
    };
  }

  it("clears a stale cwd after restart without starting a backend", async () => {
    const fixture = setupReset();
    fixture.runtimeState.ensureSession.mockRejectedValue(
      new Error("spawn failed: working directory /workspace/removed does not exist"),
    );

    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).resolves.toEqual({});

    expect(fixture.meta.runtimeOptions).toBeUndefined();
    expect(fixture.meta.cwd).toBeUndefined();
    expect(fixture.runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(fixture.runtimeState.close).not.toHaveBeenCalled();
  });

  it("closes an unhealthy retained handle without replacing it during reset", async () => {
    const fixture = setupReset();
    await fixture.manager.getSessionStatus(fixture.target);
    fixture.runtimeState.getStatus.mockRejectedValue(new Error("backend status unavailable"));
    fixture.runtimeState.ensureSession.mockRejectedValue(new Error("backend cannot be started"));

    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).resolves.toEqual({});

    expect(fixture.runtimeState.ensureSession).toHaveBeenCalledOnce();
    expect(fixture.runtimeState.close).toHaveBeenCalledOnce();
    expectMockCallFields(fixture.runtimeState.close, { reason: "reset-runtime-options" });
    expect(fixture.meta.runtimeOptions).toBeUndefined();
    expect(fixture.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });

  it("keeps overrides and the retained handle available when reset close fails", async () => {
    const fixture = setupReset();
    await fixture.manager.getSessionStatus(fixture.target);
    fixture.runtimeState.close.mockRejectedValueOnce(new Error("backend close failed"));

    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "backend close failed",
    });

    expect(fixture.meta.runtimeOptions).toEqual({ cwd: "/workspace/removed", thinking: "high" });
    expect(fixture.manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(1);
    await expect(fixture.manager.resetSessionRuntimeOptions(fixture.target)).resolves.toEqual({});
    expect(fixture.runtimeState.ensureSession).toHaveBeenCalledOnce();
    expect(fixture.runtimeState.close).toHaveBeenCalledTimes(2);
    expect(fixture.meta.runtimeOptions).toBeUndefined();
  });
});
