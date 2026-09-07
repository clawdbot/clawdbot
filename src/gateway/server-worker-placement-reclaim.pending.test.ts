import { expect, it, vi } from "vitest";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";

it.each(["active", "failed"] as const)(
  "a %s reclaim whose canonical cancellation rejects still retires old pending work",
  async (state) => {
    const scope = `/fixture/cancel-failure-${state}.sqlite`;
    const sessionKey = "agent:main:cancel-failure";
    const sessionId = "cancel-failure-session";
    const entry = {
      sessionId,
      updatedAt: 1,
      worktree: { id: "cancel-failure-worktree" },
    };
    const target = {
      storePath: scope,
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      agentId: "main",
      store: { [sessionKey]: entry },
    };
    const cancellationFailure = new Error("canonical terminal drain rejected");
    const cancel = vi.fn(async () => {
      throw cancellationFailure;
    });
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements: {
        get: () => ({ state, sessionId }) as never,
        waitForTurnClaimRelease: vi.fn(),
      },
      loadSessionRuntime: async () =>
        ({
          managedWorktrees: {
            findLiveByOwner: () => ({
              id: "cancel-failure-worktree",
              ownerId: sessionKey,
              path: "/fixture/workspace",
            }),
          },
          resolveGatewaySessionStoreTargetWithStore: () => target,
          resolveCanonicalSessionEntryFromStoreKeys: () => entry,
        }) as never,
      cancelSessionWork: cancel,
      revokeSessionAuthority: vi.fn(),
    });
    const interrupted = vi.fn();
    const validated = vi.fn();
    const acquiredInterrupted = vi.fn();
    const acquired = await beginSessionWorkAdmission({
      scope,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: acquiredInterrupted,
    });
    const begin = vi.fn();
    const reclaim = vi.fn();
    let pending!: Promise<{ admitted: boolean; error?: unknown }>;
    try {
      await runExclusiveSessionLifecycleMutation({
        scope,
        identities: [sessionKey, sessionId],
        run: async () => {
          pending = beginSessionWorkAdmission({
            scope,
            identities: [sessionKey, sessionId],
            assertAllowed: validated,
            onInterrupt: interrupted,
          }).then(
            (lease) => {
              lease.release();
              return { admitted: true };
            },
            (error: unknown) => ({ admitted: false, error }),
          );
          const request = { sessionId, sessionKey, agentId: "main", begin, reclaim };
          const stop =
            state === "failed"
              ? barriers.runFailedReclaimBarrier(request)
              : barriers.runReclaimBarrier(request);
          await expect(stop).rejects.toBe(cancellationFailure);
        },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(begin).not.toHaveBeenCalled();
      expect(reclaim).not.toHaveBeenCalled();
      // Failed Stop never begins teardown; acquired runs retain canonical abort ordering.
      expect(acquiredInterrupted).not.toHaveBeenCalled();
      expect(await pending).toEqual({ admitted: false, error: expect.any(Error) });
      expect(interrupted).toHaveBeenCalledOnce();
      expect(validated).not.toHaveBeenCalled();
      const fresh = await beginSessionWorkAdmission({
        scope,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      fresh.release();
    } finally {
      acquired.release();
      await pending;
    }
  },
);
