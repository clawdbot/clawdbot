import { createHash } from "node:crypto";
import { hasEffectivePairedDeviceRole } from "../../infra/device-pairing.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import {
  formatNodeRunnerUpdateRequired,
  type NodeRunnerInventoryIssue,
} from "../../infra/node-runner-inventory.js";
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

type DeviceWorkerAvailability = {
  available: boolean;
  issue?: NodeRunnerInventoryIssue;
  unavailableReason?: "unpaired" | "disconnected" | "at-capacity";
};
type DeviceWorkerAvailabilityResolver = (deviceId: string) => Promise<DeviceWorkerAvailability>;
type DeviceWorkerReconciliation = (deviceId: string) => Promise<readonly string[]>;
const DEVICE_WORKER_AVAILABILITY = new WeakMap<object, DeviceWorkerAvailabilityResolver>();
const DEVICE_WORKER_RECONCILIATION = new WeakMap<object, DeviceWorkerReconciliation>();

export function bindDeviceWorkerAvailability(
  service: object,
  resolveAvailability: DeviceWorkerAvailabilityResolver,
): void {
  DEVICE_WORKER_AVAILABILITY.set(service, resolveAvailability);
}

export async function resolveDeviceWorkerAvailability(
  service: object | undefined,
  deviceId: string,
): Promise<DeviceWorkerAvailability> {
  const resolveAvailability = service ? DEVICE_WORKER_AVAILABILITY.get(service) : undefined;
  return resolveAvailability ? await resolveAvailability(deviceId) : { available: false };
}

export function deviceUnavailableText(deviceId: string, availability: DeviceWorkerAvailability) {
  if (availability.issue) {
    return formatNodeRunnerUpdateRequired(deviceId, availability.issue);
  }
  switch (availability.unavailableReason) {
    case "unpaired":
      return `device worker is not a paired node host: ${deviceId}`;
    case "disconnected":
      return `device worker node is not connected: ${deviceId}; reconnect it before retrying`;
    case "at-capacity":
      return `device worker is at capacity (all worker slots in use): ${deviceId}; retry after a running turn completes`;
    default:
      return `device worker availability is unknown: ${deviceId}; verify the node host is paired and connected, then retry`;
  }
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
  return node.workerHost.capacity === "available";
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
  const resolveAvailability = async (deviceId: string): Promise<DeviceWorkerAvailability> => {
    const [paired, connected] = await Promise.all([
      options.getPairedDevice(deviceId),
      findConnectedNode(deviceId),
    ]);
    // Connected hosts remain discoverable while full; capacity gates only new leases.
    const unavailableReason = !hasPairedNodeRole(paired)
      ? "unpaired"
      : !connected
        ? "disconnected"
        : !isSessionCapableNode(connected)
          ? "at-capacity"
          : undefined;
    const issue = nodeTransport?.getIssue?.(deviceId);
    return {
      available: unavailableReason === undefined,
      ...(issue ? { issue } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
    };
  };
  const provider: WorkerProvider = {
    id: DEVICE_WORKER_PROVIDER_ID,
    provisionBeforeInstallation: true,
    provision: async (profile, operationId) => {
      const deviceId = requireDeviceId(profile);
      const availability = await resolveAvailability(deviceId);
      if (!availability.available) {
        throw new WorkerProviderError(deviceUnavailableText(deviceId, availability));
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
    resolveAvailability,
    launchNodeWorker: launchAdapter.launch,
    getNodeTransport: () => nodeTransport,
    bindNodeTransport: (transport: NodeWorkerSupervisorTransport) => {
      nodeTransport = transport;
    },
  };
}
