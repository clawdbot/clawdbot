import { describe, expect, it, vi } from "vitest";
import { installWorkerPlacementReconcileGuard } from "./server-worker-placement-reconcile-guard.js";

const localClaim = {
  owner: "local" as const,
  claimId: "claim-cleanup",
  runId: "run-cleanup",
  generation: 1,
  ownerEpoch: null,
};

function createFailedPlacementGuard(params: {
  turnClaim: typeof localClaim | null;
  activeOwnerEpoch: number | null;
  destroyRequestedAtMs: number | null;
}) {
  let guard:
    | ((environmentId: string, reconcileCore: () => Promise<void>) => Promise<void>)
    | undefined;
  const resumeProvisioning = vi.fn();
  installWorkerPlacementReconcileGuard({
    placements: {
      list: () => [
        {
          sessionId: "session-cleanup",
          state: "failed",
          environmentId: "worker-cleanup",
          turnClaim: params.turnClaim,
          activeOwnerEpoch: params.activeOwnerEpoch,
        },
      ],
    } as never,
    environments: {
      get: (environmentId: string) => ({
        environmentId,
        state: "provisioning",
        destroyRequestedAtMs: params.destroyRequestedAtMs,
      }),
      installReconcileEnvironmentGuard: (installed: typeof guard) => {
        guard = installed;
        return async () => {};
      },
    } as never,
    dispatch: { resumeProvisioning } as never,
    isStopping: () => false,
  });
  if (!guard) {
    throw new Error("worker placement reconciliation guard was not installed");
  }
  return { guard, resumeProvisioning };
}

describe("worker placement reconciliation teardown authority", () => {
  it("allows destruction only after its exact failed owner has released all authority", async () => {
    const { guard, resumeProvisioning } = createFailedPlacementGuard({
      turnClaim: null,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: 1,
    });
    const reconcileCore = vi.fn(async () => {});

    await guard("worker-cleanup", reconcileCore);

    expect(reconcileCore).toHaveBeenCalledOnce();
    expect(resumeProvisioning).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "a retained local turn claim",
      turnClaim: localClaim,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: 1,
    },
    {
      reason: "an active owner epoch",
      turnClaim: null,
      activeOwnerEpoch: 2,
      destroyRequestedAtMs: 1,
    },
    {
      reason: "no durable destruction request",
      turnClaim: null,
      activeOwnerEpoch: null,
      destroyRequestedAtMs: null,
    },
  ])("keeps failed-placement cleanup fenced with $reason", async ({ reason: _, ...params }) => {
    const { guard, resumeProvisioning } = createFailedPlacementGuard(params);
    const reconcileCore = vi.fn(async () => {});

    await expect(guard("worker-cleanup", reconcileCore)).rejects.toThrow(
      "provisioning owner is failed",
    );

    expect(reconcileCore).not.toHaveBeenCalled();
    expect(resumeProvisioning).not.toHaveBeenCalled();
  });
});
