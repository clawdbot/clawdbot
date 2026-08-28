import { beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  flushPendingSessionsChangedEvents,
  readSessionsMutationVersion,
} from "./session-change-event.js";
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

    expect(reclaim).toHaveBeenCalledWith(
      {
        sessionId: dispatchTestSessionId,
        sessionKey: dispatchTestSessionKey,
        agentId: "main",
      },
      undefined,
    );
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
    const reclaimed = makeReclaimedPlacement();
    const reclaim = vi.fn().mockResolvedValue(reclaimed);
    const context = makeDispatchTestContext({
      workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
      workerSessionPlacementService: {
        getMany: () => new Map([[dispatchTestSessionId, reclaimed]]),
      },
    });
    const respond = await invokeSessionReclaim(context);

    expect(reclaim).toHaveBeenCalledWith(
      {
        sessionId: dispatchTestSessionId,
        sessionKey: dispatchTestSessionKey,
        agentId: "main",
      },
      undefined,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
    expect(readSessionsMutationVersion(context)).toBe(0);
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

  it("delegates placement visibility races to the reclaim owner", async () => {
    const reclaim = vi.fn().mockResolvedValue(makeReclaimedPlacement());
    const respond = await invokeSessionReclaim(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
        workerSessionPlacementService: {
          getMany: () => new Map(),
        },
      }),
    );

    expect(reclaim).toHaveBeenCalledWith(
      {
        sessionId: dispatchTestSessionId,
        sessionKey: dispatchTestSessionKey,
        agentId: "main",
      },
      undefined,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
  });

  it("does not let session change reporting failure replace a committed reclaim", async () => {
    const active = {
      ...makeReclaimedPlacement(),
      state: "active",
      generation: 3,
      updatedAtMs: 1,
      recoveryError: null,
    } as WorkerSessionPlacementRecord;
    const reclaimed = makeReclaimedPlacement();
    const context = makeDispatchTestContext({
      getSessionEventSubscriberConnIds: () => {
        throw new Error("session subscribers unavailable");
      },
      workerPlacementDispatchService: {
        dispatch: vi.fn(),
        reclaim: vi.fn().mockResolvedValue(reclaimed),
      },
      workerSessionPlacementService: {
        getMany: () => new Map([[dispatchTestSessionId, active]]),
      },
    });

    const respond = await invokeSessionReclaim(context);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "reclaimed" }),
      }),
      undefined,
    );
    expect(readSessionsMutationVersion(context)).toBe(1);
  });

  it.each(["success", "persisted failure"] as const)(
    "publishes a %s placement change to another session subscriber",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        let placement: WorkerSessionPlacementRecord = {
          ...makeReclaimedPlacement(),
          state: "active",
          generation: 3,
          updatedAtMs: 1,
          recoveryError: null,
          terminalReason: null,
          terminalAtMs: null,
        };
        const reclaimError = new Error("worker teardown failed after committing placement");
        const reclaim = vi.fn(async () => {
          if (outcome === "persisted failure") {
            placement = {
              ...placement,
              state: "failed",
              generation: placement.generation + 1,
              updatedAtMs: placement.updatedAtMs + 1,
              recoveryError: reclaimError.message,
            } as WorkerSessionPlacementRecord;
            throw reclaimError;
          }
          placement = makeReclaimedPlacement();
          return placement;
        });
        const context = makeDispatchTestContext({
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(["another-client"]),
          workerPlacementDispatchService: { dispatch: vi.fn(), reclaim },
          workerSessionPlacementService: {
            getMany: () => new Map([[dispatchTestSessionId, placement]]),
          },
        });

        try {
          const respond = await invokeSessionReclaim(context);

          expect(respond).toHaveBeenCalledWith(
            outcome === "success",
            outcome === "success" ? expect.objectContaining({ ok: true }) : undefined,
            outcome === "success"
              ? undefined
              : expect.objectContaining({ message: reclaimError.message }),
          );
          expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            expect.objectContaining({ reason: "reclaim", sessionKey: dispatchTestSessionKey }),
            new Set(["another-client"]),
            expect.objectContaining({ agentId: "main", dropIfSlow: true }),
          );
          expect(readSessionsMutationVersion(context)).toBe(1);
        } finally {
          flushPendingSessionsChangedEvents(context);
        }
      });
    },
  );
});
