import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const runtimeMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
}));

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>();
  return { ...actual, createWorkerPlacementDispatchService: runtimeMocks.createDispatch };
});

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>();
  return { ...actual, createWorkerPlacementDiskSpaceMonitor: runtimeMocks.createDiskSpace };
});

import {
  flushPendingSessionsChangedEvents,
  readSessionsMutationVersion,
} from "./server-methods/session-change-event.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

describe("worker placement recovery session events", () => {
  it("publishes a later recovered move through the Gateway session event and cache fence", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      const context = {
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(["session-observer"]),
      };
      const recovered = {
        sessionId: "session-recovered",
        sessionKey: "agent:main:move-source",
        agentId: "main",
        state: "local" as const,
      };
      let currentPlacement: typeof recovered | undefined;
      let sweepCount = 0;
      runtimeMocks.createDiskSpace.mockReturnValue({
        read: vi.fn(),
        version: vi.fn(() => 0),
        sweep: vi.fn().mockResolvedValue(undefined),
      });
      runtimeMocks.createDispatch.mockImplementation((options) => ({
        dispatch: vi.fn(),
        forceDestroyEnvironment: vi.fn(),
        reclaim: vi.fn(),
        reconcile: vi.fn().mockResolvedValue(undefined),
        reconcileActive: vi.fn(async () => {
          sweepCount += 1;
          if (sweepCount === 2) {
            currentPlacement = recovered;
            options.onRecoveredMoveTransition?.(recovered);
          }
        }),
      }));
      const environments = {
        installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
        start: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const runtime = createGatewayWorkerPlacementRuntime({
        placements: {
          workspaceResultInstanceId: () => "gateway-test",
          get: () => currentPlacement,
          list: () => [],
          retireSessionPlacement: vi.fn(),
          pruneOrphanedWorkspaceReconciliations: () => [],
          listWorkspaceReconciliationOwners: () => [],
          listPendingWorkspaceResults: () => [],
        } as never,
        environments: environments as never,
        gatewayNamespace: "gateway-test",
        getSessionChangeContext: () => {
          expect(currentPlacement).toBe(recovered);
          return context;
        },
        revokeSessionAuthority: vi.fn(),
        warn: vi.fn(),
      });
      const initialMutationVersion = readSessionsMutationVersion(context);
      let sidecar: Awaited<ReturnType<typeof runtime.startRuntime>> = null;

      try {
        sidecar = await runtime.startRuntime({
          isClosePreludeStarted: () => false,
          registerSidecar: vi.fn(),
          unregisterSidecar: vi.fn(),
        });
        if (!sidecar) {
          throw new Error("worker placement runtime did not start");
        }

        await vi.advanceTimersByTimeAsync(60_000);
        expect(context.broadcastToConnIds).not.toHaveBeenCalled();
        expect(readSessionsMutationVersion(context)).toBe(initialMutationVersion);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(context.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "move",
            sessionKey: recovered.sessionKey,
            agentId: recovered.agentId,
          }),
          new Set(["session-observer"]),
          expect.objectContaining({ agentId: recovered.agentId, dropIfSlow: true }),
        );
        expect(readSessionsMutationVersion(context)).toBe(initialMutationVersion + 1);
      } finally {
        await sidecar?.stop();
        flushPendingSessionsChangedEvents(context);
        vi.useRealTimers();
      }
    });
  });
});
