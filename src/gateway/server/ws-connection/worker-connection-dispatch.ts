import {
  type RequestFrame,
  type WorkerConnectParams,
  type WorkerErrorShape,
  type WorkerGitHubPublishParams,
  type WorkerHeartbeatResult,
  type WorkerLiveEventErrorDetails,
  type WorkerLiveEventErrorShape,
  type WorkerLiveEventParams,
  type WorkerLiveEventResult,
  type WorkerPortalParams,
  type WorkerProtocolCloseReason,
  type WorkerSessionsSendParams,
  type WorkerSessionsSpawnParams,
  type WorkerSessionToolResult,
  type WorkerTranscriptCommitErrorReason,
  type WorkerTranscriptCommitErrorShape,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitResult,
  WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PORTAL_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_METHODS,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  validateWorkerGitHubPublishParams,
  validateWorkerHeartbeatParams,
  validateWorkerLiveEventParams,
  validateWorkerPortalParams,
  validateWorkerSessionsSendParams,
  validateWorkerSessionsSpawnParams,
  validateWorkerTranscriptCommitParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  type WorkerInferenceCancelParams,
  type WorkerInferenceCancelResult,
  type WorkerInferenceErrorReason,
  type WorkerInferenceErrorShape,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartResult,
  type WorkerInferenceTerminalFrame,
  WORKER_INFERENCE_METHODS,
  WORKER_INFERENCE_PROTOCOL_FEATURE,
  validateWorkerInferenceCancelParams,
  validateWorkerInferenceStartParams,
} from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import {
  workerInferenceError,
  workerLiveEventError,
  workerProtocolError,
  workerTranscriptCommitError,
} from "./worker-connection-frames.js";

type WorkerServiceResult<TResult, TFailure> =
  | { ok: true; result: TResult }
  | ({ ok: false } & (TFailure | { closeReason: WorkerProtocolCloseReason }));

export type WorkerConnectionService = {
  admitWorker: (
    admission: WorkerConnectParams["admission"],
  ) => Promise<
    | { ok: true; identity: WorkerConnectionIdentity }
    | { ok: false; reason: WorkerProtocolCloseReason }
  >;
  commitTranscript: (
    identity: WorkerConnectionIdentity,
    request: WorkerTranscriptCommitParams,
  ) => Promise<
    WorkerServiceResult<WorkerTranscriptCommitResult, { reason: WorkerTranscriptCommitErrorReason }>
  >;
  pushLiveEvent: (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
  ) => Promise<
    WorkerServiceResult<WorkerLiveEventResult, { details: WorkerLiveEventErrorDetails }>
  >;
  validateWorkerConnection: (
    identity: WorkerConnectionIdentity,
  ) => WorkerProtocolCloseReason | null;
  executeSessionTool?: (
    identity: WorkerConnectionIdentity,
    toolName: "sessions_spawn" | "sessions_send" | "github_publish" | "portal",
    request:
      | WorkerSessionsSpawnParams
      | WorkerSessionsSendParams
      | WorkerGitHubPublishParams
      | WorkerPortalParams,
    signal?: AbortSignal,
  ) => Promise<WorkerServiceResult<WorkerSessionToolResult, { reason: WorkerProtocolCloseReason }>>;
};

type WorkerInferenceConnectionService = WorkerConnectionService & {
  startInference?: (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams,
    sink: WorkerInferenceSink,
  ) =>
    | { ok: true; result: WorkerInferenceStartResult; launch: () => void }
    | { ok: false; reason: WorkerInferenceErrorReason }
    | { ok: false; closeReason: WorkerProtocolCloseReason };
  cancelInference?: (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceCancelParams,
  ) => WorkerServiceResult<WorkerInferenceCancelResult, { reason: WorkerInferenceErrorReason }>;
};

type WorkerInferenceSink = {
  connectionId: string;
  send(frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame): void;
};

type WorkerRespond = (
  ok: boolean,
  payload?: unknown,
  error?:
    | WorkerErrorShape
    | WorkerInferenceErrorShape
    | WorkerLiveEventErrorShape
    | WorkerTranscriptCommitErrorShape,
) => void;

function rejectWorkerRequest(params: {
  reason: WorkerProtocolCloseReason;
  respond: WorkerRespond;
  close(code: number, reason: WorkerProtocolCloseReason): void;
  warn(message: string): void;
}): void {
  params.warn(`worker protocol request rejected reason=${params.reason}`);
  params.respond(false, undefined, workerProtocolError(params.reason));
  queueMicrotask(() => params.close(1008, params.reason));
}

