import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { collectSessionMaintenancePreserveKeys } from "../config/sessions/store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "../config/sessions/store-maintenance.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const runtimeFactoryMocks = vi.hoisted(() => ({
  createDispatch: vi.fn(),
  createDiskSpace: vi.fn(),
  createSessionEvidenceResolver: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("./worker-environments/placement-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/placement-dispatch.js")>()),
  createWorkerPlacementDispatchService: runtimeFactoryMocks.createDispatch,
}));

vi.mock("./server-worker-placement-session-evidence.js", () => ({
  createWorkerPlacementSessionEvidenceResolver: runtimeFactoryMocks.createSessionEvidenceResolver,
}));

vi.mock("./worker-environments/placement-disk-space.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-environments/placement-disk-space.js")>()),
  createWorkerPlacementDiskSpaceMonitor: runtimeFactoryMocks.createDiskSpace,
}));

import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

type PlacementFixture = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  state: WorkerSessionPlacementRecord["state"];
  generation: number;
  environmentId: string | null;
  activeOwnerEpoch: number | null;
  turnClaim: null;
};

function createPlacementFixture(
  sessionKey: string,
  state: WorkerSessionPlacementRecord["state"] = "active",
): PlacementFixture {
  const sessionId = `session-${sessionKey.slice(sessionKey.lastIndexOf(":") + 1)}`;
  return {
    sessionId,
    sessionKey,
    agentId: "main",
    state,
    generation: 1,
    environmentId: state === "local" || state === "requested" ? null : `environment-${sessionId}`,
    activeOwnerEpoch: state === "active" || state === "draining" ? 1 : null,
    turnClaim: null,
  };
}

function createMaintenanceRuntime(params: {
  placements: PlacementFixture[];
  onRecovery?: () => void;
  recoveryError?: Error;
  stopError?: Error;
}) {
  const forceDestroyEnvironment = vi.fn().mockResolvedValue(undefined);
  const goneEnvironmentIds = new Set<string>();
  runtimeFactoryMocks.createDiskSpace.mockReturnValue({
    read: vi.fn(),
    version: vi.fn(() => 0),
    sweep: vi.fn().mockResolvedValue(undefined),
  });
  runtimeFactoryMocks.createDispatch.mockReturnValue({
    dispatch: vi.fn(),
    forceDestroyEnvironment,
    reclaim: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    reconcileActive: vi.fn().mockResolvedValue(undefined),
  });
  runtimeFactoryMocks.createSessionEvidenceResolver.mockResolvedValue(async () => "current");
  const stop = vi.fn().mockResolvedValue(undefined);
  if (params.stopError) {
    stop.mockRejectedValueOnce(params.stopError);
  }
  const environments = {
    get: (environmentId: string) =>
      goneEnvironmentIds.has(environmentId)
        ? { state: "destroyed" as const, leaseId: null }
        : { state: "attached" as const, leaseId: "cloud-lease" },
    installReconcileEnvironmentGuard: vi.fn(() => vi.fn()),
    start: vi.fn(),
    stop,
  };
  const runtime = createGatewayWorkerPlacementRuntime({
    cancelSessionWork: vi.fn(async () => {}),
    placements: {
      workspaceResultInstanceId: () => "gateway-test",
      get: (sessionId: string) =>
        params.placements.find((placement) => placement.sessionId === sessionId),
      list: () => params.placements,
      listForReconcile: () =>
        params.placements.filter(
          (placement) => placement.state !== "local" && placement.state !== "reclaimed",
        ),
      retireSessionPlacement: vi.fn(),
      pruneOrphanedWorkspaceReconciliations: () => {
        params.onRecovery?.();
        if (params.recoveryError) {
          throw params.recoveryError;
        }
        return [];
      },
      listWorkspaceReconciliationOwners: () => [],
      listPendingWorkspaceResults: () => [],
    } as never,
    environments: environments as never,
    gatewayNamespace: "gateway-test",
    revokeSessionAuthority: vi.fn(),
    warn: vi.fn(),
  });
  return { environments, forceDestroyEnvironment, goneEnvironmentIds, runtime };
}

