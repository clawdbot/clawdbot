import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerPlacementMoveService } from "../worker-environments/placement-move-service.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  invokeSessionMove,
  makeDispatchTestContext,
  makeReclaimedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();

function activePlacement(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...makeReclaimedPlacement(),
    state: "active",
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

describe("sessions.move abandonment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId,
        agentRuntimeOverride: "openclaw",
        worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
    });
  });

  it.each([
    { name: "starts an active abandonment", joined: false },
    { name: "joins an exact draining abandonment retry", joined: true },
  ])("$name and returns local while remote settlement remains unresolved", async ({ joined }) => {
    const source = { generation: 4, environmentId: "environment-previous", ownerEpoch: 1 };
    const active = activePlacement();
    const draining = { ...active, state: "draining" as const, generation: 5 };
    const existing = joined ? draining : active;
    const local = {
      ...active,
      state: "local" as const,
      generation: 9,
      environmentId: null,
      activeOwnerEpoch: null,
      turnClaim: null,
    };
    const recordPlacementMoveError = vi.fn();
    const validateAbandonSource = vi.fn();
    let remoteSettlementObserved = false;
    const remoteSettlement = new Promise<void>(() => {});
    void remoteSettlement.then(() => {
      remoteSettlementObserved = true;
    });
    const moves = createWorkerPlacementMoveService({
      placements: {
        preparePlacementMove: async (_request: unknown, prepareNew: () => Promise<void>) => {
          if (!joined) {
            await prepareNew();
          }
          return {
            intent: {
              operationId: "move:v1:rpc-abandon",
              sessionId,
              source,
              target: { kind: "gateway" },
              abandonSource: true,
              lastError: null,
              createdAtMs: 1,
              updatedAtMs: 1,
            },
            placement: draining,
            joined,
          };
        },
        get: () => existing,
        getPlacementMove: () => undefined,
        recordPlacementMoveError,
      } as never,
      environments: { get: () => undefined },
      runMoveBarrier: async (params) => {
        const begun = await params.begin();
        if (params.sourceDisposition !== "abandon") {
          throw new Error("placement move interrupted");
        }
        return begun;
      },
      dispatch: vi.fn(),
      reclaimSource: vi.fn(),
      validateAbandonSource,
      abandonSource: vi.fn(async () => local as never),
      resolveDestination: vi.fn(),
    });

    const respond = await invokeSessionMove(
      makeDispatchTestContext({
        getSessionEventSubscriberConnIds: () => new Set(),
        workerPlacementDispatchService: { dispatch: vi.fn(), move: moves.move } as never,
        workerSessionPlacementService: {
          getMany: () => new Map([[sessionId, existing]]),
        },
      }),
      { expected: source, target: { kind: "gateway" }, abandonSource: true },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        key: sessionKey,
        sessionId,
        placement: { state: "local", generation: 9 },
      },
      undefined,
    );
    expect(validateAbandonSource).toHaveBeenCalledTimes(joined ? 0 : 1);
    expect(recordPlacementMoveError).not.toHaveBeenCalled();
    expect(remoteSettlementObserved).toBe(false);
  });
});