/** Closed worker dispatcher. It never calls the generic gateway method registry. */
export async function dispatchWorkerRequest(params: {
  request: RequestFrame;
  identity: WorkerConnectionIdentity;
  connectionId: string;
  service: WorkerInferenceConnectionService | undefined;
  send(frame: unknown): void;
  respond: WorkerRespond;
  close(code: number, reason: WorkerProtocolCloseReason): void;
  warn(message: string): void;
  signal?: AbortSignal;
}): Promise<void> {
  const service = params.service;
  if (!service) {
    rejectWorkerRequest({ ...params, reason: "environment-unavailable" });
    return;
  }
  const ownershipFailure = service.validateWorkerConnection(params.identity);
  if (ownershipFailure) {
    rejectWorkerRequest({ ...params, reason: ownershipFailure });
    return;
  }
  if (params.request.method === WORKER_INFERENCE_METHODS[0]) {
    if (!params.identity.protocolFeatures.includes(WORKER_INFERENCE_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!validateWorkerInferenceStartParams(params.request.params)) {
      params.respond(false, undefined, workerInferenceError("invalid-context"));
      return;
    }
    if (!service.startInference) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    const outcome = service.startInference(params.identity, params.request.params, {
      connectionId: params.connectionId,
      send: (frame) => params.send(frame),
    });
    if (outcome.ok) {
      // Reply before a synchronous provider can emit.
      params.respond(true, outcome.result);
      outcome.launch();
      return;
    }
    if ("closeReason" in outcome) {
      rejectWorkerRequest({ ...params, reason: outcome.closeReason });
      return;
    }
    params.respond(false, undefined, workerInferenceError(outcome.reason));
    return;
  }
  if (params.request.method === WORKER_INFERENCE_METHODS[1]) {
    if (!params.identity.protocolFeatures.includes(WORKER_INFERENCE_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!validateWorkerInferenceCancelParams(params.request.params)) {
      params.respond(false, undefined, workerInferenceError("invalid-context"));
      return;
    }
    if (!service.cancelInference) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    const outcome = service.cancelInference(params.identity, params.request.params);
    if (outcome.ok) {
      params.respond(true, outcome.result);
      return;
    }
    if ("closeReason" in outcome) {
      rejectWorkerRequest({ ...params, reason: outcome.closeReason });
      return;
    }
    params.respond(false, undefined, workerInferenceError(outcome.reason));
    return;
  }
  if (params.request.method === WORKER_PROTOCOL_METHODS[1]) {
    if (!params.identity.protocolFeatures.includes(WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!validateWorkerTranscriptCommitParams(params.request.params)) {
      params.respond(false, undefined, workerTranscriptCommitError("invalid-batch"));
      return;
    }
    const outcome = await service.commitTranscript(params.identity, params.request.params);
    if (outcome.ok) {
      params.respond(true, outcome.result);
      return;
    }
    if ("closeReason" in outcome) {
      rejectWorkerRequest({ ...params, reason: outcome.closeReason });
      return;
    }
    params.respond(false, undefined, workerTranscriptCommitError(outcome.reason));
    return;
  }
  if (params.request.method === WORKER_PROTOCOL_METHODS[2]) {
    if (!params.identity.protocolFeatures.includes(WORKER_LIVE_EVENT_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!validateWorkerLiveEventParams(params.request.params)) {
      params.respond(false, undefined, workerLiveEventError({ reason: "invalid-event" }));
      return;
    }
    const outcome = await service.pushLiveEvent(params.identity, params.request.params);
    if (outcome.ok) {
      params.respond(true, outcome.result);
      return;
    }
    if ("closeReason" in outcome) {
      rejectWorkerRequest({ ...params, reason: outcome.closeReason });
      return;
    }
    params.respond(false, undefined, workerLiveEventError(outcome.details));
    return;
  }
  if (
    params.request.method === WORKER_PROTOCOL_METHODS[3] ||
    params.request.method === WORKER_PROTOCOL_METHODS[4] ||
    params.request.method === WORKER_PROTOCOL_METHODS[5] ||
    params.request.method === WORKER_PROTOCOL_METHODS[6]
  ) {
    const isGitHubPublish = params.request.method === WORKER_PROTOCOL_METHODS[5];
    const isPortal = params.request.method === WORKER_PROTOCOL_METHODS[6];
    const requiredFeature = isPortal
      ? WORKER_PORTAL_PROTOCOL_FEATURE
      : isGitHubPublish
        ? WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE
        : WORKER_SESSION_TOOLS_PROTOCOL_FEATURE;
    if (!params.identity.protocolFeatures.includes(requiredFeature)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!service.executeSessionTool) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    const isSpawn = params.request.method === WORKER_PROTOCOL_METHODS[3];
    const requestValid = isPortal
      ? validateWorkerPortalParams(params.request.params)
      : isSpawn
        ? validateWorkerSessionsSpawnParams(params.request.params)
        : isGitHubPublish
          ? validateWorkerGitHubPublishParams(params.request.params)
          : validateWorkerSessionsSendParams(params.request.params);
    if (!requestValid) {
      params.respond(false, undefined, workerProtocolError("invalid-frame"));
      return;
    }
    const outcome = await service.executeSessionTool(
      params.identity,
      isPortal
        ? "portal"
        : isSpawn
          ? "sessions_spawn"
          : isGitHubPublish
            ? "github_publish"
            : "sessions_send",
      // SAFETY: The selected tool's matching protocol validator accepted these request params.
      params.request.params as
        | WorkerSessionsSpawnParams
        | WorkerSessionsSendParams
        | WorkerGitHubPublishParams
        | WorkerPortalParams,
      params.signal,
    );
    if (outcome.ok) {
      params.respond(true, outcome.result);
      return;
    }
    if ("closeReason" in outcome) {
      rejectWorkerRequest({ ...params, reason: outcome.closeReason });
      return;
    }
    params.respond(false, undefined, workerProtocolError(outcome.reason));
    return;
  }
  if (params.request.method !== WORKER_PROTOCOL_METHODS[0]) {
    rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
    return;
  }
  if (!validateWorkerHeartbeatParams(params.request.params)) {
    rejectWorkerRequest({ ...params, reason: "invalid-heartbeat" });
    return;
  }
  const result: WorkerHeartbeatResult = {
    receivedAtMs: Date.now(),
    status: "ok",
    ownerEpoch: params.identity.ownerEpoch,
  };
  params.respond(true, result);
}
