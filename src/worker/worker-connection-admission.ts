import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { WebSocket, type RawData } from "ws";
import {
  type WorkerAdmissionResponseFrame,
  WorkerAdmissionResponseFrameSchema,
  type WorkerConnectParams,
  type WorkerConnectRequestFrame,
  type WorkerHelloOk,
  type WorkerProtocolCloseReason,
  WorkerProtocolCloseReasonSchema,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { rawDataToString } from "../infra/ws.js";
import {
  WorkerAdmissionError,
  WorkerConnectionInterruptedError,
  toError,
  type WorkerConnectionOptions,
} from "./worker-connection-contract.js";
import { closeInvalidWorkerFrame } from "./worker-connection-frames.js";

const RETRYABLE_CLOSE_REASONS = new Set<WorkerProtocolCloseReason>([
  "gateway-shutdown",
  "gateway-unavailable",
]);

type WorkerConnectionAttemptOptions = {
  attemptTimeoutMs: number;
  connectionOptions: WorkerConnectionOptions;
  isCurrentGeneration: () => boolean;
  isTerminal: () => boolean;
  onSocket: (socket: WebSocket) => void;
  onAdmitting: () => void;
  onReady: (hello: WorkerHelloOk) => void;
  onReadyFrame: (frame: unknown, socket: WebSocket) => void;
  onSocketClosed: () => WorkerConnectionInterruptedError;
  onReadyClose: (reason: WorkerProtocolCloseReason | undefined) => void;
};

function parseFrame(data: RawData): { ok: true; frame: unknown } | { ok: false } {
  try {
    return { ok: true, frame: JSON.parse(rawDataToString(data)) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseCloseReason(data: Buffer): WorkerProtocolCloseReason | undefined {
  const reason = rawDataToString(data);
  return Value.Check(WorkerProtocolCloseReasonSchema, reason) ? reason : undefined;
}

function matchesAdmission(connectParams: WorkerConnectParams, hello: WorkerHelloOk): boolean {
  const expected = connectParams.admission;
  return (
    hello.environmentId === expected.environmentId &&
    hello.sessionId === expected.sessionId &&
    hello.ownerEpoch === expected.ownerEpoch &&
    hello.rpcSetVersion === expected.rpcSetVersion &&
    hello.protocolFeatures.length === expected.handshake.protocolFeatures.length &&
    hello.protocolFeatures.every((feature) => expected.handshake.protocolFeatures.includes(feature))
  );
}

export function isRetryableWorkerCloseReason(reason: WorkerProtocolCloseReason): boolean {
  return RETRYABLE_CLOSE_REASONS.has(reason);
}

function workerSocketUrl(socketPath: string): string {
  if (!socketPath.startsWith("/")) {
    throw new Error("worker gateway socket path must be absolute");
  }
  if (socketPath.includes(":")) {
    throw new Error("worker gateway socket path must not contain a colon");
  }
  return `ws+unix://${socketPath}:/`;
}

export function connectWorkerConnectionAttempt(
  options: WorkerConnectionAttemptOptions,
): Promise<WorkerHelloOk> {
  const connectionOptions = options.connectionOptions;
  const socket = connectionOptions.createSocket
    ? connectionOptions.createSocket(workerSocketUrl(connectionOptions.socketPath))
    : new WebSocket(workerSocketUrl(connectionOptions.socketPath), {
        maxPayload: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
      });
  options.onSocket(socket);
  const admissionId = randomUUID();
  let admitted = false;
  let attemptSettled = false;

  return new Promise<WorkerHelloOk>((resolve, reject) => {
    let attemptTimeout: ReturnType<typeof setTimeout> | undefined;
    const rejectAttempt = (error: Error) => {
      if (attemptSettled) {
        return;
      }
      attemptSettled = true;
      if (attemptTimeout) {
        clearTimeout(attemptTimeout);
        attemptTimeout = undefined;
      }
      reject(error);
    };
    attemptTimeout = setTimeout(() => {
      rejectAttempt(new WorkerConnectionInterruptedError("worker admission timed out"));
      socket.terminate();
    }, options.attemptTimeoutMs);
    attemptTimeout.unref?.();

    socket.on("error", (error) => {
      if (!admitted) {
        rejectAttempt(new WorkerConnectionInterruptedError(toError(error).message));
      }
    });
    socket.on("open", () => {
      if (!options.isCurrentGeneration() || options.isTerminal()) {
        socket.close();
        return;
      }
      options.onAdmitting();
      const frame: WorkerConnectRequestFrame = {
        type: "req",
        id: admissionId,
        method: "connect",
        params: {
          ...connectionOptions.connectParams,
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
        },
      };
      socket.send(JSON.stringify(frame), (error) => {
        if (error) {
          rejectAttempt(new WorkerConnectionInterruptedError(error.message));
          socket.terminate();
        }
      });
    });
    socket.on("message", (data: RawData) => {
      if (!options.isCurrentGeneration()) {
        return;
      }
      const parsed = parseFrame(data);
      if (!parsed.ok) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      const frame = parsed.frame;
      if (!admitted) {
        if (
          !Value.Check(WorkerAdmissionResponseFrameSchema, frame) ||
          (frame as WorkerAdmissionResponseFrame).id !== admissionId
        ) {
          closeInvalidWorkerFrame(socket);
          rejectAttempt(new WorkerAdmissionError("invalid-handshake", false));
          return;
        }
        const response = frame as WorkerAdmissionResponseFrame;
        if (!response.ok) {
          const reason = response.error.details.reason;
          rejectAttempt(
            new WorkerAdmissionError(
              reason,
              response.error.retryable === true && isRetryableWorkerCloseReason(reason),
            ),
          );
          socket.terminate();
          return;
        }
        if (!matchesAdmission(connectionOptions.connectParams, response.payload)) {
          closeInvalidWorkerFrame(socket);
          rejectAttempt(new WorkerAdmissionError("invalid-handshake", false));
          return;
        }
        admitted = true;
        attemptSettled = true;
        if (attemptTimeout) {
          clearTimeout(attemptTimeout);
          attemptTimeout = undefined;
        }
        options.onReady(response.payload);
        resolve(response.payload);
        return;
      }
      options.onReadyFrame(frame, socket);
    });
    socket.on("close", (_code, reason) => {
      if (!options.isCurrentGeneration()) {
        return;
      }
      const interrupted = options.onSocketClosed();
      const closeReason = parseCloseReason(reason);
      if (!admitted) {
        rejectAttempt(
          closeReason
            ? new WorkerAdmissionError(closeReason, isRetryableWorkerCloseReason(closeReason))
            : interrupted,
        );
        return;
      }
      options.onReadyClose(closeReason);
    });
  });
}
