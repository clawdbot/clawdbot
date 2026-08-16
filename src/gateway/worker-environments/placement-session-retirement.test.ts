import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createPlacementSessionRetirement } from "./placement-session-retirement.js";
import {
  createWorkerSessionPlacementStore,
  WorkerSessionPlacementRetirementBlockedError,
  type WorkerSessionPlacementRetirement,
} from "./placement-store.js";

function localPlacement(
  sessionId: string,
): Extract<WorkerSessionPlacementRecord, { state: "local" }> {
  return {
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    agentId: "main",
    state: "local",
    executionMode: "worker-turn",
    generation: 1,
    turnClaim: null,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
  };
}

function activePlacement(
  sessionId: string,
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...localPlacement(sessionId),
    state: "active",
    generation: 2,
    turnClaim: null,
    environmentId: `environment:${sessionId}`,
    activeOwnerEpoch: 3,
    workspaceBaseManifestRef: "manifest",
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "a".repeat(64),
  };
}

function failedPlacement(
  placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
): Extract<WorkerSessionPlacementRecord, { state: "failed" }> {
  return {
    ...placement,
    state: "failed",
    generation: placement.generation + 1,
    turnClaim: null,
    recoveryError: "forced teardown",
    terminalReason: "failed",
    terminalAtMs: 2,
  };
}

