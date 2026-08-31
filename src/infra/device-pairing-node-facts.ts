import { withDevicePairingLock } from "./device-pairing-state.js";
import { updatePairedDeviceNodeSurfaceInTransaction } from "./device-pairing-store.js";
import {
  resolveNodePairingGeneration,
  type NodePairingGeneration,
  type PairedDevice,
} from "./device-pairing.js";

type NodeSurface = NonNullable<PairedDevice["nodeSurface"]>;

async function updatePairedNodeGenerationSurface(params: {
  nodeId: string;
  expectedPairingGeneration: NodePairingGeneration;
  isCurrent?: () => boolean;
  update: (surface: NodeSurface) => NodeSurface;
  baseDir?: string;
}): Promise<boolean> {
  return await withDevicePairingLock(async () => {
    return updatePairedDeviceNodeSurfaceInTransaction<boolean>(
      params.nodeId,
      params.baseDir,
      (device) => {
        const generation = resolveNodePairingGeneration(device);
        if (
          !device?.nodeSurface ||
          params.isCurrent?.() === false ||
          params.expectedPairingGeneration.nodeId !== device.deviceId ||
          generation?.key !== params.expectedPairingGeneration.key
        ) {
          return { value: false, persist: false };
        }
        return {
          value: true,
          persist: true,
          nodeSurface: params.update(device.nodeSurface),
        };
      },
    );
  });
}

/** Update the remote skill bins advertised by a paired node. */
export async function updatePairedNodeBins(
  nodeId: string,
  bins: string[],
  expectedPairingGeneration: NodePairingGeneration,
  baseDir?: string,
): Promise<boolean> {
  return await updatePairedNodeGenerationSurface({
    nodeId,
    expectedPairingGeneration,
    update: (surface) => ({ ...surface, bins }),
    baseDir,
  });
}

/** Persist current runner-host consent for one exact node connection generation. */
export async function updatePairedNodeSessionHost(params: {
  nodeId: string;
  sessionHost: boolean;
  expectedPairingGeneration: NodePairingGeneration;
  isConnectionCurrent: () => boolean;
  baseDir?: string;
}): Promise<boolean> {
  return await updatePairedNodeGenerationSurface({
    ...params,
    isCurrent: params.isConnectionCurrent,
    update: (surface) => ({ ...surface, sessionHost: params.sessionHost }),
  });
}
