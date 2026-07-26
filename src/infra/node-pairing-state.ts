import { loadPairedDevicePairingStoreRecord } from "./device-pairing-store.js";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  resolveNodePairingGeneration,
  resolveNodePairingState,
  type NodePairingGeneration,
  type NodePairingState,
} from "./device-pairing.js";

export type { NodePairingGeneration, NodePairingIdentity } from "./device-pairing.js";

export type NodePairingBinding = {
  identity: string;
  generation?: string;
};

function toNodePairingBinding(state: NodePairingState | null): NodePairingBinding | undefined {
  return state
    ? {
        identity: state.identity.key,
        ...(state.generation ? { generation: state.generation.key } : {}),
      }
    : undefined;
}

/** Captures the persistent authenticated pairing and optional approved surface. */
export async function captureNodePairingState(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingState | null> {
  return resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
}

/** Registry projection of the current persistent pairing owner. */
export async function resolveCurrentNodePairingBinding(
  nodeId: string,
): Promise<NodePairingBinding | undefined> {
  return toNodePairingBinding(await captureNodePairingState(nodeId));
}

/** Synchronous registry projection for non-yielding process-local reads. */
export function isNodePairingBindingCurrent(nodeId: string, expected: NodePairingBinding): boolean {
  const current = toNodePairingBinding(
    resolveNodePairingState(loadPairedDevicePairingStoreRecord(nodeId)),
  );
  return Boolean(
    current &&
    current.identity === expected.identity &&
    (!expected.generation || current.generation === expected.generation),
  );
}

/** Captures the persistent node pairing generation admitted for new work. */
export async function captureNodePairingGeneration(
  nodeId: string,
): Promise<NodePairingGeneration | null> {
  return (await captureNodePairingState(nodeId))?.generation ?? null;
}

/** Binds a connected session to the exact device key and node token it authenticated with. */
export async function captureAuthenticatedNodePairingState(params: {
  nodeId: string;
  publicKey: string;
  token: string;
  baseDir?: string;
}): Promise<NodePairingState | null> {
  const device = await getPairedDevice(params.nodeId, params.baseDir);
  if (
    !device ||
    device.publicKey !== params.publicKey ||
    device.tokens?.node?.token !== params.token ||
    !hasEffectivePairedDeviceRole(device, "node")
  ) {
    return null;
  }
  return resolveNodePairingState(device);
}

/** Revalidates that asynchronous work still belongs to the admitted pairing. */
export async function isNodePairingGenerationCurrent(
  generation: NodePairingGeneration,
): Promise<boolean> {
  const current = resolveNodePairingGeneration(await getPairedDevice(generation.nodeId));
  return current?.key === generation.key;
}
