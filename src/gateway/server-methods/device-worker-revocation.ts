import { reconcileDeviceWorker } from "../worker-environments/device-provider.js";
import type { GatewayRequestContext } from "./shared-types.js";

/** Reconciles worker authority after pairing removal without delaying token invalidation. */
type DeviceWorkerRevocationContext = Pick<
  GatewayRequestContext,
  "logGateway" | "workerEnvironmentService" | "workerPlacementDispatchService"
>;

export async function reconcileRevokedDeviceWorker(
  context: DeviceWorkerRevocationContext,
  deviceId: string,
): Promise<void> {
  const environmentIds = await reconcileDeviceWorker(context.workerEnvironmentService, deviceId);
  for (const environmentId of environmentIds) {
    try {
      await context.workerPlacementDispatchService?.reconcileActive?.(environmentId);
    } catch {
      context.logGateway.warn(
        `device worker placement reconciliation failed device=${deviceId} environment=${environmentId}`,
      );
    }
  }
}
