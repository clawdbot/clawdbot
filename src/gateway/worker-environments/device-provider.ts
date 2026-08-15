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

export const DEVICE_WORKER_PROVIDER_ID = "device";
const DEVICE_WORKER_DORMANCY_MS = 14 * 24 * 60 * 60 * 1_000;

type DeviceWorkerRuntimeOptions = {
  getPairedDevice: (deviceId: string) => Promise<PairedDevice | null>;
  now?: () => number;
};

type DeviceWorkerAvailability = (deviceId: string) => Promise<boolean>;
type DeviceWorkerReconciliation = (deviceId: string) => Promise<readonly string[]>;
const DEVICE_WORKER_AVAILABILITY = new WeakMap<object, DeviceWorkerAvailability>();
const DEVICE_WORKER_RECONCILIATION = new WeakMap<object, DeviceWorkerReconciliation>();

export function bindDeviceWorkerAvailability(
  service: object,
  isAvailable: DeviceWorkerAvailability,
): void {
  DEVICE_WORKER_AVAILABILITY.set(service, isAvailable);
}

export async function isDeviceWorkerAvailable(
  service: object | undefined,
  deviceId: string,
): Promise<boolean> {
  const isAvailable = service ? DEVICE_WORKER_AVAILABILITY.get(service) : undefined;
  return isAvailable ? await isAvailable(deviceId) : false;
}

export function bindDeviceWorkerReconciliation(
  service: object,
  reconcile: DeviceWorkerReconciliation,
): void {
  DEVICE_WORKER_RECONCILIATION.set(service, reconcile);
}

export async function reconcileDeviceWorker(
  service: object | undefined,
  deviceId: string,
): Promise<readonly string[]> {
  const reconcile = service ? DEVICE_WORKER_RECONCILIATION.get(service) : undefined;
  return reconcile ? await reconcile(deviceId) : [];
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

function isWithinDeviceDormancy(device: PairedDevice, nowMs: number): boolean {
  const disconnectedAtMs = device.nodeSurface?.lastDisconnectedAtMs;
  // Legacy or crash-interrupted records have no exact disconnect boundary. Keep
  // them fail-safe dormant until a later connection lifecycle records one.
  return disconnectedAtMs === undefined || nowMs - disconnectedAtMs < DEVICE_WORKER_DORMANCY_MS;
}

function deviceLeaseId(deviceId: string, operationId: string): string {
  const deviceHash = createHash("sha256").update(deviceId).digest("hex");
  const operationHash = createHash("sha256").update(operationId).digest("hex");
  return `device:${deviceHash}:${operationHash.slice(0, 32)}`;
}

/** Core runtime for already-paired node hosts; pairing remains the durable trust owner. */
export function createDeviceWorkerRuntime(options: DeviceWorkerRuntimeOptions) {
  const now = options.now ?? Date.now;
  let nodeTransport: NodeWorkerSupervisorTransport | undefined;
  const launchAdapter = createNodeWorkerLaunchAdapter({ getTransport: () => nodeTransport });
  const findConnectedNode = async (deviceId: string) =>
    (await nodeTransport?.listCurrentNodes())?.find((node) => node.nodeId === deviceId);
  const findAvailableNode = async (deviceId: string) => {
    const node = await findConnectedNode(deviceId);
    return node && isSessionCapableNode(node) ? node : undefined;
  };
  const isAvailable = async (deviceId: string) => {
    const [paired, connected] = await Promise.all([
      options.getPairedDevice(deviceId),
      findAvailableNode(deviceId),
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
      if (connected) {
        return { status: "active", sharedHost: true };
      }
      return isWithinDeviceDormancy(paired, now()) ? { status: "dormant" } : { status: "unknown" };
    },
    destroy: async () => {},
  };

  return {
    provider,
    isAvailable,
    launchNodeWorker: launchAdapter.launch,
    getNodeTransport: () => nodeTransport,
    // Provisioning reads the node-advertised local-install build through the
    // runtime so node lookups keep one owner; absent means not connected or
    // not session-capable, and the caller fails provisioning closed.
    resolveWorkerBuild: async (deviceId: string) => (await findAvailableNode(deviceId))?.workerRuns,
    bindNodeTransport: (transport: NodeWorkerSupervisorTransport) => {
      nodeTransport = transport;
    },
  };
}
