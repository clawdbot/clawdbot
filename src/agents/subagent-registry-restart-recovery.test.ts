import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../sessions/session-lifecycle-admission.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  createSubagentRunRecord,
  type SubagentRunRecordOverrides,
} from "./subagent-test-fixtures.test-helpers.js";

const mocks = vi.hoisted(() => ({
  entries: {} as Record<string, SessionEntry>,
  loadSessionEntry: vi.fn(),
  patchSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: undefined } }),
}));
vi.mock("../config/sessions.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/subagent-recovery.sqlite",
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
  patchSessionEntry: mocks.patchSessionEntry,
}));
vi.mock("../gateway/session-transcript-readers.js", () => ({
  extractMessageRole: (message: { role?: string }) => message?.role,
  extractMessageText: (message: { content?: string }) => message?.content ?? null,
  readSessionMessagesAsync: mocks.readSessionMessages,
}));

const childSessionKey = "agent:main:subagent:restart-child";
function consumeRecoveryAdmission(payload: Record<string, unknown>): SessionWorkAdmissionLease {
  const lease = consumeSessionWorkAdmissionHandoff({
    handoffId: String(payload.internalRuntimeHandoffId),
    scope: "/tmp/subagent-recovery.sqlite",
    identities: [childSessionKey, String(payload.expectedExistingSessionId)],
    onInterrupt: () => undefined,
  });
  if (!lease) {
    throw new Error("expected recovery dispatch to consume its session admission handoff");
  }
  return lease;
}

const dispatchAgent = vi.fn(async (payload: Record<string, unknown>, _timeoutMs?: number) => {
  consumeRecoveryAdmission(payload).release();
  return {
    runId: String(payload.idempotencyKey),
    status: "accepted",
  };
});
const gatewayRuntime: GatewayRecoveryRuntime = {
  dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
  waitForAgent: vi.fn(),
  sendRecoveryNotice: vi.fn(),
};
type RecoveryParams = Parameters<typeof recoverInterruptedSubagentRow>[0];
type ReplaceRunParams = Parameters<RecoveryParams["replaceRun"]>[0];
const replaceRun = vi.fn<RecoveryParams["replaceRun"]>(() => true);
const clearAcceptedRecovery = vi.fn<RecoveryParams["clearAcceptedRecovery"]>((params) => {
  params.expected.execution.restartRecovery = undefined;
  return true;
});
const resumeAcceptedRecovery = vi.fn<RecoveryParams["resumeAcceptedRecovery"]>(() => true);
const reserveLaunch = vi.fn<RecoveryParams["reserveLaunch"]>((params) => params.idempotencyKey);
const markLaunchAttempted = vi.fn<RecoveryParams["markLaunchAttempted"]>((params) => ({
  sessionId: "session-id",
  sessionMarker: params.sessionMarker,
  idempotencyKey: params.idempotencyKey,
  phase: "attempted" as const,
  lifecycleGeneration: params.lifecycleGeneration,
}));
const markLaunchConsumed = vi.fn<RecoveryParams["markLaunchConsumed"]>((params) => ({
  sessionId: "session-id",
  sessionMarker: params.sessionMarker,
  idempotencyKey: params.idempotencyKey,
  phase: "consumed" as const,
}));
const markLaunchAccepted = vi.fn<RecoveryParams["markLaunchAccepted"]>((params) => {
  const accepted = {
    sessionId: "session-id",
    sessionMarker: params.sessionMarker,
    idempotencyKey: params.idempotencyKey,
    phase: "accepted" as const,
  };
  params.expected.execution.restartRecovery = accepted;
  return accepted;
});
const resetLaunchAttempt = vi.fn<RecoveryParams["resetLaunchAttempt"]>(() => true);
const abandonLaunch = vi.fn<RecoveryParams["abandonLaunch"]>(() => true);
const warn = vi.fn();

function run(overrides: Partial<SubagentRunRecordOverrides> = {}): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "original-run",
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the restart-safe task",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  });
}

function getMockSessionId(): string {
  const sessionId = mocks.entries[childSessionKey]?.sessionId;
  if (!sessionId) {
    throw new Error("expected mock recovery session");
  }
  return sessionId;
}

