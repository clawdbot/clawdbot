import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  admittedRecovery,
  createCoordinatorTestService,
  LOCAL_PLACEMENT,
  MOVE_REQUEST,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

describe("worker placement maintenance admission", () => {
  it.each(["full", "targeted", "recovery"] as const)(
    "bounds dispatch joins to the original provider cohort before %s maintenance",
    async (kind) => {
      const cloudStarted = createDeferredCore();
      const releaseCloud = createDeferredCore();
      const releaseMac = createDeferredCore();
      const maintenanceStarted = createDeferredCore();
      const releaseMaintenance = createDeferredCore();
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
        if (request.sessionId === "cloud") {
          cloudStarted.resolve();
          await releaseCloud.promise;
        } else if (request.sessionId === REQUEST.sessionId) {
          await releaseMac.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      });
      const maintain = async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
      };
      const service = createCoordinatorTestService({
        dispatch,
        reconcileActive: maintain,
        resumeProvisioning: admittedRecovery(maintain),
      });
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const cloud = coordinated.dispatch({ ...REQUEST, sessionId: "cloud" });
      await cloudStarted.promise;
      const maintenance =
        kind === "recovery"
          ? coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {})
          : coordinated.reconcileActive(kind === "targeted" ? "worker-target" : undefined);
      const mac = coordinated.dispatch(REQUEST);
      let callsBeforeCloudSettled: string[];
      let late: Promise<unknown> | undefined;
      let third: Promise<unknown> | undefined;
      let laterMaintenance: Promise<unknown> | undefined;
      try {
        await setImmediatePromise();
        callsBeforeCloudSettled = dispatch.mock.calls.map(([request]) => request.sessionId);
        releaseCloud.resolve();
        await cloud;
        laterMaintenance = coordinated.reconcileActive("worker-later");
        third = coordinated.dispatch({ ...REQUEST, sessionId: "third" });
        await setImmediatePromise();
        expect(dispatch.mock.calls.some(([request]) => request.sessionId === "third")).toBe(false);
        releaseMac.resolve();
        await maintenanceStarted.promise;
        late = coordinated.dispatch({ ...REQUEST, sessionId: "late" });
        await setImmediatePromise();
        expect(dispatch.mock.calls.some(([request]) => request.sessionId === "late")).toBe(false);
      } finally {
        releaseCloud.resolve();
        releaseMac.resolve();
        releaseMaintenance.resolve();
        await Promise.all([cloud, maintenance, mac, third, laterMaintenance, late]);
      }
      expect(callsBeforeCloudSettled).toEqual(["cloud", REQUEST.sessionId]);
    },
  );

  it.each(
    [
      { kind: "move", order: "before" },
      { kind: "move", order: "after" },
      { kind: "reclaim", order: "before" },
      { kind: "reclaim", order: "after" },
      { kind: "destroy", order: "before" },
      { kind: "destroy", order: "after" },
    ].flatMap(({ kind, order }) =>
      ["sweep", "recovery"].map((maintenanceKind) => ({ kind, order, maintenanceKind })),
    ),
  )(
    "a queued $kind closes dispatch admission $order pending $maintenanceKind",
    async ({ kind, order, maintenanceKind }) => {
      const cloudStarted = createDeferredCore();
      const releaseCloud = createDeferredCore();
      const exclusiveStarted = createDeferredCore();
      const releaseExclusive = createDeferredCore();
      const destroyError = new Error("Provider teardown failed");
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
        if (request.sessionId === "cloud") {
          cloudStarted.resolve();
          await releaseCloud.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      });
      const exclusive = async () => {
        exclusiveStarted.resolve();
        await releaseExclusive.promise;
        return LOCAL_PLACEMENT;
      };
      const service = createCoordinatorTestService({
        dispatch,
        move: exclusive,
        reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
          if (!serialize) {
            throw new Error("Reclaim fixture requires the placement fence");
          }
          return await serialize(exclusive);
        },
        forceDestroyEnvironment: async () => {
          await exclusive();
          throw destroyError;
        },
        reconcileActive: async () => {},
        resumeProvisioning: admittedRecovery(async () => {}),
      });
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const maintain = () =>
        maintenanceKind === "sweep"
          ? coordinated.reconcileActive()
          : coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
      const cloud = coordinated.dispatch({ ...REQUEST, sessionId: "cloud" });
      await cloudStarted.promise;
      let maintenance = order === "after" ? maintain() : undefined;
      const hard =
        kind === "move"
          ? coordinated.move(MOVE_REQUEST)
          : kind === "reclaim"
            ? coordinated.reclaim(REQUEST)
            : coordinated.forceDestroyEnvironment("worker-exclusive").then(
                () => {
                  throw new Error("Expected teardown failure");
                },
                (error: unknown) => expect(error).toBe(destroyError),
              );
      // Move admission yields before it reserves its placement fence.
      await setImmediatePromise();
      maintenance ??= maintain();
      const later = coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      try {
        await setImmediatePromise();
        expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["cloud"]);
        releaseCloud.resolve();
        await exclusiveStarted.promise;
        await setImmediatePromise();
        expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["cloud"]);
      } finally {
        releaseCloud.resolve();
        releaseExclusive.resolve();
        await Promise.all([cloud, maintenance, hard, later]);
      }
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
        "cloud",
        "unrelated",
      ]);
    },
  );
});