async function startMaintenanceRuntime(
  runtime: ReturnType<typeof createGatewayWorkerPlacementRuntime>,
) {
  const sidecar = await runtime.startRuntime({
    isClosePreludeStarted: () => false,
    registerSidecar: vi.fn(),
    unregisterSidecar: vi.fn(),
  });
  if (!sidecar) {
    throw new Error("worker placement runtime did not start");
  }
  return sidecar;
}

describe("worker placement session maintenance ownership", () => {
  it.each([
    { maintenance: "dashboard archive", sessionKey: "agent:main:dashboard:cloud-owned" },
    { maintenance: "stale pruning", sessionKey: "agent:main:explicit:cloud-owned-prune" },
    { maintenance: "entry capping", sessionKey: "agent:main:explicit:cloud-owned-cap" },
  ] as const)(
    "preserves active placements during write-triggered $maintenance and releases them on stop",
    async ({ maintenance, sessionKey }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const now = Date.now();
        const placement = createPlacementFixture(sessionKey);
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const sessionScope = (key: string) => ({
          agentId: "main",
          env: state.env,
          sessionKey: key,
          storePath,
        });
        const entry = {
          sessionId: placement.sessionId,
          updatedAt: maintenance === "entry capping" ? now - 1_000 : now - 31 * 86_400_000,
        };
        await patchSessionEntryCore(sessionScope(sessionKey), () => entry, {
          fallbackEntry: entry,
          replaceEntry: true,
          skipMaintenance: true,
        });
        const sentinelKey = "agent:main:explicit:maintenance-sentinel";
        const sentinelEntry = {
          sessionId: "maintenance-sentinel",
          updatedAt: now - 31 * 86_400_000,
        };
        await patchSessionEntryCore(sessionScope(sentinelKey), () => sentinelEntry, {
          fallbackEntry: sentinelEntry,
          replaceEntry: true,
          skipMaintenance: true,
        });
        const { forceDestroyEnvironment, runtime } = createMaintenanceRuntime({
          placements: [placement],
        });
        runtimeFactoryMocks.createSessionEvidenceResolver.mockImplementation(
          async () => async (candidate: { sessionKey: string }) =>
            loadSessionEntry(sessionScope(candidate.sessionKey)) ? "current" : "absent",
        );
        const sidecar = await startMaintenanceRuntime(runtime);
        const triggerEntry = { sessionId: "maintenance-trigger", updatedAt: now };
        const maintenanceConfig = resolveMaintenanceConfigFromInput({
          mode: "enforce",
          archiveDashboardAfter: "7d",
          pruneAfter: "30d",
          maxEntries: maintenance === "entry capping" ? 1 : 500,
          maxDiskBytes: false,
        });
        const triggerMaintenance = async () =>
          await patchSessionEntryCore(
            sessionScope("agent:main:explicit:maintenance-trigger"),
            () => triggerEntry,
            { fallbackEntry: triggerEntry, maintenanceConfig },
          );

        try {
          await triggerMaintenance();
          await vi.waitFor(() => {
            expect(loadSessionEntry(sessionScope(sentinelKey))).toBeUndefined();
          });
          expect(loadSessionEntry(sessionScope(sessionKey))).toMatchObject({
            sessionId: placement.sessionId,
          });
          expect(loadSessionEntry(sessionScope(sessionKey))?.archivedAt).toBeUndefined();
          expect(forceDestroyEnvironment).not.toHaveBeenCalled();
          expect(collectSessionMaintenancePreserveKeys()?.has(sessionKey)).toBe(true);

          await sidecar.stop();
          expect(collectSessionMaintenancePreserveKeys()?.has(sessionKey)).not.toBe(true);
          await triggerMaintenance();
          if (maintenance === "dashboard archive" || maintenance === "entry capping") {
            await vi.waitFor(() => {
              expect(loadSessionEntry(sessionScope(sessionKey))?.archivedAt).toEqual(
                expect.any(Number),
              );
            });
          } else {
            await vi.waitFor(() => {
              expect(loadSessionEntry(sessionScope(sessionKey))).toBeUndefined();
            });
          }
        } finally {
          await sidecar.stop();
        }
      });
    },
  );

  it("preserves every remote-owning state and releases failed placements once their environment is gone", async () => {
    const remoteOwningStates = [
      "requested",
      "provisioning",
      "syncing",
      "starting",
      "active",
      "draining",
      "reconciling",
    ] as const;
    const protectedPlacements = remoteOwningStates.map((placementState) =>
      createPlacementFixture(`agent:main:placement-${placementState}`, placementState),
    );
    const failedLive = createPlacementFixture("agent:main:failed-live", "failed");
    const failedGone = createPlacementFixture("agent:main:failed-gone", "failed");
    const local = createPlacementFixture("agent:main:placement-local", "local");
    const reclaimed = createPlacementFixture("agent:main:placement-reclaimed", "reclaimed");
    const { goneEnvironmentIds, runtime } = createMaintenanceRuntime({
      placements: [...protectedPlacements, failedLive, failedGone, local, reclaimed],
    });
    if (!failedLive.environmentId || !failedGone.environmentId) {
      throw new Error("failed placement fixtures are missing environment identities");
    }
    goneEnvironmentIds.add(failedGone.environmentId);
    const sidecar = await startMaintenanceRuntime(runtime);

    try {
      const preserveKeys = collectSessionMaintenancePreserveKeys();
      for (const placement of [...protectedPlacements, failedLive]) {
        expect(preserveKeys?.has(placement.sessionKey)).toBe(true);
      }
      for (const placement of [local, reclaimed, failedGone]) {
        expect(preserveKeys?.has(placement.sessionKey)).not.toBe(true);
      }

      goneEnvironmentIds.add(failedLive.environmentId);
      expect(collectSessionMaintenancePreserveKeys()?.has(failedLive.sessionKey)).not.toBe(true);
    } finally {
      await sidecar.stop();
    }
    expect(collectSessionMaintenancePreserveKeys()?.has("agent:main:placement-requested")).not.toBe(
      true,
    );
  });

  it("unregisters preservation synchronously when environment stop fails and is retried", async () => {
    const stopError = new Error("tunnel cleanup failed");
    const placement = createPlacementFixture("agent:main:failed-stop");
    const { environments, runtime } = createMaintenanceRuntime({
      placements: [placement],
      stopError,
    });
    const sidecar = await startMaintenanceRuntime(runtime);

    expect(collectSessionMaintenancePreserveKeys()?.has(placement.sessionKey)).toBe(true);
    const firstStop = sidecar.stop();
    expect(collectSessionMaintenancePreserveKeys()?.has(placement.sessionKey)).not.toBe(true);
    expect(sidecar.stop()).toBe(firstStop);
    await expect(firstStop).rejects.toBe(stopError);
    await expect(sidecar.stop()).resolves.toBeUndefined();
    expect(environments.stop).toHaveBeenCalledTimes(2);
  });

  it("unregisters preservation and its sidecar when initial workspace recovery fails", async () => {
    const recoveryError = new Error("workspace reconciliation inventory failed");
    const placement = createPlacementFixture("agent:main:failed-recovery");
    let protectedDuringRecovery = false;
    const { environments, runtime } = createMaintenanceRuntime({
      placements: [placement],
      recoveryError,
      onRecovery: () => {
        protectedDuringRecovery =
          collectSessionMaintenancePreserveKeys()?.has(placement.sessionKey) === true;
      },
    });
    const registerSidecar = vi.fn();
    const unregisterSidecar = vi.fn();

    await expect(
      runtime.startRuntime({
        isClosePreludeStarted: () => false,
        registerSidecar,
        unregisterSidecar,
      }),
    ).rejects.toBe(recoveryError);

    expect(protectedDuringRecovery).toBe(true);
    expect(registerSidecar).toHaveBeenCalledOnce();
    expect(unregisterSidecar).toHaveBeenCalledWith(registerSidecar.mock.calls[0]?.[0]);
    expect(environments.stop).toHaveBeenCalledOnce();
    expect(collectSessionMaintenancePreserveKeys()?.has(placement.sessionKey)).not.toBe(true);
  });
});