function recover(
  entry: SubagentRunRecord,
  overrides: Partial<Parameters<typeof recoverInterruptedSubagentRow>[0]> = {},
) {
  return recoverInterruptedSubagentRow({
    runId: entry.runId,
    entry,
    now: Date.now(),
    gatewayRuntime,
    isCurrent: () => true,
    abandonLaunch,
    clearAcceptedRecovery,
    getRun: () => entry,
    replaceRun,
    markLaunchAccepted,
    markLaunchAttempted,
    markLaunchConsumed,
    reserveLaunch,
    resumeAcceptedRecovery,
    resetLaunchAttempt,
    warn,
    ...overrides,
  });
}

describe("subagent registry restart recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entries = {
      [childSessionKey]: {
        sessionId: "session-id",
        updatedAt: Date.now(),
        abortedLastRun: true,
      },
    };
    mocks.loadSessionEntry.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => mocks.entries[sessionKey],
    );
    mocks.patchSessionEntry.mockImplementation(
      async (
        { sessionKey }: { sessionKey: string },
        update: (entry: SessionEntry) => SessionEntry,
      ) => {
        const current = mocks.entries[sessionKey];
        if (!current) {
          return null;
        }
        const next = update({ ...current });
        mocks.entries[sessionKey] = next;
        return next;
      },
    );
    dispatchAgent.mockImplementation(async (payload) => {
      consumeRecoveryAdmission(payload).release();
      return {
        runId: String(payload.idempotencyKey),
        status: "accepted",
      };
    });
    replaceRun.mockReturnValue(true);
    reserveLaunch.mockImplementation((params: { idempotencyKey: string }) => params.idempotencyKey);
    markLaunchAttempted.mockImplementation(
      (params: { idempotencyKey: string; lifecycleGeneration: string; sessionMarker: string }) => ({
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "attempted" as const,
        lifecycleGeneration: params.lifecycleGeneration,
      }),
    );
    markLaunchConsumed.mockImplementation(
      (params: { idempotencyKey: string; sessionMarker: string }) => ({
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "consumed" as const,
      }),
    );
    markLaunchAccepted.mockImplementation((params) => {
      const accepted = {
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "accepted" as const,
      };
      params.expected.execution.restartRecovery = accepted;
      return accepted;
    });
    resetLaunchAttempt.mockReturnValue(true);
    abandonLaunch.mockReturnValue(true);
    clearAcceptedRecovery.mockImplementation((params) => {
      params.expected.execution.restartRecovery = undefined;
      return true;
    });
    resumeAcceptedRecovery.mockReturnValue(true);
    mocks.readSessionMessages.mockResolvedValue([]);
  });

  it("resumes a collector with transcript context and its output contract", async () => {
    mocks.readSessionMessages.mockResolvedValue([
      { role: "user", content: "latest user direction" },
      { role: "assistant", content: "I updated openclaw.json" },
    ]);
    const entry = run({ collect: true, outputSchema: { type: "object" } });

    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: childSessionKey,
        expectedExistingSessionId: "session-id",
        internalRuntimeHandoffId: expect.any(String),
        lane: "subagent",
        deliver: false,
        swarmCollector: true,
        swarmOutputSchema: { type: "object" },
        sessionEffects: "internal",
        suppressPromptPersistence: true,
        message: expect.stringMatching(/latest user direction[\s\S]*already applied/),
      }),
    );
    expect(reserveLaunch).toHaveBeenCalledWith({
      runId: "original-run",
      expected: entry,
      sessionId: "session-id",
      sessionMarker: expect.any(String),
      idempotencyKey: expect.stringMatching(/^subagent-recovery:[a-f0-9]{64}$/),
    });
    expect(replaceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: "original-run",
        nextRunId: expect.stringMatching(/^subagent-recovery:[a-f0-9]{64}$/),
        expected: entry,
        task: "finish the restart-safe task",
        requirePersistence: true,
      }),
    );
    expect(replaceRun.mock.calls[0]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
      sessionId: "session-id",
    });
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 1,
        lastRunId: "original-run",
      },
    });
  });

  it("ignores non-aborted, yielded, steer-owned, and already-terminal rows", async () => {
    mocks.entries[childSessionKey]!.abortedLastRun = false;
    await expect(recover(run())).resolves.toEqual({ status: "ignored" });

    mocks.entries[childSessionKey]!.abortedLastRun = true;
    await expect(recover(run({ pauseReason: "sessions_yield" }))).resolves.toEqual({
      status: "ignored",
    });
    await expect(recover(run({ suppressAnnounceReason: "steer-restart" }))).resolves.toEqual({
      status: "ignored",
    });
    await expect(
      recover(
        run({
          execution: {
            status: "terminal",
            startedAt: Date.now() - 2_000,
            endedAt: Date.now(),
            outcome: { status: "ok" },
          },
        }),
      ),
    ).resolves.toEqual({ status: "ignored" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("returns stale and durable terminal owners to the sweeper finalizer", async () => {
    const stale = run({
      createdAt: Date.now() - 3 * 60 * 60_000,
      startedAt: Date.now() - 3 * 60 * 60_000,
    });
    await expect(recover(stale)).resolves.toMatchObject({
      status: "terminal",
      error: expect.stringContaining("stale aborted subagent run"),
    });

    const endedAt = Date.now();
    const replay = run({
      terminalOwner: "interrupted-recovery",
      endedReason: "subagent-error",
      execution: {
        status: "terminal",
        endedAt,
        outcome: { status: "error", error: "saved exact failure" },
      },
    });
    mocks.loadSessionEntry.mockClear();
    await expect(recover(replay)).resolves.toEqual({
      status: "terminal",
      error: "saved exact failure",
      endedAt,
    });
    expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("reclassifies shipped restart-timeout rows before dispatch", async () => {
    const entry = run({
      endedReason: "subagent-error",
      execution: {
        status: "terminal",
        endedAt: Date.now() - 1_000,
        outcome: { status: "timeout" },
      },
    });

    await expect(recover(entry)).resolves.toMatchObject({ status: "accepted" });
    expect(entry.execution).toMatchObject({
      status: "interrupted",
      interruptionReason: "gateway-restart",
      endedAt: undefined,
      outcome: undefined,
    });
    expect(entry.endedReason).toBeUndefined();
  });

  it("defers without consuming the dispatch path until a runtime exists", async () => {
    const entry = run();
    await expect(recover(entry, { gatewayRuntime: undefined })).resolves.toEqual({
      status: "deferred",
    });
    expect(mocks.readSessionMessages).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(true);
  });

  it("preserves the abort marker when dispatch fails", async () => {
    dispatchAgent.mockRejectedValueOnce(new Error("runtime not ready"));
    await expect(recover(run())).resolves.toEqual({
      status: "retry",
      error: "runtime not ready",
    });
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(true);
  });

  it("preserves falsey dispatch rejection diagnostics", async () => {
    dispatchAgent.mockRejectedValueOnce(undefined);

    await expect(recover(run())).resolves.toEqual({
      status: "retry",
      error: "undefined",
    });
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(true);
  });

  it("waits for the definitive in-process response without a caller timeout", async () => {
    const entry = run();
    let resolveDispatch!: () => void;
    dispatchAgent.mockImplementationOnce(async (payload, timeoutMs) => {
      expect(timeoutMs).toBeUndefined();
      const admission = consumeRecoveryAdmission(payload);
      await new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      });
      admission.release();
      return {
        runId: String(payload.idempotencyKey),
        status: "accepted",
      };
    });

    const pending = recover(entry);
    await vi.waitFor(() => expect(dispatchAgent).toHaveBeenCalledOnce());
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveDispatch();
    await expect(pending).resolves.toEqual({ status: "accepted" });
    expect(abandonLaunch).not.toHaveBeenCalled();
  });

  it("rolls back a dispatch attempt that never reaches the Gateway handler", async () => {
    const entry = run();
    reserveLaunch.mockImplementation((params) => {
      entry.execution.restartRecovery = {
        sessionId: "session-id",
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "reserved",
      };
      return params.idempotencyKey;
    });
    markLaunchAttempted.mockImplementation((params) => {
      const attempted = {
        sessionId: "session-id",
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "attempted" as const,
        lifecycleGeneration: params.lifecycleGeneration,
      };
      entry.execution.restartRecovery = attempted;
      return attempted;
    });
    resetLaunchAttempt.mockImplementation((params) => {
      entry.execution.restartRecovery = {
        sessionId: "session-id",
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "reserved",
      };
      return true;
    });
    dispatchAgent.mockRejectedValueOnce(new Error("Gateway runtime is closed"));

    await expect(recover(entry)).resolves.toEqual({
      status: "retry",
      error: "Gateway runtime is closed",
    });
    expect(entry.execution.restartRecovery?.phase).toBe("reserved");

    dispatchAgent.mockImplementationOnce(async (payload) => {
      consumeRecoveryAdmission(payload).release();
      return {
        runId: String(payload.idempotencyKey),
        status: "accepted",
      };
    });
    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });
    expect(dispatchAgent).toHaveBeenCalledTimes(2);
  });

  it("never dispatches unless the exact source-row reservation persists", async () => {
    reserveLaunch.mockImplementationOnce(() => {
      throw new Error("registry unavailable");
    });

    await expect(recover(run())).resolves.toEqual({
      status: "retry",
      error: "registry unavailable",
    });
    expect(dispatchAgent).not.toHaveBeenCalled();

    reserveLaunch.mockReturnValueOnce(undefined);
    await expect(recover(run())).resolves.toEqual({ status: "handled" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("derives one stable request identity for repeated ambiguous dispatch failures", async () => {
    dispatchAgent.mockRejectedValue(new Error("response lost"));
    const entry = run();

    await expect(recover(entry)).resolves.toMatchObject({ status: "retry" });
    await expect(recover(entry)).resolves.toMatchObject({ status: "retry" });

    const keys = reserveLaunch.mock.calls.map(
      ([params]: [{ idempotencyKey: string }]) => params.idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("does not dispatch when the session snapshot rotates during transcript recovery", async () => {
    const entry = run();
    mocks.readSessionMessages.mockImplementationOnce(async () => {
      mocks.entries[childSessionKey] = {
        sessionId: "rotated-session",
        updatedAt: Date.now() + 1,
        abortedLastRun: true,
      };
      return [];
    });

    await expect(recover(entry)).resolves.toEqual({
      status: "retry",
      error: "subagent restart recovery session snapshot changed before dispatch",
    });
    expect(reserveLaunch).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("never overwrites a consumed attempt when the mutable session marker advances", async () => {
    const entry = run({
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 55_000,
        restartRecovery: {
          sessionId: "session-id",
          sessionMarker: "session-id:1",
          idempotencyKey: "subagent-recovery:consumed",
          phase: "consumed",
        },
      },
    });

    await expect(recover(entry)).resolves.toEqual({
      status: "terminal",
      error: expect.stringContaining("automatic replay was suppressed"),
    });

    expect(abandonLaunch).toHaveBeenCalledWith({
      runId: entry.runId,
      expected: entry,
      sessionMarker: "session-id:1",
      idempotencyKey: "subagent-recovery:consumed",
    });
    expect(reserveLaunch).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("rejects an in-flight response when Gateway did not consume the admission handoff", async () => {
    const entry = run();
    dispatchAgent.mockImplementationOnce(async (payload) => ({
      runId: String(payload.idempotencyKey),
      status: "in_flight",
    }));

    await expect(recover(entry)).resolves.toEqual({
      status: "retry",
      error: "Gateway did not consume the subagent restart recovery admission",
    });

    expect(resetLaunchAttempt).toHaveBeenCalledWith({
      runId: entry.runId,
      expected: entry,
      sessionMarker: expect.any(String),
      idempotencyKey: expect.stringMatching(/^subagent-recovery:[a-f0-9]{64}$/),
    });
    expect(markLaunchAccepted).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("does not create a successor when Gateway consumes admission but rejects launch", async () => {
    const entry = run();
    dispatchAgent.mockImplementationOnce(async (payload) => {
      consumeRecoveryAdmission(payload).release();
      return {
        runId: String(payload.idempotencyKey),
        status: "timeout",
        stopReason: "restart",
        timeoutPhase: "queue",
        providerStarted: false,
      };
    });

    await expect(recover(entry)).resolves.toEqual({
      status: "terminal",
      error: expect.stringContaining("Gateway did not accept"),
    });

    expect(abandonLaunch).toHaveBeenCalledWith({
      runId: entry.runId,
      expected: entry,
      sessionMarker: expect.any(String),
      idempotencyKey: expect.stringMatching(/^subagent-recovery:[a-f0-9]{64}$/),
    });
    expect(markLaunchAccepted).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("keeps accepted source ownership when durable remap fails before settlement", async () => {
    replaceRun.mockReturnValue(false);
    const entry = run();

    await expect(recover(entry)).resolves.toEqual({ status: "deferred" });
    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(true);
    expect(entry.execution.restartRecovery).toMatchObject({
      idempotencyKey: expect.stringMatching(/^subagent-recovery:[a-f0-9]{64}$/),
      phase: "accepted",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not remap"),
      expect.any(Object),
    );
  });

  it("settles a persisted accepted receipt without dispatching another turn", async () => {
    const entry = run();
    replaceRun.mockImplementation((params: ReplaceRunParams) => {
      entry.runId = params.nextRunId;
      entry.execution.restartRecovery = params.restartRecovery;
      return true;
    });
    mocks.patchSessionEntry.mockRejectedValueOnce(new Error("store unavailable"));

    await expect(recover(entry)).resolves.toEqual({
      status: "deferred",
    });
    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(dispatchAgent).toHaveBeenCalledOnce();
    expect(replaceRun).toHaveBeenCalledOnce();
    expect(replaceRun.mock.calls[0]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
    });
    expect(entry.execution.restartRecovery).toBeUndefined();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 1,
      },
    });
  });

  it("keeps a definitive accepted response when the consumed write fails", async () => {
    const entry = run();
    markLaunchConsumed.mockImplementationOnce((params) => {
      params.expected.execution.restartRecovery = {
        sessionId: "session-id",
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "consumed",
      };
      throw new Error("consumed write failed");
    });

    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(markLaunchAccepted).toHaveBeenCalledOnce();
    expect(replaceRun).toHaveBeenCalledOnce();
    expect(replaceRun.mock.calls[0]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
    });
    expect(entry.execution.restartRecovery).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("intermediate consumed receipt"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("terminalizes a consumed dispatch after its Gateway lifecycle retires", async () => {
    const entry = run();
    dispatchAgent.mockImplementationOnce(async (payload) => {
      consumeRecoveryAdmission(payload).release();
      rotateAgentEventLifecycleGeneration();
      return {
        runId: String(payload.idempotencyKey),
        status: "accepted",
      };
    });

    await expect(recover(entry)).resolves.toMatchObject({
      status: "terminal",
      error: expect.stringContaining("retired Gateway lifecycle"),
      suppressSessionEffects: true,
    });

    expect(markLaunchConsumed).toHaveBeenCalledOnce();
    expect(markLaunchAccepted).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("resets an unconsumed attempt after its Gateway lifecycle retires", async () => {
    const entry = run();
    dispatchAgent.mockImplementationOnce(async (payload) => {
      rotateAgentEventLifecycleGeneration();
      return {
        runId: String(payload.idempotencyKey),
        status: "accepted",
      };
    });

    await expect(recover(entry)).resolves.toEqual({ status: "handled" });

    expect(resetLaunchAttempt).toHaveBeenCalledOnce();
    expect(markLaunchConsumed).not.toHaveBeenCalled();
    expect(markLaunchAccepted).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
  });

  it("preserves a newer restart marker when the lifecycle retires during settlement", async () => {
    const entry = run();
    markLaunchAccepted.mockImplementationOnce((params) => {
      const attempted = markLaunchAttempted.mock.results[0]?.value;
      const accepted = {
        sessionId: getMockSessionId(),
        sessionMarker: params.sessionMarker,
        idempotencyKey: params.idempotencyKey,
        phase: "accepted" as const,
        lifecycleGeneration: attempted?.lifecycleGeneration,
      };
      params.expected.execution.restartRecovery = accepted;
      return accepted;
    });
    mocks.patchSessionEntry.mockImplementationOnce(
      async (
        { sessionKey }: { sessionKey: string },
        update: (entry: SessionEntry) => SessionEntry,
        options?: { assertCommitAllowed?: () => void },
      ) => {
        const current = mocks.entries[sessionKey];
        if (!current) {
          return null;
        }
        const next = update({ ...current });
        rotateAgentEventLifecycleGeneration();
        options?.assertCommitAllowed?.();
        mocks.entries[sessionKey] = next;
        return next;
      },
    );

    await expect(recover(entry)).resolves.toMatchObject({
      status: "terminal",
      error: expect.stringContaining("retired Gateway lifecycle"),
      suppressSessionEffects: true,
    });

    expect(clearAcceptedRecovery).not.toHaveBeenCalled();
    expect(resumeAcceptedRecovery).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("settles accepted ownership across updatedAt drift on the same session", async () => {
    const entry = run({
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 55_000,
        restartRecovery: {
          sessionId: "session-id",
          sessionMarker: "session-id:1",
          idempotencyKey: "subagent-recovery:accepted",
          phase: "accepted",
        },
      },
    });

    await expect(recover(entry)).resolves.toEqual({ status: "accepted" });

    expect(replaceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: entry.runId,
        nextRunId: "subagent-recovery:accepted",
        restartRecovery: expect.objectContaining({ phase: "accepted" }),
        requirePersistence: true,
      }),
    );
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).toHaveBeenCalledOnce();
    expect(mocks.entries[childSessionKey]!.abortedLastRun).toBe(false);
  });

  it("terminalizes a retired accepted receipt without clearing newer restart evidence", async () => {
    const entry = run({
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 55_000,
        restartRecovery: {
          sessionId: "session-id",
          sessionMarker: "session-id:1",
          idempotencyKey: "subagent-recovery:retired",
          phase: "accepted",
          lifecycleGeneration: "retired-generation",
        },
      },
    });

    await expect(recover(entry)).resolves.toEqual({
      status: "terminal",
      error: expect.stringContaining("retired Gateway lifecycle"),
      suppressSessionEffects: true,
    });

    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(replaceRun).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
    expect(clearAcceptedRecovery).not.toHaveBeenCalled();
    expect(resumeAcceptedRecovery).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("terminalizes accepted ownership when its exact session is missing", async () => {
    delete mocks.entries[childSessionKey];
    const entry = run({
      execution: {
        status: "interrupted",
        startedAt: Date.now() - 55_000,
        restartRecovery: {
          sessionId: "session-id",
          sessionMarker: "session-id:1",
          idempotencyKey: "subagent-recovery:accepted",
          phase: "accepted",
        },
      },
    });
    const successor = structuredClone(entry);
    replaceRun.mockImplementation((params: ReplaceRunParams) => {
      successor.runId = params.nextRunId;
      successor.execution.restartRecovery = params.restartRecovery;
      return true;
    });

    await expect(
      recover(entry, {
        getRun: (runId) => (runId === successor.runId ? successor : undefined),
      }),
    ).resolves.toMatchObject({
      status: "terminal",
      error: expect.stringContaining("lost its exact session"),
      suppressSessionEffects: true,
      target: {
        runId: "subagent-recovery:accepted",
        entry: successor,
      },
    });

    expect(replaceRun).toHaveBeenCalledOnce();
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.patchSessionEntry).not.toHaveBeenCalled();
    expect(clearAcceptedRecovery).not.toHaveBeenCalled();
    expect(successor.execution.restartRecovery).toMatchObject({ phase: "accepted" });
  });

  it("retires the accepted receipt so a later restart can dispatch a new recovery", async () => {
    const entry = run();
    const replacements: SubagentRunRecord[] = [];
    replaceRun.mockImplementation((params: ReplaceRunParams) => {
      const replacement = structuredClone(params.expected ?? entry);
      replacement.runId = params.nextRunId;
      replacement.execution = {
        status: "running",
        startedAt: Date.now(),
        restartRecovery: params.restartRecovery,
      };
      replacements.push(replacement);
      return true;
    });

    const getRun = (runId: string) => replacements.find((candidate) => candidate.runId === runId);
    await expect(recover(entry, { getRun })).resolves.toEqual({ status: "accepted" });
    const firstSuccessor = replacements[0]!;
    const firstRecoveryRunId = firstSuccessor.runId;
    expect(firstSuccessor.execution.restartRecovery).toBeUndefined();
    expect(replaceRun.mock.calls[0]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
    });

    mocks.entries[childSessionKey] = {
      sessionId: "session-id-2",
      updatedAt: Date.now() + 1_000,
      abortedLastRun: true,
    };
    await expect(recover(firstSuccessor, { getRun })).resolves.toEqual({ status: "accepted" });

    expect(dispatchAgent).toHaveBeenCalledTimes(2);
    expect(replacements).toHaveLength(2);
    expect(replacements[1]!.runId).not.toBe(firstRecoveryRunId);
    expect(replacements[1]!.execution.restartRecovery).toBeUndefined();
    expect(replaceRun.mock.calls[1]?.[0].restartRecovery).toMatchObject({
      phase: "accepted",
    });
  });

  it("tombstones a rapid third accepted recovery", async () => {
    mocks.entries[childSessionKey]!.subagentRecovery = {
      automaticAttempts: 2,
      lastAttemptAt: Date.now(),
      lastRunId: "prior-run",
    };

    await expect(recover(run())).resolves.toEqual({ status: "handled" });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(mocks.entries[childSessionKey]).toMatchObject({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 2,
        wedgedAt: expect.any(Number),
      },
    });
  });
});
