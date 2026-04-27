import { summarizeMatrixDeviceHealth } from "../device-health.js";
import { withResolvedActionClient } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

export async function listMatrixOwnDevices(opts: MatrixActionClientOpts = {}) {
  return await withResolvedActionClient(opts, async (client) => await client.listOwnDevices());
}

export async function pruneMatrixStaleGatewayDevices(opts: MatrixActionClientOpts = {}) {
  return await withResolvedActionClient(opts, async (client) => {
    const devices = await client.listOwnDevices();
    const health = summarizeMatrixDeviceHealth(devices);
    const staleGatewayDeviceIds = health.staleOpenClawDevices.map((device) => device.deviceId);
    const deleted =
      staleGatewayDeviceIds.length > 0
        ? await client.deleteOwnDevices(staleGatewayDeviceIds)
        : {
            currentDeviceId: devices.find((device) => device.current)?.deviceId ?? null,
            deletedDeviceIds: [] as string[],
            remainingDevices: devices,
          };
    return {
      before: devices,
      staleGatewayDeviceIds,
      ...deleted,
    };
  });
}

export async function getMatrixDeviceHealth(opts: MatrixActionClientOpts = {}) {
  return await withResolvedActionClient(opts, async (client) =>
    summarizeMatrixDeviceHealth(await client.listOwnDevices()),
  );
}
