import { expectDefined } from "@openclaw/normalization-core";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "./device-pairing-node.js";
import {
  getPairedDevice,
  requestDevicePairing,
  resolveNodePairingGeneration,
} from "./device-pairing.js";

export async function seedNodeDevice(baseDir: string, nodeId: string): Promise<void> {
  const request = await requestDevicePairing(
    {
      deviceId: nodeId,
      publicKey: `test-key-${nodeId}`,
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
}

export async function setupPairedNode(baseDir: string, displayName?: string) {
  await seedNodeDevice(baseDir, "node-1");
  const request = await requestNodePairing(
    {
      nodeId: "node-1",
      displayName,
      platform: "darwin",
      commands: ["system.run"],
    },
    baseDir,
  );
  await approveNodePairing(
    request.request.requestId,
    { callerScopes: ["operator.pairing", "operator.admin"] },
    baseDir,
  );
  return expectDefined(
    resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
    "node pairing generation",
  );
}
