// Regression coverage for restart-recovery admission ordering: the
// trajectory target must resolve before `admit_recovery` persists, and every
// post-admission pre-dispatch exit must restore the admitted row through the
// interrupted terminal-event path.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { prepareAgentRunDispatch } from "./agent-run-admission-phase.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";

const hoisted = vi.hoisted(() => ({
  storePath: "/unset-sessions.json",
  actualResolve: null as unknown as typeof resolveSqliteTargetFromSessionStorePath,
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: vi.fn(() => ({ storePath: hoisted.storePath })),
  };
});

vi.mock("../chat-abort.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat-abort.js")>();
  return {
    ...actual,
    registerChatAbortController: vi.fn(() => ({
      registered: true,
      kind: "agent",
      controller: new AbortController(),
      cleanup: vi.fn(),
    })),
  };
});

vi.mock("../../agents/embedded-agent-runner/runs.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agents/embedded-agent-runner/runs.js")>();
  return {
    ...actual,
    retainEmbeddedAgentRunAbortabilityForRunId: vi.fn(),
    isEmbeddedAgentRunAbortableForRunId: vi.fn(() => false),
    clearEmbeddedAgentRunAbortabilityForRunId: vi.fn(),
  };
});

vi.mock("../../agents/prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/prepared-model-runtime.js")>();
  return {
    ...actual,
    loadPublishedGatewayReplyDispatchRuntime: vi.fn(async () => ({
      config: {} as never,
      agentId: "main",
      agentDir: "/tmp",
      workspaceDir: "/tmp",
      pluginGeneration: 0,
    })),
    acquireAgentRunPreparedModelRuntime: vi.fn(async () => ({
      pluginGeneration: 0,
      release: vi.fn(),
    })),
  };
});

vi.mock("./agent-run-user-turn.js", () => ({
  prepareAgentRunUserTurn: vi.fn(async () => ({})),
  releasePreparedAgentRunUserTurn: vi.fn(),
}));

vi.mock("../../agents/main-session-recovery/main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock("../../config/sessions/session-sqlite-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-sqlite-target.js")>();
  hoisted.actualResolve = actual.resolveSqliteTargetFromSessionStorePath;
  return {
    ...actual,
    resolveSqliteTargetFromSessionStorePath: vi.fn(
      (storePath: string, options: { agentId?: string }) =>
        actual.resolveSqliteTargetFromSessionStorePath(storePath, options),
    ),
  };
});

