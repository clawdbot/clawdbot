import type { RawData, WebSocket } from "ws";
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type RequestFrame,
  type WorkerConnectParams,
  type WorkerErrorShape,
  type WorkerHeartbeatResult,
  type WorkerHelloOk,
  type WorkerProtocolCloseReason,
  type WorkerTranscriptCommitErrorReason,
  type WorkerTranscriptCommitErrorShape,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_METHOD_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_PROTOCOL_METHODS,
  WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
  validateRequestFrame,
  validateWorkerConnectRequestFrame,
  validateWorkerHeartbeatParams,
  validateWorkerTranscriptCommitParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_STARTUP_RETRY_AFTER_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { rawDataToString } from "../../../infra/ws.js";
import { tryBeginGatewayRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import type { WorkerEnvironmentService } from "../../worker-environments/service.js";
import type { GatewayWsClient, WsHandshakePhase } from "../ws-types.js";

export type WorkerConnectionService = Pick<
  WorkerEnvironmentService,
  "admitWorker" | "commitTranscript" | "validateWorkerConnection"
>;

type WorkerRespond = (
  ok: boolean,
  payload?: unknown,
  error?: WorkerErrorShape | WorkerTranscriptCommitErrorShape,
) => void;
type WorkerLogger = { warn(message: string): void };
const MAX_QUEUED_WORKER_FRAMES = 16;

export type WorkerWsMessageHandlerParams = {
  socket: WebSocket;
  connId: string;
  service?: WorkerConnectionService;
  isStartupPending?: () => boolean;
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
};

function workerProtocolError(
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

function buildWorkerHello(identity: WorkerConnectionIdentity): WorkerHelloOk {
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
      maxPayload: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
    },
  };
}

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

function workerTranscriptCommitError(
  reason: WorkerTranscriptCommitErrorReason,
): WorkerTranscriptCommitErrorShape {
  return {
    code: ErrorCodes.INVALID_REQUEST,
    message: "worker transcript commit rejected",
    details: { reason },
  };
}

/** Closed worker dispatcher. It never calls the generic gateway method registry. */
async function dispatchWorkerRequest(params: {
  request: RequestFrame;
  identity: WorkerConnectionIdentity;
  service: WorkerConnectionService | undefined;
  respond: WorkerRespond;
  close(code: number, reason: WorkerProtocolCloseReason): void;
  warn(message: string): void;
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

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

/** Dedicated ingress handler: worker frames never enter the generic message handler. */
export function attachWorkerWsMessageHandler(params: WorkerWsMessageHandlerParams): () => void {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(expiryTimer);
    params.socket.off("message", onMessage);
  };
  const closeWorker = (code: number, reason: WorkerProtocolCloseReason) => {
    cleanup();
    params.close(code, reason);
  };
  const failHandshake = (code: number, reason: WorkerProtocolCloseReason) => {
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
  const rejectAdmission = (
    id: string,
    reason: WorkerProtocolCloseReason,
    error = workerProtocolError(reason, { message: "worker admission rejected" }),
    code = 1008,
  ) => {
    params.setHandshakeState("failed");
    params.setCloseCause(reason);
    params.logWsControl.warn(`worker admission rejected reason=${reason}`);
    sendError(id, reason, error, code);
  };

  const handleConnect = async (
    connect: WorkerConnectParams,
    id: string,
    admissionOpen: boolean,
  ) => {
    if (!admissionOpen || params.isStartupPending?.()) {
      rejectAdmission(
        id,
        "gateway-unavailable",
        workerProtocolError("gateway-unavailable", {
          code: ErrorCodes.UNAVAILABLE,
          message: "worker gateway unavailable",
          retryable: true,
          retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
        }),
        1013,
      );
      return;
    }
    if (connect.minProtocol > PROTOCOL_VERSION || connect.maxProtocol < PROTOCOL_VERSION) {
      rejectAdmission(id, "protocol-mismatch");
      return;
    }
    const admission =
      (await params.service?.admitWorker(connect.admission)) ??
      ({ ok: false, reason: "environment-unavailable" } as const);
    if (!admission.ok) {
      rejectAdmission(id, admission.reason);
      return;
    }
    const ownershipFailure = params.service?.validateWorkerConnection(admission.identity);
    if (ownershipFailure) {
      rejectAdmission(id, ownershipFailure);
      return;
    }
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
      worker: admission.identity,
      usesSharedGatewayAuth: false,
    };
    params.clearHandshakeTimer();
    params.advanceHandshakePhase("auth_validated");
    if (!params.setClient(client)) {
      params.setHandshakeState("failed");
      return;
    }
    params.setHandshakeState("connected");
    params.advanceHandshakePhase("session_attached");
    params.advanceHandshakePhase("hello_payload_prepared");
    params.send({ type: "res", id, ok: true, payload: buildWorkerHello(admission.identity) });
    params.advanceHandshakePhase("ready");
    expiryTimer = setTimeout(
      () => closeWorker(1008, "credential-expired"),
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
    if (rawDataByteLength(data) > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
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
      parsed.method === WORKER_PROTOCOL_METHODS[0] ||
      parsed.method === WORKER_PROTOCOL_METHODS[1]
    ) {
      params.setLastFrameMeta({ type: "req", method: parsed.method });
    }
    if (!client.worker) {
      closeWorker(1008, "environment-unavailable");
      return;
    }
    await dispatchWorkerRequest({
      request: parsed,
      identity: client.worker,
      service: params.service,
      respond: (ok, payload, error) =>
        params.send(
          ok
            ? { type: "res", id: parsed.id, ok, payload }
            : { type: "res", id: parsed.id, ok, error },
        ),
      close: closeWorker,
      warn: (message) => params.logGateway.warn(message),
    });
  };

  let queue = Promise.resolve();
  let pendingFrames = 0;
  function onMessage(data: RawData) {
    if (disposed) {
      return;
    }
    if (pendingFrames >= MAX_QUEUED_WORKER_FRAMES) {
      if (params.getClient()) {
        failFrame(1008, "invalid-frame");
      } else {
        failHandshake(1008, "invalid-handshake");
      }
      return;
    }
    pendingFrames += 1;
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
      });
  }
  params.socket.on("message", onMessage);
  return cleanup;
}
