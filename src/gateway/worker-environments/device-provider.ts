import { createHash } from "node:crypto";
import { hasEffectivePairedDeviceRole } from "../../infra/device-pairing.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import {
  WorkerProviderError,
  type WorkerProfile,
  type WorkerProvider,
} from "../../plugins/types.js";

export const DEVICE_WORKER_PROVIDER_ID = "device";

type DeviceWorkerNode = {
  nodeId: string;
  commands: readonly string[];
};

type DeviceWorkerProviderOptions = {
  getPairedDevice: (deviceId: string) => Promise<PairedDevice | null>;
  listConnectedNodes: () => Promise<readonly DeviceWorkerNode[]>;
};

function requireDeviceId(profile: WorkerProfile): string {
  const deviceId = profile.device;
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    throw new WorkerProviderError("device worker profile requires a device setting");
  }
  return deviceId.trim();
}

function isSessionCapableNode(node: DeviceWorkerNode): boolean {
  return node.commands.includes("system.run");
}

function hasPairedNodeRole(device: PairedDevice | null): device is PairedDevice {
  return Boolean(device && hasEffectivePairedDeviceRole(device, "node"));
}

function deviceLeaseId(deviceId: string, operationId: string): string {
  const deviceHash = createHash("sha256").update(deviceId).digest("hex");
  const operationHash = createHash("sha256").update(operationId).digest("hex");
  return `device:${deviceHash}:${operationHash.slice(0, 32)}`;
}

/** Core provider for already-paired node hosts; pairing remains the durable trust owner. */
export function createDeviceWorkerProvider(options: DeviceWorkerProviderOptions): WorkerProvider {
  const findConnectedNode = async (deviceId: string) =>
    (await options.listConnectedNodes()).find(
      (node) => node.nodeId === deviceId && isSessionCapableNode(node),
    );

  return {
    id: DEVICE_WORKER_PROVIDER_ID,
    provisionBeforeInstallation: true,
    provision: async (profile, operationId) => {
      const deviceId = requireDeviceId(profile);
      const [paired, connected] = await Promise.all([
        options.getPairedDevice(deviceId),
        findConnectedNode(deviceId),
      ]);
      if (!hasPairedNodeRole(paired) || !connected) {
        throw new WorkerProviderError(
          `device worker is not a connected session-capable paired node: ${deviceId}`,
        );
      }
      return {
        leaseId: deviceLeaseId(deviceId, operationId),
        node: { deviceId },
        sharedHost: true,
      };
    },
    inspect: async ({ profile }) => {
      const deviceId = requireDeviceId(profile);
      const paired = await options.getPairedDevice(deviceId);
      if (!hasPairedNodeRole(paired)) {
        return { status: "unknown" };
      }
      const connected = await findConnectedNode(deviceId);
      return connected ? { status: "active", sharedHost: true } : { status: "dormant" };
    },
    destroy: async () => {},
  };
}