describe("agent run admission phase restart recovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const sessionKey = "agent:main:main";
  const runId = "recovery-1";
  let dir: string;
  let storePath: string;
  let lifecycleGeneration: string;
  let commitRecoverySpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = tempDirs.make("openclaw-admission-restart-recovery-");
    storePath = path.join(dir, "sessions.json");
    hoisted.storePath = storePath;
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    commitRecoverySpy = vi.spyOn(
      await import("../../agents/main-session-recovery/main-session-recovery-store.js"),
      "commitMainSessionRecovery",
    );
    vi.mocked(resolveSqliteTargetFromSessionStorePath).mockImplementation(hoisted.actualResolve);
    vi.mocked(prepareAgentRunUserTurn).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function write(entry: SessionEntry): Promise<void> {
    await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  }

  function read(): SessionEntry {
    return sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  }

  function interruptedEntry(): SessionEntry {
    return {
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
        reservation: { runId, attempt: 1, lifecycleGeneration },
      },
    };
  }

  function buildParams(): Parameters<typeof prepareAgentRunDispatch>[0] {
    let admittedRunAbort: unknown = {
      registered: true,
      cleanup: vi.fn(),
    };
    return {
      request: {
        idempotencyKey: "req-1",
        message: "continue after restart",
        expectedExistingSessionId: "session-1",
      } as never,
      cfg: {} as never,
      cfgForAgent: undefined,
      sessionEntry: undefined,
      resolvedSessionKey: sessionKey,
      requestedSessionKeyRaw: undefined,
      requestedSessionKey: undefined,
      preAcceptedReservedSessionKey: undefined,
      activeSessionAgentId: "main",
      delivery: {
        explicitThreadId: undefined,
        deliveryPlan: { resolvedThreadId: undefined },
      } as never,
      restoredCronContinuationIdentity: undefined,
      restoredCronContinuation: undefined,
      providerOverride: undefined,
      modelOverride: undefined,
      allowModelOverride: false,
      lifecycleGeneration,
      getAdmittedSessionId: () => "session-1",
      ownerConnId: undefined,
      ownerDeviceId: undefined,
      suppressVisibleSessionEffects: false,
      pendingChatRun: undefined,
      inputProvenance: undefined,
      isOneShotModelRun: true,
      isRestartRecoveryResumeRun: true,
      canUseInternalRuntimeHandoff: false,
      execApprovalFollowupApprovalId: undefined,
      message: "continue after restart",
      promptedAt: Date.now(),
      effectiveTranscriptInputText: "",
      images: [],
      offloadedRefs: [],
      onUserTurnMediaPersisted: vi.fn(),
      requestedPromptPersistenceSuppression: false,
      runId,
      agentDedupeKeys: [runId],
      context: {
        chatAbortControllers: new Map(),
        dedupe: { get: () => undefined } as never,
        logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
        addChatRun: vi.fn(),
        resolveGatewayContext: vi.fn(),
      } as never,
      client: null,
      io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
      abortForLifecycleRotation: () => false,
      acquireGatewayWorkAdmission: vi.fn(async () => {}),
      assertGatewayWorkAdmissionAllowed: vi.fn(),
      hasGatewayAdmissionOutcome: () => false,
      respondToGatewayAdmissionOutcome: () => false,
      admissionAgentId: () => "main",
      getGatewayWorkAdmission: () => ({ release: vi.fn() }) as never,
      setAdmittedRunAbort: (value) => {
        admittedRunAbort = value;
      },
      getAdmittedRunAbort: () => admittedRunAbort as never,
      markAgentRunAccepted: vi.fn(),
    };
  }

  it("rejects before recovery admission when trajectory target resolution fails", async () => {
    await write(interruptedEntry());
    vi.mocked(resolveSqliteTargetFromSessionStorePath).mockImplementationOnce(() => {
      throw new Error("simulated registry inspection failure");
    });
    const params = buildParams();

    await expect(prepareAgentRunDispatch(params)).resolves.toBeUndefined();

    // The row must stay in its pre-admission state: resolution failed before
    // admit_recovery persisted anything, so no restore closure is needed.
    expect(commitRecoverySpy).not.toHaveBeenCalled();
    expect(read()).toMatchObject({ abortedLastRun: true });
    expect(read().lifecycleRunId).toBeUndefined();
    expect(params.io.emitAcceptance).toHaveBeenCalledWith([
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    ]);
  });

  it("restores the admitted recovery when user-turn preparation fails after admission", async () => {
    await write(interruptedEntry());
    vi.mocked(prepareAgentRunUserTurn).mockRejectedValueOnce(
      new Error("simulated preparation failure"),
    );
    const params = buildParams();

    await expect(prepareAgentRunDispatch(params)).resolves.toBeUndefined();

    // The admission commit must carry the durable partition owner: without it
    // the accessor resolves the store's default partition for a global row
    // owned by another agent and rejects the reservation before dispatch.
    expect(commitRecoverySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        command: expect.objectContaining({ kind: "admit_recovery" }),
        target: { sessionKey, storePath },
      }),
    );

    // The preparation exit restores the admitted row through the interrupted
    // terminal-event path instead of leaving it admitted with no dispatch.
    // (The restore closure runs inside the store module, so spy it by its
    // durable effects rather than by module-boundary calls.)
    const restoredEntry = read();
    expect(restoredEntry).toMatchObject({ abortedLastRun: true, status: "running" });
    expect(restoredEntry.lifecycleRunId).toBeUndefined();
    const trajectoryEvents = await loadSqliteTrajectoryRuntimeEvents({
      sessionId: "session-1",
      storePath,
    });
    expect(trajectoryEvents).toEqual([
      expect.objectContaining({
        type: "session.ended",
        runId,
        data: expect.objectContaining({ status: "interrupted", aborted: true }),
      }),
    ]);
    expect(vi.mocked(scheduleMainSessionRecoveryPendingTarget)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey,
        storePath,
        agentId: "main",
      }),
    );
    expect(params.io.emitAcceptance).toHaveBeenCalledWith([
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    ]);
  });
});
