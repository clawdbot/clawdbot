import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { RawData, WebSocket } from "ws";
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type RequestFrame,
  type WorkerConnectParams,
  type WorkerErrorShape,
  type WorkerHeartbeatResult,
  type WorkerLiveEventErrorDetails,
  type WorkerLiveEventErrorShape,
  type WorkerLiveEventParams,
  type WorkerLiveEventResult,
  type WorkerProtocolCloseReason,
  type WorkerSessionsSendParams,
  type WorkerSessionsSpawnParams,
  type WorkerSessionToolResult,
  type WorkerTranscriptCommitErrorReason,
  type WorkerTranscriptCommitErrorShape,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitResult,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_METHOD_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_METHODS,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  validateRequestFrame,
  validateWorkerConnectRequestFrame,
  validateWorkerHeartbeatParams,
  validateWorkerLiveEventParams,
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
import { GATEWAY_STARTUP_RETRY_AFTER_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { rawDataByteLength } from "../../../infra/ws.js";
import {
  runWithGatewayIndependentRootWorkContinuation,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION } from "../../auth-rate-limit.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import { MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS } from "../../worker-environments/placement-session-tool-operations.js";
import type { PublicWorkerIngressContext } from "../public-worker-ingress-context.js";
import type { GatewayWorkerIngress, GatewayWsClient, WsHandshakePhase } from "../ws-types.js";
import { runWorkerAdmissionBoundary } from "./worker-admission-boundary.js";
import {
  buildWorkerHello,
  workerInferenceError,
  workerLiveEventError,
  workerMaxPayload,
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
    toolName: "sessions_spawn" | "sessions_send",
    request: WorkerSessionsSpawnParams | WorkerSessionsSendParams,
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
type WorkerLogger = { warn(message: string): void };
const MAX_QUEUED_WORKER_FRAMES = 16;
const MAX_QUEUED_WORKER_BYTES = 32 * 1024 * 1024;

type WorkerWsMessageHandlerParams = {
  socket: WebSocket;
  connId: string;
  service?: WorkerConnectionService;
  isStartupPending?: () => boolean;
  ingress: GatewayWorkerIngress;
  send(frame: unknown): void;
  close(code?: number, reason?: string): void;
  isClosed(): boolean;
  clearHandshakeTimer(): void;
  getClient(): GatewayWsClient | null;
  setClient(client: GatewayWsClient): boolean;
  setHandshakeState(state: "pending" | "connected" | "failed"): void;
  advanceHandshakePhase(phase: WsHandshakePhase): void;
  setCloseCause(cause: string): void;
  setLastFrameMeta(meta: { type?: string; method?: string }): void;
  logGateway: WorkerLogger;
  logWsControl: WorkerLogger;
  publicAdmission?: PublicWorkerIngressContext;
};

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

function setSocketMaxPayload(socket: WebSocket, maxPayload: number): void {
  const receiver = (socket as { _receiver?: { _maxPayload?: number } })["_receiver"];
  if (receiver) {
    receiver["_maxPayload"] = maxPayload;
  }
}

/** Closed worker dispatcher. It never calls the generic gateway method registry. */
async function dispatchWorkerRequest(params: {
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
    params.request.method === WORKER_PROTOCOL_METHODS[4]
  ) {
    if (!params.identity.protocolFeatures.includes(WORKER_SESSION_TOOLS_PROTOCOL_FEATURE)) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    if (!service.executeSessionTool) {
      rejectWorkerRequest({ ...params, reason: "method-not-allowed" });
      return;
    }
    const isSpawn = params.request.method === WORKER_PROTOCOL_METHODS[3];
    const requestValid = isSpawn
      ? validateWorkerSessionsSpawnParams(params.request.params)
      : validateWorkerSessionsSendParams(params.request.params);
    if (!requestValid) {
      params.respond(false, undefined, workerProtocolError("invalid-frame"));
      return;
    }
    const outcome = await service.executeSessionTool(
      params.identity,
      isSpawn ? "sessions_spawn" : "sessions_send",
      params.request.params as WorkerSessionsSpawnParams | WorkerSessionsSendParams,
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

/** Dedicated ingress handler: worker frames never enter the generic message handler. */
export function attachWorkerWsMessageHandler(params: WorkerWsMessageHandlerParams): () => void {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const sessionOperations = new Set<string>();
  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(expiryTimer);
    sessionOperations.clear();
    params.socket.off("message", onMessage);
  };
  const closeWorker = (code: number, reason: WorkerProtocolCloseReason) => {
    cleanup();
    params.close(code, reason);
  };
  const failHandshake = (code: number, reason: WorkerProtocolCloseReason) => {
    params.publicAdmission?.rateLimiter?.recordFailure(
      params.publicAdmission.clientIp,
      AUTH_RATE_LIMIT_SCOPE_WORKER_ADMISSION,
    );
    params.setHandshakeState("failed");
    params.setCloseCause(reason);
    params.logWsControl.warn(`worker admission rejected reason=${reason}`);
    closeWorker(code, reason);
  };
  const failFrame = (code: number, reason: WorkerProtocolCloseReason) => {
    params.setCloseCause(reason);
    params.logGateway.warn(`worker protocol request rejected reason=${reason}`);
    closeWorker(code, reason);
  };
  const sendError = (
    id: string,
    reason: WorkerProtocolCloseReason,
    error = workerProtocolError(reason),
    code = 1008,
  ) => {
    params.send({ type: "res", id, ok: false, error });
    queueMicrotask(() => closeWorker(code, reason));
  };
  const rejectAdmission = (rejection: {
    id: string;
    reason: WorkerProtocolCloseReason | "rate-limited";
    internalReason?: string;
    error?: WorkerErrorShape;
    code?: number;
    opaqueOnPublicIngress?: boolean;
  }) => {
    const internalReason = rejection.internalReason ?? rejection.reason;
    const wireReason: WorkerProtocolCloseReason =
      (rejection.opaqueOnPublicIngress && params.publicAdmission) ||
      rejection.reason === "rate-limited"
        ? "invalid-handshake"
        : rejection.reason;
    const wireError =
      rejection.error ?? workerProtocolError(wireReason, { message: "worker admission rejected" });
    params.setHandshakeState("failed");
    params.setCloseCause(internalReason);
    params.logWsControl.warn(`worker admission rejected reason=${internalReason}`);
    sendError(rejection.id, wireReason, wireError, rejection.code ?? 1008);
  };

  const handleConnect = async (
    connect: WorkerConnectParams,
    id: string,
    admissionOpen: boolean,
  ) => {
    if (!admissionOpen || params.isStartupPending?.()) {
      rejectAdmission({
        id,
        reason: "gateway-unavailable",
        error: workerProtocolError("gateway-unavailable", {
          code: ErrorCodes.UNAVAILABLE,
          message: "worker gateway unavailable",
          retryable: true,
          retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
        }),
        code: 1013,
      });
      return;
    }
    if (params.ingress === "public" && !params.publicAdmission) {
      rejectAdmission({
        id,
        reason: "invalid-handshake",
        internalReason: "public-ingress-context-missing",
      });
      return;
    }
    if (connect.minProtocol > PROTOCOL_VERSION || connect.maxProtocol < PROTOCOL_VERSION) {
      rejectAdmission({ id, reason: "protocol-mismatch" });
      return;
    }
    const admission = await runWorkerAdmissionBoundary({
      service: params.service,
      admission: connect.admission,
      publicAdmission: params.publicAdmission,
      claim: (identity) => {
        const client: GatewayWsClient = {
          socket: params.socket,
          connect: {
            minProtocol: connect.minProtocol,
            maxProtocol: connect.maxProtocol,
            client: connect.client,
            role: "worker",
            scopes: [],
          },
          connId: params.connId,
          connectionKind: "worker",
          worker: identity,
          usesSharedGatewayAuth: false,
        };
        params.clearHandshakeTimer();
        params.advanceHandshakePhase("auth_validated");
        if (!params.setClient(client)) {
          params.setHandshakeState("failed");
          return false;
        }
        return true;
      },
    });
    if (!admission.ok) {
      if (admission.reason === "claim-rejected") {
        return;
      }
      rejectAdmission({ id, reason: admission.reason, opaqueOnPublicIngress: true });
      return;
    }
    params.setHandshakeState("connected");
    params.advanceHandshakePhase("session_attached");
    setSocketMaxPayload(params.socket, workerMaxPayload(admission.identity));
    params.advanceHandshakePhase("hello_payload_prepared");
    params.send({ type: "res", id, ok: true, payload: buildWorkerHello(admission.identity) });
    params.advanceHandshakePhase("ready");
    expiryTimer = setTimeout(
      () => {
        // Credential TTL fences unattached workers. An exact durable turn may
        // remain connected (and reconnect with the same claim-bound secret)
        // until terminal ACK releases its placement claim.
        const failure = params.service?.validateWorkerConnection(admission.identity);
        if (failure) {
          closeWorker(1008, failure);
        } else if (!params.service) {
          closeWorker(1008, "credential-expired");
        }
      },
      Math.max(0, admission.identity.credentialExpiresAtMs - Date.now()),
    );
    expiryTimer.unref?.();
  };

  const handleMessage = async (data: RawData, admissionOpen: boolean) => {
    const client = params.getClient();
    if (client?.invalidated) {
      failFrame(1008, "credential-replaced");
      return;
    }
    if (client && !admissionOpen) {
      failFrame(1013, "gateway-unavailable");
      return;
    }
    const frameBytes = rawDataByteLength(data);
    const maxFrameBytes = client?.worker
      ? workerMaxPayload(client.worker)
      : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
    if (frameBytes > maxFrameBytes) {
      if (client) {
        failFrame(1009, "invalid-frame");
      } else {
        failHandshake(1009, "invalid-handshake");
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      if (client) {
        failFrame(1008, "invalid-frame");
      } else {
        failHandshake(1008, "invalid-handshake");
      }
      return;
    }
    if (!client) {
      if (!validateWorkerConnectRequestFrame(parsed)) {
        failHandshake(1008, "invalid-handshake");
        return;
      }
      params.setLastFrameMeta({ type: "req", method: "connect" });
      await handleConnect(parsed.params, parsed.id, admissionOpen);
      return;
    }
    if (
      !validateRequestFrame(parsed) ||
      parsed.id.length > WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH ||
      parsed.method.length > WORKER_PROTOCOL_MAX_METHOD_LENGTH
    ) {
      params.logGateway.warn("worker protocol request rejected reason=invalid-frame");
      closeWorker(1008, "invalid-frame");
      return;
    }
    if (
      frameBytes > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES &&
      parsed.method !== WORKER_INFERENCE_METHODS[0]
    ) {
      failFrame(1009, "invalid-frame");
      return;
    }
    if (
      parsed.method === WORKER_PROTOCOL_METHODS[0] ||
      parsed.method === WORKER_PROTOCOL_METHODS[1] ||
      parsed.method === WORKER_PROTOCOL_METHODS[2] ||
      parsed.method === WORKER_PROTOCOL_METHODS[3] ||
      parsed.method === WORKER_PROTOCOL_METHODS[4] ||
      parsed.method === WORKER_INFERENCE_METHODS[0] ||
      parsed.method === WORKER_INFERENCE_METHODS[1]
    ) {
      params.setLastFrameMeta({ type: "req", method: parsed.method });
    }
    if (!client.worker) {
      closeWorker(1008, "environment-unavailable");
      return;
    }
    const respond = (ok: boolean, payload?: unknown, error?: Parameters<WorkerRespond>[2]) => {
      if (disposed || params.isClosed() || params.getClient() !== client || client.invalidated) {
        return;
      }
      params.send(
        ok
          ? { type: "res", id: parsed.id, ok, payload }
          : { type: "res", id: parsed.id, ok, error },
      );
    };
    const dispatch = (signal?: AbortSignal) =>
      dispatchWorkerRequest({
        request: parsed,
        identity: client.worker!,
        connectionId: params.connId,
        service: params.service,
        send: (frame) => params.send(frame),
        respond,
        close: closeWorker,
        warn: (message) => params.logGateway.warn(message),
        ...(signal ? { signal } : {}),
      });
    const isLongSessionOperation =
      parsed.method === WORKER_PROTOCOL_METHODS[3] || parsed.method === WORKER_PROTOCOL_METHODS[4];
    if (isLongSessionOperation) {
      if (sessionOperations.has(parsed.id)) {
        failFrame(1008, "invalid-frame");
        return;
      }
      if (sessionOperations.size >= MAX_RUNNING_WORKER_SESSION_TOOL_OPERATIONS) {
        respond(false, undefined, workerProtocolError("gateway-unavailable"));
        return;
      }
      sessionOperations.add(parsed.id);
      // Provisioning and recipient turns can take minutes. Retain independent
      // shutdown admission while releasing this connection's ordered frame
      // queue so heartbeats, cancellation, and terminal ACKs keep flowing. A
      // socket is only a response transport: disconnecting it must not cancel
      // an admitted durable operation after external effects may have begun.
      void runWithGatewayIndependentRootWorkContinuation(() => dispatch())
        .catch(() => {
          respond(false, undefined, workerProtocolError("gateway-unavailable"));
        })
        .finally(() => {
          sessionOperations.delete(parsed.id);
        });
      return;
    }
    await dispatch();
  };

  let queue = Promise.resolve();
  let pendingFrames = 0;
  let pendingBytes = 0;
  function onMessage(data: RawData) {
    if (disposed) {
      return;
    }
    const frameBytes = rawDataByteLength(data);
    if (
      pendingFrames >= MAX_QUEUED_WORKER_FRAMES ||
      pendingBytes + frameBytes > MAX_QUEUED_WORKER_BYTES
    ) {
      if (params.getClient()) {
        failFrame(1008, "invalid-frame");
      } else {
        failHandshake(1008, "invalid-handshake");
      }
      return;
    }
    pendingFrames += 1;
    pendingBytes += frameBytes;
    queue = queue
      .then(async () => {
        if (disposed || params.isClosed()) {
          return;
        }
        const admission = tryBeginGatewayRootWorkAdmission();
        if (!admission) {
          await handleMessage(data, false);
          return;
        }
        try {
          await admission.run(() => handleMessage(data, true));
        } finally {
          admission.release();
        }
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        if (params.getClient()) {
          failFrame(1011, "gateway-unavailable");
        } else {
          failHandshake(1011, "gateway-unavailable");
        }
      })
      .finally(() => {
        pendingFrames -= 1;
        pendingBytes -= frameBytes;
      });
  }
  params.socket.on("message", onMessage);
  return cleanup;
}
