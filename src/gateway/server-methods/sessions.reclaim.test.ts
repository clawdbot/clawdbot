import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId,
  dispatchTestSessionKey,
  getDispatchTestMocks,
  invokeSessionReclaim,
  makeDispatchTestContext,
  makeReclaimedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const dispatchTestMocks = getDispatchTestMocks();

describe("sessions.reclaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchTestMocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId: dispatchTestSessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    dispatchTestMocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: dispatchTestSessionKey,
    });
  });

  it("reconciles and reclaims an active placement", async () => {
    const reclaim = vi.fn().mockResolvedValue(makeReclaimedPlacement());
    const respond = await invokeSessionReclaim(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () =>
            new Map([
              [
                dispatchTestSessionId,
                {
                  ...makeReclaimedPlacement(),
                  state: "active",
                  generation: 3,
                  recoveryError: null,
                } as WorkerSessionPlacementRecord,
              ],
            ]),
        },
      }),
    );

    expect(reclaim).toHaveBeenCalledWith({
      sessionId: dispatchTestSessionId,
      sessionKey: dispatchTestSessionKey,
      agentId: "main",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
  });

  it("returns an already reclaimed placement as idempotent success", async () => {
    const reclaim = vi.fn();
    const respond = await invokeSessionReclaim(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map([[dispatchTestSessionId, makeReclaimedPlacement()]]),
        },
      }),
    );

    expect(reclaim).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
  });

  it("rejects a missing placement", async () => {
    const reclaim = vi.fn();
    const respond = await invokeSessionReclaim(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map(),
        },
      }),
    );

    expect(reclaim).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.INVALID_REQUEST }),
    );
  });
});
