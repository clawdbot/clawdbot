import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { SpawnResult } from "../../process/exec.js";
import { completeWorkerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import { completeReclaimedWorkspaceTeardown } from "./placement-teardown.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTurnLaunchRequest } from "./tunnel-contract.js";
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
    placements.startWorkspaceResultDrain(priorClaim);
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementationOnce(async () => {
      placements.updateWorkspaceBaseManifest({ claim: priorClaim, manifestRef: MANIFEST_REF });
      placements.acceptWorkspaceResult(priorClaim);
      completeReclaimedWorkspaceTeardown({
        placements,
        turnClaim: priorClaim,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      });
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

  it("waits for an exact cancelled worker turn and preserves its placement for the next run", async () => {
    seedActivePlacement();
    const cancelled = new AbortController();
    const cancellationStarted = createDeferred();
    const finishCancellation = createDeferred();
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const launchTurn = vi.fn(async (request: WorkerTurnLaunchRequest): Promise<SpawnResult> => {
      request.onDispatchReady?.();
      launchCount += 1;
      if (launchCount === 1) {
        cancellationStarted.resolve();
        await finishCancellation.promise;
        return {
          stdout: "",
          stderr: "",
          code: 1,
          signal: null,
          killed: true,
          termination: "exit",
        };
      }
      const completed = openSessionManager();
      const leafId = completed.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Recovered after cancellation" }],
          timestamp: 41,
        }),
      );
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        claim: request.turnClaim,
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
    });
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
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const firstRunId = "run-cancelled-worker";
    const runClaim = (runId: string) => ({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId,
    });
    const first = provider.executeTurn(
      runClaim(firstRunId),
      { ...turn(firstRunId), abortSignal: cancelled.signal },
      async () => ({ meta: { durationMs: 1 } }),
    );
    void first.catch(() => undefined);
    let replacement: Promise<unknown> | undefined;

    try {
      await cancellationStarted.promise;
      await expect(
        provider.executeTurn(runClaim(firstRunId), turn(firstRunId), async () => ({
          meta: { durationMs: 1 },
        })),
      ).rejects.toThrow("already has an active turn claim");
      await expect(
        provider.executeTurn(
          runClaim("run-live-collision"),
          turn("run-live-collision"),
          async () => ({ meta: { durationMs: 1 } }),
        ),
      ).rejects.toThrow("already has an active turn claim");
      const waitForRelease = vi.spyOn(placements, "waitForTurnClaimRelease");
      cancelled.abort(new Error("operator stopped the previous turn"));
      replacement = provider.executeTurn(
        runClaim("run-after-cancellation"),
        turn("run-after-cancellation"),
        async () => ({ meta: { durationMs: 1 } }),
      );
      void replacement.catch(() => undefined);

      await vi.waitFor(() => expect(waitForRelease).toHaveBeenCalledOnce());
      expect(placements.get(SESSION_ID)?.turnClaim?.runId).toBe(firstRunId);
      expect(launchTurn).toHaveBeenCalledOnce();

      finishCancellation.resolve();
      await expect(first).rejects.toThrow("Cloud worker process failed before completing the turn");
      await expect(replacement).resolves.toMatchObject({
        payloads: [{ text: "Recovered after cancellation" }],
      });
      expect(stopTunnel).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      finishCancellation.resolve();
      await Promise.allSettled([first, replacement].filter((operation) => operation !== undefined));
    }
  });

  it.each([
    { label: "without node portal support", portalAvailable: false },
    { label: "with negotiated node portal support", portalAvailable: true },
  ])("launches one worker loop $label", async ({ portalAvailable }) => {
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
    const launchTurn = vi.fn((request: WorkerTurnLaunchRequest) => {
      request.onDispatchReady?.();
      commandStarted.resolve();
      return commandFinished.promise;
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => ({
        ...attachedEnvironment(),
        nodeDeviceId: "cloud-node-1",
        sshEndpoint: null,
      })),
      supportsNodePortal: vi.fn(async () => portalAvailable),
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
    const launchRequest = launchTurn.mock.calls[0]?.[0];
    if (!launchRequest) {
      throw new Error("expected worker launch request");
    }
    expect(launchRequest.plan.assignment).toMatchObject({
      workspaceDir: "/worker/workspace",
      permissionMode: "workspace",
      workerContainmentRoot: "/worker/workspace",
    });
    expect(launchRequest.plan.assignment.toolAuthority.allowedToolNames.includes("portal")).toBe(
      portalAvailable,
    );
    expect(environments.supportsNodePortal).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
    createWorkerSessionPlacementGate(placements).updateAckCursors({
      claim: launchRequest.turnClaim,
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
              claim: request.turnClaim,
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
            claim: request.turnClaim,
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
