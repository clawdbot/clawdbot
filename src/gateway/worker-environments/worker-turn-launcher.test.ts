import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
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
  placements,
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

  it("runs an active remote-exec placement locally and reconciles before releasing its claim", async () => {
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
      get: vi.fn(() => attachedEnvironment()),
      startTunnel: vi.fn(async () => tunnel),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => {
      order.push("local");
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
  });

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
