import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedRunLaneController } from "../../agents/embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  type AgentEventPayload,
  getAgentEventLifecycleGeneration,
  onAgentEvent as subscribeAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  readAgentRunIndexVersion,
  registerAgentRunContext,
  retainQueuedAgentRunContext,
  sweepStaleRunContexts,
} from "../../infra/agent-run-registry.js";
import { getCommandLaneSnapshot, setCommandLaneConcurrency } from "../../process/command-queue.js";
import type { SpawnResult } from "../../process/exec.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  seedReclaimedPlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn launcher reclaimed placement", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("redispatches a reclaimed placement before launching the worker turn", async () => {
    const reclaimed = seedReclaimedPlacement();
    const runId = "run-reclaimed-worker";
    const contextTtlMs = 30 * 60 * 1000;
    const registeredAt = Date.now();
    const admissionAt = registeredAt + contextTtlMs + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      registeredAt,
      sessionKey: SESSION_KEY,
    });
    const releaseQueuedContext = retainQueuedAgentRunContext(runId, lifecycleGeneration);
    const redispatchEntered = createDeferred();
    const resumeRedispatch = createDeferred();
    const workerStarted = createDeferred();
    const resumeWorker = createDeferred();
    let redispatchCalls = 0;
    const redispatchReclaimed: NonNullable<
      WorkerTurnLauncherOptions["redispatchReclaimed"]
    > = async (placement) => {
      redispatchCalls += 1;
      expect(placement).toEqual(reclaimed);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      redispatchEntered.resolve();
      await resumeRedispatch.promise;
      seedActivePlacement();
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active redispatched placement");
      }
      return active;
    };
    const launchTurn = vi.fn(
      async (request: Parameters<WorkerTunnelHandle["launchTurn"]>[0]): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        workerStarted.resolve();
        await resumeWorker.promise;
        expect(placements.get(SESSION_ID)).toMatchObject({
          state: "active",
          turnClaim: { owner: "worker", runId },
        });
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Redispatched worker reply" }],
            timestamp: 51,
          }),
        );
        createWorkerSessionPlacementGate(placements).updateAckCursors({
          sessionId: SESSION_ID,
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runId,
          transcriptSeq: 2,
          liveSeq: 1,
        });
        return {
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: leafId,
            transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
          }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      },
    );
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn,
        syncWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace sync");
        }),
        reconcileWorkspace: vi.fn(async (request) => {
          request.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
          };
        }),
        stop: vi.fn(async () => {}),
      })),
      stopTunnel: vi.fn(async () => {}),
      destroy: vi.fn(async () => attachedEnvironment()),
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      redispatchReclaimed,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAdmitted = vi.fn(() => {
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: { owner: "worker", runId },
      });
      releaseQueuedContext?.("admitted");
    });
    const events: AgentEventPayload[] = [];
    const unsubscribe = subscribeAgentEvent((event) => events.push(event));
    const pending = provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
      turn(runId),
      runLocal,
      onAdmitted,
    );
    const result = await (async () => {
      try {
        await redispatchEntered.promise;
        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(getAgentRunContext(runId)).toMatchObject({ lifecycleGeneration, registeredAt });
        expect(onAdmitted).not.toHaveBeenCalled();

        resumeRedispatch.resolve();
        await workerStarted.promise;
        expect(onAdmitted).toHaveBeenCalledOnce();
        expect(getAgentRunContext(runId)?.lastActiveAt).toBe(admissionAt);
        expect(runLocal).not.toHaveBeenCalled();

        clock.mockReturnValue(admissionAt + contextTtlMs + 1);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(getAgentRunContext(runId)).toBeDefined();
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });

        clock.mockReturnValue(admissionAt);
        resumeWorker.resolve();
        return await pending;
      } finally {
        resumeRedispatch.resolve();
        resumeWorker.resolve();
        await pending.catch(() => {});
        unsubscribe();
        releaseQueuedContext?.("abandoned");
        clearAgentRunContext(runId);
        clock.mockRestore();
      }
    })();

    expect(events).toContainEqual(
      expect.objectContaining({
        runId,
        stream: "run_status",
        sessionKey: SESSION_KEY,
        agentId: "main",
        data: { phase: "provisioning_environment" },
      }),
    );
    expect(result.payloads).toEqual([{ text: "Redispatched worker reply" }]);
    expect(redispatchCalls).toBe(1);
    expect(launchTurn).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("releases a claimed worker turn when its admission callback fails", async () => {
    seedActivePlacement();
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runId = "run-admission-failed";
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAdmitted = vi.fn(() => {
      expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });
      throw new Error("worker admission callback failed");
    });

    await expect(
      provider.executeTurn(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
        turn(runId),
        runLocal,
        onAdmitted,
      ),
    ).rejects.toThrow("worker admission callback failed");

    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("reclaims a rotated foreground run before an actual remote worker starts", async () => {
    seedActivePlacement();
    const runId = "run-rotated-worker";
    const sessionLane = `session:${runId}`;
    const globalLane = `global:${runId}`;
    const registeredAt = Date.now();
    const admissionAt = registeredAt + 30 * 60 * 1000 + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    let lifecycleGeneration = getAgentEventLifecycleGeneration();
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      ...turn(runId),
      lifecycleGeneration,
      trigger: "user",
    };
    registerAgentRunContext(runId, { lifecycleGeneration, registeredAt, sessionKey: SESSION_KEY });

    const remoteStarted = createDeferred();
    const finishRemote = createDeferred();
    const environments = unusedEnvironments();
    environments.get = vi.fn(() => attachedEnvironment());
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      workspaceOperations: {
        async run<T>(_environmentId: string, _operation: () => Promise<T>): Promise<T> {
          remoteStarted.resolve();
          await finishRemote.promise;
          throw new Error("remote lifecycle proof completed");
        },
      },
    });
    const uninstallPlacement = installSessionPlacementAdmissionProvider(provider);
    const controller = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => lifecycleGeneration,
      getParams: () => params,
      globalLane,
      initialQueuedLifecycleGeneration: lifecycleGeneration,
      sessionLane,
      setLifecycleGeneration: (generation) => {
        lifecycleGeneration = generation;
      },
      setParams: (next) => {
        params = next;
      },
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    setCommandLaneConcurrency(globalLane, 0);
    const pending = controller.enqueueSession(() => controller.enqueueGlobal(runLocal));

    try {
      for (
        let attempt = 0;
        attempt < 10 && getCommandLaneSnapshot(globalLane).queuedCount === 0;
        attempt++
      ) {
        await Promise.resolve();
      }
      expect(getCommandLaneSnapshot(globalLane).queuedCount).toBe(1);

      clock.mockReturnValue(admissionAt);
      const replacementGeneration = rotateAgentEventLifecycleGeneration();
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(runId)).toBeUndefined();
      const versionBeforeAdmission = readAgentRunIndexVersion();

      setCommandLaneConcurrency(globalLane, 1);
      await remoteStarted.promise;
      expect(getAgentRunContext(runId)).toMatchObject({
        lifecycleGeneration: replacementGeneration,
        lastActiveAt: admissionAt,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      expect(readAgentRunIndexVersion()).toBe(versionBeforeAdmission + 1);
      expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });
      expect(runLocal).not.toHaveBeenCalled();

      finishRemote.resolve();
      await expect(pending).rejects.toThrow("remote lifecycle proof completed");
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      setCommandLaneConcurrency(globalLane, 1);
      finishRemote.resolve();
      uninstallPlacement();
      await pending.catch(() => {});
      clearAgentRunContext(runId);
      clock.mockRestore();
    }
  });

  it("rejects an actual worker turn when its lifecycle rotates during placement admission", async () => {
    seedActivePlacement();
    const runId = "run-worker-rotated-during-admission";
    const registeredAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    let lifecycleGeneration = getAgentEventLifecycleGeneration();
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      ...turn(runId),
      lifecycleGeneration,
      trigger: "user",
    };
    registerAgentRunContext(runId, { lifecycleGeneration, registeredAt, sessionKey: SESSION_KEY });

    const workspaceResolutionStarted = createDeferred();
    const resumeWorkspaceResolution = createDeferred();
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      resolveWorkspacePath: async () => {
        workspaceResolutionStarted.resolve();
        await resumeWorkspaceResolution.promise;
        return root;
      },
    });
    const uninstallPlacement = installSessionPlacementAdmissionProvider(provider);
    const controller = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => lifecycleGeneration,
      getParams: () => params,
      globalLane: `global:${runId}`,
      initialQueuedLifecycleGeneration: lifecycleGeneration,
      sessionLane: `session:${runId}`,
      setLifecycleGeneration: (generation) => {
        lifecycleGeneration = generation;
      },
      setParams: (next) => {
        params = next;
      },
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const pending = controller.enqueueSession(() => controller.enqueueGlobal(runLocal));

    try {
      await workspaceResolutionStarted.promise;
      clock.mockReturnValue(registeredAt + 30 * 60 * 1000 + 1);
      const replacementGeneration = rotateAgentEventLifecycleGeneration();
      expect(sweepStaleRunContexts()).toBe(1);
      registerAgentRunContext(runId, {
        lifecycleGeneration: replacementGeneration,
        registeredAt: Date.now(),
        sessionId: "replacement-session",
        sessionKey: "agent:main:replacement",
      });
      const versionBeforeRejectedAdmission = readAgentRunIndexVersion();

      resumeWorkspaceResolution.resolve();
      await expect(pending).rejects.toThrow("stale gateway lifecycle");
      expect(getAgentRunContext(runId)).toMatchObject({
        lifecycleGeneration: replacementGeneration,
        sessionId: "replacement-session",
        sessionKey: "agent:main:replacement",
      });
      expect(readAgentRunIndexVersion()).toBe(versionBeforeRejectedAdmission);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      expect(environments.get).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      resumeWorkspaceResolution.resolve();
      uninstallPlacement();
      await pending.catch(() => {});
      clearAgentRunContext(runId);
      clock.mockRestore();
    }
  });

  it("does not fall back locally when reclaimed redispatch fails", async () => {
    seedReclaimedPlacement();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
      redispatchReclaimed: async () => {
        throw new Error("reclaimed redispatch failed");
      },
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-reclaimed-failed",
        },
        turn("run-reclaimed-failed"),
        runLocal,
      ),
    ).rejects.toThrow("reclaimed redispatch failed");
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("rejects non-active placement without falling back to the local loop", async () => {
    placements.startDispatch({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-requested",
        },
        turn("run-requested"),
        runLocal,
      ),
    ).rejects.toThrow("Worker turn rejected in placement requested");
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });
});
