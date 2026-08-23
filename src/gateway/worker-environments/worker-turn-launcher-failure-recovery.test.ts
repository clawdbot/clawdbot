import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { SpawnResult } from "../../process/exec.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import { STALE_WORKER_BUILD_REASON, StaleWorkerBuildError } from "./admission.js";
import type { WorkerDispatchEnvironmentService } from "./placement-dispatch-failure.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { placementTurnOwner } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  WorkerRunnerCapacityError,
  WorkerRunnerUnavailableError,
  type WorkerTunnelHandle,
} from "./tunnel-contract.js";
import { failHandedOffTurn } from "./worker-turn-failure.js";
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
  hasLoneSurrogate,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
  type WorkerTurnLauncherOptions,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker turn launcher failure recovery", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each(["worker-turn", "remote-exec"] as const)(
    "releases an exact %s claim after another lifecycle owner starts draining",
    async (executionMode) => {
      seedActivePlacement(executionMode);
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active placement");
      }
      const turnClaim = placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: `move-${executionMode}-claim`,
        runId: `move-${executionMode}-run`,
        owner: placementTurnOwner(active),
      });
      const draining = placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      const stopTunnel = vi.fn(async () => {});
      const destroy = vi.fn(async () => attachedEnvironment());

      await failHandedOffTurn({
        environments: { ...unusedEnvironments(), stopTunnel, destroy },
        placements,
        placement: active,
        turnClaim,
        error: new Error("turn interrupted for placement move"),
      });

      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "draining",
        generation: draining.generation,
        environmentId: active.environmentId,
        activeOwnerEpoch: active.activeOwnerEpoch,
        turnClaim: null,
      });
      expect(stopTunnel).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    },
  );

  it("projects a stale Gateway build teardown and records its durable placement reason", async () => {
    seedActivePlacement();
    const terminalReason = `cloud worker disappeared: ${STALE_WORKER_BUILD_REASON}`;
    const staleEnvironment: NonNullable<ReturnType<WorkerTurnEnvironmentService["get"]>> = {
      ...attachedEnvironment(),
      state: "failed" as const,
      leaseId: null,
      sshEndpoint: null,
      sharedHost: null,
      ownerEpoch: OWNER_EPOCH + 1,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
      error: STALE_WORKER_BUILD_REASON,
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => staleEnvironment),
    };
    const reconcileActivePlacement = vi.fn(async () => {
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active stale-build placement");
      }
      const draining = placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      if (draining.state !== "draining") {
        throw new Error("expected draining stale-build placement");
      }
      const reconciling = placements.startReconcile({
        sessionId: draining.sessionId,
        environmentId: draining.environmentId,
        ownerEpoch: draining.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      if (reconciling.state !== "reconciling") {
        throw new Error("expected reconciling stale-build placement");
      }
      placements.fail({
        sessionId: reconciling.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: terminalReason,
      });
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-stale-worker-build",
        },
        turn("run-stale-worker-build"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow(`Worker turn rejected in placement failed: ${terminalReason}`);
    expect(reconcileActivePlacement).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "failed",
      recoveryError: terminalReason,
      terminalReason,
      turnClaim: null,
    });
  });

  it("terminalizes a stale build rejected during live tunnel admission", async () => {
    seedActivePlacement();
    const terminalReason = `cloud worker disappeared: ${STALE_WORKER_BUILD_REASON}`;
    let environment = attachedEnvironment();
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => environment);
    const reconcileOnce = vi.fn(async () => {
      environment = {
        ...environment,
        state: "failed",
        leaseId: null,
        sshEndpoint: null,
        sharedHost: null,
        ownerEpoch: OWNER_EPOCH + 1,
        attachedSessionIds: [],
        tunnelStatus: "stopped",
        error: STALE_WORKER_BUILD_REASON,
      };
    });
    const environments: WorkerTurnEnvironmentService & WorkerDispatchEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => environment),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => {
        throw new StaleWorkerBuildError();
      }),
      stopTunnel,
      destroy,
      attachSession: vi.fn(async () => {
        throw new Error("unexpected worker session attachment");
      }),
      create: vi.fn(async () => {
        throw new Error("unexpected worker environment creation");
      }),
      createFromProfileSnapshot: vi.fn(async () => {
        throw new Error("unexpected inherited worker environment creation");
      }),
      reconcileOnce,
      reconcileEnvironment: vi.fn(),
    };
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const dispatch = createWorkerPlacementDispatchService({
      placements,
      environments,
      runnerAvailability: { read: () => undefined, version: () => 0 },
      runLocalBarrier: async ({ startDispatch }) => startDispatch(),
      runRecoveryBarrier: async ({ run }) => await run(root),
      runActivationBarrier: async ({ activate }) => activate(),
      runMoveBarrier: async ({ begin }) => begin(),
      resolveMoveDestination: async () => undefined,
      runReclaimBarrier: async ({ begin, reclaim }) => await reclaim(root, begin()),
      runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
      workspaceOperations,
      resolveWorkspacePath: async () => root,
      reportWorkspaceResultConflict: async () => {},
      resolveWorkspaceResultConflict: async () => undefined,
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement: dispatch.reconcileActive,
      workspaceOperations,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-live-stale-worker-build",
        },
        turn("run-live-stale-worker-build"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow(`Worker turn rejected in placement failed: ${terminalReason}`);

    expect(reconcileOnce).toHaveBeenCalledOnce();
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "failed",
      recoveryError: terminalReason,
      terminalReason,
      turnClaim: null,
    });
    expect(placements.get(SESSION_ID)).not.toMatchObject({
      state: "active",
      recoveryError: null,
      terminalReason: null,
    });
  });

  it("keeps an active placement when tunnel startup fails before remote handoff", async () => {
    seedActivePlacement();
    const acknowledgeCredentialDelivery = vi.fn(() => true);
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => {
        throw Object.assign(new Error("device worker node transport is unavailable"), {
          code: "UNAVAILABLE",
        });
      }),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-tunnel-unavailable",
        },
        turn("run-tunnel-unavailable"),
        runLocal,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });

    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("fails impossible replay before handoff and keeps the active placement reusable", async () => {
    seedActivePlacement();
    const manager = openSessionManager();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-replay", name: "read", arguments: {} }],
        model: "gpt-test",
        providerReplay: {
          v: 1,
          type: "openai-responses-compaction",
          data: "gAAAAlauncherReplayCiphertext",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-test",
          baseUrlHash: "ozhevd1smnk8s",
        },
        stopReason: "toolUse",
        timestamp: 1,
      }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-replay",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      details: { payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) },
      isError: false,
      timestamp: 2,
    });
    const launchTurn = vi.fn(async (): Promise<SpawnResult> => {
      throw new Error("unexpected worker handoff");
    });
    const acknowledgeCredentialDelivery = vi.fn(() => true);
    const startTunnel = vi.fn(
      async (): Promise<WorkerTunnelHandle> => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        quiesceWorkspace: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        launchTurn,
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      }),
    );
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel,
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-replay-local-fallback",
        },
        turn("run-replay-local-fallback"),
        runLocal,
      ),
    ).rejects.toThrow(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);

    expect(startTunnel).toHaveBeenCalledOnce();
    expect(launchTurn).not.toHaveBeenCalled();
    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("preserves an unresolved rollback journal when pre-launch recovery conflicts", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement for journal recovery");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const basePack = Buffer.from("conflicted journal snapshot");
    placements.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "e".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"f".repeat(64)}`,
      baseEntries: [
        {
          path: "blocked.txt",
          type: "file",
          mode: 0o644,
          size: 5,
          sha256: createHash("sha256").update("base\n").digest("hex"),
        },
      ],
      appliedEntries: [
        {
          path: "blocked.txt",
          type: "file",
          mode: 0o644,
          size: 7,
          sha256: createHash("sha256").update("worker\n").digest("hex"),
        },
      ],
      baseTree: "d".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    await fs.writeFile(path.join(root, "blocked.txt"), "local\n");
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
    };
    const enteredWorkspaceQueue = createDeferred();
    const releaseWorkspaceQueue = createDeferred();
    const workspaceOperations: NonNullable<WorkerTurnLauncherOptions["workspaceOperations"]> = {
      async run(environmentId, operation) {
        expect(environmentId).toBe(ENVIRONMENT_ID);
        enteredWorkspaceQueue.resolve();
        await releaseWorkspaceQueue.promise;
        return await operation();
      },
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      workspaceOperations,
    });

    const attempt = provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-blocked-journal",
      },
      turn("run-blocked-journal"),
      async () => ({ meta: { durationMs: 1 } }),
    );
    await enteredWorkspaceQueue.promise;
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    releaseWorkspaceQueue.resolve();
    await expect(attempt).rejects.toThrow("workspace recovery could not complete");

    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(placements.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.destroy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "offline before transport dispatch",
      error: new WorkerRunnerUnavailableError(),
      dispatched: false,
      expectedMessage: "The device runner is offline",
    },
    {
      name: "capacity rejection after transport dispatch",
      error: new WorkerRunnerCapacityError(),
      dispatched: true,
      expectedMessage: "device worker capacity remained full",
    },
  ])("keeps the placement active after $name", async ({ error, dispatched, expectedMessage }) => {
    seedActivePlacement();
    const teardownStates: string[] = [];
    const observedPlacements: WorkerSessionPlacementStore = {
      ...placements,
      startReconcile: (input) => {
        teardownStates.push(`reconcile-before:${placements.get(SESSION_ID)?.state ?? "missing"}`);
        const reconciling = placements.startReconcile(input);
        teardownStates.push(`reconcile-after:${reconciling.state}`);
        expect(reconciling.turnClaim).toBeNull();
        return reconciling;
      },
    };
    const stopTunnel = vi.fn(async () => {
      const placement = placements.get(SESSION_ID);
      teardownStates.push(`stop:${placement?.state ?? "missing"}`);
      expect(placement).toMatchObject({ state: "draining", turnClaim: null });
    });
    const destroy = vi.fn(async () => {
      teardownStates.push(`destroy:${placements.get(SESSION_ID)?.state ?? "missing"}`);
      return attachedEnvironment();
    });
    const acknowledgeCredentialDelivery = vi.fn(() => true);
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(async (request) => {
          if (dispatched) {
            request.onDispatchReady?.();
          }
          throw error;
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
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements: observedPlacements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-failed",
        },
        turn("run-failed"),
        runLocal,
      ),
    ).rejects.toThrow(expectedMessage);
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(acknowledgeCredentialDelivery).toHaveBeenCalledTimes(dispatched ? 1 : 0);
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(teardownStates).toEqual([]);
  });

  it("keeps redacted process failure details on a valid UTF-16 boundary", async () => {
    seedActivePlacement();
    const secret = "$SUPERSECRET123";
    const redactedPrefix = "DISCORD_BOT_TOKEN=*** ";
    const padding = "a".repeat(399 - redactedPrefix.length);
    const retained = `${redactedPrefix}${padding}`;
    const emoji = String.fromCodePoint(0x1f600);
    const stderr = `DISCORD_BOT_TOKEN=${secret} ${padding}${emoji}tail`;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
          request.onDispatchReady?.();
          return {
            stdout: "",
            stderr,
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }),
        syncWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace sync");
        }),
        quiesceWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace quiescence");
        }),
        reconcileWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace reconciliation");
        }),
        stop: vi.fn(async () => {}),
      })),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const failurePrefix = "Cloud worker process failed before completing the turn: ";
    let failure: unknown;

    try {
      await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-process-failed",
        },
        turn("run-process-failed"),
        async () => ({ meta: { durationMs: 1 } }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toBe(`${failurePrefix}${retained}`);
    expect(message).not.toContain(secret);
    expect(hasLoneSurrogate(message)).toBe(false);
    const placement = placements.get(SESSION_ID);
    expect(placement).toMatchObject({
      state: "failed",
      recoveryError: message,
      terminalReason: message,
      turnClaim: null,
    });
    expect(hasLoneSurrogate(placement?.recoveryError ?? "")).toBe(false);
    expect(stopTunnel).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
    expect(destroy).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });
});
