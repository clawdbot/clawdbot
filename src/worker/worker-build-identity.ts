import type { WorkerAdmissionHandshake } from "../../packages/gateway-protocol/src/schema/worker-admission.js";

export type ExpectedWorkerBuild = {
  bundleHash: WorkerAdmissionHandshake["bundleHash"];
  openclawVersion: WorkerAdmissionHandshake["openclawVersion"];
  protocolFeatures: readonly string[];
};

export function sameWorkerProtocolFeatures(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = left.toSorted();
  const normalizedRight = right.toSorted();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

/** Compares the exact worker build while treating protocol features as an unordered set. */
export function sameWorkerBuild(left: ExpectedWorkerBuild, right: ExpectedWorkerBuild): boolean {
  return (
    left.bundleHash === right.bundleHash &&
    left.openclawVersion === right.openclawVersion &&
    sameWorkerProtocolFeatures(left.protocolFeatures, right.protocolFeatures)
  );
}
