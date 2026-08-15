import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { SpawnResult } from "../../process/exec.js";
import { completeWorkerLaunchDescriptor } from "../../worker/launch-descriptor.js";
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
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn launcher claim admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("waits before returning an actionable pending-result claim error", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const priorClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "prior-result-claim",
      runId: "prior-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.markWorkspaceResultPending(priorClaim);
    const waitForRelease = vi
      .spyOn(placements, "waitForTurnClaimRelease")
      .mockRejectedValue(new Error("timed out"));
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: priorClaim.runId,
        },
        turn(priorClaim.runId),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("already has an active turn claim");
    expect(waitForRelease).not.toHaveBeenCalled();

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "next-run",
        },
        turn("next-run"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow(
      "The previous cloud turn's workspace result is still reconciling; it retries automatically — try again shortly.",
    );
    expect(waitForRelease).toHaveBeenCalledWith(SESSION_ID, { timeoutMs: 15_000 });
  });

  it("retries admission when a collided claim releases before inspection", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const priorClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "released-before-inspection",
      runId: "prior-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    vi.spyOn(placements, "listPendingWorkspaceResults").mockImplementationOnce(() => {
      placements.releaseTurn(priorClaim);
      return [];
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "next-run",
        },
        turn("next-run"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("Active worker placement does not match its attached environment");
  });

  it("does not claim a stale worker after pending-result recovery reclaims it", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const priorClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "reclaimed-result-claim",
      runId: "reclaimed-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.markWorkspaceResultPending(priorClaim);
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementationOnce(async () => {
      placements.updateWorkspaceBaseManifest({ claim: priorClaim, manifestRef: MANIFEST_REF });
      placements.acceptWorkspaceResult(priorClaim);
      placements.completeWorkspaceResultAndReleaseTurn(priorClaim, { reclaim: true });
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "next-after-reclaim",
        },
        turn("next-after-reclaim"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow(
      "The previous cloud turn's workspace result is still reconciling; it retries automatically — try again shortly.",
    );
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("launches only one worker loop for concurrent admission of the same run", async () => {
    seedActivePlacement();
    const commandStarted = createDeferred();
    const commandFinished = createDeferred<{
      stdout: string;
      stderr: string;
      code: number;
      signal: null;
      killed: false;
      termination: "exit";
    }>();
    const launchTurn = vi.fn((request: Parameters<WorkerTunnelHandle["launchTurn"]>[0]) => {
      request.onDispatchReady?.();
      commandStarted.resolve();
      return commandFinished.promise;
    });
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
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-overlap",
    };
    const first = provider.executeTurn(claim, turn("run-overlap"), async () => ({
      meta: { durationMs: 1 },
    }));
    await commandStarted.promise;

    await expect(
      provider.executeTurn(claim, turn("run-overlap"), async () => ({
        meta: { durationMs: 1 },
      })),
    ).rejects.toThrow("already has an active turn claim");
    expect(launchTurn).toHaveBeenCalledOnce();

    const completed = openSessionManager();
    const leafId = completed.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Only worker reply" }],
        timestamp: 31,
      }),
    );
    createWorkerSessionPlacementGate(placements).updateAckCursors({
      sessionId: SESSION_ID,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: "run-overlap",
      transcriptSeq: 2,
      liveSeq: 1,
    });
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement before drain race");
    }
    expect(() =>
      placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toThrow("pending cloud workspace result");
    commandFinished.resolve({
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
    });
    await expect(first).resolves.toMatchObject({ payloads: [{ text: "Only worker reply" }] });
    const completedPlacement = placements.get(SESSION_ID);
    if (completedPlacement?.state !== "active") {
      throw new Error("expected active placement after worker completion");
    }
    placements.startDrain({
      sessionId: completedPlacement.sessionId,
      environmentId: completedPlacement.environmentId,
      ownerEpoch: completedPlacement.activeOwnerEpoch,
      expectedGeneration: completedPlacement.generation,
    });
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
  });

  it("keeps an active placement after an acknowledged turn failure and admits the next turn", async () => {
    seedActivePlacement();
    const turnIds: string[] = [];
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential(String(launchCount + 1).repeat(43))),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
          request.onDispatchReady?.();
          launchCount += 1;
          const descriptor = completeWorkerLaunchDescriptor(structuredClone(request.plan), {
            kind: "unix",
            socketPath: "/worker/gateway.sock",
          });
          turnIds.push(descriptor.assignment.turnId);
          if (launchCount === 1) {
            const completed = openSessionManager();
            const leafId = completed.appendMessage(
              makeAgentAssistantMessage({
                content: [{ type: "text", text: "Remote model failed" }],
                stopReason: "error",
                errorMessage: "Cloud worker turn failed",
                timestamp: 31,
              }),
            );
            createWorkerSessionPlacementGate(placements).updateAckCursors({
              sessionId: SESSION_ID,
              environmentId: ENVIRONMENT_ID,
              ownerEpoch: OWNER_EPOCH,
              runId: "run-model-failed",
              transcriptSeq: 2,
              liveSeq: 1,
            });
            return {
              stdout: JSON.stringify({
                status: "failed",
                reason: "turn-failed",
                transcriptLeafId: leafId,
                transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
              }),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          }
          const completed = openSessionManager();
          const leafId = completed.appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "Recovered worker reply" }],
              timestamp: 41,
            }),
          );
          createWorkerSessionPlacementGate(placements).updateAckCursors({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            runId: "run-model-recovered",
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
        }),
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
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-model-failed",
        },
        turn("run-model-failed"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("Cloud worker turn failed");
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(placements.listPendingWorkspaceResults()).toEqual([]);

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-model-recovered",
        },
        turn("run-model-recovered"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).resolves.toMatchObject({ payloads: [{ text: "Recovered worker reply" }] });
    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
