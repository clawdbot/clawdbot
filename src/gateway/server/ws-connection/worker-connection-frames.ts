import {
  ErrorCodes,
  type WorkerErrorShape,
  type WorkerHelloOk,
  type WorkerLiveEventErrorDetails,
  type WorkerLiveEventErrorShape,
  type WorkerProtocolCloseReason,
  type WorkerTranscriptCommitErrorReason,
  type WorkerTranscriptCommitErrorShape,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  type WorkerInferenceErrorReason,
  type WorkerInferenceErrorShape,
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";

export function workerProtocolError(
  reason: WorkerProtocolCloseReason,
  options: {
    code?: WorkerErrorShape["code"];
    message?: string;
    retryable?: boolean;
    retryAfterMs?: number;
  } = {},
): WorkerErrorShape {
  return {
    code: options.code ?? ErrorCodes.INVALID_REQUEST,
    message: options.message ?? "worker protocol request rejected",
    details: { reason },
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  };
}

export function workerMaxPayload(identity: WorkerConnectionIdentity): number {
  return identity.protocolFeatures.includes(WORKER_INFERENCE_PROTOCOL_FEATURE)
    ? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES
    : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
}

export function buildWorkerHello(identity: WorkerConnectionIdentity): WorkerHelloOk {
  return {
    type: "worker-hello-ok",
    environmentId: identity.environmentId,
    sessionId: identity.sessionId,
    ownerEpoch: identity.ownerEpoch,
    rpcSetVersion: identity.rpcSetVersion,
    protocolFeatures: [...identity.protocolFeatures],
    credentialExpiresAtMs: identity.credentialExpiresAtMs,
    policy: {
      heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
      maxPayload: workerMaxPayload(identity),
    },
  };
}

export function workerTranscriptCommitError(
  reason: WorkerTranscriptCommitErrorReason,
): WorkerTranscriptCommitErrorShape {
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: "worker transcript commit rejected",
    details: { reason },
  };
}

export function workerLiveEventError(
  details: WorkerLiveEventErrorDetails,
): WorkerLiveEventErrorShape {
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: "worker live event rejected",
    details,
  };
}

export function workerInferenceError(
  reason: WorkerInferenceErrorReason,
): WorkerInferenceErrorShape {
  return {
    code: reason === "provider-error" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    message: "worker inference request rejected",
    details: { reason },
  };
}
