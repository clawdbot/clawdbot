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

/** Registry projection of a paired device's authenticated node-role state. */
export type PairedDeviceNodeBinding = {
  identity: string;
  generation?: string;
};

function toPairedDeviceNodeBinding(
  state: NodePairingState | null,
): PairedDeviceNodeBinding | undefined {
  return state
    ? {
        identity: state.identity.key,
        ...(state.generation ? { generation: state.generation.key } : {}),
      }
    : undefined;
}

export async function captureNodePairingState(
  nodeId: string,
  baseDir?: string,
): Promise<NodePairingState | null> {
  return resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
}

export async function resolveCurrentPairedDeviceNodeBinding(
  nodeId: string,
): Promise<PairedDeviceNodeBinding | undefined> {
  return toPairedDeviceNodeBinding(await captureNodePairingState(nodeId));
}

export function isPairedDeviceNodeBindingCurrent(
  nodeId: string,
  expected: PairedDeviceNodeBinding,
): boolean {
  const current = toPairedDeviceNodeBinding(
    resolveNodePairingState(loadPairedDevicePairingStoreRecord(nodeId)),
  );
  return Boolean(
    current &&
    current.identity === expected.identity &&
    (!expected.generation || current.generation === expected.generation),
  );
}

export async function captureNodePairingGeneration(
  nodeId: string,
): Promise<NodePairingGeneration | null> {
  return (await captureNodePairingState(nodeId))?.generation ?? null;
}

/** Binds a connected session to the exact device key and node token used for authentication. */
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

export async function isNodePairingGenerationCurrent(
  generation: NodePairingGeneration,
): Promise<boolean> {
  const current = resolveNodePairingGeneration(await getPairedDevice(generation.nodeId));
  return current?.key === generation.key;
}
