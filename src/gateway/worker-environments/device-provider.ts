import { createHash } from "node:crypto";
import { hasEffectivePairedDeviceRole } from "../../infra/device-pairing.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import {
  WorkerProviderError,
  type WorkerProfile,
  type WorkerProvider,
} from "../../plugins/types.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

export const DEVICE_WORKER_PROVIDER_ID = "device";

type DeviceWorkerRuntimeOptions = {
  getPairedDevice: (deviceId: string) => Promise<PairedDevice | null>;
};

type DeviceWorkerAvailability = (deviceId: string) => Promise<boolean>;
const DEVICE_WORKER_AVAILABILITY = new WeakMap<object, DeviceWorkerAvailability>();

export function bindDeviceWorkerAvailability(
  service: WorkerEnvironmentServiceContract,
  isAvailable: DeviceWorkerAvailability,
): void {
  DEVICE_WORKER_AVAILABILITY.set(service, isAvailable);
}

export async function isDeviceWorkerAvailable(
  service: WorkerEnvironmentServiceContract | undefined,
  deviceId: string,
): Promise<boolean> {
  const isAvailable = service ? DEVICE_WORKER_AVAILABILITY.get(service) : undefined;
  return isAvailable ? await isAvailable(deviceId) : false;
}

function requireDeviceId(profile: WorkerProfile): string {
  const deviceId = profile.device;
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    throw new WorkerProviderError("device worker profile requires a device setting");
  }
  return deviceId.trim();
}

function isSessionCapableNode(node: NodeWorkerSupervisorNodeProof): boolean {
  return node.workerRuns !== undefined;
}

function hasPairedNodeRole(device: PairedDevice | null): device is PairedDevice {
  return Boolean(device && hasEffectivePairedDeviceRole(device, "node"));
}

function deviceLeaseId(deviceId: string, operationId: string): string {
  const deviceHash = createHash("sha256").update(deviceId).digest("hex");
  const operationHash = createHash("sha256").update(operationId).digest("hex");
  return `device:${deviceHash}:${operationHash.slice(0, 32)}`;
}

/** Core runtime for already-paired node hosts; pairing remains the durable trust owner. */
export function createDeviceWorkerRuntime(options: DeviceWorkerRuntimeOptions) {
  let nodeTransport: NodeWorkerSupervisorTransport | undefined;
  const launchAdapter = createNodeWorkerLaunchAdapter({ getTransport: () => nodeTransport });
  const findConnectedNode = async (deviceId: string) =>
    (await nodeTransport?.listCurrentNodes())?.find(
      (node) => node.nodeId === deviceId && isSessionCapableNode(node),
    );
  const isAvailable = async (deviceId: string) => {
    const [paired, connected] = await Promise.all([
      options.getPairedDevice(deviceId),
      findConnectedNode(deviceId),
    ]);
    return hasPairedNodeRole(paired) && Boolean(connected);
  };
  const provider: WorkerProvider = {
    id: DEVICE_WORKER_PROVIDER_ID,
    provisionBeforeInstallation: true,
    provision: async (profile, operationId) => {
      const deviceId = requireDeviceId(profile);
      if (!(await isAvailable(deviceId))) {
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

  return {
    provider,
    isAvailable,
    launchNodeWorker: launchAdapter.launch,
    // Provisioning reads the node-advertised local-install build through the
    // runtime so node lookups keep one owner; absent means not connected or
    // not session-capable, and the caller fails provisioning closed.
    resolveWorkerBuild: async (deviceId: string) => (await findConnectedNode(deviceId))?.workerRuns,
    bindNodeTransport: (transport: NodeWorkerSupervisorTransport) => {
      nodeTransport = transport;
    },
  };
}
