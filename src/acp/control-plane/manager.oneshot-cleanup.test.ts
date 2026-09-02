/** Tests oneshot session identity persistence through terminal cleanup. */
import { describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  expectRejectedRecord,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager oneshot cleanup", () => {
  installAcpSessionManagerTestLifecycle();

  function installMutableSessionMeta(initial?: SessionAcpMeta) {
    const persisted: { current?: SessionAcpMeta } = { current: initial };
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const sessionKey =
        (paramsUnknown as { sessionKey?: string }).sessionKey ?? "agent:codex:acp:session-1";
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: persisted.current,
      };
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      const next = params.mutate(persisted.current, { acp: persisted.current });
      if (next) {
        persisted.current = next;
      }
      return {
        sessionId: "session-1",
        updatedAt: Date.now(),
        acp: persisted.current,
      };
    });
    return persisted;
  }

  it("preserves a failed oneshot turn state after its terminal close succeeds", async () => {
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-1",
      backend: "acpx",
      runtimeSessionName: "runtime-1",
      backendSessionId: "acpx-oneshot",
      agentSessionId: "agent-oneshot",
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield { type: "done" as const };
      }
      throw new AcpRuntimeError("ACP_TURN_FAILED", "prompt failed after submission");
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const persisted = installMutableSessionMeta();
    const manager = new AcpSessionManager();

    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-1",
      agent: "codex",
      mode: "oneshot",
    });

    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        text: "fail",
        mode: "prompt",
        requestId: "run-failed-oneshot",
      }),
    ).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "prompt failed after submission",
    });

    expect(runtimeState.close).toHaveBeenCalledOnce();
    expectRecordFields(persisted.current, {
      state: "error",
      lastError: "AcpRuntimeError [ACP_TURN_FAILED]: prompt failed after submission",
    });
    expectRecordFields(persisted.current?.identity, { state: "pending" });
    expect(persisted.current?.identity?.acpxSessionId).toBeUndefined();
    expect(persisted.current?.identity?.agentSessionId).toBeUndefined();
  });

  it.each([
    {
      closeOutcome: "succeeds",
      advanceByMs: 2_100,
      expectedResumeSessionId: undefined,
      expectedCreatedSessions: 2,
    },
    {
      closeOutcome: "rejects",
      advanceByMs: 2_100,
      expectedResumeSessionId: "agent-session-1",
      expectedCreatedSessions: 1,
    },
    {
      closeOutcome: "exceeds the cleanup grace period",
      advanceByMs: 4_100,
      expectedResumeSessionId: "agent-session-1",
      expectedCreatedSessions: 1,
    },
  ])(
    "handles a oneshot timeout whose terminal close $closeOutcome",
    async ({ closeOutcome, advanceByMs, expectedResumeSessionId, expectedCreatedSessions }) => {
      vi.useFakeTimers();
      let resolvePendingClose: (() => void) | undefined;
      try {
        const runtimeState = createRuntime();
        let createdSessions = 0;
        runtimeState.ensureSession.mockImplementation(async (input) => {
          const backendSessionId = input.resumeSessionId ?? `acpx-session-${++createdSessions}`;
          return {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: "runtime-1",
            backendSessionId,
            agentSessionId: "agent-session-1",
          };
        });
        runtimeState.runTurn.mockImplementation(async function* () {
          await new Promise(() => {});
          yield { type: "done" as const };
        });
        if (closeOutcome === "rejects") {
          runtimeState.close.mockRejectedValue(new Error("close failed: lease still held"));
        } else if (closeOutcome === "exceeds the cleanup grace period") {
          runtimeState.close.mockImplementation(
            () =>
              new Promise<void>((resolve) => {
                resolvePendingClose = resolve;
              }),
          );
        }
        hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
          id: "acpx",
          runtime: runtimeState.runtime,
        });
        const persisted = installMutableSessionMeta();
        const cfg = {
          ...baseCfg,
          agents: { defaults: { timeoutSeconds: 1 } },
        } as OpenClawConfig;
        const sessionKey = "agent:codex:acp:session-1";
        const managerA = new AcpSessionManager();

        await managerA.initializeSession({
          cfg,
          sessionKey,
          agent: "codex",
          mode: "oneshot",
        });
        const turn = managerA.runTurn({
          provenance: "system",
          cfg,
          sessionKey,
          text: "hang",
          mode: "prompt",
          requestId: `run-timeout-close-${closeOutcome}`,
        });
        void turn.catch(() => undefined);
        await vi.waitFor(() => expect(runtimeState.runTurn).toHaveBeenCalledOnce(), {
          interval: 1,
        });

        await vi.advanceTimersByTimeAsync(advanceByMs);

        await expectRejectedRecord(turn, {
          code: "ACP_TURN_FAILED",
          message: "ACP turn timed out after 1s.",
        });
        expectRecordFields(persisted.current, { state: "error" });

        const managerB = new AcpSessionManager();
        await managerB.getSessionStatus({ cfg, sessionKey });

        expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
        expect(mockCallArg(runtimeState.ensureSession, 1).resumeSessionId).toBe(
          expectedResumeSessionId,
        );
        expect(createdSessions).toBe(expectedCreatedSessions);
      } finally {
        resolvePendingClose?.();
        await Promise.resolve();
        vi.useRealTimers();
      }
    },
  );

  it("resumes one backend session across a manager cache miss and closes it after the prompt", async () => {
    const runtimeState = createRuntime();
    let createdSessions = 0;
    runtimeState.ensureSession.mockImplementation(async (input) => {
      const backendSessionId = input.resumeSessionId ?? `acpx-session-${++createdSessions}`;
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: "runtime-1",
        backendSessionId,
        agentSessionId: "agent-session-1",
      };
    });
    runtimeState.getStatus.mockImplementation(async ({ handle }) => ({
      summary: "status=alive",
      backendSessionId: handle.backendSessionId,
      agentSessionId: handle.agentSessionId,
      details: { status: "alive" },
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const persisted = installMutableSessionMeta();
    const sessionKey = "agent:codex:acp:session-1";

    await new AcpSessionManager().initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "oneshot",
    });
    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "resume and finish",
      mode: "prompt",
      requestId: "run-resumed-oneshot",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    expect(mockCallArg(runtimeState.ensureSession, 1).resumeSessionId).toBe("agent-session-1");
    expect(createdSessions).toBe(1);
    expectRecordFields(mockCallArg(runtimeState.runTurn), { text: "resume and finish" });
    expectRecordFields(mockCallArg(runtimeState.close), { reason: "oneshot-complete" });
    expectRecordFields(persisted.current?.identity, { state: "pending" });
    expect(persisted.current?.identity?.acpxSessionId).toBeUndefined();
    expect(persisted.current?.identity?.agentSessionId).toBeUndefined();
  });
});
