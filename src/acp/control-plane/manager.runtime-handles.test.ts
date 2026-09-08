/** Tests ACP runtime handle caching, reuse, re-ensure, and lifecycle cleanup. */
import { describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  disposeAcpSessionManagerInstance,
  expectRecordFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager runtime handles", () => {
  installAcpSessionManagerTestLifecycle();

  function installPersistedSession(sessionKey: string, initialMeta: SessionAcpMeta) {
    let currentMeta = initialMeta;
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: currentMeta,
    }));
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      currentMeta = params.mutate(currentMeta, { acp: currentMeta }) ?? currentMeta;
      return { sessionId: "session-1", updatedAt: Date.now(), acp: currentMeta };
    });
    return {
      get currentMeta() {
        return currentMeta;
      },
    };
  }

  it("reuses runtime session handles after idle time in the same manager process", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    try {
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "second",
        mode: "prompt",
        requestId: "r2",
      });
    } finally {
      clock.mockRestore();
    }

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expect(runtimeState.close).not.toHaveBeenCalled();
    expect(manager.getObservabilitySnapshot().runtimeCache).toStrictEqual({
      activeSessions: 1,
      idleTtlMs: 0,
      evictedTotal: 0,
    });
  });

  it("disposes every retained runtime handle", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockImplementation((input: unknown) => {
      const sessionKey = (input as { sessionKey: string }).sessionKey;
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: readySessionMeta(),
      };
    });
    const manager = new AcpSessionManager();

    for (const [index, sessionKey] of [
      "agent:claude:acp:session-1",
      "agent:codex:acp:session-2",
    ].entries()) {
      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: `turn ${index + 1}`,
        mode: "prompt",
        requestId: `r${index + 1}`,
      });
    }

    await disposeAcpSessionManagerInstance(manager, "gateway-shutdown");

    expect(runtimeState.close).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        runtimeState.close.mock.calls.map(
          ([input]) => (input as { handle: { sessionKey: string } }).handle.sessionKey,
        ),
      ),
    ).toEqual(new Set(["agent:claude:acp:session-1", "agent:codex:acp:session-2"]));
    expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });

  it("cancels an active turn before closing its retained runtime handle", async () => {
    const runtimeState = createRuntime();
    let releaseTurn!: () => void;
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const lifecycle: string[] = [];
    runtimeState.runTurn.mockImplementation(async function* () {
      await turnReleased;
      yield { type: "done" as const };
    });
    runtimeState.cancel.mockImplementation(async () => {
      lifecycle.push("cancel");
      releaseTurn();
    });
    runtimeState.close.mockImplementation(async () => {
      lifecycle.push("close");
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:claude:acp:active-session";
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: readySessionMeta(),
    });
    const manager = new AcpSessionManager();
    const turnPromise = manager
      .runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "active turn",
        mode: "prompt",
        requestId: "r-active",
      })
      .catch(() => undefined);
    await vi.waitFor(() => expect(runtimeState.runTurn).toHaveBeenCalledOnce());

    await disposeAcpSessionManagerInstance(manager, "gateway-shutdown");
    await turnPromise;

    expect(lifecycle).toEqual(["cancel", "close"]);
    expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
  });

  it("re-ensures cached runtime handles when the runtime config changes", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });
    const allowlistCfg = {
      ...baseCfg,
      tools: {
        exec: {
          mode: "allowlist",
          safeBins: ["git"],
        },
      },
    } satisfies OpenClawConfig;
    const denyCfg = {
      ...baseCfg,
      tools: {
        exec: {
          mode: "deny",
          safeBins: ["node"],
        },
      },
    } satisfies OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: allowlistCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      provenance: "system",
      cfg: denyCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.close), {
      reason: "runtime-handle-replaced",
    });
  });

  it("re-ensures cached runtime handles when the backend reports the session is dead", async () => {
    const runtimeState = createRuntime();
    const lifecycle: string[] = [];
    runtimeState.ensureSession
      .mockImplementationOnce(async (input) => {
        lifecycle.push("ensure:old");
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: "runtime-old",
        };
      })
      .mockImplementationOnce(async (input) => {
        lifecycle.push("ensure:new");
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: "runtime-new",
        };
      });
    runtimeState.close.mockImplementation(async ({ handle }) => {
      lifecycle.push(`close:${handle.runtimeSessionName}`);
    });
    runtimeState.getStatus
      .mockResolvedValueOnce({
        summary: "status=alive",
        details: { status: "alive" },
      })
      .mockResolvedValueOnce({
        summary: "status=dead",
        details: { status: "dead" },
      })
      .mockResolvedValueOnce({
        summary: "status=alive",
        details: { status: "alive" },
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.getStatus).toHaveBeenCalledTimes(3);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expect(runtimeState.close).toHaveBeenCalledOnce();
    expectRecordFields(mockCallArg(runtimeState.close), {
      handle: expect.objectContaining({ runtimeSessionName: "runtime-old" }),
      reason: "runtime-handle-replaced",
    });
    expect(lifecycle).toEqual(["ensure:old", "close:runtime-old", "ensure:new"]);
  });

  it("re-ensures cached runtime handles when persisted ACP session identity changes", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession
      .mockResolvedValueOnce({
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-1",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
      })
      .mockResolvedValueOnce({
        sessionKey: "agent:codex:acp:session-1",
        backend: "acpx",
        runtimeSessionName: "runtime-2",
        acpxRecordId: "record-1",
        backendSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
      });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    let currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-1",
      identity: {
        state: "resolved",
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-1",
        agentSessionId: "agent-session-1",
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: currentMeta,
    }));

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "first",
      mode: "prompt",
      requestId: "r1",
    });

    currentMeta = readySessionMeta({
      runtimeSessionName: "runtime-2",
      identity: {
        state: "resolved",
        acpxRecordId: "record-1",
        acpxSessionId: "acpx-session-2",
        agentSessionId: "agent-session-2",
        source: "status",
        lastUpdatedAt: Date.now(),
      },
    });

    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "second",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rehydrates runtime handles after a manager restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex:acp:session-1",
      storeSessionKey: "agent:codex:acp:session-1",
      acp: readySessionMeta(),
    });

    const managerA = new AcpSessionManager();
    await managerA.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "before restart",
      mode: "prompt",
      requestId: "r1",
    });
    const managerB = new AcpSessionManager();
    await managerB.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      text: "after restart",
      mode: "prompt",
      requestId: "r2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
  });

  it("passes persisted ACP backend session identity back into ensureSession for configured bindings after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:deadbeef";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-1",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "codex",
      resumeSessionId: "acpx-sid-1",
    });
    expect(runtimeState.prepareFreshSession).not.toHaveBeenCalled();
  });

  it("never resumes or merges another backend's persisted session identity when returning to the primary", async () => {
    const primaryRuntime = createRuntime();
    primaryRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "primary-backend",
      runtimeSessionName: "primary-runtime",
      acpxRecordId: "primary-record",
      backendSessionId: "primary-session",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "primary-backend",
      runtime: primaryRuntime.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:backend-transition";
    const persisted = installPersistedSession(
      sessionKey,
      readySessionMeta({
        backend: "fallback-backend",
        runtimeSessionName: "fallback-runtime",
        identity: {
          state: "resolved",
          source: "status",
          acpxRecordId: "fallback-record",
          acpxSessionId: "fallback-session",
          agentSessionId: "fallback-agent-session",
          lastUpdatedAt: Date.now(),
        },
      }),
    );
    const cfg = {
      acp: { ...baseCfg.acp, backend: "primary-backend", fallbacks: ["fallback-backend"] },
    } satisfies OpenClawConfig;

    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg,
      sessionKey,
      text: "return to primary",
      mode: "prompt",
      requestId: "r-return-primary",
    });

    expect(mockCallArg(primaryRuntime.ensureSession).resumeSessionId).toBeUndefined();
    expect(primaryRuntime.prepareFreshSession).not.toHaveBeenCalled();
    expect(mockCallArg(primaryRuntime.runTurn).handle).toEqual(
      expect.objectContaining({
        acpxRecordId: "primary-record",
        backendSessionId: "primary-session",
      }),
    );
    expect(mockCallArg(primaryRuntime.runTurn).handle).not.toHaveProperty("agentSessionId");
    expect(persisted.currentMeta.backend).toBe("primary-backend");
    expect(persisted.currentMeta.identity).toEqual(
      expect.objectContaining({
        acpxRecordId: "primary-record",
        acpxSessionId: "primary-session",
      }),
    );
    expect(persisted.currentMeta.identity).not.toHaveProperty("agentSessionId");
  });

  it("recovers a destination-owned named session during failover without crossing source identity", async () => {
    const fallbackRuntime = createRuntime();
    fallbackRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "fallback-backend",
      runtimeSessionName: "fallback-recovered-runtime",
      acpxRecordId: "fallback-recovered-record",
      backendSessionId: "fallback-recovered-session",
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId === "primary-backend") {
        throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "primary backend unavailable");
      }
      if (backendId === "fallback-backend") {
        return { id: backendId, runtime: fallbackRuntime.runtime };
      }
      throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
    });
    const sessionKey = "agent:codex:acp:binding:backend-failover";
    const persisted = installPersistedSession(
      sessionKey,
      readySessionMeta({
        backend: "primary-backend",
        runtimeSessionName: "primary-runtime",
        identity: {
          state: "resolved",
          source: "status",
          acpxRecordId: "primary-record",
          acpxSessionId: "primary-session",
          agentSessionId: "primary-agent-session",
          lastUpdatedAt: Date.now(),
        },
      }),
    );
    const cfg = {
      acp: { ...baseCfg.acp, backend: "primary-backend", fallbacks: ["fallback-backend"] },
    } satisfies OpenClawConfig;

    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg,
      sessionKey,
      text: "fail over",
      mode: "prompt",
      requestId: "r-backend-failover",
    });

    expect(fallbackRuntime.prepareFreshSession).not.toHaveBeenCalled();
    expect(mockCallArg(fallbackRuntime.ensureSession).resumeSessionId).toBeUndefined();
    expect(mockCallArg(fallbackRuntime.runTurn).handle).toEqual(
      expect.objectContaining({
        acpxRecordId: "fallback-recovered-record",
        backendSessionId: "fallback-recovered-session",
      }),
    );
    expect(mockCallArg(fallbackRuntime.runTurn).handle).not.toHaveProperty("agentSessionId");
    expect(persisted.currentMeta.backend).toBe("fallback-backend");
    expect(persisted.currentMeta.identity).toEqual(
      expect.objectContaining({
        acpxRecordId: "fallback-recovered-record",
        acpxSessionId: "fallback-recovered-session",
      }),
    );
    expect(persisted.currentMeta.identity).not.toHaveProperty("agentSessionId");
    expect(persisted.currentMeta.runtimeSessionName).toBe("fallback-recovered-runtime");
  });

  it.each([
    { label: "no identifiers", identifiers: {}, expectedIdentity: undefined },
    {
      label: "only a record identifier",
      identifiers: { acpxRecordId: "destination-record" },
      expectedIdentity: { acpxRecordId: "destination-record" },
    },
    {
      label: "only a backend session identifier",
      identifiers: { backendSessionId: "destination-session" },
      expectedIdentity: { acpxSessionId: "destination-session" },
    },
  ])("does not resurrect source identity when the destination reports $label", async (testCase) => {
    const destinationRuntime = createRuntime();
    destinationRuntime.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "primary-backend",
      runtimeSessionName: "destination-runtime",
      ...testCase.identifiers,
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "primary-backend",
      runtime: destinationRuntime.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:destination-partial-identity";
    const persisted = installPersistedSession(
      sessionKey,
      readySessionMeta({
        backend: "fallback-backend",
        runtimeSessionName: "source-runtime",
        identity: {
          state: "resolved",
          source: "status",
          acpxRecordId: "source-record",
          acpxSessionId: "source-session",
          agentSessionId: "source-agent-session",
          lastUpdatedAt: Date.now(),
        },
      }),
    );

    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg: { acp: { ...baseCfg.acp, backend: "primary-backend" } },
      sessionKey,
      text: "recover destination identity",
      mode: "prompt",
      requestId: `r-destination-${testCase.label.replaceAll(" ", "-")}`,
    });

    expect(destinationRuntime.prepareFreshSession).not.toHaveBeenCalled();
    expect(mockCallArg(destinationRuntime.ensureSession).resumeSessionId).toBeUndefined();
    expect(mockCallArg(destinationRuntime.runTurn).handle).not.toHaveProperty("agentSessionId");
    expect(persisted.currentMeta.backend).toBe("primary-backend");
    expect(persisted.currentMeta.runtimeSessionName).toBe("destination-runtime");
    if (testCase.expectedIdentity) {
      expect(persisted.currentMeta.identity).toEqual(
        expect.objectContaining(testCase.expectedIdentity),
      );
      expect(persisted.currentMeta.identity).not.toHaveProperty("agentSessionId");
    } else {
      expect(persisted.currentMeta.identity).toBeUndefined();
    }
  });

  it("preserves the persisted backend owner and identity when destination initialization fails", async () => {
    const destinationRuntime = createRuntime();
    const sessionKey = "agent:codex:acp:binding:destination-init-failure";
    const sourceIdentity = {
      state: "resolved" as const,
      source: "status" as const,
      acpxRecordId: "source-record",
      acpxSessionId: "source-session",
      agentSessionId: "source-agent-session",
      lastUpdatedAt: Date.now(),
    };
    const persisted = installPersistedSession(
      sessionKey,
      readySessionMeta({
        backend: "fallback-backend",
        runtimeSessionName: "source-runtime",
        identity: sourceIdentity,
      }),
    );
    destinationRuntime.ensureSession.mockImplementation(async () => {
      expect(persisted.currentMeta.backend).toBe("fallback-backend");
      expect(persisted.currentMeta.runtimeSessionName).toBe("source-runtime");
      expect(persisted.currentMeta.identity).toEqual(sourceIdentity);
      throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "destination unavailable");
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "primary-backend",
      runtime: destinationRuntime.runtime,
    });

    await expect(
      new AcpSessionManager().runTurn({
        provenance: "system",
        cfg: { acp: { ...baseCfg.acp, backend: "primary-backend" } },
        sessionKey,
        text: "leave source ownership intact",
        mode: "prompt",
        requestId: "r-destination-init-failure",
      }),
    ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });

    expect(destinationRuntime.prepareFreshSession).not.toHaveBeenCalled();
    expect(mockCallArg(destinationRuntime.ensureSession).resumeSessionId).toBeUndefined();
    expect(persisted.currentMeta.backend).toBe("fallback-backend");
    expect(persisted.currentMeta.runtimeSessionName).toBe("source-runtime");
    expect(persisted.currentMeta.identity).toEqual(sourceIdentity);
  });

  it("prefers the persisted agent session id when reopening an ACP runtime after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:gemini:acp:binding:discord:default:restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          agent: "gemini",
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-1",
            agentSessionId: "gemini-sid-1",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-gemini",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "gemini",
      resumeSessionId: "gemini-sid-1",
    });
  });

  it("passes persisted cwd runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:cwd-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          cwd: "/workspace/stale",
          runtimeOptions: {
            cwd: "/workspace/project",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-cwd",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      cwd: "/workspace/project",
    });
  });

  it.each([
    { agent: "codex", model: "openai/gpt-5.4", supportsModel: true },
    { agent: "claude", model: "anthropic/claude-sonnet-4-6", supportsModel: true },
    { agent: "opencode", model: "inherited/default", supportsModel: false },
  ])(
    "preserves legacy $agent model state across status and turn restart",
    async ({ agent, model, supportsModel }) => {
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      const sessionKey = `agent:${agent}:acp:binding:demo-binding:default:model-restart`;
      const persisted = installPersistedSession(sessionKey, readySessionMeta({ agent }));
      runtimeState.ensureSession.mockImplementation(async (input) => {
        if (!supportsModel && input.modelExplicit) {
          throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Backend has no model capability");
        }
        // The shipped fallback returned no appliedModel, so initialization retained the request.
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: "legacy-runtime",
          backendSessionId: "legacy-session",
        };
      });
      if (!supportsModel) {
        runtimeState.setConfigOption.mockRejectedValue(
          new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", "Model replay is unsupported"),
        );
      }
      const original = new AcpSessionManager();
      await original.initializeSession({
        cfg: baseCfg,
        sessionKey,
        agent,
        mode: "persistent",
        runtimeOptions: { model },
        modelExplicit: supportsModel,
      });
      expect(persisted.currentMeta.runtimeOptions?.model).toBe(model);

      for (const [index, manager] of [original, new AcpSessionManager()].entries()) {
        await expect(manager.getSessionStatus({ cfg: baseCfg, sessionKey })).resolves.toMatchObject(
          {
            runtimeOptions: { model },
          },
        );
        const turn = manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey,
          text: "Use the selected model",
          mode: "prompt",
          requestId: `model-replay-${index}`,
        });
        if (supportsModel) {
          await turn;
        } else {
          await expect(turn).rejects.toMatchObject({ code: "ACP_BACKEND_UNSUPPORTED_CONTROL" });
        }
      }

      expect(runtimeState.runTurn).toHaveBeenCalledTimes(supportsModel ? 2 : 0);
      expect(runtimeState.setConfigOption).toHaveBeenCalledTimes(2);
      expectRecordFields(mockCallArg(runtimeState.setConfigOption, 1), {
        key: "model",
        value: model,
      });
      expect(persisted.currentMeta.runtimeOptions?.model).toBe(model);
    },
  );

  it("passes persisted thinking runtime options into ensureSession after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:thinking-restart";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeOptions: {
            thinking: "high",
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-restart-thinking",
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      thinking: "high",
    });
  });

  it("does not resume persisted ACP identity for oneshot sessions after restart", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:oneshot";
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: {
          ...readySessionMeta(),
          runtimeSessionName: key,
          mode: "oneshot",
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-sid-oneshot",
            lastUpdatedAt: Date.now(),
          },
        },
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-oneshot",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    const ensureInput = mockCallArg(runtimeState.ensureSession);
    expectRecordFields(ensureInput, {
      sessionKey,
      agent: "codex",
      mode: "oneshot",
    });
    expect(ensureInput?.resumeSessionId).toBeUndefined();
  });

  it("falls back to a fresh ensure without reusing stale agent session ids", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (inputUnknown: unknown) => {
      const input = inputUnknown as {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        resumeSessionId?: string;
      };
      if (input.resumeSessionId) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          "failed to resume persisted ACP session",
        );
      }
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
        backendSessionId: "acpx-sid-fresh",
      };
    });
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:binding:demo-binding:default:retry-fresh";
    let currentMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      runtimeSessionName: sessionKey,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-stale",
        agentSessionId: "agent-sid-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey ?? sessionKey;
      return {
        sessionKey: key,
        storeSessionKey: key,
        acp: currentMeta,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(currentMeta, { acp: currentMeta });
      if (next) {
        currentMeta = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: currentMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "r-binding-retry-fresh",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey,
      agent: "codex",
      resumeSessionId: "agent-sid-stale",
    });
    const retryInput = mockCallArg(runtimeState.ensureSession, 1);
    expect(retryInput.resumeSessionId).toBeUndefined();
    const runTurnInput = mockCallArg(runtimeState.runTurn);
    const handle = expectRecordFields(runTurnInput.handle, {
      backendSessionId: "acpx-sid-fresh",
    });
    expect(handle.agentSessionId).toBeUndefined();
    expect(currentMeta.identity?.acpxSessionId).toBe("acpx-sid-fresh");
    expect(currentMeta.identity?.agentSessionId).toBeUndefined();
  });
});
