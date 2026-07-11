import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";

/** Admits only the exact build selected for this worker environment. */
export function verifyWorkerAdmissionHandshake(
  handshake: WorkerAdmissionHandshake,
  expectedBundleHash: string,
): boolean {
  return handshake.bundleHash === expectedBundleHash;
}
