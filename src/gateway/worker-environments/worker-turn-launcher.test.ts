import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  abortAndDrainEmbeddedAgentRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createChatRunState } from "../server-chat-state.js";
import { prepareSessionLifecycleDrain } from "../server-methods/sessions-lifecycle-drain.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { WorkerTunnelOwnerDisconnectedError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

describe("worker turn launcher local placement", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("rejects a transcript target without a session incarnation", () => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        sessionId: "current-session",
        sessionTarget: {
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("missing its transcript identity");
  });

  it("rejects a transcript target from another session incarnation", () => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        sessionId: "current-session",
        sessionTarget: {
          agentId: "main",
          sessionId: "stale-session",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("transcript identity does not match the active turn");
  });

  it.each([
    ["agent", { agentId: "other", sessionKey: "agent:main:main" }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["target key agent", { agentId: "main", sessionKey: "agent:other:main" }],
  ])("rejects a transcript target with a different %s", (_label, identity) => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:main",
        sessionTarget: {
          ...identity,
          sessionId: "current-session",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("transcript identity does not match the active turn");
  });
  it("rejects a transcript target after its session key is rebound", async () => {
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: "replacement-session",
      updatedAt: Date.now() + 1,
    });

    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        sessionTarget,
      }),
    ).toThrow("transcript identity is no longer current");
  });
  it("atomically claims and releases a local turn around the local loop", async () => {
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    const result = await provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-local" },
      turn("run-local"),
      async () => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "local",
          runId: "run-local",
        });
        return { payloads: [{ text: "local" }], meta: { durationMs: 1 } };
      },
    );

    expect(result.payloads).toEqual([{ text: "local" }]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("leaves no placement row for an auxiliary model run without a session key", async () => {
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await provider.executeTurn(
      { sessionId: SESSION_ID, agentId: "main", runId: "run-model-probe" },
      { ...turn("run-model-probe"), modelRun: true },
      runLocal,
    );

    expect(runLocal).toHaveBeenCalledOnce();
    expect(placements.list()).toEqual([]);
  });

  it.each([
    ["agent id", { agentId: "other", sessionKey: SESSION_KEY }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["blank agent id", { agentId: " ", sessionKey: SESSION_KEY }],
    ["blank session key", { agentId: "main", sessionKey: " " }],
  ])(
    "rejects a conflicting supplied placement %s before workspace access",
    async (_label, identity) => {
      seedActivePlacement();
      const resolveWorkspacePath = vi.fn(async () => root);
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: unusedEnvironments(),
        placements,
        resolveWorkspacePath,
      });

      await expect(
        provider.executeTurn(
          { sessionId: SESSION_ID, ...identity, runId: `run-conflict-${_label}` },
          turn(`run-conflict-${_label}`),
          runLocal,
        ),
      ).rejects.toThrow(/Worker turn (agent id|session key) (?:is required|does not match)/u);
      expect(resolveWorkspacePath).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("inherits omitted placement identity before workspace access", async () => {
    seedActivePlacement();
    const resolveWorkspacePath = vi.fn(async () => {
      throw new Error("workspace reached");
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
      resolveWorkspacePath,
    });

    await expect(
      provider.executeTurn(
        { sessionId: SESSION_ID, runId: "run-inherited-identity" },
        turn("run-inherited-identity"),
        vi.fn(),
      ),
    ).rejects.toThrow("workspace reached");
    expect(resolveWorkspacePath).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      agentId: "main",
      sessionKey: SESSION_KEY,
    });
  });

  it("holds a local placement claim around CLI execution", async () => {
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    const result = await provider.executeLocalTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-cli" },
      async () => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "local",
          runId: "run-cli",
        });
        return { kind: "cli" };
      },
    );

    expect(result).toEqual({ kind: "cli" });
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("mints a fresh claim token when a later turn reuses the run id", async () => {
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const claimIds: string[] = [];
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-reused",
    };

    for (let index = 0; index < 2; index += 1) {
      await provider.executeLocalTurn(claim, async () => {
        const claimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
        if (!claimId) {
          throw new Error("expected active placement claim");
        }
        claimIds.push(claimId);
      });
    }

    expect(claimIds).toHaveLength(2);
    expect(claimIds[0]).not.toBe(claimIds[1]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("does not let a stale local finally release a reclaimed run id", async () => {
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred();
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-restarted",
    };

    const first = provider.executeLocalTurn(claim, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const firstClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(placements.clearLocalTurnClaimsAfterRestart()).toBe(1);

    const second = provider.executeLocalTurn(claim, async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
    });
    await secondStarted.promise;
    const secondClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(secondClaimId).toBeTruthy();
    expect(secondClaimId).not.toBe(firstClaimId);

    releaseFirst.resolve();
    await first;
    expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(secondClaimId);

    releaseSecond.resolve();
    await second;
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("releases a force-cleared embedded turn for archive without clearing its replacement", async () => {
    const startedAt = Date.now() - 60_000;
    setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      startedAt,
      status: "running",
      updatedAt: startedAt,
    });
    const runningEntry = loadSessionEntry(sessionTarget);
    expect(runningEntry).toMatchObject({
      sessionId: SESSION_ID,
      startedAt,
      status: "running",
      updatedAt: expect.any(Number),
    });
    if (!runningEntry) {
      throw new Error("expected running session entry");
    }
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const oldRunStarted = createDeferred();
    const finishOldRun = createDeferred();
    const replacementStarted = createDeferred();
    const finishReplacement = createDeferred();
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };

    const oldRun = provider.executeLocalTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-force-cleared",
      },
      async () => {
        setActiveEmbeddedRun(SESSION_ID, handle, SESSION_KEY);
        oldRunStarted.resolve();
        await finishOldRun.promise;
      },
    );
    await oldRunStarted.promise;
    const oldClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(oldClaimId).toBeTruthy();

    await expect(
      abortAndDrainEmbeddedAgentRun({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        settleMs: 100,
        forceClear: true,
        reason: "stuck_recovery",
      }),
    ).resolves.toMatchObject({ forceCleared: true });
    const killedEntry = loadSessionEntry(sessionTarget);
    expect(killedEntry).toMatchObject({
      sessionId: SESSION_ID,
      status: "killed",
      abortedLastRun: true,
    });
    expect(killedEntry?.updatedAt).toBeGreaterThan(runningEntry.updatedAt);

    const context = {
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(),
      workerSessionPlacementService: placements,
    } as unknown as GatewayRequestContext;
    const archiveDrain = await prepareSessionLifecycleDrain({
      action: "archive",
      context,
      storePath: sessionTarget.storePath,
      sessionKeys: [SESSION_KEY],
      sessionId: SESSION_ID,
      agentId: "main",
      sessionKey: SESSION_KEY,
      lifecycleIdentities: [SESSION_KEY, SESSION_ID],
    });
    expect(archiveDrain.hasAuthoritativeWork()).toBe(false);
    archiveDrain.release();

    const replacement = provider.executeLocalTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-replacement",
      },
      async () => {
        replacementStarted.resolve();
        await finishReplacement.promise;
      },
    );
    await replacementStarted.promise;
    const replacementClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(replacementClaimId).toBeTruthy();
    expect(replacementClaimId).not.toBe(oldClaimId);

    finishOldRun.resolve();
    await oldRun;
    expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(replacementClaimId);

    finishReplacement.resolve();
    await replacement;
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("rejects local CLI execution after worker activation", async () => {
    seedActivePlacement();
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ kind: "cli" }));

    await expect(
      provider.executeLocalTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-local-after-dispatch",
        },
        runLocal,
      ),
    ).rejects.toThrow(`Local turn rejected for session ${SESSION_ID} in placement active`);

    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it.each([
    ["CLI", "claude-cli"],
    ["plugin", "test-harness"],
  ])(
    "rejects an active worker turn assigned to a configured %s runtime",
    async (_kind, runtimeId) => {
      seedActivePlacement();
      const getEnvironment = vi.fn(() => undefined);
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: getEnvironment,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const runId = `run-${runtimeId}`;

      await expect(
        provider.executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          {
            ...turn(runId),
            config: {
              agents: {
                defaults: {
                  models: {
                    "openai/gpt-test": { agentRuntime: { id: runtimeId } },
                  },
                },
              },
            },
          },
          runLocal,
        ),
      ).rejects.toThrow(`Cloud worker turns require the OpenClaw runtime, not ${runtimeId}`);

      expect(runLocal).not.toHaveBeenCalled();
      expect(getEnvironment).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );

  it.each([
    { label: "SSH", nodeDeviceId: undefined, providerId: "fake" },
    { label: "paired-device", nodeDeviceId: "paired-node-1", providerId: "device" },
    { label: "cloud-node", nodeDeviceId: "cloud-node-1", providerId: "crabbox" },
  ])(
    "runs a $label remote-exec placement locally and reconciles without launching a worker child",
    async ({ nodeDeviceId, providerId }) => {
      seedActivePlacement("remote-exec");
      const order: string[] = [];
      const launchTurn = vi.fn();
      const quiesceWorkspace = vi.fn(async () => {
        order.push("quiesce");
        return {
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {
            order.push("resume");
          }),
        };
      });
      const reconcileWorkspace = vi.fn(
        async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
          order.push("reconcile");
          request.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: vi.fn(async () => {}),
            verifyLocalStable: vi.fn(async () => {}),
          };
        },
      );
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace,
        syncWorkspace: vi.fn(),
        reconcileWorkspace,
        stop: vi.fn(async () => {}),
      };
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() =>
          nodeDeviceId
            ? { ...attachedEnvironment(), providerId, nodeDeviceId, sshEndpoint: null }
            : attachedEnvironment(),
        ),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      let retainedNodeAuthority: (() => void) | undefined;
      const runLocal = vi.fn(async () => {
        order.push("local");
        if (nodeDeviceId) {
          const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent;
          expect(assertCurrent).toBeTypeOf("function");
          const request = {
            runId: "run-remote-exec",
            agentId: "main",
            nodeId: nodeDeviceId,
            workspace: {
              workspaceDir: "/worker/workspace",
              environmentId: ENVIRONMENT_ID,
              sessionId: SESSION_ID,
              sessionKey: SESSION_KEY,
              ownerEpoch: OWNER_EPOCH,
            },
          };
          retainedNodeAuthority = () => assertCurrent!(request);
          retainedNodeAuthority();
          for (const changed of [
            { ...request, runId: "other" },
            { ...request, nodeId: "other" },
            ...[
              { ownerEpoch: OWNER_EPOCH + 1 },
              { environmentId: "other" },
              { sessionId: "other" },
              { workspaceDir: "/other" },
            ].map((workspace) =>
              Object.assign({}, request, {
                workspace: Object.assign({}, request.workspace, workspace),
              }),
            ),
          ]) {
            expect(() => assertCurrent!(changed)).toThrow("no longer current");
          }
          const original = environments.get(ENVIRONMENT_ID)!;
          if (original.state !== "attached") {
            throw new Error("expected an attached environment");
          }
          for (const changed of [
            { ...original, nodeDeviceId: "replacement" },
            { ...original, leaseId: "replacement" },
          ]) {
            vi.mocked(environments.get).mockReturnValueOnce(changed);
            await Promise.resolve();
            expect(retainedNodeAuthority).toThrow("no longer current");
          }
        }
        return { payloads: [{ text: "local remote reply" }], meta: { durationMs: 1 } };
      });

      await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-remote-exec",
        },
        turn("run-remote-exec"),
        runLocal,
      );

      expect(order).toEqual(["local", "quiesce", "reconcile", "resume"]);
      expect(launchTurn).not.toHaveBeenCalled();
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      const placement = placements.get(SESSION_ID);
      expect([placement?.state, placement?.turnClaim]).toEqual(["active", null]);
      if (retainedNodeAuthority) {
        expect(retainedNodeAuthority).toThrow("no longer current");
      }
    },
  );

  it("resolves an exact paired-device sandbox without requiring an SSH identity resolver", async () => {
    seedActivePlacement("remote-exec");
    const environment = {
      ...attachedEnvironment(),
      providerId: "device",
      nodeDeviceId: "paired-node-1",
      sharedHost: true,
      sshEndpoint: null,
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => environment),
      resolveSshIdentity: undefined,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await expect(
      provider.resolveSandbox({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: "/caller/workspace",
      }),
    ).resolves.toMatchObject({
      backendId: "node",
      placementExecutionMode: "remote-exec",
      placementNodeId: "paired-node-1",
      containerWorkdir: "/worker/workspace",
    });
  });

  it("rejects a remote-exec placement replaced while resolving its managed workspace", async () => {
    seedActivePlacement("remote-exec");
    const environment = attachedEnvironment();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: { ...unusedEnvironments(), get: vi.fn(() => environment) },
      placements,
      resolveWorkspacePath: async () => {
        const placement = placements.get(SESSION_ID);
        if (placement?.state !== "active") {
          throw new Error("expected an active placement");
        }
        placements.startDrain({
          sessionId: SESSION_ID,
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
          expectedGeneration: placement.generation,
        });
        return "/local/managed-worktree";
      },
    });

    await expect(
      provider.resolveSandbox({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: "/caller/workspace",
      }),
    ).rejects.toThrow("changed while preparing its managed workspace");
  });

  it("rejects a paired-node environment replaced after sandbox preparation", async () => {
    seedActivePlacement("remote-exec");
    const environment = {
      ...attachedEnvironment(),
      providerId: "device",
      nodeDeviceId: "paired-node-1",
      sshEndpoint: null,
    };
    const get = vi
      .fn<WorkerTurnEnvironmentService["get"]>()
      .mockReturnValueOnce(environment)
      .mockReturnValueOnce(environment)
      .mockReturnValueOnce({ ...environment, nodeDeviceId: "replacement-node" });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: { ...unusedEnvironments(), get },
      placements,
    });

    await expect(
      provider.resolveSandbox({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: "/caller/workspace",
      }),
    ).rejects.toThrow("environment changed while preparing its sandbox");
  });

  it.each([
    {
      scenario: "successful execution",
      executionFailure: undefined,
      expectedError:
        "Cloud worker finished, but its workspace result could not be reconciled: workspace manifest memo exceeds its entry limit",
      expectedTerminalReason: "workspace manifest memo exceeds its entry limit",
    },
    {
      scenario: "failed execution",
      executionFailure: "Codex paired execution device disconnected; start a fresh attempt",
      expectedError: "Codex paired execution device disconnected; start a fresh attempt",
      expectedTerminalReason: "Codex paired execution device disconnected; start a fresh attempt",
    },
  ])(
    "records a remote-exec reconciliation failure after $scenario and releases its local claim",
    async ({ executionFailure, expectedError, expectedTerminalReason }) => {
      seedActivePlacement("remote-exec");
      const reconciliationError = new Error("workspace manifest memo exceeds its entry limit");
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(async () => {
          throw reconciliationError;
        }),
        stop: vi.fn(async () => {}),
      };
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => attachedEnvironment()),
        startTunnel: vi.fn(async () => tunnel),
      };
      const reconcileActivePlacement = vi.fn(async () => {
        const placement = placements.get(SESSION_ID);
        if (placement?.state !== "failed" || placement.turnClaim !== null) {
          throw new Error("expected terminal placement before teardown recovery");
        }
        expect(placements.listPendingWorkspaceResults()).toEqual([]);
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
            runId: "run-remote-exec-reconcile-failure",
          },
          turn("run-remote-exec-reconcile-failure"),
          async () => {
            if (executionFailure) {
              throw new Error(executionFailure);
            }
            return { payloads: [{ text: "remote work completed" }], meta: { durationMs: 1 } };
          },
        ),
      ).rejects.toMatchObject({
        message: expectedError,
        ...(executionFailure
          ? {
              cause: expect.objectContaining({
                message: expect.stringContaining(reconciliationError.message),
              }),
            }
          : {}),
      });

      expect(reconcileActivePlacement).toHaveBeenCalledWith(ENVIRONMENT_ID);
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "failed",
        turnClaim: null,
        terminalReason: expect.stringContaining(expectedTerminalReason),
      });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
    },
  );

  it.each([
    { label: "failed paired-device execution", executionFailed: true, providerId: "device" },
    { label: "successful paired-device execution", executionFailed: false, providerId: "device" },
    { label: "failed cloud-node execution", executionFailed: true, providerId: "crabbox" },
    { label: "successful cloud-node execution", executionFailed: false, providerId: "crabbox" },
  ])(
    "preserves a disconnected node-backed placement after $label for a fresh attempt",
    async ({ executionFailed, providerId }) => {
      seedActivePlacement("remote-exec");
      const original = placements.get(SESSION_ID);
      if (original?.state !== "active") {
        throw new Error("expected an active paired-device placement");
      }
      let connected = false;
      const quiesceWorkspace = vi.fn(async () => {
        if (!connected) {
          throw new WorkerTunnelOwnerDisconnectedError(
            "device worker node is not connected with the supervisor dialect",
          );
        }
        return { assertActive: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
      });
      const reconcileWorkspace = vi.fn(
        async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
          request.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: vi.fn(async () => {}),
            verifyLocalStable: vi.fn(async () => {}),
          };
        },
      );
      const launchTurn = vi.fn();
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace,
        syncWorkspace: vi.fn(),
        reconcileWorkspace,
        stop: vi.fn(async () => {}),
      };
      const environment = {
        ...attachedEnvironment(),
        providerId,
        nodeDeviceId: "paired-node-1",
        sshEndpoint: null,
      };
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        startTunnel: vi.fn(async () => tunnel),
      };
      const reconcileActivePlacement = vi.fn(async () => {});
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        reconcileActivePlacement,
      });
      const executionFailure = executionFailed
        ? "Codex paired execution device disconnected; start a fresh attempt"
        : undefined;

      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-paired-device-disconnected",
          },
          turn("run-paired-device-disconnected"),
          async () => {
            if (executionFailure) {
              throw new Error(executionFailure);
            }
            return { payloads: [{ text: "remote work completed" }], meta: { durationMs: 1 } };
          },
        ),
      ).rejects.toMatchObject({
        message:
          executionFailure ?? expect.stringContaining("workspace result could not be reconciled"),
        cause: expect.any(Error),
      });

      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        generation: original.generation,
        environmentId: original.environmentId,
        activeOwnerEpoch: original.activeOwnerEpoch,
        workspaceBaseManifestRef: original.workspaceBaseManifestRef,
        turnClaim: null,
        terminalReason: null,
      });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(reconcileWorkspace).not.toHaveBeenCalled();
      expect(reconcileActivePlacement).not.toHaveBeenCalled();

      connected = true;
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-paired-device-fresh-attempt",
          },
          turn("run-paired-device-fresh-attempt"),
          async () => ({ payloads: [{ text: "fresh node attempt" }], meta: { durationMs: 1 } }),
        ),
      ).resolves.toMatchObject({ payloads: [{ text: "fresh node attempt" }] });

      expect(reconcileWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ baseManifestRef: original.workspaceBaseManifestRef }),
      );
      expect(launchTurn).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );

  it("rejects a reused worker bundle without execution context before launch", async () => {
    seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    oldEnvironment.bootstrapReceipt = {
      ...oldEnvironment.bootstrapReceipt!,
      protocolFeatures: [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => oldEnvironment),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-old-worker",
        },
        turn("run-old-worker"),
        runLocal,
      ),
    ).rejects.toThrow("reprovision the worker before launch");

    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
