import { describe, expect, it, vi } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createPlacementSessionRetirement } from "./placement-session-retirement.js";
import type { WorkerSessionPlacementRetirement } from "./placement-store.js";

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

  it("fences a live environment before retiring its failed placement", async () => {
    const harness = createHarness([activePlacement("session-active")]);

    await harness.retirement.reconcile();

    expect(harness.forceDestroyEnvironment).toHaveBeenCalledWith(
      "environment:session-active",
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
});
