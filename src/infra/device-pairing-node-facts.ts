import { updatePairedDeviceNodeSurfaceInTransaction } from "./device-pairing-store.js";
import {
  resolveNodePairingGeneration,
  withPairedDeviceRecords,
  type NodePairingGeneration,
  type PairedDevice,
} from "./device-pairing.js";

type NodeSurface = NonNullable<PairedDevice["nodeSurface"]>;

export async function updatePairedNodeGenerationSurface(params: {
  nodeId: string;
  expectedPairingGeneration: NodePairingGeneration;
  isCurrent?: (surface: NodeSurface) => boolean;
  update: (surface: NodeSurface) => NodeSurface;
  baseDir?: string;
}): Promise<boolean> {
  return await withPairedDeviceRecords<boolean>(params.baseDir, () => {
    const value = updatePairedDeviceNodeSurfaceInTransaction<boolean>(
      params.nodeId,
      params.baseDir,
      (device) => {
        if (
          !device?.nodeSurface ||
          params.isCurrent?.(device.nodeSurface) === false ||
          params.expectedPairingGeneration.nodeId !== device.deviceId ||
          resolveNodePairingGeneration(device)?.key !== params.expectedPairingGeneration.key
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
    // The row transaction validates durable generation ownership; the shared
    // lock also prevents a local full-snapshot writer from replaying old facts.
    return { value, persist: false };
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
