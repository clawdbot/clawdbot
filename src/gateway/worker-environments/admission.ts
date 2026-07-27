import {
  type WorkerAdmissionFailureReason,
  type WorkerAdmissionHandshake,
  type WorkerConnectParams,
  type WorkerProtocolCloseReason,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { hashWorkerCredential } from "./credential.js";
import type { WorkerEnvironmentStore } from "./store.js";

export type { WorkerConnectionIdentity } from "./connection-identity.js";

export type ExpectedWorkerBuild = {
  bundleHash: string;
  openclawVersion: string;
  protocolFeatures: readonly string[];
};

type WorkerConnectionAdmissionResult =
  | { ok: true; identity: WorkerConnectionIdentity }
  | { ok: false; reason: WorkerAdmissionFailureReason };

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = left.toSorted();
  const normalizedRight = right.toSorted();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

/** Admits only the exact build selected for this worker environment. */
export function verifyWorkerAdmissionHandshake(
  handshake: WorkerAdmissionHandshake,
  expected: ExpectedWorkerBuild,
): boolean {
  return (
    handshake.bundleHash === expected.bundleHash &&
    handshake.openclawVersion === expected.openclawVersion &&
    sameStrings(handshake.protocolFeatures, expected.protocolFeatures)
  );
}

/** Validate an opaque credential and every server-owned worker admission binding. */
export function admitWorkerConnection(params: {
  store: WorkerEnvironmentStore;
  admission: WorkerConnectParams["admission"];
  expectedBuild: ExpectedWorkerBuild;
  nowMs: number;
}): WorkerConnectionAdmissionResult {
  const { admission, store } = params;
  const credentialHash = hashWorkerCredential(admission.credential);
  const credential = store.getCredential(admission.environmentId);
  if (!credential || !safeEqualSecret(credentialHash, credential.credentialHash)) {
    const otherEnvironmentCredential = store.findCredentialByHash(credentialHash);
    return {
      ok: false,
      reason: otherEnvironmentCredential ? "environment-mismatch" : "invalid-credential",
    };
  }
  if (credential.environmentId !== admission.environmentId) {
    return { ok: false, reason: "environment-mismatch" };
  }
  if (params.nowMs >= credential.expiresAtMs) {
    return { ok: false, reason: "credential-expired" };
  }
  const environment = store.get(admission.environmentId);
  if (
    !environment ||
    (environment.state !== "ready" &&
      environment.state !== "idle" &&
      environment.state !== "attached") ||
    environment.destroyRequestedAtMs !== null ||
    !environment.bootstrapReceipt
  ) {
    return { ok: false, reason: "environment-unavailable" };
  }
  if (
    admission.handshake.bundleHash !== credential.bundleHash ||
    admission.handshake.bundleHash !== environment.bootstrapReceipt.bundleHash ||
    admission.handshake.bundleHash !== params.expectedBuild.bundleHash
  ) {
    return { ok: false, reason: "bundle-mismatch" };
  }
  if (
    admission.handshake.openclawVersion !== environment.bootstrapReceipt.openclawVersion ||
    admission.handshake.openclawVersion !== params.expectedBuild.openclawVersion
  ) {
    return { ok: false, reason: "version-mismatch" };
  }
  if (admission.sessionId !== credential.sessionId) {
    return { ok: false, reason: "session-mismatch" };
  }
  if ((admission.sessionId === null) !== (admission.runId === null)) {
    return { ok: false, reason: "session-mismatch" };
  }
  if (
    admission.ownerEpoch !== credential.ownerEpoch ||
    admission.ownerEpoch !== environment.ownerEpoch
  ) {
    return { ok: false, reason: "owner-epoch-mismatch" };
  }
  if (
    admission.rpcSetVersion !== credential.rpcSetVersion ||
    credential.rpcSetVersion !== WORKER_RPC_SET_VERSION
  ) {
    return { ok: false, reason: "rpc-set-mismatch" };
  }
  if (
    !sameStrings(
      admission.handshake.protocolFeatures,
      environment.bootstrapReceipt.protocolFeatures,
    ) ||
    !sameStrings(admission.handshake.protocolFeatures, params.expectedBuild.protocolFeatures)
  ) {
    return { ok: false, reason: "protocol-features-mismatch" };
  }
  return {
    ok: true,
    identity: {
      environmentId: environment.environmentId,
      credentialHash: credential.credentialHash,
      bundleHash: credential.bundleHash,
      sessionId: credential.sessionId,
      runId: admission.runId,
      ownerEpoch: credential.ownerEpoch,
      rpcSetVersion: credential.rpcSetVersion,
      protocolFeatures: [...environment.bootstrapReceipt.protocolFeatures],
      credentialExpiresAtMs: credential.expiresAtMs,
    },
  };
}

/** Revalidate live ownership on every worker RPC so rotation and expiry fence stale sockets. */
export function validateWorkerConnectionIdentity(params: {
  store: WorkerEnvironmentStore;
  identity: WorkerConnectionIdentity;
  nowMs: number;
}): WorkerProtocolCloseReason | null {
  const credential = params.store.getCredential(params.identity.environmentId);
  if (!credential || !safeEqualSecret(credential.credentialHash, params.identity.credentialHash)) {
    return "credential-replaced";
  }
  if (params.nowMs >= credential.expiresAtMs) {
    return "credential-expired";
  }
  const environment = params.store.get(params.identity.environmentId);
  if (
    !environment ||
    (environment.state !== "ready" &&
      environment.state !== "idle" &&
      environment.state !== "attached") ||
    environment.destroyRequestedAtMs !== null
  ) {
    return "environment-unavailable";
  }
  if (
    environment.ownerEpoch !== params.identity.ownerEpoch ||
    credential.ownerEpoch !== params.identity.ownerEpoch
  ) {
    return "owner-epoch-mismatch";
  }
  return null;
}
