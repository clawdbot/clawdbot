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

  it("delegates a failed placement to the reclaim owner", async () => {
    const failed = {
      ...makeReclaimedPlacement(),
      state: "failed",
      environmentId: null,
      activeOwnerEpoch: null,
      workspaceBaseManifestRef: null,
      remoteWorkspaceDir: null,
      workerBundleHash: null,
      recoveryError: "device worker is offline",
      terminalReason: "device worker is offline",
    } as WorkerSessionPlacementRecord;
    const local = {
      ...failed,
      state: "local",
      generation: failed.generation + 1,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
    } as WorkerSessionPlacementRecord;
    const reclaim = vi.fn().mockResolvedValue(local);
    const respond = await invokeSessionReclaim(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map([[dispatchTestSessionId, failed]]),
        },
      }),
    );

    expect(reclaim).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "local" }),
      }),
      undefined,
    );
  });

  it("requires permanent abandonment before reclaiming retained workspace recovery", async () => {
    const reclaim = vi.fn();
    const failed = {
      ...makeReclaimedPlacement(),
      state: "failed",
      recoveryError: "workspace recovery requires operator action",
      terminalReason: "workspace recovery requires operator action",
      terminalRecovery: {
        action: "force-destroy-environment",
        dataLoss: "unreconciled-workspace-result",
      },
    } as WorkerSessionPlacementRecord;
    const respond = await invokeSessionReclaim(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map([[dispatchTestSessionId, failed]]),
        },
      }),
    );

    expect(reclaim).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message:
          "cloud worker retains unreconciled workspace changes; call environments.destroy with force=true (or use Stop cloud worker and confirm permanent abandonment) before reclaim or redispatch",
      }),
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