function createHarness(records: WorkerSessionPlacementRecord[]) {
  const placements = new Map(records.map((record) => [record.sessionId, record]));
  const environments = new Map<
    string,
    { environmentId: string; state: "attached" | "destroyed"; leaseId: string | null }
  >(
    records.flatMap((record) =>
      record.environmentId
        ? [
            [
              record.environmentId,
              {
                environmentId: record.environmentId,
                state: "attached" as const,
                leaseId: `lease:${record.environmentId}`,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const retired: WorkerSessionPlacementRetirement[] = [];
  const resolveSessionEvidence = vi.fn(
    async (_placement: WorkerSessionPlacementRecord) => "absent" as const,
  );
  const createSessionEvidenceResolver = vi.fn(async () => resolveSessionEvidence);
  const forceDestroyEnvironment = vi.fn(async (environmentId: string) => {
    environments.set(environmentId, {
      environmentId,
      state: "destroyed",
      leaseId: null,
    });
    for (const record of placements.values()) {
      if (record.environmentId === environmentId && record.state === "active") {
        placements.set(record.sessionId, failedPlacement(record));
      }
    }
  });
  const retirement = createPlacementSessionRetirement({
    placements: {
      get: (sessionId) => placements.get(sessionId),
      list: () => [...placements.values()],
      retireSessionPlacement: (input) => {
        const current = placements.get(input.sessionId);
        if (
          current?.state !== input.expectedState ||
          current.generation !== input.expectedGeneration ||
          current.turnClaim
        ) {
          throw new Error("placement changed");
        }
        placements.delete(input.sessionId);
        retired.push(input);
      },
      isEnvironmentTeardownFenced: () => false,
    },
    environments: {
      get: (environmentId) => environments.get(environmentId) as never,
    },
    forceDestroyEnvironment,
    createSessionEvidenceResolver,
    warn: vi.fn(),
  });
  return {
    createSessionEvidenceResolver,
    forceDestroyEnvironment,
    placements,
    resolveSessionEvidence,
    retired,
    retirement,
  };
}

describe("placement session retirement", () => {
  it("retires an exact local placement after its session disappears", async () => {
    const harness = createHarness([localPlacement("session-local")]);

    await harness.retirement.reconcile();

    expect(harness.retired).toEqual([
      {
        sessionId: "session-local",
        expectedState: "local",
        expectedGeneration: 1,
      },
    ]);
    expect(harness.forceDestroyEnvironment).not.toHaveBeenCalled();
  });

  it("retires an exact ownerless requested placement after its session disappears", async () => {
    const root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-retirement-"),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const requested = placements.startDispatch({
      sessionId: "session-requested",
      sessionKey: "agent:main:session-requested",
      agentId: "main",
    });
    const ownedIdentity = {
      sessionId: "session-owned-requested",
      sessionKey: "agent:main:session-owned-requested",
      agentId: "main",
    };
    const ownedClaim = placements.claimTurn({
      ...ownedIdentity,
      owner: { kind: "local" },
      claimId: "requested-owner-claim",
      runId: "requested-owner-run",
    });
    const ownedRequested = placements.startDispatch(ownedIdentity);
    const retireSessionPlacement = vi.fn((input: WorkerSessionPlacementRetirement) =>
      placements.retireSessionPlacement(input),
    );
    const forceDestroyEnvironment = vi.fn();
    const warn = vi.fn();
    const retirement = createPlacementSessionRetirement({
      placements: {
        get: (sessionId) => placements.get(sessionId),
        isEnvironmentTeardownFenced: () => false,
        list: () => placements.list(),
        retireSessionPlacement,
      },
      environments: { get: () => undefined },
      forceDestroyEnvironment,
      createSessionEvidenceResolver: async () => async () => "absent",
      warn,
    });

    try {
      await retirement.reconcile();

      expect(retireSessionPlacement).toHaveBeenCalledWith({
        sessionId: requested.sessionId,
        expectedState: "requested",
        expectedGeneration: requested.generation,
      });
      expect(retireSessionPlacement).toHaveBeenCalledOnce();
      expect(placements.get(requested.sessionId)).toBeUndefined();
      expect(placements.get(ownedRequested.sessionId)).toMatchObject({
        state: "requested",
        generation: ownedRequested.generation,
        turnClaim: {
          owner: "local",
          claimId: ownedClaim.claimId,
          runId: ownedClaim.runId,
        },
      });
      expect(warn).toHaveBeenCalledWith(
        `Retired ownerless worker placement ${requested.sessionId} because its authoritative session is absent (requested@${requested.generation})`,
      );
      expect(forceDestroyEnvironment).not.toHaveBeenCalled();
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fences a live environment before retiring its failed placement", async () => {
    const harness = createHarness([activePlacement("session-active")]);

    await harness.retirement.reconcile();

    expect(harness.forceDestroyEnvironment).toHaveBeenCalledWith(
      "environment:session-active",
      expect.any(Function),
      expect.any(Function),
    );
    expect(harness.retired).toEqual([
      {
        sessionId: "session-active",
        expectedState: "failed",
        expectedGeneration: 3,
      },
    ]);
  });

  it("retains current and unknown session evidence", async () => {
    const current = localPlacement("session-current");
    const unknown = localPlacement("session-unknown");
    const harness = createHarness([current, unknown]);
    const retirement = createPlacementSessionRetirement({
      placements: {
        get: (sessionId) => harness.placements.get(sessionId),
        list: () => [...harness.placements.values()],
        retireSessionPlacement: () => {
          throw new Error("must not retire");
        },
        isEnvironmentTeardownFenced: () => false,
      },
      environments: { get: () => undefined },
      forceDestroyEnvironment: async () => {
        throw new Error("must not destroy");
      },
      createSessionEvidenceResolver: async () => async (placement) =>
        placement.sessionId === current.sessionId ? "current" : "unknown",
      warn: vi.fn(),
    });

    await retirement.reconcile();

    expect(harness.placements.size).toBe(2);
  });

  it("creates one evidence resolver for the reconcile snapshot", async () => {
    const placements = [localPlacement("session-one"), localPlacement("session-two")];
    const harness = createHarness(placements);

    await harness.retirement.reconcile();

    expect(harness.createSessionEvidenceResolver).toHaveBeenCalledOnce();
    expect(harness.createSessionEvidenceResolver).toHaveBeenCalledWith(placements);
    expect(harness.resolveSessionEvidence.mock.calls.map(([placement]) => placement)).toEqual(
      placements,
    );
  });

  it("reports automatic retirement deferred by retained workspace recovery", async () => {
    const placement = failedPlacement(activePlacement("session-retained"));
    const warn = vi.fn();
    const retirement = createPlacementSessionRetirement({
      placements: {
        get: () => placement,
        list: () => [placement],
        retireSessionPlacement: () => {
          throw new WorkerSessionPlacementRetirementBlockedError(placement.sessionId);
        },
        isEnvironmentTeardownFenced: () => true,
      },
      environments: {
        get: () => ({ state: "destroyed" }) as never,
      },
      forceDestroyEnvironment: async () => {
        throw new Error("must not destroy an already terminal environment");
      },
      createSessionEvidenceResolver: async () => async () => "absent",
      warn,
    });

    await retirement.reconcile();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Worker placement session retirement deferred for session-retained"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("force-abandoned"));
  });

  it("defers automatic teardown while a real pending result owns the active orphan", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-retire-"));
    try {
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
      const active = seedActivePlacement(placements, {
        environmentId: "environment:session-pending",
        ownerEpoch: 2,
      });
      if (active.state !== "active") {
        throw new Error("expected active placement fixture");
      }
      const claim = placements.claimTurn({
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
        claimId: "claim-pending-retirement",
        runId: "run-pending-retirement",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placements.markWorkspaceResultPending(claim);
      const forceDestroyEnvironment = vi.fn(async () => {});
      const warn = vi.fn();
      const retirement = createPlacementSessionRetirement({
        placements,
        environments: { get: () => ({ state: "attached" }) as never },
        forceDestroyEnvironment,
        createSessionEvidenceResolver: async () => async () => "absent",
        warn,
      });

      await retirement.reconcile();

      expect(forceDestroyEnvironment).not.toHaveBeenCalled();
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        turnClaim: { claimId: claim.claimId },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("explicit forced abandonment is required"),
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
