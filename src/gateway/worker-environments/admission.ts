import {
  type WorkerAdmissionFailureReason,
  type WorkerAdmissionHandshake,
  type WorkerConnectParams,
  type WorkerProtocolCloseReason,
  WORKER_EXEC_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  sameWorkerBuild,
  sameWorkerProtocolFeatures,
  type ExpectedWorkerBuild,
} from "../../worker/worker-build-identity.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { hashWorkerCredential } from "./credential.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerEnvironmentStore } from "./store.js";

export type { WorkerConnectionIdentity } from "./connection-identity.js";
export type { ExpectedWorkerBuild } from "../../worker/worker-build-identity.js";

export const STALE_WORKER_BUILD_REASON =
  "Worker build does not match the current Gateway build; redispatch the session so its worker can bootstrap the current build before retrying.";

export class StaleWorkerBuildError extends Error {
  readonly code = "invalid_state";

  constructor() {
    super(STALE_WORKER_BUILD_REASON);
  }
}

/** Fence persisted builds that cannot parse the exact current launch descriptor. */
export function supportsCurrentWorkerLaunch(
  handshake: Pick<WorkerAdmissionHandshake, "protocolFeatures"> | null | undefined,
): boolean {
  return (
    handshake?.protocolFeatures.includes(WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE) === true &&
    handshake.protocolFeatures.includes(WORKER_EXEC_AUTHORITY_PROTOCOL_FEATURE)
  );
}

type WorkerConnectionAdmissionResult =
  | { ok: true; identity: WorkerConnectionIdentity }
  | { ok: false; reason: WorkerAdmissionFailureReason };

/** Admits only the exact build selected for this worker environment. */
export function verifyWorkerAdmissionHandshake(
  handshake: WorkerAdmissionHandshake,
  expected: ExpectedWorkerBuild,
): boolean {
  return sameWorkerBuild(handshake, expected);
}

/** Validate an opaque credential and every server-owned worker admission binding. */
export function admitWorkerConnection(params: {
  store: WorkerEnvironmentStore;
  admission: WorkerConnectParams["admission"];
  expectedBuild: ExpectedWorkerBuild;
  nowMs: number;
  turnClaim?: WorkerSessionTurnClaim;
  /** Service-only: exact durable turn validation must follow before admission succeeds. */
  allowExpiredCredential?: boolean;
}): WorkerConnectionAdmissionResult {
  const { admission, store } = params;
  const turnClaim = params.turnClaim;
  const credentialHash = hashWorkerCredential(admission.credential, turnClaim);
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
  if (admission.sessionId !== null) {
    if (
      !turnClaim ||
      turnClaim.owner.kind !== "worker" ||
      turnClaim.sessionId !== admission.sessionId ||
      turnClaim.runId !== admission.runId ||
      turnClaim.owner.environmentId !== admission.environmentId ||
      turnClaim.owner.ownerEpoch !== admission.ownerEpoch
    ) {
      return { ok: false, reason: "placement-mismatch" };
    }
  } else if (turnClaim || admission.runId !== null) {
    return { ok: false, reason: "session-mismatch" };
  }
  if (params.nowMs >= credential.expiresAtMs && params.allowExpiredCredential !== true) {
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
    !sameWorkerProtocolFeatures(
      admission.handshake.protocolFeatures,
      environment.bootstrapReceipt.protocolFeatures,
    ) ||
    !sameWorkerProtocolFeatures(
      admission.handshake.protocolFeatures,
      params.expectedBuild.protocolFeatures,
    )
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
      turnClaim: turnClaim ?? null,
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
